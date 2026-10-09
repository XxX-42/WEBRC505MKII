#include "webrc/dsp/octave_models.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

namespace {

using namespace webrc::dsp;

constexpr float kSampleRate = 48000.0f;
constexpr std::uint32_t kWindow = 2048U;
constexpr std::uint32_t kHop = 256U;
constexpr double kPi = 3.141592653589793238462643383279502884;
std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gAllocationCount{0U};
std::atomic<std::uint64_t> gFreeCount{0U};
std::uint64_t gCallbackAllocations = 0U;
std::uint64_t gCallbackFrees = 0U;
std::uint32_t gFailures = 0U;
double gMaxPartitionError = 0.0;
double gPreEventDifference = 0.0;
double gPostEventDifference = 0.0;
std::array<double, 3U> gModeTonePeaks{};
std::array<std::array<double, 2U>, 2U> gModeChannelPeaks{};
std::array<double, 4U> gDualTonePeaks{};
std::array<double, 2U> gChannelLeakage{};
std::uint32_t gColdImpulseFirst = 0U;
std::uint32_t gWarmImpulseFirst = 0U;
std::uint32_t gDurationMs = 0U;
std::uint64_t gPreparedBytes = 0U;

void check(bool condition, const char* message) {
    if (!condition) {
        ++gFailures;
        std::fprintf(stderr, "FAIL: %s\n", message);
    }
}

webrc::dsp::ProcessSpec makeSpec(std::uint32_t maxBlockFrames = 256U,
                                 float sampleRate = kSampleRate) {
    return {sampleRate, maxBlockFrames, 2U};
}

OctaveModelsEvent event(std::uint32_t offset, OctaveModelsControl control, float value) {
    return {offset, control, value};
}

std::array<OctaveModelsEvent, 3U> activeEvents(OctaveModelsMode mode) {
    return {{event(0U, OctaveModelsControl::Active, 1.0f),
             event(0U, OctaveModelsControl::Mix, 1.0f),
             event(0U, OctaveModelsControl::Mode, static_cast<float>(mode))}};
}

float sine(float hz, std::uint64_t frame, float amplitude) {
    return amplitude * std::sin(static_cast<float>(2.0 * kPi * hz *
        static_cast<double>(frame) / kSampleRate));
}

double toneAmplitude(const std::vector<StereoFrame>& audio, bool left,
                     std::uint32_t first, std::uint32_t count, double frequency) {
    double real = 0.0;
    double imag = 0.0;
    for (std::uint32_t index = 0U; index < count; ++index) {
        const auto frame = static_cast<std::uint64_t>(first) + index;
        const double phase = 2.0 * kPi * frequency * static_cast<double>(frame) / kSampleRate;
        const double sample = left ? audio[first + index].left : audio[first + index].right;
        real += sample * std::cos(phase);
        imag -= sample * std::sin(phase);
    }
    return 2.0 * std::hypot(real, imag) / count;
}

bool render(OctaveModelsFxProcessor& processor, std::vector<StereoFrame>& audio,
            std::uint32_t quantum, const std::array<OctaveModelsEvent, 3U>& startEvents) {
    for (std::uint32_t start = 0U; start < audio.size(); start += quantum) {
        const auto frames = std::min<std::uint32_t>(quantum,
            static_cast<std::uint32_t>(audio.size() - start));
        const auto* events = start == 0U ? startEvents.data() : nullptr;
        const auto eventCount = start == 0U
            ? static_cast<std::uint32_t>(startEvents.size()) : 0U;
        if (!processor.processBlock(start, audio.data() + start, frames, events, eventCount))
            return false;
    }
    return true;
}

void fillStereoTones(std::vector<StereoFrame>& audio, std::uint32_t sourceFrames,
                     float leftHz = 880.0f, float rightHz = 660.0f) {
    for (std::uint32_t frame = 0U; frame < sourceFrames; ++frame)
        audio[frame] = {sine(leftHz, frame, 0.56f), sine(rightHz, frame, 0.43f)};
}

void testMemoryAndValidation() {
    const auto spec = makeSpec();
    OctaveModelsOptions options;
    const auto required = OctaveModelsFxProcessor::requiredPrepareBytes(spec, options);
    gPreparedBytes = required;
    check(required > 0U && required < 16U * 1024U * 1024U,
          "three prepared phase-vocoder branches fit the bounded memory admission");
    check(OctaveModelsFxProcessor::replacementPeakBytes(required, spec, options) == 2U * required,
          "replacement admission accounts for active and staged graphs");
    check(OctaveModelsFxProcessor::requiredPrepareBytes({48000.0f, 256U, 1U}, options) == 0U,
          "mono graph preparation is rejected because mode mixing is defined stereo");
    options.voice.windowFrames = 3000U;
    check(OctaveModelsFxProcessor::requiredPrepareBytes(spec, options) == 0U,
          "invalid inner STFT dimensions fail closed before allocation");

    OctaveModelsFxProcessor processor;
    check(!processor.prepare({48000.0f, 256U, 1U}),
          "invalid preparation leaves a fresh adapter unprepared");
    check(processor.prepare(spec), "OCTAVE mode wrapper prepares all bounded voice paths");
    const auto bytes = processor.preparedBytes();
    check(bytes == required, "prepared byte report equals the conservative admission estimate");
    check(!processor.prepare(spec), "a prepared object rejects restaging and preserves its instance");
    check(processor.prepared() && processor.preparedBytes() == bytes,
          "rejected restage leaves the existing prepared object usable");
    check(processor.latency().fixedMixedPathSamples == 2U * kWindow,
          "mode adapter declares two-window mixed-path alignment for the -2 path");
}

void testPublishedModeTonesAndStereo() {
    constexpr std::uint32_t sourceFrames = 48000U;
    constexpr std::uint32_t totalFrames = sourceFrames + 2U * kWindow + 4096U;
    constexpr std::uint32_t measureFirst = 2U * kWindow + 12000U;
    constexpr std::uint32_t measureCount = 24000U;
    const std::array<OctaveModelsMode, 3U> modes{{
        OctaveModelsMode::DownOneOctave,
        OctaveModelsMode::DownTwoOctaves,
        OctaveModelsMode::DualDownOctaves,
    }};
    for (std::size_t index = 0U; index < modes.size(); ++index) {
        OctaveModelsFxProcessor processor;
        check(processor.prepare(makeSpec()), "mode tone fixture prepares");
        std::vector<StereoFrame> audio(totalFrames);
        fillStereoTones(audio, sourceFrames);
        check(render(processor, audio, 128U, activeEvents(modes[index])),
              "published OCTAVE mode renders a long independent stereo tone");
        if (modes[index] == OctaveModelsMode::DownOneOctave) {
            const double left = toneAmplitude(audio, true, measureFirst, measureCount, 440.0);
            const double right = toneAmplitude(audio, false, measureFirst, measureCount, 330.0);
            gModeChannelPeaks[0U] = {{left, right}};
            gModeTonePeaks[index] = std::min(left, right);
            check(left > 0.20 && right > 0.15,
                  "-1OCT mode produces independent left/right tones at half frequency");
        } else if (modes[index] == OctaveModelsMode::DownTwoOctaves) {
            const double left = toneAmplitude(audio, true, measureFirst, measureCount, 220.0);
            const double right = toneAmplitude(audio, false, measureFirst, measureCount, 165.0);
            gModeChannelPeaks[1U] = {{left, right}};
            gModeTonePeaks[index] = std::min(left, right);
            check(left > 0.06 && right > 0.05,
                  "-2OCT cascades real phase-vocoder voices to one-quarter frequency");
        } else {
            const double leftOne = toneAmplitude(audio, true, measureFirst, measureCount, 440.0);
            const double leftTwo = toneAmplitude(audio, true, measureFirst, measureCount, 220.0);
            const double rightOne = toneAmplitude(audio, false, measureFirst, measureCount, 330.0);
            const double rightTwo = toneAmplitude(audio, false, measureFirst, measureCount, 165.0);
            gDualTonePeaks = {{leftOne, leftTwo, rightOne, rightTwo}};
            gModeTonePeaks[index] = std::min({leftOne, leftTwo, rightOne, rightTwo});
            check(leftOne > 0.08 && leftTwo > 0.03 && rightOne > 0.06 && rightTwo > 0.04,
                  "dual mode contains both real octave voices on both channels");
        }
    }

    OctaveModelsFxProcessor isolation;
    check(isolation.prepare(makeSpec()), "dual isolation fixture prepares");
    std::vector<StereoFrame> audio(totalFrames);
    for (std::uint32_t frame = 0U; frame < sourceFrames; ++frame)
        audio[frame].left = sine(880.0f, frame, 0.56f);
    check(render(isolation, audio, 256U,
                 activeEvents(OctaveModelsMode::DualDownOctaves)),
          "left-only dual mode renders without channel averaging");
    double rightEnergy = 0.0;
    for (std::uint32_t frame = measureFirst; frame < measureFirst + measureCount; ++frame)
        rightEnergy += static_cast<double>(audio[frame].right) * audio[frame].right;
    const double rightRms = std::sqrt(rightEnergy / measureCount);
    gChannelLeakage[0] = rightRms;
    check(rightRms < 1.0e-7,
          "left-only input has no right output leakage through either octave stage");
}

void testColdWarmLatencyAndDuration() {
    constexpr std::uint32_t captureFrames = 16384U;
    OctaveModelsFxProcessor cold;
    check(cold.prepare(makeSpec()), "cold impulse processor prepares");
    std::vector<StereoFrame> impulse(captureFrames);
    impulse[0U] = {0.7f, -0.3f};
    check(render(cold, impulse, 64U,
                 activeEvents(OctaveModelsMode::DownTwoOctaves)),
          "cold -2OCT impulse renders");
    for (std::uint32_t frame = 0U; frame < impulse.size(); ++frame) {
        if (std::max(std::fabs(impulse[frame].left), std::fabs(impulse[frame].right)) > 1.0e-7f) {
            gColdImpulseFirst = frame;
            break;
        }
    }
    check(gColdImpulseFirst > 0U && gColdImpulseFirst < 2U * kWindow,
          "cold wet impulse onset is measured separately from two-window dry alignment");

    constexpr std::uint32_t warmFrames = 8192U;
    OctaveModelsFxProcessor warmImpulse;
    OctaveModelsFxProcessor warmControl;
    check(warmImpulse.prepare(makeSpec(128U)) && warmControl.prepare(makeSpec(128U)),
          "paired warm impulse processors prepare");
    auto setup = activeEvents(OctaveModelsMode::DownTwoOctaves);
    std::vector<StereoFrame> warmA(warmFrames);
    std::vector<StereoFrame> warmB(warmFrames);
    for (std::uint32_t frame = 0U; frame < warmFrames; ++frame) {
        const float left = 0.18f * sine(523.25f, frame, 1.0f) +
                           0.07f * sine(1733.0f, frame, 1.0f);
        const float right = 0.14f * sine(691.7f, frame, 1.0f) -
                            0.04f * sine(2219.0f, frame, 1.0f);
        warmA[frame] = {left, right};
        warmB[frame] = {left, right};
    }
    check(render(warmImpulse, warmA, 128U, setup) && render(warmControl, warmB, 128U, setup),
          "paired processors warm on identical stereo spectra");
    constexpr std::uint32_t postFrames = 8192U;
    std::vector<StereoFrame> afterA(postFrames);
    std::vector<StereoFrame> afterB(postFrames);
    afterA[0U] = {0.7f, -0.3f};
    bool both = true;
    for (std::uint32_t start = 0U; start < postFrames; start += 128U) {
        const auto frames = std::min<std::uint32_t>(128U, postFrames - start);
        both = warmImpulse.processBlock(warmFrames + start, afterA.data() + start, frames) && both;
        both = warmControl.processBlock(warmFrames + start, afterB.data() + start, frames) && both;
    }
    check(both, "warmed impulse/control pair processes contiguously");
    for (std::uint32_t frame = 0U; frame < postFrames; ++frame) {
        const double difference = std::max(std::fabs(afterA[frame].left - afterB[frame].left),
                                           std::fabs(afterA[frame].right - afterB[frame].right));
        if (difference > 1.0e-7) { gWarmImpulseFirst = frame; break; }
    }
    check(gWarmImpulseFirst > 0U && gWarmImpulseFirst < 2U * kWindow + kHop,
          "warmed wet onset is captured against an identical warmed control render");

    constexpr std::uint32_t noteFrames = 24000U;
    constexpr std::uint32_t totalFrames = noteFrames + 2U * kWindow + 8192U;
    std::vector<StereoFrame> gated(totalFrames);
    for (std::uint32_t frame = 0U; frame < noteFrames; ++frame) {
        float envelope = 1.0f;
        if (frame < 512U) envelope = static_cast<float>(frame) / 512.0f;
        if (frame >= noteFrames - 512U)
            envelope = std::min(envelope,
                static_cast<float>(noteFrames - 1U - frame) / 512.0f);
        gated[frame] = {sine(880.0f, frame, 0.56f * envelope),
                        sine(660.0f, frame, 0.43f * envelope)};
    }
    OctaveModelsFxProcessor duration;
    check(duration.prepare(makeSpec()), "duration fixture prepares");
    check(render(duration, gated, 64U,
                 activeEvents(OctaveModelsMode::DownTwoOctaves)),
          "gated -2OCT notes render with equal analysis/synthesis hops");
    std::uint32_t firstBlock = totalFrames / 256U;
    std::uint32_t lastBlock = 0U;
    for (std::uint32_t block = 0U; block < totalFrames / 256U; ++block) {
        double energy = 0.0;
        for (std::uint32_t i = 0U; i < 256U; ++i) {
            const auto& sample = gated[block * 256U + i];
            energy += static_cast<double>(sample.left) * sample.left +
                      static_cast<double>(sample.right) * sample.right;
        }
        const double rms = std::sqrt(energy / 512.0);
        if (rms > 0.02) {
            firstBlock = std::min(firstBlock, block);
            lastBlock = block;
        }
    }
    const auto durationFrames = (lastBlock - firstBlock + 1U) * 256U;
    gDurationMs = static_cast<std::uint32_t>(std::lround(
        1000.0 * static_cast<double>(durationFrames) / kSampleRate));
    check(firstBlock * 256U >= 256U && firstBlock * 256U < 2U * kWindow + 3U * kHop,
          "duration fixture bounds cold onset smear to the first analysis hops");
    check(std::abs(static_cast<std::int64_t>(durationFrames) - noteFrames) <= 2 * kWindow,
          "-2OCT preserves note duration within one two-stage window envelope");
}

void testPartitioningEventsAndNoAllocation() {
    constexpr std::uint32_t total = 32000U;
    std::vector<StereoFrame> input(total);
    for (std::uint32_t frame = 0U; frame < total; ++frame)
        input[frame] = {0.32f * sine(997.0f, frame, 1.0f) + 0.07f * sine(211.0f, frame, 1.0f),
                        -0.21f * sine(733.0f, frame, 1.0f)};
    auto audio64 = input;
    auto audio128 = input;
    auto audio256 = input;
    OctaveModelsFxProcessor p64, p128, p256;
    check(p64.prepare(makeSpec(256U)) && p128.prepare(makeSpec(256U)) &&
          p256.prepare(makeSpec(256U)),
          "separate processors prepare for 64/128/256 partition test");
    const auto setup = activeEvents(OctaveModelsMode::DualDownOctaves);
    check(render(p64, audio64, 64U, setup) && render(p128, audio128, 128U, setup) &&
          render(p256, audio256, 256U, setup),
          "fixed block partitions all process the same stereo stream");
    for (std::uint32_t frame = 0U; frame < total; ++frame) {
        gMaxPartitionError = std::max(gMaxPartitionError,
            static_cast<double>(std::max({std::fabs(audio64[frame].left - audio128[frame].left),
                                          std::fabs(audio64[frame].right - audio128[frame].right),
                                          std::fabs(audio128[frame].left - audio256[frame].left),
                                          std::fabs(audio128[frame].right - audio256[frame].right)})));
    }
    check(gMaxPartitionError == 0.0,
          "64-, 128-, and 256-frame schedules produce identical PCM");

    OctaveModelsFxProcessor switched;
    OctaveModelsFxProcessor controlProcessor;
    check(switched.prepare(makeSpec(128U)) && controlProcessor.prepare(makeSpec(128U)),
          "sample-offset mode pair prepares");
    constexpr std::uint32_t warmLength = 8192U;
    std::vector<StereoFrame> warmSwitch(warmLength);
    std::vector<StereoFrame> warmControl(warmLength);
    for (std::uint32_t frame = 0U; frame < warmLength; ++frame) {
        const StereoFrame value{sine(880.0f, frame, 0.4f), sine(660.0f, frame, 0.3f)};
        warmSwitch[frame] = value;
        warmControl[frame] = value;
    }
    const auto oneMode = activeEvents(OctaveModelsMode::DownOneOctave);
    check(render(switched, warmSwitch, 128U, oneMode) &&
          render(controlProcessor, warmControl, 128U, oneMode),
          "mode branches warm in lockstep before a sample-offset switch");
    std::array<StereoFrame, 128U> switchBlock{};
    std::array<StereoFrame, 128U> controlBlock{};
    for (std::uint32_t frame = 0U; frame < switchBlock.size(); ++frame) {
        const auto absolute = warmLength + frame;
        switchBlock[frame] = {sine(880.0f, absolute, 0.4f), sine(660.0f, absolute, 0.3f)};
        controlBlock[frame] = switchBlock[frame];
    }
    const OctaveModelsEvent switchAt{37U, OctaveModelsControl::Mode,
        static_cast<float>(OctaveModelsMode::DownTwoOctaves)};
    check(switched.processBlock(warmLength, switchBlock.data(), 128U, &switchAt, 1U) &&
          controlProcessor.processBlock(warmLength, controlBlock.data(), 128U),
          "mid-block octave mode automation is accepted");
    for (std::uint32_t frame = 0U; frame < 37U; ++frame) {
        gPreEventDifference = std::max(gPreEventDifference,
            static_cast<double>(std::max(std::fabs(switchBlock[frame].left - controlBlock[frame].left),
                                          std::fabs(switchBlock[frame].right - controlBlock[frame].right))));
    }
    for (std::uint32_t frame = 37U; frame < switchBlock.size(); ++frame) {
        gPostEventDifference = std::max(gPostEventDifference,
            static_cast<double>(std::max(std::fabs(switchBlock[frame].left - controlBlock[frame].left),
                                          std::fabs(switchBlock[frame].right - controlBlock[frame].right))));
    }
    check(gPreEventDifference == 0.0,
          "sample-offset mode control leaves all earlier samples unchanged");
    check(gPostEventDifference > 1.0e-5,
          "sample-offset mode control changes the smoothed voice mix from its exact event frame");

    OctaveModelsFxProcessor processor;
    check(processor.prepare(makeSpec(64U)), "event/no-allocation processor prepares");
    std::array<StereoFrame, 64U> block{};
    std::array<OctaveModelsEvent, 64U> events{};
    for (std::uint32_t index = 0U; index < events.size(); ++index) {
        const auto control = index % 3U;
        events[index] = control == 0U
            ? event(index, OctaveModelsControl::Active, (index & 1U) ? 0.7f : 1.0f)
            : control == 1U
                ? event(index, OctaveModelsControl::Mix, (index & 1U) ? 0.3f : 0.9f)
                : event(index, OctaveModelsControl::Mode, static_cast<float>((index / 3U) % 3U));
    }
    std::uint64_t beforeAlloc = gAllocationCount.load(std::memory_order_relaxed);
    std::uint64_t beforeFree = gFreeCount.load(std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    bool accepted = true;
    for (std::uint32_t blockIndex = 0U; blockIndex < 64U; ++blockIndex) {
        for (std::uint32_t frame = 0U; frame < block.size(); ++frame) {
            const auto absolute = static_cast<std::uint64_t>(blockIndex) * 64U + frame;
            block[frame] = {0.29f * sine(377.0f, absolute, 1.0f),
                            -0.19f * sine(619.0f, absolute, 1.0f)};
        }
        accepted = processor.processBlock(static_cast<std::uint64_t>(blockIndex) * 64U,
            block.data(), 64U, events.data(), static_cast<std::uint32_t>(events.size())) && accepted;
    }
    gWatchAllocations.store(false, std::memory_order_relaxed);
    gCallbackAllocations = gAllocationCount.load(std::memory_order_relaxed) - beforeAlloc;
    gCallbackFrees = gFreeCount.load(std::memory_order_relaxed) - beforeFree;
    check(accepted, "64 ordered controls per callback remain inside the fixed event bound");
    check(gCallbackAllocations == 0U && gCallbackFrees == 0U,
          "prepared mode callbacks allocate and free no memory");

    OctaveModelsFxProcessor transactional;
    check(transactional.prepare(makeSpec(64U)), "transactional validation processor prepares");
    block.fill({0.1f, -0.2f});
    const auto original = block;
    const auto invalid = event(7U, OctaveModelsControl::Mode, 2.5f);
    check(!transactional.processBlock(0U, block.data(), 64U, &invalid, 1U),
          "noninteger mode selection rejects the callback");
    check(std::equal(block.begin(), block.end(), original.begin(), [](const auto& a, const auto& b) {
        return a.left == b.left && a.right == b.right;
    }), "invalid mode leaves callback PCM untouched");
    check(transactional.processBlock(0U, block.data(), 64U),
          "rejected mode event leaves timeline and processing state reusable");
}

} // namespace

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gAllocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}

