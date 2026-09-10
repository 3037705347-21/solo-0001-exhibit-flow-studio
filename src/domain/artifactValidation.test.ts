import { describe, expect, it } from 'vitest';
import { artifactFromDraft, emptyArtifactDraft, validateArtifactDraft } from './artifactValidation';

describe('artifact validation', () => {
  it('rejects duplicate accession ids and weak summaries', () => {
    const existing = artifactFromDraft({
      ...emptyArtifactDraft,
      accessionId: 'af-1',
      title: 'Existing',
      maker: 'Maker',
      medium: 'Metal',
      summary: 'A sufficiently descriptive existing object summary.',
      width: '1',
      height: '1',
      depth: '1',
      dwellMinutes: '2',
    });
    const errors = validateArtifactDraft(
      {
        ...emptyArtifactDraft,
        accessionId: ' AF-1 ',
        title: 'New',
        maker: 'Maker',
        medium: 'Metal',
        summary: 'Too short',
        width: '1',
        height: '1',
        depth: '1',
        dwellMinutes: '2',
      },
      [existing],
    );
    expect(errors.map((error) => error.field)).toEqual(
      expect.arrayContaining(['accessionId', 'summary']),
    );
  });
  it('normalizes ids when creating an artifact', () => {
    const artifact = artifactFromDraft({
      ...emptyArtifactDraft,
      accessionId: 'af 2027 001',
      title: 'A title',
      maker: 'Maker',
      medium: 'Paper',
      summary: 'A sufficiently descriptive summary for this object.',
      width: '10',
      height: '20',
      depth: '2',
      dwellMinutes: '3',
    });
    expect(artifact.accessionId).toBe('AF-2027-001');
  });
});
