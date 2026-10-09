#include "webrc/dsp/octave_fx.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <vector>

namespace {
std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gAllocationCount{0U};
std::atomic<std::uint64_t> gFreeCount{0U};
}

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gAllocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    std::abort();
}
void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gAllocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    std::abort();
}
void operator delete(void* memory) noexcept {
    if (memory != nullptr && gWatchAllocations.load(std::memory_order_relaxed))
        gFreeCount.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}
void operator delete[](void* memory) noexcept {
    if (memory != nullptr && gWatchAllocations.load(std::memory_order_relaxed))
        gFreeCount.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}
void operator delete(void* memory, std::size_t) noexcept { operator delete(memory); }
void operator delete[](void* memory, std::size_t) noexcept { operator delete[](memory); }

namespace {

using namespace webrc::dsp;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr float kSampleRate = 48000.0f;
int gFailures = 0;
double gMaximumPartitionDifference = 0.0;
std::array<double, 2U> gUpPeakHz{};
std::array<double, 2U> gDownPeakHz{};
std::array<double, 2U> gUpWrongChannelRatio{};
std::array<double, 2U> gDownWrongChannelRatio{};
double gUnityMaximumError = 0.0;
std::uint32_t gImpulseFirstOutput = 0U;
std::uint64_t gCallbackAllocations = 0U;
std::uint64_t gCallbackFrees = 0U;
double gDurationMs = 0.0;

bool check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++gFailures;
    }
    return condition;
}

constexpr ProcessSpec makeSpec(std::uint32_t maximumBlock = 256U) {
    return {kSampleRate, maximumBlock, 2U};
}

OctaveFxEvent event(std::uint32_t offset, OctaveFxControl control, float value) {
    return {offset, control, value};
}

std::array<OctaveFxEvent, 3U> activeOctaveEvents(float semitones) {
    return {{event(0U, OctaveFxControl::Active, 1.0f),
             event(0U, OctaveFxControl::Mix, 1.0f),
             event(0U, OctaveFxControl::Semitones, semitones)}};
}

float sine(float frequencyHz, std::uint64_t frame, float amplitude) {
    return amplitude * static_cast<float>(std::sin(
        2.0 * kPi * frequencyHz * static_cast<double>(frame) / kSampleRate));
}

bool render(OctaveFxProcessor& processor, std::vector<StereoFrame>& audio,
            std::uint32_t partitionFrames,
            const std::array<OctaveFxEvent, 3U>& startEvents) {
    for (std::uint32_t start = 0U; start < audio.size();) {
        const auto count = std::min<std::uint32_t>(partitionFrames,
            static_cast<std::uint32_t>(audio.size()) - start);
        const auto* events = start == 0U ? startEvents.data() : nullptr;
        const auto eventCount = start == 0U
            ? static_cast<std::uint32_t>(startEvents.size()) : 0U;
        if (!processor.processBlock(start, audio.data() + start, count, events, eventCount))
            return false;
        start += count;
    }
    return true;
}

double toneAmplitude(const std::vector<StereoFrame>& samples, bool left,
                     std::uint32_t first, std::uint32_t count, double frequencyHz) {
    double cosine = 0.0;
    double sineSum = 0.0;
    double windowSum = 0.0;
    for (std::uint32_t i = 0U; i < count; ++i) {
        const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * i / (count - 1U));
        const auto& frame = samples[first + i];
        const double value = left ? frame.left : frame.right;
        const double phase = 2.0 * kPi * frequencyHz * i / kSampleRate;
        cosine += value * window * std::cos(phase);
        sineSum += value * window * std::sin(phase);
        windowSum += window;
    }
    return 2.0 * std::hypot(cosine, sineSum) / std::max(1.0e-20, windowSum);
}

