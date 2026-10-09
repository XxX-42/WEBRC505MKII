#include "webrc/dsp/modulated_delay_fx.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace {

using namespace webrc::dsp;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::uint32_t kFrames = 64U;
constexpr std::uint32_t kWarmupBlocks = 2500U;
constexpr std::uint32_t kMeasuredBlocks = 10000U;

struct BenchCase {
    const char* name;
    ModulatedDelayKind kind;
};

constexpr std::array<BenchCase, 5> kCases{{
    {"flanger", ModulatedDelayKind::Flanger},
    {"chorus", ModulatedDelayKind::Chorus},
    {"vibrato", ModulatedDelayKind::Vibrato},
    {"mod_delay", ModulatedDelayKind::ModDelay},
    {"panning_delay", ModulatedDelayKind::PanningDelay},
}};

StereoFrame source(std::uint64_t frame) noexcept {
    const double time = static_cast<double>(frame) / 48000.0;
    return {
        0.25f * static_cast<float>(std::sin(2.0 * kPi * 211.0 * time)) +
            0.08f * static_cast<float>(std::sin(2.0 * kPi * 61.0 * time)),
        0.18f * static_cast<float>(std::sin(2.0 * kPi * 307.0 * time + 0.3)) +
            0.06f * static_cast<float>(std::sin(2.0 * kPi * 97.0 * time)),
    };
}

std::uint64_t percentile(const std::vector<std::uint64_t>& sorted, double p) {
    if (sorted.empty()) return 0U;
    const auto index = static_cast<std::size_t>(std::ceil(p * sorted.size()) - 1.0);
    return sorted[std::min(index, sorted.size() - 1U)];
}

bool runCase(const BenchCase& bench, bool maxEvents) {
    ModulatedDelayFx processor;
    const ProcessSpec processSpec{48000.0f, kFrames, 2U};
    if (!processor.prepare(processSpec, bench.kind)) return false;
    std::array<StereoFrame, kFrames> block{};
    for (std::uint32_t i = 0; i < kFrames; ++i) block[i] = source(i);
    std::array<ModulatedDelayEvent, ModulatedDelayFx::kMaximumControlEventsPerBlock> events{};
    for (std::uint32_t i = 0; i < events.size(); ++i) {
        events[i] = {i, ModulatedDelayControl::Wet, (i & 1U) ? 0.35f : 0.68f};
    }

    std::uint64_t frame = 0U;
    for (std::uint32_t i = 0; i < kWarmupBlocks; ++i) {
        for (std::uint32_t j = 0; j < kFrames; ++j) block[j] = source(frame + j);
        const auto eventCount = maxEvents ? static_cast<std::uint32_t>(events.size()) : 0U;
        if (!processor.processBlock(frame, block.data(), kFrames,
                eventCount ? events.data() : nullptr, eventCount)) return false;
        frame += kFrames;
    }

    std::vector<std::uint64_t> rawNanoseconds(kMeasuredBlocks);
    for (std::uint32_t i = 0; i < kMeasuredBlocks; ++i) {
        for (std::uint32_t j = 0; j < kFrames; ++j) block[j] = source(frame + j);
        const auto eventCount = maxEvents ? static_cast<std::uint32_t>(events.size()) : 0U;
        const auto begin = std::chrono::steady_clock::now();
        const bool valid = processor.processBlock(frame, block.data(), kFrames,
            eventCount ? events.data() : nullptr, eventCount);
        const auto end = std::chrono::steady_clock::now();
        if (!valid) return false;
        for (const auto& sample : block) {
            if (!std::isfinite(sample.left) || !std::isfinite(sample.right) ||
                std::fabs(sample.left) > 8.0f || std::fabs(sample.right) > 8.0f) return false;
        }
        rawNanoseconds[i] = static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(end - begin).count());
        frame += kFrames;
    }
    std::vector<std::uint64_t> sorted = rawNanoseconds;
    std::sort(sorted.begin(), sorted.end());
    constexpr std::uint64_t deadlineNs = 1000000000ULL * kFrames / 48000U;
    constexpr std::uint64_t target60Ns = deadlineNs * 60U / 100U;
    constexpr std::uint64_t target80Ns = deadlineNs * 80U / 100U;
    std::uint32_t over60 = 0U, over80 = 0U, over100 = 0U;
    for (const auto sample : rawNanoseconds) {
        if (sample > target60Ns) ++over60;
        if (sample > target80Ns) ++over80;
        if (sample > deadlineNs) ++over100;
    }

    std::printf("    {\"kind\":\"%s\",\"ordinal\":%u,\"scenario\":\"%s\","
                "\"warmupBlocks\":%u,\"measuredBlocks\":%u,\"framesPerBlock\":%u,"
                "\"deadlineNs\":%llu,\"target60Ns\":%llu,\"target80Ns\":%llu,"
                "\"p50Ns\":%llu,\"p95Ns\":%llu,\"p99Ns\":%llu,\"p999Ns\":%llu,"
                "\"maxNs\":%llu,\"over60\":%u,\"over80\":%u,\"over100\":%u,"
                "\"rawCallbackNsChronological\":[",
                bench.name, ModulatedDelayFx::effectOrdinal(bench.kind),
                maxEvents ? "64_events" : "ordinary", kWarmupBlocks, kMeasuredBlocks,
                kFrames, static_cast<unsigned long long>(deadlineNs),
                static_cast<unsigned long long>(target60Ns),
                static_cast<unsigned long long>(target80Ns),
                static_cast<unsigned long long>(percentile(sorted, 0.50)),
                static_cast<unsigned long long>(percentile(sorted, 0.95)),
                static_cast<unsigned long long>(percentile(sorted, 0.99)),
                static_cast<unsigned long long>(percentile(sorted, 0.999)),
                static_cast<unsigned long long>(sorted.back()), over60, over80, over100);
    for (std::size_t i = 0; i < rawNanoseconds.size(); ++i) {
        if (i != 0U) std::putchar(',');
        std::printf("%llu", static_cast<unsigned long long>(rawNanoseconds[i]));
    }
    std::puts("]}");
    return true;
}

} // namespace

int main() {
    std::puts("{\"schemaVersion\":1,\"sampleRate\":48000,\"framesPerBlock\":64,"
              "\"note\":\"Standalone kernel timings only; not product callback or Gate evidence.\","
              "\"cases\":[");
    bool first = true;
    for (const auto& item : kCases) {
        for (const bool maximumEvents : {false, true}) {
            if (!first) std::putchar(',');
            first = false;
            if (!runCase(item, maximumEvents)) return 2;
        }
    }
    std::puts("]}");
    return 0;
}
