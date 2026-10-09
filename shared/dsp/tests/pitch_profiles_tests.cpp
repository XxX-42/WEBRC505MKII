#include "webrc/dsp/pitch_profiles.hpp"

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
std::atomic<unsigned> allocationCount{0U};
int failures = 0;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}

double toneAmplitude(const float* samples, std::uint32_t first,
                     std::uint32_t frames, double frequencyHz, double sampleRate) {
    double cosine = 0.0;
    double sineProjection = 0.0;
    constexpr double twoPi = 6.28318530717958647692;
    for (std::uint32_t offset = 0U; offset < frames; ++offset) {
        const double phase = twoPi * frequencyHz * (first + offset) / sampleRate;
        cosine += samples[first + offset] * std::cos(phase);
        sineProjection += samples[first + offset] * std::sin(phase);
    }
    return 2.0 * std::hypot(cosine, sineProjection) / frames;
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
    constexpr std::uint32_t maxBlockFrames = 128U;
    constexpr std::uint32_t seed = 0x12345U;

    PitchProfileSettings monoSettings{};
    PitchProfileSettings polySettings{};
    PitchProfileSettings hqSettings{};
    check(makePitchProfileSettings(PitchProfileId::LiveMono, sampleRate, maxBlockFrames,
                                   seed, monoSettings) &&
          makePitchProfileSettings(PitchProfileId::LivePoly, sampleRate, maxBlockFrames,
                                   seed, polySettings) &&
          makePitchProfileSettings(PitchProfileId::HqRender, sampleRate, maxBlockFrames,
                                   seed, hqSettings),
          "build all three canonical pitch-route configurations");
    check(monoSettings.spec.channels == 1U && monoSettings.liveMono.analysisWindowFrames == 4096U &&
          monoSettings.liveMono.analysisHopFrames == 512U &&
          monoSettings.liveMono.analysisWorkUnitsPerCallback == 32768U,
          "LIVE_MONO is mono incremental YIN plus streaming PSOLA with explicit bounded work");
    check(polySettings.spec.channels == 2U &&
          polySettings.signalsmith.mode == PitchQualityMode::LivePoly &&
          polySettings.signalsmith.blockSamples == 4096U &&
          polySettings.signalsmith.intervalSamples == 1024U &&
          polySettings.signalsmith.splitComputation,
          "LIVE_POLY selects stereo Signalsmith with the lower-window split profile");
    check(hqSettings.spec.channels == 2U &&
          hqSettings.signalsmith.mode == PitchQualityMode::HqRender &&
          hqSettings.signalsmith.blockSamples == 8192U &&
          hqSettings.signalsmith.intervalSamples == 1024U &&
          !hqSettings.signalsmith.splitComputation,
          "HQ_RENDER selects the larger stereo Signalsmith window without split computation");
    PitchProfileSettings unchanged{};
    unchanged.profile = PitchProfileId::HqRender;
    check(!makePitchProfileSettings(static_cast<PitchProfileId>(99U), sampleRate,
                                    maxBlockFrames, seed, unchanged) &&
          unchanged.profile == PitchProfileId::HqRender,
          "reject unknown profile IDs without mutating caller settings");
    check(PitchProfileProcessor::requiredPrepareBytes(monoSettings) > sizeof(PitchProfileProcessor) &&
          PitchProfileProcessor::requiredPrepareBytes(polySettings) > sizeof(PitchProfileProcessor) &&
          PitchProfileProcessor::requiredPrepareBytes(hqSettings) >
              PitchProfileProcessor::requiredPrepareBytes(polySettings),
          "profile preflight reports engine storage and the larger HQ analysis state");

    PitchProfileProcessor mono(seed);
    PitchProfileProcessor poly(seed);
    PitchProfileProcessor hq(seed);
    const auto monoBytes = PitchProfileProcessor::requiredPrepareBytes(monoSettings);
    const auto polyBytes = PitchProfileProcessor::requiredPrepareBytes(polySettings);
    const auto hqBytes = PitchProfileProcessor::requiredPrepareBytes(hqSettings);
    check(!mono.prepare(monoSettings, monoBytes - 1U) && !mono.prepared(),
          "reject insufficient profile memory before preparation");
    check(mono.prepare(monoSettings, monoBytes) && poly.prepare(polySettings, polyBytes) &&
          hq.prepare(hqSettings, hqBytes),
          "prepare mono, polyphonic and HQ algorithms under their respective budgets");
    check(!mono.prepare(polySettings, monoBytes + polyBytes) && mono.prepared() &&
          mono.profile() == PitchProfileId::LiveMono,
          "profile changes require a separately prepared candidate and preserve the active route");
    check(mono.setPitchRatio(1.5f) && poly.setPitchRatio(1.5f) && hq.setPitchRatio(1.5f) &&
          !mono.setPitchRatio(4.1f),
          "route pitch ratios to the selected engine and reject invalid values");
    check(!mono.processStereo(nullptr, nullptr, nullptr, nullptr, 64U) &&
          !poly.processMono(nullptr, nullptr, 64U),
          "each profile rejects the other route's channel API");

    constexpr std::uint32_t inputFrames = 48000U;
    std::vector<float> monoInput(inputFrames);
    std::vector<float> monoOutput(inputFrames);
    std::array<std::vector<float>, 2U> leftInput{{std::vector<float>(inputFrames),
                                                  std::vector<float>(inputFrames)}};
    std::array<std::vector<float>, 2U> polyOutput{{std::vector<float>(inputFrames),
                                                   std::vector<float>(inputFrames)}};
    std::array<std::vector<float>, 2U> hqOutput{{std::vector<float>(inputFrames),
                                                std::vector<float>(inputFrames)}};
    for (std::uint32_t frame = 0U; frame < inputFrames; ++frame) {
        const double time = static_cast<double>(frame) / sampleRate;
        monoInput[frame] = 0.22f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 55.0 * time));
        leftInput[0][frame] = 0.25f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 220.0 * time));
        leftInput[1][frame] = 0.18f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 330.0 * time + 0.3));
    }

    std::array<PitchProfileLatency, 3U> latencies{};
    latencies[0] = mono.latency();
    latencies[1] = poly.latency();
    latencies[2] = hq.latency();
    std::array<std::uint32_t, 3U> finiteOutputs{};
    allocationCount.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    constexpr std::array<std::uint32_t, 4U> callbackSchedule{{64U, 128U, 64U, 128U}};
    std::uint32_t scheduleIndex = 0U;
    for (std::uint32_t offset = 0U; offset < inputFrames;) {
        const auto frames = std::min(callbackSchedule[scheduleIndex++ % callbackSchedule.size()],
                                     inputFrames - offset);
        if (!mono.processMono(monoInput.data() + offset, monoOutput.data() + offset,
                              frames)) {
            ++failures;
            break;
        }
        if (!poly.processStereo(leftInput[0].data() + offset, leftInput[1].data() + offset,
                                polyOutput[0].data() + offset, polyOutput[1].data() + offset,
                                frames) ||
            !hq.processStereo(leftInput[0].data() + offset, leftInput[1].data() + offset,
                              hqOutput[0].data() + offset, hqOutput[1].data() + offset,
                              frames)) {
            ++failures;
            break;
        }
        offset += frames;
    }
    countAllocations.store(false, std::memory_order_release);

    for (std::uint32_t frame = 0U; frame < inputFrames; ++frame) {
        finiteOutputs[0] += std::isfinite(monoOutput[frame]) ? 1U : 0U;
        finiteOutputs[1] += std::isfinite(polyOutput[0][frame]) &&
                            std::isfinite(polyOutput[1][frame]) ? 1U : 0U;
        finiteOutputs[2] += std::isfinite(hqOutput[0][frame]) &&
                            std::isfinite(hqOutput[1][frame]) ? 1U : 0U;
    }
    check(allocationCount.load(std::memory_order_relaxed) == 0U,
          "all three prepared pitch profiles process Native-64 and Browser-128 callback sizes without allocation");
    check(finiteOutputs[0] == inputFrames && finiteOutputs[1] == inputFrames &&
          finiteOutputs[2] == inputFrames,
          "all three pitch routes produce finite output for the full fixture");
    check(std::abs(poly.latency().inputSamples - hq.latency().inputSamples) > 0 ||
          std::abs(poly.latency().outputSamples - hq.latency().outputSamples) > 0,
          "Signalsmith profile settings produce different engine latency reports");

    YinPitchDetector monoReference;
    YinPitchDetector leftReference;
    YinPitchDetector rightReference;
    const ProcessSpec monoSpec{sampleRate, maxBlockFrames, 1U};
    const auto analysisStart = inputFrames - 8192U;
    const bool analyzersReady = monoReference.prepare(monoSpec, 8192U, 40.0f, 200.0f) &&
        leftReference.prepare(monoSpec, 8192U, 250.0f, 420.0f) &&
        rightReference.prepare(monoSpec, 8192U, 400.0f, 650.0f);
    PitchEstimate monoOutputEstimate{};
    PitchEstimate polyLeftEstimate{};
    PitchEstimate polyRightEstimate{};
    PitchEstimate hqLeftEstimate{};
    PitchEstimate hqRightEstimate{};
    check(analyzersReady &&
          monoReference.analyze(monoOutput.data() + analysisStart, 8192U, monoOutputEstimate) &&
          leftReference.analyze(polyOutput[0].data() + analysisStart, 8192U, polyLeftEstimate) &&
          rightReference.analyze(polyOutput[1].data() + analysisStart, 8192U, polyRightEstimate) &&
          leftReference.analyze(hqOutput[0].data() + analysisStart, 8192U, hqLeftEstimate) &&
          rightReference.analyze(hqOutput[1].data() + analysisStart, 8192U, hqRightEstimate),
          "analyze measured steady-state output from each prepared pitch profile");
    check(monoOutputEstimate.voiced && std::abs(monoOutputEstimate.frequencyHz - 82.5f) < 5.0f &&
          polyLeftEstimate.voiced && std::abs(polyLeftEstimate.frequencyHz - 330.0f) < 8.0f &&
          polyRightEstimate.voiced && std::abs(polyRightEstimate.frequencyHz - 495.0f) < 10.0f &&
          hqLeftEstimate.voiced && std::abs(hqLeftEstimate.frequencyHz - 330.0f) < 8.0f &&
          hqRightEstimate.voiced && std::abs(hqRightEstimate.frequencyHz - 495.0f) < 10.0f,
          "LIVE_MONO, LIVE_POLY and HQ_RENDER produce the requested pitch ratios on real PCM");
    const auto polyLeftMain = toneAmplitude(polyOutput[0].data(), analysisStart, 8192U,
                                             330.0, sampleRate);
    const auto polyLeftLeak = toneAmplitude(polyOutput[0].data(), analysisStart, 8192U,
                                             495.0, sampleRate);
    const auto polyRightMain = toneAmplitude(polyOutput[1].data(), analysisStart, 8192U,
                                              495.0, sampleRate);
    const auto polyRightLeak = toneAmplitude(polyOutput[1].data(), analysisStart, 8192U,
                                              330.0, sampleRate);
    const auto hqLeftMain = toneAmplitude(hqOutput[0].data(), analysisStart, 8192U,
                                           330.0, sampleRate);
    const auto hqLeftLeak = toneAmplitude(hqOutput[0].data(), analysisStart, 8192U,
                                           495.0, sampleRate);
    const auto hqRightMain = toneAmplitude(hqOutput[1].data(), analysisStart, 8192U,
                                            495.0, sampleRate);
    const auto hqRightLeak = toneAmplitude(hqOutput[1].data(), analysisStart, 8192U,
                                            330.0, sampleRate);
    check(polyLeftMain > 1.0e-3 && polyRightMain > 1.0e-3 &&
          polyLeftLeak < polyLeftMain * 0.10 && polyRightLeak < polyRightMain * 0.10 &&
          hqLeftMain > 1.0e-3 && hqRightMain > 1.0e-3 &&
          hqLeftLeak < hqLeftMain * 0.10 && hqRightLeak < hqRightMain * 0.10,
          "LIVE_POLY and HQ_RENDER retain independent left/right tones with under -20 dB opposite-channel leakage");
    check(latencies[0].model == PitchProfileLatencyModel::DetectorWindowPlusResynthesisLookahead &&
          latencies[0].declaredWindowPlusResynthesisSamples == 7696U &&
          latencies[1].model == PitchProfileLatencyModel::SignalsmithEngineInputAndOutputGetters &&
          latencies[2].model == PitchProfileLatencyModel::SignalsmithEngineInputAndOutputGetters,
          "report LIVE_MONO declared components separately from measured Signalsmith getters");

    if (failures != 0) {
        std::fprintf(stderr, "Pitch profile tests failed: %d\n", failures);
        return 1;
    }
    std::printf("Pitch profile tests passed; LIVE_MONO=%0.2fHz, LIVE_POLY=%0.2f/%0.2fHz latency=%d/%d, HQ_RENDER=%0.2f/%0.2fHz latency=%d/%d samples.\n",
                monoOutputEstimate.frequencyHz, polyLeftEstimate.frequencyHz,
                polyRightEstimate.frequencyHz,
                poly.latency().inputSamples, poly.latency().outputSamples,
                hqLeftEstimate.frequencyHz, hqRightEstimate.frequencyHz,
                hq.latency().inputSamples, hq.latency().outputSamples);
    return 0;
}
