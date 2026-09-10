import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { REVIEW_UI_KEY } from '../../../state/persistence';
import { useReviewFilters } from './useReviewFilters';

afterEach(() => {
  localStorage.clear();
});

describe('useReviewFilters', () => {
  it('defaults to the overview with the all-status filter', () => {
    const { result } = renderHook(() => useReviewFilters());
    expect(result.current.zoneId).toBe('');
    expect(result.current.status).toBe('all');
  });

  it('restores the zone and status filters from the existing storage key', () => {
    localStorage.setItem(REVIEW_UI_KEY, JSON.stringify({ zoneId: 'zone-common', status: 'resolved' }));
    const { result } = renderHook(() => useReviewFilters());
    expect(result.current.zoneId).toBe('zone-common');
    expect(result.current.status).toBe('resolved');
  });

  it('persists zone and status changes back under the same key', () => {
    const { result } = renderHook(() => useReviewFilters());

    act(() => result.current.setZoneId('zone-arrival'));
    expect(JSON.parse(localStorage.getItem(REVIEW_UI_KEY)!)).toEqual({ zoneId: 'zone-arrival', status: 'all' });

    act(() => result.current.setStatus('open'));
    expect(JSON.parse(localStorage.getItem(REVIEW_UI_KEY)!)).toEqual({ zoneId: 'zone-arrival', status: 'open' });
    expect(result.current.zoneId).toBe('zone-arrival');
    expect(result.current.status).toBe('open');
  });
});
