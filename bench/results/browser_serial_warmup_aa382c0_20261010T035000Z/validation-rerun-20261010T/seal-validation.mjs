import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceRoot = path.dirname(fileURLToPath(import.meta.url));
const archiveRoot = path.resolve(evidenceRoot, '..');
const sourceRoot = path.join(archiveRoot, 'repo');
const graphRoot = path.join(sourceRoot, 'bench', 'results', 'browser-graph-source');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hashPath = async p => sha(await fs.readFile(p));
const inputsPath = path.join(archiveRoot, 'snapshot-inputs.json');
const inputsBytes = await fs.readFile(inputsPath);
const inputs = JSON.parse(inputsBytes.toString('utf8'));
const snapshotManifestPath = path.join(graphRoot, 'snapshot-manifest.json');
const snapshotManifestBytes = await fs.readFile(snapshotManifestPath);
const snapshotManifest = JSON.parse(snapshotManifestBytes.toString('utf8'));

assert.equal(snapshotManifest.schemaVersion, 1);
assert.equal(snapshotManifest.fileCount, 167);
assert.equal(snapshotManifest.sourceAssetSetSha256, '5a5faa7e8fb1c89774c3dcbeecca2248cc881f5addb5d884911e4b3a4ca3a33f');
const snapshotCanonical = snapshotManifest.files.map(x => x.path + '=' + x.sha256).join('\n');
assert.equal(sha(Buffer.from(snapshotCanonical, 'utf8')), snapshotManifest.sourceAssetSetSha256);

const sourceEntries = [];
for (const entry of snapshotManifest.files) {
  const absolute = path.resolve(graphRoot, entry.path);
  assert.ok(absolute.startsWith(graphRoot + path.sep));
  const bytes = await fs.readFile(absolute);
  assert.equal(bytes.byteLength, entry.bytes, 'size mismatch: ' + entry.path);
  assert.equal(sha(bytes), entry.sha256, 'hash mismatch: ' + entry.path);
  sourceEntries.push({ path: 'sourceSnapshot/' + entry.path, bytes: entry.bytes, sha256: entry.sha256 });
}

const overlayEntries = [];
for (const overlay of inputs.overlayFiles ?? []) {
  const absolute = path.resolve(sourceRoot, overlay.path);
  const bytes = await fs.readFile(absolute);
  assert.equal(bytes.byteLength, overlay.bytes, 'overlay size mismatch: ' + overlay.path);
  assert.equal(sha(bytes), overlay.sha256, 'overlay hash mismatch: ' + overlay.path);
  overlayEntries.push({ path: 'overlay/' + overlay.path, bytes: bytes.byteLength, sha256: overlay.sha256 });
}
const zipPath = path.join(archiveRoot, 'head-archive.zip');
const zipSha = await hashPath(zipPath);
assert.equal(zipSha, inputs.archiveZipSha256, 'git archive zip hash mismatch');
const auxiliary = [
  { path: 'snapshot-inputs.json', absolute: inputsPath },
  { path: 'head-archive.zip', absolute: zipPath },
  { path: 'sourceSnapshot/snapshot-manifest.json', absolute: snapshotManifestPath },
];
const validationFiles = (await fs.readdir(evidenceRoot, { withFileTypes: true }))
  .filter(e => e.isFile() && !['validation-manifest.json', 'SHA256SUMS.txt'].includes(e.name))
  .map(e => ({ path: 'validation/' + e.name, absolute: path.join(evidenceRoot, e.name) }));
const auxiliaryEntries = [];
for (const item of auxiliary) {
  const bytes = await fs.readFile(item.absolute);
  auxiliaryEntries.push({ path: item.path, bytes: bytes.byteLength, sha256: sha(bytes) });
}
for (const item of validationFiles) {
  const bytes = await fs.readFile(item.absolute);
  auxiliaryEntries.push({ path: item.path, bytes: bytes.byteLength, sha256: sha(bytes) });
}

