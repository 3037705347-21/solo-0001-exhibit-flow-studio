import { CheckCircle2, Download, RotateCcw, ShieldAlert, XCircle } from 'lucide-react';
import { Button } from '../../../components/Button';
import { formatDate } from '../../../domain/formatters';
import type { ReadinessResult } from '../../../domain/models';

interface ReadinessPanelProps {
  readiness: ReadinessResult;
  onCheck: () => void;
  onExportSnapshot: () => void;
}

export function ReadinessPanel({ readiness, onCheck, onExportSnapshot }: ReadinessPanelProps) {
  return <>
    <section className={`readiness-card ${readiness.ready ? 'ready' : 'blocked'}`}><div className="readiness-icon">{readiness.ready ? <CheckCircle2 size={28} /> : <ShieldAlert size={28} />}</div><div className="readiness-copy"><div className="eyebrow">READINESS CHECK · {readiness.checkedAt ? formatDate(readiness.checkedAt) : 'not run'}</div><h2>{readiness.ready ? 'Ready to share' : 'Still needs attention'}</h2><p>{readiness.ready ? 'The journey and review desk have no blocking conditions.' : `${readiness.blockers.length} blocking condition${readiness.blockers.length === 1 ? '' : 's'} prevent this plan from being marked ready.`}</p></div><div className="readiness-score"><strong>{readiness.score}</strong><span>readiness score</span></div><div className="readiness-actions">{readiness.ready ? <Button variant="primary" icon={<Download size={16} />} onClick={onExportSnapshot}>Export snapshot</Button> : <Button variant="secondary" icon={<RotateCcw size={16} />} onClick={onCheck}>Re-check plan</Button>}</div></section>
    {!readiness.ready && <section className="blocker-list"><div className="eyebrow">WHAT IS BLOCKING</div>{readiness.blockers.map((blocker) => <div className="blocker-row" key={blocker}><XCircle size={16} /><span>{blocker}</span></div>)}</section>}
  </>;
}
