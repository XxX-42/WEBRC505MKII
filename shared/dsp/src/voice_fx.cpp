#include "webrc/dsp/voice_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <new>
#include <utility>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::uint64_t kMaximumExactFrame = 9007199254740992ULL;
constexpr float kDenormalThreshold = 1.0e-20f;

[[nodiscard]] float clean(float value) noexcept {
    return std::isfinite(value) && std::fabs(value) >= kDenormalThreshold ? value : 0.0f;
}

[[nodiscard]] bool inRange(float value, float low, float high) noexcept {
    return std::isfinite(value) && value >= low && value <= high;
}

[[nodiscard]] bool validSpec(const ProcessSpec& spec) noexcept {
    return validProcessSpec(spec) && spec.channels == 2U &&
           spec.sampleRate >= 24000.0f && spec.sampleRate <= 192000.0f &&
           spec.maxBlockFrames <= 8192U;
}

[[nodiscard]] double smoothingCoefficient(float milliseconds, float sampleRate) noexcept {
    const double seconds = std::max(0.001, static_cast<double>(milliseconds) * 0.001);
    return 1.0 - std::exp(-1.0 / (seconds * static_cast<double>(sampleRate)));
}

[[nodiscard]] float midiFrequency(double midi) noexcept {
    return static_cast<float>(440.0 * std::exp2((midi - 69.0) / 12.0));
}

[[nodiscard]] double midiForFrequency(float frequency) noexcept {
    return 69.0 + 12.0 * std::log2(static_cast<double>(frequency) / 440.0);
}

[[nodiscard]] int positiveModulo12(int value) noexcept {
    const int result = value % 12;
    return result < 0 ? result + 12 : result;
}

[[nodiscard]] float pitchClassRatio(const PitchEstimate& estimate,
                                    std::uint8_t noteClass) noexcept {
    if (!estimate.voiced || estimate.frequencyHz <= 0.0f) return 1.0f;
    const double midi = midiForFrequency(estimate.frequencyHz);
    const int first = static_cast<int>(std::floor(midi)) - 12;
    int targetMidi = first;
    double targetDistance = std::numeric_limits<double>::infinity();
    for (int candidate = first; candidate <= first + 36; ++candidate) {
        if (positiveModulo12(candidate) != static_cast<int>(noteClass)) continue;
        const double distance = std::fabs(static_cast<double>(candidate) - midi);
        if (distance < targetDistance) {
            targetDistance = distance;
            targetMidi = candidate;
        }
    }
    return std::clamp(static_cast<float>(std::exp2(
        (static_cast<double>(targetMidi) - midi) / 12.0)), 0.5f, 2.0f);
}

[[nodiscard]] float majorScaleRatio(const PitchEstimate& estimate,
                                    std::uint8_t root) noexcept {
    if (!estimate.voiced || estimate.frequencyHz <= 0.0f) return 1.0f;
    constexpr std::array<int, 7U> majorOffsets{{0, 2, 4, 5, 7, 9, 11}};
    const double midi = midiForFrequency(estimate.frequencyHz);
    const int first = static_cast<int>(std::floor(midi)) - 12;
    int targetMidi = first;
    double bestDistance = std::numeric_limits<double>::infinity();
    for (int candidate = first; candidate <= first + 36; ++candidate) {
        const int pitchClass = positiveModulo12(candidate);
        bool allowed = false;
        for (const int offset : majorOffsets)
            allowed = allowed || pitchClass == positiveModulo12(static_cast<int>(root) + offset);
        const double distance = std::fabs(static_cast<double>(candidate) - midi);
        if (allowed && distance < bestDistance) {
            bestDistance = distance;
            targetMidi = candidate;
        }
    }
    return static_cast<float>(std::exp2(
        (static_cast<double>(targetMidi) - midi) / 12.0));
}

[[nodiscard]] bool prepareFormantBank(std::array<std::array<BiquadDf2T, 3U>, 2U>& filters,
                                      const ProcessSpec& spec, float formant,
                                      float smoothingMs, bool electric) noexcept {
    const std::array<float, 3U> centers = electric
        ? std::array<float, 3U>{{380.0f, 1450.0f, 3200.0f}}
        : std::array<float, 3U>{{500.0f, 1500.0f, 3000.0f}};
    const std::array<float, 3U> qs{{1.1f, 1.0f, 0.85f}};
    const std::array<float, 3U> gains = electric
        ? std::array<float, 3U>{{4.0f, -2.5f, 4.5f}}
        : std::array<float, 3U>{{2.5f, -1.0f, 2.0f}};
    const float ratio = static_cast<float>(std::exp2(static_cast<double>(formant) / 50.0));
    for (auto& channel : filters) {
        for (std::size_t band = 0U; band < channel.size(); ++band) {
            if (!channel[band].prepare(spec) ||
                !channel[band].setPeaking(std::clamp(centers[band] * ratio, 25.0f,
                    0.45f * spec.sampleRate), qs[band], gains[band], smoothingMs)) return false;
        }
    }
    return true;
}

[[nodiscard]] bool updateFormantBank(
    std::array<std::array<BiquadDf2T, 3U>, 2U>& filters,
    const ProcessSpec& spec, float formant, float smoothingMs, bool electric) noexcept {
    const std::array<float, 3U> centers = electric
        ? std::array<float, 3U>{{380.0f, 1450.0f, 3200.0f}}
        : std::array<float, 3U>{{500.0f, 1500.0f, 3000.0f}};
    const std::array<float, 3U> qs{{1.1f, 1.0f, 0.85f}};
    const std::array<float, 3U> gains = electric
        ? std::array<float, 3U>{{4.0f, -2.5f, 4.5f}}
        : std::array<float, 3U>{{2.5f, -1.0f, 2.0f}};
    const float ratio = static_cast<float>(std::exp2(static_cast<double>(formant) / 50.0));
    for (auto& channel : filters)
        for (std::size_t band = 0U; band < channel.size(); ++band)
            if (!channel[band].setPeaking(std::clamp(centers[band] * ratio, 25.0f,
                    0.45f * spec.sampleRate), qs[band], gains[band], smoothingMs)) return false;
    return true;
}

[[nodiscard]] float processFormantBank(
    std::array<std::array<BiquadDf2T, 3U>, 2U>& filters,
    std::size_t channel, float sample) noexcept {
    float result = sample;
    for (auto& filter : filters[channel]) result = filter.processSample(result);
    return clean(result);
}

[[nodiscard]] float electricScaleRatio(const PitchEstimate& estimate,
                                       std::int8_t scaleRoot) noexcept {
    if (!estimate.voiced || estimate.frequencyHz <= 0.0f) return 1.0f;
    if (scaleRoot < 0) {
        const double midi = midiForFrequency(estimate.frequencyHz);
        return static_cast<float>(std::exp2((std::round(midi) - midi) / 12.0));
    }
    return majorScaleRatio(estimate, static_cast<std::uint8_t>(scaleRoot));
}

[[nodiscard]] float crushSample(float sample) noexcept {
    constexpr float step = 1.0f / 128.0f;
    return clean(std::round(sample / step) * step);
}

} // namespace

