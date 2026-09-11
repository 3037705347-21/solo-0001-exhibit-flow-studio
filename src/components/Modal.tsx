import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';

export function Modal({ title, eyebrow, onClose, children, footer, className = '' }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; className?: string }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}><div className="modal-header"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2></div><Button variant="ghost" icon={<X size={18} />} aria-label="Close dialog" onClick={onClose} /></div><div className="modal-body">{children}</div>{footer && <div className="modal-footer">{footer}</div>}</section></div>;
}
