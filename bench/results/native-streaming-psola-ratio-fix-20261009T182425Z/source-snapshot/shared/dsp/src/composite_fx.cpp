#include "webrc/dsp/composite_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kControlSmoothingSeconds = 0.005;
constexpr double kSlowGearDetectorAttackMs = 0.5;
constexpr double kSlowGearDetectorReleaseMs = 8.0;
constexpr double kSlowGearReferenceMs = 80.0;
constexpr double kSlowGearRearmFadeMs = 8.0;
constexpr double kSlowGearRearmSmoothingMs = 1.5;

[[nodiscard]] bool finiteInRange(float value, float low, float high) noexcept {
    return std::isfinite(value) && value >= low && value <= high;
}

[[nodiscard]] bool integralInRange(float value, float low, float high) noexcept {
    return finiteInRange(value, low, high) && std::floor(value) == value;
}

[[nodiscard]] bool validKind(CompositeFxKind kind) noexcept {
    return static_cast<std::uint8_t>(kind) <=
           static_cast<std::uint8_t>(CompositeFxKind::StereoEnhance);
}

[[nodiscard]] double onePoleCoefficient(double milliseconds, double sampleRate) noexcept {
    if (!(milliseconds > 0.0)) return 0.0;
    return std::exp(-1.0 / (milliseconds * 0.001 * sampleRate));
}

[[nodiscard]] float bounded(float sample) noexcept {
    return std::clamp(sanitize(sample), -8.0f, 8.0f);
}

[[nodiscard]] double radioCubicShape(double value) noexcept {
    if (value >= 1.0) return 1.0;
    if (value <= -1.0) return -1.0;
    return 1.5 * value - 0.5 * value * value * value;
}

[[nodiscard]] double radioCubicAntiderivative(double value) noexcept {
    if (value >= 1.0 || value <= -1.0) return std::fabs(value) - 0.375;
    const double squared = value * value;
    return 0.75 * squared - 0.125 * squared * squared;
}

[[nodiscard]] float processRadioAdaa(double previousInput, float input,
                                     float drive) noexcept {
    const double current = static_cast<double>(input) * drive;
    const double previous = previousInput * drive;
    const double difference = current - previous;
    const double output = std::fabs(difference) > 1.0e-8
        ? (radioCubicAntiderivative(current) - radioCubicAntiderivative(previous)) / difference
        : radioCubicShape(0.5 * (current + previous));
    return sanitize(static_cast<float>(output));
}

} // namespace

std::size_t CompositeFxProcessor::requiredPrepareBytes(const ProcessSpec& spec,
                                                       CompositeFxKind kind) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2 || spec.sampleRate > 192000.0f ||
        !validKind(kind)) return 0;
    return sizeof(CompositeFxProcessor);
}

