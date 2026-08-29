# NEXUS Cloudflare Worker

Replaces the n8n supervisor. Runs on Cloudflare's global edge network with
sub-5ms cold starts.

## What it does

```
NEXUS laptop → sidecar → this Worker → API calls (GitHub/Google) → text response → sidecar → NEXUS
```

1. Receives transcript text + credentials from the sidecar
2. Classifies intent (GitHub / Gmail / Calendar / Search / General) using Workers AI
3. Routes to the appropriate handler
4. Calls external APIs (GitHub, Google) using the user's OAuth tokens
5. Summarizes the result using Workers AI
6. Returns text to the sidecar

## Performance

| Metric | n8n (old) | Worker (new) |
|--------|-----------|-------------|
| Cold start | 2,300ms | <5ms |
| Intent classification | 500ms (Ollama) | <50ms (Workers AI) |
| Total overhead | 3,500ms | <100ms |
| Free tier | $30/mo VPS | 100K req/day + 10K neurons/day |

## Setup (5 minutes)

### 1. Install Wrangler

```bash
cd server/worker
npm install
```

### 2. Login to Cloudflare

```bash
npx wrangler login
```

This opens a browser. Sign up / log in to Cloudflare (free account).

### 3. Set the sidecar URL

Edit `wrangler.toml` and set `SIDECAR_URL` to your server's address:

```toml
[vars]
SIDECAR_URL = "http://100.71.60.31:8443"
```

If your sidecar uses a bearer token, set it as a secret:

```bash
npx wrangler secret put SIDECAR_TOKEN
# Paste your NEXUS_SIDECAR_TOKEN value when prompted
```

### 4. Deploy

```bash
npx wrangler deploy
```

Output:
```
Published nexus-worker (1.2 sec)
  https://nexus-worker.<your-subdomain>.workers.dev
```

That URL is your Worker endpoint. The sidecar sends requests there.

### 5. Update the sidecar

Set `NEXUS_WORKER_URL` in the sidecar's `.env`:

```bash
NEXUS_WORKER_URL=https://nexus-worker.your-subdomain.workers.dev
```

Restart the sidecar. Done — n8n is no longer needed.

## Local development

```bash
npx wrangler dev
```

Runs locally at `http://localhost:8785`. The sidecar can point to this for testing.

## Supported intents

| Intent | Example phrases | What it does |
|--------|----------------|--------------|
| `github` | "check PR 24 in zync" | Fetches PR/issue from GitHub API, summarizes |
| `gmail` | "check unread emails" | Lists unread Gmail, summarizes senders + subjects |
| `calendar` | "what's on my calendar today" | Fetches today's events, summarizes |
| `search` | "what is the capital of France" | Uses Workers AI to answer knowledge questions |
| `general` | anything else | Uses Workers AI for general conversation |

## Adding new intents

1. Add the intent name to the classifier prompt in `src/index.ts`
2. Write a handler function: `async function handleX(req, env): Promise<string>`
3. Add a `case` in the `switch` statement

## Cost

| Usage | Free tier | Your usage | Cost |
|-------|-----------|------------|------|
| Requests | 100K/day | ~50-200/day | $0 |
| AI neurons | 10K/day | ~500-2K/day | $0 |
| Total | — | — | **$0/month** |

Even at 1,000 requests/day, you'd use 1% of the free tier.

## Security

- The Worker is stateless (V8 isolate). No data persists between requests.
- OAuth tokens are sent in the payload from the sidecar, used for one API call,
  then garbage-collected. They are never stored or logged.
- The connection from the sidecar to the Worker is HTTPS (encrypted in transit).
- Workers AI requests are processed on Cloudflare's network and not used for training.

## Why not n8n?

n8n adds 50-200ms overhead per workflow step. A 5-step workflow (classify →
route → fetch credential → API call → summarize) adds 250-1000ms on top of
the actual work. The Worker does the same thing in <5ms of overhead.

n8n also requires a running server ($30/mo VPS), maintenance, and has 2.3s
cold starts after idle periods. The Worker is always warm, globally
distributed, and free.
