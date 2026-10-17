#include "native_electric_processor.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kVoiceGate = 0.003;
constexpr double kMinimumTrackerRms = 0.003;
constexpr double kYinThreshold = 0.22;
constexpr float kMaximumInput = 8.0f;
constexpr float kMaximumOutput = 8.0f;
constexpr double kPitchOscillatorSmoothingSeconds = 0.006;
constexpr double kBitCrushRateHz = 8000.0;
constexpr double kBitCrushQuantizationSteps = 31.0;

[[nodiscard]] float finiteBounded(float sample, float magnitude) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return std::clamp(sample, -magnitude, magnitude);
}

[[nodiscard]] float snapToNearestMidi(float frequencyHz) noexcept {
    if (!(frequencyHz > 0.0f) || !std::isfinite(frequencyHz)) return 0.0f;
    const double midi = 69.0 + 12.0 * std::log2(static_cast<double>(frequencyHz) / 440.0);
    const double snappedMidi = std::round(midi);
    const double frequency = 440.0 * std::pow(2.0, (snappedMidi - 69.0) / 12.0);
    return std::isfinite(frequency) ? static_cast<float>(frequency) : 0.0f;
}

} // namespace

NativeElectricProcessor::NativeElectricProcessor(const NativeEffectDescriptor& descriptor) noexcept
    : NativeEffectProcessor(descriptor) {}

unsigned int NativeElectricProcessor::trackingLatencyUpperBoundSamples() const noexcept {
    if (sampleRate() == 0U || decimationFactor_ == 0U) return 0U;
    return static_cast<unsigned int>((kAnalysisWindow + kTrackerHop) * decimationFactor_);
}

bool NativeElectricProcessor::configureToneFilters(float cutoffHz) noexcept {
    if (sampleRate() == 0U || !std::isfinite(cutoffHz)) return false;
    const double upperBound = static_cast<double>(sampleRate()) * 0.45;
    const double cutoff = std::clamp(static_cast<double>(cutoffHz), 20.0, upperBound);
    bool okay = true;
    for (auto& filter : toneFilters_) {
        okay = filter.setParameters(static_cast<double>(sampleRate()), cutoff, 0.70710678) && okay;
    }
    return okay;
}

bool NativeElectricProcessor::configureVocoder() noexcept {
    if (sampleRate() == 0U ||
        !vocoderFilterBank_.prepare(sampleRate(), kVocoderBands)) return false;
    vocoderOscillatorCount_ = static_cast<unsigned int>(vocoderFilterBank_.bandCount());
    for (unsigned int band = 0U; band < vocoderOscillatorCount_; ++band) {
        const float centerHz = vocoderFilterBank_.centerFrequencyHz(band);
        if (!vocoderOscillators_[band].prepare(sampleRate(), centerHz, NativeVocoderWaveform::Saw)) {
            vocoderOscillatorCount_ = 0U;
            return false;
        }
        vocoderOscillators_[band].reset(static_cast<double>(band) / static_cast<double>(kVocoderBands));
    }
    return true;
}

void NativeElectricProcessor::resetPitchTracker() noexcept {
    trackerRing_.fill(0.0f);
    differences_.fill(0.0);
    normalizedDifferences_.fill(1.0);
    trackerWrite_ = 0U;
    trackerCount_ = 0U;
    decimationPhase_ = 0U;
    trackerHopCount_ = 0U;
    goodAnalyses_ = 0U;
    badAnalyses_ = 0U;
    decimatorSum_ = 0.0;
    trackedHz_ = 0.0f;
    trackerConfidence_ = 0.0f;
    snappedHz_ = 0.0f;
    effectiveHz_ = 0.0f;
    smoothedOscillatorHz_ = 0.0;
    pitchLocked_ = false;
    pitchStatus_ = sampleRate() == 0U ? PitchStatus::Unprepared : PitchStatus::InsufficientLevel;
}

