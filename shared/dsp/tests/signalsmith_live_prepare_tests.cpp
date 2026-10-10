#include "webrc/dsp/signalsmith_adapter.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

using namespace webrc::dsp;

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<unsigned> allocationCount{0U};
unsigned failures = 0U;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}

bool runLiveStateCase(std::uint32_t channels, std::uint32_t blockFrames) {
    const ProcessSpec spec{48000.0f, blockFrames, channels};
    const auto seed = 0x505243U;
    SignalsmithStretchSettings settings{
        channels == 1U ? PitchQualityMode::LiveMono : PitchQualityMode::LivePoly,
        channels, 4096U, 512U, false, seed};
    const auto liveBytes = SignalsmithStretchAdapter::requiredLivePrepareBytes(spec, settings);
    const auto offlineBytes = SignalsmithStretchAdapter::requiredPrepareBytes(spec, settings);
    if (liveBytes == 0U || offlineBytes <= liveBytes) return false;

    SignalsmithStretchAdapter tested(seed), reference(seed);
    if (!tested.prepareLive(spec, settings, liveBytes) ||
        !reference.prepareLive(spec, settings, liveBytes)) return false;
    const auto oldBytes = liveBytes;

    SignalsmithStretchSettings replacement = settings;
    replacement.blockSamples = 8192U;
    replacement.intervalSamples = 1024U;
    const auto replacementBytes = SignalsmithStretchAdapter::requiredLivePrepareBytes(
        spec, replacement);
    if (replacementBytes == 0U || oldBytes > static_cast<std::size_t>(-1) - replacementBytes)
        return false;
    const auto rejectingPeak = oldBytes + replacementBytes - 1U;

    std::array<std::array<float, 1024U>, 2U> input{};
    std::array<std::array<float, 1024U>, 2U> testedOutput{};
    std::array<std::array<float, 1024U>, 2U> referenceOutput{};
    std::array<const float*, 2U> inputPointers{};
    std::array<float*, 2U> testedPointers{};
    std::array<float*, 2U> referencePointers{};
    for (std::uint32_t channel = 0U; channel < channels; ++channel) {
        inputPointers[channel] = input[channel].data();
        testedPointers[channel] = testedOutput[channel].data();
        referencePointers[channel] = referenceOutput[channel].data();
        for (std::uint32_t i = 0U; i < blockFrames; ++i) {
            const double phase = 6.2831853071795864769 *
                (channel == 0U ? 220.0 : 331.0) * static_cast<double>(i) / 48000.0;
            input[channel][i] = static_cast<float>((channel == 0U ? 0.23 : -0.17) *
                                                    std::sin(phase));
        }
    }
    for (unsigned warm = 0U; warm < 4U; ++warm) {
        if (!tested.process(inputPointers.data(), blockFrames,
                            testedPointers.data(), blockFrames) ||
            !reference.process(inputPointers.data(), blockFrames,
                               referencePointers.data(), blockFrames)) return false;
    }

    allocationCount.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    const bool rejected = !tested.prepareLive(spec, replacement, rejectingPeak);
    const bool testedOk = tested.process(inputPointers.data(), blockFrames,
                                         testedPointers.data(), blockFrames);
    const bool referenceOk = reference.process(inputPointers.data(), blockFrames,
                                               referencePointers.data(), blockFrames);
    countAllocations.store(false, std::memory_order_release);
    const auto allocations = allocationCount.load(std::memory_order_relaxed);

    if (!rejected || !testedOk || !referenceOk || allocations != 0U ||
        !tested.prepared() ||
        tested.settings().blockSamples != settings.blockSamples ||
        tested.settings().channels != settings.channels) return false;
    for (std::uint32_t channel = 0U; channel < channels; ++channel)
        for (std::uint32_t i = 0U; i < blockFrames; ++i)
            if (testedOutput[channel][i] != referenceOutput[channel][i]) return false;
    return true;
}
} // namespace

