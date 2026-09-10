import { test, expect, type Page } from '@playwright/test';

async function openNewZoneDialog(page: Page) {
  await page.goto('/zones');
  await page.getByRole('button', { name: 'New zone' }).click();
  await expect(page.getByRole('dialog', { name: 'Add exhibition zone' })).toBeVisible();
}

async function fillZone(page: Page, zone: { name: string; shortLabel?: string; thesis?: string; capacity?: string; maxObjects?: string }) {
  await page.getByLabel('Zone name').fill(zone.name);
  if (zone.shortLabel !== undefined) await page.getByLabel('Short label').fill(zone.shortLabel);
  if (zone.thesis !== undefined) await page.getByLabel('Theme').fill(zone.thesis);
  if (zone.capacity !== undefined) await page.getByLabel('Dwell capacity (minutes)').fill(zone.capacity);
  if (zone.maxObjects !== undefined) await page.getByLabel('Maximum object count').fill(zone.maxObjects);
}

async function createZone(page: Page, zone: { name: string; shortLabel?: string; thesis?: string; capacity?: string; maxObjects?: string }) {
  await openNewZoneDialog(page);
  await fillZone(page, zone);
  await page.getByRole('button', { name: 'Create zone' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('creates an empty zone that immediately participates in journey placement', async ({ page }) => {
  await createZone(page, {
    name: 'Reading Alcove',
    shortLabel: 'Alcove',
    thesis: 'A quiet space for reflection at the end of the visit.',
    capacity: '9',
    maxObjects: '2',
  });
  await expect(page.getByRole('heading', { name: 'Reading Alcove' })).toBeVisible();

  // The new zone appears on the journey board and accepts a placement from the queue.
  await page.goto('/journey');
  await expect(page.getByRole('heading', { name: 'Reading Alcove' })).toBeVisible();
  await page.getByRole('button', { name: /Conservator’s Gloves/ }).click();
  const lane = page.locator('.zone-lane', { hasText: 'Reading Alcove' });
  await lane.getByRole('button', { name: /Place Conservator’s Gloves here/ }).click();
  await expect(lane.getByText('Conservator’s Gloves')).toBeVisible();

  // The new zone is selectable in the review desk filter.
  await page.goto('/review');
  await page.getByLabel('Exhibition zone').selectOption({ label: 'Reading Alcove' });
  await expect(page.getByLabel('Exhibition zone')).toHaveValue(/.+/);
});

test('reducing capacity below current occupancy surfaces blocking constraints', async ({ page }) => {
  await page.goto('/zones');
  // Patterns of Work holds two objects and 11 minutes of dwell in the seed plan.
  const card = page.locator('.zone-admin-card', { hasText: 'Patterns of Work' });
  await card.getByRole('button', { name: 'Edit' }).click();
  await page.getByLabel('Dwell capacity (minutes)').fill('5');
  await page.getByLabel('Maximum object count').fill('1');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByText(/outside configured limits/)).toBeVisible();
  await expect(card.getByText('Over dwell capacity')).toBeVisible();
  await expect(card.getByText('Over object limit')).toBeVisible();

  // The journey board reports the same blocking constraints without moving any objects.
  await page.goto('/journey');
  await expect(page.getByText('Patterns of Work exceeds dwell capacity').first()).toBeVisible();
  await expect(page.getByText('Patterns of Work has too many objects').first()).toBeVisible();
});

test('deleting a non-empty zone shows impact, returns objects to the queue, and keeps findings', async ({ page }) => {
  await page.goto('/zones');
  const card = page.locator('.zone-admin-card', { hasText: 'Arrival / A Light Carried' });
  await card.getByRole('button', { name: 'Delete Arrival / A Light Carried' }).click();

  const dialog = page.getByRole('dialog', { name: /Delete/ });
  await expect(dialog).toBeVisible();
  // Impact review lists the placed object...
  await expect(dialog.getByText('Railway Signal Lantern')).toBeVisible();
  await expect(dialog.getByText(/1 OBJECT RETURNS? TO THE UNPLACED QUEUE/)).toBeVisible();
  // ...and the zone-level finding that must not disappear silently.
  await expect(dialog.getByText('Reduce entry panel copy')).toBeVisible();

  await dialog.getByRole('button', { name: 'Delete zone' }).click();
  await expect(page.getByRole('heading', { name: 'Arrival / A Light Carried' })).toHaveCount(0);

  // The lantern is back in the unplaced queue.
  await page.goto('/journey');
  await expect(page.getByRole('button', { name: /Railway Signal Lantern/ })).toBeVisible();

  // The zone-level finding is still listed on the review desk, marked as detached.
  await page.goto('/review');
  const issue = page.locator('.issue-row', { hasText: 'Reduce entry panel copy' });
  await expect(issue).toBeVisible();
  await expect(issue.getByText(/zone removed/)).toBeVisible();
  await expect(issue).toContainText('Arrival / A Light Carried');
});

test('zone order changes persist across refresh', async ({ page }) => {
  await page.goto('/zones');
  const order = () => page.locator('.zone-admin-card h3').allTextContents();

  // Move the Common Thread zone from third position up to second.
  const commonCard = page.locator('.zone-admin-card', { hasText: 'The Common Thread' });
  await commonCard.getByRole('button', { name: /Move The Common Thread earlier/ }).click();
  await expect.poll(order).toEqual([
    'Arrival / A Light Carried',
    'The Common Thread',
    'Patterns of Work',
    'Afterlives',
  ]);

  await page.reload();
  await expect.poll(order).toEqual([
    'Arrival / A Light Carried',
    'The Common Thread',
    'Patterns of Work',
    'Afterlives',
  ]);

  // The journey board follows the same sequence.
  await page.goto('/journey');
  const laneTitles = await page.locator('.zone-title-line h3').allTextContents();
  expect(laneTitles.slice(0, 3)).toEqual([
    'Arrival / A Light Carried',
    'The Common Thread',
    'Patterns of Work',
  ]);
});
