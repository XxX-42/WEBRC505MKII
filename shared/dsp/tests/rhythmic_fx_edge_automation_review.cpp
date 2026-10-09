#include "webrc/dsp/rhythmic_fx.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <vector>

namespace {

using namespace webrc::dsp;
constexpr std::uint32_t kTotalFrames = 72000U;
constexpr double kPi = 3.141592653589793238462643383279502884;

struct EdgeMeasurement {
    double oneToTenDc = 0.0;
    double tenToPointOneDc = 0.0;
    double oneToTenSine = 0.0;
    double tenToPointOneSine = 0.0;
    bool twentyMsRejected = false;
};

bool render(bool sine, std::uint8_t scenario, std::vector<StereoFrame>& input,
            std::vector<StereoFrame>& output) {
    RhythmicFxProcessor processor;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    if (!processor.prepare(spec, RhythmicFxKind::PatternSlicer)) return false;
    input.resize(kTotalFrames);
    output.resize(kTotalFrames);
    for (std::uint32_t frame = 0U; frame < kTotalFrames; ++frame) {
        const float sample = sine
            ? 0.5f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * frame / 48000.0))
            : 0.5f;
        input[frame] = {sample, sample};
    }

    // At 120 BPM the 16-step grid is 6000 frames per step. In the quarter
    // pulse pattern, steps 4 and 8 rise from zero. Change the edge length 24
    // frames into each edge window to isolate the automation discontinuity.
    std::array<RhythmicFxEvent, 5> schedule{{
        {0U, RhythmicFxControl::Active, 0U, 1.0f},
        {0U, RhythmicFxControl::PatternId, 0U, 0.0f},
        {0U, RhythmicFxControl::EdgeMilliseconds, 0U, 1.0f},
        {24024U, RhythmicFxControl::EdgeMilliseconds, 0U, 10.0f},
        {48024U, RhythmicFxControl::EdgeMilliseconds, 0U, 0.1f},
    }};
    std::uint32_t scheduleCount = static_cast<std::uint32_t>(schedule.size());
    if (scenario == 1U) {
        scheduleCount = 3U; // Fixed 1 ms reference for the 1 -> 10 ms change.
    } else if (scenario == 2U) {
        schedule[2].value = 10.0f;
        scheduleCount = 3U; // Fixed 10 ms reference for the 10 -> 0.1 ms change.
    }
    std::uint32_t scheduleIndex = 0U;
    for (std::uint32_t start = 0U; start < kTotalFrames;) {
        const auto frames = std::min<std::uint32_t>(256U, kTotalFrames - start);
        std::array<RhythmicFxEvent, 5> localEvents{};
        std::uint32_t eventCount = 0U;
        while (scheduleIndex < scheduleCount &&
               schedule[scheduleIndex].frameOffset < start + frames) {
            auto event = schedule[scheduleIndex++];
            if (event.frameOffset < start) return false;
            event.frameOffset -= start;
            localEvents[eventCount++] = event;
        }
        std::copy_n(input.data() + start, frames, output.data() + start);
        if (!processor.processBlock(start, output.data() + start, frames,
                                    eventCount == 0U ? nullptr : localEvents.data(),
                                    eventCount)) return false;
        start += frames;
    }
    return scheduleIndex == scheduleCount;
}

} // namespace

int main() {
    EdgeMeasurement measurement{};
    std::vector<StereoFrame> dcInput;
    std::vector<StereoFrame> sineInput;
    std::vector<StereoFrame> dcTreatment, dcOneMs, dcTenMs;
    std::vector<StereoFrame> sineTreatment, sineOneMs, sineTenMs;
    if (!render(false, 0U, dcInput, dcTreatment) || !render(false, 1U, dcInput, dcOneMs) ||
        !render(false, 2U, dcInput, dcTenMs) || !render(true, 0U, sineInput, sineTreatment) ||
        !render(true, 1U, sineInput, sineOneMs) || !render(true, 2U, sineInput, sineTenMs)) {
        std::fprintf(stderr, "Could not render edge automation fixture\n");
        return 2;
    }
    const auto normalizedStep = [&](const std::vector<StereoFrame>& source,
                                    const std::vector<StereoFrame>& treatment,
                                    const std::vector<StereoFrame>& baseline,
                                    std::uint32_t eventFrame, bool sine) {
        const float before = source[eventFrame - 1U].left;
        const float after = source[eventFrame].left;
        if (sine && (std::abs(before) < 0.1f || std::abs(after) < 0.1f))
            return std::numeric_limits<double>::infinity();
        const double treatmentBefore = treatment[eventFrame - 1U].left / before;
        const double treatmentAfter = treatment[eventFrame].left / after;
        const double baselineBefore = baseline[eventFrame - 1U].left / before;
        const double baselineAfter = baseline[eventFrame].left / after;
        // Subtract the ordinary gate-edge slope present without automation so
        // the measurement isolates the extra discontinuity from control change.
        return std::abs((treatmentAfter - treatmentBefore) -
                        (baselineAfter - baselineBefore));
    };
    measurement.oneToTenDc = normalizedStep(dcInput, dcTreatment, dcOneMs, 24024U, false);
    measurement.tenToPointOneDc = normalizedStep(dcInput, dcTreatment, dcTenMs, 48024U, false);
    measurement.oneToTenSine = normalizedStep(sineInput, sineTreatment, sineOneMs, 24024U, true);
    measurement.tenToPointOneSine = normalizedStep(sineInput, sineTreatment, sineTenMs, 48024U, true);
    RhythmicFxProcessor validation;
    const ProcessSpec spec{48000.0f, 64U, 2U};
    if (!validation.prepare(spec, RhythmicFxKind::PatternSlicer)) return 2;
    std::array<StereoFrame, 64> block{};
    const RhythmicFxEvent unsupported{0U, RhythmicFxControl::EdgeMilliseconds, 0U, 20.0f};
    measurement.twentyMsRejected = !validation.processBlock(0U, block.data(), 64U,
                                                             &unsupported, 1U);
    std::printf(
        "{\"schemaVersion\":1,\"fixture\":\"rhythmic-edge-automation-review\","
        "\"kind\":\"PATTERN SLICER\",\"sampleRate\":48000,\"tempoBpm\":120,"
        "\"patternId\":0,\"edgeChanges\":[{\"frame\":24024,\"fromMs\":1,\"toMs\":10},"
        "{\"frame\":48024,\"fromMs\":10,\"toMs\":0.1}],"
        "\"edgeBoundsMs\":[0.1,10],\"twentyMsRejected\":%s,"
        "\"dcNormalizedGainSteps\":[%.9g,%.9g],"
        "\"sine440NormalizedGainSteps\":[%.9g,%.9g],"
        "\"limit\":0.05}\n",
        measurement.twentyMsRejected ? "true" : "false",
        measurement.oneToTenDc, measurement.tenToPointOneDc,
        measurement.oneToTenSine, measurement.tenToPointOneSine);
    const auto largest = std::max({measurement.oneToTenDc, measurement.tenToPointOneDc,
                                   measurement.oneToTenSine, measurement.tenToPointOneSine});
    if (!measurement.twentyMsRejected || !std::isfinite(largest) || largest > 0.05) {
        std::fprintf(stderr, "Edge-length automation discontinuity exceeds normalized step limit\n");
        return 1;
    }
    std::puts("Rhythmic edge automation passed");
    return 0;
}
