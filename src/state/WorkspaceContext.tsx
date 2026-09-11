import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { buildImportPlan, type CsvImportAnalysis } from '../domain/csvImport';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, Snapshot, WorkspaceState } from '../domain/models';
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
  importArtifacts: (analysis: CsvImportAnalysis, options?: { skipConflicts?: boolean }) => CommandResult<{ added: number; updated: number; skipped: number }>;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => void;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  addIssue: (draft: IssueDraft) => CommandResult;
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

  const importArtifacts = useCallback((analysis: CsvImportAnalysis, options: { skipConflicts?: boolean } = {}): CommandResult<{ added: number; updated: number; skipped: number }> => {
    // Replan against the current collection: the preview may predate other edits.
    const plan = buildImportPlan(analysis, state.artifacts, options);
    if (!plan || plan.length === 0) {
      return { ok: false, message: 'Resolve field errors and conflicts before importing.' };
    }
    const updated = plan.filter((artifact) => state.artifacts.some((existing) => existing.id === artifact.id)).length;
    const skipped = options.skipConflicts ? analysis.rows.filter((row) => row.status === 'conflict').length : 0;
    try {
      // One dispatch, one reducer commit, one persistence write — atomic batch.
      dispatch({ type: 'artifacts/import', artifacts: plan });
      return { ok: true, value: { added: plan.length - updated, updated, skipped } };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The import could not be written.' };
    }
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
    removeArtifact,
    importArtifacts,
    assignArtifact,
    removePlacement,
    reorderArtifact,
    addIssue,
    transitionReviewIssue,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, storageHealthy, upsertArtifact, removeArtifact, importArtifacts, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
