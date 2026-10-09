#include "webrc/dsp/nonlinear.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {

namespace {
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kMaximumIncidentWave = 32.0;

float finiteFloat(double value) noexcept {
    constexpr double limit = static_cast<double>(std::numeric_limits<float>::max());
    if (!std::isfinite(value)) {
        return std::signbit(value) ? -std::numeric_limits<float>::max()
                                   : std::numeric_limits<float>::max();
    }
    return static_cast<float>(std::clamp(value, -limit, limit));
}
} // namespace

bool WdfSymmetricDiode::prepare(const ProcessSpec& spec, double portResistance,
                                double saturationCurrent, double thermalVoltage,
                                double ideality) noexcept {
    if (!validProcessSpec(spec) ||
        !setParameters(portResistance, saturationCurrent, thermalVoltage, ideality)) {
        return false;
    }
    maxBlockFrames_ = spec.maxBlockFrames;
    prepared_ = true;
    return true;
}

bool WdfSymmetricDiode::setParameters(double portResistance, double saturationCurrent,
                                      double thermalVoltage, double ideality) noexcept {
    if (!std::isfinite(portResistance) || portResistance < 1.0 || portResistance > 1.0e6 ||
        !std::isfinite(saturationCurrent) || saturationCurrent < 1.0e-12 ||
        saturationCurrent > 1.0e-3 || !std::isfinite(thermalVoltage) ||
        thermalVoltage < 0.005 || thermalVoltage > 0.2 || !std::isfinite(ideality) ||
        ideality < 0.5 || ideality > 4.0) {
        return false;
    }
    portResistance_ = portResistance;
    saturationCurrent_ = saturationCurrent;
    thermalVoltage_ = thermalVoltage;
    ideality_ = ideality;
    return true;
}

WdfPortSample WdfSymmetricDiode::processPort(float incidentWave) const noexcept {
    if (!prepared_) return {};
    const double incident = std::clamp(static_cast<double>(sanitize(incidentWave)),
                                       -kMaximumIncidentWave, kMaximumIncidentWave);
    const double voltageScale = ideality_ * thermalVoltage_;
    const double nonlinearScale = 2.0 * portResistance_ * saturationCurrent_;
    // Ignore the small resistor-voltage term for the initial estimate, then
    // solve a=v+Ri with a monotone Newton iteration. The clamp keeps exp/sinh
    // finite for every accepted input and remains well outside normal audio.
    double voltage = voltageScale * std::asinh(incident / nonlinearScale);
    voltage = std::clamp(voltage, -std::fabs(incident), std::fabs(incident));
    for (int iteration = 0; iteration < 12; ++iteration) {
        const double normalizedVoltage = std::clamp(voltage / voltageScale, -40.0, 40.0);
        const double current = 2.0 * saturationCurrent_ * std::sinh(normalizedVoltage);
        const double derivative = 1.0 + (nonlinearScale / voltageScale) *
            std::cosh(normalizedVoltage);
        const double residual = voltage + portResistance_ * current - incident;
        if (!std::isfinite(residual) || !std::isfinite(derivative) || derivative <= 0.0) {
            break;
        }
        const double correction = residual / derivative;
        voltage = std::clamp(voltage - correction, -kMaximumIncidentWave,
                             kMaximumIncidentWave);
        if (std::fabs(correction) < 1.0e-13) break;
    }

    const double normalizedVoltage = std::clamp(voltage / voltageScale, -40.0, 40.0);
    const double current = 2.0 * saturationCurrent_ * std::sinh(normalizedVoltage);
    const double reflected = voltage - portResistance_ * current;
    return {incident, reflected, voltage, current};
}

float WdfSymmetricDiode::processSample(float incidentWave) const noexcept {
    return sanitize(finiteFloat(processPort(incidentWave).voltage));
}

bool WdfSymmetricDiode::processBlock(const float* input, float* output,
                                     std::uint32_t frames) const noexcept {
    if (!prepared_ || !input || !output || frames > maxBlockFrames_) return false;
    for (std::uint32_t i = 0; i < frames; ++i) output[i] = processSample(input[i]);
    return true;
}

bool OversampledNonlinear::prepare(const ProcessSpec& spec, OversamplingFactor factor,
                                   NonlinearModel model) noexcept {
    if (!validProcessSpec(spec) ||
        (factor != OversamplingFactor::x2 && factor != OversamplingFactor::x4) ||
        (model != NonlinearModel::AdaaCubic && model != NonlinearModel::WdfSymmetricDiode) ||
        !adaa_.prepare(spec) || !diode_.prepare(spec)) {
        return false;
    }
    spec_ = spec;
    factor_ = factor;
    model_ = model;
    makeHalfBand(halfBand_);
    prepared_ = true;
    reset();
    return true;
}

void OversampledNonlinear::reset() noexcept {
    up1History_.fill(0.0);
    up2History_.fill(0.0);
    down1History_.fill(0.0);
    down2History_.fill(0.0);
    up1Position_ = up2Position_ = down1Position_ = down2Position_ = 0;
    adaa_.reset();
    diode_.reset();
}

