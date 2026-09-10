export function Donut({
  value,
  color = '#2f7c75',
  label,
}: {
  value: number;
  color?: string;
  label: string;
}) {
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 100 100" className="donut">
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#e7e5df" strokeWidth="9" />
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.max(0, Math.min(1, value)))}
          transform="rotate(-90 50 50)"
        />
      </svg>
      <div className="donut-center">
        <strong>{Math.round(value * 100)}%</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}
