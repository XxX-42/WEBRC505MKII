#include "native_robot_core.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::native {

namespace {

constexpr double kYinThreshold = 0.16;
constexpr double kMinimumVoicedRms = 0.003;
constexpr double kMaximumPsolaStepLogFrequency = 0.35 * 0.69314718055994530942 / 12.0;
constexpr float kMaximumFormantShift = 12.0f;
constexpr float kMaximumPitchShift = static_cast<float>(NativeRobotCore::kMaximumPitchShiftSemitones);
constexpr float kMaximumPsolaShift = 12.0f;
constexpr float kPsolaProcessorConfidence = 0.55f;

[[nodiscard]] bool validPitchMode(NativeRobotCore::PitchMode mode) noexcept {
    return mode == NativeRobotCore::PitchMode::FixedShift ||
        mode == NativeRobotCore::PitchMode::NearestSemitone;
}

[[nodiscard]] bool validFormantPolicy(NativeRobotCore::FormantPolicy policy) noexcept {
    return NativeRobotCore::supportsFormantPolicy(policy);
}

} // namespace

bool NativeRobotCore::PitchTracker::configure(unsigned int detectorRate) noexcept {
    if (detectorRate < 4000U || detectorRate > 12000U) return false;
    const unsigned int minLag = std::max(2U, static_cast<unsigned int>(std::floor(
        static_cast<double>(detectorRate) / 1000.0)));
    const unsigned int maxLag = static_cast<unsigned int>(std::ceil(
        static_cast<double>(detectorRate) / 55.0));
    if (maxLag < minLag || maxLag > kDetectorMaximumLag) return false;
    const unsigned int frame = std::max(64U, maxLag * 3U);
    if (frame + 1U > kDetectorRingCapacity) return false;

    sampleRate = detectorRate;
    minimumLag = minLag;
    maximumLag = maxLag;
    frameSamples = frame;
    analysisWindowSamples = frame - maxLag;
    hopSamples = std::max(1U, static_cast<unsigned int>(std::lround(
        static_cast<double>(detectorRate) * 0.005)));
    if (hopSamples > frame) return false;
    reset();
    return true;
}

void NativeRobotCore::PitchTracker::reset() noexcept {
    ring.fill(0.0f);
    differences.fill(0.0);
    normalizedDifferences.fill(1.0);
    writeIndex = 0U;
    sampleCount = 0U;
    nextAnalysisSample = frameSamples;
    goodFrames = 0U;
    badFrames = 0U;
    stableFrames = 0U;
    frequencyHz = 0.0f;
    confidence = 0.0f;
    smoothedLogFrequency = 0.0;
    previousMeasuredLogFrequency = 0.0;
    voiced = false;
}

void NativeRobotCore::PitchTracker::pushSample(float sample) noexcept {
    ring[writeIndex] = std::isfinite(sample) ? sample : 0.0f;
    writeIndex = (writeIndex + 1U) & kDetectorRingMask;
    ++sampleCount;
    if (sampleCount < nextAnalysisSample) return;
    analyzeFrame();
    nextAnalysisSample += hopSamples;
}

