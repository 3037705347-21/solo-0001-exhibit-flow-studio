import { AlertCircle, AlertTriangle, Archive, CheckCircle2, Clock, Download, FileArchive, FileWarning, History, MapPin, PackageCheck, PlusCircle, ShieldAlert, XCircle } from 'lucide-react';
import { useMemo } from 'react';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { downloadTextFile } from '../../domain/export';
import { formatDate, formatMinutes, titleCase } from '../../domain/formatters';
import type { ReleasePackage, ReviewIssue, Snapshot } from '../../domain/models';
import {
  assessReleaseDrift,
  assessSnapshotDrift,
  releaseFileName,
  serializeReleasePackage,
  type DriftChange,
  type DriftEntry,
  type DriftRecordKind,
  type DriftReport,
} from '../../domain/release';
import { serializeZoneChecklistCsv, type ZoneChecklist, zoneChecklistFileName } from '../../domain/zoneChecklist';
import { useWorkspace } from '../../state/WorkspaceContext';

export type PackageViewerTarget =
  | { kind: 'release'; release: ReleasePackage }
  | { kind: 'snapshot'; snapshot: Snapshot; fileName?: string };

const CHANGE_LABEL: Record<DriftChange, string> = {
  changed: 'Edited',
  removed: 'Removed from workspace',
  added: 'Added since freeze',
};

const KIND_LABEL: Record<DriftRecordKind, string> = {
  artifact: 'Object',
  zone: 'Zone',
  issue: 'Finding',
};

function issueTone(issue: ReviewIssue): 'positive' | 'danger' | 'warning' | 'neutral' {
  if (issue.status === 'resolved') return 'positive';
  if (issue.severity === 'critical') return 'danger';
  if (issue.severity === 'warning') return 'warning';
  return 'neutral';
}

