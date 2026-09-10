import { test, expect } from '@playwright/test';

test('curate object set through collection route', async ({ page }) => {
  await page.goto('/collection');
  await page.getByRole('button', { name: 'Add object' }).first().click();
  await page.getByLabel('Accession ID').fill('AF-2027-901');
  await page.getByLabel('Title').fill('A New Material Memory');
  await page.getByLabel('Maker / source').fill('Studio North');
  await page.getByLabel('Medium').fill('Paper and graphite');
  await page
    .getByLabel('Summary')
    .fill('A new object with enough context to join the exhibition narrative.');
  await page.getByLabel('Width (cm)').fill('10');
  await page.getByLabel('Height (cm)').fill('12');
  await page.getByLabel('Depth (cm)').fill('2');
  await page.getByLabel('Dwell time (min)').fill('3');
  await page.getByRole('button', { name: 'Add object' }).last().click();
  await expect(page.getByText('A New Material Memory')).toBeVisible();
});
