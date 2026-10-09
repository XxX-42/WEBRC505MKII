#include "webrc/dsp/spatial_temporal.hpp"

#include "webrc/dsp/fft.hpp"

#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
#include <new>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_DSP_TRY try
#define WEBRC_DSP_CATCH_BAD_ALLOC catch (const std::bad_alloc&)
#else
// Standard vector allocation is fail-fast in no-exception builds. Callers must
// preflight graph peak memory before preparing a staged instance.
#define WEBRC_DSP_TRY if (true)
#define WEBRC_DSP_CATCH_BAD_ALLOC else if (false)
#endif

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr float kDenormalCutoff = 1.0e-20f;

bool finite(float value) noexcept { return std::isfinite(value); }

float clean(float value) noexcept {
    return finite(value) && std::abs(value) >= kDenormalCutoff ? value : 0.0f;
}

bool validSpec(const ProcessSpec& spec, bool stereoRequired = true) noexcept {
    return finite(spec.sampleRate) && spec.sampleRate >= 8000.0f &&
           spec.sampleRate <= 384000.0f && spec.maxBlockFrames > 0 &&
           spec.maxBlockFrames <= 8192 && spec.channels > 0 && spec.channels <= 2 &&
           (!stereoRequired || spec.channels == 2);
}

std::uint32_t wrapIndex(std::int64_t index, std::uint32_t size) noexcept {
    const auto n = static_cast<std::int64_t>(size);
    auto wrapped = index % n;
    if (wrapped < 0) {
        wrapped += n;
    }
    return static_cast<std::uint32_t>(wrapped);
}

float lagrange4(float xm1, float x0, float x1, float x2, float phase) noexcept {
    const double t = std::clamp(static_cast<double>(phase), 0.0, 1.0);
    const double cM1 = -t * (t - 1.0) * (t - 2.0) / 6.0;
    const double c0 = (t + 1.0) * (t - 1.0) * (t - 2.0) / 2.0;
    const double c1 = -(t + 1.0) * t * (t - 2.0) / 2.0;
    const double c2 = (t + 1.0) * t * (t - 1.0) / 6.0;
    return clean(static_cast<float>(cM1 * xm1 + c0 * x0 + c1 * x1 + c2 * x2));
}

void hadamardStages(float* values, std::uint32_t count) noexcept {
    for (std::uint32_t span = 1; span < count; span <<= 1) {
        for (std::uint32_t base = 0; base < count; base += span * 2) {
            for (std::uint32_t offset = 0; offset < span; ++offset) {
                const float a = values[base + offset];
                const float b = values[base + offset + span];
                values[base + offset] = a + b;
                values[base + offset + span] = a - b;
            }
        }
    }
}

} // namespace

bool normalizedHadamard(float* values, std::uint32_t count) noexcept {
    if (values == nullptr || (count != 8 && count != 16)) {
        return false;
    }
    hadamardStages(values, count);
    const float scale = 1.0f / std::sqrt(static_cast<float>(count));
    for (std::uint32_t i = 0; i < count; ++i) {
        values[i] = clean(values[i] * scale);
    }
    return true;
}

std::size_t PartitionedConvolver::requiredPrepareBytes(std::uint32_t partitionFrames,
                                                       std::uint32_t impulseFrames) noexcept {
    if (!fft::isPowerOfTwo(partitionFrames) || partitionFrames < 16 || partitionFrames > 2048 ||
        impulseFrames == 0) {
        return 0;
    }
    const std::uint64_t partitions =
        (static_cast<std::uint64_t>(impulseFrames) + partitionFrames - 1U) / partitionFrames;
    if (partitions == 0 || partitions > 65536) return 0;
    const std::uint64_t fftFrames = static_cast<std::uint64_t>(partitionFrames) * 2U;
    const std::uint64_t bins = partitions * fftFrames;
    const std::uint64_t payload = bins * 6U * sizeof(std::complex<float>) +
        fftFrames * 4U * sizeof(std::complex<float>) +
        static_cast<std::uint64_t>(partitionFrames) * 6U * sizeof(float);
    constexpr std::uint64_t maximumPayload = 24U * 1024U * 1024U;
    if (payload > maximumPayload || payload + kPrepareAllocatorAllowanceBytes >
        std::numeric_limits<std::size_t>::max()) return 0;
    return static_cast<std::size_t>(payload) + kPrepareAllocatorAllowanceBytes;
}

bool PartitionedConvolver::prepare(const ProcessSpec& spec, std::uint32_t partitionFrames,
                                   std::uint32_t impulseFrames, const float* impulseLL,
                                   const float* impulseLR, const float* impulseRL,
                                   const float* impulseRR) {
    prepared_ = false;
    if (!validSpec(spec) || !fft::isPowerOfTwo(partitionFrames) ||
        partitionFrames < 16 || partitionFrames > 2048 || impulseFrames == 0 ||
        (impulseLL == nullptr && impulseLR == nullptr && impulseRL == nullptr &&
         impulseRR == nullptr)) {
        return false;
    }
    if (requiredPrepareBytes(partitionFrames, impulseFrames) == 0) return false;
    const std::uint32_t fftFrames = partitionFrames * 2;
    const std::uint64_t partitionCount =
        (static_cast<std::uint64_t>(impulseFrames) + partitionFrames - 1U) / partitionFrames;
    if (partitionCount == 0 || partitionCount > 65536) {
        return false;
    }
    const auto partitions = static_cast<std::uint32_t>(partitionCount);
    const std::size_t bins = static_cast<std::size_t>(partitions) * fftFrames;
    // Four IR branches + two input-history rings. Bound prepare-time memory so
    // malformed durations cannot request multi-gigabyte allocations.
    constexpr std::size_t kMaximumSpectrumBytes = 24U * 1024U * 1024U;
    if (bins > kMaximumSpectrumBytes / (sizeof(std::complex<float>) * 6U)) {
        return false;
    }

    WEBRC_DSP_TRY {
        const std::array<const float*, 4> impulsePointers{impulseLL, impulseLR, impulseRL, impulseRR};
        for (std::size_t branch = 0; branch < impulseSpectra_.size(); ++branch) {
            impulseSpectra_[branch].assign(bins, {0.0f, 0.0f});
            if (impulsePointers[branch] == nullptr) {
                continue;
            }
            std::vector<std::complex<float>> frame(fftFrames, {0.0f, 0.0f});
            for (std::uint32_t part = 0; part < partitions; ++part) {
                std::fill(frame.begin(), frame.end(), std::complex<float>{0.0f, 0.0f});
                const std::uint32_t offset = part * partitionFrames;
                const std::uint32_t count = std::min(partitionFrames, impulseFrames - offset);
                for (std::uint32_t i = 0; i < count; ++i) {
                    const float tap = clean(impulsePointers[branch][offset + i]);
                    frame[i] = {tap, 0.0f};
                }
                if (!fft::transform(frame.data(), frame.size(), fft::Direction::Forward)) {
                    return false;
                }
                std::copy(frame.begin(), frame.end(),
                          impulseSpectra_[branch].begin() + static_cast<std::size_t>(part) * fftFrames);
            }
        }
        for (auto& history : inputSpectrumHistory_) {
            history.assign(bins, {0.0f, 0.0f});
        }
        for (auto& scratch : fftScratch_) {
            scratch.assign(fftFrames, {0.0f, 0.0f});
        }
        for (auto& scratch : sumScratch_) {
            scratch.assign(fftFrames, {0.0f, 0.0f});
        }
        for (auto& block : previousInput_) {
            block.assign(partitionFrames, 0.0f);
        }
        for (auto& block : currentInput_) {
            block.assign(partitionFrames, 0.0f);
        }
        for (auto& queue : outputQueue_) {
            queue.assign(partitionFrames, 0.0f);
        }
    } WEBRC_DSP_CATCH_BAD_ALLOC {
        reset();
        return false;
    }

    spec_ = spec;
    partitionFrames_ = partitionFrames;
    fftFrames_ = fftFrames;
    impulseFrames_ = impulseFrames;
    impulsePartitions_ = partitions;
    prepared_ = true;
    reset();
    return true;
}

void PartitionedConvolver::reset() noexcept {
    for (auto& history : inputSpectrumHistory_) {
        std::fill(history.begin(), history.end(), std::complex<float>{0.0f, 0.0f});
    }
    for (auto& block : previousInput_) {
        std::fill(block.begin(), block.end(), 0.0f);
    }
    for (auto& block : currentInput_) {
        std::fill(block.begin(), block.end(), 0.0f);
    }
    for (auto& queue : outputQueue_) {
        std::fill(queue.begin(), queue.end(), 0.0f);
    }
    for (auto& scratch : fftScratch_) {
        std::fill(scratch.begin(), scratch.end(), std::complex<float>{0.0f, 0.0f});
    }
    for (auto& scratch : sumScratch_) {
        std::fill(scratch.begin(), scratch.end(), std::complex<float>{0.0f, 0.0f});
    }
    inputFill_ = 0;
    outputRead_ = 0;
    historyWrite_ = 0;
}

void PartitionedConvolver::finishInputPartition() noexcept {
    for (std::uint32_t channel = 0; channel < 2; ++channel) {
        auto& frame = fftScratch_[channel];
        for (std::uint32_t i = 0; i < partitionFrames_; ++i) {
            frame[i] = {previousInput_[channel][i], 0.0f};
            frame[i + partitionFrames_] = {currentInput_[channel][i], 0.0f};
        }
        (void)fft::transform(frame.data(), frame.size(), fft::Direction::Forward);
        const std::size_t historyOffset = static_cast<std::size_t>(historyWrite_) * fftFrames_;
        std::copy(frame.begin(), frame.end(), inputSpectrumHistory_[channel].begin() + historyOffset);
    }

    for (std::uint32_t output = 0; output < 2; ++output) {
        auto& sum = sumScratch_[output];
        std::fill(sum.begin(), sum.end(), std::complex<float>{0.0f, 0.0f});
        for (std::uint32_t part = 0; part < impulsePartitions_; ++part) {
            const std::uint32_t inputIndexLeft = (historyWrite_ + impulsePartitions_ - part) % impulsePartitions_;
            const std::uint32_t inputIndexRight = inputIndexLeft;
            const std::size_t inputOffsetLeft = static_cast<std::size_t>(inputIndexLeft) * fftFrames_;
            const std::size_t inputOffsetRight = static_cast<std::size_t>(inputIndexRight) * fftFrames_;
            const std::size_t impulseOffset = static_cast<std::size_t>(part) * fftFrames_;
            const std::size_t branchA = output == 0 ? 0 : 2;
            const std::size_t branchB = output == 0 ? 1 : 3;
            for (std::uint32_t bin = 0; bin < fftFrames_; ++bin) {
                sum[bin] += impulseSpectra_[branchA][impulseOffset + bin] *
                            inputSpectrumHistory_[0][inputOffsetLeft + bin];
                sum[bin] += impulseSpectra_[branchB][impulseOffset + bin] *
                            inputSpectrumHistory_[1][inputOffsetRight + bin];
            }
        }
        (void)fft::transform(sum.data(), sum.size(), fft::Direction::Inverse);
        for (std::uint32_t i = 0; i < partitionFrames_; ++i) {
            outputQueue_[output][i] = clean(sum[i + partitionFrames_].real());
        }
    }

    for (std::uint32_t channel = 0; channel < 2; ++channel) {
        previousInput_[channel].swap(currentInput_[channel]);
        std::fill(currentInput_[channel].begin(), currentInput_[channel].end(), 0.0f);
    }
    historyWrite_ = (historyWrite_ + 1) % impulsePartitions_;
    inputFill_ = 0;
    outputRead_ = 0;
}

