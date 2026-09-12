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
}

test('previews a multi-person batch and applies a fair rebalance transactionally', async ({ page }) => {
  await page.goto('/review');
  // Build an unbalanced desk: Mara carries 6+3+2=11 weight while Theo carries only 2.
  await createFinding(page, 'Balancing critical finding', 'Mara Chen', 'Critical blocker', 'Arrival / A Light Carried');
  await createFinding(page, 'Balancing warning finding', 'Mara Chen', 'Warning', 'Afterlives');

  await selectForAllocation(page, 'Balancing critical finding');
  await selectForAllocation(page, 'Balancing warning finding');
  await openAllocation(page, 2);

  await expect(page.getByText('Weights: critical ×3 · warning ×2 · note ×1.')).toBeVisible();

  // Fair balancing spreads severity weight evenly across both owners.
  await page.getByRole('button', { name: 'Balance fairly' }).click();
  await expect(page.getByText(/Weight spread after the batch is/)).not.toBeVisible();

  const confirm = page.getByRole('button', { name: /^Confirm/ });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText(/findings? reassigned in one transaction/)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Every moved finding shows a bumped version in the list.
  const moved = page.locator('.issue-row', { has: page.getByRole('heading', { name: 'Balancing critical finding' }) });
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

  // Reopen a batch on the same finding; the new baseline is already Mara so
  // there is nothing to move, and the audit trail contains a single entry.
  await selectForAllocation(page, 'Reduce entry panel copy');
  await openAllocation(page, 1);
  const auditRows = page.locator('.allocation-audit-row', { hasText: 'Reduce entry panel copy' });
  await expect(auditRows).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Confirm/ })).toBeDisabled();
});

test('detects an external reassignment, blocks commit, then refreshes and applies', async ({ context }) => {
  const pageOne = await context.newPage();
  const pageTwo = await context.newPage();
  await pageOne.goto('/review');
  await pageTwo.goto('/review');

  await selectForAllocation(pageOne, 'Reduce entry panel copy');
  await openAllocation(pageOne, 1);
  await pageOne.getByLabel('New owner for Reduce entry panel copy').selectOption({ label: 'Rina Solberg' });
  await expect(pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ })).toBeEnabled();

  // Peer advances the same finding externally; its version bumps.
  await pageTwo.getByRole('button', { name: 'Start work' }).first().click();
  await expect(pageTwo.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // The open transaction must now refuse to commit.
  await expect(pageOne.locator('.allocation-conflicts')).toBeVisible();
  await expect(pageOne.getByText('Status changed')).toBeVisible();
  await expect(pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ })).toBeDisabled();

  // Refresh re-acknowledges the new base version; the batch can proceed.
  await pageOne.getByRole('button', { name: 'Refresh base' }).click();
  await expect(pageOne.locator('.allocation-conflicts')).toHaveCount(0);
  await expect(pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ })).toBeEnabled();
  await pageOne.getByRole('button', { name: /^Confirm 1 reassign$/ }).click();
  await expect(pageOne.getByText(/finding reassigned in one transaction/)).toBeVisible();

  // Peer view picks up the committed owner through the storage-event sync.
  await expect(pageTwo.locator('.issue-row', { hasText: 'Reduce entry panel copy' }).locator('.issue-meta')).toContainText('Rina Solberg');
});
