import { describe, expect, it } from 'vitest';
import type { ReviewIssue, WorkspaceState } from './models';
import { createSeedWorkspace } from '../state/seed';
import {
  applyMergePlan,
  buildMergePlan,
  getMergePlanStatus,
  parseMergePayload,
  resolveArtifactField,
  resolveFindingField,
  setArtifactDecision,
  setArtifactEntryResolution,
  setFindingDecision,
  setFindingEntryResolution,
  type IncomingArtifact,
  type IncomingFinding,
  type MergeImportPayload,
} from './merge';

const FIXED_AT = '2026-09-10T08:00:00.000Z';
let counter = 0;
const testIdFactory = () => `test-id-${(counter += 1)}`;

function baseState(): WorkspaceState {
  counter = 0;
  return createSeedWorkspace();
}

function incomingArtifact(overrides: Partial<IncomingArtifact> = {}): IncomingArtifact {
  return { accessionId: 'AF-NEW-001', title: 'Imported Object', ...overrides };
}

describe('buildMergePlan', () => {
  it('classifies brand-new records as new', () => {
    const plan = buildMergePlan(baseState(), {
      artifacts: [incomingArtifact({ medium: 'Mixed media', summary: 'An object with enough descriptive text for import.' })],
    }, testIdFactory, FIXED_AT);
    expect(plan.artifactEntries).toHaveLength(1);
    expect(plan.artifactEntries[0].kind).toBe('new');
    expect(getMergePlanStatus(plan).ready).toBe(true);
  });

  it('treats fully identical records as identical without decisions', () => {
    const state = baseState();
    const lantern = state.artifacts[0];
    const plan = buildMergePlan(state, {
      artifacts: [{
        accessionId: lantern.accessionId,
        title: lantern.title,
        maker: lantern.maker,
        yearLabel: lantern.yearLabel,
        medium: lantern.medium,
        origin: lantern.origin,
        summary: lantern.summary,
        dimensions: lantern.dimensions,
        dwellMinutes: lantern.dwellMinutes,
        narrativeRole: lantern.narrativeRole,
        sensitivity: lantern.sensitivity,
        accessibilityNeed: lantern.accessibilityNeed,
        isKeyObject: lantern.isKeyObject,
        tags: lantern.tags,
        color: lantern.color,
      }],
    }, testIdFactory, FIXED_AT);
    expect(plan.artifactEntries[0].kind).toBe('identical');
    expect(getMergePlanStatus(plan).ready).toBe(true);
  });
});

