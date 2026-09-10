import type { JourneyAnalysis, ScenarioInput, ScenarioProjection, WorkspaceState } from './models';

const PACE_MULTIPLIER: Record<ScenarioInput['pace'], number> = {
  focused: 0.78,
  balanced: 1,
  leisurely: 1.28,
};

export function clampScenario(input: ScenarioInput): ScenarioInput {
  return {
    pace: input.pace,
    accessibilityPriority: Math.max(0, Math.min(100, Math.round(input.accessibilityPriority))),
    groupSize: Math.max(1, Math.min(30, Math.round(input.groupSize))),
  };
}

export function projectScenario(
  state: WorkspaceState,
  analysis: JourneyAnalysis,
  rawInput: ScenarioInput,
): ScenarioProjection {
  const input = clampScenario(rawInput);
  const groupDrag = 1 + Math.max(0, input.groupSize - 4) * 0.025;
  const accessibilityPause = 1 + input.accessibilityPriority * 0.0015;
  const durationMinutes = Math.round(
    analysis.totalDwellMinutes * PACE_MULTIPLIER[input.pace] * groupDrag * accessibilityPause,
  );
  const seatedNeeds = state.artifacts.filter(
    (artifact) => artifact.accessibilityNeed === 'seating',
  ).length;
  const audioNeeds = state.artifacts.filter(
    (artifact) => artifact.accessibilityNeed === 'audio',
  ).length;
  const tactileNeeds = state.artifacts.filter(
    (artifact) => artifact.accessibilityNeed === 'tactile-alternative',
  ).length;
  const accessibleObjects = state.artifacts.length - seatedNeeds - audioNeeds - tactileNeeds;
  const baseAccessibility = state.artifacts.length
    ? (accessibleObjects / state.artifacts.length) * 100
    : 100;
  const seatingCoverage = state.zones.length
    ? (state.zones.filter((zone) => zone.hasSeating).length / state.zones.length) * 100
    : 100;
  const accessibilityScore = Math.round(
    Math.min(
      100,
      baseAccessibility * 0.55 + seatingCoverage * 0.45 + input.accessibilityPriority * 0.12,
    ),
  );
  const pressureThreshold = input.groupSize >= 10 ? 0.7 : input.groupSize >= 6 ? 0.82 : 0.95;
  const pressureZoneIds = analysis.zones
    .filter((zone) => Math.max(zone.utilization, zone.objectUtilization) >= pressureThreshold)
    .map((zone) => zone.zoneId);
  const comfortScore = Math.max(
    0,
    Math.round(100 - pressureZoneIds.length * 16 - Math.max(0, input.groupSize - 8) * 2),
  );
  const narrativeScore = Math.round(analysis.roleCoverage * 65 + analysis.keyObjectCoverage * 35);
  const recommendations: string[] = [];

  if (pressureZoneIds.length)
    recommendations.push('Redistribute objects from pressure zones before increasing group size.');
  if (accessibilityScore < 75)
    recommendations.push('Add seating or alternative interpretation to improve access coverage.');
  if (narrativeScore < 100)
    recommendations.push(
      'Place missing key objects and narrative roles to complete the story arc.',
    );
  if (durationMinutes > 55)
    recommendations.push('Offer a short-route cue for visitors with limited time.');
  if (recommendations.length === 0)
    recommendations.push(
      'This scenario is balanced across duration, access, and narrative coverage.',
    );

  return {
    durationMinutes,
    comfortScore,
    accessibilityScore,
    narrativeScore,
    pressureZoneIds,
    recommendations,
  };
}
