<template>
  <div class="component-showcase">
    <h1 class="showcase-title">RC-505MKII Hardware Components</h1>
    
    <!-- Button Showcase -->
    <section class="showcase-section">
      <h2 class="section-title">Hardware Buttons</h2>
      
      <div class="demo-grid">
        <!-- Size Variants -->
        <div class="demo-item">
          <h3>Sizes</h3>
          <div class="button-row">
            <HardwareButton size="sm" color="red" :active="true" label="Small" />
            <HardwareButton size="md" color="green" :active="true" label="Medium" />
            <HardwareButton size="lg" color="yellow" :active="true" label="Large" />
          </div>
        </div>
        
        <!-- Color Variants -->
        <div class="demo-item">
          <h3>LED Colors</h3>
          <div class="button-row">
            <HardwareButton color="red" :active="activeButtons.red" @press="toggleButton('red')" label="Red" />
            <HardwareButton color="green" :active="activeButtons.green" @press="toggleButton('green')" label="Green" />
            <HardwareButton color="yellow" :active="activeButtons.yellow" @press="toggleButton('yellow')" label="Yellow" />
            <HardwareButton color="blue" :active="activeButtons.blue" @press="toggleButton('blue')" label="Blue" />
            <HardwareButton color="white" :active="activeButtons.white" @press="toggleButton('white')" label="White" />
          </div>
          <p class="hint">Click to toggle LED states</p>
        </div>
        
        <!-- State Demo -->
        <div class="demo-item">
          <h3>Interactive States</h3>
          <div class="button-row">
            <HardwareButton color="neutral" :active="false" label="Idle" />
            <HardwareButton color="red" :active="true" label="Active" />
            <HardwareButton color="green" :active="pulseState" label="Pulsing" />
          </div>
        </div>
      </div>
    </section>
    
    <!-- Fader Showcase -->
    <section class="showcase-section">
      <h2 class="section-title">Hardware Faders</h2>
      
      <div class="fader-grid">
        <div class="fader-demo">
          <HardwareFader 
            v-model="faderValues.red" 
            led-color="red" 
            label="Recording"
            :min="0"
            :max="100"
          />
        </div>
        
        <div class="fader-demo">
          <HardwareFader 
            v-model="faderValues.green" 
            led-color="green" 
            label="Playing"
            :min="0"
            :max="100"
          />
        </div>
        
        <div class="fader-demo">
          <HardwareFader 
            v-model="faderValues.yellow" 
            led-color="yellow" 
            label="Overdub"
            :min="0"
            :max="100"
          />
        </div>
        
        <div class="fader-demo">
          <HardwareFader 
            v-model="faderValues.blue" 
            led-color="blue" 
            label="FX Send"
            :min="0"
            :max="100"
          />
        </div>
        
        <div class="fader-demo">
          <HardwareFader 
            v-model="faderValues.white" 
            led-color="white" 
            label="Master"
            :min="0"
            :max="100"
          />
        </div>
      </div>
    </section>
    
    <!-- Combined Demo -->
    <section class="showcase-section">
      <h2 class="section-title">Combined Example: Mini Track</h2>
      
      <div class="mini-track hardware-panel">
        <div class="track-header">DEMO TRACK</div>
        
        <HardwareButton 
          size="lg" 
          :color="trackState.color" 
          :active="trackState.active"
          @press="cycleTrackState"
          class="mb-4"
        />
        
        <HardwareButton 
          size="sm" 
          color="neutral" 
          label="STOP"
          @press="stopTrack"
          class="mb-4"
        />
        
        <HardwareFader 
          v-model="trackLevel" 
          :led-color="trackState.color === 'neutral' ? 'white' : trackState.color"
          label="LEVEL"
          :min="0"
          :max="200"
        />
        
        <div class="fx-row">
          <HardwareButton 
            size="sm" 
            color="blue" 
            :active="fx.filter"
            label="FLT"
            @press="fx.filter = !fx.filter"
          />
          <HardwareButton 
            size="sm" 
            color="blue" 
            :active="fx.delay"
            label="DLY"
            @press="fx.delay = !fx.delay"
          />
          <HardwareButton 
            size="sm" 
            color="blue" 
            :active="fx.reverb"
            label="RVB"
            @press="fx.reverb = !fx.reverb"
          />
        </div>
      </div>
    </section>
    
    <!-- Color Palette Reference -->
    <section class="showcase-section">
      <h2 class="section-title">Color Palette</h2>
      
      <div class="palette-grid">
        <div class="palette-item">
          <div class="color-swatch" style="background: var(--led-red-recording); box-shadow: var(--glow-red-intense);"></div>
          <span>Recording Red</span>
        </div>
        <div class="palette-item">
          <div class="color-swatch" style="background: var(--led-green-playing); box-shadow: var(--glow-green-intense);"></div>
          <span>Playing Green</span>
        </div>
        <div class="palette-item">
          <div class="color-swatch" style="background: var(--led-yellow-overdub); box-shadow: var(--glow-yellow-intense);"></div>
          <span>Overdub Yellow</span>
        </div>
        <div class="palette-item">
          <div class="color-swatch" style="background: var(--led-blue-accent); box-shadow: var(--glow-blue-soft);"></div>
          <span>FX Blue</span>
        </div>
        <div class="palette-item">
          <div class="color-swatch" style="background: var(--led-white-neutral); box-shadow: var(--glow-white-soft);"></div>
          <span>Neutral White</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import HardwareButton from './ui/HardwareButton.vue';
