#include "native_rhythm_engine.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <string_view>

namespace webrc::native {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 2.0 * kPi;

std::uint32_t hashText(std::string_view value) noexcept {
    std::uint32_t hash = 0x811c9dc5U;
    for (const char character : value) {
        hash ^= static_cast<std::uint8_t>(character);
        hash *= 0x01000193U;
    }
    return hash;
}

bool containsText(std::string_view value, std::string_view token) noexcept {
    return value.find(token) != std::string_view::npos;
}

float unitHash(std::uint32_t seed) noexcept {
    return static_cast<float>(static_cast<double>(seed) / 4294967295.0);
}

} // namespace

bool NativeRhythmEngine::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) {
        return false;
    }

    sampleRate_ = sampleRate;
    config_ = {};
    pattern_ = nativeRhythmPatternByIndex(config_.patternIndex);
    meterNumerator_ = pattern_->meterNumerator;
    meterDenominator_ = pattern_->meterDenominator;
    stepsPerBeat_ = 16U / meterDenominator_;
    stepsPerBar_ = meterNumerator_ * stepsPerBeat_;
    reset();
    return true;
}

bool NativeRhythmEngine::setConfig(const NativeRhythmConfig& config, std::uint64_t startFrame) noexcept {
    const auto* selectedPattern = nativeRhythmPatternByIndex(config.patternIndex);
    if (sampleRate_ == 0U || !isValidConfig(config) || selectedPattern == nullptr) {
        return false;
    }

    const bool timingAndPatternUnchanged =
        config.enabled == config_.enabled && config.bpm == config_.bpm &&
        config.kitIndex == config_.kitIndex && config.variation == config_.variation &&
        config.section == config_.section && config.patternIndex == config_.patternIndex &&
        config.swingPercent == config_.swingPercent && config.quantizeGrid == config_.quantizeGrid;
    config_ = config;
    // Volume slider updates are applied at the callback boundary without
    // restarting the pattern clock or cutting off active drum voices.
    if (timingAndPatternUnchanged) return true;

    pattern_ = selectedPattern;
    meterNumerator_ = pattern_->meterNumerator;
    meterDenominator_ = pattern_->meterDenominator;
    stepsPerBeat_ = 16U / meterDenominator_;
    stepsPerBar_ = meterNumerator_ * stepsPerBeat_;
    timelineOriginFrame_ = startFrame;
    stepOrdinal_ = 0;
    nextStepFrame_ = startFrame;
    for (auto& voice : voices_) {
        voice.active = false;
    }
    return true;
}

void NativeRhythmEngine::processAdditive(
    float* interleaved,
    unsigned int frames,
    unsigned int channels,
    std::uint64_t startFrame
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) {
        return;
    }
    if (!config_.enabled && activeVoiceCount() == 0U) {
        return;
    }

    const unsigned int quantizeStride = config_.quantizeGrid == NativeRhythmQuantizeGrid::Quarter ? 4U :
        config_.quantizeGrid == NativeRhythmQuantizeGrid::Eighth ? 2U : 1U;
    const double lookaheadSteps = static_cast<double>(quantizeStride / 2U);
    const double lookaheadOffset = lookaheadSteps * static_cast<double>(sampleRate_) * 15.0 / config_.bpm;
    const std::uint64_t maximumLookahead = std::numeric_limits<std::uint64_t>::max();
    const std::uint64_t lookaheadFrames = !std::isfinite(lookaheadOffset) ||
        lookaheadOffset >= static_cast<double>(maximumLookahead)
        ? maximumLookahead
        : static_cast<std::uint64_t>(std::floor(lookaheadOffset + 0.5));

    for (unsigned int frameOffset = 0; frameOffset < frames; ++frameOffset) {
        const std::uint64_t absoluteFrame = startFrame + frameOffset;
        const auto remainingFrames = std::numeric_limits<std::uint64_t>::max() - absoluteFrame;
        const std::uint64_t scheduleThroughFrame = lookaheadFrames >= remainingFrames
            ? std::numeric_limits<std::uint64_t>::max()
            : absoluteFrame + lookaheadFrames;
        while (config_.enabled && nextStepFrame_ <= scheduleThroughFrame) {
            scheduleStep(stepOrdinal_, absoluteFrame);
            ++stepOrdinal_;
            updateNextStepFrame();
        }

        float rhythmSample = 0.0f;
        for (auto& voice : voices_) {
            if (voice.active) {
                rhythmSample += processVoice(voice, absoluteFrame);
            }
        }

        const std::size_t offset = static_cast<std::size_t>(frameOffset) * channels;
        const float outputGain = static_cast<float>(config_.volume) * 0.01f;
        for (unsigned int channel = 0; channel < channels; ++channel) {
            interleaved[offset + channel] += rhythmSample * outputGain;
        }
    }
}

