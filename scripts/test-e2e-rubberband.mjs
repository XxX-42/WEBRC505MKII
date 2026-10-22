import { access, constants } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const requiredExecutables = [
  ['NATIVE_BRIDGE_SIMULATION_EXECUTABLE', 'the explicit no-audio Native bridge simulation host'],
  ['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', 'the verified Chromium headless-shell browser'],
];

let invalid = false;
for (const [name, description] of requiredExecutables) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}: provide ${description}; strict Rubber Band E2E never silently skips this dependency.`);
    invalid = true;
    continue;
  }
  try {
    await access(value, constants.X_OK);
  } catch {
    console.error(`${name} is not an executable file: ${value}`);
    invalid = true;
  }
}

if (invalid) process.exit(2);

console.log('Running the complete Playwright E2E suite with the explicit Native simulation host and browser.');
// Launch the pinned CLI through Node. Windows cannot spawn npm.cmd without a
// command shell; using the JS entry point also avoids shell quoting entirely.
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');
const result = spawnSync(process.execPath, [playwrightCli, 'test', '--workers=1', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to launch Playwright: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
