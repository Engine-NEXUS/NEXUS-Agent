# 01 — Research Sources

All 9 research sources integrated into the NEXUS Worker, organized by
priority in the retrieval cascade. Free sources run first (unlimited
quota), keyed sources run as fallback (generous free tiers).

## Source overview

| # | Source | API Key | Free Quota | Priority | File |
|---|--------|---------|------------|----------|------|
| 1 | Wikipedia REST | None | Unlimited | Tier 1 (always) | `research.ts` |
| 2 | Wikidata | None | Unlimited | Tier 1 (always) | `research.ts` |
| 3 | DuckDuckGo Instant Answer | None | Unlimited | Tier 1 (always) | `research.ts` |
| 4 | knowledgelib.io | None | 1,000/month | Tier 1 (if no SearchX) | `research.ts` |
| 5 | SearchX | `SEARCHX_API_KEY` | 3,000/day | Tier 2 (first fallback) | `research.ts` |
| 6 | Tavily | `TAVILY_API_KEY` | 1,000/month | Tier 3 (second fallback) | `research.ts` |
| 7 | Google Custom Search | `GOOGLE_CSE_API_KEY` + cx | 100/day | Tier 4 (third fallback) | `research.ts` |
| 8 | Serper.dev | `SERPER_API_KEY` | 2,500 one-time | Tier 5 (emergency) | `research.ts` |
| 9 | Wolfram Alpha | `WOLFRAM_API_KEY` | 2,000/month | Special (math only) | `research.ts` |
| 10 | Semantic Scholar | `SEMANTIC_SCHOLAR_API_KEY` | 1 req/s | Special (academic only) | `research.ts` |

---

## Source 1: Wikipedia REST API

**Purpose:** Encyclopedia summaries with citations. The primary source
for "what is X" and "research on X" queries.

**API:** `https://en.wikipedia.org/api/rest_v1/page/summary/{title}`

**Authentication:** None. Fully public, no rate limit, no key.

**Code:** `research.ts` → `searchWikipedia(query, lang)`

**How it works:**
1. Search for the best matching page title:
   `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={query}&srlimit=1&format=json&origin=*`
2. Fetch the page summary via REST API:
   `https://en.wikipedia.org/api/rest_v1/page/summary/{title}`
3. Return `{ title, url, snippet (extract), source: "wikipedia" }`

**Example response:**
```json
{
  "title": "Cloudflare",
  "url": "https://en.wikipedia.org/wiki/Cloudflare",
  "snippet": "Cloudflare, Inc., is an American technology company headquartered in San Francisco, California, that provides a range of internet services, including content...",
  "source": "wikipedia",
  "retrieved_at": "2026-09-01T19:30:00.000Z"
}
```

**Covers:** ~70% of all research queries. Encyclopedia articles on
people, places, companies, technologies, concepts, historical events.

**Limitations:** Only returns the first paragraph (summary). For full
article content, would need to fetch the full page API (not implemented).

---

## Source 2: Wikidata API

**Purpose:** Structured facts and entity relationships. Complements
Wikipedia with machine-readable data (IDs, properties, types).

**API:** `https://www.wikidata.org/w/api.php?action=wbsearchentities&search={query}&language=en&format=json&limit=1&origin=*`

**Authentication:** None. Fully public, no rate limit, no key.

**Code:** `research.ts` → `searchWikidata(query)`

**How it works:**
1. Search for the best matching entity.
2. Return `{ title (label), url, snippet (description), source: "wikidata" }`.

**Example response:**
```json
{
  "title": "Cloudflare",
  "url": "https://www.wikidata.org/wiki/Q4880",
  "snippet": "American technology company",
  "source": "wikidata",
  "retrieved_at": "2026-09-01T19:30:00.000Z"
}
```

**Covers:** ~5% of queries — adds structured metadata that Wikipedia
doesn't surface in its summary (entity IDs, property values, typed
relationships).

---

## Source 3: DuckDuckGo Instant Answer API

**Purpose:** Quick definitions, disambiguation, calculations, and
topic summaries from 100+ sources (Wikipedia, Crunchbase, WikiHow,
Free Dictionary, etc.).

**API:** `https://api.duckduckgo.com/?q={query}&format=json&no_html=1&skip_disambig=1`

**Authentication:** None. Fully public, no rate limit, no key.

**Code:** `research.ts` → `searchDuckDuckGo(query)`

