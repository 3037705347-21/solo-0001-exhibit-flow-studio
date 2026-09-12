import { regressReadyProject, transitionIssue } from '../domain/transitions';
import {
  applyFieldRestore,
  applyRevisionRestore,
  createRevisionEntry,
  hasAccessionCollision,
  isTrackedField,
  RevisionConflictError,
} from '../domain/revisions';
import type { Artifact, ArtifactRevision, WorkspaceState } from '../domain/models';
import type { WorkspaceAction } from './actions';

function stamp(state: WorkspaceState): WorkspaceState {
  return { ...state, lastSavedAt: new Date().toISOString() };
}

/**
 * Replaces an artifact in place and appends the revision that describes the
 * change. The object id never changes, so zone placements, review findings,
 * readiness results, and exports keep referencing the same identity.
 */
function commitArtifactRevision(state: WorkspaceState, next: Artifact, revision: ArtifactRevision): WorkspaceState {
  return stamp(regressReadyProject({
    ...state,
    artifacts: state.artifacts.map((artifact) => artifact.id === next.id ? next : artifact),
    revisions: [...state.revisions, revision],
  }));
}

function requireCurrentArtifact(state: WorkspaceState, artifactId: string): Artifact {
  const current = state.artifacts.find((artifact) => artifact.id === artifactId);
  if (!current) throw new Error('The selected object no longer exists.');
  return current;
}

function guardBaseVersion(current: Artifact, baseVersion: number | undefined): void {
  if (baseVersion === undefined || current.revision !== baseVersion) {
    throw new RevisionConflictError(current.revision, baseVersion);
  }
}

function requireSourceRevision(state: WorkspaceState, artifactId: string, revisionId: string): ArtifactRevision {
  const source = state.revisions.find((revision) => revision.id === revisionId && revision.artifactId === artifactId);
  if (!source) throw new Error('The selected revision is no longer part of this object\'s history.');
  return source;
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
      const current = state.artifacts.find((artifact) => artifact.id === action.artifact.id);
      if (current) guardBaseVersion(current, action.baseVersion);
      const revision = createRevisionEntry({
        artifactId: action.artifact.id,
        before: current,
        after: action.artifact,
        reason: action.reason,
        kind: current ? 'edit' : 'create',
        at: action.at,
      });
      if (current && revision.changes.length === 0) return state;
      if (current) return commitArtifactRevision(state, action.artifact, revision);
      return stamp(regressReadyProject({
        ...state,
        artifacts: [...state.artifacts, action.artifact],
        revisions: [...state.revisions, revision],
      }));
    }
    case 'artifact/remove': {
      const withoutPlacement = removeArtifactFromZones(state, action.artifactId);
      return stamp(regressReadyProject({
        ...withoutPlacement,
        artifacts: withoutPlacement.artifacts.filter((artifact) => artifact.id !== action.artifactId),
        issues: withoutPlacement.issues.filter((issue) => issue.artifactId !== action.artifactId),
        revisions: withoutPlacement.revisions.filter((revision) => revision.artifactId !== action.artifactId),
      }));
    }
    case 'artifact/restore-field': {
      const current = requireCurrentArtifact(state, action.artifactId);
      guardBaseVersion(current, action.baseVersion);
      const source = requireSourceRevision(state, action.artifactId, action.revisionId);
      if (!isTrackedField(action.field)) {
        throw new Error(`The field "${action.field}" is not tracked by the revision history.`);
      }
      const restored = applyFieldRestore(current, source, action.field, action.at);
      if (!restored) return state;
      if (action.field === 'accessionId' && hasAccessionCollision(state.artifacts, restored)) {
        throw new Error('Restoring this accession ID would duplicate another object in the collection.');
      }
      const revision = createRevisionEntry({
        artifactId: current.id,
        before: current,
        after: restored,
        reason: action.reason,
        kind: 'restore-field',
        at: action.at,
      });
      return commitArtifactRevision(state, restored, revision);
    }
    case 'artifact/restore-revision': {
      const current = requireCurrentArtifact(state, action.artifactId);
      guardBaseVersion(current, action.baseVersion);
      const source = requireSourceRevision(state, action.artifactId, action.revisionId);
      const restored = applyRevisionRestore(current, source, action.at);
      if (!restored) return state;
      if (hasAccessionCollision(state.artifacts, restored)) {
        throw new Error('Restoring this version would duplicate another object\'s accession ID.');
      }
      const revision = createRevisionEntry({
        artifactId: current.id,
        before: current,
        after: restored,
        reason: action.reason,
        kind: 'restore-object',
        at: action.at,
      });
      return commitArtifactRevision(state, restored, revision);
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
      });
    case 'workspace/reset':
      return action.state;
    default:
      return state;
  }
}
