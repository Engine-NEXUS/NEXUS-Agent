import { LanguageChart, FrameworkChart } from "./Charts";

/**
 * Analysis data structure returned by the Worker.
 */
interface RepoAnalysis {
  repo: string;
  visibility: string;
  description: string;
  stars: number;
  forks: number;
  totalFiles: number;
  languages: { name: string; bytes: number; percentage: number }[];
  frameworks: { name: string; category: string }[];
  databases: { name: string; evidence: string }[];
  features: string[];
  tests: boolean;
  ci: string;
  docker: boolean;
  architecture: string;
  defaultBranch: string;
}

/**
 * Rich repository analysis dashboard.
 * Renders in the NEXUS sidebar when the user says "analyse owner/repo".
 * Minimalist design without colorful charts or emojis in headings.
 */
export function AnalysisDashboard({ data }: { data: RepoAnalysis }) {
  return (
    <div className="analysis-dashboard">
      {/* ── Overview Card ── */}
      <div className="analysis-card analysis-overview">
        <div className="analysis-card-icon">📦</div>
        <div className="analysis-overview-stats">
          <span className="analysis-badge analysis-badge--visibility">
            {data.visibility === "private" ? "🔒 Private" : "🌐 Public"}
          </span>
          <span className="analysis-badge">⭐ {data.stars} stars</span>
          <span className="analysis-badge">🍴 {data.forks} forks</span>
          <span className="analysis-badge">📁 {data.totalFiles} files</span>
          <span className="analysis-badge">🌿 {data.defaultBranch}</span>
        </div>
      </div>

      {/* ── Description ── */}
      {data.description && data.description !== "No description provided." && (
        <div className="analysis-card">
          <div className="analysis-card-title">DESCRIPTION</div>
          <p className="analysis-description">{data.description}</p>
        </div>
      )}

      {/* ── Languages ── */}
      {data.languages && data.languages.length > 0 && (
        <div className="analysis-card">
          <div className="analysis-card-title">LANGUAGES</div>
          <LanguageChart languages={data.languages} />
        </div>
      )}

      {/* ── Frameworks ── */}
      {data.frameworks && data.frameworks.length > 0 && (
        <div className="analysis-card">
          <div className="analysis-card-title">FRAMEWORKS & TOOLS</div>
          <FrameworkChart frameworks={data.frameworks} />
        </div>
      )}

      {/* ── Databases ── */}
      {data.databases && data.databases.length > 0 && (
        <div className="analysis-card">
          <div className="analysis-card-title">DATABASES</div>
          <div className="minimal-list">
            {data.databases.map((db) => (
              <div key={db.name} className="minimal-list-item">
                <span className="minimal-list-name">{db.name}</span>
                <span className="minimal-list-sub">{db.evidence}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Features ── */}
      {data.features && data.features.length > 0 && (
        <div className="analysis-card">
          <div className="analysis-card-title">FEATURES</div>
          <ul className="analysis-features-minimal">
            {data.features.map((feature, i) => (
              <li key={i} className="analysis-feature-item-minimal">
                {feature}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Architecture ── */}
      {data.architecture && (
        <div className="analysis-card">
          <div className="analysis-card-title">ARCHITECTURE</div>
          <p className="analysis-architecture">{data.architecture}</p>
        </div>
      )}

      {/* ── Activity / Quality ── */}
      <div className="analysis-card analysis-activity">
        <div className="analysis-card-title">QUALITY & CI</div>
        <div className="minimal-list">
          <div className="minimal-list-item">
            <span className="minimal-list-name">Tests</span>
            <span className="minimal-list-value">{data.tests ? "Yes" : "No"}</span>
          </div>
          <div className="minimal-list-item">
            <span className="minimal-list-name">CI</span>
            <span className="minimal-list-value">{data.ci !== "none" ? data.ci : "None"}</span>
          </div>
          <div className="minimal-list-item">
            <span className="minimal-list-name">Docker</span>
            <span className="minimal-list-value">{data.docker ? "Yes" : "No"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
