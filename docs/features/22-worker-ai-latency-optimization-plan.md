# NEXUS Worker AI — Latency Optimization Plan

> **Current latency:** ~40 seconds (send → receive)
> **Target latency:** 3-4 seconds (send → first token) / 8-12s (full response)
> **Date:** 2026-08-30

---

## 1. Where the 40 Seconds Is Going — Root Cause Analysis

The request flow is **fully sequential** — every step blocks the next:

```
User speaks → STT → Rust POST to Worker → Worker:
  1. classifyIntent()           ← AI call #1 (llama-3.2-1b)     ~1-3s
  2. getValidGithubToken()      ← D1 query                     ~50ms
  3. resolveRepo()              ← GitHub API (user/repos)       ~500ms-2s
  4. fetchPRContext()           ← 5 GitHub API calls            ~2-5s
     ├─ GET /repos/{repo}/pulls/{pr}
     ├─ GET /repos/{repo}/pulls/{pr}/files      ┐
     ├─ GET /repos/{repo}/pulls/{pr}/commits     ├─ Promise.all  ~1-3s
     ├─ GET /repos/{repo}/pulls/{pr}/comments    │
     └─ GET /repos/{repo}/pulls/{pr}/reviews    ┘
  5. env.AI.run(ANALYSIS_MODEL) ← AI call #2 (GLM-4.7-Flash)   ~15-30s
     ├─ Prompt: ~50K-200K chars of PR context
     └─ max_tokens: 3000
  6. Return reply_text           ← HTTP response                ~instant
```

### The three latency bottlenecks

| Bottleneck | Time | Why |
|-----------|------|-----|
| **AI call #2 (GLM-4.7-Flash analysis)** | 15-30s | Reasoning model with 50K-200K char prompt + 3000 max_tokens. At ~33 tok/s on Cloudflare, 3000 tokens = ~90s theoretical, but with reasoning overhead it's 15-30s for shorter outputs. The **prompt is enormous** — full PR diffs, commits, comments, reviews. |
| **AI call #1 (intent classification)** | 1-3s | `llama-3.2-1b-instruct` is called for EVERY request even though `keywordFallback()` already handles 90% of intents. The keyword fallback returns early, but for "general" intents it falls through to the LLM. |
| **GitHub API calls** | 2-5s | `resolveRepo()` fetches ALL user repos (100 per page) to do fuzzy matching, then `fetchPRContext()` makes 5 API calls. These are sequential: resolveRepo → fetchPRContext. |
| **No streaming** | +5-10s perceived | The Worker waits for the **entire** AI response before returning. The user sees nothing until the full 3000-token analysis is generated. |

### Why it's 40s and not 15s

The 40s is the **sum** of all sequential steps. For a PR analysis:
- Intent classification: ~2s (even though keywords could skip it)
- D1 token lookup: ~0.1s
- resolveRepo (100 repos + Levenshtein): ~1-2s
- fetchPRContext (5 parallel API calls): ~2-3s
- GLM-4.7-Flash analysis (200K char prompt, 3000 tokens): ~25-35s
- **Total: ~30-42s**

---

## 2. Optimization Strategy — 5 Phases

### Phase 1: Skip redundant AI calls (saves ~2s on every request)

**Problem:** `classifyIntent()` calls `llama-3.2-1b` for every "general" intent, even though `keywordFallback()` already catches github/gmail/calendar/search/analyze_repo. The LLM is only needed for ambiguous queries.

**Fix:** The keyword fallback already returns early for known intents. But for "general" queries, it falls through to the LLM call. Since "general" just calls `handleGeneral()` which calls `summarize()` (another LLM call), we're making **two** LLM calls for every general query.

