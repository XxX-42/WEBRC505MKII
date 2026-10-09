#pragma once

#include "webrc/dsp/pitch.hpp"

#include <complex>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kStreamingYinApiVersion = 1;

// Incremental fixed-window YIN. Input is captured into a prepared ring; FFT
// autocorrelation and CMND work is resumed across calls under a fixed analysis
// work-unit budget. Input-ring ingestion is also bounded by spec.maxBlockFrames
// but is not included in that counter; wall-clock benchmarks time the whole call.
// It performs no allocation, lock, or I/O from processBlock(). The
// newest completed estimate remains available while a newer analysis is busy.
class IncrementalYinDetector {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, std::uint32_t windowFrames,
        float minimumFrequencyHz, float maximumFrequencyHz,
        std::uint32_t workUnitsPerBlock) noexcept;

    bool prepare(const ProcessSpec& spec, std::uint32_t windowFrames,
                 float minimumFrequencyHz, float maximumFrequencyHz,
                 float threshold = 0.15f, std::uint32_t hopFrames = 512U,
                 std::uint32_t workUnitsPerBlock = 8192U);
    void reset() noexcept;
    bool processBlock(const float* monoInput, std::uint32_t frames) noexcept;

    [[nodiscard]] const PitchEstimate& latestEstimate() const noexcept { return latestEstimate_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] bool analysisBusy() const noexcept;
    [[nodiscard]] std::uint64_t analysisCount() const noexcept { return analysisCount_; }
    [[nodiscard]] std::uint64_t totalInputFrames() const noexcept { return totalInputFrames_; }
    [[nodiscard]] std::uint64_t latestWindowEndFrame() const noexcept { return latestWindowEndFrame_; }
    [[nodiscard]] std::uint32_t latestProcessingLagFrames() const noexcept { return latestProcessingLagFrames_; }
    // Estimator work units only (including the bounded snapshot copy), excluding
    // input sample ingestion. Use elapsed callback timing for total CPU cost.
    [[nodiscard]] std::uint32_t lastWorkUnits() const noexcept { return lastWorkUnits_; }
    [[nodiscard]] std::uint32_t workUnitsPerBlock() const noexcept { return workUnitsPerBlock_; }
    [[nodiscard]] std::uint32_t windowFrames() const noexcept { return windowFrames_; }
    [[nodiscard]] std::uint32_t hopFrames() const noexcept { return hopFrames_; }
    [[nodiscard]] std::uint32_t maximumBlockFrames() const noexcept { return spec_.maxBlockFrames; }
    [[nodiscard]] std::uint32_t minimumLagSamples() const noexcept { return minimumLag_; }
    [[nodiscard]] std::uint32_t maximumLagSamples() const noexcept { return maximumLag_; }

private:
    enum class Phase : std::uint8_t {
        Idle,
        Mean,
        CenterAndPad,
        BitReverseForward,
        FftForward,
        PowerSpectrum,
        BitReverseInverse,
        FftInverse,
        ScaleInverse,
        Cmnd,
        SelectLag,
        FollowMinimum,
    };

    void beginAnalysis() noexcept;
    void beginTransform(bool inverse) noexcept;
    void advanceTransformStage() noexcept;
    void completeAnalysis(const PitchEstimate& estimate) noexcept;
    void performWork() noexcept;

    ProcessSpec spec_{};
    std::uint32_t windowFrames_ = 0U;
    std::uint32_t fftFrames_ = 0U;
    std::uint32_t minimumLag_ = 0U;
    std::uint32_t maximumLag_ = 0U;
    std::uint32_t hopFrames_ = 0U;
    std::uint32_t workUnitsPerBlock_ = 0U;
    std::uint32_t ringWrite_ = 0U;
    std::uint32_t ringFilled_ = 0U;
    std::uint32_t samplesSinceCapture_ = 0U;
    std::uint32_t workCursor_ = 0U;
    std::uint32_t lastWorkUnits_ = 0U;
    std::uint32_t bitReverseIndex_ = 0U;
    std::uint32_t bitReverseJ_ = 0U;
    std::uint32_t fftSpan_ = 0U;
    std::uint32_t fftBase_ = 0U;
    std::uint32_t fftOffset_ = 0U;
    std::uint32_t estimateLagCursor_ = 0U;
    std::uint32_t searchMinimumLag_ = 0U;
    std::uint32_t selectedLag_ = 0U;
    std::uint32_t bestLag_ = 0U;
    std::uint32_t latestProcessingLagFrames_ = 0U;
    std::uint64_t totalInputFrames_ = 0U;
    std::uint64_t captureWindowEndFrame_ = 0U;
    std::uint64_t latestWindowEndFrame_ = 0U;
    std::uint64_t analysisCount_ = 0U;
    double meanAccumulator_ = 0.0;
    double centeredEnergy_ = 0.0;
    double cumulativeDifference_ = 0.0;
    double bestCmnd_ = 0.0;
    double minimumPeriodSamples_ = 0.0;
    double maximumPeriodSamples_ = 0.0;
    double threshold_ = 0.15;
    double silenceRms_ = 1.0e-5;
    double rms_ = 0.0;
    std::complex<double> fftStep_{1.0, 0.0};
    std::complex<double> fftTwiddle_{1.0, 0.0};
    PitchEstimate latestEstimate_{};
    std::vector<float> inputRing_;
    std::vector<float> snapshot_;
    std::vector<std::complex<float>> spectrum_;
    std::vector<std::complex<double>> twiddleRoots_;
    std::vector<double> prefixEnergy_;
    std::vector<double> cmnd_;
    Phase phase_ = Phase::Idle;
    bool fftInverse_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
