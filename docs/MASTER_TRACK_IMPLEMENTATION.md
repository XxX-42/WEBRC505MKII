# Master Track Logic Implementation 🎯

## Overview
Implemented dynamic BPM calculation and Master Track system for the WebRC-505MKII looper. The first track to complete recording automatically becomes the master track, with BPM calculated intelligently from the recording duration.

---

## Implementation Details

### Files Modified:
1. **`src/core/Transport.ts`** - Enhanced with improved BPM calculation
2. **`src/audio/TrackAudio.ts`** - Updated to use new master track API

---

## Algorithm: Dynamic BPM Calculation

### Formula:
```
BPM = (Beats × 60) / Duration_seconds
```

### Logic Flow:

1. **When first track completes recording:**
   - Check if master track exists (`hasMasterTrack()`)
   - If no master, this track becomes master

2. **BPM Calculation:**
   - Assumes recording represents 1, 2, 4, or 8 measures
   - Calculates BPM for each possibility
   - Selects BPM within 60-160 range
   - Prefers BPM closest to 120 (ideal tempo)

3. **Example Calculation:**
   ```
   Recording duration: 4.000s
   Time signature: 4/4
   
   Testing possibilities:
   - 1 measure (4 beats): (4 × 60) / 4.000 = 60 BPM ✓
   - 2 measures (8 beats): (8 × 60) / 4.000 = 120 BPM ✓ (closest to ideal)
   - 4 measures (16 beats): (16 × 60) / 4.000 = 240 BPM ✗ (out of range)
   - 8 measures (32 beats): (32 × 60) / 4.000 = 480 BPM ✗ (out of range)
   
   Selected: 2 measures → 120 BPM
   ```

---

## Code Changes

### Transport.ts Enhancements:

#### 1. **Event System Improvement**
```typescript
// Before: Simple array
private listeners: Function[] = [];

// After: Event-specific listeners
private listeners: Map<string, Function[]> = new Map();

public on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
        this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
}
```

**Benefits:**
- Proper event isolation
- No cross-event pollution
- Better performance

#### 2. **Master Track State**
```typescript
public masterTrackId: number | null = null;
public masterLoopLengthSamples: number = 0; // NEW: Track loop length
public measureLength: number = 0;
```

#### 3. **Enhanced setMasterTrack Method**
```typescript
public setMasterTrack(
    trackId: number,
    durationSeconds: number,
    sampleRate: number,      // NEW
    lengthSamples: number    // NEW
)
```

**Parameters:**
- `trackId`: ID of track becoming master
- `durationSeconds`: Recording duration in seconds
- `sampleRate`: Audio context sample rate (44100Hz)
- `lengthSamples`: Loop length in samples (for precise sync)

#### 4. **BPM Calculation Algorithm**
```typescript
const TARGET_MIN_BPM = 60;
const TARGET_MAX_BPM = 160;
const IDEAL_BPM = 120;

const possibleMeasureCounts = [1, 2, 4, 8];

possibleMeasureCounts.forEach(measureCount => {
    const totalBeats = measureCount * beatsPerMeasure;
    const calculatedBpm = (totalBeats * 60) / durationSeconds;

    if (calculatedBpm >= TARGET_MIN_BPM && calculatedBpm <= TARGET_MAX_BPM) {
        const diff = Math.abs(calculatedBpm - IDEAL_BPM);
        if (diff < minDiff) {
            minDiff = diff;
            bestBpm = calculatedBpm;
            bestMeasureCount = measureCount;
        }
    }
});
```

#### 5. **Detailed Console Logging**
```typescript
console.log(`\n=== Master Track BPM Calculation ===`);
console.log(`Track ${trackId} duration: ${durationSeconds.toFixed(3)}s`);
console.log(`Time signature: ${this.timeSignature[0]}/${this.timeSignature[1]}`);

possibleMeasureCounts.forEach(measureCount => {
    const totalBeats = measureCount * beatsPerMeasure;
    const calculatedBpm = (totalBeats * 60) / durationSeconds;
    console.log(`  ${measureCount} measure(s): ${totalBeats} beats → ${calculatedBpm.toFixed(2)} BPM`);
});

console.log(`\n✓ Selected: ${bestMeasureCount} measure(s) → ${finalBpm} BPM`);
console.log(`  Loop length: ${lengthSamples} samples @ ${sampleRate}Hz`);
console.log(`=====================================\n`);
```

