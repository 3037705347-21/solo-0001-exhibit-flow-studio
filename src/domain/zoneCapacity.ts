import type { Artifact, Zone } from './models';

export interface CapacityProjection {
  zoneId: string;
  currentMinutes: number;
  remainingMinutes: number;
  currentObjects: number;
  remainingObjects: number;
  canFitMinutes: (minutes: number) => boolean;
  canFitObject: () => boolean;
}

export function projectZoneCapacity(zone: Zone, artifacts: Artifact[]): CapacityProjection {
  const currentMinutes = artifacts.reduce((total, artifact) => total + artifact.dwellMinutes, 0);
  const remainingMinutes = Math.max(0, zone.capacityMinutes - currentMinutes);
  const currentObjects = artifacts.length;
  const remainingObjects = Math.max(0, zone.maxObjects - currentObjects);
  return {
    zoneId: zone.id,
    currentMinutes,
    remainingMinutes,
    currentObjects,
    remainingObjects,
    canFitMinutes: (minutes) => currentMinutes + minutes <= zone.capacityMinutes,
    canFitObject: () => currentObjects < zone.maxObjects,
  };
}

export function rankZonesForArtifact(artifact: Artifact, zones: Zone[], occupancy: Map<string, CapacityProjection>): Zone[] {
  return [...zones].sort((left, right) => {
    const leftScore = scoreZone(artifact, left, occupancy.get(left.id));
    const rightScore = scoreZone(artifact, right, occupancy.get(right.id));
    return rightScore - leftScore;
  });
}

function scoreZone(artifact: Artifact, zone: Zone, capacity?: CapacityProjection): number {
  if (!capacity || !capacity.canFitMinutes(artifact.dwellMinutes) || !capacity.canFitObject()) return -100;
  let score = capacity.remainingMinutes - artifact.dwellMinutes;
  if (artifact.sensitivity === 'low-light') score += zone.lowLight ? 40 : -80;
  if (artifact.accessibilityNeed === 'seating') score += zone.hasSeating ? 20 : -25;
  return score;
}

export function describeCapacity(capacity: CapacityProjection): string {
  if (capacity.remainingMinutes === 0) return 'At dwell limit';
  if (capacity.remainingMinutes < 4) return `${capacity.remainingMinutes} min remaining`;
  return `${capacity.remainingMinutes} min available`;
}