void NativeElectricProcessor::pushTrackerSample(float sample) noexcept {
    trackerRing_[trackerWrite_] = finiteBounded(sample, kMaximumInput);
    trackerWrite_ = (trackerWrite_ + 1U) % kAnalysisWindow;
    trackerCount_ = std::min<std::size_t>(trackerCount_ + 1U, kAnalysisWindow);
    if (trackerCount_ < kAnalysisWindow) return;

    ++trackerHopCount_;
    if (trackerHopCount_ < kTrackerHop) return;
    trackerHopCount_ = 0U;
    analyzePitchFrame();
}

void NativeElectricProcessor::analyzePitchFrame() noexcept {
    if (trackerRate_ == 0U || maximumLag_ <= minimumLag_) {
        pitchStatus_ = PitchStatus::Unprepared;
        return;
    }

    double signalEnergy = 0.0;
    for (std::size_t index = 0U; index < kAnalysisWindow; ++index) {
        const double value = trackerRing_[(trackerWrite_ + index) % kAnalysisWindow];
        signalEnergy += value * value;
    }
    const double rms = std::sqrt(signalEnergy / static_cast<double>(kAnalysisWindow));
    if (!(rms >= kMinimumTrackerRms)) {
        trackerConfidence_ = 0.0f;
        pitchStatus_ = PitchStatus::InsufficientLevel;
        goodAnalyses_ = 0U;
        if (++badAnalyses_ >= kPitchDropAnalyses) {
            pitchLocked_ = false;
            trackedHz_ = 0.0f;
            snappedHz_ = 0.0f;
            effectiveHz_ = 0.0f;
            smoothedOscillatorHz_ = 0.0;
        }
        return;
    }

    differences_.fill(0.0);
    for (unsigned int lag = 1U; lag <= maximumLag_; ++lag) {
        double difference = 0.0;
        const std::size_t comparisonCount = kAnalysisWindow - maximumLag_;
        for (std::size_t index = 0U; index < comparisonCount; ++index) {
            const double first = trackerRing_[(trackerWrite_ + index) % kAnalysisWindow];
            const double second = trackerRing_[(trackerWrite_ + index + lag) % kAnalysisWindow];
            const double delta = first - second;
            difference += delta * delta;
        }
        differences_[lag] = difference;
    }

    double cumulativeDifference = 0.0;
    normalizedDifferences_[0U] = 1.0;
    for (unsigned int lag = 1U; lag <= maximumLag_; ++lag) {
        cumulativeDifference += differences_[lag];
        normalizedDifferences_[lag] = cumulativeDifference > 1.0e-20
            ? differences_[lag] * static_cast<double>(lag) / cumulativeDifference
            : 1.0;
    }

    unsigned int selectedLag = 0U;
    double bestValue = 1.0;
    for (unsigned int lag = minimumLag_; lag <= maximumLag_; ++lag) {
        const double value = normalizedDifferences_[lag];
        if (value < bestValue) {
            bestValue = value;
            selectedLag = lag;
        }
        if (value < kYinThreshold &&
            (lag == maximumLag_ || value <= normalizedDifferences_[lag + 1U])) {
            selectedLag = lag;
            while (selectedLag < maximumLag_ &&
                   normalizedDifferences_[selectedLag + 1U] < normalizedDifferences_[selectedLag]) {
                ++selectedLag;
            }
            bestValue = normalizedDifferences_[selectedLag];
            break;
        }
    }
    trackerConfidence_ = std::isfinite(bestValue)
        ? static_cast<float>(std::clamp(1.0 - bestValue, 0.0, 1.0))
        : 0.0f;

    double refinedLag = static_cast<double>(selectedLag);
    if (selectedLag > minimumLag_ && selectedLag < maximumLag_) {
        const double left = normalizedDifferences_[selectedLag - 1U];
        const double center = normalizedDifferences_[selectedLag];
        const double right = normalizedDifferences_[selectedLag + 1U];
        const double curvature = left - (2.0 * center) + right;
        if (std::fabs(curvature) > 1.0e-12) {
            refinedLag += std::clamp(0.5 * (left - right) / curvature, -0.5, 0.5);
        }
    }
    const double measuredHz = selectedLag > 0U && refinedLag > 0.0
        ? static_cast<double>(trackerRate_) / refinedLag
        : 0.0;
    const bool validPitch = std::isfinite(measuredHz) &&
        measuredHz >= kMinimumTrackedHz && measuredHz <= kMaximumTrackedHz;
    const bool confident = selectedLag > 0U && validPitch &&
        trackerConfidence_ >= kMinimumPitchConfidence && bestValue < kYinThreshold;

    if (!confident) {
        goodAnalyses_ = 0U;
        pitchStatus_ = PitchStatus::LowConfidence;
        if (++badAnalyses_ >= kPitchDropAnalyses) {
            pitchLocked_ = false;
            trackedHz_ = 0.0f;
            snappedHz_ = 0.0f;
            effectiveHz_ = 0.0f;
            smoothedOscillatorHz_ = 0.0;
        }
        return;
    }

    badAnalyses_ = 0U;
    ++goodAnalyses_;
    const float measured = static_cast<float>(measuredHz);
    if (trackedHz_ <= 0.0f ||
        std::fabs(measured - trackedHz_) > trackedHz_ * 0.30f) {
        trackedHz_ = measured;
    } else {
        const double smoothedLog = std::log(static_cast<double>(trackedHz_)) +
            (std::log(measuredHz) - std::log(static_cast<double>(trackedHz_))) * 0.40;
        trackedHz_ = static_cast<float>(std::exp(smoothedLog));
    }
    if (goodAnalyses_ >= kPitchLockAnalyses) pitchLocked_ = true;
    pitchStatus_ = pitchLocked_ ? PitchStatus::Tracking : PitchStatus::Acquiring;
}

