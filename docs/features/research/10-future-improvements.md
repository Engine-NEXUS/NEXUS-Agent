# 10 — Future Improvements

Pending items, potential upgrades, and scaling considerations for the
NEXUS research system beyond 10 users.

## Pending keys (not yet set)

### Wolfram Alpha App ID

| Field | Value |
|-------|-------|
| Status | User submitted the form, waiting for App ID |
| Impact | Math/science queries won't use Wolfram — will fall back to LLM with Wikipedia sources |
| Priority | Medium — math queries are rare (~2% of total) |
| When key arrives | `echo "XXXXXX-XXXXXXXXXX" \| npx wrangler secret put WOLFRAM_API_KEY` then redeploy |

**What happens without it:** If a user says "calculate 15 * 23", the
`isMathQuery()` check returns true, but `env.WOLFRAM_API_KEY` is
undefined, so the Wolfram path is skipped. The query falls through to
the normal search cascade (Wikipedia + DDG + etc.) and the LLM
synthesizes the answer. This works but is less precise than Wolfram's
exact computation.

### Google Custom Search Engine (cx) ID

| Field | Value |
|-------|-------|
| Status | API key is set, but cx ID is not |
| Impact | Google CSE fallback is unavailable — SearchX + Tavily cover this gap |
| Priority | Low — SearchX (3K/day) and Tavily (1K/month) are more than sufficient |
| How to get | https://programmablesearchengine.google.com/ → Create → set to "Search entire web" → copy cx |

**What happens without it:** The `searchGoogleCSE()` function checks
`env.GOOGLE_CSE_API_KEY && env.GOOGLE_CSE_CX`. Since cx is undefined,
Google CSE is skipped. SearchX and Tavily handle the overflow.

### Serper.dev API key

| Field | Value |
|-------|-------|
| Status | Not signed up |
| Impact | Tier 5 emergency fallback is unavailable |
| Priority | Very low — Tier 1-4 cover 99%+ of queries |
| How to get | https://serper.dev → sign up → copy key |

**What happens without it:** The `searchSerper()` function checks
`env.SERPER_API_KEY`. Since it's undefined, Serper is skipped. If all
other sources fail, the system returns "no sources found" and the LLM
answers with honest uncertainty.

---

## Potential upgrades

### 1. Cache versioning

**Problem:** When the LLM model or prompt is changed, old cached
responses in KV still contain the old output. Users see stale answers
for up to 24 hours.

**Solution:** Add a cache version prefix to the cache key:

```typescript
const CACHE_VERSION = "v2";
const cacheK = `${CACHE_VERSION}:search:en:${contentHash(query)}`;
```

