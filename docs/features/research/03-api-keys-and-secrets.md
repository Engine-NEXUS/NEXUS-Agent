# 03 — API Keys and Cloudflare Secrets

Every API key used by the NEXUS research system, where to get it, the
free tier details, and how to set it as a Cloudflare Worker secret.

## Current secret status

| # | Secret name | Status | Free quota | Set date |
|---|-------------|--------|------------|----------|
| 1 | `TAVILY_API_KEY` | ✅ Set | 1,000 credits/month | 2026-09-01 |
| 2 | `SEARCHX_API_KEY` | ✅ Set | 3,000 queries/day | 2026-09-01 |
| 3 | `GOOGLE_CSE_API_KEY` | ✅ Set | 100 queries/day | 2026-09-01 |
| 4 | `SEMANTIC_SCHOLAR_API_KEY` | ✅ Set | 1 req/s | 2026-09-01 |
| 5 | `GEMINI_API_KEY` | ✅ Set | 1,500 req/day | 2026-09-01 |
| 6 | `GROQ_API_KEY` | ✅ Set | 14,400 req/day | 2026-09-01 |
| 7 | `WOLFRAM_API_KEY` | ⏳ Pending | 2,000 calls/month | Waiting for approval |
| 8 | `SERPER_API_KEY` | ❌ Not set | 2,500 one-time | Not signed up |
| 9 | `GOOGLE_CSE_CX` | ⏳ Pending | — | Need to create CSE |
| 10 | `GOOGLE_CLIENT_ID` | ✅ Set (existing) | — | Pre-existing |
| 11 | `GOOGLE_CLIENT_SECRET` | ✅ Set (existing) | — | Pre-existing |
| 12 | `GITHUB_CLIENT_ID` | ✅ Set (existing) | — | Pre-existing |
| 13 | `GITHUB_CLIENT_SECRET` | ✅ Set (existing) | — | Pre-existing |
| 14 | `NEXUS_ENCRYPTION_KEY` | ✅ Set (existing) | — | Pre-existing |

---

## How to set a Cloudflare secret

All secrets are set via `wrangler secret put` from the worker directory:

```bash
cd server/worker
echo "your-api-key-here" | npx wrangler secret put SECRET_NAME
```

Secrets are encrypted and stored in Cloudflare's secret manager. They
are NOT visible in the dashboard, NOT in `wrangler.toml`, and NOT in
git. They are only accessible to the Worker at runtime via `env.SECRET_NAME`.

To list current secrets:
```bash
npx wrangler secret list
```

To delete a secret:
```bash
npx wrangler secret delete SECRET_NAME
```

---

## Key 1: Tavily API Key

| Field | Value |
|-------|-------|
| Secret name | `TAVILY_API_KEY` |
| Key format | `tvly-dev-xxxxxxxxxx` |
| Free tier | 1,000 credits/month |
| Card required | No |
| Signup URL | https://app.tavily.com/sign-in |
| Docs URL | https://docs.tavily.com/documentation/api-reference/endpoint/search |

### What it does

Tavily is an AI-optimized web search API. Unlike traditional search
APIs that return links, Tavily returns clean content extracted from
web pages, plus an AI-generated answer field. Built specifically for
RAG pipelines and AI agents.

### Free tier details

| Plan | Credits/month | Cost | Card |
|------|---------------|------|------|
| Researcher (Free) | 1,000 | $0 | No |
| Project | 4,000 | $30/mo | Yes |
| Bootstrap | 15,000 | $100/mo | Yes |

- 1 credit = 1 basic search
- 2 credits = 1 advanced search (deeper content extraction)
- Credits reset monthly
- No expiration on the free plan

### How to get the key

1. Go to https://app.tavily.com/sign-in
2. Sign up with email or Google
3. Go to Dashboard → API Keys
4. Copy the key (starts with `tvly-dev-` or `tvly-`)

### Set as Cloudflare secret

```bash
cd server/worker
echo "tvly-dev-xxxxxxxxxx" | npx wrangler secret put TAVILY_API_KEY
```

### Usage in code

