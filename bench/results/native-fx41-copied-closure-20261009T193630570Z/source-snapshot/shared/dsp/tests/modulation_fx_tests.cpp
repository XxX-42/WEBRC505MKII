#include "webrc/dsp/modulation_fx.hpp"
#include "webrc/dsp/control_dynamics.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

namespace {

using namespace webrc::dsp;

std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gWatchedAllocations{0};

bool check(bool condition, const char* message) {
    if (!condition) std::fprintf(stderr, "FAIL: %s\n", message);
    return condition;
}

ProcessSpec spec(std::uint32_t block = 64) { return {48000.0f, block, 2}; }

StereoFrame source(std::uint64_t frame) {
    const double t = static_cast<double>(frame) / 48000.0;
    return {static_cast<float>(0.37 * std::sin(2.0 * 3.141592653589793 * 431.0 * t) +
                               0.11 * std::sin(2.0 * 3.141592653589793 * 73.0 * t)),
            static_cast<float>(0.23 * std::sin(2.0 * 3.141592653589793 * 587.0 * t + 0.71) +
                               0.08 * std::sin(2.0 * 3.141592653589793 * 109.0 * t))};
}

std::uint32_t controlsAt(ModulationFxKind kind, std::uint32_t offset, bool initial,
                         std::array<ModulationFxEvent, 8>& events) {
    std::uint32_t count = 0;
    if (initial) events[count++] = {offset, ModulationFxControl::Active, 1.0f};
    switch (kind) {
    case ModulationFxKind::LoFi:
        events[count++] = {offset, ModulationFxControl::BitDepth, initial ? 11.0f : 9.0f};
        events[count++] = {offset, ModulationFxControl::HoldFrames, initial ? 4.0f : 7.0f};
        events[count++] = {offset, ModulationFxControl::Dither, initial ? 0.4f : 0.7f};
        break;
    case ModulationFxKind::RingModulator:
        events[count++] = {offset, ModulationFxControl::RateHz, initial ? 337.0f : 719.0f};
        events[count++] = {offset, ModulationFxControl::Waveform, initial ? 3.0f : 0.0f};
        break;
    case ModulationFxKind::AutoPan:
        events[count++] = {offset, ModulationFxControl::RateHz, initial ? 1.7f : 0.8f};
        events[count++] = {offset, ModulationFxControl::Depth, initial ? 0.8f : 0.3f};
        events[count++] = {offset, ModulationFxControl::Pan, initial ? 0.15f : -0.2f};
        break;
    case ModulationFxKind::ManualPan:
        events[count++] = {offset, ModulationFxControl::Pan, initial ? 0.7f : -0.35f};
        break;
    case ModulationFxKind::Tremolo:
        events[count++] = {offset, ModulationFxControl::RateHz, initial ? 6.3f : 3.1f};
        events[count++] = {offset, ModulationFxControl::Depth, initial ? 0.85f : 0.55f};
        break;
    }
    events[count++] = {offset, ModulationFxControl::Wet, initial ? 0.9f : 0.65f};
    return count;
}

template <typename Processor>
std::vector<StereoFrame> render(std::uint32_t blockFrames, std::uint32_t totalFrames) {
    Processor processor;
    if (!processor.prepare(spec(256)) || !processor.setSeed(0x8123456789abcdefULL)) return {};
    std::vector<StereoFrame> output(totalFrames);
    constexpr std::uint32_t changeAt = 17119;
    constexpr std::uint32_t stopAt = 57003;
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min(blockFrames, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) output[start + i] = source(start + i);
        std::array<ModulationFxEvent, 8> events{};
        std::uint32_t eventCount = 0;
        if (start == 0) eventCount += controlsAt(processor.kind(), 0, true, events);
        if (start <= changeAt && changeAt < start + count) {
            std::array<ModulationFxEvent, 8> changed{};
            const auto n = controlsAt(processor.kind(), changeAt - start, false, changed);
            for (std::uint32_t i = 0; i < n; ++i) events[eventCount++] = changed[i];
        }
        if (start <= stopAt && stopAt < start + count)
            events[eventCount++] = {stopAt - start, ModulationFxControl::Active, 0.0f};
        if (!processor.processBlock(start, output.data() + start, count,
                                    eventCount == 0U ? nullptr : events.data(), eventCount)) return {};
        start += count;
    }
    return output;
}

