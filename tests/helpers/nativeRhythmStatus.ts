import type { NativeRhythmConfig, NativeStatus } from '../../src/audio/NativeBridgeClient';

export function nativeRhythmStatus(settings: Partial<NativeRhythmConfig> = {}): NativeStatus {
  return {
    ok: true, bridgeHealthy: true, engineRunning: true, backend: 'WASAPI',
    inputDeviceId: 'in', outputDeviceId: 'out', inputDeviceName: 'Input', outputDeviceName: 'Output',
    sampleRate: 48000, bufferFrames: 128, monitoringEnabled: false, state: 'Empty',
    inputLatencyMs: 0, outputLatencyMs: 0, roundTripEstimateMs: 0,
    inputPeak: 0, outputPeak: 0, xrunsOrDropouts: 0, lastError: '', loopProgress: 0,
    nativeRhythm: {
      available: true, enabled: false, bpm: 120, kitIndex: 1, patternIndex: 106,
      variation: 'A', section: 'main', swingPercent: 50, quantizeGrid: '1/16', volume: 50,
      patternCatalogAvailable: true, patternId: 'rhythm-106', genre: 'ROCK', pattern: 'ROCK1', beat: '4/4',
      meterNumerator: 4, meterDenominator: 4, eventsCleanRoomProcedural: true,
      patternSource: 'metadata-only-240-pattern-catalog', statusNote: 'Clean-room generated events and voices.',
      ...settings,
    },
  };
}