```typescript
// research.ts → searchTavily()
const resp = await fetch("https://api.tavily.com/search", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${env.TAVILY_API_KEY}`,
  },
  body: JSON.stringify({
    query,
    max_results: 1,
    include_answer: true,
  }),
});
```

---

## Key 2: SearchX API Key

| Field | Value |
|-------|-------|
| Secret name | `SEARCHX_API_KEY` |
| Key format | `sk-sx-xxxxxxxxxx` |
| Free tier | 3,000 queries/day (90,000/month) |
| Card required | No |
| Signup URL | https://searchx.dev/signup |
| Docs URL | https://searchx.dev/api-docs |

### What it does

SearchX provides hybrid search (keyword + semantic) across 1B+ web
pages. Includes page extraction, AI answers, and image search. Highest
free quota of any search API.

### Free tier details

| Feature | Free tier |
|---------|-----------|
| Queries per day | 3,000 |
| Queries per month | ~90,000 |
| Search mode | Hybrid (BM25 + vector) |
| JS rendering | Included |
| Semantic search | Included |
| AI answer | Built-in |
| Card required | No |

### How to get the key

1. Go to https://searchx.dev/signup
2. Sign up with email
3. Key is displayed immediately (starts with `sk-sx-`)

### Set as Cloudflare secret

```bash
cd server/worker
echo "sk-sx-xxxxxxxxxx" | npx wrangler secret put SEARCHX_API_KEY
```

### Usage in code

```typescript
// research.ts → searchSearchX()
const resp = await fetch(
  `https://searchx.dev/api/v1/search?q=${encodeURIComponent(query)}&mode=hybrid`,
  {
    headers: {
      "Authorization": `Bearer ${env.SEARCHX_API_KEY}`,
      "Accept": "application/json",
    },
  },
);
```

---

## Key 3: Google Custom Search API Key

| Field | Value |
|-------|-------|
| Secret name | `GOOGLE_CSE_API_KEY` |
| Key format | `AIzaSyxxxxxxxxxx` |
| Free tier | 100 queries/day |
| Card required | No |
| Signup URL | https://console.cloud.google.com |

### What it does

Google Custom Search JSON API provides Google search results
programmatically. Requires both an API key AND a Custom Search Engine
ID (cx).

### Free tier details

| Plan | Queries/day | Cost |
|------|-------------|------|
| Free | 100 | $0 |
| Paid | $5 per 1,000 queries | Pay-as-you-go |

### How to get the API key

1. Go to https://console.cloud.google.com
2. Create or select a project
3. Enable "Custom Search API" (APIs & Services → Library → search "Custom Search")
4. Go to APIs & Services → Credentials → Create Credentials → API Key
5. Copy the key (starts with `AIzaSy`)

### How to get the cx ID (Custom Search Engine ID)

**This step is still pending.**

1. Go to https://programmablesearchengine.google.com/
2. Click "Create"
3. Name it `nexus`
4. In "Sites to search", enter any site (e.g., `wikipedia.org`) —
   this is required to proceed but will be overridden
5. Click "Create"
6. After creation, go to "Control Panel" → "Search features" →
   "Sites to search"
7. Change from "Search only included sites" to **"Search the entire
   web but emphasize included sites"**
8. Copy the **cx ID** (looks like `a1b2c3d4e5f6g7h8j`)

### Set as Cloudflare secrets

```bash
cd server/worker
echo "AIzaSyxxxxxxxxxx" | npx wrangler secret put GOOGLE_CSE_API_KEY
echo "a1b2c3d4e5f6g7h8j" | npx wrangler secret put GOOGLE_CSE_CX
```

### Usage in code

```typescript
// research.ts → searchGoogleCSE()
const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${env.GOOGLE_CSE_API_KEY}&cx=${env.GOOGLE_CSE_CX}&num=1`;
```

---

## Key 4: Semantic Scholar API Key

| Field | Value |
|-------|-------|
| Secret name | `SEMANTIC_SCHOLAR_API_KEY` |
| Key format | `VW2TUQWR5A` (10-char alphanumeric) |
| Free tier | 1 req/s (with key), 1,000 req/s shared (without key) |
| Card required | No |
| Signup URL | https://www.semanticscholar.org/product/api |

### What it does

Semantic Scholar provides access to 214M academic papers with 2.49B
citations. Used for academic research queries — "papers on X",
"research on neural networks", "study on Y".

### Free tier details

| Feature | With key | Without key |
|---------|----------|-------------|
| Rate limit | 1 req/s | 1,000 req/s (shared anonymous) |
| Quota | Unlimited (rate-limited) | Unlimited (rate-limited) |
| Card | No | N/A |

### How to get the key

1. Go to https://www.semanticscholar.org/product/api
2. Click "Request a Semantic Scholar API Key"
3. Fill in the form:
   - First/Last name
   - Email (academic/corporate preferred)
   - Affiliation: "Independent Developer"
   - Affiliation URL: your GitHub profile
   - Country: India
   - Application use: Private
   - How do you plan to use it: "NEXUS is a voice-first developer
     assistant that uses Semantic Scholar's paper search and citation
     graph endpoints to answer academic research queries. I plan to
     use the /graph/v1/paper/search endpoint for keyword-based paper
     discovery and /graph/v1/paper/{id}/references for citation
     traversal. Expected usage is approximately 20-50 requests per
     day from a small user base of 5-10 developers. I will implement
     client-side caching with 24-hour TTL and exponential backoff on
     rate limit responses to minimize API load."
   - Endpoints: `/graph/v1/paper/search`, `/graph/v1/paper/{paper_id}/references`
   - Requests per day: `50`
   - Check all acknowledgment boxes
