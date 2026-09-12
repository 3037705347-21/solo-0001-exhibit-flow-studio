import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { artifactFromDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import { previewRuleImpact, type RuleImpactReport } from '../domain/ruleImpact';
import {
  cloneParameters,
  draftNextVersion,
  findProfile,
  isValidRuleParameters,
  resolveRuleProfile,
  type RuleParameters,
  type RuleProfile,
} from '../domain/ruleProfiles';
import type {
  Artifact,
  ArtifactDraft,
  IssueDraft,
  IssueStatus,
  PlanningPreferences,
  ReadinessResult,
  ReadinessRun,
  RuleBinding,
  Snapshot,
  WorkspaceState,
} from '../domain/models';
import { workspaceReducer } from './reducer';
import { loadWorkspaceResult, rebindWorkspace, saveWorkspace, type WorkspaceLoadProblem } from './persistence';
import { createSeedWorkspace } from './seed';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

export interface PublishRulesInput {
  parameters: RuleParameters;
  changeSummary: string;
  name?: string;
}

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  loadProblems: WorkspaceLoadProblem[];
  /** Resolved bound archive; status is never assumed — missing versions stay unresolved. */
  ruleResolution: ReturnType<typeof resolveRuleProfile>;
  boundProfile?: RuleProfile;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  removeArtifact: (artifactId: string) => CommandResult;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => void;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  addIssue: (draft: IssueDraft) => CommandResult;
  transitionReviewIssue: (issueId: string, status: IssueStatus) => CommandResult;
  updatePreferences: (preferences: PlanningPreferences) => void;
  checkReadiness: () => CommandResult<ReadinessResult>;
  createSnapshot: () => CommandResult<Snapshot>;
  /** Dry-run a candidate (existing version or draft) against the current plan. */
  previewImpact: (candidate: RuleProfile) => CommandResult<RuleImpactReport>;
  publishRuleVersion: (input: PublishRulesInput) => CommandResult<RuleProfile>;
  switchRuleVersion: (profileId: string, version: number) => CommandResult;
  repairRuleBinding: (profileId: string, version: number) => CommandResult;
  resetWorkspace: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [initial] = useState(() => loadWorkspaceResult());
  const [state, dispatch] = useReducer(workspaceReducer, initial.state);
  const [loadProblems] = useState<WorkspaceLoadProblem[]>(initial.problems);
  const [storageHealthy, setStorageHealthy] = useState(true);

  useEffect(() => {
    setStorageHealthy(saveWorkspace(state));
  }, [state]);

  const ruleResolution = useMemo(() => resolveRuleProfile(state), [state]);
  const boundProfile = ruleResolution.status === 'resolved' ? ruleResolution.profile : undefined;

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

  const checkReadiness = useCallback((): CommandResult<ReadinessResult> => {
    if (!boundProfile) {
      return { ok: false, message: `Cannot evaluate readiness: ${ruleResolution.reason}` };
    }
    const analysis = analyzeJourney(
      state.artifacts,
      state.zones,
      boundProfile.parameters,
      { profileId: boundProfile.profileId, version: boundProfile.version, name: boundProfile.name },
    );
    const result = evaluateReadiness(state, analysis, boundProfile);
    const run: ReadinessRun = {
      id: createId('run'),
      checkedAt: result.checkedAt,
      ready: result.ready,
      score: result.score,
      blockers: result.blockers,
      cautions: result.cautions,
      ruleArchive: result.ruleArchive,
    };
    dispatch({ type: 'project/readiness', ready: result.ready, checkedAt: result.checkedAt, run });
    return { ok: true, value: result };
  }, [state, boundProfile, ruleResolution.reason]);

  const createSnapshot = useCallback((): CommandResult<Snapshot> => {
    if (!boundProfile) {
      return { ok: false, message: `Cannot publish: ${ruleResolution.reason}` };
    }
    const analysis = analyzeJourney(
      state.artifacts,
      state.zones,
      boundProfile.parameters,
      { profileId: boundProfile.profileId, version: boundProfile.version, name: boundProfile.name },
    );
    const readiness = evaluateReadiness(state, analysis, boundProfile);
    if (!readiness.ready) return { ok: false, message: readiness.blockers[0] ?? 'The plan is not ready.' };
    const snapshot = buildSnapshot(state, analysis, readiness, boundProfile);
    return { ok: true, value: snapshot };
  }, [state, boundProfile, ruleResolution.reason]);

  const previewImpact = useCallback((candidate: RuleProfile): CommandResult<RuleImpactReport> => {
    // Drafts carry a provisional version number, so validate the thresholds
    // themselves rather than the full (immutable, published) profile shape.
    if (!isValidRuleParameters(candidate.parameters)) return { ok: false, message: 'The candidate rule thresholds are not valid.' };
    if (!boundProfile) return { ok: false, message: `Cannot preview impact: ${ruleResolution.reason}` };
    const report = previewRuleImpact(state, boundProfile, candidate);
    return { ok: true, value: report };
  }, [state, boundProfile, ruleResolution.reason]);

  const publishRuleVersion = useCallback((input: PublishRulesInput): CommandResult<RuleProfile> => {
    if (!boundProfile) return { ok: false, message: `Cannot publish rules: ${ruleResolution.reason}` };
    if (!input.changeSummary.trim()) {
      return { ok: false, errors: { changeSummary: 'Describe what changed in this version.' } };
    }
    if (!isValidRuleParameters(input.parameters)) {
      return { ok: false, message: 'The rule thresholds are not valid.' };
    }
    const profile = draftNextVersion(
      state.ruleProfiles,
      boundProfile,
      { parameters: cloneParameters(input.parameters), changeSummary: input.changeSummary, name: input.name },
    );
    dispatch({ type: 'rules/publish', profile });
    return { ok: true, value: profile };
  }, [state.ruleProfiles, boundProfile, ruleResolution.reason]);

  const switchRuleVersion = useCallback((profileId: string, version: number): CommandResult => {
    const target = findProfile(state.ruleProfiles, profileId, version);
    if (!target) return { ok: false, message: `Archive version ${profileId}#${version} is not stored in this workspace.` };
    try {
      const binding: RuleBinding = { profileId, version, boundAt: new Date().toISOString() };
      dispatch({ type: 'rules/bind', binding });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Rule version could not be switched.' };
    }
  }, [state.ruleProfiles]);

  const repairRuleBinding = useCallback((profileId: string, version: number): CommandResult => {
    const repaired = rebindWorkspace(state, profileId, version);
    if (!repaired || !repaired.project.ruleBinding) return { ok: false, message: 'Choose an archive version present in this workspace.' };
    dispatch({ type: 'rules/repair', binding: repaired.project.ruleBinding });
    return { ok: true };
  }, [state]);

  const resetWorkspace = useCallback(() => dispatch({ type: 'workspace/reset', state: createSeedWorkspace() }), []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    storageHealthy,
    loadProblems,
    ruleResolution,
    boundProfile,
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
    previewImpact,
    publishRuleVersion,
    switchRuleVersion,
    repairRuleBinding,
    resetWorkspace,
  }), [state, storageHealthy, loadProblems, ruleResolution, boundProfile, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, previewImpact, publishRuleVersion, switchRuleVersion, repairRuleBinding, resetWorkspace]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
