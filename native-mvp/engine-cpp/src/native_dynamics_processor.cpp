#include "native_dynamics_processor.hpp"

#include <algorithm>
#include <cstddef>
#include <cmath>

namespace webrc::native {
namespace {

constexpr double kDbPerOctaveScale = 20.0;
constexpr double kMillisecondsToSeconds = 0.001;

[[nodiscard]] double dbToLinear(double db) noexcept {
    return std::pow(10.0, db / kDbPerOctaveScale);
}

} // namespace

bool NativeDynamicsProcessor::isValidDetector(NativeDynamicsDetector detector) noexcept {
    return detector == NativeDynamicsDetector::Peak || detector == NativeDynamicsDetector::Rms;
}

double NativeDynamicsProcessor::finiteInput(float sample) noexcept {
    return std::isfinite(sample) ? static_cast<double>(sample) : 0.0;
}

float NativeDynamicsProcessor::boundedOutput(double sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return static_cast<float>(std::clamp(sample, -kMaxOutputMagnitude, kMaxOutputMagnitude));
}

bool NativeDynamicsProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) {
        sampleRate_ = 0U;
        attackCoefficient_ = 0.0;
        releaseCoefficient_ = 0.0;
        return false;
    }

    sampleRate_ = sampleRate;
    updateDerivedParameters();
    reset();
    return true;
}

bool NativeDynamicsProcessor::setConfig(const NativeDynamicsConfig& config) noexcept {
    if (!std::isfinite(config.thresholdDb) || !std::isfinite(config.ratio) ||
        !std::isfinite(config.kneeDb) || !std::isfinite(config.attackMs) ||
        !std::isfinite(config.releaseMs) || !std::isfinite(config.outputGainDb) ||
        !isValidDetector(config.detector) || config.thresholdDb < -60.0f || config.thresholdDb > 0.0f ||
        config.ratio < 1.0f || config.ratio > 20.0f || config.kneeDb < 0.0f || config.kneeDb > 24.0f ||
        config.attackMs < 0.1f || config.attackMs > 100.0f ||
        config.releaseMs < 5.0f || config.releaseMs > 1000.0f ||
        config.outputGainDb < -24.0f || config.outputGainDb > 12.0f) {
        return false;
    }

    config_ = config;
    updateDerivedParameters();
    return true;
}

void NativeDynamicsProcessor::reset() noexcept {
    peakEnvelope_ = 0.0;
    rmsMeanSquare_ = 0.0;
}

void NativeDynamicsProcessor::updateDerivedParameters() noexcept {
    outputGainLinear_ = dbToLinear(static_cast<double>(config_.outputGainDb));
    if (sampleRate_ == 0U) {
        attackCoefficient_ = 0.0;
        releaseCoefficient_ = 0.0;
        return;
    }

    const double rate = static_cast<double>(sampleRate_);
    attackCoefficient_ = std::exp(-1.0 /
        (static_cast<double>(config_.attackMs) * kMillisecondsToSeconds * rate));
    releaseCoefficient_ = std::exp(-1.0 /
        (static_cast<double>(config_.releaseMs) * kMillisecondsToSeconds * rate));
}

double NativeDynamicsProcessor::updateDetector(double linkedMagnitude) noexcept {
    double envelope = 0.0;
    if (config_.detector == NativeDynamicsDetector::Rms) {
        const double power = linkedMagnitude * linkedMagnitude;
        const double coefficient = power > rmsMeanSquare_ ? attackCoefficient_ : releaseCoefficient_;
        rmsMeanSquare_ = coefficient * rmsMeanSquare_ + (1.0 - coefficient) * power;
        if (rmsMeanSquare_ < kDenormalFloor) rmsMeanSquare_ = 0.0;
        envelope = std::sqrt(std::max(0.0, rmsMeanSquare_));
    } else {
        const double coefficient = linkedMagnitude > peakEnvelope_ ? attackCoefficient_ : releaseCoefficient_;
        peakEnvelope_ = coefficient * peakEnvelope_ + (1.0 - coefficient) * linkedMagnitude;
        if (peakEnvelope_ < kDenormalFloor) peakEnvelope_ = 0.0;
        envelope = peakEnvelope_;
    }

    const double levelDb = kDbPerOctaveScale * std::log10(std::max(kEnvelopeFloor, envelope));
    const double thresholdDb = static_cast<double>(config_.thresholdDb);
    const double ratio = static_cast<double>(config_.ratio);
    const double kneeDb = static_cast<double>(config_.kneeDb);
    const double slope = (1.0 / ratio) - 1.0;
    double gainReductionDb = 0.0;

    if (kneeDb <= 1.0e-6) {
        if (levelDb > thresholdDb) gainReductionDb = slope * (levelDb - thresholdDb);
    } else {
        const double lowerKnee = thresholdDb - kneeDb * 0.5;
        const double upperKnee = thresholdDb + kneeDb * 0.5;
        if (levelDb >= upperKnee) {
            gainReductionDb = slope * (levelDb - thresholdDb);
        } else if (levelDb > lowerKnee) {
            const double kneePosition = levelDb - lowerKnee;
            gainReductionDb = slope * kneePosition * kneePosition / (2.0 * kneeDb);
        }
    }

    const double compressionGain = dbToLinear(gainReductionDb);
    return std::isfinite(compressionGain)
        ? std::clamp(compressionGain * outputGainLinear_, 0.0, kMaxGain)
        : 0.0;
}

float NativeDynamicsProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U) return 0.0f;

    float peak = 0.0f;
    const bool canProcess = sampleRate_ != 0U;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const auto offset = static_cast<std::size_t>(frame) * channels;
        const double inputLeft = finiteInput(interleaved[offset]);
        const double inputRight = channels >= 2U ? finiteInput(interleaved[offset + 1U]) : 0.0;
        const double linkedMagnitude = std::max(std::fabs(inputLeft), std::fabs(inputRight));
        const double gain = canProcess ? updateDetector(linkedMagnitude) : 1.0;

        interleaved[offset] = boundedOutput(inputLeft * gain);
        if (channels >= 2U) interleaved[offset + 1U] = boundedOutput(inputRight * gain);

        for (unsigned int channel = 0U; channel < channels; ++channel) {
            const auto sampleIndex = offset + channel;
            if (channel >= 2U) {
                // Extra channels bypass the compressor but still cannot carry
                // NaN/Inf through this finite-safe processor boundary.
                const double extra = finiteInput(interleaved[sampleIndex]);
                interleaved[sampleIndex] = boundedOutput(extra);
            }
            peak = std::max(peak, std::fabs(interleaved[sampleIndex]));
        }
    }
    return peak;
}

} // namespace webrc::native
