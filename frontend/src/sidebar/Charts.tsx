interface LanguageData {
  name: string;
  bytes: number;
  percentage: number;
}

export function LanguageChart({ languages }: { languages: LanguageData[] }) {
  if (!languages || languages.length === 0) {
    return <div className="analysis-no-data">No language data available</div>;
  }

  const top = languages.slice(0, 6);
  const restBytes = languages.slice(6).reduce((sum, l) => sum + l.bytes, 0);
  const restPct = languages.slice(6).reduce((sum, l) => sum + l.percentage, 0);
  if (restBytes > 0) {
    top.push({ name: "Other", bytes: restBytes, percentage: Math.round(restPct * 10) / 10 });
  }

  return (
    <div className="minimal-list">
      {top.map((l) => (
        <div key={l.name} className="minimal-list-item">
          <span className="minimal-list-name">{l.name}</span>
          <span className="minimal-list-value">{l.percentage}%</span>
        </div>
      ))}
    </div>
  );
}

export function FrameworkChart({
  frameworks,
}: {
  frameworks: { name: string; category: string }[];
}) {
  if (!frameworks || frameworks.length === 0) {
    return <div className="analysis-no-data">No framework data available</div>;
  }

  return (
    <div className="minimal-list">
      {frameworks.map((f) => (
        <div key={f.name} className="minimal-list-item">
          <span className="minimal-list-name">{f.name}</span>
          <span className="minimal-list-sub">{f.category}</span>
        </div>
      ))}
    </div>
  );
}
