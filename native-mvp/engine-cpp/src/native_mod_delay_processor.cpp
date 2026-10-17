#include "native_mod_delay_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {
namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;
constexpr double kPi = 3.1415926535897932384626433832795;
constexpr double kRightPhaseOffset = kPi * 0.5;
constexpr float kFeedbackStabilityScale = 0.78f;

[[nodiscard]] float finiteBounded(float value, float maximumMagnitude) noexcept {
    return std::isfinite(value) ? std::clamp(value, -maximumMagnitude, maximumMagnitude) : 0.0f;
}

} // namespace

bool NativeModDelayProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) {
        return false;
    }

    const double maximumDelayWithExcursionMs =
        static_cast<double>(kMaximumDelayMs + kMaximumDepthMs);
    const auto maximumDelayFrames = static_cast<std::size_t>(std::ceil(
        maximumDelayWithExcursionMs * static_cast<double>(sampleRate) / 1000.0
    ));
    const std::size_t capacity = maximumDelayFrames + 4U;

    // Allocate replacement buffers before swapping, preserving a prior valid
    // preparation if a later sample-rate change cannot allocate its storage.
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

    delayBuffers_.swap(newBuffers);
    sampleRate_ = sampleRate;
    maximumDelayFrames_ = maximumDelayFrames;
    const double cutoffHz = std::min(8000.0, static_cast<double>(sampleRate) * 0.45);
    feedbackToneAlpha_ = static_cast<float>(1.0 - std::exp(-kTwoPi * cutoffHz / static_cast<double>(sampleRate)));
    reset();
    return true;
}

bool NativeModDelayProcessor::setConfig(
    const NativeModDelayProcessorConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!std::isfinite(config.rateHz) ||
        !std::isfinite(config.depthMs) || !std::isfinite(config.delayMs) ||
        !std::isfinite(config.feedback) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.05f || config.rateHz > kMaximumRateHz ||
        config.depthMs < 0.0f || config.depthMs > kMaximumDepthMs ||
        config.delayMs < kMinimumDelayMs || config.delayMs > kMaximumDelayMs ||
        config.feedback < 0.0f || config.feedback > kMaximumFeedback ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    config_ = config;
    rateHz_.setTarget(config.rateHz, rampFrames);
    depthMs_.setTarget(config.depthMs, rampFrames);
    delayMs_.setTarget(config.delayMs, rampFrames);
    feedback_.setTarget(config.feedback, rampFrames);
    wetMix_.setTarget(config.enabled ? config.wetMix : 0.0f, rampFrames);
    return true;
}

void NativeModDelayProcessor::reset() noexcept {
    for (auto& buffer : delayBuffers_) {
        std::fill(buffer.begin(), buffer.end(), 0.0f);
    }
    writeIndices_.fill(0U);
    feedbackFilterState_.fill(0.0f);
    leftPhase_ = 0.0;
    rateHz_.reset(config_.rateHz);
    depthMs_.reset(config_.depthMs);
    delayMs_.reset(config_.delayMs);
    feedback_.reset(config_.feedback);
    wetMix_.reset(config_.enabled ? config_.wetMix : 0.0f);
}

