# Autonomous Codebase Architecture Mapper — Hackathon Submission

**Project Name:** NEXUS Agent Architecture Mapper
**Track:** Developer Intelligence & Change Impact Analysis
**Target:** WCAG 2.2 AA Compliant UI (Apple Music Web Aesthetic)

---

## 1. Executive Summary

NEXUS solves the "Codebase Architecture Mapper" problem by combining **lightning-fast static analysis (Rust)** with **agentic AI explanation (LLMs)**. 

When a developer asks *"If I change this piece of code, what else could be affected and why?"*, traditional tools spit out an overwhelming list of 50 files. NEXUS instead calculates the **blast radius** using reverse-BFS graph traversal, reconstructs the exact dependency paths, and uses an AI agent to explain the real-world engineering risks in plain English.

We implemented a **three-phase progressive architecture** that gives the user immediate visual value, then deepens the analysis silently in the background, and finally allows them to interrogate the codebase through a voice or text agent.

---

## 2. How NEXUS Meets the Hackathon Criteria

### ?? Codebase Understanding & Architecture Mapping
* **The Challenge:** Transform a repository from a collection of files into an understandable map.
* **Our Solution (Phase 1):** We built an intelligent clustering engine (nalyze_repo_phase1) that categorizes thousands of files into high-level architectural layers (Frontend, Backend, Database, Infrastructure, Shared). This is instantly visualized in our ReactFlow interface, orienting the developer in under 10 seconds.

### ?? Relationship and Dependency Discovery
* **The Challenge:** Identify meaningful relationships between software components.
* **Our Solution (Phase 2):** NEXUS automatically clones the repository and uses ayon to perform parallel AST-level import parsing. It constructs a highly performant directed adjacency graph (petgraph) mapping exactly which files import or call which other files across the entire codebase.

### ?? Change Impact Analysis & Explainability (The Core Challenge)
* **The Challenge:** Investigate the potential impact of changing a selected component and explain *why*.
* **Our Solution (Phase 3):** Our query_impact engine runs a **Reverse Breadth-First Search (BFS)** starting from the modified file to calculate the total blast radius. Crucially, it reconstructs the *shortest paths* from the origin to the affected files. The AI then narrates this path (e.g., pi/client.ts -> Dashboard.tsx -> App.tsx), explaining exactly how a low-level utility change could crash a top-level route.

### ?? Risk and Criticality Analysis
* **The Challenge:** Identify architectural hotspots and operational risks.
* **Our Solution:** The backend automatically calculates graph centrality:
  * **Hotspots:** Calculates in_degree to find files that are heavily depended upon, grading them from "normal" to "critical" risk.
  * **Circular Dependencies:** We implemented **Tarjan's Strongly Connected Components (SCC)** algorithm to mathematically detect and flag dangerous circular dependency loops that break tree-shaking and isolated testing.

### ?? Scalability & Efficiency
* **The Challenge:** Handle thousands of files and minimize LLM consumption.
* **Our Solution:** 
  * **Processing:** The Rust backend processes file trees in parallel, reducing scan times to seconds.
  * **LLM Efficiency:** The AI does *not* guess dependencies. The deterministic Rust engine calculates the graph and the blast radius offline, and passes the minimal required JSON to the LLM solely for *translation* and *explanation*.
  * **Speed:** Impact queries on the cached in-memory graph execute in **<10ms**.

---

## 3. Example Scenario

**Scenario:** A developer wants to modify 
ext.config.js.

1. **User asks:** *"What breaks if I change next.config.js?"*
2. **NEXUS Rust Engine:** Instantly searches the cached petgraph. Finds that 
ext.config.js has an in_degree of 47 (Critical). Runs reverse BFS and finds 12 page routes are affected via the Webpack layer.
3. **NEXUS AI Agent:** *"Changing next.config.js is highly critical. It feeds directly into the build layer which bundles all 12 of your page routes. Any syntax error here will bring down the entire application build."*
4. **UI Response:** The ReactFlow visualizer dims unaffected components and pulses the exact blast radius in bright red, highlighting the specific edges that propagate the change.

---

## 4. Technical Implementation

* **Backend Engine:** Rust (Tauri)
* **Graph Algorithms:** petgraph (Tarjan's SCC, Reverse BFS, Centrality Scoring)
* **Concurrency:** ayon (Parallel I/O and RegEx AST parsing)
* **Frontend Visualization:** ReactFlow with custom frosted glass UI
* **LLM Layer:** Cloudflare Workers (Mistral / GLM-4) 

## 5. Summary

NEXUS does not just draw a diagram. It actively monitors architectural health, mathematically calculates risk, and provides an explainable, conversational agent to help developers navigate complex enterprise codebases safely.
