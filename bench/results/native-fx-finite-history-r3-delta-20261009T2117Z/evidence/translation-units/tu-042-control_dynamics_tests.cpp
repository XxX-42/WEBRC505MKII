#include "webrc/dsp/control_dynamics.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>

namespace {

std::atomic<bool> gCountAllocations{false};
std::atomic<unsigned> gAllocationCount{0};
int gFailures = 0;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++gFailures;
    }
}

} // namespace

void* operator new(std::size_t size) {
    if (gCountAllocations.load(std::memory_order_relaxed))
        gAllocationCount.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (gCountAllocations.load(std::memory_order_relaxed))
        gAllocationCount.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    using namespace webrc::dsp;
    constexpr float sampleRate = 48000.0f;
    const ProcessSpec spec{sampleRate, 256, 2};

    float ratio = 0.0f;
    check(pitchRatioSemitones(0.0f, ratio) && std::fabs(ratio - 1.0f) < 1.0e-7f,
          "F09 zero semitones maps to unit rate");
    check(pitchRatioSemitones(12.0f, ratio) && std::fabs(ratio - 2.0f) < 1.0e-6f,
          "F09 octave up doubles read rate");
    check(pitchRatioSemitones(-12.0f, ratio) && std::fabs(ratio - 0.5f) < 1.0e-6f,
          "F09 octave down halves read rate");
    check(pitchRatioSemitones(48.0f, ratio) && ratio == 16.0f,
          "F09 range allows four octaves up");
    check(!pitchRatioSemitones(48.1f, ratio) && !pitchRatioSemitones(
              std::numeric_limits<float>::quiet_NaN(), ratio),
          "F09 rejects out-of-contract and non-finite semitones");

    PatternSlicer slicer;
    const float gains[4] = {1.0f, 0.0f, 1.0f, 0.0f};
    check(slicer.prepare(spec) && slicer.setPattern(gains, 4, 0.1f),
          "F16 slicer accepts a bounded step pattern");
    check(std::fabs(slicer.gainAtPhase(0.0) - 0.0f) < 1.0e-6f,
          "F16 cycle wrap starts smoothly from previous step value");
    check(std::fabs(slicer.gainAtPhase(0.0125) - 0.5f) < 0.002f,
          "F16 raised-cosine edge midpoint");
    check(std::fabs(slicer.gainAtPhase(0.05) - 1.0f) < 1.0e-6f,
          "F16 holds the current step after transition edge");
    check(std::fabs(slicer.gainAtPhase(0.2625) - 0.5f) < 0.002f,
          "F16 transitions at interior step edge");
    check(std::fabs(slicer.gainAtPhase(-0.25) - slicer.gainAtPhase(0.75)) < 1.0e-6f,
          "F16 phase wraps for negative cycles");
    check(!slicer.setPattern(gains, 65, 0.1f), "F16 rejects pattern over fixed capacity");
    check(!slicer.setPattern(gains, 4, 0.75f), "F16 rejects overlapping transition width");
    const double phases[4] = {0.0, 0.0125, 0.05, 0.2625};
    const float slicerInput[4] = {1, 1, 1, 1};
    float slicerOutput[4]{};
    check(slicer.processBlock(slicerInput, phases, slicerOutput, 4), "F16 block process");
    check(!slicer.processBlock(slicerInput, phases, slicerOutput, 257),
          "F16 rejects block larger than prepared maximum");

    SampleAccurateScheduler scheduler;
    check(scheduler.prepare(spec, 120.0, 960), "F20 scheduler prepare");
    check(scheduler.tickToFrame(4096, 0) == 4096, "F20 tick zero maps to origin");
    check(scheduler.tickToFrame(4096, 960) == 28096,
          "F20 one quarter note maps to rounded absolute frame");
    check(SampleAccurateScheduler::swingOffsetFrames(48000.0, 120.0, 2, 0.5) == 3000,
          "F20 odd-subdivision swing offset formula");
    check(scheduler.scheduleAbsolute({255, 3, 0.3f}) &&
              scheduler.scheduleAbsolute({10, 1, 0.1f}) &&
              scheduler.scheduleAbsolute({64, 2, 0.2f}),
          "F20 accepts out-of-order inserts into fixed event queue");
    ScheduledEvent due[8]{};
    std::uint32_t dueCount = 0;
    check(!scheduler.collectBlock(0, 256, due, 1, dueCount) && scheduler.queuedCount() == 3,
          "F20 insufficient output capacity leaves due events queued");
    check(scheduler.collectBlock(0, 64, due, 8, dueCount) && dueCount == 1 &&
              due[0].eventId == 1 && due[0].absoluteFrame == 10 &&
              due[0].blockOffset == 10 && !due[0].late,
          "F20 sample-accurate half-open block collection");
    check(scheduler.setTempo(60.0, 960) && scheduler.scheduleTick(4096, 960, 4, 0.4f),
          "F20 tempo update affects future tick conversion");
    check(scheduler.collectBlock(64, 191, due, 8, dueCount) && dueCount == 1 &&
              due[0].eventId == 2 && due[0].absoluteFrame == 64,
          "F20 event retained at original sample frame after BPM update");
    check(scheduler.queuedCount() == 2, "F20 future events remain queued");
    check(scheduler.collectBlock(255, 1, due, 8, dueCount) && dueCount == 1 &&
              due[0].eventId == 3 && due[0].absoluteFrame == 255,
          "F20 later absolute frame delivered in matching block");
    check(scheduler.collectBlock(4096 + 48000, 256, due, 8, dueCount) && dueCount == 1 &&
              due[0].eventId == 4 && due[0].absoluteFrame == 52096,
          "F20 tempo update maps newly scheduled beat without moving prior events");
    check(!scheduler.setTempo(0.0, 960), "F20 rejects invalid tempo");
    check(scheduler.scheduleAbsolute({60000, 9, 0.9f}), "F20 queues event before reprepare check");
    const ProcessSpec invalidReprepare{0.0f, 128, 2};
    check(!scheduler.prepare(invalidReprepare, 120.0, 960) &&
              scheduler.sampleRate() == 48000.0 && scheduler.bpm() == 60.0 &&
              scheduler.ppq() == 960 && scheduler.queuedCount() == 1,
          "F20 failed prepare leaves the active clock and event queue intact");

    SampleAccurateScheduler lateScheduler;
    check(lateScheduler.prepare(spec, 120.0, 960) &&
              lateScheduler.scheduleAbsolute({100, 1, 1.0f}),
          "F20 late-event policy setup");
    check(lateScheduler.collectBlock(101, 0, due, 8, dueCount) && dueCount == 0 &&
              lateScheduler.queuedCount() == 1,
          "F20 zero-frame collection never consumes due or overdue events");
    check(lateScheduler.collectBlock(101, 64, due, 8, dueCount) && dueCount == 1 &&
              due[0].absoluteFrame == 100 && due[0].blockOffset == 0 && due[0].late,
          "F20 skipped-frame event is marked late and clamped to block offset zero");

    MidSideWidth width;
    check(width.prepare(spec, 140.0f) && width.setWidth(2.0f, 0.0f, 0.0f),
          "F22 mid-side width prepare and protected low-side setting");
    const auto mono = width.processSample(0.25f, 0.25f);
    check(std::fabs(mono.left - 0.25f) < 1.0e-5f &&
              std::fabs(mono.right - 0.25f) < 1.0e-5f,
          "F22 preserves a mono center signal at high width");
    width.reset();
    double lowFrequencySideEnergy = 0.0;
    for (int i = 0; i < 48000; ++i) {
        const float side = static_cast<float>(0.5 * std::sin(2.0 * 3.14159265358979323846 *
                                                             60.0 * i / sampleRate));
        const auto result = width.processSample(side, -side);
        lowFrequencySideEnergy += static_cast<double>(result.left) * result.left +
                                  static_cast<double>(result.right) * result.right;
    }
    check(lowFrequencySideEnergy / 48000.0 < 0.18,
          "F22 low-frequency side protection folds a 60 Hz side signal toward mono");
    width.reset();
    double wideFrequencySideEnergy = 0.0;
    for (int i = 0; i < 48000; ++i) {
        const float side = static_cast<float>(0.5 * std::sin(2.0 * 3.14159265358979323846 *
                                                             5000.0 * i / sampleRate));
        const auto result = width.processSample(side, -side);
        wideFrequencySideEnergy += static_cast<double>(result.left) * result.left +
                                   static_cast<double>(result.right) * result.right;
    }
    check(wideFrequencySideEnergy / 48000.0 > 0.8,
          "F22 high-frequency width expands side content while lows are folded");
    check(width.setWidth(1.0f, 1.0f, 0.0f), "F22 unity width accepted");
    width.reset();
    const auto unityWidth = width.processSample(0.13f, -0.07f);
    check(std::fabs(unityWidth.left - 0.13f) < 1.0e-6f &&
              std::fabs(unityWidth.right + 0.07f) < 1.0e-6f,
          "F22 complementary bands sum exactly to unity at default width");
    width.setWidth(2.0f, 0.0f, 10.0f);
    const auto widthAtAutomationStart = width.processSample(0.5f, -0.5f);
    check(std::fabs(widthAtAutomationStart.left - 0.5f) < 0.002f,
          "F22 width change starts continuously and uses prepared smoothing state");
    check(std::isfinite(width.correlationEstimate()) && width.correlationEstimate() >= -1.0f &&
              width.correlationEstimate() <= 1.0f,
          "F22 monitors bounded output correlation");

    OnsetDetector onset;
    check(onset.prepare(spec) && onset.setParameters(0.01f, 1.5f, 10.0f, 35.0f),
          "F27 onset detector prepare/parameters");
    for (int i = 0; i < 2000; ++i) check(!onset.processSample(0.0f).onset,
                                          "F27 silence does not trigger");
    OnsetResult onsetEvent{};
    onsetEvent = onset.processSample(1.0f);
    check(onsetEvent.onset && onsetEvent.envelope == 0.0f && onsetEvent.flux > 0.01f,
          "F27 onset triggers from positive energy flux and begins attack");
    float maximumEnvelope = 0.0f;
    bool retriggeredDuringRefractory = false;
    for (int i = 0; i < 1200; ++i) {
        const auto result = onset.processSample(i == 10 ? 1.0f : 0.0f);
        maximumEnvelope = std::max(maximumEnvelope, result.envelope);
        retriggeredDuringRefractory |= result.onset;
    }
    check(maximumEnvelope > 0.99f, "F27 raised-cosine attack reaches unity in 10 ms");
    check(!retriggeredDuringRefractory, "F27 refractory interval suppresses repeated transient");

    BitRateReducer reducerA;
    BitRateReducer reducerB;
    check(reducerA.prepare(spec) && reducerB.prepare(spec), "F28 reducer prepare");
    check(reducerA.setParameters(4, 4, 1.0f, false, 0.0f), "F28 configure 4-bit hold");
    const float loFiInput[8] = {0.31f, -0.31f, 0.49f, -0.49f, 0.9f, 0.7f, -0.9f, -0.7f};
    float loFiOutput[8]{};
    check(reducerA.processBlock(loFiInput, loFiOutput, 8), "F28 block process");
    check(std::fabs(loFiOutput[0] - 0.25f) < 1.0e-6f &&
              std::fabs(loFiOutput[1] - 0.25f) < 1.0e-6f &&
              std::fabs(loFiOutput[2] - 0.25f) < 1.0e-6f &&
              std::fabs(loFiOutput[3] - 0.25f) < 1.0e-6f,
          "F28 holds the quantized sample for the selected period");
    check(std::fabs(loFiOutput[4] - 0.875f) < 1.0e-6f,
          "F28 quantizes next held sample to 4-bit grid");
    check(reducerA.setParameters(16, 1, 1.0f, true, 0.0f), "F28 enable TPDF dither");
    reducerA.reset(123, 9);
    reducerB.setParameters(16, 1, 1.0f, true, 0.0f);
    reducerB.reset(123, 9);
    bool deterministicDither = true;
    for (int i = 0; i < 1000; ++i) {
        const float sample = 0.123456f;
        deterministicDither &= reducerA.processSample(sample) == reducerB.processSample(sample);
    }
    check(deterministicDither, "F28 seeded TPDF is deterministic");
    check(!reducerA.setParameters(1, 1, 1.0f, true), "F28 rejects fewer than two bits");
    BitRateReducer dryReducer;
    check(dryReducer.prepare(spec) && dryReducer.setParameters(8, 1, 0.0f, false, 0.0f) &&
              std::fabs(dryReducer.processSample(1.5f) - 1.5f) < 1.0e-6f &&
              std::fabs(dryReducer.processSample(-2.0f) + 2.0f) < 1.0e-6f,
          "F28 zero wet mix preserves unclipped dry values outside the quantizer range");
    BitRateReducer smoothedMix;
    check(smoothedMix.prepare(spec) &&
              smoothedMix.setParameters(4, 1, 0.0f, false, 0.0f) &&
              smoothedMix.setParameters(4, 1, 1.0f, false, 10.0f) &&
              std::fabs(smoothedMix.processSample(0.1f) - 0.1f) < 0.001f,
          "F28 wet mix automation ramps without an immediate quantizer step");

    RingModulator ring;
    check(ring.prepare(spec) && ring.setParameters(1000.0f, 1.0f, 0.0f),
          "F29 ring modulator prepare/parameters");
    ring.reset(0.0f);
    bool ringMatchesSine = true;
    for (int i = 0; i < 48; ++i) {
        const float expected = static_cast<float>(std::sin(2.0 * 3.14159265358979323846 *
                                                           i / 48.0));
        ringMatchesSine &= std::fabs(ring.processSample(1.0f) - expected) < 2.0e-5f;
    }
    check(ringMatchesSine, "F29 carrier follows the configured four-quadrant sine product");
    check(ring.setParameters(1000.0f, 0.0f, 0.0f) && std::fabs(ring.processSample(0.3f) - 0.3f) < 1.0e-6f,
          "F29 depth zero is transparent");
    ring.setParameters(1000.0f, 1.0f, 0.0f);
    ring.reset(0.25f);
    ring.setParameters(1000.0f, 0.0f, 10.0f);
    check(ring.processSample(0.25f) > 0.24f,
          "F29 depth automation begins at the previous carrier gain without a discontinuity");

    // Verify repeated process calls and control changes stay heap-free once prepared.
    PatternSlicer rtSlicer;
    SampleAccurateScheduler rtScheduler;
    MidSideWidth rtWidth;
    OnsetDetector rtOnset;
    BitRateReducer rtReducer;
    RingModulator rtRing;
    const float pattern[4] = {1.0f, 0.3f, 0.0f, 0.7f};
    bool rtSetup = rtSlicer.prepare(spec) && rtSlicer.setPattern(pattern, 4) &&
                   rtScheduler.prepare(spec, 120.0, 960) && rtWidth.prepare(spec) &&
                   rtOnset.prepare(spec) && rtReducer.prepare(spec) &&
                   rtReducer.setParameters(12, 3, 0.8f, true) && rtRing.prepare(spec) &&
                   rtRing.setParameters(17.0f, 0.7f);
    std::array<float, 256> rtInput{};
    std::array<float, 256> rtRight{};
    std::array<float, 256> rtOutput{};
    std::array<float, 256> rtRightOutput{};
    std::array<double, 256> rtPhases{};
    std::array<OnsetResult, 256> rtOnsetOutput{};
    std::array<ScheduledEvent, 256> rtEvents{};
    for (std::size_t i = 0; i < 256; ++i) {
        rtInput[i] = 0.2f * std::sin(static_cast<float>(0.04 * i));
        rtRight[i] = 0.15f * std::cos(static_cast<float>(0.03 * i));
        rtPhases[i] = static_cast<double>(i) / 256.0;
    }
    std::uint32_t eventCount = 0;
    std::uint64_t frameCursor = 0;
    gAllocationCount.store(0, std::memory_order_relaxed);
    gCountAllocations.store(true, std::memory_order_relaxed);
    for (int block = 0; block < 24; ++block) {
        const std::uint32_t frames = block % 3 == 0 ? 64U : (block % 3 == 1 ? 128U : 256U);
        if (block % 4 == 0) {
            rtSetup = rtSetup && rtSlicer.setPattern(pattern, 4, 0.05f) &&
                      rtScheduler.setTempo(100.0 + block, 960) &&
                      rtReducer.setParameters(10 + block % 8, 2 + block % 3, 0.75f, true) &&
                      rtRing.setParameters(20.0f + block, 0.6f);
            (void)rtScheduler.scheduleAbsolute({frameCursor + 7,
                                                static_cast<std::uint32_t>(block), 0.5f});
        }
        rtSetup = rtSetup && rtSlicer.processBlock(rtInput.data(), rtPhases.data(),
                                                   rtOutput.data(), frames) &&
                  rtWidth.processBlock(rtInput.data(), rtRight.data(), rtOutput.data(),
                                       rtRightOutput.data(), frames) &&
                  rtOnset.processBlock(rtInput.data(), rtOnsetOutput.data(), frames) &&
                  rtReducer.processBlock(rtInput.data(), rtOutput.data(), frames) &&
                  rtRing.processBlock(rtInput.data(), rtOutput.data(), frames) &&
                  rtScheduler.collectBlock(frameCursor, frames,
                                           rtEvents.data(), static_cast<std::uint32_t>(rtEvents.size()),
                                           eventCount);
        frameCursor += frames;
    }
    gCountAllocations.store(false, std::memory_order_relaxed);
    check(rtSetup, "prepared control/dynamics blocks accept repeated audio calls");
    check(gAllocationCount.load(std::memory_order_relaxed) == 0,
          "control/dynamics process and automation paths allocate no heap memory");

    if (gFailures != 0) {
        std::fprintf(stderr, "%d control/dynamics test(s) failed\n", gFailures);
        return 1;
    }
    std::puts("Control/dynamics tests passed");
    return 0;
}