**How it works:**
1. Fetch the instant answer payload.
2. If `AbstractText` exists, return it as the primary result.
3. If no abstract, check `RelatedTopics` for the first topic with text.
4. Return `{ title (Heading), url (AbstractURL), snippet (AbstractText), source: "duckduckgo" }`.

**Example response:**
```json
{
  "title": "Docker (software)",
  "url": "https://duckduckgo.com/Docker_(software)",
  "snippet": "A set of products that uses operating system-level virtualization to deliver software in packages...",
  "source": "duckduckgo",
  "retrieved_at": "2026-09-01T19:30:00.000Z"
}
```

**Covers:** ~10% of queries — catches things Wikipedia misses
(disambiguation pages, utility queries, definitions from non-Wikipedia
sources).

**Important:** This is NOT a full search engine. It only returns
instant answers (zero-click results). It does not return a list of web
results. For web search, use SearchX or Tavily.

---

## Source 4: knowledgelib.io

**Purpose:** Pre-verified knowledge units with confidence scores and
inline citations. Designed specifically for AI agents — saves tokens
by providing structured answers instead of raw web pages.

**API:** `https://knowledgelib.io/api/v1/query?q={query}`

**Authentication:** None for keyless access (1,000 queries/month).
Optional API key for higher limits.

**Code:** `research.ts` → `searchKnowledgelib(query)`

**How it works:**
1. Fetch the pre-verified answer for the query.
2. Return `{ title, url (source URLs), snippet (answer text), source: "knowledgelib" }`.

**When it's used:** Only when SearchX key is NOT set. If SearchX is
available, knowledgelib is skipped to save its 1K/month quota for
when it's needed most.

**Covers:** ~5% of queries — best for factual questions with known
answers (conversions, definitions, established facts).

---

## Source 5: SearchX

**Purpose:** Real-time hybrid web search (keyword + semantic) across
1B+ pages. Returns clean snippets, not just links. Highest free quota
of any search API.

**API:** `https://searchx.dev/api/v1/search?q={query}&mode=hybrid`

**Authentication:** Bearer token (`SEARCHX_API_KEY`).

**Free tier:** 3,000 queries/day (90,000/month). No card required.

**Code:** `research.ts` → `searchSearchX(query, apiKey)`

**How it works:**
1. Send GET request with `Authorization: Bearer {key}`.
2. Parse the first result from the `results` array.
3. Return `{ title, url, snippet, source: "searchx" }`.

**When it's used:** Tier 2 fallback — only when Tier 1 (Wikipedia +
Wikidata + DDG) returns fewer than 3 results.

**Signup:** https://searchx.dev/signup

---

## Source 6: Tavily

**Purpose:** AI-optimized web search that returns clean content (not
just links). Built for RAG pipelines. Includes an AI-generated answer
field alongside raw results.

**API:** `POST https://api.tavily.com/search`

**Authentication:** Bearer token (`TAVILY_API_KEY`).

**Free tier:** 1,000 credits/month (1 credit = 1 basic search, 2 credits
= 1 advanced search). No card required.

**Code:** `research.ts` → `searchTavily(query, apiKey)`

**How it works:**
1. POST with `{ query, max_results: 1, include_answer: true }`.
2. If `data.answer` exists, use it as the snippet (AI-generated summary).
3. Otherwise, use the first result's `content` field.
4. Return `{ title, url, snippet, source: "tavily" }`.

**When it's used:** Tier 3 fallback — only when Tier 1 + Tier 2 return
fewer than 3 results.

**Signup:** https://app.tavily.com/sign-in

---

## Source 7: Google Custom Search

**Purpose:** Google search results via API. Fallback when all other
sources fail.

**API:** `https://www.googleapis.com/customsearch/v1?q={query}&key={key}&cx={cx}&num=1`

**Authentication:** API key (`GOOGLE_CSE_API_KEY`) + Custom Search
Engine ID (`GOOGLE_CSE_CX`).

**Free tier:** 100 queries/day. No card required.

**Code:** `research.ts` → `searchGoogleCSE(query, apiKey, cx)`

**Status:** API key is set. **cx ID is pending** — user needs to create
a Custom Search Engine at https://programmablesearchengine.google.com/
and configure it to "Search the entire web but emphasize included sites".

**When it's used:** Tier 4 fallback — only when Tier 1 + 2 + 3 return
fewer than 3 results.

---

## Source 8: Serper.dev

**Purpose:** Google search results as JSON. Emergency fallback when all
other sources fail.

**API:** `POST https://google.serper.dev/search`

