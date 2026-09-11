import { artifactFromDraft, validateArtifactDraft } from './artifactValidation';
import { createId } from './ids';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import type {
  Artifact,
  ArtifactDraft,
  ConstraintFinding,
  JourneyAnalysis,
  NarrativeRole,
  ReadinessResult,
  WorkspaceState,
  Zone,
} from './models';

// ---------------------------------------------------------------------------
// Sandbox change model
// ---------------------------------------------------------------------------

export interface MoveSandboxChange {
  id: string;
  kind: 'move';
  artifactId: string;
  targetZoneId: string;
}

export interface AddArtifactSandboxChange {
  id: string;
  kind: 'add';
  draft: ArtifactDraft;
  /** When omitted the trial object stays in the unplaced queue. */
  targetZoneId?: string;
}

export interface ZoneRulePatch {
  capacityMinutes?: number;
  maxObjects?: number;
  lowLight?: boolean;
  hasSeating?: boolean;
}

export interface ZoneRuleSandboxChange {
  id: string;
  kind: 'zone-rule';
  zoneId: string;
  patch: ZoneRulePatch;
}

export type SandboxChange = MoveSandboxChange | AddArtifactSandboxChange | ZoneRuleSandboxChange;

export type SandboxFailureCode =
  | 'unknown-artifact'
  | 'unknown-zone'
  | 'invalid-artifact'
  | 'duplicate-accession'
  | 'invalid-zone-rule';

export interface SandboxChangeResult {
  changeId: string;
  status: 'ok' | 'failed';
  code?: SandboxFailureCode;
  message?: string;
}

export interface SandboxConflict {
  changeId?: string;
  kind: 'light' | 'capacity' | 'density' | 'unplaced-key' | 'missing-role' | 'other';
  title: string;
  detail: string;
  zoneId?: string;
  artifactId?: string;
}

export interface MetricDelta {
  base: number;
  trial: number;
}

export interface SandboxZoneDiff {
  zoneId: string;
  rulesChanged: boolean;
  objectCount: MetricDelta;
  dwellMinutes: MetricDelta;
  capacityMinutes: MetricDelta;
  maxObjects: MetricDelta;
  utilization: MetricDelta;
  objectUtilization: MetricDelta;
  keyAdded: Artifact[];
  keyRemoved: Artifact[];
  rolesAdded: NarrativeRole[];
  rolesRemoved: NarrativeRole[];
  lowLightChanged: boolean;
  hasSeatingChanged: boolean;
  newFindings: ConstraintFinding[];
  resolvedFindings: ConstraintFinding[];
}

