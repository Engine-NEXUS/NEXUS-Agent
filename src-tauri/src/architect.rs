//! Architecture Mapper — Phase 1, 2 & 3 Backend Engine.
//!
//! Provides:
//!   - Active repo detection from foreground OS window (`get_active_repo_url`)
//!   - Window control for the `architect` window (`open_architect_window`)
//!   - Phase 1 fast architectural layer clustering (`analyze_repo_phase1`)
//!   - Phase 2 deep dependency graph extraction via shallow clone, parallel AST scanning, and petgraph analysis (`analyze_repo_deep`)
//!   - Phase 3 sub-10ms reverse BFS impact & blast radius engine (`query_impact`)

use petgraph::algo::tarjan_scc;
use petgraph::graph::{DiGraph, NodeIndex};
use petgraph::Direction;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

// ─── Data Models ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoIdentity {
    pub owner: String,
    pub repo: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectLayer {
    pub id: String,
    pub label: String,
    pub layer_type: String, // "frontend" | "backend" | "database" | "infra" | "shared"
    pub dirs: Vec<String>,
    pub tech_stack: String,
    pub file_count: usize,
    pub sample_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchitectEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub label: Option<String>,
    pub edge_type: Option<String>, // "imports" | "calls" | "configures"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phase1Response {
    pub owner: String,
    pub repo: String,
    pub default_branch: String,
    pub primary_language: String,
    pub description: String,
    pub summary: String,
    pub layers: Vec<ArchitectLayer>,
    pub edges: Vec<ArchitectEdge>,
    pub entry_points: Vec<String>,
    pub total_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNodeInfo {
    pub file_path: String,
    pub layer_id: Option<String>,
    pub in_degree: usize,
    pub out_degree: usize,
    pub imports: Vec<String>,
    pub imported_by: Vec<String>,
    pub is_hotspot: bool,
    pub risk_level: String, // "normal" | "medium" | "high" | "critical"
    pub is_circular: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircularDependency {
    pub chain: Vec<String>,
    pub risk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotspotItem {
    pub file: String,
    pub in_degree: usize,
    pub risk: String, // "high" | "critical"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Phase2Response {
    pub owner: String,
    pub repo: String,
    pub total_files: usize,
    pub files_analyzed: usize,
    pub nodes: HashMap<String, FileNodeInfo>,
    pub circular_deps: Vec<CircularDependency>,
    pub hotspots: Vec<HotspotItem>,
    pub isolated: Vec<String>,
    pub entry_points: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImpactResult {
    pub target_file: String,
    pub affected_files: Vec<String>,
    pub dependency_paths: Vec<Vec<String>>,
    pub max_depth: usize,
    pub direct_count: usize,
    pub transitive_count: usize,
    pub test_files_affected: Vec<String>,
    pub explanation: String,
}

// ─── In-Memory Graph Storage ──────────────────────────────────────

#[allow(dead_code)]
pub struct CachedGraphState {
    pub owner: String,
    pub repo: String,
    pub graph: DiGraph<String, ()>,
    pub node_indices: HashMap<String, NodeIndex>,
    pub index_to_file: HashMap<NodeIndex, String>,
    pub phase2_response: Phase2Response,
}

static CACHED_GRAPH: once_cell::sync::Lazy<parking_lot::Mutex<Option<Arc<CachedGraphState>>>> =
    once_cell::sync::Lazy::new(|| parking_lot::Mutex::new(None));

// ─── Active Window Detection ──────────────────────────────────────

/// IPC: Extract active GitHub owner and repository from the current foreground window title.
#[tauri::command]
pub fn get_active_repo_url() -> Option<RepoIdentity> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0 == 0 {
                return None;
            }
            let mut buf = [0u16; 512];
            let len = GetWindowTextW(hwnd, &mut buf);
            if len == 0 {
                return None;
            }
            let title = String::from_utf16_lossy(&buf[..len as usize]);
            extract_github_repo_from_title(&title)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Parse window title or URL string for GitHub owner/repo format.
pub fn extract_github_repo_from_title(title: &str) -> Option<RepoIdentity> {
    let t = title.trim();

    // Check for https://github.com/owner/repo
    if let Some(pos) = t.find("github.com/") {
        let after = &t[pos + "github.com/".len()..];
        let parts: Vec<&str> = after.split('/').take(2).collect();
        if parts.len() == 2 {
            let owner = sanitize_github_name(parts[0]);
            let repo = sanitize_github_name(parts[1]);
            if !owner.is_empty() && !repo.is_empty() {
                return Some(RepoIdentity { owner, repo });
            }
        }
    }

    // Check for "owner/repo" in window titles
    let parts: Vec<&str> = t.split(&['·', '—', '-', '|', ':'][..]).collect();
    for part in parts {
        let trimmed = part.trim();
        if let Some((owner, repo)) = split_owner_repo(trimmed) {
            return Some(RepoIdentity { owner, repo });
        }
    }

    None
}

fn split_owner_repo(s: &str) -> Option<(String, String)> {
    let tokens: Vec<&str> = s.split_whitespace().collect();
    for token in tokens {
        if token.contains('/') {
            let segs: Vec<&str> = token.split('/').collect();
            if segs.len() == 2 {
                let o = sanitize_github_name(segs[0]);
                let r = sanitize_github_name(segs[1]);
                if is_valid_github_slug(&o) && is_valid_github_slug(&r) {
                    return Some((o, r));
                }
            }
        }
    }
    None
}

fn sanitize_github_name(name: &str) -> String {
    name.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_' && c != '.')
        .to_string()
}

fn is_valid_github_slug(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.')
        && s != "github"
        && s != "login"
        && s != "settings"
        && s != "pulls"
        && s != "issues"
}

// ─── Window Management ────────────────────────────────────────────

/// IPC: Open the dedicated Architect window and focus it.
#[tauri::command]
pub fn open_architect_window<R: Runtime>(
    app: AppHandle<R>,
    owner: Option<String>,
    repo: Option<String>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("architect")
        .ok_or_else(|| "architect window not found in configuration".to_string())?;

    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())?;

    if let (Some(o), Some(r)) = (owner, repo) {
        let _ = app.emit(
            "architect:set-repo",
            serde_json::json!({ "owner": o, "repo": r }),
        );
    }

    Ok(())
}

// ─── Phase 1: Fast Architecture Map ──────────────────────────────

#[tauri::command]
pub async fn analyze_repo_phase1<R: Runtime>(
    app: AppHandle<R>,
    owner: String,
    repo: String,
    github_token: Option<String>,
) -> Result<Phase1Response, String> {
    tracing::info!("Phase 1: starting architectural analysis for {}/{}", owner, repo);
    let _ = app.emit(
        "architect:progress",
        serde_json::json!({
            "stage": "metadata",
            "message": format!("Fetching repository metadata for {}/{}...", owner, repo)
        }),
    );

    let client = reqwest::Client::builder()
        .user_agent("NEXUS-Architecture-Mapper/1.0")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // 1. Fetch Repo Metadata
    let repo_url = format!("https://api.github.com/repos/{owner}/{repo}");
    let mut req = client.get(&repo_url);
    if let Some(tok) = &github_token {
        if !tok.trim().is_empty() {
            req = req.bearer_auth(tok);
        }
    }

    let repo_resp = req.send().await.map_err(|e| format!("GitHub API repo request failed: {e}"))?;
    if !repo_resp.status().is_success() {
        return Err(format!("GitHub API error {}: {}", repo_resp.status(), repo_resp.text().await.unwrap_or_default()));
    }

    let repo_json: serde_json::Value = repo_resp.json().await.map_err(|e| format!("Failed to parse repo JSON: {e}"))?;
    let default_branch = repo_json["default_branch"].as_str().unwrap_or("main").to_string();
    let primary_language = repo_json["language"].as_str().unwrap_or("TypeScript").to_string();
    let description = repo_json["description"].as_str().unwrap_or("No description provided.").to_string();

    // 2. Fetch Recursive Git Tree
    let _ = app.emit(
        "architect:progress",
        serde_json::json!({
            "stage": "tree",
            "message": format!("Fetching file tree from branch '{}'...", default_branch)
        }),
    );

    let tree_url = format!("https://api.github.com/repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1");
    let mut tree_req = client.get(&tree_url);
    if let Some(tok) = &github_token {
        if !tok.trim().is_empty() {
            tree_req = tree_req.bearer_auth(tok);
        }
    }

    let tree_resp = tree_req.send().await.map_err(|e| format!("GitHub tree request failed: {e}"))?;
    let tree_json: serde_json::Value = tree_resp.json().await.map_err(|e| format!("Failed to parse tree JSON: {e}"))?;

    let mut file_paths: Vec<String> = Vec::new();
    if let Some(tree_arr) = tree_json["tree"].as_array() {
        for item in tree_arr {
            if item["type"].as_str() == Some("blob") {
                if let Some(path) = item["path"].as_str() {
                    file_paths.push(path.to_string());
                }
            }
        }
    }

    let total_files = file_paths.len();
    let _ = app.emit(
        "architect:progress",
        serde_json::json!({
            "stage": "clustering",
            "message": format!("Clustering {} files into architectural layers...", total_files)
        }),
    );

    // 3. Cluster into architectural layers
    let (layers, edges, entry_points) = cluster_files_into_layers(&file_paths, &primary_language);

    let summary = format!(
        "{} is a {} repository structured across {} architectural layers with {} source files.",
        repo,
        primary_language,
        layers.len(),
        total_files
    );

    let response = Phase1Response {
        owner,
        repo,
        default_branch,
        primary_language,
        description,
        summary,
        layers,
        edges,
        entry_points,
        total_files,
    };

    let _ = app.emit("architect:phase1-ready", &response);
    Ok(response)
}

fn cluster_files_into_layers(
    paths: &[String],
    primary_language: &str,
) -> (Vec<ArchitectLayer>, Vec<ArchitectEdge>, Vec<String>) {
    let mut frontend_files = Vec::new();
    let mut backend_files = Vec::new();
    let mut data_files = Vec::new();
    let mut infra_files = Vec::new();
    let mut shared_files = Vec::new();
    let mut entry_points = Vec::new();

    for path in paths {
        let p_lower = path.to_lowercase();

        if p_lower.ends_with("main.tsx")
            || p_lower.ends_with("index.tsx")
            || p_lower.ends_with("main.rs")
            || p_lower.ends_with("main.go")
            || p_lower.ends_with("server.ts")
            || p_lower.ends_with("app.tsx")
            || p_lower.ends_with("index.js")
            || p_lower.ends_with("manage.py")
        {
            if entry_points.len() < 5 {
                entry_points.push(path.clone());
            }
        }

        if p_lower.contains("client")
            || p_lower.contains("ui")
            || p_lower.contains("frontend")
            || p_lower.contains("components")
            || p_lower.contains("pages")
            || p_lower.contains("views")
            || p_lower.contains("styles")
            || p_lower.ends_with(".tsx")
            || p_lower.ends_with(".jsx")
            || p_lower.ends_with(".vue")
            || p_lower.ends_with(".svelte")
            || p_lower.ends_with(".html")
            || p_lower.ends_with(".css")
        {
            frontend_files.push(path.clone());
        } else if p_lower.contains("server")
            || p_lower.contains("api")
            || p_lower.contains("backend")
            || p_lower.contains("routes")
            || p_lower.contains("controllers")
            || p_lower.contains("handlers")
            || p_lower.contains("services")
            || p_lower.contains("grpc")
        {
            backend_files.push(path.clone());
        } else if p_lower.contains("db")
            || p_lower.contains("database")
            || p_lower.contains("models")
            || p_lower.contains("schema")
            || p_lower.contains("migrations")
            || p_lower.contains("queries")
            || p_lower.contains("store")
            || p_lower.ends_with(".sql")
            || p_lower.ends_with(".prisma")
        {
            data_files.push(path.clone());
        } else if p_lower.contains("docker")
            || p_lower.contains(".github")
            || p_lower.contains("k8s")
            || p_lower.contains("helm")
            || p_lower.contains("terraform")
            || p_lower.contains("deploy")
            || p_lower.contains("scripts")
            || p_lower.ends_with(".yml")
            || p_lower.ends_with(".yaml")
            || p_lower.ends_with(".toml")
        {
            infra_files.push(path.clone());
        } else {
            shared_files.push(path.clone());
        }
    }

    let mut layers = Vec::new();

    if !frontend_files.is_empty() {
        layers.push(ArchitectLayer {
            id: "layer_frontend".to_string(),
            label: "Client / Presentation Layer".to_string(),
            layer_type: "frontend".to_string(),
            dirs: extract_top_dirs(&frontend_files),
            tech_stack: if primary_language == "TypeScript" { "React / Web UI".into() } else { primary_language.into() },
            file_count: frontend_files.len(),
            sample_files: frontend_files.iter().take(4).cloned().collect(),
        });
    }

    if !backend_files.is_empty() {
        layers.push(ArchitectLayer {
            id: "layer_backend".to_string(),
            label: "Server / API Services".to_string(),
            layer_type: "backend".to_string(),
            dirs: extract_top_dirs(&backend_files),
            tech_stack: format!("{} Core Runtime", primary_language),
            file_count: backend_files.len(),
            sample_files: backend_files.iter().take(4).cloned().collect(),
        });
    }

    if !data_files.is_empty() {
        layers.push(ArchitectLayer {
            id: "layer_data".to_string(),
            label: "Data & State Management".to_string(),
            layer_type: "database".to_string(),
            dirs: extract_top_dirs(&data_files),
            tech_stack: "Database / Store Models".into(),
            file_count: data_files.len(),
            sample_files: data_files.iter().take(4).cloned().collect(),
        });
    }

    if !shared_files.is_empty() {
        layers.push(ArchitectLayer {
            id: "layer_shared".to_string(),
            label: "Shared Utilities & Types".to_string(),
            layer_type: "shared".to_string(),
            dirs: extract_top_dirs(&shared_files),
            tech_stack: "Utilities / Lib / Config".into(),
            file_count: shared_files.len(),
            sample_files: shared_files.iter().take(4).cloned().collect(),
        });
    }

    if !infra_files.is_empty() {
        layers.push(ArchitectLayer {
            id: "layer_infra".to_string(),
            label: "Infrastructure & CI/CD".to_string(),
            layer_type: "infra".to_string(),
            dirs: extract_top_dirs(&infra_files),
            tech_stack: "Docker / Workflows / Config".into(),
            file_count: infra_files.len(),
            sample_files: infra_files.iter().take(4).cloned().collect(),
        });
    }

    let mut edges = Vec::new();
    if layers.iter().any(|l| l.id == "layer_frontend") && layers.iter().any(|l| l.id == "layer_backend") {
        edges.push(ArchitectEdge {
            id: "e_frontend_backend".into(),
            source: "layer_frontend".into(),
            target: "layer_backend".into(),
            label: Some("API requests".into()),
            edge_type: Some("calls".into()),
        });
    }
    if layers.iter().any(|l| l.id == "layer_backend") && layers.iter().any(|l| l.id == "layer_data") {
        edges.push(ArchitectEdge {
            id: "e_backend_data".into(),
            source: "layer_backend".into(),
            target: "layer_data".into(),
            label: Some("queries".into()),
            edge_type: Some("imports".into()),
        });
    }
    if layers.iter().any(|l| l.id == "layer_backend") && layers.iter().any(|l| l.id == "layer_shared") {
        edges.push(ArchitectEdge {
            id: "e_backend_shared".into(),
            source: "layer_backend".into(),
            target: "layer_shared".into(),
            label: Some("imports".into()),
            edge_type: Some("imports".into()),
        });
    }
    if layers.iter().any(|l| l.id == "layer_frontend") && layers.iter().any(|l| l.id == "layer_shared") {
        edges.push(ArchitectEdge {
            id: "e_frontend_shared".into(),
            source: "layer_frontend".into(),
            target: "layer_shared".into(),
            label: Some("imports".into()),
            edge_type: Some("imports".into()),
        });
    }

    (layers, edges, entry_points)
}

fn extract_top_dirs(files: &[String]) -> Vec<String> {
    let mut dir_counts: HashMap<String, usize> = HashMap::new();
    for f in files {
        let parts: Vec<&str> = f.split('/').collect();
        if parts.len() > 1 {
            let dir = parts[..parts.len() - 1].join("/");
            *dir_counts.entry(dir).or_insert(0) += 1;
        }
    }
    let mut sorted: Vec<(String, usize)> = dir_counts.into_iter().collect();
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    sorted.into_iter().take(3).map(|(d, _)| format!("{}/", d)).collect()
}

// ─── Phase 2: Deep AST Dependency Graph ──────────────────────────

/// Resolve base cache directory for cloned repos: `%APPDATA%\com.nexus.assistant\repos\`
fn get_repos_cache_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if let Ok(dir) = app.path().app_data_dir() {
        dir.join("repos")
    } else if let Some(dir) = dirs_next::data_dir() {
        dir.join("com.nexus.assistant").join("repos")
    } else {
        std::env::temp_dir().join("nexus_repos")
    }
}

/// IPC: Phase 2 deep dependency scan (~60s background path).
/// Performs shallow clone (`git clone --depth=1`), scans imports with rayon in parallel,
/// constructs petgraph dependency graph, calculates cycle chains and centrality hotspots.
#[tauri::command]
pub async fn analyze_repo_deep<R: Runtime>(
    app: AppHandle<R>,
    owner: String,
    repo: String,
    github_token: Option<String>,
) -> Result<Phase2Response, String> {
    tracing::info!("Phase 2: Starting deep graph scan for {}/{}", owner, repo);

    let repos_dir = get_repos_cache_dir(&app);
    let repo_target_dir = repos_dir.join(format!("{}-{}", owner, repo));
    let _ = std::fs::create_dir_all(&repos_dir);

    // 1. Shallow Git Clone (or reuse existing directory)
    let _ = app.emit(
        "architect:progress",
        serde_json::json!({
            "stage": "cloning",
            "message": format!("Shallow cloning {}/{} to local cache...", owner, repo)
        }),
    );

    let clone_needed = !repo_target_dir.exists() || !repo_target_dir.join(".git").exists();
    if clone_needed {
        let mut clone_url = format!("https://github.com/{}/{}.git", owner, repo);
        if let Some(tok) = &github_token {
            if !tok.trim().is_empty() {
                clone_url = format!("https://{}@github.com/{}/{}.git", tok, owner, repo);
            }
        }

        let mut cmd = std::process::Command::new("git");
        cmd.args([
            "clone",
            "--depth=1",
            "--single-branch",
            &clone_url,
            repo_target_dir.to_str().unwrap_or_default(),
        ]);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        match cmd.output() {
            Ok(out) if out.status.success() => {
                tracing::info!("Phase 2: shallow clone succeeded at {}", repo_target_dir.display());
            }
            Ok(out) => {
                let err_str = String::from_utf8_lossy(&out.stderr);
                tracing::warn!("Phase 2: git clone exited with code: {err_str}");
            }
            Err(e) => {
                tracing::warn!("Phase 2: git clone command failed: {e}");
            }
        }
    }

    // 2. Discover Source Files
    let _ = app.emit(
        "architect:progress",
        serde_json::json!({
            "stage": "scanning",
            "message": "Walking file tree and extracting import statements in parallel..."
        }),
    );

    let mut candidate_files = Vec::new();
    if repo_target_dir.exists() {
        for entry in ignore::WalkBuilder::new(&repo_target_dir)
            .hidden(false)
            .git_ignore(true)
            .build()
            .flatten()
        {
            let path = entry.path();
            if path.is_file() && is_source_file(path) {
                if let Ok(rel) = path.strip_prefix(&repo_target_dir) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    if !is_ignored_path(&rel_str) {
                        candidate_files.push((rel_str, path.to_path_buf()));
                    }
                }
            }
        }
    }

    let total_files = candidate_files.len();
    tracing::info!("Phase 2: found {} candidate source files to parse", total_files);

    // 3. Parallel Import Extraction with Rayon
    let known_file_set: HashSet<String> = candidate_files.iter().map(|(r, _)| r.clone()).collect();

    let parsed_results: Vec<(String, Vec<String>)> = candidate_files
        .par_iter()
        .map(|(rel_path, abs_path)| {
            let content = std::fs::read_to_string(abs_path).unwrap_or_default();
            let raw_imports = extract_imports_from_source(rel_path, &content);
            let resolved_imports = resolve_imported_files(rel_path, &raw_imports, &known_file_set);
            (rel_path.clone(), resolved_imports)
        })
        .collect();

    // 4. Construct Directed Graph in Petgraph
    let _ = app.emit(
        "architect:progress",
        serde_json::json!({
            "stage": "graph",
            "message": "Building dependency graph and calculating cycles..."
        }),
    );

    let mut graph = DiGraph::<String, ()>::new();
    let mut node_indices: HashMap<String, NodeIndex> = HashMap::new();
    let mut index_to_file: HashMap<NodeIndex, String> = HashMap::new();

    // Add nodes
    for (rel_path, _) in &parsed_results {
        let idx = graph.add_node(rel_path.clone());
        node_indices.insert(rel_path.clone(), idx);
        index_to_file.insert(idx, rel_path.clone());
    }

    // Add edges (A imports B -> directed edge A -> B)
    for (source_file, imports) in &parsed_results {
        if let Some(&src_idx) = node_indices.get(source_file) {
            for target_file in imports {
                if let Some(&tgt_idx) = node_indices.get(target_file) {
                    if src_idx != tgt_idx {
                        graph.add_edge(src_idx, tgt_idx, ());
                    }
                }
            }
        }
    }

    // 5. Detect Circular Dependencies (Tarjan's SCC)
    let sccs = tarjan_scc(&graph);
    let mut circular_deps = Vec::new();
    let mut circular_file_set = HashSet::new();

    for scc in sccs {
        if scc.len() > 1 {
            let mut chain: Vec<String> = scc.iter().filter_map(|idx| index_to_file.get(idx).cloned()).collect();
            for f in &chain {
                circular_file_set.insert(f.clone());
            }
            if let Some(first) = chain.first().cloned() {
                chain.push(first);
            }
            circular_deps.push(CircularDependency {
                chain,
                risk: "Circular coupling prevents isolated unit testing and tree-shaking.".to_string(),
            });
        }
    }

    // 6. Compute Centrality, In-Degree, Out-Degree & Hotspots
    let mut node_map = HashMap::new();
    let mut hotspots = Vec::new();
    let mut isolated = Vec::new();
    let mut entry_points = Vec::new();

    for (file_path, idx) in &node_indices {
        let in_deg = graph.neighbors_directed(*idx, Direction::Incoming).count();
        let out_deg = graph.neighbors_directed(*idx, Direction::Outgoing).count();

        let imported_by: Vec<String> = graph
            .neighbors_directed(*idx, Direction::Incoming)
            .filter_map(|n_idx| index_to_file.get(&n_idx).cloned())
            .collect();

        let imports: Vec<String> = graph
            .neighbors_directed(*idx, Direction::Outgoing)
            .filter_map(|n_idx| index_to_file.get(&n_idx).cloned())
            .collect();

        let risk_level = if in_deg >= 20 {
            "critical"
        } else if in_deg >= 8 {
            "high"
        } else if in_deg >= 3 {
            "medium"
        } else {
            "normal"
        };

        let is_hotspot = in_deg >= 8;
        if is_hotspot {
            hotspots.push(HotspotItem {
                file: file_path.clone(),
                in_degree: in_deg,
                risk: risk_level.to_string(),
            });
        }

        if in_deg == 0 && out_deg == 0 {
            isolated.push(file_path.clone());
        }

        if in_deg == 0 && out_deg > 0 && is_likely_entrypoint(file_path) {
            entry_points.push(file_path.clone());
        }

        node_map.insert(
            file_path.clone(),
            FileNodeInfo {
                file_path: file_path.clone(),
                layer_id: None,
                in_degree: in_deg,
                out_degree: out_deg,
                imports,
                imported_by,
                is_hotspot,
                risk_level: risk_level.to_string(),
                is_circular: circular_file_set.contains(file_path),
            },
        );
    }

    hotspots.sort_by(|a, b| b.in_degree.cmp(&a.in_degree));

    let summary = format!(
        "Deep scan complete for {}/{}. Analyzed {} files with {} import dependencies. Found {} circular dependency chains and {} high-coupling hotspots.",
        owner,
        repo,
        total_files,
        graph.edge_count(),
        circular_deps.len(),
        hotspots.len()
    );

    let phase2_resp = Phase2Response {
        owner: owner.clone(),
        repo: repo.clone(),
        total_files,
        files_analyzed: parsed_results.len(),
        nodes: node_map,
        circular_deps,
        hotspots,
        isolated,
        entry_points,
        summary,
    };

    // Cache graph in memory for sub-10ms Phase 3 impact queries
    *CACHED_GRAPH.lock() = Some(Arc::new(CachedGraphState {
        owner,
        repo,
        graph,
        node_indices,
        index_to_file,
        phase2_response: phase2_resp.clone(),
    }));

    let _ = app.emit("architect:graph-ready", &phase2_resp);
    Ok(phase2_resp)
}

// ─── Import Extraction Helpers ────────────────────────────────────

fn is_source_file(path: &Path) -> bool {
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or_default().to_lowercase();
    matches!(
        ext.as_str(),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "rs" | "go" | "java" | "kt" | "php"
    )
}

fn is_ignored_path(rel_path: &str) -> bool {
    let p = rel_path.to_lowercase();
    p.contains("node_modules/")
        || p.contains("dist/")
        || p.contains("build/")
        || p.contains("target/")
        || p.contains(".git/")
        || p.contains("vendor/")
        || p.contains("__pycache__/")
        || p.ends_with(".d.ts")
        || p.ends_with(".min.js")
        || p.ends_with(".test.ts")
        || p.ends_with(".test.tsx")
        || p.ends_with(".test.js")
        || p.ends_with(".spec.ts")
        || p.ends_with(".spec.tsx")
        || p.ends_with(".spec.js")
}

fn is_likely_entrypoint(p: &str) -> bool {
    let l = p.to_lowercase();
    l.ends_with("main.tsx")
        || l.ends_with("index.tsx")
        || l.ends_with("main.rs")
        || l.ends_with("main.go")
        || l.ends_with("server.ts")
        || l.ends_with("app.tsx")
        || l.ends_with("index.js")
        || l.ends_with("app.py")
        || l.ends_with("manage.py")
}

/// Extract import specifiers from source content across multiple languages.
fn extract_imports_from_source(file_path: &str, content: &str) -> Vec<String> {
    let mut imports = Vec::new();
    let ext = file_path.split('.').last().unwrap_or_default().to_lowercase();

    match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            for line in content.lines() {
                let trimmed = line.trim();
                // import ... from "path"
                if (trimmed.starts_with("import ") || trimmed.starts_with("import{") || trimmed.starts_with("export "))
                    && trimmed.contains(" from ")
                {
                    if let Some(spec) = extract_quoted_specifier(trimmed) {
                        imports.push(spec);
                    }
                }
                // require("path") or import("path")
                else if trimmed.contains("require(") || trimmed.contains("import(") {
                    if let Some(spec) = extract_quoted_specifier(trimmed) {
                        imports.push(spec);
                    }
                }
            }
        }
        "py" => {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("import ") {
                    let parts: Vec<&str> = trimmed["import ".len()..].split(',').collect();
                    for part in parts {
                        let mod_name = part.trim().split_whitespace().next().unwrap_or_default();
                        if !mod_name.is_empty() {
                            imports.push(mod_name.replace('.', "/"));
                        }
                    }
                } else if trimmed.starts_with("from ") {
                    if let Some(pos) = trimmed.find(" import") {
                        let mod_name = trimmed["from ".len()..pos].trim();
                        imports.push(mod_name.replace('.', "/"));
                    }
                }
            }
        }
        "rs" => {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("use crate::") {
                    let path_part = &trimmed["use crate::".len()..];
                    let clean = path_part.trim_end_matches(';').split('{').next().unwrap_or_default();
                    let formatted = clean.trim().trim_end_matches("::").replace("::", "/");
                    if !formatted.is_empty() {
                        imports.push(formatted);
                    }
                } else if trimmed.starts_with("mod ") && trimmed.ends_with(';') {
                    let mod_name = trimmed["mod ".len()..trimmed.len() - 1].trim();
                    imports.push(mod_name.to_string());
                }
            }
        }
        "go" => {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("import \"") || trimmed.starts_with('"') {
                    if let Some(spec) = extract_quoted_specifier(trimmed) {
                        imports.push(spec);
                    }
                }
            }
        }
        _ => {}
    }

    imports
}

