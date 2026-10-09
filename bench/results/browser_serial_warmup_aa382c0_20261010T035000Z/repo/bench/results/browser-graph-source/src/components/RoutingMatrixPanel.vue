<template>
  <section class="routing-matrix" aria-label="Audio routing matrix">
    <header class="panel-heading">
      <div><p class="eyebrow">BROWSER AUDIO GRAPH</p><h3>Input channels and sends</h3></div>
      <span class="graph-state" :class="{ ready }">{{ ready ? 'ENGINE READY' : 'ENGINE NOT READY' }}</span>
    </header>
    <p v-if="error" class="routing-error" role="alert">{{ error }}</p>
    <p v-if="!ready" class="routing-note">Initialize browser audio to inspect and change live routes.</p>
    <p v-else-if="!state?.inputChannels.length" class="routing-note">No live input channels are available. Select an input device and allow capture access to create routes.</p>

    <template v-if="ready && state">
      <section class="channel-list" aria-label="Available input channels">
        <details v-for="(channel, index) in state.inputChannels" :key="channelKey(channel)" class="channel-card" :open="index === 0">
          <summary><span>{{ sourceLabel(channel.sourceId) }} · CH {{ channel.sourceChannel + 1 }}</span><span class="channel-kind">{{ sourceKind(channel.sourceId) }}</span></summary>
          <div class="channel-controls">
            <fieldset class="eq-controls" :disabled="busy">
              <legend>CHANNEL EQ</legend>
              <label class="check-row"><input type="checkbox" :checked="channel.eq.enabled" @change="setEq(channel, { enabled: checked($event) })"> Enable input EQ</label>
              <label>LOW CUT · Hz <input type="number" min="20" max="20000" step="1" :value="channel.eq.lowCutHz" :disabled="busy || !channel.eq.enabled" @change="setEq(channel, { lowCutHz: numberValue($event) })"></label>
              <label>HIGH CUT · Hz <input type="number" min="20" max="20000" step="1" :value="channel.eq.highCutHz" :disabled="busy || !channel.eq.enabled" @change="setEq(channel, { highCutHz: numberValue($event) })"></label>
              <label>GAIN · dB <input type="number" min="-24" max="24" step="0.5" :value="channel.eq.gainDb" :disabled="busy || !channel.eq.enabled" @change="setEq(channel, { gainDb: numberValue($event) })"></label>
            </fieldset>
            <fieldset class="track-sends" :disabled="busy">
              <legend>TRACK INPUTS</legend>
              <div v-for="send in routeFor(channel)?.tracks ?? []" :key="send.trackId" class="send-row">
                <span>TRACK {{ send.trackId }}</span>
                <input type="range" min="0" max="2" step="0.01" :value="send.gain" :aria-label="'Track ' + send.trackId + ' input gain for ' + channelLabel(channel)" @change="setTrackGain(channel, send.trackId, numberValue($event))">
                <output>{{ send.gain.toFixed(2) }}</output>
                <select :value="send.targetChannel" :aria-label="'Track ' + send.trackId + ' input destination for ' + channelLabel(channel)" @change="setTrackTarget(channel, send.trackId, $event)">
                  <option value="left">LEFT</option><option value="right">RIGHT</option><option value="both">BOTH</option>
                </select>
              </div>
              <p v-if="isRhythmRoutedToTracks(channel)" class="latency-note">RHYTHM CAPTURE ROUTE ADDS 2.67 MS TO PREVENT FEEDBACK.</p>
            </fieldset>
            <fieldset class="bus-sends" :disabled="busy">
              <legend>OUTPUT BUSES</legend>
              <div v-for="bus in buses" :key="bus" class="send-row">
                <span>{{ bus.toUpperCase() }}</span>
                <input type="range" min="0" max="2" step="0.01" :value="routeGain(channel, bus)" :aria-label="bus + ' output gain for ' + channelLabel(channel)" @change="setBusGain(channel, bus, numberValue($event))">
                <output>{{ routeGain(channel, bus).toFixed(2) }}</output>
                <select :value="routeTarget(channel, bus)" :aria-label="bus + ' output destination for ' + channelLabel(channel)" @change="setBusTarget(channel, bus, $event)">
                  <option value="left">LEFT</option><option value="right">RIGHT</option><option value="both">BOTH</option>
                </select>
              </div>
            </fieldset>
          </div>
        </details>
      </section>
      <section class="outputs-panel" aria-label="Physical output routing">
        <h4>Output devices</h4>
        <div v-for="bus in buses" :key="bus" class="output-row">
          <label class="check-row"><input type="checkbox" :checked="state.outputs[bus].enabled" :disabled="busy || !state.outputs[bus].available" @change="updateOutput(bus, { enabled: checked($event) })"> {{ bus.toUpperCase() }} OUTPUT</label>
          <select :value="state.outputs[bus].sinkId ?? ''" :disabled="busy || !state.outputs[bus].available || !state.outputs[bus].availableSinks.length" :aria-label="bus + ' output device'" @change="updateOutput(bus, { sinkId: selectValue($event) || null })">
            <option value="">DEFAULT OUTPUT</option><option v-for="sink in state.outputs[bus].availableSinks" :key="sink.id" :value="sink.id">{{ sink.label }}</option>
          </select>
          <span class="availability">{{ state.outputs[bus].available ? 'AVAILABLE' : 'UNAVAILABLE' }}</span>
        </div>
      </section>
    </template>
    <footer class="routing-footer">All changes are sent to the live browser graph and displayed after its update completes.</footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { AudioEngine } from '../audio/AudioEngine';