double rms(const std::vector<StereoFrame>& frames) {
    double energy = 0.0;
    for (const auto& frame : frames) energy += static_cast<double>(frame.left) * frame.left +
                                               static_cast<double>(frame.right) * frame.right;
    return frames.empty() ? 0.0 : std::sqrt(energy / (2.0 * frames.size()));
}

template <typename Processor>
bool testBlockScheduleInvariant(const char* label) {
    constexpr std::uint32_t frames = 65536;
    const auto output64 = render<Processor>(64, frames);
    const auto output256 = render<Processor>(256, frames);
    if (!check(output64.size() == frames && output256.size() == frames, label)) return false;
    double maximumDifference = 0.0;
    double activeDifference = 0.0;
    double stereoDifference = 0.0;
    for (std::uint32_t i = 0; i < frames; ++i) {
        maximumDifference = std::max(maximumDifference,
            std::max(std::fabs(static_cast<double>(output64[i].left) - output256[i].left),
                     std::fabs(static_cast<double>(output64[i].right) - output256[i].right)));
        stereoDifference += std::fabs(static_cast<double>(output64[i].left) - output64[i].right);
        if (i >= 6000 && i < 50000) {
            const auto dry = source(i);
            activeDifference += std::fabs(static_cast<double>(output64[i].left) - dry.left) +
                                std::fabs(static_cast<double>(output64[i].right) - dry.right);
        }
    }
    if (!check(maximumDifference < 1.0e-7, label) ||
        !check(rms(output64) > 0.025, "processor emits nonzero stereo audio") ||
        !check(stereoDifference / frames > 0.01, "left/right histories remain distinct") ||
        !check(activeDifference > 50.0, "sample-accurate controls create a measurable effect")) {
        std::fprintf(stderr, "%s rms=%.9g maxDiff=%.9g effectDiff=%.9g\n", label,
                     rms(output64), maximumDifference, activeDifference);
        return false;
    }
    return true;
}

bool testValidationAndPrepareBounds() {
    AutoPan pan;
    if (!check(ModulationFxProcessor::requiredPrepareBytes(spec(), ModulationFxKind::AutoPan) > 0,
               "fixed-state processor reports a prepare memory budget") ||
        !check(ModulationFxProcessor::requiredPrepareBytes({48000.0f, 64, 1},
                   ModulationFxKind::Tremolo) == 0,
               "mono ProcessSpec is rejected for the stereo family") ||
        !check(pan.prepare(spec()), "autopan prepares without external memory")) return false;
    std::array<StereoFrame, 8> block{};
    block[0] = {0.25f, -0.125f};
    const auto original = block;
    const ModulationFxEvent invalid{0, ModulationFxControl::Depth, 1.5f};
    if (!check(!pan.processBlock(0, block.data(), 8, &invalid, 1),
               "out-of-domain automation is rejected") ||
        !check(block[0].left == original[0].left && block[0].right == original[0].right &&
               !pan.active() && pan.activeGain() == 0.0f,
               "invalid event list leaves audio and processor state untouched")) return false;
    std::array<ModulationFxEvent, 65> tooMany{};
    for (auto& event : tooMany) event = {0, ModulationFxControl::Wet, 0.5f};
    return check(!pan.processBlock(0, block.data(), 8, tooMany.data(), 65),
                 "event flood over the fixed per-block bound is rejected");
}

