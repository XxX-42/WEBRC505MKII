#include "webrc/dsp/modulated_delay_fx.hpp"

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

StereoFrame source(std::uint64_t frame) {
    const double time = static_cast<double>(frame) / 48000.0;
    return {0.24f * static_cast<float>(std::sin(2.0 * kPi * 211.0 * time)) +
                0.06f * static_cast<float>(std::sin(2.0 * kPi * 71.0 * time)),
            0.18f * static_cast<float>(std::sin(2.0 * kPi * 307.0 * time + 0.41)) +
                0.05f * static_cast<float>(std::sin(2.0 * kPi * 97.0 * time))};
}

struct KindControls {
    float rate = 0.75f;
    float base = 8.0f;
    float depth = 4.0f;
    float feedback = 0.2f;
};

KindControls controlsFor(ModulatedDelayKind kind) {
    switch (kind) {
    case ModulatedDelayKind::Flanger: return {0.31f, 8.0f, 5.0f, 0.5f};
    case ModulatedDelayKind::Chorus: return {0.77f, 31.0f, 7.0f, 0.28f};
    case ModulatedDelayKind::Vibrato: return {4.3f, 10.0f, 4.0f, 0.0f};
    case ModulatedDelayKind::ModDelay: return {0.43f, 280.0f, 12.0f, 0.36f};
    case ModulatedDelayKind::PanningDelay: return {0.52f, 280.0f, 12.0f, 0.42f};
    }
    return {};
}

std::uint32_t makeInitialEvents(ModulatedDelayKind kind, std::uint32_t offset,
                               std::array<ModulatedDelayEvent, 12>& events,
                               float wet = 0.68f) {
    const auto controls = controlsFor(kind);
    std::uint32_t count = 0U;
    events[count++] = {offset, ModulatedDelayControl::Active, 1.0f};
    events[count++] = {offset, ModulatedDelayControl::Wet, wet};
    events[count++] = {offset, ModulatedDelayControl::RateHz, controls.rate};
    events[count++] = {offset, ModulatedDelayControl::BaseDelayMs, controls.base};
    events[count++] = {offset, ModulatedDelayControl::DepthMs, controls.depth};
    if (kind != ModulatedDelayKind::Vibrato)
        events[count++] = {offset, ModulatedDelayControl::Feedback, controls.feedback};
    if (kind == ModulatedDelayKind::PanningDelay) {
        events[count++] = {offset, ModulatedDelayControl::Pan, 0.0f};
        events[count++] = {offset, ModulatedDelayControl::PanDepth, 0.72f};
        events[count++] = {offset, ModulatedDelayControl::CrossFeedback, 0.85f};
    }
    return count;
}

std::vector<StereoFrame> render(ModulatedDelayKind kind, std::uint32_t blockFrames,
                                std::uint32_t totalFrames) {
    ModulatedDelayFx processor;
    if (!processor.prepare(spec(256U), kind)) return {};
    std::vector<StereoFrame> output(totalFrames);
    constexpr std::uint32_t wetChangeAt = 17777U;
    constexpr std::uint32_t rateChangeAt = 24001U;
    constexpr std::uint32_t depthChangeAt = 29113U;
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min(blockFrames, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) output[start + i] = source(start + i);
        std::array<ModulatedDelayEvent, 12> events{};
        std::uint32_t eventCount = 0U;
        if (start == 0U) eventCount = makeInitialEvents(kind, 0U, events);
        if (start <= wetChangeAt && wetChangeAt < start + count)
            events[eventCount++] = {wetChangeAt - start, ModulatedDelayControl::Wet, 0.37f};
        if (start <= rateChangeAt && rateChangeAt < start + count)
            events[eventCount++] = {rateChangeAt - start, ModulatedDelayControl::RateHz, 1.31f};
        if (start <= depthChangeAt && depthChangeAt < start + count)
            events[eventCount++] = {depthChangeAt - start, ModulatedDelayControl::DepthMs,
                                    controlsFor(kind).depth * 0.45f};
        if (kind == ModulatedDelayKind::PanningDelay &&
            start <= depthChangeAt && depthChangeAt < start + count) {
            events[eventCount++] = {depthChangeAt - start, ModulatedDelayControl::CrossFeedback,
                                    0.25f};
            events[eventCount++] = {depthChangeAt - start, ModulatedDelayControl::Pan, -0.35f};
        }
        if (!processor.processBlock(start, output.data() + start, count,
                                    eventCount == 0U ? nullptr : events.data(), eventCount)) return {};
        start += count;
    }
    return output;
}

