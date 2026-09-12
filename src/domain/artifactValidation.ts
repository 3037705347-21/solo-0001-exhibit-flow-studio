import type { Artifact, ArtifactDraft, ValidationError } from './models';
import { createId, normalizeAccessionId } from './ids';

const REQUIRED_TEXT_FIELDS: Array<keyof Pick<ArtifactDraft, 'accessionId' | 'title' | 'maker' | 'medium' | 'summary'>> = [
  'accessionId',
  'title',
  'maker',
  'medium',
  'summary',
];

function parsePositiveNumber(value: string, field: string, label: string): ValidationError | undefined {
  const parsed = Number(value);
  if (!value.trim()) return { field, message: `${label} is required.` };
  if (!Number.isFinite(parsed) || parsed <= 0) return { field, message: `${label} must be greater than zero.` };
  if (parsed > 10000) return { field, message: `${label} is outside the supported range.` };
  return undefined;
}

export function validateArtifactDraft(draft: ArtifactDraft, artifacts: Artifact[], editingId?: string): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (!draft[field].trim()) {
      errors.push({ field, message: `${field === 'accessionId' ? 'Accession ID' : field[0].toUpperCase() + field.slice(1)} is required.` });
    }
  }

  if (draft.title.trim().length > 90) errors.push({ field: 'title', message: 'Title must be 90 characters or fewer.' });
  if (draft.summary.trim().length < 24) errors.push({ field: 'summary', message: 'Summary must contain at least 24 characters.' });
  if (draft.summary.trim().length > 500) errors.push({ field: 'summary', message: 'Summary must be 500 characters or fewer.' });

  const normalized = normalizeAccessionId(draft.accessionId);
  if (artifacts.some((artifact) => artifact.id !== editingId && normalizeAccessionId(artifact.accessionId) === normalized)) {
    errors.push({ field: 'accessionId', message: 'This accession ID is already in the collection.' });
  }

  const numericChecks = [
    parsePositiveNumber(draft.width, 'width', 'Width'),
    parsePositiveNumber(draft.height, 'height', 'Height'),
    parsePositiveNumber(draft.depth, 'depth', 'Depth'),
    parsePositiveNumber(draft.dwellMinutes, 'dwellMinutes', 'Dwell time'),
  ];
  errors.push(...numericChecks.filter((error): error is ValidationError => Boolean(error)));

  if (Number(draft.dwellMinutes) > 30) {
    errors.push({ field: 'dwellMinutes', message: 'Dwell time must be 30 minutes or fewer.' });
  }

  return errors;
}

export function artifactFromDraft(draft: ArtifactDraft, existing?: Artifact, at = new Date()): Artifact {
  const now = at.toISOString();
  return {
    id: existing?.id ?? createId('artifact'),
    accessionId: normalizeAccessionId(draft.accessionId),
    title: draft.title.trim(),
    maker: draft.maker.trim(),
    yearLabel: draft.yearLabel.trim() || 'Date unknown',
    medium: draft.medium.trim(),
    origin: draft.origin.trim() || 'Origin unknown',
    summary: draft.summary.trim(),
    dimensions: {
      width: Number(draft.width),
      height: Number(draft.height),
      depth: Number(draft.depth),
      unit: 'cm',
    },
    dwellMinutes: Number(draft.dwellMinutes),
    narrativeRole: draft.narrativeRole,
    sensitivity: draft.sensitivity,
    accessibilityNeed: draft.accessibilityNeed,
    isKeyObject: draft.isKeyObject,
    tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
    color: draft.color,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    revision: (existing?.revision ?? 0) + 1,
  };
}

export function artifactToDraft(artifact: Artifact): ArtifactDraft {
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
    dwellMinutes: String(artifact.dwellMinutes),
    narrativeRole: artifact.narrativeRole,
    sensitivity: artifact.sensitivity,
    accessibilityNeed: artifact.accessibilityNeed,
    isKeyObject: artifact.isKeyObject,
    tags: artifact.tags.join(', '),
    color: artifact.color,
  };
}

export const emptyArtifactDraft: ArtifactDraft = {
  accessionId: '',
  title: '',
  maker: '',
  yearLabel: '',
  medium: '',
  origin: '',
  summary: '',
  width: '',
  height: '',
  depth: '',
  dwellMinutes: '3',
  narrativeRole: 'context',
  sensitivity: 'standard',
  accessibilityNeed: 'none',
  isKeyObject: false,
  tags: '',
  color: '#c9563f',
};
