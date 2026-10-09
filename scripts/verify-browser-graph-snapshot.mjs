import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshotRoot = path.resolve(process.argv[2] ?? path.join(
  repoRoot, 'bench', 'results', 'browser_graph_snapshot_20261009T131900Z_preintegration',
));
const manifestPath = path.join(snapshotRoot, 'snapshot-manifest.json');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error('Browser graph snapshot manifest is not a supported nonempty schema-v1 file list.');
}

for (const entry of manifest.files) {
  if (typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    throw new Error('Browser graph snapshot contains an invalid path, size, or SHA-256 field.');
  }
  const absolute = path.resolve(snapshotRoot, entry.path);
  if (!absolute.startsWith(`${snapshotRoot}${path.sep}`)) {
    throw new Error(`Snapshot path escapes its root: ${entry.path}`);
  }
  const bytes = await fs.readFile(absolute);
  if (bytes.byteLength !== entry.bytes || digest(bytes) !== entry.sha256) {
    throw new Error(`Snapshot file does not match its immutable manifest: ${entry.path}`);
  }
}

// Canonical sourceAssetSet is the manifest's recorded file order, with each
// entry encoded as path=lowercaseSha256 and entries joined by LF (no trailing LF).
const canonical = manifest.files.map(({ path: relative, sha256 }) => `${relative}=${sha256}`).join('\n');
const actualSetHash = digest(Buffer.from(canonical, 'utf8'));
if (actualSetHash !== manifest.sourceAssetSetSha256) {
  throw new Error(`Snapshot sourceAssetSetSha256 mismatch: ${actualSetHash}`);
}

console.log(JSON.stringify({
  result: 'VERIFIED',
  snapshotRoot,
  capturedAtUtc: manifest.capturedAtUtc,
  fileCount: manifest.files.length,
  sourceAssetSetSha256: actualSetHash,
}, null, 2));
