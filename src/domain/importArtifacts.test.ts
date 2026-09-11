import { describe, expect, it } from 'vitest';
import { planImport, parseImportFile } from './importArtifacts';
import type { ImportBatch } from './models';

const FILE = JSON.stringify({
  kind: 'artifact-import',
  artifacts: [
    {
      accessionId: 'AF-2027-100',
      title: 'Weaving Sample Card',
      maker: 'North Studio',
      medium: 'Wool and paper',
      summary: 'A reference card recording thread colors and weave structures.',
      width: 20, height: 30, depth: 1, dwellMinutes: 4,
      narrativeRole: 'context',
      tags: ['textile'],
    },
    {
      accessionId: 'AF-2027-101',
      title: 'Gallery Sign Prototype',
      maker: 'Wayfinding Team',
      medium: 'Acrylic and vinyl',
      summary: 'A full-scale prototype sign tested for reading distance and glare.',
      width: 40, height: 25, depth: 2, dwellMinutes: 2,
      narrativeRole: 'threshold',
      isKeyObject: true,
    },
  ],
}, null, 2);

describe('artifact import', () => {
  it('parses a well-formed import file and rejects others', () => {
    expect(parseImportFile(FILE)?.artifacts).toHaveLength(2);
    expect(parseImportFile('{"artifacts": []}')).toBeNull();
    expect(parseImportFile('not json')).toBeNull();
    expect(parseImportFile('{"items": []}')).toBeNull();
  });

  it('creates new artifacts on first import', () => {
    const plan = planImport(parseImportFile(FILE) as NonNullable<ReturnType<typeof parseImportFile>>, 'batch-a.json', FILE, []);
    expect(plan.creates).toHaveLength(2);
    expect(plan.updates).toHaveLength(0);
    expect(plan.batch.id).toMatch(/^batch-/);
    expect(plan.batch.artifactIds).toHaveLength(2);
  });

  it('is idempotent: re-importing the identical file creates no records or relationships', () => {
    const parsed = parseImportFile(FILE) as NonNullable<ReturnType<typeof parseImportFile>>;
    const first = planImport(parsed, 'batch-a.json', FILE, []);
    const priorBatch: ImportBatch = first.batch;
    const existing = first.creates;
    const second = planImport(parsed, 'batch-a.json', FILE, existing, { previousBatch: priorBatch });
    expect(second.creates).toHaveLength(0);
    expect(second.updates).toHaveLength(0);
    expect(second.skipped.every((row) => row.reason === 'Already imported from this file')).toBe(true);
    // Same deterministic batch id — the graph links to one batch node.
    expect(second.batch.id).toBe(first.batch.id);
  });

  it('merges by normalized accession id when an object already exists outside the batch', () => {
    const parsed = parseImportFile(FILE) as NonNullable<ReturnType<typeof parseImportFile>>;
    const [firstRow] = parsed.artifacts;
    const preExisting = planImport(
      { artifacts: [firstRow] },
      'batch-a.json',
      JSON.stringify({ artifacts: [firstRow] }),
      [],
    ).creates;
    const plan = planImport(parsed, 'batch-a.json', FILE, preExisting);
    expect(plan.creates).toHaveLength(1);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].artifact.id).toBe(preExisting[0].id);
  });

  it('skips invalid rows with reasons', () => {
    const invalidRows = {
      artifacts: [
        { accessionId: 'AF-X', title: 'Missing fields', medium: '', summary: 'short' },
        { accessionId: 'AF-2027-200', title: 'Bad Dwell', medium: 'Stone', summary: 'Enough summary text to pass length checks.', width: 10, height: 10, depth: 10, dwellMinutes: 200 },
      ],
    };
    const raw = JSON.stringify(invalidRows);
    const parsed = parseImportFile(raw) as NonNullable<ReturnType<typeof parseImportFile>>;
    const plan = planImport(parsed, 'bad.json', raw, []);
    expect(plan.creates).toHaveLength(0);
    expect(plan.skipped).toHaveLength(2);
  });
});
