import { createId, normalizeAccessionId } from './ids';
import type { IssueSeverity, ReviewIssue, WorkspaceState, Zone } from './models';

export type FindingImportStatus = 'create' | 'ignore' | 'error';

export interface FindingImportRow {
  /** 1-based line number in the source CSV (the header row is line 1). */
  lineNumber: number;
  title: string;
  description: string;
  owner: string;
  severity: IssueSeverity | null;
  rawZoneName: string;
  rawAccessionId: string;
  status: FindingImportStatus;
  /** Human-readable validation failures, one per problem. */
  errors: string[];
  /** Present when the row is ignored as a duplicate. */
  duplicateReason?: string;
  /** Resolved references, present once the row passes validation. */
  zoneId?: string;
  zoneName?: string;
  artifactId?: string;
  artifactTitle?: string;
  accessionId?: string;
}

export interface FindingImportPlan {
  /** False when the file itself cannot be parsed into validated rows. */
  ok: boolean;
  /** File-level problems (bad CSV syntax, missing required columns). */
  errors: string[];
  rows: FindingImportRow[];
  createCount: number;
  ignoreCount: number;
  failCount: number;
}

/** A validated row ready to be turned into a finding. */
export interface FindingImportDraft {
  title: string;
  description: string;
  severity: IssueSeverity;
  owner: string;
  zoneId?: string;
  artifactId?: string;
}

export interface ImportedFindings {
  issues: ReviewIssue[];
}

type CanonicalField = 'title' | 'description' | 'severity' | 'owner' | 'zoneName' | 'accessionId';

const REQUIRED_FIELDS: CanonicalField[] = ['title', 'description', 'severity', 'owner'];

const FIELD_LABELS: Record<CanonicalField, string> = {
  title: 'Title',
  description: 'Description',
  severity: 'Severity',
  owner: 'Owner',
  zoneName: 'Zone Name',
  accessionId: 'Accession ID',
};

/** Accepted header spellings after lower-casing and stripping punctuation/whitespace. */
const HEADER_ALIASES: Array<{ field: CanonicalField; aliases: string[] }> = [
  { field: 'title', aliases: ['title', 'findingtitle', '标题', '问题标题'] },
  { field: 'description', aliases: ['description', 'details', 'notes', '说明', '问题说明'] },
  { field: 'severity', aliases: ['severity', 'severitylevel', 'level', '严重级别', '严重程度', '级别'] },
  { field: 'owner', aliases: ['owner', 'assignee', '负责人', '责任人'] },
  { field: 'zoneName', aliases: ['zonename', 'zone', 'gallery', '展区名称', '展区'] },
  { field: 'accessionId', aliases: ['accessionid', 'accession', 'objectid', 'objectaccessionid', '对象登录号', '登录号'] },
];

const SEVERITY_ALIASES: Array<{ value: IssueSeverity; aliases: string[] }> = [
  { value: 'note', aliases: ['note', 'notes', 'info', 'minor', '提示', '建议'] },
  { value: 'warning', aliases: ['warning', 'warn', 'caution', 'medium', 'moderate', '警告', '注意'] },
  { value: 'critical', aliases: ['critical', 'blocker', 'blocking', 'severe', 'urgent', '严重', '关键'] },
];

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '');
}

function normalizeSeverityToken(value: string): string {
  return value.trim().toLowerCase();
}