bool CompositeFxProcessor::prepare(const ProcessSpec& spec) {
    if (requiredPrepareBytes(spec, kind_) == 0) return false;
    prepared_ = false;
    spec_ = spec;
    wet_ = 1.0f;
    radioHighPassHz_ = 220.0f;
    radioLowPassHz_ = 3400.0f;
    radioDrive_ = 2.5f;
    radioBitDepth_ = 12U;
    radioHoldFrames_ = 2U;
    radioBitMix_ = 0.35f;
    sustainerThresholdDb_ = -24.0f;
    sustainerRatio_ = 8.0f;
    sustainerAttackMs_ = 8.0f;
    sustainerReleaseMs_ = 450.0f;
    sustainerRmsMix_ = 0.55f;
    sustainerMakeupDb_ = 4.0f;
    slowGearAttackMs_ = 300.0f;
    slowGearReleaseMs_ = 120.0f;
    slowGearSensitivity_ = 2.0f;
    stereoHighWidth_ = 1.6f;
    stereoLowWidth_ = 0.35f;
    stereoSmoothingMs_ = 20.0f;
    activeSmoothingCoefficient_ = onePoleCoefficient(kControlSmoothingSeconds * 1000.0,
                                                      spec.sampleRate);
    wetSmoothingCoefficient_ = activeSmoothingCoefficient_;
    radioDriveSmoothingCoefficient_ = activeSmoothingCoefficient_;
    sustainerGainSmoothingCoefficient_ = onePoleCoefficient(kControlSmoothingSeconds * 1000.0,
                                                             spec.sampleRate);
    switch (kind_) {
    case CompositeFxKind::Radio:
        for (std::size_t channel = 0; channel < 2; ++channel) {
            if (!radioHighPass_[channel].prepare(spec) ||
                !radioLowPass_[channel].prepare(spec) ||
                !radioReducer_[channel].prepare(spec)) return false;
            if (!radioHighPass_[channel].setHighpass(radioHighPassHz_, 0.70710678f, 5.0f) ||
                !radioLowPass_[channel].setLowpass(radioLowPassHz_, 0.70710678f, 5.0f) ||
                !radioReducer_[channel].setParameters(radioBitDepth_, radioHoldFrames_,
                                                       radioBitMix_, true, 10.0f)) return false;
        }
        break;
    case CompositeFxKind::Sustainer:
        if (!sustainer_.prepare(spec) ||
            !sustainer_.setParameters(sustainerThresholdDb_, sustainerRatio_, 6.0f,
                                      sustainerAttackMs_, sustainerReleaseMs_,
                                      sustainerRmsMix_, sustainerMakeupDb_)) return false;
        sustainerGainCurrent_ = 1.0f;
        break;
    case CompositeFxKind::SlowGear:
        slowAttackCoefficient_ = onePoleCoefficient(slowGearAttackMs_, spec.sampleRate);
        slowReleaseCoefficient_ = onePoleCoefficient(slowGearReleaseMs_, spec.sampleRate);
        slowDetectorAttackCoefficient_ = onePoleCoefficient(kSlowGearDetectorAttackMs,
                                                             spec.sampleRate);
        slowDetectorReleaseCoefficient_ = onePoleCoefficient(kSlowGearDetectorReleaseMs,
                                                              spec.sampleRate);
        slowReferenceCoefficient_ = onePoleCoefficient(kSlowGearReferenceMs,
                                                        spec.sampleRate);
        slowRearmSmoothingCoefficient_ = onePoleCoefficient(kSlowGearRearmSmoothingMs,
                                                              spec.sampleRate);
        slowGearRearmSamples_ = static_cast<std::uint32_t>(std::ceil(
            kSlowGearRearmFadeMs * 0.001 * static_cast<double>(spec.sampleRate)));
        break;
    case CompositeFxKind::StereoEnhance:
        if (!stereoWidth_.prepare(spec, 140.0f) ||
            !stereoWidth_.setWidth(stereoHighWidth_, stereoLowWidth_, 0.0f)) return false;
        break;
    }
    wet_ = 1.0f;
    wetCurrent_ = 1.0f;
    activeGain_ = 0.0f;
    targetActiveGain_ = 0.0f;
    active_ = false;
    prepared_ = true;
    reset(0U);
    hasExpectedFrame_ = false;
    return true;
}

void CompositeFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    switch (kind_) {
    case CompositeFxKind::Radio:
        for (std::size_t channel = 0; channel < 2; ++channel) {
            radioHighPass_[channel].reset();
            radioLowPass_[channel].reset();
            radioPreviousBandLimited_[channel] = 0.0;
            radioReducer_[channel].reset(randomSeed_ ^ (0x9e3779b97f4a7c15ULL * (channel + 1U)),
                                          7U + static_cast<std::uint64_t>(channel));
        }
        radioDriveCurrent_ = radioDrive_;
        break;
    case CompositeFxKind::Sustainer:
        sustainer_.reset();
        sustainerGainCurrent_ = 1.0f;
        break;
    case CompositeFxKind::SlowGear:
        slowGearEnvelope_ = 0.0;
        slowGearDetectorEnvelope_ = 0.0;
        slowGearReferenceEnvelope_ = 0.0;
        slowGearRearmTarget_ = 0.0;
        slowGearRearmSamplesRemaining_ = 0;
        slowGearOnsetArmed_ = true;
        slowGearSensitivityCurrent_ = slowGearSensitivity_;
        break;
    case CompositeFxKind::StereoEnhance:
        stereoWidth_.reset();
        break;
    }
    wetCurrent_ = wet_;
    activeGain_ = 0.0f;
    targetActiveGain_ = 0.0f;
    active_ = false;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = true;
}

