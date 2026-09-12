import type {
  AssignmentAuditEntry,
  IssueSeverity,
  ReviewIssue,
  WorkspaceState,
  Zone,
} from './models';

/** Severity weights used to compare workloads beyond raw finding counts. */
export const SEVERITY_WEIGHT: Record<IssueSeverity, number> = {
  critical: 3,
  warning: 2,
  note: 1,
};

/** A finding captured by an allocation transaction. */
export interface AllocationItem {
  issueId: string;
  title: string;
  severity: IssueSeverity;
  status: ReviewIssue['status'];
  zoneId?: string;
  artifactId?: string;
  /** Owner when the batch was first opened (immutable audit snapshot). */
  fromOwner: string;
  /** Version when the batch was first opened (immutable audit snapshot). */
  baseVersion: number;
  /**
   * Acknowledged baseline: what the operator last confirmed via refresh.
   * Conflict detection and the atomic commit compare live state against these.
   */
  ackOwner: string;
  ackVersion: number;
  ackStatus: ReviewIssue['status'];
  targetOwner: string;
}

/** Reassignable assignment, validated against a base state version. */
export interface AllocationPlan {
  planId: string;
  items: AllocationItem[];
  openedAt: string;
}

export type AllocationConflictType =
  | 'missing'
  | 'status-changed'
  | 'owner-changed'
  | 'version-stale'
  | 'invalid-target';

export interface AllocationConflict {
  issueId: string;
  title: string;
  type: AllocationConflictType;
  detail: string;
}

export interface OwnerLoad {
  owner: string;
  beforeCount: number;
  afterCount: number;
  beforeWeight: number;
  afterWeight: number;
  beforeZoneIds: string[];
  afterZoneIds: string[];
  delta: number;
  deltaWeight: number;
  receives: Array<{ issueId: string; title: string; severity: IssueSeverity }>;
  loses: Array<{ issueId: string; title: string; severity: IssueSeverity }>;
}

export interface WorkloadPreview {
  rows: OwnerLoad[];
  conflicts: AllocationConflict[];
  invalidTargets: number;
  balanced: boolean;
  minAfterWeight: number;
  maxAfterWeight: number;
  weightSpread: number;
}

export type AllocationCommitResult =
  | { ok: true; state: WorkspaceState; audit: AssignmentAuditEntry[]; duplicate: boolean }
  | { ok: false; conflicts: AllocationConflict[] };

const CONFLICT_DESCRIPTIONS: Record<AllocationConflictType, string> = {
  missing: 'This finding no longer exists. Refresh the list and rebuild the batch.',
  'status-changed': 'The finding status changed since the batch was opened.',
  'owner-changed': 'The finding was reassigned by someone else since the batch was opened.',
  'version-stale': 'A newer revision of this finding exists.',
  'invalid-target': 'Every reassigned finding needs a named owner.',
};

export function isActiveIssue(issue: ReviewIssue): boolean {
  return issue.status !== 'resolved';
}

export function issueWeight(issue: Pick<ReviewIssue, 'severity'>): number {
  return SEVERITY_WEIGHT[issue.severity];
}

function zoneNames(zones: Zone[]): Map<string, string> {
  return new Map(zones.map((zone) => [zone.id, zone.shortLabel || zone.name]));
}

/**
 * Open a batch: each selected finding becomes an item pinned to its owner and
 * version at that moment. The draft lives only in UI state and never writes
 * to the workspace until commit.
 */
