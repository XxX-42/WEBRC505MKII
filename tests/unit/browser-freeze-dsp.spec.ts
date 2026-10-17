import { describe, expect, it } from 'vitest';
import { BrowserFreezeDsp } from '../../src/audio/fx/dsp/BrowserFreezeDsp';

function runBlock(
  dsp: BrowserFreezeDsp,
  inputLeft: Float32Array,
  inputRight: Float32Array,
  outputLeft: Float32Array,
  outputRight: Float32Array,
  start: number,
  end: number,
  blockSizes: readonly number[] = [end - start],
): void {
  let offset = start;
  let block = 0;
  while (offset < end) {
    const requested = blockSizes[block % blockSizes.length] ?? end - start;
    const frames = Math.min(Math.max(1, requested), end - offset);
    dsp.processBlock(
      inputLeft.subarray(offset, offset + frames),
      inputRight.subarray(offset, offset + frames),
      outputLeft.subarray(offset, offset + frames),
      outputRight.subarray(offset, offset + frames),
    );
    offset += frames;
    block += 1;
  }
}

describe('Browser clean-room FREEZE micro-loop DSP (catalog source ID 45)', () => {
  it('waits for a complete pre-roll window before fading into a requested capture', () => {
    const sampleRate = 8000;
    const dsp = new BrowserFreezeDsp(sampleRate, { captureLengthMs: 20 });
    const partialLength = 80;
    const partialLeft = new Float32Array(partialLength).fill(0.4);
    const partialRight = new Float32Array(partialLength).fill(-0.3);
    const partialOutputLeft = new Float32Array(partialLength);
    const partialOutputRight = new Float32Array(partialLength);

    dsp.setParameters({ frozen: true });
    dsp.processBlock(partialLeft, partialRight, partialOutputLeft, partialOutputRight);
    expect(dsp.diagnostics).toMatchObject({
      targetFrozen: true,
      capturePending: true,
      hasFrozenBuffer: false,
      activationGain: 0,
    });
    expect(partialOutputLeft).toEqual(partialLeft);
    expect(partialOutputRight).toEqual(partialRight);

    const completingLeft = new Float32Array(80).fill(0.6);
    const completingRight = new Float32Array(80).fill(-0.5);
    dsp.processBlock(completingLeft, completingRight, new Float32Array(80), new Float32Array(80));
    expect(dsp.diagnostics).toMatchObject({
      capturePending: false,
      hasFrozenBuffer: true,
      activeCaptureLengthFrames: 160,
    });

    dsp.setParameters({ frozen: false });
    const released = new Float32Array(40).fill(0.2);
    const releaseOutput = new Float32Array(40);
    dsp.processBlock(released, released, releaseOutput, new Float32Array(40));
    expect(releaseOutput[39]).toBeCloseTo(0.2, 6);
  });

  it('captures the recent stereo history with an O(1) ring swap, then holds it', () => {
    const sampleRate = 8000;
    const dsp = new BrowserFreezeDsp(sampleRate, { captureLengthMs: 20 });
    const prefillLeft = new Float32Array(160);
    const prefillRight = new Float32Array(160);
    for (let frame = 0; frame < prefillLeft.length; frame += 1) {
      prefillLeft[frame] = 0.4 * Math.sin((2 * Math.PI * 200 * frame) / 8000);
      prefillRight[frame] = 0.3 * Math.sin((2 * Math.PI * 300 * frame) / 8000);
    }

    const prefillOutLeft = new Float32Array(160);
    const prefillOutRight = new Float32Array(160);
    runBlock(dsp, prefillLeft, prefillRight, prefillOutLeft, prefillOutRight, 0, 160, [1, 7, 64, 3]);
    expect(prefillOutLeft).toEqual(prefillLeft);
    expect(prefillOutRight).toEqual(prefillRight);

    const writePositionBeforeFreeze = dsp.diagnostics.writePosition;
    dsp.setParameters({ frozen: true });
    const liveLeft = new Float32Array(640).fill(0.8);
    const liveRight = new Float32Array(640).fill(-0.7);
    const frozenOutLeft = new Float32Array(640);
    const frozenOutRight = new Float32Array(640);
    dsp.processBlock(liveLeft, liveRight, frozenOutLeft, frozenOutRight);

    expect(dsp.diagnostics).toMatchObject({
      activeCaptureLengthFrames: 160,
      activeCrossfadeFrames: 1,
      // The captured history ring is swapped out in constant time; the other
      // ring begins a fresh history generation for the next capture.
      writePosition: liveLeft.length % dsp.maxCaptureFrames,
      historyFrames: liveLeft.length,
      targetFrozen: true,
      hasFrozenBuffer: true,
    });
    expect(frozenOutLeft[80]).not.toBeCloseTo(liveLeft[80]!, 3);
    expect(frozenOutRight[80]).not.toBeCloseTo(liveRight[80]!, 3);
    // The small equal-power seam is rate-compensated, so neutral pitch retains
    // the captured 160-frame period instead of shortening the loop.
    for (let frame = 400; frame < 480; frame += 1) {
      expect(frozenOutLeft[frame]).toBeCloseTo(frozenOutLeft[frame + 160]!, 1);
      expect(frozenOutRight[frame]).toBeCloseTo(frozenOutRight[frame + 160]!, 1);
    }
    let largestStepAcrossHeldLoop = 0;
    for (let frame = 40; frame < frozenOutLeft.length; frame += 1) {
      largestStepAcrossHeldLoop = Math.max(
        largestStepAcrossHeldLoop,
        Math.abs(frozenOutLeft[frame]! - frozenOutLeft[frame - 1]!),
        Math.abs(frozenOutRight[frame]! - frozenOutRight[frame - 1]!),
      );
    }
    expect(largestStepAcrossHeldLoop).toBeLessThan(0.2);
    expect(frozenOutLeft.some((sample) => Math.abs(sample) > 0.01)).toBe(true);
    expect(dsp.diagnostics.writePosition).not.toBe(writePositionBeforeFreeze);
  });

  it('reads a wrapped capture from its ring origin instead of stale prior-generation samples', () => {
    const dsp = new BrowserFreezeDsp(8000, { captureLengthMs: 10 });
    const inputLeft = new Float32Array(dsp.maxCaptureFrames + 20);
    const inputRight = new Float32Array(inputLeft.length);
    inputLeft.fill(-0.1);
    inputRight.fill(0.1);
    inputLeft.fill(0.25, inputLeft.length - 100);
    inputRight.fill(-0.5, inputRight.length - 100);
    dsp.processBlock(inputLeft, inputRight, new Float32Array(inputLeft.length), new Float32Array(inputRight.length));
    expect(dsp.diagnostics.writePosition).toBe(20);

    dsp.setParameters({ frozen: true });
    const heldInput = new Float32Array(128);
    const heldOutputLeft = new Float32Array(heldInput.length);
    const heldOutputRight = new Float32Array(heldInput.length);
    dsp.processBlock(heldInput, heldInput, heldOutputLeft, heldOutputRight);

    for (let frame = 48; frame < heldInput.length; frame += 1) {
      if (frame >= 77 && frame <= 84) continue; // permit the one-sample loop seam overlap
      expect(heldOutputLeft[frame]).toBeCloseTo(0.25, 5);
      expect(heldOutputRight[frame]).toBeCloseTo(-0.5, 5);
    }
    expect(Math.max(...heldOutputLeft)).toBeLessThanOrEqual(0.250001);
    expect(Math.min(...heldOutputRight)).toBeGreaterThanOrEqual(-0.500001);
  });

  it('releases smoothly, records fresh history during hold, and supports another capture', () => {
    const dsp = new BrowserFreezeDsp(8000, { captureLengthMs: 20 });
    const initialLeft = new Float32Array(160).fill(0.25);
    const initialRight = new Float32Array(160).fill(-0.5);
    dsp.processBlock(initialLeft, initialRight, new Float32Array(160), new Float32Array(160));
    dsp.setParameters({ frozen: true });
    const frozenInput = new Float32Array(40).fill(0.9);
    dsp.processBlock(frozenInput, frozenInput, new Float32Array(40), new Float32Array(40));
    expect(dsp.diagnostics.activationGain).toBe(1);

    dsp.setParameters({ frozen: false });
    const releaseLeft = new Float32Array(40).fill(-0.3);
    const releaseRight = new Float32Array(40).fill(0.6);
    const releaseOutLeft = new Float32Array(40);
    const releaseOutRight = new Float32Array(40);
    dsp.processBlock(releaseLeft, releaseRight, releaseOutLeft, releaseOutRight);
    expect(releaseOutLeft[0]).not.toBeCloseTo(releaseLeft[0]!, 2);
    expect(releaseOutLeft[39]).toBeCloseTo(releaseLeft[39]!, 6);
    expect(releaseOutRight[39]).toBeCloseTo(releaseRight[39]!, 6);
    expect(dsp.isFrozen).toBe(false);
    expect(dsp.hasFrozenBuffer).toBe(false);

    // The ring recorded new live input during the prior hold and release.
    expect(dsp.diagnostics.historyFrames).toBe(80);
    dsp.setParameters({ frozen: true });
    expect(dsp.diagnostics).toMatchObject({
      targetFrozen: true,
      capturePending: true,
      hasFrozenBuffer: false,
      activeCaptureLengthFrames: 160,
      historyFrames: 80,
      writePosition: 80,
    });
    const nextFrozenInput = new Float32Array(80).fill(0.2);
    dsp.processBlock(nextFrozenInput, nextFrozenInput, new Float32Array(80), new Float32Array(80));
    expect(dsp.diagnostics).toMatchObject({
      capturePending: false,
      hasFrozenBuffer: true,
      activeCaptureLengthFrames: 160,
      historyFrames: 0,
      writePosition: 0,
    });

    dsp.setParameters({ frozen: false });
    const writePosition = dsp.diagnostics.writePosition;
    dsp.processSample(0.1, -0.1);
    expect(dsp.diagnostics.writePosition).toBe((writePosition + 1) % dsp.maxCaptureFrames);
  });

  it('finishes a release before a fast retrigger replaces the active loop', () => {
    const dsp = new BrowserFreezeDsp(8000, { captureLengthMs: 10 });
    const original = new Float32Array(80).fill(0.7);
    dsp.processBlock(original, original, new Float32Array(80), new Float32Array(80));
    dsp.setParameters({ frozen: true });
    const activate = new Float32Array(40).fill(0.15);
    dsp.processBlock(activate, activate, new Float32Array(40), new Float32Array(40));

    dsp.setParameters({ frozen: false });
    const releaseHead = new Float32Array(5).fill(0.15);
    dsp.processBlock(releaseHead, releaseHead, new Float32Array(5), new Float32Array(5));
    dsp.setParameters({ frozen: true });
    expect(dsp.diagnostics).toMatchObject({ capturePending: true, hasFrozenBuffer: true });

    const retriggerInput = new Float32Array(120).fill(0.15);
    const retriggerOutput = new Float32Array(retriggerInput.length);
    dsp.processBlock(retriggerInput, retriggerInput, retriggerOutput, new Float32Array(retriggerInput.length));
    let largestStep = 0;
    for (let frame = 1; frame < retriggerOutput.length; frame += 1) {
      const step = Math.abs(retriggerOutput[frame]! - retriggerOutput[frame - 1]!);
      largestStep = Math.max(largestStep, step);
    }
    expect(largestStep).toBeLessThan(0.03);
    expect(dsp.diagnostics).toMatchObject({ capturePending: false, hasFrozenBuffer: true });
  });

  it('applies stable varispeed pitch and clamps capture duration and pitch controls', () => {
    const sampleRate = 48000;
    const dsp = new BrowserFreezeDsp(sampleRate, { captureLengthMs: 1500 });
    const prefillLeft = new Float32Array(72000);
    const prefillRight = new Float32Array(72000);
    for (let frame = 0; frame < prefillLeft.length; frame += 1) {
      const sample = 0.4 * Math.sin((2 * Math.PI * 220 * frame) / sampleRate);
      prefillLeft[frame] = sample;
      prefillRight[frame] = sample * 0.5;
    }
    dsp.processBlock(prefillLeft, prefillRight, new Float32Array(72000), new Float32Array(72000));
    dsp.setParameters({ captureLengthMs: 1500, pitchSemitones: 12, frozen: true });
    expect(dsp.diagnostics).toMatchObject({
      activeCaptureLengthFrames: 72000,
      targetPitchSemitones: 12,
      targetFrozen: true,
    });

    const warmFrames = 6000;
    const warmInput = new Float32Array(warmFrames);
    const warmOut = new Float32Array(warmFrames);
    dsp.processBlock(warmInput, warmInput, warmOut, new Float32Array(warmFrames));
    const observeFrames = 12000;
    const observation = new Float32Array(observeFrames);
    dsp.processBlock(new Float32Array(observeFrames), new Float32Array(observeFrames), observation, new Float32Array(observeFrames));
    let positiveCrossings = 0;
    for (let frame = 1; frame < observation.length; frame += 1) {
      if ((observation[frame - 1] ?? 0) <= 0 && (observation[frame] ?? 0) > 0) positiveCrossings += 1;
    }
    const measuredPitchHz = positiveCrossings * sampleRate / observeFrames;
    expect(measuredPitchHz).toBeGreaterThan(420);
    expect(measuredPitchHz).toBeLessThan(460);

    dsp.setParameters({ captureLengthMs: 9000, pitchSemitones: 80 });
    expect(dsp.diagnostics.requestedCaptureLengthMs).toBe(2000);
    expect(dsp.diagnostics.requestedCaptureLengthFrames).toBe(sampleRate * 2);
    expect(dsp.diagnostics.targetPitchSemitones).toBe(24);
    expect(dsp.diagnostics.playbackRate).toBeLessThanOrEqual(4);
  });

  it('preserves the requested pitch across short crossfaded loop windows', () => {
    const sampleRate = 48_000;
    const captureFrames = 960;
    const captureLeft = new Float32Array(captureFrames);
    const captureRight = new Float32Array(captureFrames);
    for (let frame = 0; frame < captureFrames; frame += 1) {
      const sample = 0.4 * Math.sin((2 * Math.PI * 250 * frame) / sampleRate);
      captureLeft[frame] = sample;
      captureRight[frame] = sample * 0.5;
    }
    const dsp = new BrowserFreezeDsp(sampleRate, { captureLengthMs: 20 });
    dsp.processBlock(captureLeft, captureRight, new Float32Array(captureFrames), new Float32Array(captureFrames));
    dsp.setParameters({ frozen: true });
    const warmFrames = 4800;
    dsp.processBlock(new Float32Array(warmFrames), new Float32Array(warmFrames), new Float32Array(warmFrames), new Float32Array(warmFrames));
    const observeFrames = 12000;
    const observed = new Float32Array(observeFrames);
    dsp.processBlock(new Float32Array(observeFrames), new Float32Array(observeFrames), observed, new Float32Array(observeFrames));
    let positiveCrossings = 0;
    for (let frame = 1; frame < observed.length; frame += 1) {
      if ((observed[frame - 1] ?? 0) <= 0 && (observed[frame] ?? 0) > 0) positiveCrossings += 1;
    }
    const measuredPitchHz = positiveCrossings * sampleRate / observeFrames;
    expect(measuredPitchHz).toBeGreaterThan(240);
    expect(measuredPitchHz).toBeLessThan(260);
    expect(observed.some((sample) => Math.abs(sample) > 0.01)).toBe(true);
  });

  it('is invariant to arbitrary block segmentation and in-place channel processing', () => {
    const totalFrames = 2400;
    const inputLeft = new Float32Array(totalFrames);
    const inputRight = new Float32Array(totalFrames);
    for (let frame = 0; frame < totalFrames; frame += 1) {
      inputLeft[frame] = 0.7 * Math.sin(frame * 0.07);
      inputRight[frame] = 0.5 * Math.cos(frame * 0.037);
    }

    const render = (blockSizes: readonly number[], inPlace: boolean) => {
      const dsp = new BrowserFreezeDsp(8000, { captureLengthMs: 50 });
      const left = inPlace ? inputLeft : new Float32Array(totalFrames);
      const right = inPlace ? inputRight : new Float32Array(totalFrames);
      runBlock(dsp, inputLeft, inputRight, left, right, 0, 100, blockSizes);
      dsp.setParameters({ frozen: true, pitchSemitones: 7 });
      runBlock(dsp, inputLeft, inputRight, left, right, 100, totalFrames, blockSizes);
      return { dsp, left, right };
    };

    const whole = render([totalFrames], false);
    const segmented = render([1, 31, 128, 257, 3, 511, 17], true);
    expect(segmented.left).toEqual(whole.left);
    expect(segmented.right).toEqual(whole.right);
    expect(segmented.dsp.diagnostics).toEqual(whole.dsp.diagnostics);
  });

  it('keeps all output samples finite and bounded and resets without reallocating', () => {
    const dsp = new BrowserFreezeDsp(8000, { captureLengthMs: 2 });
    expect(dsp.diagnostics.requestedCaptureLengthFrames).toBe(16);
    const values = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e30, -1e30];
    const left = new Float32Array(100);
    const right = new Float32Array(100);
    const outputLeft = new Float32Array(100);
    const outputRight = new Float32Array(100);
    for (let frame = 0; frame < left.length; frame += 1) {
      left[frame] = values[frame % values.length]!;
      right[frame] = values[(frame + 2) % values.length]!;
    }
    dsp.processBlock(left, right, outputLeft, outputRight);
    dsp.setParameters({ frozen: true });
    expect(dsp.diagnostics.activeCaptureLengthFrames).toBe(16);
    dsp.processBlock(left, right, outputLeft, outputRight);
    expect(outputLeft.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 8)).toBe(true);
    expect(outputRight.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 8)).toBe(true);
    const storageIdentity = dsp.diagnostics.maxCaptureFrames;
    dsp.reset();
    expect(dsp.diagnostics).toMatchObject({
      hasFrozenBuffer: false,
      targetFrozen: false,
      historyFrames: 0,
      framesProcessed: 0,
      maxCaptureFrames: storageIdentity,
    });
    expect(dsp.outputLeft).toBe(0);
    expect(dsp.outputRight).toBe(0);
  });
});