import type { BrowserRoutingBus, BrowserRoutingChannelTarget, BrowserRoutingInputChannel, BrowserRoutingOutput, BrowserRoutingRoute, BrowserRoutingState } from '../audio/browserRouting';

const engine = AudioEngine.getInstance();
const buses: readonly BrowserRoutingBus[] = ['main', 'sub', 'headphones'];
const state = ref<BrowserRoutingState | null>(null);
const ready = ref(false);
const busy = ref(false);
const error = ref('');
let unsubscribeState: (() => void) | null = null;
let unsubscribeStatus: (() => void) | null = null;

const routingApi = computed(() => engine.getMode() === 'browser' && typeof engine.getRoutingState === 'function'
  && typeof engine.updateRoutingState === 'function' && typeof engine.subscribeRoutingState === 'function');

onMounted(() => {
  syncReady();
  unsubscribeStatus = engine.onStatusChange(() => syncReady());
});
onUnmounted(() => { unsubscribeState?.(); unsubscribeStatus?.(); });

function syncReady() {
  const nextReady = routingApi.value && engine.getUiStatus().ready;
  if (nextReady === ready.value && Boolean(unsubscribeState) === nextReady) return;
  unsubscribeState?.();
  unsubscribeState = null;
  ready.value = nextReady;
  state.value = null;
  if (!nextReady) return;
  try {
    state.value = engine.getRoutingState();
    unsubscribeState = engine.subscribeRoutingState((next) => { state.value = next; });
    error.value = '';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

function channelKey(channel: BrowserRoutingInputChannel) { return channel.sourceId + ':' + channel.sourceChannel; }
function channelLabel(channel: BrowserRoutingInputChannel) { return sourceLabel(channel.sourceId) + ' CH ' + (channel.sourceChannel + 1); }
function sourceFor(sourceId: string) { return state.value?.sources.find((source) => source.id === sourceId); }
function sourceLabel(sourceId: string) { return sourceFor(sourceId)?.label ?? sourceId; }
function sourceKind(sourceId: string) { return sourceFor(sourceId)?.kind === 'rhythm' ? 'SYNTH' : 'CAPTURE'; }
function routeFor(channel: BrowserRoutingInputChannel): BrowserRoutingRoute | undefined {
  return state.value?.routes.find((route) => route.sourceId === channel.sourceId && route.sourceChannel === channel.sourceChannel);
}
function isRhythmRoutedToTracks(channel: BrowserRoutingInputChannel) {
  return sourceFor(channel.sourceId)?.kind === 'rhythm' && (routeFor(channel)?.tracks.some((send) => send.gain > 0) ?? false);
}
function routeGain(channel: BrowserRoutingInputChannel, bus: BrowserRoutingBus) {
  const route = routeFor(channel);
  return bus === 'main' ? route?.mainGain ?? 0 : bus === 'sub' ? route?.subGain ?? 0 : route?.headphonesGain ?? 0;
}
function routeTarget(channel: BrowserRoutingInputChannel, bus: BrowserRoutingBus): BrowserRoutingChannelTarget {
  const route = routeFor(channel);
  return bus === 'main' ? route?.mainTargetChannel ?? 'both'
    : bus === 'sub' ? route?.subTargetChannel ?? 'both' : route?.headphonesTargetChannel ?? 'both';
}

async function submit(update: (snapshot: BrowserRoutingState) => void) {
  if (!ready.value || !state.value || busy.value) return;
  const next = structuredClone(state.value);
  update(next);
  busy.value = true;
  error.value = '';
  try {
    await engine.updateRoutingState({ inputChannels: next.inputChannels, routes: next.routes, outputs: next.outputs });
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}

function setEq(channel: BrowserRoutingInputChannel, patch: Partial<BrowserRoutingInputChannel['eq']>) {
  void submit((next) => {
    const target = next.inputChannels.find((entry) => channelKey(entry) === channelKey(channel));
    if (target) target.eq = { ...target.eq, ...patch };
  });
}
function setTrackGain(channel: BrowserRoutingInputChannel, trackId: number, gain: number) {
  void submit((next) => {
    const send = next.routes.find((route) => route.sourceId === channel.sourceId && route.sourceChannel === channel.sourceChannel)?.tracks.find((entry) => entry.trackId === trackId);
    if (send) send.gain = clamp(gain, 0, 2);
  });
}
function setTrackTarget(channel: BrowserRoutingInputChannel, trackId: number, event: Event) {
  const targetChannel = selectValue(event) as BrowserRoutingChannelTarget;
  void submit((next) => {
    const send = next.routes.find((route) => route.sourceId === channel.sourceId && route.sourceChannel === channel.sourceChannel)?.tracks.find((entry) => entry.trackId === trackId);
    if (send) send.targetChannel = targetChannel;
  });
}
function setBusGain(channel: BrowserRoutingInputChannel, bus: BrowserRoutingBus, gain: number) {
  void updateRoute(channel, bus === 'main' ? { mainGain: gain } : bus === 'sub' ? { subGain: gain } : { headphonesGain: gain });
}
function setBusTarget(channel: BrowserRoutingInputChannel, bus: BrowserRoutingBus, event: Event) {
  const targetChannel = selectValue(event) as BrowserRoutingChannelTarget;
  void updateRoute(channel, bus === 'main' ? { mainTargetChannel: targetChannel }
    : bus === 'sub' ? { subTargetChannel: targetChannel } : { headphonesTargetChannel: targetChannel });
}
async function updateRoute(channel: BrowserRoutingInputChannel, patch: Partial<BrowserRoutingRoute>) {
  await submit((next) => {
    const route = next.routes.find((entry) => entry.sourceId === channel.sourceId && entry.sourceChannel === channel.sourceChannel);
    if (route) Object.assign(route, patch);
  });
}
function updateOutput(bus: BrowserRoutingBus, patch: Partial<BrowserRoutingOutput>) {
  void submit((next) => { next.outputs[bus] = { ...next.outputs[bus], ...patch }; });
}
function numberValue(event: Event) { return Number((event.target as HTMLInputElement).value); }
function checked(event: Event) { return (event.target as HTMLInputElement).checked; }
function selectValue(event: Event) { return (event.target as HTMLSelectElement).value; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
</script>

<style scoped>
.routing-matrix { display:flex; flex-direction:column; gap:14px; margin-top:18px; padding:14px; border:1px solid rgba(255,255,255,.1); border-radius:9px; background:rgba(0,0,0,.18); color:#dce2ec; }
.panel-heading,.channel-card summary,.send-row,.output-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.panel-heading h3,.outputs-panel h4 { margin:2px 0 0; font:600 13px var(--font-hardware); letter-spacing:.8px; }
.eyebrow { margin:0; color:#8f9bad; font:9px var(--font-hardware); letter-spacing:1.3px; }
.graph-state,.availability { color:#8994a4; font:9px var(--font-hardware); }
.graph-state.ready { color:#78c99a; }
.routing-note,.routing-footer { margin:0; color:#a8b0bd; font-size:11px; line-height:1.45; }
.routing-error { margin:0; color:#ff8e95; font-size:11px; }
.channel-list { display:flex; flex-direction:column; gap:8px; }
.channel-card { border:1px solid rgba(255,255,255,.1); border-radius:7px; background:#171a20; overflow:hidden; }
.channel-card summary { min-height:38px; padding:0 11px; cursor:pointer; font:10px var(--font-hardware); letter-spacing:.6px; }
.channel-kind { color:#8591a1; font-size:9px; }
.channel-controls { display:grid; grid-template-columns:minmax(170px,.8fr) minmax(260px,1.4fr) minmax(250px,1.3fr); gap:9px; padding:0 9px 9px; }
fieldset { min-width:0; margin:0; padding:8px; border:1px solid rgba(255,255,255,.09); border-radius:6px; }
legend { padding:0 4px; color:#9ba8b8; font:9px var(--font-hardware); letter-spacing:.7px; }
.eq-controls { display:grid; align-content:start; gap:8px; }
.eq-controls label { display:flex; justify-content:space-between; align-items:center; gap:7px; color:#b7c0ce; font-size:9px; }
.eq-controls input[type=number] { width:78px; }
.check-row { display:flex; align-items:center; gap:7px; color:#c1cad7; font-size:10px; }
.send-row { min-height:31px; font:9px var(--font-hardware); }
.send-row > span { min-width:62px; }
.send-row input[type=range] { min-width:40px; flex:1; accent-color:#4ca6f6; }
.send-row output { min-width:30px; text-align:right; color:#95a5b9; }
.send-row select { width:72px; }
input[type=number],select { min-height:25px; border:1px solid #353b45; border-radius:4px; background:#101217; color:#e0e5ee; padding:3px 5px; font-size:10px; }
input:disabled,select:disabled { opacity:.45; }
.latency-note { margin:6px 0 0; color:#e1b76f; font:9px var(--font-hardware); line-height:1.35; }
.outputs-panel { display:flex; flex-direction:column; gap:7px; }
.outputs-panel h4 { color:#b9c4d3; }
.output-row { padding:7px 9px; border-radius:6px; background:#171a20; }
.output-row > select { min-width:170px; }
.routing-footer { padding-top:8px; border-top:1px solid rgba(255,255,255,.08); }
@media (max-width:820px) { .channel-controls { grid-template-columns:1fr; } .output-row { flex-wrap:wrap; } }
</style>
