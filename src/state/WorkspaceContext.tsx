import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import type { AllocationConflict, AllocationPlan } from '../domain/workload';
import { commitAllocation } from '../domain/workload';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import { regressReadyProject, transitionIssue } from '../domain/transitions';
import type { Artifact, ArtifactDraft, AssignmentAuditEntry, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, ReviewIssue, Snapshot, WorkspaceState } from '../domain/models';
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
  addIssue: (draft: IssueDraft) => Promise<CommandResult>;
  transitionReviewIssue: (issueId: string, status: IssueStatus) => Promise<CommandResult>;
  commitAllocationPlan: (plan: AllocationPlan) => Promise<AllocationCommandResult>;
  updatePreferences: (preferences: PlanningPreferences) => void;
  checkReadiness: () => ReadinessResult;
  createSnapshot: () => CommandResult<Snapshot>;
  resetWorkspace: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Cross-tab mutex shared by every write that can change owner or status. */
const REVIEW_WRITE_LOCK_NAME = 'exhibit-flow.review-write.v1';

interface LockManagerLike {
  request(name: string, callback: () => Promise<void> | void): Promise<void>;
}

function getLockManager(): LockManagerLike | null {
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return typeof locks?.request === 'function' ? locks : null;
}

type LockedOutcome =
  | { kind: 'applied'; audit?: AssignmentAuditEntry[] }
  | { kind: 'unchanged' }
  | { kind: 'duplicate'; message: string }
  | { kind: 'conflicts'; conflicts: AllocationConflict[]; message: string }
  | { kind: 'rejected'; message: string };

