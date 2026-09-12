import { test, expect, type Page } from '@playwright/test';

const STORAGE_KEY = 'exhibit-flow.workspace.v1';

test('place an object into a journey zone', async ({ page }) => {
  await page.goto('/journey');
  const queueItem = page.getByRole('button', { name: /Conservator’s Gloves/ });
  await queueItem.click();
  await page.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
  await expect(page.getByText('Conservator’s Gloves').first()).toBeVisible();
});

test.describe('constraint repair sandbox', () => {
  /** Queue an unplaced object and place it into the first drop zone. */
  async function placeFromQueue(page: Page, title: string) {
    await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
    await page.getByRole('button', { name: new RegExp(`Place ${title} here`) }).first().click();
  }

  /** Remove a placed object back to the queue, then place it into the first drop zone. */
  async function relocate(page: Page, title: string) {
    await page.getByRole('button', { name: `Remove ${title}` }).click();
    await placeFromQueue(page, title);
  }

  async function openSandbox(page: Page) {
    await page.getByTestId('open-repair-sandbox').click();
    await expect(page.getByRole('dialog', { name: 'Resolve placement conflicts' })).toBeVisible();
  }

  test('resolves a single capacity conflict with a confirmed minimal change', async ({ page }) => {
    await page.goto('/journey');

    // Create a dwell-capacity overload in the arrival zone:
    // lantern(4) + radio(5) + gloves(3) = 12 min against a 10-minute target.
    await relocate(page, 'Kitchen Table Radio');
    await placeFromQueue(page, 'Conservator’s Gloves');
    await expect(page.getByText(/exceeds dwell capacity/).first()).toBeVisible();

    await openSandbox(page);
    await expect(page.getByText(/exceeds dwell capacity/).first()).toBeVisible();

    await page.getByRole('button', { name: /Calculate minimal changes/ }).click();
    await expect(page.getByRole('button', { name: /Apply 1 change/ })).toBeEnabled();

    const change = page.getByTestId('repair-change');
    await expect(change).toHaveCount(1);
    await expect(change).toContainText(/Move Kitchen Table Radio/);
    await expect(change).toContainText(/Arrival \/ A Light Carried/);
    await expect(change).toContainText(/Patterns of Work/);
    await expect(change).toContainText(/Affected materials/);
    await expect(change).toContainText(/Reduce entry panel copy/);

    await page.getByRole('button', { name: /Apply 1 change/ }).click();
    await expect(page.getByText(/Applied 1 repair change/)).toBeVisible();
    await expect(page.getByText(/exceeds dwell capacity/)).toHaveCount(0);
    await expect(page.getByTestId('open-repair-sandbox')).toBeDisabled();
  });

  test('resolves multiple conflicts in one apply and submits them together', async ({ page }) => {
    await page.goto('/journey');

    // Overload arrival to 4 objects (density) and 16 minutes (capacity)...
    await relocate(page, 'Mended Serving Bowl');
    await relocate(page, 'Kitchen Table Radio');
    await placeFromQueue(page, 'Conservator’s Gloves');
    // ...and return a key object to the queue.
    await page.getByRole('button', { name: /Remove Rain Map Quilt/ }).click();

    await expect(page.getByText(/Key object is not in the journey/)).toBeVisible();
    await expect(page.getByText(/exceeds dwell capacity/).first()).toBeVisible();
    await expect(page.getByText(/has too many objects/)).toBeVisible();

    await openSandbox(page);
    await page.getByRole('button', { name: /Calculate minimal changes/ }).click();

    const changes = page.getByTestId('repair-change');
    expect(await changes.count()).toBeGreaterThan(1);
    await expect(page.getByText(/Place Rain Map Quilt/)).toBeVisible();
    const applyButton = page.getByRole('button', { name: /Apply \d+ changes? to plan/ });
    await expect(applyButton).toBeEnabled();
    const applyCount = Number((await applyButton.textContent())?.match(/(\d+)/)?.[1] ?? 0);

    // Nothing is written before confirmation: the queue still holds the key object.
    await expect(page.getByRole('button', { name: /^Rain Map Quilt/ }).first()).toBeVisible();

    await applyButton.click();
    await expect(page.getByText(new RegExp(`Applied ${applyCount} repair change`))).toBeVisible();
    await expect(page.getByText(/Key object is not in the journey/)).toHaveCount(0);
    await expect(page.getByText(/exceeds dwell capacity/)).toHaveCount(0);
    await expect(page.getByText(/has too many objects/)).toHaveCount(0);
    await expect(page.getByTestId('open-repair-sandbox')).toBeDisabled();
  });

  test('protects key objects: apply is blocked and the plan is never written', async ({ page }) => {
    // Seed an already-broken historical plan through persistence: the key quilt
    // sits in the arrival zone, which has neither low light nor seating.
    await page.goto('/journey');
    await page.evaluate((storageKey) => {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) throw new Error('seed plan missing');
      const plan = JSON.parse(raw);
      for (const zone of plan.zones) {
        zone.artifactIds = zone.artifactIds.filter((id: string) => id !== 'artifact-quilt');
        if (zone.id === 'zone-arrival') zone.artifactIds.push('artifact-quilt');
      }
      window.localStorage.setItem(storageKey, JSON.stringify(plan));
    }, STORAGE_KEY);
    await page.reload();
    await expect(page.getByText(/requires low light/).first()).toBeVisible();

    await openSandbox(page);
    await page.getByRole('button', { name: /Calculate minimal changes/ }).click();

    // The key object is never moved; every automatic option is listed as unavailable.
    const blocked = page.getByTestId('repair-blocked-option');
    await expect(blocked.filter({ hasText: /Rain Map Quilt/ }).first()).toContainText(/key object/i);
    await expect(page.getByTestId('repair-change')).toHaveCount(0);
    const applyButton = page.getByRole('button', { name: /Apply \d+ changes? to plan/ });
    await expect(applyButton).toBeDisabled();

    // Closing the sandbox leaves the conflicted plan exactly as it was.
    await page.getByRole('button', { name: /Back to conflicts/ }).click();
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(page.getByText(/requires low light/).first()).toBeVisible();
  });

  test('applies a second proposal for remaining conflicts after the first repair', async ({ page }) => {
    await page.goto('/journey');

    // Overload arrival with radio + bowl: first repair clears the blocking
    // error but leaves a non-blocking capacity warning as a remaining conflict.
    await relocate(page, 'Kitchen Table Radio');
    await relocate(page, 'Mended Serving Bowl');

    // First repair: only the blocking capacity error is selected by default.
    await openSandbox(page);
    await page.getByRole('button', { name: /Calculate minimal changes/ }).click();
    const firstApply = page.getByRole('button', { name: /Apply 1 change to plan/ });
    await expect(firstApply).toBeEnabled();
    await firstApply.click();
    await expect(page.getByText(/Applied 1 repair change/)).toBeVisible();

    // A remaining warning is still listed, so the sandbox stays available.
    await expect(page.getByTestId('open-repair-sandbox')).toBeEnabled();

    // Second repair for the remaining conflict must not be mistaken for a
    // duplicate of the first confirmation.
    await openSandbox(page);
    const warningCheckbox = page.getByRole('checkbox').first();
    await warningCheckbox.check();
    await page.getByRole('button', { name: /Calculate minimal changes/ }).click();
    const secondApply = page.getByRole('button', { name: /Apply \d+ changes? to plan/ });
    await expect(secondApply).toBeEnabled();
    await secondApply.click();
    // Success, not an "already applied" rejection.
    await expect(page.getByText(/Applied \d+ repair change/)).toBeVisible();
    await expect(page.getByTestId('sandbox-error-banner')).toHaveCount(0);
  });
});
