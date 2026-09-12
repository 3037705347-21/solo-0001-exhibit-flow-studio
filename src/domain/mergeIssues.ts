import { createId } from './ids';
import type { IssueSeverity, IssueStatus, ReviewIssue, WorkspaceState } from './models';

export const SEVERITY_RANK: Record<IssueSeverity, number> = { note: 0, warning: 1, critical: 2 };

export type MergeMode = 'create' | 'absorb' | 'noop';

export interface MergeFieldDiff {
  field: string;
  values: Array<{ issueId: string; value: string }>;
  differs: boolean;
}

export interface MergeStatusEntry {
  issueId: string;
  title: string;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  mergedIntoId?: string;
}

export interface MergePreview {
  mode: MergeMode;
  /** The selection the preview was built from; commit must be called with these ids. */
  requestedIds: string[];
  sourceIds: string[];
  primaryId: string;
  existingCanonicalId?: string;
  fingerprint: string;
  sharedZoneIds: string[];
  sharedArtifactIds: string[];
  linkedZoneIds: string[];
  linkedArtifactIds: string[];
  fieldDiffs: MergeFieldDiff[];
  statusHistory: MergeStatusEntry[];
  resultingSeverity: IssueSeverity;
  resultingStatus: IssueStatus;
}

export interface MergeCommitInput {
  sourceIds: string[];
  reason: string;
  primaryId?: string;
  expectedFingerprint: string;
  at?: Date;
  idFactory?: () => string;
}

export type MergePreviewResult = { ok: true; preview: MergePreview } | { ok: false; message: string };
export type MergeCommitResult =
  | { ok: true; state: WorkspaceState; canonical: ReviewIssue; sources: ReviewIssue[]; mode: MergeMode; changed: boolean }
  | { ok: false; message: string };

export function isMergedSource(issue: ReviewIssue): boolean {
  return Boolean(issue.mergedIntoId);
}

export function isCanonicalRecord(issue: ReviewIssue): boolean {
  return Boolean(issue.merge);
}

/** Issues that still count individually: canonical records and never-merged findings. */
export function activeIssues(issues: ReviewIssue[]): ReviewIssue[] {
  return issues.filter((issue) => !isMergedSource(issue));
}

/** Follows the mergedIntoId chain so references to a source land on the canonical record. */
export function resolveCanonicalId(issues: ReviewIssue[], id: string): string {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const issue = byId.get(current);
    if (!issue || !issue.mergedIntoId) return current;
    current = issue.mergedIntoId;
  }
  return current;
}

/** Every zone an issue touches, including links inherited through a merge. */
export function issueZoneIds(issue: ReviewIssue): string[] {
  const ids = new Set<string>();
  if (issue.zoneId) ids.add(issue.zoneId);
  for (const zoneId of issue.merge?.linkedZoneIds ?? []) ids.add(zoneId);
  return [...ids];
}

/** Every artifact an issue touches, including links inherited through a merge. */
export function issueArtifactIds(issue: ReviewIssue): string[] {
  const ids = new Set<string>();
  if (issue.artifactId) ids.add(issue.artifactId);
  for (const artifactId of issue.merge?.linkedArtifactIds ?? []) ids.add(artifactId);
  return [...ids];
}

/**
 * Fingerprint of every record a merge transaction depends on. If any of them
 * changes between preview and confirm (external transition, re-merge, removal),
 * the fingerprint no longer matches and the commit aborts, leaving sources untouched.
 */
export function mergeFingerprint(issues: ReviewIssue[]): string {
  return issues
    .map((issue) => [issue.id, issue.status, issue.updatedAt, issue.zoneId ?? '', issue.artifactId ?? '', issue.mergedIntoId ?? ''].join(':'))
    .sort()
    .join('|');
}

interface MergeResolution {
  fresh: ReviewIssue[];
  canonicals: ReviewIssue[];
  implicated: ReviewIssue[];
}

