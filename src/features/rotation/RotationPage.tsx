import {
  AlertTriangle,
  ArrowRightLeft,
  CalendarClock,
  CheckCircle2,
  Download,
  FileJson,
  History,
  Lamp,
  MoonStar,
  Pencil,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  SunMedium,
  Trash2,
  TreePine,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Callout } from '../../components/Callout';
import { EmptyState } from '../../components/EmptyState';
import { SectionHeader } from '../../components/SectionHeader';
import { formatDate } from '../../domain/formatters';
import { sortZones } from '../../domain/filters';
import type {
  RotationBatch,
  RotationBatchHealth,
  RotationPlan,
  RotationPlanHealth,
  Zone,
} from '../../domain/models';
import {
  ROTATION_CLASS_LABELS,
  evaluateRotationPlan,
  rotationPlanFileName,
  rotationScheduleCsvFileName,
  rotationStatusTone,
  serializeRotationPlanExport,
  serializeRotationScheduleCsv,
} from '../../domain/rotation';
import { selectRotationPlans } from '../../state/selectors';
import { useWorkspace } from '../../state/WorkspaceContext';
import { downloadTextFile } from '../../domain/export';

export function RotationPage() {
  const workspace = useWorkspace();
  const { state } = workspace;
  const plans = useMemo(() => selectRotationPlans(state), [state]);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [openingDraft, setOpeningDraft] = useState(state.project.openingDate);
  const [toast, setToast] = useState<string | null>(null);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2800); };

  const activePlan: RotationPlan | undefined = selectedPlanId
    ? plans.find((plan) => plan.id === selectedPlanId)
    : plans[0];

  const sensitiveCount = state.artifacts.filter(
    (artifact) => artifact.sensitivity === 'low-light' || artifact.sensitivity === 'fragile',
  ).length;
  const reviewCount = plans.filter((plan) => plan.status === 'review').length;

  const generate = () => {
    const result = workspace.generateRotationPlan();
    if (!result.ok || !result.value) { notify(result.message ?? 'Could not generate a rotation plan.'); return; }
    setSelectedPlanId(result.value.id);
    notify('Draft rotation plan generated for review.');
  };

  const saveOpeningDate = () => {
    if (openingDraft === state.project.openingDate) return;
    const result = workspace.updateOpeningDate(openingDraft);
    if (!result.ok) { notify(result.message ?? 'Invalid date.'); setOpeningDraft(state.project.openingDate); return; }
    notify('Opening date updated; confirmed schedules now need review.');
  };

  const exportPlanJson = (plan: RotationPlan) => {
    const result = workspace.exportRotationPlan(plan.id);
    if (!result.ok || !result.value) { notify(result.message ?? 'Export failed.'); return; }
    downloadTextFile(serializeRotationPlanExport(result.value), rotationPlanFileName());
    notify('Rotation plan exported (JSON).');
  };

  const exportPlanCsv = (plan: RotationPlan) => {
    downloadTextFile(serializeRotationScheduleCsv(plan), rotationScheduleCsvFileName(), 'text/csv;charset=utf-8');
    notify('Rotation schedule exported (CSV).');
  };

  const confirmPlan = (planId: string) => {
    const result = workspace.confirmRotationPlan(planId);
    if (!result.ok) { notify(result.message ?? 'Resolve the review items first.'); return; }
    notify('Rotation plan confirmed and re-pinned to current versions.');
  };

  const removePlan = (planId: string) => {
    if (!window.confirm('Delete this rotation plan? Older versions are kept for audit until removed.')) return;
    workspace.removeRotationPlan(planId);
    if (selectedPlanId === planId) setSelectedPlanId(null);
    notify('Rotation plan removed.');
  };

  return <div className="page-stack">
    <SectionHeader
      eyebrow="CONSERVATION ROTATION"
      title="Rotation schedule"
      description="Build reviewable display/rest cycles for low-light-sensitive and fragile objects, pinned to the exact object and gallery versions."
      actions={<div className="header-button-row">
        <Button variant="secondary" icon={<RefreshCw size={16} />} onClick={generate}>
          {plans.length === 0 ? 'Generate rotation plan' : 'Regenerate from plan'}
        </Button>
      </div>}
    />

    <div className="summary-strip">
      <div><span className="eyebrow">OBJECTS NEEDING ROTATION</span><strong>{sensitiveCount}<small> sensitive</small></strong></div>
      <div><span className="eyebrow">SAVED PLANS</span><strong>{plans.length}<small> in workspace</small></strong></div>
      <div><span className="eyebrow">NEEDS REVIEW</span><strong className={reviewCount ? 'text-amber' : ''}>{reviewCount}<small> stale</small></strong></div>
      <div><span className="eyebrow">OPENING DATE</span><strong className="rotation-opening"><input aria-label="Planned opening date" type="date" value={openingDraft} onChange={(event) => setOpeningDraft(event.target.value)} onBlur={saveOpeningDate} /></strong></div>
    </div>

    <section className="rotation-conditions" aria-label="Gallery light conditions">
      <div className="rotation-conditions-head">
        <div><div className="eyebrow">GALLERY CONDITIONS</div><h2>Zone light environment</h2></div>
        <p>Changing a zone's light level after a plan is confirmed sends every dependent batch back to review.</p>
      </div>
      <div className="rotation-zone-grid">
        {sortZones(state.zones).map((zone) => <ZoneLightToggle
          key={zone.id}
          zone={zone}
          onToggle={() => workspace.updateZone({ ...zone, lowLight: !zone.lowLight })}
        />)}
      </div>
    </section>

    {plans.length === 0 && <EmptyState
      icon={<MoonStar size={26} />}
      title="No rotation plan yet"
      detail="Generate a plan from the current object sensitivities, gallery light levels, opening date, and per-object dwell. You can adjust batches before confirming."
      action={<Button variant="primary" icon={<Sparkles size={16} />} onClick={generate}>Generate rotation plan</Button>}
    />}

    {activePlan && <PlanCard
      key={activePlan.id}
      plan={activePlan}
      isLatest={plans[0]?.id === activePlan.id}
      onConfirm={() => confirmPlan(activePlan.id)}
      onExportJson={() => exportPlanJson(activePlan)}
      onExportCsv={() => exportPlanCsv(activePlan)}
      onRemove={() => removePlan(activePlan.id)}
      onRenameBatch={(batchId, label) => workspace.renameRotationBatch(activePlan.id, batchId, label)}
      onMoveArtifact={(artifactId, fromBatchId, toBatchId) => workspace.moveRotationArtifact(activePlan.id, artifactId, fromBatchId, toBatchId)}
      notify={notify}
    />}

    {plans.length > 1 && <section className="rotation-history">
      <div className="rotation-history-head"><History size={16} /><h2>Saved and superseded plans</h2></div>
      <div className="rotation-history-list">
        {plans.map((plan) => <button
          key={plan.id}
          className={`rotation-history-row ${activePlan?.id === plan.id ? 'selected' : ''}`}
          onClick={() => setSelectedPlanId(plan.id)}
        >
          <span className="rotation-history-name"><strong>{plan.name}</strong><small>Created {formatDate(plan.createdAt)} · {plan.batches.length} batch{plan.batches.length === 1 ? '' : 'es'}</small></span>
          <Badge tone={rotationStatusTone(plan.status)}>{plan.status === 'review' ? 'Needs review' : plan.status}</Badge>
        </button>)}
      </div>
    </section>}

    {toast && <div className="toast toast-warning"><AlertTriangle size={16} />{toast}</div>}
  </div>;
}

