import { validateArtifactDraft } from './artifactValidation';
import type { Artifact, ArtifactDraft, BatchTransactionRecord, ValidationError, WorkspaceState } from './models';

/**
 * Auditable batch editing for the collection.
 *
 * A batch transaction is prepared against a known revision of each object and
 * committed atomically: at submit time every target is re-read from the
 * current state and classified. If any target is invalid, stale, or missing,
 * the whole transaction is rejected and no object is touched. A committed
 * transaction is recorded with its id so retries are idempotent.
 */

export type BatchFieldKey =
  | 'narrativeRole'
  | 'sensitivity'
  | 'accessibilityNeed'
  | 'dwellMinutes'
  | 'isKeyObject';

export type BatchPatch = Partial<Pick<Artifact, BatchFieldKey>>;

export interface BatchItemPlan {
  artifactId: string;
  /** Revision the user reviewed when preparing the transaction. */
  baseRevision: string;
  patch: BatchPatch;
  changes: Array<{ field: BatchFieldKey; from: Artifact[BatchFieldKey]; to: Artifact[BatchFieldKey] }>;
}

export type BatchItemStatus = 'safe' | 'stale' | 'missing' | 'invalid';

export interface BatchItemResult {
  artifactId: string;
  accessionId?: string;
  title?: string;
  status: BatchItemStatus;
  /** True for a stale record whose current values already equal the patch. */
  conflictsWithPatch: boolean;
  changedFields: BatchFieldKey[];
  errors: ValidationError[];
  detail: string;
}

export interface BatchTransaction {
  id: string;
  createdAt: string;
  items: BatchItemPlan[];
}

export type BatchCommitOutcome =
  | { status: 'committed'; transaction: BatchTransactionRecord; state: WorkspaceState }
  | { status: 'duplicate'; transaction: BatchTransactionRecord }
  | { status: 'rejected'; items: BatchItemResult[]; updatedAt: string };

export interface BatchAuditState {
  transactions: BatchTransactionRecord[];
}

export const EMPTY_BATCH_AUDIT: BatchAuditState = { transactions: [] };

/** Fields a batch edit is allowed to touch. Anything else is an illegal field. */
export const BATCH_FIELDS: readonly BatchFieldKey[] = [
  'narrativeRole',
  'sensitivity',
  'accessibilityNeed',
  'dwellMinutes',
  'isKeyObject',
];

/** Fields a batch edit is allowed to touch. Anything else is an illegal field. */

const ROLE_VALUES = ['threshold', 'context', 'turning-point', 'reflection'];
const SENSITIVITY_VALUES = ['standard', 'low-light', 'fragile'];
const ACCESSIBILITY_VALUES = ['none', 'seating', 'audio', 'tactile-alternative'];

/**
 * Rejects patch keys that are not part of the auditable batch surface. This
 * guards the command boundary so a caller cannot smuggle id, accessionId, or
 * timestamp changes through a bulk edit.
 */
export function validatePatchShape(patch: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of Object.keys(patch)) {
    if (!BATCH_FIELDS.includes(key as BatchFieldKey)) {
      errors.push({ field: key, message: `"${key}" cannot be changed by a batch edit.` });
    }
  }
  const check = (field: BatchFieldKey, allowed: readonly string[]) => {
    const value = patch[field];
    if (value !== undefined && !allowed.includes(value as string)) {
      errors.push({ field, message: `Unsupported value for ${field}.` });
    }
  };
  check('narrativeRole', ROLE_VALUES);
  check('sensitivity', SENSITIVITY_VALUES);
  check('accessibilityNeed', ACCESSIBILITY_VALUES);
  if (patch.dwellMinutes !== undefined) {
    const dwell = patch.dwellMinutes;
    if (typeof dwell !== 'number' || !Number.isFinite(dwell) || dwell <= 0 || dwell > 30) {
      errors.push({ field: 'dwellMinutes', message: 'Dwell time must be between 1 and 30 minutes.' });
    }
  }
  if (patch.isKeyObject !== undefined && typeof patch.isKeyObject !== 'boolean') {
    errors.push({ field: 'isKeyObject', message: 'Key object flag must be true or false.' });
  }
  return errors;
}

