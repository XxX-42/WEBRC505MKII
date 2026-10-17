#include "native_tape_echo_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr unsigned int kMinimumSampleRate = 8000U;
constexpr unsigned int kMaximumSampleRate = 192000U;
constexpr double kMaximumTimeMs = 2000.0;
constexpr double kMaximumHeadScale = 3.0;
constexpr double kMaximumWowFraction = 0.004;
constexpr double kWowRateHz = 0.63;
constexpr double kFlutterRateHz = 6.1;
constexpr float kUnityDriveTanhSlope = 1.0f / 0.76159416f;
constexpr float kFeedbackStabilityMargin = 0.97f;
constexpr float kMaximumInputMagnitude = 8.0f;

[[nodiscard]] float finiteBounded(float value, float maximumMagnitude) noexcept {
    return std::isfinite(value) ? std::clamp(value, -maximumMagnitude, maximumMagnitude) : 0.0f;
}

[[nodiscard]] NativeDistortionConfig saturationConfig(float saturationPercent) noexcept {
    const float saturation = std::clamp(saturationPercent, 0.0f, 100.0f);
    // Use the reusable 4x processor's mildest tanh setting and let the tape
    // control blend it in. Its small-signal slope is known and compensated in
    // the feedback coefficient below, keeping the recirculating loop contractive.
    return NativeDistortionConfig{
        0.0f,
        saturation
    };
}

} // namespace

bool NativeTapeEchoProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) {
        return false;
    }

    // Reserve enough history for the 3x head at the maximum delay and full
    // proportional wow excursion, plus interpolation taps and a guard frame.
    const double maximumDelayMs = kMaximumTimeMs * kMaximumHeadScale * (1.0 + kMaximumWowFraction);
    const auto maximumDelayFrames = static_cast<std::size_t>(std::ceil(
        maximumDelayMs * static_cast<double>(sampleRate) / 1000.0
    ));
    const std::size_t capacity = maximumDelayFrames + 4U;

    std::array<std::vector<float>, kChannels> newBuffers{};
    try {
        for (auto& buffer : newBuffers) {
            buffer.assign(capacity, 0.0f);
        }
    } catch (const std::bad_alloc&) {
        return false;
    } catch (...) {
        return false;
    }

    // The 4x saturator accepts this same rate range and has fixed storage.
    if (!saturation_.prepare(sampleRate)) {
        return false;
    }

    delayBuffers_.swap(newBuffers);
    sampleRate_ = sampleRate;
    if (!saturation_.setConfig(saturationConfig(config_.saturationPercent), 0U)) {
        // Validated descriptor values always map to a valid NativeDistortion
        // configuration. This branch is a defensive guard for future edits.
        return false;
    }
    reset();
    return true;
}

bool NativeTapeEchoProcessor::setConfig(
    const NativeTapeEchoProcessorConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!std::isfinite(config.timeMs) || !std::isfinite(config.feedbackPercent) ||
        !std::isfinite(config.wowFlutterPercent) || !std::isfinite(config.saturationPercent) ||
        !std::isfinite(config.toneHz) || !std::isfinite(config.mixPercent) ||
        config.timeMs < kMinimumTimeMs || config.timeMs > kMaximumTimeMs ||
        config.feedbackPercent < 0.0f || config.feedbackPercent > kMaximumFeedbackPercent ||
        config.wowFlutterPercent < 0.0f || config.wowFlutterPercent > kMaximumWowFlutterPercent ||
        config.saturationPercent < 0.0f || config.saturationPercent > kMaximumSaturationPercent ||
        config.toneHz < kMinimumToneHz || config.toneHz > kMaximumToneHz ||
        config.mixPercent < 0.0f || config.mixPercent > kMaximumMixPercent) {
        return false;
    }

    if (!saturation_.setConfig(saturationConfig(config.saturationPercent), rampFrames)) {
        return false;
    }

    config_ = config;
    timeMs_.setTarget(config.timeMs, rampFrames);
    feedbackPercent_.setTarget(config.feedbackPercent, rampFrames);
    wowFlutterPercent_.setTarget(config.wowFlutterPercent, rampFrames);
    saturationPercent_.setTarget(config.saturationPercent, rampFrames);
    if (sampleRate_ != 0U) {
        toneAlpha_.setTarget(coefficientForTone(config.toneHz, sampleRate_), rampFrames);
    }
    mixPercent_.setTarget(config.enabled ? config.mixPercent : 0.0f, rampFrames);
    return true;
}

