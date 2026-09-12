import { Accessibility, ArrowRight, CheckCircle2, Gauge, GitCompareArrows, History, Info, Layers3, Play, Save, Trash2, Users, WandSparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Donut } from '../../components/Donut';
import { EmptyState } from '../../components/EmptyState';
import { Metric } from '../../components/Metric';
import { Modal } from '../../components/Modal';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { formatDate, formatMinutes, titleCase } from '../../domain/formatters';
import { analyzeJourney } from '../../domain/journeyAnalysis';
import { clampScenario, projectScenario } from '../../domain/scenario';
import type { PlanningPreferences, ScenarioInput, ScenarioRecord } from '../../domain/models';
import { computePlanVersion, isRecordStale } from '../../domain/scenarioRecords';
import { useWorkspace } from '../../state/WorkspaceContext';
import { SaveComparisonDialog } from './SaveComparisonDialog';
import { ReplayComparisonDialog } from './ReplayComparisonDialog';

type ToastKind = 'positive' | 'warning';

export function InsightsPage() {
  const { state, updatePreferences, saveScenarioRecord, removeScenarioRecord } = useWorkspace();
  const [draft, setDraft] = useState<PlanningPreferences>(state.preferences);
  const [saved, setSaved] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [replayId, setReplayId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: ToastKind; text: string } | null>(null);
  const analysis = useMemo(() => analyzeJourney(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const projection = useMemo(() => projectScenario(state, analysis, draft), [state, analysis, draft]);
  const planVersion = useMemo(() => computePlanVersion(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const records = useMemo(() => [...state.scenarioRecords].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.scenarioRecords]);

  const notify = (kind: ToastKind, text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 2600);
  };
  const setPreference = <K extends keyof PlanningPreferences>(key: K, value: PlanningPreferences[K]) => setDraft((current) => clampScenario({ ...current, [key]: value }));
  const apply = () => { updatePreferences(draft); setSaved(true); window.setTimeout(() => setSaved(false), 2200); };

  const defaultComparisonName = () => {
    const base = `${titleCase(draft.pace)} visit`;
    let candidate = base;
    let counter = 2;
    while (state.scenarioRecords.some((record) => record.name.toLowerCase() === candidate.toLowerCase())) {
      candidate = `${base} ${counter}`;
      counter += 1;
    }
    return candidate;
  };

  const replayRecord = replayId ? state.scenarioRecords.find((record) => record.id === replayId) : undefined;
  const deleteRecord = confirmDeleteId ? state.scenarioRecords.find((record) => record.id === confirmDeleteId) : undefined;

  const handleDelete = () => {
    if (!confirmDeleteId) return;
    const result = removeScenarioRecord(confirmDeleteId);
    setConfirmDeleteId(null);
    if (replayId === confirmDeleteId) setReplayId(null);
    if (result.ok) notify('positive', 'Comparison deleted.');
    else notify('warning', result.message ?? 'The comparison could not be deleted.');
  };

  const loadInputs = (input: ScenarioInput) => {
    setDraft(clampScenario(input));
    notify('positive', 'Saved inputs loaded into the lab. Run them against the current plan and save a new comparison to keep the outcome.');
  };

  return <div className="page-stack"><SectionHeader eyebrow="SCENARIO LAB" title="Insights" description="Pressure-test the plan for different visitor rhythms without changing the saved journey." actions={<><Button variant="secondary" icon={<Save size={16} />} onClick={apply}>Apply preferences</Button><Button variant="primary" icon={<GitCompareArrows size={16} />} data-testid="save-comparison-open" onClick={() => setShowSaveDialog(true)}>Save comparison</Button></>} />
    <div className="scenario-banner"><div className="scenario-banner-icon"><WandSparkles size={21} /></div><div><strong>Scenario projection</strong><p>Try a visitor profile to see how pacing, group size, and access priorities reshape the visit.</p></div><Badge tone="info">Non-destructive</Badge></div>
    <div className="insights-layout"><section className="scenario-controls"><div className="panel-heading"><div><div className="eyebrow">INPUTS</div><h2>Visitor profile</h2></div><Users size={19} /></div><div className="control-block"><label className="field-label">Visit pace</label><div className="pace-options">{(['focused', 'balanced', 'leisurely'] as const).map((pace) => <button key={pace} className={draft.pace === pace ? 'selected' : ''} onClick={() => setPreference('pace', pace)}><span className="pace-dot" /><strong>{titleCase(pace)}</strong><small>{pace === 'focused' ? 'Short route' : pace === 'balanced' ? 'Recommended' : 'Deep looking'}</small></button>)}</div></div><div className="control-block"><div className="control-label-row"><label className="field-label" htmlFor="group-size">Group size</label><strong>{draft.groupSize} people</strong></div><input id="group-size" className="range-input" type="range" min="1" max="20" value={draft.groupSize} onChange={(event) => setPreference('groupSize', Number(event.target.value))} /><div className="range-labels"><span>Solo</span><span>Small group</span><span>Large group</span></div></div><div className="control-block"><div className="control-label-row"><label className="field-label" htmlFor="access-priority">Accessibility priority</label><strong>{draft.accessibilityPriority}%</strong></div><input id="access-priority" className="range-input teal" type="range" min="0" max="100" value={draft.accessibilityPriority} onChange={(event) => setPreference('accessibilityPriority', Number(event.target.value))} /><div className="range-labels"><span>Baseline</span><span>Prioritized</span><span>Highest</span></div></div><div className="saved-profile"><Info size={15} /><span>Saved profile: <strong>{titleCase(state.preferences.pace)}</strong> pace · {state.preferences.groupSize} people</span></div></section><section className="projection-panel"><div className="panel-heading"><div><div className="eyebrow">PROJECTED OUTCOME</div><h2>{titleCase(draft.pace)} visit</h2></div><Badge tone={projection.comfortScore >= 75 ? 'positive' : 'warning'}>{projection.comfortScore >= 75 ? 'Comfortable' : 'Pressure points'}</Badge></div><div className="projection-metrics"><Metric label="Expected duration" value={formatMinutes(projection.durationMinutes)} detail="At this visitor pace" icon={<Gauge size={17} />} tone="teal" /><Metric label="Comfort score" value={`${projection.comfortScore}/100`} detail="Density-adjusted" icon={<Users size={17} />} tone={projection.comfortScore >= 75 ? 'teal' : 'amber'} /><Metric label="Access coverage" value={`${projection.accessibilityScore}/100`} detail="Interpretation access" icon={<Accessibility size={17} />} tone={projection.accessibilityScore >= 75 ? 'teal' : 'amber'} /></div><div className="donut-row"><Donut value={projection.narrativeScore / 100} color="#c9563f" label="Narrative" /><Donut value={projection.accessibilityScore / 100} color="#2f7c75" label="Access" /><Donut value={projection.comfortScore / 100} color="#7c6aa6" label="Comfort" /></div><div className="recommendation-box"><div className="eyebrow">RECOMMENDATIONS</div>{projection.recommendations.map((recommendation) => <div className="recommendation" key={recommendation}><ArrowRight size={15} /><span>{recommendation}</span></div>)}</div></section></div>
    <section className="comparisons-section" data-testid="comparisons-section"><div className="panel-heading"><div><div className="eyebrow">SAVED COMPARISONS</div><h2>Replayable scenario records</h2></div><Badge tone="neutral"><History size={12} /> {records.length} saved</Badge></div>{records.length === 0 ? <EmptyState icon={<GitCompareArrows size={22} />} title="No comparisons saved yet" detail="Adjust the visitor profile above and save a comparison to freeze the inputs, plan version, outcome, and recommendations for later side-by-side review." /> : <div className="comparison-grid">{records.map((record) => <ComparisonCard key={record.id} record={record} stale={isRecordStale(record, planVersion)} onReplay={() => setReplayId(record.id)} onDelete={() => setConfirmDeleteId(record.id)} />)}</div>}</section>
    <section className="pressure-section"><div className="panel-heading"><div><div className="eyebrow">ZONE PRESSURE</div><h2>Where the plan is carrying weight</h2></div><Layers3 size={19} /></div><div className="pressure-grid">{analysis.zones.map((zone) => { const pressured = projection.pressureZoneIds.includes(zone.zoneId); const source = state.zones.find((candidate) => candidate.id === zone.zoneId); return <div className={`pressure-card ${pressured ? 'pressured' : ''}`} key={zone.zoneId}><div className="pressure-card-top"><span className="zone-color" style={{ backgroundColor: source?.color }} /><strong>{source?.shortLabel}</strong>{pressured && <Badge tone="warning">Pressure</Badge>}</div><div className="pressure-stat"><span>{zone.objectCount} objects</span><strong>{zone.dwellMinutes} min</strong></div><ProgressBar value={zone.utilization * 100} tone={pressured ? 'amber' : 'teal'} /></div>; })}</div></section>
    {showSaveDialog && <SaveComparisonDialog defaultName={defaultComparisonName()} input={draft} onClose={() => setShowSaveDialog(false)} onSave={(name, input) => { const result = saveScenarioRecord(name, input); if (result.ok) { setShowSaveDialog(false); notify('positive', `Comparison “${result.value?.name}” saved on plan version ${planVersion.slice(0, 6)}.`); } return result; }} />}
    {replayRecord && <ReplayComparisonDialog record={replayRecord} state={state} analysis={analysis} currentPlanVersion={planVersion} onLoadInputs={loadInputs} onDelete={(recordId) => { setReplayId(null); setConfirmDeleteId(recordId); }} onClose={() => setReplayId(null)} />}
    {deleteRecord && <Modal eyebrow="DELETE COMPARISON" title={`Delete “${deleteRecord.name}”?`} onClose={() => setConfirmDeleteId(null)} footer={<><Button variant="ghost" onClick={() => setConfirmDeleteId(null)}>Cancel</Button><Button variant="danger" icon={<Trash2 size={15} />} data-testid="confirm-delete" onClick={handleDelete}>Delete comparison</Button></>}><p className="confirm-delete-copy">The frozen inputs, plan version, outcome, and recommendations will be permanently removed. This cannot be undone and does not change the saved plan.</p></Modal>}
    {saved && <div className="toast toast-positive"><Save size={16} />Planning preferences applied.</div>}
    {toast && <div className={`toast ${toast.kind === 'positive' ? 'toast-positive' : 'toast-warning'}`}>{toast.kind === 'positive' ? <CheckCircle2 size={16} /> : <Info size={16} />}{toast.text}</div>}
  </div>;
}

function ComparisonCard({ record, stale, onReplay, onDelete }: { record: ScenarioRecord; stale: boolean; onReplay: () => void; onDelete: () => void }) {
  return <article className="comparison-card" data-testid="comparison-card"><div className="comparison-card-top"><div className="comparison-card-title"><strong>{record.name}</strong><span>{formatDate(record.createdAt)}</span></div>{stale ? <Badge tone="warning">Basis changed</Badge> : <Badge tone="positive">Current basis</Badge>}</div><div className="comparison-inputs"><span>{titleCase(record.input.pace)}</span><span>{record.input.groupSize} people</span><span>{record.input.accessibilityPriority}% access</span></div><div className="comparison-outcomes"><div><strong>{formatMinutes(record.projection.durationMinutes)}</strong><span>Duration</span></div><div><strong>{record.projection.comfortScore}</strong><span>Comfort</span></div><div><strong>{record.projection.accessibilityScore}</strong><span>Access</span></div></div><div className="comparison-basis"><History size={13} /><span>Plan v{record.planVersion.slice(0, 6)} · {record.planBasis.artifactCount} objects · {record.planBasis.placedCount} placed</span></div><div className="comparison-actions"><Button variant="secondary" icon={<Play size={14} />} data-testid={`replay-${record.id}`} onClick={onReplay}>Replay</Button><Button variant="ghost" icon={<Trash2 size={14} />} aria-label={`Delete ${record.name}`} data-testid={`delete-${record.id}`} onClick={onDelete} /></div></article>;
}
