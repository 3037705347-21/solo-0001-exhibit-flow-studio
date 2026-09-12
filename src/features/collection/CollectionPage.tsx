import { AlertTriangle, Archive, CheckCircle2, Filter, Plus, Radio, Save, Search, SlidersHorizontal, Snowflake, Trash2, X } from 'lucide-react';
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
import {
  EMPTY_COLLECTION_FILTER,
  FROZEN_MEMBER_FIELD_LABELS,
  describeRulesBasis,
  evaluateFrozenView,
  latestRuleVersion,
} from '../../domain/collectionViews';
import { filterCollection } from '../../domain/filters';
import { formatDate, titleCase } from '../../domain/formatters';
import type { Artifact, ArtifactDraft, CollectionFilter, CollectionView, FrozenMemberEntry, NarrativeRole, Sensitivity } from '../../domain/models';
import { loadCollectionUi, saveCollectionUi, type CollectionUiState } from '../../state/persistence';
import { useWorkspace } from '../../state/WorkspaceContext';

const roleOptions: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const sensitivityOptions: Sensitivity[] = ['standard', 'low-light', 'fragile'];

function sameRules(left: CollectionFilter, right: CollectionFilter): boolean {
  return left.query === right.query
    && left.keyOnly === right.keyOnly
    && left.roles.length === right.roles.length && left.roles.every((role) => right.roles.includes(role))
    && left.sensitivities.length === right.sensitivities.length && left.sensitivities.every((item) => right.sensitivities.includes(item));
}