```typescript
// BEFORE: two LLM calls for general queries
const intent = await classifyIntent(transcript, env);  // LLM call #1
// → "general" → handleGeneral() → summarize()          // LLM call #2

// AFTER: skip classification for general, go straight to summarize
const keywordIntent = keywordFallback(transcript);
if (keywordIntent !== "general") {
  // Use keyword intent — no LLM needed
} else {
  // Skip LLM classification — just call handleGeneral() directly
  // which calls summarize() once. Saves one LLM round-trip.
}
```

**Estimated savings:** ~2s per general query, ~0s for keyword-matched queries (already fast).

---

### Phase 2: Parallelize GitHub API calls (saves ~2-3s)

**Problem:** `resolveRepo()` runs **before** `fetchPRContext()`. But `resolveRepo()` is only needed if the repo name doesn't contain `/`. If the user says "analyse PR 24 in owner/repo", we skip resolveRepo entirely.

**Fix A:** If repo contains `/`, skip resolveRepo and go straight to fetchPRContext.

**Fix B:** When resolveRepo IS needed, parallelize it with the PR metadata fetch. We can start fetching the PR metadata using the raw repo name (even if it might be wrong) while simultaneously resolving the repo. If resolveRepo returns a different name, we retry with the correct name.

**Fix C:** Cache resolveRepo results in a Worker-level Map (or KV). Repo names don't change often — if we resolved "zync" → "chitkullakshya/zync" 5 minutes ago, reuse that mapping.

```typescript
// Repo name cache (Worker-level, survives between requests on same isolate)
const repoCache = new Map<string, string>(); // "zync" → "owner/zync"

async function resolveRepoCached(token: string, repoName: string | null): Promise<string | null> {
  if (!repoName) return null;
  if (repoName.includes("/")) return repoName;

  const cached = repoCache.get(repoName.toLowerCase());
  if (cached) return cached;

  const resolved = await resolveRepo(token, repoName);
  if (resolved) repoCache.set(repoName.toLowerCase(), resolved);
  return resolved;
}
```

**Estimated savings:** ~2-3s when repo is cached, ~1s from skipping resolveRepo when repo has `/`.

---

### Phase 3: Reduce the analysis prompt size (saves ~10-15s)

**Problem:** The analysis prompt includes **full diffs** for every changed file, up to 200K chars. GLM-4.7-Flash has a 131K token context window, but **larger prompts = slower prefill**. The prefill phase is compute-bound — more tokens = linearly more time.

Current limits:
```typescript
const MAX_PATCH_PER_FILE = 3000;    // 3K chars per file
const MAX_TOTAL_PATCH = 200000;     // 200K chars total (~50K tokens)
```

**Fix:** Reduce the context aggressively. For a code review, the LLM doesn't need every line of every diff — it needs:
- PR metadata (title, body, author, state)
- File list with change stats (filename, +additions -deletions, status)
- **Only the most important diffs** (largest changes, or files with review comments)
- Commit messages (just the first line)
- Review comments (already truncated to 500 chars)

```typescript
// AFTER: aggressive truncation
const MAX_PATCH_PER_FILE = 1500;    // 1.5K chars per file (enough for context)
const MAX_TOTAL_PATCH = 60000;      // 60K chars total (~15K tokens)
const MAX_FILES_WITH_PATCH = 15;    // Only include diffs for top 15 files by change size
```

**Strategy for selecting which files get diffs:**
1. Sort files by `additions + deletions` (descending)
2. Include full patch for top 15 files
3. For remaining files, include only filename + change stats (no patch)

This reduces the prompt from ~50K tokens to ~15K tokens, cutting prefill time by ~3x.

**Estimated savings:** ~10-15s on large PRs, ~5s on medium PRs.

---

### Phase 4: Switch to a faster model for simple queries (saves ~5-10s)

**Problem:** Every query goes through either:
- `SUMMARY_MODEL` = `@cf/mistral/mistral-small-3.1-24b-instruct` (24B params, ~1.3s TTFT)
- `ANALYSIS_MODEL` = `@cf/zai-org/glm-4.7-flash` (reasoning model, variable latency)