std::size_t YinPsolaStereoPath::requiredPrepareBytes(const ProcessSpec& spec) noexcept {
    if (!validSpec(spec)) return 0U;
    const ProcessSpec detectorSpec{spec.sampleRate, spec.maxBlockFrames, 1U};
    const auto detectorBytes = IncrementalYinDetector::requiredPrepareBytes(
        detectorSpec, kAnalysisWindowFrames, kMinimumFrequencyHz, kMaximumFrequencyHz,
        kAnalysisWorkUnitsPerChannelPerCallback);
    const auto maxPeriod = static_cast<std::uint32_t>(std::ceil(
        static_cast<double>(spec.sampleRate) / kMinimumFrequencyHz));
    const auto shifterBytes = StreamingTdPsolaPitchShifter::requiredPrepareBytes(spec, maxPeriod);
    if (detectorBytes == 0U || shifterBytes == 0U) return 0U;
    if (shifterBytes < sizeof(StreamingTdPsolaPitchShifter)) return 0U;
    const auto detectorDynamicBytes = detectorBytes > sizeof(IncrementalYinDetector)
        ? detectorBytes - sizeof(IncrementalYinDetector) : 0U;
    // Peak for a fresh staged setup: the live path object, both heap-staged
    // detector/shifter objects, and their prepared scratch. A graph replacing
    // an already prepared path must reserve old preparedBytes() plus this value
    // until the inactive candidate is swapped in.
    const std::uint64_t bytes = sizeof(YinPsolaStereoPath) +
        2ULL * (sizeof(IncrementalYinDetector) + sizeof(StreamingTdPsolaPitchShifter)) +
        2ULL * static_cast<std::uint64_t>(detectorDynamicBytes) +
        2ULL * static_cast<std::uint64_t>(
            shifterBytes - sizeof(StreamingTdPsolaPitchShifter));
    return bytes > std::numeric_limits<std::size_t>::max()
        ? 0U : static_cast<std::size_t>(bytes);
}

bool YinPsolaStereoPath::prepare(const ProcessSpec& spec) {
    const auto required = requiredPrepareBytes(spec);
    if (required == 0U) return false;
    const ProcessSpec detectorSpec{spec.sampleRate, spec.maxBlockFrames, 1U};
    const auto maxPeriod = static_cast<std::uint32_t>(std::ceil(
        static_cast<double>(spec.sampleRate) / kMinimumFrequencyHz));
    using DetectorPair = std::array<IncrementalYinDetector, 2U>;
    using ShifterPair = std::array<StreamingTdPsolaPitchShifter, 2U>;
    std::unique_ptr<DetectorPair> candidateDetectors(
        new (std::nothrow) DetectorPair{});
    std::unique_ptr<ShifterPair> candidateShifters(
        new (std::nothrow) ShifterPair{});
    if (!candidateDetectors || !candidateShifters) return false;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        if (!(*candidateDetectors)[channel].prepare(detectorSpec, kAnalysisWindowFrames,
                kMinimumFrequencyHz, kMaximumFrequencyHz, 0.15f, kAnalysisHopFrames,
                kAnalysisWorkUnitsPerChannelPerCallback) ||
            !(*candidateShifters)[channel].prepare(spec, maxPeriod)) return false;
    }
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif
    detectors_ = std::move(*candidateDetectors);
    shifters_ = std::move(*candidateShifters);
    spec_ = spec;
    detectorSpec_ = detectorSpec;
    preparedBytes_ = required;
    prepared_ = true;
    reset();
    return true;
}

void YinPsolaStereoPath::reset() noexcept {
    if (!prepared_) return;
    for (auto& detector : detectors_) detector.reset();
    for (auto& shifter : shifters_) shifter.reset();
    estimates_.fill({});
    pendingEstimates_.fill({});
    detectorCountsSeen_.fill(0U);
    activeWindowEndFrames_.fill(0U);
    pendingWindowEndFrames_.fill(0U);
    activeProcessingLagFrames_.fill(0U);
    pendingProcessingLagFrames_.fill(0U);
    activeEstimateAgeFrames_.fill(0U);
    lastWorkUnits_.fill(0U);
    pendingAvailable_.fill(false);
    totalInputFrames_ = 0U;
}

bool YinPsolaStereoPath::processAnalysisBlock(const StereoFrame* input,
                                             std::uint32_t frames) noexcept {
    if (!prepared_ || input == nullptr || frames == 0U || frames > spec_.maxBlockFrames ||
        frames > kMaximumBlockFrames) return false;
    bool promoted = false;
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        if (pendingAvailable_[channel]) {
            estimates_[channel] = pendingEstimates_[channel];
            activeWindowEndFrames_[channel] = pendingWindowEndFrames_[channel];
            activeProcessingLagFrames_[channel] = pendingProcessingLagFrames_[channel];
            pendingAvailable_[channel] = false;
            promoted = true;
        }
    }

    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        for (std::uint32_t frame = 0U; frame < frames; ++frame)
            monoScratch_[frame] = channel == 0U ? clean(input[frame].left)
                                                 : clean(input[frame].right);
        if (!detectors_[channel].processBlock(monoScratch_.data(), frames)) return false;
        lastWorkUnits_[channel] = detectors_[channel].lastWorkUnits();
        const auto count = detectors_[channel].analysisCount();
        if (count != detectorCountsSeen_[channel]) {
            detectorCountsSeen_[channel] = count;
            pendingEstimates_[channel] = detectors_[channel].latestEstimate();
            pendingWindowEndFrames_[channel] = detectors_[channel].latestWindowEndFrame();
            pendingProcessingLagFrames_[channel] =
                detectors_[channel].latestProcessingLagFrames();
            pendingAvailable_[channel] = true;
        }
    }
    totalInputFrames_ += frames;
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        const auto age = totalInputFrames_ >= activeWindowEndFrames_[channel]
            ? totalInputFrames_ - activeWindowEndFrames_[channel] : 0U;
        activeEstimateAgeFrames_[channel] = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(age, std::numeric_limits<std::uint32_t>::max()));
    }
    return promoted;
}

PitchEstimate YinPsolaStereoPath::estimate(std::uint32_t channel) const noexcept {
    return channel < estimates_.size() ? estimates_[channel] : PitchEstimate{};
}

std::uint32_t YinPsolaStereoPath::estimateAgeFrames(std::uint32_t channel) const noexcept {
    return channel < activeEstimateAgeFrames_.size() ? activeEstimateAgeFrames_[channel] : 0U;
}

std::uint32_t YinPsolaStereoPath::estimateProcessingLagFrames(
    std::uint32_t channel) const noexcept {
    return channel < activeProcessingLagFrames_.size()
        ? activeProcessingLagFrames_[channel] : 0U;
}

std::uint32_t YinPsolaStereoPath::lastAnalysisWorkUnits(std::uint32_t channel) const noexcept {
    return channel < lastWorkUnits_.size() ? lastWorkUnits_[channel] : 0U;
}

std::uint64_t YinPsolaStereoPath::analysisCount(std::uint32_t channel) const noexcept {
    return channel < detectors_.size() ? detectors_[channel].analysisCount() : 0U;
}

bool YinPsolaStereoPath::setPitchTargets(float leftRatio, float rightRatio,
                                         float confidenceThreshold) noexcept {
    if (!prepared_ || !inRange(leftRatio, 0.5f, 2.0f) ||
        !inRange(rightRatio, 0.5f, 2.0f) ||
        !inRange(confidenceThreshold, 0.0f, 1.0f)) return false;
    std::array<float, 2U> ratios{{leftRatio, rightRatio}};
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        auto candidate = estimates_[channel];
        if (candidate.confidence < confidenceThreshold) candidate.voiced = false;
        if (!shifters_[channel].setPitchEstimate(candidate, ratios[channel])) return false;
    }
    return true;
}

