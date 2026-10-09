import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = path.join(repoRoot, 'public', 'dsp', 'webrc-dsp.wasm');
const manifestPath = path.join(repoRoot, 'public', 'dsp', 'webrc-dsp.build.json');
const pinPath = path.join(repoRoot, 'shared', 'dsp', 'wasm', 'browser-build-pin.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const expectedEmsdkCommit = '35ff8a6d150541276abbc6bae512ca90bcfbe220';
const expectedCompiler = /^emcc \(Emscripten gcc\/clang-like replacement \+ linker emulating GNU ld\) 6\.0\.10 \(d6c521a7f05449857c76bd99e396895583cf2083\)$/;
const expectedImports = [
  ['wasi_snapshot_preview1', 'fd_close', 'function'],
  ['wasi_snapshot_preview1', 'fd_write', 'function'],
  ['wasi_snapshot_preview1', 'fd_seek', 'function'],
];

const [wasm, manifestBytes, pinBytes] = await Promise.all([
  fs.readFile(wasmPath), fs.readFile(manifestPath), fs.readFile(pinPath),
]);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const pin = JSON.parse(pinBytes.toString('utf8'));
const artifactHash = sha256(wasm);
if (manifest.schemaVersion !== 1 || manifest.sourceFilesStableDuringBuild !== true ||
    manifest.artifact.file !== 'dsp/webrc-dsp.wasm' ||
    manifest.artifact.byteLength !== wasm.byteLength || manifest.artifact.sha256 !== artifactHash ||
    manifest.build?.emsdkCommit !== expectedEmsdkCommit ||
    !expectedCompiler.test(manifest.build?.compilerIdentity ?? '')) {
  throw new Error('Shared-DSP public assets are missing, unpinned, stale, or inconsistent with their build manifest.');
}
if (pin.schemaVersion !== 1 || pin.artifact?.file !== manifest.artifact.file ||
    pin.artifact?.byteLength !== manifest.artifact.byteLength || pin.artifact?.sha256 !== artifactHash ||
    pin.build?.emsdkCommit !== manifest.build.emsdkCommit ||
    pin.build?.compilerIdentity !== manifest.build.compilerIdentity ||
    pin.sourceSetSha256 !== manifest.sourceSetSha256) {
  throw new Error('Shared-DSP public build manifest does not match its checked-in source pin.');
}

const sourceEntries = Object.entries(manifest.sourceFiles ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const sourceSet = sourceEntries.map(([relative, digest]) => `${relative}=${digest}`).join('\n');
if (sourceEntries.length === 0 || sha256(Buffer.from(sourceSet, 'utf8')) !== manifest.sourceSetSha256) {
  throw new Error('Shared-DSP source-set fingerprint is invalid.');
}
for (const [relative, expectedHash] of sourceEntries) {
  const sourcePath = path.resolve(repoRoot, relative);
  if (!sourcePath.startsWith(`${repoRoot}${path.sep}`) || !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error(`Shared-DSP source manifest contains an invalid path or hash: ${relative}.`);
  }
  const currentHash = sha256(await fs.readFile(sourcePath));
  if (currentHash !== expectedHash) {
    throw new Error(`Shared-DSP build assets are stale because source changed: ${relative}.`);
  }
}

const module = await WebAssembly.compile(wasm);
const imports = WebAssembly.Module.imports(module).map(({ module: name, name: symbol, kind }) => [name, symbol, kind]);
if (JSON.stringify(imports) !== JSON.stringify(expectedImports)) {
  throw new Error('Shared-DSP WebAssembly import surface is not the expected WASI preview1 subset.');
}
console.log(JSON.stringify({
  result: 'VERIFIED',
  byteLength: wasm.byteLength,
  wasmSha256: artifactHash,
  sourceSetSha256: manifest.sourceSetSha256,
  sourceCount: sourceEntries.length,
  emsdkCommit: manifest.build.emsdkCommit,
  compilerIdentity: manifest.build.compilerIdentity,
}, null, 2));
