<template>
  <div class="audio-container" ref="container" @mousemove="onMouseMove" @mouseup="onMouseUp">
    <h2>音频模块连接器</h2>
    <div class="global-actions">
      <button @click="startAudio">开始播放</button>
      <button @click="stopAudio">停止播放</button>
    </div>
    <!-- SVG画布，用于绘制模块之间的连线 -->
    <svg class="connections-overlay">
      <line
          v-for="(conn, index) in connections"
          :key="index"
          :x1="getOutputX(conn.from)"
          :y1="getOutputY(conn.from)"
          :x2="getInputX(conn.to)"
          :y2="getInputY(conn.to)"
          stroke="black" stroke-width="2"/>
      <!-- 正在拖拽创建连接时的虚线 -->
      <line
          v-if="draggingConnection.active"
          :x1="draggingConnection.startX"
          :y1="draggingConnection.startY"
          :x2="draggingConnection.x"
          :y2="draggingConnection.y"
          stroke="red" stroke-width="2" stroke-dasharray="5,5"/>
    </svg>
    <!-- 拖拽节点，每个节点代表一个音频模块 -->
    <div
        v-for="node in nodes"
        :key="node.id"
        class="node"
        :style="{ left: node.x + 'px', top: node.y + 'px' }"
        @mousedown="onNodeMouseDown($event, node.id)"
    >
      <div class="node-header">
        {{ node.name }}
      </div>
      <!-- 若节点有输入端口 -->
      <div v-if="node.hasInput" class="port input-port" :id="'input-' + node.id"></div>
      <!-- 若节点有输出端口 -->
      <div v-if="node.hasOutput" class="port output-port"
           :id="'output-' + node.id"
           @mousedown.stop="onPortMouseDown($event, node.id)">
      </div>
      <!-- 节点内的参数控制 -->
      <div v-if="node.id === 'phaser'" class="controls-panel">
        <label>
          LFO频率:
          <input type="range" min="0.1" max="5" step="0.1" v-model.number="phaserParams.lfoFrequency" @input="updatePhaser"/>
          {{ phaserParams.lfoFrequency }} Hz
        </label>
        <label>
          调制深度:
          <input type="range" min="50" max="1000" step="10" v-model.number="phaserParams.modDepth" @input="updatePhaser"/>
          {{ phaserParams.modDepth }}
        </label>
      </div>
      <div v-if="node.id === 'lpf'" class="controls-panel">
        <label>
          截止频率:
          <input type="range" min="500" max="10000" step="100" v-model.number="lpfParams.cutoff" @input="updateLPF"/>
          {{ lpfParams.cutoff }} Hz
        </label>
        <label>
          Q值:
          <input type="range" min="0.1" max="20" step="0.1" v-model.number="lpfParams.Q" @input="updateLPF"/>
          {{ lpfParams.Q }}
        </label>
      </div>
      <div v-if="node.id === 'reverb'" class="controls-panel">
        <label>
          混响比例:
          <input type="range" min="0" max="1" step="0.05" v-model.number="reverbParams.mix" @input="updateReverb"/>
          {{ reverbParams.mix }}
        </label>
      </div>
      <div v-if="node.id === 'master'" class="controls-panel">
        <label>
          输出音量:
          <input type="range" min="0" max="1" step="0.05" v-model.number="masterVolume" @input="updateMasterVolume"/>
          {{ masterVolume }}
        </label>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, reactive, onMounted } from 'vue';
import { createPhaser } from '@/FX/phaser';


