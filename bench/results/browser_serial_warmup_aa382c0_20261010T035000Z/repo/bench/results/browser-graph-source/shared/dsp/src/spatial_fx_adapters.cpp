#include "webrc/dsp/spatial_fx_adapters.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr float kMinimumReverbTimeSeconds = 0.1f;
constexpr float kMaximumReverbTimeSeconds = 20.0f;
constexpr float kDefaultWet = 0.65f;

bool finite(float value) noexcept { return std::isfinite(value); }

float clean(float value) noexcept {
    if (!finite(value) || std::abs(value) < 1.0e-20f) return 0.0f;
    return std::clamp(value, -8.0f, 8.0f);
}

bool validKind(SpatialFxKind kind) noexcept {
    return kind == SpatialFxKind::ReverseDelay || kind == SpatialFxKind::GateReverb ||
           kind == SpatialFxKind::ReverseReverb;
}

bool usesReverse(SpatialFxKind kind) noexcept {
    return kind == SpatialFxKind::ReverseDelay || kind == SpatialFxKind::ReverseReverb;
}

bool usesReverb(SpatialFxKind kind) noexcept {
    return kind == SpatialFxKind::GateReverb || kind == SpatialFxKind::ReverseReverb;
}

bool validOptions(const ProcessSpec& spec, SpatialFxKind kind,
                  const SpatialFxPrepareOptions& options,
                  std::uint32_t& maxSegmentFrames, std::uint32_t& segmentFrames,
                  std::uint32_t& crossfadeFrames) noexcept {
    if (!validKind(kind) || !validProcessSpec(spec) || spec.channels != 2U ||
        !finite(options.maximumReverseSeconds) || !finite(options.reverseSegmentSeconds) ||
        !finite(options.reverseCrossfadeSeconds) || !finite(options.reverbMaximumDelaySeconds)) {
        return false;
    }
    if (usesReverb(kind) && (options.reverbMaximumDelaySeconds < 0.03f ||
                             options.reverbMaximumDelaySeconds > 2.0f)) {
        return false;
    }
    if (!usesReverse(kind)) {
        maxSegmentFrames = segmentFrames = crossfadeFrames = 0U;
        return true;
    }
    if (options.maximumReverseSeconds < 0.01f || options.maximumReverseSeconds > 1.0f ||
        options.reverseSegmentSeconds < 0.005f ||
        options.reverseSegmentSeconds > options.maximumReverseSeconds ||
        options.reverseCrossfadeSeconds < 0.0f ||
        options.reverseCrossfadeSeconds > options.reverseSegmentSeconds * 0.25f) {
        return false;
    }
    const double maximum = std::round(static_cast<double>(spec.sampleRate) *
                                      options.maximumReverseSeconds);
    const double segment = std::round(static_cast<double>(spec.sampleRate) *
                                      options.reverseSegmentSeconds);
    const double crossfade = std::round(static_cast<double>(spec.sampleRate) *
                                        options.reverseCrossfadeSeconds);
    if (!std::isfinite(maximum) || !std::isfinite(segment) || !std::isfinite(crossfade) ||
        maximum < 128.0 || segment < 64.0 || maximum > std::numeric_limits<std::uint32_t>::max() ||
        segment > maximum || crossfade > segment / 4.0 || crossfade == 1.0) {
        return false;
    }
    maxSegmentFrames = static_cast<std::uint32_t>(maximum);
    segmentFrames = static_cast<std::uint32_t>(segment);
    crossfadeFrames = static_cast<std::uint32_t>(crossfade);
    return true;
}

std::size_t addBudget(std::size_t a, std::size_t b) noexcept {
    if (b > std::numeric_limits<std::size_t>::max() - a) return 0U;
    return a + b;
}

double onePoleCoefficient(double milliseconds, double sampleRate) noexcept {
    if (!(milliseconds > 0.0) || !(sampleRate > 0.0)) return 1.0;
    return 1.0 - std::exp(-1.0 / (milliseconds * 0.001 * sampleRate));
}

} // namespace

std::uint16_t SpatialFxAdapter::effectOrdinal(SpatialFxKind kind) noexcept {
    switch (kind) {
    case SpatialFxKind::ReverseDelay: return 38U;
    case SpatialFxKind::GateReverb: return 48U;
    case SpatialFxKind::ReverseReverb: return 49U;
    }
    return 0U;
}

