import { mergeOfficialParameterEdit } from '../audio/fx/official/parameters';
import { computed, onScopeDispose, reactive, ref, watch } from 'vue';
import { AudioEngine, type AudioDeviceInfo, type AudioDeviceSelection } from '../audio/AudioEngine';
import { NativeProjectImportIndeterminateError, NativeProjectImportOutcomeUnknownError } from '../audio/NativeBridgeClient';
import { ProjectMemory } from '../audio/projectMemory';
import { PROJECT_ARCHIVE_LIMITS } from '../audio/projectArchive';
import type { ProjectMemoryMetadata } from '../audio/projectMemoryStore';
import { nativeCatalogMacroParameters } from '../audio/nativeFxCatalog';
import { PREAMP_MODELS } from '../audio/preampParameters';
import { SYNTH_WAVEFORMS } from '../audio/synthParameters';
import { ROLL_DIRECTIONS, ROLL_SLICE_BEATS } from '../audio/rollParameters';
import { AUTO_RIFF_RATE_OPTIONS, AUTO_RIFF_SCALE_OPTIONS } from '../audio/autoRiffParameters';
import { HRM_AUTO_KEY_OPTIONS, HRM_AUTO_SCALE_OPTIONS } from '../audio/hrmAutoParameters';
import { STEP_SLICER_COUNT_OPTIONS, STEP_SLICER_RATE_OPTIONS } from '../audio/nativeStepSlicerParameters';
import { Transport } from '../core/Transport';
import { RHYTHM_PATTERN_CATALOG, RHYTHM_SECTIONS, RHYTHM_VARIATIONS, DRUM_KIT_CATALOG, RHYTHM_QUANTIZE_GRIDS } from '../audio/rhythm';
import type { WavSampleFormat } from '../audio/export/wavEncoder';
import { getDeviceTrackController } from './deviceTrackControllers';
import { useBrowserTrackFxState } from './useBrowserTrackFxState';
import { useDevicePanel, type DevicePanelPage } from './useDevicePanel';
import { useFxPanelState, type FxSlotState } from './useFxPanelState';
import { useNativeTrackFxState } from './useNativeTrackFxState';
import { usePanelFocus, type FxSlotId } from './usePanelFocus';
import { useRhythmUiControls, rhythmUiState } from './rhythmUiState';
import { useTrackFxTargetState } from './useTrackFxTargetState';
import type { DeviceEditorPanel } from './createEnhancedDevicePanel';
import { useRc505Controls } from './useRc505Controls';

export type DeviceScreenFieldKind = 'number' | 'enum' | 'boolean' | 'action';

export interface DeviceScreenOption {
  label: string;
  value: number;
}

