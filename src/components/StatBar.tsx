export function StatBar({
  label,
  value,
  maximum,
  detail,
  color = '#2f7c75',
}: {
  label: string;
  value: number;
  maximum: number;
  detail?: string;
  color?: string;
}) {
  const ratio = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
  return (
    <div className="stat-bar">
      <div className="stat-bar-head">
        <strong>{label}</strong>
        <span>{detail ?? `${value} / ${maximum}`}</span>
      </div>
      <div className="stat-bar-track">
        <div
          className="stat-bar-fill"
          style={{ width: `${ratio * 100}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}
