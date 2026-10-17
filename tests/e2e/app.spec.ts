import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeDeviceDrawer, findLcdField, lcdField, lcdScreen, openAppSettingsMenu, openFxEditor, openLcdPage, startBrowserAudio } from './uiHelpers';

const initScriptPath = path.join(process.cwd(), 'tests', 'e2e', 'initMocks.js');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: initScriptPath });
});

test('defaults to classic shell and persists UI style toggling', async ({ page }) => {
  await page.goto('/?audio=browser');
  await startBrowserAudio(page);

  await expect(page.locator('#app > [data-ui-style="classic"]')).toBeVisible();
  await expect(page.locator('[data-panel="center-main"]')).toBeVisible();
  await expect(page.locator('[data-panel="track-bay"]')).toBeVisible();
  await expect(page.getByTestId('rc505-physical-face')).toBeVisible();

  const lcd = await openLcdPage(page, 'input-fx-edit-button');
  await expect(lcd).toContainText(/INPUT FX/i);
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
  await page.getByTestId('track-fx-edit-button').click();
  await expect(lcd).toContainText(/TRACK FX/i);
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);

  await openAppSettingsMenu(page);
  await page.getByTestId('ui-style-toggle').click();
  await expect(page.locator('#app > [data-ui-style="tech"]')).toBeVisible();

  await page.reload();
  await startBrowserAudio(page);
  await expect(page.locator('#app > [data-ui-style="tech"]')).toBeVisible();
});

test('keeps original tech-shell interactions available after switching UI style', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  await expect(page.locator('.mode-summary')).toHaveText('BROWSER: 5 TRACKS; LIMITED EFFECTS/RHYTHM; DSP PARITY INCOMPLETE');

  const firstTrack = page.locator('.track-unit').first();
  const filterButton = firstTrack.locator('button[aria-label="Toggle track filter"]');
  await expect(filterButton).toBeVisible();
  await filterButton.click();
  await expect(filterButton).toHaveClass(/active/);

  const fader = firstTrack.locator('.right-fader input[type="range"]').first();
  await fader.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '72';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(firstTrack.locator('.fader-value').first()).toContainText('72');
});

test('selects the explicitly experimental REVERSE REVERB from the Browser FX panel', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const panel = page.locator('[data-panel="input-fx"]');
  const selector = panel.locator('select.fx-select').first();
  await expect(selector.locator('option')).toContainText(['REVERSE REVERB (EXPERIMENTAL)']);
  await selector.selectOption('REVERSE REVERB (EXPERIMENTAL)');

  await page.waitForFunction(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    return records.some(({ algorithm, message }) => algorithm === 'reverse-reverb'
      && message?.type === 'configure');
  });
  const routed = await page.evaluate(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    return records
      .filter(({ algorithm, message }) => algorithm === 'reverse-reverb' && message?.type === 'configure')
      .reduce<Record<string, number>>((parameters, { message }) => Object.assign(parameters, message?.parameters), {});
  });
  expect(routed.bpm).toBeGreaterThanOrEqual(30);
  expect(routed.bpm).toBeLessThanOrEqual(300);
});

test('shows Native capability reasons in the Tech compatibility shell', async ({ page }) => {
  await page.goto('/?audio=native&ui=tech');

  await expect(page.locator('.mode-summary')).toHaveText(
    'NATIVE: 1 LOOP TRACK; INPUT A–D UNAVAILABLE; TRACK A–D UNAVAILABLE',
  );
  const inputPanel = await openFxEditor(page, 'input');
  await expect(inputPanel.locator('.section-note').first())
    .toContainText('Native catalog FX is unavailable');
  await closeDeviceDrawer(page);
  await expect(page.getByTestId('rhythm-status'))
    .toContainText('Native rhythm is unavailable in the current bridge status.');

  const secondTrack = page.locator('.tech-track-list .track-unit[data-track-id="2"]');
  await expect(secondTrack.locator('.track-note').first())
    .toHaveText('NATIVE HOST DOES NOT EXPOSE THIS LOOP TRACK');
  await expect(secondTrack.getByRole('slider', { name: /Track 2 level unavailable:/ }))
    .toBeDisabled();
});