void NativeRhythmEngine::reset() noexcept {
    config_.enabled = false;
    for (auto& voice : voices_) {
        voice.active = false;
    }
    timelineOriginFrame_ = 0;
    stepOrdinal_ = 0;
    nextStepFrame_ = 0;
}

std::size_t NativeRhythmEngine::activeVoiceCount() const noexcept {
    std::size_t activeCount = 0;
    for (const auto& voice : voices_) {
        activeCount += voice.active ? 1U : 0U;
    }
    return activeCount;
}

bool NativeRhythmEngine::isValidConfig(const NativeRhythmConfig& config) noexcept {
    const auto* pattern = nativeRhythmPatternByIndex(config.patternIndex);
    if (!std::isfinite(config.bpm) || config.bpm < 40.0 || config.bpm > 300.0 ||
        config.kitIndex < 1U || config.kitIndex > 16U ||
        config.swingPercent < 50U || config.swingPercent > 75U || config.volume > 100U ||
        pattern == nullptr || pattern->meterNumerator == 0U || pattern->meterDenominator == 0U ||
        16U % pattern->meterDenominator != 0U) {
        return false;
    }

    const auto variationValid = config.variation == NativeRhythmVariation::A ||
        config.variation == NativeRhythmVariation::B ||
        config.variation == NativeRhythmVariation::C ||
        config.variation == NativeRhythmVariation::D;
    const auto sectionValid = config.section == NativeRhythmSection::Main ||
        config.section == NativeRhythmSection::Intro ||
        config.section == NativeRhythmSection::Ending ||
        config.section == NativeRhythmSection::Fill;
    const auto quantizeValid = config.quantizeGrid == NativeRhythmQuantizeGrid::Sixteenth ||
        config.quantizeGrid == NativeRhythmQuantizeGrid::Eighth ||
        config.quantizeGrid == NativeRhythmQuantizeGrid::Quarter;
    const auto variationIndex = static_cast<std::uint8_t>(config.variation) + 1U;
    const bool availableVariation = variationValid && pattern != nullptr &&
        variationIndex <= pattern->variationCount;
    return availableVariation && sectionValid && quantizeValid;
}

const NativeRhythmEngine::KitTimbre& NativeRhythmEngine::activeTimbre() const noexcept {
    // These are clean-room procedural timbre controls. The kit index aligns to
    // the browser engine's 16 profile slots; these values do not encode factory
    // samples, MIDI, or undocumented device circuitry.
    static constexpr std::array<KitTimbre, 16> timbres{{
        {78, 74, 250, 190, 0.60f, 160, 9200, 62, 142, 230, 0.88f},
        {70, 64, 300, 180, 0.70f, 205, 8600, 95, 132, 260, 0.84f},
        {90, 60, 175, 220, 0.54f, 125, 7800, 44, 165, 160, 0.96f},
        {58, 52, 390, 165, 0.66f, 220, 7600, 78, 105, 310, 0.80f},
        {68, 82, 325, 205, 0.64f, 185, 10000, 70, 150, 215, 0.82f},
        {62, 105, 285, 240, 0.82f, 130, 11800, 42, 178, 155, 0.72f},
        {82, 42, 360, 175, 0.50f, 240, 10800, 170, 125, 290, 0.72f},
        {92, 35, 260, 280, 0.92f, 290, 7200, 110, 210, 205, 1.12f},
        {78, 32, 240, 310, 0.48f, 170, 6500, 68, 195, 260, 0.92f},
        {55, 110, 220, 220, 0.86f, 115, 11200, 38, 120, 145, 0.76f},
        {72, 50, 295, 185, 0.58f, 205, 8200, 60, 135, 225, 0.88f},
        {49, 100, 360, 255, 0.78f, 150, 12200, 48, 165, 180, 0.74f},
        {44, 120, 440, 235, 0.70f, 140, 12600, 43, 185, 190, 0.70f},
        {52, 108, 335, 215, 0.76f, 145, 11600, 50, 155, 170, 0.76f},
        {50, 88, 365, 195, 0.72f, 175, 9400, 68, 140, 220, 0.80f},
        {58, 102, 410, 205, 0.88f, 200, 6800, 55, 130, 210, 0.78f},
    }};
    const std::size_t index = static_cast<std::size_t>(config_.kitIndex - 1U);
    return timbres[index];
}

