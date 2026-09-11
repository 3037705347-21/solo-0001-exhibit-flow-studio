import { AlertCircle, Accessibility, Check, CheckCircle2, ClipboardCheck, Clock, Download, FileWarning, ListChecks, Lock, MapPin, Plus, RotateCcw, Send, ShieldAlert, Sparkles, UserRound, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import {
  gapFingerprint,
  getCoverageGaps,
  hasOpenRemediation,
  type CoverageGap,
} from '../../domain/accessibilityRemediation';
import { auditAccessibility } from '../../domain/accessibility';
import { downloadTextFile } from '../../domain/export';
import { sortZones } from '../../domain/filters';
import { formatDate, formatMinutes, titleCase } from '../../domain/formatters';
import { analyzeJourney } from '../../domain/journeyAnalysis';
import type { IssueDraft, IssueSeverity, IssueStatus, ReviewIssue } from '../../domain/models';
import { evaluateReadiness } from '../../domain/reviewRules';
import { buildZoneChecklist, serializeZoneChecklistCsv, zoneChecklistFileName } from '../../domain/zoneChecklist';
import { loadReviewUi, saveReviewUi, type ReviewUiState } from '../../state/persistence';
import { selectEffectiveIssueZone } from '../../state/selectors';
import { useWorkspace } from '../../state/WorkspaceContext';

type StatusFilter = IssueStatus | 'all';
const STATUS_FILTERS: StatusFilter[] = ['all', 'open', 'in-progress', 'resolved'];

export function ReviewPage() {
  const { state, addIssue, commitRemediation, transitionReviewIssue, checkReadiness, createSnapshot } = useWorkspace();
  const [reviewUi, setReviewUi] = useState<ReviewUiState>(() => loadReviewUi());
  const [showModal, setShowModal] = useState(false);
  const [showRemediation, setShowRemediation] = useState(false);
  const [readiness, setReadiness] = useState(() => evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones)));
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { saveReviewUi(reviewUi); }, [reviewUi]);
  const setZoneId = (zoneId: string) => setReviewUi((ui) => ({ ...ui, zoneId }));
  const setStatus = (status: StatusFilter) => setReviewUi((ui) => ({ ...ui, status }));

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2600); };

  const zones = useMemo(() => sortZones(state.zones), [state.zones]);
  const selectedZone = zones.find((zone) => zone.id === reviewUi.zoneId);
  const filter = reviewUi.status;

  const accessAudit = useMemo(() => auditAccessibility(state.artifacts, state.zones), [state.artifacts, state.zones]);
  const coverageGaps = useMemo(() => getCoverageGaps(state), [state]);

  const scopedIssues = useMemo<ReviewIssue[]>(() => {
    if (!selectedZone) return state.issues;
    // Scope from live object placement: object movement carries findings with it.
    return state.issues.filter((issue) => selectEffectiveIssueZone(state, issue)?.id === selectedZone.id);
  }, [state, selectedZone]);

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
    <section className={`readiness-card ${readiness.ready ? 'ready' : 'blocked'}`}><div className="readiness-icon">{readiness.ready ? <CheckCircle2 size={28} /> : <ShieldAlert size={28} />}</div><div className="readiness-copy"><div className="eyebrow">READINESS CHECK · {readiness.checkedAt ? formatDate(readiness.checkedAt) : 'not run'}</div><h2>{readiness.ready ? 'Ready to share' : 'Still needs attention'}</h2><p>{readiness.ready ? 'The journey and review desk have no blocking conditions.' : `${readiness.blockers.length} blocking condition${readiness.blockers.length === 1 ? '' : 's'} prevent this plan from being marked ready.`}</p></div><div className="readiness-score"><strong>{readiness.score}</strong><span>readiness score</span></div><div className="readiness-actions">{readiness.ready ? <Button variant="primary" icon={<Download size={16} />} onClick={exportSnapshot}>Export snapshot</Button> : <Button variant="secondary" icon={<RotateCcw size={16} />} onClick={runCheck}>Re-check plan</Button>}</div></section>
    {!readiness.ready && <section className="blocker-list"><div className="eyebrow">WHAT IS BLOCKING</div>{readiness.blockers.map((blocker) => <div className="blocker-row" key={blocker}><XCircle size={16} /><span>{blocker}</span></div>)}</section>}
    <AccessCoverageCard audit={accessAudit} gaps={coverageGaps} state={state} onRemediate={() => setShowRemediation(true)} />
    <div className="review-summary"><div><span className="eyebrow">TOTAL FINDINGS</span><strong>{counts.all}</strong></div><div><span className="eyebrow">OPEN</span><strong className="text-danger">{counts.open}</strong></div><div><span className="eyebrow">IN PROGRESS</span><strong className="text-amber">{counts['in-progress']}</strong></div><div><span className="eyebrow">RESOLVED</span><strong className="text-teal">{counts.resolved}</strong></div></div>
    <div className="review-filters"><div className="review-zone-field"><SelectField label="Exhibition zone" value={selectedZone?.id ?? ''} onChange={(event) => setZoneId(event.target.value)}><option value="">All zones — overview</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</SelectField></div><span className="review-hint"><Sparkles size={14} /> {selectedZone ? 'Findings and the floor checklist are scoped to this zone.' : 'Critical findings block readiness'}</span></div>
    <div className="review-toolbar"><div className="segmented-control">{STATUS_FILTERS.map((status) => <button key={status} className={filter === status ? 'selected' : ''} onClick={() => setStatus(status)}>{titleCase(status)} <span>{counts[status]}</span></button>)}</div></div>
    {checklist && <ZoneChecklistCard checklist={checklist} onDownload={exportChecklist} />}
    <section className="issue-list">{filtered.map((issue) => <IssueRow key={issue.id} issue={issue} zoneName={selectEffectiveIssueZone(state, issue)?.name} onTransition={(status) => transitionReviewIssue(issue.id, status)} />)}</section>
    {filtered.length === 0 && <EmptyState icon={<MapPin size={26} />} title={selectedZone ? 'No findings in this zone' : 'No findings here'} detail={selectedZone ? 'This zone has no findings matching the current status filter.' : 'No findings match the current status filter.'} />}
    {showModal && <IssueEditor state={state} onClose={() => setShowModal(false)} onSave={(draft) => { const result = addIssue(draft); if (result.ok) setShowModal(false); return result; }} />}
    {showRemediation && <RemediationDialog state={state} gaps={coverageGaps} onClose={() => setShowRemediation(false)} onCommit={commitRemediation} onCommitted={(count) => { setShowRemediation(false); notify(`${count} remediation finding${count === 1 ? '' : 's'} opened in one transaction.`); }} />}
    {toast && <div className="toast toast-positive"><Download size={16} />{toast}</div>}
  </div>;
}

