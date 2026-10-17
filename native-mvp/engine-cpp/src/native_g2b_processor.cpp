#include "native_g2b_processor.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native {
namespace {

constexpr double kTwoPi = 6.28318530717958647692;
constexpr float kMaximumInput = 4.0f;
constexpr float kMaximumOutput = 3.0f;

[[nodiscard]] double wrappedPhase(double phase) noexcept {
    phase -= std::floor(phase);
    return phase < 0.0 ? phase + 1.0 : phase;
}

[[nodiscard]] double polyBlep(double phase, double increment) noexcept {
    if (increment <= 0.0) return 0.0;
    if (phase < increment) {
        const double normalized = phase / increment;
        return normalized + normalized - (normalized * normalized) - 1.0;
    }
    if (phase > 1.0 - increment) {
        const double normalized = (phase - 1.0) / increment;
        return (normalized * normalized) + normalized + normalized + 1.0;
    }
    return 0.0;
}

[[nodiscard]] float octaveDownSquare(double phase, double increment) noexcept {
    double square = phase < 0.5 ? 0.62 : -0.62;
    square += polyBlep(phase, increment);
    square -= polyBlep(wrappedPhase(phase + 0.5), increment);
    return static_cast<float>(square);
}

} // namespace

NativeG2BProcessor::NativeG2BProcessor(const NativeEffectDescriptor& descriptor) noexcept
    : NativeEffectProcessor(descriptor) {}

unsigned int NativeG2BProcessor::trackingLatencyUpperBoundSamples() const noexcept {
    if (sampleRate() == 0U || decimationFactor_ == 0U) return 0U;
    return static_cast<unsigned int>((kAnalysisWindow + kTrackerHop) * decimationFactor_);
}

double NativeG2BProcessor::inputGate(float trackingPercent) const noexcept {
    const double inverse = 1.0 - (static_cast<double>(trackingPercent) * 0.01);
    return 0.0015 + (0.024 * inverse * inverse);
}

bool NativeG2BProcessor::configureBodyFilter(float cutoffHz) noexcept {
    if (sampleRate() == 0U) return false;
    const double boundedCutoff = std::clamp(
        static_cast<double>(cutoffHz), 20.0, static_cast<double>(sampleRate()) * 0.45);
    return bodyFilter_.setParameters(static_cast<double>(sampleRate()), boundedCutoff, 0.70710678);
}

