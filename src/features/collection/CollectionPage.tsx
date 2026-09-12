import { CheckSquare, Filter, Plus, Search, SlidersHorizontal, Square, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ArtifactGlyph } from '../../components/ArtifactGlyph';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Callout } from '../../components/Callout';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { SectionHeader } from '../../components/SectionHeader';
import { SelectField } from '../../components/SelectField';
import { TextField } from '../../components/TextField';
import { artifactToDraft, emptyArtifactDraft } from '../../domain/artifactValidation';
import { BATCH_FIELDS, type BatchItemResult, type BatchPatch, type BatchTransaction } from '../../domain/batchTransaction';
import { titleCase } from '../../domain/formatters';
import type { Artifact, ArtifactDraft, NarrativeRole, Sensitivity } from '../../domain/models';
import { useWorkspace, type BatchSubmitResult } from '../../state/WorkspaceContext';

const roleOptions: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const sensitivityOptions: Sensitivity[] = ['standard', 'low-light', 'fragile'];
const accessibilityOptions: ArtifactDraft['accessibilityNeed'][] = ['none', 'seating', 'audio', 'tactile-alternative'];

type BatchFormState = {
  narrativeRole: '' | NarrativeRole;
  sensitivity: '' | Sensitivity;
  accessibilityNeed: '' | ArtifactDraft['accessibilityNeed'];
  dwellMinutes: string;
  isKeyObject: '' | 'true' | 'false';
};

const emptyBatchForm: BatchFormState = {
  narrativeRole: '',
  sensitivity: '',
  accessibilityNeed: '',
  dwellMinutes: '',
  isKeyObject: '',
};

function formToPatch(form: BatchFormState): BatchPatch {
  const patch: BatchPatch = {};
  if (form.narrativeRole) patch.narrativeRole = form.narrativeRole;
  if (form.sensitivity) patch.sensitivity = form.sensitivity;
  if (form.accessibilityNeed) patch.accessibilityNeed = form.accessibilityNeed;
  if (form.dwellMinutes.trim() !== '') patch.dwellMinutes = Number(form.dwellMinutes);
  if (form.isKeyObject !== '') patch.isKeyObject = form.isKeyObject === 'true';
  return patch;
}