const rows = [...sourceEntries, ...overlayEntries, ...auxiliaryEntries]
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const canonical = rows.map(x => x.path + '=' + x.sha256).join('\n');
const evidenceSetSha256 = sha(Buffer.from(canonical, 'utf8'));
const buildManifestPath = path.join(graphRoot, 'public', 'dsp', 'webrc-dsp.build.json');
const buildManifest = JSON.parse(await fs.readFile(buildManifestPath, 'utf8'));
const wasmPath = path.join(graphRoot, 'public', 'dsp', 'webrc-dsp.wasm');
const wasmSha256 = await hashPath(wasmPath);
assert.equal(wasmSha256, buildManifest.artifact.sha256);
const packageLockPath = path.join(sourceRoot, 'package-lock.json');
const packageLockSha256 = await hashPath(packageLockPath);
const verifyBeforePath = path.join(evidenceRoot, 'source-verify-before.stdout.log');
const verifyAfterPath = path.join(evidenceRoot, 'source-verify-after.stdout.log');
for (const p of [verifyBeforePath, verifyAfterPath]) {
  const result = JSON.parse(await fs.readFile(p, 'utf8'));
  assert.equal(result.result, 'VERIFIED');
  assert.equal(result.fileCount, 167);
  assert.equal(result.sourceAssetSetSha256, snapshotManifest.sourceAssetSetSha256);
}
const buildExit = Number((await fs.readFile(path.join(evidenceRoot, 'build.exit-code.txt'), 'utf8')).trim());
const unitExit = Number((await fs.readFile(path.join(evidenceRoot, 'unit-retry.exit-code.txt'), 'utf8')).trim());
assert.equal(buildExit, 0);
assert.equal(unitExit, 0);
const manifest = {
  schemaVersion: 1,
  status: 'verified',
  repositoryHead: inputs.repositoryHead,
  sourceSnapshot: {
    archiveRoot: path.relative(process.cwd(), archiveRoot).replaceAll(path.sep, '/'),
    gitArchiveZipSha256: zipSha,
    trackedTreeSha256: inputs.trackedTreeSha256,
    trackedFileCount: inputs.trackedFileCount,
    overlayFiles: inputs.overlayFiles,
    graphSnapshotPath: 'repo/bench/results/browser-graph-source',
    graphSnapshotManifestSha256: sha(snapshotManifestBytes),
    graphSnapshotFileCount: snapshotManifest.fileCount,
    sourceAssetSetSha256: snapshotManifest.sourceAssetSetSha256,
  },
  runtime: {
    nodeVersion: process.version,
    npmVersion: '11.17.0',
    powershellVersion: '7.5.3',
    dependencyResolution: 'snapshot repo/node_modules is a junction to the main checkout node_modules; package-lock.json is pinned and hash-recorded',
    packageLockSha256,
  },
  wasmBaseline: {
    artifactSha256: wasmSha256,
    artifactBytes: buildManifest.artifact.byteLength,
    buildManifestSha256: sha(await fs.readFile(buildManifestPath)),
    sourceSetSha256: buildManifest.sourceSetSha256,
    emsdkCommit: buildManifest.build.emsdkCommit,
    compilerIdentity: buildManifest.build.compilerIdentity,
  },
  validation: {
    build: { command: 'npm run build', exitCode: buildExit, stdout: 'validation-rerun-20261010T/build.stdout.log', stderr: 'validation-rerun-20261010T/build.stderr.log' },
    unit: { command: 'npm run test:unit', exitCode: unitExit, testFiles: 32, tests: 200, stdout: 'validation-rerun-20261010T/unit-retry.stdout.log', stderr: 'validation-rerun-20261010T/unit-retry.stderr.log' },
    sourceVerifierBefore: 'validation-rerun-20261010T/source-verify-before.stdout.log',
    sourceVerifierAfter: 'validation-rerun-20261010T/source-verify-after.stdout.log',
    concurrentLoadFailedRun: {
      retained: true,
      exitCode: Number((await fs.readFile(path.join(evidenceRoot, 'unit.exit-code.txt'), 'utf8')).trim()),
      stdout: 'validation-rerun-20261010T/unit.stdout.log',
      stderr: 'validation-rerun-20261010T/unit.stderr.log',
      note: 'Two pre-existing timeout limits fired only in this overlapping load run; the quiet full rerun passed 200/200.',
    },
  },
  evidenceFileCount: rows.length,
  evidenceSetSha256,
  evidenceSetCanonicalization: 'paths sorted by ordinal/code-point comparison; each line path=lowercase SHA-256; UTF-8 LF joined with no trailing LF',
  files: rows,
};
await fs.writeFile(path.join(evidenceRoot, 'validation-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(path.join(evidenceRoot, 'SHA256SUMS.txt'),
  rows.map(x => x.sha256 + '  ' + x.path).join('\n') + '\n');
console.log(JSON.stringify({
  result: 'VERIFIED',
  sourceAssetSetSha256: manifest.sourceSnapshot.sourceAssetSetSha256,
  evidenceFileCount: manifest.evidenceFileCount,
  evidenceSetSha256,
  packageLockSha256,
  wasmSha256,
  validationManifestSha256: sha(await fs.readFile(path.join(evidenceRoot, 'validation-manifest.json'))),
  sha256SumsFileSha256: sha(await fs.readFile(path.join(evidenceRoot, 'SHA256SUMS.txt'))),
}, null, 2));