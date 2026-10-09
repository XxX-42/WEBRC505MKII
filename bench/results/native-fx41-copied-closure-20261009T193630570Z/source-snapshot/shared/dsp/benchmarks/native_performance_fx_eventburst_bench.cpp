#include "webrc/dsp/performance_fx.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <ctime>
#include <vector>

namespace {

using namespace webrc::dsp;
using Clock = std::chrono::steady_clock;
constexpr std::uint32_t kFramesPerCallback = 64;
constexpr std::uint32_t kCallbacks = 20000;
constexpr std::uint32_t kSampleRate = 48000;
constexpr std::uint64_t kDeadlineNs = 1333333;
constexpr std::uint64_t kP99TargetNs = 800000;
constexpr std::uint64_t kP999TargetNs = 1066666;

std::uint64_t quantile(std::vector<std::uint64_t> values, double p) {
    std::sort(values.begin(), values.end());
    const auto rank = static_cast<std::size_t>(std::ceil(p * values.size()));
    return values[std::max<std::size_t>(1U, rank) - 1U];
}

void writeArray(const std::vector<std::uint64_t>& values) {
    std::putchar('[');
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i != 0) std::putchar(',');
        std::printf("%llu", static_cast<unsigned long long>(values[i]));
    }
    std::putchar(']');
}

bool renderWarmup(BeatRepeat& repeat, std::uint64_t& frame, std::uint64_t total) {
    std::array<StereoFrame, kFramesPerCallback> block{};
    const std::array<PerformanceFxEvent, 3> startEvents{{
        {0, PerformanceFxControl::TempoBpm, 20.0f},
        {0, PerformanceFxControl::SubdivisionBeats, 0.5f},
        {0, PerformanceFxControl::Active, 1.0f},
    }};
    while (frame < total) {
        for (std::uint32_t i = 0; i < block.size(); ++i) {
            const auto absolute = frame + i;
            const auto phase = static_cast<double>(absolute % kSampleRate) / kSampleRate;
            block[i] = {static_cast<float>(0.21 * std::sin(2.0 * 3.141592653589793 * 431.0 * phase)),
                        static_cast<float>(-0.13 * std::sin(2.0 * 3.141592653589793 * 587.0 * phase + 0.2))};
        }
        const bool start = frame == 100032U;
        if (!repeat.processBlock(frame, block.data(), kFramesPerCallback,
                                 start ? startEvents.data() : nullptr,
                                 start ? static_cast<std::uint32_t>(startEvents.size()) : 0U)) return false;
        frame += kFramesPerCallback;
    }
    return true;
}

std::array<PerformanceFxEvent, PerformanceFxProcessor::kMaximumControlEventsPerBlock>
makeEvents() {
    std::array<PerformanceFxEvent, PerformanceFxProcessor::kMaximumControlEventsPerBlock> events{};
    for (std::uint32_t i = 0; i < events.size(); ++i) {
        const auto group = i / 8U;
        switch (i % 8U) {
        case 0:
            events[i] = {i, PerformanceFxControl::Active, (group & 1U) == 0U ? 0.0f : 1.0f};
            break;
        case 1:
        case 5:
            events[i] = {i, PerformanceFxControl::TempoBpm,
                         (group & 1U) == 0U ? 300.0f : 20.0f};
            break;
        case 2:
        case 6:
            events[i] = {i, PerformanceFxControl::SubdivisionBeats,
                         (group & 1U) == 0U ? 0.125f : 0.5f};
            break;
        case 3:
        case 7:
            events[i] = {i, PerformanceFxControl::Feedback,
                         (group & 1U) == 0U ? 0.95f : 0.0f};
            break;
        case 4:
            events[i] = {i, PerformanceFxControl::Wet,
                         (group & 1U) == 0U ? 0.0f : 1.0f};
            break;
        }
    }
    return events;
}

} // namespace