export function CollectionPage() {
  const { state, upsertArtifact, removeArtifact, prepareBatchEdit, commitBatchEdit } = useWorkspace();
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [sensitivityFilter, setSensitivityFilter] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [editor, setEditor] = useState<{ draft: ArtifactDraft; existing?: Artifact } | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batch, setBatch] = useState<{
    step: 'fields' | 'review' | 'conflicts';
    form: BatchFormState;
    transaction: BatchTransaction | null;
    issues: BatchItemResult[];
    formErrors: Record<string, string>;
    errorMessage: string | null;
  } | null>(null);

  const filtered = useMemo(() => state.artifacts.filter((artifact) => {
    const haystack = `${artifact.title} ${artifact.maker} ${artifact.accessionId} ${artifact.tags.join(' ')}`.toLowerCase();
    return haystack.includes(query.toLowerCase()) && (roleFilter === 'all' || artifact.narrativeRole === roleFilter) && (sensitivityFilter === 'all' || artifact.sensitivity === sensitivityFilter);
  }), [state.artifacts, query, roleFilter, sensitivityFilter]);

  const selectedArtifacts = useMemo(
    () => state.artifacts.filter((artifact) => selectedIds.includes(artifact.id)),
    [state.artifacts, selectedIds],
  );

  const flash = (message: string) => {
    setFeedback(message);
    window.setTimeout(() => setFeedback(null), 5000);
  };

  const handleSave = (draft: ArtifactDraft, existing?: Artifact) => {
    const result = upsertArtifact(draft, existing);
    if (!result.ok) return result;
    setEditor(null);
    flash(existing ? 'Object details updated.' : 'Object added to the collection.');
    return result;
  };

  const toggleSelect = (artifactId: string) => {
    setSelectedIds((current) => current.includes(artifactId) ? current.filter((id) => id !== artifactId) : [...current, artifactId]);
  };

  const openBatchEditor = () => {
    if (selectedIds.length === 0) return;
    setBatch({ step: 'fields', form: emptyBatchForm, transaction: null, issues: [], formErrors: {}, errorMessage: null });
  };

  const closeBatch = () => setBatch(null);

  const reviewBatch = (form: BatchFormState) => {
    const patch = formToPatch(form);
    if (Object.keys(patch).length === 0) {
      setBatch({ step: 'fields', form, transaction: null, issues: [], formErrors: { patch: 'Choose at least one field to change.' }, errorMessage: null });
      return;
    }
    const result = prepareBatchEdit(selectedIds.map((artifactId) => {
      const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
      return { artifactId, baseRevision: artifact?.updatedAt ?? '', patch };
    }));
    if (!result.ok) {
      setBatch({
        step: 'conflicts',
        form,
        transaction: null,
        issues: result.items,
        formErrors: result.errors ?? {},
        errorMessage: null,
      });
      return;
    }
    setBatch({ step: 'review', form, transaction: result.transaction, issues: [], formErrors: {}, errorMessage: null });
  };

  const submitBatch = (transaction: BatchTransaction) => {
    const result: BatchSubmitResult = commitBatchEdit(transaction);
    if (result.ok) {
      setBatch(null);
      setSelectedIds([]);
      setSelectMode(false);
      flash(result.duplicate
        ? `Batch ${result.transactionId.slice(0, 13)}… was already applied; no duplicate changes recorded.`
        : `Batch ${result.transactionId.slice(0, 13)}… committed ${result.applied} ${result.applied === 1 ? 'object' : 'objects'} atomically. Placement, finding, and readiness results stay consistent.`);
      return;
    }
    const safeCount = result.items.filter((item) => item.status === 'safe').length;
    setBatch((current) => current ? {
      ...current,
      step: 'conflicts',
      issues: result.items,
      errorMessage: result.duplicate
        ? 'This transaction was already applied.'
        : `Transaction rejected — no changes were saved. ${safeCount} of ${result.items.length} objects were still safe to apply.`,
    } : current);
  };

  const dropProblemItems = (issues: BatchItemResult[], form: BatchFormState) => {
    const blocked = new Set(issues.filter((item) => item.status !== 'safe').map((item) => item.artifactId));
    const remaining = selectedIds.filter((id) => !blocked.has(id));
    setSelectedIds(remaining);
    if (remaining.length === 0) {
      setBatch(null);
      return;
    }
    // Re-plan against the objects' *current* revisions: dropping the stale
    // item means the surviving transaction can be committed immediately.
    const patch = formToPatch(form);
    const result = prepareBatchEdit(remaining.map((artifactId) => {
      const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
      return { artifactId, baseRevision: artifact?.updatedAt ?? '', patch };
    }));
    if (result.ok) {
      setBatch({ step: 'review', form, transaction: result.transaction, issues: [], formErrors: {}, errorMessage: null });
    } else {
      setBatch({ step: 'conflicts', form, transaction: null, issues: result.items, formErrors: result.errors ?? {}, errorMessage: null });
    }
  };

  return <div className="page-stack"><SectionHeader eyebrow="OBJECT LIBRARY" title="Collection" description="Shape the cast of objects before you ask them to carry a story." actions={<><Button variant="secondary" icon={selectMode ? <X size={16} /> : <CheckSquare size={16} />} onClick={() => { setSelectMode((value) => !value); setSelectedIds([]); }}>{selectMode ? 'Exit selection' : 'Batch edit'}</Button><Button variant="primary" icon={<Plus size={17} />} onClick={() => setEditor({ draft: emptyArtifactDraft })}>Add object</Button></>} />
    <div className="summary-strip"><div><span className="eyebrow">COLLECTION SIZE</span><strong>{state.artifacts.length}<small> objects</small></strong></div><div><span className="eyebrow">KEY OBJECTS</span><strong>{state.artifacts.filter((artifact) => artifact.isKeyObject).length}<small> flagged</small></strong></div><div><span className="eyebrow">ROLES COVERED</span><strong>{new Set(state.artifacts.map((artifact) => artifact.narrativeRole)).size}<small> of 4</small></strong></div><div><span className="eyebrow">FILTERED VIEW</span><strong>{filtered.length}<small> showing</small></strong></div></div>
    <section className="toolbar"><div className="search-box"><Search size={17} /><input aria-label="Search collection" placeholder="Search title, maker, ID, or tag" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <Button variant="ghost" icon={<X size={15} />} aria-label="Clear search" onClick={() => setQuery('')} />}</div><Button variant={showFilters ? 'primary' : 'secondary'} icon={<SlidersHorizontal size={16} />} onClick={() => setShowFilters((value) => !value)}>Filters</Button><div className="toolbar-count"><Filter size={14} /> {filtered.length} results</div></section>
    {showFilters && <section className="filter-drawer"><SelectField label="Narrative role" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">All roles</option>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField><SelectField label="Sensitivity" value={sensitivityFilter} onChange={(event) => setSensitivityFilter(event.target.value)}><option value="all">All sensitivities</option>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField><Button variant="ghost" onClick={() => { setRoleFilter('all'); setSensitivityFilter('all'); }}>Clear filters</Button></section>}
    {selectMode && <section className="batch-bar" data-testid="batch-bar"><div className="batch-bar-info"><strong>{selectedIds.length} selected</strong><span>Objects are locked to the revision you see now until the transaction is confirmed.</span></div><div className="batch-bar-actions"><Button variant="ghost" onClick={() => setSelectedIds(filtered.map((artifact) => artifact.id))}>Select all shown</Button><Button variant="ghost" onClick={() => setSelectedIds([])}>Clear</Button><Button variant="primary" disabled={selectedIds.length === 0} onClick={openBatchEditor}>Review {selectedIds.length || ''} changes</Button></div></section>}
    {filtered.length === 0 ? <EmptyState icon={<Search size={23} />} title="No matching objects" detail="Try a different search or clear the filters." /> : <div className="artifact-grid">{filtered.map((artifact) => <ArtifactCard key={artifact.id} artifact={artifact} selectable={selectMode} selected={selectedIds.includes(artifact.id)} onToggle={() => toggleSelect(artifact.id)} onEdit={() => setEditor({ draft: artifactToDraft(artifact), existing: artifact })} onRemove={() => { if (window.confirm(`Remove ${artifact.title} from the collection?`)) removeArtifact(artifact.id); }} />)}</div>}
    {feedback && <div className="toast toast-positive">{feedback}</div>}
    {editor && <ArtifactEditor initial={editor.draft} existing={editor.existing} onClose={() => setEditor(null)} onSave={handleSave} />}
    {batch && <BatchEditModal
      step={batch.step}
      form={batch.form}
      issues={batch.issues}
      formErrors={batch.formErrors}
      errorMessage={batch.errorMessage}
      transaction={batch.transaction}
      artifacts={selectedArtifacts}
      onClose={closeBatch}
      onReview={reviewBatch}
      onSubmit={submitBatch}
      onContinue={(issues) => dropProblemItems(issues, batch.form)}
    />}
  </div>;
}