StereoFrame YinPsolaStereoPath::processSample(StereoFrame input) noexcept {
    if (!prepared_) return {};
    const float leftInput = clean(input.left);
    const float rightInput = clean(input.right);
    float leftOutput = 0.0f;
    float rightOutput = 0.0f;
    (void)shifters_[0U].processBlock(&leftInput, &leftOutput, 1U);
    (void)shifters_[1U].processBlock(&rightInput, &rightOutput, 1U);
    return {clean(leftOutput), clean(rightOutput)};
}

VoiceFxLatency YinPsolaStereoPath::latency() const noexcept {
    if (!prepared_) return {};
    const auto psola = shifters_[0U].latencySamples();
    constexpr std::uint32_t fftFrames = 4096U;
    constexpr std::uint32_t maximumLag = (192000U + 64U) / 65U;
    constexpr std::uint32_t maximumFftWork = (fftFrames / 2U) * 12U;
    constexpr std::uint32_t maximumWorkUnits = kAnalysisWindowFrames + 5U * fftFrames +
        2U * maximumFftWork + 3U * maximumLag;
    const std::uint64_t analysisCallbacks =
        (static_cast<std::uint64_t>(maximumWorkUnits) +
         kAnalysisWorkUnitsPerChannelPerCallback - 1U) /
        kAnalysisWorkUnitsPerChannelPerCallback;
    const std::uint64_t conservativeOnset = kAnalysisWindowFrames +
        (analysisCallbacks + 1U) * spec_.maxBlockFrames + psola;
    VoiceFxLatency result{};
    result.psolaLookaheadSamples = psola;
    result.analysisWindowFrames = kAnalysisWindowFrames;
    result.analysisHopFrames = kAnalysisHopFrames;
    result.conservativePitchOnsetFrames = static_cast<std::uint32_t>(
        std::min<std::uint64_t>(conservativeOnset, std::numeric_limits<std::uint32_t>::max()));
    result.workUnitsPerChannelPerCallback = kAnalysisWorkUnitsPerChannelPerCallback;
    result.analysisCold = detectors_[0U].analysisCount() == 0U ||
                          detectors_[1U].analysisCount() == 0U;
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        result.activeEstimateAgeFrames[channel] = activeEstimateAgeFrames_[channel];
        result.activeEstimateProcessingLagFrames[channel] = activeProcessingLagFrames_[channel];
        result.lastAnalysisWorkUnits[channel] = lastWorkUnits_[channel];
        result.analysisCounts[channel] = detectors_[channel].analysisCount();
    }
    return result;
}

std::size_t RobotFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const RobotFxOptions& options) noexcept {
    if (!validSpec(spec) || options.noteClass > 11U ||
        (options.mode != RobotFxMode::PitchClass && options.mode != RobotFxMode::MajorScale) ||
        !inRange(options.formant, -50.0f, 50.0f) || !inRange(options.mix, 0.0f, 1.0f) ||
        !inRange(options.controlSmoothingMs, 1.0f, 100.0f)) return 0U;
    const auto pathBytes = YinPsolaStereoPath::requiredPrepareBytes(spec);
    if (pathBytes < sizeof(YinPsolaStereoPath)) return 0U;
    // Include the heap-staged path object and its temporary detector/shifter
    // pairs in addition to the live processor object. Graph replacement must
    // add the old prepared instance's reservation until its swap completes.
    const std::uint64_t bytes = sizeof(RobotFxProcessor) + pathBytes;
    return bytes > std::numeric_limits<std::size_t>::max()
        ? 0U : static_cast<std::size_t>(bytes);
}

bool RobotFxProcessor::prepare(const ProcessSpec& spec, const RobotFxOptions& options) {
    const auto required = requiredPrepareBytes(spec, options);
    if (required == 0U) return false;
    std::unique_ptr<YinPsolaStereoPath> candidatePath(
        new (std::nothrow) YinPsolaStereoPath{});
    if (!candidatePath || !candidatePath->prepare(spec)) return false;
    auto candidateFilters = std::array<std::array<BiquadDf2T, 3U>, 2U>{};
    if (!prepareFormantBank(candidateFilters, spec, options.formant,
                            options.controlSmoothingMs, false)) return false;
    pitchPath_ = std::move(*candidatePath);
    formantFilters_ = std::move(candidateFilters);
    spec_ = spec;
    options_ = options;
    preparedBytes_ = required;
    smoothingCoefficient_ = smoothingCoefficient(options.controlSmoothingMs, spec.sampleRate);
    activeTarget_ = activeCurrent_ = 0.0f;
    mixTarget_ = mixCurrent_ = options.mix;
    formantCurrent_ = options.formant;
    hasExpectedFrame_ = false;
    prepared_ = true;
    updatePitchTargets();
    return true;
}

void RobotFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    pitchPath_.reset();
    for (auto& channel : formantFilters_) for (auto& filter : channel) filter.reset();
    expectedFrame_ = std::min(absoluteFrame, kMaximumExactFrame);
    hasExpectedFrame_ = true;
    activeCurrent_ = activeTarget_;
    mixCurrent_ = mixTarget_;
    updateFormantTargets(formantCurrent_);
}

bool RobotFxProcessor::validateEvent(const RobotFxEvent& event) const noexcept {
    switch (event.control) {
    case RobotFxControl::Active:
    case RobotFxControl::Mix: return inRange(event.value, 0.0f, 1.0f);
    case RobotFxControl::NoteClass:
        return inRange(event.value, 0.0f, 11.0f) && std::floor(event.value) == event.value;
    case RobotFxControl::Mode:
        return event.value == 1.0f || event.value == 2.0f;
    case RobotFxControl::Formant: return inRange(event.value, -50.0f, 50.0f);
    }
    return false;
}

bool RobotFxProcessor::validateEvents(std::uint32_t frames, const RobotFxEvent* events,
                                      std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    std::uint32_t previous = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames || (i != 0U && events[i].frameOffset < previous) ||
            !validateEvent(events[i])) return false;
        previous = events[i].frameOffset;
    }
    return true;
}

void RobotFxProcessor::updatePitchTargets() noexcept {
    const auto left = pitchPath_.estimate(0U);
    const auto right = pitchPath_.estimate(1U);
    const auto targetRatio = [&](const PitchEstimate& estimate) noexcept {
        return options_.mode == RobotFxMode::PitchClass
            ? pitchClassRatio(estimate, options_.noteClass)
            : majorScaleRatio(estimate, options_.noteClass);
    };
    (void)pitchPath_.setPitchTargets(targetRatio(left), targetRatio(right), 0.65f);
}

void RobotFxProcessor::updateFormantTargets(float formant) noexcept {
    (void)updateFormantBank(formantFilters_, spec_, formant,
                            options_.controlSmoothingMs, false);
}

void RobotFxProcessor::applyEvent(const RobotFxEvent& event) noexcept {
    switch (event.control) {
    case RobotFxControl::Active: activeTarget_ = event.value; break;
    case RobotFxControl::Mix: mixTarget_ = event.value; break;
    case RobotFxControl::NoteClass:
        options_.noteClass = static_cast<std::uint8_t>(event.value);
        updatePitchTargets();
        break;
    case RobotFxControl::Mode:
        options_.mode = static_cast<RobotFxMode>(static_cast<std::uint8_t>(event.value));
        updatePitchTargets();
        break;
    case RobotFxControl::Formant:
        formantCurrent_ = event.value;
        options_.formant = event.value;
        updateFormantTargets(event.value);
        break;
    }
}

