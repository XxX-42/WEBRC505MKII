#include "webrc/dsp/rhythmic_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kButterworthQ = 0.707106781186547524400844362104849039;
constexpr double kLowCrossoverHz = 240.0;
constexpr double kHighCrossoverHz = 2400.0;
constexpr double kSmoothingSeconds = 0.005;
constexpr double kMinimumBpm = 20.0;
constexpr double kMaximumBpm = 300.0;
constexpr double kEdgeAutomationSmoothingSeconds = 0.02;
constexpr float kMaximumAudio = 8.0f;

constexpr std::array<float, 16> kQuarterGate{{
    1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0
}};
constexpr std::array<float, 16> kEighthGate{{
    1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0
}};
constexpr std::array<float, 16> kSixteenthPulseGate{{
    1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0
}};
constexpr std::array<float, 16> kOffbeatGate{{
    0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0
}};
constexpr std::array<float, 16> kSyncopatedGate{{
    1,0,1,0, 0,1,0,0, 1,0,0,1, 0,1,0,0
}};
constexpr std::array<float, 16> kTripletGate{{
    1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,0
}};
constexpr std::array<float, 16> kLongShortGate{{
    1,1,0,0, 1,1,1,0, 1,1,0,0, 1,1,1,0
}};
constexpr std::array<float, 16> kSparseGate{{
    1,0,0,0, 0,0,1,0, 0,0,0,1, 0,1,0,0
}};

constexpr RhythmicPatternDescriptor makePattern(
    const char* id, const char* name, std::array<float, 16> levels,
    std::array<float, 16> pans = {}, std::array<float, 16> cutoffs = {}) {
    return {id, name, levels, pans, cutoffs};
}

constexpr std::array<RhythmicPatternDescriptor, 8> kGatePatterns{{
    makePattern("quarter-pulse", "Quarter pulse", kQuarterGate),
    makePattern("eighth-chop", "Eighth chop", kEighthGate),
    makePattern("bar-downbeats", "Bar downbeats", kSixteenthPulseGate),
    makePattern("offbeat-eighth", "Offbeat eighths", kOffbeatGate),
    makePattern("syncopated-16", "Syncopated 16", kSyncopatedGate),
    makePattern("triplet-accent", "Triplet accent", kTripletGate),
    makePattern("long-short", "Long-short", kLongShortGate),
    makePattern("sparse-break", "Sparse break", kSparseGate),
}};

