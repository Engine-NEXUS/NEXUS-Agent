/**
 * NEXUS Cloudflare Worker — replaces n8n supervisor.
 *
 * Receives transcript text + identity + credentials from the sidecar,
 * classifies intent, routes to the appropriate handler, calls external
 * APIs (GitHub, Google, etc.), summarizes the result, and returns text.
 *
 * Architecture:
 *   NEXUS laptop → sidecar (gets credentials) → this Worker → API calls → text
 *
 * The Worker is stateless (V8 isolate). No credentials are persisted.
 * Access tokens are used for one request and garbage-collected.
 *
 * Workers AI is used for:
 *   - Intent classification (small model, <50ms, free)
 *   - Result summarization (larger model, free tier covers personal use)
 *
 * Deploy:
 *   cd server/worker
 *   npx wrangler deploy
 */

// ---- Types ----

interface NexusRequest {
  request_id: string;
  requester: {
    id: string;
    device_id: string;
  };
  task: {
    type: string;
    request: string;
  };
  authorization: {
    providers: string[];
    credential_endpoint: string;
    credentials: {
      google?: { access_token: string; scopes: string };
      github?: { access_token: string };
      api_keys?: Record<string, string>;
    };
  };
}

interface NexusResponse {
  request_id: string;
  reply_text: string;
  intent: string;
}

interface Env {
  AI: Ai;
  SIDECAR_URL: string;
  SIDECAR_TOKEN: string;
}

// ---- Intent classification ----

const INTENT_MODEL = "@cf/qwen/qwen1.5-0.5b-chat";

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
    // Extract the first word and validate
    const word = text.split(/\s+/)[0].replace(/[^a-z]/g, "");
    if (["github", "gmail", "calendar", "search", "general"].includes(word)) {
      return word;
    }
    // Fallback: keyword matching
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

// ---- Summarization ----

const SUMMARY_MODEL = "@cf/qwen/qwen1.5-14b-chat-awq";
const SMALL_SUMMARY_MODEL = "@cf/qwen/qwen1.5-1.8b-chat";

async function summarize(prompt: string, env: Env, useLarge: boolean = true): Promise<string> {
  const model = useLarge ? SUMMARY_MODEL : SMALL_SUMMARY_MODEL;
  try {
    const response = await env.AI.run(model, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    });
    return (response as { response?: string }).response?.trim() || "I couldn't summarize that.";
  } catch {
    // Fall back to small model if large fails
    if (useLarge) return summarize(prompt, env, false);
    return "I couldn't process that request.";
  }
}

// ---- GitHub handler ----

async function handleGitHub(req: NexusRequest, env: Env): Promise<string> {
  const token = req.authorization.credentials.github?.access_token;
  if (!token) {
    return "You haven't connected your GitHub account yet. Please connect it in the NEXUS setup.";
  }

  const transcript = req.task.request.toLowerCase();

  // Parse: "check PR 24 of repo zync" or "check pr 24 in owner/repo"
  const prMatch = transcript.match(/(?:pr|pull request)\s*#?\s*(\d+)\s*(?:of|in|from)?\s*(?:repo\s+)?([\w\-./]+)?/);
  // Parse: "list open PRs in owner/repo"
  const listPrMatch = transcript.match(/(?:list|show|open)\s+(?:open\s+)?(?:prs|pull requests?)(?:\s+(?:in|of|from)\s+([\w\-./]+))?/);
  // Parse: "status of issue 42 in owner/repo"
  const issueMatch = transcript.match(/(?:issue|bug)\s*#?\s*(\d+)\s*(?:in|of|from)?\s*(?:repo\s+)?([\w\-./]+)?/);

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    if (prMatch) {
      const prNum = prMatch[1];
      let repo = prMatch[2] || "zync";
      if (!repo.includes("/")) repo = `chitkul-lakshya/${repo}`;

      const resp = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNum}`, { headers });
      if (!resp.ok) {
        return `I couldn't find PR #${prNum} in ${repo}. Error: ${resp.status}`;
      }
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
      if (!resp.ok) {
        return `I couldn't fetch PRs from ${repo}. Error: ${resp.status}`;
      }
      const prs = await resp.json() as Array<Record<string, unknown>>;
      if (prs.length === 0) {
        return `There are no open pull requests in ${repo}.`;
      }
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
      if (!resp.ok) {
        return `I couldn't find issue #${issueNum} in ${repo}. Error: ${resp.status}`;
      }
      const issue = await resp.json() as Record<string, unknown>;
      const issueInfo = `Issue #${issue["number"]}: ${issue["title"]}
State: ${issue["state"]}
Author: ${(issue["user"] as Record<string, string>)?.login || "unknown"}
Body: ${(issue["body"] as string || "").slice(0, 500)}`;

      return await summarize(
        `Summarize this GitHub issue in 2-3 sentences:\n\n${issueInfo}`,
        env
      );
    }

    // Generic GitHub query — use the API to search
    return await summarize(
      `The user asked: "${req.task.request}". This is a GitHub-related request but I couldn't parse a specific PR or issue number. Suggest how they might phrase it, e.g., "check PR 24 in owner/repo".`,
      env,
      false
    );
  } catch (err) {
    return `I had trouble reaching GitHub. Error: ${(err as Error).message}`;
  }
}

