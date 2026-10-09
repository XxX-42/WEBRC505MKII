#include "webrc/dsp/distortion_fx.hpp"

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

std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gAllocations{0U};
std::atomic<std::uint64_t> gFrees{0U};

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void operator delete(void* pointer) noexcept {
    if (pointer && gWatchAllocations.load(std::memory_order_relaxed))
        gFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}
void operator delete[](void* pointer) noexcept {
    if (pointer && gWatchAllocations.load(std::memory_order_relaxed))
        gFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}
void operator delete(void* pointer, std::size_t) noexcept { operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { operator delete[](pointer); }

namespace {

using namespace webrc::dsp;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kFrames = 24000U;
int gFailures = 0;
double gPartitionDifference = 0.0;
double gStereoLeakLeft = 0.0;
double gStereoLeakRight = 0.0;
double gToneRatio = 0.0;
double gReferenceMaximumError = 0.0;
double gAliasRatio4xVs1x = 0.0;
double gModelDifference = 0.0;
std::uint64_t gCallbackAllocations = 0U;

bool check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++gFailures;
    }
    return condition;
}

constexpr ProcessSpec makeSpec(std::uint32_t maxBlockFrames = 256U) {
    return {static_cast<float>(kSampleRate), maxBlockFrames, 2U};
}

DistortionFxEvent event(std::uint32_t offset, DistortionFxControl control, float value) {
    return {offset, control, value};
}

std::vector<StereoFrame> source(std::uint32_t frames) {
    std::vector<StereoFrame> result(frames);
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const double t = static_cast<double>(i) / kSampleRate;
        result[i] = {0.29f * static_cast<float>(std::sin(2.0 * kPi * 431.0 * t)) +
                         0.07f * static_cast<float>(std::sin(2.0 * kPi * 6100.0 * t)),
                     -0.23f * static_cast<float>(std::sin(2.0 * kPi * 997.0 * t + 0.2)) +
                          0.05f * static_cast<float>(std::sin(2.0 * kPi * 4300.0 * t))};
    }
    return result;
}

struct RenderResult {
    std::vector<StereoFrame> audio;
    bool ok = false;
};

std::vector<DistortionFxEvent> schedule() {
    return {event(0U, DistortionFxControl::Active, 1.0f),
            event(0U, DistortionFxControl::Mix, 0.9f),
            event(0U, DistortionFxControl::Drive, 5.0f),
            event(0U, DistortionFxControl::ToneHz, 7200.0f),
            event(0U, DistortionFxControl::OutputDb, -2.0f),
            event(6000U, DistortionFxControl::Drive, 12.0f),
            event(9000U, DistortionFxControl::ToneHz, 3800.0f),
            event(15000U, DistortionFxControl::OutputDb, 1.5f),
            event(18000U, DistortionFxControl::Mix, 0.72f)};
}

RenderResult render(DistortionModel model, std::uint32_t blockFrames) {
    RenderResult result;
    result.audio = source(kFrames);
    DistortionFxProcessor processor;
    DistortionFxOptions options{};
    options.model = model;
    if (!check(DistortionFxProcessor::requiredPrepareBytes(makeSpec(), options) ==
                   sizeof(DistortionFxProcessor), "valid model has exact fixed-state preflight") ||
              !check(processor.prepare(makeSpec(), options), "distortion model prepares")) return result;
    const auto events = schedule();
    std::size_t eventIndex = 0U;
    for (std::uint32_t start = 0U; start < kFrames; start += blockFrames) {
        const auto count = std::min(blockFrames, kFrames - start);
        std::array<DistortionFxEvent, 64U> local{};
        std::uint32_t localCount = 0U;
        while (eventIndex < events.size() && events[eventIndex].frameOffset < start + count) {
            local[localCount] = events[eventIndex];
            local[localCount++].frameOffset -= start;
            ++eventIndex;
        }
        if (!processor.processBlock(start, result.audio.data() + start, count,
                                    localCount ? local.data() : nullptr, localCount)) return result;
    }
    result.ok = true;
    return result;
}

