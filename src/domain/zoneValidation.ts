import type { ValidationError, Zone, ZoneDraft } from './models';

export const ZONE_COLOR_OPTIONS = [
  '#d7654e',
  '#7c6aa6',
  '#2f7c75',
  '#597b8e',
  '#c7903d',
  '#a55f72',
  '#8c9474',
  '#496786',
];

export const emptyZoneDraft: ZoneDraft = {
  name: '',
  shortLabel: '',
  thesis: '',
  capacityMinutes: '15',
  maxObjects: '4',
  lowLight: false,
  hasSeating: false,
  color: ZONE_COLOR_OPTIONS[0],
};

export function zoneToDraft(zone: Zone): ZoneDraft {
  return {
    name: zone.name,
    shortLabel: zone.shortLabel,
    thesis: zone.thesis,
    capacityMinutes: String(zone.capacityMinutes),
    maxObjects: String(zone.maxObjects),
    lowLight: zone.lowLight,
    hasSeating: zone.hasSeating,
    color: zone.color,
  };
}

function parsePositiveInteger(value: string, field: string, label: string): ValidationError | undefined {
  if (!value.trim()) return { field, message: `${label} is required.` };
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return { field, message: `${label} must be a whole number greater than zero.` };
  }
  if (parsed > 1000) return { field, message: `${label} must be 1000 or fewer.` };
  return undefined;
}

export function validateZoneDraft(draft: ZoneDraft, zones: Zone[], editingId?: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!draft.name.trim()) {
    errors.push({ field: 'name', message: 'Zone name is required.' });
  } else if (draft.name.trim().length > 80) {
    errors.push({ field: 'name', message: 'Zone name must be 80 characters or fewer.' });
  } else if (
    zones.some((zone) => zone.id !== editingId && zone.name.trim().toLowerCase() === draft.name.trim().toLowerCase())
  ) {
    errors.push({ field: 'name', message: 'A zone with this name already exists.' });
  }

  if (draft.shortLabel.trim().length > 24) {
    errors.push({ field: 'shortLabel', message: 'Short label must be 24 characters or fewer.' });
  }

  if (draft.thesis.trim().length > 240) {
    errors.push({ field: 'thesis', message: 'Theme must be 240 characters or fewer.' });
  }

  const capacityError = parsePositiveInteger(draft.capacityMinutes, 'capacityMinutes', 'Dwell capacity');
  if (capacityError) errors.push(capacityError);

  const maxObjectsError = parsePositiveInteger(draft.maxObjects, 'maxObjects', 'Maximum object count');
  if (maxObjectsError) errors.push(maxObjectsError);

  if (!/^#[0-9a-fA-F]{6}$/.test(draft.color.trim())) {
    errors.push({ field: 'color', message: 'Choose a zone color.' });
  }

  return errors;
}
