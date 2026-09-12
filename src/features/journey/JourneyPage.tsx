import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Check, CheckCircle2, Eye, FileWarning, GripVertical, Lightbulb, Minus, Plus, RotateCcw, Route, ShieldAlert, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
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
import { formatMinutes, formatPercent, titleCase } from '../../domain/formatters';
import type { Artifact, WorkspaceState, Zone } from '../../domain/models';
import { normalizeZoneOrder, previewZoneReorder, type ZoneReorderImpact } from '../../domain/zoneReorder';
import { useWorkspace } from '../../state/WorkspaceContext';

export function JourneyPage() {
  const { state, assignArtifact, removePlacement, reorderArtifact, reorderZones } = useWorkspace();
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [showReorder, setShowReorder] = useState(false);
  const analysis = useMemo(() => analyzeJourney(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const unplaced = getUnplacedArtifacts(state.artifacts, state.zones);
  const place = (artifact: Artifact, zone: Zone) => {
    const preview = canPlaceArtifact(artifact, zone);
    if (preview.some((finding) => finding.type === 'error')) { setNotice(preview[0].detail); window.setTimeout(() => setNotice(null), 2800); return; }
    const result = assignArtifact(artifact.id, zone.id);
    if (!result.ok) { setNotice(result.message ?? 'Placement failed.'); window.setTimeout(() => setNotice(null), 2800); }
    setSelectedArtifact(null);
  };
  const commitReorder = (order: string[], baseSignature: string) => {
    const result = reorderZones(order, baseSignature);
    if (result.ok && result.value) {
      const impact: ZoneReorderImpact = result.value;
      const parts = [`Zone order updated — ${impact.changes.length} zone${impact.changes.length === 1 ? '' : 's'} moved`];
      if (impact.staleExports.length) parts.push(`${impact.staleExports.length} exported material${impact.staleExports.length === 1 ? '' : 's'} marked out of date`);
      if (impact.reReviewIssues.length) parts.push(`${impact.reReviewIssues.length} finding${impact.reReviewIssues.length === 1 ? '' : 's'} flagged for re-review`);
      if (impact.readinessRegresses) parts.push('project returned to review');
      setConfirmation(parts.join(' · '));
      window.setTimeout(() => setConfirmation(null), 3600);
      setShowReorder(false);
    }
    return result;
  };
  return <div className="page-stack"><SectionHeader eyebrow="SPATIAL EDITOR" title="Visitor journey" description="Arrange the sequence, then let the constraint engine challenge the story." actions={<div className="header-button-row"><div className="inline-status"><Route size={16} /><span>{formatMinutes(analysis.totalDwellMinutes)} planned visit</span></div><Button variant="secondary" icon={<ArrowUpDown size={15} />} onClick={() => setShowReorder(true)}>Reorder zones</Button></div>} />
    <div className="metric-grid four"><Metric label="Placed objects" value={`${analysis.placedCount}/${state.artifacts.length}`} detail={`${analysis.unplacedCount} unplaced`} icon={<Eye size={17} />} tone="teal" /><Metric label="Key coverage" value={formatPercent(analysis.keyObjectCoverage)} detail="Required objects" icon={<ShieldCheck size={17} />} tone={analysis.keyObjectCoverage === 1 ? 'teal' : 'red'} /><Metric label="Role coverage" value={formatPercent(analysis.roleCoverage)} detail="Story arc" icon={<Sparkles size={17} />} tone={analysis.roleCoverage === 1 ? 'teal' : 'amber'} /><Metric label="Constraints" value={`${analysis.blockingCount} errors`} detail={`${analysis.warningCount} warnings`} icon={<AlertTriangle size={17} />} tone={analysis.blockingCount ? 'red' : 'amber'} /></div>
    <div className="journey-layout"><section className="journey-board"><div className="board-header"><div><div className="eyebrow">SEQUENCE BOARD</div><h2>Visitor flow</h2></div><div className="board-legend"><span><i className="legend-dot legend-placed" /> placed</span><span><i className="legend-dot legend-issue" /> needs attention</span></div></div><div className="zone-list">{state.zones.slice().sort((a, b) => a.sequence - b.sequence).map((zone, index) => <ZoneLane key={zone.id} zone={zone} index={index} artifacts={state.artifacts} analysis={analysis.zones.find((item) => item.zoneId === zone.id)} selectedArtifact={selectedArtifact} onSelect={setSelectedArtifact} onPlace={place} onRemove={removePlacement} onReorder={reorderArtifact} />)}</div></section><aside className="journey-sidebar"><div className="panel-heading"><div><div className="eyebrow">UNPLACED</div><h3>Object queue</h3></div><Badge tone={unplaced.length ? 'warning' : 'positive'}>{unplaced.length}</Badge></div>{unplaced.length ? <div className="unplaced-list">{unplaced.map((artifact) => <button className={`unplaced-item ${selectedArtifact === artifact.id ? 'selected' : ''}`} key={artifact.id} onClick={() => setSelectedArtifact(selectedArtifact === artifact.id ? null : artifact.id)}><ArtifactGlyph color={artifact.color} size="small" /><span><strong>{artifact.title}</strong><small>{artifact.accessionId} · {titleCase(artifact.narrativeRole)}</small></span><Plus size={15} /></button>)}</div> : <EmptyState icon={<CheckCircle2 size={22} />} title="Queue is clear" detail="Every collection object has a place in the visitor journey." />}<div className="constraint-panel"><div className="panel-heading"><div><div className="eyebrow">ANALYSIS</div><h3>Constraint review</h3></div><Badge tone={analysis.blockingCount ? 'danger' : 'positive'}>{analysis.blockingCount ? 'Blocked' : 'Clear'}</Badge></div>{analysis.findings.length ? <div className="finding-list compact">{analysis.findings.slice(0, 5).map((finding) => <div className={`finding-row ${finding.type}`} key={finding.id}>{finding.type === 'error' ? <XCircle size={15} /> : finding.type === 'warning' ? <AlertTriangle size={15} /> : <Lightbulb size={15} />}<span><strong>{finding.title}</strong><small>{finding.detail}</small></span></div>)}</div> : <div className="clear-message"><CheckCircle2 size={17} /> No constraints detected</div>}</div></aside></div>{showReorder && <ReorderZonesModal state={state} onClose={() => setShowReorder(false)} onCommit={commitReorder} />}{notice && <div className="toast toast-warning"><AlertTriangle size={16} />{notice}</div>}{confirmation && <div className="toast toast-positive"><CheckCircle2 size={16} />{confirmation}</div>}</div>;
}

interface ReorderCommitResult { ok: boolean; message?: string; code?: 'conflict' | 'validation' }

function ReorderZonesModal({ state, onClose, onCommit }: { state: WorkspaceState; onClose: () => void; onCommit: (order: string[], baseSignature: string) => ReorderCommitResult }) {
  const currentOrder = useMemo(() => normalizeZoneOrder(state.zones).map((zone) => zone.id), [state.zones]);
  const [staged, setStaged] = useState<string[]>(currentOrder);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const preview = useMemo(() => previewZoneReorder(state, staged), [state, staged]);
  const zoneById = useMemo(() => new Map(state.zones.map((zone) => [zone.id, zone])), [state.zones]);
  const impact = preview.ok ? preview.preview.impact : null;
  const isNoOp = preview.ok && preview.preview.isNoOp;

  const move = (zoneId: string, direction: -1 | 1) => {
    setStaged((current) => {
      const index = current.indexOf(zoneId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setError(null);
    setConflict(false);
  };
  const resetToCurrent = () => { setStaged(currentOrder); setError(null); setConflict(false); };
  const confirm = () => {
    if (!preview.ok || preview.preview.isNoOp) return;
    const result = onCommit(staged, preview.preview.baseSignature);
    if (result.ok) return;
    setError(result.message ?? 'The new order could not be applied.');
    setConflict(result.code === 'conflict');
  };

  const routeChips = (nodes: ZoneReorderImpact['timelineBefore']['nodes'], className: string) => (
    <div className={`impact-route ${className}`}>{nodes.map((node, index) => {
      const zone = zoneById.get(node.zoneId);
      return <span className="route-fragment" key={node.zoneId}>{index > 0 && <ArrowRight size={12} />}<span className="route-chip">{zone?.shortLabel ?? node.zoneName} · {node.dwellMinutes}m</span></span>;
    })}</div>
  );

  return <Modal eyebrow="SEQUENCE CHANGE" title="Reorder zones" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>{conflict && <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={resetToCurrent}>Reset to current order</Button>}<Button variant="primary" icon={<Check size={15} />} disabled={!preview.ok || isNoOp} onClick={confirm}>Apply new order</Button></>}>
    <p className="reorder-intro">Stage a new visit order, review its downstream impact, then apply it as one change. Exports made against the old order are marked out of date; nothing changes until you apply.</p>
    <div className="reorder-list">{staged.map((id, index) => {
      const zone = zoneById.get(id);
      if (!zone) return null;
      const change = impact?.changes.find((candidate) => candidate.zoneId === id);
      return <div className={`reorder-row ${change ? 'moved' : ''}`} key={id}>
        <span className="reorder-pos">{String(index + 1).padStart(2, '0')}</span>
        <span className="reorder-dot" style={{ backgroundColor: zone.color }} />
        <span className="reorder-name"><strong>{zone.name}</strong><small>{zone.artifactIds.length} object{zone.artifactIds.length === 1 ? '' : 's'}</small></span>
        {change && <span className="reorder-delta">{change.fromIndex + 1} → {change.toIndex + 1}</span>}
        <span className="reorder-actions">
          <Button variant="ghost" icon={<ArrowUp size={14} />} aria-label={`Move ${zone.name} up`} disabled={index === 0} onClick={() => move(id, -1)} />
          <Button variant="ghost" icon={<ArrowDown size={14} />} aria-label={`Move ${zone.name} down`} disabled={index === staged.length - 1} onClick={() => move(id, 1)} />
        </span>
      </div>;
    })}</div>
    {!preview.ok && <div className="reorder-conflict"><AlertTriangle size={14} /><span>{preview.errors[0]}</span></div>}
    {error && <div className="reorder-conflict"><AlertTriangle size={14} /><span>{error}</span></div>}
    {preview.ok && !isNoOp && impact && <div className="reorder-impact">
      <div className="impact-block"><div className="eyebrow">VISIT TIMELINE</div>
        {routeChips(impact.timelineBefore.nodes, 'before')}
        {routeChips(impact.timelineAfter.nodes, 'after')}
        {impact.newHandoffs.length > 0 && <div className="impact-row"><ArrowRight size={13} /><span>New handoff{impact.newHandoffs.length === 1 ? '' : 's'}: {impact.newHandoffs.join(' · ')}</span></div>}
      </div>
      <div className="impact-block"><div className="eyebrow">EXPORTED MATERIALS</div>
        {impact.staleExports.length ? impact.staleExports.map((record) => <div className="impact-row" key={record.id}><FileWarning size={13} /><span><strong>{record.label}</strong> will be marked out of date.</span></div>) : <div className="impact-row"><CheckCircle2 size={13} /><span>No exported materials are affected.</span></div>}
      </div>
      <div className="impact-block"><div className="eyebrow">READINESS & FINDINGS</div>
        {impact.readinessRegresses && <div className="impact-row"><ShieldAlert size={13} /><span>The project will return from Ready to Review.</span></div>}
        {impact.reReviewIssues.map((issue) => <div className="impact-row" key={issue.id}><RotateCcw size={13} /><span><strong>{issue.title}</strong> will be flagged for re-review.</span></div>)}
        {!impact.readinessRegresses && impact.reReviewIssues.length === 0 && <div className="impact-row"><CheckCircle2 size={13} /><span>Readiness state and findings are unaffected.</span></div>}
      </div>
    </div>}
    {isNoOp && <p className="reorder-intro">The staged order matches the current sequence — move a zone to preview the impact.</p>}
  </Modal>;
}

function ZoneLane({ zone, index, artifacts, analysis, selectedArtifact, onSelect, onPlace, onRemove, onReorder }: { zone: Zone; index: number; artifacts: Artifact[]; analysis?: ReturnType<typeof analyzeJourney>['zones'][number]; selectedArtifact: string | null; onSelect?: (id: string | null) => void; onPlace: (artifact: Artifact, zone: Zone) => void; onRemove: (id: string) => void; onReorder: (zoneId: string, artifactId: string, direction: -1 | 1) => void }) {
  void onSelect;
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const placed = zone.artifactIds.map((id) => artifactMap.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
  const selected = selectedArtifact ? artifactMap.get(selectedArtifact) : undefined;
  const issueCount = analysis?.findings.filter((finding) => finding.type === 'error').length ?? 0;
  return <article className="zone-lane"><div className="zone-marker" style={{ backgroundColor: zone.color }}><span>{String(index + 1).padStart(2, '0')}</span></div><div className="zone-content"><div className="zone-head"><div><div className="zone-title-line"><h3>{zone.name}</h3>{issueCount > 0 && <Badge tone="danger">{issueCount} issue{issueCount > 1 ? 's' : ''}</Badge>}</div><p>{zone.thesis}</p></div><div className="zone-stats"><span>{placed.length}/{zone.maxObjects} objects</span><span>{analysis?.dwellMinutes ?? 0}/{zone.capacityMinutes} min</span></div></div><ProgressBar value={(analysis?.utilization ?? 0) * 100} tone={issueCount ? 'red' : (analysis?.utilization ?? 0) >= 0.8 ? 'amber' : 'teal'} /><div className="zone-flags"><span>{zone.lowLight ? 'Low-light' : 'Standard light'}</span><span>{zone.hasSeating ? 'Seating available' : 'Standing interpretation'}</span></div><div className="placement-list">{placed.map((artifact, artifactIndex) => <div className="placement-item" key={artifact.id}><GripVertical size={15} className="drag-handle" /><ArtifactGlyph color={artifact.color} size="small" /><div className="placement-info"><strong>{artifact.title}</strong><span>{titleCase(artifact.narrativeRole)} · {artifact.dwellMinutes} min</span></div><div className="placement-actions"><Button variant="ghost" icon={<ArrowUp size={14} />} aria-label={`Move ${artifact.title} up`} disabled={artifactIndex === 0} onClick={() => onReorder(zone.id, artifact.id, -1)} /><Button variant="ghost" icon={<ArrowDown size={14} />} aria-label={`Move ${artifact.title} down`} disabled={artifactIndex === placed.length - 1} onClick={() => onReorder(zone.id, artifact.id, 1)} /><Button variant="ghost" icon={<Minus size={14} />} aria-label={`Remove ${artifact.title}`} onClick={() => onRemove(artifact.id)} /></div></div>)}{selected && !zone.artifactIds.includes(selected.id) && <button className="drop-target" onClick={() => onPlace(selected, zone)}><Plus size={15} /> Place <strong>{selected.title}</strong> here</button>}{placed.length === 0 && !selected && <div className="zone-empty">Select an object from the queue to place it here.</div>}</div></div></article>;
}