export interface DeviceScreenField {
  key: string;
  label: string;
  value: number;
  kind: DeviceScreenFieldKind;
  options?: readonly DeviceScreenOption[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  reason?: string;
  format?: (value: number) => string;
  setValue?: (value: number) => void | boolean | Promise<void | boolean>;
  activate?: () => void | boolean | Promise<void | boolean>;
}

export interface DeviceScreenEditorOptions {
  surface?: 'classic' | 'enhanced';
  panel?: DeviceEditorPanel;
  setInputMacro?: (value: number) => void;
  setTrackMacro?: (value: number) => void;
  setInputParameter?: (group: string, key: string, value: number) => void;
  setTrackParameter?: (group: string, key: string, value: number) => void;
  confirm?: (message: string) => Promise<boolean>;
}

const slotIds: readonly FxSlotId[] = ['A', 'B', 'C', 'D'];
const targetOptions = [
  { label: 'SHARED BANK', value: 0 },
  { label: 'TRACK 1', value: 1 },
  { label: 'TRACK 2', value: 2 },
  { label: 'TRACK 3', value: 3 },
  { label: 'TRACK 4', value: 4 },
  { label: 'TRACK 5', value: 5 },
] as const;
const loopStorageOptions = [
  { label: '768 MIB · 48 KHZ / 300 S', value: 768 * 1024 * 1024 },
  { label: '1.5 GIB · 96 KHZ / 300 S', value: 1536 * 1024 * 1024 },
  { label: '2.5 GIB · 192 KHZ / 300 S', value: 2560 * 1024 * 1024 },
] as const;
const livePitchOptions = [
  { label: 'OFF', value: 0, mode: 'OFF' },
  { label: 'LIVE MONO', value: 1, mode: 'LIVE_MONO' },
  { label: 'LIVE POLY', value: 2, mode: 'LIVE_POLY' },
] as const;
const wavFormats: readonly WavSampleFormat[] = ['pcm16', 'pcm24', 'float32'];
const wavFormatOptions = [
  { label: 'PCM 16-BIT', value: 0 },
  { label: 'PCM 24-BIT', value: 1 },
  { label: 'FLOAT 32-BIT', value: 2 },
] as const;
const pitchBendDirections = [{ label: 'UP', value: 0 }, { label: 'DOWN', value: 1 }] as const;
const rollDirectionOptions = ROLL_DIRECTIONS.map((value, index) => ({
  value,
  label: ['FORWARD', 'REVERSE', 'ALTERNATE'][index]!,
}));
const electricCharacterOptions = [
  { label: 'CLASSIC', value: 0 },
  { label: 'METALLIC', value: 1 },
  { label: 'VOCODER', value: 2 },
  { label: 'BIT-CRUSH', value: 3 },
] as const;
const vocoderCarrierOptions = [
  { label: 'NOISE', value: 0 },
  { label: 'SAW', value: 1 },
  { label: 'SQUARE', value: 2 },
] as const;

interface ParameterSpec {
  min: number;
  max: number;
  step?: number;
  options?: readonly DeviceScreenOption[];
  unit?: string;
}

const numericSpec = (min: number, max: number, step = 1, unit = ''): ParameterSpec => ({ min, max, step, unit });
const enumSpec = (options: readonly DeviceScreenOption[]): ParameterSpec => ({
  min: Math.min(...options.map((option) => option.value)),
  max: Math.max(...options.map((option) => option.value)),
  step: 1,
  options,
});

function nativeParameterStep(minimum: number, maximum: number, defaultValue: number): number {
  const range = maximum - minimum;
  const decimals = Math.min(4, Math.max(
    (String(minimum).split('.')[1] ?? '').length,
    (String(maximum).split('.')[1] ?? '').length,
    (String(Number(defaultValue.toFixed(4))).split('.')[1] ?? '').length,
    range > 0 && range <= 1 ? 2 : 0,
  ));
  return decimals ? 10 ** -decimals : 1;
}

function sequentialOptions(labels: readonly string[]): DeviceScreenOption[] {
  return labels.map((label, value) => ({ label, value }));
}

function rangeOptions(values: readonly number[], label: (value: number) => string = String): DeviceScreenOption[] {
  return values.map((value) => ({ label: label(value), value }));
}

const parameterSpecs: Readonly<Record<string, Readonly<Record<string, ParameterSpec>>>> = {
  PREAMP: {
    model: enumSpec(sequentialOptions(PREAMP_MODELS)), gainPercent: numericSpec(0, 100, 1, '%'),
    bassDb: numericSpec(-12, 12, 1, 'dB'), middleDb: numericSpec(-12, 12, 1, 'dB'),
    trebleDb: numericSpec(-12, 12, 1, 'dB'), levelDb: numericSpec(-24, 12, 1, 'dB'),
  },
  SYNTH: {
    sensitivity: numericSpec(0, 100, 1, '%'), waveform: enumSpec(sequentialOptions(SYNTH_WAVEFORMS)),
    octave: numericSpec(-24, 24, 1, 'st'), tone: numericSpec(100, 16_000, 10, 'Hz'), mix: numericSpec(0, 100, 1, '%'),
  },
  G2B: { tracking: numericSpec(0, 100, 1, '%'), blend: numericSpec(0, 100, 1, '%'), body: numericSpec(60, 1200, 1, 'Hz') },
  ROLL: {
    sliceBeats: enumSpec(rangeOptions(ROLL_SLICE_BEATS, (value) => value < 1 ? `1/${Math.round(1 / value)} NOTE` : `${value} BEAT${value === 1 ? '' : 'S'}`)),
    decayPercent: numericSpec(0, 100, 1, '%'), pitchSemitones: numericSpec(-24, 24, 1, 'st'), direction: enumSpec(rollDirectionOptions),
  },
  FREEZE: { captureLengthMs: numericSpec(2, 2000, 1, 'ms'), pitchSemitones: numericSpec(-24, 24, 1, 'st') },
  'PITCH BEND': {
    rangeSemitones: numericSpec(0, 24, 1, 'st'), timeMs: numericSpec(20, 4000, 1, 'ms'),
    direction: enumSpec(pitchBendDirections), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  'HRM MANUAL': {
    voice1Interval: numericSpec(-24, 24, 1, 'st'), voice2Interval: numericSpec(-24, 24, 1, 'st'),
    panPercent: numericSpec(-100, 100, 1, '%'), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  OCTAVE: {
    minus24Level: numericSpec(0, 100, 1, '%'), minus12Level: numericSpec(0, 100, 1, '%'),
    plus12Level: numericSpec(0, 100, 1, '%'), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  VOCODER: { bands: numericSpec(8, 24, 1), carrier: enumSpec(vocoderCarrierOptions), mixPercent: numericSpec(0, 100, 1, '%') },
  'OSC VOC (M)': {
    waveform: enumSpec(sequentialOptions(SYNTH_WAVEFORMS)), midiChannel: numericSpec(1, 16, 1),
    octaveSemitones: numericSpec(-24, 24, 1, 'st'), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  'AUTO RIFF': {
    scale: enumSpec(AUTO_RIFF_SCALE_OPTIONS.map(({ label, value }) => ({ label: label.toUpperCase(), value }))),
    rateBeats: enumSpec(rangeOptions(AUTO_RIFF_RATE_OPTIONS, (value) => value < 1 ? `1/${Math.round(1 / value)}` : `${value}`)),
    sensitivityPercent: numericSpec(0, 100, 1, '%'), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  'AUTO RIFF (EXPERIMENTAL)': {
    scale: enumSpec(AUTO_RIFF_SCALE_OPTIONS.map(({ label, value }) => ({ label: label.toUpperCase(), value }))),
    rateBeats: enumSpec(rangeOptions(AUTO_RIFF_RATE_OPTIONS, (value) => value < 1 ? `1/${Math.round(1 / value)}` : `${value}`)),
    sensitivityPercent: numericSpec(0, 100, 1, '%'), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  ROBOT: {
    targetPitchSemitones: numericSpec(-24, 24, 1, 'st'), formantShiftSemitones: numericSpec(-12, 12, 1, 'st'), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  'ROBOT (EXPERIMENTAL)': {
    targetPitchSemitones: numericSpec(-24, 24, 1, 'st'), formantShiftSemitones: numericSpec(-12, 12, 1, 'st'), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  'HRM AUTO (M)': {
    key: enumSpec(HRM_AUTO_KEY_OPTIONS.map(({ label, value }) => ({ label, value }))),
    scale: enumSpec(HRM_AUTO_SCALE_OPTIONS.map(({ label, value }) => ({ label: label.toUpperCase(), value }))),
    midiChannel: numericSpec(1, 16, 1), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  ELECTRIC: {
    character: enumSpec(electricCharacterOptions), pitchSnapPercent: numericSpec(0, 100, 1, '%'),
    toneHz: numericSpec(100, 16_000, 10, 'Hz'), mixPercent: numericSpec(0, 100, 1, '%'),
  },
  'STEP SLICER': {
    step_count: enumSpec(rangeOptions(STEP_SLICER_COUNT_OPTIONS)),
    rate_beats: enumSpec(rangeOptions(STEP_SLICER_RATE_OPTIONS, (value) => value < 1 ? `1/${Math.round(1 / value)}` : `${value}`)),
    depth_percent: numericSpec(0, 100, 1, '%'), pan_depth_percent: numericSpec(0, 100, 1, '%'),
    filter_hz: numericSpec(20, 20_000, 10, 'Hz'),
    ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`step_${String(index + 1).padStart(2, '0')}`, numericSpec(0, 100, 1, '%')])),
  },
};

const friendlyKey = (key: string) => key
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .toUpperCase();

function chunks(items: DeviceScreenField[], size = 4): DeviceScreenField[][] {
  const pages: DeviceScreenField[][] = [];
  for (let offset = 0; offset < items.length; offset += size) pages.push(items.slice(offset, offset + size));
  return pages.length ? pages : [[]];
}

function eventConfirmation(message: string, surface: 'classic' | 'enhanced' = 'enhanced'): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent('rc505-request-confirmation', { detail: { message, surface, resolve } }));
  });
}

const MONITORING_WARNING = [
  'WARNING: FEEDBACK RISK!',
  '',
  'Enabling THRU routes microphone audio to the speakers.',
  'Use headphones only. Speakers can cause loud feedback.',
  '',
  'Enable THRU?',
].join('\n');

/**
 * Owns the page content shown on the device LCD. Every editable control uses
 * the existing engine/composable path so Browser and Native retain their own
 * capability checks and status semantics.
 */
export function useDeviceScreenEditor(options: DeviceScreenEditorOptions = {}) {
  const device = options.panel ?? useDevicePanel();
  const classic = options.surface === 'classic';
  const controls = useRc505Controls();
  const confirmAction = options.confirm ?? ((message: string) => eventConfirmation(message, options.surface ?? 'enhanced'));
  const focus = usePanelFocus();
  const engine = AudioEngine.getInstance();
  const projectMemory = new ProjectMemory(engine);
  const input = useFxPanelState('input');
  const trackFx = useTrackFxTargetState({ sharedOnly: classic });
  const browserTrack = useBrowserTrackFxState();
  const nativeTrack = useNativeTrackFxState();
  const rhythm = useRhythmUiControls({ initializeOnMount: false });
  const active = computed(() => !['home', 'mixer'].includes(device.state.page));
  const selectedFieldIndex = ref(0);
  const statusText = ref('');
  const editPending = ref(false);
  const memorySlot = ref(1);
  const memoryName = ref('MEMORY 01');
  const memoryNotice = ref('V1 PCM + BPM + LOOP/SIGNATURE · FX/KIT/PATTERN SETTINGS NOT SAVED');
  const pendingNativeImportGeneration = ref<number | null>(null);
  const memorySlots = ref<readonly ProjectMemoryMetadata[]>([]);
  const memoryStorageReady = ref(typeof indexedDB !== 'undefined');
  let memoryMetadataRevision = 0;
  let editRevision = 0;
  const settings = reactive({
    selection: null as AudioDeviceSelection | null,
    loading: false,
    loaded: false,
    error: '',
    loopbackRunning: false,
  });
  const statusRevision = ref(0);
  const unsubscribeStatus = engine.onStatusChange(() => { statusRevision.value += 1; });
  if (unsubscribeStatus) onScopeDispose(unsubscribeStatus);

  const currentInputSlot = computed(() => input.slots.value.find((slot) => slot.id === input.activeSlot.value) ?? input.slots.value[0] ?? null);
  const currentTrackFx = computed(() => trackFx.activeFx.value);
  const currentTrackId = computed(() => focus.state.currentTrackId);
  const currentTrackController = computed(() => getDeviceTrackController(currentTrackId.value));
  const pageIndex = computed(() => device.state.editorPageIndex);
  const pageCount = computed(() => device.state.editorPageCount);
  const fieldOptions = (labels: readonly string[]): DeviceScreenOption[] => labels.map((label, value) => ({ label, value }));

  async function runEdit(action: () => void | boolean | Promise<void | boolean>): Promise<void> {
    const revision = ++editRevision;
    statusText.value = '';
    editPending.value = true;
    try {
      if (await action() === false) throw new Error('The audio runtime did not accept this control.');
      statusRevision.value += 1;
      if (revision === editRevision) statusText.value = '';
    } catch (error) {
      if (revision === editRevision) statusText.value = error instanceof Error ? error.message : String(error);
    } finally {
      if (revision === editRevision) editPending.value = false;
    }
  }

  function makeEnumField(
    key: string,
    label: string,
    value: number,
    fieldOptions: readonly DeviceScreenOption[],
    setValue: (value: number) => void | boolean | Promise<void | boolean>,
    extra: Partial<DeviceScreenField> = {},
  ): DeviceScreenField {
    return { key, label, value, kind: 'enum', options: fieldOptions, setValue, ...extra };
  }

  function makeNumberField(
    key: string,
    label: string,
    value: number,
    setValue: (value: number) => void | boolean | Promise<void | boolean>,
    extra: Partial<DeviceScreenField> = {},
  ): DeviceScreenField {
    return { key, label, value, kind: 'number', step: 1, setValue, ...extra };
  }

  function makeBooleanField(
    key: string,
    label: string,
    value: boolean,
    setValue: (value: boolean) => void | boolean | Promise<void | boolean>,
    extra: Partial<DeviceScreenField> = {},
  ): DeviceScreenField {
    return { key, label, value: value ? 100 : 0, kind: 'boolean', min: 0, max: 100, step: 100, options: [{ label: 'OFF', value: 0 }, { label: 'ON', value: 100 }], format: (next) => next >= 50 ? 'ON' : 'OFF', setValue: (next) => setValue(next >= 50), ...extra };
  }

  function makeActionField(
    key: string,
    label: string,
    activate: () => void | boolean | Promise<void | boolean>,
    extra: Partial<DeviceScreenField> = {},
  ): DeviceScreenField {
    return { key, label, value: 0, kind: 'action', activate, ...extra };
  }

  function selectSlot(target: 'input' | 'track', index: number): void {
    const slot = slotIds[index];
    if (!slot) return;
    if (target === 'input') input.selectSlot(slot);
    else trackFx.selectSlot(slot);
  }

  function setFxType(target: 'input' | 'track', index: number): void {
    const source = target === 'input' ? input.fxOptions.value : trackFx.fxOptions.value;
    const type = source[index];
    if (!type) return;
    if (target === 'input') {
      const slot = currentInputSlot.value;
      if (slot) slot.type = type;
      return;
    }
    trackFx.setType(type);
  }

  function fxBaseFields(target: 'input' | 'track'): DeviceScreenField[] {
    if (target === 'input') {
      const slot = currentInputSlot.value;
      if (!slot) return [];
      const currentIndex = Math.max(0, slotIds.indexOf(slot.id));
      const typeOptions = input.fxOptions.value.map((label, value) => ({ label, value }));
      return [
        makeEnumField('slot', 'SLOT', currentIndex, fieldOptions(slotIds), (index) => selectSlot('input', index)),
        makeEnumField('type', 'EFFECT TYPE', Math.max(0, typeOptions.findIndex((option) => option.label === slot.type)), typeOptions, (index) => setFxType('input', index), {
          disabled: input.fxDisabled.value,
          reason: input.fxUnavailableReason.value || 'Input FX is unavailable on this runtime.',
        }),
        makeNumberField('amount', 'AMOUNT', slot.value, (value) => {
          if (input.fxDisabled.value || slot.type === 'NONE' || !slot.type) return;
          if (options.setInputMacro) options.setInputMacro(value);
          else slot.value = Math.max(0, Math.min(100, value));
        }, { min: 0, max: 100, step: 1, disabled: input.fxDisabled.value || slot.type === 'NONE' || !slot.type, reason: slot.type === 'NONE' ? 'Select an effect first.' : input.fxUnavailableReason.value }),
        makeBooleanField('active', 'ACTIVE', slot.active, (enabled) => { if (!input.fxDisabled.value && slot.type && slot.type !== 'NONE') slot.active = enabled; }, {
          disabled: input.fxDisabled.value || slot.type === 'NONE' || !slot.type,
          reason: slot.type === 'NONE' ? 'Select an effect first.' : input.fxUnavailableReason.value,
        }),
      ];
    }

    const fx = currentTrackFx.value;
    if (!fx) return [];
    const typeOptions = trackFx.fxOptions.value.map((label, value) => ({ label, value }));
    const targetIndex = typeof trackFx.target.value === 'number' ? trackFx.target.value : 0;
    const selectableTargets = targetOptions.filter((option) => {
      if (option.value === 0) return true;
      if (engine.getMode() === 'native') {
        const nativeOptions = engine.getNativeCatalogFxOptions('track', option.value)
          .filter((type) => type !== 'VINYL FLICK' && type !== 'VINYL FLICK (EXPERIMENTAL)' && type !== 'BEAT SHIFT');
        return engine.isTrackAvailable(option.value) && nativeOptions.length > 0;
      }
      const capabilities = engine.getTrackCapabilities(option.value);
      return capabilities.isAvailable && capabilities.supportsTrackFx;
    });
    return [
      makeEnumField('target', 'FX TARGET', targetIndex, selectableTargets, (value) => { trackFx.selectTarget(value === 0 ? 'shared' : value); }, {
        reason: 'Only tracks exposing independent Track FX are listed.',
      }),
      makeEnumField('slot', 'SLOT', Math.max(0, slotIds.indexOf(trackFx.activeSlot.value)), fieldOptions(slotIds), (index) => selectSlot('track', index)),
      makeEnumField('type', 'EFFECT TYPE', Math.max(0, typeOptions.findIndex((option) => option.label === fx.type)), typeOptions, (index) => setFxType('track', index), {
        disabled: trackFx.fxDisabled.value,
        reason: trackFx.fxUnavailableReason.value,
      }),
      makeNumberField('amount', 'AMOUNT', fx.value, (value) => {
        if (trackFx.fxDisabled.value || trackFx.activeFxIsEmpty.value) return;
        if (options.setTrackMacro) options.setTrackMacro(value);
        else trackFx.setValue(value);
      }, { min: 0, max: 100, step: 1, disabled: trackFx.fxDisabled.value || trackFx.activeFxIsEmpty.value, reason: trackFx.activeFxIsEmpty.value ? 'Select an effect first.' : trackFx.fxUnavailableReason.value }),
      makeBooleanField('active', 'ACTIVE', fx.active, (enabled) => { trackFx.setActive(enabled); }, {
        disabled: trackFx.fxDisabled.value || trackFx.activeFxIsEmpty.value,
        reason: trackFx.activeFxIsEmpty.value ? 'Select an effect first.' : trackFx.fxUnavailableReason.value,
      }),
    ];
  }

  function sharedParameterFields(
    location: 'input' | 'track',
    slot: FxSlotState,
    params: Record<string, unknown>,
  ): DeviceScreenField[] {
    const group = parameterObjectKey(slot.type);
    const callback = location === 'input' ? options.setInputParameter : options.setTrackParameter;
    if (!group) return [];
    const output: DeviceScreenField[] = [];
    for (const [key, raw] of Object.entries(params)) {
      const spec = parameterSpecs[slot.type]?.[key];
      const isBoolean = typeof raw === 'boolean';
      const numericValue = isBoolean ? (raw ? 100 : 0) : raw;
      if (typeof numericValue !== 'number' || !Number.isFinite(numericValue)) continue;
      const unsupported = !spec;
      const disabled = !callback || unsupported;
      const reason = !callback
        ? 'This detailed control is not wired to the LCD parameter controller.'
        : unsupported ? 'No verified range or choice list exists for this effect parameter.' : '';
      const fieldKey = location === 'input' ? `input-${key}` : `track-shared-${key}`;
      const setNumeric = (value: number) => callback?.(group, key, value);
      if (isBoolean) {
        output.push(makeBooleanField(fieldKey, friendlyKey(key), raw, (value) => setNumeric(value ? 100 : 0), {
          disabled, reason,
        }));
      } else if (spec?.options) {
        output.push(makeEnumField(fieldKey, friendlyKey(key), numericValue, spec.options, setNumeric, {
          min: spec.min, max: spec.max, step: spec.step ?? 1, disabled, reason,
        }));
      } else {
        output.push(makeNumberField(fieldKey, friendlyKey(key), numericValue, setNumeric, {
          ...(spec ? { min: spec.min, max: spec.max, step: spec.step ?? 1 } : {}),
          ...(spec?.unit ? { format: (value: number) => `${value}${spec.unit === '%' ? '%' : ` ${spec.unit}`}` } : {}),
          disabled, reason,
        }));
      }
    }
    return output;
  }

  function nativeCatalogParameterFields(
    location: 'input' | 'track',
    slot: FxSlotState,
    slotIndex: number,
    applyOverrides: (parameters: Record<string, number>) => boolean,
    pending: boolean,
  ): DeviceScreenField[] {
    const schema = engine.getNativeCatalogFxParameterSchema(slot.type, location, 0, slot.namedParametersByType?.[slot.type] ?? {}, slotIndex);
    if (!schema) {
      return [makeActionField(`native-${location}-schema-unavailable`, 'NAMED CONTROLS UNAVAILABLE', () => false, {
        disabled: true,
        reason: 'This Native host does not advertise a valid parameter schema. Ranges are not guessed.',
      })];
    }
    if (schema.parameters.length === 0) {
      return [makeActionField(`native-${location}-parameters-unavailable`, 'NO NAMED CONTROLS', () => false, {
        disabled: true,
        reason: `The Native host advertises no named controls for ${slot.type}.`,
      })];
    }
    const overrides = slot.namedParametersByType?.[slot.type] ?? {};
    const macro = nativeCatalogMacroParameters(slot.type, slot.value);
    const runtime = location === 'input' ? input.runtimeStatus.value : trackFx.runtimeStatus.value;
    const needsRestart = runtime?.pendingRestart === true;
    const waitForAck = pending || runtime?.pendingApply === true || runtime?.outcomeUnknown === true;
    const disabled = needsRestart || waitForAck;
    const reason = needsRestart
      ? 'Restart Native audio to apply the selected effect before editing named controls.'
      : waitForAck ? 'Wait for the current Native ACK or status reconciliation before editing again.' : '';
    const fields: DeviceScreenField[] = [];
    for (const descriptor of schema.parameters) {
      const currentValue = overrides[descriptor.id] ?? macro[descriptor.id] ?? descriptor.defaultValue;
      if (!Number.isFinite(currentValue)) continue;
      const setParameter = (next: number) => {
        if (next < descriptor.minimum || next > descriptor.maximum ||
            (descriptor.discrete && !descriptor.discreteValues?.includes(next))) return false;
        return applyOverrides(mergeOfficialParameterEdit(overrides, descriptor.id, next));
      };
      if (descriptor.discrete && descriptor.discreteValues?.length) {
        fields.push(makeEnumField(
          `native-${location}-${slotIndex}-${descriptor.id}`,
          descriptor.label,
          currentValue,
          descriptor.discreteValues.map((choice) => ({ label: descriptor.options?.find(option => option.value === choice)?.label ?? String(choice), value: choice })),
          setParameter,
          { min: descriptor.minimum, max: descriptor.maximum, step: 1, disabled, reason },
        ));
      } else {
        fields.push(makeNumberField(
          `native-${location}-${slotIndex}-${descriptor.id}`,
          descriptor.label,
          currentValue,
          setParameter,
          {
            min: descriptor.minimum,
            max: descriptor.maximum,
            step: descriptor.step ?? nativeParameterStep(descriptor.minimum, descriptor.maximum, descriptor.defaultValue),
            disabled,
            reason,
          },
        ));
      }
    }
    if (Object.keys(overrides).length > 0) {
      fields.push(makeActionField(`native-${location}-${slotIndex}-reset-named`, 'RESET NAMED OVERRIDES', () => applyOverrides({}), {
        disabled,
        reason,
      }));
    }
    return fields;
  }

  function inputFxFields(): DeviceScreenField[][] {
    const slot = currentInputSlot.value;
    const base = fxBaseFields('input');
    const details: DeviceScreenField[] = [];
    if (slot && slot.type && slot.type !== 'NONE') {
      const paramName = inputParameterObjectKey(slot);
      const params = paramName ? slot[paramName] as Record<string, unknown> | undefined : undefined;
      if (engine.getMode() === 'native' && !params) {
        const slotIndex = input.slots.value.findIndex((candidate) => candidate.id === slot.id);
        if (slotIndex >= 0) details.push(...nativeCatalogParameterFields(
          'input', slot, slotIndex,
          (parameters) => input.setNativeNamedParameters(slotIndex, parameters),
          input.nativeNamedParametersPending.value,
        ));
      } else if (params) details.push(...sharedParameterFields('input', slot, params));
    }
    return [base, ...chunks(details)].filter((page, index) => index === 0 || page.length > 0);
  }

  function trackFxFields(): DeviceScreenField[][] {
    const base = fxBaseFields('track');
    const details: DeviceScreenField[] = [];
    const fx = currentTrackFx.value;
    if (!fx || trackFx.activeFxIsEmpty.value || trackFx.fxDisabled.value) return chunks(base);

    if (!trackFx.isSharedTarget.value && typeof trackFx.target.value === 'number') {
      if (trackFx.mode.value === 'browser') {
        for (const control of browserTrack.controls.value) {
          const existing = 'namedParameters' in fx ? fx.namedParameters[control.key] : undefined;
          const value = typeof existing === 'number' ? existing : control.defaultValue;
          const controlOptions = control.options?.map((option) => ({ label: option.label, value: option.value })) ?? undefined;
          const setter = (next: number) => browserTrack.setNamedParameters(trackFx.target.value as number, trackFx.activeSlotIndex.value, { [control.key]: next });
          details.push(controlOptions?.length
            ? makeEnumField(`track-${control.key}`, control.label, value, controlOptions, setter, { min: control.min, max: control.max, step: control.step, format: (n) => `${n}${control.unit === '0–1' ? '' : ` ${control.unit}`}` })
            : makeNumberField(`track-${control.key}`, control.label, value, setter, { min: control.min, max: control.max, step: control.step, format: (n) => `${n}${control.unit === '0–1' ? '' : ` ${control.unit}`}` }));
        }
      } else {
        const nativeFx = nativeTrack.activeFx.value;
        const parameters = nativeFx?.namedParameters ?? {};
        const defaults = nativeCatalogMacroParameters(fx.type, fx.value);
        const schema = engine.getNativeCatalogFxParameterSchema(fx.type, 'track', trackFx.target.value, parameters, nativeTrack.activeSlotIndex.value);
        if (!schema) {
          details.push(makeActionField('native-parameter-schema-unavailable', 'NAMED CONTROLS UNAVAILABLE', () => {}, {
            disabled: true,
            reason: 'This Native host does not advertise a valid parameter schema. Generic ranges are not guessed; use a schema-aware host or the advanced JSON editor, which is still validated by Native.',
          }));
          return [...chunks(base), ...chunks(details)].filter((page, index) => index < chunks(base).length || page.length > 0);
        }
        for (const descriptor of schema.parameters) {
          const key = descriptor.id;
          const value = parameters[key] ?? defaults[key] ?? descriptor.defaultValue;
          if (!Number.isFinite(value)) continue;
          const setParameter = (next: number) => {
            if (next < descriptor.minimum || next > descriptor.maximum ||
                (descriptor.discrete && !descriptor.discreteValues?.includes(next))) return false;
            return nativeTrack.setNamedParameters(trackFx.target.value as number, trackFx.activeSlotIndex.value, mergeOfficialParameterEdit(parameters, key, next));
          };
          if (descriptor.discrete && descriptor.discreteValues?.length) {
            details.push(makeEnumField(`native-${key}`, descriptor.label, value,
              descriptor.discreteValues.map((choice) => ({ label: descriptor.options?.find(option => option.value === choice)?.label ?? String(choice), value: choice })), setParameter, {
                min: descriptor.minimum, max: descriptor.maximum, step: 1,
              }));
          } else {
            details.push(makeNumberField(`native-${key}`, descriptor.label, value, setParameter, {
              min: descriptor.minimum, max: descriptor.maximum,
              step: descriptor.step ?? nativeParameterStep(descriptor.minimum, descriptor.maximum, descriptor.defaultValue),
            }));
          }
        }
      }
    } else {
      const paramName = trackParameterObjectKey(fx);
      const params = paramName ? (fx as unknown as FxSlotState)[paramName] as Record<string, unknown> | undefined : undefined;
      if (params) details.push(...sharedParameterFields('track', fx as FxSlotState, params));
      else if (engine.getMode() === 'native') {
        const slotIndex = trackFx.activeSlotIndex.value;
        if (slotIndex >= 0) details.push(...nativeCatalogParameterFields(
          'track', fx as FxSlotState, slotIndex,
          (parameters) => trackFx.setSharedNativeNamedParameters(parameters),
          trackFx.nativeNamedParametersPending.value,
        ));
      }
    }
    return [...chunks(base), ...chunks(details)].filter((page, index) => index < chunks(base).length || page.length > 0);
  }

  function inputParameterObjectKey(slot: FxSlotState): keyof FxSlotState | null {
    return parameterObjectKey(slot.type);
  }

  function trackParameterObjectKey(slot: FxSlotState | NonNullable<typeof currentTrackFx.value>): keyof FxSlotState | null {
    return parameterObjectKey(slot.type);
  }

  function parameterObjectKey(type: string): keyof FxSlotState | null {
    const keys: Record<string, keyof FxSlotState> = {
      PREAMP: 'preampParameters', SYNTH: 'synthParameters', G2B: 'g2bParameters', ROLL: 'rollParameters',
      FREEZE: 'freezeParameters', 'PITCH BEND': 'pitchBendParameters', 'HRM MANUAL': 'manualHarmonistParameters',
      OCTAVE: 'octaveParameters', VOCODER: 'vocoderParameters', 'OSC VOC (M)': 'oscVocParameters',
      'AUTO RIFF': 'autoRiffParameters', 'AUTO RIFF (EXPERIMENTAL)': 'autoRiffParameters',
      ROBOT: 'robotParameters', 'ROBOT (EXPERIMENTAL)': 'robotParameters', 'HRM AUTO (M)': 'hrmAutoParameters', ELECTRIC: 'electricParameters',
      'STEP SLICER': 'stepSlicerParameters',
    };
    return keys[type] ?? null;
  }

  function rhythmFields(): DeviceScreenField[][] {
    const patternOptions = RHYTHM_PATTERN_CATALOG.map((pattern) => ({ label: `${pattern.globalIndex} · ${pattern.genre} / ${pattern.pattern}`, value: pattern.globalIndex }));
    const kitOptions = DRUM_KIT_CATALOG.map((kit) => ({ label: `${kit.index} · ${kit.officialName}`, value: kit.index }));
    const base: DeviceScreenField[] = [
      makeNumberField('bpm', 'TEMPO', Transport.getInstance().bpm, (value) => { Transport.getInstance().setBpm(Math.max(40, Math.min(300, Math.round(value)))); }, { min: 40, max: 300, step: 1, disabled: rhythm.disabled.value, reason: rhythm.message.value }),
      makeNumberField('volume', 'VOLUME', rhythm.volume.value, async (value) => { rhythm.volume.value = Math.max(0, Math.min(100, value)); await rhythm.updateVolume(); }, { min: 0, max: 100, step: 1, disabled: rhythm.disabled.value, reason: rhythm.message.value }),
      makeEnumField('pattern', 'PATTERN', rhythmUiState.patternIndex, patternOptions, (value) => { void rhythm.updateSelection({ patternIndex: value }); }, { disabled: rhythm.disabled.value, reason: rhythm.message.value }),
      makeEnumField('kit', 'KIT', rhythmUiState.kitIndex, kitOptions, (value) => { void rhythm.updateSelection({ kitIndex: value }); }, { disabled: rhythm.disabled.value, reason: rhythm.message.value }),
      makeEnumField('variation', 'VARIATION', RHYTHM_VARIATIONS.indexOf(rhythmUiState.variation), fieldOptions(RHYTHM_VARIATIONS), (value) => { void rhythm.updateSelection({ variation: RHYTHM_VARIATIONS[value] ?? 'A' }); }, { disabled: rhythm.disabled.value, reason: rhythm.message.value }),
      makeEnumField('section', 'SECTION', RHYTHM_SECTIONS.indexOf(rhythmUiState.section), fieldOptions(RHYTHM_SECTIONS.map((item) => item.toUpperCase())), (value) => { void rhythm.updateSelection({ section: RHYTHM_SECTIONS[value] ?? 'main' }); }, { disabled: rhythm.disabled.value, reason: rhythm.message.value }),
      makeNumberField('swing', 'SWING', rhythmUiState.swingPercent, (value) => { void rhythm.updateSelection({ swingPercent: Math.max(50, Math.min(75, Math.round(value))) }); }, { min: 50, max: 75, step: 1, disabled: rhythm.disabled.value, reason: rhythm.message.value }),
      makeEnumField('quantize', 'QUANTIZE', RHYTHM_QUANTIZE_GRIDS.indexOf(rhythmUiState.quantizeGrid), fieldOptions(RHYTHM_QUANTIZE_GRIDS), (value) => { void rhythm.updateSelection({ quantizeGrid: RHYTHM_QUANTIZE_GRIDS[value] ?? '1/16' }); }, { disabled: rhythm.disabled.value, reason: rhythm.message.value }),
      makeActionField('play-stop', rhythm.isPlaying.value ? 'STOP RHYTHM' : 'START RHYTHM', async () => { await rhythm.toggleRhythm(); }, { disabled: rhythm.disabled.value || rhythm.pending.value, reason: rhythm.message.value }),
    ];
    return chunks(base);
  }

  function trackFields(): DeviceScreenField[][] {
    const controller = currentTrackController.value;
    if (!controller) return [[makeActionField('track-controller-missing', 'TRACK CONTROLS UNAVAILABLE', () => {}, { disabled: true, reason: 'Track controller has not mounted yet.' })]];
    const trackCapabilities = engine.getTrackCapabilities(currentTrackId.value);
    const audioTrack = engine.tracks[currentTrackId.value - 1];
    const modeOptions = livePitchOptions.filter((option) => option.value === 0
      || (option.value === 1 && controller.liveMonoPitchSupported.value)
      || (option.value === 2 && controller.livePolyPitchSupported.value));
    const modeValue = livePitchOptions.find((option) => option.mode === controller.livePitchMode.value)?.value ?? 0;
    const rendererOptions = controller.nativeHqRendererEngines.value.map((name, index) => ({ label: name, value: index }));
    const rendererIndex = rendererOptions.findIndex((option) => option.label === controller.hqNativeEngine.value);
    const fields: DeviceScreenField[] = [
      makeNumberField('track-level', 'TRACK LEVEL', controller.playLevel.value, (value) => controller.handleLevelChange(value), { min: 0, max: 100, step: 1, disabled: !controller.levelControlEnabled.value, reason: controller.trackLevelUnavailableReason.value }),
      makeBooleanField('track-reverse', 'REVERSE', audioTrack?.isReverse === true, (enabled) => {
        if (audioTrack && audioTrack.isReverse !== enabled) engine.toggleReverse(currentTrackId.value - 1);
      }, { disabled: !trackCapabilities.supportsReverse, reason: trackCapabilities.supportsReverse ? '' : trackCapabilities.reverseReason || 'Reverse playback is unavailable on this runtime.' }),
      makeEnumField('keep-pitch', 'KEEP PITCH', modeValue, modeOptions, (value) => {
        const selected = modeOptions.find((option) => option.value === value);
        if (!selected) return;
        controller.livePitchMode.value = selected.mode as typeof controller.livePitchMode.value;
        controller.handleLivePitchModeChange();
      }, { disabled: controller.livePitchControlsDisabled.value, reason: controller.livePitchFallbackReason.value || 'KeepPitch is unavailable for this track or while recording.' }),
      makeNumberField('keep-pitch-semitones', 'PITCH SHIFT', controller.livePitchSemitones.value, (value) => {
        controller.livePitchSemitones.value = Math.max(-12, Math.min(12, Math.round(value)));
        controller.handleLivePitchSemitonesChange();
      }, { min: -12, max: 12, step: 1, disabled: controller.livePitchControlsDisabled.value, reason: controller.livePitchError.value }),
      makeNumberField('wav-pitch', 'WAV PITCH', controller.hqPitchSemitones.value, (value) => { controller.hqPitchSemitones.value = Math.max(-24, Math.min(24, Math.round(value))); controller.handleHqPitchChange(); }, { min: -24, max: 24, step: 1 }),
      makeNumberField('wav-rate', 'WAV PLAYBACK RATE', controller.hqPlaybackRate.value, (value) => { controller.hqPlaybackRate.value = value; controller.handleHqPlaybackRateChange(); }, { min: 0.5, max: 2, step: 0.01 }),
      makeEnumField('wav-format', 'WAV FORMAT', wavFormats.indexOf(controller.hqWavFormat.value), wavFormatOptions, (index) => { controller.hqWavFormat.value = wavFormats[index] ?? 'pcm16'; }),
      makeNumberField('wav-memory', 'WAV MEMORY MIB', controller.hqMemoryBudgetMiB.value, (value) => { controller.hqMemoryBudgetMiB.value = value; controller.handleHqMemoryBudgetChange(); }, { min: 64, max: 4096, step: 64 }),
      makeEnumField('wav-engine', 'NATIVE RENDERER', Math.max(0, rendererIndex), rendererOptions, (index) => { const selected = rendererOptions[index]; if (selected) { controller.hqNativeEngine.value = selected.label as typeof controller.hqNativeEngine.value; controller.handleHqNativeEngineChange(); } }, { disabled: controller.isNativeAudioMode.value && !controller.nativeHqRendererAvailable.value, reason: 'A Native HQ renderer is not available.' }),
      makeActionField('wav-export', controller.isHqExporting.value ? `EXPORTING ${controller.hqExportProgress.value}%` : 'EXPORT HQ WAV', async () => { await controller.exportHqWav(); }, { disabled: !controller.canExportHqWav.value || controller.isHqExporting.value, reason: controller.hqExportError.value || 'Record a loop and wait for the supported renderer before exporting.' }),
    ];
    return chunks(classic ? fields.filter((field) => field.key === 'track-level' || field.key === 'track-reverse') : fields);
  }

  function deviceOptions(devices: readonly AudioDeviceInfo[]): DeviceScreenOption[] {
    return devices.map((item, index) => ({ label: item.name || item.id, value: index }));
  }

  function menuFields(): DeviceScreenField[][] {
    const nativeMode = engine.getMode() === 'native';
    const audioReady = engine.getUiStatus().ready;
    return chunks([
      makeActionField('audio-settings', 'AUDIO SETTINGS', () => device.openPage('settings')),
      makeActionField('restart-native', 'RESTART / APPLY FX', () => {
        if (!nativeMode || !audioReady) return;
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('rc505-restart-native-audio'));
      }, {
        disabled: !nativeMode || !audioReady,
        reason: !nativeMode ? 'Restart / Apply FX is available only in Native mode.' : 'Start Native audio before applying saved FX.',
      }),
      makeActionField('switch-ui', 'TECH COMPATIBILITY', () => {
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('rc505-toggle-ui-style'));
      }),
      makeActionField('memory-save', 'MEMORY SAVE', () => device.openPage('memory'), {
        disabled: !memoryStorageReady.value,
        reason: !memoryStorageReady.value ? 'IndexedDB is unavailable in this browser context.' : '',
      }),
      makeActionField('memory-load', 'MEMORY LOAD', () => device.openPage('memory'), {
        disabled: !memoryStorageReady.value,
        reason: !memoryStorageReady.value ? 'IndexedDB is unavailable in this browser context.' : '',
      }),
    ]);
  }

  async function refreshMemoryMetadata(slot = memorySlot.value): Promise<void> {
    const revision = ++memoryMetadataRevision;
    if (!memoryStorageReady.value) return;
    try {
      const saved = await projectMemory.list();
      if (revision !== memoryMetadataRevision) return;
      memorySlots.value = saved;
      const metadata = saved.find((entry) => entry.slot === slot) ?? null;
      memoryName.value = metadata?.name ?? `MEMORY ${String(slot).padStart(2, '0')}`;
      memoryNotice.value = metadata
        ? `SAVED · ${metadata.name} · ${Math.round(metadata.archiveBytes / (1024 * 1024))} MIB · PCM/TEMPO`
        : 'EMPTY SLOT · V1 PCM + BPM + LOOP/SIGNATURE · NO FX/KIT/PATTERN SETTINGS';
    } catch (error) {
      if (revision === memoryMetadataRevision) {
        memoryStorageReady.value = false;
        memoryNotice.value = error instanceof Error ? error.message : String(error);
      }
    }
  }

  function validateMemoryName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || new TextEncoder().encode(trimmed).byteLength > PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes) {
      throw new RangeError(`Project name must contain 1–${PROJECT_ARCHIVE_LIMITS.maxProjectNameUtf8Bytes} UTF-8 bytes`);
    }
    return trimmed;
  }

  function promptMemoryName(): string | null {
    if (typeof window === 'undefined') return null;
    const value = window.prompt('Project name', memoryName.value);
    if (value === null) return null;
    return validateMemoryName(value);
  }

  async function saveMemorySlot(): Promise<void> {
    try {
      const existing = memorySlots.value.find((entry) => entry.slot === memorySlot.value);
      if (existing && !(await confirmAction(`Replace saved project memory slot ${memorySlot.value} (${existing.name})?`))) return;
      // The name is edited by the separate PROJECT NAME action. Asking again
      // here caused a second browser prompt on every save and silently
      // cancelled when clients only acknowledged the first prompt.
      const name = validateMemoryName(memoryName.value);
      const saved = await projectMemory.save(memorySlot.value, name);
      memoryName.value = saved.name;
      memoryMetadataRevision += 1;
      memorySlots.value = [...memorySlots.value.filter((entry) => entry.slot !== saved.slot), saved]
        .sort((left, right) => left.slot - right.slot);
      memoryNotice.value = `SAVED SLOT ${String(saved.slot).padStart(2, '0')} · ${saved.name} · PCM/TEMPO`;
    } catch (error) {
      memoryNotice.value = `SAVE FAILED · ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function loadMemorySlot(): Promise<void> {
    memoryNotice.value = `LOADING SLOT ${String(memorySlot.value).padStart(2, '0')} · WAITING FOR NATIVE AUDIO COMMIT`;
    try {
      const loaded = await projectMemory.load(memorySlot.value);
      pendingNativeImportGeneration.value = null;
      memoryName.value = loaded.name;
      memoryNotice.value = `LOADED ${loaded.name} · ${loaded.tracksWithAudio}/5 LOOPS · FX/KIT/PATTERNS UNCHANGED`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const archiveCommitted = typeof error === 'object' && error !== null && 'archiveCommitted' in error && error.archiveCommitted === true;
      const generation = typeof error === 'object' && error !== null && 'generation' in error &&
        Number.isSafeInteger(error.generation) && Number(error.generation) > 0 ? Number(error.generation) : null;
      if (generation !== null) pendingNativeImportGeneration.value = generation;
      memoryNotice.value = archiveCommitted
        ? `PCM IMPORT COMMITTED · UI SYNC FAILED · ${message}`
        : error instanceof NativeProjectImportIndeterminateError
          ? `IMPORT STATUS UNKNOWN · GEN ${generation ?? error.generation} · CHECK STATUS BEFORE RETRY`
          : error instanceof NativeProjectImportOutcomeUnknownError
            ? `IMPORT OUTCOME UNKNOWN · NO GENERATION ACK · DO NOT RETRY YET`
            : `LOAD FAILED · ${message}`;
    }
  }

  async function checkNativeProjectImportStatus(): Promise<void> {
    const generation = pendingNativeImportGeneration.value;
    if (generation === null) return;
    memoryNotice.value = `CHECKING NATIVE IMPORT GENERATION ${generation}`;
    try {
      const status = await engine.getNativeProjectArchiveImportStatus(generation);
      if (status.state === 'committed') {
        pendingNativeImportGeneration.value = null;
        await refreshMemoryMetadata(memorySlot.value);
        memoryNotice.value = `NATIVE IMPORT COMMITTED · GEN ${generation} · CHECK AUDIO AND TRANSPORT STATUS`;
      } else if (status.state === 'cancelled') {
        pendingNativeImportGeneration.value = null;
        memoryNotice.value = `IMPORT CANCELLED · GEN ${generation} · EXISTING AUDIO PRESERVED`;
      } else {
        memoryNotice.value = `IMPORT ${status.state.toUpperCase()} · GEN ${generation} · CHECK AGAIN, DO NOT REUPLOAD`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const archiveCommitted = typeof error === 'object' && error !== null && 'archiveCommitted' in error && error.archiveCommitted === true;
      memoryNotice.value = archiveCommitted
        ? `PCM IMPORT COMMITTED · UI SYNC FAILED · GEN ${generation} · ${message}`
        : `IMPORT STATUS UNKNOWN · GEN ${generation} · CHECK AGAIN BEFORE RETRY`;
    }
  }

  async function exportMemoryFile(): Promise<void> {
    const name = promptMemoryName();
    if (!name) return;
    const archive = await projectMemory.exportFile(name);
    const archiveBuffer = archive.buffer instanceof ArrayBuffer && archive.byteOffset === 0 && archive.byteLength === archive.buffer.byteLength
      ? archive.buffer
      : archive.slice().buffer as ArrayBuffer;
    const blob = new Blob([archiveBuffer], { type: 'application/x-rc505-project' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = name.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'RC505-project';
    link.href = url;
    link.download = `${safeName}.rc505proj`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    memoryNotice.value = `EXPORTED ${name} · PCM/TEMPO`;
  }

  async function importMemoryFile(): Promise<void> {
    memoryNotice.value = 'IMPORTING PROJECT FILE · VALIDATING PCM AND PREPARING AUDIO';
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = '.rc505proj,application/x-rc505-project,application/octet-stream';
    picker.hidden = true;
    document.body.append(picker);
    try {
      const file = await new Promise<File | null>((resolve) => {
        picker.addEventListener('change', () => resolve(picker.files?.[0] ?? null), { once: true });
        picker.addEventListener('cancel', () => resolve(null), { once: true });
        picker.click();
      });
      if (!file) {
        memoryNotice.value = 'IMPORT CANCELLED · NO CHANGES MADE';
        return;
      }
      try {
        const loaded = await projectMemory.importFile(file);
        pendingNativeImportGeneration.value = null;
        memoryName.value = loaded.name;
        memoryNotice.value = `IMPORTED ${loaded.name} · ${loaded.tracksWithAudio}/5 LOOPS · FX/KIT/PATTERNS UNCHANGED`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const archiveCommitted = typeof error === 'object' && error !== null && 'archiveCommitted' in error && error.archiveCommitted === true;
        const generation = typeof error === 'object' && error !== null && 'generation' in error &&
          Number.isSafeInteger(error.generation) && Number(error.generation) > 0 ? Number(error.generation) : null;
        if (generation !== null) pendingNativeImportGeneration.value = generation;
        memoryNotice.value = archiveCommitted
          ? `PCM IMPORT COMMITTED · UI SYNC FAILED · ${message}`
          : error instanceof NativeProjectImportIndeterminateError
            ? `IMPORT STATUS UNKNOWN · GEN ${generation ?? error.generation} · CHECK STATUS BEFORE RETRY`
            : error instanceof NativeProjectImportOutcomeUnknownError
              ? `IMPORT OUTCOME UNKNOWN · NO GENERATION ACK · DO NOT RETRY YET`
              : `IMPORT FAILED · ${message}`;
      }
    } finally {
      picker.remove();
    }
  }

  function memoryFields(): DeviceScreenField[][] {
    const storageAvailable = memoryStorageReady.value;
    const reason = !storageAvailable ? 'IndexedDB is unavailable in this browser context.' : '';
    const saved = memorySlots.value.find((entry) => entry.slot === memorySlot.value);
    const disabled = editPending.value || pendingNativeImportGeneration.value !== null;
    const audioReady = engine.getUiStatus().ready;
    const browserLoopsCanBeExportedWithoutAudio = engine.getMode() === 'browser' && engine.hasUnsavedLoops();
    const exportAllowed = audioReady || browserLoopsCanBeExportedWithoutAudio;
    const audioUnavailableReason = engine.getMode() === 'browser'
      ? 'Browser audio is unavailable. Export current loops before reloading; project import is available after audio starts.'
      : 'Audio engine is not running and ready.';
    const exportUnavailableReason = exportAllowed ? '' : engine.getMode() === 'browser'
      ? 'Audio is unavailable and no Browser loops are available to export.'
      : 'Audio engine is not running and ready.';
    return chunks([
      makeNumberField('memory-slot', 'MEMORY SLOT', memorySlot.value, (value) => {
        memorySlot.value = Math.max(1, Math.min(99, Math.round(value)));
        void refreshMemoryMetadata(memorySlot.value);
      }, { min: 1, max: 99, step: 1, disabled: !storageAvailable || disabled, reason }),
      makeActionField('memory-name', 'PROJECT NAME', () => {
        const name = promptMemoryName();
        if (name) memoryName.value = name;
      }, { disabled: !storageAvailable || disabled, reason: saved ? `Saved name: ${saved.name}` : reason, format: () => memoryName.value }),
      makeActionField('memory-save-slot', 'SAVE TO SLOT', saveMemorySlot, { disabled: !storageAvailable || disabled, reason }),
      makeActionField('memory-check-import-status', 'CHECK IMPORT STATUS', checkNativeProjectImportStatus, {
        disabled: editPending.value || pendingNativeImportGeneration.value === null,
        reason: pendingNativeImportGeneration.value === null ? 'No acknowledged Native import generation is pending status recovery.' : 'Checks the accepted generation without uploading or changing PCM again.',
      }),
      makeActionField('memory-load-slot', 'LOAD SLOT', loadMemorySlot, { disabled: !storageAvailable || disabled || !saved || !audioReady, reason: !storageAvailable ? reason : !saved ? 'Selected memory slot is empty.' : !audioReady ? audioUnavailableReason : 'Loads PCM, BPM, master loop, and time signature; FX, kits, and patterns remain unchanged.' }),
      makeActionField('memory-import-file', 'IMPORT PROJECT FILE', importMemoryFile, { disabled: disabled || !audioReady, reason: !audioReady ? audioUnavailableReason : '' }),
      makeActionField('memory-export-file', 'EXPORT PROJECT FILE', exportMemoryFile, { disabled: disabled || !exportAllowed, reason: exportUnavailableReason }),
      makeActionField('memory-delete-slot', 'ERASE SLOT', async () => {
        if (!(await confirmAction(`Erase saved project memory slot ${memorySlot.value}? This permanently removes its PCM archive from this browser.`))) return;
        await projectMemory.delete(memorySlot.value);
        await refreshMemoryMetadata(memorySlot.value);
      }, { disabled: !storageAvailable || disabled || !saved, reason: saved ? 'Erases only the selected saved slot.' : 'Selected memory slot is empty.' }),
    ]);
  }

  async function refreshDevices(): Promise<void> {
    settings.loading = true;
    settings.error = '';
    try {
      settings.selection = await engine.getDevices();
      settings.loaded = true;
    } catch (error) {
      settings.error = error instanceof Error ? error.message : String(error);
    } finally {
      settings.loading = false;
    }
  }

  async function applyDeviceSetting(action: () => Promise<unknown>): Promise<void> {
    settings.error = '';
    try {
      await action();
      await refreshDevices();
    } catch (error) {
      settings.error = error instanceof Error ? error.message : String(error);
    }
  }

  async function setMonitoring(enabled: boolean): Promise<void> {
    if (enabled && !(await confirmAction(MONITORING_WARNING))) return;
    await applyDeviceSetting(() => engine.setMonitoring(enabled));
  }

  function settingsFields(): DeviceScreenField[][] {
    const selection = settings.selection;
    const backends = selection?.backends ?? [];
    const inputs = selection?.inputs ?? [];
    const outputs = selection?.outputs ?? [];
    const sampleRates = selection?.sampleRates ?? [];
    const bufferOptions = selection?.bufferOptions ?? [];
    const currentInputId = engine.selectedInputDeviceId;
    const currentOutputId = engine.selectedOutputDeviceId;
    const selectedInputIndex = Math.max(0, inputs.findIndex((item) => item.id === currentInputId));
    const selectedOutputIndex = Math.max(0, outputs.findIndex((item) => item.id === currentOutputId));
    const fields: DeviceScreenField[] = [
      makeEnumField('backend', 'BACKEND', Math.max(0, backends.indexOf(engine.selectedBackend)), fieldOptions(backends), (index) => { const backend = backends[index]; if (backend) void applyDeviceSetting(() => engine.setBackend(backend)); }, { disabled: engine.getMode() !== 'native' || backends.length === 0 || settings.loading, reason: engine.getMode() !== 'native' ? 'Backend selection is available in Native mode.' : settings.error }),
      makeEnumField('input-device', 'INPUT DEVICE', selectedInputIndex, deviceOptions(inputs), (index) => { const item = inputs[index]; if (item) void applyDeviceSetting(() => engine.setInputDevice(item.id)); }, { disabled: inputs.length === 0 || settings.loading, reason: settings.error || 'No input devices are available.' }),
      makeEnumField('output-device', 'OUTPUT DEVICE', selectedOutputIndex, deviceOptions(outputs), (index) => { const item = outputs[index]; if (item) void applyDeviceSetting(() => engine.setOutputDevice(item.id)); }, { disabled: outputs.length === 0 || settings.loading, reason: settings.error || 'No output devices are available.' }),
      makeEnumField('sample-rate', 'SAMPLE RATE', Math.max(0, sampleRates.indexOf(engine.selectedSampleRate)), fieldOptions(sampleRates.map((rate) => `${rate} HZ`)), (index) => { const rate = sampleRates[index]; if (rate) void applyDeviceSetting(() => engine.setSampleRate(rate)); }, { disabled: engine.getMode() !== 'native' || sampleRates.length === 0 || settings.loading, reason: engine.getMode() !== 'native' ? `Browser sample rate is fixed at ${engine.selectedSampleRate} Hz.` : settings.error }),
      makeEnumField('buffer-size', 'BUFFER FRAMES', Math.max(0, bufferOptions.indexOf(engine.selectedBufferFrames)), fieldOptions(bufferOptions.map(String)), (index) => { const frames = bufferOptions[index]; if (frames) void applyDeviceSetting(() => engine.setBufferFrames(frames)); }, { disabled: engine.getMode() !== 'native' || bufferOptions.length === 0 || settings.loading, reason: engine.getMode() !== 'native' ? 'The Browser render quantum is runtime-defined.' : 'The bridge did not report selectable buffer sizes.' }),
      makeEnumField('loop-memory', 'LOOP MEMORY', loopStorageOptions.findIndex((item) => item.value === engine.nativeLooperStorageBudgetBytes), loopStorageOptions, (index) => { const item = loopStorageOptions[index]; if (item) void applyDeviceSetting(() => engine.setNativeLooperStorageBudget(item.value)); }, { disabled: engine.getMode() !== 'native' || !engine.isBridgeAvailable() || settings.loading, reason: 'Native loop memory is only configurable through the connected Native bridge.' }),
      makeBooleanField('monitoring', 'INPUT THRU', engine.monitoringEnabled, (enabled) => setMonitoring(enabled), { disabled: !engine.getUiStatus().ready || settings.loading, reason: engine.getUiStatus().message || 'Audio is not ready.' }),
      makeNumberField('output-level', 'MASTER OUT', engine.getOutputLevel(), (value) => engine.setOutputLevel(value), { min: 0, max: 100, step: 1, disabled: !engine.getCapabilities().supportsOutputLevel, reason: engine.getCapabilities().outputLevelReason || 'Master output control is unavailable on this runtime.' }),
      makeActionField('test-tone', 'PLAY TEST TONE', () => { engine.playTestTone(); }, { disabled: !engine.getUiStatus().ready, reason: engine.getUiStatus().message }),
      makeActionField('loopback-test', settings.loopbackRunning ? 'MEASURING LOOPBACK…' : 'RUN LOOPBACK TEST', async () => {
        settings.loopbackRunning = true;
        settings.error = '';
        try { engine.setLatency(await engine.runLoopbackTest()); }
        catch (error) { settings.error = error instanceof Error ? error.message : String(error); }
        finally { settings.loopbackRunning = false; }
      }, { disabled: !engine.getUiStatus().ready || settings.loopbackRunning, reason: engine.getUiStatus().message }),
      makeActionField('refresh-devices', 'REFRESH AUDIO DEVICES', () => refreshDevices(), { disabled: settings.loading, reason: settings.error }),
    ];
    return chunks(fields);
  }

  const pages = computed(() => {
    statusRevision.value;
    switch (device.state.page) {
      case 'input-fx': return inputFxFields();
      case 'track-fx': return classic ? trackFxFields().map((page) => page.filter((field) => field.key !== 'target')).filter((page) => page.length) : trackFxFields();
      case 'rhythm': return rhythmFields();
      case 'track': return trackFields();
      case 'menu': return classic ? [[makeActionField('partial-menu', 'UNAVAILABLE', () => {}, { disabled: true, reason: 'Use the hardware MENU hierarchy.' })]] : menuFields();
      case 'memory': return classic ? [[makeActionField('partial-memory', 'MEMORY PARTIAL', () => {}, { disabled: true, reason: 'Hardware Memory mapping is unavailable. Project archives are in Enhanced.' })]] : memoryFields();
      case 'settings': return classic ? [[makeActionField('partial-settings', 'UNAVAILABLE', () => {}, { disabled: true, reason: 'Audio device tools are available in Enhanced.' })]] : settingsFields();
      default: return [[]];
    }
  });
  const fxChangeBlocked = () => (device.state.page === 'input-fx' && controls.state.fxBusy.input) || (device.state.page === 'track-fx' && controls.state.fxBusy.track);
  const fields = computed<readonly DeviceScreenField[]>(() => (pages.value[Math.min(pageIndex.value, pages.value.length - 1)] ?? []).map((field) => ({
    ...field,
    ...(fxChangeBlocked()
      ? { disabled: true, reason: 'Wait for the current FX bank application.' } : {}),
    ...(field.setValue ? { setValue: (value: number) => { if (!field.disabled && !fxChangeBlocked()) void runEdit(() => field.setValue?.(value)); } } : {}),
    ...(field.activate ? { activate: () => { if (!field.disabled && !fxChangeBlocked()) void runEdit(() => field.activate?.()); } } : {}),
  })));
  const pageTitle = computed(() => {
    const titles: Record<DevicePanelPage, string> = {
      home: 'HOME', mixer: 'MIXER', menu: 'MENU', memory: 'MEMORY · PCM/TEMPO', 'input-fx': `INPUT FX · ${currentInputSlot.value?.type || 'EMPTY'}`,
      'track-fx': `TRACK FX · ${trackFx.target.value === 'shared' ? 'SHARED' : `TRACK ${trackFx.target.value}`}`,
      rhythm: 'RHYTHM', settings: 'AUDIO SETTINGS', track: `TRACK ${currentTrackId.value}`,
    };
    return titles[device.state.page];
  });
  const status = computed(() => {
    statusRevision.value;
    if (statusText.value) return statusText.value;
    if (settings.error) return settings.error;
    const runtime = device.state.page === 'input-fx'
      ? input.runtimeStatus.value as (typeof input.runtimeStatus.value & { pendingRestart?: boolean; pendingApply?: boolean; acknowledged?: boolean })
      : device.state.page === 'track-fx' ? trackFx.runtimeStatus.value : null;
    if (runtime?.outcomeUnknown) return 'FX OUTCOME UNKNOWN · CHECK NATIVE STATUS';
    // Native deliberately rejects a live effect-type replacement and marks
    // the saved choice pending restart. That actionable state is more useful
    // than the accompanying rejection text until the user restarts Native.
    if (runtime?.pendingRestart) return classic ? 'APPLY IN ENHANCED' : 'SAVED · RESTART / APPLY FX';
    if (runtime?.error) return runtime.error;
    if (device.state.page === 'input-fx' && input.nativeNamedParametersPending.value) return 'NAMED PARAMETERS PENDING · WAIT FOR NATIVE ACK';
    if (device.state.page === 'track-fx' && trackFx.nativeNamedParametersPending.value) return 'NAMED PARAMETERS PENDING · WAIT FOR NATIVE ACK';
    if (runtime?.pendingApply) return 'WAIT FOR ACK';
    if (editPending.value) return 'WAIT FOR ACK';
    if (runtime?.acknowledged === true) return 'FX APPLIED · RUNTIME ACKNOWLEDGED';
    if (device.state.page === 'track-fx' && trackFx.warning.value) return trackFx.warning.value;
    if (device.state.page === 'input-fx') return input.fxUnavailableReason.value || '';
    if (device.state.page === 'track-fx') return trackFx.fxUnavailableReason.value || '';
    if (device.state.page === 'rhythm') return rhythm.message.value;
    if (device.state.page === 'track' && classic) return '';
    if (device.state.page === 'track') return currentTrackController.value?.hqExportError.value || currentTrackController.value?.livePitchError.value || currentTrackController.value?.livePitchStatus.value || '';
    if (device.state.page === 'memory') return memoryNotice.value;
    if (device.actionStatus.error || device.actionStatus.pending) return '';
    const selected = fields.value[selectedFieldIndex.value];
    if (selected?.disabled && selected.reason) return selected.reason;
    return engine.getUiStatus().lastError || engine.getUiStatus().message || '';
  });

  watch(
    () => [device.state.page, device.state.editorPageCount, pages.value.length] as const,
    ([, , count]) => device.setEditorPageCount(count),
    { immediate: true, flush: 'sync' },
  );
  watch(() => device.state.page, (page) => {
    selectedFieldIndex.value = 0;
    if (page === 'settings' && !settings.loaded && !settings.loading) void refreshDevices();
    if (page === 'memory') void refreshMemoryMetadata();
  }, { immediate: true });
  watch(fields, (nextFields) => {
    if (selectedFieldIndex.value >= nextFields.length) selectedFieldIndex.value = Math.max(0, nextFields.length - 1);
  });

  function enter(page?: DevicePanelPage): void {
    if (page) {
      device.openPage(page);
      return;
    }
    const selected = fields.value[selectedFieldIndex.value];
    if (!selected || selected.disabled) return;
    if (selected.kind === 'action') void selected.activate?.();
    else if (typeof document !== 'undefined') document.getElementById(`lcd-field-${selected.key}`)?.focus({ preventScroll: true });
  }

  function exit(): void {
    device.backPage();
  }

  function stepPage(direction: -1 | 1): void {
    device.changePage(direction);
  }

  function selectField(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= fields.value.length) return;
    selectedFieldIndex.value = index;
  }

  return {
    active,
    fields,
    pageTitle,
    pageIndex,
    pageCount,
    selectedFieldIndex: computed(() => selectedFieldIndex.value),
    status,
    enter,
    exit,
    stepPage,
    selectField,
  };
}
