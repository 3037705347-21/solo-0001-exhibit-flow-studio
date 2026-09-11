import { Archive as ArchiveIcon, ArrowRight, CopyPlus, FileArchive, FileJson2, FileWarning, GitCompare, History, RefreshCcw, SearchX, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Modal } from '../../components/Modal';
import { SectionHeader } from '../../components/SectionHeader';
import {
  archiveExportFileName,
  entryHashSuffix,
  groupArchiveLineages,
  shortHash,
  sortLineages,
  type ArchiveEntry,
  type ArchiveLineage,
  type ArchiveSortMode,
} from '../../domain/archive';
import { downloadTextFile, serializeSnapshot } from '../../domain/export';
import { formatDate, formatMinutes } from '../../domain/formatters';
import { loadArchiveSort, saveArchiveSort } from '../../state/persistence';
import { useWorkspace } from '../../state/WorkspaceContext';

const SORT_OPTIONS: Array<{ mode: ArchiveSortMode; label: string }> = [
  { mode: 'recent', label: 'Recently archived' },
  { mode: 'title', label: 'Plan title A–Z' },
];

export function ArchivePage() {
  const { archiveEntries, importArchiveFile, removeArchive } = useWorkspace();
  const [sortMode, setSortMode] = useState<ArchiveSortMode>(() => loadArchiveSort());
  const [toast, setToast] = useState<{ tone: 'positive' | 'warning'; message: string } | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { saveArchiveSort(sortMode); }, [sortMode]);
  const notify = (tone: 'positive' | 'warning', message: string) => {
    setToast({ tone, message });
    window.setTimeout(() => setToast(null), 3200);
  };

  const lineages = useMemo(
    () => sortLineages(groupArchiveLineages(archiveEntries), sortMode),
    [archiveEntries, sortMode],
  );
  const openEntryId = searchParams.get('entry');
  const openEntry = openEntryId ? archiveEntries.find((entry) => entry.id === openEntryId) : undefined;
  const entryById = useMemo(
    () => new Map(archiveEntries.map((entry) => [entry.id, entry])),
    [archiveEntries],
  );

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    const raw = await file.text();
    const result = importArchiveFile(raw, file.name);
    if (!result.ok || !result.value) { notify('warning', result.message ?? 'The snapshot could not be read.'); return; }
    const { outcome, entry } = result.value;
    if (outcome === 'duplicate') {
      notify('positive', `Already archived — same content (${shortHash(entry.contentHash)}), regardless of file name or export time.`);
    } else if (outcome === 'new-version') {
      const replaced = result.value.supersededEntry;
      notify('positive', replaced
        ? `Archived as v${entry.version}, replacing v${replaced.version} of “${entry.projectTitle}”.`
        : `Restored v${entry.version} of “${entry.projectTitle}” from its snapshot content.`);
    } else {
      notify('positive', `Archived “${entry.projectTitle}” as the first version.`);
    }
  };

  const reopen = (entry: ArchiveEntry) => {
    const next = new URLSearchParams(searchParams);
    next.set('entry', entry.id);
    setSearchParams(next, { replace: true });
  };
  const closeDetail = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('entry');
    setSearchParams(next, { replace: true });
  };

  const exportEntry = (entry: ArchiveEntry) => {
    downloadTextFile(serializeSnapshot(entry.snapshot), archiveExportFileName(entry));
    notify('positive', 'Snapshot re-exported with its original export date.');
  };

  const confirmEntry = confirmId ? entryById.get(confirmId) : undefined;

  return <div className="page-stack">
    <SectionHeader
      eyebrow="PLAN HISTORY"
      title="Plan archive"
      description="Snapshots are identified by their plan content, not the file name. Re-importing the same file — even under a different name or with a changed export time — returns the existing archive; changing business fields adds a version that shows what it replaces. Archiving never alters the live workspace."
      actions={<div className="header-button-row">
        <Button variant="primary" icon={<Upload size={16} />} onClick={() => fileInputRef.current?.click()}>Import snapshot</Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="archive-file-input"
          data-testid="archive-file-input"
          onChange={(event) => { void handleFiles(event.target.files); event.target.value = ''; }}
        />
      </div>}
    />

    <div className="archive-toolbar">
      <div className="segmented-control" role="group" aria-label="Archive sort order">
        {SORT_OPTIONS.map(({ mode, label }) =>
          <button key={mode} className={sortMode === mode ? 'selected' : ''} aria-pressed={sortMode === mode} onClick={() => setSortMode(mode)}>{label}</button>)}
      </div>
      <span className="review-hint"><History size={14} /> {archiveEntries.length} archived version{archiveEntries.length === 1 ? '' : 's'} across {lineages.length} plan{lineages.length === 1 ? '' : 's'} · order is stable on reload</span>
    </div>

    {lineages.length === 0 && <EmptyState
      icon={<FileArchive size={26} />}
      title="No archived plans yet"
      detail="Import an ExhibitFlow snapshot JSON exported from the review desk. The same content imported twice — even with a different file name — stays one record."
      action={<Button variant="secondary" icon={<Upload size={16} />} onClick={() => fileInputRef.current?.click()}>Import your first snapshot</Button>}
    />}

    {lineages.map((lineage) =>
      <ArchiveLineageCard
        key={lineage.planId}
        lineage={lineage}
        entryById={entryById}
        onReopen={reopen}
        onExport={exportEntry}
        onDelete={(entry) => setConfirmId(entry.id)}
      />)}

    {openEntryId && <ArchiveDetailModal
      entry={openEntry}
      predecessor={openEntry?.supersededEntryId ? entryById.get(openEntry.supersededEntryId) : undefined}
      onClose={closeDetail}
      onExport={exportEntry}
    />}

    {confirmEntry && <Modal
      eyebrow="DELETE ARCHIVE"
      title={`Delete v${confirmEntry.version} of “${confirmEntry.projectTitle}”?`}
      onClose={() => setConfirmId(null)}
      footer={<>
        <Button variant="ghost" onClick={() => setConfirmId(null)}>Cancel</Button>
        <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => { removeArchive(confirmEntry.id); setConfirmId(null); if (openEntryId === confirmEntry.id) closeDetail(); notify('warning', 'Archive deleted. The live workspace and other versions were not changed.'); }}>Delete archived version</Button>
      </>}
    >
      <p className="archive-confirm-copy">This removes only this archived copy. The current workspace is untouched, other versions stay reachable, and re-importing the same snapshot restores the same record identity (<code>{shortHash(confirmEntry.contentHash)}</code>).</p>
    </Modal>}

    {toast && <div className={`toast toast-${toast.tone}`}>{toast.tone === 'warning' ? <FileWarning size={16} /> : <FileJson2 size={16} />}{toast.message}</div>}
  </div>;
}

