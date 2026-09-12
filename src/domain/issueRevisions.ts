import { createId } from './ids';
import type {
  IssueDraft,
  IssueEditableField,
  IssueFieldChange,
  IssueRevision,
  IssueRevisionField,
  ReviewIssue,
} from './models';

export const ISSUE_EDITABLE_FIELDS: IssueEditableField[] = ['title', 'description', 'severity', 'owner', 'zoneId', 'artifactId'];

export const ISSUE_FIELD_LABELS: Record<IssueRevisionField, string> = {
  title: 'Title',
  description: 'Description',
  severity: 'Severity',
  owner: 'Owner',
  zoneId: 'Linked zone',
  artifactId: 'Linked object',
  status: 'Status',
};

export interface IssueEditInput {
  issueId: string;
  /** Snapshot of the finding captured when the editor was opened. */
  base: ReviewIssue;
  draft: IssueDraft;
  editor: string;
  rationale: string;
}

export interface IssueFieldConflict {
  field: IssueEditableField;
  /** Value currently stored (the other page's edit). */
  current: string;
  /** Value this edit proposes. */
  yours: string;
}

export interface IssueMergePreview {
  merged: ReviewIssue;
  revision: IssueRevision;
  /** Fields both sides changed to different values; merging keeps yours. */
  fieldConflicts: IssueFieldConflict[];
  /** Fields the other version changed that this edit leaves untouched. */
  keptTheirChanges: IssueFieldChange[];
}

export type IssueEditResult =
  | { kind: 'committed'; issue: ReviewIssue; revision: IssueRevision }
  | { kind: 'conflict'; current: ReviewIssue; preview: IssueMergePreview }
  | { kind: 'unchanged' }
  | { kind: 'invalid'; errors: Record<string, string> }
  | { kind: 'missing' };

export type IssueMergeResult =
  | { kind: 'committed'; issue: ReviewIssue; revision: IssueRevision }
  | { kind: 'unchanged' }
  | { kind: 'missing' };

export function draftFromIssue(issue: ReviewIssue): IssueDraft {
  return {
    title: issue.title,
    description: issue.description,
    severity: issue.severity,
    owner: issue.owner,
    zoneId: issue.zoneId ?? '',
    artifactId: issue.artifactId ?? '',
  };
}

export function issueFieldValue(issue: ReviewIssue, field: IssueRevisionField): string {
  const value = issue[field];
  return value ?? '';
}

export function diffIssueFields(before: ReviewIssue, after: ReviewIssue): IssueFieldChange[] {
  return ISSUE_EDITABLE_FIELDS
    .map((field) => ({ field, before: issueFieldValue(before, field), after: issueFieldValue(after, field) }))
    .filter((change) => change.before !== change.after);
}

export function validateIssueDraft(draft: IssueDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.title.trim()) errors.title = 'A finding title is required.';
  if (draft.description.trim().length < 16) errors.description = 'Add at least 16 characters of context.';
  if (!draft.owner.trim()) errors.owner = 'Assign an owner.';
  return errors;
}

export function validateIssueEditMeta(editor: string, rationale: string): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!editor.trim()) errors.editor = 'Name who is making this change.';
  if (rationale.trim().length < 8) errors.rationale = 'Explain the basis for this change (at least 8 characters).';
  return errors;
}

export function applyDraftToIssue(issue: ReviewIssue, draft: IssueDraft): ReviewIssue {
  return {
    ...issue,
    title: draft.title.trim(),
    description: draft.description.trim(),
    severity: draft.severity,
    owner: draft.owner.trim(),
    zoneId: draft.zoneId || undefined,
    artifactId: draft.artifactId || undefined,
  };
}

/**
 * Three-way merge of an edit proposal: fields the draft changed relative to the
 * captured base win; everything else keeps the current (other page's) values.
 */
export function mergeIssueDraft(base: ReviewIssue, current: ReviewIssue, draft: IssueDraft): ReviewIssue {
  const proposed = applyDraftToIssue(base, draft);
  const pick = <K extends IssueEditableField>(field: K): ReviewIssue[K] =>
    issueFieldValue(base, field) !== issueFieldValue(proposed, field) ? proposed[field] : current[field];
  return {
    ...current,
    title: pick('title'),
    description: pick('description'),
    severity: pick('severity'),
    owner: pick('owner'),
    zoneId: pick('zoneId'),
    artifactId: pick('artifactId'),
  };
}

function buildRevision(
  kind: IssueRevision['kind'],
  issueId: string,
  baseVersion: number,
  resultVersion: number,
  editor: string,
  rationale: string,
  changes: IssueFieldChange[],
  at: Date,
): IssueRevision {
  return {
    id: createId('rev'),
    issueId,
    kind,
    baseVersion,
    resultVersion,
    editor: editor.trim(),
    rationale: rationale.trim(),
    changes,
    committedAt: at.toISOString(),
  };
}

