#pragma once

#include "webrc/dsp/synthesis_pitch_fx.hpp"
#include "webrc/dsp/vocoder_fx.hpp"

#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <variant>

namespace webrc::dsp {

// Local adapter kinds deliberately do not consume the global factory ordinal
// namespace.  The existing processors retain ownership of their DSP and their
// official catalog ordinals.
enum class MusicalFxKind : std::uint8_t {
    Unprepared = 0U,
    Synth = 1U,          // catalog ordinal 6
    GuitarToBass = 2U,   // catalog ordinal 10
    AutoRiff = 3U,       // catalog ordinal 12
    Robot = 4U,          // catalog ordinal 16
    Electric = 5U,       // catalog ordinal 17
    HarmonyAuto = 6U,    // catalog ordinal 19
    Vocoder = 7U,        // catalog ordinal 20; requires external stereo carrier
    OscVocMidi = 8U,     // catalog ordinal 21; internal oscillator + timed MIDI
    OscBot = 9U,         // catalog ordinal 22
};

using MusicalFxOptions = std::variant<SynthFxOptions, GuitarToBassFxOptions,
    AutoRiffFxOptions, HarmonyAutoFxOptions, RobotFxOptions, ElectricFxOptions,
    VocoderFxOptions, OscBotFxOptions>;

// Semantic parameters supported by the currently wrapped processors.  A
// parameter is valid only for the selected kind; this enum is not the global
// official UI parameter contract.
enum class MusicalFxParameter : std::uint8_t {
    Active,
    Mix,
    Frequency,
    Resonance,
    Decay,
    Balance,
    Mode,
    Phrase,
    TempoBpm,
    Hold,
    Loop,
    Attack,
    Key,
    Voice,
    Formant,
    Pan,
    DryLevel,
    HarmonyLevel,
    NoteClass,
    ShiftSemitones,
    Speed,
    Stability,
    ScaleRoot,
    Waveform,
    Tone,
    OscNote,
    ModulationSensitivity,
    Pattern,
    OutputDb,
    EnvelopeAttackMs,
    EnvelopeReleaseMs,
};

enum class MusicalFxEventType : std::uint8_t {
    Parameter,
    MidiNoteOn,
    MidiNoteOff,
    MidiAllNotesOff,
};

// One ordered stream keeps parameter and MIDI events under the same 64-event
// limit and transaction. MIDI is currently single-channel (channel 0); the
// channel field is explicit so hosts cannot accidentally smuggle channel data
// through a float parameter. NoteOn velocity must be 1..127; NoteOff velocity
// is accepted as 0..127 and ignored by the wrapped mono-target processors.
struct MusicalFxEvent {
    std::uint32_t frameOffset = 0U;
    MusicalFxEventType type = MusicalFxEventType::Parameter;
    MusicalFxParameter parameter = MusicalFxParameter::Active;
    float value = 0.0f;
    std::uint8_t channel = 0U;
    std::uint8_t note = 60U;
    std::uint8_t velocity = 100U;
};

struct MusicalFxLatency {
    std::uint32_t fixedAlgorithmicSamples = 0U;
    std::uint32_t analysisWindowFrames = 0U;
    std::uint32_t analysisHopFrames = 0U;
    std::uint32_t psolaLookaheadSamples = 0U;
    std::uint32_t conservativePitchOnsetFrames = 0U;
    bool pitchAnalysisCold = true;
};

// Typed runtime facade over the existing clean-room musical processors. Setup
// allocates a fresh variant off the callback, prepares it completely, then
// swaps it in. On failure the previous processor remains usable. The caller
// must serialize prepare/reset against processing and provide a peak budget;
// replacing a prepared instance temporarily retains both old and candidate
// storage. The audio path uses fixed stack event translation and delegates to
// each processor's transactional, sample-accurate event validator.
class MusicalFxAdapter final {
public:
    static constexpr std::uint32_t kMaximumEventsPerBlock = 64U;

    MusicalFxAdapter() noexcept;
    ~MusicalFxAdapter();
    MusicalFxAdapter(const MusicalFxAdapter&) = delete;
    MusicalFxAdapter& operator=(const MusicalFxAdapter&) = delete;
    MusicalFxAdapter(MusicalFxAdapter&&) = delete;
    MusicalFxAdapter& operator=(MusicalFxAdapter&&) = delete;

    [[nodiscard]] static MusicalFxKind kindForOptions(const MusicalFxOptions& options) noexcept;
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const MusicalFxOptions& options) noexcept;

    // maximumPeakBytes covers the old prepared instance plus the complete
    // candidate during replacement. Pass SIZE_MAX only when the host has
    // already performed admission against its own aggregate graph ledger.
    bool prepare(const ProcessSpec& spec, const MusicalFxOptions& options,
                 std::size_t maximumPeakBytes = std::numeric_limits<std::size_t>::max());
    [[nodiscard]] std::size_t replacementPeakBytes(
        const ProcessSpec& spec, const MusicalFxOptions& options) const noexcept;
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;

    // Interleaved, independent L/R input/output in-place. All event types in
    // the single stream count toward the 64-event capacity.
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const MusicalFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    // Only catalog ordinal 20 accepts this path. The carrier is a read-only
    // stereo buffer with exactly `frames` samples; null or a wrong-kind call
    // fails before audio or DSP state changes. VOCODER20 has no oscillator or
    // fallback carrier path.
    bool processBlockWithCarrier(std::uint64_t blockStartFrame, StereoFrame* modulator,
                      const StereoFrame* carrier, std::uint32_t frames,
                      const MusicalFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept;
    [[nodiscard]] MusicalFxKind kind() const noexcept { return kind_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] MusicalFxLatency latency() const noexcept;
    [[nodiscard]] std::uint16_t catalogOrdinal() const noexcept;
    [[nodiscard]] PitchEstimate pitchEstimate(std::uint32_t channel) const noexcept;

private:
    struct ProcessorStorage;
    bool processInternal(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                         const StereoFrame* carrier, std::uint32_t frames,
                         const MusicalFxEvent* events, std::uint32_t eventCount,
                         bool carrierPath) noexcept;

    std::unique_ptr<ProcessorStorage> active_{};
    ProcessSpec spec_{};
    MusicalFxKind kind_ = MusicalFxKind::Unprepared;
    std::size_t preparedBytes_ = 0U;
};

} // namespace webrc::dsp
