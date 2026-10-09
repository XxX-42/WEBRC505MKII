#include "webrc/dsp/spatial_fx_adapters.hpp"

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

std::atomic<bool> gCountAllocations{false};
std::atomic<std::uint64_t> gAllocations{0U};
std::atomic<std::uint64_t> gDeallocations{0U};

void* operator new(std::size_t size) {
    if (gCountAllocations.load(std::memory_order_relaxed))
        gAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (gCountAllocations.load(std::memory_order_relaxed))
        gAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}

void operator delete(void* pointer) noexcept {
    if (pointer != nullptr && gCountAllocations.load(std::memory_order_relaxed))
        gDeallocations.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}

void operator delete[](void* pointer) noexcept {
    if (pointer != nullptr && gCountAllocations.load(std::memory_order_relaxed))
        gDeallocations.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}

void operator delete(void* pointer, std::size_t) noexcept { operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { operator delete[](pointer); }

namespace {

using namespace webrc::dsp;

int gFailures = 0;
double gReversePartitionMaximumDifference = 0.0;
double gReverseMaximumAdjacentStep = 0.0;
std::uint32_t gReverseLeftPeakFrame = 0U;
std::uint32_t gReverseRightPeakFrame = 0U;
float gReverseLeftPeak = 0.0f;
float gReverseRightPeak = 0.0f;
double gGateShortEarlyEnergy = 0.0;
double gGateShortLateEnergy = 0.0;
double gGateLongLateEnergy = 0.0;
double gClosedGateWetOneMaximum = 0.0;
double gClosedGateHalfWetMaximumError = 0.0;
double gReverseReverbEarlyEnergy = 0.0;
double gReverseReverbLateEnergy = 0.0;
double gReverseReverbRightEnergy = 0.0;
std::uint64_t gGateBurstAllocations = 0U;
std::uint64_t gFdnBurstAllocations = 0U;
std::uint64_t gDelayBurstAllocations = 0U;

struct ImpulseMetrics {
    std::uint32_t firstNonzeroFrame = 0U;
    std::uint32_t firstNonzeroAtOrAfterWetWarmupFrame = 0U;
    std::uint32_t peakFrame = 0U;
    float peak = 0.0f;
    double energy = 0.0;
    double leftEnergy = 0.0;
    double rightEnergy = 0.0;
    double rightToLeftEnergyRatio = 0.0;
};

std::array<ImpulseMetrics, 3> gImpulseMetrics{};

void check(bool condition, const char* message) {
    if (condition) return;
    std::fprintf(stderr, "FAIL: %s\n", message);
    ++gFailures;
}

ProcessSpec spec(std::uint32_t maxBlock = 256U) {
    return {48000.0f, maxBlock, 2U};
}

SpatialFxPrepareOptions shortReverseOptions() {
    SpatialFxPrepareOptions options{};
    options.maximumReverseSeconds = 0.20003f;
    options.reverseSegmentSeconds = 0.100123f;
    options.reverseCrossfadeSeconds = 0.00517f;
    return options;
}

bool processInChunks(SpatialFxAdapter& processor, std::vector<StereoFrame>& signal,
                     std::uint64_t startFrame, std::uint32_t chunkSize,
                     const SpatialFxEvent* events = nullptr,
                     std::uint32_t eventCount = 0U) {
    std::uint32_t frame = 0U;
    std::uint32_t eventIndex = 0U;
    while (frame < signal.size()) {
        const auto count = std::min<std::uint32_t>(chunkSize,
            static_cast<std::uint32_t>(signal.size() - frame));
        std::array<SpatialFxEvent, SpatialFxAdapter::kMaximumControlEventsPerBlock> local{};
        std::uint32_t localCount = 0U;
        const auto blockEnd = frame + count;
        while (eventIndex < eventCount && events[eventIndex].frameOffset < blockEnd) {
            if (events[eventIndex].frameOffset < frame) return false;
            auto event = events[eventIndex++];
            event.frameOffset -= frame;
            if (localCount >= local.size()) return false;
            local[localCount++] = event;
        }
        if (!processor.processBlock(startFrame + frame, signal.data() + frame, count,
                                    local.data(), localCount)) return false;
        frame += count;
    }
    return eventIndex == eventCount;
}

void testMappingsAndPreflight() {
    const auto stereo = spec();
    check(SpatialFxAdapter::effectOrdinal(SpatialFxKind::ReverseDelay) == 38U,
          "reverse delay uses stable catalog ordinal 38");
    check(SpatialFxAdapter::effectOrdinal(SpatialFxKind::GateReverb) == 48U,
          "gate reverb uses stable catalog ordinal 48");
    check(SpatialFxAdapter::effectOrdinal(SpatialFxKind::ReverseReverb) == 49U,
          "reverse reverb uses stable catalog ordinal 49");
    const auto reverseBudget = SpatialFxAdapter::requiredPrepareBytes(
        stereo, SpatialFxKind::ReverseDelay, shortReverseOptions());
    const auto gateBudget = SpatialFxAdapter::requiredPrepareBytes(
        stereo, SpatialFxKind::GateReverb);
    const auto reverseReverbBudget = SpatialFxAdapter::requiredPrepareBytes(
        stereo, SpatialFxKind::ReverseReverb, shortReverseOptions());
    check(reverseBudget >= sizeof(SpatialFxAdapter) && gateBudget >= sizeof(SpatialFxAdapter) &&
          reverseReverbBudget > gateBudget && reverseReverbBudget > reverseBudget,
          "preflight reserves wrapper and exact nested primitive reservations");
    auto invalid = shortReverseOptions();
    invalid.reverseSegmentSeconds = 0.21f;
    check(SpatialFxAdapter::requiredPrepareBytes(stereo, SpatialFxKind::ReverseDelay, invalid) == 0U,
          "preflight rejects segment beyond history before allocation");
    check(SpatialFxAdapter::requiredPrepareBytes({48000.0f, 64U, 1U},
              SpatialFxKind::GateReverb) == 0U,
          "spatial adapter preflight rejects mono graph");
    check(SpatialFxAdapter::requiredPrepareBytes(stereo, static_cast<SpatialFxKind>(99U)) == 0U,
          "preflight rejects unknown kind");
}

void testReverseDelayStereoAndPartitioning() {
    const auto options = shortReverseOptions();
    const auto configuration = spec(256U);
    SpatialFxAdapter whole;
    SpatialFxAdapter partitioned;
    check(whole.prepare(configuration, SpatialFxKind::ReverseDelay, options),
          "reverse delay prepares for stereo");
    check(partitioned.prepare(configuration, SpatialFxKind::ReverseDelay, options),
          "second reverse delay prepares for partition comparison");
    check(whole.algorithmicLatencySamples() == 0U &&
          whole.wetPathWarmupSamples() == 9364U,
          "noninteger reverse geometry rounds once and reports explicit wet-path warmup");

    constexpr std::uint32_t totalFrames = 26000U;
    std::vector<StereoFrame> source(totalFrames);
    source[100U].left = 1.0f;
    source[400U].right = -0.6f;
    auto a = source;
    auto b = source;
    check(whole.processBlock(0U, a.data(), totalFrames, nullptr, 0U) == false,
          "oversized block is rejected transactionally");
    check(processInChunks(whole, a, 0U, 256U), "reverse delay processes fixed 256-frame chunks");

    std::uint32_t cursor = 0U;
    const std::array<std::uint32_t, 3> chunks{{64U, 128U, 256U}};
    std::uint32_t chunkIndex = 0U;
    while (cursor < totalFrames) {
        const auto count = std::min(chunks[chunkIndex++ % chunks.size()], totalFrames - cursor);
        check(partitioned.processBlock(cursor, b.data() + cursor, count, nullptr, 0U),
              "reverse delay accepts mixed callback partition");
        cursor += count;
    }
    double maximumDifference = 0.0;
    std::uint32_t leftPeak = 0U;
    std::uint32_t rightPeak = 0U;
    float leftPeakValue = 0.0f;
    float rightPeakValue = 0.0f;
    for (std::uint32_t i = 0U; i < totalFrames; ++i) {
        maximumDifference = std::max(maximumDifference,
            std::max(std::abs(static_cast<double>(a[i].left - b[i].left)),
                     std::abs(static_cast<double>(a[i].right - b[i].right))));
        if (i >= 9500U && std::abs(a[i].left) > leftPeakValue) {
            leftPeakValue = std::abs(a[i].left);
            leftPeak = i;
        }
        if (i >= 9500U && std::abs(a[i].right) > rightPeakValue) {
            rightPeakValue = std::abs(a[i].right);
            rightPeak = i;
        }
    }
    check(maximumDifference == 0.0, "reverse output is invariant to callback partitioning");
    check(leftPeakValue > 0.25f && rightPeakValue > 0.1f,
          "reverse delay renders both independent stereo impulse histories");
    check(leftPeak > rightPeak && leftPeak - rightPeak >= 250U && leftPeak - rightPeak <= 350U,
          "different L/R impulse times remain distinct after reverse processing");
    gReversePartitionMaximumDifference = maximumDifference;
    gReverseLeftPeakFrame = leftPeak;
    gReverseRightPeakFrame = rightPeak;
    gReverseLeftPeak = leftPeakValue;
    gReverseRightPeak = rightPeakValue;

    SpatialFxAdapter smooth;
    check(smooth.prepare(configuration, SpatialFxKind::ReverseDelay, options),
          "reverse transition fixture prepares");
    std::vector<StereoFrame> tone(totalFrames);
    for (std::uint32_t i = 0U; i < tone.size(); ++i) {
        tone[i].left = 0.4f * std::sin(static_cast<float>(2.0 * 3.141592653589793 * 440.0 * i / 48000.0));
        tone[i].right = 0.3f * std::cos(static_cast<float>(2.0 * 3.141592653589793 * 997.0 * i / 48000.0));
    }
    check(processInChunks(smooth, tone, 0U, 128U),
          "reverse transition tone processes through several segment joins");
    double maximumAdjacentStep = 0.0;
    for (std::uint32_t i = 1U; i < tone.size(); ++i) {
        maximumAdjacentStep = std::max(maximumAdjacentStep,
            std::max(std::abs(static_cast<double>(tone[i].left - tone[i - 1U].left)),
                     std::abs(static_cast<double>(tone[i].right - tone[i - 1U].right))));
    }
    check(maximumAdjacentStep < 0.20,
          "initial reverse transition and repeated segment joins stay below 0.20 full-scale/sample");
    gReverseMaximumAdjacentStep = maximumAdjacentStep;

    SpatialFxEvent invalid[]{{0U, SpatialFxControl::Wet, 0.1f},
                             {1U, SpatialFxControl::Feedback, 0.91f}};
    const auto oldWet = whole.wet();
    std::array<StereoFrame, 64> invalidBuffer{};
    check(!whole.processBlock(totalFrames, invalidBuffer.data(), 64U, invalid, 2U),
          "invalid event in batch rejects full block");
    check(whole.wet() == oldWet, "invalid batch applies no preceding events");
}

void renderGateImpulse(float holdMs, float releaseMs, std::vector<StereoFrame>& output) {
    SpatialFxAdapter gate;
    check(gate.prepare(spec(256U), SpatialFxKind::GateReverb), "gate reverb prepares");
    const SpatialFxEvent events[]{{0U, SpatialFxControl::GateThresholdDb, -80.0f},
                                  {0U, SpatialFxControl::GateHoldMs, holdMs},
                                  {0U, SpatialFxControl::GateReleaseMs, releaseMs}};
    output.assign(24000U, {});
    output[0U] = {0.7f, -0.15f};
    check(processInChunks(gate, output, 0U, 256U, events, 3U),
          "gate reverb processes an impulse and sample-zero control batch");
}

double energy(const std::vector<StereoFrame>& signal, std::uint32_t begin, std::uint32_t end) {
    double total = 0.0;
    end = std::min<std::uint32_t>(end, static_cast<std::uint32_t>(signal.size()));
    for (std::uint32_t i = begin; i < end; ++i)
        total += static_cast<double>(signal[i].left) * signal[i].left +
                 static_cast<double>(signal[i].right) * signal[i].right;
    return total;
}

void testGateReverbTailAndStereo() {
    std::vector<StereoFrame> shortGate;
    std::vector<StereoFrame> longGate;
    renderGateImpulse(0.0f, 5.0f, shortGate);
    renderGateImpulse(250.0f, 1000.0f, longGate);
    const auto shortEarly = energy(shortGate, 400U, 6000U);
    const auto shortLate = energy(shortGate, 12000U, 18000U);
    const auto longLate = energy(longGate, 12000U, 18000U);
    check(shortEarly > 1.0e-5, "gate reverb produces an audible early wet response");
    check(longLate > 1.0e-5 && shortLate < longLate * 0.05,
          "gate hold/release controls shorten the reverb return while long hold preserves tail");
    double stereoDifference = 0.0;
    for (std::uint32_t i = 1U; i < 6000U; ++i)
        stereoDifference += std::abs(static_cast<double>(longGate[i].left - longGate[i].right));
    check(stereoDifference > 1.0e-3, "gate reverb preserves a distinct true-stereo response");
    gGateShortEarlyEnergy = shortEarly;
    gGateShortLateEnergy = shortLate;
    gGateLongLateEnergy = longLate;

    SpatialFxAdapter wetOne;
    SpatialFxAdapter halfWet;
    check(wetOne.prepare(spec(64U), SpatialFxKind::GateReverb), "closed wet-one fixture prepares");
    check(halfWet.prepare(spec(64U), SpatialFxKind::GateReverb), "closed half-wet fixture prepares");
    std::array<StereoFrame, 64> muted{};
    std::array<StereoFrame, 64> halfDry{};
    std::array<StereoFrame, 64> warmup{};
    muted.fill({0.25f, -0.125f});
    halfDry = muted;
    const SpatialFxEvent wetOneClosed[]{{0U, SpatialFxControl::Wet, 1.0f},
                                        {0U, SpatialFxControl::GateThresholdDb, 0.0f}};
    const SpatialFxEvent halfWetClosed[]{{0U, SpatialFxControl::Wet, 0.5f},
                                         {0U, SpatialFxControl::GateThresholdDb, 0.0f}};
    check(wetOne.processBlock(0U, warmup.data(), 64U, wetOneClosed, 2U),
          "closed wet-one mix target is queued");
    wetOne.reset(64U); // reset is a setup operation and starts the wet control at its target.
    check(wetOne.processBlock(64U, muted.data(), 64U) &&
          halfWet.processBlock(0U, halfDry.data(), 64U, halfWetClosed, 2U),
          "closed-gate wet/dry fixtures process");
    double wetOneMaximum = 0.0;
    double halfWetMaximumError = 0.0;
    for (std::uint32_t i = 0U; i < muted.size(); ++i) {
        wetOneMaximum = std::max(wetOneMaximum,
            std::max(std::abs(static_cast<double>(muted[i].left)),
                     std::abs(static_cast<double>(muted[i].right))));
        halfWetMaximumError = std::max(halfWetMaximumError,
            std::max(std::abs(static_cast<double>(halfDry[i].left - 0.125f)),
                     std::abs(static_cast<double>(halfDry[i].right + 0.0625f))));
        check(std::abs(muted[i].left) < 1.0e-7f && std::abs(muted[i].right) < 1.0e-7f,
              "closed wet-one gate returns silence");
        check(std::abs(halfDry[i].left - 0.125f) < 1.0e-6f &&
              std::abs(halfDry[i].right + 0.0625f) < 1.0e-6f,
              "closed half-wet gate preserves a fixed half-level dry coefficient");
    }
    gClosedGateWetOneMaximum = wetOneMaximum;
    gClosedGateHalfWetMaximumError = halfWetMaximumError;
}

void testReverseReverbWetStaging() {
    const auto options = shortReverseOptions();
    SpatialFxAdapter reverseReverb;
    check(reverseReverb.prepare(spec(256U), SpatialFxKind::ReverseReverb, options),
          "reverse reverb prepares FDN and reverse histories");
    check(reverseReverb.algorithmicLatencySamples() == 0U &&
          reverseReverb.wetPathWarmupSamples() == 9364U,
          "reverse reverb separates dry latency from its wet reverse staging interval");
    constexpr std::uint32_t totalFrames = 30000U;
    std::vector<StereoFrame> signal(totalFrames);
    signal[0U] = {0.8f, 0.0f};
    check(processInChunks(reverseReverb, signal, 0U, 128U),
          "reverse reverb processes through its reverse window");
    double early = 0.0;
    double later = 0.0;
    double rightEnergy = 0.0;
    for (std::uint32_t i = 0U; i < signal.size(); ++i) {
        const double l = signal[i].left;
        const double r = signal[i].right;
        if (i < 9000U) early += l * l + r * r;
        if (i >= 10000U) later += l * l + r * r;
        rightEnergy += r * r;
        check(std::isfinite(signal[i].left) && std::isfinite(signal[i].right),
              "reverse reverb output stays finite");
    }
    check(early > 0.01 && later > 1.0e-5,
          "reverse reverb has immediate FDN return and staged reversed tail");
    check(rightEnergy > 1.0e-6, "reverse reverb FDN creates a real stereo return from mono input");
    gReverseReverbEarlyEnergy = early;
    gReverseReverbLateEnergy = later;
    gReverseReverbRightEnergy = rightEnergy;
}

ImpulseMetrics renderWetOneImpulse(SpatialFxKind kind) {
    const auto options = shortReverseOptions();
    SpatialFxAdapter processor;
    if (!processor.prepare(spec(256U), kind, options)) {
        check(false, "wet-one impulse adapter prepares");
        return {};
    }
    constexpr std::uint32_t frameCount = 30000U;
    std::vector<StereoFrame> signal(frameCount);
    signal[3000U].left = 0.7f;
    std::array<SpatialFxEvent, 4> events{};
    std::uint32_t eventCount = 0U;
    events[eventCount++] = {0U, SpatialFxControl::Wet, 1.0f};
    if (kind == SpatialFxKind::GateReverb) {
        events[eventCount++] = {0U, SpatialFxControl::GateThresholdDb, -80.0f};
        events[eventCount++] = {0U, SpatialFxControl::GateHoldMs, 100.0f};
        events[eventCount++] = {0U, SpatialFxControl::GateReleaseMs, 120.0f};
    }
    check(processInChunks(processor, signal, 0U, 256U, events.data(), eventCount),
          "wet-one mono impulse is rendered through all stereo output channels");

    ImpulseMetrics metrics{};
    const auto wetWarmup = processor.wetPathWarmupSamples();
    metrics.firstNonzeroFrame = frameCount;
    metrics.firstNonzeroAtOrAfterWetWarmupFrame = frameCount;
    for (std::uint32_t frame = 0U; frame < frameCount; ++frame) {
        const auto& sample = signal[frame];
        check(std::isfinite(sample.left) && std::isfinite(sample.right),
              "wet-one impulse response stays finite");
        const float magnitude = std::max(std::abs(sample.left), std::abs(sample.right));
        if (magnitude > 1.0e-7f && metrics.firstNonzeroFrame == frameCount)
            metrics.firstNonzeroFrame = frame;
        if (frame >= wetWarmup && magnitude > 1.0e-7f &&
            metrics.firstNonzeroAtOrAfterWetWarmupFrame == frameCount)
            metrics.firstNonzeroAtOrAfterWetWarmupFrame = frame;
        if (magnitude > metrics.peak) {
            metrics.peak = magnitude;
            metrics.peakFrame = frame;
        }
        metrics.leftEnergy += static_cast<double>(sample.left) * sample.left;
        metrics.rightEnergy += static_cast<double>(sample.right) * sample.right;
    }
    metrics.energy = metrics.leftEnergy + metrics.rightEnergy;
    metrics.rightToLeftEnergyRatio = metrics.leftEnergy > 1.0e-20
        ? metrics.rightEnergy / metrics.leftEnergy : 0.0;
    check(metrics.firstNonzeroFrame == 3000U,
          "wet-one impulse includes immediate live/dry response at its input frame");
    check(metrics.firstNonzeroAtOrAfterWetWarmupFrame < frameCount,
          "wet-one impulse has nonzero response after declared reverse staging");
    check(metrics.peak > 0.05f && metrics.energy > 1.0e-3,
          "wet-one impulse has a measurable peak and finite response energy");
    if (kind == SpatialFxKind::ReverseDelay) {
        check(metrics.rightEnergy < 1.0e-12,
              "reverse delay keeps left-only impulse out of right channel");
        check(metrics.firstNonzeroAtOrAfterWetWarmupFrame == 11169U,
              "reverse-delay noninteger segment impulse lands at measured reverse frame");
    } else {
        check(metrics.rightEnergy > 1.0e-6,
              "FDN-backed stereo effect produces measured left-to-right crossfeed");
    }
    return metrics;
}

void testWetOneImpulseMetricsAndCrossfeed() {
    gImpulseMetrics[0] = renderWetOneImpulse(SpatialFxKind::ReverseDelay);
    gImpulseMetrics[1] = renderWetOneImpulse(SpatialFxKind::GateReverb);
    gImpulseMetrics[2] = renderWetOneImpulse(SpatialFxKind::ReverseReverb);
}

void testEventBurstAndNoProcessAllocation() {
    SpatialFxAdapter processor;
    check(processor.prepare(spec(64U), SpatialFxKind::GateReverb),
          "event burst gate reverb prepares");
    std::array<SpatialFxEvent, SpatialFxAdapter::kMaximumControlEventsPerBlock> events{};
    for (std::uint32_t i = 0U; i < events.size(); ++i) {
        events[i].frameOffset = i;
        events[i].control = (i & 1U) == 0U ? SpatialFxControl::Wet : SpatialFxControl::Active;
        events[i].value = (i & 1U) == 0U ? static_cast<float>(i % 11U) / 10.0f
                                         : static_cast<float>((i / 2U) & 1U);
    }
    std::array<StereoFrame, 64> data{};
    for (std::uint32_t i = 0U; i < data.size(); ++i)
        data[i] = {0.2f * std::sin(static_cast<float>(i) * 0.13f),
                   0.17f * std::cos(static_cast<float>(i) * 0.11f)};
    gAllocations.store(0U, std::memory_order_relaxed);
    gDeallocations.store(0U, std::memory_order_relaxed);
    gCountAllocations.store(true, std::memory_order_release);
    const bool accepted = processor.processBlock(0U, data.data(), 64U, events.data(),
                                                  static_cast<std::uint32_t>(events.size()));
    gCountAllocations.store(false, std::memory_order_release);
    check(accepted, "64-event same-block gate automation is accepted");
    gGateBurstAllocations = gAllocations.load(std::memory_order_relaxed) +
                            gDeallocations.load(std::memory_order_relaxed);
    check(gGateBurstAllocations == 0U,
          "spatial callback performs no allocation or deallocation under 64 events");

    SpatialFxAdapter fdnBurst;
    check(fdnBurst.prepare(spec(64U), SpatialFxKind::GateReverb),
          "FDN parameter event burst instance prepares");
    std::array<SpatialFxEvent, SpatialFxAdapter::kMaximumControlEventsPerBlock> reverbEvents{};
    for (std::uint32_t i = 0U; i < reverbEvents.size(); ++i) {
        const auto frame = i;
        switch (i % 8U) {
        case 0U: reverbEvents[i] = {frame, SpatialFxControl::ReverbTimeSeconds, 0.5f + 0.1f * (i % 5U)}; break;
        case 1U: reverbEvents[i] = {frame, SpatialFxControl::DampingHz, 1200.0f + 70.0f * (i % 9U)}; break;
        case 2U: reverbEvents[i] = {frame, SpatialFxControl::ModulationRateHz, 0.2f + 0.03f * (i % 8U)}; break;
        case 3U: reverbEvents[i] = {frame, SpatialFxControl::ModulationDepthMs, 0.1f + 0.02f * (i % 8U)}; break;
        case 4U: reverbEvents[i] = {frame, SpatialFxControl::GateThresholdDb, -20.0f - 0.5f * (i % 8U)}; break;
        case 5U: reverbEvents[i] = {frame, SpatialFxControl::GateHoldMs, 30.0f + static_cast<float>(i % 8U)}; break;
        case 6U: reverbEvents[i] = {frame, SpatialFxControl::GateReleaseMs, 80.0f + 2.0f * (i % 8U)}; break;
        default: reverbEvents[i] = {frame, SpatialFxControl::Wet, static_cast<float>(i % 10U) / 10.0f}; break;
        }
    }
    data.fill({0.15f, -0.12f});
    gAllocations.store(0U, std::memory_order_relaxed);
    gDeallocations.store(0U, std::memory_order_relaxed);
    gCountAllocations.store(true, std::memory_order_release);
    const bool fdnAccepted = fdnBurst.processBlock(0U, data.data(), 64U, reverbEvents.data(),
                                                   static_cast<std::uint32_t>(reverbEvents.size()));
    gCountAllocations.store(false, std::memory_order_release);
    gFdnBurstAllocations = gAllocations.load(std::memory_order_relaxed) +
                           gDeallocations.load(std::memory_order_relaxed);
    check(fdnAccepted && gFdnBurstAllocations == 0U,
          "64-event gate/FDN parameter burst performs no process allocation or free");

    SpatialFxAdapter delayed;
    const auto shortOptions = shortReverseOptions();
    check(delayed.prepare(spec(64U), SpatialFxKind::ReverseDelay, shortOptions),
          "delay burst instance prepares");
    std::array<SpatialFxEvent, SpatialFxAdapter::kMaximumControlEventsPerBlock> delayEvents{};
    for (std::uint32_t i = 0U; i < delayEvents.size(); ++i) {
        delayEvents[i] = {i, SpatialFxControl::Wet, static_cast<float>(i & 1U)};
    }
    data.fill({0.1f, -0.1f});
    gAllocations.store(0U, std::memory_order_relaxed);
    gDeallocations.store(0U, std::memory_order_relaxed);
    gCountAllocations.store(true, std::memory_order_release);
    const bool delayAccepted = delayed.processBlock(0U, data.data(), 64U, delayEvents.data(),
                                                    static_cast<std::uint32_t>(delayEvents.size()));
    gCountAllocations.store(false, std::memory_order_release);
    gDelayBurstAllocations = gAllocations.load(std::memory_order_relaxed) +
                             gDeallocations.load(std::memory_order_relaxed);
    check(delayAccepted && gDelayBurstAllocations == 0U,
          "reverse-delay callback stays allocation-free with maximum event burst");

    std::array<SpatialFxEvent, SpatialFxAdapter::kMaximumControlEventsPerBlock + 1U> tooMany{};
    for (std::uint32_t i = 0U; i < tooMany.size(); ++i)
        tooMany[i] = {i % 64U, SpatialFxControl::Wet, 0.5f};
    const float beforeRejectedBurst = processor.wet();
    check(!processor.processBlock(64U, data.data(), 64U, tooMany.data(),
                                 static_cast<std::uint32_t>(tooMany.size())),
          "65th control event is rejected before callback work");
    check(processor.wet() == beforeRejectedBurst,
          "over-capacity event burst leaves the active adapter unchanged");
}

void testFrameAndParameterBoundsAreTransactional() {
    SpatialFxAdapter processor;
    check(processor.prepare(spec(64U), SpatialFxKind::ReverseDelay, shortReverseOptions()),
          "transactional reverse delay prepares");
    std::array<StereoFrame, 64> block{};
    const SpatialFxEvent validThenInvalid[]{{0U, SpatialFxControl::Wet, 0.1f},
                                            {1U, SpatialFxControl::Feedback, 0.95f}};
    const float wetBefore = processor.wet();
    check(!processor.processBlock(100U, block.data(), 64U, validThenInvalid, 2U),
          "invalid parameter rejects the whole block before mutation");
    check(processor.wet() == wetBefore, "rejected parameter batch preserves controls");
    processor.reset(100U);
    check(processor.processBlock(100U, block.data(), 64U), "first timeline block is accepted");
    check(!processor.processBlock(165U, block.data(), 64U), "noncontiguous timeline is rejected");
    const SpatialFxEvent outOfOrder[]{{1U, SpatialFxControl::Wet, 0.2f},
                                      {0U, SpatialFxControl::Wet, 0.8f}};
    const float currentWet = processor.wet();
    check(!processor.processBlock(164U, block.data(), 64U, outOfOrder, 2U),
          "unordered sample-accurate event list is rejected");
    check(processor.wet() == currentWet, "unordered events do not change adapter targets");
    check(!processor.processBlock(std::numeric_limits<std::uint64_t>::max() - 10U,
                                  block.data(), 64U),
          "absolute frame overflow is rejected before processing");
}

} // namespace

int main() {
    testMappingsAndPreflight();
    testReverseDelayStereoAndPartitioning();
    testGateReverbTailAndStereo();
    testReverseReverbWetStaging();
    testWetOneImpulseMetricsAndCrossfeed();
    testEventBurstAndNoProcessAllocation();
    testFrameAndParameterBoundsAreTransactional();
    std::printf(
        "{\"schemaVersion\":1,\"suite\":\"spatial-fx-adapters\","
        "\"sampleRate\":48000,\"reverseDelay\":{\"segmentSeconds\":0.100123,"
        "\"crossfadeSeconds\":0.00517,\"segmentFrames\":4806,"
        "\"crossfadeFrames\":248,\"wetPathWarmupFrames\":9364,"
        "\"leftPeakFrame\":%u,\"leftPeak\":%.9g,\"rightPeakFrame\":%u,"
        "\"rightPeak\":%.9g,\"partitionMaximumDifference\":%.9g,"
        "\"maximumAdjacentStep\":%.9g},"
        "\"gateReverb\":{\"shortEarlyEnergy\":%.17g,\"shortLateEnergy\":%.17g,"
        "\"longLateEnergy\":%.17g,\"shortHoldMs\":0,\"shortReleaseMs\":5,"
        "\"longHoldMs\":250,\"longReleaseMs\":1000,\"closedWetOneMax\":%.9g,"
        "\"closedHalfWetMaxError\":%.9g},"
        "\"reverseReverb\":{\"earlyEnergy\":%.17g,\"lateEnergy\":%.17g,"
        "\"rightEnergy\":%.17g,\"wetPathWarmupFrames\":9364},"
        "\"wetOneImpulseProbes\":["
        "{\"ordinal\":38,\"firstNonzeroFrame\":%u,\"firstNonzeroAtOrAfterWarmup\":%u,"
        "\"peakFrame\":%u,\"peak\":%.9g,\"energy\":%.17g,"
        "\"leftEnergy\":%.17g,\"rightEnergy\":%.17g,\"rightToLeftEnergyRatio\":%.17g},"
        "{\"ordinal\":48,\"firstNonzeroFrame\":%u,\"firstNonzeroAtOrAfterWarmup\":%u,"
        "\"peakFrame\":%u,\"peak\":%.9g,\"energy\":%.17g,"
        "\"leftEnergy\":%.17g,\"rightEnergy\":%.17g,\"rightToLeftEnergyRatio\":%.17g},"
        "{\"ordinal\":49,\"firstNonzeroFrame\":%u,\"firstNonzeroAtOrAfterWarmup\":%u,"
        "\"peakFrame\":%u,\"peak\":%.9g,\"energy\":%.17g,"
        "\"leftEnergy\":%.17g,\"rightEnergy\":%.17g,\"rightToLeftEnergyRatio\":%.17g}],"
        "\"eventBurst\":{\"maxEvents\":64,\"gateAllocationsAndFrees\":%llu,"
        "\"fdnAllocationsAndFrees\":%llu,"
        "\"reverseDelayAllocationsAndFrees\":%llu}}\n",
        gReverseLeftPeakFrame, static_cast<double>(gReverseLeftPeak),
        gReverseRightPeakFrame, static_cast<double>(gReverseRightPeak),
        gReversePartitionMaximumDifference, gReverseMaximumAdjacentStep,
        gGateShortEarlyEnergy, gGateShortLateEnergy,
        gGateLongLateEnergy, gClosedGateWetOneMaximum,
        gClosedGateHalfWetMaximumError, gReverseReverbEarlyEnergy, gReverseReverbLateEnergy,
        gReverseReverbRightEnergy,
        gImpulseMetrics[0].firstNonzeroFrame,
        gImpulseMetrics[0].firstNonzeroAtOrAfterWetWarmupFrame,
        gImpulseMetrics[0].peakFrame, static_cast<double>(gImpulseMetrics[0].peak),
        gImpulseMetrics[0].energy, gImpulseMetrics[0].leftEnergy,
        gImpulseMetrics[0].rightEnergy, gImpulseMetrics[0].rightToLeftEnergyRatio,
        gImpulseMetrics[1].firstNonzeroFrame,
        gImpulseMetrics[1].firstNonzeroAtOrAfterWetWarmupFrame,
        gImpulseMetrics[1].peakFrame, static_cast<double>(gImpulseMetrics[1].peak),
        gImpulseMetrics[1].energy, gImpulseMetrics[1].leftEnergy,
        gImpulseMetrics[1].rightEnergy, gImpulseMetrics[1].rightToLeftEnergyRatio,
        gImpulseMetrics[2].firstNonzeroFrame,
        gImpulseMetrics[2].firstNonzeroAtOrAfterWetWarmupFrame,
        gImpulseMetrics[2].peakFrame, static_cast<double>(gImpulseMetrics[2].peak),
        gImpulseMetrics[2].energy, gImpulseMetrics[2].leftEnergy,
        gImpulseMetrics[2].rightEnergy, gImpulseMetrics[2].rightToLeftEnergyRatio,
        static_cast<unsigned long long>(gGateBurstAllocations),
        static_cast<unsigned long long>(gFdnBurstAllocations),
        static_cast<unsigned long long>(gDelayBurstAllocations));
    if (gFailures != 0) {
        std::fprintf(stderr, "Spatial FX adapter tests failed: %d\n", gFailures);
        return 1;
    }
    std::puts("Spatial FX adapter tests passed");
    return 0;
}
