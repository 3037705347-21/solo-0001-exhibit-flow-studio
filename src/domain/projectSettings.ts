import { isIsoCalendarDate } from './dateMath';
import type { ExhibitProject, ProjectSettingsDraft, ValidationError } from './models';

export function projectToSettingsDraft(project: ExhibitProject): ProjectSettingsDraft {
  return {
    title: project.title ?? '',
    venue: project.venue ?? '',
    audience: project.audience ?? '',
    openingDate: project.openingDate ?? '',
  };
}

export function validateProjectSettings(draft: ProjectSettingsDraft): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!draft.title.trim()) {
    errors.push({ field: 'title', message: 'An exhibition title is required.' });
  } else if (draft.title.trim().length > 120) {
    errors.push({ field: 'title', message: 'Title must be 120 characters or fewer.' });
  }
  if (draft.venue.trim().length > 160) {
    errors.push({ field: 'venue', message: 'Venue must be 160 characters or fewer.' });
  }
  if (draft.audience.trim().length > 200) {
    errors.push({ field: 'audience', message: 'Target audience must be 200 characters or fewer.' });
  }
  const openingDate = draft.openingDate.trim();
  if (openingDate && !isIsoCalendarDate(openingDate)) {
    errors.push({ field: 'openingDate', message: 'Opening date must use the YYYY-MM-DD format and be a real calendar date.' });
  }
  return errors;
}

/** Trimmed, null-safe project patch; the state command never reads anything outside these four fields. */
export function projectSettingsFromDraft(draft: ProjectSettingsDraft): Pick<ExhibitProject, 'title' | 'venue' | 'audience' | 'openingDate'> {
  return {
    title: draft.title.trim(),
    venue: draft.venue.trim(),
    audience: draft.audience.trim(),
    openingDate: draft.openingDate.trim(),
  };
}

const PROJECT_STAGES: ExhibitProject['stage'][] = ['draft', 'review', 'ready'];

/**
 * Repair project records from older workspaces without touching artifacts, zones,
 * issues, or planning preferences. Unknown values fall back to safe defaults.
 */
export function normalizeProject(project: ExhibitProject): ExhibitProject {
  const stage = PROJECT_STAGES.includes(project.stage) ? project.stage : 'draft';
  const openingDate = typeof project.openingDate === 'string' && isIsoCalendarDate(project.openingDate)
    ? project.openingDate
    : '';
  return {
    id: typeof project.id === 'string' && project.id ? project.id : 'project-untitled',
    title: typeof project.title === 'string' ? project.title : '',
    venue: typeof project.venue === 'string' ? project.venue : '',
    audience: typeof project.audience === 'string' ? project.audience : '',
    openingDate,
    stage,
    ...(typeof project.lastReadinessCheck === 'string' ? { lastReadinessCheck: project.lastReadinessCheck } : {}),
  };
}
