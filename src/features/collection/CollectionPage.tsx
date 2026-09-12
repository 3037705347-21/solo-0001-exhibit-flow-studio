import { AlertTriangle, ArrowRight, CheckCircle2, Filter, Lightbulb, Plus, Search, SlidersHorizontal, Undo2, X, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ArtifactGlyph } from '../../components/ArtifactGlyph';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { ProgressBar } from '../../components/ProgressBar';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { artifactToDraft, emptyArtifactDraft } from '../../domain/artifactValidation';
import { titleCase } from '../../domain/formatters';
import type { ImpactPreview } from '../../domain/impactPreview';
import type { Artifact, ArtifactDraft, NarrativeRole, Sensitivity } from '../../domain/models';
import { useWorkspace } from '../../state/WorkspaceContext';

const roleOptions: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const sensitivityOptions: Sensitivity[] = ['standard', 'low-light', 'fragile'];

export function CollectionPage() {
  const { state, removeArtifact } = useWorkspace();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sensitivityFilter, setSensitivityFilter] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [editor, setEditor] = useState<{ draft: ArtifactDraft; existing?: Artifact } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const filtered = useMemo(() => state.artifacts.filter((artifact) => {
    const haystack = `${artifact.title} ${artifact.maker} ${artifact.accessionId} ${artifact.tags.join(' ')}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (roleFilter === 'all' || artifact.narrativeRole === roleFilter) && (sensitivityFilter === 'all' || artifact.sensitivity === sensitivityFilter);
  }), [state.artifacts, query, roleFilter, sensitivityFilter]);

  const handleSaved = (isEdit: boolean) => {
    setEditor(null);
    setFeedback(isEdit ? 'Object details updated.' : 'Object added to the collection.');
    window.setTimeout(() => setFeedback(null), 2400);
  };

  return <div className="page-stack"><SectionHeader eyebrow="OBJECT LIBRARY" title="Collection" description="Shape the cast of objects before you ask them to carry a story." actions={<Button variant="primary" icon={<Plus size={17} />} onClick={() => setEditor({ draft: emptyArtifactDraft })}>Add object</Button>} />
    <div className="summary-strip"><div><span className="eyebrow">COLLECTION SIZE</span><strong>{state.artifacts.length}<small> objects</small></strong></div><div><span className="eyebrow">KEY OBJECTS</span><strong>{state.artifacts.filter((artifact) => artifact.isKeyObject).length}<small> flagged</small></strong></div><div><span className="eyebrow">ROLES COVERED</span><strong>{new Set(state.artifacts.map((artifact) => artifact.narrativeRole)).size}<small> of 4</small></strong></div><div><span className="eyebrow">FILTERED VIEW</span><strong>{filtered.length}<small> showing</small></strong></div></div>
    <section className="toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search collection" placeholder="Search title, maker, ID, or tag" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <Button variant="ghost" icon={<X size={15} />} aria-label="Clear search" onClick={() => setQuery('')} />}</div><Button variant={showFilters ? 'primary' : 'secondary'} icon={<SlidersHorizontal size={16} />} onClick={() => setShowFilters((value) => !value)}>Filters</Button><div className="toolbar-count"><Filter size={14} /> {filtered.length} results</div></section>
    {showFilters && <section className="filter-drawer"><SelectField label="Narrative role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">All roles</option>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField><SelectField label="Sensitivity" value={sensitivityFilter} onChange={(event) => setSensitivityFilter(event.target.value)}><option value="all">All sensitivities</option>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField><Button variant="ghost" onClick={() => { setRoleFilter('all'); setSensitivityFilter('all'); }}>Clear filters</Button></section>}
    {filtered.length === 0 ? <EmptyState icon={<Search size={23} />} title="No matching objects" detail="Try a different search or clear the filters." /> : <div className="artifact-grid">{filtered.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} onEdit={() => setEditor({ draft: artifactToDraft(artifact), existing: artifact })} onRemove={() => { if (window.confirm(`Remove ${artifact.title} from the collection?`)) removeArtifact(artifact.id); }} />)}</div>}
    {feedback && <div className="toast toast-positive">{feedback}</div>}
    {editor && <ArtifactEditor initial={editor.draft} existing={editor.existing} onClose={() => setEditor(null)} onSaved={handleSaved} />}
  </div>;
}

function ArtifactCard({ artifact, onEdit, onRemove }: { artifact: Artifact; onEdit: () => void; onRemove: () => void }) {
  return <article className="artifact-card"><div className="artifact-card-top"><ArtifactGlyph color={artifact.color} size="large" /><div className="artifact-actions"><Button variant="ghost" onClick={onEdit}>Edit</Button><Button variant="ghost" onClick={onRemove}>Remove</Button></div></div><div className="artifact-id">{artifact.accessionId}</div><h3>{artifact.title}</h3><p className="artifact-maker">{artifact.maker} · {artifact.yearLabel}</p><p className="artifact-summary">{artifact.summary}</p><div className="tag-row"><Badge tone="info">{titleCase(artifact.narrativeRole)}</Badge><Badge tone={artifact.sensitivity === 'low-light' ? 'warning' : 'neutral'}>{titleCase(artifact.sensitivity)}</Badge>{artifact.isKeyObject && <Badge tone="danger">Key object</Badge>}</div><div className="artifact-card-bottom"><span>{artifact.medium}</span><strong>{artifact.dwellMinutes} min dwell</strong></div></article>;
}

function ArtifactEditor({ initial, existing, onClose, onSaved }: { initial: ArtifactDraft; existing?: Artifact; onClose: () => void; onSaved: (isEdit: boolean) => void }) {
  const { upsertArtifact, previewArtifactChange, commitArtifactChange } = useWorkspace();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ImpactPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const update = <K extends keyof ArtifactDraft>(key: K, value: ArtifactDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = () => {
    if (!existing) {
      const result = upsertArtifact(draft);
      if (!result.ok) { setErrors(result.errors ?? {}); return; }
      onSaved(false);
      return;
    }
    const result = previewArtifactChange(draft, existing);
    if (!result.ok || !result.value) {
      setErrors(result.errors ?? {});
      setNotice(result.errors ? null : (result.message ?? 'The impact preview could not be computed.'));
      return;
    }
    setErrors({});
    setNotice(null);
    setPreview(result.value);
  };

  const confirm = () => {
    if (!existing || !preview) return;
    const result = commitArtifactChange(draft, existing, preview.baseVersion);
    if (result.stale && result.preview) {
      setPreview(result.preview);
      setNotice(result.message ?? 'The plan changed. Review the refreshed impact.');
      return;
    }
    if (!result.ok) {
      setErrors(result.errors ?? {});
      setNotice(result.message ?? null);
      if (result.errors) setPreview(null);
      return;
    }
    onSaved(true);
  };

  // Returning to the form keeps the full draft: every edited field is preserved.
  const backToEdit = () => { setPreview(null); setNotice(null); };

  const footer = preview
    ? <><Button variant="ghost" icon={<Undo2 size={15} />} onClick={backToEdit}>Back to edit</Button><Button variant="primary" icon={<CheckCircle2 size={15} />} onClick={confirm}>Confirm save</Button></>
    : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>{existing ? 'Review impact' : 'Add object'}</Button></>;

  return <Modal eyebrow={preview ? 'IMPACT PREVIEW' : existing ? 'EDIT OBJECT' : 'NEW OBJECT'} title={preview ? 'Confirm journey impact' : existing ? 'Update object record' : 'Add to collection'} onClose={onClose} footer={footer}>{preview ? <ImpactPreviewPanel preview={preview} notice={notice} /> : <div className="form-grid">{notice && <div className="impact-notice form-notice"><AlertTriangle size={15} /><span>{notice}</span></div>}<TextField label="Accession ID" value={draft.accessionId} onChange={(event) => update('accessionId', event.target.value)} error={errors.accessionId} placeholder="AF-2027-001" /><TextField label="Title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="Object title" /><TextField label="Maker / source" value={draft.maker} onChange={(event) => update('maker', event.target.value)} error={errors.maker} /><TextField label="Date / period" value={draft.yearLabel} onChange={(event) => update('yearLabel', event.target.value)} /><TextField label="Medium" value={draft.medium} onChange={(event) => update('medium', event.target.value)} error={errors.medium} /><TextField label="Origin" value={draft.origin} onChange={(event) => update('origin', event.target.value)} /><TextField label="Width (cm)" type="number" min="0" step="0.1" value={draft.width} onChange={(event) => update('width', event.target.value)} error={errors.width} /><TextField label="Height (cm)" type="number" min="0" step="0.1" value={draft.height} onChange={(event) => update('height', event.target.value)} error={errors.height} /><TextField label="Depth (cm)" type="number" min="0" step="0.1" value={draft.depth} onChange={(event) => update('depth', event.target.value)} error={errors.depth} /><TextField label="Dwell time (min)" type="number" min="1" max="30" value={draft.dwellMinutes} onChange={(event) => update('dwellMinutes', event.target.value)} error={errors.dwellMinutes} /><SelectField label="Narrative role" value={draft.narrativeRole} onChange={(event) => update('narrativeRole', event.target.value as NarrativeRole)}>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField><SelectField label="Sensitivity" value={draft.sensitivity} onChange={(event) => update('sensitivity', event.target.value as Sensitivity)}>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField><SelectField label="Accessibility need" value={draft.accessibilityNeed} onChange={(event) => update('accessibilityNeed', event.target.value as ArtifactDraft['accessibilityNeed'])}><option value="none">None noted</option><option value="seating">Seated interpretation</option><option value="audio">Audio interpretation</option><option value="tactile-alternative">Tactile alternative</option></SelectField><TextField label="Tags" value={draft.tags} onChange={(event) => update('tags', event.target.value)} hint="Comma-separated, up to 8" /><TextField label="Object summary" textarea rows={4} value={draft.summary} onChange={(event) => update('summary', event.target.value)} error={errors.summary} hint="Describe why this object matters in the exhibition." /><label className="check-field"><input type="checkbox" checked={draft.isKeyObject} onChange={(event) => update('isKeyObject', event.target.checked)} /><span><strong>Key object</strong><small>Must be placed before readiness can pass.</small></span></label></div>}</Modal>;
}

function FindingIcon({ type }: { type: 'error' | 'warning' | 'notice' }) {
  if (type === 'error') return <XCircle size={15} />;
  if (type === 'warning') return <AlertTriangle size={15} />;
  return <Lightbulb size={15} />;
}

function ImpactPreviewPanel({ preview, notice }: { preview: ImpactPreview; notice: string | null }) {
  const readinessDelta = preview.readinessAfter.score - preview.readinessBefore.score;
  return <div className="impact-preview">
    {notice && <div className="impact-notice"><AlertTriangle size={15} /><span>{notice}</span></div>}
    <section className="impact-section"><div className="eyebrow">CONSTRAINT CHANGES</div>
      {preview.fieldChanges.length ? <ul className="impact-fields">{preview.fieldChanges.map((change) => <li key={change.key}><strong>{change.label}</strong><span>{change.before} <ArrowRight size={11} /> {change.after}</span></li>)}</ul> : <p className="impact-muted">No constraint-relevant fields change with this edit.</p>}
    </section>
    {!preview.hasImpact && <div className="clear-message"><CheckCircle2 size={17} /> No zones, findings, or readiness outcomes change with this edit.</div>}
    {preview.affectedZones.length > 0 && <section className="impact-section"><div className="eyebrow">ZONES AFFECTED ({preview.affectedZones.length})</div>
      {preview.affectedZones.map((zone) => <div className="impact-zone" key={zone.zoneId}>
        <div className="impact-zone-head"><strong>{zone.zoneName}</strong><span>{zone.dwellBefore} → {zone.dwellAfter} of {zone.capacityMinutes} min</span></div>
        <ProgressBar value={zone.utilizationAfter * 100} tone={zone.utilizationAfter > 1 ? 'red' : zone.utilizationAfter >= 0.8 ? 'amber' : 'teal'} />
        {zone.addedFindings.map((finding) => <div className={`finding-row ${finding.type}`} key={finding.id}><FindingIcon type={finding.type} /><span><strong>{finding.title}</strong><small>{finding.detail}</small></span></div>)}
        {zone.resolvedFindings.map((finding) => <div className="finding-row resolved" key={finding.id}><CheckCircle2 size={15} /><span><strong>Resolved: {finding.title}</strong><small>{finding.detail}</small></span></div>)}
      </div>)}
    </section>}
    {preview.journeyFindings.length > 0 && <section className="impact-section"><div className="eyebrow">JOURNEY-WIDE FINDINGS</div>
      <div className="finding-list">{preview.journeyFindings.map((delta) => delta.kind === 'added'
        ? <div className={`finding-row ${delta.finding.type}`} key={delta.finding.id}><FindingIcon type={delta.finding.type} /><span><strong>{delta.finding.title}</strong><small>{delta.finding.detail}</small></span></div>
        : <div className="finding-row resolved" key={delta.finding.id}><CheckCircle2 size={15} /><span><strong>Resolved: {delta.finding.title}</strong><small>{delta.finding.detail}</small></span></div>)}</div>
    </section>}
    <section className="impact-section"><div className="eyebrow">READINESS AFTER THIS CHANGE</div>
      <div className="impact-readiness"><Badge tone={preview.readinessAfter.ready ? 'positive' : 'danger'}>{preview.readinessAfter.ready ? 'Ready' : 'Blocked'}</Badge><span className="impact-readiness-score"><strong>{preview.readinessBefore.score} → {preview.readinessAfter.score}</strong>{readinessDelta === 0 ? 'readiness score unchanged' : `readiness score ${readinessDelta > 0 ? '+' : ''}${readinessDelta}`}</span></div>
      {preview.readinessAfter.blockers.length > 0 && <div className="blocker-list"><div className="eyebrow">BLOCKING AFTER THIS CHANGE</div>{preview.readinessAfter.blockers.map((blocker) => <div className="blocker-row" key={blocker}><XCircle size={16} /><span>{blocker}</span></div>)}</div>}
    </section>
    {preview.addedBlockers.length > 0 && <div className="impact-notice"><AlertTriangle size={15} /><span>This edit introduces {preview.addedBlockers.length} new blocking finding{preview.addedBlockers.length === 1 ? '' : 's'}. Confirm only if the team can absorb them.</span></div>}
  </div>;
}