double rms(const std::vector<StereoFrame>& frames, std::size_t begin, std::size_t end,
           bool right = false) {
    double energy = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        const double sample = right ? frames[i].right : frames[i].left;
        energy += sample * sample;
    }
    return end > begin ? std::sqrt(energy / static_cast<double>(end - begin)) : 0.0;
}

bool testBudgetLatencyAndOrdinals() {
    const auto stereo = spec(64U);
    if (!check(ModulatedDelayFx::requiredPrepareBytes(stereo, ModulatedDelayKind::Flanger) >
                   sizeof(ModulatedDelayFx), "Flanger reports its complete delay memory budget") ||
        !check(ModulatedDelayFx::requiredPrepareBytes(stereo, ModulatedDelayKind::PanningDelay) >
                   ModulatedDelayFx::requiredPrepareBytes(stereo, ModulatedDelayKind::Flanger),
               "long delay kinds reserve proportionate stereo history memory") ||
        !check(ModulatedDelayFx::requiredPrepareBytes({48000.0f, 64U, 1U},
                   ModulatedDelayKind::Chorus) == 0U, "delay family rejects mono ProcessSpec") ||
        !check(ModulatedDelayFx::requiredPrepareBytes({192001.0f, 64U, 2U},
                   ModulatedDelayKind::ModDelay) == 0U, "delay memory cap rejects unsupported sample rates") ||
        !check(ModulatedDelayFx::effectOrdinal(ModulatedDelayKind::Flanger) == 5U &&
               ModulatedDelayFx::effectOrdinal(ModulatedDelayKind::Vibrato) == 33U &&
               ModulatedDelayFx::effectOrdinal(ModulatedDelayKind::PanningDelay) == 37U &&
               ModulatedDelayFx::effectOrdinal(ModulatedDelayKind::ModDelay) == 39U &&
               ModulatedDelayFx::effectOrdinal(ModulatedDelayKind::Chorus) == 46U,
               "delay kinds retain the five source ordinals")) return false;
    ModulatedDelayFx processor;
    if (!check(processor.prepare(stereo, ModulatedDelayKind::ModDelay),
               "Mod Delay prepares within the admitted budget") ||
        !check(processor.preparedBytes() ==
                   ModulatedDelayFx::requiredPrepareBytes(stereo, ModulatedDelayKind::ModDelay),
               "prepared memory ledger equals the estimator") ||
        !check(processor.ringFrames() >= 96016U,
               "two-second Mod Delay has sufficient eight-tap guarded history")) return false;
    const auto window = processor.delayWindowSamples();
    if (!check(window.minimumSamples >= ModulatedDelayFx::kMinimumDelaySamples &&
               window.maximumSamples > window.minimumSamples &&
               window.maximumSamples <= processor.ringFrames() - 8U,
               "variable wet-path latency is reported as a safe sample window")) return false;
    std::printf("Mod Delay preflight: %zu bytes, ring %u frames, wet window %.2f..%.2f samples\n",
                processor.preparedBytes(), processor.ringFrames(),
                window.minimumSamples, window.maximumSamples);
    return true;
}

