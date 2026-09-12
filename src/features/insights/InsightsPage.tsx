import { Accessibility, AlertTriangle, ArrowRight, Gauge, History, Info, Layers3, RotateCcw, Save, Users, WandSparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Donut } from '../../components/Donut';
import { Metric } from '../../components/Metric';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { formatDateTime, formatMinutes, titleCase } from '../../domain/formatters';
import { analyzeJourney } from '../../domain/journeyAnalysis';
import type { PlanningPreferences } from '../../domain/models';
import { clampScenario, projectScenario } from '../../domain/scenario';
import { diffPreferences, hasDraftChanges, planVersion, resolveScenarioDraft, type ScenarioDraft } from '../../domain/scenarioDraft';
import { clearScenarioDraft, loadScenarioDraft, saveScenarioDraft } from '../../state/scenarioDraftStore';
import { useWorkspace } from '../../state/WorkspaceContext';

export function InsightsPage() {
  const { state, applyPreferences } = useWorkspace();
  const analysis = useMemo(() => analyzeJourney(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const currentVersion = useMemo(() => planVersion(state), [state]);
  const [recovered] = useState<ScenarioDraft | null>(() => {
    const stored = loadScenarioDraft();
    return stored && hasDraftChanges(stored) ? stored : null;
  });
  const [working, setWorking] = useState<PlanningPreferences>(() => (recovered ? resolveScenarioDraft(state.preferences, recovered) : state.preferences));
  const [baseVersion, setBaseVersion] = useState(() => recovered?.baseVersion ?? currentVersion);
  const [dirty, setDirty] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(Boolean(recovered));
  const [conflict, setConflict] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const projection = useMemo(() => projectScenario(state, analysis, working), [state, analysis, working]);
  const hasChanges = Object.keys(diffPreferences(state.preferences, working)).length > 0;

  // Persist in-session edits as a recoverable draft: delta vs saved
  // preferences, last edit time, and the plan version the edits are based on.
  useEffect(() => {
    if (!dirty) return;
    const changes = diffPreferences(state.preferences, working);
    if (Object.keys(changes).length === 0) {
      clearScenarioDraft();
      return;
    }
    saveScenarioDraft({ changes, updatedAt: new Date().toISOString(), baseVersion });
  }, [dirty, working, baseVersion, state.preferences]);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2600); };

  const setPreference = <K extends keyof PlanningPreferences>(key: K, value: PlanningPreferences[K]) => {
    setWorking((current) => clampScenario({ ...current, [key]: value }));
    setBaseVersion(currentVersion);
    setDirty(true);
    setConflict(null);
  };

  const revert = () => {
    setWorking(state.preferences);
    setBaseVersion(currentVersion);
    setDirty(false);
    setConflict(null);
    setRecoveryOpen(false);
    clearScenarioDraft();
  };

  const discard = () => {
    // Abandoning the recovered draft also returns the controls to the saved
    // profile, so nothing unapplied remains and the discarded values can no
    // longer be committed.
    revert();
  };

  const commit = (version: string) => {
    const result = applyPreferences(working, version);
    if (result.ok) {
      clearScenarioDraft();
      setDirty(false);
      setConflict(null);
      setRecoveryOpen(false);
      notify(result.value?.applied === false ? 'Saved profile already matches this scenario.' : 'Planning preferences applied.');
      return;
    }
    // Never write a stale or invalid draft: re-anchor on the current plan and
    // let the user confirm against the recalculated projection.
    if (result.code === 'invalid') setWorking(clampScenario(working));
    setBaseVersion(currentVersion);
    setConflict(result.message ?? 'The draft could not be applied. Review the recalculated projection, then confirm.');
  };

  const apply = () => commit(baseVersion);

  return <div className="page-stack">
    <SectionHeader eyebrow="SCENARIO LAB" title="Insights" description="Pressure-test the plan for different visitor rhythms without changing the saved journey." actions={<Button variant="primary" icon={<Save size={16} />} onClick={apply} disabled={!hasChanges}>{conflict ? 'Confirm apply' : 'Apply preferences'}</Button>} />
    <div className="scenario-banner"><div className="scenario-banner-icon"><WandSparkles size={21} /></div><div><strong>Scenario projection</strong><p>Try a visitor profile to see how pacing, group size, and access priorities reshape the visit.</p></div><Badge tone="info">Non-destructive</Badge></div>
    {recoveryOpen && recovered && <div className="scenario-banner recovery-banner" role="status">
      <div className="scenario-banner-icon"><History size={21} /></div>
      <div><strong>Recovered an unsaved scenario draft</strong><p>Last edited {formatDateTime(recovered.updatedAt)} · {recovered.baseVersion === currentVersion ? 'based on the current plan.' : 'based on an earlier plan version — the projection below has been recalculated.'}</p></div>
      <div className="recovery-actions">
        <Button variant="primary" onClick={() => setRecoveryOpen(false)}>Continue</Button>
        <Button variant="secondary" onClick={apply}>Apply</Button>
        <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={revert}>Revert</Button>
        <Button variant="ghost" onClick={discard}>Discard</Button>
      </div>
    </div>}
    {conflict && <div className="scenario-banner conflict-banner" role="alert">
      <div className="scenario-banner-icon"><AlertTriangle size={21} /></div>
      <div><strong>Confirm against the current plan</strong><p>{conflict}</p></div>
      <Badge tone="warning">Recalculated</Badge>
    </div>}
    <div className="insights-layout">
      <section className="scenario-controls">
        <div className="panel-heading"><div><div className="eyebrow">INPUTS</div><h2>Visitor profile</h2></div><Users size={19} /></div>
        <div className="control-block"><label className="field-label">Visit pace</label><div className="pace-options">{(['focused', 'balanced', 'leisurely'] as const).map((pace) => <button key={pace} className={working.pace === pace ? 'selected' : ''} onClick={() => setPreference('pace', pace)}><span className="pace-dot" /><strong>{titleCase(pace)}</strong><small>{pace === 'focused' ? 'Short route' : pace === 'balanced' ? 'Recommended' : 'Deep looking'}</small></button>)}</div></div>
        <div className="control-block"><div className="control-label-row"><label className="field-label" htmlFor="group-size">Group size</label><strong>{working.groupSize} people</strong></div><input id="group-size" className="range-input" type="range" min="1" max="20" value={working.groupSize} onChange={(event) => setPreference('groupSize', Number(event.target.value))} /><div className="range-labels"><span>Solo</span><span>Small group</span><span>Large group</span></div></div>
        <div className="control-block"><div className="control-label-row"><label className="field-label" htmlFor="access-priority">Accessibility priority</label><strong>{working.accessibilityPriority}%</strong></div><input id="access-priority" className="range-input teal" type="range" min="0" max="100" value={working.accessibilityPriority} onChange={(event) => setPreference('accessibilityPriority', Number(event.target.value))} /><div className="range-labels"><span>Baseline</span><span>Prioritized</span><span>Highest</span></div></div>
        <div className="saved-profile"><Info size={15} /><span>Saved profile: <strong>{titleCase(state.preferences.pace)}</strong> pace · {state.preferences.groupSize} people</span></div>
        {hasChanges && !recoveryOpen && <div className="draft-status"><span>Unapplied scenario changes · recoverable draft saved locally</span><Button variant="ghost" icon={<RotateCcw size={14} />} onClick={revert}>Revert to saved</Button></div>}
      </section>
      <section className="projection-panel">
        <div className="panel-heading"><div><div className="eyebrow">PROJECTED OUTCOME</div><h2>{titleCase(working.pace)} visit</h2></div><Badge tone={projection.comfortScore >= 75 ? 'positive' : 'warning'}>{projection.comfortScore >= 75 ? 'Comfortable' : 'Pressure points'}</Badge></div>
        <div className="projection-metrics"><Metric label="Expected duration" value={formatMinutes(projection.durationMinutes)} detail="At this visitor pace" icon={<Gauge size={17} />} tone="teal" /><Metric label="Comfort score" value={`${projection.comfortScore}/100`} detail="Density-adjusted" icon={<Users size={17} />} tone={projection.comfortScore >= 75 ? 'teal' : 'amber'} /><Metric label="Access coverage" value={`${projection.accessibilityScore}/100`} detail="Interpretation access" icon={<Accessibility size={17} />} tone={projection.accessibilityScore >= 75 ? 'teal' : 'amber'} /></div>
        <div className="donut-row"><Donut value={projection.narrativeScore / 100} color="#c9563f" label="Narrative" /><Donut value={projection.accessibilityScore / 100} color="#2f7c75" label="Access" /><Donut value={projection.comfortScore / 100} color="#7c6aa6" label="Comfort" /></div>
        <div className="recommendation-box"><div className="eyebrow">RECOMMENDATIONS</div>{projection.recommendations.map((recommendation) => <div className="recommendation" key={recommendation}><ArrowRight size={15} /><span>{recommendation}</span></div>)}</div>
      </section>
    </div>
    <section className="pressure-section"><div className="panel-heading"><div><div className="eyebrow">ZONE PRESSURE</div><h2>Where the plan is carrying weight</h2></div><Layers3 size={19} /></div><div className="pressure-grid">{analysis.zones.map((zone) => { const pressured = projection.pressureZoneIds.includes(zone.zoneId); const source = state.zones.find((candidate) => candidate.id === zone.zoneId); return <div className={`pressure-card ${pressured ? 'pressured' : ''}`} key={zone.zoneId}><div className="pressure-card-top"><span className="zone-color" style={{ backgroundColor: source?.color }} /><strong>{source?.shortLabel}</strong>{pressured && <Badge tone="warning">Pressure</Badge>}</div><div className="pressure-stat"><span>{zone.objectCount} objects</span><strong>{zone.dwellMinutes} min</strong></div><ProgressBar value={zone.utilization * 100} tone={pressured ? 'amber' : 'teal'} /></div>; })}</div></section>
    {toast && <div className="toast toast-positive"><Save size={16} />{toast}</div>}
  </div>;
}