void NativeTapeEchoProcessor::reset() noexcept {
    for (auto& buffer : delayBuffers_) {
        std::fill(buffer.begin(), buffer.end(), 0.0f);
    }
    writeIndices_.fill(0U);
    feedbackToneStates_.fill(0.0f);
    wowPhases_.fill(0.0);
    flutterPhases_.fill(kPi * 0.5);
    timeMs_.reset(config_.timeMs);
    feedbackPercent_.reset(config_.feedbackPercent);
    wowFlutterPercent_.reset(config_.wowFlutterPercent);
    saturationPercent_.reset(config_.saturationPercent);
    mixPercent_.reset(config_.enabled ? config_.mixPercent : 0.0f);
    if (sampleRate_ != 0U) {
        toneAlpha_.reset(coefficientForTone(config_.toneHz, sampleRate_));
    }
    saturation_.reset();
}

float NativeTapeEchoProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U ||
        delayBuffers_[0].empty() || delayBuffers_[1].empty()) {
        return 0.0f;
    }

    const unsigned int processedChannels = std::min<unsigned int>(channels, static_cast<unsigned int>(kChannels));
    const double sampleRate = static_cast<double>(sampleRate_);
    const double wowPhaseIncrement = kTwoPi * kWowRateHz / sampleRate;
    const double flutterPhaseIncrement = kTwoPi * kFlutterRateHz / sampleRate;
    float peak = 0.0f;

    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float baseTimeMs = timeMs_.next();
        const float requestedFeedback = std::clamp(feedbackPercent_.next() * 0.01f, 0.0f, 0.95f);
        const float wowAmount = std::clamp(wowFlutterPercent_.next() * 0.01f, 0.0f, 1.0f);
        const float saturationAmount = std::clamp(saturationPercent_.next() * 0.01f, 0.0f, 1.0f);
        const float saturationSlopeBound = 1.0f + saturationAmount * (kUnityDriveTanhSlope - 1.0f);
        const float feedback = requestedFeedback * kFeedbackStabilityMargin / saturationSlopeBound;
        const float toneAlpha = std::clamp(toneAlpha_.next(), 0.0f, 1.0f);
        const float wetMix = std::clamp(mixPercent_.next() * 0.01f, 0.0f, 1.0f);
        const std::size_t offset = static_cast<std::size_t>(frame) * static_cast<std::size_t>(channels);
        std::array<float, kChannels> dry{};
        std::array<float, kChannels> recordInput{};
        std::array<std::array<float, kHeadCount>, kChannels> heads{};

        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            dry[channel] = finiteBounded(interleaved[offset + channel], kMaximumInputMagnitude);
            const double lfo =
                0.75 * std::sin(wowPhases_[channel]) +
                0.25 * std::sin(flutterPhases_[channel]);

            for (std::size_t head = 0U; head < kHeadCount; ++head) {
                const double headScale = static_cast<double>(head + 1U);
                const double headTimeMs = static_cast<double>(baseTimeMs) * headScale;
                const double modulationMs = headTimeMs * kMaximumWowFraction *
                    static_cast<double>(wowAmount) * lfo;
                const double delayFrames = std::clamp(
                    (headTimeMs + modulationMs) * sampleRate / 1000.0,
                    2.0,
                    static_cast<double>(delayBuffers_[channel].size() - 3U)
                );
                heads[channel][head] = readFractionalDelay(
                    delayBuffers_[channel],
                    writeIndices_[channel],
                    delayFrames
                );
            }

            float filteredFeedback = feedbackToneStates_[channel] + toneAlpha *
                (heads[channel][0U] - feedbackToneStates_[channel]);
            filteredFeedback = finiteBounded(filteredFeedback, kMaximumStateMagnitude);
            feedbackToneStates_[channel] = filteredFeedback;
            recordInput[channel] = finiteBounded(
                dry[channel] + feedback * filteredFeedback,
                kMaximumStateMagnitude
            );
        }

        // The reusable NativeDistortion processor performs the clean-room 4x
        // oversampled tanh record/repro path. Its fixed 24-frame latency is
        // documented above and is included in the echo's actual arrival time.
        (void)saturation_.processInPlace(recordInput.data(), 1U, processedChannels);

        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            auto& buffer = delayBuffers_[channel];
            const std::size_t writeIndex = writeIndices_[channel];
            buffer[writeIndex] = finiteBounded(recordInput[channel], kMaximumStateMagnitude);
            const std::size_t next = writeIndex + 1U;
            writeIndices_[channel] = next == buffer.size() ? 0U : next;

            const float wet = 0.55f * heads[channel][0U] +
                              0.30f * heads[channel][1U] +
                              0.15f * heads[channel][2U];
            const float mixed = dry[channel] * (1.0f - wetMix) + wet * wetMix;
            const float output = finiteBounded(mixed, kMaximumStateMagnitude);
            interleaved[offset + channel] = output;
            peak = std::max(peak, std::fabs(output));
        }

        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            float passthrough = interleaved[offset + channel];
            if (!std::isfinite(passthrough)) {
                passthrough = 0.0f;
                interleaved[offset + channel] = passthrough;
            }
            peak = std::max(peak, std::fabs(passthrough));
        }

        for (std::size_t channel = 0U; channel < kChannels; ++channel) {
            wowPhases_[channel] += wowPhaseIncrement;
            flutterPhases_[channel] += flutterPhaseIncrement;
            if (wowPhases_[channel] >= kTwoPi) wowPhases_[channel] -= kTwoPi;
            if (flutterPhases_[channel] >= kTwoPi) flutterPhases_[channel] -= kTwoPi;
        }
    }

    return peak;
}