bool PartitionedConvolver::processBlock(const float* inputLeft, const float* inputRight,
                                        float* outputLeft, float* outputRight,
                                        std::uint32_t frames) noexcept {
    if (!prepared_ || inputLeft == nullptr || inputRight == nullptr || outputLeft == nullptr ||
        outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const float inputL = clean(inputLeft[i]);
        const float inputR = clean(inputRight[i]);
        outputLeft[i] = outputQueue_[0][outputRead_];
        outputRight[i] = outputQueue_[1][outputRead_];
        ++outputRead_;
        currentInput_[0][inputFill_] = inputL;
        currentInput_[1][inputFill_] = inputR;
        ++inputFill_;
        if (inputFill_ == partitionFrames_) {
            finishInputPartition();
        }
    }
    return true;
}

bool FdnReverb::prepare(const ProcessSpec& spec, FdnLineCount lineCount,
                        float maximumDelaySeconds) {
    prepared_ = false;
    if (!validSpec(spec) || (lineCount != FdnLineCount::Eight && lineCount != FdnLineCount::Sixteen) ||
        !finite(maximumDelaySeconds) || maximumDelaySeconds < 0.03f || maximumDelaySeconds > 2.0f) {
        return false;
    }
    if (requiredPrepareBytes(spec, lineCount, maximumDelaySeconds) == 0) return false;
    spec_ = spec;
    lineCount_ = lineCount;
    activeLines_ = static_cast<std::uint32_t>(lineCount);
    const double delayScale = static_cast<double>(maximumDelaySeconds) / 0.1013;
    const std::array<double, kMaximumLines> delayMs{
        29.7, 37.1, 41.1, 43.7, 47.3, 53.1, 59.1, 61.7,
        67.1, 71.9, 73.7, 79.1, 83.3, 89.7, 97.1, 101.3};
    const std::uint32_t earlyFrames = static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(spec.sampleRate) * kMaximumEarlyDelayMs / 1000.0)) + 2;
    std::uint64_t requiredBytes = static_cast<std::uint64_t>(earlyFrames) * 2U * sizeof(float);
    const auto modulationHeadroom = static_cast<std::uint64_t>(
        std::ceil(static_cast<double>(spec.sampleRate) * 0.005)) + 8U;
    for (std::uint32_t line = 0; line < activeLines_; ++line) {
        const auto requested = static_cast<std::uint64_t>(std::llround(
            delayMs[line] * delayScale * static_cast<double>(spec.sampleRate) / 1000.0));
        requiredBytes += (std::max<std::uint64_t>(requested, 16U) + modulationHeadroom) * sizeof(float);
    }
    constexpr std::uint64_t kMaximumFdnPayloadBytes = 16U * 1024U * 1024U;
    if (requiredBytes > kMaximumFdnPayloadBytes) {
        return false;
    }
    WEBRC_DSP_TRY {
    for (std::uint32_t line = 0; line < activeLines_; ++line) {
        const auto requested = static_cast<std::uint32_t>(std::lround(
            delayMs[line] * delayScale * static_cast<double>(spec.sampleRate) / 1000.0));
        delayLengths_[line] = std::max<std::uint32_t>(requested, 16);
            delayLines_[line].assign(static_cast<std::size_t>(delayLengths_[line]) +
                                     static_cast<std::size_t>(modulationHeadroom), 0.0f);
        const double phaseOffset = kTwoPi * static_cast<double>(line) / activeLines_;
        modPhaseOffsetSin_[line] = std::sin(phaseOffset);
        modPhaseOffsetCos_[line] = std::cos(phaseOffset);
        }
        earlyLeftRing_.assign(earlyFrames, 0.0f);
        earlyRightRing_.assign(earlyFrames, 0.0f);
    } WEBRC_DSP_CATCH_BAD_ALLOC {
        reset();
        return false;
    }
    earlyTapCount_ = 6;
    const auto msToSamples = [&spec](double milliseconds) {
        return static_cast<std::uint32_t>(std::lround(milliseconds * spec.sampleRate / 1000.0));
    };
    earlyTaps_[0] = {0, 0.28f, 0.0f, 0.0f, 0.28f};
    earlyTaps_[1] = {msToSamples(4.7), 0.22f, 0.04f, 0.03f, 0.18f};
    earlyTaps_[2] = {msToSamples(8.3), 0.10f, -0.05f, 0.06f, 0.14f};
    earlyTaps_[3] = {msToSamples(13.1), 0.07f, 0.06f, -0.04f, 0.08f};
    earlyTaps_[4] = {msToSamples(19.7), 0.04f, -0.03f, 0.05f, 0.05f};
    earlyTaps_[5] = {msToSamples(27.3), 0.03f, 0.02f, -0.02f, 0.04f};
    reset();
    prepared_ = true;
    // Re-establish bounded defaults after reset.
    (void)setParameters(1.2f, 8000.0f, 0.17f, 0.15f, 0.9995f, 0.65f, 0.0f);
    currentRt60_ = targetRt60_;
    currentDampingHz_ = targetDampingHz_;
    currentModRateHz_ = targetModRateHz_;
    currentModDepthMs_ = targetModDepthMs_;
    currentMaximumFeedback_ = targetMaximumFeedback_;
    currentWet_ = targetWet_;
    for (std::uint32_t line = 0; line < activeLines_; ++line) {
        const double delaySeconds = static_cast<double>(delayLengths_[line]) / spec.sampleRate;
        targetFeedback_[line] = std::min(targetMaximumFeedback_,
            static_cast<float>(std::pow(10.0, -3.0 * delaySeconds / targetRt60_)));
        currentFeedback_[line] = targetFeedback_[line];
    }
    targetDampingCoefficient_ = static_cast<float>(1.0 - std::exp(-kTwoPi * targetDampingHz_ / spec.sampleRate));
    currentDampingCoefficient_ = targetDampingCoefficient_;
    return true;
}

std::size_t FdnReverb::requiredPrepareBytes(const ProcessSpec& spec, FdnLineCount lineCount,
                                           float maximumDelaySeconds) noexcept {
    if (!validSpec(spec) || (lineCount != FdnLineCount::Eight && lineCount != FdnLineCount::Sixteen) ||
        !finite(maximumDelaySeconds) || maximumDelaySeconds < 0.03f || maximumDelaySeconds > 2.0f) {
        return 0;
    }
    constexpr std::size_t lineCountMax = 16;
    const std::array<double, lineCountMax> delayMs{
        29.7, 37.1, 41.1, 43.7, 47.3, 53.1, 59.1, 61.7,
        67.1, 71.9, 73.7, 79.1, 83.3, 89.7, 97.1, 101.3};
    const auto activeLines = static_cast<std::uint32_t>(lineCount);
    const double scale = static_cast<double>(maximumDelaySeconds) / 0.1013;
    const std::uint64_t earlyFrames = static_cast<std::uint64_t>(
        std::ceil(static_cast<double>(spec.sampleRate) * 0.1)) + 2U;
    const std::uint64_t headroom = static_cast<std::uint64_t>(
        std::ceil(static_cast<double>(spec.sampleRate) * 0.005)) + 8U;
    std::uint64_t payload = earlyFrames * 2U * sizeof(float);
    for (std::uint32_t line = 0; line < activeLines; ++line) {
        const auto requested = static_cast<std::uint64_t>(std::llround(
            delayMs[line] * scale * static_cast<double>(spec.sampleRate) / 1000.0));
        payload += (std::max<std::uint64_t>(requested, 16U) + headroom) * sizeof(float);
    }
    constexpr std::uint64_t maximumPayload = 16U * 1024U * 1024U;
    if (payload > maximumPayload || payload + kPrepareAllocatorAllowanceBytes >
        std::numeric_limits<std::size_t>::max()) return 0;
    return static_cast<std::size_t>(payload) + kPrepareAllocatorAllowanceBytes;
}

void FdnReverb::reset() noexcept {
    for (auto& line : delayLines_) {
        std::fill(line.begin(), line.end(), 0.0f);
    }
    std::fill(earlyLeftRing_.begin(), earlyLeftRing_.end(), 0.0f);
    std::fill(earlyRightRing_.begin(), earlyRightRing_.end(), 0.0f);
    writePositions_.fill(0);
    dampingStates_.fill(0.0f);
    earlyWritePosition_ = 0;
    modulationSine_ = 0.0;
    modulationCosine_ = 1.0;
    modulationStepSine_ = 0.0;
    modulationStepCosine_ = 1.0;
    modulationStepCountdown_ = 0;
    modulationRenormalizeCountdown_ = 0;
}

bool FdnReverb::setEarlyImpulseResponse(std::uint32_t frames, const float* ll,
                                        const float* lr, const float* rl,
                                        const float* rr) noexcept {
    if (!prepared_ || frames == 0 || frames > earlyLeftRing_.size() ||
        (ll == nullptr && lr == nullptr && rl == nullptr && rr == nullptr)) {
        return false;
    }
    std::array<EarlyTap, kMaximumEarlyTaps> taps{};
    std::uint32_t count = 0;
    for (std::uint32_t delay = 0; delay < frames; ++delay) {
        EarlyTap tap{};
        tap.delay = delay;
        tap.ll = ll == nullptr ? 0.0f : clean(ll[delay]);
        tap.lr = lr == nullptr ? 0.0f : clean(lr[delay]);
        tap.rl = rl == nullptr ? 0.0f : clean(rl[delay]);
        tap.rr = rr == nullptr ? 0.0f : clean(rr[delay]);
        if (tap.ll == 0.0f && tap.lr == 0.0f && tap.rl == 0.0f && tap.rr == 0.0f) {
            continue;
        }
        if (count == kMaximumEarlyTaps) {
            return false;
        }
        taps[count++] = tap;
    }
    earlyTaps_ = taps;
    earlyTapCount_ = count;
    return true;
}

bool FdnReverb::setParameters(float rt60Seconds, float dampingHz, float modulationRateHz,
                              float modulationDepthMs, float maximumFeedback,
                              float wet, float smoothingMs) noexcept {
    if (!prepared_ || !finite(rt60Seconds) || !finite(dampingHz) || !finite(modulationRateHz) ||
        !finite(modulationDepthMs) || !finite(maximumFeedback) || !finite(wet) ||
        !finite(smoothingMs) || smoothingMs < 0.0f) {
        return false;
    }
    targetRt60_ = std::clamp(rt60Seconds, 0.1f, 20.0f);
    targetDampingHz_ = std::clamp(dampingHz, 50.0f, spec_.sampleRate * 0.49f);
    targetModRateHz_ = std::clamp(modulationRateHz, 0.0f, 8.0f);
    targetModDepthMs_ = std::clamp(modulationDepthMs, 0.0f, 5.0f);
    targetMaximumFeedback_ = std::clamp(maximumFeedback, 0.0f, 0.9995f);
    targetWet_ = std::clamp(wet, 0.0f, 1.0f);
    parameterSmoothingCoefficient_ = smoothingMs <= 0.0f
        ? 1.0f
        : static_cast<float>(1.0 - std::exp(-1.0 / (smoothingMs * 0.001 * spec_.sampleRate)));
    targetDampingCoefficient_ = static_cast<float>(1.0 - std::exp(-kTwoPi * targetDampingHz_ / spec_.sampleRate));
    for (std::uint32_t line = 0; line < activeLines_; ++line) {
        const double delaySeconds = static_cast<double>(delayLengths_[line]) / spec_.sampleRate;
        targetFeedback_[line] = std::min(targetMaximumFeedback_,
            static_cast<float>(std::pow(10.0, -3.0 * delaySeconds / targetRt60_)));
    }
    return true;
}

float FdnReverb::readRing(const std::vector<float>& ring, std::uint32_t write,
                          std::int64_t offset) const noexcept {
    if (ring.empty()) {
        return 0.0f;
    }
    return ring[wrapIndex(static_cast<std::int64_t>(write) + offset,
                          static_cast<std::uint32_t>(ring.size()))];
}

