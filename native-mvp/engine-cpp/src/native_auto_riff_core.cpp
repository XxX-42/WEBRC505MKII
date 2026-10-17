#include "native_auto_riff_core.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::native {

namespace {

constexpr double kYinThreshold = 0.16;
constexpr double kMinimumVoicedRms = 0.003;
constexpr std::array<unsigned int, 8U> kRiffDegrees{{0U, 1U, 2U, 4U, 5U, 4U, 2U, 1U}};

[[nodiscard]] bool isFiniteRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] int pitchClass(int midiNote) noexcept {
    const int remainder = midiNote % 12;
    return remainder < 0 ? remainder + 12 : remainder;
}

} // namespace

unsigned int NativeAutoRiffCore::nextPowerOfTwo(unsigned int value) noexcept {
    if (value <= 1U) return 1U;
    --value;
    value |= value >> 1U;
    value |= value >> 2U;
    value |= value >> 4U;
    value |= value >> 8U;
    value |= value >> 16U;
    return value == std::numeric_limits<unsigned int>::max() ? 0U : value + 1U;
}

bool NativeAutoRiffCore::validStepRate(float value) noexcept {
    for (const float supported : {0.25f, 0.5f, 1.0f, 2.0f, 4.0f}) {
        if (std::fabs(value - supported) < 1.0e-5f) return true;
    }
    return false;
}

int NativeAutoRiffCore::scaleDegreeSemitone(unsigned int scale, unsigned int degree) noexcept {
    constexpr std::array<int, 12U> kChromatic{{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}};
    constexpr std::array<int, 7U> kMajor{{0, 2, 4, 5, 7, 9, 11}};
    constexpr std::array<int, 7U> kNaturalMinor{{0, 2, 3, 5, 7, 8, 10}};
    constexpr std::array<int, 7U> kHarmonicMinor{{0, 2, 3, 5, 7, 8, 11}};
    constexpr std::array<int, 5U> kPentatonic{{0, 2, 4, 7, 9}};

    const int* notes = kChromatic.data();
    unsigned int count = static_cast<unsigned int>(kChromatic.size());
    switch (scale) {
    case 1U:
        notes = kMajor.data();
        count = static_cast<unsigned int>(kMajor.size());
        break;
    case 2U:
        notes = kNaturalMinor.data();
        count = static_cast<unsigned int>(kNaturalMinor.size());
        break;
    case 3U:
        notes = kHarmonicMinor.data();
        count = static_cast<unsigned int>(kHarmonicMinor.size());
        break;
    case 4U:
        notes = kPentatonic.data();
        count = static_cast<unsigned int>(kPentatonic.size());
        break;
    default:
        break;
    }
    if (count == 0U) return 0;
    const unsigned int octave = degree / count;
    const unsigned int noteIndex = degree % count;
    return static_cast<int>(octave * 12U) + notes[noteIndex];
}

int NativeAutoRiffCore::quantizeMidiToScale(float frequencyHz, unsigned int scale) noexcept {
    if (!std::isfinite(frequencyHz) || frequencyHz <= 0.0f || scale > 4U) return -1;
    const double exactMidi = 69.0 + 12.0 * std::log2(static_cast<double>(frequencyHz) / 440.0);
    if (!std::isfinite(exactMidi)) return -1;
    if (scale == 0U) return static_cast<int>(std::lround(exactMidi));

    const int nearestMidi = static_cast<int>(std::lround(exactMidi));
    int bestMidi = nearestMidi;
    double bestDistance = std::numeric_limits<double>::infinity();
    const unsigned int count = scale == 4U ? 5U : 7U;
    for (int candidate = nearestMidi - 12; candidate <= nearestMidi + 12; ++candidate) {
        const int pc = pitchClass(candidate);
        bool allowed = false;
        for (unsigned int degree = 0U; degree < count; ++degree) {
            if (scaleDegreeSemitone(scale, degree) == pc) {
                allowed = true;
                break;
            }
        }
        if (!allowed) continue;
        const double distance = std::fabs(static_cast<double>(candidate) - exactMidi);
        if (distance < bestDistance || (distance == bestDistance && candidate < bestMidi)) {
            bestDistance = distance;
            bestMidi = candidate;
        }
    }
    return std::isfinite(bestDistance) ? bestMidi : -1;
}

