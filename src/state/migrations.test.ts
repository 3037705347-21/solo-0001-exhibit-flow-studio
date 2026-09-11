import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import {
  applyReviewDecisions,
  buildMigrationPlan,
  detectWorkspaceVersion,
  findWorkspaceShapeErrors,
  migrateWorkspace,
} from './migrations';
import { serializeWorkspaceFile } from '../domain/workspaceFile';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function v2Fixture(): WorkspaceState {
  return JSON.parse(JSON.stringify(toPlainV2(createSeedWorkspace()))) as WorkspaceState;
}

function toPlainV2(state: WorkspaceState): WorkspaceState {
  const { restoredFrom, lastSavedAt, ...rest } = state;
  void restoredFrom;
  void lastSavedAt;
  return rest as WorkspaceState;
}

/** Legacy pre-sequence export: no version tag, dwell seconds, no sequence. */
function v0Fixture() {
  return {
    project: {
      id: 'project-old',
      title: 'Old Format Exhibition',
      venue: 'Warehouse 4',
      audience: 'Adults',
      openingDate: '2024-05-01',
      stage: 'draft',
    },
    preferences: { pace: 'focused', accessibilityPriority: 40, groupSize: 3 },
    artifacts: [
      {
        id: 'old-a-1',
        accessionId: 'OLD-001',
        title: 'Lantern',
        maker: 'Cooke',
        yearLabel: '1908',
        medium: 'Brass',
        origin: 'York',
        summary: 'A hand-carried signal lantern with a worn leather grip.',
        dimensions: { width: 20, height: 30, depth: 18, unit: 'cm' },
        dwellSeconds: 240,
        narrativeRole: 'threshold',
        sensitivity: 'standard',
        accessibilityNeed: 'none',
        isKeyObject: true,
        tags: ['rail'],
        color: '#112233',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'old-a-2',
        accessionId: 'OLD-002',
        title: 'Tape',
        maker: 'Riverside',
        yearLabel: '1994',
        medium: 'Magnetic tape',
        origin: 'Glasgow',
        summary: 'A cassette holding recollections of the closed factory.',
        dimensions: { width: 10, height: 6, depth: 1.2, unit: 'cm' },
        dwellSeconds: 90,
        narrativeRole: 'reflection',
        sensitivity: 'standard',
        accessibilityNeed: 'audio',
        isKeyObject: false,
        tags: [],
        color: '#223344',
      },
    ],
    zones: [
      {
        id: 'old-z-1',
        name: 'Threshold Room',
        shortLabel: 'Threshold',
        thesis: 'Begin',
        capacityMinutes: 10,
        maxObjects: 2,
        lowLight: false,
        hasSeating: false,
        color: '#112233',
        artifactIds: ['old-a-1'],
      },
    ],
    issues: [
      {
        id: 'old-i-1',
        title: 'Check entry lighting',
        description: 'Too bright for first impression.',
        severity: 'note',
        status: 'open',
        zoneId: 'old-z-1',
        owner: 'Mara',
        createdAt: '2024-02-01T00:00:00.000Z',
        updatedAt: '2024-02-01T00:00:00.000Z',
      },
    ],
  };
}

function v1Fixture() {
  const v0 = v0Fixture();
  return {
    version: 1 as const,
    project: v0.project,
    preferences: { pace: 'leisurely', accessibilityPriority: 80, groupSize: 9 },
    artifacts: v0.artifacts.map(({ dwellSeconds, ...rest }) => ({
      ...rest,
      dwellMinutes: (dwellSeconds as number) / 60,
    })),
    zones: v0.zones.map((zone, index) => ({ ...zone, sequence: index })),
    issues: v0.issues,
    lastSavedAt: '2024-03-01T00:00:00.000Z',
  };
}

function verdictIds(plan: ReturnType<typeof expectPlan>, verdict: string): string[] {
  return plan.report.entries.filter((entry) => entry.verdict === verdict).map((entry) => entry.id);
}

function expectPlan(input: unknown) {
  const result = buildMigrationPlan(input);
  if (!result.ok) throw new Error(`Expected plan, got rejection: ${result.reason}`);
  return result.plan;
}

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