bool NativeElectricProcessor::onPrepare() noexcept {
    const float pitchSnap = pitchSnapPercent_.target();
    const float tone = toneHz_.target();
    const float mix = mixPercent_.target();
    pitchSnapPercent_.reset(pitchSnap);
    toneHz_.reset(tone);
    mixPercent_.reset(mix);

    trackerRate_ = 0U;
    minimumLag_ = 0U;
    maximumLag_ = 0U;
    decimationFactor_ = std::max(1U, static_cast<unsigned int>(std::ceil(
        static_cast<double>(sampleRate()) / 16000.0)));
    trackerRate_ = sampleRate() / decimationFactor_;
    minimumLag_ = std::max(2U, static_cast<unsigned int>(std::floor(
        static_cast<double>(trackerRate_) / static_cast<double>(kMaximumTrackedHz))));
    maximumLag_ = std::min(kMaximumLag, static_cast<unsigned int>(std::ceil(
        static_cast<double>(trackerRate_) / static_cast<double>(kMinimumTrackedHz))));
    if (trackerRate_ < 4000U || minimumLag_ == 0U || maximumLag_ <= minimumLag_) return false;

    envelopeAttackCoefficient_ = std::exp(-1.0 / (static_cast<double>(sampleRate()) * 0.004));
    envelopeReleaseCoefficient_ = std::exp(-1.0 / (static_cast<double>(sampleRate()) * 0.070));
    oscillatorFrequencyCoefficient_ = 1.0 - std::exp(
        -1.0 / (static_cast<double>(sampleRate()) * kPitchOscillatorSmoothingSeconds));
    filterUpdateCount_ = 0U;
    envelope_ = 0.0;
    oscillatorPhase_ = 0.0;
    smoothedOscillatorHz_ = 0.0;
    crushPhase_ = 0.0;
    heldLeft_ = 0.0f;
    heldRight_ = 0.0f;
    resetPitchTracker();
    if (!configureToneFilters(tone)) return false;
    for (auto& filter : toneFilters_) filter.reset();
    if (!configureVocoder()) return false;
    return true;
}

bool NativeElectricProcessor::onSetParameter(std::string_view parameterId, float value,
                                              std::uint64_t rampFrames) noexcept {
    if (parameterId == "character") {
        const auto requested = static_cast<Character>(static_cast<unsigned int>(value));
        if (requested != character_) {
            character_ = requested;
            resetCharacterState();
        }
        return true;
    }
    if (parameterId == "pitch-snap") {
        pitchSnapPercent_.setTarget(value, rampFrames);
        return true;
    }
    if (parameterId == "tone") {
        toneHz_.setTarget(value, rampFrames);
        return true;
    }
    if (parameterId == "mix") {
        mixPercent_.setTarget(value, rampFrames);
        return true;
    }
    return false;
}