bool testAllKindsProduceDistinctStereoAndPartitionInvariant() {
    constexpr std::uint32_t totalFrames = 50000U;
    constexpr std::array<ModulatedDelayKind, 5> kinds{{
        ModulatedDelayKind::Flanger, ModulatedDelayKind::Chorus,
        ModulatedDelayKind::Vibrato, ModulatedDelayKind::ModDelay,
        ModulatedDelayKind::PanningDelay,
    }};
    for (const auto kind : kinds) {
        const auto output64 = render(kind, 64U, totalFrames);
        const auto output256 = render(kind, 256U, totalFrames);
        if (!check(output64.size() == totalFrames && output256.size() == totalFrames,
                   "kind rendered both block schedules")) return false;
        double maximumDifference = 0.0;
        double stereoDifference = 0.0;
        double effectDifference = 0.0;
        for (std::uint32_t i = 0; i < totalFrames; ++i) {
            maximumDifference = std::max(maximumDifference,
                std::max(std::fabs(static_cast<double>(output64[i].left) - output256[i].left),
                         std::fabs(static_cast<double>(output64[i].right) - output256[i].right)));
            stereoDifference += std::fabs(static_cast<double>(output64[i].left) - output64[i].right);
            if (i >= 18000U && i < 48000U) {
                const auto dry = source(i);
                effectDifference += std::fabs(static_cast<double>(output64[i].left) - dry.left) +
                                    std::fabs(static_cast<double>(output64[i].right) - dry.right);
            }
            if (!std::isfinite(output64[i].left) || !std::isfinite(output64[i].right) ||
                std::fabs(output64[i].left) > 8.0f || std::fabs(output64[i].right) > 8.0f)
                return check(false, "delay output remains finite and bounded");
        }
        if (!check(maximumDifference < 1.0e-6,
                   "sample-offset automation is invariant to 64/256-frame partitions") ||
            !check(stereoDifference / totalFrames > 0.002,
                   "stereo delay retains independent channel content") ||
            !check(effectDifference > 25.0,
                   "processor changes its stereo dry signal after the wet path arrives")) {
            std::fprintf(stderr, "Delay kind=%u blockDiff=%.9g stereo=%.6f effect=%.4f\n",
                         static_cast<unsigned>(kind), maximumDifference,
                         stereoDifference / totalFrames, effectDifference);
            return false;
        }
        std::printf("Delay ordinal %u: max partition delta %.9g, mean stereo delta %.6f, effect delta %.4f\n",
                    ModulatedDelayFx::effectOrdinal(kind), maximumDifference,
                    stereoDifference / totalFrames, effectDifference);
    }
    return true;
}

bool testFractionalVibratoDelayImpulse() {
    ModulatedDelayFx processor;
    if (!processor.prepare(spec(128U), ModulatedDelayKind::Vibrato)) return false;
    constexpr std::uint32_t impulseFrame = 3000U;
    constexpr std::uint32_t totalFrames = 4200U;
    std::array<ModulatedDelayEvent, 5> events{{
        {0U, ModulatedDelayControl::Active, 1.0f},
        {0U, ModulatedDelayControl::Wet, 1.0f},
        {0U, ModulatedDelayControl::RateHz, 0.5f},
        {0U, ModulatedDelayControl::BaseDelayMs, 10.26041667f},
        {0U, ModulatedDelayControl::DepthMs, 0.0f},
    }};
    std::vector<StereoFrame> output(totalFrames);
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min<std::uint32_t>(128U, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            output[frame] = frame == impulseFrame ? StereoFrame{1.0f, -0.25f} : StereoFrame{};
        }
        if (!processor.processBlock(start, output.data() + start, count,
                                    start == 0U ? events.data() : nullptr,
                                    start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U))
            return false;
        start += count;
    }
    double weightedOffset = 0.0;
    double totalAbsolute = 0.0;
    double energy = 0.0;
    float peak = 0.0f;
    for (std::uint32_t frame = impulseFrame + 488U; frame <= impulseFrame + 500U; ++frame) {
        const double sample = std::fabs(static_cast<double>(output[frame].left));
        weightedOffset += static_cast<double>(frame - impulseFrame) * sample;
        totalAbsolute += sample;
        energy += sample * sample;
        peak = std::max(peak, static_cast<float>(sample));
    }
    const double centroid = totalAbsolute > 0.0 ? weightedOffset / totalAbsolute : 0.0;
    const auto window = processor.delayWindowSamples();
    if (!check(peak > 0.55f && peak < 0.75f,
               "fractional 492.5-frame impulse is interpolated across adjacent output samples") ||
        !check(std::fabs(centroid - 492.5) < 0.12,
               "eight-tap delay interpolation preserves fractional group delay") ||
        !check(energy > 0.70 && energy < 0.95,
               "fractional impulse interpolation has bounded energy") ||
        !check(std::fabs(window.minimumSamples - 492.5) < 0.2 &&
               std::fabs(window.maximumSamples - 492.5) < 0.2,
               "Vibrato reports its fixed-delay limit when modulation depth is zero")) {
        std::fprintf(stderr, "Fractional delay peak=%.7f centroid=%.7f energy=%.7f window=[%.4f,%.4f]\n",
                     peak, centroid, energy, window.minimumSamples, window.maximumSamples);
        return false;
    }
    std::printf("Vibrato impulse: peak %.7f, centroid %.7f samples, energy %.7f\n",
                peak, centroid, energy);
    return true;
}

