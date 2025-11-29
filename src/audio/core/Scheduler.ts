export class Scheduler {
    private context: AudioContext;
    private bpm: number = 120;
    private beatsPerMeasure: number = 4;
    private startTime: number = 0;
    private scheduledEvents: { time: number; callback: () => void; executed: boolean }[] = [];
    private lookahead: number = 25.0; // milliseconds
    private timerId: number | null = null;

    constructor(context: AudioContext) {
        this.context = context;
        this.startTime = this.context.currentTime;
        this.start();
    }

    public setBpm(bpm: number) {
        this.bpm = bpm;
    }

    public start() {
        if (this.timerId) return;
        const tick = () => {
            this.processScheduledEvents();
            this.timerId = window.setTimeout(tick, this.lookahead);
        };
        tick();
    }

    public stop() {
        if (this.timerId) {
            clearTimeout(this.timerId);
            this.timerId = null;
        }
    }

    /**
     * Schedule a callback to be executed at a specific AudioContext time.
     */
    public schedule(time: number, callback: () => void) {
        this.scheduledEvents.push({ time, callback, executed: false });
        this.scheduledEvents.sort((a, b) => a.time - b.time);
    }

    /**
     * Calculate the time of the next downbeat (measure boundary).
     */
    /**
     * Calculate the time of the next downbeat (measure boundary).
     */
    public getNextDownbeatTime(): number {
        const currentTime = this.context.currentTime;
        const secondsPerBeat = 60.0 / this.bpm;
        const measureDuration = secondsPerBeat * this.beatsPerMeasure;

        // Calculate how many measures have passed since startTime
        const elapsed = currentTime - this.startTime;
        const currentMeasureIndex = Math.floor(elapsed / measureDuration);

        // The start of the next measure
        const nextDownbeat = this.startTime + (currentMeasureIndex + 1) * measureDuration;

        return nextDownbeat;
    }

    /**
     * Reset the grid start time to a specific time (e.g., when recording starts from READY).
     */
    public resetGrid(startTime: number) {
        this.startTime = startTime;
        // Clear past events? Maybe not, but good to know grid is reset.
        console.log(`Scheduler: Grid reset to ${startTime}`);
    }

    /**
     * Calculate the duration of the nearest integer number of measures.
     * Used for "Snap-to-Grid" quantization at the end of recording.
     */
    public calculateNearestMeasure(duration: number, bpm: number): number {
        const secondsPerBeat = 60.0 / bpm;
        const measureDuration = secondsPerBeat * this.beatsPerMeasure;

        const measureCount = Math.round(duration / measureDuration);
        // Ensure at least 1 measure
        const clampedMeasureCount = Math.max(1, measureCount);

        return clampedMeasureCount * measureDuration;
    }

    private processScheduledEvents() {
        const currentTime = this.context.currentTime;
        // Look slightly ahead to ensure we don't miss events due to timer jitter
        // But for precise audio scheduling, we usually schedule audio nodes ahead.
        // For JS callbacks (UI updates, state changes), we execute them when their time is reached.
        const scheduleWindow = currentTime + 0.1; // 100ms window

        this.scheduledEvents.forEach(event => {
            if (!event.executed && event.time <= currentTime) {
                event.callback();
                event.executed = true;
            }
        });

        // Cleanup executed events
        this.scheduledEvents = this.scheduledEvents.filter(e => !e.executed);
    }
}