interface QueueEntry {
  mutate: (state: WorkspaceState) => { state: WorkspaceState; outcome: LockedOutcome };
  resolve: (outcome: LockedOutcome) => void;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => loadWorkspace());
  const [storageHealthy, setStorageHealthy] = useState(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const appliedPlansRef = useRef<Set<string>>(new Set());
  // State adopted from a direct locked write or an external tab; the next
  // persistence effect must skip it so we never echo authoritative storage
  // content back and clobber a peer.
  const adoptedStateRef = useRef<WorkspaceState | null>(null);

  // Serialized cross-tab write queue. Every command that can change an
  // issue's owner or status funnels through here: all queued mutations drain
  // in one Web Lock-held task, each applied to the freshest state re-read from
  // shared storage, then stamped once, written once, and adopted.
  const queueRef = useRef<QueueEntry[]>([]);
  const drainingRef = useRef(false);

  const drainQueue = useCallback(() => {
    if (drainingRef.current) return;
    drainingRef.current = true;

    const run = () => {
      const entries = queueRef.current;
      queueRef.current = [];
      // Start from the shared state re-read under the lock; every queued
      // mutation folds into the same base, so same-tab and cross-tab commands
      // can never overwrite one another.
      let base = loadStoredWorkspace() ?? stateRef.current;
      let changed = false;

      for (const entry of entries) {
        try {
          const { state: next, outcome } = entry.mutate(base);
          entry.resolve(outcome);
          if (outcome.kind === 'applied' && next !== base) {
            base = next;
            changed = true;
          }
        } catch (error) {
          entry.resolve({ kind: 'rejected', message: error instanceof Error ? error.message : 'The transaction failed.' });
        }
      }

      let saved = true;
      if (changed) {
        const stamped: WorkspaceState = { ...base, lastSavedAt: new Date().toISOString() };
        saved = saveWorkspace(stamped);
        if (saved) {
          adoptedStateRef.current = stamped;
          dispatch({ type: 'transaction/apply', state: stamped });
        } else {
          setStorageHealthy(false);
        }
      }
      drainingRef.current = false;
      if (queueRef.current.length > 0) drainQueue();
    };

    const locks = getLockManager();
    if (locks) {
      locks.request(REVIEW_WRITE_LOCK_NAME, () => { run(); }).catch(() => run());
    } else {
      run();
    }
  }, []);

  const enqueueLocked = useCallback((mutate: QueueEntry['mutate']): Promise<LockedOutcome> => {
    return new Promise<LockedOutcome>((resolve) => {
      queueRef.current.push({ mutate, resolve });
      drainQueue();
    });
  }, [drainQueue]);

  useEffect(() => {
    if (adoptedStateRef.current === state) {
      adoptedStateRef.current = null;
      setStorageHealthy(true);
      return;
    }
    setStorageHealthy(saveWorkspace(state));
  }, [state]);

  // Adopt writes committed in another tab. Local review writes serialize on
  // the same named lock, so by the time an event arrives it is authoritative.
  useEffect(() => {
    const onExternalChange = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      let incoming: WorkspaceState | null = null;
      try { incoming = parseWorkspaceJson(event.newValue); } catch { incoming = null; }
      if (!incoming) return;
      if (incoming.lastSavedAt === stateRef.current.lastSavedAt) return;
      // Merge any audit entries missing locally before adopting so the
      // complete trail survives whichever side committed last.
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

  const addIssue = useCallback(async (draft: IssueDraft): Promise<CommandResult> => {
    if (!draft.title.trim()) return { ok: false, errors: { title: 'A finding title is required.' } };
    if (draft.description.trim().length < 16) return { ok: false, errors: { description: 'Add at least 16 characters of context.' } };
    if (!draft.owner.trim()) return { ok: false, errors: { owner: 'Assign an owner.' } };

    // Build the issue outside the lock but validate/persist inside it so the
    // new finding shares the same cross-tab write serialization.
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
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    const outcome = await enqueueLocked((current) => ({
      state: regressReadyProject({ ...current, issues: [issue, ...current.issues] }),
      outcome: { kind: 'applied' },
    }));
    return outcome.kind === 'rejected'
      ? { ok: false, message: outcome.message }
      : { ok: true };
  }, [enqueueLocked]);

  const transitionReviewIssue = useCallback(async (issueId: string, status: IssueStatus): Promise<CommandResult> => {
    const previewIssue = stateRef.current.issues.find((candidate) => candidate.id === issueId);
    if (!previewIssue) return { ok: false, message: 'The selected review finding no longer exists.' };

    const outcome = await enqueueLocked((current) => {
      const issue = current.issues.find((candidate) => candidate.id === issueId);
      if (!issue) {
        return { state: current, outcome: { kind: 'rejected', message: 'The selected review finding no longer exists.' } };
      }
      // Re-read under the lock: an allocation or peer transition may have
      // moved the version. transitionIssue validates the lifecycle and bumps
      // only when the status actually changes.
      if (issue.status === status) return { state: current, outcome: { kind: 'unchanged' } };
      const moved = transitionIssue(issue, status);
      const nextIssue: ReviewIssue = { ...moved, version: issue.version + 1 };
      return {
        state: regressReadyProject({ ...current, issues: current.issues.map((candidate) => candidate.id === issueId ? nextIssue : candidate) }),
        outcome: { kind: 'applied' },
      };
    });
    if (outcome.kind === 'rejected') return { ok: false, message: outcome.message };
    return { ok: true };
  }, [enqueueLocked]);

  const commitAllocationPlan = useCallback(async (plan: AllocationPlan): Promise<AllocationCommandResult> => {
    // Synchronous guard so a double click in the same UI task reports a
    // duplicate instead of queuing behind the lock.
    if (appliedPlansRef.current.has(plan.planId)) {
      return { ok: true, duplicate: true, audit: [], message: 'This allocation was already applied.' };
    }

    const outcome = await enqueueLocked((shared) => {
      // Re-read happens in the drain; `shared` is already the freshest state
      // in shared storage for this lock-held task.
      const result = commitAllocation(shared, plan);
      if (!result.ok) {
        return {
          state: shared,
          outcome: {
            kind: 'conflicts',
            conflicts: result.conflicts,
            message: 'The workload changed while the batch was open. Review the conflicts and refresh.',
          },
        };
      }
      if (result.duplicate) {
        appliedPlansRef.current.add(plan.planId);
        return { state: shared, outcome: { kind: 'duplicate', message: 'This allocation was already applied.' } };
      }
      if (result.audit.length === 0) {
        return { state: shared, outcome: { kind: 'unchanged' } };
      }
      appliedPlansRef.current.add(plan.planId);
      if (appliedPlansRef.current.size > 20) {
        appliedPlansRef.current = new Set([...appliedPlansRef.current].slice(-10));
      }
      return { state: result.state, outcome: { kind: 'applied', audit: result.audit } };
    });

    switch (outcome.kind) {
      case 'conflicts':
        return { ok: false, conflicts: outcome.conflicts, message: outcome.message };
      case 'duplicate':
        return { ok: true, duplicate: true, audit: [], message: outcome.message };
      case 'rejected':
        return { ok: false, message: outcome.message };
      case 'unchanged':
        return { ok: true, audit: [], duplicate: false };
      case 'applied':
        return { ok: true, audit: outcome.audit ?? [] };
    }
  }, [enqueueLocked]);

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
