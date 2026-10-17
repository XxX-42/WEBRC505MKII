#include "dsp_primitives.hpp"

#include <chrono>
#include <cstdint>
#include <iostream>

using namespace webrc::native::dsp;

int main() {
    constexpr std::uint64_t iterations = 2'000'000;

    Biquad biquad;
    TptStateVariableFilter svf;
    LagrangeDelayLine<4096> delay;
    ParameterSmoother smoother(0.0f);
    DeterministicRng rng(42);
    (void)biquad.setParameters(BiquadType::LowPass, 48000.0, 4000.0, 0.70710678);
    (void)svf.setParameters(48000.0, 1800.0, 0.8);
    smoother.setTarget(1.0f, iterations);

    double sink = 0.0;
    const auto start = std::chrono::steady_clock::now();
    for (std::uint64_t i = 0; i < iterations; ++i) {
        const float noise = rng.nextBipolarFloat() * 0.05f;
        const float smoothed = smoother.next();
        const float filtered = biquad.process(noise);
        const SvfOutput outputs = svf.process(filtered);
        const float delayed = delay.process(outputs.lowPass, 512.375f);
        sink += equalPowerCrossfade(delayed, outputs.highPass, smoothed);
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - start
    ).count();

    const double samplesPerSecond = elapsed > 0
        ? static_cast<double>(iterations) * 1'000'000.0 / static_cast<double>(elapsed)
        : 0.0;
    std::cout << "DSP primitive chain: " << iterations << " frames in " << elapsed
              << " us (" << samplesPerSecond << " frames/s), sink=" << sink << '\n';
    return 0;
}