void NativeRhythmEngine::scheduleStep(
    std::uint64_t ordinal,
    std::uint64_t renderedFrame
) noexcept {
    const unsigned int quantizeStride = config_.quantizeGrid == NativeRhythmQuantizeGrid::Quarter ? 4U :
        config_.quantizeGrid == NativeRhythmQuantizeGrid::Eighth ? 2U : 1U;
    const std::uint64_t remainder = ordinal % quantizeStride;
    std::uint64_t quantizedOrdinal = ordinal - remainder;
    // Browser uses Math.round(step / gridSteps), whose exact half-step ties
    // round upward. Applying the same rule here snaps each generated event;
    // it does not discard the off-grid event.
    if (remainder * 2U >= quantizeStride &&
        quantizedOrdinal <= std::numeric_limits<std::uint64_t>::max() - quantizeStride) {
        quantizedOrdinal += quantizeStride;
    }

    const double maximumOffset = static_cast<double>(
        std::numeric_limits<std::uint64_t>::max() - timelineOriginFrame_);
    double eventOffset = static_cast<double>(quantizedOrdinal) *
        static_cast<double>(sampleRate_) * 15.0 / config_.bpm;
    if (quantizedOrdinal % 4U == 2U && config_.swingPercent > 50U) {
        const double beatPosition = static_cast<double>(quantizedOrdinal) / 4.0 +
            static_cast<double>(config_.swingPercent - 50U) / 100.0;
        eventOffset = beatPosition * static_cast<double>(sampleRate_) * 60.0 / config_.bpm;
    }
    if (!std::isfinite(eventOffset) || eventOffset < 0.0 || eventOffset >= maximumOffset) {
        return;
    }
    const auto roundedOffset = static_cast<std::uint64_t>(std::floor(eventOffset + 0.5));
    if (roundedOffset >= std::numeric_limits<std::uint64_t>::max() - timelineOriginFrame_) {
        return;
    }
    const std::uint64_t eventFrame = timelineOriginFrame_ + roundedOffset;

    const unsigned int step = static_cast<unsigned int>(ordinal % stepsPerBar_);
    const std::uint64_t bar = ordinal / stepsPerBar_;
    const unsigned int beat = step / stepsPerBeat_;
    const unsigned int withinBeat = step % stepsPerBeat_;
    const bool downbeat = step == 0U;
    const bool onBeat = withinBeat == 0U;
    const bool intro = config_.section == NativeRhythmSection::Intro && bar == 0U;
    const bool ending = config_.section == NativeRhythmSection::Ending;
    const bool fill = config_.section == NativeRhythmSection::Fill;
    const bool electronic = containsText(pattern_->genre, "ELCTRO") || containsText(pattern_->genre, "TECHNO") ||
        containsText(pattern_->genre, "DANCE") || containsText(pattern_->genre, "METAL") ||
        containsText(pattern_->genre, "DRUM&BASS") || containsText(pattern_->pattern, "808") ||
        containsText(pattern_->genre, "HIPHOP");
    const bool world = containsText(pattern_->genre, "WORLD") || containsText(pattern_->genre, "TRAD") ||
        containsText(pattern_->pattern, "CONGA") || containsText(pattern_->pattern, "BOSSA") ||
        containsText(pattern_->pattern, "CAJON");
    const bool brushPattern = containsText(pattern_->pattern, "BRUSH");

    std::uint32_t seed = hashText(pattern_->genre) ^ (hashText(pattern_->pattern) * 0x9e3779b1U) ^
        (static_cast<std::uint32_t>(pattern_->globalIndex) * 0x45d9f3bU) ^
        (static_cast<std::uint32_t>(config_.kitIndex) << 24U) ^
        (static_cast<std::uint32_t>(config_.variation) << 20U) ^
        (static_cast<std::uint32_t>(config_.section) << 16U) ^ static_cast<std::uint32_t>(bar);
    seed = mixSeed(seed ^ (static_cast<std::uint32_t>(step) * 0x27d4eb2dU));
    const float random = unitHash(seed);

    // Preserve the existing legacy metronome mapping (catalog row 210) as a
    // simple four-beat clean-room click: strong kick on beat one, snare clicks
    // on the remaining quarter notes. This is not factory MIDI or samples.
    if (config_.patternIndex == 210U && meterNumerator_ == 4U && meterDenominator_ == 4U) {
        if (onBeat) {
            const bool firstBeat = beat == 0U;
            startVoice(firstBeat ? Instrument::Kick : Instrument::Snare,
                firstBeat ? 112.0f : 86.0f, seed ^ 0x7a11U, eventFrame);
        }
        for (auto& voice : voices_) {
            if (voice.active && voice.endFrame <= renderedFrame) {
                voice.active = false;
            }
        }
        return;
    }

    const unsigned int kickBeatInterval = electronic ? 1U : 2U;
    const bool regularKick = onBeat && (beat % kickBeatInterval) == 0U && random > 0.43f;
    const bool variationKick = config_.variation == NativeRhythmVariation::B && !onBeat && random > 0.90f;
    const bool denseKick = config_.variation == NativeRhythmVariation::D && !onBeat && random > 0.96f;
    const bool kick = downbeat || regularKick || variationKick || denseKick;
    if (kick && (!intro || downbeat)) {
        startVoice(Instrument::Kick, downbeat ? 116.0f : 96.0f, seed ^ 0x11a3U, eventFrame);
    }

    const bool backbeat = onBeat && (beat % 2U) == 1U;
    if (!intro && backbeat) {
        const Instrument backbeatInstrument = brushPattern ? Instrument::Brush :
            world ? Instrument::Clap : Instrument::Snare;
        startVoice(backbeatInstrument, 100.0f, seed ^ 0x27b5U, eventFrame);
    }
    if (fill && step >= (stepsPerBar_ * 7U) / 10U && !onBeat && random > 0.52f) {
        startVoice(Instrument::Tom, 88.0f, seed ^ 0x39c7U, eventFrame);
    }
    if (fill && beat + 1U == meterNumerator_ && onBeat && !intro) {
        startVoice(Instrument::Snare, 94.0f, seed ^ 0x4ad9U, eventFrame);
    }
    if (config_.variation == NativeRhythmVariation::D && !onBeat && random > 0.94f && !fill) {
        startVoice(Instrument::Tom, 74.0f, seed ^ 0x5bebU, eventFrame);
    }

    const unsigned int hatsPerBeat = config_.variation == NativeRhythmVariation::C ? 1U :
        config_.variation == NativeRhythmVariation::D ? 4U : 2U;
    const unsigned int hatInterval = std::max(1U, stepsPerBeat_ / hatsPerBeat);
    const bool hat = (step % hatInterval) == 0U;
    if (hat && (downbeat || config_.variation == NativeRhythmVariation::D || onBeat || random > 0.10f)) {
        const bool openHat = ending && step + 1U == stepsPerBar_;
        const bool ride = downbeat && config_.variation != NativeRhythmVariation::C;
        const auto instrument = openHat ? Instrument::OpenHat : ride ? Instrument::Ride : Instrument::ClosedHat;
        startVoice(instrument, downbeat ? 72.0f : 56.0f, seed ^ 0x6cfdU, eventFrame);
    }

    if (ending && step + 1U == stepsPerBar_ && !hat) {
        startVoice(Instrument::OpenHat, 88.0f, seed ^ 0x7d0fU, eventFrame);
    }

    // Old step events from a large callback gap are discarded when their voice
    // has already decayed, rather than consuming the fixed voice pool.
    for (auto& voice : voices_) {
        if (voice.active && voice.endFrame <= renderedFrame) {
            voice.active = false;
        }
    }
}

