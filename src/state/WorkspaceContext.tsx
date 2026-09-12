import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { computePlanRevision } from '../domain/planVersion';
import { commitRepairOperations, RepairCommitError, type RepairOperation } from '../domain/repairSandbox';
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
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => void;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  applyRepairProposal: (operations: RepairOperation[], expectedRevision: string) => CommandResult;
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

  // Refs let long-lived commands validate against the plan version that is
  // current at confirm time, rather than the render the command was created on.
  const stateRef = useRef(state);
  stateRef.current = state;
  const appliedRepairRevision = useRef<string | null>(null);
  // Last proposal signature handed to the reducer. A second click on the same
  // proposal (before React re-renders with the new revision) is rejected here.
  const pendingRepairSignature = useRef<string | null>(null);

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

  const applyRepairProposal = useCallback((operations: RepairOperation[], expectedRevision: string): CommandResult => {
    const current = stateRef.current;
    const signature = `${expectedRevision}:${JSON.stringify(operations)}`;
    if (pendingRepairSignature.current === signature) {
      return { ok: false, message: 'This repair proposal was already applied.' };
    }
    try {
      // Validate and dry-run the whole set against the current revision before
      // dispatching anything. Stale proposals, duplicate confirms and failed
      // simulations return here without touching the plan.
      const next = commitRepairOperations({
        state: current,
        operations,
        expectedRevision,
        appliedRevision: appliedRepairRevision.current,
      });
      pendingRepairSignature.current = signature;
      dispatch({ type: 'repair/commit', operations, expectedRevision });
      appliedRepairRevision.current = computePlanRevision(next);
      return { ok: true };
    } catch (error) {
      if (error instanceof RepairCommitError) {
        return { ok: false, message: error.message };
      }
      return { ok: false, message: 'The repair proposal could not be applied.' };
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
    assignArtifact,
    removePlacement,
    reorderArtifact,
    applyRepairProposal,
    addIssue,
    transitionReviewIssue,
    updatePreferences,
    checkReadiness,
    createSnapshot,
    resetWorkspace,
  }), [state, storageHealthy, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, applyRepairProposal, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