describe('field conflicts', () => {
  function conflictPlan() {
    const state = baseState();
    const lantern = state.artifacts[0];
    const payload: MergeImportPayload = {
      artifacts: [{
        accessionId: lantern.accessionId,
        title: 'Railway Signal Lamp (Revised)',
        maker: lantern.maker,
        yearLabel: lantern.yearLabel,
        medium: lantern.medium,
        origin: lantern.origin,
        summary: lantern.summary,
        dimensions: { width: 20, height: 35, depth: 19, unit: 'cm' },
        dwellMinutes: 5,
        narrativeRole: lantern.narrativeRole,
        sensitivity: lantern.sensitivity,
        accessibilityNeed: lantern.accessibilityNeed,
        isKeyObject: lantern.isKeyObject,
        tags: lantern.tags,
        color: lantern.color,
      }],
    };
    return { state, plan: buildMergePlan(state, payload, testIdFactory, FIXED_AT) };
  }

  it('lists every differing field with current, incoming, and merged values', () => {
    const { plan } = conflictPlan();
    const entry = plan.artifactEntries[0];
    expect(entry.kind).toBe('conflict');
    const fields = Object.fromEntries(entry.fields.map((field) => [field.field, field]));
    expect(fields.title.current).toContain('Lantern');
    expect(fields.title.incoming).toContain('Lamp');
    expect(fields.dimensions.current).toBe('19 × 34 × 18 cm');
    expect(fields.dimensions.incoming).toBe('20 × 35 × 19 cm');
    expect(fields.title.merged).toBeTruthy();
    expect(entry.fields.every((field) => !field.decided)).toBe(true);
  });

  it('refuses to commit while any field conflict is unresolved', () => {
    const { state, plan } = conflictPlan();
    expect(getMergePlanStatus(plan).ready).toBe(false);
    expect(() => applyMergePlan(state, plan, FIXED_AT)).toThrow(/decision/i);
    // Existing workspace is untouched by the failed commit.
    expect(state.artifacts[0].title).toBe('Railway Signal Lantern');
  });

  it('applies per-field side choices and keeps the current id, placement, and findings', () => {
    const { state, plan } = conflictPlan();
    let next = resolveArtifactField(plan, plan.artifactEntries[0].key, 'title', 'current');
    next = resolveArtifactField(next, next.artifactEntries[0].key, 'dimensions', 'incoming');
    next = resolveArtifactField(next, next.artifactEntries[0].key, 'dwellMinutes', 'incoming');
    next = setArtifactDecision(next, next.artifactEntries[0].key, 'accept-merged');
    expect(getMergePlanStatus(next).ready).toBe(true);

    const mergedState = applyMergePlan(state, next, FIXED_AT);
    const lantern = mergedState.artifacts.find((artifact) => artifact.id === 'artifact-lantern')!;
    expect(lantern.title).toBe('Railway Signal Lantern');
    expect(lantern.dimensions).toMatchObject({ width: 20, height: 35, depth: 19 });
    expect(lantern.dwellMinutes).toBe(5);
    // Placement reference survives by stable identity.
    expect(mergedState.zones[0].artifactIds).toContain('artifact-lantern');
  });

  it('supports take-incoming and keep-current for the whole record', () => {
    const { state, plan } = conflictPlan();
    const incoming = setArtifactDecision(plan, plan.artifactEntries[0].key, 'take-incoming');
    const mergedState = applyMergePlan(state, incoming, FIXED_AT);
    expect(mergedState.artifacts[0].title).toBe('Railway Signal Lamp (Revised)');

    const kept = applyMergePlan(state, setArtifactDecision(plan, plan.artifactEntries[0].key, 'keep-current'), FIXED_AT);
    expect(kept.artifacts[0].title).toBe('Railway Signal Lantern');
  });
});

describe('finding field conflicts', () => {
  it('reconciles findings by stable title + linked identity and resolves per field', () => {
    const state = baseState();
    const existing = state.issues.find((issue) => issue.id === 'issue-audio-transcript')!;
    const payload: MergeImportPayload = {
      findings: [{
        title: existing.title,
        description: existing.description,
        severity: 'critical',
        status: 'resolved',
        owner: existing.owner,
        artifactAccessionId: 'AF-1994-052',
        zoneShortLabel: 'Afterlives',
      }],
    };
    const plan = buildMergePlan(state, payload, testIdFactory, FIXED_AT);
    const entry = plan.findingEntries[0];
    expect(entry.kind).toBe('field-conflict');
    expect(entry.fieldConflicts.map((field) => field.label)).toEqual(['Status']);
    expect(() => applyMergePlan(state, plan, FIXED_AT)).toThrow();

    let next = resolveFindingField(plan, entry.key, 'Status', 'incoming');
    next = setFindingDecision(next, entry.key, 'accept-merged');
    const mergedState = applyMergePlan(state, next, FIXED_AT);
    const updated = mergedState.issues.find((issue) => issue.id === existing.id)!;
    expect(updated.status).toBe('resolved');
    expect(updated.resolvedAt).toBeTruthy();
    // Linkage retained through stable identities.
    expect(updated.artifactId).toBe('artifact-tape');
    expect(updated.zoneId).toBe('zone-after');
  });
});

