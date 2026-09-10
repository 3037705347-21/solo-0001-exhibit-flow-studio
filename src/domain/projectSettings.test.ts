import { describe, expect, it } from 'vitest';
import { isIsoCalendarDate } from './dateMath';
import { normalizeProject, projectSettingsFromDraft, projectToSettingsDraft, validateProjectSettings } from './projectSettings';
import type { ExhibitProject, ProjectSettingsDraft } from './models';

const validDraft: ProjectSettingsDraft = {
  title: 'Afterlight: Material Memory',
  venue: 'North Hall / Gallery 3',
  audience: 'General visitors, age 12+',
  openingDate: '2027-03-18',
};

describe('project settings validation', () => {
  it('accepts a complete valid draft', () => {
    expect(validateProjectSettings(validDraft)).toEqual([]);
  });

  it('accepts empty venue, audience, and opening date', () => {
    const draft: ProjectSettingsDraft = { title: 'Small Show', venue: '   ', audience: '', openingDate: '' };
    expect(validateProjectSettings(draft)).toEqual([]);
    expect(projectSettingsFromDraft(draft)).toEqual({ title: 'Small Show', venue: '', audience: '', openingDate: '' });
  });

  it('rejects a blank or whitespace-only title', () => {
    const errors = validateProjectSettings({ ...validDraft, title: '   ' });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('title');
  });

  it('rejects malformed and impossible opening dates while accepting the empty value', () => {
    for (const openingDate of ['18/03/2027', '2027-3-18', '2027-02-30', '2027-13-01', 'not-a-date', '2027-03']) {
      const errors = validateProjectSettings({ ...validDraft, openingDate });
      expect(errors.map((error) => error.field)).toContain('openingDate');
    }
    expect(validateProjectSettings({ ...validDraft, openingDate: '' })).toEqual([]);
  });

  it('round trips a project through the draft shape', () => {
    const project: ExhibitProject = {
      id: 'p1', title: 'Show', venue: 'Venue', audience: 'Adults', openingDate: '2030-01-02', stage: 'review',
    };
    expect(projectToSettingsDraft(project)).toEqual({ title: 'Show', venue: 'Venue', audience: 'Adults', openingDate: '2030-01-02' });
  });
});

describe('isIsoCalendarDate', () => {
  it('accepts real ISO dates including leap days', () => {
    expect(isIsoCalendarDate('2024-02-29')).toBe(true);
    expect(isIsoCalendarDate('2000-12-31')).toBe(true);
  });
  it('rejects leap days in non-leap years and malformed input', () => {
    expect(isIsoCalendarDate('2023-02-29')).toBe(false);
    expect(isIsoCalendarDate('')).toBe(false);
    expect(isIsoCalendarDate('2027/03/18')).toBe(false);
  });
});

describe('normalizeProject', () => {
  it('repairs legacy project fields without inventing values', () => {
    const legacy = {
      id: 'legacy',
      title: undefined as unknown as string,
      venue: 42 as unknown as string,
      audience: null as unknown as string,
      openingDate: '2027-02-30',
      stage: 'unknown' as ExhibitProject['stage'],
    };
    expect(normalizeProject(legacy)).toEqual({
      id: 'legacy', title: '', venue: '', audience: '', openingDate: '', stage: 'draft',
    });
  });

  it('keeps valid legacy values and preserves the readiness timestamp', () => {
    const project: ExhibitProject = {
      id: 'p', title: 'Old Show', venue: 'Wing A', audience: 'Families', openingDate: '2026-05-09', stage: 'ready', lastReadinessCheck: '2026-09-01T10:00:00.000Z',
    };
    expect(normalizeProject(project)).toEqual(project);
  });
});
