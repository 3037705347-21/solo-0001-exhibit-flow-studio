import { canPlaceArtifact } from './journeyAnalysis';
import type { Artifact, ConstraintFinding, WorkspaceState, Zone } from './models';

export interface SwapRequest {
  firstArtifactId: string;
  secondArtifactId: string;
  firstZoneId: string;
  secondZoneId: string;
  firstIndex: number;
  secondIndex: number;
}

export interface SwapSidePreview {
  artifactId: string;
  fromZoneId: string;
  fromIndex: number;
  toZoneId: string;
  toIndex: number;
  findings: ConstraintFinding[];
}

export interface SwapZonePreview {
  zoneId: string;
  beforeDwellMinutes: number;
  afterDwellMinutes: number;
  capacityMinutes: number;
  beforeObjects: number;
  afterObjects: number;
  maxObjects: number;
  beforeUtilization: number;
  afterUtilization: number;
  findings: ConstraintFinding[];
}

export interface SwapPreview {
  first: SwapSidePreview;
  second: SwapSidePreview;
  zones: [SwapZonePreview, SwapZonePreview];
  errors: ConstraintFinding[];
  warnings: ConstraintFinding[];
  canSwap: boolean;
}

interface Placement {
  zone: Zone;
  index: number;
}

function findPlacement(state: WorkspaceState, artifactId: string): Placement | null {
  for (const zone of state.zones) {
    const index = zone.artifactIds.indexOf(artifactId);
    if (index !== -1) return { zone, index };
  }
  return null;
}

function zoneDwellMinutes(state: WorkspaceState, zone: Zone): number {
  const byId = new Map(state.artifacts.map((artifact) => [artifact.id, artifact]));
  return zone.artifactIds.reduce((total, id) => total + (byId.get(id)?.dwellMinutes ?? 0), 0);
}

function previewZone(state: WorkspaceState, zone: Zone, outgoing: Artifact, incoming: Artifact): SwapZonePreview {
  const beforeDwellMinutes = zoneDwellMinutes(state, zone);
  const afterDwellMinutes = beforeDwellMinutes - outgoing.dwellMinutes + incoming.dwellMinutes;
  const beforeObjects = zone.artifactIds.length;
  const afterObjects = beforeObjects;
  const findings: ConstraintFinding[] = [];

  if (afterDwellMinutes > zone.capacityMinutes) {
    findings.push({
      id: `swap-capacity-${zone.id}`,
      type: 'error',
      title: `${zone.name} exceeds dwell capacity`,
      detail: `${afterDwellMinutes} minutes would be planned against a ${zone.capacityMinutes} minute target.`,
      zoneId: zone.id,
    });
  } else if (zone.capacityMinutes > 0 && afterDwellMinutes / zone.capacityMinutes >= 0.8) {
    findings.push({
      id: `swap-capacity-warning-${zone.id}`,
      type: 'warning',
      title: `${zone.name} nears dwell capacity`,
      detail: `${Math.round((afterDwellMinutes / zone.capacityMinutes) * 100)}% of the target dwell time would be allocated.`,
      zoneId: zone.id,
    });
  }

  if (afterObjects > zone.maxObjects) {
    findings.push({
      id: `swap-density-${zone.id}`,
      type: 'error',
      title: `${zone.name} has too many objects`,
      detail: `${afterObjects} objects would be placed against a limit of ${zone.maxObjects}.`,
      zoneId: zone.id,
    });
  }

  return {
    zoneId: zone.id,
    beforeDwellMinutes,
    afterDwellMinutes,
    capacityMinutes: zone.capacityMinutes,
    beforeObjects,
    afterObjects,
    maxObjects: zone.maxObjects,
    beforeUtilization: zone.capacityMinutes ? beforeDwellMinutes / zone.capacityMinutes : 0,
    afterUtilization: zone.capacityMinutes ? afterDwellMinutes / zone.capacityMinutes : 0,
    findings,
  };
}

