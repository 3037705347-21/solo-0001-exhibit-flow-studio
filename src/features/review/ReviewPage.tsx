import { AlertCircle, Check, CheckCircle2, ClipboardCheck, Clock, Download, FileWarning, GitMerge, History, Link2, ListChecks, MapPin, Plus, RotateCcw, Send, ShieldAlert, Sparkles, UserRound, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { downloadTextFile } from '../../domain/export';
import { sortZones } from '../../domain/filters';
import { formatDate, formatMinutes, titleCase } from '../../domain/formatters';
import { analyzeJourney } from '../../domain/journeyAnalysis';
import { activeIssues, issueArtifactIds, issueZoneIds, type MergePreview } from '../../domain/mergeIssues';
import type { IssueDraft, IssueSeverity, IssueStatus, ReviewIssue, WorkspaceState } from '../../domain/models';
import { evaluateReadiness } from '../../domain/reviewRules';
import { buildZoneChecklist, serializeZoneChecklistCsv, zoneChecklistFileName } from '../../domain/zoneChecklist';
import { loadReviewUi, saveReviewUi, type ReviewUiState } from '../../state/persistence';
import { useWorkspace } from '../../state/WorkspaceContext';

type StatusFilter = IssueStatus | 'all';
const STATUS_FILTERS: StatusFilter[] = ['all', 'open', 'in-progress', 'resolved'];

export function ReviewPage() {
  const { state, addIssue, transitionReviewIssue, previewMerge, commitMerge, checkReadiness, createSnapshot } = useWorkspace();
  const [reviewUi, setReviewUi] = useState<ReviewUiState>(() => loadReviewUi());
  const [showModal, setShowModal] = useState(false);
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null);
  const [readiness, setReadiness] = useState(() => evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones)));
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { saveReviewUi(reviewUi); }, [reviewUi]);
  const setZoneId = (zoneId: string) => setReviewUi((ui) => ({ ...ui, zoneId }));
  const setStatus = (status: StatusFilter) => setReviewUi((ui) => ({ ...ui, status }));

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(null), 2600); };

  const zones = useMemo(() => sortZones(state.zones), [state.zones]);
  const selectedZone = zones.find((zone) => zone.id === reviewUi.zoneId);
  const filter = reviewUi.status;
  const issueById = useMemo(() => new Map(state.issues.map((issue) => [issue.id, issue])), [state.issues]);

  useEffect(() => {
    setMergeSelection((ids) => ids.filter((id) => issueById.has(id)));
  }, [issueById]);

  const scopedIssues = useMemo<ReviewIssue[]>(() => {
    if (!selectedZone) return state.issues;
    return state.issues.filter((issue) =>
      issueZoneIds(issue).includes(selectedZone.id)
      || issueArtifactIds(issue).some((id) => selectedZone.artifactIds.includes(id)));
  }, [state.issues, selectedZone]);

  // Merged sources stay visible under "All" as evidence, but only canonical
  // and never-merged findings count towards the status totals.
  const countable = useMemo(() => activeIssues(scopedIssues), [scopedIssues]);
  const counts = {
    all: countable.length,
    open: countable.filter((issue) => issue.status === 'open').length,
    'in-progress': countable.filter((issue) => issue.status === 'in-progress').length,
    resolved: countable.filter((issue) => issue.status === 'resolved').length,
  };
  const filtered = filter === 'all' ? scopedIssues : countable.filter((issue) => issue.status === filter);
  const checklist = selectedZone ? buildZoneChecklist(state, selectedZone.id) : null;

  const toggleMergeSelection = (issueId: string) => {
    setMergeSelection((ids) => (ids.includes(issueId) ? ids.filter((id) => id !== issueId) : [...ids, issueId]));
  };

  const openMergePreview = () => {
    const result = previewMerge(mergeSelection);
    if (!result.ok || !result.value) { notify(result.message ?? 'These findings cannot be merged.'); return; }
    setMergePreview(result.value);
  };

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
    <div className="review-summary"><div><span className="eyebrow">TOTAL FINDINGS</span><strong>{counts.all}</strong></div><div><span className="eyebrow">OPEN</span><strong className="text-danger">{counts.open}</strong></div><div><span className="eyebrow">IN PROGRESS</span><strong className="text-amber">{counts['in-progress']}</strong></div><div><span className="eyebrow">RESOLVED</span><strong className="text-teal">{counts.resolved}</strong></div></div>
    <div className="review-filters"><div className="review-zone-field"><SelectField label="Exhibition zone" value={selectedZone?.id ?? ''} onChange={(event) => setZoneId(event.target.value)}><option value="">All zones — overview</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</SelectField></div><span className="review-hint"><Sparkles size={14} /> {selectedZone ? 'Findings and the floor checklist are scoped to this zone.' : 'Critical findings block readiness'}</span></div>
    <div className="review-toolbar"><div className="segmented-control">{STATUS_FILTERS.map((status) => <button key={status} className={filter === status ? 'selected' : ''} onClick={() => setStatus(status)}>{titleCase(status)} <span>{counts[status]}</span></button>)}</div><Button variant="secondary" icon={<GitMerge size={15} />} disabled={mergeSelection.length < 2} onClick={openMergePreview}>Merge selected{mergeSelection.length >= 2 ? ` (${mergeSelection.length})` : ''}</Button></div>
    {checklist && <ZoneChecklistCard checklist={checklist} onDownload={exportChecklist} />}
    <section className="issue-list">{filtered.map((issue) => <IssueRow key={issue.id} issue={issue} canonical={issue.mergedIntoId ? issueById.get(issue.mergedIntoId) : undefined} selected={mergeSelection.includes(issue.id)} onToggleSelect={() => toggleMergeSelection(issue.id)} onTransition={(status) => transitionReviewIssue(issue.id, status)} />)}</section>
    {filtered.length === 0 && <EmptyState icon={<MapPin size={26} />} title={selectedZone ? 'No findings in this zone' : 'No findings here'} detail={selectedZone ? 'This zone has no findings matching the current status filter.' : 'No findings match the current status filter.'} />}
    {showModal && <IssueEditor state={state} onClose={() => setShowModal(false)} onSave={(draft) => { const result = addIssue(draft); if (result.ok) setShowModal(false); return result; }} />}
    {mergePreview && <MergeReviewModal state={state} preview={mergePreview} onClose={() => setMergePreview(null)} onConfirm={(reason, primaryId) => {
      const result = commitMerge(mergePreview.requestedIds, { reason, primaryId, expectedFingerprint: mergePreview.fingerprint });
      if (result.ok && result.value) {
        setMergePreview(null);
        setMergeSelection([]);
        notify(`Merge complete — "${result.value.title}" is now the canonical record.`);
      }
      return result;
    }} />}
    {toast && <div className="toast toast-positive"><Download size={16} />{toast}</div>}
  </div>;
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