function resolveSelection(state: WorkspaceState, sourceIds: string[]): MergeResolution | { message: string } {
  const byId = new Map(state.issues.map((issue) => [issue.id, issue]));
  const uniqueIds = [...new Set(sourceIds)];
  const fresh: ReviewIssue[] = [];
  const canonicals = new Map<string, ReviewIssue>();
  const implicated = new Map<string, ReviewIssue>();

  for (const id of uniqueIds) {
    const issue = byId.get(id);
    if (!issue) return { message: 'A selected finding no longer exists. Refresh the list before merging.' };
    if (issue.mergedIntoId) {
      const canonical = byId.get(resolveCanonicalId(state.issues, id));
      if (canonical?.merge) {
        canonicals.set(canonical.id, canonical);
        implicated.set(canonical.id, canonical);
        implicated.set(issue.id, issue);
        continue;
      }
      // Dangling merge reference: treat the record as unmerged rather than failing.
      fresh.push(issue);
      implicated.set(issue.id, issue);
      continue;
    }
    if (issue.merge) {
      canonicals.set(issue.id, issue);
      implicated.set(issue.id, issue);
      continue;
    }
    fresh.push(issue);
    implicated.set(issue.id, issue);
  }

  return { fresh, canonicals: [...canonicals.values()], implicated: [...implicated.values()] };
}

function highestSeverity(issues: ReviewIssue[]): IssueSeverity {
  return issues.reduce<IssueSeverity>(
    (top, issue) => (SEVERITY_RANK[issue.severity] > SEVERITY_RANK[top] ? issue.severity : top),
    'note',
  );
}

function deriveStatus(issues: ReviewIssue[]): IssueStatus {
  if (issues.every((issue) => issue.status === 'resolved')) return 'resolved';
  if (issues.some((issue) => issue.status === 'in-progress')) return 'in-progress';
  return 'open';
}

function choosePrimary(sources: ReviewIssue[]): ReviewIssue {
  return [...sources].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.updatedAt.localeCompare(a.updatedAt),
  )[0];
}

function unionLinks(sources: ReviewIssue[], pick: (issue: ReviewIssue) => string[]): string[] {
  const ids = new Set<string>();
  for (const source of sources) {
    for (const id of pick(source)) ids.add(id);
  }
  return [...ids].sort();
}

function sharedLinks(sources: ReviewIssue[], pick: (issue: ReviewIssue) => string[]): string[] {
  if (sources.length === 0) return [];
  const [first, ...rest] = sources.map((source) => new Set(pick(source)));
  return [...first].filter((id) => rest.every((set) => set.has(id))).sort();
}

function buildFieldDiffs(sources: ReviewIssue[]): MergeFieldDiff[] {
  const fields: Array<{ field: string; read: (issue: ReviewIssue) => string }> = [
    { field: 'title', read: (issue) => issue.title },
    { field: 'severity', read: (issue) => issue.severity },
    { field: 'status', read: (issue) => issue.status },
    { field: 'owner', read: (issue) => issue.owner },
    { field: 'zoneId', read: (issue) => issue.zoneId ?? '' },
    { field: 'artifactId', read: (issue) => issue.artifactId ?? '' },
    { field: 'description', read: (issue) => issue.description },
  ];
  return fields.map(({ field, read }) => {
    const values = sources.map((issue) => ({ issueId: issue.id, value: read(issue) }));
    return { field, values, differs: new Set(values.map((entry) => entry.value)).size > 1 };
  });
}

function buildStatusHistory(sources: ReviewIssue[]): MergeStatusEntry[] {
  return sources.map((issue) => ({
    issueId: issue.id,
    title: issue.title,
    status: issue.status,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    resolvedAt: issue.resolvedAt,
    mergedIntoId: issue.mergedIntoId,
  }));
}

