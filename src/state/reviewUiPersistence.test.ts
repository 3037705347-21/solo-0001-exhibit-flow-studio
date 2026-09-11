import { describe, expect, it } from 'vitest';
import { loadReviewUi, REVIEW_UI_KEY, saveReviewUi } from './persistence';
import type { StorageLike } from './testStorage';
import { memoryStorage } from './testStorage';

describe('review UI preferences', () => {
  it('returns the default preferences when nothing is stored', () => {
    const ui = loadReviewUi(memoryStorage());
    expect(ui).toEqual({ zoneId: '', status: 'all' });
  });

  it('keeps an unknown zone id usable by treating it as "all zones" on the page', () => {
    const storage = memoryStorage({
      [REVIEW_UI_KEY]: JSON.stringify({ zoneId: 'zone-renamed-away', status: 'open' }),
    });
    const ui = loadReviewUi(storage);
    // The raw preference is preserved as a string so the page can resolve it
    // to no selected zone (overview) instead of crashing on a missing zone.
    expect(ui.zoneId).toBe('zone-renamed-away');
    expect(ui.status).toBe('open');
  });

  it('falls back to the all filter for an unrecognized status value', () => {
    const storage = memoryStorage({
      [REVIEW_UI_KEY]: JSON.stringify({ zoneId: 'zone-after', status: 'archived' }),
    });
    expect(loadReviewUi(storage)).toEqual({ zoneId: 'zone-after', status: 'all' });
  });

  it('falls back to defaults when the stored payload is malformed', () => {
    const storage = memoryStorage({ [REVIEW_UI_KEY]: 'oops' });
    expect(loadReviewUi(storage)).toEqual({ zoneId: '', status: 'all' });
  });

  it('round trips preferences through storage', () => {
    const storage: StorageLike = memoryStorage();
    saveReviewUi({ zoneId: 'zone-common', status: 'resolved' }, storage);
    expect(loadReviewUi(storage)).toEqual({ zoneId: 'zone-common', status: 'resolved' });
  });
});
