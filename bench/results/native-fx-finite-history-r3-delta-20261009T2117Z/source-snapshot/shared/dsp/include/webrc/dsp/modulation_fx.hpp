#pragma once

#include "webrc/dsp/primitives.hpp"

#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kModulationFxApiVersion = 1;

enum class ModulationFxKind : std::uint8_t {
    LoFi,
    RingModulator,
    AutoPan,
    ManualPan,
    Tremolo,
};

enum class ModulationFxControl : std::uint8_t {
    Active,
    Wet,
    RateHz,
    Depth,
    Pan,
    BitDepth,
    HoldFrames,
    Dither,
    Waveform,
};

// Events are applied immediately before the sample at frameOffset. Events must
// be ordered, lie inside the block, and remain within the fixed 64-event limit.
struct ModulationFxEvent {
    std::uint32_t frameOffset = 0;
    ModulationFxControl control = ModulationFxControl::Active;
    float value = 0.0f;
};

// Five bounded, allocation-free stereo modulation/lo-fi processors. Build and
// prepare an inactive instance off the audio callback, then swap it into the
// graph. processBlock is in-place interleaved stereo. The instance has one
// owner: prepare/reset/setSeed and processBlock must not race.
class ModulationFxProcessor {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64;

    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec,
                                                          ModulationFxKind kind) noexcept;
    bool prepare(const ProcessSpec& spec);
    void reset(std::uint64_t absoluteFrame = 0) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const ModulationFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0) noexcept;
    bool setSeed(std::uint64_t seed) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] bool active() const noexcept { return active_; }
    [[nodiscard]] ModulationFxKind kind() const noexcept { return kind_; }
    [[nodiscard]] float activeGain() const noexcept { return activeGain_; }
    [[nodiscard]] float wet() const noexcept { return wet_; }
    [[nodiscard]] float rateHz() const noexcept { return rateHz_; }
    [[nodiscard]] float depth() const noexcept { return depth_; }
    [[nodiscard]] float pan() const noexcept { return pan_; }
    [[nodiscard]] std::uint32_t bitDepth() const noexcept { return bitDepth_; }
    [[nodiscard]] std::uint32_t holdFrames() const noexcept { return holdFrames_; }
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

protected:
    explicit ModulationFxProcessor(ModulationFxKind kind) noexcept : kind_(kind) {}

private:
    [[nodiscard]] bool validateEvent(const ModulationFxEvent& event) const noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const ModulationFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    void applyEvent(const ModulationFxEvent& event) noexcept;
    [[nodiscard]] StereoFrame processSample(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processLoFi(StereoFrame input) noexcept;
    [[nodiscard]] static StereoFrame applyBalance(StereoFrame input, float pan) noexcept;
    [[nodiscard]] float quantize(float input) noexcept;

    ModulationFxKind kind_ = ModulationFxKind::Tremolo;
    ProcessSpec spec_{};
    Lfo lfo_{};
    PolyBlepOscillator carrier_{};
    Pcg32 ditherRandom_{};
    std::uint64_t randomSeed_ = 0x4d595df4d0f33173ULL;
    std::uint64_t expectedFrame_ = 0;
    double smoothingCoefficient_ = 0.0;
    float wet_ = 1.0f;
    float wetCurrent_ = 1.0f;
    float rateHz_ = 1.0f;
    float depth_ = 0.5f;
    float depthCurrent_ = 0.5f;
    float pan_ = 0.0f;
    float panCurrent_ = 0.0f;
    float activeGain_ = 0.0f;
    float targetActiveGain_ = 0.0f;
    float dither_ = 0.5f;
    std::uint32_t bitDepth_ = 8;
    std::uint32_t holdFrames_ = 4;
    std::uint32_t holdCountdown_ = 0;
    OscillatorWaveform waveform_ = OscillatorWaveform::Sine;
    StereoFrame heldSample_{};
    bool active_ = false;
    bool prepared_ = false;
    bool hasExpectedFrame_ = false;
};

class LoFi final : public ModulationFxProcessor {
public:
    LoFi() noexcept : ModulationFxProcessor(ModulationFxKind::LoFi) {}
};

// The `RingModulator` type in nonlinear.hpp is a separate mono primitive.
// Give this independent stereo track effect an explicit family-qualified name
// to keep both APIs safe to include in the same translation unit.
class StereoRingModulatorFx final : public ModulationFxProcessor {
public:
    StereoRingModulatorFx() noexcept : ModulationFxProcessor(ModulationFxKind::RingModulator) {}
};

class AutoPan final : public ModulationFxProcessor {
public:
    AutoPan() noexcept : ModulationFxProcessor(ModulationFxKind::AutoPan) {}
};

class ManualPan final : public ModulationFxProcessor {
public:
    ManualPan() noexcept : ModulationFxProcessor(ModulationFxKind::ManualPan) {}
};

class Tremolo final : public ModulationFxProcessor {
public:
    Tremolo() noexcept : ModulationFxProcessor(ModulationFxKind::Tremolo) {}
};

} // namespace webrc::dsp
