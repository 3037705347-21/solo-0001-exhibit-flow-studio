import { describe, expect, it } from 'vitest';
import { previewRuleImpact } from './ruleImpact';
import { cloneParameters, draftNextVersion, standardRuleProfile } from './ruleProfiles';
import { analyzeJourney } from './journeyAnalysis';
import { evaluateReadiness } from './reviewRules';
import { createSeedWorkspace } from '../state/seed';

function archive(rules: ReturnType<typeof standardRuleProfile>) {
  return { profileId: rules.profileId, version: rules.version, name: rules.name };
}

describe('rule impact preview', () => {
  it('reports no change for an identical candidate', () => {
    const state = createSeedWorkspace();
    const v1 = standardRuleProfile();
    const report = previewRuleImpact(state, v1, { ...v1 });
    expect(report.items).toEqual([]);
    expect(report.parameterChanges).toEqual([]);
    expect(report.regresses).toBe(false);
  });

  it('surfaces new warnings when the capacity warning line tightens', () => {
    const state = createSeedWorkspace();
    const v1 = standardRuleProfile();
    const parameters = cloneParameters(v1.parameters);
    parameters.capacityWarnAt = 0.2;
    const v2 = draftNextVersion([v1], v1, { parameters, changeSummary: 'Tight capacity warnings.' });
    const report = previewRuleImpact(state, v1, v2);
    expect(report.newWarnings.length).toBeGreaterThan(0);
    expect(report.regresses).toBe(true);
    expect(report.toAnalysis.warningCount).toBeGreaterThan(report.fromAnalysis.warningCount);
  });

  it('promoting seating to a blocking error creates a blocker on the plan', () => {
    const seed = createSeedWorkspace();
    // Dyer's Sample Book needs seating; remove seating from its zone to create a live conflict.
    const state = {
      ...seed,
      zones: seed.zones.map((zone) => (zone.id === 'zone-patterns' ? { ...zone, hasSeating: false } : zone)),
    };
    const v1 = standardRuleProfile();
    const parameters = cloneParameters(v1.parameters);
    parameters.seatingSeverity = 'error';
    const v2 = draftNextVersion([v1], v1, { parameters, changeSummary: 'Seating now blocks.' });
    const report = previewRuleImpact(state, v1, v2);
    expect(report.newBlockers.some((title) => title.includes('seated interpretation'))).toBe(true);
    expect(report.toReadiness.ready).toBe(false);
    expect(report.fromAnalysis.findings.filter((finding) => finding.id.startsWith('seating-'))[0].type).toBe('warning');
    expect(report.toAnalysis.findings.filter((finding) => finding.id.startsWith('seating-'))[0].type).toBe('error');
  });

  it('shows a ready plan staying ready under an equivalent newer archive', () => {
    const seed = createSeedWorkspace();
    const state = { ...seed, issues: seed.issues.map((issue) => ({ ...issue, status: 'resolved' as const })) };
    const v1 = standardRuleProfile();
    const parameters = cloneParameters(v1.parameters);
    parameters.cautionScorePenalty = 5;
    const v2 = draftNextVersion([v1], v1, { parameters, changeSummary: 'Cosmetic scoring tweak.' });
    const report = previewRuleImpact(state, v1, v2);
    expect(report.fromReadiness.ready).toBe(true);
    expect(report.toReadiness.ready).toBe(true);
    expect(report.outcome.text).toContain('stays ready');
  });

  it('computes readiness pinned to the archive version', () => {
    const state = createSeedWorkspace();
    const v1 = standardRuleProfile();
    const analysis = analyzeJourney(state.artifacts, state.zones, v1.parameters, archive(v1));
    const readiness = evaluateReadiness(state, analysis, v1);
    expect(readiness.ruleArchive).toEqual({ profileId: v1.profileId, version: 1, name: v1.name });
  });
});
