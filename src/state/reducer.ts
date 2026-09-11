import { regressReadyProject, transitionIssue } from '../domain/transitions';
import {
  acknowledgeStaleness,
  artifactNodeId,
  noteArtifactRemoved,
  noteArtifactUpserted,
  noteIssueAdded,
  noteIssueRemoved,
  noteIssueTransitioned,
  noteIssueZoneLinked,
  notePlacementAssigned,
  notePlacementRemoved,
  recordSnapshot,
  rebaselineArtifact,
  reconcileLineage,
} from '../domain/lineage';
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
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) {
    throw new Error('Cannot place an artifact in an unknown zone.');
  }
  const removed = removeArtifactFromZones(state, artifactId);
  const zones = removed.zones.map((candidate) => {
    if (candidate.id !== zoneId) return candidate;
    const targetIndex = index === undefined ? candidate.artifactIds.length : Math.max(0, Math.min(index, candidate.artifactIds.length));
    const artifactIds = [...candidate.artifactIds];
    artifactIds.splice(targetIndex, 0, artifactId);
    return { ...candidate, artifactIds };
  });
  const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
  const lineage = artifact
    ? notePlacementAssigned(removed.lineage, artifact, zone, new Date())
    : removed.lineage;
  return { ...removed, zones, lineage };
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
      const { lineage } = noteArtifactUpserted(state.lineage, action.artifact, 'direct');
      return stamp(regressReadyProject({ ...state, artifacts, lineage }));
    }
    case 'artifacts/import': {
      const { batch, creates, updates } = action.payload;
      let lineage = state.lineage;
      const batchSeen = lineage.batches.some((candidate) => candidate.id === batch.id);
      if (!batchSeen) {
        lineage = { ...lineage, batches: [...lineage.batches, batch] };
      }
      const updateIds = new Set(updates.map((update) => update.existingId));
      const artifacts = [
        ...state.artifacts.filter((artifact) => !updateIds.has(artifact.id)),
        ...updates.map((update) => update.artifact),
        ...creates,
      ];
      let next = { ...state, artifacts };
      for (const created of creates) {
        ({ lineage } = noteArtifactUpserted(lineage, created, 'import', batch));
      }
      for (const updated of updates) {
        ({ lineage } = noteArtifactUpserted(lineage, updated.artifact, 'direct'));
      }
      next = { ...next, lineage };
      return stamp(regressReadyProject(next));
    }
    case 'artifact/remove': {
      const withoutPlacement = removeArtifactFromZones(state, action.artifactId);
      const removedIssues = withoutPlacement.issues.filter((issue) => issue.artifactId === action.artifactId);
      let lineage = noteArtifactRemoved(withoutPlacement.lineage, action.artifactId);
      for (const issue of removedIssues) {
        lineage = noteIssueRemoved(lineage, issue.id);
      }
      return stamp(regressReadyProject({
        ...withoutPlacement,
        artifacts: withoutPlacement.artifacts.filter((artifact) => artifact.id !== action.artifactId),
        issues: withoutPlacement.issues.filter((issue) => issue.artifactId !== action.artifactId),
        lineage,
      }));
    }
    case 'placement/assign':
      return stamp(regressReadyProject(assignArtifact(state, action.artifactId, action.zoneId, action.index)));
    case 'placement/remove': {
      const next = removeArtifactFromZones(state, action.artifactId);
      return stamp(regressReadyProject({
        ...next,
        lineage: notePlacementRemoved(next.lineage, action.artifactId),
      }));
    }
    case 'placement/reorder':
      return stamp(regressReadyProject(reorderArtifact(state, action.zoneId, action.artifactId, action.direction)));
    case 'issue/add': {
      const zone = state.zones.find((candidate) => candidate.id === action.issue.zoneId);
      let lineage = noteIssueAdded(state.lineage, action.issue);
      lineage = noteIssueZoneLinked(lineage, action.issue, zone);
      return stamp(regressReadyProject({ ...state, issues: [action.issue, ...state.issues], lineage }));
    }
    case 'issue/transition':
      return stamp(regressReadyProject({
        ...state,
        issues: state.issues.map((issue) =>
          issue.id === action.issueId ? transitionIssue(issue, action.status, action.at) : issue,
        ),
        lineage: (() => {
          const issue = state.issues.find((candidate) => candidate.id === action.issueId);
          return issue ? noteIssueTransitioned(state.lineage, issue, action.at ?? new Date()) : state.lineage;
        })(),
      }));
    case 'lineage/acknowledge': {
      let lineage = acknowledgeStaleness(state.lineage, action.nodeId);
      if (action.artifact && action.nodeId === artifactNodeId(action.artifact.id)) {
        lineage = rebaselineArtifact(lineage, action.artifact);
      }
      return stamp({ ...state, lineage });
    }
    case 'snapshot/recorded':
      return stamp({
        ...state,
        lineage: recordSnapshot(state.lineage, action.snapshotId, action.label, state),
      });
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
    case 'workspace/restore':
      // Backups already carry their own lineage; reconcile only structural
      // relationships that are missing (idempotent — never duplicates edges).
      return {
        ...action.state,
        lineage: reconcileLineage(
          action.state.lineage,
          action.state.artifacts,
          action.state.zones,
          action.state.issues,
          'backfill',
        ),
      };
    case 'lineage/reconcile':
      return stamp({ ...state, lineage: action.lineage });
    default:
      return state;
  }
}
