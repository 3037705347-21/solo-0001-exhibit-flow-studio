import { createId } from './ids';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import { buildZoneChecklist, serializeZoneChecklistCsv, zoneLabelSlug } from './zoneChecklist';
import type { ChecklistHandoff, ValidationError, WorkspaceState, Zone, ZoneChecklist } from './models';

export interface HandoffDraft {
  scope: string;
  members: string[];
}

export interface ZoneConditions {
  capacityMinutes: number;
  maxObjects: number;
  lowLight: boolean;
  hasSeating: boolean;
}

export function zoneConditions(zone: Zone): ZoneConditions {
  return {
    capacityMinutes: zone.capacityMinutes,
    maxObjects: zone.maxObjects,
    lowLight: zone.lowLight,
    hasSeating: zone.hasSeating,
  };
}

export function normalizeMembers(members: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const member of members) {
    const name = member.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    normalized.push(name);
  }
  return normalized;
}

export function parseMemberList(raw: string): string[] {
  return normalizeMembers(raw.split(','));
}

export function validateHandoffDraft(draft: HandoffDraft): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!draft.scope.trim()) errors.push({ field: 'scope', message: 'Describe where this checklist will be used.' });
  if (normalizeMembers(draft.members).length === 0) errors.push({ field: 'members', message: 'List at least one team member.' });
  return errors;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable fingerprint of everything a printed checklist depends on, excluding
 * the generation timestamp. Zone conditions are folded in so environmental
 * changes (capacity, lighting, seating) also mark a handoff as drifted.
 */
export function checklistDigest(checklist: ZoneChecklist, conditions?: ZoneConditions): string {
  const findingKey = (finding: ZoneChecklist['zoneFindings'][number]) =>
    [finding.severity, finding.status, finding.title, finding.owner, finding.scope];
  const basis = {
    zone: [checklist.zoneId, checklist.zoneName, checklist.zoneShortLabel, checklist.thesis],
    project: [checklist.projectTitle, checklist.venue],
    conditions: conditions ?? null,
    zoneFindings: checklist.zoneFindings.map(findingKey),
    entries: checklist.entries.map((entry) => [
      entry.sequence,
      entry.artifactId,
      entry.accessionId,
      entry.title,
      entry.dwellMinutes,
      entry.unresolvedFindings.map(findingKey),
    ]),
  };
  return fnv1a(JSON.stringify(basis));
}

export function currentChecklistDigest(state: WorkspaceState, zoneId: string): string | null {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) return null;
  const checklist = buildZoneChecklist(state, zoneId);
  if (!checklist) return null;
  return checklistDigest(checklist, zoneConditions(zone));
}

export function handoffDrifted(state: WorkspaceState, handoff: ChecklistHandoff): boolean {
  const digest = currentChecklistDigest(state, handoff.zoneId);
  return digest === null || digest !== handoff.summary.digest;
}

export function handoffsForZone(handoffs: ChecklistHandoff[], zoneId: string): ChecklistHandoff[] {
  return handoffs
    .filter((handoff) => handoff.zoneId === zoneId)
    .sort((left, right) => right.version - left.version);
}

export function latestHandoff(handoffs: ChecklistHandoff[], zoneId: string): ChecklistHandoff | undefined {
  return handoffsForZone(handoffs, zoneId)[0];
}

/**
 * Freezes the current zone checklist as an immutable handoff version. The
 * readiness basis and content summary are captured at creation; the stored
 * checklist is never mutated afterwards, so re-downloads stay byte-identical.
 */
export function createChecklistHandoff(
  state: WorkspaceState,
  zoneId: string,
  draft: HandoffDraft,
  at = new Date(),
): ChecklistHandoff | null {
  const zone = state.zones.find((candidate) => candidate.id === zoneId);
  if (!zone) return null;
  const checklist = buildZoneChecklist(state, zoneId, at);
  if (!checklist) return null;
  const readiness = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones), at);
  const version = state.checklistHandoffs
    .filter((handoff) => handoff.zoneId === zoneId)
    .reduce((max, handoff) => Math.max(max, handoff.version), 0) + 1;
  return {
    id: createId('handoff'),
    zoneId,
    version,
    createdAt: at.toISOString(),
    scope: draft.scope.trim(),
    members: normalizeMembers(draft.members),
    readinessBasis: {
      stage: state.project.stage,
      ready: readiness.ready,
      score: readiness.score,
      blockers: readiness.blockers,
      cautions: readiness.cautions,
      checkedAt: readiness.checkedAt,
    },
    summary: {
      objectCount: checklist.objectCount,
      totalDwellMinutes: checklist.totalDwellMinutes,
      unresolvedCount: checklist.unresolvedCount,
      digest: checklistDigest(checklist, zoneConditions(zone)),
    },
    checklist,
  };
}

export function serializeHandoffCsv(handoff: ChecklistHandoff): string {
  return serializeZoneChecklistCsv(handoff.checklist);
}

export function handoffFileName(handoff: ChecklistHandoff): string {
  const slug = zoneLabelSlug(handoff.checklist.zoneShortLabel || handoff.checklist.zoneName);
  return `exhibit-flow-zone-checklist-${slug}-v${handoff.version}-${handoff.createdAt.slice(0, 10)}.csv`;
}
