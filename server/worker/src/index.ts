/**
 * NEXUS Cloudflare Worker — fully serverless. No sidecar, no server needed.
 *
 * Handles everything:
 *   - User/device registration (POST /api/register)
 *   - OAuth authorization URL generation (GET /oauth/auth-url)
 *   - OAuth code exchange (POST /oauth/exchange)
 *   - OAuth status (GET /oauth/status)
 *   - OAuth disconnect (DELETE /oauth/disconnect)
 *   - API key management (POST /apikeys/add, DELETE /apikeys/remove, GET /apikeys/list)
 *   - Transcript processing (POST /) — classify intent, call APIs, summarize
 *   - Health check (GET /health)
 *
 * Storage: Cloudflare D1 (free SQLite, 5GB)
 * AI: Cloudflare Workers AI (free, 10K neurons/day)
 *
 * Deploy:
 *   cd server/worker
 *   npx wrangler d1 create nexus-db          # creates the database
 *   npx wrangler d1 execute nexus-db --file=schema.sql  --remote  # creates tables
 *   npx wrangler secret put GOOGLE_CLIENT_ID
 *   npx wrangler secret put GOOGLE_CLIENT_SECRET
 *   npx wrangler secret put GITHUB_CLIENT_ID
 *   npx wrangler secret put GITHUB_CLIENT_SECRET
 *   npx wrangler secret put NEXUS_ENCRYPTION_KEY  # Fernet key for API keys
 *   npx wrangler deploy
 */

// ---- Types ----

interface Env {
  AI: Ai;
  DB: D1Database;
  // Secrets (set via wrangler secret put)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  NEXUS_ENCRYPTION_KEY: string;
}

// ---- OAuth configuration ----

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const OAUTH_REDIRECT_URI = "nexus://oauth/callback";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
  "openid",
  "email",
  "profile",
].join(" ");

const GITHUB_SCOPES = "repo read:org workflow";

// ---- Intent classification ----

const INTENT_MODEL = "@cf/qwen/qwen1.5-0.5b-chat";
const SUMMARY_MODEL = "@cf/qwen/qwen1.5-14b-chat-awq";
const SMALL_SUMMARY_MODEL = "@cf/qwen/qwen1.5-1.8b-chat";

async function classifyIntent(transcript: string, env: Env): Promise<string> {
  const prompt = `You are an intent classifier. Read the user request and respond with exactly one word from this list:
- github (for GitHub PRs, issues, repos, code)
- gmail (for email, inbox, messages)
- calendar (for schedule, meetings, events, appointments)
- search (for web searches, looking up information)
- general (for anything else)

User request: "${transcript}"

Intent:`;

  try {
    const response = await env.AI.run(INTENT_MODEL, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 5,
    });
    const text = (response as { response?: string }).response?.trim().toLowerCase() || "";
    const word = text.split(/\s+/)[0].replace(/[^a-z]/g, "");
    if (["github", "gmail", "calendar", "search", "general"].includes(word)) return word;
    return keywordFallback(transcript);
  } catch {
    return keywordFallback(transcript);
  }
}

function keywordFallback(transcript: string): string {
  const t = transcript.toLowerCase();
  if (/\b(pr|pull request|repo|repository|commit|issue|branch|merge|github)\b/.test(t)) return "github";
  if (/\b(email|inbox|mail|message|gmail|send to)\b/.test(t)) return "gmail";
  if (/\b(calendar|schedule|meeting|event|appointment|today|tomorrow)\b/.test(t)) return "calendar";
  if (/\b(search|google|look up|find|what is|who is|where is)\b/.test(t)) return "search";
  return "general";
}

async function summarize(prompt: string, env: Env, useLarge = true): Promise<string> {
  const model = useLarge ? SUMMARY_MODEL : SMALL_SUMMARY_MODEL;
  try {
    const response = await env.AI.run(model, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    });
    return (response as { response?: string }).response?.trim() || "I couldn't summarize that.";
  } catch {
    if (useLarge) return summarize(prompt, env, false);
    return "I couldn't process that request.";
  }
}