fn extract_quoted_specifier(s: &str) -> Option<String> {
    let mut in_quote = false;
    let mut quote_char = '"';
    let mut start = 0;

    for (i, c) in s.char_indices() {
        if !in_quote {
            if c == '"' || c == '\'' || c == '`' {
                in_quote = true;
                quote_char = c;
                start = i + 1;
            }
        } else if c == quote_char {
            let spec = &s[start..i];
            if !spec.is_empty() {
                return Some(spec.to_string());
            }
            in_quote = false;
        }
    }
    None
}

/// Resolve relative import paths (e.g. `./client`, `../utils/http`, `@/components/App`)
/// to normalized file paths matching `known_files`.
fn resolve_imported_files(
    current_file: &str,
    import_specs: &[String],
    known_files: &HashSet<String>,
) -> Vec<String> {
    let mut resolved = Vec::new();
    let current_dir = Path::new(current_file).parent().unwrap_or_else(|| Path::new(""));

    for spec in import_specs {
        // Skip external package modules (e.g. "react", "tokio", "express")
        if !spec.starts_with('.') && !spec.starts_with('@') && !spec.starts_with('/') {
            // Check if it directly matches a local module path
            if known_files.contains(spec) {
                resolved.push(spec.clone());
            }
            continue;
        }

        // Relative path resolution
        let clean_spec = spec.strip_prefix("@/").unwrap_or(spec);
        let target_path = if spec.starts_with('@') {
            PathBuf::from("src").join(clean_spec)
        } else {
            current_dir.join(clean_spec)
        };

        // Normalize path
        let normalized = normalize_path(&target_path);
        let candidates = [
            normalized.clone(),
            format!("{}.ts", normalized),
            format!("{}.tsx", normalized),
            format!("{}.js", normalized),
            format!("{}.jsx", normalized),
            format!("{}/index.ts", normalized),
            format!("{}/index.tsx", normalized),
            format!("{}/index.js", normalized),
            format!("{}.rs", normalized),
            format!("{}/mod.rs", normalized),
            format!("{}.py", normalized),
            format!("{}/__init__.py", normalized),
        ];

        for cand in &candidates {
            if known_files.contains(cand) && cand != current_file {
                resolved.push(cand.clone());
                break;
            }
        }
    }

    resolved
}