import HardwareFader from './ui/HardwareFader.vue';

// Button states
const activeButtons = ref({
  red: true,
  green: true,
  yellow: true,
  blue: true,
  white: true
});

const toggleButton = (color: keyof typeof activeButtons.value) => {
  activeButtons.value[color] = !activeButtons.value[color];
};

// Pulse animation
const pulseState = ref(false);
let pulseInterval: number;

onMounted(() => {
  pulseInterval = window.setInterval(() => {
    pulseState.value = !pulseState.value;
  }, 500);
});

onUnmounted(() => {
  clearInterval(pulseInterval);
});

// Fader values
const faderValues = ref({
  red: 75,
  green: 60,
  yellow: 85,
  blue: 40,
  white: 100
});

// Track demo
type TrackColor = 'neutral' | 'red' | 'green' | 'yellow' | 'blue' | 'white';

const trackState = ref<{ color: TrackColor; active: boolean }>({
  color: 'neutral',
  active: false
});

const trackLevel = ref(100);

const fx = ref({
  filter: false,
  delay: false,
  reverb: false
});

const cycleTrackState = () => {
  const states: Array<{ color: TrackColor; active: boolean }> = [
    { color: 'red', active: true },      // Recording
    { color: 'green', active: true },    // Playing
    { color: 'yellow', active: true },   // Overdubbing
    { color: 'neutral', active: false }  // Idle
  ];
  
  const currentIndex = states.findIndex(
    s => s.color === trackState.value.color && s.active === trackState.value.active
  );
  
  const nextIndex = (currentIndex + 1) % states.length;
  const nextState = states[nextIndex] ?? states[0];
  if (nextState) {
    trackState.value = nextState;
  }
};

const stopTrack = () => {
  trackState.value = { color: 'neutral', active: false };
};
</script>

<style scoped>
.component-showcase {
  min-height: 100vh;
  background: var(--bg-panel-main);
  padding: 40px 20px;
}

.showcase-title {
  font-size: 32px;
  font-weight: 700;
  text-align: center;
  color: var(--led-white-neutral);
  margin-bottom: 48px;
  letter-spacing: 2px;
  text-transform: uppercase;
  font-family: var(--font-hardware);
}

.showcase-section {
  max-width: 1200px;
  margin: 0 auto 60px;
  padding: 32px;
  background: var(--bg-panel-secondary);
  border-radius: var(--border-radius-hardware);
  border: 1px solid rgba(255, 255, 255, 0.05);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--led-white-neutral);
  margin-bottom: 24px;
  padding-bottom: 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  font-family: var(--font-hardware);
  letter-spacing: 1px;
}

.demo-grid {
  display: grid;
  gap: 32px;
}

.demo-item h3 {
  font-size: 14px;
  font-weight: 600;
  color: rgba(240, 240, 240, 0.6);
  margin-bottom: 16px;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.button-row {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}

.hint {
  margin-top: 12px;
  font-size: 12px;
  color: rgba(240, 240, 240, 0.4);
  font-style: italic;
}

.fader-grid {
  display: flex;
  gap: 24px;
  justify-content: center;
  flex-wrap: wrap;
}

.fader-demo {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.mini-track {
  max-width: 200px;
  margin: 0 auto;
  padding: 24px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.track-header {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.5px;
  color: rgba(240, 240, 240, 0.4);
  margin-bottom: 20px;
  font-family: var(--font-mono);
}

.fx-row {
  display: flex;
  gap: 8px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
}

.mb-4 {
  margin-bottom: 16px;
}

.palette-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 24px;
}

.palette-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.color-swatch {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 2px solid rgba(0, 0, 0, 0.3);
}

.palette-item span {
  font-size: 12px;
  font-weight: 600;
  color: rgba(240, 240, 240, 0.7);
  font-family: var(--font-mono);
}
</style>