void NativeElectricProcessor::resetCharacterState() noexcept {
    oscillatorPhase_ = 0.0;
    crushPhase_ = 0.0;
    heldLeft_ = 0.0f;
    heldRight_ = 0.0f;
    vocoderFilterBank_.reset();
    for (unsigned int band = 0U; band < vocoderOscillatorCount_; ++band) {
        vocoderOscillators_[band].reset(static_cast<double>(band) / static_cast<double>(kVocoderBands));
    }
    for (auto& filter : toneFilters_) filter.reset();
}

void NativeElectricProcessor::onResetState() noexcept {
    pitchSnapPercent_.reset(pitchSnapPercent_.target());
    toneHz_.reset(toneHz_.target());
    mixPercent_.reset(mixPercent_.target());
    filterUpdateCount_ = 0U;
    envelope_ = 0.0;
    oscillatorPhase_ = 0.0;
    smoothedOscillatorHz_ = 0.0;
    crushPhase_ = 0.0;
    heldLeft_ = 0.0f;
    heldRight_ = 0.0f;
    resetPitchTracker();
    vocoderFilterBank_.reset();
    for (unsigned int band = 0U; band < vocoderOscillatorCount_; ++band) {
        vocoderOscillators_[band].reset(static_cast<double>(band) / static_cast<double>(kVocoderBands));
    }
    for (auto& filter : toneFilters_) filter.reset();
    (void)configureToneFilters(toneHz_.target());
}

float NativeElectricProcessor::filteredTone(float sample, unsigned int channel) noexcept {
    if (channel >= toneFilters_.size()) return sample;
    const auto outputs = toneFilters_[channel].process(sample);
    return finiteBounded(outputs.lowPass, kMaximumOutput);
}

float NativeElectricProcessor::vocoderSample(float mono) noexcept {
    if (vocoderOscillatorCount_ == 0U) return 0.0f;
    vocoderFilterBank_.analyzeModulatorSample(mono);
    for (unsigned int band = 0U; band < vocoderOscillatorCount_; ++band) {
        const float carrier = vocoderOscillators_[band].processSample();
        vocoderCarriers_[band] = vocoderFilterBank_.filterCarrierSample(band, carrier);
    }
    return finiteBounded(vocoderFilterBank_.synthesizeSample(
        vocoderCarriers_.data(), vocoderOscillatorCount_) * 0.42f, kMaximumOutput);
}

float NativeElectricProcessor::crushSample(float sample) const noexcept {
    const float bounded = std::clamp(sample, -1.0f, 1.0f);
    return static_cast<float>(std::round(static_cast<double>(bounded) * kBitCrushQuantizationSteps) /
        kBitCrushQuantizationSteps);
}