std::size_t SpatialFxAdapter::requiredPrepareBytes(
    const ProcessSpec& spec, SpatialFxKind kind, const SpatialFxPrepareOptions& options) noexcept {
    std::uint32_t maximumSegment = 0U;
    std::uint32_t segment = 0U;
    std::uint32_t crossfade = 0U;
    if (!validOptions(spec, kind, options, maximumSegment, segment, crossfade)) return 0U;

    // The nested estimates include their allocator allowance. This adapter
    // owns no dynamic scratch; only the fixed wrapper object and these nested
    // FDN/ReverseSegment reservations are needed.
    std::size_t total = sizeof(SpatialFxAdapter);
    if (usesReverb(kind)) {
        const auto bytes = FdnReverb::requiredPrepareBytes(
            spec, FdnLineCount::Eight, options.reverbMaximumDelaySeconds);
        if (bytes == 0U) return 0U;
        total = addBudget(total, bytes);
        if (total == 0U) return 0U;
    }
    if (usesReverse(kind)) {
        const auto bytes = ReverseSegment::requiredPrepareBytes(spec, maximumSegment);
        if (bytes == 0U) return 0U;
        total = addBudget(total, bytes);
        if (total == 0U) return 0U;
    }
    return total;
}

bool SpatialFxAdapter::prepare(const ProcessSpec& spec, SpatialFxKind kind,
                               const SpatialFxPrepareOptions& options) {
    prepared_ = false;
    std::uint32_t maximumSegment = 0U;
    std::uint32_t segment = 0U;
    std::uint32_t crossfade = 0U;
    const auto budget = requiredPrepareBytes(spec, kind, options);
    if (budget == 0U || !validOptions(spec, kind, options, maximumSegment, segment, crossfade)) {
        return false;
    }

    spec_ = spec;
    options_ = options;
    kind_ = kind;
    preparedBytes_ = budget;
    if (usesReverb(kind)) {
        if (!reverb_.prepare(spec, FdnLineCount::Eight, options.reverbMaximumDelaySeconds)) return false;
        targetRt60_ = 1.2f;
        targetDampingHz_ = std::min(8000.0f, spec.sampleRate * 0.45f);
        targetModulationRateHz_ = 0.17f;
        targetModulationDepthMs_ = 0.15f;
        if (!reverb_.setParameters(targetRt60_, targetDampingHz_, targetModulationRateHz_,
                                   targetModulationDepthMs_, 0.9995f, 1.0f, 0.0f)) {
            return false;
        }
    }
    if (usesReverse(kind)) {
        if (!reverse_.prepare(spec, maximumSegment, segment, crossfade)) return false;
    }

    targetActive_ = true;
    targetActiveGain_ = 1.0f;
    currentActiveGain_ = 1.0f;
    targetFeedback_ = kind == SpatialFxKind::ReverseDelay ? 0.25f : 0.0f;
    currentFeedback_ = targetFeedback_;
    targetWet_ = kind == SpatialFxKind::GateReverb ? 0.5f : kDefaultWet;
    currentWet_ = targetWet_;
    gateThresholdDb_ = -30.0f;
    gateThresholdLinear_ = std::pow(10.0f, gateThresholdDb_ / 20.0f);
    gateHoldMs_ = 70.0f;
    gateReleaseMs_ = 160.0f;
    smootherCoefficient_ = onePoleCoefficient(10.0, spec.sampleRate);
    gateAttackCoefficient_ = onePoleCoefficient(2.0, spec.sampleRate);
    gateReleaseCoefficient_ = onePoleCoefficient(gateReleaseMs_, spec.sampleRate);
    detectorAttackCoefficient_ = onePoleCoefficient(0.75, spec.sampleRate);
    detectorReleaseCoefficient_ = onePoleCoefficient(5.0, spec.sampleRate);
    prepared_ = true;
    reset(0U);
    return true;
}

void SpatialFxAdapter::reset(std::uint64_t absoluteFrame) noexcept {
    if (usesReverb(kind_)) {
        reverb_.reset();
        (void)reverb_.setParameters(targetRt60_, targetDampingHz_, targetModulationRateHz_,
                                    targetModulationDepthMs_, 0.9995f, 1.0f, 0.0f);
    }
    if (usesReverse(kind_)) reverse_.reset();
    expectedFrame_ = absoluteFrame;
    processedFrames_ = 0U;
    hasExpectedFrame_ = true;
    detectorEnvelope_ = 0.0f;
    gateGain_ = 0.0f;
    gateHoldRemaining_ = 0U;
    reverseFeedbackStateLeft_ = 0.0f;
    reverseFeedbackStateRight_ = 0.0f;
    currentWet_ = targetWet_;
    currentFeedback_ = targetFeedback_;
    currentActiveGain_ = targetActiveGain_;
}

