#include "native_roll_processor.hpp"

#include "dsp_primitives.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::native {

namespace {

constexpr std::array<float, 5U> kSliceDivisions{{0.25f, 0.5f, 1.0f, 2.0f, 4.0f}};
constexpr float kDivisionTolerance = 1.0e-6f;
constexpr float kMinimumRepeatGain = 1.0e-6f;
constexpr double kSecondsPerMinute = 60.0;
constexpr double kSemitonesPerOctave = 12.0;

} // namespace

bool NativeRollProcessor::validDirection(NativeRollDirection direction) noexcept {
    return direction == NativeRollDirection::Forward ||
        direction == NativeRollDirection::Reverse ||
        direction == NativeRollDirection::Alternate;
}

bool NativeRollProcessor::validConfig(const NativeRollConfig& config) noexcept {
    if (!std::isfinite(config.bpm) || config.bpm < kMinimumBpm || config.bpm > kMaximumBpm ||
        !std::isfinite(config.sliceBeats) || !std::isfinite(config.decayPercent) ||
        !std::isfinite(config.pitchSemitones) || !std::isfinite(config.wetMix) ||
        config.decayPercent < 0.0f || config.decayPercent > 100.0f ||
        config.pitchSemitones < -24.0f || config.pitchSemitones > 24.0f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f || !validDirection(config.direction)) {
        return false;
    }

    for (const float division : kSliceDivisions) {
        if (std::fabs(config.sliceBeats - division) <= kDivisionTolerance) return true;
    }
    return false;
}

bool NativeRollProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return false;

    const std::size_t capacity = static_cast<std::size_t>(sampleRate) * kSliceCapacitySeconds + 2U;
    std::array<std::array<std::vector<float>, 2U>, 2U> replacement{};
    try {
        for (auto& bank : replacement) {
            for (auto& channel : bank) channel.assign(capacity, 0.0f);
        }
    } catch (const std::bad_alloc&) {
        return false;
    } catch (...) {
        return false;
    }

    buffers_.swap(replacement);
    sampleRate_ = sampleRate;
    maxSliceFrames_ = capacity;
    reset();
    return true;
}

bool NativeRollProcessor::setConfig(const NativeRollConfig& config) noexcept {
    if (!validConfig(config)) return false;

    pendingConfig_ = config;
    if (framesProcessed_ == 0U && !hasSlice_) {
        activeConfig_ = config;
        activeRateRatio_ = rateRatio(config.pitchSemitones);
        framesUntilBoundary_ = intervalFrames(activeConfig_);
    }
    return true;
}

void NativeRollProcessor::reset() noexcept {
    captureFrames_ = 0U;
    playbackLength_ = 0U;
    playbackPosition_ = 0.0;
    framesUntilBoundary_ = intervalFrames(pendingConfig_);
    transitionFramesTotal_ = 0U;
    transitionFramesRemaining_ = 0U;
    captureBufferIndex_ = 0U;
    playbackBufferIndex_ = -1;
    directionReverse_ = false;
    hasSlice_ = false;
    activeConfig_ = pendingConfig_;
    activeRateRatio_ = rateRatio(activeConfig_.pitchSemitones);
    repeatGain_ = 1.0f;
    framesProcessed_ = 0U;
    boundaryCount_ = 0U;
    lastBoundaryFrame_ = -1;
}

unsigned int NativeRollProcessor::intervalFrames(const NativeRollConfig& config) const noexcept {
    if (sampleRate_ == 0U || maxSliceFrames_ == 0U) return 0U;
    const double rawFrames = kSecondsPerMinute * static_cast<double>(sampleRate_) *
        static_cast<double>(config.sliceBeats) / static_cast<double>(config.bpm);
    if (!std::isfinite(rawFrames) || rawFrames <= 0.0) return 1U;
    const double boundedFrames = std::clamp(rawFrames, 1.0, static_cast<double>(maxSliceFrames_));
    return static_cast<unsigned int>(std::lround(boundedFrames));
}

std::size_t NativeRollProcessor::crossfadeFrames(std::size_t sliceFrames) const noexcept {
    if (sampleRate_ == 0U || sliceFrames < 2U) return 0U;
    const auto timeFrames = static_cast<std::size_t>(std::lround(static_cast<double>(sampleRate_) * 0.005));
    return std::min<std::size_t>(
        kMaximumCrossfadeFrames,
        std::min(sliceFrames / 2U, std::max<std::size_t>(1U, timeFrames))
    );
}