test('edits and restores all six PREAMP controls from the live Browser FX panel', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const panel = page.locator('.top-panel [data-panel="input-fx"]');
  await panel.locator('select.fx-select').first().selectOption('PREAMP');
  const editor = panel.locator('[data-preamp-editor]');
  await expect(editor).toBeVisible();

  await editor.getByLabel('Preamp model').selectOption('3');
  const setRange = async (label: string, value: string) => {
    await editor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  await setRange('Preamp gain percent', '72');
  await setRange('Preamp bass in decibels', '4.5');
  await setRange('Preamp middle in decibels', '-2');
  await setRange('Preamp treble in decibels', '6');
  await setRange('Preamp level in decibels', '-3');

  await expect(editor.getByLabel('Preamp model')).toHaveValue('3');
  await expect(editor.getByLabel('Preamp gain percent')).toHaveValue('72');
  await expect(editor.getByLabel('Preamp bass in decibels')).toHaveValue('4.5');
  await expect(editor.getByLabel('Preamp middle in decibels')).toHaveValue('-2');
  await expect(editor.getByLabel('Preamp treble in decibels')).toHaveValue('6');
  await expect(editor.getByLabel('Preamp level in decibels')).toHaveValue('-3');
  // Trace the actual application route: the six Vue controls call
  // AudioEngine.setPreampParameters, which maps them to BrowserWorkletFX and
  // post configure updates to the slot's AudioWorklet port.
  await page.waitForFunction(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    const delivered = records
      .filter(({ algorithm, message }) => algorithm === 'preamp' && message?.type === 'configure')
      .reduce<Record<string, number>>((parameters, { message }) => Object.assign(parameters, message?.parameters), {});
    return delivered.preampModel === 3
      && delivered.preampGainPercent === 72
      && delivered.preampBassDb === 4.5
      && delivered.preampMiddleDb === -2
      && delivered.preampTrebleDb === 6
      && delivered.preampLevelDb === -3;
  });
  const deliveredPreampParameters = await page.evaluate(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    return records
      .filter(({ algorithm, message }) => algorithm === 'preamp' && message?.type === 'configure')
      .reduce<Record<string, number>>((parameters, { message }) => Object.assign(parameters, message?.parameters), {});
  });
  expect(deliveredPreampParameters).toMatchObject({
    preampModel: 3,
    preampGainPercent: 72,
    preampBassDb: 4.5,
    preampMiddleDb: -2,
    preampTrebleDb: 6,
    preampLevelDb: -3,
  });

  const macroFader = panel.locator('.fx-slot-shell').first().getByRole('slider');
  await macroFader.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '81';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(editor.getByLabel('Preamp gain percent')).toHaveValue('81');
  await setRange('Preamp gain percent', '72');

  await page.reload();
  await startBrowserAudio(page);
  const restored = page.locator('[data-panel="input-fx"] [data-preamp-editor]');
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel('Preamp model')).toHaveValue('3');
  await expect(restored.getByLabel('Preamp gain percent')).toHaveValue('72');
  await expect(restored.getByLabel('Preamp bass in decibels')).toHaveValue('4.5');
  await expect(restored.getByLabel('Preamp middle in decibels')).toHaveValue('-2');
  await expect(restored.getByLabel('Preamp treble in decibels')).toHaveValue('6');
  await expect(restored.getByLabel('Preamp level in decibels')).toHaveValue('-3');
});