function AccessCoverageCard({ audit, gaps, state, onRemediate }: { audit: ReturnType<typeof auditAccessibility>; gaps: CoverageGap[]; state: ReturnType<typeof useWorkspace>['state']; onRemediate: () => void }) {
  const actionable = gaps.filter((gap) => !hasOpenRemediation(state, gap.key));
  return <section className="access-coverage-card" aria-label="Accessibility coverage">
    <div className="access-coverage-head">
      <div className="access-coverage-title"><div className="access-coverage-icon"><Accessibility size={20} /></div><div><div className="eyebrow">ACCESSIBILITY COVERAGE</div><h2>{audit.coveredRequirements}/{audit.totalRequirements} requirements covered</h2></div></div>
      <Button variant="primary" icon={<Plus size={16} />} disabled={actionable.length === 0} onClick={onRemediate}>{actionable.length ? `Log ${actionable.length} remediation finding${actionable.length === 1 ? '' : 's'}` : 'Coverage tracked'}</Button>
    </div>
    <ProgressBar value={audit.coverage} tone={gaps.length ? 'amber' : 'teal'} />
    {gaps.length > 0
      ? <div className="access-gap-list">{gaps.map((gap) => {
        const duplicate = hasOpenRemediation(state, gap.key);
        return <div className={`access-gap-row ${duplicate ? 'is-duplicate' : ''}`} key={gap.key}>
          <span className="access-gap-object"><strong>{gap.artifactTitle}</strong><small>{gap.accessionId} · {gap.requirement}</small></span>
          <span className="access-gap-zone"><MapPin size={13} />{gap.zoneName ?? 'Not placed'}</span>
          {duplicate ? <Badge tone="neutral"><Lock size={11} /> Open finding</Badge> : <Badge tone="warning">Gap</Badge>}
        </div>;
      })}</div>
      : <div className="access-gap-clear"><CheckCircle2 size={15} /><span>Every recorded interpretation requirement is covered.</span></div>}
  </section>;
}

