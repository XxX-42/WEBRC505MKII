#include "webrc/dsp/temporal_fx_adapters.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>
#include <utility>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_TEMPORAL_TRY try
#define WEBRC_TEMPORAL_CATCH_ALL catch (...)
#else
// No-exception targets must admit active plus staged graph memory before
// prepare. Standard-library allocation failure is fail-fast on these targets.
#define WEBRC_TEMPORAL_TRY if (true)
#define WEBRC_TEMPORAL_CATCH_ALL else if (false)
#endif

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr float kAudioBound = 8.0f;
constexpr float kMaxSampleRate = 192000.0f;
constexpr float kMaxDelaySeconds = 2.0f;
constexpr double kMinimumTapeDelayMs = 50.0;
constexpr double kMaximumTapeWowDepthMs = 8.0;
constexpr std::size_t kMaximumAdapterBytes = 64U * 1024U * 1024U;
constexpr std::uint64_t kAllocatorAllowance = 64U * 1024U;
constexpr std::uint32_t kHistoryGuardFrames = 16U;
constexpr std::uint32_t kMinimumDelayFrames = 12U;
constexpr float kControlSmoothingMs = 5.0f;
constexpr std::uint32_t kRollOrdinalEquivalentMaxFrames = 2U * 192000U;
constexpr std::uint64_t kMaximumExactlyRepresentableFrame = 9007199254740992ULL;

[[nodiscard]] bool finiteRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] float clampAudio(float value) noexcept {
    return std::clamp(sanitize(value), -kAudioBound, kAudioBound);
}

[[nodiscard]] std::uint32_t nextPowerOfTwo(std::uint64_t value) noexcept {
    if (value == 0U || value > (std::uint64_t{1} << 31U)) return 0U;
    std::uint64_t result = 1U;
    while (result < value) result <<= 1U;
    return result <= std::numeric_limits<std::uint32_t>::max()
        ? static_cast<std::uint32_t>(result) : 0U;
}

} // namespace

bool TemporalFxAdapter::validKind(TemporalFxKind kind) noexcept {
    return static_cast<std::uint8_t>(kind) <= static_cast<std::uint8_t>(TemporalFxKind::Freeze);
}

std::uint32_t TemporalFxAdapter::historyCapacityFrames(const ProcessSpec& spec,
                                                       float seconds) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2U || !std::isfinite(seconds) ||
        seconds < 0.05f || seconds > kMaxDelaySeconds || spec.sampleRate > kMaxSampleRate) {
        return 0U;
    }
    const auto requested = static_cast<std::uint64_t>(
        std::ceil(static_cast<double>(spec.sampleRate) * seconds)) +
        spec.maxBlockFrames + kHistoryGuardFrames;
    return nextPowerOfTwo(requested);
}

std::size_t TemporalFxAdapter::requiredPrepareBytes(const ProcessSpec& spec,
                                                   TemporalFxKind kind,
                                                   const TemporalFxOptions& options) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2U || spec.sampleRate > kMaxSampleRate ||
        !validKind(kind) || !std::isfinite(options.maximumDelaySeconds) ||
        options.maximumDelaySeconds < 0.1f || options.maximumDelaySeconds > kMaxDelaySeconds ||
        !std::isfinite(options.granularCaptureSeconds) ||
        options.granularCaptureSeconds < 0.1f || options.granularCaptureSeconds > 10.0f) {
        return 0U;
    }

    std::uint64_t payload = sizeof(TemporalFxAdapter) + kAllocatorAllowance;
    switch (kind) {
    case TemporalFxKind::TapeEcho:
    case TemporalFxKind::Twist: {
        const auto frames = historyCapacityFrames(spec, options.maximumDelaySeconds);
        if (frames == 0U) return 0U;
        payload += static_cast<std::uint64_t>(frames) * sizeof(StereoFrame);
        break;
    }
    case TemporalFxKind::GranularDelay: {
        const auto bytes = GranularTexture::requiredPrepareBytes(spec,
                                                                 options.granularCaptureSeconds);
        if (bytes == 0U) return 0U;
        payload += bytes;
        break;
    }
    case TemporalFxKind::Warp: {
        const auto freezeBytes = SpectralFreeze::requiredPrepareBytes(
            spec, options.freezeWindowFrames, options.freezeHopFrames);
        const auto reverbBytes = FdnReverb::requiredPrepareBytes(spec, FdnLineCount::Eight, 0.12f);
        if (freezeBytes == 0U || reverbBytes == 0U) return 0U;
        payload += freezeBytes + reverbBytes;
        break;
    }
    case TemporalFxKind::Roll: {
        const auto bytes = PerformanceFxProcessor::requiredPrepareBytes(
            spec, PerformanceFxKind::BeatRepeat);
        if (bytes == 0U) return 0U;
        payload += bytes;
        break;
    }
    case TemporalFxKind::Freeze: {
        const auto bytes = SpectralFreeze::requiredPrepareBytes(
            spec, options.freezeWindowFrames, options.freezeHopFrames);
        if (bytes == 0U) return 0U;
        payload += bytes;
        break;
    }
    }
    if (payload > kMaximumAdapterBytes || payload > std::numeric_limits<std::size_t>::max())
        return 0U;
    return static_cast<std::size_t>(payload);
}

