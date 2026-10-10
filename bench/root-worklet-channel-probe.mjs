import { chromium } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const output = process.argv[2];
const executable = process.argv[3] || chromium.executablePath();
assert.ok(output, 'Pass an output JSON path.');
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><title>Offline channel probe</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: executable });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const cases = await page.evaluate(async () => {
    const results = [];
    for (const mode of ['explicit', 'clamped-max']) {
      for (const sourceChannels of [1, 2]) {
        const context = new OfflineAudioContext(2, 256, 48000);
        const code = `class ChannelProbe extends AudioWorkletProcessor {
          process(inputs, outputs) {
            if (!this.sent) { this.sent = true; this.port.postMessage({
              channels: inputs[0].length,
              firstSamples: inputs[0].map(channel => channel[0])
            }); }
            for (const plane of outputs[0]) plane.fill(0);
            return true;
          }
        } registerProcessor('channel-probe', ChannelProbe);`;
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        await context.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(context, 'channel-probe', {
          numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: mode, channelInterpretation: 'discrete',
        });
        const observed = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('No Worklet channel observation')), 5000);
          node.port.onmessage = event => { clearTimeout(timer); resolve(event.data); };
        });
        const buffer = context.createBuffer(sourceChannels, 256, 48000);
        buffer.getChannelData(0).fill(.25);
        if (sourceChannels === 2) buffer.getChannelData(1).fill(-.5);
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(node); node.connect(context.destination); source.start();
        await context.startRendering();
        results.push({ mode, sourceChannels, sourceChannelCountProperty: source.channelCount,
          observed: await observed });
      }
    }
    return results;
  });
  for (const test of cases) {
    assert.equal(test.observed.channels, test.mode === 'explicit' ? 2 : test.sourceChannels);
    assert.equal(test.observed.firstSamples[0], .25);
    if (test.sourceChannels === 2) assert.equal(test.observed.firstSamples[1], -.5);
    else if (test.mode === 'explicit') assert.equal(test.observed.firstSamples[1], 0);
  }
  const report = { scope: 'Actual Chromium OfflineAudioContext/AudioWorklet channel negotiation; not production graph or realtime performance proof',
    browserVersion: browser.version(), executable,
    executableSha256: crypto.createHash('sha256').update(await fs.readFile(executable)).digest('hex'),
    cases, pass: true };
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
