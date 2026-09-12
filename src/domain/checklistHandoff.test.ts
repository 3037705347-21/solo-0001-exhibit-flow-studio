import { describe, expect, it } from 'vitest';
import type { ChecklistHandoff, WorkspaceState } from './models';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import { buildZoneChecklist, serializeZoneChecklistCsv, zoneChecklistFileName } from './zoneChecklist';
import {
  checklistDigest,
  createChecklistHandoff,
  currentChecklistDigest,
  handoffDrifted,
  handoffFileName,
  handoffsForZone,
  latestHandoff,
  normalizeMembers,
  parseMemberList,
  serializeHandoffCsv,
  validateHandoffDraft,
  zoneConditions,
  type HandoffDraft,
} from './checklistHandoff';
import { workspaceReducer } from '../state/reducer';
import { createSeedWorkspace } from '../state/seed';

const HANDOFF_AT = new Date('2026-09-12T09:00:00.000Z');
const DRAFT: HandoffDraft = { scope: 'Floor install crew', members: ['Jo Renner', ' Mara Chen ', 'jo renner'] };

function recordHandoff(state: WorkspaceState, zoneId: string, draft: HandoffDraft = DRAFT, at = HANDOFF_AT): { state: WorkspaceState; handoff: ChecklistHandoff } {
  const handoff = createChecklistHandoff(state, zoneId, draft, at);
  if (!handoff) throw new Error(`Expected a handoff for ${zoneId}`);
  return { state: workspaceReducer(state, { type: 'checklist/record-handoff', handoff }), handoff };
}

describe('validateHandoffDraft', () => {
  it('requires a usage scope and at least one member', () => {
    const errors = validateHandoffDraft({ scope: '  ', members: [] });
    expect(errors.map((error) => error.field).sort()).toEqual(['members', 'scope']);
    expect(validateHandoffDraft(DRAFT)).toEqual([]);
  });

  it('normalizes member lists by trimming and deduplicating', () => {
    expect(normalizeMembers([' Jo ', '', 'jo', 'Mara'])).toEqual(['Jo', 'Mara']);
    expect(parseMemberList('Jo Renner, , Mara Chen,')).toEqual(['Jo Renner', 'Mara Chen']);
  });
});

describe('createChecklistHandoff — first handoff', () => {
  it('captures scope, members, readiness basis, and content summary', () => {
    const seed = createSeedWorkspace();
    const handoff = createChecklistHandoff(seed, 'zone-common', DRAFT, HANDOFF_AT)!;
    const readiness = evaluateReadiness(seed, analyzeJourney(seed.artifacts, seed.zones), HANDOFF_AT);

    expect(handoff.version).toBe(1);
    expect(handoff.zoneId).toBe('zone-common');
    expect(handoff.createdAt).toBe(HANDOFF_AT.toISOString());
    expect(handoff.scope).toBe('Floor install crew');
    expect(handoff.members).toEqual(['Jo Renner', 'Mara Chen']);
    expect(handoff.readinessBasis).toEqual({
      stage: seed.project.stage,
      ready: readiness.ready,
      score: readiness.score,
      blockers: readiness.blockers,
      cautions: readiness.cautions,
      checkedAt: readiness.checkedAt,
    });
    expect(handoff.summary.objectCount).toBe(2);
    expect(handoff.summary.totalDwellMinutes).toBe(15);
    expect(handoff.summary.digest).toBe(currentChecklistDigest(seed, 'zone-common'));
    expect(handoff.checklist.entries.map((entry) => entry.title)).toEqual(['Portable Letterpress', 'Rain Map Quilt']);
  });

  it('returns null for an unknown zone', () => {
    expect(createChecklistHandoff(createSeedWorkspace(), 'zone-nope', DRAFT)).toBeNull();
  });

  it('is in sync with the plan right after recording', () => {
    const { state, handoff } = recordHandoff(createSeedWorkspace(), 'zone-common');
    expect(handoffDrifted(state, handoff)).toBe(false);
    expect(latestHandoff(state.checklistHandoffs, 'zone-common')?.id).toBe(handoff.id);
  });
});