function ArtifactCard({ artifact, selectable, selected, onToggle, onEdit, onRemove }: { artifact: Artifact; selectable: boolean; selected: boolean; onToggle: () => void; onEdit: () => void; onRemove: () => void }) {
  return <article className={`artifact-card${selected ? ' artifact-card-selected' : ''}`}>{selectable && <label className="card-select"><input type="checkbox" aria-label={`Select ${artifact.title}`} checked={selected} onChange={onToggle} />{selected ? <CheckSquare size={19} /> : <Square size={19} />}</label>}<div className="artifact-card-top"><ArtifactGlyph color={artifact.color} size="large" /><div className="artifact-actions">{!selectable && <><Button variant="ghost" onClick={onEdit}>Edit</Button><Button variant="ghost" onClick={onRemove}>Remove</Button></>}</div></div><div className="artifact-id">{artifact.accessionId}</div><h3>{artifact.title}</h3><p className="artifact-maker">{artifact.maker} · {artifact.yearLabel}</p><p className="artifact-summary">{artifact.summary}</p><div className="tag-row"><Badge tone="info">{titleCase(artifact.narrativeRole)}</Badge><Badge tone={artifact.sensitivity === 'low-light' ? 'warning' : 'neutral'}>{titleCase(artifact.sensitivity)}</Badge>{artifact.isKeyObject && <Badge tone="danger">Key object</Badge>}</div><div className="artifact-card-bottom"><span>{artifact.medium}</span><strong>{artifact.dwellMinutes} min dwell</strong></div></article>;
}