function diffPatch(artifact: Artifact, patch: BatchPatch): BatchItemPlan['changes'] {
  return BATCH_FIELDS.flatMap((field) => {
    const next = patch[field];
    if (next === undefined || artifact[field] === next) return [];
    return [{ field, from: artifact[field], to: next }];
  });
}

/**
 * Prepares a transaction from the objects the user selected and reviewed.
 * Items whose current revision differs from the one the user opened, or whose
 * resulting record would be invalid, are reported up front; they must be
 * resolved before the transaction can even be confirmed.
 */
export function planBatchTransaction(args: {
  id: string;
  artifacts: Artifact[];
  selections: Array<{ artifactId: string; baseRevision: string; patch: BatchPatch }>;
  now?: Date;
}): { transaction: BatchTransaction | null; items: BatchItemResult[] } {
  const items: BatchItemResult[] = [];
  const plans: BatchItemPlan[] = [];

  for (const selection of args.selections) {
    const current = args.artifacts.find((artifact) => artifact.id === selection.artifactId);
    if (!current) {
      items.push({
        artifactId: selection.artifactId,
        status: 'missing',
        conflictsWithPatch: false,
        changedFields: [],
        errors: [],
        detail: 'This object was removed from the collection after it was selected.',
      });
      continue;
    }
    if (current.updatedAt !== selection.baseRevision) {
      const changes = diffPatch(current, selection.patch);
      items.push({
        artifactId: current.id,
        accessionId: current.accessionId,
        title: current.title,
        status: 'stale',
        conflictsWithPatch: changes.length > 0,
        changedFields: changes.map((change) => change.field),
        errors: [],
        detail: changes.length
          ? `Changed since review (${changes.map((change) => change.field).join(', ')} needs another look).`
          : 'Changed since review, but the requested values already match.',
      });
      continue;
    }
    const draft = artifactToBatchDraft(current, selection.patch);
    const errors = validateArtifactDraft(draft, args.artifacts, current.id);
    if (errors.length) {
      items.push({
        artifactId: current.id,
        accessionId: current.accessionId,
        title: current.title,
        status: 'invalid',
        conflictsWithPatch: false,
        changedFields: Object.keys(selection.patch) as BatchFieldKey[],
        errors,
        detail: 'The requested change would violate object validation.',
      });
      continue;
    }
    // An object that already has every requested value is a safe no-op member
    // of the batch: it stays in the audit count but produces no update.
    plans.push({ artifactId: current.id, baseRevision: current.updatedAt, patch: selection.patch, changes: diffPatch(current, selection.patch) });
  }

  return {
    transaction: items.length === 0 && plans.length > 0
      ? { id: args.id, createdAt: (args.now ?? new Date()).toISOString(), items: plans }
      : null,
    items,
  };
}

function artifactToBatchDraft(artifact: Artifact, patch: BatchPatch): ArtifactDraft {
  return {
    accessionId: artifact.accessionId,
    title: artifact.title,
    maker: artifact.maker,
    yearLabel: artifact.yearLabel,
    medium: artifact.medium,
    origin: artifact.origin,
    summary: artifact.summary,
    width: String(artifact.dimensions.width),
    height: String(artifact.dimensions.height),
    depth: String(artifact.dimensions.depth),
    dwellMinutes: String(patch.dwellMinutes ?? artifact.dwellMinutes),
    narrativeRole: patch.narrativeRole ?? artifact.narrativeRole,
    sensitivity: patch.sensitivity ?? artifact.sensitivity,
    accessibilityNeed: patch.accessibilityNeed ?? artifact.accessibilityNeed,
    isKeyObject: patch.isKeyObject ?? artifact.isKeyObject,
    tags: artifact.tags.join(', '),
    color: artifact.color,
  };
}

/**
 * Re-reads every target from the live state and applies the transaction only
 * when every item is still safe. Returns a per-item classification on reject.
 * Pure with respect to state; the caller persists and dispatches the result.
 */
