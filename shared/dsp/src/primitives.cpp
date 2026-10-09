#include "webrc/dsp/primitives.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr float kDenormalThreshold = 1.0e-20f;

bool finite(double value) noexcept {
    return std::isfinite(value);
}

float flushState(float value) noexcept {
    return sanitize(value);
}

double flushState(double value) noexcept {
    return !std::isfinite(value) || std::fabs(value) < static_cast<double>(kDenormalThreshold)
               ? 0.0
               : value;
}

float finiteFloat(double value) noexcept {
    constexpr double maximum = static_cast<double>(std::numeric_limits<float>::max());
    if (!std::isfinite(value)) {
        return value < 0.0 ? -std::numeric_limits<float>::max()
                           : std::numeric_limits<float>::max();
    }
    return static_cast<float>(std::clamp(value, -maximum, maximum));
}

std::size_t wrapped(std::int64_t index, std::size_t size) noexcept {
    const auto n = static_cast<std::int64_t>(size);
    auto result = index % n;
    if (result < 0) {
        result += n;
    }
    return static_cast<std::size_t>(result);
}

} // namespace

bool validProcessSpec(const ProcessSpec& spec) noexcept {
    return std::isfinite(spec.sampleRate) && spec.sampleRate >= 8000.0f &&
           spec.sampleRate <= 384000.0f && spec.maxBlockFrames > 0 &&
           spec.maxBlockFrames <= 8192 && spec.channels > 0 && spec.channels <= 2;
}

float sanitize(float value) noexcept {
    if (!std::isfinite(value) || std::fabs(value) < kDenormalThreshold) {
        return 0.0f;
    }
    return value;
}

float equalPowerCrossfade(float a, float b, float phase) noexcept {
    const auto u = static_cast<double>(std::clamp(sanitize(phase), 0.0f, 1.0f));
    const auto angle = kPi * u * 0.5;
    return sanitize(static_cast<float>(std::cos(angle) * sanitize(a) +
                                       std::sin(angle) * sanitize(b)));
}

StereoGains equalPowerPan(float pan) noexcept {
    const auto p = static_cast<double>(std::clamp(sanitize(pan), -1.0f, 1.0f));
    const auto angle = kPi * (p + 1.0) * 0.25;
    return {sanitize(static_cast<float>(std::cos(angle))),
            sanitize(static_cast<float>(std::sin(angle)))};
}

bool ParameterSmoother::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) {
        return false;
    }
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    coefficient_ = 0.0f;
    return true;
}

void ParameterSmoother::reset(float value) noexcept {
    current_ = std::clamp(sanitize(value), -1.0e6f, 1.0e6f);
    target_ = current_;
    coefficient_ = 0.0f;
}

bool ParameterSmoother::setTarget(float value, float timeMs) noexcept {
    if (!std::isfinite(value) || std::fabs(value) > 1.0e6f || !std::isfinite(timeMs) ||
        timeMs < 0.0f || timeMs > 10000.0f) {
        return false;
    }
    target_ = value;
    if (timeMs == 0.0f) {
        current_ = target_;
        coefficient_ = 0.0f;
        return true;
    }
    const auto timeSeconds = static_cast<double>(std::max(timeMs, 0.1f)) * 0.001;
    coefficient_ = static_cast<float>(std::exp(-1.0 / (timeSeconds * sampleRate_)));
    return true;
}

float ParameterSmoother::next() noexcept {
    current_ = target_ + coefficient_ * (current_ - target_);
    if (std::fabs(current_ - target_) < 1.0e-7f) {
        current_ = target_;
    }
    current_ = flushState(current_);
    return current_;
}

bool ParameterSmoother::processBlock(float* output, std::uint32_t frames) noexcept {
    if (!output || frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        output[i] = next();
    }
    return true;
}

bool BiquadDf2T::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) {
        return false;
    }
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    coefficients_ = {};
    targetCoefficients_ = {};
    coefficientStep_ = {};
    coefficientRampRemaining_ = 0;
    prepared_ = true;
    reset();
    return true;
}

void BiquadDf2T::reset() noexcept {
    z1_ = 0.0;
    z2_ = 0.0;
}

