#pragma once

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kPitchApiVersion = 1;

struct PitchEstimate {
    float frequencyHz = 0.0f;
    float periodSamples = 0.0f;
    float confidence = 0.0f;
    float rms = 0.0f;
    bool voiced = false;
};

// Fixed-frame YIN detector. FFT autocorrelation and prefix-energy evaluation
// implement d(tau)=sum(x[j]-x[j+tau])^2; all scratch is prepared up front.
// Prepare stages bounded scratch vectors before replacing an existing setup.
class YinPitchDetector {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, std::uint32_t frameFrames,
        float minimumFrequencyHz, float maximumFrequencyHz) noexcept;
    bool prepare(const ProcessSpec& spec, std::uint32_t frameFrames,
                 float minimumFrequencyHz, float maximumFrequencyHz,
                 float threshold = 0.15f);
    void reset() noexcept;
    bool analyze(const float* mono, std::uint32_t frames,
                 PitchEstimate& estimate) noexcept;
    [[nodiscard]] std::uint32_t frameFrames() const noexcept { return frameFrames_; }
    [[nodiscard]] std::uint32_t minimumLagSamples() const noexcept { return minimumLag_; }
    [[nodiscard]] std::uint32_t maximumLagSamples() const noexcept { return maximumLag_; }

private:
    ProcessSpec spec_{};
    std::uint32_t frameFrames_ = 0;
    std::uint32_t fftFrames_ = 0;
    std::uint32_t minimumLag_ = 0;
    std::uint32_t maximumLag_ = 0;
    double minimumPeriodSamples_ = 0.0;
    double maximumPeriodSamples_ = 0.0;
    float threshold_ = 0.15f;
    float silenceRms_ = 1.0e-5f;
    std::vector<std::complex<float>> spectrum_;
    std::vector<double> prefixEnergy_;
    std::vector<double> cmnd_;
};

// Buffer-based TD-PSOLA resynthesis. This is intended for prepared render
// buffers, not a per-quantum streaming callback. The source period comes from
// a pitch detector; pitchRatio is target/source, constrained to [0.5, 2].
// Input/output may alias because input is copied into prepare-time storage.
class TdPsolaPitchShifter {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        std::uint32_t maxBufferFrames) noexcept;
    bool prepare(const ProcessSpec& spec, std::uint32_t maxBufferFrames,
                 std::uint32_t maxPitchPeriodSamples);
    void reset() noexcept;
    bool processBuffer(const float* input, float* output, std::uint32_t frames,
                       float sourcePeriodSamples, float pitchRatio) noexcept;
    [[nodiscard]] std::uint32_t maximumBufferFrames() const noexcept { return maxBufferFrames_; }
    [[nodiscard]] std::uint32_t maximumPitchPeriodSamples() const noexcept { return maxPitchPeriodSamples_; }
    [[nodiscard]] static constexpr bool requiresWholeBufferProcessing() noexcept { return true; }

private:
    ProcessSpec spec_{};
    std::uint32_t maxBufferFrames_ = 0;
    std::uint32_t maxPitchPeriodSamples_ = 0;
    std::vector<float> source_;
    std::vector<double> accumulation_;
    std::vector<double> normalization_;
};

// Streaming mono pitch-synchronous granular resynthesizer with a fixed
// input/lookahead ring, ratio-remapped source reads, and future OLA slots.
// Ratio remapping is band-limited with a prepared sinc8 table; this clean-room
// path is not formant-preserving. `latencySamples()` reports its resynthesis
// lookahead only; a separate YIN analysis window must be added by the caller
// when budgeting the complete detector-to-output path. Pitch/voicing updates
// are smoothed; processBlock is bounded by the prepared Worklet quantum.
class StreamingTdPsolaPitchShifter {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, std::uint32_t maximumPitchPeriodSamples) noexcept;
    bool prepare(const ProcessSpec& spec, std::uint32_t maximumPitchPeriodSamples);
    void reset() noexcept;
    bool setPitch(float sourcePeriodSamples, float pitchRatio, bool voiced) noexcept;
    bool setPitchEstimate(const PitchEstimate& estimate, float pitchRatio) noexcept;
    bool processBlock(const float* input, float* output, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t latencySamples() const noexcept { return latencySamples_; }
    [[nodiscard]] std::uint32_t maximumPitchPeriodSamples() const noexcept { return maximumPitchPeriodSamples_; }
    [[nodiscard]] std::uint32_t maximumBlockFrames() const noexcept { return spec_.maxBlockFrames; }

private:
    static constexpr std::uint32_t kResamplingRatioSteps = 16U;
    static constexpr std::uint32_t kResamplingPhaseCount = 128U;
    static constexpr std::uint32_t kResamplingTapCount = 8U;
    [[nodiscard]] std::size_t ringIndex(std::int64_t frame) const noexcept;
    [[nodiscard]] float readInput(std::int64_t frame, std::int64_t newestFrame) const noexcept;
    [[nodiscard]] float readInputFractional(double frame, std::int64_t newestFrame,
                                            float pitchRatio) const noexcept;
    void scheduleGrain(double outputCenter, std::int64_t newestFrame) noexcept;
    void advanceSynthesisCenter() noexcept;
    void advanceMix() noexcept;

    ProcessSpec spec_{};
    std::uint32_t maximumPitchPeriodSamples_ = 0;
    std::uint32_t latencySamples_ = 0;
    std::size_t ringFrames_ = 0;
    std::vector<float> inputRing_;
    std::vector<double> outputAccumulation_;
    std::vector<double> outputNormalization_;
    std::vector<std::int64_t> outputFrameTags_;
    std::vector<std::uint32_t> outputEpochTags_;
    std::array<std::array<std::array<float, kResamplingTapCount>,
                          kResamplingPhaseCount + 1U>,
               kResamplingRatioSteps + 1U> resamplingTable_{};
    std::int64_t inputFrameIndex_ = -1;
    std::uint32_t epoch_ = 1;
    double nextSynthesisCenter_ = 0.0;
    float targetSourcePeriod_ = 0.0f;
    float currentSourcePeriod_ = 0.0f;
    float targetPitchRatio_ = 1.0f;
    float currentPitchRatio_ = 1.0f;
    float sourceMarkPolarity_ = 0.0f;
    float targetVoicingMix_ = 0.0f;
    float currentVoicingMix_ = 0.0f;
    float pitchSmoothingCoefficient_ = 0.0f;
    std::uint32_t voicingRampRemaining_ = 0;
    bool pitchAvailable_ = false;
};

