#pragma once

#include "webrc/dsp/control_dynamics.hpp"
#include "webrc/dsp/primitives.hpp"
#include "webrc/dsp/voice_fx.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kSynthesisPitchFxApiVersion = 1U;

struct SynthesisPitchFxLatency {
    std::uint32_t fixedAlgorithmicSamples = 0U;
    std::uint32_t analysisWindowFrames = 0U;
    std::uint32_t analysisHopFrames = 0U;
    std::uint32_t psolaLookaheadSamples = 0U;
    bool pitchAnalysisCold = true;
};

enum class SynthFxControl : std::uint8_t { Active, Frequency, Resonance, Decay, Balance };
struct SynthFxOptions {
    float frequency = 50.0f;
    float resonance = 50.0f;
    float decay = 50.0f;
    float balance = 50.0f;
};
struct SynthFxEvent {
    std::uint32_t frameOffset = 0U;
    SynthFxControl control = SynthFxControl::Active;
    float value = 0.0f;
};

// Clean-room monophonic-input synthesizer. Published macro ranges are stored
// separately; this adapter interprets FREQUENCY as resonant low-pass cutoff,
// RESONANCE as Q, DECAY as the tracked envelope release, and BALANCE as dry/wet.
// Two independent incremental pitch estimates control band-limited oscillators.
class SynthFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec) noexcept;
    bool prepare(const ProcessSpec& spec, const SynthFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const SynthFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] SynthesisPitchFxLatency latency() const noexcept;
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 6U; }

private:
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const SynthFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const SynthFxEvent& event) const noexcept;
    void applyEvent(const SynthFxEvent& event) noexcept;
    void updateFilterTargets(float smoothingMs) noexcept;

    ProcessSpec spec_{};
    SynthFxOptions options_{};
    YinPsolaStereoPath pitchAnalysis_{};
    std::array<OnsetDetector, 2U> onset_{};
    std::array<TptStateVariableFilter, 2U> filters_{};
    std::array<PolyBlepOscillator, 2U> mainOscillator_{};
    std::array<PolyBlepOscillator, 2U> subOscillator_{};
    std::array<float, 2U> inputEnvelope_{};
    std::array<float, 2U> onsetEnvelope_{};
    std::array<float, 2U> oscillatorFrequency_{};
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double releaseCoefficient_ = 0.0;
    double controlCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float balanceTarget_ = 0.5f;
    float balanceCurrent_ = 0.5f;
    float frequencyCurrent_ = 50.0f;
    float resonanceCurrent_ = 50.0f;
    float decayCurrent_ = 50.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

enum class GuitarToBassMode : std::uint8_t { DividerBlend = 1U, PsolaBody = 2U };
enum class GuitarToBassControl : std::uint8_t { Active, Balance, Mode };
struct GuitarToBassFxOptions {
    float balance = 50.0f;
    GuitarToBassMode mode = GuitarToBassMode::PsolaBody;
};
struct GuitarToBassFxEvent {
    std::uint32_t frameOffset = 0U;
    GuitarToBassControl control = GuitarToBassControl::Active;
    float value = 0.0f;
};

// Octave-down guitar resynthesis. MODE 1 blends PSOLA with tracked band-limited
// square subharmonics; MODE 2 emphasizes the PSOLA signal through stereo body
// EQ. Both preserve the original L/R pitch analysis and independent audio paths.
class GuitarToBassFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec) noexcept;
    bool prepare(const ProcessSpec& spec, const GuitarToBassFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const GuitarToBassFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] SynthesisPitchFxLatency latency() const noexcept;
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 10U; }

private:
    [[nodiscard]] bool validateEvents(std::uint32_t frames,
                                      const GuitarToBassFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const GuitarToBassFxEvent& event) const noexcept;
    void applyEvent(const GuitarToBassFxEvent& event) noexcept;
    void updatePitchTargets() noexcept;

    ProcessSpec spec_{};
    GuitarToBassFxOptions options_{};
    YinPsolaStereoPath pitchPath_{};
    std::array<PolyBlepOscillator, 2U> subOscillator_{};
    std::array<BiquadDf2T, 2U> bodyFilter_{};
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double controlCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float balanceTarget_ = 0.5f;
    float balanceCurrent_ = 0.5f;
    float modeMixTarget_ = 1.0f;
    float modeMixCurrent_ = 1.0f;
    GuitarToBassMode modeCurrent_ = GuitarToBassMode::PsolaBody;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

enum class AutoRiffControl : std::uint8_t {
    Active, Phrase, TempoBpm, Hold, Loop, Attack, Key, Balance
};
struct AutoRiffFxOptions {
    std::uint8_t phrase = 1U;
    float tempoBpm = 120.0f;
    bool hold = false;
    bool loop = true;
    float attack = 20.0f;
    std::uint8_t key = 0U;
    float balance = 70.0f;
};
struct AutoRiffFxEvent {
    std::uint32_t frameOffset = 0U;
    AutoRiffControl control = AutoRiffControl::Active;
    float value = 0.0f;
};