void NativeG2BProcessor::pushTrackerSample(float sample, float trackingPercent) noexcept {
    trackerRing_[trackerWrite_] = sample;
    trackerWrite_ = (trackerWrite_ + 1U) % kAnalysisWindow;
    trackerCount_ = std::min<std::size_t>(trackerCount_ + 1U, kAnalysisWindow);
    if (trackerCount_ < kAnalysisWindow) return;

    ++trackerHopCount_;
    if (trackerHopCount_ < kTrackerHop) return;
    trackerHopCount_ = 0U;

    constexpr std::size_t comparisonCount = kAnalysisWindow - kMaximumLag;
    double signalEnergy = 0.0;
    for (std::size_t index = 0U; index < kAnalysisWindow; ++index) {
        const double value = trackerRing_[(trackerWrite_ + index) % kAnalysisWindow];
        signalEnergy += value * value;
    }
    if (signalEnergy < 1.0e-8) return;

    for (unsigned int lag = kMinimumLag; lag <= kMaximumLag; ++lag) {
        double sum = 0.0;
        std::size_t firstIndex = trackerWrite_;
        std::size_t secondIndex = (trackerWrite_ + lag) % kAnalysisWindow;
        for (std::size_t index = 0U; index < comparisonCount; ++index) {
            const double delta = static_cast<double>(trackerRing_[firstIndex]) -
                static_cast<double>(trackerRing_[secondIndex]);
            sum += delta * delta;
            firstIndex = (firstIndex + 1U) % kAnalysisWindow;
            secondIndex = (secondIndex + 1U) % kAnalysisWindow;
        }
        difference_[lag] = sum;
    }

    cmnd_.fill(1.0);
    double cumulative = 0.0;
    for (unsigned int lag = 1U; lag <= kMaximumLag; ++lag) {
        cumulative += difference_[lag];
        if (lag >= kMinimumLag) {
            cmnd_[lag] = cumulative > 1.0e-20
                ? (difference_[lag] * static_cast<double>(lag)) / cumulative
                : 1.0;
        }
    }

    const double threshold = 0.24 - (0.10 * static_cast<double>(trackingPercent) * 0.01);
    unsigned int selectedLag = 0U;
    double bestValue = 1.0;
    for (unsigned int lag = kMinimumLag; lag <= kMaximumLag; ++lag) {
        if (cmnd_[lag] < bestValue) {
            bestValue = cmnd_[lag];
            selectedLag = lag;
        }
        if (cmnd_[lag] < threshold) {
            while (lag < kMaximumLag && cmnd_[lag + 1U] < cmnd_[lag]) ++lag;
            selectedLag = lag;
            bestValue = cmnd_[lag];
            break;
        }
    }
    if (selectedLag == 0U || bestValue > 0.34) return;

    double lagOffset = 0.0;
    if (selectedLag > kMinimumLag && selectedLag < kMaximumLag) {
        const double left = cmnd_[selectedLag - 1U];
        const double center = cmnd_[selectedLag];
        const double right = cmnd_[selectedLag + 1U];
        const double curvature = left - (2.0 * center) + right;
        if (std::fabs(curvature) > 1.0e-12) {
            lagOffset = std::clamp(0.5 * (left - right) / curvature, -0.5, 0.5);
        }
    }

    const double estimatedHz = static_cast<double>(trackerRate_) /
        (static_cast<double>(selectedLag) + lagOffset);
    if (!std::isfinite(estimatedHz) || estimatedHz < 30.0 ||
        estimatedHz > std::min(1200.0, static_cast<double>(trackerRate_) * 0.45)) {
        return;
    }
    if (trackedHz_ <= 0.0f || std::fabs(estimatedHz - static_cast<double>(trackedHz_)) >
        static_cast<double>(trackedHz_) * 0.30) {
        trackedHz_ = static_cast<float>(estimatedHz);
    } else {
        trackedHz_ += (static_cast<float>(estimatedHz) - trackedHz_) * 0.55f;
    }
}

bool NativeG2BProcessor::onPrepare() noexcept {
    if (sampleRate() > 192000U) return false;
    decimationFactor_ = std::max(1U, static_cast<unsigned int>(std::lround(
        static_cast<double>(sampleRate()) / 12000.0)));
    trackerRate_ = sampleRate() / decimationFactor_;
    attackCoefficient_ = std::exp(-1.0 / (static_cast<double>(sampleRate()) * 0.003));
    releaseCoefficient_ = std::exp(-1.0 / (static_cast<double>(sampleRate()) * 0.080));
    trackingPercent_.reset(trackingPercent_.target());
    blendPercent_.reset(blendPercent_.target());
    bodyHz_.reset(bodyHz_.target());
    trackerRing_.fill(0.0f);
    difference_.fill(0.0);
    cmnd_.fill(1.0);
    trackerWrite_ = 0U;
    trackerCount_ = 0U;
    decimationPhase_ = 0U;
    trackerHopCount_ = 0U;
    filterUpdateCount_ = 0U;
    decimatorState_ = 0.0;
    envelope_ = 0.0;
    oscillatorPhase_ = 0.0;
    trackedHz_ = 0.0f;
    bodyFilter_.reset();
    return configureBodyFilter(bodyHz_.target());
}

bool NativeG2BProcessor::onSetParameter(
    std::string_view parameterId, float value, std::uint64_t rampFrames
) noexcept {
    if (parameterId == "tracking_percent") trackingPercent_.setTarget(value, rampFrames);
    else if (parameterId == "blend_percent") blendPercent_.setTarget(value, rampFrames);
    else if (parameterId == "body_hz") bodyHz_.setTarget(value, rampFrames);
    else return false;
    return true;
}

