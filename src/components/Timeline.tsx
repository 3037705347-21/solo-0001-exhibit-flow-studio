import type { ReactNode } from 'react';

export interface TimelineItem { id: string; title: string; detail: string; meta?: string; icon?: ReactNode; tone?: 'neutral' | 'active' | 'complete' }

export function Timeline({ items }: { items: TimelineItem[] }) {
  return <ol className="timeline">{items.map((item, index) => <li key={item.id} className={`timeline-${item.tone ?? 'neutral'}`}><div className="timeline-rail"><span className="timeline-marker">{item.icon ?? index + 1}</span>{index < items.length - 1 && <span className="timeline-line" />}</div><div className="timeline-copy"><strong>{item.title}</strong><p>{item.detail}</p>{item.meta && <small>{item.meta}</small>}</div></li>)}</ol>;
}
