#include "webrc/dsp/pitch.hpp"

#include "webrc/dsp/fft.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::dsp {

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;

std::uint32_t nextPowerOfTwo(std::uint32_t value) noexcept {
    if (value <= 1) return 1;
    --value;
    value |= value >> 1U;
    value |= value >> 2U;
    value |= value >> 4U;
    value |= value >> 8U;
    value |= value >> 16U;
    return value + 1U;
}

float wrapPhase(float radians) noexcept {
    if (!std::isfinite(radians)) return 0.0f;
    return static_cast<float>(std::remainder(static_cast<double>(radians), kTwoPi));
}

float phaseInterpolate(float first, float second, float fraction) noexcept {
    return wrapPhase(first + fraction * wrapPhase(second - first));
}

} // namespace

std::size_t YinPitchDetector::requiredPrepareBytes(
    const ProcessSpec& spec, std::uint32_t frameFrames,
    float minimumFrequencyHz, float maximumFrequencyHz) noexcept {
    if (!validProcessSpec(spec) || frameFrames < 64 || frameFrames > 8192 ||
        !std::isfinite(minimumFrequencyHz) || !std::isfinite(maximumFrequencyHz) ||
        minimumFrequencyHz <= 0.0f || maximumFrequencyHz <= minimumFrequencyHz ||
        maximumFrequencyHz >= 0.5f * spec.sampleRate) {
        return 0;
    }

    const double minimumLagValue = std::floor(static_cast<double>(spec.sampleRate) /
                                               static_cast<double>(maximumFrequencyHz));
    const double maximumLagValue = std::ceil(static_cast<double>(spec.sampleRate) /
                                              static_cast<double>(minimumFrequencyHz));
    if (!std::isfinite(minimumLagValue) || !std::isfinite(maximumLagValue) ||
        minimumLagValue < 2.0 || maximumLagValue >= static_cast<double>(frameFrames - 2U) ||
        maximumLagValue <= minimumLagValue) {
        return 0;
    }
    const auto maximumLag = static_cast<std::uint32_t>(maximumLagValue);
    const std::size_t fftFrames = nextPowerOfTwo(2U * frameFrames);
    const std::size_t bytes = fftFrames * sizeof(std::complex<float>) +
        (static_cast<std::size_t>(frameFrames) + 1U + maximumLag + 2U) * sizeof(double) +
        64U * 1024U;
    return bytes;
}

bool YinPitchDetector::prepare(const ProcessSpec& spec, std::uint32_t frameFrames,
                               float minimumFrequencyHz, float maximumFrequencyHz,
                               float threshold) {
    if (!std::isfinite(threshold) || threshold <= 0.0f || threshold >= 1.0f ||
        requiredPrepareBytes(spec, frameFrames, minimumFrequencyHz, maximumFrequencyHz) == 0) {
        return false;
    }

    const double minimumLagValue = std::floor(static_cast<double>(spec.sampleRate) /
                                               static_cast<double>(maximumFrequencyHz));
    const double maximumLagValue = std::ceil(static_cast<double>(spec.sampleRate) /
                                              static_cast<double>(minimumFrequencyHz));
    const auto minimumLag = static_cast<std::uint32_t>(minimumLagValue);
    const auto maximumLag = static_cast<std::uint32_t>(maximumLagValue);
    const auto fftFrames = nextPowerOfTwo(2U * frameFrames);

    std::vector<std::complex<float>> spectrum;
    std::vector<double> prefixEnergy;
    std::vector<double> cmnd;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        spectrum.resize(fftFrames);
        prefixEnergy.resize(static_cast<std::size_t>(frameFrames) + 1U);
        cmnd.resize(static_cast<std::size_t>(maximumLag) + 2U);
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif

    spectrum_.swap(spectrum);
    prefixEnergy_.swap(prefixEnergy);
    cmnd_.swap(cmnd);
    spec_ = spec;
    frameFrames_ = frameFrames;
    fftFrames_ = fftFrames;
    minimumLag_ = minimumLag;
    maximumLag_ = maximumLag;
    minimumPeriodSamples_ = static_cast<double>(spec.sampleRate) / maximumFrequencyHz;
    maximumPeriodSamples_ = static_cast<double>(spec.sampleRate) / minimumFrequencyHz;
    threshold_ = threshold;
    reset();
    return true;
}

void YinPitchDetector::reset() noexcept {
    std::fill(spectrum_.begin(), spectrum_.end(), std::complex<float>{});
    std::fill(prefixEnergy_.begin(), prefixEnergy_.end(), 0.0);
    std::fill(cmnd_.begin(), cmnd_.end(), 0.0);
}

