#include "webrc/dsp/rhythmic_fx.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <vector>

namespace {

using namespace webrc::dsp;
constexpr double kPi = 3.141592653589793238462643383279502884;
std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gWatchedAllocations{0};

bool check(bool condition, const char* message) {
    if (!condition) std::fprintf(stderr, "FAIL: %s\n", message);
    return condition;
}

ProcessSpec spec(std::uint32_t maxBlockFrames = 256U, float sampleRate = 48000.0f) {
    return {sampleRate, maxBlockFrames, 2U};
}

double rms(const std::vector<StereoFrame>& samples, std::size_t start,
           std::size_t count, bool right = false) {
    double energy = 0.0;
    const auto end = std::min(samples.size(), start + count);
    for (std::size_t i = start; i < end; ++i) {
        const double value = right ? samples[i].right : samples[i].left;
        energy += value * value;
    }
    return end > start ? std::sqrt(energy / static_cast<double>(end - start)) : 0.0;
}

double toneRms(RhythmicFxKind kind, double frequency, RhythmicFxControl control,
               float controlValue) {
    constexpr std::uint32_t frames = 24000U;
    RhythmicFxProcessor processor;
    if (!processor.prepare(spec(256U), kind)) return -1.0;
    std::vector<StereoFrame> output(frames);
    const std::array<RhythmicFxEvent, 2> events{{
        {0U, RhythmicFxControl::Active, 0U, 1.0f},
        {0U, control, 0U, controlValue},
    }};
    for (std::uint32_t start = 0; start < frames;) {
        const auto count = std::min<std::uint32_t>(256U, frames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            const double phase = 2.0 * kPi * frequency * frame / 48000.0;
            output[frame] = {0.22f * static_cast<float>(std::sin(phase)),
                             0.17f * static_cast<float>(std::sin(phase + 0.31))};
        }
        const auto eventCount = start == 0U ? 2U : 0U;
        if (!processor.processBlock(start, output.data() + start, count,
                                    eventCount ? events.data() : nullptr, eventCount)) return -1.0;
        start += count;
    }
    return std::sqrt((rms(output, 10000U, 12000U) * rms(output, 10000U, 12000U) +
                      rms(output, 10000U, 12000U, true) * rms(output, 10000U, 12000U, true)) * 0.5);
}

std::vector<StereoFrame> renderPattern(std::uint32_t blockFrames, std::uint32_t totalFrames,
                                       std::uint32_t& finalPatternId,
                                       double& eventTick) {
    RhythmicFxProcessor processor;
    if (!processor.prepare(spec(256U), RhythmicFxKind::PatternSlicer)) return {};
    std::vector<StereoFrame> output(totalFrames);
    constexpr std::uint32_t tempoFrame = 6000U;
    constexpr std::uint32_t patternFrame = 45023U;
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min(blockFrames, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            output[start + i] = {0.25f, -0.1f};
        }
        std::array<RhythmicFxEvent, 3> events{};
        std::uint32_t eventCount = 0U;
        if (start == 0U) {
            events[eventCount++] = {0U, RhythmicFxControl::Active, 0U, 1.0f};
            events[eventCount++] = {0U, RhythmicFxControl::PatternId, 0U, 0.0f};
        }
        if (start <= tempoFrame && tempoFrame < start + count)
            events[eventCount++] = {tempoFrame - start, RhythmicFxControl::TempoBpm, 0U, 60.0f};
        if (start <= patternFrame && patternFrame < start + count)
            events[eventCount++] = {patternFrame - start, RhythmicFxControl::PatternId, 0U, 3.0f};
        if (!processor.processBlock(start, output.data() + start, count,
                                    eventCount ? events.data() : nullptr, eventCount)) return {};
        start += count;
    }
    finalPatternId = processor.patternId();
    eventTick = processor.tickAtFrame(tempoFrame);
    return output;
}

