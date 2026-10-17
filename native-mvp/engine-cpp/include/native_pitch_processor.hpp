#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Stateless host-routing result for the mono pitch processor. The host owns
// reverse playback and loop lifetime; these checks make the safe fallback
// explicit before connecting the processor in an audio graph.
enum class NativePitchFallbackReason : std::uint8_t {
    None = 0,
    NotRequested,
    ProcessorNotPrepared,
    PlaybackBufferUnavailable,
    ReversePlayback,
    UnsupportedChannelCount,
    LoopShorterThanLatency,
};

struct NativePitchRouteDecision {
    bool useProcessor = false;
    NativePitchFallbackReason fallbackReason = NativePitchFallbackReason::NotRequested;
};

[[nodiscard]] NativePitchRouteDecision decideNativePitchRoute(
    bool requested,
    bool processorPrepared,
    bool reversePlayback,
    unsigned int channelCount,
    std::uint64_t loopLengthSamples,
    std::uint64_t latencySamples
) noexcept;

struct NativePitchStatus {
    unsigned int sampleRate = 0U;
    unsigned int latencySamples = 0U;
    float semitones = 0.0f;
    float frequencyHz = 0.0f;
    float confidence = 0.0f;
    bool prepared = false;
    bool voiced = false;
};

// Clean-room, fixed-latency LIVE_MONO pitch shifting. YIN/CMND analyses are
// performed on a boxcar-decimated mono stream. Peak-locked, Hann-like
// TD-PSOLA grains then overlap-add into bounded rings. All vector storage is
// sized in prepare(); processInPlace/processInterleaved perform no allocation,
// locking, I/O, or logging.
//
// Mutate configuration only on the DSP-owner thread (or hand it over via the
// host's bounded command queue). Reverse, >2-channel, unprepared, and too-short
// loops should use the ordinary host playback route via decideNativePitchRoute.
// LIVE_POLY and HQ_RENDER are deliberately outside this class.
class NativePitchProcessor final {
public:
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr unsigned int kMaximumCallbackFrames = 64U;

    NativePitchProcessor() = default;

    // Allocate bounded history before starting the audio callback. Returns
    // false for invalid ranges or allocation failure; no state is usable then.
    [[nodiscard]] bool prepare(
        unsigned int sampleRate,
        float minimumFrequencyHz = 70.0f,
        float maximumFrequencyHz = 1200.0f,
        float semitones = 0.0f,
        // Optional per-source transient sensitivity; default preserves the
        // existing 0.08f attack threshold. Higher values protect fewer grains.
        float transientThresholdFloor = 0.08f
    ) noexcept;

    // May be called by the DSP owner between callbacks. The ratio is smoothed
    // by the processor over roughly 12 ms.
    [[nodiscard]] bool setSemitones(float semitones) noexcept;
    void reset() noexcept;

    // Mono in-place streaming interface. Arbitrary block sizes are supported;
    // the native host may naturally call it in <=64-frame callback slices.
    [[nodiscard]] bool processInPlace(float* monoSamples, unsigned int frames) noexcept;

    // Interleaved mono/stereo input interface. Stereo is explicitly downmixed
    // to mono and duplicated at output. Blocks larger than 64 frames are
    // internally chunked through preallocated scratch; >2 channels are left
    // untouched and rejected so the host can take its ordinary fallback.
    [[nodiscard]] bool processInterleaved(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] NativePitchStatus status() const noexcept;
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] unsigned int latencySamples() const noexcept { return latencySamples_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] bool voiced() const noexcept { return detectorVoiced_; }
    [[nodiscard]] float frequencyHz() const noexcept { return detectorFrequencyHz_; }
    [[nodiscard]] float confidence() const noexcept { return detectorConfidence_; }
    [[nodiscard]] float semitones() const noexcept { return targetSemitones_; }

    // Returns 0 for invalid configuration. Otherwise this is the same fixed
    // algorithmic delay reported after prepare(), without allocating buffers.
    [[nodiscard]] static unsigned int calculateLatencySamples(
        unsigned int sampleRate,
        float minimumFrequencyHz = 70.0f
    ) noexcept;