bool YinPitchDetector::analyze(const float* mono, std::uint32_t frames,
                               PitchEstimate& estimate) noexcept {
    estimate = {};
    if (mono == nullptr || frameFrames_ == 0 || frames != frameFrames_ ||
        fftFrames_ == 0 || spectrum_.size() != fftFrames_) {
        return false;
    }

    double mean = 0.0;
    for (std::uint32_t i = 0; i < frameFrames_; ++i) mean += sanitize(mono[i]);
    mean /= frameFrames_;

    double sumSquares = 0.0;
    prefixEnergy_[0] = 0.0;
    for (std::uint32_t i = 0; i < frameFrames_; ++i) {
        const double sample = static_cast<double>(sanitize(mono[i])) - mean;
        sumSquares += sample * sample;
        prefixEnergy_[i + 1] = sumSquares;
        spectrum_[i] = {static_cast<float>(sample), 0.0f};
    }
    for (std::uint32_t i = frameFrames_; i < fftFrames_; ++i) spectrum_[i] = {};

    estimate.rms = static_cast<float>(std::sqrt(sumSquares / frameFrames_));
    if (!std::isfinite(estimate.rms) || estimate.rms < silenceRms_) return true;

    if (!fft::transform(spectrum_.data(), fftFrames_, fft::Direction::Forward)) return false;
    for (std::uint32_t i = 0; i < fftFrames_; ++i) {
        const double real = spectrum_[i].real();
        const double imag = spectrum_[i].imag();
        spectrum_[i] = {static_cast<float>(real * real + imag * imag), 0.0f};
    }
    if (!fft::transform(spectrum_.data(), fftFrames_, fft::Direction::Inverse)) return false;

    double cumulativeDifference = 0.0;
    double bestValue = std::numeric_limits<double>::infinity();
    std::uint32_t bestLag = minimumLag_;
    const std::uint32_t searchMinimumLag = minimumLag_ > 2U ? minimumLag_ - 2U : 2U;
    for (std::uint32_t lag = 1; lag <= maximumLag_; ++lag) {
        const double energyA = prefixEnergy_[frameFrames_ - lag];
        const double energyB = prefixEnergy_[frameFrames_] - prefixEnergy_[lag];
        const double correlation = spectrum_[lag].real();
        const double difference = std::max(0.0, energyA + energyB - 2.0 * correlation);
        cumulativeDifference += difference;
        if (lag < cmnd_.size()) {
            cmnd_[lag] = cumulativeDifference > 1.0e-20
                ? difference * static_cast<double>(lag) / cumulativeDifference
                : 1.0;
        }
        if (lag >= minimumLag_ && lag <= maximumLag_ && cmnd_[lag] < bestValue) {
            bestValue = cmnd_[lag];
            bestLag = lag;
        }
    }

    std::uint32_t selectedLag = 0;
    for (std::uint32_t lag = searchMinimumLag; lag < maximumLag_; ++lag) {
        if (cmnd_[lag] < threshold_ && cmnd_[lag] <= cmnd_[lag + 1]) {
            selectedLag = lag;
            while (selectedLag < maximumLag_ &&
                   cmnd_[selectedLag + 1] < cmnd_[selectedLag]) {
                ++selectedLag;
            }
            break;
        }
    }
    if (selectedLag == 0) selectedLag = bestLag;
    const double left = selectedLag > searchMinimumLag
        ? cmnd_[selectedLag - 1] : cmnd_[selectedLag];
    const double center = cmnd_[selectedLag];
    const double right = selectedLag < maximumLag_ ? cmnd_[selectedLag + 1] : center;
    const double denominator = left - 2.0 * center + right;
    double offset = std::abs(denominator) > 1.0e-15
        ? 0.5 * (left - right) / denominator
        : 0.0;
    offset = std::clamp(offset, -0.5, 0.5);
    const double period = std::clamp(static_cast<double>(selectedLag) + offset,
        minimumPeriodSamples_, maximumPeriodSamples_);
    const double selectedConfidence = std::clamp(1.0 - center, 0.0, 1.0);
    estimate.periodSamples = static_cast<float>(period);
    estimate.confidence = static_cast<float>(selectedConfidence);
    estimate.frequencyHz = static_cast<float>(spec_.sampleRate / period);
    estimate.voiced = std::isfinite(estimate.frequencyHz) && center <= threshold_;
    if (!estimate.voiced) {
        estimate.frequencyHz = 0.0f;
        estimate.periodSamples = 0.0f;
    }
    return true;
}

std::size_t TdPsolaPitchShifter::requiredPrepareBytes(
    std::uint32_t maxBufferFrames) noexcept {
    if (maxBufferFrames == 0 || maxBufferFrames > 131072) return 0;
    return static_cast<std::size_t>(maxBufferFrames) *
        (sizeof(float) + 2U * sizeof(double)) + 64U * 1024U;
}