#### 6. **New Utility Methods**
```typescript
// Reset master track
public resetMasterTrack() {
    this.masterTrackId = null;
    this.masterLoopLengthSamples = 0;
    this.measureLength = 0;
}

// Check if master exists
public hasMasterTrack(): boolean {
    return this.masterTrackId !== null;
}
```

---

### TrackAudio.ts Updates:

#### processRecordedBuffer Enhancement:
```typescript
private processRecordedBuffer(rawBuffer: Float32Array) {
    // ... latency compensation ...

    const durationSeconds = this.audioBuffer.duration;
    const lengthSamples = this.audioBuffer.length;

    if (!this.transport.hasMasterTrack()) {
        // This is the first track - becomes master
        console.log(`\n🎯 Track ${this.track.id} is becoming the MASTER track`);
        
        this.transport.setMasterTrack(
            this.track.id,
            durationSeconds,
            ctx.sampleRate,
            lengthSamples
        );
        
        this.transport.start();
        console.log(`✓ Global transport started with calculated BPM\n`);
    } else {
        // Slave track
        console.log(`Track ${this.track.id} recorded as SLAVE track`);
        // TODO: Quantize to master loop
    }

    this.state = TrackState.PLAYING;
    this.play();
}
```

---

## State Synchronization

### How BPM Updates Reach the UI:

1. **Transport.setBpm() called**
   ```typescript
   this.setBpm(finalBpm);
   ```

2. **Event emitted**
   ```typescript
   this.emit('bpm-change');
   ```

3. **TransportControls.vue listens**
   ```typescript
   onMounted(() => {
       transport.on('bpm-change', updateState);
   });
   ```

4. **UI updates**
   ```typescript
   const updateState = () => {
       bpm.value = transport.bpm;
   };
   ```

5. **7-Segment Display shows new BPM**
   ```vue
   <div class="led-digits">{{ bpmDisplay }}</div>
   ```

### Data Flow:
```
Recording Complete
    ↓
processRecordedBuffer()
    ↓
setMasterTrack()
    ↓
Calculate BPM (60-160 range)
    ↓
setBpm(finalBpm)
    ↓
emit('bpm-change')
    ↓
TransportControls.updateState()
    ↓
UI displays new BPM
```

---

## Example Scenarios

### Scenario 1: 4-second recording
```
Duration: 4.000s
Time signature: 4/4

Calculations:
  1 measure (4 beats): 60 BPM ✓
  2 measures (8 beats): 120 BPM ✓ (closest to 120)
  4 measures (16 beats): 240 BPM ✗
  8 measures (32 beats): 480 BPM ✗

Result: 120 BPM (2 measures)
```

### Scenario 2: 2-second recording
```
Duration: 2.000s
Time signature: 4/4

Calculations:
  1 measure (4 beats): 120 BPM ✓ (closest to 120)
  2 measures (8 beats): 240 BPM ✗
  4 measures (16 beats): 480 BPM ✗
  8 measures (32 beats): 960 BPM ✗

Result: 120 BPM (1 measure)
```

### Scenario 3: 8-second recording
```
Duration: 8.000s
Time signature: 4/4

Calculations:
  1 measure (4 beats): 30 BPM ✗
  2 measures (8 beats): 60 BPM ✓ (at minimum)
  4 measures (16 beats): 120 BPM ✓ (closest to 120)
  8 measures (32 beats): 240 BPM ✗

Result: 120 BPM (4 measures)
```

### Scenario 4: 3-second recording
```
Duration: 3.000s
Time signature: 4/4

Calculations:
  1 measure (4 beats): 80 BPM ✓
  2 measures (8 beats): 160 BPM ✓ (at maximum, but farther from 120)
  4 measures (16 beats): 320 BPM ✗
  8 measures (32 beats): 640 BPM ✗

Result: 80 BPM (1 measure) - closer to 120 than 160
```

