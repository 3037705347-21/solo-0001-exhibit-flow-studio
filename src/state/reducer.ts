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

function removeZone(state: WorkspaceState, zoneId: string): WorkspaceState {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) throw new Error('The selected zone no longer exists.');
  return {
    ...state,
    zones: state.zones
      .filter((candidate) => candidate.id !== zoneId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((candidate, index) => ({ ...candidate, sequence: index })),
    issues: state.issues.map((issue) => {
      if (issue.zoneId !== zoneId) return issue;
      if (issue.artifactId) return { ...issue, zoneId: undefined };
      return { ...issue, zoneId: undefined, detachedFromZone: zone.name };
    }),
  };
}

function reorderZone(state: WorkspaceState, zoneId: string, direction: -1 | 1): WorkspaceState {
  const ordered = [...state.zones].sort((left, right) => left.sequence - right.sequence);
  const currentIndex = ordered.findIndex((zone) => zone.id === zoneId);
  if (currentIndex === -1) throw new Error('The zone could not be found.');
  const targetIndex = currentIndex + direction;
  if (targetIndex < 0 || targetIndex >= ordered.length) return state;
  const reordered = [...ordered];
  [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[currentIndex]];
  const sequenceById = new Map<string, number>(reordered.map((zone, index) => [zone.id, index]));
  return {
    ...state,
    zones: state.zones.map((zone) => {
      const sequence = sequenceById.get(zone.id);
      return sequence === undefined ? zone : { ...zone, sequence };
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
        issues: withoutPlacement.issues.filter((issue) => issue.artifactId !== action.artifactId),
      }));
    }
    case 'zone/upsert': {
      const exists = state.zones.some((zone) => zone.id === action.zone.id);
      if (!exists) return stamp(regressReadyProject({ ...state, zones: [...state.zones, action.zone] }));
      return stamp(regressReadyProject({
        ...state,
        zones: state.zones.map((zone) => (zone.id === action.zone.id ? action.zone : zone)),
      }));
    }
    case 'zone/remove':
      return stamp(regressReadyProject(removeZone(state, action.zoneId)));
    case 'zone/reorder':
      return stamp(regressReadyProject(reorderZone(state, action.zoneId, action.direction)));
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