bool TdPsolaPitchShifter::prepare(const ProcessSpec& spec,
                                 std::uint32_t maxBufferFrames,
                                 std::uint32_t maxPitchPeriodSamples) {
    if (!validProcessSpec(spec) || requiredPrepareBytes(maxBufferFrames) == 0 ||
        maxPitchPeriodSamples < 4 || maxPitchPeriodSamples > 8192) {
        return false;
    }

    std::vector<float> source;
    std::vector<double> accumulation;
    std::vector<double> normalization;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        source.resize(maxBufferFrames);
        accumulation.resize(maxBufferFrames);
        normalization.resize(maxBufferFrames);
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif

    source_.swap(source);
    accumulation_.swap(accumulation);
    normalization_.swap(normalization);
    spec_ = spec;
    maxBufferFrames_ = maxBufferFrames;
    maxPitchPeriodSamples_ = maxPitchPeriodSamples;
    reset();
    return true;
}

void TdPsolaPitchShifter::reset() noexcept {
    std::fill(source_.begin(), source_.end(), 0.0f);
    std::fill(accumulation_.begin(), accumulation_.end(), 0.0);
    std::fill(normalization_.begin(), normalization_.end(), 0.0);
}

bool TdPsolaPitchShifter::processBuffer(const float* input, float* output,
                                       std::uint32_t frames,
                                       float sourcePeriodSamples,
                                       float pitchRatio) noexcept {
    if (input == nullptr || output == nullptr || frames == 0 || frames > maxBufferFrames_ ||
        maxBufferFrames_ == 0 || source_.size() < frames || accumulation_.size() < frames ||
        normalization_.size() < frames || !std::isfinite(sourcePeriodSamples) ||
        !std::isfinite(pitchRatio) || sourcePeriodSamples < 4.0f ||
        sourcePeriodSamples > static_cast<float>(maxPitchPeriodSamples_) ||
        pitchRatio < 0.5f || pitchRatio > 2.0f) {
        return false;
    }
    std::copy_n(input, frames, source_.begin());
    if (std::abs(pitchRatio - 1.0f) < 1.0e-6f) {
        std::copy_n(source_.data(), frames, output);
        return true;
    }

    std::fill_n(accumulation_.begin(), frames, 0.0);
    std::fill_n(normalization_.begin(), frames, 0.0);
    const auto radius = std::max<std::int32_t>(2,
        static_cast<std::int32_t>(std::llround(sourcePeriodSamples)));
    const double targetPeriod = static_cast<double>(sourcePeriodSamples) / pitchRatio;
    const auto searchRadius = std::max<std::int32_t>(1, radius / 2);
    const double finalCenter = static_cast<double>(frames - 1) + radius;

    for (double outputCenter = 0.0; outputCenter <= finalCenter; outputCenter += targetPeriod) {
        const double expectedSourceCenter = std::clamp(outputCenter, 0.0,
                                                        static_cast<double>(frames - 1));
        const auto expectedInteger = static_cast<std::int32_t>(std::llround(expectedSourceCenter));
        const auto firstSearch = std::max<std::int32_t>(0, expectedInteger - searchRadius);
        const auto lastSearch = std::min<std::int32_t>(static_cast<std::int32_t>(frames) - 1,
                                                       expectedInteger + searchRadius);
        std::int32_t sourceCenter = expectedInteger;
        float peak = source_[static_cast<std::size_t>(sourceCenter)];
        for (std::int32_t index = firstSearch; index <= lastSearch; ++index) {
            const float candidate = source_[static_cast<std::size_t>(index)];
            if (candidate > peak) {
                peak = candidate;
                sourceCenter = index;
            }
        }

        const auto outputCenterInteger = static_cast<std::int32_t>(std::llround(outputCenter));
        for (std::int32_t offset = -radius; offset <= radius; ++offset) {
            const std::int32_t outIndex = outputCenterInteger + offset;
            const std::int32_t sourceIndex = sourceCenter + offset;
            if (outIndex < 0 || outIndex >= static_cast<std::int32_t>(frames) ||
                sourceIndex < 0 || sourceIndex >= static_cast<std::int32_t>(frames)) {
                continue;
            }
            const double phase = static_cast<double>(offset) / radius;
            const double window = 0.5 + 0.5 * std::cos(kPi * phase);
            accumulation_[static_cast<std::size_t>(outIndex)] +=
                static_cast<double>(source_[static_cast<std::size_t>(sourceIndex)]) * window;
            normalization_[static_cast<std::size_t>(outIndex)] += window;
        }
    }

    for (std::uint32_t i = 0; i < frames; ++i) {
        const double norm = normalization_[i];
        output[i] = norm > 1.0e-9
            ? sanitize(static_cast<float>(accumulation_[i] / norm))
            : source_[i];
    }
    return true;
}

std::size_t StreamingTdPsolaPitchShifter::requiredPrepareBytes(
    const ProcessSpec& spec, std::uint32_t maximumPitchPeriodSamples) noexcept {
    if (!validProcessSpec(spec) || spec.maxBlockFrames > 8192 ||
        maximumPitchPeriodSamples < 4 || maximumPitchPeriodSamples > 8192) {
        return 0;
    }
    const std::uint64_t latency = 3ULL * maximumPitchPeriodSamples;
    const std::uint64_t ringFrames = latency + 4ULL * maximumPitchPeriodSamples +
                                     spec.maxBlockFrames + 32ULL;
    if (ringFrames > 100000) return 0;
    return static_cast<std::size_t>(ringFrames) *
        (sizeof(float) + 2U * sizeof(double) + sizeof(std::int64_t) +
         sizeof(std::uint32_t)) + 64U * 1024U;
}

