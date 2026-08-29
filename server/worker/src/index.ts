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
// Models confirmed available on Cloudflare Workers AI (Aug 2026).
// Small model for fast intent classification, larger for summarization.
// Two-tier PR analysis:
//   Primary: GLM-4.7-Flash (cheap, 131K context, covers 95% of PRs)
//   Deep:    GLM-5.3-Flash (1M context, for re-evaluation or large PRs)

const INTENT_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const SUMMARY_MODEL = "@cf/mistral/mistral-small-3.1-24b-instruct";
const SMALL_SUMMARY_MODEL = "@cf/meta/llama-3.2-3b-instruct";

// Primary analysis model — 10x cheaper than GLM-5.2
// $0.06/M input, $0.40/M output, 131K context, reasoning + function calling
const ANALYSIS_MODEL = "@cf/zai-org/glm-4.7-flash";

// Deep analysis model — for re-evaluation or PRs exceeding 131K context
// $0.15/M input, $0.50/M output, 1M context, multimodal
const DEEP_ANALYSIS_MODEL = "@cf/zai-org/glm-5.3-flash";

// Context threshold: if PR context exceeds this, use deep model (131K tokens ≈ 520K chars)
const FLASH_CONTEXT_LIMIT_CHARS = 520000;

// Track recent analyses to detect re-evaluation requests
// Maps "user_id:repo:prNumber" → timestamp of last analysis
const recentAnalyses = new Map<string, number>();
const RE_EVALUATION_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes

/**
 * Extract text from any Workers AI model response format.
 * - Older models (llama, mistral): { response: "text" }
 * - OpenAI-compatible (GLM-5.2, GLM-5.3-Flash): { choices: [{ message: { content: "text" } }] }
 * - Reasoning models (GLM-4.7-Flash): content may be null, reasoning_content has the thinking
 *   → if content is null, fall back to reasoning_content
 */
function extractText(response: any): string {
  if (response?.response) return response.response.trim();
  const msg = response?.choices?.[0]?.message;
  if (msg?.content) return msg.content.trim();
  // Reasoning model fallback: if content is null, use reasoning_content
  if (msg?.reasoning_content) return msg.reasoning_content.trim();
  if (response?.choices?.[0]?.text) return response.choices[0].text.trim();
  if (response?.result?.response) return response.result.response.trim();
  return "";
}

async function classifyIntent(transcript: string, env: Env): Promise<string> {
  // Check keyword fallback FIRST for reliable intent detection.
  // The LLM classifier is a secondary signal — keywords are more reliable
  // for the analyse vs. check distinction.
  const keywordIntent = keywordFallback(transcript);
  if (keywordIntent !== "general") {
    return keywordIntent;
  }

  const prompt = `You are an intent classifier. Read the user request and respond with exactly one word from this list:
- github (for GitHub PRs, issues, repos, code)
- gmail (for email, inbox, messages)
- calendar (for schedule, meetings, events, appointments)
- search (for web searches, looking up information)
- general (for anything else)

User request: "${transcript}"

Intent:`;

  try {
    const response = await env.AI.run(INTENT_MODEL as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 5,
    });
    const text = extractText(response).toLowerCase();
    const word = text.split(/\s+/)[0].replace(/[^a-z]/g, "");
    if (["github", "gmail", "calendar", "search", "general"].includes(word)) return word;
    return "general";
  } catch {
    return "general";
  }
}

  // Architecture Mapper intent — e.g. "analyze this repo", "map the codebase", "architecture", "what breaks"
  if (/\b(analy[sz]e|map|understand|explore|scan|visuali[sz]e)\b/.test(t)
      && /\b(repo|repository|codebase|project|architecture|dependencies|dependency)\b/.test(t)) {
    return "analyze_repo";
  }
  if (/\b(what breaks|blast radius|impact analysis|consequence)\b/.test(t)) {
    return "analyze_repo";
  }

  // Deep analysis intent — keywords like "analyse", "analyze", "review", "deep dive"
  // Must match BEFORE the generic github check
  if (/\b(analy[sz]e|analy[sz]ing|analy[sz]is|review|deep\s*dive|critique|evaluate|assess|inspect|examine|take\s+another\s+look|look\s+at)\b/.test(t)
      && /\b(pr|pull\s*request|repo|repository|code|commit|branch|merge|github|diff|patch|change)\b/.test(t)) {
    return "github_analyse";
  }

  // Also catch "analyse the PR" / "review the PR" even without explicit github keyword
  if (/\b(analy[sz]e|review|deep\s*dive|critique|evaluate|take\s+another\s+look)\b/.test(t)
      && /\b(pr|pull\s*request)\b/.test(t)) {
    return "github_analyse";
  }

  // STT often mishears "analyse" as "unless", "analyze" (without the 's'), etc.
  // If the transcript contains "PR <number>" + "in <something>", treat it as
  // github_analyse — the user clearly wants a PR analysis.
  if (/\bpr\s*#?\s*\d+\b/.test(t) && /\b(in|of|from)\b/.test(t)) {
    return "github_analyse";
  }

  if (/\b(pr|pull request|repo|repository|commit|issue|branch|merge|github)\b/.test(t)) return "github";
  if (/\b(email|inbox|mail|message|gmail|send to)\b/.test(t)) return "gmail";
  if (/\b(calendar|schedule|meeting|event|appointment|today|tomorrow)\b/.test(t)) return "calendar";
  if (/\b(search|google|look up|find|what is|who is|where is)\b/.test(t)) return "search";
  return "general";
}

