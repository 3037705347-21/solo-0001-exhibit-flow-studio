import { createId } from './ids';
import type {
  IssueEvent,
  IssueEventType,
  IssueSeverity,
  IssueStatus,
  ReviewIssue,
} from './models';

/** Allowed lifecycle moves, reused both for live transitions and event replay. */
const LIFECYCLE_EVENTS: Partial<Record<IssueStatus, Array<{ target: IssueStatus; type: IssueEventType }>>> = {
  open: [{ target: 'in-progress', type: 'started' }],
  'in-progress': [
    { target: 'resolved', type: 'resolved' },
    // Pulling work back to the queue is also recorded as a reopen.
    { target: 'open', type: 'reopened' },
  ],
  resolved: [{ target: 'open', type: 'reopened' }],
};

function findLifecycleMove(from: IssueStatus, target: IssueStatus) {
  return LIFECYCLE_EVENTS[from]?.find((move) => move.target === target);
}

export class IssueHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueHistoryError';
  }
}

export function sortEvents(events: IssueEvent[]): IssueEvent[] {
  return [...events].sort((a, b) => (a.seq - b.seq) || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export function nextEventSeq(issue: Pick<ReviewIssue, 'events'>): number {
  return issue.events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function appendEvent(issue: ReviewIssue, event: IssueEvent): ReviewIssue {
  return {
    ...issue,
    events: [...issue.events, event],
    updatedAt: event.at,
  };
}

export interface CreateEventInput {
  title: string;
  description: string;
  severity: IssueSeverity;
  owner: string;
  zoneId?: string;
  artifactId?: string;
}

export function issueFromInput(
  issueId: string,
  input: CreateEventInput,
  at = new Date(),
  actor = input.owner,
): ReviewIssue {
  const timestamp = at.toISOString();
  const event: IssueEvent = {
    id: createId('issue-event'),
    issueId,
    type: 'created',
    at: timestamp,
    actor,
    seq: 1,
    snapshot: {
      title: input.title,
      description: input.description,
      severity: input.severity,
      zoneId: input.zoneId,
      artifactId: input.artifactId,
    },
  };
  return {
    id: issueId,
    title: input.title,
    description: input.description,
    severity: input.severity,
    status: 'open',
    zoneId: input.zoneId,
    artifactId: input.artifactId,
    owner: input.owner,
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [event],
  };
}

export interface IssueEditPatch {
  title?: string;
  description?: string;
  severity?: IssueSeverity;
  zoneId?: string;
  artifactId?: string;
}

/** Append an edited event carrying only the fields that actually changed. */
export function recordIssueEdit(
  issue: ReviewIssue,
  patch: IssueEditPatch,
  at = new Date(),
  actor = issue.owner,
  note?: string,
): ReviewIssue {
  const snapshot: NonNullable<IssueEvent['snapshot']> = {};
  const fields: Array<keyof IssueEditPatch> = ['title', 'description', 'severity', 'zoneId', 'artifactId'];
  for (const field of fields) {
    if (field in patch && (patch[field] ?? '') !== (issue[field] ?? '')) {
      (snapshot as Record<string, unknown>)[field] = patch[field];
    }
  }
  if (Object.keys(snapshot).length === 0) return issue;
  const event: IssueEvent = {
    id: createId('issue-event'),
    issueId: issue.id,
    type: 'edited',
    at: at.toISOString(),
    actor,
    seq: nextEventSeq(issue),
    snapshot,
    ...(note ? { note } : {}),
  };
  const updated = appendEvent(issue, event);
  for (const [field, value] of Object.entries(snapshot) as Array<[keyof IssueEditPatch, string]>) {
    (updated as unknown as Record<string, unknown>)[field] = value || undefined;
  }
  return updated;
}

/** Append a reassigned event; same-owner reassignments are ignored. */
export function recordIssueReassignment(
  issue: ReviewIssue,
  owner: string,
  at = new Date(),
  actor = owner,
  note?: string,
): ReviewIssue {
  if (owner === issue.owner) return issue;
  const event: IssueEvent = {
    id: createId('issue-event'),
    issueId: issue.id,
    type: 'reassigned',
    at: at.toISOString(),
    actor,
    seq: nextEventSeq(issue),
    owner,
    ...(note ? { note } : {}),
  };
  return { ...appendEvent(issue, event), owner };
}

/**
 * Append the lifecycle event that moves the finding towards `target`.
 * Same-status calls are no-ops; illegal jumps raise IssueHistoryError so the
 * stored state can never disagree with the event chain.
 */
export function recordIssueStatus(
  issue: ReviewIssue,
  target: IssueStatus,
  at = new Date(),
  actor = issue.owner,
  note?: string,
): ReviewIssue {
  if (issue.status === target) return issue;
  const move = findLifecycleMove(issue.status, target);
  if (!move) {
    throw new IssueHistoryError(`Cannot move a review finding from ${issue.status} to ${target}.`);
  }
  const timestamp = at.toISOString();
  const event: IssueEvent = {
    id: createId('issue-event'),
    issueId: issue.id,
    type: move.type,
    at: timestamp,
    actor,
    seq: nextEventSeq(issue),
    ...(note ? { note } : {}),
  };
  const updated = appendEvent(issue, event);
  if (target === 'resolved') {
    updated.resolvedAt = timestamp;
  } else {
    delete updated.resolvedAt;
  }
  updated.status = target;
  return updated;
}

export interface IssueProjection {
  title: string;
  description: string;
  severity: IssueSeverity;
  zoneId?: string;
  artifactId?: string;
  owner: string;
  status: IssueStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

/**
 * Replay the event chain to derive the current finding state. A migrated
 * legacy finding starts from its synthetic backfilled `created` event, which
 * records the status the finding had at migration time.
 */
export function projectIssue(issue: Pick<ReviewIssue, 'id' | 'events'>): IssueProjection | null {
  const events = sortEvents(issue.events);
  const first = events[0];
  if (!first || first.type !== 'created') return null;

  const initial = first.snapshot ?? {};
  const projection: IssueProjection = {
    title: initial.title ?? '',
    description: initial.description ?? '',
    severity: initial.severity ?? 'warning',
    zoneId: initial.zoneId,
    artifactId: initial.artifactId,
    owner: first.actor,
    status: first.backfilled ? (first.note as IssueStatus | undefined) ?? 'open' : 'open',
    createdAt: first.at,
    updatedAt: first.at,
  };

  for (const event of events.slice(1)) {
    switch (event.type) {
      case 'edited':
        if (event.snapshot) Object.assign(projection, event.snapshot);
        projection.updatedAt = event.at;
        break;
      case 'reassigned':
        if (event.owner) projection.owner = event.owner;
        projection.updatedAt = event.at;
        break;
      case 'started':
        projection.status = 'in-progress';
        projection.resolvedAt = undefined;
        projection.updatedAt = event.at;
        break;
      case 'resolved':
        projection.status = 'resolved';
        projection.resolvedAt = event.at;
        projection.updatedAt = event.at;
        break;
      case 'reopened':
        projection.status = 'open';
        projection.resolvedAt = undefined;
        projection.updatedAt = event.at;
        break;
      case 'created':
        // Only the first event may be created; ignore duplicates defensively.
        break;
    }
  }
  if (projection.status !== 'resolved') projection.resolvedAt = undefined;
  return projection;
}

/**
 * Rebuild the denormalized fields of a finding from its event chain.
 * Returns null when the chain is unusable (missing/invalid created event).
 * For migrated findings the synthetic initial event is the only record, so
 * their pre-existing updated/resolved timestamps are preserved rather than
 * flattened onto the creation time.
 */
export function reconcileIssue(issue: ReviewIssue): ReviewIssue | null {
  const projection = projectIssue(issue);
  if (!projection) return null;
  const backfilled = issue.events.some((event) => event.backfilled);
  if (backfilled) {
    if (issue.updatedAt) projection.updatedAt = issue.updatedAt;
    if (projection.status === 'resolved' && issue.resolvedAt) projection.resolvedAt = issue.resolvedAt;
  }
  return {
    ...issue,
    ...projection,
  };
}

export function isReconciled(issue: ReviewIssue): boolean {
  const projected = projectIssue(issue);
  if (!projected) return false;
  const fields: Array<keyof IssueProjection> = [
    'title', 'description', 'severity', 'zoneId', 'artifactId',
    'owner', 'status', 'createdAt', 'updatedAt', 'resolvedAt',
  ];
  return fields.every((field) => (issue[field] ?? '') === (projected[field] ?? ''));
}

/**
 * Synthesize a compatible initial record for a finding created before event
 * history existed. Exactly one `created` event is appended, marked as
 * backfilled; its note carries the status the legacy finding ended in so the
 * current state stays derivable from the chain.
 */
export function backfillIssueHistory(issue: ReviewIssue, actor = 'system'): ReviewIssue {
  if (issue.events && issue.events.length > 0) return issue;
  const event: IssueEvent = {
    id: createId('issue-event'),
    issueId: issue.id,
    type: 'created',
    at: issue.createdAt,
    actor: issue.owner || actor,
    seq: 1,
    backfilled: true,
    note: issue.status,
    snapshot: {
      title: issue.title,
      description: issue.description,
      severity: issue.severity,
      ...(issue.zoneId ? { zoneId: issue.zoneId } : {}),
      ...(issue.artifactId ? { artifactId: issue.artifactId } : {}),
    },
  };
  return { ...issue, events: [event] };
}

export interface IssueHistorySummary {
  eventCount: number;
  reopenCount: number;
  resolutionCount: number;
  latestResolution?: IssueEvent;
}

export function summarizeHistory(issue: Pick<ReviewIssue, 'events'>): IssueHistorySummary {
  const events = sortEvents(issue.events);
  const resolutions = events.filter((event) => event.type === 'resolved');
  return {
    eventCount: events.length,
    reopenCount: events.filter((event) => event.type === 'reopened').length,
    resolutionCount: resolutions.length,
    latestResolution: resolutions[resolutions.length - 1],
  };
}

/** Whether a finding in `from` status is allowed to move to `target`. */
export function canTransitionStatus(from: IssueStatus, target: IssueStatus): boolean {
  return Boolean(findLifecycleMove(from, target));
}
