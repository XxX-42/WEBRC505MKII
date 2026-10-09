import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectory = path.resolve(process.argv[2] ?? path.join(repoRoot, 'test-results', 'dsp-wasm'));
const sourceWasmPath = path.join(buildDirectory, 'webrc-dsp.wasm');
const sourceManifestPath = path.join(buildDirectory, 'webrc-dsp.build.json');
const outputDirectory = path.join(repoRoot, 'public', 'dsp');
const outputWasmPath = path.join(outputDirectory, 'webrc-dsp.wasm');
const outputManifestPath = path.join(outputDirectory, 'webrc-dsp.build.json');
const buildPinPath = path.join(repoRoot, 'shared', 'dsp', 'wasm', 'browser-build-pin.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const [sourceWasm, sourceManifestBytes] = await Promise.all([
  fs.readFile(sourceWasmPath), fs.readFile(sourceManifestPath),
]);
const manifest = JSON.parse(sourceManifestBytes.toString('utf8'));
if (manifest.schemaVersion !== 1 || manifest.sourceFilesStableDuringBuild !== true ||
    manifest.artifact.byteLength !== sourceWasm.byteLength || manifest.artifact.sha256 !== sha256(sourceWasm) ||
    manifest.build?.emsdkCommit !== '35ff8a6d150541276abbc6bae512ca90bcfbe220' ||
    !/6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/.test(manifest.build?.compilerIdentity ?? '')) {
  throw new Error('Refusing to install a stale, incomplete, or unpinned shared-DSP WASM build.');
}
const sourceSet = Object.keys(manifest.sourceFiles ?? {}).sort()
  .map(relative => `${relative}=${manifest.sourceFiles[relative]}`).join('\n');
if (!sourceSet || manifest.sourceSetSha256 !== sha256(Buffer.from(sourceSet, 'utf8'))) {
  throw new Error('Refusing to install a shared-DSP build with an inconsistent source-set fingerprint.');
}
for (const [relative, expectedHash] of Object.entries(manifest.sourceFiles ?? {})) {
  const absolute = path.resolve(repoRoot, relative);
  if (!absolute.startsWith(`${repoRoot}${path.sep}`) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`Refusing to install a build with an invalid source path/hash: ${relative}.`);
  }
  const currentHash = sha256(await fs.readFile(absolute));
  if (currentHash !== expectedHash) {
    throw new Error(`Refusing to install stale shared-DSP output; source changed: ${relative}.`);
  }
}
for (const source of [
  'shared/dsp/src/primitives.cpp',
  'shared/dsp/src/pitch.cpp',
  'shared/dsp/src/spatial_temporal.cpp',
  'shared/dsp/src/streaming_yin.cpp',
  'shared/dsp/src/live_mono_pitch.cpp',
  'shared/dsp/src/rhythm.cpp',
  'shared/dsp/src/cleanroom_rhythm_data.cpp',
  'shared/dsp/src/performance_fx.cpp',
  'shared/dsp/src/composite_fx.cpp',
  'shared/dsp/src/modulated_delay_fx.cpp',
  'shared/dsp/src/rhythmic_fx.cpp',
  'shared/dsp/src/spatial_fx_adapters.cpp',
  'shared/dsp/src/modulation_fx.cpp',
  'shared/dsp/src/fx_registry.cpp',
  'shared/dsp/wasm/webrc_dsp_wasm.cpp',
  'shared/dsp/wasm/webrc_dsp_extended.cpp',
  'shared/dsp/wasm/webrc_dsp_fx.cpp',
]) {
  if (!/^[a-f0-9]{64}$/.test(manifest.sourceFiles[source] ?? '')) {
    throw new Error(`Shared-DSP build is missing a fingerprint for ${source}.`);
  }
}

await fs.mkdir(outputDirectory, { recursive: true });
await fs.copyFile(sourceWasmPath, outputWasmPath);
manifest.artifact.file = 'dsp/webrc-dsp.wasm';
await fs.writeFile(outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const pin = {
  schemaVersion: 1,
  artifact: {
    file: manifest.artifact.file,
    byteLength: manifest.artifact.byteLength,
    sha256: manifest.artifact.sha256,
  },
  build: {
    emsdkCommit: manifest.build.emsdkCommit,
    compilerIdentity: manifest.build.compilerIdentity,
  },
  sourceSetSha256: manifest.sourceSetSha256,
};
await fs.writeFile(buildPinPath, `${JSON.stringify(pin, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  result: 'INSTALLED',
  wasm: path.relative(repoRoot, outputWasmPath).replaceAll('\\', '/'),
  manifest: path.relative(repoRoot, outputManifestPath).replaceAll('\\', '/'),
  pin: path.relative(repoRoot, buildPinPath).replaceAll('\\', '/'),
  byteLength: manifest.artifact.byteLength,
  wasmSha256: manifest.artifact.sha256,
  sourceSetSha256: manifest.sourceSetSha256,
}, null, 2));