constexpr std::array<RhythmicPatternDescriptor, 6> kStepPatterns{{
    makePattern("step-eighth-gap", "Eighth gaps",
        {{1.00f,0.00f,0.82f,0.00f, 0.94f,0.22f,0.72f,0.00f,
          1.00f,0.00f,0.78f,0.14f, 0.90f,0.00f,0.66f,0.00f}},
        {{0.00f,-0.30f,-0.10f,0.30f, 0.00f,-0.45f,0.18f,0.45f,
          0.00f,-0.30f,-0.10f,0.30f, 0.00f,-0.45f,0.18f,0.45f}},
        {{18000,9000,7000,4200, 16000,8000,6200,3600,
          18000,9000,7000,4200, 15000,7600,5600,3200}}),
    makePattern("step-four-beat", "Four-beat accents",
        {{1.00f,0.72f,0.78f,0.66f, 0.96f,0.70f,0.76f,0.62f,
          1.00f,0.72f,0.78f,0.66f, 0.96f,0.70f,0.76f,0.62f}},
        {{-0.25f,-0.12f,0.00f,0.12f, 0.25f,0.12f,0.00f,-0.12f,
          -0.25f,-0.12f,0.00f,0.12f, 0.25f,0.12f,0.00f,-0.12f}},
        {{14000,12000,10000,9000, 13500,11500,9600,8400,
          14000,12000,10000,9000, 13500,11500,9600,8400}}),
    makePattern("step-syncopated", "Syncopated accents",
        {{1.00f,0.00f,0.58f,0.18f, 0.00f,0.82f,0.00f,0.32f,
          0.92f,0.00f,0.26f,0.68f, 0.00f,0.76f,0.22f,0.00f}},
        {{0.00f,-0.50f,-0.15f,0.45f, -0.60f,0.12f,0.50f,-0.32f,
          0.00f,-0.45f,0.25f,0.55f, -0.55f,0.10f,0.38f,-0.25f}},
        {{18000,5000,12000,7200, 3800,15000,4600,10000,
          16000,4200,8200,13500, 3600,14800,7400,4100}}),
    makePattern("step-half-time", "Half-time sweep",
        {{1.00f,0.92f,0.82f,0.70f, 0.58f,0.45f,0.35f,0.26f,
          0.18f,0.25f,0.38f,0.54f, 0.70f,0.82f,0.92f,1.00f}},
        {{-0.70f,-0.60f,-0.48f,-0.35f, -0.20f,-0.05f,0.10f,0.25f,
          0.40f,0.55f,0.68f,0.55f, 0.38f,0.18f,-0.28f,-0.55f}},
        {{4000,4600,5400,6400, 7600,9000,10600,12400,
          14500,16500,18000,16500, 14500,12000,9000,6200}}),
    makePattern("step-low-pass", "Low-pass movement",
        {{0.92f,0.92f,0.84f,0.84f, 0.76f,0.76f,0.68f,0.68f,
          0.60f,0.60f,0.68f,0.68f, 0.78f,0.78f,0.90f,0.90f}},
        {{0.00f,0.00f,0.18f,0.18f, 0.38f,0.38f,0.58f,0.58f,
          0.72f,0.72f,0.52f,0.52f, 0.30f,0.30f,0.12f,0.12f}},
        {{16000,14000,12000,10000, 8000,6500,5200,4000,
          3000,2200,3200,4600, 6500,9000,12000,15000}}),
    makePattern("step-triple-break", "Triple break",
        {{1.00f,0.00f,0.60f,0.00f, 0.78f,0.00f,0.52f,0.18f,
          0.00f,0.84f,0.00f,0.56f, 0.00f,0.72f,0.00f,0.28f}},
        {{-0.40f,-0.20f,0.00f,0.20f, 0.40f,0.20f,0.00f,-0.20f,
          -0.40f,-0.20f,0.00f,0.20f, 0.40f,0.20f,0.00f,-0.20f}},
        {{15000,5000,12000,4600, 14000,4300,11000,7600,
          3900,14500,4100,9800, 3600,13000,4400,7200}}),
}};

[[nodiscard]] bool validKind(RhythmicFxKind kind) noexcept {
    return static_cast<std::uint8_t>(kind) <=
           static_cast<std::uint8_t>(RhythmicFxKind::StepSlicer);
}

[[nodiscard]] bool finiteRange(float value, float low, float high) noexcept {
    return std::isfinite(value) && value >= low && value <= high;
}

[[nodiscard]] float bounded(float value) noexcept {
    return std::clamp(sanitize(value), -kMaximumAudio, kMaximumAudio);
}

[[nodiscard]] float gainForDb(float db) noexcept {
    return static_cast<float>(std::pow(10.0, static_cast<double>(db) / 20.0));
}

[[nodiscard]] std::uint32_t patternCountFor(RhythmicFxKind kind) noexcept {
    if (kind == RhythmicFxKind::PatternSlicer)
        return static_cast<std::uint32_t>(kGatePatterns.size());
    if (kind == RhythmicFxKind::StepSlicer)
        return static_cast<std::uint32_t>(kStepPatterns.size());
    return 0U;
}

} // namespace

std::uint32_t rhythmicFxPatternCount(RhythmicFxKind kind) noexcept {
    return validKind(kind) ? patternCountFor(kind) : 0U;
}

const RhythmicPatternDescriptor* rhythmicFxPattern(RhythmicFxKind kind,
                                                    std::uint32_t patternIndex) noexcept {
    if (!validKind(kind)) return nullptr;
    if (kind == RhythmicFxKind::PatternSlicer)
        return patternIndex < kGatePatterns.size() ? &kGatePatterns[patternIndex] : nullptr;
    if (kind == RhythmicFxKind::StepSlicer)
        return patternIndex < kStepPatterns.size() ? &kStepPatterns[patternIndex] : nullptr;
    return nullptr;
}

std::size_t RhythmicFxProcessor::requiredMemoryBytes(const ProcessSpec& spec,
                                                     RhythmicFxKind kind) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2U || spec.sampleRate > 192000.0f ||
        !validKind(kind)) return 0U;
    return sizeof(RhythmicFxProcessor);
}

