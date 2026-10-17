import { beforeEach, describe, expect, it } from 'vitest';
import { useDevicePanel } from '../../src/composables/useDevicePanel';

describe('device LCD page navigation', () => {
  const panel = useDevicePanel();

  beforeEach(() => {
    panel.goHome();
    panel.setEditorPageCount(1);
  });

  it('cycles subpages without changing the selected editor category', () => {
    panel.openPage('input-fx');
    panel.setEditorPageCount(3);

    panel.changePage(1);
    expect(panel.state.page).toBe('input-fx');
    expect(panel.state.editorPageIndex).toBe(1);

    panel.changePage(1);
    expect(panel.state.editorPageIndex).toBe(2);

    panel.changePage(1);
    expect(panel.state.editorPageIndex).toBe(0);

    panel.changePage(-1);
    expect(panel.state.editorPageIndex).toBe(2);
  });

  it('clamps a stale subpage index when page content shrinks', () => {
    panel.openPage('rhythm');
    panel.setEditorPageCount(4);
    panel.changePage(1);
    panel.changePage(1);
    panel.changePage(1);

    panel.setEditorPageCount(2);
    expect(panel.state.editorPageIndex).toBe(1);
    expect(panel.state.editorPageCount).toBe(2);
  });

  it('resets editor subpage state on exit and category changes', () => {
    panel.openPage('track-fx');
    panel.setEditorPageCount(3);
    panel.changePage(1);
    panel.openPage('settings');
    expect(panel.state.page).toBe('settings');
    expect(panel.state.editorPageIndex).toBe(0);
    expect(panel.state.editorPageCount).toBe(1);

    panel.backPage();
    expect(panel.state.page).toBe('home');
    expect(panel.state.editorPageIndex).toBe(0);
  });

  it('nests Audio Settings under MENU and returns through both levels', () => {
    panel.openPage('menu');
    panel.setEditorPageCount(2);
    panel.changePage(1);
    panel.openPage('settings');

    expect(panel.state.page).toBe('settings');
    expect(panel.state.editorParentPage).toBe('menu');
    expect(panel.state.editorPageIndex).toBe(0);

    panel.backPage();
    expect(panel.state.page).toBe('menu');
    panel.backPage();
    expect(panel.state.page).toBe('home');
  });
});
