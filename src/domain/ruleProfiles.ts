import type { NarrativeRole } from './models';

/**
 * A review rule profile is an immutable, human-readable archive of the
 * thresholds and gating policy used to evaluate a plan. Every computation
 * (journey analysis, readiness, snapshot, checklist) records the exact
 * profile version it was calculated against so that later rule changes can
 * never silently reinterpret an old plan.
 */

export const ALL_NARRATIVE_ROLES: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];

export interface RuleParameters {
  /** Utilization (planned dwell / zone capacity) at or above which a zone warns. */
  capacityWarnAt: number;
  /** Utilization strictly above which a zone blocks. */
  capacityBlockAt: number;
  /** Occupancy (placed objects / max objects) at or above which a zone warns. */
  densityWarnAt: number;
  /** Occupancy strictly above which a zone blocks. */
  densityBlockAt: number;
  /** Low-light sensitive objects must land in a low-light zone. */
  enforceLowLight: boolean;
  /** Objects requiring seated interpretation must land in a zone with seating. */
  enforceSeating: boolean;
  /** How the seating rule surfaces when violated. */
  seatingSeverity: 'error' | 'warning';
  /** Narrative roles that must appear before readiness. */
  requiredRoles: NarrativeRole[];
  /** Missing role that blocks; other required roles only warn. */
  blockingRole: NarrativeRole;
  /** Every key object must be placed before readiness. */
  requireKeyObjectsPlaced: boolean;
  /** Unresolved critical review findings block readiness. */
  criticalFindingsBlock: boolean;
  /** Score deduction applied per readiness blocker. */
  blockerScorePenalty: number;
  /** Score deduction applied per readiness caution. */
  cautionScorePenalty: number;
}

export interface RuleProfile {
  /** Stable identity of the rule line a project follows; versions branch off it. */
  profileId: string;
  /** Monotonic, strictly increasing version inside a profile line. */
  version: number;
  name: string;
  changeSummary: string;
  parameters: RuleParameters;
  createdAt: string;
  /** Origin marks how the profile entered the workspace. */
  origin: 'builtin' | 'published';
}

export interface RuleBinding {
  profileId: string;
  version: number;
  /** Set once a user explicitly accepts a newer version; older plans keep theirs. */
  boundAt: string;
}

export type RuleResolutionStatus = 'resolved' | 'binding-missing' | 'profile-unknown' | 'profile-corrupt';

export interface RuleResolution {
  status: RuleResolutionStatus;
  profile?: RuleProfile;
  /** Human-readable explanation used when no profile can be resolved. */
  reason: string;
}

export const STANDARD_PROFILE_ID = 'standard-review-rules';
export const RULE_ARCHIVE_KIND = 'exhibit-flow-rule-archive';

export const STANDARD_RULE_PARAMETERS: RuleParameters = {
  capacityWarnAt: 0.8,
  capacityBlockAt: 1,
  densityWarnAt: 0.8,
  densityBlockAt: 1,
  enforceLowLight: true,
  enforceSeating: true,
  seatingSeverity: 'warning',
  requiredRoles: [...ALL_NARRATIVE_ROLES],
  blockingRole: 'turning-point',
  requireKeyObjectsPlaced: true,
  criticalFindingsBlock: true,
  blockerScorePenalty: 18,
  cautionScorePenalty: 6,
};

export function standardRuleProfile(at = new Date()): RuleProfile {
  return {
    profileId: STANDARD_PROFILE_ID,
    version: 1,
    name: 'Standard gallery review rules',
    changeSummary: 'Initial rule line: 80% capacity warning, 100% block; low-light and seating checks; full narrative arc required.',
    parameters: {
      ...STANDARD_RULE_PARAMETERS,
      requiredRoles: [...STANDARD_RULE_PARAMETERS.requiredRoles],
    },
    createdAt: at.toISOString(),
    origin: 'builtin',
  };
}

export function profileKey(profileId: string, version: number): string {
  return `${profileId}#${version}`;
}

export function profileLabel(profile: Pick<RuleProfile, 'profileId' | 'version' | 'name'>): string {
  return `${profile.name} · v${profile.version}`;
}

export function bindingKey(binding: { profileId: string; version: number }): string {
  return profileKey(binding.profileId, binding.version);
}

export function findProfile(profiles: RuleProfile[], profileId: string, version: number): RuleProfile | undefined {
  return profiles.find((profile) => profile.profileId === profileId && profile.version === version);
}

/**
 * Resolve the archive version a project is bound to. A missing or unknown
 * binding is an explicit failure state: callers must never fall back to a
 * default profile and compute silently.
 */
