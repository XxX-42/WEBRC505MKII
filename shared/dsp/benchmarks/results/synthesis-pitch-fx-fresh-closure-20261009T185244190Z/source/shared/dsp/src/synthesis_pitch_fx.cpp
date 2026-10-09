#include "webrc/dsp/synthesis_pitch_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::uint64_t kMaximumExactFrame = 9007199254740992ULL;
constexpr double kQ32 = 4294967296.0;

[[nodiscard]] bool validAudioSpec(const ProcessSpec& spec) noexcept {
    return validProcessSpec(spec) && spec.channels == 2U &&
        spec.sampleRate >= 24000.0f && spec.sampleRate <= 192000.0f &&
        spec.maxBlockFrames <= 8192U;
}

[[nodiscard]] bool validTimeline(std::uint64_t start, std::uint32_t frames,
                                 std::uint32_t maximum) noexcept {
    return frames != 0U && frames <= maximum && start <= kMaximumExactFrame &&
        static_cast<std::uint64_t>(frames) <= kMaximumExactFrame - start;
}

[[nodiscard]] float cleanAudio(float value) noexcept {
    return std::isfinite(value) && std::fabs(value) >= 1.0e-20f ? value : 0.0f;
}

[[nodiscard]] double coefficient(float milliseconds, float sampleRate) noexcept {
    const double seconds = std::max(0.001, static_cast<double>(milliseconds) * 0.001);
    return 1.0 - std::exp(-1.0 / (seconds * static_cast<double>(sampleRate)));
}

[[nodiscard]] float smooth(float current, float target, double amount) noexcept {
    return static_cast<float>(static_cast<double>(current) +
        amount * (static_cast<double>(target) - static_cast<double>(current)));
}

[[nodiscard]] double midiFromFrequency(float frequency) noexcept {
    if (!std::isfinite(frequency) || frequency <= 0.0f) return 0.0;
    return 69.0 + 12.0 * std::log2(static_cast<double>(frequency) / 440.0);
}

[[nodiscard]] float frequencyFromMidi(double midi) noexcept {
    return static_cast<float>(440.0 * std::exp2((midi - 69.0) / 12.0));
}

[[nodiscard]] int positiveModulo12(int value) noexcept {
    const int remainder = value % 12;
    return remainder < 0 ? remainder + 12 : remainder;
}

[[nodiscard]] int nearestMajorNote(double midi, std::uint8_t key) noexcept {
    constexpr std::array<int, 7U> offsets{{0, 2, 4, 5, 7, 9, 11}};
    const int center = static_cast<int>(std::floor(midi));
    int selected = center;
    double selectedDistance = std::numeric_limits<double>::infinity();
    for (int candidate = center - 12; candidate <= center + 12; ++candidate) {
        const int pitchClass = positiveModulo12(candidate);
        bool allowed = false;
        for (int offset : offsets)
            allowed = allowed || pitchClass == positiveModulo12(static_cast<int>(key) + offset);
        const double distance = std::fabs(static_cast<double>(candidate) - midi);
        if (allowed && distance < selectedDistance) {
            selectedDistance = distance;
            selected = candidate;
        }
    }
    return selected;
}

[[nodiscard]] int advanceMajorDegrees(int note, int degrees, std::uint8_t key) noexcept {
    constexpr std::array<int, 7U> offsets{{0, 2, 4, 5, 7, 9, 11}};
    int current = note;
    const int direction = degrees < 0 ? -1 : 1;
    for (int step = 0; step < std::abs(degrees); ++step) {
        const int currentPitch = positiveModulo12(current);
        int bestDistance = 13;
        int next = current;
        for (int delta = 1; delta <= 12; ++delta) {
            const int candidate = current + direction * delta;
            const int pitchClass = positiveModulo12(candidate);
            bool allowed = false;
            for (const int offset : offsets)
                allowed = allowed || pitchClass == positiveModulo12(static_cast<int>(key) + offset);
            (void)currentPitch;
            if (allowed) { bestDistance = delta; next = candidate; break; }
        }
        if (bestDistance > 12) break;
        current = next;
    }
    return current;
}

[[nodiscard]] float ratioForTarget(const PitchEstimate& estimate, double targetMidi) noexcept {
    if (!estimate.voiced || estimate.frequencyHz <= 0.0f) return 1.0f;
    const double sourceMidi = midiFromFrequency(estimate.frequencyHz);
    return std::clamp(static_cast<float>(std::exp2((targetMidi - sourceMidi) / 12.0)),
                      0.5f, 2.0f);
}

[[nodiscard]] bool validEnum(GuitarToBassMode value) noexcept {
    return value == GuitarToBassMode::DividerBlend || value == GuitarToBassMode::PsolaBody;
}
[[nodiscard]] bool validEnum(HarmonyAutoVoice value) noexcept {
    return value >= HarmonyAutoVoice::OctaveDown && value <= HarmonyAutoVoice::Unison;
}
[[nodiscard]] bool validEnum(HarmonyAutoMode value) noexcept {
    return value == HarmonyAutoMode::Hybrid || value == HarmonyAutoMode::Auto;
}

