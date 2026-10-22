#pragma once

#include "native_pitch_processor.hpp"
#include "native_poly_pitch_processor.hpp"

#include <array>
#include <atomic>
#include <cstdint>

namespace webrc::native {

// Experimental clean-room ROBOT voice core. Bounded YIN/CMND stability,
// confidence, and frequency-range heuristics admit candidate sources in the
// 130-1200 Hz range to a preallocated TD-PSOLA path. This is not a general
// polyphony detector: ambiguous/unvoiced/out-of-range cases use the pinned
// Signalsmith fallback. Independent formant shifts remain Signalsmith-only.
// This is not a Roland implementation and has not received listening or
// hardware quality acceptance. Pitch acquisition and the common,
// latency-aligned algorithmic output delay are exposed separately.
class NativeRobotCore final {
public:
    static constexpr unsigned int kMinimumSampleRate = NativePolyPitchProcessor::kMinimumSampleRate;
    static constexpr unsigned int kMaximumSampleRate = NativePolyPitchProcessor::kMaximumSampleRate;
    static constexpr unsigned int kMaximumChannels = NativePolyPitchProcessor::kMaximumChannels;
    static constexpr unsigned int kMaximumControlQuantumFrames = 256U;
    static constexpr unsigned int kMaximumPitchShiftSemitones = NativePolyPitchProcessor::kMaximumSemitones;

    enum class PitchMode : std::uint8_t {
        FixedShift = 0U,
        NearestSemitone = 1U
    };

    enum class FormantPolicy : std::uint8_t {
        // Follow the shifted pitch naturally without compensation.
        CoupledToPitch = 0U,
        // Use Signalsmith compensation to hold the source formant map fixed.
        Preserve = 1U,
        // Compensate pitch and then apply formantSemitones independently.
        IndependentShift = 2U
    };

    enum class ProcessingMode : std::uint8_t {
        SignalsmithFallback = 0U,
        TdPsola = 1U
    };

    enum class FallbackReason : std::uint8_t {
        None = 0U,
        Unvoiced,
        UnstablePitch,
        // A conservative YIN confidence heuristic; not proof of polyphony.
        AmbiguousOrLowConfidence,
        BelowPsolaFrequencyRange,
        AbovePsolaFrequencyRange,
        PitchShiftOutsidePsolaRange,
        IndependentFormantShiftRequiresSignalsmith,
        CoupledFormantPolicyRequiresSignalsmith,
        PsolaDetectorNotConfident
    };

    static constexpr float kPsolaMinimumFrequencyHz = 130.0f;
    static constexpr float kPsolaMaximumFrequencyHz = 1200.0f;
    static constexpr float kPsolaMinimumConfidence = 0.94f;
    static constexpr unsigned int kMinimumStablePitchFrames = 4U;

    struct Config final {
        unsigned int sampleRate = 48000U;
        unsigned int channels = 2U;
        PitchMode pitchMode = PitchMode::NearestSemitone;
        // FixedShift: exact shift. NearestSemitone: offset applied before
        // snapping tracked F0 to the nearest MIDI note.
        float pitchSemitones = 0.0f;
        FormantPolicy formantPolicy = FormantPolicy::IndependentShift;
        // -12..12; must be zero unless formantPolicy is IndependentShift.
        float formantSemitones = 0.0f;
        float mixPercent = 100.0f;
    };

    NativeRobotCore() noexcept = default;

    // prepare/configure allocate or resize Signalsmith storage on the control
    // thread. Formant modes are implemented through the pinned Signalsmith API.
    [[nodiscard]] bool prepare(const Config& config) noexcept;
    // Control-thread setup/re-prepare only. For a running graph, use the
    // scalar setters below at the DSP-owner callback boundary instead.
    [[nodiscard]] bool configure(const Config& config) noexcept;
    void reset() noexcept;

    // RT-safe scalar controls. They validate and update fixed scalar state;
    // when prepared they call only the adapter's non-allocating setters.
    [[nodiscard]] bool setPitchSemitones(float semitones) noexcept;
    // Official NOTE C..B selects a fixed C4..B4 target (authored octave).
    [[nodiscard]] bool setFixedMidiNote(unsigned int note) noexcept;
    [[nodiscard]] bool setFormantSemitones(float semitones) noexcept;
    [[nodiscard]] bool setFormantPolicy(FormantPolicy policy) noexcept;
    [[nodiscard]] bool setPitchMode(PitchMode mode) noexcept;
    [[nodiscard]] bool setMixPercent(float percent) noexcept;