private:
    static constexpr unsigned int kMaximumDetectorLag = 600U;
    static constexpr unsigned int kMaximumDetectorRing = 4096U;
    static constexpr unsigned int kMaximumPitchHistory = 256U;
    static constexpr unsigned int kMaximumScratchFrames = 64U;

    struct YinDetector {
        std::array<float, kMaximumDetectorRing> ring{};
        std::array<double, kMaximumDetectorLag + 1U> differences{};
        std::array<double, kMaximumDetectorLag + 1U> normalizedDifferences{};
        unsigned int sampleRate = 0U;
        unsigned int minimumLag = 0U;
        unsigned int maximumLag = 0U;
        unsigned int frameSamples = 0U;
        unsigned int analysisWindowSamples = 0U;
        unsigned int hopSamples = 0U;
        unsigned int ringCapacity = 0U;
        unsigned int ringMask = 0U;
        unsigned int writeIndex = 0U;
        std::uint64_t sampleCount = 0U;
        std::uint64_t nextAnalysisSample = 0U;
        std::uint64_t analysisSerial = 0U;
        std::uint64_t estimateTimeSamples = 0U;
        unsigned int goodFrames = 0U;
        unsigned int badFrames = 0U;
        float threshold = 0.16f;
        float currentFrequencyHz = 0.0f;
        float currentConfidence = 0.0f;
        float smoothedLogFrequency = 0.0f;
        bool currentVoiced = false;

        [[nodiscard]] bool configure(
            unsigned int rate,
            float minimumFrequencyHz,
            float maximumFrequencyHz,
            unsigned int analysisHopSamples
        ) noexcept;
        void reset() noexcept;
        void pushSample(float sample) noexcept;
        void analyzeFrame() noexcept;
    };

    static unsigned int nextPowerOfTwo(unsigned int value) noexcept;
    static bool validSemitones(float semitones) noexcept;
    [[nodiscard]] bool validConfiguration(
        unsigned int sampleRate,
        float minimumFrequencyHz,
        float maximumFrequencyHz,
        float semitones,
        float transientThresholdFloor
    ) const noexcept;
    void storePitchEstimate(std::uint64_t estimateTimeSamples) noexcept;
    [[nodiscard]] bool lookupPitch(std::int64_t timeSamples) noexcept;
    void synthesizePitchGrain(double outputCenter) noexcept;
    void addGrainSample(std::int64_t absoluteOutputSample, float sample, double weight) noexcept;
    [[nodiscard]] float readInput(std::int64_t absoluteSample) const noexcept;

    YinDetector detector_{};
    std::vector<float> inputRing_{};
    std::vector<std::uint8_t> transientRing_{};
    std::vector<double> outputSumRing_{};
    std::vector<double> outputWeightRing_{};
    // Generation tags make reset constant-time: stale overlap-add samples are
    // ignored instead of clearing the full output ring on the audio thread.
    std::vector<std::uint64_t> outputRingGeneration_{};
    std::vector<std::uint64_t> pitchTimes_{};
    std::vector<float> pitchFrequencies_{};
    std::vector<float> pitchConfidences_{};
    std::vector<std::uint8_t> pitchVoiced_{};
    std::array<float, kMaximumScratchFrames> monoScratch_{};

    unsigned int sampleRate_ = 0U;
    unsigned int latencySamples_ = 0U;
    unsigned int decimation_ = 1U;
    unsigned int detectorHopRawSamples_ = 1U;
    unsigned int detectorDelayRawSamples_ = 0U;
    unsigned int maximumPeriodSamples_ = 0U;
    unsigned int maximumSearchRadius_ = 0U;
    unsigned int generationDelaySamples_ = 0U;
    unsigned int inputRingMask_ = 0U;
    unsigned int outputRingMask_ = 0U;
    unsigned int pitchHistoryMask_ = 0U;
    unsigned int transientHoldSamples_ = 1U;
    float transientThresholdFloor_ = 0.08f;
    std::uint64_t inputSampleCursor_ = 0U;
    unsigned int decimatorCount_ = 0U;
    double decimatorSum_ = 0.0;
    std::uint64_t detectorSerial_ = 0U;
    std::uint64_t resetGeneration_ = 0U;
    unsigned int pitchHistoryWrite_ = 0U;
    unsigned int pitchHistoryCount_ = 0U;
    int latestPitchHistoryIndex_ = -1;
    std::uint64_t latestPitchTime_ = 0U;
    double nextSynthesisCenter_ = 0.0;
    float targetSemitones_ = 0.0f;
    float targetRatio_ = 1.0f;
    float currentRatio_ = 1.0f;
    float outputMix_ = 0.0f;
    float previousInput_ = 0.0f;
    float derivativeEnvelope_ = 0.0f;
    unsigned int transientCountdown_ = 0U;
    float lookupFrequency_ = 0.0f;
    float lookupConfidence_ = 0.0f;
    bool lookupVoiced_ = false;
    bool detectorVoiced_ = false;
    float detectorFrequencyHz_ = 0.0f;
    float detectorConfidence_ = 0.0f;
    float ratioSmoothing_ = 0.0f;
    float mixSmoothing_ = 0.0f;
    bool prepared_ = false;
};

} // namespace webrc::native
