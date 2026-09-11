import { AlertTriangle, ArrowLeftRight, CheckCircle2, FileInput, GitBranch, MapPin, Trash2 } from 'lucide-react';
import { Badge } from './Badge';
import { Button } from './Button';
import { staleReasonLabel, type RecordLineage } from '../domain/lineageView';
import type { LineageNode } from '../domain/models';

const TYPE_LABELS: Record<LineageNode['type'], string> = {
  artifact: 'Object',
  placement: 'Placement',
  issue: 'Finding',
  snapshot: 'Published package',
  batch: 'Import file',
};

function HealthBadge({ health }: { health: RecordLineage['health'] }) {
  if (health === 'deleted') return <Badge tone="danger"><Trash2 size={10} /> Source gone</Badge>;
  if (health === 'needs-review') return <Badge tone="warning"><AlertTriangle size={10} /> Needs re-review</Badge>;
  return <Badge tone="positive"><CheckCircle2 size={10} /> Current</Badge>;
}

function LineageRow({ item }: { item: { node: LineageNode; health: RecordLineage['health']; detail: string } }) {
  return <div className="lineage-row">
    <span className={`lineage-dot lineage-dot-${item.health}`} />
    <span className="lineage-row-main"><strong>{item.node.label}</strong><small>{TYPE_LABELS[item.node.type]} · {item.detail}</small></span>
    <HealthBadge health={item.health} />
  </div>;
}

export function LineagePanel({
  view,
  onAcknowledge,
  compact = false,
}: {
  view: RecordLineage;
  onAcknowledge?: () => void;
  compact?: boolean;
}) {
  if (!view.node) return null;
  const originLabel = view.importBatch
    ? `Imported from ${view.importBatch.batchFileName ?? 'file'}`
    : view.node.origin === 'seed'
      ? 'Part of the built-in sample plan'
      : view.node.origin === 'backfill'
        ? 'Recovered from the workspace in use before provenance'
        : 'Directly created in this workspace';
  return <div className={`lineage-panel ${compact ? 'compact' : ''}`}>
    <div className="lineage-panel-head">
      <div className="eyebrow"><GitBranch size={11} /> Provenance & dependencies</div>
      <HealthBadge health={view.health} />
    </div>
    {view.staleReason && <div className="lineage-stale-banner">
      <AlertTriangle size={14} />
      <span>{staleReasonLabel(view.staleReason)}</span>
      {onAcknowledge && <Button variant="secondary" onClick={onAcknowledge}>Mark reviewed</Button>}
    </div>}
    <div className="lineage-origin"><FileInput size={13} /><span>{originLabel}</span></div>
    {view.node.type === 'placement' && view.node.contextLabel && (
      <div className="lineage-origin"><MapPin size={13} /><span>Carried in {view.node.contextLabel}</span></div>
    )}
    {!compact && view.sources.length > 0 && <div className="lineage-group">
      <div className="eyebrow">Direct sources</div>
      {view.sources.map((item) => <LineageRow key={item.node.id} item={item} />)}
    </div>}
    {!compact && view.sourceClosure.length > view.sources.length && <div className="lineage-group">
      <div className="eyebrow">Full source closure</div>
      {view.sourceClosure
        .filter((item) => !view.sources.some((source) => source.node.id === item.node.id))
        .map((item) => <LineageRow key={item.node.id} item={item} />)}
    </div>}
    {view.dependents.length > 0 && <div className="lineage-group">
      <div className="eyebrow"><ArrowLeftRight size={11} /> Downstream records ({view.dependents.length})</div>
      {view.dependents.map((item) => <LineageRow key={item.node.id} item={item} />)}
    </div>}
    {!compact && view.sources.length === 0 && view.dependents.length === 0 && (
      <p className="lineage-empty">No other records reference this one yet.</p>
    )}
  </div>;
}
