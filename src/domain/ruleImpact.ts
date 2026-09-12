import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import { bindingKey, diffRuleParameters, type RuleChange, type RuleProfile } from './ruleProfiles';
import type { JourneyAnalysis, ReadinessResult, WorkspaceState } from './models';

export type ImpactTone = 'better' | 'worse' | 'neutral';

export interface ImpactItem {
  tone: ImpactTone;
  text: string;
}

export interface RuleImpactReport {
  fromArchive: string;
  toArchive: string;
  parameterChanges: RuleChange[];
  fromAnalysis: JourneyAnalysis;
  toAnalysis: JourneyAnalysis;
  fromReadiness: ReadinessResult;
  toReadiness: ReadinessResult;
  /** Constraint findings that exist under the candidate rules but not today. */
  newBlockers: string[];
  clearedBlockers: string[];
  newWarnings: string[];
  clearedWarnings: string[];
  outcome: ImpactItem;
  scoreChange: ImpactItem;
  items: ImpactItem[];
  /** True when the current plan would no longer be ready under the candidate. */
  regresses: boolean;
  improves: boolean;
}

function findingKeys(analysis: JourneyAnalysis, type: 'error' | 'warning'): Map<string, string> {
  const entries = analysis.findings
    .filter((finding) => finding.type === type)
    .map((finding) => [finding.id, finding.title] as const);
  return new Map(entries);
}

function titlesDiff(current: Map<string, string>, next: Map<string, string>): string[] {
  const added: string[] = [];
  for (const [id, title] of next) {
    if (!current.has(id)) added.push(title);
  }
  return added;
}

/** Findings that swap severity, e.g. a warning promoted to a blocking error. */
function severitySwapped(from: JourneyAnalysis, to: JourneyAnalysis, target: 'error' | 'warning'): string[] {
  const fromById = new Map(from.findings.map((finding) => [finding.id, finding]));
  return to.findings
    .filter((finding) => finding.type === target && fromById.get(finding.id)?.type && fromById.get(finding.id)?.type !== target)
    .map((finding) => finding.title);
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items));
}

/**
 * Dry-run the current plan against a candidate archive version without
 * mutating anything. Used before a project is switched or rules are edited,
 * so the effect on the current plan is always shown first.
 */
export function previewRuleImpact(state: WorkspaceState, current: RuleProfile, candidate: RuleProfile, at = new Date()): RuleImpactReport {
  const fromArchive = { profileId: current.profileId, version: current.version, name: current.name };
  const toArchive = { profileId: candidate.profileId, version: candidate.version, name: candidate.name };
  const fromAnalysis = analyzeJourney(state.artifacts, state.zones, current.parameters, fromArchive);
  const toAnalysis = analyzeJourney(state.artifacts, state.zones, candidate.parameters, toArchive);
  const fromReadiness = evaluateReadiness(state, fromAnalysis, current, at);
  const toReadiness = evaluateReadiness(state, toAnalysis, candidate, at);

  const fromErrors = findingKeys(fromAnalysis, 'error');
  const toErrors = findingKeys(toAnalysis, 'error');
  const fromWarnings = findingKeys(fromAnalysis, 'warning');
  const toWarnings = findingKeys(toAnalysis, 'warning');

  const newBlockers = dedupe([...titlesDiff(fromErrors, toErrors), ...severitySwapped(fromAnalysis, toAnalysis, 'error')]);
  const clearedBlockers = dedupe([...titlesDiff(toErrors, fromErrors), ...severitySwapped(toAnalysis, fromAnalysis, 'error')]);
  const newWarnings = dedupe([...titlesDiff(fromWarnings, toWarnings), ...severitySwapped(fromAnalysis, toAnalysis, 'warning')]);
  const clearedWarnings = dedupe([...titlesDiff(toWarnings, fromWarnings), ...severitySwapped(toAnalysis, fromAnalysis, 'warning')]);

  const scoreDelta = toReadiness.score - fromReadiness.score;
  const regresses = (!toReadiness.ready && fromReadiness.ready) || newBlockers.length > 0 || scoreDelta < 0;
  const improves = (toReadiness.ready && !fromReadiness.ready) || clearedBlockers.length > 0 || scoreDelta > 0;

  const items: ImpactItem[] = [];
  newBlockers.forEach((title) => items.push({ tone: 'worse', text: `New blocking condition: ${title}` }));
  clearedBlockers.forEach((title) => items.push({ tone: 'better', text: `No longer blocking: ${title}` }));
  newWarnings.forEach((title) => items.push({ tone: 'worse', text: `New warning: ${title}` }));
  clearedWarnings.forEach((title) => items.push({ tone: 'better', text: `Warning cleared: ${title}` }));

  let outcome: ImpactItem;
  if (toReadiness.ready && !fromReadiness.ready) {
    outcome = { tone: 'better', text: 'The current plan would become ready under the candidate archive.' };
  } else if (!toReadiness.ready && fromReadiness.ready) {
    outcome = { tone: 'worse', text: 'The currently ready plan would become blocked under the candidate archive.' };
  } else if (toReadiness.ready) {
    outcome = { tone: 'neutral', text: 'The plan stays ready under the candidate archive.' };
  } else {
    outcome = { tone: 'neutral', text: `The plan stays blocked with ${toReadiness.blockers.length} blocker${toReadiness.blockers.length === 1 ? '' : 's'}.` };
  }

  const scoreChange: ImpactItem = scoreDelta === 0
    ? { tone: 'neutral', text: `Readiness score unchanged at ${toReadiness.score}.` }
    : {
      tone: scoreDelta > 0 ? 'better' : 'worse',
      text: `Readiness score moves ${scoreDelta > 0 ? 'up' : 'down'} from ${fromReadiness.score} to ${toReadiness.score}.`,
    };

  return {
    fromArchive: bindingKey({ profileId: current.profileId, version: current.version }),
    toArchive: bindingKey({ profileId: candidate.profileId, version: candidate.version }),
    parameterChanges: diffRuleParameters(current.parameters, candidate.parameters),
    fromAnalysis,
    toAnalysis,
    fromReadiness,
    toReadiness,
    newBlockers,
    clearedBlockers,
    newWarnings,
    clearedWarnings,
    outcome,
    scoreChange,
    items,
    regresses,
    improves,
  };
}