constexpr std::array<std::array<std::int8_t, AutoRiffFxProcessor::kStepsPerPhrase>,
                     AutoRiffFxProcessor::kPhraseCount> kRiffPhrases{{
    {{0, 2, 4, 7, 4, 2, 0, -2}}, {{0, 3, 5, 7, 10, 7, 5, 3}},
    {{0, 0, 3, 5, 7, 5, 3, 0}}, {{0, 4, 7, 9, 7, 4, 2, 0}},
    {{0, 2, 5, 9, 7, 5, 2, -3}}, {{0, 5, 7, 12, 7, 5, 3, 0}},
    {{0, 3, 7, 10, 12, 10, 7, 3}}, {{0, 2, 3, 7, 9, 7, 3, 2}},
    {{0, 4, 5, 9, 12, 9, 5, 4}}, {{0, 7, 5, 3, 7, 10, 7, 3}},
    {{0, -2, 3, 5, 7, 3, 2, -2}}, {{0, 2, 7, 5, 9, 7, 4, 2}},
    {{0, 3, 2, 7, 5, 10, 7, 3}}, {{0, 5, 3, 7, 12, 7, 5, 2}},
    {{0, 2, 4, 5, 9, 7, 4, 0}}, {{0, 7, 9, 12, 10, 9, 7, 5}},
    {{0, 3, 5, 8, 7, 5, 3, -1}}, {{0, 4, 7, 11, 9, 7, 4, 2}},
    {{0, 2, 6, 7, 11, 9, 6, 2}}, {{0, 5, 7, 9, 12, 14, 12, 7}},
    {{0, 2, 5, 7, 5, 9, 7, 2}}, {{0, 3, 7, 5, 10, 7, 3, 0}},
    {{0, 4, 2, 7, 9, 5, 4, 0}}, {{0, 7, 10, 12, 10, 7, 5, 3}},
    {{0, 2, 5, 3, 7, 9, 7, 4}}, {{0, 3, 5, 7, 8, 7, 5, 2}},
    {{0, 5, 9, 7, 12, 9, 7, 4}}, {{0, 2, 7, 9, 11, 9, 5, 2}},
    {{0, 4, 5, 7, 11, 7, 5, 0}}, {{0, 3, 6, 7, 10, 7, 6, 3}}
}};

} // namespace

// ------------------------------- SYNTH ----------------------------------

std::size_t SynthFxProcessor::requiredPrepareBytes(const ProcessSpec& spec) noexcept {
    if (!validAudioSpec(spec)) return 0U;
    const auto pathBytes = YinPsolaStereoPath::requiredPrepareBytes(spec);
    if (pathBytes < sizeof(YinPsolaStereoPath)) return 0U;
    const std::uint64_t bytes = sizeof(SynthFxProcessor) +
        pathBytes - sizeof(YinPsolaStereoPath);
    return bytes > std::numeric_limits<std::size_t>::max() ? 0U : static_cast<std::size_t>(bytes);
}

bool SynthFxProcessor::prepare(const ProcessSpec& spec, const SynthFxOptions& options) {
    if (requiredPrepareBytes(spec) == 0U ||
        !std::isfinite(options.frequency) || options.frequency < 0.0f || options.frequency > 100.0f ||
        !std::isfinite(options.resonance) || options.resonance < 0.0f || options.resonance > 100.0f ||
        !std::isfinite(options.decay) || options.decay < 0.0f || options.decay > 100.0f ||
        !std::isfinite(options.balance) || options.balance < 0.0f || options.balance > 100.0f)
        return false;
    if (!pitchAnalysis_.prepare(spec)) return false;
    spec_ = spec;
    options_ = options;
    const double required = static_cast<double>(sizeof(*this)) + pitchAnalysis_.preparedBytes() -
                            sizeof(YinPsolaStereoPath);
    if (required > static_cast<double>(std::numeric_limits<std::size_t>::max())) return false;
    preparedBytes_ = static_cast<std::size_t>(required);
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        if (!onset_[channel].prepare(spec_) ||
            !onset_[channel].setParameters(0.0025f, 1.2f, 4.0f, 25.0f) ||
            !filters_[channel].prepare(spec_) ||
            !mainOscillator_[channel].prepare(spec_) ||
            !subOscillator_[channel].prepare(spec_)) return false;
        mainOscillator_[channel].setWaveform(OscillatorWaveform::Saw);
        subOscillator_[channel].setWaveform(OscillatorWaveform::Square);
    }
    frequencyCurrent_ = options.frequency;
    resonanceCurrent_ = options.resonance;
    decayCurrent_ = options.decay;
    balanceCurrent_ = balanceTarget_ = options.balance / 100.0f;
    activeCurrent_ = activeTarget_ = 1.0f;
    controlCoefficient_ = coefficient(8.0f, spec.sampleRate);
    releaseCoefficient_ = std::exp(-1.0 / (0.060 * static_cast<double>(spec.sampleRate)));
    updateFilterTargets(0.0f);
    prepared_ = true;
    reset();
    return true;
}

void SynthFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = false;
    pitchAnalysis_.reset();
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        onset_[channel].reset();
        filters_[channel].reset();
        mainOscillator_[channel].reset();
        subOscillator_[channel].reset();
        inputEnvelope_[channel] = 0.0f;
        onsetEnvelope_[channel] = 0.0f;
        oscillatorFrequency_[channel] = 0.0f;
    }
}

bool SynthFxProcessor::validateEvent(const SynthFxEvent& event) const noexcept {
    if (!std::isfinite(event.value)) return false;
    switch (event.control) {
    case SynthFxControl::Active: return event.value == 0.0f || event.value == 1.0f;
    case SynthFxControl::Frequency:
    case SynthFxControl::Resonance:
    case SynthFxControl::Decay:
    case SynthFxControl::Balance: return event.value >= 0.0f && event.value <= 100.0f;
    }
    return false;
}

bool SynthFxProcessor::validateEvents(std::uint32_t frames, const SynthFxEvent* events,
                                      std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && events == nullptr))
        return false;
    std::uint32_t last = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames || (i != 0U && events[i].frameOffset < last) ||
            !validateEvent(events[i])) return false;
        last = events[i].frameOffset;
    }
    return true;
}

void SynthFxProcessor::updateFilterTargets(float smoothingMs) noexcept {
    const float normalized = frequencyCurrent_ / 100.0f;
    const float cutoff = std::clamp(130.0f * std::exp2(6.0f * normalized),
                                    35.0f, 0.44f * spec_.sampleRate);
    const float q = 0.55f + 8.0f * (resonanceCurrent_ / 100.0f);
    for (auto& filter : filters_) (void)filter.setFrequencyQ(cutoff, q, smoothingMs);
    const double releaseMs = 45.0 + 1955.0 * static_cast<double>(decayCurrent_) / 100.0;
    releaseCoefficient_ = std::exp(-1.0 / (releaseMs * 0.001 * spec_.sampleRate));
}

