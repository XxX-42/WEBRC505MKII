<template>
  <div class="audio-container" ref="container" @mousemove="onMouseMove" @mouseup="onMouseUp">
    <h2>音频效果连接器</h2>
    <div class="global-actions">
      <button @click="startAudio">开始播放</button>
      <button @click="stopAudio">停止播放</button>
      <button @click="exportConfig">导出配置</button>
      <button @click="importConfig">导入配置</button>
      <!-- 隐藏的文件输入，用于导入配置 -->
      <input type="file" ref="fileInput" style="display:none" @change="handleFileChange" />
      <div class="oscillator-control">
        <label>
          振荡器 MIDI (C3～C5):
          <input type="range" min="48" max="72" step="1" v-model.number="oscillatorMidi" @input="updateOscillatorFrequency" />
          {{ oscillatorMidi }}
        </label>
      </div>
      <div class="bpm-control">
        BPM: {{ bpm }}
      </div>
    </div>
    <!-- SVG画布：绘制连线 -->
    <svg class="connections-overlay">
      <line
          v-for="(conn, index) in connections"
          :key="index"
          :x1="getEndpointX(conn.from, 'output')"
          :y1="getEndpointY(conn.from, 'output')"
          :x2="getEndpointX(conn.to, 'input')"
          :y2="getEndpointY(conn.to, 'input')"
          stroke="#ffffff" stroke-width="0.125rem" />
      <line
          v-if="draggingConnection.active"
          :x1="draggingConnection.startX"
          :y1="draggingConnection.startY"
          :x2="draggingConnection.x"
          :y2="draggingConnection.y"
          stroke="#ff4444" stroke-width="0.2rem" stroke-dasharray="0.25rem,0.25rem" stroke-linecap="round"/>
    </svg>
    <!-- 各模块，子组件会在挂载时自动注册节点 -->
    <OscillatorModule />
    <SequencerModule />
    <PhaserModule />
    <LPFModule />
    <ReverbModule />
    <MasterModule />
    <!-- 独立的 MIDI 键盘 -->
    <MidiKeyboard @midi-keydown="onMidiKeyDown" @midi-keyup="onMidiKeyUp" />
  </div>
</template>

<script>
import { ref, reactive, onMounted, onBeforeUnmount, provide, watch } from 'vue';
import OscillatorModule from './OscillatorModule.vue';
import SequencerModule from './SequencerModule.vue';
import PhaserModule from './PhaserModule.vue';
import LPFModule from './effect/LPFModule.vue';
import ReverbModule from './effect/ReverbModule.vue';
import MasterModule from './effect/MasterModule.vue';
import MidiKeyboard from './MidiKeyboard.vue';