function IssueRow({ issue, canonical, selected, onToggleSelect, onTransition }: { issue: ReviewIssue; canonical?: ReviewIssue; selected: boolean; onToggleSelect: () => void; onTransition: (status: ReviewIssue['status']) => { ok: boolean; message?: string } }) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const merged = Boolean(issue.mergedIntoId);
  const next = issue.status === 'open' ? 'in-progress' : issue.status === 'in-progress' ? 'resolved' : 'in-progress';
  const resultLabel = issue.status === 'open' ? 'Start work' : issue.status === 'in-progress' ? 'Resolve' : 'Reopen';
  const result = () => {
    const response = onTransition(next);
    if (!response.ok) { setError(response.message ?? 'Transition failed.'); window.setTimeout(() => setError(null), 2500); }
    else if (response.message) { setNote(response.message); window.setTimeout(() => setNote(null), 3500); }
  };
  return <article className={`issue-row issue-${issue.severity} ${merged ? 'issue-merged' : ''}`}><label className="merge-select" title="Select for merge"><input type="checkbox" aria-label={`Select "${issue.title}" for merge`} checked={selected} onChange={onToggleSelect} /></label><div className="issue-severity">{issue.severity === 'critical' ? <ShieldAlert size={19} /> : issue.severity === 'warning' ? <AlertCircle size={19} /> : <FileWarning size={19} />}</div><div className="issue-main"><div className="issue-title-line"><h3>{issue.title}</h3><Badge tone={issue.status === 'resolved' ? 'positive' : issue.severity === 'critical' ? 'danger' : issue.severity === 'warning' ? 'warning' : 'neutral'}>{titleCase(issue.status)}</Badge>{merged && <Badge tone="info">Merged</Badge>}{issue.merge && <Badge tone="info">Canonical · {issue.merge.mergedFrom.length} merged</Badge>}</div><p>{issue.description}</p><div className="issue-meta"><span><UserRound size={13} /> {issue.owner}</span>{issue.zoneId && <span><MapPin size={13} /> Zone linked</span>}{issue.artifactId && <span>Object linked</span>}<span>Updated {formatDate(issue.updatedAt)}</span></div>{merged && <div className="merge-ref"><GitMerge size={13} /><span>Merged into <strong>{canonical?.title ?? issue.mergedIntoId}</strong> — references to this finding now point at the canonical record{canonical?.merge?.reason ? ` · ${canonical.merge.reason}` : ''}</span></div>}{issue.merge && <div className="merge-ref"><GitMerge size={13} /><span>Merged {issue.merge.mergedFrom.length} source finding{issue.merge.mergedFrom.length === 1 ? '' : 's'} on {formatDate(issue.merge.mergedAt)} · {issue.merge.reason}</span></div>}{error && <div className="field-error">{error}</div>}{note && <div className="field-hint">{note}</div>}</div>{!merged && <Button variant={issue.status === 'resolved' ? 'ghost' : 'secondary'} icon={issue.status === 'resolved' ? <RotateCcw size={15} /> : <Check size={15} />} onClick={result}>{resultLabel}</Button>}</article>;
}

