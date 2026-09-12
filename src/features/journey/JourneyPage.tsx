import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Eye, FileDown, GripVertical, History, Lightbulb, Minus, Plus, RotateCcw, Route, ShieldAlert, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ArtifactGlyph } from '../../components/ArtifactGlyph';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { Modal } from '../../components/Modal';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { analyzeJourney, canPlaceArtifact, getUnplacedArtifacts } from '../../domain/journeyAnalysis';
import { formatMinutes, formatPercent, formatDate, titleCase } from '../../domain/formatters';
import { RESTORE_CONFLICT_LABELS } from '../../domain/placementRecovery';
import type { Artifact, PlacementRemoval, RemovalPlan, Zone } from '../../domain/models';
import { useWorkspace } from '../../state/WorkspaceContext';

export function JourneyPage() {
  const { state, assignArtifact, planPlacementRemoval, removePlacement, restorePlacement, discardRemoval, reorderArtifact } = useWorkspace();
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [removalPlan, setRemovalPlan] = useState<RemovalPlan | null>(null);
  const [notice, setNotice] = useState<{ kind: 'warning' | 'positive'; text: string } | null>(null);
  const analysis = useMemo(() => analyzeJourney(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const unplaced = getUnplacedArtifacts(state.artifacts, state.zones);
  const activeRemovals = state.removals.filter((removal) => removal.status === 'held' || removal.status === 'in-review');

  const notify = (kind: 'warning' | 'positive', text: string) => {
    setNotice({ kind, text });
    window.setTimeout(() => setNotice(null), 3200);
  };

  const place = (artifact: Artifact, zone: Zone) => {
    const preview = canPlaceArtifact(artifact, zone);
    if (preview.some((finding) => finding.type === 'error')) { notify('warning', preview[0].detail); return; }
    const result = assignArtifact(artifact.id, zone.id);
    if (!result.ok) { notify('warning', result.message ?? 'Placement failed.'); }
    setSelectedArtifact(null);
  };

  const requestRemoval = (artifactId: string) => {
    const plan = planPlacementRemoval(artifactId);
    if (!plan) { notify('warning', 'This object is not placed in the journey.'); return; }
    setRemovalPlan(plan);
  };

  const confirmRemoval = () => {
    if (!removalPlan) return;
    const result = removePlacement(removalPlan.artifactId);
    setRemovalPlan(null);
    if (result.ok) notify('positive', `Object removed from the journey. It can be restored from the recovery list.`);
    else notify('warning', result.message ?? 'Removal failed.');
  };

  const restore = (removalId: string, approved = false) => {
    const result = restorePlacement(removalId, { approved });
    notify(result.ok ? 'positive' : 'warning', result.message ?? 'Restore could not be completed.');
  };

  return <div className="page-stack"><SectionHeader eyebrow="SPATIAL EDITOR" title="Visitor journey" description="Arrange the sequence, then let the constraint engine challenge the story." actions={<div className="inline-status"><Route size={16} /><span>{formatMinutes(analysis.totalDwellMinutes)} planned visit</span></div>} />
    <div className="metric-grid four"><Metric label="Placed objects" value={`${analysis.placedCount}/${state.artifacts.length}`} detail={`${analysis.unplacedCount} unplaced`} icon={<Eye size={17} />} tone="teal" /><Metric label="Key coverage" value={formatPercent(analysis.keyObjectCoverage)} detail="Required objects" icon={<ShieldCheck size={17} />} tone={analysis.keyObjectCoverage === 1 ? 'teal' : 'red'} /><Metric label="Role coverage" value={formatPercent(analysis.roleCoverage)} detail="Story arc" icon={<Sparkles size={17} />} tone={analysis.roleCoverage === 1 ? 'teal' : 'amber'} /><Metric label="Constraints" value={`${analysis.blockingCount} errors`} detail={`${analysis.warningCount} warnings`} icon={<AlertTriangle size={17} />} tone={analysis.blockingCount ? 'red' : 'amber'} /></div>
    <div className="journey-layout"><section className="journey-board"><div className="board-header"><div><div className="eyebrow">SEQUENCE BOARD</div><h2>Visitor flow</h2></div><div className="board-legend"><span><i className="legend-dot legend-placed" /> placed</span><span><i className="legend-dot legend-issue" /> needs attention</span></div></div><div className="zone-list">{state.zones.slice().sort((a, b) => a.sequence - b.sequence).map((zone, index) => <ZoneLane key={zone.id} zone={zone} index={index} artifacts={state.artifacts} analysis={analysis.zones.find((item) => item.zoneId === zone.id)} selectedArtifact={selectedArtifact} onSelect={setSelectedArtifact} onPlace={place} onRemove={requestRemoval} onReorder={reorderArtifact} />)}</div></section><aside className="journey-sidebar"><div className="panel-heading"><div><div className="eyebrow">UNPLACED</div><h3>Object queue</h3></div><Badge tone={unplaced.length ? 'warning' : 'positive'}>{unplaced.length}</Badge></div>{unplaced.length ? <div className="unplaced-list">{unplaced.map((artifact) => <button className={`unplaced-item ${selectedArtifact === artifact.id ? 'selected' : ''}`} key={artifact.id} onClick={() => setSelectedArtifact(selectedArtifact === artifact.id ? null : artifact.id)}><ArtifactGlyph color={artifact.color} size="small" /><span><strong>{artifact.title}</strong><small>{artifact.accessionId} · {titleCase(artifact.narrativeRole)}</small></span><Plus size={15} /></button>)}</div> : <EmptyState icon={<CheckCircle2 size={22} />} title="Queue is clear" detail="Every collection object has a place in the visitor journey." />}
      <RecoveryPanel removals={activeRemovals} artifacts={state.artifacts} zones={state.zones} onRestore={restore} onDiscard={discardRemoval} />      <div className="constraint-panel"><div className="panel-heading"><div><div className="eyebrow">ANALYSIS</div><h3>Constraint review</h3></div><Badge tone={analysis.blockingCount ? 'danger' : 'positive'}>{analysis.blockingCount ? 'Blocked' : 'Clear'}</Badge></div>{analysis.findings.length ? <div className="finding-list compact">{analysis.findings.slice(0, 5).map((finding) => <div className={`finding-row ${finding.type}`} key={finding.id}>{finding.type === 'error' ? <XCircle size={15} /> : finding.type === 'warning' ? <AlertTriangle size={15} /> : <Lightbulb size={15} />}<span><strong>{finding.title}</strong><small>{finding.detail}</small></span></div>)}</div> : <div className="clear-message"><CheckCircle2 size={17} /> No constraints detected</div>}</div></aside></div>
    {removalPlan && <RemovalConfirmModal plan={removalPlan} onCancel={() => setRemovalPlan(null)} onConfirm={confirmRemoval} />}
    {notice && <div className={`toast ${notice.kind === 'positive' ? 'toast-positive' : 'toast-warning'}`}>{notice.kind === 'positive' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}{notice.text}</div>}
  </div>;
}

function ZoneLane({ zone, index, artifacts, analysis, selectedArtifact, onSelect, onPlace, onRemove, onReorder }: { zone: Zone; index: number; artifacts: Artifact[]; analysis?: ReturnType<typeof analyzeJourney>['zones'][number]; selectedArtifact: string | null; onSelect?: (id: string | null) => void; onPlace: (artifact: Artifact, zone: Zone) => void; onRemove: (id: string) => void; onReorder: (zoneId: string, artifactId: string, direction: -1 | 1) => void }) {
  void onSelect;
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const placed = zone.artifactIds.map((id) => artifactMap.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
  const selected = selectedArtifact ? artifactMap.get(selectedArtifact) : undefined;
  const issueCount = analysis?.findings.filter((finding) => finding.type === 'error').length ?? 0;
  return <article className="zone-lane"><div className="zone-marker" style={{ backgroundColor: zone.color }}><span>{String(index + 1).padStart(2, '0')}</span></div><div className="zone-content"><div className="zone-head"><div><div className="zone-title-line"><h3>{zone.name}</h3>{issueCount > 0 && <Badge tone="danger">{issueCount} issue{issueCount > 1 ? 's' : ''}</Badge>}</div><p>{zone.thesis}</p></div><div className="zone-stats"><span>{placed.length}/{zone.maxObjects} objects</span><span>{analysis?.dwellMinutes ?? 0}/{zone.capacityMinutes} min</span></div></div><ProgressBar value={(analysis?.utilization ?? 0) * 100} tone={issueCount ? 'red' : (analysis?.utilization ?? 0) >= 0.8 ? 'amber' : 'teal'} /><div className="zone-flags"><span>{zone.lowLight ? 'Low-light' : 'Standard light'}</span><span>{zone.hasSeating ? 'Seating available' : 'Standing interpretation'}</span></div><div className="placement-list">{placed.map((artifact, artifactIndex) => <div className="placement-item" key={artifact.id}><GripVertical size={15} className="drag-handle" /><ArtifactGlyph color={artifact.color} size="small" /><div className="placement-info"><strong>{artifact.title}</strong><span>{titleCase(artifact.narrativeRole)} · {artifact.dwellMinutes} min</span></div><div className="placement-actions"><Button variant="ghost" icon={<ArrowUp size={14} />} aria-label={`Move ${artifact.title} up`} disabled={artifactIndex === 0} onClick={() => onReorder(zone.id, artifact.id, -1)} /><Button variant="ghost" icon={<ArrowDown size={14} />} aria-label={`Move ${artifact.title} down`} disabled={artifactIndex === placed.length - 1} onClick={() => onReorder(zone.id, artifact.id, 1)} /><Button variant="ghost" icon={<Minus size={14} />} aria-label={`Remove ${artifact.title}`} onClick={() => onRemove(artifact.id)} /></div></div>)}{selected && !zone.artifactIds.includes(selected.id) && <button className="drop-target" onClick={() => onPlace(selected, zone)}><Plus size={15} /> Place <strong>{selected.title}</strong> here</button>}{placed.length === 0 && !selected && <div className="zone-empty">Select an object from the queue to place it here.</div>}</div></div></article>;
}

function RemovalConfirmModal({ plan, onCancel, onConfirm }: { plan: RemovalPlan; onCancel: () => void; onConfirm: () => void }) {
  return <Modal title={`Remove ${plan.artifactTitle}?`} eyebrow="RECOVERABLE REMOVAL" onClose={onCancel} footer={<><Button variant="secondary" onClick={onCancel}>Keep in place</Button><Button variant="danger" icon={<Minus size={15} />} onClick={onConfirm}>Remove to recovery list</Button></>}>
    <div className="removal-confirm">
      <p className="removal-lede">The placement leaves the sequence board but is saved as a recovery transaction. The object stays in the collection and linked findings are kept.</p>
      <div className="removal-detail-grid">
        <div><span className="eyebrow">Source placement</span><strong>{plan.zoneName}</strong><small>Position {plan.index + 1} in the visitor sequence</small></div>
        <div><span className="eyebrow">Adjacent objects</span><strong>{plan.neighborBeforeTitle ?? '—'} ／ {plan.neighborAfterTitle ?? '—'}</strong><small>Used to return to the same slot</small></div>
      </div>
      <div className="removal-context">
        <div><span className="eyebrow">LINKED FINDINGS · {plan.relatedFindings.length}</span>{plan.relatedFindings.length ? <ul>{plan.relatedFindings.map((finding) => <li key={finding.issueId}><Badge tone={finding.severity === 'critical' ? 'danger' : finding.severity === 'warning' ? 'warning' : 'neutral'}>{finding.severity}</Badge><span>{finding.title} · {titleCase(finding.status)}</span></li>)}</ul> : <small>No findings are linked to this object or its zone.</small>}</div>
        <div><span className="eyebrow">EXPORT DEPENDENCIES · {plan.exportDependencies.length}</span>{plan.exportDependencies.length ? <ul>{plan.exportDependencies.map((dependency) => <li key={dependency.snapshotGeneratedAt}><FileDown size={14} /><span>Snapshot published {formatDate(dependency.snapshotGeneratedAt)} · score {dependency.readinessScore}</span></li>)}</ul> : <small>No published snapshot currently contains this object.</small>}</div>
      </div>
      <p className="removal-note"><ShieldAlert size={14} /> Published snapshots and release packages are never rewritten by a later restore.</p>
    </div>
  </Modal>;
}

function RecoveryPanel({ removals, artifacts, zones, onRestore, onDiscard }: { removals: PlacementRemoval[]; artifacts: Artifact[]; zones: Zone[]; onRestore: (removalId: string, approved?: boolean) => void; onDiscard: (removalId: string) => void }) {
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));
  return <div className="recovery-panel"><div className="panel-heading"><div><div className="eyebrow">RECOVERY</div><h3>Removed placements</h3></div><Badge tone={removals.length ? 'info' : 'neutral'}>{removals.length}</Badge></div>
    {removals.length ? <div className="recovery-list">{removals.map((removal) => {
      const artifact = artifactById.get(removal.artifactId);
      const zone = zoneById.get(removal.zoneId);
      const inReview = removal.status === 'in-review';
      const needsSignOff = inReview && (removal.conflictReason === 'object-modified' || removal.conflictReason === 'constraint-violation' || removal.conflictReason === 'export-dependency-stale');
      return <div className={`recovery-item ${inReview ? 'in-review' : ''}`} key={removal.id}>
        <div className="recovery-head">{inReview ? <ShieldAlert size={15} className="text-amber" /> : <History size={15} />}<strong>{artifact?.title ?? removal.artifactId}</strong><Badge tone={inReview ? 'warning' : 'info'}>{inReview && removal.conflictReason ? RESTORE_CONFLICT_LABELS[removal.conflictReason] : 'Held'}</Badge></div>
        <small>Removed from {zone?.name ?? 'a deleted zone'} · position {removal.index + 1} · {formatDate(removal.createdAt)}</small>
        {inReview && <p className="recovery-conflict">{removal.conflictDetail}</p>}
        <div className="recovery-actions">
          <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={() => onRestore(removal.id)}>{inReview ? 'Re-check restore' : 'Restore placement'}</Button>
          {needsSignOff && <Button variant="primary" icon={<CheckCircle2 size={14} />} onClick={() => onRestore(removal.id, true)}>Restore after review</Button>}
          <Button variant="ghost" onClick={() => onDiscard(removal.id)}>Discard record</Button>
        </div>
      </div>;
    })}</div> : <EmptyState icon={<History size={22} />} title="No held removals" detail="Removing a placement keeps it here for recovery." />}
  </div>;
}
