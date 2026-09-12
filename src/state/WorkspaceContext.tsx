import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import type { AllocationConflict, AllocationPlan } from '../domain/workload';
import { commitAllocation } from '../domain/workload';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import type { Artifact, ArtifactDraft, AssignmentAuditEntry, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import { loadStoredWorkspace, loadWorkspace, parseWorkspaceJson, saveWorkspace, STORAGE_KEY } from './persistence';
import { createSeedWorkspace } from './seed';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

export interface AllocationCommandResult {
  ok: boolean;
  duplicate?: boolean;
  conflicts?: AllocationConflict[];
  audit?: AssignmentAuditEntry[];
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
  addIssue: (draft: IssueDraft) => CommandResult;
  transitionReviewIssue: (issueId: string, status: IssueStatus) => CommandResult;
  commitAllocationPlan: (plan: AllocationPlan) => Promise<AllocationCommandResult>;
  updatePreferences: (preferences: PlanningPreferences) => void;
  checkReadiness: () => ReadinessResult;
  createSnapshot: () => CommandResult<Snapshot>;
  resetWorkspace: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Cross-tab mutex name shared by every allocation transaction. */
const ALLOCATION_LOCK_NAME = 'exhibit-flow.allocation.v1';

interface LockManagerLike {
  request(name: string, callback: () => Promise<void> | void): Promise<void>;
}

function getLockManager(): LockManagerLike | null {
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return typeof locks?.request === 'function' ? locks : null;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => loadWorkspace());
  const [storageHealthy, setStorageHealthy] = useState(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const appliedPlansRef = useRef<Set<string>>(new Set());
  // State adopted from a direct transaction write or an external tab; the next
  // persistence effect must skip it so we never echo authoritative storage
  // content back and clobber a peer.
  const adoptedStateRef = useRef<WorkspaceState | null>(null);

  useEffect(() => {
    if (adoptedStateRef.current === state) {
      adoptedStateRef.current = null;
      setStorageHealthy(true);
      return;
    }
    setStorageHealthy(saveWorkspace(state));
  }, [state]);

  // Adopt writes committed in another tab. Allocation transactions also
  // serialize on a named lock and re-read storage before writing.
  useEffect(() => {
    const onExternalChange = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      let incoming: WorkspaceState | null = null;
      try { incoming = parseWorkspaceJson(event.newValue); } catch { incoming = null; }
      if (!incoming) return;
      if (incoming.lastSavedAt === stateRef.current.lastSavedAt) return;
      // Merge any audit entries missing locally before handing state to the
      // reducer so the complete trail survives either side winning.
      const known = new Set(stateRef.current.assignmentLog.map((entry) => entry.id));
      const mergedAudit = [
        ...stateRef.current.assignmentLog,
        ...incoming.assignmentLog.filter((entry) => !known.has(entry.id)),
      ];
      const adopted = { ...incoming, assignmentLog: mergedAudit };
      adoptedStateRef.current = adopted;
      dispatch({ type: 'workspace/syncExternal', state: adopted, audit: mergedAudit });
    };
    window.addEventListener('storage', onExternalChange);
    return () => window.removeEventListener('storage', onExternalChange);
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
        version: 0,
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

  const commitAllocationPlan = useCallback(async (plan: AllocationPlan): Promise<AllocationCommandResult> => {
    // Synchronous guard so a double click in the same UI task reports a
    // duplicate instead of queuing behind the lock.
    if (appliedPlansRef.current.has(plan.planId)) {
      return { ok: true, duplicate: true, audit: [], message: 'This allocation was already applied.' };
    }

    const runTransaction = (): AllocationCommandResult => {
      // Re-read shared state straight from storage under the lock: another tab
      // may have committed after this dialog opened. Fall back to in-memory
      // state when nothing is persisted yet (first run) or storage is unreadable.
      const shared = loadStoredWorkspace() ?? stateRef.current;
      const result = commitAllocation(shared, plan);

      if (!result.ok) {
        return {
          ok: false,
          conflicts: result.conflicts,
          message: 'The workload changed while the batch was open. Review the conflicts and refresh.',
        };
      }
      if (result.duplicate) {
        appliedPlansRef.current.add(plan.planId);
        return { ok: true, duplicate: true, audit: [], message: 'This allocation was already applied.' };
      }
      if (result.audit.length === 0) {
        return { ok: true, audit: [], duplicate: false };
      }

      // read → validate → write all run in one synchronous lock-held task, so
      // no other tab (allocation commits hold the same lock; other writes are
      // blocked from interleaving by the event loop) can slip in between.
      const committed: WorkspaceState = {
        ...result.state,
        lastSavedAt: new Date().toISOString(),
      };
      if (!saveWorkspace(committed)) {
        return { ok: false, message: 'The allocation could not be saved to this browser.' };
      }
      appliedPlansRef.current.add(plan.planId);
      if (appliedPlansRef.current.size > 20) {
        appliedPlansRef.current = new Set([...appliedPlansRef.current].slice(-10));
      }
      // Adopt the authoritative committed state without a second storage
      // write; the persistence effect skips this exact reference.
      adoptedStateRef.current = committed;
      dispatch({ type: 'allocation/committed', state: committed, movedCount: result.audit.length, duplicate: false });
      return { ok: true, audit: result.audit };
    };

    const locks = getLockManager();
    if (locks) {
      // Named Web Lock: allocation commits in every tab are mutually exclusive.
      try {
        let outcome: AllocationCommandResult = { ok: false, message: 'Allocation transaction failed.' };
        await locks.request(ALLOCATION_LOCK_NAME, async () => {
          outcome = runTransaction();
        });
        return outcome;
      } catch {
        // A lock failure must never silently apply; fall through to a direct
        // best-effort transaction where version checks still reject drift.
      }
    }
    return runTransaction();
  }, []);

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
    transitionReviewIssue,
    commitAllocationPlan,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, storageHealthy, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, commitAllocationPlan, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
