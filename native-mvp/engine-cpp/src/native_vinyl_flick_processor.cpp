#include "native_vinyl_flick_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {
namespace {

constexpr double kSpeedOffsetScale = 0.01;
constexpr float kInputLimit = 64.0f;
constexpr double kMaximumBrakeDamping = 0.6;

[[nodiscard]] double targetRatio(float speedPercent) noexcept {
    return std::clamp(1.0 + static_cast<double>(speedPercent) * kSpeedOffsetScale, 0.0, 2.0);
}

} // namespace

bool NativeVinylFlickProcessor::validConfig(const NativeVinylFlickConfig& config) noexcept {
    return std::isfinite(config.speedPercent) && config.speedPercent >= -100.0f && config.speedPercent <= 100.0f &&
        std::isfinite(config.motorReturnSeconds) && config.motorReturnSeconds >= 0.05f &&
        config.motorReturnSeconds <= 10.0f &&
        std::isfinite(config.brakePercent) && config.brakePercent >= 0.0f && config.brakePercent <= 100.0f &&
        std::isfinite(config.mixPercent) && config.mixPercent >= 0.0f && config.mixPercent <= 100.0f;
}

float NativeVinylFlickProcessor::sanitizeSample(float sample) noexcept {
    return std::isfinite(sample) ? std::clamp(sample, -kInputLimit, kInputLimit) : 0.0f;
}

double NativeVinylFlickProcessor::wrapCursor(double cursor) noexcept {
    constexpr double capacity = static_cast<double>(kHistoryFrames);
    if (!std::isfinite(cursor)) return 0.0;
    if (cursor < 0.0) cursor += capacity * (std::ceil(-cursor / capacity));
    if (cursor >= capacity) cursor -= capacity * std::floor(cursor / capacity);
    return cursor >= capacity ? 0.0 : cursor;
}

double NativeVinylFlickProcessor::cursorAge(std::size_t newestIndex, double cursor) noexcept {
    double age = static_cast<double>(newestIndex) - cursor;
    if (age < 0.0) age += static_cast<double>(kHistoryFrames);
    return age;
}

float NativeVinylFlickProcessor::readHistory(const float* history, std::size_t index) const noexcept {
    return history[index & kHistoryMask];
}

float NativeVinylFlickProcessor::resample(const float* history) const noexcept {
    const double baseValue = std::floor(readCursor_);
    const auto base = static_cast<std::size_t>(baseValue) & kHistoryMask;
    const float fraction = static_cast<float>(readCursor_ - baseValue);
    const float before = readHistory(history, (base - 1U) & kHistoryMask);
    const float at = readHistory(history, base);
    const float after = readHistory(history, (base + 1U) & kHistoryMask);
    const float after2 = readHistory(history, (base + 2U) & kHistoryMask);
    const float output = dsp::lagrange4(before, at, after, after2, fraction);
    return std::isfinite(output) ? std::clamp(output, -kInputLimit, kInputLimit) : 0.0f;
}

bool NativeVinylFlickProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) {
        sampleRate_ = 0U;
        return false;
    }

    if (!history_) {
        history_.reset(new (std::nothrow) float[kHistoryFrames * 2U]);
        if (!history_) {
            sampleRate_ = 0U;
            return false;
        }
    }

    sampleRate_ = sampleRate;
    speedPercent_.reset(config_.speedPercent);
    motorReturnSeconds_.reset(config_.motorReturnSeconds);
    brakePercent_.reset(config_.brakePercent);
    mixPercent_.reset(config_.mixPercent);
    reset();
    return true;
}

bool NativeVinylFlickProcessor::setConfig(
    const NativeVinylFlickConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!validConfig(config)) return false;
    config_ = config;
    const std::uint64_t actualRamp = rampFrames != 0U
        ? rampFrames
        : (sampleRate_ != 0U ? std::max<std::uint64_t>(1U, sampleRate_ / 100U) : 64U);
    speedPercent_.setTarget(config.speedPercent, actualRamp);
    motorReturnSeconds_.setTarget(config.motorReturnSeconds, actualRamp);
    brakePercent_.setTarget(config.brakePercent, actualRamp);
    mixPercent_.setTarget(config.mixPercent, actualRamp);
    return true;
}