bool BiquadDf2T::setCoefficients(const BiquadCoefficients& coefficients,
                                float smoothingMs) noexcept {
    constexpr double maxNumeratorMagnitude = 1.0e6;
    if (!finite(coefficients.b0) || !finite(coefficients.b1) || !finite(coefficients.b2) ||
        !finite(coefficients.a1) || !finite(coefficients.a2) || !std::isfinite(smoothingMs) ||
        std::fabs(coefficients.b0) > maxNumeratorMagnitude ||
        std::fabs(coefficients.b1) > maxNumeratorMagnitude ||
        std::fabs(coefficients.b2) > maxNumeratorMagnitude ||
        smoothingMs < 0.0f || smoothingMs > 10000.0f) {
        return false;
    }
    // Strict Schur/Jury stability conditions for z^2 + a1*z + a2. Do not
    // apply a coarse margin here: it would reject valid very-low-frequency poles.
    if (std::fabs(coefficients.a2) >= 1.0 ||
        1.0 + coefficients.a1 + coefficients.a2 <= 0.0 ||
        1.0 - coefficients.a1 + coefficients.a2 <= 0.0) {
        return false;
    }
    targetCoefficients_ = coefficients;
    const auto rampSamples = static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(smoothingMs) * 0.001 * sampleRate_));
    if (rampSamples == 0) {
        coefficients_ = targetCoefficients_;
        coefficientStep_ = {};
        coefficientRampRemaining_ = 0;
        return true;
    }
    const auto divisor = static_cast<double>(rampSamples);
    coefficientStep_ = {
        (targetCoefficients_.b0 - coefficients_.b0) / divisor,
        (targetCoefficients_.b1 - coefficients_.b1) / divisor,
        (targetCoefficients_.b2 - coefficients_.b2) / divisor,
        (targetCoefficients_.a1 - coefficients_.a1) / divisor,
        (targetCoefficients_.a2 - coefficients_.a2) / divisor,
    };
    coefficientRampRemaining_ = rampSamples;
    return true;
}

bool BiquadDf2T::makeRbJ(float frequencyHz, float q, float gainDb, unsigned int type,
                         float smoothingMs) noexcept {
    if (!prepared_ || !std::isfinite(frequencyHz) || !std::isfinite(q) || q < 0.1f ||
        q > 50.0f || !std::isfinite(gainDb) || gainDb < -36.0f || gainDb > 36.0f ||
        frequencyHz < 0.5f || frequencyHz > sampleRate_ * 0.49) {
        return false;
    }

    const double w0 = 2.0 * kPi * static_cast<double>(frequencyHz) / sampleRate_;
    const double cosine = std::cos(w0);
    const double sine = std::sin(w0);
    const double alpha = sine / (2.0 * static_cast<double>(q));
    double b0 = 0.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a0 = 1.0 + alpha;
    double a1 = -2.0 * cosine;
    double a2 = 1.0 - alpha;

    switch (type) {
    case 0: // low-pass
        b0 = (1.0 - cosine) * 0.5;
        b1 = 1.0 - cosine;
        b2 = b0;
        break;
    case 1: // high-pass
        b0 = (1.0 + cosine) * 0.5;
        b1 = -(1.0 + cosine);
        b2 = b0;
        break;
    case 2: // constant-skirt band-pass, peak gain = Q
        b0 = sine * 0.5;
        b1 = 0.0;
        b2 = -b0;
        break;
    case 3: { // peaking EQ
        const double amplitude = std::pow(10.0, static_cast<double>(gainDb) / 40.0);
        b0 = 1.0 + alpha * amplitude;
        b1 = -2.0 * cosine;
        b2 = 1.0 - alpha * amplitude;
        a0 = 1.0 + alpha / amplitude;
        a1 = -2.0 * cosine;
        a2 = 1.0 - alpha / amplitude;
        break;
    }
    default:
        return false;
    }

    return setCoefficients({b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0},
                           smoothingMs);
}

bool BiquadDf2T::setLowpass(float frequencyHz, float q, float smoothingMs) noexcept {
    return makeRbJ(frequencyHz, q, 0.0f, 0, smoothingMs);
}

bool BiquadDf2T::setHighpass(float frequencyHz, float q, float smoothingMs) noexcept {
    return makeRbJ(frequencyHz, q, 0.0f, 1, smoothingMs);
}

bool BiquadDf2T::setBandpass(float frequencyHz, float q, float smoothingMs) noexcept {
    return makeRbJ(frequencyHz, q, 0.0f, 2, smoothingMs);
}

bool BiquadDf2T::setPeaking(float frequencyHz, float q, float gainDb,
                            float smoothingMs) noexcept {
    return makeRbJ(frequencyHz, q, gainDb, 3, smoothingMs);
}