describe('reference conflicts', () => {
  it('flags findings pointing at identities absent from both sides and blocks until decided', () => {
    const state = baseState();
    const finding: IncomingFinding = {
      title: 'Dangling link finding',
      description: 'This finding points at an object that does not exist anywhere.',
      severity: 'warning',
      owner: 'Test Owner',
      artifactAccessionId: 'AF-MISSING-999',
    };
    const plan = buildMergePlan(state, { findings: [finding] }, testIdFactory, FIXED_AT);
    expect(plan.findingEntries[0].kind).toBe('reference-conflict');
    expect(getMergePlanStatus(plan).unresolvedReferenceConflicts).toBe(1);
    expect(() => applyMergePlan(state, plan, FIXED_AT)).toThrow();

    const dropped = applyMergePlan(
      state,
      setFindingEntryResolution(plan, plan.findingEntries[0].key, 'drop-link'),
      FIXED_AT,
    );
    const imported = dropped.issues.find((issue) => issue.title === 'Dangling link finding')!;
    expect(imported.artifactId).toBeUndefined();
    expect(imported.zoneId).toBeUndefined();

    const skipped = applyMergePlan(
      state,
      setFindingEntryResolution(plan, plan.findingEntries[0].key, 'skip'),
      FIXED_AT,
    );
    expect(skipped.issues.some((issue) => issue.title === 'Dangling link finding')).toBe(false);
  });

  it('resolves a reference conflict when the missing object arrives in the same batch', () => {
    const state = baseState();
    const payload: MergeImportPayload = {
      artifacts: [{
        accessionId: 'AF-BATCH-001',
        title: 'Batch Arrival',
        maker: 'Batch Maker',
        medium: 'Paper',
        summary: 'An object arriving together with its finding in one merge batch.',
        dimensions: { width: 10, height: 10, depth: 2 },
        dwellMinutes: 3,
      }],
      findings: [{
        title: 'Batch object finding',
        description: 'Linked to an object that is part of the same import.',
        severity: 'note',
        owner: 'Batch Owner',
        artifactAccessionId: 'AF-BATCH-001',
      }],
    };
    const plan = buildMergePlan(state, payload, testIdFactory, FIXED_AT);
    expect(plan.findingEntries[0].kind).toBe('new');
    const merged = applyMergePlan(state, plan, FIXED_AT);
    const created = merged.artifacts.find((artifact) => artifact.accessionId === 'AF-BATCH-001')!;
    const finding = merged.issues.find((issue) => issue.title === 'Batch object finding')!;
    expect(finding.artifactId).toBe(created.id);
  });
});

describe('identical records and idempotency', () => {
  it('re-running the same merge input produces no duplicate objects or findings', () => {
    const state = baseState();
    const payload: MergeImportPayload = {
      artifacts: [{
        accessionId: 'AF-IDEM-001',
        title: 'Idempotent Vessel',
        maker: 'Studio Repeat',
        medium: 'Clay',
        summary: 'A record that will be imported twice but must exist only once.',
        dimensions: { width: 12, height: 18, depth: 12 },
        dwellMinutes: 4,
      }],
      findings: [{
        title: 'Idempotent finding',
        description: 'Re-confirming the same observation should not duplicate it.',
        severity: 'note',
        owner: 'Repeat Owner',
        artifactAccessionId: 'AF-IDEM-001',
      }],
    };

    const firstPlan = buildMergePlan(state, payload, testIdFactory, FIXED_AT);
    const once = applyMergePlan(state, firstPlan, FIXED_AT);
    expect(once.artifacts.filter((artifact) => artifact.accessionId === 'AF-IDEM-001')).toHaveLength(1);

    // Second pass: the now-existing records match by stable identity.
    const secondPlan = buildMergePlan(once, payload, testIdFactory, FIXED_AT);
    expect(secondPlan.artifactEntries[0].kind).toBe('identical');
    expect(secondPlan.findingEntries[0].kind).toBe('identical');
    const twice = applyMergePlan(once, secondPlan, FIXED_AT);
    expect(twice.artifacts.filter((artifact) => artifact.accessionId === 'AF-IDEM-001')).toHaveLength(1);
    expect(twice.issues.filter((issue: ReviewIssue) => issue.title === 'Idempotent finding')).toHaveLength(1);
    expect(twice.artifacts.length).toBe(once.artifacts.length);
    expect(twice.issues.length).toBe(once.issues.length);
  });

  it('deduplicates repeated records inside one incoming batch', () => {
    const state = baseState();
    const record = incomingArtifact({
      accessionId: 'AF-DUP-001',
      medium: 'Paper',
      summary: 'Repeated inside a single file and should collapse to one entry.',
      dimensions: { width: 5, height: 5, depth: 1 },
      dwellMinutes: 2,
    });
    const plan = buildMergePlan(state, { artifacts: [record, record] }, testIdFactory, FIXED_AT);
    expect(plan.artifactEntries).toHaveLength(1);
    expect(plan.parseErrors.some((message) => message.includes('Duplicate'))).toBe(true);
  });

  it('normalizes accession id casing and spacing before matching', () => {
    const state = baseState();
    const plan = buildMergePlan(state, {
      artifacts: [{
        accessionId: '  af-1908-014 ',
        title: state.artifacts[0].title,
        maker: state.artifacts[0].maker,
        medium: state.artifacts[0].medium,
        summary: state.artifacts[0].summary,
        dimensions: state.artifacts[0].dimensions,
        dwellMinutes: state.artifacts[0].dwellMinutes,
      }],
    }, testIdFactory, FIXED_AT);
    expect(plan.artifactEntries[0].kind).toBe('identical');
  });

  it('treats a sparse finding confirmation (identity plus unchanged status) as identical', () => {
    const state = baseState();
    const plan = buildMergePlan(state, {
      findings: [{
        title: 'Add transcript beside oral history station',
        status: 'in-progress',
        artifactAccessionId: 'AF-1994-052',
        zoneShortLabel: 'Afterlives',
      }],
    }, testIdFactory, FIXED_AT);
    expect(plan.findingEntries[0].kind).toBe('identical');
    const merged = applyMergePlan(state, plan, FIXED_AT);
    expect(merged.issues.length).toBe(state.issues.length);
  });
});

