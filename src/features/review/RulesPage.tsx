import { ArrowLeft, ArrowRight, CheckCircle2, FileWarning, GitBranch, History, Plus, Save, ShieldAlert, Sparkles, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { SectionHeader } from '../../components/SectionHeader';
import {
  cloneParameters,
  explainRuleProfile,
  profileKey,
  profileLabel,
  type RuleProfile,
} from '../../domain/ruleProfiles';
import type { RuleImpactReport } from '../../domain/ruleImpact';
import { formatDate } from '../../domain/formatters';
import { useWorkspace } from '../../state/WorkspaceContext';
import { RuleVersionEditor, type RuleDraft } from './RuleVersionEditor';

export function RulesPage() {
  const {
    state,
    boundProfile,
    ruleResolution,
    previewImpact,
    publishRuleVersion,
    switchRuleVersion,
    repairRuleBinding,
    loadProblems,
  } = useWorkspace();
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [preview, setPreview] = useState<RuleImpactReport | null>(null);
  const [switchTarget, setSwitchTarget] = useState<RuleProfile | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 3200); };

  const line = useMemo(
    () => state.ruleProfiles
      .filter((profile) => profile.profileId === (boundProfile?.profileId ?? state.project.ruleBinding?.profileId))
      .sort((a, b) => b.version - a.version),
    [state.ruleProfiles, boundProfile, state.project.ruleBinding],
  );
  const otherLines = useMemo(
    () => Array.from(new Set(state.ruleProfiles.map((profile) => profile.profileId)))
      .filter((id) => id !== (boundProfile?.profileId ?? state.project.ruleBinding?.profileId))
      .map((id) => state.ruleProfiles.filter((profile) => profile.profileId === id)),
    [state.ruleProfiles, boundProfile, state.project.ruleBinding],
  );

  const startDraft = () => {
    if (!boundProfile) return;
    setDraft({
      parameters: cloneParameters(boundProfile.parameters),
      changeSummary: '',
    });
    setPreview(null);
    setPublishError(null);
  };

  const runPreview = (next: RuleDraft) => {
    if (!boundProfile) return;
    const candidate: RuleProfile = {
      profileId: boundProfile.profileId,
      version: -1,
      name: boundProfile.name,
      changeSummary: next.changeSummary || 'Unpublished draft',
      parameters: cloneParameters(next.parameters),
      createdAt: new Date().toISOString(),
      origin: 'published',
    };
    const result = previewImpact(candidate);
    if (!result.ok || !result.value) { notify(result.message ?? 'Impact preview failed.'); return; }
    setPreview(result.value);
  };

  const publish = () => {
    if (!draft) return;
    const result = publishRuleVersion({ parameters: draft.parameters, changeSummary: draft.changeSummary });
    if (!result.ok || !result.value) {
      setPublishError(result.errors?.changeSummary ?? result.message ?? 'Could not publish the new version.');
      return;
    }
    const published = result.value;
    setDraft(null);
    setPreview(null);
    setPublishError(null);
    setSwitchTarget(published);
    notify(`Published ${profileLabel(published)}. Review the impact before switching this project.`);
  };

  const confirmSwitch = () => {
    if (!switchTarget) return;
    const result = switchRuleVersion(switchTarget.profileId, switchTarget.version);
    if (!result.ok) { notify(result.message ?? 'Switch failed.'); return; }
    notify(`Project now interpreted under ${profileLabel(switchTarget)}.`);
    setSwitchTarget(null);
  };

  const repair = (profile: RuleProfile) => {
    const result = repairRuleBinding(profile.profileId, profile.version);
    if (!result.ok) { notify(result.message ?? 'Repair failed.'); return; }
    notify(`Binding repaired to ${profileLabel(profile)}.`);
  };

  const unresolved = ruleResolution.status !== 'resolved';

  return <div className="page-stack">
    <div className="rules-back"><Link to="/review"><ArrowLeft size={15} /> Back to review desk</Link></div>
    <SectionHeader
      eyebrow="VERSIONED RULE ARCHIVE"
      title="Review rules"
      description="Every readiness result names the archive version used to calculate it. Change a rule and a new immutable version is published first; old plans keep their version until explicitly upgraded."
      actions={boundProfile && !draft
        ? <Button variant="primary" icon={<Plus size={16} />} onClick={startDraft}>Publish new version</Button>
        : draft
          ? <Button variant="secondary" icon={<ArrowLeft size={15} />} onClick={() => { setDraft(null); setPreview(null); }}>Cancel draft</Button>
          : undefined}
    />

    {(unresolved || loadProblems.length > 0) && <section className="rule-banner" role="alert">
      <div className="rule-banner-icon"><ShieldAlert size={22} /></div>
      <div className="rule-banner-copy">
        <div className="eyebrow">BINDING PROBLEM</div>
        <h2>{ruleResolution.reason || 'Some archive entries were ignored during load.'}</h2>
        {line.length > 0 && <p>Rebind this project to one of the versions stored locally:</p>}
        <div className="rule-repair-row">
          {line.map((profile) => <Button key={profileKey(profile.profileId, profile.version)} variant="secondary" icon={<Save size={15} />} onClick={() => repair(profile)}>Rebind to v{profile.version}</Button>)}
          {line.length === 0 && <span>No versions of the bound archive line are present here; reset the sample plan or re-import the missing archive.</span>}
        </div>
      </div>
    </section>}

    {boundProfile && !draft && <section className="rule-bound-card">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">CURRENTLY BOUND · <GitBranch size={13} /> {profileKey(boundProfile.profileId, boundProfile.version)}</div>
          <h2>{profileLabel(boundProfile)}</h2>
        </div>
        <Badge tone="positive">Active for this project</Badge>
      </div>
      <p className="rule-change-summary">{boundProfile.changeSummary}</p>
      <div className="rule-statements">
        {explainRuleProfile(boundProfile).map((statement) => <div className="rule-statement" key={statement.label}><span>{statement.label}</span><strong>{statement.value}</strong></div>)}
      </div>
      <div className="rule-bound-foot"><History size={14} /><span>Created {formatDate(boundProfile.createdAt)} · {boundProfile.origin === 'builtin' ? 'Built into the workspace' : 'Published by the team'}</span></div>
    </section>}

    {draft && boundProfile && <RuleVersionEditor
      basis={boundProfile}
      draft={draft}
      onChange={setDraft}
      onPreview={() => runPreview(draft)}
      onPublish={publish}
      preview={preview}
      error={publishError}
    />}

    {switchTarget && !draft && <section className="rule-impact-banner">
      <div className="rule-impact-head"><Sparkles size={18} /><div><div className="eyebrow">CONFIRM VERSION SWITCH</div><h2>Switch this project to {profileLabel(switchTarget)}?</h2></div></div>
      <ImpactSummary profile={switchTarget} />
      <div className="rule-impact-actions">
        <Button variant="primary" icon={<CheckCircle2 size={16} />} onClick={confirmSwitch}>Switch and recalculate</Button>
        <Button variant="ghost" icon={<XCircle size={15} />} onClick={() => setSwitchTarget(null)}>Keep v{boundProfile?.version}</Button>
      </div>
    </section>}

    {!draft && <section className="rule-version-list">
      <div className="panel-heading"><div><div className="eyebrow">ARCHIVE HISTORY</div><h2>{line[0]?.name ?? 'Rule archive versions'}</h2></div><Badge tone="neutral">{line.length} version{line.length === 1 ? '' : 's'}</Badge></div>
      {line.map((profile) => {
        const isBound = boundProfile?.profileId === profile.profileId && boundProfile?.version === profile.version;
        return <article className={`rule-version-row ${isBound ? 'is-bound' : ''}`} key={profileKey(profile.profileId, profile.version)}>
          <div className="rule-version-main">
            <div className="rule-version-line"><strong>v{profile.version}</strong>{isBound ? <Badge tone="positive">Bound</Badge> : profile.origin === 'builtin' ? <Badge tone="neutral">Built-in</Badge> : <Badge tone="info">Published</Badge>}</div>
            <p>{profile.changeSummary}</p>
            <small>Created {formatDate(profile.createdAt)}</small>
          </div>
          <div className="rule-version-actions">
            {!isBound && <Button variant="secondary" icon={<ArrowRight size={15} />} onClick={() => setSwitchTarget(profile)}>Review impact &amp; switch</Button>}
          </div>
        </article>;
      })}
    </section>}

    {otherLines.map((profiles) => <section className="rule-version-list" key={profiles[0].profileId}>
      <div className="panel-heading"><div><div className="eyebrow">OTHER ARCHIVE LINE</div><h2>{profiles[0].name}</h2></div></div>
      {profiles.sort((a, b) => b.version - a.version).map((profile) => <article className="rule-version-row" key={profileKey(profile.profileId, profile.version)}>
        <div className="rule-version-main">
          <div className="rule-version-line"><strong>{profileKey(profile.profileId, profile.version)}</strong><Badge tone="neutral">Not bound</Badge></div>
          <p>{profile.changeSummary}</p>
        </div>
        <div className="rule-version-actions"><Button variant="ghost" icon={<ArrowRight size={15} />} onClick={() => setSwitchTarget(profile)}>Review impact &amp; switch</Button></div>
      </article>)}
    </section>)}

    {state.readinessRuns.length > 0 && !draft && <ReadinessHistory />}

    {toast && <div className="toast toast-positive"><FileWarning size={16} />{toast}</div>}
  </div>;
}

