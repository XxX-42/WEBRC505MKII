#pragma once

#include "webrc/dsp/pitch.hpp"
#include "webrc/dsp/primitives.hpp"
#include "webrc/dsp/streaming_yin.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kVoiceFxApiVersion = 1U;

struct VoiceFxLatency {
    // PSOLA lookahead is a fixed audio-path delay. YIN window/hop describe the
    // control estimator; detector lag and active-estimate age are measured
    // state and are not added to the fixed audio delay.
    std::uint32_t psolaLookaheadSamples = 0U;
    std::uint32_t analysisWindowFrames = 0U;
    std::uint32_t analysisHopFrames = 0U;
    std::uint32_t conservativePitchOnsetFrames = 0U;
    std::array<std::uint32_t, 2U> activeEstimateAgeFrames{};
    std::array<std::uint32_t, 2U> activeEstimateProcessingLagFrames{};
    std::array<std::uint32_t, 2U> lastAnalysisWorkUnits{};
    std::array<std::uint64_t, 2U> analysisCounts{};
    std::uint32_t workUnitsPerChannelPerCallback = 0U;
    bool analysisCold = true;
};

// Stereo dual-mono YIN + streaming TD-PSOLA path shared by ROBOT and ELECTRIC.
// Analysis is fixed 2048-frame, 512-frame hop. All detector and PSOLA storage
// is prepared up front; processSample does not allocate or lock. The byte
// estimator reports the peak for one fresh staged setup, including temporary
// detector/shifter storage. While replacing an active path, reserve the old
// preparedBytes() plus the candidate requirement until the swap completes.
class YinPsolaStereoPath final {
public:
    static constexpr std::uint32_t kAnalysisWindowFrames = 2048U;
    static constexpr std::uint32_t kAnalysisHopFrames = 512U;
    static constexpr std::uint32_t kAnalysisWorkUnitsPerChannelPerCallback = 4096U;
    static constexpr std::uint32_t kMaximumBlockFrames = 8192U;
    static constexpr float kMinimumFrequencyHz = 65.0f;
    static constexpr float kMaximumFrequencyHz = 1200.0f;

    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec) noexcept;
    bool prepare(const ProcessSpec& spec);
    void reset() noexcept;
    // Promotes only estimates completed before this call, then ingests the
    // current block and advances each detector by its fixed work budget. A new
    // estimate therefore becomes active no earlier than the next audio block.
    [[nodiscard]] bool processAnalysisBlock(const StereoFrame* input,
                                            std::uint32_t frames) noexcept;
    [[nodiscard]] PitchEstimate estimate(std::uint32_t channel) const noexcept;
    [[nodiscard]] std::uint32_t estimateAgeFrames(std::uint32_t channel) const noexcept;
    [[nodiscard]] std::uint32_t estimateProcessingLagFrames(std::uint32_t channel) const noexcept;
    [[nodiscard]] std::uint32_t lastAnalysisWorkUnits(std::uint32_t channel) const noexcept;
    [[nodiscard]] std::uint64_t analysisCount(std::uint32_t channel) const noexcept;
    bool setPitchTargets(float leftRatio, float rightRatio,
                         float confidenceThreshold = 0.65f) noexcept;
    [[nodiscard]] StereoFrame processSample(StereoFrame input) noexcept;
    [[nodiscard]] VoiceFxLatency latency() const noexcept;
    // Peak setup reservation; temporary staging storage is freed after prepare.
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }

private:
    ProcessSpec spec_{};
    ProcessSpec detectorSpec_{};
    std::array<IncrementalYinDetector, 2U> detectors_{};
    std::array<StreamingTdPsolaPitchShifter, 2U> shifters_{};
    std::array<float, kMaximumBlockFrames> monoScratch_{};
    std::array<PitchEstimate, 2U> estimates_{};
    std::array<PitchEstimate, 2U> pendingEstimates_{};
    std::array<std::uint64_t, 2U> detectorCountsSeen_{};
    std::array<std::uint64_t, 2U> activeWindowEndFrames_{};
    std::array<std::uint64_t, 2U> pendingWindowEndFrames_{};
    std::array<std::uint32_t, 2U> activeProcessingLagFrames_{};
    std::array<std::uint32_t, 2U> pendingProcessingLagFrames_{};
    std::array<std::uint32_t, 2U> activeEstimateAgeFrames_{};
    std::array<std::uint32_t, 2U> lastWorkUnits_{};
    std::array<bool, 2U> pendingAvailable_{};
    std::uint64_t totalInputFrames_ = 0U;
    std::size_t preparedBytes_ = 0U;
    bool prepared_ = false;
};

