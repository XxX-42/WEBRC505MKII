#include "native_freeze_processor.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::native {

namespace {

constexpr double kMillisecondsPerSecond = 1000.0;
constexpr double kSemitonesPerOctave = 12.0;
constexpr double kMixSmoothingSeconds = 0.01;
constexpr double kMaximumCrossfadeSeconds = 0.005;
constexpr double kReleaseFadeSeconds = 0.005;

} // namespace

bool NativeFreezeProcessor::validConfig(const NativeFreezeConfig& config) noexcept {
    if (!std::isfinite(config.captureLengthMs) ||
        !std::isfinite(config.pitchSemitones) ||
        !std::isfinite(config.wetMix) ||
        config.captureLengthMs < kMinimumCaptureLengthMs ||
        config.captureLengthMs > kMaximumCaptureLengthMs ||
        config.pitchSemitones < kMinimumPitchSemitones ||
        config.pitchSemitones > kMaximumPitchSemitones ||
        config.wetMix < kMinimumWetMix || config.wetMix > kMaximumWetMix) {
        return false;
    }

    return config.mode == NativeFreezeMode::MicroLoop ||
        config.mode == NativeFreezeMode::Spectral;
}

bool NativeFreezeProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return false;

    const auto capacity = static_cast<std::size_t>(sampleRate) * 2U;
    std::vector<float> replacementLeft;
    std::vector<float> replacementRight;
    try {
        replacementLeft.assign(capacity, 0.0f);
        replacementRight.assign(capacity, 0.0f);
    } catch (const std::bad_alloc&) {
        return false;
    } catch (...) {
        return false;
    }

    ringLeft_.swap(replacementLeft);
    ringRight_.swap(replacementRight);
    sampleRate_ = sampleRate;
    const double smoothingSamples = kMixSmoothingSeconds * static_cast<double>(sampleRate_);
    mixSmoothingCoefficient_ = static_cast<float>(
        1.0 - std::exp(-1.0 / std::max(1.0, smoothingSamples))
    );
    reset();
    return true;
}

NativeFreezeConfigResult NativeFreezeProcessor::setConfig(
    const NativeFreezeConfig& config
) noexcept {
    if (config.mode == NativeFreezeMode::Spectral) {
        return NativeFreezeConfigResult::UnsupportedMode;
    }
    if (!validConfig(config)) return NativeFreezeConfigResult::InvalidConfig;

    if (config.frozen && !frozen_) {
        const auto requestedFrames = captureFramesFor(config.captureLengthMs);
        if (requestedFrames == 0U || validCaptureFrames_ < requestedFrames) {
            return NativeFreezeConfigResult::InsufficientCaptureHistory;
        }
        config_ = config;
        playbackRateRatio_ = rateRatio(config_.pitchSemitones);
        latchLoop(requestedFrames);
        return NativeFreezeConfigResult::Accepted;
    }

    const bool releasing = frozen_ && !config.frozen;
    config_ = config;
    playbackRateRatio_ = rateRatio(config_.pitchSemitones);
    if (releasing) releaseLoop();
    return NativeFreezeConfigResult::Accepted;
}

void NativeFreezeProcessor::reset() noexcept {
    writePosition_ = 0U;
    validCaptureFrames_ = 0U;
    loopStart_ = 0U;
    loopFrames_ = 0U;
    crossfadeFrames_ = 0U;
    releaseFadeLength_ = 0U;
    releaseFadePosition_ = 0U;
    playbackPosition_ = 0.0;
    playbackRateRatio_ = rateRatio(config_.pitchSemitones);
    mixCurrent_ = config_.wetMix;
    lastOutputLeft_ = 0.0f;
    lastOutputRight_ = 0.0f;
    releaseFadeStartLeft_ = 0.0f;
    releaseFadeStartRight_ = 0.0f;
    framesProcessed_ = 0U;
    frozen_ = false;
    hasLoop_ = false;
    config_.frozen = false;
}

std::size_t NativeFreezeProcessor::captureFramesFor(float milliseconds) const noexcept {
    if (sampleRate_ == 0U || !std::isfinite(milliseconds) || milliseconds <= 0.0f) return 0U;
    const double frames = static_cast<double>(milliseconds) * static_cast<double>(sampleRate_) /
        kMillisecondsPerSecond;
    if (!std::isfinite(frames) || frames <= 0.0) return 0U;
    const auto rounded = static_cast<std::size_t>(std::llround(frames));
    return std::clamp<std::size_t>(rounded, 1U, ringLeft_.size());
}

