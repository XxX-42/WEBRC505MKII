/**
 * BOSS RC-505mkII Memory Settings Simulation (Refined)
 * Based on user-provided manual images.
 * * Logic strictness: High (Type safety, Range clamping, Enum constraints)
 */

// ==========================================
// 1. Enums & Constants
// ==========================================

export const Switch = {
    OFF: "OFF",
    ON: "ON"
} as const;
export type Switch = (typeof Switch)[keyof typeof Switch];

export const TransportState = {
    STOPPED: "STOPPED",
    PLAYING: "PLAYING",
    RECORDING: "RECORDING"
} as const;
export type TransportState = (typeof TransportState)[keyof typeof TransportState];

export const TrackState = {
    EMPTY: "EMPTY",
    REC_STANDBY: "REC_STANDBY",  // Waiting for measure boundary to start recording
    RECORDING: "RECORDING",
    REC_FINISHING: "REC_FINISHING",  // Waiting for measure boundary to stop recording
    PLAYING: "PLAYING",
    OVERDUBBING: "OVERDUBBING",
    STOPPED: "STOPPED"
} as const;
export type TrackState = (typeof TrackState)[keyof typeof TrackState];

// Image 1: Measure Settings
export type MeasureType = "AUTO" | "FREE" | "NOTE";
export interface MeasureSetting {
    type: MeasureType;
    value?: string; // e.g., "♪", "1", "2"... used when type is NOTE
}

// Image 1: Loop Sync & Tempo Sync
export const LoopSyncMode = {
    IMMEDIATE: "IMMEDIATE",
    MEASURE: "MEASURE",
    LOOP_LENGTH: "LOOP LENGTH"
} as const;
export type LoopSyncMode = (typeof LoopSyncMode)[keyof typeof LoopSyncMode];

export const TempoSyncMode = {
    PITCH: "PITCH",
    XFADE: "XFADE"
} as const;
export type TempoSyncMode = (typeof TempoSyncMode)[keyof typeof TempoSyncMode];

export const TempoSyncSpeed = {
    HALF: "HALF",
    NORMAL: "NORMAL",
    DOUBLE: "DOUBLE"
} as const;
export type TempoSyncSpeed = (typeof TempoSyncSpeed)[keyof typeof TempoSyncSpeed];

// Image 2: Track Attributes
export const StartMode = {
    IMMEDIATE: "IMMEDIATE",
    FADE: "FADE"
} as const;
export type StartMode = (typeof StartMode)[keyof typeof StartMode];

export const StopMode = {
    IMMEDIATE: "IMMEDIATE",
    FADE: "FADE",
    LOOP: "LOOP"
} as const;
export type StopMode = (typeof StopMode)[keyof typeof StopMode];

export const DubMode = {
    OVERDUB: "OVERDUB",
    REPLACE1: "REPLACE1",
    REPLACE2: "REPLACE2"
} as const;
export type DubMode = (typeof DubMode)[keyof typeof DubMode];

// Image 2: Play Mode (Memory Level)
export const PlayMode = {
    MULTI: "MULTI",
    SINGLE: "SINGLE"
} as const;
export type PlayMode = (typeof PlayMode)[keyof typeof PlayMode];

// Image 3: Rec Settings
export const RecAction = {
    REC_DUB: "REC->DUB",
    REC_PLAY: "REC->PLAY"
} as const;
export type RecAction = (typeof RecAction)[keyof typeof RecAction];

export const QuantizeMode = {
    OFF: "OFF",
    MEASURE: "MEASURE"
} as const;
export type QuantizeMode = (typeof QuantizeMode)[keyof typeof QuantizeMode];

// Image 3: Play Settings
export const SingleTrackChange = {
    IMMEDIATE: "IMMEDIATE",
    LOOP_END: "LOOP END",
    MEASURE: "MEASURE"
} as const;
export type SingleTrackChange = (typeof SingleTrackChange)[keyof typeof SingleTrackChange];

export const SpeedChange = {
    IMMEDIATE: "IMMEDIATE",
    LOOP_END: "LOOP END"
} as const;
export type SpeedChange = (typeof SpeedChange)[keyof typeof SpeedChange];

