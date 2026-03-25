import { computed, ref } from 'vue';

export type UiStyle = 'classic' | 'tech';

const UI_STYLE_KEY = 'webrc505_ui_style';
const currentStyle = ref<UiStyle>('classic');
let initialized = false;

function resolveInitialStyle(): UiStyle {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('ui');
  if (requested === 'classic' || requested === 'tech') {
    localStorage.setItem(UI_STYLE_KEY, requested);
    return requested;
  }

  const stored = localStorage.getItem(UI_STYLE_KEY);
  return stored === 'tech' ? 'tech' : 'classic';
}

function syncDom(style: UiStyle) {
  document.documentElement.dataset.uiStyle = style;
}

function ensureInitialized() {
  if (initialized) {
    return;
  }
  initialized = true;
  currentStyle.value = resolveInitialStyle();
  syncDom(currentStyle.value);
}

export function useUiStyle() {
  ensureInitialized();

  const isClassic = computed(() => currentStyle.value === 'classic');
  const toggleStyle = () => {
    currentStyle.value = currentStyle.value === 'classic' ? 'tech' : 'classic';
    localStorage.setItem(UI_STYLE_KEY, currentStyle.value);
    syncDom(currentStyle.value);
  };

  const setStyle = (style: UiStyle) => {
    currentStyle.value = style;
    localStorage.setItem(UI_STYLE_KEY, style);
    syncDom(style);
  };

  return {
    currentStyle,
    isClassic,
    toggleStyle,
    setStyle,
  };
}
