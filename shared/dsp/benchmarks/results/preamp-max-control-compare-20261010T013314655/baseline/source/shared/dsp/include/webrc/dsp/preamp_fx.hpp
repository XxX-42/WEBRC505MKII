#pragma once

#include "webrc/dsp/nonlinear.hpp"
#include "webrc/dsp/primitives.hpp"
#include "webrc/dsp/spatial_temporal.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kPreampFxApiVersion = 1U;

enum class PreampFxControl : std::uint8_t {
    Active,
    Mix,
    Drive,
    BassDb,
    MidDb,
    TrebleDb,
    PresenceDb,
    OutputDb,
};

struct PreampFxEvent {
    // Events are applied immediately before frameOffset. The list must be
    // ordered, lie within this callback, and contain at most 64 entries.
    std::uint32_t frameOffset = 0U;
    PreampFxControl control = PreampFxControl::Active;
    float value = 0.0f;
};

struct PreampCabinetIr {
    // The responses are copied into the partitioned convolver during prepare.
    // A null right response reuses the left response. Channels remain dual
    // mono; this API does not add cross-channel cabinet leakage.
    std::uint32_t frames = 0U;
    const float* left = nullptr;
    const float* right = nullptr;
};

struct PreampFxOptions {
    // PREAMP is a clean-room diode-preamp reconstruction. DIST remains the
    // separate ADAA cubic distortion processor without tone stack or cabinet.
    NonlinearModel nonlinearModel = NonlinearModel::WdfSymmetricDiode;
    std::uint32_t cabinetPartitionFrames = 64U;
    double diodePortResistance = 1000.0;
    double diodeSaturationCurrent = 2.0e-9;
    double diodeThermalVoltage = 0.02585;
    double diodeIdeality = 1.0;
    float controlSmoothingMs = 10.0f;
    float toneCoefficientSmoothingMs = 8.0f;
};

struct PreampFxLatency {
    // Cabinet partition latency plus the integer alignment anchor for the
    // x4 shaper's low-frequency group delay. The nonlinear FIR response has
    // frequency-dependent residual phase and is not a pure delay.
    std::uint32_t fixedAlgorithmicSamples = 0U;
    std::uint32_t cabinetPartitionSamples = 0U;
    std::uint32_t dryAlignmentSamples = 0U;
    double nonlinearLowFrequencyGroupDelaySamples = 0.0;
};

// Standalone PREAMP23 processor. Its order is x4 diode/ADAA saturation,
// four-band tone stack, per-channel cabinet IR convolution, then a smoothed
// parallel blend against a latency-aligned dry path. Published Roland values
// remain separate from these clean-room reconstruction controls.
//
// Prepare only a fresh inactive instance after admitting requiredPrepareBytes
// for the active plus staged graph. The IR is copied/precomputed at setup.
// processBlock has bounded ordered automation and performs no allocation,
// locking, or I/O.
class PreampFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    static constexpr std::uint32_t kMaximumCabinetIrFrames = 16384U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const PreampFxOptions& options,
        std::uint32_t cabinetIrFrames) noexcept;
    bool prepare(const ProcessSpec& spec, const PreampFxOptions& options,
                 const PreampCabinetIr& cabinetIr);
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const PreampFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] PreampFxLatency latency() const noexcept;
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 23U; }

private:
    [[nodiscard]] static bool validOptions(const PreampFxOptions& options) noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const PreampFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const PreampFxEvent& event) const noexcept;
    void applyEvent(const PreampFxEvent& event) noexcept;
    void updateToneTargets(PreampFxControl changed) noexcept;
    void advanceControls() noexcept;
    [[nodiscard]] float processTone(std::size_t channel, float sample) noexcept;

    ProcessSpec spec_{};
    PreampFxOptions options_{};
    std::array<OversampledNonlinear, 2U> shapers_{};
    std::array<std::array<BiquadDf2T, 4U>, 2U> tone_{};
    PartitionedConvolver cabinet_{};
    std::array<std::vector<float>, 2U> cabinetInputOutput_{};
    std::array<std::vector<float>, 2U> alignedDryBlock_{};
    std::array<std::vector<float>, 2U> dryRing_{};
    std::vector<float> blendBlock_;
    std::uint32_t dryAlignmentSamples_ = 0U;
    std::uint32_t dryWritePosition_ = 0U;
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double controlSmoothingCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 1.0f;
    float mixCurrent_ = 1.0f;
    float driveTarget_ = 4.0f;
    float driveCurrent_ = 4.0f;
    float bassDbTarget_ = 0.0f;
    float midDbTarget_ = 0.0f;
    float trebleDbTarget_ = 0.0f;
    float presenceDbTarget_ = 0.0f;
    float outputGainTarget_ = 1.0f;
    float outputGainCurrent_ = 1.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