// ---- D1 credential helpers ----

async function getCredentialsFromD1(env: Env, userId: string): Promise<{
  google?: { access_token: string; scopes: string; refresh_token?: string; expires_at?: number };
  github?: { access_token: string };
}> {
  const result = await env.DB.prepare(
    "SELECT provider, access_token, refresh_token, expires_at, scopes FROM oauth_tokens WHERE user_id = ?"
  ).bind(userId).all();

  const creds: Record<string, any> = {};
  for (const row of result.results || []) {
    creds[row.provider as string] = {
      access_token: row.access_token as string,
      refresh_token: row.refresh_token as string | undefined,
      expires_at: row.expires_at as number | undefined,
      scopes: row.scopes as string | undefined,
    };
  }
  return creds;
}

async function refreshGoogleToken(env: Env, refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`Google refresh failed: ${resp.status}`);
  const data = await resp.json() as any;
  return { access_token: data.access_token, expires_in: data.expires_in || 3600 };
}

async function getValidGoogleToken(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE user_id = ? AND provider = 'google'"
  ).bind(userId).first();

  if (!row) return null;

  const now = Date.now() / 1000;
  const expiresAt = row.expires_at as number;

  // Refresh if expired (with 60s buffer) and we have a refresh token
  if (expiresAt && now > expiresAt - 60 && row.refresh_token) {
    try {
      const refreshed = await refreshGoogleToken(env, row.refresh_token as string);
      const newExpiresAt = now + refreshed.expires_in;
      await env.DB.prepare(
        "UPDATE oauth_tokens SET access_token = ?, expires_at = ? WHERE user_id = ? AND provider = 'google'"
      ).bind(refreshed.access_token, newExpiresAt, userId).run();
      return refreshed.access_token;
    } catch {
      // Fall back to the stored token (might still work briefly)
      return row.access_token as string;
    }
  }

  return row.access_token as string;
}

async function getValidGithubToken(env: Env, userId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT access_token FROM oauth_tokens WHERE user_id = ? AND provider = 'github'"
  ).bind(userId).first();
  return row?.access_token as string | null;
}

// ---- GitHub handler ----

