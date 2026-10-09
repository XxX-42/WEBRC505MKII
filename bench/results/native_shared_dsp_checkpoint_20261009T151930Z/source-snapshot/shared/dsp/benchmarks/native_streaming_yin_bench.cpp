#include "webrc/dsp/streaming_yin.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<std::uint64_t> allocationCount{0};
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::uint32_t kRate = 48000U;
constexpr std::uint32_t kBlock = 64U;
constexpr std::uint32_t kBlocks = 20000U;
constexpr std::uint32_t kWindow = 4096U;
constexpr std::uint32_t kWorkBudget = 32768U;
constexpr std::uint64_t kHardDeadlineNs = 1'333'333ULL;
constexpr std::uint64_t kTargetDeadlineNs = 1'066'667ULL;

struct Sample {
    std::uint64_t ns = 0U;
    std::uint32_t workUnits = 0U;
    std::uint64_t analysisCount = 0U;
    std::uint32_t processingLagFrames = 0U;
    bool busy = false;
    bool sectionSteady = false;
};

std::uint64_t percentile(std::vector<std::uint64_t> values, double p) {
    if (values.empty()) return 0U;
    std::sort(values.begin(), values.end());
    const auto rank = static_cast<std::size_t>(std::ceil(p * static_cast<double>(values.size())));
    return values[std::min(values.size() - 1U, rank == 0U ? 0U : rank - 1U)];
}

void emitStats(const char* name, const std::vector<std::uint64_t>& values) {
    if (values.empty()) {
        std::printf("\"%s\":{\"samples\":0}", name);
        return;
    }
    std::uint64_t maximum = 0U;
    std::uint64_t overTarget = 0U;
    std::uint64_t overHard = 0U;
    for (const auto value : values) {
        maximum = std::max(maximum, value);
        overTarget += value > kTargetDeadlineNs ? 1U : 0U;
        overHard += value > kHardDeadlineNs ? 1U : 0U;
    }
    std::printf("\"%s\":{\"samples\":%zu,\"p50Ns\":%llu,\"p95Ns\":%llu,\"p99Ns\":%llu,\"p999Ns\":%llu,\"maxNs\":%llu,\"over80PercentDeadline\":%llu,\"overHardDeadline\":%llu}",
        name, values.size(),
        static_cast<unsigned long long>(percentile(values, 0.50)),
        static_cast<unsigned long long>(percentile(values, 0.95)),
        static_cast<unsigned long long>(percentile(values, 0.99)),
        static_cast<unsigned long long>(percentile(values, 0.999)),
        static_cast<unsigned long long>(maximum),
        static_cast<unsigned long long>(overTarget),
        static_cast<unsigned long long>(overHard));
}
} // namespace

