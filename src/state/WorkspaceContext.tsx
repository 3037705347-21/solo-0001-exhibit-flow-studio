import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { serializeWorkspace, parseWorkspaceFile } from '../domain/export';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { loadWorkspace, saveWorkspace } from './persistence';
import { createSeedWorkspace } from './seed';
import { applyConfirmations, planWorkspaceMigration, type ConfirmResolution, type MigrationPlan } from './migrations';
import { commitRestore, RestoreHandle, type RestoreOutcome } from './restore';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  startupNotice: string | null;
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
  exportWorkspace: () => CommandResult<string>;
  previewImport: (contents: string) => CommandResult<MigrationPlan>;
  restoreFromPlan: (plan: MigrationPlan, resolutions: Record<string, ConfirmResolution>) => CommandResult;
  undoLastRestore: () => CommandResult;
  acceptLastRestore: () => CommandResult;
  dismissStartupNotice: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => loadWorkspace());
  const [state, dispatch] = useReducer(workspaceReducer, initial.state);
  const [storageHealthy, setStorageHealthy] = useState(true);
  const [startupNotice, setStartupNotice] = useState<string | null>(
    initial.recoveredFromInterruption
      ? 'An interrupted workspace restore was detected; the previous workspace was rolled back automatically.'
      : initial.fellBackToSeed
        ? 'The stored workspace could not be read; the sample plan was loaded instead.'
        : null,
  );
  const restoreHandleRef = useRef<RestoreHandle | null>(null);
  // Restore/rollback write storage transactionally themselves; skip the next
  // autosave so the reducer's own save cannot interleave with the backup slot.
  const skipNextSaveRef = useRef(false);

  useEffect(() => {
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
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

  const exportWorkspace = useCallback((): CommandResult<string> => {
    const serialized = serializeWorkspace(state);
    if (!serialized) return { ok: false, message: 'The current workspace failed validation and cannot be exported.' };
    return { ok: true, value: serialized };
  }, [state]);

  const previewImport = useCallback((contents: string): CommandResult<MigrationPlan> => {
    const parsed = parseWorkspaceFile(contents);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    const plan = planWorkspaceMigration(parsed.value);
    if (plan.fatal.length > 0 || !plan.candidate) {
      return { ok: false, message: plan.fatal[0]?.message ?? 'Nothing in this file can be restored safely.' };
    }
    return { ok: true, value: plan };
  }, []);

  const restoreFromPlan = useCallback((plan: MigrationPlan, resolutions: Record<string, ConfirmResolution>): CommandResult => {
    let restored: WorkspaceState;
    try {
      restored = applyConfirmations(plan, resolutions);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The migration could not be finalized.' };
    }
    const outcome = commitRestore(restored, localStorage);
    if (!outcome.ok) {
      return { ok: false, message: outcome.message };
    }
    restoreHandleRef.current = outcome.handle;
    skipNextSaveRef.current = true;
    dispatch({ type: 'workspace/replace', state: restored });
    return { ok: true };
  }, [restoreHandleRef]);

  const undoLastRestore = useCallback((): CommandResult => {
    const handle = restoreHandleRef.current;
    if (!handle) return { ok: false, message: 'There is no restore to undo in this session.' };
    const outcome: RestoreOutcome = handle.rollback();
    if (!outcome.ok) return { ok: false, message: outcome.message };
    restoreHandleRef.current = null;
    const reloaded = loadWorkspace({ recover: false });
    skipNextSaveRef.current = true;
    dispatch({ type: 'workspace/replace', state: reloaded.state });
    return { ok: true };
  }, [restoreHandleRef]);

  const acceptLastRestore = useCallback((): CommandResult => {
    const handle = restoreHandleRef.current;
    if (!handle) return { ok: true };
    const outcome = handle.finalize();
    if (!outcome.ok) return { ok: false, message: outcome.message };
    restoreHandleRef.current = null;
    return { ok: true };
  }, [restoreHandleRef]);

  const dismissStartupNotice = useCallback(() => setStartupNotice(null), []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    storageHealthy,
    startupNotice,
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
    exportWorkspace,
    previewImport,
    restoreFromPlan,
    undoLastRestore,
    acceptLastRestore,
    dismissStartupNotice,
  }), [state, storageHealthy, startupNotice, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace, exportWorkspace, previewImport, restoreFromPlan, undoLastRestore, acceptLastRestore, dismissStartupNotice]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