bool testPanStereoBalanceAndAutoModulation() {
    ManualPan manual;
    // This also proves the family-qualified stereo ring modulator can coexist
    // with the established mono `RingModulator` primitive.
    RingModulator establishedMonoRingModulator;
    (void)establishedMonoRingModulator;
    if (!manual.prepare(spec(256))) return false;
    std::array<StereoFrame, 256> centered{};
    centered.fill({0.2f, -0.1f});
    const std::array<ModulationFxEvent, 2> centerEvents{{
        {0, ModulationFxControl::Pan, 0.0f},
        {0, ModulationFxControl::Active, 1.0f},
    }};
    if (!manual.processBlock(0, centered.data(), 256, centerEvents.data(), 2)) return false;
    std::array<StereoFrame, 256> left{};
    left.fill({0.2f, -0.1f});
    const ModulationFxEvent leftEvent{0, ModulationFxControl::Pan, -1.0f};
    if (!manual.processBlock(256, left.data(), 256, &leftEvent, 1)) return false;
    for (std::uint32_t start = 512; start < 3328; start += 256) {
        left.fill({0.2f, -0.1f});
        if (!manual.processBlock(start, left.data(), 256)) return false;
    }
    if (!check(std::fabs(centered.back().left - 0.2f) < 2.0e-4f &&
               std::fabs(centered.back().right + 0.1f) < 2.0e-4f,
               "manual center pan preserves independent stereo channels at unity") ||
        !check(std::fabs(left.back().left - 0.1f) < 2.0e-4f &&
               std::fabs(left.back().right) < 1.0e-5f,
               "hard-left stereo panning sums L and R into the left output")) return false;

    std::array<StereoFrame, 256> right{};
    right.fill({0.2f, -0.1f});
    const ModulationFxEvent rightEvent{0, ModulationFxControl::Pan, 1.0f};
    if (!manual.processBlock(3328, right.data(), 256, &rightEvent, 1)) return false;
    for (std::uint32_t start = 3584; start < 6656; start += 256) {
        right.fill({0.2f, -0.1f});
        if (!manual.processBlock(start, right.data(), 256)) return false;
    }
    if (!check(std::fabs(right.back().left) < 1.0e-5f &&
               std::fabs(right.back().right - 0.1f) < 2.0e-4f,
               "hard-right stereo panning sums L and R into the right output")) return false;

    AutoPan automatic;
    if (!automatic.prepare(spec(64))) return false;
    const std::array<ModulationFxEvent, 3> autoEvents{{
        {0, ModulationFxControl::RateHz, 1.0f},
        {0, ModulationFxControl::Depth, 1.0f},
        {0, ModulationFxControl::Active, 1.0f},
    }};
    float minLeft = 1.0f, maxLeft = 0.0f, minRight = 1.0f, maxRight = 0.0f;
    for (std::uint32_t start = 0; start < 48000; start += 64) {
        std::array<StereoFrame, 64> signal{};
        signal.fill({0.5f, 0.25f});
        if (!automatic.processBlock(start, signal.data(), 64,
                                    start == 0 ? autoEvents.data() : nullptr,
                                    start == 0 ? 3U : 0U)) return false;
        for (const auto& frame : signal) {
            minLeft = std::min(minLeft, std::fabs(frame.left));
            maxLeft = std::max(maxLeft, std::fabs(frame.left));
            minRight = std::min(minRight, std::fabs(frame.right));
            maxRight = std::max(maxRight, std::fabs(frame.right));
        }
    }
    return check(minLeft < 0.01f && maxLeft > 0.45f && minRight < 0.01f && maxRight > 0.22f,
                 "autopan moves both independent stereo sides through a full LFO cycle");
}