bool SpatialFxAdapter::validateEvent(const SpatialFxEvent& event) const noexcept {
    if (!finite(event.value)) return false;
    switch (event.control) {
    case SpatialFxControl::Active:
        return event.value == 0.0f || event.value == 1.0f;
    case SpatialFxControl::Wet:
        return event.value >= 0.0f && event.value <= 1.0f;
    case SpatialFxControl::Feedback:
        return kind_ == SpatialFxKind::ReverseDelay && event.value >= 0.0f && event.value <= 0.9f;
    case SpatialFxControl::ReverbTimeSeconds:
        return usesReverb(kind_) && event.value >= kMinimumReverbTimeSeconds &&
               event.value <= kMaximumReverbTimeSeconds;
    case SpatialFxControl::DampingHz:
        return usesReverb(kind_) && event.value >= 50.0f && event.value <= spec_.sampleRate * 0.49f;
    case SpatialFxControl::ModulationRateHz:
        return usesReverb(kind_) && event.value >= 0.0f && event.value <= 8.0f;
    case SpatialFxControl::ModulationDepthMs:
        return usesReverb(kind_) && event.value >= 0.0f && event.value <= 5.0f;
    case SpatialFxControl::GateThresholdDb:
        return kind_ == SpatialFxKind::GateReverb && event.value >= -90.0f && event.value <= 0.0f;
    case SpatialFxControl::GateHoldMs:
        return kind_ == SpatialFxKind::GateReverb && event.value >= 0.0f && event.value <= 500.0f;
    case SpatialFxControl::GateReleaseMs:
        return kind_ == SpatialFxKind::GateReverb && event.value >= 5.0f && event.value <= 2000.0f;
    }
    return false;
}

bool SpatialFxAdapter::validateEvents(std::uint32_t frames, const SpatialFxEvent* events,
                                      std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && events == nullptr)) {
        return false;
    }
    std::uint32_t previousOffset = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        const auto& event = events[i];
        if (event.frameOffset >= frames || (i != 0U && event.frameOffset < previousOffset) ||
            !validateEvent(event)) {
            return false;
        }
        previousOffset = event.frameOffset;
    }
    return true;
}

void SpatialFxAdapter::applyReverbParameters() noexcept {
    (void)reverb_.setParameters(targetRt60_, targetDampingHz_, targetModulationRateHz_,
                                targetModulationDepthMs_, 0.9995f, 1.0f, 15.0f);
}

void SpatialFxAdapter::applyEvent(const SpatialFxEvent& event) noexcept {
    switch (event.control) {
    case SpatialFxControl::Active:
        targetActive_ = event.value == 1.0f;
        targetActiveGain_ = targetActive_ ? 1.0f : 0.0f;
        break;
    case SpatialFxControl::Wet:
        targetWet_ = event.value;
        break;
    case SpatialFxControl::Feedback:
        targetFeedback_ = event.value;
        break;
    case SpatialFxControl::ReverbTimeSeconds:
        targetRt60_ = event.value;
        applyReverbParameters();
        break;
    case SpatialFxControl::DampingHz:
        targetDampingHz_ = event.value;
        applyReverbParameters();
        break;
    case SpatialFxControl::ModulationRateHz:
        targetModulationRateHz_ = event.value;
        applyReverbParameters();
        break;
    case SpatialFxControl::ModulationDepthMs:
        targetModulationDepthMs_ = event.value;
        applyReverbParameters();
        break;
    case SpatialFxControl::GateThresholdDb:
        gateThresholdDb_ = event.value;
        gateThresholdLinear_ = std::pow(10.0f, gateThresholdDb_ / 20.0f);
        break;
    case SpatialFxControl::GateHoldMs:
        gateHoldMs_ = event.value;
        break;
    case SpatialFxControl::GateReleaseMs:
        gateReleaseMs_ = event.value;
        gateReleaseCoefficient_ = onePoleCoefficient(gateReleaseMs_, spec_.sampleRate);
        break;
    }
}

void SpatialFxAdapter::updateSmoothers() noexcept {
    currentWet_ += (targetWet_ - currentWet_) * static_cast<float>(smootherCoefficient_);
    currentFeedback_ += (targetFeedback_ - currentFeedback_) * static_cast<float>(smootherCoefficient_);
    currentActiveGain_ += (targetActiveGain_ - currentActiveGain_) *
                          static_cast<float>(smootherCoefficient_);
}