test('sends all six PREAMP controls from the Browser Track A editor to its FX worklet', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const panel = page.locator('[data-panel="track-fx"]');
  await panel.locator('select.fx-select').first().selectOption('PREAMP');
  const editor = panel.locator('[data-preamp-editor]');
  await expect(editor).toBeVisible();
  await editor.getByLabel('Preamp model').selectOption('2');
  const setRange = async (label: string, value: string) => {
    await editor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  await setRange('Preamp gain percent', '61');
  await setRange('Preamp bass in decibels', '-4');
  await setRange('Preamp middle in decibels', '2.5');
  await setRange('Preamp treble in decibels', '3.5');
  await setRange('Preamp level in decibels', '1');

  await page.waitForFunction(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    const delivered = records
      .filter(({ algorithm, message }) => algorithm === 'preamp' && message?.type === 'configure')
      .reduce<Record<string, number>>((parameters, { message }) => Object.assign(parameters, message?.parameters), {});
    return delivered.preampModel === 2
      && delivered.preampGainPercent === 61
      && delivered.preampBassDb === -4
      && delivered.preampMiddleDb === 2.5
      && delivered.preampTrebleDb === 3.5
      && delivered.preampLevelDb === 1;
  });

  await page.reload();
  await startBrowserAudio(page);
  const restored = page.locator('[data-panel="track-fx"] [data-preamp-editor]');
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel('Preamp model')).toHaveValue('2');
  await expect(restored.getByLabel('Preamp gain percent')).toHaveValue('61');
  await expect(restored.getByLabel('Preamp bass in decibels')).toHaveValue('-4');
  await expect(restored.getByLabel('Preamp middle in decibels')).toHaveValue('2.5');
  await expect(restored.getByLabel('Preamp treble in decibels')).toHaveValue('3.5');
  await expect(restored.getByLabel('Preamp level in decibels')).toHaveValue('1');
});

test('edits, routes and restores the Browser ROLL controls through the live FX worklet', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const panel = page.locator('[data-panel="input-fx"]');
  await panel.locator('select.fx-select').first().selectOption('ROLL');
  const editor = panel.locator('[data-roll-editor]');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('ROLL slice length in beats')).toHaveValue('0.5');
  await expect(editor.getByLabel('ROLL decay percent')).toHaveValue('20');
  await expect(editor.getByLabel('ROLL pitch semitones')).toHaveValue('0');
  await expect(editor.getByLabel('ROLL playback direction')).toHaveValue('0');

  await editor.getByLabel('ROLL slice length in beats').selectOption('1');
  const setRange = async (label: string, value: string) => {
    await editor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  await setRange('ROLL decay percent', '35');
  await setRange('ROLL pitch semitones', '-12');
  await editor.getByLabel('ROLL playback direction').selectOption('2');
  await panel.locator('.fx-slot-shell').first().getByRole('button', { name: 'A', exact: true }).click();

  await page.waitForFunction(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number>; bypassed?: boolean };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    const configured = records
      .filter(({ algorithm, message }) => algorithm === 'roll' && message?.type === 'configure')
      .reduce<Record<string, number>>((parameters, { message }) => Object.assign(parameters, message?.parameters), {});
    return configured.rollSliceBeats === 1
      && configured.rollDecayPercent === 35
      && configured.rollPitchSemitones === -12
      && configured.rollDirection === 2;
  });

  await expect(editor.getByLabel('ROLL slice length in beats')).toHaveValue('1');
  await expect(editor.getByLabel('ROLL decay percent')).toHaveValue('35');
  await expect(editor.getByLabel('ROLL pitch semitones')).toHaveValue('-12');
  await expect(editor.getByLabel('ROLL playback direction')).toHaveValue('2');

  const macroFader = panel.locator('.fx-slot-shell').first().locator('input[type="range"]');
  await macroFader.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '65';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForFunction(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    return records.some(({ algorithm, message }) => algorithm === 'roll'
      && message?.type === 'configure'
      && typeof message.parameters?.mix === 'number'
      && message.parameters.mix === 0.65);
  });

  await page.reload();
  await startBrowserAudio(page);
  const restored = page.locator('[data-panel="input-fx"] [data-roll-editor]');
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel('ROLL slice length in beats')).toHaveValue('1');
  await expect(restored.getByLabel('ROLL decay percent')).toHaveValue('35');
  await expect(restored.getByLabel('ROLL pitch semitones')).toHaveValue('-12');
  await expect(restored.getByLabel('ROLL playback direction')).toHaveValue('2');
});

