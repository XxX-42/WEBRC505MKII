#include "webrc/dsp/distortion_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::uint64_t kMaximumExactlyRepresentableFrame = 9007199254740992ULL;
constexpr float kMaximumSampleRate = 192000.0f;
constexpr std::uint32_t kMaximumBlockFrames = 8192U;
constexpr float kMaximumAudioMagnitude = 8.0f;

[[nodiscard]] bool validOptions(const DistortionFxOptions& options) noexcept {
    const bool validModel = options.model == DistortionModel::AdaaCubic4x ||
                            options.model == DistortionModel::SymmetricDiode4x;
    if (!validModel) return false;
    if (options.model == DistortionModel::AdaaCubic4x) return true;
    return std::isfinite(options.diodePortResistance) &&
           options.diodePortResistance >= 1.0 && options.diodePortResistance <= 1.0e6 &&
           std::isfinite(options.diodeSaturationCurrent) &&
           options.diodeSaturationCurrent >= 1.0e-12 &&
           options.diodeSaturationCurrent <= 1.0e-3 &&
           std::isfinite(options.diodeThermalVoltage) &&
           options.diodeThermalVoltage >= 0.005 && options.diodeThermalVoltage <= 0.2 &&
           std::isfinite(options.diodeIdeality) &&
           options.diodeIdeality >= 0.5 && options.diodeIdeality <= 4.0;
}

[[nodiscard]] bool validSpec(const ProcessSpec& spec) noexcept {
    return validProcessSpec(spec) && spec.channels == 2U &&
           spec.sampleRate >= 24000.0f && spec.sampleRate <= kMaximumSampleRate &&
           spec.maxBlockFrames <= kMaximumBlockFrames;
}

[[nodiscard]] bool finiteRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] float boundedAudio(float value) noexcept {
    return std::clamp(sanitize(value), -kMaximumAudioMagnitude, kMaximumAudioMagnitude);
}

} // namespace

std::size_t DistortionFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const DistortionFxOptions& options) noexcept {
    if (!validSpec(spec) || !validOptions(options)) return 0U;
    // All channel shapers, filters and histories are fixed-size members.
    return sizeof(DistortionFxProcessor);
}

bool DistortionFxProcessor::prepare(const ProcessSpec& spec,
                                    const DistortionFxOptions& options) {
    prepared_ = false;
    const auto admittedBytes = requiredPrepareBytes(spec, options);
    if (admittedBytes == 0U) return false;
    const auto model = options.model == DistortionModel::AdaaCubic4x
        ? NonlinearModel::AdaaCubic : NonlinearModel::WdfSymmetricDiode;
    bool ready = true;
    for (auto& shaper : shapers_) {
        ready = ready && shaper.prepare(spec, OversamplingFactor::x4, model);
        if (ready && model == NonlinearModel::WdfSymmetricDiode) {
            ready = shaper.setDiodeParameters(options.diodePortResistance,
                options.diodeSaturationCurrent, options.diodeThermalVoltage,
                options.diodeIdeality);
        }
    }
    if (!ready) return false;

    spec_ = spec;
    options_ = options;
    preparedBytes_ = admittedBytes;
    smoothingCoefficient_ = 1.0 - std::exp(-1.0 / (0.010 * spec.sampleRate));
    toneCoefficientCurrent_ = toneCoefficientTarget_ = 1.0 - std::exp(
        -2.0 * kPi * static_cast<double>(toneHzTarget_) / spec.sampleRate);
    prepared_ = true;
    reset();
    return true;
}

void DistortionFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    absoluteFrame = std::min(absoluteFrame, kMaximumExactlyRepresentableFrame);
    for (auto& shaper : shapers_) shaper.reset();
    toneState_.fill(0.0);
    activeCurrent_ = activeTarget_ = 0.0f;
    mixCurrent_ = mixTarget_;
    driveCurrent_ = driveTarget_;
    outputGainCurrent_ = outputGainTarget_;
    toneCoefficientCurrent_ = toneCoefficientTarget_;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = true;
}

bool DistortionFxProcessor::validateEvent(const DistortionFxEvent& event) const noexcept {
    if (!std::isfinite(event.value)) return false;
    switch (event.control) {
    case DistortionFxControl::Active:
    case DistortionFxControl::Mix:
        return finiteRange(event.value, 0.0f, 1.0f);
    case DistortionFxControl::Drive:
        return finiteRange(event.value, 0.1f, 24.0f);
    case DistortionFxControl::ToneHz:
        return finiteRange(event.value, 100.0f,
                           std::min(18000.0f, spec_.sampleRate * 0.45f));
    case DistortionFxControl::OutputDb:
        return finiteRange(event.value, -24.0f, 12.0f);
    }
    return false;
}

