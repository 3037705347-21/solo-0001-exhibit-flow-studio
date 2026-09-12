import { test, expect, type Page } from '@playwright/test';

function lane(page: Page, name: string) {
  return page.locator('.zone-lane').filter({ has: page.getByRole('heading', { name }) });
}

test('swap two objects between zones and keep the result after reload', async ({ page }) => {
  await page.goto('/journey');
  await page.getByRole('button', { name: 'Swap Railway Signal Lantern' }).click();
  await expect(page.getByText(/Swapping Railway Signal Lantern/)).toBeVisible();
  await page.getByRole('button', { name: 'Swap Kitchen Table Radio' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm swap' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('From Arrival / A Light Carried · slot 1')).toBeVisible();
  await expect(dialog.getByText('To Patterns of Work · slot 2')).toBeVisible();
  await expect(dialog.getByText('From Patterns of Work · slot 2')).toBeVisible();
  await expect(dialog.getByText('To Arrival / A Light Carried · slot 1')).toBeVisible();
  await expect(dialog.getByText('4 → 5 / 10 min')).toBeVisible();
  await expect(dialog.getByText('11 → 10 / 18 min')).toBeVisible();
  await dialog.getByRole('button', { name: 'Swap objects' }).click();
  await expect(dialog).not.toBeVisible();

  await expect(lane(page, 'Arrival / A Light Carried').locator('.placement-item strong')).toHaveText(['Kitchen Table Radio']);
  await expect(lane(page, 'Patterns of Work').locator('.placement-item strong')).toHaveText(['Dyer’s Sample Book', 'Railway Signal Lantern']);
  await expect(page.locator('.unplaced-item')).toHaveCount(1);
  await expect(page.locator('.unplaced-item').first()).toContainText('Conservator’s Gloves');

  await page.reload();
  await expect(lane(page, 'Arrival / A Light Carried').locator('.placement-item strong')).toHaveText(['Kitchen Table Radio']);
  await expect(lane(page, 'Patterns of Work').locator('.placement-item strong')).toHaveText(['Dyer’s Sample Book', 'Railway Signal Lantern']);
  await expect(page.locator('.unplaced-item')).toHaveCount(1);
});

test('blocks a conflicting swap and cancel keeps both placements', async ({ page }) => {
  await page.goto('/journey');
  await page.getByRole('button', { name: 'Swap Railway Signal Lantern' }).click();
  await page.getByRole('button', { name: 'Swap Dyer’s Sample Book' }).click();

  const dialog = page.getByRole('dialog', { name: 'Confirm swap' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/requires a low-light environment/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Swap objects' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();

  await expect(lane(page, 'Arrival / A Light Carried').locator('.placement-item strong')).toHaveText(['Railway Signal Lantern']);
  await expect(lane(page, 'Patterns of Work').locator('.placement-item strong')).toHaveText(['Dyer’s Sample Book', 'Kitchen Table Radio']);

  await page.reload();
  await expect(lane(page, 'Arrival / A Light Carried').locator('.placement-item strong')).toHaveText(['Railway Signal Lantern']);
  await expect(lane(page, 'Patterns of Work').locator('.placement-item strong')).toHaveText(['Dyer’s Sample Book', 'Kitchen Table Radio']);
});