For simple queries ("check unread emails", "what's on my calendar"), the 24B Mistral is overkill. For PR analysis, GLM-4.7-Flash's reasoning capability is valuable but slow.

**Fix — tiered model selection:**

| Query type | Current model | Proposed model | TTFT |
|-----------|--------------|----------------|------|
| Intent classification | llama-3.2-1b | **Skip entirely** (keywords) | 0s |
| Simple summary (email, calendar) | mistral-small-3.1-24b | **llama-3.2-3b** | ~1.5s |
| General question | mistral-small-3.1-24b | **llama-3.2-3b** | ~1.5s |
| PR analysis (small PR, <60K chars) | glm-4.7-flash | **mistral-small-3.1-24b** | ~1.3s |
| PR analysis (large PR, >60K chars) | glm-4.7-flash | **glm-4.7-flash** (keep) | ~2-5s |
| PR re-evaluation / deep review | glm-5.3-flash | **glm-5.3-flash** (keep) | ~5-10s |

**Rationale:**
- `llama-3.2-3b` is 8x smaller than Mistral 24B, with ~1.5s TTFT vs ~1.3s. For simple summaries, the quality difference is negligible.
- For PR analysis, use Mistral 24B for small/medium PRs (it's faster than GLM-4.7-Flash for non-reasoning tasks) and only use GLM-4.7-Flash for large PRs that need reasoning.
- GLM-4.7-Flash is a **reasoning model** — it generates hidden "thinking" tokens that don't appear in the output but consume time. For a simple "summarize this PR in 2 sentences", reasoning is wasted overhead.

**Estimated savings:** ~5-10s for simple queries, ~5s for medium PR analysis.

---

### Phase 5: Stream the response (saves ~15-20s perceived latency)

**Problem:** The Worker waits for the **entire** AI response, then returns it as a single JSON object. The user sees nothing for 30-40s, then gets the full response at once.

**Fix:** Use Workers AI's `stream: true` parameter to get a `ReadableStream` of SSE events. Stream tokens to the client as they're generated.

This doesn't reduce the **total** time, but it reduces **perceived** latency from 40s → 3-4s (time to first token). The user starts reading the analysis while it's still being generated.

#### Worker-side changes:

```typescript
// BEFORE: wait for full response
const response = await env.AI.run(model, { messages, max_tokens: 3000 });
const analysis = extractText(response);
return json({ reply_text: analysis });

// AFTER: stream tokens as SSE
const stream = await env.AI.run(model, { messages, max_tokens: 3000, stream: true });
return new Response(stream, {
  headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  },
});
```

But we need to handle the existing protocol (JSON response with `reply_text`). Two options:

**Option A: New streaming endpoint (recommended)**
- Keep `POST /` as-is for backward compatibility
- Add `POST /stream` that returns SSE
- Rust client uses `/stream` for analysis queries, `/` for simple queries
- Frontend shows tokens as they arrive (like ChatGPT)

**Option B: Upgrade protocol to always stream**
- Change `POST /` to always return SSE
- Rust client parses SSE and emits `assistant:server` events per token
- Frontend appends tokens to the sidebar in real-time

**Recommended: Option A** — less disruptive, allows gradual migration.

#### Rust-side changes:

```rust
// New: send_transcript_streaming command
pub async fn send_transcript_streaming(app: AppHandle<R>, text: String) -> Result<(), String> {
    // ... same setup as send_transcript ...

    let resp = client.post(&format!("{}/stream", worker_url)).json(&payload).send().await?;

    // Parse SSE stream
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let text = String::from_utf8_lossy(&chunk);

        // Parse SSE: "data: {\"response\": \"token\"}\n\n"
        for line in text.lines() {
            if line.starts_with("data: ") && !line.contains("[DONE]") {
                let json: serde_json::Value = serde_json::from_str(&line[6..])?;
                let token = json["response"].as_str().or(json["choices"][0]["delta"]["content"].as_str()).unwrap_or("");
                if !token.is_empty() {
                    app.emit("assistant:server", ServerEvent {
                        kind: "token".into(),
                        data: Some(token.into()),
                        ..
                    });
                }
            }
        }
    }

    app.emit("assistant:server", ServerEvent::done());
    Ok(())
}
```

#### Frontend-side changes:

The sidebar already has a streaming text animation feature (`03-sidebar-streaming-animation.md`). The `wsBridge.ts` handler would accumulate tokens and update the sidebar in real-time:

```typescript
case "token":
  // Append token to the current response
  store.appendToken(ev.data);
  break;
case "result":
  // Final complete text (for TTS)
  store.addAssistantMessage(ev.data);
  break;
```

**Estimated savings:** 40s → 3-4s perceived (time to first token). Total time unchanged, but user experience dramatically better.

---

## 3. Implementation Priority

| Phase | Effort | Savings (actual) | Savings (perceived) | Priority |
|-------|--------|-------------------|---------------------|----------|
| 1: Skip redundant AI | Low | ~2s | ~2s | **P0** (quick win) |
| 2: Parallelize + cache GitHub | Medium | ~2-3s | ~2-3s | **P0** |
| 3: Reduce prompt size | Low | ~10-15s | ~10-15s | **P0** (biggest actual win) |
| 4: Tiered model selection | Medium | ~5-10s | ~5-10s | **P1** |
| 5: Stream the response | High | 0s | ~35s | **P1** (biggest perceived win) |

**Combined estimated latency after all phases:**

| Query type | Before | After (actual) | After (perceived with streaming) |
|-----------|--------|----------------|----------------------------------|
| "Check unread emails" | ~15s | ~3-4s | ~1.5s (first token) |
| "What's on my calendar" | ~12s | ~3s | ~1.5s |
| "Check PR 24 in zync" (small PR) | ~20s | ~5-7s | ~2s (first token) |
| "Analyse PR 76 in servx" (large PR) | ~40s | ~15-20s | ~3-4s (first token) |
| "What is the capital of France" | ~10s | ~3s | ~1.5s |

---

## 4. Additional Optimizations (Future)

### 4a: Cache identical queries in Workers KV

If the user asks "analyse PR 24" twice within 5 minutes, return the cached analysis. KV reads are ~10ms vs 30s for a fresh analysis.

```typescript
const cacheKey = `analysis:${userId}:${repo}:${prNumber}`;
const cached = await env.CACHE.get(cacheKey);
if (cached) return json({ reply_text: cached, cached: true });

// ... generate analysis ...
await env.CACHE.put(cacheKey, analysis, { expirationTtl: 300 }); // 5 min TTL
```

### 4b: Use AI Gateway for caching + retry

Cloudflare AI Gateway provides automatic response caching, retry on failure, and rate limiting. It sits between the Worker and Workers AI.

```typescript
// wrangler.toml
[[ai_gateway]]
binding = "GATEWAY"
name = "nexus-gateway"

// index.ts
const response = await env.AI.run(model, {
  gateway: { id: env.GATEWAY.id },
  messages,
  max_tokens: 3000,
});
```

### 4c: Pre-warm the model on first request

Workers AI models have a cold start of 1-3s on first request. If the Worker has been idle for >5 minutes, the first request pays this cost. A scheduled cron job could keep the model warm:

```typescript
// wrangler.toml
[triggers]
crons = ["*/5 * * * *"]  // every 5 minutes

// index.ts
export default {
  async scheduled(event, env) {
    // Warm up the most-used model
    await env.AI.run(INTENT_MODEL, { messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
  },
};
```

### 4d: Use DeepInfra for GLM-4.7-Flash (3x faster)

Per benchmarks, DeepInfra serves GLM-4.7-Flash at 74.6 tok/s vs Cloudflare's 33 tok/s. If we're willing to use an external API:

```typescript
// Instead of env.AI.run(GLM_MODEL, ...)
const response = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
  method: "POST",
  headers: { "Authorization": `Bearer ${env.DEEPINFRA_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "zai-org/GLM-4.7-Flash",
    messages,
    max_tokens: 3000,
    stream: true,
  }),
});
```

**Trade-off:** Adds an external dependency and API key management, but 2x faster inference.

---

## 5. What NOT to Change

- **Keyword fallback for intent classification** — already fast, keep as-is
- **D1 database queries** — already fast (~50ms), not a bottleneck
- **OAuth token refresh** — only runs on expiry, not per-request
- **Rust HTTP client timeout** — 120s is fine as a safety net; actual responses will be much faster after optimization
- **Ack phrase ("On it, sir")** — already emitted immediately, good UX

---

## 6. Measurement Plan

Before and after each phase, measure:

1. **Time to first byte (TTFB)** — when the Worker starts sending data
2. **Time to first token (TTFT)** — when the first AI token appears (with streaming)
3. **Total response time** — when the full response is received
4. **Per-step timing** — add `console.log` timestamps at each step in the Worker

```typescript
const t0 = Date.now();
const intent = await classifyIntent(req.task.request, env);
console.log(`[timing] intent: ${Date.now() - t0}ms`);

