#include "native_distortion_processor.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace webrc::native {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kCutoffCyclesPerOversample = 0.118;
constexpr float kMaxFiniteInput = 16.0f;

[[nodiscard]] float finiteBoundedInput(float value) noexcept {
    return std::isfinite(value) ? std::clamp(value, -kMaxFiniteInput, kMaxFiniteInput) : 0.0f;
}

[[nodiscard]] float gainForDriveDb(float driveDb) noexcept {
    return static_cast<float>(std::pow(10.0, static_cast<double>(driveDb) / 20.0));
}

[[nodiscard]] float makeupForDrive(float driveGain) noexcept {
    const double drive = static_cast<double>(driveGain);
    const double denominator = std::tanh(drive);
    return denominator > 0.0 ? static_cast<float>(1.0 / denominator) : 1.0f;
}

} // namespace

bool NativeDistortionProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U || sampleRate > 192000U) return false;
    sampleRate_ = sampleRate;
    designFilters();
    reset();
    return true;
}

bool NativeDistortionProcessor::setConfig(
    const NativeDistortionConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!std::isfinite(config.driveDb) || !std::isfinite(config.mixPercent) ||
        config.driveDb < 0.0f || config.driveDb > 36.0f ||
        config.mixPercent < 0.0f || config.mixPercent > 100.0f) {
        return false;
    }

    config_ = config;
    const float driveGain = gainForDriveDb(config.driveDb);
    driveGain_.setTarget(driveGain, rampFrames);
    makeupGain_.setTarget(makeupForDrive(driveGain), rampFrames);
    mix_.setTarget(config.mixPercent * 0.01f, rampFrames);
    return true;
}

void NativeDistortionProcessor::reset() noexcept {
    if (sampleRate_ == 0U) return;
    for (auto& state : channels_) {
        state.inputHistory.fill(0.0f);
        state.reconstructionHistory.fill(0.0f);
        state.dryDelay.fill(0.0f);
        state.inputWrite = 0U;
        state.reconstructionWrite = 0U;
        state.dryWrite = 0U;
    }
    const float driveGain = gainForDriveDb(config_.driveDb);
    driveGain_.reset(driveGain);
    makeupGain_.reset(makeupForDrive(driveGain));
    mix_.reset(config_.mixPercent * 0.01f);
}

float NativeDistortionProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) return 0.0f;

    float peak = 0.0f;
    for (unsigned int frameIndex = 0U; frameIndex < frames; ++frameIndex) {
        const std::size_t offset = static_cast<std::size_t>(frameIndex) * channels;
        const float driveGain = driveGain_.next();
        const float makeupGain = makeupGain_.next();
        const float wetMix = mix_.next();
        const float leftInput = finiteBoundedInput(interleaved[offset]);
        float delayedDryLeft = 0.0f;
        const float wetLeft = processSample(0U, leftInput, driveGain, makeupGain, delayedDryLeft);
        float outputLeft = wetMix <= 0.0f ? delayedDryLeft :
            (wetMix >= 1.0f ? wetLeft : delayedDryLeft * (1.0f - wetMix) + wetLeft * wetMix);
        if (!std::isfinite(outputLeft)) outputLeft = 0.0f;
        interleaved[offset] = outputLeft;
        peak = std::max(peak, std::fabs(outputLeft));

        if (channels >= 2U) {
            const float rightInput = finiteBoundedInput(interleaved[offset + 1U]);
            float delayedDryRight = 0.0f;
            const float wetRight = processSample(1U, rightInput, driveGain, makeupGain, delayedDryRight);
            float outputRight = wetMix <= 0.0f ? delayedDryRight :
                (wetMix >= 1.0f ? wetRight : delayedDryRight * (1.0f - wetMix) + wetRight * wetMix);
            if (!std::isfinite(outputRight)) outputRight = 0.0f;
            interleaved[offset + 1U] = outputRight;
            peak = std::max(peak, std::fabs(outputRight));
        } else {
            // Keep the unused right-channel history settled if the caller later
            // changes from mono to stereo without resetting the processor.
            float ignoredDry = 0.0f;
            (void)processSample(1U, 0.0f, driveGain, makeupGain, ignoredDry);
        }
    }
    return peak;
}

