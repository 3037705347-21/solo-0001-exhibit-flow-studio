import { test, expect, type Page } from '@playwright/test';

async function selectForAllocation(page: Page, title: string) {
  const row = page.locator('.issue-row', { has: page.getByRole('heading', { name: title }) });
  await row.getByRole('checkbox').check();
}

async function openAllocation(page: Page, count: number) {
  await page.getByRole('button', { name: new RegExp(`Allocate workload \\(${count}\\)`) }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

async function createFinding(page: Page, title: string, owner: string, severity: string, zone: string) {
  await page.getByRole('button', { name: 'New finding' }).click();
  await page.getByLabel('Finding title').fill(title);
  await page.getByLabel('Severity').selectOption({ label: severity });
  await page.getByLabel('Owner').fill(owner);
  await page.getByLabel('Linked zone').selectOption({ label: zone });
  await page.getByLabel('Context and next step').fill('This is a test finding with enough context text to pass validation.');
  await page.getByRole('button', { name: 'Create finding' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

test('previews a multi-person batch and applies a fair rebalance transactionally', async ({ page }) => {
  await page.goto('/review');
  // Seed desk is Mara weight 5 / Theo weight 2. Add one warning on Mara so the
  // desk becomes 7/2; fair balancing moves exactly that warning to Theo (5/4,
  // spread 1) — a single, deterministic reassignment.
  await createFinding(page, 'Balancing warning finding', 'Mara Chen', 'Warning', 'Afterlives');

  await selectForAllocation(page, 'Balancing warning finding');
  await openAllocation(page, 1);

  await expect(page.getByText('Severity weights: critical ×3 · warning ×2 · note ×1.')).toBeVisible();
  // Before balancing: Mara carries weight 5 (critical seed finding + the new
  // warning), Theo carries 2.
  const maraRow = page.locator('.allocation-row', { hasText: 'Mara Chen' });
  await expect(maraRow.locator('.allocation-weight strong').first()).toHaveText('5');
  const theoRow = page.locator('.allocation-row', { hasText: 'Theo James' });
  await expect(theoRow.locator('.allocation-weight strong').first()).toHaveText('2');
  await expect(page.getByText(/Weight spread after the batch is/)).toBeVisible();

  await page.getByRole('button', { name: 'Balance fairly' }).click();
  await expect(page.getByText(/Weight spread after the batch is/)).not.toBeVisible();
  // After: the warning moves to Theo — Mara 3, Theo 4, spread 1.
  await expect(maraRow.locator('.allocation-weight strong').nth(1)).toHaveText('3');
  await expect(theoRow.locator('.allocation-weight strong').nth(1)).toHaveText('4');
  const confirm = page.getByRole('button', { name: /^Confirm 1 reassign$/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText('1 finding reassigned in one transaction.')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The warning moved to Theo James and the version bumped to 1.
  const moved = page.locator('.issue-row', { has: page.getByRole('heading', { name: 'Balancing warning finding' }) });
  await expect(moved).toContainText('Theo James');
  await expect(moved).toContainText('v1');
});

test('cancels a batch without writing any owner or version change', async ({ page }) => {
  await page.goto('/review');
  await selectForAllocation(page, 'Reduce entry panel copy');
  await openAllocation(page, 1);
  await page.getByLabel('New owner for Reduce entry panel copy').selectOption({ label: 'Mara Chen' });
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.locator('.issue-row', { has: page.getByRole('heading', { name: 'Reduce entry panel copy' }) });
  await expect(row).toContainText('Theo James');
  await expect(row).toContainText('v0');
});

test('a repeated confirmation cannot allocate the same finding twice', async ({ page }) => {
  await page.goto('/review');
  await selectForAllocation(page, 'Reduce entry panel copy');
  await openAllocation(page, 1);
  await page.getByLabel('New owner for Reduce entry panel copy').selectOption({ label: 'Mara Chen' });
  await page.getByRole('button', { name: /^Confirm 1 reassign$/ }).click();
  await expect(page.getByText('1 finding reassigned in one transaction.')).toBeVisible();

  // Reopen a batch on the same finding: the acknowledged owner is already Mara
  // so nothing moves, confirm is disabled, and the audit holds one entry.
  await selectForAllocation(page, 'Reduce entry panel copy');
  await openAllocation(page, 1);
  const auditRows = page.locator('.allocation-audit-row', { hasText: 'Reduce entry panel copy' });
  await expect(auditRows).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Confirm/ })).toBeDisabled();
});

test('detects an external status change, rejects the whole batch, then refreshes and commits', async ({ context }) => {
  const pageOne = await context.newPage();
  const pageTwo = await context.newPage();
  await pageOne.goto('/review');
  await pageTwo.goto('/review');

  await selectForAllocation(pageOne, 'Reduce entry panel copy');
  await openAllocation(pageOne, 1);
  await pageOne.getByLabel('New owner for Reduce entry panel copy').selectOption({ label: 'Rina Solberg' });
  await expect(pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ })).toBeEnabled();

  // Peer advances the exact same finding from another tab; its version bumps.
  const peerRow = pageTwo.locator('.issue-row', { has: pageTwo.getByRole('heading', { name: 'Reduce entry panel copy' }) });
  await peerRow.getByRole('button', { name: 'Start work' }).click();
  await expect(peerRow.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // The open transaction detects the external status/version change and
  // refuses to commit any part of the batch.
  await expect(pageOne.locator('.allocation-conflicts')).toBeVisible();
  await expect(pageOne.getByRole('alert').getByText('Status changed', { exact: true })).toBeVisible();
  await expect(pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ })).toBeDisabled();

  // Refresh re-acknowledges the new base; the batch can now commit.
  await pageOne.getByRole('button', { name: 'Refresh base' }).click();
  await expect(pageOne.locator('.allocation-conflicts')).toHaveCount(0);
  await expect(pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ })).toBeEnabled();
  await pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ }).click();
  await expect(pageOne.getByText('1 finding reassigned in one transaction.')).toBeVisible();

  // The peer tab adopts the committed owner through the storage-event sync.
  await expect(peerRow.locator('.issue-meta')).toContainText('Rina Solberg');
});
