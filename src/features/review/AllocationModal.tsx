import { ArrowRight, CheckCircle2, RefreshCw, Scale, Send, ShieldAlert, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { formatDate, titleCase } from '../../domain/formatters';
import type { AllocationConflict, AllocationPlan, OwnerLoad } from '../../domain/workload';
import {
  ownerOptions,
  previewWorkload,
  rebalanceDraft,
  refreshAllocationDraft,
  setDraftTarget,
} from '../../domain/workload';
import type { WorkspaceState } from '../../domain/models';
import { useWorkspace } from '../../state/WorkspaceContext';

interface AllocationModalProps {
  state: WorkspaceState;
  draft: AllocationPlan;
  onDraftChange: (draft: AllocationPlan) => void;
  onClose: () => void;
  onApplied: (message: string, tone: 'positive' | 'warning') => void;
}

const CONFLICT_LABEL: Record<AllocationConflict['type'], string> = {
  missing: 'Finding removed',
  'status-changed': 'Status changed',
  'owner-changed': 'Owner changed elsewhere',
  'version-stale': 'Newer revision',
  'invalid-target': 'Owner required',
};

const SEVERITY_TONE = { critical: 'danger', warning: 'warning', note: 'neutral' } as const;

export function AllocationModal({ state, draft, onDraftChange, onClose, onApplied }: AllocationModalProps) {
  const { commitAllocationPlan } = useWorkspace();
  const [pending, setPending] = useState(false);

  const zones = useMemo(() => new Map(state.zones.map((zone) => [zone.id, zone.shortLabel || zone.name])), [state.zones]);
  const preview = useMemo(() => previewWorkload(state, draft), [state, draft]);
  const owners = useMemo(() => ownerOptions(state, draft), [state, draft]);
  // Per-finding custom-name mode; entering text switches the select to the
  // "(new)" entry automatically.
  const customMode = useMemo(() => new Set(draft.items.filter((item) => item.targetOwner.trim() && !owners.includes(item.targetOwner)).map((item) => item.issueId)), [draft, owners]);
  const moveCount = draft.items.filter((item) => item.targetOwner.trim() && item.targetOwner !== item.ackOwner).length;
  const invalidTargets = draft.items.filter((item) => !item.targetOwner.trim()).length;
  const recentAudit = state.assignmentLog.slice().reverse().slice(0, 5);
  const blocked = preview.conflicts.length > 0 || invalidTargets > 0 || moveCount === 0;

  const refresh = () => onDraftChange(refreshAllocationDraft(draft, state));
  const balance = () => onDraftChange(rebalanceDraft(state, draft));
  const confirm = async () => {
    setPending(true);
    const result = await commitAllocationPlan(draft);
    setPending(false);
    if (!result.ok) {
      onDraftChange(refreshAllocationDraft(draft, state));
      onApplied(result.message ?? 'The batch could not be applied.', 'warning');
      return;
    }
    if (result.duplicate) {
      onApplied('This allocation was already applied — no duplicate assignment was created.', 'warning');
    } else {
      const count = result.audit?.length ?? moveCount;
      onApplied(`${count} finding${count === 1 ? '' : 's'} reassigned in one transaction.`, 'positive');
    }
    onClose();
  };

  return <Modal
    wide
    eyebrow="WORKLOAD ALLOCATION TRANSACTION"
    title={`Reassign ${draft.items.length} finding${draft.items.length === 1 ? '' : 's'}`}
    onClose={onClose}
    footer={<>
      <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
      <Button variant="secondary" icon={<RefreshCw size={15} />} disabled={pending} onClick={refresh}>Refresh base</Button>
      <Button variant="primary" icon={<Send size={15} />} disabled={blocked || pending} onClick={confirm}>
        {pending ? 'Committing transaction…' : `Confirm ${moveCount} reassign${moveCount === 1 ? '' : 's'}`}
      </Button>
    </>}>
    <div className="allocation-stack">
      <div className="allocation-toolbar">
        <span className="review-hint"><Scale size={14} /> Severity weights: critical ×3 · warning ×2 · note ×1. Resolved findings never count toward load.</span>
        <Button variant="secondary" icon={<Scale size={14} />} onClick={balance}>Balance fairly</Button>
      </div>

      {preview.conflicts.length > 0 && <div className="allocation-conflicts" role="alert">
        <div className="allocation-conflicts-head"><ShieldAlert size={16} /><strong>{preview.conflicts.length} external change{preview.conflicts.length === 1 ? '' : 's'} detected</strong><Button variant="ghost" icon={<RefreshCw size={13} />} onClick={refresh}>Refresh</Button></div>
        {preview.conflicts.map((conflict) => <div className="allocation-conflict-row" key={`${conflict.issueId}-${conflict.type}`}>
          <XCircle size={14} />
          <span className="allocation-conflict-title">{conflict.title}</span>
          <Badge tone="danger">{CONFLICT_LABEL[conflict.type]}</Badge>
          <small>{conflict.detail}</small>
        </div>)}
      </div>}

      <section className="allocation-table" aria-label="Workload distribution before and after the batch">
        <div className="allocation-row allocation-row-head">
          <span>Owner</span><span>Findings now → after</span><span>Weight now → after</span><span>Affected zones after</span>
        </div>
        {preview.rows.map((row) => <OwnerRow key={row.owner} row={row} zones={zones} balanced={preview.balanced} />)}
      </section>

      {!preview.balanced && <div className="allocation-balance-note"><Scale size={14} /><span>Weight spread after the batch is {preview.weightSpread}. Try “Balance fairly” to even out severity load.</span></div>}

      <section className="allocation-items" aria-label="Findings in this batch">
        <div className="eyebrow">FINDINGS IN THIS BATCH · BASE VERSIONS PINNED</div>
        {draft.items.map((item) => {
          const itemConflict = preview.conflicts.find((conflict) => conflict.issueId === item.issueId);
          const moving = item.targetOwner.trim() && item.targetOwner !== item.ackOwner;
          const zoneNames = [item.zoneId].filter((id): id is string => Boolean(id)).map((id) => zones.get(id) ?? id).join(', ');
          const ownerChangedElsewhere = item.ackOwner !== item.fromOwner;
          return <div className={`allocation-item ${itemConflict ? 'is-conflicted' : ''} ${moving ? 'is-moving' : ''}`} key={item.issueId}>
            <div className="allocation-item-main">
              <div className="allocation-item-title">
                <strong>{item.title}</strong>
                <Badge tone={SEVERITY_TONE[item.severity]}>{titleCase(item.severity)} · weight {item.severity === 'critical' ? 3 : item.severity === 'warning' ? 2 : 1}</Badge>
                <Badge tone={item.ackStatus === 'resolved' ? 'positive' : 'neutral'}>{titleCase(item.ackStatus)}</Badge>
                {itemConflict && <Badge tone="danger">{CONFLICT_LABEL[itemConflict.type]}</Badge>}
              </div>
              <div className="allocation-item-meta">
                <span>{item.ackOwner}</span>
                <ArrowRight size={11} />
                <span className={moving ? 'text-teal' : ''}>{moving ? item.targetOwner : 'stays with current owner'}</span>
                {ownerChangedElsewhere && <Badge tone="warning">opened under {item.fromOwner}</Badge>}
                {zoneNames && <span className="allocation-item-zone">{zoneNames}</span>}
                <em>v{item.ackVersion}{item.ackVersion !== item.baseVersion ? ` (opened at v${item.baseVersion})` : ''}</em>
              </div>
              {itemConflict && <small className="field-error">{itemConflict.detail}</small>}
            </div>
            <div className="allocation-item-assign">
              <select
                aria-label={`New owner for ${item.title}`}
                value={customMode.has(item.issueId) ? '__custom__' : item.targetOwner}
                onChange={(event) => {
                  if (event.target.value === '__custom__') {
                    onDraftChange(setDraftTarget(draft, item.issueId, ''));
                  } else {
                    onDraftChange(setDraftTarget(draft, item.issueId, event.target.value));
                  }
                }}
              >
                <option value="">— choose owner —</option>
                <option value={item.ackOwner}>{item.ackOwner} (keep)</option>
                {owners.filter((owner) => owner !== item.ackOwner).map((owner) => <option key={owner} value={owner}>{owner}</option>)}
                <option value="__custom__">+ New owner…</option>
              </select>
              {customMode.has(item.issueId) && <input
                aria-label={`Custom owner name for ${item.title}`}
                placeholder="New owner name"
                autoFocus
                value={item.targetOwner}
                onChange={(event) => onDraftChange(setDraftTarget(draft, item.issueId, event.target.value))}
              />}
            </div>
          </div>;
        })}
      </section>

      <section className="allocation-audit" aria-label="Recent assignment audit entries">
        <div className="eyebrow">ASSIGNMENT AUDIT TRAIL</div>
        {recentAudit.length === 0 && <p className="allocation-audit-empty">No reassignments recorded in this workspace yet.</p>}
        {recentAudit.map((entry) => <div className="allocation-audit-row" key={entry.id}>
          <CheckCircle2 size={13} />
          <span><strong>{entry.issueTitle}</strong> {entry.fromOwner} <ArrowRight size={10} /> {entry.toOwner}</span>
          <em>{formatDate(entry.timestamp)}</em>
        </div>)}
      </section>
    </div>
  </Modal>;
}

function OwnerRow({ row, zones, balanced }: { row: OwnerLoad; zones: Map<string, string>; balanced: boolean }) {
  const overloaded = !balanced && row.deltaWeight > 0;
  return <div className={`allocation-row ${row.delta !== 0 ? 'is-changing' : ''}`}>
    <span className="allocation-owner">{row.owner}</span>
    <span className="allocation-count"><strong>{row.beforeCount}</strong><ArrowRight size={12} /><strong className={row.delta > 0 ? 'text-danger' : row.delta < 0 ? 'text-teal' : ''}>{row.afterCount}</strong>{row.delta !== 0 && <em className={row.delta > 0 ? 'text-danger' : 'text-teal'}>{row.delta > 0 ? `+${row.delta}` : row.delta}</em>}</span>
    <span className="allocation-weight"><strong>{row.beforeWeight}</strong><ArrowRight size={12} /><strong className={overloaded ? 'text-amber' : ''}>{row.afterWeight}</strong>{row.deltaWeight !== 0 && <em className={row.deltaWeight > 0 ? 'text-danger' : 'text-teal'}>{row.deltaWeight > 0 ? `+${row.deltaWeight}` : row.deltaWeight}</em>}</span>
    <span className="allocation-zones">{row.afterZoneIds.length ? row.afterZoneIds.map((id) => zones.get(id) ?? id).join(', ') : <em className="allocation-empty">No active findings</em>}</span>
  </div>;
}