bool DistortionFxProcessor::validateEvents(std::uint32_t frames,
                                           const DistortionFxEvent* events,
                                           std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    std::uint32_t previous = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames ||
            (i != 0U && events[i].frameOffset < previous) ||
            !validateEvent(events[i])) return false;
        previous = events[i].frameOffset;
    }
    return true;
}

void DistortionFxProcessor::applyEvent(const DistortionFxEvent& event) noexcept {
    switch (event.control) {
    case DistortionFxControl::Active:
        activeTarget_ = event.value;
        break;
    case DistortionFxControl::Mix:
        mixTarget_ = event.value;
        break;
    case DistortionFxControl::Drive:
        driveTarget_ = event.value;
        break;
    case DistortionFxControl::ToneHz:
        toneHzTarget_ = event.value;
        toneCoefficientTarget_ = 1.0 - std::exp(
            -2.0 * kPi * static_cast<double>(toneHzTarget_) / spec_.sampleRate);
        break;
    case DistortionFxControl::OutputDb:
        outputGainTarget_ = std::pow(10.0f, event.value / 20.0f);
        break;
    }
}

void DistortionFxProcessor::advanceParameters() noexcept {
    const float coefficient = static_cast<float>(smoothingCoefficient_);
    activeCurrent_ += (activeTarget_ - activeCurrent_) * coefficient;
    mixCurrent_ += (mixTarget_ - mixCurrent_) * coefficient;
    driveCurrent_ += (driveTarget_ - driveCurrent_) * coefficient;
    outputGainCurrent_ += (outputGainTarget_ - outputGainCurrent_) * coefficient;
    toneCoefficientCurrent_ +=
        (toneCoefficientTarget_ - toneCoefficientCurrent_) * smoothingCoefficient_;
    if (std::fabs(activeTarget_ - activeCurrent_) < 1.0e-7f) activeCurrent_ = activeTarget_;
    if (std::fabs(mixTarget_ - mixCurrent_) < 1.0e-7f) mixCurrent_ = mixTarget_;
    if (std::fabs(driveTarget_ - driveCurrent_) < 1.0e-6f) driveCurrent_ = driveTarget_;
    if (std::fabs(outputGainTarget_ - outputGainCurrent_) < 1.0e-7f)
        outputGainCurrent_ = outputGainTarget_;
    if (std::fabs(toneCoefficientTarget_ - toneCoefficientCurrent_) < 1.0e-12)
        toneCoefficientCurrent_ = toneCoefficientTarget_;
}

StereoFrame DistortionFxProcessor::processSample(StereoFrame input) noexcept {
    advanceParameters();
    // Keep a wide linear input guard for malformed/outlier buffers, but never
    // clip normal audio at the base rate before the x4 antialiasing stages.
    constexpr float kLinearInputGuard = 8.0f;
    const float drivenLeft = std::clamp(sanitize(input.left),
        -kLinearInputGuard, kLinearInputGuard) * driveCurrent_;
    const float drivenRight = std::clamp(sanitize(input.right),
        -kLinearInputGuard, kLinearInputGuard) * driveCurrent_;
    const float shapedLeft = shapers_[0].processSample(drivenLeft);
    const float shapedRight = shapers_[1].processSample(drivenRight);
    toneState_[0] += toneCoefficientCurrent_ *
        (static_cast<double>(shapedLeft) - toneState_[0]);
    toneState_[1] += toneCoefficientCurrent_ *
        (static_cast<double>(shapedRight) - toneState_[1]);
    const float wetLeft = boundedAudio(static_cast<float>(toneState_[0]) * outputGainCurrent_);
    const float wetRight = boundedAudio(static_cast<float>(toneState_[1]) * outputGainCurrent_);
    const float mix = std::clamp(activeCurrent_ * mixCurrent_, 0.0f, 1.0f);
    return {boundedAudio(input.left + (wetLeft - input.left) * mix),
            boundedAudio(input.right + (wetRight - input.right) * mix)};
}

bool DistortionFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                         StereoFrame* interleaved,
                                         std::uint32_t frames,
                                         const DistortionFxEvent* events,
                                         std::uint32_t eventCount) noexcept {
    if (!prepared_ || frames > spec_.maxBlockFrames ||
        (frames != 0U && interleaved == nullptr) ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        blockStartFrame + frames > kMaximumExactlyRepresentableFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;

    std::uint32_t eventIndex = 0U;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == i)
            applyEvent(events[eventIndex++]);
        interleaved[i] = processSample({boundedAudio(interleaved[i].left),
                                         boundedAudio(interleaved[i].right)});
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

DistortionFxLatency DistortionFxProcessor::latency() const noexcept {
    DistortionFxLatency result{};
    if (prepared_) result.frequencyDependentGroupDelaySamples =
        shapers_[0].lowFrequencySmallSignalGroupDelaySamples();
    return result;
}

} // namespace webrc::dsp
