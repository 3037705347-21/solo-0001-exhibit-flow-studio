import type { ReactNode } from 'react';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'positive' | 'warning' | 'danger' | 'info';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
