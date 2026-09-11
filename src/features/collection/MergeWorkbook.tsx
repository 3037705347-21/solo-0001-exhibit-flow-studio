import { AlertTriangle, CheckCircle2, Copy, FileUp, GitMerge, Layers, Link2Off, Search, XCircle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import {
  getMergePlanStatus,
  parseMergePayload,
  resolveArtifactField,
  resolveFindingField,
  setArtifactDecision,
  setArtifactEntryResolution,
  setFindingDecision,
  setFindingEntryResolution,
  type FieldConflict,
  type ArtifactMergeEntry,
  type FindingMergeEntry,
  type MergePlan,
} from '../../domain/merge';
import { useWorkspace } from '../../state/WorkspaceContext';

type WorkbookStage = 'import' | 'review';

export function MergeWorkbook({ onClose, onCommitted }: { onClose: () => void; onCommitted: (summary: string) => void }) {
  const { planMerge, commitMerge } = useWorkspace();
  const [stage, setStage] = useState<WorkbookStage>('import');
  const [rawText, setRawText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const status = useMemo(() => (plan ? getMergePlanStatus(plan) : null), [plan]);

  const ingest = (text: string) => {
    const parsed = parseMergePayload(text);
    if ('error' in parsed) {
      setParseError(parsed.error);
      return;
    }
    const nextPlan = planMerge(parsed.payload);
    setPlan(nextPlan);
    setParseWarnings([...parsed.warnings, ...nextPlan.parseErrors]);
    setParseError(null);
    setStage('review');
  };

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => ingest(String(reader.result ?? ''));
    reader.onerror = () => setParseError('The file could not be read.');
    reader.readAsText(file);
  };

  const commit = () => {
    if (!plan) return;
    const result = commitMerge(plan);
    if (!result.ok) {
      setCommitError(result.message ?? 'Resolve every conflict before committing.');
      return;
    }
    onCommitted('Merge committed: references and readiness state are intact.');
  };

  return <Modal
    eyebrow="COLLECTION RECONCILIATION"
    title="Merge another workspace"
    onClose={onClose}
    footer={stage === 'import'
      ? <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Search size={15} />} onClick={() => ingest(rawText)} disabled={!rawText.trim()}>Preview reconciliation</Button></>
      : <><Button variant="ghost" onClick={() => setStage('import')}>Choose different file</Button>
        <Button variant="primary" icon={<GitMerge size={15} />} onClick={commit} disabled={!status?.ready}>
          Commit merge
        </Button></>}
  >
    {stage === 'import' && <div className="merge-import">
      <p className="merge-intro">Paste workspace JSON or choose an exported file. Objects are matched by accession ID and findings by title plus their linked object or zone — existing IDs, placements, and findings are never replaced blindly.</p>
      <div className="merge-drop" role="button" tabIndex={0} onClick={() => fileInputRef.current?.click()}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInputRef.current?.click(); }}>
        <FileUp size={22} />
        <div><strong>Choose a workspace or snapshot file</strong><small>Or paste JSON below — nothing is committed until you confirm.</small></div>
      </div>
      <input ref={fileInputRef} type="file" accept="application/json,.json" hidden
        onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); }} />
      <label className="field"><span className="field-label">Incoming JSON</span>
        <textarea rows={8} value={rawText} onChange={(event) => setRawText(event.target.value)}
          placeholder='{"artifacts": [{ "accessionId": "AF-1908-014", "title": "…" }], "findings": []}' />
      </label>
      {parseError && <div className="merge-banner merge-banner-danger"><XCircle size={15} /><span>{parseError}</span></div>}
    </div>}

    {stage === 'review' && plan && status && <div className="merge-review">
      <div className="merge-status-row">
        <Badge tone={status.newArtifacts ? 'info' : 'neutral'}>{status.newArtifacts} new object{status.newArtifacts === 1 ? '' : 's'}</Badge>
        <Badge tone={status.conflictingArtifacts ? 'warning' : 'positive'}>{status.conflictingArtifacts} object conflict{status.conflictingArtifacts === 1 ? '' : 's'}</Badge>
        <Badge tone={status.newFindings ? 'info' : 'neutral'}>{status.newFindings} new finding{status.newFindings === 1 ? '' : 's'}</Badge>
        <Badge tone={status.conflictingFindings + status.referenceConflicts ? 'danger' : 'positive'}>
          {status.conflictingFindings + status.referenceConflicts} finding conflict{status.conflictingFindings + status.referenceConflicts === 1 ? '' : 's'}
        </Badge>
        <Badge tone="neutral">{status.identical} identical</Badge>
      </div>

      {!status.ready && <div className="merge-banner merge-banner-warning">
        <AlertTriangle size={15} />
        <span>{status.unresolvedArtifactConflicts + status.unresolvedFindingConflicts + status.unresolvedReferenceConflicts + status.unresolvedOrphans} record{(status.unresolvedArtifactConflicts + status.unresolvedFindingConflicts + status.unresolvedReferenceConflicts + status.unresolvedOrphans) === 1 ? '' : 's'} still need a decision. The merge cannot be committed yet.</span>
      </div>}
      {status.ready && <div className="merge-banner merge-banner-ok">
        <CheckCircle2 size={15} /><span>Every record is settled. Committing updates objects and findings in one atomic step.</span>
      </div>}
      {parseWarnings.length > 0 && <div className="merge-banner merge-banner-warning">
        <AlertTriangle size={15} /><span>{parseWarnings[0]}{parseWarnings.length > 1 ? ` (+${parseWarnings.length - 1} more note${parseWarnings.length - 1 === 1 ? '' : 's'})` : ''}</span>
      </div>}
      {commitError && <div className="merge-banner merge-banner-danger"><XCircle size={15} /><span>{commitError}</span></div>}

      <section className="merge-section">
        <div className="merge-section-head"><Layers size={14} /><h3>Objects</h3></div>
        {plan.artifactEntries.length === 0 && <p className="merge-empty">No objects in the incoming file.</p>}
        {plan.artifactEntries.map((entry) => <ArtifactRow key={entry.key} entry={entry}
          onField={(field, resolution) => setPlan((current) => current ? resolveArtifactField(current, entry.key, field, resolution) : current)}
          onDecision={(decision) => setPlan((current) => current ? setArtifactDecision(current, entry.key, decision) : current)}
          onSkip={(resolution) => setPlan((current) => current ? setArtifactEntryResolution(current, entry.key, resolution) : current)} />)}
      </section>

      {plan.findingEntries.length > 0 && <section className="merge-section">
        <div className="merge-section-head"><GitMerge size={14} /><h3>Findings</h3></div>
        {plan.findingEntries.map((entry) => <FindingRow key={entry.key} entry={entry}
          onField={(label, resolution) => setPlan((current) => current ? resolveFindingField(current, entry.key, label, resolution) : current)}
          onDecision={(decision) => setPlan((current) => current ? setFindingDecision(current, entry.key, decision) : current)}
          onResolve={(resolution) => setPlan((current) => current ? setFindingEntryResolution(current, entry.key, resolution) : current)} />)}
      </section>}
    </div>}
  </Modal>;
}