void NativeRobotCore::PitchTracker::analyzeFrame() noexcept {
    const unsigned int frameStart = (writeIndex + kDetectorRingCapacity - frameSamples) & kDetectorRingMask;
    double energy = 0.0;
    for (unsigned int i = 0U; i < frameSamples; ++i) {
        const double sample = ring[(frameStart + i) & kDetectorRingMask];
        energy += sample * sample;
    }
    const double rms = std::sqrt(energy / static_cast<double>(frameSamples));

    differences[0] = 0.0;
    for (unsigned int lag = 1U; lag <= maximumLag; ++lag) {
        double sum = 0.0;
        for (unsigned int i = 0U; i < analysisWindowSamples; ++i) {
            const double delta = static_cast<double>(ring[(frameStart + i) & kDetectorRingMask]) -
                static_cast<double>(ring[(frameStart + i + lag) & kDetectorRingMask]);
            sum += delta * delta;
        }
        differences[lag] = sum;
    }

    double cumulativeDifference = 0.0;
    for (unsigned int lag = 1U; lag <= maximumLag; ++lag) {
        const double difference = differences[lag];
        cumulativeDifference += difference;
        normalizedDifferences[lag] = cumulativeDifference > 1.0e-15
            ? difference * static_cast<double>(lag) / cumulativeDifference
            : 1.0;
    }

    unsigned int bestLag = 0U;
    double bestValue = std::numeric_limits<double>::infinity();
    const double threshold = voiced ? 0.22 : kYinThreshold;
    for (unsigned int lag = minimumLag; lag <= maximumLag; ++lag) {
        const double value = normalizedDifferences[lag];
        if (value < bestValue) {
            bestValue = value;
            bestLag = lag;
        }
        if (value < threshold && (lag == maximumLag || value <= normalizedDifferences[lag + 1U])) {
            bestLag = lag;
            while (bestLag < maximumLag &&
                   normalizedDifferences[bestLag + 1U] < normalizedDifferences[bestLag]) {
                ++bestLag;
            }
            bestValue = normalizedDifferences[bestLag];
            break;
        }
    }

    confidence = std::isfinite(bestValue)
        ? static_cast<float>(std::clamp(1.0 - bestValue, 0.0, 1.0))
        : 0.0f;
    const bool candidate = rms >= kMinimumVoicedRms && bestLag > 0U && bestValue < threshold;
    if (candidate) {
        ++goodFrames;
        badFrames = 0U;
        double refinedLag = static_cast<double>(bestLag);
        if (bestLag > minimumLag && bestLag < maximumLag) {
            const double left = normalizedDifferences[bestLag - 1U];
            const double center = normalizedDifferences[bestLag];
            const double right = normalizedDifferences[bestLag + 1U];
            const double denominator = left - 2.0 * center + right;
            if (std::fabs(denominator) > 1.0e-12) {
                refinedLag += std::clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
            }
        }
        const float measuredHz = static_cast<float>(static_cast<double>(sampleRate) / refinedLag);
        const double measuredLog = std::log(static_cast<double>(measuredHz));
        if (goodFrames == 1U || previousMeasuredLogFrequency <= 0.0) {
            stableFrames = 1U;
        } else if (std::fabs(measuredLog - previousMeasuredLogFrequency) <= kMaximumPsolaStepLogFrequency) {
            if (stableFrames < 1000U) ++stableFrames;
        } else {
            stableFrames = 1U;
        }
        previousMeasuredLogFrequency = measuredLog;
        if (goodFrames == 1U || frequencyHz <= 0.0f) {
            smoothedLogFrequency = measuredLog;
        } else {
            smoothedLogFrequency += (measuredLog - smoothedLogFrequency) * 0.35;
        }
        frequencyHz = static_cast<float>(std::exp(smoothedLogFrequency));
        if (goodFrames >= 2U) voiced = true;
    } else {
        goodFrames = 0U;
        stableFrames = 0U;
        previousMeasuredLogFrequency = 0.0;
        ++badFrames;
        if (badFrames >= 3U) voiced = false;
    }
}

bool NativeRobotCore::validConfig(const Config& config) noexcept {
    if (config.sampleRate < kMinimumSampleRate || config.sampleRate > kMaximumSampleRate ||
        config.channels == 0U || config.channels > kMaximumChannels ||
        !validPitchMode(config.pitchMode) || !validFormantPolicy(config.formantPolicy) ||
        !std::isfinite(config.pitchSemitones) ||
        config.pitchSemitones < -kMaximumPitchShift || config.pitchSemitones > kMaximumPitchShift ||
        !std::isfinite(config.formantSemitones) ||
        config.formantSemitones < -kMaximumFormantShift || config.formantSemitones > kMaximumFormantShift ||
        !std::isfinite(config.mixPercent) || config.mixPercent < 0.0f || config.mixPercent > 100.0f) {
        return false;
    }
    if (config.formantPolicy != FormantPolicy::IndependentShift && config.formantSemitones != 0.0f) {
        return false;
    }
    return true;
}