test('routes and restores the Browser FREEZE micro-loop controls through the FX worklet', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const panel = page.locator('[data-panel="input-fx"]');
  await panel.locator('select.fx-select').first().selectOption('FREEZE');
  const editor = panel.locator('[data-freeze-editor]');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('FREEZE capture length milliseconds')).toHaveValue('250');
  await expect(editor.getByLabel('FREEZE pitch semitones')).toHaveValue('0');

  const setRange = async (label: string, value: string) => {
    await editor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  await setRange('FREEZE capture length milliseconds', '420');
  await setRange('FREEZE pitch semitones', '-9');
  await editor.getByLabel('Capture or release FREEZE loop').click();
  await panel.locator('.fx-slot-shell').first().getByRole('button', { name: 'A', exact: true }).click();

  await page.waitForFunction(() => {
    const records = (window as unknown as {
      __rc505AudioWorkletMessages?: Array<{
        algorithm?: string;
        message?: { type?: string; parameters?: Record<string, number> };
      }>;
    }).__rc505AudioWorkletMessages ?? [];
    const configured = records
      .filter(({ algorithm, message }) => algorithm === 'freeze' && message?.type === 'configure')
      .reduce<Record<string, number>>((parameters, { message }) => Object.assign(parameters, message?.parameters), {});
    return configured.freezeCaptureLengthMs === 420
      && configured.freezePitchSemitones === -9
      && configured.freezeEnabled === 1;
  });

  await page.reload();
  await startBrowserAudio(page);
  const restored = page.locator('[data-panel="input-fx"] [data-freeze-editor]');
  await expect(restored).toBeVisible();
  await expect(restored.getByLabel('FREEZE capture length milliseconds')).toHaveValue('420');
  await expect(restored.getByLabel('FREEZE pitch semitones')).toHaveValue('-9');
  await expect(restored.getByLabel('Capture or release FREEZE loop')).toHaveAttribute('aria-pressed', 'false');
});

test('sends and restores Browser SYNTH controls on Input and Track A worklet routes', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const setRange = async (editor: ReturnType<typeof page.locator>, label: string, value: string) => {
    await editor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  const expectDelivered = async (expected: Record<string, number>) => {
    await page.waitForFunction((target) => {
      const records = (window as unknown as {
        __rc505AudioWorkletMessages?: Array<{
          algorithm?: string;
          message?: { type?: string; parameters?: Record<string, number> };
        }>;
      }).__rc505AudioWorkletMessages ?? [];
      const delivered = records
        .filter(({ algorithm, message }) => algorithm === 'synth' && message?.type === 'configure')
        .reduce<Record<string, number>>((parameters, { message }) => Object.assign(parameters, message?.parameters), {});
      return Object.entries(target).every(([key, value]) => delivered[key] === value);
    }, expected);
  };

  const inputPanel = page.locator('[data-panel="input-fx"]');
  await inputPanel.locator('select.fx-select').first().selectOption('SYNTH');
  const inputEditor = inputPanel.locator('[data-synth-editor]');
  await expect(inputEditor).toBeVisible();
  await setRange(inputEditor, 'Synth tracking sensitivity', '73');
  await inputEditor.getByLabel('Synth oscillator waveform').selectOption('2');
  await setRange(inputEditor, 'Synth oscillator octave', '-12');
  await setRange(inputEditor, 'Synth tone cutoff hertz', '6400');
  await setRange(inputEditor, 'Synth effect mix percent', '44');
  const inputParameters = {
    synthSensitivity: 73,
    synthWaveform: 2,
    synthOctave: -12,
    synthToneHz: 6400,
    synthMixPercent: 44,
  };
  await expectDelivered(inputParameters);

  const inputMacroFader = inputPanel.locator('.fx-slot-shell').first().getByRole('slider');
  await inputMacroFader.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '67';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(inputEditor.getByLabel('Synth effect mix percent')).toHaveValue('67');

  const trackPanel = page.locator('[data-panel="track-fx"]');
  await trackPanel.locator('select.fx-select').first().selectOption('SYNTH');
  const trackEditor = trackPanel.locator('[data-synth-editor]');
  await expect(trackEditor).toBeVisible();
  await setRange(trackEditor, 'Synth tracking sensitivity', '31');
  await trackEditor.getByLabel('Synth oscillator waveform').selectOption('1');
  await setRange(trackEditor, 'Synth oscillator octave', '7');
  await setRange(trackEditor, 'Synth tone cutoff hertz', '900');
  await setRange(trackEditor, 'Synth effect mix percent', '22');
  const trackParameters = {
    synthSensitivity: 31,
    synthWaveform: 1,
    synthOctave: 7,
    synthToneHz: 900,
    synthMixPercent: 22,
  };
  await expectDelivered(trackParameters);

  await page.reload();
  await startBrowserAudio(page);
  const restoredInput = page.locator('[data-panel="input-fx"] [data-synth-editor]');
  const restoredTrack = page.locator('[data-panel="track-fx"] [data-synth-editor]');
  await expect(restoredInput).toBeVisible();
  await expect(restoredTrack).toBeVisible();
  await expect(restoredInput.getByLabel('Synth tracking sensitivity')).toHaveValue('73');
  await expect(restoredInput.getByLabel('Synth oscillator waveform')).toHaveValue('2');
  await expect(restoredInput.getByLabel('Synth oscillator octave')).toHaveValue('-12');
  await expect(restoredInput.getByLabel('Synth tone cutoff hertz')).toHaveValue('6400');
  await expect(restoredInput.getByLabel('Synth effect mix percent')).toHaveValue('67');
  await expect(restoredTrack.getByLabel('Synth tracking sensitivity')).toHaveValue('31');
  await expect(restoredTrack.getByLabel('Synth oscillator waveform')).toHaveValue('1');
  await expect(restoredTrack.getByLabel('Synth oscillator octave')).toHaveValue('7');
  await expect(restoredTrack.getByLabel('Synth tone cutoff hertz')).toHaveValue('900');
  await expect(restoredTrack.getByLabel('Synth effect mix percent')).toHaveValue('22');

  await openAppSettingsMenu(page);
  await page.getByTestId('ui-style-toggle').click();
  await expect(page.locator('#app > [data-ui-style="classic"]')).toBeVisible();
  const techInput = await openFxEditor(page, 'input');
  await expect(page.locator('#app > [data-ui-style="tech"]')).toBeVisible();
  await expect(techInput.locator('[data-synth-editor]')).toBeVisible();
  await closeDeviceDrawer(page);
  const techTrack = await openFxEditor(page, 'track');
  await expect(techTrack.locator('[data-synth-editor]')).toBeVisible();
});