function RemediationDialog({ state, gaps, onClose, onCommit, onCommitted }: {
  state: ReturnType<typeof useWorkspace>['state'];
  gaps: CoverageGap[];
  onClose: () => void;
  onCommit: ReturnType<typeof useWorkspace>['commitRemediation'];
  onCommitted: (count: number) => void;
}) {
  // Fingerprints are captured when the dialog opens from the current object
  // facts; commit re-checks them, so a mid-batch change rejects the whole batch.
  const initialRows = useMemo(() => gaps
    .filter((gap) => !hasOpenRemediation(state, gap.key))
    .map((gap) => ({ key: gap.key, fingerprint: gapFingerprint(state, gap.key) ?? '', selected: true, owner: '' })), [gaps, state]);
  const [rows, setRows] = useState(initialRows);
  const [bulkOwner, setBulkOwner] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setRows((current) => current.map((row) => row.owner ? row : { ...row, owner: bulkOwner })); }, [bulkOwner]);

  if (rows.length === 0) return null;

  const gapByKey = new Map(gaps.map((gap) => [gap.key, gap]));
  const selectedRows = rows.filter((row) => row.selected);

  const toggle = (key: string) => setRows((current) => current.map((row) => row.key === key ? { ...row, selected: !row.selected } : row));
  const setOwner = (key: string, owner: string) => setRows((current) => current.map((row) => row.key === key ? { ...row, owner } : row));

  const submit = () => {
    if (selectedRows.length === 0) { setError('Select at least one coverage gap.'); return; }
    const missingOwner = selectedRows.find((row) => !row.owner.trim());
    if (missingOwner) { setError('Assign an owner to every selected gap before submitting.'); return; }
    const result = onCommit({
      selections: selectedRows.map((row) => ({ key: row.key, owner: row.owner.trim(), fingerprint: row.fingerprint })),
    });
    if (!result.ok) { setError(result.failure.message); return; }
    onCommitted(result.issues.length);
  };

  return <Modal eyebrow="ACCESSIBILITY REMEDIATION" title="Open findings for coverage gaps" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send size={15} />} onClick={submit}>Create findings</Button></>}>
    <div className="remediation-dialog">
      <p className="remediation-intro">Each selected gap becomes an open warning finding carrying the object, its current zone, the requirement, and an owner. Gaps that already have an open finding are excluded. Submission is one transaction — nothing is written if any check fails.</p>
      <TextField label="Owner for all selected gaps" value={bulkOwner} placeholder="Team member name" onChange={(event) => setBulkOwner(event.target.value)} hint="Fills empty owner rows; you can still adjust them individually." />
      <div className="remediation-rows">{rows.map((row) => {
        const gap = gapByKey.get(row.key);
        if (!gap) return null;
        return <label className={`remediation-row ${row.selected ? 'selected' : ''}`} key={row.key}>
          <input type="checkbox" checked={row.selected} onChange={() => toggle(row.key)} />
          <span className="remediation-object"><strong>{gap.artifactTitle}</strong><small>{gap.requirement}</small></span>
          <span className="remediation-zone"><MapPin size={13} /> {gap.zoneName ?? 'Not placed'}</span>
          <span className="remediation-owner"><input aria-label={`Owner for ${gap.artifactTitle}`} placeholder="Owner" value={row.owner} onChange={(event) => setOwner(row.key, event.target.value)} onClick={(event) => event.stopPropagation()} /></span>
        </label>;
      })}</div>
      {error && <div className="field-error remediation-error">{error}</div>}
      <div className="remediation-footnote">{selectedRows.length} of {rows.length} gaps selected · same requirement, same object can never be logged twice while open</div>
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