export function CollectionPage() {
  const { state, upsertArtifact, removeArtifact, saveCollectionView, reviseCollectionView, removeCollectionView } = useWorkspace();
  const [uiState, setUiState] = useState<CollectionUiState>(() => loadCollectionUi(undefined, new Set(state.collectionViews.map((view) => view.id))));
  const [controls, setControls] = useState<CollectionFilter>(() => {
    const selected = state.collectionViews.find((view) => view.id === uiState.selectedViewId);
    return selected ? latestRuleVersion(selected).rules : uiState.draft;
  });
  const [showFilters, setShowFilters] = useState(false);
  const [editor, setEditor] = useState<{ draft: ArtifactDraft; existing?: Artifact } | null>(null);
  const [saveModal, setSaveModal] = useState<{ name: string; kind: CollectionView['kind']; rules: CollectionFilter } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const selectedView = state.collectionViews.find((view) => view.id === uiState.selectedViewId) ?? null;

  // A view deleted elsewhere (or removed by a workspace reset) must drop selection;
  // we never synthesize a kind from stale UI state.
  useEffect(() => {
    if (uiState.selectedViewId && !state.collectionViews.some((view) => view.id === uiState.selectedViewId)) {
      setUiState((current) => ({ ...current, selectedViewId: null }));
      setControls(uiState.draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.collectionViews, uiState.selectedViewId]);

  useEffect(() => {
    saveCollectionUi(uiState);
  }, [uiState]);

  const appliedRules: CollectionFilter = selectedView ? latestRuleVersion(selectedView).rules : uiState.draft;
  const isDirty = Boolean(selectedView) && !sameRules(controls, appliedRules);
  const controlsLocked = selectedView?.kind === 'frozen';

  const liveMembers = useMemo(
    // While editing a live view, the grid previews the (unsaved) draft rules so the
    // curator sees what the next rule version will yield; after saving they converge.
    () => selectedView?.kind === 'live' ? filterCollection(state.artifacts, controls) : null,
    [selectedView, state.artifacts, controls],
  );
  const frozenEvaluation = useMemo(
    () => selectedView?.kind === 'frozen' ? evaluateFrozenView(selectedView, state.artifacts) : null,
    [selectedView, state.artifacts],
  );
  const adHocMembers = useMemo(
    () => (!selectedView ? filterCollection(state.artifacts, controls) : null),
    [selectedView, state.artifacts, controls],
  );

  const filtered = liveMembers ?? (frozenEvaluation
    ? frozenEvaluation.entries.map((entry) => entry.current).filter((artifact): artifact is Artifact => Boolean(artifact))
    : adHocMembers ?? []);

  const notify = (message: string) => { setFeedback(message); window.setTimeout(() => setFeedback(null), 2600); };

  const updateControl = <K extends keyof CollectionFilter>(key: K, value: CollectionFilter[K]) => {
    setControls((current) => ({ ...current, [key]: value }));
    if (!selectedView) setUiState((current) => ({ draft: { ...current.draft, [key]: value }, selectedViewId: null }));
  };
  const toggleControl = (key: 'roles' | 'sensitivities', value: string) => {
    const next = controls[key].includes(value)
      ? controls[key].filter((item) => item !== value)
      : [...controls[key], value];
    updateControl(key, next);
  };
  const clearScratch = () => {
    setControls(EMPTY_COLLECTION_FILTER);
    if (!selectedView) setUiState((current) => ({ ...current, draft: EMPTY_COLLECTION_FILTER }));
  };

  const selectView = (view: CollectionView) => {
    setControls(latestRuleVersion(view).rules);
    setUiState((current) => ({ ...current, selectedViewId: view.id }));
  };
  const browseAll = () => {
    setControls(uiState.draft);
    setUiState((current) => ({ ...current, selectedViewId: null }));
  };

  const handleReviseLive = () => {
    if (!selectedView || selectedView.kind !== 'live') return;
    const result = reviseCollectionView(selectedView.id, controls);
    if (result.ok) notify(`Live view “${selectedView.name}” updated to rule version ${result.value?.ruleVersions.length ?? ''}.`);
    else notify(result.message ?? 'The live view could not be updated.');
  };
  const handleDiscardEdits = () => setControls(appliedRules);

  const openSaveModal = (kind: CollectionView['kind']) => {
    setSaveModal({ name: '', kind, rules: controls });
    setSaveError(null);
  };
  const submitSaveModal = () => {
    if (!saveModal) return;
    const result = saveCollectionView(saveModal.name, saveModal.kind, saveModal.rules);
    if (!result.ok || !result.value) {
      setSaveError(result.errors?.name ?? result.message ?? 'The view could not be saved.');
      return;
    }
    const view = result.value;
    setSaveModal(null);
    setControls(latestRuleVersion(view).rules);
    setUiState((current) => ({ ...current, selectedViewId: view.id }));
    notify(view.kind === 'frozen' ? `Frozen list “${view.name}” issued with ${view.frozenMembers?.length ?? 0} members.` : `Live view “${view.name}” saved.`);
  };

  const handleDeleteView = (view: CollectionView) => {
    const label = view.kind === 'frozen' ? 'frozen list' : 'live view';
    if (!window.confirm(`Delete the ${label} “${view.name}”? Its saved rules${view.kind === 'frozen' ? ' and issued member record' : ''} will be removed.`)) return;
    const result = removeCollectionView(view.id);
    if (!result.ok) { notify(result.message ?? 'The view could not be deleted.'); return; }
    if (selectedView?.id === view.id) browseAll();
    notify(`“${view.name}” deleted.`);
  };

  const handleSaveArtifact = (draft: ArtifactDraft, existing?: Artifact) => {
    const result = upsertArtifact(draft, existing);
    if (!result.ok) return result;
    setEditor(null);
    setFeedback(existing ? 'Object details updated.' : 'Object added to the collection.');
    window.setTimeout(() => setFeedback(null), 2400);
    return result;
  };

  const liveViews = state.collectionViews.filter((view) => view.kind === 'live');
  const frozenViews = state.collectionViews.filter((view) => view.kind === 'frozen');

  return <div className="page-stack"><SectionHeader eyebrow="OBJECT LIBRARY" title="Collection" description="Shape the cast of objects before you ask them to carry a story." actions={<Button variant="primary" icon={<Plus size={17} />} onClick={() => setEditor({ draft: emptyArtifactDraft })}>Add object</Button>} />
    <div className="summary-strip"><div><span className="eyebrow">COLLECTION SIZE</span><strong>{state.artifacts.length}<small> objects</small></strong></div><div><span className="eyebrow">KEY OBJECTS</span><strong>{state.artifacts.filter((artifact) => artifact.isKeyObject).length}<small> flagged</small></strong></div><div><span className="eyebrow">ROLES COVERED</span><strong>{new Set(state.artifacts.map((artifact) => artifact.narrativeRole)).size}<small> of 4</small></strong></div><div><span className="eyebrow">FILTERED VIEW</span><strong>{selectedView?.kind === 'frozen' ? (frozenEvaluation?.entries.length ?? 0) : filtered.length}<small> showing</small></strong></div></div>

    <SavedViewsPanel liveViews={liveViews} frozenViews={frozenViews} artifacts={state.artifacts} selectedView={selectedView} selectedViewId={uiState.selectedViewId} onSelect={selectView} onBrowseAll={browseAll} onDelete={handleDeleteView} onSaveLive={() => openSaveModal('live')} onSaveFrozen={() => openSaveModal('frozen')} />

    <section className="toolbar"><div className={`search-box ${controlsLocked ? 'is-disabled' : ''}`}><Search size={17} /><input aria-label="Search collection" placeholder={controlsLocked ? 'Controls are locked for a frozen list' : 'Search title, maker, ID, or tag'} value={controls.query} disabled={controlsLocked} onChange={(event) => updateControl('query', event.target.value)} />{controls.query && !controlsLocked && <Button variant="ghost" icon={<X size={15} />} aria-label="Clear search" onClick={() => updateControl('query', '')} />}</div><Button variant={showFilters ? 'primary' : 'secondary'} icon={<SlidersHorizontal size={16} />} onClick={() => setShowFilters((value) => !value)}>Filters</Button><div className="toolbar-count"><Filter size={14} /> {selectedView?.kind === 'frozen' ? (frozenEvaluation?.entries.length ?? 0) : filtered.length} results</div></section>
    {showFilters && <section className="filter-drawer">
      <fieldset className="filter-group" disabled={controlsLocked}><legend className="eyebrow">NARRATIVE ROLE</legend><div className="chip-row">{roleOptions.map((role) => <label key={role} className={`filter-chip ${controls.roles.includes(role) ? 'selected' : ''}`}><input type="checkbox" checked={controls.roles.includes(role)} onChange={() => toggleControl('roles', role)} />{titleCase(role)}</label>)}</div></fieldset>
      <fieldset className="filter-group" disabled={controlsLocked}><legend className="eyebrow">SENSITIVITY</legend><div className="chip-row">{sensitivityOptions.map((option) => <label key={option} className={`filter-chip ${controls.sensitivities.includes(option) ? 'selected' : ''}`}><input type="checkbox" checked={controls.sensitivities.includes(option)} onChange={() => toggleControl('sensitivities', option)} />{titleCase(option)}</label>)}</div></fieldset>
      <label className={`check-field filter-check ${controlsLocked ? 'is-disabled' : ''}`}><input type="checkbox" checked={controls.keyOnly} disabled={controlsLocked} onChange={(event) => updateControl('keyOnly', event.target.checked)} /><span><strong>Key objects only</strong></span></label>
      <Button variant="ghost" onClick={clearScratch} disabled={controlsLocked}>Clear filters</Button>
    </section>}

    {selectedView?.kind === 'live' && <LiveViewBanner view={selectedView} members={liveMembers ?? []} isDirty={isDirty} onUpdate={handleReviseLive} onDiscard={handleDiscardEdits} onSaveFrozen={() => openSaveModal('frozen')} />}
    {selectedView?.kind === 'frozen' && frozenEvaluation && <FrozenViewBanner view={selectedView} evaluation={frozenEvaluation} onSaveLive={() => openSaveModal('live')} />}
    {!selectedView && <div className="view-mode-note"><Radio size={14} /> Browsing with unsaved filters — results follow the live collection. Save a live view or issue a frozen list from the panel above.</div>}

    {selectedView?.kind === 'frozen' && frozenEvaluation ? (
      <FrozenMemberList evaluation={frozenEvaluation} onEdit={(artifact) => setEditor({ draft: artifactToDraft(artifact), existing: artifact })} onRemove={(artifactId) => { if (window.confirm('Remove this object from the collection? The frozen list will keep its issued record and flag the member as missing.')) removeArtifact(artifactId); }} />
    ) : filtered.length === 0 ? (
      <EmptyState icon={<Search size={23} />} title="No matching objects" detail="Try a different search or clear the filters." />
    ) : (
      <div className="artifact-grid">{filtered.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} onEdit={() => setEditor({ draft: artifactToDraft(artifact), existing: artifact })} onRemove={() => { if (window.confirm(`Remove ${artifact.title} from the collection?`)) removeArtifact(artifact.id); }} />)}</div>
    )}

    {feedback && <div className="toast toast-positive">{feedback}</div>}
    {editor && <ArtifactEditor initial={editor.draft} existing={editor.existing} onClose={() => setEditor(null)} onSave={handleSaveArtifact} />}
    {saveModal && <Modal eyebrow="SAVE FILTER VIEW" title={saveModal.kind === 'frozen' ? 'Issue a frozen list' : 'Save a live view'} onClose={() => setSaveModal(null)} footer={<><Button variant="ghost" onClick={() => setSaveModal(null)}>Cancel</Button><Button variant="primary" icon={<Save size={15} />} onClick={submitSaveModal}>{saveModal.kind === 'frozen' ? 'Issue frozen list' : 'Save live view'}</Button></>}>
      <div className="form-grid">
        <TextField label="View name" value={saveModal.name} autoFocus onChange={(event) => { setSaveModal((current) => current ? { ...current, name: event.target.value } : current); setSaveError(null); }} error={saveError ?? undefined} placeholder={saveModal.kind === 'frozen' ? 'e.g. Loan pack — September review' : 'e.g. Low-light key objects'} />
        <div className={`save-kind-card ${saveModal.kind === 'frozen' ? 'kind-frozen' : 'kind-live'}`}>
          <div className="save-kind-head">{saveModal.kind === 'frozen' ? <Snowflake size={16} /> : <Radio size={16} />}<strong>{saveModal.kind === 'frozen' ? 'Frozen list' : 'Live view'}</strong></div>
          <p>{saveModal.kind === 'frozen'
            ? 'Membership is captured now with each object’s record. The list never re-runs; members are flagged if an object is deleted, changes role, or has its accession ID corrected.'
            : 'Membership is recomputed from the current collection every time. Editing the rules records a new version; prior versions and membership stay on record.'}</p>
          <small className="eyebrow">BASIS · {describeRulesBasis(saveModal.rules)}</small>
        </div>
      </div>
    </Modal>}
  </div>;
}

