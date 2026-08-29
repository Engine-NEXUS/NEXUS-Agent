# Feature 25 — Rich Repository Analysis Dashboard

> Status: **PLANNING** — awaiting user cross-check before implementation

## User Requirements

1. Use a **free unlimited model** (not GLM-5.2 which requires Workers Paid $5/mo)
2. **Remove the text input bar** — this is analysis, not chat
3. **More information** — not just 5 lines. Need:
   - Frameworks used
   - Languages used (with percentages)
   - Databases used
   - Features
   - Tests
4. **Pie charts** (like GitHub):
   - One pie chart for languages
   - One pie chart for frameworks
5. **Top bar changes**:
   - Remove the "X" close button
   - Keep the speaker button
   - Add a heading showing the command (e.g. "analyse zync" → "Analysis: zync-meet/Zync")
6. One-time view (not a chat)

---

## 1. Model Selection — Free Unlimited

### Problem
- `@cf/zai-org/glm-5.2` — **requires Workers Paid plan** ($5/month). Returns 403 on Free plan.
- `@cf/zai-org/glm-5.3` and `@cf/zai-org/glm-5.3-flash` — also require Paid plan.
- Current fast analysis uses `SUMMARY_MODEL = @cf/mistral/mistral-small-3.1-24b-instruct` which is free but gives only 5-line summaries.

### Solution: `@cf/zai-org/glm-4.7-flash`
- **FREE** on Workers Free plan (no paid plan required)
- 131,072 token context window (131K — enough for repo analysis)
- Function calling: Yes
- Reasoning: Yes
- Pricing: 5,500 neurons/M input, 36,400 neurons/M output
- Free allocation: 10,000 neurons/day → ~275K input tokens or ~42K output tokens per day
- That's ~50-100 repo analyses per day on the free tier

### Why not other free models?
| Model | Free? | Issue |
|-------|-------|-------|
| `@cf/meta/llama-3.2-3b-instruct` | Yes | Too small (3B), poor quality summaries |
| `@cf/meta/llama-3.2-1b-instruct` | Yes | Intent classification only, not analysis |
| `@cf/mistral/mistral-small-3.1-24b-instruct` | Yes | Current model, gives 5-line summaries |
| `@cf/google/gemma-4-26b-a4b-it` | Yes | Good but less coding-focused than GLM |
| `@cf/nvidia/nemotron-3-120b-a12b` | Yes | Large but slower |
| **`@cf/zai-org/glm-4.7-flash`** | **Yes** | **Best choice — coding-focused, 131K context, reasoning, function calling** |

### Change in Worker
```typescript
// CURRENT (gives 5-line summaries):
const SUMMARY_MODEL = "@cf/mistral/mistral-small-3.1-24b-instruct";

// NEW (rich analysis, free, 131K context):
const REPO_ANALYSIS_MODEL = "@cf/zai-org/glm-4.7-flash";
```

---

## 2. GitHub API Data Sources

### Currently fetched
- Repo metadata (description, stars, forks, language, default branch)
- File tree (recursive)
- Key file contents (README, package.json, Cargo.toml, etc.)

### NEW: Also fetch

| API Endpoint | Purpose | Data |
|-------------|---------|------|
| `GET /repos/{owner}/{repo}/languages` | **Language pie chart** | Byte counts per language (e.g. `{TypeScript: 45000, CSS: 12000, HTML: 5000}`) |
| `GET /repos/{owner}/{repo}/topics` | **Features/tags** | Repository topics (e.g. `["react", "ai", "collaboration"]`) |
| `GET /repos/{owner}/{repo}/stats/contributors` | **Contributor count** | Number of contributors |
| `GET /repos/{owner}/{repo}/stats/code_frequency` | **Activity** | Code additions/deletions over time |

### Language pie chart data
GitHub's `/languages` endpoint returns byte counts:
```json
{
  "TypeScript": 45000,
  "CSS": 12000,
  "HTML": 5000,
  "JavaScript": 3000
}
```
Convert to percentages:
```
TypeScript: 70.3%
CSS: 18.8%
HTML: 7.8%
JavaScript: 4.7%
```

### Framework pie chart data
Detected from `package.json`, `Cargo.toml`, `pyproject.toml`, etc.:
- Parse dependencies and categorize as frameworks, libraries, dev tools, databases
- Weight by presence in file tree (e.g. `next/` directory → Next.js, `src/components/` → React)

### Database detection
Scan key files for database indicators:
- `package.json`: `mongoose`, `pg`, `mysql2`, `redis`, `prisma`, `drizzle-orm`, `sequelize`
- `Cargo.toml`: `diesel`, `sqlx`, `sea-orm`, `redis`
- `pyproject.toml`: `sqlalchemy`, `psycopg2`, `pymongo`, `redis`
- `go.mod`: `gorm`, `pgx`, `redis/go`
- File tree: `prisma/schema.prisma`, `migrations/`, `docker-compose.yml` (with postgres/mysql/redis services)