function ImpactSummary({ profile }: { profile: RuleProfile }) {
  const { state, boundProfile, previewImpact } = useWorkspace();
  const report = useMemo(() => {
    if (!boundProfile) return null;
    return previewImpact(profile).value ?? null;
  }, [boundProfile, profile, previewImpact, state]);
  if (!report) return null;
  return <div className="rule-impact-summary">
    <div className={`rule-impact-outcome ${report.regresses ? 'tone-worse' : report.improves ? 'tone-better' : 'tone-neutral'}`}>
      {report.regresses ? <XCircle size={18} /> : report.improves ? <CheckCircle2 size={18} /> : <Sparkles size={18} />}
      <span>{report.outcome.text} {report.scoreChange.text}</span>
    </div>
    {report.parameterChanges.length > 0 && <div className="rule-change-list">
      <div className="eyebrow">PARAMETER CHANGES</div>
      {report.parameterChanges.map((change) => <div className="rule-change-row" key={change.key}><span>{change.label}</span><strong><em>{change.from}</em> → {change.to}</strong></div>)}
    </div>}
    {report.items.length > 0 && <div className="rule-impact-items">
      {report.items.map((item, index) => <div className={`rule-impact-item ${item.tone}`} key={`${item.text}-${index}`}>
        {item.tone === 'worse' ? <XCircle size={14} /> : <CheckCircle2 size={14} />}<span>{item.text}</span>
      </div>)}
    </div>}
    {report.parameterChanges.length === 0 && report.items.length === 0 && <p className="rule-impact-none">This version produces identical findings for the current plan.</p>}
  </div>;
}

function ReadinessHistory() {
  const { state } = useWorkspace();
  return <section className="rule-run-history">
    <div className="panel-heading"><div><div className="eyebrow">HISTORICAL READINESS RESULTS</div><h2>Calculated against pinned archive versions</h2></div></div>
    <div className="rule-run-list">
      {state.readinessRuns.map((run) => <article className={`rule-run-row ${run.ready ? 'is-ready' : 'is-blocked'}`} key={run.id}>
        <div className="rule-run-status">{run.ready ? <CheckCircle2 size={18} /> : <XCircle size={18} />}</div>
        <div className="rule-run-main">
          <strong>{run.ready ? 'Ready' : 'Blocked'} · score {run.score}</strong>
          <span>{formatDate(run.checkedAt)}</span>
        </div>
        <Badge tone="neutral"><GitBranch size={12} /> {run.ruleArchive.name} v{run.ruleArchive.version}</Badge>
      </article>)}
    </div>
  </section>;
}