async function handleGitHub(req: NexusRequest, env: Env, token: string): Promise<string> {
  const transcript = req.task.request.toLowerCase();
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const prMatch = transcript.match(/(?:pr|pull request)\s*#?\s*(\d+)\s*(?:of|in|from)?\s*(?:repo\s+)?([\w\-./]+)?/);
  const listPrMatch = transcript.match(/(?:list|show|open)\s+(?:open\s+)?(?:prs|pull requests?)(?:\s+(?:in|of|from)\s+([\w\-./]+))?/);
  const issueMatch = transcript.match(/(?:issue|bug)\s*#?\s*(\d+)\s*(?:in|of|from)?\s*(?:repo\s+)?([\w\-./]+)?/);

  try {
    if (prMatch) {
      const prNum = prMatch[1];
      let repo = prMatch[2] || "zync";
      if (!repo.includes("/")) repo = `chitkul-lakshya/${repo}`;

      const resp = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNum}`, { headers });
      if (!resp.ok) return `I couldn't find PR #${prNum} in ${repo}. Error: ${resp.status}`;
      const pr = await resp.json() as Record<string, unknown>;
      const prInfo = `PR #${pr["number"]}: ${pr["title"]}
State: ${pr["state"]}, Mergeable: ${pr["mergeable_state"] || "unknown"}
Author: ${(pr["user"] as Record<string, string>)?.login || "unknown"}
Body: ${(pr["body"] as string || "").slice(0, 500)}
Changes: +${pr["additions"]} -${pr["deletions"]} across ${pr["changed_files"]} files`;

      return await summarize(
        `Summarize this GitHub PR for the user in 2-3 sentences. Be concise and mention the status, what it changes, and whether it's ready to merge:\n\n${prInfo}`,
        env
      );
    }

    if (listPrMatch) {
      let repo = listPrMatch[1] || "zync";
      if (!repo.includes("/")) repo = `chitkul-lakshya/${repo}`;

      const resp = await fetch(`https://api.github.com/repos/${repo}/pulls?state=open&per_page=10`, { headers });
      if (!resp.ok) return `I couldn't fetch PRs from ${repo}. Error: ${resp.status}`;
      const prs = await resp.json() as Array<Record<string, unknown>>;
      if (prs.length === 0) return `There are no open pull requests in ${repo}.`;
      const prList = prs.map((pr, i) =>
        `${i + 1}. PR #${pr["number"]}: ${pr["title"]} (by ${(pr["user"] as Record<string, string>)?.login})`
      ).join("\n");

      return await summarize(
        `The user asked for open PRs in ${repo}. Summarize this list concisely:\n\n${prList}`,
        env
      );
    }

    if (issueMatch) {
      const issueNum = issueMatch[1];
      let repo = issueMatch[2] || "zync";
      if (!repo.includes("/")) repo = `chitkul-lakshya/${repo}`;

      const resp = await fetch(`https://api.github.com/repos/${repo}/issues/${issueNum}`, { headers });
      if (!resp.ok) return `I couldn't find issue #${issueNum} in ${repo}. Error: ${resp.status}`;
      const issue = await resp.json() as Record<string, unknown>;
      const issueInfo = `Issue #${issue["number"]}: ${issue["title"]}
State: ${issue["state"]}
Author: ${(issue["user"] as Record<string, string>)?.login || "unknown"}
Body: ${(issue["body"] as string || "").slice(0, 500)}`;

      return await summarize(`Summarize this GitHub issue in 2-3 sentences:\n\n${issueInfo}`, env);
    }

    return await summarize(
      `The user asked: "${req.task.request}". This is a GitHub-related request but I couldn't parse a specific PR or issue number. Suggest how they might phrase it, e.g., "check PR 24 in owner/repo".`,
      env, false
    );
  } catch (err) {
    return `I had trouble reaching GitHub. Error: ${(err as Error).message}`;
  }
}

// ---- Gmail handler ----

async function handleGmail(req: NexusRequest, env: Env, token: string): Promise<string> {
  const transcript = req.task.request.toLowerCase();

  try {
    if (/\b(unread|inbox|recent|latest|new)\b/.test(transcript)) {
      const resp = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5",
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      if (!resp.ok) return `I couldn't access your Gmail. Error: ${resp.status}`;

      const data = await resp.json() as { messages?: Array<{ id: string }> };
      if (!data.messages || data.messages.length === 0) return "You have no unread emails. Your inbox is clean!";

      const emails = await Promise.all(
        data.messages.slice(0, 5).map(async (msg) => {
          const detail = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
            { headers: { "Authorization": `Bearer ${token}` } }
          );
          if (!detail.ok) return null;
          const msgData = await detail.json() as { payload?: { headers?: Array<{ name: string; value: string }> } };
          const headers = msgData.payload?.headers || [];
          const from = headers.find(h => h.name === "From")?.value || "Unknown";
          const subject = headers.find(h => h.name === "Subject")?.value || "(no subject)";
          return `From: ${from}\nSubject: ${subject}`;
        })
      );

      const validEmails = emails.filter(Boolean);
      if (validEmails.length === 0) return "I found unread emails but couldn't read their details.";

      return await summarize(
        `The user asked about unread emails. Summarize these concisely (who they're from and the subject):\n\n${validEmails.join("\n\n")}`,
        env
      );
    }

    return await summarize(
      `The user asked: "${req.task.request}". This is a Gmail-related request. Suggest they try "check unread emails" or "what's in my inbox".`,
      env, false
    );
  } catch (err) {
    return `I had trouble reaching Gmail. Error: ${(err as Error).message}`;
  }
}

// ---- Calendar handler ----

