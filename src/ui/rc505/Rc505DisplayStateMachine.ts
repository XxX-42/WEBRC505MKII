import {
  RC505_LOOP_ROOT_ITEMS,
  RC505_MENU_ROOT_ITEMS,
  RC505_MIXER_PAGES,
  RC505_PLAY_SCREENS,
  type Rc505DisplayAction,
  type Rc505DisplayRoot,
  type Rc505DisplayRootItem,
  type Rc505DisplayState,
  type Rc505DisplayView,
} from './rc505DisplayTypes';

const ROOT_ITEMS_PER_PAGE = 4;
const MAX_RETURN_DEPTH = 10;

export function createRc505DisplayState(): Rc505DisplayState {
  return {
    view: { kind: 'play', pageIndex: 0 },
    returnStack: [],
    notice: '',
    lastConfirmation: null,
  };
}

export function getRc505RootItems(root: Rc505DisplayRoot): readonly Rc505DisplayRootItem[] {
  return root === 'loop' ? RC505_LOOP_ROOT_ITEMS : RC505_MENU_ROOT_ITEMS;
}

function rootForView(view: Rc505DisplayView): Rc505DisplayRoot | null {
  if (view.kind === 'loop-root') return 'loop';
  if (view.kind === 'menu-root') return 'menu';
  return null;
}

function rootViewKind(root: Rc505DisplayRoot): 'loop-root' | 'menu-root' {
  return root === 'loop' ? 'loop-root' : 'menu-root';
}

function rootPageCount(root: Rc505DisplayRoot): number {
  return Math.max(1, Math.ceil(getRc505RootItems(root).length / ROOT_ITEMS_PER_PAGE));
}

function wrap(index: number, count: number): number {
  return (index % count + count) % count;
}

function withView(state: Rc505DisplayState, view: Rc505DisplayView, notice = ''): Rc505DisplayState {
  return { ...state, view, notice };
}

function pushView(state: Rc505DisplayState, view: Rc505DisplayView): Rc505DisplayState {
  const returnStack = [...state.returnStack, state.view];
  if (returnStack.length > MAX_RETURN_DEPTH) {
    returnStack.splice(1, returnStack.length - MAX_RETURN_DEPTH);
  }
  return { ...state, view, returnStack, notice: '' };
}

function openRootItem(state: Rc505DisplayState, root: Rc505DisplayRoot, itemIndex: number): Rc505DisplayState {
  const items = getRc505RootItems(root);
  const item = items[itemIndex];
  if (!item) return state;

  let view: Rc505DisplayView = state.view;
  if (root === 'loop' && state.view.kind === 'loop-root') view = { ...state.view, selectedIndex: itemIndex };
  if (root === 'menu' && state.view.kind === 'menu-root') view = { ...state.view, selectedIndex: itemIndex };
  const selectedState = { ...state, view };
  if (item.reason || !item.target) return { ...selectedState, notice: item.reason || `${item.label} is not available in this build.` };

  if (item.target === 'mixer') {
    return pushView(selectedState, { kind: 'mixer', pageIndex: 0 });
  }
  return pushView(selectedState, { kind: 'editor', target: item.target, category: item.id, pageIndex: 0, pageCount: 1 });
}

function navigateRoot(state: Rc505DisplayState, delta: number): Rc505DisplayState {
  if (state.view.kind !== 'loop-root' && state.view.kind !== 'menu-root') return state;
  const root = state.view.kind === 'loop-root' ? 'loop' : 'menu';
  if (!Number.isFinite(delta) || delta === 0) return state;
  const count = getRc505RootItems(root).length;
  const selectedIndex = wrap(state.view.selectedIndex + Math.trunc(delta), count);
  const pageIndex = Math.floor(selectedIndex / ROOT_ITEMS_PER_PAGE);
  return withView(state, { ...state.view, pageIndex, selectedIndex });
}

function selectRootEncoder(state: Rc505DisplayState, encoderIndex: number): Rc505DisplayState {
  if (state.view.kind !== 'loop-root' && state.view.kind !== 'menu-root') return state;
  const root = state.view.kind === 'loop-root' ? 'loop' : 'menu';
  if (!Number.isInteger(encoderIndex) || encoderIndex < 0 || encoderIndex >= ROOT_ITEMS_PER_PAGE) return state;
  const itemIndex = state.view.pageIndex * ROOT_ITEMS_PER_PAGE + encoderIndex;
  return openRootItem(state, root, itemIndex);
}

function enterSelectedRootItem(state: Rc505DisplayState): Rc505DisplayState {
  if (state.view.kind !== 'loop-root' && state.view.kind !== 'menu-root') return state;
  const root = state.view.kind === 'loop-root' ? 'loop' : 'menu';
  return openRootItem(state, root, state.view.selectedIndex);
}

function exitView(state: Rc505DisplayState): Rc505DisplayState {
  if (state.view.kind === 'memory-write' && state.view.busy) return state;
  if (state.view.kind === 'confirm') {
    return {
      ...state,
      view: state.returnStack[state.returnStack.length - 1] ?? { kind: 'play', pageIndex: 0 },
      returnStack: state.returnStack.slice(0, -1),
      notice: '',
      lastConfirmation: 'cancelled',
    };
  }
  if (state.returnStack.length === 0) return state;
  return {
    ...state,
    view: state.returnStack[state.returnStack.length - 1]!,
    returnStack: state.returnStack.slice(0, -1),
    notice: '',
  };
}