export default {
  name: 'AudioLinker',
  setup() {
    const container = ref(null);
    // 定义各个音频模块节点，包含初始位置及是否含有输入/输出端口
    const nodes = reactive([
      { id: 'oscillator', name: '振荡器', x: 50, y: 50, hasInput: false, hasOutput: true },
      { id: 'phaser', name: 'Phaser', x: 250, y: 50, hasInput: true, hasOutput: true },
      { id: 'lpf', name: '低通滤波器', x: 450, y: 50, hasInput: true, hasOutput: true },
      { id: 'reverb', name: '混响', x: 650, y: 50, hasInput: true, hasOutput: true },
      { id: 'master', name: '输出音量', x: 850, y: 50, hasInput: true, hasOutput: false },
    ]);
    // 默认连接顺序：振荡器→Phaser→低通滤波器→混响→输出
    const connections = reactive([
      { from: 'oscillator', to: 'phaser' },
      { from: 'phaser', to: 'lpf' },
      { from: 'lpf', to: 'reverb' },
      { from: 'reverb', to: 'master' },
    ]);

    // 节点拖拽状态
    const draggingNode = reactive({
      active: false,
      nodeId: null,
      offsetX: 0,
      offsetY: 0,
    });
    // 连接拖拽状态
    const draggingConnection = reactive({
      active: false,
      sourceNodeId: null,
      startX: 0,
      startY: 0,
      x: 0,
      y: 0,
    });

    // AudioContext 及各个音频节点
    let oscillatorNode = null;
    let phaserNode = null; // 对象：{ input, output, lfo, lfoGain, filters }
    let lpfNode = null;
    let reverbNode = null;
    let masterGainNode = null;
    let oscillatorStarted = false;

    // 效果器参数
    const phaserParams = reactive({
      lfoFrequency: 0.5,
      modDepth: 500,
    });
    const lpfParams = reactive({
      cutoff: 1000,
      Q: 1,
    });
    const reverbParams = reactive({
      mix: 0.5, // 0：全干；1：全湿
    });
    const masterVolume = ref(0.2);

    onMounted(() => {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      // 创建振荡器（方波）
      oscillatorNode = audioContext.createOscillator();
      oscillatorNode.type = 'square';
      oscillatorNode.frequency.value = 440;

      // 创建 Phaser 效果器
      phaserNode = createPhaser(audioContext, phaserParams.lfoFrequency, phaserParams.modDepth);

      // 创建低通滤波器
      lpfNode = audioContext.createBiquadFilter();
      lpfNode.type = 'lowpass';
      lpfNode.frequency.value = lpfParams.cutoff;
      lpfNode.Q.value = lpfParams.Q;

      // 创建混响（Convolver），并使用简单的脉冲响应；混响采用干湿混合
      reverbNode = audioContext.createConvolver();
      reverbNode.buffer = createReverbImpulseResponse(audioContext);
      // 为混响设置干湿分离：dryGain 与 wetGain
      reverbNode.dry = audioContext.createGain();
      reverbNode.wet = audioContext.createGain();
      reverbNode.dry.gain.value = 1 - reverbParams.mix;
      reverbNode.wet.gain.value = reverbParams.mix;

      // 创建输出音量节点，默认音量较低
      masterGainNode = audioContext.createGain();
      masterGainNode.gain.value = masterVolume.value;

      // 初始时构建音频链（根据默认连接）
      updateAudioChain();
    });

    // 创建 Phaser 效果器（使用多个全通滤波器和 LFO 调制）


    // 生成简单混响脉冲响应
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

    // 根据当前“节点链接”信息重新构建音频链
    function updateAudioChain() {
      // 首先断开所有连接
      try { oscillatorNode.disconnect(); } catch(e) {}
      try { phaserNode.input.disconnect(); phaserNode.output.disconnect(); } catch(e) {}
      try { lpfNode.disconnect(); } catch(e) {}
      try { reverbNode.disconnect(); reverbNode.dry.disconnect(); reverbNode.wet.disconnect(); } catch(e) {}
      try { masterGainNode.disconnect(); } catch(e) {}

      // 根据 connections 数组，从“振荡器”开始构建链路
      let chain = [];
      let current = 'oscillator';
      chain.push(current);
      let found = true;
      while (current !== 'master' && found) {
        found = false;
        for (let conn of connections) {
          if (conn.from === current) {
            chain.push(conn.to);
            current = conn.to;
            found = true;
            break;
          }
        }
      }
      console.log("Audio chain:", chain);
      // 按链路顺序连接各节点
      for (let i = 0; i < chain.length - 1; i++) {
        const src = chain[i];
        const dst = chain[i + 1];
        const srcNode = getAudioNode(src);
        const dstNode = getAudioNode(dst);
        if (src === 'reverb') {
          // 混响采用干湿混合，先分别连接后合并
          srcNode.connect(reverbNode.dry);
          srcNode.connect(reverbNode.wet);
          const merger = audioContext.createGain();
          reverbNode.dry.connect(merger);
          reverbNode.wet.connect(merger);
          merger.connect(dstNode);
        } else {
          srcNode.connect(dstNode);
        }
      }
      // 将 masterGainNode 连接到输出设备
      masterGainNode.connect(audioContext.destination);
    }

    // 根据节点ID返回对应的 Web Audio 节点（注意：对于效果器，返回其输入端）
    function getAudioNode(id) {
      switch(id) {
        case 'oscillator': return oscillatorNode;
        case 'phaser': return phaserNode.input;
        case 'lpf': return lpfNode;
        case 'reverb': return reverbNode;
        case 'master': return masterGainNode;
        default: return null;
      }
    }

    // 更新 Phaser 参数
    function updatePhaser() {
      phaserNode.lfo.frequency.value = phaserParams.lfoFrequency;
      phaserNode.lfoGain.gain.value = phaserParams.modDepth;
    }
    // 更新 LPF 参数
    function updateLPF() {
      lpfNode.frequency.value = lpfParams.cutoff;
      lpfNode.Q.value = lpfParams.Q;
    }
    // 更新混响干湿比
    function updateReverb() {
      if(reverbNode){
        reverbNode.dry.gain.value = 1 - reverbParams.mix;
        reverbNode.wet.gain.value = reverbParams.mix;
      }
    }
    // 更新输出音量
    function updateMasterVolume() {
      masterGainNode.gain.value = masterVolume.value;
    }

    // 音频播放控制
    function startAudio() {
      // 如果 context 处于 suspended（某些浏览器自动挂起），先恢复它
      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }
      // 如果还没启动，创建一个新的 OscillatorNode
      if (!oscillatorStarted) {
        oscillatorNode = audioContext.createOscillator();
        oscillatorNode.type = 'square';
        oscillatorNode.frequency.value = 440;

        updateAudioChain();          // 重新把它插到当前音频链
        oscillatorNode.start();
        oscillatorStarted = true;
      }
    }

    function stopAudio() {
      if (oscillatorStarted) {
        oscillatorNode.stop();
        oscillatorStarted = false;
      }
    }

    // 节点拖拽：记录拖拽起始位置
    function onNodeMouseDown(event, nodeId) {
      draggingNode.active = true;
      draggingNode.nodeId = nodeId;
      const node = nodes.find(n => n.id === nodeId);
      draggingNode.offsetX = event.clientX - node.x;
      draggingNode.offsetY = event.clientY - node.y;
    }
    // 全局鼠标移动：更新节点位置或正在拖拽的连线终点
    function onMouseMove(event) {
      if (draggingNode.active) {
        const node = nodes.find(n => n.id === draggingNode.nodeId);
        node.x = event.clientX - draggingNode.offsetX;
        node.y = event.clientY - draggingNode.offsetY;
      }
      if (draggingConnection.active) {
        draggingConnection.x = event.clientX;
        draggingConnection.y = event.clientY;
      }
    }
    // 全局鼠标弹起：结束节点拖拽或连线拖拽，并检测连线目标
    function onMouseUp() {
      if (draggingNode.active) {
        draggingNode.active = false;
        draggingNode.nodeId = null;
      }
      if (draggingConnection.active) {
        let targetNode = null;
        nodes.forEach(node => {
          const port = document.getElementById('input-' + node.id);
          if (port) {
            const rect = port.getBoundingClientRect();
            if (draggingConnection.x >= rect.left && draggingConnection.x <= rect.right &&
                draggingConnection.y >= rect.top && draggingConnection.y <= rect.bottom) {
              targetNode = node;
            }
          }
        });
        if (targetNode && targetNode.id !== draggingConnection.sourceNodeId) {
          // 若已有该输出的连接则更新目标，否则添加新的连接
          const exists = connections.find(conn => conn.from === draggingConnection.sourceNodeId);
          if (exists) {
            exists.to = targetNode.id;
          } else {
            connections.push({ from: draggingConnection.sourceNodeId, to: targetNode.id });
          }
          updateAudioChain();
        }
        draggingConnection.active = false;
        draggingConnection.sourceNodeId = null;
      }
    }
    // 开始拖拽连线：记录输出端口的位置
    function onPortMouseDown(event, nodeId) {
      draggingConnection.active = true;
      draggingConnection.sourceNodeId = nodeId;
      const port = document.getElementById('output-' + nodeId);
      const rect = port.getBoundingClientRect();
      draggingConnection.startX = rect.right;
      draggingConnection.startY = rect.top + rect.height / 2;
      draggingConnection.x = draggingConnection.startX;
      draggingConnection.y = draggingConnection.startY;
    }

    // 以下辅助函数用于根据节点位置计算端口中心（假设节点宽 120px，高 80px）
    function getOutputX(nodeId) {
      const node = nodes.find(n => n.id === nodeId);
      return node ? node.x + 120 : 0;
    }
    function getOutputY(nodeId) {
      const node = nodes.find(n => n.id === nodeId);
      return node ? node.y + 40 : 0;
    }
    function getInputX(nodeId) {
      const node = nodes.find(n => n.id === nodeId);
      return node ? node.x : 0;
    }
    function getInputY(nodeId) {
      const node = nodes.find(n => n.id === nodeId);
      return node ? node.y + 40 : 0;
    }

    return {
      container,
      nodes,
      connections,
      draggingConnection,
      onNodeMouseDown,
      onMouseMove,
      onMouseUp,
      onPortMouseDown,
      startAudio,
      stopAudio,
      phaserParams,
      updatePhaser,
      lpfParams,
      updateLPF,
      reverbParams,
      updateReverb,
      masterVolume,
      updateMasterVolume,
      getOutputX,
      getOutputY,
      getInputX,
      getInputY,
    }
  }
}
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
  width: auto;
  min-width: 7.5rem;
  height: auto;
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
</style>
