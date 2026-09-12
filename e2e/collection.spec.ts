import { test, expect } from '@playwright/test';

test('curate object set through collection route', async ({ page }) => {
  await page.goto('/collection');
  await page.getByRole('button', { name: 'Add object' }).first().click();
  await page.getByLabel('Accession ID').fill('AF-2027-901');
  await page.getByLabel('Title').fill('A New Material Memory');
  await page.getByLabel('Maker / source').fill('Studio North');
  await page.getByLabel('Medium').fill('Paper and graphite');
  await page.getByLabel('Summary').fill('A new object with enough context to join the exhibition narrative.');
  await page.getByLabel('Width (cm)').fill('10');
  await page.getByLabel('Height (cm)').fill('12');
  await page.getByLabel('Depth (cm)').fill('2');
  await page.getByLabel('Dwell time (min)').fill('3');
  await page.getByRole('button', { name: 'Add object' }).last().click();
  await expect(page.getByText('A New Material Memory')).toBeVisible();
});

test('sort the collection, keep order stable across filters, and restore sort after reload', async ({ page }) => {
  await page.goto('/collection');
  const titles = () => page.locator('.artifact-card h3').allTextContents();

  // Default added order matches how objects entered the collection.
  expect((await titles())[0]).toBe('Railway Signal Lantern');

  // A deterministic title order replaces it.
  await page.getByLabel('Sort objects by').selectOption('title');
  expect((await titles())[0]).toBe('Conservator’s Gloves');

  // Search and role filters only narrow the visible set.
  await page.getByLabel('Search collection').fill('radio');
  expect(await titles()).toEqual(['Kitchen Table Radio']);
  await page.getByLabel('Search collection').fill('');
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.getByLabel('Narrative role').selectOption('reflection');
  expect(await titles()).toEqual(['Conservator’s Gloves', 'Mended Serving Bowl', 'Oral History Tape 12']);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  const fullOrder = await titles();
  expect(fullOrder).toHaveLength(8);
  expect(fullOrder[0]).toBe('Conservator’s Gloves');

  // The sort rule survives a page refresh.
  await page.reload();
  await expect(page.getByLabel('Sort objects by')).toHaveValue('title');
  expect(await titles()).toEqual(fullOrder);
});
