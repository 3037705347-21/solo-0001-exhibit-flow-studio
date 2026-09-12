import type { RuleProfile, WorkspaceState } from '../domain/models';
import { isRuleProfile, standardRuleProfile } from '../domain/ruleProfiles';

interface LegacyZone {
  id: string;
  name: string;
  shortLabel: string;
  thesis: string;
  capacityMinutes: number;
  maxObjects: number;
  lowLight: boolean;
  hasSeating: boolean;
  color: string;
  sequence?: number;
  artifactIds: string[];
}

interface LegacyWorkspace {
  version?: number;
  project?: WorkspaceState['project'];
  artifacts?: WorkspaceState['artifacts'];
  zones?: LegacyZone[];
  issues?: WorkspaceState['issues'];
  preferences?: WorkspaceState['preferences'];
  ruleProfiles?: RuleProfile[];
  readinessRuns?: WorkspaceState['readinessRuns'];
  lastSavedAt?: string;
}

/**
 * Migrate a persisted workspace. v1 workspaces predate the versioned rule
 * archive: they are pinned to standard rules v1 explicitly so their results
 * keep the same interpretation they had when saved. Workspaces that name an
 * unknown archive version are migrated structurally but remain unbound —
 * loadWorkspace reports that rather than substituting defaults.
 */
export function migrateWorkspace(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as LegacyWorkspace;
  if (!source.project || !source.artifacts || !source.zones || !source.issues || !source.preferences) return null;
  const zones = source.zones.map((zone, index) => ({
    ...zone,
    sequence: typeof zone.sequence === 'number' ? zone.sequence : index,
  }));

  const ruleProfiles = sanitizeProfiles(source.ruleProfiles);
  const sourceVersion = (value as { version?: number }).version;
  const hasBinding = Boolean(source.project.ruleBinding);
  const project = { ...source.project };
  // Only pre-archive v1 workspaces are implicitly pinned to standard rules.
  // A v2 workspace without a binding stays unbound so load can surface the
  // problem instead of silently choosing rules.
  if (!hasBinding && sourceVersion === 1) {
    const standard = standardRuleProfile();
    if (!ruleProfiles.some((profile) => profile.profileId === standard.profileId && profile.version === standard.version)) {
      ruleProfiles.unshift(standard);
    }
    project.ruleBinding = {
      profileId: standard.profileId,
      version: standard.version,
      boundAt: new Date(0).toISOString(),
    };
  }

  const readinessRuns = Array.isArray(source.readinessRuns)
    ? source.readinessRuns.filter(
        (run) =>
          run && typeof run.id === 'string' && typeof run.checkedAt === 'string'
          && typeof run.ready === 'boolean' && typeof run.score === 'number'
          && Array.isArray(run.blockers) && Array.isArray(run.cautions)
          && Boolean(run.ruleArchive) && typeof run.ruleArchive.profileId === 'string'
          && typeof run.ruleArchive.version === 'number',
      )
    : [];

  return {
    version: 2,
    project,
    artifacts: source.artifacts,
    zones,
    issues: source.issues,
    preferences: source.preferences,
    ruleProfiles,
    readinessRuns,
    lastSavedAt: source.lastSavedAt,
  };
}

/** Drop structurally invalid profiles but never invent or rewrite versions. */
export function sanitizeProfiles(profiles: unknown): RuleProfile[] {
  if (!Array.isArray(profiles)) return [];
  const valid = profiles.filter(isRuleProfile);
  // Keep the first occurrence of each profile#version key.
  const seen = new Set<string>();
  return valid.filter((profile) => {
    const key = `${profile.profileId}#${profile.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateReferences(state: WorkspaceState): WorkspaceState {
  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.id));
  const zoneIds = new Set(state.zones.map((zone) => zone.id));
  return {
    ...state,
    zones: state.zones.map((zone) => ({ ...zone, artifactIds: zone.artifactIds.filter((id) => artifactIds.has(id)) })),
    issues: state.issues.map((issue) => ({
      ...issue,
      zoneId: issue.zoneId && zoneIds.has(issue.zoneId) ? issue.zoneId : undefined,
      artifactId: issue.artifactId && artifactIds.has(issue.artifactId) ? issue.artifactId : undefined,
    })),
  };
}