bool testTablesBudgetAndIdentity() {
    if (!check(RhythmicFxProcessor::effectOrdinal(RhythmicFxKind::Isolator) == 27U &&
               RhythmicFxProcessor::effectOrdinal(RhythmicFxKind::PatternSlicer) == 34U &&
               RhythmicFxProcessor::effectOrdinal(RhythmicFxKind::StepSlicer) == 35U,
               "three processors preserve their catalog ordinals") ||
        !check(rhythmicFxPatternCount(RhythmicFxKind::PatternSlicer) == 8U &&
               rhythmicFxPatternCount(RhythmicFxKind::StepSlicer) == 6U,
               "slicers expose explicit non-placeholder preset tables") ||
        !check(rhythmicFxPattern(RhythmicFxKind::Isolator, 0U) == nullptr &&
               rhythmicFxPattern(RhythmicFxKind::PatternSlicer, 8U) == nullptr,
               "invalid or non-table pattern lookups fail closed")) return false;
    for (auto kind : {RhythmicFxKind::PatternSlicer, RhythmicFxKind::StepSlicer}) {
        const auto count = rhythmicFxPatternCount(kind);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto* preset = rhythmicFxPattern(kind, i);
            if (!check(preset && preset->stableId && preset->stableId[0] != '\0',
                       "every clean-room pattern has a stable id")) return false;
            for (const float value : preset->levels) {
                if (!check(std::isfinite(value) && value >= 0.0f && value <= 1.0f,
                           "pattern levels are bounded in [0,1]")) return false;
            }
        }
    }
    const auto pattern0 = rhythmicFxPattern(RhythmicFxKind::PatternSlicer, 0U);
    const auto pattern1 = rhythmicFxPattern(RhythmicFxKind::PatternSlicer, 1U);
    if (!check(pattern0->levels[0] == 1.0f && pattern0->levels[1] == 0.0f &&
               pattern0->levels[4] == 1.0f && pattern1->levels[0] == 1.0f &&
               pattern1->levels[2] == 1.0f,
               "quarter and eighth gate descriptors contain their exact step arrays")) return false;

    const auto stereo = spec(64U);
    if (!check(RhythmicFxProcessor::requiredMemoryBytes(stereo, RhythmicFxKind::Isolator) ==
                   sizeof(RhythmicFxProcessor),
               "fixed-storage preflight reports the entire processor object") ||
        !check(RhythmicFxProcessor::requiredMemoryBytes({48000.0f,64U,1U},
                   RhythmicFxKind::StepSlicer) == 0U,
               "family rejects a mono ProcessSpec") ||
        !check(RhythmicFxProcessor::requiredMemoryBytes({192001.0f,64U,2U},
                   RhythmicFxKind::PatternSlicer) == 0U,
               "family rejects unsupported memory-admission sample rates")) return false;
    RhythmicFxProcessor processor;
    if (!check(processor.prepare(stereo, RhythmicFxKind::Isolator),
               "fixed-memory isolator prepares") ||
        !check(processor.preparedBytes() ==
                   RhythmicFxProcessor::requiredMemoryBytes(stereo, RhythmicFxKind::Isolator),
               "prepared memory ledger equals the preflight estimate")) return false;
    return true;
}

bool testIsolatorFrequencyBands() {
    struct Case { double frequency; RhythmicFxControl mute; const char* name; };
    constexpr std::array<Case, 3> cases{{
        {80.0, RhythmicFxControl::LowMute, "low"},
        {1000.0, RhythmicFxControl::MidMute, "mid"},
        {7000.0, RhythmicFxControl::HighMute, "high"},
    }};
    for (const auto& item : cases) {
        const double baseline = toneRms(RhythmicFxKind::Isolator, item.frequency,
                                        item.mute, 0.0f);
        const double muted = toneRms(RhythmicFxKind::Isolator, item.frequency,
                                     item.mute, 1.0f);
        constexpr double expectedInputRms = 0.1390288;
        const double unityErrorDb = 20.0 * std::log10(baseline / expectedInputRms);
        const double ratioDb = 20.0 * std::log10(std::max(1.0e-12, muted / baseline));
        if (!check(std::fabs(unityErrorDb) < 0.6 && ratioDb < -22.0,
                   "isolator crossover recombines near unity and mutes the intended band")) {
            std::fprintf(stderr, "Isolator %s %.0f Hz unity=%.7f (%.2f dB) muted=%.7f ratio=%.2f dB\n",
                         item.name, item.frequency, baseline, unityErrorDb, muted, ratioDb);
            return false;
        }
        std::printf("Isolator %s %.0f Hz unity %.2f dB, mute %.2f dB\n",
                    item.name, item.frequency, unityErrorDb, ratioDb);
    }
    const double lowUnity = toneRms(RhythmicFxKind::Isolator, 80.0,
                                    RhythmicFxControl::LowGainDb, 0.0f);
    const double lowBoosted = toneRms(RhythmicFxKind::Isolator, 80.0,
                                      RhythmicFxControl::LowGainDb, 6.0f);
    const double boostDb = 20.0 * std::log10(lowBoosted / lowUnity);
    if (!check(std::fabs(boostDb - 6.0) < 0.2,
               "low-band gain control has the expected measured 6 dB tone response")) {
        std::fprintf(stderr, "isolator low boost measured %.4f dB\n", boostDb);
        return false;
    }
    return true;
}

