import type {
  Artifact,
  CollectionFilter,
  CollectionRuleVersion,
  CollectionView,
  FrozenMemberEntry,
  FrozenMemberSnapshot,
  FrozenViewEvaluation,
} from './models';
import { filterCollection } from './filters';

export const EMPTY_COLLECTION_FILTER: CollectionFilter = {
  query: '',
  roles: [],
  sensitivities: [],
  keyOnly: false,
};

/** Fields captured when a frozen list is issued; any difference means the member has drifted. */
const SNAPSHOT_FIELDS: Array<{ key: keyof FrozenMemberSnapshot; label: string }> = [
  { key: 'accessionId', label: 'Accession ID' },
  { key: 'title', label: 'Title' },
  { key: 'narrativeRole', label: 'Narrative role' },
  { key: 'sensitivity', label: 'Sensitivity' },
  { key: 'isKeyObject', label: 'Key object flag' },
];

/** Human-readable basis ("创建依据") for a set of rules, used when issuing a new revision. */
export function describeRulesBasis(rules: CollectionFilter): string {
  const parts: string[] = [];
  if (rules.query.trim()) parts.push(`query “${rules.query.trim()}”`);
  if (rules.roles.length) parts.push(`${rules.roles.length} role filter${rules.roles.length === 1 ? '' : 's'}`);
  if (rules.sensitivities.length) parts.push(`${rules.sensitivities.length} sensitivity filter${rules.sensitivities.length === 1 ? '' : 's'}`);
  if (rules.keyOnly) parts.push('key objects only');
  return parts.length ? parts.join(', ') : 'all collection objects';
}

export function snapshotMember(artifact: Artifact): FrozenMemberSnapshot {
  return {
    artifactId: artifact.id,
    accessionId: artifact.accessionId,
    title: artifact.title,
    narrativeRole: artifact.narrativeRole,
    sensitivity: artifact.sensitivity,
    isKeyObject: artifact.isKeyObject,
  };
}

/**
 * Create a saved view. Membership is computed once so the first rule version
 * always records member identity. Frozen views additionally capture the member
 * snapshots that protect the issued list from future content drift.
 */
export function createCollectionView(input: {
  id: string;
  name: string;
  kind: CollectionView['kind'];
  rules: CollectionFilter;
  artifacts: Artifact[];
  basis?: string;
  at: string;
}): CollectionView {
  const members = filterCollection(input.artifacts, input.rules);
  const version: CollectionRuleVersion = {
    version: 1,
    rules: input.rules,
    memberIds: members.map((artifact) => artifact.id),
    basis: input.basis ?? describeRulesBasis(input.rules),
    createdAt: input.at,
  };
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    createdAt: input.at,
    updatedAt: input.at,
    ruleVersions: [version],
    frozenMembers: input.kind === 'frozen' ? members.map(snapshotMember) : undefined,
  };
}

/**
 * Append a new rule revision to a live view. The live view follows the latest
 * revision; prior versions (rules, membership, basis) remain on record.
 * Frozen views are never revised in place — their rule set is issued evidence.
 */
export function reviseLiveView(
  view: CollectionView,
  rules: CollectionFilter,
  artifacts: Artifact[],
  at: string,
): CollectionView {
  if (view.kind !== 'live') {
    throw new Error('Frozen lists cannot be revised; save the rules as a new view instead.');
  }
  const members = filterCollection(artifacts, rules);
  const version: CollectionRuleVersion = {
    version: view.ruleVersions.length + 1,
    rules,
    memberIds: members.map((artifact) => artifact.id),
    basis: describeRulesBasis(rules),
    createdAt: at,
  };
  return { ...view, ruleVersions: [...view.ruleVersions, version], updatedAt: at };
}

export function latestRuleVersion(view: CollectionView): CollectionRuleVersion {
  return view.ruleVersions[view.ruleVersions.length - 1];
}

/** Live view membership: always recomputed against the current collection. */
export function evaluateLiveView(view: CollectionView, artifacts: Artifact[]): Artifact[] {
  if (view.kind !== 'live') {
    throw new Error('Frozen lists must be evaluated with evaluateFrozenView.');
  }
  return filterCollection(artifacts, latestRuleVersion(view).rules);
}

function diffMember(snapshot: FrozenMemberSnapshot, current: Artifact): Array<keyof FrozenMemberSnapshot> {
  return SNAPSHOT_FIELDS
    .filter(({ key }) => current[key as keyof Artifact] !== snapshot[key])
    .map(({ key }) => key);
}

/**
 * Frozen list membership: the issued member sequence is preserved exactly.
 * Each member is compared to the object currently holding its id:
 * - `intact`: the object still matches the issued record,
 * - `changed`: accession ID corrected, role changed, or another tracked field drifted,
 * - `missing`: the object was deleted.
 * Objects newly matching the rules are reported separately and never merge in.
 */
export function evaluateFrozenView(view: CollectionView, artifacts: Artifact[]): FrozenViewEvaluation {
  if (view.kind !== 'frozen' || !view.frozenMembers) {
    throw new Error('Live views must be evaluated with evaluateLiveView.');
  }
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const entries: FrozenMemberEntry[] = view.frozenMembers.map((snapshot) => {
    const current = byId.get(snapshot.artifactId);
    if (!current) {
      return { snapshot, state: 'missing', changedFields: [] };
    }
    const changedFields = diffMember(snapshot, current);
    return changedFields.length
      ? { snapshot, current, state: 'changed', changedFields }
      : { snapshot, current, state: 'intact', changedFields: [] };
  });
  const changedCount = entries.filter((entry) => entry.state === 'changed').length;
  const missingCount = entries.filter((entry) => entry.state === 'missing').length;
  const issuedIds = new Set(view.frozenMembers.map((member) => member.artifactId));
  const addedArtifacts = filterCollection(artifacts, latestRuleVersion(view).rules)
    .filter((artifact) => !issuedIds.has(artifact.id));
  return {
    entries,
    intactCount: entries.length - changedCount - missingCount,
    changedCount,
    missingCount,
    isStale: changedCount + missingCount > 0,
    addedArtifacts,
  };
}

/** View names must be unique across both kinds so delete/restore can never confuse the two semantics. */
export function findViewNameConflict(views: CollectionView[], name: string, excludeId?: string): CollectionView | undefined {
  const normalized = name.trim().toLowerCase();
  return views.find((view) => view.id !== excludeId && view.name.toLowerCase() === normalized);
}

export function isCollectionFilter(value: unknown): value is CollectionFilter {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CollectionFilter>;
  return typeof candidate.query === 'string'
    && Array.isArray(candidate.roles) && candidate.roles.every((role) => typeof role === 'string')
    && Array.isArray(candidate.sensitivities) && candidate.sensitivities.every((item) => typeof item === 'string')
    && typeof candidate.keyOnly === 'boolean';
}

export const FROZEN_MEMBER_FIELD_LABELS: Record<keyof FrozenMemberSnapshot, string> = {
  artifactId: 'Object',
  accessionId: 'Accession ID',
  title: 'Title',
  narrativeRole: 'Narrative role',
  sensitivity: 'Sensitivity',
  isKeyObject: 'Key object flag',
};