export function reduceRc505DisplayState(state: Rc505DisplayState, action: Rc505DisplayAction): Rc505DisplayState {
  if (state.view.kind === 'memory-write') {
    const view = state.view;
    if (action.type === 'MEMORY_COMPLETE' && view.busy) {
      return action.success
        ? exitView({ ...state, view: { ...view, busy: false } })
        : withView(state, { ...view, busy: false }, action.message || 'MEMORY FAILED');
    }
    if (view.busy) return state;
    if (action.type === 'ENCODER_PRESS' && action.encoderIndex >= 0 && action.encoderIndex < 4 && view.operation === 'choose') {
      return withView(state, { ...view, operation: action.encoderIndex < 2 ? 'write' : 'clear' });
    }
    if ((action.type === 'ENCODER_ROTATE' || action.type === 'ENCODER_PRESS_ROTATE') && view.operation !== 'choose'
      && action.encoderIndex >= 0 && action.encoderIndex < 4 && Number.isFinite(action.delta)) {
      return withView(state, { ...view, slot: Math.max(1, Math.min(99, view.slot + Math.trunc(action.delta))) });
    }
    if (action.type === 'ENTER' && view.operation !== 'choose') return withView(state, { ...view, busy: true });
    if (action.type !== 'EXIT' && action.type !== 'CLEAR_NOTICE') return state;
  }
  switch (action.type) {
    case 'OPEN_MEMORY_WRITE':
      if (state.view.kind === 'confirm' || !Number.isInteger(action.slot) || action.slot < 1 || action.slot > 99) return state;
      return pushView(state, { kind: 'memory-write', operation: 'choose', slot: action.slot, busy: false });
    case 'MEMORY_COMPLETE':
      return state;
    case 'PAGE': {
      if (state.view.kind === 'play') {
        return withView(state, { ...state.view, pageIndex: wrap(state.view.pageIndex + action.direction, RC505_PLAY_SCREENS.length) });
      }
      if (state.view.kind === 'mixer') {
        return withView(state, { ...state.view, pageIndex: wrap(state.view.pageIndex + action.direction, RC505_MIXER_PAGES.length) });
      }
      if (state.view.kind === 'loop-root' || state.view.kind === 'menu-root') {
        const root = rootForView(state.view)!;
        const count = rootPageCount(root);
        const pageIndex = wrap(state.view.pageIndex + action.direction, count);
        const firstItem = pageIndex * ROOT_ITEMS_PER_PAGE;
        const selectedIndex = state.view.selectedIndex >= firstItem && state.view.selectedIndex < firstItem + ROOT_ITEMS_PER_PAGE
          ? state.view.selectedIndex
          : firstItem;
        return withView(state, { ...state.view, pageIndex, selectedIndex });
      }
      if (state.view.kind === 'editor') {
        return withView(state, { ...state.view, pageIndex: wrap(state.view.pageIndex + action.direction, state.view.pageCount) });
      }
      return state;
    }
    case 'ENTER':
      if (state.view.kind === 'play') return pushView(state, { kind: 'mixer', pageIndex: 0 });
      if (state.view.kind === 'loop-root' || state.view.kind === 'menu-root') return enterSelectedRootItem(state);
      return state;
    case 'EXIT':
      return exitView(state);
    case 'OPEN_ROOT':
      if (state.view.kind === 'confirm') return state;
      if (state.view.kind === rootViewKind(action.root)) return state;
      if (state.view.kind === 'loop-root' || state.view.kind === 'menu-root') {
        return withView(state, {
          kind: rootViewKind(action.root),
          pageIndex: 0,
          selectedIndex: 0,
        });
      }
      return pushView(state, {
        kind: rootViewKind(action.root),
        pageIndex: 0,
        selectedIndex: 0,
      });
    case 'OPEN_EDITOR': {
      if (state.view.kind === 'confirm') return state;
      if (state.view.kind === 'editor') {
        if (state.view.target === action.target && state.view.category === action.category) return state;
        return withView(state, { kind: 'editor', target: action.target, category: action.category, pageIndex: 0, pageCount: 1 });
      }
      return pushView(state, { kind: 'editor', target: action.target, category: action.category, pageIndex: 0, pageCount: 1 });
    }
    case 'ENCODER_ROTATE':
      return navigateRoot(state, action.delta);
    case 'ENCODER_PRESS':
      return selectRootEncoder(state, action.encoderIndex);
    case 'ENCODER_PRESS_ROTATE':
      return navigateRoot(state, action.delta);
    case 'EDITOR_PAGE_COUNT': {
      if (state.view.kind !== 'editor') return state;
      const pageCount = Number.isInteger(action.count) ? Math.max(1, action.count) : 1;
      if (pageCount === state.view.pageCount && state.view.pageIndex < pageCount) return state;
      return withView(state, { ...state.view, pageCount, pageIndex: Math.min(state.view.pageIndex, pageCount - 1) });
    }
    case 'REQUEST_CONFIRMATION':
      if (state.view.kind === 'confirm') return withView(state, { ...state.view, prompt: action.prompt });
      return pushView(state, { kind: 'confirm', prompt: action.prompt });
    case 'CONFIRM': {
      if (state.view.kind !== 'confirm') return state;
      return {
        ...state,
        view: state.returnStack[state.returnStack.length - 1] ?? { kind: 'play', pageIndex: 0 },
        returnStack: state.returnStack.slice(0, -1),
        notice: '',
        lastConfirmation: action.accepted ? 'accepted' : 'cancelled',
      };
    }
    case 'CLEAR_NOTICE':
      return state.notice ? { ...state, notice: '' } : state;
  }
}
