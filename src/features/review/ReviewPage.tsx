import { ClipboardCheck, Download, MapPin, Plus, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { downloadTextFile, snapshotFileName } from '../../domain/export';
import { sortZones } from '../../domain/filters';
import { titleCase } from '../../domain/formatters';
import { buildZoneChecklist } from '../../domain/zoneChecklist';
import { useWorkspace } from '../../state/WorkspaceContext';
import { downloadZoneChecklist } from './checklist/checklistExport';
import { IssueEditor } from './components/IssueEditor';
import { IssueRow } from './components/IssueRow';
import { ReadinessPanel } from './components/ReadinessPanel';
import { ZoneChecklistCard } from './components/ZoneChecklistCard';
import { countByStatus, filterIssuesByStatus, scopeIssuesToZone, STATUS_FILTERS } from './findings/findingScope';
import { useReadinessCheck } from './hooks/useReadinessCheck';
import { useReviewFilters } from './hooks/useReviewFilters';
import { useTransientNotice } from './hooks/useTransientNotice';

export function ReviewPage() {
  const { state, addIssue, transitionReviewIssue, checkReadiness, createSnapshot } = useWorkspace();
  const { zoneId, status: filter, setZoneId, setStatus } = useReviewFilters();
  const { readiness, check } = useReadinessCheck(state, checkReadiness);
  const { notice, notify } = useTransientNotice();
  const [showModal, setShowModal] = useState(false);

  const zones = useMemo(() => sortZones(state.zones), [state.zones]);
  const selectedZone = zones.find((zone) => zone.id === zoneId);

  const scopedIssues = useMemo(
    () => scopeIssuesToZone(state.issues, selectedZone),
    [state.issues, selectedZone],
  );
  const counts = countByStatus(scopedIssues);
  const filtered = filterIssuesByStatus(scopedIssues, filter);
  const checklist = selectedZone ? buildZoneChecklist(state, selectedZone.id) : null;

  const exportSnapshot = () => {
    const result = createSnapshot();
    if (!result.ok || !result.value) { notify(result.message ?? 'Resolve blockers before exporting.'); return; }
    downloadTextFile(JSON.stringify(result.value, null, 2), snapshotFileName());
    notify('Snapshot downloaded.');
  };
  const exportChecklist = () => {
    if (!selectedZone || !checklist) return;
    downloadZoneChecklist(checklist, selectedZone);
    notify('Zone checklist downloaded.');
  };

  return <div className="page-stack"><SectionHeader eyebrow="QUALITY GATE" title="Review desk" description="Turn open questions into resolved decisions, then run the final readiness check." actions={<div className="header-button-row"><Button variant="secondary" icon={<ClipboardCheck size={16} />} onClick={check}>Run readiness check</Button><Button variant="primary" icon={<Plus size={17} />} onClick={() => setShowModal(true)}>New finding</Button></div>} />
    <ReadinessPanel readiness={readiness} onCheck={check} onExportSnapshot={exportSnapshot} />
    <div className="review-summary"><div><span className="eyebrow">TOTAL FINDINGS</span><strong>{counts.all}</strong></div><div><span className="eyebrow">OPEN</span><strong className="text-danger">{counts.open}</strong></div><div><span className="eyebrow">IN PROGRESS</span><strong className="text-amber">{counts['in-progress']}</strong></div><div><span className="eyebrow">RESOLVED</span><strong className="text-teal">{counts.resolved}</strong></div></div>
    <div className="review-filters"><div className="review-zone-field"><SelectField label="Exhibition zone" value={selectedZone?.id ?? ''} onChange={(event) => setZoneId(event.target.value)}><option value="">All zones — overview</option>{zones.map((zone) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}</SelectField></div><span className="review-hint"><Sparkles size={14} /> {selectedZone ? 'Findings and the floor checklist are scoped to this zone.' : 'Critical findings block readiness'}</span></div>
    <div className="review-toolbar"><div className="segmented-control">{STATUS_FILTERS.map((status) => <button key={status} className={filter === status ? 'selected' : ''} onClick={() => setStatus(status)}>{titleCase(status)} <span>{counts[status]}</span></button>)}</div></div>
    {checklist && <ZoneChecklistCard checklist={checklist} onDownload={exportChecklist} />}
    <section className="issue-list">{filtered.map((issue) => <IssueRow key={issue.id} issue={issue} onTransition={(status) => transitionReviewIssue(issue.id, status)} />)}</section>
    {filtered.length === 0 && <EmptyState icon={<MapPin size={26} />} title={selectedZone ? 'No findings in this zone' : 'No findings here'} detail={selectedZone ? 'This zone has no findings matching the current status filter.' : 'No findings match the current status filter.'} />}
    {showModal && <IssueEditor state={state} onClose={() => setShowModal(false)} onSave={(draft) => { const result = addIssue(draft); if (result.ok) setShowModal(false); return result; }} />}
    {notice && <div className="toast toast-positive"><Download size={16} />{notice}</div>}
  </div>;
}
