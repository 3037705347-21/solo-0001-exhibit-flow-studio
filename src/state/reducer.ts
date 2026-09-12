import { regressReadyProject, transitionIssue } from '../domain/transitions';
import { reconcileRotationPlans } from '../domain/rotation';
import type { WorkspaceState, Zone } from '../domain/models';
import type { WorkspaceAction } from './actions';

function stamp(state: WorkspaceState): WorkspaceState {
  return { ...state, lastSavedAt: new Date().toISOString() };
}

function reconcile(state: WorkspaceState): WorkspaceState {
  const rotationPlans = reconcileRotationPlans(state);
  return rotationPlans === state.rotationPlans ? state : { ...state, rotationPlans };
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

function updateZone(state: WorkspaceState, zone: Zone): WorkspaceState {
  if (!state.zones.some((candidate) => candidate.id === zone.id)) {
    throw new Error('Cannot update an unknown gallery zone.');
  }
  return {
    ...state,
    zones: state.zones.map((candidate) => (candidate.id === zone.id ? zone : candidate)),
  };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'artifact/upsert': {
      const exists = state.artifacts.some((artifact) => artifact.id === action.artifact.id);
      const artifacts = exists
        ? state.artifacts.map((artifact) => artifact.id === action.artifact.id ? action.artifact : artifact)
        : [...state.artifacts, action.artifact];
      return stamp(reconcile(regressReadyProject({ ...state, artifacts })));
    }
    case 'artifact/remove': {
      const withoutPlacement = removeArtifactFromZones(state, action.artifactId);
      return stamp(reconcile(regressReadyProject({
        ...withoutPlacement,
        artifacts: withoutPlacement.artifacts.filter((artifact) => artifact.id !== action.artifactId),
        issues: withoutPlacement.issues.filter((issue) => issue.artifactId !== action.artifactId),
      })));
    }
    case 'placement/assign':
      return stamp(reconcile(regressReadyProject(assignArtifact(state, action.artifactId, action.zoneId, action.index))));
    case 'placement/remove':
      return stamp(reconcile(regressReadyProject(removeArtifactFromZones(state, action.artifactId))));
    case 'placement/reorder':
      return stamp(reconcile(regressReadyProject(reorderArtifact(state, action.zoneId, action.artifactId, action.direction))));
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
    case 'project/openingDate':
      return stamp(reconcile(regressReadyProject({
        ...state,
        project: { ...state.project, openingDate: action.openingDate },
      })));
    case 'zone/update':
      return stamp(reconcile(regressReadyProject(updateZone(state, action.zone))));
    case 'rotation/generate':
      return stamp({ ...state, rotationPlans: [...state.rotationPlans, action.plan] });
    case 'rotation/replace':
      return stamp({ ...state, rotationPlans: action.plans });
    case 'rotation/remove':
      return stamp({ ...state, rotationPlans: state.rotationPlans.filter((plan) => plan.id !== action.planId) });
    case 'workspace/reset':
      return action.state;
    default:
      return state;
  }
}