export function prepareMerge(state: WorkspaceState, sourceIds: string[], primaryId?: string): MergePreviewResult {
  const resolution = resolveSelection(state, sourceIds);
  if ('message' in resolution) return { ok: false, message: resolution.message };
  const { fresh, canonicals, implicated } = resolution;

  if (canonicals.length > 1) {
    return {
      ok: false,
      message: 'These findings already belong to different canonical records. Unmerge them before combining the groups.',
    };
  }

  const mode: MergeMode = canonicals.length === 1 ? (fresh.length === 0 ? 'noop' : 'absorb') : 'create';
  if (mode === 'create' && fresh.length < 2) {
    return { ok: false, message: 'Select at least two unmerged findings to merge.' };
  }

  const composition = canonicals.length === 1
    ? [canonicals[0], ...implicated.filter((issue) => issue.id !== canonicals[0].id)]
    : implicated;
  const primary = (primaryId && fresh.find((issue) => issue.id === primaryId)) || choosePrimary(fresh.length ? fresh : composition);

  return {
    ok: true,
    preview: {
      mode,
      requestedIds: [...new Set(sourceIds)],
      sourceIds: fresh.map((issue) => issue.id),
      primaryId: primary.id,
      existingCanonicalId: canonicals[0]?.id,
      fingerprint: mergeFingerprint(implicated),
      sharedZoneIds: sharedLinks(composition, (issue) => issueZoneIds(issue)),
      sharedArtifactIds: sharedLinks(composition, (issue) => issueArtifactIds(issue)),
      linkedZoneIds: unionLinks(composition, (issue) => issueZoneIds(issue)),
      linkedArtifactIds: unionLinks(composition, (issue) => issueArtifactIds(issue)),
      fieldDiffs: buildFieldDiffs(composition),
      statusHistory: buildStatusHistory(composition),
      resultingSeverity: highestSeverity(composition),
      resultingStatus: deriveStatus(composition),
    },
  };
}

function evidenceAppendix(sources: ReviewIssue[]): string {
  if (sources.length === 0) return '';
  const lines = sources.map(
    (source) => `— "${source.title}" (${source.owner}, ${source.severity}, ${source.status}): ${source.description}`,
  );
  return `\n\nMerged evidence:\n${lines.join('\n')}`;
}

function latestResolvedAt(issues: ReviewIssue[]): string | undefined {
  return issues
    .map((issue) => issue.resolvedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

/** Post-merge invariants. Any failure means the commit is rejected and sources stay untouched. */
export function validateMergeOutcome(state: WorkspaceState, next: WorkspaceState, canonical: ReviewIssue, sourceIds: string[]): string[] {
  const problems: string[] = [];
  const sourceIdSet = new Set(sourceIds);

  if (!canonical.title.trim()) problems.push('The canonical record needs a title.');
  if (!canonical.owner.trim()) problems.push('The canonical record needs an owner.');
  if (canonical.mergedIntoId) problems.push('The canonical record cannot itself be a merged source.');
  if (sourceIdSet.has(canonical.id)) problems.push('The canonical record cannot also be a merge source.');

  const zoneIds = new Set(state.zones.map((zone) => zone.id));
  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.id));
  const linkedZones = [canonical.zoneId, ...(canonical.merge?.linkedZoneIds ?? [])].filter((id): id is string => Boolean(id));
  const linkedArtifacts = [canonical.artifactId, ...(canonical.merge?.linkedArtifactIds ?? [])].filter((id): id is string => Boolean(id));
  if (linkedZones.some((id) => !zoneIds.has(id))) problems.push('The canonical record links to a zone that no longer exists.');
  if (linkedArtifacts.some((id) => !artifactIds.has(id))) problems.push('The canonical record links to an object that no longer exists.');

  for (const sourceId of sourceIds) {
    const source = next.issues.find((issue) => issue.id === sourceId);
    if (!source) problems.push('A merge source disappeared during the transaction.');
    else if (source.mergedIntoId !== canonical.id) problems.push('A merge source does not point at the canonical record.');
  }

  const claiming = next.issues.filter(
    (issue) => issue.merge && issue.merge.mergedFrom.some((id) => sourceIdSet.has(id)),
  );
  if (claiming.length !== 1 || claiming[0]?.id !== canonical.id) {
    problems.push('More than one canonical record would claim the same sources.');
  }

  return problems;
}

