#include "webrc/dsp/streaming_yin.hpp"
#include "webrc/dsp/pitch.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <vector>

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<unsigned> allocationCount{0};
int failures = 0;
void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}
}

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
    constexpr float rate = 48000.0f;
    constexpr std::uint32_t window = 4096U;
    constexpr float minimumHz = 40.0f;
    constexpr float maximumHz = 1000.0f;
    constexpr std::uint32_t workBudget = 32768U;
    const ProcessSpec spec{rate, 256U, 1U};

    check(IncrementalYinDetector::requiredPrepareBytes(spec, window, minimumHz, maximumHz,
                                                        workBudget) > 0U,
          "incremental YIN reports a bounded preflight storage requirement");
    check(IncrementalYinDetector::requiredPrepareBytes(spec, window, minimumHz, maximumHz, 0U) == 0U &&
          IncrementalYinDetector::requiredPrepareBytes(spec, window, minimumHz, maximumHz,
                                                        window - 1U) == 0U &&
          IncrementalYinDetector::requiredPrepareBytes(ProcessSpec{rate,64U,2U}, window,
                                                        minimumHz, maximumHz, workBudget) == 0U,
          "incremental YIN rejects undersized work budgets and non-mono analysis specs");

    IncrementalYinDetector detector;
    YinPitchDetector reference;
    check(detector.prepare(spec, window, minimumHz, maximumHz, 0.15f, 512U, workBudget),
          "incremental YIN prepares its bounded 4096-frame low-F0 route");
    check(reference.prepare(spec, window, minimumHz, maximumHz),
          "fixed-frame reference YIN prepares with the same window and lag range");
    if (!detector.prepared() || detector.windowFrames() != window ||
        detector.workUnitsPerBlock() != workBudget) {
        if (failures != 0) return 1;
        return 1;
    }

    constexpr std::uint32_t inputFrames = 48000U;
    std::vector<float> input(inputFrames);
    double phase55 = 0.0;
    double phase110 = 0.0;
    double phase997 = 0.0;
    for (std::uint32_t i = 0U; i < inputFrames; ++i) {
        phase55 += 2.0 * 3.14159265358979323846 * 55.0 / rate;
        phase110 += 2.0 * 3.14159265358979323846 * 110.0 / rate;
        phase997 += 2.0 * 3.14159265358979323846 * 997.0 / rate;
        input[i] = 0.24f * static_cast<float>(std::sin(phase55)) +
                   0.07f * static_cast<float>(std::sin(phase110)) +
                   0.035f * static_cast<float>(std::sin(phase997));
    }

    const std::uint32_t partitions[] = {64U,128U,256U,64U,256U,128U};
    std::uint32_t inputOffset = 0U;
    std::uint32_t maxObservedWork = 0U;
    bool processed = true;
    allocationCount.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    std::size_t partitionIndex = 0U;
    while (inputOffset < inputFrames) {
        const auto frames = std::min(partitions[partitionIndex++ % 6U], inputFrames - inputOffset);
        processed = processed && detector.processBlock(input.data() + inputOffset, frames);
        inputOffset += frames;
        maxObservedWork = std::max(maxObservedWork, detector.lastWorkUnits());
        if (detector.lastWorkUnits() > workBudget) processed = false;
    }
    countAllocations.store(false, std::memory_order_release);
    check(processed, "variable-size streaming input blocks process successfully");
    check(allocationCount.load(std::memory_order_relaxed) == 0U,
          "incremental analysis performs no allocation throughout continuous processing");
    check(detector.analysisCount() >= 8U,
          "incremental analysis publishes repeated estimates rather than only one setup result");
    check(maxObservedWork <= workBudget && detector.lastWorkUnits() <= workBudget,
          "every callback stays within the prepared YIN work-unit ceiling");

    const auto endFrame = detector.latestWindowEndFrame();
    check(endFrame >= window && endFrame <= inputFrames,
          "latest estimate identifies the exact sample-clock window that produced it");
    std::vector<float> capturedWindow(window);
    const auto startFrame = static_cast<std::size_t>(endFrame - window);
    std::copy_n(input.data() + startFrame, window, capturedWindow.data());
    PitchEstimate expected{};
    check(reference.analyze(capturedWindow.data(), window, expected),
          "fixed-frame reference analyzes the incremental detector's exact captured window");
    const auto actual = detector.latestEstimate();
    check(actual.voiced && expected.voiced && std::fabs(actual.frequencyHz - 55.0f) < 0.8f,
          "low F0 remains tracked with a strong second harmonic and upper partial");
    check(std::fabs(actual.frequencyHz - expected.frequencyHz) < 0.03f &&
          std::fabs(actual.periodSamples - expected.periodSamples) < 0.03f &&
          std::fabs(actual.confidence - expected.confidence) < 2.0e-4f &&
          std::fabs(actual.rms - expected.rms) < 2.0e-5f,
          "incremental FFT/YIN matches the fixed-frame reference on the identical PCM window");
    check(detector.latestProcessingLagFrames() <= 2048U,
          "analysis processing lag is reported separately and stays bounded in this 64/128/256-frame run");

    detector.reset();
    std::array<float,256> silence{};
    bool silenceProcessed = true;
    for (int block = 0; block < 24; ++block)
        silenceProcessed = silenceProcessed && detector.processBlock(silence.data(), 256U);
    check(silenceProcessed && detector.analysisCount() > 0U &&
          !detector.latestEstimate().voiced && detector.latestEstimate().frequencyHz == 0.0f,
          "silence remains unvoiced after the incremental window and work queue settle");

    if (failures != 0) {
        std::fprintf(stderr, "Streaming YIN tests failed: %d\n", failures);
        return 1;
    }
    std::printf("Streaming YIN tests passed; max-work=%u/%u, analyses=%llu, processing-lag=%u frames.\n",
                maxObservedWork, workBudget,
                static_cast<unsigned long long>(detector.analysisCount()),
                detector.latestProcessingLagFrames());
    return 0;
}