// Thirty deterministic clean-room riff phrases, each eight eighth-note slots.
// They are authored reconstructions, not copied factory phrase data. Tempo is
// represented by a 32.32 fixed-point frame period so fractional BPM does not
// accumulate integer-rounding drift.
class AutoRiffFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    static constexpr std::uint8_t kPhraseCount = 30U;
    static constexpr std::uint8_t kStepsPerPhrase = 8U;
    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec) noexcept;
    bool prepare(const ProcessSpec& spec, const AutoRiffFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const AutoRiffFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] std::uint64_t stepCount() const noexcept { return stepCount_; }
    [[nodiscard]] std::uint8_t stepIndex() const noexcept { return stepIndex_; }
    [[nodiscard]] std::uint8_t selectedPhrase() const noexcept { return options_.phrase; }
    [[nodiscard]] static std::int8_t phraseStep(std::uint8_t phrase,
                                               std::uint8_t step) noexcept;
    [[nodiscard]] SynthesisPitchFxLatency latency() const noexcept;
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 12U; }

private:
    [[nodiscard]] bool validateEvents(std::uint32_t frames,
                                      const AutoRiffFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const AutoRiffFxEvent& event) const noexcept;
    void applyEvent(const AutoRiffFxEvent& event, std::uint64_t frame) noexcept;
    void updatePitchTargets() noexcept;
    void setTempo(float bpm, std::uint64_t frame) noexcept;
    void beginPhrase(std::uint64_t frame) noexcept;
    void advanceStep(std::uint64_t frame) noexcept;
    void advanceStepDeadline() noexcept;
    [[nodiscard]] float targetRatio(std::uint32_t channel) const noexcept;

    ProcessSpec spec_{};
    AutoRiffFxOptions options_{};
    YinPsolaStereoPath pitchPath_{};
    std::uint64_t expectedFrame_ = 0U;
    std::uint64_t processingFrame_ = 0U;
    std::uint64_t stepDeadlineFrame_ = 0U;
    std::uint64_t stepPeriodQ32_ = 0U;
    std::uint64_t stepCount_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double controlCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float balanceTarget_ = 0.7f;
    float balanceCurrent_ = 0.7f;
    float stepEnvelope_ = 0.0f;
    float stepEnvelopeIncrement_ = 1.0f;
    float lastRatioLeft_ = 1.0f;
    float lastRatioRight_ = 1.0f;
    std::uint8_t stepIndex_ = 0U;
    std::uint32_t stepFractionQ32_ = 0U;
    std::uint32_t stepAttackRemaining_ = 0U;
    bool transportStarted_ = false;
    bool phraseFinished_ = false;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

enum class HarmonyAutoVoice : std::uint8_t {
    OctaveDown, OctaveUp, Lower, Low, High, Higher, Unison
};
enum class HarmonyAutoMode : std::uint8_t { Hybrid, Auto };
enum class HarmonyAutoControl : std::uint8_t {
    Active, Voice, Formant, Pan, Mode, Key, DryLevel, HarmonyLevel,
    MidiNoteOn, MidiNoteOff, MidiAllNotesOff
};
struct HarmonyAutoFxOptions {
    HarmonyAutoVoice voice = HarmonyAutoVoice::High;
    float formant = 0.0f;
    float pan = 0.0f;
    HarmonyAutoMode mode = HarmonyAutoMode::Auto;
    std::uint8_t key = 0U;
    float dryLevel = 100.0f;
    float harmonyLevel = 80.0f;
};
struct HarmonyAutoFxEvent {
    std::uint32_t frameOffset = 0U;
    HarmonyAutoControl control = HarmonyAutoControl::Active;
    std::uint8_t midiNote = 60U;
    float value = 0.0f;
};

// Clean-room one-voice automatic harmonizer. AUTO selects diatonic intervals
// from the configured key; HYBRID accepts a bounded MIDI target override and
// otherwise uses fixed semitone intervals. MIDI note-ons at one offset replace
// the target atomically; they do not create multi-voice chords.
class HarmonyAutoFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec) noexcept;
    bool prepare(const ProcessSpec& spec, const HarmonyAutoFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const HarmonyAutoFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] bool midiTargetActive() const noexcept { return midiTargetActive_; }
    [[nodiscard]] SynthesisPitchFxLatency latency() const noexcept;
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 19U; }

private:
    [[nodiscard]] bool validateEvents(std::uint32_t frames,
                                      const HarmonyAutoFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const HarmonyAutoFxEvent& event) const noexcept;
    void applyEvent(const HarmonyAutoFxEvent& event) noexcept;
    void updatePitchTargets() noexcept;
    [[nodiscard]] float targetRatio(std::uint32_t channel) const noexcept;
    void updateFormantFilters(float formant) noexcept;

    ProcessSpec spec_{};
    HarmonyAutoFxOptions options_{};
    YinPsolaStereoPath pitchPath_{};
    std::array<std::array<BiquadDf2T, 2U>, 2U> formantFilters_{};
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double controlCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float dryTarget_ = 1.0f;
    float dryCurrent_ = 1.0f;
    float harmonyTarget_ = 0.8f;
    float harmonyCurrent_ = 0.8f;
    float panTarget_ = 0.0f;
    float panCurrent_ = 0.0f;
    std::int16_t midiTarget_ = -1;
    bool midiTargetActive_ = false;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