test('sends and restores Browser G2B tracking, octave blend, and body controls on Input and Track A', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);
  const setRange = async (editor: ReturnType<typeof page.locator>, label: string, value: string) => {
    await editor.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = String(nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  };
  const expectDelivered = async (expected: Record<string, number>) => {
    await page.waitForFunction((target) => {
      const records = (window as unknown as {
        __rc505AudioWorkletMessages?: Array<{
          algorithm?: string;
          message?: { type?: string; parameters?: Record<string, number> };
        }>;
      }).__rc505AudioWorkletMessages ?? [];
      const delivered = records
        .filter(({ algorithm, message }) => algorithm === 'g2b' && message?.type === 'configure')
        .reduce<Record<string, number>>((parameters, { message }) => Object.assign(parameters, message?.parameters), {});
      return Object.entries(target).every(([key, value]) => delivered[key] === value);
    }, expected);
  };

  const inputPanel = page.locator('[data-panel="input-fx"]');
  await inputPanel.locator('select.fx-select').first().selectOption('G2B');
  const inputEditor = inputPanel.locator('[data-g2b-editor]');
  await expect(inputEditor).toBeVisible();
  await setRange(inputEditor, 'G2B tracking sensitivity', '77');
  await setRange(inputEditor, 'G2B sub octave blend', '46');
  await setRange(inputEditor, 'G2B body cutoff hertz', '65');
  await expectDelivered({ g2bTrackingPercent: 77, g2bBlendPercent: 46, g2bBodyHz: 60 * (20 ** 0.65) });

  const inputMacroFader = inputPanel.locator('.fx-slot-shell').first().getByRole('slider');
  await inputMacroFader.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '68';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(inputEditor.getByLabel('G2B sub octave blend')).toHaveValue('68');

  const trackPanel = page.locator('[data-panel="track-fx"]');
  await trackPanel.locator('select.fx-select').first().selectOption('G2B');
  const trackEditor = trackPanel.locator('[data-g2b-editor]');
  await expect(trackEditor).toBeVisible();
  await setRange(trackEditor, 'G2B tracking sensitivity', '33');
  await setRange(trackEditor, 'G2B sub octave blend', '81');
  await setRange(trackEditor, 'G2B body cutoff hertz', '79');
  await expectDelivered({ g2bTrackingPercent: 33, g2bBlendPercent: 81, g2bBodyHz: 60 * (20 ** 0.79) });

  await page.reload();
  await startBrowserAudio(page);
  const restoredInput = page.locator('[data-panel="input-fx"] [data-g2b-editor]');
  const restoredTrack = page.locator('[data-panel="track-fx"] [data-g2b-editor]');
  await expect(restoredInput.getByLabel('G2B tracking sensitivity')).toHaveValue('77');
  await expect(restoredInput.getByLabel('G2B sub octave blend')).toHaveValue('68');
  await expect(restoredInput.getByLabel('G2B body cutoff hertz')).toHaveValue('65');
  await expect(restoredTrack.getByLabel('G2B tracking sensitivity')).toHaveValue('33');
  await expect(restoredTrack.getByLabel('G2B sub octave blend')).toHaveValue('81');
  await expect(restoredTrack.getByLabel('G2B body cutoff hertz')).toHaveValue('79');

  await openAppSettingsMenu(page);
  await page.getByTestId('ui-style-toggle').click();
  await expect(page.locator('#app > [data-ui-style="classic"]')).toBeVisible();
  const techInput = await openFxEditor(page, 'input');
  await expect(page.locator('#app > [data-ui-style="tech"]')).toBeVisible();
  await expect(techInput.locator('[data-g2b-editor]')).toBeVisible();
  await closeDeviceDrawer(page);
  const techTrack = await openFxEditor(page, 'track');
  await expect(techTrack.locator('[data-g2b-editor]')).toBeVisible();
});