double maxDifference(const std::vector<StereoFrame>& left,
                     const std::vector<StereoFrame>& right) {
    double result = 0.0;
    for (std::size_t i = 0U; i < left.size(); ++i) {
        result = std::max(result, std::fabs(static_cast<double>(left[i].left) - right[i].left));
        result = std::max(result, std::fabs(static_cast<double>(left[i].right) - right[i].right));
    }
    return result;
}

std::uint32_t nonFiniteCount(const std::vector<StereoFrame>& audio) {
    std::uint32_t count = 0U;
    for (const auto& frame : audio)
        count += (!std::isfinite(frame.left) || !std::isfinite(frame.right)) ? 1U : 0U;
    return count;
}

double amplitudeAt(const std::vector<StereoFrame>& audio, bool left,
                   std::uint32_t begin, std::uint32_t count, double hz) {
    double real = 0.0;
    double imaginary = 0.0;
    double windowSum = 0.0;
    for (std::uint32_t i = 0U; i < count; ++i) {
        const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * i / (count - 1U));
        const double phase = 2.0 * kPi * hz * i / kSampleRate;
        const double value = left ? audio[begin + i].left : audio[begin + i].right;
        real += value * window * std::cos(phase);
        imaginary -= value * window * std::sin(phase);
        windowSum += window;
    }
    return 2.0 * std::hypot(real, imaginary) / std::max(1.0, windowSum);
}

double aliasEnergy(const std::vector<float>& audio, std::uint32_t begin,
                   std::uint32_t frames) {
    constexpr std::array<double, 5> aliasBins{{2000.0, 6000.0, 10000.0, 18000.0, 22000.0}};
    double windowSum = 0.0;
    for (std::uint32_t i = 0U; i < frames; ++i)
        windowSum += 0.5 - 0.5 * std::cos(2.0 * kPi * i / (frames - 1U));
    double total = 0.0;
    for (const auto hz : aliasBins) {
        double real = 0.0;
        double imaginary = 0.0;
        for (std::uint32_t i = 0U; i < frames; ++i) {
            const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * i / (frames - 1U));
            const double phase = 2.0 * kPi * hz * i / kSampleRate;
            real += audio[begin + i] * window * std::cos(phase);
            imaginary -= audio[begin + i] * window * std::sin(phase);
        }
        const double magnitude = 2.0 * std::hypot(real, imaginary) / windowSum;
        total += magnitude * magnitude;
    }
    return total;
}

void testPrepareAndTransactionBounds() {
    const auto spec = makeSpec();
    DistortionFxProcessor processor;
    DistortionFxOptions invalidModel{};
    invalidModel.model = static_cast<DistortionModel>(255U);
    check(DistortionFxProcessor::requiredPrepareBytes(spec, invalidModel) == 0U,
          "invalid model fails memory preflight");
    check(DistortionFxProcessor::requiredPrepareBytes({48000.0f, 256U, 1U}) == 0U,
          "mono ProcessSpec is rejected for the stereo processor");
    DistortionFxOptions invalidCircuit{};
    invalidCircuit.model = DistortionModel::SymmetricDiode4x;
    invalidCircuit.diodePortResistance = 0.0;
    check(DistortionFxProcessor::requiredPrepareBytes(spec, invalidCircuit) == 0U,
          "invalid WDF diode circuit values fail preflight");
    check(processor.prepare(spec), "ADAA distortion prepares");
    const auto latency = processor.latency();
    check(latency.fixedAlgorithmicSamples == 0 &&
          latency.frequencyDependentGroupDelaySamples > 21.0,
          "nonlinear delay is distinguished from whole-sample buffering");
    std::array<StereoFrame, 64U> block{};
    for (std::uint32_t i = 0U; i < block.size(); ++i)
        block[i] = {0.2f + 0.001f * i, -0.1f - 0.0005f * i};
    const auto before = block;
    const DistortionFxEvent invalid = event(10U, DistortionFxControl::Drive, 25.0f);
    check(!processor.processBlock(0U, block.data(), 64U, &invalid, 1U),
          "out-of-range parameter event is rejected");
    check(std::equal(block.begin(), block.end(), before.begin(), [](const auto& a, const auto& b) {
        return a.left == b.left && a.right == b.right;
    }), "invalid event leaves audio and processing state unchanged");
    const std::array<DistortionFxEvent, 2U> unsorted{{
        event(20U, DistortionFxControl::Drive, 2.0f),
        event(10U, DistortionFxControl::ToneHz, 8000.0f)}};
    check(!processor.processBlock(0U, block.data(), 64U, unsorted.data(), 2U),
          "unsorted event list is rejected transactionally");
    std::array<DistortionFxEvent, 65U> excessive{};
    for (std::uint32_t i = 0U; i < excessive.size(); ++i)
        excessive[i] = event(0U, DistortionFxControl::Active, 1.0f);
    check(!processor.processBlock(0U, block.data(), 64U, excessive.data(), 65U),
          "event count above the fixed callback cap is rejected");
    check(!processor.processBlock(65U, block.data(), 64U),
          "absolute callback gap is rejected");
    check(!processor.processBlock(std::numeric_limits<std::uint64_t>::max() - 4U,
                                  block.data(), 64U),
          "absolute frame overflow is rejected");
}