enum class RobotFxMode : std::uint8_t {
    PitchClass = 1,
    MajorScale = 2,
};

enum class RobotFxControl : std::uint8_t {
    Active,
    Mix,
    NoteClass,
    Mode,
    Formant,
};

struct RobotFxOptions {
    std::uint8_t noteClass = 0U;
    RobotFxMode mode = RobotFxMode::MajorScale;
    float formant = 0.0f;
    float mix = 0.75f;
    float controlSmoothingMs = 8.0f;
    // Reconstruction only: MODE 1 snaps to the selected pitch class; MODE 2
    // quantizes to the selected root's major scale. Official UI labels remain
    // recorded separately and do not establish this local DSP interpretation.
};

struct RobotFxEvent {
    std::uint32_t frameOffset = 0U;
    RobotFxControl control = RobotFxControl::Active;
    float value = 0.0f;
};

class RobotFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const RobotFxOptions& options = {}) noexcept;
    bool prepare(const ProcessSpec& spec, const RobotFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const RobotFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] VoiceFxLatency latency() const noexcept { return pitchPath_.latency(); }
    [[nodiscard]] PitchEstimate pitchEstimate(std::uint32_t channel) const noexcept {
        return pitchPath_.estimate(channel);
    }
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 16U; }

private:
    [[nodiscard]] bool validateEvent(const RobotFxEvent& event) const noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const RobotFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    void applyEvent(const RobotFxEvent& event) noexcept;
    void updatePitchTargets() noexcept;
    void updateFormantTargets(float formant) noexcept;

    ProcessSpec spec_{};
    RobotFxOptions options_{};
    YinPsolaStereoPath pitchPath_{};
    std::array<std::array<BiquadDf2T, 3U>, 2U> formantFilters_{};
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double smoothingCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 0.75f;
    float mixCurrent_ = 0.75f;
    float formantCurrent_ = 0.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

enum class ElectricFxControl : std::uint8_t {
    Active,
    Mix,
    ShiftSemitones,
    Formant,
    Speed,
    Stability,
    ScaleRoot,
};

struct ElectricFxOptions {
    float shiftSemitones = 0.0f;
    float formant = 0.0f;
    float speed = 5.0f;
    float stability = 0.0f;
    // -1 is chromatic; 0..11 selects a clean-room major-scale root.
    std::int8_t scaleRoot = -1;
    float mix = 0.7f;
    float controlSmoothingMs = 8.0f;
    float metallicMix = 0.28f;
    float bitCrushMix = 0.12f;
};

struct ElectricFxEvent {
    std::uint32_t frameOffset = 0U;
    ElectricFxControl control = ElectricFxControl::Active;
    float value = 0.0f;
};

// Clean-room ELECTRIC macro: scale-aware pitch snapping/shift, shifted formant
// peaks, a stereo metallic ring-carrier branch and a fixed-bit/sample-hold
// character branch. Its local curves are independent of the published UI facts.
class ElectricFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const ElectricFxOptions& options = {}) noexcept;
    bool prepare(const ProcessSpec& spec, const ElectricFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const ElectricFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] VoiceFxLatency latency() const noexcept { return pitchPath_.latency(); }
    [[nodiscard]] PitchEstimate pitchEstimate(std::uint32_t channel) const noexcept {
        return pitchPath_.estimate(channel);
    }
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 17U; }

private:
    [[nodiscard]] bool validateEvent(const ElectricFxEvent& event) const noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const ElectricFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    void applyEvent(const ElectricFxEvent& event) noexcept;
    void updatePitchTargets() noexcept;
    void updateFormantTargets(float formant) noexcept;
    [[nodiscard]] float processFormant(std::size_t channel, float input) noexcept;

    ProcessSpec spec_{};
    ElectricFxOptions options_{};
    YinPsolaStereoPath pitchPath_{};
    std::array<std::array<BiquadDf2T, 3U>, 2U> formantFilters_{};
    std::array<PolyBlepOscillator, 2U> ringCarriers_{};
    std::array<std::uint32_t, 2U> holdCountdown_{};
    std::array<float, 2U> heldSamples_{};
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double smoothingCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 0.7f;
    float mixCurrent_ = 0.7f;
    float shiftCurrent_ = 0.0f;
    float speedCurrent_ = 5.0f;
    float stabilityCurrent_ = 0.0f;
    float formantCurrent_ = 0.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