bool RobotFxProcessor::processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                                    std::uint32_t frames, const RobotFxEvent* events,
                                    std::uint32_t eventCount) noexcept {
    if (!prepared_ || (frames != 0U && interleaved == nullptr) || frames > spec_.maxBlockFrames ||
        blockStartFrame > kMaximumExactFrame || frames > kMaximumExactFrame - blockStartFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;
    if (pitchPath_.processAnalysisBlock(interleaved, frames)) updatePitchTargets();
    std::uint32_t eventIndex = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame)
            applyEvent(events[eventIndex++]);
        const auto dry = interleaved[frame];
        const auto pitch = pitchPath_.processSample(dry);
        const float wetLeft = processFormantBank(formantFilters_, 0U, pitch.left);
        const float wetRight = processFormantBank(formantFilters_, 1U, pitch.right);
        activeCurrent_ += static_cast<float>(smoothingCoefficient_) * (activeTarget_ - activeCurrent_);
        mixCurrent_ += static_cast<float>(smoothingCoefficient_) * (mixTarget_ - mixCurrent_);
        const float amount = std::clamp(clean(activeCurrent_ * mixCurrent_), 0.0f, 1.0f);
        interleaved[frame] = {clean(dry.left + amount * (wetLeft - dry.left)),
                              clean(dry.right + amount * (wetRight - dry.right))};
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

std::size_t ElectricFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const ElectricFxOptions& options) noexcept {
    if (!validSpec(spec) || !inRange(options.shiftSemitones, -12.0f, 12.0f) ||
        !inRange(options.formant, -50.0f, 50.0f) || !inRange(options.speed, 0.0f, 10.0f) ||
        !inRange(options.stability, -10.0f, 10.0f) ||
        !(options.scaleRoot == -1 || (options.scaleRoot >= 0 && options.scaleRoot <= 11)) ||
        !inRange(options.mix, 0.0f, 1.0f) ||
        !inRange(options.controlSmoothingMs, 1.0f, 100.0f) ||
        !inRange(options.metallicMix, 0.0f, 1.0f) ||
        !inRange(options.bitCrushMix, 0.0f, 1.0f) ||
        options.metallicMix + options.bitCrushMix > 1.0f) return 0U;
    const auto pathBytes = YinPsolaStereoPath::requiredPrepareBytes(spec);
    if (pathBytes < sizeof(YinPsolaStereoPath)) return 0U;
    const std::uint64_t bytes = sizeof(ElectricFxProcessor) + pathBytes;
    return bytes > std::numeric_limits<std::size_t>::max()
        ? 0U : static_cast<std::size_t>(bytes);
}

bool ElectricFxProcessor::prepare(const ProcessSpec& spec, const ElectricFxOptions& options) {
    const auto required = requiredPrepareBytes(spec, options);
    if (required == 0U) return false;
    std::unique_ptr<YinPsolaStereoPath> candidatePath(
        new (std::nothrow) YinPsolaStereoPath{});
    if (!candidatePath || !candidatePath->prepare(spec)) return false;
    auto candidateFilters = std::array<std::array<BiquadDf2T, 3U>, 2U>{};
    if (!prepareFormantBank(candidateFilters, spec, options.formant,
                            options.controlSmoothingMs, true)) return false;
    std::array<PolyBlepOscillator, 2U> candidateCarriers{};
    for (std::size_t channel = 0U; channel < candidateCarriers.size(); ++channel) {
        if (!candidateCarriers[channel].prepare(spec) ||
            !candidateCarriers[channel].setFrequency(channel == 0U ? 337.0f : 379.0f)) return false;
        candidateCarriers[channel].setWaveform(OscillatorWaveform::Sine);
        candidateCarriers[channel].reset(channel == 0U ? 0.07f : 0.31f);
    }
    pitchPath_ = std::move(*candidatePath);
    formantFilters_ = std::move(candidateFilters);
    ringCarriers_ = std::move(candidateCarriers);
    spec_ = spec;
    options_ = options;
    preparedBytes_ = required;
    smoothingCoefficient_ = smoothingCoefficient(options.controlSmoothingMs, spec.sampleRate);
    activeTarget_ = activeCurrent_ = 0.0f;
    mixTarget_ = mixCurrent_ = options.mix;
    shiftCurrent_ = options.shiftSemitones;
    speedCurrent_ = options.speed;
    stabilityCurrent_ = options.stability;
    formantCurrent_ = options.formant;
    heldSamples_.fill(0.0f);
    holdCountdown_.fill(0U);
    hasExpectedFrame_ = false;
    prepared_ = true;
    updatePitchTargets();
    return true;
}

void ElectricFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    pitchPath_.reset();
    for (auto& channel : formantFilters_) for (auto& filter : channel) filter.reset();
    for (std::size_t channel = 0U; channel < ringCarriers_.size(); ++channel)
        ringCarriers_[channel].reset(channel == 0U ? 0.07f : 0.31f);
    heldSamples_.fill(0.0f);
    holdCountdown_.fill(0U);
    expectedFrame_ = std::min(absoluteFrame, kMaximumExactFrame);
    hasExpectedFrame_ = true;
    activeCurrent_ = activeTarget_;
    mixCurrent_ = mixTarget_;
    shiftCurrent_ = options_.shiftSemitones;
    speedCurrent_ = options_.speed;
    stabilityCurrent_ = options_.stability;
    updateFormantTargets(formantCurrent_);
}

bool ElectricFxProcessor::validateEvent(const ElectricFxEvent& event) const noexcept {
    switch (event.control) {
    case ElectricFxControl::Active:
    case ElectricFxControl::Mix: return inRange(event.value, 0.0f, 1.0f);
    case ElectricFxControl::ShiftSemitones: return inRange(event.value, -12.0f, 12.0f);
    case ElectricFxControl::Formant: return inRange(event.value, -50.0f, 50.0f);
    case ElectricFxControl::Speed: return inRange(event.value, 0.0f, 10.0f);
    case ElectricFxControl::Stability: return inRange(event.value, -10.0f, 10.0f);
    case ElectricFxControl::ScaleRoot:
        return event.value == -1.0f || (inRange(event.value, 0.0f, 11.0f) &&
                                        std::floor(event.value) == event.value);
    }
    return false;
}

bool ElectricFxProcessor::validateEvents(std::uint32_t frames, const ElectricFxEvent* events,
                                         std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    std::uint32_t previous = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames || (i != 0U && events[i].frameOffset < previous) ||
            !validateEvent(events[i])) return false;
        previous = events[i].frameOffset;
    }
    return true;
}

void ElectricFxProcessor::updatePitchTargets() noexcept {
    const auto left = pitchPath_.estimate(0U);
    const auto right = pitchPath_.estimate(1U);
    const float leftBase = electricScaleRatio(left, options_.scaleRoot);
    const float rightBase = electricScaleRatio(right, options_.scaleRoot);
    const float shiftRatio = static_cast<float>(std::exp2(
        static_cast<double>(shiftCurrent_) / 12.0));
    const float leftRatio = std::clamp(leftBase * shiftRatio, 0.5f, 2.0f);
    const float rightRatio = std::clamp(rightBase * shiftRatio, 0.5f, 2.0f);
    const float threshold = std::clamp(0.65f + (stabilityCurrent_ + 10.0f) * 0.017f,
                                      0.65f, 0.99f);
    (void)pitchPath_.setPitchTargets(leftRatio, rightRatio, threshold);
}

void ElectricFxProcessor::updateFormantTargets(float formant) noexcept {
    (void)updateFormantBank(formantFilters_, spec_, formant,
                            options_.controlSmoothingMs, true);
}