bool testLoFiHoldAndTremoloEnvelope() {
    LoFi lofi;
    if (!lofi.prepare(spec(64))) return false;
    const std::array<ModulationFxEvent, 5> loFiEvents{{
        {0, ModulationFxControl::BitDepth, 4.0f},
        {0, ModulationFxControl::HoldFrames, 4.0f},
        {0, ModulationFxControl::Dither, 0.0f},
        {0, ModulationFxControl::Active, 1.0f},
        {0, ModulationFxControl::Wet, 1.0f},
    }};
    std::array<StereoFrame, 64> warm{};
    for (std::uint32_t start = 0; start < 4096; start += 64) {
        warm.fill({});
        if (!lofi.processBlock(start, warm.data(), 64,
                               start == 0 ? loFiEvents.data() : nullptr,
                               start == 0 ? 5U : 0U)) return false;
    }
    std::array<StereoFrame, 64> ramp{};
    for (std::uint32_t i = 0; i < ramp.size(); ++i)
        ramp[i] = {static_cast<float>(i) / 64.0f, -static_cast<float>(i) / 64.0f};
    const ModulationFxEvent restartHold{0, ModulationFxControl::HoldFrames, 4.0f};
    if (!lofi.processBlock(4096, ramp.data(), 64, &restartHold, 1)) return false;
    for (std::uint32_t group = 0; group < 16; ++group) {
        const auto start = group * 4;
        const auto maxWithinGroup = std::max({
            std::fabs(ramp[start].left - ramp[start + 1].left),
            std::fabs(ramp[start].left - ramp[start + 2].left),
            std::fabs(ramp[start].left - ramp[start + 3].left)});
        if (!check(maxWithinGroup < 1.0e-6f,
                   "lo-fi sample-and-hold repeats a four-frame sample independent of the dry path")) return false;
    }
    if (!check(std::fabs(ramp[0].left * 7.0f - std::round(ramp[0].left * 7.0f)) < 1.0e-6f,
               "lo-fi output uses the selected four-bit quantizer grid")) return false;

    Tremolo tremolo;
    if (!tremolo.prepare(spec(64))) return false;
    const std::array<ModulationFxEvent, 3> tremoloEvents{{
        {0, ModulationFxControl::RateHz, 4.0f},
        {0, ModulationFxControl::Depth, 1.0f},
        {0, ModulationFxControl::Active, 1.0f},
    }};
    double minimum = 1.0;
    double maximum = 0.0;
    for (std::uint32_t start = 0; start < 48000; start += 64) {
        std::array<StereoFrame, 64> signal{};
        signal.fill({0.5f, 0.5f});
        if (!tremolo.processBlock(start, signal.data(), 64,
                                  start == 0 ? tremoloEvents.data() : nullptr,
                                  start == 0 ? 3U : 0U)) return false;
        for (const auto& frame : signal) {
            minimum = std::min(minimum, static_cast<double>(frame.left));
            maximum = std::max(maximum, static_cast<double>(frame.left));
        }
    }
    return check(minimum < 0.01 && maximum > 0.48,
                 "full-depth tremolo reaches a real zero-to-unity amplitude envelope");
}

bool testNoAllocationAndMaximumEventBurst() {
    Tremolo tremolo;
    if (!tremolo.prepare(spec(64))) return false;
    std::array<ModulationFxEvent, 64> events{};
    for (std::uint32_t i = 0; i < events.size(); ++i) {
        events[i] = {0, (i & 1U) == 0U ? ModulationFxControl::RateHz : ModulationFxControl::Depth,
                     (i & 1U) == 0U ? 5.0f : 0.75f};
    }
    std::array<StereoFrame, 64> block{};
    for (std::uint32_t i = 0; i < block.size(); ++i) block[i] = source(i);
    gWatchedAllocations.store(0, std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    const auto processed = tremolo.processBlock(0, block.data(), 64, events.data(), 64);
    gWatchAllocations.store(false, std::memory_order_relaxed);
    return check(processed && gWatchedAllocations.load(std::memory_order_relaxed) == 0,
                 "64 sample-offset updates and callback processing allocate no heap memory");
}

} // namespace

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gWatchedAllocations.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc{};
}
void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gWatchedAllocations.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc{};
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    bool ok = true;
    ok = testValidationAndPrepareBounds() && ok;
    ok = testPanStereoBalanceAndAutoModulation() && ok;
    ok = testLoFiHoldAndTremoloEnvelope() && ok;
    ok = testNoAllocationAndMaximumEventBurst() && ok;
    ok = testBlockScheduleInvariant<LoFi>("LoFi is block-schedule invariant") && ok;
    ok = testBlockScheduleInvariant<StereoRingModulatorFx>("stereo ring modulator is block-schedule invariant") && ok;
    ok = testBlockScheduleInvariant<AutoPan>("AutoPan is block-schedule invariant") && ok;
    ok = testBlockScheduleInvariant<ManualPan>("ManualPan is block-schedule invariant") && ok;
    ok = testBlockScheduleInvariant<Tremolo>("Tremolo is block-schedule invariant") && ok;
    if (!ok) return 1;
    std::puts("PASS: modulation/lo-fi stereo processors, sample events, block invariance, and noalloc tests");
    return 0;
}
