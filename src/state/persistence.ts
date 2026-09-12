import type { IssueStatus, RuleProfile, WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { migrateWorkspace, sanitizeProfiles, validateReferences } from './migrations';
import { findProfile, resolveRuleProfile } from '../domain/ruleProfiles';

export const STORAGE_KEY = 'exhibit-flow.workspace.v1';
export const REVIEW_UI_KEY = 'exhibit-flow.review-ui.v1';

export interface ReviewUiState {
  zoneId: string;
  status: IssueStatus | 'all';
}

export type WorkspaceLoadProblem =
  | 'storage-malformed'
  | 'profiles-filtered'
  | 'rule-binding-missing'
  | 'rule-profile-unknown'
  | 'rule-profile-corrupt';

export interface WorkspaceLoadResult {
  state: WorkspaceState;
  problems: WorkspaceLoadProblem[];
}

const DEFAULT_REVIEW_UI: ReviewUiState = { zoneId: '', status: 'all' };
const ISSUE_STATUSES: Array<IssueStatus | 'all'> = ['all', 'open', 'in-progress', 'resolved'];

function isWorkspaceState(value: unknown): value is WorkspaceState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkspaceState>;
  return candidate.version === 2
    && Boolean(candidate.project)
    && Array.isArray(candidate.artifacts)
    && Array.isArray(candidate.zones)
    && Array.isArray(candidate.issues)
    && Boolean(candidate.preferences)
    && Array.isArray(candidate.ruleProfiles)
    && Array.isArray(candidate.readinessRuns);
}

/**
 * Load the workspace and surface every rule-archive integrity problem.
 * Structural corruption still falls back to the sample plan (the data is
 * unreadable), but an unbound or unknown archive version is returned as-is
 * with an explicit problem so the UI blocks calculation instead of silently
 * substituting default rules.
 */
export function loadWorkspaceResult(storage: Pick<Storage, 'getItem'> = localStorage): WorkspaceLoadResult {
  let parsed: unknown;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { state: createSeedWorkspace(), problems: [] };
    parsed = JSON.parse(raw);
  } catch {
    return { state: createSeedWorkspace(), problems: ['storage-malformed'] };
  }

  const rawProfiles = extractProfiles(parsed);
  const sanitized = sanitizeProfiles(rawProfiles);
  const profilesFiltered = sanitized.length !== (Array.isArray(rawProfiles) ? rawProfiles.length : 0);

  const migrated = migrateWorkspace(parsed);
  if (!migrated || !isWorkspaceState(migrated)) {
    return { state: createSeedWorkspace(), problems: ['storage-malformed'] };
  }

  const state = validateReferences(migrated);
  const resolution = resolveRuleProfile(state);
  const problems: WorkspaceLoadProblem[] = [];
  if (profilesFiltered) problems.push('profiles-filtered');
  if (resolution.status === 'binding-missing') problems.push('rule-binding-missing');
  if (resolution.status === 'profile-unknown') problems.push('rule-profile-unknown');
  if (resolution.status === 'profile-corrupt') problems.push('rule-profile-corrupt');
  return { state, problems };
}

function extractProfiles(parsed: unknown): RuleProfile[] {
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { ruleProfiles?: unknown }).ruleProfiles)) {
    return (parsed as { ruleProfiles: RuleProfile[] }).ruleProfiles;
  }
  return [];
}

export function loadWorkspace(storage: Pick<Storage, 'getItem'> = localStorage): WorkspaceState {
  return loadWorkspaceResult(storage).state;
}

/** Resolve a problem state by (re)binding to an archive version present locally. */
export function rebindWorkspace(state: WorkspaceState, profileId: string, version: number, at = new Date()): WorkspaceState | null {
  if (!findProfile(state.ruleProfiles, profileId, version)) return null;
  return {
    ...state,
    project: {
      ...state.project,
      ruleBinding: { profileId, version, boundAt: at.toISOString() },
    },
  };
}

export function saveWorkspace(state: WorkspaceState, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspace(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  storage.removeItem(STORAGE_KEY);
}

export function loadReviewUi(storage: Pick<Storage, 'getItem'> = localStorage): ReviewUiState {
  try {
    const raw = storage.getItem(REVIEW_UI_KEY);
    if (!raw) return DEFAULT_REVIEW_UI;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_REVIEW_UI;
    const candidate = parsed as Partial<ReviewUiState>;
    const status: IssueStatus | 'all' = ISSUE_STATUSES.includes(candidate.status as IssueStatus | 'all')
      ? (candidate.status as IssueStatus | 'all')
      : 'all';
    return {
      zoneId: typeof candidate.zoneId === 'string' ? candidate.zoneId : '',
      status,
    };
  } catch {
    return DEFAULT_REVIEW_UI;
  }
}

export function saveReviewUi(ui: ReviewUiState, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(REVIEW_UI_KEY, JSON.stringify(ui));
  } catch {
    // UI preferences are non-critical; ignore storage failures.
  }
}
