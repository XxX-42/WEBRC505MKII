#include "native_beat_repeat_processor.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::native {

namespace {

constexpr std::array<float, 5U> kBeatDivisions{{0.25f, 0.5f, 1.0f, 2.0f, 4.0f}};
constexpr float kDivisionTolerance = 1.0e-6f;

[[nodiscard]] float finiteSample(float sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return std::clamp(sample, -64.0f, 64.0f);
}

[[nodiscard]] float boundedOutput(double sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return static_cast<float>(std::clamp(sample, -64.0, 64.0));
}

} // namespace

bool NativeBeatRepeatProcessor::validDirection(NativeBeatRepeatDirection direction) noexcept {
    return direction == NativeBeatRepeatDirection::Forward ||
        direction == NativeBeatRepeatDirection::Reverse ||
        direction == NativeBeatRepeatDirection::Alternate;
}

bool NativeBeatRepeatProcessor::validConfig(const NativeBeatRepeatConfig& config) noexcept {
    if (!std::isfinite(config.bpm) || config.bpm < kMinimumBpm || config.bpm > kMaximumBpm ||
        !std::isfinite(config.division) || !std::isfinite(config.decay) ||
        config.decay < 0.0f || config.decay > 100.0f ||
        !std::isfinite(config.wetMix) || config.wetMix < 0.0f || config.wetMix > 1.0f ||
        !validDirection(config.direction)) {
        return false;
    }

    for (const float option : kBeatDivisions) {
        if (std::fabs(config.division - option) <= kDivisionTolerance) return true;
    }
    return false;
}

bool NativeBeatRepeatProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return false;

    const auto sliceFrames = static_cast<std::size_t>(sampleRate) * kSliceCapacitySeconds + 2U;
    std::array<std::array<std::vector<float>, 2U>, 2U> replacement{};
    try {
        for (auto& bank : replacement) {
            for (auto& channel : bank) channel.assign(sliceFrames, 0.0f);
        }
    } catch (const std::bad_alloc&) {
        return false;
    } catch (...) {
        return false;
    }

    buffers_.swap(replacement);
    sampleRate_ = sampleRate;
    maxSliceFrames_ = sliceFrames;
    reset();
    return true;
}

bool NativeBeatRepeatProcessor::setConfig(
    const NativeBeatRepeatConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!validConfig(config)) return false;
    pendingConfig_ = config;
    activeConfig_.wetMix = config.wetMix;
    // Before the sample clock starts there is no partial slice to protect, so
    // the first interval uses the configured transport and division directly.
    if (sampleRate_ != 0U && framesProcessed_ == 0U && !hasSlice_) {
        activeConfig_ = pendingConfig_;
        framesUntilBoundary_ = intervalFrames(activeConfig_);
    }
    wetMix_.setTarget(config.wetMix, rampFrames);
    return true;
}

void NativeBeatRepeatProcessor::reset() noexcept {
    captureFrames_ = 0U;
    playbackLength_ = 0U;
    playbackPosition_ = 0U;
    captureBufferIndex_ = 0U;
    playbackBufferIndex_ = -1;
    directionReverse_ = false;
    hasSlice_ = false;
    repeatGain_ = 1.0f;
    framesProcessed_ = 0U;
    boundaryCount_ = 0U;
    lastBoundaryFrame_ = -1;
    activeConfig_ = pendingConfig_;
    framesUntilBoundary_ = intervalFrames(activeConfig_);
    wetMix_.reset(pendingConfig_.wetMix);
}

unsigned int NativeBeatRepeatProcessor::intervalFrames(const NativeBeatRepeatConfig& config) const noexcept {
    if (sampleRate_ == 0U || maxSliceFrames_ == 0U) return 0U;
    const double rawFrames = (60.0 * static_cast<double>(sampleRate_) * static_cast<double>(config.division)) /
        static_cast<double>(config.bpm);
    if (!std::isfinite(rawFrames) || rawFrames <= 0.0) return 1U;
    const double boundedFrames = std::clamp(rawFrames, 1.0, static_cast<double>(maxSliceFrames_));
    return static_cast<unsigned int>(std::lround(boundedFrames));
}

std::size_t NativeBeatRepeatProcessor::crossfadeFrames(std::size_t sliceFrames) const noexcept {
    if (sampleRate_ == 0U || sliceFrames < 2U) return 0U;
    const auto sampleRateFade = static_cast<std::size_t>(std::lround(static_cast<double>(sampleRate_) * 0.005));
    return std::min(sliceFrames / 2U, std::max<std::size_t>(1U, sampleRateFade));
}