bool TemporalFxAdapter::prepare(const ProcessSpec& spec, TemporalFxKind kind,
                                const TemporalFxOptions& options) {
    // Prepare only a new inactive instance. A failed prepare invalidates this
    // instance; callers retain the running graph until a staged replacement is ready.
    prepared_ = false;
    const auto admittedBytes = requiredPrepareBytes(spec, kind, options);
    if (admittedBytes == 0U) return false;

    const auto capacity = (kind == TemporalFxKind::TapeEcho || kind == TemporalFxKind::Twist)
        ? historyCapacityFrames(spec, options.maximumDelaySeconds) : 0U;
    WEBRC_TEMPORAL_TRY {
        std::vector<StereoFrame> candidateHistory;
        if (capacity != 0U) candidateHistory.assign(capacity, StereoFrame{});

        bool ready = true;
        switch (kind) {
        case TemporalFxKind::TapeEcho:
            for (auto& nonlinear : tapeSaturator_) {
                ready = ready && nonlinear.prepare(spec, OversamplingFactor::x4,
                                                   NonlinearModel::AdaaCubic) &&
                        nonlinear.setDrive(driveTarget_);
            }
            ready = ready && wowLfo_.prepare(spec) && wowLfo_.setFrequency(wowRateHz_);
            break;
        case TemporalFxKind::GranularDelay:
            ready = granular_.prepare(spec, options.granularCaptureSeconds) &&
                    granular_.setParameters(grainMs_, densityHz_, pitchRatio_,
                                            positionSpread_, 1.0f, randomSeed_);
            break;
        case TemporalFxKind::Warp:
            ready = spectralFreeze_.prepare(spec, options.freezeWindowFrames,
                                             options.freezeHopFrames) &&
                    warpReverb_.prepare(spec, FdnLineCount::Eight, 0.12f) &&
                    spectralFreeze_.setFreeze(false) && spectralFreeze_.setMix(warpAmount_) &&
                    warpReverb_.setParameters(rt60Seconds_, dampingHz_, 0.21f, 0.35f,
                                              0.995f, 0.0f, 20.0f);
            break;
        case TemporalFxKind::Twist:
            ready = twistInertia_.prepare(spec) && twistInertia_.setInertia(1.7f, 0.9f);
            break;
        case TemporalFxKind::Roll:
            ready = roll_.prepare(spec);
            break;
        case TemporalFxKind::Freeze:
            ready = spectralFreeze_.prepare(spec, options.freezeWindowFrames,
                                             options.freezeHopFrames) &&
                    spectralFreeze_.setFreeze(false) && spectralFreeze_.setMix(0.0f);
            break;
        }
        if (!ready) return false;

        if (capacity != 0U) history_ = std::move(candidateHistory);
        else history_.clear();
        spec_ = spec;
        options_ = options;
        kind_ = kind;
        preparedBytes_ = admittedBytes;
        historyFrames_ = capacity;
        historyMask_ = capacity == 0U ? 0U : capacity - 1U;
        if (kind == TemporalFxKind::TapeEcho) {
            const float maximumBaseDelayMs = std::min(800.0f,
                options.maximumDelaySeconds * 1000.0f / 1.5f);
            delayMsTarget_ = std::clamp(240.0f, 50.0f,
                                         maximumBaseDelayMs - wowDepthMsTarget_);
        } else if (kind == TemporalFxKind::Twist) {
            delayMsTarget_ = std::clamp(180.0f, 30.0f,
                                        options.maximumDelaySeconds * 1000.0f);
        }
        prepareInterpolationTable();
        controlSmoothingCoefficient_ = 1.0 - std::exp(
            -1.0 / (static_cast<double>(spec.sampleRate) * kControlSmoothingMs * 0.001));
        toneCoefficientCurrent_ = 1.0 - std::exp(-2.0 * kPi * toneHzCurrent_ / spec.sampleRate);
        toneCoefficientTarget_ = toneCoefficientCurrent_;
        activeTarget_ = 0.0f;
        activeCurrent_ = 0.0f;
        wetTarget_ = kind == TemporalFxKind::TapeEcho ? 0.42f : 0.65f;
        wetCurrent_ = wetTarget_;
        expectedFrame_ = 0U;
        freezeWindowFrames_ = options.freezeWindowFrames;
        freezeHopFrames_ = options.freezeHopFrames;
        prepared_ = true;
        reset();
        return true;
    } WEBRC_TEMPORAL_CATCH_ALL {
        history_.clear();
        return false;
    }
}

