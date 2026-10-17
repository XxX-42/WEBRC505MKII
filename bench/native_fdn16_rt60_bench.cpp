#include "native_fdn16_reverb_processor.hpp"

#include <array>
#include <cmath>
#include <cstddef>
#include <iostream>
#include <vector>

#if defined(_MSC_VER)
#define RC505_COMPILER_VERSION "MSVC"
#elif defined(__clang__)
#define RC505_COMPILER_VERSION __clang_version__
#elif defined(__GNUC__)
#define RC505_COMPILER_VERSION __VERSION__
#else
#define RC505_COMPILER_VERSION "unknown"
#endif

namespace {

struct Measurement {
    unsigned int frames = 0U;
    std::size_t fitPoints = 0U;
    double slopeDbPerSecond = 0.0;
    double measuredRt60Seconds = 0.0;
    float peak = 0.0f;
};

bool measure(float targetRt60Seconds, Measurement& measurement) {
    constexpr unsigned int sampleRate = 48000U;
    const auto frames = static_cast<unsigned int>(std::ceil(targetRt60Seconds * 2.5f * sampleRate));

    webrc::native::NativeFdn16ReverbProcessor reverb;
    webrc::native::NativeFdn16ReverbConfig config{};
    config.enabled = true;
    config.wetMix = 1.0f;
    config.rt60Seconds = targetRt60Seconds;
    config.dampingCutoffHz = 20000.0f;
    if (!reverb.setConfig(config, 0U) || !reverb.prepare(sampleRate)) return false;

    std::vector<float> impulse(static_cast<std::size_t>(frames) * 2U, 0.0f);
    impulse[0] = 1.0f;
    measurement.peak = reverb.processInPlace(impulse.data(), frames, 2U);
    measurement.frames = frames;

    std::vector<double> decayEnergy(static_cast<std::size_t>(frames) + 1U, 0.0);
    for (unsigned int frame = frames; frame-- > 0U;) {
        const double left = impulse[static_cast<std::size_t>(frame) * 2U];
        const double right = impulse[static_cast<std::size_t>(frame) * 2U + 1U];
        decayEnergy[frame] = decayEnergy[frame + 1U] + left * left + right * right;
    }
    const double reference = decayEnergy.front();
    if (!(reference > 0.0) || !std::isfinite(reference)) return false;

    // Fit the -5 to -35 dB region of the Schroeder backward-integrated energy
    // decay, then extrapolate the line slope to -60 dB.
    double sumTime = 0.0;
    double sumDb = 0.0;
    double sumTimeSquared = 0.0;
    double sumTimeDb = 0.0;
    for (unsigned int frame = 1U; frame < frames; ++frame) {
        const double db = 10.0 * std::log10(decayEnergy[frame] / reference);
        if (db <= -5.0 && db >= -35.0) {
            const double time = static_cast<double>(frame) / sampleRate;
            sumTime += time;
            sumDb += db;
            sumTimeSquared += time * time;
            sumTimeDb += time * db;
            ++measurement.fitPoints;
        }
    }
    const double count = static_cast<double>(measurement.fitPoints);
    const double denominator = count * sumTimeSquared - sumTime * sumTime;
    if (measurement.fitPoints < 100U || denominator <= 0.0) return false;
    measurement.slopeDbPerSecond = (count * sumTimeDb - sumTime * sumDb) / denominator;
    if (!(measurement.slopeDbPerSecond < 0.0) || !std::isfinite(measurement.slopeDbPerSecond)) return false;
    measurement.measuredRt60Seconds = -60.0 / measurement.slopeDbPerSecond;
    return std::isfinite(measurement.measuredRt60Seconds) && std::isfinite(measurement.peak);
}

} // namespace

int main() {
    constexpr std::array<float, 3U> targets{{0.5f, 2.0f, 4.0f}};
    constexpr unsigned int sampleRate = 48000U;
    std::cout << "{\n"
              << "  \"schema\": \"rc505-native-fdn16-rt60-v1\",\n"
              << "  \"environment\": {\n"
              << "    \"platform\": \""
#if defined(_WIN32)
              << "windows"
#elif defined(__APPLE__)
              << "macos"
#elif defined(__linux__)
              << "linux"
#else
              << "unknown"
#endif
              << "\",\n"
              << "    \"compiler\": \"" << RC505_COMPILER_VERSION << "\",\n"
              << "    \"cplusplus\": " << __cplusplus << ",\n"
              << "    \"sampleRateHz\": " << sampleRate << ",\n"
              << "    \"channels\": 2,\n"
              << "    \"dampingCutoffHz\": 20000,\n"
              << "    \"feedbackNetwork\": \"normalized Hadamard 16-line FDN\"\n"
              << "  },\n"
              << "  \"method\": \"unit impulse; backward-integrated stereo energy (Schroeder EDC); least-squares fit from -5 to -35 dB; extrapolate slope to -60 dB\",\n"
              << "  \"measurements\": [\n";

    bool accepted = true;
    for (std::size_t index = 0U; index < targets.size(); ++index) {
        Measurement measurement{};
        if (!measure(targets[index], measurement)) return 1;
        const double relativeError = std::fabs(measurement.measuredRt60Seconds - targets[index]) / targets[index];
        accepted = accepted && relativeError < 0.08;
        std::cout << "    {\"targetRt60Seconds\": " << targets[index]
                  << ", \"measuredRt60Seconds\": " << measurement.measuredRt60Seconds
                  << ", \"relativeError\": " << relativeError
                  << ", \"slopeDbPerSecond\": " << measurement.slopeDbPerSecond
                  << ", \"fitPoints\": " << measurement.fitPoints
                  << ", \"frames\": " << measurement.frames
                  << ", \"peak\": " << measurement.peak << "}"
                  << (index + 1U == targets.size() ? "\n" : ",\n");
    }

    std::cout << "  ],\n"
              << "  \"acceptance\": {\"maximumRelativeError\": 0.08, \"passed\": "
              << (accepted ? "true" : "false") << "},\n"
              << "  \"limitations\": [\"synthetic algorithm measurement only\", \"not perceptual listening or Roland hardware equivalence\", \"damping is set high to minimize its influence on base RT60 calibration\"]\n"
              << "}\n";
    return accepted ? 0 : 2;
}