void NativeRhythmEngine::startVoice(
    Instrument instrument,
    float velocity,
    std::uint64_t seed,
    std::uint64_t frame
) noexcept {
    const auto& timbre = activeTimbre();
    float durationMs = timbre.hatDecayMs;
    float baseAmplitude = 0.10f;
    float initialHz = 0.0f;
    float settledHz = 0.0f;
    float noiseMix = 1.0f;
    switch (instrument) {
    case Instrument::Kick:
        durationMs = timbre.kickDecayMs;
        baseAmplitude = 0.34f;
        initialHz = timbre.kickHz + timbre.kickPitchDropHz;
        settledHz = timbre.kickHz;
        noiseMix = 0.08f;
        break;
    case Instrument::Snare:
        durationMs = timbre.snareDecayMs;
        baseAmplitude = 0.23f;
        initialHz = settledHz = timbre.snareHz;
        noiseMix = timbre.snareNoiseMix;
        break;
    case Instrument::ClosedHat:
        durationMs = timbre.hatDecayMs;
        baseAmplitude = 0.075f;
        initialHz = settledHz = timbre.hatCutoffHz;
        break;
    case Instrument::OpenHat:
        durationMs = std::max(timbre.hatDecayMs * 2.8f, 90.0f);
        baseAmplitude = 0.10f;
        initialHz = settledHz = timbre.hatCutoffHz;
        break;
    case Instrument::Tom:
        durationMs = timbre.tomDecayMs;
        baseAmplitude = 0.22f;
        initialHz = settledHz = timbre.tomHz;
        noiseMix = 0.05f;
        break;
    case Instrument::Ride:
        durationMs = std::max(timbre.hatDecayMs * 2.8f, 90.0f);
        baseAmplitude = 0.065f;
        initialHz = settledHz = timbre.hatCutoffHz * 0.74f;
        break;
    case Instrument::Clap:
        durationMs = timbre.snareDecayMs;
        baseAmplitude = 0.18f;
        initialHz = settledHz = timbre.snareHz;
        break;
    case Instrument::Brush:
        durationMs = std::max(timbre.snareDecayMs * 1.7f, 160.0f);
        baseAmplitude = 0.07f;
        initialHz = settledHz = timbre.snareHz * 0.7f;
        break;
    }

    const std::uint64_t durationFrames = std::max<std::uint64_t>(
        1U,
        static_cast<std::uint64_t>(std::llround(static_cast<double>(sampleRate_) * durationMs / 1000.0))
    );
    if (frame > std::numeric_limits<std::uint64_t>::max() - durationFrames) {
        return;
    }
    const std::uint64_t endFrame = frame + durationFrames;
    if (endFrame <= frame) {
        return;
    }

    std::size_t slot = kMaxVoices;
    for (std::size_t index = 0; index < voices_.size(); ++index) {
        if (!voices_[index].active) {
            slot = index;
            break;
        }
    }
    if (slot == kMaxVoices) {
        slot = 0;
        for (std::size_t index = 1; index < voices_.size(); ++index) {
            if (voices_[index].startFrame < voices_[slot].startFrame) {
                slot = index;
            }
        }
    }

    Voice voice;
    voice.active = endFrame > timelineOriginFrame_;
    voice.instrument = instrument;
    voice.startFrame = frame;
    voice.endFrame = endFrame;
    const float normalizedVelocity = std::max(0.0f, std::min(1.0f, velocity / 127.0f));
    voice.amplitude = baseAmplitude * std::pow(normalizedVelocity, timbre.velocityExponent);
    voice.envelopeDecay = static_cast<float>(std::exp(-6.2 / static_cast<double>(durationFrames)));
    voice.initialHz = initialHz;
    voice.settledHz = settledHz;
    voice.phaseIncrement = static_cast<float>(kTwoPi * initialHz / sampleRate_);
    voice.secondaryIncrement = static_cast<float>(kTwoPi * initialHz * 1.47 / sampleRate_);
    voice.pitchDropDecay = static_cast<float>(std::exp(-1.0 / (0.020 * sampleRate_)));
    voice.noiseMix = noiseMix;
    voice.randomState = mixSeed(static_cast<std::uint32_t>(seed) ^ static_cast<std::uint32_t>(frame));
    if (voice.randomState == 0U) {
        voice.randomState = 1U;
    }
    voices_[slot] = voice;
}