function ArchiveLineageCard({ lineage, entryById, onReopen, onExport, onDelete }: {
  lineage: ArchiveLineage;
  entryById: Map<string, ArchiveEntry>;
  onReopen: (entry: ArchiveEntry) => void;
  onExport: (entry: ArchiveEntry) => void;
  onDelete: (entry: ArchiveEntry) => void;
}) {
  return <section className="archive-lineage" aria-label={`Archived plan ${lineage.projectTitle}`}>
    <div className="archive-lineage-head">
      <div className="archive-lineage-id"><ArchiveIcon size={17} /><div><h2>{lineage.projectTitle}</h2><small>{lineage.venue} · {lineage.versions.length} version{lineage.versions.length === 1 ? '' : 's'}</small></div></div>
      <Badge tone="info">plan {lineage.planKey}</Badge>
    </div>
    <ol className="archive-version-list">
      {lineage.versions.map((entry) => {
        const predecessor = entry.supersededEntryId ? entryById.get(entry.supersededEntryId) : undefined;
        const isLatest = entry.id === lineage.latest.id;
        return <li className={`archive-version-row ${isLatest ? 'is-latest' : ''}`} key={entry.id}>
          <span className="archive-version-tag">v{entry.version}</span>
          <div className="archive-version-main">
            <div className="archive-version-title">
              <strong>Exported {formatDate(entry.generatedAt)}</strong>
              {isLatest && <Badge tone="positive">Current version</Badge>}
              {entry.importCount > 1 && <Badge tone="neutral"><CopyPlus size={11} /> imported {entry.importCount}×</Badge>}
            </div>
            <div className="archive-version-meta">
              <span>{entry.snapshot.summary.artifactCount} objects</span>
              <span>{entry.snapshot.summary.zoneCount} zones</span>
              <span>{formatMinutes(entry.snapshot.summary.visitMinutes)}</span>
              <span>score {entry.snapshot.summary.readinessScore}</span>
              <span title="Content identity"><FileJson2 size={12} /> {shortHash(entry.contentHash)}</span>
              <span title="First archived on">archived {formatDate(entry.importedAt)}</span>
            </div>
            {predecessor
              ? <div className="archive-supersede" data-testid="supersede-note"><GitCompare size={13} /><span>Replaces v{predecessor.version} (exported {formatDate(predecessor.generatedAt)}, {shortHash(predecessor.contentHash)})</span></div>
              : entry.supersededEntryId
                ? <div className="archive-supersede archive-supersede-missing" data-testid="supersede-dangling"><GitCompare size={13} /><span>Replaced an earlier version ({entryHashSuffix(entry.supersededEntryId)}) that has since been deleted</span></div>
                : <div className="archive-supersede archive-supersede-first"><History size={13} /><span>First archived version of this plan</span></div>}
          </div>
          <div className="archive-version-actions">
            <Button variant="secondary" icon={<RefreshCcw size={14} />} onClick={() => onReopen(entry)}>Reopen</Button>
            <Button variant="ghost" icon={<FileJson2 size={14} />} onClick={() => onExport(entry)}>Export</Button>
            <Button variant="ghost" icon={<Trash2 size={14} />} aria-label={`Delete archived v${entry.version}`} onClick={() => onDelete(entry)} />
          </div>
        </li>;
      })}
    </ol>
  </section>;
}