StereoFrame SpatialFxAdapter::processReverseDelay(StereoFrame input) noexcept {
    const float feedbackLeft = processedFrames_ >= reverse_.algorithmicLatencySamples()
        ? reverseFeedbackStateLeft_ : 0.0f;
    const float feedbackRight = processedFrames_ >= reverse_.algorithmicLatencySamples()
        ? reverseFeedbackStateRight_ : 0.0f;
    const float drivenLeft = clean(input.left + currentFeedback_ * feedbackLeft);
    const float drivenRight = clean(input.right + currentFeedback_ * feedbackRight);
    const StereoFrame reversed = reverse_.processSample(drivenLeft, drivenRight);
    if (processedFrames_ >= reverse_.algorithmicLatencySamples()) {
        reverseFeedbackStateLeft_ = clean(reversed.left);
        reverseFeedbackStateRight_ = clean(reversed.right);
    } else {
        reverseFeedbackStateLeft_ = 0.0f;
        reverseFeedbackStateRight_ = 0.0f;
    }
    const float mix = std::clamp(currentWet_ * currentActiveGain_, 0.0f, 1.0f);
    return {clean(input.left + mix * (reversed.left - input.left)),
            clean(input.right + mix * (reversed.right - input.right))};
}

StereoFrame SpatialFxAdapter::processGateReverb(StereoFrame input) noexcept {
    const float detector = std::max(std::abs(clean(input.left)), std::abs(clean(input.right)));
    const double detectorCoefficient = detector > detectorEnvelope_
        ? detectorAttackCoefficient_ : detectorReleaseCoefficient_;
    detectorEnvelope_ += (detector - detectorEnvelope_) * static_cast<float>(detectorCoefficient);

    float gateTarget = 0.0f;
    if (detectorEnvelope_ >= gateThresholdLinear_) {
        const double requested = static_cast<double>(gateHoldMs_) * 0.001 * spec_.sampleRate;
        gateHoldRemaining_ = requested >= static_cast<double>(std::numeric_limits<std::uint64_t>::max())
            ? std::numeric_limits<std::uint64_t>::max()
            : static_cast<std::uint64_t>(std::llround(requested));
        gateTarget = 1.0f;
    } else if (gateHoldRemaining_ != 0U) {
        --gateHoldRemaining_;
        gateTarget = 1.0f;
    }
    const double gateCoefficient = gateTarget > gateGain_
        ? gateAttackCoefficient_ : gateReleaseCoefficient_;
    gateGain_ += (gateTarget - gateGain_) * static_cast<float>(gateCoefficient);

    const StereoFrame reverberated = reverb_.processSample(input.left, input.right);
    const float effectMix = std::clamp(currentWet_ * currentActiveGain_, 0.0f, 1.0f);
    const float wetGain = effectMix * std::clamp(gateGain_, 0.0f, 1.0f);
    const float dryGain = 1.0f - effectMix;
    return {clean(dryGain * input.left + wetGain * reverberated.left),
            clean(dryGain * input.right + wetGain * reverberated.right)};
}

StereoFrame SpatialFxAdapter::processReverseReverb(StereoFrame input) noexcept {
    const StereoFrame reverberated = reverb_.processSample(input.left, input.right);
    const StereoFrame reversed = reverse_.processSample(reverberated.left, reverberated.right);
    const float mix = std::clamp(currentWet_ * currentActiveGain_, 0.0f, 1.0f);
    return {clean(input.left + mix * (reversed.left - input.left)),
            clean(input.right + mix * (reversed.right - input.right))};
}

StereoFrame SpatialFxAdapter::processSample(StereoFrame input) noexcept {
    updateSmoothers();
    switch (kind_) {
    case SpatialFxKind::ReverseDelay: return processReverseDelay(input);
    case SpatialFxKind::GateReverb: return processGateReverb(input);
    case SpatialFxKind::ReverseReverb: return processReverseReverb(input);
    }
    return input;
}

bool SpatialFxAdapter::processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                                    std::uint32_t frames, const SpatialFxEvent* events,
                                    std::uint32_t eventCount) noexcept {
    if (!prepared_ || (frames != 0U && interleaved == nullptr) || frames > spec_.maxBlockFrames ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        !validateEvents(frames, events, eventCount)) {
        return false;
    }
    if (hasExpectedFrame_ && blockStartFrame != expectedFrame_) return false;
    if (frames == 0U) {
        if (eventCount != 0U) return false;
        expectedFrame_ = blockStartFrame;
        hasExpectedFrame_ = true;
        return true;
    }

    std::uint32_t eventIndex = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame) {
            applyEvent(events[eventIndex]);
            ++eventIndex;
        }
        auto& sample = interleaved[frame];
        sample = processSample({clean(sample.left), clean(sample.right)});
        if (processedFrames_ != std::numeric_limits<std::uint64_t>::max()) ++processedFrames_;
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

std::uint32_t SpatialFxAdapter::wetPathWarmupSamples() const noexcept {
    return usesReverse(kind_) ? reverse_.algorithmicLatencySamples() : 0U;
}

} // namespace webrc::dsp
