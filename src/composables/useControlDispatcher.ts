import { computed, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import { Transport } from '../core/Transport';
import { usePanelFocus } from './usePanelFocus';
import { useMemorySlot } from './useMemorySlot';
import { ControlCommandDispatcher, type AudioControlCommand, type ControlDispatcherState } from '../controls/commandDispatcher';
import type { ProjectService } from '../project/ProjectService';

interface ControlTrack {
  track?: { playLevel: number; pan: number };
  triggerRecord?: () => void | Promise<void>;
  triggerStop?: () => void | Promise<void>;
  clear?: () => void | Promise<void>;
  updateSettings?: () => void | Promise<void>;
  undo?: () => Promise<boolean> | boolean;
  redo?: () => Promise<boolean> | boolean;
  mark?: () => Promise<boolean> | boolean;
  restoreMark?: () => Promise<boolean> | boolean;
  clearMark?: () => Promise<boolean> | boolean;
  recBack?: () => Promise<boolean> | boolean;
  getLastActionError?: () => string | null;
}

type ProjectControls = Pick<ProjectService, 'loadMemory' | 'bounceTrack' | 'setControlStateAdapter'>;

const engine = AudioEngine.getInstance();
const transport = Transport.getInstance();
const focus = usePanelFocus();
const { setActiveMemorySlot } = useMemorySlot();
const error = ref('');

function getTrack(trackId: number): ControlTrack {
  const track = engine.tracks[trackId - 1] as ControlTrack | undefined;
  if (!track) throw new Error(`Track ${trackId} is unavailable.`);
  return track;
}

function getProjectControls(): ProjectControls {
  const getter = (engine as unknown as { getProjectService?: () => ProjectControls | null }).getProjectService;
  const projects = getter?.call(engine);
  if (!projects) throw new Error('Project controls require browser audio to be ready.');
  return projects;
}

function assertTrackCommandSucceeded(track: ControlTrack, result: unknown, label: string): void {
  const message = track.getLastActionError?.();
  if (message) throw new Error(message);
  if (result === false) throw new Error(`${label} could not be completed for this track.`);
}

async function runAudioCommand(command: AudioControlCommand): Promise<void> {
  switch (command.type) {
    case 'record-track':
      {
        const track = getTrack(command.trackId);
        if (!track.triggerRecord) throw new Error(`Track ${command.trackId} does not support recording.`);
        const result = await track.triggerRecord();
        assertTrackCommandSucceeded(track, result, 'Recording');
      }
      return;
    case 'stop-track':
      {
        const track = getTrack(command.trackId);
        if (!track.triggerStop) throw new Error(`Track ${command.trackId} does not support stopping.`);
        const result = await track.triggerStop();
        assertTrackCommandSucceeded(track, result, 'Stopping');
      }
      return;
    case 'clear-track':
      {
        const track = getTrack(command.trackId);
        if (!track.clear) throw new Error(`Track ${command.trackId} does not support clearing.`);
        const result = await track.clear();
        assertTrackCommandSucceeded(track, result, 'Clearing');
      }
      return;
    case 'play-all':
      await engine.playAllTracks();
      return;
    case 'stop-all':
      await engine.stopAllTracks();
      return;
    case 'toggle-transport':
      {
        const activeStates = new Set(['RECORDING', 'PLAYING', 'OVERDUBBING', 'REPLACING', 'REC_STANDBY', 'REC_FINISHING']);
        if (engine.tracks.some((track) => activeStates.has(track.state))) await engine.stopAllTracks();
        else await engine.playAllTracks();
        return;
      }
    case 'undo':
    case 'redo':
    case 'mark':
    case 'mark-back':
    case 'mark-clear':
    case 'rec-back':
      {
        const track = getTrack(command.trackId ?? focus.state.currentTrackId);
        const operation = command.type === 'undo' ? track.undo
          : command.type === 'redo' ? track.redo
            : command.type === 'mark' ? track.mark
              : command.type === 'mark-back' ? track.restoreMark
                : command.type === 'mark-clear' ? track.clearMark
                  : track.recBack;
        if (!operation) throw new Error(`${command.type.toUpperCase()} is unavailable for this track.`);
        const result = await operation.call(track);
        assertTrackCommandSucceeded(track, result, command.type.toUpperCase());
        return;
      }
    case 'bounce':
      {
        const sourceTrackId = command.trackId ?? focus.state.currentTrackId;
        const targetTrackId = sourceTrackId === 5 ? 4 : sourceTrackId + 1;
        const projects = getProjectControls();
        await projects.bounceTrack(targetTrackId, { selectedTrackIds: [sourceTrackId] });
        return;
      }
    case 'load-memory':
      await getProjectControls().loadMemory(command.memoryId);
      setActiveMemorySlot(command.memoryId);
      return;
    case 'set-track-level':
      {
        const track = getTrack(command.trackId);
        if (!track.track || !track.updateSettings) throw new Error('Track level is unavailable.');
        track.track.playLevel = Math.max(0, Math.min(200, Math.round(command.value)));
        await track.updateSettings();
        return;
      }
    case 'set-track-pan':
      {
        const track = getTrack(command.trackId);
        if (!track.track || !track.updateSettings) throw new Error('Track pan is unavailable.');
        track.track.pan = Math.max(-50, Math.min(50, Math.round(command.value)));
        await track.updateSettings();
        return;
      }
    case 'set-track-fx-send':
      await engine.setTrackFxSend(command.trackId, command.enabled);
      focus.setTrackFxApplied(command.trackId, command.enabled);
      return;
    case 'set-tempo':
      transport.setBpm(Math.max(40, Math.min(300, Math.round(command.value))));
      return;
  }
}

export const controlCommandDispatcher = new ControlCommandDispatcher({
  run: runAudioCommand,
  forwardFxMidiInput: (event) => engine.postFxMidiInput(event),
  syncExternalClock: async (bpm, beatOrdinal) => {
    const sync = (engine as unknown as { syncExternalClock?: (tempo: number, ordinal: number) => Promise<unknown> }).syncExternalClock;
    if (!sync) throw new Error('External MIDI Clock sync is not available in the active audio engine.');
    await sync.call(engine, bpm, beatOrdinal);
  },
  onError: (caught) => {
    error.value = caught instanceof Error ? caught.message : String(caught);
  },
});

export function useControlDispatcher() {
  const clearError = () => { error.value = ''; };
  const bindProjectStateAdapter = () => {
    const getter = (engine as unknown as { getProjectService?: () => ProjectControls | null }).getProjectService;
    try {
      getter?.call(engine)?.setControlStateAdapter?.({
        read: () => controlCommandDispatcher.getState(),
        apply: (state: ControlDispatcherState) => controlCommandDispatcher.setState(state),
      });
    } catch {
      // The audio engine may still be initializing. The host retries on status changes.
    }
  };
  return {
    dispatcher: controlCommandDispatcher,
    error: computed(() => error.value),
    clearError,
    bindProjectStateAdapter,
  };
}