bool CompositeFxProcessor::setSeed(std::uint64_t seed) noexcept {
    if (!prepared_ || kind_ != CompositeFxKind::Radio || active_ ||
        activeGain_ != 0.0f || targetActiveGain_ != 0.0f) return false;
    randomSeed_ = seed == 0U ? 0x12e15e35a7bd381dULL : seed;
    for (std::size_t channel = 0; channel < 2; ++channel) {
        radioReducer_[channel].reset(randomSeed_ ^ (0x9e3779b97f4a7c15ULL * (channel + 1U)),
                                      7U + static_cast<std::uint64_t>(channel));
    }
    return true;
}

bool CompositeFxProcessor::validateEvent(const CompositeFxEvent& event) const noexcept {
    switch (event.control) {
    case CompositeFxControl::Active:
        return event.value == 0.0f || event.value == 1.0f;
    case CompositeFxControl::Wet:
        return finiteInRange(event.value, 0.0f, 1.0f);
    case CompositeFxControl::RadioHighPassHz:
        return kind_ == CompositeFxKind::Radio &&
               finiteInRange(event.value, 20.0f, std::min(1200.0f, spec_.sampleRate * 0.40f));
    case CompositeFxControl::RadioLowPassHz:
        return kind_ == CompositeFxKind::Radio &&
               finiteInRange(event.value, 300.0f, std::min(12000.0f, spec_.sampleRate * 0.45f));
    case CompositeFxControl::RadioDrive:
        return kind_ == CompositeFxKind::Radio && finiteInRange(event.value, 0.1f, 12.0f);
    case CompositeFxControl::RadioBitDepth:
        return kind_ == CompositeFxKind::Radio && integralInRange(event.value, 4.0f, 16.0f);
    case CompositeFxControl::RadioHoldFrames:
        return kind_ == CompositeFxKind::Radio && integralInRange(event.value, 1.0f, 32.0f);
    case CompositeFxControl::RadioBitMix:
        return kind_ == CompositeFxKind::Radio && finiteInRange(event.value, 0.0f, 1.0f);
    case CompositeFxControl::SustainerThresholdDb:
        return kind_ == CompositeFxKind::Sustainer && finiteInRange(event.value, -60.0f, 0.0f);
    case CompositeFxControl::SustainerRatio:
        return kind_ == CompositeFxKind::Sustainer && finiteInRange(event.value, 1.0f, 40.0f);
    case CompositeFxControl::SustainerAttackMs:
        return kind_ == CompositeFxKind::Sustainer && finiteInRange(event.value, 0.1f, 2000.0f);
    case CompositeFxControl::SustainerReleaseMs:
        return kind_ == CompositeFxKind::Sustainer && finiteInRange(event.value, 1.0f, 10000.0f);
    case CompositeFxControl::SustainerRmsMix:
        return kind_ == CompositeFxKind::Sustainer && finiteInRange(event.value, 0.0f, 1.0f);
    case CompositeFxControl::SustainerMakeupDb:
        return kind_ == CompositeFxKind::Sustainer && finiteInRange(event.value, -24.0f, 24.0f);
    case CompositeFxControl::SlowGearAttackMs:
        return kind_ == CompositeFxKind::SlowGear && finiteInRange(event.value, 10.0f, 2000.0f);
    case CompositeFxControl::SlowGearReleaseMs:
        return kind_ == CompositeFxKind::SlowGear && finiteInRange(event.value, 10.0f, 5000.0f);
    case CompositeFxControl::SlowGearSensitivity:
        return kind_ == CompositeFxKind::SlowGear && finiteInRange(event.value, 0.5f, 8.0f);
    case CompositeFxControl::StereoHighWidth:
        return kind_ == CompositeFxKind::StereoEnhance && finiteInRange(event.value, 0.0f, 2.0f);
    case CompositeFxControl::StereoLowWidth:
        return kind_ == CompositeFxKind::StereoEnhance && finiteInRange(event.value, 0.0f, 1.0f);
    case CompositeFxControl::StereoSmoothingMs:
        return kind_ == CompositeFxKind::StereoEnhance && finiteInRange(event.value, 0.0f, 1000.0f);
    }
    return false;
}