function SavedViewsPanel({ liveViews, frozenViews, artifacts, selectedView, selectedViewId, onSelect, onBrowseAll, onDelete, onSaveLive, onSaveFrozen }: {
  liveViews: CollectionView[];
  frozenViews: CollectionView[];
  artifacts: Artifact[];
  selectedView: CollectionView | null;
  selectedViewId: string | null;
  onSelect: (view: CollectionView) => void;
  onBrowseAll: () => void;
  onDelete: (view: CollectionView) => void;
  onSaveLive: () => void;
  onSaveFrozen: () => void;
}) {
  return <section className="saved-views" aria-label="Saved filter views">
    <div className="saved-views-head"><span className="eyebrow">SAVED FILTER VIEWS</span><div><Button variant="ghost" icon={<Radio size={14} />} onClick={onSaveLive}>Save live view</Button><Button variant="ghost" icon={<Snowflake size={14} />} onClick={onSaveFrozen}>Issue frozen list</Button></div></div>
    <div className="saved-view-groups">
      <div className="saved-view-group">
        <div className="saved-view-label"><Radio size={13} /> Live views <small>follow the collection</small></div>
        <div className="saved-view-row">
          <button type="button" className={`view-pill ${selectedViewId === null ? 'selected' : ''}`} onClick={onBrowseAll}>Unsaved filters</button>
          {liveViews.length === 0 && <span className="saved-view-empty">None saved yet.</span>}
          {liveViews.map((view) => {
            const version = latestRuleVersion(view);
            const currentCount = filterCollection(artifacts, version.rules).length;
            return <ViewPill key={view.id} icon={<Radio size={13} />} selected={selectedView?.id === view.id} name={view.name} meta={`v${version.version} · ${currentCount} now · ${version.memberIds.length} at v${version.version}`} onSelect={() => onSelect(view)} onDelete={() => onDelete(view)} deleteLabel="Delete live view" />;
          })}
        </div>
      </div>
      <div className="saved-view-group">
        <div className="saved-view-label"><Snowflake size={13} /> Frozen lists <small>issued, do not change</small></div>
        <div className="saved-view-row">
          {frozenViews.length === 0 && <span className="saved-view-empty">None issued yet.</span>}
          {frozenViews.map((view) => {
            const evaluation = evaluateFrozenView(view, artifacts);
            return <ViewPill key={view.id} icon={<Snowflake size={13} />} selected={selectedView?.id === view.id} name={view.name} warning={evaluation.isStale} meta={`${view.frozenMembers?.length ?? 0} issued ${formatDate(view.createdAt)}${evaluation.isStale ? ` · ${evaluation.changedCount + evaluation.missingCount} drifted` : ''}`} onSelect={() => onSelect(view)} onDelete={() => onDelete(view)} deleteLabel="Delete frozen list" />;
          })}
        </div>
      </div>
    </div>
  </section>;
}

