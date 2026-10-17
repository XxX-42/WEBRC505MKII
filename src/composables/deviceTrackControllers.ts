import { shallowReactive } from 'vue';
import type { useTrackStripState } from './useTrackStripState';

export type DeviceTrackController = ReturnType<typeof useTrackStripState>;
const controllers = shallowReactive(new Map<number, DeviceTrackController>());

export function registerDeviceTrackController(trackId: number, controller: DeviceTrackController): () => void {
  controllers.set(trackId, controller);
  return () => { if (controllers.get(trackId) === controller) controllers.delete(trackId); };
}

export function getDeviceTrackController(trackId: number): DeviceTrackController | undefined {
  return controllers.get(trackId);
}
