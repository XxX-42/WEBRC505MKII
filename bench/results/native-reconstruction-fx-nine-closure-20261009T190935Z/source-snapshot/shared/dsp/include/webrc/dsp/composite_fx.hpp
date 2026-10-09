#pragma once

#include "webrc/dsp/control_dynamics.hpp"
#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kCompositeFxApiVersion = 1;

// Processor availability in this file does not mean that a complete registry,
// official control map, browser adapter, or product graph is qualified.
enum class CompositeFxKind : std::uint8_t {
    Radio,
    Sustainer,
    SlowGear,
    StereoEnhance,
};

enum class CompositeFxControl : std::uint8_t {
    Active,
    Wet,
    RadioHighPassHz,
    RadioLowPassHz,
    RadioDrive,
    RadioBitDepth,
    RadioHoldFrames,
    RadioBitMix,
    SustainerThresholdDb,
    SustainerRatio,
    SustainerAttackMs,
    SustainerReleaseMs,
    SustainerRmsMix,
    SustainerMakeupDb,
    SlowGearAttackMs,
    SlowGearReleaseMs,
    SlowGearSensitivity,
    StereoHighWidth,
    StereoLowWidth,
    StereoSmoothingMs,
};

// Parameter values in this reconstruction API are local DSP controls. They do
// not claim to reproduce the manufacturer's UI ranges or named algorithms.
// Events apply immediately before their frame; offsets must be ordered and
// lie inside the current block. A block accepts at most 64 events.
struct CompositeFxEvent {
    std::uint32_t frameOffset = 0;
    CompositeFxControl control = CompositeFxControl::Active;
    float value = 0.0f;
};

// Four independent, allocation-free stereo composite processors. Objects are
// prepared while inactive, then swapped into the running graph. processBlock
// operates in place on interleaved stereo and never allocates or locks.
class CompositeFxProcessor {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64;

    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec,
                                                          CompositeFxKind kind) noexcept;
    bool prepare(const ProcessSpec& spec);
    void reset(std::uint64_t absoluteFrame = 0) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const CompositeFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0) noexcept;
    bool setSeed(std::uint64_t seed) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] bool active() const noexcept { return active_; }
    [[nodiscard]] CompositeFxKind kind() const noexcept { return kind_; }
    [[nodiscard]] float activeGain() const noexcept { return activeGain_; }
    [[nodiscard]] float wet() const noexcept { return wet_; }
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

protected:
    explicit CompositeFxProcessor(CompositeFxKind kind) noexcept : kind_(kind) {}

private:
    [[nodiscard]] bool validateEvent(const CompositeFxEvent& event) const noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const CompositeFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    void applyEvent(const CompositeFxEvent& event) noexcept;
    [[nodiscard]] StereoFrame processSample(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processRadio(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processSustainer(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processSlowGear(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processStereoEnhance(StereoFrame input) noexcept;

    CompositeFxKind kind_ = CompositeFxKind::Radio;
    ProcessSpec spec_{};
    std::array<BiquadDf2T, 2> radioHighPass_{};
    std::array<BiquadDf2T, 2> radioLowPass_{};
    std::array<BitRateReducer, 2> radioReducer_{};
    std::array<double, 2> radioPreviousBandLimited_{};
    DualDetectorCompressor sustainer_{};
    MidSideWidth stereoWidth_{};
    std::uint64_t randomSeed_ = 0x12e15e35a7bd381dULL;
    std::uint64_t expectedFrame_ = 0;
    double activeSmoothingCoefficient_ = 0.0;
    double wetSmoothingCoefficient_ = 0.0;
    double radioDriveSmoothingCoefficient_ = 0.0;
    double sustainerGainSmoothingCoefficient_ = 0.0;
    double slowAttackCoefficient_ = 0.0;
    double slowReleaseCoefficient_ = 0.0;
    double slowDetectorAttackCoefficient_ = 0.0;
    double slowDetectorReleaseCoefficient_ = 0.0;
    double slowReferenceCoefficient_ = 0.0;
    double slowRearmSmoothingCoefficient_ = 0.0;
    float activeGain_ = 0.0f;
    float targetActiveGain_ = 0.0f;
    float wet_ = 1.0f;
    float wetCurrent_ = 1.0f;
    float radioHighPassHz_ = 220.0f;
    float radioLowPassHz_ = 3400.0f;
    float radioDrive_ = 2.5f;
    float radioDriveCurrent_ = 2.5f;
    std::uint32_t radioBitDepth_ = 12;
    std::uint32_t radioHoldFrames_ = 2;
    float radioBitMix_ = 0.35f;
    float sustainerThresholdDb_ = -24.0f;
    float sustainerRatio_ = 8.0f;
    float sustainerAttackMs_ = 8.0f;
    float sustainerReleaseMs_ = 450.0f;
    float sustainerRmsMix_ = 0.55f;
    float sustainerMakeupDb_ = 4.0f;
    float sustainerGainCurrent_ = 1.0f;
    float slowGearAttackMs_ = 300.0f;
    float slowGearReleaseMs_ = 120.0f;
    float slowGearSensitivity_ = 2.0f;
    float slowGearSensitivityCurrent_ = 2.0f;
    float stereoHighWidth_ = 1.6f;
    float stereoLowWidth_ = 0.35f;
    float stereoSmoothingMs_ = 20.0f;
    double slowGearEnvelope_ = 0.0;
    double slowGearDetectorEnvelope_ = 0.0;
    double slowGearReferenceEnvelope_ = 0.0;
    double slowGearRearmTarget_ = 0.0;
    std::uint32_t slowGearRearmSamplesRemaining_ = 0;
    std::uint32_t slowGearRearmSamples_ = 0;
    bool slowGearOnsetArmed_ = true;
    bool active_ = false;
    bool prepared_ = false;
    bool hasExpectedFrame_ = false;
};

class RadioFx final : public CompositeFxProcessor {
public:
    RadioFx() noexcept : CompositeFxProcessor(CompositeFxKind::Radio) {}
};

class SustainerFx final : public CompositeFxProcessor {
public:
    SustainerFx() noexcept : CompositeFxProcessor(CompositeFxKind::Sustainer) {}
};

class SlowGearFx final : public CompositeFxProcessor {
public:
    SlowGearFx() noexcept : CompositeFxProcessor(CompositeFxKind::SlowGear) {}
};

class StereoEnhancerFx final : public CompositeFxProcessor {
public:
    StereoEnhancerFx() noexcept : CompositeFxProcessor(CompositeFxKind::StereoEnhance) {}
};

} // namespace webrc::dsp