function ArtifactEditor({ initial, existing, onClose, onSave }: { initial: ArtifactDraft; existing?: Artifact; onClose: () => void; onSave: (draft: ArtifactDraft, existing?: Artifact) => { ok: boolean; errors?: Record<string, string> } }) {
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = <K extends keyof ArtifactDraft>(key: K, value: ArtifactDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = () => { const result = onSave(draft, existing); if (!result.ok) setErrors(result.errors ?? {}); };
  return <Modal eyebrow={existing ? 'EDIT OBJECT' : 'NEW OBJECT'} title={existing ? 'Update object record' : 'Add to collection'} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>{existing ? 'Save changes' : 'Add object'}</Button></>}><div className="form-grid"><TextField label="Accession ID" value={draft.accessionId} onChange={(event) => update('accessionId', event.target.value)} error={errors.accessionId} placeholder="AF-2027-001" /><TextField label="Title" value={draft.title} onChange={(event) => update('title', event.target.value)} error={errors.title} placeholder="Object title" /><TextField label="Maker / source" value={draft.maker} onChange={(event) => update('maker', event.target.value)} error={errors.maker} /><TextField label="Date / period" value={draft.yearLabel} onChange={(event) => update('yearLabel', event.target.value)} /><TextField label="Medium" value={draft.medium} onChange={(event) => update('medium', event.target.value)} error={errors.medium} /><TextField label="Origin" value={draft.origin} onChange={(event) => update('origin', event.target.value)} /><TextField label="Width (cm)" type="number" min="0" step="0.1" value={draft.width} onChange={(event) => update('width', event.target.value)} error={errors.width} /><TextField label="Height (cm)" type="number" min="0" step="0.1" value={draft.height} onChange={(event) => update('height', event.target.value)} error={errors.height} /><TextField label="Depth (cm)" type="number" min="0" step="0.1" value={draft.depth} onChange={(event) => update('depth', event.target.value)} error={errors.depth} /><TextField label="Dwell time (min)" type="number" min="1" max="30" value={draft.dwellMinutes} onChange={(event) => update('dwellMinutes', event.target.value)} error={errors.dwellMinutes} /><SelectField label="Narrative role" value={draft.narrativeRole} onChange={(event) => update('narrativeRole', event.target.value as NarrativeRole)}>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField><SelectField label="Sensitivity" value={draft.sensitivity} onChange={(event) => update('sensitivity', event.target.value as Sensitivity)}>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField><SelectField label="Accessibility need" value={draft.accessibilityNeed} onChange={(event) => update('accessibilityNeed', event.target.value as ArtifactDraft['accessibilityNeed'])}><option value="none">None noted</option><option value="seating">Seated interpretation</option><option value="audio">Audio interpretation</option><option value="tactile-alternative">Tactile alternative</option></SelectField><TextField label="Tags" value={draft.tags} onChange={(event) => update('tags', event.target.value)} hint="Comma-separated, up to 8" /><TextField label="Object summary" textarea rows={4} value={draft.summary} onChange={(event) => update('summary', event.target.value)} error={errors.summary} hint="Describe why this object matters in the exhibition." /><label className="check-field"><input type="checkbox" checked={draft.isKeyObject} onChange={(event) => update('isKeyObject', event.target.checked)} /><span><strong>Key object</strong><small>Must be placed before readiness can pass.</small></span></label></div></Modal>;
}

const fieldLabels: Record<string, string> = {
  narrativeRole: 'Narrative role',
  sensitivity: 'Sensitivity',
  accessibilityNeed: 'Accessibility need',
  dwellMinutes: 'Dwell time',
  isKeyObject: 'Key object',
};

function formatValue(field: string, value: unknown): string {
  if (field === 'isKeyObject') return value ? 'Key object' : 'Not key';
  if (field === 'dwellMinutes') return `${value} min`;
  return titleCase(String(value));
}