void NativeElectricProcessor::processEffectFrame(float* frame, unsigned int channels) noexcept {
    const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
    if (processedChannels == 0U || sampleRate() == 0U) return;

    const float left = finiteBounded(frame[0], kMaximumInput);
    const float right = processedChannels > 1U ? finiteBounded(frame[1], kMaximumInput) : left;
    const float mono = processedChannels > 1U ? 0.5f * (left + right) : left;

    const double magnitude = std::fabs(static_cast<double>(mono));
    const double envelopeCoefficient = magnitude > envelope_
        ? envelopeAttackCoefficient_ : envelopeReleaseCoefficient_;
    envelope_ = (envelopeCoefficient * envelope_) + ((1.0 - envelopeCoefficient) * magnitude);

    decimatorSum_ += static_cast<double>(mono);
    if (++decimationPhase_ >= decimationFactor_) {
        const float trackerSample = static_cast<float>(decimatorSum_ / static_cast<double>(decimationFactor_));
        decimationPhase_ = 0U;
        decimatorSum_ = 0.0;
        pushTrackerSample(trackerSample);
    }

    const float pitchSnap = std::clamp(pitchSnapPercent_.next() * 0.01f, 0.0f, 1.0f);
    if (pitchLocked_ && trackedHz_ > 0.0f) {
        snappedHz_ = snapToNearestMidi(trackedHz_);
        const double requestedHz = static_cast<double>(trackedHz_) +
            (static_cast<double>(snappedHz_ - trackedHz_) * static_cast<double>(pitchSnap));
        if (!(smoothedOscillatorHz_ > 0.0)) {
            smoothedOscillatorHz_ = requestedHz;
        } else {
            smoothedOscillatorHz_ += (requestedHz - smoothedOscillatorHz_) *
                oscillatorFrequencyCoefficient_;
        }
        effectiveHz_ = static_cast<float>(smoothedOscillatorHz_);
    } else {
        snappedHz_ = 0.0f;
        effectiveHz_ = 0.0f;
        smoothedOscillatorHz_ = 0.0;
    }

    const float toneCutoffHz = toneHz_.next();
    if ((filterUpdateCount_++ & 15U) == 0U) (void)configureToneFilters(toneCutoffHz);
    const float mix = std::clamp(mixPercent_.next() * 0.01f, 0.0f, 1.0f);

    float wetLeft = left;
    float wetRight = right;
    bool pitchDependentFallback = false;
    switch (character_) {
    case Character::Classic: {
        if (!pitchLocked_ || !(envelope_ > kVoiceGate)) {
            pitchDependentFallback = true;
            break;
        }
        const double frequency = std::clamp(smoothedOscillatorHz_, 20.0,
            static_cast<double>(sampleRate()) * 0.40);
        const float carrier = static_cast<float>(std::sin(oscillatorPhase_));
        oscillatorPhase_ += kTwoPi * frequency / static_cast<double>(sampleRate());
        if (oscillatorPhase_ >= kTwoPi) oscillatorPhase_ -= kTwoPi;
        const float voice = finiteBounded(static_cast<float>(envelope_ * 1.4142135623730951) * carrier,
            kMaximumOutput);
        wetLeft = filteredTone(voice, 0U);
        wetRight = filteredTone(voice, 1U);
        break;
    }
    case Character::Metallic: {
        if (!pitchLocked_ || !(envelope_ > kVoiceGate)) {
            pitchDependentFallback = true;
            break;
        }
        const double frequency = std::clamp(smoothedOscillatorHz_ * 2.0, 20.0,
            static_cast<double>(sampleRate()) * 0.40);
        const float carrier = static_cast<float>(std::sin(oscillatorPhase_));
        oscillatorPhase_ += kTwoPi * frequency / static_cast<double>(sampleRate());
        if (oscillatorPhase_ >= kTwoPi) oscillatorPhase_ -= kTwoPi;
        wetLeft = filteredTone(left * carrier * 1.4142135623730951f, 0U);
        wetRight = filteredTone(right * carrier * 1.4142135623730951f, 1U);
        break;
    }
    case Character::Vocoder: {
        const float vocoder = vocoderSample(mono);
        wetLeft = filteredTone(vocoder, 0U);
        wetRight = filteredTone(vocoder, 1U);
        break;
    }
    case Character::BitCrush: {
        const double holdRate = std::min(kBitCrushRateHz, static_cast<double>(sampleRate()) * 0.8);
        crushPhase_ += holdRate;
        if (crushPhase_ >= static_cast<double>(sampleRate())) {
            crushPhase_ -= static_cast<double>(sampleRate());
            heldLeft_ = crushSample(left);
            heldRight_ = crushSample(right);
        }
        wetLeft = filteredTone(heldLeft_, 0U);
        wetRight = filteredTone(heldRight_, 1U);
        break;
    }
    }

    if (pitchDependentFallback) {
        // No stable F0 means no synthetic/ring voice; preserve the input at
        // any mix value instead of leaking a stale or noisy pitch estimate.
        wetLeft = left;
        wetRight = right;
    }
    frame[0] = finiteBounded((left * (1.0f - mix)) + (wetLeft * mix), kMaximumOutput);
    if (processedChannels > 1U) {
        frame[1] = finiteBounded((right * (1.0f - mix)) + (wetRight * mix), kMaximumOutput);
    }
}

} // namespace webrc::native
