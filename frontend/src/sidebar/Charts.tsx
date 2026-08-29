import { PieChart } from "react-minimal-pie-chart";

/**
 * GitHub-style language colors.
 * Source: https://github.com/ozh/github-colors
 */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Go: "#00ADD8",
  Java: "#b07219",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  HTML: "#e34c26",
  CSS: "#563d7c",
  SCSS: "#c6538c",
  Vue: "#41b883",
  Shell: "#89e051",
  Dockerfile: "#384d54",
  Lua: "#000080",
  HCL: "#844FBA",
  Other: "#8b8b8b",
};

function getColor(name: string): string {
  return LANGUAGE_COLORS[name] || LANGUAGE_COLORS.Other;
}

interface LanguageData {
  name: string;
  bytes: number;
  percentage: number;
}

/**
 * Half-donut chart for language distribution.
 * Shows the top languages with their percentages in a semi-circle.
 */
export function LanguageChart({ languages }: { languages: LanguageData[] }) {
  if (!languages || languages.length === 0) {
    return <div className="analysis-no-data">No language data available</div>;
  }

  // Show top 6 languages, group the rest as "Other"
  const top = languages.slice(0, 6);
  const restBytes = languages.slice(6).reduce((sum, l) => sum + l.bytes, 0);
  const restPct = languages.slice(6).reduce((sum, l) => sum + l.percentage, 0);
  if (restBytes > 0) {
    top.push({ name: "Other", bytes: restBytes, percentage: Math.round(restPct * 10) / 10 });
  }

  const chartData = top.map((l) => ({
    title: l.name,
    value: l.percentage,
    color: getColor(l.name),
  }));

  return (
    <div className="language-chart-container">
      <div className="language-chart-visual">
        <PieChart
          data={chartData}
          startAngle={180}
          lengthAngle={180}
          lineWidth={45} // Slightly thinner for elegance
          paddingAngle={2} // Small gap between slices
          rounded
          animate
          center={[50, 50]}
          label={({ dataEntry }) =>
            dataEntry.percentage >= 10 ? `${dataEntry.percentage}%` : ""
          }
          labelStyle={{
            fontSize: "5px",
            fill: "#fff",
            fontWeight: "bold",
            pointerEvents: "none",
          }}
          labelPosition={70}
          viewBoxSize={[100, 50]}
          background="#ffffff08"
        />
      </div>
      <div className="language-chart-legend">
        {top.map((l) => (
          <div key={l.name} className="language-legend-item">
            <span
              className="language-legend-dot"
              style={{ backgroundColor: getColor(l.name) }}
            />
            <span className="language-legend-name">{l.name}</span>
            <span className="language-legend-pct">{l.percentage}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Donut chart for frameworks (equal slices, visual indicator).
 */
export function FrameworkChart({
  frameworks,
}: {
  frameworks: { name: string; category: string }[];
}) {
  if (!frameworks || frameworks.length === 0) {
    return <div className="analysis-no-data">No framework data available</div>;
  }

  const CATEGORY_COLORS: Record<string, string> = {
    frontend: "#61dafb",
    backend: "#68a063",
    desktop: "#ff9e64",
    styling: "#38bdf8",
    state: "#764abc",
    testing: "#c21325",
    build: "#646cff",
    language: "#3178c6",
    runtime: "#76e24d",
    serialization: "#dd6b20",
    database: "#336791",
  };

  function getCategoryColor(cat: string): string {
    return CATEGORY_COLORS[cat] || "#8b8b8b";
  }

  const chartData = frameworks.map((f) => ({
    title: f.name,
    value: 1, // Equal slices
    color: getCategoryColor(f.category),
  }));

  return (
    <div className="framework-chart-container">
      <div className="framework-chart-visual">
        <PieChart
          data={chartData}
          lineWidth={40} // Thinner for elegance
          paddingAngle={2}
          rounded
          animate
          viewBoxSize={[100, 100]} // Must be 100x100 to fit radius 50
          background="#ffffff08"

        />
      </div>
      <div className="framework-chart-legend">
        {frameworks.map((f) => (
          <div key={f.name} className="framework-legend-item">
            <span
              className="framework-legend-dot"
              style={{ backgroundColor: getCategoryColor(f.category) }}
            />
            <span className="framework-legend-name">{f.name}</span>
            <span className="framework-legend-cat">{f.category}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
