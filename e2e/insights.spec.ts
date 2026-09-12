import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'exhibit-flow.workspace.v1';

test.beforeEach(async ({ page }) => {
  // Start from the sample plan once per test. The session flag keeps the data
  // intact across in-test full navigations and reloads (a new test gets a new
  // context, so the flag resets automatically).
  await page.addInitScript((key) => {
    if (!window.sessionStorage.getItem('__insights_seeded__')) {
      window.localStorage.removeItem(key);
      window.sessionStorage.setItem('__insights_seeded__', '1');
    }
  }, STORAGE_KEY);
});

async function saveComparison(page: import('@playwright/test').Page, name: string, groupSize: number) {
  await page.getByLabel('Group size').fill(String(groupSize));
  await page.getByRole('button', { name: 'Save comparison' }).click();
  await page.getByTestId('comparison-name-input').fill(name);
  await page.getByTestId('save-comparison-confirm').click();
}

test('compare and apply a visitor scenario', async ({ page }) => {
  await page.goto('/insights');
  await page.getByRole('button', { name: 'Leisurely' }).click();
  await page.getByLabel('Group size').fill('12');
  await expect(page.getByText('Leisurely visit')).toBeVisible();
  await page.getByRole('button', { name: 'Apply preferences' }).click();
  await expect(page.getByText('Planning preferences applied.')).toBeVisible();
});

test.describe('replayable scenario comparisons', () => {
  test('saves a named immutable comparison and replays it side by side', async ({ page }) => {
    await page.goto('/insights');
    await page.getByRole('button', { name: 'Leisurely' }).click();
    await saveComparison(page, 'Leisurely crowd test', 14);

    await expect(page.getByText(/Comparison .Leisurely crowd test. saved/)).toBeVisible();
    const card = page.getByTestId('comparison-card').filter({ hasText: 'Leisurely crowd test' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Current basis')).toBeVisible();

    // Open the frozen record and verify the side-by-side replay.
    await card.getByRole('button', { name: 'Replay' }).click();
    const dialog = page.getByRole('dialog', { name: 'Leisurely crowd test' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Basis current')).toBeVisible();
    await expect(dialog.getByText('SAVED OUTCOME — IMMUTABLE')).toBeVisible();
    await expect(dialog.getByText('SAME INPUTS ON CURRENT PLAN')).toBeVisible();
    await expect(dialog.getByTestId('replay-stale-notice')).toHaveCount(0);

    // The lab loads the saved inputs but keeps the record intact.
    await page.getByTestId('replay-load-inputs').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Saved inputs loaded into the lab.')).toBeVisible();
    await expect(page.getByTestId('comparison-card')).toHaveCount(1);
  });

  test('marks old records as basis-changed after the plan changes, without replacing results', async ({ page }) => {
    await page.goto('/insights');
    await saveComparison(page, 'Baseline run', 6);
    const card = page.getByTestId('comparison-card').filter({ hasText: 'Baseline run' });
    const basisBefore = (await card.locator('.comparison-basis').textContent()) ?? '';
    const outcomeBefore = (await card.locator('.comparison-outcomes').textContent()) ?? '';

    // Change the plan by removing a placement on the journey board.
    await page.goto('/journey');
    await page.getByRole('button', { name: /^Remove / }).first().click();

    await page.goto('/insights');
    await expect(card.getByText('Basis changed')).toBeVisible();

    // The frozen outcome on the card is unchanged.
    const outcomeAfter = (await card.locator('.comparison-outcomes').textContent()) ?? '';
    expect(outcomeAfter).toBe(outcomeBefore);

    await card.getByRole('button', { name: 'Replay' }).click();
    const dialog = page.getByRole('dialog', { name: 'Baseline run' });
    await expect(dialog.getByTestId('replay-stale-notice')).toBeVisible();
    await expect(dialog.getByText('The plan changed since this comparison was saved.')).toBeVisible();

    // The saved side still shows the original plan version basis.
    expect((await dialog.locator('.replay-frozen').textContent()) ?? '').toContain(basisBefore.match(/v[0-9a-f]{6}/)?.[0] ?? '');
    await expect(dialog.locator('.replay-current').getByText('Live replay')).toBeVisible();

    // The frozen duration is preserved while the current-plan replay recomputes
    // from the shorter journey instead of silently overwriting the saved result.
    const frozenDuration = (await dialog.locator('.replay-frozen dd').first().textContent()) ?? '';
    const liveDuration = (await dialog.locator('.replay-current dd').first().textContent()) ?? '';
    expect(frozenDuration).not.toBe(liveDuration);
  });

  test('rejects duplicate names and identical inputs on the same plan version', async ({ page }) => {
    await page.goto('/insights');
    await saveComparison(page, 'Weekend profile', 8);

    // Same normalized name, different casing/whitespace.
    await page.getByRole('button', { name: 'Save comparison' }).click();
    await page.getByTestId('comparison-name-input').fill('  weekend PROFILE ');
    await page.getByTestId('save-comparison-confirm').click();
    await expect(page.getByText('A comparison with this name already exists. Choose another name.')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Different name but identical inputs on the same plan version.
    await page.getByRole('button', { name: 'Save comparison' }).click();
    await page.getByTestId('comparison-name-input').fill('Same inputs again');
    await page.getByTestId('save-comparison-confirm').click();
    await expect(page.getByText(/already saved as/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Only the first record exists.
    await expect(page.getByTestId('comparison-card')).toHaveCount(1);

    // Distinct inputs with a distinct name are accepted.
    await saveComparison(page, 'Small focused run', 2);
    await expect(page.getByTestId('comparison-card')).toHaveCount(2);
  });

  test('deletes a comparison after confirmation and survives refresh otherwise', async ({ page }) => {
    await page.goto('/insights');
    await saveComparison(page, 'Keep after refresh', 5);
    await expect(page.getByTestId('comparison-card')).toHaveCount(1);

    // Refresh keeps the record.
    await page.reload();
    await expect(page.getByTestId('comparison-card').filter({ hasText: 'Keep after refresh' })).toBeVisible();

    // Cancelling the confirm dialog keeps the record.
    await page.getByRole('button', { name: 'Replay' }).click();
    await page.getByTestId('replay-delete').click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('comparison-card')).toHaveCount(1);

    // Confirming deletion removes the record.
    await page.getByRole('button', { name: 'Replay' }).click();
    await page.getByTestId('replay-delete').click();
    await page.getByTestId('confirm-delete').click();
    await expect(page.getByText('Comparison deleted.')).toBeVisible();
    await expect(page.getByTestId('comparison-card')).toHaveCount(0);

    // Deletion persists across refresh.
    await page.reload();
    await expect(page.getByText('No comparisons saved yet')).toBeVisible();
  });
});
