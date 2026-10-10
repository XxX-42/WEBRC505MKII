import { describe, expect, it } from 'vitest';
import {
  NATIVE_FX_BUS_COUNT,
  NATIVE_FX_SLOTS_PER_BUS,
  serializeNativeFxBankConfiguration,
  serializeNativeFxControlEvent,
  serializeNativeFxParameterEvent,
  validateNativeFxBankConfiguration,
  validateNativeFxControlEvent,
  validateFxMidiInputEvent,
  validateNativeFxParameterEvent,
  type NativeFxBankConfiguration,
} from '../../src/audio/nativeFxProtocol';

function emptyBank(): NativeFxBankConfiguration {
  const buses: NativeFxBankConfiguration['buses'] = [
    { kind: 'input', slots: [] },
    ...Array.from({ length: 5 }, (_, trackIndex) => ({
      kind: 'track' as const,
      trackIndex,
      slots: [],
    })),
    { kind: 'send', slots: [] },
    { kind: 'master', slots: [] },
  ];
  for (const bus of buses) {
    bus.slots = Array.from({ length: NATIVE_FX_SLOTS_PER_BUS }, () => ({
      enabled: false,
      ordinal: 0,
      mix: 1,
      smoothingMs: 5,
      parameters: [],
    }));
  }
  return { sampleRateHz: 48000, channels: 2, maxBlockFrames: 64, buses };
}

describe('NativeFxProtocol', () => {
  it('serializes a stable 8 bus by 4 slot bank with canonical bus order', () => {
    const config = emptyBank();
    config.buses[0]!.slots[0] = {
      enabled: true,
      ordinal: 1,
      mix: 0.75,
      smoothingMs: 8,
      parameters: [{ id: 48, value: 1 }, { id: 1, value: 900 }],
    };
    expect(validateNativeFxBankConfiguration(config)).toEqual([]);
    const json = serializeNativeFxBankConfiguration(config);
    const parsed = JSON.parse(json) as NativeFxBankConfiguration;
    expect(parsed.buses).toHaveLength(NATIVE_FX_BUS_COUNT);
    expect(parsed.buses.every((bus) => bus.slots.length === NATIVE_FX_SLOTS_PER_BUS)).toBe(true);
    expect(parsed.buses[2]).toMatchObject({ kind: 'track', trackIndex: 1 });
    expect(parsed.buses[6]).toMatchObject({ kind: 'send' });
    expect(parsed.buses[7]).toMatchObject({ kind: 'master' });
  });

  it('rejects malformed geometry, unsupported send placement, duplicate controls, and non-finite values', () => {
    const config = emptyBank();
    config.buses[6]!.slots[0] = {
      enabled: true,
      ordinal: 1,
      mix: 1,
      smoothingMs: 5,
      parameters: [{ id: 48, value: 1 }, { id: 48, value: Number.NaN }],
    };
    config.buses[3]!.trackIndex = 4;
    const issues = validateNativeFxBankConfiguration(config);
    expect(issues.map(({ code }) => code)).toEqual(expect.arrayContaining([
      'send-bus-unrouted',
      'duplicate-parameter-id',
      'finite-value-required',
      'bus-order-or-address-mismatch',
    ]));
    expect(() => serializeNativeFxBankConfiguration(config)).toThrow(TypeError);
  });

  it('rejects sparse arrays at bus, slot, and parameter positions before serialization', () => {
    const sparseBus = emptyBank();
    delete sparseBus.buses[4];
    expect(validateNativeFxBankConfiguration(sparseBus)).toContainEqual({
      path: '$.buses[4]',
      code: 'object-required',
    });
    expect(() => serializeNativeFxBankConfiguration(sparseBus)).toThrow(TypeError);

    const sparseSlot = emptyBank();
    delete sparseSlot.buses[1]!.slots[2];
    expect(validateNativeFxBankConfiguration(sparseSlot)).toContainEqual({
      path: '$.buses[1].slots[2]',
      code: 'object-required',
    });
    expect(() => serializeNativeFxBankConfiguration(sparseSlot)).toThrow(TypeError);

    const sparseParameter = emptyBank();
    sparseParameter.buses[0]!.slots[0] = {
      enabled: true,
      ordinal: 1,
      mix: 1,
      smoothingMs: 5,
      parameters: new Array(1),
    };
    expect(validateNativeFxBankConfiguration(sparseParameter)).toContainEqual({
      path: '$.buses[0].slots[0].parameters[0]',
      code: 'object-required',
    });
    expect(() => serializeNativeFxBankConfiguration(sparseParameter)).toThrow(TypeError);
  });

  it('validates safe absolute frame event records without accepting fractional or NaN fields', () => {
    const event = { absoluteFrame: 128, busIndex: 1, slotIndex: 3, parameterId: 56, value: -1 };
    expect(validateNativeFxParameterEvent(event)).toEqual([]);
    expect(serializeNativeFxParameterEvent(event)).toBe(
      '{"absoluteFrame":128,"busIndex":1,"slotIndex":3,"parameterId":56,"value":-1}',
    );
    expect(validateNativeFxParameterEvent({ ...event, absoluteFrame: 1.5, value: Infinity }))
      .toEqual(expect.arrayContaining([
        { path: '$.absoluteFrame', code: 'safe-frame-required' },
        { path: '$.value', code: 'finite-value-required' },
      ]));
  });

  it('validates typed MIDI records and keeps DSP channels zero-based', () => {
    const noteOn = {
      kind: 'midi', absoluteFrame: 512, busIndex: 0, slotIndex: 1,
      midiType: 'NoteOn', channel: 0, note: 60, velocity: 100,
    } as const;
    expect(validateNativeFxControlEvent(noteOn)).toEqual([]);
    expect(serializeNativeFxControlEvent(noteOn)).toBe(JSON.stringify(noteOn));
    expect(validateNativeFxControlEvent({ ...noteOn, channel: 16 })).toContainEqual({
      path: '$.channel', code: 'midi-channel-out-of-range',
    });
    expect(validateNativeFxControlEvent({ ...noteOn, midiType: 'NoteOn', velocity: 0 })).toContainEqual({
      path: '$.velocity', code: 'note-on-velocity-must-be-positive',
    });
    const allOff = { ...noteOn, midiType: 'AllNotesOff', note: 0, velocity: 0 } as const;
    expect(validateNativeFxControlEvent(allOff)).toEqual([]);
  });

  it('validates normalized WebMIDI timestamps and NoteOn/AllNotesOff payloads', () => {
    expect(validateFxMidiInputEvent({
      type: 'NoteOn', channel: 15, note: 127, velocity: 1, timestampMs: 12.5,
    })).toEqual([]);
    expect(validateFxMidiInputEvent({
      type: 'AllNotesOff', channel: 2, note: 0, velocity: 0, timestampMs: 0,
    })).toEqual([]);
    expect(validateFxMidiInputEvent({
      type: 'NoteOn', channel: 16, note: 128, velocity: 0, timestampMs: -1,
    }).map(({ code }) => code)).toEqual(expect.arrayContaining([
      'midi-channel-out-of-range', 'midi-note-out-of-range', 'monotonic-timestamp-required',
      'note-on-velocity-must-be-positive',
    ]));
  });
});
