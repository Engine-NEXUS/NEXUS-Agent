# 05 — Worker Fuzzy Repo Name Matching

**Branch:** prem224k
**Status:** Implemented and tested
**Date:** 2026-08-29

---

## Problem

STT mishears repo names ("servx" → "service", "cervix"). The Worker's
`resolveRepo()` only did exact and substring matching, so fuzzy mishearings
returned "repository not found".

## Implementation

### Worker (`server/worker/src/index.ts` — `resolveRepo()`)

Three-tier matching strategy:

#### Tier 1: Exact match (case-insensitive)
```typescript
const exact = repos.find(r => (r["name"] as string)?.toLowerCase() === target);
if (exact) return exact["full_name"] as string;
```

#### Tier 2: Substring match (either direction)
```typescript
const partial = repos.find(r => {
  const name = (r["name"] as string)?.toLowerCase();
  return name && (name.includes(target) || target.includes(name));
});
if (partial) return partial["full_name"] as string;
```

#### Tier 3: Fuzzy match (Levenshtein distance)
```typescript
for (const repoName_ of repoNames) {
  const candidate = repoName_.toLowerCase();
  // Skip repos too different in length
  if (Math.abs(candidate.length - target.length) > Math.max(3, target.length)) continue;

  const dist = levenshtein(target, candidate);
  const score = dist / Math.max(target.length, candidate.length);

  // Prefix bonus: if first 3 chars match, reduce effective score
  const prefixMatch = target.substring(0, 3) === candidate.substring(0, 3);
  const adjustedScore = prefixMatch ? score * 0.5 : score;

  // Accept if normalised distance < 0.6 (>40% of chars match)
  if (adjustedScore < 0.6 && adjustedScore < bestScore) {
    bestScore = adjustedScore;
    bestMatch = repoName_;
  }
}
```

### Levenshtein distance function

Standard dynamic programming implementation:

```typescript
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }
  return dp[m][n];
}
```

## Testing Results

| Input | Matched to | Method | Result |
|---|---|---|---|
| "servx" | servx | Exact | Full analysis |
| "service" | servx | Fuzzy (prefix bonus) | 4,162-char analysis |
| "weeks" | — | No match | Expected (too different: 4/5 chars differ) |
| "NEXUS-Agent" | NEXUS-Agent | Exact | Full analysis |

## Why prefix bonus?

"servx" and "service" share the prefix "ser". Without the prefix bonus,
the Levenshtein distance is 3 (v→i, x→c, +e) out of max length 7, giving
a score of 0.43 — which would pass the 0.6 threshold anyway. But with
the prefix bonus, the score becomes 0.21, making it a strong match.

"servx" and "weeks" share no prefix. The distance is 4 out of 5, giving
a score of 0.8 — correctly rejected.

## Files Changed

- `server/worker/src/index.ts` — resolveRepo() with fuzzy matching, levenshtein() function
