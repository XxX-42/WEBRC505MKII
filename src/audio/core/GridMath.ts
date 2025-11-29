/**
 * GridMath.ts
 * Encapsulates mathematical logic for BPM detection and Grid quantization.
 */

export interface BpmDetectionResult {
    bpm: number;
    measures: number;
    error: number;
}

/**
 * Calculate the best fitting BPM and Measure count for a given duration.
 * Assumes 4/4 Time Signature.
 * Prioritizes BPM range 80-160.
 * 
 * @param durationSeconds The duration of the recording in seconds.
 * @returns BpmDetectionResult containing detected BPM, measures, and error score.
 */
export function calculateBpmFromDuration(durationSeconds: number): BpmDetectionResult {
    // Edge Case: Ignore very short recordings
    if (durationSeconds < 0.5) {
        console.warn("Duration too short for grid calculation (< 0.5s), defaulting to 120 BPM");
        return { bpm: 120, measures: 1, error: 0 };
    }

    const minBpm = 80;
    const maxBpm = 160;
    // Candidate measure counts to test against
    const candidateMeasures = [1, 2, 4, 8, 16, 32];

    let bestFit: BpmDetectionResult = { bpm: 120, measures: 4, error: Infinity };

    for (const measures of candidateMeasures) {
        // Formula: BPM = (Measures * 4 beats/measure * 60s/min) / Duration
        // Simplified: BPM = (Measures * 240) / Duration
        const rawBpm = (measures * 240) / durationSeconds;

        // Calculate Error Score
        // 1. Integer Proximity: We prefer integer BPMs (e.g. 120.0 vs 120.4)
        const integerError = Math.abs(rawBpm - Math.round(rawBpm));

        // 2. Range Penalty: Penalize BPMs outside the target range (80-160)
        let rangePenalty = 0;
        if (rawBpm < minBpm || rawBpm > maxBpm) {
            // Heavy penalty for being out of range, proportional to distance
            rangePenalty = 1000 + Math.min(Math.abs(rawBpm - minBpm), Math.abs(rawBpm - maxBpm));
        } else {
            // Slight tie-breaker preference for 120 BPM center (optional)
            rangePenalty = Math.abs(rawBpm - 120) * 0.01;
        }

        // Total Error = Integer Error (weighted high) + Range Penalty
        const totalError = integerError * 10 + rangePenalty;

        if (totalError < bestFit.error) {
            bestFit = {
                bpm: rawBpm, // Keep precision for exact loop match? Or round? 
                // Usually for "First Track", we want to set the system BPM to the EXACT calculated value 
                // so the loop plays back naturally without time-stretching.
                // However, the user requirement implies we might want to "Snap" to an integer if close.
                // Let's return the EXACT BPM that fits the measures perfectly.
                measures: measures,
                error: totalError
            };
        }
    }

    console.log(`[GridMath] Duration: ${durationSeconds.toFixed(3)}s -> Detected: ${bestFit.measures} bars @ ${bestFit.bpm.toFixed(2)} BPM`);

    return bestFit;
}

/**
 * Calculate the exact duration in seconds for a given BPM and measure count (4/4).
 */
export function calculateDurationFromBpm(bpm: number, measures: number): number {
    if (bpm <= 0) return 0;
    return (measures * 240) / bpm;
}
