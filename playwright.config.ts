import { defineConfig } from '@playwright/test';

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  // Native bridge integration specs launch a local simulation host on the
  // same fixed loopback port. Keep that suite serial whenever the host is
  // enabled so separate spec files cannot race to bind the same port.
  ...(process.env.NATIVE_BRIDGE_SIMULATION_EXECUTABLE ? { workers: 1 } : {}),
  use: {
    baseURL: 'http://127.0.0.1:4174',
    headless: true,
    permissions: ['microphone'],
    launchOptions: {
      ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --mode e2e --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
