import { describe, expect, it } from 'vitest';
import { analyzeCsvImport, buildCsvTemplate, buildImportPlan } from './csvImport';
import { parseCsv } from './csv';
import { artifactFromDraft, emptyArtifactDraft } from './artifactValidation';
import type { ArtifactDraft } from './models';

const VALID: ArtifactDraft = {
  ...emptyArtifactDraft,
  accessionId: 'AF-2027-100',
  title: 'Imported Lantern',
  maker: 'Studio North',
  yearLabel: '2027',
  medium: 'Brass and glass',
  origin: 'York',
  summary: 'A sufficiently long descriptive summary for validation to pass on this record.',
  width: '12',
  height: '20',
  depth: '8',
  dwellMinutes: '4',
  tags: 'rail, light',
};

function tableFromCsv(csv: string) {
  return parseCsv(csv);
}

function headerRow(extra = '') {
  return [
    'Accession ID', 'Title', 'Maker / source', 'Date / period', 'Medium', 'Origin',
    'Summary', 'Width', 'Height', 'Depth', 'Dwell minutes', 'Narrative role',
    'Sensitivity', 'Accessibility need', 'Key object', 'Tags', 'Color',
  ].join(',') + extra;
}

function csvForDraft(draft: ArtifactDraft): string {
  const row = [
    draft.accessionId, draft.title, draft.maker, draft.yearLabel, draft.medium, draft.origin,
    draft.summary, draft.width, draft.height, draft.depth, draft.dwellMinutes,
    draft.narrativeRole, draft.sensitivity, draft.accessibilityNeed,
    draft.isKeyObject ? 'yes' : 'no', draft.tags, draft.color,
  ].map((cell) => (cell.includes(',') ? `"${cell}"` : cell)).join(',');
  return `${headerRow()}\n${row}\n`;
}

describe('analyzeCsvImport', () => {
  it('classifies a fully valid file as new rows', () => {
    const analysis = analyzeCsvImport(tableFromCsv(csvForDraft(VALID)), [], false);
    expect(analysis.fileErrors).toEqual([]);
    expect(analysis.rows).toHaveLength(1);
    expect(analysis.rows[0].status).toBe('new');
    expect(analysis.counts.new).toBe(1);
  });

  it('parses quoted commas, embedded newlines, semicolon tags, and enum synonyms', () => {
    const draft: ArtifactDraft = {
      ...VALID,
      accessionId: 'AF-2027-101',
      maker: 'Cooke, H. B. & Co.',
      summary: 'Quoted summary\nwith a newline and enough length to pass validation easily.',
      narrativeRole: 'turning-point',
      sensitivity: 'low-light',
      accessibilityNeed: 'seating',
      isKeyObject: true,
      tags: 'rail; light',
    };
    const row = [
      draft.accessionId, draft.title, `"${draft.maker}"`, draft.yearLabel, draft.medium, draft.origin,
      `"${draft.summary}"`, draft.width, draft.height, draft.depth, draft.dwellMinutes,
      'turning point', 'low light', 'seated', 'YES', draft.tags, draft.color,
    ].join(',');
    const analysis = analyzeCsvImport(tableFromCsv(`${headerRow()}\n${row}\n`), [], false);
    expect(analysis.rows[0].issues).toEqual([]);
    const built = buildImportPlan(analysis, []);
    expect(built?.[0]).toMatchObject({
      maker: 'Cooke, H. B. & Co.',
      narrativeRole: 'turning-point',
      sensitivity: 'low-light',
      accessibilityNeed: 'seating',
      isKeyObject: true,
      tags: ['rail', 'light'],
    });
    expect(built?.[0].summary).toContain('with a newline');
  });

  it('marks an existing accession id a conflict unless updates are allowed', () => {
    const existing = artifactFromDraft({ ...VALID, accessionId: 'af-2027-100' });
    const withoutFlag = analyzeCsvImport(tableFromCsv(csvForDraft({ ...VALID, title: 'Changed Title' })), [existing], false);
    expect(withoutFlag.rows[0].status).toBe('conflict');
    expect(buildImportPlan(withoutFlag, [existing])).toBeNull();

    const withFlag = analyzeCsvImport(tableFromCsv(csvForDraft({ ...VALID, title: 'Changed Title' })), [existing], true);
    expect(withFlag.rows[0].status).toBe('update');
    const plan = buildImportPlan(withFlag, [existing]);
    expect(plan).toHaveLength(1);
    expect(plan?.[0].id).toBe(existing.id);
    expect(plan?.[0].title).toBe('Changed Title');
    expect(plan?.[0].createdAt).toBe(existing.createdAt);
  });

  it('flags invalid numbers and short summaries as field errors that block the batch', () => {
    const bad = { ...VALID, width: '-5', dwellMinutes: '99', summary: 'Too short' };
    const analysis = analyzeCsvImport(tableFromCsv(csvForDraft(bad)), [], false);
    expect(analysis.rows[0].status).toBe('error');
    const fields = analysis.rows[0].issues.map((issue) => issue.field);
    expect(fields).toEqual(expect.arrayContaining(['width', 'dwellMinutes', 'summary']));
    expect(buildImportPlan(analysis, [])).toBeNull();
  });

  it('treats non-numeric dimensions and illegal enums as errors', () => {
    const row = [
      'AF-1', 'Title', 'Maker', '2027', 'Metal', 'York',
      'A sufficiently long descriptive summary for validation here.',
      'abc', '10', '10', '4', 'sidekick', 'ultra', 'braille', 'maybe', '', '',
    ].join(',');
    const analysis = analyzeCsvImport(tableFromCsv(`${headerRow()}\n${row}\n`), [], false);
    const fields = analysis.rows[0].issues.map((issue) => issue.field);
    expect(fields).toEqual(expect.arrayContaining(['width', 'narrativeRole', 'sensitivity', 'accessibilityNeed', 'isKeyObject']));
  });

  it('flags repeated accession ids inside the same file while keeping the first row valid', () => {
    const csv = `${headerRow()}\n${draftRow({ ...VALID })}\n${draftRow({ ...VALID, title: 'Second Copy', summary: 'Another sufficiently long summary for the duplicate record.' })}\n`;
    const analysis = analyzeCsvImport(tableFromCsv(csv), [], false);
    expect(analysis.rows[0].status).toBe('new');
    expect(analysis.rows[1].status).toBe('error');
    expect(analysis.rows[1].issues[0].field).toBe('accessionId');
    expect(buildImportPlan(analysis, [])).toBeNull();
  });

  it('reports missing and duplicated headers and ignores unknown columns', () => {
    const headers = 'Accession ID,Title,Maker,Medium,Summary,Width,Height,Depth,Title';
    const analysis = analyzeCsvImport(tableFromCsv(`${headers}\n`), [], false);
    expect(analysis.fileErrors.join(' ')).toMatch(/[Dd]well minutes/);
    expect(analysis.fileErrors.join(' ')).toMatch(/[Dd]uplicate/);

    const withExtra = analyzeCsvImport(tableFromCsv(`${headerRow(',Internal note')}\n`), [], false);
    expect(withExtra.ignoredColumns).toContain('Internal note');
    expect(withExtra.fileErrors).toEqual([]);
  });

  it('flags ragged rows with the wrong column count', () => {
    const csv = `${headerRow()}\n${draftRow(VALID).split(',').slice(0, -4).join(',')}\n`;
    const analysis = analyzeCsvImport(tableFromCsv(csv), [], false);
    expect(analysis.rows[0].issues.some((issue) => issue.field === '_row' && /columns/.test(issue.message))).toBe(true);
  });

  it('counts skipped blank lines and reports zero data rows', () => {
    const analysis = analyzeCsvImport(tableFromCsv(`${headerRow()}\n\n   \n`), [], false);
    expect(analysis.blankRows).toBe(2);
    expect(analysis.rows).toHaveLength(0);
  });

  it('exposes a header-only template', () => {
    const template = parseCsv(buildCsvTemplate());
    expect(template.headers).toContain('Accession ID');
    expect(template.rows).toEqual([]);
  });
});

