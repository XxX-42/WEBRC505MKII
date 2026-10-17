import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = process.cwd();
const copies = [
  ['LICENSE', 'public/LICENSE'],
  ['node_modules/vue/LICENSE', 'public/THIRD_PARTY/vue/LICENSE'],
  ['node_modules/vite/LICENSE.md', 'public/THIRD_PARTY/vite/LICENSE.md'],
  ['src/audio/pitch/vendor/NOTICE.md', 'public/THIRD_PARTY/signalsmith/NOTICE.md'],
  ['src/audio/pitch/vendor/SIGNALSMITH_STRETCH_LICENSE.txt', 'public/THIRD_PARTY/signalsmith/SIGNALSMITH_STRETCH_LICENSE.txt'],
  ['src/audio/pitch/vendor/SIGNALSMITH_LINEAR_LICENSE.txt', 'public/THIRD_PARTY/signalsmith/SIGNALSMITH_LINEAR_LICENSE.txt'],
];

describe('distributed project and third-party licenses', () => {
  it('ships exact project and runtime dependency license texts alongside the web app', () => {
    for (const [source, destination] of copies) {
      const vendored = readFileSync(resolve(repo, source), 'utf8');
      const publicCopy = readFileSync(resolve(repo, destination), 'utf8');
      expect(publicCopy, destination).toBe(vendored);
    }
  });
});
