import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const [moduleArg, manifestArg] = process.argv.slice(2);

function fail(message) {
  console.error(`pitch-wasm-runner: ${message}`);
  process.exit(1);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function repoPath(relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    fail(`manifest path must be repository-relative: ${String(relativePath)}`);
  }
  const absolute = path.resolve(repoRoot, relativePath);
  const relative = path.relative(repoRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`manifest path escapes repository: ${relativePath}`);
  }
  return absolute;
}

if (!moduleArg || !manifestArg) fail('usage: node run-pitch-tests.mjs <test-module.cjs> <build-manifest.json>');
const manifestPath = path.resolve(manifestArg);
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (error) {
  fail(`cannot read build manifest: ${error.message}`);
}

if (manifest.schemaVersion !== 1 || manifest.suite !== 'shared-dsp-pitch-wasm-functional') {
  fail('unsupported build manifest schema or suite');
}
if (manifest.sourceFilesStableDuringBuild !== true || !manifest.sourceFiles || !manifest.build || !Array.isArray(manifest.artifacts)) {
  fail('manifest is incomplete or records an unstable build');
}
if (!/35ff8a6d150541276abbc6bae512ca90bcfbe220/.test(manifest.build.emsdkCommit ?? '')) {
  fail('manifest does not identify the pinned emsdk manager commit');
}
if (!/6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/.test(manifest.build.compilerIdentity ?? '')) {
  fail('manifest does not identify the pinned Emscripten compiler');
}

const sourceEntries = Object.entries(manifest.sourceFiles);
if (sourceEntries.length === 0) fail('manifest source set is empty');
const canonicalSourceSet = sourceEntries
  .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  .map(([relative, digest]) => `${relative}=${digest}`)
  .join('\n');
const sourceSetHash = crypto.createHash('sha256').update(canonicalSourceSet, 'utf8').digest('hex');
if (sourceSetHash !== manifest.sourceSetSha256) fail('manifest source-set digest is invalid');

const sourceDifferences = [];
for (const [relativePath, expectedHash] of sourceEntries) {
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) fail(`invalid source digest for ${relativePath}`);
  const absolute = repoPath(relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    sourceDifferences.push(`${relativePath} (missing)`);
    continue;
  }
  if (sha256(absolute) !== expectedHash) sourceDifferences.push(relativePath);
}
if (sourceDifferences.length) {
  fail(`current working tree differs from this WASM build: ${sourceDifferences.join(', ')}`);
}

const modulePath = path.resolve(moduleArg);
const artifactByPath = new Map(manifest.artifacts.map((entry) => [entry.file, entry]));
const moduleRelative = path.relative(repoRoot, modulePath).split(path.sep).join('/');
const moduleArtifact = artifactByPath.get(moduleRelative);
if (!moduleArtifact) fail(`test module is not listed in manifest: ${moduleRelative}`);
for (const suffix of [moduleArtifact, ...manifest.artifacts.filter((item) => item.file.endsWith('.wasm'))]) {
  const artifact = repoPath(suffix.file);
  if (!fs.existsSync(artifact) || !fs.statSync(artifact).isFile()) fail(`missing build artifact: ${suffix.file}`);
  const details = fs.statSync(artifact);
  if (details.size !== suffix.byteLength || sha256(artifact) !== suffix.sha256) {
    fail(`artifact size/hash mismatch: ${suffix.file}`);
  }
}

console.log(`pitch-wasm-built-source=${manifest.sourceSetSha256}`);
console.log(`pitch-wasm-current-source=match (${sourceEntries.length} files)`);
for (const artifact of manifest.artifacts) console.log(`pitch-wasm-artifact=${artifact.file} sha256=${artifact.sha256}`);
console.log(`pitch-wasm-toolchain=${manifest.build.compilerIdentity}`);

const result = spawnSync(process.execPath, [modulePath], { cwd: path.dirname(modulePath), stdio: 'inherit' });
if (result.error) fail(`could not start test module: ${result.error.message}`);
if (result.signal) fail(`test module terminated by signal ${result.signal}`);
if (result.status !== 0) fail(`test module exited with status ${result.status}`);
console.log('pitch-wasm-result=PASS');
