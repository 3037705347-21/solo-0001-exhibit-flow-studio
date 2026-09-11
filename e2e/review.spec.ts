import { test, expect, type Page, type Locator } from '@playwright/test';

const STORAGE_KEY = 'exhibit-flow.workspace.v1';

async function seedLegacyWorkspace(page: Page) {
  // Capture the sample workspace the app seeds on first load, then strip the
  // event chains so it looks like a workspace saved before decision history.
  await page.goto('/review');
  await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error('seed workspace missing');
    const parsed = JSON.parse(raw);
    parsed.issues = parsed.issues.map(({ events: _events, ...issue }: { events?: unknown[] }) => issue);
    localStorage.setItem(key, JSON.stringify(parsed));
  }, STORAGE_KEY);
  await page.reload();
}

async function createFinding(page: Page, title: string, owner: string) {
  await page.getByRole('button', { name: 'New finding' }).click();
  await page.getByLabel('Finding title').fill(title);
  await page.getByLabel('Severity').selectOption('critical');
  await page.getByLabel('Owner').fill(owner);
  await page.getByLabel('Context and next step').fill('The label cannot be read from the seated viewing position near the entrance.');
  await page.getByRole('button', { name: 'Create finding' }).click();
}

async function confirmDecision(page: Page, scope: Locator, buttonName: RegExp, confirmName: string, note: string) {
  await scope.getByRole('button', { name: buttonName }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox').fill(note);
  await dialog.getByRole('button', { name: confirmName }).click();
  await expect(dialog).toBeHidden();
}

async function readStoredIssues(page: Page) {
  const raw = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
  expect(raw).toBeTruthy();
  const parsed = JSON.parse(raw as string);
  return parsed.issues;
}

test('advance a review finding and run readiness check', async ({ page }) => {
  await page.goto('/review');
  const row = page.locator('.issue-row', { hasText: 'Add transcript beside oral history station' });
  await row.getByRole('button', { name: 'Resolve' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Record resolution' }).click();
  await expect(row.locator('.issue-title-line .badge', { hasText: /^Resolved$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByRole('heading', { name: /Still needs attention|Ready to share/ })).toBeVisible();
});

test('immutable finding decision history survives repeated lifecycle rounds and refresh', async ({ page }) => {
  await seedLegacyWorkspace(page);

  // Legacy findings receive a migrated initial record on load.
  const entryRow = page.locator('.issue-row', { hasText: 'Reduce entry panel copy' });
  await entryRow.getByRole('button', { name: /Show decision history/ }).click();
  await expect(entryRow.getByText('Immutable decision history')).toBeVisible();
  await expect(entryRow.getByText('Migrated initial record')).toBeVisible();
  await expect(entryRow.getByText('1 event · append-only')).toBeVisible();
  await entryRow.getByRole('button', { name: /Hide decision history/ }).click();

  await createFinding(page, 'History verification finding', 'Mara Chen');
  const row = page.locator('.issue-row', { hasText: 'History verification finding' });
  await expect(row).toBeVisible();

  // Round one: start, resolve with evidence, then reopen with a reason.
  await row.getByRole('button', { name: 'Start work' }).click();
  await expect(row.locator('.issue-title-line .badge', { hasText: 'In Progress' })).toBeVisible();
  await confirmDecision(page, row, /^Resolve$/, 'Record resolution', 'First attempt: angled the panel down 15 degrees.');
  await expect(row.locator('.issue-title-line .badge', { hasText: /^Resolved$/ })).toBeVisible();
  await expect(row.getByText(/Resolved /)).toBeVisible();
  await confirmDecision(page, row, /^Reopen$/, 'Reopen finding', 'Still unreadable under glare; needs anti-glare film.');
  await expect(row.locator('.issue-title-line .badge', { hasText: /^Open$/ })).toBeVisible();
  // The old resolution must be visibly superseded, not presented as current.
  await expect(row.getByText(/Reopened 1×/)).toBeVisible();
  await row.getByRole('button', { name: /Show decision history/ }).click();
  await expect(row.getByText('No longer the current conclusion')).toBeVisible();

  // Edit details and reassign; both become history events.
  await row.getByRole('button', { name: 'Edit finding details and assignee' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Severity').selectOption('warning');
  await editor.getByLabel(/Owner/).fill('Rina Solberg');
  await editor.getByRole('button', { name: 'Record changes' }).click();
  await expect(editor).toBeHidden();

  // Round two: start and resolve again -> second resolution event.
  await row.getByRole('button', { name: 'Start work' }).click();
  await confirmDecision(page, row, /^Resolve$/, 'Record resolution', 'Anti-glare film applied and re-verified.');
  await expect(row.getByText('2 resolutions on record')).toBeVisible();

  // Inspect the rendered chain (panel was opened right after the reopen).
  const eventTitles = await row.locator('.decision-log-entry strong').allInnerTexts();
  expect(eventTitles).toEqual([
    'Finding created',
    'Work started',
    'Marked resolved',
    'Reopened for more work',
    'Finding details edited',
    'Reassigned to Rina Solberg',
    'Work started',
    'Marked resolved',
  ]);
  await expect(row.getByText('8 events', { exact: true })).toBeVisible();

  // Persisted state must be explainable by the chain before refresh.
  let stored = await readStoredIssues(page);
  let persisted = stored.find((issue: { title: string }) => issue.title === 'History verification finding');
  expect(persisted.status).toBe('resolved');
  expect(persisted.severity).toBe('warning');
  expect(persisted.owner).toBe('Rina Solberg');
  expect(persisted.resolvedAt).toBeTruthy();
  expect(persisted.events).toHaveLength(8);
  expect(persisted.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

  // Refresh: history, current state and superseded resolution all remain.
  await page.reload();
  const reloadedRow = page.locator('.issue-row', { hasText: 'History verification finding' });
  await expect(reloadedRow.locator('.issue-title-line .badge', { hasText: /^Resolved$/ })).toBeVisible();
  await reloadedRow.getByRole('button', { name: /Show decision history/ }).click();
  await expect(reloadedRow.getByText('No longer the current conclusion')).toBeVisible();
  expect(await reloadedRow.locator('.decision-log-entry').count()).toBe(8);

  stored = await readStoredIssues(page);
  persisted = stored.find((issue: { title: string }) => issue.title === 'History verification finding');
  expect(persisted.events).toHaveLength(8);
  expect(persisted.events[0]).toMatchObject({ type: 'created' });
  expect(persisted.events[0].backfilled).toBeUndefined();
});

test('snapshot export can include or exclude the full decision history', async ({ page }) => {
  await page.goto('/review');

  async function exportedJson(includeHistory: boolean) {
    const downloadPromise = page.waitForEvent('download');
    if (includeHistory) await page.getByText('Include full decision history').click();
    await page.getByRole('button', { name: /Export snapshot/ }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  }

  // Resolve every seed finding: open -> in progress -> resolved with dialog.
  const resolveAll = async () => {
    let rows = page.locator('.issue-list .issue-row');
    const initial = await rows.count();
    for (let i = 0; i < initial; i += 1) {
      const row = page.locator('.issue-list .issue-row').nth(i);
      const start = row.getByRole('button', { name: 'Start work' });
      if (await start.count()) await start.click();
      const resolve = row.getByRole('button', { name: 'Resolve' });
      if (await resolve.count()) {
        await resolve.click();
        await page.getByRole('dialog').getByRole('button', { name: 'Record resolution' }).click();
      }
    }
    rows = page.locator('.issue-list .issue-row');
    for (let i = 0; i < await rows.count(); i += 1) {
      await expect(rows.nth(i)).toContainText('Resolved');
    }
  };
  await resolveAll();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByRole('button', { name: /Export snapshot/ })).toBeVisible();

  const plain = await exportedJson(false);
  expect(plain.issueHistory).toBeUndefined();
  expect(plain.unresolvedIssues).toEqual([]);

  const full = await exportedJson(true);
  expect(full.issueHistory.length).toBeGreaterThan(0);
  for (const issue of full.issueHistory) {
    expect(Array.isArray(issue.events)).toBe(true);
    expect(issue.events.length).toBeGreaterThan(0);
    expect(issue.historySummary.eventCount).toBe(issue.events.length);
    expect(issue.events[0].type).toBe('created');
  }
});
