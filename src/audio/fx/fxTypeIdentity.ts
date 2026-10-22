import { FX_CATALOG } from './catalog';

const EXPERIMENTAL_SUFFIX = ' (EXPERIMENTAL)';

/** Resolve a user-facing selector label to its stable clean-room catalog ID. */
export function fxCatalogIdForDisplayLabel(label: string): string | null {
  const normalized = label.trim().toUpperCase();
  const canonical = normalized.endsWith(EXPERIMENTAL_SUFFIX)
    ? normalized.slice(0, -EXPERIMENTAL_SUFFIX.length)
    : normalized;
  return FX_CATALOG.find((effect) => effect.displayName.toUpperCase() === canonical)?.id ?? null;
}

