import { defineConfig } from '@playwright/test';

const port = Number(process.env.WEBRC_E2E_PORT ?? 5175);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL,
    headless: true,
    launchOptions: process.env.WEBRC_CHROMIUM_PATH
      ? { executablePath: process.env.WEBRC_CHROMIUM_PATH }
      : undefined,
  },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
