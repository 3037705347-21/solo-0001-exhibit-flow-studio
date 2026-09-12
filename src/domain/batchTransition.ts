import type {
  BatchItemResult,
  BatchOutcomeCounts,
  BatchTransitionIntent,
  BatchTransitionReport,
  ReviewIssue,
  WorkspaceState,
} from './models';
import { TransitionError, transitionIssue } from './transitions';

export interface BatchTransitionPlan {
  report: BatchTransitionReport;
  /** The issues to write, one per `applied` result, in intent order. */
  updates: ReviewIssue[];
}

/** Upper bound for the persisted idempotency registry. */
export const BATCH_REGISTRY_LIMIT = 25;

/**
 * Plan a versioned batch transition without mutating anything.
 *
 * Every intent is re-checked against the current record, in order:
 * 1. missing record            -> invalid (not-found)
 * 2. already in target status  -> skipped (idempotent no-op, never rewritten)
 * 3. stale base revision       -> conflict (externally modified, re-decide)
 * 4. illegal status transition -> invalid (rejected with the from/to pair)
 * 5. otherwise                 -> applied with a shared timestamp and audit data
 *
 * The same pure function runs in the command (to preview/return the report)
 * and in the reducer (to re-validate at commit time), so a record that changed
 * between preview and commit is always judged against authoritative state.
 */
export function planIssueBatchTransition(
  state: WorkspaceState,
  intents: BatchTransitionIntent[],
  options: { batchId: string; at?: Date },
): BatchTransitionPlan {
  const at = options.at ?? new Date();
  const issuesById = new Map(state.issues.map((issue) => [issue.id, issue]));
  const seen = new Set<string>();
  const results: BatchItemResult[] = [];
  const updates: ReviewIssue[] = [];

  for (const intent of intents) {
    const issue = issuesById.get(intent.issueId);
    if (!issue) {
      results.push({ issueId: intent.issueId, outcome: 'invalid', reason: 'not-found' });
      continue;
    }
    if (seen.has(issue.id)) {
      results.push({ issueId: issue.id, outcome: 'invalid', reason: 'duplicate-in-batch' });
      continue;
    }
    seen.add(issue.id);
    if (issue.status === intent.target) {
      results.push({ issueId: issue.id, outcome: 'skipped', reason: 'already-in-target', status: issue.status });
      continue;
    }
    if (issue.revision !== intent.baseRevision) {
      results.push({
        issueId: issue.id,
        outcome: 'conflict',
        reason: 'externally-modified',
        expectedRevision: intent.baseRevision,
        currentRevision: issue.revision,
        currentStatus: issue.status,
      });
      continue;
    }
    try {
      const updated = { ...transitionIssue(issue, intent.target, at), lastBatchId: options.batchId };
      updates.push(updated);
      issuesById.set(issue.id, updated);
      results.push({ issueId: issue.id, outcome: 'applied', from: issue.status, to: intent.target, revision: updated.revision });
    } catch (error) {
      if (error instanceof TransitionError) {
        results.push({ issueId: issue.id, outcome: 'invalid', reason: 'illegal-transition', from: issue.status, to: intent.target });
        continue;
      }
      throw error;
    }
  }

  return { report: buildReport(options.batchId, at, results), updates };
}

function buildReport(batchId: string, at: Date, results: BatchItemResult[]): BatchTransitionReport {
  return { batchId, at: at.toISOString(), results, counts: countBatchResults(results) };
}

export function countBatchResults(results: BatchItemResult[]): BatchOutcomeCounts {
  const counts: BatchOutcomeCounts = { applied: 0, skipped: 0, conflict: 0, invalid: 0 };
  for (const result of results) counts[result.outcome] += 1;
  return counts;
}

/**
 * Fold a retry report into the previous one so the user always sees a single
 * result covering completed, skipped, and still-pending items. Retried items
 * are replaced by their latest outcome; the merged report takes the newest
 * batch id and timestamp.
 */
export function mergeBatchReports(previous: BatchTransitionReport, next: BatchTransitionReport): BatchTransitionReport {
  const retried = new Set(next.results.map((result) => result.issueId));
  const results = [...previous.results.filter((result) => !retried.has(result.issueId)), ...next.results];
  return { batchId: next.batchId, at: next.at, results, counts: countBatchResults(results) };
}

/**
 * Record a committed batch report in the idempotency registry, keeping only
 * the most recent entries so persisted state stays bounded.
 */
export function recordBatchReport(
  registry: Record<string, BatchTransitionReport> | undefined,
  report: BatchTransitionReport,
): Record<string, BatchTransitionReport> {
  const entries = Object.entries({ ...registry, [report.batchId]: report });
  const byRecency = entries.sort(([, a], [, b]) => a.at.localeCompare(b.at));
  return Object.fromEntries(byRecency.slice(-BATCH_REGISTRY_LIMIT));
}