4. Wait for approval (may take days)

### Set as Cloudflare secret

```bash
cd server/worker
echo "VW2TUQWR5A" | npx wrangler secret put SEMANTIC_SCHOLAR_API_KEY
```

### Usage in code

```typescript
// research.ts → searchSemanticScholar()
const headers: Record<string, string> = { "Accept": "application/json" };
if (env.SEMANTIC_SCHOLAR_API_KEY) {
  headers["x-api-key"] = env.SEMANTIC_SCHOLAR_API_KEY;
}
const resp = await fetch(url, { headers });
```

---

## Key 5: Google Gemini API Key

| Field | Value |
|-------|-------|
| Secret name | `GEMINI_API_KEY` |
| Key format | `AIzaSy...` or `AQ.Ab8...` |
| Free tier | 1,500 req/day (Flash Lite), 1M TPM |
| Card required | No |
| Signup URL | https://aistudio.google.com/apikey |
| Docs URL | https://ai.google.dev/gemini-api/docs |

### What it does

Google Gemini API provides access to Google's Gemini family of LLMs.
Used as the **primary LLM** in the NEXUS cascade for answer synthesis.

### Free tier details (per model)

| Model | RPM | RPD | TPM | Context |
|-------|-----|-----|-----|---------|
| Gemini 2.5 Flash | 15 | 1,500 | 1,000,000 | 1M tokens |
| Gemini 2.5 Flash-Lite | 30 | 1,500 | 1,000,000 | 1M tokens |
| Gemini 2.5 Pro | 5 | 50 | 1,000,000 | 1M tokens |
| gemini-flash-lite-latest | 30 | 1,500 | 1,000,000 | 1M tokens |

**Selected model:** `gemini-flash-lite-latest` — highest RPM (30),
non-reasoning (no CoT leakage), 1,500 RPD.

### Important: model deprecations

- `gemini-2.5-flash` → **404** "no longer available to new users"
- `gemini-flash-latest` → **503** "high demand" (unreliable)
- `gemini-3.6-flash` → Works but is a **reasoning model** (wastes
  tokens on thinking)
- `gemini-flash-lite-latest` → ✅ Works, non-reasoning, reliable

### How to get the key