float ElectricFxProcessor::processFormant(std::size_t channel, float input) noexcept {
    return processFormantBank(formantFilters_, channel, input);
}

void ElectricFxProcessor::applyEvent(const ElectricFxEvent& event) noexcept {
    switch (event.control) {
    case ElectricFxControl::Active: activeTarget_ = event.value; break;
    case ElectricFxControl::Mix: mixTarget_ = event.value; break;
    case ElectricFxControl::ShiftSemitones:
        options_.shiftSemitones = event.value;
        break;
    case ElectricFxControl::Formant:
        formantCurrent_ = options_.formant = event.value;
        updateFormantTargets(event.value);
        break;
    case ElectricFxControl::Speed: options_.speed = event.value; break;
    case ElectricFxControl::Stability: options_.stability = event.value; break;
    case ElectricFxControl::ScaleRoot:
        options_.scaleRoot = static_cast<std::int8_t>(event.value);
        break;
    }
}

bool ElectricFxProcessor::processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                                       std::uint32_t frames, const ElectricFxEvent* events,
                                       std::uint32_t eventCount) noexcept {
    if (!prepared_ || (frames != 0U && interleaved == nullptr) || frames > spec_.maxBlockFrames ||
        blockStartFrame > kMaximumExactFrame || frames > kMaximumExactFrame - blockStartFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;
    const bool newPitchEstimate = pitchPath_.processAnalysisBlock(interleaved, frames);
    if (newPitchEstimate) updatePitchTargets();
    std::uint32_t eventIndex = 0U;
    const float stabilitySmoothing = static_cast<float>(smoothingCoefficient_);
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame)
            applyEvent(events[eventIndex++]);
        const auto dry = interleaved[frame];
        speedCurrent_ += stabilitySmoothing * (options_.speed - speedCurrent_);
        stabilityCurrent_ += stabilitySmoothing * (options_.stability - stabilityCurrent_);
        const auto speedBucket = static_cast<std::uint8_t>(std::clamp(
            static_cast<int>(std::lround(speedCurrent_)), 0, 10));
        const double speedSeconds = 0.003 + (10.0 - speedBucket) * 0.0147;
        const float shiftSmoothing = static_cast<float>(1.0 - std::exp(
            -1.0 / (speedSeconds * spec_.sampleRate)));
        shiftCurrent_ += shiftSmoothing * (options_.shiftSemitones - shiftCurrent_);
        if (std::fabs(shiftCurrent_ - options_.shiftSemitones) < 1.0e-4f)
            shiftCurrent_ = options_.shiftSemitones;
        if (std::fabs(speedCurrent_ - options_.speed) < 1.0e-4f)
            speedCurrent_ = options_.speed;
        if (std::fabs(stabilityCurrent_ - options_.stability) < 1.0e-4f)
            stabilityCurrent_ = options_.stability;
        const auto pitch = pitchPath_.processSample(dry);
        const float leftFormant = processFormant(0U, pitch.left);
        const float rightFormant = processFormant(1U, pitch.right);
        const float leftRing = leftFormant * ringCarriers_[0U].next();
        const float rightRing = rightFormant * ringCarriers_[1U].next();
        const auto holdPeriod = static_cast<std::uint32_t>(2U + std::lround(
            speedCurrent_ * 3.0f));
        for (std::size_t channel = 0U; channel < 2U; ++channel) {
            if (holdCountdown_[channel] == 0U) {
                heldSamples_[channel] = crushSample(channel == 0U ? leftFormant : rightFormant);
                holdCountdown_[channel] = holdPeriod - 1U;
            } else {
                --holdCountdown_[channel];
            }
        }
        const float pitchWeight = 1.0f - options_.metallicMix - options_.bitCrushMix;
        const float leftCharacter = pitchWeight * leftFormant +
            options_.metallicMix * leftRing + options_.bitCrushMix * heldSamples_[0U];
        const float rightCharacter = pitchWeight * rightFormant +
            options_.metallicMix * rightRing + options_.bitCrushMix * heldSamples_[1U];
        activeCurrent_ += static_cast<float>(smoothingCoefficient_) *
                          (activeTarget_ - activeCurrent_);
        mixCurrent_ += static_cast<float>(smoothingCoefficient_) * (mixTarget_ - mixCurrent_);
        const float amount = std::clamp(clean(activeCurrent_ * mixCurrent_), 0.0f, 1.0f);
        interleaved[frame] = {clean(dry.left + amount * (leftCharacter - dry.left)),
                              clean(dry.right + amount * (rightCharacter - dry.right))};
    }
    // PSOLA accepts one new ratio target per block. This follows smoothed
    // shift/speed/stability controls without resetting its ramp at every sample.
    updatePitchTargets();
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

namespace {

constexpr std::uint32_t kOscBotVoiceFadeSamples = 64U;
constexpr float kOscBotIdleThreshold = 1.0e-5f;
constexpr std::array<std::array<std::int8_t, 8U>, OscBotFxProcessor::kPatternCount>
    kOscBotPatterns{{
        {{0, 7, 12, 7, 4, 7, 12, 7}},
        {{0, 4, 7, 11, 7, 4, 2, 4}},
        {{0, 5, 7, 12, 5, 7, 10, 7}},
        {{0, 3, 7, 10, 12, 10, 7, 3}},
    }};

[[nodiscard]] OscillatorWaveform botPrimitiveWaveform(OscBotWaveform waveform) noexcept {
    switch (waveform) {
    case OscBotWaveform::Saw:
    case OscBotWaveform::VintageSaw:
    case OscBotWaveform::DetuneSaw: return OscillatorWaveform::Saw;
    case OscBotWaveform::Square: return OscillatorWaveform::Square;
    case OscBotWaveform::Rect: return OscillatorWaveform::Saw;
    }
    return OscillatorWaveform::Sine;
}

[[nodiscard]] OscillatorWaveform botRectangularOffsetWaveform(OscBotWaveform waveform) noexcept {
    return waveform == OscBotWaveform::Rect
        ? OscillatorWaveform::Saw : OscillatorWaveform::Square;
}

[[nodiscard]] float botRenderWave(PolyBlepOscillator& main,
                                  PolyBlepOscillator& rectOffset,
                                  PolyBlepOscillator& vintageFundamental,
                                  OscBotWaveform waveform) noexcept {
    const float primary = main.next();
    const float shifted = rectOffset.next();
    const float vintage = vintageFundamental.next();
    switch (waveform) {
    case OscBotWaveform::VintageSaw: return 0.8f * primary + 0.2f * vintage;
    case OscBotWaveform::Rect: return 0.5f * (primary - shifted);
    case OscBotWaveform::Saw:
    case OscBotWaveform::DetuneSaw:
    case OscBotWaveform::Square: return primary;
    }
    return 0.0f;
}

[[nodiscard]] float oscillatorFrequency(std::uint8_t note, float cents) noexcept {
    return static_cast<float>(440.0 * std::exp2(
        (static_cast<double>(note) - 69.0 + static_cast<double>(cents) / 100.0) / 12.0));
}

} // namespace

bool OscBotFxProcessor::validWaveform(OscBotWaveform waveform) noexcept {
    return static_cast<std::uint8_t>(waveform) <=
           static_cast<std::uint8_t>(OscBotWaveform::Rect);
}