double positiveCrossingFrequency(const std::vector<StereoFrame>& samples,
                                 bool left, std::uint32_t first,
                                 std::uint32_t last) {
    double firstCrossing = -1.0;
    double lastCrossing = -1.0;
    std::uint32_t count = 0U;
    for (std::uint32_t i = first + 1U; i <= last; ++i) {
        const double a = left ? samples[i - 1U].left : samples[i - 1U].right;
        const double b = left ? samples[i].left : samples[i].right;
        if (a <= 0.0 && b > 0.0) {
            const double crossing = static_cast<double>(i - 1U) - a / (b - a);
            if (firstCrossing < 0.0) firstCrossing = crossing;
            lastCrossing = crossing;
            ++count;
        }
    }
    return count > 1U && lastCrossing > firstCrossing
        ? (count - 1U) * kSampleRate / (lastCrossing - firstCrossing)
        : 0.0;
}

void testValidationAndMemoryAdmission() {
    OctaveFxOptions options{};
    check(OctaveFxProcessor::requiredPrepareBytes(makeSpec(), options) > sizeof(OctaveFxProcessor),
          "memory preflight includes both phase processors and fixed stereo histories");
    check(OctaveFxProcessor::requiredPrepareBytes(makeSpec(), {8192U, 256U, 10.0f}) == 0U,
          "memory preflight rejects windows beyond the bounded implementation limit");
    check(OctaveFxProcessor::requiredPrepareBytes(makeSpec(), {2048U, 192U, 10.0f}) == 0U,
          "memory preflight rejects non-power-of-two hops");
    OctaveFxProcessor processor;
    check(processor.prepare(makeSpec()), "default OCTAVE processor prepares");
    check(processor.preparedBytes() == OctaveFxProcessor::requiredPrepareBytes(makeSpec()),
          "prepared byte report matches preflight");
    check(processor.latency().fixedAlgorithmicSamples == 2048U,
          "prepared output reports one fixed 2048-frame dry/wet latency");
}

void testUnityReconstructionAndImpulseLatency() {
    constexpr std::uint32_t total = 60000U;
    constexpr std::uint32_t activeAt = 12288U;
    OctaveFxProcessor processor;
    check(processor.prepare(makeSpec()), "OCTAVE prepares for unity reconstruction");
    std::vector<StereoFrame> audio(total);
    for (std::uint32_t i = 0U; i < total; ++i) {
        audio[i] = {0.35f * sine(431.3f, i, 1.0f) + 0.12f * sine(1800.0f, i, 1.0f),
                    0.29f * sine(723.1f, i, 1.0f) - 0.09f * sine(2600.0f, i, 1.0f)};
    }
    const std::array<OctaveFxEvent, 2U> setUnity{{
        event(0U, OctaveFxControl::Mix, 1.0f),
        event(0U, OctaveFxControl::Semitones, 0.0f)}};
    bool settled = true;
    for (std::uint32_t start = 0U; start < activeAt; start += 256U) {
        settled = processor.processBlock(start, audio.data() + start, 256U,
            start == 0U ? setUnity.data() : nullptr,
            start == 0U ? static_cast<std::uint32_t>(setUnity.size()) : 0U) && settled;
    }
    check(settled, "unity ratio can settle before the wet voice is enabled");
    const std::array<OctaveFxEvent, 1U> activate{{event(0U, OctaveFxControl::Active, 1.0f)}};
    bool unityProcessed = true;
    for (std::uint32_t start = activeAt; start < total; start += 256U) {
        const auto count = std::min<std::uint32_t>(256U, total - start);
        unityProcessed = processor.processBlock(start, audio.data() + start, count,
            start == activeAt ? activate.data() : nullptr,
            start == activeAt ? 1U : 0U) && unityProcessed;
    }
    check(unityProcessed,
          "unity phase-vocoder reconstruction processes a long independent stereo fixture");
    for (std::uint32_t frame = activeAt + 12000U; frame < total; ++frame) {
        const auto source = frame - 2048U;
        const StereoFrame reference{
            0.35f * sine(431.3f, source, 1.0f) + 0.12f * sine(1800.0f, source, 1.0f),
            0.29f * sine(723.1f, source, 1.0f) - 0.09f * sine(2600.0f, source, 1.0f)};
        const double error = std::max(std::fabs(audio[frame].left - reference.left),
                                      std::fabs(audio[frame].right - reference.right));
        gUnityMaximumError = std::max(gUnityMaximumError, error);
    }
    check(gUnityMaximumError < 2.0e-3,
          "unity phase-vocoder OLA reconstructs the delayed independent L/R input");
    OctaveFxProcessor impulseProcessor;
    check(impulseProcessor.prepare(makeSpec()), "OCTAVE prepares for impulse latency probe");
    std::vector<StereoFrame> impulse(8192U);
    impulse[0] = {0.7f, -0.3f};
    const auto events = activeOctaveEvents(0.0f);
    check(render(impulseProcessor, impulse, 128U, events),
          "unity OCTAVE impulse probe renders");
    for (std::uint32_t i = 0U; i < impulse.size(); ++i) {
        if (std::max(std::fabs(impulse[i].left), std::fabs(impulse[i].right)) > 1.0e-6f) {
            gImpulseFirstOutput = i;
            break;
        }
    }
    check(gImpulseFirstOutput == 257U,
          "impulse pre-ringing begins at the first Hann-weighted analysis hop, apart from steady-state alignment");
}

