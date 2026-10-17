#include "native_pitch_processor.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::native {

namespace {

constexpr float kMinimumFrequencyHz = 20.0f;
constexpr float kVoicingConfidence = 0.55f;
constexpr double kTwoPi = 6.28318530717958647692;

[[nodiscard]] bool finiteInRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] unsigned int ceilToUnsigned(double value) noexcept {
    if (!std::isfinite(value) || value < 1.0 || value > static_cast<double>(std::numeric_limits<unsigned int>::max())) {
        return 0U;
    }
    return static_cast<unsigned int>(std::ceil(value));
}

} // namespace

NativePitchRouteDecision decideNativePitchRoute(
    bool requested,
    bool processorPrepared,
    bool reversePlayback,
    unsigned int channelCount,
    std::uint64_t loopLengthSamples,
    std::uint64_t latencySamples
) noexcept {
    if (!requested) return {false, NativePitchFallbackReason::NotRequested};
    if (!processorPrepared) return {false, NativePitchFallbackReason::ProcessorNotPrepared};
    if (reversePlayback) return {false, NativePitchFallbackReason::ReversePlayback};
    if (channelCount == 0U || channelCount > 2U) {
        return {false, NativePitchFallbackReason::UnsupportedChannelCount};
    }
    if (loopLengthSamples <= latencySamples) {
        return {false, NativePitchFallbackReason::LoopShorterThanLatency};
    }
    return {true, NativePitchFallbackReason::None};
}

unsigned int NativePitchProcessor::nextPowerOfTwo(unsigned int value) noexcept {
    if (value <= 1U) return 1U;
    --value;
    value |= value >> 1U;
    value |= value >> 2U;
    value |= value >> 4U;
    value |= value >> 8U;
    value |= value >> 16U;
    return value == std::numeric_limits<unsigned int>::max() ? 0U : value + 1U;
}

bool NativePitchProcessor::validSemitones(float semitones) noexcept {
    return finiteInRange(semitones, -12.0f, 12.0f);
}

bool NativePitchProcessor::validConfiguration(
    unsigned int sampleRate,
    float minimumFrequencyHz,
    float maximumFrequencyHz,
    float semitones,
    float transientThresholdFloor
) const noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate || !validSemitones(semitones) ||
        !finiteInRange(transientThresholdFloor, 0.01f, 1.0f)) {
        return false;
    }
    const unsigned int decimation = std::max(1U, static_cast<unsigned int>(std::ceil(static_cast<double>(sampleRate) / 12000.0)));
    const float detectorRate = static_cast<float>(sampleRate) / static_cast<float>(decimation);
    if (!finiteInRange(minimumFrequencyHz, kMinimumFrequencyHz, detectorRate / 2.0f) ||
        !finiteInRange(maximumFrequencyHz, minimumFrequencyHz + 1.0f, detectorRate / 2.0f)) {
        return false;
    }
    const double maximumLag = std::ceil(static_cast<double>(detectorRate) / static_cast<double>(minimumFrequencyHz));
    return maximumLag >= 2.0 && maximumLag <= static_cast<double>(kMaximumDetectorLag);
}

unsigned int NativePitchProcessor::calculateLatencySamples(
    unsigned int sampleRate,
    float minimumFrequencyHz
) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate || !std::isfinite(minimumFrequencyHz)) {
        return 0U;
    }
    const unsigned int decimation = std::max(1U, static_cast<unsigned int>(std::ceil(static_cast<double>(sampleRate) / 12000.0)));
    const double detectorRate = static_cast<double>(sampleRate) / static_cast<double>(decimation);
    if (minimumFrequencyHz < kMinimumFrequencyHz || static_cast<double>(minimumFrequencyHz) >= detectorRate / 2.0) {
        return 0U;
    }
    const auto maximumLag = ceilToUnsigned(detectorRate / static_cast<double>(minimumFrequencyHz));
    if (maximumLag < 2U || maximumLag > kMaximumDetectorLag) return 0U;
    const unsigned int frameSamples = std::max(64U, maximumLag * 3U);
    const unsigned int detectorHop = std::max(1U, static_cast<unsigned int>(std::lround(detectorRate * 0.005)));
    const unsigned int maximumPeriod = ceilToUnsigned(static_cast<double>(sampleRate) / static_cast<double>(minimumFrequencyHz));
    if (maximumPeriod == 0U) return 0U;
    const unsigned int searchRadius = (maximumPeriod + 1U) / 2U;
    const auto detectorDelay = ceilToUnsigned(
        (static_cast<double>(frameSamples) / 2.0 + static_cast<double>(detectorHop * 2U) + 2.0) * static_cast<double>(decimation)
    );
    if (detectorDelay == 0U || maximumPeriod > std::numeric_limits<unsigned int>::max() - searchRadius) return 0U;
    const unsigned int generationDelay = std::max(detectorDelay, maximumPeriod + searchRadius);
    if (generationDelay > std::numeric_limits<unsigned int>::max() - maximumPeriod) return 0U;
    return generationDelay + maximumPeriod;
}