function parseSeverity(value: string): IssueSeverity | null {
  const token = normalizeSeverityToken(value);
  const match = SEVERITY_ALIASES.find((entry) => entry.aliases.includes(token));
  return match ? match.value : null;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const FINDING_IMPORT_TEMPLATE_NAME = 'exhibit-flow-finding-import-template.csv';

export function findingImportTemplateCsv(): string {
  const rows = [
    ['Title', 'Description', 'Severity', 'Owner', 'Zone Name', 'Accession ID'],
    [
      'Reprint large-type entry label',
      'The 12pt label is unreadable for low-vision visitors; reprint at 18 pt and add a braille plate.',
      'warning',
      'Mara Chen',
      'Arrival / A Light Carried',
      'AF-1908-014',
    ],
    [
      'Queue backup at listening bench',
      'Weekend groups wait too long for the audio bench; add a second listening position.',
      'critical',
      'Theo James',
      'Afterlives',
      '',
    ],
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

interface CsvRow {
  lineNumber: number;
  cells: string[];
}

/**
 * Minimal RFC 4180 style CSV reader: quoted fields, doubled quotes, CRLF/LF, and
 * quoted fields spanning multiple lines are supported. Returns the first syntax
 * problem instead of guessing when the input is malformed.
 */
export function parseCsv(input: string): { rows: CsvRow[] } | { parseError: string } {
  const text = input.replace(/^\uFEFF/, '');
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let rowStartLine = 1;
  let line = 1;

  const pushField = () => { cells.push(field); field = ''; };
  const pushRow = () => { rows.push({ lineNumber: rowStartLine, cells }); cells = []; rowStartLine = line; };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; } else { inQuotes = false; }
      } else {
        field += char;
        if (char === '\n') line += 1;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushField();
      line += 1;
      pushRow();
    } else if (char === '\r') {
      if (text[index + 1] === '\n') index += 1;
      pushField();
      line += 1;
      pushRow();
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    return { parseError: 'The CSV ends inside a quoted field. Add the missing closing quote and try again.' };
  }

  // Flush the final record (a trailing newline only yields an empty record, which is dropped below).
  pushField();
  if (cells.length > 1 || cells[0] !== '') pushRow();

  const nonBlank = rows.filter((row) => row.cells.some((cell) => cell.trim() !== ''));
  return { rows: nonBlank };
}

interface HeaderMapping {
  columns: Array<{ field: CanonicalField; index: number }>;
  missing: CanonicalField[];
}

function mapHeader(headerCells: string[]): HeaderMapping {
  const columns: Array<{ field: CanonicalField; index: number }> = [];
  const claimed = new Set<CanonicalField>();
  headerCells.forEach((cell, index) => {
    const normalized = normalizeHeader(cell);
    const alias = HEADER_ALIASES.find((entry) => entry.aliases.includes(normalized));
    if (alias && !claimed.has(alias.field)) {
      columns.push({ field: alias.field, index });
      claimed.add(alias.field);
    }
  });
  const missing = REQUIRED_FIELDS.filter((field) => !claimed.has(field));
  return { columns, missing };
}

function readCell(cells: string[], index: number | undefined): string {
  return index === undefined ? '' : (cells[index] ?? '').trim();
}

function matchZone(zones: Zone[], rawName: string): Zone | undefined {
  const wanted = rawName.trim().replace(/\s+/g, ' ').toLowerCase();
  return zones.find((zone) => {
    const name = zone.name.trim().replace(/\s+/g, ' ').toLowerCase();
    const shortLabel = zone.shortLabel.trim().replace(/\s+/g, ' ').toLowerCase();
    return name === wanted || shortLabel === wanted;
  });
}

function duplicateKey(title: string, zoneId: string, artifactId: string): string {
  return `${title.trim().toLowerCase()}|${zoneId}|${artifactId}`;
}

/**
 * Parses the CSV and classifies every data row as a finding to create, a row to
 * ignore (duplicate), or a failed row with understandable errors. This function
 * never mutates workspace state; committing the plan is a separate step.
 */
export function buildFindingImportPlan(csvText: string, state: WorkspaceState): FindingImportPlan {
  const parsed = parseCsv(csvText);
  if ('parseError' in parsed) {
    return { ok: false, errors: [parsed.parseError], rows: [], createCount: 0, ignoreCount: 0, failCount: 0 };
  }
  if (parsed.rows.length === 0) {
    return { ok: false, errors: ['The CSV is empty. Add a header row and at least one finding row.'], rows: [], createCount: 0, ignoreCount: 0, failCount: 0 };
  }

  const { columns, missing } = mapHeader(parsed.rows[0].cells);
  if (missing.length > 0) {
    const labels = missing.map((field) => FIELD_LABELS[field]).join(', ');
    return {
      ok: false,
      errors: [`The CSV is missing required column${missing.length === 1 ? '' : 's'}: ${labels}.`],
      rows: [],
      createCount: 0,
      ignoreCount: 0,
      failCount: 0,
    };
  }

  const indexFor = (field: CanonicalField) => columns.find((column) => column.field === field)?.index;
  const titleIndex = indexFor('title');
  const descriptionIndex = indexFor('description');
  const severityIndex = indexFor('severity');
  const ownerIndex = indexFor('owner');
  const zoneIndex = indexFor('zoneName');
  const accessionIndex = indexFor('accessionId');

  const zoneNames = state.zones.map((zone) => zone.name).join(', ');
  const artifactByAccession = new Map(
    state.artifacts.map((artifact) => [normalizeAccessionId(artifact.accessionId), artifact]),
  );

  const seenKeys = new Set(
    state.issues.map((issue) => duplicateKey(issue.title, issue.zoneId ?? '', issue.artifactId ?? '')),
  );
  const existingTitleByKey = new Map(
    state.issues.map((issue) => [duplicateKey(issue.title, issue.zoneId ?? '', issue.artifactId ?? ''), issue.title]),
  );

  const rows: FindingImportRow[] = [];

  for (const record of parsed.rows.slice(1)) {
    const title = readCell(record.cells, titleIndex);
    const description = readCell(record.cells, descriptionIndex);
    const severityRaw = readCell(record.cells, severityIndex);
    const owner = readCell(record.cells, ownerIndex);
    const rawZoneName = readCell(record.cells, zoneIndex);
    const rawAccessionId = readCell(record.cells, accessionIndex);
    const errors: string[] = [];

    const row: FindingImportRow = {
      lineNumber: record.lineNumber,
      title,
      description,
      owner,
      severity: null,
      rawZoneName,
      rawAccessionId,
      status: 'error',
      errors,
    };

    if (!title) errors.push('Finding title is required.');
    else if (title.length > 90) errors.push('Title must be 90 characters or fewer.');
    if (!description) errors.push('Description is required.');
    else if (description.length < 16) errors.push('Description needs at least 16 characters of context.');
    else if (description.length > 1000) errors.push('Description must be 1000 characters or fewer.');
    if (!owner) errors.push('Owner is required.');
    else if (owner.length > 80) errors.push('Owner must be 80 characters or fewer.');

    let severity: IssueSeverity | null = null;
    if (!severityRaw) {
      errors.push('Severity is required. Use note, warning, or critical.');
    } else {
      severity = parseSeverity(severityRaw);
      if (!severity) errors.push(`Severity "${severityRaw}" is not recognised. Use note, warning, or critical.`);
      else row.severity = severity;
    }

    let zoneId: string | undefined;
    if (rawZoneName) {
      const zone = matchZone(state.zones, rawZoneName);
      if (!zone) {
        errors.push(`No zone named "${rawZoneName}" exists in this plan (known zones: ${zoneNames}). Check the spelling or leave the cell empty.`);
      } else {
        zoneId = zone.id;
        row.zoneId = zone.id;
        row.zoneName = zone.name;
      }
    }

    let artifactId: string | undefined;
    if (rawAccessionId) {
      const artifact = artifactByAccession.get(normalizeAccessionId(rawAccessionId));
      if (!artifact) {
        errors.push(`No object with accession ID "${normalizeAccessionId(rawAccessionId)}" exists in the collection. Check the ID or leave the cell empty.`);
      } else {
        artifactId = artifact.id;
        row.artifactId = artifact.id;
        row.artifactTitle = artifact.title;
        row.accessionId = artifact.accessionId;
      }
    }

    // Duplicate policy: a row that passes every other check is skipped (not failed)
    // when its title and zone/object links already exist on the desk or earlier in
    // this file. Invalid rows are never folded into the duplicate set.
    if (errors.length === 0 && severity) {
      const key = duplicateKey(title, zoneId ?? '', artifactId ?? '');
      if (seenKeys.has(key)) {
        const existingTitle = existingTitleByKey.get(key);
        row.status = 'ignore';
        row.duplicateReason = existingTitle
          ? `Duplicate of existing finding "${existingTitle}" already on the review desk.`
          : 'Duplicate of an earlier row in this file; only the first row will be created.';
      } else {
        seenKeys.add(key);
        row.status = 'create';
      }
    }

    rows.push(row);
  }

  return {
    ok: true,
    errors: [],
    rows,
    createCount: rows.filter((row) => row.status === 'create').length,
    ignoreCount: rows.filter((row) => row.status === 'ignore').length,
    failCount: rows.filter((row) => row.status === 'error').length,
  };
}

/**
 * State-boundary validation for a confirmed import. Re-checks every draft so a
 * stale preview (for example an object deleted while the dialog was open) can
 * never create partial records: the whole batch is rejected as a unit.
 */
export function commitFindingImport(
  drafts: FindingImportDraft[],
  state: WorkspaceState,
  at = new Date(),
): { ok: true; value: ImportedFindings } | { ok: false; message: string } {
  if (drafts.length === 0) return { ok: false, message: 'There are no valid rows to import.' };

  const zoneIds = new Set(state.zones.map((zone) => zone.id));
  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.id));
  const allowedSeverities = new Set<string>(SEVERITY_ALIASES.map((entry) => entry.value));
  const seenKeys = new Set(
    state.issues.map((issue) => duplicateKey(issue.title, issue.zoneId ?? '', issue.artifactId ?? '')),
  );

  const failures: string[] = [];
  drafts.forEach((draft, index) => {
    const rowLabel = `Row ${index + 2}`;
    if (!draft.title.trim()) failures.push(`${rowLabel}: a finding title is required.`);
    else if (draft.title.trim().length > 90) failures.push(`${rowLabel}: the title must be 90 characters or fewer.`);
    if (!draft.description.trim() || draft.description.trim().length < 16) {
      failures.push(`${rowLabel}: the description needs at least 16 characters of context.`);
    } else if (draft.description.trim().length > 1000) {
      failures.push(`${rowLabel}: the description must be 1000 characters or fewer.`);
    }
    if (!draft.owner.trim()) failures.push(`${rowLabel}: an owner is required.`);
    else if (draft.owner.trim().length > 80) failures.push(`${rowLabel}: the owner must be 80 characters or fewer.`);
    if (!allowedSeverities.has(draft.severity)) failures.push(`${rowLabel}: severity "${draft.severity}" is not recognised.`);
    if (draft.zoneId && !zoneIds.has(draft.zoneId)) failures.push(`${rowLabel}: the linked zone no longer exists.`);
    if (draft.artifactId && !artifactIds.has(draft.artifactId)) failures.push(`${rowLabel}: the linked object no longer exists.`);
    const key = duplicateKey(draft.title, draft.zoneId ?? '', draft.artifactId ?? '');
    if (seenKeys.has(key)) failures.push(`${rowLabel}: a finding with the same title and links already exists.`);
    seenKeys.add(key);
  });

  if (failures.length > 0) {
    return { ok: false, message: `Import was cancelled because ${failures.length} row${failures.length === 1 ? '' : 's'} no longer validate${failures.length === 1 ? 's' : ''}: ${failures.join(' ')}` };
  }

  const timestamp = at.toISOString();
  const issues: ReviewIssue[] = drafts.map((draft) => ({
    id: createId('issue'),
    title: draft.title.trim(),
    description: draft.description.trim(),
    severity: draft.severity,
    status: 'open',
    owner: draft.owner.trim(),
    zoneId: draft.zoneId || undefined,
    artifactId: draft.artifactId || undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));

  return { ok: true, value: { issues } };
}
