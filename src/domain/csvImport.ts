import { artifactFromDraft, validateArtifactDraft } from './artifactValidation';
import { normalizeAccessionId } from './ids';
import type { AccessibilityNeed, Artifact, ArtifactDraft, NarrativeRole, Sensitivity } from './models';
import type { CsvTable } from './csv';
import { emptyArtifactDraft } from './artifactValidation';

export type CsvRowStatus = 'new' | 'update' | 'conflict' | 'error';

export interface CsvImportIssue {
  /** Canoninal draft field key, or '_row' for record-level problems. */
  field: string;
  message: string;
}

export interface CsvImportRow {
  /** 1-based position among data rows in the file. */
  rowNumber: number;
  /** 1-based physical source line where the record begins. */
  line: number;
  status: CsvRowStatus;
  accessionId: string;
  title: string;
  /** Matched existing artifact id, for update/conflict rows. */
  existingId?: string;
  /** Rows this normalized accession id also appears on (after the first). */
  duplicateOfRow?: number;
  /** Parsed draft, available once the row contains enough data. */
  draft?: ArtifactDraft;
  issues: CsvImportIssue[];
}

export interface CsvImportCounts {
  total: number;
  new: number;
  update: number;
  conflict: number;
  error: number;
}

export interface CsvImportAnalysis {
  rows: CsvImportRow[];
  /** Blocking problems with the file structure or header. */
  fileErrors: string[];
  /** Header labels present in the file that map to no artifact field. */
  ignoredColumns: string[];
  blankRows: number;
  allowUpdates: boolean;
  counts: CsvImportCounts;
}

type MappableKey = Exclude<keyof ArtifactDraft, 'isKeyObject'>;

interface ColumnSpec {
  key: keyof ArtifactDraft;
  aliases: string[];
  label: string;
  required: boolean;
}

const COLUMN_SPECS: ColumnSpec[] = [
  { key: 'accessionId', label: 'Accession ID', aliases: ['accession id', 'accession', 'id', 'accession number', 'accession no'], required: true },
  { key: 'title', label: 'Title', aliases: ['title', 'object title', 'name', 'object name'], required: true },
  { key: 'maker', label: 'Maker / source', aliases: ['maker', 'maker / source', 'artist', 'creator', 'source'], required: true },
  { key: 'yearLabel', label: 'Date / period', aliases: ['year', 'date', 'period', 'year label', 'date / period', 'date or period'], required: false },
  { key: 'medium', label: 'Medium', aliases: ['medium', 'materials', 'material'], required: true },
  { key: 'origin', label: 'Origin', aliases: ['origin', 'place of origin', 'place', 'provenance'], required: false },
  { key: 'summary', label: 'Summary', aliases: ['summary', 'description', 'narrative', 'object summary'], required: true },
  { key: 'width', label: 'Width', aliases: ['width', 'width cm', 'w'], required: true },
  { key: 'height', label: 'Height', aliases: ['height', 'height cm', 'h'], required: true },
  { key: 'depth', label: 'Depth', aliases: ['depth', 'depth cm', 'd'], required: true },
  { key: 'dwellMinutes', label: 'Dwell minutes', aliases: ['dwell minutes', 'dwell time', 'dwell', 'dwell time minutes', 'dwell time min'], required: true },
  { key: 'narrativeRole', label: 'Narrative role', aliases: ['narrative role', 'role', 'story role'], required: false },
  { key: 'sensitivity', label: 'Sensitivity', aliases: ['sensitivity', 'sensitivity level'], required: false },
  { key: 'accessibilityNeed', label: 'Accessibility need', aliases: ['accessibility need', 'accessibility', 'access need'], required: false },
  { key: 'isKeyObject', label: 'Key object', aliases: ['key object', 'key', 'is key object', 'key object?'], required: false },
  { key: 'tags', label: 'Tags', aliases: ['tags', 'keywords', 'tag'], required: false },
  { key: 'color', label: 'Color', aliases: ['color', 'colour', 'hex', 'hex color'], required: false },
];

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const ROLE_ALIASES: Record<string, NarrativeRole> = {
  threshold: 'threshold',
  context: 'context',
  turningpoint: 'turning-point',
  turning: 'turning-point',
  reflection: 'reflection',
};

const SENSITIVITY_ALIASES: Record<string, Sensitivity> = {
  standard: 'standard',
  normal: 'standard',
  lowlight: 'low-light',
  low: 'low-light',
  fragile: 'fragile',
};

const ACCESSIBILITY_ALIASES: Record<string, AccessibilityNeed> = {
  none: 'none',
  '': 'none',
  seating: 'seating',
  seated: 'seating',
  audio: 'audio',
  tactile: 'tactile-alternative',
  tactilealternative: 'tactile-alternative',
};

