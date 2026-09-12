import type { PlanningPreferences, WorkspaceState } from './models';
import { clampScenario } from './scenario';

/**
 * A scenario draft is the persisted record of an interrupted Insights editing
 * session. It stores only the delta against the saved planning preferences,
 * the last edit time, and the version of the plan the edits were based on, so
 * the session can be recovered later and revalidated before it is applied.
 */
export interface ScenarioDraft {
  changes: Partial<PlanningPreferences>;
  updatedAt: string;
  baseVersion: string;
}

export type ScenarioDraftStatus = 'ready' | 'stale';

const PACE_VALUES: Array<PlanningPreferences['pace']> = ['focused', 'balanced', 'leisurely'];
const PREFERENCE_KEYS = ['pace', 'accessibilityPriority', 'groupSize'];

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Fingerprint of the plan inputs a scenario projection depends on. Artifact and
 * zone changes produce a new version; preference, issue, and readiness changes
 * do not, so applying a draft never invalidates another one by itself.
 */
export function planVersion(state: WorkspaceState): string {
  const input = stableStringify({ artifacts: state.artifacts, zones: state.zones });
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `plan-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function samePreferences(left: PlanningPreferences, right: PlanningPreferences): boolean {
  return left.pace === right.pace
    && left.accessibilityPriority === right.accessibilityPriority
    && left.groupSize === right.groupSize;
}

/** Delta of the working values against the saved preferences. */
export function diffPreferences(saved: PlanningPreferences, working: PlanningPreferences): Partial<PlanningPreferences> {
  const changes: Partial<PlanningPreferences> = {};
  if (working.pace !== saved.pace) changes.pace = working.pace;
  if (working.accessibilityPriority !== saved.accessibilityPriority) changes.accessibilityPriority = working.accessibilityPriority;
  if (working.groupSize !== saved.groupSize) changes.groupSize = working.groupSize;
  return changes;
}

export function hasDraftChanges(draft: ScenarioDraft): boolean {
  return Object.keys(draft.changes).length > 0;
}

/** Replay the stored delta on top of the current saved preferences. */
export function resolveScenarioDraft(saved: PlanningPreferences, draft: ScenarioDraft): PlanningPreferences {
  return clampScenario({ ...saved, ...draft.changes });
}

/** Strict check used at commit time: out-of-range values must never be written. */
export function isValidScenarioInput(value: unknown): value is PlanningPreferences {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PlanningPreferences>;
  return PACE_VALUES.includes(candidate.pace as PlanningPreferences['pace'])
    && typeof candidate.accessibilityPriority === 'number'
    && Number.isFinite(candidate.accessibilityPriority)
    && candidate.accessibilityPriority >= 0
    && candidate.accessibilityPriority <= 100
    && typeof candidate.groupSize === 'number'
    && Number.isFinite(candidate.groupSize)
    && candidate.groupSize >= 1
    && candidate.groupSize <= 30;
}

/** Structural check used when loading a persisted draft from storage. */
export function isValidScenarioDraft(value: unknown): value is ScenarioDraft {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ScenarioDraft>;
  if (!candidate.changes || typeof candidate.changes !== 'object') return false;
  if (typeof candidate.updatedAt !== 'string' || Number.isNaN(new Date(candidate.updatedAt).getTime())) return false;
  if (typeof candidate.baseVersion !== 'string' || candidate.baseVersion.length === 0) return false;
  const changes = candidate.changes as Record<string, unknown>;
  if (Object.keys(changes).some((key) => !PREFERENCE_KEYS.includes(key))) return false;
  if (changes.pace !== undefined && !PACE_VALUES.includes(changes.pace as PlanningPreferences['pace'])) return false;
  if (changes.accessibilityPriority !== undefined) {
    const priority = changes.accessibilityPriority;
    if (typeof priority !== 'number' || !Number.isFinite(priority) || priority < 0 || priority > 100) return false;
  }
  if (changes.groupSize !== undefined) {
    const groupSize = changes.groupSize;
    if (typeof groupSize !== 'number' || !Number.isFinite(groupSize) || groupSize < 1 || groupSize > 30) return false;
  }
  return true;
}

export function scenarioDraftStatus(draft: ScenarioDraft, state: WorkspaceState): ScenarioDraftStatus {
  return draft.baseVersion === planVersion(state) ? 'ready' : 'stale';
}