bool NativePitchProcessor::YinDetector::configure(
    unsigned int rate,
    float minimumFrequencyHz,
    float maximumFrequencyHz,
    unsigned int analysisHopSamples
) noexcept {
    if (rate < NativePitchProcessor::kMinimumSampleRate || !std::isfinite(minimumFrequencyHz) ||
        !std::isfinite(maximumFrequencyHz) || maximumFrequencyHz <= minimumFrequencyHz) {
        return false;
    }
    const auto minLag = static_cast<unsigned int>(std::max(2.0, std::floor(static_cast<double>(rate) / maximumFrequencyHz)));
    const auto maxLag = ceilToUnsigned(static_cast<double>(rate) / minimumFrequencyHz);
    if (maxLag < minLag || maxLag > kMaximumDetectorLag) return false;
    const unsigned int frame = std::max(64U, maxLag * 3U);
    const unsigned int capacity = NativePitchProcessor::nextPowerOfTwo(frame * 2U);
    if (capacity == 0U || capacity > kMaximumDetectorRing || analysisHopSamples == 0U || analysisHopSamples > frame) {
        return false;
    }

    sampleRate = rate;
    minimumLag = minLag;
    maximumLag = maxLag;
    frameSamples = frame;
    analysisWindowSamples = frame - maxLag;
    hopSamples = analysisHopSamples;
    ringCapacity = capacity;
    ringMask = capacity - 1U;
    reset();
    return true;
}

void NativePitchProcessor::YinDetector::reset() noexcept {
    // The detector does not analyze until frameSamples fresh samples arrive;
    // every ring value and every CMND entry is overwritten before use.
    writeIndex = 0U;
    sampleCount = 0U;
    nextAnalysisSample = frameSamples;
    analysisSerial = 0U;
    estimateTimeSamples = 0U;
    goodFrames = 0U;
    badFrames = 0U;
    currentFrequencyHz = 0.0f;
    currentConfidence = 0.0f;
    smoothedLogFrequency = 0.0f;
    currentVoiced = false;
}

void NativePitchProcessor::YinDetector::pushSample(float sample) noexcept {
    ring[writeIndex] = std::isfinite(sample) ? sample : 0.0f;
    writeIndex = (writeIndex + 1U) & ringMask;
    ++sampleCount;
    if (sampleCount < nextAnalysisSample) return;
    analyzeFrame();
    nextAnalysisSample += hopSamples;
}