// Phase-vocoder spectral frame processor. Angular-frequency state and API are
// explicitly radians/sample; synthesis phase advances by omega * hopSamples.
// Time scaling is analysisHop/synthesisHop and pitchRatio remaps spectral bins.
// The caller supplies windowed real-signal spectra and owns STFT overlap-add.
class PhaseVocoder {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        std::uint32_t fftFrames) noexcept;
    bool prepare(const ProcessSpec& spec, std::uint32_t fftFrames,
                 std::uint32_t analysisHopFrames, std::uint32_t synthesisHopFrames);
    void reset() noexcept;
    bool processSpectrumFrame(const std::complex<float>* input,
                              std::complex<float>* output,
                              float pitchRatio = 1.0f) noexcept;
    [[nodiscard]] float instantaneousAngularFrequencyRadiansPerSample(
        std::uint32_t bin) const noexcept;
    [[nodiscard]] std::uint32_t fftFrames() const noexcept { return fftFrames_; }
    [[nodiscard]] std::uint32_t analysisHopFrames() const noexcept { return analysisHopFrames_; }
    [[nodiscard]] std::uint32_t synthesisHopFrames() const noexcept { return synthesisHopFrames_; }

private:
    ProcessSpec spec_{};
    std::uint32_t fftFrames_ = 0;
    std::uint32_t analysisHopFrames_ = 0;
    std::uint32_t synthesisHopFrames_ = 0;
    std::vector<float> currentPhase_;
    std::vector<float> previousPhase_;
    std::vector<float> magnitudes_;
    std::vector<float> instantaneousOmegaRadiansPerSample_;
    std::vector<float> synthesisPhase_;
    bool havePreviousFrame_ = false;
};

// Linked-stereo, 16-band default browser vocoder. Each band is a real modulator
// and carrier band-pass pair followed by a shared attack/release envelope.
class MultibandVocoder {
public:
    static constexpr std::uint32_t kMaximumBands = 24;
    [[nodiscard]] static std::size_t requiredPrepareBytes() noexcept;
    bool prepare(const ProcessSpec& spec, std::uint32_t bandCount = 16,
                 float minimumFrequencyHz = 80.0f,
                 float maximumFrequencyHz = 10000.0f,
                 float bandQ = 1.25f);
    void reset() noexcept;
    bool setEnvelopeTimes(float attackMs, float releaseMs) noexcept;
    bool setOutputGain(float gain) noexcept;
    [[nodiscard]] StereoFrame processSample(float modulatorLeft, float modulatorRight,
                                            float carrierLeft, float carrierRight) noexcept;
    bool processBlock(const float* modulatorLeft, const float* modulatorRight,
                      const float* carrierLeft, const float* carrierRight,
                      float* outputLeft, float* outputRight,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t bandCount() const noexcept { return bandCount_; }
    [[nodiscard]] std::uint32_t algorithmicLatencySamples() const noexcept { return 0; }

private:
    ProcessSpec spec_{};
    std::uint32_t bandCount_ = 0;
    std::uint32_t maxBlockFrames_ = 0;
    float attackMs_ = 10.0f;
    float releaseMs_ = 100.0f;
    float attackCoefficient_ = 0.0f;
    float releaseCoefficient_ = 0.0f;
    float outputGain_ = 1.0f;
    std::array<BiquadDf2T, kMaximumBands> modulatorLeft_;
    std::array<BiquadDf2T, kMaximumBands> modulatorRight_;
    std::array<BiquadDf2T, kMaximumBands> carrierLeft_;
    std::array<BiquadDf2T, kMaximumBands> carrierRight_;
    std::array<float, kMaximumBands> envelope_{};
};

} // namespace webrc::dsp
