<template>
  <div class="audio-container" ref="container" @mousemove="onMouseMove" @mouseup="onMouseUp">
    <h2>音频效果连接器</h2>
    <div class="global-actions">
      <!-- “开始播放”按钮仅用于更新连线，振荡器不自动播放 -->
      <button @click="startAudio">开始播放</button>
      <button @click="startAudio">test</button>
      <button @click="stopAudio">停止播放</button>
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
          stroke="#ffffff"
          stroke-width="0.125rem"
      />
      <!-- 拖拽时的动态连线（红色虚线） -->
      <line
          v-if="draggingConnection.active"
          :x1="draggingConnection.startX"
          :y1="draggingConnection.startY"
          :x2="draggingConnection.x"
          :y2="draggingConnection.y"
          stroke="#ff4444"
          stroke-width="0.2rem"
          stroke-dasharray="0.25rem,0.25rem"
          stroke-linecap="round"
      />
    </svg>

    <!-- 各模块（在每个模块外层加 id 以便检测目标区域） -->
    <div
        v-for="node in nodes"
        :key="node.id"
        :id="'node-' + node.id"
        class="node"
        :class="{ highlight: node.highlight }"
        :style="{ left: node.x + 'rem', top: node.y + 'rem' }"
    >
      <!-- 模块头部：点击切换展开/收起，拖拽移动 -->
      <div class="node-header" @mousedown="onHeaderMouseDown($event, node)">
        {{ node.name }}
      </div>
      <!-- 模块内容 -->
      <div v-show="node.open" class="node-content">
        <!-- 仅输出端口支持拖拽建立连线 -->
        <div
            v-if="node.hasOutput"
            class="port output-port"
            :id="'output-' + node.id"
            @mousedown.stop="onPortMouseDown($event, node.id)"
        ></div>
        <div v-if="node.hasInput" class="port input-port" :id="'input-' + node.id"></div>

        <!-- 振荡器显示 -->
        <div v-if="node.id === 'oscillator'" class="oscillator-info">
          频率: {{ oscillatorFrequency.toFixed(2) }} Hz
        </div>

        <!-- 音序器：构造为 8×8 网格，模仿 Launchpad Pro -->
        <div v-if="node.id === 'sequencer'" class="sequencer-grid">
          <div
              v-for="(step, index) in sequencerSteps"
              :key="index"
              class="sequencer-cell"
              :class="{ selected: sequencerSelectedCell === index, active: currentStepIndex === index }"
              @click="selectSequencerCell(index)"
          >
            {{ step.pitch !== null ? step.pitch : '-' }}
          </div>
        </div>

        <!-- Phaser 效果器界面 -->
        <PhaserEffect
            v-if="node.id === 'phaser'"
            :params="phaserParams"
            @update="updatePhaser"
        />

        <!-- 低通滤波器界面 -->
        <LpfEffect
            v-if="node.id === 'lpf'"
            :params="lpfParams"
            @update="updateLPF"
        />

        <!-- 混响效果器界面 -->
        <ReverbEffect
            v-if="node.id === 'reverb'"
            :params="reverbParams"
            @update="updateReverb"
        />

        <!-- 输出模块参数 -->
        <div v-if="node.id === 'master'" class="controls-panel">
          <label>
            输出音量:
            <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                v-model.number="masterVolume"
                @input="updateMasterVolume"
                @mousedown.stop
            />
            {{ masterVolume }}
          </label>
        </div>
      </div>
    </div>

    <!-- 独立的 MIDI 键盘 UI（mousedown 与 mouseup 事件） -->
    <div class="midi-keyboard">
      <div
          v-for="key in midiKeys"
          :key="key.note"
          class="midi-key"
          @mousedown="onMidiKeyDown(key.note)"
          @mouseup="onMidiKeyUp(key.note)"
      >
        {{ key.label }}
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, onMounted, onBeforeUnmount, watch } from 'vue';