bool StreamingTdPsolaPitchShifter::prepare(const ProcessSpec& spec,
                                          std::uint32_t maximumPitchPeriodSamples) {
    const std::size_t requiredBytes = requiredPrepareBytes(spec, maximumPitchPeriodSamples);
    if (requiredBytes == 0) return false;

    const auto latency = 3U * maximumPitchPeriodSamples;
    const auto ringFrames = static_cast<std::size_t>(latency) +
        4U * static_cast<std::size_t>(maximumPitchPeriodSamples) + spec.maxBlockFrames + 32U;
    std::vector<float> inputRing;
    std::vector<double> outputAccumulation;
    std::vector<double> outputNormalization;
    std::vector<std::int64_t> outputFrameTags;
    std::vector<std::uint32_t> outputEpochTags;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        inputRing.resize(ringFrames);
        outputAccumulation.resize(ringFrames);
        outputNormalization.resize(ringFrames);
        outputFrameTags.resize(ringFrames, std::numeric_limits<std::int64_t>::min());
        outputEpochTags.resize(ringFrames);
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif

    inputRing_.swap(inputRing);
    outputAccumulation_.swap(outputAccumulation);
    outputNormalization_.swap(outputNormalization);
    outputFrameTags_.swap(outputFrameTags);
    outputEpochTags_.swap(outputEpochTags);
    spec_ = spec;
    maximumPitchPeriodSamples_ = maximumPitchPeriodSamples;
    latencySamples_ = latency;
    ringFrames_ = ringFrames;
    pitchSmoothingCoefficient_ = static_cast<float>(1.0 - std::exp(-1.0 /
        (0.02 * static_cast<double>(spec.sampleRate))));
    reset();
    return true;
}

void StreamingTdPsolaPitchShifter::reset() noexcept {
    std::fill(inputRing_.begin(), inputRing_.end(), 0.0f);
    std::fill(outputAccumulation_.begin(), outputAccumulation_.end(), 0.0);
    std::fill(outputNormalization_.begin(), outputNormalization_.end(), 0.0);
    std::fill(outputFrameTags_.begin(), outputFrameTags_.end(),
              std::numeric_limits<std::int64_t>::min());
    std::fill(outputEpochTags_.begin(), outputEpochTags_.end(), 0);
    inputFrameIndex_ = -1;
    epoch_ = 1;
    nextSynthesisCenter_ = 0.0;
    targetSourcePeriod_ = 0.0f;
    currentSourcePeriod_ = 0.0f;
    targetPitchRatio_ = 1.0f;
    currentPitchRatio_ = 1.0f;
    targetVoicingMix_ = 0.0f;
    currentVoicingMix_ = 0.0f;
    voicingRampRemaining_ = 0;
    pitchAvailable_ = false;
}

bool StreamingTdPsolaPitchShifter::setPitch(float sourcePeriodSamples,
                                            float pitchRatio,
                                            bool voiced) noexcept {
    if (ringFrames_ == 0 || !std::isfinite(pitchRatio) ||
        pitchRatio < 0.5f || pitchRatio > 2.0f) {
        return false;
    }
    if (voiced && (!std::isfinite(sourcePeriodSamples) || sourcePeriodSamples < 4.0f ||
                   sourcePeriodSamples > static_cast<float>(maximumPitchPeriodSamples_))) {
        return false;
    }

    const bool wasAvailable = pitchAvailable_;
    if (voiced) {
        targetSourcePeriod_ = sourcePeriodSamples;
        targetPitchRatio_ = pitchRatio;
        pitchAvailable_ = true;
        if (!wasAvailable) {
            currentSourcePeriod_ = sourcePeriodSamples;
            currentPitchRatio_ = pitchRatio;
            const double nextOutputFrame = std::max(0.0,
                static_cast<double>(inputFrameIndex_ + 1) - latencySamples_);
            const double targetPeriod = sourcePeriodSamples / pitchRatio;
            const double earliestCenter = std::max(0.0,
                nextOutputFrame - std::ceil(sourcePeriodSamples));
            nextSynthesisCenter_ = std::ceil(earliestCenter / targetPeriod) * targetPeriod;
            ++epoch_;
            if (epoch_ == 0) ++epoch_;
        }
    }
    targetVoicingMix_ = voiced ? 1.0f : 0.0f;
    const double fadeSeconds = voiced ? 0.010 : 0.020;
    voicingRampRemaining_ = std::max<std::uint32_t>(1,
        static_cast<std::uint32_t>(std::llround(spec_.sampleRate * fadeSeconds)));
    return true;
}