async function handleCalendar(req: NexusRequest, env: Env, token: string): Promise<string> {
  try {
    const now = new Date();
    const timeMin = now.toISOString();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const timeMax = endOfDay.toISOString();

    const resp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime&maxResults=10`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );

    if (!resp.ok) return `I couldn't access your calendar. Error: ${resp.status}`;

    const data = await resp.json() as { items?: Array<Record<string, unknown>> };
    if (!data.items || data.items.length === 0) return "You have no events scheduled for the rest of today.";

    const events = data.items.map((evt, i) => {
      const start = (evt["start"] as Record<string, string>)?.dateTime || (evt["start"] as Record<string, string>)?.date || "Unknown time";
      const summary = evt["summary"] || "(no title)";
      return `${i + 1}. ${start}: ${summary}`;
    }).join("\n");

    return await summarize(`The user asked about their schedule. Summarize today's events concisely:\n\n${events}`, env);
  } catch (err) {
    return `I had trouble reaching Google Calendar. Error: ${(err as Error).message}`;
  }
}

// ---- Search / General handlers ----

async function handleSearch(req: NexusRequest, env: Env): Promise<string> {
  return await summarize(`Answer this question concisely and accurately:\n\n${req.task.request}`, env);
}

async function handleGeneral(req: NexusRequest, env: Env): Promise<string> {
  return await summarize(
    `You are NEXUS, a helpful personal assistant. Answer the user's request concisely and naturally, as if speaking aloud:\n\n${req.task.request}`,
    env
  );
}

// ---- Request types ----

interface NexusRequest {
  request_id: string;
  requester: { id: string; device_id: string };
  task: { type: string; request: string };
}

// ---- Main entry point ----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });

    // ---- CORS preflight ----
    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // ---- Health ----
    if (path === "/health" && method === "GET") {
      return json({ ok: true, service: "NEXUS Worker", protocol: "text-only", serverless: true });
    }

    // ---- User registration ----
    if (path === "/api/register" && method === "POST") {
      return handleRegister(request, env, json);
    }

    // ---- OAuth: get auth URL ----
    if (path === "/oauth/auth-url" && method === "GET") {
      return handleAuthUrl(url, env, json);
    }

    // ---- OAuth: exchange code for tokens ----
    if (path === "/oauth/exchange" && method === "POST") {
      return handleOAuthExchange(request, env, json);
    }

    // ---- OAuth: status ----
    if (path === "/oauth/status" && method === "GET") {
      return handleOAuthStatus(url, env, json);
    }

    // ---- OAuth: disconnect ----
    if (path === "/oauth/disconnect" && method === "DELETE") {
      return handleOAuthDisconnect(request, env, json);
    }

    // ---- API keys: add ----
    if (path === "/apikeys/add" && method === "POST") {
      return handleAddApiKey(request, env, json);
    }

    // ---- API keys: remove ----
    if (path === "/apikeys/remove" && method === "DELETE") {
      return handleRemoveApiKey(request, env, json);
    }

    // ---- API keys: list ----
    if (path === "/apikeys/list" && method === "GET") {
      return handleListApiKeys(url, env, json);
    }

    // ---- Config check ----
    if (path === "/config/check" && method === "GET") {
      return json({
        google: { configured: !!env.GOOGLE_CLIENT_ID, scopes: GOOGLE_SCOPES },
        github: { configured: !!env.GITHUB_CLIENT_ID, scopes: GITHUB_SCOPES },
        redirect_uri: OAUTH_REDIRECT_URI,
      });
    }

    // ---- Main: process transcript ----
    if (path === "/" && method === "POST") {
      return handleTranscript(request, env, json);
    }

    return json({ error: "not found" }, 404);
  },
};

// ---- Registration handler ----

