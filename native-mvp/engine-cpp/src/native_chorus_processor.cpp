#include "native_chorus_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {

namespace {

constexpr double kTwoPi = 6.28318530717958647692;
constexpr double kQuarterTurn = 1.57079632679489661923;

} // namespace

bool NativeChorusProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) {
        return false;
    }

    try {
        maximumDelayFrames_ = static_cast<std::size_t>(std::max(
            2.0,
            std::round((static_cast<double>(kCenterDelayMs + kMaximumDepthMs) *
                static_cast<double>(sampleRate)) / 1000.0)
        ));
        const auto capacity = maximumDelayFrames_ + 4U;
        for (auto& buffer : delayBuffers_) {
            buffer.assign(capacity, 0.0f);
        }
    } catch (const std::bad_alloc&) {
        sampleRate_ = 0U;
        return false;
    } catch (...) {
        sampleRate_ = 0U;
        return false;
    }

    sampleRate_ = sampleRate;
    writeIndices_.fill(0U);
    leftPhase_ = 0.0;
    rightPhase_ = kQuarterTurn;
    rateHz_.reset(config_.rateHz);
    depthMs_.reset(config_.depthMs);
    feedback_.reset(config_.feedback);
    wetMix_.reset(config_.enabled ? config_.wetMix : 0.0f);
    return true;
}

bool NativeChorusProcessor::setConfig(const ChorusProcessorConfig& config, std::uint64_t rampFrames) noexcept {
    if (!std::isfinite(config.rateHz) || !std::isfinite(config.depthMs) ||
        !std::isfinite(config.feedback) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.1f || config.rateHz > 8.0f ||
        config.depthMs < 0.0f || config.depthMs > kMaximumDepthMs ||
        config.feedback < 0.0f || config.feedback > 0.95f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    config_ = config;
    rateHz_.setTarget(config.rateHz, rampFrames);
    depthMs_.setTarget(config.depthMs, rampFrames);
    feedback_.setTarget(config.feedback, rampFrames);
    wetMix_.setTarget(config.enabled ? config.wetMix : 0.0f, rampFrames);
    return true;
}

float NativeChorusProcessor::readFractionalDelay(
    const std::vector<float>& buffer,
    std::size_t writeIndex,
    double delayFrames
) const noexcept {
    const auto capacity = buffer.size();
    const double boundedDelay = std::clamp(delayFrames, 2.0, static_cast<double>(maximumDelayFrames_));
    const auto integerDelay = static_cast<std::size_t>(boundedDelay);
    const float fraction = static_cast<float>(boundedDelay - static_cast<double>(integerDelay));
    const float position = 1.0f - fraction;
    const auto readAtDelay = [&buffer, capacity, writeIndex](std::size_t frames) noexcept {
        const std::size_t index = writeIndex + capacity - frames;
        return buffer[index >= capacity ? index - capacity : index];
    };
    return dsp::lagrange4(
        readAtDelay(integerDelay + 2U),
        readAtDelay(integerDelay + 1U),
        readAtDelay(integerDelay),
        readAtDelay(integerDelay - 1U),
        position
    );
}

float NativeChorusProcessor::processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) {
        return 0.0f;
    }

    float peak = 0.0f;
    const auto processedChannels = std::min<unsigned int>(channels, static_cast<unsigned int>(kChannels));
    const auto capacity = delayBuffers_[0].size();
    for (unsigned int frame = 0; frame < frames; ++frame) {
        const float rate = rateHz_.next();
        const double depthFrames = static_cast<double>(depthMs_.next()) * static_cast<double>(sampleRate_) / 1000.0;
        const float feedback = feedback_.next();
        const float mix = wetMix_.next();
        const auto gains = dsp::equalPowerCrossfadeGains(mix);
        const double baseDelayFrames = static_cast<double>(kCenterDelayMs) * static_cast<double>(sampleRate_) / 1000.0;
        const std::size_t offset = static_cast<std::size_t>(frame) * channels;
        std::array<float, kChannels> input{};
        std::array<float, kChannels> delayed{};
        for (unsigned int channel = 0; channel < processedChannels; ++channel) {
            input[channel] = interleaved[offset + channel];
            const double phase = channel == 0U ? leftPhase_ : rightPhase_;
            const double delay = baseDelayFrames + depthFrames * std::sin(phase);
            delayed[channel] = readFractionalDelay(delayBuffers_[channel], writeIndices_[channel], delay);
        }

        for (unsigned int channel = 0; channel < processedChannels; ++channel) {
            auto& buffer = delayBuffers_[channel];
            const std::size_t writeIndex = writeIndices_[channel];
            buffer[writeIndex] = input[channel] + (feedback * delayed[channel]);
            const std::size_t next = writeIndex + 1U;
            writeIndices_[channel] = next == capacity ? 0U : next;
            const float output = (input[channel] * gains.first) + (delayed[channel] * gains.second);
            interleaved[offset + channel] = output;
            peak = std::max(peak, std::fabs(output));
        }

        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            peak = std::max(peak, std::fabs(interleaved[offset + channel]));
        }
        const double phaseIncrement = kTwoPi * static_cast<double>(rate) / static_cast<double>(sampleRate_);
        leftPhase_ += phaseIncrement;
        rightPhase_ += phaseIncrement;
        if (leftPhase_ >= kTwoPi) {
            leftPhase_ -= kTwoPi;
        }
        if (rightPhase_ >= kTwoPi) {
            rightPhase_ -= kTwoPi;
        }
    }
    return peak;
}

} // namespace webrc::native