export default {
  name: 'AudioLinker',

  // 内联子组件，不依赖外部模块
  components: {
    PhaserEffect: {
      props: ['params'],
      emits: ['update'],
      template: `
        <div class="effect-panel">
          <label>
            LFO Frequency:
            <input
                type="range"
                min="0.1"
                max="5"
                step="0.1"
                v-model.number="params.lfoFrequency"
                @input="$emit('update')"
            />
            {{ params.lfoFrequency }}
          </label>
          <label>
            Mod Depth:
            <input
                type="range"
                min="0"
                max="2000"
                step="50"
                v-model.number="params.modDepth"
                @input="$emit('update')"
            />
            {{ params.modDepth }}
          </label>
        </div>
      `
    },

    LpfEffect: {
      props: ['params'],
      emits: ['update'],
      template: `
        <div class="effect-panel">
          <label>
            Cutoff:
            <input
                type="range"
                min="20"
                max="20000"
                step="10"
                v-model.number="params.cutoff"
                @input="$emit('update')"
            />
            {{ params.cutoff }}
          </label>
          <label>
            Q:
            <input
                type="range"
                min="0.1"
                max="20"
                step="0.1"
                v-model.number="params.Q"
                @input="$emit('update')"
            />
            {{ params.Q }}
          </label>
        </div>
      `
    },

    ReverbEffect: {
      props: ['params'],
      emits: ['update'],
      template: `
        <div class="effect-panel">
          <label>
            Mix:
            <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                v-model.number="params.mix"
                @input="$emit('update')"
            />
            {{ params.mix }}
          </label>
        </div>
      `
    }
  },

  setup() {
    const container = ref(null);
    const remToPx = 16;
    const nodeWidthRem = 7.5;
    const nodeHeightRem = 5;

    // 全局 BPM（可从 window.myGlobalState 中获取，若无则默认 120）
    const bpm = ref(window.myGlobalState ? window.myGlobalState.bpm : 120);
    const handleBpmUpdate = (event) => {
      bpm.value = event.detail;
    };
    window.addEventListener('bpm-update', handleBpmUpdate);

    // 定义各模块节点
    const nodes = reactive([
      { id: 'oscillator', name: '振荡器', x: 2, y: 2, hasInput: false, hasOutput: true, open: true, highlight: false },
      { id: 'sequencer', name: '音序器', x: 10, y: 2, hasInput: false, hasOutput: true, open: true, highlight: false },
      { id: 'phaser', name: 'Phaser', x: 18, y: 2, hasInput: true, hasOutput: true, open: true, highlight: false },
      { id: 'lpf', name: '低通滤波器', x: 26, y: 2, hasInput: true, hasOutput: true, open: true, highlight: false },
      { id: 'reverb', name: '混响', x: 34, y: 2, hasInput: true, hasOutput: true, open: true, highlight: false },
      { id: 'master', name: '输出音量', x: 42, y: 2, hasInput: true, hasOutput: false, open: true, highlight: false },
    ]);

    // 连线数组（后续用来动态路由 AudioNode）
    const connections = reactive([]);

    // 拖拽模块状态
    const draggingNode = reactive({
      active: false,
      nodeId: null,
      offsetX: 0,
      offsetY: 0,
      startX: 0,
      startY: 0,
      dragged: false,
    });

    // 拖拽连线状态（仅支持从输出端口拖拽）
    const draggingConnection = reactive({
      active: false,
      sourceNodeId: null,
      startX: 0,
      startY: 0,
      x: 0,
      y: 0,
    });

    // 音序器：64 格（8x8）
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
        // 如果步内有设置音高，则播放对应音符；否则可以用作节拍器 Tick
        if (step.pitch !== null) {
          playSequencerNote(step.pitch);
        } else {
          // 这里使用合成节拍：每小节第一个 Tick 用 Kick，其余依次用 Snare/Click
          playMetronomeTick(currentStepIndex.value);
        }
      }, interval);
    }
    function stopSequencer() {
      if (sequencerTimer) {
        clearInterval(sequencerTimer);
        sequencerTimer = null;
      }
    }
    watch(bpm, () => {
      startSequencer();
    });

    // MIDI 键盘数据
    const midiKeys = [
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
    ];

    // 振荡器 MIDI 与频率
    const oscillatorMidi = ref(60);
    const oscillatorFrequency = ref(440);
    function updateOscillatorFrequency() {
      const midi = oscillatorMidi.value;
      oscillatorFrequency.value = 440 * Math.pow(2, (midi - 69) / 12);
      if (oscillatorNode) {
        oscillatorNode.frequency.value = oscillatorFrequency.value;
      }
    }

    // AudioContext 及各节点
    let audioContext = null;
    let oscillatorNode = null;
    let phaserNode = null;
    let lpfNode = null;
    let reverbNode = null;
    let masterGainNode = null;
    let oscillatorStarted = false;

    function createOscillator() {
      const osc = audioContext.createOscillator();
      osc.type = 'square';
      updateOscillatorFrequency();
      return osc;
    }

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

      // LFO 实现
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

    // 修改后的音频连线：根据 connections 数组建立节点连接
    function updateAudioChain() {
      try { oscillatorNode.disconnect(); } catch (e) {}
      try { phaserNode.input.disconnect(); } catch (e) {}
      try { phaserNode.output.disconnect(); } catch (e) {}
      try { lpfNode.disconnect(); } catch (e) {}
      try { reverbNode.disconnect(); } catch (e) {}
      try { masterGainNode.disconnect(); } catch (e) {}

      connections.forEach(conn => {
        const fromNode = getAudioNode(conn.from);
        const toNode = getAudioNode(conn.to);
        if (fromNode && toNode) {
          fromNode.connect(toNode);
        } else {
          console.warn(`未找到有效的节点连接：${conn.from} -> ${conn.to}`);
        }
      });

      masterGainNode.connect(audioContext.destination);
    }

    function getAudioNode(id) {
      switch (id) {
        case 'oscillator':
          return oscillatorNode;
        case 'phaser':
          return phaserNode.output;
        case 'lpf':
          return lpfNode;
        case 'reverb':
          return reverbNode;
        case 'master':
          return masterGainNode;
        default:
          console.warn(`未知的节点 id: ${id}`);
          return null;
      }
    }

    // 效果器参数更新
    const phaserParams = reactive({
      lfoFrequency: 0.5,
      modDepth: 500,
    });
    function updatePhaser() {
      if (phaserNode) {
        phaserNode.lfo.frequency.value = phaserParams.lfoFrequency;
        phaserNode.lfoGain.gain.value = phaserParams.modDepth;
      }
    }

    const lpfParams = reactive({
      cutoff: 1000,
      Q: 1,
    });
    function updateLPF() {
      if (lpfNode) {
        lpfNode.frequency.value = lpfParams.cutoff;
        lpfNode.Q.value = lpfParams.Q;
      }
    }

    const reverbParams = reactive({
      mix: 0.5,
    });
    function updateReverb() {
      if (reverbNode) {
        reverbNode.dry.gain.value = 1 - reverbParams.mix;
        reverbNode.wet.gain.value = reverbParams.mix;
      }
    }

    const masterVolume = ref(0.2);
    function updateMasterVolume() {
      if (masterGainNode) {
        masterGainNode.gain.value = masterVolume.value;
      }
    }

    // 纯合成节拍器函数，避免样本加载错误
    function playClick() {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'square';
      osc.frequency.value = 1000;
      gain.gain.setValueAtTime(1, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.05);
      osc.connect(gain).connect(masterGainNode);
      osc.start();
      osc.stop(audioContext.currentTime + 0.05);
    }

    function playSnare() {
      const buffer = audioContext.createBuffer(1, audioContext.sampleRate * 0.2, audioContext.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      const noise = audioContext.createBufferSource();
      noise.buffer = buffer;
      const filter = audioContext.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1800;
      const gain = audioContext.createGain();
      gain.gain.setValueAtTime(1, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.2);
      noise.connect(filter).connect(gain).connect(masterGainNode);
      noise.start();
      noise.stop(audioContext.currentTime + 0.2);
    }

    function playKick() {
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.frequency.setValueAtTime(150, audioContext.currentTime);
      osc.frequency.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5);
      gain.gain.setValueAtTime(1, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5);
      osc.connect(gain).connect(masterGainNode);
      osc.start();
      osc.stop(audioContext.currentTime + 0.5);
    }

    // 根据步数决定节拍器声音：每小节第一拍用 Kick，其它交替使用 Snare 和 Click
    function playMetronomeTick(stepIndex) {
      if (stepIndex % 4 === 0) {
        playKick();
      } else if (stepIndex % 2 === 0) {
        playSnare();
      } else {
        playClick();
      }
    }

    // 音序器播放：当单元点击设置了音高后，用振荡器播放短音
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

    // 简单的 MIDI 键盘
    function onMidiKeyDown(note) {
      const newFrequency = 440 * Math.pow(2, (note - 69) / 12);
      oscillatorFrequency.value = newFrequency;
      if (oscillatorNode) {
        oscillatorNode.frequency.setValueAtTime(newFrequency, audioContext.currentTime);
      }
    }
    function onMidiKeyUp(note) {
      // 若实现多复音，每个按键应单独生成 osc，此处仅示例调整全局振荡器
    }

    // 拖拽模块：头部 mousedown
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
      if (draggingNode.active) {
        const dx = event.clientX - draggingNode.startX;
        const dy = event.clientY - draggingNode.startY;
        if (!draggingNode.dragged && Math.hypot(dx, dy) > 5) {
          draggingNode.dragged = true;
        }
        if (draggingNode.dragged) {
          const node = nodes.find(n => n.id === draggingNode.nodeId);
          node.x = (event.clientX - draggingNode.offsetX) / remToPx;
          node.y = (event.clientY - draggingNode.offsetY) / remToPx;
        }
      }
      if (draggingConnection.active) {
        draggingConnection.x = event.clientX;
        draggingConnection.y = event.clientY;
        nodes.forEach(node => (node.highlight = false));
        nodes.forEach(node => {
          if (node.id !== draggingConnection.sourceNodeId) {
            const el = document.getElementById('node-' + node.id);
            if (el) {
              const rect = el.getBoundingClientRect();
              if (
                  event.clientX >= rect.left &&
                  event.clientX <= rect.right &&
                  event.clientY >= rect.top &&
                  event.clientY <= rect.bottom
              ) {
                node.highlight = true;
              }
            }
          }
        });
      }
    }
    function onMouseUp() {
      if (draggingNode.active) {
        const node = nodes.find(n => n.id === draggingNode.nodeId);
        if (!draggingNode.dragged) {
          node.open = !node.open;
        }
        draggingNode.active = false;
        draggingNode.nodeId = null;
      }
      if (draggingConnection.active) {
        let targetNode = null;
        nodes.forEach(node => {
          if (node.highlight && node.id !== draggingConnection.sourceNodeId) {
            targetNode = node;
          }
          node.highlight = false;
        });
        if (targetNode) {
          const exists = connections.find(conn => conn.from === draggingConnection.sourceNodeId);
          if (exists) {
            exists.to = targetNode.id;
          } else {
            connections.push({ from: draggingConnection.sourceNodeId, to: targetNode.id });
          }
          console.log('Connections now:', JSON.stringify(connections));
          updateAudioChain();
        }
        draggingConnection.active = false;
        draggingConnection.sourceNodeId = null;
      }
    }
    // 仅允许从输出端口拖拽建立连线
    function onPortMouseDown(event, nodeId) {
      draggingConnection.active = true;
      draggingConnection.sourceNodeId = nodeId;
      const port = document.getElementById('output-' + nodeId);
      if (port) {
        const rect = port.getBoundingClientRect();
        draggingConnection.startX = rect.right;
        draggingConnection.startY = rect.top + rect.height / 2;
        draggingConnection.x = draggingConnection.startX;
        draggingConnection.y = draggingConnection.startY;
      }
    }
    function getEndpointX(nodeId, type) {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return 0;
      return type === 'output'
          ? node.x * remToPx + nodeWidthRem * remToPx
          : node.x * remToPx;
    }
    function getEndpointY(nodeId, type) {
      const node = nodes.find(n => n.id === nodeId);
      if (!node) return 0;
      return node.y * remToPx + (nodeHeightRem * remToPx) / 2;
    }

    function selectSequencerCell(index) {
      sequencerSelectedCell.value = index;
      if (sequencerSteps[index].pitch === null) {
        sequencerSteps[index].pitch = oscillatorMidi.value;
      } else {
        sequencerSteps[index].pitch = null;
      }
    }

    // 启动/停止音频
    async function startAudio() {
      if (!audioContext) {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
        console.log('AudioContext resumed');
      }
      if (!oscillatorNode) {
        oscillatorNode = createOscillator();
      }
      if (!phaserNode) {
        phaserNode = createPhaser(audioContext, phaserParams.lfoFrequency, phaserParams.modDepth);
      }
      if (!lpfNode) {
        lpfNode = audioContext.createBiquadFilter();
        lpfNode.type = 'lowpass';
        lpfNode.frequency.value = lpfParams.cutoff;
        lpfNode.Q.value = lpfParams.Q;
      }
      if (!reverbNode) {
        reverbNode = audioContext.createConvolver();
        reverbNode.buffer = createReverbImpulseResponse(audioContext);
        reverbNode.dry = audioContext.createGain();
        reverbNode.wet = audioContext.createGain();
        reverbNode.dry.gain.value = 1 - reverbParams.mix;
        reverbNode.wet.gain.value = reverbParams.mix;
      }
      if (!masterGainNode) {
        masterGainNode = audioContext.createGain();
        masterGainNode.gain.value = masterVolume.value;
      }
      updateAudioChain();
      if (!oscillatorStarted) {
        oscillatorNode.start();
        oscillatorStarted = true;
        console.log('Oscillator started');
      }
      startSequencer();
    }
    function stopAudio() {
      stopSequencer();
      if (oscillatorNode) {
        try { oscillatorNode.stop(); } catch(e) { console.error(e); }
      }
      oscillatorStarted = false;
      oscillatorNode = null;
      phaserNode = null;
      lpfNode = null;
      reverbNode = null;
      masterGainNode = null;
    }

    function onKeyDown(event) {
      // 预留扩展 MIDI 键盘功能
    }

    onMounted(() => {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      oscillatorNode = createOscillator();
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

    return {
      container,
      bpm,
      nodes,
      connections,
      draggingConnection,
      sequencerSteps,
      sequencerSelectedCell,
      currentStepIndex,
      midiKeys,
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
    };
  },
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
.bpm-control {
  font-size: 0.875rem;
}

button {
  background: #444444;
  color: #ffffff;
  border: none;
  padding: 0.5rem 1rem;
  cursor: pointer;
}
button:hover {
  background: #555555;
}

.connections-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.node {
  position: absolute;
  min-width: 7.5rem;
  min-height: 5rem;
  background: #3a3a3a;
  border: 0.125rem solid #2a2a2a;
  border-radius: 0.3125rem;
  padding: 0.3125rem;
  box-sizing: border-box;
  transition: background 0.2s;
  overflow: hidden;
}

.node.highlight {
  background: #1a1a1a;
}

.node-header {
  font-weight: bold;
  margin-bottom: 0.3125rem;
  background: #2a2a2a;
  text-align: center;
  cursor: grab;
  user-select: none;
  padding: 0.1875rem;
  border-radius: 0.1875rem;
}

.node-content {
  font-size: 0.75rem;
  position: relative;
  overflow: hidden;
}

.port {
  width: 0.625rem;
  height: 0.625rem;
  background: #ffffff;
  border-radius: 50%;
  position: absolute;
  z-index: 10;
}
.input-port {
  left: -0.3125rem;
  top: calc(50% - 0.3125rem);
}
.output-port {
  right: -0.3125rem;
  top: calc(50% - 0.3125rem);
  cursor: pointer;
}

.controls-panel {
  margin-top: 0.3125rem;
}
.controls-panel label {
  display: block;
  margin-bottom: 0.1875rem;
}

/* 音序器网格（8x8） */
.sequencer-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 0.125rem;
  margin-top: 0.5rem;
}
.sequencer-cell {
  background: #555555;
  border: 0.0625rem solid #2a2a2a;
  padding: 0.25rem;
  text-align: center;
  cursor: pointer;
  font-size: 0.75rem;
}
.sequencer-cell.selected {
  background: #777777;
}
.sequencer-cell.active {
  border: 0.125rem solid #ff4444;
}

.midi-keyboard {
  display: flex;
  flex-wrap: wrap;
  gap: 0.125rem;
  margin-top: 1rem;
}
.midi-key {
  background: #444444;
  border: 0.0625rem solid #2a2a2a;
  padding: 0.5rem;
  flex: 1 0 4rem;
  text-align: center;
  cursor: pointer;
  user-select: none;
}

/* 效果器小面板 */
.effect-panel {
  margin-top: 0.5rem;
}
.effect-panel label {
  display: block;
  margin-bottom: 0.25rem;
}

/* 如果需要垂直 slider，请参考下面写法 */
/*
input[type="range"].vertical {
  writing-mode: vertical-lr;
  direction: rtl;
}
*/
</style>