function IssueRow({ issue, zoneName, onTransition }: { issue: ReviewIssue; zoneName?: string; onTransition: (status: ReviewIssue['status']) => { ok: boolean; message?: string } }) {
  const [error, setError] = useState<string | null>(null);
  const next = issue.status === 'open' ? 'in-progress' : issue.status === 'in-progress' ? 'resolved' : 'in-progress';
  const resultLabel = issue.status === 'open' ? 'Start work' : issue.status === 'in-progress' ? 'Resolve' : 'Reopen';
  const result = () => { const response = onTransition(next); if (!response.ok) { setError(response.message ?? 'Transition failed.'); window.setTimeout(() => setError(null), 2500); } };
  return <article className={`issue-row issue-${issue.severity}`}><div className="issue-severity">{issue.severity === 'critical' ? <ShieldAlert size={19} /> : issue.severity === 'warning' ? <AlertCircle size={19} /> : <FileWarning size={19} />}</div><div className="issue-main"><div className="issue-title-line"><h3>{issue.title}</h3>{issue.origin === 'accessibility-remediation' && <Badge tone="info">Access remediation</Badge>}<Badge tone={issue.status === 'resolved' ? 'positive' : issue.severity === 'critical' ? 'danger' : issue.severity === 'warning' ? 'warning' : 'neutral'}>{titleCase(issue.status)}</Badge></div><p>{issue.description}</p><div className="issue-meta"><span><UserRound size={13} /> {issue.owner}</span>{zoneName && <span><MapPin size={13} /> {zoneName}</span>}{issue.artifactId && <span>Object linked</span>}<span>Updated {formatDate(issue.updatedAt)}</span></div>{error && <div className="field-error">{error}</div>}</div><Button variant={issue.status === 'resolved' ? 'ghost' : 'secondary'} icon={issue.status === 'resolved' ? <RotateCcw size={15} /> : <Check size={15} />} onClick={result}>{resultLabel}</Button></article>;
}

function IssueEditor({ state, onClose, onSave }: { state: ReturnType<typeof useWorkspace>['state']; onClose: () => void; onSave: (draft: IssueDraft) => { ok: boolean; errors?: Record<string, string> } }) {
  const [draft, setDraft] = useState<IssueDraft>({ title: '', description: '', severity: 'warning', owner: '', zoneId: '', artifactId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <Modal eyebrow="NEW REVIEW FINDING" title="Capture an open question" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send size={15} />} onClick={() => { const result = onSave(draft); if (!result.ok) setErrors(result.errors ?? {}); }}>Create finding</Button></>}><div className="form-grid"><TextField label="Finding title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="What needs a decision?" /><SelectField label="Severity" value={draft.severity} onChange={(event) => update('severity', event.target.value as IssueSeverity)}><option value="note">Note</option><option value="warning">Warning</option><option value="critical">Critical blocker</option></SelectField><TextField label="Owner" value={draft.owner} onChange={(event) => update('owner', event.target.value)} error={errors.owner} placeholder="Team member" /><SelectField label="Linked zone" value={draft.zoneId} onChange={(event) => update('zoneId', event.target.value)}><option value="">No zone link</option>{state.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</SelectField><SelectField label="Linked object" value={draft.artifactId} onChange={(event) => update('artifactId', event.target.value)}><option value="">No object link</option>{state.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}</SelectField><TextField label="Context and next step" textarea rows={5} value={draft.description} onChange={(event) => update('description', event.target.value)} error={errors.description} placeholder="Describe the decision, evidence, or next action." /></div></Modal>;
}
