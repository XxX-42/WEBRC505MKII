#include "dsp_primitives.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

using namespace webrc::native::dsp;

namespace {

void expectNear(double actual, double expected, double tolerance = 1.0e-4) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

void testParameterSmoother() {
    ParameterSmoother smoother(0.0f);
    smoother.setTarget(1.0f, 4);
    expectNear(smoother.next(), 0.25);
    expectNear(smoother.next(), 0.5);
    expectNear(smoother.current(), 0.5);
    smoother.skip(1);
    expectNear(smoother.current(), 0.75);
    assert(smoother.isSmoothing());
    expectNear(smoother.next(), 1.0);
    assert(!smoother.isSmoothing());

    smoother.reset(0.0f);
    smoother.setTarget(-1.0f, 10);
    smoother.setTarget(1.0f, 2);
    expectNear(smoother.next(), 0.5);
    expectNear(smoother.next(), 1.0);
    smoother.setTarget(0.5f, 0);
    expectNear(smoother.current(), 0.5);
    smoother.setTarget(std::numeric_limits<float>::quiet_NaN(), 5);
    expectNear(smoother.target(), 0.0);
}

void testParameterSmootherPerSampleIsBitExactToPreviousContract() {
    struct ReferenceSmoother {
        float current = 0.0f;
        float target = 0.0f;
        double step = 0.0;
        std::uint64_t remaining = 0U;

        void reset(float value) {
            current = std::isfinite(value) ? value : 0.0f;
            target = current;
            step = 0.0;
            remaining = 0U;
        }

        void setTarget(float value, std::uint64_t rampFrames) {
            const float finiteTarget = std::isfinite(value) ? value : 0.0f;
            if (rampFrames == 0U || finiteTarget == current) {
                reset(finiteTarget);
                return;
            }
            target = finiteTarget;
            remaining = rampFrames;
            step = (static_cast<double>(target) - static_cast<double>(current)) /
                   static_cast<double>(remaining);
        }

        float next() {
            if (remaining != 0U) {
                current = static_cast<float>(static_cast<double>(current) + step);
                --remaining;
                if (remaining == 0U) {
                    current = target;
                    step = 0.0;
                }
            }
            return current;
        }

        void skip(std::uint64_t frames) {
            if (frames == 0U || remaining == 0U) return;
            if (frames >= remaining) {
                current = target;
                step = 0.0;
                remaining = 0U;
                return;
            }
            current = static_cast<float>(static_cast<double>(current) + step * static_cast<double>(frames));
            remaining -= frames;
        }
    } reference;

    constexpr float targets[] = {
        0.33333334f, -0.875f, 0.0f, 1.0e-20f, -1.0e-30f,
        std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN(), 0.99999994f,
    };
    constexpr std::uint64_t ramps[] = {0U, 1U, 2U, 3U, 5U, 17U, 64U, 127U, 1024U, 4097U};
    ParameterSmoother candidate(-0.125f);
    reference.reset(-0.125f);

    for (std::uint64_t frame = 0U; frame < 50000U; ++frame) {
        if (frame % 997U == 0U) {
            const float value = targets[(frame / 997U) % (sizeof(targets) / sizeof(targets[0]))];
            candidate.reset(value);
            reference.reset(value);
        }
        if (frame % 113U == 0U) {
            const auto event = frame / 113U;
            const float value = targets[event % (sizeof(targets) / sizeof(targets[0]))];
            const auto ramp = ramps[event % (sizeof(ramps) / sizeof(ramps[0]))];
            candidate.setTarget(value, ramp);
            reference.setTarget(value, ramp);
        }
        if (frame % 431U == 0U) {
            const std::uint64_t skipFrames = (frame / 431U) % 3U == 0U ? 0U : ((frame / 431U) % 17U);
            candidate.skip(skipFrames);
            reference.skip(skipFrames);
        }

        const float actual = candidate.next();
        const float expected = reference.next();
        const float actualCurrent = candidate.current();
        const float actualTarget = candidate.target();
        assert(std::memcmp(&actual, &expected, sizeof(actual)) == 0);
        assert(std::memcmp(&actualCurrent, &reference.current, sizeof(float)) == 0);
        assert(std::memcmp(&actualTarget, &reference.target, sizeof(float)) == 0);
        assert(candidate.remainingFrames() == reference.remaining);
        assert(candidate.isSmoothing() == (reference.remaining != 0U));
    }
}

void testEqualPowerCrossfade() {
    const auto start = equalPowerCrossfadeGains(-1.0f);
    const auto middle = equalPowerCrossfadeGains(0.5f);
    const auto end = equalPowerCrossfadeGains(2.0f);
    expectNear(start.first, 1.0);
    expectNear(start.second, 0.0);
    expectNear(middle.first * middle.first + middle.second * middle.second, 1.0);
    expectNear(middle.first, std::sqrt(0.5));
    expectNear(middle.second, std::sqrt(0.5));
    expectNear(end.first, 0.0);
    expectNear(end.second, 1.0);
    expectNear(equalPowerCrossfade(1.0f, 0.0f, 0.0f), 1.0);
    expectNear(equalPowerCrossfade(0.0f, 1.0f, 1.0f), 1.0);
}

void testBiquad() {
    Biquad lowPass;
    assert(lowPass.setParameters(BiquadType::LowPass, 48000.0, 1000.0, 0.70710678));
    lowPass.reset();
    float lowPassOutput = 0.0f;
    for (int i = 0; i < 4096; ++i) {
        lowPassOutput = lowPass.process(1.0f);
        assert(std::isfinite(lowPassOutput));
    }
    expectNear(lowPassOutput, 1.0, 1.0e-3);

    Biquad highPass;
    assert(highPass.setParameters(BiquadType::HighPass, 48000.0, 1000.0, 0.70710678));
    float highPassOutput = 1.0f;
    for (int i = 0; i < 4096; ++i) {
        highPassOutput = highPass.process(1.0f);
        assert(std::isfinite(highPassOutput));
    }
    expectNear(highPassOutput, 0.0, 1.0e-4);

    const auto beforeInvalidUpdate = lowPass.coefficients();
    assert(!lowPass.setParameters(BiquadType::LowPass, 48000.0, 24000.0));
    expectNear(lowPass.coefficients().b0, beforeInvalidUpdate.b0, 0.0);
    BiquadCoefficients invalidCoefficients{};
    invalidCoefficients.b0 = std::numeric_limits<double>::quiet_NaN();
    assert(!lowPass.setCoefficients(invalidCoefficients));
    expectNear(lowPass.coefficients().b0, beforeInvalidUpdate.b0, 0.0);

    const BiquadType types[] = {
        BiquadType::LowPass,
        BiquadType::HighPass,
        BiquadType::BandPass,
        BiquadType::Notch,
        BiquadType::Peaking,
        BiquadType::LowShelf,
        BiquadType::HighShelf,
    };
    for (const auto type : types) {
        Biquad filter;
        assert(filter.setParameters(type, 44100.0, 1200.0, 0.8, 6.0));
        filter.reset();
        for (int i = 0; i < 1024; ++i) {
            assert(std::isfinite(filter.process(i == 0 ? 1.0f : 0.0f)));
        }
    }
}

void testTptStateVariableFilter() {
    TptStateVariableFilter filter;
    assert(filter.setParameters(48000.0, 1200.0, 0.70710678));
    SvfOutput output{};
    for (int i = 0; i < 8192; ++i) {
        output = filter.process(1.0f);
        assert(std::isfinite(output.lowPass));
        assert(std::isfinite(output.bandPass));
        assert(std::isfinite(output.highPass));
        assert(std::isfinite(output.notch));
    }
    expectNear(output.lowPass, 1.0, 1.0e-3);
    expectNear(output.bandPass, 0.0, 1.0e-3);
    expectNear(output.highPass, 0.0, 1.0e-3);
    expectNear(output.notch, 1.0, 1.0e-3);
    assert(!filter.setParameters(48000.0, 24000.0, 0.7));
}

void testLagrangeDelay() {
    // A cubic polynomial is reproduced exactly by four-point Lagrange
    // interpolation over the interval [0, 1].
    const float mu = 0.37f;
    const float value = lagrange4(-1.0f, 0.0f, 1.0f, 8.0f, mu);
    expectNear(value, static_cast<double>(mu * mu * mu), 2.0e-6);

    LagrangeDelayLine<16> delay;
    delay.reset();
    float output = 0.0f;
    for (int i = 0; i < 12; ++i) {
        output = delay.process(static_cast<float>(i), 1.5f);
        if (i >= 3) {
            expectNear(output, static_cast<double>(i) - 1.5, 1.0e-5);
        }
    }

    delay.reset(2.0f);
    expectNear(delay.process(2.0f, 100.0f), 2.0);
    expectNear(delay.process(2.0f, std::numeric_limits<float>::quiet_NaN()), 2.0);
}

void testLagrange4IsBitExactToPreviousContract() {
    const auto reference = [](float xMinus1, float x0, float xPlus1, float xPlus2, float fraction) {
        const float finiteFraction = std::isfinite(fraction) ? fraction : 0.0f;
        const double mu = std::clamp(static_cast<double>(finiteFraction), 0.0, 1.0);
        const double weightMinus1 = -(mu * (mu - 1.0) * (mu - 2.0)) / 6.0;
        const double weight0 = ((mu + 1.0) * (mu - 1.0) * (mu - 2.0)) / 2.0;
        const double weightPlus1 = -((mu + 1.0) * mu * (mu - 2.0)) / 2.0;
        const double weightPlus2 = ((mu + 1.0) * mu * (mu - 1.0)) / 6.0;
        return static_cast<float>(weightMinus1 * xMinus1 + weight0 * x0 + weightPlus1 * xPlus1 + weightPlus2 * xPlus2);
    };
    const std::array<float, 11U> samples{{
        0.0f,
        -0.0f,
        0.125f,
        -0.25f,
        1.0f,
        -1.0f,
        0.99999994f,
        1.0e-30f,
        -1.0e30f,
        std::numeric_limits<float>::max(),
        std::numeric_limits<float>::lowest(),
    }};
    const std::array<float, 12U> fractions{{
        -std::numeric_limits<float>::infinity(), -2.0f, -1.0f, -0.0f, 0.0f, 0.125f,
        0.25f, 0.5f, 0.875f, 1.0f, 2.0f, std::numeric_limits<float>::quiet_NaN(),
    }};

    for (const float xMinus1 : samples) {
        for (const float x0 : samples) {
            for (const float xPlus1 : samples) {
                for (const float xPlus2 : samples) {
                    for (const float fraction : fractions) {
                        const float actual = lagrange4(xMinus1, x0, xPlus1, xPlus2, fraction);
                        const float expected = reference(xMinus1, x0, xPlus1, xPlus2, fraction);
                        assert(std::memcmp(&actual, &expected, sizeof(actual)) == 0);
                    }
                }
            }
        }
    }
}

void testDeterministicRng() {
    DeterministicRng golden(0);
    assert(golden.nextUInt32() == 0xe220a839U);
    assert(golden.nextUInt32() == 0x6e789e6aU);

    DeterministicRng first(123456789ULL);
    DeterministicRng second(123456789ULL);
    for (int i = 0; i < 1024; ++i) {
        assert(first.nextUInt32() == second.nextUInt32());
    }

    DeterministicRng floats(987654321ULL);
    for (int i = 0; i < 4096; ++i) {
        const float unit = floats.nextUnitFloat();
        const float bipolar = floats.nextBipolarFloat();
        assert(unit >= 0.0f && unit < 1.0f);
        assert(bipolar >= -1.0f && bipolar < 1.0f);
    }
}

void testAbsoluteBeatClock() {
    AbsoluteBeatClock clock;
    assert(clock.configure(48000, 120.0, 123));
    assert(clock.frameForBeat(0) == 123);
    assert(clock.frameForBeat(1) == 24123);
    assert(clock.frameForBeat(10) == 240123);
    assert(clock.beatAtFrame(24122) == 0);
    assert(clock.beatAtFrame(24123) == 1);
    assert(clock.beatAtFrame(72123) == 3);
    assert(!clock.configure(0, 120.0));

    AbsoluteBeatClock fractionalTempo;
    assert(fractionalTempo.configure(44100, 123.0));
    const auto beat10000 = fractionalTempo.frameForBeat(10000);
    const auto beat10001 = fractionalTempo.frameForBeat(10001);
    assert(beat10001 > beat10000);
    assert(beat10000 == static_cast<std::uint64_t>(std::floor(10000.0 * 44100.0 * 60.0 / 123.0 + 0.5)));
}

} // namespace

int main() {
    testParameterSmoother();
    testParameterSmootherPerSampleIsBitExactToPreviousContract();
    testEqualPowerCrossfade();
    testBiquad();
    testTptStateVariableFilter();
    testLagrangeDelay();
    testLagrange4IsBitExactToPreviousContract();
    testDeterministicRng();
    testAbsoluteBeatClock();
    return 0;
}