float NativeTapeEchoProcessor::coefficientForTone(float toneHz, unsigned int sampleRate) noexcept {
    if (sampleRate == 0U) return 0.0f;
    const double nyquistGuard = static_cast<double>(sampleRate) * 0.45;
    const double cutoff = std::clamp(
        static_cast<double>(toneHz),
        static_cast<double>(kMinimumToneHz),
        nyquistGuard
    );
    return static_cast<float>(1.0 - std::exp(-kTwoPi * cutoff / static_cast<double>(sampleRate)));
}

float NativeTapeEchoProcessor::readFractionalDelay(
    const std::vector<float>& buffer,
    std::size_t writeIndex,
    double delayFrames
) const noexcept {
    const std::size_t capacity = buffer.size();
    if (capacity < 5U) return 0.0f;

    const double boundedDelay = std::clamp(
        delayFrames,
        2.0,
        static_cast<double>(capacity - 3U)
    );
    const auto integerDelay = static_cast<std::size_t>(boundedDelay);
    const float fraction = static_cast<float>(boundedDelay - static_cast<double>(integerDelay));
    const auto readAtDelay = [&buffer, capacity, writeIndex](std::size_t framesAgo) noexcept {
        std::size_t index = writeIndex + capacity - framesAgo;
        if (index >= capacity) index -= capacity;
        return buffer[index];
    };

    // Cubic Lagrange interpolation between ages N and N+1 gives a truly
    // variable fractional tap while only reading history (no future samples).
    return dsp::lagrange4(
        readAtDelay(integerDelay - 1U),
        readAtDelay(integerDelay),
        readAtDelay(integerDelay + 1U),
        readAtDelay(integerDelay + 2U),
        fraction
    );
}

} // namespace webrc::native
