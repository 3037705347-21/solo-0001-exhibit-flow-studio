import { describe, expect, it } from 'vitest';
import {
  buildCreationRevision,
  buildStatusRevision,
  confirmIssueMerge,
  diffIssueFields,
  draftFromIssue,
  mergeIssueDraft,
  prepareIssueEdit,
  revisionsForIssue,
  type IssueEditInput,
} from './issueRevisions';
import { transitionIssue } from './transitions';
import type { IssueDraft, ReviewIssue } from './models';

const AT = new Date('2026-09-12T09:00:00.000Z');

function makeIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
  return {
    id: 'issue-1',
    title: 'Original title',
    description: 'Original description of the finding.',
    severity: 'warning',
    status: 'open',
    zoneId: 'zone-arrival',
    artifactId: undefined,
    owner: 'Mara Chen',
    version: 3,
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeDraft(overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    title: 'Original title',
    description: 'Original description of the finding.',
    severity: 'warning',
    owner: 'Mara Chen',
    zoneId: 'zone-arrival',
    artifactId: '',
    ...overrides,
  };
}

function makeInput(base: ReviewIssue, draft: IssueDraft, overrides: Partial<IssueEditInput> = {}): IssueEditInput {
  return {
    issueId: base.id,
    base,
    draft,
    editor: 'Theo James',
    rationale: 'Corrected after the walkthrough.',
    ...overrides,
  };
}

describe('prepareIssueEdit', () => {
  it('commits a normal edit with before/after values, editor, rationale, and base version', () => {
    const base = makeIssue();
    const draft = makeDraft({ title: 'Shorten entry panel copy', severity: 'critical' });
    const result = prepareIssueEdit(base, makeInput(base, draft), AT);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.issue.title).toBe('Shorten entry panel copy');
    expect(result.issue.severity).toBe('critical');
    expect(result.issue.version).toBe(4);
    expect(result.issue.updatedAt).toBe(AT.toISOString());
    expect(result.revision.kind).toBe('edit');
    expect(result.revision.baseVersion).toBe(3);
    expect(result.revision.resultVersion).toBe(4);
    expect(result.revision.editor).toBe('Theo James');
    expect(result.revision.rationale).toBe('Corrected after the walkthrough.');
    expect(result.revision.changes).toEqual([
      { field: 'title', before: 'Original title', after: 'Shorten entry panel copy' },
      { field: 'severity', before: 'warning', after: 'critical' },
    ]);
  });

  it('normalizes empty link selections to no link', () => {
    const base = makeIssue({ artifactId: 'artifact-tape' });
    const draft = makeDraft({ artifactId: '' });
    const result = prepareIssueEdit(base, makeInput(base, draft), AT);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.issue.artifactId).toBeUndefined();
    expect(result.revision.changes).toEqual([{ field: 'artifactId', before: 'artifact-tape', after: '' }]);
  });

  it('rejects invalid drafts and missing edit metadata', () => {
    const base = makeIssue();
    const draft = makeDraft({ title: ' ', description: 'short', owner: '' });
    const result = prepareIssueEdit(base, makeInput(base, draft, { editor: '', rationale: 'no' }), AT);
    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(Object.keys(result.errors).sort()).toEqual(['description', 'editor', 'owner', 'rationale', 'title']);
  });

  it('reports unchanged when the draft matches the base', () => {
    const base = makeIssue();
    expect(prepareIssueEdit(base, makeInput(base, makeDraft()), AT).kind).toBe('unchanged');
  });

  it('reports missing when the finding no longer exists', () => {
    const base = makeIssue();
    expect(prepareIssueEdit(undefined, makeInput(base, makeDraft({ title: 'New title' })), AT).kind).toBe('missing');
  });

  it('detects a version conflict when the stored finding moved past the base version', () => {
    const base = makeIssue();
    // Another page edited the owner and the severity while this editor was open.
    const current = makeIssue({ owner: 'Rina Solberg', severity: 'critical', version: 4 });
    const draft = makeDraft({ title: 'Shorten entry panel copy', severity: 'note' });
    const result = prepareIssueEdit(current, makeInput(base, draft), AT);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.current.version).toBe(4);
    // My changed fields win; their untouched-by-me owner change is kept.
    expect(result.preview.merged.title).toBe('Shorten entry panel copy');
    expect(result.preview.merged.severity).toBe('note');
    expect(result.preview.merged.owner).toBe('Rina Solberg');
    // Severity was changed by both sides to different values.
    expect(result.preview.fieldConflicts).toEqual([{ field: 'severity', current: 'critical', yours: 'note' }]);
    expect(result.preview.keptTheirChanges).toEqual([{ field: 'owner', before: 'Mara Chen', after: 'Rina Solberg' }]);
    // The recorded revision diffs against the stored version it would replace.
    expect(result.preview.revision.kind).toBe('merge');
    expect(result.preview.revision.baseVersion).toBe(3);
    expect(result.preview.revision.resultVersion).toBe(5);
    expect(result.preview.revision.changes).toEqual([
      { field: 'title', before: 'Original title', after: 'Shorten entry panel copy' },
      { field: 'severity', before: 'critical', after: 'note' },
    ]);
  });

  it('does not flag a field conflict when both sides made the same change', () => {
    const base = makeIssue();
    const current = makeIssue({ title: 'Same new title', version: 4 });
    const draft = makeDraft({ title: 'Same new title' });
    const result = prepareIssueEdit(current, makeInput(base, draft), AT);
    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') return;
    expect(result.preview.fieldConflicts).toEqual([]);
    expect(result.preview.revision.changes).toEqual([]);
  });
});