void NativePitchProcessor::YinDetector::analyzeFrame() noexcept {
    const unsigned int frameStart = (writeIndex + ringCapacity - frameSamples) & ringMask;
    double energy = 0.0;
    for (unsigned int i = 0U; i < frameSamples; ++i) {
        const float sample = ring[(frameStart + i) & ringMask];
        energy += static_cast<double>(sample) * static_cast<double>(sample);
    }
    const double rms = std::sqrt(energy / static_cast<double>(frameSamples));

    differences[0] = 0.0;
    for (unsigned int lag = 1U; lag <= maximumLag; ++lag) {
        double sum = 0.0;
        for (unsigned int i = 0U; i < analysisWindowSamples; ++i) {
            const float first = ring[(frameStart + i) & ringMask];
            const float second = ring[(frameStart + i + lag) & ringMask];
            const double delta = static_cast<double>(first) - static_cast<double>(second);
            sum += delta * delta;
        }
        differences[lag] = sum;
    }

    double cumulativeDifference = 0.0;
    for (unsigned int lag = 1U; lag <= maximumLag; ++lag) {
        const double difference = differences[lag];
        cumulativeDifference += difference;
        normalizedDifferences[lag] = cumulativeDifference > 1.0e-15
            ? (difference * static_cast<double>(lag)) / cumulativeDifference
            : 1.0;
    }

    unsigned int bestLag = 0U;
    double bestValue = std::numeric_limits<double>::infinity();
    const double activeThreshold = currentVoiced ? std::min(0.28, static_cast<double>(threshold + 0.05f)) : static_cast<double>(threshold);
    for (unsigned int lag = minimumLag; lag <= maximumLag; ++lag) {
        const double value = normalizedDifferences[lag];
        if (value < bestValue) {
            bestValue = value;
            bestLag = lag;
        }
        if (value < activeThreshold &&
            (lag == maximumLag || value <= normalizedDifferences[lag + 1U])) {
            bestLag = lag;
            while (bestLag < maximumLag && normalizedDifferences[bestLag + 1U] < normalizedDifferences[bestLag]) {
                ++bestLag;
            }
            bestValue = normalizedDifferences[bestLag];
            break;
        }
    }

    estimateTimeSamples = sampleCount - static_cast<std::uint64_t>(frameSamples / 2U) - 1U;
    currentConfidence = std::isfinite(bestValue)
        ? static_cast<float>(std::clamp(1.0 - bestValue, 0.0, 1.0))
        : 0.0f;

    const bool candidate = rms >= 1.0e-4 && bestLag > 0U && bestValue < activeThreshold;
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
        if (goodFrames == 1U || currentFrequencyHz <= 0.0f) {
            smoothedLogFrequency = std::log(measuredHz);
        } else {
            smoothedLogFrequency += (std::log(measuredHz) - smoothedLogFrequency) * 0.35f;
        }
        currentFrequencyHz = std::exp(smoothedLogFrequency);
        if (goodFrames >= 2U) currentVoiced = true;
    } else {
        goodFrames = 0U;
        ++badFrames;
        if (badFrames >= 2U) currentVoiced = false;
    }
    ++analysisSerial;
}