// ---- Gmail handler ----

async function handleGmail(req: NexusRequest, env: Env): Promise<string> {
  const token = req.authorization.credentials.google?.access_token;
  if (!token) {
    return "You haven't connected your Google account yet. Please connect it in the NEXUS setup.";
  }

  const transcript = req.task.request.toLowerCase();

  try {
    if (/\b(unread|inbox|recent|latest|new)\b/.test(transcript)) {
      // List recent unread emails
      const resp = await fetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=5",
        { headers: { "Authorization": `Bearer ${token}` } }
      );
      if (!resp.ok) return `I couldn't access your Gmail. Error: ${resp.status}`;

      const data = await resp.json() as { messages?: Array<{ id: string }> };
      if (!data.messages || data.messages.length === 0) {
        return "You have no unread emails. Your inbox is clean!";
      }

      // Fetch headers for each message
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
      if (validEmails.length === 0) {
        return "I found unread emails but couldn't read their details.";
      }

      return await summarize(
        `The user asked about unread emails. Summarize these concisely (who they're from and the subject):\n\n${validEmails.join("\n\n")}`,
        env
      );
    }

    return await summarize(
      `The user asked: "${req.task.request}". This is a Gmail-related request. Suggest they try "check unread emails" or "what's in my inbox".`,
      env,
      false
    );
  } catch (err) {
    return `I had trouble reaching Gmail. Error: ${(err as Error).message}`;
  }
}

// ---- Calendar handler ----

async function handleCalendar(req: NexusRequest, env: Env): Promise<string> {
  const token = req.authorization.credentials.google?.access_token;
  if (!token) {
    return "You haven't connected your Google account yet. Please connect it in the NEXUS setup.";
  }

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

    if (!resp.ok) {
      return `I couldn't access your calendar. Error: ${resp.status}`;
    }

    const data = await resp.json() as { items?: Array<Record<string, unknown>> };
    if (!data.items || data.items.length === 0) {
      return "You have no events scheduled for the rest of today.";
    }

    const events = data.items.map((evt, i) => {
      const start = (evt["start"] as Record<string, string>)?.dateTime || (evt["start"] as Record<string, string>)?.date || "Unknown time";
      const summary = evt["summary"] || "(no title)";
      return `${i + 1}. ${start}: ${summary}`;
    }).join("\n");

    return await summarize(
      `The user asked about their schedule. Summarize today's events concisely:\n\n${events}`,
      env
    );
  } catch (err) {
    return `I had trouble reaching Google Calendar. Error: ${(err as Error).message}`;
  }
}

// ---- Search handler ----

async function handleSearch(req: NexusRequest, env: Env): Promise<string> {
  // Use Workers AI to answer general knowledge questions directly
  return await summarize(
    `Answer this question concisely and accurately:\n\n${req.task.request}`,
    env
  );
}

// ---- General handler ----

async function handleGeneral(req: NexusRequest, env: Env): Promise<string> {
  return await summarize(
    `You are NEXUS, a helpful personal assistant. Answer the user's request concisely and naturally, as if speaking aloud:\n\n${req.task.request}`,
    env
  );
}

// ---- Main entry point ----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Health check
    if (request.method === "GET") {
      return new Response(JSON.stringify({
        ok: true,
        service: "NEXUS Worker",
        protocol: "text-only",
        timestamp: new Date().toISOString(),
      }), { headers: { "Content-Type": "application/json" }});
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json" },
      });
    }

    let req: NexusRequest;
    try {
      req = await request.json() as NexusRequest;
    } catch {
      return new Response(JSON.stringify({ error: "invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!req.task?.request) {
      return new Response(JSON.stringify({ error: "missing task.request" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Classify intent
    const intent = await classifyIntent(req.task.request, env);

    // 2. Route to handler
    let replyText: string;
    try {
      switch (intent) {
        case "github":
          replyText = await handleGitHub(req, env);
          break;
        case "gmail":
          replyText = await handleGmail(req, env);
          break;
        case "calendar":
          replyText = await handleCalendar(req, env);
          break;
        case "search":
          replyText = await handleSearch(req, env);
          break;
        default:
          replyText = await handleGeneral(req, env);
          break;
      }
    } catch (err) {
      replyText = `I ran into an error processing that request: ${(err as Error).message}`;
    }

    const response: NexusResponse = {
      request_id: req.request_id,
      reply_text: replyText,
      intent,
    };

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