bool testPanningDelayPingPongAndDcBound() {
    ModulatedDelayFx processor;
    if (!processor.prepare(spec(256U), ModulatedDelayKind::PanningDelay)) return false;
    constexpr std::uint32_t impulseFrame = 24000U;
    constexpr std::uint32_t delayFrames = 960U;
    constexpr std::uint32_t totalFrames = 180000U;
    std::array<ModulatedDelayEvent, 9> events{{
        {0U, ModulatedDelayControl::Active, 1.0f},
        {0U, ModulatedDelayControl::Wet, 1.0f},
        {0U, ModulatedDelayControl::RateHz, 0.5f},
        {0U, ModulatedDelayControl::BaseDelayMs, 20.0f},
        {0U, ModulatedDelayControl::DepthMs, 0.0f},
        {0U, ModulatedDelayControl::Feedback, 0.5f},
        {0U, ModulatedDelayControl::Pan, 0.0f},
        {0U, ModulatedDelayControl::PanDepth, 0.0f},
        {0U, ModulatedDelayControl::CrossFeedback, 1.0f},
    }};
    std::array<StereoFrame, 256> block{};
    float firstEchoLeft = 0.0f;
    float secondEchoRight = 0.0f;
    double maximum = 0.0;
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min<std::uint32_t>(256U, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            if (frame < impulseFrame) block[i] = {};
            else if (frame == impulseFrame) block[i] = {1.0f, 0.0f};
            else if (frame < 48000U) block[i] = {0.0f, 0.0f};
            else block[i] = {0.5f, -0.25f}; // DC stress exercises feedback high-pass.
        }
        const auto isFirst = start == 0U;
        if (!processor.processBlock(start, block.data(), count,
                                    isFirst ? events.data() : nullptr,
                                    isFirst ? static_cast<std::uint32_t>(events.size()) : 0U))
            return false;
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            maximum = std::max(maximum, std::max(std::fabs(static_cast<double>(block[i].left)),
                                                std::fabs(static_cast<double>(block[i].right))));
            if (frame == impulseFrame + delayFrames) firstEchoLeft = block[i].left;
            if (frame == impulseFrame + 2U * delayFrames) secondEchoRight = block[i].right;
            if (!std::isfinite(block[i].left) || !std::isfinite(block[i].right))
                return check(false, "panning delay DC/feedback path remains finite");
        }
        start += count;
    }
    if (!check(firstEchoLeft > 0.9f,
               "panning delay sends a left impulse to its first left echo") ||
        !check(secondEchoRight > 0.4f && secondEchoRight < 0.6f,
               "cross-feedback routes the first echo into the next right echo") ||
        !check(maximum < 2.0,
               "DC blocking and feedback clamps prevent a constant-input runaway")) {
        std::fprintf(stderr, "Panning delay firstL=%.6f secondR=%.6f max=%.6f\n",
                     firstEchoLeft, secondEchoRight, maximum);
        return false;
    }
    std::printf("Panning Delay: first L echo %.6f, second R echo %.6f, DC-stress peak %.6f\n",
                firstEchoLeft, secondEchoRight, maximum);
    return true;
}

