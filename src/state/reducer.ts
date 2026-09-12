import { dedupeOrder, isPermutationOf, sameOrder } from '../domain/reorder';
import { regressReadyProject, transitionIssue } from '../domain/transitions';
import type { WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';

function stamp(state: WorkspaceState): WorkspaceState {
  return { ...state, lastSavedAt: new Date().toISOString() };
}

function removeArtifactFromZones(state: WorkspaceState, artifactId: string): WorkspaceState {
  return {
    ...state,
    zones: state.zones.map((zone) => {
      if (!zone.artifactIds.includes(artifactId)) return zone;
      return {
        ...zone,
        artifactIds: zone.artifactIds.filter((id) => id !== artifactId),
        version: zone.version + 1,
      };
    }),
  };
}

function assignArtifact(state: WorkspaceState, artifactId: string, zoneId: string, index?: number): WorkspaceState {
  if (!state.artifacts.some((artifact) => artifact.id === artifactId)) {
    throw new Error('Cannot place an artifact that is not in the collection.');
  }
  if (!state.zones.some((zone) => zone.id === zoneId)) {
    throw new Error('Cannot place an artifact in an unknown zone.');
  }
  const removed = removeArtifactFromZones(state, artifactId);
  return {
    ...removed,
    zones: removed.zones.map((zone) => {
      if (zone.id !== zoneId) return zone;
      const targetIndex = index === undefined ? zone.artifactIds.length : Math.max(0, Math.min(index, zone.artifactIds.length));
      const artifactIds = [...zone.artifactIds];
      artifactIds.splice(targetIndex, 0, artifactId);
      return { ...zone, artifactIds, version: zone.version + 1 };
    }),
  };
}

/**
 * Compare-and-swap reorder: the resolved order is committed only when the zone
 * version still matches the version the resolution was based on, and only when
 * it is an exact permutation of the current order — so a stale or malformed
 * reorder can never overwrite newer edits, drop objects, or duplicate them.
 * Returns the same state reference when nothing may change.
 */
function applyZoneOrder(state: WorkspaceState, zoneId: string, expectedVersion: number, nextOrder: string[]): WorkspaceState {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) return state;
  if (zone.version !== expectedVersion) return state;
  const current = dedupeOrder(zone.artifactIds);
  // The proposed order must be an exact permutation as-is: a duplicated or
  // incomplete proposal is rejected, never silently repaired.
  if (!isPermutationOf(nextOrder, current)) return state;
  if (sameOrder(nextOrder, zone.artifactIds)) return state;
  return {
    ...state,
    zones: state.zones.map((candidate) => (candidate.id === zoneId
      ? { ...candidate, artifactIds: [...nextOrder], version: candidate.version + 1 }
      : candidate)),
  };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'artifact/upsert': {
      const exists = state.artifacts.some((artifact) => artifact.id === action.artifact.id);
      const artifacts = exists
        ? state.artifacts.map((artifact) => artifact.id === action.artifact.id ? action.artifact : artifact)
        : [...state.artifacts, action.artifact];
      return stamp(regressReadyProject({ ...state, artifacts }));
    }
    case 'artifact/remove': {
      const withoutPlacement = removeArtifactFromZones(state, action.artifactId);
      return stamp(regressReadyProject({
        ...withoutPlacement,
        artifacts: withoutPlacement.artifacts.filter((artifact) => artifact.id !== action.artifactId),
        issues: withoutPlacement.issues.filter((issue) => issue.artifactId !== action.artifactId),
      }));
    }
    case 'placement/assign':
      return stamp(regressReadyProject(assignArtifact(state, action.artifactId, action.zoneId, action.index)));
    case 'placement/remove':
      return stamp(regressReadyProject(removeArtifactFromZones(state, action.artifactId)));
    case 'placement/reorder': {
      const next = applyZoneOrder(state, action.zoneId, action.expectedVersion, action.nextOrder);
      return next === state ? state : stamp(regressReadyProject(next));
    }
    case 'issue/add':
      return stamp(regressReadyProject({ ...state, issues: [action.issue, ...state.issues] }));
    case 'issue/transition':
      return stamp(regressReadyProject({
        ...state,
        issues: state.issues.map((issue) =>
          issue.id === action.issueId ? transitionIssue(issue, action.status, action.at) : issue,
        ),
      }));
    case 'preferences/update':
      return stamp({ ...state, preferences: action.preferences });
    case 'project/readiness':
      return stamp({
        ...state,
        project: {
          ...state.project,
          stage: action.ready ? 'ready' : 'review',
          lastReadinessCheck: action.checkedAt,
        },
      });
    case 'workspace/restore':
    case 'workspace/external':
      return action.state;
    case 'workspace/reset':
      return action.state;
    default:
      return state;
  }
}
