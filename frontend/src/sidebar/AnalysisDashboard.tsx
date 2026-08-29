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
 * Shows pie charts for languages and frameworks, database info,
 * features list, and architecture summary.
 */
export function AnalysisDashboard({ data }: { data: RepoAnalysis }) {
  return (
    <div className="analysis-dashboard">
      {/* ── Overview Card ─────────────────────────────────── */}
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

      {/* ── Description ───────────────────────────────────── */}
      {data.description && data.description !== "No description provided." && (
        <div className="analysis-card">
          <div className="analysis-card-title">📝 Description</div>
          <p className="analysis-description">{data.description}</p>
        </div>
      )}

      {/* ── Languages (half donut chart) ─────────────────── */}
      {data.languages && data.languages.length > 0 && (
        <div className="analysis-card">
          <div className="analysis-card-title">🏗️ Languages</div>
          <LanguageChart languages={data.languages} />
        </div>
      )}

      {/* ── Frameworks (donut chart) ─────────────────────── */}
      {data.frameworks && data.frameworks.length > 0 && (
        <div className="analysis-card">
          <div className="analysis-card-title">⚡ Frameworks & Tools</div>
          <FrameworkChart frameworks={data.frameworks} />
        </div>
      )}

      {/* ── Databases ─────────────────────────────────────── */}
      {data.databases && data.databases.length > 0 && (
        <div className="analysis-card">
          <div className="analysis-card-title">🗄️ Databases</div>
          <div className="analysis-databases">
            {data.databases.map((db) => (
              <div key={db.name} className="analysis-database-item">
                <span className="analysis-database-name">{db.name}</span>
                <span className="analysis-database-evidence">{db.evidence}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Features ──────────────────────────────────────── */}
      {data.features && data.features.length > 0 && (
        <div className="analysis-card">
          <div className="analysis-card-title">✨ Features</div>
          <ul className="analysis-features">
            {data.features.map((feature, i) => (
              <li key={i} className="analysis-feature-item">
                {feature}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Architecture ──────────────────────────────────── */}
      {data.architecture && (
        <div className="analysis-card">
          <div className="analysis-card-title">🏗️ Architecture</div>
          <p className="analysis-architecture">{data.architecture}</p>
        </div>
      )}

      {/* ── Activity / Quality ────────────────────────────── */}
      <div className="analysis-card analysis-activity">
        <div className="analysis-card-title">📊 Quality & CI</div>
        <div className="analysis-activity-grid">
          <div className={`analysis-activity-item ${data.tests ? "yes" : "no"}`}>
            <span className="analysis-activity-icon">{data.tests ? "✅" : "❌"}</span>
            <span className="analysis-activity-label">Tests</span>
          </div>
          <div className={`analysis-activity-item ${data.ci !== "none" ? "yes" : "no"}`}>
            <span className="analysis-activity-icon">{data.ci !== "none" ? "✅" : "❌"}</span>
            <span className="analysis-activity-label">{data.ci !== "none" ? data.ci : "No CI"}</span>
          </div>
          <div className={`analysis-activity-item ${data.docker ? "yes" : "no"}`}>
            <span className="analysis-activity-icon">{data.docker ? "✅" : "❌"}</span>
            <span className="analysis-activity-label">Docker</span>
          </div>
        </div>
      </div>
    </div>
  );
}