void TemporalFxAdapter::prepareInterpolationTable() noexcept {
    for (std::uint32_t phase = 0U; phase <= kInterpolationPhaseCount; ++phase) {
        const double fraction = static_cast<double>(phase) / kInterpolationPhaseCount;
        double sum = 0.0;
        for (std::int32_t tap = -3; tap <= 4; ++tap) {
            const double distance = fraction - static_cast<double>(tap);
            const double absoluteDistance = std::fabs(distance);
            double weight = 0.0;
            if (absoluteDistance < 4.0) {
                const double sinc = absoluteDistance < 1.0e-12 ? 1.0 :
                    std::sin(kPi * distance) / (kPi * distance);
                const double window = 0.5 + 0.5 * std::cos(kPi * distance / 4.0);
                weight = sinc * window;
            }
            const auto index = static_cast<std::uint32_t>(tap + 3);
            sinc8Table_[phase][index] = static_cast<float>(weight);
            sum += weight;
        }
        if (std::fabs(sum) > 1.0e-15) {
            for (auto& coefficient : sinc8Table_[phase])
                coefficient = static_cast<float>(coefficient / sum);
        }
    }
}

void TemporalFxAdapter::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    absoluteFrame = std::min(absoluteFrame, kMaximumExactlyRepresentableFrame);
    activeCurrent_ = activeTarget_ = 0.0f;
    std::fill(history_.begin(), history_.end(), StereoFrame{});
    if (kind_ == TemporalFxKind::TapeEcho) {
        for (auto& nonlinear : tapeSaturator_) nonlinear.reset();
        wowLfo_.reset();
    } else if (kind_ == TemporalFxKind::GranularDelay) {
        granular_.reset();
        granularFeedbackState_ = {};
    } else if (kind_ == TemporalFxKind::Warp || kind_ == TemporalFxKind::Freeze) {
        spectralFreeze_.reset();
        (void)spectralFreeze_.setFreeze(false);
        freezeRequested_ = false;
        if (kind_ == TemporalFxKind::Warp) {
            warpReverb_.reset();
            updateWarpParameters();
        }
    } else if (kind_ == TemporalFxKind::Twist) {
        const float resetSpeed = 1.0f + 3.0f * twistMacro_;
        twistInertia_.reset(resetSpeed);
        (void)twistInertia_.setInertia(1.7f, 0.9f);
        (void)twistInertia_.setTargetSpeed(resetSpeed);
        twistReadPosition_ = static_cast<double>(absoluteFrame) -
            static_cast<double>(delayMsCurrent_) * spec_.sampleRate / 1000.0;
        twistReadInitialized_ = false;
    } else if (kind_ == TemporalFxKind::Roll) {
        roll_.reset(absoluteFrame);
    }
    std::fill(feedbackFilterState_.begin(), feedbackFilterState_.end(), 0.0f);
    wetCurrent_ = wetTarget_;
    feedbackCurrent_ = feedbackTarget_;
    delayMsCurrent_ = delayMsTarget_;
    toneHzCurrent_ = toneHzTarget_;
    toneCoefficientCurrent_ = toneCoefficientTarget_;
    wowDepthMsCurrent_ = wowDepthMsTarget_;
    driveCurrent_ = driveTarget_;
    twistMacroCurrent_ = twistMacro_;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = true;
}

bool TemporalFxAdapter::setSeed(std::uint64_t seed) noexcept {
    if (!prepared_ || activeTarget_ != 0.0f || activeCurrent_ != 0.0f) return false;
    if (kind_ == TemporalFxKind::Roll) return roll_.setSeed(seed);
    if (kind_ != TemporalFxKind::GranularDelay) return false;
    randomSeed_ = seed == 0U ? 0x6a09e667f3bcc909ULL : seed;
    return granular_.setParameters(grainMs_, densityHz_, pitchRatio_, positionSpread_,
                                   1.0f, randomSeed_);
}

