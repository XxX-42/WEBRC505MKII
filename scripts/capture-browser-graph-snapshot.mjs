import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputArgument = process.argv[2];
if (!outputArgument) throw new Error('Pass a new output directory under bench/results.');
const outputRoot = path.resolve(repoRoot, outputArgument);
if (!outputRoot.startsWith(`${path.resolve(repoRoot, 'bench', 'results')}${path.sep}`)) {
  throw new Error('Browser graph snapshots must be created under bench/results.');
}
const wasmSourceRoot = path.resolve(repoRoot, process.argv[3] ?? '.');
await fs.access(path.join(wasmSourceRoot, 'shared', 'dsp'));
await fs.mkdir(outputRoot, { recursive: false });

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const copyFile = async (relativePath, sourceRoot = repoRoot) => {
  const sourcePath = path.resolve(sourceRoot, relativePath);
  const targetPath = path.resolve(outputRoot, relativePath);
  if (!sourcePath.startsWith(`${sourceRoot}${path.sep}`) ||
      !targetPath.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error(`Snapshot source path escapes its root: ${relativePath}`);
  }
  const bytes = await fs.readFile(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, bytes);
  return { path: relativePath.replaceAll(path.sep, '/'), bytes: bytes.byteLength, sha256: digest(bytes) };
};
const copyTree = async (relativeDirectory) => {
  const directory = path.resolve(repoRoot, relativeDirectory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const copied = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in snapshot source: ${relativeDirectory}/${entry.name}`);
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) copied.push(...await copyTree(relative));
    else if (entry.isFile()) copied.push(await copyFile(relative));
  }
  return copied;
};

const appFiles = [];
for (const relativePath of [
  'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json',
  'tsconfig.app.json', 'tsconfig.node.json', 'postcss.config.js', 'tailwind.config.js',
  'scripts/browser-realtime-smoke.mjs', 'scripts/verify-shared-dsp-assets.mjs',
  'scripts/install-shared-dsp-assets.mjs', 'scripts/capture-browser-graph-snapshot.mjs',
  'shared/dsp/wasm/browser-build-pin.json',
]) {
  try { appFiles.push(await copyFile(relativePath)); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
appFiles.push(...await copyTree('src'));
appFiles.push(...await copyTree('public'));

const buildManifestBytes = await fs.readFile(path.join(repoRoot, 'public', 'dsp', 'webrc-dsp.build.json'));
const buildManifest = JSON.parse(buildManifestBytes.toString('utf8'));
const copiedBuildSources = [];
for (const relativePath of Object.keys(buildManifest.sourceFiles ?? {}).sort()) {
  const copied = await copyFile(relativePath, wasmSourceRoot);
  if (copied.sha256 !== buildManifest.sourceFiles[relativePath]) {
    throw new Error(`WASM source snapshot mismatch for ${relativePath}: ${copied.sha256}`);
  }
  copiedBuildSources.push(copied);
}

await fs.writeFile(path.join(outputRoot, 'README.md'), [
  '# Browser graph smoke source snapshot',
  '',
  `Captured at ${new Date().toISOString()}.`,
  '',
  `The manifest pins ${appFiles.length} app source/assets plus ${copiedBuildSources.length} exact WASM compiler inputs.`,
  'The WASM module and build manifest are copied under public/dsp and are included in the snapshot inventory.',
  'Node dependencies are resolved from the locked package-lock.json in the parent checkout; browser version and actual fetched WASM identity are recorded by the smoke report.',
  '',
].join('\n'), 'utf8');
const readme = await fs.readFile(path.join(outputRoot, 'README.md'));
appFiles.push({ path: 'README.md', bytes: readme.byteLength, sha256: digest(readme) });

const fileMap = new Map();
for (const entry of [...appFiles, ...copiedBuildSources]) fileMap.set(entry.path, entry);
const files = [...fileMap.values()].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const canonical = files.map(({ path: relativePath, sha256 }) => `${relativePath}=${sha256}`).join('\n');
const manifest = {
  schemaVersion: 1,
  capturedAtUtc: new Date().toISOString(),
  appRootSource: repoRoot,
  wasmSourceRoot,
  nodeVersion: process.version,
  wasmBuildManifestSha256: digest(buildManifestBytes),
  wasmSourceSetSha256: buildManifest.sourceSetSha256 ?? null,
  wasmArtifactSha256: buildManifest.artifact?.sha256 ?? null,
  wasmArtifactBytes: buildManifest.artifact?.byteLength ?? null,
  fileCount: files.length,
  appFileCount: appFiles.length,
  wasmBuildSourceCount: copiedBuildSources.length,
  sourceAssetSetSha256: digest(Buffer.from(canonical, 'utf8')),
  sourceAssetSetCanonicalization: 'files sorted by UTF-8 path using JS code-point order; each line path=lowercase SHA-256; LF joined with no trailing LF',
  files,
};
await fs.writeFile(path.join(outputRoot, 'snapshot-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  outputRoot,
  fileCount: files.length,
  appFileCount: appFiles.length,
  wasmBuildSourceCount: copiedBuildSources.length,
  sourceAssetSetSha256: manifest.sourceAssetSetSha256,
  wasmSourceSetSha256: manifest.wasmSourceSetSha256,
  wasmArtifactSha256: manifest.wasmArtifactSha256,
}, null, 2));
