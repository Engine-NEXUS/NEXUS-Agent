# PR & Branch Query Commands — Research, Plan & Implementation

**Date:** 2026-09-03
**Status:** Planning → Implementation

---

## Problem Statement

The user wants three new voice command patterns:

1. **"analyse the pr in zync"** → Fetch the LATEST PR in the zync repo (no PR number needed)
2. **"analyse the pr of prem in servx"** → Fetch the latest PR by author "prem" in the servx repo
3. **"check the latest branch of servx created by eesha"** → Check the latest branch created by user "eesha" in the servx repo

---

## Current Parser Test Results

### What Happens Now (ALL BROKEN)

| User Says | Current Output | Correct? |
|-----------|---------------|----------|
| `analyse the pr in zync` | `AnalyseRepo { repo: "pr in zync" }` | ❌ Treats "pr in zync" as repo name |
| `analyse the pr of prem in servx` | `AnalyseRepo { repo: "pr of prem in servx" }` | ❌ Treats everything as repo name |
| `check the latest branch of servx created by eesha` | `None` | ❌ No branch intent exists |
| `analyse latest pr in zync` | `AnalyseRepo { repo: "latest pr in zync" }` | ❌ Same issue |
| `analyse pr by prem in servx` | `AnalyseRepo { repo: "pr by prem in servx" }` | ❌ Same issue |
| `show the latest branch of servx by eesha` | `OpenApp { target: "latest branch..." }` | ❌ Treats as app name |
| `what is the latest branch by eesha in servx` | `None` | ❌ No match |

### Root Cause
1. **No "latest PR" concept** — the parser only handles `PR <number>`, not `PR` without a number
2. **No author filter** — the parser has no concept of "by <author>" or "of <author>"
3. **No branch intent** — there's no `CheckBranch` intent at all
4. **Fallback catches everything** — "analyse <text>" falls through to Pattern 4 (treat remaining text as repo name), so "the pr in zync" becomes the repo name

---

## Word Variation Analysis

### Pattern 1: Latest PR (no number, no author)

**Intent:** Fetch the most recent PR in a repo (top of the list, any state)