function ArchiveDetailModal({ entry, predecessor, onClose, onExport }: {
  entry?: ArchiveEntry;
  predecessor?: ArchiveEntry;
  onClose: () => void;
  onExport: (entry: ArchiveEntry) => void;
}) {
  if (!entry) {
    return <Modal eyebrow="ARCHIVED SNAPSHOT" title="Archive no longer available" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Close</Button></>}>
      <p className="archive-confirm-copy">This archived version was deleted. Re-importing its snapshot file will rebuild it with the same identity.</p>
    </Modal>;
  }
  return <Modal eyebrow={`ARCHIVED SNAPSHOT · v${entry.version}`} title={entry.projectTitle} onClose={onClose}
    footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" icon={<FileJson2 size={15} />} onClick={() => onExport(entry)}>Export snapshot</Button></>}>
    <div className="archive-detail">
      <div className="archive-detail-summary">
        <div><span className="eyebrow">EXPORTED</span><strong>{formatDate(entry.generatedAt)}</strong></div>
        <div><span className="eyebrow">ARCHIVED</span><strong>{formatDate(entry.importedAt)}</strong></div>
        <div><span className="eyebrow">CONTENT ID</span><strong><FileJson2 size={13} /> {entry.contentHash}</strong></div>
      </div>
      <div className="archive-detail-summary">
        <div><span className="eyebrow">OBJECTS</span><strong>{entry.snapshot.summary.artifactCount}</strong></div>
        <div><span className="eyebrow">ZONES</span><strong>{entry.snapshot.summary.zoneCount}</strong></div>
        <div><span className="eyebrow">VISIT LENGTH</span><strong>{formatMinutes(entry.snapshot.summary.visitMinutes)}</strong></div>
        <div><span className="eyebrow">READINESS</span><strong>{entry.snapshot.summary.readinessScore}</strong></div>
      </div>
      {predecessor
        ? <div className="archive-detail-replaces"><GitCompare size={15} /><span>This version replaces <strong>v{predecessor.version}</strong>, exported {formatDate(predecessor.generatedAt)} ({shortHash(predecessor.contentHash)}).</span><ArrowRight size={14} /></div>
        : entry.supersededEntryId
          ? <div className="archive-detail-replaces archive-detail-first"><GitCompare size={15} /><span>This version replaced an earlier version ({entryHashSuffix(entry.supersededEntryId)}) that has since been deleted.</span></div>
          : <div className="archive-detail-replaces archive-detail-first"><History size={15} /><span>This is the first archived version of the plan.</span></div>}
      <div className="archive-zones">
        <div className="eyebrow">ZONES IN VISIT ORDER</div>
        {entry.snapshot.zones.map((zone, index) => <div className="archive-zone-row" key={zone.id}>
          <span className="archive-zone-order">{index + 1}</span>
          <span className="archive-zone-color" style={{ background: zone.color }} />
          <span className="archive-zone-name">{zone.name}</span>
          <small>{zone.artifacts.length} object{zone.artifacts.length === 1 ? '' : 's'} · {formatMinutes(zone.artifacts.reduce((total, artifact) => total + artifact.dwellMinutes, 0))}</small>
        </div>)}
      </div>
      {entry.snapshot.unresolvedIssues.length > 0 && <div className="archive-issues">
        <div className="eyebrow">NON-BLOCKING OPEN FINDINGS</div>
        {entry.snapshot.unresolvedIssues.map((issue) => <div className="archive-issue-row" key={issue.id}><SearchX size={13} /><span>{issue.title}</span></div>)}
      </div>}
      <p className="archive-detail-note">Read-only frozen record. Reopening or exporting it does not change the workspace you are planning in.</p>
    </div>
  </Modal>;
}