bool NativeAutoRiffCore::YinTracker::configure(unsigned int detectorRate) noexcept {
    if (detectorRate < 4000U || detectorRate > 12000U) return false;
    const unsigned int minLag = std::max(2U, static_cast<unsigned int>(std::floor(
        static_cast<double>(detectorRate) / 1000.0)));
    const unsigned int maxLag = static_cast<unsigned int>(std::ceil(
        static_cast<double>(detectorRate) / 65.0));
    if (maxLag < minLag || maxLag > kMaximumDetectorLag) return false;
    const unsigned int frame = std::max(64U, maxLag * 3U);
    const unsigned int capacity = NativeAutoRiffCore::nextPowerOfTwo(frame * 2U);
    if (capacity == 0U || capacity > kMaximumDetectorRing) return false;

    sampleRate = detectorRate;
    minimumLag = minLag;
    maximumLag = maxLag;
    frameSamples = frame;
    analysisWindowSamples = frame - maxLag;
    hopSamples = std::max(1U, static_cast<unsigned int>(std::lround(static_cast<double>(detectorRate) * 0.005)));
    if (hopSamples > frame) return false;
    ringCapacity = capacity;
    ringMask = capacity - 1U;
    reset();
    return true;
}

void NativeAutoRiffCore::YinTracker::reset() noexcept {
    writeIndex = 0U;
    sampleCount = 0U;
    nextAnalysisSample = frameSamples;
    analysisSerial = 0U;
    goodFrames = 0U;
    badFrames = 0U;
    frequencyHz = 0.0f;
    confidence = 0.0f;
    smoothedLogFrequency = 0.0f;
    voiced = false;
}

void NativeAutoRiffCore::YinTracker::pushSample(float sample) noexcept {
    ring[writeIndex] = std::isfinite(sample) ? sample : 0.0f;
    writeIndex = (writeIndex + 1U) & ringMask;
    ++sampleCount;
    if (sampleCount < nextAnalysisSample) return;
    analyzeFrame();
    nextAnalysisSample += hopSamples;
}