bool CompositeFxProcessor::validateEvents(std::uint32_t frames,
                                          const CompositeFxEvent* events,
                                          std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && !events)) return false;
    auto candidateHighPass = radioHighPassHz_;
    auto candidateLowPass = radioLowPassHz_;
    std::uint32_t previousOffset = 0;
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        const auto& event = events[i];
        if (event.frameOffset >= frames || (i != 0U && event.frameOffset < previousOffset) ||
            !validateEvent(event)) return false;
        if (event.control == CompositeFxControl::RadioHighPassHz) {
            if (event.value >= candidateLowPass) return false;
            candidateHighPass = event.value;
        } else if (event.control == CompositeFxControl::RadioLowPassHz) {
            if (event.value <= candidateHighPass) return false;
            candidateLowPass = event.value;
        }
        previousOffset = event.frameOffset;
    }
    return true;
}

bool CompositeFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                        StereoFrame* interleaved,
                                        std::uint32_t frames,
                                        const CompositeFxEvent* events,
                                        std::uint32_t eventCount) noexcept {
    if (!prepared_ || !interleaved || frames == 0U || frames > spec_.maxBlockFrames ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (!hasExpectedFrame_) {
        expectedFrame_ = blockStartFrame;
        hasExpectedFrame_ = true;
    }
    std::uint32_t eventIndex = 0;
    for (std::uint32_t offset = 0; offset < frames; ++offset) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == offset) {
            applyEvent(events[eventIndex]);
            ++eventIndex;
        }
        interleaved[offset] = processSample(interleaved[offset]);
    }
    expectedFrame_ = blockStartFrame + frames;
    return true;
}