float FdnReverb::readModulated(std::uint32_t line, double delay) const noexcept {
    const auto& ring = delayLines_[line];
    if (ring.empty()) {
        return 0.0f;
    }
    const double clampedDelay = std::clamp(delay, 4.0,
        static_cast<double>(delayLines_[line].size()) - 4.0);
    const double position = static_cast<double>(writePositions_[line]) - clampedDelay;
    const auto base = static_cast<std::int64_t>(std::floor(position));
    const float phase = static_cast<float>(position - static_cast<double>(base));
    return lagrange4(readRing(ring, writePositions_[line], base - writePositions_[line] - 1),
                     readRing(ring, writePositions_[line], base - writePositions_[line]),
                     readRing(ring, writePositions_[line], base - writePositions_[line] + 1),
                     readRing(ring, writePositions_[line], base - writePositions_[line] + 2), phase);
}

void FdnReverb::updateSmoothedParameters() noexcept {
    const float coefficient = parameterSmoothingCoefficient_;
    currentRt60_ += (targetRt60_ - currentRt60_) * coefficient;
    currentDampingHz_ += (targetDampingHz_ - currentDampingHz_) * coefficient;
    currentModRateHz_ += (targetModRateHz_ - currentModRateHz_) * coefficient;
    currentModDepthMs_ += (targetModDepthMs_ - currentModDepthMs_) * coefficient;
    currentMaximumFeedback_ += (targetMaximumFeedback_ - currentMaximumFeedback_) * coefficient;
    currentWet_ += (targetWet_ - currentWet_) * coefficient;
    currentDampingCoefficient_ += (targetDampingCoefficient_ - currentDampingCoefficient_) * coefficient;
    for (std::uint32_t line = 0; line < activeLines_; ++line) {
        currentFeedback_[line] += (targetFeedback_[line] - currentFeedback_[line]) * coefficient;
    }
}

StereoFrame FdnReverb::processSample(float inputLeft, float inputRight) noexcept {
    if (!prepared_) {
        return {};
    }
    const float left = clean(inputLeft);
    const float right = clean(inputRight);
    updateSmoothedParameters();
    if (modulationStepCountdown_ == 0) {
        const double step = kTwoPi * currentModRateHz_ / spec_.sampleRate;
        modulationStepSine_ = std::sin(step);
        modulationStepCosine_ = std::cos(step);
        modulationStepCountdown_ = 31;
    } else {
        --modulationStepCountdown_;
    }
    const auto earlyWrite = earlyWritePosition_;
    earlyLeftRing_[earlyWrite] = left;
    earlyRightRing_[earlyWrite] = right;
    double earlyLeft = 0.0;
    double earlyRight = 0.0;
    for (std::uint32_t tapIndex = 0; tapIndex < earlyTapCount_; ++tapIndex) {
        const auto& tap = earlyTaps_[tapIndex];
        const auto delay = static_cast<std::int64_t>(tap.delay);
        const float xLeft = readRing(earlyLeftRing_, earlyWrite, -delay);
        const float xRight = readRing(earlyRightRing_, earlyWrite, -delay);
        earlyLeft += tap.ll * xLeft + tap.lr * xRight;
        earlyRight += tap.rl * xLeft + tap.rr * xRight;
    }
    earlyWritePosition_ = (earlyWritePosition_ + 1) % static_cast<std::uint32_t>(earlyLeftRing_.size());

    std::array<float, 16> delayed{};
    for (std::uint32_t line = 0; line < activeLines_; ++line) {
        const double modulationSine = modulationSine_ * modPhaseOffsetCos_[line] +
                                       modulationCosine_ * modPhaseOffsetSin_[line];
        const double modulationSamples = currentModDepthMs_ * 0.001 * spec_.sampleRate * modulationSine;
        const float raw = readModulated(line, static_cast<double>(delayLengths_[line]) + modulationSamples);
        const float state = dampingStates_[line] + currentDampingCoefficient_ * (raw - dampingStates_[line]);
        dampingStates_[line] = clean(state);
        delayed[line] = dampingStates_[line];
    }

    std::array<float, 16> feedback = delayed;
    (void)normalizedHadamard(feedback.data(), activeLines_); // One normalization after all stages.
    const float normalization = 1.0f / std::sqrt(static_cast<float>(activeLines_));
    double tailLeft = 0.0;
    double tailRight = 0.0;
    for (std::uint32_t line = 0; line < activeLines_; ++line) {
        const float injectionLeft = (line & 1U) == 0 ? 1.0f : -1.0f;
        const float injectionRight = (line & 2U) == 0 ? 1.0f : -1.0f;
        const float input = (left * injectionLeft + right * injectionRight) * (0.5f * normalization);
        const float write = clean(input + currentFeedback_[line] * feedback[line]);
        auto& ring = delayLines_[line];
        ring[writePositions_[line]] = write;
        writePositions_[line] = (writePositions_[line] + 1) % static_cast<std::uint32_t>(ring.size());

        const float outputLeftSign = (line & 1U) == 0 ? 1.0f : -1.0f;
        const float outputRightSign = (line & 2U) == 0 ? 1.0f : -1.0f;
        tailLeft += delayed[line] * outputLeftSign * normalization;
        tailRight += delayed[line] * outputRightSign * normalization;
    }
    const double nextSine = modulationSine_ * modulationStepCosine_ +
                            modulationCosine_ * modulationStepSine_;
    const double nextCosine = modulationCosine_ * modulationStepCosine_ -
                              modulationSine_ * modulationStepSine_;
    modulationSine_ = nextSine;
    modulationCosine_ = nextCosine;
    if (++modulationRenormalizeCountdown_ >= 256) {
        const double magnitude = std::sqrt(modulationSine_ * modulationSine_ +
                                           modulationCosine_ * modulationCosine_);
        if (magnitude > 1.0e-12) {
            modulationSine_ /= magnitude;
            modulationCosine_ /= magnitude;
        }
        modulationRenormalizeCountdown_ = 0;
    }
    const float wet = std::clamp(currentWet_, 0.0f, 1.0f);
    return {
        clean((1.0f - wet) * left + wet * (static_cast<float>(earlyLeft) + 0.55f * static_cast<float>(tailLeft))),
        clean((1.0f - wet) * right + wet * (static_cast<float>(earlyRight) + 0.55f * static_cast<float>(tailRight)))
    };
}

bool FdnReverb::processBlock(const float* inputLeft, const float* inputRight,
                             float* outputLeft, float* outputRight,
                             std::uint32_t frames) noexcept {
    if (!prepared_ || inputLeft == nullptr || inputRight == nullptr || outputLeft == nullptr ||
        outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto output = processSample(inputLeft[i], inputRight[i]);
        outputLeft[i] = output.left;
        outputRight[i] = output.right;
    }
    return true;
}

bool GranularTexture::prepare(const ProcessSpec& spec, float captureSeconds) {
    prepared_ = false;
    if (!validSpec(spec) || !finite(captureSeconds) || captureSeconds < 0.1f || captureSeconds > 10.0f) {
        return false;
    }
    if (requiredPrepareBytes(spec, captureSeconds) == 0) return false;
    const auto capacity = static_cast<std::size_t>(std::ceil(spec.sampleRate * captureSeconds));
    constexpr std::size_t kMaximumCaptureBytes = 16U * 1024U * 1024U;
    if (capacity < 512 || capacity > static_cast<std::size_t>(spec.sampleRate) * 10U ||
        capacity > kMaximumCaptureBytes / (2U * sizeof(float))) {
        return false;
    }
    WEBRC_DSP_TRY {
        captureLeft_.assign(capacity, 0.0f);
        captureRight_.assign(capacity, 0.0f);
    } WEBRC_DSP_CATCH_BAD_ALLOC {
        captureLeft_.clear();
        captureRight_.clear();
        return false;
    }
    spec_ = spec;
    prepared_ = true;
    grainFrames_ = std::min<std::uint32_t>(2400, static_cast<std::uint32_t>(capacity / 4));
    reset();
    return true;
}

std::size_t GranularTexture::requiredPrepareBytes(const ProcessSpec& spec,
                                                  float captureSeconds) noexcept {
    if (!validSpec(spec) || !finite(captureSeconds) || captureSeconds < 0.1f || captureSeconds > 10.0f) {
        return 0;
    }
    const auto capacity = static_cast<std::uint64_t>(std::ceil(spec.sampleRate * captureSeconds));
    constexpr std::uint64_t maximumPayload = 16U * 1024U * 1024U;
    const std::uint64_t payload = capacity * 2U * sizeof(float);
    if (capacity < 512 || capacity > static_cast<std::uint64_t>(spec.sampleRate) * 10U ||
        payload > maximumPayload) return 0;
    return static_cast<std::size_t>(payload) + kPrepareAllocatorAllowanceBytes;
}

void GranularTexture::reset() noexcept {
    std::fill(captureLeft_.begin(), captureLeft_.end(), 0.0f);
    std::fill(captureRight_.begin(), captureRight_.end(), 0.0f);
    grains_.fill(Grain{});
    captureWrite_ = 0;
    capturedFrames_ = 0;
    densityPhase_ = 0.0;
    randomState_ = seed_ == 0 ? 0x9e3779b97f4a7c15ULL : seed_;
}

bool GranularTexture::setParameters(float grainMs, float densityHz, float pitchRatio,
                                    float positionSpread, float mix, std::uint64_t seed) noexcept {
    if (!prepared_ || !finite(grainMs) || !finite(densityHz) || !finite(pitchRatio) ||
        !finite(positionSpread) || !finite(mix)) {
        return false;
    }
    const auto capacity = static_cast<std::uint32_t>(captureLeft_.size());
    const auto requested = static_cast<std::uint32_t>(std::lround(
        std::clamp(grainMs, 5.0f, 1000.0f) * spec_.sampleRate / 1000.0f));
    grainFrames_ = std::clamp<std::uint32_t>(requested, 32, std::max<std::uint32_t>(32, capacity / 4));
    densityHz_ = std::clamp(static_cast<double>(densityHz), 0.0,
                            std::min(200.0, static_cast<double>(spec_.sampleRate) * 0.25));
    pitchRatio_ = std::clamp(static_cast<double>(pitchRatio), 0.25, 4.0);
    positionSpread_ = std::clamp(positionSpread, 0.0f, 1.0f);
    mix_ = std::clamp(mix, 0.0f, 1.0f);
    seed_ = seed;
    randomState_ = seed_ == 0 ? 0x9e3779b97f4a7c15ULL : seed_;
    return true;
}

std::uint32_t GranularTexture::randomU32() noexcept {
    std::uint64_t value = randomState_;
    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    randomState_ = value;
    return static_cast<std::uint32_t>((value * 0x2545f4914f6cdd1dULL) >> 32);
}

float GranularTexture::randomUnit() noexcept {
    return static_cast<float>(randomU32() >> 8) * (1.0f / 16777216.0f);
}

void GranularTexture::spawnGrain() noexcept {
    if (captureLeft_.empty()) {
        return;
    }
    std::uint32_t slot = static_cast<std::uint32_t>(grains_.size());
    std::uint32_t oldestAge = 0;
    for (std::uint32_t i = 0; i < grains_.size(); ++i) {
        if (!grains_[i].active) {
            slot = i;
            break;
        }
        if (grains_[i].age >= oldestAge) {
            oldestAge = grains_[i].age;
            slot = i;
        }
    }
    const std::uint32_t length = std::min<std::uint32_t>(
        grainFrames_, static_cast<std::uint32_t>(captureLeft_.size() / 4));
    const std::uint64_t available = std::min<std::uint64_t>(capturedFrames_, captureLeft_.size());
    const std::uint32_t minimumOffset = static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(length) * std::max(1.0, pitchRatio_))) + 4;
    if (length < 32 || available <= minimumOffset + 4) {
        return;
    }
    const std::uint32_t extra = static_cast<std::uint32_t>(available) - minimumOffset - 4;
    const std::uint32_t spread = static_cast<std::uint32_t>(extra * positionSpread_ * randomUnit());
    const std::uint32_t behind = std::min<std::uint32_t>(minimumOffset + spread,
                                                         static_cast<std::uint32_t>(available) - 4);
    const auto capacity = static_cast<double>(captureLeft_.size());
    double start = static_cast<double>(captureWrite_) - 1.0 - behind;
    start -= std::floor(start / capacity) * capacity;
    const float pan = (randomUnit() * 2.0f - 1.0f) * positionSpread_;
    grains_[slot] = {start, pitchRatio_, 0, length, pan, true};
}

