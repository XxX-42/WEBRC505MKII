#include "native_phaser_processor.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 6.28318530717958647692;
constexpr float kFeedbackStateLimit = 4.0f;

bool supportedStageCount(unsigned int stages) noexcept {
    return stages == 4U || stages == 8U || stages == 12U;
}

} // namespace

bool NativePhaserProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) {
        return false;
    }

    sampleRate_ = sampleRate;
    allpassStates_ = {};
    feedbackState_.fill(0.0f);
    phase_ = 0.0;
    rateHz_.reset(config_.rateHz);
    depth_.reset(config_.depth);
    feedback_.reset(config_.feedback);
    wetMix_.reset(config_.enabled ? config_.wetMix : 0.0f);
    stageCount_.reset(static_cast<float>(config_.stages));
    return true;
}

bool NativePhaserProcessor::setConfig(const PhaserProcessorConfig& config, std::uint64_t rampFrames) noexcept {
    if (!supportedStageCount(config.stages) ||
        !std::isfinite(config.rateHz) || !std::isfinite(config.depth) ||
        !std::isfinite(config.feedback) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.05f || config.rateHz > 10.0f ||
        config.depth < 0.0f || config.depth > 1.0f ||
        config.feedback < -0.9f || config.feedback > 0.9f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    config_ = config;
    rateHz_.setTarget(config.rateHz, rampFrames);
    depth_.setTarget(config.depth, rampFrames);
    feedback_.setTarget(config.feedback, rampFrames);
    wetMix_.setTarget(config.enabled ? config.wetMix : 0.0f, rampFrames);
    stageCount_.setTarget(static_cast<float>(config.stages), rampFrames);
    return true;
}

float NativePhaserProcessor::processAllpass(float input, float coefficient, AllpassState& state) noexcept {
    // H(z) = (a + z^-1) / (1 + a z^-1), with |a| < 1. This first-order
    // all-pass section changes phase without changing steady-state magnitude.
    const float output = (coefficient * input) + state.previousInput - (coefficient * state.previousOutput);
    state.previousInput = input;
    state.previousOutput = std::fabs(output) < 1.0e-20f ? 0.0f : output;
    return state.previousOutput;
}

float NativePhaserProcessor::coefficientForSweep(float normalizedSweep) const noexcept {
    const double position = static_cast<double>(std::clamp(normalizedSweep, 0.0f, 1.0f));
    // A logarithmic 140 Hz .. 6.3 kHz sweep is musical over a wide range of
    // sample rates; depth contracts this range around its logarithmic centre.
    const double requestedHz = 140.0 * std::exp2(position * 5.5);
    const double cutoffHz = std::clamp(
        requestedHz,
        20.0,
        static_cast<double>(sampleRate_) * 0.45
    );
    const double tangent = std::tan(kPi * cutoffHz / static_cast<double>(sampleRate_));
    const double coefficient = (tangent - 1.0) / (tangent + 1.0);
    return static_cast<float>(std::clamp(coefficient, -0.98, 0.98));
}

float NativePhaserProcessor::processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) {
        return 0.0f;
    }

    float peak = 0.0f;
    const auto processedChannels = std::min<unsigned int>(channels, static_cast<unsigned int>(kChannels));
    for (unsigned int frame = 0; frame < frames; ++frame) {
        const float rate = rateHz_.next();
        const float depth = depth_.next();
        const float feedback = feedback_.next();
        const float mix = wetMix_.next();
        const float stageCount = stageCount_.next();
        const float sweepPosition = 0.5f + (0.5f * depth * static_cast<float>(std::sin(phase_)));
        const float coefficient = coefficientForSweep(sweepPosition);
        const auto mixGains = dsp::equalPowerCrossfadeGains(mix);
        const float stagePosition = std::clamp((stageCount - 4.0f) / 4.0f, 0.0f, 2.0f);
        const auto lowerGroup = static_cast<std::size_t>(stagePosition);
        const auto upperGroup = std::min<std::size_t>(lowerGroup + 1U, 2U);
        const float stageBlend = stagePosition - static_cast<float>(lowerGroup);
        const std::size_t offset = static_cast<std::size_t>(frame) * channels;

        for (unsigned int channel = 0; channel < processedChannels; ++channel) {
            const float dry = interleaved[offset + channel];
            const float feedbackInput = dry + (feedback * feedbackState_[channel]);
            float stageInput = feedbackInput;
            std::array<float, 3> groupOutput{};
            for (std::size_t stage = 0; stage < kMaximumStages; ++stage) {
                stageInput = processAllpass(stageInput, coefficient, allpassStates_[channel][stage]);
                if (((stage + 1U) % kStageGroupSize) == 0U) {
                    groupOutput[stage / kStageGroupSize] = stageInput;
                }
            }
            const float wet = groupOutput[lowerGroup] +
                ((groupOutput[upperGroup] - groupOutput[lowerGroup]) * stageBlend);
            feedbackState_[channel] = std::clamp(wet, -kFeedbackStateLimit, kFeedbackStateLimit);
            const float output = (dry * mixGains.first) + (wet * mixGains.second);
            interleaved[offset + channel] = output;
            peak = std::max(peak, std::fabs(output));
        }

        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            peak = std::max(peak, std::fabs(interleaved[offset + channel]));
        }

        phase_ += kTwoPi * static_cast<double>(rate) / static_cast<double>(sampleRate_);
        if (phase_ >= kTwoPi) {
            phase_ -= kTwoPi;
        }
    }
    return peak;
}

} // namespace webrc::native
