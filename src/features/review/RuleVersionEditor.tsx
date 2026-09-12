import { Eye, GitCompare, Save, Sparkles, XCircle, CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import {
  ALL_NARRATIVE_ROLES,
  describeRuleParameter,
  ruleParameterLabel,
  type RuleParameters,
  type RuleProfile,
} from '../../domain/ruleProfiles';
import type { RuleImpactReport } from '../../domain/ruleImpact';
import { titleCase } from '../../domain/formatters';

export interface RuleDraft {
  parameters: RuleParameters;
  changeSummary: string;
}

interface RuleVersionEditorProps {
  basis: RuleProfile;
  draft: RuleDraft;
  onChange: (draft: RuleDraft) => void;
  onPreview: () => void;
  onPublish: () => void;
  preview: RuleImpactReport | null;
  error: string | null;
}

function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function RuleVersionEditor({ basis, draft, onChange, onPreview, onPublish, preview, error }: RuleVersionEditorProps) {
  const [summaryTouched, setSummaryTouched] = useState(false);
  const parameters = draft.parameters;
  const update = <K extends keyof RuleParameters>(key: K, value: RuleParameters[K]) =>
    onChange({ ...draft, parameters: { ...parameters, [key]: value } });

  const toggleRole = (role: RuleParameters['requiredRoles'][number]) => {
    const roles = parameters.requiredRoles.includes(role)
      ? parameters.requiredRoles.filter((candidate) => candidate !== role)
      : [...parameters.requiredRoles, role];
    update('requiredRoles', roles);
  };

  const rangeField = (key: 'capacityWarnAt' | 'capacityBlockAt' | 'densityWarnAt' | 'densityBlockAt') => (
    <div className="rule-field" key={key}>
      <div className="control-label-row"><label className="field-label" htmlFor={`rule-${key}`}>{ruleParameterLabel(key)}</label><strong>{percentLabel(parameters[key])}</strong></div>
      <input
        id={`rule-${key}`}
        className="range-input teal"
        type="range"
        min={50}
        max={110}
        step={5}
        value={Math.round(parameters[key] * 100)}
        onChange={(event) => update(key, Number(event.target.value) / 100)}
      />
      <small>Today: {describeRuleParameter(key, basis.parameters[key])}</small>
    </div>
  );

  const toggleField = (key: 'enforceLowLight' | 'enforceSeating' | 'requireKeyObjectsPlaced' | 'criticalFindingsBlock') => (
    <label className={`rule-toggle ${parameters[key] ? 'on' : ''}`} key={key}>
      <input type="checkbox" checked={parameters[key]} onChange={(event) => update(key, event.target.checked)} />
      <span><strong>{ruleParameterLabel(key)}</strong><small>{parameters[key] ? 'Enabled' : 'Disabled'} · today {describeRuleParameter(key, basis.parameters[key])}</small></span>
    </label>
  );

  const penaltyField = (key: 'blockerScorePenalty' | 'cautionScorePenalty') => (
    <div className="rule-field" key={key}>
      <label className="field-label" htmlFor={`rule-${key}`}>{ruleParameterLabel(key)}</label>
      <input
        id={`rule-${key}`}
        className="text-input"
        type="number"
        min={0}
        max={100}
        value={parameters[key]}
        onChange={(event) => update(key, Math.max(0, Math.min(100, Number(event.target.value) || 0)))}
      />
      <small>Today: {describeRuleParameter(key, basis.parameters[key])}</small>
    </div>
  );

  const changedKeys = new Set(preview?.parameterChanges.map((change) => change.key) ?? []);

  return <section className="rule-editor">
    <div className="panel-heading">
      <div>
        <div className="eyebrow">DRAFTING A NEW IMMUTABLE VERSION</div>
        <h2>Based on {basis.name} v{basis.version}</h2>
      </div>
      <Badge tone="warning">Unpublished draft</Badge>
    </div>

    <div className="rule-editor-grid">
      <div className="rule-editor-group">
        <div className="eyebrow">ZONE CAPACITY &amp; DENSITY</div>
        {rangeField('capacityWarnAt')}
        {rangeField('capacityBlockAt')}
        {rangeField('densityWarnAt')}
        {rangeField('densityBlockAt')}
      </div>
      <div className="rule-editor-group">
        <div className="eyebrow">OBJECT &amp; ZONE REQUIREMENTS</div>
        {toggleField('enforceLowLight')}
        {toggleField('enforceSeating')}
        <div className="rule-field">
          <label className="field-label" htmlFor="rule-seatingSeverity">{ruleParameterLabel('seatingSeverity')}</label>
          <select
            id="rule-seatingSeverity"
            className="text-input"
            value={parameters.seatingSeverity}
            onChange={(event) => update('seatingSeverity', event.target.value as RuleParameters['seatingSeverity'])}
          >
            <option value="warning">Warning (does not block)</option>
            <option value="error">Blocking error</option>
          </select>
          <small>Today: {describeRuleParameter('seatingSeverity', basis.parameters.seatingSeverity)}</small>
        </div>
      </div>
      <div className="rule-editor-group">
        <div className="eyebrow">NARRATIVE &amp; READINESS GATE</div>
        <div className="rule-field">
          <span className="field-label">Required narrative roles</span>
          <div className="rule-role-checks">
            {ALL_NARRATIVE_ROLES.map((role) => (
              <label className={`rule-role-chip ${parameters.requiredRoles.includes(role) ? 'on' : ''}`} key={role}>
                <input type="checkbox" checked={parameters.requiredRoles.includes(role)} onChange={() => toggleRole(role)} />
                {titleCase(role)}
              </label>
            ))}
          </div>
        </div>
        <div className="rule-field">
          <label className="field-label" htmlFor="rule-blockingRole">{ruleParameterLabel('blockingRole')}</label>
          <select
            id="rule-blockingRole"
            className="text-input"
            value={parameters.blockingRole}
            onChange={(event) => update('blockingRole', event.target.value as RuleParameters['blockingRole'])}
          >
            {ALL_NARRATIVE_ROLES.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}
          </select>
        </div>
        {toggleField('requireKeyObjectsPlaced')}
        {toggleField('criticalFindingsBlock')}
        {penaltyField('blockerScorePenalty')}
        {penaltyField('cautionScorePenalty')}
      </div>
    </div>

    <div className="rule-summary-field">
      <TextField
        label="Change summary (recorded permanently with this version)"
        value={draft.changeSummary}
        onChange={(event) => { onChange({ ...draft, changeSummary: event.target.value }); setSummaryTouched(true); }}
        error={summaryTouched && !draft.changeSummary.trim() ? 'Describe what this version changes and why.' : undefined}
        placeholder="e.g. Tighten dwell warning to 70% after visitor-flow study; make seating advisory."
      />
    </div>

    {error && <div className="field-error">{error}</div>}

    <div className="rule-editor-actions">
      <Button variant="secondary" icon={<Eye size={15} />} onClick={onPreview}>Preview impact on current plan</Button>
      <Button variant="primary" icon={<Save size={16} />} onClick={onPublish} disabled={!draft.changeSummary.trim()}>Publish new version</Button>
    </div>
    <p className="rule-editor-hint"><Sparkles size={14} /> Publishing appends an immutable version but does not switch this project. After publishing, review the impact and switch explicitly.</p>

    {preview && <div className="rule-preview">
      <div className="panel-heading">
        <div><div className="eyebrow">DRY RUN · <GitCompare size={13} /> {preview.fromArchive} → draft</div><h2>Impact on the current plan</h2></div>
        <Badge tone={preview.regresses ? 'danger' : preview.improves ? 'positive' : 'neutral'}>{preview.regresses ? 'Tightens' : preview.improves ? 'Loosens' : 'Equivalent'}</Badge>
      </div>
      <div className={`rule-impact-outcome ${preview.regresses ? 'tone-worse' : preview.improves ? 'tone-better' : 'tone-neutral'}`}>
        {preview.regresses ? <XCircle size={18} /> : preview.improves ? <CheckCircle2 size={18} /> : <Sparkles size={18} />}
        <span>{preview.outcome.text} {preview.scoreChange.text}</span>
      </div>
      {preview.parameterChanges.length > 0 && <div className="rule-change-list">
        {preview.parameterChanges.map((change) => <div className={`rule-change-row ${changedKeys.has(change.key) ? 'highlight' : ''}`} key={change.key}><span>{change.label}</span><strong><em>{change.from}</em> → {change.to}</strong></div>)}
      </div>}
      {preview.items.length > 0 && <div className="rule-impact-items">
        {preview.items.map((item, index) => <div className={`rule-impact-item ${item.tone}`} key={`${item.text}-${index}`}>
          {item.tone === 'worse' ? <XCircle size={14} /> : <CheckCircle2 size={14} />}<span>{item.text}</span>
        </div>)}
      </div>}
      {preview.items.length === 0 && preview.parameterChanges.length === 0 && <p className="rule-impact-none">This draft produces identical findings for the current plan.</p>}
    </div>}
  </section>;
}