export function createAllocationDraft(
  issues: ReviewIssue[],
  selectedIds: string[],
  at = new Date(),
): AllocationPlan {
  const selected = new Set(selectedIds);
  const items: AllocationItem[] = issues
    .filter((issue) => selected.has(issue.id))
    .map((issue) => ({
      issueId: issue.id,
      title: issue.title,
      severity: issue.severity,
      status: issue.status,
      zoneId: issue.zoneId,
      artifactId: issue.artifactId,
      fromOwner: issue.owner,
      baseVersion: issue.version,
      ackOwner: issue.owner,
      ackVersion: issue.version,
      ackStatus: issue.status,
      targetOwner: issue.owner,
    }));
  return {
    planId: `plan-${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    items,
    openedAt: at.toISOString(),
  };
}

export function setDraftTarget(draft: AllocationPlan, issueId: string, targetOwner: string): AllocationPlan {
  return {
    ...draft,
    items: draft.items.map((item) => (item.issueId === issueId ? { ...item, targetOwner } : item)),
  };
}

/**
 * Rebase a draft onto a newer state: the acknowledged baseline moves forward
 * to the live owner/version/status, clearing conflicts the operator has now
 * seen. The original snapshot and chosen targets are preserved.
 */
export function refreshAllocationDraft(draft: AllocationPlan, state: WorkspaceState): AllocationPlan {
  const byId = new Map(state.issues.map((issue) => [issue.id, issue]));
  return {
    ...draft,
    items: draft.items.map((item) => {
      const live = byId.get(item.issueId);
      if (!live) return item;
      return {
        ...item,
        title: live.title,
        severity: live.severity,
        status: live.status,
        zoneId: live.zoneId,
        artifactId: live.artifactId,
        ackOwner: live.owner,
        ackVersion: live.version,
        ackStatus: live.status,
      };
    }),
  };
}

export function validateTargets(items: AllocationItem[]): AllocationConflict[] {
  const conflicts: AllocationConflict[] = [];
  for (const item of items) {
    if (!item.targetOwner.trim()) {
      conflicts.push(conflict(item, 'invalid-target'));
    }
  }
  return conflicts;
}

/**
 * Detect external changes since the operator last acknowledged state (batch
 * open or explicit refresh). Findings that disappeared, changed status,
 * changed owner, or carry a newer version are reported; the batch cannot
 * commit until the operator refreshes over the change.
 */
export function detectConflicts(items: AllocationItem[], issues: ReviewIssue[]): AllocationConflict[] {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const conflicts: AllocationConflict[] = [];
  for (const item of items) {
    const live = byId.get(item.issueId);
    if (!live) {
      conflicts.push(conflict(item, 'missing'));
      continue;
    }
    if (live.status !== item.ackStatus) {
      conflicts.push(conflict(item, 'status-changed'));
      continue;
    }
    if (live.owner !== item.ackOwner) {
      conflicts.push(conflict(item, 'owner-changed'));
      continue;
    }
    if (live.version !== item.ackVersion) {
      conflicts.push(conflict(item, 'version-stale'));
    }
  }
  return conflicts;
}

function conflict(item: AllocationItem, type: AllocationConflictType): AllocationConflict {
  return { issueId: item.issueId, title: item.title, type, detail: CONFLICT_DESCRIPTIONS[type] };
}

function movesOf(items: AllocationItem[]) {
  return items.filter((item) =>
    item.targetOwner.trim() && item.ackOwner !== item.targetOwner.trim());
}

/**
 * Pure workload projection. `before` is computed from active (non-resolved)
 * findings; `after` applies the validated moves. Resolved findings stay with
 * their owner and never count toward load.
 */
export function previewWorkload(state: WorkspaceState, draft: AllocationPlan): WorkloadPreview {
  const zones = zoneNames(state.zones);
  const active = state.issues.filter(isActiveIssue);
  const conflicts = detectConflicts(draft.items, state.issues);
  const targetConflicts = validateTargets(draft.items);
  const moves = movesOf(draft.items).map((item) => ({ ...item, targetOwner: item.targetOwner.trim() }));

  const moveByIssue = new Map(moves.map((move) => [move.issueId, move]));
  const beforeIssues = active;
  const afterIssues = active.map((issue) => {
    const move = moveByIssue.get(issue.id);
    return move ? { ...issue, owner: move.targetOwner } : issue;
  });

  const owners = new Set<string>();
  beforeIssues.forEach((issue) => owners.add(issue.owner));
  afterIssues.forEach((issue) => owners.add(issue.owner));

  const rows: OwnerLoad[] = [...owners].sort((a, b) => a.localeCompare(b)).map((owner) => {
    const beforeOwned = beforeIssues.filter((issue) => issue.owner === owner);
    const afterOwned = afterIssues.filter((issue) => issue.owner === owner);
    const beforeZoneIds = uniqueSorted(beforeOwned.map((issue) => issue.zoneId).filter((id): id is string => Boolean(id)), zones);
    const afterZoneIds = uniqueSorted(afterOwned.map((issue) => issue.zoneId).filter((id): id is string => Boolean(id)), zones);
    const beforeWeight = beforeOwned.reduce((sum, issue) => sum + issueWeight(issue), 0);
    const afterWeight = afterOwned.reduce((sum, issue) => sum + issueWeight(issue), 0);
    return {
      owner,
      beforeCount: beforeOwned.length,
      afterCount: afterOwned.length,
      beforeWeight,
      afterWeight,
      beforeZoneIds,
      afterZoneIds,
      delta: afterOwned.length - beforeOwned.length,
      deltaWeight: afterWeight - beforeWeight,
      receives: moves
        .filter((move) => move.targetOwner === owner)
        .map((move) => ({ issueId: move.issueId, title: move.title, severity: move.severity })),
      loses: moves
        .filter((move) => move.ackOwner === owner)
        .map((move) => ({ issueId: move.issueId, title: move.title, severity: move.severity })),
    };
  });

  const weights = rows.map((row) => row.afterWeight);
  const minAfterWeight = weights.length ? Math.min(...weights) : 0;
  const maxAfterWeight = weights.length ? Math.max(...weights) : 0;
  return {
    rows,
    conflicts,
    invalidTargets: targetConflicts.length,
    // A batch is fair when no single owner carries more than one weight unit
    // over the lightest loaded owner.
    balanced: weights.length <= 1 || maxAfterWeight - minAfterWeight <= 1,
    minAfterWeight,
    maxAfterWeight,
    weightSpread: maxAfterWeight - minAfterWeight,
  };
}

function uniqueSorted(zoneIds: string[], names: Map<string, string>): string[] {
  return [...new Set(zoneIds)].sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
}

export function ownerOptions(state: WorkspaceState, draft: AllocationPlan): string[] {
  const owners = new Set<string>();
  state.issues.forEach((issue) => owners.add(issue.owner));
  draft.items.forEach((item) => {
    owners.add(item.ackOwner);
    if (item.targetOwner.trim()) owners.add(item.targetOwner.trim());
  });
  return [...owners].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/**
 * Greedy fair balancer: unassigned selected findings are handed to the owner
 * with the lowest projected severity weight (ties: lowest count, then name).
 * Resolved findings never move. Current assignments stay where they are when
 * they remain the optimal choice.
 */
export function rebalanceDraft(state: WorkspaceState, draft: AllocationPlan): AllocationPlan {
  const candidates = draft.items.filter((item) => item.ackStatus !== 'resolved');
  if (candidates.length === 0) return draft;
  const pool = new Set<string>();
  state.issues.filter(isActiveIssue).forEach((issue) => pool.add(issue.owner));
  draft.items.forEach((item) => pool.add(item.ackOwner));
  if (pool.size < 2) return draft;

  const load = new Map<string, { weight: number; count: number }>();
  [...pool].forEach((owner) => load.set(owner, { weight: 0, count: 0 }));
  state.issues
    .filter(isActiveIssue)
    .filter((issue) => !draft.items.some((item) => item.issueId === issue.id))
    .forEach((issue) => {
      const entry = load.get(issue.owner);
      if (entry) { entry.weight += issueWeight(issue); entry.count += 1; }
    });

  const ranked = [...candidates].sort((a, b) => {
    const weightGap = issueWeight(b) - issueWeight(a);
    return weightGap !== 0 ? weightGap : a.title.localeCompare(b.title);
  });
  const targets = new Map<string, string>();
  for (const item of ranked) {
    const winner = [...load.entries()].sort(([, a], [, b]) => {
      if (a.weight !== b.weight) return a.weight - b.weight;
      return a.count - b.count;
    })[0][0];
    targets.set(item.issueId, winner);
    const entry = load.get(winner);
    if (entry) { entry.weight += issueWeight(item); entry.count += 1; }
  }

  return {
    ...draft,
    items: draft.items.map((item) => {
      const target = targets.get(item.issueId);
      return target ? { ...item, targetOwner: target } : item;
    }),
  };
}

function bumpIssue(issue: ReviewIssue, owner: string, atIso: string): ReviewIssue {
  return { ...issue, owner, version: issue.version + 1, updatedAt: atIso };
}

/**
 * Atomic commit. Nothing is written unless every selected finding still
 * matches its base snapshot (and has a named target). A repeated commit of
 * the same plan id is recognized as a duplicate confirmation and returns the
 * unchanged state, so double clicks or retries can never double-allocate.
 */
export function commitAllocation(
  state: WorkspaceState,
  draft: AllocationPlan,
  now = new Date(),
): AllocationCommitResult {
  const knownPlan = state.assignmentLog.some((entry) => entry.planId === draft.planId);
  if (knownPlan) return { ok: true, state, audit: [], duplicate: true };

  const conflicts = [...detectConflicts(draft.items, state.issues), ...validateTargets(draft.items)];
  if (conflicts.length > 0) return { ok: false, conflicts };

  const atIso = now.toISOString();
  const changes = new Map(
    movesOf(draft.items).map((item) => [item.issueId, item.targetOwner.trim()]),
  );
  if (changes.size === 0) {
    return { ok: true, state, audit: [], duplicate: false };
  }

  const audit: AssignmentAuditEntry[] = [];
  const issues = state.issues.map((issue) => {
    const target = changes.get(issue.id);
    if (!target) return issue;
    audit.push({
      id: `audit-${issue.id}-${issue.version}`,
      planId: draft.planId,
      issueId: issue.id,
      issueTitle: issue.title,
      fromOwner: issue.owner,
      toOwner: target,
      fromStatus: issue.status,
      toStatus: issue.status,
      timestamp: atIso,
    });
    return bumpIssue(issue, target, atIso);
  });

  return {
    ok: true,
    state: {
      ...state,
      issues,
      assignmentLog: [...state.assignmentLog, ...audit].slice(-50),
    },
    audit,
    duplicate: false,
  };
}
