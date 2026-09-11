import { AlertCircle, Check, CheckCircle2, ClipboardCheck, Clock, Download, FileWarning, ListChecks, MapPin, PenLine, Plus, RotateCcw, Send, ShieldAlert, ShieldCheck, Sparkles, Stamp, UserRound, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { KeyValueList } from '../../components/KeyValueList';
import { Modal } from '../../components/Modal';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { computePlanVersion, evaluateApproval } from '../../domain/approval';
import { downloadTextFile } from '../../domain/export';
import { sortZones } from '../../domain/filters';
import { formatDate, formatMinutes, titleCase } from '../../domain/formatters';
import { analyzeJourney } from '../../domain/journeyAnalysis';
import type { IssueDraft, IssueSeverity, IssueStatus, ReadinessResult, ReviewIssue, WorkspaceState } from '../../domain/models';
import { evaluateReadiness } from '../../domain/reviewRules';
import { buildZoneChecklist, serializeZoneChecklistCsv, zoneChecklistFileName } from '../../domain/zoneChecklist';
import { loadReviewUi, saveReviewUi, type ReviewUiState } from '../../state/persistence';
import { useWorkspace } from '../../state/WorkspaceContext';

type StatusFilter = IssueStatus | 'all';
const STATUS_FILTERS: StatusFilter[] = ['all', 'open', 'in-progress', 'resolved'];

export function ReviewPage() {
  const { state, addIssue, transitionReviewIssue, checkReadiness, approvePlan, createSnapshot } = useWorkspace();
  const [reviewUi, setReviewUi] = useState<ReviewUiState>(() => loadReviewUi());
  const [showModal, setShowModal] = useState(false);
  const [showSignOff, setShowSignOff] = useState(false);
  const [readiness, setReadiness] = useState(() => evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones)));
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { saveReviewUi(reviewUi); }, [reviewUi]);
  const setZoneId = (zoneId: string) => setReviewUi((ui) => ({ ...ui, zoneId }));
  const setStatus = (status: StatusFilter) => setReviewUi((ui) => ({ ...ui, status }));

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2600); };

  const zones = useMemo(() => sortZones(state.zones), [state.zones]);
  const selectedZone = zones.find((zone) => zone.id === reviewUi.zoneId);
  const filter = reviewUi.status;
  const approval = evaluateApproval(state);
  const stageReady = state.project.stage === 'ready';
  const liveReadiness = useMemo(() => evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones)), [state]);
  const planVersion = useMemo(() => computePlanVersion(state), [state]);

  const scopedIssues = useMemo<ReviewIssue[]>(() => {
    if (!selectedZone) return state.issues;
    return state.issues.filter((issue) =>
      issue.zoneId === selectedZone.id || (Boolean(issue.artifactId) && selectedZone.artifactIds.includes(issue.artifactId as string)));
  }, [state.issues, selectedZone]);

  const counts = {
    all: scopedIssues.length,
    open: scopedIssues.filter((issue) => issue.status === 'open').length,
    'in-progress': scopedIssues.filter((issue) => issue.status === 'in-progress').length,
    resolved: scopedIssues.filter((issue) => issue.status === 'resolved').length,
  };
  const filtered = scopedIssues.filter((issue) => filter === 'all' || issue.status === filter);
  const checklist = selectedZone ? buildZoneChecklist(state, selectedZone.id) : null;

  const runCheck = () => setReadiness(checkReadiness());
  const exportSnapshot = () => {
    const result = createSnapshot();
    if (!result.ok || !result.value) { notify(result.message ?? 'Resolve blockers before exporting.'); return; }
    downloadTextFile(JSON.stringify(result.value, null, 2), `exhibit-flow-snapshot-${new Date().toISOString().slice(0, 10)}.json`);
    notify('Snapshot downloaded.');
  };
  const exportChecklist = () => {
    if (!selectedZone || !checklist) return;
    downloadTextFile(serializeZoneChecklistCsv(checklist), zoneChecklistFileName(selectedZone), 'text/csv;charset=utf-8');
    notify('Zone checklist downloaded.');
  };

  return <div className="page-stack"><SectionHeader eyebrow="QUALITY GATE" title="Review desk" description="Turn open questions into resolved decisions, then run the final readiness check." actions={<div className="header-button-row"><Button variant="secondary" icon={<ClipboardCheck size={16} />} onClick={runCheck}>Run readiness check</Button><Button variant="primary" icon={<Plus size={17} />} onClick={() => setShowModal(true)}>New finding</Button></div>} />
    <section className={`readiness-card ${readiness.ready ? 'ready' : 'blocked'}`}><div className="readiness-icon">{readiness.ready ? <CheckCircle2 size={28} /> : <ShieldAlert size={28} />}</div><div className="readiness-copy"><div className="eyebrow">READINESS CHECK · {readiness.checkedAt ? formatDate(readiness.checkedAt) : 'not run'}</div><h2>{readiness.ready ? 'Ready to share' : 'Still needs attention'}</h2><p>{readiness.ready ? 'The journey and review desk have no blocking conditions.' : `${readiness.blockers.length} blocking condition${readiness.blockers.length === 1 ? '' : 's'} prevent this plan from being marked ready.`}</p></div><div className="readiness-score"><strong>{readiness.score}</strong><span>readiness score</span></div><div className="readiness-actions">{readiness.ready && approval.status === 'active' ? <Button variant="primary" icon={<Download size={16} />} onClick={exportSnapshot}>Export snapshot</Button> : readiness.ready && stageReady ? <Button variant="primary" icon={<PenLine size={16} />} onClick={() => setShowSignOff(true)}>Sign off to publish</Button> : <Button variant="secondary" icon={<RotateCcw size={16} />} onClick={runCheck}>Re-check plan</Button>}</div></section>
    {!readiness.ready && <section className="blocker-list"><div className="eyebrow">WHAT IS BLOCKING</div>{readiness.blockers.map((blocker) => <div className="blocker-row" key={blocker}><XCircle size={16} /><span>{blocker}</span></div>)}</section>}
    <section className={`approval-card approval-${approval.status}`} aria-label="Lead sign-off">
      <div className="approval-icon">{approval.status === 'active' ? <ShieldCheck size={22} /> : approval.status === 'stale' ? <ShieldAlert size={22} /> : <Stamp size={22} />}</div>
      <div className="approval-copy">
        <div className="eyebrow">LEAD SIGN-OFF</div>
        {approval.status === 'active' && <>
          <h2>Signed off by {approval.approval.approver}</h2>
          <p>Confirmed on {formatDate(approval.approval.approvedAt)} against plan version <code>{approval.approval.planVersion}</code>. Snapshot export is unlocked; any further plan change will require a new sign-off.</p>
        </>}
        {approval.status === 'stale' && <>
          <h2>Sign-off needs renewal</h2>
          <p>{approval.approval.approver} signed off on {formatDate(approval.approval.approvedAt)}, but {approval.reason}{approval.approval.invalidatedAt ? ` (recorded ${formatDate(approval.approval.invalidatedAt)})` : ''}. The plan is back to needing lead confirmation.</p>
        </>}
        {approval.status === 'none' && <>
          <h2>Awaiting lead sign-off</h2>
          <p>Publishing stays locked until a lead confirms the current plan, the export package, and any open reminders. Workspaces saved before this policy need one fresh confirmation.</p>
        </>}
      </div>
      {approval.status !== 'active' && (stageReady
        ? <Button variant="primary" icon={<PenLine size={15} />} onClick={() => setShowSignOff(true)}>{approval.status === 'stale' ? 'Confirm again' : 'Sign off now'}</Button>
        : <span className="approval-hint">Sign-off unlocks once the readiness check passes.</span>)}
    </section>
    <div className="review-summary"><div><span className="eyebrow">TOTAL FINDINGS</span><strong>{counts.all}</strong></div><div><span className="eyebrow">OPEN</span><strong className="text-danger">{counts.open}</strong></div><div><span className="eyebrow">IN PROGRESS</span><strong className="text-amber">{counts['in-progress']}</strong></div><div><span className="eyebrow">RESOLVED</span><strong className="text-teal">{counts.resolved}</strong></div></div>
    <div className="review-filters"><div className="review-zone-field"><SelectField label="Exhibition zone" value={selectedZone?.id ?? ''} onChange={(event) => setZoneId(event.target.value)}><option value="">All zones — overview</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</SelectField></div><span className="review-hint"><Sparkles size={14} /> {selectedZone ? 'Findings and the floor checklist are scoped to this zone.' : 'Critical findings block readiness'}</span></div>
    <div className="review-toolbar"><div className="segmented-control">{STATUS_FILTERS.map((status) => <button key={status} className={filter === status ? 'selected' : ''} onClick={() => setStatus(status)}>{titleCase(status)} <span>{counts[status]}</span></button>)}</div></div>
    {checklist && <ZoneChecklistCard checklist={checklist} onDownload={exportChecklist} />}
    <section className="issue-list">{filtered.map((issue) => <IssueRow key={issue.id} issue={issue} onTransition={(status) => transitionReviewIssue(issue.id, status)} />)}</section>
    {filtered.length === 0 && <EmptyState icon={<MapPin size={26} />} title={selectedZone ? 'No findings in this zone' : 'No findings here'} detail={selectedZone ? 'This zone has no findings matching the current status filter.' : 'No findings match the current status filter.'} />}
    {showModal && <IssueEditor state={state} onClose={() => setShowModal(false)} onSave={(draft) => { const result = addIssue(draft); if (result.ok) setShowModal(false); return result; }} />}
    {showSignOff && <SignOffDialog state={state} readiness={liveReadiness} planVersion={planVersion} renewal={approval.status === 'stale'} onClose={() => setShowSignOff(false)} onConfirm={(approver) => { const result = approvePlan(approver); if (result.ok) notify(`Sign-off recorded for ${result.value?.approver ?? approver}. Publishing is unlocked.`); return result; }} />}
    {toast && <div className="toast toast-positive"><Download size={16} />{toast}</div>}
  </div>;
}

