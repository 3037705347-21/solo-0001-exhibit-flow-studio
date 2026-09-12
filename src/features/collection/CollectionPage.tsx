import { ArrowDownWideNarrow, ArrowUpNarrowWide, Download, Filter, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ArtifactGlyph } from '../../components/ArtifactGlyph';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { artifactToDraft, emptyArtifactDraft } from '../../domain/artifactValidation';
import { COLLECTION_SORT_KEYS, collectionSortLabels, defaultDirectionForKey, sortCollection, type CollectionSort, type CollectionSortKey } from '../../domain/collectionSort';
import { collectionListFileName, downloadTextFile, serializeCollectionCsv } from '../../domain/export';
import { titleCase } from '../../domain/formatters';
import type { Artifact, ArtifactDraft, NarrativeRole, Sensitivity } from '../../domain/models';
import { loadCollectionUi, saveCollectionUi } from '../../state/persistence';
import { useWorkspace } from '../../state/WorkspaceContext';

const roleOptions: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const sensitivityOptions: Sensitivity[] = ['standard', 'low-light', 'fragile'];

export function CollectionPage() {
  const { state, upsertArtifact, removeArtifact } = useWorkspace();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sensitivityFilter, setSensitivityFilter] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<CollectionSort>(() => loadCollectionUi());
  const [editor, setEditor] = useState<{ draft: ArtifactDraft; existing?: Artifact } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => { saveCollectionUi(sort); }, [sort]);

  // Order is decided first; search and filters only narrow the visible set, never reorder it.
  const sorted = useMemo(() => sortCollection(state.artifacts, sort), [state.artifacts, sort]);
  const filtered = useMemo(() => sorted.filter((artifact) => {
    const haystack = `${artifact.title} ${artifact.maker} ${artifact.accessionId} ${artifact.tags.join(' ')}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (roleFilter === 'all' || artifact.narrativeRole === roleFilter) && (sensitivityFilter === 'all' || artifact.sensitivity === sensitivityFilter);
  }), [sorted, query, roleFilter, sensitivityFilter]);

  const changeSortKey = (key: CollectionSortKey) => setSort({ key, direction: defaultDirectionForKey(key) });
  const toggleDirection = () => setSort((current) => ({ ...current, direction: current.direction === 'asc' ? 'desc' : 'asc' }));

  const notify = (message: string) => { setFeedback(message); window.setTimeout(() => setFeedback(null), 2400); };

  const handleSave = (draft: ArtifactDraft, existing?: Artifact) => {
    const result = upsertArtifact(draft, existing);
    if (!result.ok) return result;
    setEditor(null);
    notify(existing ? 'Object details updated.' : 'Object added to the collection.');
    return result;
  };

  const exportView = () => {
    downloadTextFile(serializeCollectionCsv(filtered), collectionListFileName(), 'text/csv;charset=utf-8');
    notify('Collection view downloaded in its current order.');
  };

  return <div className="page-stack"><SectionHeader eyebrow="OBJECT LIBRARY" title="Collection" description="Shape the cast of objects before you ask them to carry a story." actions={<div className="header-button-row"><Button variant="secondary" icon={<Download size={16} />} onClick={exportView} disabled={filtered.length === 0}>Export view (CSV)</Button><Button variant="primary" icon={<Plus size={17} />} onClick={() => setEditor({ draft: emptyArtifactDraft })}>Add object</Button></div>} />
    <div className="summary-strip"><div><span className="eyebrow">COLLECTION SIZE</span><strong>{state.artifacts.length}<small> objects</small></strong></div><div><span className="eyebrow">KEY OBJECTS</span><strong>{state.artifacts.filter((artifact) => artifact.isKeyObject).length}<small> flagged</small></strong></div><div><span className="eyebrow">ROLES COVERED</span><strong>{new Set(state.artifacts.map((artifact) => artifact.narrativeRole)).size}<small> of 4</small></strong></div><div><span className="eyebrow">FILTERED VIEW</span><strong>{filtered.length}<small> showing</small></strong></div></div>
    <section className="toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search collection" placeholder="Search title, maker, ID, or tag" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <Button variant="ghost" icon={<X size={15} />} aria-label="Clear search" onClick={() => setQuery('')} />}</div><div className="sort-control" title="Equal values are ordered by title, then accession ID."><label className="sort-label" htmlFor="collection-sort">Sort</label><select id="collection-sort" aria-label="Sort objects by" value={sort.key} onChange={(event) => changeSortKey(event.target.value as CollectionSortKey)}>{COLLECTION_SORT_KEYS.map((key) => <option key={key} value={key}>{collectionSortLabels[key]}</option>)}</select><Button variant="ghost" icon={sort.direction === 'asc' ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />} aria-label={`Sort direction: ${sort.direction === 'asc' ? 'ascending' : 'descending'}`} onClick={toggleDirection} /></div><Button variant={showFilters ? 'primary' : 'secondary'} icon={<SlidersHorizontal size={16} />} onClick={() => setShowFilters((value) => !value)}>Filters</Button><div className="toolbar-count"><Filter size={14} /> {filtered.length} results</div></section>
    {showFilters && <section className="filter-drawer"><SelectField label="Narrative role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">All roles</option>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField><SelectField label="Sensitivity" value={sensitivityFilter} onChange={(event) => setSensitivityFilter(event.target.value)}><option value="all">All sensitivities</option>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField><Button variant="ghost" onClick={() => { setRoleFilter('all'); setSensitivityFilter('all'); }}>Clear filters</Button></section>}
    {filtered.length === 0 ? <EmptyState icon={<Search size={23} />} title="No matching objects" detail="Try a different search or clear the filters." /> : <div className="artifact-grid">{filtered.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} onEdit={() => setEditor({ draft: artifactToDraft(artifact), existing: artifact })} onRemove={() => { if (window.confirm(`Remove ${artifact.title} from the collection?`)) removeArtifact(artifact.id); }} />)}</div>}
    {feedback && <div className="toast toast-positive">{feedback}</div>}
    {editor && <ArtifactEditor initial={editor.draft} existing={editor.existing} onClose={() => setEditor(null)} onSave={handleSave} />}
  </div>;
}

function ArtifactCard({ artifact, onEdit, onRemove }: { artifact: Artifact; onEdit: () => void; onRemove: () => void }) {
  return <article className="artifact-card"><div className="artifact-card-top"><ArtifactGlyph color={artifact.color} size="large" /><div className="artifact-actions"><Button variant="ghost" onClick={onEdit}>Edit</Button><Button variant="ghost" onClick={onRemove}>Remove</Button></div></div><div className="artifact-id">{artifact.accessionId}</div><h3>{artifact.title}</h3><p className="artifact-maker">{artifact.maker} · {artifact.yearLabel}</p><p className="artifact-summary">{artifact.summary}</p><div className="tag-row"><Badge tone="info">{titleCase(artifact.narrativeRole)}</Badge><Badge tone={artifact.sensitivity === 'low-light' ? 'warning' : 'neutral'}>{titleCase(artifact.sensitivity)}</Badge>{artifact.isKeyObject && <Badge tone="danger">Key object</Badge>}</div><div className="artifact-card-bottom"><span>{artifact.medium}</span><strong>{artifact.dwellMinutes} min dwell</strong></div></article>;
}

function ArtifactEditor({ initial, existing, onClose, onSave }: { initial: ArtifactDraft; existing?: Artifact; onClose: () => void; onSave: (draft: ArtifactDraft, existing?: Artifact) => { ok: boolean; errors?: Record<string, string> } }) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = <K extends keyof ArtifactDraft>(key: K, value: ArtifactDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = () => { const result = onSave(draft, existing); if (!result.ok) setErrors(result.errors ?? {}); };
  return <Modal eyebrow={existing ? 'EDIT OBJECT' : 'NEW OBJECT'} title={existing ? 'Update object record' : 'Add to collection'} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>{existing ? 'Save changes' : 'Add object'}</Button></>}><div className="form-grid"><TextField label="Accession ID" value={draft.accessionId} onChange={(event) => update('accessionId', event.target.value)} error={errors.accessionId} placeholder="AF-2027-001" /><TextField label="Title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="Object title" /><TextField label="Maker / source" value={draft.maker} onChange={(event) => update('maker', event.target.value)} error={errors.maker} /><TextField label="Date / period" value={draft.yearLabel} onChange={(event) => update('yearLabel', event.target.value)} /><TextField label="Medium" value={draft.medium} onChange={(event) => update('medium', event.target.value)} error={errors.medium} /><TextField label="Origin" value={draft.origin} onChange={(event) => update('origin', event.target.value)} /><TextField label="Width (cm)" type="number" min="0" step="0.1" value={draft.width} onChange={(event) => update('width', event.target.value)} error={errors.width} /><TextField label="Height (cm)" type="number" min="0" step="0.1" value={draft.height} onChange={(event) => update('height', event.target.value)} error={errors.height} /><TextField label="Depth (cm)" type="number" min="0" step="0.1" value={draft.depth} onChange={(event) => update('depth', event.target.value)} error={errors.depth} /><TextField label="Dwell time (min)" type="number" min="1" max="30" value={draft.dwellMinutes} onChange={(event) => update('dwellMinutes', event.target.value)} error={errors.dwellMinutes} /><SelectField label="Narrative role" value={draft.narrativeRole} onChange={(event) => update('narrativeRole', event.target.value as NarrativeRole)}>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField><SelectField label="Sensitivity" value={draft.sensitivity} onChange={(event) => update('sensitivity', event.target.value as Sensitivity)}>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField><SelectField label="Accessibility need" value={draft.accessibilityNeed} onChange={(event) => update('accessibilityNeed', event.target.value as ArtifactDraft['accessibilityNeed'])}><option value="none">None noted</option><option value="seating">Seated interpretation</option><option value="audio">Audio interpretation</option><option value="tactile-alternative">Tactile alternative</option></SelectField><TextField label="Tags" value={draft.tags} onChange={(event) => update('tags', event.target.value)} hint="Comma-separated, up to 8" /><TextField label="Object summary" textarea rows={4} value={draft.summary} onChange={(event) => update('summary', event.target.value)} error={errors.summary} hint="Describe why this object matters in the exhibition." /><label className="check-field"><input type="checkbox" checked={draft.isKeyObject} onChange={(event) => update('isKeyObject', event.target.checked)} /><span><strong>Key object</strong><small>Must be placed before readiness can pass.</small></span></label></div></Modal>;
}