float NativeDistortionProcessor::processSample(
    unsigned int channel,
    float input,
    float driveGain,
    float makeupGain,
    float& delayedDry
) noexcept {
    auto& state = channels_[channel];
    const float safeInput = finiteBoundedInput(input);
    delayedDry = state.dryDelay[state.dryWrite];
    state.dryDelay[state.dryWrite] = safeInput;
    ++state.dryWrite;
    if (state.dryWrite == kLatencyFrames) state.dryWrite = 0U;

    state.inputHistory[state.inputWrite] = safeInput;
    float output = 0.0f;
    for (unsigned int phase = 0U; phase < kOversampling; ++phase) {
        const float oversampled = interpolate(channel, phase);
        const float preShaped = std::clamp(oversampled * driveGain, -64.0f, 64.0f);
        const float shaped = std::tanh(preShaped) * makeupGain;
        const float reconstructed = reconstruct(
            channel,
            std::isfinite(shaped) ? shaped : 0.0f,
            phase == 0U
        );
        if (phase == 0U) output = reconstructed;
    }

    ++state.inputWrite;
    if (state.inputWrite == kPolyphaseTaps) state.inputWrite = 0U;
    return std::isfinite(output) ? std::clamp(output, -4.0f, 4.0f) : 0.0f;
}

float NativeDistortionProcessor::interpolate(unsigned int channel, unsigned int phase) const noexcept {
    const auto& state = channels_[channel];
    unsigned int historyIndex = state.inputWrite;
    float sum = 0.0f;
    for (unsigned int tap = phase; tap < kFirTaps; tap += kOversampling) {
        sum += interpolationTaps_[tap] * state.inputHistory[historyIndex];
        if (historyIndex == 0U) historyIndex = kPolyphaseTaps - 1U;
        else --historyIndex;
    }
    return std::isfinite(sum) ? std::clamp(sum, -kMaxFiniteInput, kMaxFiniteInput) : 0.0f;
}

float NativeDistortionProcessor::reconstruct(unsigned int channel, float sample, bool computeOutput) noexcept {
    auto& state = channels_[channel];
    state.reconstructionHistory[state.reconstructionWrite] = sample;

    float sum = 0.0f;
    if (computeOutput) {
        unsigned int historyIndex = state.reconstructionWrite;
        for (unsigned int tap = 0U; tap < kFirTaps; ++tap) {
            sum += reconstructionTaps_[tap] * state.reconstructionHistory[historyIndex];
            if (historyIndex == 0U) historyIndex = kFirTaps - 1U;
            else --historyIndex;
        }
    }

    ++state.reconstructionWrite;
    if (state.reconstructionWrite == kFirTaps) state.reconstructionWrite = 0U;
    return std::isfinite(sum) ? sum : 0.0f;
}

void NativeDistortionProcessor::designFilters() noexcept {
    // A Blackman-windowed sinc low-pass at 0.118 cycles per high-rate sample
    // (94.4% of the original-rate Nyquist). The same prototype is normalized
    // for interpolation gain (4) and reconstruction gain (1), respectively.
    const double center = static_cast<double>(kFirTaps - 1U) * 0.5;
    const double cutoff = kCutoffCyclesPerOversample;
    double rawSum = 0.0;
    for (unsigned int tap = 0U; tap < kFirTaps; ++tap) {
        const double position = static_cast<double>(tap) - center;
        const double ideal = position == 0.0
            ? 2.0 * cutoff
            : std::sin(kTwoPi * cutoff * position) / (kPi * position);
        const double normalizedPosition = static_cast<double>(tap) / static_cast<double>(kFirTaps - 1U);
        const double window = 0.42 - 0.5 * std::cos(kTwoPi * normalizedPosition) +
                              0.08 * std::cos(2.0 * kTwoPi * normalizedPosition);
        const double coefficient = ideal * window;
        interpolationTaps_[tap] = static_cast<float>(coefficient);
        rawSum += coefficient;
    }

    if (rawSum == 0.0 || !std::isfinite(rawSum)) {
        interpolationTaps_.fill(0.0f);
        reconstructionTaps_.fill(0.0f);
        interpolationTaps_[(kFirTaps - 1U) / 2U] = static_cast<float>(kOversampling);
        reconstructionTaps_[(kFirTaps - 1U) / 2U] = 1.0f;
        return;
    }

    for (unsigned int tap = 0U; tap < kFirTaps; ++tap) {
        const float unityCoefficient = interpolationTaps_[tap] / static_cast<float>(rawSum);
        reconstructionTaps_[tap] = unityCoefficient;
        interpolationTaps_[tap] = unityCoefficient * static_cast<float>(kOversampling);
    }

    // Equalize DC gain in each polyphase branch. The symmetrical prototype
    // keeps group delay and passband phase matched while preventing four-phase
    // DC ripple from the finite window.
    for (unsigned int phase = 0U; phase < kOversampling; ++phase) {
        double phaseSum = 0.0;
        for (unsigned int tap = phase; tap < kFirTaps; tap += kOversampling) {
            phaseSum += interpolationTaps_[tap];
        }
        if (std::fabs(phaseSum) < 1.0e-12) continue;
        const float correction = static_cast<float>(1.0 / phaseSum);
        for (unsigned int tap = phase; tap < kFirTaps; tap += kOversampling) {
            interpolationTaps_[tap] *= correction;
        }
    }
}

} // namespace webrc::native
