import { describe, expect, it } from 'vitest';
import { decodeProjectArchive, encodeProjectArchive } from '../../src/project/projectArchive';
import { createDefaultProjectDocument } from '../../src/project/projectValidation';
import { readBlobArrayBuffer } from '../../src/project/blobUtils';
import { encodeAudioBufferToNativeWavBlobAsync, inspectWavHeader } from '../../src/project/wavCodec';

describe('project archive', () => {
  it('exports the versioned project JSON and native-rate audio as separate binary assets', async () => {
    const document = createDefaultProjectDocument('stereo-loop');
    document.tracks[0]!.audioAssetId = 'track-1';
    document.tracks[0]!.settings.loopFrames = 3;
    const audio = {
      sampleRate: 48_000,
      length: 3,
      numberOfChannels: 2,
      getChannelData: (channel: number) => channel === 0
        ? Float32Array.from([0.25, -0.5, 0.75])
        : Float32Array.from([-0.25, 0.5, -0.75]),
    };
    const wav = await encodeAudioBufferToNativeWavBlobAsync(audio);
    const archive = await encodeProjectArchive(document, new Map([['track-1', wav]]));
    const loaded = await decodeProjectArchive(archive);
    expect(loaded.document.name).toBe('stereo-loop');
    expect(loaded.document.tracks[0]!.audioAssetId).toBe('track-1');
    expect(loaded.assets.size).toBe(1);
    expect(await inspectWavHeader(loaded.assets.get('track-1')!)).toMatchObject({ sampleRate: 48_000, channels: 2, frames: 3 });
    expect(new Uint8Array(await readBlobArrayBuffer(loaded.assets.get('track-1')!)).length).toBe(wav.size);
  });

  it('rejects a corrupted or unreferenced asset before returning an importable project', async () => {
    const document = createDefaultProjectDocument('damaged');
    document.tracks[0]!.audioAssetId = 'track-1';
    const wav = await encodeAudioBufferToNativeWavBlobAsync({
      sampleRate: 48_000, length: 1, numberOfChannels: 1, getChannelData: () => Float32Array.of(0.25),
    });
    const bytes = new Uint8Array(await readBlobArrayBuffer(wav));
    bytes[0] = 0;
    await expect(encodeProjectArchive(document, new Map([['track-1', bytes]]))).rejects.toThrow(/RIFF\/WAVE/);
    await expect(encodeProjectArchive(document, new Map())).rejects.toThrow(/match the document/);
  });

  it('rejects unsupported schema, invalid enums, or mismatched track audio references', async () => {
    const document = createDefaultProjectDocument();
    document.global.playMode = 'BROKEN' as never;
    await expect(encodeProjectArchive(document, new Map())).rejects.toThrow(/project.global.playMode/);
    const valid = createDefaultProjectDocument();
    valid.tracks[0]!.audioAssetId = 'missing';
    await expect(encodeProjectArchive(valid, new Map())).rejects.toThrow(/audio assets/);
  });
});
