import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import {
  buildCreationRevision,
  buildStatusRevision,
  confirmIssueMerge,
  prepareIssueEdit,
  validateIssueDraft,
  type IssueEditInput,
  type IssueMergePreview,
} from '../domain/issueRevisions';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { transitionIssue } from '../domain/transitions';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, ReviewIssue, Snapshot, WorkspaceState } from '../domain/models';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import { workspaceReducer } from './reducer';
import { loadWorkspace, saveWorkspace } from './persistence';
import { createSeedWorkspace } from './seed';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

export interface IssueEditResponse {
  ok: boolean;
  errors?: Record<string, string>;
  message?: string;
  issue?: ReviewIssue;
  conflict?: { current: ReviewIssue; preview: IssueMergePreview };
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  removeArtifact: (artifactId: string) => CommandResult;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => void;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  addIssue: (draft: IssueDraft) => CommandResult;
  saveIssueEdit: (input: IssueEditInput) => IssueEditResponse;
  resolveIssueEditConflict: (input: IssueEditInput, decision: 'merge' | 'discard') => IssueEditResponse;
  transitionReviewIssue: (issueId: string, status: IssueStatus) => CommandResult;
  updatePreferences: (preferences: PlanningPreferences) => void;
  checkReadiness: () => ReadinessResult;
  createSnapshot: () => CommandResult<Snapshot>;
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

  const addIssue = useCallback((draft: IssueDraft): CommandResult => {
    const errors = validateIssueDraft(draft);
    if (Object.keys(errors).length) return { ok: false, errors };
    const now = new Date().toISOString();
    const issue: ReviewIssue = {
      id: createId('issue'),
      title: draft.title.trim(),
      description: draft.description.trim(),
      severity: draft.severity,
      status: 'open',
      owner: draft.owner.trim(),
      zoneId: draft.zoneId || undefined,
      artifactId: draft.artifactId || undefined,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    dispatch({ type: 'issue/add', issue, revision: buildCreationRevision(issue) });
    return { ok: true };
  }, []);

  const saveIssueEdit = useCallback((input: IssueEditInput): IssueEditResponse => {
    const current = state.issues.find((candidate) => candidate.id === input.issueId);
    const result = prepareIssueEdit(current, input);
    switch (result.kind) {
      case 'missing':
        return { ok: false, message: 'The selected review finding no longer exists.' };
      case 'invalid':
        return { ok: false, errors: result.errors, message: 'Review the highlighted fields before saving.' };
      case 'unchanged':
        return { ok: false, message: 'No changes to save.' };
      case 'conflict':
        return { ok: false, conflict: { current: result.current, preview: result.preview } };
      case 'committed':
        dispatch({ type: 'issue/revise', issue: result.issue, revision: result.revision });
        return { ok: true, issue: result.issue };
    }
  }, [state.issues]);

  const resolveIssueEditConflict = useCallback((input: IssueEditInput, decision: 'merge' | 'discard'): IssueEditResponse => {
    if (decision === 'discard') return { ok: true, message: 'Edit discarded; the latest stored values were kept.' };
    const current = state.issues.find((candidate) => candidate.id === input.issueId);
    const result = confirmIssueMerge(current, input);
    switch (result.kind) {
      case 'missing':
        return { ok: false, message: 'The selected review finding no longer exists.' };
      case 'unchanged':
        return { ok: true, message: 'The latest version already includes these changes.' };
      case 'committed':
        dispatch({ type: 'issue/revise', issue: result.issue, revision: result.revision });
        return { ok: true, issue: result.issue };
    }
  }, [state.issues]);

  const transitionReviewIssue = useCallback((issueId: string, status: IssueStatus): CommandResult => {
    const issue = state.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    try {
      const next = transitionIssue(issue, status);
      if (next === issue) return { ok: true };
      dispatch({ type: 'issue/transition', issue: next, revision: buildStatusRevision(issue, next) });
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
    removeArtifact,
    assignArtifact,
    removePlacement,
    reorderArtifact,
    addIssue,
    saveIssueEdit,
    resolveIssueEditConflict,
    transitionReviewIssue,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, storageHealthy, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, saveIssueEdit, resolveIssueEditConflict, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