export function resolveRuleProfile(state: {
  ruleProfiles?: RuleProfile[];
  project?: { ruleBinding?: RuleBinding };
}): RuleResolution {
  const binding = state.project?.ruleBinding;
  if (!binding || typeof binding.profileId !== 'string' || typeof binding.version !== 'number') {
    return { status: 'binding-missing', reason: 'This project has no review rule archive version bound to it.' };
  }
  const profiles = state.ruleProfiles ?? [];
  const line = profiles.filter((profile) => profile.profileId === binding.profileId);
  if (line.length === 0) {
    return {
      status: 'profile-unknown',
      reason: `Bound rule archive "${binding.profileId}" is not present in this workspace.`,
    };
  }
  const profile = findProfile(profiles, binding.profileId, binding.version);
  if (!profile) {
    return {
      status: 'profile-unknown',
      reason: `Rule archive ${bindingKey(binding)} is missing. Only versions present here are: ${line
        .map((candidate) => candidate.version)
        .sort((a, b) => a - b)
        .join(', ')}.`,
    };
  }
  if (!isValidRuleParameters(profile.parameters)) {
    return { status: 'profile-corrupt', reason: `Rule archive ${bindingKey(binding)} holds invalid thresholds.` };
  }
  return { status: 'resolved', profile, reason: '' };
}

export function isRuleProfile(value: unknown): value is RuleProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RuleProfile>;
  return typeof candidate.profileId === 'string'
    && candidate.profileId.length > 0
    && typeof candidate.version === 'number'
    && Number.isFinite(candidate.version)
    && candidate.version >= 1
    && typeof candidate.name === 'string'
    && candidate.name.trim().length > 0
    && typeof candidate.changeSummary === 'string'
    && typeof candidate.createdAt === 'string'
    && (candidate.origin === 'builtin' || candidate.origin === 'published')
    && isValidRuleParameters((candidate as RuleProfile).parameters);
}

export function isValidRuleParameters(parameters: unknown): parameters is RuleParameters {
  if (!parameters || typeof parameters !== 'object') return false;
  const candidate = parameters as Partial<RuleParameters>;
  const ratio = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
  const capacityWarn = candidate.capacityWarnAt;
  const capacityBlock = candidate.capacityBlockAt;
  if (!ratio(capacityWarn) || !ratio(capacityBlock)) return false;
  if (capacityWarn > capacityBlock) return false;
  const densityWarn = candidate.densityWarnAt;
  const densityBlock = candidate.densityBlockAt;
  if (!ratio(densityWarn) || !ratio(densityBlock)) return false;
  if (densityWarn > densityBlock) return false;
  if (typeof candidate.enforceLowLight !== 'boolean' || typeof candidate.enforceSeating !== 'boolean') return false;
  if (candidate.seatingSeverity !== 'error' && candidate.seatingSeverity !== 'warning') return false;
  if (!Array.isArray(candidate.requiredRoles)) return false;
  const roles = candidate.requiredRoles as unknown[];
  if (!roles.every((role) => ALL_NARRATIVE_ROLES.includes(role as NarrativeRole))) return false;
  if (new Set(roles).size !== roles.length) return false;
  if (!ALL_NARRATIVE_ROLES.includes(candidate.blockingRole as NarrativeRole)) return false;
  if (typeof candidate.requireKeyObjectsPlaced !== 'boolean') return false;
  if (typeof candidate.criticalFindingsBlock !== 'boolean') return false;
  const penalty = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
  return penalty(candidate.blockerScorePenalty) && penalty(candidate.cautionScorePenalty);
}

export function nextVersionNumber(profiles: RuleProfile[], profileId: string): number {
  return profiles.reduce((max, profile) => (profile.profileId === profileId ? Math.max(max, profile.version) : max), 0) + 1;
}

export function draftNextVersion(
  profiles: RuleProfile[],
  basis: RuleProfile,
  patch: { parameters: RuleParameters; name?: string; changeSummary: string },
  at = new Date(),
): RuleProfile {
  return {
    profileId: basis.profileId,
    version: nextVersionNumber(profiles, basis.profileId),
    name: patch.name?.trim() || basis.name,
    changeSummary: patch.changeSummary.trim() || 'No change summary provided.',
    parameters: cloneParameters(patch.parameters),
    createdAt: at.toISOString(),
    origin: 'published',
  };
}

export function cloneParameters(parameters: RuleParameters): RuleParameters {
  return { ...parameters, requiredRoles: [...parameters.requiredRoles] };
}

export type RuleChangeKind = 'added' | 'removed' | 'changed';

export interface RuleChange {
  key: keyof RuleParameters;
  label: string;
  kind: RuleChangeKind;
  from: string;
  to: string;
}

function describeBoolean(value: boolean): string {
  return value ? 'Enabled' : 'Disabled';
}

function describeRoles(roles: NarrativeRole[]): string {
  return roles.length ? roles.map((role) => role.replace('-', ' ')).join(', ') : 'None required';
}

function describePercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const PARAMETER_LABELS: Array<{ key: keyof RuleParameters; label: string; describe: (value: RuleParameters[keyof RuleParameters]) => string }> = [
  { key: 'capacityWarnAt', label: 'Capacity warning line', describe: (value) => describePercent(value as number) },
  { key: 'capacityBlockAt', label: 'Capacity block line', describe: (value) => describePercent(value as number) },
  { key: 'densityWarnAt', label: 'Density warning line', describe: (value) => describePercent(value as number) },
  { key: 'densityBlockAt', label: 'Density block line', describe: (value) => describePercent(value as number) },
  { key: 'enforceLowLight', label: 'Low-light placement enforcement', describe: (value) => describeBoolean(value as boolean) },
  { key: 'enforceSeating', label: 'Seated interpretation enforcement', describe: (value) => describeBoolean(value as boolean) },
  { key: 'seatingSeverity', label: 'Seating violation level', describe: (value) => (value === 'error' ? 'Blocking error' : 'Warning') },
  { key: 'requiredRoles', label: 'Required narrative roles', describe: (value) => describeRoles(value as NarrativeRole[]) },
  { key: 'blockingRole', label: 'Blocking narrative role', describe: (value) => String(value).replace('-', ' ') },
  { key: 'requireKeyObjectsPlaced', label: 'Key objects must be placed', describe: (value) => describeBoolean(value as boolean) },
  { key: 'criticalFindingsBlock', label: 'Critical findings block readiness', describe: (value) => describeBoolean(value as boolean) },
  { key: 'blockerScorePenalty', label: 'Score penalty per blocker', describe: (value) => `${value} points` },
  { key: 'cautionScorePenalty', label: 'Score penalty per caution', describe: (value) => `${value} points` },
];

export function describeRuleParameter(key: keyof RuleParameters, value: RuleParameters[keyof RuleParameters]): string {
  return PARAMETER_LABELS.find((item) => item.key === key)?.describe(value) ?? String(value);
}

export function ruleParameterLabel(key: keyof RuleParameters): string {
  return PARAMETER_LABELS.find((item) => item.key === key)?.label ?? key;
}

export function diffRuleParameters(from: RuleParameters, to: RuleParameters): RuleChange[] {
  const changes: RuleChange[] = [];
  for (const { key, label, describe } of PARAMETER_LABELS) {
    const before = from[key];
    const after = to[key];
    if (Array.isArray(before) || Array.isArray(after)) {
      const beforeRoles = Array.isArray(before) ? (before as NarrativeRole[]) : [];
      const afterRoles = Array.isArray(after) ? (after as NarrativeRole[]) : [];
      const beforeText = describeRoles(beforeRoles);
      const afterText = describeRoles(afterRoles);
      if (beforeText !== afterText) {
        changes.push({ key, label, kind: 'changed', from: beforeText, to: afterText });
      }
      continue;
    }
    if (before !== after) {
      changes.push({
        key,
        label,
        kind: 'changed',
        from: describe(before),
        to: describe(after),
      });
    }
  }
  return changes;
}

export interface RuleStatement {
  label: string;
  value: string;
}

/** Readable explanation of a profile version, suitable for display and export. */
export function explainRuleProfile(profile: RuleProfile): RuleStatement[] {
  const parameters = profile.parameters;
  return [
    { label: 'Capacity warning line', value: describePercent(parameters.capacityWarnAt) },
    { label: 'Capacity block line', value: describePercent(parameters.capacityBlockAt) },
    { label: 'Density warning line', value: describePercent(parameters.densityWarnAt) },
    { label: 'Density block line', value: describePercent(parameters.densityBlockAt) },
    {
      label: 'Low-light objects',
      value: parameters.enforceLowLight ? 'Must be placed in a low-light zone' : 'Placement is not enforced',
    },
    {
      label: 'Seated interpretation',
      value: parameters.enforceSeating
        ? `Must be placed in a seated zone (${parameters.seatingSeverity === 'error' ? 'blocking' : 'warning'} level)`
        : 'Placement is not enforced',
    },
    { label: 'Required narrative roles', value: describeRoles(parameters.requiredRoles) },
    { label: 'Blocking narrative role', value: parameters.blockingRole.replace('-', ' ') },
    {
      label: 'Key objects',
      value: parameters.requireKeyObjectsPlaced ? 'Every key object must be placed' : 'Key objects are advisory',
    },
    {
      label: 'Critical review findings',
      value: parameters.criticalFindingsBlock ? 'Block readiness until resolved' : 'Do not block readiness',
    },
    { label: 'Score penalty per blocker', value: `${parameters.blockerScorePenalty} points` },
    { label: 'Score penalty per caution', value: `${parameters.cautionScorePenalty} points` },
  ];
}