void SynthFxProcessor::applyEvent(const SynthFxEvent& event) noexcept {
    switch (event.control) {
    case SynthFxControl::Active: activeTarget_ = event.value; break;
    case SynthFxControl::Frequency:
        frequencyCurrent_ = event.value; updateFilterTargets(8.0f); break;
    case SynthFxControl::Resonance:
        resonanceCurrent_ = event.value; updateFilterTargets(8.0f); break;
    case SynthFxControl::Decay:
        decayCurrent_ = event.value; updateFilterTargets(0.0f); break;
    case SynthFxControl::Balance: balanceTarget_ = event.value / 100.0f; break;
    }
}

bool SynthFxProcessor::processBlock(std::uint64_t blockStartFrame, StereoFrame* audio,
                                   std::uint32_t frames, const SynthFxEvent* events,
                                   std::uint32_t eventCount) noexcept {
    if (!prepared_ || audio == nullptr || !validTimeline(blockStartFrame, frames,
            spec_.maxBlockFrames) || !validateEvents(frames, events, eventCount) ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_)) return false;
    // The bool reports whether a new estimate was promoted, not callback failure.
    (void)pitchAnalysis_.processAnalysisBlock(audio, frames);
    const auto leftEstimate = pitchAnalysis_.estimate(0U);
    const auto rightEstimate = pitchAnalysis_.estimate(1U);
    const std::array<PitchEstimate, 2U> estimates{{leftEstimate, rightEstimate}};
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        if (estimates[channel].voiced && estimates[channel].frequencyHz > 0.0f) {
            const float frequency = std::clamp(estimates[channel].frequencyHz, 25.0f,
                                                0.43f * spec_.sampleRate);
            if (std::fabs(frequency - oscillatorFrequency_[channel]) > 0.1f) {
                oscillatorFrequency_[channel] = frequency;
                (void)mainOscillator_[channel].setFrequency(frequency);
                (void)subOscillator_[channel].setFrequency(std::max(15.0f, 0.5f * frequency));
            }
        }
    }
    std::uint32_t event = 0U;
    const double inputAttack = std::exp(-1.0 / (0.003 * spec_.sampleRate));
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (event < eventCount && events[event].frameOffset == frame)
            applyEvent(events[event++]);
        activeCurrent_ = smooth(activeCurrent_, activeTarget_, controlCoefficient_);
        balanceCurrent_ = smooth(balanceCurrent_, balanceTarget_, controlCoefficient_);
        const StereoFrame input{cleanAudio(audio[frame].left), cleanAudio(audio[frame].right)};
        const float samples[2U]{input.left, input.right};
        float generated[2U]{};
        for (std::size_t channel = 0U; channel < 2U; ++channel) {
            const float magnitude = std::fabs(samples[channel]);
            const double coefficientValue = magnitude > inputEnvelope_[channel]
                ? inputAttack : releaseCoefficient_;
            inputEnvelope_[channel] = static_cast<float>(coefficientValue *
                inputEnvelope_[channel] + (1.0 - coefficientValue) * magnitude);
            const auto onset = onset_[channel].processSample(samples[channel]);
            if (onset.onset) onsetEnvelope_[channel] = 1.0f;
            else onsetEnvelope_[channel] = static_cast<float>(releaseCoefficient_ * onsetEnvelope_[channel]);
            const float excitation = std::clamp(std::max(inputEnvelope_[channel],
                0.35f * onsetEnvelope_[channel]), 0.0f, 1.0f);
            const float oscillator = 0.29f * mainOscillator_[channel].next() +
                                     0.16f * subOscillator_[channel].next();
            generated[channel] = cleanAudio(filters_[channel].processSample(
                (estimates[channel].voiced ? oscillator : 0.0f) * excitation).low);
        }
        const float wet = activeCurrent_ * balanceCurrent_;
        audio[frame].left = cleanAudio(input.left * (1.0f - wet) + generated[0U] * wet);
        audio[frame].right = cleanAudio(input.right * (1.0f - wet) + generated[1U] * wet);
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

SynthesisPitchFxLatency SynthFxProcessor::latency() const noexcept {
    const bool cold = pitchAnalysis_.analysisCount(0U) == 0U &&
                      pitchAnalysis_.analysisCount(1U) == 0U;
    return {0U, YinPsolaStereoPath::kAnalysisWindowFrames,
        YinPsolaStereoPath::kAnalysisHopFrames, 0U, cold};
}

// ------------------------------ G2B -------------------------------------

std::size_t GuitarToBassFxProcessor::requiredPrepareBytes(const ProcessSpec& spec) noexcept {
    if (!validAudioSpec(spec)) return 0U;
    const auto pathBytes = YinPsolaStereoPath::requiredPrepareBytes(spec);
    if (pathBytes < sizeof(YinPsolaStereoPath)) return 0U;
    const std::uint64_t bytes = sizeof(GuitarToBassFxProcessor) +
        pathBytes - sizeof(YinPsolaStereoPath);
    return bytes > std::numeric_limits<std::size_t>::max() ? 0U : static_cast<std::size_t>(bytes);
}