bool NativePitchProcessor::prepare(
    unsigned int sampleRate,
    float minimumFrequencyHz,
    float maximumFrequencyHz,
    float semitones,
    float transientThresholdFloor
) noexcept {
    prepared_ = false;
    sampleRate_ = 0U;
    latencySamples_ = 0U;
    if (!validConfiguration(sampleRate, minimumFrequencyHz, maximumFrequencyHz, semitones,
            transientThresholdFloor)) return false;

    const unsigned int decimation = std::max(1U, static_cast<unsigned int>(std::ceil(static_cast<double>(sampleRate) / 12000.0)));
    const unsigned int detectorRate = static_cast<unsigned int>(std::lround(static_cast<double>(sampleRate) / static_cast<double>(decimation)));
    const unsigned int detectorHop = std::max(1U, static_cast<unsigned int>(std::lround(static_cast<double>(detectorRate) * 0.005)));
    const unsigned int maximumPeriod = ceilToUnsigned(static_cast<double>(sampleRate) / static_cast<double>(minimumFrequencyHz));
    const unsigned int maximumSearchRadius = (maximumPeriod + 1U) / 2U;
    if (maximumPeriod == 0U || maximumPeriod > (std::numeric_limits<unsigned int>::max() / 2U) ||
        maximumSearchRadius > (std::numeric_limits<unsigned int>::max() / 2U)) {
        return false;
    }
    if (!detector_.configure(detectorRate, minimumFrequencyHz, maximumFrequencyHz, detectorHop)) return false;

    const auto rawHop = static_cast<std::uint64_t>(detectorHop) * decimation;
    const auto rawDetectorDelayDouble =
        (static_cast<double>(detector_.frameSamples) / 2.0 + static_cast<double>(detectorHop) * 2.0 + 2.0) * decimation;
    const unsigned int rawDetectorDelay = ceilToUnsigned(rawDetectorDelayDouble);
    const unsigned int generationDelay = std::max(rawDetectorDelay, maximumPeriod + maximumSearchRadius);
    if (rawDetectorDelay == 0U || generationDelay > std::numeric_limits<unsigned int>::max() - maximumPeriod) return false;
    const unsigned int latency = generationDelay + maximumPeriod;
    const auto inputRequired64 = static_cast<std::uint64_t>(latency) +
        static_cast<std::uint64_t>(detector_.frameSamples) * decimation + 16U;
    const auto outputRequired64 = static_cast<std::uint64_t>(maximumPeriod) * 2U + 16U;
    const auto historyRequired64 = (static_cast<std::uint64_t>(latency) + rawDetectorDelay + rawHop - 1U) / rawHop + 16U;
    if (inputRequired64 > std::numeric_limits<unsigned int>::max() ||
        outputRequired64 > std::numeric_limits<unsigned int>::max() ||
        historyRequired64 > kMaximumPitchHistory) {
        return false;
    }
    const unsigned int inputCapacity = nextPowerOfTwo(static_cast<unsigned int>(inputRequired64));
    const unsigned int outputCapacity = nextPowerOfTwo(static_cast<unsigned int>(outputRequired64));
    const unsigned int historyCapacity = nextPowerOfTwo(static_cast<unsigned int>(historyRequired64));
    if (inputCapacity == 0U || outputCapacity == 0U || historyCapacity == 0U ||
        inputCapacity < inputRequired64 || outputCapacity < outputRequired64 || historyCapacity < historyRequired64) {
        return false;
    }

    try {
        inputRing_.assign(inputCapacity, 0.0f);
        transientRing_.assign(inputCapacity, 0U);
        outputSumRing_.assign(outputCapacity, 0.0);
        outputWeightRing_.assign(outputCapacity, 0.0);
        outputRingGeneration_.assign(outputCapacity, 0U);
        pitchTimes_.assign(historyCapacity, 0U);
        pitchFrequencies_.assign(historyCapacity, 0.0f);
        pitchConfidences_.assign(historyCapacity, 0.0f);
        pitchVoiced_.assign(historyCapacity, 0U);
    } catch (const std::bad_alloc&) {
        inputRing_.clear();
        transientRing_.clear();
        outputSumRing_.clear();
        outputWeightRing_.clear();
        pitchTimes_.clear();
        pitchFrequencies_.clear();
        pitchConfidences_.clear();
        pitchVoiced_.clear();
        return false;
    } catch (...) {
        inputRing_.clear();
        transientRing_.clear();
        outputSumRing_.clear();
        outputWeightRing_.clear();
        pitchTimes_.clear();
        pitchFrequencies_.clear();
        pitchConfidences_.clear();
        pitchVoiced_.clear();
        return false;
    }

    sampleRate_ = sampleRate;
    decimation_ = decimation;
    detectorHopRawSamples_ = static_cast<unsigned int>(rawHop);
    detectorDelayRawSamples_ = rawDetectorDelay;
    maximumPeriodSamples_ = maximumPeriod;
    maximumSearchRadius_ = maximumSearchRadius;
    generationDelaySamples_ = generationDelay;
    latencySamples_ = latency;
    inputRingMask_ = inputCapacity - 1U;
    outputRingMask_ = outputCapacity - 1U;
    pitchHistoryMask_ = historyCapacity - 1U;
    transientHoldSamples_ = std::max(1U, static_cast<unsigned int>(std::lround(static_cast<double>(sampleRate) * 0.012)));
    transientThresholdFloor_ = transientThresholdFloor;
    mixSmoothing_ = static_cast<float>(1.0 - std::exp(-1.0 / (static_cast<double>(sampleRate) * 0.008)));
    ratioSmoothing_ = static_cast<float>(1.0 - std::exp(-1.0 / (static_cast<double>(sampleRate) * 0.012)));
    targetSemitones_ = semitones;
    targetRatio_ = std::pow(2.0f, semitones / 12.0f);
    currentRatio_ = targetRatio_;
    prepared_ = true;
    reset();
    return true;
}

bool NativePitchProcessor::setSemitones(float semitones) noexcept {
    if (!prepared_ || !validSemitones(semitones)) return false;
    targetSemitones_ = semitones;
    targetRatio_ = std::pow(2.0f, semitones / 12.0f);
    return true;
}

void NativePitchProcessor::reset() noexcept {
    if (!prepared_) return;
    // Logical invalidation keeps transport resets bounded and allocation-free
    // in the real-time callback, regardless of the selected sample rate.
    ++resetGeneration_;
    if (resetGeneration_ == 0U) {
        std::fill(outputRingGeneration_.begin(), outputRingGeneration_.end(), 0U);
        resetGeneration_ = 1U;
    }
    detector_.reset();
    inputSampleCursor_ = 0U;
    decimatorCount_ = 0U;
    decimatorSum_ = 0.0;
    detectorSerial_ = 0U;
    pitchHistoryWrite_ = 0U;
    pitchHistoryCount_ = 0U;
    latestPitchHistoryIndex_ = -1;
    latestPitchTime_ = 0U;
    nextSynthesisCenter_ = static_cast<double>(latencySamples_);
    currentRatio_ = targetRatio_;
    outputMix_ = 0.0f;
    previousInput_ = 0.0f;
    derivativeEnvelope_ = 0.0f;
    transientCountdown_ = 0U;
    lookupFrequency_ = 0.0f;
    lookupConfidence_ = 0.0f;
    lookupVoiced_ = false;
    detectorVoiced_ = false;
    detectorFrequencyHz_ = 0.0f;
    detectorConfidence_ = 0.0f;
    monoScratch_.fill(0.0f);
}

