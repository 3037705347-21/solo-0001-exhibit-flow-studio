import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTransientNotice } from './useTransientNotice';

afterEach(() => {
  vi.useRealTimers();
});

describe('useTransientNotice', () => {
  it('starts empty, shows a message, and clears it after the duration', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientNotice(2600));
    expect(result.current.notice).toBeNull();

    act(() => result.current.notify('Zone checklist downloaded.'));
    expect(result.current.notice).toBe('Zone checklist downloaded.');

    act(() => vi.advanceTimersByTime(2599));
    expect(result.current.notice).toBe('Zone checklist downloaded.');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.notice).toBeNull();
  });
});