const MERGE_FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  severity: 'Severity',
  status: 'Status',
  owner: 'Owner',
  zoneId: 'Zone link',
  artifactId: 'Object link',
  description: 'Description',
};

function MergeReviewModal({ state, preview, onClose, onConfirm }: { state: WorkspaceState; preview: MergePreview; onClose: () => void; onConfirm: (reason: string, primaryId: string) => { ok: boolean; message?: string } }) {
  const [reason, setReason] = useState('');
  const [primaryId, setPrimaryId] = useState(preview.primaryId);
  const [error, setError] = useState<string | null>(null);

  const zoneName = (id: string) => state.zones.find((zone) => zone.id === id)?.name ?? id;
  const artifactTitle = (id: string) => state.artifacts.find((artifact) => artifact.id === id)?.title ?? id;
  const issueById = useMemo(() => new Map(state.issues.map((issue) => [issue.id, issue])), [state.issues]);
  const canonical = preview.existingCanonicalId ? issueById.get(preview.existingCanonicalId) : undefined;
  const records = preview.statusHistory
    .map((entry) => ({ entry, issue: issueById.get(entry.issueId) }))
    .filter((record): record is { entry: MergePreview['statusHistory'][number]; issue: ReviewIssue } => Boolean(record.issue));

  const fieldValue = (field: string, value: string) => {
    if (!value) return '—';
    if (field === 'zoneId') return zoneName(value);
    if (field === 'artifactId') return artifactTitle(value);
    if (field === 'severity' || field === 'status') return titleCase(value);
    return value;
  };

  const sharedZones = preview.sharedZoneIds.map(zoneName);
  const sharedArtifacts = preview.sharedArtifactIds.map(artifactTitle);
  const linkedZones = preview.linkedZoneIds.map(zoneName);
  const linkedArtifacts = preview.linkedArtifactIds.map(artifactTitle);
  const hasSharedRoot = sharedZones.length > 0 || sharedArtifacts.length > 0;

  const confirm = () => {
    const result = onConfirm(reason, primaryId);
    if (!result.ok) setError(result.message ?? 'The merge could not be completed.');
  };

  return <Modal eyebrow="MERGE FINDINGS" title="Merge duplicate findings" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>{preview.mode !== 'noop' && <Button variant="primary" icon={<GitMerge size={15} />} disabled={!reason.trim()} onClick={confirm}>Confirm merge</Button>}</>}>
    <div className="merge-modal">
      {preview.mode === 'noop' && <div className="merge-banner is-note"><GitMerge size={16} /><span>These findings are already merged into <strong>{canonical?.title ?? 'the canonical record'}</strong>. No new record will be created.</span></div>}
      {preview.mode === 'absorb' && <div className="merge-banner is-note"><GitMerge size={16} /><span>The new findings will be absorbed into the existing canonical record <strong>{canonical?.title ?? ''}</strong>. No additional canonical record is created.</span></div>}
      {preview.mode === 'create' && <div className="merge-banner"><GitMerge size={16} /><span>A single canonical record will be created. The {preview.sourceIds.length} source records stay in the list as evidence and point at it.</span></div>}

      <section className="merge-section"><div className="eyebrow"><Link2 size={11} /> COMMON ROOT CAUSE</div>
        {hasSharedRoot ? <p className="merge-root">All selected findings point at {[
          ...sharedArtifacts.map((title) => `object "${title}"`),
          ...sharedZones.map((name) => `zone "${name}"`),
        ].join(' and ')}, so they are treated as reports of the same underlying problem.</p>
          : <p className="merge-root is-warning">The selected findings share no linked zone or object. Confirm they really describe the same root cause before merging.</p>}
      </section>

      <section className="merge-section"><div className="eyebrow">FIELD DIFFERENCES</div>
        <div className="merge-diff-table" role="table" aria-label="Field differences">
          <div className="merge-diff-row merge-diff-head" role="row"><span role="columnheader">Field</span>{records.map(({ issue }) => <span role="columnheader" key={issue.id}>{issue.title}</span>)}</div>
          {preview.fieldDiffs.map((diff) => <div className={`merge-diff-row ${diff.differs ? 'differs' : ''}`} role="row" key={diff.field}><span role="rowheader">{MERGE_FIELD_LABELS[diff.field] ?? diff.field}</span>{diff.values.map((value) => <span role="cell" key={value.issueId} className={diff.field === 'description' ? 'merge-diff-long' : ''}>{fieldValue(diff.field, value.value)}</span>)}</div>)}
        </div>
      </section>

      <section className="merge-section"><div className="eyebrow">LINKED ZONES AND OBJECTS</div>
        {linkedZones.length === 0 && linkedArtifacts.length === 0 && <p className="merge-root">No zone or object links across the selected findings.</p>}
        <div className="merge-linked">{linkedZones.map((name) => <span className="merge-chip" key={`zone-${name}`}><MapPin size={12} />{name}</span>)}{linkedArtifacts.map((title) => <span className="merge-chip" key={`artifact-${title}`}><Link2 size={12} />{title}</span>)}</div>
      </section>

      <section className="merge-section"><div className="eyebrow"><History size={11} /> STATUS HISTORY</div>
        <div className="merge-history">{records.map(({ entry, issue }) => <div className="merge-history-row" key={entry.issueId}><span className="merge-history-title">{entry.title}{issue.merge ? ' · canonical' : ''}{entry.mergedIntoId ? ' · already merged' : ''}</span><Badge tone={entry.status === 'resolved' ? 'positive' : issue.severity === 'critical' ? 'danger' : issue.severity === 'warning' ? 'warning' : 'neutral'}>{titleCase(entry.status)}</Badge><span className="merge-history-dates">created {formatDate(entry.createdAt)} · updated {formatDate(entry.updatedAt)}{entry.resolvedAt ? ` · resolved ${formatDate(entry.resolvedAt)}` : ''}</span></div>)}</div>
      </section>

      {preview.mode === 'create' && <section className="merge-section"><div className="eyebrow">CANONICAL CONTENT</div>
        <p className="merge-root">Choose which record supplies the canonical title, description, and owner. Severity and status are combined from every source.</p>
        <div className="merge-primary-list">{records.map(({ issue }) => <label className="merge-primary-option" key={issue.id}><input type="radio" name="merge-primary" checked={primaryId === issue.id} onChange={() => setPrimaryId(issue.id)} /><span><strong>{issue.title}</strong><small>{issue.owner} · {titleCase(issue.severity)} · {titleCase(issue.status)}</small></span></label>)}</div>
      </section>}

      <section className="merge-section"><div className="eyebrow">MERGE RESULT</div>
        <p className="merge-root">Canonical severity <strong>{titleCase(preview.resultingSeverity)}</strong> · canonical status <strong>{titleCase(preview.resultingStatus)}</strong>. Evidence from every source is appended to the canonical description.</p>
        <TextField label="Merge reason" textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why are these the same finding? This reason is stored on the canonical record." hint="Required — the reason is kept with the merge record for audit." />
      </section>

      {error && <div className="field-error" role="alert">{error}</div>}
    </div>
  </Modal>;
}

