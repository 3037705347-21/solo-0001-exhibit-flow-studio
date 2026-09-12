import { Filter, History, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ArtifactGlyph } from '../../components/ArtifactGlyph';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { InlineNotice } from '../../components/InlineNotice';
import { Modal } from '../../components/Modal';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { artifactToDraft, emptyArtifactDraft } from '../../domain/artifactValidation';
import { formatDate, titleCase } from '../../domain/formatters';
import type { Artifact, ArtifactDraft, ArtifactRevision, NarrativeRole, RevisionKind, Sensitivity } from '../../domain/models';
import { fieldDiffersFromRevision, formatRevisionValue, REVISION_FIELD_LABELS, revisionsForArtifact, type TrackedArtifactField } from '../../domain/revisions';
import { useWorkspace } from '../../state/WorkspaceContext';

const roleOptions: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const sensitivityOptions: Sensitivity[] = ['standard', 'low-light', 'fragile'];

const REVISION_KIND_LABELS: Record<RevisionKind, string> = {
  create: 'Created',
  edit: 'Edited',
  'restore-field': 'Field restore',
  'restore-object': 'Full restore',
};

interface SaveResult {
  ok: boolean;
  errors?: Record<string, string>;
  message?: string;
  conflict?: boolean;
}

export function CollectionPage() {
  const { state, upsertArtifact, removeArtifact } = useWorkspace();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sensitivityFilter, setSensitivityFilter] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [editor, setEditor] = useState<{ draft: ArtifactDraft; existing?: Artifact } | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const filtered = useMemo(() => state.artifacts.filter((artifact) => {
    const haystack = `${artifact.title} ${artifact.maker} ${artifact.accessionId} ${artifact.tags.join(' ')}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (roleFilter === 'all' || artifact.narrativeRole === roleFilter) && (sensitivityFilter === 'all' || artifact.sensitivity === sensitivityFilter);
  }), [state.artifacts, query, roleFilter, sensitivityFilter]);

  const notify = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 2400);
  };

  const handleSave = (draft: ArtifactDraft, existing: Artifact | undefined, reason: string): SaveResult => {
    const result = upsertArtifact(draft, existing, reason || undefined);
    if (!result.ok) return result;
    setEditor(null);
    notify(existing ? `Object details updated — now version ${result.value?.revision}.` : 'Object added to the collection.');
    return result;
  };

  const reloadEditor = () => {
    if (!editor?.existing) return;
    const current = state.artifacts.find((artifact) => artifact.id === editor.existing?.id);
    if (current) setEditor({ draft: artifactToDraft(current), existing: current });
  };

  return <div className="page-stack"><SectionHeader eyebrow="OBJECT LIBRARY" title="Collection" description="Shape the cast of objects before you ask them to carry a story." actions={<Button variant="primary" icon={<Plus size={17} />} onClick={() => setEditor({ draft: emptyArtifactDraft })}>Add object</Button>} />
    <div className="summary-strip"><div><span className="eyebrow">COLLECTION SIZE</span><strong>{state.artifacts.length}<small> objects</small></strong></div><div><span className="eyebrow">KEY OBJECTS</span><strong>{state.artifacts.filter((artifact) => artifact.isKeyObject).length}<small> flagged</small></strong></div><div><span className="eyebrow">ROLES COVERED</span><strong>{new Set(state.artifacts.map((artifact) => artifact.narrativeRole)).size}<small> of 4</small></strong></div><div><span className="eyebrow">FILTERED VIEW</span><strong>{filtered.length}<small> showing</small></strong></div></div>
    <section className="toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search collection" placeholder="Search title, maker, ID, or tag" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <Button variant="ghost" icon={<X size={15} />} aria-label="Clear search" onClick={() => setQuery('')} />}</div><Button variant={showFilters ? 'primary' : 'secondary'} icon={<SlidersHorizontal size={16} />} onClick={() => setShowFilters((value) => !value)}>Filters</Button><div className="toolbar-count"><Filter size={14} /> {filtered.length} results</div></section>
    {showFilters && <section className="filter-drawer"><SelectField label="Narrative role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">All roles</option>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField><SelectField label="Sensitivity" value={sensitivityFilter} onChange={(event) => setSensitivityFilter(event.target.value)}><option value="all">All sensitivities</option>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField><Button variant="ghost" onClick={() => { setRoleFilter('all'); setSensitivityFilter('all'); }}>Clear filters</Button></section>}
    {filtered.length === 0 ? <EmptyState icon={<Search size={23} />} title="No matching objects" detail="Try a different search or clear the filters." /> : <div className="artifact-grid">{filtered.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} onEdit={() => setEditor({ draft: artifactToDraft(artifact), existing: artifact })} onHistory={() => setHistoryId(artifact.id)} onRemove={() => { if (window.confirm(`Remove ${artifact.title} from the collection?`)) removeArtifact(artifact.id); }} />)}</div>}
    {feedback && <div className="toast toast-positive">{feedback}</div>}
    {editor && <ArtifactEditor key={editor.existing ? `${editor.existing.id}@${editor.existing.revision}` : 'new'} initial={editor.draft} existing={editor.existing} onClose={() => setEditor(null)} onSave={handleSave} onReload={reloadEditor} />}
    {historyId && <RevisionHistoryModal artifactId={historyId} onClose={() => setHistoryId(null)} />}
  </div>;
}

function ArtifactCard({ artifact, onEdit, onHistory, onRemove }: { artifact: Artifact; onEdit: () => void; onHistory: () => void; onRemove: () => void }) {
  return <article className="artifact-card"><div className="artifact-card-top"><ArtifactGlyph color={artifact.color} size="large" /><div className="artifact-actions"><Button variant="ghost" onClick={onEdit}>Edit</Button><Button variant="ghost" icon={<History size={14} />} onClick={onHistory}>History</Button><Button variant="ghost" onClick={onRemove}>Remove</Button></div></div><div className="artifact-id">{artifact.accessionId}</div><h3>{artifact.title}</h3><p className="artifact-maker">{artifact.maker} · {artifact.yearLabel}</p><p className="artifact-summary">{artifact.summary}</p><div className="tag-row"><Badge tone="info">{titleCase(artifact.narrativeRole)}</Badge><Badge tone={artifact.sensitivity === 'low-light' ? 'warning' : 'neutral'}>{titleCase(artifact.sensitivity)}</Badge>{artifact.isKeyObject && <Badge tone="danger">Key object</Badge>}</div><div className="artifact-card-bottom"><span>{artifact.medium}</span><strong>{artifact.dwellMinutes} min dwell</strong><span className="artifact-version">v{artifact.revision}</span></div></article>;
}

function ArtifactEditor({ initial, existing, onClose, onSave, onReload }: { initial: ArtifactDraft; existing?: Artifact; onClose: () => void; onSave: (draft: ArtifactDraft, existing: Artifact | undefined, reason: string) => SaveResult; onReload: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const update = <K extends keyof ArtifactDraft>(key: K, value: ArtifactDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = () => {
    const result = onSave(draft, existing, reason);
    if (!result.ok) {
      setErrors(result.errors ?? {});
      setFormError(result.message ?? null);
      setConflict(Boolean(result.conflict));
    }
  };
  return <Modal eyebrow={existing ? `EDIT OBJECT · VERSION ${existing.revision}` : 'NEW OBJECT'} title={existing ? 'Update object record' : 'Add to collection'} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>{existing ? 'Save changes' : 'Add object'}</Button></>}><div className="form-grid">
    {existing && <TextField label="Reason for change" value={reason} onChange={(event) => setReason(event.target.value)} error={errors.reason} placeholder="e.g. Conservation report 2026-09" hint="Recorded in the object history as the basis for this change." />}
    {formError && <div className="form-notice"><InlineNotice tone="warning" message={formError} />{conflict && <Button variant="secondary" onClick={onReload}>Reload latest version</Button>}</div>}
    <TextField label="Accession ID" value={draft.accessionId} onChange={(event) => update('accessionId', event.target.value)} error={errors.accessionId} placeholder="AF-2027-001" /><TextField label="Title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="Object title" /><TextField label="Maker / source" value={draft.maker} onChange={(event) => update('maker', event.target.value)} error={errors.maker} /><TextField label="Date / period" value={draft.yearLabel} onChange={(event) => update('yearLabel', event.target.value)} /><TextField label="Medium" value={draft.medium} onChange={(event) => update('medium', event.target.value)} error={errors.medium} /><TextField label="Origin" value={draft.origin} onChange={(event) => update('origin', event.target.value)} /><TextField label="Width (cm)" type="number" min="0" step="0.1" value={draft.width} onChange={(event) => update('width', event.target.value)} error={errors.width} /><TextField label="Height (cm)" type="number" min="0" step="0.1" value={draft.height} onChange={(event) => update('height', event.target.value)} error={errors.height} /><TextField label="Depth (cm)" type="number" min="0" step="0.1" value={draft.depth} onChange={(event) => update('depth', event.target.value)} error={errors.depth} /><TextField label="Dwell time (min)" type="number" min="1" max="30" value={draft.dwellMinutes} onChange={(event) => update('dwellMinutes', event.target.value)} error={errors.dwellMinutes} /><SelectField label="Narrative role" value={draft.narrativeRole} onChange={(event) => update('narrativeRole', event.target.value as NarrativeRole)}>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField><SelectField label="Sensitivity" value={draft.sensitivity} onChange={(event) => update('sensitivity', event.target.value as Sensitivity)}>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField><SelectField label="Accessibility need" value={draft.accessibilityNeed} onChange={(event) => update('accessibilityNeed', event.target.value as ArtifactDraft['accessibilityNeed'])}><option value="none">None noted</option><option value="seating">Seated interpretation</option><option value="audio">Audio interpretation</option><option value="tactile-alternative">Tactile alternative</option></SelectField><TextField label="Tags" value={draft.tags} onChange={(event) => update('tags', event.target.value)} hint="Comma-separated, up to 8" /><TextField label="Object summary" textarea rows={4} value={draft.summary} onChange={(event) => update('summary', event.target.value)} error={errors.summary} hint="Describe why this object matters in the exhibition." /><label className="check-field"><input type="checkbox" checked={draft.isKeyObject} onChange={(event) => update('isKeyObject', event.target.checked)} /><span><strong>Key object</strong><small>Must be placed before readiness can pass.</small></span></label></div></Modal>;
}

function RevisionHistoryModal({ artifactId, onClose }: { artifactId: string; onClose: () => void }) {
  const { state, restoreArtifactField, restoreArtifactRevision } = useWorkspace();
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; message: string } | null>(null);
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact) return null;
  const chain = revisionsForArtifact(state.revisions, artifactId);

  const report = (result: { ok: boolean; message?: string }, success: string) => {
    setNotice(result.ok ? { tone: 'success', message: success } : { tone: 'warning', message: result.message ?? 'The restore could not be completed.' });
  };
  const restoreField = (revision: ArtifactRevision, field: TrackedArtifactField) => {
    report(restoreArtifactField(artifactId, revision.id, field), `${REVISION_FIELD_LABELS[field]} restored from version ${revision.version}.`);
  };
  const restoreRevision = (revision: ArtifactRevision) => {
    report(restoreArtifactRevision(artifactId, revision.id), `Object restored to version ${revision.version}.`);
  };

  return <Modal eyebrow={`OBJECT HISTORY · ${artifact.accessionId}`} title={`Revision history — v${artifact.revision} current`} onClose={onClose}>
    <p className="revision-intro">Every saved change is recorded with its before and after values, the basis for the change, and a version. Restoring a field or a full version is itself recorded as a new revision — placements, findings, and exports always follow the same object.</p>
    {notice && <div className="revision-notice"><InlineNotice tone={notice.tone} message={notice.message} /></div>}
    <ol className="revision-list">
      {[...chain].reverse().map((revision) => {
        const isCurrent = revision.version === artifact.revision;
        return <li key={revision.id} className={`revision-entry${isCurrent ? ' current' : ''}`}>
          <div className="revision-head"><Badge tone={revision.kind === 'create' ? 'info' : revision.kind === 'edit' ? 'neutral' : 'warning'}>{REVISION_KIND_LABELS[revision.kind]}</Badge><strong>Version {revision.version}</strong>{isCurrent && <Badge tone="positive">Current</Badge>}<span className="revision-meta">{formatDate(revision.changedAt)}</span></div>
          <p className="revision-reason">{revision.reason}</p>
          <div className="revision-changes">
            {revision.changes.map((change) => {
              const field = change.field as TrackedArtifactField;
              const label = REVISION_FIELD_LABELS[field] ?? change.field;
              return <div className="revision-change" key={change.field}>
                <span className="revision-field">{label}</span>
                <span className="revision-diff"><s>{formatRevisionValue(change.field, change.before)}</s>→<strong>{formatRevisionValue(change.field, change.after)}</strong></span>
                <Button variant="ghost" disabled={!fieldDiffersFromRevision(artifact, revision, field)} onClick={() => restoreField(revision, field)}>Restore field</Button>
              </div>;
            })}
            {revision.changes.length === 0 && <div className="revision-change"><span className="revision-field">No field changes</span><span className="revision-diff"><strong>Record saved without metadata changes</strong></span></div>}
          </div>
          <div className="revision-actions"><Button variant="secondary" disabled={isCurrent} onClick={() => restoreRevision(revision)}>Restore this version</Button></div>
        </li>;
      })}
    </ol>
  </Modal>;
}