async function handleRegister(
  request: Request,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const userId = body.user_id || "";
  const deviceId = body.device_id || "";
  if (!userId || !deviceId) return json({ error: "user_id and device_id required" }, 400);

  const now = Date.now() / 1000;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO user_devices (user_id, device_id, device_name, os, device_token, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(userId, deviceId, body.device_name || "", body.os || "", body.device_token || null, now).run();

  return json({
    ok: true,
    user_id: userId,
    device_id: deviceId,
    server_config: {
      worker_url: new URL(request.url).origin,
      ws_url: "",  // no WebSocket — HTTP only
    },
    providers: {
      google: { configured: !!env.GOOGLE_CLIENT_ID, scopes: GOOGLE_SCOPES },
      github: { configured: !!env.GITHUB_CLIENT_ID, scopes: GITHUB_SCOPES },
    },
  });
}

// ---- OAuth auth URL handler ----

async function handleAuthUrl(
  url: URL,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  const provider = url.searchParams.get("provider") || "";
  const userId = url.searchParams.get("user_id") || "";
  const codeChallenge = url.searchParams.get("code_challenge") || "";

  if (provider === "google") {
    if (!env.GOOGLE_CLIENT_ID) return json({ error: "Google OAuth not configured" }, 500);
    const authUrl = (
      `https://accounts.google.com/o/oauth2/v2/auth`
      + `?client_id=${env.GOOGLE_CLIENT_ID}`
      + `&redirect_uri=${OAUTH_REDIRECT_URI}`
      + `&response_type=code`
      + `&scope=${encodeURIComponent(GOOGLE_SCOPES)}`
      + `&code_challenge=${codeChallenge}`
      + `&code_challenge_method=S256`
      + `&state=${userId}`
      + `&access_type=offline`
      + `&prompt=consent`
    );
    return json({ url: authUrl, redirect_uri: OAUTH_REDIRECT_URI });
  }

  if (provider === "github") {
    if (!env.GITHUB_CLIENT_ID) return json({ error: "GitHub OAuth not configured" }, 500);
    const authUrl = (
      `https://github.com/login/oauth/authorize`
      + `?client_id=${env.GITHUB_CLIENT_ID}`
      + `&redirect_uri=${OAUTH_REDIRECT_URI}`
      + `&scope=${encodeURIComponent(GITHUB_SCOPES)}`
      + `&state=${userId}`
    );
    return json({ url: authUrl, redirect_uri: OAUTH_REDIRECT_URI });
  }

  return json({ error: `unsupported provider: ${provider}` }, 400);
}

// ---- OAuth exchange handler ----

async function handleOAuthExchange(
  request: Request,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }

  const provider = body.provider || "";
  const code = body.code || "";
  const codeVerifier = body.code_verifier || "";
  const userId = body.user_id || "";
  const redirectUri = body.redirect_uri || OAUTH_REDIRECT_URI;

  if (!provider || !code || !userId) return json({ error: "missing required fields" }, 400);

  try {
    let tokens: any;
    if (provider === "google") {
      const resp = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });
      if (!resp.ok) return json({ error: "Google exchange failed" }, 502);
      tokens = await resp.json();
    } else if (provider === "github") {
      const resp = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }),
      });
      if (!resp.ok) return json({ error: "GitHub exchange failed" }, 502);
      tokens = await resp.json();
      if (!tokens.access_token) return json({ error: tokens.error || "exchange failed" }, 400);
    } else {
      return json({ error: `unsupported provider: ${provider}` }, 400);
    }

    // Store in D1
    const now = Date.now() / 1000;
    const expiresAt = tokens.expires_in ? now + tokens.expires_in : 0;

    // Get account_id (GitHub login or Google email)
    let accountId = userId;
    if (provider === "github") {
      try {
        const ghResp = await fetch("https://api.github.com/user", {
          headers: { "Authorization": `Bearer ${tokens.access_token}` },
        });
        if (ghResp.ok) {
          const ghUser = await ghResp.json() as any;
          accountId = ghUser.login || userId;
        }
      } catch { /* ignore */ }
    }

    await env.DB.prepare(
      "INSERT OR REPLACE INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scopes, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      userId, provider, tokens.access_token,
      tokens.refresh_token || null, expiresAt,
      provider === "google" ? GOOGLE_SCOPES : GITHUB_SCOPES,
      accountId, now
    ).run();

    return json({ ok: true, provider, connected: true });
  } catch (err) {
    return json({ error: `exchange error: ${(err as Error).message}` }, 500);
  }
}

// ---- OAuth status handler ----

