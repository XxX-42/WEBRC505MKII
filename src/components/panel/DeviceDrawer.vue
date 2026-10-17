<template>
  <Teleport to="body">
    <div
      v-show="open"
      class="device-drawer-layer"
      :class="{ 'device-drawer-mobile-modal': isMobileModal }"
      :data-open="open ? 'true' : 'false'"
      :aria-hidden="!open"
      @pointerdown.self="$emit('close')"
    >
      <aside
        class="device-drawer"
        ref="dialog"
        :data-testid="testId"
        role="dialog"
        :aria-modal="isMobileModal ? 'true' : 'false'"
        :aria-labelledby="titleId"
        tabindex="-1"
      >
        <header class="drawer-header">
          <div>
            <div v-if="eyebrow" class="drawer-eyebrow">{{ eyebrow }}</div>
            <h2 :id="titleId">{{ title }}</h2>
          </div>
          <button class="drawer-close" type="button" data-testid="device-drawer-close" aria-label="Close panel" @click="$emit('close')">×</button>
        </header>
        <div class="drawer-content">
          <slot />
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  eyebrow?: string;
  testId?: string;
}>(), {
  eyebrow: 'RC-505mkII · PANEL',
  testId: 'device-drawer',
});

const emit = defineEmits<{ close: [] }>();

const titleId = `device-drawer-title-${Math.random().toString(36).slice(2, 9)}`;
const dialog = ref<HTMLElement | null>(null);
const isMobileModal = ref(false);
const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let opener: HTMLElement | null = null;
let mobileMedia: MediaQueryList | null = null;

watch(() => props.open, async (isOpen) => {
  if (isOpen) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await nextTick();
    const firstFocusable = dialog.value?.querySelector<HTMLElement>(focusableSelector);
    (firstFocusable ?? dialog.value)?.focus({ preventScroll: true });
    return;
  }

  await nextTick();
  // A sibling drawer may be opening in the same render. Leave focus management
  // to that dialog rather than restoring focus behind it.
  if (document.querySelector('.device-drawer-layer[data-open="true"]')) return;
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  opener = null;
}, { flush: 'post', immediate: true });

function handleKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key !== 'Tab' || !isMobileModal.value || !dialog.value) return;

  const focusable = Array.from(dialog.value.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => !element.hasAttribute('disabled')
      && !element.closest('[hidden], [aria-hidden="true"], details:not([open])')
      && window.getComputedStyle(element).display !== 'none'
      && window.getComputedStyle(element).visibility !== 'hidden');
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.value.focus();
    return;
  }

  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.value.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.value.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function updateModalMode(): void {
  isMobileModal.value = mobileMedia?.matches ?? false;
}

onMounted(() => {
  mobileMedia = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 900px)') : null;
  updateModalMode();
  mobileMedia?.addEventListener('change', updateModalMode);
  window.addEventListener('keydown', handleKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
  mobileMedia?.removeEventListener('change', updateModalMode);
  const returnFocus = opener;
  void nextTick(() => {
    if (document.querySelector('.device-drawer-layer[data-open="true"]')) return;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
});

</script>

<style>
.device-drawer-layer {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: stretch;
  justify-content: flex-end;
  padding: 78px clamp(8px, 1.5vw, 24px) 16px;
  pointer-events: none;
}

.device-drawer {
  display: flex;
  flex-direction: column;
  width: min(560px, 40vw);
  max-height: min(86dvh, 940px);
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 14px;
  color: #f4f5f7;
  background: linear-gradient(155deg, #282b31 0%, #121419 68%);
  box-shadow: 0 28px 90px rgba(0, 0, 0, 0.62), inset 0 1px rgba(255, 255, 255, 0.08);
  pointer-events: auto;
}

.drawer-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  min-height: 70px;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(15, 17, 22, 0.96);
}

.drawer-header h2 {
  margin: 2px 0 0;
  font: 700 18px/1.2 var(--font-hardware, system-ui, sans-serif);
  letter-spacing: 0.09em;
}

.drawer-eyebrow {
  color: #b8c1cc;
  font: 600 12px/1.4 var(--font-hardware, system-ui, sans-serif);
  letter-spacing: 0.15em;
}

.drawer-close {
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 50%;
  color: white;
  background: #292d35;
  font-size: 28px;
  line-height: 1;
  cursor: pointer;
}

.drawer-close:hover { background: #3a404a; }
.drawer-close:focus-visible { outline: 3px solid #6bc5ff; outline-offset: 2px; }

.drawer-content {
  min-height: 0;
  overflow: auto;
  padding: clamp(14px, 2vw, 24px);
  overscroll-behavior: contain;
}

.drawer-content > :first-child { margin-top: 0; }
.drawer-content > :last-child { margin-bottom: 0; }

@media (max-width: 900px) {
  .device-drawer-layer.device-drawer-mobile-modal {
    display: grid;
    place-items: center;
    padding: clamp(12px, 3vw, 32px);
    pointer-events: auto;
    background: rgba(3, 5, 8, 0.7);
    backdrop-filter: blur(5px);
  }
  .device-drawer-mobile-modal .device-drawer { width: min(980px, 100%); }
}

@media (max-width: 640px) {
  .device-drawer-layer.device-drawer-mobile-modal { padding: 0; place-items: stretch; }
  .device-drawer-mobile-modal .device-drawer { width: 100%; max-height: 100dvh; border-radius: 0; }
  .drawer-header { min-height: 62px; padding: 11px 14px; }
  .drawer-header h2 { font-size: 15px; }
}
</style>