int main() {
    BeatRepeat repeat;
    if (!repeat.prepare({static_cast<float>(kSampleRate), kFramesPerCallback, 2U})) {
        std::fputs("prepare failed\n", stderr);
        return 2;
    }
    std::uint64_t frame = 0;
    if (!renderWarmup(repeat, frame, 100032U) || !renderWarmup(repeat, frame, 172032U)) {
        std::fputs("warmup failed\n", stderr);
        return 3;
    }
    const auto events = makeEvents();
    std::array<StereoFrame, kFramesPerCallback> block{};
    std::vector<std::uint64_t> callbackNs;
    std::vector<std::uint64_t> timerPairNs;
    callbackNs.reserve(kCallbacks);
    timerPairNs.reserve(kCallbacks);
    std::uint32_t maximumCopiedFrames = 0;
    std::uint64_t processorFailures = 0;
    std::uint64_t totalCopiedFrames = 0;
    const auto timedWallBegin = Clock::now();
    const auto cpuStart = std::clock();
    for (std::uint32_t i = 0; i < kCallbacks; ++i) {
        for (std::uint32_t j = 0; j < block.size(); ++j) {
            const auto absolute = frame + j;
            const auto phase = static_cast<double>(absolute % kSampleRate) / kSampleRate;
            block[j] = {static_cast<float>(0.21 * std::sin(2.0 * 3.141592653589793 * 431.0 * phase)),
                        static_cast<float>(-0.13 * std::sin(2.0 * 3.141592653589793 * 587.0 * phase + 0.2))};
        }
        const auto begin = Clock::now();
        const bool processed = repeat.processBlock(frame, block.data(), kFramesPerCallback,
                                                    events.data(), static_cast<std::uint32_t>(events.size()));
        const auto end = Clock::now();
        callbackNs.push_back(static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(end - begin).count()));
        if (!processed) ++processorFailures;
        const auto copied = repeat.repeatCaptureFramesCopiedLastBlock();
        maximumCopiedFrames = std::max(maximumCopiedFrames, copied);
        totalCopiedFrames += copied;
        frame += kFramesPerCallback;
    }
    const auto cpuEnd = std::clock();
    const auto timedWallEnd = Clock::now();
    for (std::uint32_t i = 0; i < kCallbacks; ++i) {
        const auto begin = Clock::now();
        const auto end = Clock::now();
        timerPairNs.push_back(static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(end - begin).count()));
    }
    const auto p99 = quantile(callbackNs, 0.99);
    const auto p999 = quantile(callbackNs, 0.999);
    const auto maximum = *std::max_element(callbackNs.begin(), callbackNs.end());
    const auto over60 = std::count_if(callbackNs.begin(), callbackNs.end(),
        [](std::uint64_t value) { return value > kP99TargetNs; });
    const auto over80 = std::count_if(callbackNs.begin(), callbackNs.end(),
        [](std::uint64_t value) { return value > kP999TargetNs; });
    const auto over100 = std::count_if(callbackNs.begin(), callbackNs.end(),
        [](std::uint64_t value) { return value > kDeadlineNs; });
    const auto timerP50 = quantile(timerPairNs, 0.50);
    const auto timerP99 = quantile(timerPairNs, 0.99);
    const auto timerMax = *std::max_element(timerPairNs.begin(), timerPairNs.end());
    const auto timedWallNs = std::chrono::duration_cast<std::chrono::nanoseconds>(
        timedWallEnd - timedWallBegin).count();

    std::printf("{\n\"schemaVersion\":\"webrc-performance-fx-eventburst-v1\",\n");
    std::printf("\"scenario\":\"BeatRepeat active, 64 ordered mixed control events, 64-frame callback\",\n");
    std::printf("\"sampleRate\":%u,\"blockFrames\":%u,\"callbackCount\":%u,\n",
                kSampleRate, kFramesPerCallback, kCallbacks);
    std::printf("\"deadlineBudgetNs\":%llu,\"over60TargetNs\":%llu,\"over80TargetNs\":%llu,\n",
                static_cast<unsigned long long>(kDeadlineNs),
                static_cast<unsigned long long>(kP99TargetNs),
                static_cast<unsigned long long>(kP999TargetNs));
    std::printf("\"eventCountPerCallback\":64,\"eventsPerSample\":1,\"eventKinds\":[\"Active\",\"TempoBpm\",\"SubdivisionBeats\",\"Feedback\",\"Wet\"],\n");
    std::printf("\"processorFailures\":%llu,\"maximumRepeatFramesCopiedPerCallback\":%u,\"totalRepeatFramesCopied\":%llu,\n",
                static_cast<unsigned long long>(processorFailures), maximumCopiedFrames,
                static_cast<unsigned long long>(totalCopiedFrames));
    std::printf("\"timedLoopWallNs\":%llu,\"timedLoopProcessCpuTicks\":%lld,\"clockTicksPerSecond\":%lld,\n",
                static_cast<unsigned long long>(timedWallNs),
                static_cast<long long>(cpuEnd - cpuStart), static_cast<long long>(CLOCKS_PER_SEC));
    std::printf("\"wallTimingSummary\":{\"p50Ns\":%llu,\"p99Ns\":%llu,\"p999Ns\":%llu,\"maxNs\":%llu,\"over60PercentBudget\":%llu,\"over80PercentBudget\":%llu,\"over100PercentBudget\":%llu},\n",
                static_cast<unsigned long long>(quantile(callbackNs, 0.50)),
                static_cast<unsigned long long>(p99), static_cast<unsigned long long>(p999),
                static_cast<unsigned long long>(maximum), static_cast<unsigned long long>(over60),
                static_cast<unsigned long long>(over80), static_cast<unsigned long long>(over100));
    std::printf("\"steadyClockPairOnlyNs\":{\"p50Ns\":%llu,\"p99Ns\":%llu,\"maxNs\":%llu,\"rawChronologicalNs\":",
                static_cast<unsigned long long>(timerP50), static_cast<unsigned long long>(timerP99),
                static_cast<unsigned long long>(timerMax));
    writeArray(timerPairNs);
    std::printf("},\n\"rawChronologicalCallbackWallNs\":");
    writeArray(callbackNs);
    std::printf("\n}\n");
    return processorFailures == 0U && maximumCopiedFrames <= kFramesPerCallback ? 0 : 4;
}