function ZoneLightToggle({ zone, onToggle }: { zone: Zone; onToggle: () => void }) {
  return <div className={`rotation-zone-card ${zone.lowLight ? 'low-light' : 'full-light'}`}>
    <div className="rotation-zone-card-top">
      <span className="zone-color-swatch" style={{ background: zone.color }} />
      <strong>{zone.shortLabel}</strong>
      {zone.lowLight ? <MoonStar size={15} className="rotation-zone-icon" /> : <SunMedium size={15} className="rotation-zone-icon" />}
    </div>
    <small>{zone.name}</small>
    <label className="rotation-switch">
      <input type="checkbox" checked={zone.lowLight} onChange={onToggle} aria-label={`Toggle low light for ${zone.name}`} />
      <span>{zone.lowLight ? 'Low-light zone' : 'Standard lighting'}</span>
    </label>
  </div>;
}

function PlanCard(props: {
  plan: RotationPlan;
  isLatest: boolean;
  onConfirm: () => void;
  onExportJson: () => void;
  onExportCsv: () => void;
  onRemove: () => void;
  onRenameBatch: (batchId: string, label: string) => { ok: boolean; message?: string };
  onMoveArtifact: (artifactId: string, fromBatchId: string | null, toBatchId: string | 'new') => { ok: boolean; message?: string };
  notify: (message: string) => void;
}) {
  const { plan } = props;
  const { state } = useWorkspace();
  const health = useMemo<RotationPlanHealth>(() => evaluateRotationPlan(state, plan), [state, plan]);
  const effectiveStatus = health.status;
  const batchHealthById = new Map(health.batches.map((batch) => [batch.batchId, batch]));

  return <section className={`rotation-plan-card status-${effectiveStatus}`}>
    <div className="rotation-plan-head">
      <div className="rotation-plan-title">
        <div className="eyebrow">{props.isLatest ? 'LATEST PLAN' : 'SAVED PLAN'} · OPENING {plan.openingDate}</div>
        <h2>{plan.name}</h2>
        <p>Updated {formatDate(plan.updatedAt)}{plan.confirmedAt ? ` · confirmed ${formatDate(plan.confirmedAt)}` : ''} · horizon {plan.horizonDays} days</p>
      </div>
      <div className="rotation-plan-actions">
        <Badge tone={rotationStatusTone(effectiveStatus)}>
          {effectiveStatus === 'confirmed' ? 'Confirmed' : effectiveStatus === 'review' ? 'Needs review' : 'Draft'}
        </Badge>
        {effectiveStatus === 'draft' && <Button variant="primary" icon={<ShieldCheck size={16} />} onClick={props.onConfirm} disabled={!health.canConfirm}>Confirm plan</Button>}
        {effectiveStatus === 'review' && <Button variant="primary" icon={<ShieldCheck size={16} />} onClick={props.onConfirm} disabled={!health.canConfirm}>Re-confirm after review</Button>}
        <Button variant="secondary" icon={<FileJson size={15} />} onClick={props.onExportJson}>JSON</Button>
        <Button variant="secondary" icon={<Download size={15} />} onClick={props.onExportCsv}>CSV</Button>
        <Button variant="ghost" icon={<Trash2 size={15} />} aria-label="Delete plan" onClick={props.onRemove} />
      </div>
    </div>

    {effectiveStatus === 'review' && <Callout tone="warning" title="This schedule is stale and must be reviewed">
      <ul className="rotation-reason-list">{health.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      {health.canConfirm
        ? 'Re-confirm to re-pin batches to the current object and gallery versions.'
        : 'Fix the missing references or regenerate the plan before it can be confirmed again.'}
    </Callout>}

    {effectiveStatus === 'draft' && <Callout tone="info" title="Draft available for review">
      Batches were generated from the current plan. Adjust batch labels or move objects between batches, then confirm to pin object and gallery versions.
    </Callout>}

    {effectiveStatus === 'confirmed' && <Callout tone="success" title="Confirmed schedule">
      Every batch is pinned to current object and gallery versions. Any later change to an object's sensitivity, a zone's light conditions, or the opening date returns affected batches to review.
    </Callout>}

    {plan.warnings.length > 0 && <Callout tone="warning" title="Conservation cautions">
      <ul className="rotation-reason-list">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
    </Callout>}

    <div className="rotation-batch-list">
      {plan.batches.map((batch) => <BatchCard
        key={batch.id}
        batch={batch}
        batchHealth={batchHealthById.get(batch.id)}
        allBatches={plan.batches}
        editable={effectiveStatus !== 'confirmed'}
        onRename={(label) => {
          const result = props.onRenameBatch(batch.id, label);
          if (!result.ok) props.notify(result.message ?? 'Could not save label.');
        }}
        onMoveArtifact={(artifactId, target) => {
          const result = props.onMoveArtifact(artifactId, batch.id, target);
          if (!result.ok) props.notify(result.message ?? 'Could not move object.');
        }}
      />)}
    </div>
  </section>;
}

function BatchCard(props: {
  batch: RotationBatch;
  batchHealth?: RotationBatchHealth;
  allBatches: RotationBatch[];
  editable: boolean;
  onRename: (label: string) => void;
  onMoveArtifact: (artifactId: string, target: string | 'new') => void;
}) {
  const { batch, batchHealth } = props;
  const { state } = useWorkspace();
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState(batch.label);
  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));

  const stateTone = batchHealth?.state === 'missing' ? 'danger' : batchHealth?.state === 'stale' ? 'warning' : 'positive';
  const stateLabel = batchHealth?.state === 'missing' ? 'Reference missing' : batchHealth?.state === 'stale' ? 'Version stale' : 'Pinned versions current';

  const saveLabel = () => {
    if (labelDraft.trim() && labelDraft !== batch.label) props.onRename(labelDraft);
    setEditingLabel(false);
  };

  return <article className={`rotation-batch state-${batchHealth?.state ?? 'ok'}`}>
    <div className="rotation-batch-head">
      <div className="rotation-batch-title">
        {editingLabel
          ? <span className="rotation-label-edit"><input aria-label="Batch label" value={labelDraft} onChange={(event) => setLabelDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveLabel(); if (event.key === 'Escape') { setLabelDraft(batch.label); setEditingLabel(false); } }} autoFocus /><Button variant="secondary" icon={<Save size={13} />} onClick={saveLabel}>Save</Button></span>
          : <h3>{batch.label} {props.editable && <button className="rotation-inline-edit" aria-label={`Edit label for ${batch.label}`} onClick={() => { setLabelDraft(batch.label); setEditingLabel(true); }}><Pencil size={13} /></button>}</h3>}
        <div className="rotation-batch-meta">
          <Badge tone="info">{ROTATION_CLASS_LABELS[batch.rotationClass]}</Badge>
          {batch.manual && <Badge tone="neutral">Manually adjusted</Badge>}
          <Badge tone={stateTone}>{stateLabel}</Badge>
        </div>
      </div>
      <div className="rotation-batch-cycle">
        <span><CalendarClock size={13} /> {batch.displayDays} days on</span>
        <span><MoonStar size={13} /> {batch.restDays} days rest</span>
      </div>
    </div>

    {batchHealth && batchHealth.reasons.length > 0 && <ul className="rotation-batch-reasons">
      {batchHealth.reasons.map((reason) => <li key={reason}><AlertTriangle size={13} />{reason}</li>)}
    </ul>}

    <div className="rotation-dependency-table" role="table" aria-label={`Pinned versions for ${batch.label}`}>
      <div className="rotation-dependency-row rotation-dependency-head" role="row">
        <span role="columnheader">Object</span><span role="columnheader">Sensitivity</span><span role="columnheader">Gallery version pinned</span><span role="columnheader">Object version</span>{props.editable && <span role="columnheader">Move</span>}
      </div>
      {batch.dependencies.map((dependency) => {
        const liveArtifact = artifactById.get(dependency.artifactId);
        const targets = props.allBatches.filter((candidate) => candidate.id !== batch.id && candidate.rotationClass === batch.rotationClass);
        return <div className="rotation-dependency-row" role="row" key={dependency.artifactId}>
          <span role="cell"><strong>{dependency.artifactTitle}</strong>{liveArtifact && <small>{liveArtifact.accessionId}</small>}</span>
          <span role="cell">{dependency.sensitivity.replace('-', ' ')}</span>
          <span role="cell" className="rotation-version-cell">
            {dependency.zoneName ? <><Lamp size={12} />{dependency.zoneName}<code>{dependency.zoneVersion?.slice(0, 6)}</code></> : <em>Unassigned gallery</em>}
          </span>
          <span role="cell"><code>{dependency.artifactVersion}</code></span>
          {props.editable && <span role="cell" className="rotation-move-cell">
            {targets.length > 0 && <select aria-label={`Move ${dependency.artifactTitle} to batch`} value="" onChange={(event) => { if (event.target.value) props.onMoveArtifact(dependency.artifactId, event.target.value); }}>
              <option value="">Move to…</option>
              {targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
            </select>}
            <Button variant="ghost" icon={<ArrowRightLeft size={13} />} onClick={() => props.onMoveArtifact(dependency.artifactId, 'new')}>New batch</Button>
          </span>}
        </div>;
      })}
    </div>

    <StintTimeline batch={batch} />
  </article>;
}

