import { useCallback, useEffect, useState } from 'react';
import { loadReviewUi, saveReviewUi, type ReviewUiState } from '../../../state/persistence';
import type { StatusFilter } from '../findings/findingScope';

/**
 * Holds the zone + status filters and restores/persists them through the same
 * localStorage key as the previous inline implementation.
 */
export function useReviewFilters(): {
  zoneId: string;
  status: StatusFilter;
  setZoneId: (zoneId: string) => void;
  setStatus: (status: StatusFilter) => void;
} {
  const [reviewUi, setReviewUi] = useState<ReviewUiState>(() => loadReviewUi());

  useEffect(() => { saveReviewUi(reviewUi); }, [reviewUi]);

  const setZoneId = useCallback((zoneId: string) => {
    setReviewUi((ui) => ({ ...ui, zoneId }));
  }, []);
  const setStatus = useCallback((status: StatusFilter) => {
    setReviewUi((ui) => ({ ...ui, status }));
  }, []);

  return { zoneId: reviewUi.zoneId, status: reviewUi.status, setZoneId, setStatus };
}