bool StreamingTdPsolaPitchShifter::setPitchEstimate(const PitchEstimate& estimate,
                                                    float pitchRatio) noexcept {
    if (!std::isfinite(estimate.confidence) || !std::isfinite(estimate.frequencyHz) ||
        !std::isfinite(estimate.periodSamples) || !std::isfinite(pitchRatio) ||
        pitchRatio < 0.5f || pitchRatio > 2.0f) {
        return false;
    }
    const float onsetThreshold = targetVoicingMix_ > 0.5f ? 0.45f : 0.65f;
    const bool voiced = estimate.voiced && estimate.confidence >= onsetThreshold &&
        estimate.periodSamples >= 4.0f &&
        estimate.periodSamples <= static_cast<float>(maximumPitchPeriodSamples_);
    return setPitch(voiced ? estimate.periodSamples : 0.0f, pitchRatio, voiced);
}

std::size_t StreamingTdPsolaPitchShifter::ringIndex(std::int64_t frame) const noexcept {
    if (ringFrames_ == 0 || frame < 0) return 0;
    return static_cast<std::size_t>(static_cast<std::uint64_t>(frame) % ringFrames_);
}

float StreamingTdPsolaPitchShifter::readInput(std::int64_t frame,
                                             std::int64_t newestFrame) const noexcept {
    if (frame < 0 || frame > newestFrame || ringFrames_ == 0 ||
        newestFrame - frame >= static_cast<std::int64_t>(ringFrames_)) {
        return 0.0f;
    }
    return inputRing_[ringIndex(frame)];
}

void StreamingTdPsolaPitchShifter::scheduleGrain(double outputCenter,
                                                 std::int64_t newestFrame) noexcept {
    if (ringFrames_ == 0 || currentSourcePeriod_ < 4.0f || currentPitchRatio_ <= 0.0f) return;
    const auto radius = std::max<std::int32_t>(2,
        static_cast<std::int32_t>(std::ceil(currentSourcePeriod_)));
    const auto searchRadius = std::max<std::int32_t>(1,
        static_cast<std::int32_t>(std::ceil(currentSourcePeriod_ * 0.5f)));
    const auto expected = static_cast<std::int64_t>(std::llround(outputCenter));
    const auto firstSearch = std::max<std::int64_t>(0, expected - searchRadius);
    const auto lastSearch = std::min<std::int64_t>(newestFrame, expected + searchRadius);
    std::int64_t sourceCenter = std::clamp(expected, firstSearch, lastSearch);
    float peak = readInput(sourceCenter, newestFrame);
    for (std::int64_t frame = firstSearch; frame <= lastSearch; ++frame) {
        const float candidate = readInput(frame, newestFrame);
        if (candidate > peak) {
            peak = candidate;
            sourceCenter = frame;
        }
    }

    const auto outputCenterInteger = static_cast<std::int64_t>(std::llround(outputCenter));
    for (std::int32_t offset = -radius; offset <= radius; ++offset) {
        const std::int64_t destinationFrame = outputCenterInteger + offset;
        if (destinationFrame < 0) continue;
        const std::int64_t sourceFrame = sourceCenter + offset;
        const double phase = static_cast<double>(offset) / radius;
        const double window = 0.5 + 0.5 * std::cos(kPi * phase);
        const std::size_t slot = ringIndex(destinationFrame);
        if (outputFrameTags_[slot] != destinationFrame || outputEpochTags_[slot] != epoch_) {
            outputFrameTags_[slot] = destinationFrame;
            outputEpochTags_[slot] = epoch_;
            outputAccumulation_[slot] = 0.0;
            outputNormalization_[slot] = 0.0;
        }
        outputAccumulation_[slot] +=
            static_cast<double>(readInput(sourceFrame, newestFrame)) * window;
        outputNormalization_[slot] += window;
    }
}

void StreamingTdPsolaPitchShifter::advanceSynthesisCenter() noexcept {
    const double period = currentSourcePeriod_ / std::max(0.5f, currentPitchRatio_);
    if (std::isfinite(period) && period >= 2.0) nextSynthesisCenter_ += period;
}

void StreamingTdPsolaPitchShifter::advanceMix() noexcept {
    if (voicingRampRemaining_ > 0) {
        currentVoicingMix_ += (targetVoicingMix_ - currentVoicingMix_) /
            static_cast<float>(voicingRampRemaining_);
        --voicingRampRemaining_;
        if (voicingRampRemaining_ == 0) currentVoicingMix_ = targetVoicingMix_;
    }
    if (currentVoicingMix_ <= 0.0f && targetVoicingMix_ <= 0.0f) {
        currentVoicingMix_ = 0.0f;
        pitchAvailable_ = false;
    }
}

