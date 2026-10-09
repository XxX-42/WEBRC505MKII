#pragma once

#include "webrc/dsp/pitch.hpp"
#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kVocoderFxApiVersion = 1U;

enum class VocoderFxKind : std::uint8_t {
    Vocoder,
    OscVocMidi,
};

// Clean-room oscillator carriers for OSC VOC(M). These are distinct real
// oscillator shapes; Vintage is a band-limited saw with an inverted 20% sine
// blend that aligns the saw fundamental and reduces its upper harmonics, and
// Rect is a band-limited saw-difference pulse. They do not claim sample-for-
// sample Roland emulation.
enum class OscVocWaveform : std::uint8_t {
    Saw,
    Vintage,
    Detune,
    Square,
    Rect,
};

enum class VocoderFxControl : std::uint8_t {
    Active,
    Mix,
    OutputDb,
    EnvelopeAttackMs,
    EnvelopeReleaseMs,
    MidiNoteOn,
    MidiNoteOff,
    MidiAllNotesOff,
    Waveform,
};

struct VocoderFxOptions {
    VocoderFxKind kind = VocoderFxKind::Vocoder;
    std::uint32_t bandCount = 16U;
    float minimumBandHz = 80.0f;
    float maximumBandHz = 10000.0f;
    float bandQ = 1.25f;
    float envelopeAttackMs = 8.0f;
    float envelopeReleaseMs = 90.0f;
    float oscillatorAttackMs = 5.0f;
    float oscillatorReleaseMs = 90.0f;
    float controlSmoothingMs = 10.0f;
    float carrierStereoWidth = 0.24f;
    OscVocWaveform waveform = OscVocWaveform::Saw;
};

struct VocoderFxEvent {
    // Sample-accurate, ordered event. MidiNoteOn uses midiNote plus velocity
    // in value as a normalized [0, 1] amplitude; velocity zero follows MIDI
    // note-on-zero note-off behavior.
    std::uint32_t frameOffset = 0U;
    VocoderFxControl control = VocoderFxControl::Active;
    std::uint8_t midiNote = 60U;
    float value = 0.0f;
};

struct VocoderFxLatency {
    // No whole-sample buffering is added. Multiband bandpass/detector response
    // has frequency-dependent group delay that is not a fixed host latency.
    std::int32_t fixedAlgorithmicSamples = 0;
};