std::size_t OscBotFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const OscBotFxOptions& options) noexcept {
    if (!validSpec(spec) || !validWaveform(options.waveform) ||
        !inRange(options.tone, -50.0f, 50.0f) || !inRange(options.attack, 0.0f, 100.0f) ||
        options.note < 24U || options.note > 127U ||
        !inRange(options.modulationSensitivity, -50.0f, 50.0f) ||
        !inRange(options.balance, 0.0f, 1.0f) || !inRange(options.mix, 0.0f, 1.0f) ||
        options.pattern >= kPatternCount ||
        !inRange(options.stepRateHz, 0.25f, 16.0f) ||
        !inRange(options.controlSmoothingMs, 1.0f, 100.0f)) return 0U;
    return sizeof(OscBotFxProcessor);
}

bool OscBotFxProcessor::prepare(const ProcessSpec& spec, const OscBotFxOptions& options) {
    const auto required = requiredPrepareBytes(spec, options);
    if (required == 0U) return false;
    auto candidateVoices = std::array<Voice, kVoiceCount>{};
    auto candidateRetired = std::array<Retired, 16U>{};
    const float baseFrequency = oscillatorFrequency(options.note, 0.0f);
    for (auto& voice : candidateVoices) {
        if (!voice.left.prepare(spec) || !voice.right.prepare(spec) ||
            !voice.vintageLeft.prepare(spec) || !voice.vintageRight.prepare(spec) ||
            !voice.rectLeft.prepare(spec) || !voice.rectRight.prepare(spec) ||
            !voice.left.setFrequency(baseFrequency) || !voice.right.setFrequency(baseFrequency) ||
            !voice.vintageLeft.setFrequency(baseFrequency) ||
            !voice.vintageRight.setFrequency(baseFrequency) ||
            !voice.rectLeft.setFrequency(baseFrequency) || !voice.rectRight.setFrequency(baseFrequency))
            return false;
        voice.left.setWaveform(botPrimitiveWaveform(options.waveform));
        voice.right.setWaveform(botPrimitiveWaveform(options.waveform));
        voice.vintageLeft.setWaveform(OscillatorWaveform::Sine);
        voice.vintageRight.setWaveform(OscillatorWaveform::Sine);
        voice.rectLeft.setWaveform(botRectangularOffsetWaveform(options.waveform));
        voice.rectRight.setWaveform(botRectangularOffsetWaveform(options.waveform));
        voice.rectLeft.reset(0.25f);
        voice.rectRight.reset(0.48f);
        voice.vintageLeft.reset(0.0f);
        voice.vintageRight.reset(0.23f);
        voice.previousLeft = voice.left;
        voice.previousRight = voice.right;
        voice.previousVintageLeft = voice.vintageLeft;
        voice.previousVintageRight = voice.vintageRight;
        voice.previousRectLeft = voice.rectLeft;
        voice.previousRectRight = voice.rectRight;
        voice.waveform = options.waveform;
        voice.previousWaveform = options.waveform;
    }
    for (auto& tail : candidateRetired) {
        if (!tail.left.prepare(spec) || !tail.right.prepare(spec) ||
            !tail.vintageLeft.prepare(spec) || !tail.vintageRight.prepare(spec) ||
            !tail.rectLeft.prepare(spec) || !tail.rectRight.prepare(spec) ||
            !tail.left.setFrequency(baseFrequency) || !tail.right.setFrequency(baseFrequency) ||
            !tail.vintageLeft.setFrequency(baseFrequency) ||
            !tail.vintageRight.setFrequency(baseFrequency) ||
            !tail.rectLeft.setFrequency(baseFrequency) || !tail.rectRight.setFrequency(baseFrequency))
            return false;
        tail.left.setWaveform(botPrimitiveWaveform(options.waveform));
        tail.right.setWaveform(botPrimitiveWaveform(options.waveform));
        tail.vintageLeft.setWaveform(OscillatorWaveform::Sine);
        tail.vintageRight.setWaveform(OscillatorWaveform::Sine);
        tail.rectLeft.setWaveform(botRectangularOffsetWaveform(options.waveform));
        tail.rectRight.setWaveform(botRectangularOffsetWaveform(options.waveform));
        tail.rectLeft.reset(0.25f);
        tail.rectRight.reset(0.48f);
        tail.vintageLeft.reset(0.0f);
        tail.vintageRight.reset(0.23f);
        tail.waveform = options.waveform;
    }
    auto candidateFilters = std::array<std::array<BiquadDf2T, 3U>, 2U>{};
    if (!prepareFormantBank(candidateFilters, spec, options.tone,
                            options.controlSmoothingMs, false)) return false;
    voices_ = std::move(candidateVoices);
    retired_ = std::move(candidateRetired);
    formantFilters_ = std::move(candidateFilters);
    spec_ = spec;
    options_ = options;
    preparedBytes_ = required;
    stepFrames_ = static_cast<std::uint32_t>(std::max(1.0, std::round(
        static_cast<double>(spec.sampleRate) / options.stepRateHz)));
    activeSmoothingCoefficient_ = smoothingCoefficient(options.controlSmoothingMs,
                                                        spec.sampleRate);
    const double attackSeconds = 0.001 + static_cast<double>(options.attack) * 0.00199;
    const double releaseSeconds = 0.03;
    envelopeAttackCoefficient_ = static_cast<float>(1.0 - std::exp(
        -1.0 / (attackSeconds * spec.sampleRate)));
    envelopeReleaseCoefficient_ = static_cast<float>(1.0 - std::exp(
        -1.0 / (releaseSeconds * spec.sampleRate)));
    activeTarget_ = activeCurrent_ = 0.0f;
    mixTarget_ = mixCurrent_ = options.mix;
    balanceTarget_ = balanceCurrent_ = options.balance;
    prepared_ = true;
    reset();
    return true;
}

void OscBotFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    for (auto& voice : voices_) {
        voice.note = options_.note;
        voice.velocity = voice.gain = voice.targetGain = 0.0f;
        voice.age = 0U;
        voice.active = false;
        voice.waveform = voice.previousWaveform = options_.waveform;
        voice.waveformFadeRemaining = 0U;
        voice.left.setWaveform(botPrimitiveWaveform(options_.waveform));
        voice.right.setWaveform(botPrimitiveWaveform(options_.waveform));
        voice.rectLeft.setWaveform(botRectangularOffsetWaveform(options_.waveform));
        voice.rectRight.setWaveform(botRectangularOffsetWaveform(options_.waveform));
        voice.vintageLeft.setWaveform(OscillatorWaveform::Sine);
        voice.vintageRight.setWaveform(OscillatorWaveform::Sine);
        voice.left.reset(0.0f);
        voice.right.reset(0.23f);
        voice.vintageLeft.reset(0.0f);
        voice.vintageRight.reset(0.23f);
        voice.rectLeft.reset(0.25f);
        voice.rectRight.reset(0.48f);
        voice.previousLeft = voice.left;
        voice.previousRight = voice.right;
        voice.previousVintageLeft = voice.vintageLeft;
        voice.previousVintageRight = voice.vintageRight;
        voice.previousRectLeft = voice.rectLeft;
        voice.previousRectRight = voice.rectRight;
    }
    for (auto& tail : retired_) {
        tail.gain = 0.0f;
        tail.remaining = 0U;
        tail.waveform = options_.waveform;
    }
    for (auto& channel : formantFilters_) for (auto& filter : channel) filter.reset();
    envelopeLeft_ = envelopeRight_ = 0.0f;
    noteAge_ = 0U;
    stepCount_ = 0U;
    nextStepFrame_ = std::min(absoluteFrame, kMaximumExactFrame);
    modulationUpdateCounter_ = 0U;
    expectedFrame_ = std::min(absoluteFrame, kMaximumExactFrame);
    activeCurrent_ = activeTarget_;
    mixCurrent_ = mixTarget_;
    balanceCurrent_ = balanceTarget_;
    hasExpectedFrame_ = true;
    (void)updateFormantBank(formantFilters_, spec_, options_.tone,
                            options_.controlSmoothingMs, false);
}

