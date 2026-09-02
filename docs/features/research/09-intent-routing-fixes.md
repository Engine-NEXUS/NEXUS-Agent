# 09 — Intent Routing Fixes

Bug fixes to the intent classification system that caused "research on
X" queries to be misrouted, miss the search engine, or trigger
unnecessary LLM calls.

## Bug 1: "research" not matched by keyword fallback

### The problem

When a user says "research on cloudflare", the Worker's
`classifyIntent()` function first tries `keywordFallback()` — a
regex-based matcher that routes intents without needing an LLM call.

The original regex for search intent was:

```javascript
if (/\b(search|google|look up|find|what is|who is|where is)\b/.test(t)) return "search";
```

This tests for the word `search` with word boundaries (`\bsearch\b`).
But "research" contains "search" as a substring — there is no word
boundary between "re" and "search" in "research". So `\bsearch\b`
does NOT match "research".

**Result:** `keywordFallback("research on cloudflare")` returned
`"general"`, which triggered an LLM intent classifier call
(`llama-3.2-1b-instruct`, `max_tokens: 5`) — wasting ~200ms and 1 LLM
call just to decide the intent.

### The fix

Added `research`, `look up`, `tell me about`, `explain`, and `define`
to the keyword fallback regex:

**File:** `server/worker/src/index.ts`, line 219

**Before:**
```typescript
if (/\b(search|google|look up|find|what is|who is|where is)\b/.test(t)) return "search";
```

**After:**
```typescript
if (/\b(search|google|look up|find|what is|who is|where is|research|look\s*up|tell me about|explain|define)\b/.test(t)) return "search";
```

**Impact:**
- "research on cloudflare" → matches `\bresearch\b` → returns `"search"` immediately
- No LLM intent classifier call needed
- Saves ~200ms and 1 LLM call per research query

---

## Bug 2: isSearchQuestion() didn't catch "research on X"

### The problem

Even if `keywordFallback()` returns `"general"` (e.g., for a phrase
not in the keyword list), there's a safety net in `handleTranscript()`:

```typescript
if (intent === "general" && isSearchQuestion(req.task.request)) {
  intent = "search";
}
```

But `isSearchQuestion()` didn't have a pattern for "research on X":

```typescript
const searchPatterns = [
  /^(what|who|where|when|why|how)\s+(is|are|was|were|do|does|did|can|could)\b/,
  /^(what|who|where|when|why|how)\s+\S+/,
  /^(tell me about|explain|describe|define)\b/,
  /^(what's|whats|who's|whos)\b/,
];
```

"research on cloudflare" doesn't start with "what/who/where/when/why/how"
or "tell me about/explain/describe/define", so it returned `false`.

### The fix

Added a pattern for "research", "look up", "find info on", and
"search for":

**File:** `server/worker/src/research.ts`, line 139

**Before:**
```typescript
const searchPatterns = [
  /^(what|who|where|when|why|how)\s+(is|are|was|were|do|does|did|can|could)\b/,
  /^(what|who|where|when|why|how)\s+\S+/,
  /^(tell me about|explain|describe|define)\b/,
  /^(what's|whats|who's|whos)\b/,
];
```

**After:**
```typescript
const searchPatterns = [
  /^(what|who|where|when|why|how)\s+(is|are|was|were|do|does|did|can|could)\b/,
  /^(what|who|where|when|why|how)\s+\S+/,
  /^(tell me about|explain|describe|define)\b/,
  /^(what's|whats|who's|whos)\b/,
  /^(research|look up|look\s*up|find info on|find information on|search for)\b/,
];
```

**Impact:**
- "research on cloudflare" → matches `/^research\b/` → returns `true`
- Even if keyword fallback misses it, the safety net catches it
- Routes to `handleSearch()` instead of `handleGeneral()`

---

## Bug 3: isAcademicQuery() was too broad

### The problem

The initial implementation of `isAcademicQuery()` matched any query
containing "research":

```typescript
export function isAcademicQuery(query: string): boolean {
  const t = query.toLowerCase();
  return /\b(paper|research|study|studies|arxiv|...|neural|model|...)\b/.test(t);
}
```

This meant "research on cloudflare" would match as academic (because
of "research"), triggering a Semantic Scholar API call — which is
wrong because "research on cloudflare" is a general research query,
not an academic paper search.

### The fix

Split into two regex groups — academic keywords AND topic keywords.
Both must match:

**File:** `server/worker/src/research.ts`, line 346

**After:**
```typescript
export function isAcademicQuery(query: string): boolean {
  const t = query.toLowerCase();
  // Must contain an academic keyword AND a topic keyword to avoid
  // matching "research on cloudflare" (general research, not academic)
  const academicKeywords = /\b(papers?|arxiv|publication|journal|citation|academic|scientific|study|studies|research)\b/;
  const topicKeywords = /\b(algorithm|neural|model|benchmark|dataset|transformer|architecture|learning|machine|deep|network|covid|transmission|attention|mechanism)\b/;
  return academicKeywords.test(t) && topicKeywords.test(t);
}
```

**Impact:**
- "research on cloudflare" → academic keyword "research" matches, but
  no topic keyword matches → returns `false` → no Semantic Scholar call
- "research on neural networks" → "research" + "neural" → returns
  `true` → Semantic Scholar called