bool TemporalFxAdapter::validateEvent(const TemporalFxEvent& event) const noexcept {
    if (!std::isfinite(event.value)) return false;
    if (event.control == TemporalFxControl::Active)
        return finiteRange(event.value, 0.0f, 1.0f);
    if (event.control == TemporalFxControl::Wet)
        return finiteRange(event.value, 0.0f, 1.0f);
    switch (kind_) {
    case TemporalFxKind::TapeEcho:
        switch (event.control) {
        case TemporalFxControl::DelayMs:
            return finiteRange(event.value, 50.0f,
                std::min(800.0f, options_.maximumDelaySeconds * 1000.0f / 1.5f));
        case TemporalFxControl::Feedback: return finiteRange(event.value, 0.0f, 0.92f);
        case TemporalFxControl::ToneHz:
            return finiteRange(event.value, 100.0f, std::min(16000.0f, spec_.sampleRate * 0.45f));
        case TemporalFxControl::WowDepthMs: return finiteRange(event.value, 0.0f, 8.0f);
        case TemporalFxControl::WowRateHz: return finiteRange(event.value, 0.02f, 8.0f);
        case TemporalFxControl::Drive: return finiteRange(event.value, 1.0f, 16.0f);
        default: return false;
        }
    case TemporalFxKind::GranularDelay:
        switch (event.control) {
        case TemporalFxControl::Feedback: return finiteRange(event.value, 0.0f, 0.78f);
        case TemporalFxControl::GrainMs: return finiteRange(event.value, 12.0f, 800.0f);
        case TemporalFxControl::DensityHz: return finiteRange(event.value, 1.0f, 80.0f);
        case TemporalFxControl::PitchRatio: return finiteRange(event.value, 0.25f, 4.0f);
        case TemporalFxControl::PositionSpread: return finiteRange(event.value, 0.0f, 1.0f);
        default: return false;
        }
    case TemporalFxKind::Warp:
        switch (event.control) {
        case TemporalFxControl::Freeze: return finiteRange(event.value, 0.0f, 1.0f);
        case TemporalFxControl::WarpAmount: return finiteRange(event.value, 0.0f, 1.0f);
        case TemporalFxControl::ReverbTimeSeconds: return finiteRange(event.value, 0.25f, 12.0f);
        case TemporalFxControl::DampingHz:
            return finiteRange(event.value, 100.0f, std::min(18000.0f, spec_.sampleRate * 0.45f));
        default: return false;
        }
    case TemporalFxKind::Twist:
        switch (event.control) {
        case TemporalFxControl::DelayMs:
            return finiteRange(event.value, 30.0f, options_.maximumDelaySeconds * 1000.0f);
        case TemporalFxControl::TwistMacro: return finiteRange(event.value, -1.0f, 1.0f);
        case TemporalFxControl::Feedback: return finiteRange(event.value, 0.0f, 0.85f);
        case TemporalFxControl::ToneHz:
            return finiteRange(event.value, 100.0f, std::min(16000.0f, spec_.sampleRate * 0.45f));
        default: return false;
        }
    case TemporalFxKind::Roll:
        switch (event.control) {
        case TemporalFxControl::TempoBpm: return finiteRange(event.value, 20.0f, 300.0f);
        case TemporalFxControl::SubdivisionBeats: return finiteRange(event.value, 0.0625f, 4.0f);
        case TemporalFxControl::Feedback: return finiteRange(event.value, 0.0f, 0.95f);
        default: return false;
        }
    case TemporalFxKind::Freeze:
        return event.control == TemporalFxControl::Freeze && finiteRange(event.value, 0.0f, 1.0f);
    }
    return false;
}

bool TemporalFxAdapter::validateEvents(std::uint32_t frames, const TemporalFxEvent* events,
                                       std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && events == nullptr))
        return false;
    std::uint32_t previous = 0U;
    float projectedDelayMs = delayMsTarget_;
    float projectedWowDepthMs = wowDepthMsTarget_;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames || (i != 0U && events[i].frameOffset < previous) ||
            !validateEvent(events[i])) return false;
        if (kind_ == TemporalFxKind::TapeEcho) {
            if (events[i].control == TemporalFxControl::DelayMs)
                projectedDelayMs = events[i].value;
            else if (events[i].control == TemporalFxControl::WowDepthMs)
                projectedWowDepthMs = events[i].value;
            const bool endOfFrameEvents = i + 1U == eventCount ||
                events[i + 1U].frameOffset != events[i].frameOffset;
            if (endOfFrameEvents) {
                const double maximumExcursionMs = 1.5 *
                    (static_cast<double>(projectedDelayMs) + projectedWowDepthMs);
                if (maximumExcursionMs >
                    static_cast<double>(options_.maximumDelaySeconds) * 1000.0 + 1.0e-5)
                    return false;
            }
        }
        previous = events[i].frameOffset;
    }
    return true;
}

