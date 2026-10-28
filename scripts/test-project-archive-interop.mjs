import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const codecExe = process.argv[2];
if (!codecExe) throw new Error('Pass the built project_archive_codec_interop executable path.');
const runner = join(root, 'node_modules', 'vite-node', 'vite-node.mjs');
const helper = join(root, 'tests', 'interop', 'projectArchiveInterop.ts');
const temp = mkdtempSync(join(tmpdir(), 'rc505-archive-interop-'));
const typescriptArchive = join(temp, 'typescript-v2.rcpa');
const cppArchive = join(temp, 'cpp-v2.rcpa');

function runNode(mode, path) {
  const result = spawnSync(process.execPath, [runner, helper, mode, path], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`TypeScript ${mode} failed:\n${result.stdout}\n${result.stderr}`);
}

try {
  runNode('write-ts-v2', typescriptArchive);
  execFileSync(codecExe, ['read-ts-v2', typescriptArchive], { cwd: root, stdio: 'inherit' });
  execFileSync(codecExe, ['write-cpp-v2', cppArchive], { cwd: root, stdio: 'inherit' });
  runNode('read-cpp-v2', cppArchive);
  console.log('TypeScript -> C++ and C++ -> TypeScript v2 archive interoperability passed.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
