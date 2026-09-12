import { Accessibility, ArrowRight, Gauge, Info, Layers3, Save, Users, WandSparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Donut } from '../../components/Donut';
import { Metric } from '../../components/Metric';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { formatMinutes, titleCase } from '../../domain/formatters';
import { analyzeJourney } from '../../domain/journeyAnalysis';
import { clampScenario, projectScenario } from '../../domain/scenario';
import { profileLabel } from '../../domain/ruleProfiles';
import type { PlanningPreferences } from '../../domain/models';
import { useWorkspace } from '../../state/WorkspaceContext';
import { RuleArchiveBanner } from '../shared/RuleArchiveBanner';

export function InsightsPage() {
  const { state, updatePreferences, boundProfile } = useWorkspace();
  const [draft, setDraft] = useState<PlanningPreferences>(state.preferences);
  const [saved, setSaved] = useState(false);
  const analysis = useMemo(() => boundProfile
    ? analyzeJourney(
      state.artifacts,
      state.zones,
      boundProfile.parameters,
      { profileId: boundProfile.profileId, version: boundProfile.version, name: boundProfile.name },
    )
    : null, [state.artifacts, state.zones, boundProfile]);
  const projection = useMemo(() => analysis ? projectScenario(state, analysis, draft) : null, [state, analysis, draft]);
  const setPreference = <K extends keyof PlanningPreferences>(key: K, value: PlanningPreferences[K]) => setDraft((current) => clampScenario({ ...current, [key]: value }));
  const apply = () => { updatePreferences(draft); setSaved(true); window.setTimeout(() => setSaved(false), 2200); };
  return <div className="page-stack"><SectionHeader eyebrow="SCENARIO LAB" title="Insights" description="Pressure-test the plan for different visitor rhythms without changing the saved journey." actions={<Button variant="primary" icon={<Save size={16} />} onClick={apply} disabled={!boundProfile}>Apply preferences</Button>} />
    <RuleArchiveBanner />
    {boundProfile && <div className="rule-archive-chip"><WandSparkles size={14} /><span>Projections use constraints from <strong>{profileLabel(boundProfile)}</strong></span></div>}
    {analysis && projection && <><div className="scenario-banner"><div className="scenario-banner-icon"><WandSparkles size={21} /></div><div><strong>Scenario projection</strong><p>Try a visitor profile to see how pacing, group size, and access priorities reshape the visit.</p></div><Badge tone="info">Non-destructive</Badge></div>
    <div className="insights-layout"><section className="scenario-controls"><div className="panel-heading"><div><div className="eyebrow">INPUTS</div><h2>Visitor profile</h2></div><Users size={19} /></div><div className="control-block"><label className="field-label">Visit pace</label><div className="pace-options">{(['focused', 'balanced', 'leisurely'] as const).map((pace) => <button key={pace} className={draft.pace === pace ? 'selected' : ''} onClick={() => setPreference('pace', pace)}><span className="pace-dot" /><strong>{titleCase(pace)}</strong><small>{pace === 'focused' ? 'Short route' : pace === 'balanced' ? 'Recommended' : 'Deep looking'}</small></button>)}</div></div><div className="control-block"><div className="control-label-row"><label className="field-label" htmlFor="group-size">Group size</label><strong>{draft.groupSize} people</strong></div><input id="group-size" className="range-input" type="range" min="1" max="20" value={draft.groupSize} onChange={(event) => setPreference('groupSize', Number(event.target.value))} /><div className="range-labels"><span>Solo</span><span>Small group</span><span>Large group</span></div></div><div className="control-block"><div className="control-label-row"><label className="field-label" htmlFor="access-priority">Accessibility priority</label><strong>{draft.accessibilityPriority}%</strong></div><input id="access-priority" className="range-input teal" type="range" min="0" max="100" value={draft.accessibilityPriority} onChange={(event) => setPreference('accessibilityPriority', Number(event.target.value))} /><div className="range-labels"><span>Baseline</span><span>Prioritized</span><span>Highest</span></div></div><div className="saved-profile"><Info size={15} /><span>Saved profile: <strong>{titleCase(state.preferences.pace)}</strong> pace · {state.preferences.groupSize} people</span></div></section><section className="projection-panel"><div className="panel-heading"><div><div className="eyebrow">PROJECTED OUTCOME</div><h2>{titleCase(draft.pace)} visit</h2></div><Badge tone={projection.comfortScore >= 75 ? 'positive' : 'warning'}>{projection.comfortScore >= 75 ? 'Comfortable' : 'Pressure points'}</Badge></div><div className="projection-metrics"><Metric label="Expected duration" value={formatMinutes(projection.durationMinutes)} detail="At this visitor pace" icon={<Gauge size={17} />} tone="teal" /><Metric label="Comfort score" value={`${projection.comfortScore}/100`} detail="Density-adjusted" icon={<Users size={17} />} tone={projection.comfortScore >= 75 ? 'teal' : 'amber'} /><Metric label="Access coverage" value={`${projection.accessibilityScore}/100`} detail="Interpretation access" icon={<Accessibility size={17} />} tone={projection.accessibilityScore >= 75 ? 'teal' : 'amber'} /></div><div className="donut-row"><Donut value={projection.narrativeScore / 100} color="#c9563f" label="Narrative" /><Donut value={projection.accessibilityScore / 100} color="#2f7c75" label="Access" /><Donut value={projection.comfortScore / 100} color="#7c6aa6" label="Comfort" /></div><div className="recommendation-box"><div className="eyebrow">RECOMMENDATIONS</div>{projection.recommendations.map((recommendation) => <div className="recommendation" key={recommendation}><ArrowRight size={15} /><span>{recommendation}</span></div>)}</div></section></div>
    <section className="pressure-section"><div className="panel-heading"><div><div className="eyebrow">ZONE PRESSURE</div><h2>Where the plan is carrying weight</h2></div><Layers3 size={19} /></div><div className="pressure-grid">{analysis.zones.map((zone) => { const pressured = projection.pressureZoneIds.includes(zone.zoneId); const source = state.zones.find((candidate) => candidate.id === zone.zoneId); return <div className={`pressure-card ${pressured ? 'pressured' : ''}`} key={zone.zoneId}><div className="pressure-card-top"><span className="zone-color" style={{ backgroundColor: source?.color }} /><strong>{source?.shortLabel}</strong>{pressured && <Badge tone="warning">Pressure</Badge>}</div><div className="pressure-stat"><span>{zone.objectCount} objects</span><strong>{zone.dwellMinutes} min</strong></div><ProgressBar value={zone.utilization * 100} tone={pressured ? 'amber' : 'teal'} /></div>; })}</div></section>
    </>}{saved && <div className="toast toast-positive"><Save size={16} />Planning preferences applied.</div>}</div>;
}