bool StreamingTdPsolaPitchShifter::processBlock(const float* input, float* output,
                                                std::uint32_t frames) noexcept {
    if (ringFrames_ == 0 || input == nullptr || output == nullptr || frames == 0 ||
        frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const std::int64_t newestFrame = ++inputFrameIndex_;
        inputRing_[ringIndex(newestFrame)] = sanitize(input[i]);
        const std::int64_t outputFrame = newestFrame - static_cast<std::int64_t>(latencySamples_);
        if (outputFrame < 0) {
            output[i] = 0.0f;
            continue;
        }

        advanceMix();
        const float smoothing = pitchSmoothingCoefficient_;
        currentSourcePeriod_ += smoothing * (targetSourcePeriod_ - currentSourcePeriod_);
        currentPitchRatio_ += smoothing * (targetPitchRatio_ - currentPitchRatio_);
        const float dry = readInput(outputFrame, newestFrame);
        float wet = dry;

        if (pitchAvailable_ && currentSourcePeriod_ >= 4.0f) {
            if (std::abs(currentPitchRatio_ - 1.0f) < 1.0e-5f) {
                const double radius = std::ceil(currentSourcePeriod_);
                const double targetPeriod = currentSourcePeriod_ /
                    std::max(0.5f, currentPitchRatio_);
                while (nextSynthesisCenter_ <= outputFrame + radius) {
                    advanceSynthesisCenter();
                    if (targetPeriod < 2.0 || !std::isfinite(targetPeriod)) break;
                }
            } else {
                const double radius = std::ceil(currentSourcePeriod_);
                while (nextSynthesisCenter_ <= outputFrame + radius) {
                    scheduleGrain(nextSynthesisCenter_, newestFrame);
                    advanceSynthesisCenter();
                }
                const std::size_t slot = ringIndex(outputFrame);
                if (outputFrameTags_[slot] == outputFrame && outputEpochTags_[slot] == epoch_) {
                    const double norm = outputNormalization_[slot];
                    if (norm > 1.0e-9) {
                        wet = sanitize(static_cast<float>(outputAccumulation_[slot] / norm));
                    }
                    outputAccumulation_[slot] = 0.0;
                    outputNormalization_[slot] = 0.0;
                    outputFrameTags_[slot] = std::numeric_limits<std::int64_t>::min();
                    outputEpochTags_[slot] = 0;
                }
            }
        }
        const float mix = std::clamp(currentVoicingMix_, 0.0f, 1.0f);
        output[i] = sanitize(dry + mix * (wet - dry));
    }
    return true;
}

std::size_t PhaseVocoder::requiredPrepareBytes(std::uint32_t fftFrames) noexcept {
    if (fftFrames < 64 || fftFrames > 16384 ||
        (fftFrames & (fftFrames - 1U)) != 0) return 0;
    const std::size_t bins = static_cast<std::size_t>(fftFrames / 2U) + 1U;
    return bins * 5U * sizeof(float) + 64U * 1024U;
}

bool PhaseVocoder::prepare(const ProcessSpec& spec, std::uint32_t fftFrames,
                           std::uint32_t analysisHopFrames,
                           std::uint32_t synthesisHopFrames) {
    if (!validProcessSpec(spec) || requiredPrepareBytes(fftFrames) == 0 ||
        analysisHopFrames == 0 ||
        synthesisHopFrames == 0 || analysisHopFrames > fftFrames ||
        synthesisHopFrames > fftFrames) {
        return false;
    }

    const std::size_t bins = static_cast<std::size_t>(fftFrames / 2U) + 1U;
    std::vector<float> currentPhase;
    std::vector<float> previousPhase;
    std::vector<float> magnitudes;
    std::vector<float> instantaneousOmega;
    std::vector<float> synthesisPhase;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        currentPhase.resize(bins);
        previousPhase.resize(bins);
        magnitudes.resize(bins);
        instantaneousOmega.resize(bins);
        synthesisPhase.resize(bins);
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif

    currentPhase_.swap(currentPhase);
    previousPhase_.swap(previousPhase);
    magnitudes_.swap(magnitudes);
    instantaneousOmegaRadiansPerSample_.swap(instantaneousOmega);
    synthesisPhase_.swap(synthesisPhase);
    spec_ = spec;
    fftFrames_ = fftFrames;
    analysisHopFrames_ = analysisHopFrames;
    synthesisHopFrames_ = synthesisHopFrames;
    reset();
    return true;
}

void PhaseVocoder::reset() noexcept {
    std::fill(currentPhase_.begin(), currentPhase_.end(), 0.0f);
    std::fill(previousPhase_.begin(), previousPhase_.end(), 0.0f);
    std::fill(magnitudes_.begin(), magnitudes_.end(), 0.0f);
    std::fill(instantaneousOmegaRadiansPerSample_.begin(),
              instantaneousOmegaRadiansPerSample_.end(), 0.0f);
    std::fill(synthesisPhase_.begin(), synthesisPhase_.end(), 0.0f);
    havePreviousFrame_ = false;
}