function SignOffDialog({ state, readiness, planVersion, renewal, onClose, onConfirm }: {
  state: WorkspaceState;
  readiness: ReadinessResult;
  planVersion: string;
  renewal: boolean;
  onClose: () => void;
  onConfirm: (approver: string) => { ok: boolean; errors?: Record<string, string>; message?: string };
}) {
  const [approver, setApprover] = useState(state.approval?.approver ?? '');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const submit = () => {
    const result = onConfirm(approver);
    if (!result.ok) {
      setError(result.errors?.approver ?? null);
      setMessage(result.errors ? null : (result.message ?? 'Sign-off could not be recorded.'));
      return;
    }
    onClose();
  };
  return <Modal eyebrow="LEAD SIGN-OFF" title={renewal ? 'Confirm the plan again' : 'Confirm the plan for publishing'} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Stamp size={15} />} onClick={submit}>Confirm and sign off</Button></>}>
    <div className="signoff-summary">
      <p>Signing off records the accountable lead, the time, and the exact plan version being confirmed. Any later change to objects, placements, findings, or readiness rules invalidates this sign-off and locks publishing again.</p>
      <KeyValueList items={[
        { label: 'Readiness score', value: `${readiness.score}` },
        { label: 'Plan version', value: planVersion },
        { label: 'Open reminders', value: `${readiness.cautions.length}`, emphasis: readiness.cautions.length > 0 },
      ]} />
      {readiness.cautions.length > 0 && <div className="signoff-cautions"><div className="eyebrow">OPEN REMINDERS TO ACCEPT</div>{readiness.cautions.map((caution) => <div className="signoff-caution" key={caution}><AlertCircle size={14} /><span>{caution}</span></div>)}</div>}
      <TextField label="Accountable lead" value={approver} onChange={(event) => setApprover(event.target.value)} error={error ?? undefined} placeholder="Lead confirming this plan" />
      {message && <div className="field-error">{message}</div>}
    </div>
  </Modal>;
}