bool testValidationAndNoAllocationAtMaximumEvents() {
    ModulatedDelayFx processor;
    if (!processor.prepare(spec(64U), ModulatedDelayKind::Flanger)) return false;
    std::array<StereoFrame, 64> block{};
    block[0] = {0.25f, -0.1f};
    const auto original = block;
    const auto minMs = static_cast<float>(ModulatedDelayFx::kMinimumDelaySamples *
                                          1000.0 / 48000.0);
    const std::array<ModulatedDelayEvent, 2> invalid{{
        {0U, ModulatedDelayControl::BaseDelayMs, minMs + 0.1f},
        {0U, ModulatedDelayControl::DepthMs, 3.0f},
    }};
    if (!check(!processor.processBlock(0U, block.data(), 64U, invalid.data(), 2U),
               "unsafe base/depth pair is rejected transactionally") ||
        !check(block[0].left == original[0].left && block[0].right == original[0].right,
               "rejected event batch preserves audio") ||
        !check(processor.processBlock(0U, block.data(), 64U),
               "failed control batch does not consume the expected frame")) return false;

    ModulatedDelayFx upperBoundProcessor;
    ModulatedDelayFx unchangedReference;
    if (!upperBoundProcessor.prepare(spec(64U), ModulatedDelayKind::ModDelay) ||
        !unchangedReference.prepare(spec(64U), ModulatedDelayKind::ModDelay)) return false;
    const std::array<ModulatedDelayEvent, 2> overRange{{
        {0U, ModulatedDelayControl::BaseDelayMs, 2000.0f},
        {0U, ModulatedDelayControl::DepthMs, 50.0f},
    }};
    std::array<StereoFrame, 64> rejectedAudio{};
    std::array<StereoFrame, 64> referenceAudio{};
    for (std::uint32_t i = 0; i < 64U; ++i) {
        rejectedAudio[i] = referenceAudio[i] = source(i);
    }
    if (!check(!upperBoundProcessor.processBlock(0U, rejectedAudio.data(), 64U,
                    overRange.data(), static_cast<std::uint32_t>(overRange.size())),
               "base plus modulation depth above the allocated history is rejected") ||
        !check(upperBoundProcessor.processBlock(0U, rejectedAudio.data(), 64U) &&
               unchangedReference.processBlock(0U, referenceAudio.data(), 64U),
               "rejected upper-bound batch preserves both transport and parameters")) return false;
    for (std::uint32_t i = 0; i < 64U; ++i) {
        if (!check(rejectedAudio[i].left == referenceAudio[i].left &&
                   rejectedAudio[i].right == referenceAudio[i].right,
                   "rejected upper-bound batch is sample-identical to the unchanged instance"))
            return false;
    }
    ModulatedDelayFx exactUpperBound;
    if (!exactUpperBound.prepare(spec(64U), ModulatedDelayKind::ModDelay)) return false;
    const std::array<ModulatedDelayEvent, 2> exactRange{{
        {0U, ModulatedDelayControl::BaseDelayMs, 1950.0f},
        {0U, ModulatedDelayControl::DepthMs, 50.0f},
    }};
    std::array<StereoFrame, 64> exactAudio{};
    if (!check(exactUpperBound.processBlock(0U, exactAudio.data(), 64U,
                    exactRange.data(), static_cast<std::uint32_t>(exactRange.size())),
               "base plus modulation depth at the allocated history limit is accepted"))
        return false;

    std::array<ModulatedDelayEvent, 65> tooMany{};
    for (std::uint32_t i = 0; i < tooMany.size(); ++i)
        tooMany[i] = {i % 64U, ModulatedDelayControl::Wet, 0.25f};
    ModulatedDelayFx eventsProcessor;
    if (!eventsProcessor.prepare(spec(64U), ModulatedDelayKind::Flanger)) return false;
    if (!check(!eventsProcessor.processBlock(0U, block.data(), 64U, tooMany.data(), 65U),
               "event count above the fixed callback budget is rejected")) return false;
    std::array<ModulatedDelayEvent, 64> events{};
    for (std::uint32_t i = 0; i < events.size(); ++i)
        events[i] = {i, ModulatedDelayControl::Wet, (i & 1U) == 0U ? 0.3f : 0.8f};
    constexpr std::array<ModulatedDelayKind, 5> kinds{{
        ModulatedDelayKind::Flanger, ModulatedDelayKind::Chorus,
        ModulatedDelayKind::Vibrato, ModulatedDelayKind::ModDelay,
        ModulatedDelayKind::PanningDelay,
    }};
    for (const auto kind : kinds) {
        ModulatedDelayFx processorForKind;
        if (!processorForKind.prepare(spec(64U), kind)) return false;
        block.fill({0.1f, -0.03f});
        gWatchedAllocations.store(0U, std::memory_order_relaxed);
        gWatchAllocations.store(true, std::memory_order_relaxed);
        const auto processed = processorForKind.processBlock(0U, block.data(), 64U,
            events.data(), static_cast<std::uint32_t>(events.size()));
        gWatchAllocations.store(false, std::memory_order_relaxed);
        if (!check(processed && gWatchedAllocations.load(std::memory_order_relaxed) == 0U,
                   "64 sample-offset events and stereo history reads allocate nothing"))
            return false;
    }
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
    ok = testBudgetLatencyAndOrdinals() && ok;
    ok = testAllKindsProduceDistinctStereoAndPartitionInvariant() && ok;
    ok = testFractionalVibratoDelayImpulse() && ok;
    ok = testPanningDelayPingPongAndDcBound() && ok;
    ok = testValidationAndNoAllocationAtMaximumEvents() && ok;
    if (!ok) return 1;
    std::puts("PASS: five stereo modulated delays; fractional latency, cross-feedback, bounds, automation partitions and noalloc");
    return 0;
}
