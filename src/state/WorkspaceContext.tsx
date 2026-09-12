import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import {
  PlanTransactionError,
  commitPlanTransaction,
  preparePlanBatch,
  revertPlanTransaction,
  type PlanBatchPreview,
  type PlanSuggestion,
  type PlanTransaction,
} from '../domain/planTransaction';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, ScenarioInput, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { loadWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

interface PlanCommitResult {
  ok: boolean;
  message?: string;
  transaction?: PlanTransaction;
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  lastTransaction: PlanTransaction | null;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  removeArtifact: (artifactId: string) => CommandResult;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => void;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  addIssue: (draft: IssueDraft) => CommandResult;
  transitionReviewIssue: (issueId: string, status: IssueStatus) => CommandResult;
  updatePreferences: (preferences: PlanningPreferences) => void;
  prepareBatch: (suggestions: PlanSuggestion[], selectedIds: string[], scenarioInput: ScenarioInput) => PlanBatchPreview;
  commitBatch: (preview: PlanBatchPreview) => PlanCommitResult;
  undoLastTransaction: () => CommandResult;
  dismissUndo: () => void;
  checkReadiness: () => ReadinessResult;
  createSnapshot: () => CommandResult<Snapshot>;
  resetWorkspace: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => loadWorkspace());
  const [storageHealthy, setStorageHealthy] = useState(true);
  const [lastTransaction, setLastTransaction] = useState<PlanTransaction | null>(null);

  // Latest state for command callbacks that must validate against the live
  // revision rather than the render they were created in.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Retained for the undo guard; undo validates against the same transaction
  // that was committed, even across re-renders.
  const lastTransactionRef = useRef<PlanTransaction | null>(null);
  lastTransactionRef.current = lastTransaction;

  useEffect(() => {
    setStorageHealthy(saveWorkspace(state));
  }, [state]);

  // Adopt plan changes persisted in another browser tab. Prepared batches
  // retain their base revision, so a batch committed against stale data is
  // rejected wholesale instead of overwriting the external edit.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const external = JSON.parse(event.newValue) as WorkspaceState;
        if (external.version === 1 && external.revision !== stateRef.current.revision) {
          dispatch({ type: 'workspace/sync-external', state: external });
        }
      } catch {
        // Malformed external writes are ignored; local state remains intact.
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const upsertArtifact = useCallback((draft: ArtifactDraft, existing?: Artifact): CommandResult<Artifact> => {
    const validation = validateArtifactDraft(draft, stateRef.current.artifacts, existing?.id);
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
  }, []);

  const removeArtifact = useCallback((artifactId: string): CommandResult => {
    const artifact = stateRef.current.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return { ok: false, message: 'The selected object no longer exists.' };
    dispatch({ type: 'artifact/remove', artifactId });
    return { ok: true };
  }, []);

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
    const issue = stateRef.current.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    try {
      dispatch({ type: 'issue/transition', issueId, status });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Status could not be changed.' };
    }
  }, []);

  const updatePreferences = useCallback((preferences: PlanningPreferences) => {
    dispatch({ type: 'preferences/update', preferences });
  }, []);

  const prepareBatch = useCallback((suggestions: PlanSuggestion[], selectedIds: string[], scenarioInput: ScenarioInput): PlanBatchPreview => {
    return preparePlanBatch(stateRef.current, suggestions, selectedIds, scenarioInput);
  }, []);

  const commitBatch = useCallback((preview: PlanBatchPreview): PlanCommitResult => {
    const live = stateRef.current;
    const transactionId = createId('plan');
    try {
      const { transaction } = commitPlanTransaction(live, preview, { id: transactionId });
      dispatch({ type: 'plan-transaction/commit', preview, transactionId });
      setLastTransaction(transaction);
      return { ok: true, transaction };
    } catch (error) {
      if (error instanceof PlanTransactionError) {
        return { ok: false, message: error.issues[0]?.message ?? 'The planning batch could not be applied.' };
      }
      return { ok: false, message: 'The planning batch could not be applied.' };
    }
  }, []);

  const undoLastTransaction = useCallback((): CommandResult => {
    const transaction = lastTransactionRef.current;
    if (!transaction) return { ok: false, message: 'There is no applied planning transaction to undo.' };
    try {
      revertPlanTransaction(stateRef.current, transaction);
    } catch (error) {
      if (error instanceof PlanTransactionError) {
        return { ok: false, message: error.issues[0]?.message ?? 'The plan changed and this transaction can no longer be undone.' };
      }
      return { ok: false, message: 'The transaction could not be undone.' };
    }
    dispatch({ type: 'plan-transaction/revert', transaction });
    setLastTransaction(null);
    return { ok: true };
  }, []);

  // Keep a ref so the revert guard reads the transaction that was validated,
  // even if the state update from dispatch re-renders between calls.
  const dismissUndo = useCallback(() => setLastTransaction(null), []);

  const checkReadiness = useCallback(() => {
    const current = stateRef.current;
    const analysis = analyzeJourney(current.artifacts, current.zones);
    const result = evaluateReadiness(current, analysis);
    dispatch({ type: 'project/readiness', ready: result.ready, checkedAt: result.checkedAt });
    return result;
  }, []);

  const createSnapshot = useCallback((): CommandResult<Snapshot> => {
    const current = stateRef.current;
    const analysis = analyzeJourney(current.artifacts, current.zones);
    const readiness = evaluateReadiness(current, analysis);
    if (!readiness.ready) return { ok: false, message: readiness.blockers[0] ?? 'The plan is not ready.' };
    return { ok: true, value: buildSnapshot(current, analysis, readiness) };
  }, []);

  const resetWorkspace = useCallback(() => {
    setLastTransaction(null);
    dispatch({ type: 'workspace/reset', state: createSeedWorkspace() });
  }, []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    storageHealthy,
    lastTransaction,
    upsertArtifact,
    removeArtifact,
    assignArtifact,
    removePlacement,
    reorderArtifact,
    addIssue,
    transitionReviewIssue,
    updatePreferences,
    prepareBatch,
    commitBatch,
    undoLastTransaction,
    dismissUndo,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, storageHealthy, lastTransaction, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, prepareBatch, commitBatch, undoLastTransaction, dismissUndo, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