1. Go to https://aistudio.google.com/apikey
2. Click "Create API key"
3. Select any Google Cloud project (or create one)
4. Copy the key immediately (it won't be shown again)

### Set as Cloudflare secret

```bash
cd server/worker
echo "AQ.Ab8RN6Ljf-..." | npx wrangler secret put GEMINI_API_KEY
```

### Usage in code

```typescript
// external_llm.ts → callGemini()
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${env.GEMINI_API_KEY}`;
```

### Privacy note

Google's free tier terms allow using prompts for model training. If
this is a concern, use the paid tier (which doesn't use prompts for
training). For NEXUS's use case (public research queries), this is
acceptable.

---

## Key 6: Groq API Key

| Field | Value |
|-------|-------|
| Secret name | `GROQ_API_KEY` |
| Key format | `gsk_xxxxxxxxxx` |
| Free tier | 14,400 req/day (8B-class), 30 RPM, 6K TPM |
| Card required | No |
| Signup URL | https://console.groq.com/keys |
| Docs URL | https://console.groq.com/docs |

### What it does

Groq provides ultra-fast LLM inference using LPU (Language Processing
Unit) hardware. Used as the **fallback LLM** in the NEXUS cascade.

### Free tier details

| Model | RPM | RPD | TPM | Speed |
|-------|-----|-----|-----|-------|
| qwen/qwen3.8-27b | 30 | 14,400 | 6,000 | ~1,500-2,000 TPS |
| openai/gpt-oss-120b | 30 | 14,400 | 6,000 | ~450-500 TPS |
| openai/gpt-oss-20b | 30 | 14,400 | 6,000 | ~2,100 TPS |

**Selected model:** `qwen/qwen3.8-27b` — direct output (no reasoning
leakage), 27B parameters, fast.

### Important: model name changes

Groq's model catalog changes frequently. The old
`llama-3.3-70b-versatile` was removed. Always check the current list:

```bash
curl -s "https://api.groq.com/openai/v1/models" \
  -H "Authorization: Bearer gsk_xxx" \
  | python -c "import sys,json; data=json.load(sys.stdin); [print(m['id']) for m in data.get('data',[])]"
```

### How to get the key

1. Go to https://console.groq.com/keys
2. Sign up with Google or email
3. Click "Create API Key"
4. Copy the key (starts with `gsk_`)

### Set as Cloudflare secret

```bash
cd server/worker
echo "gsk_Lc4J6beG..." | npx wrangler secret put GROQ_API_KEY
```

### Usage in code

```typescript
// external_llm.ts → callGroq()
const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${env.GROQ_API_KEY}`,
  },
  body: JSON.stringify({
    model: "qwen/qwen3.8-27b",
    messages,
    max_tokens: 500,
    temperature: 0.3,
  }),
});
```

---

## Key 7: Wolfram Alpha App ID (PENDING)

| Field | Value |
|-------|-------|
| Secret name | `WOLFRAM_API_KEY` |
| Key format | `XXXXXX-XXXXXXXXXX` |
| Free tier | 2,000 calls/month |
| Card required | No |
| Signup URL | https://products.wolframalpha.com/api |
| Docs URL | https://products.wolframalpha.com/api/documentation |

### What it does

Wolfram Alpha provides computational answers for math, science, unit
conversions, physics, chemistry. Returns exact computed results — no
LLM needed for these queries.

### Status

User submitted the form (selecting "Full Results API", naming the app
"nexus") but hasn't received the App ID yet. Wolfram's approval
process may take time.

### How to get the key

1. Go to https://products.wolframalpha.com/api
2. Click "Get a New App ID"
3. Fill in:
   - Name: `nexus`
   - Description: `Voice assistant research and computation API for factual queries`
   - API: Select **Full Results API**
4. Submit
5. Wait for App ID (displayed on the page or emailed)

### Set as Cloudflare secret (when received)

```bash
cd server/worker
echo "XXXXXX-XXXXXXXXXX" | npx wrangler secret put WOLFRAM_API_KEY
```

---

## Key 8: Serper.dev API Key (NOT SET)

| Field | Value |
|-------|-------|
| Secret name | `SERPER_API_KEY` |
| Key format | `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| Free tier | 2,500 queries (one-time, not monthly) |
| Card required | No |
| Signup URL | https://serper.dev |
| Docs URL | https://serper.dev/playground |

### What it does

Serper.dev provides Google search results as JSON. Emergency fallback
when all other search sources fail.

### Status

Code is ready in `research.ts` → `searchSerper()`. User hasn't signed
up yet. This is the lowest priority source — only used as Tier 5
emergency fallback.

### How to get the key

1. Go to https://serper.dev
2. Sign up with email
3. Key is displayed in the dashboard

### Set as Cloudflare secret

```bash
cd server/worker
echo "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" | npx wrangler secret put SERPER_API_KEY
```

---

## Env type declaration

All secrets are declared in `server/worker/src/quota.ts`:

```typescript
export interface Env {
  AI: Ai;
  DB: D1Database;
  CACHE?: KVNamespace;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  NEXUS_ENCRYPTION_KEY: string;
  // Research API keys (Cloudflare secrets)
  TAVILY_API_KEY?: string;
  SEARCHX_API_KEY?: string;
  WOLFRAM_API_KEY?: string;
  SEMANTIC_SCHOLAR_API_KEY?: string;
  SERPER_API_KEY?: string;
  GOOGLE_CSE_API_KEY?: string;
  GOOGLE_CSE_CX?: string;
  // External LLM API keys (Cloudflare secrets)
  GEMINI_API_KEY?: string;
  GROQ_API_KEY?: string;
}
```

All research/LLM keys are `optional` (`?`) — the Worker gracefully
handles missing keys by skipping that source/provider and falling
back to the next one in the cascade.

---

## wrangler.toml configuration

```toml
name = "nexus-worker"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[ai]
binding = "AI"

[[d1_databases]]
binding = "DB"
database_name = "nexus-db"
database_id = "4bca5d1b-55e1-4a30-bbf9-ca28cf96e3ea"

[[kv_namespaces]]
binding = "CACHE"
id = "2af54bd3039040969e2ffac4c745e443"

[observability]
enabled = true
```

**Note:** Secrets are NOT in `wrangler.toml`. They are set via
`wrangler secret put` and stored in Cloudflare's encrypted secret
manager. The `wrangler.toml` only contains non-secret bindings (AI,
D1, KV).

---

## File references

- **Env type (secret declarations):** `server/worker/src/quota.ts` → `interface Env`
- **wrangler.toml:** `server/worker/wrangler.toml`
- **Secret usage in research:** `server/worker/src/research.ts`
- **Secret usage in LLM cascade:** `server/worker/src/external_llm.ts`
