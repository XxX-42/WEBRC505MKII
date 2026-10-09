#include "webrc/dsp/octave_fx.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <vector>

namespace {

using namespace webrc::dsp;
constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kWindowFrames = 2048U;
constexpr std::uint32_t kHopFrames = 256U;
constexpr std::uint32_t kCaptureWindowFrames = 4U * kWindowFrames;
constexpr double kPi = 3.141592653589793238462643383279502884;

struct Run {
    std::vector<StereoFrame> output;
    std::vector<StereoFrame> rawWet;
    bool ok = false;
};

Run* gCurrentCapture = nullptr;

struct Metrics {
    double rawPreBoundWetPeak = 0.0;
    double rawPreBoundWetEnergy = 0.0;
    double rawPreBoundDeltaPeak = 0.0;
    double rawPreBoundDeltaEnergy = 0.0;
    double outputPeak = 0.0;
    double outputEnergy = 0.0;
    double outputDeltaPeak = 0.0;
    double outputDeltaEnergy = 0.0;
    std::uint32_t rawWouldClipSamples = 0U;
    std::uint32_t outputAtBoundSamples = 0U;
    std::uint32_t nonFiniteSamples = 0U;
};

void check(bool condition, const char* message, std::uint32_t& failures) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}

} // namespace

// Supplied by a one-line-instrumented copy of octave_fx.cpp. This observes the
// exact overlap-add wet value immediately before the production clamp.
void octaveFxAuditCapture(std::uint64_t elapsedFrame, float left, float right) noexcept {
    if (gCurrentCapture == nullptr || elapsedFrame >= gCurrentCapture->rawWet.size()) return;
    gCurrentCapture->rawWet[static_cast<std::size_t>(elapsedFrame)] = {left, right};
}

namespace {

constexpr ProcessSpec makeSpec() noexcept {
    return {static_cast<float>(kSampleRate), 256U, 2U};
}

Run render(float semitones, bool warmed, bool addImpulse) {
    const std::uint32_t prelude = warmed ? 16U * kWindowFrames : kWindowFrames;
    const std::uint32_t totalFrames = prelude + 6U * kWindowFrames;
    Run run;
    run.output.assign(totalFrames, {});
    run.rawWet.assign(totalFrames, {});
    for (std::uint32_t frame = 0U; frame < prelude; ++frame) {
        if (!warmed) continue;
        const double time = static_cast<double>(frame) / kSampleRate;
        run.output[frame] = {
            0.5f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * time)),
            0.35f * static_cast<float>(std::sin(2.0 * kPi * 997.0 * time + 0.23))};
    }
    if (addImpulse) {
        run.output[prelude].left += 0.9f;
        run.output[prelude].right -= 0.65f;
    }

    OctaveFxProcessor processor;
    OctaveFxOptions options{};
    options.windowFrames = kWindowFrames;
    options.hopFrames = kHopFrames;
    options.controlSmoothingMs = 10.0f;
    if (!processor.prepare(makeSpec(), options)) return run;
    const std::array<OctaveFxEvent, 3U> events{{
        {0U, OctaveFxControl::Active, 1.0f},
        {0U, OctaveFxControl::Mix, 1.0f},
        {0U, OctaveFxControl::Semitones, semitones}}};
    gCurrentCapture = &run;
    for (std::uint32_t start = 0U; start < totalFrames; start += 128U) {
        if (!processor.processBlock(start, run.output.data() + start, 128U,
                start == 0U ? events.data() : nullptr, start == 0U ? 3U : 0U)) {
            gCurrentCapture = nullptr;
            return run;
        }
    }
    gCurrentCapture = nullptr;
    run.ok = true;
    return run;
}

