import { AlertTriangle, ArrowDown, ArrowLeftRight, ArrowUp, CheckCircle2, Eye, GripVertical, Lightbulb, Minus, Plus, Route, ShieldCheck, Sparkles, X, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ArtifactGlyph } from '../../components/ArtifactGlyph';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { analyzeJourney, canPlaceArtifact, getUnplacedArtifacts } from '../../domain/journeyAnalysis';
import { formatMinutes, formatPercent, titleCase } from '../../domain/formatters';
import { planArtifactSwap, type SwapPreview } from '../../domain/swap';
import type { Artifact, Zone } from '../../domain/models';
import { useWorkspace } from '../../state/WorkspaceContext';
import { SwapDialog } from './SwapDialog';

export function JourneyPage() {
  const { state, assignArtifact, removePlacement, reorderArtifact, swapArtifacts } = useWorkspace();
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [swapSourceId, setSwapSourceId] = useState<string | null>(null);
  const [swapPreview, setSwapPreview] = useState<SwapPreview | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const analysis = useMemo(() => analyzeJourney(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const unplaced = getUnplacedArtifacts(state.artifacts, state.zones);
  const artifactMap = useMemo(() => new Map(state.artifacts.map((artifact) => [artifact.id, artifact])), [state.artifacts]);
  const zoneMap = useMemo(() => new Map(state.zones.map((zone) => [zone.id, zone])), [state.zones]);
  const swapSource = swapSourceId ? artifactMap.get(swapSourceId) : undefined;
  const flash = (message: string) => { setNotice(message); window.setTimeout(() => setNotice(null), 2800); };
  const place = (artifact: Artifact, zone: Zone) => {
    const preview = canPlaceArtifact(artifact, zone);
    if (preview.some((finding) => finding.type === 'error')) { flash(preview[0].detail); return; }
    const result = assignArtifact(artifact.id, zone.id);
    if (!result.ok) flash(result.message ?? 'Placement failed.');
    setSelectedArtifact(null);
  };
  const beginSwap = (artifactId: string) => {
    if (!swapSourceId) { setSwapSourceId(artifactId); return; }
    if (swapSourceId === artifactId) { setSwapSourceId(null); return; }
    const sourceZone = state.zones.find((zone) => zone.artifactIds.includes(swapSourceId));
    const targetZone = state.zones.find((zone) => zone.artifactIds.includes(artifactId));
    if (sourceZone && targetZone && sourceZone.id === targetZone.id) { flash('Pick an object in another zone to complete the swap.'); return; }
    const preview = planArtifactSwap(state, swapSourceId, artifactId);
    setSwapSourceId(null);
    if (!preview) { flash('One of the objects is no longer placed.'); return; }
    setSwapError(null);
    setSwapPreview(preview);
  };
  const closeSwap = () => { setSwapPreview(null); setSwapError(null); };
  const confirmSwap = () => {
    if (!swapPreview) return;
    const result = swapArtifacts(swapPreview);
    if (!result.ok) { setSwapError(result.message ?? 'Swap could not be applied.'); return; }
    const firstTitle = artifactMap.get(swapPreview.first.artifactId)?.title ?? 'object';
    const secondTitle = artifactMap.get(swapPreview.second.artifactId)?.title ?? 'object';
    closeSwap();
    flash(`Swapped ${firstTitle} with ${secondTitle}.`);
  };
  return <div className="page-stack"><SectionHeader eyebrow="SPATIAL EDITOR" title="Visitor journey" description="Arrange the sequence, then let the constraint engine challenge the story." actions={<div className="inline-status"><Route size={16} /><span>{formatMinutes(analysis.totalDwellMinutes)} planned visit</span></div>} />
    <div className="metric-grid four"><Metric label="Placed objects" value={`${analysis.placedCount}/${state.artifacts.length}`} detail={`${analysis.unplacedCount} unplaced`} icon={<Eye size={17} />} tone="teal" /><Metric label="Key coverage" value={formatPercent(analysis.keyObjectCoverage)} detail="Required objects" icon={<ShieldCheck size={17} />} tone={analysis.keyObjectCoverage === 1 ? 'teal' : 'red'} /><Metric label="Role coverage" value={formatPercent(analysis.roleCoverage)} detail="Story arc" icon={<Sparkles size={17} />} tone={analysis.roleCoverage === 1 ? 'teal' : 'amber'} /><Metric label="Constraints" value={`${analysis.blockingCount} errors`} detail={`${analysis.warningCount} warnings`} icon={<AlertTriangle size={17} />} tone={analysis.blockingCount ? 'red' : 'amber'} /></div>
    <div className="journey-layout"><section className="journey-board"><div className="board-header"><div><div className="eyebrow">SEQUENCE BOARD</div><h2>Visitor flow</h2></div><div className="board-legend"><span><i className="legend-dot legend-placed" /> placed</span><span><i className="legend-dot legend-issue" /> needs attention</span></div></div>
      {swapSource && <div className="swap-hint"><ArrowLeftRight size={15} /><span>Swapping <strong>{swapSource.title}</strong> — pick an object in another zone.</span><Button variant="ghost" icon={<X size={14} />} aria-label="Cancel swap" onClick={() => setSwapSourceId(null)} /></div>}
      <div className="zone-list">{state.zones.slice().sort((a, b) => a.sequence - b.sequence).map((zone, index) => <ZoneLane key={zone.id} zone={zone} index={index} artifacts={state.artifacts} analysis={analysis.zones.find((item) => item.zoneId === zone.id)} selectedArtifact={selectedArtifact} swapSourceId={swapSourceId} onSelect={setSelectedArtifact} onPlace={place} onRemove={removePlacement} onReorder={reorderArtifact} onSwap={beginSwap} />)}</div></section><aside className="journey-sidebar"><div className="panel-heading"><div><div className="eyebrow">UNPLACED</div><h3>Object queue</h3></div><Badge tone={unplaced.length ? 'warning' : 'positive'}>{unplaced.length}</Badge></div>{unplaced.length ? <div className="unplaced-list">{unplaced.map((artifact) => <button className={`unplaced-item ${selectedArtifact === artifact.id ? 'selected' : ''}`} key={artifact.id} onClick={() => setSelectedArtifact(selectedArtifact === artifact.id ? null : artifact.id)}><ArtifactGlyph color={artifact.color} size="small" /><span><strong>{artifact.title}</strong><small>{artifact.accessionId} · {titleCase(artifact.narrativeRole)}</small></span><Plus size={15} /></button>)}</div> : <EmptyState icon={<CheckCircle2 size={22} />} title="Queue is clear" detail="Every collection object has a place in the visitor journey." />}<div className="constraint-panel"><div className="panel-heading"><div><div className="eyebrow">ANALYSIS</div><h3>Constraint review</h3></div><Badge tone={analysis.blockingCount ? 'danger' : 'positive'}>{analysis.blockingCount ? 'Blocked' : 'Clear'}</Badge></div>{analysis.findings.length ? <div className="finding-list compact">{analysis.findings.slice(0, 5).map((finding) => <div className={`finding-row ${finding.type}`} key={finding.id}>{finding.type === 'error' ? <XCircle size={15} /> : finding.type === 'warning' ? <AlertTriangle size={15} /> : <Lightbulb size={15} />}<span><strong>{finding.title}</strong><small>{finding.detail}</small></span></div>)}</div> : <div className="clear-message"><CheckCircle2 size={17} /> No constraints detected</div>}</div></aside></div>
    {swapPreview && <SwapDialog preview={swapPreview} artifacts={artifactMap} zones={zoneMap} error={swapError} onCancel={closeSwap} onConfirm={confirmSwap} />}
    {notice && <div className="toast toast-warning"><AlertTriangle size={16} />{notice}</div>}</div>;
}

function ZoneLane({ zone, index, artifacts, analysis, selectedArtifact, swapSourceId, onSelect, onPlace, onRemove, onReorder, onSwap }: { zone: Zone; index: number; artifacts: Artifact[]; analysis?: ReturnType<typeof analyzeJourney>['zones'][number]; selectedArtifact: string | null; swapSourceId: string | null; onSelect?: (id: string | null) => void; onPlace: (artifact: Artifact, zone: Zone) => void; onRemove: (id: string) => void; onReorder: (zoneId: string, artifactId: string, direction: -1 | 1) => void; onSwap: (id: string) => void }) {
  void onSelect;
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const placed = zone.artifactIds.map((id) => artifactMap.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
  const selected = selectedArtifact ? artifactMap.get(selectedArtifact) : undefined;
  const issueCount = analysis?.findings.filter((finding) => finding.type === 'error').length ?? 0;
  return <article className="zone-lane"><div className="zone-marker" style={{ backgroundColor: zone.color }}><span>{String(index + 1).padStart(2, '0')}</span></div><div className="zone-content"><div className="zone-head"><div><div className="zone-title-line"><h3>{zone.name}</h3>{issueCount > 0 && <Badge tone="danger">{issueCount} issue{issueCount > 1 ? 's' : ''}</Badge>}</div><p>{zone.thesis}</p></div><div className="zone-stats"><span>{placed.length}/{zone.maxObjects} objects</span><span>{analysis?.dwellMinutes ?? 0}/{zone.capacityMinutes} min</span></div></div><ProgressBar value={(analysis?.utilization ?? 0) * 100} tone={issueCount ? 'red' : (analysis?.utilization ?? 0) >= 0.8 ? 'amber' : 'teal'} /><div className="zone-flags"><span>{zone.lowLight ? 'Low-light' : 'Standard light'}</span><span>{zone.hasSeating ? 'Seating available' : 'Standing interpretation'}</span></div><div className="placement-list">{placed.map((artifact, artifactIndex) => <div className={`placement-item ${swapSourceId === artifact.id ? 'swap-armed' : ''}`} key={artifact.id}><GripVertical size={15} className="drag-handle" /><ArtifactGlyph color={artifact.color} size="small" /><div className="placement-info"><strong>{artifact.title}</strong><span>{titleCase(artifact.narrativeRole)} · {artifact.dwellMinutes} min</span></div><div className="placement-actions"><Button variant="ghost" icon={<ArrowUp size={14} />} aria-label={`Move ${artifact.title} up`} disabled={artifactIndex === 0} onClick={() => onReorder(zone.id, artifact.id, -1)} /><Button variant="ghost" icon={<ArrowDown size={14} />} aria-label={`Move ${artifact.title} down`} disabled={artifactIndex === placed.length - 1} onClick={() => onReorder(zone.id, artifact.id, 1)} /><Button variant="ghost" icon={<ArrowLeftRight size={14} />} aria-label={`Swap ${artifact.title}`} onClick={() => onSwap(artifact.id)} /><Button variant="ghost" icon={<Minus size={14} />} aria-label={`Remove ${artifact.title}`} onClick={() => onRemove(artifact.id)} /></div></div>)}{selected && !zone.artifactIds.includes(selected.id) && <button className="drop-target" onClick={() => onPlace(selected, zone)}><Plus size={15} /> Place <strong>{selected.title}</strong> here</button>}{placed.length === 0 && !selected && <div className="zone-empty">Select an object from the queue to place it here.</div>}</div></div></article>;
}
