import { test, expect, type Page } from '@playwright/test';

const STORAGE_KEY = 'exhibit-flow.workspace.v1';

async function resetPlan(page: Page) {
  await page.goto('/insights');
  await page.evaluate((key) => {
    localStorage.removeItem(key);
  }, STORAGE_KEY);
  await page.reload();
}

async function setLeisurelyLargeGroup(page: Page) {
  await page.getByRole('button', { name: 'Leisurely' }).click();
  await page.getByLabel('Group size').fill('12');
}

async function mutateStoredPlan(page: Page, mutate: (state: any) => any) {
  await page.evaluate(({ key, source }) => {
    const raw = localStorage.getItem(key);
    const state = raw ? JSON.parse(raw) : null;
    // eslint-disable-next-line no-eval
    const next = eval(`(${source})`)(state);
    localStorage.setItem(key, JSON.stringify(next));
  }, { key: STORAGE_KEY, source: mutate.toString() });
}

async function seedTightAfterlives(page: Page) {
  // Lower Afterlives to 9 minutes: both Afterlives (tape 6/9) and Common
  // (15/20) read as pressured for a group of 12, and their only fitting
  // destination is Patterns — two moves that overload it together.
  await mutateStoredPlan(page, (state: any) => ({
    ...state,
    zones: state.zones.map((zone: any) =>
      zone.id === 'zone-after' ? { ...zone, capacityMinutes: 9 } : zone,
    ),
  }));
  await page.reload();
}

test.describe('planning transactions', () => {
  test.beforeEach(async ({ page }) => {
    await resetPlan(page);
  });

  test('applies a single suggestion as one committed change', async ({ page }) => {
    await setLeisurelyLargeGroup(page);
    await page.getByRole('checkbox', { name: /Adopt the leisurely visitor profile/ }).check();
    await page.getByRole('button', { name: /^Review 1 change$/ }).click();

    const panel = page.getByRole('region', { name: 'Review planning changes' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Visitor profile')).toBeVisible();
    await expect(panel.getByText('Leisurely pace, group 12, access 70%')).toBeVisible();

    await page.getByRole('button', { name: /^Commit 1 change$/ }).click();
    await expect(page.getByText('Planning transaction applied.')).toBeVisible();

    // The saved profile line reflects the new preferences and a new revision.
    await expect(page.getByText(/Saved profile:[\s\S]*Leisurely[\s\S]*12 people[\s\S]*revision 2/)).toBeVisible();
  });

  test('blocks a suggestion whose dependency is not selected, then succeeds together', async ({ page }) => {
    await setLeisurelyLargeGroup(page);
    // The quilt move only fits Patterns after a dwell trim; select the move alone.
    await page.getByRole('checkbox', { name: /Select Move Rain Map Quilt to Patterns/ }).check();
    await page.getByRole('button', { name: /^Review 1 change$/ }).click();

    await expect(page.getByText(/depends on another suggestion that is not selected/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Commit 1 change$/ })).toBeDisabled();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('checkbox', { name: /Select Shorten stay at Rain Map Quilt/ }).check();
    await page.getByRole('button', { name: /^Review 2 changes$/ }).click();
    await expect(page.getByRole('button', { name: /^Commit 2 changes$/ })).toBeEnabled();
  });

  test('rejects a capacity-breaking combination and keeps the plan unchanged', async ({ page }) => {
    await seedTightAfterlives(page);
    await setLeisurelyLargeGroup(page);

    await page.getByRole('checkbox', { name: /Select Move Oral History Tape 12 to Patterns/ }).check();
    await page.getByRole('checkbox', { name: /Select Move Rain Map Quilt to Patterns/ }).check();
    await page.getByRole('checkbox', { name: /Select Shorten stay at Rain Map Quilt/ }).check();
    await page.getByRole('button', { name: /Review 3 changes/ }).click();

    await expect(page.getByText(/would run at \d+% of its dwell capacity/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Commit 3 changes$/ })).toBeDisabled();

    await page.getByRole('button', { name: 'Cancel' }).click();
    // Nothing was written: revision remains the seed revision.
    await expect(page.getByText(/revision 1(?!\d)/)).toBeVisible();
  });

  test('refuses to commit when another tab changed the plan, then applies after reload', async ({ page, context }) => {
    await setLeisurelyLargeGroup(page);
    await page.getByRole('checkbox', { name: /Adopt the leisurely visitor profile/ }).check();
    await page.getByRole('button', { name: /^Review 1 change$/ }).click();
    await expect(page.getByText(/Revision 1(?!\d)/)).toBeVisible();

    // Simulate a write from another browser tab: bump revision and change data.
    const second = await context.newPage();
    await second.goto('/insights');
    await mutateStoredPlan(second, (state: any) => ({
      ...state,
      revision: state.revision + 1,
      preferences: { ...state.preferences, groupSize: 3 },
    }));
    await second.close();

    await expect(page.getByText('The saved plan changed elsewhere')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /^Commit 1 change$/ })).toBeDisabled();

    await page.getByRole('button', { name: 'Reload latest plan' }).click();
    await expect(page.getByText('The saved plan changed elsewhere')).toHaveCount(0);

    // Re-select on the rebased suggestions and commit.
    await page.getByRole('checkbox', { name: /Adopt the leisurely visitor profile/ }).check();
    await page.getByRole('button', { name: /^Review 1 change$/ }).click();
    await page.getByRole('button', { name: /^Commit 1 change$/ }).click();
    await expect(page.getByText('Planning transaction applied.')).toBeVisible();
  });

  test('commits a successful batch and undoes it completely', async ({ page }) => {
    await setLeisurelyLargeGroup(page);
    await page.getByRole('checkbox', { name: /Adopt the leisurely visitor profile/ }).check();
    await page.getByRole('button', { name: /^Review 1 change$/ }).click();
    await page.getByRole('button', { name: /^Commit 1 change$/ }).click();
    await expect(page.getByText('Planning transaction applied.')).toBeVisible();
    await expect(page.getByText(/Saved profile:[\s\S]*Leisurely/)).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText(/Saved profile:[\s\S]*Balanced[\s\S]*6 people/)).toBeVisible();
  });

  test('cancelling a prepared batch leaves no partial preferences', async ({ page }) => {
    await setLeisurelyLargeGroup(page);
    await page.getByRole('checkbox', { name: /Adopt the leisurely visitor profile/ }).check();
    await page.getByRole('button', { name: /^Review 1 change$/ }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(/Saved profile:[\s\S]*Balanced[\s\S]*6 people[\s\S]*revision 1(?!\d)/)).toBeVisible();
  });
});
