import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // The landing route is now the project command center.
  await expect(page).toHaveURL(/\/command$/);
});

test('command center aggregates the seed project and deep-links to sources', async ({ page }) => {
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Afterlight: Material Memory' })).toBeVisible();
  await expect(main.getByText('North Hall / Gallery 3')).toBeVisible();
  await expect(page.getByTestId('command-score')).toHaveText('70');
  await expect(main.getByText('7/8', { exact: true })).toBeVisible();
  await expect(main.getByText('4/4', { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('last-check')).toContainText('No formal check recorded');

  // The unresolved critical finding leads the ranked register.
  const risks = page.getByTestId('risk-card');
  await expect(risks.first()).toContainText('Add transcript beside oral history station');
  await expect(risks.first()).toHaveAttribute('href', '/review?issue=issue-audio-transcript');

  // The warning finding deep-link lands on the review desk with the row scoped and highlighted.
  await risks.filter({ hasText: 'Reduce entry panel copy' }).click();
  await expect(page).toHaveURL(/\/review\?issue=issue-entry-copy$/);
  await expect(page.locator('#issue-row-issue-entry-copy.issue-highlighted')).toBeVisible();

  // A journey risk deep-link preselects the unplaced object for placement.
  await page.goto('/command');
  await page.getByTestId('risk-card').filter({ hasText: 'not placed in the journey' }).click();
  await expect(page).toHaveURL(/\/journey\?artifact=artifact-gloves$/);
  await expect(page.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first()).toBeVisible();
});

test('changes on review, journey, collection and insights all flow back to the command center', async ({ page }) => {
  // --- Review page: resolve both open findings, run the formal check. ---
  await page.goto('/review?issue=issue-audio-transcript');
  await page.locator('#issue-row-issue-audio-transcript').getByRole('button', { name: 'Resolve' }).click();
  await page.goto('/review?issue=issue-entry-copy');
  await page.locator('#issue-row-issue-entry-copy').getByRole('button', { name: 'Start work' }).click();
  await page.locator('#issue-row-issue-entry-copy').getByRole('button', { name: 'Resolve' }).click();
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to share' })).toBeVisible();

  await page.goto('/command');
  await expect(page.getByTestId('command-score')).toHaveText('94');
  await expect(page.getByTestId('command-metrics').getByText('0', { exact: true })).toBeVisible();
  await expect(page.getByTestId('last-check')).toContainText('Passed — plan confirmed ready');

  // --- Journey page: place the last unplaced object; gate now scores 100. ---
  await page.goto('/journey');
  await page.getByRole('button', { name: /Conservator’s Gloves/ }).click();
  await page.getByRole('button', { name: /Place Conservator’s Gloves here/ }).first().click();
  await page.goto('/review');
  await page.getByRole('button', { name: 'Run readiness check' }).click();
  await expect(page.getByRole('heading', { name: 'Ready to share' })).toBeVisible();

  await page.goto('/command');
  await expect(page.getByTestId('command-score')).toHaveText('100');
  await expect(page.getByText('8/8', { exact: true })).toBeVisible();
  await expect(page.getByTestId('risk-count')).toContainText('All clear');
  await expect(page.getByTestId('last-check')).toContainText('Passed — plan confirmed ready');

  // --- Collection page: adding a non-key object regresses readiness. ---
  await page.goto('/collection');
  await page.getByRole('button', { name: 'Add object' }).first().click();
  await page.getByLabel('Accession ID').fill('AF-2027-902');
  await page.getByLabel('Title').fill('Late Addition Sketchbook');
  await page.getByLabel('Maker / source').fill('Studio North');
  await page.getByLabel('Medium').fill('Paper and ink');
  await page.getByLabel('Summary').fill('A sketchbook added late in planning that still needs a home in the galleries.');
  await page.getByLabel('Width (cm)').fill('20');
  await page.getByLabel('Height (cm)').fill('26');
  await page.getByLabel('Depth (cm)').fill('3');
  await page.getByLabel('Dwell time (min)').fill('4');
  await page.getByRole('button', { name: 'Add object' }).last().click();

  await page.goto('/command');
  await expect(page.getByText('8/9', { exact: true })).toBeVisible();
  await expect(page.getByTestId('command-score')).toHaveText('94');
  const staleRisk = page.getByTestId('risk-card').filter({ hasText: 'passing readiness check is no longer current' });
  await expect(staleRisk).toBeVisible();
  await expect(staleRisk).toHaveAttribute('href', '/review');

  // --- Insights page: a large group scenario flags pressure zones. ---
  await page.goto('/insights');
  await page.getByLabel('Group size').fill('12');
  await page.getByRole('button', { name: 'Apply preferences' }).click();
  await page.goto('/command');
  const pressureRisks = page.getByTestId('capacity-risk').filter({ hasText: 'Scenario pressure' });
  await expect(pressureRisks.first()).toBeVisible();
  await expect(pressureRisks.first()).toHaveAttribute('href', /\/insights\?zone=zone-/);
  await pressureRisks.first().click();
  await expect(page).toHaveURL(/\/insights\?zone=zone-/);
  await expect(page.locator('[id^="pressure-card-"].pressure-card-highlighted')).toBeVisible();

  // --- Refresh restores every aggregated number. ---
  await page.reload();
  await expect(page).toHaveURL(/\/insights\?zone=zone-/);
  await expect(page.locator('[id^="pressure-card-"].pressure-card-highlighted')).toBeVisible();
  await page.goto('/command');
  await expect(page.getByText('8/9', { exact: true })).toBeVisible();
  await expect(page.getByTestId('command-score')).toHaveText('94');
  await expect(page.getByTestId('capacity-risk').filter({ hasText: 'Scenario pressure' })).not.toHaveCount(0);
});

test('empty workspace presents a non-misleading starting state', async ({ page }) => {
  // No UI page can delete zones, so visit once to materialize the persisted seed,
  // then replace it with an empty project under the documented storage key.
  await page.goto('/collection');
  await page.evaluate((key) => {
    const seed = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({
      ...seed,
      project: { ...seed.project, stage: 'draft', lastReadinessCheck: undefined },
      artifacts: [],
      zones: [],
      issues: [],
    }));
  }, 'exhibit-flow.workspace.v1');
  await page.goto('/command');
  await expect(page.getByRole('heading', { name: 'This workspace has no project content yet' })).toBeVisible();
  await expect(page.getByTestId('command-score')).toHaveText('—');
  const risks = page.getByTestId('risk-card');
  await expect(risks).toHaveCount(2);
  await expect(risks.first()).toContainText('The collection is empty');
  await expect(risks.first()).toHaveAttribute('href', '/collection');
});
