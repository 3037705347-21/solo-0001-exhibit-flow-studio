import { expect, test } from '@playwright/test';

const HISTORY_KEY = 'exhibit-flow.activity-history.v1';
const WORKSPACE_KEY = 'exhibit-flow.workspace.v1';

test.beforeEach(async ({ page }) => {
  await page.goto('/collection');
  await page.evaluate(() => {
    localStorage.removeItem('exhibit-flow.activity-history.v1');
    localStorage.removeItem('exhibit-flow.workspace.v1');
  });
});

test('shows an explanatory empty state before any command', async ({ page }) => {
  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'No commands recorded yet' })).toBeVisible();
  await expect(page.getByTestId('history-count')).toContainText('0');
});

test('records commands from every workspace area in time order and restores after refresh', async ({ page }) => {
  // 1. Object edit (create) from collection
  await page.getByRole('button', { name: 'Add object' }).first().click();
  await page.getByLabel('Accession ID').fill('AF-2027-902');
  await page.getByLabel('Title').fill('History Test Plaque');
  await page.getByLabel('Maker / source').fill('Studio North');
  await page.getByLabel('Medium').fill('Enamel and steel');
  await page.getByLabel('Summary').fill('A plaque created to verify the operation history audit trail end to end.');
  await page.getByLabel('Width (cm)').fill('8');
  await page.getByLabel('Height (cm)').fill('10');
  await page.getByLabel('Depth (cm)').fill('2');
  await page.getByLabel('Dwell time (min)').fill('3');
  await page.getByRole('button', { name: 'Add object' }).last().click();
  await expect(page.getByText('History Test Plaque')).toBeVisible();

  // 2. Finding create + transition from review
  await page.goto('/review');
  await page.getByRole('button', { name: 'New finding' }).click();
  await page.getByLabel('Finding title').fill('History audit blocker');
  await page.getByLabel('Owner').fill('Audit Reviewer');
  await page.getByLabel('Context and next step').fill('Confirm the audit trail records this finding lifecycle correctly.');
  await page.getByRole('button', { name: 'Create finding' }).click();
  await expect(page.getByText('History audit blocker')).toBeVisible();
  await page.getByRole('button', { name: 'Start work' }).first().click();

  // 3. Readiness check
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByText(/Still needs attention|Ready to share/)).toBeVisible();

  // 4. Preferences from insights
  await page.goto('/insights');
  await page.getByRole('button', { name: 'Leisurely' }).click();
  await page.getByRole('button', { name: 'Apply preferences' }).click();
  await expect(page.getByText('Planning preferences applied.')).toBeVisible();

  // 5. Journey placement
  await page.goto('/journey');
  await page.getByRole('button', { name: /Conservator’s Gloves/ }).click();
  await page.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
  await expect(page.getByText('Conservator’s Gloves').first()).toBeVisible();

  // History appears immediately with newest-first order and summaries/sources/time.
  await page.goto('/history');
  const rows = page.getByTestId('activity-row');
  await expect(rows).toHaveCount(6);
  const summaries = await rows.evaluateAll((nodes) => nodes.map((node) => (node.querySelector('.activity-copy strong') as HTMLElement).textContent ?? ''));
  expect(summaries[0]).toContain('Placed “Conservator’s Gloves”');
  expect(summaries[0]).toContain('Arrival / A Light Carried');
  expect(summaries[1]).toContain('Applied visitor preferences: Leisurely pace');
  expect(summaries[2]).toContain('Ran readiness check');
  expect(summaries[3]).toContain('Started work on finding “History audit blocker”');
  expect(summaries[4]).toContain('Created Warning finding “History audit blocker”');
  expect(summaries[5]).toContain('Added object “History Test Plaque” (AF-2027-902)');

  const sources = await rows.evaluateAll((nodes) => nodes.map((node) => (node.querySelector('.activity-source') as HTMLElement).textContent ?? ''));
  expect(sources).toContain('Visitor journey');
  expect(sources).toContain('Review desk');
  expect(sources).toContain('Insights');
  expect(sources).toContain('Collection');
  expect(await page.locator('.activity-time').count()).toBe(6);

  // Refresh: history is restored, order preserved.
  await page.reload();
  await expect(page.getByTestId('activity-row')).toHaveCount(6);
  const persisted = await page.getByTestId('activity-row').first().locator('.activity-copy strong').textContent();
  expect(persisted).toContain('Placed “Conservator’s Gloves”');

  // Reset replaces business state but must not erase the trail; the reset is appended.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset sample plan' }).click();
  await expect(page.getByTestId('activity-row')).toHaveCount(7);
  await expect(page.getByTestId('activity-row').first().locator('.activity-copy strong')).toHaveText('Reset workspace to the sample plan');

  // Business state returned to the sample plan (the name survives only in the old log summary).
  await page.goto('/collection');
  await expect(page.getByText('Railway Signal Lantern').first()).toBeVisible();
  const workspaceRaw = await page.evaluate((key) => localStorage.getItem(key), WORKSPACE_KEY);
  expect(workspaceRaw).not.toContain('History Test Plaque');
});

test('keeps only the newest entries once the cap is reached', async ({ page }) => {
  const seedEntries = Array.from({ length: 110 }, (_, index) => ({
    id: `event-old-${index}`,
    category: 'workspace',
    action: 'workspace/reset',
    summary: `Seed event ${index}`,
    source: 'Workspace',
    timestamp: new Date(2026, 0, index + 1).toISOString(),
    actor: 'local-user',
  }));
  await page.evaluate(([key, entries]) => localStorage.setItem(key, JSON.stringify(entries)), [HISTORY_KEY, seedEntries] as const);

  await page.goto('/history');
  const rows = page.getByTestId('activity-row');
  await expect(rows).toHaveCount(100);
  await expect(page.getByTestId('history-count')).toContainText('100');
  await expect(page.getByText('Cap of 100 reached')).toBeVisible();
  // Entries 0..9 rolled off; index 10 is the oldest survivor (shown last).
  await expect(page.getByText('Seed event 0', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Seed event 9', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Seed event 10', { exact: true })).toBeVisible();
  await expect(page.getByText('Seed event 109', { exact: true })).toBeVisible();

  // A new command drops one more old entry and lands on top.
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reset sample plan' }).click();
  await expect(page.getByTestId('activity-row')).toHaveCount(100);
  await expect(page.getByText('Seed event 10', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('activity-row').first().locator('.activity-copy strong')).toHaveText('Reset workspace to the sample plan');
});

test('invalid commands do not create history entries', async ({ page }) => {
  await page.getByRole('button', { name: 'Add object' }).first().click();
  await page.getByRole('button', { name: 'Add object' }).last().click();
  await expect(page.getByText('Title is required.')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'No commands recorded yet' })).toBeVisible();
});
