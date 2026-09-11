import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { analyzeRestore as analyzeRestoreState, commitRestore, getDeletionStatus, planDelete, type DeletionPlan, type RestoreAnalysis } from '../domain/deletion';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import type {
  Artifact,
  ArtifactDraft,
  DeletionRecord,
  DeletionTargetKind,
  IssueDraft,
  IssueStatus,
  PlanningPreferences,
  ReadinessResult,
  RestoreDecision,
  RestoreReport,
  Snapshot,
  WorkspaceState,
} from '../domain/models';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import { workspaceReducer, pruneWorkspace } from './reducer';
import { loadWorkspace, saveWorkspace } from './persistence';
import { createSeedWorkspace } from './seed';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  planDeletion: (kind: DeletionTargetKind, targetId: string) => CommandResult<DeletionPlan>;
  executeDeletion: (plan: DeletionPlan) => CommandResult<DeletionRecord>;
  analyzeRestore: (recordId: string) => CommandResult<RestoreAnalysis>;
  restoreDeletion: (recordId: string, decisions?: Record<string, RestoreDecision>) => CommandResult<RestoreReport>;
  getDeletionStatus: (record: DeletionRecord) => ReturnType<typeof getDeletionStatus>;
  recordPublishedPackage: (pkg: { kind: 'snapshot'; snapshot: Snapshot; fileName: string } | { kind: 'zone-checklist'; fileName: string; zoneId: string }) => CommandResult;
  recoveryOpen: boolean;
  openRecovery: () => void;
  closeRecovery: () => void;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => void;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  addIssue: (draft: IssueDraft) => CommandResult;
  removeIssue: (issueId: string) => CommandResult<DeletionPlan>;
  transitionReviewIssue: (issueId: string, status: IssueStatus) => CommandResult;
  updatePreferences: (preferences: PlanningPreferences) => void;
  checkReadiness: () => ReadinessResult;
  createSnapshot: () => CommandResult<Snapshot>;
  resetWorkspace: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => pruneWorkspace(loadWorkspace()));
  const [storageHealthy, setStorageHealthy] = useState(true);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const openRecovery = useCallback(() => setRecoveryOpen(true), []);
  const closeRecovery = useCallback(() => setRecoveryOpen(false), []);

  useEffect(() => {
    setStorageHealthy(saveWorkspace(state));
  }, [state]);

  const upsertArtifact = useCallback((draft: ArtifactDraft, existing?: Artifact): CommandResult<Artifact> => {
    const validation = validateArtifactDraft(draft, state.artifacts, existing?.id);
    if (validation.length) {
      return {
        ok: false,
        errors: Object.fromEntries(validation.map((error) => [error.field, error.message])),
        message: 'Review the highlighted fields before saving.',
      };
    }
    const artifact = artifactFromDraft(draft, existing);
    dispatch({ type: 'artifact/upsert', artifact });
    return { ok: true, value: artifact };
  }, [state.artifacts]);

  const planDeletion = useCallback((kind: DeletionTargetKind, targetId: string): CommandResult<DeletionPlan> => {
    try {
      return { ok: true, value: planDelete(state, kind, targetId) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The deletion could not be prepared.' };
    }
  }, [state]);

  const executeDeletion = useCallback((plan: DeletionPlan): CommandResult<DeletionRecord> => {
    const exists = plan.record.kind === 'artifact'
      ? state.artifacts.some((artifact) => artifact.id === plan.record.targetId)
      : plan.record.kind === 'zone'
        ? state.zones.some((zone) => zone.id === plan.record.targetId)
        : state.issues.some((issue) => issue.id === plan.record.targetId);
    if (!exists) return { ok: false, message: 'The record was changed by another edit; close this dialog and review the current plan.' };
    if (plan.record.kind === 'artifact') dispatch({ type: 'artifact/delete', record: plan.record });
    else if (plan.record.kind === 'zone') dispatch({ type: 'zone/delete', record: plan.record });
    else dispatch({ type: 'issue/delete', record: plan.record });
    return { ok: true, value: plan.record };
  }, [state]);

  const analyzeRestoreCommand = useCallback((recordId: string): CommandResult<RestoreAnalysis> => {
    try {
      return { ok: true, value: analyzeRestoreState(state, recordId) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The deletion record could not be read.' };
    }
  }, [state]);

  const restoreDeletion = useCallback((recordId: string, decisions: Record<string, RestoreDecision> = {}): CommandResult<RestoreReport> => {
    try {
      const result = commitRestore(state, recordId, decisions);
      if (!result.applied) {
        return { ok: false, value: result.report, message: 'Nothing was restored — every part of this deletion was set to skip. The current plan is unchanged.' };
      }
      dispatch({ type: 'deletion/restore', recordId, decisions, at: result.report.restoredAt });
      return { ok: true, value: result.report };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The deletion could not be restored.' };
    }
  }, [state]);

  const recordPublishedPackage = useCallback((input: { kind: 'snapshot'; snapshot: Snapshot; fileName: string } | { kind: 'zone-checklist'; fileName: string; zoneId: string }): CommandResult => {
    if (input.kind === 'zone-checklist') {
      const zone = state.zones.find((candidate) => candidate.id === input.zoneId);
      if (!zone) return { ok: false, message: 'The selected area no longer exists.' };
      dispatch({
        type: 'package/publish',
        pkg: {
          id: createId('package'),
          kind: 'zone-checklist',
          fileName: input.fileName,
          publishedAt: new Date().toISOString(),
          projectTitle: state.project.title,
          zoneId: zone.id,
          artifactIds: zone.artifactIds,
          issueIds: state.issues
            .filter((issue) => issue.zoneId === zone.id || (issue.artifactId && zone.artifactIds.includes(issue.artifactId)))
            .map((issue) => issue.id),
        },
      });
      return { ok: true };
    }
    const { snapshot, fileName } = input;
    dispatch({
      type: 'package/publish',
      pkg: {
        id: createId('package'),
        kind: 'snapshot',
        fileName,
        publishedAt: snapshot.generatedAt,
        projectTitle: snapshot.project.title,
        zoneIds: snapshot.zones.map((zone) => zone.id),
        artifactIds: snapshot.zones.flatMap((zone) => zone.artifacts.map((artifact) => artifact.id)),
        issueIds: snapshot.unresolvedIssues.map((issue) => issue.id),
      },
    });
    return { ok: true };
  }, [state]);

  const assignArtifact = useCallback((artifactId: string, zoneId: string): CommandResult => {
    try {
      dispatch({ type: 'placement/assign', artifactId, zoneId });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Placement could not be updated.' };
    }
  }, []);

  const removePlacement = useCallback((artifactId: string) => {
    dispatch({ type: 'placement/remove', artifactId });
  }, []);

  const reorderArtifact = useCallback((zoneId: string, artifactId: string, direction: -1 | 1): CommandResult => {
    try {
      dispatch({ type: 'placement/reorder', zoneId, artifactId, direction });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Object sequence could not be changed.' };
    }
  }, []);

  const addIssue = useCallback((draft: IssueDraft): CommandResult => {
    if (!draft.title.trim()) return { ok: false, errors: { title: 'A finding title is required.' } };
    if (draft.description.trim().length < 16) return { ok: false, errors: { description: 'Add at least 16 characters of context.' } };
    if (!draft.owner.trim()) return { ok: false, errors: { owner: 'Assign an owner.' } };
    const now = new Date().toISOString();
    dispatch({
      type: 'issue/add',
      issue: {
        id: createId('issue'),
        title: draft.title.trim(),
        description: draft.description.trim(),
        severity: draft.severity,
        status: 'open',
        owner: draft.owner.trim(),
        zoneId: draft.zoneId || undefined,
        artifactId: draft.artifactId || undefined,
        createdAt: now,
        updatedAt: now,
      },
    });
    return { ok: true };
  }, []);

  const removeIssue = useCallback((issueId: string): CommandResult<DeletionPlan> => {
    const result = planDeletion('issue', issueId);
    return result;
  }, [planDeletion]);

  const transitionReviewIssue = useCallback((issueId: string, status: IssueStatus): CommandResult => {
    const issue = state.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    try {
      dispatch({ type: 'issue/transition', issueId, status });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Status could not be changed.' };
    }
  }, [state.issues]);

  const updatePreferences = useCallback((preferences: PlanningPreferences) => {
    dispatch({ type: 'preferences/update', preferences });
  }, []);

  const checkReadiness = useCallback(() => {
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const result = evaluateReadiness(state, analysis);
    dispatch({ type: 'project/readiness', ready: result.ready, checkedAt: result.checkedAt });
    return result;
  }, [state]);

  const createSnapshot = useCallback((): CommandResult<Snapshot> => {
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis);
    if (!readiness.ready) return { ok: false, message: readiness.blockers[0] ?? 'The plan is not ready.' };
    return { ok: true, value: buildSnapshot(state, analysis, readiness) };
  }, [state]);

  const resetWorkspace = useCallback(() => dispatch({ type: 'workspace/reset', state: createSeedWorkspace() }), []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    storageHealthy,
    upsertArtifact,
    planDeletion,
    executeDeletion,
    analyzeRestore: analyzeRestoreCommand,
    restoreDeletion,
    getDeletionStatus,
    recordPublishedPackage,
    assignArtifact,
    removePlacement,
    reorderArtifact,
    addIssue,
    removeIssue,
    transitionReviewIssue,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    recoveryOpen,
    openRecovery,
    closeRecovery,
    resetWorkspace,
  }), [state, storageHealthy, upsertArtifact, planDeletion, executeDeletion, analyzeRestoreCommand, restoreDeletion, recordPublishedPackage, assignArtifact, removePlacement, reorderArtifact, addIssue, removeIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, recoveryOpen, openRecovery, closeRecovery, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
