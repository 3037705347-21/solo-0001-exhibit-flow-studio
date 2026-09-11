import type { WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';

export interface FixtureOptions {
  version?: number;
  wrapped?: boolean;
  /** strip a field on one artifact to simulate missing fields */
  missingField?: boolean;
  /** point references at ids that do not exist to simulate corruption */
  brokenReferences?: boolean;
}

/**
 * Builds import fixtures for the five validation scenarios. The returned
 * object is always derived from the seed so it starts structurally valid.
 */
export function buildImportFixture(options: FixtureOptions = {}): unknown {
  const seed: WorkspaceState = createSeedWorkspace();
  const version = options.version ?? 2;

  // v1 payload: version 1 and no v2-only preference fields.
  const preferences = {
    pace: seed.preferences.pace,
    accessibilityPriority: seed.preferences.accessibilityPriority,
    groupSize: seed.preferences.groupSize,
  };
  const zones = version < 1
    ? seed.zones.map(({ sequence: _sequence, ...zone }) => zone)
    : seed.zones;

  let artifacts: unknown = seed.artifacts;
  if (options.missingField) {
    artifacts = seed.artifacts.map((artifact, index) => {
      // A repairable gap: empty title gets a default ("added" change).
      if (index === 0) return { ...artifact, title: '' };
      // An unrecoverable record: gloves are unplaced and unreferenced, so
      // dropping them creates no dangling references (kept separate from the
      // broken-reference scenario).
      if (artifact.id === 'artifact-gloves') {
        const copy: Record<string, unknown> = { ...artifact };
        delete copy.dimensions;
        return copy;
      }
      return artifact;
    });
  }

  const issues = options.brokenReferences
    ? [
        ...seed.issues,
        {
          id: 'issue-broken-zone',
          title: 'Finding linked to a missing zone',
          description: 'This reference dangles after an export from a newer branch.',
          severity: 'critical',
          status: 'open',
          zoneId: 'zone-vanished',
          owner: 'Recovery Tester',
          createdAt: '2026-09-01T10:00:00.000Z',
          updatedAt: '2026-09-01T10:00:00.000Z',
        },
        {
          id: 'issue-broken-artifact',
          title: 'Finding linked to a missing object',
          description: 'This reference dangles after an export from a newer branch.',
          severity: 'warning',
          status: 'open',
          artifactId: 'artifact-vanished',
          owner: 'Recovery Tester',
          createdAt: '2026-09-01T10:00:00.000Z',
          updatedAt: '2026-09-01T10:00:00.000Z',
        },
      ]
    : seed.issues;

  const brokenZones = options.brokenReferences
    ? zones.map((zone, index) => index === 0
      ? { ...zone, artifactIds: [...zone.artifactIds, 'artifact-vanished'] }
      : zone)
    : zones;

  const payload = {
    version,
    project: seed.project,
    artifacts,
    zones: brokenZones,
    issues,
    preferences: version < 2 ? preferences : seed.preferences,
    lastSavedAt: seed.lastSavedAt,
  };

  if (!options.wrapped) return payload;
  return {
    kind: 'exhibit-flow-workspace',
    fileVersion: 1,
    exportedAt: '2026-09-11T08:00:00.000Z',
    workspace: payload,
  };
}

export function memoryTransferStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  return { values, storage: storage as unknown as Storage & Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> };
}