export default {
  name: 'AudioLinker',
  components: { OscillatorModule, SequencerModule, PhaserModule, LPFModule, ReverbModule, MasterModule, MidiKeyboard },
  setup() {
    const container = ref(null);
    const remToPx = 16, nodeWidthRem = 7.5, nodeHeightRem = 5;
    const bpm = ref(window.myGlobalState.bpm);
    const handleBpmUpdate = event => { bpm.value = event.detail; };
    window.addEventListener('bpm-update', handleBpmUpdate);

    // 全局节点数据由子组件注册
    const nodes = reactive([]);
    const registerNode = (nodeData) => {
      const idx = nodes.findIndex(n => n.id === nodeData.id);
      if (idx >= 0) nodes[idx] = nodeData;
      else nodes.push(nodeData);
    };
    const unregisterNode = (nodeId) => {
      const idx = nodes.findIndex(n => n.id === nodeId);
      if (idx >= 0) nodes.splice(idx, 1);
    };
    provide('registerNode', registerNode);
    provide('unregisterNode', unregisterNode);

    // 全局连线数组（记录 { from, to }）
    const connections = reactive([]);

    // 拖拽状态
    const draggingNode = reactive({ active: false, nodeId: null, offsetX: 0, offsetY: 0, startX: 0, startY: 0, dragged: false });
    const draggingConnection = reactive({ active: false, sourceNodeId: null, startX: 0, startY: 0, x: 0, y: 0 });

    // 振荡器状态
    const oscillatorMidi = ref(60);
    const oscillatorFrequency = ref(440);
    function updateOscillatorFrequency() {
      oscillatorFrequency.value = 440 * Math.pow(2, (oscillatorMidi.value - 69) / 12);
      if (oscillatorNode) oscillatorNode.frequency.value = oscillatorFrequency.value;
    }
    function updateOscillatorFrequencyWith(midi) {
      oscillatorFrequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      if (oscillatorNode) oscillatorNode.frequency.value = oscillatorFrequency.value;
    }

    // 音序器状态：64 格子（8×8）
    const sequencerSteps = reactive(Array.from({ length: 64 }, () => ({ pitch: null })));
    const sequencerSelectedCell = ref(null);
    const currentStepIndex = ref(-1);
    let sequencerTimer = null;
    function startSequencer() {
      stopSequencer();
      const interval = (15 / bpm.value) * 1000;
      sequencerTimer = setInterval(() => {
        currentStepIndex.value = (currentStepIndex.value + 1) % 64;
        const step = sequencerSteps[currentStepIndex.value];
        if (step.pitch !== null) playSequencerNote(step.pitch);
      }, interval);
    }
    function stopSequencer() {
      if (sequencerTimer) {
        clearInterval(sequencerTimer);
        sequencerTimer = null;
      }
    }
    watch(bpm, startSequencer);

    // 全局 AudioContext 及各节点
    let audioContext = null;
    let oscillatorNode = null, phaserNode = null, lpfNode = null, reverbNode = null, masterGainNode = null;
    let oscillatorStarted = false;
    function createOscillator() {
      const osc = audioContext.createOscillator();
      osc.type = 'square';
      updateOscillatorFrequency();
      return osc;
    }
    onMounted(() => {
      audioContext = new (window.AudioContext || window['webkitAudioContext'])();
      oscillatorNode = createOscillator();
      // 不自动启动振荡器
      phaserNode = createPhaser(audioContext, phaserParams.lfoFrequency, phaserParams.modDepth);
      lpfNode = audioContext.createBiquadFilter();
      lpfNode.type = 'lowpass';
      lpfNode.frequency.value = lpfParams.cutoff;
      lpfNode.Q.value = lpfParams.Q;
      reverbNode = audioContext.createConvolver();
      reverbNode.buffer = createReverbImpulseResponse(audioContext);
      reverbNode.dry = audioContext.createGain();
      reverbNode.wet = audioContext.createGain();
      reverbNode.dry.gain.value = 1 - reverbParams.mix;
      reverbNode.wet.gain.value = reverbParams.mix;
      masterGainNode = audioContext.createGain();
      masterGainNode.gain.value = masterVolume.value;
      updateAudioChain();
      startSequencer();
      window.addEventListener('keydown', onKeyDown);
    });
    onBeforeUnmount(() => {
      stopSequencer();
      window.removeEventListener('bpm-update', handleBpmUpdate);
      window.removeEventListener('keydown', onKeyDown);
    });
    function createPhaser(context, lfoFrequency, modDepth) {
      const input = context.createGain();
      const output = context.createGain();
      const allpassFilters = [];
      const numFilters = 4;
      for (let i = 0; i < numFilters; i++) {
        const allpass = context.createBiquadFilter();
        allpass.type = 'allpass';
        allpass.frequency.value = 1000 + i * 100;
        allpassFilters.push(allpass);
      }
      input.connect(allpassFilters[0]);
      for (let i = 0; i < numFilters - 1; i++) {
        allpassFilters[i].connect(allpassFilters[i + 1]);
      }
      allpassFilters[numFilters - 1].connect(output);
      const lfo = context.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = lfoFrequency;
      const lfoGain = context.createGain();
      lfoGain.gain.value = modDepth;
      lfo.connect(lfoGain);
      allpassFilters.forEach(filter => {
        lfoGain.connect(filter.frequency);
      });
      lfo.start();
      return { input, output, lfo, lfoGain, filters: allpassFilters };
    }
    function createReverbImpulseResponse(context) {
      const sampleRate = context.sampleRate;
      const length = sampleRate * 3;
      const impulse = context.createBuffer(2, length, sampleRate);
      for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
        const channelData = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2);
        }
      }
      return impulse;
    }
    function updateAudioChain() {
      try { oscillatorNode.disconnect(); } catch(e) {}
      try { phaserNode.input.disconnect(); phaserNode.output.disconnect(); } catch(e) {}
      try { lpfNode.disconnect(); } catch(e) {}
      try { reverbNode.disconnect(); reverbNode.dry.disconnect(); reverbNode.wet.disconnect(); } catch(e) {}
      try { masterGainNode.disconnect(); } catch(e) {}
      let chain = [oscillatorNode];
      let currentId = 'oscillator';
      let found = true;
      while(found) {
        const conn = connections.find(c => c.from === currentId);
        if(conn) {
          const nodeAudio = getAudioNode(conn.to);
          if(nodeAudio) {
            chain.push(nodeAudio);
            currentId = conn.to;
          } else { found = false; }
        } else { found = false; }
      }
      if(chain[chain.length - 1] !== masterGainNode) chain.push(masterGainNode);
      for (let i = 0; i < chain.length - 1; i++) {
        chain[i].connect(chain[i+1]);
      }
      masterGainNode.connect(audioContext.destination);
    }
    function getAudioNode(id) {
      switch(id) {
        case 'phaser': return phaserNode.input;
        case 'lpf': return lpfNode;
        case 'reverb': return reverbNode;
        case 'master': return masterGainNode;
        default: return null;
      }
    }
    const phaserParams = reactive({ lfoFrequency: 0.5, modDepth: 500 });
    function updatePhaser() {
      phaserNode.lfo.frequency.value = phaserParams.lfoFrequency;
      phaserNode.lfoGain.gain.value = phaserParams.modDepth;
    }
    const lpfParams = reactive({ cutoff: 1000, Q: 1 });
    function updateLPF() {
      lpfNode.frequency.value = lpfParams.cutoff;
      lpfNode.Q.value = lpfParams.Q;
    }
    const reverbParams = reactive({ mix: 0.5 });
    function updateReverb() {
      if(reverbNode) {
        reverbNode.dry.gain.value = 1 - reverbParams.mix;
        reverbNode.wet.gain.value = reverbParams.mix;
      }
    }
    const masterVolume = ref(0.2);
    function updateMasterVolume() {
      masterGainNode.gain.value = masterVolume.value;
    }
    function startAudio() {
      updateAudioChain();
    }
    function stopAudio() {
      try { oscillatorNode.stop(); } catch(e) { console.error(e); }
      oscillatorStarted = false;
      oscillatorNode = null;
    }
    function onHeaderMouseDown(event, node) {
      draggingNode.active = true;
      draggingNode.nodeId = node.id;
      draggingNode.startX = event.clientX;
      draggingNode.startY = event.clientY;
      draggingNode.offsetX = event.clientX - node.x * remToPx;
      draggingNode.offsetY = event.clientY - node.y * remToPx;
      draggingNode.dragged = false;
    }
    function onMouseMove(event) {
      if(draggingNode.active) {
        const dx = event.clientX - draggingNode.startX;
        const dy = event.clientY - draggingNode.startY;
        if(!draggingNode.dragged && Math.hypot(dx, dy) > 5) draggingNode.dragged = true;
        if(draggingNode.dragged) {
          const node = nodes.find(n => n.id === draggingNode.nodeId);
          node.x = (event.clientX - draggingNode.offsetX) / remToPx;
          node.y = (event.clientY - draggingNode.offsetY) / remToPx;
        }
      }
      if(draggingConnection.active) {
        draggingConnection.x = event.clientX;
        draggingConnection.y = event.clientY;
        nodes.forEach(n => n.highlight = false);
        nodes.forEach(n => {
          if(n.id !== draggingConnection.sourceNodeId) {
            const el = document.getElementById('node-' + n.id);
            if(el) {
              const rect = el.getBoundingClientRect();
              if(event.clientX >= rect.left && event.clientX <= rect.right &&
                  event.clientY >= rect.top && event.clientY <= rect.bottom)
              {
                n.highlight = true;
              }
            }
          }
        });
      }
    }
    function onMouseUp() {
      if(draggingNode.active) {
        const node = nodes.find(n => n.id === draggingNode.nodeId);
        if(!draggingNode.dragged) node.open = !node.open;
        draggingNode.active = false;
        draggingNode.nodeId = null;
      }
      if(draggingConnection.active) {
        let targetNode = null;
        nodes.forEach(n => {
          if(n.highlight && n.id !== draggingConnection.sourceNodeId) targetNode = n;
          n.highlight = false;
        });
        if(targetNode) {
          const exists = connections.find(conn => conn.from === draggingConnection.sourceNodeId);
          if(exists) exists.to = targetNode.id;
          else connections.push({ from: draggingConnection.sourceNodeId, to: targetNode.id });
          updateAudioChain();
        }
        draggingConnection.active = false;
        draggingConnection.sourceNodeId = null;
      }
    }
    function onPortMouseDown(event, nodeId) {
      draggingConnection.active = true;
      draggingConnection.sourceNodeId = nodeId;
      const port = document.getElementById('output-' + nodeId);
      if(port) {
        const rect = port.getBoundingClientRect();
        draggingConnection.startX = rect.right;
        draggingConnection.startY = rect.top + rect.height/2;
        draggingConnection.x = draggingConnection.startX;
        draggingConnection.y = draggingConnection.startY;
      }
    }
    function getEndpointX(nodeId, type) {
      const node = nodes.find(n => n.id === nodeId);
      if(!node) return 0;
      return type === 'output'
          ? node.x * remToPx + nodeWidthRem * remToPx
          : node.x * remToPx;
    }
    function getEndpointY(nodeId, type) {
      const node = nodes.find(n => n.id === nodeId);
      if(!node) return 0;
      return node.y * remToPx + (nodeHeightRem * remToPx)/2;
    }
    function selectSequencerCell(index) {
      sequencerSelectedCell.value = index;
    }
    function playSequencerNote(midi) {
      const osc = audioContext.createOscillator();
      osc.type = 'square';
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      osc.frequency.value = freq;
      const gainNode = audioContext.createGain();
      gainNode.gain.setValueAtTime(1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.2);
      osc.connect(gainNode).connect(masterGainNode);
      osc.start();
      osc.stop(audioContext.currentTime + 0.2);
    }
    const activeMidiOscillators = {};
    function onMidiKeyDown(note) {
      if(sequencerSelectedCell.value !== null) {
        sequencerSteps[sequencerSelectedCell.value].pitch = note;
      } else {
        if(!activeMidiOscillators[note]) {
          const osc = audioContext.createOscillator();
          osc.type = 'square';
          osc.frequency.value = 440 * Math.pow(2, (note - 69) / 12);
          osc.connect(masterGainNode);
          osc.start();
          activeMidiOscillators[note] = osc;
        }
      }
    }
    function onMidiKeyUp(note) {
      if(activeMidiOscillators[note]) {
        activeMidiOscillators[note].stop();
        delete activeMidiOscillators[note];
      }
    }
    function onKeyDown(event) { /* 预留 */ }

    // 配置导出与导入
    const fileInput = ref(null);
    function getConfig() {
      return {
        nodes: nodes,
        connections: connections,
        phaserParams: phaserParams,
        lpfParams: lpfParams,
        reverbParams: reverbParams,
        masterVolume: masterVolume.value,
        oscillatorMidi: oscillatorMidi.value,
        sequencerSteps: sequencerSteps,
        bpm: bpm.value
      };
    }
    function setConfig(config) {
      // 更新各全局状态（此处简单赋值，实际项目中可做更细致判断）
      // 清空 nodes 数组，并重新注册各模块（此处为简单示例）
      nodes.splice(0, nodes.length, ...config.nodes);
      connections.splice(0, connections.length, ...config.connections);
      Object.assign(phaserParams, config.phaserParams);
      Object.assign(lpfParams, config.lpfParams);
      Object.assign(reverbParams, config.reverbParams);
      masterVolume.value = config.masterVolume;
      oscillatorMidi.value = config.oscillatorMidi;
      // 更新 sequencerSteps 数组
      config.sequencerSteps.forEach((step, idx) => {
        sequencerSteps[idx] = step;
      });
      bpm.value = config.bpm;
    }
    function exportConfig() {
      const data = JSON.stringify(getConfig(), null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'config.json';
      a.click();
      URL.revokeObjectURL(url);
    }
    function importConfig() {
      fileInput.value.click();
    }
    function handleFileChange(event) {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const config = JSON.parse(e.target.result);
            setConfig(config);
          } catch (err) {
            console.error('解析配置文件错误', err);
          }
        };
        reader.readAsText(file);
      }
    }

    return {
      container,
      bpm,
      nodes,
      connections,
      draggingConnection,
      sequencerSteps,
      sequencerSelectedCell,
      currentStepIndex,
      midiKeys: [
        { note: 48, label: 'C3' },
        { note: 50, label: 'D3' },
        { note: 52, label: 'E3' },
        { note: 53, label: 'F3' },
        { note: 55, label: 'G3' },
        { note: 57, label: 'A3' },
        { note: 59, label: 'B3' },
        { note: 60, label: 'C4' },
        { note: 62, label: 'D4' },
        { note: 64, label: 'E4' },
        { note: 65, label: 'F4' },
        { note: 67, label: 'G4' },
        { note: 69, label: 'A4' },
        { note: 71, label: 'B4' },
        { note: 72, label: 'C5' },
        { note: 74, label: 'D5' },
      ],
      oscillatorMidi,
      oscillatorFrequency,
      phaserParams,
      lpfParams,
      reverbParams,
      masterVolume,
      onMouseMove,
      onMouseUp,
      onHeaderMouseDown,
      onPortMouseDown,
      startAudio,
      stopAudio,
      updateOscillatorFrequency,
      updatePhaser,
      updateLPF,
      updateReverb,
      updateMasterVolume,
      getEndpointX,
      getEndpointY,
      selectSequencerCell,
      onMidiKeyDown,
      onMidiKeyUp,
      onKeyDown,
      exportConfig,
      importConfig,
      fileInput,
      handleFileChange,
      updateOscillatorFrequencyWith,
      playSequencerNote,
      getNode,
      container,
    };
  }
};
</script>

<style scoped>
.audio-container {
  position: relative;
  width: 100%;
  height: 37.5rem;
  background: #2a2a2a;
  color: #ffffff;
  border: 0.0625rem solid #2a2a2a;
  overflow: hidden;
  user-select: none;
  font-family: sans-serif;
  padding: 1rem;
}
.global-actions {
  margin-bottom: 0.625rem;
  display: flex;
  align-items: center;
  gap: 1rem;
}
.oscillator-control label,
.bpm-control { font-size: 0.875rem; }
.connections-overlay {
  position: absolute;
  top: 0; left: 0; width: 100%; height: 100%;
  pointer-events: none;
}
</style>
