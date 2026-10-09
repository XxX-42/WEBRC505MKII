#include "webrc/dsp/streaming_yin.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::uint64_t kMaxExactFrame = 1ULL << 53U;

std::uint32_t nextPowerOfTwo(std::uint32_t value) noexcept {
    if (value <= 1U) return 1U;
    --value;
    value |= value >> 1U;
    value |= value >> 2U;
    value |= value >> 4U;
    value |= value >> 8U;
    value |= value >> 16U;
    return value + 1U;
}

float finiteOrZero(float value) noexcept {
    return std::isfinite(value) && std::abs(value) >= 1.0e-30f ? value : 0.0f;
}

} // namespace

std::size_t IncrementalYinDetector::requiredPrepareBytes(
    const ProcessSpec& spec, std::uint32_t windowFrames,
    float minimumFrequencyHz, float maximumFrequencyHz,
    std::uint32_t workUnitsPerBlock) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 1U || windowFrames < 64U ||
        windowFrames > 8192U || workUnitsPerBlock < windowFrames || workUnitsPerBlock > 1'000'000U ||
        !std::isfinite(minimumFrequencyHz) || !std::isfinite(maximumFrequencyHz) ||
        minimumFrequencyHz <= 0.0f || maximumFrequencyHz <= minimumFrequencyHz ||
        maximumFrequencyHz >= 0.5f * spec.sampleRate) return 0U;
    const double minimumLag = std::floor(static_cast<double>(spec.sampleRate) / maximumFrequencyHz);
    const double maximumLag = std::ceil(static_cast<double>(spec.sampleRate) / minimumFrequencyHz);
    if (!std::isfinite(minimumLag) || !std::isfinite(maximumLag) || minimumLag < 2.0 ||
        maximumLag >= static_cast<double>(windowFrames - 2U) || maximumLag <= minimumLag) return 0U;

    const auto fftFrames = nextPowerOfTwo(windowFrames * 2U);
    const std::uint64_t bytes =
        2ULL * windowFrames * sizeof(float) +
        static_cast<std::uint64_t>(fftFrames) * sizeof(std::complex<float>) +
        static_cast<std::uint64_t>(fftFrames / 2U) * sizeof(std::complex<double>) +
        (static_cast<std::uint64_t>(windowFrames) + 1U +
         static_cast<std::uint64_t>(maximumLag) + 2U) * sizeof(double) +
        64ULL * 1024ULL;
    return bytes <= std::numeric_limits<std::size_t>::max()
        ? static_cast<std::size_t>(bytes) : 0U;
}