std::uint16_t RhythmicFxProcessor::effectOrdinal(RhythmicFxKind kind) noexcept {
    switch (kind) {
    case RhythmicFxKind::Isolator: return 27U;
    case RhythmicFxKind::PatternSlicer: return 34U;
    case RhythmicFxKind::StepSlicer: return 35U;
    }
    return 0U;
}

void RhythmicFxProcessor::BiquadState::setButterworth(double sampleRate,
                                                      double frequencyHz,
                                                      bool highpass) noexcept {
    const double omega = 2.0 * kPi * frequencyHz / sampleRate;
    const double cosine = std::cos(omega);
    const double alpha = std::sin(omega) / (2.0 * kButterworthQ);
    const double a0 = 1.0 + alpha;
    if (highpass) {
        b0 = ((1.0 + cosine) * 0.5) / a0;
        b1 = (-(1.0 + cosine)) / a0;
        b2 = b0;
    } else {
        b0 = ((1.0 - cosine) * 0.5) / a0;
        b1 = (1.0 - cosine) / a0;
        b2 = b0;
    }
    a1 = (-2.0 * cosine) / a0;
    a2 = (1.0 - alpha) / a0;
    reset();
}

float RhythmicFxProcessor::BiquadState::process(float input) noexcept {
    const double x = static_cast<double>(sanitize(input));
    const double output = b0 * x + z1;
    z1 = b1 * x - a1 * output + z2;
    z2 = b2 * x - a2 * output;
    if (!std::isfinite(output) || std::fabs(output) < 1.0e-20) {
        if (!std::isfinite(z1) || std::fabs(z1) < 1.0e-20) z1 = 0.0;
        if (!std::isfinite(z2) || std::fabs(z2) < 1.0e-20) z2 = 0.0;
        return 0.0f;
    }
    return bounded(static_cast<float>(output));
}

bool RhythmicFxProcessor::prepare(const ProcessSpec& spec, RhythmicFxKind kind) noexcept {
    const auto budget = requiredMemoryBytes(spec, kind);
    if (budget == 0U) return false;
    prepared_ = false;
    spec_ = spec;
    kind_ = kind;
    preparedBytes_ = budget;
    smoothingCoefficient_ = 1.0 - std::exp(-1.0 /
        (static_cast<double>(spec.sampleRate) * kSmoothingSeconds));
    edgeSmoothingCoefficient_ = 1.0 - std::exp(-1.0 /
        (static_cast<double>(spec.sampleRate) * kEdgeAutomationSmoothingSeconds));
    for (std::uint32_t channel = 0; channel < 2U; ++channel) {
        auto& crossover = crossovers_[channel];
        for (std::uint32_t stage = 0; stage < 2U; ++stage) {
            crossover.lowerLow[stage].setButterworth(spec.sampleRate, kLowCrossoverHz, false);
            crossover.lowerHigh[stage].setButterworth(spec.sampleRate, kLowCrossoverHz, true);
            crossover.upperLowRemainder[stage].setButterworth(spec.sampleRate,
                                                               kHighCrossoverHz, false);
            crossover.upperHighRemainder[stage].setButterworth(spec.sampleRate,
                                                                kHighCrossoverHz, true);
            crossover.upperLowLow[stage].setButterworth(spec.sampleRate,
                                                         kHighCrossoverHz, false);
            crossover.upperHighLow[stage].setButterworth(spec.sampleRate,
                                                          kHighCrossoverHz, true);
        }
    }
    bandGainDb_ = {0.0f, 0.0f, 0.0f};
    bandMuted_ = {false, false, false};
    bandGainTarget_ = {1.0f, 1.0f, 1.0f};
    bandGainCurrent_ = bandGainTarget_;
    lowFilterState_ = {};
    edgeMs_ = 1.0;
    edgeTargetMs_ = 1.0;
    edgeStepMultiplier_ = 1.0;
    bpm_ = 120.0;
    ticksPerFrame_ = bpm_ * static_cast<double>(kTicksPerQuarter) /
                     (60.0 * static_cast<double>(spec.sampleRate));
    patternId_ = 0U;
    previousPatternId_ = 0U;
    activePatternBlend_ = targetPatternBlend_ = 1.0;
    stepGainDirtyMask_ = stepPanDirtyMask_ = stepCutoffDirtyMask_ = 0U;
    active_ = false;
    targetActiveGain_ = activeGain_ = 0.0f;
    wet_ = wetCurrent_ = 1.0f;
    const auto* preset = rhythmicFxPattern(kind, 0U);
    for (std::uint32_t step = 0; step < kPatternSteps; ++step) {
        const float gain = preset ? preset->levels[step] : 1.0f;
        const float pan = preset ? preset->pans[step] : 0.0f;
        const float cutoff = preset && preset->cutoffHz[step] > 0.0f
            ? preset->cutoffHz[step] : spec.sampleRate * 0.45f;
        stepGainTarget_[step] = stepGainCurrent_[step] = gain;
        stepPanTarget_[step] = stepPanCurrent_[step] = pan;
        const double alpha = 1.0 - std::exp(-2.0 * kPi * static_cast<double>(cutoff) /
                                             static_cast<double>(spec.sampleRate));
        stepCutoffAlphaTarget_[step] = stepCutoffAlphaCurrent_[step] =
            static_cast<float>(std::clamp(alpha, 0.00001, 0.99999));
        activePatternFrom_[step] = preset ? preset->levels[step] : 1.0f;
    }
    epochFrame_ = expectedFrame_ = 0U;
    epochTicks_ = 0.0;
    hasClockOrigin_ = false;
    hasExpectedFrame_ = false;
    prepared_ = true;
    return true;
}

void RhythmicFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    for (auto& channel : crossovers_) {
        for (auto& state : channel.lowerLow) state.reset();
        for (auto& state : channel.lowerHigh) state.reset();
        for (auto& state : channel.upperLowRemainder) state.reset();
        for (auto& state : channel.upperHighRemainder) state.reset();
        for (auto& state : channel.upperLowLow) state.reset();
        for (auto& state : channel.upperHighLow) state.reset();
    }
    lowFilterState_ = {};
    activeGain_ = targetActiveGain_ = active_ ? 1.0f : 0.0f;
    wetCurrent_ = wet_;
    bandGainCurrent_ = bandGainTarget_;
    stepGainCurrent_ = stepGainTarget_;
    stepPanCurrent_ = stepPanTarget_;
    stepCutoffAlphaCurrent_ = stepCutoffAlphaTarget_;
    edgeMs_ = edgeTargetMs_;
    edgeStepMultiplier_ = 1.0;
    stepGainDirtyMask_ = stepPanDirtyMask_ = stepCutoffDirtyMask_ = 0U;
    activePatternBlend_ = targetPatternBlend_ = 1.0;
    epochFrame_ = expectedFrame_ = absoluteFrame;
    epochTicks_ = 0.0;
    hasClockOrigin_ = hasExpectedFrame_ = true;
}

bool RhythmicFxProcessor::validateEvent(const RhythmicFxEvent& event) const noexcept {
    switch (event.control) {
    case RhythmicFxControl::Active:
        return event.value == 0.0f || event.value == 1.0f;
    case RhythmicFxControl::Wet:
        return finiteRange(event.value, 0.0f, 1.0f);
    case RhythmicFxControl::TempoBpm:
        return finiteRange(event.value, static_cast<float>(kMinimumBpm),
                           static_cast<float>(kMaximumBpm));
    case RhythmicFxControl::EdgeMilliseconds:
        return kind_ != RhythmicFxKind::Isolator && finiteRange(event.value, 0.1f, 10.0f);
    case RhythmicFxControl::PatternId:
        return kind_ != RhythmicFxKind::Isolator && finiteRange(event.value, 0.0f,
            static_cast<float>(patternCountFor(kind_) - 1U)) &&
            std::floor(event.value) == event.value;
    case RhythmicFxControl::LowGainDb:
        return kind_ == RhythmicFxKind::Isolator && finiteRange(event.value, -80.0f, 12.0f);
    case RhythmicFxControl::MidGainDb:
        return kind_ == RhythmicFxKind::Isolator && finiteRange(event.value, -80.0f, 12.0f);
    case RhythmicFxControl::HighGainDb:
        return kind_ == RhythmicFxKind::Isolator && finiteRange(event.value, -80.0f, 12.0f);
    case RhythmicFxControl::LowMute:
    case RhythmicFxControl::MidMute:
    case RhythmicFxControl::HighMute:
        return kind_ == RhythmicFxKind::Isolator &&
               (event.value == 0.0f || event.value == 1.0f);
    case RhythmicFxControl::StepGain:
        return kind_ == RhythmicFxKind::StepSlicer && event.stepIndex < kPatternSteps &&
               finiteRange(event.value, 0.0f, 1.0f);
    case RhythmicFxControl::StepPan:
        return kind_ == RhythmicFxKind::StepSlicer && event.stepIndex < kPatternSteps &&
               finiteRange(event.value, -1.0f, 1.0f);
    case RhythmicFxControl::StepCutoffHz:
        return kind_ == RhythmicFxKind::StepSlicer && event.stepIndex < kPatternSteps &&
               finiteRange(event.value, 40.0f, spec_.sampleRate * 0.45f);
    }
    return false;
}

