import { AlertTriangle, ArrowRight, CheckCircle2, FileWarning, History, Info, LockKeyhole, MapPin, RefreshCw, ShieldAlert, Sparkles, Wrench, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { extractRepairConflicts, buildRepairProposal, type RepairConflict, type RepairProposal } from '../../domain/repairSandbox';
import { titleCase } from '../../domain/formatters';
import { computePlanRevision } from '../../domain/planVersion';
import { useWorkspace } from '../../state/WorkspaceContext';

type SandboxStep = 'select' | 'review';

const CONFLICT_TONE: Record<RepairConflict['severity'], 'danger' | 'warning'> = {
  error: 'danger',
  warning: 'warning',
};

export function RepairSandbox({ onClose, onNotify }: { onClose: () => void; onNotify: (message: string, tone: 'positive' | 'warning') => void }) {
  const { state, applyRepairProposal } = useWorkspace();
  const revision = useMemo(() => computePlanRevision(state), [state]);
  const conflicts = useMemo(() => extractRepairConflicts(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const [step, setStep] = useState<SandboxStep>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>(() => conflicts.filter((conflict) => conflict.severity === 'error').map((conflict) => conflict.id));
  const [proposal, setProposal] = useState<RepairProposal | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const zoneName = (zoneId?: string) => zoneId ? state.zones.find((zone) => zone.id === zoneId)?.name ?? 'Unknown zone' : undefined;
  const artifactName = (artifactId?: string) => artifactId ? state.artifacts.find((artifact) => artifact.id === artifactId)?.title ?? 'Object' : undefined;

  const toggle = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  const generate = () => {
    const next = buildRepairProposal({ state, selectedConflictIds: selectedIds });
    setProposal(next);
    setErrorMessage(null);
    setStep('review');
  };
  const stale = proposal !== null && proposal.revision !== revision;

  const confirm = () => {
    if (!proposal) return;
    const result = applyRepairProposal(proposal.changes.map((change) => change.operation), proposal.revision);
    if (result.ok) {
      onNotify(`Applied ${proposal.changes.length} repair change${proposal.changes.length === 1 ? '' : 's'}.`, 'positive');
      onClose();
      return;
    }
    // The plan moved under us (or the same proposal was confirmed twice):
    // nothing was written. Recalculate from the current plan.
    setErrorMessage(result.message ?? 'The proposal could not be applied.');
  };

  const selectedConflicts = conflicts.filter((conflict) => selectedIds.includes(conflict.id));

  return <Modal
    eyebrow="CONSTRAINT REPAIR SANDBOX"
    title="Resolve placement conflicts"
    onClose={onClose}
    footer={<SandboxFooter
      step={step}
      hasSelection={selectedIds.length > 0}
      proposal={proposal}
      stale={stale}
      onBack={() => setStep('select')}
      onRecalculate={generate}
      onGenerate={generate}
      onConfirm={confirm}
      onClose={onClose}
    />}
  >
    {step === 'select' ? (
      <div className="sandbox-stack">
        <p className="sandbox-intro"><Wrench size={15} /> Choose the conflicts to solve together. The sandbox computes one deterministic, minimal set of changes and previews it before anything touches the plan. Key objects are never moved automatically.</p>
        <div className="sandbox-conflicts">
          {conflicts.map((conflict) => (
            <label className={`sandbox-conflict ${selectedIds.includes(conflict.id) ? 'selected' : ''}`} key={conflict.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(conflict.id)}
                onChange={() => toggle(conflict.id)}
                aria-label={`Select conflict ${conflict.title}`}
              />
              <span className="sandbox-conflict-body">
                <span className="sandbox-conflict-line">
                  <strong>{conflict.title}</strong>
                  <Badge tone={CONFLICT_TONE[conflict.severity]}>{conflict.severity}</Badge>
                </span>
                <small>{conflict.detail}</small>
                <span className="sandbox-conflict-meta">
                  {zoneName(conflict.zoneId) && <span><MapPin size={11} /> {zoneName(conflict.zoneId)}</span>}
                  {artifactName(conflict.artifactId) && <span>{artifactName(conflict.artifactId)}</span>}
                  <span>{titleCase(conflict.kind).replace('-', ' ')}</span>
                </span>
              </span>
            </label>
          ))}
          {conflicts.length === 0 && <div className="sandbox-empty"><CheckCircle2 size={20} /><strong>No repair candidates</strong><span>The constraint engine has no active capacity, role, or accessibility conflicts.</span></div>}
        </div>
        <p className="sandbox-hint">{selectedIds.length} conflict{selectedIds.length === 1 ? '' : 's'} selected · proposal computed against plan revision <code>{revision.slice(0, 8)}</code></p>
      </div>
    ) : proposal && (
      <div className="sandbox-stack">
        {stale && <div className="sandbox-banner stale" data-testid="sandbox-stale-banner"><RefreshCw size={15} /><span><strong>Plan changed since this proposal was calculated.</strong><small>A placement or finding moved; the displayed set is stale. Recalculate to see the new candidates — nothing has been written.</small></span></div>}
        {errorMessage && <div className="sandbox-banner error" data-testid="sandbox-error-banner"><XCircle size={15} /><span><strong>Application rejected.</strong><small>{errorMessage}</small></span></div>}
        <div className="sandbox-summary-line">
          <Badge tone={proposal.complete ? 'positive' : 'danger'}>{proposal.complete ? 'Complete' : 'Unresolved conflicts'}</Badge>
          <span>{proposal.changes.length} change{proposal.changes.length === 1 ? '' : 's'} · {selectedConflicts.length} conflict{selectedConflicts.length === 1 ? '' : 's'} · revision <code>{proposal.revision.slice(0, 8)}</code></span>
        </div>
        {proposal.changes.map((change) => (
          <article className="repair-change" key={change.id} data-testid="repair-change">
            <div className="repair-change-head">
              <Sparkles size={15} />
              <strong>{change.summary}</strong>
            </div>
            <p className="repair-reason"><Info size={12} /> {change.reason}</p>
            {change.fromZoneName && <p className="repair-route"><MapPin size={12} /> {change.fromZoneName}{change.toZoneName && <><ArrowRight size={12} /> {change.toZoneName}</>}</p>}
            <div className="repair-resolves">{change.resolvesConflictIds.map((id) => {
              const conflict = proposal.conflicts.find((candidate) => candidate.id === id);
              return conflict ? <Badge key={id} tone={CONFLICT_TONE[conflict.severity]}>Resolves · {conflict.title}</Badge> : null;
            })}</div>
            <div className="repair-materials">
              <div className="eyebrow"><History size={10} /> Affected materials</div>
              <ul>
                {change.affectedMaterials.map((material, index) => (
                  <li key={`${material.type}-${material.id ?? index}`}>
                    {material.type === 'finding' ? <FileWarning size={12} /> : material.type === 'readiness' ? <ShieldAlert size={12} /> : material.type === 'zone' ? <MapPin size={12} /> : <AlertTriangle size={12} />}
                    <span><strong>{material.label}</strong> <small>{material.detail}</small></span>
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
        {proposal.blockedOptions.length > 0 && <div className="repair-blocked">
          <div className="eyebrow"><LockKeyhole size={10} /> Unavailable options</div>
          {proposal.blockedOptions.map((option, index) => {
            const conflict = proposal.conflicts.find((candidate) => candidate.id === option.conflictId);
            return <div className="repair-blocked-row" key={`${option.conflictId}-${index}`} data-testid="repair-blocked-option">
              <LockKeyhole size={13} />
              <span>
                <strong>{option.artifactTitle ?? conflict?.title ?? 'Option'}</strong>
                <small>{option.blocked.message}</small>
              </span>
              <Badge tone="neutral">{option.blocked.code.replaceAll('-', ' ')}</Badge>
            </div>;
          })}
          <p className="sandbox-hint">These conflicts cannot be repaired automatically. Apply stays disabled until they are excluded or resolved manually.</p>
        </div>}
        {proposal.cautions.length > 0 && <div className="repair-cautions">
          <div className="eyebrow"><AlertTriangle size={10} /> Non-blocking side effects</div>
          {proposal.cautions.map((caution) => <div className="repair-caution-row" key={caution.id}><AlertTriangle size={12} /><span><strong>{caution.title}</strong> <small>{caution.detail}</small></span></div>)}
        </div>}
      </div>
    )}
  </Modal>;
}

function SandboxFooter({ step, hasSelection, proposal, stale, onBack, onRecalculate, onGenerate, onConfirm, onClose }: {
  step: SandboxStep;
  hasSelection: boolean;
  proposal: RepairProposal | null;
  stale: boolean;
  onBack: () => void;
  onRecalculate: () => void;
  onGenerate: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (step === 'select') {
    return <>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon={<Wrench size={15} />} disabled={!hasSelection} onClick={onGenerate}>Calculate minimal changes</Button>
    </>;
  }
  return <>
    <Button variant="ghost" onClick={onBack}>Back to conflicts</Button>
    {stale
      ? <Button variant="primary" icon={<RefreshCw size={15} />} onClick={onRecalculate}>Recalculate from current plan</Button>
      : <Button variant="primary" icon={<CheckCircle2 size={15} />} disabled={!proposal || !proposal.complete} onClick={onConfirm}>Apply {proposal?.changes.length ?? 0} change{proposal?.changes.length === 1 ? '' : 's'} to plan</Button>}
  </>;
}
