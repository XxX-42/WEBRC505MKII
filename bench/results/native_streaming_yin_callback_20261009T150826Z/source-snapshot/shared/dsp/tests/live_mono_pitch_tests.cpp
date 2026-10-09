#include "webrc/dsp/live_mono_pitch.hpp"

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
    constexpr float sampleRate = 48000.0f;
    constexpr std::uint32_t inputFrames = 96000U;
    const LiveMonoPitchSettings settings{
        ProcessSpec{sampleRate, 256U, 1U}, 4096U, 512U, 32768U,
        40.0f, 1000.0f, 0.15f};
    check(LiveMonoPitchRoute::requiredPrepareBytes(settings) > sizeof(LiveMonoPitchRoute),
          "LIVE_MONO preflight includes incremental detector, PSOLA, and inline object state");
    check(LiveMonoPitchRoute::requiredPrepareBytes(LiveMonoPitchSettings{
              ProcessSpec{sampleRate,256U,2U},4096U,512U,32768U,40.0f,1000.0f,0.15f}) == 0U,
          "LIVE_MONO rejects a stereo analysis spec rather than guessing a downmix");

    LiveMonoPitchRoute route;
    check(route.prepare(settings), "LIVE_MONO prepares bounded YIN plus streaming TD-PSOLA");
    check(route.resynthesisLatencySamples() == 3U * 1200U &&
          route.declaredDetectorPlusResynthesisLatencySamples() == 7696U,
          "LIVE_MONO reports 4096-frame detector window and 3600-frame resynthesis lookahead separately");
    check(route.setPitchRatio(1.5f) && !route.setPitchRatio(std::numeric_limits<float>::infinity()) &&
          !route.setPitchRatio(2.1f),
          "LIVE_MONO accepts only finite, bounded pitch ratios");

    std::vector<float> input(inputFrames);
    std::vector<float> output(inputFrames);
    double phase55 = 0.0;
    for (std::uint32_t i = 0U; i < inputFrames; ++i) {
        phase55 += 2.0 * 3.14159265358979323846 * 55.0 / sampleRate;
        input[i] = 0.24f * static_cast<float>(std::sin(phase55));
    }

    constexpr std::array<std::uint32_t,6> partitions{{64U,128U,256U,64U,256U,128U}};
    std::size_t partitionIndex = 0U;
    std::uint32_t offset = 0U;
    std::uint32_t maxAnalysisWork = 0U;
    bool processed = true;
    allocationCount.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    while (offset < inputFrames) {
        const auto frames = std::min(partitions[partitionIndex++ % partitions.size()], inputFrames - offset);
        processed = route.processBlock(input.data() + offset, output.data() + offset, frames) && processed;
        maxAnalysisWork = std::max(maxAnalysisWork, route.lastAnalysisWorkUnits());
        offset += frames;
    }
    countAllocations.store(false, std::memory_order_release);

    check(processed && allocationCount.load(std::memory_order_relaxed) == 0U,
          "LIVE_MONO detector-to-renderer streaming route processes variable callbacks without allocation");
    check(route.analysisCount() > 100U && maxAnalysisWork <= settings.analysisWorkUnitsPerCallback,
          "LIVE_MONO publishes repeated estimates under its fixed analysis-work budget");
    check(route.latestEstimate().voiced && std::fabs(route.latestEstimate().frequencyHz - 55.0f) < 0.8f,
          "LIVE_MONO tracks a 55Hz fundamental during continuous streaming");
    check(route.estimateWindowEndFrame() <= route.inputFrames() &&
          route.latestEstimateAgeFrames() <= 2048U,
          "LIVE_MONO exposes capture frame and bounded estimate age independently from declared latency");

    YinPitchDetector outputReference;
    check(outputReference.prepare(settings.spec,8192U,60.0f,500.0f),
          "output reference prepares to verify the actual streaming resynthesis path");
    PitchEstimate outputEstimate{};
    constexpr std::uint32_t outputWindow = 8192U;
    const auto outputStart = inputFrames - outputWindow;
    check(outputReference.analyze(output.data() + outputStart,outputWindow,outputEstimate) &&
          outputEstimate.voiced && std::fabs(outputEstimate.frequencyHz - 82.5f) < 5.0f,
          "LIVE_MONO output contains the requested 1.5x low-F0 pitch-shifted signal");

    std::array<float,256> sentinel{};
    sentinel.fill(-99.0f);
    check(!route.processBlock(input.data(),sentinel.data(),257U) && sentinel[0] == -99.0f,
          "LIVE_MONO rejects an oversized callback before touching caller output");

    if (failures != 0) {
        std::fprintf(stderr, "LIVE_MONO route tests failed: %d\n", failures);
        return 1;
    }
    std::printf("LIVE_MONO route tests passed; analyses=%llu, maxAnalysisWork=%u/%u, estimateAge=%u, outputPitch=%.3fHz.\n",
        static_cast<unsigned long long>(route.analysisCount()),maxAnalysisWork,
        settings.analysisWorkUnitsPerCallback,route.latestEstimateAgeFrames(),outputEstimate.frequencyHz);
    return 0;
}