export interface SandboxEvaluation {
  baseAnalysis: JourneyAnalysis;
  trialAnalysis: JourneyAnalysis;
  baseReadiness: ReadinessResult;
  trialReadiness: ReadinessResult;
  changeResults: SandboxChangeResult[];
  conflicts: SandboxConflict[];
  zoneDiffs: SandboxZoneDiff[];
  addedArtifacts: Artifact[];
  unplacedAdded: Artifact[];
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Plan versioning (optimistic concurrency)
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Content version of the plan. Preferences and local bookkeeping timestamps are
 * excluded: a sandbox only contends over project, collection, zone, and review
 * finding content.
 */
export function planFingerprint(
  state: Pick<WorkspaceState, 'project' | 'artifacts' | 'zones' | 'issues'>,
): string {
  return `plan-${fnv1aHex(stableStringify({
    project: state.project,
    artifacts: state.artifacts,
    zones: state.zones,
    issues: state.issues,
  }))}`;
}

// ---------------------------------------------------------------------------
// Trial plan construction
// ---------------------------------------------------------------------------

const MIN_CAPACITY_MINUTES = 1;
const MAX_CAPACITY_MINUTES = 600;
const MIN_OBJECT_LIMIT = 1;
const MAX_OBJECT_LIMIT = 50;

function asPositiveInt(value: number | undefined, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

interface EffectivePlan {
  artifacts: Artifact[];
  zones: Zone[];
  addedById: Map<string, Artifact>;
  changeResults: SandboxChangeResult[];
}

function buildEffectivePlan(
  base: WorkspaceState,
  changes: SandboxChange[],
  idForAdd: (changeId: string) => string,
): EffectivePlan {
  const result: SandboxChangeResult[] = [];
  const addedById = new Map<string, Artifact>();
  const effectiveArtifacts: Artifact[] = [...base.artifacts];
  const effectiveZones: Zone[] = base.zones.map((zone) => ({ ...zone, artifactIds: [...zone.artifactIds] }));
  const zoneById = new Map(effectiveZones.map((zone) => [zone.id, zone]));
  const baseArtifactIds = new Set(base.artifacts.map((artifact) => artifact.id));

  const recordOk = (changeId: string) => result.push({ changeId, status: 'ok' });

  for (const change of changes) {
    if (change.kind === 'add') {
      const siblingArtifacts = [...base.artifacts, ...addedById.values()];
      const errors = validateArtifactDraft(change.draft, siblingArtifacts);
      if (errors.length > 0) {
        const duplicate = errors.some((error) => error.field === 'accessionId');
        result.push({
          changeId: change.id,
          status: 'failed',
          code: duplicate ? 'duplicate-accession' : 'invalid-artifact',
          message: errors[0].message,
        });
        continue;
      }
      const artifact = artifactFromDraft(change.draft);
      artifact.id = idForAdd(change.id);
      addedById.set(change.id, artifact);
      effectiveArtifacts.push(artifact);
      if (change.targetZoneId) {
        const target = zoneById.get(change.targetZoneId);
        if (target) target.artifactIds.push(artifact.id);
      }
      recordOk(change.id);
      continue;
    }

    if (change.kind === 'move') {
      const artifactExists = baseArtifactIds.has(change.artifactId) || addedById.has(change.artifactId);
      const target = zoneById.get(change.targetZoneId);
      if (!artifactExists) {
        result.push({ changeId: change.id, status: 'failed', code: 'unknown-artifact', message: 'The object to move is no longer in the plan.' });
        continue;
      }
      if (!target) {
        result.push({ changeId: change.id, status: 'failed', code: 'unknown-zone', message: 'The target exhibition zone no longer exists.' });
        continue;
      }
      for (const zone of effectiveZones) zone.artifactIds = zone.artifactIds.filter((id) => id !== change.artifactId);
      if (!target.artifactIds.includes(change.artifactId)) target.artifactIds.push(change.artifactId);
      recordOk(change.id);
      continue;
    }

    const zone = zoneById.get(change.zoneId);
    if (!zone) {
      result.push({ changeId: change.id, status: 'failed', code: 'unknown-zone', message: 'The zone to adjust no longer exists.' });
      continue;
    }
    const { capacityMinutes, maxObjects, lowLight, hasSeating } = change.patch;
    if (capacityMinutes !== undefined && !asPositiveInt(capacityMinutes, MIN_CAPACITY_MINUTES, MAX_CAPACITY_MINUTES)) {
      result.push({ changeId: change.id, status: 'failed', code: 'invalid-zone-rule', message: `${zone.name} capacity must be a whole number between ${MIN_CAPACITY_MINUTES} and ${MAX_CAPACITY_MINUTES} minutes.` });
      continue;
    }
    if (maxObjects !== undefined && !asPositiveInt(maxObjects, MIN_OBJECT_LIMIT, MAX_OBJECT_LIMIT)) {
      result.push({ changeId: change.id, status: 'failed', code: 'invalid-zone-rule', message: `${zone.name} object limit must be a whole number between ${MIN_OBJECT_LIMIT} and ${MAX_OBJECT_LIMIT}.` });
      continue;
    }
    if (capacityMinutes !== undefined) zone.capacityMinutes = capacityMinutes;
    if (maxObjects !== undefined) zone.maxObjects = maxObjects;
    if (typeof lowLight === 'boolean') zone.lowLight = lowLight;
    if (typeof hasSeating === 'boolean') zone.hasSeating = hasSeating;
    recordOk(change.id);
  }

  return { artifacts: effectiveArtifacts, zones: effectiveZones, addedById, changeResults: result };
}

// ---------------------------------------------------------------------------
// Diffing and conflict attribution
// ---------------------------------------------------------------------------

function placedArtifacts(zone: Zone, artifacts: Artifact[]): Artifact[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return zone.artifactIds.map((id) => byId.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
}

function findingsByZone(analysis: JourneyAnalysis): Map<string, ConstraintFinding[]> {
  const map = new Map<string, ConstraintFinding[]>();
  for (const zone of analysis.zones) map.set(zone.zoneId, zone.findings);
  return map;
}

function attributeConflict(
  finding: ConstraintFinding,
  changes: SandboxChange[],
  addedById: Map<string, Artifact>,
  baseZones: Zone[],
): SandboxConflict {
  const kind: SandboxConflict['kind'] = finding.id.startsWith('light-')
    ? 'light'
    : finding.id.startsWith('capacity-')
      ? 'capacity'
      : finding.id.startsWith('density-')
        ? 'density'
        : finding.id.startsWith('unplaced-key-')
          ? 'unplaced-key'
          : finding.id.startsWith('missing-role-')
            ? 'missing-role'
            : 'other';

  let change: SandboxChange | undefined;
  if (finding.artifactId) {
    const addChange = changes.find((candidate) => candidate.kind === 'add' && addedById.get(candidate.id)?.id === finding.artifactId);
    if (addChange) {
      change = addChange;
    } else {
      const moveChange = [...changes].reverse().find((candidate) => candidate.kind === 'move' && candidate.artifactId === finding.artifactId);
      if (moveChange) change = moveChange;
    }
  }
  if (!change && finding.zoneId) {
    change = changes.find((candidate) => candidate.kind === 'zone-rule' && candidate.zoneId === finding.zoneId);
  }
  if (!change && finding.zoneId) {
    change = [...changes].reverse().find((candidate) =>
      (candidate.kind === 'move' && candidate.targetZoneId === finding.zoneId)
      || (candidate.kind === 'add' && candidate.targetZoneId === finding.zoneId),
    );
  }
  // A light conflict introduced by switching low light off belongs to the rule change.
  if (!change && kind === 'light' && finding.zoneId) {
    const baseZone = baseZones.find((zone) => zone.id === finding.zoneId);
    if (baseZone?.lowLight) {
      change = changes.find(
        (candidate) => candidate.kind === 'zone-rule' && candidate.zoneId === finding.zoneId && candidate.patch.lowLight === false,
      );
    }
  }

  return {
    changeId: change?.id,
    kind,
    title: finding.title,
    detail: finding.detail,
    zoneId: finding.zoneId,
    artifactId: finding.artifactId,
  };
}

function buildZoneDiffs(
  base: WorkspaceState,
  plan: EffectivePlan,
  baseAnalysis: JourneyAnalysis,
  trialAnalysis: JourneyAnalysis,
  changes: SandboxChange[],
): SandboxZoneDiff[] {
  const baseZoneById = new Map(base.zones.map((zone) => [zone.id, zone]));
  const baseZoneAnalysis = new Map(baseAnalysis.zones.map((zone) => [zone.zoneId, zone]));
  const trialZoneAnalysis = new Map(trialAnalysis.zones.map((zone) => [zone.zoneId, zone]));
  const baseFindings = findingsByZone(baseAnalysis);
  const trialFindings = findingsByZone(trialAnalysis);

  return [...plan.zones]
    .sort((left, right) => left.sequence - right.sequence)
    .map((trialZone) => {
      const zoneId = trialZone.id;
      const baseZone = baseZoneById.get(zoneId);
      const baseAnalysisForZone = baseZoneAnalysis.get(zoneId);
      const trialAnalysisForZone = trialZoneAnalysis.get(zoneId)!;
      const before = baseZone ? placedArtifacts(baseZone, base.artifacts) : [];
      const after = placedArtifacts(trialZone, plan.artifacts);
      const beforeById = new Map(before.map((artifact) => [artifact.id, artifact]));
      const afterById = new Map(after.map((artifact) => [artifact.id, artifact]));
      const baseFindingIds = new Set((baseFindings.get(zoneId) ?? []).map((finding) => finding.id));
      const trialFindingIds = new Set((trialFindings.get(zoneId) ?? []).map((finding) => finding.id));
      const ruleChange = changes.find((change) => change.kind === 'zone-rule' && change.zoneId === zoneId);

      const rolesBefore = new Set(before.map((artifact) => artifact.narrativeRole));
      const rolesAfter = new Set(after.map((artifact) => artifact.narrativeRole));

      return {
        zoneId,
        rulesChanged: Boolean(ruleChange),
        objectCount: { base: before.length, trial: after.length },
        dwellMinutes: {
          base: baseAnalysisForZone?.dwellMinutes ?? 0,
          trial: trialAnalysisForZone.dwellMinutes,
        },
        capacityMinutes: {
          base: baseZone?.capacityMinutes ?? trialZone.capacityMinutes,
          trial: trialZone.capacityMinutes,
        },
        maxObjects: {
          base: baseZone?.maxObjects ?? trialZone.maxObjects,
          trial: trialZone.maxObjects,
        },
        utilization: {
          base: baseAnalysisForZone?.utilization ?? 0,
          trial: trialAnalysisForZone.utilization,
        },
        objectUtilization: {
          base: baseAnalysisForZone?.objectUtilization ?? 0,
          trial: trialAnalysisForZone.objectUtilization,
        },
        keyAdded: after.filter((artifact) => artifact.isKeyObject && !beforeById.has(artifact.id)),
        keyRemoved: before.filter((artifact) => artifact.isKeyObject && !afterById.has(artifact.id)),
        rolesAdded: Array.from(rolesAfter).filter((role) => !rolesBefore.has(role)),
        rolesRemoved: Array.from(rolesBefore).filter((role) => !rolesAfter.has(role)),
        lowLightChanged: baseZone ? baseZone.lowLight !== trialZone.lowLight : false,
        hasSeatingChanged: baseZone ? baseZone.hasSeating !== trialZone.hasSeating : false,
        newFindings: (trialFindings.get(zoneId) ?? []).filter((finding) => !baseFindingIds.has(finding.id)),
        resolvedFindings: (baseFindings.get(zoneId) ?? []).filter((finding) => !trialFindingIds.has(finding.id)),
      };
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function evaluateCapacitySandbox(base: WorkspaceState, changes: SandboxChange[]): SandboxEvaluation {
  const provisional = buildEffectivePlan(base, changes, (changeId) => changeId);
  const baseAnalysis = analyzeJourney(base.artifacts, base.zones);
  const trialAnalysis = analyzeJourney(provisional.artifacts, provisional.zones);
  const baseReadiness = evaluateReadiness(base, baseAnalysis);
  const trialReadiness = evaluateReadiness({ ...base, artifacts: provisional.artifacts, zones: provisional.zones }, trialAnalysis);

  const baseErrorIds = new Set(baseAnalysis.findings.filter((finding) => finding.type === 'error').map((finding) => finding.id));
  const newErrors = trialAnalysis.findings.filter((finding) => finding.type === 'error' && !baseErrorIds.has(finding.id));
  const conflicts = newErrors.map((finding) => attributeConflict(finding, changes, provisional.addedById, base.zones));

  const addedArtifacts = Array.from(provisional.addedById.values());
  const placedIds = new Set(provisional.zones.flatMap((zone) => zone.artifactIds));
  const unplacedAdded = addedArtifacts.filter((artifact) => !placedIds.has(artifact.id));
  const failedChanges = provisional.changeResults.filter((result) => result.status === 'failed');

  return {
    baseAnalysis,
    trialAnalysis,
    baseReadiness,
    trialReadiness,
    changeResults: provisional.changeResults,
    conflicts,
    zoneDiffs: buildZoneDiffs(base, provisional, baseAnalysis, trialAnalysis, changes),
    addedArtifacts,
    unplacedAdded,
    blocked: failedChanges.length > 0 || conflicts.length > 0,
  };
}

export type SandboxCommitResult =
  | { outcome: 'applied'; state: WorkspaceState }
  | { outcome: 'version-conflict'; expectedVersion: string; currentVersion: string }
  | {
      outcome: 'invalid-operation';
      conflicts: SandboxConflict[];
      failures: SandboxChangeResult[];
    };

/**
 * Applies the whole sandbox batch against the live plan. The batch is only
 * committed when (1) the live plan version still matches the version captured
 * when the sandbox started and (2) every staged operation is valid. Otherwise
 * nothing changes.
 */
export function commitCapacitySandbox(
  live: WorkspaceState,
  changes: SandboxChange[],
  expectedVersion: string,
): SandboxCommitResult {
  const currentVersion = planFingerprint(live);
  if (currentVersion !== expectedVersion) {
    return { outcome: 'version-conflict', expectedVersion, currentVersion };
  }
  const evaluation = evaluateCapacitySandbox(live, changes);
  if (evaluation.blocked) {
    return {
      outcome: 'invalid-operation',
      conflicts: evaluation.conflicts,
      failures: evaluation.changeResults.filter((result) => result.status === 'failed'),
    };
  }

  const issuedIds = new Set(live.artifacts.map((artifact) => artifact.id));
  const plan = buildEffectivePlan(live, changes, () => {
    let nextId = createId('artifact');
    while (issuedIds.has(nextId)) nextId = createId('artifact');
    issuedIds.add(nextId);
    return nextId;
  });

  return {
    outcome: 'applied',
    state: { ...live, artifacts: plan.artifacts, zones: plan.zones },
  };
}