describe('repeated downloads and version history', () => {
  it('serializes a handoff identically every time', () => {
    const { handoff } = recordHandoff(createSeedWorkspace(), 'zone-common');
    expect(serializeHandoffCsv(handoff)).toBe(serializeHandoffCsv(handoff));
  });

  it('matches the fresh export that was current at handoff time', () => {
    const seed = createSeedWorkspace();
    const { handoff } = recordHandoff(seed, 'zone-common');
    const freshAtHandoffTime = serializeZoneChecklistCsv(buildZoneChecklist(seed, 'zone-common', HANDOFF_AT)!);
    expect(serializeHandoffCsv(handoff)).toBe(freshAtHandoffTime);
  });

  it('recording a new version never rewrites earlier handoffs', () => {
    const seed = createSeedWorkspace();
    const first = recordHandoff(seed, 'zone-common');
    const moved = workspaceReducer(first.state, { type: 'placement/reorder', zoneId: 'zone-common', artifactId: 'artifact-press', direction: 1 });
    const second = recordHandoff(moved, 'zone-common', { scope: 'Conservation review', members: ['Rina Solberg'] }, new Date('2026-09-13T10:00:00.000Z'));

    const versions = handoffsForZone(second.state.checklistHandoffs, 'zone-common');
    expect(versions.map((handoff) => handoff.version)).toEqual([2, 1]);
    const restoredFirst = versions[1];
    expect(restoredFirst.version).toBe(1);
    expect(serializeHandoffCsv(restoredFirst)).toBe(serializeHandoffCsv(first.handoff));
    expect(restoredFirst.scope).toBe('Floor install crew');
    expect(serializeHandoffCsv(versions[0])).not.toBe(serializeHandoffCsv(restoredFirst));
  });

  it('versions are tracked independently per zone', () => {
    const seed = createSeedWorkspace();
    const common = recordHandoff(seed, 'zone-common');
    const arrival = recordHandoff(common.state, 'zone-arrival');
    expect(latestHandoff(arrival.state.checklistHandoffs, 'zone-common')?.version).toBe(1);
    expect(latestHandoff(arrival.state.checklistHandoffs, 'zone-arrival')?.version).toBe(1);
  });
});

describe('drift detection', () => {
  it('flags object reordering inside the zone', () => {
    const { state, handoff } = recordHandoff(createSeedWorkspace(), 'zone-common');
    const moved = workspaceReducer(state, { type: 'placement/reorder', zoneId: 'zone-common', artifactId: 'artifact-press', direction: 1 });
    expect(handoffDrifted(moved, handoff)).toBe(true);
    expect(serializeHandoffCsv(handoff)).toBe(serializeHandoffCsv(handoff));
  });

  it('flags objects moved into the zone from another zone', () => {
    const { state, handoff } = recordHandoff(createSeedWorkspace(), 'zone-common');
    const moved = workspaceReducer(state, { type: 'placement/assign', artifactId: 'artifact-lantern', zoneId: 'zone-common' });
    expect(handoffDrifted(moved, handoff)).toBe(true);
  });

  it('flags finding status changes', () => {
    const { state, handoff } = recordHandoff(createSeedWorkspace(), 'zone-arrival');
    const inProgress = workspaceReducer(state, { type: 'issue/transition', issueId: 'issue-entry-copy', status: 'in-progress' });
    expect(handoffDrifted(inProgress, handoff)).toBe(true);
  });

  it('flags resolved findings leaving the checklist', () => {
    const { state, handoff } = recordHandoff(createSeedWorkspace(), 'zone-arrival');
    const inProgress = workspaceReducer(state, { type: 'issue/transition', issueId: 'issue-entry-copy', status: 'in-progress' });
    const resolved = workspaceReducer(inProgress, { type: 'issue/transition', issueId: 'issue-entry-copy', status: 'resolved' });
    expect(handoffDrifted(resolved, handoff)).toBe(true);
  });

  it('stays in sync when an unrelated zone changes', () => {
    const { state, handoff } = recordHandoff(createSeedWorkspace(), 'zone-common');
    const elsewhere = workspaceReducer(state, { type: 'issue/transition', issueId: 'issue-entry-copy', status: 'in-progress' });
    expect(handoffDrifted(elsewhere, handoff)).toBe(false);
  });
});

