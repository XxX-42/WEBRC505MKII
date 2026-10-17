#include "native_reverse_delay_processor.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::native {
namespace {

constexpr std::array<float, 5U> kBeatOptions{{0.25f, 0.5f, 1.0f, 2.0f, 4.0f}};
constexpr float kBeatTolerance = 1.0e-6f;

} // namespace

bool NativeReverseDelayProcessor::validConfig(const NativeReverseDelayConfig& config) noexcept {
    if (!std::isfinite(config.bpm) || config.bpm < kMinimumBpm || config.bpm > kMaximumBpm ||
        !std::isfinite(config.segmentBeats) || !std::isfinite(config.feedbackPercent) ||
        !std::isfinite(config.crossfadeMs) || !std::isfinite(config.mixPercent) ||
        config.feedbackPercent < 0.0f || config.feedbackPercent > kMaxFeedbackPercent ||
        config.crossfadeMs < 1.0f || config.crossfadeMs > static_cast<float>(kMaxCrossfadeMs) ||
        config.mixPercent < 0.0f || config.mixPercent > kMaxMixPercent) {
        return false;
    }

    for (const float option : kBeatOptions) {
        if (std::fabs(config.segmentBeats - option) <= kBeatTolerance) return true;
    }
    return false;
}

bool NativeReverseDelayProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return false;

    const std::size_t maxFrames = static_cast<std::size_t>(sampleRate) * kMaxSegmentSeconds + 1U;
    const auto requestedQueueFrames = static_cast<std::size_t>(std::ceil(
        static_cast<double>(sampleRate) * static_cast<double>(kMaxCrossfadeMs) / 1000.0
    ));
    const std::size_t queueFrames = std::max<std::size_t>(1U, requestedQueueFrames);
    std::array<std::array<std::vector<float>, kChannelCount>, kSegmentBufferCount> newSegments{};
    std::array<std::vector<float>, kChannelCount> newWetDelay{};
    try {
        for (auto& segment : newSegments) {
            for (auto& channel : segment) channel.assign(maxFrames, 0.0f);
        }
        for (auto& channel : newWetDelay) channel.assign(queueFrames, 0.0f);
    } catch (const std::bad_alloc&) {
        return false;
    } catch (...) {
        return false;
    }

    segments_.swap(newSegments);
    wetDelay_.swap(newWetDelay);
    sampleRate_ = sampleRate;
    maxSegmentFrames_ = maxFrames;
    wetLookaheadFrames_ = queueFrames;
    reset();
    return true;
}

bool NativeReverseDelayProcessor::setConfig(
    const NativeReverseDelayConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!validConfig(config)) return false;

    pendingConfig_ = config;
    feedbackPercent_.setTarget(config.feedbackPercent, rampFrames);
    crossfadeMs_.setTarget(config.crossfadeMs, rampFrames);
    mixPercent_.setTarget(config.mixPercent, rampFrames);

    // Before the sample clock starts, take tempo and beat size immediately.
    // Once capture begins, those controls latch together at the next boundary.
    if (sampleRate_ != 0U && framesProcessed_ == 0U && captureFrames_ == 0U && !hasPlaybackSegment_) {
        activeConfig_ = pendingConfig_;
        activeSegmentFrames_ = segmentFramesFor(activeConfig_);
    }
    return true;
}

void NativeReverseDelayProcessor::reset() noexcept {
    captureFrames_ = 0U;
    playbackLength_ = 0U;
    playbackPosition_ = 0U;
    crossfadeFrames_ = 0U;
    wetDelayWriteIndex_ = 0U;
    captureBufferIndex_ = 0U;
    playbackBufferIndex_ = 0U;
    hasPlaybackSegment_ = false;
    playbackActive_ = false;
    framesProcessed_ = 0U;
    boundaryCount_ = 0U;
    activeConfig_ = pendingConfig_;
    activeSegmentFrames_ = segmentFramesFor(activeConfig_);
    feedbackPercent_.reset(pendingConfig_.feedbackPercent);
    crossfadeMs_.reset(pendingConfig_.crossfadeMs);
    mixPercent_.reset(pendingConfig_.mixPercent);
    for (auto& channel : wetDelay_) std::fill(channel.begin(), channel.end(), 0.0f);
}

float NativeReverseDelayProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U ||
        activeSegmentFrames_ == 0U || wetLookaheadFrames_ == 0U ||
        wetDelay_[0U].size() != wetLookaheadFrames_ || wetDelay_[1U].size() != wetLookaheadFrames_ ||
        static_cast<std::size_t>(frames) > std::numeric_limits<std::size_t>::max() / channels) {
        return 0.0f;
    }

    const unsigned int processedChannels = std::min<unsigned int>(channels, static_cast<unsigned int>(kChannelCount));
    const std::size_t channelStride = static_cast<std::size_t>(channels);
    float peak = 0.0f;

    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const std::size_t offset = static_cast<std::size_t>(frame) * channelStride;
        const float feedback = std::clamp(feedbackPercent_.next() * 0.01f, 0.0f, 0.95f);
        const float wetMix = std::clamp(mixPercent_.next() * 0.01f, 0.0f, 1.0f);
        std::array<float, kChannelCount> dry{};
        std::array<float, kChannelCount> generatedWet{};
        std::array<float, kChannelCount> delayedWet{};

        for (std::size_t channel = 0U; channel < kChannelCount; ++channel) {
            dry[channel] = channel < processedChannels
                ? finiteBounded(interleaved[offset + channel], kMaxCrossfadeSample)
                : 0.0f;
            generatedWet[channel] = renderPlaybackSample(static_cast<unsigned int>(channel));
            const float recorded = finiteBounded(dry[channel] + feedback * generatedWet[channel], kMaxCrossfadeSample);
            segments_[captureBufferIndex_][channel][captureFrames_] = recorded;
            auto& delay = wetDelay_[channel];
            delayedWet[channel] = delay[wetDelayWriteIndex_];
            delay[wetDelayWriteIndex_] = generatedWet[channel];
        }

        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            const float mixed = dry[channel] * (1.0f - wetMix) + delayedWet[channel] * wetMix;
            const float output = finiteBounded(mixed, kMaxOutputSample);
            interleaved[offset + channel] = output;
            peak = std::max(peak, std::fabs(output));
        }
        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            float passthrough = interleaved[offset + channel];
            if (!std::isfinite(passthrough)) {
                passthrough = 0.0f;
                interleaved[offset + channel] = 0.0f;
            }
            peak = std::max(peak, std::fabs(passthrough));
        }

        wetDelayWriteIndex_ = wetDelayWriteIndex_ + 1U == wetLookaheadFrames_ ? 0U : wetDelayWriteIndex_ + 1U;
        if (playbackActive_) {
            if (playbackPosition_ == 0U) {
                playbackActive_ = false;
            } else {
                --playbackPosition_;
            }
        }
        ++captureFrames_;
        if (framesProcessed_ != std::numeric_limits<std::uint64_t>::max()) ++framesProcessed_;
        if (captureFrames_ >= activeSegmentFrames_) completeCaptureSegment();
    }

    return peak;
}

NativeReverseDelayStatus NativeReverseDelayProcessor::status() const noexcept {
    return NativeReverseDelayStatus{
        sampleRate_,
        maxSegmentFrames_,
        activeSegmentFrames_,
        captureFrames_,
        playbackLength_,
        crossfadeFrames_,
        wetLookaheadFrames_,
        causalSegmentLatencyFrames(),
        framesProcessed_,
        boundaryCount_,
        hasPlaybackSegment_,
    };
}

std::size_t NativeReverseDelayProcessor::causalSegmentLatencyFrames() const noexcept {
    return activeSegmentFrames_ + wetLookaheadFrames_;
}

std::size_t NativeReverseDelayProcessor::segmentFramesFor(const NativeReverseDelayConfig& config) const noexcept {
    if (sampleRate_ == 0U || maxSegmentFrames_ == 0U) return 0U;
    const double rawFrames = 60.0 * static_cast<double>(sampleRate_) * static_cast<double>(config.segmentBeats) /
        static_cast<double>(config.bpm);
    if (!std::isfinite(rawFrames) || rawFrames <= 0.0) return 1U;
    return static_cast<std::size_t>(std::clamp(
        std::llround(rawFrames),
        1LL,
        static_cast<long long>(maxSegmentFrames_)
    ));
}