describe('confirmIssueMerge', () => {
  it('commits the merge against the freshest stored version', () => {
    const base = makeIssue();
    const current = makeIssue({ owner: 'Rina Solberg', version: 4 });
    const input = makeInput(base, makeDraft({ title: 'Shorten entry panel copy' }));
    const result = confirmIssueMerge(current, input, AT);
    expect(result.kind).toBe('committed');
    if (result.kind !== 'committed') return;
    expect(result.issue.title).toBe('Shorten entry panel copy');
    expect(result.issue.owner).toBe('Rina Solberg');
    expect(result.issue.version).toBe(5);
    expect(result.revision.kind).toBe('merge');
    expect(result.revision.changes).toEqual([{ field: 'title', before: 'Original title', after: 'Shorten entry panel copy' }]);
  });

  it('reports unchanged when the latest version already includes the edit', () => {
    const base = makeIssue();
    const current = makeIssue({ title: 'Shorten entry panel copy', version: 4 });
    const result = confirmIssueMerge(current, makeInput(base, makeDraft({ title: 'Shorten entry panel copy' })), AT);
    expect(result.kind).toBe('unchanged');
  });

  it('reports missing when the finding was removed', () => {
    const base = makeIssue();
    expect(confirmIssueMerge(undefined, makeInput(base, makeDraft({ title: 'X' })), AT).kind).toBe('missing');
  });
});

describe('mergeIssueDraft', () => {
  it('keeps their link changes when the edit only touched text fields', () => {
    const base = makeIssue();
    const current = makeIssue({ zoneId: 'zone-after', artifactId: 'artifact-tape', version: 4 });
    const merged = mergeIssueDraft(base, current, makeDraft({ title: 'Retitled finding' }));
    expect(merged.title).toBe('Retitled finding');
    expect(merged.zoneId).toBe('zone-after');
    expect(merged.artifactId).toBe('artifact-tape');
  });

  it('applies link removals from the edit over their untouched links', () => {
    const base = makeIssue({ zoneId: 'zone-arrival' });
    const current = makeIssue({ version: 4 });
    const merged = mergeIssueDraft(base, current, makeDraft({ zoneId: '' }));
    expect(merged.zoneId).toBeUndefined();
  });
});

describe('revision builders', () => {
  it('records creation with every field captured from empty', () => {
    const issue = makeIssue({ version: 1 });
    const revision = buildCreationRevision(issue, AT);
    expect(revision.kind).toBe('create');
    expect(revision.baseVersion).toBe(0);
    expect(revision.resultVersion).toBe(1);
    expect(revision.editor).toBe('Mara Chen');
    expect(revision.changes).toHaveLength(6);
    expect(revision.changes.every((change) => change.before === '')).toBe(true);
    expect(revision.changes.find((change) => change.field === 'title')?.after).toBe('Original title');
  });

  it('records status transitions with the version bump', () => {
    const before = makeIssue({ version: 2 });
    const after = transitionIssue(before, 'in-progress', AT);
    const revision = buildStatusRevision(before, after, AT);
    expect(revision.kind).toBe('status');
    expect(revision.baseVersion).toBe(2);
    expect(revision.resultVersion).toBe(3);
    expect(revision.changes).toEqual([{ field: 'status', before: 'open', after: 'in-progress' }]);
  });
});

describe('diffIssueFields and drafts', () => {
  it('round-trips an issue through its draft without changes', () => {
    const issue = makeIssue({ artifactId: 'artifact-tape' });
    expect(diffIssueFields(issue, { ...issue, ...draftFromIssue(issue), artifactId: 'artifact-tape' })).toEqual([]);
  });
});

describe('revisionsForIssue', () => {
  it('returns only the finding’s revisions, newest version first', () => {
    const issue = makeIssue({ version: 1 });
    const created = buildCreationRevision(issue, AT);
    const other = { ...buildCreationRevision(makeIssue({ id: 'issue-2', version: 1 }), AT) };
    const later = { ...created, id: 'rev-2', resultVersion: 2, baseVersion: 1, committedAt: '2026-09-13T09:00:00.000Z' };
    const history = revisionsForIssue([created, other, later], 'issue-1');
    expect(history.map((revision) => revision.resultVersion)).toEqual([2, 1]);
  });
});
