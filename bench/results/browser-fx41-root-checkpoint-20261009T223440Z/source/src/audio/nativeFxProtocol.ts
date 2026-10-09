/**
 * Pure wire contract for configuring the software Native FX graph.
 *
 * The fixed bus order is input, tracks 0..4, send, master; each bus carries
 * exactly four slots. This module validates and serializes data only. It does
 * not contact the Native HTTP bridge or claim that an ordinal is implemented.
 */

export const NATIVE_FX_BUS_COUNT = 8 as const;
export const NATIVE_FX_SLOTS_PER_BUS = 4 as const;
export const NATIVE_FX_MAXIMUM_BLOCK_FRAMES = 64 as const;
export const NATIVE_FX_MAXIMUM_PARAMETERS_PER_SLOT = 64 as const;
export const NATIVE_FX_MAXIMUM_ORDINAL = 53 as const;
export const NATIVE_FX_MAXIMUM_PARAMETER_ID = 124 as const;
export const NATIVE_FX_SEND_BUS_ROUTED = false as const;

export type NativeFxBusKind = 'input' | 'track' | 'send' | 'master';

export interface NativeFxParameterValue {
  id: number;
  value: number;
}

export interface NativeFxSlotConfiguration {
  enabled: boolean;
  ordinal: number;
  mix: number;
  smoothingMs: number;
  parameters: NativeFxParameterValue[];
}

export interface NativeFxBusConfiguration {
  kind: NativeFxBusKind;
  trackIndex?: number;
  slots: NativeFxSlotConfiguration[];
}

export interface NativeFxBankConfiguration {
  sampleRateHz: number;
  channels: 2;
  maxBlockFrames: 64;
  buses: NativeFxBusConfiguration[];
}

export interface NativeFxParameterEvent {
  absoluteFrame: number;
  busIndex: number;
  slotIndex: number;
  parameterId: number;
  value: number;
}

export interface NativeFxProtocolIssue {
  path: string;
  code: string;
}