void TemporalFxAdapter::applyEvent(const TemporalFxEvent& event,
                                   std::uint64_t absoluteFrame) noexcept {
    if (event.control == TemporalFxControl::Active) {
        activeTarget_ = event.value;
        if (kind_ == TemporalFxKind::Warp) updateWarpParameters();
        return;
    }
    if (event.control == TemporalFxControl::Wet) {
        wetTarget_ = event.value;
        if (kind_ == TemporalFxKind::Warp) updateWarpParameters();
        return;
    }
    switch (kind_) {
    case TemporalFxKind::TapeEcho:
        switch (event.control) {
        case TemporalFxControl::DelayMs: delayMsTarget_ = event.value; break;
        case TemporalFxControl::Feedback: feedbackTarget_ = event.value; break;
        case TemporalFxControl::ToneHz:
            toneHzTarget_ = event.value;
            toneCoefficientTarget_ = 1.0 - std::exp(
                -2.0 * kPi * static_cast<double>(toneHzTarget_) / spec_.sampleRate);
            break;
        case TemporalFxControl::WowDepthMs: wowDepthMsTarget_ = event.value; break;
        case TemporalFxControl::WowRateHz:
            wowRateHz_ = event.value;
            (void)wowLfo_.setFrequency(wowRateHz_);
            break;
        case TemporalFxControl::Drive:
            driveTarget_ = event.value;
            break;
        default: break;
        }
        break;
    case TemporalFxKind::GranularDelay:
        {
        bool updateGrainParameters = false;
        switch (event.control) {
        case TemporalFxControl::Feedback: feedbackTarget_ = event.value; break;
        case TemporalFxControl::GrainMs: grainMs_ = event.value; updateGrainParameters = true; break;
        case TemporalFxControl::DensityHz: densityHz_ = event.value; updateGrainParameters = true; break;
        case TemporalFxControl::PitchRatio: pitchRatio_ = event.value; updateGrainParameters = true; break;
        case TemporalFxControl::PositionSpread:
            positionSpread_ = event.value; updateGrainParameters = true; break;
        default: break;
        }
        if (updateGrainParameters)
            (void)granular_.setParameters(grainMs_, densityHz_, pitchRatio_,
                                          positionSpread_, 1.0f, randomSeed_);
        break;
        }
    case TemporalFxKind::Warp:
        switch (event.control) {
        case TemporalFxControl::Freeze:
            freezeRequested_ = event.value >= 0.5f;
            (void)spectralFreeze_.setFreeze(freezeRequested_);
            break;
        case TemporalFxControl::WarpAmount: warpAmount_ = event.value; break;
        case TemporalFxControl::ReverbTimeSeconds: rt60Seconds_ = event.value; break;
        case TemporalFxControl::DampingHz: dampingHz_ = event.value; break;
        default: break;
        }
        updateWarpParameters();
        break;
    case TemporalFxKind::Twist:
        switch (event.control) {
        case TemporalFxControl::DelayMs: delayMsTarget_ = event.value; break;
        case TemporalFxControl::TwistMacro:
            twistMacro_ = event.value;
            feedbackTarget_ = 0.80f * std::fabs(twistMacro_);
            toneHzTarget_ = 14000.0f - 12000.0f * std::fabs(twistMacro_);
            toneCoefficientTarget_ = 1.0 - std::exp(
                -2.0 * kPi * static_cast<double>(toneHzTarget_) / spec_.sampleRate);
            (void)twistInertia_.setTargetSpeed(1.0f + 3.0f * twistMacro_);
            break;
        case TemporalFxControl::Feedback: feedbackTarget_ = event.value; break;
        case TemporalFxControl::ToneHz:
            toneHzTarget_ = event.value;
            toneCoefficientTarget_ = 1.0 - std::exp(
                -2.0 * kPi * static_cast<double>(toneHzTarget_) / spec_.sampleRate);
            break;
        default: break;
        }
        break;
    case TemporalFxKind::Roll:
        break;
    case TemporalFxKind::Freeze:
        if (event.control == TemporalFxControl::Freeze) {
            freezeRequested_ = event.value >= 0.5f;
            (void)spectralFreeze_.setFreeze(freezeRequested_);
        }
        break;
    }
    (void)absoluteFrame;
}

void TemporalFxAdapter::advanceControls() noexcept {
    const auto smooth = [this](float current, float target) noexcept {
        return current + (target - current) * static_cast<float>(controlSmoothingCoefficient_);
    };
    activeCurrent_ = smooth(activeCurrent_, activeTarget_);
    wetCurrent_ = smooth(wetCurrent_, wetTarget_);
    feedbackCurrent_ = smooth(feedbackCurrent_, feedbackTarget_);
    delayMsCurrent_ += (static_cast<double>(delayMsTarget_) - delayMsCurrent_) *
                       controlSmoothingCoefficient_;
    if (std::fabs(static_cast<double>(delayMsTarget_) - delayMsCurrent_) < 1.0e-10)
        delayMsCurrent_ = delayMsTarget_;
    toneHzCurrent_ = smooth(toneHzCurrent_, toneHzTarget_);
    toneCoefficientCurrent_ += (toneCoefficientTarget_ - toneCoefficientCurrent_) *
                                controlSmoothingCoefficient_;
    wowDepthMsCurrent_ = smooth(wowDepthMsCurrent_, wowDepthMsTarget_);
    driveCurrent_ = smooth(driveCurrent_, driveTarget_);
    twistMacroCurrent_ = smooth(twistMacroCurrent_, twistMacro_);
}