bool NativeRobotCore::prepare(const Config& config) noexcept {
    prepared_ = false;
    if (!validConfig(config)) return false;
    if (!pitchProcessor_.prepareForFx(config.sampleRate, 0.0f)) return false;
    // The voice path raises only PSOLA's transient floor: formant-rich voiced
    // cycles can have large adjacent-sample slopes that otherwise hold off
    // every grain. Other NativePitchProcessor users keep the 0.08 default.
    if (!psolaLeft_.prepare(config.sampleRate, kPsolaMinimumFrequencyHz, kPsolaMaximumFrequencyHz,
            0.0f, 0.105f)) {
        return false;
    }
    if (config.channels == 2U &&
        !psolaRight_.prepare(config.sampleRate, kPsolaMinimumFrequencyHz, kPsolaMaximumFrequencyHz,
            0.0f, 0.105f)) {
        return false;
    }
    const unsigned int signalsmithLatency = pitchProcessor_.latencySamples();
    const unsigned int psolaLatency = psolaLeft_.latencySamples();
    const unsigned int commonLatency = std::max(signalsmithLatency, psolaLatency);
    if (commonLatency == 0U || commonLatency >= kDryRingCapacityFrames) return false;

    const unsigned int decimation = std::max(1U, static_cast<unsigned int>(std::ceil(
        static_cast<double>(config.sampleRate) / 12000.0)));
    const unsigned int detectorRate = static_cast<unsigned int>(std::lround(
        static_cast<double>(config.sampleRate) / static_cast<double>(decimation)));
    if (!tracker_.configure(detectorRate)) return false;

    config_ = config;
    detectorDecimation_ = decimation;
    algorithmicLatencyFrames_ = commonLatency;
    psolaAlgorithmLatencyFrames_ = psolaLatency;
    psolaOutputAlignmentFrames_ = commonLatency - psolaLatency;
    prepared_ = true;
    reset();
    return prepared_;
}

bool NativeRobotCore::configure(const Config& config) noexcept {
    if (!validConfig(config)) return false;
    if (!prepared_ || config.sampleRate != config_.sampleRate || config.channels != config_.channels) {
        return prepare(config);
    }
    return applyRuntimeConfig(config);
}

bool NativeRobotCore::applyRuntimeConfig(const Config& config) noexcept {
    if (!validConfig(config)) return false;
    const Config previous = config_;
    config_ = config;
    if (prepared_ && !updatePitchTarget()) {
        config_ = previous;
        (void)updatePitchTarget();
        return false;
    }
    return true;
}

bool NativeRobotCore::setPitchSemitones(float semitones) noexcept {
    Config updated = config_;
    updated.pitchSemitones = semitones;
    if (!validConfig(updated)) return false;
    fixedMidiNote_ = -1;
    return applyRuntimeConfig(updated);
}

bool NativeRobotCore::setFixedMidiNote(unsigned int note) noexcept {
    if (note < 60U || note > 71U) return false;
    fixedMidiNote_ = static_cast<int>(note);
    return !prepared_ || updatePitchTarget();
}

bool NativeRobotCore::setFormantSemitones(float semitones) noexcept {
    if (!std::isfinite(semitones) || semitones < -kMaximumFormantShift || semitones > kMaximumFormantShift) {
        return false;
    }
    if (semitones != 0.0f && config_.formantPolicy != FormantPolicy::IndependentShift) return false;
    Config updated = config_;
    updated.formantSemitones = semitones;
    return applyRuntimeConfig(updated);
}

bool NativeRobotCore::setFormantPolicy(FormantPolicy policy) noexcept {
    Config updated = config_;
    updated.formantPolicy = policy;
    return applyRuntimeConfig(updated);
}

bool NativeRobotCore::setPitchMode(PitchMode mode) noexcept {
    Config updated = config_;
    updated.pitchMode = mode;
    if (!validConfig(updated)) return false;
    fixedMidiNote_ = -1;
    return applyRuntimeConfig(updated);
}

bool NativeRobotCore::setMixPercent(float percent) noexcept {
    Config updated = config_;
    updated.mixPercent = percent;
    return applyRuntimeConfig(updated);
}