bool BiquadDf2T::makeRbJShelf(float frequencyHz, float gainDb, float slope,
                              bool highShelf, float smoothingMs) noexcept {
    if (!prepared_ || !std::isfinite(frequencyHz) || frequencyHz < 0.5f ||
        frequencyHz > sampleRate_ * 0.49 || !std::isfinite(gainDb) ||
        gainDb < -36.0f || gainDb > 36.0f || !std::isfinite(slope) ||
        slope < 0.1f || slope > 1.0f || !std::isfinite(smoothingMs) ||
        smoothingMs < 0.0f || smoothingMs > 10000.0f) {
        return false;
    }

    const double amplitude = std::pow(10.0, static_cast<double>(gainDb) / 40.0);
    const double w0 = 2.0 * kPi * static_cast<double>(frequencyHz) / sampleRate_;
    const double cosine = std::cos(w0);
    const double sine = std::sin(w0);
    const double slopeTerm = (amplitude + 1.0 / amplitude) *
                             (1.0 / static_cast<double>(slope) - 1.0) + 2.0;
    if (!finite(amplitude) || !finite(slopeTerm) || slopeTerm <= 0.0) return false;
    const double alpha = 0.5 * sine * std::sqrt(slopeTerm);
    const double beta = 2.0 * std::sqrt(amplitude) * alpha;
    double b0 = 0.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a0 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
    if (!highShelf) {
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
    if (!finite(a0) || a0 <= 0.0) return false;
    return setCoefficients({b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0},
                           smoothingMs);
}

bool BiquadDf2T::setLowShelf(float frequencyHz, float gainDb, float slope,
                             float smoothingMs) noexcept {
    return makeRbJShelf(frequencyHz, gainDb, slope, false, smoothingMs);
}

bool BiquadDf2T::setHighShelf(float frequencyHz, float gainDb, float slope,
                              float smoothingMs) noexcept {
    return makeRbJShelf(frequencyHz, gainDb, slope, true, smoothingMs);
}

void BiquadDf2T::advanceCoefficients() noexcept {
    if (coefficientRampRemaining_ == 0) {
        return;
    }
    coefficients_.b0 += coefficientStep_.b0;
    coefficients_.b1 += coefficientStep_.b1;
    coefficients_.b2 += coefficientStep_.b2;
    coefficients_.a1 += coefficientStep_.a1;
    coefficients_.a2 += coefficientStep_.a2;
    if (--coefficientRampRemaining_ == 0) {
        coefficients_ = targetCoefficients_;
        coefficientStep_ = {};
    }
}

float BiquadDf2T::processSample(float input) noexcept {
    const double x = sanitize(input);
    const double yDouble = coefficients_.b0 * x + z1_;
    const float y = sanitize(finiteFloat(yDouble));
    z1_ = flushState(coefficients_.b1 * x - coefficients_.a1 * yDouble + z2_);
    z2_ = flushState(coefficients_.b2 * x - coefficients_.a2 * yDouble);
    advanceCoefficients();
    return y;
}

bool BiquadDf2T::processBlock(const float* input, float* output, std::uint32_t frames) noexcept {
    if (!prepared_ || !input || !output || frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        output[i] = processSample(input[i]);
    }
    return true;
}

bool TptStateVariableFilter::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) {
        return false;
    }
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    g_ = targetG_ = stepG_ = 0.0f;
    k_ = targetK_ = 1.41421356237f;
    a1_ = 1.0f;
    a2_ = a3_ = 0.0f;
    stepK_ = stepA1_ = stepA2_ = stepA3_ = 0.0f;
    coefficientRampRemaining_ = 0;
    prepared_ = true;
    reset();
    return true;
}

void TptStateVariableFilter::reset() noexcept {
    ic1_ = 0.0f;
    ic2_ = 0.0f;
}

bool TptStateVariableFilter::setFrequencyQ(float frequencyHz, float q,
                                          float smoothingMs) noexcept {
    if (!prepared_ || !std::isfinite(frequencyHz) || !std::isfinite(q) ||
        frequencyHz < 0.5f || frequencyHz > sampleRate_ * 0.49 || q < 0.1f || q > 50.0f ||
        !std::isfinite(smoothingMs) || smoothingMs < 0.0f || smoothingMs > 10000.0f) {
        return false;
    }
    const double g = std::tan(kPi * static_cast<double>(frequencyHz) / sampleRate_);
    const double k = 1.0 / static_cast<double>(q);
    targetG_ = static_cast<float>(g);
    targetK_ = static_cast<float>(k);
    const auto rampSamples = static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(smoothingMs) * 0.001 * sampleRate_));
    if (rampSamples == 0) {
        g_ = targetG_;
        k_ = targetK_;
        coefficientRampRemaining_ = 0;
        stepG_ = 0.0f;
        stepK_ = 0.0f;
        stepA1_ = 0.0f;
        stepA2_ = 0.0f;
        stepA3_ = 0.0f;
    } else {
        stepG_ = (targetG_ - g_) / static_cast<float>(rampSamples);
        stepK_ = (targetK_ - k_) / static_cast<float>(rampSamples);
        const double targetA1 = 1.0 / (1.0 + static_cast<double>(targetG_) *
                                                 (targetG_ + targetK_));
        const double targetA2 = static_cast<double>(targetG_) * targetA1;
        const double targetA3 = static_cast<double>(targetG_) * targetG_ * targetA1;
        stepA1_ = (static_cast<float>(targetA1) - a1_) / static_cast<float>(rampSamples);
        stepA2_ = (static_cast<float>(targetA2) - a2_) / static_cast<float>(rampSamples);
        stepA3_ = (static_cast<float>(targetA3) - a3_) / static_cast<float>(rampSamples);
        coefficientRampRemaining_ = rampSamples;
    }
    const auto coefficientG = coefficientRampRemaining_ == 0 ? g_ : targetG_;
    const auto coefficientK = coefficientRampRemaining_ == 0 ? k_ : targetK_;
    const auto coefficientA1 = 1.0 / (1.0 + static_cast<double>(coefficientG) *
                                                 (coefficientG + coefficientK));
    a1_ = static_cast<float>(coefficientA1);
    a2_ = static_cast<float>(coefficientG * coefficientA1);
    a3_ = static_cast<float>(coefficientG * coefficientG * coefficientA1);
    return true;
}