describe('skip and existing data survival', () => {
  it('keeps every existing object, placement, and finding when records are skipped', () => {
    const state = baseState();
    const plan = buildMergePlan(state, {
      artifacts: [incomingArtifact({ medium: 'Paper', summary: 'Enough descriptive text for this incoming object record.' })],
    }, testIdFactory, FIXED_AT);
    const skipped = setArtifactEntryResolution(plan, plan.artifactEntries[0].key, 'skip');
    const merged = applyMergePlan(state, skipped, FIXED_AT);
    expect(merged.artifacts).toHaveLength(state.artifacts.length);
    expect(merged.zones).toEqual(state.zones);
    expect(merged.issues).toEqual(state.issues);
  });

  it('preserves placement and finding links when only other fields change', () => {
    const state = baseState();
    const quilt = state.artifacts.find((artifact) => artifact.accessionId === 'AF-1979-031')!;
    const plan = buildMergePlan(state, {
      artifacts: [{
        accessionId: quilt.accessionId,
        title: quilt.title,
        maker: quilt.maker,
        medium: quilt.medium,
        summary: quilt.summary,
        dimensions: quilt.dimensions,
        dwellMinutes: 9,
        narrativeRole: quilt.narrativeRole,
        sensitivity: quilt.sensitivity,
        accessibilityNeed: quilt.accessibilityNeed,
        isKeyObject: quilt.isKeyObject,
        tags: quilt.tags,
        color: quilt.color,
      }],
    }, testIdFactory, FIXED_AT);
    const decided = setArtifactDecision(plan, plan.artifactEntries[0].key, 'take-incoming');
    const merged = applyMergePlan(state, decided, FIXED_AT);
    const updated = merged.artifacts.find((artifact) => artifact.id === quilt.id)!;
    expect(updated.dwellMinutes).toBe(9);
    expect(merged.zones.some((zone) => zone.artifactIds.includes(quilt.id))).toBe(true);
    const finding = merged.issues.find((issue) => issue.id === 'issue-quilt-light')!;
    expect(finding.artifactId).toBe(quilt.id);
  });
});

describe('parseMergePayload', () => {
  it('parses a direct merge payload', () => {
    const result = parseMergePayload(JSON.stringify({ artifacts: [incomingArtifact()] }));
    expect('payload' in result).toBe(true);
  });

  it('rejects malformed JSON and unknown shapes', () => {
    expect('error' in parseMergePayload('{not json')).toBe(true);
    expect('error' in parseMergePayload(JSON.stringify({ hello: 'world' }))).toBe(true);
  });

  it('extracts objects and identity-linked findings from a snapshot export', () => {
    const state = baseState();
    const snapshot = {
      schemaVersion: 1,
      zones: [{
        id: 'zone-after',
        shortLabel: 'Afterlives',
        artifacts: [state.artifacts.find((artifact) => artifact.accessionId === 'AF-1994-052')],
      }],
      unresolvedIssues: [{
        ...state.issues[0],
        artifactId: 'artifact-tape',
        zoneId: 'zone-after',
      }],
    };
    const result = parseMergePayload(JSON.stringify(snapshot));
    if (!('payload' in result)) throw new Error('expected payload');
    expect(result.payload.artifacts).toHaveLength(1);
    expect(result.payload.findings?.[0].artifactAccessionId).toBe('AF-1994-052');
    expect(result.payload.findings?.[0].zoneShortLabel).toBe('Afterlives');
  });
});
