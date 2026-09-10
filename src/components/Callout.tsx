import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

const icons = { info: Info, success: CheckCircle2, warning: AlertTriangle, danger: XCircle };

export function Callout({ tone = 'info', title, children, actions }: { tone?: keyof typeof icons; title: string; children: ReactNode; actions?: ReactNode }) {
  const Icon = icons[tone];
  return <aside className={`callout callout-${tone}`}><Icon size={18} /><div className="callout-content"><strong>{title}</strong><div>{children}</div></div>{actions && <div className="callout-actions">{actions}</div>}</aside>;
}
