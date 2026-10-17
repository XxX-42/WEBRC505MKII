#include "native_beat_scatter_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {
namespace {

constexpr float kMinimumBpm = 40.0f;
constexpr float kMaximumBpm = 300.0f;
constexpr float kMinimumPitchSemitones = -24.0f;
constexpr float kMaximumPitchSemitones = 24.0f;
constexpr float kPercentMaximum = 100.0f;
constexpr float kSliceTolerance = 1.0e-6f;
constexpr float kSampleCeiling = 64.0f;

[[nodiscard]] float boundedOutput(double value) noexcept {
    if (!std::isfinite(value)) return 0.0f;
    return static_cast<float>(std::clamp(value, -static_cast<double>(kSampleCeiling),
        static_cast<double>(kSampleCeiling)));
}

} // namespace

bool NativeBeatScatterProcessor::validConfig(const NativeBeatScatterConfig& config) noexcept {
    if (!std::isfinite(config.bpm) || config.bpm < kMinimumBpm || config.bpm > kMaximumBpm ||
        !std::isfinite(config.scatterPercent) || config.scatterPercent < 0.0f ||
        config.scatterPercent > kPercentMaximum || !std::isfinite(config.pitchSemitones) ||
        config.pitchSemitones < kMinimumPitchSemitones || config.pitchSemitones > kMaximumPitchSemitones ||
        config.repeats < 1U || config.repeats > 16U || !std::isfinite(config.wetMix) ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    for (const float option : kSliceBeatOptions) {
        if (std::fabs(config.sliceBeats - option) <= kSliceTolerance) return true;
    }
    return false;
}

bool NativeBeatScatterProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return false;

    const auto capacity = static_cast<std::size_t>(sampleRate) * kSliceCapacitySeconds + 2U;
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

bool NativeBeatScatterProcessor::setConfig(const NativeBeatScatterConfig& config,
    std::uint64_t mixRampFrames) noexcept {
    if (!validConfig(config)) return false;

    pendingConfig_ = config;
    // Mix is an immediate, smoothed control; tempo and grain controls latch at
    // a slice boundary so no current capture/read head changes mid-slice.
    activeConfig_.wetMix = config.wetMix;
    wetMix_.setTarget(config.wetMix, mixRampFrames);
    if (sampleRate_ != 0U && framesProcessed_ == 0U && !hasSlice_) {
        activeConfig_ = pendingConfig_;
        activeIntervalFrames_ = intervalFrames(activeConfig_);
        framesUntilBoundary_ = activeIntervalFrames_;
    }
    return true;
}

void NativeBeatScatterProcessor::reset() noexcept {
    captureFrames_ = 0U;
    playbackLength_ = 0U;
    playbackElapsedFrames_ = 0U;
    framesUntilBoundary_ = 0U;
    activeIntervalFrames_ = 0U;
    captureBufferIndex_ = 0U;
    playbackBufferIndex_ = -1;
    randomState_ = kInitialRandomState;
    pitchRatio_ = 1.0f;
    previousWetLeft_ = 0.0f;
    previousWetRight_ = 0.0f;
    hasSlice_ = false;
    framesProcessed_ = 0U;
    boundaryCount_ = 0U;
    lastBoundaryFrame_ = -1;
    activeConfig_ = pendingConfig_;
    activeIntervalFrames_ = intervalFrames(activeConfig_);
    framesUntilBoundary_ = activeIntervalFrames_;
    wetMix_.reset(pendingConfig_.wetMix);
}

float NativeBeatScatterProcessor::processInPlace(float* interleaved, unsigned int frames,
    unsigned int channels) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) return 0.0f;

    for (unsigned int frameIndex = 0U; frameIndex < frames; ++frameIndex) {
        processFrame(interleaved + static_cast<std::size_t>(frameIndex) * channels, channels);
    }

    float peak = 0.0f;
    const std::size_t sampleCount = static_cast<std::size_t>(frames) * channels;
    for (std::size_t index = 0U; index < sampleCount; ++index) {
        const float sample = interleaved[index];
        if (std::isfinite(sample)) peak = std::max(peak, std::fabs(sample));
    }
    return peak;
}