function StintTimeline({ batch }: { batch: RotationBatch }) {
  const displayStints = batch.stints.filter((stint) => stint.kind === 'display');
  const restStints = batch.stints.filter((stint) => stint.kind === 'rest');
  const visibleStints = batch.stints.slice(0, 6);
  const remaining = batch.stints.length - visibleStints.length;
  return <div className="rotation-stints">
    <div className="rotation-stints-summary">
      <span><TreePine size={13} /> {displayStints.length} display segment{displayStints.length === 1 ? '' : 's'}</span>
      <span>{restStints.length} rest segment{restStints.length === 1 ? '' : 's'}</span>
      <span><CalendarClock size={13} /> {batch.displayDays + batch.restDays}-day cycle</span>
    </div>
    <ol className="rotation-timeline">
      {visibleStints.map((stint, index) => <li key={`${stint.kind}-${stint.startDate}-${index}`} className={`rotation-stint rotation-stint-${stint.kind}`}>
        <span className="rotation-stint-kind">{stint.kind === 'display' ? <SunMedium size={12} /> : <MoonStar size={12} />}{stint.kind}</span>
        <span className="rotation-stint-dates">{formatDate(stint.startDate)} → {formatDate(stint.endDate)}</span>
        {stint.kind === 'display' && <span className="rotation-stint-zone">{stint.zoneName ?? 'Gallery unassigned'}</span>}
      </li>)}
      {remaining > 0 && <li className="rotation-stint-more"><CheckCircle2 size={12} />{remaining} more segments across the full schedule — included in exports</li>}
    </ol>
  </div>;
}