void CompositeFxProcessor::applyEvent(const CompositeFxEvent& event) noexcept {
    switch (event.control) {
    case CompositeFxControl::Active:
        active_ = event.value > 0.5f;
        targetActiveGain_ = active_ ? 1.0f : 0.0f;
        break;
    case CompositeFxControl::Wet:
        wet_ = event.value;
        break;
    case CompositeFxControl::RadioHighPassHz:
        radioHighPassHz_ = event.value;
        for (auto& filter : radioHighPass_) (void)filter.setHighpass(event.value, 0.70710678f, 5.0f);
        break;
    case CompositeFxControl::RadioLowPassHz:
        radioLowPassHz_ = event.value;
        for (auto& filter : radioLowPass_) (void)filter.setLowpass(event.value, 0.70710678f, 5.0f);
        break;
    case CompositeFxControl::RadioDrive:
        radioDrive_ = event.value;
        break;
    case CompositeFxControl::RadioBitDepth:
    case CompositeFxControl::RadioHoldFrames:
    case CompositeFxControl::RadioBitMix: {
        if (event.control == CompositeFxControl::RadioBitDepth)
            radioBitDepth_ = static_cast<std::uint32_t>(event.value);
        if (event.control == CompositeFxControl::RadioHoldFrames)
            radioHoldFrames_ = static_cast<std::uint32_t>(event.value);
        radioBitMix_ = event.control == CompositeFxControl::RadioBitMix ? event.value : radioBitMix_;
        for (auto& reducer : radioReducer_)
            (void)reducer.setParameters(radioBitDepth_, radioHoldFrames_, radioBitMix_, true, 10.0f);
        break;
    }
    case CompositeFxControl::SustainerThresholdDb:
        sustainerThresholdDb_ = event.value;
        break;
    case CompositeFxControl::SustainerRatio:
        sustainerRatio_ = event.value;
        break;
    case CompositeFxControl::SustainerAttackMs:
        sustainerAttackMs_ = event.value;
        break;
    case CompositeFxControl::SustainerReleaseMs:
        sustainerReleaseMs_ = event.value;
        break;
    case CompositeFxControl::SustainerRmsMix:
        sustainerRmsMix_ = event.value;
        break;
    case CompositeFxControl::SustainerMakeupDb:
        sustainerMakeupDb_ = event.value;
        break;
    case CompositeFxControl::SlowGearAttackMs:
        slowGearAttackMs_ = event.value;
        slowAttackCoefficient_ = onePoleCoefficient(slowGearAttackMs_, spec_.sampleRate);
        break;
    case CompositeFxControl::SlowGearReleaseMs:
        slowGearReleaseMs_ = event.value;
        slowReleaseCoefficient_ = onePoleCoefficient(slowGearReleaseMs_, spec_.sampleRate);
        break;
    case CompositeFxControl::SlowGearSensitivity:
        slowGearSensitivity_ = event.value;
        break;
    case CompositeFxControl::StereoHighWidth:
        stereoHighWidth_ = event.value;
        (void)stereoWidth_.setWidth(stereoHighWidth_, stereoLowWidth_, stereoSmoothingMs_);
        break;
    case CompositeFxControl::StereoLowWidth:
        stereoLowWidth_ = event.value;
        (void)stereoWidth_.setWidth(stereoHighWidth_, stereoLowWidth_, stereoSmoothingMs_);
        break;
    case CompositeFxControl::StereoSmoothingMs:
        stereoSmoothingMs_ = event.value;
        (void)stereoWidth_.setWidth(stereoHighWidth_, stereoLowWidth_, stereoSmoothingMs_);
        break;
    }
    if (kind_ == CompositeFxKind::Sustainer &&
        (event.control >= CompositeFxControl::SustainerThresholdDb &&
         event.control <= CompositeFxControl::SustainerMakeupDb)) {
        (void)sustainer_.setParameters(sustainerThresholdDb_, sustainerRatio_, 6.0f,
                                       sustainerAttackMs_, sustainerReleaseMs_,
                                       sustainerRmsMix_, sustainerMakeupDb_);
    }
}

StereoFrame CompositeFxProcessor::processSample(StereoFrame input) noexcept {
    input = {bounded(input.left), bounded(input.right)};
    wetCurrent_ += (wet_ - wetCurrent_) *
        static_cast<float>(1.0 - wetSmoothingCoefficient_);
    activeGain_ += (targetActiveGain_ - activeGain_) *
                   static_cast<float>(1.0 - activeSmoothingCoefficient_);
    if (std::fabs(targetActiveGain_ - activeGain_) < 1.0e-6f) activeGain_ = targetActiveGain_;
    StereoFrame effect = input;
    switch (kind_) {
    case CompositeFxKind::Radio: effect = processRadio(input); break;
    case CompositeFxKind::Sustainer: effect = processSustainer(input); break;
    case CompositeFxKind::SlowGear: effect = processSlowGear(input); break;
    case CompositeFxKind::StereoEnhance: effect = processStereoEnhance(input); break;
    }
    const auto mix = activeGain_ * wetCurrent_;
    return {bounded(input.left + (effect.left - input.left) * mix),
            bounded(input.right + (effect.right - input.right) * mix)};
}

StereoFrame CompositeFxProcessor::processRadio(StereoFrame input) noexcept {
    radioDriveCurrent_ += (radioDrive_ - radioDriveCurrent_) *
                          static_cast<float>(1.0 - radioDriveSmoothingCoefficient_);
    StereoFrame result{};
    const std::array<float, 2> samples{{input.left, input.right}};
    std::array<float, 2> outputs{};
    for (std::size_t channel = 0; channel < 2; ++channel) {
        const auto bandLimited = radioLowPass_[channel].processSample(
            radioHighPass_[channel].processSample(samples[channel]));
        const auto driven = processRadioAdaa(radioPreviousBandLimited_[channel],
                                             bandLimited, radioDriveCurrent_);
        radioPreviousBandLimited_[channel] = bandLimited;
        outputs[channel] = bounded(radioReducer_[channel].processSample(driven));
    }
    result.left = outputs[0];
    result.right = outputs[1];
    return result;
}

