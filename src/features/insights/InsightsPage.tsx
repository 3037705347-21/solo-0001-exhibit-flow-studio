import {
  Accessibility,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Gauge,
  Info,
  Layers3,
  Link2,
  RefreshCw,
  RotateCcw,
  Save,
  SquareChartGantt,
  Users,
  WandSparkles,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Donut } from '../../components/Donut';
import { Metric } from '../../components/Metric';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { formatMinutes, titleCase } from '../../domain/formatters';
import { analyzeJourney } from '../../domain/journeyAnalysis';
import { clampScenario, projectScenario } from '../../domain/scenario';
import {
  buildPlanSuggestions,
  preparePlanBatch,
  type PlanBatchPreview,
  type PlanSuggestion,
} from '../../domain/planTransaction';
import type { PlanningPreferences } from '../../domain/models';
import { useWorkspace } from '../../state/WorkspaceContext';

const CATEGORY_META: Record<PlanSuggestion['category'], { label: string; tone: 'info' | 'teal' | 'warning' | 'positive' }> = {
  'visit-preferences': { label: 'Visit profile', tone: 'info' },
  'object-dwell': { label: 'Object stay', tone: 'teal' },
  'zone-pressure': { label: 'Zone pressure', tone: 'warning' },
  access: { label: 'Access', tone: 'positive' },
};

function categoryBadge(tone: 'info' | 'teal' | 'warning' | 'positive') {
  return tone === 'teal' ? 'positive' : tone;
}