export const SyncAdjust = {
    MEASURE: "MEASURE",
    BEAT: "BEAT"
} as const;
export type SyncAdjust = (typeof SyncAdjust)[keyof typeof SyncAdjust];

// ==========================================
// 2. Track Class (Per-Track Logic)
// ==========================================

export class Track {
    readonly id: number;

    // --- Image 1: LOOP Attributes ---
    // "Specifies the number of measures for each track."
    // Default: AUTO (Bold in image)
    measure: MeasureSetting = { type: "AUTO" };

    // Loop Sync (SW: Default OFF, Mode: Default MEASURE)
    loopSyncSw: Switch = Switch.OFF;

    // Tempo Sync (SW: Default ON, Mode: Default PITCH, Speed: Default NORMAL)
    tempoSyncSw: Switch = Switch.ON;

    // --- Image 2: TRACK Attributes ---
    reverse: Switch = Switch.OFF;

    // "1SHOT": Default OFF (Image shows 'Track 1: OFF' as standard example/bold)
    oneShot: Switch = Switch.OFF;

    // Pan: L50 - CENTER - R50
    // Internal representation: -50 to 50, 0 is Center
    private _pan: number = 0;

    // Play Level: 0 - 100 - 200
    private _playLevel: number = 100;

    startMode: StartMode = StartMode.IMMEDIATE;
    stopMode: StopMode = StopMode.IMMEDIATE;
    dubMode: DubMode = DubMode.OVERDUB;
    fxSw: Switch = Switch.ON;

    // --- FX Parameters ---
    // Filter (FLT button)
    filterEnabled: boolean = false;
    private _filterValue: number = 0.5; // 0.0-1.0 (0.5 = bypass)
    filterResonance: number = 1.0; // Q factor

    constructor(id: number) {
        this.id = id;
    }

    // --- Setters with Range Logic ---

    set pan(val: number) {
        // Clamp between -50 (L50) and 50 (R50)
        this._pan = Math.max(-50, Math.min(50, Math.round(val)));
    }
    get pan(): string {
        if (this._pan === 0) return "CENTER";
        return this._pan < 0 ? `L${Math.abs(this._pan)}` : `R${this._pan}`;
    }

    set playLevel(val: number) {
        // Clamp between 0 and 200
        this._playLevel = Math.max(0, Math.min(200, Math.round(val)));
    }
    get playLevel(): number { return this._playLevel; }

    // Filter value (0.0-1.0)
    set filterValue(val: number) {
        this._filterValue = Math.max(0, Math.min(1, val));
    }
    get filterValue(): number { return this._filterValue; }
}

// ==========================================
// 3. Memory Class (Global Settings)
// ==========================================

export class MemorySettings {
    tracks: Track[];

    // --- Image 1: Global Loop Settings ---
    // Note: While Sync Mode is global definition, the SW is per track.
    // The "MODE" for Loop Sync and Tempo Sync are technically listed in the table.
    // Usually these are Memory-level rules applied to tracks that have SW ON.
    loopSyncMode: LoopSyncMode = LoopSyncMode.MEASURE;
    tempoSyncMode: TempoSyncMode = TempoSyncMode.PITCH;

    // Bounce In (Image 1): Default OFF
    bounceIn: Switch = Switch.OFF;

    // Input Routing (Image 1)
    // Default: ON (Assumed standard for inputs, though image explicitly says "OFF, ON")
    inputMic1: Switch = Switch.ON;
    inputMic2: Switch = Switch.ON;
    inputInst1L: Switch = Switch.ON;
    inputInst1R: Switch = Switch.ON;
    inputInst2L: Switch = Switch.ON;
    inputInst2R: Switch = Switch.ON;
    inputRhythm: Switch = Switch.ON;

    // --- Image 2: Play Mode ---
    // This governs the relationship between tracks (Multi vs Single)
    playMode: PlayMode = PlayMode.MULTI;

    // --- Image 3: REC Settings ---
    recAction: RecAction = RecAction.REC_DUB; // Default: REC->DUB
    quantize: QuantizeMode = QuantizeMode.OFF; // Default: OFF