void NativeAutoRiffCore::YinTracker::analyzeFrame() noexcept {
    const unsigned int frameStart = (writeIndex + ringCapacity - frameSamples) & ringMask;
    double energy = 0.0;
    for (unsigned int i = 0U; i < frameSamples; ++i) {
        const double sample = ring[(frameStart + i) & ringMask];
        energy += sample * sample;
    }
    const double rms = std::sqrt(energy / static_cast<double>(frameSamples));

    differences[0] = 0.0;
    for (unsigned int lag = 1U; lag <= maximumLag; ++lag) {
        double sum = 0.0;
        for (unsigned int i = 0U; i < analysisWindowSamples; ++i) {
            const double delta = static_cast<double>(ring[(frameStart + i) & ringMask]) -
                static_cast<double>(ring[(frameStart + i + lag) & ringMask]);
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
    const double threshold = voiced ? 0.22 : kYinThreshold;
    for (unsigned int lag = minimumLag; lag <= maximumLag; ++lag) {
        const double value = normalizedDifferences[lag];
        if (value < bestValue) {
            bestValue = value;
            bestLag = lag;
        }
        if (value < threshold && (lag == maximumLag || value <= normalizedDifferences[lag + 1U])) {
            bestLag = lag;
            while (bestLag < maximumLag && normalizedDifferences[bestLag + 1U] < normalizedDifferences[bestLag]) {
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
        if (goodFrames == 1U || frequencyHz <= 0.0f) {
            smoothedLogFrequency = std::log(measuredHz);
        } else {
            smoothedLogFrequency += (std::log(measuredHz) - smoothedLogFrequency) * 0.35f;
        }
        frequencyHz = std::exp(smoothedLogFrequency);
        if (goodFrames >= 2U) voiced = true;
    } else {
        goodFrames = 0U;
        ++badFrames;
        if (badFrames >= 2U) voiced = false;
    }
    ++analysisSerial;
}

bool NativeAutoRiffCore::prepare(unsigned int sampleRate) noexcept {
    prepared_ = false;
    sampleRate_ = 0U;
    detectorLatencySamples_ = 0U;
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return false;

    const unsigned int decimation = std::max(1U, static_cast<unsigned int>(std::ceil(
        static_cast<double>(sampleRate) / 12000.0)));
    const unsigned int detectorRate = static_cast<unsigned int>(std::lround(
        static_cast<double>(sampleRate) / static_cast<double>(decimation)));
    if (!detector_.configure(detectorRate) || !shifter_.prepareForFx(sampleRate, 0.0f)) return false;

    sampleRate_ = sampleRate;
    detectorDecimation_ = decimation;
    const double analysisDelay = (static_cast<double>(detector_.frameSamples) +
        static_cast<double>(detector_.hopSamples)) * decimation;
    detectorLatencySamples_ = static_cast<unsigned int>(std::ceil(analysisDelay));
    onsetRefractorySamples_ = std::max<std::uint64_t>(1U, static_cast<std::uint64_t>(sampleRate) * 6U / 100U);
    scale_ = 0U;
    tempoBpm_ = 120.0f;
    stepRateBeats_ = 0.5f;
    sensitivity_ = 55.0f;
    mix_ = 0.65f;
    onsetFastCoefficient_ = static_cast<float>(1.0 - std::exp(-1.0 /
        (static_cast<double>(sampleRate_) * 0.008)));
    onsetSlowCoefficient_ = static_cast<float>(1.0 - std::exp(-1.0 /
        (static_cast<double>(sampleRate_) * 0.08)));
    stepPeriodSamples_ = calculateStepPeriod();
    prepared_ = true;
    reset();
    return true;
}

bool NativeAutoRiffCore::setParameter(std::string_view name, float value) noexcept {
    if (!prepared_ || !std::isfinite(value)) return false;
    if (name == "scale" || name == "auto-riff.scale") {
        if (value < 0.0f || value > 4.0f || std::floor(value) != value) return false;
        scale_ = static_cast<unsigned int>(value);
        if (voiced_ && detectedFrequencyHz_ > 0.0f) {
            const int remappedMidi = quantizeMidiToScale(detectedFrequencyHz_, scale_);
            if (remappedMidi >= 0) rootMidiNote_ = remappedMidi;
        }
        updateTargetSemitones();
        return true;
    }
    if (name == "rate" || name == "stepRate" || name == "step-rate" || name == "auto-riff.rate") {
        if (!validStepRate(value)) return false;
        stepRateBeats_ = value;
        stepPeriodSamples_ = calculateStepPeriod();
        if (sequenceRunning_) nextStepSample_ = sampleCursor_ + stepPeriodSamples_;
        return true;
    }
    if (name == "sensitivity" || name == "auto-riff.sensitivity") {
        if (value < 0.0f || value > 100.0f) return false;
        sensitivity_ = value;
        return true;
    }
    if (name == "mix" || name == "auto-riff.mix") {
        if (value < 0.0f || value > 100.0f) return false;
        mix_ = value / 100.0f;
        return true;
    }
    return false;
}

bool NativeAutoRiffCore::setTempoBpm(float bpm) noexcept {
    if (!prepared_ || !isFiniteRange(bpm, kMinimumTempoBpm, kMaximumTempoBpm)) return false;
    tempoBpm_ = bpm;
    stepPeriodSamples_ = calculateStepPeriod();
    if (sequenceRunning_) nextStepSample_ = sampleCursor_ + stepPeriodSamples_;
    return true;
}

unsigned int NativeAutoRiffCore::calculateStepPeriod() const noexcept {
    if (sampleRate_ == 0U || !isFiniteRange(tempoBpm_, kMinimumTempoBpm, kMaximumTempoBpm) ||
        !validStepRate(stepRateBeats_)) return 0U;
    const double period = static_cast<double>(sampleRate_) * 60.0 /
        static_cast<double>(tempoBpm_) * static_cast<double>(stepRateBeats_);
    if (!std::isfinite(period) || period < 1.0 || period > static_cast<double>(std::numeric_limits<unsigned int>::max())) {
        return 0U;
    }
    return static_cast<unsigned int>(std::lround(period));
}

void NativeAutoRiffCore::reset() noexcept {
    if (!prepared_) return;
    ++resetGeneration_;
    if (resetGeneration_ == 0U) {
        dryGeneration_.fill(0U);
        resetGeneration_ = 1U;
    }
    detector_.reset();
    sampleCursor_ = 0U;
    nextStepSample_ = 0U;
    channelCount_ = 0U;
    stepIndex_ = 0U;
    decimatorCount_ = 0U;
    decimatorSum_ = 0.0;
    fastEnvelope_ = 0.0f;
    slowEnvelope_ = 0.0f;
    detectedFrequencyHz_ = 0.0f;
    confidence_ = 0.0f;
    rootMidiNote_ = -1;
    voiced_ = false;
    sequenceRunning_ = false;
    lastOnsetSample_ = 0U;
    lastDetectorSerial_ = 0U;
    targetSemitones_ = 0.0f;
    appliedSemitones_ = 0.0f;
    stepPeriodSamples_ = calculateStepPeriod();
    (void)shifter_.setSemitones(0.0f);
    shifter_.reset();
}

void NativeAutoRiffCore::startSequence(std::uint64_t absoluteFrame) noexcept {
    sequenceRunning_ = true;
    stepIndex_ = 0U;
    nextStepSample_ = absoluteFrame + stepPeriodSamples_;
    updateTargetSemitones();
}

void NativeAutoRiffCore::advanceSequenceAt(std::uint64_t absoluteFrame) noexcept {
    if (!sequenceRunning_ || stepPeriodSamples_ == 0U) return;
    while (absoluteFrame >= nextStepSample_) {
        stepIndex_ = (stepIndex_ + 1U) % kRiffLength;
        nextStepSample_ += stepPeriodSamples_;
        updateTargetSemitones();
    }
}

float NativeAutoRiffCore::calculateStepSemitones() const noexcept {
    if (rootMidiNote_ < 0 || scale_ > 4U) return 0.0f;
    const int rootPc = pitchClass(rootMidiNote_);
    const unsigned int degreeCount = scale_ == 0U ? 12U : (scale_ == 4U ? 5U : 7U);
    unsigned int rootDegree = 0U;
    for (; rootDegree < degreeCount; ++rootDegree) {
        if (scaleDegreeSemitone(scale_, rootDegree) == rootPc) break;
    }
    if (rootDegree >= degreeCount) return 0.0f;
    const int rootC = rootMidiNote_ - rootPc;
    const unsigned int riffDegree = kRiffDegrees[stepIndex_ % kRiffLength];
    const int targetMidi = rootC + scaleDegreeSemitone(scale_, rootDegree + riffDegree);
    return static_cast<float>(std::clamp(targetMidi - rootMidiNote_, -24, 24));
}

void NativeAutoRiffCore::updateTargetSemitones() noexcept {
    targetSemitones_ = sequenceRunning_ && voiced_ ? calculateStepSemitones() : 0.0f;
}

void NativeAutoRiffCore::handleOnset(std::uint64_t absoluteFrame) noexcept {
    if (!voiced_) return;
    startSequence(absoluteFrame);
}

void NativeAutoRiffCore::updateVoicing(std::uint64_t absoluteFrame) noexcept {
    voiced_ = detector_.voiced;
    confidence_ = detector_.confidence;
    detectedFrequencyHz_ = voiced_ ? detector_.frequencyHz : 0.0f;
    if (!voiced_) {
        rootMidiNote_ = -1;
        sequenceRunning_ = false;
        stepIndex_ = 0U;
        nextStepSample_ = 0U;
        targetSemitones_ = 0.0f;
        return;
    }

    const int detectedMidi = quantizeMidiToScale(detector_.frequencyHz, scale_);
    if (detectedMidi < 0) return;
    const bool rootChanged = detectedMidi != rootMidiNote_;
    rootMidiNote_ = detectedMidi;
    if (!sequenceRunning_) {
        startSequence(absoluteFrame);
    } else if (rootChanged) {
        updateTargetSemitones();
    }
}

void NativeAutoRiffCore::processDetectorSample(float mono, std::uint64_t absoluteFrame) noexcept {
    const float absolute = std::fabs(std::isfinite(mono) ? mono : 0.0f);
    fastEnvelope_ += (absolute - fastEnvelope_) * onsetFastCoefficient_;
    slowEnvelope_ += (absolute - slowEnvelope_) * onsetSlowCoefficient_;

    decimatorSum_ += static_cast<double>(mono);
    ++decimatorCount_;
    if (decimatorCount_ >= detectorDecimation_) {
        detector_.pushSample(static_cast<float>(decimatorSum_ / static_cast<double>(detectorDecimation_)));
        decimatorCount_ = 0U;
        decimatorSum_ = 0.0;
        if (detector_.analysisSerial != lastDetectorSerial_) {
            lastDetectorSerial_ = detector_.analysisSerial;
            updateVoicing(absoluteFrame);
        }
    }

    const float sensitivityAmount = sensitivity_ / 100.0f;
    const float ratioThreshold = 2.3f - sensitivityAmount * 1.15f;
    const float amplitudeThreshold = 0.002f + (1.0f - sensitivityAmount) * 0.015f;
    const bool hasOnset = fastEnvelope_ > 0.004f &&
        fastEnvelope_ > slowEnvelope_ * ratioThreshold + amplitudeThreshold;
    if (hasOnset && absoluteFrame - lastOnsetSample_ >= onsetRefractorySamples_) {
        lastOnsetSample_ = absoluteFrame;
        handleOnset(absoluteFrame);
    }
}

bool NativeAutoRiffCore::processInterleaved(float* interleaved, unsigned int frames,
                                           unsigned int channels) noexcept {
    if (!prepared_ || (frames > 0U && interleaved == nullptr) || channels == 0U || channels > kMaximumChannels) {
        return false;
    }
    if (frames == 0U) return true;
    if (channelCount_ == 0U) channelCount_ = channels;
    if (channelCount_ != channels) return false;

    unsigned int processedFrames = 0U;
    while (processedFrames < frames) {
        unsigned int segmentFrames = std::min(kMaximumControlQuantumFrames, frames - processedFrames);
        const std::uint64_t segmentStart = sampleCursor_;
        float* segment = interleaved + static_cast<std::size_t>(processedFrames) * channels;
        struct ControlChange final {
            unsigned int offset = 0U;
            float semitones = 0.0f;
        };
        std::array<ControlChange, 64U> changes{};
        unsigned int changeCount = 0U;
        const auto recordChange = [&changes, &changeCount](unsigned int offset, float semitones) noexcept {
            if (changeCount > 0U && changes[changeCount - 1U].offset == offset) {
                changes[changeCount - 1U].semitones = semitones;
            } else if (changeCount < static_cast<unsigned int>(changes.size())) {
                changes[changeCount++] = {offset, semitones};
            }
        };
        if (std::fabs(targetSemitones_ - appliedSemitones_) > 1.0e-6f) {
            recordChange(0U, targetSemitones_);
        }
        for (unsigned int frame = 0U; frame < segmentFrames; ++frame) {
            const std::uint64_t absoluteFrame = segmentStart + frame;
            const float priorTargetSemitones = targetSemitones_;
            advanceSequenceAt(absoluteFrame);
            const std::size_t offset = static_cast<std::size_t>(frame) * channels;
            const float left = std::isfinite(segment[offset]) ? segment[offset] : 0.0f;
            const float right = channels > 1U
                ? (std::isfinite(segment[offset + 1U]) ? segment[offset + 1U] : 0.0f)
                : left;
            segment[offset] = left;
            if (channels > 1U) segment[offset + 1U] = right;
            const unsigned int drySlot = static_cast<unsigned int>(absoluteFrame) & kDryRingMask;
            dryRing_[static_cast<std::size_t>(drySlot) * kMaximumChannels] = left;
            dryRing_[static_cast<std::size_t>(drySlot) * kMaximumChannels + 1U] = right;
            dryGeneration_[drySlot] = resetGeneration_;
            const float mono = channels > 1U ? 0.5f * (left + right) : left;
            processDetectorSample(mono, absoluteFrame);
            if (std::fabs(targetSemitones_ - priorTargetSemitones) > 1.0e-6f) {
                recordChange(frame, targetSemitones_);
            }
        }

        sampleCursor_ += segmentFrames;
        unsigned int nextFrame = 0U;
        for (unsigned int changeIndex = 0U; changeIndex < changeCount; ++changeIndex) {
            const auto& change = changes[changeIndex];
            if (change.offset > nextFrame) {
                const auto rangeOffset = static_cast<std::size_t>(nextFrame) * channels;
                if (!shifter_.processInterleaved(segment + rangeOffset, change.offset - nextFrame, channels)) {
                    return false;
                }
            }
            if (std::fabs(change.semitones - appliedSemitones_) > 1.0e-6f) {
                if (!shifter_.setSemitones(change.semitones)) return false;
                appliedSemitones_ = change.semitones;
            }
            nextFrame = change.offset;
        }
        if (nextFrame < segmentFrames) {
            const auto rangeOffset = static_cast<std::size_t>(nextFrame) * channels;
            if (!shifter_.processInterleaved(segment + rangeOffset, segmentFrames - nextFrame, channels)) {
                return false;
            }
        }

        for (unsigned int frame = 0U; frame < segmentFrames; ++frame) {
            const std::uint64_t absoluteFrame = segmentStart + frame;
            const bool hasDryHistory = absoluteFrame >= latencySamples();
            const std::uint64_t dryFrame = hasDryHistory ? absoluteFrame - latencySamples() : 0U;
            const unsigned int drySlot = static_cast<unsigned int>(dryFrame) & kDryRingMask;
            const bool dryIsCurrent = hasDryHistory && dryGeneration_[drySlot] == resetGeneration_;
            const std::size_t offset = static_cast<std::size_t>(frame) * channels;
            for (unsigned int channel = 0U; channel < channels; ++channel) {
                const std::size_t ringOffset = static_cast<std::size_t>(drySlot) * kMaximumChannels + channel;
                const float dry = dryIsCurrent && std::isfinite(dryRing_[ringOffset])
                    ? dryRing_[ringOffset] : 0.0f;
                const float wet = std::isfinite(segment[offset + channel]) ? segment[offset + channel] : 0.0f;
                const float output = wet * mix_ + dry * (1.0f - mix_);
                segment[offset + channel] = std::isfinite(output)
                    ? std::clamp(output, -4.0f, 4.0f) : 0.0f;
            }
        }
        processedFrames += segmentFrames;
    }
    return true;
}

} // namespace webrc::native