void testPartitionAndModelResponses() {
    const auto ada64 = render(DistortionModel::AdaaCubic4x, 64U);
    const auto ada128 = render(DistortionModel::AdaaCubic4x, 128U);
    const auto ada256 = render(DistortionModel::AdaaCubic4x, 256U);
    const auto wdf64 = render(DistortionModel::SymmetricDiode4x, 64U);
    const auto wdf256 = render(DistortionModel::SymmetricDiode4x, 256U);
    check(ada64.ok && ada128.ok && ada256.ok && wdf64.ok && wdf256.ok,
          "both nonlinear models render across the tested partitions");
    if (!(ada64.ok && ada128.ok && ada256.ok && wdf64.ok && wdf256.ok)) return;
    gPartitionDifference = std::max(maxDifference(ada64.audio, ada128.audio),
        std::max(maxDifference(ada128.audio, ada256.audio),
                 maxDifference(wdf64.audio, wdf256.audio)));
    check(gPartitionDifference < 1.0e-7,
          "sample-accurate modulation is invariant to 64/128/256 frame partitioning");
    check(nonFiniteCount(ada64.audio) == 0U && nonFiniteCount(wdf64.audio) == 0U,
          "both nonlinear models remain finite under drive/tone automation");
    gModelDifference = maxDifference(ada64.audio, wdf64.audio);
    check(gModelDifference > 1.0e-3,
          "Adaa and WDF options select distinct nonlinear responses");
}

