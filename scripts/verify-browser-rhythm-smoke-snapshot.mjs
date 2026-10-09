import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const readContained = async (relative) => {
  const absolute = path.resolve(root, relative);
  assert.ok(absolute.startsWith(`${root}${path.sep}`), `snapshot path escapes root: ${relative}`);
  return fs.readFile(absolute);
};

const sourceManifest = JSON.parse((await readContained('source-snapshot.json')).toString('utf8'));
assert.equal(sourceManifest.schemaVersion, 1);
assert.ok(Array.isArray(sourceManifest.files) && sourceManifest.files.length > 0);
for (const entry of sourceManifest.files) {
  assert.ok(typeof entry.path === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256));
  assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
  const bytes = await readContained(entry.path);
  assert.equal(bytes.byteLength, entry.bytes, `snapshot byte length differs: ${entry.path}`);
  assert.equal(sha256(bytes), entry.sha256, `snapshot SHA differs: ${entry.path}`);
}
const appAssetSet = sha256(Buffer.from(
  sourceManifest.files.map(({ path: relative, sha256: digest }) => `${relative}=${digest}`).join('\n'),
  'utf8',
));
if (sourceManifest.sourceAssetSetSha256) {
  assert.equal(appAssetSet, sourceManifest.sourceAssetSetSha256, 'app source-asset-set digest');
}

const publicWasm = await readContained('public/dsp/webrc-dsp.wasm');
const publicBuild = JSON.parse((await readContained('public/dsp/webrc-dsp.build.json')).toString('utf8'));
assert.equal(sha256(publicWasm), publicBuild.artifact.sha256, 'public WASM matches build manifest');
assert.equal(publicWasm.byteLength, publicBuild.artifact.byteLength);
const buildSourceSet = sha256(Buffer.from(Object.keys(publicBuild.sourceFiles).sort()
  .map((relative) => `${relative}=${publicBuild.sourceFiles[relative]}`).join('\n'), 'utf8'));
assert.equal(buildSourceSet, publicBuild.sourceSetSha256, 'WASM build source-set digest');

const buildSnapshotManifestPath = path.join(root, 'wasm-build-snapshot', 'source-snapshot.json');
let wasmBuildSnapshotFileCount = 0;
try {
  const buildSnapshot = JSON.parse(await fs.readFile(buildSnapshotManifestPath, 'utf8'));
  const buildRoot = path.join(root, 'wasm-build-snapshot');
  for (const entry of buildSnapshot.files) {
    const absolute = path.resolve(buildRoot, entry.path);
    assert.ok(absolute.startsWith(`${buildRoot}${path.sep}`), `WASM snapshot path escapes root: ${entry.path}`);
    const bytes = await fs.readFile(absolute);
    assert.equal(bytes.byteLength, entry.bytes, `WASM snapshot byte length differs: ${entry.path}`);
    assert.equal(sha256(bytes), entry.sha256, `WASM snapshot SHA differs: ${entry.path}`);
  }
  wasmBuildSnapshotFileCount = buildSnapshot.files.length;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const evidencePath = path.join(root, 'evidence', 'browser-realtime-smoke.json');
let smokeEvidence = null;
try {
  smokeEvidence = JSON.parse(await fs.readFile(evidencePath, 'utf8'));
  assert.equal(smokeEvidence.status, 'PASS');
  assert.equal(smokeEvidence.sharedDspBuild.runtimeResponse.matchesManifest, true);
  assert.equal(smokeEvidence.sharedDspBuild.runtimeResponse.sha256, publicBuild.artifact.sha256);
  assert.equal(smokeEvidence.sharedDspBuild.sourceSetSha256, publicBuild.sourceSetSha256);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

console.log(JSON.stringify({
  result: 'VERIFIED',
  root,
  appSourceFileCount: sourceManifest.files.length,
  appSourceAssetSetSha256: appAssetSet,
  wasmSha256: publicBuild.artifact.sha256,
  wasmSourceSetSha256: publicBuild.sourceSetSha256,
  wasmBuildSnapshotFileCount,
  smokeStatus: smokeEvidence?.status ?? null,
  smokeAssertionCount: smokeEvidence?.assertions?.length ?? null,
}, null, 2));