enum class OscBotWaveform : std::uint8_t {
    Saw,
    VintageSaw,
    DetuneSaw,
    Square,
    Rect,
};

enum class OscBotControl : std::uint8_t {
    Active,
    Mix,
    Waveform,
    Tone,
    Attack,
    Note,
    ModSensitivity,
    Balance,
    Pattern,
};

struct OscBotFxOptions {
    OscBotWaveform waveform = OscBotWaveform::Saw;
    float tone = 0.0f;
    float attack = 50.0f;
    std::uint8_t note = 36U; // C2 in equal-tempered MIDI.
    float modulationSensitivity = 0.0f;
    float balance = 0.5f;
    float mix = 0.75f;
    std::uint8_t pattern = 0U;
    float stepRateHz = 4.0f; // Reconstruction transport, independent of FX UI facts.
    float controlSmoothingMs = 8.0f;
};

struct OscBotFxEvent {
    std::uint32_t frameOffset = 0U;
    OscBotControl control = OscBotControl::Active;
    float value = 0.0f;
};

// Stereo input-envelope-driven oscillator bank with a sample-accurate,
// eight-step clean-room sequence and three-band resonant formant shaping.
class OscBotFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    static constexpr std::size_t kVoiceCount = 8U;
    static constexpr std::size_t kPatternCount = 4U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const OscBotFxOptions& options = {}) noexcept;
    bool prepare(const ProcessSpec& spec, const OscBotFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const OscBotFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] std::uint64_t stepCount() const noexcept { return stepCount_; }
    [[nodiscard]] std::uint8_t selectedPattern() const noexcept { return options_.pattern; }
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 22U; }

private:
    struct Voice {
        PolyBlepOscillator left{};
        PolyBlepOscillator right{};
        PolyBlepOscillator vintageLeft{};
        PolyBlepOscillator vintageRight{};
        PolyBlepOscillator rectLeft{};
        PolyBlepOscillator rectRight{};
        PolyBlepOscillator previousLeft{};
        PolyBlepOscillator previousRight{};
        PolyBlepOscillator previousVintageLeft{};
        PolyBlepOscillator previousVintageRight{};
        PolyBlepOscillator previousRectLeft{};
        PolyBlepOscillator previousRectRight{};
        std::uint8_t note = 0U;
        float velocity = 0.0f;
        float gain = 0.0f;
        float targetGain = 0.0f;
        std::uint64_t age = 0U;
        OscBotWaveform waveform = OscBotWaveform::Saw;
        OscBotWaveform previousWaveform = OscBotWaveform::Saw;
        std::uint32_t waveformFadeRemaining = 0U;
        bool active = false;
    };
    struct Retired {
        PolyBlepOscillator left{};
        PolyBlepOscillator right{};
        PolyBlepOscillator vintageLeft{};
        PolyBlepOscillator vintageRight{};
        PolyBlepOscillator rectLeft{};
        PolyBlepOscillator rectRight{};
        float gain = 0.0f;
        std::uint32_t remaining = 0U;
        OscBotWaveform waveform = OscBotWaveform::Saw;
    };
    [[nodiscard]] bool validateEvent(const OscBotFxEvent& event) const noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const OscBotFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    void applyEvent(const OscBotFxEvent& event) noexcept;
    void triggerNote(std::uint8_t note, float velocity) noexcept;
    void triggerStep(std::uint64_t absoluteFrame) noexcept;
    void updateFormantTargets(float tone) noexcept;
    [[nodiscard]] static bool validWaveform(OscBotWaveform waveform) noexcept;

    ProcessSpec spec_{};
    OscBotFxOptions options_{};
    std::array<Voice, kVoiceCount> voices_{};
    std::array<Retired, 16U> retired_{};
    std::array<std::array<BiquadDf2T, 3U>, 2U> formantFilters_{};
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    std::uint64_t noteAge_ = 0U;
    std::uint64_t stepCount_ = 0U;
    std::uint64_t nextStepFrame_ = 0U;
    std::uint32_t stepFrames_ = 0U;
    std::uint32_t modulationUpdateCounter_ = 0U;
    double activeSmoothingCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 0.75f;
    float mixCurrent_ = 0.75f;
    float balanceTarget_ = 0.5f;
    float balanceCurrent_ = 0.5f;
    float envelopeLeft_ = 0.0f;
    float envelopeRight_ = 0.0f;
    float envelopeAttackCoefficient_ = 0.0f;
    float envelopeReleaseCoefficient_ = 0.0f;
    float voiceAttackCoefficient_ = 0.0f;
    float voiceReleaseCoefficient_ = 0.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
