import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { WorkspaceProvider, useWorkspace } from './WorkspaceContext';
import { JOURNAL_KEY, readJournal } from './journal';
import { createSeedWorkspace } from './seed';
import type { ArtifactDraft } from '../domain/models';

const validDraft: ArtifactDraft = {
  accessionId: 'AF-2026-100',
  title: 'Integration Lantern',
  maker: 'Test Maker',
  yearLabel: '2026',
  medium: 'Brass',
  origin: 'Lab',
  summary: 'A fully described object created through the public command surface.',
  width: '12',
  height: '18',
  depth: '8',
  dwellMinutes: '5',
  narrativeRole: 'reflection',
  sensitivity: 'standard',
  accessibilityNeed: 'none',
  isKeyObject: false,
  tags: '',
  color: '#333333',
};

function wrapperWithStorage(storage: Storage) {
  return function Wrapper({ children }: { children: ReactNode }) {
    // The provider reads global localStorage; swap it for the controlled double.
    Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
    return <WorkspaceProvider>{children}</WorkspaceProvider>;
  };
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => { values.clear(); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  } as unknown as Storage;
}

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true, writable: true });
});

describe('WorkspaceProvider recovery integration', () => {
  it('normal startup: commands land in the journal and survive remount', () => {
    const storage = memoryStorage();
    const wrapper = wrapperWithStorage(storage);
    const { result, unmount } = renderHook(() => useWorkspace(), { wrapper });

    act(() => {
      const saved = result.current.upsertArtifact(validDraft);
      expect(saved.ok).toBe(true);
    });
    expect(result.current.state.artifacts.some((a) => a.accessionId === 'AF-2026-100')).toBe(true);
    expect(readJournal(storage).records).toHaveLength(1);

    unmount();
    const { result: reloaded } = renderHook(() => useWorkspace(), { wrapper: wrapperWithStorage(storage) });
    expect(reloaded.current.state.artifacts.some((a) => a.accessionId === 'AF-2026-100')).toBe(true);
    expect(reloaded.current.recoveryReport).toBeNull();
  });

  it('simulates a torn write mid-session: journal tail is truncated on next boot', () => {
    const storage = memoryStorage();
    const wrapper = wrapperWithStorage(storage);
    const { result, unmount } = renderHook(() => useWorkspace(), { wrapper });

    act(() => { result.current.upsertArtifact(validDraft); });
    unmount();

    // Browser crashed while a second command was being appended.
    const raw = storage.getItem(JOURNAL_KEY) ?? '';
    const torn = `${raw}\n{"id":"cmd-torn","seq":2,"epoch":"epoch`;
    act(() => { storage.setItem(JOURNAL_KEY, torn); });

    const { result: reloaded } = renderHook(() => useWorkspace(), { wrapper: wrapperWithStorage(storage) });
    expect(reloaded.current.recoveryReport?.kind).toBe('recovered-torn-log');
    expect(reloaded.current.state.artifacts.some((a) => a.accessionId === 'AF-2026-100')).toBe(true);
  });

  it('simulates a duplicated log line: the command applies once and a duplicate is reported', () => {
    const storage = memoryStorage();
    const wrapper = wrapperWithStorage(storage);
    const { result, unmount } = renderHook(() => useWorkspace(), { wrapper });
    act(() => { result.current.upsertArtifact(validDraft); });
    unmount();

    const lines = (storage.getItem(JOURNAL_KEY) ?? '').split('\n');
    storage.setItem(JOURNAL_KEY, [...lines, lines[0]].join('\n'));

    const { result: reloaded } = renderHook(() => useWorkspace(), { wrapper: wrapperWithStorage(storage) });
    expect(reloaded.current.recoveryReport?.duplicates.length).toBeGreaterThan(0);
    expect(reloaded.current.state.artifacts.filter((a) => a.accessionId === 'AF-2026-100')).toHaveLength(1);
  });

  it('simulates an invalid (unreplayable) journal record: breakpoint holds later commands back', () => {
    const storage = memoryStorage();
    const wrapper = wrapperWithStorage(storage);
    const { result, unmount } = renderHook(() => useWorkspace(), { wrapper });
    act(() => { result.current.upsertArtifact(validDraft); });
    unmount();

    const goodLine = (storage.getItem(JOURNAL_KEY) ?? '').split('\n')[0];
    const goodRecord = JSON.parse(goodLine);
    const bad = {
      id: 'cmd-bad',
      seq: 2,
      epoch: goodRecord.epoch,
      at: '2026-09-10T12:00:00.000Z',
      action: { type: 'placement/assign', artifactId: 'artifact-does-not-exist', zoneId: 'zone-arrival' },
    };
    const later = {
      id: 'cmd-later',
      seq: 3,
      epoch: goodRecord.epoch,
      at: '2026-09-10T12:01:00.000Z',
      action: { type: 'artifact/remove', artifactId: 'artifact-lantern' },
    };
    storage.setItem(JOURNAL_KEY, [goodLine, JSON.stringify(bad), JSON.stringify(later)].join('\n'));

    const { result: reloaded } = renderHook(() => useWorkspace(), { wrapper: wrapperWithStorage(storage) });
    const report = reloaded.current.recoveryReport;
    expect(report?.kind).toBe('breakpoint');
    expect(report?.breakpoint?.commandId).toBe('cmd-bad');
    expect(report?.commandsAfterBreakpoint).toBe(1);
    // Earlier command restored; later command not applied.
    expect(reloaded.current.state.artifacts.some((a) => a.accessionId === 'AF-2026-100')).toBe(true);
    expect(reloaded.current.state.artifacts.some((a) => a.id === 'artifact-lantern')).toBe(true);
  });

  it('reset produces no reset command and post-reset work survives a remount', () => {
    const storage = memoryStorage();
    const wrapper = wrapperWithStorage(storage);
    const { result, unmount } = renderHook(() => useWorkspace(), { wrapper });
    act(() => { result.current.upsertArtifact(validDraft); });
    act(() => {
      const reset = result.current.resetWorkspace();
      expect(reset.ok).toBe(true);
    });
    expect(storage.getItem(JOURNAL_KEY)).toBeNull();
    expect(result.current.state.artifacts.map((a) => a.id)).toEqual(createSeedWorkspace().artifacts.map((a) => a.id));
    unmount();

    const { result: reloaded } = renderHook(() => useWorkspace(), { wrapper: wrapperWithStorage(storage) });
    expect(reloaded.current.state.artifacts.some((a) => a.accessionId === 'AF-2026-100')).toBe(false);
    expect(reloaded.current.recoveryReport).toBeNull();
  });

  it('preferences applied without changes create no journal entries', () => {
    const storage = memoryStorage();
    const { result } = renderHook(() => useWorkspace(), { wrapper: wrapperWithStorage(storage) });
    act(() => { result.current.updatePreferences(result.current.state.preferences); });
    expect(readJournal(storage).records).toHaveLength(0);
  });

  it('renders the recovery banner when a breakpoint exists', () => {
    const storage = memoryStorage();
    const wrapper = wrapperWithStorage(storage);
    const { result, unmount } = renderHook(() => useWorkspace(), { wrapper });
    act(() => { result.current.upsertArtifact(validDraft); });
    unmount();

    const goodLine = (storage.getItem(JOURNAL_KEY) ?? '').split('\n')[0];
    const goodRecord = JSON.parse(goodLine);
    const bad = JSON.stringify({
      id: 'cmd-bad',
      seq: 2,
      epoch: goodRecord.epoch,
      at: '2026-09-10T12:00:00.000Z',
      action: { type: 'placement/assign', artifactId: 'nope', zoneId: 'zone-arrival' },
    });
    storage.setItem(JOURNAL_KEY, `${goodLine}\n${bad}`);

    function BannerProbe() {
      const { recoveryReport } = useWorkspace();
      return recoveryReport ? <div data-testid="banner">{recoveryReport.detail}</div> : null;
    }
    const screen = render(<WorkspaceProvider><BannerProbe /></WorkspaceProvider>);
    expect(screen.getByTestId('banner').textContent).toMatch(/Recovery stopped/);
    screen.unmount();
  });
});
