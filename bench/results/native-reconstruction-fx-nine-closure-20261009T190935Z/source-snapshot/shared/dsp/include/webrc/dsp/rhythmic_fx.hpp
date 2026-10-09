#pragma once

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kRhythmicFxApiVersion = 1U;

enum class RhythmicFxKind : std::uint8_t {
    Isolator,
    PatternSlicer,
    StepSlicer,
};

enum class RhythmicFxControl : std::uint8_t {
    Active,
    Wet,
    TempoBpm,
    EdgeMilliseconds,
    PatternId,
    LowGainDb,
    MidGainDb,
    HighGainDb,
    LowMute,
    MidMute,
    HighMute,
    StepGain,
    StepPan,
    StepCutoffHz,
};

struct RhythmicFxEvent {
    std::uint32_t frameOffset = 0U;
    RhythmicFxControl control = RhythmicFxControl::Active;
    std::uint8_t stepIndex = 0U;
    float value = 0.0f;
};

struct RhythmicPatternDescriptor {
    const char* stableId = "";
    const char* displayName = "";
    std::array<float, 16> levels{};
    std::array<float, 16> pans{};
    std::array<float, 16> cutoffHz{};
};

// Clean-room rhythmic preset descriptions. These are deterministic internal
// tables, not claims about Roland factory pattern data.
[[nodiscard]] std::uint32_t rhythmicFxPatternCount(RhythmicFxKind kind) noexcept;
[[nodiscard]] const RhythmicPatternDescriptor* rhythmicFxPattern(
    RhythmicFxKind kind, std::uint32_t patternIndex) noexcept;

// Fixed-storage stereo processors for the 3-band ISOLATOR and tempo-synced
// PATTERN/STEP SLICER. No heap storage is used, including during prepare.
// Controls arrive in sample-offset order; reject a whole invalid batch before
// processing any sample. Call processBlock from one owner at a time.
class RhythmicFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    static constexpr std::uint32_t kPatternSteps = 16U;
    static constexpr std::uint32_t kTicksPerQuarter = 960U;
    static constexpr std::uint64_t kMaximumExactFrame = 1ULL << 53U;

    [[nodiscard]] static std::size_t requiredMemoryBytes(const ProcessSpec& spec,
                                                          RhythmicFxKind kind) noexcept;
    [[nodiscard]] static std::uint16_t effectOrdinal(RhythmicFxKind kind) noexcept;
    bool prepare(const ProcessSpec& spec, RhythmicFxKind kind) noexcept;
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const RhythmicFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] RhythmicFxKind kind() const noexcept { return kind_; }
    [[nodiscard]] bool active() const noexcept { return active_; }
    [[nodiscard]] double tempoBpm() const noexcept { return bpm_; }
    [[nodiscard]] std::uint32_t patternId() const noexcept { return patternId_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] double tickAtFrame(std::uint64_t absoluteFrame) const noexcept;
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept {
        return 0U;
    }

private:
    struct BiquadState {
        double b0 = 1.0;
        double b1 = 0.0;
        double b2 = 0.0;
        double a1 = 0.0;
        double a2 = 0.0;
        double z1 = 0.0;
        double z2 = 0.0;

        void setButterworth(double sampleRate, double frequencyHz, bool highpass) noexcept;
        void reset() noexcept { z1 = z2 = 0.0; }
        [[nodiscard]] float process(float input) noexcept;
    };

    struct CrossoverChannel {
        std::array<BiquadState, 2> lowerLow{};
        std::array<BiquadState, 2> lowerHigh{};
        std::array<BiquadState, 2> upperLowRemainder{};
        std::array<BiquadState, 2> upperHighRemainder{};
        std::array<BiquadState, 2> upperLowLow{};
        std::array<BiquadState, 2> upperHighLow{};
    };

    [[nodiscard]] bool validateEvent(const RhythmicFxEvent& event) const noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const RhythmicFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    void applyEvent(const RhythmicFxEvent& event, std::uint64_t absoluteFrame) noexcept;
    void advanceSmoothers() noexcept;
    [[nodiscard]] StereoFrame processSample(StereoFrame input,
                                            std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] StereoFrame processIsolator(StereoFrame input) noexcept;
    [[nodiscard]] float splitBandChannel(float input, std::uint32_t channel,
                                         float& middle, float& high) noexcept;
    [[nodiscard]] float patternLevel(double tick) const noexcept;
    [[nodiscard]] float shapedStepValue(const std::array<float, 16>& values,
                                        double tick) const noexcept;
    [[nodiscard]] static double smoothCurve(double value) noexcept;
    [[nodiscard]] static StereoFrame applyStereoPan(StereoFrame input, float pan) noexcept;

    ProcessSpec spec_{};
    std::array<CrossoverChannel, 2> crossovers_{};
    std::array<float, 16> stepGainTarget_{};
    std::array<float, 16> stepGainCurrent_{};
    std::array<float, 16> stepPanTarget_{};
    std::array<float, 16> stepPanCurrent_{};
    std::array<float, 16> stepCutoffAlphaTarget_{};
    std::array<float, 16> stepCutoffAlphaCurrent_{};
    std::array<float, 2> lowFilterState_{};
    std::array<float, 3> bandGainDb_{};
    std::array<float, 3> bandGainCurrent_{};
    std::array<bool, 3> bandMuted_{};
    std::array<float, 16> activePatternFrom_{};
    std::uint64_t epochFrame_ = 0U;
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double epochTicks_ = 0.0;
    double ticksPerFrame_ = 0.0;
    double bpm_ = 120.0;
    double activePatternBlend_ = 1.0;
    double targetPatternBlend_ = 1.0;
    double smoothingCoefficient_ = 0.0;
    double edgeMs_ = 1.0;
    double edgeTargetMs_ = 1.0;
    double edgeStepMultiplier_ = 1.0;
    double edgeSmoothingCoefficient_ = 0.0;
    float activeGain_ = 0.0f;
    float targetActiveGain_ = 0.0f;
    float wet_ = 1.0f;
    float wetCurrent_ = 1.0f;
    std::array<float, 3> bandGainTarget_{{1.0f, 1.0f, 1.0f}};
    std::uint32_t patternId_ = 0U;
    std::uint32_t previousPatternId_ = 0U;
    std::uint32_t stepGainDirtyMask_ = 0U;
    std::uint32_t stepPanDirtyMask_ = 0U;
    std::uint32_t stepCutoffDirtyMask_ = 0U;
    RhythmicFxKind kind_ = RhythmicFxKind::Isolator;
    bool active_ = false;
    bool hasClockOrigin_ = false;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