const t1 = Date.now();
const token = await getValidGithubToken(env, userId);
console.log(`[timing] d1: ${Date.now() - t1}ms`);

const t2 = Date.now();
const repo = await resolveRepoCached(token, repoName);
console.log(`[timing] resolveRepo: ${Date.now() - t2}ms`);

const t3 = Date.now();
const context = await fetchPRContext(token, repo, prNumber);
console.log(`[timing] fetchPR: ${Date.now() - t3}ms, context=${context.length}chars`);

const t4 = Date.now();
const analysis = await env.AI.run(model, { messages, max_tokens: 3000 });
console.log(`[timing] AI: ${Date.now() - t4}ms`);

console.log(`[timing] TOTAL: ${Date.now() - t0}ms`);
```

---

## 7. File Changes Summary

| File | Phase | Change |
|------|-------|--------|
| `server/worker/src/index.ts` | 1 | Remove LLM classification for "general" intent |
| `server/worker/src/index.ts` | 2 | Add repoCache Map, skip resolveRepo when repo has `/` |
| `server/worker/src/index.ts` | 3 | Reduce MAX_TOTAL_PATCH to 60K, MAX_PATCH_PER_FILE to 1.5K, add file sorting |
| `server/worker/src/index.ts` | 4 | Tiered model selection: llama-3.2-3b for simple, mistral for medium PR, GLM for large |
| `server/worker/src/index.ts` | 5 | Add `POST /stream` endpoint with SSE streaming |
| `server/worker/wrangler.toml` | 5 | (No change needed — streaming works with existing config) |
| `src-tauri/src/network.rs` | 5 | Add `send_transcript_streaming` command that parses SSE |
| `frontend/src/net/wsBridge.ts` | 5 | Handle "token" events, append to sidebar in real-time |
| `frontend/src/sidebar/sidebarStore.ts` | 5 | Add `appendToken` action for streaming text |

---

## 8. Recommended Implementation Order

1. **Phase 3 first** (reduce prompt size) — biggest actual win, lowest effort, no protocol changes
2. **Phase 1** (skip redundant AI) — quick win, 1 line change
3. **Phase 2** (parallelize + cache GitHub) — medium effort, good win
4. **Phase 4** (tiered models) — needs testing to verify quality
5. **Phase 5** (streaming) — biggest perceived win but most work (Rust SSE parsing + frontend streaming UI)

After Phases 1-3: expect ~20-25s (down from 40s)
After Phase 4: expect ~12-18s
After Phase 5: expect ~3-4s perceived (first token), ~12-18s total