NativeBeatScatterStatus NativeBeatScatterProcessor::status() const noexcept {
    NativeBeatScatterStatus result;
    result.sampleRate = sampleRate_;
    result.maxSliceFrames = maxSliceFrames_;
    result.activeSliceFrames = playbackLength_;
    result.framesProcessed = framesProcessed_;
    result.boundaryCount = boundaryCount_;
    result.lastBoundaryFrame = lastBoundaryFrame_;
    result.remainingFramesToBoundary = framesUntilBoundary_;
    result.activeBpm = activeConfig_.bpm;
    result.activeSliceBeats = activeConfig_.sliceBeats;
    result.activeScatterPercent = activeConfig_.scatterPercent;
    result.activePitchSemitones = activeConfig_.pitchSemitones;
    result.activeRepeats = activeConfig_.repeats;
    result.hasCapturedSlice = hasSlice_;
    return result;
}

unsigned int NativeBeatScatterProcessor::intervalFrames(const NativeBeatScatterConfig& config) const noexcept {
    if (sampleRate_ == 0U || maxSliceFrames_ == 0U) return 0U;
    const double rawFrames = (60.0 * static_cast<double>(sampleRate_) * static_cast<double>(config.sliceBeats)) /
        static_cast<double>(config.bpm);
    if (!std::isfinite(rawFrames) || rawFrames <= 0.0) return 1U;
    const double boundedFrames = std::clamp(rawFrames, 1.0, static_cast<double>(maxSliceFrames_));
    return static_cast<unsigned int>(std::lround(boundedFrames));
}

float NativeBeatScatterProcessor::finiteSample(float sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return std::clamp(sample, -kSampleCeiling, kSampleCeiling);
}

void NativeBeatScatterProcessor::processFrame(float* frame, unsigned int channels) noexcept {
    const float dryLeft = finiteSample(frame[0]);
    const float dryRight = channels > 1U ? finiteSample(frame[1]) : dryLeft;

    const auto captureIndex = static_cast<std::size_t>(captureBufferIndex_);
    if (captureFrames_ < maxSliceFrames_) {
        buffers_[captureIndex][0U][captureFrames_] = dryLeft;
        buffers_[captureIndex][1U][captureFrames_] = dryRight;
    }

    float wetLeft = 0.0f;
    float wetRight = 0.0f;
    if (hasSlice_ && playbackBufferIndex_ >= 0 && playbackLength_ > 0U) {
        renderGrain(wetLeft, wetRight);
        const float mix = wetMix_.next();
        const auto gains = dsp::equalPowerCrossfadeGains(mix);
        frame[0] = boundedOutput(static_cast<double>(dryLeft) * gains.first +
            static_cast<double>(wetLeft) * gains.second);
        if (channels > 1U) {
            frame[1] = boundedOutput(static_cast<double>(dryRight) * gains.first +
                static_cast<double>(wetRight) * gains.second);
        }
    } else {
        // Until the first complete slice exists, preserve a bit-exact dry path
        // regardless of the mix setting, matching the Browser processor.
        (void)wetMix_.next();
        frame[0] = dryLeft;
        if (channels > 1U) frame[1] = dryRight;
    }

    captureFrames_ = std::min(captureFrames_ + 1U, maxSliceFrames_);
    ++framesProcessed_;
    if (framesUntilBoundary_ > 0U) --framesUntilBoundary_;
    if (framesUntilBoundary_ == 0U) onBoundary();
}