bool RhythmicFxProcessor::validateEvents(std::uint32_t frames,
                                         const RhythmicFxEvent* events,
                                         std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && !events))
        return false;
    std::uint32_t previousOffset = 0U;
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        const auto& event = events[i];
        if (event.frameOffset >= frames ||
            (i != 0U && event.frameOffset < previousOffset) || !validateEvent(event))
            return false;
        previousOffset = event.frameOffset;
    }
    return true;
}

void RhythmicFxProcessor::applyEvent(const RhythmicFxEvent& event,
                                     std::uint64_t absoluteFrame) noexcept {
    switch (event.control) {
    case RhythmicFxControl::Active:
        active_ = event.value > 0.5f;
        targetActiveGain_ = active_ ? 1.0f : 0.0f;
        break;
    case RhythmicFxControl::Wet:
        wet_ = event.value;
        break;
    case RhythmicFxControl::TempoBpm: {
        epochTicks_ = tickAtFrame(absoluteFrame);
        epochFrame_ = absoluteFrame;
        bpm_ = static_cast<double>(event.value);
        ticksPerFrame_ = bpm_ * static_cast<double>(kTicksPerQuarter) /
                         (60.0 * static_cast<double>(spec_.sampleRate));
        break;
    }
    case RhythmicFxControl::EdgeMilliseconds:
        edgeTargetMs_ = static_cast<double>(event.value);
        if (std::fabs(edgeTargetMs_ - edgeMs_) <= 1.0e-9) {
            edgeMs_ = edgeTargetMs_;
            edgeStepMultiplier_ = 1.0;
        } else {
            // Smooth in logarithmic edge length so the full 0.1–10 ms control
            // range has a bounded fractional step even when automation moves
            // from an extreme to the other in one event.
            edgeStepMultiplier_ = std::exp(
                std::log(edgeTargetMs_ / edgeMs_) * edgeSmoothingCoefficient_);
        }
        break;
    case RhythmicFxControl::PatternId: {
        const auto selected = static_cast<std::uint32_t>(event.value);
        if (kind_ == RhythmicFxKind::PatternSlicer) {
            const auto* current = rhythmicFxPattern(kind_, patternId_);
            if (current) {
                const float previousWeight = static_cast<float>(1.0 - activePatternBlend_);
                const float currentWeight = static_cast<float>(activePatternBlend_);
                for (std::uint32_t step = 0; step < kPatternSteps; ++step)
                    activePatternFrom_[step] = activePatternFrom_[step] * previousWeight +
                                               current->levels[step] * currentWeight;
            }
            previousPatternId_ = patternId_;
            patternId_ = selected;
            activePatternBlend_ = 0.0;
            targetPatternBlend_ = 1.0;
        } else {
            const auto* preset = rhythmicFxPattern(kind_, selected);
            if (preset) {
                patternId_ = selected;
                for (std::uint32_t step = 0; step < kPatternSteps; ++step) {
                    stepGainTarget_[step] = preset->levels[step];
                    stepPanTarget_[step] = preset->pans[step];
                    const double alpha = 1.0 - std::exp(-2.0 * kPi *
                        static_cast<double>(preset->cutoffHz[step]) /
                        static_cast<double>(spec_.sampleRate));
                    stepCutoffAlphaTarget_[step] = static_cast<float>(
                        std::clamp(alpha, 0.00001, 0.99999));
                }
                stepGainDirtyMask_ = stepPanDirtyMask_ = stepCutoffDirtyMask_ = 0xffffU;
            }
        }
        break;
    }
    case RhythmicFxControl::LowGainDb:
    case RhythmicFxControl::MidGainDb:
    case RhythmicFxControl::HighGainDb: {
        const auto band = static_cast<std::uint32_t>(event.control) -
                          static_cast<std::uint32_t>(RhythmicFxControl::LowGainDb);
        bandGainDb_[band] = event.value;
        bandGainTarget_[band] = bandMuted_[band] ? 0.0f : gainForDb(event.value);
        break;
    }
    case RhythmicFxControl::LowMute:
    case RhythmicFxControl::MidMute:
    case RhythmicFxControl::HighMute: {
        const auto band = static_cast<std::uint32_t>(event.control) -
                          static_cast<std::uint32_t>(RhythmicFxControl::LowMute);
        bandMuted_[band] = event.value > 0.5f;
        bandGainTarget_[band] = bandMuted_[band] ? 0.0f : gainForDb(bandGainDb_[band]);
        break;
    }
    case RhythmicFxControl::StepGain:
        stepGainTarget_[event.stepIndex] = event.value;
        stepGainDirtyMask_ |= 1U << event.stepIndex;
        break;
    case RhythmicFxControl::StepPan:
        stepPanTarget_[event.stepIndex] = event.value;
        stepPanDirtyMask_ |= 1U << event.stepIndex;
        break;
    case RhythmicFxControl::StepCutoffHz: {
        const double alpha = 1.0 - std::exp(-2.0 * kPi * static_cast<double>(event.value) /
                                             static_cast<double>(spec_.sampleRate));
        stepCutoffAlphaTarget_[event.stepIndex] = static_cast<float>(
            std::clamp(alpha, 0.00001, 0.99999));
        stepCutoffDirtyMask_ |= 1U << event.stepIndex;
        break;
    }
    }
}