void NativeRobotCore::reset() noexcept {
    if (prepared_) {
        pitchProcessor_.reset();
        psolaLeft_.reset();
        if (config_.channels == 2U) psolaRight_.reset();
    }
    tracker_.reset();
    dryRing_.fill(0.0f);
    psolaAlignmentRing_.fill(0.0f);
    psolaLeftScratch_.fill(0.0f);
    psolaRightScratch_.fill(0.0f);
    decimatorCount_ = 0U;
    decimatorSum_ = 0.0;
    appliedPitchSemitones_ = 0.0f;
    appliedFormantSemitones_ = 0.0f;
    trackedFormantBaseHz_ = 0.0f;
    lastConfiguredFormantSemitones_ = 0.0f;
    lastConfiguredFormantBaseHz_ = 0.0f;
    targetMidiNote_ = -1;
    quantizedPitchTargetMidiNote_ = -1;
    wetActive_ = false;
    formantCompensationEnabled_ = false;
    hasConfiguredFormant_ = false;
    hasConfiguredFormantBase_ = false;
    processingMode_ = ProcessingMode::SignalsmithFallback;
    fallbackReason_ = FallbackReason::Unvoiced;
    currentFrame_.store(0U, std::memory_order_release);
    if (prepared_ && !updatePitchTarget()) prepared_ = false;
}

bool NativeRobotCore::synchronizeFrame(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return false;
    const std::uint64_t current = currentFrame_.load(std::memory_order_acquire);
    if (absoluteFrame < current) return false;
    if (absoluteFrame > current) currentFrame_.store(absoluteFrame, std::memory_order_release);
    return true;
}

float NativeRobotCore::sourceMidiNote() const noexcept {
    if (!tracker_.voiced || tracker_.frequencyHz <= 0.0f) return -1.0f;
    return static_cast<float>(69.0 + 12.0 * std::log2(static_cast<double>(tracker_.frequencyHz) / 440.0));
}

bool NativeRobotCore::updatePitchTarget() noexcept {
    const float sourceMidi = sourceMidiNote();
    targetMidiNote_ = -1;
    wetActive_ = tracker_.voiced && sourceMidi >= 0.0f;
    float targetShift = 0.0f;
    if (wetActive_) {
        if (fixedMidiNote_ >= 0) {
            targetMidiNote_ = fixedMidiNote_;
            targetShift = static_cast<float>(fixedMidiNote_) - sourceMidi;
        } else if (config_.pitchMode == PitchMode::FixedShift) {
            quantizedPitchTargetMidiNote_ = -1;
            targetShift = config_.pitchSemitones;
            targetMidiNote_ = static_cast<int>(std::lround(sourceMidi + targetShift));
        } else {
            const float candidateMidi = sourceMidi + config_.pitchSemitones;
            if (quantizedPitchTargetMidiNote_ < 0 ||
                candidateMidi > static_cast<float>(quantizedPitchTargetMidiNote_) + 0.55f ||
                candidateMidi < static_cast<float>(quantizedPitchTargetMidiNote_) - 0.55f) {
                quantizedPitchTargetMidiNote_ = static_cast<int>(std::lround(candidateMidi));
            }
            targetMidiNote_ = quantizedPitchTargetMidiNote_;
            targetShift = static_cast<float>(targetMidiNote_) - sourceMidi;
        }
        targetShift = fixedMidiNote_ >= 0 ? std::clamp(targetShift, -36.0f, 48.0f)
            : std::clamp(targetShift, -kMaximumPitchShift, kMaximumPitchShift);
        targetMidiNote_ = static_cast<int>(std::lround(sourceMidi + targetShift));
        if (config_.pitchMode == PitchMode::NearestSemitone) {
            quantizedPitchTargetMidiNote_ = targetMidiNote_;
        }
    } else {
        quantizedPitchTargetMidiNote_ = -1;
    }

    if (std::fabs(pitchProcessor_.semitones() - targetShift) > 0.0001f &&
        !(fixedMidiNote_ >= 0 ? pitchProcessor_.setOfficialBendSemitones(targetShift)
                             : pitchProcessor_.setSemitones(targetShift))) {
        return false;
    }
    const float psolaShift = std::clamp(targetShift, -kMaximumPsolaShift, kMaximumPsolaShift);
    if (std::fabs(psolaLeft_.semitones() - psolaShift) > 0.0001f &&
        !psolaLeft_.setSemitones(psolaShift)) {
        return false;
    }
    if (config_.channels == 2U &&
        std::fabs(psolaRight_.semitones() - psolaShift) > 0.0001f &&
        !psolaRight_.setSemitones(psolaShift)) {
        return false;
    }

    float formantShift = 0.0f;
    bool compensatePitch = false;
    if (config_.formantPolicy == FormantPolicy::Preserve) {
        compensatePitch = true;
    } else if (config_.formantPolicy == FormantPolicy::IndependentShift) {
        compensatePitch = true;
        formantShift = config_.formantSemitones;
    }
    if (!hasConfiguredFormant_ ||
        std::fabs(lastConfiguredFormantSemitones_ - formantShift) > 0.0001f ||
        formantCompensationEnabled_ != compensatePitch) {
        if (!pitchProcessor_.setFormantSemitones(formantShift, compensatePitch)) return false;
        lastConfiguredFormantSemitones_ = formantShift;
        formantCompensationEnabled_ = compensatePitch;
        hasConfiguredFormant_ = true;
    }
    // Explicit F0 anchoring makes formant correction track the same bounded
    // monophonic estimate as the pitch target. Zero asks Signalsmith to use its
    // own estimator until a valid tracked fundamental is available.
    const float formantBase = wetActive_ ? tracker_.frequencyHz : 0.0f;
    if (!hasConfiguredFormantBase_ ||
        std::fabs(lastConfiguredFormantBaseHz_ - formantBase) > 0.1f) {
        if (!pitchProcessor_.setFormantBaseHz(formantBase)) return false;
        lastConfiguredFormantBaseHz_ = formantBase;
        hasConfiguredFormantBase_ = true;
    }
    appliedPitchSemitones_ = targetShift;
    appliedFormantSemitones_ = lastConfiguredFormantSemitones_;
    trackedFormantBaseHz_ = lastConfiguredFormantBaseHz_;
    return true;
}