---

## 3. Worker Response Format

### Current: plain text (5 lines)
```
Ok sir, zync-meet/Zync is a TypeScript repository (public repository). Zync is a modern...
```

### NEW: structured JSON + markdown for the sidebar

The Worker returns a JSON object with both spoken text and structured data:

```json
{
  "reply_text": "Ok sir, zync-meet/Zync is a TypeScript repository with 623 files. Built with React and Vite, it uses MongoDB and Redis for data storage. The project has tests, CI/CD via GitHub Actions, and Docker support. Key features include real-time messaging, presence tracking, and project planning tools.",
  "intent": "fast_analyse",
  "analysis": {
    "repo": "zync-meet/Zync",
    "visibility": "public",
    "description": "Zync is a modern, AI-powered collaboration platform...",
    "stars": 42,
    "forks": 8,
    "totalFiles": 623,
    "languages": [
      { "name": "TypeScript", "bytes": 45000, "percentage": 70.3 },
      { "name": "CSS", "bytes": 12000, "percentage": 18.8 },
      { "name": "HTML", "bytes": 5000, "percentage": 7.8 },
      { "name": "JavaScript", "bytes": 3000, "percentage": 4.7 }
    ],
    "frameworks": [
      { "name": "React", "category": "frontend", "confidence": "high" },
      { "name": "Vite", "category": "build-tool", "confidence": "high" },
      { "name": "Express", "category": "backend", "confidence": "medium" }
    ],
    "databases": [
      { "name": "MongoDB", "evidence": "mongoose in package.json" },
      { "name": "Redis", "evidence": "redis in package.json + docker-compose.yml" }
    ],
    "features": [
      "Real-time messaging",
      "Presence tracking",
      "Project planning tools",
      "AI-powered collaboration",
      "Responsive interface"
    ],
    "tests": true,
    "ci": "GitHub Actions",
    "docker": true,
    "contributors": 5,
    "topics": ["react", "ai", "collaboration", "productivity"],
    "architecture": "Frontend (React/Vite) + Backend (Express) + Database (MongoDB/Redis)"
  }
}
```

### How the Worker builds this

1. **Fetch all data in parallel** (metadata, languages, tree, key files, topics)
2. **Detect frameworks** from package.json/Cargo.toml/pyproject.toml dependencies
3. **Detect databases** from dependencies + file tree patterns
4. **Extract features** from README.md headings + topics
5. **Send to GLM-4.7-flash** with a structured prompt asking for JSON output
6. **Merge** LLM analysis with heuristic data
7. **Return** both `reply_text` (for voice) and `analysis` (for sidebar)

---

## 4. Sidebar UI Redesign

### 4.1 Top Bar Changes

**Current:**
```
[Speaker] [X]
```

**NEW:**
```
[Speaker]  Analysis: zync-meet/Zync
```

- Remove the "X" close button (close via Esc or Ctrl+Shift+Space hotkey only)
- Keep the speaker button (Read Aloud TTS)
- Add a **heading** showing the formatted command:
  - `analyse zync` → `Analysis: zync-meet/Zync`
  - `analyse PR 24 in servx` → `Analysis: PR #24 in servx-lab/ServX`
  - `analyse tauri-apps/tauri` → `Analysis: tauri-apps/tauri`

### 4.2 Remove Text Input Bar

Remove the text input bar I just added. This is a one-time analysis view, not a chat.

### 4.3 Remove "PROMPT" Query Banner

Remove the collapsible "PROMPT" card that shows the raw command. The heading in the top bar replaces it.

### 4.4 New Content Layout