export function commitBatchTransaction(args: {
  state: WorkspaceState;
  audit: BatchAuditState;
  transaction: BatchTransaction;
  now?: Date;
}): BatchCommitOutcome {
  const { state, audit, transaction } = args;
  const existing = audit.transactions.find((record) => record.id === transaction.id);
  if (existing) return { status: 'duplicate', transaction: existing };

  const committedAt = (args.now ?? new Date()).toISOString();
  const results: BatchItemResult[] = [];
  const updates = new Map<string, Artifact>();

  for (const plan of transaction.items) {
    const current = state.artifacts.find((artifact) => artifact.id === plan.artifactId);
    if (!current) {
      results.push({
        artifactId: plan.artifactId,
        status: 'missing',
        conflictsWithPatch: false,
        changedFields: [],
        errors: [],
        detail: 'This object no longer exists in the collection.',
      });
      continue;
    }
    if (current.updatedAt !== plan.baseRevision) {
      const changes = diffPatch(current, plan.patch);
      results.push({
        artifactId: current.id,
        accessionId: current.accessionId,
        title: current.title,
        status: 'stale',
        conflictsWithPatch: changes.length > 0,
        changedFields: changes.map((change) => change.field),
        errors: [],
        detail: changes.length
          ? `Another edit changed this object after review (${changes.map((change) => change.field).join(', ')}).`
          : 'Another edit touched this object, but it already has the requested values.',
      });
      continue;
    }
    const draft = artifactToBatchDraft(current, plan.patch);
    const errors = validateArtifactDraft(draft, state.artifacts, current.id);
    if (errors.length) {
      results.push({
        artifactId: current.id,
        accessionId: current.accessionId,
        title: current.title,
        status: 'invalid',
        conflictsWithPatch: false,
        changedFields: plan.changes.map((change) => change.field),
        errors,
        detail: 'Validation no longer passes for the current version of this object.',
      });
      continue;
    }
    const changes = diffPatch(current, plan.patch);
    if (changes.length === 0) {
      // Already has the requested values: keep the artifact untouched but the
      // item is still a safe member of the atomic transaction.
      results.push({
        artifactId: current.id,
        accessionId: current.accessionId,
        title: current.title,
        status: 'safe',
        conflictsWithPatch: false,
        changedFields: [],
        errors: [],
        detail: 'Already has the requested values; left unchanged.',
      });
      continue;
    }
    updates.set(current.id, { ...current, ...plan.patch, updatedAt: committedAt });
    results.push({
      artifactId: current.id,
      accessionId: current.accessionId,
      title: current.title,
      status: 'safe',
      conflictsWithPatch: false,
      changedFields: changes.map((change) => change.field),
      errors: [],
      detail: `Applied ${changes.length} field ${changes.length === 1 ? 'change' : 'changes'}.`,
    });
  }

  if (results.some((item) => item.status !== 'safe')) {
    // Nothing was applied: the caller keeps the original state and audit log.
    return { status: 'rejected', items: results, updatedAt: committedAt };
  }

  const artifacts = state.artifacts.map((artifact) => updates.get(artifact.id) ?? artifact);
  const fields = Array.from(new Set(transaction.items.flatMap((plan) => plan.changes.map((change) => change.field))));
  const record: BatchTransactionRecord = {
    id: transaction.id,
    createdAt: transaction.createdAt,
    committedAt,
    itemCount: transaction.items.length,
    artifactIds: transaction.items.map((plan) => plan.artifactId),
    fields,
    appliedRevision: committedAt,
  };
  return {
    status: 'committed',
    transaction: record,
    state: { ...state, artifacts, lastSavedAt: committedAt },
  };
}

/** Stable list of the concrete value changes the user is asked to confirm. */
export function summarizeBatchSelection(
  artifacts: Artifact[],
  selections: Array<{ artifactId: string; patch: BatchPatch }>,
): Map<string, BatchItemPlan['changes']> {
  const summary = new Map<string, BatchItemPlan['changes']>();
  for (const selection of selections) {
    const artifact = artifacts.find((candidate) => candidate.id === selection.artifactId);
    if (artifact) summary.set(selection.artifactId, diffPatch(artifact, selection.patch));
  }
  return summary;
}
