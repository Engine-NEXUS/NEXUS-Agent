# 02 — LLM Cascade (Gemini → Groq → Cloudflare)

The NEXUS Worker uses a 3-tier LLM cascade for answer synthesis. Each
tier is a different provider with different free quotas, speeds, and
model characteristics. The cascade tries the best provider first and
falls back to the next one on failure.

## Cascade overview

| Tier | Provider | Model | Free quota | Speed | When used |
|------|----------|-------|------------|-------|-----------|
| 1 | Google Gemini | `gemini-flash-lite-latest` | 1,500 req/day | ~2-4s | Primary — highest quota, 1M context |
| 2 | Groq | `qwen/qwen3.8-27b` | 14,400 req/day | ~1-3s | Fallback — fastest inference |
| 3 | Cloudflare Workers AI | `@cf/meta/llama-3.2-3b-instruct` | ~200 calls/day | ~3-5s | Last resort — always available |

**Total free LLM capacity: 16,100 req/day**
**10-user daily need: ~105 req/day**
**Headroom: 153x**

---

## Tier 1: Google Gemini Flash Lite

### Why Gemini is primary

- **Highest free quota:** 1,500 req/day (vs Groq's per-model limits and
  Cloudflare's 10K neurons/day ≈ 200 calls)
- **1M token context window:** Can handle very long source texts
  (multiple Wikipedia articles + search results in one prompt)
- **No reasoning token leakage:** `gemini-flash-lite-latest` is a
  non-reasoning model — it gives direct answers without showing
  chain-of-thought
- **No card required:** Free tier is permanent, no expiration
- **Multimodal capable:** Can process images, audio, video (not used
  currently but available for future features)

### Model selection history

| Model tried | Result | Why |
|-------------|--------|-----|
| `gemini-2.5-flash` | ❌ 404 | "no longer available to new users" |
| `gemini-flash-latest` | ⚠️ 503 | "currently experiencing high demand" |
| `gemini-3.6-flash` | ⚠️ Reasoning model | Wastes 95 tokens on thinking for a 1-word answer |
| `gemini-flash-lite-latest` | ✅ Perfect | Direct answer, no thinking tokens, fast |

### API details

**Endpoint:**
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key={API_KEY}
```

**Request body:**
```json
{
  "contents": [
    {
      "role": "user",
      "parts": [{ "text": "{system_prompt}\n\n{user_prompt}" }]
    }
  ],
  "generationConfig": {
    "maxOutputTokens": 700,
    "temperature": 0.3
  }
}
```

**Note on maxOutputTokens:** Set to `maxTokens + 200` because Gemini
flash-lite may use a small number of thinking tokens even in
non-reasoning mode. The extra 200 tokens ensures the actual answer
isn't truncated.

**Response parsing:**
```typescript
const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
```

### Free tier limits

| Limit | Value | Notes |
|-------|-------|-------|
| Requests per day (RPD) | 1,500 | Per model, resets at midnight Pacific Time |
| Requests per minute (RPM) | 30 | Flash-Lite has higher RPM than Flash |
| Tokens per minute (TPM) | 1,000,000 | Input + output combined |
| Input token limit | 1,048,576 | 1M context window |
| Credit card required | No | Google account only |
| Expiration | None | Free tier is permanent |
| Data usage | Yes (free tier) | Google may use prompts for model training |

### Code

**File:** `server/worker/src/external_llm.ts` → `callGemini()`

```typescript
export async function callGemini(
  prompt: string,
  env: Env,
  systemPrompt: string = "",
  maxTokens: number = 500,
): Promise<LLMResponse | null> {
  if (!env.GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  // ... POST request, parse candidates[0].content.parts[0].text
}
```

### Key setup

1. Go to https://aistudio.google.com/apikey
2. Click "Create API key"
3. Select any Google Cloud project (or create one)
4. Copy the key (starts with `AIza...` or `AQ.Ab8...`)
5. Set as Cloudflare secret:
   ```
   npx wrangler secret put GEMINI_API_KEY
   ```

---

## Tier 2: Groq (Qwen 3.8 27B)

### Why Groq is the fallback

- **Massive free quota:** 14,400 req/day for the 8B-class models
- **Fastest inference:** 300-500 tokens/s on 70B models, 1,500-2,000
  tokens/s on 8B models (LPU hardware, not GPU)
- **No reasoning leakage:** Qwen 3.8 27B gives direct answers without
  chain-of-thought
- **No card required:** Free tier, no expiration
- **OpenAI-compatible API:** Uses the standard `/v1/chat/completions`
  format — easy to integrate

### Model selection history

| Model tried | Result | Why |
|-------------|--------|-----|
| `llama-3.3-70b-versatile` | ❌ 404 | "does not exist or you do not have access" |
| `groq/compound` | ⚠️ Reasoning model | Returns `<Think>` tags in reasoning field |
| `openai/gpt-oss-20b` | ⚠️ Reasoning model | All 10 tokens consumed by reasoning |
| `qwen/qwen3.8-27b` | ✅ Perfect | Direct answer, 5ms, no reasoning tokens |

### Available Groq models (as of 2026-09-01)

```
groq/compound
whisper-large-v3-turbo
openai/gpt-oss-safeguard-20b
openai/gpt-oss-120b
groq/compound-mini
allam-2-7b
canopylabs/orpheus-arabic-saudi
meta-llama/llama-prompt-guard-2-86m
whisper-large-v3
meta-llama/llama-prompt-guard-2-22m
qwen/qwen3.6-27b
openai/gpt-oss-20b
canopylabs/orpheus-v1-english
qwen/qwen3.8-27b    ← selected
```

**Note:** Groq's model catalog changes frequently. The old
`llama-3.3-70b-versatile` was removed. Always check
`GET https://api.groq.com/openai/v1/models` for the current list.

### API details

**Endpoint:**
```
POST https://api.groq.com/openai/v1/chat/completions
```

**Headers:**
```
Content-Type: application/json
Authorization: Bearer {GROQ_API_KEY}
```

**Request body:**
```json
{
  "model": "qwen/qwen3.8-27b",
  "messages": [
    { "role": "system", "content": "You are NEXUS..." },
    { "role": "user", "content": "{prompt}" }
  ],
  "max_tokens": 500,
  "temperature": 0.3
}
```

**Response parsing:**
```typescript
const text = data?.choices?.[0]?.message?.content;
```

### Free tier limits

| Limit | Value | Notes |
|-------|-------|-------|
| Requests per day (RPD) | 14,400 (8B-class) | Per-model limits vary |
| Requests per minute (RPM) | 30 | Per-model |
| Tokens per minute (TPM) | 6,000 | Per-model |
| Context window | 128K tokens | For Qwen 3.8 27B |
| Credit card required | No | |
| Expiration | None | |

### Code

**File:** `server/worker/src/external_llm.ts` → `callGroq()`

```typescript
export async function callGroq(
  prompt: string,
  env: Env,
  systemPrompt: string = "",
  maxTokens: number = 500,
): Promise<LLMResponse | null> {
  if (!env.GROQ_API_KEY) return null;
  // ... POST to api.groq.com, parse choices[0].message.content
}
```

### Key setup

1. Go to https://console.groq.com/keys
2. Sign up with Google or email
3. Click "Create API Key"
4. Copy the key (starts with `gsk_...`)
5. Set as Cloudflare secret:
   ```
   npx wrangler secret put GROQ_API_KEY
   ```

---

## Tier 3: Cloudflare Workers AI (Llama 3.2 3B)

### Why Cloudflare is last resort

- **Lowest free quota:** 10K neurons/day ≈ ~200 synthesis calls
- **Slower:** ~50 tokens/s (vs Groq's 300-500, Gemini's 100-200)
- **But always available:** Already bound to the Worker via `AI` binding,
  no external API call needed, no network latency to another provider

### Model selection

| Model | Result | Why |
|-------|--------|-----|
| `@cf/mistral/mistral-small-3.1-24b-instruct` | ❌ Reasoning leakage | Shows full chain-of-thought in output |
| `@cf/zai-org/glm-4.7-flash` | ❌ Reasoning leakage | Also shows analysis steps |
| `@cf/meta/llama-3.2-3b-instruct` | ✅ Direct | Small model, no CoT, gives clean answers |
| `@cf/meta/llama-3.2-1b-instruct` | ✅ Direct but low quality | Too small for good synthesis |

Selected: `@cf/meta/llama-3.2-3b-instruct` — best balance of direct
output and answer quality.

### API details

**Binding:** `env.AI` (Cloudflare Workers AI binding, configured in `wrangler.toml`)

**Code:**
```typescript
const response = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ],
  max_tokens: maxTokens,
});
const text = (response as any)?.response || "";
```

### Free tier limits

| Limit | Value | Notes |
|-------|-------|-------|
| Neurons per day | 10,000 | Global, shared across all users |
| Approximate calls | ~200 | Depends on prompt/output size |
| Cost | $5/month | Workers Paid plan (already have) |

---

## The cascade function

**File:** `server/worker/src/external_llm.ts` → `synthesizeWithCascade()`

```typescript
export async function synthesizeWithCascade(
  prompt: string,
  env: Env,
  systemPrompt: string = "You are NEXUS, a voice assistant. Answer the user's question directly and concisely using only the provided sources. Never show your reasoning, analysis steps, or thought process. Give only the final answer with citation numbers like [1], [2].",
  maxTokens: number = 500,
): Promise<LLMResponse | null> {
  // 1. Gemini (1,500 req/day, 1M context, best for long sources)
  const gemini = await callGemini(prompt, env, systemPrompt, maxTokens);
  if (gemini) return gemini;

  // 2. Groq (14,400 req/day, fastest inference, 70B model)
  const groq = await callGroq(prompt, env, systemPrompt, maxTokens);
  if (groq) return groq;

  // 3. Cloudflare Workers AI (~200 calls/day, last resort)
  const cf = await callCloudflare(prompt, env, systemPrompt, maxTokens);
  if (cf) return cf;

  return null;
}
```

### System prompt (used for all 3 tiers)

```
You are NEXUS, a voice assistant. Answer the user's question directly
and concisely using only the provided sources. Never show your
reasoning, analysis steps, or thought process. Give only the final
answer with citation numbers like [1], [2].
```

This system prompt is critical — without it, the models (especially
Mistral and GLM) show their full reasoning process in the output,
which would be spoken aloud by TTS and sound terrible.

### Where the cascade is used

1. **`handleSearch()`** in `index.ts` — for all search/research queries
   (after sources are retrieved)
2. **`handleGeneral()`** in `index.ts` — for general chat/Q&A queries
   (no sources, just direct LLM response)

### Fallback when ALL LLMs fail

If all 3 tiers fail (network error, rate limit, etc.), the Worker
returns the raw snippet from the best source:

```typescript
if (!synthesis) {
  synthesis = `${deduped[0].snippet}\n\nSource: ${deduped[0].url}`;
}
```

This ensures the user always gets a factual answer with a citation,
even if every LLM provider is down.

---

## Reasoning leakage problem and fix

### The problem

Initially, the search synthesis used `mistral-small-3.1-24b-instruct`
via Cloudflare Workers AI. This model is a reasoning model — it shows
its full chain-of-thought in the output:

```
1. Analyze the Request:
   - Task: Research Cloudflare.
   - Sources: Two HTML snippets...
2. Analyze Source [1]:
   - Content: "Cloudflare, Inc., is..."
3. Synthesize Answer:
   ...
```

This is fine for a text interface but **terrible for a voice
assistant** — the user would hear the entire reasoning process spoken
aloud before getting to the actual answer.

### The fix

1. **Switched primary model** from `mistral-small-24b` to
   `llama-3.2-3b-instruct` (Cloudflare) — direct output, no CoT
2. **Added system prompt** explicitly instructing "Never show your
   reasoning, analysis steps, or thought process"
3. **Added Gemini Flash Lite** as primary — non-reasoning model by
   design
4. **Added Groq Qwen 3.8 27B** as fallback — also non-reasoning
5. **Demoted Cloudflare to tier 3** — only used if Gemini and Groq
   both fail

### Result

All test queries now return clean, direct answers with citations:

```
Cloudflare, Inc. is an American technology company headquartered in
San Francisco, California, that provides a range of internet services [1].
The company focuses on improving its operating margin through cost
reductions in sales, marketing, R&D, and administration [2].

Sources:
[1] Cloudflare - https://en.wikipedia.org/wiki/Cloudflare
[2] Cloudflare, Inc. Research Report - https://www.thewolfofharcourtstreet.com/p/cloudflare-inc-research-report
```

No reasoning steps. No chain-of-thought. Just the answer.

---

## File references

- **LLM cascade implementation:** `server/worker/src/external_llm.ts`
- **handleSearch() integration:** `server/worker/src/index.ts` (~line 1421)
- **handleGeneral() integration:** `server/worker/src/index.ts` (~line 1447)
- **Env type (key declarations):** `server/worker/src/quota.ts` → `interface Env`
- **Model constants:** `server/worker/src/models.ts` (Cloudflare models only)
