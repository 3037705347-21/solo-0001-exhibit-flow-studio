import { AlertTriangle, ArrowRight, Boxes, CheckCircle2, FlaskConical, Layers3, Lightbulb, Play, ShieldAlert, Sparkles, Trash2, X, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Callout } from '../../components/Callout';
import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { createId } from '../../domain/ids';
import { formatMinutes, formatPercent } from '../../domain/formatters';
import { evaluateCapacitySandbox, planFingerprint } from '../../domain/sandbox';
import type { ArtifactDraft, NarrativeRole, WorkspaceState, Zone } from '../../domain/models';
import type { SandboxChange, SandboxEvaluation, SandboxZoneDiff } from '../../domain/sandbox';
import { useWorkspace } from '../../state/WorkspaceContext';
import { SandboxAddArtifactModal, type PendingSandboxArtifact } from './SandboxAddArtifactModal';
import { buildZoneRulePatch, zoneToRuleDraft, ZoneRuleCard, type ZoneRuleDraft } from './ZoneRuleCard';

interface SandboxSession {
  base: WorkspaceState;
  baseVersion: string;
}

interface StagedMove {
  id: string;
  artifactId: string;
  targetZoneId: string;
}

interface StagedAdd {
  id: string;
  draft: ArtifactDraft;
  targetZoneId?: string;
}

type RuleDraftMap = Record<string, ZoneRuleDraft>;

const ROLE_LABEL: Record<NarrativeRole, string> = {
  threshold: 'Threshold',
  context: 'Context',
  'turning-point': 'Turning point',
  reflection: 'Reflection',
};

function cloneBase(state: WorkspaceState): WorkspaceState {
  return JSON.parse(JSON.stringify(state)) as WorkspaceState;
}