| Variation | Natural? | STT Risk | Priority |
|-----------|----------|----------|----------|
| `analyse the pr in zync` | ✅ Very natural | Low | P0 (user's exact words) |
| `analyse the latest pr in zync` | ✅ Very natural | Low | P0 |
| `analyse latest pr zync` | ✅ Natural | Low | P0 |
| `analyse pr in zync` | ✅ Natural | Low | P0 |
| `analyse newest pr in zync` | ⚠️ Less common | Low | P1 |
| `analyse the pull request in zync` | ✅ Formal | Medium ("pull request" → "pool request") | P1 |
| `analyse latest pull request in zync` | ✅ Formal | Medium | P1 |
| `analyse the pr of zync` | ⚠️ Ambiguous ("of" could mean author) | Low | P2 |
| `analyse pr of zync` | ⚠️ Same ambiguity | Low | P2 |
| `analyse recent pr in zync` | ✅ Natural | Low | P1 |
| `analyse the current pr in zync` | ⚠️ "current" is ambiguous | Low | P2 |
| `analyse open pr in zync` | ✅ Natural (open PRs only) | Low | P1 |
| `analyse first pr in zync` | ⚠️ "first" could mean #1 | Low | P2 |
| `analyse top pr in zync` | ⚠️ Unusual phrasing | Low | P2 |

**Best variations to support (P0):**
- `analyse [the] pr in <repo>`
- `analyse [the] latest pr in <repo>`
- `analyse latest pr <repo>` (no preposition)
- `analyse [the] pr of <repo>` (when "of" is followed by a known repo, not a person name)

### Pattern 2: Latest PR by Author

**Intent:** Fetch the most recent PR by a specific author in a repo

| Variation | Natural? | STT Risk | Priority |
|-----------|----------|----------|----------|
| `analyse the pr of prem in servx` | ✅ User's exact words | Low | P0 |
| `analyse the pr by prem in servx` | ✅ Very natural | Low | P0 |
| `analyse pr by prem in servx` | ✅ Natural | Low | P0 |
| `analyse pr of prem in servx` | ✅ Natural | Low | P0 |
| `analyse latest pr by prem in servx` | ✅ Natural | Low | P0 |
| `analyse the latest pr by prem in servx` | ✅ Natural | Low | P0 |
| `analyse prem pr in servx` | ⚠️ Ambiguous (is "prem" a repo?) | Low | P1 |
| `analyse prem's pr in servx` | ⚠️ Possessive may be misheard | High ("prem's" → "prems") | P2 |
| `analyse the pull request by prem in servx` | ✅ Formal | Medium | P1 |
| `analyse the pull request of prem in servx` | ✅ Formal | Medium | P1 |
| `analyse pr from prem in servx` | ✅ Natural | Low | P0 |
| `analyse latest pr from prem in servx` | ✅ Natural | Low | P0 |

**Best variations to support (P0):**
- `analyse [the] pr [of|by|from] <author> in <repo>`
- `analyse [the] latest pr [of|by|from] <author> in <repo>`
- `analyse [the] [latest] pull request [of|by|from] <author> in <repo>`

### Pattern 3: Branch by Author

**Intent:** Check the latest branch created by a specific user in a repo

| Variation | Natural? | STT Risk | Priority |
|-----------|----------|----------|----------|
| `check the latest branch of servx created by eesha` | ✅ User's exact words | Low | P0 |
| `check the latest branch in servx created by eesha` | ✅ Natural | Low | P0 |
| `check latest branch of servx by eesha` | ✅ Natural | Low | P0 |
| `check branch of servx by eesha` | ✅ Natural | Low | P0 |
| `check the branch of servx created by eesha` | ✅ Natural | Low | P0 |
| `check the latest branch of servx by eesha` | ✅ Natural | Low | P0 |
| `check branches of servx by eesha` | ✅ Plural form | Low | P1 |
| `check the newest branch of servx created by eesha` | ⚠️ "newest" less common | Low | P1 |
| `check the recent branch of servx created by eesha` | ⚠️ "recent" = could be multiple | Low | P1 |
| `check the latest branch in servx by eesha` | ✅ Natural | Low | P0 |
| `check the latest branch from eesha in servx` | ⚠️ "from" for branch is unusual | Low | P2 |
| `check the latest branch by eesha in servx` | ✅ Natural | Low | P0 |
| `check eesha's latest branch in servx` | ⚠️ Possessive | High | P2 |
| `check eesha branch in servx` | ⚠️ Missing "latest" | Low | P1 |
| `check the latest branch of servx from eesha` | ⚠️ "from" unusual | Low | P2 |
| `show the latest branch of servx created by eesha` | ✅ "show" instead of "check" | Low | P0 |
| `show latest branch of servx by eesha` | ✅ Natural | Low | P0 |
| `what is the latest branch of servx created by eesha` | ✅ Question form | Low | P1 |
| `what is the latest branch by eesha in servx` | ✅ Question form | Low | P1 |

**Best variations to support (P0):**
- `check [the] [latest|recent|newest] branch [of|in] <repo> [created] [by] <author>`
- `check [the] [latest|recent|newest] branch [by] <author> [in|of] <repo>`
- `show [the] [latest|recent|newest] branch [of|in] <repo> [created] [by] <author>`
- `what is [the] [latest|recent|newest] branch [of|in] <repo> [created] [by] <author>`

---

## Implementation Plan

### Step 1: New Intent Types (Rust)

```rust
// Add to ParsedIntent enum:

/// Analyse the latest PR in a repo, optionally filtered by author.
/// "analyse the pr in zync" → AnalyseLatestPr { repo: "zync", author: None }
/// "analyse the pr by prem in servx" → AnalyseLatestPr { repo: "servx", author: Some("prem") }
#[serde(rename = "analyse_latest_pr")]
AnalyseLatestPr {
    owner: Option<String>,
    repo: String,
    author: Option<String>,
},

/// Check the latest branch in a repo, optionally filtered by author.
/// "check the latest branch of servx created by eesha"
///   → CheckBranch { repo: "servx", author: Some("eesha") }
#[serde(rename = "check_branch")]
CheckBranch {
    owner: Option<String>,
    repo: String,
    author: Option<String>,
},
```

### Step 2: New Parsing Functions (Rust)

#### `parse_latest_pr_analyse(text)` — Detect "PR" without a number

Patterns to match (in priority order):
1. `the pr [of|by|from] <author> in <repo>` → author + repo
2. `the pr in <repo>` → repo only
3. `the latest pr [of|by|from] <author> in <repo>` → author + repo
4. `the latest pr in <repo>` → repo only
5. `latest pr [of|by|from] <author> in <repo>` → author + repo
6. `latest pr in <repo>` → repo only
7. `the pr of <repo>` → repo only (when "of" is followed by a known repo)
8. `the pull request [of|by|from] <author> in <repo>` → author + repo
9. `the pull request in <repo>` → repo only

#### `parse_branch_command(text)` — Detect "check branch" commands

Patterns to match:
1. `check [the] [latest|recent|newest] branch [of|in] <repo> [created] [by] <author>`
2. `check [the] [latest|recent|newest] branch [by] <author> [in|of] <repo>`
3. `show [the] [latest|recent|newest] branch [of|in] <repo> [created] [by] <author>`
4. `what is [the] [latest|recent|newest] branch [of|in] <repo> [created] [by] <author>`

### Step 3: Worker Updates (TypeScript)

#### Latest PR (no number)
```typescript
// When prNumber is null, fetch the latest PR
if (prNumber === null && repoName) {
    const resp = await fetch(
        `https://api.github.com/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=10`,
        { headers }
    );
    const prs = await resp.json();
    // If author filter, find first PR by that author
    let pr = prs[0];
    if (author) {
        pr = prs.find(p => p.user.login.toLowerCase() === author.toLowerCase());
    }
    // Use pr.number to fetch full context
}
```

#### Branch by Author
```typescript
// Fetch branches and filter by author
async function checkBranch(token: string, repo: string, author: string | null) {
    // GitHub API: GET /repos/{owner}/{repo}/branches
    // Note: GitHub doesn't directly support filtering branches by author.
    // We need to:
    // 1. List branches: GET /repos/{repo}/branches?per_page=100
    // 2. For each branch, GET /repos/{repo}/branches/{branch} to get the last commit
    // 3. Filter by commit.author.login
    // 4. Sort by commit.committer.date
    // 5. Return the latest one

    // Alternative: Use GitHub Search API
    // GET /search/commits?q=repo:{repo}+author:{author}&sort=committer-date&order=desc
    // This returns commits, from which we can extract branch names
}
```

### Step 4: Frontend Updates

The frontend `recorder.ts` needs to handle the new intents:
- `AnalyseLatestPr` → send to Worker with `action: "analyse_latest_pr"`
- `CheckBranch` → send to Worker with `action: "check_branch"`

### Step 5: Tests

Write tests for ALL variations listed above to ensure 100% coverage.

---

## Disambiguation Rules

### "of" — Author vs Repo

"analyse the pr **of** prem in servx" — "of" → author (prem is a person)
"analyse the pr **of** zync" — "of" → repo (zync is a known repo)

**Rule:** If the word after "of" is in `KNOWN_REPOS`, treat it as a repo.
Otherwise, treat it as an author and look for "in <repo>" later.

### "in" — Repo vs Other

"analyse the pr in zync" — "in" → repo (zync)
"check the latest branch in servx created by eesha" — "in" → repo (servx)

**Rule:** "in" always introduces a repo name.

### "by" vs "created by"

"check the latest branch **by** eesha" — "by" → author
"check the latest branch **created by** eesha" — "created by" → author

**Rule:** Both "by" and "created by" introduce an author. "created by" is
two words, so we strip "created" first.

### Author vs Repo Name Disambiguation

"analyse prem pr in servx" — Is "prem" an author or a repo?

**Rule:** If the pattern is `<word> pr in <repo>`, treat `<word>` as author.
If the pattern is `pr in <repo>`, there's no author.

---

## GitHub API Endpoints Needed

### Latest PR
```
GET /repos/{owner}/{repo}/pulls?state=all&sort=created&direction=desc&per_page=10
```
Returns PRs sorted by creation date (newest first). Take the first one.
If author filter: iterate until `pr.user.login` matches.

### PR by Author (Alternative: Search API)
```
GET /search/issues?q=repo:{owner}/{repo}+is:pr+author:{username}&sort=created&order=desc&per_page=1
```
More efficient — GitHub filters by author server-side.

### Branch by Author
GitHub doesn't have a direct "branches by author" API. Two approaches:

**Approach A: List branches + fetch last commit for each**
```
GET /repos/{owner}/{repo}/branches?per_page=100
→ For each branch: GET /repos/{owner}/{repo}/branches/{branch}
→ Check last commit's author
→ Filter and sort by date
```
**Pros:** Accurate, uses standard API
**Cons:** Many API calls (1 + N where N = branch count)

**Approach B: Search commits API**
```
GET /search/commits?q=repo:{owner}/{repo}+author:{username}&sort=committer-date&order=desc&per_page=5
```
**Pros:** Single API call, server-side filtering
**Cons:** Returns commits, not branches. Need to extract branch names from commit SHA.

**Approach C: List branches + commit SHA lookup**
```
GET /repos/{owner}/{repo}/branches?per_page=100
→ Filter by branch name pattern (if author name is in branch name, e.g. "eesha/feature-x")
```
**Pros:** Single API call
**Cons:** Only works if branches follow naming convention (author/branch-name)

**Recommended: Approach B** (Search commits) — most efficient, single API call.

---

## Implementation Order

1. ✅ Write tests for current behavior (done — all fail as expected)
2. Add new intent types to `ParsedIntent` enum
3. Implement `parse_latest_pr_analyse()` in `intent_parser.rs`
4. Implement `parse_branch_command()` in `intent_parser.rs`
5. Wire new patterns into `parse_analyse_command()` and `parse_deterministic()`
6. Run tests — all variations should now parse correctly
7. Update Worker to handle `AnalyseLatestPr` and `CheckBranch` intents
8. Update frontend to send new intents to Worker
9. Test end-to-end with actual GitHub repos
10. Document in `docs/features/44-pr-branch-query-commands.md`