bool GuitarToBassFxProcessor::prepare(const ProcessSpec& spec,
                                     const GuitarToBassFxOptions& options) {
    if (requiredPrepareBytes(spec) == 0U || !std::isfinite(options.balance) ||
        options.balance < 0.0f || options.balance > 100.0f || !validEnum(options.mode) ||
        !pitchPath_.prepare(spec)) return false;
    spec_ = spec;
    options_ = options;
    modeCurrent_ = options.mode;
    modeMixCurrent_ = modeMixTarget_ = options.mode == GuitarToBassMode::PsolaBody ? 1.0f : 0.0f;
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        if (!subOscillator_[channel].prepare(spec_) || !bodyFilter_[channel].prepare(spec_) ||
            !bodyFilter_[channel].setLowpass(std::min(950.0f, 0.42f * spec_.sampleRate),
                                             0.707f, 10.0f)) return false;
        subOscillator_[channel].setWaveform(OscillatorWaveform::Square);
    }
    const std::uint64_t bytes = sizeof(*this) + pitchPath_.preparedBytes() -
                                sizeof(YinPsolaStereoPath);
    if (bytes > std::numeric_limits<std::size_t>::max()) return false;
    preparedBytes_ = static_cast<std::size_t>(bytes);
    controlCoefficient_ = coefficient(10.0f, spec_.sampleRate);
    activeCurrent_ = activeTarget_ = 1.0f;
    balanceCurrent_ = balanceTarget_ = options.balance / 100.0f;
    prepared_ = true;
    reset();
    return true;
}

void GuitarToBassFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = false;
    pitchPath_.reset();
    for (auto& oscillator : subOscillator_) oscillator.reset();
    for (auto& filter : bodyFilter_) filter.reset();
}

bool GuitarToBassFxProcessor::validateEvent(const GuitarToBassFxEvent& event) const noexcept {
    if (!std::isfinite(event.value)) return false;
    switch (event.control) {
    case GuitarToBassControl::Active: return event.value == 0.0f || event.value == 1.0f;
    case GuitarToBassControl::Balance: return event.value >= 0.0f && event.value <= 100.0f;
    case GuitarToBassControl::Mode:
        return event.value == 1.0f || event.value == 2.0f;
    }
    return false;
}

bool GuitarToBassFxProcessor::validateEvents(std::uint32_t frames,
        const GuitarToBassFxEvent* events, std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && events == nullptr))
        return false;
    std::uint32_t last = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames || (i != 0U && events[i].frameOffset < last) ||
            !validateEvent(events[i])) return false;
        last = events[i].frameOffset;
    }
    return true;
}

void GuitarToBassFxProcessor::applyEvent(const GuitarToBassFxEvent& event) noexcept {
    if (event.control == GuitarToBassControl::Active) activeTarget_ = event.value;
    else if (event.control == GuitarToBassControl::Balance) balanceTarget_ = event.value / 100.0f;
    else {
        modeCurrent_ = event.value < 1.5f ? GuitarToBassMode::DividerBlend
                                          : GuitarToBassMode::PsolaBody;
        modeMixTarget_ = modeCurrent_ == GuitarToBassMode::PsolaBody ? 1.0f : 0.0f;
    }
}

void GuitarToBassFxProcessor::updatePitchTargets() noexcept {
    (void)pitchPath_.setPitchTargets(0.5f, 0.5f, 0.60f);
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        const auto estimate = pitchPath_.estimate(static_cast<std::uint32_t>(channel));
        if (estimate.voiced && estimate.frequencyHz > 0.0f)
            (void)subOscillator_[channel].setFrequency(std::clamp(estimate.frequencyHz * 0.5f,
                20.0f, 0.43f * spec_.sampleRate));
    }
}

bool GuitarToBassFxProcessor::processBlock(std::uint64_t blockStartFrame, StereoFrame* audio,
        std::uint32_t frames, const GuitarToBassFxEvent* events,
        std::uint32_t eventCount) noexcept {
    if (!prepared_ || audio == nullptr || !validTimeline(blockStartFrame, frames,
            spec_.maxBlockFrames) || !validateEvents(frames, events, eventCount) ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_)) return false;
    (void)pitchPath_.processAnalysisBlock(audio, frames);
    updatePitchTargets();
    std::uint32_t event = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (event < eventCount && events[event].frameOffset == frame)
            applyEvent(events[event++]);
        activeCurrent_ = smooth(activeCurrent_, activeTarget_, controlCoefficient_);
        balanceCurrent_ = smooth(balanceCurrent_, balanceTarget_, controlCoefficient_);
        modeMixCurrent_ = smooth(modeMixCurrent_, modeMixTarget_, controlCoefficient_);
        const StereoFrame dry{cleanAudio(audio[frame].left), cleanAudio(audio[frame].right)};
        const StereoFrame shifted = pitchPath_.processSample(dry);
        const auto leftPitch = pitchPath_.estimate(0U);
        const auto rightPitch = pitchPath_.estimate(1U);
        float shiftedSamples[2U]{shifted.left, shifted.right};
        const float drySamples[2U]{dry.left, dry.right};
        float output[2U]{};
        for (std::size_t channel = 0U; channel < 2U; ++channel) {
            const auto estimate = channel == 0U ? leftPitch : rightPitch;
            if (!estimate.voiced) {
                output[channel] = drySamples[channel];
                continue;
            }
            const float sub = 0.28f * subOscillator_[channel].next();
            const float filtered = bodyFilter_[channel].processSample(shiftedSamples[channel]);
            const float dividerWet = 0.62f * shiftedSamples[channel] + 0.38f * sub;
            const float bodyWet = 0.82f * filtered + 0.18f * sub;
            const float wet = dividerWet * (1.0f - modeMixCurrent_) +
                              bodyWet * modeMixCurrent_;
            const float mix = activeCurrent_ * balanceCurrent_;
            output[channel] = cleanAudio(drySamples[channel] * (1.0f - mix) + wet * mix);
        }
        audio[frame] = {output[0U], output[1U]};
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

SynthesisPitchFxLatency GuitarToBassFxProcessor::latency() const noexcept {
    const auto voice = pitchPath_.latency();
    return {0U, voice.analysisWindowFrames, voice.analysisHopFrames,
            voice.psolaLookaheadSamples, voice.analysisCold};
}

// ----------------------------- AUTO RIFF --------------------------------

