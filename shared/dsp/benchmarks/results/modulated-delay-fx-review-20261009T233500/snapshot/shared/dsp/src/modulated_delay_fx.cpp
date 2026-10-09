#include "webrc/dsp/modulated_delay_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kParameterSmoothingSeconds = 0.010;
constexpr double kFeedbackHighpassHz = 20.0;
constexpr std::uint32_t kRingGuardFrames = ModulatedDelayFx::kInterpolationTaps + 8U;

struct Defaults {
    float rateHz;
    float baseDelayMs;
    float depthMs;
    float feedback;
    float wet;
    float pan;
    float panDepth;
    float crossFeedback;
    double rightLfoPhase;
};

[[nodiscard]] bool validKind(ModulatedDelayKind kind) noexcept {
    return static_cast<std::uint8_t>(kind) <=
           static_cast<std::uint8_t>(ModulatedDelayKind::PanningDelay);
}

[[nodiscard]] double maximumDelayMs(ModulatedDelayKind kind) noexcept {
    switch (kind) {
    case ModulatedDelayKind::Flanger: return 30.0;
    case ModulatedDelayKind::Chorus: return 120.0;
    case ModulatedDelayKind::Vibrato: return 35.0;
    case ModulatedDelayKind::ModDelay: return 2000.0;
    case ModulatedDelayKind::PanningDelay: return 2000.0;
    }
    return 0.0;
}

[[nodiscard]] double maximumDepthMs(ModulatedDelayKind kind) noexcept {
    switch (kind) {
    case ModulatedDelayKind::Flanger: return 8.0;
    case ModulatedDelayKind::Chorus: return 20.0;
    case ModulatedDelayKind::Vibrato: return 10.0;
    case ModulatedDelayKind::ModDelay: return 50.0;
    case ModulatedDelayKind::PanningDelay: return 50.0;
    }
    return 0.0;
}

[[nodiscard]] Defaults defaultsFor(ModulatedDelayKind kind) noexcept {
    switch (kind) {
    case ModulatedDelayKind::Flanger: return {0.25f, 8.0f, 5.5f, 0.52f, 0.45f,
                                              0.0f, 0.0f, 0.0f, 0.5};
    case ModulatedDelayKind::Chorus: return {0.8f, 30.0f, 8.0f, 0.20f, 0.48f,
                                             0.0f, 0.0f, 0.0f, 0.25};
    case ModulatedDelayKind::Vibrato: return {5.0f, 10.0f, 4.0f, 0.0f, 1.0f,
                                              0.0f, 0.0f, 0.0f, 0.5};
    case ModulatedDelayKind::ModDelay: return {0.45f, 280.0f, 12.0f, 0.28f, 0.40f,
                                               0.0f, 0.0f, 0.0f, 0.25};
    case ModulatedDelayKind::PanningDelay: return {0.5f, 280.0f, 12.0f, 0.42f, 0.42f,
                                                   0.0f, 0.72f, 0.88f, 0.5};
    }
    return {};
}

[[nodiscard]] std::uint32_t ringFramesFor(const ProcessSpec& spec,
                                           ModulatedDelayKind kind) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2U || spec.sampleRate > 192000.0f ||
        !validKind(kind)) return 0U;
    const double requested = std::ceil(static_cast<double>(spec.sampleRate) *
                                       maximumDelayMs(kind) * 0.001) + kRingGuardFrames;
    if (!std::isfinite(requested) || requested <= 0.0 ||
        requested > static_cast<double>(std::numeric_limits<std::uint32_t>::max() / 2U))
        return 0U;
    const auto needed = static_cast<std::uint64_t>(requested);
    std::uint64_t size = 1U;
    while (size < needed) size <<= 1U;
    return size <= std::numeric_limits<std::uint32_t>::max()
        ? static_cast<std::uint32_t>(size) : 0U;
}

[[nodiscard]] bool finiteInRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] float boundedAudio(float value) noexcept {
    return std::clamp(sanitize(value), -8.0f, 8.0f);
}

[[nodiscard]] double sinc(double x) noexcept {
    if (std::fabs(x) < 1.0e-12) return 1.0;
    const double angle = kPi * x;
    return std::sin(angle) / angle;
}

} // namespace