export function ReleasePackageViewer({ target, onClose }: { target: PackageViewerTarget; onClose: () => void }) {
  const { state } = useWorkspace();
  const release = target.kind === 'release' ? target.release : null;
  const snapshot = target.kind === 'snapshot' ? target.snapshot : null;
  const project = release ? release.project : snapshot!.project;
  const generatedAt = release ? release.publishedAt : snapshot!.generatedAt;
  const title = release ? release.label : 'Legacy snapshot';

  const drift = useMemo<DriftReport>(
    () => (release ? assessReleaseDrift(release, state) : assessSnapshotDrift(snapshot!, state)),
    [release, snapshot, state],
  );

  const downloadPackage = () => {
    if (release) {
      downloadTextFile(serializeReleasePackage(release), releaseFileName(release));
    } else if (snapshot) {
      const fileName = target.kind === 'snapshot' && target.fileName
        ? target.fileName
        : `exhibit-flow-snapshot-${snapshot.generatedAt.slice(0, 10)}.json`;
      downloadTextFile(JSON.stringify(snapshot, null, 2), fileName);
    }
  };

  const downloadChecklist = (frozen: ReleasePackage, zoneId: string) => {
    const releaseZone = frozen.zones.find((candidate) => candidate.zone.id === zoneId);
    if (!releaseZone) return;
    const checklist: ZoneChecklist = {
      ...releaseZone.checklist,
      projectTitle: frozen.project.title,
      venue: frozen.project.venue,
    };
    downloadTextFile(serializeZoneChecklistCsv(checklist), zoneChecklistFileName(releaseZone.zone, new Date(frozen.publishedAt)), 'text/csv;charset=utf-8');
  };

  const frozenIssues: ReviewIssue[] = release ? release.issues : snapshot!.unresolvedIssues;
  type FrozenZoneRow = {
    id: string;
    sequence: number;
    name: string;
    thesis: string;
    color: string;
    lowLight: boolean;
    hasSeating: boolean;
    meta: string;
    releaseZone: ReleasePackage['zones'][number] | null;
    legacyArtifacts: Snapshot['zones'][number]['artifacts'] | null;
  };
  const frozenZones: FrozenZoneRow[] = release
    ? release.zones.map((releaseZone, index) => ({
      id: releaseZone.zone.id,
      sequence: index,
      name: releaseZone.zone.name,
      thesis: releaseZone.zone.thesis,
      color: releaseZone.zone.color,
      lowLight: releaseZone.zone.lowLight,
      hasSeating: releaseZone.zone.hasSeating,
      meta: `${releaseZone.checklist.objectCount} objects · ${formatMinutes(releaseZone.checklist.totalDwellMinutes)} · ${releaseZone.zone.lowLight ? 'Low-light' : 'Standard light'} · ${releaseZone.zone.hasSeating ? 'Seating' : 'No seating'}`,
      releaseZone,
      legacyArtifacts: null,
    }))
    : snapshot!.zones.map((zone, index) => ({
      id: zone.id,
      sequence: index,
      name: zone.name,
      thesis: zone.thesis,
      color: zone.color,
      lowLight: zone.lowLight,
      hasSeating: zone.hasSeating,
      meta: `${zone.artifacts.length} objects · ${zone.lowLight ? 'Low-light' : 'Standard light'} · ${zone.hasSeating ? 'Seating' : 'No seating'}`,
      releaseZone: null,
      legacyArtifacts: zone.artifacts,
    }));

  return <Modal eyebrow={release ? 'REVIEW RELEASE PACKAGE · IMMUTABLE' : 'LEGACY SNAPSHOT · READ-ONLY'} title={title} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary" icon={<Download size={15} />} onClick={downloadPackage}>{release ? 'Download package JSON' : 'Download snapshot copy'}</Button></>}>
    <div className="release-viewer">
      <div className="release-identity">
        <div className="release-identity-icon">{release ? <PackageCheck size={22} /> : <Archive size={22} />}</div>
        <div>
          <h3>{project.title}</h3>
          <p>{project.venue} · {release ? 'Published' : 'Exported'} {formatDate(generatedAt)}</p>
        </div>
        {release
          ? <Badge tone="positive"><History size={11} /> Frozen record</Badge>
          : <Badge tone="neutral"><FileArchive size={11} /> Schema v1 export</Badge>}
      </div>

      <DriftBanner drift={drift} />
      {!release && <div className="release-legacy-note"><FileWarning size={14} /><span>This snapshot predates release packages. It contains only placed objects and unresolved findings; drift below is limited to those records.</span></div>}

      {release ? <section className="release-readiness">
        <div className="panel-heading"><div><div className="eyebrow">READINESS SUMMARY AT FREEZE</div><h2>{release.readiness.ready ? 'Ready to share' : 'Blocked'} · {release.readiness.score}</h2></div>{release.readiness.ready ? <CheckCircle2 size={20} className="text-teal" /> : <ShieldAlert size={20} className="text-danger" />}</div>
        <div className="release-stat-grid">
          <div><span className="eyebrow">OBJECTS</span><strong>{release.readiness.artifactCount}</strong></div>
          <div><span className="eyebrow">PLACED</span><strong>{release.readiness.placedCount}</strong></div>
          <div><span className="eyebrow">UNPLACED</span><strong>{release.readiness.unplacedCount}</strong></div>
          <div><span className="eyebrow">PLANNED VISIT</span><strong>{formatMinutes(release.readiness.visitMinutes)}</strong></div>
        </div>
        {release.readiness.blockers.length > 0 && <ul className="release-conditions blocked">{release.readiness.blockers.map((blocker) => <li key={blocker}><XCircle size={14} />{blocker}</li>)}</ul>}
        {release.readiness.cautions.length > 0 && <ul className="release-conditions cautions">{release.readiness.cautions.map((caution) => <li key={caution}><AlertTriangle size={14} />{caution}</li>)}</ul>}
      </section> : <section className="release-readiness">
        <div className="release-stat-grid">
          <div><span className="eyebrow">OBJECTS PLACED</span><strong>{snapshot!.zones.reduce((total, zone) => total + zone.artifacts.length, 0)}</strong></div>
          <div><span className="eyebrow">ZONES</span><strong>{snapshot!.summary.zoneCount}</strong></div>
          <div><span className="eyebrow">PLANNED VISIT</span><strong>{formatMinutes(snapshot!.summary.visitMinutes)}</strong></div>
          <div><span className="eyebrow">SCORE AT EXPORT</span><strong>{snapshot!.summary.readinessScore}</strong></div>
        </div>
      </section>}

      <section className="release-zones">
        <div className="eyebrow">OBJECTS IN ZONE ORDER</div>
        {frozenZones.map((zoneRow) => {
          const releaseZone = zoneRow.releaseZone;
          return <div className="release-zone" key={zoneRow.id}>
            <div className="release-zone-head">
              <div className="release-zone-title"><span className="release-zone-marker" style={{ backgroundColor: zoneRow.color }}>{String(zoneRow.sequence + 1).padStart(2, '0')}</span><div><h3>{zoneRow.name}</h3><p>{zoneRow.meta}</p></div></div>
              {release && releaseZone && <Button variant="ghost" icon={<Download size={14} />} onClick={() => downloadChecklist(release, zoneRow.id)}>Frozen checklist CSV</Button>}
            </div>
            <p className="release-zone-thesis">{zoneRow.thesis}</p>
            {releaseZone ? <>
              <div className="release-entry-list">
                {releaseZone.checklist.entries.length === 0 && <div className="zone-empty">No objects were placed in this zone at freeze time.</div>}
                {releaseZone.checklist.entries.map((entry) => {
                  const objectFindings = entry.unresolvedFindings.filter((finding) => finding.scope === 'object').length;
                  return <div className="release-entry" key={entry.artifactId}>
                    <span className="checklist-order">{entry.sequence}</span>
                    <span className="checklist-object"><strong>{entry.title}</strong><small>{entry.accessionId}</small></span>
                    <span className="checklist-dwell"><Clock size={13} />{entry.dwellMinutes} min</span>
                    <span className={`checklist-findings ${objectFindings ? 'is-open' : 'is-clear'}`}>{objectFindings ? <><AlertCircle size={13} />{objectFindings} open finding{objectFindings === 1 ? '' : 's'}</> : <><CheckCircle2 size={13} />Clear</>}</span>
                  </div>;
                })}
              </div>
              {releaseZone.checklist.zoneFindings.length > 0 && <div className="checklist-zone-findings">{releaseZone.checklist.zoneFindings.map((finding, findingIndex) => <div className="checklist-zone-finding" key={`${finding.title}-${findingIndex}`}><ShieldAlert size={14} /><span><strong>[{finding.severity.toUpperCase()}]</strong> {finding.title} <em>· {finding.owner}</em></span></div>)}</div>}
            </> : <div className="release-entry-list">{(zoneRow.legacyArtifacts ?? []).map((artifact, artifactIndex) => <div className="release-entry" key={artifact.id}><span className="checklist-order">{artifactIndex + 1}</span><span className="checklist-object"><strong>{artifact.title}</strong><small>{artifact.accessionId}</small></span><span className="checklist-dwell"><Clock size={13} />{artifact.dwellMinutes} min</span></div>)}</div>}
          </div>;
        })}
      </section>

      {release && <section className="release-unplaced">
        <div className="eyebrow">COLLECTION OBJECTS NOT IN THE JOURNEY ({release.unplacedArtifacts.length})</div>
        {release.unplacedArtifacts.length === 0 ? <p className="release-empty-line">Every collection object was placed when this package was frozen.</p> : <div className="release-unplaced-list">{release.unplacedArtifacts.map((artifact) => <span className="release-unplaced-chip" key={artifact.id}>{artifact.title} <small>{artifact.accessionId}</small></span>)}</div>}
      </section>}

      <section className="release-findings">
        <div className="eyebrow">{release ? `FINDINGS FROZEN IN PACKAGE (${release.issues.length})` : `UNRESOLVED FINDINGS AT EXPORT (${snapshot!.unresolvedIssues.length})`}</div>
        {frozenIssues.length === 0 && <p className="release-empty-line">No findings were recorded.</p>}
        {frozenIssues.map((issue) => <div className={`release-finding release-finding-${issue.severity}`} key={issue.id}>
          <div className="issue-severity">{issue.severity === 'critical' ? <ShieldAlert size={17} /> : issue.severity === 'warning' ? <AlertTriangle size={17} /> : <FileWarning size={17} />}</div>
          <div className="issue-main"><div className="issue-title-line"><h3>{issue.title}</h3><Badge tone={issueTone(issue)}>{titleCase(issue.status)}</Badge></div><p>{issue.description}</p><div className="issue-meta">{issue.owner && <span>{issue.owner}</span>}{issue.zoneId && <span><MapPin size={13} /> Zone linked</span>}{issue.artifactId && <span>Object linked</span>}</div></div>
        </div>)}
      </section>
    </div>
  </Modal>;
}

