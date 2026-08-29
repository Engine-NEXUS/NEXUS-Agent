# 01 — GitHub PR Analysis via Voice

**Branch:** prem224k
**Status:** Implemented and tested
**Date:** 2026-08-29

---

## Problem

The user wanted to say "analyse PR 5 in servx" and have NEXUS:
1. Fetch the PR from GitHub using stored OAuth credentials
2. Send the PR context (files, diffs, commits, reviews) to Cloudflare GLM-4.7-Flash
3. Return a senior-engineer code review
4. Show it in the sidebar (not speak the entire long response)
5. Speak only "Here is the analysis, sir"

## Implementation

### Worker side (`server/worker/src/index.ts`)

- `handleGitHubAnalyse()` (lines 555–664): Complete PR analysis pipeline
- `parsePRRequest()`: Extracts PR number and repo name from transcript
  - Supports: `PR 24`, `PR #24`, `pull request 24`, `in servx`, `of servx`, `from servx`
- `resolveRepo()`: Resolves short repo names (e.g. `servx`) against the user's
  authenticated GitHub repositories (queries up to 100 repos sorted by updated)
- `fetchPRContext()`: Fetches via GitHub REST API:
  - PR metadata
  - Changed files and diffs
  - Commits
  - Inline review comments
  - Review summaries

### Model selection

- **Default:** `@cf/zai-org/glm-4.7-flash` (fast, normal context)
- **Deep:** `@cf/zai-org/glm-5.3-flash` (re-evaluations or >520K char context)
- **Summary models:** `@cf/mistral/mistral-small-3.1-24b-instruct`, `@cf/meta/llama-3.2-3b-instruct`

### Review prompt

The prompt sent to GLM covers:
1. Summary
2. Risk Assessment
3. Code Quality
4. Suggestions
5. Verdict
6. File names and line numbers
7. Edge cases
8. Error handling
9. Test coverage gaps
10. Security implications

### Client side (`frontend/src/net/wsBridge.ts`)

- `shouldShowSidebar()`: Decides whether a response warrants the sidebar
  - Gate 1: Response length >= 80 chars
  - Gate 2: Not a local-command verb (open/close/play)
  - Gate 3: Contains info/research intent keyword (analyse, review, PR, etc.)
- Result handler: If `showSidebar=true`, invokes `show_sidebar_with_content`
  IPC command and speaks only "Here is the analysis, sir"

### Rust side (`src-tauri/src/commands.rs`)

- `show_sidebar_with_content()`: Shows sidebar window AND directly injects
  content into the sidebar WebView DOM via `eval()` (more reliable than
  cross-window Tauri events)

### Intent classifier enhancement

Added `PR <number>` + `in/of/from <something>` pattern → `github_analyse`
even without the "analyse" keyword. This handles STT mishearing "analyse"
as "unless":

```typescript
if (/\bpr\s*#?\s*\d+\b/.test(t) && /\b(in|of|from)\b/.test(t)) {
  return "github_analyse";
}
```

## Testing Results

| Test | Result |
|---|---|
| `analyse PR 1 in servx` | 5,184-char analysis |
| `analyse PR 5 in servx` | 12,817-char analysis |
| `analyse the PR in servx` (no number) | 12,515-char analysis (latest PR) |
| Invalid PR | Useful not-found error |
| Voice test | Full flow works end-to-end |

## Files Changed

- `server/worker/src/index.ts` — PR analysis pipeline, fuzzy matching, intent classifier
- `frontend/src/net/wsBridge.ts` — Sidebar result handler
- `src-tauri/src/commands.rs` — show_sidebar_with_content IPC command
- `src-tauri/src/network.rs` — HTTP timeout fix, error logging
- `src-tauri/src/lib.rs` — Command registration