    // Auto Rec
    autoRecSw: Switch = Switch.OFF;
    private _autoRecSens: number = 50; // Default: 50 (Range 1-100)

    // Bounce (Image 3)
    bounceSw: Switch = Switch.OFF;
    bounceTrack: number = 5; // Default often Last Track, or user selectable 1-5

    // --- Image 3: PLAY Settings ---
    singleTrackChange: SingleTrackChange = SingleTrackChange.IMMEDIATE;
    currentTrack: number = 1; // Default TRACK1

    // Fade Time (Separate IN and OUT)
    // Values: Notes, 1MEAS, 2MEAS... 
    // Storing as string for simulation simplicity, defaults to "2MEAS" based on common usage, 
    // though image bolding is ambiguous, often "1MEAS" or "OFF" is factory. 
    // Let's assume "2MEAS" based on the text block size or standard BOSS logic.
    fadeTimeIn: string = "2MEAS";
    fadeTimeOut: string = "2MEAS";

    // All Start/Stop Trk: Image 3 says "Set this to ON for tracks that should start..."
    // This implies a bitmap or array of booleans.
    allStartTrk: boolean[] = [false, false, false, false, false];
    allStopTrk: boolean[] = [false, false, false, false, false];

    loopLength: string | number = "AUTO"; // Default: AUTO
    speedChange: SpeedChange = SpeedChange.IMMEDIATE;
    syncAdjust: SyncAdjust = SyncAdjust.MEASURE;

    constructor() {
        this.tracks = Array.from({ length: 5 }, (_, i) => new Track(i + 1));
    }

    // --- Logic & Validations ---

    set autoRecSens(val: number) {
        this._autoRecSens = Math.max(1, Math.min(100, Math.round(val)));
    }
    get autoRecSens(): number { return this._autoRecSens; }

    /**
     * Simulation Logic: Get target track for Bounce
     */
    getBounceTarget(): Track | null {
        if (this.bounceSw === Switch.OFF) return null;
        // Adjust for 0-index array
        return this.tracks[this.bounceTrack - 1] || null;
    }

    /**
     * Simulation Logic: Start Recording
     * Evaluates Quantize and Auto Rec settings
     */
    initiateRecord(trackId: number, inputLevel: number) {
        // const track = this.tracks[trackId - 1]; // Unused

        // Auto Rec Logic
        if (this.autoRecSw === Switch.ON) {
            if (inputLevel < this._autoRecSens) {
                console.log("Waiting for input (Auto Rec Standby)...");
                return;
            }
        }

        console.log(`Recording started on Track ${trackId}`);

        // Quantize Logic
        if (this.quantize === QuantizeMode.MEASURE) {
            console.log(">> Quantization Enabled: Aligning to Measure grid...");
        }
    }

    /**
     * Simulation Logic: Stop Recording
     * Determines next state based on RecAction
     */
    finishRecord(trackId: number) {
        console.log(`Recording finished on Track ${trackId}`);

        // Rec Action Logic
        if (this.recAction === RecAction.REC_DUB) {
            console.log(`>> Switching to OVERDUB mode (Rec Action: ${this.recAction})`);
        } else {
            console.log(`>> Switching to PLAY mode (Rec Action: ${this.recAction})`);
        }

        // Loop Length Logic
        if (this.loopLength === "AUTO" && trackId === 1) { // Simplified assumption
            console.log(">> Loop Length defined by this first recording.");
        }
    }

    /**
     * Simulation Logic: Switching Tracks in SINGLE mode
     */
    switchTrack(newTrackId: number) {
        if (this.playMode === PlayMode.MULTI) {
            console.log(`Track ${newTrackId} starting (Multi Mode)`);
            return;
        }

        // Single Mode Logic
        console.log(`Switching to Track ${newTrackId} in SINGLE Mode.`);

        // Single Track Change Logic
        switch (this.singleTrackChange) {
            case SingleTrackChange.IMMEDIATE:
                console.log(">> Change: Immediate");
                break;
            case SingleTrackChange.LOOP_END:
                console.log(">> Change: Waiting for current Loop End...");
                break;
            case SingleTrackChange.MEASURE:
                console.log(">> Change: Waiting for Measure boundary...");
                break;
        }
    }
}