void RhythmicFxProcessor::advanceSmoothers() noexcept {
    const float coefficient = static_cast<float>(smoothingCoefficient_);
    activeGain_ += (targetActiveGain_ - activeGain_) * coefficient;
    wetCurrent_ += (wet_ - wetCurrent_) * coefficient;
    for (std::uint32_t band = 0; band < 3U; ++band) {
        bandGainCurrent_[band] += (bandGainTarget_[band] - bandGainCurrent_[band]) * coefficient;
        if (std::fabs(bandGainTarget_[band] - bandGainCurrent_[band]) < 1.0e-6f)
            bandGainCurrent_[band] = bandGainTarget_[band];
    }
    if (targetPatternBlend_ != activePatternBlend_) {
        activePatternBlend_ += (targetPatternBlend_ - activePatternBlend_) *
                               smoothingCoefficient_;
        if (std::fabs(targetPatternBlend_ - activePatternBlend_) < 1.0e-6)
            activePatternBlend_ = targetPatternBlend_;
    }
    for (std::uint32_t step = 0; step < kPatternSteps; ++step) {
        const auto bit = 1U << step;
        if ((stepGainDirtyMask_ & bit) != 0U) {
            stepGainCurrent_[step] += (stepGainTarget_[step] - stepGainCurrent_[step]) *
                                      coefficient;
            if (std::fabs(stepGainTarget_[step] - stepGainCurrent_[step]) < 1.0e-6f) {
                stepGainCurrent_[step] = stepGainTarget_[step];
                stepGainDirtyMask_ &= ~bit;
            }
        }
        if ((stepPanDirtyMask_ & bit) != 0U) {
            stepPanCurrent_[step] += (stepPanTarget_[step] - stepPanCurrent_[step]) *
                                     coefficient;
            if (std::fabs(stepPanTarget_[step] - stepPanCurrent_[step]) < 1.0e-6f) {
                stepPanCurrent_[step] = stepPanTarget_[step];
                stepPanDirtyMask_ &= ~bit;
            }
        }
        if ((stepCutoffDirtyMask_ & bit) != 0U) {
            stepCutoffAlphaCurrent_[step] +=
                (stepCutoffAlphaTarget_[step] - stepCutoffAlphaCurrent_[step]) * coefficient;
            if (std::fabs(stepCutoffAlphaTarget_[step] -
                          stepCutoffAlphaCurrent_[step]) < 1.0e-6f) {
                stepCutoffAlphaCurrent_[step] = stepCutoffAlphaTarget_[step];
                stepCutoffDirtyMask_ &= ~bit;
            }
        }
    }
    if (edgeStepMultiplier_ != 1.0 && edgeMs_ != edgeTargetMs_) {
        const double nextEdgeMs = edgeMs_ * edgeStepMultiplier_;
        const bool crossedTarget = edgeStepMultiplier_ > 1.0
            ? nextEdgeMs >= edgeTargetMs_ : nextEdgeMs <= edgeTargetMs_;
        if (crossedTarget || std::fabs(edgeTargetMs_ - nextEdgeMs) <=
                             std::max(1.0e-9, edgeTargetMs_ * 1.0e-8)) {
            edgeMs_ = edgeTargetMs_;
            edgeStepMultiplier_ = 1.0;
        } else {
            edgeMs_ = nextEdgeMs;
        }
    }
}