void NativeG2BProcessor::onResetState() noexcept {
    trackingPercent_.reset(trackingPercent_.target());
    blendPercent_.reset(blendPercent_.target());
    bodyHz_.reset(bodyHz_.target());
    trackerRing_.fill(0.0f);
    difference_.fill(0.0);
    cmnd_.fill(1.0);
    trackerWrite_ = 0U;
    trackerCount_ = 0U;
    decimationPhase_ = 0U;
    trackerHopCount_ = 0U;
    filterUpdateCount_ = 0U;
    decimatorState_ = 0.0;
    envelope_ = 0.0;
    oscillatorPhase_ = 0.0;
    trackedHz_ = 0.0f;
    bodyFilter_.reset();
    (void)configureBodyFilter(bodyHz_.target());
}

void NativeG2BProcessor::processEffectFrame(float* frame, unsigned int channels) noexcept {
    const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
    if (processedChannels == 0U) return;

    const float left = std::isfinite(frame[0])
        ? std::clamp(frame[0], -kMaximumInput, kMaximumInput) : 0.0f;
    const float right = processedChannels > 1U
        ? (std::isfinite(frame[1]) ? std::clamp(frame[1], -kMaximumInput, kMaximumInput) : 0.0f)
        : left;
    const float mono = processedChannels > 1U ? (left + right) * 0.5f : left;

    const float tracking = std::clamp(trackingPercent_.next(), 0.0f, 100.0f);
    const float blend = std::clamp(blendPercent_.next() * 0.01f, 0.0f, 1.0f);
    const float bodyCutoff = bodyHz_.next();
    const double absolute = std::fabs(static_cast<double>(mono));
    const double envelopeCoefficient = absolute > envelope_ ? attackCoefficient_ : releaseCoefficient_;
    envelope_ = (envelopeCoefficient * envelope_) + ((1.0 - envelopeCoefficient) * absolute);
    const double gate = inputGate(tracking);

    // A one-pole input conditioner followed by boxcar decimation limits
    // tracker aliasing without allocating or introducing a separate buffer.
    decimatorState_ += 0.35 * (static_cast<double>(mono) - decimatorState_);
    ++decimationPhase_;
    if (decimationPhase_ >= decimationFactor_) {
        decimationPhase_ = 0U;
        if (envelope_ > gate) pushTrackerSample(static_cast<float>(decimatorState_), tracking);
    }

    if ((filterUpdateCount_++ & 7U) == 0U) (void)configureBodyFilter(bodyCutoff);

    float wet = 0.0f;
    if (trackedHz_ > 0.0f && envelope_ > gate) {
        // The detected fundamental is explicitly divided by two before the
        // square-wave resynthesis; blend then combines this octave-down voice
        // with the original input. This is a simple divider-style sub effect.
        const double subFrequency = std::clamp(static_cast<double>(trackedHz_) * 0.5,
                                                15.0, static_cast<double>(sampleRate()) * 0.20);
        const double increment = subFrequency / static_cast<double>(sampleRate());
        const float dividerVoice = octaveDownSquare(oscillatorPhase_, increment);
        oscillatorPhase_ = wrappedPhase(oscillatorPhase_ + increment);
        const float level = static_cast<float>(std::clamp(envelope_ * 2.0, 0.0, 0.85));
        const float filtered = bodyFilter_.process(dividerVoice * level).lowPass;
        wet = std::isfinite(filtered)
            ? std::clamp(filtered, -kMaximumOutput, kMaximumOutput) : 0.0f;
    } else {
        oscillatorPhase_ = wrappedPhase(oscillatorPhase_ + 0.00001);
    }

    const float dryGain = 1.0f - blend;
    for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
        const float dry = channel == 0U ? left : right;
        const float output = (dry * dryGain) + (wet * blend);
        frame[channel] = std::isfinite(output)
            ? std::clamp(output, -kMaximumOutput, kMaximumOutput) : 0.0f;
    }
}

} // namespace webrc::native
