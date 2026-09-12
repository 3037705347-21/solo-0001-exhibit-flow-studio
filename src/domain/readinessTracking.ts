import type { ReadinessDrift, ReadinessFact, ReadinessLink, WorkspaceState } from './models';

/**
 * A readiness verdict is only valid for the exact domain facts it was computed
 * from. These helpers record those facts next to the result and diff them
 * against the live workspace so a stale verdict is detected deterministically,
 * no matter which module introduced the change.
 */

export function collectReadinessFacts(state: Pick<WorkspaceState, 'artifacts' | 'zones' | 'issues'>): ReadinessFact[] {
  const facts: ReadinessFact[] = [];
  for (const issue of state.issues) {
    facts.push({
      key: `issue:${issue.id}`,
      hash: [issue.title, issue.severity, issue.status, issue.zoneId ?? '', issue.artifactId ?? ''].join('|'),
    });
  }
  for (const artifact of state.artifacts) {
    facts.push({
      key: `artifact:${artifact.id}`,
      hash: [artifact.title, artifact.dwellMinutes, artifact.narrativeRole, artifact.sensitivity, artifact.accessibilityNeed, artifact.isKeyObject].join('|'),
    });
  }
  for (const zone of state.zones) {
    facts.push({
      key: `zone:${zone.id}`,
      hash: [zone.name, zone.capacityMinutes, zone.maxObjects, zone.lowLight, zone.hasSeating, zone.sequence, zone.artifactIds.join(',')].join('|'),
    });
  }
  return facts.sort((a, b) => a.key.localeCompare(b.key));
}

export function diffReadinessFacts(recorded: ReadinessFact[], current: ReadinessFact[]): ReadinessDrift {
  const recordedByKey = new Map(recorded.map((fact) => [fact.key, fact.hash]));
  const currentByKey = new Map(current.map((fact) => [fact.key, fact.hash]));
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  for (const [key, hash] of recordedByKey) {
    if (!currentByKey.has(key)) removed.push(key);
    else if (currentByKey.get(key) !== hash) changed.push(key);
  }
  for (const key of currentByKey.keys()) {
    if (!recordedByKey.has(key)) added.push(key);
  }
  const sort = (keys: string[]) => keys.sort((a, b) => a.localeCompare(b));
  return { stale: changed.length + removed.length + added.length > 0, changed: sort(changed), removed: sort(removed), added: sort(added) };
}

export function readinessDrift(state: WorkspaceState): ReadinessDrift | null {
  if (!state.readiness) return null;
  return diffReadinessFacts(state.readiness.facts, collectReadinessFacts(state));
}

export function describeFactKey(key: string, state: Pick<WorkspaceState, 'artifacts' | 'zones' | 'issues'>): string {
  const separator = key.indexOf(':');
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (kind === 'issue') {
    const issue = state.issues.find((candidate) => candidate.id === id);
    return issue ? `finding “${issue.title}”` : 'a removed finding';
  }
  if (kind === 'artifact') {
    const artifact = state.artifacts.find((candidate) => candidate.id === id);
    return artifact ? `object “${artifact.title}”` : 'a removed object';
  }
  if (kind === 'zone') {
    const zone = state.zones.find((candidate) => candidate.id === id);
    return zone ? `zone “${zone.name}”` : 'a removed zone';
  }
  return key;
}

export function summarizeDrift(drift: ReadinessDrift, state: Pick<WorkspaceState, 'artifacts' | 'zones' | 'issues'>): string {
  const keys = [...drift.changed, ...drift.removed, ...drift.added];
  const labels = keys.slice(0, 3).map((key) => describeFactKey(key, state));
  const remainder = keys.length - labels.length;
  const suffix = remainder > 0 ? `, +${remainder} more` : '';
  return `${keys.length} tracked fact${keys.length === 1 ? '' : 's'} changed (${labels.join(', ')}${suffix}).`;
}

export type ReadinessLinkStatus = 'ok' | 'changed' | 'missing';

/** Deep link from a blocker to the page that can resolve it, carrying the return context. */
export function readinessLinkHref(link: ReadinessLink, blockerId: string): string {
  if (link.kind === 'issue') return `/review?issue=${encodeURIComponent(link.id ?? '')}`;
  const params = new URLSearchParams({ from: 'readiness', blocker: blockerId });
  if (link.kind === 'zone' && link.id) params.set('zone', link.id);
  if (link.kind === 'artifact' && link.id) params.set('artifact', link.id);
  const base = link.kind === 'artifact' ? '/collection' : '/journey';
  return `${base}?${params.toString()}`;
}

/**
 * Resolve a recorded blocker link against the live workspace: the target may
 * have been deleted ('missing') or edited since the check ('changed'). Both
 * cases must send the user back to a fresh readiness check.
 */
export function readinessLinkStatus(
  link: ReadinessLink,
  state: WorkspaceState,
  currentFacts: ReadinessFact[] = collectReadinessFacts(state),
): ReadinessLinkStatus {
  if (link.kind === 'journey' || !link.id) return 'ok';
  const exists =
    link.kind === 'issue' ? state.issues.some((issue) => issue.id === link.id)
      : link.kind === 'artifact' ? state.artifacts.some((artifact) => artifact.id === link.id)
        : state.zones.some((zone) => zone.id === link.id);
  if (!exists) return 'missing';
  const key = `${link.kind}:${link.id}`;
  const recordedHash = state.readiness?.facts.find((fact) => fact.key === key)?.hash;
  if (recordedHash === undefined) return 'ok';
  const currentHash = currentFacts.find((fact) => fact.key === key)?.hash;
  return currentHash !== undefined && currentHash !== recordedHash ? 'changed' : 'ok';
}
