# 07 — Deployment Guide

Step-by-step guide to deploy the NEXUS research system from scratch.

## Prerequisites

- Node.js 18+ installed
- Cloudflare account with Workers Paid plan ($5/month)
- `wrangler` CLI installed (`npm install -g wrangler` or use `npx`)
- Cloudflare API token (set via `wrangler login`)
- Git clone of the NEXUS repository

## Step 1: Login to Cloudflare

```bash
cd server/worker
npx wrangler login
```

This opens a browser to authenticate with Cloudflare. After login,
wrangler can deploy Workers, create D1 databases, create KV namespaces,
and set secrets.

## Step 2: Create D1 database (if not exists)

```bash
npx wrangler d1 create nexus-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "nexus-db"
database_id = "paste-database-id-here"
```

## Step 3: Create KV namespace (if not exists)

```bash
npx wrangler kv namespace create CACHE
```

Copy the `id` from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "paste-kv-namespace-id-here"
```

## Step 4: Deploy D1 schema

```bash
npx wrangler d1 execute nexus-db --remote --file=schema.sql
```

This creates 5 tables:
- `usage_log` — per-user daily usage tracking
- `cache_entries` — D1 cache table (in addition to KV)
- `oauth_tokens` — encrypted Google/GitHub OAuth tokens
- `user_identity` — user identity isolation
- `analysis_cache` — GitHub PR/repo analysis cache

Verify:
```bash
npx wrangler d1 execute nexus-db --remote --command="SELECT name FROM sqlite_master WHERE type='table';"
```

## Step 5: Set Cloudflare secrets

### Research API keys

```bash
# Tavily (1,000 credits/month, no card)
echo "tvly-dev-xxxxxxxxxx" | npx wrangler secret put TAVILY_API_KEY

# SearchX (3,000 queries/day, no card)
echo "sk-sx-xxxxxxxxxx" | npx wrangler secret put SEARCHX_API_KEY

# Semantic Scholar (1 req/s, no card)
echo "VW2TUQWR5A" | npx wrangler secret put SEMANTIC_SCHOLAR_API_KEY

# Google Custom Search API key (100 queries/day, no card)
echo "AIzaSyxxxxxxxxxx" | npx wrangler secret put GOOGLE_CSE_API_KEY

# Google Custom Search Engine ID (cx)
echo "a1b2c3d4e5f6g7h8j" | npx wrangler secret put GOOGLE_CSE_CX

# Wolfram Alpha (2,000 calls/month, no card) — when received
echo "XXXXXX-XXXXXXXXXX" | npx wrangler secret put WOLFRAM_API_KEY

# Serper.dev (2,500 one-time, no card) — optional
echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" | npx wrangler secret put SERPER_API_KEY
```

### LLM API keys

```bash
# Google Gemini (1,500 req/day, no card)
echo "AQ.Ab8RN6Ljf-..." | npx wrangler secret put GEMINI_API_KEY

# Groq (14,400 req/day, no card)
echo "gsk_Lc4J6beG..." | npx wrangler secret put GROQ_API_KEY
```

### OAuth secrets (pre-existing, included for completeness)

```bash
echo "your-google-client-id" | npx wrangler secret put GOOGLE_CLIENT_ID
echo "your-google-client-secret" | npx wrangler secret put GOOGLE_CLIENT_SECRET
echo "your-github-client-id" | npx wrangler secret put GITHUB_CLIENT_ID
echo "your-github-client-secret" | npx wrangler secret put GITHUB_CLIENT_SECRET
echo "your-encryption-key" | npx wrangler secret put NEXUS_ENCRYPTION_KEY
```

### Verify all secrets are set

```bash
npx wrangler secret list
```

Expected output:
```
NAME                    TYPE
GEMINI_API_KEY          secret text
GROQ_API_KEY            secret text
TAVILY_API_KEY          secret text
SEARCHX_API_KEY         secret text
SEMANTIC_SCHOLAR_API_KEY secret text
GOOGLE_CSE_API_KEY      secret text
GOOGLE_CLIENT_ID        secret text
GOOGLE_CLIENT_SECRET    secret text
GITHUB_CLIENT_ID        secret text
GITHUB_CLIENT_SECRET    secret text
NEXUS_ENCRYPTION_KEY    secret text
```

## Step 6: Build and run tests

```bash
cd server/worker

# TypeScript check
npx tsc --noEmit

# Run tests
npx vitest run
```

Expected output:
```
Test Files  3 passed (3)
     Tests  28 passed (28)
