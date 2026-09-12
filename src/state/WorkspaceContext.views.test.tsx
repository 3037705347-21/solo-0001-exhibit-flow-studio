import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CollectionFilter } from '../domain/models';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';

const rules: CollectionFilter = { query: '', roles: ['reflection'], sensitivities: [], keyOnly: false };

function renderWorkspace() {
  const wrapper = ({ children }: { children: ReactNode }) => <WorkspaceProvider>{children}</WorkspaceProvider>;
  return renderHook(() => useWorkspace(), { wrapper });
}

describe('collection view commands', () => {
  beforeEach(() => localStorage.clear());

  it('saves a live view and a frozen list with distinct semantics', () => {
    const { result } = renderWorkspace();
    const live = result.current.saveCollectionView('Reflection live', 'live', rules);
    expect(live.ok, live.message).toBe(true);
    expect(live.value?.kind).toBe('live');
    expect(live.value?.frozenMembers).toBeUndefined();

    const frozen = result.current.saveCollectionView('Reflection issued', 'frozen', rules);
    expect(frozen.ok, frozen.message).toBe(true);
    expect(frozen.value?.kind).toBe('frozen');
    expect(frozen.value?.frozenMembers).toHaveLength(3);
  });

  it('rejects duplicate names across both kinds and empty names', () => {
    const { result, rerender } = renderWorkspace();
    expect(result.current.saveCollectionView('Shared Name', 'live', rules).ok).toBe(true);
    rerender();
    // Same name on a frozen list is rejected — delete/name lookup must never cross kinds.
    const duplicate = result.current.saveCollectionView('shared name', 'frozen', rules);
    expect(duplicate.ok).toBe(false);
    expect(duplicate.errors?.name).toMatch(/already exists/);
    // Case/whitespace difference is still a duplicate.
    rerender();
    expect(result.current.saveCollectionView(' SHARED NAME ', 'frozen', rules).ok).toBe(false);
    // An unused name is accepted.
    rerender();
    expect(result.current.saveCollectionView('Other list', 'frozen', rules).ok).toBe(true);
    // Empty name is rejected.
    rerender();
    expect(result.current.saveCollectionView('   ', 'live', rules).ok).toBe(false);
  });

  it('allows revising a live view but refuses to revise a frozen list', () => {
    const { result, rerender } = renderWorkspace();
    const live = result.current.saveCollectionView('Editable live', 'live', rules);
    const frozen = result.current.saveCollectionView('Stable frozen', 'frozen', rules);
    expect(live.ok && frozen.ok).toBe(true);
    rerender();

    const revised = result.current.reviseCollectionView(live.value!.id, { query: '', roles: ['threshold'], sensitivities: [], keyOnly: false });
    expect(revised.ok, revised.message).toBe(true);
    expect(revised.value?.ruleVersions).toHaveLength(2);

    rerender();
    const blocked = result.current.reviseCollectionView(frozen.value!.id, { query: 'tampered', roles: [], sensitivities: [], keyOnly: false });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toMatch(/frozen list cannot be revised/);

    rerender();
    const storedFrozen = result.current.state.collectionViews.find((view) => view.id === frozen.value!.id);
    expect(storedFrozen?.ruleVersions).toHaveLength(1);
    expect(storedFrozen?.ruleVersions[0].rules.query).toBe('');
  });

  it('deletes a view by id without affecting the other kind', () => {
    const { result, rerender } = renderWorkspace();
    const live = result.current.saveCollectionView('To delete live', 'live', rules);
    const frozen = result.current.saveCollectionView('To keep frozen', 'frozen', rules);
    expect(live.ok && frozen.ok).toBe(true);
    rerender();

    expect(result.current.removeCollectionView(live.value!.id).ok).toBe(true);
    rerender();
    const remaining = result.current.state.collectionViews;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(frozen.value!.id);
    expect(remaining[0].kind).toBe('frozen');
  });
});