bool OscBotFxProcessor::validateEvent(const OscBotFxEvent& event) const noexcept {
    switch (event.control) {
    case OscBotControl::Active:
    case OscBotControl::Mix:
    case OscBotControl::Balance: return inRange(event.value, 0.0f, 1.0f);
    case OscBotControl::Waveform:
        return inRange(event.value, 0.0f, 4.0f) && std::floor(event.value) == event.value;
    case OscBotControl::Tone:
    case OscBotControl::ModSensitivity: return inRange(event.value, -50.0f, 50.0f);
    case OscBotControl::Attack: return inRange(event.value, 0.0f, 100.0f);
    case OscBotControl::Note:
        return inRange(event.value, 24.0f, 127.0f) && std::floor(event.value) == event.value;
    case OscBotControl::Pattern:
        return inRange(event.value, 0.0f, static_cast<float>(kPatternCount - 1U)) &&
               std::floor(event.value) == event.value;
    }
    return false;
}

bool OscBotFxProcessor::validateEvents(std::uint32_t frames, const OscBotFxEvent* events,
                                       std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    std::uint32_t previous = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames || (i != 0U && events[i].frameOffset < previous) ||
            !validateEvent(events[i])) return false;
        previous = events[i].frameOffset;
    }
    return true;
}

void OscBotFxProcessor::updateFormantTargets(float tone) noexcept {
    (void)updateFormantBank(formantFilters_, spec_, tone,
                            options_.controlSmoothingMs, false);
}

void OscBotFxProcessor::applyEvent(const OscBotFxEvent& event) noexcept {
    switch (event.control) {
    case OscBotControl::Active: activeTarget_ = event.value; break;
    case OscBotControl::Mix: mixTarget_ = event.value; break;
    case OscBotControl::Waveform: {
        const auto waveform = static_cast<OscBotWaveform>(static_cast<std::uint8_t>(event.value));
        if (!validWaveform(waveform) || waveform == options_.waveform) break;
        options_.waveform = waveform;
        for (auto& voice : voices_) {
            if (!voice.active) continue;
            voice.previousLeft = voice.left;
            voice.previousRight = voice.right;
            voice.previousVintageLeft = voice.vintageLeft;
            voice.previousVintageRight = voice.vintageRight;
            voice.previousRectLeft = voice.rectLeft;
            voice.previousRectRight = voice.rectRight;
            voice.previousWaveform = voice.waveform;
            voice.waveform = waveform;
            voice.waveformFadeRemaining = kOscBotVoiceFadeSamples;
            voice.left.setWaveform(botPrimitiveWaveform(waveform));
            voice.right.setWaveform(botPrimitiveWaveform(waveform));
            voice.rectLeft.setWaveform(botRectangularOffsetWaveform(waveform));
            voice.rectRight.setWaveform(botRectangularOffsetWaveform(waveform));
        }
        break;
    }
    case OscBotControl::Tone:
        options_.tone = event.value;
        updateFormantTargets(event.value);
        break;
    case OscBotControl::Attack: {
        options_.attack = event.value;
        const double attackSeconds = 0.001 + static_cast<double>(event.value) * 0.00199;
        envelopeAttackCoefficient_ = static_cast<float>(1.0 - std::exp(
            -1.0 / (attackSeconds * spec_.sampleRate)));
        break;
    }
    case OscBotControl::Note: options_.note = static_cast<std::uint8_t>(event.value); break;
    case OscBotControl::ModSensitivity: options_.modulationSensitivity = event.value; break;
    case OscBotControl::Balance:
        options_.balance = event.value;
        balanceTarget_ = event.value;
        break;
    case OscBotControl::Pattern:
        options_.pattern = static_cast<std::uint8_t>(event.value);
        break;
    }
}

void OscBotFxProcessor::triggerNote(std::uint8_t note, float velocity) noexcept {
    if (note > 127U || velocity <= 0.0f) return;
    Voice* selected = nullptr;
    for (auto& voice : voices_) {
        if (!voice.active || voice.gain <= kOscBotIdleThreshold) {
            selected = &voice;
            break;
        }
    }
    if (selected == nullptr) {
        selected = &*std::min_element(voices_.begin(), voices_.end(),
            [](const Voice& left, const Voice& right) {
                if (left.gain != right.gain) return left.gain < right.gain;
                return left.age < right.age;
            });
        auto tail = std::find_if(retired_.begin(), retired_.end(),
            [](const Retired& candidate) { return candidate.remaining == 0U; });
        if (tail == retired_.end())
            tail = std::min_element(retired_.begin(), retired_.end(),
                [](const Retired& left, const Retired& right) {
                    return left.remaining < right.remaining;
                });
        tail->left = selected->left;
        tail->right = selected->right;
        tail->vintageLeft = selected->vintageLeft;
        tail->vintageRight = selected->vintageRight;
        tail->rectLeft = selected->rectLeft;
        tail->rectRight = selected->rectRight;
        tail->gain = clean(selected->gain * selected->velocity);
        tail->remaining = kOscBotVoiceFadeSamples;
        tail->waveform = selected->waveform;
    }
    selected->note = note;
    selected->velocity = std::clamp(velocity, 0.0f, 1.0f);
    selected->gain = 0.0f;
    selected->targetGain = selected->velocity;
    selected->age = noteAge_++;
    selected->active = true;
    selected->waveform = options_.waveform;
    selected->previousWaveform = options_.waveform;
    selected->waveformFadeRemaining = 0U;
    selected->left.setWaveform(botPrimitiveWaveform(options_.waveform));
    selected->right.setWaveform(botPrimitiveWaveform(options_.waveform));
    selected->vintageLeft.setWaveform(OscillatorWaveform::Sine);
    selected->vintageRight.setWaveform(OscillatorWaveform::Sine);
    selected->rectLeft.setWaveform(botRectangularOffsetWaveform(options_.waveform));
    selected->rectRight.setWaveform(botRectangularOffsetWaveform(options_.waveform));
    const float frequency = oscillatorFrequency(note, 0.0f);
    (void)selected->left.setFrequency(frequency);
    (void)selected->right.setFrequency(frequency);
    (void)selected->vintageLeft.setFrequency(frequency);
    (void)selected->vintageRight.setFrequency(frequency);
    (void)selected->rectLeft.setFrequency(frequency);
    (void)selected->rectRight.setFrequency(frequency);
    selected->left.reset(0.0f);
    selected->right.reset(0.23f);
    selected->vintageLeft.reset(0.0f);
    selected->vintageRight.reset(0.23f);
    selected->rectLeft.reset(0.25f);
    selected->rectRight.reset(0.48f);
    selected->previousLeft = selected->left;
    selected->previousRight = selected->right;
    selected->previousVintageLeft = selected->vintageLeft;
    selected->previousVintageRight = selected->vintageRight;
    selected->previousRectLeft = selected->rectLeft;
    selected->previousRectRight = selected->rectRight;
}