function BatchEditModal({
  step,
  form,
  issues,
  formErrors,
  errorMessage,
  transaction,
  artifacts,
  onClose,
  onReview,
  onSubmit,
  onContinue,
}: {
  step: 'fields' | 'review' | 'conflicts';
  form: BatchFormState;
  issues: BatchItemResult[];
  formErrors: Record<string, string>;
  errorMessage: string | null;
  transaction: BatchTransaction | null;
  artifacts: Artifact[];
  onClose: () => void;
  onReview: (form: BatchFormState) => void;
  onSubmit: (transaction: BatchTransaction) => void;
  onContinue: (issues: BatchItemResult[]) => void;
}) {
  const [draft, setDraft] = useState(form);
  const update = <K extends keyof BatchFormState>(key: K, value: BatchFormState[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const patch = formToPatch(draft);
  const patchFields = BATCH_FIELDS.filter((field) => patch[field] !== undefined);

  return <Modal eyebrow="BATCH TRANSACTION" title={step === 'fields' ? `Edit ${artifacts.length} objects` : step === 'review' ? 'Confirm field differences' : 'Resolve conflicts before commit'} onClose={onClose} footer={step === 'fields'
    ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onReview(draft)}>Review differences</Button></>
    : step === 'review' && transaction
      ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => onSubmit(transaction)}>Commit {transaction.items.length} changes atomically</Button></>
      : <><Button variant="ghost" onClick={onClose}>Cancel transaction</Button>{issues.some((issue) => issue.status === 'safe') && <Button variant="primary" onClick={() => onContinue(issues)}>Continue with safe objects only</Button>}</>}
  >
    {step === 'fields' && <div className="form-grid">
      <Callout tone="info" title="One patch, applied as a transaction">Leave a field on “Keep current” to leave it untouched. Every selected object is re-checked at commit; if any record changed or fails validation, the entire batch is rejected.</Callout>
      <SelectField label="Narrative role" value={draft.narrativeRole} onChange={(event) => update('narrativeRole', event.target.value as BatchFormState['narrativeRole'])}><option value="">Keep current</option>{roleOptions.map((role) => <option key={role} value={role}>{titleCase(role)}</option>)}</SelectField>
      <SelectField label="Sensitivity" value={draft.sensitivity} onChange={(event) => update('sensitivity', event.target.value as BatchFormState['sensitivity'])}><option value="">Keep current</option>{sensitivityOptions.map((option) => <option key={option} value={option}>{titleCase(option)}</option>)}</SelectField>
      <SelectField label="Accessibility need" value={draft.accessibilityNeed} onChange={(event) => update('accessibilityNeed', event.target.value as BatchFormState['accessibilityNeed'])}><option value="">Keep current</option>{accessibilityOptions.map((option) => <option key={option} value={option}>{option === 'none' ? 'None noted' : titleCase(option)}</option>)}</SelectField>
      <TextField label="Dwell time (min)" type="number" min="1" max="30" value={draft.dwellMinutes} onChange={(event) => update('dwellMinutes', event.target.value)} hint="Blank keeps each object's dwell time." error={formErrors.dwellMinutes} />
      <SelectField label="Key object" value={draft.isKeyObject} onChange={(event) => update('isKeyObject', event.target.value as BatchFormState['isKeyObject'])}><option value="">Keep current</option><option value="true">Mark as key object</option><option value="false">Clear key object</option></SelectField>
      {formErrors.patch && <p className="field-error" role="alert" style={{ gridColumn: '1 / -1' }}>{formErrors.patch}</p>}
      <div className="batch-target-list"><span className="eyebrow">TARGETS ({artifacts.length})</span><ul>{artifacts.map((artifact) => <li key={artifact.id}>{artifact.accessionId} · {artifact.title}</li>)}</ul></div>
    </div>}
    {step === 'review' && transaction && <div className="batch-review">
      <Callout tone="success" title={`${transaction.items.length} objects ready, one shared revision`}>
        All targets passed validation against their reviewed revision. On commit each changed object receives the same <code>updatedAt</code> stamp, the audit record {transaction.id} is written, placements and findings stay linked, and a ready project returns to review. Repeating this commit never applies twice.
      </Callout>
      <div className="batch-diff-table">
        <table>
          <thead><tr><th>Object</th>{patchFields.map((field) => <th key={field}>{fieldLabels[field]}</th>)}</tr></thead>
          <tbody>
            {transaction.items.map((item) => {
              const artifact = artifacts.find((candidate) => candidate.id === item.artifactId);
              return <tr key={item.artifactId}><td><strong>{artifact?.title ?? item.artifactId}</strong><small>{artifact?.accessionId}</small></td>
                {patchFields.map((field) => {
                  const change = item.changes.find((entry) => entry.field === field);
                  return <td key={field}>{change
                    ? <span className="diff-change"><del>{formatValue(field, change.from)}</del> → <ins>{formatValue(field, change.to)}</ins></span>
                    : <span className="diff-same">{artifact ? formatValue(field, artifact[field as keyof Artifact] as unknown) : '—'}</span>}</td>;
                })}
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>}
    {step === 'conflicts' && <div className="batch-conflicts">
      {errorMessage && <Callout tone="danger" title={errorMessage}><span /></Callout>}
      {formErrors && Object.entries(formErrors).length > 0 && <Callout tone="danger" title="Illegal batch request"><ul>{Object.entries(formErrors).map(([field, message]) => <li key={field}>{message}</li>)}</ul></Callout>}
      {issues.length > 0 && <>
        <p className="eyebrow">SUBMIT-TIME RE-READ ({issues.length} OBJECTS)</p>
        <ul className="conflict-list">
          {issues.map((issue) => <li key={issue.artifactId} className={`conflict-row conflict-${issue.status}`}>
            <div><Badge tone={issue.status === 'safe' ? 'info' : issue.status === 'invalid' ? 'danger' : 'warning'}>{issue.status}</Badge><strong>{issue.title ?? issue.artifactId}</strong>{issue.accessionId && <small> {issue.accessionId}</small>}</div>
            <p>{issue.detail}</p>
            {issue.errors.length > 0 && <ul className="conflict-errors">{issue.errors.map((error) => <li key={error.field}>{fieldLabels[error.field] ?? error.field}: {error.message}</li>)}</ul>}
          </li>)}
        </ul>
      </>}
    </div>}
  </Modal>;
}
