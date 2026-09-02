# 05 — Capacity Analysis for 10 Users

Honest math on whether each free tier survives 10 active users, with
realistic usage assumptions and worst-case scenarios.

## Usage assumptions

### Realistic daily usage

| Metric | Value | Reasoning |
|--------|-------|-----------|
| Total users | 10 | Target user base |
| Active users per day | 7 | Not everyone uses NEXUS daily |
| Searches per user per day | 5–15 | Voice assistant — quick questions, research lookups |
| Peak concurrent users | 3–4 | Not everyone speaks at the same time |
| **Total searches per day** | **35–105** | 7 users × 5–15 searches |
| **Total searches per month** | **1,050–3,150** | 30 days |

### Query type distribution

Based on typical voice assistant usage:

| Query type | % of total | Daily count | Notes |
|------------|-----------|-------------|-------|
| Search/research | 60% | 21–63 | "what is X", "research on Y" |
| General chat | 20% | 7–21 | "tell me a joke", "remind me" |
| GitHub analysis | 10% | 3.5–10.5 | "analyse PR", "review this repo" |
| Offline commands | 8% | 2.8–8.4 | "close chrome", "open whatsapp" |
| Gmail/Calendar | 2% | 0.7–2.1 | "check my email" |

**Search queries (the ones that hit research sources):** 21–63/day
**LLM synthesis calls:** 28–84/day (search + general chat)

---

## Source-by-source analysis

### Tier 1: Free sources (no key) — NO PROBLEM

| Source | Free limit | 10-user daily use | Headroom | Verdict |
|--------|-----------|-------------------|----------|---------|
| Wikipedia REST | Unlimited | ~21–63 | ∞ | ✅ Fine |
| Wikidata | Unlimited | ~21–63 | ∞ | ✅ Fine |
| DuckDuckGo Instant Answer | Unlimited | ~21–63 | ∞ | ✅ Fine |
| knowledgelib.io | 1,000/month | ~10–30 (only if no SearchX) | 33x | ✅ Fine |

**These cover ~80% of all search queries with zero limit risk.**

### Tier 2: SearchX — NO PROBLEM

| Metric | Value |
|--------|-------|
| Free limit | 3,000 queries/day (90,000/month) |
| 10-user daily use | ~5–15 (only when Tier 1 returns <3 results) |
| Headroom | **200x** |
| Verdict | ✅ Fine |

SearchX is only called when Wikipedia + Wikidata + DDG don't return
enough results. In practice, this is ~15-25% of search queries, so
~3–16 calls/day. Well under 3,000.

### Tier 3: Tavily — NO PROBLEM

| Metric | Value |
|--------|-------|
| Free limit | 1,000 credits/month |
| 10-user monthly use | ~50–100 (only when Tier 1 + 2 return <3 results) |
| Headroom | **10–20x** |
| Verdict | ✅ Fine |

Tavily is only called when Wikipedia + DDG + SearchX don't return
enough results. In practice, this is ~5-10% of search queries, so
~1–6 calls/day = ~30–180/month. Under 1,000.

### Tier 4: Google Custom Search — TIGHT BUT OK

| Metric | Value |
|--------|-------|
| Free limit | 100 queries/day |
| 10-user daily use | ~1–3 (only when Tier 1+2+3 fail) |
| Headroom | **33x** |
| Verdict | ✅ Fine (but tight on busy days) |

Google CSE is the 4th fallback — only called when all other sources
return nothing. In practice, ~1-3 calls/day. But on a busy day with
10 active users all asking obscure questions, could hit 5-10 calls.
Still under 100.

**Note:** cx ID is still pending. Once set, this becomes available.

### Tier 5: Serper.dev — ONE-TIME CREDIT

| Metric | Value |
|--------|-------|
| Free limit | 2,500 queries (one-time, NOT monthly) |
| 10-user use | ~1–2/day (emergency only) |
| Time to exhaust | ~1,250–2,500 days (3.4–6.8 years) |
| Verdict | ✅ Fine (effectively unlimited for emergency use) |

Serper is the last resort — only called when ALL other sources fail.
In practice, almost never used. 2,500 one-time credits will last years.

### Special: Wolfram Alpha — NO PROBLEM (math only)

| Metric | Value |
|--------|-------|
| Free limit | 2,000 calls/month |
| 10-user monthly use | ~20–50 (math queries only) |
| Headroom | **40x** |
| Verdict | ✅ Fine |

Wolfram is only called for math/science queries (`isMathQuery()`
returns true). Most searches are not math. ~1-2 calls/day = ~30-60/month.

### Special: Semantic Scholar — NO PROBLEM (academic only)

