/**
 * Result cleaning, source deduplication, and structured-output validation.
 */

import type { SearchResult } from "./research";

/**
 * Normalize a URL for deduplication (strip tracking params, lowercase host).
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip common tracking params
    const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"];
    trackingParams.forEach(p => u.searchParams.delete(p));
    return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname}${u.search}`;
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Deduplicate search results by normalized URL.
 */
export function dedupeSources(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = normalizeUrl(r.url);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/**
 * Strip prompt-injection patterns from retrieved text.
 * Removes common injection patterns while preserving content.
 */
export function stripInjection(text: string): string {
  return text
    // Remove "ignore previous instructions" patterns
    .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, "[filtered]")
    // Remove "you are now" role-injection patterns
    .replace(/you\s+are\s+now\s+(a|an)\s+\w+/gi, "[filtered]")
    // Remove "system:" prefix injections
    .replace(/^(system|assistant|admin)\s*:/gim, "[filtered]:")
    // Remove escaped instruction patterns
    .replace(/\\n\s*(system|assistant)\s*:/gi, "[filtered]");
}

/**
 * Validate a structured analysis result. Returns the result if valid,
 * or null if the JSON is malformed.
 */
export function validateAnalysisResult(raw: any): any | null {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.summary !== "string") return null;
  if (!Array.isArray(raw.risks)) return null;
  // Don't reject missing sources — some analyses don't have external sources
  return raw;
}

/**
 * Extract caveats (ungrounded statements) from model output.
 * Lines starting with "Note:" are moved to a separate caveats array.
 */
export function extractCaveats(text: string): { text: string; caveats: string[] } {
  const lines = text.split("\n");
  const clean: string[] = [];
  const caveats: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^note\s*:/i.test(trimmed)) {
      caveats.push(trimmed.replace(/^note\s*:\s*/i, ""));
    } else {
      clean.push(line);
    }
  }

  return {
    text: clean.join("\n").trim(),
    caveats,
  };
}

/**
 * Build the final response envelope with provenance.
 */
export function buildResponse(
  reply: string,
  options: {
    analysis?: any;
    sources?: SearchResult[];
    caveats?: string[];
    cacheHit?: boolean;
    quotaRemaining?: any;
    model?: string;
  } = {}
): any {
  return {
    reply,
    analysis: options.analysis || null,
    sources: options.sources || [],
    caveats: options.caveats || [],
    cache_hit: options.cacheHit || false,
    quota_remaining: options.quotaRemaining || null,
    model: options.model || null,
    timestamp: new Date().toISOString(),
  };
}