SvfOutput TptStateVariableFilter::processSample(float input) noexcept {
    if (coefficientRampRemaining_ > 0) {
        g_ += stepG_;
        k_ += stepK_;
        if (--coefficientRampRemaining_ == 0) {
            g_ = targetG_;
            k_ = targetK_;
        }
        a1_ += stepA1_;
        a2_ += stepA2_;
        a3_ += stepA3_;
        if (coefficientRampRemaining_ == 0) {
            const double coefficientA1 = 1.0 / (1.0 + static_cast<double>(g_) * (g_ + k_));
            a1_ = static_cast<float>(coefficientA1);
            a2_ = static_cast<float>(g_ * coefficientA1);
            a3_ = static_cast<float>(g_ * g_ * coefficientA1);
            stepA1_ = stepA2_ = stepA3_ = 0.0f;
        }
    }
    const float x = sanitize(input);
    const float v3 = x - ic2_;
    const float v1 = a1_ * ic1_ + a2_ * v3;
    const float v2 = ic2_ + a2_ * ic1_ + a3_ * v3;
    ic1_ = flushState(2.0f * v1 - ic1_);
    ic2_ = flushState(2.0f * v2 - ic2_);
    return {sanitize(v2), sanitize(v1), sanitize(x - k_ * v1 - v2)};
}

bool TptStateVariableFilter::processBlock(const float* input, float* low, float* band,
                                          float* high, std::uint32_t frames) noexcept {
    if (!prepared_ || !input || !low || !band || !high || frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto output = processSample(input[i]);
        low[i] = output.low;
        band[i] = output.band;
        high[i] = output.high;
    }
    return true;
}

bool AllPass1::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) {
        return false;
    }
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    coefficient_ = targetCoefficient_ = coefficientStep_ = 0.0f;
    coefficientRampRemaining_ = 0;
    prepared_ = true;
    reset();
    return true;
}

void AllPass1::reset() noexcept {
    x1_ = 0.0f;
    y1_ = 0.0f;
}

bool AllPass1::setFrequency(float frequencyHz, float smoothingMs) noexcept {
    if (!prepared_ || !std::isfinite(frequencyHz) || frequencyHz < 0.5f ||
        frequencyHz > sampleRate_ * 0.49 || !std::isfinite(smoothingMs) ||
        smoothingMs < 0.0f || smoothingMs > 10000.0f) {
        return false;
    }
    const double tangent = std::tan(kPi * static_cast<double>(frequencyHz) / sampleRate_);
    targetCoefficient_ = static_cast<float>((tangent - 1.0) / (tangent + 1.0));
    const auto rampSamples = static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(smoothingMs) * 0.001 * sampleRate_));
    if (rampSamples == 0) {
        coefficient_ = targetCoefficient_;
        coefficientStep_ = 0.0f;
        coefficientRampRemaining_ = 0;
    } else {
        coefficientStep_ = (targetCoefficient_ - coefficient_) / static_cast<float>(rampSamples);
        coefficientRampRemaining_ = rampSamples;
    }
    return std::isfinite(targetCoefficient_);
}

float AllPass1::processSample(float input) noexcept {
    if (coefficientRampRemaining_ > 0) {
        coefficient_ += coefficientStep_;
        if (--coefficientRampRemaining_ == 0) {
            coefficient_ = targetCoefficient_;
        }
    }
    const float x = sanitize(input);
    const float y = sanitize(coefficient_ * x + x1_ - coefficient_ * y1_);
    x1_ = flushState(x);
    y1_ = flushState(y);
    return y;
}

bool AllPass1::processBlock(const float* input, float* output, std::uint32_t frames) noexcept {
    if (!prepared_ || !input || !output || frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        output[i] = processSample(input[i]);
    }
    return true;
}

bool LagrangeDelay::prepare(const ProcessSpec& spec, std::uint32_t maxDelaySamples) {
    if (!validProcessSpec(spec) || maxDelaySamples < 3 ||
        maxDelaySamples > 10U * 60U * 384000U) {
        return false;
    }
    maxBlockFrames_ = spec.maxBlockFrames;
    maxDelaySamples_ = maxDelaySamples;
    buffer_.assign(static_cast<std::size_t>(maxDelaySamples) + 4U, 0.0f);
    reset();
    return true;
}

void LagrangeDelay::reset() noexcept {
    std::fill(buffer_.begin(), buffer_.end(), 0.0f);
    writePosition_ = 0;
}

std::size_t LagrangeDelay::wrapIndex(std::int64_t index) const noexcept {
    return wrapped(index, buffer_.size());
}

