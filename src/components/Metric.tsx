import type { ReactNode } from 'react';

export function Metric({ label, value, detail, icon, tone = 'default' }: { label: string; value: string; detail?: string; icon?: ReactNode; tone?: 'default' | 'teal' | 'red' | 'amber' }) {
  return <div className={`metric metric-${tone}`}><div className="metric-top"><span className="metric-label">{label}</span>{icon && <span className="metric-icon">{icon}</span>}</div><strong>{value}</strong>{detail && <span className="metric-detail">{detail}</span>}</div>;
}
