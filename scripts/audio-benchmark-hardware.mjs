#!/usr/bin/env node
// Physical RC-505mkII browser I/O baseline. This deliberately tests a Web Audio
// identity path only; its report can never pass the WebRC505 project-DSP gate.
// It requires real endpoints and never enables audio monitoring or fake devices.
import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const LOCAL_CHROMIUM = process.env.LOCALAPPDATA
  ? resolve(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe')
  : null;
const DEFAULT_BROWSER = process.env.WEBRC_CHROMIUM_PATH
  || (LOCAL_CHROMIUM && existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : chromium.executablePath());
const DEFAULT_URL = 'http://127.0.0.1:5173/';
const SAMPLE_RATE = 48000;
const PROBE_COUNT = 100;
const PROBE_AMPLITUDE = 0.01; // -40 dBFS; short, windowed 450–2,000 Hz chirp.
const PROBE_INTERVAL_MS = 300;
const MAX_ROUND_TRIP_MS = 180;
const MIN_CORRELATION = 0.35;

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const inventoryOnly = process.argv.includes('--inventory-only');
const inputSelector = getArg('--input-label', 'SUB1');
const outputSelector = getArg('--output-label', 'MAIN');
const operatorConfirmedLoopback = process.argv.includes('--confirm-physical-loopback');
const operatorLoopbackDescription = getArg('--loopback-description', '').trim();
const count = Math.max(1, Math.min(500, Number(getArg('--probes', String(PROBE_COUNT))) || PROBE_COUNT));
const url = getArg('--url', DEFAULT_URL);
const browserPath = getArg('--browser', DEFAULT_BROWSER);
const outputBase = resolve(getArg('--out', resolve(tmpdir(), 'webrc-audio-benchmark', `rc505-bypass-${Date.now()}.json`)));
const probeAmplitude = Number(getArg('--amplitude', String(PROBE_AMPLITUDE)));
if (!Number.isFinite(probeAmplitude) || probeAmplitude <= 0 || probeAmplitude > 0.05) {
  throw new RangeError('--amplitude must be greater than 0 and at most 0.05 full scale');
}
if (operatorConfirmedLoopback && !operatorLoopbackDescription) {
  throw new Error('--confirm-physical-loopback requires --loopback-description describing the currently connected analog path');
}
const tracePath = outputBase.replace(/\.json$/i, '.trace.json');
const inventoryPath = outputBase.replace(/\.json$/i, '.inventory.json');
const failurePath = outputBase.replace(/\.json$/i, '.failure.json');

const browser = await chromium.launch({
  executablePath: browserPath,
  headless: !process.argv.includes('--headed'),
  // Playwright adds --mute-audio to headless Chromium by default. That would
  // make every physical DAC probe a false negative, so remove and verify it.
  ignoreDefaultArgs: ['--mute-audio'],
  args: [
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
  ],
});

let context;
try {
  context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();
  const commandLineSession = await context.newCDPSession(page);
  const commandLineResponse = await commandLineSession.send('Browser.getBrowserCommandLine');
  const actualBrowserArgs = commandLineResponse.arguments.filter((arg) => !arg.startsWith('--remote-debugging-port='));
  if (actualBrowserArgs.some((arg) => arg === '--mute-audio' || arg.startsWith('--use-fake-device-for-media-stream'))) {
    throw new Error(`Refusing physical probes with muted audio or a fake device: ${actualBrowserArgs.join(' ')}`);
  }
  await commandLineSession.detach();
  page.setDefaultTimeout(15000);
  // Keep media permissions and COOP/COEP from the real Vite origin while
  // preventing the product App and its native bridge from starting audio.
  await page.route('**/src/main.ts*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  page.on('console', (message) => {
    if (message.type() === 'error') process.stderr.write(`[browser] ${message.text()}\n`);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Grant labels through a real capture permission, stop that temporary stream,
  // and inspect physical devices. No output is opened during inventory.
  const inventory = await page.evaluate(async () => {
    const temporary = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    temporary.getTracks().forEach((track) => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput' || device.kind === 'audiooutput')
      .map((device) => ({ kind: device.kind, id: device.deviceId, label: device.label }));
  });
  await mkdir(dirname(outputBase), { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify({ schema: 'webrc.audio-device-inventory', schemaVersion: 1, capturedAt: new Date().toISOString(), devices: inventory }, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ phase: 'device-inventory', devices: inventory }, null, 2)}\n`);

  if (inventoryOnly) process.exitCode = 0;
  else {
    const inputMatches = inventory.filter((device) => device.kind === 'audioinput'
      && device.id !== 'default'
      && device.id !== 'communications'
      && device.label.toLowerCase().includes(inputSelector.toLowerCase())
      && device.label.toLowerCase().includes('rc-505'));
    const outputMatches = inventory.filter((device) => device.kind === 'audiooutput'
      && device.label.toLowerCase().includes(outputSelector.toLowerCase())
      && device.label.toLowerCase().includes('rc-505'));
    if (inputMatches.length !== 1 || outputMatches.length !== 1) {
      const failure = {
        schema: 'webrc.audio-benchmark-failure', schemaVersion: 1,
        phase: 'endpoint-selection', capturedAt: new Date().toISOString(),
        inputSelector, outputSelector, inputMatches, outputMatches, inventoryPath,
        reason: 'No unique requested RC-505 capture/render endpoint pair; no probe signal was sent.',
      };
      await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
      throw new Error(`Refusing to guess a physical endpoint: input matches=${inputMatches.length}, MAIN/RC-505 output matches=${outputMatches.length}. No probe was sent. Inventory: ${inventoryPath}; failure: ${failurePath}`);
    }
    const input = inputMatches[0];
    const output = outputMatches[0];
    const physicalCaptureRouteConfigured = input.label.toLowerCase().includes('sub1')
      && output.label.toLowerCase().includes('main');
    const capture = await page.evaluate(async ({ inputId, outputId, expectedCount, intervalMs, maxRoundTripMs, minimumCorrelation, amplitude }) => {
      const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      if (context.sampleRate !== 48000) {
        await context.close();
        throw new Error(`Expected a 48000 Hz Web Audio graph, got ${context.sampleRate} Hz`);
      }
      if (typeof context.setSinkId !== 'function') {
        await context.close();
        throw new Error('AudioContext.setSinkId is unavailable; refusing to use the system default output');
      }
      await context.setSinkId(outputId);
      if (context.sinkId && context.sinkId !== outputId) {
        await context.close();
        throw new Error('The browser did not select the requested RC-505 output endpoint');
      }
      await context.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: inputId },
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48000 },
          latency: { ideal: 128 / 48000 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings() ?? {};
      const supportedCaptureConstraints = navigator.mediaDevices.getSupportedConstraints();
      if (!track || settings.deviceId !== inputId) {
        stream.getTracks().forEach((item) => item.stop());
        await context.close();
        throw new Error('The browser did not open the exact selected RC-505mkII capture endpoint');
      }

      const processorSource = `class CaptureOnlyProcessor extends AudioWorkletProcessor {
        constructor() { super(); this.port.onmessage = () => {}; }
        process(inputs, outputs) {
          const input = inputs[0] ?? [];
          const output = outputs[0] ?? [];
          for (const channel of output) channel.fill(0);
          if (input.length) {
            const channels = input.map((channel) => channel.slice());
            this.port.postMessage({ frame: currentFrame, channels }, channels.map((channel) => channel.buffer));
          }
          return true;
        }
      }
      registerProcessor('rc505-capture-only', CaptureOnlyProcessor);`;
      const moduleUrl = URL.createObjectURL(new Blob([processorSource], { type: 'text/javascript' }));
      await context.audioWorklet.addModule(moduleUrl);
      URL.revokeObjectURL(moduleUrl);

      const source = context.createMediaStreamSource(stream);
      const captureNode = new AudioWorkletNode(context, 'rc505-capture-only', {
        numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2],
      });
      const silent = context.createGain();
      silent.gain.value = 0;
      source.connect(captureNode);
      captureNode.connect(silent);
      silent.connect(context.destination);

      const ringLength = context.sampleRate * 2;
      const ringByChannel = [];
      const frameTags = new Float64Array(ringLength);
      frameTags.fill(-1);
      const quantumHistogram = new Map();
      let capturedFrames = 0;
      const capturedFramesByChannel = [];
      captureNode.port.onmessage = ({ data }) => {
        const channels = data.channels;
        const frame = data.frame;
        if (!Array.isArray(channels) || channels.some((samples) => !(samples instanceof Float32Array)) || !Number.isSafeInteger(frame)) return;
        const quantumFrames = channels[0]?.length ?? 0;
        if (quantumFrames === 0 || channels.some((samples) => samples.length !== quantumFrames)) return;
        quantumHistogram.set(quantumFrames, (quantumHistogram.get(quantumFrames) ?? 0) + 1);
        capturedFrames += quantumFrames;
        for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
          const samples = channels[channelIndex];
          if (!ringByChannel[channelIndex]) ringByChannel[channelIndex] = new Float32Array(ringLength);
          capturedFramesByChannel[channelIndex] = (capturedFramesByChannel[channelIndex] ?? 0) + samples.length;
          for (let index = 0; index < samples.length; index += 1) {
            const absoluteFrame = frame + index;
            const ringIndex = absoluteFrame % ringLength;
            ringByChannel[channelIndex][ringIndex] = samples[index];
            frameTags[ringIndex] = absoluteFrame;
          }
        }
      };

      const pulseLength = Math.round(context.sampleRate * 0.01);
      const pulse = context.createBuffer(1, pulseLength, context.sampleRate);
      const template = pulse.getChannelData(0);
      for (let index = 0; index < pulseLength; index += 1) {
        const progress = index / Math.max(1, pulseLength - 1);
        const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * progress);
        const cycles = 450 * progress + (2000 - 450) * progress * progress / 2;
        template[index] = Math.sin(2 * Math.PI * cycles * pulseLength / context.sampleRate) * amplitude * window;
      }
      const templateEnergy = template.reduce((sum, value) => sum + value * value, 0);
      const maxLagFrames = Math.round(context.sampleRate * maxRoundTripMs / 1000);

      const correlate = (scheduledFrame, channelIndex) => {
        let best = { lag: null, coefficient: 0, inputRms: null, inputEnergy: null };
        const step = 2;
        for (let lag = 0; lag <= maxLagFrames; lag += step) {
          let dot = 0;
          let energy = 0;
          let complete = true;
          for (let index = 0; index < template.length; index += 1) {
            const absoluteFrame = scheduledFrame + lag + index;
            const ringIndex = absoluteFrame % ringLength;
            if (frameTags[ringIndex] !== absoluteFrame) { complete = false; break; }
            const sample = ringByChannel[channelIndex]?.[ringIndex];
            dot += sample * template[index];
            energy += sample * sample;
          }
          if (!complete) continue;
          const inputRms = Math.sqrt(energy / template.length);
          if (energy < 1e-12) {
            if (inputRms > (best.inputRms ?? -1)) best = { ...best, inputRms, inputEnergy: energy };
            continue;
          }
          const coefficient = Math.abs(dot) / Math.sqrt(templateEnergy * energy);
          if (coefficient > best.coefficient) best = { lag, coefficient, inputRms, inputEnergy: energy };
        }
        // Refine around the best even-sample lag.
        if (best.lag !== null) {
          const center = best.lag;
          for (let lag = Math.max(0, center - 1); lag <= Math.min(maxLagFrames, center + 1); lag += 1) {
            let dot = 0;
            let energy = 0;
            let complete = true;
            for (let index = 0; index < template.length; index += 1) {
              const absoluteFrame = scheduledFrame + lag + index;
              const ringIndex = absoluteFrame % ringLength;
              if (frameTags[ringIndex] !== absoluteFrame) { complete = false; break; }
              const sample = ringByChannel[channelIndex]?.[ringIndex];
              dot += sample * template[index];
              energy += sample * sample;
            }
            if (!complete) continue;
            const inputRms = Math.sqrt(energy / template.length);
            if (energy < 1e-12) {
              if (inputRms > (best.inputRms ?? -1)) best = { ...best, inputRms, inputEnergy: energy };
              continue;
            }
            const coefficient = Math.abs(dot) / Math.sqrt(templateEnergy * energy);
            if (coefficient > best.coefficient) best = { lag, coefficient, inputRms, inputEnergy: energy };
          }
        }
        return best;
      };

      const probes = [];
      const measurementStartedAt = new Date().toISOString();
      const outputTimestampBefore = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : null;
      for (let index = 0; index < expectedCount; index += 1) {
        const startTime = context.currentTime + 0.05;
        const scheduledFrame = Math.round(startTime * context.sampleRate);
        const player = context.createBufferSource();
        player.buffer = pulse;
        player.connect(context.destination);
        player.start(startTime);
        player.stop(startTime + pulse.duration);
        await new Promise((resolve) => setTimeout(resolve, intervalMs - 45));
        const channelCorrelations = ringByChannel.map((_ring, channelIndex) => correlate(scheduledFrame, channelIndex));
        const bestChannelIndex = channelCorrelations.reduce((bestIndex, current, index) => (
          current.coefficient > (channelCorrelations[bestIndex]?.coefficient ?? -1) ? index : bestIndex
        ), 0);
        const correlation = channelCorrelations[bestChannelIndex] ?? { lag: null, coefficient: 0, inputRms: null, inputEnergy: null };
        const acceptedChannels = channelCorrelations.map((item) => item.lag !== null && item.coefficient >= minimumCorrelation);
        const accepted = acceptedChannels.some(Boolean);
        probes.push({
          index,
          scheduledFrame,
          actualInputChannels: channelCorrelations.length,
          channelCorrelations: channelCorrelations.map((item, channelIndex) => ({
            channelIndex,
            channelName: channelIndex === 0 ? 'left/index-0' : channelIndex === 1 ? 'right/index-1' : `channel-${channelIndex}`,
            capturedFrame: item.lag === null || !acceptedChannels[channelIndex] ? null : scheduledFrame + item.lag,
            latencyFrames: item.lag === null || !acceptedChannels[channelIndex] ? null : item.lag,
            latencyMs: item.lag === null || !acceptedChannels[channelIndex] ? null : item.lag * 1000 / context.sampleRate,
            correlation: Number(item.coefficient.toFixed(5)),
            inputWindowRms: item.inputRms,
            inputWindowEnergy: item.inputEnergy,
            accepted: acceptedChannels[channelIndex],
          })),
          bestChannelIndex,
          capturedFrame: accepted ? scheduledFrame + correlation.lag : null,
          latencyFrames: accepted ? correlation.lag : null,
          latencyMs: accepted ? correlation.lag * 1000 / context.sampleRate : null,
          correlation: Number(correlation.coefficient.toFixed(5)),
          inputWindowRms: correlation.inputRms,
          inputWindowEnergy: correlation.inputEnergy,
          accepted,
          rejection: accepted ? null : (correlation.lag === null ? 'no captured samples in search window' : `correlation below ${minimumCorrelation}`),
        });
        player.disconnect();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const measurementEndedAt = new Date().toISOString();
      const outputTimestampAfter = typeof context.getOutputTimestamp === 'function' ? context.getOutputTimestamp() : null;
      const result = {
        contextStateAtCapture: context.state,
        graphSampleRateHz: context.sampleRate,
        contextBaseLatencySeconds: context.baseLatency,
        contextOutputLatencySeconds: typeof context.outputLatency === 'number' ? context.outputLatency : null,
        outputTimestampBefore,
        outputTimestampAfter,
        measurementStartedAt,
        measurementEndedAt,
        durationSeconds: (Date.parse(measurementEndedAt) - Date.parse(measurementStartedAt)) / 1000,
        inputSettings: settings,
        requestedCaptureConstraints: {
          channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 }, latency: { ideal: 128 / 48000 },
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        },
        supportedCaptureConstraints,
        selectedOutputSinkId: context.sinkId ?? outputId,
        outputMonitorEnabled: false,
        captureWorkletQuantumHistogram: Object.fromEntries(quantumHistogram),
        dominantQuantumFrames: [...quantumHistogram.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        capturedFrames,
        capturedFramesByChannel,
        probes,
      };
      captureNode.disconnect();
      source.disconnect();
      silent.disconnect();
      stream.getTracks().forEach((item) => item.stop());
      await context.close();
      return result;
    }, {
      inputId: input.id,
      outputId: output.id,
      expectedCount: count,
      intervalMs: PROBE_INTERVAL_MS,
      maxRoundTripMs: MAX_ROUND_TRIP_MS,
      minimumCorrelation: MIN_CORRELATION,
      amplitude: probeAmplitude,
    });

    const accepted = capture.probes.filter((probe) => probe.accepted);
    const delays = accepted.map((probe) => probe.latencyMs).sort((a, b) => a - b);
    const measuredAt = capture.measurementEndedAt;
    const runId = `rc505-bypass-${Date.now()}`;
    const hasRtl = accepted.length >= 10;
    const captureRate = Number(capture.inputSettings.sampleRate) || 44100;
    // Endpoint names and a correlated signal cannot distinguish an analog
    // return from a digital/internal route. Require an explicit, per-run
    // operator assertion about the currently connected cable path as well.
    const physicalLoopbackConfirmed = operatorConfirmedLoopback
      && Boolean(operatorLoopbackDescription)
      && physicalCaptureRouteConfigured
      && hasRtl;
    const report = {
      schema: 'webrc.instrument-grade-audio',
      schemaVersion: 1,
      reportId: runId,
      run: {
        startedAt: capture.measurementStartedAt,
        endedAt: capture.measurementEndedAt,
        durationSeconds: capture.durationSeconds,
        gateVersion: 'instrument-grade-gate/1.0.0',
        systemUnderTest: 'web-audio-bypass-baseline',
        assertionVersions: {
          physicalHarness: 'audio-benchmark-hardware/1.0.0',
          probe: 'windowed-chirp-correlation/1.0.0',
          hardwareClock: 'RC-505mkII USB interface clock 44100 Hz; capture getSettings is recorded separately',
          routeConfirmation: 'operator-flag-plus-current-endpoint-match/1.0.0',
          confirmedRouting: operatorConfirmedLoopback ? operatorLoopbackDescription : 'not confirmed for this run',
        },
      },
      hardware: {
        inputDevice: { id: input.id, label: input.label },
        outputDevice: { id: output.id, label: output.label },
        hardwareSampleRateHz: 44100,
        processingSampleRateHz: capture.graphSampleRateHz,
        renderQuantumFrames: capture.dominantQuantumFrames,
      },
      pathEvidence: {
        physicalLoopbackConfirmed,
        loopbackDescription: operatorConfirmedLoopback
          ? `Operator-confirmed current analog path: ${operatorLoopbackDescription}. Selected capture: ${input.label}; selected render: ${output.label}; endpoint roles must match SUB1 capture and MAIN render. This report exercises a Web Audio identity bypass baseline only.`
          : `No current physical loopback confirmation was supplied. Selected capture: ${input.label}; selected render: ${output.label}. Endpoint names or correlation alone do not prove an analog route. This report exercises a Web Audio identity bypass baseline only.`,
        loopbackEvidenceRef: basename(tracePath),
        independentInputAnchorRef: null,
        independentOutputAnchorRef: null,
        adcToBrowserEvidenceRef: physicalLoopbackConfirmed ? basename(tracePath) : null,
        browserToDspEvidenceRef: 'identity-bypass-only; not WebRC505 project DSP',
        dspToDacEvidenceRef: basename(tracePath),
        dacToAdcEvidenceRef: physicalLoopbackConfirmed ? basename(tracePath) : null,
      },
      metrics: {
        hardwareRtl: physicalLoopbackConfirmed ? distribution(delays, 'physical-loopback', capture.graphSampleRateHz, `${input.label} → AudioContext → ${output.label}`, basename(tracePath), measuredAt) : unknownDistribution(),
        input: unknownDistribution(),
        output: unknownDistribution(),
        jitter: physicalLoopbackConfirmed ? scalar(reportJitter(delays), 'ms', 'physical-loopback', delays.length, capture.graphSampleRateHz, `${input.label} → AudioContext → ${output.label}`, basename(tracePath), measuredAt) : unknownScalar('ms'),
        trigger: unknownDistribution(),
        triggerByAction: { REC: unknownDistribution(), PLAY: unknownDistribution(), STOP: unknownDistribution(), FX: unknownDistribution() },
        overdubAlignment: unknownDistribution(),
        renderQuantum: scalar(capture.dominantQuantumFrames, 'frames', 'software-diagnostic', capture.capturedFrames / Math.max(1, capture.dominantQuantumFrames ?? 128), capture.graphSampleRateHz, 'Web Audio capture worklet', basename(tracePath), measuredAt),
        fxLatency: [],
        callback: unknownDistribution(),
        xrun: unknownXrun(),
        loopDrift: unknownDrift(),
      },
      software: { runtimeSnapshot: null, callback96kProfile: null },
    };
    const trace = {
      schema: 'webrc.instrument-grade-trace',
      schemaVersion: 1,
      reportId: runId,
      method: {
        probeWaveform: '10 ms Hann-windowed 450–2000 Hz linear chirp',
        amplitudePeak: probeAmplitude,
        requestedProcessingRateHz: SAMPLE_RATE,
        matchedFilter: 'absolute normalized correlation; even-frame sweep plus ±1-frame refinement',
        minimumCorrelation: MIN_CORRELATION,
        maxSearchMs: MAX_ROUND_TRIP_MS,
        monitoring: 'disabled; capture worklet writes zero output; capture stream never connects to audible output',
        browserArguments: actualBrowserArgs,
        browserExecutable: browserPath,
        headless: !process.argv.includes('--headed'),
        selectedCapture: input,
        selectedRender: output,
        captureSettings: capture.inputSettings,
        requestedCaptureConstraints: capture.requestedCaptureConstraints,
        supportedCaptureConstraints: capture.supportedCaptureConstraints,
        selectedOutputSinkId: capture.selectedOutputSinkId,
        contextStateAtCapture: capture.contextStateAtCapture,
        contextBaseLatencySeconds: capture.contextBaseLatencySeconds,
        contextOutputLatencySeconds: capture.contextOutputLatencySeconds,
        outputTimestampBefore: capture.outputTimestampBefore,
        outputTimestampAfter: capture.outputTimestampAfter,
        graphSampleRateHz: capture.graphSampleRateHz,
        quantumHistogram: capture.captureWorkletQuantumHistogram,
        capturedFrames: capture.capturedFrames,
      },
      requestedProbeCount: count,
      matchedProbeCount: accepted.length,
        delaysMs: delays,
        inputWindowRms: capture.probes.map((probe) => probe.inputWindowRms),
      probes: capture.probes,
    };

    if (accepted.length < 10) {
      process.stderr.write(`Only ${accepted.length}/${count} probes met correlation ${MIN_CORRELATION}; Hardware RTL stays UNKNOWN. Check endpoint and analog path.\n`);
    }
    await mkdir(dirname(outputBase), { recursive: true });
    await writeFile(outputBase, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ phase: 'measurement-complete', reportPath: outputBase, tracePath, matched: accepted.length, requested: count, rtlMs: hasRtl ? { p50: report.metrics.hardwareRtl.p50, p95: report.metrics.hardwareRtl.p95, p99: report.metrics.hardwareRtl.p99, max: report.metrics.hardwareRtl.max } : null, sampleRate: capture.graphSampleRateHz, captureRate, hardwareRate: report.hardware.hardwareSampleRateHz, quantumFrames: capture.dominantQuantumFrames, systemUnderTest: report.run.systemUnderTest }, null, 2)}\n`);
  }
} finally {
  if (context) await context.close().catch(() => {});
  await browser.close();
}

function quantile(sortedValues, probability) {
  if (sortedValues.length === 0) return null;
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
}

function reportJitter(sortedLatencies) {
  const p50 = quantile(sortedLatencies, 0.5);
  const p95 = quantile(sortedLatencies, 0.95);
  return p50 === null || p95 === null ? null : p95 - p50;
}

function distribution(values, provenance, sampleRateHz, device, evidenceRef, measuredAt) {
  return {
    unit: 'ms',
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
    max: values.at(-1),
    maxAbs: Math.max(...values.map((value) => Math.abs(value))),
    provenance,
    sampleCount: values.length,
    measuredAt,
    device,
    sampleRateHz,
    evidenceRef,
    anchorRef: null,
  };
}

function scalar(value, unit, provenance, sampleCount, sampleRateHz, device, evidenceRef, measuredAt) {
  return {
    unit,
    value: value ?? null,
    provenance: value === null ? 'unknown' : provenance,
    sampleCount: value === null ? 0 : Math.max(1, Math.floor(sampleCount)),
    measuredAt: value === null ? null : measuredAt,
    device: value === null ? null : device,
    sampleRateHz: value === null ? null : sampleRateHz,
    evidenceRef: value === null ? null : evidenceRef,
    anchorRef: null,
  };
}

function unknownDistribution() {
  return {
    unit: 'ms', p50: null, p95: null, p99: null, max: null, maxAbs: null,
    provenance: 'unknown', sampleCount: 0, measuredAt: null, device: null, sampleRateHz: null, evidenceRef: null, anchorRef: null,
  };
}

function unknownScalar(unit) {
  return {
    unit, value: null, provenance: 'unknown', sampleCount: 0,
    measuredAt: null, device: null, sampleRateHz: null, evidenceRef: null, anchorRef: null,
  };
}

function unknownXrun() {
  return {
    ...scalar(null, 'count', 'unknown', 0, null, null, null, null),
    coverageSeconds: null,
    coverageScope: 'unknown',
    callbackDeadlineMs: null,
    physicalSampleMarkerContinuous: null,
    hardwareDropoutEvidenceRef: null,
  };
}

function unknownDrift() {
  return {
    unit: 'ms', maxAbs: null, slopeMsPerMinute: null, nonAccumulating: null,
    provenance: 'unknown', sampleCount: 0, measuredAt: null, device: null, sampleRateHz: null, evidenceRef: null, anchorRef: null,
  };
}
