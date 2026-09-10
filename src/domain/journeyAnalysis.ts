import type {
  Artifact,
  ConstraintFinding,
  JourneyAnalysis,
  NarrativeRole,
  Zone,
  ZoneAnalysis,
} from './models';

const ALL_ROLES: NarrativeRole[] = ['threshold', 'context', 'turning-point', 'reflection'];

function zoneArtifacts(zone: Zone, artifacts: Artifact[]): Artifact[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return zone.artifactIds
    .map((id) => byId.get(id))
    .filter((artifact): artifact is Artifact => Boolean(artifact));
}

function analyzeZone(zone: Zone, artifacts: Artifact[]): ZoneAnalysis {
  const placed = zoneArtifacts(zone, artifacts);
  const dwellMinutes = placed.reduce((total, artifact) => total + artifact.dwellMinutes, 0);
  const utilization = zone.capacityMinutes ? dwellMinutes / zone.capacityMinutes : 0;
  const objectUtilization = zone.maxObjects ? placed.length / zone.maxObjects : 0;
  const findings: ConstraintFinding[] = [];

  if (utilization > 1) {
    findings.push({
      id: `capacity-${zone.id}`,
      type: 'error',
      title: `${zone.name} exceeds dwell capacity`,
      detail: `${dwellMinutes} minutes planned against a ${zone.capacityMinutes} minute target.`,
      zoneId: zone.id,
    });
  } else if (utilization >= 0.8) {
    findings.push({
      id: `capacity-warning-${zone.id}`,
      type: 'warning',
      title: `${zone.name} is nearing dwell capacity`,
      detail: `${Math.round(utilization * 100)}% of the target dwell time is allocated.`,
      zoneId: zone.id,
    });
  }

  if (objectUtilization > 1) {
    findings.push({
      id: `density-${zone.id}`,
      type: 'error',
      title: `${zone.name} has too many objects`,
      detail: `${placed.length} objects are placed against a limit of ${zone.maxObjects}.`,
      zoneId: zone.id,
    });
  } else if (objectUtilization >= 0.8) {
    findings.push({
      id: `density-warning-${zone.id}`,
      type: 'warning',
      title: `${zone.name} may feel visually dense`,
      detail: `${placed.length} of ${zone.maxObjects} object positions are occupied.`,
      zoneId: zone.id,
    });
  }

  for (const artifact of placed) {
    if (artifact.sensitivity === 'low-light' && !zone.lowLight) {
      findings.push({
        id: `light-${zone.id}-${artifact.id}`,
        type: 'error',
        title: `${artifact.title} requires low light`,
        detail: `${zone.name} is not configured as a low-light zone.`,
        zoneId: zone.id,
        artifactId: artifact.id,
      });
    }
    if (artifact.accessibilityNeed === 'seating' && !zone.hasSeating) {
      findings.push({
        id: `seating-${zone.id}-${artifact.id}`,
        type: 'warning',
        title: `${artifact.title} needs seated interpretation`,
        detail: `Add seating to ${zone.name} or move the object to a seated zone.`,
        zoneId: zone.id,
        artifactId: artifact.id,
      });
    }
  }

  const roleCoverage = Array.from(new Set(placed.map((artifact) => artifact.narrativeRole)));
  if (placed.length > 0 && !roleCoverage.includes('context')) {
    findings.push({
      id: `context-${zone.id}`,
      type: 'notice',
      title: `${zone.name} lacks a context object`,
      detail: 'A context object can help visitors orient before the main interpretive turn.',
      zoneId: zone.id,
    });
  }

  return {
    zoneId: zone.id,
    dwellMinutes,
    utilization,
    objectCount: placed.length,
    objectUtilization,
    roleCoverage,
    findings,
  };
}

export function analyzeJourney(artifacts: Artifact[], zones: Zone[]): JourneyAnalysis {
  const sequenceZones = [...zones].sort((a, b) => a.sequence - b.sequence);
  const zoneAnalyses = sequenceZones.map((zone) => analyzeZone(zone, artifacts));
  const placedIds = new Set(zones.flatMap((zone) => zone.artifactIds));
  const keyObjects = artifacts.filter((artifact) => artifact.isKeyObject);
  const placedKeyObjects = keyObjects.filter((artifact) => placedIds.has(artifact.id));
  const placedRoles = new Set(
    artifacts
      .filter((artifact) => placedIds.has(artifact.id))
      .map((artifact) => artifact.narrativeRole),
  );
  const findings = zoneAnalyses.flatMap((zone) => zone.findings);

  for (const role of ALL_ROLES) {
    if (!placedRoles.has(role)) {
      findings.push({
        id: `missing-role-${role}`,
        type: role === 'turning-point' ? 'error' : 'warning',
        title: `Missing ${role.replace('-', ' ')} role`,
        detail: 'Assign at least one placed object to this narrative role before final review.',
      });
    }
  }

  const unplacedKeyObjects = keyObjects.filter((artifact) => !placedIds.has(artifact.id));
  for (const artifact of unplacedKeyObjects) {
    findings.push({
      id: `unplaced-key-${artifact.id}`,
      type: 'error',
      title: `Key object is not in the journey`,
      detail: `${artifact.title} is marked as a key object and must be placed.`,
      artifactId: artifact.id,
    });
  }

  return {
    totalDwellMinutes: zoneAnalyses.reduce((total, zone) => total + zone.dwellMinutes, 0),
    placedCount: placedIds.size,
    unplacedCount: artifacts.filter((artifact) => !placedIds.has(artifact.id)).length,
    keyObjectCoverage: keyObjects.length ? placedKeyObjects.length / keyObjects.length : 1,
    roleCoverage: placedRoles.size / ALL_ROLES.length,
    zones: zoneAnalyses,
    findings,
    blockingCount: findings.filter((finding) => finding.type === 'error').length,
    warningCount: findings.filter((finding) => finding.type === 'warning').length,
  };
}

export function getUnplacedArtifacts(artifacts: Artifact[], zones: Zone[]): Artifact[] {
  const placedIds = new Set(zones.flatMap((zone) => zone.artifactIds));
  return artifacts.filter((artifact) => !placedIds.has(artifact.id));
}

export function canPlaceArtifact(artifact: Artifact, zone: Zone): ConstraintFinding[] {
  const findings: ConstraintFinding[] = [];
  if (artifact.sensitivity === 'low-light' && !zone.lowLight) {
    findings.push({
      id: `preview-light-${artifact.id}-${zone.id}`,
      type: 'error',
      title: 'Light requirement conflict',
      detail: `${artifact.title} requires a low-light environment.`,
      zoneId: zone.id,
      artifactId: artifact.id,
    });
  }
  if (artifact.accessibilityNeed === 'seating' && !zone.hasSeating) {
    findings.push({
      id: `preview-seating-${artifact.id}-${zone.id}`,
      type: 'warning',
      title: 'Seating requirement',
      detail: `${artifact.title} benefits from seated interpretation.`,
      zoneId: zone.id,
      artifactId: artifact.id,
    });
  }
  return findings;
}