void* operator new(std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    const ProcessSpec offlineSpec{48000.0f, 128U, 2U};
    const SignalsmithStretchSettings offlineSettings{PitchQualityMode::HqRender, 2U,
                                                      16384U, 1024U, false, 0x505243U};
    const auto offlineBytes = SignalsmithStretchAdapter::requiredPrepareBytes(
        offlineSpec, offlineSettings);
    SignalsmithStretchAdapter offline(offlineSettings.seed);
    bool offlinePrepared = offlineBytes > 0U && offline.prepare(
        offlineSpec, offlineSettings, offlineBytes);
    std::uint32_t seekFrames = 0U;
    const bool seekLengthOk = offlinePrepared &&
        offline.outputSeekLength(1.0f, seekFrames) && seekFrames > offlineSpec.maxBlockFrames;
    std::vector<float> seekLeft(seekFrames), seekRight(seekFrames);
    std::array<float, 128U> processLeft{}, processRight{}, flushLeft{}, flushRight{};
    std::array<float, 128U> inputLeft{}, inputRight{};
    for (std::uint32_t i = 0U; i < std::min<std::uint32_t>(
             static_cast<std::uint32_t>(seekLeft.size()), 16384U); ++i) {
        const double t = static_cast<double>(i) / 48000.0;
        seekLeft[i] = static_cast<float>(0.2 * std::sin(6.2831853071795864769 * 220.0 * t));
        seekRight[i] = static_cast<float>(-0.15 * std::sin(6.2831853071795864769 * 330.0 * t));
    }
    for (std::uint32_t i = 0U; i < 128U; ++i) {
        inputLeft[i] = seekLeft[i];
        inputRight[i] = seekRight[i];
    }
    const float* seekInput[2]{seekLeft.data(), seekRight.data()};
    const float* input[2]{inputLeft.data(), inputRight.data()};
    float* processOutput[2]{processLeft.data(), processRight.data()};
    float* flushOutput[2]{flushLeft.data(), flushRight.data()};
    const bool seekOk = seekLengthOk && offline.outputSeek(seekInput, seekFrames, 1.0f);
    const bool processOk = seekOk && offline.process(input, 128U, processOutput, 128U);
    const bool flushOk = processOk && offline.flush(flushOutput, 128U, 1.0f);
    check(offlinePrepared && seekLengthOk && seekOk && processOk && flushOk,
          "offline prepare preserves bounded outputSeek, process and flush");

    check(SignalsmithStretchAdapter::requiredLivePrepareBytes(
              ProcessSpec{48000.0f, 64U, 1U},
              SignalsmithStretchSettings{PitchQualityMode::LiveMono, 1U, 4096U, 512U, false, 7U}) > 0U &&
          SignalsmithStretchAdapter::requiredLivePrepareBytes(
              ProcessSpec{48000.0f, 128U, 2U},
              SignalsmithStretchSettings{PitchQualityMode::LivePoly, 2U, 4096U, 512U, false, 7U}) > 0U &&
          SignalsmithStretchAdapter::requiredLivePrepareBytes(
              ProcessSpec{48000.0f, 1024U, 2U},
              SignalsmithStretchSettings{PitchQualityMode::LivePoly, 2U, 4096U, 512U, false, 7U}) > 0U,
          "live preflight reports nonzero bounded storage at mono/stereo 64/128/1024-frame configurations");

    bool statesPreserved = true;
    for (const auto channels : {1U, 2U})
        for (const auto frames : {64U, 128U, 1024U})
            statesPreserved = runLiveStateCase(channels, frames) && statesPreserved;
    check(statesPreserved,
          "live process is allocation-free and budget-rejected reprepare preserves stereo engine state exactly at 64/128/1024 frames");

    std::printf("offlineBytes=%zu seekFrames=%u liveStateCases=6 failures=%u\n",
                offlineBytes, seekFrames, failures);
    return failures == 0U ? 0 : 1;
}
