import type { AccessibilityNeed, Artifact, Zone } from './models';

export interface AccessAudit {
  totalRequirements: number;
  coveredRequirements: number;
  coverage: number;
  missing: Array<{ artifactId: string; need: AccessibilityNeed; zoneId?: string }>;
  strengths: string[];
}

export function auditAccessibility(artifacts: Artifact[], zones: Zone[]): AccessAudit {
  const zoneByArtifact = new Map<string, Zone>();
  zones.forEach((zone) =>
    zone.artifactIds.forEach((artifactId) => zoneByArtifact.set(artifactId, zone)),
  );
  const requirements = artifacts.filter((artifact) => artifact.accessibilityNeed !== 'none');
  const missing = requirements.flatMap((artifact) => {
    const zone = zoneByArtifact.get(artifact.id);
    const covered =
      artifact.accessibilityNeed === 'seating'
        ? zone?.hasSeating
        : artifact.accessibilityNeed === 'audio'
          ? Boolean(zone)
          : artifact.accessibilityNeed === 'tactile-alternative'
            ? Boolean(zone)
            : true;
    return covered
      ? []
      : [{ artifactId: artifact.id, need: artifact.accessibilityNeed, zoneId: zone?.id }];
  });
  const strengths: string[] = [];
  const seatedZones = zones.filter((zone) => zone.hasSeating).length;
  const lowLightZones = zones.filter((zone) => zone.lowLight).length;
  if (seatedZones)
    strengths.push(`${seatedZones} zone${seatedZones === 1 ? '' : 's'} offer seating.`);
  if (lowLightZones)
    strengths.push(
      `${lowLightZones} low-light zone${lowLightZones === 1 ? '' : 's'} protect sensitive material.`,
    );
  if (!requirements.length)
    strengths.push('No special interpretation requirements are recorded yet.');
  const coveredRequirements = requirements.length - missing.length;
  return {
    totalRequirements: requirements.length,
    coveredRequirements,
    coverage: requirements.length ? coveredRequirements / requirements.length : 1,
    missing,
    strengths,
  };
}

export function needLabel(need: AccessibilityNeed): string {
  const labels: Record<AccessibilityNeed, string> = {
    none: 'No special need',
    seating: 'Seated interpretation',
    audio: 'Audio interpretation',
    'tactile-alternative': 'Tactile alternative',
  };
  return labels[need];
}

export function zoneSupportsNeed(zone: Zone, need: AccessibilityNeed): boolean {
  if (need === 'none' || need === 'audio' || need === 'tactile-alternative') return true;
  return need === 'seating' ? zone.hasSeating : false;
}