void testOctaveAccuracyAndStereoIsolation(float semitones,
                                          const std::array<float, 2U>& inputHz,
                                          const std::array<float, 2U>& expectedHz,
                                          std::array<double, 2U>& measured,
                                          std::array<double, 2U>& leakage) {
    constexpr std::uint32_t sourceFrames = 48000U;
    constexpr std::uint32_t total = sourceFrames + 2048U + 4096U;
    OctaveFxProcessor processor;
    check(processor.prepare(makeSpec()), "OCTAVE prepares for octave voice parity");
    std::vector<StereoFrame> audio(total);
    for (std::uint32_t i = 0U; i < sourceFrames; ++i) {
        audio[i] = {sine(inputHz[0], i, 0.6f), sine(inputHz[1], i, 0.45f)};
    }
    check(render(processor, audio, 128U, activeOctaveEvents(semitones)),
          "octave-shifted stereo tone fixture renders");
    constexpr std::uint32_t first = 2048U + 12000U;
    constexpr std::uint32_t count = 24000U;
    constexpr std::uint32_t last = first + count - 1U;
    measured[0] = positiveCrossingFrequency(audio, true, first, last);
    measured[1] = positiveCrossingFrequency(audio, false, first, last);
    const auto leftRightExpected = toneAmplitude(audio, true, first, count, expectedHz[0]);
    const auto rightLeftExpected = toneAmplitude(audio, false, first, count, expectedHz[1]);
    const auto leftWrong = toneAmplitude(audio, true, first, count, expectedHz[1]);
    const auto rightWrong = toneAmplitude(audio, false, first, count, expectedHz[0]);
    leakage[0] = leftWrong / std::max(1.0e-9, leftRightExpected);
    leakage[1] = rightWrong / std::max(1.0e-9, rightLeftExpected);
    check(std::fabs(measured[0] - expectedHz[0]) < 4.0,
          "left octave voice reaches the requested frequency within 4 Hz");
    check(std::fabs(measured[1] - expectedHz[1]) < 4.0,
          "right octave voice reaches the requested frequency within 4 Hz");
    check(leftRightExpected > 0.12 && rightLeftExpected > 0.10,
          "both independent channels retain measurable octave-shifted energy");
    check(leakage[0] < 0.025 && leakage[1] < 0.025,
          "different L/R source frequencies remain isolated through octave shifting");
}