export function buildCreationRevision(issue: ReviewIssue, at: Date | string = new Date(), id = createId('rev')): IssueRevision {
  return {
    id,
    issueId: issue.id,
    kind: 'create',
    baseVersion: 0,
    resultVersion: issue.version,
    editor: issue.owner,
    rationale: 'Finding captured.',
    changes: ISSUE_EDITABLE_FIELDS.map((field) => ({ field, before: '', after: issueFieldValue(issue, field) })),
    committedAt: typeof at === 'string' ? at : at.toISOString(),
  };
}

export function buildStatusRevision(before: ReviewIssue, after: ReviewIssue, at = new Date()): IssueRevision {
  return buildRevision(
    'status',
    before.id,
    before.version,
    after.version,
    before.owner,
    `Status moved from ${before.status} to ${after.status}.`,
    [{ field: 'status', before: before.status, after: after.status }],
    at,
  );
}

function buildMergePreview(current: ReviewIssue, input: IssueEditInput, at: Date): IssueMergePreview {
  const merged = mergeIssueDraft(input.base, current, input.draft);
  const proposed = applyDraftToIssue(input.base, input.draft);
  const fieldConflicts: IssueFieldConflict[] = ISSUE_EDITABLE_FIELDS
    .map((field) => ({
      field,
      base: issueFieldValue(input.base, field),
      current: issueFieldValue(current, field),
      yours: issueFieldValue(proposed, field),
    }))
    .filter((entry) => entry.base !== entry.current && entry.base !== entry.yours && entry.current !== entry.yours)
    .map((entry) => ({ field: entry.field, current: entry.current, yours: entry.yours }));
  const myFields = new Set(diffIssueFields(input.base, proposed).map((change) => change.field));
  const keptTheirChanges = diffIssueFields(input.base, current).filter((change) => !myFields.has(change.field as IssueEditableField));
  const revision = buildRevision(
    'merge',
    input.issueId,
    input.base.version,
    current.version + 1,
    input.editor,
    input.rationale,
    diffIssueFields(current, merged),
    at,
  );
  return { merged, revision, fieldConflicts, keptTheirChanges };
}

/**
 * Attempts to commit an edit as a versioned transaction. When the stored finding
 * moved past the version the editor was opened from, no write happens; instead a
 * merge preview is returned so the user can confirm a merge or discard the edit.
 */
export function prepareIssueEdit(current: ReviewIssue | undefined, input: IssueEditInput, at = new Date()): IssueEditResult {
  const errors = { ...validateIssueDraft(input.draft), ...validateIssueEditMeta(input.editor, input.rationale) };
  if (Object.keys(errors).length) return { kind: 'invalid', errors };
  if (!current) return { kind: 'missing' };
  const proposed = applyDraftToIssue(input.base, input.draft);
  const changes = diffIssueFields(input.base, proposed);
  if (!changes.length) return { kind: 'unchanged' };
  if (current.version !== input.base.version) {
    return { kind: 'conflict', current, preview: buildMergePreview(current, input, at) };
  }
  const issue: ReviewIssue = { ...applyDraftToIssue(current, input.draft), version: current.version + 1, updatedAt: at.toISOString() };
  const revision = buildRevision('edit', input.issueId, input.base.version, issue.version, input.editor, input.rationale, changes, at);
  return { kind: 'committed', issue, revision };
}

/**
 * Commits a previously conflicted edit as a merge on top of the freshest stored
 * finding. The recorded revision always diffs against the state it actually
 * replaces, so the history stays exact even if versions moved again.
 */
export function confirmIssueMerge(current: ReviewIssue | undefined, input: IssueEditInput, at = new Date()): IssueMergeResult {
  if (!current) return { kind: 'missing' };
  const merged = mergeIssueDraft(input.base, current, input.draft);
  const changes = diffIssueFields(current, merged);
  if (!changes.length) return { kind: 'unchanged' };
  const issue: ReviewIssue = { ...merged, version: current.version + 1, updatedAt: at.toISOString() };
  const revision = buildRevision('merge', input.issueId, input.base.version, issue.version, input.editor, input.rationale, changes, at);
  return { kind: 'committed', issue, revision };
}

export function revisionsForIssue(history: IssueRevision[], issueId: string): IssueRevision[] {
  return history
    .filter((revision) => revision.issueId === issueId)
    .sort((a, b) => b.resultVersion - a.resultVersion || b.committedAt.localeCompare(a.committedAt));
}
