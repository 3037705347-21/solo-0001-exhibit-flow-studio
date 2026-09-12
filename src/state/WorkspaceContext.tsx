import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import {
  commitBatchTransaction,
  planBatchTransaction,
  validatePatchShape,
  type BatchCommitOutcome,
  type BatchItemResult,
  type BatchPatch,
  type BatchTransaction,
} from '../domain/batchTransaction';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { loadWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

export type BatchReviewResult =
  | { ok: true; transaction: BatchTransaction }
  | { ok: false; transactionId: string; items: BatchItemResult[]; errors?: Record<string, string> };

export type BatchSubmitResult =
  | { ok: true; duplicate: boolean; applied: number; transactionId: string; committedAt: string }
  | { ok: false; duplicate: boolean; transactionId: string; items: BatchItemResult[] };

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  removeArtifact: (artifactId: string) => CommandResult;
  prepareBatchEdit: (
    selections: Array<{ artifactId: string; baseRevision: string; patch: BatchPatch }>,
  ) => BatchReviewResult;
  commitBatchEdit: (transaction: BatchTransaction) => BatchSubmitResult;
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

/** Always points at the latest committed state, even inside a stable callback. */
function useUpdatedStateRef(state: WorkspaceState) {
  const ref = useRef(state);
  useEffect(() => {
    ref.current = state;
  }, [state]);
  return ref;
}

/** Tracks a synchronously-mutable value so rapid double submits are de-duplicated. */
function useRefValue<T>(initial: T) {
  const ref = useRef(initial);
  return ref;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => loadWorkspace());
  const [storageHealthy, setStorageHealthy] = useState(true);
  const stateRef = useUpdatedStateRef(state);
  const committedBatchIdsRef = useRefValue(new Set<string>());

  useEffect(() => {
    setStorageHealthy(saveWorkspace(state));
  }, [state]);

  // Another browser tab is a legitimate source of "other edits": adopt the
  // newest persisted revision so an open batch transaction re-reads it at
  // commit time instead of silently overwriting concurrent work.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        const next = JSON.parse(event.newValue) as WorkspaceState;
        if (next.version === 1 && Array.isArray(next.artifacts)) dispatch({ type: 'workspace/reset', state: next });
      } catch {
        // Ignore malformed cross-tab payloads.
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    committedBatchIdsRef.current = new Set(state.batchTransactions.map((record) => record.id));
  }, [state.batchTransactions, committedBatchIdsRef]);

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

  /**
   * Step 1 of the auditable workflow: validate the patch surface and build a
   * transaction plan carrying the revision each object was reviewed at.
   */
  const prepareBatchEdit = useCallback((selections: Parameters<WorkspaceContextValue['prepareBatchEdit']>[0]): BatchReviewResult => {
    const transactionId = createId('batch');
    const shapeErrors = selections.flatMap((selection) => validatePatchShape(selection.patch as Record<string, unknown>));
    if (shapeErrors.length || selections.length === 0) {
      return {
        ok: false,
        transactionId,
        items: [],
        errors: shapeErrors.length
          ? Object.fromEntries(shapeErrors.map((error) => [error.field, error.message]))
          : { selection: 'Select at least one object for the batch edit.' },
      };
    }
    const { transaction, items } = planBatchTransaction({
      id: transactionId,
      artifacts: stateRef.current.artifacts,
      selections,
    });
    if (!transaction) return { ok: false, transactionId, items };
    const hasChanges = transaction.items.some((item) => item.changes.length > 0);
    if (!hasChanges) {
      return {
        ok: false,
        transactionId,
        items: [],
        errors: { patch: 'None of the selected values differ from the current records.' },
      };
    }
    return { ok: true, transaction };
  }, [stateRef]);

  /**
   * Step 2: re-read every object at submit time and apply the transaction as a
   * single atomic action. Any stale, missing, or invalid record rejects the
   * entire batch; a repeated transaction id returns the recorded result.
   */
  const commitBatchEdit = useCallback((transaction: BatchTransaction): BatchSubmitResult => {
    if (committedBatchIdsRef.current.has(transaction.id)) {
      const record = stateRef.current.batchTransactions.find((entry) => entry.id === transaction.id);
      return record
        ? { ok: true, duplicate: true, applied: record.itemCount, transactionId: record.id, committedAt: record.committedAt }
        : { ok: false, duplicate: true, transactionId: transaction.id, items: [] };
    }
    const outcome: BatchCommitOutcome = commitBatchTransaction({
      state: stateRef.current,
      audit: { transactions: stateRef.current.batchTransactions },
      transaction,
    });
    if (outcome.status === 'duplicate') {
      committedBatchIdsRef.current.add(outcome.transaction.id);
      return {
        ok: true,
        duplicate: true,
        applied: outcome.transaction.itemCount,
        transactionId: outcome.transaction.id,
        committedAt: outcome.transaction.committedAt,
      };
    }
    if (outcome.status === 'rejected') {
      return { ok: false, duplicate: false, transactionId: transaction.id, items: outcome.items };
    }
    committedBatchIdsRef.current.add(outcome.transaction.id);
    const updatedArtifacts = outcome.state.artifacts.filter((artifact) =>
      outcome.transaction.artifactIds.includes(artifact.id)
      && artifact.updatedAt === outcome.transaction.appliedRevision,
    );
    dispatch({
      type: 'artifact/batchCommit',
      artifacts: updatedArtifacts,
      record: outcome.transaction,
    });
    return {
      ok: true,
      duplicate: false,
      applied: outcome.transaction.itemCount,
      transactionId: outcome.transaction.id,
      committedAt: outcome.transaction.committedAt,
    };
  }, [stateRef, committedBatchIdsRef]);

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
    prepareBatchEdit,
    commitBatchEdit,
    assignArtifact,
    removePlacement,
    reorderArtifact,
    addIssue,
    transitionReviewIssue,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, storageHealthy, upsertArtifact, removeArtifact, prepareBatchEdit, commitBatchEdit, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
