import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
  ],
  // Vue is the app's only runtime bare dependency; add new ones to include.
  optimizeDeps: {
    include: ['vue'],
    noDiscovery: true,
  },
  server: {
    // Native build and benchmark outputs are not frontend inputs.
    watch: {
      ignored: ['**/native-mvp/build*/**', '**/bench/results/**', '**/golden-master/**',
        '**/hil-captures/**', '**/bench/hardware/results/**', '**/bench/audio-parity/results/**', '**/bench/**/*.wav'],
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup/vitest.setup.ts'],
    include: ['tests/unit/**/*.spec.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
  build: {
    rollupOptions: {
      // Keep the standalone LIVE_MONO factory and its bundled AudioWorklet in
      // every production build, even before a TrackAudio host opts into it.
      preserveEntrySignatures: 'strict',
      input: {
        app: 'index.html',
        liveMonoPitch: 'src/audio/pitch/liveMonoNode.ts',
      },
    },
  },
})