void* operator new(std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    using namespace webrc::dsp;
    const ProcessSpec spec{static_cast<float>(kRate), kBlock, 1U};
    IncrementalYinDetector detector;
    if (!detector.prepare(spec, kWindow, 40.0f, 1000.0f, 0.15f, 512U, kWorkBudget)) {
        std::fprintf(stderr, "IncrementalYinDetector prepare failed\n");
        return 2;
    }

    std::array<float, kBlock> input{};
    std::vector<Sample> samples(kBlocks);
    std::vector<std::uint64_t> startupNs;
    std::vector<std::uint64_t> steadyNs;
    startupNs.reserve(kBlocks);
    steadyNs.reserve(kBlocks);
    double phase55 = 0.0;
    double phase110 = 0.0;
    double phase997 = 0.0;
    std::uint64_t frames = 0U;
    std::uint64_t nonFiniteInput = 0U;
    float inputPeak = 0.0f;
    std::uint64_t firstEstimateBlock = kBlocks;
    bool finiteOutput = true;
    allocationCount.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    for (std::uint32_t block = 0U; block < kBlocks; ++block) {
        for (std::uint32_t i = 0U; i < kBlock; ++i) {
            phase55 += 2.0 * kPi * 55.0 / kRate;
            phase110 += 2.0 * kPi * 110.0 / kRate;
            phase997 += 2.0 * kPi * 997.0 / kRate;
            input[i] = 0.24f * static_cast<float>(std::sin(phase55)) +
                       0.07f * static_cast<float>(std::sin(phase110)) +
                       0.035f * static_cast<float>(std::sin(phase997));
            nonFiniteInput += std::isfinite(input[i]) ? 0U : 1U;
            if (std::isfinite(input[i])) inputPeak = std::max(inputPeak, std::abs(input[i]));
        }
        const auto start = std::chrono::steady_clock::now();
        const bool ok = detector.processBlock(input.data(), kBlock);
        const auto stop = std::chrono::steady_clock::now();
        if (!ok) {
            countAllocations.store(false, std::memory_order_release);
            std::fprintf(stderr, "processBlock rejected block %u\n", block);
            return 3;
        }
        const auto ns = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start).count());
        const auto estimate = detector.latestEstimate();
        finiteOutput = finiteOutput && std::isfinite(estimate.frequencyHz) &&
                       std::isfinite(estimate.periodSamples) && std::isfinite(estimate.rms) &&
                       std::isfinite(estimate.confidence);
        frames += kBlock;
        auto& sample = samples[block];
        sample.ns = ns;
        sample.workUnits = detector.lastWorkUnits();
        sample.analysisCount = detector.analysisCount();
        sample.processingLagFrames = detector.latestProcessingLagFrames();
        sample.busy = detector.analysisBusy();
        sample.sectionSteady = detector.analysisCount() != 0U;
        if (detector.analysisCount() != 0U && firstEstimateBlock == kBlocks)
            firstEstimateBlock = block;
        (sample.sectionSteady ? steadyNs : startupNs).push_back(ns);
    }
    countAllocations.store(false, std::memory_order_release);

    std::uint32_t badWork = 0U;
    for (const auto& sample : samples) {
        badWork += sample.workUnits > kWorkBudget ? 1U : 0U;
    }
    if (!finiteOutput || detector.analysisCount() == 0U || badWork != 0U || allocationCount.load() != 0U ||
        nonFiniteInput != 0U || inputPeak > 0.345001f) {
        std::fprintf(stderr, "invalid evidence: finite=%d analyses=%llu badWork=%u allocs=%llu nonfiniteInput=%llu inputPeak=%.9g\n",
            finiteOutput ? 1 : 0, static_cast<unsigned long long>(detector.analysisCount()), badWork,
            static_cast<unsigned long long>(allocationCount.load()),
            static_cast<unsigned long long>(nonFiniteInput), inputPeak);
        return 4;
    }

    std::vector<std::uint64_t> allNs;
    allNs.reserve(kBlocks);
    for (const auto& sample : samples) allNs.push_back(sample.ns);
    const auto estimate = detector.latestEstimate();
    std::printf("{\"schema\":\"native-streaming-yin-callback-bench-v1\",\"module\":\"F10_IncrementalYinDetector\",\"scope\":\"single processBlock callback; software-only CPU timing, not complete graph or device XRUN qualification\",\"sampleRateHz\":%u,\"callbackFrames\":%u,\"windowFrames\":%u,\"hopFrames\":512,\"analysisWorkBudgetPerCallback\":%u,\"callbacks\":%u,\"inputFrames\":%llu,\"inputRecipe\":\"0.24*sin(55Hz)+0.07*sin(110Hz)+0.035*sin(997Hz), phase-continuous across 64-frame calls\",\"inputPeak\":%.9g,\"deadlineNs\":%llu,\"target80PercentDeadlineNs\":%llu,\"firstEstimateBlock\":%llu,\"analysisCount\":%llu,\"latestEstimate\":{\"voiced\":%s,\"frequencyHz\":%.9g,\"periodSamples\":%.9g,\"confidence\":%.9g,\"rms\":%.9g,\"windowEndFrame\":%llu,\"processingLagFrames\":%u},\"finiteOutput\":%s,\"processAllocations\":%llu,\"badAnalysisWorkCallbacks\":%u,\"nonFiniteInputSamples\":%llu,",
        kRate, kBlock, kWindow, kWorkBudget, kBlocks,
        static_cast<unsigned long long>(frames),
        inputPeak,
        static_cast<unsigned long long>(kHardDeadlineNs),
        static_cast<unsigned long long>(kTargetDeadlineNs),
        static_cast<unsigned long long>(firstEstimateBlock),
        static_cast<unsigned long long>(detector.analysisCount()),
        estimate.voiced ? "true" : "false", estimate.frequencyHz,
        estimate.periodSamples, estimate.confidence, estimate.rms,
        static_cast<unsigned long long>(detector.latestWindowEndFrame()),
        detector.latestProcessingLagFrames(), finiteOutput ? "true" : "false",
        static_cast<unsigned long long>(allocationCount.load()), badWork,
        static_cast<unsigned long long>(nonFiniteInput));
    emitStats("all", allNs);
    std::printf(",");
    emitStats("startup", startupNs);
    std::printf(",");
    emitStats("steady", steadyNs);
    std::printf(",\"rawCallbacks\":[");
    for (std::size_t i = 0U; i < samples.size(); ++i) {
        if (i != 0U) std::printf(",");
        const auto& s = samples[i];
        std::printf("{\"block\":%zu,\"ns\":%llu,\"analysisWorkUnits\":%u,\"analysisCount\":%llu,\"busy\":%s,\"processingLagFrames\":%u,\"section\":\"%s\"}",
            i, static_cast<unsigned long long>(s.ns), s.workUnits,
            static_cast<unsigned long long>(s.analysisCount), s.busy ? "true" : "false",
            s.processingLagFrames, s.sectionSteady ? "steady" : "startup");
    }
    std::printf("]}\n");
    return 0;
}