bool testTickPositionsAndPartitionParity() {
    constexpr std::uint32_t totalFrames = 64000U;
    std::uint32_t id64 = 0U, id128 = 0U, id256 = 0U;
    double tick64 = 0.0, tick128 = 0.0, tick256 = 0.0;
    const auto r64 = renderPattern(64U, totalFrames, id64, tick64);
    const auto r128 = renderPattern(128U, totalFrames, id128, tick128);
    const auto r256 = renderPattern(256U, totalFrames, id256, tick256);
    if (!check(r64.size() == totalFrames && r128.size() == totalFrames &&
               r256.size() == totalFrames,
               "tempo and pattern events render under all legal test partitions")) return false;
    double max64_128 = 0.0;
    double max64_256 = 0.0;
    for (std::uint32_t i = 0; i < totalFrames; ++i) {
        max64_128 = std::max(max64_128,
            std::max(std::fabs(static_cast<double>(r64[i].left) - r128[i].left),
                     std::fabs(static_cast<double>(r64[i].right) - r128[i].right)));
        max64_256 = std::max(max64_256,
            std::max(std::fabs(static_cast<double>(r64[i].left) - r256[i].left),
                     std::fabs(static_cast<double>(r64[i].right) - r256[i].right)));
    }
    if (!check(id64 == 3U && id128 == 3U && id256 == 3U,
               "sample-offset pattern event takes effect at its exact scheduled frame") ||
        !check(std::fabs(tick64 - 240.0) < 1.0e-12 &&
               std::fabs(tick128 - tick64) < 1.0e-12 &&
               std::fabs(tick256 - tick64) < 1.0e-12,
               "tempo event at frame 6000 preserves the exact 240-tick phase") ||
        !check(max64_128 == 0.0 && max64_256 == 0.0,
               "absolute-frame tempo and pattern clock is bit-identical for 64/128/256 blocks")) {
        std::fprintf(stderr, "rhythm partition max deltas %.9g %.9g; tick %.17g %.17g %.17g\n",
                     max64_128, max64_256, tick64, tick128, tick256);
        return false;
    }

    std::uint32_t knownId = 0U;
    double knownTick = 0.0;
    const auto known = renderPattern(128U, 44000U, knownId, knownTick);
    const double onBeforeTempo = std::fabs(known[3000U].left);
    const double offAfterFirstSixteenth = std::fabs(known[9000U].left);
    const double onAtNextBar = std::fabs(known[42000U + 200U].left);
    double gateBoundaryStep = 0.0;
    for (std::uint32_t frame = 5900U; frame < 6100U; ++frame)
        gateBoundaryStep = std::max(gateBoundaryStep,
            std::fabs(static_cast<double>(known[frame].left) - known[frame - 1U].left));
    double barBoundaryStep = 0.0;
    for (std::uint32_t frame = 41900U; frame < 42150U; ++frame)
        barBoundaryStep = std::max(barBoundaryStep,
            std::fabs(static_cast<double>(known[frame].left) - known[frame - 1U].left));
    double patternControlStep = 0.0;
    for (std::uint32_t frame = 44900U; frame < 45200U; ++frame)
        patternControlStep = std::max(patternControlStep,
            std::fabs(static_cast<double>(r64[frame].left) - r64[frame - 1U].left));
    if (!check(onBeforeTempo > 0.20 && offAfterFirstSixteenth < 0.002 &&
               onAtNextBar > 0.20 && gateBoundaryStep < 0.01 &&
               barBoundaryStep < 0.01 && patternControlStep < 0.01,
               "quarter-gate grid and pattern automation edges are sample-timed and click-smoothed")) {
        std::fprintf(stderr, "known gate samples on %.6f off %.6f nextbar %.6f; steps %.6f %.6f %.6f\n",
                     onBeforeTempo, offAfterFirstSixteenth, onAtNextBar,
                     gateBoundaryStep, barBoundaryStep, patternControlStep);
        return false;
    }
    std::printf("Slicer clock: tick@tempo event %.3f; partition deltas %.1f / %.1f; gate samples %.4f / %.4f / %.4f; max adjacent steps %.5f / %.5f / %.5f\n",
                tick64, max64_128, max64_256,
                onBeforeTempo, offAfterFirstSixteenth, onAtNextBar,
                gateBoundaryStep, barBoundaryStep, patternControlStep);
    return true;
}