std::size_t AutoRiffFxProcessor::requiredPrepareBytes(const ProcessSpec& spec) noexcept {
    if (!validAudioSpec(spec)) return 0U;
    const auto pathBytes = YinPsolaStereoPath::requiredPrepareBytes(spec);
    if (pathBytes < sizeof(YinPsolaStereoPath)) return 0U;
    const std::uint64_t bytes = sizeof(AutoRiffFxProcessor) +
        pathBytes - sizeof(YinPsolaStereoPath);
    return bytes > std::numeric_limits<std::size_t>::max() ? 0U : static_cast<std::size_t>(bytes);
}

std::int8_t AutoRiffFxProcessor::phraseStep(std::uint8_t phrase,
                                            std::uint8_t step) noexcept {
    if (phrase < 1U || phrase > kPhraseCount || step >= kStepsPerPhrase) return 0;
    return kRiffPhrases[static_cast<std::size_t>(phrase - 1U)][step];
}

bool AutoRiffFxProcessor::prepare(const ProcessSpec& spec, const AutoRiffFxOptions& options) {
    if (requiredPrepareBytes(spec) == 0U || options.phrase < 1U || options.phrase > kPhraseCount ||
        !std::isfinite(options.tempoBpm) || options.tempoBpm < 30.0f || options.tempoBpm > 300.0f ||
        !std::isfinite(options.attack) || options.attack < 0.0f || options.attack > 100.0f ||
        options.key > 11U || !std::isfinite(options.balance) || options.balance < 0.0f ||
        options.balance > 100.0f || !pitchPath_.prepare(spec)) return false;
    spec_ = spec;
    options_ = options;
    const std::uint64_t bytes = sizeof(*this) + pitchPath_.preparedBytes() -
                                sizeof(YinPsolaStereoPath);
    if (bytes > std::numeric_limits<std::size_t>::max()) return false;
    preparedBytes_ = static_cast<std::size_t>(bytes);
    controlCoefficient_ = coefficient(8.0f, spec_.sampleRate);
    activeCurrent_ = activeTarget_ = 1.0f;
    balanceCurrent_ = balanceTarget_ = options.balance / 100.0f;
    prepared_ = true;
    reset();
    setTempo(options.tempoBpm, 0U);
    return true;
}

void AutoRiffFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = false;
    processingFrame_ = absoluteFrame;
    stepDeadlineFrame_ = absoluteFrame;
    stepFractionQ32_ = 0U;
    stepCount_ = 0U;
    stepIndex_ = 0U;
    stepEnvelope_ = 0.0f;
    stepAttackRemaining_ = 0U;
    transportStarted_ = false;
    phraseFinished_ = false;
    pitchPath_.reset();
}

bool AutoRiffFxProcessor::validateEvent(const AutoRiffFxEvent& event) const noexcept {
    if (!std::isfinite(event.value)) return false;
    switch (event.control) {
    case AutoRiffControl::Active:
    case AutoRiffControl::Hold:
    case AutoRiffControl::Loop:
        return event.value == 0.0f || event.value == 1.0f;
    case AutoRiffControl::Phrase:
        return event.value >= 1.0f && event.value <= static_cast<float>(kPhraseCount) &&
            std::floor(event.value) == event.value;
    case AutoRiffControl::TempoBpm: return event.value >= 30.0f && event.value <= 300.0f;
    case AutoRiffControl::Attack:
    case AutoRiffControl::Balance: return event.value >= 0.0f && event.value <= 100.0f;
    case AutoRiffControl::Key:
        return event.value >= 0.0f && event.value <= 11.0f && std::floor(event.value) == event.value;
    }
    return false;
}

bool AutoRiffFxProcessor::validateEvents(std::uint32_t frames,
        const AutoRiffFxEvent* events, std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && events == nullptr))
        return false;
    std::uint32_t last = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames || (i != 0U && events[i].frameOffset < last) ||
            !validateEvent(events[i])) return false;
        last = events[i].frameOffset;
    }
    return true;
}

void AutoRiffFxProcessor::setTempo(float bpm, std::uint64_t frame) noexcept {
    options_.tempoBpm = bpm;
    const double framesPerEighth = static_cast<double>(spec_.sampleRate) * 30.0 /
                                   static_cast<double>(bpm);
    stepPeriodQ32_ = static_cast<std::uint64_t>(std::llround(framesPerEighth * kQ32));
    if (transportStarted_) {
        stepDeadlineFrame_ = frame;
        stepFractionQ32_ = 0U;
        advanceStepDeadline();
    }
}

void AutoRiffFxProcessor::beginPhrase(std::uint64_t frame) noexcept {
    processingFrame_ = frame;
    stepIndex_ = 0U;
    stepCount_ = 0U;
    stepDeadlineFrame_ = frame;
    stepFractionQ32_ = 0U;
    stepEnvelope_ = 0.0f;
    stepAttackRemaining_ = 0U;
    transportStarted_ = true;
    phraseFinished_ = false;
}

void AutoRiffFxProcessor::advanceStepDeadline() noexcept {
    const std::uint64_t whole = stepPeriodQ32_ >> 32U;
    const std::uint64_t fractional = stepPeriodQ32_ & 0xffffffffULL;
    const std::uint64_t fractionalSum = static_cast<std::uint64_t>(stepFractionQ32_) + fractional;
    const std::uint64_t totalWhole = whole + (fractionalSum >> 32U);
    if (stepDeadlineFrame_ > kMaximumExactFrame - totalWhole) {
        transportStarted_ = false;
        phraseFinished_ = true;
        return;
    }
    stepDeadlineFrame_ += totalWhole;
    stepFractionQ32_ = static_cast<std::uint32_t>(fractionalSum & 0xffffffffULL);
}

