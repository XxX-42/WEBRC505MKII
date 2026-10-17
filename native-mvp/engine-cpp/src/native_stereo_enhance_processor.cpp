#include "native_stereo_enhance_processor.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native {
namespace {

constexpr double kTwoPi = 6.28318530717958647692;

} // namespace

bool NativeStereoEnhanceProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) return false;
    sampleRate_ = sampleRate;
    allpass1Coefficient_ = allpassCoefficient(std::min(650.0f, static_cast<float>(sampleRate_) * 0.12f));
    allpass2Coefficient_ = allpassCoefficient(std::min(2300.0f, static_cast<float>(sampleRate_) * 0.36f));
    reset();
    return true;
}

bool NativeStereoEnhanceProcessor::setConfig(
    const NativeStereoEnhanceConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!std::isfinite(config.widthPercent) || !std::isfinite(config.lowMonoCutoffHz) ||
        !std::isfinite(config.decorrelationPercent) || !std::isfinite(config.wetMixPercent) ||
        config.widthPercent < 0.0f || config.widthPercent > 200.0f ||
        config.lowMonoCutoffHz < 20.0f || config.lowMonoCutoffHz > 1000.0f ||
        config.decorrelationPercent < 0.0f || config.decorrelationPercent > 100.0f ||
        config.wetMixPercent < 0.0f || config.wetMixPercent > 100.0f) {
        return false;
    }

    config_ = config;
    width_.setTarget(config.widthPercent * 0.01f, rampFrames);
    lowMonoCutoffHz_.setTarget(config.lowMonoCutoffHz, rampFrames);
    decorrelation_.setTarget(config.decorrelationPercent * 0.01f, rampFrames);
    wetMix_.setTarget(config.wetMixPercent * 0.01f, rampFrames);
    return true;
}

void NativeStereoEnhanceProcessor::reset() noexcept {
    if (sampleRate_ == 0U) return;
    width_.reset(config_.widthPercent * 0.01f);
    lowMonoCutoffHz_.reset(config_.lowMonoCutoffHz);
    decorrelation_.reset(config_.decorrelationPercent * 0.01f);
    wetMix_.reset(config_.wetMixPercent * 0.01f);
    processedFrames_ = 0U;
    lowSideState_ = 0.0f;
    allpassInput_.fill(0.0f);
    allpassOutput_.fill(0.0f);
    updateLowMonoCoefficient(lowMonoCutoffHz_.current());
}

float NativeStereoEnhanceProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) return 0.0f;
    float peak = 0.0f;
    for (unsigned int frameIndex = 0U; frameIndex < frames; ++frameIndex) {
        const std::size_t offset = static_cast<std::size_t>(frameIndex) * channels;
        const float width = width_.next();
        const float cutoffHz = lowMonoCutoffHz_.next();
        const float decorrelation = decorrelation_.next();
        const auto mixGains = dsp::equalPowerCrossfadeGains(wetMix_.next());
        if ((processedFrames_ % kCoefficientUpdateInterval) == 0U) updateLowMonoCoefficient(cutoffHz);
        ++processedFrames_;

        if (channels >= 2U) {
            const float inputLeft = std::isfinite(interleaved[offset]) ? interleaved[offset] : 0.0f;
            const float inputRight = std::isfinite(interleaved[offset + 1U]) ? interleaved[offset + 1U] : 0.0f;
            const float mid = 0.5f * (inputLeft + inputRight);
            const float side = 0.5f * (inputLeft - inputRight);

            lowSideState_ += lowMonoAlpha_ * (side - lowSideState_);
            const float highSide = side - lowSideState_;
            const float firstAllpass = -allpass1Coefficient_ * highSide +
                allpassInput_[0] + allpass1Coefficient_ * allpassOutput_[0];
            allpassInput_[0] = highSide;
            allpassOutput_[0] = firstAllpass;
            const float secondAllpass = -allpass2Coefficient_ * firstAllpass +
                allpassInput_[1] + allpass2Coefficient_ * allpassOutput_[1];
            allpassInput_[1] = firstAllpass;
            allpassOutput_[1] = secondAllpass;

            float outputSide = (highSide + decorrelation * (secondAllpass - highSide)) * width;
            // Widening is limited only when it would add a sample polarity
            // inversion relative to mid; intentional source width at unity or
            // narrower settings remains untouched.
            if (width > 1.0f && std::fabs(outputSide) > std::fabs(mid)) {
                outputSide = outputSide < 0.0f ? -std::fabs(mid) : std::fabs(mid);
            }
            const float wetLeft = mid + outputSide;
            const float wetRight = mid - outputSide;
            interleaved[offset] = inputLeft * mixGains.first + wetLeft * mixGains.second;
            interleaved[offset + 1U] = inputRight * mixGains.first + wetRight * mixGains.second;
        } else {
            // Keep causal state and parameter ramps coherent if a mono route
            // later becomes stereo without resetting its processor.
            lowSideState_ += lowMonoAlpha_ * (0.0f - lowSideState_);
            const float firstAllpass = allpassInput_[0] + allpass1Coefficient_ * allpassOutput_[0];
            allpassInput_[0] = 0.0f;
            allpassOutput_[0] = firstAllpass;
            const float secondAllpass = -allpass2Coefficient_ * firstAllpass +
                allpassInput_[1] + allpass2Coefficient_ * allpassOutput_[1];
            allpassInput_[1] = firstAllpass;
            allpassOutput_[1] = secondAllpass;
        }

        for (unsigned int channel = 0U; channel < std::min(channels, 2U); ++channel) {
            const float output = interleaved[offset + channel];
            peak = std::max(peak, std::fabs(output));
        }
    }
    return peak;
}

float NativeStereoEnhanceProcessor::allpassCoefficient(float frequencyHz) const noexcept {
    if (sampleRate_ == 0U) return 0.0f;
    const float frequency = std::clamp(frequencyHz, 20.0f, static_cast<float>(sampleRate_) * 0.45f);
    const double tangent = std::tan(3.14159265358979323846 * static_cast<double>(frequency) /
                                    static_cast<double>(sampleRate_));
    return static_cast<float>(std::clamp((tangent - 1.0) / (tangent + 1.0), -0.9995, 0.9995));
}

void NativeStereoEnhanceProcessor::updateLowMonoCoefficient(float cutoffHz) noexcept {
    if (sampleRate_ == 0U) return;
    const double cutoff = std::clamp(static_cast<double>(cutoffHz), 20.0,
                                     std::min(1000.0, static_cast<double>(sampleRate_) * 0.499));
    lowMonoAlpha_ = static_cast<float>(1.0 - std::exp(-kTwoPi * cutoff / static_cast<double>(sampleRate_)));
}

} // namespace webrc::native