void testVariableBlocksAndDuration() {
    constexpr std::uint32_t total = 64000U;
    std::vector<StereoFrame> input(total);
    for (std::uint32_t i = 0U; i < 48000U; ++i) {
        input[i] = {sine(220.0f, i, 0.58f), sine(330.0f, i, 0.43f)};
    }
    auto audio64 = input;
    auto audio128 = input;
    auto audio256 = input;
    OctaveFxProcessor p64;
    OctaveFxProcessor p128;
    OctaveFxProcessor p256;
    check(p64.prepare(makeSpec(256U)) && p128.prepare(makeSpec(256U)) &&
          p256.prepare(makeSpec(256U)),
          "separate OCTAVE instances prepare for block partition comparison");
    const auto events = activeOctaveEvents(12.0f);
    check(render(p64, audio64, 64U, events), "OCTAVE accepts fixed 64-frame blocks");
    check(render(p128, audio128, 128U, events), "OCTAVE accepts fixed 128-frame blocks");
    check(render(p256, audio256, 256U, events), "OCTAVE accepts fixed 256-frame blocks");
    for (std::uint32_t i = 0U; i < total; ++i) {
        gMaximumPartitionDifference = std::max(gMaximumPartitionDifference,
            static_cast<double>(std::max({std::fabs(audio64[i].left - audio128[i].left),
                                          std::fabs(audio64[i].right - audio128[i].right),
                                          std::fabs(audio128[i].left - audio256[i].left),
                                          std::fabs(audio128[i].right - audio256[i].right)})));
    }
    check(gMaximumPartitionDifference == 0.0,
          "64-, 128-, and 256-frame schedules produce bit-identical stereo PCM");

    constexpr std::uint32_t noteFrames = 24000U;
    constexpr std::uint32_t renderedFrames = noteFrames + 2048U + 4096U;
    OctaveFxProcessor durationProcessor;
    check(durationProcessor.prepare(makeSpec()), "OCTAVE prepares for duration preservation");
    std::vector<StereoFrame> gated(renderedFrames);
    constexpr std::uint32_t fade = 256U;
    for (std::uint32_t i = 0U; i < noteFrames; ++i) {
        float envelope = 1.0f;
        if (i < fade) envelope = static_cast<float>(i) / fade;
        if (i >= noteFrames - fade)
            envelope = std::min(envelope, static_cast<float>(noteFrames - 1U - i) / fade);
        gated[i] = {sine(220.0f, i, 0.6f * envelope), sine(330.0f, i, 0.4f * envelope)};
    }
    check(render(durationProcessor, gated, 64U, activeOctaveEvents(12.0f)),
          "gated octave note is rendered at 64-frame quantum");
    std::uint32_t firstActiveBlock = renderedFrames / 256U;
    std::uint32_t lastActiveBlock = 0U;
    for (std::uint32_t block = 0U; block < renderedFrames / 256U; ++block) {
        double energy = 0.0;
        for (std::uint32_t i = 0U; i < 256U; ++i) {
            const auto& sample = gated[block * 256U + i];
            energy += static_cast<double>(sample.left) * sample.left +
                      static_cast<double>(sample.right) * sample.right;
        }
        const double rms = std::sqrt(energy / 512.0);
        if (rms > 0.04) {
            firstActiveBlock = std::min(firstActiveBlock, block);
            lastActiveBlock = block;
        }
    }
    const auto measuredDurationFrames = (lastActiveBlock - firstActiveBlock + 1U) * 256U;
    gDurationMs = 1000.0 * measuredDurationFrames / kSampleRate;
    check(firstActiveBlock * 256U >= 256U && firstActiveBlock * 256U <= 256U + 2U * 256U,
          "gated onset smearing is bounded by the first available analysis hops");
    check(std::abs(static_cast<std::int64_t>(measuredDurationFrames) - noteFrames) <= 2048,
          "equal analysis/synthesis hops preserve note duration within one window smear");
}