```
┌─────────────────────────────────────────────────┐
│ [🔊]  Analysis: zync-meet/Zync                   │  ← Top bar (no X)
├─────────────────────────────────────────────────┤
│                                                  │
│  📦 Overview                                     │
│  ┌───────────────────────────────────────────┐  │
│  │ Public • 42 stars • 8 forks • 623 files   │  │
│  │ 5 contributors                            │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  📝 Description                                  │
│  Zync is a modern, AI-powered collaboration      │
│  platform designed to streamline team            │
│  communication and project management.           │
│                                                  │
│  🏗️ Languages                          📊        │
│  ┌─────────────────────┐  ┌──────────────────┐  │
│  │                     │  │ TypeScript  70.3% │  │
│  │    [PIE CHART]      │  │ CSS         18.8% │  │
│  │                     │  │ HTML         7.8% │  │
│  │                     │  │ JavaScript   4.7% │  │
│  └─────────────────────┘  └──────────────────┘  │
│                                                  │
│  ⚡ Frameworks & Tools                           │
│  ┌───────────────────────────────────────────┐  │
│  │ Frontend:  React, Vite                    │  │
│  │ Backend:   Express                        │  │
│  │ Build:     Vite                           │  │
│  │ Testing:   Jest, Testing Library          │  │
│  │ CI/CD:     GitHub Actions                 │  │
│  │ Deploy:    Docker, Docker Compose         │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  🗄️ Databases                                    │
│  ┌───────────────────────────────────────────┐  │
│  │ 🍃 MongoDB  (mongoose in package.json)    │  │
│  │ 🔴 Redis    (redis in docker-compose.yml) │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ✨ Features                                      │
│  ┌───────────────────────────────────────────┐  │
│  │ • Real-time messaging                     │  │
│  │ • Presence tracking                       │  │
│  │ • Project planning tools                  │  │
│  │ • AI-powered collaboration                │  │
│  │ • Responsive interface                    │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  🏗️ Architecture                                 │
│  Frontend (React/Vite) + Backend (Express) +     │
│  Database (MongoDB/Redis)                        │
│                                                  │
│  📊 Activity                                     │
│  ┌───────────────────────────────────────────┐  │
│  │ Tests: ✅ Yes    CI: ✅ GitHub Actions     │  │
│  │ Docker: ✅ Yes   Contributors: 5          │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
├─────────────────────────────────────────────────┤
│  Esc or Ctrl+Shift+Space to close                │  ← Footer
└─────────────────────────────────────────────────┘
```

### 4.5 Pie Chart Implementation

**Library: `react-minimal-pie-chart`**
- < 2kB gzipped
- No dependencies
- TypeScript support
- SVG-based (crisp at any resolution)
- CSS animations included

```bash
npm install react-minimal-pie-chart --prefix frontend
```

Usage:
```tsx
import { PieChart } from 'react-minimal-pie-chart';

<PieChart
  data={[
    { title: 'TypeScript', value: 70.3, color: '#3178c6' },
    { title: 'CSS', value: 18.8, color: '#1572b6' },
    { title: 'HTML', value: 7.8, color: '#e34c26' },
    { title: 'JavaScript', value: 4.7, color: '#f7df1e' },
  ]}
  lineWidth={60}
  rounded
  animate
  label={({ dataEntry }) => `${dataEntry.title} ${dataEntry.value}%`}
  labelStyle={{ fontSize: '5px', fill: '#fff' }}
/>
```

**Language colors** (matching GitHub):
```typescript
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  C: '#555555',
  'C++': '#f34b7d',
  C#: '#178600',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  HTML: '#e34c26',
  CSS: '#563d7c',
  SCSS: '#c6538c',
  Vue: '#41b883',
  Shell: '#89e051',
  Dockerfile: '#384d54',
  // fallback
  Other: '#8b8b8b',
};
```

---

## 5. Implementation Plan

### Phase 1: Worker — Rich Data Collection (server/worker/src/index.ts)

**Changes to `handleFastAnalyse()`:**

1. Add parallel fetch of:
   - `GET /repos/{owner}/{repo}/languages` → language byte counts
   - `GET /repos/{owner}/{repo}/topics` → repository topics
   - (Optional) `GET /repos/{owner}/{repo}/stats/contributors` → contributor count

2. Expand framework detection:
   - Parse ALL dependencies from package.json (not just 6)
   - Categorize: frontend, backend, build-tool, testing, database, devops
   - Detect from Cargo.toml, pyproject.toml, go.mod, requirements.txt

3. Add database detection:
   - Scan dependencies for ORM/database client libraries
   - Scan docker-compose.yml for database services
   - Scan file tree for migration files, schema files