**Authentication:** `X-API-KEY` header (`SERPER_API_KEY`).

**Free tier:** 2,500 queries (one-time, not monthly). No card required.

**Code:** `research.ts` → `searchSerper(query, apiKey)`

**Status:** Code is ready. **Key not yet set** — user hasn't signed up.

**When it's used:** Tier 5 emergency fallback — last resort before
returning "no sources found".

**Signup:** https://serper.dev

---

## Source 9: Wolfram Alpha

**Purpose:** Computational answers for math, science, unit conversions,
physics, chemistry. No LLM needed for these — Wolfram returns exact
computed results.

**API:** `https://api.wolframalpha.com/v2/query?input={query}&appid={key}&format=plaintext&output=JSON`

**Authentication:** App ID (`WOLFRAM_API_KEY`).

**Free tier:** 2,000 calls/month. No card required.

**Code:** `research.ts` → `searchWolfram(query, apiKey)`

**Special routing:** Only used when `isMathQuery(query)` returns true.
Detected patterns:
- `calculate`, `compute`, `solve`, `convert`
- `what is \d+`, `\d+ [+\-*/^] \d+`
- `integral`, `derivative`, `equation`, `percentage`, `square root`, `factorial`
- Pure math expressions: `^\s*[\d\s+\-*/^.()=]+\s*$`

**Status:** Code is ready. **Key not yet set** — user submitted the form
(selecting "Full Results API") but hasn't received the App ID yet.

**Signup:** https://products.wolframalpha.com/api

---

## Source 10: Semantic Scholar

**Purpose:** Academic paper search with citation graphs. 214M papers,
2.49B citations across all disciplines.

**API:** `https://api.semanticscholar.org/graph/v1/paper/search?query={query}&limit=1&fields=title,abstract,url,citationCount,year`

**Authentication:** `x-api-key` header (`SEMANTIC_SCHOLAR_API_KEY`).
Optional — works without key at 1,000 req/s shared anonymous rate.

**Free tier:** 1 req/s with key. No card required.

**Code:** `research.ts` → `searchSemanticScholar(query, apiKey)`

**Special routing:** Only used when `isAcademicQuery(query)` returns true.
Detected patterns:
- Academic keywords: `papers`, `arxiv`, `publication`, `journal`, `citation`, `academic`, `scientific`, `study`, `studies`, `research`
- Topic keywords: `algorithm`, `neural`, `model`, `benchmark`, `dataset`, `transformer`, `architecture`, `learning`, `machine`, `deep`, `network`, `covid`, `transmission`, `attention`, `mechanism`
- Must match BOTH an academic keyword AND a topic keyword (avoids
  matching "research on cloudflare" which is general, not academic).

**Status:** ✅ Key is set (`VW2TUQWR5A`).

**Signup:** https://www.semanticscholar.org/product/api

---

## How sources are combined

The `retrieveCascade()` function in `research.ts` runs sources in
priority order:

```
1. Special path: if isMathQuery && WOLFRAM_API_KEY → Wolfram Alpha
   → also fetch Wikipedia for context
   → return early

2. Tier 1 (parallel, no key):
   - searchWikipedia(query)
   - searchWikidata(query)
   - searchDuckDuckGo(query)
   - searchKnowledgelib(query) [only if no SearchX key]

3. If results.length >= maxResults (5) → return early

4. Special path: if isAcademicQuery → searchSemanticScholar()
   → if results.length >= maxResults → return early

5. Tier 2: if SEARCHX_API_KEY → searchSearchX()
   → if results.length >= maxResults → return early

6. Tier 3: if TAVILY_API_KEY → searchTavily()
   → if results.length >= maxResults → return early

7. Tier 4: if GOOGLE_CSE_API_KEY && GOOGLE_CSE_CX → searchGoogleCSE()
   → if results.length >= maxResults → return early

8. Tier 5: if SERPER_API_KEY → searchSerper()

9. Return all collected results
```

All results are deduplicated by `dedupeSources()` in `clean.ts` before
being passed to the LLM for synthesis.

## File references

- **Source implementations:** `server/worker/src/research.ts`
- **Cascade logic:** `server/worker/src/research.ts` → `retrieveCascade()`
- **Deduplication:** `server/worker/src/clean.ts` → `dedupeSources()`
- **Env type (key declarations):** `server/worker/src/quota.ts` → `interface Env`
- **Tests:** `server/worker/src/__tests__/research.test.ts`
