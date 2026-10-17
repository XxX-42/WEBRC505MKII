#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

#include "native_rhythm_catalog.hpp"

namespace webrc::native {

enum class NativeRhythmVariation : std::uint8_t {
    A = 0,
    B,
    C,
    D,
};

enum class NativeRhythmSection : std::uint8_t {
    Main = 0,
    Intro,
    Ending,
    Fill,
};

enum class NativeRhythmQuantizeGrid : std::uint8_t {
    Sixteenth = 0,
    Eighth,
    Quarter,
};

struct NativeRhythmConfig {
    bool enabled = false;
    double bpm = 120.0;
    std::uint8_t kitIndex = 1;
    NativeRhythmVariation variation = NativeRhythmVariation::A;
    NativeRhythmSection section = NativeRhythmSection::Main;
    // Stable one-based selection into the metadata-only 240-pattern catalog.
    std::uint16_t patternIndex = 1U;
    unsigned int swingPercent = 50U;
    NativeRhythmQuantizeGrid quantizeGrid = NativeRhythmQuantizeGrid::Sixteenth;
    unsigned int volume = 50U;
};

// Clean-room procedural renderer whose meter and descriptive style cues come
// from the metadata-only Browser catalog. It never reads or reconstructs
// factory MIDI, event sequences, or samples. All DSP state is fixed-size and
// owned by the audio thread.
class NativeRhythmEngine final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeRhythmConfig& config, std::uint64_t startFrame) noexcept;

    // Add generated drums to an already-rendered interleaved output block. This
    // operation performs no allocation, locking, I/O, or logging.
    void processAdditive(
        float* interleaved,
        unsigned int frames,
        unsigned int channels,
        std::uint64_t startFrame
    ) noexcept;

    void reset() noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool enabled() const noexcept { return config_.enabled; }
    [[nodiscard]] std::size_t activeVoiceCount() const noexcept;
    [[nodiscard]] std::uint16_t patternIndex() const noexcept { return config_.patternIndex; }
    [[nodiscard]] const NativeRhythmPatternMetadata& patternMetadata() const noexcept { return *pattern_; }
    [[nodiscard]] unsigned int meterNumerator() const noexcept { return meterNumerator_; }
    [[nodiscard]] unsigned int meterDenominator() const noexcept { return meterDenominator_; }
    [[nodiscard]] unsigned int stepsPerBeat() const noexcept { return stepsPerBeat_; }
    [[nodiscard]] unsigned int stepsPerBar() const noexcept { return stepsPerBar_; }
    [[nodiscard]] std::uint64_t nextScheduledStepFrame() const noexcept { return nextStepFrame_; }
    [[nodiscard]] std::uint64_t scheduledStepOrdinal() const noexcept { return stepOrdinal_; }

private:
    enum class Instrument : std::uint8_t {
        Kick = 0,
        Snare,
        ClosedHat,
        OpenHat,
        Tom,
        Ride,
        Clap,
        Brush,
    };

    struct KitTimbre {
        float kickHz;
        float kickPitchDropHz;
        float kickDecayMs;
        float snareHz;
        float snareNoiseMix;
        float snareDecayMs;
        float hatCutoffHz;
        float hatDecayMs;
        float tomHz;
        float tomDecayMs;
        float velocityExponent;
    };

    struct Voice {
        bool active = false;
        Instrument instrument = Instrument::Kick;
        std::uint64_t startFrame = 0;
        std::uint64_t endFrame = 0;
        float amplitude = 0.0f;
        float envelope = 1.0f;
        float envelopeDecay = 1.0f;
        float phase = 0.0f;
        float secondaryPhase = 0.0f;
        float phaseIncrement = 0.0f;
        float secondaryIncrement = 0.0f;
        float pitchDropEnvelope = 1.0f;
        float pitchDropDecay = 1.0f;
        float initialHz = 0.0f;
        float settledHz = 0.0f;
        float noiseMix = 0.0f;
        float previousNoise = 0.0f;
        std::uint32_t randomState = 1;
    };

    [[nodiscard]] static bool isValidConfig(const NativeRhythmConfig& config) noexcept;
    [[nodiscard]] const KitTimbre& activeTimbre() const noexcept;
    void scheduleStep(std::uint64_t ordinal, std::uint64_t renderedFrame) noexcept;
    void startVoice(Instrument instrument, float velocity, std::uint64_t seed, std::uint64_t frame) noexcept;
    [[nodiscard]] float processVoice(Voice& voice, std::uint64_t frame) noexcept;
    [[nodiscard]] float nextNoise(Voice& voice) noexcept;
    [[nodiscard]] static std::uint32_t mixSeed(std::uint32_t value) noexcept;
    [[nodiscard]] static std::uint32_t nextRandom(std::uint32_t& state) noexcept;
    void updateNextStepFrame() noexcept;

    static constexpr std::size_t kMaxVoices = 16;
    std::array<Voice, kMaxVoices> voices_{};
    NativeRhythmConfig config_{};
    const NativeRhythmPatternMetadata* pattern_ = nativeRhythmPatternByIndex(1U);
    unsigned int sampleRate_ = 0;
    unsigned int meterNumerator_ = 4U;
    unsigned int meterDenominator_ = 4U;
    unsigned int stepsPerBeat_ = 4U;
    unsigned int stepsPerBar_ = 16U;
    std::uint64_t timelineOriginFrame_ = 0;
    std::uint64_t stepOrdinal_ = 0;
    std::uint64_t nextStepFrame_ = 0;
};

[[nodiscard]] const char* nativeRhythmVariationToString(NativeRhythmVariation variation) noexcept;
[[nodiscard]] const char* nativeRhythmSectionToString(NativeRhythmSection section) noexcept;
[[nodiscard]] const char* nativeRhythmQuantizeGridToString(NativeRhythmQuantizeGrid grid) noexcept;
[[nodiscard]] bool nativeRhythmVariationFromString(const char* raw, NativeRhythmVariation& variation) noexcept;
[[nodiscard]] bool nativeRhythmSectionFromString(const char* raw, NativeRhythmSection& section) noexcept;
[[nodiscard]] bool nativeRhythmQuantizeGridFromString(const char* raw, NativeRhythmQuantizeGrid& grid) noexcept;

} // namespace webrc::native