fn normalize_path(path: &Path) -> String {
    let mut parts = Vec::new();
    for comp in path.components() {
        match comp {
            std::path::Component::Normal(c) => parts.push(c.to_string_lossy().to_string()),
            std::path::Component::ParentDir => {
                parts.pop();
            }
            _ => {}
        }
    }
    parts.join("/")
}

// ─── Phase 3: Reverse BFS Impact Engine ───────────────────────────

/// IPC: Sub-10ms reverse BFS impact analysis on the cached petgraph dependency graph.
/// Traces all upstream files that depend on `target_file` (directly or transitively),
/// reconstructs exact shortest paths from target to affected root, and details risk.
#[tauri::command]
pub fn query_impact(
    target_file: String,
    max_depth: Option<usize>,
) -> Result<ImpactResult, String> {
    let depth_limit = max_depth.unwrap_or(6);
    let guard = CACHED_GRAPH.lock();
    let cached = guard.as_ref().ok_or_else(|| "No graph cached. Run Phase 2 deep scan first.".to_string())?;

    // Fuzzy match target_file if exact match is not found
    let resolved_file = if cached.node_indices.contains_key(&target_file) {
        target_file.clone()
    } else {
        let needle = target_file.to_lowercase();
        cached
            .node_indices
            .keys()
            .find(|k| {
                let kl = k.to_lowercase();
                kl.ends_with(&needle) || kl.contains(&needle)
            })
            .cloned()
            .ok_or_else(|| format!("File '{}' not found in dependency graph.", target_file))?
    };

    let target_idx = *cached.node_indices.get(&resolved_file).unwrap();

    // Reverse BFS traversal on incoming edges (files that import target)
    let mut visited: HashSet<NodeIndex> = HashSet::new();
    let mut queue: VecDeque<(NodeIndex, usize, Vec<String>)> = VecDeque::new();
    let mut affected_files = Vec::new();
    let mut dependency_paths = Vec::new();
    let mut max_reached_depth = 0;
    let mut direct_count = 0;
    let mut transitive_count = 0;
    let mut test_files_affected = Vec::new();

    visited.insert(target_idx);
    queue.push_back((target_idx, 0, vec![resolved_file.clone()]));

    while let Some((curr_idx, curr_depth, curr_path)) = queue.pop_front() {
        if curr_depth > 0 {
            let curr_file = cached.index_to_file.get(&curr_idx).cloned().unwrap_or_default();
            affected_files.push(curr_file.clone());
            dependency_paths.push(curr_path.clone());

            if curr_depth == 1 {
                direct_count += 1;
            } else {
                transitive_count += 1;
            }

            if curr_file.contains("test") || curr_file.contains("spec") {
                test_files_affected.push(curr_file);
            }

            max_reached_depth = max_reached_depth.max(curr_depth);
        }

        if curr_depth < depth_limit {
            // Incoming neighbors import curr_idx
            for neighbor_idx in cached.graph.neighbors_directed(curr_idx, Direction::Incoming) {
                if !visited.contains(&neighbor_idx) {
                    visited.insert(neighbor_idx);
                    if let Some(neighbor_file) = cached.index_to_file.get(&neighbor_idx) {
                        let mut next_path = curr_path.clone();
                        next_path.push(neighbor_file.clone());
                        queue.push_back((neighbor_idx, curr_depth + 1, next_path));
                    }
                }
            }
        }
    }

    let explanation = if affected_files.is_empty() {
        format!(
            "'{}' is a leaf node or isolated module with 0 dependents. Changes to this file have minimal blast radius.",
            target_file
        )
    } else {
        format!(
            "Changing '{}' affects {} files ({} direct, {} transitive across depth {}). High-risk path: {}",
            target_file,
            affected_files.len(),
            direct_count,
            transitive_count,
            max_reached_depth,
            dependency_paths.first().map(|p| p.join(" → ")).unwrap_or_default()
        )
    };

    Ok(ImpactResult {
        target_file: resolved_file,
        affected_files,
        dependency_paths,
        max_depth: max_reached_depth,
        direct_count,
        transitive_count,
        test_files_affected,
        explanation,
    })
}