export function commitMerge(state: WorkspaceState, input: MergeCommitInput): MergeCommitResult {
  const reason = input.reason.trim();
  if (!reason) return { ok: false, message: 'A merge reason is required so the team can audit the decision.' };

  const prepared = prepareMerge(state, input.sourceIds, input.primaryId);
  if (!prepared.ok) return { ok: false, message: prepared.message };
  const preview = prepared.preview;

  if (preview.fingerprint !== input.expectedFingerprint) {
    return {
      ok: false,
      message: 'One of these findings changed since the preview. Review the latest state and merge again.',
    };
  }

  if (preview.mode === 'noop' && preview.existingCanonicalId) {
    const canonical = state.issues.find((issue) => issue.id === preview.existingCanonicalId);
    if (!canonical) return { ok: false, message: 'The canonical record no longer exists.' };
    return { ok: true, state, canonical, sources: [], mode: 'noop', changed: false };
  }

  const at = (input.at ?? new Date()).toISOString();
  const freshIds = new Set(preview.sourceIds);

  let canonical: ReviewIssue;
  if (preview.mode === 'absorb' && preview.existingCanonicalId) {
    const existing = state.issues.find((issue) => issue.id === preview.existingCanonicalId);
    if (!existing?.merge) return { ok: false, message: 'The canonical record no longer exists.' };
    const newSources = state.issues.filter((issue) => freshIds.has(issue.id));
    const composition = [existing, ...newSources];
    const status = deriveStatus(composition);
    canonical = {
      ...existing,
      severity: highestSeverity(composition),
      status,
      resolvedAt: status === 'resolved' ? latestResolvedAt(composition) : undefined,
      description: `${existing.description}${evidenceAppendix(newSources)}`,
      updatedAt: at,
      merge: {
        ...existing.merge,
        mergedFrom: [...new Set([...existing.merge.mergedFrom, ...newSources.map((issue) => issue.id)])],
        reason,
        mergedAt: at,
        linkedZoneIds: preview.linkedZoneIds,
        linkedArtifactIds: preview.linkedArtifactIds,
      },
    };
  } else {
    const sources = state.issues.filter((issue) => freshIds.has(issue.id));
    const primary = sources.find((issue) => issue.id === preview.primaryId) ?? choosePrimary(sources);
    const status = deriveStatus(sources);
    const id = (input.idFactory ?? (() => createId('issue')))();
    canonical = {
      id,
      title: primary.title,
      description: `${primary.description}${evidenceAppendix(sources.filter((source) => source.id !== primary.id))}`,
      severity: highestSeverity(sources),
      status,
      zoneId: primary.zoneId,
      artifactId: primary.artifactId,
      owner: primary.owner,
      createdAt: at,
      updatedAt: at,
      resolvedAt: status === 'resolved' ? latestResolvedAt(sources) : undefined,
      merge: {
        canonicalId: id,
        mergedFrom: sources.map((issue) => issue.id),
        reason,
        mergedAt: at,
        linkedZoneIds: preview.linkedZoneIds,
        linkedArtifactIds: preview.linkedArtifactIds,
      },
    };
  }

  const markedSources = new Map(
    state.issues
      .filter((issue) => freshIds.has(issue.id))
      .map((issue) => [issue.id, { ...issue, mergedIntoId: canonical.id }]),
  );

  const canonicalExists = state.issues.some((issue) => issue.id === canonical.id);
  const next: WorkspaceState = {
    ...state,
    issues: [
      ...(canonicalExists ? [] : [canonical]),
      ...state.issues.map((issue) => {
        if (issue.id === canonical.id) return canonical;
        return markedSources.get(issue.id) ?? issue;
      }),
    ],
  };

  const problems = validateMergeOutcome(state, next, canonical, preview.sourceIds);
  if (problems.length > 0) {
    return { ok: false, message: `Merge validation failed: ${problems[0]}` };
  }

  return { ok: true, state: next, canonical, sources: [...markedSources.values()], mode: preview.mode, changed: true };
}
