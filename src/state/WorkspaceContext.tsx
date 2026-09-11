import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, RestoreProvenance, Snapshot, WorkspaceState } from '../domain/models';
import { serializeWorkspaceFile } from '../domain/workspaceFile';
import {
  applyReviewDecisions,
  buildMigrationPlan,
  findWorkspaceShapeErrors,
  type AppliedMigration,
  type MigrationPlan,
  type ReviewDecisions,
} from './migrations';
import { workspaceReducer } from './reducer';
import { loadWorkspace, readPersistedWorkspace, replaceWorkspace, rollbackWorkspace, saveWorkspace } from './persistence';
import { createSeedWorkspace } from './seed';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

export type ImportPreviewResult =
  | { ok: true; plan: MigrationPlan }
  | { ok: false; reason: string };

interface RecoverySnapshot {
  /** In-memory state that recovery replaced, used for undo. */
  state: WorkspaceState;
  /** Storage bytes captured before the write, used for storage rollback. */
  previousBytes: string | null;
  provenance: RestoreProvenance;
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  lastRecovery: RecoverySnapshot | null;
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
  previewWorkspaceImport: (raw: string | File) => Promise<ImportPreviewResult>;
  commitRecovery: (plan: MigrationPlan, decisions: ReviewDecisions, sourceFileName?: string) => CommandResult<AppliedMigration>;
  undoLastRecovery: () => CommandResult;
  exportWorkspaceFile: () => CommandResult<string>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

async function readImportInput(raw: string | File): Promise<unknown> {
  if (typeof raw === 'string') return raw;
  return raw.text();
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => loadWorkspace());
  const [storageHealthy, setStorageHealthy] = useState(true);
  const [lastRecovery, setLastRecovery] = useState<RecoverySnapshot | null>(null);

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

  const resetWorkspace = useCallback(() => {
    // A deliberate sample reset is a new baseline; an undo would otherwise
    // appear available but resurrect a recovery the user moved past.
    setLastRecovery(null);
    dispatch({ type: 'workspace/reset', state: createSeedWorkspace() });
  }, []);

  const previewWorkspaceImport = useCallback(async (raw: string | File): Promise<ImportPreviewResult> => {
    let textContent: unknown;
    try {
      textContent = await readImportInput(raw);
    } catch {
      return { ok: false, reason: 'The selected file could not be read.' };
    }
    const result = buildMigrationPlan(textContent);
    if (!result.ok) return { ok: false, reason: result.reason };
    // The preview itself never mutates the current workspace or storage.
    const shapeErrors = findWorkspaceShapeErrors(
      applyReviewDecisions(result.plan).state,
    );
    if (shapeErrors.length > 0) {
      return { ok: false, reason: `Migration produced an unusable workspace: ${shapeErrors[0]}` };
    }
    return { ok: true, plan: result.plan };
  }, []);

  const commitRecovery = useCallback((plan: MigrationPlan, decisions: ReviewDecisions, sourceFileName?: string): CommandResult<AppliedMigration> => {
    const applied = applyReviewDecisions(plan, decisions);
    const shapeErrors = findWorkspaceShapeErrors(applied.state);
    if (shapeErrors.length > 0) {
      return { ok: false, message: shapeErrors[0] };
    }

    const previousBytes = readPersistedWorkspace();
    const snapshot: RecoverySnapshot = {
      state,
      previousBytes,
      provenance: {
        restoredAt: new Date().toISOString(),
        sourceVersion: plan.report.sourceVersion,
        ...(sourceFileName ? { sourceFileName } : {}),
        retainedCount: applied.counters.kept,
        addedCount: applied.counters.added,
        invalidatedCount: applied.counters.invalid,
        confirmedCount: applied.confirmedCount,
      },
    };

    const recoveredState: WorkspaceState = {
      ...applied.state,
      restoredFrom: snapshot.provenance,
    };
    const write = replaceWorkspace(recoveredState);
    if (!write.ok) {
      // Storage was never touched (validation failure) or was rolled back to
      // the previous bytes; the current in-memory workspace is untouched.
      return {
        ok: false,
        message: write.errors[0] ?? 'Recovery could not be written; the current workspace is unchanged.',
      };
    }

    setLastRecovery({ ...snapshot, previousBytes: write.previous });
    dispatch({ type: 'workspace/replace', state: recoveredState });
    return { ok: true, value: applied };
  }, [state]);

  const undoLastRecovery = useCallback((): CommandResult => {
    const snapshot = lastRecovery;
    if (!snapshot) return { ok: false, message: 'There is no recovery to undo.' };
    const restored = rollbackWorkspace(snapshot.previousBytes);
    if (!restored) return { ok: false, message: 'The browser refused to restore the previous workspace.' };
    setLastRecovery(null);
    dispatch({ type: 'workspace/replace', state: snapshot.state });
    return { ok: true };
  }, [lastRecovery]);

  const exportWorkspaceFile = useCallback((): CommandResult<string> => {
    const shapeErrors = findWorkspaceShapeErrors(state);
    if (shapeErrors.length > 0) {
      return { ok: false, message: `The current workspace cannot be exported: ${shapeErrors[0]}` };
    }
    try {
      return { ok: true, value: serializeWorkspaceFile(state) };
    } catch {
      return { ok: false, message: 'The workspace could not be serialized.' };
    }
  }, [state]);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    storageHealthy,
    lastRecovery,
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
    previewWorkspaceImport,
    commitRecovery,
    undoLastRecovery,
    exportWorkspaceFile,
  }), [state, storageHealthy, lastRecovery, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace, previewWorkspaceImport, commitRecovery, undoLastRecovery, exportWorkspaceFile]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