- "find papers on transformer architecture" → "papers" + "transformer"
  + "architecture" → returns `true` → Semantic Scholar called

---

## Bug 4: LLM reasoning leakage

### The problem

The original search synthesis used `mistral-small-3.1-24b-instruct`
via Cloudflare Workers AI. This is a reasoning model that shows its
full chain-of-thought in the output:

```
1. Analyze the Request:
   - Task: Research Cloudflare.
   - Sources: Two HTML snippets...
2. Analyze Source [1]:
   ...
```

When spoken aloud by TTS, this sounds terrible — the user hears the
entire reasoning process before getting to the answer.

### The fix

1. **Switched Cloudflare model** from `mistral-small-24b` to
   `llama-3.2-3b-instruct` (direct output, no CoT)
2. **Added Gemini Flash Lite** as primary LLM (non-reasoning by design)
3. **Added Groq Qwen 3.8 27B** as fallback (non-reasoning)
4. **Added system prompt** explicitly forbidding reasoning output:
   ```
   Never show your reasoning, analysis steps, or thought process.
   Give only the final answer with citation numbers like [1], [2].
   ```
5. **Demoted Cloudflare to tier 3** — only used if Gemini and Groq
   both fail

**File:** `server/worker/src/external_llm.ts` (new file)
**File:** `server/worker/src/models.ts` → `SEARCH_SYNTHESIS_FALLBACK_CHAIN`

**Before:**
```typescript
export const SEARCH_SYNTHESIS_FALLBACK_CHAIN = [
  SUMMARY_MODEL,         // mistral-small (leaks reasoning)
  ANALYSIS_MODEL,        // glm-4.7-flash (also leaks)
];
```

**After:**
```typescript
export const SEARCH_SYNTHESIS_FALLBACK_CHAIN = [
  SMALL_SUMMARY_MODEL,   // llama-3.2-3b (direct, no CoT, fast)
  ANALYSIS_MODEL,        // glm-4.7-flash (fallback)
  SUMMARY_MODEL,         // mistral-small (last resort — may show reasoning)
];
```

Note: This chain is now only used as the Cloudflare fallback in the
external LLM cascade. The primary path is Gemini → Groq → Cloudflare.

---

## Bug 5: Cached responses contain old reasoning

### The problem

After fixing the LLM model, old cached responses in KV still contain
the reasoning-leaked output from Mistral. KV cache TTL is 24 hours,
so the old responses persist for up to a day after the fix.

### The fix

No code fix needed — the cache expires naturally after 24 hours. To
force a cache miss immediately, slightly modify the query:

- "research on cloudflare" → cached (old output)
- "research on cloudflare inc" → fresh (new output with Gemini)

**Future improvement:** Could add a cache version key to the cache
key format, so deploying a new Worker version invalidates all caches:

```typescript
const CACHE_VERSION = "v2"; // bump on model changes
const cacheK = `${CACHE_VERSION}:search:en:${contentHash(query)}`;
```

---

## Test coverage for fixes

All fixes are covered by unit tests in
`server/worker/src/__tests__/research.test.ts`:

```typescript
test("detects 'research on X' / 'look up X' / 'search for X'", () => {
  expect(isSearchQuestion("research on cloudflare")).toBe(true);
  expect(isSearchQuestion("research on cloud flare")).toBe(true);
  expect(isSearchQuestion("look up the capital of France")).toBe(true);
  expect(isSearchQuestion("search for rust async patterns")).toBe(true);
  expect(isSearchQuestion("find info on kubernetes")).toBe(true);
});

test("detects math expressions", () => {
  expect(isMathQuery("calculate 15 * 23")).toBe(true);
  expect(isMathQuery("what is 2 + 2")).toBe(true);
  expect(isMathQuery("convert 5 miles to km")).toBe(true);
  expect(isMathQuery("2 + 2")).toBe(true);
  expect(isMathQuery("solve x^2 + 5x + 6 = 0")).toBe(true);
});

test("does NOT trigger on non-math queries", () => {
  expect(isMathQuery("research on cloudflare")).toBe(false);
  expect(isMathQuery("what is quantum computing")).toBe(false);
  expect(isMathQuery("close chrome")).toBe(false);
});

test("detects academic queries", () => {
  expect(isAcademicQuery("find papers on transformer architecture")).toBe(true);
  expect(isAcademicQuery("study on covid transmission")).toBe(true);
  expect(isAcademicQuery("arxiv paper on attention mechanism")).toBe(true);
  expect(isAcademicQuery("research on neural networks")).toBe(true);
});

test("does NOT trigger on non-academic queries", () => {
  expect(isAcademicQuery("what is cloudflare")).toBe(false);
  expect(isAcademicQuery("close chrome")).toBe(false);
  expect(isAcademicQuery("research on cloudflare")).toBe(false);
});
```

All 28 tests pass.

---

## File references

- **keywordFallback fix:** `server/worker/src/index.ts` line 219
- **isSearchQuestion fix:** `server/worker/src/research.ts` line 139
- **isAcademicQuery fix:** `server/worker/src/research.ts` line 346
- **isMathQuery implementation:** `server/worker/src/research.ts` line 330
- **LLM cascade (reasoning fix):** `server/worker/src/external_llm.ts`
- **Model chain fix:** `server/worker/src/models.ts` line 42
- **Tests:** `server/worker/src/__tests__/research.test.ts`
