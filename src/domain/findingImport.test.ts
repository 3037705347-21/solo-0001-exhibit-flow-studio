import { describe, expect, it } from 'vitest';
import {
  buildFindingImportPlan,
  commitFindingImport,
  findingImportTemplateCsv,
  parseCsv,
  type FindingImportDraft,
} from './findingImport';
import type { WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';

const HEADER = 'Title,Description,Severity,Owner,Zone Name,Accession ID';

function state(): WorkspaceState {
  return createSeedWorkspace();
}

function validRow(overrides: string[] = []): string {
  const base = [
    'Add large-print wall text',
    'Visitors with low vision cannot read the 10pt panel near the entrance door.',
    'warning',
    'Mara Chen',
    'Arrival / A Light Carried',
    'AF-1908-014',
  ];
  const cells = overrides.length ? base.map((value, index) => (overrides[index] !== undefined ? overrides[index] : value)) : base;
  return cells.map((cell) => (cell.includes(',') ? `"${cell}"` : cell)).join(',');
}

describe('finding CSV parser', () => {
  it('reads quoted fields containing commas and new lines', () => {
    const result = parseCsv('Title,Description\n"Hello, team","line one\nline two"');
    expect('rows' in result).toBe(true);
    if (!('rows' in result)) return;
    expect(result.rows[1].cells[0]).toBe('Hello, team');
    expect(result.rows[1].cells[1]).toBe('line one\nline two');
  });

  it('drops completely blank lines including trailing newlines', () => {
    const result = parseCsv('Title,Owner\n\nA,Mara\n\n');
    expect('rows' in result).toBe(true);
    if (!('rows' in result)) return;
    expect(result.rows).toHaveLength(2);
  });

  it('reports an unterminated quoted field as a file-level error', () => {
    const result = parseCsv('Title\n"never closed');
    expect('parseError' in result).toBe(true);
  });
});

describe('buildFindingImportPlan', () => {
  it('classifies every well-formed row as a create with resolved references', () => {
    const plan = buildFindingImportPlan(`${HEADER}\n${validRow()}`, state());
    expect(plan.ok).toBe(true);
    expect(plan.createCount).toBe(1);
    expect(plan.ignoreCount).toBe(0);
    expect(plan.failCount).toBe(0);
    const row = plan.rows[0];
    expect(row.status).toBe('create');
    expect(row.severity).toBe('warning');
    expect(row.zoneId).toBe('zone-arrival');
    expect(row.artifactId).toBe('artifact-lantern');
    expect(row.accessionId).toBe('AF-1908-014');
  });

  it('accepts severity aliases case-insensitively', () => {
    const csv = [
      HEADER,
      validRow(['A note row', 'A short description that clears sixteen characters.', 'NOTE', 'Theo James', '', '']),
      validRow(['A blocker row', 'A short description that clears sixteen characters.', 'BLOCKER', 'Theo James', '', '']),
    ].join('\n');
    const plan = buildFindingImportPlan(csv, state());
    expect(plan.failCount).toBe(0);
    expect(plan.rows.map((row) => row.severity)).toEqual(['note', 'critical']);
  });

  it('marks unmatched zones and accession ids with understandable errors and never creates them', () => {
    const csv = [
      HEADER,
      validRow(['Bad zone finding', 'A short description that clears sixteen characters.', 'note', 'Mara Chen', 'Phantom Wing', 'AF-1908-014']),
      validRow(['Bad object finding', 'A short description that clears sixteen characters.', 'note', 'Mara Chen', 'Afterlives', 'AF-9999-999']),
    ].join('\n');
    const plan = buildFindingImportPlan(csv, state());
    expect(plan.createCount).toBe(0);
    expect(plan.failCount).toBe(2);
    expect(plan.rows[0].errors.join(' ')).toMatch(/No zone named "Phantom Wing"/);
    expect(plan.rows[0].errors.join(' ')).toMatch(/Known zones/i);
    expect(plan.rows[1].errors.join(' ')).toMatch(/No object with accession ID "AF-9999-999"/);
  });

  it('rejects illegal severity and missing required fields as failed rows', () => {
    const csv = [
      HEADER,
      validRow(['', 'A short description that clears sixteen characters.', 'huge', '']),
    ].join('\n');
    const plan = buildFindingImportPlan(csv, state());
    expect(plan.rows[0].status).toBe('error');
    expect(plan.rows[0].errors).toEqual(
      expect.arrayContaining([
        'Finding title is required.',
        'Owner is required.',
        'Severity "huge" is not recognised. Use note, warning, or critical.',
      ]),
    );
  });

  it('requires the description boundary used by the single-finding command', () => {
    const csv = [HEADER, validRow(['Short context', 'Too short', 'note', 'Mara Chen', '', ''])].join('\n');
    const plan = buildFindingImportPlan(csv, state());
    expect(plan.rows[0].status).toBe('error');
    expect(plan.rows[0].errors[0]).toMatch(/at least 16 characters/);
  });

  it('ignores duplicates of existing desk findings and earlier rows with the same title and links', () => {
    // Seed issue "Reduce entry panel copy" is linked to zone-arrival with no object.
    const seedDuplicate = validRow([
      'Reduce entry panel copy',
      'A short description that clears sixteen characters.',
      'warning',
      'Theo James',
      'Arrival / A Light Carried',
      '',
    ]);
    const newRow = validRow([
      'Tighten closing text',
      'A short description that clears sixteen characters.',
      'note',
      'Rina Solberg',
      'Afterlives',
      'AF-1987-064',
    ]);
    const sameTitleDifferentLink = validRow([
      'Tighten closing text',
      'A short description that clears sixteen characters.',
      'note',
      'Rina Solberg',
      '',
      '',
    ]);
    const repeated = newRow;
    const csv = [HEADER, seedDuplicate, newRow, sameTitleDifferentLink, repeated].join('\n');
    const plan = buildFindingImportPlan(csv, state());

    expect(plan.createCount).toBe(2);
    expect(plan.ignoreCount).toBe(2);
    expect(plan.failCount).toBe(0);
    expect(plan.rows[0].status).toBe('ignore');
    expect(plan.rows[0].duplicateReason).toMatch(/existing finding "Reduce entry panel copy"/);
    // Same title but different links is a distinct finding.
    expect(plan.rows[2].status).toBe('create');
    // Exact repeat of an earlier file row is ignored.
    expect(plan.rows[3].status).toBe('ignore');
    expect(plan.rows[3].duplicateReason).toMatch(/earlier row/);
  });

  it('refuses files missing required columns', () => {
    const plan = buildFindingImportPlan('Title,Owner\nA,Mara', state());
    expect(plan.ok).toBe(false);
    expect(plan.errors[0]).toMatch(/missing required columns/);
    expect(plan.errors[0]).toMatch(/Description/);
    expect(plan.errors[0]).toMatch(/Severity/);
  });

  it('accepts Chinese and spaced header spellings', () => {
    const csv = [
      '标题,说明,严重级别,负责人,展区名称,对象登录号',
      validRow(),
    ].join('\n');
    const plan = buildFindingImportPlan(csv, state());
    expect(plan.ok).toBe(true);
    expect(plan.createCount).toBe(1);
  });

  it('ships a template with the documented columns', () => {
    const csv = findingImportTemplateCsv();
    const plan = buildFindingImportPlan(csv, state());
    expect(plan.ok).toBe(true);
    expect(plan.createCount).toBe(2);
    expect(plan.failCount).toBe(0);
  });
});

describe('commitFindingImport', () => {
  const draftsFrom = (plan: ReturnType<typeof buildFindingImportPlan>): FindingImportDraft[] =>
    plan.rows
      .filter((row) => row.status === 'create' && row.severity)
      .map((row) => ({
        title: row.title,
        description: row.description,
        severity: row.severity as NonNullable<typeof row.severity>,
        owner: row.owner,
        zoneId: row.zoneId,
        artifactId: row.artifactId,
      }));

  it('creates every draft as an open finding owned by the CSV owner at one timestamp', () => {
    const workspace = state();
    const plan = buildFindingImportPlan(`${HEADER}\n${validRow()}`, workspace);
    const result = commitFindingImport(draftsFrom(plan), workspace, new Date('2026-09-10T12:00:00Z'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [issue] = result.value.issues;
    expect(issue.status).toBe('open');
    expect(issue.owner).toBe('Mara Chen');
    expect(issue.zoneId).toBe('zone-arrival');
    expect(issue.artifactId).toBe('artifact-lantern');
    expect(issue.createdAt).toBe('2026-09-10T12:00:00.000Z');
    expect(issue.updatedAt).toBe(issue.createdAt);
  });

  it('rejects the entire batch (atomic, no half records) when a reference has gone stale', () => {
    const workspace = state();
    const plan = buildFindingImportPlan(`${HEADER}\n${validRow()}`, workspace);
    const drafts = draftsFrom(plan).map((draft) => ({ ...draft, artifactId: 'artifact-deleted' }));
    const result = commitFindingImport(drafts, workspace);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected commit to fail');
    expect(result.message).toMatch(/linked object no longer exists/);
    expect(workspace.issues).toHaveLength(3);
  });

  it('rejects a batch that became a duplicate of a finding added after preview', () => {
    const workspace = state();
    const plan = buildFindingImportPlan(`${HEADER}\n${validRow()}`, workspace);
    const drafts = draftsFrom(plan);
    const withCompetingIssue: WorkspaceState = {
      ...workspace,
      issues: [
        ...workspace.issues,
        {
          ...workspace.issues[0],
          id: 'issue-competing',
          title: drafts[0].title,
          zoneId: drafts[0].zoneId,
          artifactId: drafts[0].artifactId,
        },
      ],
    };
    const result = commitFindingImport(drafts, withCompetingIssue);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected commit to fail');
    expect(result.message).toMatch(/same title and links/);
  });

  it('refuses an empty batch', () => {
    const result = commitFindingImport([], state());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected empty commit to fail');
    expect(result.message).toMatch(/no valid rows/);
  });
});
