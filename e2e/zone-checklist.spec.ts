import { expect, test } from '@playwright/test';

test('filter by zone, download the floor checklist, and keep the filter after reload', async ({ page }) => {
  await page.goto('/review');

  // The floor checklist only appears once a zone is selected.
  await expect(page.getByRole('button', { name: 'Download current state (CSV)' })).toHaveCount(0);

  await page.getByLabel('Exhibition zone').selectOption('zone-common');

  const card = page.getByRole('region', { name: 'Zone checklist' });
  await expect(card.getByRole('heading', { name: 'The Common Thread' })).toBeVisible();
  // Objects are listed in visit order with dwell time.
  await expect(card.getByText('Portable Letterpress')).toBeVisible();
  await expect(card.getByText('Rain Map Quilt')).toBeVisible();
  await expect(card.getByText('15 min')).toBeVisible();

  // Download produces a CSV file.
  const downloadPromise = page.waitForEvent('download');
  await card.getByRole('button', { name: 'Download current state (CSV)' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/exhibit-flow-zone-checklist-common-thread-.*\.csv/);

  // The selected zone survives a page refresh.
  await page.reload();
  await expect(page.getByLabel('Exhibition zone')).toHaveValue('zone-common');
  await expect(card.getByRole('heading', { name: 'The Common Thread' })).toBeVisible();

  // Switching back to all zones restores the overview and hides the checklist.
  await page.getByLabel('Exhibition zone').selectOption('');
  await expect(page.getByRole('button', { name: 'Download current state (CSV)' })).toHaveCount(0);
});