float NativeRollProcessor::finiteSample(float sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return std::clamp(sample, -64.0f, 64.0f);
}

float NativeRollProcessor::boundedOutput(double sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return static_cast<float>(std::clamp(sample, -64.0, 64.0));
}

float NativeRollProcessor::rateRatio(float semitones) noexcept {
    const double ratio = std::pow(2.0, static_cast<double>(semitones) / kSemitonesPerOctave);
    if (!std::isfinite(ratio)) return 1.0f;
    return static_cast<float>(std::clamp(ratio, 0.25, 4.0));
}

std::size_t NativeRollProcessor::wrapIndex(std::int64_t index, std::size_t length) noexcept {
    if (length == 0U) return 0U;
    const auto signedLength = static_cast<std::int64_t>(length);
    const std::int64_t remainder = index % signedLength;
    return static_cast<std::size_t>(remainder < 0 ? remainder + signedLength : remainder);
}

float NativeRollProcessor::interpolate(
    std::size_t bufferIndex,
    unsigned int channel,
    double position,
    std::size_t length
) const noexcept {
    if (bufferIndex >= buffers_.size() || channel >= 2U || length == 0U ||
        length > buffers_[bufferIndex][channel].size()) {
        return 0.0f;
    }

    const double floored = std::floor(position);
    const auto base = static_cast<std::int64_t>(floored);
    const float fraction = static_cast<float>(position - floored);
    const auto& samples = buffers_[bufferIndex][channel];
    const float xMinus1 = samples[wrapIndex(base - 1, length)];
    const float x0 = samples[wrapIndex(base, length)];
    const float xPlus1 = samples[wrapIndex(base + 1, length)];
    const float xPlus2 = samples[wrapIndex(base + 2, length)];
    const float interpolated = dsp::lagrange4(xMinus1, x0, xPlus1, xPlus2, fraction);
    const float localMinimum = std::min(std::min(xMinus1, x0), std::min(xPlus1, xPlus2));
    const float localMaximum = std::max(std::max(xMinus1, x0), std::max(xPlus1, xPlus2));
    return std::isfinite(interpolated)
        ? std::clamp(interpolated, localMinimum, localMaximum)
        : x0;
}

void NativeRollProcessor::renderPlayback(float& left, float& right) noexcept {
    if (!hasSlice_ || playbackBufferIndex_ < 0 || playbackLength_ == 0U ||
        static_cast<std::size_t>(playbackBufferIndex_) >= buffers_.size()) {
        left = 0.0f;
        right = 0.0f;
        return;
    }

    const auto bufferIndex = static_cast<std::size_t>(playbackBufferIndex_);
    const auto fadeFrames = crossfadeFrames(playbackLength_);
    left = interpolate(bufferIndex, 0U, playbackPosition_, playbackLength_);
    right = interpolate(bufferIndex, 1U, playbackPosition_, playbackLength_);

    if (fadeFrames > 0U) {
        double alternatePosition = playbackPosition_;
        float fadePosition = 0.0f;
        bool crossfadingLoop = false;
        if (directionReverse_ && playbackPosition_ < static_cast<double>(fadeFrames)) {
            alternatePosition += static_cast<double>(playbackLength_ - fadeFrames);
            fadePosition = static_cast<float>(static_cast<double>(fadeFrames) - playbackPosition_) /
                static_cast<float>(fadeFrames);
            crossfadingLoop = true;
        } else if (!directionReverse_ && playbackPosition_ >=
            static_cast<double>(playbackLength_ - fadeFrames)) {
            alternatePosition -= static_cast<double>(playbackLength_ - fadeFrames);
            const double offset = playbackPosition_ - static_cast<double>(playbackLength_ - fadeFrames);
            fadePosition = static_cast<float>(offset + 1.0) / static_cast<float>(fadeFrames);
            crossfadingLoop = true;
        }

        if (crossfadingLoop) {
            const auto gains = dsp::equalPowerCrossfadeGains(fadePosition);
            const float alternateLeft = interpolate(bufferIndex, 0U, alternatePosition, playbackLength_);
            const float alternateRight = interpolate(bufferIndex, 1U, alternatePosition, playbackLength_);
            left = left * gains.first + alternateLeft * gains.second;
            right = right * gains.first + alternateRight * gains.second;
        }
    }

    left *= repeatGain_;
    right *= repeatGain_;
    advancePlaybackPosition();
}