describe('workspace version detection', () => {
  it('recognizes a current-version workspace file', () => {
    const file = JSON.parse(serializeWorkspaceFile(v2Fixture()));
    const detection = detectWorkspaceVersion(file);
    expect(detection.ok).toBe(true);
    if (detection.ok) {
      expect(detection.version).toBe(2);
      expect(detection.format).toBe('workspace-file');
    }
  });
  it('recognizes legacy v1 and versionless v0 dumps', () => {
    const v1 = detectWorkspaceVersion(v1Fixture());
    expect(v1.ok && v1.version).toBe(1);
    const v0 = detectWorkspaceVersion(v0Fixture());
    expect(v0.ok && v0.version).toBe(0);
  });
  it('rejects readiness snapshots and unknown envelopes', () => {
    expect(detectWorkspaceVersion({ schemaVersion: 1, project: {} }).ok).toBe(false);
    expect(detectWorkspaceVersion('{bad json').ok).toBe(false);
    expect(detectWorkspaceVersion({ kind: 'something-else' }).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 1. Current version                                                  */
/* ------------------------------------------------------------------ */

describe('migrating the current version', () => {
  it('passes a v2 export through without structural changes and re-imports it', () => {
    const state = v2Fixture();
    const file = JSON.parse(serializeWorkspaceFile(state));
    const plan = expectPlan(file);
    expect(plan.report.sourceVersion).toBe(2);
    expect(plan.report.steps).toHaveLength(0);
    const applied = applyReviewDecisions(plan);
    expect(findWorkspaceShapeErrors(applied.state)).toEqual([]);
    expect(applied.state.project.id).toBe(state.project.id);
    expect(applied.state.preferences.targetVisitMinutes).toBe(state.preferences.targetVisitMinutes);

    const reimported = expectPlan(JSON.parse(serializeWorkspaceFile(applied.state)));
    expect(applyReviewDecisions(reimported).state.project.title).toBe(state.project.title);
  });
  it('strips provenance when exporting so a re-import is a clean plan', () => {
    const state = v2Fixture();
    state.restoredFrom = {
      restoredAt: '2026-09-10T00:00:00.000Z',
      sourceVersion: 0,
      retainedCount: 1,
      addedCount: 1,
      invalidatedCount: 0,
      confirmedCount: 0,
    };
    const serialized = serializeWorkspaceFile(state);
    expect(serialized).not.toContain('restoredFrom');
  });
});

/* ------------------------------------------------------------------ */
/* 2. Old version (v0 and v1)                                          */
/* ------------------------------------------------------------------ */

describe('migrating old versions in order', () => {
  it('runs v0 -> v1 -> v2, converting dwell seconds and assigning sequence', () => {
    const plan = expectPlan(v0Fixture());
    expect(plan.report.steps.map((step) => [step.from, step.to])).toEqual([[0, 1], [1, 2]]);
    const applied = applyReviewDecisions(plan);
    expect(findWorkspaceShapeErrors(applied.state)).toEqual([]);

    const lantern = applied.state.artifacts.find((artifact) => artifact.id === 'old-a-1')!;
    expect(lantern.dwellMinutes).toBe(4);
    const tape = applied.state.artifacts.find((artifact) => artifact.id === 'old-a-2')!;
    expect(tape.dwellMinutes).toBe(2); // 90 seconds rounds to 2 minutes
    expect(applied.state.zones[0].sequence).toBe(0);
    expect(applied.state.version).toBe(2);
    expect(applied.state.project.planCode).toMatch(/^PLN-\d{4}-[0-9A-Z]{4}$/);
  });
  it('migrates v1 with a single step and keeps records intact', () => {
    const plan = expectPlan(v1Fixture());
    expect(plan.report.steps.map((step) => [step.from, step.to])).toEqual([[1, 2]]);
    const applied = applyReviewDecisions(plan);
    expect(findWorkspaceShapeErrors(applied.state)).toEqual([]);
    expect(applied.state.artifacts).toHaveLength(2);
    expect(applied.state.preferences.pace).toBe('leisurely');
  });
  it('never regresses the silent loader used at startup', () => {
    const migrated = migrateWorkspace(v0Fixture());
    expect(migrated).not.toBeNull();
    expect(migrated!.version).toBe(2);
    expect(findWorkspaceShapeErrors(migrated)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Missing fields                                                   */
/* ------------------------------------------------------------------ */

describe('migrating files with missing fields', () => {
  it('creates review/added entries instead of crashing and fills safe defaults', () => {
    const v0 = v0Fixture();
    const brokenArtifacts = [
      // No ID or accession, but a title keeps the row identifiable; every
      // other field is missing and must be defaulted under review.
      { medium: 'Stone', tags: 'not-an-array', title: 'Fragment' },
      // Complete object but with missing tags/color flags.
      {
        id: 'old-a-3',
        accessionId: 'OLD-003',
        title: 'Bowl',
        maker: 'Unknown',
        yearLabel: 'c.1987',
        medium: 'Stoneware',
        origin: 'Seoul',
        summary: 'A repaired household bowl kept together with staples.',
        dimensions: { width: 31, height: 12, depth: 31, unit: 'cm' },
        dwellSeconds: 300,
        narrativeRole: 'reflection',
      },
    ] as unknown[];
    const input = {
      ...v0,
      artifacts: brokenArtifacts,
      zones: [{ id: 'old-z-9' }],
      issues: [
        { id: 'old-i-9' },
        { id: 'old-i-10', title: 'Needs an owner', description: 'Context for the ownerless finding.', severity: 'warning', status: 'open' },
      ],
    };
    const plan = expectPlan(input);
    const applied = applyReviewDecisions(plan);
    expect(findWorkspaceShapeErrors(applied.state)).toEqual([]);

    const placeholder = applied.state.artifacts.find((artifact) => artifact.title === 'Fragment')!;
    expect(placeholder).toBeTruthy();
    expect(placeholder.dwellMinutes).toBe(3);
    expect(placeholder.dimensions).toEqual({ width: 10, height: 10, depth: 10, unit: 'cm' });
    expect(placeholder.accessionId).toMatch(/^UNKNOWN-/);

    const bowl = applied.state.artifacts.find((artifact) => artifact.id === 'old-a-3')!;
    expect(bowl.tags).toEqual([]);
    expect(bowl.isKeyObject).toBe(false);
    expect(bowl.color).toBeTruthy();

    const zone = applied.state.zones[0];
    expect(zone.name).toBe('Unnamed zone');
    expect(zone.capacityMinutes).toBe(15);
    expect(zone.maxObjects).toBe(4);
    const ownerless = applied.state.issues.find((issue) => issue.id === 'old-i-10')!;
    expect(ownerless.owner).toBe('Unassigned');
    expect(verdictIds(plan, 'review').length).toBeGreaterThan(0);
    expect(verdictIds(plan, 'added').length).toBeGreaterThan(0);
  });
  it('drops a missing-title finding rather than carrying an unusable record', () => {
    const v0 = v0Fixture();
    const plan = expectPlan({ ...v0, issues: [{ id: 'bad-issue', severity: 'critical' }] });
    const applied = applyReviewDecisions(plan);
    expect(applied.state.issues).toHaveLength(0);
    expect(verdictIds(plan, 'invalid').some((id) => id.startsWith('issue:bad-issue'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Broken references                                                */
/* ------------------------------------------------------------------ */

describe('migrating files with broken references', () => {
  it('strips dangling zone placements and issue links', () => {
    const v1 = v1Fixture();
    const input = {
      ...v1,
      zones: [{ ...v1.zones[0], artifactIds: ['old-a-1', 'ghost-artifact', 'old-a-1'] }],
      issues: [
        ...v1.issues,
        { id: 'i-ghost-zone', title: 'Lost zone', description: 'x'.repeat(20), severity: 'warning', status: 'open', zoneId: 'ghost-zone', owner: 'A', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
        { id: 'i-ghost-artifact', title: 'Lost object', description: 'x'.repeat(20), severity: 'note', status: 'open', artifactId: 'ghost-artifact', owner: 'B', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const plan = expectPlan(input);
    const applied = applyReviewDecisions(plan);
    expect(findWorkspaceShapeErrors(applied.state)).toEqual([]);
    expect(applied.state.zones[0].artifactIds).toEqual(['old-a-1']);
    expect(applied.state.issues.find((issue) => issue.id === 'i-ghost-zone')?.zoneId).toBeUndefined();
    expect(applied.state.issues.find((issue) => issue.id === 'i-ghost-artifact')?.artifactId).toBeUndefined();
    expect(verdictIds(plan, 'invalid').length).toBeGreaterThanOrEqual(3);
  });
  it('repairs duplicate ids and accession ids as reviewable records', () => {
    const v1 = v1Fixture();
    const duplicate = { ...v1.artifacts[0], id: v1.artifacts[0].id, accessionId: 'OLD-001', title: 'Lantern Copy' };
    const input = { ...v1, artifacts: [v1.artifacts[0], duplicate] };
    const plan = expectPlan(input);
    const applied = applyReviewDecisions(plan);
    expect(findWorkspaceShapeErrors(applied.state)).toEqual([]);
    expect(new Set(applied.state.artifacts.map((artifact) => artifact.id)).size).toBe(2);
    expect(new Set(applied.state.artifacts.map((artifact) => artifact.accessionId)).size).toBe(2);
    expect(verdictIds(plan, 'review').some((id) => id.includes('collision'))).toBe(true);
  });
  it('cascades a dropped object out of zones and issue links', () => {
    const v0 = v0Fixture();
    const input = {
      ...v0,
      zones: [
        { ...v0.zones[0], artifactIds: ['old-a-1', 'old-a-2'] },
      ],
      issues: [
        { id: 'i-link', title: 'Tape note', description: 'x'.repeat(20), severity: 'note', status: 'open', artifactId: 'old-a-2', zoneId: 'old-z-1', owner: 'A', createdAt: '2024-01-01', updatedAt: '2024-01-01' },
      ],
    };
    const plan = expectPlan(input);
    // The 90-second tape is reviewable; drop it.
    const tapeEntry = plan.report.entries.find((entry) => entry.recordId === 'old-a-2' && entry.adjustable)!;
    const applied = applyReviewDecisions(plan, { [tapeEntry.id]: 'drop' });
    expect(findWorkspaceShapeErrors(applied.state)).toEqual([]);
    expect(applied.state.artifacts.some((artifact) => artifact.id === 'old-a-2')).toBe(false);
    expect(applied.state.zones[0].artifactIds).not.toContain('old-a-2');
    expect(applied.state.issues[0].artifactId).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 5. Interrupted recovery                                             */
/* ------------------------------------------------------------------ */

describe('interrupted recovery safety', () => {
  it('keeps the previous storage usable when migration produces nothing usable', () => {
    expect(buildMigrationPlan({ version: 9 }).ok).toBe(false);
    expect(migrateWorkspace({ version: 9 })).toBeNull();
  });
  it('never commits when the reviewer drops records that would leave a shape error', () => {
    // Even aggressive dropping must converge to a valid state because the
    // shared reference scan clears cascading links.
    const plan = expectPlan(v1Fixture());
    const decisions: Record<string, 'drop'> = {};
    for (const entry of plan.report.entries) {
      if (entry.adjustable) decisions[entry.id] = 'drop';
    }
    const applied = applyReviewDecisions(plan, decisions);
    expect(findWorkspaceShapeErrors(applied.state)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Sample plan shares the structural validation path                   */
/* ------------------------------------------------------------------ */

describe('sample plan structural validation', () => {
  it('validates the seed workspace through the same path as recovery', () => {
    expect(findWorkspaceShapeErrors(createSeedWorkspace())).toEqual([]);
  });
  it('reports structural problems precisely', () => {
    const state = v2Fixture();
    state.artifacts[0].dwellMinutes = 0;
    state.zones[0].artifactIds.push('missing');
    const errors = findWorkspaceShapeErrors(state);
    expect(errors.some((error) => error.includes('dwell time'))).toBe(true);
    expect(errors.some((error) => error.includes('unknown artifact'))).toBe(true);
  });
});