void AutoRiffFxProcessor::advanceStep(std::uint64_t frame) noexcept {
    if (stepCount_ != 0U) {
        if (stepIndex_ + 1U < kStepsPerPhrase) ++stepIndex_;
        else if (options_.loop) stepIndex_ = 0U;
        else {
            phraseFinished_ = true;
            transportStarted_ = false;
            lastRatioLeft_ = lastRatioRight_ = 1.0f;
            (void)pitchPath_.setPitchTargets(1.0f, 1.0f, 0.0f);
            stepEnvelope_ = 0.0f;
            return;
        }
    }
    ++stepCount_;
    const std::uint32_t attackSamples = static_cast<std::uint32_t>(std::ceil(
        static_cast<double>(options_.attack) * 0.002 * spec_.sampleRate));
    stepAttackRemaining_ = attackSamples;
    stepEnvelope_ = attackSamples == 0U ? 1.0f : 0.0f;
    stepEnvelopeIncrement_ = attackSamples == 0U ? 1.0f : 1.0f / attackSamples;
    (void)frame;
    updatePitchTargets();
}

void AutoRiffFxProcessor::applyEvent(const AutoRiffFxEvent& event,
                                     std::uint64_t frame) noexcept {
    switch (event.control) {
    case AutoRiffControl::Active:
        activeTarget_ = event.value;
        if (event.value > 0.5f) beginPhrase(frame);
        else {
            transportStarted_ = false;
            phraseFinished_ = true;
            stepEnvelope_ = 0.0f;
            lastRatioLeft_ = lastRatioRight_ = 1.0f;
            (void)pitchPath_.setPitchTargets(1.0f, 1.0f, 0.0f);
        }
        break;
    case AutoRiffControl::Phrase:
        options_.phrase = static_cast<std::uint8_t>(event.value);
        beginPhrase(frame);
        break;
    case AutoRiffControl::TempoBpm: setTempo(event.value, frame); break;
    case AutoRiffControl::Hold:
        options_.hold = event.value > 0.5f; updatePitchTargets(); break;
    case AutoRiffControl::Loop:
        options_.loop = event.value > 0.5f;
        if (options_.loop && phraseFinished_ && activeTarget_ > 0.5f) beginPhrase(frame);
        break;
    case AutoRiffControl::Attack: options_.attack = event.value; break;
    case AutoRiffControl::Key:
        options_.key = static_cast<std::uint8_t>(event.value); updatePitchTargets(); break;
    case AutoRiffControl::Balance: balanceTarget_ = event.value / 100.0f; break;
    }
}

float AutoRiffFxProcessor::targetRatio(std::uint32_t channel) const noexcept {
    const auto estimate = pitchPath_.estimate(channel);
    if (!estimate.voiced || estimate.frequencyHz <= 0.0f)
        return options_.hold ? (channel == 0U ? lastRatioLeft_ : lastRatioRight_) : 1.0f;
    const int nearest = nearestMajorNote(midiFromFrequency(estimate.frequencyHz), options_.key);
    const int offset = kRiffPhrases[static_cast<std::size_t>(options_.phrase - 1U)][stepIndex_];
    const double target = static_cast<double>(nearest + offset);
    return ratioForTarget(estimate, target);
}

void AutoRiffFxProcessor::updatePitchTargets() noexcept {
    if (phraseFinished_ || !activeTarget_) {
        lastRatioLeft_ = lastRatioRight_ = 1.0f;
    } else {
        lastRatioLeft_ = targetRatio(0U);
        lastRatioRight_ = targetRatio(1U);
    }
    (void)pitchPath_.setPitchTargets(lastRatioLeft_, lastRatioRight_, 0.55f);
}

bool AutoRiffFxProcessor::processBlock(std::uint64_t blockStartFrame, StereoFrame* audio,
        std::uint32_t frames, const AutoRiffFxEvent* events,
        std::uint32_t eventCount) noexcept {
    if (!prepared_ || audio == nullptr || !validTimeline(blockStartFrame, frames,
            spec_.maxBlockFrames) || !validateEvents(frames, events, eventCount) ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_)) return false;
    (void)pitchPath_.processAnalysisBlock(audio, frames);
    updatePitchTargets();
    std::uint32_t event = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        processingFrame_ = blockStartFrame + frame;
        while (event < eventCount && events[event].frameOffset == frame)
            applyEvent(events[event++], processingFrame_);
        if (activeTarget_ > 0.5f && !transportStarted_ && !phraseFinished_)
            beginPhrase(processingFrame_);
        while (transportStarted_ && processingFrame_ >= stepDeadlineFrame_) {
            advanceStep(processingFrame_);
            if (transportStarted_) advanceStepDeadline();
        }
        activeCurrent_ = smooth(activeCurrent_, activeTarget_, controlCoefficient_);
        balanceCurrent_ = smooth(balanceCurrent_, balanceTarget_, controlCoefficient_);
        const StereoFrame dry{cleanAudio(audio[frame].left), cleanAudio(audio[frame].right)};
        const StereoFrame shifted = pitchPath_.processSample(dry);
        const auto left = pitchPath_.estimate(0U);
        const auto right = pitchPath_.estimate(1U);
        if (left.voiced || options_.hold) lastRatioLeft_ = targetRatio(0U);
        if (right.voiced || options_.hold) lastRatioRight_ = targetRatio(1U);
        const float envelope = stepEnvelope_ * activeCurrent_ * balanceCurrent_;
        float leftWet = left.voiced || options_.hold ? shifted.left : dry.left;
        float rightWet = right.voiced || options_.hold ? shifted.right : dry.right;
        leftWet = dry.left + envelope * (leftWet - dry.left);
        rightWet = dry.right + envelope * (rightWet - dry.right);
        audio[frame] = {cleanAudio(leftWet), cleanAudio(rightWet)};
        if (stepAttackRemaining_ != 0U) {
            stepEnvelope_ = std::min(1.0f, stepEnvelope_ + stepEnvelopeIncrement_);
            --stepAttackRemaining_;
        }
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

SynthesisPitchFxLatency AutoRiffFxProcessor::latency() const noexcept {
    const auto voice = pitchPath_.latency();
    return {0U, voice.analysisWindowFrames, voice.analysisHopFrames,
            voice.psolaLookaheadSamples, voice.analysisCold};
}

