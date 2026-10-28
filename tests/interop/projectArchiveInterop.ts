import { readFile, writeFile } from 'node:fs/promises';
import { decodeProjectArchive, encodeProjectArchive } from '../../src/audio/projectArchive';

const [mode, path] = process.argv.slice(2);
if (!mode || !path) throw new Error('Expected mode and archive path.');

if (mode === 'write-ts-v2') {
  const archive = await encodeProjectArchive({
    name: 'TS interop',
    bpm: 120,
    tracks: [
      { pcm: new Float32Array([0.25, -0.5, 1]), sampleRate: 48_000, frameCount: 3, channels: 1, originalTempoBpm: 93.5 },
      { pcm: new Float32Array([1, -1, 0.75, -0.75]), sampleRate: 48_000, frameCount: 2, channels: 2, originalTempoBpm: null },
      null, null, null,
    ],
  }, { version: 2 });
  await writeFile(path, archive);
} else if (mode === 'read-cpp-v2') {
  const project = await decodeProjectArchive(await readFile(path));
  if (project.version !== 2 || project.name !== 'C++ interop' || project.bpm !== 120
    || project.tracks[0]?.originalTempoBpm !== 87.25
    || project.tracks[0]?.pcm.join(',') !== '0.5,-0.25,0.125'
    || project.tracks[1]?.originalTempoBpm !== null
    || project.tracks[1]?.pcm.join(',') !== '1,-1,0.75,-0.75') {
    throw new Error('TypeScript did not preserve C++ v2 project fields and PCM.');
  }
} else {
  throw new Error(`Unsupported interop mode: ${mode}`);
}
