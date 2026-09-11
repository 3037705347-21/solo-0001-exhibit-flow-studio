/* Fixtures for the versioned workspace migration/recovery workflow. */

export interface ArtifactLike {
  id: string;
  accessionId: string;
  title: string;
  maker: string;
  yearLabel: string;
  medium: string;
  origin: string;
  summary: string;
  dimensions: { width: number; height: number; depth: number; unit: 'cm' };
  narrativeRole: string;
  sensitivity: string;
  accessibilityNeed: string;
  isKeyObject: boolean;
  tags: string[];
  color: string;
  createdAt: string;
  updatedAt: string;
}

function artifact(partial: Partial<ArtifactLike> & { id: string; title: string; accessionId: string }, dwellKey: 'minutes' | 'seconds'): Record<string, unknown> {
  const base: ArtifactLike = {
    maker: 'Studio North',
    yearLabel: '2026',
    medium: 'Mixed media',
    origin: 'Local collection',
    summary: 'A recovered object carrying enough context to join the visitor narrative.',
    dimensions: { width: 20, height: 30, depth: 12, unit: 'cm' },
    narrativeRole: 'context',
    sensitivity: 'standard',
    accessibilityNeed: 'none',
    isKeyObject: false,
    tags: ['test'],
    color: '#2f7c75',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
  if (dwellKey === 'seconds') return { ...base, dwellSeconds: 240 };
  return { ...base, dwellMinutes: 4 };
}

const PROJECT = {
  id: 'project-e2e',
  title: 'Recovery Fixture Exhibition',
  venue: 'Test Hall',
  audience: 'General visitors',
  openingDate: '2027-06-01',
  stage: 'draft',
};

const PREFERENCES = { pace: 'balanced', accessibilityPriority: 50, groupSize: 5 };

/** Current version 2 envelope, re-exported through the app for round-trip. */
export function currentVersionFile(): string {
  return JSON.stringify({
    kind: 'exhibit-flow.workspace-file',
    fileVersion: 2,
    exportedAt: '2026-09-01T00:00:00.000Z',
    source: 'manual-export',
    workspace: {
      version: 2,
      project: { ...PROJECT, planCode: 'PLN-2027-TEST' },
      artifacts: [
        artifact({ id: 'cur-1', accessionId: 'CUR-001', title: 'Current Version Vase', narrativeRole: 'threshold', isKeyObject: true }, 'minutes'),
        artifact({ id: 'cur-2', accessionId: 'CUR-002', title: 'Current Version Scroll', narrativeRole: 'turning-point' }, 'minutes'),
        artifact({ id: 'cur-3', accessionId: 'CUR-003', title: 'Current Version Quilt', narrativeRole: 'reflection', sensitivity: 'low-light' }, 'minutes'),
        artifact({ id: 'cur-4', accessionId: 'CUR-004', title: 'Current Version Radio', narrativeRole: 'context', accessibilityNeed: 'audio' }, 'minutes'),
      ],
      zones: [
        { id: 'cur-z1', name: 'Current Zone', shortLabel: 'Current', thesis: 'A', capacityMinutes: 30, maxObjects: 4, lowLight: true, hasSeating: true, color: '#2f7c75', sequence: 0, artifactIds: ['cur-1', 'cur-2', 'cur-3', 'cur-4'] },
      ],
      issues: [],
      preferences: { ...PREFERENCES, targetVisitMinutes: 40 },
    },
  });
}

/** Pre-sequence v0 export: no version, dwell seconds, no zone sequence. */
export function oldVersionFile(): string {
  return JSON.stringify({
    project: PROJECT,
    preferences: PREFERENCES,
    artifacts: [
      artifact({ id: 'old-1', accessionId: 'OLD-001', title: 'Old Format Lantern', narrativeRole: 'threshold', isKeyObject: true }, 'seconds'),
      artifact({ id: 'old-2', accessionId: 'OLD-002', title: 'Old Format Tape', narrativeRole: 'reflection', accessibilityNeed: 'audio' }, 'seconds'),
      artifact({ id: 'old-3', accessionId: 'OLD-003', title: 'Old Format Press', narrativeRole: 'turning-point' }, 'seconds'),
      artifact({ id: 'old-4', accessionId: 'OLD-004', title: 'Old Format Bowl', narrativeRole: 'context' }, 'seconds'),
    ],
    zones: [
      { id: 'old-z1', name: 'Old Format Room', shortLabel: 'Old room', thesis: 'B', capacityMinutes: 30, maxObjects: 4, lowLight: false, hasSeating: true, color: '#7c6aa6', artifactIds: ['old-1', 'old-2', 'old-3', 'old-4'] },
    ],
    issues: [],
  });
}

/** v1 dump missing fields on an artifact, a zone, and an issue. */
export function missingFieldsFile(): string {
  return JSON.stringify({
    version: 1,
    project: PROJECT,
    preferences: PREFERENCES,
    artifacts: [
      artifact({ id: 'miss-1', accessionId: 'MISS-001', title: 'Complete Compass', narrativeRole: 'threshold', isKeyObject: true }, 'minutes'),
      {
        // Identifiable by title, but id, accession, dimensions, tags, flags missing.
        title: 'Fragment Without Fields',
        narrativeRole: 'reflection',
      },
    ],
    zones: [
      { id: 'miss-z1', artifactIds: ['miss-1'] }, // name, capacity, flags missing
    ],
    issues: [
      { id: 'miss-i1', title: 'Finding Without Owner', description: 'This finding needs an owner assigned during migration.', severity: 'note', status: 'open' },
    ],
  });
}

/** v1 dump with dangling and duplicate references. */
export function brokenReferencesFile(): string {
  return JSON.stringify({
    version: 1,
    project: PROJECT,
    preferences: PREFERENCES,
    artifacts: [
      artifact({ id: 'ref-1', accessionId: 'REF-001', title: 'Referenced Lantern', narrativeRole: 'threshold', isKeyObject: true }, 'minutes'),
      artifact({ id: 'ref-2', accessionId: 'REF-002', title: 'Referenced Tape', narrativeRole: 'reflection' }, 'minutes'),
      artifact({ id: 'ref-3', accessionId: 'REF-003', title: 'Referenced Bowl', narrativeRole: 'turning-point' }, 'minutes'),
      artifact({ id: 'ref-4', accessionId: 'REF-004', title: 'Referenced Scroll', narrativeRole: 'context' }, 'minutes'),
    ],
    zones: [
      {
        id: 'ref-z1',
        name: 'Reference Room',
        shortLabel: 'Refs',
        thesis: 'C',
        capacityMinutes: 30,
        maxObjects: 4,
        lowLight: false,
        hasSeating: true,
        color: '#c7903d',
        sequence: 0,
        artifactIds: ['ref-1', 'ghost-artifact', 'ref-1', 'ref-2', 'ref-3', 'ref-4'],
      },
    ],
    issues: [
      { id: 'ref-i1', title: 'Ghost Zone Finding', description: 'Points at a zone that does not exist in the file.', severity: 'warning', status: 'open', zoneId: 'ghost-zone', owner: 'Ari', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
    ],
  });
}

/** Valid v2 envelope for the interrupted-recovery rollback scenario. */
export function interruptedFile(): string {
  return currentVersionFile();
}

/** A readiness snapshot, which must be refused rather than restored. */
export function snapshotFile(): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-09-01T00:00:00.000Z',
    project: PROJECT,
    summary: { artifactCount: 1, zoneCount: 1, visitMinutes: 4, readinessScore: 90 },
    zones: [],
    unresolvedIssues: [],
  });
}