void testStereoIsolationAndTone() {
    DistortionFxProcessor processor;
    check(processor.prepare(makeSpec()), "stereo ADAA distortion prepares");
    constexpr std::uint32_t total = 16384U;
    std::vector<StereoFrame> audio(total);
    const std::array<DistortionFxEvent, 4U> events{{
        event(0U, DistortionFxControl::Active, 1.0f),
        event(0U, DistortionFxControl::Mix, 1.0f),
        event(0U, DistortionFxControl::Drive, 3.0f),
        event(0U, DistortionFxControl::ToneHz, 16000.0f)}};
    for (std::uint32_t i = 0U; i < total; ++i) {
        const double t = static_cast<double>(i) / kSampleRate;
        audio[i] = {0.24f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * t)),
                    0.22f * static_cast<float>(std::sin(2.0 * kPi * 997.0 * t + 0.17))};
    }
    for (std::uint32_t start = 0U; start < total; start += 256U) {
        const auto count = std::min(256U, total - start);
        check(processor.processBlock(start, audio.data() + start, count,
            start == 0U ? events.data() : nullptr,
            start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U),
            "stereo tone fixture processes");
    }
    gStereoLeakLeft = amplitudeAt(audio, true, 8192U, 8192U, 997.0);
    gStereoLeakRight = amplitudeAt(audio, false, 8192U, 8192U, 440.0);
    check(gStereoLeakLeft < 1.0e-4 && gStereoLeakRight < 1.0e-4,
          "nonlinear state remains independent between left and right channels");

    DistortionFxProcessor lowTone;
    check(lowTone.prepare(makeSpec()), "tone-cutoff probe prepares");
    constexpr std::uint32_t toneFrames = 16384U;
    std::vector<StereoFrame> mixture(toneFrames);
    const std::array<DistortionFxEvent, 4U> lowEvents{{
        event(0U, DistortionFxControl::Active, 1.0f),
        event(0U, DistortionFxControl::Mix, 1.0f),
        event(0U, DistortionFxControl::Drive, 1.0f),
        event(0U, DistortionFxControl::ToneHz, 1000.0f)}};
    for (std::uint32_t i = 0U; i < toneFrames; ++i) {
        const double t = static_cast<double>(i) / kSampleRate;
        const float value = 0.15f * static_cast<float>(
            std::sin(2.0 * kPi * 440.0 * t) + std::sin(2.0 * kPi * 12000.0 * t));
        mixture[i] = {value, value};
    }
    for (std::uint32_t start = 0U; start < toneFrames; start += 256U) {
        const auto count = std::min(256U, toneFrames - start);
        check(lowTone.processBlock(start, mixture.data() + start, count,
            start == 0U ? lowEvents.data() : nullptr,
            start == 0U ? static_cast<std::uint32_t>(lowEvents.size()) : 0U),
            "tone cutoff fixture processes");
    }
    const auto lowAmplitude = amplitudeAt(mixture, true, 8192U, 8192U, 440.0);
    const auto highAmplitude = amplitudeAt(mixture, true, 8192U, 8192U, 12000.0);
    gToneRatio = highAmplitude / std::max(1.0e-12, lowAmplitude);
    check(lowAmplitude > 0.05 && gToneRatio < 0.2,
          "post-shaper tone control attenuates upper partials while retaining the low tone");
}

void testAdaaReferenceAndAliasing() {
    constexpr std::uint32_t total = 48000U;
    std::vector<StereoFrame> actual(total);
    std::vector<float> reference4x(total);
    std::vector<float> reference1x(total);
    DistortionFxProcessor processor;
    check(processor.prepare(makeSpec()), "4x ADAA processor prepares for spectral fixture");
    OversampledNonlinear fourX;
    AdaaCubicShaper oneX;
    check(fourX.prepare(makeSpec(), OversamplingFactor::x4, NonlinearModel::AdaaCubic) &&
          oneX.prepare(makeSpec()), "reference 4x and 1x paths prepare");
    const std::array<DistortionFxEvent, 4U> events{{
        event(0U, DistortionFxControl::Active, 1.0f),
        event(0U, DistortionFxControl::Mix, 1.0f),
        event(0U, DistortionFxControl::Drive, 24.0f),
        event(0U, DistortionFxControl::ToneHz, 18000.0f)}};
    for (std::uint32_t start = 0U; start < total; start += 256U) {
        const auto count = std::min(256U, total - start);
        for (std::uint32_t i = 0U; i < count; ++i) {
            const auto frame = start + i;
            const float input = 0.72f * static_cast<float>(
                std::sin(2.0 * kPi * 14000.0 * frame / kSampleRate));
            actual[frame] = {input, 0.0f};
            reference4x[frame] = fourX.processSample(input * 24.0f);
            reference1x[frame] = oneX.processSample(input * 24.0f);
        }
        check(processor.processBlock(start, actual.data() + start, count,
            start == 0U ? events.data() : nullptr,
            start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U),
            "4x ADAA spectral fixture processes");
    }
    constexpr std::uint32_t begin = 24000U;
    constexpr std::uint32_t windowFrames = 8192U;
    double toneState = 0.0;
    const double toneAlpha = 1.0 - std::exp(-2.0 * kPi * 18000.0 / kSampleRate);
    for (std::uint32_t i = 0U; i < begin + windowFrames; ++i) {
        toneState += toneAlpha * (static_cast<double>(reference4x[i]) - toneState);
        if (i >= begin)
            gReferenceMaximumError = std::max(gReferenceMaximumError,
                std::fabs(static_cast<double>(actual[i].left) - toneState));
    }
    gAliasRatio4xVs1x = aliasEnergy(reference4x, begin, windowFrames) /
        std::max(1.0e-20, aliasEnergy(reference1x, begin, windowFrames));
    check(gReferenceMaximumError < 2.0e-3,
          "stereo DIST output matches the standalone 4x ADAA plus prepared tone reference");
    check(std::isfinite(gAliasRatio4xVs1x) && gAliasRatio4xVs1x < 0.5,
          "4x ADAA reduces measured folded energy versus 1x ADAA");
}