const expectedBus = (index: number): { kind: NativeFxBusKind; trackIndex?: number } => {
  if (index === 0) return { kind: 'input' };
  if (index >= 1 && index <= 5) return { kind: 'track', trackIndex: index - 1 };
  if (index === 6) return { kind: 'send' };
  return { kind: 'master' };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const integerInRange = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;

/** Returns every structural/protocol issue without mutating the supplied value. */
export function validateNativeFxBankConfiguration(input: unknown): NativeFxProtocolIssue[] {
  const issues: NativeFxProtocolIssue[] = [];
  if (!isRecord(input)) return [{ path: '$', code: 'object-required' }];

  if (!integerInRange(input.sampleRateHz, 8000, 384000))
    issues.push({ path: '$.sampleRateHz', code: 'sample-rate-out-of-range' });
  if (input.channels !== 2) issues.push({ path: '$.channels', code: 'stereo-required' });
  if (input.maxBlockFrames !== NATIVE_FX_MAXIMUM_BLOCK_FRAMES)
    issues.push({ path: '$.maxBlockFrames', code: 'native-quantum-must-be-64' });
  if (!Array.isArray(input.buses) || input.buses.length !== NATIVE_FX_BUS_COUNT) {
    issues.push({ path: '$.buses', code: 'exactly-eight-buses-required' });
    return issues;
  }

  for (let busIndex = 0; busIndex < NATIVE_FX_BUS_COUNT; busIndex += 1) {
    const busValue = input.buses[busIndex];
    const path = `$.buses[${busIndex}]`;
    const expected = expectedBus(busIndex);
    if (!isRecord(busValue)) {
      issues.push({ path, code: 'object-required' });
      continue;
    }
    if (busValue.kind !== expected.kind ||
        (expected.trackIndex !== undefined && busValue.trackIndex !== expected.trackIndex) ||
        (expected.trackIndex === undefined && Object.prototype.hasOwnProperty.call(busValue, 'trackIndex')))
      issues.push({ path, code: 'bus-order-or-address-mismatch' });
    if (!Array.isArray(busValue.slots) || busValue.slots.length !== NATIVE_FX_SLOTS_PER_BUS) {
      issues.push({ path: `${path}.slots`, code: 'exactly-four-slots-required' });
      continue;
    }

    for (let slotIndex = 0; slotIndex < NATIVE_FX_SLOTS_PER_BUS; slotIndex += 1) {
      const slotValue = busValue.slots[slotIndex];
      const slotPath = `${path}.slots[${slotIndex}]`;
      if (!isRecord(slotValue)) {
        issues.push({ path: slotPath, code: 'object-required' });
        continue;
      }
      if (typeof slotValue.enabled !== 'boolean')
        issues.push({ path: `${slotPath}.enabled`, code: 'boolean-required' });
      if (!finiteNumber(slotValue.mix) || slotValue.mix < 0 || slotValue.mix > 1)
        issues.push({ path: `${slotPath}.mix`, code: 'mix-out-of-range' });
      if (!finiteNumber(slotValue.smoothingMs) || slotValue.smoothingMs < 0 || slotValue.smoothingMs > 1000)
        issues.push({ path: `${slotPath}.smoothingMs`, code: 'smoothing-out-of-range' });
      if (!Array.isArray(slotValue.parameters)) {
        issues.push({ path: `${slotPath}.parameters`, code: 'array-required' });
        continue;
      }
      if (slotValue.parameters.length > NATIVE_FX_MAXIMUM_PARAMETERS_PER_SLOT)
        issues.push({ path: `${slotPath}.parameters`, code: 'too-many-parameters' });

      if (slotValue.enabled !== true) {
        if (slotValue.ordinal !== 0 || slotValue.mix !== 1 || slotValue.smoothingMs !== 5 ||
            slotValue.parameters.length !== 0)
          issues.push({ path: slotPath, code: 'disabled-slot-must-be-canonical-empty' });
        continue;
      }

      if (!integerInRange(slotValue.ordinal, 1, NATIVE_FX_MAXIMUM_ORDINAL))
        issues.push({ path: `${slotPath}.ordinal`, code: 'ordinal-out-of-range' });
      if (busIndex === 6 && NATIVE_FX_SEND_BUS_ROUTED === false)
        issues.push({ path: slotPath, code: 'send-bus-unrouted' });

      const seen = new Set<number>();
      for (let parameterIndex = 0; parameterIndex < slotValue.parameters.length; parameterIndex += 1) {
        const parameterValue = slotValue.parameters[parameterIndex];
        const parameterPath = `${slotPath}.parameters[${parameterIndex}]`;
        if (!isRecord(parameterValue)) {
          issues.push({ path: parameterPath, code: 'object-required' });
          continue;
        }
        if (!integerInRange(parameterValue.id, 1, NATIVE_FX_MAXIMUM_PARAMETER_ID))
          issues.push({ path: `${parameterPath}.id`, code: 'parameter-id-out-of-range' });
        else if (seen.has(parameterValue.id))
          issues.push({ path: `${parameterPath}.id`, code: 'duplicate-parameter-id' });
        else seen.add(parameterValue.id);
        if (!finiteNumber(parameterValue.value))
          issues.push({ path: `${parameterPath}.value`, code: 'finite-value-required' });
      }
    }
  }
  return issues;
}

/** Stable JSON form suitable for a request body after protocol validation. */
export function serializeNativeFxBankConfiguration(input: unknown): string {
  const issues = validateNativeFxBankConfiguration(input);
  if (issues.length !== 0) {
    const first = issues[0]!;
    throw new TypeError(`Invalid Native FX bank at ${first.path}: ${first.code}`);
  }
  const value = input as NativeFxBankConfiguration;
  const normalized: NativeFxBankConfiguration = {
    sampleRateHz: value.sampleRateHz,
    channels: 2,
    maxBlockFrames: NATIVE_FX_MAXIMUM_BLOCK_FRAMES,
    buses: value.buses.map((bus) => ({
      kind: bus.kind,
      ...(bus.kind === 'track' ? { trackIndex: bus.trackIndex } : {}),
      slots: bus.slots.map((slot) => ({
        enabled: slot.enabled,
        ordinal: slot.ordinal,
        mix: slot.mix,
        smoothingMs: slot.smoothingMs,
        parameters: slot.parameters.map(({ id, value: parameterValue }) => ({
          id,
          value: parameterValue,
        })),
      })),
    })),
  };
  return JSON.stringify(normalized);
}

export function validateNativeFxParameterEvent(input: unknown): NativeFxProtocolIssue[] {
  if (!isRecord(input)) return [{ path: '$', code: 'object-required' }];
  const issues: NativeFxProtocolIssue[] = [];
  if (!integerInRange(input.absoluteFrame, 0, Number.MAX_SAFE_INTEGER))
    issues.push({ path: '$.absoluteFrame', code: 'safe-frame-required' });
  if (!integerInRange(input.busIndex, 0, NATIVE_FX_BUS_COUNT - 1))
    issues.push({ path: '$.busIndex', code: 'bus-index-out-of-range' });
  if (!integerInRange(input.slotIndex, 0, NATIVE_FX_SLOTS_PER_BUS - 1))
    issues.push({ path: '$.slotIndex', code: 'slot-index-out-of-range' });
  if (!integerInRange(input.parameterId, 1, NATIVE_FX_MAXIMUM_PARAMETER_ID))
    issues.push({ path: '$.parameterId', code: 'parameter-id-out-of-range' });
  if (!finiteNumber(input.value)) issues.push({ path: '$.value', code: 'finite-value-required' });
  return issues;
}

export function serializeNativeFxParameterEvent(input: unknown): string {
  const issues = validateNativeFxParameterEvent(input);
  if (issues.length !== 0) {
    const first = issues[0]!;
    throw new TypeError(`Invalid Native FX event at ${first.path}: ${first.code}`);
  }
  const event = input as NativeFxParameterEvent;
  return JSON.stringify({
    absoluteFrame: event.absoluteFrame,
    busIndex: event.busIndex,
    slotIndex: event.slotIndex,
    parameterId: event.parameterId,
    value: event.value,
  });
}
