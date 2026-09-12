import { regressReadyProject, transitionIssue } from '../domain/transitions';
import { findProfile } from '../domain/ruleProfiles';
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

/** Append a freshly published archive version; an identical key may never overwrite history. */
function publishProfile(state: WorkspaceState, profile: WorkspaceState['ruleProfiles'][number]): WorkspaceState {
  if (findProfile(state.ruleProfiles, profile.profileId, profile.version)) {
    throw new Error(`Rule archive ${profile.profileId}#${profile.version} already exists; versions are immutable.`);
  }
  return {
    ...state,
    ruleProfiles: [...state.ruleProfiles, profile],
  };
}

/** Switch to an existing archive version. Ready plans regress because the gate changed. */
function bindProfile(state: WorkspaceState, binding: WorkspaceState['project']['ruleBinding']): WorkspaceState {
  if (!binding) throw new Error('A rule archive binding is required.');
  if (!findProfile(state.ruleProfiles, binding.profileId, binding.version)) {
    throw new Error(`Cannot bind to an archive version that is not stored here (${binding.profileId}#${binding.version}).`);
  }
  const current = state.project.ruleBinding;
  if (current && current.profileId === binding.profileId && current.version === binding.version) return state;
  return regressReadyProject({
    ...state,
    project: { ...state.project, ruleBinding: { ...binding } },
  });
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
        readinessRuns: [action.run, ...state.readinessRuns].slice(0, 25),
      });
    case 'rules/publish':
      return stamp(publishProfile(state, action.profile));
    case 'rules/bind':
      return stamp(bindProfile(state, action.binding));
    case 'rules/repair': {
      const bound = bindProfile(state, action.binding);
      // Repairing a broken load is an administrative fix; do not punish a ready stage.
      return stamp({
        ...bound,
        project: { ...bound.project, stage: state.project.stage },
      });
    }
    case 'workspace/reset':
      return action.state;
    default:
      return state;
  }
}
