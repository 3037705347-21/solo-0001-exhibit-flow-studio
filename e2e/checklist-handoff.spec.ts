import { expect, test } from '@playwright/test';

test('record a handoff, detect drift from a finding change, and keep re-downloading the frozen version', async ({ page }) => {
  await page.goto('/review');
  await page.getByLabel('Exhibition zone').selectOption('zone-arrival');

  const handoffs = page.getByRole('region', { name: 'Checklist handoffs' });

  // No handoff exists yet: downloads reflect the live plan only.
  await expect(handoffs.getByText('No handoff recorded yet')).toBeVisible();

  // First handoff captures scope, members, and the readiness basis.
  await page.getByRole('button', { name: 'Record handoff' }).click();
  await page.getByRole('button', { name: 'Save handoff' }).click();
  await expect(page.getByText('Describe where this checklist will be used.')).toBeVisible();
  await page.getByLabel('Usage scope').fill('Floor install crew');
  await page.getByLabel('Members').fill('Jo Renner, Mara Chen');
  await page.getByRole('button', { name: 'Save handoff' }).click();

  await expect(handoffs.getByText('v1', { exact: true })).toBeVisible();
  await expect(handoffs.getByText('Floor install crew')).toBeVisible();
  await expect(handoffs.getByText('Matches current plan')).toBeVisible();

  // Repeated downloads of the handoff keep the frozen version name.
  const firstDownload = page.waitForEvent('download');
  await handoffs.getByRole('button', { name: 'Download handoff v1 (CSV)' }).click();
  expect((await firstDownload).suggestedFilename()).toMatch(/exhibit-flow-zone-checklist-arrival-v1-.*\.csv/);

  // A finding status change marks the recorded handoff as drifted.
  await page.getByRole('button', { name: 'Start work' }).click();
  await expect(handoffs.getByText('Drifted from current plan')).toBeVisible();

  // The frozen version still downloads unchanged.
  const secondDownload = page.waitForEvent('download');
  await handoffs.getByRole('button', { name: 'Download handoff v1 (CSV)' }).click();
  expect((await secondDownload).suggestedFilename()).toMatch(/exhibit-flow-zone-checklist-arrival-v1-.*\.csv/);

  // Recording again creates v2 while v1 stays in the history.
  await page.getByRole('button', { name: 'Record handoff' }).click();
  await page.getByLabel('Usage scope').fill('Install walkthrough');
  await page.getByLabel('Members').fill('Theo James');
  await page.getByRole('button', { name: 'Save handoff' }).click();
  await expect(handoffs.getByText('v2', { exact: true })).toBeVisible();
  await expect(handoffs.getByText('v1', { exact: true })).toBeVisible();
  await expect(handoffs.getByText('Matches current plan')).toBeVisible();
  await expect(handoffs.getByText('Drifted from current plan')).toBeVisible();

  // Handoffs survive a reload through local persistence.
  await page.reload();
  await page.getByLabel('Exhibition zone').selectOption('zone-arrival');
  await expect(page.getByRole('region', { name: 'Checklist handoffs' }).getByText('v2', { exact: true })).toBeVisible();
});

test('moving an object marks the zone handoff as drifted while the frozen file stays readable', async ({ page }) => {
  await page.goto('/review');
  await page.getByLabel('Exhibition zone').selectOption('zone-common');

  await page.getByRole('button', { name: 'Record handoff' }).click();
  await page.getByLabel('Usage scope').fill('Gallery lighting pass');
  await page.getByLabel('Members').fill('Rina Solberg');
  await page.getByRole('button', { name: 'Save handoff' }).click();

  const handoffs = page.getByRole('region', { name: 'Checklist handoffs' });
  await expect(handoffs.getByText('Matches current plan')).toBeVisible();

  // Reorder objects on the journey board.
  await page.goto('/journey');
  await page.getByRole('button', { name: 'Move Portable Letterpress down' }).click();

  // Back on the review desk the recorded handoff shows drift.
  await page.goto('/review');
  await page.getByLabel('Exhibition zone').selectOption('zone-common');
  await expect(handoffs.getByText('Drifted from current plan')).toBeVisible();

  // The frozen handoff and the current-state export remain distinct downloads.
  const frozenDownload = page.waitForEvent('download');
  await handoffs.getByRole('button', { name: 'Download handoff v1 (CSV)' }).click();
  expect((await frozenDownload).suggestedFilename()).toMatch(/exhibit-flow-zone-checklist-common-thread-v1-.*\.csv/);

  const liveDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download current state (CSV)' }).click();
  expect((await liveDownload).suggestedFilename()).toMatch(/exhibit-flow-zone-checklist-common-thread-\d{4}-\d{2}-\d{2}\.csv/);
});
