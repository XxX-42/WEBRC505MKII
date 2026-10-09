#pragma once

#include "webrc/dsp/nonlinear.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kDistortionFxApiVersion = 1U;

enum class DistortionModel : std::uint8_t {
    AdaaCubic4x,
    SymmetricDiode4x,
};

enum class DistortionFxControl : std::uint8_t {
    Active,
    Mix,
    Drive,
    ToneHz,
    OutputDb,
};

struct DistortionFxOptions {
    DistortionModel model = DistortionModel::AdaaCubic4x;
    double diodePortResistance = 1000.0;
    double diodeSaturationCurrent = 2.0e-9;
    double diodeThermalVoltage = 0.02585;
    double diodeIdeality = 1.0;
};

struct DistortionFxEvent {
    // Applied immediately before frameOffset. Event offsets are ordered and
    // must be inside the current block; one callback accepts at most 64.
    std::uint32_t frameOffset = 0U;
    DistortionFxControl control = DistortionFxControl::Active;
    float value = 0.0f;
};

struct DistortionFxLatency {
    // No whole-sample buffer is inserted. The nonlinear path retains its
    // frequency-dependent FIR and ADAA group delay.
    std::int32_t fixedAlgorithmicSamples = 0;
    double frequencyDependentGroupDelaySamples = 0.0;
};

// Clean-room stereo distortion reconstruction for ordinal 24. The published
// parameter contract remains separate. Prepare a fresh inactive instance and
// preflight its object/state before publication; processBlock is allocation-
// free and lock-free, with one owner for reset and audio processing.
class DistortionFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const DistortionFxOptions& options = {}) noexcept;
    bool prepare(const ProcessSpec& spec, const DistortionFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const DistortionFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] DistortionModel model() const noexcept { return options_.model; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] DistortionFxLatency latency() const noexcept;

private:
    [[nodiscard]] bool validateEvent(const DistortionFxEvent& event) const noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const DistortionFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    void applyEvent(const DistortionFxEvent& event) noexcept;
    [[nodiscard]] StereoFrame processSample(StereoFrame input) noexcept;
    void advanceParameters() noexcept;

    ProcessSpec spec_{};
    DistortionFxOptions options_{};
    std::array<OversampledNonlinear, 2U> shapers_{};
    std::array<double, 2U> toneState_{};
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double smoothingCoefficient_ = 0.0;
    double toneCoefficientCurrent_ = 0.0;
    double toneCoefficientTarget_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 1.0f;
    float mixCurrent_ = 1.0f;
    float driveTarget_ = 1.0f;
    float driveCurrent_ = 1.0f;
    float outputGainTarget_ = 1.0f;
    float outputGainCurrent_ = 1.0f;
    float toneHzTarget_ = 14000.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