/**
 * Builds the confirmation preview for exchanging two placed artifacts between
 * their zones. Returns null when the swap is structurally impossible: an
 * artifact is missing, either artifact lacks a placement, or both already
 * share a zone. Rule conflicts are reported on the preview instead.
 */
export function planArtifactSwap(state: WorkspaceState, firstArtifactId: string, secondArtifactId: string): SwapPreview | null {
  if (firstArtifactId === secondArtifactId) return null;
  const firstArtifact = state.artifacts.find((artifact) => artifact.id === firstArtifactId);
  const secondArtifact = state.artifacts.find((artifact) => artifact.id === secondArtifactId);
  if (!firstArtifact || !secondArtifact) return null;
  const firstPlacement = findPlacement(state, firstArtifactId);
  const secondPlacement = findPlacement(state, secondArtifactId);
  if (!firstPlacement || !secondPlacement) return null;
  if (firstPlacement.zone.id === secondPlacement.zone.id) return null;

  const first: SwapSidePreview = {
    artifactId: firstArtifactId,
    fromZoneId: firstPlacement.zone.id,
    fromIndex: firstPlacement.index,
    toZoneId: secondPlacement.zone.id,
    toIndex: secondPlacement.index,
    findings: canPlaceArtifact(firstArtifact, secondPlacement.zone),
  };
  const second: SwapSidePreview = {
    artifactId: secondArtifactId,
    fromZoneId: secondPlacement.zone.id,
    fromIndex: secondPlacement.index,
    toZoneId: firstPlacement.zone.id,
    toIndex: firstPlacement.index,
    findings: canPlaceArtifact(secondArtifact, firstPlacement.zone),
  };
  const zones: [SwapZonePreview, SwapZonePreview] = [
    previewZone(state, firstPlacement.zone, firstArtifact, secondArtifact),
    previewZone(state, secondPlacement.zone, secondArtifact, firstArtifact),
  ];
  const all = [...first.findings, ...second.findings, ...zones[0].findings, ...zones[1].findings];
  const errors = all.filter((finding) => finding.type === 'error');
  const warnings = all.filter((finding) => finding.type === 'warning');
  return { first, second, zones, errors, warnings, canSwap: errors.length === 0 };
}

export function swapRequestFromPreview(preview: SwapPreview): SwapRequest {
  return {
    firstArtifactId: preview.first.artifactId,
    secondArtifactId: preview.second.artifactId,
    firstZoneId: preview.first.fromZoneId,
    secondZoneId: preview.second.fromZoneId,
    firstIndex: preview.first.fromIndex,
    secondIndex: preview.second.fromIndex,
  };
}

/**
 * Applies a confirmed swap as a single atomic transition. Each artifact takes
 * the exact slot of the other, so every zone keeps its internal order. Returns
 * null — leaving both placements untouched — when the request no longer
 * matches the current plan or either target breaks a placement rule.
 */
export function applyArtifactSwap(state: WorkspaceState, request: SwapRequest): WorkspaceState | null {
  const preview = planArtifactSwap(state, request.firstArtifactId, request.secondArtifactId);
  if (!preview || !preview.canSwap) return null;
  const unchanged =
    preview.first.fromZoneId !== request.firstZoneId
    || preview.second.fromZoneId !== request.secondZoneId
    || preview.first.fromIndex !== request.firstIndex
    || preview.second.fromIndex !== request.secondIndex;
  if (unchanged) return null;

  return {
    ...state,
    zones: state.zones.map((zone) => {
      if (zone.id === preview.first.fromZoneId) {
        const artifactIds = [...zone.artifactIds];
        artifactIds[preview.first.fromIndex] = request.secondArtifactId;
        return { ...zone, artifactIds };
      }
      if (zone.id === preview.second.fromZoneId) {
        const artifactIds = [...zone.artifactIds];
        artifactIds[preview.second.fromIndex] = request.firstArtifactId;
        return { ...zone, artifactIds };
      }
      return zone;
    }),
  };
}
