import { expect, test } from '@playwright/test';

const STORAGE_KEY = 'exhibit-flow.workspace.v1';
const FOUR_ROUTES = ['/collection', '/journey', '/review', '/insights'] as const;

async function openSettingsFrom(page: import('@playwright/test').Page, route: string) {
  await page.goto(route);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page).toHaveURL('/settings');
  await expect(page.getByRole('heading', { name: 'Project settings' })).toBeVisible();
}

test.describe('project settings', () => {
  test('opens from every existing page and returns via the back control', async ({ page }) => {
    for (const route of FOUR_ROUTES) {
      await openSettingsFrom(page, route);
      await page.getByRole('button', { name: /Back to/ }).click();
      await expect(page).toHaveURL(route);
    }
  });

  test('saving from a settings page updates the sidebar and survives reload', async ({ page }) => {
    await openSettingsFrom(page, '/collection');

    await page.getByLabel('Exhibition title').fill('Echoes in Glass');
    await page.getByLabel('Venue').fill('South Wing, Room 2');
    await page.getByLabel('Target audience').fill('Teen groups and families');
    await page.getByLabel('Opening date').fill('2028-06-01');
    await page.getByRole('button', { name: 'Save settings' }).click();

    await expect(page.getByText('Exhibition settings saved.')).toBeVisible();
    // Saved overview panel reflects the new values immediately.
    await expect(page.getByRole('heading', { name: 'Echoes in Glass' }).first()).toBeVisible();
    await expect(page.getByText('South Wing, Room 2').first()).toBeVisible();
    // Sidebar updates immediately without leaving the settings route.
    await expect(page.locator('.sidebar-project').getByText('Echoes in Glass')).toBeVisible();
    await expect(page.locator('.sidebar-project').getByText(/Teen groups and families/)).toBeVisible();
    await expect(page.locator('.sidebar-project').getByText(/Jun(?:e)? 1, 2028/)).toBeVisible();

    await page.reload();
    await expect(page.locator('.sidebar-project').getByText('Echoes in Glass')).toBeVisible();
    await expect(page.locator('.sidebar-project').getByText(/Teen groups and families/)).toBeVisible();

    const persisted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), STORAGE_KEY);
    expect(persisted.project).toMatchObject({
      title: 'Echoes in Glass',
      venue: 'South Wing, Room 2',
      audience: 'Teen groups and families',
      openingDate: '2028-06-01',
    });
    // Other modules are still present after a project-only save.
    expect(Array.isArray(persisted.artifacts)).toBeTruthy();
    expect(persisted.artifacts.length).toBeGreaterThan(0);
    expect(Array.isArray(persisted.zones)).toBeTruthy();
    expect(persisted.zones.length).toBeGreaterThan(0);
    expect(Array.isArray(persisted.issues)).toBeTruthy();
    expect(persisted.preferences).toBeTruthy();
  });

  test('cancel discards edits and leaves the workspace unchanged', async ({ page }) => {
    await page.goto('/journey');
    const before = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);

    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByLabel('Exhibition title').fill('Temporary Title That Must Not Persist');
    await page.getByLabel('Venue').fill('Nowhere Pavilion');
    await page.getByRole('button', { name: 'Cancel' }).first().click();
    await expect(page).toHaveURL('/journey');
    await expect(page.locator('.sidebar-project').getByText('Temporary Title That Must Not Persist')).toHaveCount(0);

    const after = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
    expect(after).toBe(before);
  });

  test('rejects an invalid opening date and keeps the editor open', async ({ page }) => {
    await openSettingsFrom(page, '/insights');
    await page.getByLabel('Opening date').fill('2028-02-30');
    await page.getByRole('button', { name: 'Save settings' }).click();

    await expect(page.getByText(/Opening date must use the YYYY-MM-DD format/)).toBeVisible();
    await expect(page).toHaveURL('/settings');
    await expect(page.getByText('Exhibition settings saved.')).toHaveCount(0);

    // Correcting the date clears the error and saves.
    await page.getByLabel('Opening date').fill('2028-02-29');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Exhibition settings saved.')).toBeVisible();
  });

  test('allows clearing venue, audience, and opening date', async ({ page }) => {
    await openSettingsFrom(page, '/review');
    await page.getByLabel('Venue').fill('');
    await page.getByLabel('Target audience').fill('');
    await page.getByLabel('Opening date').fill('');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Exhibition settings saved.')).toBeVisible();
    await expect(page.getByText('No venue set').first()).toBeVisible();
    await expect(page.getByText('No audience defined').first()).toBeVisible();
    await expect(page.getByText('Not scheduled yet', { exact: true })).toBeVisible();
  });

  test('settings reachable directly by route and returns to a safe default', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Project settings' })).toBeVisible();
    await page.getByRole('button', { name: /Back to/ }).click();
    await expect(page).toHaveURL('/collection');
  });

  test('repairs an old workspace project record without touching other modules', async ({ page }) => {
    const seed = {
      version: 1,
      project: {
        id: 'project-afterlight',
        title: 'Legacy Show',
        venue: 'Old Hall',
        audience: 'Adults',
        openingDate: '2027-13-99',
        stage: 'published',
      },
      artifacts: [],
      zones: [
        { id: 'zone-legacy', name: 'Legacy Zone', shortLabel: 'Legacy', thesis: 'A zone without a sequence.', capacityMinutes: 10, maxObjects: 3, lowLight: false, hasSeating: false, color: '#123456', artifactIds: [] },
      ],
      issues: [],
      preferences: { pace: 'leisurely', accessibilityPriority: 42, groupSize: 9 },
    };
    await page.addInitScript(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [STORAGE_KEY, seed] as const);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Project settings' })).toBeVisible();
    // Invalid legacy date and unknown stage are repaired on load, not on first edit.
    await expect(page.getByLabel('Opening date')).toHaveValue('');
    await expect(page.getByText('Not scheduled yet', { exact: true })).toBeVisible();

    await page.getByLabel('Exhibition title').fill('Legacy Show Repaired');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Exhibition settings saved.')).toBeVisible();

    const persisted = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}'), STORAGE_KEY);
    expect(persisted.project).toMatchObject({ title: 'Legacy Show Repaired', openingDate: '', stage: 'draft' });
    // Legacy zone and preferences survive the project repair untouched.
    expect(persisted.zones).toHaveLength(1);
    expect(persisted.zones[0].id).toBe('zone-legacy');
    expect(persisted.zones[0].sequence).toBe(0);
    expect(persisted.preferences).toEqual({ pace: 'leisurely', accessibilityPriority: 42, groupSize: 9 });
  });

  test('resetting the workspace from the settings sidebar restores seed values without a save', async ({ page }) => {
    await openSettingsFrom(page, '/collection');
    await page.getByLabel('Exhibition title').fill('Temporary Show');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.locator('.sidebar-project').getByText('Temporary Show')).toBeVisible();

    // Confirm the native reset dialog; the form should re-seed to the sample project.
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Reset sample plan' }).click();

    await expect(page.getByLabel('Exhibition title')).toHaveValue('Afterlight: Material Memory');
    await expect(page.getByLabel('Opening date')).toHaveValue('2027-03-18');
    await expect(page.getByText('Exhibition settings saved.')).toHaveCount(0);
  });
});
