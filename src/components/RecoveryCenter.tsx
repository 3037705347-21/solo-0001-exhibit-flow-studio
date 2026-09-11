import { AlertTriangle, ArchiveRestore, History, RotateCcw, ShieldAlert, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type RestoreAnalysis } from '../domain/deletion';
import { formatDate } from '../domain/formatters';
import type { DeletionRecord, RestoreConflict, RestoreDecision } from '../domain/models';
import { useWorkspace } from '../state/WorkspaceContext';
import { Badge } from './Badge';
import { Button } from './Button';
import { Modal } from './Modal';

const KIND_LABEL: Record<DeletionRecord['kind'], string> = {
  artifact: 'Object',
  zone: 'Exhibition area',
  issue: 'Finding',
};

const DECISION_LABEL: Record<RestoreDecision, string> = {
  restore: 'Restore recorded version',
  overwrite: 'Overwrite current state',
  skip: 'Skip / keep current state',
  detach: 'Restore without the link',
};

export function RecoveryCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useWorkspace();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!open) return null;

  const records = state.deletionRecords;

  return <Modal
    eyebrow="AUDIT & RECOVERY"
    title="Recovery center"
    onClose={onClose}
    footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
  >
    <div className="recovery-center">
      <p className="delete-flow-copy">Deletes stay recoverable for <strong>7 days</strong>. Records remain here for a 30-day audit trail. Exported packages are append-only and are never altered by a delete or restore.</p>
      {records.length === 0 && <div className="recovery-empty"><History size={22} /><p>No deletions have been recorded in this workspace yet.</p></div>}
      {records.length > 0 && <div className="recovery-list">
        {records.map((record) => <RecoveryRow key={record.id} record={record} selected={selectedId === record.id} onSelect={() => setSelectedId(record.id)} onDismiss={() => setSelectedId(null)} />)}
      </div>}
    </div>
  </Modal>;
}

function RecoveryRow({ record, selected, onSelect, onDismiss }: { record: DeletionRecord; selected: boolean; onSelect: () => void; onDismiss: () => void }) {
  const { getDeletionStatus } = useWorkspace();
  const status = getDeletionStatus(record);
  const referenceCount = record.placements.length + record.cascadeIssues.length + record.detachments.length;
  return <article className={`recovery-row ${selected ? 'selected' : ''} status-${status}`}>
    <div className="recovery-row-main" onClick={onSelect}>
      <div className="recovery-row-icon">{record.kind === 'artifact' ? <Trash2 size={15} /> : record.kind === 'zone' ? <History size={15} /> : <AlertTriangle size={15} />}</div>
      <div className="recovery-row-copy">
        <div className="recovery-row-title"><strong>{record.targetLabel}</strong><Badge tone={status === 'recoverable' ? 'positive' : status === 'expired' ? 'warning' : 'info'}>{status}</Badge></div>
        <div className="recovery-row-meta">
          <span>{KIND_LABEL[record.kind]}</span>
          <span>deleted {formatDate(record.deletedAt)}</span>
          {referenceCount > 0 && <span>{referenceCount} linked reference{referenceCount === 1 ? '' : 's'}</span>}
          {record.publishedPackageIds.length > 0 && <span>{record.publishedPackageIds.length} published package{record.publishedPackageIds.length === 1 ? '' : 's'}</span>}
        </div>
      </div>
    </div>
    <div className="recovery-row-action">
      {status === 'recoverable' && <Button variant="secondary" icon={<ArchiveRestore size={14} />} onClick={onSelect}>Review &amp; restore</Button>}
      {status === 'restored' && <span className="recovery-restored-at">Restored {record.restoredAt ? formatDate(record.restoredAt) : ''}</span>}
      {status === 'expired' && <span className="recovery-expired">Recovery window closed</span>}
    </div>
    {selected && status === 'recoverable' && <RestorePanel record={record} onDismiss={onDismiss} />}
  </article>;
}

function RestorePanel({ record, onDismiss }: { record: DeletionRecord; onDismiss: () => void }) {
  const { analyzeRestore, restoreDeletion } = useWorkspace();
  const [decisions, setDecisions] = useState<Record<string, RestoreDecision>>({});
  const [appliedNote, setAppliedNote] = useState<string | null>(null);

  const result = useMemo(() => analyzeRestore(record.id), [analyzeRestore, record.id]);
  if (!result.ok || !result.value) {
    return <div className="restore-panel field-error">{result.message ?? 'This deletion cannot be reviewed.'}</div>;
  }
  const analysis: RestoreAnalysis = result.value;

  const blockingUnresolved = analysis.conflicts.some(
    (item) => item.severity === 'blocking' && !(item.id in decisions),
  );
  const setDecision = (conflictId: string, decision: RestoreDecision) => setDecisions((current) => ({ ...current, [conflictId]: decision }));

  const runRestore = () => {
    const response = restoreDeletion(record.id, decisions);
    if (!response.ok) { setAppliedNote(response.message ?? 'Restore could not be completed.'); return; }
    setAppliedNote('Restored. Review the current plan before continuing.');
    window.setTimeout(onDismiss, 1400);
  };

  return <div className="restore-panel">
    {analysis.conflicts.length === 0
      ? <div className="restore-conflict-none"><ShieldAlert size={15} /><span>Nothing on the current plan conflicts with this deletion. The exact recorded state can be restored.</span></div>
      : <>
        <div className="restore-conflict-head">
          <div className="eyebrow">CONFLICTS WITH THE CURRENT PLAN</div>
          <p>The source data changed after the delete{analysis.hasBlocking ? '; resolve the blocking choice before restoring' : ''}. The current state is never overwritten without an explicit choice.</p>
        </div>
        <div className="restore-conflict-list">
          {analysis.conflicts.map((item) => <ConflictChoice key={item.id} conflict={item} chosen={decisions[item.id]} onChange={(decision) => setDecision(item.id, decision)} />)}
        </div>
      </>}
    <div className="restore-actions">
      <Button variant="ghost" onClick={onDismiss}>Cancel</Button>
      <Button variant="primary" icon={<RotateCcw size={15} />} disabled={blockingUnresolved} onClick={runRestore}>
        {blockingUnresolved ? 'Resolve blocking conflicts first' : 'Restore now'}
      </Button>
    </div>
    {appliedNote && <div className={`restore-note ${appliedNote.startsWith('Restored') ? 'ok' : ''}`}>{appliedNote}</div>}
  </div>;
}

function ConflictChoice({ conflict, chosen, onChange }: { conflict: RestoreConflict; chosen?: RestoreDecision; onChange: (decision: RestoreDecision) => void }) {
  // Warning conflicts carry a safe default; blocking ones start unchosen so a
  // restore can never proceed on a decision nobody explicitly made.
  const effective = chosen ?? (conflict.severity === 'blocking' ? undefined : conflict.decision);
  return <section className={`restore-conflict ${conflict.severity}`}>
    <div className="restore-conflict-title">
      <Badge tone={conflict.severity === 'blocking' ? 'danger' : 'warning'}>{conflict.severity}</Badge>
      <strong>{conflict.subjectLabel}</strong>
    </div>
    <p>{conflict.message}</p>
    <div className="restore-options" role="radiogroup" aria-label={`Resolution for ${conflict.subjectLabel}`}>
      {conflict.options.map((option) => <label key={option} className="restore-option">
        <input
          type="radio"
          name={`conflict-${conflict.id}`}
          checked={effective === option}
          onChange={() => onChange(option)}
        />
        <span>{DECISION_LABEL[option]}</span>
      </label>)}
    </div>
  </section>;
}