| Metric | Value |
|--------|-------|
| Free limit | 1 req/s (rate-limited, not quota-limited) |
| 10-user daily use | ~2–5 (academic queries only) |
| Headroom | ✅ (rate limit, not quota) |
| Verdict | ✅ Fine |

Semantic Scholar is only called for academic queries
(`isAcademicQuery()` returns true). Most searches are not academic.
~2-5 calls/day, well under the 1 req/s rate limit.

---

## LLM capacity analysis

### Gemini Flash Lite (Tier 1)

| Metric | Value |
|--------|-------|
| Free limit | 1,500 req/day |
| 10-user daily use | ~28–84 (search synthesis + general chat) |
| Headroom | **18–54x** |
| Verdict | ✅ Fine |

Gemini handles the majority of LLM calls. At 84 calls/day max, that's
only 5.6% of the 1,500 daily limit. Even in the worst case (all 10
users active, all asking research questions), we'd need ~105 calls/day
— still only 7% of the limit.

### Groq Qwen 3.8 27B (Tier 2)

| Metric | Value |
|--------|-------|
| Free limit | 14,400 req/day |
| 10-user daily use | ~5–20 (only when Gemini fails) |
| Headroom | **720–2880x** |
| Verdict | ✅ Fine |

Groq is only called when Gemini fails (network error, rate limit,
high demand). In practice, Gemini handles ~95% of calls, so Groq
gets ~1-5 calls/day. 14,400 is massive overkill.

### Cloudflare Workers AI (Tier 3)

| Metric | Value |
|--------|-------|
| Free limit | 10,000 neurons/day ≈ ~200 synthesis calls |
| 10-user daily use | ~1–5 (only when Gemini AND Groq fail) |
| Headroom | **40–200x** |
| Verdict | ✅ Fine |

Cloudflare is the last resort. Only called when both Gemini and Groq
are down. In practice, almost never used for search. The 10K
neurons/day is also shared with GitHub analysis, intent classification,
and other Worker AI calls.

### Total LLM capacity

| Provider | Free quota | Daily capacity |
|----------|-----------|----------------|
| Gemini Flash Lite | 1,500 req/day | 1,500 |
| Groq Qwen 3.8 | 14,400 req/day | 14,400 |
| Cloudflare Workers AI | ~200 calls/day | 200 |
| **Total** | | **16,100 req/day** |
| **10-user need** | | **~105 req/day** |
| **Headroom** | | **153x** |

---

## Worst-case scenario

**Scenario:** All 10 users active on the same day, each asking 15
research questions.

| Resource | Needed | Available | Status |
|----------|--------|-----------|--------|
| Wikipedia + DDG | 150 calls | Unlimited | ✅ |
| SearchX | ~30 calls (20% overflow) | 3,000/day | ✅ |
| Tavily | ~8 calls (5% overflow) | 1,000/month | ✅ |
| Gemini | 150 calls | 1,500/day | ✅ |
| Groq | ~8 calls (5% Gemini fail) | 14,400/day | ✅ |
| Cloudflare | ~1 call (0.5% both fail) | ~200/day | ✅ |
| KV cache | 150 entries | Unlimited | ✅ |

**Even in the worst case, nothing breaks.**

---

## Monthly cost

| Item | Cost |
|------|------|
| Cloudflare Workers Paid | $5/month |
| Gemini API | $0 (free tier) |
| Groq API | $0 (free tier) |
| Tavily | $0 (free tier) |
| SearchX | $0 (free tier) |
| Semantic Scholar | $0 (free tier) |
| Wolfram Alpha | $0 (free tier, when key set) |
| Wikipedia/Wikidata/DDG | $0 (no key) |
| **Total** | **$5/month** |

---

## What would break at 100 users?

| Resource | 100-user need | Available | Breaks? |
|----------|---------------|-----------|---------|
| Gemini | ~1,050/day | 1,500/day | ⚠️ Tight (70%) |
| Groq | ~50/day | 14,400/day | ✅ |
| SearchX | ~300/day | 3,000/day | ✅ |
| Tavily | ~500/month | 1,000/month | ⚠️ Tight (50%) |
| Google CSE | ~30/day | 100/day | ⚠️ Tight (30%) |
| Cloudflare neurons | ~1,000/day | 10,000/day | ✅ |

At 100 users, Gemini and Tavily would need to be upgraded to paid
tiers. Estimated cost: ~$20-30/month for Gemini Pro + Tavily Project.

---

## File references

- **Quota enforcement:** `server/worker/src/quota.ts` → `checkQuota()`
- **Per-user limits:** `server/worker/src/quota.ts` → `LIMITS`
- **Cache TTL:** `server/worker/src/index.ts` → `handleSearch()` (86400s = 24h)
- **Usage tracking:** `server/worker/src/quota.ts` → `incrementUsage()`