export const CSV_TEMPLATE_HEADERS = [
  'Accession ID',
  'Title',
  'Maker / source',
  'Date / period',
  'Medium',
  'Origin',
  'Summary',
  'Width',
  'Height',
  'Depth',
  'Dwell minutes',
  'Narrative role',
  'Sensitivity',
  'Accessibility need',
  'Key object',
  'Tags',
  'Color',
];

export function buildCsvTemplate(): string {
  return `${CSV_TEMPLATE_HEADERS.join(',')}\n`;
}

interface HeaderMapping {
  fileErrors: string[];
  ignoredColumns: string[];
}

function mapHeaders(headers: string[]): HeaderMapping {
  const fileErrors: string[] = [];
  const ignoredColumns: string[] = [];
  const seenKeys = new Map<keyof ArtifactDraft, string>();

  headers.forEach((header) => {
    const normalized = normalizeHeader(header);
    const spec = COLUMN_SPECS.find((candidate) =>
      candidate.aliases.some((alias) => normalizeHeader(alias) === normalized),
    );
    if (!spec) {
      if (normalized) ignoredColumns.push(header.trim());
      return;
    }
    const previous = seenKeys.get(spec.key);
    if (previous) {
      fileErrors.push(`Column “${header.trim()}” duplicates the “${previous}” column.`);
      return;
    }
    seenKeys.set(spec.key, header.trim());
  });

  for (const spec of COLUMN_SPECS) {
    if (spec.required && !seenKeys.has(spec.key)) {
      fileErrors.push(`Required column “${spec.label}” is missing.`);
    }
  }
  return { fileErrors, ignoredColumns };
}

function parseEnum<T extends string>(value: string, aliases: Record<string, T>, label: string, fallback: T): { value: T; error?: string } {
  const key = value.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!key) return { value: fallback };
  const mapped = aliases[key];
  if (!mapped) return { value: fallback, error: `${label} must be one of: ${[...new Set(Object.values(aliases))].join(', ')}.` };
  return { value: mapped };
}

function parseBoolean(value: string): { value: boolean; error?: string } {
  const key = value.trim().toLowerCase();
  if (['', 'no', 'false', '0', 'n'].includes(key)) return { value: false };
  if (['yes', 'true', '1', 'y'].includes(key)) return { value: true };
  return { value: false, error: 'Key object must be “yes” or “no”.' };
}

function parseColor(value: string): { value: string; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { value: emptyArtifactDraft.color };
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) return { value: emptyArtifactDraft.color, error: 'Color must be a hex code such as #2f7c75.' };
  let hex = match[1];
  if (hex.length === 3) hex = hex.split('').map((char) => char + char).join('');
  return { value: `#${hex.toLowerCase()}` };
}

function isRecordEmpty(cells: string[]): boolean {
  return cells.every((cell) => cell.trim() === '');
}

/**
 * Analyze a parsed CSV table against the current collection. Each row is
 * classified as new, a safe update, a conflict with an existing accession id,
 * or an error. Classification is pure; nothing is written.
 */