std::size_t NativeFreezeProcessor::crossfadeFrames(std::size_t loopFrames) const noexcept {
    if (sampleRate_ == 0U || loopFrames < 4U) return 0U;
    const auto timeFrames = static_cast<std::size_t>(std::lround(
        static_cast<double>(sampleRate_) * kMaximumCrossfadeSeconds
    ));
    const auto proportionalFrames = std::max<std::size_t>(1U, loopFrames / 100U);
    return std::min<std::size_t>(
        kMaximumCrossfadeFrames,
        std::min(proportionalFrames, std::max<std::size_t>(1U, timeFrames))
    );
}

std::size_t NativeFreezeProcessor::wrapIndex(std::int64_t index, std::size_t length) noexcept {
    if (length == 0U) return 0U;
    const auto signedLength = static_cast<std::int64_t>(length);
    const auto remainder = index % signedLength;
    return static_cast<std::size_t>(remainder < 0 ? remainder + signedLength : remainder);
}

float NativeFreezeProcessor::finiteSample(float sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return std::clamp(sample, -64.0f, 64.0f);
}

float NativeFreezeProcessor::boundedOutput(double sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return static_cast<float>(std::clamp(sample, -64.0, 64.0));
}

float NativeFreezeProcessor::rateRatio(float semitones) noexcept {
    const double ratio = std::pow(2.0, static_cast<double>(semitones) / kSemitonesPerOctave);
    if (!std::isfinite(ratio)) return 1.0f;
    return static_cast<float>(std::clamp(ratio, 0.25, 4.0));
}

float NativeFreezeProcessor::readLoop(unsigned int channel, double position) const noexcept {
    if (!hasLoop_ || loopFrames_ == 0U || channel >= 2U || ringLeft_.empty()) return 0.0f;
    const auto floored = std::floor(position);
    const auto base = static_cast<std::int64_t>(floored);
    const float fraction = static_cast<float>(position - floored);
    const auto& ring = channel == 0U ? ringLeft_ : ringRight_;
    const auto firstRelative = wrapIndex(base, loopFrames_);
    const auto secondRelative = wrapIndex(base + 1, loopFrames_);
    const auto firstIndex = (loopStart_ + firstRelative) % ring.size();
    const auto secondIndex = (loopStart_ + secondRelative) % ring.size();
    const float first = ring[firstIndex];
    const float second = ring[secondIndex];
    const float interpolated = first + (second - first) * fraction;
    return std::isfinite(interpolated)
        ? std::clamp(interpolated, std::min(first, second), std::max(first, second))
        : first;
}

void NativeFreezeProcessor::captureFrame(float left, float right) noexcept {
    if (ringLeft_.empty() || ringRight_.empty()) return;
    ringLeft_[writePosition_] = left;
    ringRight_[writePosition_] = right;
    writePosition_ = (writePosition_ + 1U) % ringLeft_.size();
    validCaptureFrames_ = std::min(validCaptureFrames_ + 1U, ringLeft_.size());
}

void NativeFreezeProcessor::latchLoop(std::size_t length) noexcept {
    if (ringLeft_.empty() || length == 0U || length > validCaptureFrames_) return;
    loopStart_ = writePosition_ >= length
        ? writePosition_ - length
        : ringLeft_.size() - (length - writePosition_);
    loopFrames_ = length;
    crossfadeFrames_ = crossfadeFrames(loopFrames_);
    playbackPosition_ = 0.0;
    frozen_ = true;
    hasLoop_ = true;
}

void NativeFreezeProcessor::releaseLoop() noexcept {
    releaseFadeStartLeft_ = lastOutputLeft_;
    releaseFadeStartRight_ = lastOutputRight_;
    releaseFadeLength_ = std::min<std::size_t>(
        kMaximumCrossfadeFrames,
        std::max<std::size_t>(1U, static_cast<std::size_t>(std::lround(
            static_cast<double>(sampleRate_) * kReleaseFadeSeconds
        )))
    );
    releaseFadePosition_ = 0U;
    frozen_ = false;
    hasLoop_ = false;
    loopStart_ = 0U;
    loopFrames_ = 0U;
    crossfadeFrames_ = 0U;
    playbackPosition_ = 0.0;
    // Only audio captured after release is eligible for the next freeze. This
    // prevents stale samples from the previous loop entering a new snapshot.
    validCaptureFrames_ = 0U;
    config_.frozen = false;
}