bool PhaseVocoder::processSpectrumFrame(const std::complex<float>* input,
                                       std::complex<float>* output,
                                       float pitchRatio) noexcept {
    const std::size_t bins = static_cast<std::size_t>(fftFrames_ / 2U) + 1;
    if (input == nullptr || output == nullptr || fftFrames_ == 0 ||
        currentPhase_.size() != bins || !std::isfinite(pitchRatio) ||
        pitchRatio < 0.5f || pitchRatio > 2.0f) {
        return false;
    }

    for (std::size_t bin = 0; bin < bins; ++bin) {
        const double real = input[bin].real();
        const double imag = input[bin].imag();
        currentPhase_[bin] = static_cast<float>(std::atan2(imag, real));
        magnitudes_[bin] = static_cast<float>(std::hypot(real, imag));
    }

    for (std::size_t bin = 0; bin < bins; ++bin) {
        const float binOmega = static_cast<float>(kTwoPi * bin / fftFrames_);
        if (!havePreviousFrame_) {
            instantaneousOmegaRadiansPerSample_[bin] = binOmega;
        } else {
            const float expectedAdvance = binOmega * static_cast<float>(analysisHopFrames_);
            const float phaseAdvance = wrapPhase(currentPhase_[bin] - previousPhase_[bin]);
            const float residual = wrapPhase(phaseAdvance - expectedAdvance);
            instantaneousOmegaRadiansPerSample_[bin] =
                binOmega + residual / static_cast<float>(analysisHopFrames_);
        }
    }

    for (std::size_t bin = 0; bin < bins; ++bin) {
        const double sourcePosition = static_cast<double>(bin) / pitchRatio;
        if (sourcePosition > static_cast<double>(bins - 1)) {
            output[bin] = {};
            continue;
        }
        const auto lower = static_cast<std::size_t>(sourcePosition);
        const auto upper = std::min(lower + 1, bins - 1);
        const float fraction = static_cast<float>(sourcePosition - lower);
        const float magnitude = magnitudes_[lower] + fraction * (magnitudes_[upper] - magnitudes_[lower]);
        const float omega = instantaneousOmegaRadiansPerSample_[lower] + fraction *
            (instantaneousOmegaRadiansPerSample_[upper] - instantaneousOmegaRadiansPerSample_[lower]);

        if (!havePreviousFrame_) {
            synthesisPhase_[bin] = phaseInterpolate(currentPhase_[lower], currentPhase_[upper], fraction);
        } else {
            synthesisPhase_[bin] = wrapPhase(synthesisPhase_[bin] + omega * pitchRatio *
                                             static_cast<float>(synthesisHopFrames_));
        }
        output[bin] = {magnitude * std::cos(synthesisPhase_[bin]),
                       magnitude * std::sin(synthesisPhase_[bin])};
        if (bin != 0 && bin != fftFrames_ / 2U) {
            output[fftFrames_ - bin] = std::conj(output[bin]);
        }
    }
    for (std::size_t bin = 0; bin < bins; ++bin) previousPhase_[bin] = currentPhase_[bin];
    output[0].imag(0.0f);
    output[fftFrames_ / 2U].imag(0.0f);
    havePreviousFrame_ = true;
    return true;
}

float PhaseVocoder::instantaneousAngularFrequencyRadiansPerSample(
    std::uint32_t bin) const noexcept {
    return bin < instantaneousOmegaRadiansPerSample_.size()
        ? instantaneousOmegaRadiansPerSample_[bin]
        : 0.0f;
}

std::size_t MultibandVocoder::requiredPrepareBytes() noexcept {
    return sizeof(MultibandVocoder) + 64U * 1024U;
}

bool MultibandVocoder::prepare(const ProcessSpec& spec, std::uint32_t bandCount,
                               float minimumFrequencyHz, float maximumFrequencyHz,
                               float bandQ) {
    if (!validProcessSpec(spec) || bandCount < 4 || bandCount > kMaximumBands ||
        !std::isfinite(minimumFrequencyHz) || !std::isfinite(maximumFrequencyHz) ||
        !std::isfinite(bandQ) || minimumFrequencyHz <= 0.0f ||
        maximumFrequencyHz <= minimumFrequencyHz || maximumFrequencyHz >= 0.48f * spec.sampleRate ||
        bandQ < 0.2f || bandQ > 20.0f || attackMs_ < 0.1f || attackMs_ > 500.0f ||
        releaseMs_ < 1.0f || releaseMs_ > 3000.0f) {
        return false;
    }

    std::array<BiquadDf2T, kMaximumBands> nextModulatorLeft{};
    std::array<BiquadDf2T, kMaximumBands> nextModulatorRight{};
    std::array<BiquadDf2T, kMaximumBands> nextCarrierLeft{};
    std::array<BiquadDf2T, kMaximumBands> nextCarrierRight{};
    for (std::uint32_t band = 0; band < bandCount; ++band) {
        const float fraction = (static_cast<float>(band) + 0.5f) / static_cast<float>(bandCount);
        const float frequency = minimumFrequencyHz *
            std::pow(maximumFrequencyHz / minimumFrequencyHz, fraction);
        if (!nextModulatorLeft[band].prepare(spec) || !nextModulatorRight[band].prepare(spec) ||
            !nextCarrierLeft[band].prepare(spec) || !nextCarrierRight[band].prepare(spec) ||
            !nextModulatorLeft[band].setBandpass(frequency, bandQ, 0.0f) ||
            !nextModulatorRight[band].setBandpass(frequency, bandQ, 0.0f) ||
            !nextCarrierLeft[band].setBandpass(frequency, bandQ, 0.0f) ||
            !nextCarrierRight[band].setBandpass(frequency, bandQ, 0.0f)) {
            return false;
        }
    }

    modulatorLeft_.swap(nextModulatorLeft);
    modulatorRight_.swap(nextModulatorRight);
    carrierLeft_.swap(nextCarrierLeft);
    carrierRight_.swap(nextCarrierRight);
    spec_ = spec;
    bandCount_ = bandCount;
    maxBlockFrames_ = spec.maxBlockFrames;
    attackCoefficient_ = static_cast<float>(1.0 - std::exp(-1.0 /
        (0.001 * static_cast<double>(attackMs_) * spec.sampleRate)));
    releaseCoefficient_ = static_cast<float>(1.0 - std::exp(-1.0 /
        (0.001 * static_cast<double>(releaseMs_) * spec.sampleRate)));
    envelope_.fill(0.0f);
    reset();
    return true;
}

