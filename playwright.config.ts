import { defineConfig, devices } from '@playwright/test';

const noSandbox = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PLAYWRIGHT_NO_SANDBOX === '1';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      // Set PLAYWRIGHT_NO_SANDBOX=1 in restricted containers without user namespaces.
      launchOptions: noSandbox ? { args: ['--no-sandbox', '--disable-dev-shm-usage'] } : undefined,
    },
  }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