std::size_t ModulatedDelayFx::requiredPrepareBytes(const ProcessSpec& spec,
                                                  ModulatedDelayKind kind) noexcept {
    const auto frames = ringFramesFor(spec, kind);
    if (frames == 0U) return 0U;
    const auto bytesPerFrame = sizeof(StereoFrame) + sizeof(std::uint32_t);
    const auto frameBytes = static_cast<std::size_t>(frames) * bytesPerFrame;
    if (frameBytes > std::numeric_limits<std::size_t>::max() - sizeof(ModulatedDelayFx))
        return 0U;
    return sizeof(ModulatedDelayFx) + frameBytes;
}

std::uint16_t ModulatedDelayFx::effectOrdinal(ModulatedDelayKind kind) noexcept {
    switch (kind) {
    case ModulatedDelayKind::Flanger: return 5U;
    case ModulatedDelayKind::Vibrato: return 33U;
    case ModulatedDelayKind::PanningDelay: return 37U;
    case ModulatedDelayKind::ModDelay: return 39U;
    case ModulatedDelayKind::Chorus: return 46U;
    }
    return 0U;
}

bool ModulatedDelayFx::prepare(const ProcessSpec& spec, ModulatedDelayKind kind) {
    const auto bytes = requiredPrepareBytes(spec, kind);
    const auto frames = ringFramesFor(spec, kind);
    if (bytes == 0U || frames == 0U) return false;
    prepared_ = false;

#if defined(__cpp_exceptions)
    try {
        delayLine_.assign(frames, StereoFrame{});
        generationTags_.assign(frames, 0U);
    } catch (...) {
        delayLine_.clear();
        generationTags_.clear();
        return false;
    }
#else
    // WASM builds disable exceptions. Hosts must admit this exact payload via
    // requiredPrepareBytes() and prepare a staged instance before graph swap.
    delayLine_.assign(frames, StereoFrame{});
    generationTags_.assign(frames, 0U);
#endif

    if (!leftLfo_.prepare(spec) || !rightLfo_.prepare(spec)) {
        delayLine_.clear();
        generationTags_.clear();
        return false;
    }
    spec_ = spec;
    kind_ = kind;
    ringMask_ = frames - 1U;
    maximumDelaySamples_ = static_cast<std::uint32_t>(std::ceil(
        static_cast<double>(spec.sampleRate) * maximumDelayMs(kind) * 0.001));
    preparedBytes_ = bytes;
    interpolationSmoothingCoefficient_ = 1.0 - std::exp(-1.0 /
        (static_cast<double>(spec.sampleRate) * kParameterSmoothingSeconds));
    feedbackDcCoefficient_ = std::exp(-2.0 * kPi * kFeedbackHighpassHz /
                                       static_cast<double>(spec.sampleRate));
    const auto defaults = defaultsFor(kind);
    wet_ = wetCurrent_ = defaults.wet;
    rateHz_ = defaults.rateHz;
    baseDelayMs_ = baseDelayCurrentMs_ = defaults.baseDelayMs;
    depthMs_ = depthCurrentMs_ = defaults.depthMs;
    feedback_ = feedbackCurrent_ = defaults.feedback;
    pan_ = panCurrent_ = defaults.pan;
    panDepth_ = panDepthCurrent_ = defaults.panDepth;
    crossFeedback_ = crossFeedbackCurrent_ = defaults.crossFeedback;
    activeGain_ = targetActiveGain_ = 0.0f;
    active_ = false;
    if (!leftLfo_.setFrequency(rateHz_) || !rightLfo_.setFrequency(rateHz_)) {
        delayLine_.clear();
        generationTags_.clear();
        return false;
    }
    leftLfo_.reset(0.0f);
    rightLfo_.reset(static_cast<float>(defaults.rightLfoPhase));
    feedbackPreviousInput_ = {};
    feedbackDcState_ = {};
    writeIndex_ = 0U;
    generation_ = 1U;
    expectedFrame_ = 0U;
    hasExpectedFrame_ = false;
    prepared_ = true;
    reset(0U);
    hasExpectedFrame_ = false;
    return true;
}

