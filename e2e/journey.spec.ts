import { test, expect } from '@playwright/test';

const STORAGE_KEY = 'exhibit-flow.workspace.v1';

function zoneLane(page: import('@playwright/test').Page, name: string) {
  return page.locator('.zone-lane', { has: page.getByRole('heading', { name }) });
}

test('place an object into a journey zone', async ({ page }) => {
  await page.goto('/journey');
  const queueItem = page.getByRole('button', { name: /Conservator’s Gloves/ });
  await queueItem.click();
  await page.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
  await expect(page.getByText('Conservator’s Gloves').first()).toBeVisible();
});

test('reorders with consecutive moves, undo, and keeps the order after reload', async ({ page }) => {
  await page.goto('/journey');
  const lane = zoneLane(page, 'The Common Thread');
  const items = lane.locator('.placement-item');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('Portable Letterpress');

  // Boundary positions: the first object cannot move up, the last cannot move down.
  await expect(lane.getByRole('button', { name: 'Move Portable Letterpress up' })).toBeDisabled();
  await expect(lane.getByRole('button', { name: 'Move Rain Map Quilt down' })).toBeDisabled();

  // Rapid consecutive moves chain on the latest committed order.
  await lane.getByRole('button', { name: 'Move Rain Map Quilt up' }).click();
  await expect(items.first()).toContainText('Rain Map Quilt');
  await lane.getByRole('button', { name: 'Move Rain Map Quilt down' }).click();
  await lane.getByRole('button', { name: 'Move Rain Map Quilt up' }).click();
  await expect(items.first()).toContainText('Rain Map Quilt');
  await expect(items).toHaveCount(2);

  // Undo/redo replay the sequence without losing or duplicating objects.
  await page.getByRole('button', { name: 'Undo last change' }).click();
  await expect(items.first()).toContainText('Portable Letterpress');
  await page.getByRole('button', { name: 'Redo change' }).click();
  await expect(items.first()).toContainText('Rain Map Quilt');
  await expect(items).toHaveCount(2);

  // Refresh recovery: the committed order and zone version survive a reload.
  await page.reload();
  const reloaded = zoneLane(page, 'The Common Thread');
  await expect(reloaded.locator('.placement-item').first()).toContainText('Rain Map Quilt');
  await expect(reloaded.locator('.placement-item')).toHaveCount(2);
});

test('shows the difference and rebases a stale move when the order changed externally', async ({ page }) => {
  await page.goto('/journey');
  // Arrange a three-object zone so the external edit and the local move compose.
  await page.evaluate((key) => {
    const state = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    const common = state.zones.find((zone: { id: string }) => zone.id === 'zone-common');
    common.artifactIds = ['artifact-press', 'artifact-quilt', 'artifact-bowl'];
    common.version = 5;
    state.zones.find((zone: { id: string }) => zone.id === 'zone-after').artifactIds = ['artifact-tape'];
    window.localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);
  await page.reload();
  const lane = zoneLane(page, 'The Common Thread');
  await expect(lane.locator('.placement-item')).toHaveCount(3);

  // Another tab swaps the first two objects while this tab has not synced yet.
  await page.evaluate((key) => {
    const state = JSON.parse(window.localStorage.getItem(key) ?? '{}');
    const common = state.zones.find((zone: { id: string }) => zone.id === 'zone-common');
    common.artifactIds = ['artifact-quilt', 'artifact-press', 'artifact-bowl'];
    common.version += 1;
    window.localStorage.setItem(key, JSON.stringify(state));
  }, STORAGE_KEY);

  // The stale drag (quilt to the end) is re-validated and rebased deterministically.
  await lane.getByRole('button', { name: 'Move Rain Map Quilt down' }).click();
  await expect(page.getByRole('alert')).toContainText('changed in another tab');
  await expect(page.getByRole('alert')).toContainText('re-applied');
  await expect(lane.locator('.placement-item .placement-info strong')).toHaveText([
    'Portable Letterpress',
    'Mended Serving Bowl',
    'Rain Map Quilt',
  ]);
});

test('keeps orders consistent across two open tabs', async ({ context }) => {
  const pageA = await context.newPage();
  await pageA.goto('/journey');
  const pageB = await context.newPage();
  await pageB.goto('/journey');

  const laneB = zoneLane(pageB, 'Patterns of Work');
  await laneB.getByRole('button', { name: 'Move Kitchen Table Radio up' }).click();
  await expect(laneB.locator('.placement-item').first()).toContainText('Kitchen Table Radio');

  // Tab A adopts the external order, then applies its own move on top of it.
  const laneA = zoneLane(pageA, 'Patterns of Work');
  await expect(laneA.locator('.placement-item').first()).toContainText('Kitchen Table Radio');
  await laneA.getByRole('button', { name: 'Move Kitchen Table Radio down' }).click();
  await expect(laneA.locator('.placement-item').first()).toContainText('Dyer’s Sample Book');

  // Both tabs converge on the same final order with no object lost or duplicated.
  await expect(laneB.locator('.placement-item').first()).toContainText('Dyer’s Sample Book');
  await expect(laneA.locator('.placement-item')).toHaveCount(2);
  await expect(laneB.locator('.placement-item')).toHaveCount(2);
  await pageA.close();
  await pageB.close();
});