// ---------------------------- HRM AUTO(M) -------------------------------

std::size_t HarmonyAutoFxProcessor::requiredPrepareBytes(const ProcessSpec& spec) noexcept {
    if (!validAudioSpec(spec)) return 0U;
    const auto pathBytes = YinPsolaStereoPath::requiredPrepareBytes(spec);
    if (pathBytes < sizeof(YinPsolaStereoPath)) return 0U;
    const std::uint64_t bytes = sizeof(HarmonyAutoFxProcessor) +
        pathBytes - sizeof(YinPsolaStereoPath);
    return bytes > std::numeric_limits<std::size_t>::max() ? 0U : static_cast<std::size_t>(bytes);
}

bool HarmonyAutoFxProcessor::prepare(const ProcessSpec& spec,
                                     const HarmonyAutoFxOptions& options) {
    if (requiredPrepareBytes(spec) == 0U || !validEnum(options.voice) || !validEnum(options.mode) ||
        !std::isfinite(options.formant) || options.formant < -50.0f || options.formant > 50.0f ||
        !std::isfinite(options.pan) || options.pan < -50.0f || options.pan > 50.0f ||
        options.key > 11U || !std::isfinite(options.dryLevel) || options.dryLevel < 0.0f ||
        options.dryLevel > 100.0f || !std::isfinite(options.harmonyLevel) ||
        options.harmonyLevel < 0.0f || options.harmonyLevel > 100.0f ||
        !pitchPath_.prepare(spec)) return false;
    spec_ = spec;
    options_ = options;
    for (auto& channel : formantFilters_) {
        for (auto& filter : channel)
            if (!filter.prepare(spec_)) return false;
    }
    updateFormantFilters(options.formant);
    const std::uint64_t bytes = sizeof(*this) + pitchPath_.preparedBytes() -
                                sizeof(YinPsolaStereoPath);
    if (bytes > std::numeric_limits<std::size_t>::max()) return false;
    preparedBytes_ = static_cast<std::size_t>(bytes);
    controlCoefficient_ = coefficient(8.0f, spec_.sampleRate);
    activeCurrent_ = activeTarget_ = 1.0f;
    dryCurrent_ = dryTarget_ = options.dryLevel / 100.0f;
    harmonyCurrent_ = harmonyTarget_ = options.harmonyLevel / 100.0f;
    panCurrent_ = panTarget_ = options.pan / 50.0f;
    prepared_ = true;
    reset();
    updatePitchTargets();
    return true;
}

void HarmonyAutoFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = false;
    pitchPath_.reset();
    for (auto& channel : formantFilters_)
        for (auto& filter : channel) filter.reset();
    midiTarget_ = -1;
    midiTargetActive_ = false;
}

bool HarmonyAutoFxProcessor::validateEvent(const HarmonyAutoFxEvent& event) const noexcept {
    if (!std::isfinite(event.value)) return false;
    switch (event.control) {
    case HarmonyAutoControl::Active: return event.value == 0.0f || event.value == 1.0f;
    case HarmonyAutoControl::Voice:
        return event.value >= 0.0f && event.value <= 6.0f && std::floor(event.value) == event.value;
    case HarmonyAutoControl::Formant: return event.value >= -50.0f && event.value <= 50.0f;
    case HarmonyAutoControl::Pan: return event.value >= -50.0f && event.value <= 50.0f;
    case HarmonyAutoControl::Mode: return event.value == 1.0f || event.value == 2.0f;
    case HarmonyAutoControl::Key:
        return event.value >= 0.0f && event.value <= 11.0f && std::floor(event.value) == event.value;
    case HarmonyAutoControl::DryLevel:
    case HarmonyAutoControl::HarmonyLevel: return event.value >= 0.0f && event.value <= 100.0f;
    case HarmonyAutoControl::MidiNoteOn:
    case HarmonyAutoControl::MidiNoteOff:
    case HarmonyAutoControl::MidiAllNotesOff: return event.value >= 0.0f && event.value <= 1.0f;
    }
    return false;
}

bool HarmonyAutoFxProcessor::validateEvents(std::uint32_t frames,
        const HarmonyAutoFxEvent* events, std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && events == nullptr))
        return false;
    std::uint32_t last = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames || (i != 0U && events[i].frameOffset < last) ||
            !validateEvent(events[i])) return false;
        if ((events[i].control == HarmonyAutoControl::MidiNoteOn ||
             events[i].control == HarmonyAutoControl::MidiNoteOff) && events[i].midiNote > 127U)
            return false;
        last = events[i].frameOffset;
    }
    return true;
}

void HarmonyAutoFxProcessor::updateFormantFilters(float formant) noexcept {
    const float multiplier = std::exp2(formant / 50.0f);
    const std::array<float, 2U> centers{{520.0f, 1750.0f}};
    const std::array<float, 2U> gains{{3.0f, 2.0f}};
    for (auto& channel : formantFilters_)
        for (std::size_t band = 0U; band < channel.size(); ++band)
            (void)channel[band].setPeaking(std::clamp(centers[band] * multiplier,
                30.0f, 0.44f * spec_.sampleRate), 1.0f, gains[band], 12.0f);
}