export function SandboxPage() {
  const { state, planVersion, applyCapacitySandbox } = useWorkspace();
  const [session, setSession] = useState<SandboxSession | null>(null);
  const [moves, setMoves] = useState<StagedMove[]>([]);
  const [adds, setAdds] = useState<StagedAdd[]>([]);
  const [ruleDrafts, setRuleDrafts] = useState<RuleDraftMap>({});
  const [moveArtifact, setMoveArtifact] = useState('');
  const [moveTarget, setMoveTarget] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'positive' | 'warning' | 'danger'; text: string } | null>(null);
  const [conflictReview, setConflictReview] = useState<SandboxEvaluation | null>(null);

  const baseZones = useMemo(
    () => (session ? [...session.base.zones].sort((left, right) => left.sequence - right.sequence) : []),
    [session],
  );

  const changes = useMemo<SandboxChange[]>(() => {
    if (!session) return [];
    const zoneChanges: SandboxChange[] = baseZones.flatMap((zone) => {
      const draft = ruleDrafts[zone.id];
      if (!draft) return [];
      const patch = buildZoneRulePatch(zone, draft);
      return patch ? [{ id: `rule-${zone.id}`, kind: 'zone-rule', zoneId: zone.id, patch }] : [];
    });
    return [
      ...zoneChanges,
      ...moves.map((move) => ({ id: move.id, kind: 'move' as const, artifactId: move.artifactId, targetZoneId: move.targetZoneId })),
      ...adds.map((add) => ({ id: add.id, kind: 'add' as const, draft: add.draft, targetZoneId: add.targetZoneId })),
    ];
  }, [session, baseZones, ruleDrafts, moves, adds]);

  const evaluation = useMemo(
    () => (session ? evaluateCapacitySandbox(session.base, changes) : null),
    [session, changes],
  );

  const startSandbox = () => {
    const base = cloneBase(state);
    setSession({ base, baseVersion: planFingerprint(state) });
    setRuleDrafts(Object.fromEntries(base.zones.map((zone) => [zone.id, zoneToRuleDraft(zone)])));
    setNotice(null);
  };

  const discardSandbox = () => {
    setSession(null);
    setMoves([]);
    setAdds([]);
    setRuleDrafts({});
    setMoveArtifact('');
    setMoveTarget('');
    setConflictReview(null);
    setNotice(null);
  };

  const rebase = () => {
    if (!session) return;
    setSession({ base: cloneBase(state), baseVersion: planVersion });
    setRuleDrafts((current) => {
      const next: RuleDraftMap = {};
      for (const zone of state.zones) next[zone.id] = current[zone.id] ?? zoneToRuleDraft(zone);
      return next;
    });
    setMoves((current) => current.filter((move) => state.artifacts.some((artifact) => artifact.id === move.artifactId) && state.zones.some((zone) => zone.id === move.targetZoneId)));
    setAdds((current) => current.filter((add) => !add.targetZoneId || state.zones.some((zone) => zone.id === add.targetZoneId)));
    setConflictReview(null);
    setNotice({ tone: 'positive', text: 'Sandbox re-anchored to the latest plan. Review the updated results before applying.' });
  };

  const addMove = () => {
    if (!moveArtifact || !moveTarget) return;
    setMoves((current) => [...current, { id: createId('sandbox-move'), artifactId: moveArtifact, targetZoneId: moveTarget }]);
    setMoveArtifact('');
    setMoveTarget('');
  };

  const stageAdd = (pending: PendingSandboxArtifact) => {
    setAdds((current) => [...current, { id: createId('sandbox-add'), draft: pending.draft, targetZoneId: pending.targetZoneId || undefined }]);
    setEditorOpen(false);
  };

  const flash = (text: string, tone: 'positive' | 'warning' | 'danger' = 'warning') => {
    setNotice({ tone, text });
    window.setTimeout(() => setNotice(null), 4200);
  };

  const apply = () => {
    if (!session || !evaluation) return;
    if (evaluation.blocked) {
      setConflictReview(evaluation);
      return;
    }
    const result = applyCapacitySandbox(changes, session.baseVersion);
    if (!result.ok && result.reason === 'version-conflict') {
      setConflictReview(evaluation);
      flash(result.message, 'danger');
      return;
    }
    if (!result.ok && result.reason === 'invalid-operation') {
      setConflictReview(evaluateCapacitySandbox(state, changes));
      flash(result.message, 'danger');
      return;
    }
    const appliedCount = changes.length;
    discardSandbox();
    setNotice({ tone: 'positive', text: `Applied ${appliedCount} sandbox change${appliedCount === 1 ? '' : 's'} to the live plan.` });
    window.setTimeout(() => setNotice(null), 4200);
  };

  if (!session || !evaluation) {
    return (
      <div className="page-stack">
        <SectionHeader
          eyebrow="CAPACITY SANDBOX"
          title="Capacity sandbox"
          description="Combine object moves, an unrecorded object, and zone rule changes to preview occupancy, conflicts, and readiness before touching the saved plan."
          actions={<Button variant="primary" icon={<Play size={16} />} onClick={startSandbox}>Start sandbox</Button>}
        />
        <EmptyState
          icon={<FlaskConical size={24} />}
          title="No active sandbox"
          detail="Start a sandbox to freeze the current plan version. Trial results never affect readiness, exports, or local storage until you explicitly apply them."
        />
        {notice && <SandboxToast notice={notice} />}
      </div>
    );
  }

  const divergent = planVersion !== session.baseVersion;
  const movedArtifactIds = new Set(moves.map((move) => move.artifactId));
  const availableArtifacts = session.base.artifacts.filter((artifact) => !movedArtifactIds.has(artifact.id));
  const failedChangeIds = new Set(evaluation.changeResults.filter((result) => result.status === 'failed').map((result) => result.changeId));
  const conflictChangeIds = new Set(evaluation.conflicts.map((conflict) => conflict.changeId).filter((id): id is string => Boolean(id)));
  const hasChanges = changes.length > 0;

  return (
    <div className="page-stack">
      <SectionHeader
        eyebrow="CAPACITY SANDBOX"
        title="Capacity sandbox"
        description="Every figure below is a trial against a frozen plan version. Discarding restores the workspace exactly as it was."
        actions={
          <div className="header-button-row">
            <Button variant="secondary" icon={<Trash2 size={15} />} onClick={discardSandbox}>Discard sandbox</Button>
            <Button variant="primary" icon={<CheckCircle2 size={16} />} disabled={!hasChanges || evaluation.blocked} onClick={apply}>
              Apply {hasChanges ? `${changes.length} change${changes.length === 1 ? '' : 's'}` : 'changes'}
            </Button>
          </div>
        }
      />

      <div className="scenario-banner">
        <div className="scenario-banner-icon"><FlaskConical size={21} /></div>
        <div>
          <strong>Trial workspace · frozen at {shortVersion(session.baseVersion)}</strong>
          <p>{hasChanges ? `${changes.length} staged change${changes.length === 1 ? '' : 's'}` : 'No changes staged yet'} · live plan version {shortVersion(planVersion)}</p>
        </div>
        {divergent ? <Badge tone="danger">Plan changed elsewhere</Badge> : <Badge tone="info">Non-destructive</Badge>}
      </div>

      {divergent && (
        <Callout
          tone="danger"
          title="The live plan was modified after this sandbox started"
          actions={<div className="header-button-row"><Button variant="secondary" onClick={discardSandbox}>Discard &amp; close</Button><Button variant="primary" icon={<ArrowRight size={15} />} onClick={rebase}>Re-anchor to latest plan</Button></div>}
        >
          Applying now would overwrite newer work, so the batch is blocked. Re-anchor the sandbox to replay these staged changes against the current plan version, then review the results again.
        </Callout>
      )}

      <div className="metric-grid four">
        <Metric label="Trial visit length" value={formatMinutes(evaluation.trialAnalysis.totalDwellMinutes)} detail={`Baseline ${formatMinutes(evaluation.baseAnalysis.totalDwellMinutes)}`} icon={<Layers3 size={17} />} tone="teal" />
        <Metric label="Blocking errors" value={`${evaluation.trialAnalysis.blockingCount}`} detail={`Baseline ${evaluation.baseAnalysis.blockingCount}`} icon={<AlertTriangle size={17} />} tone={evaluation.trialAnalysis.blockingCount ? 'red' : 'teal'} />
        <Metric label="Key coverage" value={formatPercent(evaluation.trialAnalysis.keyObjectCoverage)} detail={`Baseline ${formatPercent(evaluation.baseAnalysis.keyObjectCoverage)}`} icon={<ShieldAlert size={17} />} tone={evaluation.trialAnalysis.keyObjectCoverage === 1 ? 'teal' : 'red'} />
        <Metric label="Readiness score" value={`${evaluation.trialReadiness.score}/100`} detail={`Baseline ${evaluation.baseReadiness.score}/100 · ${evaluation.trialReadiness.ready ? 'would pass' : 'would block'}`} icon={<Sparkles size={17} />} tone={evaluation.trialReadiness.ready ? 'teal' : 'amber'} />
      </div>

      <div className="sandbox-layout">
        <section className="sandbox-composer">
          <div className="panel-heading"><div><div className="eyebrow">STAGED CHANGES</div><h2>Compose the trial</h2></div><Badge tone={hasChanges ? 'warning' : 'neutral'}>{changes.length}</Badge></div>

          <div className="sandbox-add-row">
            <div className="sandbox-add-grid">
              <SelectField label="Move object" value={moveArtifact} onChange={(event) => setMoveArtifact(event.target.value)}>
                <option value="">Select object…</option>
                {availableArtifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}
              </SelectField>
              <SelectField label="To zone" value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)}>
                <option value="">Select zone…</option>
                {baseZones.map((zone) => <option key={zone.id} value={zone.id}>{zone.shortLabel}</option>)}
              </SelectField>
            </div>
            <Button variant="secondary" icon={<Boxes size={15} />} disabled={!moveArtifact || !moveTarget} onClick={addMove}>Stage move</Button>
          </div>

          <Button variant="secondary" icon={<Play size={14} />} onClick={() => setEditorOpen(true)}>Stage an unrecorded object</Button>

          <div className="sandbox-change-list">
            {moves.map((move) => {
              const artifact = session.base.artifacts.find((candidate) => candidate.id === move.artifactId);
              const zone = baseZones.find((candidate) => candidate.id === move.targetZoneId);
              const flagged = failedChangeIds.has(move.id) || conflictChangeIds.has(move.id);
              return (
                <div className={`sandbox-change-row ${flagged ? 'flagged' : ''}`} key={move.id}>
                  <Boxes size={15} />
                  <span><strong>{artifact?.title ?? 'Missing object'}</strong><small>Move → {zone?.shortLabel ?? 'Missing zone'}</small></span>
                  {flagged && <Badge tone="danger">Conflict</Badge>}
                  <Button variant="ghost" icon={<X size={14} />} aria-label={`Remove move of ${artifact?.title ?? 'object'}`} onClick={() => setMoves((current) => current.filter((item) => item.id !== move.id))} />
                </div>
              );
            })}
            {adds.map((add) => {
              const zone = baseZones.find((candidate) => candidate.id === add.targetZoneId);
              const flagged = failedChangeIds.has(add.id) || conflictChangeIds.has(add.id);
              return (
                <div className={`sandbox-change-row ${flagged ? 'flagged' : ''}`} key={add.id}>
                  <Sparkles size={15} />
                  <span><strong>{add.draft.title || 'Unnamed trial object'}</strong><small>New object · {zone ? `→ ${zone.shortLabel}` : 'unplaced'}</small></span>
                  {flagged && <Badge tone="danger">Conflict</Badge>}
                  <Button variant="ghost" icon={<X size={14} />} aria-label={`Remove trial object ${add.draft.title}`} onClick={() => setAdds((current) => current.filter((item) => item.id !== add.id))} />
                </div>
              );
            })}
            {Object.entries(ruleDrafts).map(([zoneId, draft]) => {
              const zone = baseZones.find((candidate) => candidate.id === zoneId);
              if (!zone) return null;
              const patch = buildZoneRulePatch(zone, draft);
              if (!patch) return null;
              const changeId = `rule-${zoneId}`;
              const flagged = failedChangeIds.has(changeId) || conflictChangeIds.has(changeId);
              return (
                <div className={`sandbox-change-row ${flagged ? 'flagged' : ''}`} key={changeId}>
                  <Layers3 size={15} />
                  <span><strong>{zone.shortLabel}</strong><small>{describePatch(patch)}</small></span>
                  {flagged && <Badge tone="danger">Conflict</Badge>}
                  <Button variant="ghost" icon={<X size={14} />} aria-label={`Remove rule change for ${zone.shortLabel}`} onClick={() => setRuleDrafts((current) => ({ ...current, [zoneId]: zoneToRuleDraft(zone) }))} />
                </div>
              );
            })}
            {!hasChanges && <div className="sandbox-empty">Stage a move, add a trial object, or edit a zone rule to see live capacity results.</div>}
          </div>

          <div className="sandbox-rules">
            <div className="panel-heading"><div><div className="eyebrow">ZONE RULES</div><h3>Adjust capacity &amp; conditions</h3></div></div>
            <div className="sandbox-rules-grid">
              {baseZones.map((zone) => (
                <ZoneRuleCard
                  key={zone.id}
                  zone={zone}
                  draft={ruleDrafts[zone.id] ?? zoneToRuleDraft(zone)}
                  onChange={(next) => setRuleDrafts((current) => ({ ...current, [zone.id]: next }))}
                  onReset={() => setRuleDrafts((current) => ({ ...current, [zone.id]: zoneToRuleDraft(zone) }))}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="sandbox-results">
          <div className="panel-heading"><div><div className="eyebrow">TRIAL RESULTS</div><h2>Per-zone impact</h2></div>{evaluation.blocked ? <Badge tone="danger">Blocked</Badge> : <Badge tone="positive">Applicable</Badge>}</div>

          {evaluation.blocked && (
            <Callout tone="warning" title="This batch cannot be applied yet">
              {evaluation.changeResults.some((result) => result.status === 'failed')
                ? 'At least one staged operation is invalid against the frozen plan. '
                : 'The batch introduces blocking constraints. '}
              Remove or adjust the flagged changes and the trial updates immediately.
            </Callout>
          )}

          <div className="sandbox-zone-list">
            {evaluation.zoneDiffs.map((diff) => {
              const zone = baseZones.find((candidate) => candidate.id === diff.zoneId);
              if (!zone) return null;
              return <ZoneDiffCard key={diff.zoneId} zone={zone} diff={diff} />;
            })}
          </div>

          {evaluation.unplacedAdded.length > 0 && (
            <div className="sandbox-unplaced">
              <div className="eyebrow">TRIAL OBJECTS LEFT UNPLACED</div>
              {evaluation.unplacedAdded.map((artifact) => (
                <div className="sandbox-change-row" key={artifact.id}><Sparkles size={15} /><span><strong>{artifact.title}</strong><small>{artifact.isKeyObject ? 'Key object · will block readiness' : 'Counts as an unused collection object'}</small></span></div>
              ))}
            </div>
          )}

          {evaluation.conflicts.some((conflict) => !conflict.zoneId) && (
            <div className="sandbox-journey-findings">
              <div className="eyebrow">JOURNEY-LEVEL CONFLICTS</div>
              {evaluation.conflicts.filter((conflict) => !conflict.zoneId).map((conflict) => (
                <div className="finding-row error" key={`${conflict.kind}-${conflict.title}`}>{conflict.kind === 'missing-role' ? <Lightbulb size={15} /> : <XCircle size={15} />}<span><strong>{conflict.title}</strong><small>{conflict.detail}</small></span></div>
              ))}
            </div>
          )}
        </section>
      </div>

      {editorOpen && (
        <SandboxAddArtifactModal
          state={session.base}
          stagedDrafts={adds.map((add) => add.draft)}
          onClose={() => setEditorOpen(false)}
          onAdd={stageAdd}
        />
      )}
      {conflictReview && (
        <ConflictReviewDialog
          evaluation={conflictReview}
          divergent={divergent}
          onReanchor={rebase}
          onClose={() => setConflictReview(null)}
        />
      )}
      {notice && <SandboxToast notice={notice} />}
    </div>
  );
}

function shortVersion(version: string): string {
  return version.slice(-8);
}

function describePatch(patch: { capacityMinutes?: number; maxObjects?: number; lowLight?: boolean; hasSeating?: boolean }): string {
  const parts: string[] = [];
  if (patch.capacityMinutes !== undefined) parts.push(`cap ${patch.capacityMinutes}m`);
  if (patch.maxObjects !== undefined) parts.push(`limit ${patch.maxObjects}`);
  if (patch.lowLight !== undefined) parts.push(patch.lowLight ? 'low-light on' : 'low-light off');
  if (patch.hasSeating !== undefined) parts.push(patch.hasSeating ? 'seating on' : 'seating off');
  return `Rule change · ${parts.join(' · ')}`;
}

function ZoneDiffCard({ zone, diff }: { zone: Zone; diff: SandboxZoneDiff }) {
  const touched = diff.objectCount.base !== diff.objectCount.trial
    || diff.dwellMinutes.base !== diff.dwellMinutes.trial
    || diff.capacityMinutes.base !== diff.capacityMinutes.trial
    || diff.maxObjects.base !== diff.maxObjects.trial
    || diff.newFindings.length > 0 || diff.resolvedFindings.length > 0
    || diff.rolesAdded.length || diff.rolesRemoved.length;
  const tone = diff.newFindings.some((finding) => finding.type === 'error')
    ? 'red'
    : diff.utilization.trial >= 0.8 || diff.newFindings.some((finding) => finding.type === 'warning')
      ? 'amber'
      : 'teal';
  return (
    <article className={`sandbox-zone-card ${touched ? 'touched' : ''}`}>
      <div className="sandbox-zone-head">
        <span className="zone-color" style={{ backgroundColor: zone.color }} />
        <strong>{zone.shortLabel}</strong>
        <span className="sandbox-zone-count">{diff.objectCount.base} → <strong>{diff.objectCount.trial}</strong> / {diff.maxObjects.trial} objects</span>
        <span className="sandbox-zone-count">{diff.dwellMinutes.base} → <strong>{diff.dwellMinutes.trial}</strong> / {diff.capacityMinutes.trial} min</span>
      </div>
      <ProgressBar value={Math.min(100, diff.utilization.trial * 100)} tone={tone} />
      {(diff.keyAdded.length > 0 || diff.keyRemoved.length > 0) && (
        <div className="sandbox-key-diff">
          {diff.keyAdded.map((artifact) => <Badge key={`in-${artifact.id}`} tone="positive">+ key: {artifact.title}</Badge>)}
          {diff.keyRemoved.map((artifact) => <Badge key={`out-${artifact.id}`} tone="warning">− key: {artifact.title}</Badge>)}
        </div>
      )}
      {(diff.rolesAdded.length > 0 || diff.rolesRemoved.length > 0) && (
        <div className="sandbox-role-diff">
          {diff.rolesAdded.map((role) => <span key={`add-${role}`} className="role-chip added">+ {ROLE_LABEL[role]}</span>)}
          {diff.rolesRemoved.map((role) => <span key={`rm-${role}`} className="role-chip removed">− {ROLE_LABEL[role]}</span>)}
        </div>
      )}
      {diff.lowLightChanged && <small className="sandbox-rule-note">Lighting rule flips {zone.lowLight ? 'to low-light' : 'to standard light'} in the trial.</small>}
      {diff.hasSeatingChanged && <small className="sandbox-rule-note">Seating rule flips {zone.hasSeating ? 'on' : 'off'} in the trial.</small>}
      <div className="finding-list compact">
        {diff.newFindings.map((finding) => (
          <div className={`finding-row ${finding.type}`} key={`new-${finding.id}`}>
            {finding.type === 'error' ? <XCircle size={15} /> : finding.type === 'warning' ? <AlertTriangle size={15} /> : <Lightbulb size={15} />}
            <span><strong>{finding.title}</strong><small>{finding.detail}</small></span>
          </div>
        ))}
        {diff.resolvedFindings.map((finding) => (
          <div className="finding-row resolved" key={`gone-${finding.id}`}><CheckCircle2 size={15} /><span><strong>{finding.title}</strong><small>Cleared by this sandbox batch.</small></span></div>
        ))}
      </div>
    </article>
  );
}

function ConflictReviewDialog({ evaluation, divergent, onReanchor, onClose }: { evaluation: SandboxEvaluation; divergent: boolean; onReanchor: () => void; onClose: () => void }) {
  const failures = evaluation.changeResults.filter((result) => result.status === 'failed');
  const conflictByChange = new Map(evaluation.conflicts.filter((conflict) => conflict.changeId).map((conflict) => [conflict.changeId, conflict]));
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal" role="dialog" aria-modal="true" aria-label="Sandbox apply blocked">
        <div className="modal-header">
          <div><div className="eyebrow">APPLY BLOCKED</div><h2>{divergent ? 'Plan version conflict' : 'Resolve sandbox conflicts'}</h2></div>
          <Button variant="ghost" icon={<X size={18} />} aria-label="Close dialog" onClick={onClose} />
        </div>
        <div className="modal-body sandbox-conflict-body">
          {divergent ? (
            <Callout tone="danger" title="The plan changed elsewhere after the sandbox started">
              Applying this batch would overwrite newer plan edits. Nothing has been changed. Discard and re-run the same moves, object, and rule changes against the latest plan version.
            </Callout>
          ) : (
            <Callout tone="warning" title="At least one operation in the batch fails">
              The batch is atomic: no change is applied until every staged operation succeeds. Fix or remove the flagged items and retry.
            </Callout>
          )}
          {failures.map((failure) => (
            <div className="finding-row error" key={failure.changeId}><XCircle size={15} /><span><strong>Invalid operation</strong><small>{failure.message}</small></span></div>
          ))}
          {evaluation.conflicts.map((conflict, index) => (
            <div className="finding-row error" key={`${conflict.changeId ?? 'journey'}-${index}`}><XCircle size={15} /><span><strong>{conflict.title}</strong><small>{conflict.detail}</small></span></div>
          ))}
          {conflictByChange.size === 0 && failures.length === 0 && <p className="sandbox-rule-note">Review the flagged rows in the composer.</p>}
        </div>
        <div className="modal-footer">
          <Button variant="ghost" onClick={onClose}>Back to sandbox</Button>
          {divergent && <Button variant="primary" icon={<ArrowRight size={15} />} onClick={onReanchor}>Re-anchor &amp; re-run</Button>}
        </div>
      </section>
    </div>
  );
}

function SandboxToast({ notice }: { notice: { tone: 'positive' | 'warning' | 'danger'; text: string } }) {
  const icon = notice.tone === 'positive' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />;
  return <div className={`toast ${notice.tone === 'positive' ? 'toast-positive' : 'toast-warning'}`}>{icon}{notice.text}</div>;
}