test('exposes the full clean-room rhythm catalog and shared kit, variation, section, and timing controls', async ({ page }) => {
  await page.goto('/?audio=browser&ui=tech');
  await startBrowserAudio(page);

  const topPattern = page.getByTestId('rhythm-pattern-select');
  await expect(topPattern.locator('option')).toHaveCount(240);
  await expect(topPattern).toHaveValue('106');
  await topPattern.selectOption('240');

  await page.locator('summary[aria-label="More rhythm settings"]').click();
  const kit = page.getByTestId('rhythm-kit-select');
  const variation = page.getByTestId('rhythm-variation-select');
  const section = page.getByTestId('rhythm-section-select');
  const quantize = page.getByTestId('rhythm-quantize-select');
  await expect(kit.locator('option')).toHaveCount(16);
  await expect(variation.locator('option')).toHaveCount(4);
  await expect(section.locator('option')).toHaveCount(4);
  await kit.selectOption('16');
  await variation.selectOption('D');
  await section.selectOption('fill');
  await quantize.selectOption('1/8');
  await page.getByTestId('rhythm-swing').evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '67';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(kit).toHaveValue('16');
  await expect(variation).toHaveValue('D');
  await expect(section).toHaveValue('fill');
  await expect(quantize).toHaveValue('1/8');
  await expect(page.getByTestId('rhythm-provenance')).toContainText('not factory MIDI or samples');

  await openAppSettingsMenu(page);
  await page.getByTestId('ui-style-toggle').click();
  await expect(page.locator('#app > [data-ui-style="classic"]')).toBeVisible();
  const lcd = await openLcdPage(page, 'rhythm-edit-button');
  await expect(lcd).toContainText(/RHYTHM/i);
  await expect(lcdField(page, 'pattern')).toHaveValue('240');
  await expect(lcdField(page, 'kit')).toHaveValue('16');
  await findLcdField(page, 'variation');
  await expect(lcdField(page, 'variation').locator('option:checked')).toHaveText('D');
  await expect(lcdField(page, 'section').locator('option:checked')).toHaveText('FILL');
  await expect(lcdField(page, 'quantize').locator('option:checked')).toHaveText('1/8');
  await expect(lcdField(page, 'swing')).toHaveValue('67');
  await expect(page.locator('.device-drawer-layer[data-open="true"]')).toHaveCount(0);
});