void OscBotFxProcessor::triggerStep(std::uint64_t absoluteFrame) noexcept {
    for (auto& voice : voices_) if (voice.active) voice.targetGain = 0.0f;
    const auto step = static_cast<std::size_t>(stepCount_ % 8U);
    const auto offset = kOscBotPatterns[options_.pattern][step];
    const int note = std::clamp(static_cast<int>(options_.note) + offset, 0, 127);
    triggerNote(static_cast<std::uint8_t>(note), 1.0f);
    ++stepCount_;
    nextStepFrame_ = absoluteFrame > kMaximumExactFrame - stepFrames_
        ? kMaximumExactFrame : absoluteFrame + stepFrames_;
}

bool OscBotFxProcessor::processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                                     std::uint32_t frames, const OscBotFxEvent* events,
                                     std::uint32_t eventCount) noexcept {
    if (!prepared_ || (frames != 0U && interleaved == nullptr) || frames > spec_.maxBlockFrames ||
        blockStartFrame > kMaximumExactFrame || frames > kMaximumExactFrame - blockStartFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;
    std::uint32_t eventIndex = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        const std::uint64_t absoluteFrame = blockStartFrame + frame;
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame)
            applyEvent(events[eventIndex++]);
        const auto dry = interleaved[frame];
        const float magnitudeLeft = std::fabs(clean(dry.left));
        const float magnitudeRight = std::fabs(clean(dry.right));
        const float leftCoefficient = magnitudeLeft > envelopeLeft_
            ? envelopeAttackCoefficient_ : envelopeReleaseCoefficient_;
        const float rightCoefficient = magnitudeRight > envelopeRight_
            ? envelopeAttackCoefficient_ : envelopeReleaseCoefficient_;
        envelopeLeft_ = clean(envelopeLeft_ + leftCoefficient * (magnitudeLeft - envelopeLeft_));
        envelopeRight_ = clean(envelopeRight_ + rightCoefficient * (magnitudeRight - envelopeRight_));
        if (absoluteFrame == nextStepFrame_) triggerStep(absoluteFrame);
        if (++modulationUpdateCounter_ >= 16U) {
            modulationUpdateCounter_ = 0U;
            for (auto& voice : voices_) {
                if (!voice.active) continue;
                const float env = 0.5f * (envelopeLeft_ + envelopeRight_);
                const float semitones = options_.modulationSensitivity / 50.0f * 6.0f * (env - 0.5f);
                const float detuneLeft = options_.waveform == OscBotWaveform::DetuneSaw ? -8.0f :
                    options_.waveform == OscBotWaveform::VintageSaw ? -1.5f : 0.0f;
                const float detuneRight = -detuneLeft;
                (void)voice.left.setFrequency(oscillatorFrequency(voice.note, semitones * 100.0f + detuneLeft));
                (void)voice.right.setFrequency(oscillatorFrequency(voice.note, semitones * 100.0f + detuneRight));
                (void)voice.vintageLeft.setFrequency(oscillatorFrequency(voice.note,
                    semitones * 100.0f + detuneLeft));
                (void)voice.vintageRight.setFrequency(oscillatorFrequency(voice.note,
                    semitones * 100.0f + detuneRight));
                (void)voice.rectLeft.setFrequency(oscillatorFrequency(voice.note, semitones * 100.0f + detuneLeft));
                (void)voice.rectRight.setFrequency(oscillatorFrequency(voice.note, semitones * 100.0f + detuneRight));
            }
        }
        double voiceLeft = 0.0;
        double voiceRight = 0.0;
        for (auto& voice : voices_) {
            if (!voice.active) continue;
            const float coefficient = voice.targetGain > voice.gain
                ? envelopeAttackCoefficient_ : envelopeReleaseCoefficient_;
            voice.gain = clean(voice.gain + coefficient * (voice.targetGain - voice.gain));
            if (voice.targetGain == 0.0f && voice.gain <= kOscBotIdleThreshold) {
                voice.gain = 0.0f;
                voice.active = false;
                continue;
            }
            float leftSample = botRenderWave(voice.left, voice.rectLeft,
                                              voice.vintageLeft, voice.waveform);
            float rightSample = botRenderWave(voice.right, voice.rectRight,
                                              voice.vintageRight, voice.waveform);
            if (voice.waveformFadeRemaining > 0U) {
                const float oldLeft = botRenderWave(voice.previousLeft, voice.previousRectLeft,
                    voice.previousVintageLeft, voice.previousWaveform);
                const float oldRight = botRenderWave(voice.previousRight, voice.previousRectRight,
                    voice.previousVintageRight, voice.previousWaveform);
                const float phase = static_cast<float>(kOscBotVoiceFadeSamples -
                    voice.waveformFadeRemaining) / static_cast<float>(kOscBotVoiceFadeSamples - 1U);
                leftSample = equalPowerCrossfade(oldLeft, leftSample, phase);
                rightSample = equalPowerCrossfade(oldRight, rightSample, phase);
                --voice.waveformFadeRemaining;
            }
            const float inputEnvelope = 0.5f * (envelopeLeft_ + envelopeRight_);
            const float inputGain = std::clamp(0.2f + 1.6f * inputEnvelope, 0.0f, 1.25f);
            voiceLeft += static_cast<double>(leftSample) * voice.gain * inputGain;
            voiceRight += static_cast<double>(rightSample) * voice.gain * inputGain;
        }
        for (auto& tail : retired_) {
            if (tail.remaining == 0U) continue;
            const float fade = static_cast<float>(tail.remaining - 1U) /
                               static_cast<float>(kOscBotVoiceFadeSamples - 1U);
            voiceLeft += static_cast<double>(botRenderWave(tail.left, tail.rectLeft,
                tail.vintageLeft, tail.waveform)) * tail.gain * fade;
            voiceRight += static_cast<double>(botRenderWave(tail.right, tail.rectRight,
                tail.vintageRight, tail.waveform)) * tail.gain * fade;
            --tail.remaining;
            if (tail.remaining == 0U) tail.gain = 0.0f;
        }
        const float synthLeft = processFormantBank(formantFilters_, 0U,
            clean(static_cast<float>(voiceLeft)));
        const float synthRight = processFormantBank(formantFilters_, 1U,
            clean(static_cast<float>(voiceRight)));
        activeCurrent_ += static_cast<float>(activeSmoothingCoefficient_) *
                          (activeTarget_ - activeCurrent_);
        mixCurrent_ += static_cast<float>(activeSmoothingCoefficient_) *
                       (mixTarget_ - mixCurrent_);
        balanceCurrent_ += static_cast<float>(activeSmoothingCoefficient_) *
                           (balanceTarget_ - balanceCurrent_);
        const float balanceLeft = balanceCurrent_ <= 0.5f ? 1.0f :
            2.0f * (1.0f - balanceCurrent_);
        const float balanceRight = balanceCurrent_ >= 0.5f ? 1.0f :
            2.0f * balanceCurrent_;
        const float balancedSynthLeft = clean(synthLeft * balanceLeft);
        const float balancedSynthRight = clean(synthRight * balanceRight);
        const float processedLeft = clean(dry.left * (1.0f - mixCurrent_) +
                                          balancedSynthLeft * mixCurrent_);
        const float processedRight = clean(dry.right * (1.0f - mixCurrent_) +
                                           balancedSynthRight * mixCurrent_);
        const float amount = std::clamp(clean(activeCurrent_), 0.0f, 1.0f);
        interleaved[frame] = {clean(dry.left + amount * (processedLeft - dry.left)),
                              clean(dry.right + amount * (processedRight - dry.right))};
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

} // namespace webrc::dsp
