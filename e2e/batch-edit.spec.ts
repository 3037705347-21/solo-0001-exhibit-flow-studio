import { expect, test } from '@playwright/test';
import { STORAGE_KEY } from '../src/state/persistence';

async function openBatchMode(page: import('@playwright/test').Page, names: string[]) {
  await page.goto('/collection');
  await page.getByRole('button', { name: 'Batch edit' }).click();
  for (const name of names) {
    await page.getByRole('checkbox', { name: `Select ${name}` }).check();
  }
  await page.getByRole('button', { name: /^Review/ }).click();
}

async function editMakerInAnotherTab(context: import('@playwright/test').BrowserContext, maker: string) {
  const page = await context.newPage();
  await page.goto('/collection');
  await page.getByRole('article').filter({ hasText: 'Railway Signal Lantern' }).getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Maker / source').fill(maker);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Object details updated.')).toBeVisible();
  return page;
}

test.describe('auditable batch edit transactions', () => {
  test('commits all selected objects atomically and persists after reload', async ({ page }) => {
    await openBatchMode(page, ['Railway Signal Lantern', 'Kitchen Table Radio']);
    await page.getByLabel('Sensitivity').selectOption('fragile');
    await page.getByRole('button', { name: 'Review differences' }).click();

    // The diff confirmation names both objects and shows the value change.
    await expect(page.getByRole('dialog')).toContainText('Railway Signal Lantern');
    await expect(page.getByRole('dialog')).toContainText('Kitchen Table Radio');
    await expect(page.getByRole('dialog').locator('ins').first()).toContainText('Fragile');

    await page.getByRole('button', { name: /Commit .* changes atomically/ }).click();
    await expect(page.getByText(/committed 2 objects atomically/)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Select Railway Signal Lantern' })).toHaveCount(0);

    // The batch result survives a reload.
    await page.reload();
    await page.getByRole('button', { name: 'Batch edit' }).click();
    await page.getByRole('checkbox', { name: 'Select Railway Signal Lantern' }).check();
    await expect(page.getByText('Fragile').first()).toBeVisible();
  });

  test('cancels a prepared transaction without changing anything', async ({ page }) => {
    await page.goto('/collection');
    await page.getByRole('button', { name: 'Batch edit' }).click();
    await page.getByRole('checkbox', { name: 'Select Mended Serving Bowl' }).check();
    await page.getByRole('button', { name: /^Review/ }).click();
    await page.getByLabel('Narrative role').selectOption('turning-point');
    await page.getByRole('button', { name: 'Review differences' }).click();
    await expect(page.getByRole('dialog')).toContainText('Turning Point');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.reload();
    // Object keeps its original role badge (scoped to its card to avoid the
    // role filter options elsewhere on the page).
    const bowlCard = page.getByRole('article').filter({ hasText: 'Mended Serving Bowl' });
    await expect(bowlCard).toContainText('Reflection');
    await expect(bowlCard).not.toContainText('Turning Point');
  });

  test('rejects an illegal field request without opening a transaction', async ({ page }) => {
    // A patch whose only value is out of range is blocked at the command boundary.
    await openBatchMode(page, ['Railway Signal Lantern']);
    await page.getByLabel('Dwell time (min)').fill('99');
    await page.getByRole('button', { name: 'Review differences' }).click();
    await expect(page.getByRole('dialog')).toContainText('Resolve conflicts before commit');
    await expect(page.getByRole('dialog')).toContainText('Dwell time must be between 1 and 30 minutes');

    // Closing the conflict screen leaves every record on its original value.
    await page.getByRole('button', { name: 'Cancel transaction' }).click();
    await expect(page.getByText('4 min dwell').first()).toBeVisible();
  });

  test('a double submit of the same transaction is recorded only once', async ({ page }) => {
    await openBatchMode(page, ['Railway Signal Lantern', 'Kitchen Table Radio']);
    await page.getByLabel('Key object').selectOption('Mark as key object');
    await page.getByRole('button', { name: 'Review differences' }).click();
    const commit = page.getByRole('button', { name: /Commit .* changes atomically/ });
    await commit.click();
    // The modal closes on the first (successful) commit; the audit log must hold one record.
    await expect(page.getByText(/committed 2 objects atomically/)).toBeVisible();
    const raw = await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
    const persisted = JSON.parse(raw ?? '{}');
    expect(persisted.batchTransactions).toHaveLength(1);
    expect(persisted.batchTransactions[0].itemCount).toBe(2);
  });

  test('aborts the whole batch when an object is edited in another tab after review', async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await pageA.goto('/collection');
    await pageA.getByRole('button', { name: 'Batch edit' }).click();
    await pageA.getByRole('checkbox', { name: 'Select Railway Signal Lantern' }).check();
    await pageA.getByRole('checkbox', { name: 'Select Kitchen Table Radio' }).check();
    await pageA.getByRole('button', { name: /^Review/ }).click();
    await pageA.getByLabel('Sensitivity').selectOption('fragile');
    await pageA.getByRole('button', { name: 'Review differences' }).click();
    await expect(pageA.getByText('2 objects ready, one shared revision')).toBeVisible();

    // A second tab performs an "other edit" to one of the reviewed objects.
    const pageB = await editMakerInAnotherTab(context, 'H. B. Cooke & Sons');

    // The first tab receives the cross-tab update; committing must now reject atomically.
    await expect(pageA.getByText('H. B. Cooke & Sons').first()).toBeVisible({ timeout: 5000 });
    await pageA.getByRole('button', { name: /Commit .* changes atomically/ }).click();
    await expect(pageA.getByRole('dialog')).toContainText('Transaction rejected — no changes were saved');
    await expect(pageA.getByRole('dialog')).toContainText('stale');

    // The otherwise-safe second object must not carry a half-applied change.
    await pageA.getByRole('button', { name: 'Cancel transaction' }).click();
    const raw = await pageA.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
    const persisted = JSON.parse(raw ?? '{}');
    expect(persisted.batchTransactions ?? []).toHaveLength(0);
    const radio = persisted.artifacts.find((a: { id: string }) => a.id === 'artifact-radio');
    expect(radio.sensitivity).toBe('standard');

    await context.close();
  });

  test('continues a rejected batch with only the still-safe records', async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    await pageA.goto('/collection');
    await pageA.getByRole('button', { name: 'Batch edit' }).click();
    await pageA.getByRole('checkbox', { name: 'Select Railway Signal Lantern' }).check();
    await pageA.getByRole('checkbox', { name: 'Select Kitchen Table Radio' }).check();
    await pageA.getByRole('button', { name: /^Review/ }).click();
    await pageA.getByLabel('Narrative role').selectOption('reflection');
    await pageA.getByRole('button', { name: 'Review differences' }).click();

    const pageB = await editMakerInAnotherTab(context, 'Cooke & Sons, Reltd.');

    await expect(pageA.getByText('Cooke & Sons, Reltd.').first()).toBeVisible({ timeout: 5000 });
    await pageA.getByRole('button', { name: /Commit .* changes atomically/ }).click();
    await expect(pageA.getByRole('dialog')).toContainText('1 of 2 objects were still safe to apply');

    await pageA.getByRole('button', { name: 'Continue with safe objects only' }).click();
    // The surviving one-object transaction is planned on the fresh revision and committed.
    await expect(pageA.getByRole('button', { name: /Commit .* changes atomically/ })).toBeVisible({ timeout: 5000 });
    await pageA.getByRole('button', { name: /Commit .* changes atomically/ }).click();
    await expect(pageA.getByText(/committed 1 object atomically/)).toBeVisible();

    const raw = await pageA.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
    const persisted = JSON.parse(raw ?? '{}');
    expect(persisted.batchTransactions).toHaveLength(1);
    expect(persisted.batchTransactions[0].artifactIds).toEqual(['artifact-radio']);
    expect(persisted.artifacts.find((a: { id: string }) => a.id === 'artifact-radio').narrativeRole).toBe('reflection');

    await context.close();
  });
});