Metrics measure(const Run& withImpulse, const Run& baseline, std::uint32_t prelude) {
    Metrics metrics{};
    const std::uint32_t end = std::min<std::uint32_t>(
        static_cast<std::uint32_t>(withImpulse.output.size()), prelude + kCaptureWindowFrames);
    for (std::uint32_t frame = prelude; frame < end; ++frame) {
        const auto& raw = withImpulse.rawWet[frame];
        const auto& rawBase = baseline.rawWet[frame];
        const auto& output = withImpulse.output[frame];
        const auto& outputBase = baseline.output[frame];
        const double rawAbsL = std::fabs(static_cast<double>(raw.left));
        const double rawAbsR = std::fabs(static_cast<double>(raw.right));
        const double rawDeltaL = static_cast<double>(raw.left) - rawBase.left;
        const double rawDeltaR = static_cast<double>(raw.right) - rawBase.right;
        const double outputAbsL = std::fabs(static_cast<double>(output.left));
        const double outputAbsR = std::fabs(static_cast<double>(output.right));
        const double outputDeltaL = static_cast<double>(output.left) - outputBase.left;
        const double outputDeltaR = static_cast<double>(output.right) - outputBase.right;
        metrics.rawPreBoundWetPeak = std::max({metrics.rawPreBoundWetPeak, rawAbsL, rawAbsR});
        metrics.rawPreBoundWetEnergy += raw.left * raw.left + raw.right * raw.right;
        metrics.rawPreBoundDeltaPeak = std::max({metrics.rawPreBoundDeltaPeak,
            std::fabs(rawDeltaL), std::fabs(rawDeltaR)});
        metrics.rawPreBoundDeltaEnergy += rawDeltaL * rawDeltaL + rawDeltaR * rawDeltaR;
        metrics.outputPeak = std::max({metrics.outputPeak, outputAbsL, outputAbsR});
        metrics.outputEnergy += output.left * output.left + output.right * output.right;
        metrics.outputDeltaPeak = std::max({metrics.outputDeltaPeak,
            std::fabs(outputDeltaL), std::fabs(outputDeltaR)});
        metrics.outputDeltaEnergy += outputDeltaL * outputDeltaL + outputDeltaR * outputDeltaR;
        if (rawAbsL >= 8.0 || rawAbsR >= 8.0) ++metrics.rawWouldClipSamples;
        if (outputAbsL >= 7.999999 || outputAbsR >= 7.999999)
            ++metrics.outputAtBoundSamples;
        if (!std::isfinite(raw.left) || !std::isfinite(raw.right) ||
            !std::isfinite(output.left) || !std::isfinite(output.right))
            ++metrics.nonFiniteSamples;
    }
    return metrics;
}

void printCase(float semitones, bool warmed, const Metrics& metrics) {
    std::printf("{\"semitones\":%.0f,\"condition\":\"%s\","
                "\"rawPreBoundWetPeak\":%.12g,\"rawPreBoundWetEnergy\":%.12g,"
                "\"rawPreBoundImpulseDeltaPeak\":%.12g,\"rawPreBoundImpulseDeltaEnergy\":%.12g,"
                "\"outputPeak\":%.12g,\"outputEnergy\":%.12g,"
                "\"outputImpulseDeltaPeak\":%.12g,\"outputImpulseDeltaEnergy\":%.12g,"
                "\"rawWouldClipSamples\":%u,\"outputAtBoundSamples\":%u,"
                "\"nonFiniteSamples\":%u}",
                semitones, warmed ? "fully_warmed_440_997Hz" : "cold_silence_startup",
                metrics.rawPreBoundWetPeak, metrics.rawPreBoundWetEnergy,
                metrics.rawPreBoundDeltaPeak, metrics.rawPreBoundDeltaEnergy,
                metrics.outputPeak, metrics.outputEnergy,
                metrics.outputDeltaPeak, metrics.outputDeltaEnergy,
                metrics.rawWouldClipSamples, metrics.outputAtBoundSamples,
                metrics.nonFiniteSamples);
}

} // namespace

int main() {
    std::uint32_t failures = 0U;
    std::printf("{\"schemaVersion\":1,\"suite\":\"octave-impulse-transient-audit\","
                "\"sampleRate\":%u,\"windowFrames\":%u,\"hopFrames\":%u,"
                "\"impulse\":[0.9,-0.65],\"captureWindowFrames\":%u,\"cases\":[\n",
                kSampleRate, kWindowFrames, kHopFrames, kCaptureWindowFrames);
    const std::array<float, 3U> semitones{{-12.0f, 0.0f, 12.0f}};
    bool firstCase = true;
    for (const float pitch : semitones) {
        for (const bool warmed : {false, true}) {
            const auto withImpulse = render(pitch, warmed, true);
            const auto baseline = render(pitch, warmed, false);
            check(withImpulse.ok && baseline.ok, "all audit renders process", failures);
            const std::uint32_t prelude = warmed ? 16U * kWindowFrames : kWindowFrames;
            const auto metrics = measure(withImpulse, baseline, prelude);
            check(metrics.nonFiniteSamples == 0U, "audited output and raw wet stay finite", failures);
            if (!firstCase) std::printf(",\n");
            printCase(pitch, warmed, metrics);
            firstCase = false;
        }
    }
    std::printf("],\"status\":\"%s\",\"failures\":%u}\n",
                failures == 0U ? "metrics-only-no-nonfinite" : "failed", failures);
    return failures == 0U ? 0 : 1;
}