bool RhythmicFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                       StereoFrame* interleaved,
                                       std::uint32_t frames,
                                       const RhythmicFxEvent* events,
                                       std::uint32_t eventCount) noexcept {
    if (!prepared_ || !interleaved || frames == 0U || frames > spec_.maxBlockFrames ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        blockStartFrame + frames > kMaximumExactFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (!hasClockOrigin_) {
        epochFrame_ = blockStartFrame;
        epochTicks_ = 0.0;
        hasClockOrigin_ = true;
    }
    if (!hasExpectedFrame_) {
        expectedFrame_ = blockStartFrame;
        hasExpectedFrame_ = true;
    }
    std::uint32_t eventIndex = 0U;
    for (std::uint32_t offset = 0; offset < frames; ++offset) {
        const auto absoluteFrame = blockStartFrame + offset;
        while (eventIndex < eventCount && events[eventIndex].frameOffset == offset) {
            applyEvent(events[eventIndex], absoluteFrame);
            ++eventIndex;
        }
        interleaved[offset] = processSample(interleaved[offset], absoluteFrame);
    }
    expectedFrame_ = blockStartFrame + frames;
    return true;
}

StereoFrame RhythmicFxProcessor::processSample(StereoFrame input,
                                               std::uint64_t absoluteFrame) noexcept {
    input = {bounded(input.left), bounded(input.right)};
    advanceSmoothers();
    StereoFrame processed = input;
    if (kind_ == RhythmicFxKind::Isolator) {
        processed = processIsolator(input);
    } else {
        const double tick = tickAtFrame(absoluteFrame);
        float gate = 0.0f;
        if (kind_ == RhythmicFxKind::PatternSlicer) {
            gate = patternLevel(tick);
            processed = {input.left * gate, input.right * gate};
        } else {
            const auto* preset = rhythmicFxPattern(kind_, patternId_);
            if (!preset) return input;
            const float gain = shapedStepValue(stepGainCurrent_, tick);
            const float pan = shapedStepValue(stepPanCurrent_, tick);
            const float cutoff = std::clamp(shapedStepValue(stepCutoffAlphaCurrent_, tick),
                                            0.00001f, 0.99999f);
            lowFilterState_[0] += cutoff * (input.left - lowFilterState_[0]);
            lowFilterState_[1] += cutoff * (input.right - lowFilterState_[1]);
            processed = applyStereoPan({lowFilterState_[0] * gain,
                                        lowFilterState_[1] * gain}, pan);
        }
    }
    const float mix = activeGain_ * wetCurrent_;
    return {bounded(input.left + (processed.left - input.left) * mix),
            bounded(input.right + (processed.right - input.right) * mix)};
}

StereoFrame RhythmicFxProcessor::processIsolator(StereoFrame input) noexcept {
    float middleLeft = 0.0f;
    float highLeft = 0.0f;
    const float lowLeft = splitBandChannel(input.left, 0U, middleLeft, highLeft);
    float middleRight = 0.0f;
    float highRight = 0.0f;
    const float lowRight = splitBandChannel(input.right, 1U, middleRight, highRight);
    return {
        bounded(lowLeft * bandGainCurrent_[0] + middleLeft * bandGainCurrent_[1] +
                highLeft * bandGainCurrent_[2]),
        bounded(lowRight * bandGainCurrent_[0] + middleRight * bandGainCurrent_[1] +
                highRight * bandGainCurrent_[2]),
    };
}

float RhythmicFxProcessor::splitBandChannel(float input, std::uint32_t channel,
                                            float& middle, float& high) noexcept {
    auto& crossover = crossovers_[channel];
    float low = input;
    float aboveLow = input;
    for (std::uint32_t stage = 0; stage < 2U; ++stage) {
        low = crossover.lowerLow[stage].process(low);
        aboveLow = crossover.lowerHigh[stage].process(aboveLow);
    }
    float midRoute = aboveLow;
    float highRoute = aboveLow;
    float lowAllpassLow = low;
    float lowAllpassHigh = low;
    for (std::uint32_t stage = 0; stage < 2U; ++stage) {
        midRoute = crossover.upperLowRemainder[stage].process(midRoute);
        highRoute = crossover.upperHighRemainder[stage].process(highRoute);
        lowAllpassLow = crossover.upperLowLow[stage].process(lowAllpassLow);
        lowAllpassHigh = crossover.upperHighLow[stage].process(lowAllpassHigh);
    }
    middle = midRoute;
    high = highRoute;
    return bounded(lowAllpassLow + lowAllpassHigh);
}

float RhythmicFxProcessor::patternLevel(double tick) const noexcept {
    const auto* selected = rhythmicFxPattern(kind_, patternId_);
    if (!selected) return 1.0f;
    const float from = shapedStepValue(activePatternFrom_, tick);
    const float to = shapedStepValue(selected->levels, tick);
    const float blend = static_cast<float>(std::clamp(activePatternBlend_, 0.0, 1.0));
    return std::clamp(from + (to - from) * blend, 0.0f, 1.0f);
}

float RhythmicFxProcessor::shapedStepValue(const std::array<float, 16>& values,
                                           double tick) const noexcept {
    constexpr double ticksPerBar = static_cast<double>(kTicksPerQuarter * 4U);
    constexpr double ticksPerStep = ticksPerBar / static_cast<double>(kPatternSteps);
    if (!std::isfinite(tick) || tick < 0.0) return 1.0f;
    double barPhase = std::fmod(tick, ticksPerBar);
    if (barPhase < 0.0) barPhase += ticksPerBar;
    const double position = barPhase / ticksPerStep;
    const auto step = static_cast<std::uint32_t>(std::floor(position)) % kPatternSteps;
    const auto previous = (step + kPatternSteps - 1U) % kPatternSteps;
    const double phase = position - std::floor(position);
    const double samplesPerStep = (60.0 * static_cast<double>(spec_.sampleRate)) /
                                  (bpm_ * 4.0);
    const double edgeFraction = std::clamp((edgeMs_ * 0.001 * spec_.sampleRate) /
                                           samplesPerStep, 0.00001, 0.49);
    if (phase >= edgeFraction) return values[step];
    const double blend = smoothCurve(phase / edgeFraction);
    return static_cast<float>(static_cast<double>(values[previous]) +
        (static_cast<double>(values[step]) - values[previous]) * blend);
}

double RhythmicFxProcessor::tickAtFrame(std::uint64_t absoluteFrame) const noexcept {
    if (!hasClockOrigin_ || absoluteFrame < epochFrame_ ||
        absoluteFrame > kMaximumExactFrame) return std::numeric_limits<double>::quiet_NaN();
    const double elapsed = static_cast<double>(absoluteFrame - epochFrame_);
    return epochTicks_ + elapsed * ticksPerFrame_;
}

double RhythmicFxProcessor::smoothCurve(double value) noexcept {
    const double boundedValue = std::clamp(value, 0.0, 1.0);
    return 0.5 - 0.5 * std::cos(kPi * boundedValue);
}

StereoFrame RhythmicFxProcessor::applyStereoPan(StereoFrame input, float pan) noexcept {
    const double p = static_cast<double>(std::clamp(sanitize(pan), -1.0f, 1.0f));
    const double x = p <= 0.0 ? p + 1.0 : p;
    const double angle = x * kPi * 0.5;
    const float left = static_cast<float>(std::cos(angle));
    const float right = static_cast<float>(std::sin(angle));
    if (p <= 0.0) return {bounded(input.left + input.right * left),
                          bounded(input.right * right)};
    return {bounded(input.left * left), bounded(input.right + input.left * right)};
}

} // namespace webrc::dsp
