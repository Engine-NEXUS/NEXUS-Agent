# NEXUS Research System — Documentation Index

This folder documents the complete multi-source ad-free research system
built into the NEXUS Worker. The system retrieves factual information
from 9+ independent sources, then synthesizes answers using a 3-tier LLM
cascade — all on free tiers, designed for 5–10 users at $5/month total
cost.

## Files in this folder

| # | File | What it covers |
|---|------|----------------|
| 01 | [01-research-sources.md](01-research-sources.md) | All 9 research sources, their APIs, free tiers, limits, and code |
| 02 | [02-llm-cascade.md](02-llm-cascade.md) | Gemini → Groq → Cloudflare LLM cascade with model names and fallback logic |
| 03 | [03-api-keys-and-secrets.md](03-api-keys-and-secrets.md) | Every API key, where to get it, free tier details, Cloudflare secret setup |
| 04 | [04-cascade-architecture.md](04-cascade-architecture.md) | The full retrieval + synthesis flow, code paths, and decision logic |
| 05 | [05-capacity-analysis-10-users.md](05-capacity-analysis-10-users.md) | Whether each free tier survives 10 active users, with real math |
| 06 | [06-latency-benchmarks.md](06-latency-benchmarks.md) | Measured end-to-end latency for every command type, from live tests |
| 07 | [07-deployment-guide.md](07-deployment-guide.md) | Step-by-step deploy: secrets, D1 schema, KV namespace, wrangler config |
| 08 | [08-testing-results.md](08-testing-results.md) | Live test results with actual queries, response times, and provider routing |
| 09 | [09-intent-routing-fixes.md](09-intent-routing-fixes.md) | Bug fixes: "research" keyword, isSearchQuestion, isMathQuery, isAcademicQuery |
| 10 | [10-future-improvements.md](10-future-improvements.md) | Pending keys, potential upgrades, and scaling beyond 10 users |

## Quick summary

**What changed:**

1. **9 research sources** added to `server/worker/src/research.ts` —
   Wikipedia, Wikidata, DuckDuckGo, knowledgelib.io, SearchX, Tavily,
   Google Custom Search, Serper.dev, Wolfram Alpha, Semantic Scholar.

2. **3-tier LLM cascade** in `server/worker/src/external_llm.ts` —
   Gemini Flash Lite (1,500/day) → Groq Qwen 3.8 27B (14,400/day) →
   Cloudflare llama-3.2-3b (~200/day).

3. **Intent routing fixes** in `server/worker/src/index.ts` —
   "research", "look up", "explain", "define" now route to search
   without needing an LLM intent classifier call.

4. **6 Cloudflare secrets** set via `wrangler secret put`.

5. **D1 schema + KV namespace** created and deployed.

6. **28 tests** passing (4 new test suites for math/academic detection).

7. **Worker deployed** to `https://nexus-worker.chitkullakshya.workers.dev`.

**Total cost: $5/month** (Cloudflare Workers Paid — all other APIs are free tier).

**10-user capacity: 153x headroom** on LLM, 200x on search.