float LagrangeDelay::read(std::int64_t index) const noexcept {
    return buffer_[wrapIndex(index)];
}

float LagrangeDelay::processSample(float input, float delaySamples) noexcept {
    if (buffer_.empty()) {
        return sanitize(input);
    }
    const float x = sanitize(input);
    buffer_[writePosition_] = x;
    const auto delay = std::clamp(sanitize(delaySamples), minimumDelaySamples(),
                                  static_cast<float>(maxDelaySamples_));
    const double readPosition = static_cast<double>(writePosition_) - delay;
    const auto base = static_cast<std::int64_t>(std::floor(readPosition));
    const double mu = readPosition - static_cast<double>(base);
    const double h0 = -mu * (mu - 1.0) * (mu - 2.0) / 6.0;
    const double h1 = (mu + 1.0) * (mu - 1.0) * (mu - 2.0) / 2.0;
    const double h2 = -(mu + 1.0) * mu * (mu - 2.0) / 2.0;
    const double h3 = (mu + 1.0) * mu * (mu - 1.0) / 6.0;
    const double output = h0 * read(base - 1) + h1 * read(base) +
                          h2 * read(base + 1) + h3 * read(base + 2);
    writePosition_ = (writePosition_ + 1U) % buffer_.size();
    return sanitize(static_cast<float>(output));
}

bool LagrangeDelay::processBlock(const float* input, float* output, const float* delaySamples,
                                 std::uint32_t frames) noexcept {
    if (buffer_.empty() || !input || !output || !delaySamples || frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        output[i] = processSample(input[i], delaySamples[i]);
    }
    return true;
}

float sinc8Read(const float* input, std::size_t frames, double position,
                BoundaryMode boundary) noexcept {
    constexpr auto maxSafeFrames = static_cast<std::size_t>(
        std::numeric_limits<std::int64_t>::max() - 4);
    if (!input || frames == 0 || frames > maxSafeFrames || !finite(position)) {
        return 0.0f;
    }
    if (boundary == BoundaryMode::Zero &&
        (position < -4.0 || position > static_cast<double>(frames) + 3.0)) {
        return 0.0f;
    }
    if (boundary == BoundaryMode::Wrap) {
        position = std::fmod(position, static_cast<double>(frames));
        if (position < 0.0) {
            position += static_cast<double>(frames);
        }
    } else if (boundary == BoundaryMode::Clamp) {
        position = std::clamp(position, 0.0, static_cast<double>(frames - 1U));
    }

    const auto center = static_cast<std::int64_t>(std::floor(position));
    double sum = 0.0;
    double weightSum = 0.0;
    for (std::int64_t tap = -3; tap <= 4; ++tap) {
        const auto index = center + tap;
        const double distance = position - static_cast<double>(index);
        const double absoluteDistance = std::fabs(distance);
        if (absoluteDistance >= 4.0) {
            continue;
        }
        const double sinc = absoluteDistance < 1.0e-12
                                ? 1.0
                                : std::sin(kPi * distance) / (kPi * distance);
        const double window = 0.5 + 0.5 * std::cos(kPi * distance / 4.0);
        const double weight = sinc * window;
        double sample = 0.0;
        if (boundary == BoundaryMode::Wrap) {
            sample = input[wrapped(index, frames)];
        } else if (index >= 0 && static_cast<std::size_t>(index) < frames) {
            sample = input[static_cast<std::size_t>(index)];
        } else if (boundary == BoundaryMode::Clamp) {
            sample = input[index < 0 ? 0U : frames - 1U];
        }
        sum += weight * sanitize(static_cast<float>(sample));
        weightSum += weight;
    }
    if (std::fabs(weightSum) < 1.0e-12) {
        return 0.0f;
    }
    return sanitize(static_cast<float>(sum / weightSum));
}

bool Lfo::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) {
        return false;
    }
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    sinStep_ = 0.0;
    cosStep_ = 1.0;
    reset();
    return true;
}

void Lfo::reset(float phaseCycles) noexcept {
    if (!std::isfinite(phaseCycles)) {
        phaseCycles = 0.0f;
    }
    phase_ = std::fmod(static_cast<double>(phaseCycles), 1.0);
    if (phase_ < 0.0) {
        phase_ += 1.0;
    }
    const double angle = 2.0 * kPi * phase_;
    sine_ = std::sin(angle);
    cosine_ = std::cos(angle);
    samplesSinceNormalize_ = 0;
}

bool Lfo::setFrequency(float frequencyHz) noexcept {
    if (!std::isfinite(frequencyHz) || frequencyHz < 0.0f ||
        frequencyHz > sampleRate_ * 0.45) {
        return false;
    }
    const double angle = 2.0 * kPi * static_cast<double>(frequencyHz) / sampleRate_;
    sinStep_ = std::sin(angle);
    cosStep_ = std::cos(angle);
    return true;
}

