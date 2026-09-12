import type { WorkspaceState } from './models';

/**
 * A deterministic fingerprint of the parts of a plan that a repair proposal is
 * built against: every placement (zone order and each zone's object sequence)
 * and every review finding's lifecycle state. Candidate changes are computed
 * against one revision and can only be committed while the plan is still at
 * that revision.
 */
export type PlanRevision = string;

/** FNV-1a (32-bit) — small, deterministic, dependency-free content hash. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function computePlanRevision(state: Pick<WorkspaceState, 'zones' | 'issues'>): PlanRevision {
  const placementLines = [...state.zones]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((zone) => `${zone.id}=[${zone.artifactIds.join('>')}]`);
  const findingLines = [...state.issues]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((issue) => `${issue.id}:${issue.status}:${issue.zoneId ?? ''}:${issue.artifactId ?? ''}`);
  return fnv1a32(['plan-v1', ...placementLines, ...findingLines].join('\n'));
}
