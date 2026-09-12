import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { resolveZoneReorder, type ReorderOutcome } from '../domain/reorder';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { loadWorkspace, parseWorkspace, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';
import { canRedo as historyCanRedo, canUndo as historyCanUndo, createHistory, pushHistory, redoHistory, undoHistory, type WorkspaceHistory } from './undoStack';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  removeArtifact: (artifactId: string) => CommandResult;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => void;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1, expectedVersion: number, baseOrder: string[]) => CommandResult<ReorderOutcome>;
  moveArtifactTo: (zoneId: string, artifactId: string, targetIndex: number, expectedVersion: number, baseOrder: string[]) => CommandResult<ReorderOutcome>;
  undo: () => void;
  redo: () => void;
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
  const stateRef = useRef(state);
  const historyRef = useRef<WorkspaceHistory>(createHistory(state));
  const [historyTick, setHistoryTick] = useState(0);
  /** Serialized state this tab last wrote or adopted, to avoid save/adopt echo loops. */
  const lastSavedRef = useRef<string | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const serialized = JSON.stringify(state);
    if (serialized === lastSavedRef.current) return;
    lastSavedRef.current = serialized;
    setStorageHealthy(saveWorkspace(state));
  }, [state]);

  useEffect(() => {
    const history = historyRef.current;
    if (state === history.present) return;
    historyRef.current = pushHistory(history, state);
    setHistoryTick((tick) => tick + 1);
  }, [state]);

  /**
   * Adopt a persisted state written by another tab. Returns the state the
   * caller should treat as current (the adopted one, or the in-memory state
   * when storage holds nothing new).
   */
  const syncFromStorage = useCallback((): WorkspaceState => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return stateRef.current;
    }
    if (raw === null || raw === lastSavedRef.current) return stateRef.current;
    const incoming = parseWorkspace(raw);
    if (!incoming) return stateRef.current;
    lastSavedRef.current = raw;
    dispatch({ type: 'workspace/external', state: incoming });
    return incoming;
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || event.newValue == null) return;
      syncFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [syncFromStorage]);

  /**
   * Shared reorder pipeline: re-read persisted state (another tab may have
   * written while this one was backgrounded), resolve the intent against the
   * authoritative order and version, then commit with a compare-and-swap
   * guard so a stale resolution can never overwrite newer edits.
   */
  const requestReorder = useCallback((zoneId: string, artifactId: string, targetIndex: number, expectedVersion: number, baseOrder: string[]): CommandResult<ReorderOutcome> => {
    const live = syncFromStorage();
    const zone = live.zones.find((candidate) => candidate.id === zoneId);
    if (!zone) return { ok: false, value: { kind: 'conflict' }, message: 'This zone no longer exists.' };
    const resolution = resolveZoneReorder({
      baseOrder,
      currentOrder: zone.artifactIds,
      artifactId,
      targetIndex,
      versionMismatch: zone.version !== expectedVersion,
      titleOf: (id) => live.artifacts.find((artifact) => artifact.id === id)?.title ?? id,
    });
    if (resolution.kind === 'noop') return { ok: true, value: { kind: 'noop' } };
    if (resolution.kind === 'conflict') {
      return { ok: false, value: { kind: 'conflict', changes: resolution.changes }, message: resolution.reason };
    }
    dispatch({
      type: 'placement/reorder',
      zoneId,
      artifactId,
      expectedVersion: zone.version,
      nextOrder: resolution.nextOrder,
    });
    return {
      ok: true,
      value: resolution.kind === 'apply' ? { kind: 'applied' } : { kind: 'rebased', changes: resolution.changes },
    };
  }, [syncFromStorage]);

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

  const reorderArtifact = useCallback((zoneId: string, artifactId: string, direction: -1 | 1, expectedVersion: number, baseOrder: string[]): CommandResult<ReorderOutcome> => {
    const fromIndex = baseOrder.indexOf(artifactId);
    const targetIndex = (fromIndex === -1 ? 0 : fromIndex) + direction;
    return requestReorder(zoneId, artifactId, targetIndex, expectedVersion, baseOrder);
  }, [requestReorder]);

  const moveArtifactTo = useCallback((zoneId: string, artifactId: string, targetIndex: number, expectedVersion: number, baseOrder: string[]): CommandResult<ReorderOutcome> => {
    return requestReorder(zoneId, artifactId, targetIndex, expectedVersion, baseOrder);
  }, [requestReorder]);

  const undo = useCallback(() => {
    const next = undoHistory(historyRef.current);
    if (next === historyRef.current) return;
    historyRef.current = next;
    dispatch({ type: 'workspace/restore', state: next.present });
    setHistoryTick((tick) => tick + 1);
  }, []);

  const redo = useCallback(() => {
    const next = redoHistory(historyRef.current);
    if (next === historyRef.current) return;
    historyRef.current = next;
    dispatch({ type: 'workspace/restore', state: next.present });
    setHistoryTick((tick) => tick + 1);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && event.shiftKey) { event.preventDefault(); redo(); }
      else if (key === 'z') { event.preventDefault(); undo(); }
      else if (key === 'y') { event.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undo, redo]);

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
    canUndo: historyCanUndo(historyRef.current),
    canRedo: historyCanRedo(historyRef.current),
    upsertArtifact,
    removeArtifact,
    assignArtifact,
    removePlacement,
    reorderArtifact,
    moveArtifactTo,
    undo,
    redo,
    addIssue,
    transitionReviewIssue,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, storageHealthy, historyTick, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, moveArtifactTo, undo, redo, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
