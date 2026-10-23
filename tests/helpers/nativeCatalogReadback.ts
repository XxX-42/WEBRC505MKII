import type { NativeCatalogSlotConfig, NativeCatalogSlotStatus } from '../../src/audio/NativeBridgeClient';

/** Explicit fake render boundary: acceptance alone is not an applied ACK. */
export function renderedCatalogWrite(config: NativeCatalogSlotConfig, previous?: Partial<NativeCatalogSlotStatus>): NativeCatalogSlotStatus {
  const revision = (previous?.requestedRevision ?? 0) + 1;
  return { slot: config.slot, effectId: config.effectId, parameters: { ...config.parameters },
    bypassed: config.bypassed, appliedBypassed: config.bypassed, prepared: Boolean(config.effectId),
    processingFaulted: false, controlFaulted: false, requestedRevision: revision, appliedRevision: revision };
}
