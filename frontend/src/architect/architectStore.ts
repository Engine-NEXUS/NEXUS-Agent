import { create } from "zustand";

export interface ArchitectLayer {
  id: string;
  label: string;
  layer_type: "frontend" | "backend" | "database" | "infra" | "shared" | string;
  dirs: string[];
  tech_stack: string;
  file_count: number;
  sample_files: string[];
}

export interface ArchitectEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  edge_type?: "imports" | "calls" | "configures" | string;
}

export interface Phase1Data {
  owner: string;
  repo: string;
  default_branch: string;
  primary_language: string;
  description: string;
  summary: string;
  layers: ArchitectLayer[];
  edges: ArchitectEdge[];
  entry_points: string[];
  total_files: number;
  /** Sample file paths for LLM enrichment (not used for rendering). */
  sample_file_paths?: string[];
}

export interface FileNodeInfo {
  file_path: string;
  layer_id?: string | null;
  in_degree: number;
  out_degree: number;
  imports: string[];
  imported_by: string[];
  is_hotspot: boolean;
  risk_level: "normal" | "medium" | "high" | "critical" | string;
  is_circular: boolean;
}

export interface CircularDependency {
  chain: string[];
  risk: string;
}

export interface HotspotItem {
  file: string;
  in_degree: number;
  risk: "high" | "critical" | string;
}

export interface Phase2Data {
  owner: string;
  repo: string;
  total_files: number;
  files_analyzed: number;
  nodes: Record<string, FileNodeInfo>;
  circular_deps: CircularDependency[];
  hotspots: HotspotItem[];
  isolated: string[];
  entry_points: string[];
  summary: string;
}

export interface ImpactResult {
  target_file: string;
  affected_files: string[];
  dependency_paths: string[][];
  max_depth: number;
  direct_count: number;
  transitive_count: number;
  test_files_affected: string[];
  explanation: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: number;
  highlightedNodes?: string[];
}

export type ViewMode = "layers" | "files" | "hotspots" | "cycles";

interface ArchitectState {
  owner: string;
  repo: string;
  phase: 0 | 1 | 2 | 3;
  loading: boolean;
  deepScanning: boolean;
  progressStage: string;
  progressMessage: string;
  phase1Data: Phase1Data | null;
  phase2Data: Phase2Data | null;
  selectedNodeId: string | null;
  impactResult: ImpactResult | null;
  highlightedPaths: string[][];
  viewMode: ViewMode;
  chatMessages: ChatMessage[];
  searchQuery: string;

  setRepo: (owner: string, repo: string) => void;
  setPhase: (phase: 0 | 1 | 2 | 3) => void;
  setLoading: (loading: boolean) => void;
  setDeepScanning: (deepScanning: boolean) => void;
  setProgress: (stage: string, message: string) => void;
  setPhase1Data: (data: Phase1Data) => void;
  enrichPhase1: (enrichment: { summary: string; layers: { id: string; label: string; tech_stack: string }[] }) => void;
  setPhase2Data: (data: Phase2Data) => void;
  setSelectedNodeId: (nodeId: string | null) => void;
  setImpactResult: (result: ImpactResult | null) => void;
  setHighlightedPaths: (paths: string[][]) => void;
  setViewMode: (mode: ViewMode) => void;
  addChatMessage: (msg: Omit<ChatMessage, "id" | "timestamp">) => void;
  setSearchQuery: (query: string) => void;
  reset: () => void;
}

export const useArchitect = create<ArchitectState>((set) => ({
  owner: "",
  repo: "",
  phase: 0,
  loading: false,
  deepScanning: false,
  progressStage: "",
  progressMessage: "",
  phase1Data: null,
  phase2Data: null,
  selectedNodeId: null,
  impactResult: null,
  highlightedPaths: [],
  viewMode: "layers",
  chatMessages: [
    {
      id: "welcome",
      role: "assistant",
      text: "👋 Welcome to **NEXUS Architecture Mapper**. Select or enter a repository to generate an interactive visual map of its architecture.",
      timestamp: Date.now(),
    },
  ],
  searchQuery: "",

  setRepo: (owner, repo) => set({ owner, repo }),
  setPhase: (phase) => set({ phase }),
  setLoading: (loading) => set({ loading }),
  setDeepScanning: (deepScanning) => set({ deepScanning }),
  setProgress: (stage, message) => set({ progressStage: stage, progressMessage: message }),
  setPhase1Data: (data) =>
    set({
      phase1Data: data,
      owner: data.owner,
      repo: data.repo,
      phase: 1,
      loading: false,
      progressStage: "complete",
      progressMessage: "Phase 1 visual map ready",
    }),
  enrichPhase1: (enrichment) =>
    set((state) => {
      if (!state.phase1Data) return {};
      const updatedLayers = state.phase1Data.layers.map((layer) => {
        const enriched = enrichment.layers.find((e) => e.id === layer.id);
        if (!enriched) return layer;
        return {
          ...layer,
          label: enriched.label || layer.label,
          tech_stack: enriched.tech_stack || layer.tech_stack,
        };
      });
      return {
        phase1Data: {
          ...state.phase1Data,
          summary: enrichment.summary || state.phase1Data.summary,
          layers: updatedLayers,
        },
      };
    }),
  setPhase2Data: (data) =>
    set({
      phase2Data: data,
      phase: 2,
      deepScanning: false,
      progressStage: "complete",
      progressMessage: "Phase 2 deep scan complete",
    }),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setImpactResult: (impactResult) => set({ impactResult }),
  setHighlightedPaths: (highlightedPaths) => set({ highlightedPaths }),
  setViewMode: (viewMode) => set({ viewMode }),
  addChatMessage: (msg) =>
    set((state) => ({
      chatMessages: [
        ...state.chatMessages,
        {
          ...msg,
          id: Math.random().toString(36).substring(2, 9),
          timestamp: Date.now(),
        },
      ],
    })),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  reset: () =>
    set({
      owner: "",
      repo: "",
      phase: 0,
      loading: false,
      deepScanning: false,
      progressStage: "",
      progressMessage: "",
      phase1Data: null,
      phase2Data: null,
      selectedNodeId: null,
      impactResult: null,
      highlightedPaths: [],
      viewMode: "layers",
    }),
}));