std::size_t NativeReverseDelayProcessor::requestedCrossfadeFrames(float crossfadeMs) const noexcept {
    if (sampleRate_ == 0U || wetLookaheadFrames_ == 0U) return 0U;
    const double rawFrames = static_cast<double>(sampleRate_) * static_cast<double>(crossfadeMs) / 1000.0;
    const auto rounded = static_cast<std::size_t>(std::max(1LL, std::llround(rawFrames)));
    return std::min(rounded, wetLookaheadFrames_);
}

float NativeReverseDelayProcessor::renderPlaybackSample(unsigned int channel) noexcept {
    if (!hasPlaybackSegment_ || !playbackActive_ || channel >= kChannelCount || playbackPosition_ >= playbackLength_) {
        return 0.0f;
    }
    return finiteBounded(segments_[playbackBufferIndex_][channel][playbackPosition_], kMaxCrossfadeSample);
}

void NativeReverseDelayProcessor::completeCaptureSegment() noexcept {
    const unsigned int completedBuffer = captureBufferIndex_;
    const std::size_t completedLength = captureFrames_;
    const bool hadPreviousSegment = hasPlaybackSegment_;
    const unsigned int previousPlaybackBuffer = playbackBufferIndex_;

    std::size_t fadeFrames = 0U;
    if (hadPreviousSegment && playbackLength_ != 0U && completedLength != 0U) {
        const std::size_t requested = requestedCrossfadeFrames(crossfadeMs_.target());
        fadeFrames = std::min(requested, std::min(playbackLength_, completedLength) / 2U);
        if (fadeFrames >= 2U) {
            for (std::size_t fadeIndex = 0U; fadeIndex < fadeFrames; ++fadeIndex) {
                const std::size_t queueOffset = wetLookaheadFrames_ - fadeFrames + fadeIndex;
                const std::size_t queueIndex = (wetDelayWriteIndex_ + queueOffset) % wetLookaheadFrames_;
                const float position = static_cast<float>(fadeIndex + 1U) / static_cast<float>(fadeFrames);
                const auto gains = dsp::equalPowerCrossfadeGains(position);
                const std::size_t incomingFrame = completedLength - 1U - fadeIndex;
                for (std::size_t channel = 0U; channel < kChannelCount; ++channel) {
                    const float outgoing = wetDelay_[channel][queueIndex];
                    const float incoming = segments_[completedBuffer][channel][incomingFrame];
                    wetDelay_[channel][queueIndex] = finiteBounded(
                        (outgoing * gains.first) + (incoming * gains.second),
                        kMaxOutputSample
                    );
                }
            }
        } else {
            fadeFrames = 0U;
        }
    }

    playbackBufferIndex_ = completedBuffer;
    playbackLength_ = completedLength;
    hasPlaybackSegment_ = completedLength != 0U;
    crossfadeFrames_ = fadeFrames;
    if (hasPlaybackSegment_) {
        // The first `fadeFrames` samples of the new reverse pass are already
        // represented in the delayed overlap, so continue after that head.
        playbackPosition_ = fadeFrames < completedLength
            ? completedLength - 1U - fadeFrames
            : completedLength - 1U;
        playbackActive_ = true;
    } else {
        playbackPosition_ = 0U;
        playbackActive_ = false;
    }

    captureBufferIndex_ = hadPreviousSegment ? previousPlaybackBuffer : 1U - completedBuffer;
    captureFrames_ = 0U;
    if (boundaryCount_ != std::numeric_limits<std::uint64_t>::max()) ++boundaryCount_;

    // Segment timing changes are sample-clocked and take effect at this edge.
    activeConfig_ = pendingConfig_;
    activeSegmentFrames_ = segmentFramesFor(activeConfig_);
}

float NativeReverseDelayProcessor::finiteBounded(float value, float magnitude) noexcept {
    return std::isfinite(value) ? std::clamp(value, -magnitude, magnitude) : 0.0f;
}

} // namespace webrc::native