void TemporalFxAdapter::writeHistory(std::uint64_t absoluteFrame,
                                     StereoFrame sample) noexcept {
    if (history_.empty()) return;
    const auto index = static_cast<std::uint32_t>(absoluteFrame) & historyMask_;
    history_[index] = {clampAudio(sample.left), clampAudio(sample.right)};
}

StereoFrame TemporalFxAdapter::readHistory(double absoluteFrame,
                                           std::uint64_t newestFrame) const noexcept {
    if (history_.empty() || !std::isfinite(absoluteFrame) || absoluteFrame < 0.0 ||
        absoluteFrame > static_cast<double>(newestFrame) ||
        absoluteFrame > static_cast<double>(std::numeric_limits<std::int64_t>::max() - 4)) return {};
    const auto base = static_cast<std::int64_t>(std::floor(absoluteFrame));
    const double fraction = absoluteFrame - static_cast<double>(base);
    const double phasePosition = fraction * kInterpolationPhaseCount;
    const auto phase = std::min<std::uint32_t>(
        static_cast<std::uint32_t>(std::floor(phasePosition)), kInterpolationPhaseCount - 1U);
    const float phaseBlend = static_cast<float>(phasePosition - phase);
    const std::int64_t center = base;
    double left = 0.0;
    double right = 0.0;
    for (std::int32_t tap = -3; tap <= 4; ++tap) {
        const auto sampleFrame = center + tap;
        if (sampleFrame < 0 || static_cast<std::uint64_t>(sampleFrame) > newestFrame ||
            newestFrame - static_cast<std::uint64_t>(sampleFrame) >= history_.size()) continue;
        const auto index = static_cast<std::uint32_t>(sampleFrame) & historyMask_;
        const auto tapIndex = static_cast<std::uint32_t>(tap + 3);
        const float weight = sinc8Table_[phase][tapIndex] +
            phaseBlend * (sinc8Table_[phase + 1U][tapIndex] - sinc8Table_[phase][tapIndex]);
        left += static_cast<double>(history_[index].left) * weight;
        right += static_cast<double>(history_[index].right) * weight;
    }
    return {sanitize(static_cast<float>(left)), sanitize(static_cast<float>(right))};
}

StereoFrame TemporalFxAdapter::processTapeEcho(StereoFrame input,
                                                std::uint64_t absoluteFrame) noexcept {
    const float wow = wowLfo_.next();
    const double baseDelay = std::max<double>(kMinimumDelayFrames,
        (delayMsCurrent_ + static_cast<double>(wow * wowDepthMsCurrent_)) * spec_.sampleRate / 1000.0);
    const auto first = readHistory(static_cast<double>(absoluteFrame) - baseDelay,
                                   absoluteFrame == 0U ? 0U : absoluteFrame - 1U);
    const auto second = readHistory(static_cast<double>(absoluteFrame) - baseDelay * 1.5,
                                    absoluteFrame == 0U ? 0U : absoluteFrame - 1U);
    const StereoFrame wet{0.67f * first.left + 0.33f * second.left,
                          0.67f * first.right + 0.33f * second.right};
    feedbackFilterState_[0] += static_cast<float>(toneCoefficientCurrent_) *
        (wet.left - feedbackFilterState_[0]);
    feedbackFilterState_[1] += static_cast<float>(toneCoefficientCurrent_) *
        (wet.right - feedbackFilterState_[1]);
    // ADAA's maximum small-signal slope is 1.5 * drive. Apply a strictly
    // monotonic normalization of the requested feedback so the effective
    // small-signal loop gain stays below 0.8 while preserving the full control
    // range at every drive setting.
    const float loopFeedback = feedbackCurrent_ * (0.8f /
        std::max(1.0f, 1.5f * driveCurrent_));
    for (std::uint32_t channel = 0U; channel < 2U; ++channel)
        (void)tapeSaturator_[channel].setDrive(driveCurrent_);
    const StereoFrame recorded{
        tapeSaturator_[0].processSample(clampAudio(input.left + loopFeedback * feedbackFilterState_[0])),
        tapeSaturator_[1].processSample(clampAudio(input.right + loopFeedback * feedbackFilterState_[1]))};
    writeHistory(absoluteFrame, recorded);
    const float mix = std::clamp(activeCurrent_ * wetCurrent_, 0.0f, 1.0f);
    return {sanitize(input.left + (wet.left - input.left) * mix),
            sanitize(input.right + (wet.right - input.right) * mix)};
}