void MultibandVocoder::reset() noexcept {
    for (std::uint32_t band = 0; band < bandCount_; ++band) {
        modulatorLeft_[band].reset();
        modulatorRight_[band].reset();
        carrierLeft_[band].reset();
        carrierRight_[band].reset();
    }
    envelope_.fill(0.0f);
}

bool MultibandVocoder::setEnvelopeTimes(float attackMs, float releaseMs) noexcept {
    if (!std::isfinite(attackMs) || !std::isfinite(releaseMs) ||
        attackMs < 0.1f || releaseMs < 1.0f || attackMs > 500.0f || releaseMs > 3000.0f) {
        return false;
    }
    attackMs_ = attackMs;
    releaseMs_ = releaseMs;
    if (spec_.sampleRate <= 0.0f) return true;
    attackCoefficient_ = static_cast<float>(1.0 - std::exp(-1.0 /
        (0.001 * attackMs_ * spec_.sampleRate)));
    releaseCoefficient_ = static_cast<float>(1.0 - std::exp(-1.0 /
        (0.001 * releaseMs_ * spec_.sampleRate)));
    return std::isfinite(attackCoefficient_) && std::isfinite(releaseCoefficient_);
}

bool MultibandVocoder::setOutputGain(float gain) noexcept {
    if (!std::isfinite(gain) || gain < 0.0f || gain > 16.0f) return false;
    outputGain_ = gain;
    return true;
}

StereoFrame MultibandVocoder::processSample(float modulatorLeft,
                                            float modulatorRight,
                                            float carrierLeft,
                                            float carrierRight) noexcept {
    StereoFrame output{};
    if (bandCount_ == 0) return output;
    const float modL = sanitize(modulatorLeft);
    const float modR = sanitize(modulatorRight);
    const float carL = sanitize(carrierLeft);
    const float carR = sanitize(carrierRight);
    double sumLeft = 0.0;
    double sumRight = 0.0;
    for (std::uint32_t band = 0; band < bandCount_; ++band) {
        const float analyzerLeft = modulatorLeft_[band].processSample(modL);
        const float analyzerRight = modulatorRight_[band].processSample(modR);
        const float detector = 0.5f * (std::abs(analyzerLeft) + std::abs(analyzerRight));
        const float coefficient = detector > envelope_[band]
            ? attackCoefficient_ : releaseCoefficient_;
        envelope_[band] += coefficient * (detector - envelope_[band]);
        sumLeft += static_cast<double>(carrierLeft_[band].processSample(carL)) * envelope_[band];
        sumRight += static_cast<double>(carrierRight_[band].processSample(carR)) * envelope_[band];
    }
    output.left = sanitize(static_cast<float>(sumLeft * outputGain_));
    output.right = sanitize(static_cast<float>(sumRight * outputGain_));
    return output;
}

bool MultibandVocoder::processBlock(const float* modulatorLeft,
                                   const float* modulatorRight,
                                   const float* carrierLeft,
                                   const float* carrierRight,
                                   float* outputLeft, float* outputRight,
                                   std::uint32_t frames) noexcept {
    if (bandCount_ == 0 || frames > maxBlockFrames_ ||
        modulatorLeft == nullptr || modulatorRight == nullptr ||
        carrierLeft == nullptr || carrierRight == nullptr ||
        outputLeft == nullptr || outputRight == nullptr) {
        return false;
    }
    for (std::uint32_t frame = 0; frame < frames; ++frame) {
        const auto output = processSample(modulatorLeft[frame], modulatorRight[frame],
                                          carrierLeft[frame], carrierRight[frame]);
        outputLeft[frame] = output.left;
        outputRight[frame] = output.right;
    }
    return true;
}

} // namespace webrc::dsp
