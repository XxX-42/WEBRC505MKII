export class SemanticMapper {

    // --- FX Specfic Mappers (Ported from XmlParserFX.java) ---

    static mapOnOff(value) {
        if (value === "0" || value.toUpperCase() === "OFF") return "OFF";
        return (value === "1" || value.toUpperCase() === "ON") ? "ON" : value;
    }

    static mapRate(value) {
        const i = parseInt(value, 10);
        if (isNaN(i)) return value;
        const map = {
            0: "4 MEAS", 1: "2 MEAS", 2: "1 MEAS", 3: "1/2 note",
            4: "1/4 note dotted", 5: "1/2 note triplet", 6: "1/4 note",
            7: "1/8 note dotted", 8: "1/4 note triplet", 9: "1/8 note",
            10: "1/16 note dotted", 11: "1/8 note triplet", 12: "1/16 note",
            13: "1/32 note"
        };
        return map[i] || (i - 14).toString();
    }

    static mapDepth(value) { return value; } // Direct value

    static mapFilterCutoff(value) { // For HI/LO CUT/FREQ
        const map = {
            0: "FLAT", 1: "20.0Hz", 2: "25.0Hz", 3: "31.5Hz", 4: "40.0Hz",
            5: "50.0Hz", 6: "63.0Hz", 7: "80.0Hz", 8: "100Hz", 9: "125Hz",
            10: "160Hz", 11: "200Hz", 12: "250Hz", 13: "315Hz", 14: "400Hz",
            15: "500Hz", 16: "630Hz", 17: "800Hz", 18: "1.00KHz", 19: "1.25KHz",
            20: "1.6KHz", 21: "2.00KHz", 22: "2.5KHz", 23: "3.15KHz",
            24: "4.00KHz", 25: "5.00KHz", 26: "6.3KHz", 27: "8.00KHz",
            28: "10.00KHz", 29: "12.5KHz"
        };
        // Note: XMLParserFX distinguishes maplo_cut vs maphi_cut slightly (0 is FLAT vs 29 is FLAT).
        // I'll implement a generic one and handle edge cases if specific types match.
        return map[value] || value;
    }

    static mapResonance(value) { return value; }

    static mapStepRate(value) {
        const i = parseInt(value, 10);
        if (isNaN(i)) return value;
        const map = {
            0: "OFF", 1: "4 MEAS", 2: "2 MEAS", 3: "1 MEAS", 4: "1/2 note",
            5: "1/4 note dotted", 6: "1/2 note triplet", 7: "1/4 note",
            8: "1/8 note dotted", 9: "1/4 note triplet", 10: "1/8 note",
            11: "1/16 note dotted", 12: "1/8 note triplet", 13: "1/16 note",
            14: "1/32 note"
        };
        return map[i] || (i - 15).toString();
    }

    static mapTimeReverb(value) {
        const i = parseInt(value, 10);
        return isNaN(i) ? value : (i * 0.1).toFixed(1) + "S";
    }

    static mapTimeDelay(value) {
        const i = parseInt(value, 10);
        if (isNaN(i)) return value;
        const map = {
            0: "1/32 note", 1: "1/16 note", 2: "1/8T", 3: "1/16D",
            4: "1/8 note", 5: "1/4T", 6: "1/4D", 7: "1/2T",
            8: "1/4 note", 9: "1/2 note"
        };
        return map[i] || (i - 8) + "ms";
    }

    static mapGain(value) {
        const i = parseInt(value, 10);
        if (isNaN(i)) return value;
        const db = i - 20;
        return (db > 0 ? "+" : "") + db + "dB";
    }

    // --- Definitions ---

    // Detailed Parameter Lists extracted from RC-505mkII Parameter Guide (PDF)
    // Keys match XML tag suffixes (e.g. AA_MOD_DELAY -> MOD_DELAY)
    static FX_DEFS = {
        // 通用 FX 序列
        'FX_SEQUENCE': ['SW', 'SYNC', 'RETRIG', 'TARGET', 'RATE', 'MAX', 'VAL1', 'VAL2', 'VAL3', 'VAL4', 'VAL5', 'VAL6', 'VAL7', 'VAL8', 'VAL9', 'VAL10', 'VAL11', 'VAL12', 'VAL13', 'VAL14', 'VAL15', 'VAL16'],
        // 滤波器
        'LPF': ['RATE', 'DEPTH', 'RESONANCE', 'CUTOFF', 'STEP RATE'],
        'HPF': ['RATE', 'DEPTH', 'RESONANCE', 'CUTOFF', 'STEP RATE'],
        'BPF': ['RATE', 'DEPTH', 'RESONANCE', 'CUTOFF', 'STEP RATE'],
        // 调制
        'PHASER': ['RATE', 'DEPTH', 'RESONANCE', 'MANUAL', 'STEP RATE', 'D.LEVEL', 'E.LEVEL', 'STAGE'],
        'FLANGER': ['RATE', 'DEPTH', 'RESONANCE', 'MANUAL', 'STEP RATE', 'D.LEVEL', 'E.LEVEL', 'SEPARATION'],
        'RING_MOD': ['FREQUENCY', 'BALANCE', 'MODE'],
        'G2B': ['BALANCE', 'MODE'],
        // 合成器 / Lo-Fi
        'SYNTH': ['FREQUENCY', 'RESONANCE', 'DECAY', 'BALANCE'],
        'LO-FI': ['BITDEPTH', 'SAMPLERATE', 'BALANCE'],
        'RADIO': ['LO-FI', 'LEVEL'],
        // 动态 / 乐器
        'SUSTAINER': ['ATTACK', 'RELEASE', 'LEVEL', 'LOW GAIN', 'HI GAIN', 'SUSTAIN'],
        'AUTO_RIFF': ['PHRASE', 'TEMPO', 'HOLD', 'ATTACK', 'LOOP', 'KEY', 'BALANCE'],
        // 音高 / 声码器
        'PITCH_BEND': ['PITCH', 'BEND', 'MODE'],
        'ROBOT': ['NOTE', 'FORMANT'],
        'SLOW_GEAR': ['SENS', 'RISE TIME', 'LEVEL', 'MODE'],
        'ELECTRIC': ['SHIFT', 'FORMANT', 'SPEED', 'STABILITY', 'SCALE'],
        'TRANSPOSE': ['TRANS', 'MODE'],
        'HRM_MANUAL': ['VOICE', 'FORMANT', 'PAN', 'KEY', 'D.LEVEL', 'HRM LEVEL'],
        'VOCODER': ['CARRIER', 'TONE', 'ATTACK', 'MOD SENS', 'BALANCE', 'CARRIER THRU'],
        'HRM_AUTO': ['VOICE', 'FORMANT', 'PAN', 'HRM MODE', 'KEY', 'D.LEVEL', 'HRM LEVEL'],
        'OSC_VOC': ['CARRIER', 'TONE', 'ATTACK', 'OCTAVE', 'MOD SENS', 'RELEASE', 'BALANCE'],
        // 失真 / 前置放大
        'DIST': ['TYPE', 'TONE', 'DIST', 'D.LEVEL', 'E.LEVEL'],
        'OSC_BOT': ['OSC', 'TONE', 'ATTACK', 'NOTE', 'MOD SENS', 'BALANCE'],
        'PREAMP': ['AMP TYPE', 'SPK TYPE', 'GAIN', 'T-COMP', 'BASS', 'MIDDLE', 'TREBLE', 'PRESENCE', 'MIC TYPE', 'MIC DIS', 'MIC POS', 'E.LEVEL'],
        // 动态 / 均衡
        'DYNAMICS': ['TYPE', 'DYNAMICS'],
        'EQ': ['LO', 'LO-MID', 'LO-MID FREQ', 'LO-MID Q', 'HI-MID', 'HI-MID FREQ', 'HI-MID Q', 'HIGH', 'LEVEL'],
        'ISOLATOR': ['BAND', 'RATE', 'BAND LEVEL', 'DEPTH', 'STEP RATE', 'WAVEFORM'],
        // 声像 / 立体声
        'MANUAL_PAN': ['POSITION'],
        'STEREO_ENHANCE': ['LOW CUT', 'HIGH CUT', 'ENHANCE'],
        // 音量调制
        'OCTAVE': ['OCTAVE', 'MODE', 'OCT.LEVEL'],
        'TREMOLO': ['RATE', 'DEPTH', 'WAVEFORM'],
        'AUTO_PAN': ['RATE', 'WAVEFORM', 'DEPTH', 'INIT PHASE', 'STEP RATE'],
        'VIBRATO': ['RATE', 'DEPTH', 'COLOR', 'D.LEVEL', 'E.LEVEL'],
        'PATTERN_SLICER': ['RATE', 'DUTY', 'ATTACK', 'PATTERN', 'DEPTH'],
        'STEP_SLICER': ['RATE', 'STEP MAX', 'STEP LENGTH', 'STEP LEVEL', 'DEPTH'],
        // 延迟
        'DELAY': ['TIME', 'FEEDBACK', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        'MOD_DELAY': ['TIME', 'FEEDBACK', 'MOD DEPTH', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        'PANNING_DELAY': ['TIME', 'FEEDBACK', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        'REVERSE_DELAY': ['TIME', 'FEEDBACK', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        'TAPE_ECHO1': ['REPEAT RATE', 'INTENSITY', 'D.LEVEL', 'BASS', 'TREBLE', 'E.LEVEL'],
        'TAPE_ECHO2': ['REPEAT RATE', 'INTENSITY', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        'ROLL1': ['TIME', 'FEEDBACK', 'ROLL', 'BALANCE'],
        'ROLL2': ['TIME', 'REPEAT', 'ROLL', 'BALANCE'],
        'GRANULAR_DELAY': ['TIME', 'FEEDBACK', 'E.LEVEL'],
        // 特殊效果
        'WARP': ['LEVEL'],
        'TWIST': ['RELEASE', 'RISE', 'FALL', 'LEVEL'],
        'FREEZE': ['ATTACK', 'RELEASE', 'DECAY', 'SUSTAIN', 'BALANCE'],
        // 混响
        'GATE_REVERB': ['TIME', 'PREDELAY', 'THRESHOLD', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        'CHORUS': ['RATE', 'DEPTH', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        'REVERSE_REVERB': ['TIME', 'PRE DELAY', 'GATE TIME', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        'REVERB': ['TIME', 'PRE DELAY', 'DENSITY', 'D.LEVEL', 'LOW CUT', 'HIGH CUT', 'E.LEVEL'],
        // Track FX Only
        'BEAT_SCATTER': ['TYPE', 'LENGTH'],
        'BEAT_REPEAT': ['TYPE', 'LENGTH'],
        'BEAT_SHIFT': ['TYPE', 'SHIFT'],
        'VINYL_FLICK': ['FLICK']
    };

    static FX_GENERIC = ['Param A', 'Param B', 'Param C', 'Param D', 'Param E', 'Param F', 'Param G', 'Param H'];

    // Map Parameter Names to Mapper Functions
    static PARAM_MAPPERS = {
        'RATE': SemanticMapper.mapRate,
        'DEPTH': SemanticMapper.mapDepth,
        'RESONANCE': (v) => v,
        'CUTOFF': SemanticMapper.mapFilterCutoff,
        'LOW CUT': SemanticMapper.mapFilterCutoff,
        'HIGH CUT': SemanticMapper.mapFilterCutoff,
        'HI CUT': SemanticMapper.mapFilterCutoff,
        'LO CUT': SemanticMapper.mapFilterCutoff,
        'STEP RATE': SemanticMapper.mapStepRate,
        'TIME': (v, ctx) => {
            if (ctx && (ctx.includes('REVERB') || ctx.includes('REV'))) return SemanticMapper.mapTimeReverb(v);
            if (ctx && (ctx.includes('DELAY'))) return SemanticMapper.mapTimeDelay(v);
            return v;
        },
        'GAIN': SemanticMapper.mapGain,
        'LEVEL': SemanticMapper.mapGain,
        'SW': SemanticMapper.mapOnOff,
        'SYNC': SemanticMapper.mapOnOff,
        'TYPE': (v, ctx) => {
            if (ctx === 'DYNAMICS') return SemanticMapper.mapTypeDynamics(v);
            if (ctx === 'PREAMP') return SemanticMapper.mapAmpType(v);
            return v;
        },
        'DYNAMICS': SemanticMapper.mapDynamics,
        'THRESHOLD': SemanticMapper.mapThreshold,
        'PATTERN': SemanticMapper.mapPattern,
        'PHRASE': SemanticMapper.mapPhrase,
        'STAGE': SemanticMapper.mapStage,
        'SAW': SemanticMapper.mapSaw,
        'OSC': SemanticMapper.mapSaw,
        'CARRIER': SemanticMapper.mapSaw,
        'Q': SemanticMapper.mapQ,
        'LO-MID Q': SemanticMapper.mapQ,
        'HI-MID Q': SemanticMapper.mapQ,
        'LO': SemanticMapper.mapGain,
        'HIGH': SemanticMapper.mapGain,
        'LO-MID': SemanticMapper.mapGain,
        'HI-MID': SemanticMapper.mapGain,
        'LO-MID FREQ': SemanticMapper.mapFilterCutoff,
        'HI-MID FREQ': SemanticMapper.mapFilterCutoff,
        'LOW GAIN': SemanticMapper.mapGain,
        'HI GAIN': SemanticMapper.mapGain
    };


    // --- Public API ---

    // --- Mappers from XmlParserFX.java ---

    static mapTwistRelease(value) {
        if (value === "0") return "FALL";
        if (value === "1") return "FADE";
        return value;
    }

    static mapMode(value) {
        if (value === "1") return "RC OLD";
        if (value === "2") return "RC NEW";
        return value;
    }

    static mapAmpType(value) {
        const map = {
            0: "JC-120", 1: "NATURAL CLEAN", 2: "FULL RANGE", 3: "COMBO CRUNCH",
            4: "STACK CRUNCH", 5: "HIGAIN STACK", 6: "POWER DRIVE",
            7: "EXTREM LEAD", 8: "CORE METAL"
        };
        return map[value] || "invalid";
    }

    static mapTypeDynamics(value) {
        const map = {
            0: "NATURALCOMP", 1: "MIXER COMP", 2: "LIVE COMP", 3: "NATURAL LIM",
            4: "HARD LIM", 5: "JINGL COMP", 6: "HARD COMP", 7: "SOFT COMP",
            8: "CLEAN COMP", 9: "DANCE COMP", 10: "ORCH COMP", 11: "VOCAL COMP",
            12: "ACOUSTIC", 13: "ROCK BAND", 14: "ORCHESTRA", 15: "LOW BOOST",
            16: "BRIGHTEN", 17: "DJs VOICE", 18: "PHONE VOX"
        };
        return map[value] || "invalid";
    }

    static mapDynamics(value) {
        let i = parseInt(value, 10);
        if (isNaN(i)) return value;
        if (i < 20) return "-" + (20 - i);
        if (i === 20) return "0";
        return "+" + (i - 20);
    }

    static mapQ(value) {
        const map = { 0: "0.5", 1: "1", 2: "2", 3: "4", 4: "8", 5: "16" };
        return map[value] || value;
    }

    static mapThreshold(value) {
        let i = parseInt(value, 10);
        if (i < 30) return -(30 - i) + "dB";
        if (i === 30) return "0dB";
        return "invalid";
    }

    static mapPattern(value) {
        let i = parseInt(value, 10);
        return isNaN(i) ? value : "P" + (i + 1);
    }

    static mapPhrase(value) {
        return "P" + value; // Java says P + int(value)
    }

    static mapStage(value) {
        const map = { 0: "4", 1: "8", 2: "12", 3: "BI PHASE" };
        return map[value] || "invalid";
    }

    static mapSaw(value) {
        const map = { 0: "SAW", 2: "VINTAGE_SAW", 3: "DETUNE_SAW", 4: "SQUARE", 5: "RECT" };
        return map[value] || "INVALID";
    }

    static mapFxParam(tagName, key, value) {
        // tagName ex: AA_LPF -> type = LPF
        // tagName ex: AA -> type = "Common" (or handled separately)

        let fxType = "";
        let paramName = key;

        if (tagName.includes('_')) {
            fxType = tagName.split('_').slice(1).join('_'); // AA_LPF -> LPF, AA_MOD_DELAY -> MOD_DELAY
        } else {
            fxType = "COMMON";
        }

        const paramList = this.FX_DEFS[fxType] || this.FX_GENERIC;

        // Convert 'A'...'Z' to index 0...25
        // Or if key is already 'RATE' (unlikely in RC0 XML which uses A,B,C), handle it.
        // XML keys are A, B, C...
        let index = -1;
        if (key.length === 1 && key >= 'A' && key <= 'Z') {
            index = key.charCodeAt(0) - 65; // A=0, B=1...
        }

        if (index >= 0 && index < paramList.length) {
            paramName = paramList[index];
        }

        // Apply Value Mapping
        let processedValue = value;
        const mapper = this.PARAM_MAPPERS[paramName];

        // Context-aware mapping logic
        if (paramName === 'TIME') {
            processedValue = this.PARAM_MAPPERS['TIME'](value, fxType);
        }
        else if (paramName === 'TYPE') {
            processedValue = this.PARAM_MAPPERS['TYPE'](value, fxType);
        }
        else if (paramName === 'RELEASE' && fxType === 'TWIST') {
            processedValue = this.mapTwistRelease(value);
        }
        else if (paramName === 'MODE' && (value === '1' || value === '2')) { // Generic RC Mode check
            processedValue = this.mapMode(value);
        }
        else if (paramName === 'LEVEL' && fxType === 'EQ') {
            processedValue = this.mapGain(value);
        }
        else if (paramName === 'PREDELAY') {
            processedValue = value; // GATE_REVERB 使用无空格版本
        }
        else if (mapper) {
            processedValue = mapper(value);
        }

        return { name: paramName, value: processedValue };
    }

    // --- Track Params (Ported/Updated from XmlParserTrack.java) ---
    static TRACK_LABELS = [
        "REVERSE", "1SHOT", "PAN", "PLAYLEVEL", "STARTMODE", "STOPMODE", "DUBMODE",
        "FX", "PLAYMODE", "MEASURE", "LPSYN SW", "LPSYN MODE", "TSYN SW", "TSYN MODE", "SPEED", "BOUNCEIN"
    ];

    static mapTrackParam(key, value) {
        // Key is A, B, C... maps to TRACK_LABELS
        let index = -1;
        if (key.length === 1 && key >= 'A' && key <= 'Z') {
            index = key.charCodeAt(0) - 65;
        }

        let name = key;
        if (index >= 0 && index < SemanticMapper.TRACK_LABELS.length) {
            name = SemanticMapper.TRACK_LABELS[index];
        }

        // Value Mapping based on Name
        let processedValue = value;
        switch (name) {
            case "REVERSE":
            case "1SHOT":
            case "FX":
            case "LPSYN SW":
            case "TSYN SW":
            case "BOUNCEIN":
                processedValue = this.mapOnOff(value);
                break;
            case "MEASURE":
                const m = parseInt(value, 10);
                if (m === 0) processedValue = "AUTO";
                else if (m === 1) processedValue = "FREE";
                else if (m <= 6) processedValue = "Note Value"; // Simplified
                else processedValue = (m - 7).toString();
                break;
            // Add more specific track value maps here if needed
        }

        return { name, value: processedValue };
    }
}