function EntryHeader({ accessionId, badge, decided }: { accessionId: string; badge: { tone: 'positive' | 'warning' | 'info' | 'neutral' | 'danger'; label: string }; decided?: boolean }) {
  return <div className="merge-entry-head">
    <code>{accessionId}</code>
    <Badge tone={badge.tone}>{badge.label}</Badge>
    {decided && <Badge tone="positive"><Copy size={10} /> settled</Badge>}
  </div>;
}

function ArtifactRow({ entry, onField, onDecision, onSkip }: {
  entry: ArtifactMergeEntry;
  onField: (field: FieldConflict['field'], resolution: 'current' | 'incoming') => void;
  onDecision: (decision: 'keep-current' | 'take-incoming' | 'accept-merged') => void;
  onSkip: (resolution: 'import' | 'skip') => void;
}) {
  const unresolved = entry.kind === 'conflict' && (entry.fields.some((field) => !field.decided) || !entry.decision);
  if (entry.kind === 'new') {
    const skipped = entry.entryResolution === 'skip';
    return <article className="merge-entry merge-entry-new">
      <EntryHeader accessionId={entry.accessionId} badge={{ tone: skipped ? 'neutral' : 'info', label: skipped ? 'Skipped' : 'New object' }} />
      <p className="merge-new-title">{entry.merged?.title}</p>
      <div className="merge-entry-actions">
        <Button variant={skipped ? 'secondary' : 'ghost'} onClick={() => onSkip(skipped ? 'import' : 'skip')}>{skipped ? 'Add instead' : 'Skip object'}</Button>
      </div>
    </article>;
  }
  if (entry.kind === 'identical') {
    return <article className="merge-entry merge-entry-identical">
      <EntryHeader accessionId={entry.accessionId} badge={{ tone: 'positive', label: 'Identical' }} />
      <p className="merge-new-title">{entry.current?.title}</p>
    </article>;
  }
  return <article className={`merge-entry merge-entry-conflict${unresolved ? ' is-unresolved' : ''}`}>
    <EntryHeader accessionId={entry.accessionId} badge={{ tone: unresolved ? 'warning' : 'positive', label: unresolved ? 'Field conflict' : 'Settled' }} decided={!unresolved} />
    <div className="merge-field-list">
      <div className="merge-column-head"><span>Field</span><span>Current record</span><span>Incoming record</span><span>Merged result</span></div>
      {entry.fields.map((field) => <FieldRow key={field.field} conflict={field}
        onChange={(resolution) => onField(field.field, resolution)} />)}
    </div>
    <div className="merge-entry-actions">
      <Button variant="secondary" onClick={() => onDecision('keep-current')}>Keep current record</Button>
      <Button variant="secondary" onClick={() => onDecision('take-incoming')}>Take incoming record</Button>
      <Button variant="primary" disabled={entry.fields.some((field) => !field.decided)} onClick={() => onDecision('accept-merged')}>
        Accept merged result
      </Button>
    </div>
  </article>;
}