bool NativeBeatRepeatProcessor::isAtLoopTail(std::size_t readIndex, std::size_t fadeFrames) const noexcept {
    if (fadeFrames == 0U || playbackLength_ == 0U) return false;
    return directionReverse_ ? readIndex < fadeFrames : readIndex >= playbackLength_ - fadeFrames;
}

float NativeBeatRepeatProcessor::captureSample(float sample) const noexcept {
    return finiteSample(sample);
}

void NativeBeatRepeatProcessor::renderPlayback(float& left, float& right) noexcept {
    if (playbackBufferIndex_ < 0 || playbackLength_ == 0U) {
        left = 0.0f;
        right = 0.0f;
        return;
    }

    const auto bufferIndex = static_cast<std::size_t>(playbackBufferIndex_);
    const auto fadeFrames = crossfadeFrames(playbackLength_);
    const bool fadeToNextSlice = fadeFrames > 0U && !directionReverse_ &&
        activeConfig_.direction == NativeBeatRepeatDirection::Forward &&
        pendingConfig_.direction == NativeBeatRepeatDirection::Forward &&
        framesUntilBoundary_ <= fadeFrames;
    const std::size_t fadePosition = fadeToNextSlice ? fadeFrames - framesUntilBoundary_ : 0U;
    const std::size_t readIndex = std::min(playbackPosition_, playbackLength_ - 1U);

    left = buffers_[bufferIndex][0U][readIndex];
    right = buffers_[bufferIndex][1U][readIndex];

    if (fadeToNextSlice && captureFrames_ > fadePosition && fadePosition < maxSliceFrames_) {
        const float position = static_cast<float>(fadePosition + 1U) / static_cast<float>(fadeFrames);
        const auto gains = dsp::equalPowerCrossfadeGains(position);
        const std::size_t incomingIndex = fadePosition;
        const std::size_t captureIndex = static_cast<std::size_t>(captureBufferIndex_);
        left = left * gains.first + buffers_[captureIndex][0U][incomingIndex] * gains.second;
        right = right * gains.first + buffers_[captureIndex][1U][incomingIndex] * gains.second;
    } else if (fadeFrames > 0U && isAtLoopTail(readIndex, fadeFrames)) {
        const float position = directionReverse_
            ? static_cast<float>(fadeFrames - readIndex) / static_cast<float>(fadeFrames)
            : static_cast<float>(readIndex - (playbackLength_ - fadeFrames) + 1U) /
                static_cast<float>(fadeFrames);
        const auto gains = dsp::equalPowerCrossfadeGains(position);
        const std::size_t nextIndex = directionReverse_
            ? playbackLength_ - 1U - (fadeFrames - 1U - readIndex)
            : readIndex - (playbackLength_ - fadeFrames);
        left = left * gains.first + buffers_[bufferIndex][0U][nextIndex] * gains.second;
        right = right * gains.first + buffers_[bufferIndex][1U][nextIndex] * gains.second;
    }

    left *= repeatGain_;
    right *= repeatGain_;
    advancePlaybackPosition();
}

void NativeBeatRepeatProcessor::advancePlaybackPosition() noexcept {
    if (directionReverse_) {
        if (playbackPosition_ > 0U) {
            --playbackPosition_;
        } else {
            const auto fadeFrames = crossfadeFrames(playbackLength_);
            playbackPosition_ = playbackLength_ > fadeFrames
                ? playbackLength_ - fadeFrames - 1U
                : 0U;
            if (framesUntilBoundary_ > 1U) onRetrigger();
        }
    } else {
        ++playbackPosition_;
        if (playbackPosition_ >= playbackLength_) {
            playbackPosition_ = std::min(playbackLength_ - 1U, crossfadeFrames(playbackLength_));
            if (framesUntilBoundary_ > 1U) onRetrigger();
        }
    }
}

void NativeBeatRepeatProcessor::onRetrigger() noexcept {
    repeatGain_ *= 1.0f - activeConfig_.decay / 100.0f;
    if (repeatGain_ < 1.0e-6f) repeatGain_ = 0.0f;
}

