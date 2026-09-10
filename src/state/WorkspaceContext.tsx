import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { appendHistory, createHistoryEntry, historyContextFromState, type HistoryEntry } from '../domain/commandLog';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { loadWorkspace, saveWorkspace } from './persistence';
import { loadActivityHistory, saveActivityHistory } from './activityHistory';
import { createSeedWorkspace } from './seed';
import type { WorkspaceAction } from './actions';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

export interface WorkspaceContextValue {
  state: WorkspaceState;
  history: HistoryEntry[];
  storageHealthy: boolean;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  removeArtifact: (artifactId: string) => CommandResult;
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
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadActivityHistory());
  const [storageHealthy, setStorageHealthy] = useState(true);
  // Always points at the state before the current dispatch, which is exactly
  // the context history summaries need (prior placement, prior record, …).
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    setStorageHealthy(saveWorkspace(state));
  }, [state]);

  useEffect(() => {
    saveActivityHistory(history);
  }, [history]);

  const recordAction = useCallback((action: WorkspaceAction) => {
    const entry = createHistoryEntry(action, historyContextFromState(stateRef.current), createId('event'));
    setHistory((entries) => appendHistory(entries, entry));
  }, []);

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
    const action: WorkspaceAction = { type: 'artifact/upsert', artifact };
    dispatch(action);
    recordAction(action);
    return { ok: true, value: artifact };
  }, [state.artifacts, recordAction]);

  const removeArtifact = useCallback((artifactId: string): CommandResult => {
    const artifact = state.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return { ok: false, message: 'The selected object no longer exists.' };
    const action: WorkspaceAction = { type: 'artifact/remove', artifactId };
    dispatch(action);
    recordAction(action);
    return { ok: true };
  }, [state.artifacts, recordAction]);

  const assignArtifact = useCallback((artifactId: string, zoneId: string): CommandResult => {
    const action: WorkspaceAction = { type: 'placement/assign', artifactId, zoneId };
    try {
      dispatch(action);
      recordAction(action);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Placement could not be updated.' };
    }
  }, [recordAction]);

  const removePlacement = useCallback((artifactId: string) => {
    const action: WorkspaceAction = { type: 'placement/remove', artifactId };
    dispatch(action);
    recordAction(action);
  }, [recordAction]);

  const reorderArtifact = useCallback((zoneId: string, artifactId: string, direction: -1 | 1): CommandResult => {
    // A boundary move changes nothing; keep the command result but skip the log.
    const zone = stateRef.current.zones.find((candidate) => candidate.id === zoneId);
    const currentIndex = zone?.artifactIds.indexOf(artifactId) ?? -1;
    const action: WorkspaceAction = { type: 'placement/reorder', zoneId, artifactId, direction };
    try {
      dispatch(action);
      if (zone && currentIndex >= 0 && currentIndex + direction >= 0 && currentIndex + direction < zone.artifactIds.length) {
        recordAction(action);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Object sequence could not be changed.' };
    }
  }, [recordAction]);

  const addIssue = useCallback((draft: IssueDraft): CommandResult => {
    if (!draft.title.trim()) return { ok: false, errors: { title: 'A finding title is required.' } };
    if (draft.description.trim().length < 16) return { ok: false, errors: { description: 'Add at least 16 characters of context.' } };
    if (!draft.owner.trim()) return { ok: false, errors: { owner: 'Assign an owner.' } };
    const now = new Date().toISOString();
    const action: WorkspaceAction = {
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
    };
    dispatch(action);
    recordAction(action);
    return { ok: true };
  }, [recordAction]);

  const transitionReviewIssue = useCallback((issueId: string, status: IssueStatus): CommandResult => {
    const issue = state.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    const action: WorkspaceAction = { type: 'issue/transition', issueId, status };
    try {
      dispatch(action);
      recordAction(action);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Status could not be changed.' };
    }
  }, [state.issues, recordAction]);

  const updatePreferences = useCallback((preferences: PlanningPreferences) => {
    const action: WorkspaceAction = { type: 'preferences/update', preferences };
    dispatch(action);
    recordAction(action);
  }, [recordAction]);

  const checkReadiness = useCallback(() => {
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const result = evaluateReadiness(state, analysis);
    const action: WorkspaceAction = { type: 'project/readiness', ready: result.ready, checkedAt: result.checkedAt };
    dispatch(action);
    recordAction(action);
    return result;
  }, [state, recordAction]);

  const createSnapshot = useCallback((): CommandResult<Snapshot> => {
    const analysis = analyzeJourney(state.artifacts, state.zones);
    const readiness = evaluateReadiness(state, analysis);
    if (!readiness.ready) return { ok: false, message: readiness.blockers[0] ?? 'The plan is not ready.' };
    return { ok: true, value: buildSnapshot(state, analysis, readiness) };
  }, [state]);

  const resetWorkspace = useCallback(() => {
    const action: WorkspaceAction = { type: 'workspace/reset', state: createSeedWorkspace() };
    dispatch(action);
    recordAction(action);
  }, [recordAction]);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    history,
    storageHealthy,
    upsertArtifact,
    removeArtifact,
    assignArtifact,
    removePlacement,
    reorderArtifact,
    addIssue,
    transitionReviewIssue,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, history, storageHealthy, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
