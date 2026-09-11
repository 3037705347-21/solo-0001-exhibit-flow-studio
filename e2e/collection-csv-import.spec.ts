import { expect, test } from '@playwright/test';

const HEADER = [
  'Accession ID', 'Title', 'Maker / source', 'Date / period', 'Medium', 'Origin',
  'Summary', 'Width', 'Height', 'Depth', 'Dwell minutes', 'Narrative role',
  'Sensitivity', 'Accessibility need', 'Key object', 'Tags', 'Color',
].join(',');

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function row(values: {
  id: string; title: string; maker?: string; year?: string; medium?: string; origin?: string;
  summary?: string; width?: string; height?: string; depth?: string; dwell?: string;
  role?: string; sensitivity?: string; accessibility?: string; key?: string; tags?: string; color?: string;
}): string {
  return [
    values.id, values.title, values.maker ?? 'Studio North', values.year ?? '2027',
    values.medium ?? 'Brass and glass', values.origin ?? 'York',
    values.summary ?? 'A sufficiently long descriptive summary for this imported record.',
    values.width ?? '12', values.height ?? '20', values.depth ?? '8', values.dwell ?? '4',
    values.role ?? 'context', values.sensitivity ?? 'standard', values.accessibility ?? 'none',
    values.key ?? 'no', values.tags ?? '', values.color ?? '#2f7c75',
  ].map(csvCell).join(',');
}

async function openWizard(page: import('@playwright/test').Page) {
  await page.goto('/collection');
  await page.getByRole('button', { name: 'Import CSV' }).click();
  await expect(page.getByRole('dialog', { name: 'Import objects from CSV' })).toBeVisible();
}

