/**
 * External LLM providers for research synthesis.
 *
 * Cascade: Gemini (1,500/day) → Groq (14,400/day) → Cloudflare Workers AI (~200/day)
 *
 * Gemini and Groq are called via their public REST APIs.
 * Both are free, no card required, and don't leak reasoning steps.
 */

import type { Env } from "./quota";

// ---- Model IDs ----

// Gemini: flash-lite-latest is non-reasoning (doesn't waste tokens on CoT)
const GEMINI_MODEL = "gemini-flash-lite-latest";
// Groq: qwen3.8-27b is fast, direct, no reasoning leakage
const GROQ_MODEL = "qwen/qwen3.8-27b";

// ---- Types ----

export interface LLMResponse {
  text: string;
  provider: "gemini" | "groq" | "cloudflare";
  model: string;
}

// ---- Gemini (Google AI Studio) ----

export async function callGemini(
  prompt: string,
  env: Env,
  systemPrompt: string = "",
  maxTokens: number = 500,
): Promise<LLMResponse | null> {
  if (!env.GEMINI_API_KEY) return null;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;

  try {
    const body: any = {
      contents: [
        {
          role: "user",
          parts: [{ text: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt }],
        },
      ],
      generationConfig: {
        // Gemini flash-lite may use some thinking tokens, so give extra headroom
        maxOutputTokens: maxTokens + 200,
        temperature: 0.3,
      },
    };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || text.trim() === "") return null;

    return { text: text.trim(), provider: "gemini", model: GEMINI_MODEL };
  } catch {
    return null;
  }
}

// ---- Groq (Llama 3.3 70B) ----

export async function callGroq(
  prompt: string,
  env: Env,
  systemPrompt: string = "",
  maxTokens: number = 500,
): Promise<LLMResponse | null> {
  if (!env.GROQ_API_KEY) return null;

  const url = "https://api.groq.com/openai/v1/chat/completions";

  try {
    const messages: any[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as any;

    const text = data?.choices?.[0]?.message?.content;
    if (!text || text.trim() === "") return null;

    return { text: text.trim(), provider: "groq", model: GROQ_MODEL };
  } catch {
    return null;
  }
}

// ---- Cloudflare Workers AI (fallback) ----

export async function callCloudflare(
  prompt: string,
  env: Env,
  systemPrompt: string = "",
  maxTokens: number = 500,
): Promise<LLMResponse | null> {
  const model = "@cf/meta/llama-3.2-3b-instruct";

  try {
    const messages: any[] = [];
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await env.AI.run(model as any, {
      messages,
      max_tokens: maxTokens,
    });

    const text = (response as any)?.response || "";
    if (!text || text.trim() === "") return null;

    return { text: text.trim(), provider: "cloudflare", model };
  } catch {
    return null;
  }
}

// ---- Cascade: Gemini → Groq → Cloudflare ----

/**
 * Synthesize an answer using the LLM cascade.
 * Tries Gemini first (highest free quota), then Groq (fastest),
 * then Cloudflare Workers AI (last resort).
 *
 * @param prompt The full prompt with sources
 * @param env Worker env with API keys
 * @param systemPrompt Optional system prompt
 * @param maxTokens Max output tokens
 * @returns LLMResponse or null if all providers fail
 */
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