void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gAllocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}

void operator delete(void* memory) noexcept {
    if (gWatchAllocations.load(std::memory_order_relaxed) && memory != nullptr)
        gFreeCount.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}

void operator delete[](void* memory) noexcept {
    if (gWatchAllocations.load(std::memory_order_relaxed) && memory != nullptr)
        gFreeCount.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept { ::operator delete(memory); }
void operator delete[](void* memory, std::size_t) noexcept { ::operator delete[](memory); }

int main() {
    testMemoryAndValidation();
    testPublishedModeTonesAndStereo();
    testColdWarmLatencyAndDuration();
    testPartitioningEventsAndNoAllocation();
    std::printf(
        "{\"schemaVersion\":1,\"suite\":\"octave-models-fx\",\"sampleRate\":%.0f,"
        "\"modeToneMinima\":[%.9g,%.9g,%.9g],\"oneOctaveChannelPeaks\":[%.9g,%.9g],"
        "\"twoOctaveChannelPeaks\":[%.9g,%.9g],\"dualTonePeaks\":[%.9g,%.9g,%.9g,%.9g],"
        "\"rightChannelLeakageRms\":%.12g,\"preEventDifference\":%.12g,"
        "\"postEventDifference\":%.12g,\"coldImpulseFirstSample\":%u,"
        "\"warmImpulseDifferenceFirstSample\":%u,\"fixedMixedPathSamples\":%u,"
        "\"gatedDurationMs\":%u,\"partitionMaximumDifference\":%.12g,"
        "\"preparedBytes\":%llu,\"callbackAllocations\":%llu,\"callbackFrees\":%llu,"
        "\"failures\":%u}\n",
        kSampleRate, gModeTonePeaks[0], gModeTonePeaks[1], gModeTonePeaks[2],
        gModeChannelPeaks[0U][0U], gModeChannelPeaks[0U][1U],
        gModeChannelPeaks[1U][0U], gModeChannelPeaks[1U][1U],
        gDualTonePeaks[0], gDualTonePeaks[1], gDualTonePeaks[2], gDualTonePeaks[3],
        gChannelLeakage[0], gPreEventDifference, gPostEventDifference,
        gColdImpulseFirst, gWarmImpulseFirst, 2U * kWindow,
        gDurationMs, gMaxPartitionError, static_cast<unsigned long long>(gPreparedBytes),
        static_cast<unsigned long long>(gCallbackAllocations),
        static_cast<unsigned long long>(gCallbackFrees), gFailures);
    if (gFailures != 0U) return 1;
    std::puts("OCTAVE modes: -1, -2, and dual downward voices passed functional standalone checks");
    return 0;
}