bool OversampledNonlinear::setDrive(float drive) noexcept {
    return prepared_ && model_ == NonlinearModel::AdaaCubic && adaa_.setDrive(drive);
}

bool OversampledNonlinear::setDiodeParameters(double portResistance,
                                              double saturationCurrent,
                                              double thermalVoltage,
                                              double ideality) noexcept {
    return prepared_ && model_ == NonlinearModel::WdfSymmetricDiode &&
        diode_.setParameters(portResistance, saturationCurrent, thermalVoltage, ideality);
}

float OversampledNonlinear::processSample(float input) noexcept {
    if (!prepared_) return 0.0f;
    const double x = static_cast<double>(sanitize(input));
    const double up0 = upsamplePush(up1History_, up1Position_, 2.0 * x);
    const double up1 = upsamplePush(up1History_, up1Position_, 0.0);
    double output = 0.0;
    if (factor_ == OversamplingFactor::x2) {
        const double shaped0 = shape(up0);
        const double shaped1 = shape(up1);
        output = decimatePair(down1History_, down1Position_, shaped0, shaped1);
    } else {
        const double up2a0 = upsamplePush(up2History_, up2Position_, 2.0 * up0);
        const double up2a1 = upsamplePush(up2History_, up2Position_, 0.0);
        const double up2b0 = upsamplePush(up2History_, up2Position_, 2.0 * up1);
        const double up2b1 = upsamplePush(up2History_, up2Position_, 0.0);
        const double shaped0 = shape(up2a0);
        const double shaped1 = shape(up2a1);
        const double shaped2 = shape(up2b0);
        const double shaped3 = shape(up2b1);
        const double down2a = decimatePair(down2History_, down2Position_, shaped0, shaped1);
        const double down2b = decimatePair(down2History_, down2Position_, shaped2, shaped3);
        output = decimatePair(down1History_, down1Position_, down2a, down2b);
    }
    return sanitize(finiteFloat(output));
}

bool OversampledNonlinear::processBlock(const float* input, float* output,
                                        std::uint32_t frames) noexcept {
    if (!prepared_ || !input || !output || frames > spec_.maxBlockFrames) return false;
    for (std::uint32_t i = 0; i < frames; ++i) output[i] = processSample(input[i]);
    return true;
}

double OversampledNonlinear::firGroupDelaySamples() const noexcept {
    // Each 31-tap stage has 15 samples of delay at its local rate. Keeping the
    // second decimation phase subtracts 0.5 base sample at 2x and 0.75 at 4x.
    return factor_ == OversamplingFactor::x2 ? 14.5 : 21.75;
}

double OversampledNonlinear::adaaLowFrequencyGroupDelaySamples() const noexcept {
    return model_ == NonlinearModel::AdaaCubic ?
        0.5 / static_cast<double>(static_cast<std::uint8_t>(factor_)) : 0.0;
}

double OversampledNonlinear::lowFrequencySmallSignalGroupDelaySamples() const noexcept {
    return firGroupDelaySamples() + adaaLowFrequencyGroupDelaySamples();
}

void OversampledNonlinear::makeHalfBand(
    std::array<double, kFirTaps>& coefficients) noexcept {
    double sum = 0.0;
    constexpr auto center = static_cast<std::int64_t>((kFirTaps - 1U) / 2U);
    for (std::size_t index = 0; index < kFirTaps; ++index) {
        const auto offset = static_cast<std::int64_t>(index) - center;
        if (offset != 0 && offset % 2 == 0) {
            coefficients[index] = 0.0;
            continue;
        }
        const double ideal = offset == 0 ? 0.5 :
            std::sin(0.5 * kPi * static_cast<double>(offset)) /
                (kPi * static_cast<double>(offset));
        const double window = 0.42 - 0.5 * std::cos(
            2.0 * kPi * static_cast<double>(index) / static_cast<double>(kFirTaps - 1U)) +
            0.08 * std::cos(4.0 * kPi * static_cast<double>(index) /
                            static_cast<double>(kFirTaps - 1U));
        coefficients[index] = ideal * window;
        sum += coefficients[index];
    }
    if (sum != 0.0) {
        for (auto& coefficient : coefficients) coefficient /= sum;
    }
}

double OversampledNonlinear::upsamplePush(FirHistory& history, std::size_t& position,
                                          double input) const noexcept {
    history[position] = input;
    double output = 0.0;
    auto tapIndex = position;
    for (std::size_t tap = 0; tap < kFirTaps; ++tap) {
        if (halfBand_[tap] != 0.0) output += halfBand_[tap] * history[tapIndex];
        tapIndex = tapIndex == 0 ? kFirTaps - 1U : tapIndex - 1U;
    }
    position = position + 1U == kFirTaps ? 0U : position + 1U;
    return output;
}

double OversampledNonlinear::decimatePair(FirHistory& history, std::size_t& position,
                                          double first, double second) const noexcept {
    (void)upsamplePush(history, position, first);
    return upsamplePush(history, position, second);
}

double OversampledNonlinear::shape(double input) noexcept {
    const float sample = finiteFloat(input);
    if (model_ == NonlinearModel::AdaaCubic) return adaa_.processSample(sample);
    return diode_.processSample(sample);
}

} // namespace webrc::dsp