// Standalone, stereo-linked clean-room processors for catalog ordinals 20 and
// 21. VOCODER20 requires an external stereo carrier buffer and accepts no
// internal/fabricated source; its host must route the selected MIC/INST/TRACK
// carrier or reject an unavailable route. OSC VOC(M) starts silent and accepts
// bounded sample-accurate MIDI events, including same-sample chords. It
// supports eight active notes, five distinct oscillator shapes and 64 fixed
// retirement tails for voice stealing. A block is rejected transactionally if
// all tails required by its chords cannot fit. The modulator analysis follows
// the shared L/R magnitude detector; carrier, wet output and dry paths retain
// independent L/R channels.
class VocoderFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    static constexpr std::size_t kVoiceCount = 8U;
    static constexpr std::size_t kRetiredVoiceCount = 64U;
    static constexpr std::uint32_t kVoiceStealFadeSamples = 64U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const VocoderFxOptions& options = {}) noexcept;
    bool prepare(const ProcessSpec& spec, const VocoderFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    // OSC VOC(M) oscillator-carrier path. Rejected for VOCODER20.
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const VocoderFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;
    // VOCODER20 external-carrier path. `interleaved` is the stereo modulator
    // and `carrier` is a read-only stereo carrier with the same frame count.
    // A null/unknown carrier is rejected before audio or state changes.
    bool processBlockWithCarrier(std::uint64_t blockStartFrame,
                      StereoFrame* interleaved, const StereoFrame* carrier,
                      std::uint32_t frames, const VocoderFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] VocoderFxKind kind() const noexcept { return options_.kind; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] std::uint32_t bandCount() const noexcept { return vocoder_.bandCount(); }
    [[nodiscard]] std::uint32_t activeVoices() const noexcept;
    [[nodiscard]] std::uint32_t retiredVoices() const noexcept;
    [[nodiscard]] std::uint64_t retiredVoiceOverflowCount() const noexcept {
        return retiredVoiceOverflowCount_;
    }
    [[nodiscard]] VocoderFxLatency latency() const noexcept { return {}; }
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal(VocoderFxKind kind) noexcept {
        return kind == VocoderFxKind::Vocoder ? 20U : 21U;
    }

private:
    struct Voice {
        PolyBlepOscillator oscillatorLeft{};
        PolyBlepOscillator oscillatorRight{};
        PolyBlepOscillator vintageSineLeft{};
        PolyBlepOscillator vintageSineRight{};
        PolyBlepOscillator rectangleLeft{};
        PolyBlepOscillator rectangleRight{};
        PolyBlepOscillator previousWaveformLeft{};
        PolyBlepOscillator previousWaveformRight{};
        PolyBlepOscillator previousVintageSineLeft{};
        PolyBlepOscillator previousVintageSineRight{};
        PolyBlepOscillator previousRectangleLeft{};
        PolyBlepOscillator previousRectangleRight{};
        OscVocWaveform waveform = OscVocWaveform::Saw;
        OscVocWaveform previousWaveform = OscVocWaveform::Saw;
        std::uint32_t waveformFadeRemaining = 0U;
        std::uint8_t note = 0U;
        float envelope = 0.0f;
        float targetEnvelope = 0.0f;
        float velocityGain = 1.0f;
        std::uint64_t age = 0U;
        std::uint64_t startedFrame = 0U;
        bool active = false;
    };
    struct RetiredVoice {
        PolyBlepOscillator oscillatorLeft{};
        PolyBlepOscillator oscillatorRight{};
        PolyBlepOscillator vintageSineLeft{};
        PolyBlepOscillator vintageSineRight{};
        PolyBlepOscillator rectangleLeft{};
        PolyBlepOscillator rectangleRight{};
        PolyBlepOscillator previousWaveformLeft{};
        PolyBlepOscillator previousWaveformRight{};
        PolyBlepOscillator previousVintageSineLeft{};
        PolyBlepOscillator previousVintageSineRight{};
        PolyBlepOscillator previousRectangleLeft{};
        PolyBlepOscillator previousRectangleRight{};
        OscVocWaveform waveform = OscVocWaveform::Saw;
        OscVocWaveform previousWaveform = OscVocWaveform::Saw;
        std::uint32_t waveformFadeRemaining = 0U;
        float gain = 0.0f;
        std::uint32_t remaining = 0U;
    };

    [[nodiscard]] static bool validOptions(const ProcessSpec& spec,
                                           const VocoderFxOptions& options) noexcept;
    [[nodiscard]] bool validateEvents(std::uint64_t blockStartFrame,
                                      std::uint32_t frames,
                                      const VocoderFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const VocoderFxEvent& event) const noexcept;
    bool processBlockInternal(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                              const StereoFrame* externalCarrier, std::uint32_t frames,
                              const VocoderFxEvent* events,
                              std::uint32_t eventCount) noexcept;
    void applyEvent(const VocoderFxEvent& event) noexcept;
    void setWaveform(OscVocWaveform waveform) noexcept;
    void noteOn(std::uint8_t note, float velocity) noexcept;
    void noteOff(std::uint8_t note) noexcept;
    void retireVoice(Voice& voice) noexcept;
    void updateVoiceEnvelopeCoefficients() noexcept;
    [[nodiscard]] StereoFrame renderCarrier() noexcept;
    [[nodiscard]] static float noteFrequencyHz(std::uint8_t note) noexcept;
    void advanceControls() noexcept;

    ProcessSpec spec_{};
    VocoderFxOptions options_{};
    MultibandVocoder vocoder_{};
    std::array<Voice, kVoiceCount> voices_{};
    std::array<RetiredVoice, kRetiredVoiceCount> retired_{};
    std::uint64_t expectedFrame_ = 0U;
    std::uint64_t processingFrame_ = 0U;
    std::uint64_t noteAge_ = 0U;
    std::uint64_t retiredVoiceOverflowCount_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double controlSmoothingCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 1.0f;
    float mixCurrent_ = 1.0f;
    float outputGainTarget_ = 1.0f;
    float outputGainCurrent_ = 1.0f;
    float oscillatorAttackCoefficient_ = 0.0f;
    float oscillatorReleaseCoefficient_ = 0.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