float GranularTexture::readCapture(const std::vector<float>& data, double position) const noexcept {
    if (data.empty()) {
        return 0.0f;
    }
    const double capacity = static_cast<double>(data.size());
    position -= std::floor(position / capacity) * capacity;
    const auto base = static_cast<std::int64_t>(std::floor(position));
    const float phase = static_cast<float>(position - static_cast<double>(base));
    const auto at = [&data](std::int64_t index) {
        return data[wrapIndex(index, static_cast<std::uint32_t>(data.size()))];
    };
    return lagrange4(at(base - 1), at(base), at(base + 1), at(base + 2), phase);
}

StereoFrame GranularTexture::processSample(float inputLeft, float inputRight) noexcept {
    if (!prepared_) {
        return {};
    }
    const float left = clean(inputLeft);
    const float right = clean(inputRight);
    captureLeft_[captureWrite_] = left;
    captureRight_[captureWrite_] = right;
    captureWrite_ = (captureWrite_ + 1) % static_cast<std::uint32_t>(captureLeft_.size());
    ++capturedFrames_;

    densityPhase_ += densityHz_ / spec_.sampleRate;
    if (densityPhase_ >= 1.0) {
        densityPhase_ -= std::floor(densityPhase_);
        spawnGrain();
    }

    double cloudLeft = 0.0;
    double cloudRight = 0.0;
    double windowSum = 0.0;
    for (auto& grain : grains_) {
        if (!grain.active || grain.length == 0) {
            continue;
        }
        const double phase = grain.length <= 1 ? 0.0 :
            static_cast<double>(grain.age) / static_cast<double>(grain.length - 1);
        const float window = static_cast<float>(0.5 - 0.5 * std::cos(kTwoPi * phase));
        const float panAngle = static_cast<float>((static_cast<double>(grain.pan) + 1.0) * kPi * 0.25);
        const float gainLeft = std::cos(panAngle);
        const float gainRight = std::sin(panAngle);
        cloudLeft += readCapture(captureLeft_, grain.readPosition) * window * gainLeft;
        cloudRight += readCapture(captureRight_, grain.readPosition) * window * gainRight;
        windowSum += window;
        grain.readPosition += grain.readStep;
        grain.readPosition -= std::floor(grain.readPosition / captureLeft_.size()) * captureLeft_.size();
        ++grain.age;
        if (grain.age >= grain.length) {
            grain.active = false;
        }
    }
    const double cloudNormalization = std::max(1.0, windowSum);
    cloudLeft /= cloudNormalization;
    cloudRight /= cloudNormalization;
    const float dryGain = static_cast<float>(std::cos(static_cast<double>(mix_) * kPi * 0.5));
    const float wetGain = static_cast<float>(std::sin(static_cast<double>(mix_) * kPi * 0.5));
    return {clean(dryGain * left + wetGain * static_cast<float>(cloudLeft)),
            clean(dryGain * right + wetGain * static_cast<float>(cloudRight))};
}

std::uint32_t GranularTexture::activeGrains() const noexcept {
    std::uint32_t count = 0;
    for (const auto& grain : grains_) {
        count += grain.active ? 1U : 0U;
    }
    return count;
}

bool GranularTexture::processBlock(const float* inputLeft, const float* inputRight,
                                  float* outputLeft, float* outputRight,
                                  std::uint32_t frames) noexcept {
    if (!prepared_ || inputLeft == nullptr || inputRight == nullptr || outputLeft == nullptr ||
        outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto output = processSample(inputLeft[i], inputRight[i]);
        outputLeft[i] = output.left;
        outputRight[i] = output.right;
    }
    return true;
}

bool SpectralFreeze::prepare(const ProcessSpec& spec, std::uint32_t windowFrames,
                             std::uint32_t hopFrames) {
    prepared_ = false;
    if (!validSpec(spec) || !fft::isPowerOfTwo(windowFrames) || windowFrames < 256 ||
        windowFrames > 4096 || hopFrames == 0 || hopFrames > windowFrames / 2 ||
        windowFrames % hopFrames != 0 || windowFrames / hopFrames < 2 ||
        windowFrames / hopFrames > 8) {
        return false;
    }
    if (requiredPrepareBytes(spec, windowFrames, hopFrames) == 0) return false;
    const std::uint32_t bins = windowFrames / 2 + 1;
    WEBRC_DSP_TRY {
        window_.resize(windowFrames);
        olaNormalization_.assign(hopFrames, 0.0f);
        outputRingFrames_ = windowFrames * 2;
        for (std::uint32_t i = 0; i < windowFrames; ++i) {
            window_[i] = static_cast<float>(0.5 - 0.5 *
                std::cos(kTwoPi * static_cast<double>(i) / windowFrames));
            olaNormalization_[i % hopFrames] += window_[i] * window_[i];
        }
        for (auto& value : olaNormalization_) {
            value = value > 1.0e-12f ? 1.0f / value : 0.0f;
        }
        for (auto& channel : channels_) {
            channel.inputRing.assign(windowFrames, 0.0f);
            channel.outputOverlap.assign(outputRingFrames_, 0.0f);
            channel.delayedDry.assign(outputRingFrames_, 0.0f);
            channel.spectrum.assign(windowFrames, {0.0f, 0.0f});
            channel.frozenSpectrum.assign(windowFrames, {0.0f, 0.0f});
            channel.magnitude.assign(bins, 0.0f);
            channel.frozenMagnitude.assign(bins, 0.0f);
            channel.phase.assign(bins, 0.0f);
            channel.previousPhase.assign(bins, 0.0f);
            channel.frozenPhase.assign(bins, 0.0f);
            channel.frozenPhaseOffset.assign(bins, 0.0f);
            channel.phaseAdvance.assign(bins, 0.0f);
            channel.frozenOmega.assign(bins, 0.0f);
            channel.peakOwner.assign(bins, 0);
            channel.peakList.assign(bins, 0);
            channel.scratch.assign(windowFrames, 0.0f);
        }
    } WEBRC_DSP_CATCH_BAD_ALLOC {
        reset();
        return false;
    }
    spec_ = spec;
    windowFrames_ = windowFrames;
    hopFrames_ = hopFrames;
    overlapFrames_ = windowFrames / hopFrames;
    prepared_ = true;
    reset();
    return true;
}

std::size_t SpectralFreeze::requiredPrepareBytes(const ProcessSpec& spec,
                                                 std::uint32_t windowFrames,
                                                 std::uint32_t hopFrames) noexcept {
    if (!validSpec(spec) || !fft::isPowerOfTwo(windowFrames) || windowFrames < 256 ||
        windowFrames > 4096 || hopFrames == 0 || hopFrames > windowFrames / 2 ||
        windowFrames % hopFrames != 0 || windowFrames / hopFrames < 2 ||
        windowFrames / hopFrames > 8) return 0;
    const std::uint64_t bins = windowFrames / 2U + 1U;
    const std::uint64_t perChannel = 6U * windowFrames * sizeof(float) +
        2U * windowFrames * sizeof(std::complex<float>) +
        bins * (8U * sizeof(float) + 2U * sizeof(std::uint32_t));
    const std::uint64_t payload = static_cast<std::uint64_t>(windowFrames + hopFrames) * sizeof(float) +
        2U * perChannel;
    constexpr std::uint64_t maximumPayload = 2U * 1024U * 1024U;
    if (payload > maximumPayload) return 0;
    return static_cast<std::size_t>(payload) + kPrepareAllocatorAllowanceBytes;
}

void SpectralFreeze::reset() noexcept {
    for (auto& channel : channels_) {
        std::fill(channel.inputRing.begin(), channel.inputRing.end(), 0.0f);
        std::fill(channel.outputOverlap.begin(), channel.outputOverlap.end(), 0.0f);
        std::fill(channel.delayedDry.begin(), channel.delayedDry.end(), 0.0f);
        std::fill(channel.spectrum.begin(), channel.spectrum.end(), std::complex<float>{0.0f, 0.0f});
        std::fill(channel.frozenSpectrum.begin(), channel.frozenSpectrum.end(), std::complex<float>{0.0f, 0.0f});
        std::fill(channel.magnitude.begin(), channel.magnitude.end(), 0.0f);
        std::fill(channel.frozenMagnitude.begin(), channel.frozenMagnitude.end(), 0.0f);
        std::fill(channel.phase.begin(), channel.phase.end(), 0.0f);
        std::fill(channel.previousPhase.begin(), channel.previousPhase.end(), 0.0f);
        std::fill(channel.frozenPhase.begin(), channel.frozenPhase.end(), 0.0f);
        std::fill(channel.frozenPhaseOffset.begin(), channel.frozenPhaseOffset.end(), 0.0f);
        std::fill(channel.phaseAdvance.begin(), channel.phaseAdvance.end(), 0.0f);
        std::fill(channel.frozenOmega.begin(), channel.frozenOmega.end(), 0.0f);
        std::fill(channel.peakOwner.begin(), channel.peakOwner.end(), 0U);
        std::fill(channel.peakList.begin(), channel.peakList.end(), 0U);
        std::fill(channel.scratch.begin(), channel.scratch.end(), 0.0f);
        channel.hasAnalysisFrame = false;
        channel.hasPhaseAdvance = false;
    }
    sampleCounter_ = 0;
    windowWrite_ = 0;
    capturePending_ = freezeRequested_;
}

bool SpectralFreeze::setFreeze(bool freeze) noexcept {
    if (!prepared_) {
        return false;
    }
    if (freeze && !freezeRequested_) {
        // Capture the last complete analysis frame at the control event. If we
        // waited for the next hop, an input that stops on the freeze event
        // would contaminate that frame with silence and shift off-bin pitch.
        if (channels_[0].hasPhaseAdvance && channels_[1].hasPhaseAdvance) {
            captureFrozenState(channels_[0]);
            captureFrozenState(channels_[1]);
            capturePending_ = false;
        } else {
            capturePending_ = true;
        }
    }
    freezeRequested_ = freeze;
    if (!freeze) capturePending_ = false;
    return true;
}

bool SpectralFreeze::setMix(float mix) noexcept {
    if (!prepared_ || !finite(mix)) {
        return false;
    }
    mix_ = std::clamp(mix, 0.0f, 1.0f);
    return true;
}

float SpectralFreeze::ringSample(const std::vector<float>& ring,
                                 std::int64_t absoluteIndex) const noexcept {
    if (ring.empty() || absoluteIndex < 0) {
        return 0.0f;
    }
    return ring[wrapIndex(absoluteIndex, static_cast<std::uint32_t>(ring.size()))];
}

void SpectralFreeze::captureFrozenState(ChannelState& channel) noexcept {
    const std::uint32_t bins = windowFrames_ / 2 + 1;
    std::uint32_t peakCount = 0;
    for (std::uint32_t bin = 0; bin < bins; ++bin) {
        channel.frozenMagnitude[bin] = channel.magnitude[bin];
        channel.frozenPhase[bin] = channel.phase[bin];
        // phaseAdvance was computed from this frame and the preceding complete
        // frame before previousPhase was refreshed. Keep its rad/hop value so
        // a freeze event can snapshot the latest full frame without observing
        // a zero phase difference or analyzing post-event silence.
        channel.frozenOmega[bin] = channel.phaseAdvance[bin];
        channel.frozenSpectrum[bin] = channel.spectrum[bin];
        const float before = bin == 0 ? channel.magnitude[bin] : channel.magnitude[bin - 1];
        const float after = bin + 1 >= bins ? channel.magnitude[bin] : channel.magnitude[bin + 1];
        if (channel.magnitude[bin] >= before && channel.magnitude[bin] >= after) {
            channel.peakList[peakCount++] = bin;
        }
    }
    if (peakCount == 0) {
        channel.peakList[0] = 0;
        peakCount = 1;
    }
    std::uint32_t activePeak = 0;
    for (std::uint32_t bin = 0; bin < bins; ++bin) {
        while (activePeak + 1 < peakCount) {
            const auto midpoint = (channel.peakList[activePeak] + channel.peakList[activePeak + 1]) / 2;
            if (bin <= midpoint) {
                break;
            }
            ++activePeak;
        }
        channel.peakOwner[bin] = channel.peakList[activePeak];
        channel.frozenPhaseOffset[bin] = channel.phase[bin] - channel.phase[channel.peakList[activePeak]];
    }
}