export function InsightsPage() {
  const { state, updatePreferences, commitBatch, undoLastTransaction, dismissUndo } = useWorkspace();
  const [draft, setDraft] = useState<PlanningPreferences>(state.preferences);
  const [saved, setSaved] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [batch, setBatch] = useState<PlanBatchPreview | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [appliedMessage, setAppliedMessage] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const analysis = useMemo(() => analyzeJourney(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const projection = useMemo(() => projectScenario(state, analysis, draft), [state, analysis, draft]);
  const suggestions = useMemo(
    () => buildPlanSuggestions(state, analysis, draft),
    [state, analysis, draft],
  );
  const suggestionById = useMemo(() => new Map(suggestions.map((suggestion) => [suggestion.id, suggestion])), [suggestions]);
  const inputKey = JSON.stringify(clampScenario(draft));

  const setPreference = <K extends keyof PlanningPreferences>(key: K, value: PlanningPreferences[K]) =>
    setDraft((current) => clampScenario({ ...current, [key]: value }));

  const apply = () => {
    updatePreferences(draft);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  };

  const toggleSuggestion = (id: string) => {
    setCommitError(null);
    setSelected((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  };

  const openBatch = useCallback((ids: string[]) => {
    setCommitError(null);
    setBatch(preparePlanBatch(state, suggestions, ids, draft));
  }, [state, suggestions, draft]);

  const refreshBatch = () => {
    if (!batch) return;
    // Rebase onto the live plan: keep selections that still resolve and clear
    // any version conflict produced by external modification.
    const retained = batch.suggestionIds.filter((id) => suggestionById.has(id));
    setSelected(retained);
    setCommitError(null);
    setBatch(preparePlanBatch(state, suggestions, retained, draft));
  };

  const cancelBatch = () => {
    setBatch(null);
    setCommitError(null);
  };

  const submitBatch = () => {
    if (!batch) return;
    // Re-prepare against the live state so the submit-time check catches
    // revisions, objects, and capacities that changed while the panel was open.
    const fresh = preparePlanBatch(state, suggestions, batch.suggestionIds, batch.scenarioInput);
    if (!fresh.canCommit) {
      setBatch(fresh);
      setCommitError(fresh.issues.find((issue) => issue.blocking)?.message ?? 'The batch cannot be applied.');
      return;
    }
    const result = commitBatch(fresh);
    if (!result.ok) {
      const retried = preparePlanBatch(state, suggestions, batch.suggestionIds, batch.scenarioInput);
      setBatch(retried);
      setCommitError(result.message ?? 'The batch could not be applied.');
      return;
    }
    setBatch(null);
    setSelected([]);
    setCommitError(null);
    setAppliedMessage(result.transaction?.summary ?? 'Planning changes applied');
    window.setTimeout(() => setAppliedMessage(null), 6000);
  };

  const undo = () => {
    const result = undoLastTransaction();
    if (!result.ok) {
      setUndoError(result.message ?? 'The transaction could not be undone.');
      window.setTimeout(() => setUndoError(null), 5000);
    }
    dismissUndo();
  };

  const batchStale = batch !== null && batch.baseRevision !== state.revision;
  const batchInputStale = batch !== null && JSON.stringify(batch.scenarioInput) !== inputKey;
  const blockingIssues = batch?.issues.filter((issue) => issue.blocking) ?? [];
  const advisoryIssues = batch?.issues.filter((issue) => !issue.blocking) ?? [];

  return <div className="page-stack">
    <SectionHeader
      eyebrow="SCENARIO LAB"
      title="Insights"
      description="Pressure-test the plan for different visitor rhythms, then combine advice into a single reversible planning transaction."
      actions={<Button variant="primary" icon={<Save size={16} />} onClick={apply}>Apply preferences</Button>}
    />
    <div className="scenario-banner">
      <div className="scenario-banner-icon"><WandSparkles size={21} /></div>
      <div><strong>Scenario projection</strong><p>Try a visitor profile to see how pacing, group size, and access priorities reshape the visit. Suggestions below can be reviewed and committed together.</p></div>
      <Badge tone="info">Non-destructive</Badge>
    </div>
    <div className="insights-layout">
      <section className="scenario-controls">
        <div className="panel-heading"><div><div className="eyebrow">INPUTS</div><h2>Visitor profile</h2></div><Users size={19} /></div>
        <div className="control-block">
          <label className="field-label">Visit pace</label>
          <div className="pace-options">{(['focused', 'balanced', 'leisurely'] as const).map((pace) => <button key={pace} className={draft.pace === pace ? 'selected' : ''} onClick={() => setPreference('pace', pace)}><span className="pace-dot" /><strong>{titleCase(pace)}</strong><small>{pace === 'focused' ? 'Short route' : pace === 'balanced' ? 'Recommended' : 'Deep looking'}</small></button>)}</div>
        </div>
        <div className="control-block"><div className="control-label-row"><label className="field-label" htmlFor="group-size">Group size</label><strong>{draft.groupSize} people</strong></div><input id="group-size" className="range-input" type="range" min="1" max="20" value={draft.groupSize} onChange={(event) => setPreference('groupSize', Number(event.target.value))} /><div className="range-labels"><span>Solo</span><span>Small group</span><span>Large group</span></div></div>
        <div className="control-block"><div className="control-label-row"><label className="field-label" htmlFor="access-priority">Accessibility priority</label><strong>{draft.accessibilityPriority}%</strong></div><input id="access-priority" className="range-input teal" type="range" min="0" max="100" value={draft.accessibilityPriority} onChange={(event) => setPreference('accessibilityPriority', Number(event.target.value))} /><div className="range-labels"><span>Baseline</span><span>Prioritized</span><span>Highest</span></div></div>
        <div className="saved-profile"><Info size={15} /><span>Saved profile: <strong>{titleCase(state.preferences.pace)}</strong> pace · {state.preferences.groupSize} people · revision {state.revision}</span></div>
      </section>
      <section className="projection-panel">
        <div className="panel-heading"><div><div className="eyebrow">PROJECTED OUTCOME</div><h2>{titleCase(draft.pace)} visit</h2></div><Badge tone={projection.comfortScore >= 75 ? 'positive' : 'warning'}>{projection.comfortScore >= 75 ? 'Comfortable' : 'Pressure points'}</Badge></div>
        <div className="projection-metrics"><Metric label="Expected duration" value={formatMinutes(projection.durationMinutes)} detail="At this visitor pace" icon={<Gauge size={17} />} tone="teal" /><Metric label="Comfort score" value={`${projection.comfortScore}/100`} detail="Density-adjusted" icon={<Users size={17} />} tone={projection.comfortScore >= 75 ? 'teal' : 'amber'} /><Metric label="Access coverage" value={`${projection.accessibilityScore}/100`} detail="Interpretation access" icon={<Accessibility size={17} />} tone={projection.accessibilityScore >= 75 ? 'teal' : 'amber'} /></div>
        <div className="donut-row"><Donut value={projection.narrativeScore / 100} color="#c9563f" label="Narrative" /><Donut value={projection.accessibilityScore / 100} color="#2f7c75" label="Access" /><Donut value={projection.comfortScore / 100} color="#7c6aa6" label="Comfort" /></div>
        <div className="recommendation-box">
          <div className="recommendation-heading"><div className="eyebrow">RECOMMENDATIONS</div>{selected.length > 0 && <Button variant="secondary" icon={<SquareChartGantt size={14} />} onClick={() => openBatch(selected)}>Review {selected.length} {selected.length === 1 ? 'change' : 'changes'}</Button>}</div>
          {projection.recommendations.map((recommendation) => <div className="recommendation recommendation-text" key={recommendation}><ArrowRight size={15} /><span>{recommendation}</span></div>)}
          <div className="suggestion-list">
            {suggestions.map((suggestion) => {
              const meta = CATEGORY_META[suggestion.category];
              const checked = selected.includes(suggestion.id);
              const missingDeps = suggestion.requires.filter((id) => !selected.includes(id));
              return <label className={`suggestion-card ${checked ? 'selected' : ''}`} key={suggestion.id}>
                <input type="checkbox" checked={checked} onChange={() => toggleSuggestion(suggestion.id)} aria-label={`Select ${suggestion.title}`} />
                <span className="suggestion-card-body">
                  <span className="suggestion-card-top">
                    <strong>{suggestion.title}</strong>
                    <Badge tone={categoryBadge(meta.tone)}>{meta.label}</Badge>
                  </span>
                  <small>{suggestion.detail}</small>
                  {suggestion.requires.length > 0 && <span className={`suggestion-dep ${missingDeps.length ? 'unsatisfied' : ''}`}><Link2 size={12} />Requires: {suggestion.requires.map((id) => suggestionById.get(id)?.title ?? id).join('; ')}</span>}
                </span>
              </label>;
            })}
            {suggestions.length === 0 && <div className="recommendation recommendation-text"><CheckCircle2 size={15} /><span>No plan changes recommended for this visitor profile — the current plan is balanced.</span></div>}
          </div>
        </div>
      </section>
    </div>

    {batch && <BatchReviewPanel
      preview={batch}
      stale={batchStale}
      inputStale={batchInputStale}
      blockingIssues={blockingIssues}
      advisoryIssues={advisoryIssues}
      commitError={commitError}
      onRefresh={refreshBatch}
      onCancel={cancelBatch}
      onSubmit={submitBatch}
    />}

    <section className="pressure-section"><div className="panel-heading"><div><div className="eyebrow">ZONE PRESSURE</div><h2>Where the plan is carrying weight</h2></div><Layers3 size={19} /></div><div className="pressure-grid">{analysis.zones.map((zone) => { const pressured = projection.pressureZoneIds.includes(zone.zoneId); const source = state.zones.find((candidate) => candidate.id === zone.zoneId); return <div className={`pressure-card ${pressured ? 'pressured' : ''}`} key={zone.zoneId}><div className="pressure-card-top"><span className="zone-color" style={{ backgroundColor: source?.color }} /><strong>{source?.shortLabel}</strong>{pressured && <Badge tone="warning">Pressure</Badge>}</div><div className="pressure-stat"><span>{zone.objectCount} objects</span><strong>{zone.dwellMinutes} min</strong></div><ProgressBar value={zone.utilization * 100} tone={pressured ? 'amber' : 'teal'} /></div>; })}</div></section>

    {saved && <div className="toast toast-positive"><Save size={16} />Planning preferences applied.</div>}
    {appliedMessage && <div className="toast toast-positive plan-toast">
      <span className="plan-toast-copy"><CheckCircle2 size={16} /><span><strong>Planning transaction applied.</strong><small>{appliedMessage} — derived metrics updated.</small></span></span>
      <button className="plan-toast-undo" onClick={undo}><RotateCcw size={14} />Undo</button>
    </div>}
    {undoError && <div className="toast toast-warning"><AlertTriangle size={16} />{undoError}</div>}
  </div>;
}

function BatchReviewPanel({
  preview,
  stale,
  inputStale,
  blockingIssues,
  advisoryIssues,
  commitError,
  onRefresh,
  onCancel,
  onSubmit,
}: {
  preview: PlanBatchPreview;
  stale: boolean;
  inputStale: boolean;
  blockingIssues: PlanBatchPreview['issues'];
  advisoryIssues: PlanBatchPreview['issues'];
  commitError: string | null;
  onRefresh: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const delta = (value: number) => (value > 0 ? `+${value}` : `${value}`);
  return <section className="plan-batch-panel" aria-label="Review planning changes">
    <div className="plan-batch-header">
      <div>
        <div className="eyebrow">PLANNING TRANSACTION</div>
        <h2>Review {preview.suggestions.length} {preview.suggestions.length === 1 ? 'suggestion' : 'suggestions'}</h2>
        <p>The batch writes as one unit: any conflict below blocks the entire set.</p>
      </div>
      <Badge tone={preview.canCommit && !stale ? 'positive' : 'danger'}>Revision {preview.baseRevision}{stale ? ' · stale' : ''}</Badge>
    </div>

    {stale && <div className="plan-batch-banner danger">
      <AlertTriangle size={17} />
      <span><strong>The saved plan changed elsewhere</strong> (revision {preview.baseRevision} → current). Rebase the batch onto the latest plan before submitting.</span>
      <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={onRefresh}>Reload latest plan</Button>
    </div>}
    {!stale && inputStale && <div className="plan-batch-banner warning">
      <Info size={17} />
      <span>Visitor profile inputs changed after this batch was prepared — predicted outcomes use the inputs captured at review time.</span>
      <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={onRefresh}>Refresh preview</Button>
    </div>}

    <div className="plan-batch-grid">
      <div className="plan-facts">
        <div className="plan-subhead"><Clock3 size={14} /><strong>Plan facts that will change</strong></div>
        <div className="plan-fact-list">
          {preview.factDeltas.map((fact) => <div className="plan-fact-row" key={fact.key}>
            <span className="plan-fact-label">{fact.label}</span>
            <span className="plan-fact-values"><del>{fact.before}</del><ArrowRight size={12} /><strong>{fact.after}</strong></span>
            <span className="plan-fact-count">{fact.suggestionIds.length}×</span>
          </div>)}
        </div>
        <div className="plan-subhead"><Link2 size={14} /><strong>Dependencies</strong></div>
        {preview.dependencies.length === 0
          ? <p className="plan-empty-note">No dependencies between the selected suggestions.</p>
          : <ul className="plan-dependency-list">{preview.dependencies.map((dependency) => {
            const owner = preview.suggestions.find((suggestion) => suggestion.id === dependency.suggestionId)?.title ?? dependency.suggestionId;
            const required = preview.suggestions.find((suggestion) => suggestion.id === dependency.requiresId)?.title ?? dependency.requiresId;
            return <li key={`${dependency.suggestionId}-${dependency.requiresId}`} className={dependency.satisfied ? 'satisfied' : 'unsatisfied'}>
              {dependency.satisfied ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
              <span><strong>{owner}</strong> requires <strong>{required}</strong>{dependency.satisfied ? ' — included' : ' — missing from selection'}</span>
            </li>;
          })}</ul>}
      </div>
      <div className="plan-outcomes">
        <div className="plan-subhead"><Gauge size={14} /><strong>Predicted outcome</strong></div>
        <div className="plan-metric-grid">
          <div><small>Duration</small><strong>{formatMinutes(preview.prediction.durationMinutes)}</strong><em className={preview.prediction.deltas.durationMinutes <= 0 ? 'good' : 'bad'}>{delta(preview.prediction.deltas.durationMinutes)} min</em></div>
          <div><small>Comfort</small><strong>{preview.prediction.comfortScore}</strong><em className={preview.prediction.deltas.comfortScore >= 0 ? 'good' : 'bad'}>{delta(preview.prediction.deltas.comfortScore)}</em></div>
          <div><small>Access</small><strong>{preview.prediction.accessibilityScore}</strong><em className={preview.prediction.deltas.accessibilityScore >= 0 ? 'good' : 'bad'}>{delta(preview.prediction.deltas.accessibilityScore)}</em></div>
          <div><small>Narrative</small><strong>{preview.prediction.narrativeScore}</strong><em className={preview.prediction.deltas.narrativeScore >= 0 ? 'good' : 'bad'}>{delta(preview.prediction.deltas.narrativeScore)}</em></div>
        </div>
        <div className="plan-prediction-note">
          <Layers3 size={13} />
          <span>{preview.prediction.pressureZoneIds.length} pressure {preview.prediction.pressureZoneIds.length === 1 ? 'zone' : 'zones'} · {preview.prediction.blockingJourneyCount} blocking {preview.prediction.blockingJourneyCount === 1 ? 'finding' : 'findings'} · {preview.prediction.warningJourneyCount} warnings after the batch</span>
        </div>
      </div>
    </div>

    {blockingIssues.length > 0 && <div className="plan-issue-list blocking">
      {blockingIssues.map((issue, index) => <div className="plan-issue-row" key={`${issue.code}-${index}`}><AlertTriangle size={15} /><span>{issue.message}</span></div>)}
    </div>}
    {advisoryIssues.length > 0 && <div className="plan-issue-list advisory">
      {advisoryIssues.map((issue, index) => <div className="plan-issue-row" key={`${issue.code}-${index}`}><Info size={15} /><span>{issue.message} (advisory — does not block)</span></div>)}
    </div>}
    {commitError && <div className="plan-commit-error" role="alert"><AlertTriangle size={15} /><span>{commitError}</span></div>}

    <div className="plan-batch-footer">
      <p className="plan-atomic-note">Nothing is written until you commit. A failed validation leaves every current preference in place.</p>
      <div className="plan-batch-actions">
        <Button variant="ghost" icon={<X size={15} />} onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={!preview.canCommit || stale} onClick={onSubmit}>Commit {preview.suggestions.length} {preview.suggestions.length === 1 ? 'change' : 'changes'}</Button>
      </div>
    </div>
  </section>;
}
