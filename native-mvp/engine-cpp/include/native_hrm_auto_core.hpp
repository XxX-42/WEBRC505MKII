#pragma once

#include "native_poly_pitch_processor.hpp"
#include "dsp_primitives.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace webrc::native {

// Provisional clean-room Native HRM AUTO core. MIDI chord notes are quantized
// to a key/scale, assigned to up to two Signalsmith pitch-shifter voices, and
// mixed with a latency-aligned dry path. The audio callback path uses fixed
// storage only. Configure/reset on the DSP-owner thread; enqueueMidi is a
// single-producer operation and processInterleaved is its single consumer.
//
// Source tracking is deliberately monophonic YIN/CMND analysis. Polyphonic
// source separation and production-quality tracking are out of scope here;
// voiced-chord quality and musical behavior still need listening acceptance.
class NativeHrmAutoCore final {
public:
    static constexpr unsigned int kMinimumSampleRate = NativePolyPitchProcessor::kMinimumSampleRate;
    static constexpr unsigned int kMaximumSampleRate = NativePolyPitchProcessor::kMaximumSampleRate;
    static constexpr unsigned int kMaximumChannels = NativePolyPitchProcessor::kMaximumChannels;
    static constexpr unsigned int kMaximumProcessFrames = 4096U;
    static constexpr unsigned int kMaximumControlQuantumFrames = 256U;
    static constexpr unsigned int kMidiNoteCount = 128U;
    static constexpr unsigned int kMidiQueueCapacity = 256U;

    enum class Scale : std::uint8_t {
        Major = 0U,
        NaturalMinor = 1U,
        HarmonicMinor = 2U,
        Dorian = 3U,
        Mixolydian = 4U
    };

    struct Config final {
        unsigned int sampleRate = 48000U;
        unsigned int channels = 2U;
        std::uint8_t key = 0U;          // C=0, C#=1, ..., B=11
        Scale scale = Scale::Major;
        std::uint8_t midiChannel = 1U; // MIDI channel number, 1..16
        float mixPercent = 70.0f;      // 0..100; Browser HRM AUTO default
    };

    // Standard MIDI channel-voice note message. Status uses 0x8n / 0x9n,
    // where n is the zero-based MIDI channel; data1 is note and data2 velocity.
    // frame is an absolute sample frame from currentFrame().
    struct MidiEvent final {
        std::uint64_t frame = 0U;
        std::uint8_t status = 0U;
        std::uint8_t data1 = 0U;
        std::uint8_t data2 = 0U;
    };

    NativeHrmAutoCore() noexcept = default;

    [[nodiscard]] bool prepare(const Config& config) noexcept;
    // Control-thread operation. If sampleRate/channels change this re-prepares
    // DSP storage and clears streaming state; other values update in-place.
    [[nodiscard]] bool configure(const Config& config) noexcept;
    // Bounded SPSC queue. Returns false for invalid, wrong-channel, out-of-order,
    // too-late, or full-queue events. Events must be submitted before the audio
    // callback enters the control quantum containing their frame.
    [[nodiscard]] bool enqueueMidi(const MidiEvent& event) noexcept;
    // DSP-owner-thread clock alignment for a slot selected after the engine has
    // started. Advances only; pending note events before the new frame are
    // consumed to reconstruct held-note state and counted as late.
    [[nodiscard]] bool synchronizeFrame(std::uint64_t absoluteFrame) noexcept;
    void reset() noexcept;
    // Independent hardware-facing path. Legacy configuration and two-voice
    // behavior remain unchanged until a validated official control is used.
    [[nodiscard]] bool setOfficialParameter(std::string_view id, float value, bool manual = false) noexcept;
    void disableOfficialControls() noexcept;
    [[nodiscard]] bool officialControlsActive() const noexcept { return officialActive_; }