void SpectralFreeze::processFrame(ChannelState& channel, std::uint32_t channelIndex,
                                  std::uint64_t frameEnd) noexcept {
    const bool hasPriorAnalysis = channel.hasAnalysisFrame;
    const std::int64_t frameStart = static_cast<std::int64_t>(frameEnd + 1) - windowFrames_;
    for (std::uint32_t i = 0; i < windowFrames_; ++i) {
        const float input = ringSample(channel.inputRing, frameStart + i);
        channel.spectrum[i] = {clean(input * window_[i]), 0.0f};
    }
    (void)fft::transform(channel.spectrum.data(), channel.spectrum.size(), fft::Direction::Forward);
    const std::uint32_t bins = windowFrames_ / 2 + 1;
    for (std::uint32_t bin = 0; bin < bins; ++bin) {
        const auto value = channel.spectrum[bin];
        channel.magnitude[bin] = std::hypot(value.real(), value.imag());
        channel.phase[bin] = std::atan2(value.imag(), value.real());
        const double expected = kTwoPi * static_cast<double>(bin) * hopFrames_ / windowFrames_;
        const double residual = hasPriorAnalysis ? std::remainder(
            static_cast<double>(channel.phase[bin]) - channel.previousPhase[bin] - expected,
            kTwoPi) : 0.0;
        channel.phaseAdvance[bin] = static_cast<float>(expected + residual);
    }

    const bool captureThisFrame = capturePending_;
    if (captureThisFrame) {
        captureFrozenState(channel);
    }
    if (freezeRequested_ && !channel.peakList.empty()) {
        if (!captureThisFrame) {
            for (std::uint32_t index = 0; index < bins; ++index) {
                const auto owner = channel.peakOwner[index];
                if (owner == index) {
                    channel.frozenPhase[index] = static_cast<float>(std::remainder(
                        channel.frozenPhase[index] + channel.frozenOmega[index], kTwoPi));
                }
            }
        }
        for (std::uint32_t bin = 0; bin < bins; ++bin) {
            const auto owner = channel.peakOwner[bin];
            const float phase = channel.frozenPhase[owner] + channel.frozenPhaseOffset[bin];
            const float magnitude = channel.frozenMagnitude[bin];
            channel.spectrum[bin] = {magnitude * std::cos(phase), magnitude * std::sin(phase)};
        }
        channel.spectrum[0].imag(0.0f);
        channel.spectrum[windowFrames_ / 2].imag(0.0f);
        for (std::uint32_t bin = 1; bin < windowFrames_ / 2; ++bin) {
            channel.spectrum[windowFrames_ - bin] = std::conj(channel.spectrum[bin]);
        }
    }

    (void)fft::transform(channel.spectrum.data(), channel.spectrum.size(), fft::Direction::Inverse);
    for (std::uint32_t i = 0; i < windowFrames_; ++i) {
        const auto outputIndex = static_cast<std::uint32_t>((frameStart + windowFrames_ + i) % outputRingFrames_);
        const float sample = clean(channel.spectrum[i].real() * window_[i] * olaNormalization_[i % hopFrames_]);
        channel.outputOverlap[outputIndex] = clean(channel.outputOverlap[outputIndex] + sample);
    }
    std::copy(channel.phase.begin(), channel.phase.end(), channel.previousPhase.begin());
    channel.hasPhaseAdvance = hasPriorAnalysis;
    channel.hasAnalysisFrame = true;
    if (channelIndex == 1 && capturePending_) {
        capturePending_ = false;
    }
}

StereoFrame SpectralFreeze::processSample(float inputLeft, float inputRight) noexcept {
    if (!prepared_) {
        return {};
    }
    const std::array<float, 2> inputs{clean(inputLeft), clean(inputRight)};
    std::array<float, 2> outputs{};
    const auto currentPosition = static_cast<std::uint32_t>(sampleCounter_ % outputRingFrames_);
    for (std::uint32_t channelIndex = 0; channelIndex < 2; ++channelIndex) {
        auto& channel = channels_[channelIndex];
        outputs[channelIndex] = channel.outputOverlap[currentPosition];
        channel.outputOverlap[currentPosition] = 0.0f;
        const auto dryPosition = static_cast<std::uint32_t>((sampleCounter_ + windowFrames_) % outputRingFrames_);
        channel.delayedDry[dryPosition] = inputs[channelIndex];
        channel.inputRing[sampleCounter_ % windowFrames_] = inputs[channelIndex];
    }
    const std::uint64_t frameNumber = sampleCounter_ + 1;
    if (frameNumber >= hopFrames_ && frameNumber % hopFrames_ == 0) {
        processFrame(channels_[0], 0, sampleCounter_);
        processFrame(channels_[1], 1, sampleCounter_);
    }
    const float delayedLeft = channels_[0].delayedDry[currentPosition];
    const float delayedRight = channels_[1].delayedDry[currentPosition];
    channels_[0].delayedDry[currentPosition] = 0.0f;
    channels_[1].delayedDry[currentPosition] = 0.0f;
    ++sampleCounter_;
    const float dryGain = static_cast<float>(std::cos(static_cast<double>(mix_) * kPi * 0.5));
    const float wetGain = static_cast<float>(std::sin(static_cast<double>(mix_) * kPi * 0.5));
    return {clean(dryGain * delayedLeft + wetGain * outputs[0]),
            clean(dryGain * delayedRight + wetGain * outputs[1])};
}

bool SpectralFreeze::processBlock(const float* inputLeft, const float* inputRight,
                                  float* outputLeft, float* outputRight,
                                  std::uint32_t frames) noexcept {
    if (!prepared_ || inputLeft == nullptr || inputRight == nullptr || outputLeft == nullptr ||
        outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto output = processSample(inputLeft[i], inputRight[i]);
        outputLeft[i] = output.left;
        outputRight[i] = output.right;
    }
    return true;
}

bool ReverseSegment::prepare(const ProcessSpec& spec, std::uint32_t maximumSegmentFrames,
                             std::uint32_t segmentFrames, std::uint32_t crossfadeFrames) {
    prepared_ = false;
    if (!validSpec(spec) || maximumSegmentFrames < 128 ||
        maximumSegmentFrames > static_cast<std::uint32_t>(spec.sampleRate * 8.0f) ||
        segmentFrames > maximumSegmentFrames || segmentFrames < 64 ||
        crossfadeFrames > segmentFrames / 4 || segmentFrames <= crossfadeFrames * 2 + 1 ||
        (crossfadeFrames == 1)) {
        return false;
    }
    if (requiredPrepareBytes(spec, maximumSegmentFrames) == 0) return false;
    constexpr std::uint64_t kMaximumReversePayloadBytes = 16U * 1024U * 1024U;
    const auto historyFrames = static_cast<std::uint64_t>(maximumSegmentFrames) * 3U +
                               static_cast<std::uint64_t>(spec.maxBlockFrames) * 2U + 8U;
    if (historyFrames * 2U * sizeof(float) >
        kMaximumReversePayloadBytes) {
        return false;
    }
    WEBRC_DSP_TRY {
        for (auto& channel : history_) {
            channel.assign(static_cast<std::size_t>(historyFrames), 0.0f);
        }
    } WEBRC_DSP_CATCH_BAD_ALLOC {
        for (auto& channel : history_) channel.clear();
        return false;
    }
    spec_ = spec;
    maximumSegmentFrames_ = maximumSegmentFrames;
    historyFrames_ = static_cast<std::uint32_t>(historyFrames);
    segmentFrames_ = segmentFrames;
    crossfadeFrames_ = crossfadeFrames;
    initialTransitionFrames_ = std::min(kInitialTransitionFrames, segmentFrames_ - crossfadeFrames_);
    prepared_ = true;
    reset();
    return true;
}

std::size_t ReverseSegment::requiredPrepareBytes(const ProcessSpec& spec,
                                                 std::uint32_t maximumSegmentFrames) noexcept {
    if (!validSpec(spec) || maximumSegmentFrames < 128 ||
        maximumSegmentFrames > static_cast<std::uint32_t>(spec.sampleRate * 8.0f)) return 0;
    const std::uint64_t frames = static_cast<std::uint64_t>(maximumSegmentFrames) * 3U +
                                 static_cast<std::uint64_t>(spec.maxBlockFrames) * 2U + 8U;
    const std::uint64_t payload = frames * 2U * sizeof(float);
    constexpr std::uint64_t maximumPayload = 16U * 1024U * 1024U;
    if (payload > maximumPayload) return 0;
    return static_cast<std::size_t>(payload) + kPrepareAllocatorAllowanceBytes;
}

void ReverseSegment::reset() noexcept {
    for (auto& channel : history_) std::fill(channel.begin(), channel.end(), 0.0f);
    inputFrames_ = 0;
    initialTransitionPosition_ = 0;
}

bool ReverseSegment::setSegment(std::uint32_t segmentFrames,
                                std::uint32_t crossfadeFrames) noexcept {
    if (!prepared_ || inputFrames_ != 0 || segmentFrames < 64 ||
        segmentFrames > maximumSegmentFrames_ || crossfadeFrames > segmentFrames / 4 ||
        segmentFrames <= crossfadeFrames * 2 + 1 || crossfadeFrames == 1) {
        return false;
    }
    segmentFrames_ = segmentFrames;
    crossfadeFrames_ = crossfadeFrames;
    initialTransitionFrames_ = std::min(kInitialTransitionFrames, segmentFrames_ - crossfadeFrames_);
    return true;
}

float ReverseSegment::readHistory(const std::vector<float>& history,
                                 std::uint64_t absoluteFrame) const noexcept {
    if (history.empty()) {
        return 0.0f;
    }
    return history[static_cast<std::size_t>(absoluteFrame % history.size())];
}

StereoFrame ReverseSegment::processSample(float inputLeft, float inputRight) noexcept {
    if (!prepared_) {
        return {};
    }
    const float left = clean(inputLeft);
    const float right = clean(inputRight);
    StereoFrame output{left, right};
    const auto inputPosition = inputFrames_ % historyFrames_;
    history_[0][static_cast<std::size_t>(inputPosition)] = left;
    history_[1][static_cast<std::size_t>(inputPosition)] = right;

    const std::uint64_t latency = static_cast<std::uint64_t>(2U) * segmentFrames_ - crossfadeFrames_;
    if (inputFrames_ >= latency) {
        const std::uint64_t elapsed = inputFrames_ - latency;
        const std::uint64_t stride = segmentFrames_ - crossfadeFrames_;
        std::uint64_t segmentNumber = 0;
        std::uint32_t position = 0;
        if (elapsed < segmentFrames_) {
            position = static_cast<std::uint32_t>(elapsed);
        } else {
            const std::uint64_t afterFirst = elapsed - segmentFrames_;
            segmentNumber = 1U + afterFirst / stride;
            position = crossfadeFrames_ + static_cast<std::uint32_t>(afterFirst % stride);
        }
        const std::uint64_t segmentStart = segmentNumber * stride;
        const std::uint64_t sourceA = segmentStart + segmentFrames_ - 1U - position;
        float resultLeft = readHistory(history_[0], sourceA);
        float resultRight = readHistory(history_[1], sourceA);
        if (crossfadeFrames_ >= 2 && position >= segmentFrames_ - crossfadeFrames_) {
            const std::uint32_t fadePosition = position - (segmentFrames_ - crossfadeFrames_);
            const double u = static_cast<double>(fadePosition) / (crossfadeFrames_ - 1U);
            const float gainA = static_cast<float>(std::cos(kPi * u * 0.5));
            const float gainB = static_cast<float>(std::sin(kPi * u * 0.5));
            const std::uint64_t nextStart = (segmentNumber + 1U) * stride;
            const std::uint64_t sourceB = nextStart + segmentFrames_ - 1U - fadePosition;
            resultLeft = gainA * resultLeft + gainB * readHistory(history_[0], sourceB);
            resultRight = gainA * resultRight + gainB * readHistory(history_[1], sourceB);
        }
        if (initialTransitionPosition_ < initialTransitionFrames_) {
            const double u = initialTransitionFrames_ <= 1U ? 1.0 :
                static_cast<double>(initialTransitionPosition_) / (initialTransitionFrames_ - 1U);
            const float liveGain = static_cast<float>(std::cos(kPi * u * 0.5));
            const float reverseGain = static_cast<float>(std::sin(kPi * u * 0.5));
            resultLeft = liveGain * left + reverseGain * resultLeft;
            resultRight = liveGain * right + reverseGain * resultRight;
            ++initialTransitionPosition_;
        }
        output = {clean(resultLeft), clean(resultRight)};
    }
    ++inputFrames_;
    return output;
}

