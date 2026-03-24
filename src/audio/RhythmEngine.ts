import { Transport } from '../core/Transport';

export type RhythmPattern = 'ROCK' | 'TECHNO' | 'METRONOME';

export class RhythmEngine {
    private context: AudioContext;
    private transport: Transport;
    public outputNode: GainNode;
    private isPlaying: boolean = false;

    // Scheduler
    private nextNoteTime: number = 0;
    private current16thNote: number = 0;
    private scheduleAheadTime: number = 0.1; // 100ms
    private lookahead: number = 25; // 25ms
    private timerID: number | null = null;

    // Patterns (16 steps)
    private patterns: Record<RhythmPattern, { kick: number[], snare: number[], hihat: number[] }> = {
        ROCK: {
            kick: [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
            snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
            hihat: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]
        },
        TECHNO: {
            kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
            snare: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], // Claps usually, but snare works
            hihat: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0] // Off-beat hats
        },
        METRONOME: {
            kick: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // Downbeat
            snare: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], // Clicks
            hihat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        }
    };

    private currentPattern: RhythmPattern = 'ROCK';

    constructor(context: AudioContext) {
        this.context = context;
        this.transport = Transport.getInstance();
        this.outputNode = context.createGain();
        this.outputNode.gain.value = 0.5; // Default volume
    }

    public connect(destination: AudioNode) {
        this.outputNode.connect(destination);
    }

    public setPattern(pattern: RhythmPattern) {
        this.currentPattern = pattern;
    }

    public setVolume(value: number) {
        // Value 0-100
        this.outputNode.gain.value = value / 100;
    }

    public start() {
        if (this.isPlaying) return;

        // Resume context if needed
        if (this.context.state === 'suspended') {
            this.context.resume();
        }

        this.isPlaying = true;
        this.current16thNote = 0;
        this.nextNoteTime = this.context.currentTime + 0.05;
        this.scheduler();
    }

    public stop() {
        this.isPlaying = false;
        if (this.timerID) {
            window.clearTimeout(this.timerID);
            this.timerID = null;
        }
    }

    private scheduler() {
        if (!this.isPlaying) return;

        while (this.nextNoteTime < this.context.currentTime + this.scheduleAheadTime) {
            this.scheduleNote(this.current16thNote, this.nextNoteTime);
            this.nextNote();
        }

        this.timerID = window.setTimeout(() => this.scheduler(), this.lookahead);
    }

    private nextNote() {
        const secondsPerBeat = 60.0 / this.transport.bpm;
        this.nextNoteTime += 0.25 * secondsPerBeat; // Advance 1/16th note
        this.current16thNote++;
        if (this.current16thNote === 16) {
            this.current16thNote = 0;
        }
    }

    private scheduleNote(beatNumber: number, time: number) {
        const pattern = this.patterns[this.currentPattern];

        if (pattern.kick[beatNumber]) {
            this.playKick(time);
        }
        if (pattern.snare[beatNumber]) {
            this.playSnare(time);
        }
        if (pattern.hihat[beatNumber]) {
            this.playHihat(time);
        }
    }

    // ========================================
    // SYNTHESIS METHODS
    // ========================================

    private playKick(time: number) {
        const osc = this.context.createOscillator();
        const gain = this.context.createGain();

        osc.connect(gain);
        gain.connect(this.outputNode);

        osc.frequency.setValueAtTime(150, time);
        osc.frequency.exponentialRampToValueAtTime(0.01, time + 0.5);

        gain.gain.setValueAtTime(1, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

        osc.start(time);
        osc.stop(time + 0.5);
    }

    private playSnare(time: number) {
        // Noise Buffer
        const bufferSize = this.context.sampleRate * 0.5; // 0.5s noise
        const buffer = this.context.createBuffer(1, bufferSize, this.context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = this.context.createBufferSource();
        noise.buffer = buffer;

        const filter = this.context.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 1000;

        const gain = this.context.createGain();
        gain.gain.setValueAtTime(1, time);
        gain.gain.exponentialRampToValueAtTime(0.01, time + 0.2);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.outputNode);

        noise.start(time);
        noise.stop(time + 0.2);

        // Add a "tone" to the snare for body
        const osc = this.context.createOscillator();
        const oscGain = this.context.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(180, time);
        oscGain.gain.setValueAtTime(0.5, time);
        oscGain.gain.exponentialRampToValueAtTime(0.01, time + 0.1);

        osc.connect(oscGain);
        oscGain.connect(this.outputNode);
        osc.start(time);
        osc.stop(time + 0.1);
    }

    private playHihat(time: number) {
        // Noise Buffer
        const bufferSize = this.context.sampleRate * 0.1; // Short
        const buffer = this.context.createBuffer(1, bufferSize, this.context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noise = this.context.createBufferSource();
        noise.buffer = buffer;

        const filter = this.context.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 5000; // High frequency

        const gain = this.context.createGain();
        gain.gain.setValueAtTime(0.3, time); // Lower volume
        gain.gain.exponentialRampToValueAtTime(0.01, time + 0.05); // Very short decay

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(this.outputNode);

        noise.start(time);
        noise.stop(time + 0.05);
    }
}