float NativeRhythmEngine::processVoice(Voice& voice, std::uint64_t frame) noexcept {
    // Swing and quantization may schedule a voice in the future. Keep its
    // preallocated state dormant until its sample-accurate start frame rather
    // than emitting the attack as soon as it enters the voice pool.
    if (frame < voice.startFrame) {
        return 0.0f;
    }
    if (frame >= voice.endFrame) {
        voice.active = false;
        return 0.0f;
    }

    const std::uint64_t ageFrames = frame >= voice.startFrame ? frame - voice.startFrame : 0U;
    const float noise = nextNoise(voice);
    const float highPassedNoise = noise - voice.previousNoise * 0.94f;
    voice.previousNoise = noise;

    float signal = 0.0f;
    switch (voice.instrument) {
    case Instrument::Kick: {
        const float frequency = voice.settledHz + (voice.initialHz - voice.settledHz) * voice.pitchDropEnvelope;
        voice.phaseIncrement = static_cast<float>(kTwoPi * frequency / sampleRate_);
        signal = std::sin(voice.phase) * (1.0f - voice.noiseMix) + highPassedNoise * voice.noiseMix * 0.35f;
        voice.pitchDropEnvelope *= voice.pitchDropDecay;
        break;
    }
    case Instrument::Snare: {
        const float body = std::sin(voice.phase) * 0.75f;
        signal = highPassedNoise * voice.noiseMix + body * (1.0f - voice.noiseMix);
        break;
    }
    case Instrument::ClosedHat:
    case Instrument::OpenHat:
    case Instrument::Ride:
        signal = highPassedNoise * 0.62f + std::sin(voice.phase) * 0.23f +
            std::sin(voice.secondaryPhase) * 0.15f + std::sin(voice.phase * 1.73f) * 0.10f;
        break;
    case Instrument::Tom:
        signal = std::sin(voice.phase) * 0.92f + highPassedNoise * voice.noiseMix * 0.35f;
        break;
    case Instrument::Clap:
        signal = highPassedNoise * 0.70f;
        break;
    case Instrument::Brush:
        signal = highPassedNoise * 0.45f;
        break;
    }

    const float output = signal * voice.envelope * voice.amplitude;
    voice.phase += voice.phaseIncrement;
    voice.secondaryPhase += voice.secondaryIncrement;
    if (voice.phase >= static_cast<float>(kTwoPi)) {
        voice.phase -= static_cast<float>(kTwoPi);
    }
    if (voice.secondaryPhase >= static_cast<float>(kTwoPi)) {
        voice.secondaryPhase -= static_cast<float>(kTwoPi);
    }
    voice.envelope *= voice.envelopeDecay;

    // A subtle second clap pulse and a kick transient are deterministic per
    // voice; they remain procedural and use the same preallocated voice state.
    if (voice.instrument == Instrument::Clap && ageFrames == (sampleRate_ * 14U) / 1000U) {
        voice.envelope = std::max(voice.envelope, 0.52f);
    }
    if (voice.instrument == Instrument::Kick && ageFrames < (sampleRate_ * 6U) / 1000U) {
        return output + highPassedNoise * voice.amplitude * 0.10f;
    }
    return output;
}