void NativeBeatScatterProcessor::renderGrain(float& left, float& right) noexcept {
    const unsigned int repeats = activeConfig_.repeats;
    const auto segmentIndex = std::min<std::size_t>(repeats - 1U,
        (playbackElapsedFrames_ * repeats) / std::max(1U, activeIntervalFrames_));
    const auto outputSegmentStart = (segmentIndex * activeIntervalFrames_) / repeats;
    const auto outputSegmentEnd = ((segmentIndex + 1U) * activeIntervalFrames_) / repeats;
    const auto outputSegmentFrames = std::max<std::size_t>(1U, outputSegmentEnd - outputSegmentStart);
    const auto outputOffset = playbackElapsedFrames_ - outputSegmentStart;
    const auto sourceStart = grainStarts_[segmentIndex];
    const auto sourceLength = std::max<std::size_t>(1U, grainLengths_[segmentIndex]);
    const double sourcePosition = std::fmod(
        (static_cast<double>(outputOffset) / static_cast<double>(outputSegmentFrames)) *
            static_cast<double>(sourceLength) * static_cast<double>(pitchRatio_),
        static_cast<double>(sourceLength));
    const auto sourceIndexOffset = static_cast<std::size_t>(sourcePosition);
    const float fraction = static_cast<float>(sourcePosition - static_cast<double>(sourceIndexOffset));
    const auto firstIndex = sourceStart + sourceIndexOffset;
    const auto secondIndex = sourceStart + ((sourceIndexOffset + 1U) % sourceLength);
    const auto playbackIndex = static_cast<std::size_t>(playbackBufferIndex_);
    const float sourceLeft = buffers_[playbackIndex][0U][firstIndex];
    const float sourceRight = buffers_[playbackIndex][1U][firstIndex];
    float nextLeft = buffers_[playbackIndex][0U][secondIndex];
    float nextRight = buffers_[playbackIndex][1U][secondIndex];
    left = sourceLeft + ((nextLeft - sourceLeft) * fraction);
    right = sourceRight + ((nextRight - sourceRight) * fraction);

    const auto fadeFrames = std::min<std::size_t>(16U, outputSegmentFrames / 2U);
    if (fadeFrames > 1U && outputOffset < fadeFrames) {
        const float fadeIn = static_cast<float>(outputOffset + 1U) / static_cast<float>(fadeFrames);
        left = previousWetLeft_ * (1.0f - fadeIn) + left * fadeIn;
        right = previousWetRight_ * (1.0f - fadeIn) + right * fadeIn;
    }

    left = finiteSample(left);
    right = finiteSample(right);
    previousWetLeft_ = left;
    previousWetRight_ = right;
    ++playbackElapsedFrames_;
}

void NativeBeatScatterProcessor::onBoundary() noexcept {
    ++boundaryCount_;
    lastBoundaryFrame_ = static_cast<std::int64_t>(framesProcessed_) - 1;

    const auto validFrames = std::min(captureFrames_, maxSliceFrames_);
    if (validFrames > 0U) {
        playbackBufferIndex_ = static_cast<int>(captureBufferIndex_);
        captureBufferIndex_ = 1U - captureBufferIndex_;
        playbackLength_ = validFrames;
        hasSlice_ = true;
    }

    captureFrames_ = 0U;
    playbackElapsedFrames_ = 0U;
    activeConfig_ = pendingConfig_;
    pitchRatio_ = std::pow(2.0f, activeConfig_.pitchSemitones / 12.0f);
    activeIntervalFrames_ = intervalFrames(activeConfig_);
    framesUntilBoundary_ = activeIntervalFrames_;
    if (hasSlice_) prepareGrains();
}

void NativeBeatScatterProcessor::prepareGrains() noexcept {
    const unsigned int repeats = activeConfig_.repeats;
    const float scatter = activeConfig_.scatterPercent / kPercentMaximum;
    for (unsigned int index = 0U; index < repeats; ++index) {
        const unsigned int randomBucket = nextRandom() % repeats;
        const float bucketPosition = static_cast<float>(index) +
            ((static_cast<float>(randomBucket) - static_cast<float>(index)) * scatter);
        const auto bucket = static_cast<unsigned int>(std::clamp(
            std::floor(bucketPosition + 0.5f), 0.0f, static_cast<float>(repeats - 1U)));
        const auto start = (static_cast<std::size_t>(bucket) * playbackLength_) / repeats;
        const auto end = (static_cast<std::size_t>(bucket + 1U) * playbackLength_) / repeats;
        grainStarts_[index] = std::min(start, playbackLength_ - 1U);
        grainLengths_[index] = std::max<std::size_t>(1U, end - start);
    }
}

std::uint32_t NativeBeatScatterProcessor::nextRandom() noexcept {
    // xorshift32: deterministic per instance and bounded integer state.
    std::uint32_t value = randomState_;
    value ^= value << 13U;
    value ^= value >> 17U;
    value ^= value << 5U;
    randomState_ = value;
    return randomState_;
}

} // namespace webrc::native
