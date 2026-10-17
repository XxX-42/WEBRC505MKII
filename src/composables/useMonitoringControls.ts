import { computed, ref, type ComputedRef, type Ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';

export interface MonitoringControls {
  active: Ref<boolean>;
  ready: Ref<boolean>;
  pending: Ref<boolean>;
  error: Ref<string>;
  unavailableReason: ComputedRef<string>;
  disabled: ComputedRef<boolean>;
  toggle: () => Promise<boolean>;
}

const controlsByEngine = new WeakMap<AudioEngine, MonitoringControls>();

const MONITORING_WARNING = [
  'WARNING: FEEDBACK RISK!',
  '',
  'Enabling THRU routes your microphone directly to the speakers.',
  '',
  'Use headphones only. Speakers can cause loud feedback.',
  '',
  'Enable THRU?',
].join('\n');

/** One acknowledged THRU state and one serialized toggle path shared by every view. */
export function useMonitoringControls(engine = AudioEngine.getInstance()): MonitoringControls {
  const existing = controlsByEngine.get(engine);
  if (existing) return existing;

  const status = engine.getUiStatus();
  const active = ref(engine.monitoringEnabled);
  const ready = ref(status.ready);
  const pending = ref(false);
  const error = ref('');
  const statusMessage = ref(status.message || '');

  engine.onMonitoringChange((enabled) => {
    active.value = enabled;
  });
  engine.onStatusChange((nextStatus) => {
    ready.value = nextStatus.ready;
    statusMessage.value = nextStatus.message || '';
    active.value = engine.monitoringEnabled;
  });

  const controls: MonitoringControls = {
    active,
    ready,
    pending,
    error,
    unavailableReason: computed(() => statusMessage.value || 'Audio engine is not ready'),
    disabled: computed(() => !ready.value || pending.value),
    async toggle() {
      if (!ready.value || pending.value) return false;
      const requested = !active.value;
      if (requested && !window.confirm(MONITORING_WARNING)) return false;

      pending.value = true;
      error.value = '';
      try {
        await engine.setMonitoring(requested);
        const acknowledged = engine.monitoringEnabled;
        active.value = acknowledged;
        if (acknowledged !== requested) {
          throw new Error('The audio engine did not acknowledge the requested THRU state.');
        }
        return true;
      } catch (reason) {
        active.value = engine.monitoringEnabled;
        error.value = reason instanceof Error ? reason.message : 'THRU could not be changed.';
        return false;
      } finally {
        pending.value = false;
      }
    },
  };

  controlsByEngine.set(engine, controls);
  return controls;
}