function DriftBanner({ drift }: { drift: DriftReport }) {
  if (!drift.drifted) {
    return <section className="drift-banner current"><CheckCircle2 size={18} /><div><strong>Matches the current workspace</strong><p>No object, zone, or finding has changed since this record was frozen{drift.partial ? ' (checked against the records included in this legacy export)' : ''}.</p></div></section>;
  }
  return <section className="drift-banner drifted">
    <div className="drift-head"><AlertTriangle size={18} /><div><strong>Workspace has drifted — this package no longer matches the live plan</strong><p>{drift.entries.length} record{drift.entries.length === 1 ? '' : 's'} now differ{drift.partial ? ' within the scope of this legacy export' : ''}: {drift.counts.artifact} object{drift.counts.artifact === 1 ? '' : 's'}, {drift.counts.zone} zone{drift.counts.zone === 1 ? '' : 's'}, {drift.counts.issue} finding{drift.counts.issue === 1 ? '' : 's'}.</p></div></div>
    <ul className="drift-list">
      {drift.entries.map((entry) => <DriftRow key={`${entry.kind}-${entry.id}-${entry.change}`} entry={entry} />)}
    </ul>
  </section>;
}

function DriftRow({ entry }: { entry: DriftEntry }) {
  const icon = entry.change === 'removed'
    ? <XCircle size={15} />
    : entry.change === 'added'
      ? <PlusCircle size={15} />
      : <AlertTriangle size={15} />;
  return <li className={`drift-row drift-${entry.change}`}>
    {icon}
    <span className="drift-kind">{KIND_LABEL[entry.kind]}</span>
    <strong>{entry.label}</strong>
    <span className="drift-detail">{CHANGE_LABEL[entry.change]}{entry.fieldChanges.length ? ` · ${entry.fieldChanges.join(', ')}` : ''}</span>
  </li>;
}