StereoFrame CompositeFxProcessor::processSustainer(StereoFrame input) noexcept {
    const auto compressed = sustainer_.processSample(input.left, input.right);
    const auto leftMagnitude = std::fabs(input.left);
    const auto rightMagnitude = std::fabs(input.right);
    const auto referenceInput = leftMagnitude >= rightMagnitude ? input.left : input.right;
    const auto referenceOutput = leftMagnitude >= rightMagnitude ? compressed.left : compressed.right;
    if (std::fabs(referenceInput) > 1.0e-6f) {
        const auto targetGain = std::clamp(referenceOutput / referenceInput, 0.0f, 64.0f);
        sustainerGainCurrent_ += (targetGain - sustainerGainCurrent_) *
            static_cast<float>(1.0 - sustainerGainSmoothingCoefficient_);
    }
    return {input.left * sustainerGainCurrent_, input.right * sustainerGainCurrent_};
}

StereoFrame CompositeFxProcessor::processSlowGear(StereoFrame input) noexcept {
    const double magnitude = std::max(std::fabs(static_cast<double>(input.left)),
                                      std::fabs(static_cast<double>(input.right)));
    const auto detectorCoefficient = magnitude > slowGearDetectorEnvelope_
        ? slowDetectorAttackCoefficient_ : slowDetectorReleaseCoefficient_;
    slowGearDetectorEnvelope_ = detectorCoefficient * slowGearDetectorEnvelope_ +
        (1.0 - detectorCoefficient) * magnitude;

    // Compare a fast rectified envelope to a slower level reference. The latch
    // rearms only after those envelopes converge, so carrier peaks cannot
    // repeatedly restart the slow attack. A real level onset pulls the gain
    // toward a lower target through a bounded fade instead of resetting state.
    if (slowGearOnsetArmed_ && slowGearDetectorEnvelope_ > 0.08 &&
        slowGearDetectorEnvelope_ > slowGearReferenceEnvelope_ * 1.65 + 0.035) {
        slowGearOnsetArmed_ = false;
        slowGearRearmTarget_ = std::min(slowGearEnvelope_,
                                        slowGearReferenceEnvelope_ * 0.25);
        slowGearRearmSamplesRemaining_ = slowGearRearmSamples_;
    }

    slowGearReferenceEnvelope_ = slowReferenceCoefficient_ * slowGearReferenceEnvelope_ +
        (1.0 - slowReferenceCoefficient_) * slowGearDetectorEnvelope_;
    if (!slowGearOnsetArmed_ && slowGearDetectorEnvelope_ <=
            slowGearReferenceEnvelope_ * 1.25 + 0.02) {
        slowGearOnsetArmed_ = true;
    }

    if (slowGearRearmSamplesRemaining_ != 0U) {
        slowGearEnvelope_ = slowGearRearmTarget_ +
            (slowGearEnvelope_ - slowGearRearmTarget_) * slowRearmSmoothingCoefficient_;
        --slowGearRearmSamplesRemaining_;
    } else {
        const auto coefficient = slowGearDetectorEnvelope_ > slowGearEnvelope_
            ? slowAttackCoefficient_ : slowReleaseCoefficient_;
        slowGearEnvelope_ = coefficient * slowGearEnvelope_ +
            (1.0 - coefficient) * slowGearDetectorEnvelope_;
    }
    slowGearSensitivityCurrent_ += (slowGearSensitivity_ - slowGearSensitivityCurrent_) *
                                   static_cast<float>(1.0 - activeSmoothingCoefficient_);
    const auto gain = std::clamp(static_cast<float>(slowGearEnvelope_) *
                                 slowGearSensitivityCurrent_, 0.0f, 1.0f);
    return {input.left * gain, input.right * gain};
}

StereoFrame CompositeFxProcessor::processStereoEnhance(StereoFrame input) noexcept {
    return stereoWidth_.processSample(input.left, input.right);
}

} // namespace webrc::dsp