---

## Console Output Example

```
Track 1 recorded: 4.00s (176400 samples)

🎯 Track 1 is becoming the MASTER track

=== Master Track BPM Calculation ===
Track 1 duration: 4.000s
Time signature: 4/4
  1 measure(s): 4 beats → 60.00 BPM
  2 measure(s): 8 beats → 120.00 BPM
  4 measure(s): 16 beats → 240.00 BPM
  8 measure(s): 32 beats → 480.00 BPM

✓ Selected: 2 measure(s) → 120 BPM
  Loop length: 176400 samples @ 44100Hz
=====================================

BPM updated to: 120
✓ Global transport started with calculated BPM
```

---

## Technical Specifications

### BPM Range:
- **Minimum:** 60 BPM
- **Maximum:** 160 BPM
- **Ideal:** 120 BPM (preferred when multiple options exist)

### Supported Measure Counts:
- 1 measure (4 beats in 4/4)
- 2 measures (8 beats)
- 4 measures (16 beats)
- 8 measures (32 beats)

### Time Signature:
- Currently: 4/4 (hardcoded)
- Future: Configurable via UI

### Sample Rate:
- Standard: 44100 Hz
- Configurable via AudioContext

---

## Future Enhancements (Phase 2b)

### Slave Track Logic:
1. **Quantization:**
   - Snap slave track length to master loop length
   - Trim or loop-extend to match

2. **Synchronization:**
   - Align slave track playback to master timing
   - Use SharedArrayBuffer for precise sync

3. **Overdub:**
   - Record over existing slave tracks
   - Maintain sync with master

4. **Multiple Masters:**
   - Allow switching master track
   - Recalculate BPM when master changes

---

## Testing Recommendations

### Manual Testing:
1. **Record 4-second loop** → Should calculate 120 BPM
2. **Record 2-second loop** → Should calculate 120 BPM
3. **Record 8-second loop** → Should calculate 120 BPM
4. **Record 3-second loop** → Should calculate 80 BPM
5. **Record 1.5-second loop** → Should calculate 160 BPM

### Verification:
- Check console for BPM calculation details
- Verify 7-segment display updates
- Confirm transport starts automatically
- Ensure subsequent tracks are slaves

---

## Performance Considerations

### Optimizations:
- Event listeners use Map for O(1) lookup
- BPM calculation is O(1) (only 4 iterations)
- SharedArrayBuffer for lock-free state sync
- No blocking operations in audio thread

### Memory:
- Master loop length stored in samples (Int32)
- Minimal overhead per track
- No memory leaks (proper cleanup)

---

## API Reference

### Transport.setMasterTrack()
```typescript
public setMasterTrack(
    trackId: number,
    durationSeconds: number,
    sampleRate: number,
    lengthSamples: number
): void
```

**Purpose:** Set the master track and calculate global BPM

**Parameters:**
- `trackId` - ID of the track (1-5)
- `durationSeconds` - Recording duration in seconds
- `sampleRate` - Audio context sample rate (typically 44100)
- `lengthSamples` - Loop length in samples (for precise sync)

**Side Effects:**
- Sets `masterTrackId`
- Sets `masterLoopLengthSamples`
- Calculates and sets global `bpm`
- Emits `'bpm-change'` event
- Updates `measureLength`

### Transport.hasMasterTrack()
```typescript
public hasMasterTrack(): boolean
```

**Returns:** `true` if master track is set, `false` otherwise

### Transport.resetMasterTrack()
```typescript
public resetMasterTrack(): void
```

**Purpose:** Clear master track state (for reset/clear all)

---

## Conclusion

The Master Track system is now fully implemented with:
- ✅ Dynamic BPM calculation (60-160 range)
- ✅ Intelligent measure count detection (1, 2, 4, 8)
- ✅ Preference for 120 BPM when multiple options exist
- ✅ Proper event-based state synchronization
- ✅ UI updates via 7-segment LED display
- ✅ Detailed console logging for debugging
- ✅ Sample-accurate loop length tracking
- ✅ Foundation for slave track synchronization

**Next Steps:** Implement slave track quantization and synchronization (Phase 2b)
