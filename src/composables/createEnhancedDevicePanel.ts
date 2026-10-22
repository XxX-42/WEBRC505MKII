import { reactive, readonly } from 'vue';
import type { DevicePanelPage, useDevicePanel } from './useDevicePanel';

export type DeviceEditorPanel = Pick<ReturnType<typeof useDevicePanel>, 'state' | 'actionStatus' | 'openPage' | 'backPage' | 'changePage' | 'setEditorPageCount'>;

/** Software tools have a local route; opening them never changes the hardware LCD. */
export function createEnhancedDevicePanel(): DeviceEditorPanel {
  const state = reactive({ page: 'menu' as DevicePanelPage, returnPage: 'home' as 'home' | 'mixer', editorParentPage: null as DevicePanelPage | null, editorPageIndex: 0, editorPageCount: 1 });
  const actionStatus = readonly({ trackId: null, pending: '', error: '' });
  return {
    state: readonly(state), actionStatus,
    openPage(page) { state.page = page; state.editorPageIndex = 0; state.editorPageCount = 1; },
    backPage() { state.page = 'menu'; state.editorPageIndex = 0; },
    changePage(direction) { state.editorPageIndex = (state.editorPageIndex + direction + state.editorPageCount) % state.editorPageCount; },
    setEditorPageCount(count) { state.editorPageCount = Math.max(1, count); state.editorPageIndex = Math.min(state.editorPageIndex, state.editorPageCount - 1); },
  };
}
