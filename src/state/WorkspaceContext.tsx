import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { canTransitionStatus, issueFromInput } from '../domain/issueHistory';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, IssueDraft, IssueSeverity, IssueStatus, PlanningPreferences, ReadinessResult, ReviewIssue, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
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
  removeArtifact: (artifactId: string) => CommandResult;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => void;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  addIssue: (draft: IssueDraft) => CommandResult<ReviewIssue>;
  transitionReviewIssue: (issueId: string, status: IssueStatus, options?: { actor?: string; note?: string }) => CommandResult;
  editIssue: (
    issueId: string,
    patch: { title?: string; description?: string; severity?: IssueSeverity; zoneId?: string; artifactId?: string },
    options?: { actor?: string; note?: string },
  ) => CommandResult;
  reassignIssue: (issueId: string, owner: string, options?: { actor?: string; note?: string }) => CommandResult;
  updatePreferences: (preferences: PlanningPreferences) => void;
  checkReadiness: () => ReadinessResult;
  createSnapshot: (options?: { includeHistory?: boolean }) => CommandResult<Snapshot>;
  resetWorkspace: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => loadWorkspace());
  const [storageHealthy, setStorageHealthy] = useState(true);

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

  const removeArtifact = useCallback((artifactId: string): CommandResult => {
    const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return { ok: false, message: 'The selected object no longer exists.' };
    dispatch({ type: 'artifact/remove', artifactId });
    return { ok: true };
  }, [state.artifacts]);

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

  const addIssue = useCallback((draft: IssueDraft): CommandResult<ReviewIssue> => {
    if (!draft.title.trim()) return { ok: false, errors: { title: 'A finding title is required.' } };
    if (draft.description.trim().length < 16) return { ok: false, errors: { description: 'Add at least 16 characters of context.' } };
    if (!draft.owner.trim()) return { ok: false, errors: { owner: 'Assign an owner.' } };
    const issue = issueFromInput(createId('issue'), {
      title: draft.title.trim(),
      description: draft.description.trim(),
      severity: draft.severity,
      owner: draft.owner.trim(),
      zoneId: draft.zoneId || undefined,
      artifactId: draft.artifactId || undefined,
    });
    dispatch({ type: 'issue/add', issue });
    return { ok: true, value: issue };
  }, []);

  const transitionReviewIssue = useCallback((issueId: string, status: IssueStatus, options?: { actor?: string; note?: string }): CommandResult => {
    const issue = state.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    if (issue.status === status) return { ok: true };
    // Validate against the lifecycle before dispatching so an illegal move
    // surfaces as a command failure instead of crashing the reducer.
    const allowed = canTransitionStatus(issue.status, status);
    if (!allowed) {
      return { ok: false, message: `Cannot move a review finding from ${issue.status} to ${status}.` };
    }
    dispatch({
      type: 'issue/transition',
      issueId,
      status,
      ...(options?.actor ? { actor: options.actor } : {}),
      ...(options?.note?.trim() ? { note: options.note.trim() } : {}),
    });
    return { ok: true };
  }, [state.issues]);

  const editIssue = useCallback((
    issueId: string,
    patch: { title?: string; description?: string; severity?: IssueSeverity; zoneId?: string; artifactId?: string },
    options?: { actor?: string; note?: string },
  ): CommandResult => {
    const issue = state.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    if (patch.title !== undefined && !patch.title.trim()) return { ok: false, errors: { title: 'A finding title is required.' } };
    if (patch.description !== undefined && patch.description.trim().length < 16) {
      return { ok: false, errors: { description: 'Add at least 16 characters of context.' } };
    }
    dispatch({
      type: 'issue/edit',
      issueId,
      patch: {
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
        ...(patch.severity !== undefined ? { severity: patch.severity } : {}),
        ...(patch.zoneId !== undefined ? { zoneId: patch.zoneId || '' } : {}),
        ...(patch.artifactId !== undefined ? { artifactId: patch.artifactId || '' } : {}),
      },
      ...(options?.actor ? { actor: options.actor } : {}),
      ...(options?.note?.trim() ? { note: options.note.trim() } : {}),
    });
    return { ok: true };
  }, [state.issues]);

  const reassignIssue = useCallback((issueId: string, owner: string, options?: { actor?: string; note?: string }): CommandResult => {
    const issue = state.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    if (!owner.trim()) return { ok: false, errors: { owner: 'Assign an owner.' } };
    dispatch({
      type: 'issue/reassign',
      issueId,
      owner: owner.trim(),
      ...(options?.actor ? { actor: options.actor } : {}),
      ...(options?.note?.trim() ? { note: options.note.trim() } : {}),
    });
    return { ok: true };
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

  const createSnapshot = useCallback((options?: { includeHistory?: boolean }): CommandResult<Snapshot> => {
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis);
    if (!readiness.ready) return { ok: false, message: readiness.blockers[0] ?? 'The plan is not ready.' };
    return { ok: true, value: buildSnapshot(state, analysis, readiness, options) };
  }, [state]);

  const resetWorkspace = useCallback(() => dispatch({ type: 'workspace/reset', state: createSeedWorkspace() }), []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    storageHealthy,
    upsertArtifact,
    removeArtifact,
    assignArtifact,
    removePlacement,
    reorderArtifact,
    addIssue,
    transitionReviewIssue,
    editIssue,
    reassignIssue,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, storageHealthy, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, editIssue, reassignIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
