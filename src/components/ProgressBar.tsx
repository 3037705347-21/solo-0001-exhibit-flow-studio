export function ProgressBar({ value, tone = 'teal' }: { value: number; tone?: 'teal' | 'amber' | 'red' }) {
  return <div className="progress-track"><div className={`progress-fill progress-${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>;
}