function ZoneChecklistCard({ checklist, onDownload }: { checklist: NonNullable<ReturnType<typeof buildZoneChecklist>>; onDownload: () => void }) {
  return <section className="zone-checklist-card" aria-label="Zone checklist">
    <div className="panel-heading"><div><div className="eyebrow">FLOOR TEAM CHECKLIST</div><h2>{checklist.zoneName}</h2></div><Button variant="primary" icon={<Download size={16} />} onClick={onDownload}>Download zone checklist (CSV)</Button></div>
    <p className="zone-checklist-thesis">{checklist.thesis}</p>
    <div className="zone-checklist-stats"><div><span className="eyebrow">OBJECTS</span><strong>{checklist.objectCount}</strong></div><div><span className="eyebrow">TOTAL DWELL</span><strong>{formatMinutes(checklist.totalDwellMinutes)}</strong></div><div><span className="eyebrow">UNRESOLVED FINDINGS</span><strong className={checklist.unresolvedCount ? 'text-amber' : 'text-teal'}>{checklist.unresolvedCount}</strong></div></div>
    {checklist.zoneFindings.length > 0 && <div className="checklist-zone-findings"><div className="eyebrow">ZONE-WIDE OPEN FINDINGS</div>{checklist.zoneFindings.map((finding, index) => <div className="checklist-zone-finding" key={`${finding.title}-${index}`}><ShieldAlert size={14} /><span><strong>[{finding.severity.toUpperCase()}]</strong> {finding.title} <em>· {finding.owner}</em></span></div>)}</div>}
    <div className="checklist-preview">{checklist.entries.length === 0 && <div className="zone-empty">No objects are placed in this zone yet.</div>}{checklist.entries.map((entry) => {
      const objectFindings = entry.unresolvedFindings.filter((finding) => finding.scope === 'object');
      return <div className="checklist-preview-row" key={entry.artifactId}><span className="checklist-order">{entry.sequence}</span><span className="checklist-object"><strong>{entry.title}</strong><small>{entry.accessionId}</small></span><span className="checklist-dwell"><Clock size={13} />{entry.dwellMinutes} min</span><span className={`checklist-findings ${objectFindings.length ? 'is-open' : 'is-clear'}`}>{objectFindings.length ? <><AlertCircle size={13} />{objectFindings.length} open finding{objectFindings.length === 1 ? '' : 's'}</> : <><CheckCircle2 size={13} />Clear</>}</span></div>;
    })}</div>
    <div className="checklist-footnote"><ListChecks size={14} /><span>The CSV lists each object in visit order with dwell time and every unresolved finding (zone-wide findings are tagged <code>[zone]</code>).</span></div>
  </section>;
}