async function uploadCsv(page: import('@playwright/test').Page, name: string, body: string) {
  await page.locator('.csv-dropzone input[type="file"]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(body, 'utf-8') });
}

test.describe('Collection CSV import wizard', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.localStorage.clear());
  });

  test('imports a fully valid file: collection, journey queue, and persistence stay in sync after refresh', async ({ page }) => {
    await openWizard(page);
    const csv = [
      HEADER,
      row({ id: 'AF-CSV-001', title: 'Batch Lantern One', summary: 'First batch object with a sufficiently descriptive summary line.' }),
      row({ id: 'AF-CSV-002', title: 'Batch Lantern Two', summary: 'Second batch object with a sufficiently descriptive summary line.', dwell: '6', role: 'reflection' }),
      '',
      '   ',
    ].join('\n');
    await uploadCsv(page, 'two-objects.csv', csv);

    await expect(page.getByTestId('csv-count-new')).toHaveText('2');
    await expect(page.getByTestId('csv-count-error')).toHaveText('0');
    await expect(page.getByTestId('csv-count-conflict')).toHaveText('0');

    await page.getByRole('dialog').getByRole('button', { name: /^Import 2 objects/ }).click();
    await expect(page.getByText('Import complete: 2 objects added')).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Batch Lantern One' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Batch Lantern Two' })).toBeVisible();

    // Journey unplaced queue must immediately list both new objects.
    await page.goto('/journey');
    await expect(page.getByRole('button', { name: /Batch Lantern One/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Batch Lantern Two/ })).toBeVisible();

    // Backend persistence (localStorage) survives refresh.
    await page.goto('/collection');
    await expect(page.getByRole('heading', { name: 'Batch Lantern One' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Batch Lantern Two' })).toBeVisible();
    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem('exhibit-flow.workspace.v1') ?? '';
      const parsed = JSON.parse(raw) as { artifacts: Array<{ accessionId: string }> };
      return parsed.artifacts.map((artifact) => artifact.accessionId);
    });
    expect(stored).toContain('AF-CSV-001');
    expect(stored).toContain('AF-CSV-002');
  });

  test('blocks a partially invalid batch and never writes the good rows', async ({ page }) => {
    await openWizard(page);
    const csv = [
      HEADER,
      row({ id: 'AF-CSV-101', title: 'Good Batch Object', summary: 'This row is valid and would otherwise import cleanly today.' }),
      row({ id: 'AF-CSV-102', title: 'Bad Batch Object', width: '-9', dwell: '75', summary: 'short' }),
    ].join('\n');
    await uploadCsv(page, 'partial.csv', csv);

    await expect(page.getByTestId('csv-count-new')).toHaveText('1');
    await expect(page.getByTestId('csv-count-error')).toHaveText('1');
    const importButton = page.getByRole('dialog').getByRole('button', { name: /^Import/ });
    await expect(importButton).toBeDisabled();
    await expect(page.getByText(/Width must be greater than zero/)).toBeVisible();

    // Cancel: workspace remains exactly as it was — even the good row is absent.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Good Batch Object' })).toHaveCount(0);
    const stored = await page.evaluate(() => {
      const raw = window.localStorage.getItem('exhibit-flow.workspace.v1') ?? '';
      return raw.includes('AF-CSV-101');
    });
    expect(stored).toBe(false);
  });

  test('treats a duplicate accession id within one file as a row error', async ({ page }) => {
    await openWizard(page);
    const csv = [
      HEADER,
      row({ id: 'af-csv-200', title: 'Duplicate File Row One', summary: 'First occurrence of the duplicated accession id in this file.' }),
      row({ id: 'AF CSV 200', title: 'Duplicate File Row Two', summary: 'Second occurrence of the duplicated accession id in this file.' }),
    ].join('\n');
    await uploadCsv(page, 'dup-row.csv', csv);

    await expect(page.getByTestId('csv-count-new')).toHaveText('1');
    await expect(page.getByTestId('csv-count-error')).toHaveText('1');
    await expect(page.getByText(/Duplicate accession ID in this file/)).toBeVisible();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Import/ })).toBeDisabled();
  });

  test('never overwrites existing records without explicit permission', async ({ page }) => {
    await openWizard(page);
    const csv = [HEADER, row({ id: 'af-1908-014', title: 'Lantern Hijack Attempt', maker: 'Someone Else', summary: 'A row trying to overwrite the seed lantern without user permission.' })].join('\n');
    await uploadCsv(page, 'conflict.csv', csv);

    await expect(page.getByTestId('csv-count-conflict')).toHaveText('1');
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Import/ })).toBeDisabled();

    // Cancelling leaves the original record untouched.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Railway Signal Lantern' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lantern Hijack Attempt' })).toHaveCount(0);
  });

  test('turns conflicts into safe updates only after the user allows them', async ({ page }) => {
    await openWizard(page);
    const csv = [HEADER, row({ id: 'AF-1908-014', title: 'Railway Signal Lantern', maker: 'H. B. Cooke & Co. (updated)', medium: 'Brass, glass, new wick', summary: 'Seed lantern refreshed with an updated maker line for the import test.', width: '19', height: '34', depth: '18', dwell: '5' })].join('\n');
    await uploadCsv(page, 'update.csv', csv);
    await expect(page.getByTestId('csv-count-conflict')).toHaveText('1');

    await page.getByRole('checkbox', { name: /Allow updating existing records/ }).check();
    await expect(page.getByTestId('csv-count-update')).toHaveText('1');
    await expect(page.getByTestId('csv-count-conflict')).toHaveText('0');

    await page.getByRole('dialog').getByRole('button', { name: /^Import 1 object/ }).click();
    await expect(page.getByText(/1 record updated/)).toBeVisible();
    await expect(page.getByText(/H\. B\. Cooke & Co\. \(updated\)/)).toBeVisible();

    // Placement survives the in-place update: lantern stays in its zone on the journey board.
    await page.goto('/journey');
    await expect(page.getByText('Railway Signal Lantern').first()).toBeVisible();

    // Persisted after refresh, with no duplicate lantern.
    await page.reload();
    const count = await page.evaluate(() => {
      const parsed = JSON.parse(window.localStorage.getItem('exhibit-flow.workspace.v1') ?? '{}') as { artifacts: Array<{ accessionId: string }> };
      return parsed.artifacts.filter((artifact) => artifact.accessionId === 'AF-1908-014').length;
    });
    expect(count).toBe(1);
  });

  test('imports only new rows when the user explicitly chooses to skip conflicts', async ({ page }) => {
    await openWizard(page);
    const csv = [
      HEADER,
      row({ id: 'AF-1908-014', title: 'Lantern Hijack Attempt', summary: 'A conflicting row that the user chooses to leave out of the import batch.' }),
      row({ id: 'AF-CSV-501', title: 'Brand New Alongside Conflict', summary: 'A genuinely new object imported while the conflict row is explicitly skipped.' }),
    ].join('\n');
    await uploadCsv(page, 'skip-conflict.csv', csv);

    await expect(page.getByTestId('csv-count-conflict')).toHaveText('1');
    await expect(page.getByTestId('csv-count-new')).toHaveText('1');

    await page.getByRole('checkbox', { name: /Skip rows that match existing records/ }).check();
    await expect(page.getByRole('dialog').getByRole('button', { name: /^Import 1 object/ })).toBeEnabled();
    await page.getByRole('dialog').getByRole('button', { name: /^Import 1 object/ }).click();
    await expect(page.getByText(/1 existing record skipped/)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Brand New Alongside Conflict' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Railway Signal Lantern' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Lantern Hijack Attempt' })).toHaveCount(0);

    const stored = await page.evaluate(() => {
      const parsed = JSON.parse(window.localStorage.getItem('exhibit-flow.workspace.v1') ?? '{}') as { artifacts: Array<{ accessionId: string }> };
      return {
        lanternCount: parsed.artifacts.filter((artifact) => artifact.accessionId === 'AF-1908-014').length,
        added: parsed.artifacts.some((artifact) => artifact.accessionId === 'AF-CSV-501'),
      };
    });
    expect(stored.lanternCount).toBe(1);
    expect(stored.added).toBe(true);
  });

  test('cancel after preview writes nothing, including after refresh', async ({ page }) => {
    await openWizard(page);
    const csv = [HEADER, row({ id: 'AF-CSV-301', title: 'Should Never Land', summary: 'A valid row whose import is cancelled before the user confirms it.' })].join('\n');
    await uploadCsv(page, 'cancel.csv', csv);
    await expect(page.getByTestId('csv-count-new')).toHaveText('1');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { name: 'Should Never Land' })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Should Never Land' })).toHaveCount(0);
  });

  test('handles quoted commas, quoted newlines, escaped quotes, and blank lines', async ({ page }) => {
    await openWizard(page);
    const csv = [
      HEADER,
      row({ id: 'AF-CSV-401', title: 'Comma, Quoted Object', maker: 'Cooke, H. B. & Co.', summary: 'Line one\nLine two of a "quoted" summary with enough words.' }),
      '',
      row({ id: 'AF-CSV-402', title: 'After Blank Line', summary: 'Second valid object appearing after an empty physical row in the file.' }),
    ].join('\n');
    await uploadCsv(page, 'quoting.csv', csv);

    await expect(page.getByTestId('csv-count-new')).toHaveText('2');
    await expect(page.getByTestId('csv-count-error')).toHaveText('0');
    await page.getByRole('dialog').getByRole('button', { name: /^Import 2 objects/ }).click();
    await expect(page.getByRole('heading', { name: 'Comma, Quoted Object' })).toBeVisible();
    await expect(page.getByText(/Cooke, H\. B\. & Co\./)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'After Blank Line' })).toBeVisible();
  });
});