4. Extract features from README:
   - Parse markdown headings (##, ###)
   - Extract bullet points from features/feature list sections
   - Use GitHub topics as additional feature tags

5. Switch to GLM-4.7-flash for analysis:
   - Send structured prompt with all collected data
   - Ask for JSON output with: architecture summary, feature list, concerns
   - Merge with heuristic data (languages, frameworks, databases)

6. Return structured response:
   ```json
   {
     "reply_text": "Ok sir, ...",
     "intent": "fast_analyse",
     "analysis": { ... structured data ... }
   }
   ```

### Phase 2: Frontend — Sidebar Dashboard (frontend/src/sidebar/)

**Changes to SidebarApp.tsx:**

1. Remove text input bar (revert the addition)
2. Remove "PROMPT" query banner
3. Redesign top bar:
   - Remove X close button
   - Keep speaker button
   - Add heading: `Analysis: {repo_name}` (formatted from command)
4. Add new `AnalysisDashboard` component that renders:
   - Overview card (visibility, stars, forks, files, contributors)
   - Description section
   - Languages pie chart + legend
   - Frameworks & tools card
   - Databases card
   - Features list
   - Architecture summary
   - Activity card (tests, CI, Docker)

**Changes to sidebarStore.ts:**
- Add `analysisData` field to store structured analysis data
- Add `setAnalysisData()` action

**New file: `frontend/src/sidebar/AnalysisDashboard.tsx`**
- Renders the structured analysis data
- Uses `react-minimal-pie-chart` for pie charts
- GitHub-style language colors

**New file: `frontend/src/sidebar/LanguageChart.tsx`**
- Reusable pie chart component for languages
- Takes `languages` array from analysis data
- Shows pie chart + color-coded legend with percentages

**Changes to sidebar.css:**
- Add styles for analysis dashboard cards
- Add styles for pie chart containers
- Add styles for feature list, database badges, framework tags

### Phase 3: Network Layer — Pass Structured Data

**Changes to network.rs:**
- The `send_transcript` command currently emits only `reply_text` as the result
- Need to also emit the `analysis` object if present
- The `ServerEvent::result()` should include the full JSON, not just text

**Changes to wsBridge.ts:**
- The result handler should check for `analysis` data
- If present, emit a `sidebar:analysis` event with the structured data
- The sidebar listens for this event and renders the dashboard

### Phase 4: Testing

1. Test `analyse zync` → verify pie charts + all sections appear
2. Test `analyse tauri-apps/tauri` → verify Rust/Cargo detection
3. Test `analyse ChitkulLakshya/GitGlance` → verify private repo access
4. Test with a repo that has no tests/CI → verify "Not found" indicators
5. Test voice output — `reply_text` should still be spoken
6. Verify GLM-4.7-flash stays within free tier (10K neurons/day)

---

## 6. Neuron Budget (Free Tier)

| Action | Model | Neurons per call | Calls per day (10K limit) |
|--------|-------|-----------------|--------------------------|
| Intent classification | llama-3.2-1b | ~50 | 200 |
| Repo analysis | glm-4.7-flash | ~2,000 (5K input + 36K output per M tokens; typical analysis ~5K input + 500 output tokens = ~450 neurons) | ~22 |
| PR analysis | glm-4.7-flash | ~450 | ~22 |
| Summary | mistral-small-3.1 | ~300 | ~33 |

**Estimated: ~20-30 repo/PR analyses per day on free tier.** More than enough for personal use.

---

## 7. Files to Modify

| File | Change |
|------|--------|
| `server/worker/src/index.ts` | Rewrite `handleFastAnalyse()` — fetch languages/topics, detect databases, use GLM-4.7-flash, return structured JSON |
| `frontend/src/sidebar/SidebarApp.tsx` | Remove text input, remove X button, add heading, render AnalysisDashboard |
| `frontend/src/sidebar/sidebarStore.ts` | Add `analysisData` field |
| `frontend/src/sidebar/sidebar.css` | Add dashboard card styles, pie chart styles |
| `frontend/src/sidebar/AnalysisDashboard.tsx` | **NEW** — renders structured analysis data |
| `frontend/src/sidebar/LanguageChart.tsx` | **NEW** — pie chart component |
| `frontend/src/net/wsBridge.ts` | Pass `analysis` data to sidebar |
| `src-tauri/src/network.rs` | Emit full JSON response (not just reply_text) |
| `frontend/package.json` | Add `react-minimal-pie-chart` dependency |

---

## 8. Heading Format Examples

| User says | Heading in sidebar |
|-----------|-------------------|
| `analyse zync` | `Analysis: zync-meet/Zync` |
| `analyse tauri-apps/tauri` | `Analysis: tauri-apps/tauri` |
| `analyse PR 24 in servx` | `Analysis: PR #24 in servx-lab/ServX` |
| `analyse ChitkulLakshya/GitGlance` | `Analysis: ChitkulLakshya/GitGlance` |
| `deep analyse microsoft/vscode` | `Analysis: microsoft/vscode (Deep)` |

The heading is derived from the resolved repo name (after `resolveRepo()` runs).

---

## 9. What NOT to Change

- The architecture mapper (`architect.rs`) — stays separate
- The wake word / hotkey system — unchanged
- The voice TTS — `reply_text` is still spoken
- The intent classification — `fast_analyse` intent stays the same
- PR analysis — separate flow, not affected
- GitHub write operations — not affected
- OAuth token handling — not affected

---

## 10. User Decisions (Confirmed)

1. **Pie chart style**: **Half donut** (semi-circle) for languages — clean, modern, compact
2. **Framework chart**: **Donut with equal slices** — visual indicator of which frameworks are present
3. **Close button**: **Remove X entirely** — close via Esc or Ctrl+Shift+Space only
4. **Contributors**: Skip (slow API call, not worth the latency)
5. **Heading**: Show `Analysis: {resolved_repo_name}` in the top bar
