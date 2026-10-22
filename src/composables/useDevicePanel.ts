import { computed, reactive, readonly, shallowRef } from 'vue';
import { usePanelFocus } from './usePanelFocus';
import { createRc505DisplayState, reduceRc505DisplayState } from '../ui/rc505/Rc505DisplayStateMachine';
import type { Rc505DisplayAction } from '../ui/rc505/rc505DisplayTypes';

export type DevicePanelPage = 'home' | 'mixer' | 'menu' | 'memory' | 'input-fx' | 'track-fx' | 'rhythm' | 'settings' | 'track';

interface DevicePanelState {
  page: DevicePanelPage;
  returnPage: 'home' | 'mixer';
  editorParentPage: DevicePanelPage | null;
  editorPageIndex: number;
  editorPageCount: number;
}
interface PageActionStatus {
  trackId: number | null;
  pending: string;
  error: string;
}

const devicePanelState = reactive<DevicePanelState>({
  page: 'home',
  returnPage: 'home',
  editorParentPage: null,
  editorPageIndex: 0,
  editorPageCount: 1,
});
const pageActionStatus = reactive<PageActionStatus>({ trackId: null, pending: '', error: '' });
const classicDisplayState = shallowRef(createRc505DisplayState());

const drawerPages = new Set<DevicePanelPage>(['menu', 'memory', 'input-fx', 'track-fx', 'rhythm', 'settings', 'track']);

function clearPageActionStatus(): void {
  pageActionStatus.trackId = null;
  pageActionStatus.pending = '';
  pageActionStatus.error = '';
}

function openPage(page: DevicePanelPage): void {
  if (drawerPages.has(page) && !drawerPages.has(devicePanelState.page)) {
    devicePanelState.returnPage = devicePanelState.page === 'mixer' ? 'mixer' : 'home';
  }
  if (page === 'settings' && devicePanelState.page === 'menu') devicePanelState.editorParentPage = 'menu';
  else if (page !== devicePanelState.page) devicePanelState.editorParentPage = null;
  if (devicePanelState.page !== page) {
    clearPageActionStatus();
    devicePanelState.editorPageIndex = 0;
    devicePanelState.editorPageCount = 1;
  }
  devicePanelState.page = page;
}

function backPage(): void {
  if (drawerPages.has(devicePanelState.page)) {
    clearPageActionStatus();
    const parentPage = devicePanelState.editorParentPage;
    devicePanelState.editorParentPage = null;
    devicePanelState.page = parentPage ?? devicePanelState.returnPage;
    devicePanelState.editorPageIndex = 0;
    devicePanelState.editorPageCount = 1;
  } else if (devicePanelState.page === 'mixer') {
    devicePanelState.page = 'home';
  }
}

function goHome(): void {
  clearPageActionStatus();
  devicePanelState.page = 'home';
  devicePanelState.returnPage = 'home';
  devicePanelState.editorParentPage = null;
  devicePanelState.editorPageIndex = 0;
  devicePanelState.editorPageCount = 1;
}

function changePage(direction: -1 | 1): void {
  if (drawerPages.has(devicePanelState.page)) {
    const count = Math.max(1, devicePanelState.editorPageCount);
    devicePanelState.editorPageIndex = (devicePanelState.editorPageIndex + direction + count) % count;
    clearPageActionStatus();
    return;
  }
  const pages: Array<'home' | 'mixer'> = ['home', 'mixer'];
  const currentIndex = pages.indexOf(devicePanelState.page as 'home' | 'mixer');
  devicePanelState.page = pages[(currentIndex + direction + pages.length) % pages.length]!;
}

function openSelectedTrack(): void {
  if (!drawerPages.has(devicePanelState.page)) {
    devicePanelState.returnPage = devicePanelState.page === 'mixer' ? 'mixer' : 'home';
  }
  clearPageActionStatus();
  devicePanelState.page = 'track';
  devicePanelState.editorParentPage = null;
  devicePanelState.editorPageIndex = 0;
  devicePanelState.editorPageCount = 1;
}

function clearPageStatus(page: DevicePanelPage, trackId?: number): void {
  if (devicePanelState.page !== page) return;
  if (page === 'track' && trackId !== undefined && pageActionStatus.trackId !== trackId) return;
  clearPageActionStatus();
}

export function useDevicePanel() {
  const { state: focusState } = usePanelFocus();
  const currentTrackId = computed(() => focusState.currentTrackId);
  function setPageActionStatus(page: DevicePanelPage, status: { pending?: string; error?: string; trackId?: number }): void {
    if (devicePanelState.page !== page) return;
    if (page === 'track' && status.trackId !== currentTrackId.value) return;
    pageActionStatus.trackId = page === 'track' ? status.trackId ?? null : null;
    pageActionStatus.pending = status.pending ?? '';
    pageActionStatus.error = status.error ?? '';
  }

  function setEditorPageCount(count: number): void {
    const safeCount = Number.isInteger(count) ? Math.max(1, count) : 1;
    devicePanelState.editorPageCount = safeCount;
    if (devicePanelState.editorPageIndex >= safeCount) devicePanelState.editorPageIndex = safeCount - 1;
    classicDisplayState.value = reduceRc505DisplayState(classicDisplayState.value, { type: 'EDITOR_PAGE_COUNT', count: safeCount });
  }

  function classicDispatch(action: Rc505DisplayAction) {
    classicDisplayState.value = reduceRc505DisplayState(classicDisplayState.value, action);
    return classicDisplayState.value;
  }

  function setEditorPageIndex(index: number): void {
    if (!Number.isInteger(index)) return;
    devicePanelState.editorPageIndex = Math.max(0, Math.min(devicePanelState.editorPageCount - 1, index));
  }

  return {
    state: readonly(devicePanelState),
    classicState: readonly(classicDisplayState),
    actionStatus: readonly(pageActionStatus),
    currentTrackId,
    openPage,
    backPage,
    goHome,
    changePage,
    openSelectedTrack,
    setPageActionStatus,
    clearPageStatus,
    setEditorPageCount,
    setEditorPageIndex,
    classicDispatch,
  };
}