    // Advance-only alignment for a slot attached after the host's frame clock
    // has started. No event queue is needed by this parameter-driven effect.
    [[nodiscard]] bool synchronizeFrame(std::uint64_t absoluteFrame) noexcept;

    // In-place mono/stereo streaming. Arbitrary host blocks are split into
    // bounded analysis quanta; all callback storage is preallocated.
    [[nodiscard]] bool processInterleaved(float* interleaved, unsigned int frames,
                                          unsigned int channels) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] unsigned int sampleRate() const noexcept { return config_.sampleRate; }
    [[nodiscard]] unsigned int channels() const noexcept { return config_.channels; }
    [[nodiscard]] unsigned int latencyFrames() const noexcept {
        return prepared_ ? algorithmicLatencyFrames_ : 0U;
    }
    // Raw shifter algorithm delays, before common output alignment. The
    // Signalsmith path remains 40 ms at 48 kHz; TD-PSOLA is admitted only in
    // its configured F0 band and is about 29.5 ms at 48 kHz. `latencyFrames()`
    // is the common delay used to align both paths and dry audio.
    [[nodiscard]] unsigned int signalsmithAlgorithmLatencyFrames() const noexcept {
        return prepared_ ? pitchProcessor_.latencySamples() : 0U;
    }
    [[nodiscard]] unsigned int psolaAlgorithmLatencyFrames() const noexcept {
        return prepared_ ? psolaAlgorithmLatencyFrames_ : 0U;
    }
    [[nodiscard]] unsigned int psolaOutputAlignmentFrames() const noexcept {
        return prepared_ ? psolaOutputAlignmentFrames_ : 0U;
    }
    // Separate stable-pitch admission estimate: one full detector frame, then
    // enough 5 ms hops to satisfy the configured PSOLA stability gate. This is
    // not additional reported shifter latency or a measured end-to-end delay.
    [[nodiscard]] unsigned int pitchAnalysisWindowFrames() const noexcept {
        return tracker_.frameSamples * detectorDecimation_;
    }
    [[nodiscard]] unsigned int pitchAnalysisHopFrames() const noexcept {
        return tracker_.hopSamples * detectorDecimation_;
    }
    [[nodiscard]] unsigned int estimatedPitchAcquisitionFrames() const noexcept {
        return pitchAnalysisWindowFrames() +
            pitchAnalysisHopFrames() * (kMinimumStablePitchFrames - 1U);
    }
    [[nodiscard]] std::uint64_t currentFrame() const noexcept {
        return currentFrame_.load(std::memory_order_acquire);
    }
    [[nodiscard]] bool sourceVoiced() const noexcept { return tracker_.voiced; }
    [[nodiscard]] float sourceFrequencyHz() const noexcept {
        return tracker_.voiced ? tracker_.frequencyHz : 0.0f;
    }
    [[nodiscard]] float sourceMidiNote() const noexcept;
    [[nodiscard]] float sourceConfidence() const noexcept { return tracker_.confidence; }
    [[nodiscard]] float appliedPitchSemitones() const noexcept { return appliedPitchSemitones_; }
    [[nodiscard]] float appliedFormantSemitones() const noexcept { return appliedFormantSemitones_; }
    [[nodiscard]] float trackedFormantBaseHz() const noexcept { return trackedFormantBaseHz_; }
    [[nodiscard]] bool formantCompensationEnabled() const noexcept { return formantCompensationEnabled_; }
    [[nodiscard]] int targetMidiNote() const noexcept { return targetMidiNote_; }
    [[nodiscard]] bool wetActive() const noexcept { return wetActive_; }
    [[nodiscard]] ProcessingMode processingMode() const noexcept { return processingMode_; }
    [[nodiscard]] FallbackReason fallbackReason() const noexcept { return fallbackReason_; }
    [[nodiscard]] bool psolaActive() const noexcept { return processingMode_ == ProcessingMode::TdPsola; }
    [[nodiscard]] float mixPercent() const noexcept { return config_.mixPercent; }
    [[nodiscard]] FormantPolicy formantPolicy() const noexcept { return config_.formantPolicy; }