float NativeRhythmEngine::nextNoise(Voice& voice) noexcept {
    const std::uint32_t random = nextRandom(voice.randomState);
    return static_cast<float>((static_cast<double>(random) / 2147483647.5) - 1.0);
}

std::uint32_t NativeRhythmEngine::mixSeed(std::uint32_t value) noexcept {
    value ^= value >> 16U;
    value *= 0x7feb352dU;
    value ^= value >> 15U;
    value *= 0x846ca68bU;
    value ^= value >> 16U;
    return value;
}

std::uint32_t NativeRhythmEngine::nextRandom(std::uint32_t& state) noexcept {
    state ^= state << 13U;
    state ^= state >> 17U;
    state ^= state << 5U;
    return state;
}

void NativeRhythmEngine::updateNextStepFrame() noexcept {
    const double stepOffset = static_cast<double>(stepOrdinal_) *
        static_cast<double>(sampleRate_) * 15.0 / config_.bpm;
    if (!std::isfinite(stepOffset) || stepOffset >= static_cast<double>(std::numeric_limits<std::uint64_t>::max() - timelineOriginFrame_)) {
        nextStepFrame_ = std::numeric_limits<std::uint64_t>::max();
        return;
    }
    nextStepFrame_ = timelineOriginFrame_ + static_cast<std::uint64_t>(std::floor(stepOffset + 0.5));
}