bool NativePitchProcessor::processInPlace(float* monoSamples, unsigned int frames) noexcept {
    if (!prepared_ || (monoSamples == nullptr && frames != 0U)) return false;
    if (frames == 0U) return true;

    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const std::uint64_t absoluteSample = inputSampleCursor_;
        const float inputSample = std::isfinite(monoSamples[frame]) ? monoSamples[frame] : 0.0f;
        const unsigned int inputIndex = static_cast<unsigned int>(absoluteSample) & inputRingMask_;
        inputRing_[inputIndex] = inputSample;

        const float difference = inputSample - previousInput_;
        const float absoluteDifference = std::fabs(difference);
        derivativeEnvelope_ += (absoluteDifference - derivativeEnvelope_) * 0.025f;
        // A caller may raise the absolute floor for high-harmonic voices that
        // would otherwise retrigger the 12 ms hold on every period. The default
        // remains 0.08f to preserve the processor's existing attack behavior.
        const float transientThreshold = std::max(transientThresholdFloor_, derivativeEnvelope_ * 4.5f);
        if (absoluteDifference > transientThreshold) {
            transientCountdown_ = transientHoldSamples_;
        } else if (transientCountdown_ > 0U) {
            --transientCountdown_;
        }
        transientRing_[inputIndex] = transientCountdown_ > 0U ? 1U : 0U;
        previousInput_ = inputSample;

        decimatorSum_ += inputSample;
        ++decimatorCount_;
        if (decimatorCount_ >= decimation_) {
            detector_.pushSample(static_cast<float>(decimatorSum_ / static_cast<double>(decimation_)));
            decimatorCount_ = 0U;
            decimatorSum_ = 0.0;
            if (detector_.analysisSerial != detectorSerial_) {
                detectorSerial_ = detector_.analysisSerial;
                detectorVoiced_ = detector_.currentVoiced;
                detectorFrequencyHz_ = detector_.currentVoiced ? detector_.currentFrequencyHz : 0.0f;
                detectorConfidence_ = detector_.currentConfidence;
                storePitchEstimate(detector_.estimateTimeSamples * static_cast<std::uint64_t>(decimation_));
            }
        }

        currentRatio_ += (targetRatio_ - currentRatio_) * ratioSmoothing_;
        const double latestSafeCenter = static_cast<double>(absoluteSample) + static_cast<double>(latencySamples_) -
            static_cast<double>(generationDelaySamples_);
        while (nextSynthesisCenter_ <= latestSafeCenter) synthesizePitchGrain(nextSynthesisCenter_);

        const std::int64_t delayedSample = static_cast<std::int64_t>(absoluteSample) - static_cast<std::int64_t>(latencySamples_);
        const float delayedInput = delayedSample >= 0 ? readInput(delayedSample) : 0.0f;
        float desiredMix = 0.0f;
        if (targetSemitones_ != 0.0f && lookupPitch(delayedSample) && lookupVoiced_ && lookupConfidence_ >= kVoicingConfidence) {
            desiredMix = 1.0f;
        }

        const bool delayedTransient = delayedSample >= 0 &&
            transientRing_[static_cast<unsigned int>(delayedSample) & inputRingMask_] != 0U;
        const unsigned int outputIndex = static_cast<unsigned int>(absoluteSample) & outputRingMask_;
        const bool outputSlotCurrent = outputRingGeneration_[outputIndex] == resetGeneration_;
        const double accumulatedWeight = outputSlotCurrent ? outputWeightRing_[outputIndex] : 0.0;
        const float shiftedSample = accumulatedWeight > 1.0e-8
            ? static_cast<float>(outputSumRing_[outputIndex] / accumulatedWeight)
            : delayedInput;
        if (delayedTransient) {
            outputMix_ = 0.0f;
            monoSamples[frame] = delayedInput;
        } else {
            outputMix_ += (desiredMix - outputMix_) * mixSmoothing_;
            monoSamples[frame] = delayedInput + (shiftedSample - delayedInput) * outputMix_;
        }
        outputSumRing_[outputIndex] = 0.0;
        outputWeightRing_[outputIndex] = 0.0;
        outputRingGeneration_[outputIndex] = 0U;
        ++inputSampleCursor_;
    }
    return true;
}