void NativeFreezeProcessor::renderFrozen(float& left, float& right) noexcept {
    if (!hasLoop_ || loopFrames_ == 0U) {
        left = 0.0f;
        right = 0.0f;
        return;
    }

    left = readLoop(0U, playbackPosition_);
    right = readLoop(1U, playbackPosition_);
    if (crossfadeFrames_ > 0U && playbackPosition_ >=
        static_cast<double>(loopFrames_ - crossfadeFrames_)) {
        const double fadeStart = static_cast<double>(loopFrames_ - crossfadeFrames_);
        const float fade = static_cast<float>(std::clamp(
            (playbackPosition_ - fadeStart) / static_cast<double>(crossfadeFrames_), 0.0, 1.0
        ));
        const double alternatePosition = playbackPosition_ - fadeStart;
        const float alternateLeft = readLoop(0U, alternatePosition);
        const float alternateRight = readLoop(1U, alternatePosition);
        left += (alternateLeft - left) * fade;
        right += (alternateRight - right) * fade;
    }

    // The seam maps the last crossfadeFrames_ back onto the loop start. Scale
    // traversal so each steady-state cycle still spans the requested loop
    // duration and pitch ratio rather than shortening by the overlap length.
    const double seamCompensation = loopFrames_ > crossfadeFrames_
        ? static_cast<double>(loopFrames_ - crossfadeFrames_) / static_cast<double>(loopFrames_)
        : 1.0;
    playbackPosition_ += static_cast<double>(playbackRateRatio_) * seamCompensation;
    while (playbackPosition_ >= static_cast<double>(loopFrames_)) {
        playbackPosition_ -= static_cast<double>(loopFrames_);
        playbackPosition_ += static_cast<double>(crossfadeFrames_);
    }
}

float NativeFreezeProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels,
    bool hostBypassed
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U ||
        sampleRate_ == 0U || ringLeft_.empty()) {
        return 0.0f;
    }

    float peak = 0.0f;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const auto base = static_cast<std::size_t>(frame) * static_cast<std::size_t>(channels);
        const float dryLeft = finiteSample(interleaved[base]);
        const float dryRight = channels > 1U ? finiteSample(interleaved[base + 1U]) : dryLeft;

        if (!frozen_) captureFrame(dryLeft, dryRight);

        float outputLeft = dryLeft;
        float outputRight = dryRight;
        if (frozen_ && hasLoop_) {
            float wetLeft = 0.0f;
            float wetRight = 0.0f;
            renderFrozen(wetLeft, wetRight);
            mixCurrent_ += (config_.wetMix - mixCurrent_) * mixSmoothingCoefficient_;
            if (!hostBypassed) {
                outputLeft = dryLeft * (1.0f - mixCurrent_) + wetLeft * mixCurrent_;
                outputRight = dryRight * (1.0f - mixCurrent_) + wetRight * mixCurrent_;
            }
        } else if (releaseFadePosition_ < releaseFadeLength_) {
            const float fade = releaseFadeLength_ <= 1U
                ? 0.0f
                : 1.0f - static_cast<float>(releaseFadePosition_) /
                    static_cast<float>(releaseFadeLength_ - 1U);
            if (!hostBypassed) {
                outputLeft = releaseFadeStartLeft_ * fade + dryLeft * (1.0f - fade);
                outputRight = releaseFadeStartRight_ * fade + dryRight * (1.0f - fade);
            }
            ++releaseFadePosition_;
        }

        interleaved[base] = boundedOutput(outputLeft);
        if (channels > 1U) interleaved[base + 1U] = boundedOutput(outputRight);
        for (unsigned int channel = 2U; channel < channels; ++channel) {
            const auto index = base + static_cast<std::size_t>(channel);
            interleaved[index] = finiteSample(interleaved[index]);
        }

        lastOutputLeft_ = interleaved[base];
        lastOutputRight_ = channels > 1U ? interleaved[base + 1U] : interleaved[base];
        peak = std::max(peak, std::fabs(interleaved[base]));
        if (channels > 1U) peak = std::max(peak, std::fabs(interleaved[base + 1U]));
        if (framesProcessed_ < std::numeric_limits<std::uint64_t>::max()) ++framesProcessed_;
    }
    return peak;
}

NativeFreezeStatus NativeFreezeProcessor::status() const noexcept {
    NativeFreezeStatus result;
    result.sampleRate = sampleRate_;
    result.ringCapacityFrames = ringLeft_.size();
    result.validCaptureFrames = validCaptureFrames_;
    result.requiredCaptureFrames = captureFramesFor(config_.captureLengthMs);
    result.loopFrames = loopFrames_;
    result.crossfadeFrames = crossfadeFrames_;
    result.framesProcessed = framesProcessed_;
    result.playbackPosition = playbackPosition_;
    result.playbackRateRatio = playbackRateRatio_;
    result.config = config_;
    result.prepared = sampleRate_ != 0U && !ringLeft_.empty() && !ringRight_.empty();
    result.frozen = frozen_;
    result.hasCapturedLoop = hasLoop_;
    return result;
}

} // namespace webrc::native
