#include "dsp_primitives.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::native::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kDenormalFloor = 1.0e-24;

[[nodiscard]] double flushDenormal(double value) noexcept {
    return std::fabs(value) < kDenormalFloor ? 0.0 : value;
}

[[nodiscard]] float finiteOrZero(float value) noexcept {
    return std::isfinite(value) ? value : 0.0f;
}

} // namespace

ParameterSmoother::ParameterSmoother(float initialValue) noexcept {
    reset(initialValue);
}

void ParameterSmoother::reset(float value) noexcept {
    current_ = finiteOrZero(value);
    target_ = current_;
    step_ = 0.0;
    remainingFrames_ = 0;
}

void ParameterSmoother::setTarget(float value, std::uint64_t rampFrames) noexcept {
    const float target = finiteOrZero(value);
    if (rampFrames == 0 || target == current_) {
        reset(target);
        return;
    }

    target_ = target;
    remainingFrames_ = rampFrames;
    step_ = (static_cast<double>(target_) - static_cast<double>(current_)) /
            static_cast<double>(remainingFrames_);
}

void ParameterSmoother::skip(std::uint64_t frames) noexcept {
    if (frames == 0 || remainingFrames_ == 0) {
        return;
    }
    if (frames >= remainingFrames_) {
        current_ = target_;
        step_ = 0.0;
        remainingFrames_ = 0;
        return;
    }

    current_ = static_cast<float>(static_cast<double>(current_) + step_ * static_cast<double>(frames));
    remainingFrames_ -= frames;
}

CrossfadeGains equalPowerCrossfadeGains(float position) noexcept {
    if (!(position > 0.0f)) {
        return {1.0f, 0.0f};
    }
    if (position >= 1.0f) {
        return {0.0f, 1.0f};
    }

    const double angle = static_cast<double>(position) * (kPi * 0.5);
    return {static_cast<float>(std::cos(angle)), static_cast<float>(std::sin(angle))};
}

float equalPowerCrossfade(float first, float second, float position) noexcept {
    const auto gains = equalPowerCrossfadeGains(position);
    return (first * gains.first) + (second * gains.second);
}