void NativeVinylFlickProcessor::reset() noexcept {
    writeCursor_ = 0U;
    validFrames_ = 0U;
    readCursor_ = static_cast<double>(kHistoryFrames - 3U);
    dryDelayLeft_.fill(0.0f);
    dryDelayRight_.fill(0.0f);
    dryDelayCursor_ = 0U;
    speedPercent_.reset(config_.speedPercent);
    motorReturnSeconds_.reset(config_.motorReturnSeconds);
    brakePercent_.reset(config_.brakePercent);
    mixPercent_.reset(config_.mixPercent);
    platterSpeedRatio_ = targetRatio(config_.speedPercent);
    lastWetLeft_ = 0.0f;
    lastWetRight_ = 0.0f;
    fadeFromLeft_ = 0.0f;
    fadeFromRight_ = 0.0f;
    frozenLeft_ = 0.0f;
    frozenRight_ = 0.0f;
    fadeRemaining_ = 0U;
    loopReady_ = false;
    platterStopped_ = false;
}

void NativeVinylFlickProcessor::advancePlatter(
    float targetSpeed,
    double motorReturnSeconds,
    float brakePercent
) noexcept {
    const double boundedTarget = std::clamp(static_cast<double>(targetSpeed), 0.0, 2.0);
    const double tau = std::clamp(motorReturnSeconds, 0.05, 10.0);
    const double brake = std::clamp(static_cast<double>(brakePercent) * 0.01, 0.0, 1.0);
    const double speed = std::clamp(platterSpeedRatio_, 0.0, 2.0);

    // Motor torque is a first-order velocity servo with the selected return
    // time constant. Feed-forward balances bearing friction at the requested
    // speed. The brake adds bounded velocity-dependent drag, so ordinary
    // settings still settle near the motor target instead of stalling it.
    const double brakeDamping = kMaximumBrakeDamping * brake * brake;
    const double decayRate = (1.0 / tau) + kViscousFriction + brakeDamping;
    const double equilibrium = ((boundedTarget / tau) + (kViscousFriction * boundedTarget)) / decayRate;
    const double decay = std::exp(-decayRate / static_cast<double>(sampleRate_));
    const double nextSpeed = equilibrium + ((speed - equilibrium) * decay);

    if (!std::isfinite(nextSpeed)) {
        platterSpeedRatio_ = boundedTarget;
        return;
    }
    platterSpeedRatio_ = nextSpeed <= kStoppedVelocity
        ? 0.0
        : std::clamp(nextSpeed, 0.0, 2.0);
}

void NativeVinylFlickProcessor::beginFadeFrom(float left, float right) noexcept {
    fadeFromLeft_ = left;
    fadeFromRight_ = right;
    fadeRemaining_ = kFadeFrames;
}

float NativeVinylFlickProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U) return 0.0f;

    const bool canProcess = sampleRate_ != 0U && history_ != nullptr && channels >= 2U;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const std::size_t offset = static_cast<std::size_t>(frame) * channels;
        if (canProcess) {
            const float dryLeft = sanitizeSample(interleaved[offset]);
            const float dryRight = sanitizeSample(interleaved[offset + 1U]);
            const float alignedDryLeft = dryDelayLeft_[dryDelayCursor_];
            const float alignedDryRight = dryDelayRight_[dryDelayCursor_];
            dryDelayLeft_[dryDelayCursor_] = dryLeft;
            dryDelayRight_[dryDelayCursor_] = dryRight;
            dryDelayCursor_ = (dryDelayCursor_ + 1U) % latencyFrames();
            const std::size_t currentIndex = writeCursor_;
            history_[currentIndex] = dryLeft;
            history_[kHistoryFrames + currentIndex] = dryRight;
            writeCursor_ = (writeCursor_ + 1U) & kHistoryMask;
            validFrames_ = std::min<std::size_t>(validFrames_ + 1U, kHistoryFrames);

            const double requestedSpeed = targetRatio(speedPercent_.next());
            const double motorReturn = static_cast<double>(motorReturnSeconds_.next());
            const float brake = brakePercent_.next();
            const float wetMix = std::clamp(mixPercent_.next() * 0.01f, 0.0f, 1.0f);

            const bool wasStopped = platterStopped_;
            advancePlatter(static_cast<float>(requestedSpeed), motorReturn, brake);
            platterStopped_ = platterSpeedRatio_ <= kStoppedVelocity;
            bool loopJustBecameReady = false;

            if (!wasStopped && platterStopped_) {
                frozenLeft_ = lastWetLeft_;
                frozenRight_ = lastWetRight_;
            } else if (wasStopped && !platterStopped_) {
                const double restartAge = std::max(
                    kMinimumReadAge,
                    static_cast<double>(validFrames_ > 6U ? validFrames_ / 2U : 3U)
                );
                readCursor_ = wrapCursor(static_cast<double>(currentIndex) - restartAge);
                beginFadeFrom(frozenLeft_, frozenRight_);
            }

            float wetLeft = alignedDryLeft;
            float wetRight = alignedDryRight;
            if (platterStopped_) {
                wetLeft = frozenLeft_;
                wetRight = frozenRight_;
            } else if (loopReady_) {
                wetLeft = resample(history_.get());
                wetRight = resample(history_.get() + kHistoryFrames);
                if (fadeRemaining_ != 0U) {
                    const float progress = static_cast<float>(kFadeFrames - fadeRemaining_ + 1U) /
                        static_cast<float>(kFadeFrames);
                    wetLeft = fadeFromLeft_ + (wetLeft - fadeFromLeft_) * progress;
                    wetRight = fadeFromRight_ + (wetRight - fadeFromRight_) * progress;
                    --fadeRemaining_;
                }
            }

            if (!loopReady_ && validFrames_ >= kWarmupFrames) {
                // Keep startup transparent while the circular history fills.
                // The first active frame starts at the nominal three-frame
                // causal interpolation offset.
                loopReady_ = true;
                loopJustBecameReady = true;
                readCursor_ = wrapCursor(static_cast<double>(writeCursor_) - kMinimumReadAge);
            }

            const float dryGain = 1.0f - wetMix;
            interleaved[offset] = sanitizeSample(alignedDryLeft * dryGain + wetLeft * wetMix);
            interleaved[offset + 1U] = sanitizeSample(alignedDryRight * dryGain + wetRight * wetMix);
            lastWetLeft_ = wetLeft;
            lastWetRight_ = wetRight;

            if (platterStopped_) {
                // Keep the restart head centered in valid history while the
                // output holds its frozen platter sample.
                const double age = std::max(
                    kMinimumReadAge,
                    static_cast<double>(validFrames_ > 6U ? validFrames_ / 2U : 3U)
                );
                readCursor_ = wrapCursor(static_cast<double>(writeCursor_) - age);
            } else if (loopReady_ && !loopJustBecameReady) {
                const double candidate = wrapCursor(readCursor_ + platterSpeedRatio_);
                const double nextNewest = static_cast<double>(writeCursor_);
                const std::size_t nextValidFrames = std::min<std::size_t>(validFrames_ + 1U, kHistoryFrames);
                const double nextMaximumAge = static_cast<double>(nextValidFrames) - kMinimumReadAge;
                const double candidateAge = cursorAge(writeCursor_, candidate);
                double boundedCandidate = candidate;
                if (candidateAge < kMinimumReadAge) {
                    boundedCandidate = wrapCursor(nextNewest - nextMaximumAge);
                    beginFadeFrom(lastWetLeft_, lastWetRight_);
                } else if (candidateAge > nextMaximumAge) {
                    boundedCandidate = wrapCursor(nextNewest - kMinimumReadAge);
                    beginFadeFrom(lastWetLeft_, lastWetRight_);
                }
                readCursor_ = boundedCandidate;
            } else {
                // During warm-up, use a stable one-to-one read offset. This
                // avoids reading unwritten memory when speed is edited early.
                readCursor_ = wrapCursor(static_cast<double>(writeCursor_) - kMinimumReadAge);
            }
        }

        // Additional channels pass through, while peak calculation ignores
        // any non-finite unprocessed channel rather than contaminating state.
    }

    float peak = 0.0f;
    const std::size_t sampleCount = static_cast<std::size_t>(frames) * channels;
    for (std::size_t index = 0U; index < sampleCount; ++index) {
        if (std::isfinite(interleaved[index])) peak = std::max(peak, std::fabs(interleaved[index]));
    }
    return peak;
}

} // namespace webrc::native