void NativeRollProcessor::advancePlaybackPosition() noexcept {
    if (!hasSlice_ || playbackLength_ == 0U) return;
    const auto fadeFrames = crossfadeFrames(playbackLength_);
    const double length = static_cast<double>(playbackLength_);
    if (directionReverse_) {
        playbackPosition_ -= static_cast<double>(activeRateRatio_);
        while (playbackPosition_ < 0.0) {
            playbackPosition_ += length - static_cast<double>(fadeFrames);
            // A wrap on the final callback frame is counted by onBoundary,
            // which also latches the next parameter set. Avoid double decay.
            if (framesUntilBoundary_ > 1U) onRetrigger();
        }
    } else {
        playbackPosition_ += static_cast<double>(activeRateRatio_);
        while (playbackPosition_ >= length) {
            playbackPosition_ -= length;
            playbackPosition_ += static_cast<double>(fadeFrames);
            // A wrap on the final callback frame is counted by onBoundary,
            // which also latches the next parameter set. Avoid double decay.
            if (framesUntilBoundary_ > 1U) onRetrigger();
        }
    }
}

void NativeRollProcessor::onRetrigger() noexcept {
    repeatGain_ *= 1.0f - activeConfig_.decayPercent / 100.0f;
    if (!std::isfinite(repeatGain_) || repeatGain_ < kMinimumRepeatGain) repeatGain_ = 0.0f;
}

bool NativeRollProcessor::nextDirectionReverse() const noexcept {
    if (!hasSlice_) return pendingConfig_.direction == NativeRollDirection::Reverse;
    if (pendingConfig_.direction == NativeRollDirection::Alternate) return !directionReverse_;
    return pendingConfig_.direction == NativeRollDirection::Reverse;
}

void NativeRollProcessor::onBoundary() noexcept {
    if (boundaryCount_ < std::numeric_limits<std::uint64_t>::max()) ++boundaryCount_;
    if (framesProcessed_ > 0U) {
        const std::uint64_t boundaryFrame = framesProcessed_ - 1U;
        lastBoundaryFrame_ = boundaryFrame > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())
            ? std::numeric_limits<std::int64_t>::max()
            : static_cast<std::int64_t>(boundaryFrame);
    }

    const std::size_t validFrames = std::min(captureFrames_, maxSliceFrames_);
    if (validFrames > 0U) {
        const bool replacingExistingSlice = hasSlice_ && playbackBufferIndex_ >= 0;
        const float nextGain = replacingExistingSlice
            ? repeatGain_ * (1.0f - pendingConfig_.decayPercent / 100.0f)
            : 1.0f;
        const bool nextReverse = nextDirectionReverse();

        transitionFramesTotal_ = 0U;
        transitionFramesRemaining_ = 0U;
        if (replacingExistingSlice && playbackLength_ > 0U) {
            transitionFramesTotal_ = static_cast<unsigned int>(
                crossfadeFrames(std::min(playbackLength_, validFrames))
            );
            transitionFramesRemaining_ = transitionFramesTotal_;
            for (unsigned int frame = 0U; frame < transitionFramesTotal_; ++frame) {
                float tailLeft = 0.0f;
                float tailRight = 0.0f;
                renderPlayback(tailLeft, tailRight);
                transitionTail_[0U][frame] = finiteSample(tailLeft);
                transitionTail_[1U][frame] = finiteSample(tailRight);
            }
        }

        const int oldPlaybackBuffer = playbackBufferIndex_;
        playbackBufferIndex_ = static_cast<int>(captureBufferIndex_);
        captureBufferIndex_ = oldPlaybackBuffer >= 0
            ? static_cast<unsigned int>(oldPlaybackBuffer)
            : 1U - captureBufferIndex_;
        playbackLength_ = validFrames;
        playbackPosition_ = nextReverse ? static_cast<double>(validFrames - 1U) : 0.0;
        directionReverse_ = nextReverse;
        hasSlice_ = true;
        repeatGain_ = std::isfinite(nextGain) ? std::max(0.0f, nextGain) : 0.0f;
        activeConfig_ = pendingConfig_;
        activeRateRatio_ = rateRatio(activeConfig_.pitchSemitones);
    }

    captureFrames_ = 0U;
    activeConfig_ = pendingConfig_;
    activeRateRatio_ = rateRatio(activeConfig_.pitchSemitones);
    framesUntilBoundary_ = intervalFrames(activeConfig_);
}

float NativeRollProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U ||
        maxSliceFrames_ == 0U || playbackBufferIndex_ > 1 ||
        static_cast<std::size_t>(frames) > std::numeric_limits<std::size_t>::max() /
            static_cast<std::size_t>(channels)) {
        return 0.0f;
    }

    float peak = 0.0f;
    const unsigned int processedChannels = std::min(channels, 2U);
    const std::size_t channelCount = static_cast<std::size_t>(channels);
    for (std::size_t frame = 0U; frame < static_cast<std::size_t>(frames); ++frame) {
        const std::size_t offset = frame * channelCount;
        const float dryLeft = finiteSample(interleaved[offset]);
        const float dryRight = processedChannels == 1U
            ? dryLeft
            : finiteSample(interleaved[offset + 1U]);

        if (captureFrames_ < maxSliceFrames_) {
            const std::size_t captureIndex = static_cast<std::size_t>(captureBufferIndex_);
            buffers_[captureIndex][0U][captureFrames_] = dryLeft;
            buffers_[captureIndex][1U][captureFrames_] = dryRight;
        }

        float wetLeft = 0.0f;
        float wetRight = 0.0f;
        const bool hadSliceAtFrameStart = hasSlice_ && playbackBufferIndex_ >= 0 && playbackLength_ > 0U;
        if (hadSliceAtFrameStart) renderPlayback(wetLeft, wetRight);

        if (hadSliceAtFrameStart && transitionFramesRemaining_ > 0U && transitionFramesTotal_ > 0U) {
            const unsigned int transitionIndex = transitionFramesTotal_ - transitionFramesRemaining_;
            const float position = static_cast<float>(transitionIndex + 1U) /
                static_cast<float>(transitionFramesTotal_);
            const auto gains = dsp::equalPowerCrossfadeGains(position);
            wetLeft = transitionTail_[0U][transitionIndex] * gains.first + wetLeft * gains.second;
            wetRight = transitionTail_[1U][transitionIndex] * gains.first + wetRight * gains.second;
            --transitionFramesRemaining_;
        }

        const float effectiveWetMix = hadSliceAtFrameStart ? activeConfig_.wetMix : 0.0f;
        const auto mixGains = dsp::equalPowerCrossfadeGains(effectiveWetMix);
        const float outputLeft = boundedOutput(
            static_cast<double>(dryLeft) * mixGains.first + static_cast<double>(wetLeft) * mixGains.second
        );
        const float outputRight = boundedOutput(
            static_cast<double>(dryRight) * mixGains.first + static_cast<double>(wetRight) * mixGains.second
        );
        interleaved[offset] = outputLeft;
        if (processedChannels > 1U) interleaved[offset + 1U] = outputRight;
        peak = std::max(peak, std::fabs(outputLeft));
        if (processedChannels > 1U) peak = std::max(peak, std::fabs(outputRight));

        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            const std::size_t channelOffset = offset + static_cast<std::size_t>(channel);
            const float passthrough = finiteSample(interleaved[channelOffset]);
            interleaved[channelOffset] = passthrough;
            peak = std::max(peak, std::fabs(passthrough));
        }

        if (captureFrames_ < maxSliceFrames_) ++captureFrames_;
        if (framesProcessed_ < std::numeric_limits<std::uint64_t>::max()) ++framesProcessed_;
        if (framesUntilBoundary_ > 0U) --framesUntilBoundary_;
        if (framesUntilBoundary_ == 0U) onBoundary();
    }
    return peak;
}

NativeRollStatus NativeRollProcessor::status() const noexcept {
    NativeRollStatus result;
    result.sampleRate = sampleRate_;
    result.maxSliceFrames = maxSliceFrames_;
    result.captureFrames = captureFrames_;
    result.playbackFrames = playbackLength_;
    result.framesProcessed = framesProcessed_;
    result.boundaryCount = boundaryCount_;
    result.lastBoundaryFrame = lastBoundaryFrame_;
    result.remainingFramesToBoundary = framesUntilBoundary_;
    result.transitionFramesRemaining = transitionFramesRemaining_;
    result.playbackRateRatio = activeRateRatio_;
    result.repeatGain = repeatGain_;
    result.activeConfig = activeConfig_;
    result.pendingConfig = pendingConfig_;
    result.hasCapturedSlice = hasSlice_;
    result.reversePlayback = directionReverse_;
    return result;
}

} // namespace webrc::native