export function analyzeCsvImport(table: CsvTable, artifacts: Artifact[], allowUpdates: boolean): CsvImportAnalysis {
  const mapping = mapHeaders(table.headers);
  const fileErrors = [...table.errors.map((error) => error.message), ...mapping.fileErrors];

  const rows: CsvImportRow[] = [];
  const firstRowByAccession = new Map<string, number>();
  const existingByAccession = new Map(
    artifacts.map((artifact) => [normalizeAccessionId(artifact.accessionId), artifact]),
  );

  let blankRows = table.blankRows;

  table.rows.forEach((record) => {
    if (isRecordEmpty(record.cells)) {
      blankRows += 1;
      return;
    }
    const rowNumber = rows.length + 1;
    const issues: CsvImportIssue[] = [];

    if (mapping.fileErrors.some((message) => message.startsWith('Required column'))) {
      rows.push({
        rowNumber,
        line: record.line,
        status: 'error',
        accessionId: '',
        title: '',
        issues: [{ field: '_row', message: 'Row cannot be read until the header columns are fixed.' }],
      });
      return;
    }

    if (record.cells.length !== table.headers.length) {
      issues.push({
        field: '_row',
        message: `Row has ${record.cells.length} columns; the header defines ${table.headers.length}.`,
      });
    }

    const draft: ArtifactDraft = { ...emptyArtifactDraft, tags: '' };

    // Position cells by header order; extra or missing cells stay undefined.
    const cellByKey = new Map<keyof ArtifactDraft, string>();
    table.headers.forEach((header, columnIndex) => {
      const normalized = normalizeHeader(header);
      const spec = COLUMN_SPECS.find((candidate) =>
        candidate.aliases.some((alias) => normalizeHeader(alias) === normalized),
      );
      if (spec && !cellByKey.has(spec.key)) {
        cellByKey.set(spec.key, (record.cells[columnIndex] ?? '').trim());
      }
    });

    const stringKeys: MappableKey[] = ['accessionId', 'title', 'maker', 'yearLabel', 'medium', 'origin', 'summary', 'width', 'height', 'depth', 'dwellMinutes', 'narrativeRole', 'sensitivity', 'accessibilityNeed', 'tags', 'color'];
    for (const key of stringKeys) {
      const cell = cellByKey.get(key);
      if (cell !== undefined) {
        (draft[key] as string) = cell;
      }
    }
    draft.tags = (cellByKey.get('tags') ?? '').replace(/;/g, ',');

    const role = parseEnum(cellByKey.get('narrativeRole') ?? '', ROLE_ALIASES, 'Narrative role', emptyArtifactDraft.narrativeRole);
    if (role.error) issues.push({ field: 'narrativeRole', message: role.error });
    draft.narrativeRole = role.value;

    const sensitivity = parseEnum(cellByKey.get('sensitivity') ?? '', SENSITIVITY_ALIASES, 'Sensitivity', emptyArtifactDraft.sensitivity);
    if (sensitivity.error) issues.push({ field: 'sensitivity', message: sensitivity.error });
    draft.sensitivity = sensitivity.value;

    const accessibility = parseEnum(cellByKey.get('accessibilityNeed') ?? '', ACCESSIBILITY_ALIASES, 'Accessibility need', emptyArtifactDraft.accessibilityNeed);
    if (accessibility.error) issues.push({ field: 'accessibilityNeed', message: accessibility.error });
    draft.accessibilityNeed = accessibility.value;

    const keyObject = parseBoolean(cellByKey.get('isKeyObject') ?? '');
    if (keyObject.error) issues.push({ field: 'isKeyObject', message: keyObject.error });
    draft.isKeyObject = keyObject.value;

    const color = parseColor(cellByKey.get('color') ?? '');
    if (color.error) issues.push({ field: 'color', message: color.error });
    draft.color = color.value;

    // Base field rules without any collection (duplicate ids are classified below).
    const fieldErrors = validateArtifactDraft(draft, []);
    for (const error of fieldErrors) issues.push({ field: error.field, message: error.message });

    const normalized = normalizeAccessionId(draft.accessionId);
    const earlierRow = normalized ? firstRowByAccession.get(normalized) : undefined;
    if (normalized && earlierRow !== undefined) {
      issues.push({ field: 'accessionId', message: `Duplicate accession ID in this file (also on row ${earlierRow}).` });
    } else if (normalized) {
      firstRowByAccession.set(normalized, rowNumber);
    }

    const existing = normalized ? existingByAccession.get(normalized) : undefined;
    let status: CsvRowStatus = 'new';
    if (issues.length > 0) {
      status = 'error';
    } else if (existing) {
      status = allowUpdates ? 'update' : 'conflict';
    }

    rows.push({
      rowNumber,
      line: record.line,
      status,
      accessionId: normalized || draft.accessionId.trim(),
      title: draft.title.trim(),
      existingId: existing?.id,
      duplicateOfRow: earlierRow,
      draft,
      issues,
    });
  });

  const counts: CsvImportCounts = { total: rows.length, new: 0, update: 0, conflict: 0, error: 0 };
  for (const row of rows) counts[row.status] += 1;

  return { rows, fileErrors, ignoredColumns: mapping.ignoredColumns, blankRows, allowUpdates, counts };
}

/**
 * Build the artifacts to commit from an analysis. Returns null unless every
 * row is a valid new record, an explicitly permitted safe update, or a
 * conflicting row the user explicitly chose to skip — so a caller can never
 * write a partial batch silently.
 */
export function buildImportPlan(
  analysis: CsvImportAnalysis,
  artifacts: Artifact[],
  options: { skipConflicts?: boolean } = {},
): Artifact[] | null {
  if (analysis.fileErrors.length > 0) return null;
  if (analysis.counts.error > 0) return null;
  if (analysis.counts.conflict > 0 && !options.skipConflicts) return null;

  const existingById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const planned: Artifact[] = [];
  for (const row of analysis.rows) {
    if (row.status === 'new' && row.draft) {
      const normalized = normalizeAccessionId(row.draft.accessionId);
      if (artifacts.some((artifact) => normalizeAccessionId(artifact.accessionId) === normalized)) return null;
      planned.push(artifactFromDraft(row.draft));
    } else if (row.status === 'update' && row.draft && row.existingId) {
      const existing = existingById.get(row.existingId);
      if (!existing) return null;
      planned.push(artifactFromDraft(row.draft, existing));
    } else if (row.status === 'conflict' && options.skipConflicts) {
      continue;
    } else {
      return null;
    }
  }
  return planned;
}