const char* nativeRhythmVariationToString(NativeRhythmVariation variation) noexcept {
    switch (variation) {
    case NativeRhythmVariation::A: return "A";
    case NativeRhythmVariation::B: return "B";
    case NativeRhythmVariation::C: return "C";
    case NativeRhythmVariation::D: return "D";
    }
    return "A";
}

const char* nativeRhythmSectionToString(NativeRhythmSection section) noexcept {
    switch (section) {
    case NativeRhythmSection::Main: return "main";
    case NativeRhythmSection::Intro: return "intro";
    case NativeRhythmSection::Ending: return "ending";
    case NativeRhythmSection::Fill: return "fill";
    }
    return "main";
}

const char* nativeRhythmQuantizeGridToString(NativeRhythmQuantizeGrid grid) noexcept {
    switch (grid) {
    case NativeRhythmQuantizeGrid::Sixteenth: return "1/16";
    case NativeRhythmQuantizeGrid::Eighth: return "1/8";
    case NativeRhythmQuantizeGrid::Quarter: return "1/4";
    }
    return "1/16";
}

bool nativeRhythmVariationFromString(const char* raw, NativeRhythmVariation& variation) noexcept {
    if (raw == nullptr) return false;
    if (std::strcmp(raw, "A") == 0) variation = NativeRhythmVariation::A;
    else if (std::strcmp(raw, "B") == 0) variation = NativeRhythmVariation::B;
    else if (std::strcmp(raw, "C") == 0) variation = NativeRhythmVariation::C;
    else if (std::strcmp(raw, "D") == 0) variation = NativeRhythmVariation::D;
    else return false;
    return true;
}

bool nativeRhythmSectionFromString(const char* raw, NativeRhythmSection& section) noexcept {
    if (raw == nullptr) return false;
    if (std::strcmp(raw, "main") == 0) section = NativeRhythmSection::Main;
    else if (std::strcmp(raw, "intro") == 0) section = NativeRhythmSection::Intro;
    else if (std::strcmp(raw, "ending") == 0) section = NativeRhythmSection::Ending;
    else if (std::strcmp(raw, "fill") == 0) section = NativeRhythmSection::Fill;
    else return false;
    return true;
}

bool nativeRhythmQuantizeGridFromString(const char* raw, NativeRhythmQuantizeGrid& grid) noexcept {
    if (raw == nullptr) return false;
    if (std::strcmp(raw, "1/16") == 0) grid = NativeRhythmQuantizeGrid::Sixteenth;
    else if (std::strcmp(raw, "1/8") == 0) grid = NativeRhythmQuantizeGrid::Eighth;
    else if (std::strcmp(raw, "1/4") == 0) grid = NativeRhythmQuantizeGrid::Quarter;
    else return false;
    return true;
}

} // namespace webrc::native