bool NativePitchProcessor::processInterleaved(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (!prepared_ || (interleaved == nullptr && frames != 0U) || channels == 0U || channels > 2U) return false;
    if (frames == 0U) return true;
    if (channels == 1U) return processInPlace(interleaved, frames);

    unsigned int processed = 0U;
    while (processed < frames) {
        const unsigned int blockFrames = std::min(kMaximumScratchFrames, frames - processed);
        for (unsigned int frame = 0U; frame < blockFrames; ++frame) {
            const auto sampleOffset = static_cast<std::size_t>(processed + frame) * 2U;
            const float left = std::isfinite(interleaved[sampleOffset]) ? interleaved[sampleOffset] : 0.0f;
            const float right = std::isfinite(interleaved[sampleOffset + 1U]) ? interleaved[sampleOffset + 1U] : 0.0f;
            monoScratch_[frame] = (left + right) * 0.5f;
        }
        if (!processInPlace(monoScratch_.data(), blockFrames)) return false;
        for (unsigned int frame = 0U; frame < blockFrames; ++frame) {
            const auto sampleOffset = static_cast<std::size_t>(processed + frame) * 2U;
            const float mono = monoScratch_[frame];
            interleaved[sampleOffset] = mono;
            interleaved[sampleOffset + 1U] = mono;
        }
        processed += blockFrames;
    }
    return true;
}

NativePitchStatus NativePitchProcessor::status() const noexcept {
    return {
        sampleRate_,
        latencySamples_,
        targetSemitones_,
        detectorFrequencyHz_,
        detectorConfidence_,
        prepared_,
        detectorVoiced_,
    };
}

void NativePitchProcessor::storePitchEstimate(std::uint64_t estimateTimeSamples) noexcept {
    const unsigned int index = pitchHistoryWrite_;
    pitchTimes_[index] = estimateTimeSamples;
    pitchFrequencies_[index] = detector_.currentFrequencyHz;
    pitchConfidences_[index] = detector_.currentConfidence;
    pitchVoiced_[index] = detector_.currentVoiced ? 1U : 0U;
    latestPitchHistoryIndex_ = static_cast<int>(index);
    latestPitchTime_ = estimateTimeSamples;
    pitchHistoryWrite_ = (index + 1U) & pitchHistoryMask_;
    if (pitchHistoryCount_ < pitchTimes_.size()) ++pitchHistoryCount_;
}

bool NativePitchProcessor::lookupPitch(std::int64_t timeSamples) noexcept {
    if (timeSamples < 0 || pitchHistoryCount_ == 0U || latestPitchHistoryIndex_ < 0) {
        lookupFrequency_ = 0.0f;
        lookupConfidence_ = 0.0f;
        lookupVoiced_ = false;
        return false;
    }
    const auto unsignedTime = static_cast<std::uint64_t>(timeSamples);
    const std::int64_t delta = static_cast<std::int64_t>(latestPitchTime_) - static_cast<std::int64_t>(unsignedTime);
    const auto maximumAge = static_cast<std::uint64_t>(detectorHopRawSamples_) * (pitchHistoryCount_ - 1U);
    if (delta < -static_cast<std::int64_t>(detectorHopRawSamples_) ||
        (delta >= 0 && static_cast<std::uint64_t>(delta) > maximumAge)) {
        lookupFrequency_ = 0.0f;
        lookupConfidence_ = 0.0f;
        lookupVoiced_ = false;
        return false;
    }
    const auto boundedDelta = std::max<std::int64_t>(0, delta);
    const auto historyLag = static_cast<unsigned int>((boundedDelta + static_cast<std::int64_t>(detectorHopRawSamples_ / 2U)) /
        static_cast<std::int64_t>(detectorHopRawSamples_));
    if (historyLag >= pitchHistoryCount_) {
        lookupFrequency_ = 0.0f;
        lookupConfidence_ = 0.0f;
        lookupVoiced_ = false;
        return false;
    }
    const unsigned int index = (static_cast<unsigned int>(latestPitchHistoryIndex_) +
        static_cast<unsigned int>(pitchTimes_.size()) - historyLag) & pitchHistoryMask_;
    lookupFrequency_ = pitchFrequencies_[index];
    lookupConfidence_ = pitchConfidences_[index];
    lookupVoiced_ = pitchVoiced_[index] != 0U;
    return true;
}

