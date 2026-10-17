#pragma once

#include "native_poly_pitch_processor.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace webrc::native {

// Clean-room, monophonic AUTO RIFF processor core. A bounded YIN/CMND tracker
// estimates the played note, quantizes it to the selected C-rooted scale, and
// uses a sample-clocked eight-step riff to drive the pinned Signalsmith
// polyphonic pitch shifter. Configure and reset on the DSP-owner thread; the
// streaming methods allocate no memory and take no locks.
class NativeAutoRiffCore final {
public:
    static constexpr unsigned int kMinimumSampleRate = NativePolyPitchProcessor::kMinimumSampleRate;
    static constexpr unsigned int kMaximumSampleRate = NativePolyPitchProcessor::kMaximumSampleRate;
    static constexpr unsigned int kMaximumChannels = NativePolyPitchProcessor::kMaximumChannels;
    static constexpr unsigned int kMaximumProcessFrames = 4096U;
    static constexpr unsigned int kMaximumControlQuantumFrames = 256U;
    static constexpr float kMinimumTempoBpm = 20.0f;
    static constexpr float kMaximumTempoBpm = 300.0f;

    NativeAutoRiffCore() noexcept = default;

    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    // Supported names are scale, rate/stepRate, sensitivity, mix, and their
    // auto-riff.* catalog IDs. Invalid or non-finite values are rejected.
    [[nodiscard]] bool setParameter(std::string_view name, float value) noexcept;
    [[nodiscard]] bool setTempoBpm(float bpm) noexcept;
    void reset() noexcept;

    // In-place mono or stereo. A stream must keep the channel count selected
    // on its first non-empty call. Larger host blocks are split into bounded
    // control and Signalsmith work segments internally.
    [[nodiscard]] bool processInterleaved(float* interleaved, unsigned int frames,
                                          unsigned int channels) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    // Fixed output audio-path delay from the Signalsmith FX preset. Initial
    // pitch lock-on time is a separate control-analysis delay, exposed below.
    [[nodiscard]] unsigned int latencySamples() const noexcept {
        return prepared_ ? shifter_.latencySamples() : 0U;
    }
    // Approximate samples from a new voiced input to the detector's first
    // stable estimate; this is not extra host-compensated output delay.
    [[nodiscard]] unsigned int detectorLatencySamples() const noexcept { return detectorLatencySamples_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] bool voiced() const noexcept { return voiced_; }
    [[nodiscard]] float detectedFrequencyHz() const noexcept { return voiced_ ? detectedFrequencyHz_ : 0.0f; }
    [[nodiscard]] float confidence() const noexcept { return confidence_; }
    [[nodiscard]] int rootMidiNote() const noexcept { return rootMidiNote_; }
    [[nodiscard]] int currentStep() const noexcept { return sequenceRunning_ ? stepIndex_ : -1; }
    [[nodiscard]] float targetSemitones() const noexcept { return targetSemitones_; }
    [[nodiscard]] float tempoBpm() const noexcept { return tempoBpm_; }
    [[nodiscard]] float stepRateBeats() const noexcept { return stepRateBeats_; }
    [[nodiscard]] float sensitivity() const noexcept { return sensitivity_; }
    [[nodiscard]] unsigned int stepPeriodSamples() const noexcept { return stepPeriodSamples_; }
    [[nodiscard]] std::uint64_t sampleCursor() const noexcept { return sampleCursor_; }

    [[nodiscard]] static unsigned int calculateLatencySamples(unsigned int sampleRate) noexcept {
        return NativePolyPitchProcessor::calculateFxLatencySamples(sampleRate);
    }

private:
    static constexpr unsigned int kMaximumDetectorLag = 600U;
    static constexpr unsigned int kMaximumDetectorRing = 4096U;
    static constexpr unsigned int kDryRingCapacityFrames = 16384U;
    static constexpr unsigned int kDryRingMask = kDryRingCapacityFrames - 1U;
    static constexpr unsigned int kRiffLength = 8U;

    struct YinTracker final {
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
        unsigned int goodFrames = 0U;
        unsigned int badFrames = 0U;
        float frequencyHz = 0.0f;
        float confidence = 0.0f;
        float smoothedLogFrequency = 0.0f;
        bool voiced = false;

        [[nodiscard]] bool configure(unsigned int detectorRate) noexcept;
        void reset() noexcept;
        void pushSample(float sample) noexcept;
        void analyzeFrame() noexcept;
    };

    [[nodiscard]] static unsigned int nextPowerOfTwo(unsigned int value) noexcept;
    [[nodiscard]] static bool validStepRate(float value) noexcept;
    [[nodiscard]] static int quantizeMidiToScale(float frequencyHz, unsigned int scale) noexcept;
    [[nodiscard]] static int scaleDegreeSemitone(unsigned int scale, unsigned int degree) noexcept;
    [[nodiscard]] unsigned int calculateStepPeriod() const noexcept;
    [[nodiscard]] float calculateStepSemitones() const noexcept;
    void processDetectorSample(float mono, std::uint64_t absoluteFrame) noexcept;
    void updateVoicing(std::uint64_t absoluteFrame) noexcept;
    void handleOnset(std::uint64_t absoluteFrame) noexcept;
    void advanceSequenceAt(std::uint64_t absoluteFrame) noexcept;
    void startSequence(std::uint64_t absoluteFrame) noexcept;
    void updateTargetSemitones() noexcept;

    NativePolyPitchProcessor shifter_{};
    YinTracker detector_{};
    std::array<float, kDryRingCapacityFrames * kMaximumChannels> dryRing_{};
    std::array<std::uint64_t, kDryRingCapacityFrames> dryGeneration_{};

    unsigned int sampleRate_ = 0U;
    unsigned int detectorDecimation_ = 1U;
    unsigned int detectorLatencySamples_ = 0U;
    unsigned int stepPeriodSamples_ = 0U;
    unsigned int stepIndex_ = 0U;
    unsigned int scale_ = 0U;
    unsigned int channelCount_ = 0U;
    std::uint64_t sampleCursor_ = 0U;
    std::uint64_t nextStepSample_ = 0U;
    std::uint64_t resetGeneration_ = 1U;
    std::uint64_t lastOnsetSample_ = 0U;
    std::uint64_t lastDetectorSerial_ = 0U;
    std::uint64_t onsetRefractorySamples_ = 1U;
    unsigned int decimatorCount_ = 0U;
    double decimatorSum_ = 0.0;
    float tempoBpm_ = 120.0f;
    float stepRateBeats_ = 0.5f;
    float sensitivity_ = 55.0f;
    float mix_ = 0.65f;
    float onsetFastCoefficient_ = 0.0f;
    float onsetSlowCoefficient_ = 0.0f;
    float fastEnvelope_ = 0.0f;
    float slowEnvelope_ = 0.0f;
    float detectedFrequencyHz_ = 0.0f;
    float confidence_ = 0.0f;
    float targetSemitones_ = 0.0f;
    float appliedSemitones_ = 0.0f;
    int rootMidiNote_ = -1;
    bool voiced_ = false;
    bool sequenceRunning_ = false;
    bool prepared_ = false;
};

} // namespace webrc::native