void ModulatedDelayFx::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    ++generation_;
    if (generation_ == 0U) {
        std::fill(generationTags_.begin(), generationTags_.end(), 0U);
        generation_ = 1U;
    }
    writeIndex_ = 0U;
    feedbackPreviousInput_ = {};
    feedbackDcState_ = {};
    leftLfo_.reset(0.0f);
    const auto defaults = defaultsFor(kind_);
    rightLfo_.reset(static_cast<float>(defaults.rightLfoPhase));
    (void)leftLfo_.setFrequency(rateHz_);
    (void)rightLfo_.setFrequency(rateHz_);
    wetCurrent_ = wet_;
    baseDelayCurrentMs_ = baseDelayMs_;
    depthCurrentMs_ = depthMs_;
    feedbackCurrent_ = feedback_;
    panCurrent_ = pan_;
    panDepthCurrent_ = panDepth_;
    crossFeedbackCurrent_ = crossFeedback_;
    activeGain_ = 0.0f;
    targetActiveGain_ = 0.0f;
    active_ = false;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = true;
}

bool ModulatedDelayFx::validateEvent(const ModulatedDelayEvent& event) const noexcept {
    const auto minDelayMs = static_cast<float>(kMinimumDelaySamples * 1000.0 /
                                               static_cast<double>(spec_.sampleRate));
    switch (event.control) {
    case ModulatedDelayControl::Active:
        return event.value == 0.0f || event.value == 1.0f;
    case ModulatedDelayControl::Wet:
        return finiteInRange(event.value, 0.0f, 1.0f);
    case ModulatedDelayControl::RateHz:
        return finiteInRange(event.value, 0.01f, std::min(20.0f, spec_.sampleRate * 0.25f));
    case ModulatedDelayControl::BaseDelayMs:
        return finiteInRange(event.value, minDelayMs,
            static_cast<float>(maximumDelayMs(kind_)));
    case ModulatedDelayControl::DepthMs:
        return finiteInRange(event.value, 0.0f, static_cast<float>(maximumDepthMs(kind_)));
    case ModulatedDelayControl::Feedback:
        if (kind_ == ModulatedDelayKind::Vibrato) return event.value == 0.0f;
        if (kind_ == ModulatedDelayKind::PanningDelay)
            return finiteInRange(event.value, 0.0f, 0.90f);
        if (kind_ == ModulatedDelayKind::Chorus)
            return finiteInRange(event.value, -0.80f, 0.80f);
        return finiteInRange(event.value, -0.88f, 0.88f);
    case ModulatedDelayControl::Pan:
        return kind_ == ModulatedDelayKind::PanningDelay &&
               finiteInRange(event.value, -1.0f, 1.0f);
    case ModulatedDelayControl::PanDepth:
        return kind_ == ModulatedDelayKind::PanningDelay &&
               finiteInRange(event.value, 0.0f, 1.0f);
    case ModulatedDelayControl::CrossFeedback:
        return kind_ == ModulatedDelayKind::PanningDelay &&
               finiteInRange(event.value, 0.0f, 1.0f);
    }
    return false;
}

bool ModulatedDelayFx::validateEvents(std::uint32_t frames,
                                      const ModulatedDelayEvent* events,
                                      std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && !events))
        return false;
    float candidateBase = baseDelayMs_;
    float candidateDepth = depthMs_;
    std::uint32_t previousOffset = 0U;
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        const auto& event = events[i];
        if (event.frameOffset >= frames || (i != 0U && event.frameOffset < previousOffset) ||
            !validateEvent(event)) return false;
        if (i != 0U && event.frameOffset != previousOffset) {
            const auto minimumMs = static_cast<float>(kMinimumDelaySamples * 1000.0 /
                static_cast<double>(spec_.sampleRate));
            const auto maximumMs = static_cast<float>(maximumDelayMs(kind_));
            if (candidateBase - candidateDepth < minimumMs ||
                candidateBase + candidateDepth > maximumMs) return false;
        }
        if (event.control == ModulatedDelayControl::BaseDelayMs)
            candidateBase = event.value;
        else if (event.control == ModulatedDelayControl::DepthMs)
            candidateDepth = event.value;
        previousOffset = event.frameOffset;
    }
    const auto minimumMs = static_cast<float>(kMinimumDelaySamples * 1000.0 /
        static_cast<double>(spec_.sampleRate));
    const auto maximumMs = static_cast<float>(maximumDelayMs(kind_));
    return candidateBase - candidateDepth >= minimumMs &&
           candidateBase + candidateDepth <= maximumMs;
}