describe('buildImportPlan atomicity', () => {
  it('appends new artifacts after existing ones, preserving order', () => {
    const existing = artifactFromDraft({ ...VALID, accessionId: 'AF-EXISTING-1', title: 'Existing' });
    const incoming = { ...VALID, accessionId: 'AF-NEW-1' };
    const analysis = analyzeCsvImport(tableFromCsv(csvForDraft(incoming)), [existing], false);
    const plan = buildImportPlan(analysis, [existing]);
    expect(plan).toHaveLength(1);
    expect(plan?.[0].accessionId).toBe('AF-NEW-1');
  });

  it('refuses to build a plan that would overwrite without permission even if state changed after preview', () => {
    const incoming = { ...VALID, accessionId: 'AF-NEW-1' };
    const analysis = analyzeCsvImport(tableFromCsv(csvForDraft(incoming)), [], false);
    // Meanwhile another artifact with the same normalized id exists.
    const latecomer = artifactFromDraft({ ...VALID, accessionId: 'af new 1', title: 'Latecomer' });
    expect(buildImportPlan(analysis, [latecomer])).toBeNull();
  });

  it('writes nothing for conflicts by default, but skips them when explicitly requested', () => {
    const existing = artifactFromDraft({ ...VALID, accessionId: 'AF-2027-100' });
    const csv = [
      headerRow(),
      draftRow({ ...VALID }),
      draftRow({ ...VALID, accessionId: 'AF-2027-102', title: 'Second Object', summary: 'A second sufficiently descriptive summary for this record.' }),
    ].join('\n');
    const analysis = analyzeCsvImport(tableFromCsv(csv), [existing], false);
    expect(analysis.counts).toMatchObject({ conflict: 1, new: 1 });
    expect(buildImportPlan(analysis, [existing])).toBeNull();
    const skippedPlan = buildImportPlan(analysis, [existing], { skipConflicts: true });
    expect(skippedPlan).toHaveLength(1);
    expect(skippedPlan?.[0].accessionId).toBe('AF-2027-102');
  });
});

function draftRow(draft: ArtifactDraft): string {
  return [
    draft.accessionId, draft.title, draft.maker, draft.yearLabel, draft.medium, draft.origin,
    draft.summary, draft.width, draft.height, draft.depth, draft.dwellMinutes,
    draft.narrativeRole, draft.sensitivity, draft.accessibilityNeed,
    draft.isKeyObject ? 'yes' : 'no', draft.tags, draft.color,
  ].map((cell) => (String(cell).includes(',') || String(cell).includes('\n') ? `"${String(cell).replace(/"/g, '""')}"` : cell)).join(',');
}
