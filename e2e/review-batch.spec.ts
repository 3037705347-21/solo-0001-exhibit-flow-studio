import { test, expect } from '@playwright/test';

test('batch transition findings with preview, result triage, and idempotent resubmission', async ({ page }) => {
  await page.goto('/review');

  // Select two findings and open the batch dialog.
  await page.getByLabel('Select finding: Reduce entry panel copy').check();
  await page.getByLabel('Select finding: Confirm quilt lux rotation').check();
  const batchBar = page.getByRole('region', { name: 'Batch actions' });
  await expect(batchBar).toBeVisible();
  await expect(batchBar).toContainText('2 findings selected');

  // Preview explains what will happen before anything is written.
  await batchBar.getByRole('button', { name: 'Start / reopen' }).click();
  const preview = page.getByRole('dialog', { name: /Move to/ });
  await expect(preview.getByText('Will update · 2')).toBeVisible();

  // Commit and inspect the single triaged result.
  await preview.getByRole('button', { name: 'Apply 2 changes' }).click();
  const result = page.getByRole('dialog', { name: 'Batch result' });
  await expect(result.getByText('Completed · 2')).toBeVisible();
  await expect(result.getByText(/2 completed · 0 already up to date · 0 need a new decision/)).toBeVisible();
  await result.getByRole('button', { name: 'Done' }).click();

  // Resubmitting the same action is an idempotent no-op: the dialog reports
  // "already up to date" instead of writing again.
  await page.getByLabel('Select finding: Reduce entry panel copy').check();
  await batchBar.getByRole('button', { name: 'Start / reopen' }).click();
  const resubmitted = page.getByRole('dialog', { name: /Move to/ });
  await expect(resubmitted.getByText('Already up to date · 1')).toBeVisible();
  await expect(resubmitted.getByRole('button', { name: 'Nothing to apply' })).toBeDisabled();
  await resubmitted.getByRole('button', { name: 'Cancel' }).click();
});

test('cancelling a batch preview leaves every finding untouched', async ({ page }) => {
  await page.goto('/review');
  await page.getByLabel('Select finding: Reduce entry panel copy').check();
  const batchBar = page.getByRole('region', { name: 'Batch actions' });
  await batchBar.getByRole('button', { name: 'Resolve' }).click();
  const preview = page.getByRole('dialog', { name: /Move to/ });
  // The open finding cannot jump straight to resolved, so the preview flags it.
  await expect(preview.getByText('Needs a new decision · 1')).toBeVisible();
  await preview.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The finding is still open and no batch was committed.
  await expect(page.getByRole('button', { name: 'Start work' }).first()).toBeVisible();
});