```

## Step 7: Deploy the Worker

```bash
npx wrangler deploy
```

Expected output:
```
Total Upload: 133.69 KiB / gzip: 30.87 KiB
Worker Startup Time: 29 ms
Your worker has access to the following bindings:
- KV Namespaces:
  - CACHE: 2af54bd3039040969e2ffac4c745e443
- D1 Databases:
  - DB: nexus-db (4bca5d1b-55e1-4a30-bbf9-ca28cf96e3ea)
- AI:
  - Name: AI
Uploaded nexus-worker (8.53 sec)
Deployed nexus-worker triggers (1.50 sec)
  https://nexus-worker.chitkullakshya.workers.dev
```

## Step 8: Verify deployment

### Health check

```bash
curl https://nexus-worker.chitkullakshya.workers.dev/health
```

Expected:
```json
{
  "ok": true,
  "service": "NEXUS Worker",
  "protocol": "text-only",
  "serverless": true
}
```

### Test search query

```bash
curl -X POST https://nexus-worker.chitkullakshya.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"request_id":"test-1","requester":{"id":"test-user"},"task":{"request":"research on cloudflare"}}'
```

Expected: JSON with `reply_text` containing a cited answer and
`Sources:` section.

### Test general chat

```bash
curl -X POST https://nexus-worker.chitkullakshya.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"request_id":"test-2","requester":{"id":"test-user"},"task":{"request":"tell me a short joke"}}'
```

Expected: JSON with `reply_text` containing a short joke.

### Check which LLM provider was used

```bash
npx wrangler tail nexus-worker --format pretty
```

Then send a test request. You should see:
```
POST https://nexus-worker.chitkullakshya.workers.dev/ - Ok
  (log) [search] synthesis via gemini (gemini-flash-lite-latest)
```

## Step 9: Update the NEXUS desktop app

The desktop app connects to the Worker via the URL configured in
`src-tauri/src/network.rs`. Verify the URL is correct:

```
https://nexus-worker.chitkullakshya.workers.dev
```

If you changed the Worker name, update:
- `src-tauri/src/network.rs` — Worker URL
- `frontend/src/net/wsBridge.ts` — Fallback URL
- `server/worker/wrangler.toml` — `name` field

Rebuild the desktop app:
```bash
nexus build
```

## Troubleshooting

### "KV namespace not valid"

```
KV namespace 'replace-with-your-kv-namespace-id' is not valid.
```

**Fix:** Create the KV namespace (Step 3) and paste the real ID into
`wrangler.toml`.

### "D1_ERROR: no such table: usage_log"

```
D1_ERROR: no such table: usage_log: SQLITE_ERROR
```

**Fix:** Deploy the schema (Step 4):
```bash
npx wrangler d1 execute nexus-db --remote --file=schema.sql
```

### "gemini-2.5-flash is no longer available"

```
This model models/gemini-2.5-flash is no longer available to new users.
```

**Fix:** Use `gemini-flash-lite-latest` instead. Already fixed in
`external_llm.ts`.

### "llama-3.3-70b-versatile does not exist"

```
The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.
```

**Fix:** Use `qwen/qwen3.8-27b` instead. Already fixed in
`external_llm.ts`. Check current models with:
```bash
curl -s "https://api.groq.com/openai/v1/models" \
  -H "Authorization: Bearer gsk_xxx" \
  | python -c "import sys,json; data=json.load(sys.stdin); [print(m['id']) for m in data.get('data',[])]"
```

### LLM output contains reasoning steps

```
1. Analyze the Request:
   - Task: Research Cloudflare...
```

**Fix:** This happens when Mistral or GLM is used as the synthesis
model. The fix is already deployed — the cascade uses Gemini Flash
Lite (non-reasoning) first, then Groq Qwen 3.8 (non-reasoning), then
Cloudflare llama-3.2-3b (non-reasoning). If you still see reasoning,
check `wrangler tail` to see which provider is being used.

### Cached response contains old reasoning

If a query was cached before the model fix, the cached response will
still contain the old reasoning output. KV cache TTL is 24 hours, so
it will expire naturally. To force a cache miss, slightly modify the
query (e.g., "research on cloudflare inc" instead of "research on
cloudflare").

---

## File references

- **wrangler.toml:** `server/worker/wrangler.toml`
- **schema.sql:** `server/worker/schema.sql`
- **Env type:** `server/worker/src/quota.ts` → `interface Env`
- **Worker entry:** `server/worker/src/index.ts`
- **Research sources:** `server/worker/src/research.ts`
- **LLM cascade:** `server/worker/src/external_llm.ts`
- **Tests:** `server/worker/src/__tests__/`
- **TypeScript config:** `server/worker/tsconfig.json`
- **Vitest config:** `server/worker/vitest.config.ts`