describe('history restore', () => {
  it('re-downloads the frozen content after the plan has moved on', () => {
    const seed = createSeedWorkspace();
    const { state, handoff } = recordHandoff(seed, 'zone-common');
    const originalCsv = serializeHandoffCsv(handoff);

    const moved = workspaceReducer(state, { type: 'placement/reorder', zoneId: 'zone-common', artifactId: 'artifact-press', direction: 1 });
    const restored = handoffsForZone(moved.checklistHandoffs, 'zone-common')[0];
    expect(restored.id).toBe(handoff.id);
    expect(serializeHandoffCsv(restored)).toBe(originalCsv);
    expect(originalCsv.indexOf('Portable Letterpress')).toBeLessThan(originalCsv.indexOf('Rain Map Quilt'));

    const freshCsv = serializeZoneChecklistCsv(buildZoneChecklist(moved, 'zone-common')!);
    expect(freshCsv.indexOf('Rain Map Quilt')).toBeLessThan(freshCsv.indexOf('Portable Letterpress'));
    expect(handoffFileName(restored)).toBe(handoffFileName(handoff));
  });
});

describe('export validation', () => {
  it('produces a stable digest regardless of generation time', () => {
    const seed = createSeedWorkspace();
    const zone = seed.zones.find((candidate) => candidate.id === 'zone-common')!;
    const conditions = zoneConditions(zone);
    const morning = checklistDigest(buildZoneChecklist(seed, 'zone-common', new Date('2026-09-12T08:00:00.000Z'))!, conditions);
    const evening = checklistDigest(buildZoneChecklist(seed, 'zone-common', new Date('2026-09-12T18:30:00.000Z'))!, conditions);
    expect(morning).toBe(evening);
    expect(morning).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changes the digest when zone conditions change', () => {
    const seed = createSeedWorkspace();
    const checklist = buildZoneChecklist(seed, 'zone-common')!;
    const zone = seed.zones.find((candidate) => candidate.id === 'zone-common')!;
    const base = checklistDigest(checklist, zoneConditions(zone));
    expect(checklistDigest(checklist, { ...zoneConditions(zone), lowLight: false })).not.toBe(base);
    expect(checklistDigest(checklist, { ...zoneConditions(zone), capacityMinutes: 30 })).not.toBe(base);
  });

  it('keeps the legacy current-state file name unchanged', () => {
    const zone = createSeedWorkspace().zones.find((candidate) => candidate.id === 'zone-common')!;
    expect(zoneChecklistFileName(zone, new Date('2026-09-12T12:00:00Z'))).toBe('exhibit-flow-zone-checklist-common-thread-2026-09-12.csv');
  });

  it('builds a versioned, dated handoff file name from the frozen record', () => {
    const seed = createSeedWorkspace();
    const first = recordHandoff(seed, 'zone-common');
    const second = recordHandoff(first.state, 'zone-common', DRAFT, new Date('2026-09-14T09:00:00.000Z'));
    expect(handoffFileName(first.handoff)).toBe('exhibit-flow-zone-checklist-common-thread-v1-2026-09-12.csv');
    expect(handoffFileName(second.handoff)).toBe('exhibit-flow-zone-checklist-common-thread-v2-2026-09-14.csv');
  });

  it('exports handoff CSV with the same layout as a current-state export', () => {
    const { handoff } = recordHandoff(createSeedWorkspace(), 'zone-arrival');
    const csv = serializeHandoffCsv(handoff);
    expect(csv).toContain('Order,Accession ID,Object,Dwell (min),Unresolved findings');
    expect(csv).toContain('Railway Signal Lantern');
    expect(csv).toContain('Reduce entry panel copy');
  });
});
