import { describe, expect, it } from 'vitest';
import { prepareIssueEdit, type IssueEditInput } from '../domain/issueRevisions';
import { analyzeJourney } from '../domain/journeyAnalysis';
import type { IssueDraft, ReviewIssue, WorkspaceState } from '../domain/models';
import { evaluateReadiness } from '../domain/reviewRules';
import { buildZoneChecklist } from '../domain/zoneChecklist';
import { workspaceReducer } from './reducer';
import { createSeedWorkspace } from './seed';
import { selectIssuesForZone } from './selectors';

function draftOf(issue: ReviewIssue, overrides: Partial<IssueDraft> = {}): IssueDraft {
  return {
    title: issue.title,
    description: issue.description,
    severity: issue.severity,
    owner: issue.owner,
    zoneId: issue.zoneId ?? '',
    artifactId: issue.artifactId ?? '',
    ...overrides,
  };
}

function commitEdit(state: WorkspaceState, issueId: string, overrides: Partial<IssueDraft>): WorkspaceState {
  const base = state.issues.find((issue) => issue.id === issueId)!;
  const input: IssueEditInput = { issueId, base, draft: draftOf(base, overrides), editor: 'Jo Renner', rationale: 'Re-scoped after review.' };
  const result = prepareIssueEdit(base, input);
  if (result.kind !== 'committed') throw new Error(`expected a committed edit, got ${result.kind}`);
  return workspaceReducer(state, { type: 'issue/revise', issue: result.issue, revision: result.revision });
}

describe('issue edit effects on derived views', () => {
  it('moves a finding between zone filters when its zone link changes', () => {
    const state = createSeedWorkspace();
    expect(selectIssuesForZone(state, 'zone-arrival').map((issue) => issue.id)).toContain('issue-entry-copy');
    expect(selectIssuesForZone(state, 'zone-common').map((issue) => issue.id)).not.toContain('issue-entry-copy');
    const next = commitEdit(state, 'issue-entry-copy', { zoneId: 'zone-common' });
    expect(selectIssuesForZone(next, 'zone-arrival').map((issue) => issue.id)).not.toContain('issue-entry-copy');
    expect(selectIssuesForZone(next, 'zone-common').map((issue) => issue.id)).toContain('issue-entry-copy');
  });

  it('rebuilds the zone checklist when a linked object or zone changes', () => {
    const state = createSeedWorkspace();
    const before = buildZoneChecklist(state, 'zone-after')!;
    expect(before.unresolvedCount).toBe(1);
    expect(before.entries.find((entry) => entry.artifactId === 'artifact-tape')!.unresolvedFindings.length).toBeGreaterThan(0);
    // Re-link the transcript finding to the lantern in the arrival zone.
    const next = commitEdit(state, 'issue-audio-transcript', { zoneId: 'zone-arrival', artifactId: 'artifact-lantern' });
    const afterZone = buildZoneChecklist(next, 'zone-after')!;
    expect(afterZone.unresolvedCount).toBe(0);
    expect(afterZone.entries.find((entry) => entry.artifactId === 'artifact-tape')!.unresolvedFindings).toHaveLength(0);
    const arrival = buildZoneChecklist(next, 'zone-arrival')!;
    expect(arrival.entries.find((entry) => entry.artifactId === 'artifact-lantern')!.unresolvedFindings.some((finding) => finding.title.includes('transcript'))).toBe(true);
  });

  it('updates the readiness result when severity or status changes through an edit', () => {
    const state = createSeedWorkspace();
    const blocked = evaluateReadiness(state, analyzeJourney(state.artifacts, state.zones));
    expect(blocked.ready).toBe(false);
    expect(blocked.blockers.some((blocker) => blocker.includes('critical'))).toBe(true);
    // Downgrade the only critical finding to a note: the critical blocker disappears.
    const next = commitEdit(state, 'issue-audio-transcript', { severity: 'note' });
    const reevaluated = evaluateReadiness(next, analyzeJourney(next.artifacts, next.zones));
    expect(reevaluated.blockers.some((blocker) => blocker.includes('critical'))).toBe(false);
    expect(reevaluated.ready).toBe(true);
  });
});