function ViewPill({ icon, name, meta, selected, warning, onSelect, onDelete, deleteLabel }: {
  icon: React.ReactNode;
  name: string;
  meta: string;
  selected: boolean;
  warning?: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleteLabel: string;
}) {
  return <span className={`view-pill-wrap ${selected ? 'selected' : ''}`}>
    <button type="button" className={`view-pill ${selected ? 'selected' : ''} ${warning ? 'has-warning' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <span className="view-pill-icon">{icon}{warning && <AlertTriangle size={11} className="view-pill-warn" />}</span>
      <span className="view-pill-text"><strong>{name}</strong><small>{meta}</small></span>
    </button>
    {selected && <Button variant="ghost" icon={<Trash2 size={13} />} aria-label={deleteLabel} onClick={onDelete} />}
  </span>;
}

function LiveViewBanner({ view, members, isDirty, onUpdate, onDiscard, onSaveFrozen }: {
  view: CollectionView;
  members: Artifact[];
  isDirty: boolean;
  onUpdate: () => void;
  onDiscard: () => void;
  onSaveFrozen: () => void;
}) {
  const version = latestRuleVersion(view);
  return <section className={`view-banner live ${isDirty ? 'is-dirty' : ''}`}>
    <div className="view-banner-main"><Radio size={16} /><div><strong>Live view · {view.name}</strong><p>Rule version {version.version} — basis: {version.basis}. {members.length} object{members.length === 1 ? '' : 's'} currently match; results recompute when objects are added, removed, or edited.</p></div></div>
    <div className="view-banner-actions">
      {isDirty
        ? <><Badge tone="warning">Unsaved rule changes</Badge><Button variant="secondary" icon={<Save size={14} />} onClick={onUpdate}>Update saved view (v{version.version + 1})</Button><Button variant="ghost" onClick={onDiscard}>Discard</Button></>
        : <Button variant="ghost" icon={<Snowflake size={14} />} onClick={onSaveFrozen}>Issue current members as frozen list</Button>}
    </div>
  </section>;
}

function FrozenViewBanner({ view, evaluation, onSaveLive }: {
  view: CollectionView;
  evaluation: ReturnType<typeof evaluateFrozenView>;
  onSaveLive: () => void;
}) {
  const version = latestRuleVersion(view);
  return <section className={`view-banner frozen ${evaluation.isStale ? 'is-stale' : ''}`}>
    <div className="view-banner-main">{evaluation.isStale ? <AlertTriangle size={16} /> : <Archive size={16} />}<div><strong>Frozen list · {view.name}</strong><p>Issued {formatDate(view.createdAt)} — basis: {version.basis}. Membership is the issued record of {evaluation.entries.length} object{evaluation.entries.length === 1 ? '' : 's'} and does not change.</p></div></div>
    <div className="view-banner-actions">
      {evaluation.isStale
        ? <Badge tone="danger">Invalid · {evaluation.changedCount} changed, {evaluation.missingCount} missing</Badge>
        : <Badge tone="positive"><CheckCircle2 size={12} /> All members intact</Badge>}
      <Button variant="ghost" icon={<Radio size={14} />} onClick={onSaveLive}>Save current rules as live view</Button>
    </div>
  </section>;
}

function FrozenMemberList({ evaluation, onEdit, onRemove }: {
  evaluation: ReturnType<typeof evaluateFrozenView>;
  onEdit: (artifact: Artifact) => void;
  onRemove: (artifactId: string) => void;
}) {
  return <div className="frozen-members">
    {evaluation.isStale && <div className="drift-note" role="alert"><AlertTriangle size={15} />
      <span>This issued list no longer matches the collection: {evaluation.changedCount} member{evaluation.changedCount === 1 ? '' : 's'} changed and {evaluation.missingCount} {evaluation.missingCount === 1 ? 'was' : 'were'} deleted. The issued record below is retained as evidence; do not treat it as current data.</span>
    </div>}
    <div className="artifact-grid">{evaluation.entries.map((entry, index) => <FrozenMemberCard key={`${entry.snapshot.artifactId}-${index}`} entry={entry} onEdit={onEdit} onRemove={onRemove} />)}</div>
    {evaluation.addedArtifacts.length > 0 && <div className="added-match-note"><Radio size={14} /><span>{evaluation.addedArtifacts.length} object{evaluation.addedArtifacts.length === 1 ? '' : 's'} now match these rules but {evaluation.addedArtifacts.length === 1 ? 'was' : 'were'} not on the issued list. {evaluation.addedArtifacts.map((artifact) => artifact.title).join('; ')}.</span></div>}
  </div>;
}

function FrozenMemberCard({ entry, onEdit, onRemove }: { entry: FrozenMemberEntry; onEdit: (artifact: Artifact) => void; onRemove: (artifactId: string) => void }) {
  const { snapshot, current, state: memberState, changedFields } = entry;
  if (memberState === 'missing') {
    return <article className="artifact-card frozen-card frozen-missing"><div className="drift-badge-row"><Badge tone="danger"><AlertTriangle size={11} /> Missing · deleted</Badge></div><div className="artifact-id">{snapshot.accessionId}</div><h3>{snapshot.title}</h3><p className="artifact-summary">This object was deleted after the list was issued. The issued entry is retained.</p><div className="tag-row"><Badge tone="neutral">{titleCase(snapshot.narrativeRole)}</Badge><Badge tone="neutral">{titleCase(snapshot.sensitivity)}</Badge>{snapshot.isKeyObject && <Badge tone="neutral">Key object</Badge>}</div></article>;
  }
  if (!current) return null;
  return <article className={`artifact-card frozen-card ${memberState === 'changed' ? 'frozen-changed' : 'frozen-intact'}`}>
    <div className="artifact-card-top"><ArtifactGlyph color={current.color} size="large" /><div className="artifact-actions"><Button variant="ghost" onClick={() => onEdit(current)}>Edit</Button><Button variant="ghost" onClick={() => onRemove(current.id)}>Remove</Button></div></div>
    <div className="drift-badge-row">{memberState === 'changed'
      ? <Badge tone="warning"><AlertTriangle size={11} /> Changed · {changedFields.map((field) => FROZEN_MEMBER_FIELD_LABELS[field]).join(', ')}</Badge>
      : <Badge tone="positive"><CheckCircle2 size={11} /> Intact</Badge>}</div>
    <div className="artifact-id">{snapshot.accessionId}{snapshot.accessionId !== current.accessionId && <> → <strong className="drift-current">{current.accessionId}</strong></>}</div>
    <h3>{snapshot.title}{snapshot.title !== current.title && <> → <strong className="drift-current">{current.title}</strong></>}</h3>
    <p className="artifact-maker">{current.maker} · {current.yearLabel}</p>
    <p className="artifact-summary">{current.summary}</p>
    <div className="tag-row"><Badge tone={snapshot.narrativeRole === current.narrativeRole ? 'info' : 'warning'}>{titleCase(current.narrativeRole)}{snapshot.narrativeRole !== current.narrativeRole && <em> (issued: {titleCase(snapshot.narrativeRole)})</em>}</Badge><Badge tone={snapshot.sensitivity === current.sensitivity ? 'neutral' : 'warning'}>{titleCase(current.sensitivity)}</Badge>{current.isKeyObject && <Badge tone="danger">Key object</Badge>}</div>
    <div className="artifact-card-bottom"><span>{current.medium}</span><strong>{current.dwellMinutes} min dwell</strong></div>
  </article>;
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
