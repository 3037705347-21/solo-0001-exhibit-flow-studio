import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import type { PlanApproval, WorkspaceState } from './models';

// Bump when readiness rules or snapshot content rules change. Sign-offs recorded
// against an older ruleset stop matching the current plan version and read as stale.
export const PLAN_RULES_VERSION = 'signoff-rules-1';

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Fingerprints exactly the content that readiness and the published snapshot depend
// on: project facts, objects, zones (including visit order), and findings. Process
// metadata (stage, check timestamps, preferences, save times) is excluded, and
// collection-level arrays are sorted by id so pure list reordering cannot produce
// a false mismatch. Zone artifactIds keep their order because visit sequence is
// part of the published package.
export function computePlanVersion(state: WorkspaceState): string {
  const content = {
    rules: PLAN_RULES_VERSION,
    project: {
      id: state.project.id,
      title: state.project.title,
      venue: state.project.venue,
      audience: state.project.audience,
      openingDate: state.project.openingDate,
    },
    artifacts: [...state.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
    zones: [...state.zones].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)),
    issues: [...state.issues].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return `plan-${fnv1a(stableStringify(content))}`;
}

export type ApprovalEvaluation =
  | { status: 'none' }
  | { status: 'active'; approval: PlanApproval }
  | { status: 'stale'; approval: PlanApproval; reason: string };

export function evaluateApproval(state: WorkspaceState): ApprovalEvaluation {
  const approval = state.approval;
  if (!approval) return { status: 'none' };
  if (approval.status === 'stale') {
    return { status: 'stale', approval, reason: approval.invalidationReason ?? 'the plan changed after sign-off' };
  }
  if (approval.planVersion !== computePlanVersion(state)) {
    return { status: 'stale', approval, reason: 'the plan or the readiness rules changed after sign-off' };
  }
  return { status: 'active', approval };
}

// Marks an active sign-off as stale with an explanation. Content edits call this
// from the reducer; a missing or already-stale sign-off is left untouched so the
// first invalidation reason survives.
export function invalidateApproval(state: WorkspaceState, reason: string, at = new Date()): WorkspaceState {
  const approval = state.approval;
  if (!approval || approval.status !== 'active') return state;
  return {
    ...state,
    approval: {
      ...approval,
      status: 'stale',
      invalidatedAt: at.toISOString(),
      invalidationReason: reason,
    },
  };
}

export function canSignOff(state: WorkspaceState, at = new Date()): { ok: boolean; message?: string } {
  if (state.project.stage !== 'ready') {
    return { ok: false, message: 'Run a passing readiness check before asking for sign-off.' };
  }
  const readiness = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones), at);
  if (!readiness.ready) {
    return { ok: false, message: readiness.blockers[0] ?? 'The plan is not ready.' };
  }
  return { ok: true };
}

export function canPublish(state: WorkspaceState): { ok: boolean; message?: string } {
  if (state.project.stage !== 'ready') {
    return { ok: false, message: 'The plan must pass a readiness check before publishing.' };
  }
  const evaluation = evaluateApproval(state);
  if (evaluation.status === 'none') {
    return { ok: false, message: 'A lead must sign off on the current plan before publishing.' };
  }
  if (evaluation.status === 'stale') {
    return { ok: false, message: `The sign-off no longer covers the current plan: ${evaluation.reason}. Ask the lead to confirm again.` };
  }
  return { ok: true };
}