void NativeRobotCore::selectProcessingMode() noexcept {
    processingMode_ = ProcessingMode::SignalsmithFallback;
    if (!tracker_.voiced || tracker_.frequencyHz <= 0.0f) {
        fallbackReason_ = FallbackReason::Unvoiced;
    } else if (tracker_.stableFrames < kMinimumStablePitchFrames) {
        fallbackReason_ = FallbackReason::UnstablePitch;
    } else if (tracker_.confidence < kPsolaMinimumConfidence) {
        fallbackReason_ = FallbackReason::AmbiguousOrLowConfidence;
    } else if (tracker_.frequencyHz < kPsolaMinimumFrequencyHz) {
        fallbackReason_ = FallbackReason::BelowPsolaFrequencyRange;
    } else if (tracker_.frequencyHz > kPsolaMaximumFrequencyHz) {
        fallbackReason_ = FallbackReason::AbovePsolaFrequencyRange;
    } else if (std::fabs(appliedPitchSemitones_) > kMaximumPsolaShift) {
        fallbackReason_ = FallbackReason::PitchShiftOutsidePsolaRange;
    } else if (config_.formantPolicy == FormantPolicy::IndependentShift &&
               std::fabs(config_.formantSemitones) > 0.0001f) {
        fallbackReason_ = FallbackReason::IndependentFormantShiftRequiresSignalsmith;
    } else if (config_.formantPolicy == FormantPolicy::CoupledToPitch &&
               std::fabs(appliedPitchSemitones_) > 0.0001f) {
        fallbackReason_ = FallbackReason::CoupledFormantPolicyRequiresSignalsmith;
    } else if (!psolaLeft_.voiced() || psolaLeft_.confidence() < kPsolaProcessorConfidence) {
        fallbackReason_ = FallbackReason::PsolaDetectorNotConfident;
    } else if (config_.channels == 2U &&
               (!psolaRight_.voiced() || psolaRight_.confidence() < kPsolaProcessorConfidence)) {
        fallbackReason_ = FallbackReason::PsolaDetectorNotConfident;
    } else {
        processingMode_ = ProcessingMode::TdPsola;
        fallbackReason_ = FallbackReason::None;
    }
}