StereoFrame TemporalFxAdapter::processGranularDelay(StereoFrame input) noexcept {
    const StereoFrame excitation{clampAudio(input.left + feedbackCurrent_ * granularFeedbackState_.left),
                                 clampAudio(input.right + feedbackCurrent_ * granularFeedbackState_.right)};
    const auto cloud = granular_.processSample(excitation.left, excitation.right);
    granularFeedbackState_ = cloud;
    const float mix = std::clamp(activeCurrent_ * wetCurrent_, 0.0f, 1.0f);
    return {sanitize(input.left + (cloud.left - input.left) * mix),
            sanitize(input.right + (cloud.right - input.right) * mix)};
}

StereoFrame TemporalFxAdapter::processWarp(StereoFrame input) noexcept {
    const float enabledWarp = std::clamp(activeCurrent_ * wetCurrent_ * warpAmount_, 0.0f, 1.0f);
    (void)spectralFreeze_.setMix(enabledWarp);
    const auto frozen = spectralFreeze_.processSample(input.left, input.right);
    return warpReverb_.processSample(frozen.left, frozen.right);
}

StereoFrame TemporalFxAdapter::processFreeze(StereoFrame input) noexcept {
    (void)spectralFreeze_.setMix(std::clamp(activeCurrent_ * wetCurrent_, 0.0f, 1.0f));
    return spectralFreeze_.processSample(input.left, input.right);
}

void TemporalFxAdapter::updateWarpParameters() noexcept {
    (void)spectralFreeze_.setMix(std::clamp(warpAmount_ * activeTarget_ * wetTarget_, 0.0f, 1.0f));
    const float fdnWet = std::clamp(activeTarget_ * wetTarget_ *
                                    (0.12f + 0.68f * warpAmount_), 0.0f, 0.8f);
    (void)warpReverb_.setParameters(rt60Seconds_, dampingHz_, 0.21f, 0.35f,
                                    0.995f, fdnWet, 20.0f);
}

StereoFrame TemporalFxAdapter::processTwist(StereoFrame input,
                                             std::uint64_t absoluteFrame) noexcept {
    if (!twistReadInitialized_) {
        twistReadPosition_ = static_cast<double>(absoluteFrame) -
            static_cast<double>(delayMsCurrent_) * spec_.sampleRate / 1000.0;
        twistReadInitialized_ = true;
    }
    const auto maximumAge = static_cast<std::uint64_t>(std::ceil(
        static_cast<double>(spec_.sampleRate) * options_.maximumDelaySeconds));
    const double oldest = absoluteFrame > maximumAge + 8U
        ? static_cast<double>(absoluteFrame - maximumAge + 8U) : 0.0;
    const double latest = absoluteFrame > 8U ? static_cast<double>(absoluteFrame - 8U) : 0.0;
    twistReadPosition_ = std::clamp(twistReadPosition_, oldest, latest);
    auto wet = readHistory(twistReadPosition_, absoluteFrame == 0U ? 0U : absoluteFrame - 1U);
    feedbackFilterState_[0] += static_cast<float>(toneCoefficientCurrent_) *
        (wet.left - feedbackFilterState_[0]);
    feedbackFilterState_[1] += static_cast<float>(toneCoefficientCurrent_) *
        (wet.right - feedbackFilterState_[1]);
    const float macroPan = std::clamp(twistMacroCurrent_ * 0.42f, -0.42f, 0.42f);
    if (macroPan > 0.0f) {
        const float left = wet.left;
        wet.left = left * (1.0f - macroPan);
        wet.right = sanitize(wet.right + left * macroPan);
    } else if (macroPan < 0.0f) {
        const float right = wet.right;
        wet.right = right * (1.0f + macroPan);
        wet.left = sanitize(wet.left - right * macroPan);
    }
    writeHistory(absoluteFrame,
                 {input.left + feedbackCurrent_ * feedbackFilterState_[0],
                  input.right + feedbackCurrent_ * feedbackFilterState_[1]});
    const float mix = std::clamp(activeCurrent_ * wetCurrent_, 0.0f, 1.0f);
    const auto output = StereoFrame{sanitize(input.left + (wet.left - input.left) * mix),
                                    sanitize(input.right + (wet.right - input.right) * mix)};
    const float speed = twistInertia_.nextSpeedRatio();
    twistReadPosition_ += static_cast<double>(speed);
    return output;
}

StereoFrame TemporalFxAdapter::processSample(StereoFrame input,
                                             std::uint64_t absoluteFrame) noexcept {
    advanceControls();
    switch (kind_) {
    case TemporalFxKind::TapeEcho: return processTapeEcho(input, absoluteFrame);
    case TemporalFxKind::GranularDelay: return processGranularDelay(input);
    case TemporalFxKind::Warp: return processWarp(input);
    case TemporalFxKind::Twist: return processTwist(input, absoluteFrame);
    case TemporalFxKind::Roll:
        break;
    case TemporalFxKind::Freeze: return processFreeze(input);
    }
    return input;
}

