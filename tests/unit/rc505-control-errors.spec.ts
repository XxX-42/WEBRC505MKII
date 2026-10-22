import { beforeEach, describe, expect, it } from 'vitest';
import { useRc505Controls } from '../../src/composables/useRc505Controls';

describe('Classic control-error scope', () => {
  const controls = useRc505Controls();
  beforeEach(() => controls.reset());
  it('keeps FX bank diagnostics without masking an unrelated editor', () => {
    controls.reportError('FX BANK ERROR', 'Bank slots differ from readback', 'input-fx');
    expect(controls.errorFor('input-fx')).toBe('FX BANK ERROR');
    expect(controls.errorFor('play')).toBe('FX BANK ERROR');
    expect(controls.errorFor('other')).toBe('');
    expect(controls.errorFor('track-fx')).toBe('');
    expect(controls.state.errorDetail).toContain('readback');
    controls.clearError('track-fx');
    expect(controls.state.error).toBe('FX BANK ERROR');
    controls.clearError('input-fx');
    expect(controls.errorFor('play')).toBe('');
  });
  it('shows general action failures and clears them when the history layer changes', () => {
    controls.reportError('HISTORY FAILED');
    expect(controls.errorFor('other')).toBe('HISTORY FAILED');
    controls.toggleUndoLayer();
    expect(controls.state.error).toBe('');
    expect(controls.state.errorDetail).toBe('');
  });
});