bool ModulatedDelayFx::processBlock(std::uint64_t blockStartFrame,
                                    StereoFrame* interleaved,
                                    std::uint32_t frames,
                                    const ModulatedDelayEvent* events,
                                    std::uint32_t eventCount) noexcept {
    if (!prepared_ || !interleaved || frames == 0U || frames > spec_.maxBlockFrames ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (!hasExpectedFrame_) {
        expectedFrame_ = blockStartFrame;
        hasExpectedFrame_ = true;
    }
    std::uint32_t eventIndex = 0U;
    for (std::uint32_t offset = 0; offset < frames; ++offset) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == offset) {
            applyEvent(events[eventIndex]);
            ++eventIndex;
        }
        interleaved[offset] = processSample(interleaved[offset]);
    }
    expectedFrame_ = blockStartFrame + frames;
    return true;
}

void ModulatedDelayFx::applyEvent(const ModulatedDelayEvent& event) noexcept {
    switch (event.control) {
    case ModulatedDelayControl::Active:
        active_ = event.value > 0.5f;
        targetActiveGain_ = active_ ? 1.0f : 0.0f;
        break;
    case ModulatedDelayControl::Wet:
        wet_ = event.value;
        break;
    case ModulatedDelayControl::RateHz:
        rateHz_ = event.value;
        (void)leftLfo_.setFrequency(rateHz_);
        (void)rightLfo_.setFrequency(rateHz_);
        break;
    case ModulatedDelayControl::BaseDelayMs:
        baseDelayMs_ = event.value;
        break;
    case ModulatedDelayControl::DepthMs:
        depthMs_ = event.value;
        break;
    case ModulatedDelayControl::Feedback:
        feedback_ = event.value;
        break;
    case ModulatedDelayControl::Pan:
        pan_ = event.value;
        break;
    case ModulatedDelayControl::PanDepth:
        panDepth_ = event.value;
        break;
    case ModulatedDelayControl::CrossFeedback:
        crossFeedback_ = event.value;
        break;
    }
}

StereoFrame ModulatedDelayFx::processSample(StereoFrame input) noexcept {
    input = {boundedAudio(input.left), boundedAudio(input.right)};
    const float smoothing = static_cast<float>(interpolationSmoothingCoefficient_);
    wetCurrent_ += (wet_ - wetCurrent_) * smoothing;
    activeGain_ += (targetActiveGain_ - activeGain_) * smoothing;
    if (std::fabs(targetActiveGain_ - activeGain_) < 1.0e-6f)
        activeGain_ = targetActiveGain_;
    baseDelayCurrentMs_ += (baseDelayMs_ - baseDelayCurrentMs_) * smoothing;
    depthCurrentMs_ += (depthMs_ - depthCurrentMs_) * smoothing;
    feedbackCurrent_ += (feedback_ - feedbackCurrent_) * smoothing;
    panCurrent_ += (pan_ - panCurrent_) * smoothing;
    panDepthCurrent_ += (panDepth_ - panDepthCurrent_) * smoothing;
    crossFeedbackCurrent_ += (crossFeedback_ - crossFeedbackCurrent_) * smoothing;

    const double minimumSamples = kMinimumDelaySamples;
    const double maximumSamples = static_cast<double>(maximumDelaySamples_);
    const double leftMod = static_cast<double>(leftLfo_.next());
    const double rightMod = static_cast<double>(rightLfo_.next());
    const double samplesPerMs = static_cast<double>(spec_.sampleRate) * 0.001;
    const double centerDelay = static_cast<double>(baseDelayCurrentMs_) * samplesPerMs;
    const double modulationDepth = static_cast<double>(depthCurrentMs_) * samplesPerMs;
    const double leftDelay = std::clamp(centerDelay + modulationDepth * leftMod,
                                        minimumSamples, maximumSamples);
    const double rightDelay = std::clamp(centerDelay + modulationDepth * rightMod,
                                         minimumSamples, maximumSamples);
    const float delayedLeft = readDelay(0U, leftDelay);
    const float delayedRight = readDelay(1U, rightDelay);

    float feedbackSourceLeft = delayedLeft;
    float feedbackSourceRight = delayedRight;
    if (kind_ == ModulatedDelayKind::PanningDelay) {
        const auto cross = std::clamp(crossFeedbackCurrent_, 0.0f, 1.0f);
        feedbackSourceLeft = delayedLeft * (1.0f - cross) + delayedRight * cross;
        feedbackSourceRight = delayedRight * (1.0f - cross) + delayedLeft * cross;
    }
    const float feedbackLeft = feedbackHighpass(0U, feedbackSourceLeft);
    const float feedbackRight = feedbackHighpass(1U, feedbackSourceRight);
    const float boundedFeedback = std::clamp(feedbackCurrent_, -0.88f, 0.90f);
    const float writeLeft = boundedAudio(input.left + boundedFeedback * feedbackLeft);
    const float writeRight = boundedAudio(input.right + boundedFeedback * feedbackRight);
    delayLine_[writeIndex_] = {writeLeft, writeRight};
    generationTags_[writeIndex_] = generation_;
    writeIndex_ = (writeIndex_ + 1U) & ringMask_;

    StereoFrame wetSignal{delayedLeft, delayedRight};
    if (kind_ == ModulatedDelayKind::PanningDelay) {
        const float movingPan = std::clamp(panCurrent_ + panDepthCurrent_ *
            static_cast<float>(leftMod), -1.0f, 1.0f);
        wetSignal = applyStereoPan(wetSignal, movingPan);
    }
    const float mix = activeGain_ * wetCurrent_;
    return {boundedAudio(input.left + (wetSignal.left - input.left) * mix),
            boundedAudio(input.right + (wetSignal.right - input.right) * mix)};
}