bool IncrementalYinDetector::prepare(const ProcessSpec& spec, std::uint32_t windowFrames,
                                     float minimumFrequencyHz, float maximumFrequencyHz,
                                     float threshold, std::uint32_t hopFrames,
                                     std::uint32_t workUnitsPerBlock) {
    if (!std::isfinite(threshold) || threshold <= 0.0f || threshold >= 1.0f ||
        hopFrames == 0U || hopFrames > windowFrames ||
        requiredPrepareBytes(spec, windowFrames, minimumFrequencyHz, maximumFrequencyHz,
                             workUnitsPerBlock) == 0U) return false;

    const auto minimumLag = static_cast<std::uint32_t>(std::floor(
        static_cast<double>(spec.sampleRate) / maximumFrequencyHz));
    const auto maximumLag = static_cast<std::uint32_t>(std::ceil(
        static_cast<double>(spec.sampleRate) / minimumFrequencyHz));
    const auto fftFrames = nextPowerOfTwo(windowFrames * 2U);
    std::vector<float> inputRing, snapshot;
    std::vector<std::complex<float>> spectrum;
    std::vector<std::complex<double>> twiddleRoots;
    std::vector<double> prefixEnergy, cmnd;
#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
    try {
#endif
        inputRing.assign(windowFrames, 0.0f);
        snapshot.assign(windowFrames, 0.0f);
        spectrum.assign(fftFrames, {});
        twiddleRoots.resize(fftFrames / 2U);
        prefixEnergy.assign(static_cast<std::size_t>(windowFrames) + 1U, 0.0);
        cmnd.assign(static_cast<std::size_t>(maximumLag) + 2U, 0.0);
#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif
    for (std::uint32_t i = 0U; i < fftFrames / 2U; ++i) {
        const double angle = -2.0 * kPi * static_cast<double>(i) / fftFrames;
        twiddleRoots[i] = {std::cos(angle), std::sin(angle)};
    }

    inputRing_.swap(inputRing);
    snapshot_.swap(snapshot);
    spectrum_.swap(spectrum);
    twiddleRoots_.swap(twiddleRoots);
    prefixEnergy_.swap(prefixEnergy);
    cmnd_.swap(cmnd);
    spec_ = spec;
    windowFrames_ = windowFrames;
    fftFrames_ = fftFrames;
    minimumLag_ = minimumLag;
    maximumLag_ = maximumLag;
    hopFrames_ = hopFrames;
    workUnitsPerBlock_ = workUnitsPerBlock;
    minimumPeriodSamples_ = static_cast<double>(spec.sampleRate) / maximumFrequencyHz;
    maximumPeriodSamples_ = static_cast<double>(spec.sampleRate) / minimumFrequencyHz;
    threshold_ = threshold;
    prepared_ = true;
    reset();
    return true;
}

void IncrementalYinDetector::reset() noexcept {
    std::fill(inputRing_.begin(), inputRing_.end(), 0.0f);
    std::fill(snapshot_.begin(), snapshot_.end(), 0.0f);
    std::fill(spectrum_.begin(), spectrum_.end(), std::complex<float>{});
    std::fill(prefixEnergy_.begin(), prefixEnergy_.end(), 0.0);
    std::fill(cmnd_.begin(), cmnd_.end(), 0.0);
    ringWrite_ = ringFilled_ = samplesSinceCapture_ = workCursor_ = lastWorkUnits_ = 0U;
    bitReverseIndex_ = bitReverseJ_ = fftSpan_ = fftBase_ = fftOffset_ = 0U;
    estimateLagCursor_ = searchMinimumLag_ = selectedLag_ = bestLag_ = 0U;
    latestProcessingLagFrames_ = 0U;
    totalInputFrames_ = captureWindowEndFrame_ = latestWindowEndFrame_ = analysisCount_ = 0U;
    meanAccumulator_ = centeredEnergy_ = cumulativeDifference_ = bestCmnd_ = rms_ = 0.0;
    fftStep_ = fftTwiddle_ = {1.0, 0.0};
    latestEstimate_ = {};
    phase_ = Phase::Idle;
    fftInverse_ = false;
}

bool IncrementalYinDetector::analysisBusy() const noexcept {
    return phase_ != Phase::Idle;
}

void IncrementalYinDetector::beginAnalysis() noexcept {
    captureWindowEndFrame_ = totalInputFrames_;
    samplesSinceCapture_ = 0U;
    // Copy the selected window in one bounded, fixed-size operation. Spreading
    // this copy over callbacks while the input ring is still being written
    // would mix samples from different windows. The maximum window is 8192
    // samples and this work is included in the per-callback unit budget.
    for (std::uint32_t i = 0U; i < windowFrames_; ++i)
        snapshot_[i] = inputRing_[(ringWrite_ + i) % windowFrames_];
    lastWorkUnits_ += windowFrames_;
    workCursor_ = 0U;
    meanAccumulator_ = 0.0;
    centeredEnergy_ = 0.0;
    phase_ = Phase::Mean;
}

void IncrementalYinDetector::beginTransform(bool inverse) noexcept {
    fftInverse_ = inverse;
    bitReverseIndex_ = 0U;
    bitReverseJ_ = 0U;
    phase_ = inverse ? Phase::BitReverseInverse : Phase::BitReverseForward;
}

void IncrementalYinDetector::advanceTransformStage() noexcept {
    fftSpan_ = 2U;
    fftBase_ = 0U;
    fftOffset_ = 0U;
    fftTwiddle_ = {1.0, 0.0};
    fftStep_ = twiddleRoots_[fftFrames_ / fftSpan_];
    if (fftInverse_) fftStep_ = std::conj(fftStep_);
    phase_ = fftInverse_ ? Phase::FftInverse : Phase::FftForward;
}

void IncrementalYinDetector::completeAnalysis(const PitchEstimate& estimate) noexcept {
    latestEstimate_ = estimate;
    latestWindowEndFrame_ = captureWindowEndFrame_;
    const auto lag = totalInputFrames_ >= captureWindowEndFrame_
        ? totalInputFrames_ - captureWindowEndFrame_ : 0U;
    latestProcessingLagFrames_ = static_cast<std::uint32_t>(
        std::min<std::uint64_t>(lag, std::numeric_limits<std::uint32_t>::max()));
    ++analysisCount_;
    phase_ = Phase::Idle;
    workCursor_ = 0U;
}

void IncrementalYinDetector::performWork() noexcept {
    while (lastWorkUnits_ < workUnitsPerBlock_ && phase_ != Phase::Idle) {
        ++lastWorkUnits_;
        switch (phase_) {
        case Phase::Idle:
            return;
        case Phase::Mean:
            meanAccumulator_ += snapshot_[workCursor_];
            if (++workCursor_ == windowFrames_) {
                meanAccumulator_ /= static_cast<double>(windowFrames_);
                workCursor_ = 0U;
                prefixEnergy_[0] = 0.0;
                centeredEnergy_ = 0.0;
                phase_ = Phase::CenterAndPad;
            }
            break;
        case Phase::CenterAndPad:
            if (workCursor_ < windowFrames_) {
                const double sample = static_cast<double>(snapshot_[workCursor_]) - meanAccumulator_;
                centeredEnergy_ += sample * sample;
                prefixEnergy_[workCursor_ + 1U] = centeredEnergy_;
                spectrum_[workCursor_] = {static_cast<float>(sample), 0.0f};
            } else {
                spectrum_[workCursor_] = {};
            }
            if (++workCursor_ == fftFrames_) {
                rms_ = std::sqrt(centeredEnergy_ / static_cast<double>(windowFrames_));
                workCursor_ = 0U;
                if (!std::isfinite(rms_) || rms_ < silenceRms_) {
                    PitchEstimate silent{};
                    silent.rms = std::isfinite(rms_) ? static_cast<float>(rms_) : 0.0f;
                    completeAnalysis(silent);
                } else {
                    beginTransform(false);
                }
            }
            break;
        case Phase::BitReverseForward:
        case Phase::BitReverseInverse: {
            auto j = bitReverseJ_;
            if (bitReverseIndex_ < j) std::swap(spectrum_[bitReverseIndex_], spectrum_[j]);
            spectrum_[bitReverseIndex_] = {finiteOrZero(spectrum_[bitReverseIndex_].real()),
                                           finiteOrZero(spectrum_[bitReverseIndex_].imag())};
            std::uint32_t bit = fftFrames_ >> 1U;
            while (bit != 0U && (j & bit) != 0U) {
                j ^= bit;
                bit >>= 1U;
            }
            j ^= bit;
            bitReverseJ_ = j;
            if (++bitReverseIndex_ == fftFrames_) advanceTransformStage();
            break;
        }
        case Phase::FftForward:
        case Phase::FftInverse: {
            const auto evenIndex = fftBase_ + fftOffset_;
            const auto oddIndex = evenIndex + (fftSpan_ >> 1U);
            const auto even = std::complex<double>(spectrum_[evenIndex].real(), spectrum_[evenIndex].imag());
            const auto oddInput = spectrum_[oddIndex];
            const auto odd = std::complex<double>(oddInput.real(), oddInput.imag()) * fftTwiddle_;
            const auto low = even + odd;
            const auto high = even - odd;
            spectrum_[evenIndex] = {static_cast<float>(low.real()), static_cast<float>(low.imag())};
            spectrum_[oddIndex] = {static_cast<float>(high.real()), static_cast<float>(high.imag())};
            fftTwiddle_ *= fftStep_;
            if (++fftOffset_ == (fftSpan_ >> 1U)) {
                fftOffset_ = 0U;
                fftTwiddle_ = {1.0, 0.0};
                fftBase_ += fftSpan_;
                if (fftBase_ == fftFrames_) {
                    if (fftSpan_ == fftFrames_) {
                        if (fftInverse_) {
                            workCursor_ = 0U;
                            phase_ = Phase::ScaleInverse;
                        } else {
                            workCursor_ = 0U;
                            phase_ = Phase::PowerSpectrum;
                        }
                    } else {
                        fftSpan_ <<= 1U;
                        fftBase_ = 0U;
                        fftStep_ = twiddleRoots_[fftFrames_ / fftSpan_];
                        if (fftInverse_) fftStep_ = std::conj(fftStep_);
                    }
                }
            }
            break;
        }
        case Phase::PowerSpectrum: {
            const double real = spectrum_[workCursor_].real();
            const double imag = spectrum_[workCursor_].imag();
            const double magnitude = real * real + imag * imag;
            spectrum_[workCursor_] = {std::isfinite(magnitude) ? static_cast<float>(magnitude) : 0.0f, 0.0f};
            if (++workCursor_ == fftFrames_) beginTransform(true);
            break;
        }
        case Phase::ScaleInverse: {
            const float scale = 1.0f / static_cast<float>(fftFrames_);
            spectrum_[workCursor_] *= scale;
            spectrum_[workCursor_] = {finiteOrZero(spectrum_[workCursor_].real()),
                                      finiteOrZero(spectrum_[workCursor_].imag())};
            if (++workCursor_ == fftFrames_) {
                cumulativeDifference_ = 0.0;
                bestCmnd_ = std::numeric_limits<double>::infinity();
                bestLag_ = minimumLag_;
                estimateLagCursor_ = 1U;
                cmnd_[0] = 1.0;
                phase_ = Phase::Cmnd;
            }
            break;
        }
        case Phase::Cmnd: {
            const auto lag = estimateLagCursor_;
            const double energyA = prefixEnergy_[windowFrames_ - lag];
            const double energyB = prefixEnergy_[windowFrames_] - prefixEnergy_[lag];
            const double correlation = spectrum_[lag].real();
            const double difference = std::max(0.0, energyA + energyB - 2.0 * correlation);
            cumulativeDifference_ += difference;
            cmnd_[lag] = cumulativeDifference_ > 1.0e-20
                ? difference * static_cast<double>(lag) / cumulativeDifference_ : 1.0;
            if (lag >= minimumLag_ && lag <= maximumLag_ && cmnd_[lag] < bestCmnd_) {
                bestCmnd_ = cmnd_[lag];
                bestLag_ = lag;
            }
            if (++estimateLagCursor_ > maximumLag_) {
                searchMinimumLag_ = minimumLag_ > 2U ? minimumLag_ - 2U : 2U;
                estimateLagCursor_ = searchMinimumLag_;
                selectedLag_ = 0U;
                phase_ = Phase::SelectLag;
            }
            break;
        }
        case Phase::SelectLag:
            if (estimateLagCursor_ < maximumLag_) {
                const auto lag = estimateLagCursor_;
                if (cmnd_[lag] < threshold_ && cmnd_[lag] <= cmnd_[lag + 1U]) {
                    selectedLag_ = lag;
                    phase_ = Phase::FollowMinimum;
                } else {
                    ++estimateLagCursor_;
                }
            } else {
                selectedLag_ = bestLag_;
                phase_ = Phase::FollowMinimum;
            }
            break;
        case Phase::FollowMinimum:
            if (selectedLag_ < maximumLag_ && cmnd_[selectedLag_ + 1U] < cmnd_[selectedLag_]) {
                ++selectedLag_;
            } else {
                const double left = selectedLag_ > searchMinimumLag_
                    ? cmnd_[selectedLag_ - 1U] : cmnd_[selectedLag_];
                const double center = cmnd_[selectedLag_];
                const double right = selectedLag_ < maximumLag_
                    ? cmnd_[selectedLag_ + 1U] : center;
                const double denominator = left - 2.0 * center + right;
                double offset = std::abs(denominator) > 1.0e-15
                    ? 0.5 * (left - right) / denominator : 0.0;
                offset = std::clamp(offset, -0.5, 0.5);
                const double period = std::clamp(static_cast<double>(selectedLag_) + offset,
                                                  minimumPeriodSamples_, maximumPeriodSamples_);
                const double confidence = std::clamp(1.0 - center, 0.0, 1.0);
                PitchEstimate result{};
                result.rms = std::isfinite(rms_) ? static_cast<float>(rms_) : 0.0f;
                result.periodSamples = static_cast<float>(period);
                result.confidence = static_cast<float>(confidence);
                result.frequencyHz = static_cast<float>(spec_.sampleRate / period);
                result.voiced = std::isfinite(result.frequencyHz) && center <= threshold_;
                if (!result.voiced) {
                    result.frequencyHz = 0.0f;
                    result.periodSamples = 0.0f;
                }
                completeAnalysis(result);
            }
            break;
        }
    }
}

bool IncrementalYinDetector::processBlock(const float* monoInput, std::uint32_t frames) noexcept {
    lastWorkUnits_ = 0U;
    if (!prepared_ || monoInput == nullptr || frames == 0U || frames > spec_.maxBlockFrames ||
        totalInputFrames_ >= kMaxExactFrame || frames > kMaxExactFrame - totalInputFrames_) return false;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const float sample = std::clamp(sanitize(monoInput[i]), -8.0f, 8.0f);
        inputRing_[ringWrite_] = sample;
        if (++ringWrite_ == windowFrames_) ringWrite_ = 0U;
        if (ringFilled_ < windowFrames_) ++ringFilled_;
        if (samplesSinceCapture_ < std::numeric_limits<std::uint32_t>::max()) ++samplesSinceCapture_;
        ++totalInputFrames_;
    }
    if (phase_ == Phase::Idle && ringFilled_ == windowFrames_ && samplesSinceCapture_ >= hopFrames_)
        beginAnalysis();
    performWork();
    return true;
}

} // namespace webrc::dsp
