import { describe, expect, it } from 'vitest';
import { computePlanVersion, createScenarioRecord } from '../domain/scenarioRecords';
import type { WorkspaceState } from '../domain/models';
import { createSeedWorkspace } from './seed';
import { workspaceReducer } from './reducer';

const fixedId = () => 'scenario-fixed';

function saveRecord(state: WorkspaceState, name: string, input = { pace: 'leisurely' as const, groupSize: 14, accessibilityPriority: 80 }) {
  const built = createScenarioRecord(state, { name, input }, fixedId);
  if (!built.record) throw new Error(built.errors.map((error) => error.message).join('; '));
  return workspaceReducer(state, { type: 'scenarioRecord/save', record: built.record });
}

describe('scenario record reducer commands', () => {
  it('appends records immutably without touching existing records', () => {
    const seed = createSeedWorkspace();
    const withFirst = saveRecord(seed, 'First');
    const firstRecord = withFirst.scenarioRecords[0];

    const secondInput = { pace: 'focused' as const, groupSize: 3, accessibilityPriority: 20 };
    const built = createScenarioRecord(withFirst, { name: 'Second', input: secondInput }, () => 'scenario-second');
    if (!built.record) throw new Error('second record failed');
    const withSecond = workspaceReducer(withFirst, { type: 'scenarioRecord/save', record: built.record });

    expect(withSecond.scenarioRecords).toHaveLength(2);
    expect(withFirst.scenarioRecords[0]).toEqual(firstRecord);
    expect(withSecond.scenarioRecords[0]).toBe(firstRecord);
  });

  it('refuses to overwrite a record with the same id', () => {
    const seed = createSeedWorkspace();
    const withFirst = saveRecord(seed, 'First');
    const firstRecord = withFirst.scenarioRecords[0]!;
    expect(() => workspaceReducer(withFirst, { type: 'scenarioRecord/save', record: firstRecord })).toThrow(/already saved/);
  });

  it('refuses a duplicate name even when casing differs', () => {
    const seed = createSeedWorkspace();
    const withFirst = saveRecord(seed, 'Busy Saturday');
    const built = createScenarioRecord(
      { ...withFirst, scenarioRecords: [] },
      { name: 'busy saturday', input: { pace: 'focused', groupSize: 2, accessibilityPriority: 10 } },
      () => 'scenario-other',
    );
    if (!built.record) throw new Error('record should build');
    const record = built.record;
    expect(() => workspaceReducer(withFirst, { type: 'scenarioRecord/save', record })).toThrow(/name already exists/);
  });

  it('refuses identical inputs on the same plan version', () => {
    const seed = createSeedWorkspace();
    const withFirst = saveRecord(seed, 'First');
    const built = createScenarioRecord(
      { ...withFirst, scenarioRecords: [] },
      { name: 'Different name', input: { pace: 'leisurely', groupSize: 14, accessibilityPriority: 80 } },
      () => 'scenario-other',
    );
    if (!built.record) throw new Error('record should build');
    const record = built.record;
    expect(() => workspaceReducer(withFirst, { type: 'scenarioRecord/save', record })).toThrow(/already saved/);
  });

  it('removes only the targeted record', () => {
    const seed = createSeedWorkspace();
    const withFirst = saveRecord(seed, 'First');
    const built = createScenarioRecord(withFirst, { name: 'Second', input: { pace: 'focused', groupSize: 3, accessibilityPriority: 20 } }, () => 'scenario-second');
    if (!built.record) throw new Error('second record failed');
    const withTwo = workspaceReducer(withFirst, { type: 'scenarioRecord/save', record: built.record });

    const afterRemove = workspaceReducer(withTwo, { type: 'scenarioRecord/remove', recordId: 'scenario-fixed' });
    expect(afterRemove.scenarioRecords.map((record) => record.name)).toEqual(['Second']);
  });

  it('is a no-op when removing an unknown record', () => {
    const seed = createSeedWorkspace();
    const withFirst = saveRecord(seed, 'First');
    expect(workspaceReducer(withFirst, { type: 'scenarioRecord/remove', recordId: 'missing' })).toBe(withFirst);
  });

  it('keeps records intact when preferences change and plan version stays stable', () => {
    const seed = createSeedWorkspace();
    const withFirst = saveRecord(seed, 'First');
    const versionBefore = computePlanVersion(withFirst.artifacts, withFirst.zones);
    const updated = workspaceReducer(withFirst, {
      type: 'preferences/update',
      preferences: { pace: 'focused', groupSize: 2, accessibilityPriority: 0 },
    });
    expect(updated.scenarioRecords).toEqual(withFirst.scenarioRecords);
    expect(computePlanVersion(updated.artifacts, updated.zones)).toBe(versionBefore);
  });
});