function IssueRow({ issue, onTransition }: { issue: ReviewIssue; onTransition: (status: ReviewIssue['status']) => { ok: boolean; message?: string } }) {
  const [error, setError] = useState<string | null>(null);
  const next = issue.status === 'open' ? 'in-progress' : issue.status === 'in-progress' ? 'resolved' : 'in-progress';
  const resultLabel = issue.status === 'open' ? 'Start work' : issue.status === 'in-progress' ? 'Resolve' : 'Reopen';
  const result = () => { const response = onTransition(next); if (!response.ok) { setError(response.message ?? 'Transition failed.'); window.setTimeout(() => setError(null), 2500); } };
  return <article className={`issue-row issue-${issue.severity}`}><div className="issue-severity">{issue.severity === 'critical' ? <ShieldAlert size={19} /> : issue.severity === 'warning' ? <AlertCircle size={19} /> : <FileWarning size={19} />}</div><div className="issue-main"><div className="issue-title-line"><h3>{issue.title}</h3><Badge tone={issue.status === 'resolved' ? 'positive' : issue.severity === 'critical' ? 'danger' : issue.severity === 'warning' ? 'warning' : 'neutral'}>{titleCase(issue.status)}</Badge></div><p>{issue.description}</p><div className="issue-meta"><span><UserRound size={13} /> {issue.owner}</span>{issue.zoneId && <span><MapPin size={13} /> Zone linked</span>}{issue.artifactId && <span>Object linked</span>}<span>Updated {formatDate(issue.updatedAt)}</span></div>{error && <div className="field-error">{error}</div>}</div><Button variant={issue.status === 'resolved' ? 'ghost' : 'secondary'} icon={issue.status === 'resolved' ? <RotateCcw size={15} /> : <Check size={15} />} onClick={result}>{resultLabel}</Button></article>;
}

function IssueEditor({ state, onClose, onSave }: { state: ReturnType<typeof useWorkspace>['state']; onClose: () => void; onSave: (draft: IssueDraft) => { ok: boolean; errors?: Record<string, string> } }) {
  const [draft, setDraft] = useState<IssueDraft>({ title: '', description: '', severity: 'warning', owner: '', zoneId: '', artifactId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <Modal eyebrow="NEW REVIEW FINDING" title="Capture an open question" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send size={15} />} onClick={() => { const result = onSave(draft); if (!result.ok) setErrors(result.errors ?? {}); }}>Create finding</Button></>}><div className="form-grid"><TextField label="Finding title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="What needs a decision?" /><SelectField label="Severity" value={draft.severity} onChange={(event) => update('severity', event.target.value as IssueSeverity)}><option value="note">Note</option><option value="warning">Warning</option><option value="critical">Critical blocker</option></SelectField><TextField label="Owner" value={draft.owner} onChange={(event) => update('owner', event.target.value)} error={errors.owner} placeholder="Team member" /><SelectField label="Linked zone" value={draft.zoneId} onChange={(event) => update('zoneId', event.target.value)}><option value="">No zone link</option>{state.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</SelectField><SelectField label="Linked object" value={draft.artifactId} onChange={(event) => update('artifactId', event.target.value)}><option value="">No object link</option>{state.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}</SelectField><TextField label="Context and next step" textarea rows={5} value={draft.description} onChange={(event) => update('description', event.target.value)} error={errors.description} placeholder="Describe the decision, evidence, or next action." /></div></Modal>;
}