async function handleOAuthStatus(
  url: URL,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  const userId = url.searchParams.get("user_id") || "";
  if (!userId) return json({ error: "user_id required" }, 400);

  const result = await env.DB.prepare(
    "SELECT provider, expires_at, scopes FROM oauth_tokens WHERE user_id = ?"
  ).bind(userId).all();

  const connected: Record<string, any> = {};
  const now = Date.now() / 1000;
  for (const row of result.results || []) {
    const expiresAt = row.expires_at as number;
    connected[row.provider as string] = {
      connected: true,
      expired: expiresAt ? now > expiresAt : false,
      scopes: row.scopes as string,
    };
  }
  return json({ user_id: userId, providers: connected });
}

// ---- OAuth disconnect handler ----

async function handleOAuthDisconnect(
  request: Request,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const userId = body.user_id || "";
  const provider = body.provider || "";
  if (!userId || !provider) return json({ error: "user_id and provider required" }, 400);

  await env.DB.prepare(
    "DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?"
  ).bind(userId, provider).run();

  return json({ ok: true, disconnected: provider });
}

// ---- API key handlers ----

async function handleAddApiKey(
  request: Request,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const userId = body.user_id || "";
  const provider = body.provider || "";
  const apiKey = body.api_key || "";
  if (!userId || !provider || !apiKey) return json({ error: "missing required fields" }, 400);

  // Simple obfuscation (not real encryption in Worker — D1 is already encrypted at rest)
  const encrypted = btoa(apiKey);
  const now = Date.now() / 1000;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO api_keys (user_id, provider, key_encrypted, created_at) VALUES (?, ?, ?, ?)"
  ).bind(userId, provider, encrypted, now).run();

  return json({ ok: true, provider, stored: true });
}

async function handleRemoveApiKey(
  request: Request,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  let body: any;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  await env.DB.prepare(
    "DELETE FROM api_keys WHERE user_id = ? AND provider = ?"
  ).bind(body.user_id || "", body.provider || "").run();
  return json({ ok: true, removed: body.provider });
}

async function handleListApiKeys(
  url: URL,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  const userId = url.searchParams.get("user_id") || "";
  if (!userId) return json({ error: "user_id required" }, 400);
  const result = await env.DB.prepare(
    "SELECT provider FROM api_keys WHERE user_id = ?"
  ).bind(userId).all();
  return json({ user_id: userId, providers: (result.results || []).map(r => r.provider) });
}

// ---- Main transcript handler ----

async function handleTranscript(
  request: Request,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  let req: NexusRequest;
  try { req = await request.json() as NexusRequest; } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  if (!req.task?.request) return json({ error: "missing task.request" }, 400);

  const userId = req.requester?.id || "";
  if (!userId) return json({ error: "missing requester.id" }, 400);

  // 1. Classify intent
  const intent = await classifyIntent(req.task.request, env);

  // 2. Get credentials from D1 based on intent
  let replyText: string;

  try {
    if (intent === "github") {
      const token = await getValidGithubToken(env, userId);
      if (!token) {
        replyText = "You haven't connected your GitHub account yet. Please connect it in the NEXUS setup.";
      } else {
        replyText = await handleGitHub(req, env, token);
      }
    } else if (intent === "gmail") {
      const token = await getValidGoogleToken(env, userId);
      if (!token) {
        replyText = "You haven't connected your Google account yet. Please connect it in the NEXUS setup.";
      } else {
        replyText = await handleGmail(req, env, token);
      }
    } else if (intent === "calendar") {
      const token = await getValidGoogleToken(env, userId);
      if (!token) {
        replyText = "You haven't connected your Google account yet. Please connect it in the NEXUS setup.";
      } else {
        replyText = await handleCalendar(req, env, token);
      }
    } else if (intent === "search") {
      replyText = await handleSearch(req, env);
    } else {
      replyText = await handleGeneral(req, env);
    }
  } catch (err) {
    replyText = `I ran into an error processing that request: ${(err as Error).message}`;
  }

  return json({ request_id: req.request_id, reply_text: replyText, intent });
}