bool ReverseSegment::processBlock(const float* inputLeft, const float* inputRight,
                                 float* outputLeft, float* outputRight,
                                 std::uint32_t frames) noexcept {
    if (!prepared_ || inputLeft == nullptr || inputRight == nullptr || outputLeft == nullptr ||
        outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto output = processSample(inputLeft[i], inputRight[i]);
        outputLeft[i] = output.left;
        outputRight[i] = output.right;
    }
    return true;
}

bool PlatterInertia::prepare(const ProcessSpec& spec) noexcept {
    prepared_ = validSpec(spec, false);
    if (prepared_) {
        spec_ = spec;
        sampleRate_ = spec.sampleRate;
        reset();
    }
    return prepared_;
}

void PlatterInertia::reset(float speedRatio) noexcept {
    speedRatio_ = finite(speedRatio) ? std::clamp(speedRatio, -4.0f, 4.0f) : 1.0f;
    targetSpeedRatio_ = speedRatio_;
    velocity_ = 0.0f;
    acceleration_ = 0.0f;
    phaseCycles_ = 0.0;
}

bool PlatterInertia::setTargetSpeed(float speedRatio) noexcept {
    if (!prepared_ || !finite(speedRatio)) {
        return false;
    }
    targetSpeedRatio_ = std::clamp(speedRatio, -4.0f, 4.0f);
    return true;
}

bool PlatterInertia::setInertia(float naturalFrequencyHz, float dampingRatio) noexcept {
    if (!prepared_ || !finite(naturalFrequencyHz) || !finite(dampingRatio)) {
        return false;
    }
    naturalFrequencyHz_ = std::clamp(naturalFrequencyHz, 0.1f, 20.0f);
    dampingRatio_ = std::clamp(dampingRatio, 0.1f, 4.0f);
    return true;
}

float PlatterInertia::nextSpeedRatio() noexcept {
    if (!prepared_) {
        return 0.0f;
    }
    const double omega = kTwoPi * naturalFrequencyHz_;
    const double dt = 1.0 / sampleRate_;
    const double acceleration = omega * omega * (targetSpeedRatio_ - speedRatio_) -
        2.0 * dampingRatio_ * omega * velocity_;
    acceleration_ = clean(static_cast<float>(acceleration));
    velocity_ = clean(static_cast<float>(velocity_ + acceleration * dt));
    speedRatio_ = clean(static_cast<float>(speedRatio_ + velocity_ * dt));
    if (speedRatio_ > 4.0f || speedRatio_ < -4.0f) {
        speedRatio_ = std::clamp(speedRatio_, -4.0f, 4.0f);
        velocity_ = 0.0f;
    }
    phaseCycles_ += static_cast<double>(speedRatio_) / sampleRate_;
    phaseCycles_ -= std::floor(phaseCycles_);
    return speedRatio_;
}

double PlatterInertia::nextPhaseCycles() noexcept {
    (void)nextSpeedRatio();
    return phaseCycles_;
}

bool PlatterInertia::processBlock(float* speedRatios, double* phaseCycles,
                                  float* accelerations, std::uint32_t frames) noexcept {
    if (!prepared_ || speedRatios == nullptr || phaseCycles == nullptr || accelerations == nullptr ||
        frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        speedRatios[i] = nextSpeedRatio();
        phaseCycles[i] = phaseCycles_;
        accelerations[i] = acceleration_;
    }
    return true;
}

bool DrumModalVoice::prepare(const ProcessSpec& spec) noexcept {
    if (!validSpec(spec, false)) {
        prepared_ = false;
        return false;
    }
    spec_ = spec;
    sampleRate_ = spec.sampleRate;
    prepared_ = true;
    reset();
    return true;
}

void DrumModalVoice::reset() noexcept {
    coefficient1_.fill(0.0);
    coefficient2_.fill(0.0);
    modalY1_.fill(0.0);
    modalY2_.fill(0.0);
    modalWeights_.fill(0.0f);
    modalPan_.fill(0.0f);
    noiseEnvelope_ = 0.0;
    noiseDecayCoefficient_ = 0.0;
    noiseLevel_ = 0.0f;
    amplitude_ = 0.0f;
    stereoWidth_ = 0.0f;
    active_ = false;
}

bool DrumModalVoice::trigger(const DrumVoiceParameters& parameters) noexcept {
    if (!prepared_ || !finite(parameters.fundamentalHz) || !finite(parameters.decaySeconds) ||
        !finite(parameters.tone) || !finite(parameters.noise) || !finite(parameters.amplitude) ||
        !finite(parameters.stereoWidth)) {
        return false;
    }
    constexpr std::array<double, kModalCount> ratios{
        1.0, 1.593, 2.135, 2.643, 3.157, 3.827, 4.773, 5.911};
    const double fundamental = std::clamp(static_cast<double>(parameters.fundamentalHz),
                                          20.0, std::min(12000.0, sampleRate_ * 0.44));
    const double decay = std::clamp(static_cast<double>(parameters.decaySeconds), 0.02, 12.0);
    const float tone = std::clamp(parameters.tone, 0.0f, 1.0f);
    amplitude_ = std::clamp(parameters.amplitude, 0.0f, 1.0f);
    noiseLevel_ = std::clamp(parameters.noise, 0.0f, 1.0f);
    const float width = std::clamp(parameters.stereoWidth, 0.0f, 1.0f);
    stereoWidth_ = width;
    randomState_ = parameters.seed == 0 ? 1 : parameters.seed;
    for (std::size_t mode = 0; mode < kModalCount; ++mode) {
        const double frequency = std::min(fundamental * ratios[mode] * (1.0 + (tone - 0.5) * 0.04 * mode),
                                          sampleRate_ * 0.45);
        const double radius = std::exp(-6.907755278982137 / (decay * sampleRate_));
        const double angle = kTwoPi * frequency / sampleRate_;
        coefficient1_[mode] = 2.0 * radius * std::cos(angle);
        coefficient2_[mode] = -radius * radius;
        // Damped sinusoid initial conditions, normalized to a peak near 1
        // independent of low-frequency sin(angle) gain.
        modalY1_[mode] = 0.0;
        modalY2_[mode] = -std::sin(angle) / (radius * radius);
        const double spectralTilt = std::exp(-static_cast<double>(mode) * (0.45 + 1.8 * (1.0 - tone)));
        const double detune = 0.96 + 0.08 * (static_cast<double>(randomBipolar()) * 0.5 + 0.5);
        modalWeights_[mode] = static_cast<float>(spectralTilt * detune / 2.2);
        const float alternating = mode % 2 == 0 ? -1.0f : 1.0f;
        modalPan_[mode] = alternating * width * static_cast<float>(1.0 + mode / 2.0) /
                          static_cast<float>(kModalCount / 2);
    }
    noiseEnvelope_ = noiseLevel_ > 0.0f ? 1.0 : 0.0;
    noiseDecayCoefficient_ = std::exp(-6.907755278982137 / (decay * sampleRate_));
    active_ = amplitude_ > 0.0f || noiseLevel_ > 0.0f;
    return true;
}

bool DrumModalVoice::setNoiseLevel(float level) noexcept {
    if (!prepared_ || !finite(level)) {
        return false;
    }
    noiseLevel_ = std::clamp(level, 0.0f, 1.0f);
    if (noiseLevel_ == 0.0f) {
        noiseEnvelope_ = 0.0;
    }
    if (noiseLevel_ > 0.0f && noiseEnvelope_ == 0.0) {
        noiseEnvelope_ = 1.0;
        active_ = true;
    }
    return true;
}

float DrumModalVoice::randomBipolar() noexcept {
    std::uint64_t value = randomState_;
    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    randomState_ = value;
    const auto bits = static_cast<std::uint32_t>((value * 0x2545f4914f6cdd1dULL) >> 32);
    return static_cast<float>(bits >> 8) * (2.0f / 16777216.0f) - 1.0f;
}

StereoFrame DrumModalVoice::processSample() noexcept {
    if (!prepared_ || !active_) {
        return {};
    }
    double left = 0.0;
    double right = 0.0;
    for (std::size_t mode = 0; mode < kModalCount; ++mode) {
        const double output = coefficient1_[mode] * modalY1_[mode] + coefficient2_[mode] * modalY2_[mode];
        modalY2_[mode] = modalY1_[mode];
        modalY1_[mode] = std::abs(output) < 1.0e-20 ? 0.0 : output;
        const float pan = std::clamp(modalPan_[mode], -1.0f, 1.0f);
        const double angle = (static_cast<double>(pan) + 1.0) * kPi * 0.25;
        const double sample = output * modalWeights_[mode] * amplitude_;
        left += sample * std::cos(angle);
        right += sample * std::sin(angle);
    }
    if (noiseEnvelope_ > 0.0 && noiseLevel_ > 0.0f) {
        const double envelope = noiseEnvelope_;
        const double side = static_cast<double>(stereoWidth_) * 0.5;
        const double normalization = 1.0 / std::sqrt(1.0 + side * side);
        const double sharedNoise = randomBipolar();
        const double sideNoise = randomBipolar();
        const double noiseLeft = (sharedNoise + sideNoise * side) * normalization;
        const double noiseRight = (sharedNoise - sideNoise * side) * normalization;
        left += noiseLeft * envelope * noiseLevel_ * amplitude_ * 0.35;
        right += noiseRight * envelope * noiseLevel_ * amplitude_ * 0.35;
        noiseEnvelope_ *= noiseDecayCoefficient_;
        if (noiseEnvelope_ < 1.0e-7) {
            noiseEnvelope_ = 0.0;
        }
    }
    double maximumState = 0.0;
    for (std::size_t mode = 0; mode < kModalCount; ++mode) {
        maximumState = std::max(maximumState,
            std::max(std::abs(modalY1_[mode]), std::abs(modalY2_[mode])));
    }
    if (maximumState < 1.0e-8 && noiseEnvelope_ == 0.0) {
        modalY1_.fill(0.0);
        modalY2_.fill(0.0);
        active_ = false;
    }
    return {clean(static_cast<float>(left)), clean(static_cast<float>(right))};
}

bool DrumModalVoice::processBlock(float* outputLeft, float* outputRight,
                                  std::uint32_t frames) noexcept {
    if (!prepared_ || outputLeft == nullptr || outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto sample = processSample();
        outputLeft[i] = sample.left;
        outputRight[i] = sample.right;
    }
    return true;
}

bool DrumKickVoice::prepare(const ProcessSpec& spec) noexcept {
    prepared_ = validSpec(spec, false);
    if (!prepared_) {
        return false;
    }
    spec_ = spec;
    sampleRate_ = spec.sampleRate;
    reset();
    return true;
}

void DrumKickVoice::reset() noexcept {
    phase_ = 0.0;
    elapsedSeconds_ = 0.0;
    active_ = false;
}

