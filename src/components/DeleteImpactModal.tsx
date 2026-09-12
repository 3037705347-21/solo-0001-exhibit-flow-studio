import { AlertTriangle, GitBranch, MapPin, Package, ShieldAlert } from 'lucide-react';
import { Button } from './Button';
import { Modal } from './Modal';
import type { DeleteImpact } from '../domain/lineage';

export function DeleteImpactModal({
  title,
  impact,
  onConfirm,
  onClose,
}: {
  title: string;
  impact: DeleteImpact;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const groups = [
    { label: 'Placement', items: impact.placements, icon: <MapPin size={13} /> },
    { label: 'Review finding', items: impact.findings, icon: <ShieldAlert size={13} /> },
    { label: 'Published package', items: impact.snapshots, icon: <Package size={13} /> },
  ].filter((group) => group.items.length > 0);

  return <Modal eyebrow="DELETE IMPACT" title={`Remove ${title}?`} onClose={onClose} footer={<>
    <Button variant="ghost" onClick={onClose}>Keep record</Button>
    <Button variant="danger" onClick={onConfirm}>Delete and flag dependents</Button>
  </>}>
    <div className="delete-impact">
      <div className="delete-impact-warning"><AlertTriangle size={18} /><p>This permanently deletes the object. Linked findings stay on the review desk marked <strong>needs re-review</strong>, placements are archived, and every downstream published package is flagged for re-review rather than shown as fully valid.</p></div>
      {groups.length === 0
        ? <p className="lineage-empty">No placements, findings, or published packages reference this object.</p>
        : groups.map((group) => <div className="impact-group" key={group.label}>
          <div className="eyebrow"><GitBranch size={11} /> {group.items.length} {group.label}{group.items.length === 1 ? '' : 's'}</div>
          {group.items.map((node) => <div className="impact-row" key={node.id}>
            {group.icon}
            <strong>{node.label}</strong>
            {node.staleReason && <span className="impact-flag">needs re-review</span>}
          </div>)}
        </div>)}
    </div>
  </Modal>;
}
