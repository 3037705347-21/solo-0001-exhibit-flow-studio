import { AlertTriangle, ArchiveRestore, History, ShieldAlert, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DeletionImpactGroup, DeletionPlan } from '../domain/deletion';
import type { DeletionRecord } from '../domain/models';
import { useWorkspace } from '../state/WorkspaceContext';
import { Badge } from './Badge';
import { Button } from './Button';
import { Modal } from './Modal';

const KIND_LABEL: Record<DeletionRecord['kind'], string> = {
  artifact: 'object',
  zone: 'exhibition area',
  issue: 'finding',
};

export function DeleteFlowDialog({
  kind,
  targetId,
  targetLabel,
  onClose,
  onDeleted,
}: {
  kind: DeletionRecord['kind'];
  targetId: string;
  targetLabel: string;
  onClose: () => void;
  onDeleted?: (record: DeletionRecord) => void;
}) {
  const { planDeletion, executeDeletion } = useWorkspace();
  const [error, setError] = useState<string | null>(null);

  const result = useMemo(() => planDeletion(kind, targetId), [planDeletion, kind, targetId]);

  if (!result.ok || !result.value) {
    return <Modal eyebrow="DELETE" title="Nothing to delete" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      <p className="delete-flow-copy">{result.message ?? 'This record is no longer available.'}</p>
    </Modal>;
  }

  const plan: DeletionPlan = result.value;
  const confirm = () => {
    const response = executeDeletion(plan);
    if (!response.ok || !response.value) {
      setError(response.message ?? 'The delete could not be completed.');
      return;
    }
    onDeleted?.(response.value);
    onClose();
  };

  return <Modal
    eyebrow={`DELETE ${KIND_LABEL[kind].toUpperCase()}`}
    title={`Delete ${KIND_LABEL[kind]}`}
    onClose={onClose}
    footer={<>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="danger" icon={<Trash2 size={15} />} onClick={confirm}>Delete {KIND_LABEL[kind]}</Button>
    </>}
  >
    <div className="delete-flow">
      <div className="delete-target-line"><ShieldAlert size={16} /><span>You are deleting <strong>{targetLabel}</strong>. Here is exactly what changes after the delete.</span></div>
      {plan.isolated && <div className="delete-impact-group delete-empty-impact">
        <div className="eyebrow">NOTHING ELSE REFERENCES THIS RECORD</div>
        <p>No placements, findings, sign-offs, or exported materials depend on this {KIND_LABEL[kind]}. Only this single record is removed.</p>
      </div>}
      {plan.groups.map((group) => <ImpactGroupBlock key={group.key} group={group} />)}
      <div className="delete-recovery-note"><History size={15} /><span>The delete is logged in the <strong>Recovery center</strong> in the sidebar and can be fully undone for <strong>7 days</strong>. Historical export packages are never rewritten.</span></div>
      {error && <div className="field-error">{error}</div>}
    </div>
  </Modal>;
}

function ImpactGroupBlock({ group }: { group: DeletionImpactGroup }) {
  const tone = group.key === 'signoff' ? 'warning' : group.key === 'publishedPackages' ? 'neutral' : 'danger';
  return <section className="delete-impact-group">
    <div className="delete-impact-head">
      <div><div className="eyebrow">{group.label.toUpperCase()}</div><p>{group.detail}</p></div>
      <Badge tone={tone}>{group.items.length}</Badge>
    </div>
    <ul className="delete-impact-items">
      {group.items.map((item, index) => <li key={`${group.key}-${index}`}>{item}</li>)}
    </ul>
  </section>;
}

export function DeletedToast({ record, onOpenRecovery, onDismiss }: { record: DeletionRecord; onOpenRecovery: () => void; onDismiss: () => void }) {
  const { restoreDeletion } = useWorkspace();
  const [notice, setNotice] = useState<string | null>(null);

  const undo = () => {
    const result = restoreDeletion(record.id);
    if (result.ok) { onDismiss(); return; }
    setNotice(result.message ?? 'This delete needs conflict review in the Recovery center.');
    window.setTimeout(() => { setNotice(null); onOpenRecovery(); }, 1800);
  };

  return <div className="toast toast-delete" role="status">
    <AlertTriangle size={16} />
    <div className="toast-delete-copy">
      <strong>“{record.targetLabel}” deleted.</strong>
      <span>{notice ?? 'It can be restored for 7 days from the Recovery center.'}</span>
    </div>
    {!notice && <Button variant="secondary" icon={<ArchiveRestore size={14} />} onClick={undo}>Undo</Button>}
    {!notice && <Button variant="ghost" onClick={onDismiss}>Dismiss</Button>}
  </div>;
}