bool testStepSequencePanAndFilter() {
    RhythmicFxProcessor processor;
    if (!processor.prepare(spec(256U), RhythmicFxKind::StepSlicer)) return false;
    constexpr std::uint32_t totalFrames = 60000U;
    std::vector<StereoFrame> output(totalFrames, {0.2f, -0.1f});
    std::array<RhythmicFxEvent, 50> setup{};
    std::uint32_t count = 0U;
    setup[count++] = {0U, RhythmicFxControl::Active, 0U, 1.0f};
    setup[count++] = {0U, RhythmicFxControl::PatternId, 0U, 1.0f};
    setup[count++] = {0U, RhythmicFxControl::StepPan, 0U, -1.0f};
    setup[count++] = {0U, RhythmicFxControl::StepCutoffHz, 0U, 18000.0f};
    setup[count++] = {0U, RhythmicFxControl::StepGain, 8U, 0.0f};
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto frames = std::min<std::uint32_t>(256U, totalFrames - start);
        const auto eventCount = start == 0U ? count : 0U;
        if (!processor.processBlock(start, output.data() + start, frames,
                                    eventCount ? setup.data() : nullptr, eventCount)) return false;
        start += frames;
    }
    const auto leftPan = output[3000U].left;
    const auto rightPan = output[3000U].right;
    const auto mutedStep = output[51000U].left;
    const auto followingStep = output[57000U].left;
    if (!check(std::fabs(leftPan - 0.1f) < 0.01f && std::fabs(rightPan) < 0.005f,
               "step pan uses the stereo crossfeed law with a hard-left event") ||
        !check(std::fabs(mutedStep) < 0.01f && std::fabs(followingStep) > 0.08f,
               "sample-edited step gain mutes one exact grid step and preserves the next")) {
        std::fprintf(stderr, "step pan=(%.6f,%.6f), step8=%.6f step9=%.6f\n",
                     leftPan,rightPan,mutedStep,followingStep);
        return false;
    }
    return true;
}