void NativeBeatRepeatProcessor::onBoundary() noexcept {
    ++boundaryCount_;
    if (framesProcessed_ > 0U) {
        const auto boundaryFrame = framesProcessed_ - 1U;
        lastBoundaryFrame_ = boundaryFrame > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())
            ? std::numeric_limits<std::int64_t>::max()
            : static_cast<std::int64_t>(boundaryFrame);
    }

    const auto validFrames = std::min(captureFrames_, maxSliceFrames_);
    if (validFrames > 0U) {
        const int previousPlaybackBuffer = playbackBufferIndex_;
        const bool replacingExistingSlice = hasSlice_;
        const bool eventCrossfadeApplied = replacingExistingSlice && !directionReverse_ &&
            activeConfig_.direction == NativeBeatRepeatDirection::Forward &&
            pendingConfig_.direction == NativeBeatRepeatDirection::Forward;

        if (!hasSlice_) {
            repeatGain_ = 1.0f;
            directionReverse_ = activeConfig_.direction == NativeBeatRepeatDirection::Reverse;
        } else {
            onRetrigger();
            if (pendingConfig_.direction == NativeBeatRepeatDirection::Alternate) {
                directionReverse_ = !directionReverse_;
            } else {
                directionReverse_ = pendingConfig_.direction == NativeBeatRepeatDirection::Reverse;
            }
        }

        playbackBufferIndex_ = static_cast<int>(captureBufferIndex_);
        captureBufferIndex_ = previousPlaybackBuffer >= 0
            ? static_cast<unsigned int>(previousPlaybackBuffer)
            : 1U - captureBufferIndex_;
        playbackLength_ = validFrames;
        hasSlice_ = true;
        const auto fadeFrames = crossfadeFrames(validFrames);
        playbackPosition_ = directionReverse_
            ? (validFrames > 0U ? validFrames - 1U : 0U)
            : std::min(validFrames - 1U, eventCrossfadeApplied ? fadeFrames : 0U);
    }

    captureFrames_ = 0U;
    activeConfig_ = pendingConfig_;
    framesUntilBoundary_ = intervalFrames(activeConfig_);
}

float NativeBeatRepeatProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U ||
        maxSliceFrames_ == 0U || playbackBufferIndex_ > 1 ||
        static_cast<std::size_t>(frames) > std::numeric_limits<std::size_t>::max() / static_cast<std::size_t>(channels)) {
        return 0.0f;
    }

    float peak = 0.0f;
    const unsigned int processedChannels = std::min(channels, 2U);
    const std::size_t frameCount = static_cast<std::size_t>(frames);
    for (std::size_t frame = 0U; frame < frameCount; ++frame) {
        const std::size_t offset = frame * static_cast<std::size_t>(channels);
        const float dryLeft = captureSample(interleaved[offset]);
        const float dryRight = processedChannels == 1U
            ? dryLeft
            : captureSample(interleaved[offset + 1U]);

        if (captureFrames_ < maxSliceFrames_) {
            const std::size_t captureIndex = static_cast<std::size_t>(captureBufferIndex_);
            buffers_[captureIndex][0U][captureFrames_] = dryLeft;
            buffers_[captureIndex][1U][captureFrames_] = dryRight;
        }

        float wetLeft = 0.0f;
        float wetRight = 0.0f;
        const bool hadSliceAtFrameStart = hasSlice_ && playbackBufferIndex_ >= 0 && playbackLength_ > 0U;
        if (hadSliceAtFrameStart) renderPlayback(wetLeft, wetRight);

        const float mix = wetMix_.next();
        const float effectiveMix = hadSliceAtFrameStart ? mix : 0.0f;
        const auto gains = dsp::equalPowerCrossfadeGains(effectiveMix);
        const float outputLeft = boundedOutput(
            static_cast<double>(dryLeft) * gains.first + static_cast<double>(wetLeft) * gains.second
        );
        const float outputRight = boundedOutput(
            static_cast<double>(dryRight) * gains.first + static_cast<double>(wetRight) * gains.second
        );
        interleaved[offset] = outputLeft;
        if (processedChannels > 1U) interleaved[offset + 1U] = outputRight;
        peak = std::max(peak, std::fabs(outputLeft));
        if (processedChannels > 1U) peak = std::max(peak, std::fabs(outputRight));

        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            const float passthrough = interleaved[offset + static_cast<std::size_t>(channel)];
            if (std::isfinite(passthrough)) peak = std::max(peak, std::fabs(passthrough));
        }

        ++captureFrames_;
        ++framesProcessed_;
        if (framesUntilBoundary_ > 0U) --framesUntilBoundary_;
        if (framesUntilBoundary_ == 0U) onBoundary();
    }
    return peak;
}

NativeBeatRepeatStatus NativeBeatRepeatProcessor::status() const noexcept {
    return NativeBeatRepeatStatus{
        sampleRate_,
        maxSliceFrames_,
        playbackLength_,
        framesProcessed_,
        boundaryCount_,
        lastBoundaryFrame_,
        framesUntilBoundary_,
        activeConfig_.bpm,
        activeConfig_.division,
        activeConfig_.decay,
        activeConfig_.direction,
        hasSlice_,
        directionReverse_,
    };
}

} // namespace webrc::native
