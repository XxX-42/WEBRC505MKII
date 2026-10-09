#pragma once

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

enum class OversamplingFactor : std::uint8_t {
    x2 = 2,
    x4 = 4,
};

enum class NonlinearModel : std::uint8_t {
    AdaaCubic,
    WdfSymmetricDiode,
};

struct WdfPortSample {
    double incident = 0.0;
    double reflected = 0.0;
    double voltage = 0.0;
    double current = 0.0;
};

// A memoryless symmetric antiparallel-diode one-port. The incident/reflected
// wave convention is a=v+Ri, b=v-Ri. The scattering equation is solved with
// bounded Newton iterations; no table or allocation is used on the audio path.
class WdfSymmetricDiode {
public:
    bool prepare(const ProcessSpec& spec, double portResistance = 1000.0,
                 double saturationCurrent = 2.0e-9,
                 double thermalVoltage = 0.02585,
                 double ideality = 1.0) noexcept;
    void reset() noexcept {}
    bool setParameters(double portResistance, double saturationCurrent,
                       double thermalVoltage, double ideality = 1.0) noexcept;
    [[nodiscard]] WdfPortSample processPort(float incidentWave) const noexcept;
    [[nodiscard]] float processSample(float incidentWave) const noexcept;
    bool processBlock(const float* input, float* output, std::uint32_t frames) const noexcept;
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    double portResistance_ = 1000.0;
    double saturationCurrent_ = 2.0e-9;
    double thermalVoltage_ = 0.02585;
    double ideality_ = 1.0;
    std::uint32_t maxBlockFrames_ = 64;
    bool prepared_ = false;
};

// Sparse 2x half-band FIR stages are cascaded for 4x operation. All histories
// and coefficients are fixed-size and prepared before processing. The FIR
// delay is fractional in input-sample units because decimation selects the
// second phase. ADAA adds frequency-dependent phase delay; low-frequency
// first-order ADAA is approximately half an oversampled period.
class OversampledNonlinear {
public:
    bool prepare(const ProcessSpec& spec, OversamplingFactor factor,
                 NonlinearModel model) noexcept;
    void reset() noexcept;
    bool setDrive(float drive) noexcept;
    bool setDiodeParameters(double portResistance, double saturationCurrent,
                            double thermalVoltage, double ideality = 1.0) noexcept;
    [[nodiscard]] float processSample(float input) noexcept;
    bool processBlock(const float* input, float* output, std::uint32_t frames) noexcept;
    [[nodiscard]] OversamplingFactor factor() const noexcept { return factor_; }
    [[nodiscard]] NonlinearModel model() const noexcept { return model_; }
    [[nodiscard]] double firGroupDelaySamples() const noexcept;
    [[nodiscard]] double adaaLowFrequencyGroupDelaySamples() const noexcept;
    [[nodiscard]] double lowFrequencySmallSignalGroupDelaySamples() const noexcept;
    [[nodiscard]] std::uint32_t maxBlockFrames() const noexcept { return spec_.maxBlockFrames; }

private:
    static constexpr std::size_t kFirTaps = 31;
    using FirHistory = std::array<double, kFirTaps>;
    static void makeHalfBand(std::array<double, kFirTaps>& coefficients) noexcept;
    [[nodiscard]] double upsamplePush(FirHistory& history, std::size_t& position,
                                     double input) const noexcept;
    [[nodiscard]] double decimatePair(FirHistory& history, std::size_t& position,
                                      double first, double second) const noexcept;
    [[nodiscard]] double shape(double input) noexcept;

    ProcessSpec spec_{};
    OversamplingFactor factor_ = OversamplingFactor::x2;
    NonlinearModel model_ = NonlinearModel::AdaaCubic;
    std::array<double, kFirTaps> halfBand_{};
    FirHistory up1History_{};
    FirHistory up2History_{};
    FirHistory down1History_{};
    FirHistory down2History_{};
    std::size_t up1Position_ = 0;
    std::size_t up2Position_ = 0;
    std::size_t down1Position_ = 0;
    std::size_t down2Position_ = 0;
    AdaaCubicShaper adaa_;
    WdfSymmetricDiode diode_;
    bool prepared_ = false;
};

} // namespace webrc::dsp