void testTransactionalValidationAndNoAllocation() {
    OctaveFxProcessor processor;
    check(processor.prepare(makeSpec(64U)), "OCTAVE prepares for callback validation");
    std::array<StereoFrame, 64U> block{};
    for (std::uint32_t i = 0U; i < block.size(); ++i)
        block[i] = {0.21f * std::sin(i * 0.07f), -0.19f * std::cos(i * 0.09f)};
    const auto original = block;
    const std::array<OctaveFxEvent, 2U> invalid{{
        event(0U, OctaveFxControl::Active, 1.0f),
        event(1U, OctaveFxControl::Semitones, 12.01f)}};
    check(!processor.processBlock(0U, block.data(), 64U, invalid.data(), 2U),
          "out-of-range semitone event rejects the whole callback");
    check(std::equal(block.begin(), block.end(), original.begin(), [](const auto& a, const auto& b) {
        return a.left == b.left && a.right == b.right;
    }), "invalid control schedule leaves PCM untouched");
    const std::array<OctaveFxEvent, 2U> unordered{{
        event(20U, OctaveFxControl::Mix, 0.2f),
        event(10U, OctaveFxControl::Mix, 0.8f)}};
    check(!processor.processBlock(0U, block.data(), 64U, unordered.data(), 2U),
          "unordered controls reject before advancing the expected timeline");

    std::array<OctaveFxEvent, 64U> worstEvents{};
    for (std::uint32_t i = 0U; i < worstEvents.size(); ++i) {
        const auto selector = i % 3U;
        worstEvents[i] = selector == 0U
            ? event(i, OctaveFxControl::Active, (i & 1U) == 0U ? 1.0f : 0.0f)
            : selector == 1U
                ? event(i, OctaveFxControl::Mix, (i & 1U) == 0U ? 0.9f : 0.25f)
                : event(i, OctaveFxControl::Semitones, (i & 1U) == 0U ? 12.0f : -12.0f);
    }
    const auto allocationBefore = gAllocationCount.load(std::memory_order_relaxed);
    const auto freeBefore = gFreeCount.load(std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    bool accepted = true;
    for (std::uint32_t blockIndex = 0U; blockIndex < 64U; ++blockIndex) {
        for (std::uint32_t i = 0U; i < block.size(); ++i)
            block[i] = {0.23f * std::sin((blockIndex * 64U + i) * 0.041f),
                        -0.17f * std::cos((blockIndex * 64U + i) * 0.063f)};
        accepted = processor.processBlock(static_cast<std::uint64_t>(blockIndex) * 64U,
                                           block.data(), 64U,
                                           worstEvents.data(), 64U) && accepted;
    }
    gWatchAllocations.store(false, std::memory_order_relaxed);
    gCallbackAllocations = gAllocationCount.load(std::memory_order_relaxed) - allocationBefore;
    gCallbackFrees = gFreeCount.load(std::memory_order_relaxed) - freeBefore;
    check(accepted, "maximum 64 ordered control events process across variable spectra");
    check(gCallbackAllocations == 0U && gCallbackFrees == 0U,
          "prepared OCTAVE callbacks perform no heap allocation or free");
}

} // namespace

int main() {
    testValidationAndMemoryAdmission();
    testUnityReconstructionAndImpulseLatency();
    testOctaveAccuracyAndStereoIsolation(12.0f, {220.0f, 330.0f}, {440.0f, 660.0f},
                                          gUpPeakHz, gUpWrongChannelRatio);
    testOctaveAccuracyAndStereoIsolation(-12.0f, {880.0f, 660.0f}, {440.0f, 330.0f},
                                          gDownPeakHz, gDownWrongChannelRatio);
    testVariableBlocksAndDuration();
    testTransactionalValidationAndNoAllocation();
    std::printf(
        "{\"schemaVersion\":1,\"suite\":\"octave-fx\",\"sampleRate\":48000,"
        "\"latencySamples\":2048,\"partitionMaximumDifference\":%.12g,"
        "\"upPeakHz\":[%.6f,%.6f],\"upWrongChannelRatio\":[%.12g,%.12g],"
        "\"downPeakHz\":[%.6f,%.6f],\"downWrongChannelRatio\":[%.12g,%.12g],"
        "\"unityMaximumError\":%.12g,\"impulseFirstOutput\":%u,"
        "\"gatedToneDurationMs\":%.6f,\"callbackAllocationsAndFrees\":[%llu,%llu]}\n",
        gMaximumPartitionDifference, gUpPeakHz[0], gUpPeakHz[1],
        gUpWrongChannelRatio[0], gUpWrongChannelRatio[1],
        gDownPeakHz[0], gDownPeakHz[1], gDownWrongChannelRatio[0], gDownWrongChannelRatio[1],
        gUnityMaximumError, gImpulseFirstOutput, gDurationMs,
        static_cast<unsigned long long>(gCallbackAllocations),
        static_cast<unsigned long long>(gCallbackFrees));
    if (gFailures != 0) {
        std::fprintf(stderr, "octave_fx_tests: %d failure(s)\n", gFailures);
        return 1;
    }
    std::puts("OCTAVE: true stereo phase-vocoder voice, latency, octave accuracy, duration, and callback checks passed");
    return 0;
}