async function summarize(prompt: string, env: Env, useLarge = true): Promise<string> {
  const model = useLarge ? SUMMARY_MODEL : SMALL_SUMMARY_MODEL;
  try {
    const response = await env.AI.run(model as any, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
    });
    return extractText(response) || "I couldn't summarize that.";
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
  const transcriptLower = req.task.request.toLowerCase();
  const transcriptOrig = req.task.request;  // preserve case for repo names
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "NEXUS-Worker",
  };

  // Match on lowercased transcript for keywords, but extract repo from original
  const prMatch = transcriptLower.match(/(?:pr|pull request)\s*#?\s*(\d+)\s*(?:of|in|from)?\s*(?:repo\s+)?([\w\-./]+)?/);
  const listPrMatch = transcriptLower.match(/(?:list|show|open)\s+(?:open\s+)?(?:prs|pull requests?)(?:\s+(?:in|of|from)\s+([\w\-./]+))?/);
  const issueMatch = transcriptLower.match(/(?:issue|bug)\s*#?\s*(\d+)\s*(?:in|of|from)?\s*(?:repo\s+)?([\w\-./]+)?/);

  // Extract repo name from the original transcript (preserves case)
  function extractRepo(lowerMatch: RegExpMatchArray | null): string | null {
    if (!lowerMatch || !lowerMatch[2]) return null;
    // Find the repo name in the original transcript at the same position
    const repoLower = lowerMatch[2];
    const idx = transcriptLower.indexOf(repoLower);
    if (idx >= 0) return transcriptOrig.substr(idx, repoLower.length);
    return repoLower;
  }

  try {
    if (prMatch) {
      const prNum = prMatch[1];
      let repo = extractRepo(prMatch) || "zync";
      if (!repo.includes("/")) {
        // Try to resolve via user's repos
        const resolved = await resolveRepo(token, repo);
        if (resolved) repo = resolved;
      }

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
      let repo = extractRepo(listPrMatch) || "zync";
      if (!repo.includes("/")) {
        const resolved = await resolveRepo(token, repo);
        if (resolved) repo = resolved;
      }

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
      let repo = extractRepo(issueMatch) || "zync";
      if (!repo.includes("/")) {
        const resolved = await resolveRepo(token, repo);
        if (resolved) repo = resolved;
      }

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

// ---- GitHub deep analysis handler (GLM-5.2) ----

/**
 * Parse a PR number and repo from the transcript.
 * Patterns:
 *   "analyse PR 24 in zync"        → pr=24, repo=zync
 *   "analyse the PR of zync"       → latest PR, repo=zync
 *   "review PR 76 in owner/repo"   → pr=76, repo=owner/repo
 *   "analyse the pull request"     → latest PR, default repo
 */
function parsePRRequest(transcript: string): { prNumber: number | null; repoName: string | null } {
  const tLower = transcript.toLowerCase();

  // "PR 24", "PR #24", "pull request 24"
  const prNumMatch = tLower.match(/(?:pr|pull\s*request)\s*#?\s*(\d+)/);
  const prNumber = prNumMatch ? parseInt(prNumMatch[1], 10) : null;

  // "in zync", "of zync", "in owner/repo", "from owner/repo"
  // Exclude "of PR" and "of pull" — those are not repo names
  // Also exclude common English words that follow "of/in/from"
  const repoMatch = tLower.match(/(?:in|of|from)\s+(?!pr\b|pull\b|the\b|this\b|that\b|a\b|an\b)([\w\-./]+)/);
  if (!repoMatch || !repoMatch[1]) {
    return { prNumber, repoName: null };
  }
  // Extract from original transcript to preserve case
  const repoLower = repoMatch[1];
  const idx = tLower.indexOf(repoLower);
  const repoName = idx >= 0 ? transcript.substr(idx, repoLower.length) : repoLower;

  return { prNumber, repoName };
}

/**
 * Resolve a repo name to a full owner/repo string by searching the user's repos.
 * If the name already contains "/", use it as-is.
 * Otherwise, search the user's repos for a case-insensitive match.
 */
async function resolveRepo(token: string, repoName: string | null): Promise<string | null> {
  if (!repoName) {
    // No repo specified — return null (caller will handle)
    return null;
  }
  if (repoName.includes("/")) {
    return repoName;
  }

  // Search user's repos for a case-insensitive match
  try {
    const resp = await fetch(
      `https://api.github.com/user/repos?per_page=100&sort=updated`,
      { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json", "User-Agent": "NEXUS-Worker" } },
    );
    if (!resp.ok) return null;
    const repos = await resp.json() as Array<Record<string, unknown>>;
    const target = repoName.toLowerCase();

    // 1. Try exact match first
    const exact = repos.find(r => (r["name"] as string)?.toLowerCase() === target);
    if (exact) return exact["full_name"] as string;

    // 2. Try partial match (target is a substring of repo name, or vice versa)
    const partial = repos.find(r => {
      const name = (r["name"] as string)?.toLowerCase();
      return name && (name.includes(target) || target.includes(name));
    });
    if (partial) return partial["full_name"] as string;

    // 3. FUZZY MATCH: STT often mishears repo names (e.g. "servx" → "service",
    //    "weeks", "serve x"). Use Levenshtein distance + prefix matching to
    //    find the closest repo name. This handles phonetic mishearings.
    const repoNames = repos
      .map(r => (r["name"] as string) || "")
      .filter(n => n.length > 0);

    let bestMatch: string | null = null;
    let bestScore = Infinity;

    for (const repoName_ of repoNames) {
      const candidate = repoName_.toLowerCase();
      // Skip repos that are too different in length (avoid matching "a" to "servx")
      if (Math.abs(candidate.length - target.length) > Math.max(3, target.length)) continue;

      // Levenshtein distance
      const dist = levenshtein(target, candidate);
      // Normalised score: distance / max_length (0 = perfect match, 1 = totally different)
      const score = dist / Math.max(target.length, candidate.length);

      // Also check prefix match (first 3 chars) — "ser" matches "servx" and "service"
      const prefixLen = Math.min(3, Math.min(target.length, candidate.length));
      const prefixMatch = target.substring(0, prefixLen) === candidate.substring(0, prefixLen);

      // If prefix matches, reduce the effective score (bonus for phonetic similarity)
      const adjustedScore = prefixMatch ? score * 0.5 : score;

      // Accept if normalised distance < 0.6 (i.e. >40% of chars match)
      if (adjustedScore < 0.6 && adjustedScore < bestScore) {
        bestScore = adjustedScore;
        bestMatch = repoName_;
      }
    }

    if (bestMatch) {
      const matched = repos.find(r => (r["name"] as string) === bestMatch);
      if (matched) return matched["full_name"] as string;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Levenshtein edit distance between two strings.
 * Used for fuzzy repo name matching when STT mishears the name.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}

/**
 * Fetch full PR context via GitHub REST API (no cloning needed).
 * Returns: metadata, files with diffs, commits, and review comments.
 */
async function fetchPRContext(
  token: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "NEXUS-Worker",
  };

  // 1. PR metadata
  const prResp = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, { headers });
  if (!prResp.ok) {
    if (prResp.status === 404) return `__ERROR__: PR #${prNumber} not found in ${repo}.`;
    return `__ERROR__: GitHub API returned ${prResp.status} for PR #${prNumber}.`;
  }
  const pr = await prResp.json() as Record<string, unknown>;

  // 2. Files with diffs (parallel with commits + comments)
  const [filesResp, commitsResp, commentsResp, reviewsResp] = await Promise.all([
    fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/files?per_page=100`, { headers }),
    fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/commits?per_page=100`, { headers }),
    fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=50`, { headers }),
    fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews?per_page=50`, { headers }),
  ]);

  const files = filesResp.ok ? await filesResp.json() as Array<Record<string, unknown>> : [];
  const commits = commitsResp.ok ? await commitsResp.json() as Array<Record<string, unknown>> : [];
  const comments = commentsResp.ok ? await commentsResp.json() as Array<Record<string, unknown>> : [];
  const reviews = reviewsResp.ok ? await reviewsResp.json() as Array<Record<string, unknown>> : [];

  // 3. Assemble context (truncate to stay under 250K tokens)
  const meta = `PR #${pr["number"]}: ${pr["title"]}
Repository: ${repo}
State: ${pr["state"]} | Draft: ${pr["draft"] ? "yes" : "no"} | Mergeable: ${pr["mergeable_state"] || "unknown"}
Author: ${(pr["user"] as Record<string, string>)?.login || "unknown"}
Created: ${pr["created_at"]} | Updated: ${pr["updated_at"]}
Branch: ${pr["head"] ? (pr["head"] as Record<string, string>).ref : "unknown"} → ${pr["base"] ? (pr["base"] as Record<string, string>).ref : "unknown"}
Changes: +${pr["additions"]} -${pr["deletions"]} across ${pr["changed_files"]} files
Commits: ${pr["commits"]}

Description:
${(pr["body"] as string || "(no description provided)").slice(0, 2000)}`;

  // Files with diffs — keep patches but truncate very long ones
  const MAX_PATCH_PER_FILE = 3000;
  const MAX_TOTAL_PATCH = 200000;  // ~50K tokens
  let totalPatchLen = 0;
  const fileSections: string[] = [];

  for (const file of files) {
    const filename = file["filename"] as string;
    const status = file["status"] as string;
    const additions = file["additions"] as number;
    const deletions = file["deletions"] as number;
    let patch = (file["patch"] as string) || "(binary file or no patch available)";

    if (patch.length > MAX_PATCH_PER_FILE) {
      patch = patch.slice(0, MAX_PATCH_PER_FILE) + "\n... (truncated)";
    }

    if (totalPatchLen + patch.length > MAX_TOTAL_PATCH) {
      fileSections.push(`--- ${filename} (${status}, +${additions} -${deletions})\n(diff truncated — too many changes)`);
      continue;
    }
    totalPatchLen += patch.length;

    fileSections.push(`--- ${filename} (${status}, +${additions} -${deletions})
${patch}`);
  }

  // Commits
  const commitList = commits.slice(0, 30).map((c) => {
    const msg = (c["commit"] as Record<string, { message?: string }>)?.commit?.message || "";
    const author = (c["commit"] as Record<string, { author?: { name?: string } }>)?.commit?.author?.name || "unknown";
    return `  ${c["sha"]?.toString().slice(0, 7)} ${msg.split("\n")[0]} (${author})`;
  }).join("\n");

  // Review comments (inline code comments)
  const commentList = comments.slice(0, 30).map((c) => {
    const user = (c["user"] as Record<string, string>)?.login || "unknown";
    const body = (c["body"] as string || "").slice(0, 500);
    const path = c["path"] as string;
    const line = c["line"] || c["original_line"] || "?";
    return `  ${user} on ${path}:${line}: ${body}`;
  }).join("\n");

  // Reviews
  const reviewList = reviews.slice(0, 20).map((r) => {
    const user = (r["user"] as Record<string, string>)?.login || "unknown";
    const state = r["state"] as string;
    const body = (r["body"] as string || "").slice(0, 500);
    return `  ${user}: ${state}${body ? ` — ${body}` : ""}`;
  }).join("\n");

  return `${meta}

=== FILES CHANGED (${files.length}) ===
${fileSections.join("\n\n")}

=== COMMITS (${commits.length}) ===
${commitList || "(none)"}

=== REVIEW COMMENTS (${comments.length}) ===
${commentList || "(none)"}

=== REVIEWS (${reviews.length}) ===
${reviewList || "(none)"}`;
}

/**
 * Deep PR analysis using GLM-5.2.
 * Fetches PR data via GitHub API, sends to GLM-5.2 for analysis.
 */
/**
 * Detect if this is a re-evaluation request.
 * Triggers on phrases like "re-analyse", "deeper review", "re-evaluate", "again".
 * Also checks if the same PR was analysed recently (within 5 minutes).
 */
function isReEvaluationRequest(transcript: string, userId: string, repo: string, prNumber: number): boolean {
  const t = transcript.toLowerCase();
  // Explicit re-evaluation keywords
  if (/\b(re-?analy[sz]e|re-?evaluat|deeper\s+review|again|re-?review|more\s+thorough|take\s+another\s+look)\b/.test(t)) {
    return true;
  }
  // Same PR analysed recently → assume re-evaluation
  const key = `${userId}:${repo}:${prNumber}`;
  const lastTime = recentAnalyses.get(key);
  if (lastTime && (Date.now() - lastTime) < RE_EVALUATION_WINDOW_MS) {
    return true;
  }
  return false;
}

async function handleGitHubAnalyse(req: NexusRequest, env: Env, token: string): Promise<string> {
  const { prNumber, repoName } = parsePRRequest(req.task.request);
  const userId = req.requester.id;

  try {
    // Resolve the repo name to a full owner/repo
    const repo = await resolveRepo(token, repoName);
    if (!repo) {
      return `I couldn't find a repository matching "${repoName}" in your GitHub account. Try specifying the full name, like "analyse PR 24 in owner/repo".`;
    }

    let actualPrNumber = prNumber;

    // If no PR number specified, get the most recent PR (open or closed)
    if (!actualPrNumber) {
      const headers: Record<string, string> = {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "NEXUS-Worker",
      };
      const resp = await fetch(`https://api.github.com/repos/${repo}/pulls?state=all&per_page=1&sort=created&direction=desc`, { headers });
      if (!resp.ok) {
        return `I couldn't find any pull requests in ${repo}. Error: ${resp.status}. Try saying "analyse PR 24 in ${repo}".`;
      }
      const prs = await resp.json() as Array<Record<string, unknown>>;
      if (!prs || prs.length === 0) {
        return `There are no pull requests in ${repo}. Try specifying a PR number, like "analyse PR 24".`;
      }
      actualPrNumber = prs[0]["number"] as number;
    }

    // Fetch full PR context
    const context = await fetchPRContext(token, repo, actualPrNumber);

    if (context.startsWith("__ERROR__:")) {
      return context.replace("__ERROR__:", "");
    }

    // Determine which model to use:
    // 1. Re-evaluation request → deep model (GLM-5.3-Flash, 1M context)
    // 2. Context exceeds 131K tokens → deep model (GLM-5.3-Flash, 1M context)
    // 3. Default → primary model (GLM-4.7-Flash, 131K context, 10x cheaper)
    const isReEval = isReEvaluationRequest(req.task.request, userId, repo, actualPrNumber);
    const contextTooLarge = context.length > FLASH_CONTEXT_LIMIT_CHARS;
    const useDeepModel = isReEval || contextTooLarge;
    const model = useDeepModel ? DEEP_ANALYSIS_MODEL : ANALYSIS_MODEL;

    // Record this analysis for re-evaluation detection
    const analysisKey = `${userId}:${repo}:${actualPrNumber}`;
    recentAnalyses.set(analysisKey, Date.now());

    // Clean up old entries (keep map small)
    if (recentAnalyses.size > 100) {
      const now = Date.now();
      for (const [k, t] of recentAnalyses) {
        if (now - t > RE_EVALUATION_WINDOW_MS) recentAnalyses.delete(k);
      }
    }

    const modelLabel = useDeepModel
      ? (isReEval ? "DEEP REVIEW (re-evaluation)" : "DEEP REVIEW (large PR)")
      : "CODE REVIEW";

    // Build analysis prompt
    const analysisPrompt = `You are a senior software engineer performing a thorough code review. Analyse this pull request and provide a detailed review.

Cover these areas:
1. **Summary**: What does this PR do? (1-2 sentences)
2. **Risk Assessment**: Are there bugs, security issues, or breaking changes?
3. **Code Quality**: Is the code clean, well-structured, and maintainable?
4. **Suggestions**: What would you improve before merging?
5. **Verdict**: Is this safe to merge? (approve / request changes / block)

Be specific — reference file names and line numbers when pointing out issues.
If the PR is small or straightforward, keep the review concise.

${useDeepModel ? "Note: This is a DEEP review — be extra thorough. Check edge cases, error handling, test coverage gaps, and security implications that might be missed in a quick review." : ""}

=== PULL REQUEST CONTEXT ===
${context}

=== YOUR ANALYSIS ===`;

    // GLM-4.7-Flash is a reasoning model — needs more tokens for reasoning + answer
    // GLM-5.3-Flash is more efficient but still needs adequate output space
    const maxTokens = useDeepModel ? 2500 : 3000;

    const response = await env.AI.run(model as any, {
      messages: [
        { role: "system", content: "You are a senior software engineer with expertise in code review, security, and software architecture. You provide thorough, actionable code reviews." },
        { role: "user", content: analysisPrompt },
      ],
      max_tokens: maxTokens,
    });

    const analysis = extractText(response);
    if (!analysis) {
      return `I fetched PR #${actualPrNumber} in ${repo} but couldn't generate an analysis. The PR has ${(context.match(/---/g) || []).length} changed files. Try asking a more specific question about it.`;
    }

    // Prefix deep reviews so the user knows which model was used
    if (useDeepModel) {
      return `[${modelLabel}] ${analysis}`;
    }
    return analysis;
  } catch (err) {
    return `I had trouble analysing the PR. Error: ${(err as Error).message}`;
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

    // ---- OAuth: browser callback (for testing — exchanges code automatically) ----
    if (path === "/oauth/callback" && method === "GET") {
      return handleOAuthBrowserCallback(url, env, json);
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

// ---- OAuth browser callback handler (for testing/manual flow) ----

async function handleOAuthBrowserCallback(
  url: URL,
  env: Env,
  json: (d: unknown, s?: number) => Response,
): Promise<Response> {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "test_user";
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`<html><body><h2>OAuth Error</h2><p>${error}</p></body></html>`, {
      headers: { "Content-Type": "text/html" },
    });
  }

  if (!code) {
    return new Response("<html><body><h2>Missing code</h2></body></html>", {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Exchange the code for tokens using the GitHub OAuth app
  // Note: redirect_uri must match what was used in the auth URL
  try {
    const resp = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: "https://nexus-worker.chitkullakshya.workers.dev/oauth/callback",
      }),
    });

    if (!resp.ok) {
      return new Response(`<html><body><h2>Exchange failed</h2><p>${resp.status}</p></body></html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    const tokens = await resp.json() as any;
    if (!tokens.access_token) {
      return new Response(`<html><body><h2>No token</h2><p>${JSON.stringify(tokens)}</p></body></html>`, {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Get GitHub username
    let accountId = state;
    try {
      const ghResp = await fetch("https://api.github.com/user", {
        headers: { "Authorization": `Bearer ${tokens.access_token}` },
      });
      if (ghResp.ok) {
        const ghUser = await ghResp.json() as any;
        accountId = ghUser.login || state;
      }
    } catch { /* ignore */ }

    // Store in D1
    const now = Date.now() / 1000;
    await env.DB.prepare(
      "INSERT OR REPLACE INTO oauth_tokens (user_id, provider, access_token, refresh_token, expires_at, scopes, account_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      state, "github", tokens.access_token,
      null, 0, GITHUB_SCOPES, accountId, now
    ).run();

    return new Response(
      `<html><body><h2>GitHub connected!</h2><p>User: ${state}</p><p>Account: ${accountId}</p><p>You can close this tab.</p></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  } catch (err) {
    return new Response(`<html><body><h2>Error</h2><p>${(err as Error).message}</p></body></html>`, {
      headers: { "Content-Type": "text/html" },
    });
  }
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
    if (intent === "analyze_repo") {
      replyText = await handleAnalyzeRepo(req, env);
    } else if (intent === "github_analyse") {
      const token = await getValidGithubToken(env, userId);
      if (!token) {
        replyText = "You haven't connected your GitHub account yet. Please connect it in the NEXUS setup to analyse PRs.";
      } else {
        replyText = await handleGitHubAnalyse(req, env, token);
      }
    } else if (intent === "github") {
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

// ---- Architecture Mapper Intent Handler ----

async function handleAnalyzeRepo(req: NexusRequest, env: Env): Promise<string> {
  const prompt = `The developer asked: "${req.task.request}".
Explain concisely that NEXUS is launching the Architecture Mapper to explore the codebase.
Highlight that NEXUS clusters directories into architectural layers (client, server, data, infra, shared), builds a real AST import dependency graph with cycle & hotspot detection, and runs sub-10ms reverse BFS impact analysis for any file changes. Keep your answer under 3 sentences.`;

  return await summarize(prompt, env);
}

