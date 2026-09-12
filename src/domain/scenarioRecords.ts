import { analyzeJourney } from './journeyAnalysis';
import type {
  Artifact,
  PlanBasis,
  ScenarioInput,
  ScenarioProjection,
  ScenarioRecord,
  ValidationError,
  WorkspaceState,
  Zone,
} from './models';
import { clampScenario, projectScenario } from './scenario';

/**
 * A plan version is a stable fingerprint of the inputs that feed scenario
 * projections: the object set and the sequenced placements. Preferences,
 * review issues and readiness state deliberately do not participate — they
 * never change the projected outcomes, so they must not invalidate records.
 */
export function computePlanVersion(artifacts: Artifact[], zones: Zone[]): string {
  const artifactPart = artifacts
    .map((artifact) => [
      artifact.id,
      artifact.dwellMinutes,
      artifact.accessibilityNeed,
      artifact.isKeyObject ? '1' : '0',
      artifact.narrativeRole,
    ].join(':'))
    .sort()
    .join('|');
  const zonePart = zones
    .map((zone) => [
      zone.id,
      zone.sequence,
      zone.capacityMinutes,
      zone.maxObjects,
      zone.lowLight ? '1' : '0',
      zone.hasSeating ? '1' : '0',
      zone.artifactIds.join(','),
    ].join(':'))
    .sort()
    .join('|');
  return hashString(`v1::${artifactPart}::${zonePart}`);
}

/** Small deterministic FNV-1a hash so plan versions are stable across reloads. */
function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function describePlanBasis(state: WorkspaceState): PlanBasis {
  const analysis = analyzeJourney(state.artifacts, state.zones);
  return {
    artifactCount: state.artifacts.length,
    zoneCount: state.zones.length,
    placedCount: analysis.placedCount,
    totalDwellMinutes: analysis.totalDwellMinutes,
  };
}

export function normalizeScenarioName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** True when a record's basis no longer matches the current plan version. */
export function isRecordStale(record: ScenarioRecord, currentPlanVersion: string): boolean {
  return record.planVersion !== currentPlanVersion;
}

/** Stable signature of the clamped scenario inputs, used to detect exact duplicates. */
export function scenarioInputSignature(input: ScenarioInput): string {
  const clamped = clampScenario(input);
  return `${clamped.pace}:${clamped.groupSize}:${clamped.accessibilityPriority}`;
}

/**
 * Validates a candidate comparison name. Names are required and unique
 * (case-insensitive) across existing records; the record being renamed is
 * excluded via `exceptId`.
 */
export function validateScenarioRecordName(
  rawName: string,
  records: ScenarioRecord[],
  exceptId?: string,
): ValidationError[] {
  const name = normalizeScenarioName(rawName);
  const errors: ValidationError[] = [];
  if (!name) {
    errors.push({ field: 'name', message: 'Name the comparison so it can be found later.' });
  } else if (name.length > 60) {
    errors.push({ field: 'name', message: 'Keep the name to 60 characters or fewer.' });
  }
  const duplicate = records.some(
    (record) => record.id !== exceptId && record.name.toLowerCase() === name.toLowerCase(),
  );
  if (duplicate) errors.push({ field: 'name', message: 'A comparison with this name already exists. Choose another name.' });
  return errors;
}

/**
 * True when an existing record already captures these inputs on this plan
 * version. Records from an older plan version are allowed because the basis
 * has changed and the outcomes may differ.
 */
export function findDuplicateScenarioRecord(
  records: ScenarioRecord[],
  input: ScenarioInput,
  planVersion: string,
): ScenarioRecord | undefined {
  const signature = scenarioInputSignature(input);
  return records.find(
    (record) =>
      record.planVersion === planVersion && scenarioInputSignature(record.input) === signature,
  );
}

export interface CreateScenarioRecordInput {
  name: string;
  input: ScenarioInput;
}

/**
 * Builds an immutable comparison record from the current state and inputs.
 * Validation covers both the name and an exact input/version duplicate, so
 * callers can surface field-level errors before the record is created.
 */
export function createScenarioRecord(
  state: WorkspaceState,
  candidate: CreateScenarioRecordInput,
  createRecordId: () => string,
  now: Date = new Date(),
): { record?: ScenarioRecord; errors: ValidationError[] } {
  const errors = validateScenarioRecordName(candidate.name, state.scenarioRecords);
  const planVersion = computePlanVersion(state.artifacts, state.zones);
  const duplicate = findDuplicateScenarioRecord(state.scenarioRecords, candidate.input, planVersion);
  if (duplicate) {
    errors.push({
      field: 'duplicate',
      message: `These inputs are already saved as “${duplicate.name}” on the current plan version. Open that comparison instead.`,
    });
  }
  if (errors.length) return { errors };
  const analysis = analyzeJourney(state.artifacts, state.zones);
  const input = clampScenario(candidate.input);
  const projection: ScenarioProjection = projectScenario(state, analysis, input);
  return {
    errors: [],
    record: {
      id: createRecordId(),
      name: normalizeScenarioName(candidate.name),
      input,
      planVersion,
      planBasis: describePlanBasis(state),
      projection,
      createdAt: now.toISOString(),
    },
  };
}