function FieldRow({ conflict, onChange }: { conflict: FieldConflict; onChange: (resolution: 'current' | 'incoming') => void }) {
  return <div className={`merge-field-row ${conflict.decided ? `is-${conflict.resolution}` : 'is-open'}`}>
    <span className="merge-field-label">{conflict.label}</span>
    <button type="button" className={`merge-cell merge-cell-current ${conflict.decided && conflict.resolution === 'current' ? 'is-chosen' : ''}`}
      onClick={() => onChange('current')}><span>{conflict.current}</span></button>
    <button type="button" className={`merge-cell merge-cell-incoming ${conflict.decided && conflict.resolution === 'incoming' ? 'is-chosen' : ''}`}
      onClick={() => onChange('incoming')}><span>{conflict.incoming}</span></button>
    <div className="merge-cell merge-cell-merged"><span>{conflict.resolution === 'incoming' ? conflict.incoming : conflict.current}</span></div>
  </div>;
}

function FindingRow({ entry, onField, onDecision, onResolve }: {
  entry: FindingMergeEntry;
  onField: (label: string, resolution: 'current' | 'incoming') => void;
  onDecision: (decision: 'keep-current' | 'take-incoming' | 'accept-merged') => void;
  onResolve: (resolution: 'import' | 'drop-link' | 'skip') => void;
}) {
  if (entry.kind === 'new') {
    const skipped = entry.entryResolution === 'skip';
    return <article className="merge-entry merge-entry-new">
      <EntryHeader accessionId={entry.incomingNormalized?.title ?? 'Untitled'} badge={{ tone: skipped ? 'neutral' : 'info', label: skipped ? 'Skipped' : 'New finding' }} />
      <p className="merge-ref-line">{entry.detail}{entry.targetAccessionId && <> · object <code>{entry.targetAccessionId}</code></>}</p>
      <div className="merge-entry-actions">
        <Button variant={skipped ? 'secondary' : 'ghost'} onClick={() => onResolve(skipped ? 'import' : 'skip')}>{skipped ? 'Add instead' : 'Skip finding'}</Button>
      </div>
    </article>;
  }
  if (entry.kind === 'identical') {
    return <article className="merge-entry merge-entry-identical">
      <EntryHeader accessionId={entry.current?.title ?? ''} badge={{ tone: 'positive', label: 'Identical' }} />
    </article>;
  }
  if (entry.kind === 'reference-conflict' || entry.kind === 'orphan') {
    const resolution = entry.entryResolution;
    const unresolved = !resolution;
    return <article className={`merge-entry merge-entry-ref ${unresolved ? 'is-unresolved' : ''}`}>
      <EntryHeader accessionId={entry.incomingNormalized?.title ?? 'Untitled'}
        badge={{ tone: unresolved ? 'danger' : 'positive', label: entry.kind === 'orphan' ? 'Unreadable record' : 'Reference conflict' }} />
      <p className="merge-ref-line"><Link2Off size={13} /> {entry.detail}</p>
      <div className="merge-entry-actions">
        {entry.kind === 'reference-conflict' && <Button variant={resolution === 'drop-link' ? 'primary' : 'secondary'} onClick={() => onResolve('drop-link')}>Import without link</Button>}
        <Button variant={resolution === 'skip' ? 'primary' : 'secondary'} onClick={() => onResolve('skip')}>Skip finding</Button>
        {entry.kind === 'reference-conflict' && resolution && <Button variant="ghost" onClick={() => onResolve('import')}>Undo decision</Button>}
      </div>
    </article>;
  }

  const unresolved = entry.fieldConflicts.some((field) => !field.decided) || !entry.decision;
  return <article className={`merge-entry merge-entry-conflict${unresolved ? ' is-unresolved' : ''}`}>
    <EntryHeader accessionId={entry.current?.title ?? ''} badge={{ tone: unresolved ? 'warning' : 'positive', label: unresolved ? 'Field conflict' : 'Settled' }} decided={!unresolved} />
    <p className="merge-ref-line">{entry.detail}</p>
    <div className="merge-field-list">
      <div className="merge-column-head"><span>Field</span><span>Current record</span><span>Incoming record</span><span>Merged result</span></div>
      {entry.fieldConflicts.map((field) => <div key={field.label} className={`merge-field-row ${field.decided ? `is-${field.resolution}` : 'is-open'}`}>
        <span className="merge-field-label">{field.label}</span>
        <button type="button" className={`merge-cell merge-cell-current ${field.decided && field.resolution === 'current' ? 'is-chosen' : ''}`}
          onClick={() => onField(field.label, 'current')}><span>{field.current}</span></button>
        <button type="button" className={`merge-cell merge-cell-incoming ${field.decided && field.resolution === 'incoming' ? 'is-chosen' : ''}`}
          onClick={() => onField(field.label, 'incoming')}><span>{field.incoming}</span></button>
        <div className="merge-cell merge-cell-merged"><span>{field.resolution === 'incoming' ? field.incoming : field.current}</span></div>
      </div>)}
    </div>
    <div className="merge-entry-actions">
      <Button variant="secondary" onClick={() => onDecision('keep-current')}>Keep current</Button>
      <Button variant="secondary" onClick={() => onDecision('take-incoming')}>Take incoming</Button>
      <Button variant="primary" disabled={entry.fieldConflicts.some((field) => !field.decided)} onClick={() => onDecision('accept-merged')}>Accept merged result</Button>
    </div>
  </article>;
}