bool TemporalFxAdapter::processBlock(std::uint64_t blockStartFrame,
                                     StereoFrame* interleaved, std::uint32_t frames,
                                     const TemporalFxEvent* events,
                                     std::uint32_t eventCount) noexcept {
    if (!prepared_ || frames > spec_.maxBlockFrames ||
        (frames != 0U && interleaved == nullptr) ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        blockStartFrame + frames > kMaximumExactlyRepresentableFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;

    if (kind_ == TemporalFxKind::Roll) {
        for (std::uint32_t i = 0U; i < eventCount; ++i) {
            PerformanceFxControl control{};
            switch (events[i].control) {
            case TemporalFxControl::Active: control = PerformanceFxControl::Active; break;
            case TemporalFxControl::Wet: control = PerformanceFxControl::Wet; break;
            case TemporalFxControl::Feedback: control = PerformanceFxControl::Feedback; break;
            case TemporalFxControl::TempoBpm: control = PerformanceFxControl::TempoBpm; break;
            case TemporalFxControl::SubdivisionBeats: control = PerformanceFxControl::SubdivisionBeats; break;
            case TemporalFxControl::PitchRatio: control = PerformanceFxControl::PitchRatio; break;
            default: return false;
            }
            rollEvents_[i] = {events[i].frameOffset, control, events[i].value};
        }
        const bool ok = roll_.processBlock(blockStartFrame, interleaved, frames,
            eventCount == 0U ? nullptr : rollEvents_.data(), eventCount);
        if (ok) { expectedFrame_ = blockStartFrame + frames; hasExpectedFrame_ = true; }
        return ok;
    }

    if (frames == 0U) return eventCount == 0U;
    std::uint32_t eventIndex = 0U;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const auto absoluteFrame = blockStartFrame + i;
        while (eventIndex < eventCount && events[eventIndex].frameOffset == i) {
            applyEvent(events[eventIndex], absoluteFrame);
            ++eventIndex;
        }
        const auto sample = processSample({clampAudio(interleaved[i].left),
                                           clampAudio(interleaved[i].right)}, absoluteFrame);
        interleaved[i] = sample;
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

TemporalFxLatency TemporalFxAdapter::latency() const noexcept {
    TemporalFxLatency result{};
    if (!prepared_) return result;
    switch (kind_) {
    case TemporalFxKind::TapeEcho:
        result.fixedAlgorithmicSamples = 0;
        result.minimumWetDelaySamples = static_cast<std::uint32_t>(std::ceil(
            static_cast<double>(spec_.sampleRate) *
            (kMinimumTapeDelayMs - kMaximumTapeWowDepthMs) / 1000.0));
        result.maximumWetDelaySamples = static_cast<std::uint32_t>(std::ceil(
            spec_.sampleRate * options_.maximumDelaySeconds));
        result.wetPathGroupDelaySamples = tapeSaturator_[0].lowFrequencySmallSignalGroupDelaySamples();
        break;
    case TemporalFxKind::GranularDelay:
        result.fixedAlgorithmicSamples = -1;
        result.maximumWetDelaySamples = static_cast<std::uint32_t>(
            std::ceil(spec_.sampleRate * options_.granularCaptureSeconds));
        break;
    case TemporalFxKind::Warp:
    case TemporalFxKind::Freeze:
        result.fixedAlgorithmicSamples = static_cast<std::int32_t>(freezeWindowFrames_);
        result.minimumWetDelaySamples = freezeWindowFrames_;
        result.maximumWetDelaySamples = freezeWindowFrames_;
        break;
    case TemporalFxKind::Twist:
        result.fixedAlgorithmicSamples = 0;
        // The variable-rate read head can catch up to its causal sinc guard.
        result.minimumWetDelaySamples = 4U;
        result.maximumWetDelaySamples = static_cast<std::uint32_t>(
            std::ceil(spec_.sampleRate * options_.maximumDelaySeconds));
        break;
    case TemporalFxKind::Roll:
        result.fixedAlgorithmicSamples = -1;
        result.maximumWetDelaySamples = roll_.repeatFrames() == 0U
            ? kRollOrdinalEquivalentMaxFrames : roll_.repeatFrames();
        break;
    }
    return result;
}

std::uint32_t TemporalFxAdapter::activeGrains() const noexcept {
    return prepared_ && (kind_ == TemporalFxKind::GranularDelay)
        ? granular_.activeGrains() : 0U;
}

std::uint32_t TemporalFxAdapter::repeatFrames() const noexcept {
    return prepared_ && kind_ == TemporalFxKind::Roll ? roll_.repeatFrames() : 0U;
}

} // namespace webrc::dsp
