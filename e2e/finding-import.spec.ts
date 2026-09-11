import { expect, test, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => path.join(fixturesDir, name);

async function openImport(page: Page) {
  await page.goto('/review');
  await page.getByTestId('open-import').click();
  const dialog = page.getByRole('dialog', { name: 'Import findings from CSV' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseCsv(page: Page, dialog: Locator, name: string) {
  const fileInput = page.getByTestId('import-file-input');
  await fileInput.setInputFiles(fixture(name));
  await expect(dialog.getByTestId('import-preview')).toBeVisible();
}

test.describe('finding CSV import', () => {
  test.beforeEach(async ({ page }) => {
    // Start each test from the built-in seed plan so persisted imports never leak
    // into the next scenario's counts.
    await page.addInitScript(() => window.localStorage.removeItem('exhibit-flow.workspace.v1'));
  });

  test('imports all valid rows and shows them on the review list with updated counts', async ({ page }) => {
    const dialog = await openImport(page);
    await chooseCsv(page, dialog, 'findings-valid.csv');

    await expect(dialog.getByTestId('import-count-create')).toContainText('2');
    await expect(dialog.getByTestId('import-count-ignore')).toContainText('0');
    await expect(dialog.getByTestId('import-count-fail')).toContainText('0');

    await dialog.getByRole('button', { name: 'Import 2 findings' }).click();
    await expect(dialog.getByTestId('import-done')).toContainText('2 findings created as open');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // Seed plan has 3 findings (1 open); both imported rows are open.
    await expect(page.locator('.review-summary > div').first().locator('strong')).toHaveText('5');
    await expect(page.locator('.review-summary').getByText('OPEN', { exact: true }).locator('..')).toContainText('3');
    await expect(page.getByRole('heading', { name: 'Large-print entry label' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Second listening position' })).toBeVisible();
  });

  test('reports missing zone and object references as failed rows and creates only valid rows', async ({ page }) => {
    const dialog = await openImport(page);
    await chooseCsv(page, dialog, 'findings-missing-refs.csv');

    await expect(dialog.getByTestId('import-count-create')).toContainText('1');
    await expect(dialog.getByTestId('import-count-fail')).toContainText('2');
    await expect(dialog.getByTestId('import-errors-2')).toContainText(/No zone named "Phantom Wing"/);
    await expect(dialog.getByTestId('import-errors-3')).toContainText(/No object with accession ID "AF-9999-999"/);

    // The confirm button reflects only the one valid row.
    await dialog.getByRole('button', { name: 'Import 1 finding' }).click();
    await expect(dialog.getByTestId('import-done')).toContainText('1 finding created as open');
    await expect(dialog.getByTestId('import-done')).toContainText('2 rows failed');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // Failed rows never became records; the unlinked critical row did.
    await expect(page.locator('.review-summary > div').first().locator('strong')).toHaveText('4');
    await expect(page.getByRole('heading', { name: 'Good unlinked finding' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Phantom zone finding' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Missing object finding' })).toHaveCount(0);
  });

  test('flags an illegal severity without blocking the valid row', async ({ page }) => {
    const dialog = await openImport(page);
    await chooseCsv(page, dialog, 'findings-bad-severity.csv');

    await expect(dialog.getByTestId('import-count-create')).toContainText('1');
    await expect(dialog.getByTestId('import-count-fail')).toContainText('1');
    await expect(dialog.getByTestId('import-errors-2')).toContainText(/Severity "catastrophic" is not recognised/);

    await dialog.getByRole('button', { name: 'Import 1 finding' }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    await expect(page.locator('.review-summary > div').first().locator('strong')).toHaveText('4');
    await expect(page.getByRole('heading', { name: 'Good severity row' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bad severity row' })).toHaveCount(0);
  });

  test('ignores duplicate titles with identical links while creating distinct rows', async ({ page }) => {
    const dialog = await openImport(page);
    await chooseCsv(page, dialog, 'findings-duplicates.csv');

    await expect(dialog.getByTestId('import-count-create')).toContainText('2');
    await expect(dialog.getByTestId('import-count-ignore')).toContainText('2');
    await expect(dialog.getByTestId('import-count-fail')).toContainText('0');
    await expect(dialog.getByTestId('import-duplicate-2')).toContainText(/existing finding "Reduce entry panel copy"/);
    await expect(dialog.getByTestId('import-duplicate-4')).toContainText(/earlier row/);

    await dialog.getByRole('button', { name: 'Import 2 findings' }).click();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // 3 seed findings + 2 created; duplicates are not counted twice.
    await expect(page.locator('.review-summary > div').first().locator('strong')).toHaveText('5');
    await expect(page.getByRole('heading', { name: 'Repeat floor note' })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Fresh floor note' })).toBeVisible();
  });

  test('cancelling the preview creates no findings and leaves counts untouched', async ({ page }) => {
    const dialog = await openImport(page);
    await chooseCsv(page, dialog, 'findings-valid.csv');

    await expect(dialog.getByTestId('import-count-create')).toContainText('2');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.locator('.review-summary > div').first().locator('strong')).toHaveText('3');
    await expect(page.getByRole('heading', { name: 'Large-print entry label' })).toHaveCount(0);
  });
});
