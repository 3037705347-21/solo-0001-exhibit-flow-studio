import { regressReadyProject, transitionIssue } from '../domain/transitions';
import type { WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';

function stamp(state: WorkspaceState): WorkspaceState {
  return { ...state, lastSavedAt: new Date().toISOString() };
}

function removeArtifactFromZones(state: WorkspaceState, artifactId: string): WorkspaceState {
  return {
    ...state,
    zones: state.zones.map((zone) => ({
      ...zone,
      artifactIds: zone.artifactIds.filter((id) => id !== artifactId),
    })),
  };
}

/**
 * Removes issues directly linked to an artifact. Merged sources of a removed
 * canonical record go with it; surviving canonical records simply drop the
 * dangling references from their merge metadata.
 */
function removeIssuesForArtifact(state: WorkspaceState, artifactId: string): WorkspaceState['issues'] {
  const directlyRemoved = new Set(
    state.issues.filter((issue) => issue.artifactId === artifactId).map((issue) => issue.id),
  );
  const removed = new Set(directlyRemoved);
  for (const issue of state.issues) {
    if (issue.mergedIntoId && directlyRemoved.has(issue.mergedIntoId)) removed.add(issue.id);
  }
  return state.issues
    .filter((issue) => !removed.has(issue.id))
    .map((issue) => {
      if (!issue.merge) return issue;
      const mergedFrom = issue.merge.mergedFrom.filter((id) => !removed.has(id));
      const linkedArtifactIds = issue.merge.linkedArtifactIds.filter((id) => id !== artifactId);
      if (mergedFrom.length === issue.merge.mergedFrom.length && linkedArtifactIds.length === issue.merge.linkedArtifactIds.length) {
        return issue;
      }
      return { ...issue, merge: { ...issue.merge, mergedFrom, linkedArtifactIds } };
    });
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
      return { ...zone, artifactIds };
    }),
  };
}

function reorderArtifact(state: WorkspaceState, zoneId: string, artifactId: string, direction: -1 | 1): WorkspaceState {
  return {
    ...state,
    zones: state.zones.map((zone) => {
      if (zone.id !== zoneId) return zone;
      const currentIndex = zone.artifactIds.indexOf(artifactId);
      if (currentIndex === -1) throw new Error('The artifact is not placed in this zone.');
      const targetIndex = currentIndex + direction;
      if (targetIndex < 0 || targetIndex >= zone.artifactIds.length) return zone;
      const artifactIds = [...zone.artifactIds];
      [artifactIds[currentIndex], artifactIds[targetIndex]] = [artifactIds[targetIndex], artifactIds[currentIndex]];
      return { ...zone, artifactIds };
    }),
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
        issues: removeIssuesForArtifact(withoutPlacement, action.artifactId),
      }));
    }
    case 'placement/assign':
      return stamp(regressReadyProject(assignArtifact(state, action.artifactId, action.zoneId, action.index)));
    case 'placement/remove':
      return stamp(regressReadyProject(removeArtifactFromZones(state, action.artifactId)));
    case 'placement/reorder':
      return stamp(regressReadyProject(reorderArtifact(state, action.zoneId, action.artifactId, action.direction)));
    case 'issue/add':
      return stamp(regressReadyProject({ ...state, issues: [action.issue, ...state.issues] }));
    case 'issue/transition':
      return stamp(regressReadyProject({
        ...state,
        issues: state.issues.map((issue) =>
          issue.id === action.issueId ? transitionIssue(issue, action.status, action.at) : issue,
        ),
      }));
    case 'issue/merge': {
      const sources = new Map(action.sources.map((source) => [source.id, source]));
      const canonicalExists = state.issues.some((issue) => issue.id === action.canonical.id);
      return stamp(regressReadyProject({
        ...state,
        issues: [
          ...(canonicalExists ? [] : [action.canonical]),
          ...state.issues.map((issue) => {
            if (issue.id === action.canonical.id) return action.canonical;
            return sources.get(issue.id) ?? issue;
          }),
        ],
      }));
    }
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
    case 'workspace/reset':
      return action.state;
    default:
      return state;
  }
}
