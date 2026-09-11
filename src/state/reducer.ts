import { invalidateApproval } from '../domain/approval';
import { regressReadyProject, transitionIssue } from '../domain/transitions';
import type { WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';

function stamp(state: WorkspaceState): WorkspaceState {
  return { ...state, lastSavedAt: new Date().toISOString() };
}

// Content revisions change what readiness evaluates or what a published snapshot
// would contain, so they regress a ready project and explicitly invalidate any
// active sign-off with a human-readable reason. View-only actions (preferences,
// readiness checks, sign-off itself) must not go through here.
function contentRevision(state: WorkspaceState, reason: string): WorkspaceState {
  return stamp(regressReadyProject(invalidateApproval(state, reason)));
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
      return contentRevision({ ...state, artifacts }, 'an object was added or updated');
    }
    case 'artifact/remove': {
      const withoutPlacement = removeArtifactFromZones(state, action.artifactId);
      return contentRevision({
        ...withoutPlacement,
        artifacts: withoutPlacement.artifacts.filter((artifact) => artifact.id !== action.artifactId),
        issues: withoutPlacement.issues.filter((issue) => issue.artifactId !== action.artifactId),
      }, 'an object was removed from the collection');
    }
    case 'placement/assign':
      return contentRevision(assignArtifact(state, action.artifactId, action.zoneId, action.index), 'an object placement changed');
    case 'placement/remove':
      return contentRevision(removeArtifactFromZones(state, action.artifactId), 'an object was removed from the journey');
    case 'placement/reorder':
      return contentRevision(reorderArtifact(state, action.zoneId, action.artifactId, action.direction), 'the object sequence changed');
    case 'issue/add':
      return contentRevision({ ...state, issues: [action.issue, ...state.issues] }, 'a review finding was added');
    case 'issue/transition':
      return contentRevision({
        ...state,
        issues: state.issues.map((issue) =>
          issue.id === action.issueId ? transitionIssue(issue, action.status, action.at) : issue,
        ),
      }, 'a review finding changed status');
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
    case 'project/approve':
      return stamp({ ...state, approval: action.approval });
    case 'workspace/reset':
      return action.state;
    default:
      return state;
  }
}
