(() => {
  // src/audio/rhythm/kits.ts
  var SOURCE_KIT_ROWS = Object.freeze([
    { index: 1, official_kit_name: "STUDIO", target_timbre: "Tight close-mic acoustic kit, controlled room", native_balanced_architecture: "4\u20138 velocity layers, 3\u20134 round robins, close/OH/room buses", browser_balanced_architecture: "2\u20134 layers, 2 round robins, pre-rendered room tail", formula_ids: "Sample playback + F20/F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 2, official_kit_name: "LIVE", target_timbre: "Larger room and stage bleed, broader stereo image", native_balanced_architecture: "Multi-mic sample set + early reflections/FDN room send", browser_balanced_architecture: "Dry samples + short pre-rendered room/FDN8 send", formula_ids: "F17,F18,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 3, official_kit_name: "LIGHT", target_timbre: "Small shells, short decay, low transient mass", native_balanced_architecture: "Short acoustic samples, light bus compression", browser_balanced_architecture: "Reduced layers and tail lengths", formula_ids: "F08,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 4, official_kit_name: "HEAVY", target_timbre: "Large shells, deep kick, parallel-compressed room", native_balanced_architecture: "Layered acoustic kit, parallel dynamics, room FDN", browser_balanced_architecture: "Layered samples, baked room and gentle bus compressor", formula_ids: "F08,F17,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 5, official_kit_name: "ROCK", target_timbre: "Strong attack, medium room, controlled gated ambience", native_balanced_architecture: "Attack/body sample layers, gated room return", browser_balanced_architecture: "2\u20134 layers, baked ambience, FDN8 gate", formula_ids: "F08,F17,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 6, official_kit_name: "METAL", target_timbre: "Click-forward kick, bright snare/cymbals, fast decay", native_balanced_architecture: "Multi-layer samples, transient shaper, narrow dynamic tails", browser_balanced_architecture: "Pre-shaped samples and light saturation", formula_ids: "F07,F08,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 7, official_kit_name: "JAZZ", target_timbre: "Ride-led, open dynamics, natural room", native_balanced_architecture: "High velocity resolution, cymbal round robins, minimal compression", browser_balanced_architecture: "Prioritize ride/cymbal variations; 2\u20134 layers", formula_ids: "F17,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 8, official_kit_name: "BRUSH", target_timbre: "Brush taps, sweeps and softer snare articulations", native_balanced_architecture: "Dedicated sweep/tap one-shots and loopable brush textures", browser_balanced_architecture: "Compressed brush sample set; sweep texture pool", formula_ids: "F15,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 9, official_kit_name: "CAJON", target_timbre: "Bass/body/slap articulations with wooden resonance", native_balanced_architecture: "Layered cajon samples + modal body resonator", browser_balanced_architecture: "Samples + 2\u20134 modal resonances", formula_ids: "F03,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 10, official_kit_name: "DRUM&BASS", target_timbre: "Tight breakbeat transients, electronic sub and edited hats", native_balanced_architecture: "Sample/procedural hybrid, transient slicing, parallel saturation", browser_balanced_architecture: "Pre-rendered break layers + procedural sub kick", formula_ids: "F07,F15,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 11, official_kit_name: "R&B", target_timbre: "Round kick, soft snare/clap, restrained hats", native_balanced_architecture: "Layered samples, gentle low-pass and bus compression", browser_balanced_architecture: "2\u20134 sample layers and low-cost bus compressor", formula_ids: "F02,F08,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 12, official_kit_name: "DANCE", target_timbre: "Club kick, bright clap and open electronic hats", native_balanced_architecture: "Procedural/sample hybrid with sidechain-ready envelopes", browser_balanced_architecture: "Procedural kick + one-shot clap/hats", formula_ids: "F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 13, official_kit_name: "TECHNO", target_timbre: "Hard electronic kick, resonant percussion, saturated hats", native_balanced_architecture: "Procedural kick/toms + oversampled saturation", browser_balanced_architecture: "Procedural oscillators + 2x ADAA", formula_ids: "F03,F07,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 14, official_kit_name: "DANCE BEATS", target_timbre: "Layered modern dance kit with broad macro range", native_balanced_architecture: "Sample/procedural layers, macro-driven transient/body balance", browser_balanced_architecture: "Pre-rendered layers, selective procedural kick", formula_ids: "F08,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 15, official_kit_name: "HIPHOP", target_timbre: "Low-passed drums, clap/snare layering, vinyl coloration", native_balanced_architecture: "Layered one-shots + saturation + optional wow/noise", browser_balanced_architecture: "Samples + ADAA + cheap filtered noise", formula_ids: "F02,F07,F26,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." },
    { index: 16, official_kit_name: "808+909", target_timbre: "Classic analog drum-machine hybrid", native_balanced_architecture: "Procedural bridged-T kick/toms, noise snare/clap/hats, nonlinear accent", browser_balanced_architecture: "Same procedural core in WASM; deterministic random source", formula_ids: "F07,F24", evidence_status: "Kit name is official; sample/circuit architecture is a clean-room design because Roland does not publish the original assets/topology." }
  ]);
  var CLEAN_ROOM_TIMBRES = Object.freeze([
    { kickHz: 78, kickPitchDropHz: 74, kickDecayMs: 250, snareHz: 190, snareNoiseMix: 0.6, snareDecayMs: 160, hatCutoffHz: 9200, hatDecayMs: 62, tomHz: 142, tomDecayMs: 230, roomMix: 0.12, saturation: 0.06, velocityExponent: 0.88, roundRobinCount: 3 },
    { kickHz: 70, kickPitchDropHz: 64, kickDecayMs: 300, snareHz: 180, snareNoiseMix: 0.7, snareDecayMs: 205, hatCutoffHz: 8600, hatDecayMs: 95, tomHz: 132, tomDecayMs: 260, roomMix: 0.3, saturation: 0.08, velocityExponent: 0.84, roundRobinCount: 4 },
    { kickHz: 90, kickPitchDropHz: 60, kickDecayMs: 175, snareHz: 220, snareNoiseMix: 0.54, snareDecayMs: 125, hatCutoffHz: 7800, hatDecayMs: 44, tomHz: 165, tomDecayMs: 160, roomMix: 0.04, saturation: 0.02, velocityExponent: 0.96, roundRobinCount: 2 },
    { kickHz: 58, kickPitchDropHz: 52, kickDecayMs: 390, snareHz: 165, snareNoiseMix: 0.66, snareDecayMs: 220, hatCutoffHz: 7600, hatDecayMs: 78, tomHz: 105, tomDecayMs: 310, roomMix: 0.24, saturation: 0.19, velocityExponent: 0.8, roundRobinCount: 3 },
    { kickHz: 68, kickPitchDropHz: 82, kickDecayMs: 325, snareHz: 205, snareNoiseMix: 0.64, snareDecayMs: 185, hatCutoffHz: 1e4, hatDecayMs: 70, tomHz: 150, tomDecayMs: 215, roomMix: 0.16, saturation: 0.13, velocityExponent: 0.82, roundRobinCount: 3 },
    { kickHz: 62, kickPitchDropHz: 105, kickDecayMs: 285, snareHz: 240, snareNoiseMix: 0.82, snareDecayMs: 130, hatCutoffHz: 11800, hatDecayMs: 42, tomHz: 178, tomDecayMs: 155, roomMix: 0.07, saturation: 0.24, velocityExponent: 0.72, roundRobinCount: 4 },
    { kickHz: 82, kickPitchDropHz: 42, kickDecayMs: 360, snareHz: 175, snareNoiseMix: 0.5, snareDecayMs: 240, hatCutoffHz: 10800, hatDecayMs: 170, tomHz: 125, tomDecayMs: 290, roomMix: 0.1, saturation: 0.01, velocityExponent: 0.72, roundRobinCount: 5 },
    { kickHz: 92, kickPitchDropHz: 35, kickDecayMs: 260, snareHz: 280, snareNoiseMix: 0.92, snareDecayMs: 290, hatCutoffHz: 7200, hatDecayMs: 110, tomHz: 210, tomDecayMs: 205, roomMix: 0.05, saturation: 0.03, velocityExponent: 1.12, roundRobinCount: 4 },
    { kickHz: 78, kickPitchDropHz: 32, kickDecayMs: 240, snareHz: 310, snareNoiseMix: 0.48, snareDecayMs: 170, hatCutoffHz: 6500, hatDecayMs: 68, tomHz: 195, tomDecayMs: 260, roomMix: 0.08, saturation: 0.07, velocityExponent: 0.92, roundRobinCount: 3 },
    { kickHz: 55, kickPitchDropHz: 110, kickDecayMs: 220, snareHz: 220, snareNoiseMix: 0.86, snareDecayMs: 115, hatCutoffHz: 11200, hatDecayMs: 38, tomHz: 120, tomDecayMs: 145, roomMix: 0.03, saturation: 0.22, velocityExponent: 0.76, roundRobinCount: 4 },
    { kickHz: 72, kickPitchDropHz: 50, kickDecayMs: 295, snareHz: 185, snareNoiseMix: 0.58, snareDecayMs: 205, hatCutoffHz: 8200, hatDecayMs: 60, tomHz: 135, tomDecayMs: 225, roomMix: 0.11, saturation: 0.09, velocityExponent: 0.88, roundRobinCount: 3 },
    { kickHz: 49, kickPitchDropHz: 100, kickDecayMs: 360, snareHz: 255, snareNoiseMix: 0.78, snareDecayMs: 150, hatCutoffHz: 12200, hatDecayMs: 48, tomHz: 165, tomDecayMs: 180, roomMix: 0.08, saturation: 0.16, velocityExponent: 0.74, roundRobinCount: 2 },
    { kickHz: 44, kickPitchDropHz: 120, kickDecayMs: 440, snareHz: 235, snareNoiseMix: 0.7, snareDecayMs: 140, hatCutoffHz: 12600, hatDecayMs: 43, tomHz: 185, tomDecayMs: 190, roomMix: 0.02, saturation: 0.3, velocityExponent: 0.7, roundRobinCount: 3 },
    { kickHz: 52, kickPitchDropHz: 108, kickDecayMs: 335, snareHz: 215, snareNoiseMix: 0.76, snareDecayMs: 145, hatCutoffHz: 11600, hatDecayMs: 50, tomHz: 155, tomDecayMs: 170, roomMix: 0.04, saturation: 0.2, velocityExponent: 0.76, roundRobinCount: 3 },
    { kickHz: 50, kickPitchDropHz: 88, kickDecayMs: 365, snareHz: 195, snareNoiseMix: 0.72, snareDecayMs: 175, hatCutoffHz: 9400, hatDecayMs: 68, tomHz: 140, tomDecayMs: 220, roomMix: 0.12, saturation: 0.18, velocityExponent: 0.8, roundRobinCount: 4 },
    { kickHz: 58, kickPitchDropHz: 102, kickDecayMs: 410, snareHz: 205, snareNoiseMix: 0.88, snareDecayMs: 200, hatCutoffHz: 6800, hatDecayMs: 55, tomHz: 130, tomDecayMs: 210, roomMix: 0.06, saturation: 0.26, velocityExponent: 0.78, roundRobinCount: 3 }
  ]);
  if (SOURCE_KIT_ROWS.length !== 16 || CLEAN_ROOM_TIMBRES.length !== SOURCE_KIT_ROWS.length) {
    throw new Error("The clean-room kit catalog must stay aligned to the 16 source kit rows");
  }
  var DRUM_KIT_CATALOG = Object.freeze(
    SOURCE_KIT_ROWS.map((row, index) => Object.freeze({
      id: `kit-${String(row.index).padStart(2, "0")}`,
      index: row.index,
      officialName: row.official_kit_name,
      targetTimbre: row.target_timbre,
      nativeArchitecture: row.native_balanced_architecture,
      browserArchitecture: row.browser_balanced_architecture,
      formulaIds: Object.freeze(row.formula_ids.split(",").map((formula) => formula.trim())),
      evidenceStatus: row.evidence_status,
      timbreProvenance: "clean-room-procedural",
      timbre: Object.freeze({ ...CLEAN_ROOM_TIMBRES[index] })
    }))
  );
  function getDrumKitByIndex(index) {
    return DRUM_KIT_CATALOG[index - 1];
  }
  function getDrumKitByName(name) {
    const normalized = name.toUpperCase();
    return DRUM_KIT_CATALOG.find((kit) => kit.officialName === normalized);
  }

  // src/audio/rhythm/voicePool.ts
  var INSTRUMENT_INDEX = {
    kick: 0,
    snare: 1,
    closedHat: 2,
    openHat: 3,
    tom: 4,
    ride: 5,
    clap: 6,
    brush: 7
  };
  var POOL_INSTRUMENTS = ["kick", "snare", "closedHat", "openHat", "tom", "ride", "clap", "brush"];
  var PENDING_CAPACITY = 4096;
  var DrumVoicePool = class {
    sampleRate;
    kit;
    maxVoices;
    voices;
    pendingFrames = new Float64Array(PENDING_CAPACITY);
    pendingSequences = new Float64Array(PENDING_CAPACITY);
    pendingSeeds = new Uint32Array(PENDING_CAPACITY);
    pendingVelocities = new Uint8Array(PENDING_CAPACITY);
    pendingInstruments = new Uint8Array(PENDING_CAPACITY);
    pendingHead = 0;
    pendingTail = 0;
    roundRobinCounters = new Uint32Array(POOL_INSTRUMENTS.length);
    nextSequence = 0;
    lastRenderEnd = null;
    _peakVoices = 0;
    _stolenVoices = 0;
    _startedVoices = 0;
    constructor(options) {
      if (!Number.isFinite(options.sampleRate) || options.sampleRate < 8e3) {
        throw new RangeError("sampleRate must be a finite value of at least 8000 Hz");
      }
      this.sampleRate = options.sampleRate;
      this.kit = resolveKit(options.kit);
      this.maxVoices = options.maxVoices ?? 16;
      if (!Number.isSafeInteger(this.maxVoices) || this.maxVoices < 1 || this.maxVoices > 64) {
        throw new RangeError("maxVoices must be an integer between 1 and 64");
      }
      this.voices = Array.from({ length: this.maxVoices }, () => ({
        instrumentIndex: -1,
        sequence: 0,
        seed: 0,
        velocity: 0,
        startFrame: 0,
        endFrame: 0,
        roundRobin: 0,
        amplitude: 0
      }));
    }
    get activeVoiceCount() {
      let count = 0;
      for (let index = 0; index < this.voices.length; index += 1) {
        if (this.voices[index].instrumentIndex >= 0) count += 1;
      }
      return count;
    }
    get pendingEventCount() {
      return this.pendingTail - this.pendingHead;
    }
    get peakVoiceCount() {
      return this._peakVoices;
    }
    get stolenVoiceCount() {
      return this._stolenVoices;
    }
    get startedVoiceCount() {
      return this._startedVoices;
    }
    /** Returns the next round-robin slot that would be assigned for an instrument. */
    peekRoundRobin(instrument) {
      const instrumentIndex = INSTRUMENT_INDEX[instrument];
      return (this.roundRobinCounters[instrumentIndex] ?? 0) % this.kit.timbre.roundRobinCount;
    }
    /** Convenience entry point for clean-room event objects; used outside process(). */
    schedule(event) {
      assertEvent(event);
      this.scheduleFrame(event.instrument, event.velocity, event.seed, event.frame);
    }
    /**
     * Schedule primitives into the fixed typed-array queue. This method performs no object,
     * array, Map, or node allocation and is safe for the AudioWorklet render callback.
     */
    scheduleFrame(instrument, velocity, seed, frame) {
      const instrumentIndex = INSTRUMENT_INDEX[instrument];
      if (instrumentIndex === void 0) throw new RangeError(`Unknown drum instrument: ${String(instrument)}`);
      if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
        throw new RangeError("event.velocity must be an integer from 1 to 127");
      }
      if (!Number.isSafeInteger(seed)) throw new RangeError("event.seed must be a safe integer");
      if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("event.frame must be a non-negative safe integer");
      if (this.lastRenderEnd !== null && frame < this.lastRenderEnd) {
        throw new RangeError("Cannot schedule a drum event into audio frames that have already been rendered");
      }
      this.ensureQueueSpace();
      const sequence = this.nextSequence++;
      let insertion = this.pendingTail;
      if (this.pendingTail > this.pendingHead && frame < this.pendingFrames[this.pendingTail - 1]) {
        let low = this.pendingHead;
        let high = this.pendingTail;
        while (low < high) {
          const middle = low + high >>> 1;
          if (this.pendingFrames[middle] <= frame) low = middle + 1;
          else high = middle;
        }
        insertion = low;
        for (let index = this.pendingTail; index > insertion; index -= 1) {
          this.copyPending(index - 1, index);
        }
      }
      this.pendingFrames[insertion] = frame;
      this.pendingSequences[insertion] = sequence;
      this.pendingSeeds[insertion] = seed >>> 0;
      this.pendingVelocities[insertion] = velocity;
      this.pendingInstruments[insertion] = instrumentIndex;
      this.pendingTail += 1;
    }
    scheduleMany(events) {
      for (let index = 0; index < events.length; index += 1) this.schedule(events[index]);
    }
    /** Render a mono block beginning at an absolute integer sample frame. */
    renderBlock(startFrame, frameCount) {
      if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
        throw new RangeError("frameCount must be a non-negative safe integer");
      }
      const output = new Float32Array(frameCount);
      this.renderInto(startFrame, output);
      return output;
    }
    /** Render directly into caller-owned storage; no per-call output allocation. */
    renderInto(startFrame, output) {
      if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
        throw new RangeError("startFrame must be a non-negative safe integer");
      }
      const frameCount = output.length;
      if (this.lastRenderEnd !== null && startFrame < this.lastRenderEnd) {
        throw new RangeError("renderBlock must advance monotonically on the absolute sample-frame timeline");
      }
      const endFrame = startFrame + frameCount;
      if (!Number.isSafeInteger(endFrame)) throw new RangeError("render range exceeds safe sample-frame precision");
      for (let offset = 0; offset < frameCount; offset += 1) {
        const frame = startFrame + offset;
        for (let index = 0; index < this.voices.length; index += 1) {
          const voice = this.voices[index];
          if (voice.instrumentIndex >= 0 && frame >= voice.endFrame) voice.instrumentIndex = -1;
        }
        while (this.pendingHead < this.pendingTail && this.pendingFrames[this.pendingHead] <= frame) {
          const eventFrame = this.pendingFrames[this.pendingHead];
          const sequence = this.pendingSequences[this.pendingHead];
          const seed = this.pendingSeeds[this.pendingHead];
          const velocity = this.pendingVelocities[this.pendingHead];
          const instrumentIndex = this.pendingInstruments[this.pendingHead];
          this.pendingHead += 1;
          const duration = this.voiceDurationFrames(instrumentIndex);
          if (eventFrame + duration > frame) {
            this.startVoice(instrumentIndex, velocity, seed, eventFrame, sequence, duration);
          }
        }
        let sample = 0;
        for (let voiceIndex = 0; voiceIndex < this.voices.length; voiceIndex += 1) {
          const voice = this.voices[voiceIndex];
          if (voice.instrumentIndex < 0) continue;
          if (frame >= voice.endFrame) {
            voice.instrumentIndex = -1;
            continue;
          }
          sample += this.sampleVoice(voice, frame);
        }
        const drive = 1 + this.kit.timbre.saturation * 3;
        output[offset] = Math.tanh(sample * drive) / Math.tanh(drive);
      }
      for (let index = 0; index < this.voices.length; index += 1) {
        const voice = this.voices[index];
        if (voice.instrumentIndex >= 0 && endFrame >= voice.endFrame) voice.instrumentIndex = -1;
      }
      this.lastRenderEnd = endFrame;
      this.compactConsumedQueue();
    }
    /** Reset voices, queue, counters, and the absolute render cursor. */
    reset() {
      this.pendingHead = 0;
      this.pendingTail = 0;
      this.roundRobinCounters.fill(0);
      for (let index = 0; index < this.voices.length; index += 1) {
        this.voices[index].instrumentIndex = -1;
      }
      this.nextSequence = 0;
      this.lastRenderEnd = null;
      this._peakVoices = 0;
      this._stolenVoices = 0;
      this._startedVoices = 0;
    }
    ensureQueueSpace() {
      if (this.pendingTail < PENDING_CAPACITY) return;
      this.compactConsumedQueue();
      if (this.pendingTail >= PENDING_CAPACITY) {
        throw new RangeError(`Drum event queue capacity (${PENDING_CAPACITY}) exceeded`);
      }
    }
    compactConsumedQueue() {
      if (this.pendingHead === 0) return;
      if (this.pendingHead === this.pendingTail) {
        this.pendingHead = 0;
        this.pendingTail = 0;
        return;
      }
      if (this.pendingHead < 128 && this.pendingTail < PENDING_CAPACITY) return;
      const count = this.pendingTail - this.pendingHead;
      this.pendingFrames.copyWithin(0, this.pendingHead, this.pendingTail);
      this.pendingSequences.copyWithin(0, this.pendingHead, this.pendingTail);
      this.pendingSeeds.copyWithin(0, this.pendingHead, this.pendingTail);
      this.pendingVelocities.copyWithin(0, this.pendingHead, this.pendingTail);
      this.pendingInstruments.copyWithin(0, this.pendingHead, this.pendingTail);
      this.pendingHead = 0;
      this.pendingTail = count;
    }
    copyPending(from, to) {
      this.pendingFrames[to] = this.pendingFrames[from];
      this.pendingSequences[to] = this.pendingSequences[from];
      this.pendingSeeds[to] = this.pendingSeeds[from];
      this.pendingVelocities[to] = this.pendingVelocities[from];
      this.pendingInstruments[to] = this.pendingInstruments[from];
    }
    voiceDurationFrames(instrumentIndex) {
      const t = this.kit.timbre;
      const durationMs = instrumentIndex === INSTRUMENT_INDEX.kick ? t.kickDecayMs : instrumentIndex === INSTRUMENT_INDEX.snare || instrumentIndex === INSTRUMENT_INDEX.clap ? t.snareDecayMs : instrumentIndex === INSTRUMENT_INDEX.tom ? t.tomDecayMs : instrumentIndex === INSTRUMENT_INDEX.openHat || instrumentIndex === INSTRUMENT_INDEX.ride ? Math.max(t.hatDecayMs * 2.8, 90) : instrumentIndex === INSTRUMENT_INDEX.brush ? Math.max(t.snareDecayMs * 1.7, 160) : t.hatDecayMs;
      return Math.max(1, Math.round(this.sampleRate * durationMs / 1e3));
    }
    startVoice(instrumentIndex, velocity, seed, startFrame, sequence, duration) {
      let slotIndex = -1;
      for (let index = 0; index < this.voices.length; index += 1) {
        if (this.voices[index].instrumentIndex < 0) {
          slotIndex = index;
          break;
        }
      }
      if (slotIndex < 0) {
        slotIndex = 0;
        for (let index = 1; index < this.voices.length; index += 1) {
          const candidate = this.voices[index];
          const oldest = this.voices[slotIndex];
          if (candidate.startFrame < oldest.startFrame || candidate.startFrame === oldest.startFrame && candidate.sequence < oldest.sequence) {
            slotIndex = index;
          }
        }
        this._stolenVoices += 1;
      }
      const voice = this.voices[slotIndex];
      const rrCounter = this.roundRobinCounters[instrumentIndex];
      const roundRobin = rrCounter % this.kit.timbre.roundRobinCount;
      this.roundRobinCounters[instrumentIndex] = rrCounter + 1;
      const normalizedVelocity = velocity / 127;
      voice.instrumentIndex = instrumentIndex;
      voice.sequence = sequence;
      voice.seed = seed;
      voice.velocity = velocity;
      voice.startFrame = startFrame;
      voice.endFrame = startFrame + duration;
      voice.roundRobin = roundRobin;
      voice.amplitude = Math.pow(normalizedVelocity, this.kit.timbre.velocityExponent) * (0.965 + roundRobin * 0.017);
      this._startedVoices += 1;
      const active = this.activeVoiceCount;
      if (active > this._peakVoices) this._peakVoices = active;
    }
    sampleVoice(voice, absoluteFrame) {
      const instrument = POOL_INSTRUMENTS[voice.instrumentIndex];
      const ageFrames = absoluteFrame - voice.startFrame;
      const age = ageFrames / this.sampleRate;
      const duration = (voice.endFrame - voice.startFrame) / this.sampleRate;
      const t = this.kit.timbre;
      const rrDetune = 1 + (voice.roundRobin - (t.roundRobinCount - 1) / 2) * 15e-4;
      const envelope = Math.exp(-6.2 * age / Math.max(duration, 1e-3));
      let signal;
      switch (instrument) {
        case "kick": {
          const initialHz = (t.kickHz + t.kickPitchDropHz) * rrDetune;
          const settledHz = t.kickHz * rrDetune;
          const pitchDropTime = 0.018 + voice.roundRobin % 3 * 2e-3;
          const cycles = settledHz * age + (initialHz - settledHz) * pitchDropTime * (1 - Math.exp(-age / pitchDropTime));
          const click = deterministicNoise(voice.seed, ageFrames) * Math.exp(-age / 6e-3) * 0.13;
          signal = Math.sin(2 * Math.PI * cycles) * envelope + click;
          break;
        }
        case "snare": {
          const noise = highPassedNoise(voice.seed, ageFrames);
          const body = Math.sin(2 * Math.PI * (t.snareHz * rrDetune) * age) * Math.exp(-age / Math.max(duration * 0.28, 0.02));
          signal = noise * t.snareNoiseMix + body * (1 - t.snareNoiseMix) * 0.75;
          signal *= envelope;
          break;
        }
        case "clap": {
          const pulse = Math.exp(-age / Math.max(duration * 0.2, 0.012)) + 0.55 * Math.exp(-Math.abs(age - 0.014) / Math.max(duration * 0.16, 0.01)) + 0.32 * Math.exp(-Math.abs(age - 0.029) / Math.max(duration * 0.13, 8e-3));
          signal = highPassedNoise(voice.seed, ageFrames) * pulse * 0.62;
          break;
        }
        case "closedHat":
        case "openHat":
        case "ride": {
          const bright = highPassedNoise(voice.seed, ageFrames);
          const metallic = Math.sin(2 * Math.PI * t.hatCutoffHz * age) + 0.45 * Math.sin(2 * Math.PI * t.hatCutoffHz * 1.37 * age) + 0.28 * Math.sin(2 * Math.PI * t.hatCutoffHz * 1.91 * age);
          const hatDecay = instrument === "closedHat" ? duration * 0.3 : duration * 0.65;
          const rideWeight = instrument === "ride" ? 0.46 : 0.22;
          signal = (bright * (1 - rideWeight) + metallic * rideWeight) * Math.exp(-age / Math.max(hatDecay, 8e-3));
          break;
        }
        case "tom": {
          const pitchDropTime = 0.045;
          const cycles = t.tomHz * age + t.tomHz * 0.75 * pitchDropTime * (1 - Math.exp(-age / pitchDropTime));
          signal = Math.sin(2 * Math.PI * cycles) * envelope + highPassedNoise(voice.seed, ageFrames) * 0.08 * envelope;
          break;
        }
        case "brush": {
          const smoothNoise = deterministicNoise(voice.seed, ageFrames) * 0.5 + deterministicNoise(voice.seed, Math.max(0, ageFrames - 1)) * 0.35 + deterministicNoise(voice.seed, Math.max(0, ageFrames - 2)) * 0.15;
          signal = smoothNoise * envelope * 0.5 + Math.sin(2 * Math.PI * (t.snareHz * 0.65) * age) * envelope * 0.1;
          break;
        }
      }
      return signal * voice.amplitude * (1 - t.roomMix * 0.22);
    }
  };
  function resolveKit(kit) {
    if (typeof kit === "number") {
      const match = getDrumKitByIndex(kit);
      if (match) return match;
    } else if (typeof kit === "string") {
      const match = getDrumKitByName(kit);
      if (match) return match;
    } else if (kit && kit.timbreProvenance === "clean-room-procedural") {
      return kit;
    }
    throw new RangeError(`Unknown drum kit: ${String(kit)}`);
  }
  function assertEvent(event) {
    if (!Number.isSafeInteger(event.frame) || event.frame < 0) {
      throw new RangeError("event.frame must be a non-negative safe integer");
    }
    if (!Number.isInteger(event.velocity) || event.velocity < 1 || event.velocity > 127) {
      throw new RangeError("event.velocity must be an integer from 1 to 127");
    }
    if (!Number.isSafeInteger(event.seed)) throw new RangeError("event.seed must be a safe integer");
    if (event.provenance !== "clean-room-generated") throw new RangeError("DrumVoicePool accepts clean-room generated events only");
  }
  function deterministicNoise(seed, sampleIndex) {
    let value = (seed ^ Math.imul(sampleIndex + 1, 2654435761)) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 2146121005);
    value ^= value >>> 15;
    value = Math.imul(value, 2221713035);
    value ^= value >>> 16;
    return (value >>> 0) / 2147483647 - 1;
  }
  function highPassedNoise(seed, sampleIndex) {
    return (deterministicNoise(seed, sampleIndex) - deterministicNoise(seed, Math.max(0, sampleIndex - 1))) * 0.5;
  }

  // src/audio/rhythm/timing.ts
  var RHYTHM_QUANTIZE_GRIDS = ["1/16", "1/8", "1/4"];
  var GRID_STEPS = {
    "1/16": 1,
    "1/8": 2,
    "1/4": 4
  };
  function quantizeRhythmStep(step, grid) {
    if (!Number.isSafeInteger(step) || step < 0) throw new RangeError("Rhythm step must be a non-negative safe integer");
    const gridSteps = GRID_STEPS[grid];
    if (gridSteps === void 0) throw new RangeError(`Unsupported rhythm quantize grid: ${String(grid)}`);
    return Math.round(step / gridSteps) * gridSteps;
  }
  function getRhythmEventFrame(startFrame, barIndex, eventStep, stepsPerBar, sampleRate, bpm, swingPercent, quantizeGrid) {
    const quantizedStep = quantizeRhythmStep(eventStep, quantizeGrid);
    if (!Number.isSafeInteger(barIndex) || barIndex < 0) throw new RangeError("Rhythm bar index must be non-negative");
    if (!Number.isSafeInteger(stepsPerBar) || stepsPerBar < 1) throw new RangeError("stepsPerBar must be positive");
    if (!Number.isSafeInteger(startFrame) || startFrame < 0) throw new RangeError("startFrame must be non-negative");
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(bpm) || bpm <= 0) {
      throw new RangeError("sampleRate and BPM must be positive and finite");
    }
    if (!Number.isInteger(swingPercent) || swingPercent < 50 || swingPercent > 75) {
      throw new RangeError("swingPercent must be an integer from 50 to 75");
    }
    const absoluteStep = barIndex * stepsPerBar + quantizedStep;
    if (!Number.isSafeInteger(absoluteStep)) throw new RangeError("Rhythm step exceeds safe sample-frame precision");
    const sampleFramesPerBeat = sampleRate * 60 / bpm;
    if (absoluteStep % 4 === 2 && swingPercent > 50) {
      const beatPosition = absoluteStep / 4 + (swingPercent - 50) / 100;
      return startFrame + Math.round(beatPosition * sampleFramesPerBeat);
    }
    return startFrame + Math.round(absoluteStep * sampleRate * 15 / bpm);
  }

  // src/audio/worklet/RhythmProcessor.ts
  var FallbackPort = class {
    onmessage = null;
    postMessage(_message) {
    }
  };
  var FallbackProcessor = class {
    port = new FallbackPort();
  };
  var workletGlobals = globalThis;
  var WorkletProcessorBase = workletGlobals.AudioWorkletProcessor ?? FallbackProcessor;
  var RhythmWorkletCore = class {
    sampleRate;
    configuration = null;
    measurePhaseSnapshot = null;
    pool = null;
    nextBarToSchedule = 0;
    lastRenderedFrameEnd = null;
    phaseEpoch = 0;
    constructor(sampleRate) {
      if (!Number.isFinite(sampleRate) || sampleRate < 8e3) {
        throw new RangeError("Rhythm worklet sample rate must be at least 8000 Hz");
      }
      this.sampleRate = sampleRate;
    }
    get isPlaying() {
      return this.configuration !== null && this.pool !== null;
    }
    /** End of the last successfully rendered absolute-frame block, if any. */
    get expectedNextFrame() {
      return this.lastRenderedFrameEnd;
    }
    get currentPhaseEpoch() {
      return this.phaseEpoch;
    }
    /** Snapshot construction is control-path only and is never called from renderInto(). */
    getMeasurePhaseSnapshot(requestId) {
      const snapshot = this.measurePhaseSnapshot;
      if (!snapshot || !Number.isSafeInteger(requestId) || requestId < 0) return null;
      return snapshot.requestId === requestId ? snapshot : { ...snapshot, requestId };
    }
    configure(configuration, phaseRequestId = 0) {
      if (configuration.sampleRate !== this.sampleRate) {
        throw new RangeError("Rhythm worklet sample rate does not match its AudioContext");
      }
      if (!Number.isFinite(configuration.bpm) || configuration.bpm <= 0) {
        throw new RangeError("Rhythm worklet BPM must be positive and finite");
      }
      if (!Number.isInteger(configuration.swingPercent) || configuration.swingPercent < 50 || configuration.swingPercent > 75) {
        throw new RangeError("Rhythm worklet swing must be an integer from 50 to 75 percent");
      }
      if (!RHYTHM_QUANTIZE_GRIDS.includes(configuration.quantizeGrid)) {
        throw new RangeError("Rhythm worklet quantize grid is unsupported");
      }
      if (!Number.isSafeInteger(configuration.startFrame) || configuration.startFrame < 0) {
        throw new RangeError("Rhythm worklet startFrame must be a non-negative safe integer");
      }
      if (!Number.isSafeInteger(configuration.stepsPerBar) || configuration.stepsPerBar < 1) {
        throw new RangeError("Rhythm worklet stepsPerBar must be a positive integer");
      }
      if (!Number.isSafeInteger(phaseRequestId) || phaseRequestId < 0) {
        throw new RangeError("Rhythm worklet phase request id must be a non-negative safe integer");
      }
      if (this.phaseEpoch >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Rhythm worklet phase epoch is exhausted");
      }
      this.configuration = configuration;
      this.pool = new DrumVoicePool({
        sampleRate: this.sampleRate,
        kit: configuration.kitIndex,
        maxVoices: configuration.maxVoices
      });
      this.nextBarToSchedule = 0;
      this.phaseEpoch += 1;
      const nextMeasureFrame = configuration.startFrame + Math.round(configuration.stepsPerBar * this.sampleRate * 15 / configuration.bpm);
      this.measurePhaseSnapshot = Number.isSafeInteger(nextMeasureFrame) ? {
        type: "measure-phase",
        available: true,
        requestId: phaseRequestId,
        epoch: this.phaseEpoch,
        originFrame: configuration.startFrame,
        nextMeasureFrame,
        sampleRate: this.sampleRate,
        bpm: configuration.bpm,
        stepsPerBar: configuration.stepsPerBar
      } : null;
    }
    stop() {
      if (this.phaseEpoch < Number.MAX_SAFE_INTEGER) this.phaseEpoch += 1;
      this.pool?.reset();
      this.pool = null;
      this.configuration = null;
      this.measurePhaseSnapshot = null;
      this.nextBarToSchedule = 0;
      this.lastRenderedFrameEnd = null;
    }
    /** Render one actual-sized Web Audio block; the caller supplies the global frame. */
    renderBlock(startFrame, frameCount) {
      const output = new Float32Array(frameCount);
      this.renderInto(startFrame, output);
      return output;
    }
    /** Render into caller-owned storage. This is the only path used from process(). */
    renderInto(startFrame, output) {
      if (!Number.isSafeInteger(startFrame) || startFrame < 0) {
        throw new RangeError("Rhythm render startFrame must be a non-negative safe integer");
      }
      const endFrame = startFrame + output.length;
      if (!Number.isSafeInteger(endFrame)) {
        throw new RangeError("Rhythm render range exceeds safe sample-frame precision");
      }
      if (!this.configuration || !this.pool) {
        output.fill(0);
        return true;
      }
      if (this.lastRenderedFrameEnd !== null && startFrame < this.lastRenderedFrameEnd) {
        output.fill(0);
        return false;
      }
      this.scheduleBarsThrough(endFrame);
      this.pool.renderInto(startFrame, output);
      this.lastRenderedFrameEnd = endFrame;
      return true;
    }
    get activeVoiceCount() {
      return this.pool?.activeVoiceCount ?? 0;
    }
    get peakVoiceCount() {
      return this.pool?.peakVoiceCount ?? 0;
    }
    get stolenVoiceCount() {
      return this.pool?.stolenVoiceCount ?? 0;
    }
    scheduleBarsThrough(blockEndFrame) {
      const configuration = this.configuration;
      const pool = this.pool;
      while (true) {
        const firstStep = this.nextBarToSchedule * configuration.stepsPerBar;
        const barFrame = configuration.startFrame + Math.round(firstStep * this.sampleRate * 15 / configuration.bpm);
        if (barFrame >= blockEndFrame) break;
        for (let index = 0; index < configuration.eventTemplate.length; index += 1) {
          const template = configuration.eventTemplate[index];
          const frame = getRhythmEventFrame(
            configuration.startFrame,
            this.nextBarToSchedule,
            template.step,
            configuration.stepsPerBar,
            this.sampleRate,
            configuration.bpm,
            configuration.swingPercent,
            configuration.quantizeGrid
          );
          const seed = (template.seed ^ Math.imul(this.nextBarToSchedule + 1, 2654435761)) >>> 0;
          pool.scheduleFrame(template.instrument, template.velocity, seed, frame);
        }
        this.nextBarToSchedule += 1;
      }
    }
  };
  var RhythmWorkletProcessor = class extends WorkletProcessorBase {
    core;
    staleEpisodeStartFrame = null;
    staleEpisodeExpectedFrame = null;
    phaseRequestId = null;
    phaseAcknowledged = false;
    phaseInvalidated = false;
    sharedPhaseEpoch;
    constructor() {
      super();
      this.core = new RhythmWorkletCore(workletGlobals.sampleRate ?? 44100);
      const phaseEpochBuffer = this.processorOptions?.phaseEpochBuffer;
      this.sharedPhaseEpoch = typeof SharedArrayBuffer !== "undefined" && phaseEpochBuffer instanceof SharedArrayBuffer ? new Int32Array(phaseEpochBuffer) : null;
      this.port.onmessage = (event) => {
        const message = event.data;
        if (message?.type === "start") {
          this.setSharedPhaseEpoch(0);
          this.core.configure(message.configuration, message.requestId);
          this.phaseRequestId = message.requestId;
          this.phaseAcknowledged = false;
          this.phaseInvalidated = false;
        } else if (message?.type === "stop") {
          this.setSharedPhaseEpoch(0);
          this.core.stop();
          this.phaseRequestId = message.requestId;
          this.phaseAcknowledged = true;
          this.phaseInvalidated = true;
          this.staleEpisodeStartFrame = null;
          this.staleEpisodeExpectedFrame = null;
          this.port.postMessage({
            type: "measure-phase",
            available: false,
            requestId: message.requestId,
            epoch: this.core.currentPhaseEpoch
          });
        }
      };
    }
    process(_inputs, outputs) {
      const outputChannels = outputs[0];
      if (!outputChannels || outputChannels.length === 0) return true;
      let renderChannelIndex = 0;
      for (let index = 1; index < outputChannels.length; index += 1) {
        if (outputChannels[index].length > outputChannels[renderChannelIndex].length) renderChannelIndex = index;
      }
      const startFrame = workletGlobals.currentFrame ?? 0;
      const rendered = outputChannels[renderChannelIndex];
      const blockEndFrame = startFrame + rendered.length;
      const expectedStartFrame = this.core.expectedNextFrame;
      const renderedOnTimeline = this.core.renderInto(startFrame, rendered);
      if (!renderedOnTimeline) {
        if (this.staleEpisodeStartFrame === null) {
          const expected = expectedStartFrame ?? startFrame + rendered.length;
          this.staleEpisodeStartFrame = startFrame;
          this.staleEpisodeExpectedFrame = expected;
          const message = {
            type: "timeline-rewind",
            requestedStartFrame: startFrame,
            expectedStartFrame: expected,
            frameCount: rendered.length
          };
          this.port.postMessage(message);
        }
        this.invalidatePhase();
      } else if (this.staleEpisodeStartFrame !== null) {
        const message = {
          type: "timeline-recovered",
          firstStaleStartFrame: this.staleEpisodeStartFrame,
          expectedStartFrame: this.staleEpisodeExpectedFrame ?? startFrame,
          resumedStartFrame: startFrame
        };
        this.port.postMessage(message);
        this.staleEpisodeStartFrame = null;
        this.staleEpisodeExpectedFrame = null;
        this.invalidatePhase();
      }
      if (!this.phaseAcknowledged && this.phaseRequestId !== null && renderedOnTimeline) {
        const phase = this.core.getMeasurePhaseSnapshot(this.phaseRequestId);
        if (phase && startFrame <= phase.originFrame && phase.originFrame < blockEndFrame) {
          this.setSharedPhaseEpoch(phase.epoch);
          this.port.postMessage(phase);
          this.phaseAcknowledged = true;
        } else if (phase && startFrame > phase.originFrame) {
          this.invalidatePhase();
        }
      }
      for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
        if (channelIndex === renderChannelIndex) continue;
        const channel = outputChannels[channelIndex];
        const length = Math.min(channel.length, rendered.length);
        for (let frame = 0; frame < length; frame += 1) channel[frame] = rendered[frame];
        for (let frame = length; frame < channel.length; frame += 1) channel[frame] = 0;
      }
      return true;
    }
    invalidatePhase() {
      this.setSharedPhaseEpoch(0);
      if (this.phaseInvalidated || this.phaseRequestId === null) return;
      this.phaseInvalidated = true;
      this.phaseAcknowledged = true;
      this.port.postMessage({
        type: "measure-phase",
        available: false,
        requestId: this.phaseRequestId,
        epoch: this.core.currentPhaseEpoch
      });
    }
    setSharedPhaseEpoch(epoch) {
      if (this.sharedPhaseEpoch) Atomics.store(this.sharedPhaseEpoch, 0, epoch > 0 ? epoch : 0);
    }
  };
  if (typeof workletGlobals.registerProcessor === "function") {
    workletGlobals.registerProcessor("rc505-rhythm-processor", RhythmWorkletProcessor);
  }
})();