bool Biquad::setParameters(
    BiquadType type,
    double sampleRate,
    double frequencyHz,
    double q,
    double gainDb,
    double shelfSlope
) noexcept {
    if (!std::isfinite(sampleRate) || !std::isfinite(frequencyHz) || !std::isfinite(q) ||
        !std::isfinite(gainDb) || !std::isfinite(shelfSlope) || sampleRate <= 0.0 ||
        frequencyHz <= 0.0 || frequencyHz >= sampleRate * 0.5 || q <= 0.0 || shelfSlope <= 0.0) {
        return false;
    }

    const double omega = 2.0 * kPi * frequencyHz / sampleRate;
    const double cosine = std::cos(omega);
    const double sine = std::sin(omega);
    const double alpha = sine / (2.0 * q);
    const double amplitude = std::pow(10.0, std::clamp(gainDb, -120.0, 120.0) / 40.0);

    double b0 = 0.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a0 = 1.0;
    double a1 = 0.0;
    double a2 = 0.0;

    switch (type) {
    case BiquadType::LowPass:
        b0 = (1.0 - cosine) * 0.5;
        b1 = 1.0 - cosine;
        b2 = b0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cosine;
        a2 = 1.0 - alpha;
        break;
    case BiquadType::HighPass:
        b0 = (1.0 + cosine) * 0.5;
        b1 = -(1.0 + cosine);
        b2 = b0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cosine;
        a2 = 1.0 - alpha;
        break;
    case BiquadType::BandPass:
        // Constant skirt gain with a peak of Q at the centre frequency.
        b0 = alpha;
        b1 = 0.0;
        b2 = -alpha;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cosine;
        a2 = 1.0 - alpha;
        break;
    case BiquadType::Notch:
        b0 = 1.0;
        b1 = -2.0 * cosine;
        b2 = 1.0;
        a0 = 1.0 + alpha;
        a1 = -2.0 * cosine;
        a2 = 1.0 - alpha;
        break;
    case BiquadType::Peaking: {
        b0 = 1.0 + alpha * amplitude;
        b1 = -2.0 * cosine;
        b2 = 1.0 - alpha * amplitude;
        a0 = 1.0 + alpha / amplitude;
        a1 = -2.0 * cosine;
        a2 = 1.0 - alpha / amplitude;
        break;
    }
    case BiquadType::LowShelf:
    case BiquadType::HighShelf: {
        const double slope = std::clamp(shelfSlope, 0.01, 4.0);
        const double alphaShelf = sine * 0.5 * std::sqrt((amplitude + 1.0 / amplitude) * (1.0 / slope - 1.0) + 2.0);
        const double beta = 2.0 * std::sqrt(amplitude) * alphaShelf;
        if (type == BiquadType::LowShelf) {
            b0 = amplitude * ((amplitude + 1.0) - (amplitude - 1.0) * cosine + beta);
            b1 = 2.0 * amplitude * ((amplitude - 1.0) - (amplitude + 1.0) * cosine);
            b2 = amplitude * ((amplitude + 1.0) - (amplitude - 1.0) * cosine - beta);
            a0 = (amplitude + 1.0) + (amplitude - 1.0) * cosine + beta;
            a1 = -2.0 * ((amplitude - 1.0) + (amplitude + 1.0) * cosine);
            a2 = (amplitude + 1.0) + (amplitude - 1.0) * cosine - beta;
        } else {
            b0 = amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cosine + beta);
            b1 = -2.0 * amplitude * ((amplitude - 1.0) + (amplitude + 1.0) * cosine);
            b2 = amplitude * ((amplitude + 1.0) + (amplitude - 1.0) * cosine - beta);
            a0 = (amplitude + 1.0) - (amplitude - 1.0) * cosine + beta;
            a1 = 2.0 * ((amplitude - 1.0) - (amplitude + 1.0) * cosine);
            a2 = (amplitude + 1.0) - (amplitude - 1.0) * cosine - beta;
        }
        break;
    }
    default:
        return false;
    }

    if (!std::isfinite(a0) || std::fabs(a0) < std::numeric_limits<double>::min()) {
        return false;
    }

    const double inverseA0 = 1.0 / a0;
    const BiquadCoefficients candidate{
        b0 * inverseA0,
        b1 * inverseA0,
        b2 * inverseA0,
        a1 * inverseA0,
        a2 * inverseA0,
    };
    if (!std::isfinite(candidate.b0) || !std::isfinite(candidate.b1) || !std::isfinite(candidate.b2) ||
        !std::isfinite(candidate.a1) || !std::isfinite(candidate.a2)) {
        return false;
    }
    coefficients_ = candidate;
    return true;
}

bool Biquad::setCoefficients(const BiquadCoefficients& coefficients) noexcept {
    if (!std::isfinite(coefficients.b0) || !std::isfinite(coefficients.b1) || !std::isfinite(coefficients.b2) ||
        !std::isfinite(coefficients.a1) || !std::isfinite(coefficients.a2)) {
        return false;
    }
    coefficients_ = coefficients;
    return true;
}

void Biquad::reset() noexcept {
    state1_ = 0.0;
    state2_ = 0.0;
}

float Biquad::process(float input) noexcept {
    const double x = static_cast<double>(input);
    const double y = coefficients_.b0 * x + state1_;
    state1_ = flushDenormal(coefficients_.b1 * x - coefficients_.a1 * y + state2_);
    state2_ = flushDenormal(coefficients_.b2 * x - coefficients_.a2 * y);
    return static_cast<float>(y);
}

bool TptStateVariableFilter::setParameters(double sampleRate, double cutoffHz, double q) noexcept {
    if (!std::isfinite(sampleRate) || !std::isfinite(cutoffHz) || !std::isfinite(q) || sampleRate <= 0.0 ||
        cutoffHz <= 0.0 || cutoffHz >= sampleRate * 0.5 || q < 1.0e-3 || q > 1.0e6) {
        return false;
    }

    const double g = std::tan(kPi * cutoffHz / sampleRate);
    const double k = 1.0 / q;
    const double a1 = 1.0 / (1.0 + g * (g + k));
    const double a2 = g * a1;
    const double a3 = g * a2;
    if (!std::isfinite(a1) || !std::isfinite(a2) || !std::isfinite(a3)) {
        return false;
    }
    a1_ = a1;
    a2_ = a2;
    a3_ = a3;
    k_ = k;
    return true;
}