void NativePitchProcessor::synthesizePitchGrain(double outputCenter) noexcept {
    const auto sourceTime = static_cast<std::int64_t>(std::llround(outputCenter - static_cast<double>(latencySamples_)));
    if (!lookupPitch(sourceTime) || !lookupVoiced_ || lookupConfidence_ < kVoicingConfidence || lookupFrequency_ <= 0.0f) {
        nextSynthesisCenter_ += static_cast<double>(detectorHopRawSamples_);
        return;
    }

    const double period = std::clamp(static_cast<double>(sampleRate_) / static_cast<double>(lookupFrequency_),
        1.0, static_cast<double>(maximumPeriodSamples_));
    const unsigned int radius = static_cast<unsigned int>(std::clamp(std::lround(period), 2L, static_cast<long>(maximumPeriodSamples_)));
    const unsigned int searchRadius = std::min(maximumSearchRadius_, std::max(1U, static_cast<unsigned int>(std::floor(period / 2.0))));
    const auto sourceCenter = static_cast<std::int64_t>(std::llround(static_cast<double>(sourceTime)));
    std::int64_t peakCenter = sourceCenter;
    float peakValue = -std::numeric_limits<float>::infinity();
    for (std::int64_t offset = -static_cast<std::int64_t>(searchRadius); offset <= static_cast<std::int64_t>(searchRadius); ++offset) {
        const std::int64_t candidate = sourceCenter + offset;
        const float value = readInput(candidate);
        // Lock to one polarity, avoiding alternate marks on symmetric waves.
        if (value > peakValue) {
            peakValue = value;
            peakCenter = candidate;
        }
    }

    const auto outputCenterInteger = static_cast<std::int64_t>(std::ceil(outputCenter));
    const double angle = 3.14159265358979323846 / static_cast<double>(radius + 1U);
    const double cosineStep = std::cos(angle);
    double cosineBeforePrevious = 1.0;
    double cosinePrevious = cosineStep;
    for (unsigned int offset = 0U; offset <= radius; ++offset) {
        double cosineValue = 1.0;
        if (offset == 1U) {
            cosineValue = cosinePrevious;
        } else if (offset > 1U) {
            const double nextCosine = (2.0 * cosineStep * cosinePrevious) - cosineBeforePrevious;
            cosineBeforePrevious = cosinePrevious;
            cosinePrevious = nextCosine;
            cosineValue = nextCosine;
        }
        const double weight = 0.5 + (0.5 * cosineValue);
        addGrainSample(outputCenterInteger + static_cast<std::int64_t>(offset), readInput(peakCenter + static_cast<std::int64_t>(offset)), weight);
        if (offset > 0U) {
            addGrainSample(outputCenterInteger - static_cast<std::int64_t>(offset), readInput(peakCenter - static_cast<std::int64_t>(offset)), weight);
        }
    }

    const double interval = std::max(1.0, period / static_cast<double>(currentRatio_));
    nextSynthesisCenter_ = outputCenter + interval;
}

void NativePitchProcessor::addGrainSample(std::int64_t absoluteOutputSample, float sample, double weight) noexcept {
    if (absoluteOutputSample < static_cast<std::int64_t>(inputSampleCursor_)) return;
    const unsigned int index = static_cast<unsigned int>(absoluteOutputSample) & outputRingMask_;
    if (outputRingGeneration_[index] != resetGeneration_) {
        outputSumRing_[index] = 0.0;
        outputWeightRing_[index] = 0.0;
        outputRingGeneration_[index] = resetGeneration_;
    }
    outputSumRing_[index] += static_cast<double>(sample) * weight;
    outputWeightRing_[index] += weight;
}

float NativePitchProcessor::readInput(std::int64_t absoluteSample) const noexcept {
    if (absoluteSample < 0 || static_cast<std::uint64_t>(absoluteSample) >= inputSampleCursor_) return 0.0f;
    return inputRing_[static_cast<unsigned int>(absoluteSample) & inputRingMask_];
}

} // namespace webrc::native
