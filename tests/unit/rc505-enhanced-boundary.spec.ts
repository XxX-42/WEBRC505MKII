import { describe, expect, it } from 'vitest';
import { createEnhancedDevicePanel } from '../../src/composables/createEnhancedDevicePanel';
import { useDevicePanel } from '../../src/composables/useDevicePanel';

describe('Enhanced route isolation', () => {
  it('retains the Classic Play screen and return stack while software tools navigate and paginate', () => {
    const classic = useDevicePanel();
    classic.classicDispatch({ type: 'PAGE', direction: 1 });
    classic.classicDispatch({ type: 'OPEN_ROOT', root: 'loop' });
    const before = JSON.stringify(classic.classicState.value);
    const enhanced = createEnhancedDevicePanel();
    enhanced.openPage('settings');
    enhanced.setEditorPageCount(3);
    enhanced.changePage(1);
    enhanced.openPage('memory');
    expect(enhanced.state.page).toBe('memory');
    expect(enhanced.state.editorPageIndex).toBe(0);
    expect(JSON.stringify(classic.classicState.value)).toBe(before);
    enhanced.backPage();
    expect(enhanced.state.page).toBe('menu');
    classic.classicDispatch({ type: 'EXIT' });
    expect(classic.classicState.value.view).toEqual({ kind: 'play', pageIndex: 1 });
  });
});
