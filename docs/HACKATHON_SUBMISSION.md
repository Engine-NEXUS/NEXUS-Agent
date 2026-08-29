# 🏆 Citta RISE Hackathon Submission — Problem Statement 05: Architecture Mapper

**Event:** Citta RISE (Idea2Agent Edition) — 29 Aug 2026  
**Venue:** LeapStart Academy, Nanakramguda Financial District  
**Track:** Problem 05 of 06 · Architecture Mapper (*"Not a diagram. A consequence engine."*)  
**Team Name:** V-Max (Team #5)  
**Team Leader:** Prem Sai Kota ([@prem22k](https://github.com/prem22k))  
**Team Members:**
* Lakshya Chitkul ([@chitkullakshya](https://github.com/chitkullakshya))
* Ajith Kumar ([@ajithhhak](https://github.com/ajithhhak))

---

## 1. Executive Summary

Enterprise systems span thousands of files, APIs, database entities, and microservices. Architecture evolves faster than documentation. When an engineer touches an unfamiliar repository, a single modification can trigger cascading regressions across unrelated modules.

Traditional tools only produce static, unnavigable "hairball" import graphs. 

**NEXUS transforms codebase exploration into an active consequence engine:**
> *"If I change this piece of code, what else could be affected — and why?"*

By combining **parallel AST graph traversal in Rust (Petgraph + Rayon)** with **serverless Edge AI (Cloudflare Workers + Workers AI)** and **in-process native voice (Moonshine STT + Kokoro TTS)**, NEXUS allows developers to visually and conversationally interrogate codebase architecture, calculate exact blast radiuses with `<10ms` BFS algorithms, and explain architectural consequences in plain English.

---

## 2. How NEXUS Directly Solves Problem Statement 05

| Capability Requirement | NEXUS Implementation & Technical Solution |
| :--- | :--- |
| **1. Codebase Understanding** | **Phase 1 Intelligent Layering:** Automatically clusters thousands of files into architectural layers (Presentation/Client, API/Routing, Domain/Business Logic, Database/Storage, Infrastructure/Config). Runs in `<5s` for instant first paint. |
| **2. Relationship Discovery** | **Phase 2 AST Dependency Graph:** Parallelized AST parsing (via Rayon) parses imports, exports, and function invocations into a directed adjacency graph (`petgraph`) mapping cross-module, API, and schema connections. |
| **3. Architecture Mapping** | **Interactive ReactFlow Topology:** Hierarchical, layered visual topology with node centrality coloring, collapsible clusters, and search filtering—eliminating the "node hairball" problem. |
| **4. Architecture Insights** | **Mathematical Risk Scoring:** Automatically detects **Circular Dependencies** using **Tarjan's Strongly Connected Components (SCC)** algorithm and flags critical architectural hotspots based on `in_degree` centrality. |
| **5. Change Impact Analysis** | **Sub-10ms Reverse-BFS Blast Radius:** Traverses reverse dependencies from the target file, isolates affected components, dims unaffected code, and highlights propagating edges in red. |
| **6. Explainability ("The Why")** | **Shortest-Path AI Narration:** Reconstructs the exact path (e.g., `db/schema.ts ➔ api/client.ts ➔ Dashboard.tsx ➔ App.tsx`) and prompts the LLM on the edge to explain why a low-level change breaks top-level workflows. |

---

## 3. Real-World Developer Scenario

**Scenario:** An engineer wants to modify `vite.config.ts` or a shared database client in a 1,000+ file repository.

1. **Voice / Text Prompt:** *"What breaks if I change vite.config.ts?"*
2. **Deterministic Rust Computation:**
   * Searches the cached in-memory `petgraph`.
   * Finds `vite.config.ts` has high centrality (`in_degree = 38`).
   * Runs Reverse-BFS: determines that 14 routes and 3 build plugins depend on this configuration.
   * Checks Tarjan's SCC: verifies no cyclic imports are introduced.
3. **Agentic AI Explanation (Edge Worker):**
   > *"Changing `vite.config.ts` has a CRITICAL blast radius (38 dependents). It feeds directly into the bundling and alias resolution layer across 14 page routes. Any syntax or plugin misconfiguration will immediately fail the production build."*
4. **Visual UI Reaction:**
   * The ReactFlow canvas instantly dims the rest of the application.
   * The affected 14 components pulse in alert red with directional edge flow arrows.

---

## 4. Evaluation Criteria Alignment

### 1. Depth of Understanding
NEXUS goes beyond shallow file trees. It understands architectural tiers (Frontend vs Backend vs Storage), import relationships, and file roles via AST parsing and metadata heuristics.

### 2. Meaningful Relationships
Identifies actual structural dependencies (direct imports, shared library consumption, route handlers, build definitions).

### 3. Architecture Representation
Clean, responsive, liquid-glass visual interface with zoomable pan/zoom canvas, layer-based grouping, and real-time search.

### 4. Consequence & Impact Precision
Calculates exact downstream blast radiuses via deterministic graph theory rather than LLM hallucinations.

### 5. Explainability
Never just returns a raw list of files; reconstructs the shortest path of dependency flow and explains the real-world operational risk.

### 6. Actionability
Integrates directly with the engineer's daily workflow via global hotkey (`Ctrl+Shift+Space`), voice triggers, and automated GitHub PR code reviews.

### 7. Technical Robustness
* **Client:** Rust (Tauri v2) + React 18 + TypeScript + Petgraph.
* **Audio:** `openWakeWord` (Tract-ONNX), `Moonshine` (In-process STT), `Kokoro 82M` (In-process TTS + Rodio).
* **Backend:** Cloudflare Workers (Edge) + Cloudflare D1 SQLite.

### 8. AI Value
AI is used where it excels (semantic translation, PR summarization, risk narration), while graph traversal and blast-radius math are handled with 100% precision by Rust.

### 9. Efficiency & Cost
* **Graph Queries:** Sub-10ms in-memory execution.
* **Serverless Edge:** Cold starts <5ms on Cloudflare Workers.
* **Zero Python Runtime:** Zero heavy local Python processes, saving ~340MB of RAM.

### 10. Scalability
Multi-threaded parallel file processing (Rayon) scales effortlessly to enterprise repositories with thousands of files.

---

## 5. Live Deployment & Infrastructure

* **GitHub Repository:** [`https://github.com/Engine-NEXUS/NEXUS-Agent`](https://github.com/Engine-NEXUS/NEXUS-Agent)
* **Live Edge Worker:** [`https://nexus-worker.chitkullakshya.workers.dev`](https://nexus-worker.chitkullakshya.workers.dev)
* **Live Worker Health:** [`https://nexus-worker.chitkullakshya.workers.dev/health`](https://nexus-worker.chitkullakshya.workers.dev/health) (Status: `{"ok":true,"serverless":true}`)
* **Windows NSIS Installer:** Generated via CI/CD (`NEXUS_0.1.0_x64-setup.exe`).

---

© 2026 **Team V-Max (Team #5)** — Citta RISE Hackathon