bool NativeRobotCore::processInterleaved(float* interleaved, unsigned int frames,
                                         unsigned int channels) noexcept {
    if (!prepared_ || channels != config_.channels || channels == 0U || channels > kMaximumChannels ||
        (frames > 0U && interleaved == nullptr)) {
        return false;
    }
    if (frames == 0U) return true;
    const std::uint64_t start = currentFrame_.load(std::memory_order_acquire);
    if (static_cast<std::uint64_t>(frames) > std::numeric_limits<std::uint64_t>::max() - start) return false;

    unsigned int processedFrames = 0U;
    while (processedFrames < frames) {
        const std::uint64_t segmentStart = currentFrame_.load(std::memory_order_relaxed);
        const unsigned int segmentFrames = std::min(kMaximumControlQuantumFrames, frames - processedFrames);
        for (unsigned int frame = 0U; frame < segmentFrames; ++frame) {
            const std::size_t frameOffset = static_cast<std::size_t>(processedFrames + frame) * channels;
            const std::size_t ringOffset = static_cast<std::size_t>((segmentStart + frame) & kDryRingMask) * channels;
            double mono = 0.0;
            for (unsigned int channel = 0U; channel < channels; ++channel) {
                float sample = interleaved[frameOffset + channel];
                if (!std::isfinite(sample)) sample = 0.0f;
                interleaved[frameOffset + channel] = sample;
                dryRing_[ringOffset + channel] = sample;
                if (channel == 0U) psolaLeftScratch_[frame] = sample;
                else psolaRightScratch_[frame] = sample;
                mono += static_cast<double>(sample);
            }
            mono /= static_cast<double>(channels);
            decimatorSum_ += mono;
            ++decimatorCount_;
            if (decimatorCount_ >= detectorDecimation_) {
                tracker_.pushSample(static_cast<float>(decimatorSum_ / static_cast<double>(detectorDecimation_)));
                decimatorCount_ = 0U;
                decimatorSum_ = 0.0;
            }
        }

        if (!updatePitchTarget()) {
            prepared_ = false;
            return false;
        }
        float* segment = interleaved + static_cast<std::size_t>(processedFrames) * channels;
        if (!psolaLeft_.processInPlace(psolaLeftScratch_.data(), segmentFrames) ||
            (channels == 2U && !psolaRight_.processInPlace(psolaRightScratch_.data(), segmentFrames))) {
            prepared_ = false;
            return false;
        }
        if (!pitchProcessor_.processInterleaved(segment, segmentFrames, channels)) {
            prepared_ = false;
            return false;
        }
        selectProcessingMode();

        const float mix = wetActive_ ? config_.mixPercent / 100.0f : 0.0f;
        const std::uint64_t latency = latencyFrames();
        for (unsigned int frame = 0U; frame < segmentFrames; ++frame) {
            const std::uint64_t absoluteFrame = segmentStart + frame;
            const std::size_t frameOffset = static_cast<std::size_t>(processedFrames + frame) * channels;
            const std::size_t alignmentRingOffset = static_cast<std::size_t>(absoluteFrame & kDryRingMask) * channels;
            const std::size_t delayedRingOffset = absoluteFrame >= latency
                ? static_cast<std::size_t>((absoluteFrame - latency) & kDryRingMask) * channels
                : 0U;
            for (unsigned int channel = 0U; channel < channels; ++channel) {
                const float dry = absoluteFrame >= latency ? dryRing_[delayedRingOffset + channel] : 0.0f;
                const float psolaSample = channel == 0U ? psolaLeftScratch_[frame] : psolaRightScratch_[frame];
                psolaAlignmentRing_[alignmentRingOffset + channel] = std::isfinite(psolaSample) ? psolaSample : 0.0f;
                const float psolaWet = absoluteFrame >= psolaOutputAlignmentFrames_
                    ? psolaAlignmentRing_[static_cast<std::size_t>((absoluteFrame - psolaOutputAlignmentFrames_) &
                        kDryRingMask) * channels + channel]
                    : 0.0f;
                const float fallbackWet = std::isfinite(interleaved[frameOffset + channel])
                    ? interleaved[frameOffset + channel] : 0.0f;
                const float wet = processingMode_ == ProcessingMode::TdPsola ? psolaWet : fallbackWet;
                const float output = wetActive_
                    ? dry * (1.0f - mix) + wet * mix
                    : dry;
                interleaved[frameOffset + channel] = std::isfinite(output) ? output : 0.0f;
            }
        }
        processedFrames += segmentFrames;
        currentFrame_.store(segmentStart + segmentFrames, std::memory_order_release);
    }
    return true;
}

} // namespace webrc::native
