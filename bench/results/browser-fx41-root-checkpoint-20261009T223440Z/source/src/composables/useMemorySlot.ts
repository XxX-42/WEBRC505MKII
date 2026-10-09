import { readonly, ref } from 'vue';

const activeMemorySlot = ref(1);

export function useMemorySlot() {
  const setActiveMemorySlot = (slot: number) => {
    if (!Number.isInteger(slot) || slot < 1 || slot > 99) throw new RangeError('Memory slot must be from 1 to 99.');
    activeMemorySlot.value = slot;
  };

  return {
    activeMemorySlot: readonly(activeMemorySlot),
    setActiveMemorySlot,
  };
}