    // In-place mono/stereo processing. Arbitrarily large host blocks are split
    // into bounded work segments; no heap allocations occur here.
    [[nodiscard]] bool processInterleaved(float* interleaved, unsigned int frames,
                                          unsigned int channels) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return config_.sampleRate; }
    [[nodiscard]] unsigned int channels() const noexcept { return config_.channels; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] unsigned int latencyFrames() const noexcept {
        return prepared_ ? voiceA_.latencySamples() : 0U;
    }
    [[nodiscard]] std::uint64_t currentFrame() const noexcept {
        return currentFrame_.load(std::memory_order_acquire);
    }
    [[nodiscard]] unsigned int queueDepth() const noexcept {
        const std::uint32_t head = queueHead_.load(std::memory_order_acquire);
        const std::uint32_t tail = queueTail_.load(std::memory_order_acquire);
        return static_cast<unsigned int>(head - tail);
    }
    [[nodiscard]] std::uint64_t overflowCount() const noexcept {
        return overflowCount_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::uint64_t rejectedEventCount() const noexcept {
        return rejectedEventCount_.load(std::memory_order_acquire);
    }
    // Optional host-adapter accounting for events it rejects before enqueue.
    void recordLateExternalSubmission() noexcept {
        lateEventCount_.fetch_add(1U, std::memory_order_relaxed);
    }
    void recordRejectedExternalSubmission() noexcept {
        rejectedEventCount_.fetch_add(1U, std::memory_order_relaxed);
    }
    void recordExternalQueueOverflow() noexcept {
        overflowCount_.fetch_add(1U, std::memory_order_relaxed);
    }
    [[nodiscard]] bool sourceVoiced() const noexcept { return tracker_.voiced; }
    [[nodiscard]] float sourceFrequencyHz() const noexcept { return tracker_.voiced ? tracker_.frequencyHz : 0.0f; }
    [[nodiscard]] float sourceMidiNote() const noexcept;
    [[nodiscard]] float sourceConfidence() const noexcept { return tracker_.confidence; }
    [[nodiscard]] unsigned int activeVoiceCount() const noexcept { return voiceCount_; }
    [[nodiscard]] int targetMidiNote(unsigned int voice) const noexcept {
        return voice < voiceCount_ ? targetMidiNotes_[voice] : -1;
    }
    [[nodiscard]] float targetSemitones(unsigned int voice) const noexcept {
        return voice < voiceCount_ ? targetSemitones_[voice] : 0.0f;
    }
    [[nodiscard]] unsigned int heldNoteCount() const noexcept { return heldNoteCount_; }
    [[nodiscard]] float mixPercent() const noexcept { return config_.mixPercent; }
    [[nodiscard]] std::uint64_t lateEventCount() const noexcept {
        return lateEventCount_.load(std::memory_order_acquire);
    }

    [[nodiscard]] static unsigned int calculateLatencyFrames(unsigned int sampleRate) noexcept {
        return NativePolyPitchProcessor::calculateFxLatencySamples(sampleRate);
    }

private:
    static constexpr unsigned int kDetectorMaximumLag = 600U;
    static constexpr unsigned int kDetectorRingCapacity = 2048U;
    static constexpr unsigned int kDetectorRingMask = kDetectorRingCapacity - 1U;
    static constexpr unsigned int kDryRingCapacityFrames = 16384U;
    static constexpr unsigned int kDryRingMask = kDryRingCapacityFrames - 1U;
    static constexpr unsigned int kScratchSamples = kMaximumControlQuantumFrames * kMaximumChannels;

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
        float frequencyHz = 0.0f;
        float confidence = 0.0f;
        double smoothedLogFrequency = 0.0;
        bool voiced = false;

        [[nodiscard]] bool configure(unsigned int detectorRate) noexcept;
        void reset() noexcept;
        void pushSample(float sample) noexcept;
        void analyzeFrame() noexcept;
    };

    [[nodiscard]] static bool validConfig(const Config& config) noexcept;
    [[nodiscard]] static int pitchClass(int midiNote) noexcept;
    [[nodiscard]] static const std::array<int, 7U>& scaleOffsets(Scale scale) noexcept;
    [[nodiscard]] int snapMidiToScale(int midiNote) const noexcept;
    [[nodiscard]] int diatonicInterval(int snappedRoot, unsigned int degreeOffset) const noexcept;
    [[nodiscard]] int nearestOctave(int midiNote, float sourceMidi) const noexcept;
    [[nodiscard]] unsigned int collectTargets(std::array<int, 2U>& targets) const noexcept;
    void handleMidi(const MidiEvent& event) noexcept;
    void updateVoiceTargets() noexcept;
    [[nodiscard]] float officialShift(float sourceMidi) const noexcept;
    [[nodiscard]] bool processSegment(float* interleaved, unsigned int frames,
                                      std::uint64_t segmentStart) noexcept;
    [[nodiscard]] bool peekEvent(MidiEvent& event) const noexcept;
    [[nodiscard]] bool popEvent(MidiEvent& event) noexcept;
    void clearEventQueue() noexcept;

    NativePolyPitchProcessor voiceA_{};
    NativePolyPitchProcessor voiceB_{};
    PitchTracker tracker_{};
    std::array<float, kScratchSamples> voiceAScratch_{};
    std::array<float, kScratchSamples> voiceBScratch_{};
    std::array<float, kDryRingCapacityFrames * kMaximumChannels> dryRing_{};
    std::array<std::uint8_t, kMidiNoteCount> heldNoteRefs_{};
    std::array<MidiEvent, kMidiQueueCapacity> eventQueue_{};
    std::atomic<std::uint32_t> queueHead_{0U}; // producer-owned publication counter
    std::atomic<std::uint32_t> queueTail_{0U}; // consumer-owned publication counter
    std::atomic<std::uint64_t> currentFrame_{0U};
    std::atomic<std::uint64_t> enqueueFloorFrame_{0U};
    Config config_{};
    std::uint64_t lastEnqueuedFrame_ = 0U;
    std::atomic<std::uint64_t> lateEventCount_{0U};
    std::atomic<std::uint64_t> overflowCount_{0U};
    std::atomic<std::uint64_t> rejectedEventCount_{0U};
    unsigned int heldNoteCount_ = 0U;
    unsigned int detectorDecimation_ = 1U;
    unsigned int decimatorCount_ = 0U;
    double decimatorSum_ = 0.0;
    unsigned int voiceCount_ = 0U;
    std::array<int, 2U> targetMidiNotes_{{-1, -1}};
    std::array<float, 2U> targetSemitones_{{0.0f, 0.0f}};
    bool hasLastEnqueuedFrame_ = false;
    bool officialActive_ = false;
    bool officialManual_ = false;
    unsigned int officialVoice_ = 4U;
    unsigned int officialKey_ = 0U;
    unsigned int officialMode_ = 1U;
    float officialFormant_ = 0.0f;
    dsp::ParameterSmoother officialPan_{0.0f};
    dsp::ParameterSmoother officialDirect_{1.0f};
    dsp::ParameterSmoother officialHarmony_{0.8f};
    bool prepared_ = false;
};

} // namespace webrc::native