bool DrumKickVoice::trigger(const KickVoiceParameters& parameters) noexcept {
    if (!prepared_ || !finite(parameters.startFrequencyHz) || !finite(parameters.endFrequencyHz) ||
        !finite(parameters.sweepSeconds) || !finite(parameters.decaySeconds) ||
        !finite(parameters.amplitude)) {
        return false;
    }
    startFrequencyHz_ = std::clamp(parameters.startFrequencyHz, 20.0f,
                                   static_cast<float>(sampleRate_ * 0.44));
    endFrequencyHz_ = std::clamp(parameters.endFrequencyHz, 20.0f,
                                 static_cast<float>(sampleRate_ * 0.44));
    sweepSeconds_ = std::clamp(parameters.sweepSeconds, 0.005f, 2.0f);
    decaySeconds_ = std::clamp(parameters.decaySeconds, 0.02f, 12.0f);
    amplitude_ = std::clamp(parameters.amplitude, 0.0f, 1.0f);
    phase_ = 0.0;
    elapsedSeconds_ = 0.0;
    active_ = amplitude_ > 0.0f;
    return true;
}

StereoFrame DrumKickVoice::processSample() noexcept {
    if (!prepared_ || !active_) {
        return {};
    }
    constexpr double kLn1000 = 6.907755278982137052;
    const double envelope = std::exp(-kLn1000 * elapsedSeconds_ / decaySeconds_);
    const double sweep = std::exp(-kLn1000 * elapsedSeconds_ / sweepSeconds_);
    const double frequency = endFrequencyHz_ + (startFrequencyHz_ - endFrequencyHz_) * sweep;
    const float sample = clean(static_cast<float>(std::sin(phase_) * envelope * amplitude_));
    phase_ += kTwoPi * frequency / sampleRate_;
    if (phase_ >= kTwoPi) {
        phase_ -= kTwoPi;
    }
    elapsedSeconds_ += 1.0 / sampleRate_;
    if (envelope < 1.0e-7) {
        active_ = false;
    }
    return {sample, sample};
}

bool DrumKickVoice::processBlock(float* outputLeft, float* outputRight,
                                 std::uint32_t frames) noexcept {
    if (!prepared_ || outputLeft == nullptr || outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto sample = processSample();
        outputLeft[i] = sample.left;
        outputRight[i] = sample.right;
    }
    return true;
}

bool DrumSnareVoice::prepare(const ProcessSpec& spec) noexcept {
    prepared_ = validSpec(spec, false);
    if (!prepared_) {
        return false;
    }
    spec_ = spec;
    sampleRate_ = spec.sampleRate;
    highpassCoefficient_ = static_cast<float>(1.0 -
        std::exp(-kTwoPi * std::min(350.0, sampleRate_ * 0.4) / sampleRate_));
    lowpassCoefficient_ = static_cast<float>(1.0 -
        std::exp(-kTwoPi * std::min(9000.0, sampleRate_ * 0.45) / sampleRate_));
    reset();
    return true;
}

void DrumSnareVoice::reset() noexcept {
    bodyCoefficient1_ = 0.0;
    bodyCoefficient2_ = 0.0;
    bodyY1_ = 0.0;
    bodyY2_ = 0.0;
    noiseEnvelope_ = 0.0;
    noiseDecayCoefficient_ = 0.0;
    noiseLevel_ = 0.8f;
    amplitude_ = 0.75f;
    stereoWidth_ = 0.0f;
    lowState_ = 0.0f;
    bandState_ = 0.0f;
    sideLowState_ = 0.0f;
    sideBandState_ = 0.0f;
    randomState_ = 1;
    active_ = false;
}

bool DrumSnareVoice::trigger(const SnareVoiceParameters& parameters) noexcept {
    if (!prepared_ || !finite(parameters.bodyFrequencyHz) || !finite(parameters.bodyDecaySeconds) ||
        !finite(parameters.noiseDecaySeconds) || !finite(parameters.noiseLevel) ||
        !finite(parameters.amplitude) || !finite(parameters.stereoWidth)) {
        return false;
    }
    constexpr double kLn1000 = 6.907755278982137052;
    const double frequency = std::clamp(static_cast<double>(parameters.bodyFrequencyHz),
                                        40.0, sampleRate_ * 0.42);
    const double bodyDecay = std::clamp(static_cast<double>(parameters.bodyDecaySeconds), 0.02, 6.0);
    const double noiseDecay = std::clamp(static_cast<double>(parameters.noiseDecaySeconds), 0.01, 6.0);
    const double radius = std::exp(-kLn1000 / (bodyDecay * sampleRate_));
    const double angle = kTwoPi * frequency / sampleRate_;
    bodyCoefficient1_ = 2.0 * radius * std::cos(angle);
    bodyCoefficient2_ = -radius * radius;
    bodyY1_ = 0.0;
    bodyY2_ = -std::sin(angle) / (radius * radius);
    noiseDecayCoefficient_ = std::exp(-kLn1000 / (noiseDecay * sampleRate_));
    noiseLevel_ = std::clamp(parameters.noiseLevel, 0.0f, 1.0f);
    amplitude_ = std::clamp(parameters.amplitude, 0.0f, 1.0f);
    stereoWidth_ = std::clamp(parameters.stereoWidth, 0.0f, 1.0f);
    randomState_ = parameters.seed == 0 ? 1 : parameters.seed;
    noiseEnvelope_ = noiseLevel_ > 0.0f ? 1.0 : 0.0;
    lowState_ = 0.0f;
    bandState_ = 0.0f;
    sideLowState_ = 0.0f;
    sideBandState_ = 0.0f;
    active_ = amplitude_ > 0.0f && (noiseLevel_ > 0.0f || std::abs(bodyY2_) > 0.0);
    return true;
}

float DrumSnareVoice::randomBipolar() noexcept {
    std::uint64_t value = randomState_;
    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    randomState_ = value;
    const auto bits = static_cast<std::uint32_t>((value * 0x2545f4914f6cdd1dULL) >> 32);
    return static_cast<float>(bits >> 8) * (2.0f / 16777216.0f) - 1.0f;
}

StereoFrame DrumSnareVoice::processSample() noexcept {
    if (!prepared_ || !active_) {
        return {};
    }
    const double body = bodyCoefficient1_ * bodyY1_ + bodyCoefficient2_ * bodyY2_;
    bodyY2_ = bodyY1_;
    bodyY1_ = std::abs(body) < 1.0e-20 ? 0.0 : body;
    const float whiteNoise = randomBipolar();
    lowState_ = clean(lowState_ + highpassCoefficient_ * (whiteNoise - lowState_));
    const float high = whiteNoise - lowState_;
    bandState_ = clean(bandState_ + lowpassCoefficient_ * (high - bandState_));
    const double noiseContribution = noiseEnvelope_ > 0.0 ?
        static_cast<double>(bandState_) * noiseEnvelope_ * noiseLevel_ * amplitude_ * 0.4 : 0.0;
    const double bodySample = body * amplitude_ * 0.35;
    const double panAngle = (static_cast<double>(stereoWidth_) + 1.0) * kPi * 0.25;
    const double modalLeft = std::cos(panAngle);
    const double modalRight = std::sin(panAngle);
    const double side = static_cast<double>(stereoWidth_) * 0.5;
    const double normalization = 1.0 / std::sqrt(1.0 + side * side);
    const double sharedNoise = noiseContribution;
    const float sideWhiteNoise = randomBipolar();
    sideLowState_ = clean(sideLowState_ + highpassCoefficient_ * (sideWhiteNoise - sideLowState_));
    const float sideHigh = sideWhiteNoise - sideLowState_;
    sideBandState_ = clean(sideBandState_ + lowpassCoefficient_ * (sideHigh - sideBandState_));
    const double sideNoise = static_cast<double>(sideBandState_) * noiseEnvelope_ *
                             noiseLevel_ * amplitude_ * 0.4;
    const double left = bodySample * modalLeft + (sharedNoise + sideNoise * side) * normalization;
    const double right = bodySample * modalRight + (sharedNoise - sideNoise * side) * normalization;
    noiseEnvelope_ *= noiseDecayCoefficient_;
    if (noiseEnvelope_ < 1.0e-7) {
        noiseEnvelope_ = 0.0;
    }
    const double bodyState = std::max(std::abs(bodyY1_), std::abs(bodyY2_));
    if (bodyState < 1.0e-8 && noiseEnvelope_ == 0.0) {
        bodyY1_ = bodyY2_ = 0.0;
        active_ = false;
    }
    return {clean(static_cast<float>(left)), clean(static_cast<float>(right))};
}

bool DrumSnareVoice::processBlock(float* outputLeft, float* outputRight,
                                  std::uint32_t frames) noexcept {
    if (!prepared_ || outputLeft == nullptr || outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto sample = processSample();
        outputLeft[i] = sample.left;
        outputRight[i] = sample.right;
    }
    return true;
}

bool DrumHiHatVoice::prepare(const ProcessSpec& spec) noexcept {
    prepared_ = validSpec(spec, false);
    if (!prepared_) {
        return false;
    }
    spec_ = spec;
    sampleRate_ = spec.sampleRate;
    highpassCoefficient_ = static_cast<float>(1.0 -
        std::exp(-kTwoPi * std::min(7000.0, sampleRate_ * 0.45) / sampleRate_));
    weights_ = {1.0f, 0.92f, 0.78f, 0.68f, 0.58f, 0.48f};
    reset();
    return true;
}

void DrumHiHatVoice::reset() noexcept {
    phase_.fill(0.0);
    frequencies_.fill(0.0);
    elapsedSeconds_ = 0.0;
    decaySeconds_ = 0.18f;
    noiseLevel_ = 0.5f;
    amplitude_ = 0.6f;
    stereoWidth_ = 0.0f;
    highpassState_ = 0.0f;
    sideHighpassState_ = 0.0f;
    noiseEnvelope_ = 0.0;
    noiseDecayCoefficient_ = 0.0;
    randomState_ = 1;
    active_ = false;
}

bool DrumHiHatVoice::trigger(const HiHatVoiceParameters& parameters) noexcept {
    if (!prepared_ || !finite(parameters.baseFrequencyHz) || !finite(parameters.decaySeconds) ||
        !finite(parameters.noiseLevel) || !finite(parameters.amplitude) ||
        !finite(parameters.stereoWidth)) {
        return false;
    }
    constexpr std::array<double, kPartialCount> ratios{1.0, 1.342, 1.731, 2.296, 2.789, 3.328};
    const double base = std::clamp(static_cast<double>(parameters.baseFrequencyHz),
                                   500.0, std::min(16000.0, sampleRate_ * 0.43));
    for (std::size_t i = 0; i < kPartialCount; ++i) {
        frequencies_[i] = std::min(base * ratios[i], sampleRate_ * 0.47);
        phase_[i] = 0.0;
    }
    decaySeconds_ = std::clamp(parameters.decaySeconds, 0.005f, 6.0f);
    noiseLevel_ = std::clamp(parameters.noiseLevel, 0.0f, 1.0f);
    amplitude_ = std::clamp(parameters.amplitude, 0.0f, 1.0f);
    stereoWidth_ = std::clamp(parameters.stereoWidth, 0.0f, 1.0f);
    noiseDecayCoefficient_ = std::exp(-6.907755278982137 / (decaySeconds_ * sampleRate_));
    noiseEnvelope_ = noiseLevel_ > 0.0f ? 1.0 : 0.0;
    randomState_ = parameters.seed == 0 ? 1 : parameters.seed;
    elapsedSeconds_ = 0.0;
    highpassState_ = 0.0f;
    active_ = amplitude_ > 0.0f && (noiseLevel_ > 0.0f || decaySeconds_ > 0.0f);
    return true;
}

float DrumHiHatVoice::randomBipolar() noexcept {
    std::uint64_t value = randomState_;
    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    randomState_ = value;
    const auto bits = static_cast<std::uint32_t>((value * 0x2545f4914f6cdd1dULL) >> 32);
    return static_cast<float>(bits >> 8) * (2.0f / 16777216.0f) - 1.0f;
}