float NativeModDelayProcessor::processInPlace(
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
    float peak = 0.0f;

    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float baseDelayMs = delayMs_.next();
        const float requestedDepthMs = depthMs_.next();
        const float rate = rateHz_.next();
        const float feedback = feedback_.next() * kFeedbackStabilityScale;
        const float wetMix = std::clamp(wetMix_.next(), 0.0f, 1.0f);
        const float depthMs = std::max(0.0f, std::min({
            requestedDepthMs,
            baseDelayMs - kMinimumDelayMs,
            (kMaximumDelayMs + kMaximumDepthMs) - baseDelayMs,
        }));
        const std::size_t offset = static_cast<std::size_t>(frame) * static_cast<std::size_t>(channels);
        std::array<float, kChannels> dry{};
        std::array<float, kChannels> delayed{};

        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            dry[channel] = finiteBounded(interleaved[offset + channel], kMaximumStateMagnitude);
            const double phase = leftPhase_ + (channel == 0U ? 0.0 : kRightPhaseOffset);
            const double modulatedDelayMs = std::clamp(
                static_cast<double>(baseDelayMs) + static_cast<double>(depthMs) * std::sin(phase),
                static_cast<double>(kMinimumDelayMs),
                static_cast<double>(kMaximumDelayMs + kMaximumDepthMs)
            );
            const double delayFrames = std::clamp(
                modulatedDelayMs * sampleRate / 1000.0,
                2.0,
                static_cast<double>(maximumDelayFrames_)
            );
            delayed[channel] = finiteBounded(
                readFractionalDelay(delayBuffers_[channel], writeIndices_[channel], delayFrames),
                kMaximumStateMagnitude
            );
        }

        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            auto& buffer = delayBuffers_[channel];
            const std::size_t writeIndex = writeIndices_[channel];
            auto& filterState = feedbackFilterState_[channel];
            const float filtered = finiteBounded(
                filterState + feedbackToneAlpha_ * (delayed[channel] - filterState),
                kMaximumStateMagnitude
            );
            filterState = filtered;
            // Match Browser's Lagrange4 stability margin. tanh has slope at
            // most one and the scale remains below 1; the one-pole feedback
            // low-pass limits high-frequency repeat energy. Input, filter
            // state and stored state are bounded against hostile samples.
            const float writeSample = finiteBounded(
                dry[channel] + feedback * std::tanh(filtered),
                kMaximumStateMagnitude
            );
            buffer[writeIndex] = writeSample;
            const std::size_t next = writeIndex + 1U;
            writeIndices_[channel] = next == buffer.size() ? 0U : next;

            // Linear wet return is a bounded convex blend of sanitized dry
            // and delayed state, avoiding extra gain at the wet/dry midpoint.
            const float output = finiteBounded(
                dry[channel] * (1.0f - wetMix) + delayed[channel] * wetMix,
                kMaximumStateMagnitude
            );
            interleaved[offset + channel] = output;
            peak = std::max(peak, std::fabs(output));
        }

        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            const float passthrough = finiteBounded(interleaved[offset + channel], kMaximumStateMagnitude);
            interleaved[offset + channel] = passthrough;
            peak = std::max(peak, std::fabs(passthrough));
        }

        leftPhase_ += kTwoPi * static_cast<double>(rate) / sampleRate;
        if (leftPhase_ >= kTwoPi) {
            leftPhase_ -= kTwoPi;
        }
    }

    return peak;
}

float NativeModDelayProcessor::readFractionalDelay(
    const std::vector<float>& buffer,
    std::size_t writeIndex,
    double delayFrames
) const noexcept {
    const std::size_t capacity = buffer.size();
    if (capacity < 5U || maximumDelayFrames_ < 2U) {
        return 0.0f;
    }

    const double boundedDelay = std::clamp(
        delayFrames,
        2.0,
        static_cast<double>(maximumDelayFrames_)
    );
    const std::size_t integerDelay = static_cast<std::size_t>(boundedDelay);
    const float fraction = static_cast<float>(boundedDelay - static_cast<double>(integerDelay));
    const auto readAtDelay = [&buffer, capacity, writeIndex](std::size_t framesAgo) noexcept {
        const std::size_t wrappedAge = framesAgo % capacity;
        const std::size_t index = writeIndex + capacity - wrappedAge;
        return buffer[index >= capacity ? index - capacity : index];
    };
    return dsp::lagrange4(
        readAtDelay(integerDelay - 1U),
        readAtDelay(integerDelay),
        readAtDelay(integerDelay + 1U),
        readAtDelay(integerDelay + 2U),
        fraction
    );
}

} // namespace webrc::native
