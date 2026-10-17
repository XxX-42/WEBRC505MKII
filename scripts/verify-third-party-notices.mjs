import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const copies = [
  {
    label: 'project GPL license',
    source: 'LICENSE',
    publicCopy: 'public/LICENSE',
    builtCopy: 'dist/LICENSE',
  },
  {
    label: 'Vue MIT license',
    source: 'node_modules/vue/LICENSE',
    publicCopy: 'public/THIRD_PARTY/vue/LICENSE',
    builtCopy: 'dist/THIRD_PARTY/vue/LICENSE',
  },
  {
    label: 'Vite MIT license',
    source: 'node_modules/vite/LICENSE.md',
    publicCopy: 'public/THIRD_PARTY/vite/LICENSE.md',
    builtCopy: 'dist/THIRD_PARTY/vite/LICENSE.md',
  },
  ...['NOTICE.md', 'SIGNALSMITH_STRETCH_LICENSE.txt', 'SIGNALSMITH_LINEAR_LICENSE.txt'].map((name) => ({
    label: `Signalsmith ${name}`,
    source: `src/audio/pitch/vendor/${name}`,
    publicCopy: `public/THIRD_PARTY/signalsmith/${name}`,
    builtCopy: `dist/THIRD_PARTY/signalsmith/${name}`,
  })),
];
for (const copy of copies) {
  const source = resolve(root, copy.source);
  const publicCopy = resolve(root, copy.publicCopy);
  const builtCopy = resolve(root, copy.builtCopy);
  assert.ok(existsSync(source), `missing upstream/source license: ${source}`);
  assert.ok(existsSync(publicCopy), `missing public license: ${publicCopy}`);
  assert.equal(readFileSync(publicCopy, 'utf8'), readFileSync(source, 'utf8'), `${copy.label} is not an exact source copy`);
  if (process.argv.includes('--built')) {
    assert.ok(existsSync(builtCopy), `missing built license: ${builtCopy}`);
    assert.equal(readFileSync(builtCopy, 'utf8'), readFileSync(source, 'utf8'), `${copy.label} is not an exact build copy`);
  }
}
console.log(`Verified ${copies.length} exact project and third-party license files${process.argv.includes('--built') ? ' in dist' : ''}`);