bool testValidationAndNoAllocation() {
    constexpr std::array<RhythmicFxKind, 3> kinds{{
        RhythmicFxKind::Isolator, RhythmicFxKind::PatternSlicer, RhythmicFxKind::StepSlicer
    }};
    for (const auto kind : kinds) {
        RhythmicFxProcessor processor;
        if (!processor.prepare(spec(64U), kind)) return false;
        std::array<StereoFrame, 64> samples{};
        std::array<RhythmicFxEvent, 64> events{};
        for (std::uint32_t i = 0; i < events.size(); ++i) {
            if (kind == RhythmicFxKind::Isolator)
                events[i] = {i, RhythmicFxControl::Wet, 0U, (i & 1U) ? 0.7f : 1.0f};
            else if (kind == RhythmicFxKind::PatternSlicer)
                events[i] = {i, RhythmicFxControl::PatternId, 0U,
                             static_cast<float>(i % rhythmicFxPatternCount(kind))};
            else
                events[i] = {i, RhythmicFxControl::StepGain,
                             static_cast<std::uint8_t>(i % 16U), (i & 1U) ? 0.8f : 0.4f};
        }
        gWatchedAllocations.store(0U, std::memory_order_relaxed);
        gWatchAllocations.store(true, std::memory_order_relaxed);
        const bool processed = processor.processBlock(0U, samples.data(), 64U,
            events.data(), static_cast<std::uint32_t>(events.size()));
        gWatchAllocations.store(false, std::memory_order_relaxed);
        if (!check(processed && gWatchedAllocations.load(std::memory_order_relaxed) == 0U,
                   "64 ordered sample events run allocation-free for every processor kind"))
            return false;
    }

    RhythmicFxProcessor processor;
    RhythmicFxProcessor reference;
    if (!processor.prepare(spec(64U), RhythmicFxKind::StepSlicer) ||
        !reference.prepare(spec(64U), RhythmicFxKind::StepSlicer)) return false;
    std::array<StereoFrame, 64> attempted{};
    std::array<StereoFrame, 64> expected{};
    attempted.fill({0.1f, -0.02f});
    expected = attempted;
    const std::array<RhythmicFxEvent, 2> hostile{{
        {0U, RhythmicFxControl::Active, 0U, 1.0f},
        {1U, RhythmicFxControl::StepGain, 16U, 0.2f},
    }};
    if (!check(!processor.processBlock(0U, attempted.data(), 64U,
                    hostile.data(), static_cast<std::uint32_t>(hostile.size())),
               "invalid step index rejects the complete event batch") ||
        !check(!processor.active(), "rejected mixed batch does not apply an earlier active event") ||
        !check(processor.processBlock(0U, attempted.data(), 64U) &&
               reference.processBlock(0U, expected.data(), 64U),
               "failed batch leaves both instances ready for the same frame")) return false;
    for (std::uint32_t i = 0; i < 64U; ++i) {
        if (!check(attempted[i].left == expected[i].left &&
                   attempted[i].right == expected[i].right,
                   "hostile batch leaves audio/state exactly unchanged")) return false;
    }

    std::array<StereoFrame, 64> block{};
    const std::array<RhythmicFxEvent, 2> outOfOrder{{
        {4U, RhythmicFxControl::TempoBpm, 0U, 90.0f},
        {3U, RhythmicFxControl::Active, 0U, 1.0f},
    }};
    RhythmicFxProcessor ordered;
    if (!ordered.prepare(spec(64U), RhythmicFxKind::PatternSlicer)) return false;
    if (!check(!ordered.processBlock(0U, block.data(), 64U, outOfOrder.data(), 2U),
               "unordered sample events fail closed") ||
        !check(ordered.processBlock(0U, block.data(), 64U),
               "rejected unordered batch does not consume transport time") ||
        !check(!ordered.processBlock(65U, block.data(), 64U),
               "noncontiguous sample time fails closed without a burst catch-up")) return false;
    std::array<StereoFrame, 64> tooManyBlock{};
    std::array<RhythmicFxEvent, 65> tooMany{};
    for (std::uint32_t i = 0; i < tooMany.size(); ++i)
        tooMany[i] = {i % 64U, RhythmicFxControl::Wet, 0U, 0.5f};
    RhythmicFxProcessor boundedEvents;
    if (!boundedEvents.prepare(spec(64U), RhythmicFxKind::Isolator) ||
        !check(!boundedEvents.processBlock(0U, tooManyBlock.data(), 64U,
                    tooMany.data(), static_cast<std::uint32_t>(tooMany.size())),
               "event count above the fixed callback budget rejects transactionally")) return false;
    return true;
}

} // namespace

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gWatchedAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}
void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gWatchedAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    bool ok = true;
    ok = testTablesBudgetAndIdentity() && ok;
    ok = testIsolatorFrequencyBands() && ok;
    ok = testTickPositionsAndPartitionParity() && ok;
    ok = testStepSequencePanAndFilter() && ok;
    ok = testValidationAndNoAllocation() && ok;
    if (!ok) return 1;
    std::puts("PASS: stereo isolator and sample-accurate pattern/step slicers; spectra, clock, bounds and noalloc");
    return 0;
}