void TptStateVariableFilter::reset() noexcept {
    integrator1_ = 0.0;
    integrator2_ = 0.0;
}

SvfOutput TptStateVariableFilter::process(float input) noexcept {
    const double x = static_cast<double>(input);
    const double v3 = x - integrator2_;
    const double v1 = a1_ * integrator1_ + a2_ * v3;
    const double v2 = integrator2_ + a2_ * integrator1_ + a3_ * v3;

    integrator1_ = flushDenormal(2.0 * v1 - integrator1_);
    integrator2_ = flushDenormal(2.0 * v2 - integrator2_);

    const double high = x - k_ * v1 - v2;
    return {
        static_cast<float>(v2),
        static_cast<float>(v1),
        static_cast<float>(high),
        static_cast<float>(high + v2),
    };
}

float lagrange4(float xMinus1, float x0, float xPlus1, float xPlus2, float fraction) noexcept {
    const double mu = std::clamp(static_cast<double>(finiteOrZero(fraction)), 0.0, 1.0);
    const double weightMinus1 = -(mu * (mu - 1.0) * (mu - 2.0)) / 6.0;
    const double weight0 = ((mu + 1.0) * (mu - 1.0) * (mu - 2.0)) / 2.0;
    const double weightPlus1 = -((mu + 1.0) * mu * (mu - 2.0)) / 2.0;
    const double weightPlus2 = ((mu + 1.0) * mu * (mu - 1.0)) / 6.0;
    return static_cast<float>(weightMinus1 * xMinus1 + weight0 * x0 + weightPlus1 * xPlus1 + weightPlus2 * xPlus2);
}

DeterministicRng::DeterministicRng(std::uint64_t seedValue) noexcept : state_(seedValue) {}

std::uint32_t DeterministicRng::nextUInt32() noexcept {
    std::uint64_t value = (state_ += 0x9e3779b97f4a7c15ULL);
    value = (value ^ (value >> 30U)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27U)) * 0x94d049bb133111ebULL;
    value ^= value >> 31U;
    return static_cast<std::uint32_t>(value >> 32U);
}

float DeterministicRng::nextUnitFloat() noexcept {
    return static_cast<float>(nextUInt32() >> 8U) * (1.0f / 16777216.0f);
}

float DeterministicRng::nextBipolarFloat() noexcept {
    return nextUnitFloat() * 2.0f - 1.0f;
}

bool AbsoluteBeatClock::configure(std::uint32_t sampleRateValue, double bpmValue, std::uint64_t originFrameValue) noexcept {
    if (sampleRateValue == 0 || !std::isfinite(bpmValue) || bpmValue <= 0.0) {
        return false;
    }
    sampleRate_ = sampleRateValue;
    bpm_ = bpmValue;
    originFrame_ = originFrameValue;
    return true;
}

std::uint64_t AbsoluteBeatClock::frameForBeat(std::uint64_t beatIndex) const noexcept {
    if (sampleRate_ == 0 || bpm_ <= 0.0) {
        return originFrame_;
    }

    const long double offset = (static_cast<long double>(beatIndex) * static_cast<long double>(sampleRate_) * 60.0L) /
                               static_cast<long double>(bpm_);
    const long double roundedOffset = std::floor(offset + 0.5L);
    const std::uint64_t maxOffset = std::numeric_limits<std::uint64_t>::max() - originFrame_;
    if (!std::isfinite(roundedOffset) || roundedOffset >= static_cast<long double>(maxOffset)) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    return originFrame_ + static_cast<std::uint64_t>(roundedOffset);
}

std::uint64_t AbsoluteBeatClock::beatAtFrame(std::uint64_t frame) const noexcept {
    if (sampleRate_ == 0 || bpm_ <= 0.0 || frame <= originFrame_) {
        return 0;
    }

    const long double elapsed = static_cast<long double>(frame - originFrame_);
    const long double beat = std::floor(elapsed * static_cast<long double>(bpm_) /
                                        (60.0L * static_cast<long double>(sampleRate_)));
    if (!std::isfinite(beat) || beat >= static_cast<long double>(std::numeric_limits<std::uint64_t>::max())) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    return static_cast<std::uint64_t>(beat);
}

} // namespace webrc::native::dsp