void testWorstEventBurstNoAllocation() {
    DistortionFxProcessor processor;
    check(processor.prepare(makeSpec(64U)), "processor prepares for 64-event guard");
    std::array<StereoFrame, 64U> block{};
    std::array<DistortionFxEvent, 64U> events{};
    for (std::uint32_t i = 0U; i < events.size(); ++i) {
        const auto control = static_cast<DistortionFxControl>(i % 5U);
        float value = 1.0f;
        switch (control) {
        case DistortionFxControl::Active: value = (i & 1U) ? 0.85f : 1.0f; break;
        case DistortionFxControl::Mix: value = (i & 1U) ? 0.72f : 0.91f; break;
        case DistortionFxControl::Drive: value = (i & 1U) ? 4.0f : 12.0f; break;
        case DistortionFxControl::ToneHz: value = (i & 1U) ? 2400.0f : 9000.0f; break;
        case DistortionFxControl::OutputDb: value = (i & 1U) ? -3.0f : 2.0f; break;
        }
        events[i] = event(i, control, value);
        block[i] = {0.35f * std::sin(static_cast<float>(i) * 0.07f),
                    0.28f * std::cos(static_cast<float>(i) * 0.11f)};
    }
    const auto allocationsBefore = gAllocations.load(std::memory_order_relaxed);
    const auto freesBefore = gFrees.load(std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    bool accepted = true;
    for (std::uint32_t blockIndex = 0U; blockIndex < 128U; ++blockIndex) {
        accepted = accepted && processor.processBlock(blockIndex * 64U, block.data(), 64U,
                                                       events.data(), 64U);
    }
    gWatchAllocations.store(false, std::memory_order_relaxed);
    gCallbackAllocations =
        (gAllocations.load(std::memory_order_relaxed) - allocationsBefore) +
        (gFrees.load(std::memory_order_relaxed) - freesBefore);
    check(accepted, "maximum-size ordered event bursts process");
    check(gCallbackAllocations == 0U,
          "maximum-size parameter bursts allocate or free no callback memory");
}

void emitQualityJson() {
    std::printf("{\"schemaVersion\":1,\"suite\":\"distortion-fx\",\"sampleRate\":%u,"
                "\"partitionMaximumDifference\":%.12g,\"modelMaximumDifference\":%.12g,"
                "\"stereoLeakAmplitude\":[%.12g,%.12g],\"tone12000To440Ratio\":%.12g,"
                "\"fourXReferenceMaxError\":%.12g,\"aliasEnergyRatio4xVs1x\":%.12g,"
                "\"eventBurstAllocationsAndFrees\":%llu}\n",
                kSampleRate, gPartitionDifference, gModelDifference, gStereoLeakLeft,
                gStereoLeakRight, gToneRatio, gReferenceMaximumError, gAliasRatio4xVs1x,
                static_cast<unsigned long long>(gCallbackAllocations));
}

} // namespace

int main() {
    testPrepareAndTransactionBounds();
    testPartitionAndModelResponses();
    testStereoIsolationAndTone();
    testAdaaReferenceAndAliasing();
    testWorstEventBurstNoAllocation();
    emitQualityJson();
    if (gFailures != 0) {
        std::fprintf(stderr, "distortion_fx_tests: %d failure(s)\n", gFailures);
        return EXIT_FAILURE;
    }
    std::puts("DIST adapter: two oversampled nonlinear models, stereo/tone, partition and callback guards passed");
    return EXIT_SUCCESS;
}
