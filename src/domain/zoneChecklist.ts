import { sortZones } from './filters';
import { formatMinutes } from './formatters';
import { profileLabel, resolveRuleProfile } from './ruleProfiles';
import type { IssueSeverity, IssueStatus, RuleArchiveRef, WorkspaceState, Zone } from './models';

export interface ChecklistFinding {
  severity: IssueSeverity;
  status: IssueStatus;
  title: string;
  owner: string;
  scope: 'object' | 'zone';
}

export interface ZoneChecklistEntry {
  sequence: number;
  artifactId: string;
  accessionId: string;
  title: string;
  dwellMinutes: number;
  unresolvedFindings: ChecklistFinding[];
}

export interface ZoneChecklist {
  zoneId: string;
  zoneName: string;
  zoneShortLabel: string;
  thesis: string;
  projectTitle: string;
  venue: string;
  generatedAt: string;
  /** Rule archive version the checklist findings were evaluated against. */
  ruleArchive: RuleArchiveRef;
  totalDwellMinutes: number;
  objectCount: number;
  unresolvedCount: number;
  zoneFindings: ChecklistFinding[];
  entries: ZoneChecklistEntry[];
}

export function buildZoneChecklist(state: WorkspaceState, zoneId: string, at = new Date()): ZoneChecklist | null {
  const zone = sortZones(state.zones).find((candidate) => candidate.id === zoneId);
  if (!zone) return null;
  const resolution = resolveRuleProfile(state);
  if (!resolution.profile) return null;
  const rules = resolution.profile;

  const artifactById = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  const unresolved = state.issues.filter((issue) => issue.status !== 'resolved');

  const toFinding = (scope: 'object' | 'zone') =>
    (issue: { severity: IssueSeverity; status: IssueStatus; title: string; owner: string }): ChecklistFinding => ({
      severity: issue.severity,
      status: issue.status,
      title: issue.title,
      owner: issue.owner,
      scope,
    });

  const zoneFindings: ChecklistFinding[] = unresolved
    .filter((issue) => issue.zoneId === zone.id && !issue.artifactId)
    .map(toFinding('zone'));

  const linkedIssueIds = new Set<string>();
  const entries: ZoneChecklistEntry[] = zone.artifactIds
    .map((id, index) => {
      const artifact = artifactById.get(id);
      if (!artifact) return null;
      const objectFindings = unresolved
        .filter((issue) => issue.artifactId === artifact.id)
        .map((issue) => { linkedIssueIds.add(issue.id); return toFinding('object')(issue); });
      return {
        sequence: index + 1,
        artifactId: artifact.id,
        accessionId: artifact.accessionId,
        title: artifact.title,
        dwellMinutes: artifact.dwellMinutes,
        unresolvedFindings: [...objectFindings, ...zoneFindings],
      };
    })
    .filter((entry): entry is ZoneChecklistEntry => entry !== null);

  return {
    zoneId: zone.id,
    zoneName: zone.name,
    zoneShortLabel: zone.shortLabel,
    thesis: zone.thesis,
    projectTitle: state.project.title,
    venue: state.project.venue,
    generatedAt: at.toISOString(),
    ruleArchive: { profileId: rules.profileId, version: rules.version, name: rules.name },
    totalDwellMinutes: entries.reduce((total, entry) => total + entry.dwellMinutes, 0),
    objectCount: entries.length,
    unresolvedCount: zoneFindings.length + linkedIssueIds.size,
    zoneFindings,
    entries,
  };
}

export function zoneChecklistFileName(zone: Zone, date = new Date()): string {
  const slug = (zone.shortLabel || zone.name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `exhibit-flow-zone-checklist-${slug}-${date.toISOString().slice(0, 10)}.csv`;
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function severityTag(severity: IssueSeverity): string {
  if (severity === 'critical') return 'CRITICAL';
  if (severity === 'warning') return 'WARNING';
  return 'NOTE';
}

function formatFinding(finding: ChecklistFinding): string {
  const scope = finding.scope === 'zone' ? '[zone] ' : '';
  return `${scope}[${severityTag(finding.severity)}] ${finding.title} (${finding.owner}, ${finding.status})`;
}

export function serializeZoneChecklistCsv(checklist: ZoneChecklist): string {
  const lines: string[] = [
    `Project,${csvCell(checklist.projectTitle)}`,
    `Venue,${csvCell(checklist.venue)}`,
    `Zone,${csvCell(checklist.zoneName)}`,
    `Thesis,${csvCell(checklist.thesis)}`,
    `Rule archive,${csvCell(`${profileLabel(checklist.ruleArchive)} (${checklist.ruleArchive.profileId}#${checklist.ruleArchive.version})`)}`,
    `Generated,${csvCell(checklist.generatedAt)}`,
    '',
    ['Order', 'Accession ID', 'Object', 'Dwell (min)', 'Unresolved findings'].map(csvCell).join(','),
  ];

  for (const entry of checklist.entries) {
    const findings = entry.unresolvedFindings.map(formatFinding).join(' | ');
    lines.push([entry.sequence, entry.accessionId, entry.title, entry.dwellMinutes, findings].map(csvCell).join(','));
  }

  lines.push(
    '',
    csvCell(`Total dwell: ${formatMinutes(checklist.totalDwellMinutes)} | Objects: ${checklist.objectCount} | Unresolved findings: ${checklist.unresolvedCount}`),
  );

  return lines.join('\r\n');
}