Bump `CACHE_VERSION` on every model/prompt change. Old caches become
invisible (they'll expire naturally after 24h).

**Effort:** 2 lines of code change in `index.ts`.

### 2. Streaming responses

**Problem:** The user waits 5-8 seconds for the full response before
hearing anything (besides "On it, sir").

**Solution:** Stream the LLM response token-by-token. Gemini and Groq
both support streaming:

- Gemini: `streamGenerateContent` endpoint
- Groq: `stream: true` in the request body

The Worker could emit partial responses via WebSocket, and the
frontend could start TTS as soon as the first sentence is complete.

**Effort:** Medium — requires changes to Worker response format,
Rust network bridge, and frontend TTS player.

**Impact:** Reduces perceived latency from ~7s to ~2s (first sentence).

### 3. Parallel LLM racing

**Problem:** The cascade tries Gemini first, then Groq, then
Cloudflare — serially. If Gemini takes 5s and fails, that's 5s wasted
before Groq is tried.

**Solution:** Race all 3 providers in parallel, use whichever returns
first:

```typescript
const [gemini, groq, cf] = await Promise.all([
  callGemini(prompt, env, systemPrompt),
  callGroq(prompt, env, systemPrompt),
  callCloudflare(prompt, env, systemPrompt),
]);
return gemini || groq || cf;
```

**Trade-off:** Uses 3x the API quota (every call hits all 3 providers).
With 16,100 req/day total capacity and ~105 req/day needed, this is
affordable — 315 req/day is still 51x headroom.

**Effort:** 5 lines of code change in `external_llm.ts`.

**Impact:** Reduces worst-case latency from ~10s (Gemini fails after
5s, Groq takes 3s) to ~3s (fastest provider wins).

### 4. Source-specific caching

**Problem:** Currently, the entire synthesized response is cached. If
a source API goes down, the cached response is still served (good),
but if a source updates its content, the cached response is stale
(bad for news/time-sensitive queries).

**Solution:** Cache source results separately from the synthesized
response:

```
KV key: "source:wikipedia:cloudflare" → Wikipedia snippet (1h TTL)
KV key: "source:ddg:cloudflare" → DDG snippet (1h TTL)
KV key: "synthesis:cloudflare:v2" → Full LLM response (24h TTL)
```

**Effort:** Medium — requires refactoring `retrieveCascade()` to
check source-level cache before calling APIs.

**Impact:** Reduces API calls to sources by ~80% (most sources are
queried repeatedly for similar queries). Also allows refreshing
sources without re-running the LLM.

### 5. Query expansion

**Problem:** "research on cloudflare" and "what is cloudflare" should
return the same answer, but they generate different cache keys and
may hit different sources.

**Solution:** Normalize queries before retrieval:

```typescript
function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/^(research on|what is|who is|tell me about|explain|define)\s+/, "")
    .trim();
}
```

Then use the normalized query for cache keys and source retrieval,
but pass the original query to the LLM for context.

**Effort:** 10 lines of code.

**Impact:** Increases cache hit rate by ~30% (similar queries share
cache entries).

### 6. Image search for sidebar

**Problem:** The sidebar shows text + sources, but no images.

**Solution:** SearchX includes image search. Add an `images` field to
`SearchResult` and display them in the sidebar:

```typescript
const imgResp = await fetch(
  `https://searchx.dev/api/v1/images?q=${encodeURIComponent(query)}`,
  { headers: { Authorization: `Bearer ${env.SEARCHX_API_KEY}` } },
);
```

**Effort:** Medium — requires frontend changes to display images.

### 7. Voice-optimized prompts

**Problem:** The LLM output is written for reading, not speaking.
Sentences are too long, contain URLs, and use formatting that doesn't
translate well to TTS.

**Solution:** Add a TTS-specific system prompt:

```
You are NEXUS, a voice assistant. Your answer will be spoken aloud.
Write in short sentences (max 15 words). Do not include URLs in the
spoken text — say "according to Wikipedia" instead of "according to
en dot wikipedia dot org". Use natural conversational language.
```

**Effort:** 5 lines — change the system prompt in
`synthesizeWithCascade()`.

**Impact:** Better TTS quality, more natural speech.

---

## Scaling beyond 10 users

### At 50 users

| Resource | Need | Available | Status |
|----------|------|-----------|--------|
| Gemini | 525/day | 1,500/day | ✅ (35%) |
| Groq | 25/day | 14,400/day | ✅ |
| SearchX | 150/day | 3,000/day | ✅ |
| Tavily | 250/month | 1,000/month | ✅ (25%) |
| Cloudflare neurons | 525/day | 10,000/day | ✅ |

**Cost: $5/month** — still all free tier.

### At 100 users

| Resource | Need | Available | Status |
|----------|------|-----------|--------|
| Gemini | 1,050/day | 1,500/day | ⚠️ Tight (70%) |
| Groq | 50/day | 14,400/day | ✅ |
| SearchX | 300/day | 3,000/day | ✅ |
| Tavily | 500/month | 1,000/month | ⚠️ Tight (50%) |
| Cloudflare neurons | 1,050/day | 10,000/day | ✅ |

**Cost: $5/month** — still free tier, but Gemini and Tavily are tight.

**Recommendation:** Upgrade Gemini to paid tier ($20/month for 10K
RPM) and Tavily to Project plan ($30/month for 4K credits). Total:
$55/month.

### At 500 users

| Resource | Need | Available | Status |
|----------|------|-----------|--------|
| Gemini | 5,250/day | 1,500/day | ❌ Breaks |
| Groq | 250/day | 14,400/day | ✅ |
| SearchX | 1,500/day | 3,000/day | ⚠️ Tight |
| Tavily | 2,500/month | 1,000/month | ❌ Breaks |

**Cost: ~$100-150/month** — need paid Gemini, paid Tavily, and
possibly paid SearchX. Also need to increase Cloudflare Workers Paid
limits.

### At 1,000+ users

Would need enterprise agreements with Google, Groq, and search
providers. Estimated cost: $500-1,000/month. This is beyond the
current design's target of 5-10 users.

---

## Monitoring and alerting

### Current monitoring

- `wrangler tail` — real-time logs (provider used, errors, latency)
- Cloudflare dashboard — Worker analytics (requests, CPU time, errors)
- D1 usage_log table — per-user daily usage tracking

### Recommended additions

1. **Daily quota alert:** Cloudflare Worker cron trigger that checks
   D1 usage_log and sends a notification when any user approaches
   their daily limit.

2. **LLM provider health check:** Periodic `fetch()` to Gemini and
   Groq health endpoints. If a provider is down, proactively route
   to the next tier without waiting for a failure.

3. **Source availability tracking:** Log which sources returned
   results vs. returned null. If a source is consistently failing,
   temporarily skip it to save latency.

4. **Cache hit rate metric:** Log cache hits vs. misses. If hit rate
   drops below 50%, increase TTL. If above 90%, decrease TTL for
   fresher content.

---

## File references

- **Current cascade:** `server/worker/src/external_llm.ts`
- **Current retrieval:** `server/worker/src/research.ts`
- **Current caching:** `server/worker/src/cache.ts`
- **Current quota tracking:** `server/worker/src/quota.ts`
- **Worker config:** `server/worker/wrangler.toml`