float Lfo::next() noexcept {
    const auto output = sanitize(static_cast<float>(sine_));
    const double nextSine = sine_ * cosStep_ + cosine_ * sinStep_;
    const double nextCosine = cosine_ * cosStep_ - sine_ * sinStep_;
    sine_ = nextSine;
    cosine_ = nextCosine;
    if (++samplesSinceNormalize_ >= 256U) {
        const double magnitude = std::sqrt(sine_ * sine_ + cosine_ * cosine_);
        if (magnitude > 1.0e-12) {
            sine_ /= magnitude;
            cosine_ /= magnitude;
        } else {
            sine_ = 0.0;
            cosine_ = 1.0;
        }
        samplesSinceNormalize_ = 0;
    }
    return output;
}

bool Lfo::processBlock(float* output, std::uint32_t frames) noexcept {
    if (!output || frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        output[i] = next();
    }
    return true;
}

bool PolyBlepOscillator::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) {
        return false;
    }
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    increment_ = 0.0;
    sinStep_ = 0.0;
    cosStep_ = 1.0;
    reset();
    return true;
}

void PolyBlepOscillator::reset(float phaseCycles) noexcept {
    if (!std::isfinite(phaseCycles)) {
        phaseCycles = 0.0f;
    }
    phase_ = std::fmod(static_cast<double>(phaseCycles), 1.0);
    if (phase_ < 0.0) {
        phase_ += 1.0;
    }
    const double angle = 2.0 * kPi * phase_;
    sine_ = std::sin(angle);
    cosine_ = std::cos(angle);
    samplesSinceNormalize_ = 0;
}

bool PolyBlepOscillator::setFrequency(float frequencyHz) noexcept {
    if (!std::isfinite(frequencyHz) || frequencyHz < 0.0f ||
        frequencyHz > sampleRate_ * 0.45) {
        return false;
    }
    increment_ = static_cast<double>(frequencyHz) / sampleRate_;
    const double angle = 2.0 * kPi * increment_;
    sinStep_ = std::sin(angle);
    cosStep_ = std::cos(angle);
    return true;
}

void PolyBlepOscillator::setWaveform(OscillatorWaveform waveform) noexcept {
    waveform_ = waveform;
}

float PolyBlepOscillator::polyBlep(double phase, double increment) noexcept {
    if (increment <= 0.0) {
        return 0.0f;
    }
    if (phase < increment) {
        const double t = phase / increment;
        return static_cast<float>(t + t - t * t - 1.0);
    }
    if (phase > 1.0 - increment) {
        const double t = (phase - 1.0) / increment;
        return static_cast<float>(t * t + t + t + 1.0);
    }
    return 0.0f;
}

double PolyBlepOscillator::integratedPolyBlep(double phase, double increment) noexcept {
    if (increment <= 0.0) return 0.0;
    if (phase < increment) {
        const double u = phase / increment;
        return increment * (u * u - (u * u * u) / 3.0 - u + 1.0 / 3.0);
    }
    if (phase > 1.0 - increment) {
        const double v = (phase - 1.0) / increment;
        return increment * (v * v * v / 3.0 + v * v + v + 1.0 / 3.0);
    }
    return 0.0;
}

float PolyBlepOscillator::next() noexcept {
    float output = 0.0f;
    switch (waveform_) {
    case OscillatorWaveform::Saw:
        output = static_cast<float>(2.0 * phase_ - 1.0) - polyBlep(phase_, increment_);
        break;
    case OscillatorWaveform::Square: {
        output = phase_ < 0.5 ? 1.0f : -1.0f;
        output += polyBlep(phase_, increment_);
        auto opposite = phase_ + 0.5;
        if (opposite >= 1.0) {
            opposite -= 1.0;
        }
        output -= polyBlep(opposite, increment_);
        break;
    }
    case OscillatorWaveform::Triangle: {
        const double opposite = phase_ < 0.5 ? phase_ + 0.5 : phase_ - 0.5;
        const double naive = phase_ < 0.5 ? -1.0 + 4.0 * phase_ : 3.0 - 4.0 * phase_;
        const double bandLimited = naive + 4.0 *
            (integratedPolyBlep(phase_, increment_) - integratedPolyBlep(opposite, increment_));
        output = static_cast<float>(bandLimited);
        break;
    }
    case OscillatorWaveform::Sine:
    default:
        output = static_cast<float>(sine_);
        break;
    }

    phase_ += increment_;
    if (phase_ >= 1.0) {
        phase_ -= 1.0;
    }
    const double nextSine = sine_ * cosStep_ + cosine_ * sinStep_;
    const double nextCosine = cosine_ * cosStep_ - sine_ * sinStep_;
    sine_ = nextSine;
    cosine_ = nextCosine;
    if (++samplesSinceNormalize_ >= 256U) {
        const double magnitude = std::sqrt(sine_ * sine_ + cosine_ * cosine_);
        if (magnitude > 1.0e-12) {
            sine_ /= magnitude;
            cosine_ /= magnitude;
        } else {
            sine_ = 0.0;
            cosine_ = 1.0;
        }
        samplesSinceNormalize_ = 0;
    }
    return sanitize(output);
}

