import { createId, normalizeAccessionId } from './ids';
import { hashImportFile } from './lineage';
import type { Artifact, Dimensions, ImportBatch, NarrativeRole, Sensitivity, AccessibilityNeed } from './models';

export interface ImportArtifactPayload {
  accessionId: string;
  title: string;
  maker?: string;
  yearLabel?: string;
  medium: string;
  origin?: string;
  summary: string;
  width: number;
  height: number;
  depth: number;
  dwellMinutes: number;
  narrativeRole: NarrativeRole;
  sensitivity?: Sensitivity;
  accessibilityNeed?: AccessibilityNeed;
  isKeyObject?: boolean;
  tags?: string[];
  color?: string;
}

export interface ArtifactImportFile {
  kind?: string;
  artifacts: ImportArtifactPayload[];
}

export interface ImportPlan {
  batch: ImportBatch;
  creates: Artifact[];
  updates: Array<{ artifact: Artifact; existingId: string }>;
  skipped: Array<{ accessionId: string; reason: string }>;
}

const ROLES: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];
const SENSITIVITIES: Sensitivity[] = ['standard', 'low-light', 'fragile'];
const NEEDS: AccessibilityNeed[] = ['none', 'seating', 'audio', 'tactile-alternative'];
const PALETTE = ['#c9563f', '#7c6aa6', '#2f7c75', '#c7903d', '#3f6fa8', '#8c9474', '#a55f72', '#597b8e'];

export function parseImportFile(raw: string): ArtifactImportFile | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const candidate = value as { artifacts?: unknown };
    if (!Array.isArray(candidate.artifacts)) return null;
    if (candidate.artifacts.length === 0) return null;
    return value as ArtifactImportFile;
  } catch {
    return null;
  }
}

function dimension(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 10000 ? parsed : null;
}

/**
 * Build a deterministic import plan. Re-importing the same file produces the
 * same batch id and content hash; records already created or merged by that
 * batch are never regenerated, so provenance relationships are not duplicated.
 */
export function planImport(
  parsed: ArtifactImportFile,
  fileName: string,
  contents: string,
  existing: Artifact[],
  options: { previousBatch?: ImportBatch } = {},
  now = new Date(),
): ImportPlan {
  const contentHash = hashImportFile(fileName, contents);
  const batchId = `batch-${contentHash.slice(0, 12)}`;
  const timestamp = now.toISOString();
  const creates: Artifact[] = [];
  const updates: Array<{ artifact: Artifact; existingId: string }> = [];
  const skipped: Array<{ accessionId: string; reason: string }> = [];
  const alreadyCovered = new Set(options.previousBatch?.artifactIds ?? []);
  const batchArtifactIds: string[] = [...(options.previousBatch?.artifactIds ?? [])];

  const byAccession = new Map(existing.map((artifact) => [normalizeAccessionId(artifact.accessionId), artifact]));
  const seenInFile = new Set<string>();

  parsed.artifacts.forEach((payload, index) => {
    const accessionId = normalizeAccessionId(String(payload.accessionId ?? ''));
    const title = String(payload.title ?? '').trim();
    const medium = String(payload.medium ?? '').trim();
    const summary = String(payload.summary ?? '').trim();
    if (!accessionId) { skipped.push({ accessionId: `row ${index + 1}`, reason: 'Missing accession ID' }); return; }
    if (!title || !medium || summary.length < 24) { skipped.push({ accessionId, reason: 'Missing or too-short required fields' }); return; }
    if (seenInFile.has(accessionId)) { skipped.push({ accessionId, reason: 'Duplicate row inside the file' }); return; }
    seenInFile.add(accessionId);

    const current = byAccession.get(accessionId);
    if (current && alreadyCovered.has(current.id)) {
      skipped.push({ accessionId, reason: 'Already imported from this file' });
      return;
    }

    const width = dimension(payload.width);
    const height = dimension(payload.height);
    const depth = dimension(payload.depth);
    const dwell = Number(payload.dwellMinutes);
    if (!width || !height || !depth) { skipped.push({ accessionId, reason: 'Invalid dimensions' }); return; }
    if (!Number.isFinite(dwell) || dwell <= 0 || dwell > 30) { skipped.push({ accessionId, reason: 'Dwell time must be 1–30 minutes' }); return; }
    const narrativeRole = ROLES.includes(payload.narrativeRole) ? payload.narrativeRole : 'context';
    const sensitivity = payload.sensitivity && SENSITIVITIES.includes(payload.sensitivity) ? payload.sensitivity : 'standard';
    const accessibilityNeed = payload.accessibilityNeed && NEEDS.includes(payload.accessibilityNeed) ? payload.accessibilityNeed : 'none';
    const dimensions: Dimensions = { width, height, depth, unit: 'cm' };

    const artifact: Artifact = {
      id: current?.id ?? createId('artifact'),
      accessionId,
      title,
      maker: String(payload.maker ?? '').trim() || 'Unknown maker',
      yearLabel: String(payload.yearLabel ?? '').trim() || 'Date unknown',
      medium,
      origin: String(payload.origin ?? '').trim() || 'Origin unknown',
      summary,
      dimensions,
      dwellMinutes: dwell,
      narrativeRole,
      sensitivity,
      accessibilityNeed,
      isKeyObject: Boolean(payload.isKeyObject),
      tags: Array.isArray(payload.tags) ? payload.tags.map(String).slice(0, 8) : [],
      color: payload.color || PALETTE[index % PALETTE.length],
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    if (current) {
      updates.push({ artifact, existingId: current.id });
      if (!alreadyCovered.has(current.id)) batchArtifactIds.push(artifact.id);
    } else {
      creates.push(artifact);
      batchArtifactIds.push(artifact.id);
    }
  });

  return {
    batch: { id: batchId, fileName, contentHash, importedAt: timestamp, artifactIds: batchArtifactIds },
    creates,
    updates,
    skipped,
  };
}
