import { defineConfig, devices } from '@playwright/test';

// On minimal sandboxes Chromium's system libraries are staged in /tmp/pwlibs.
// Appending those directories is harmless elsewhere: the dynamic linker ignores
// paths that do not exist.
const nodeProcess = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process;
const libraryPath = ['/tmp/pwlibs/usr/lib/aarch64-linux-gnu', '/tmp/pwlibs/lib/aarch64-linux-gnu', nodeProcess?.env?.LD_LIBRARY_PATH ?? '']
  .filter(Boolean)
  .join(':');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    launchOptions: {
      env: {
        ...nodeProcess?.env,
        LD_LIBRARY_PATH: libraryPath,
      },
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