    [[nodiscard]] static bool supportsFormantPolicy(FormantPolicy policy) noexcept {
        return policy == FormantPolicy::CoupledToPitch || policy == FormantPolicy::Preserve ||
            policy == FormantPolicy::IndependentShift;
    }
    [[nodiscard]] static unsigned int calculateLatencyFrames(unsigned int sampleRate) noexcept {
        const unsigned int signalsmith = NativePolyPitchProcessor::calculateFxLatencySamples(sampleRate);
        const unsigned int psola = NativePitchProcessor::calculateLatencySamples(
            sampleRate, kPsolaMinimumFrequencyHz);
        if (signalsmith == 0U || psola == 0U) return 0U;
        return signalsmith > psola ? signalsmith : psola;
    }

private:
    static constexpr unsigned int kDetectorMaximumLag = 600U;
    static constexpr unsigned int kDetectorRingCapacity = 2048U;
    static constexpr unsigned int kDetectorRingMask = kDetectorRingCapacity - 1U;
    static constexpr unsigned int kDryRingCapacityFrames = 16384U;
    static constexpr unsigned int kDryRingMask = kDryRingCapacityFrames - 1U;
    static constexpr unsigned int kMaximumChannelsStorage = kMaximumChannels;

    struct PitchTracker final {
        std::array<float, kDetectorRingCapacity> ring{};
        std::array<double, kDetectorMaximumLag + 1U> differences{};
        std::array<double, kDetectorMaximumLag + 1U> normalizedDifferences{};
        unsigned int sampleRate = 0U;
        unsigned int minimumLag = 0U;
        unsigned int maximumLag = 0U;
        unsigned int frameSamples = 0U;
        unsigned int analysisWindowSamples = 0U;
        unsigned int hopSamples = 0U;
        unsigned int writeIndex = 0U;
        std::uint64_t sampleCount = 0U;
        std::uint64_t nextAnalysisSample = 0U;
        unsigned int goodFrames = 0U;
        unsigned int badFrames = 0U;
        unsigned int stableFrames = 0U;
        float frequencyHz = 0.0f;
        float confidence = 0.0f;
        double smoothedLogFrequency = 0.0;
        double previousMeasuredLogFrequency = 0.0;
        bool voiced = false;

        [[nodiscard]] bool configure(unsigned int detectorRate) noexcept;
        void reset() noexcept;
        void pushSample(float sample) noexcept;
        void analyzeFrame() noexcept;
    };

    [[nodiscard]] static bool validConfig(const Config& config) noexcept;
    [[nodiscard]] bool applyRuntimeConfig(const Config& config) noexcept;
    [[nodiscard]] bool updatePitchTarget() noexcept;
    void selectProcessingMode() noexcept;

    NativePolyPitchProcessor pitchProcessor_{};
    NativePitchProcessor psolaLeft_{};
    NativePitchProcessor psolaRight_{};
    PitchTracker tracker_{};
    std::array<float, kDryRingCapacityFrames * kMaximumChannelsStorage> dryRing_{};
    std::array<float, kDryRingCapacityFrames * kMaximumChannelsStorage> psolaAlignmentRing_{};
    std::array<float, kMaximumControlQuantumFrames> psolaLeftScratch_{};
    std::array<float, kMaximumControlQuantumFrames> psolaRightScratch_{};
    std::atomic<std::uint64_t> currentFrame_{0U};
    Config config_{};
    unsigned int detectorDecimation_ = 1U;
    unsigned int algorithmicLatencyFrames_ = 0U;
    unsigned int psolaAlgorithmLatencyFrames_ = 0U;
    unsigned int psolaOutputAlignmentFrames_ = 0U;
    unsigned int decimatorCount_ = 0U;
    double decimatorSum_ = 0.0;
    float appliedPitchSemitones_ = 0.0f;
    float appliedFormantSemitones_ = 0.0f;
    float trackedFormantBaseHz_ = 0.0f;
    float lastConfiguredFormantSemitones_ = 0.0f;
    float lastConfiguredFormantBaseHz_ = 0.0f;
    int fixedMidiNote_ = -1;
    int targetMidiNote_ = -1;
    int quantizedPitchTargetMidiNote_ = -1;
    bool wetActive_ = false;
    bool formantCompensationEnabled_ = false;
    bool hasConfiguredFormant_ = false;
    bool hasConfiguredFormantBase_ = false;
    ProcessingMode processingMode_ = ProcessingMode::SignalsmithFallback;
    FallbackReason fallbackReason_ = FallbackReason::Unvoiced;
    bool prepared_ = false;
};

} // namespace webrc::native
