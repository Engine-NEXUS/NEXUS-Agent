/**
 * Model constants, routing table, and fallback chains.
 *
 * Default models are chosen for cost efficiency. Deep analysis uses
 * glm-5.3-flash (available on Workers Paid). Fallbacks cascade to
 * cheaper models on error or rate limit.
 */

// ---- Model IDs ----

export const INTENT_MODEL = "@cf/meta/llama-3.2-1b-instruct";
export const SUMMARY_MODEL = "@cf/mistral/mistral-small-3.1-24b-instruct";
export const SMALL_SUMMARY_MODEL = "@cf/meta/llama-3.2-3b-instruct";
export const ANALYSIS_MODEL = "@cf/zai-org/glm-4.7-flash";
export const DEEP_ANALYSIS_MODEL = "@cf/zai-org/glm-5.3-flash";
export const CHEAP_FALLBACK_MODEL = "@cf/meta/llama-3.2-1b-instruct";

// Context threshold: if PR context exceeds this, use deep model
export const FLASH_CONTEXT_LIMIT_CHARS = 520000;
// Hard limit for truncation (approaching 1M tokens)
export const TRUNCATE_LIMIT_CHARS = 4000000; // ~1M tokens, leave headroom

// ---- Fallback chains (try in order, first success wins) ----

export const ANALYSIS_FALLBACK_CHAIN = [
  ANALYSIS_MODEL,        // glm-4.7-flash (default, cheap)
  SUMMARY_MODEL,         // mistral-small (if GLM unavailable)
  SMALL_SUMMARY_MODEL,   // llama-3.2-3b (last resort)
];

export const DEEP_ANALYSIS_FALLBACK_CHAIN = [
  DEEP_ANALYSIS_MODEL,   // glm-5.3-flash (deep, Paid)
  ANALYSIS_MODEL,        // glm-4.7-flash (truncate + retry)
  SUMMARY_MODEL,         // mistral-small (last resort)
];

export const SUMMARY_FALLBACK_CHAIN = [
  SUMMARY_MODEL,         // mistral-small (default)
  SMALL_SUMMARY_MODEL,   // llama-3.2-3b (fallback)
];

export const SEARCH_SYNTHESIS_FALLBACK_CHAIN = [
  SMALL_SUMMARY_MODEL,   // llama-3.2-3b (direct, no CoT, fast)
  ANALYSIS_MODEL,        // glm-4.7-flash (fallback)
  SUMMARY_MODEL,         // mistral-small (last resort — may show reasoning)
];

// ---- Model selection logic ----

export function selectAnalysisModel(contextLength: number, isReEval: boolean): {
  chain: string[];
  isDeep: boolean;
  maxTokens: number;
} {
  const contextTooLarge = contextLength > FLASH_CONTEXT_LIMIT_CHARS;
  const useDeep = isReEval || contextTooLarge;

  if (useDeep) {
    return {
      chain: DEEP_ANALYSIS_FALLBACK_CHAIN,
      isDeep: true,
      maxTokens: 2500,
    };
  }

  return {
    chain: ANALYSIS_FALLBACK_CHAIN,
    isDeep: false,
    maxTokens: 3000,
  };
}

export function selectSearchModel(): string[] {
  return SEARCH_SYNTHESIS_FALLBACK_CHAIN;
}

export function selectSummaryModel(): string[] {
  return SUMMARY_FALLBACK_CHAIN;
}

// ---- Truncation helper ----

export function truncateContext(context: string, limit: number = TRUNCATE_LIMIT_CHARS): string {
  if (context.length <= limit) return context;
  // Keep the beginning and end, truncate the middle
  const headLen = Math.floor(limit * 0.6);
  const tailLen = limit - headLen - 20;
  return context.slice(0, headLen) + "\n\n[... truncated for length ...]\n\n" + context.slice(-tailLen);
}
