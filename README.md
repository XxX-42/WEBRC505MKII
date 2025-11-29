# WebRC505MKII_v1

WebRC505MKII_v1 represents a cutting-edge web-based loop station and audio synthesis platform, architected with Vue 3 and the Web Audio API. Drawing inspiration from the legendary Boss RC-505 MKII, this project delivers a robust 5-track looping environment enhanced by a flexible, node-based audio routing system.

## 🌟 Core Features

- **5-Track Loop Station**: Independent control over 5 separate audio tracks, each with dedicated Record, Play, and Stop functionality.
- **Advanced Audio Routing**: A visual `AudioLinker` interface allowing users to connect Oscillators, Sequencers, and Effects in a modular fashion.
- **Real-Time Effects**: Integrated DSP effects including Phaser, Low Pass Filter (LPF), and Reverb.
- **Dynamic Sequencer**: Built-in step sequencer for generating rhythmic patterns and melodies.
- **Global Control**: Master BPM synchronization and global volume management.
- **State Management**: Robust state handling via Pinia for track status and audio configurations.

## 📂 Project Structure & Key Files

### Root Directory
- **`AudioLinker.vue`**: A standalone version of the node-based audio connection interface. It allows for visual wiring of audio modules (Oscillators, FX, Output).
- **`vite.config.ts`**: Configuration for the Vite build tool, ensuring fast development and optimized production builds.

### Source Code (`src/`)

#### Entry & Setup
- **`main.ts`**: The application entry point, initializing the Vue app and Pinia stores.
- **`App.vue`**: The root component that structures the main layout, integrating the `RC505` view and the `CustomConsole`.

#### Views (`src/views/`)
- **`RC505.vue`**: The primary view for the Loop Station interface. It orchestrates the layout of the Track Board, Master Board, and Interface Board.
- **`AudioLinker.vue`**: The integrated view for the modular audio routing system, enabling complex sound design within the app.
- **`TrackBoard.vue`**: Manages the display and layout of the 5 individual track controls.
- **`MasterBoard.vue`**: Handles global controls such as BPM, Master FX, and overall volume.

#### State Management (`src/stores/`)
- **`trackStore.ts`**: A critical Pinia store that maintains the state of all 5 tracks. It tracks properties like `isPlaying`, `isRecording`, `volume`, and manages the audio buffers for each loop.
- **`audio.ts`**: Manages global audio context and shared audio state.

#### Components (`src/components/`)
- **`TrackBoard/`**: Contains granular controls for tracks:
  - `RecPlayButton.vue`: Handles the logic for recording and playback toggling.
  - `StopButton.vue`: Stops track playback.
  - `TrackControls.vue`: The container for a single track's UI.
- **`MasterBoard/`**:
  - `BpmControls.vue`: UI for adjusting the project's Beats Per Minute.
  - `FxControls.vue`: Interface for controlling global effects.

#### Audio & Effects (`src/FX/` & `src/audio/`)
- **`src/FX/phaser.ts`**: The DSP implementation of the Phaser effect.
- **`src/audio/`**: Contains Vue components that serve as wrappers or UI controls for specific audio effects like `LpfEffect.vue` and `ReverbEffect.vue`.

## 🚀 Getting Started

### Prerequisites
- Node.js (v16+ recommended)
- npm or yarn

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   ```
2. Navigate to the project directory:
   ```bash
   cd WebRC505MKII_v1
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

### Running the Application

Start the development server:
```bash
npm run dev
```
Open your browser and navigate to the local URL provided (usually `http://localhost:5173`).

## 🛠 Tech Stack

- **Framework**: Vue 3 (Composition API)
- **Build Tool**: Vite
- **State Management**: Pinia
- **Audio Engine**: Web Audio API
- **Language**: TypeScript / JavaScript
