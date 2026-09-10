import type { Artifact, NarrativeRole } from './models';

export interface CollectionFacet { label: string; value: string; count: number; color?: string }
export interface CollectionInsights {
  total: number;
  keyCount: number;
  totalMinutes: number;
  averageMinutes: number;
  makers: CollectionFacet[];
  roles: CollectionFacet[];
  sensitivities: CollectionFacet[];
  decades: CollectionFacet[];
  tagCloud: CollectionFacet[];
}

function facets(values: string[], colors?: Map<string, string>): CollectionFacet[] {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([value, count]) => ({ label: value, value, count, color: colors?.get(value) }));
}

function decade(yearLabel: string): string {
  const match = yearLabel.match(/(\d{4})/);
  if (!match) return 'Undated';
  return `${Math.floor(Number(match[1]) / 10) * 10}s`;
}

export function summarizeCollection(artifacts: Artifact[]): CollectionInsights {
  const roleColors = new Map<NarrativeRole, string>([
    ['threshold', '#d7654e'],
    ['context', '#7c6aa6'],
    ['turning-point', '#2f7c75'],
    ['reflection', '#597b8e'],
  ]);
  const totalMinutes = artifacts.reduce((sum, artifact) => sum + artifact.dwellMinutes, 0);
  return {
    total: artifacts.length,
    keyCount: artifacts.filter((artifact) => artifact.isKeyObject).length,
    totalMinutes,
    averageMinutes: artifacts.length ? totalMinutes / artifacts.length : 0,
    makers: facets(artifacts.map((artifact) => artifact.maker)),
    roles: facets(artifacts.map((artifact) => artifact.narrativeRole), roleColors),
    sensitivities: facets(artifacts.map((artifact) => artifact.sensitivity)),
    decades: facets(artifacts.map((artifact) => decade(artifact.yearLabel))),
    tagCloud: facets(artifacts.flatMap((artifact) => artifact.tags)),
  };
}

export function searchArtifacts(artifacts: Artifact[], query: string): Artifact[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return artifacts;
  return artifacts.filter((artifact) => {
    const fields = [artifact.title, artifact.maker, artifact.accessionId, artifact.medium, artifact.origin, artifact.summary, ...artifact.tags];
    return fields.some((field) => field.toLocaleLowerCase().includes(normalized));
  });
}

export function sortArtifacts(artifacts: Artifact[], sort: 'title' | 'dwell' | 'recent' | 'role'): Artifact[] {
  return [...artifacts].sort((left, right) => {
    if (sort === 'title') return left.title.localeCompare(right.title);
    if (sort === 'dwell') return right.dwellMinutes - left.dwellMinutes;
    if (sort === 'recent') return right.updatedAt.localeCompare(left.updatedAt);
    return left.narrativeRole.localeCompare(right.narrativeRole) || left.title.localeCompare(right.title);
  });
}

export function filterByAccessibility(artifacts: Artifact[], need: Artifact['accessibilityNeed'] | 'all'): Artifact[] {
  return need === 'all' ? artifacts : artifacts.filter((artifact) => artifact.accessibilityNeed === need);
}