StereoFrame DrumHiHatVoice::processSample() noexcept {
    if (!prepared_ || !active_) {
        return {};
    }
    const double envelope = std::exp(-6.907755278982137 * elapsedSeconds_ / decaySeconds_);
    double left = 0.0;
    double right = 0.0;
    for (std::size_t i = 0; i < kPartialCount; ++i) {
        const double sample = std::sin(phase_[i]) * weights_[i] * envelope * amplitude_ * 0.22;
        const float pan = (i % 2 == 0 ? -1.0f : 1.0f) * stereoWidth_ *
                          static_cast<float>(i + 1) / static_cast<float>(kPartialCount);
        const double angle = (static_cast<double>(pan) + 1.0) * kPi * 0.25;
        left += sample * std::cos(angle);
        right += sample * std::sin(angle);
        phase_[i] += kTwoPi * frequencies_[i] / sampleRate_;
        if (phase_[i] >= kTwoPi) phase_[i] -= kTwoPi;
    }
    const float rawNoise = randomBipolar();
    highpassState_ = clean(highpassState_ + highpassCoefficient_ * (rawNoise - highpassState_));
    const double side = static_cast<double>(stereoWidth_) * 0.5;
    const double normalization = 1.0 / std::sqrt(1.0 + side * side);
    const double sharedNoise = rawNoise - highpassState_;
    const float rawSideNoise = randomBipolar();
    sideHighpassState_ = clean(sideHighpassState_ + highpassCoefficient_ *
                               (rawSideNoise - sideHighpassState_));
    const double sideNoise = static_cast<double>(rawSideNoise - sideHighpassState_) * side;
    const double noiseGain = noiseEnvelope_ * noiseLevel_ * amplitude_ * 0.2 * normalization;
    left += (sharedNoise + sideNoise) * noiseGain;
    right += (sharedNoise - sideNoise) * noiseGain;
    elapsedSeconds_ += 1.0 / sampleRate_;
    noiseEnvelope_ *= noiseDecayCoefficient_;
    if (noiseEnvelope_ < 1.0e-7) noiseEnvelope_ = 0.0;
    if (envelope < 1.0e-7) active_ = false;
    return {clean(static_cast<float>(left)), clean(static_cast<float>(right))};
}

bool DrumHiHatVoice::processBlock(float* outputLeft, float* outputRight,
                                  std::uint32_t frames) noexcept {
    if (!prepared_ || outputLeft == nullptr || outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto sample = processSample();
        outputLeft[i] = sample.left;
        outputRight[i] = sample.right;
    }
    return true;
}

bool DrumModalVoicePool::prepare(const ProcessSpec& spec) noexcept {
    if (!validSpec(spec, false)) {
        prepared_ = false;
        return false;
    }
    for (auto& voice : voices_) {
        if (!voice.prepare(spec)) {
            prepared_ = false;
            return false;
        }
    }
    spec_ = spec;
    nextVoice_ = 0;
    prepared_ = true;
    return true;
}

void DrumModalVoicePool::reset() noexcept {
    for (auto& voice : voices_) voice.reset();
    nextVoice_ = 0;
}

bool DrumModalVoicePool::trigger(const DrumVoiceParameters& parameters) noexcept {
    if (!prepared_) return false;
    auto& voice = voices_[nextVoice_];
    nextVoice_ = (nextVoice_ + 1) % static_cast<std::uint32_t>(voices_.size());
    return voice.trigger(parameters);
}

std::uint32_t DrumModalVoicePool::activeVoices() const noexcept {
    std::uint32_t count = 0;
    for (const auto& voice : voices_) count += voice.active() ? 1U : 0U;
    return count;
}

StereoFrame DrumModalVoicePool::processSample() noexcept {
    if (!prepared_) return {};
    double left = 0.0;
    double right = 0.0;
    for (auto& voice : voices_) {
        const auto sample = voice.processSample();
        left += sample.left;
        right += sample.right;
    }
    const double normalization = 1.0 / std::sqrt(static_cast<double>(std::max(1U, activeVoices())));
    return {clean(static_cast<float>(std::clamp(left * normalization, -1.0, 1.0))),
            clean(static_cast<float>(std::clamp(right * normalization, -1.0, 1.0)))};
}

bool DrumModalVoicePool::processBlock(float* outputLeft, float* outputRight,
                                      std::uint32_t frames) noexcept {
    if (!prepared_ || outputLeft == nullptr || outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto sample = processSample();
        outputLeft[i] = sample.left;
        outputRight[i] = sample.right;
    }
    return true;
}

bool DrumVoicePool::Slot::active() const noexcept {
    return sourceActive() || stealTailRemaining > 0;
}

bool DrumVoicePool::Slot::sourceActive() const noexcept {
    switch (type) {
        case VoiceType::Modal: return modal.active();
        case VoiceType::Kick: return kick.active();
        case VoiceType::Snare: return snare.active();
        case VoiceType::HiHat: return hiHat.active();
        case VoiceType::None: return false;
    }
    return false;
}

bool DrumVoicePool::Slot::available() const noexcept {
    return !sourceActive() && stealTailRemaining == 0;
}

void DrumVoicePool::Slot::beginStealFade() noexcept {
    if (!active()) return;
    stealTail = lastOutput;
    stealTailRemaining = 64;
}

StereoFrame DrumVoicePool::Slot::process() noexcept {
    StereoFrame result{};
    switch (type) {
        case VoiceType::Modal: result = modal.processSample(); break;
        case VoiceType::Kick: result = kick.processSample(); break;
        case VoiceType::Snare: result = snare.processSample(); break;
        case VoiceType::HiHat: result = hiHat.processSample(); break;
        case VoiceType::None: break;
    }
    if (type != VoiceType::None && !sourceActive()) type = VoiceType::None;
    if (stealTailRemaining > 0) {
        constexpr std::uint32_t kStealFadeFrames = 64;
        const std::uint32_t position = kStealFadeFrames - stealTailRemaining;
        const double u = static_cast<double>(position) / (kStealFadeFrames - 1U);
        const float gain = static_cast<float>(std::cos(u * kPi * 0.5));
        result.left += stealTail.left * gain;
        result.right += stealTail.right * gain;
        --stealTailRemaining;
        if (stealTailRemaining == 0) stealTail = {};
    }
    lastOutput = {clean(result.left), clean(result.right)};
    const float level = std::max(std::abs(lastOutput.left), std::abs(lastOutput.right));
    levelEstimate = std::max(level, levelEstimate * 0.999f);
    if (!active()) levelEstimate = 0.0f;
    return lastOutput;
}

DrumVoicePool::Slot& DrumVoicePool::acquireSlot() noexcept {
    const auto slotCount = static_cast<std::uint32_t>(voices_.size());
    for (std::uint32_t offset = 0; offset < slotCount; ++offset) {
        const auto index = (nextVoice_ + offset) % slotCount;
        if (voices_[index].available()) {
            nextVoice_ = (index + 1U) % slotCount;
            return voices_[index];
        }
    }

    std::uint32_t quietest = nextVoice_;
    for (std::uint32_t offset = 1; offset < slotCount; ++offset) {
        const auto index = (nextVoice_ + offset) % slotCount;
        if (voices_[index].levelEstimate < voices_[quietest].levelEstimate) quietest = index;
    }
    auto& slot = voices_[quietest];
    slot.beginStealFade();
    slot.levelEstimate = 0.0f;
    nextVoice_ = (quietest + 1U) % slotCount;
    return slot;
}

bool DrumVoicePool::prepare(const ProcessSpec& spec) noexcept {
    prepared_ = false;
    if (!validSpec(spec, false)) return false;
    for (auto& slot : voices_) {
        if (!slot.modal.prepare(spec) || !slot.kick.prepare(spec) ||
            !slot.snare.prepare(spec) || !slot.hiHat.prepare(spec)) {
            return false;
        }
        slot.type = VoiceType::None;
        slot.lastOutput = {};
        slot.stealTail = {};
        slot.stealTailRemaining = 0;
        slot.levelEstimate = 0.0f;
    }
    spec_ = spec;
    nextVoice_ = 0;
    prepared_ = true;
    return true;
}

void DrumVoicePool::reset() noexcept {
    for (auto& slot : voices_) {
        slot.modal.reset();
        slot.kick.reset();
        slot.snare.reset();
        slot.hiHat.reset();
        slot.type = VoiceType::None;
        slot.lastOutput = {};
        slot.stealTail = {};
        slot.stealTailRemaining = 0;
        slot.levelEstimate = 0.0f;
    }
    nextVoice_ = 0;
}

bool DrumVoicePool::triggerModal(const DrumVoiceParameters& parameters) noexcept {
    if (!prepared_ || !finite(parameters.fundamentalHz) || !finite(parameters.decaySeconds) ||
        !finite(parameters.tone) || !finite(parameters.noise) || !finite(parameters.amplitude) ||
        !finite(parameters.stereoWidth)) return false;
    auto& slot = acquireSlot();
    if (!slot.modal.trigger(parameters)) return false;
    slot.type = VoiceType::Modal;
    return true;
}

bool DrumVoicePool::triggerKick(const KickVoiceParameters& parameters) noexcept {
    if (!prepared_ || !finite(parameters.startFrequencyHz) || !finite(parameters.endFrequencyHz) ||
        !finite(parameters.sweepSeconds) || !finite(parameters.decaySeconds) ||
        !finite(parameters.amplitude)) return false;
    auto& slot = acquireSlot();
    if (!slot.kick.trigger(parameters)) return false;
    slot.type = VoiceType::Kick;
    return true;
}

bool DrumVoicePool::triggerSnare(const SnareVoiceParameters& parameters) noexcept {
    if (!prepared_ || !finite(parameters.bodyFrequencyHz) || !finite(parameters.bodyDecaySeconds) ||
        !finite(parameters.noiseDecaySeconds) || !finite(parameters.noiseLevel) ||
        !finite(parameters.amplitude) || !finite(parameters.stereoWidth)) return false;
    auto& slot = acquireSlot();
    if (!slot.snare.trigger(parameters)) return false;
    slot.type = VoiceType::Snare;
    return true;
}

bool DrumVoicePool::triggerHiHat(const HiHatVoiceParameters& parameters) noexcept {
    if (!prepared_ || !finite(parameters.baseFrequencyHz) || !finite(parameters.decaySeconds) ||
        !finite(parameters.noiseLevel) || !finite(parameters.amplitude) ||
        !finite(parameters.stereoWidth)) return false;
    auto& slot = acquireSlot();
    if (!slot.hiHat.trigger(parameters)) return false;
    slot.type = VoiceType::HiHat;
    return true;
}

std::uint32_t DrumVoicePool::activeVoices() const noexcept {
    std::uint32_t count = 0;
    for (const auto& voice : voices_) count += voice.active() ? 1U : 0U;
    return count;
}

StereoFrame DrumVoicePool::processSample() noexcept {
    if (!prepared_) return {};
    double left = 0.0;
    double right = 0.0;
    for (auto& voice : voices_) {
        const auto sample = voice.process();
        left += sample.left;
        right += sample.right;
    }
    constexpr double fixedHeadroom = 0.3535533905932737622; // 1/sqrt(8)
    const auto softSafety = [](double value) noexcept {
        constexpr double knee = 0.82;
        constexpr double shoulder = 0.18;
        const double magnitude = std::abs(value);
        if (magnitude <= knee) return value;
        return std::copysign(knee + shoulder * std::tanh((magnitude - knee) / shoulder), value);
    };
    return {clean(static_cast<float>(softSafety(left * fixedHeadroom))),
            clean(static_cast<float>(softSafety(right * fixedHeadroom)))};
}

bool DrumVoicePool::processBlock(float* outputLeft, float* outputRight,
                                 std::uint32_t frames) noexcept {
    if (!prepared_ || outputLeft == nullptr || outputRight == nullptr || frames > spec_.maxBlockFrames) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto sample = processSample();
        outputLeft[i] = sample.left;
        outputRight[i] = sample.right;
    }
    return true;
}

} // namespace webrc::dsp

#undef WEBRC_DSP_TRY
#undef WEBRC_DSP_CATCH_BAD_ALLOC