bool PolyBlepOscillator::processBlock(float* output, std::uint32_t frames) noexcept {
    if (!output || frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        output[i] = next();
    }
    return true;
}

bool AdaaCubicShaper::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) {
        return false;
    }
    maxBlockFrames_ = spec.maxBlockFrames;
    prepared_ = true;
    reset();
    return true;
}

void AdaaCubicShaper::reset() noexcept {
    previousInput_ = 0.0f;
}

bool AdaaCubicShaper::setDrive(float drive) noexcept {
    if (!std::isfinite(drive) || drive < 0.1f || drive > 24.0f) {
        return false;
    }
    drive_ = static_cast<double>(drive);
    return true;
}

double AdaaCubicShaper::shape(double x) noexcept {
    if (!std::isfinite(x)) {
        return std::signbit(x) ? -1.0 : 1.0;
    }
    if (x >= 1.0f) {
        return 1.0f;
    }
    if (x <= -1.0f) {
        return -1.0f;
    }
    return 1.5 * x - 0.5 * x * x * x;
}

double AdaaCubicShaper::antiderivative(double x) noexcept {
    if (!std::isfinite(x)) {
        return std::numeric_limits<double>::max();
    }
    if (x >= 1.0f) {
        return std::fabs(x) - 0.375;
    }
    if (x <= -1.0f) {
        return std::fabs(x) - 0.375;
    }
    const double x2 = x * x;
    return 0.75 * x2 - 0.125 * x2 * x2;
}

float AdaaCubicShaper::processSample(float input) noexcept {
    const double x = static_cast<double>(sanitize(input)) * drive_;
    const double difference = x - previousInput_;
    double output = 0.0;
    if (std::fabs(difference) > 1.0e-8) {
        output = (antiderivative(x) - antiderivative(previousInput_)) / difference;
    } else {
        output = shape(0.5 * (x + previousInput_));
    }
    previousInput_ = flushState(x);
    return sanitize(finiteFloat(output));
}

bool AdaaCubicShaper::processBlock(const float* input, float* output,
                                   std::uint32_t frames) noexcept {
    if (!prepared_ || !input || !output || frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        output[i] = processSample(input[i]);
    }
    return true;
}

bool DualDetectorCompressor::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) {
        return false;
    }
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    prepared_ = true;
    attackCoefficient_ = timeCoefficient(attackMs_, static_cast<float>(sampleRate_));
    releaseCoefficient_ = timeCoefficient(releaseMs_, static_cast<float>(sampleRate_));
    reset();
    return true;
}

void DualDetectorCompressor::reset() noexcept {
    peakEnvelope_ = 0.0;
    rmsEnvelopeSquared_ = 0.0;
}

float DualDetectorCompressor::timeCoefficient(float timeMs, float sampleRate) noexcept {
    const double seconds = std::max(static_cast<double>(timeMs), 0.1) * 0.001;
    return static_cast<float>(std::exp(-1.0 / (seconds * sampleRate)));
}

bool DualDetectorCompressor::setParameters(float thresholdDb, float ratio, float kneeDb,
                                           float attackMs, float releaseMs, float rmsMix,
                                           float makeupDb) noexcept {
    if (!prepared_ || !std::isfinite(thresholdDb) || thresholdDb < -60.0f ||
        thresholdDb > 0.0f || !std::isfinite(ratio) || ratio < 1.0f || ratio > 40.0f ||
        !std::isfinite(kneeDb) || kneeDb < 0.0f || kneeDb > 24.0f ||
        !std::isfinite(attackMs) || attackMs < 0.1f || attackMs > 2000.0f ||
        !std::isfinite(releaseMs) || releaseMs < 1.0f || releaseMs > 10000.0f ||
        !std::isfinite(rmsMix) || rmsMix < 0.0f || rmsMix > 1.0f ||
        !std::isfinite(makeupDb) || makeupDb < -24.0f || makeupDb > 24.0f) {
        return false;
    }
    thresholdDb_ = thresholdDb;
    ratio_ = ratio;
    kneeDb_ = kneeDb;
    attackMs_ = attackMs;
    releaseMs_ = releaseMs;
    rmsMix_ = rmsMix;
    makeupDb_ = makeupDb;
    attackCoefficient_ = timeCoefficient(attackMs_, static_cast<float>(sampleRate_));
    releaseCoefficient_ = timeCoefficient(releaseMs_, static_cast<float>(sampleRate_));
    return true;
}

