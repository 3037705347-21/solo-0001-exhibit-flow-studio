import { AlertTriangle, CloudOff, FileWarning, LifeBuoy, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { artifactFromDraft, artifactToDraft, validateArtifactDraft } from '../domain/artifactValidation';
import { createId } from '../domain/ids';
import { analyzeJourney } from '../domain/journeyAnalysis';
import { buildSnapshot, evaluateReadiness } from '../domain/reviewRules';
import { titleCase } from '../domain/formatters';
import type { Artifact, ArtifactDraft, IssueDraft, IssueStatus, PlanningPreferences, ReadinessResult, Snapshot, WorkspaceState } from '../domain/models';
import { workspaceReducer } from './reducer';
import type { WorkspaceAction } from './actions';
import { commitInitialMigration, commitWorkspace, dismissRecovery, loadWorkspace, overwriteWorkspace, STORAGE_KEY, type LoadedSession } from './persistence';
import { createSeedWorkspace } from './seed';
import { replayIntents, reviewChanges, type ChangeReview } from './coordination';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { Badge } from '../components/Badge';

interface CommandResult<T = undefined> {
  ok: boolean;
  value?: T;
  errors?: Record<string, string>;
  message?: string;
}

interface PendingCommit {
  /** Desired document computed locally via the reducer. */
  next: WorkspaceState;
  /** Every intent folded in since the pinned base, in order. */
  intents: WorkspaceAction[];
  /** Snapshot this tab was viewing when the interaction began. */
  base: WorkspaceState;
  /** Revision the pending change is based on. */
  baseRevision: number;
  /** Sample-plan reset is destructive and cannot be replayed. */
  reset: boolean;
}

export interface ConflictState {
  base: WorkspaceState;
  local: WorkspaceState;
  remote: WorkspaceState;
  baseRevision: number;
  remoteRevision: number;
  intents: WorkspaceAction[];
  review: ChangeReview;
  reset: boolean;
  replayErrors?: string[];
}

type PendingNotice =
  | { kind: 'conflict' }
  | { kind: 'unavailable' };

interface WorkspaceContextValue {
  state: WorkspaceState;
  storageHealthy: boolean;
  conflict: ConflictState | null;
  recoveredDocument: boolean;
  upsertArtifact: (draft: ArtifactDraft, existing?: Artifact) => CommandResult<Artifact>;
  removeArtifact: (artifactId: string) => CommandResult;
  assignArtifact: (artifactId: string, zoneId: string) => CommandResult;
  removePlacement: (artifactId: string) => CommandResult;
  reorderArtifact: (zoneId: string, artifactId: string, direction: -1 | 1) => CommandResult;
  addIssue: (draft: IssueDraft) => CommandResult;
  transitionReviewIssue: (issueId: string, status: IssueStatus) => CommandResult;
  updatePreferences: (preferences: PlanningPreferences) => CommandResult;
  checkReadiness: () => CommandResult<ReadinessResult>;
  createSnapshot: () => CommandResult<Snapshot>;
  resetWorkspace: () => void;
  beginInteraction: () => void;
  endInteraction: () => void;
  reloadRemote: () => void;
  redoPending: () => void;
  keepEditing: () => void;
  forceReset: () => void;
  reopenConflict: () => void;
  retryPending: () => void;
  dismissRecoveredNotice: () => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const CONFLICT_MESSAGE = 'This tab is based on an older workspace version. Review the changes before continuing.';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const initialRef = useRef<LoadedSession | null>(null);
  const [state, dispatch] = useReducer(workspaceReducer, undefined, () => {
    const loaded = loadWorkspace();
    initialRef.current = loaded;
    return loaded.workspace;
  });
  const initial = initialRef.current as LoadedSession;

  const stateRef = useRef(state);
  stateRef.current = state;
  const sessionRef = useRef<{ workspace: WorkspaceState; revision: number }>({ workspace: initial.workspace, revision: initial.revision });
  const pendingRef = useRef<PendingCommit | null>(null);
  const anchorRef = useRef<WorkspaceState | null>(null);
  const conflictRef = useRef<ConflictState | null>(null);

  const [storageHealthy, setStorageHealthy] = useState(true);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [pendingNotice, setPendingNotice] = useState<PendingNotice | null>(null);
  const [recoveredDocument, setRecoveredDocument] = useState(initial.recovered);

  const showConflict = useCallback((pending: PendingCommit, remote: WorkspaceState, remoteRevision: number) => {
    const next: ConflictState = {
      base: pending.base,
      local: pending.next,
      remote,
      baseRevision: pending.baseRevision,
      remoteRevision,
      intents: pending.intents,
      review: reviewChanges(pending.base, pending.next, remote),
      reset: pending.reset,
    };
    conflictRef.current = next;
    setConflict(next);
    setPendingNotice({ kind: 'conflict' });
    setStorageHealthy(true);
  }, []);

  /**
   * Attempt to persist a pending change. The in-memory document has already been
   * optimistically updated by the caller; this function only coordinates the
   * revision. A rejected write is retained in `pendingRef` and surfaced.
   */
  const flush = useCallback((pending: PendingCommit): 'committed' | 'conflict' | 'unavailable' => {
    // Even a reset goes through compare-and-swap: when storage advanced, the user
    // must explicitly choose between reloading and discarding the newer document.
    const outcome = commitWorkspace(pending.next, pending.baseRevision);
    if (outcome.kind === 'committed') {
      sessionRef.current = { workspace: pending.next, revision: outcome.revision };
      pendingRef.current = null;
      anchorRef.current = null;
      conflictRef.current = null;
      setConflict(null);
      setPendingNotice(null);
      setStorageHealthy(true);
      return 'committed';
    }
    if (outcome.kind === 'conflict') {
      showConflict(pending, outcome.current, outcome.currentRevision);
      return 'conflict';
    }
    setStorageHealthy(false);
    setPendingNotice({ kind: 'unavailable' });
    return 'unavailable';
  }, [showConflict]);

  /** Adopt a newer saved document when this tab has no unsaved work. */
  const adoptSession = useCallback((workspace: WorkspaceState, revision: number) => {
    sessionRef.current = { workspace, revision };
    pendingRef.current = null;
    conflictRef.current = null;
    setConflict(null);
    setPendingNotice(null);
    setStorageHealthy(true);
    dispatch({ type: 'workspace/replace', state: workspace });
  }, []);

  const applyAction = useCallback((action: WorkspaceAction | null, options: { reset?: boolean } = {}): CommandResult => {
    if (conflictRef.current) {
      return { ok: false, message: CONFLICT_MESSAGE };
    }
    const pending = pendingRef.current;
    const current = pending ? pending.next : stateRef.current;
    const base = pending ? pending.base : anchorRef.current ?? sessionRef.current.workspace;
    const baseRevision = pending ? pending.baseRevision : sessionRef.current.revision;
    const intents = pending ? pending.intents : [];

    let next: WorkspaceState;
    if (options.reset) {
      next = createSeedWorkspace();
    } else if (!action) {
      return { ok: false, message: 'Nothing to save.' };
    } else {
      try {
        next = workspaceReducer(current, action);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'The change could not be applied.' };
      }
    }

    // Readiness checks are derived metadata, not user data to re-express on merge.
    const foldedIntents = options.reset || !action
      ? []
      : action.type === 'project/readiness'
        ? intents
        : [...intents, action];

    const nextPending: PendingCommit = { next, intents: foldedIntents, base, baseRevision, reset: Boolean(options.reset) };
    pendingRef.current = nextPending;

    // Optimistically update the visible document; persistence is coordinated after dispatch.
    // A rejected write is retained for retry/conflict resolution rather than rolled back,
    // so the tab never loses work and the pending indicator explains the state.
    if (options.reset) dispatch({ type: 'workspace/replace', state: next });
    else if (action) dispatch(action);

    const flushResult = flush(nextPending);
    if (flushResult === 'unavailable') {
      return { ok: false, message: 'Your change could not be saved in this browser yet. It is held in this tab and saving retries automatically.' };
    }
    if (flushResult === 'conflict') {
      return { ok: false, message: CONFLICT_MESSAGE };
    }
    return { ok: true };
  }, [flush]);

  /* ------------------------------ legacy upgrade ----------------------------- */
  useEffect(() => {
    if (!initial.legacy) return;
    const outcome = commitInitialMigration(initial.workspace);
    if (outcome.kind !== 'migrated') {
      // Another tab wrapped (and possibly already edited past) the legacy document.
      // Only adopt it while this tab is idle; an anchored editor keeps its base so
      // the eventual commit is detected as a conflict instead of silently rebasing.
      if (!anchorRef.current && !pendingRef.current && !conflictRef.current) {
        const loaded = loadWorkspace();
        if (!loaded.recovered && loaded.revision !== sessionRef.current.revision) {
          adoptSession(loaded.workspace, loaded.revision);
        }
      }
    }
    // Runs once per tab on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------- cross-tab change detection ---------------------- */
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      const loaded = loadWorkspace();
      if (loaded.recovered) return; // a malformed write is handled separately
      if (loaded.revision <= sessionRef.current.revision) return;

      const pending = pendingRef.current;
      if (pending) {
        showConflict(pending, loaded.workspace, loaded.revision);
        return;
      }
      if (anchorRef.current) return; // an editor is open; adopt when the interaction ends
      adoptSession(loaded.workspace, loaded.revision);
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [adoptSession, showConflict]);

  /* --------------------------- interrupted-write retry ----------------------- */
  useEffect(() => {
    const retry = () => {
      const pending = pendingRef.current;
      if (pending && !conflictRef.current) void flush(pending);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('focus', retry);
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(retry, 4000);
    return () => {
      window.removeEventListener('focus', retry);
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
  }, [flush]);

  /* -------------------------------- commands --------------------------------- */
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
    const result = applyAction({ type: 'artifact/upsert', artifact });
    if (!result.ok) return { ok: false, errors: result.errors, message: result.message };
    return { ok: true, value: artifact };
  }, [applyAction]);

  const removeArtifact = useCallback((artifactId: string): CommandResult => {
    const artifact = stateRef.current.artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return { ok: false, message: 'The selected object no longer exists.' };
    return applyAction({ type: 'artifact/remove', artifactId });
  }, [applyAction]);

  const assignArtifact = useCallback((artifactId: string, zoneId: string): CommandResult => {
    return applyAction({ type: 'placement/assign', artifactId, zoneId });
  }, [applyAction]);

  const removePlacement = useCallback((artifactId: string): CommandResult => {
    return applyAction({ type: 'placement/remove', artifactId });
  }, [applyAction]);

  const reorderArtifact = useCallback((zoneId: string, artifactId: string, direction: -1 | 1): CommandResult => {
    return applyAction({ type: 'placement/reorder', zoneId, artifactId, direction });
  }, [applyAction]);

  const addIssue = useCallback((draft: IssueDraft): CommandResult => {
    if (!draft.title.trim()) return { ok: false, errors: { title: 'A finding title is required.' } };
    if (draft.description.trim().length < 16) return { ok: false, errors: { description: 'Add at least 16 characters of context.' } };
    if (!draft.owner.trim()) return { ok: false, errors: { owner: 'Assign an owner.' } };
    const now = new Date().toISOString();
    return applyAction({
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
  }, [applyAction]);

  const transitionReviewIssue = useCallback((issueId: string, status: IssueStatus): CommandResult => {
    const issue = stateRef.current.issues.find((candidate) => candidate.id === issueId);
    if (!issue) return { ok: false, message: 'The selected review finding no longer exists.' };
    return applyAction({ type: 'issue/transition', issueId, status });
  }, [applyAction]);

  const updatePreferences = useCallback((preferences: PlanningPreferences): CommandResult => {
    return applyAction({ type: 'preferences/update', preferences });
  }, [applyAction]);

  const checkReadiness = useCallback((): CommandResult<ReadinessResult> => {
    const analysis = analyzeJourney(stateRef.current.artifacts, stateRef.current.zones);
    const result = evaluateReadiness(stateRef.current, analysis);
    const command = applyAction({ type: 'project/readiness', ready: result.ready, checkedAt: result.checkedAt });
    if (!command.ok) return { ok: false, message: command.message, value: result };
    return { ok: true, value: result };
  }, [applyAction]);

  const createSnapshot = useCallback((): CommandResult<Snapshot> => {
    const analysis = analyzeJourney(stateRef.current.artifacts, stateRef.current.zones);
    const readiness = evaluateReadiness(stateRef.current, analysis);
    if (!readiness.ready) return { ok: false, message: readiness.blockers[0] ?? 'The plan is not ready.' };
    return { ok: true, value: buildSnapshot(stateRef.current, analysis, readiness) };
  }, []);

  const resetWorkspace = useCallback(() => applyAction(null, { reset: true }), [applyAction]);

  /* ------------------------------ interaction pin ---------------------------- */
  const beginInteraction = useCallback(() => {
    if (anchorRef.current) return;
    anchorRef.current = pendingRef.current ? pendingRef.current.base : sessionRef.current.workspace;
  }, []);

  const endInteraction = useCallback(() => {
    anchorRef.current = null;
    if (pendingRef.current || conflictRef.current) return;
    const loaded = loadWorkspace();
    if (!loaded.recovered && loaded.revision > sessionRef.current.revision) {
      adoptSession(loaded.workspace, loaded.revision);
    }
  }, [adoptSession]);

  /* ------------------------------- resolutions ------------------------------- */
  const reloadRemote = useCallback(() => {
    const current = conflictRef.current;
    if (current) {
      adoptSession(current.remote, current.remoteRevision);
      return;
    }
    const loaded = loadWorkspace();
    if (!loaded.recovered) adoptSession(loaded.workspace, loaded.revision);
  }, [adoptSession]);

  const redoPending = useCallback(() => {
    const current = conflictRef.current;
    if (!current || current.reset) return;
    const replay = replayIntents(current.intents, current.local, current.remote);
    if (replay.errors.length) {
      const withErrors: ConflictState = { ...current, replayErrors: replay.errors };
      conflictRef.current = withErrors;
      setConflict(withErrors);
      return;
    }
    // Re-validate an upserted artifact against the merged document so a duplicate
    // accession introduced by the other tab is reported rather than written.
    const upsert = current.intents.find((intent) => intent.type === 'artifact/upsert') as Extract<WorkspaceAction, { type: 'artifact/upsert' }> | undefined;
    if (upsert) {
      const validation = validateArtifactDraft(artifactToDraft(upsert.artifact), replay.state.artifacts, upsert.artifact.id);
      if (validation.length) {
        const withErrors: ConflictState = { ...current, replayErrors: validation.map((error) => error.message) };
        conflictRef.current = withErrors;
        setConflict(withErrors);
        return;
      }
    }
    const pending: PendingCommit = {
      next: replay.state,
      intents: current.intents,
      base: current.remote,
      baseRevision: current.remoteRevision,
      reset: false,
    };
    // Commit the rebased change first; only adopt it in-memory once storage accepts it,
    // so a second racing save rebuilds the conflict dialog rather than orphaning the write.
    const outcome = commitWorkspace(pending.next, pending.baseRevision);
    if (outcome.kind === 'unavailable') {
      pendingRef.current = pending;
      setStorageHealthy(false);
      setPendingNotice({ kind: 'unavailable' });
      return;
    }
    if (outcome.kind === 'conflict') {
      showConflict(pending, outcome.current, outcome.currentRevision);
      return;
    }
    // The replay document replaces the optimistic stale view; intents are not
    // re-dispatched because they are already folded into `replay.state`.
    dispatch({ type: 'workspace/replace', state: replay.state });
    sessionRef.current = { workspace: replay.state, revision: outcome.revision };
    pendingRef.current = null;
    anchorRef.current = null;
    conflictRef.current = null;
    setConflict(null);
    setPendingNotice(null);
    setStorageHealthy(true);
  }, [showConflict]);

  /** Hide the review dialog without resolving it; the banner keeps the conflict reachable. */
  const keepEditing = useCallback(() => {
    setConflict(null);
  }, []);

  const reopenConflict = useCallback(() => {
    if (conflictRef.current) setConflict(conflictRef.current);
  }, []);

  const forceReset = useCallback(() => {
    const current = conflictRef.current;
    if (!current || !current.reset) return;
    const outcome = overwriteWorkspace(current.local);
    if (outcome.kind !== 'committed') {
      setStorageHealthy(false);
      setPendingNotice({ kind: 'unavailable' });
      return;
    }
    dispatch({ type: 'workspace/replace', state: current.local });
    sessionRef.current = { workspace: current.local, revision: outcome.revision };
    pendingRef.current = null;
    anchorRef.current = null;
    conflictRef.current = null;
    setConflict(null);
    setPendingNotice(null);
    setStorageHealthy(true);
  }, []);

  const retryPending = useCallback(() => {
    const pending = pendingRef.current;
    if (pending) flush(pending);
  }, [flush]);

  const dismissRecoveredNotice = useCallback(() => {
    dismissRecovery();
    setRecoveredDocument(false);
    // The corrupt main document is now stashed and cleared; the sample-plan
    // session can commit normally again from the baseline revision.
  }, []);

  const value = useMemo<WorkspaceContextValue>(() => ({
    state,
    storageHealthy,
    conflict,
    recoveredDocument,
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
    beginInteraction,
    endInteraction,
    reloadRemote,
    redoPending,
    keepEditing,
    forceReset,
    reopenConflict,
    retryPending,
    dismissRecoveredNotice,
  }), [state, storageHealthy, conflict, pendingNotice, recoveredDocument, upsertArtifact, removeArtifact, assignArtifact, removePlacement, reorderArtifact, addIssue, transitionReviewIssue, updatePreferences, checkReadiness, createSnapshot, resetWorkspace, beginInteraction, endInteraction, reloadRemote, redoPending, keepEditing, forceReset, reopenConflict, retryPending, dismissRecoveredNotice]);

  return <WorkspaceContext.Provider value={value}>
    {children}
    <ConflictLayer
      conflict={conflict}
      notice={pendingNotice}
      recovered={recoveredDocument}
      onReload={reloadRemote}
      onRedo={redoPending}
      onKeep={keepEditing}
      onForceReset={forceReset}
      onReopen={reopenConflict}
      onRetry={retryPending}
      onDismissRecovered={dismissRecoveredNotice}
    />
  </WorkspaceContext.Provider>;
}

/* --------------------------------- UI layer --------------------------------- */

const ENTITY_LABEL: Record<string, string> = {
  object: 'Object',
  placement: 'Placement',
  finding: 'Finding',
  preferences: 'Preferences',
};

function ChangeList({ items, tone }: { items: NonNullable<ConflictState['review']>['local']; tone: 'local' | 'remote' }) {
  if (items.length === 0) return <p className="conflict-empty">No record-level changes detected.</p>;
  return <ul className="conflict-change-list">
    {items.map((item, index) => (
      <li key={`${item.key}-${index}`} className={`conflict-change conflict-change-${tone}`}>
        <div className="conflict-change-head"><Badge tone={tone === 'local' ? 'info' : 'warning'}>{ENTITY_LABEL[item.entity]}</Badge><strong>{item.title}</strong></div>
        <small>{titleCase(item.kind)}{item.detail ? ` · ${item.detail}` : ''}</small>
        {item.fields.length > 0 && <div className="conflict-fields">{item.fields.map((field) => <span key={field} className="conflict-field">{field}</span>)}</div>}
      </li>
    ))}
  </ul>;
}

function ConflictLayer(props: {
  conflict: ConflictState | null;
  notice: PendingNotice | null;
  recovered: boolean;
  onReload: () => void;
  onRedo: () => void;
  onKeep: () => void;
  onForceReset: () => void;
  onReopen: () => void;
  onRetry: () => void;
  onDismissRecovered: () => void;
}) {
  const { conflict, notice, recovered } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => { setAcknowledged(false); }, [conflict?.baseRevision, conflict?.remoteRevision]);

  return <>
    {recovered && !conflict && <div className="conflict-banner conflict-banner-warning" role="status">
      <FileWarning size={17} />
      <div><strong>Saved workspace could not be read.</strong><span>The unreadable copy is preserved under a recovery key. The sample plan is open; acknowledge to keep working. Nothing was deleted.</span></div>
      <Button variant="secondary" onClick={props.onDismissRecovered}>Acknowledge</Button>
    </div>}

    {notice?.kind === 'unavailable' && !conflict && <div className="conflict-banner conflict-banner-danger" role="alert">
      <CloudOff size={17} />
      <div><strong>Changes could not be saved to this browser.</strong><span>Your edits are kept in this tab and saving retries automatically. Do not close the tab until the indicator returns to “Saved locally”.</span></div>
      <Button variant="secondary" icon={<RefreshCw size={14} />} onClick={props.onRetry}>Retry now</Button>
    </div>}

    {notice?.kind === 'conflict' && !conflict && <div className="conflict-banner conflict-banner-warning" role="alert">
      <AlertTriangle size={17} />
      <div><strong>This tab is behind another saved version.</strong><span>Your unsaved changes have not been written over it. Review both versions to continue.</span></div>
      <Button variant="secondary" icon={<LifeBuoy size={14} />} onClick={props.onReopen}>Review changes</Button>
    </div>}

    {conflict && <Modal
      eyebrow="WORKSPACE VERSION CONFLICT"
      title="Another tab moved the workspace forward"
      onClose={props.onKeep}
      footer={conflict.reset
        ? <>
          <Button variant="ghost" onClick={props.onKeep}>Close</Button>
          <Button variant="secondary" icon={<RotateCcw size={15} />} onClick={props.onReload}>Reload saved plan</Button>
          <Button variant="danger" icon={<TriangleAlert size={15} />} onClick={props.onForceReset}>Discard saved changes and reset</Button>
        </>
        : <>
          <Button variant="ghost" onClick={props.onKeep}>Close</Button>
          <Button variant="secondary" icon={<RotateCcw size={15} />} onClick={props.onReload}>Reload newer version</Button>
          <Button variant="primary" disabled={conflict.review.overlap && !acknowledged || Boolean(conflict.replayErrors?.length)} onClick={props.onRedo}>Redo my change</Button>
        </>}
    >
      <div className="conflict-intro">
        <p>This tab’s change is based on revision <code>{conflict.baseRevision}</code>; another tab already saved revision <code>{conflict.remoteRevision}</code>. Nothing has been overwritten.</p>
        {conflict.review.overlap
          ? <div className="conflict-overlap"><AlertTriangle size={15} /><span><strong>Overlapping records detected.</strong> Compare the two sides carefully; redoing your change may supersede the saved edit on the same record.</span></div>
          : <div className="conflict-clean"><Badge tone="positive">No overlapping records</Badge><span>Your change touches different records, so it can be redone automatically.</span></div>}
      </div>
      <div className="conflict-columns">
        <section className="conflict-column">
          <div className="eyebrow">YOUR UNSAVED CHANGE</div>
          <ChangeList items={conflict.review.local} tone="local" />
        </section>
        <section className="conflict-column">
          <div className="eyebrow">SAVED IN THE OTHER TAB</div>
          <ChangeList items={conflict.review.remote} tone="remote" />
        </section>
      </div>
      {conflict.replayErrors && conflict.replayErrors.length > 0 && <div className="conflict-replay-errors">
        <strong>The change could not be replayed cleanly:</strong>
        <ul>{conflict.replayErrors.map((error, index) => <li key={index}>{error}</li>)}</ul>
        <span>Reload the newer version and apply your edit there instead.</span>
      </div>}
      {conflict.review.overlap && !conflict.reset && <label className="conflict-confirm">
        <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
        <span>I have compared the changes and confirm the records no longer conflict. Redo my change on top of revision {conflict.remoteRevision}.</span>
      </label>}
      {conflict.reset && <div className="conflict-overlap"><AlertTriangle size={15} /><span>Resetting replaces every saved record with the sample plan. Reload to keep the saved plan, or explicitly discard it.</span></div>}
      {!conflict.reset && <p className="conflict-footnote">Redo reapplies your change on top of revision {conflict.remoteRevision}. Close keeps this conflict open as a banner; your change will not be written until you reload or redo.</p>}
    </Modal>}
  </>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return value;
}