float ModulatedDelayFx::readDelay(std::uint32_t channel, double delaySamples) const noexcept {
    const double position = static_cast<double>(writeIndex_) - delaySamples;
    const auto base = static_cast<std::int64_t>(std::floor(position));
    const double fraction = position - static_cast<double>(base);
    double sum = 0.0;
    double weightSum = 0.0;
    for (std::int64_t tap = -3; tap <= 4; ++tap) {
        const double distance = fraction - static_cast<double>(tap);
        if (std::fabs(distance) >= 4.0) continue;
        const double weight = sinc(distance) * sinc(distance * 0.25);
        const auto index = static_cast<std::size_t>(base + tap) & ringMask_;
        if (generationTags_[index] == generation_) {
            const float sample = channel == 0U ? delayLine_[index].left : delayLine_[index].right;
            sum += static_cast<double>(sample) * weight;
        }
        weightSum += weight;
    }
    if (std::fabs(weightSum) < 1.0e-12) return 0.0f;
    return boundedAudio(static_cast<float>(sum / weightSum));
}

float ModulatedDelayFx::feedbackHighpass(std::uint32_t channel, float input) noexcept {
    const double output = static_cast<double>(input) - feedbackPreviousInput_[channel] +
        feedbackDcCoefficient_ * feedbackDcState_[channel];
    feedbackPreviousInput_[channel] = static_cast<double>(input);
    const float safeOutput = boundedAudio(std::isfinite(output)
        ? static_cast<float>(output) : 0.0f);
    feedbackDcState_[channel] = static_cast<double>(safeOutput);
    return safeOutput;
}

StereoFrame ModulatedDelayFx::applyStereoPan(StereoFrame input, float pan) noexcept {
    const double boundedPan = static_cast<double>(std::clamp(pan, -1.0f, 1.0f));
    const double x = boundedPan <= 0.0 ? boundedPan + 1.0 : boundedPan;
    const double angle = x * kPi * 0.5;
    const float leftGain = static_cast<float>(std::cos(angle));
    const float rightGain = static_cast<float>(std::sin(angle));
    if (boundedPan <= 0.0)
        return {boundedAudio(input.left + input.right * leftGain),
                boundedAudio(input.right * rightGain)};
    return {boundedAudio(input.left * leftGain),
            boundedAudio(input.right + input.left * rightGain)};
}

ModulatedDelayWindow ModulatedDelayFx::delayWindowSamples() const noexcept {
    if (!prepared_ || spec_.sampleRate <= 0.0f) return {};
    const double samplesPerMs = static_cast<double>(spec_.sampleRate) * 0.001;
    const double low = std::max(kMinimumDelaySamples,
        static_cast<double>(baseDelayCurrentMs_ - depthCurrentMs_) * samplesPerMs);
    const double high = std::min(static_cast<double>(maximumDelaySamples_),
        static_cast<double>(baseDelayCurrentMs_ + depthCurrentMs_) * samplesPerMs);
    return {low, high};
}

} // namespace webrc::dsp