float DualDetectorCompressor::gainForLevel(float level) noexcept {
    constexpr float epsilon = 1.0e-12f;
    const float levelDb = 20.0f * std::log10(std::max(level, epsilon));
    const float over = levelDb - thresholdDb_;
    float gainDb = 0.0f;
    const float halfKnee = kneeDb_ * 0.5f;
    if (kneeDb_ <= 0.0f) {
        gainDb = over > 0.0f ? thresholdDb_ + over / ratio_ - levelDb : 0.0f;
    } else if (over <= -halfKnee) {
        gainDb = 0.0f;
    } else if (over >= halfKnee) {
        gainDb = thresholdDb_ + over / ratio_ - levelDb;
    } else {
        const float position = over + halfKnee;
        gainDb = (1.0f / ratio_ - 1.0f) * position * position / (2.0f * kneeDb_);
    }
    return sanitize(std::pow(10.0f, (gainDb + makeupDb_) / 20.0f));
}

StereoFrame DualDetectorCompressor::processSample(float left, float right) noexcept {
    const float l = sanitize(left);
    const float r = sanitize(right);
    // Keep corrupt/out-of-range float samples from poisoning detector recovery
    // for many seconds while leaving the audio path itself unclipped here.
    constexpr double detectorCeiling = 32.0;
    const double peak = std::min(detectorCeiling,
                                 std::max(std::fabs(static_cast<double>(l)),
                                          std::fabs(static_cast<double>(r))));
    const double peakCoefficient = peak > peakEnvelope_ ? attackCoefficient_ : releaseCoefficient_;
    peakEnvelope_ = flushState(peakCoefficient * peakEnvelope_ +
                               (1.0 - peakCoefficient) * peak);
    const double power = std::min(detectorCeiling * detectorCeiling,
                                  0.5 * (static_cast<double>(l) * l +
                                         static_cast<double>(r) * r));
    const double rmsCoefficient = power > rmsEnvelopeSquared_ ? attackCoefficient_ : releaseCoefficient_;
    rmsEnvelopeSquared_ = flushState(rmsCoefficient * rmsEnvelopeSquared_ +
                                     (1.0 - rmsCoefficient) * power);
    const double rms = std::sqrt(std::max(rmsEnvelopeSquared_, 0.0));
    const double detector = (1.0 - rmsMix_) * peakEnvelope_ + rmsMix_ * rms;
    const float gain = gainForLevel(finiteFloat(detector));
    return {sanitize(finiteFloat(static_cast<double>(l) * gain)),
            sanitize(finiteFloat(static_cast<double>(r) * gain))};
}

bool DualDetectorCompressor::processBlock(const float* inputLeft, const float* inputRight,
                                          float* outputLeft, float* outputRight,
                                          std::uint32_t frames) noexcept {
    if (!prepared_ || !inputLeft || !inputRight || !outputLeft || !outputRight ||
        frames > maxBlockFrames_) {
        return false;
    }
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto output = processSample(inputLeft[i], inputRight[i]);
        outputLeft[i] = output.left;
        outputRight[i] = output.right;
    }
    return true;
}

void DelayMatrix2::reset() noexcept {
    sameChannel_ = 0.0f;
    crossChannel_ = 0.0f;
}

bool DelayMatrix2::setFeedback(float sameChannel, float crossChannel) noexcept {
    if (!std::isfinite(sameChannel) || !std::isfinite(crossChannel)) {
        return false;
    }
    const float eigenvalueA = std::fabs(sameChannel + crossChannel);
    const float eigenvalueB = std::fabs(sameChannel - crossChannel);
    const float spectralRadius = std::max(eigenvalueA, eigenvalueB);
    if (spectralRadius >= 0.999f) {
        const float scale = 0.998f / spectralRadius;
        sameChannel *= scale;
        crossChannel *= scale;
    }
    sameChannel_ = sameChannel;
    crossChannel_ = crossChannel;
    return true;
}

StereoFrame DelayMatrix2::process(StereoFrame input, StereoFrame delayed) const noexcept {
    const auto left = sanitize(input.left) + sameChannel_ * sanitize(delayed.left) +
                      crossChannel_ * sanitize(delayed.right);
    const auto right = sanitize(input.right) + crossChannel_ * sanitize(delayed.left) +
                       sameChannel_ * sanitize(delayed.right);
    return {sanitize(left), sanitize(right)};
}

void Pcg32::seed(std::uint64_t initialState, std::uint64_t sequence) noexcept {
    state_ = 0U;
    increment_ = (sequence << 1U) | 1U;
    (void)nextU32();
    state_ += initialState;
    (void)nextU32();
}

std::uint32_t Pcg32::nextU32() noexcept {
    const auto oldState = state_;
    state_ = oldState * 6364136223846793005ULL + increment_;
    const auto shifted = static_cast<std::uint32_t>(((oldState >> 18U) ^ oldState) >> 27U);
    const auto rotation = static_cast<std::uint32_t>(oldState >> 59U);
    return (shifted >> rotation) | (shifted << ((0U - rotation) & 31U));
}

float Pcg32::nextBipolar() noexcept {
    const auto value = nextU32() >> 8U;
    return static_cast<float>(value) * (2.0f / 16777215.0f) - 1.0f;
}

} // namespace webrc::dsp
