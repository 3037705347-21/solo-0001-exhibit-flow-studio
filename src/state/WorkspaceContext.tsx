import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import {
  bootstrapWorkspace,
  checkpoint as persistCheckpoint,
  commitCommand,
  persistReset,
  CHECKPOINT_EVERY,
  type RecoveryReport,
} from './recovery';
import { createSeedWorkspace } from './seed';
import type { WorkspaceAction } from './actions';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  recoveryReport: RecoveryReport | null;
  dismissRecoveryReport: () => void;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  removeArtifact: (artifactId: string) => CommandResult;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => CommandResult;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  addIssue: (draft: IssueDraft) => CommandResult;
  transitionReviewIssue: (issueId: string, status: IssueStatus) => CommandResult;
  updatePreferences: (preferences: PlanningPreferences) => CommandResult;
  checkReadiness: () => ReadinessResult;
  createSnapshot: () => CommandResult<Snapshot>;
  resetWorkspace: () => CommandResult;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // Recovery-aware boot: verified snapshot first, journal replay after it.
  const [boot] = useState(() => bootstrapWorkspace(localStorage));
  const [state, dispatch] = useReducer(workspaceReducer, boot.state);
  const [storageHealthy, setStorageHealthy] = useState(true);
  const [recoveryReport, setRecoveryReport] = useState<RecoveryReport | null>(() => {
    // Only surface events the curator should know about: interrupted writes,
    // breakpoints, one-time upgrades, or a log that contained repeated lines.
    const { kind, duplicates } = boot.report;
    const quiet = (kind === 'clean' || kind === 'seed' || kind === 'replayed') && duplicates.length === 0;
    return quiet ? null : boot.report;
  });

  const epochRef = useRef(boot.epoch);
  const seqRef = useRef(boot.lastSeq);
  const slotRef = useRef(boot.snapshotSlot);
  const stateRef = useRef(state);
  const pendingSinceCheckpoint = useRef(0);
  stateRef.current = state;

  const dismissRecoveryReport = useCallback(() => setRecoveryReport(null), []);

  // Periodic safe-point promotion after the journal has absorbed commands.
  useEffect(() => {
    if (pendingSinceCheckpoint.current < CHECKPOINT_EVERY) return;
    const result = persistCheckpoint(localStorage, stateRef.current, seqRef.current, epochRef.current, slotRef.current);
    if (result.ok) {
      slotRef.current = result.slot;
      pendingSinceCheckpoint.current = 0;
    }
    setStorageHealthy(result.ok);
  }, [state]);

  /**
   * Write-ahead commit: the command is durably journaled before the reducer
   * touches in-memory state. True no-ops return without creating history.
   */
  const commit = useCallback((action: WorkspaceAction): CommandResult => {
    const current = stateRef.current;
    const seq = seqRef.current + 1;
    const result = commitCommand(localStorage, current, action, {
      id: createId('cmd'),
      seq,
      epoch: epochRef.current,
    });
    if (!('journaled' in result)) {
      setStorageHealthy(false);
      return { ok: false, message: result.reason };
    }
    if (!result.journaled) {
      // Reset/no-op handling lives at the call sites; nothing durable happened.
      return { ok: true };
    }
    seqRef.current = seq;
    pendingSinceCheckpoint.current += 1;
    setStorageHealthy(true);
    dispatch(action);
    return { ok: true };
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
    const result = commit({ type: 'artifact/upsert', artifact });
    return result.ok ? { ok: true, value: artifact } : { ok: false, message: result.message };
  }, [commit]);

  const removeArtifact = useCallback((artifactId: string): CommandResult => {
    const artifact = stateRef.current.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return { ok: false, message: 'The selected object no longer exists.' };
    return commit({ type: 'artifact/remove', artifactId });
  }, [commit]);

  const assignArtifact = useCallback((artifactId: string, zoneId: string): CommandResult => {
    return commit({ type: 'placement/assign', artifactId, zoneId });
  }, [commit]);

  const removePlacement = useCallback((artifactId: string): CommandResult => {
    return commit({ type: 'placement/remove', artifactId });
  }, [commit]);

  const reorderArtifact = useCallback((zoneId: string, artifactId: string, direction: -1 | 1): CommandResult => {
    return commit({ type: 'placement/reorder', zoneId, artifactId, direction });
  }, [commit]);

  const addIssue = useCallback((draft: IssueDraft): CommandResult => {
    if (!draft.title.trim()) return { ok: false, errors: { title: 'A finding title is required.' } };
    if (draft.description.trim().length < 16) return { ok: false, errors: { description: 'Add at least 16 characters of context.' } };
    if (!draft.owner.trim()) return { ok: false, errors: { owner: 'Assign an owner.' } };
    const now = new Date().toISOString();
    return commit({
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
  }, [commit]);

  const transitionReviewIssue = useCallback((issueId: string, status: IssueStatus): CommandResult => {
    const issue = stateRef.current.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    return commit({ type: 'issue/transition', issueId, status });
  }, [commit]);

  const updatePreferences = useCallback((preferences: PlanningPreferences): CommandResult => {
    return commit({ type: 'preferences/update', preferences });
  }, [commit]);

  const checkReadiness = useCallback(() => {
    const current = stateRef.current;
    const analysis = analyzeJourney(current.artifacts, current.zones);
    const result = evaluateReadiness(current, analysis);
    // A re-check that reaches the same project stage is not new history.
    const stageAfter = result.ready ? 'ready' : 'review';
    if (stageAfter !== current.project.stage) {
      commit({ type: 'project/readiness', ready: result.ready, checkedAt: result.checkedAt });
    }
    return result;
  }, [commit]);

  const createSnapshot = useCallback((): CommandResult<Snapshot> => {
    const current = stateRef.current;
    const analysis = analyzeJourney(current.artifacts, current.zones);
    const readiness = evaluateReadiness(current, analysis);
    if (!readiness.ready) return { ok: false, message: readiness.blockers[0] ?? 'The plan is not ready.' };
    return { ok: true, value: buildSnapshot(current, analysis, readiness) };
  }, []);

  const resetWorkspace = useCallback((): CommandResult => {
    // Snapshot the new epoch first and verify it; only then swap memory.
    const epoch = `epoch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const result = persistReset(localStorage, createSeedWorkspace(), epoch);
    if (!result.ok) {
      setStorageHealthy(false);
      return { ok: false, message: result.reason };
    }
    epochRef.current = epoch;
    seqRef.current = 0;
    slotRef.current = result.slot;
    pendingSinceCheckpoint.current = 0;
    setStorageHealthy(true);
    dispatch({ type: 'workspace/reset', state: createSeedWorkspace() });
    return { ok: true };
  }, []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    storageHealthy,
    recoveryReport,
    dismissRecoveryReport,
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
  }), [state, storageHealthy, recoveryReport, dismissRecoveryReport, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