function IssueEditor({ state, onClose, onSave }: { state: ReturnType<typeof useWorkspace>['state']; onClose: () => void; onSave: (draft: IssueDraft) => { ok: boolean; errors?: Record<string, string> } }) {
  const [draft, setDraft] = useState<IssueDraft>({ title: '', description: '', severity: 'warning', owner: '', zoneId: '', artifactId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = <K extends keyof IssueDraft>(key: K, value: IssueDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  return <Modal eyebrow="NEW REVIEW FINDING" title="Capture an open question" onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Send size={15} />} onClick={() => { const result = onSave(draft); if (!result.ok) setErrors(result.errors ?? {}); }}>Create finding</Button></>}><div className="form-grid"><TextField label="Finding title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="What needs a decision?" /><SelectField label="Severity" value={draft.severity} onChange={(event) => update('severity', event.target.value as IssueSeverity)}><option value="note">Note</option><option value="warning">Warning</option><option value="critical">Critical blocker</option></SelectField><TextField label="Owner" value={draft.owner} onChange={(event) => update('owner', event.target.value)} error={errors.owner} placeholder="Team member" /><SelectField label="Linked zone" value={draft.zoneId} onChange={(event) => update('zoneId', event.target.value)}><option value="">No zone link</option>{state.zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</SelectField><SelectField label="Linked object" value={draft.artifactId} onChange={(event) => update('artifactId', event.target.value)}><option value="">No object link</option>{state.artifacts.map((artifact) => <option key={artifact.id} value={artifact.id}>{artifact.title}</option>)}</SelectField><TextField label="Context and next step" textarea rows={5} value={draft.description} onChange={(event) => update('description', event.target.value)} error={errors.description} placeholder="Describe the decision, evidence, or next action." /></div></Modal>;
}