float HarmonyAutoFxProcessor::targetRatio(std::uint32_t channel) const noexcept {
    const auto estimate = pitchPath_.estimate(channel);
    if (!estimate.voiced || estimate.frequencyHz <= 0.0f) return 1.0f;
    const double sourceMidi = midiFromFrequency(estimate.frequencyHz);
    if (options_.mode == HarmonyAutoMode::Hybrid && midiTargetActive_ && midiTarget_ >= 0)
        return ratioForTarget(estimate, midiTarget_);
    const int nearest = nearestMajorNote(sourceMidi, options_.key);
    int target = nearest;
    switch (options_.voice) {
    case HarmonyAutoVoice::OctaveDown: target = nearest - 12; break;
    case HarmonyAutoVoice::OctaveUp: target = nearest + 12; break;
    case HarmonyAutoVoice::Lower: target = advanceMajorDegrees(nearest, -2, options_.key); break;
    case HarmonyAutoVoice::Low: target = advanceMajorDegrees(nearest, -4, options_.key); break;
    case HarmonyAutoVoice::High: target = advanceMajorDegrees(nearest, 2, options_.key); break;
    case HarmonyAutoVoice::Higher: target = advanceMajorDegrees(nearest, 4, options_.key); break;
    case HarmonyAutoVoice::Unison: target = nearest; break;
    }
    if (options_.mode == HarmonyAutoMode::Hybrid && !midiTargetActive_) {
        const std::array<int, 7U> semitones{{-12, 12, -4, -7, 4, 7, 0}};
        target = static_cast<int>(std::round(sourceMidi)) +
            semitones[static_cast<std::size_t>(options_.voice)];
    }
    return ratioForTarget(estimate, static_cast<double>(target));
}

void HarmonyAutoFxProcessor::updatePitchTargets() noexcept {
    (void)pitchPath_.setPitchTargets(targetRatio(0U), targetRatio(1U), 0.55f);
}

void HarmonyAutoFxProcessor::applyEvent(const HarmonyAutoFxEvent& event) noexcept {
    switch (event.control) {
    case HarmonyAutoControl::Active: activeTarget_ = event.value; break;
    case HarmonyAutoControl::Voice:
        options_.voice = static_cast<HarmonyAutoVoice>(static_cast<std::uint8_t>(event.value));
        updatePitchTargets(); break;
    case HarmonyAutoControl::Formant:
        options_.formant = event.value; updateFormantFilters(event.value); break;
    case HarmonyAutoControl::Pan:
        options_.pan = event.value; panTarget_ = event.value / 50.0f; break;
    case HarmonyAutoControl::Mode:
        options_.mode = event.value < 1.5f ? HarmonyAutoMode::Hybrid : HarmonyAutoMode::Auto;
        updatePitchTargets(); break;
    case HarmonyAutoControl::Key:
        options_.key = static_cast<std::uint8_t>(event.value); updatePitchTargets(); break;
    case HarmonyAutoControl::DryLevel: dryTarget_ = event.value / 100.0f; break;
    case HarmonyAutoControl::HarmonyLevel: harmonyTarget_ = event.value / 100.0f; break;
    case HarmonyAutoControl::MidiNoteOn:
        midiTarget_ = event.midiNote;
        midiTargetActive_ = event.value > 0.0f;
        updatePitchTargets(); break;
    case HarmonyAutoControl::MidiNoteOff:
        if (midiTarget_ == static_cast<std::int16_t>(event.midiNote)) {
            midiTarget_ = -1; midiTargetActive_ = false; updatePitchTargets();
        }
        break;
    case HarmonyAutoControl::MidiAllNotesOff:
        midiTarget_ = -1; midiTargetActive_ = false; updatePitchTargets(); break;
    }
}

bool HarmonyAutoFxProcessor::processBlock(std::uint64_t blockStartFrame, StereoFrame* audio,
        std::uint32_t frames, const HarmonyAutoFxEvent* events,
        std::uint32_t eventCount) noexcept {
    if (!prepared_ || audio == nullptr || !validTimeline(blockStartFrame, frames,
            spec_.maxBlockFrames) || !validateEvents(frames, events, eventCount) ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_)) return false;
    (void)pitchPath_.processAnalysisBlock(audio, frames);
    updatePitchTargets();
    std::uint32_t event = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (event < eventCount && events[event].frameOffset == frame)
            applyEvent(events[event++]);
        activeCurrent_ = smooth(activeCurrent_, activeTarget_, controlCoefficient_);
        dryCurrent_ = smooth(dryCurrent_, dryTarget_, controlCoefficient_);
        harmonyCurrent_ = smooth(harmonyCurrent_, harmonyTarget_, controlCoefficient_);
        panCurrent_ = smooth(panCurrent_, panTarget_, controlCoefficient_);
        const StereoFrame input{cleanAudio(audio[frame].left), cleanAudio(audio[frame].right)};
        StereoFrame harmony = pitchPath_.processSample(input);
        const auto leftPitch = pitchPath_.estimate(0U);
        const auto rightPitch = pitchPath_.estimate(1U);
        harmony.left = cleanAudio(formantFilters_[0U][1U].processSample(
            formantFilters_[0U][0U].processSample(harmony.left)));
        harmony.right = cleanAudio(formantFilters_[1U][1U].processSample(
            formantFilters_[1U][0U].processSample(harmony.right)));
        const float pan = std::clamp(panCurrent_, -1.0f, 1.0f);
        const float leftPan = pan > 0.0f ? std::cos(static_cast<float>(0.5 * kPi) * pan) : 1.0f;
        const float rightPan = pan < 0.0f ? std::cos(static_cast<float>(0.5 * kPi) * -pan) : 1.0f;
        const float leftWet = activeCurrent_ * harmonyCurrent_ * (leftPitch.voiced ? 1.0f : 0.0f);
        const float rightWet = activeCurrent_ * harmonyCurrent_ * (rightPitch.voiced ? 1.0f : 0.0f);
        const float leftDry = 1.0f - activeCurrent_ + activeCurrent_ * dryCurrent_;
        const float rightDry = leftDry;
        audio[frame] = {
            cleanAudio(input.left * leftDry + harmony.left * leftPan * leftWet),
            cleanAudio(input.right * rightDry + harmony.right * rightPan * rightWet)};
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

SynthesisPitchFxLatency HarmonyAutoFxProcessor::latency() const noexcept {
    const auto voice = pitchPath_.latency();
    return {0U, voice.analysisWindowFrames, voice.analysisHopFrames,
            voice.psolaLookaheadSamples, voice.analysisCold};
}

} // namespace webrc::dsp
