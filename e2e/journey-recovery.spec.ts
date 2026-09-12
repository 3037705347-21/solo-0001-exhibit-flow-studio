import { test, expect } from '@playwright/test';

test('removing a placement is a recoverable transaction', async ({ page }) => {
  await page.goto('/journey');

  // The seed journey has the Letterpress first in "The Common Thread".
  const letterpress = page.getByText('Portable Letterpress').first();
  await expect(letterpress).toBeVisible();

  await page.getByRole('button', { name: 'Remove Portable Letterpress' }).click();

  // Confirmation dialog shows the captured source placement and neighbours.
  const dialog = page.getByRole('dialog', { name: /Remove Portable Letterpress/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('The Common Thread')).toBeVisible();
  await expect(dialog.getByText(/Rain Map Quilt/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Remove to recovery list' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Removed placements')).toBeVisible();

  // The held record restores to the exact original slot, in front of the quilt.
  const held = page.locator('.recovery-item').first();
  await expect(held).toContainText('Portable Letterpress');
  await held.getByRole('button', { name: 'Restore placement' }).click();
  await expect(page.locator('.recovery-item')).toHaveCount(0);

  const lane = page.locator('.zone-lane', { hasText: 'The Common Thread' }).first();
  const titles = await lane.locator('.placement-info strong').allInnerTexts();
  expect(titles).toEqual(['Portable Letterpress', 'Rain Map Quilt']);

  // A second restore is impossible: the record is gone, no duplicate placement.
  expect(titles.filter((title) => title === 'Portable Letterpress')).toHaveLength(1);
});

test('a restore conflict keeps the record for review instead of overwriting', async ({ page }) => {
  await page.goto('/journey');

  await page.getByRole('button', { name: 'Remove Rain Map Quilt' }).click();
  await page.getByRole('button', { name: 'Remove to recovery list' }).click();

  // Re-place the quilt manually in a different low-light zone, making the
  // original recovery record stale.
  await page.getByRole('button', { name: /Rain Map Quilt/ }).first().click();
  const patternsLane = page.locator('.zone-lane', { hasText: 'Patterns of Work' }).first();
  await patternsLane.getByRole('button', { name: /Place Rain Map Quilt here/ }).click();
  await expect(patternsLane).toContainText('Rain Map Quilt');

  const held = page.locator('.recovery-item').first();
  await held.getByRole('button', { name: 'Restore placement' }).click();
  await expect(held).toContainText('Already placed elsewhere');
  await expect(held).toContainText(/kept without overwriting/);

  // The original placement in Common Thread is untouched; no duplicate is made.
  const commonLane = page.locator('.zone-lane', { hasText: 'The Common Thread' }).first();
  await expect(commonLane).not.toContainText('Rain Map Quilt');
});