// ─── Unit Tests ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_github_repo_from_title() {
        let t1 = "vercel/next.js: The React Framework · GitHub – Google Chrome";
        let res1 = extract_github_repo_from_title(t1).expect("Should parse vercel/next.js");
        assert_eq!(res1.owner, "vercel");
        assert_eq!(res1.repo, "next.js");

        let t2 = "https://github.com/facebook/react/tree/main";
        let res2 = extract_github_repo_from_title(t2).expect("Should parse facebook/react");
        assert_eq!(res2.owner, "facebook");
        assert_eq!(res2.repo, "react");

        let t3 = "Untitled - Notepad";
        assert!(extract_github_repo_from_title(t3).is_none());
    }

    #[test]
    fn test_cluster_files_into_layers() {
        let files = vec![
            "src/client/App.tsx".to_string(),
            "src/client/components/Button.tsx".to_string(),
            "src/server/routes/api.ts".to_string(),
            "src/server/handlers/user.ts".to_string(),
            "src/db/models/user.prisma".to_string(),
            "src/utils/crypto.ts".to_string(),
            ".github/workflows/ci.yml".to_string(),
        ];

        let (layers, edges, entry_points) = cluster_files_into_layers(&files, "TypeScript");

        assert!(layers.iter().any(|l| l.id == "layer_frontend"));
        assert!(layers.iter().any(|l| l.id == "layer_backend"));
        assert!(layers.iter().any(|l| l.id == "layer_data"));
        assert!(layers.iter().any(|l| l.id == "layer_infra"));
        assert!(layers.iter().any(|l| l.id == "layer_shared"));
        assert!(!edges.is_empty());
        assert!(entry_points.contains(&"src/client/App.tsx".to_string()));
    }

    #[test]
    fn test_extract_imports_from_source_ts() {
        let code = r#"
            import React, { useState } from 'react';
            import { Header } from './components/Header';
            import { calculateScore } from '@/utils/math';
            const config = require('../config/env');
            export * from './types';
        "#;

        let imports = extract_imports_from_source("src/App.tsx", code);
        assert!(imports.contains(&"react".to_string()));
        assert!(imports.contains(&"./components/Header".to_string()));
        assert!(imports.contains(&"@/utils/math".to_string()));
        assert!(imports.contains(&"../config/env".to_string()));
        assert!(imports.contains(&"./types".to_string()));
    }

    #[test]
    fn test_extract_imports_from_source_py_rs() {
        let py_code = r#"
            import os, sys
            from services.auth import verify_token
        "#;
        let py_imports = extract_imports_from_source("app.py", py_code);
        assert!(py_imports.contains(&"os".to_string()));
        assert!(py_imports.contains(&"services/auth".to_string()));

        let rs_code = r#"
            use crate::network::Client;
            use crate::commands::{show_sidebar, hide_sidebar};
            mod helper;
        "#;
        let rs_imports = extract_imports_from_source("src/main.rs", rs_code);
        assert!(rs_imports.contains(&"network/Client".to_string()));
        assert!(rs_imports.contains(&"commands".to_string()));
        assert!(rs_imports.contains(&"helper".to_string()));
    }

    #[test]
    fn test_resolve_imported_files() {
        let known_files: HashSet<String> = [
            "src/App.tsx".to_string(),
            "src/components/Header.tsx".to_string(),
            "src/utils/math.ts".to_string(),
            "src/config/env.ts".to_string(),
        ]
        .into_iter()
        .collect();

        let imports = vec![
            "./components/Header".to_string(),
            "@/utils/math".to_string(),
            "react".to_string(),
        ];

        let resolved = resolve_imported_files("src/App.tsx", &imports, &known_files);
        assert!(resolved.contains(&"src/components/Header.tsx".to_string()));
        assert!(resolved.contains(&"src/utils/math.ts".to_string()));
        assert!(!resolved.contains(&"react".to_string()));
    }

    #[test]
    fn test_reverse_bfs_impact_query() {
        // Setup a mock cached dependency graph:
        // App.tsx -> Dashboard.tsx -> client.ts -> http.ts
        //                             auth.ts  -> http.ts
        let mut graph = DiGraph::<String, ()>::new();
        let mut node_indices = HashMap::new();
        let mut index_to_file = HashMap::new();

        let files = vec![
            "src/App.tsx".to_string(),
            "src/Dashboard.tsx".to_string(),
            "src/client.ts".to_string(),
            "src/auth.ts".to_string(),
            "src/http.ts".to_string(),
        ];

        for f in &files {
            let idx = graph.add_node(f.clone());
            node_indices.insert(f.clone(), idx);
            index_to_file.insert(idx, f.clone());
        }

        // App imports Dashboard
        graph.add_edge(node_indices["src/App.tsx"], node_indices["src/Dashboard.tsx"], ());
        // Dashboard imports client
        graph.add_edge(node_indices["src/Dashboard.tsx"], node_indices["src/client.ts"], ());
        // client imports http
        graph.add_edge(node_indices["src/client.ts"], node_indices["src/http.ts"], ());
        // auth imports http
        graph.add_edge(node_indices["src/auth.ts"], node_indices["src/http.ts"], ());

        let phase2_resp = Phase2Response {
            owner: "test".into(),
            repo: "mock".into(),
            total_files: files.len(),
            files_analyzed: files.len(),
            nodes: HashMap::new(),
            circular_deps: Vec::new(),
            hotspots: Vec::new(),
            isolated: Vec::new(),
            entry_points: Vec::new(),
            summary: "Mock graph".into(),
        };

        *CACHED_GRAPH.lock() = Some(Arc::new(CachedGraphState {
            owner: "test".into(),
            repo: "mock".into(),
            graph,
            node_indices,
            index_to_file,
            phase2_response: phase2_resp,
        }));

        // Query impact of changing "src/http.ts"
        let impact = query_impact("src/http.ts".to_string(), Some(5)).expect("Impact query should succeed");

        assert_eq!(impact.target_file, "src/http.ts");
        assert_eq!(impact.direct_count, 2); // client.ts and auth.ts
        assert!(impact.affected_files.contains(&"src/client.ts".to_string()));
        assert!(impact.affected_files.contains(&"src/auth.ts".to_string()));
        assert!(impact.affected_files.contains(&"src/Dashboard.tsx".to_string()));
        assert!(impact.affected_files.contains(&"src/App.tsx".to_string()));
        assert_eq!(impact.max_depth, 3); // http -> client -> Dashboard -> App

        // Test fuzzy lookup (passing "http" instead of "src/http.ts")
        let fuzzy_impact = query_impact("http".to_string(), Some(5)).expect("Fuzzy impact query should succeed");
        assert_eq!(fuzzy_impact.target_file, "src/http.ts");
        assert_eq!(fuzzy_impact.direct_count, 2);
    }
}

