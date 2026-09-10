import type { Artifact, Zone } from './models';

export interface VisitorPathNode {
  zoneId: string;
  zoneName: string;
  sequence: number;
  dwellMinutes: number;
  artifactCount: number;
  transitions: { from: string; to: string; minutes: number }[];
}

export interface VisitorPathSummary {
  nodes: VisitorPathNode[];
  totalMinutes: number;
  shortestMinutes: number;
  longestMinutes: number;
  handoffCount: number;
}

export function buildVisitorPath(zones: Zone[], artifacts: Artifact[]): VisitorPathSummary {
  const artifactMap = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const nodes = [...zones]
    .sort((left, right) => left.sequence - right.sequence)
    .map((zone, index, all) => {
      const placed = zone.artifactIds.map((id) => artifactMap.get(id)).filter((artifact): artifact is Artifact => Boolean(artifact));
      const dwellMinutes = placed.reduce((sum, artifact) => sum + artifact.dwellMinutes, 0);
      const previous = all[index - 1];
      return {
        zoneId: zone.id,
        zoneName: zone.name,
        sequence: zone.sequence,
        dwellMinutes,
        artifactCount: placed.length,
        transitions: previous ? [{ from: previous.id, to: zone.id, minutes: 1 }] : [],
      };
    });
  const totalMinutes = nodes.reduce((sum, node) => sum + node.dwellMinutes, 0);
  return {
    nodes,
    totalMinutes,
    shortestMinutes: nodes.length ? Math.min(...nodes.map((node) => node.dwellMinutes)) : 0,
    longestMinutes: nodes.length ? Math.max(...nodes.map((node) => node.dwellMinutes)) : 0,
    handoffCount: Math.max(0, nodes.length - 1),
  };
}

export function getPathProgress(path: VisitorPathSummary, zoneId: string): number {
  const index = path.nodes.findIndex((node) => node.zoneId === zoneId);
  return index < 0 || path.nodes.length < 2 ? 0 : index / (path.nodes.length - 1);
}

export function estimateExitTime(path: VisitorPathSummary, start: Date, pauseMinutes = 0): Date {
  const exit = new Date(start);
  exit.setMinutes(exit.getMinutes() + path.totalMinutes + path.handoffCount + Math.max(0, pauseMinutes));
  return exit;
}
