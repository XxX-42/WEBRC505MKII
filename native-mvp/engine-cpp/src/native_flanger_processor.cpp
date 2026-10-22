#include "native_flanger_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kTwoPi = 6.28318530717958647692;
constexpr unsigned int kMinimumSampleRate = 8000U;
constexpr unsigned int kMaximumSampleRate = 384000U;
constexpr double kFeedbackDampingHz = 6000.0;

} // namespace

bool NativeFlangerProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) {
        return false;
    }

    const auto maximumDelayFrames = static_cast<std::size_t>(std::ceil(
        static_cast<double>(kMaximumDelayMs) * static_cast<double>(sampleRate) / 1000.0
    ));
    const auto capacity = maximumDelayFrames + 4U;

    // Build replacement storage first so a failed allocation leaves an
    // already-prepared processor usable at its prior rate.
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
    const double dampingHz = std::min(kFeedbackDampingHz, static_cast<double>(sampleRate_) * 0.45);
    feedbackDampingAlpha_ = 1.0 - std::exp(
        -kTwoPi * dampingHz / static_cast<double>(sampleRate_)
    );
    reset();
    return true;
}

bool NativeFlangerProcessor::setConfig(
    const NativeFlangerProcessorConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!std::isfinite(config.delayMs) || !std::isfinite(config.rateHz) ||
        !std::isfinite(config.depth) || !std::isfinite(config.feedback) ||
        !std::isfinite(config.wetMix) ||
        config.delayMs < kMinimumDelayMs || config.delayMs > kMaximumDelayMs ||
        !std::isfinite(config.stepRateHz) || !std::isfinite(config.separation) ||
        !std::isfinite(config.directLevel) || !std::isfinite(config.effectLevel) ||
        config.stepRateHz < 0.0f || config.stepRateHz > 100.0f ||
        config.separation < 0.0f || config.separation > 1.0f ||
        config.directLevel < 0.0f || config.directLevel > 1.0f ||
        config.effectLevel < 0.0f || config.effectLevel > 1.0f ||
        config.rateHz < (config.officialControls ? 0.001f : 0.05f) ||
        config.rateHz > (config.officialControls ? 100.0f : 20.0f) ||
        config.depth < 0.0f || config.depth > 1.0f ||
        config.feedback < -kFeedbackLimit || config.feedback > kFeedbackLimit ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    config_ = config;
    stepRateHz_.setTarget(config.stepRateHz, rampFrames);
    separation_.setTarget(config.separation, rampFrames);
    directLevel_.setTarget(config.directLevel, rampFrames);
    effectLevel_.setTarget(config.effectLevel, rampFrames);
    delayMs_.setTarget(config.delayMs, rampFrames);
    rateHz_.setTarget(config.rateHz, rampFrames);
    depth_.setTarget(config.depth, rampFrames);
    feedback_.setTarget(config.feedback, rampFrames);
    wetMix_.setTarget(config.enabled ? config.wetMix : 0.0f, rampFrames);
    return true;
}

void NativeFlangerProcessor::reset() noexcept {
    for (auto& buffer : delayBuffers_) {
        std::fill(buffer.begin(), buffer.end(), 0.0f);
    }
    writeIndices_.fill(0U);
    feedbackStates_.fill(0.0f);
    stepPhase_ = 1.0;
    heldWaves_.fill(0.0);
    stepRateHz_.reset(config_.stepRateHz);
    separation_.reset(config_.separation);
    directLevel_.reset(config_.directLevel);
    effectLevel_.reset(config_.effectLevel);
    leftPhase_ = 0.0;
    rightPhase_ = kPi;
    delayMs_.reset(config_.delayMs);
    rateHz_.reset(config_.rateHz);
    depth_.reset(config_.depth);
    feedback_.reset(config_.feedback);
    wetMix_.reset(config_.enabled ? config_.wetMix : 0.0f);
}

float NativeFlangerProcessor::readFractionalDelay(
    const std::vector<float>& buffer,
    std::size_t writeIndex,
    double delayFrames
) const noexcept {
    const auto capacity = buffer.size();
    if (capacity < 4U || maximumDelayFrames_ < 2U) {
        return 0.0f;
    }

    const double boundedDelay = std::clamp(
        delayFrames,
        2.0,
        static_cast<double>(maximumDelayFrames_)
    );
    const auto integerDelay = static_cast<std::size_t>(boundedDelay);
    const float fraction = static_cast<float>(boundedDelay - static_cast<double>(integerDelay));
    const auto readAtDelay = [&buffer, capacity, writeIndex](std::size_t frames) noexcept {
        const std::size_t index = writeIndex + capacity - frames;
        return buffer[index >= capacity ? index - capacity : index];
    };

    // This is the same causal, backward-facing four-point Lagrange read used
    // by the other Native modulated-delay processor. At an integral delay the
    // selected tap is exact; the extra tap on the recent side remains causal
    // because the requested delay is clamped to at least two frames.
    return dsp::lagrange4(
        readAtDelay(integerDelay + 2U),
        readAtDelay(integerDelay + 1U),
        readAtDelay(integerDelay),
        readAtDelay(integerDelay - 1U),
        1.0f - fraction
    );
}

float NativeFlangerProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U ||
        delayBuffers_[0].empty() || delayBuffers_[1].empty()) {
        return 0.0f;
    }

    float peak = 0.0f;
    const auto processedChannels = std::min<unsigned int>(channels, static_cast<unsigned int>(kChannels));
    const auto capacity = delayBuffers_[0].size();

    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float baseDelayMs = delayMs_.next();
        const float rate = rateHz_.next();
        const float depth = depth_.next();
        const float feedback = feedback_.next();
        const float mix = wetMix_.next();
        const auto gains = dsp::equalPowerCrossfadeGains(mix);
        const float stepHz = stepRateHz_.next();
        const float separation = separation_.next();
        const float direct = directLevel_.next();
        const float effect = effectLevel_.next();
        const bool captureStep = stepHz <= 0.0f || stepPhase_ >= 1.0;
        if (stepPhase_ >= 1.0) stepPhase_ -= std::floor(stepPhase_);
        if (stepHz > 0.0f) stepPhase_ += static_cast<double>(stepHz) / sampleRate_;
        const std::size_t offset = static_cast<std::size_t>(frame) * channels;
        std::array<float, kChannels> dry{};
        std::array<float, kChannels> delayed{};

        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            const float input = interleaved[offset + channel];
            // Prevent non-finite input or an unusually hot sample from
            // poisoning feedback state or interpolation history.
            dry[channel] = std::isfinite(input) ? std::clamp(input, -kFeedbackStateLimit, kFeedbackStateLimit) : 0.0f;

            const double phase = channel == 0U ? leftPhase_ :
                (config_.officialControls ? leftPhase_ + kPi * separation : rightPhase_);
            if (captureStep) heldWaves_[channel] = std::sin(phase);
            const double excursionMs = static_cast<double>(depth) * static_cast<double>(kMaximumDepthMs);
            const double modulatedDelayMs = std::clamp(
                static_cast<double>(baseDelayMs) + excursionMs * heldWaves_[channel],
                static_cast<double>(kMinimumDelayMs),
                static_cast<double>(kMaximumDelayMs)
            );
            const double delayFrames = std::clamp(
                modulatedDelayMs * static_cast<double>(sampleRate_) / 1000.0,
                2.0,
                static_cast<double>(maximumDelayFrames_)
            );
            delayed[channel] = readFractionalDelay(
                delayBuffers_[channel],
                writeIndices_[channel],
                delayFrames
            );
        }

        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            auto& buffer = delayBuffers_[channel];
            const auto writeIndex = writeIndices_[channel];
            float filteredFeedback = feedbackStates_[channel] + static_cast<float>(feedbackDampingAlpha_) *
                (delayed[channel] - feedbackStates_[channel]);
            if (!std::isfinite(filteredFeedback)) {
                filteredFeedback = 0.0f;
            }
            filteredFeedback = std::clamp(filteredFeedback, -kFeedbackStateLimit, kFeedbackStateLimit);
            feedbackStates_[channel] = filteredFeedback;

            // Keep the limiter's small-signal slope at or below unity. With
            // the configured |feedback| <= 0.95 this guarantees a contractive
            // feedback loop instead of a self-sustaining tanh limit cycle.
            const float writeSample = dry[channel] + feedback * std::tanh(filteredFeedback);
            buffer[writeIndex] = std::isfinite(writeSample)
                ? std::clamp(writeSample, -kFeedbackStateLimit, kFeedbackStateLimit)
                : 0.0f;
            const std::size_t next = writeIndex + 1U;
            writeIndices_[channel] = next == capacity ? 0U : next;

            // The canonical flanger wet path is a feed-forward comb, while
            // feedback is confined to the write path. Equal-power crossfade
            // below then gives independent, well-defined dry/wet endpoints.
            const float wet = 0.5f * (dry[channel] + delayed[channel]);
            const float output = config_.officialControls && config_.enabled
                ? dry[channel] * direct + delayed[channel] * effect
                : (dry[channel] * gains.first) + (wet * gains.second);
            const float safeOutput = std::isfinite(output) ? output : 0.0f;
            interleaved[offset + channel] = safeOutput;
            peak = std::max(peak, std::fabs(safeOutput));
        }

        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            const float passthrough = interleaved[offset + channel];
            if (std::isfinite(passthrough)) {
                peak = std::max(peak, std::fabs(passthrough));
            }
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
