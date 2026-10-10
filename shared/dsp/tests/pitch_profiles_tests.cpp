#include "webrc/dsp/pitch_profiles.hpp"
#include "webrc/dsp/fft.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <limits>
#include <new>
#include <vector>

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<unsigned> allocationCount{0U};
int failures = 0;

struct SpectralPeak {
    double frequencyHz = 0.0;
    double amplitude = 0.0;
};

struct PlanarInputView {
    const float* left = nullptr;
    const float* right = nullptr;
    const float* operator[](int channel) const noexcept {
        return channel == 0 ? left : right;
    }
};

struct PlanarOutputView {
    float* left = nullptr;
    float* right = nullptr;
    float* operator[](int channel) const noexcept {
        return channel == 0 ? left : right;
    }
};

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

SpectralPeak peakBelow200Hz(const float* samples, std::uint32_t first,
                            std::uint32_t frames, double sampleRate) {
    std::vector<std::complex<float>> spectrum(frames);
    double windowSum = 0.0;
    constexpr double twoPi = 6.28318530717958647692;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        const double window = 0.5 - 0.5 * std::cos(twoPi * frame / (frames - 1U));
        windowSum += window;
        spectrum[frame] = {static_cast<float>(samples[first + frame] * window), 0.0f};
    }
    if (!webrc::dsp::fft::transform(spectrum.data(), spectrum.size(),
                                   webrc::dsp::fft::Direction::Forward)) return {};
    SpectralPeak peak{};
    const auto lastBin = std::min<std::uint32_t>(
        static_cast<std::uint32_t>(spectrum.size() / 2U),
        static_cast<std::uint32_t>(200.0 * frames / sampleRate));
    for (std::uint32_t bin = 1U; bin <= lastBin; ++bin) {
        const double amplitude = 2.0 * std::abs(spectrum[bin]) / windowSum;
        if (amplitude > peak.amplitude) {
            peak.frequencyHz = static_cast<double>(bin) * sampleRate / frames;
            peak.amplitude = amplitude;
        }
    }
    return peak;
}

bool writeInterleavedFloat32(const std::filesystem::path& path,
                             const std::array<std::vector<float>, 2U>& channels,
                             std::uint32_t frames) {
    if (channels[0].size() < frames || channels[1].size() < frames) return false;
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!stream) return false;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        stream.write(reinterpret_cast<const char*>(&channels[0][frame]), sizeof(float));
        stream.write(reinterpret_cast<const char*>(&channels[1][frame]), sizeof(float));
    }
    return stream.good();
}

bool writeLowHqArtifacts(const std::filesystem::path& directory,
                         double sampleRate, std::uint32_t sourceFrames,
                         std::uint32_t renderedFrames,
                         const std::array<std::vector<float>, 2U>& input,
                         const std::array<std::vector<float>, 2U>& output,
                         const SpectralPeak& leftPeak, const SpectralPeak& rightPeak,
                         const webrc::dsp::PitchProfileLatency& latency) {
    std::error_code error;
    std::filesystem::create_directories(directory, error);
    if (error || !writeInterleavedFloat32(directory / "input-stereo-f32le.pcm",
                                          input, renderedFrames) ||
        !writeInterleavedFloat32(directory / "output-stereo-f32le.pcm",
                                 output, renderedFrames)) return false;

    std::ofstream report(directory / "diagnostic.json", std::ios::binary | std::ios::trunc);
    if (!report) return false;
    const bool targetBinsPass = std::abs(leftPeak.frequencyHz - 27.5) < 1.5 &&
                                std::abs(rightPeak.frequencyHz - 34.375) < 1.5;
    report << std::setprecision(12);
    report << "{\n"
           << "  \"schemaVersion\": 1,\n"
           << "  \"status\": \"diagnostic-only; low-frequency target-bin check "
           << (targetBinsPass ? "passed" : "not passed") << "\",\n"
           << "  \"profile\": \"HQ_RENDER\",\n"
           << "  \"sampleRateHz\": " << sampleRate << ",\n"
           << "  \"settings\": {\"windowFrames\": 16384, \"hopFrames\": 1024, "
              "\"splitComputation\": false, \"transposeRatio\": 0.5},\n"
           << "  \"sourceToneHz\": [55, 68.75],\n"
           << "  \"sourceAmplitude\": [0.25, 0.2],\n"
           << "  \"sourceFrames\": " << sourceFrames << ",\n"
           << "  \"zeroTailInputFrames\": " << (renderedFrames - sourceFrames) << ",\n"
           << "  \"renderedFrames\": " << renderedFrames << ",\n"
           << "  \"channels\": 2,\n"
           << "  \"pcmEncoding\": \"float32-le-interleaved-LR\",\n"
           << "  \"latencyGettersSamples\": {\"input\": " << latency.inputSamples
           << ", \"output\": " << latency.outputSamples
           << ", \"measuredEndToEnd\": false},\n"
           << "  \"renderPolicy\": \"streaming processBlock calls followed by zero input; no flush applied\",\n"
           << "  \"rmsWindows\": [\n";

    bool firstWindow = true;
    constexpr std::uint32_t windowFrames = 16384U;
    for (std::uint32_t start = 0U; start < renderedFrames; start += windowFrames) {
        const auto count = std::min(windowFrames, renderedFrames - start);
        double squareSum[2]{};
        float peak[2]{};
        std::uint32_t finiteCount[2]{};
        for (std::uint32_t frame = start; frame < start + count; ++frame) {
            for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
                const auto value = output[channel][frame];
                finiteCount[channel] += std::isfinite(value) ? 1U : 0U;
                peak[channel] = std::max(peak[channel], std::abs(value));
                squareSum[channel] += static_cast<double>(value) * value;
            }
        }
        if (!firstWindow) report << ",\n";
        firstWindow = false;
        report << "    {\"startFrame\": " << start << ", \"frames\": " << count
               << ", \"leftRms\": " << std::sqrt(squareSum[0] / count)
               << ", \"rightRms\": " << std::sqrt(squareSum[1] / count)
               << ", \"leftPeak\": " << peak[0] << ", \"rightPeak\": " << peak[1]
               << ", \"leftFinite\": " << finiteCount[0]
               << ", \"rightFinite\": " << finiteCount[1] << "}";
    }
    report << "\n  ],\n"
           << "  \"hannFft1To200Hz\": {\"startFrame\": 48000, \"frames\": 32768, "
              "\"binSpacingHz\": " << sampleRate / 32768.0
           << ", \"leftPeakHz\": " << leftPeak.frequencyHz
           << ", \"leftPeakAmplitude\": " << leftPeak.amplitude
           << ", \"rightPeakHz\": " << rightPeak.frequencyHz
           << ", \"rightPeakAmplitude\": " << rightPeak.amplitude
           << ", \"bins\": [";

    constexpr std::uint32_t fftFrames = 32768U;
    std::array<std::vector<double>, 2U> amplitudes{{
        std::vector<double>(fftFrames / 2U + 1U),
        std::vector<double>(fftFrames / 2U + 1U)}};
    double hannSum = 0.0;
    constexpr double twoPi = 6.28318530717958647692;
    std::vector<std::complex<float>> spectrum(fftFrames);
    for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
        hannSum = 0.0;
        for (std::uint32_t frame = 0U; frame < fftFrames; ++frame) {
            const double window = 0.5 - 0.5 * std::cos(twoPi * frame / (fftFrames - 1U));
            hannSum += window;
            spectrum[frame] = {static_cast<float>(output[channel][48000U + frame] * window), 0.0f};
        }
        if (!(hannSum > 0.0) || !std::isfinite(hannSum)) return false;
        if (!webrc::dsp::fft::transform(spectrum.data(), spectrum.size(),
                                        webrc::dsp::fft::Direction::Forward)) return false;
        const auto lastBin = std::min<std::uint32_t>(fftFrames / 2U,
            static_cast<std::uint32_t>(200.0 * fftFrames / sampleRate));
        for (std::uint32_t bin = 1U; bin <= lastBin; ++bin) {
            amplitudes[channel][bin] = 2.0 * std::abs(spectrum[bin]) / hannSum;
            if (!std::isfinite(amplitudes[channel][bin])) return false;
        }
    }
    const auto lastBin = std::min<std::uint32_t>(fftFrames / 2U,
        static_cast<std::uint32_t>(200.0 * fftFrames / sampleRate));
    for (std::uint32_t bin = 1U; bin <= lastBin; ++bin) {
        if (bin > 1U) report << ',';
        report << "{\"hz\": " << static_cast<double>(bin) * sampleRate / fftFrames
               << ", \"leftAmplitude\": " << amplitudes[0][bin]
               << ", \"rightAmplitude\": " << amplitudes[1][bin] << '}';
    }
    report << "]}\n}\n";
    return report.good();
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
          hqSettings.signalsmith.blockSamples == 16384U &&
          hqSettings.signalsmith.intervalSamples == 1024U &&
          !hqSettings.signalsmith.splitComputation,
          "HQ_RENDER selects a 16k stereo Signalsmith window without split computation");
    PitchProfileSettings unchanged{};
    unchanged.profile = PitchProfileId::HqRender;
    check(!makePitchProfileSettings(static_cast<PitchProfileId>(99U), sampleRate,
                                    maxBlockFrames, seed, unchanged) &&
          unchanged.profile == PitchProfileId::HqRender,
          "reject unknown profile IDs without mutating caller settings");
    PitchProfileSettings highRateSettings{};
    check(makePitchProfileSettings(PitchProfileId::LiveMono, 163720.0f,
                                   maxBlockFrames, seed, highRateSettings),
          "LIVE_MONO accepts the highest sample rate whose 40 Hz lag fits its fixed window");
    highRateSettings.profile = PitchProfileId::HqRender;
    const auto highRateSentinel = highRateSettings;
    check(!makePitchProfileSettings(PitchProfileId::LiveMono, 163721.0f,
                                    maxBlockFrames, seed, highRateSettings) &&
          highRateSettings.profile == highRateSentinel.profile &&
          highRateSettings.spec.sampleRate == highRateSentinel.spec.sampleRate,
          "LIVE_MONO rejects the first sample rate whose 40 Hz lag exceeds its fixed window without mutating output");
    check(!makePitchProfileSettings(PitchProfileId::LiveMono, 192000.0f,
                                    maxBlockFrames, seed, highRateSettings) &&
          highRateSettings.profile == highRateSentinel.profile &&
          highRateSettings.spec.sampleRate == highRateSentinel.spec.sampleRate,
          "LIVE_MONO rejects 192 kHz consistently with route preflight and preserves caller settings");
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

    // Verify the pinned engine's fixed-length rendering recipe through the
    // adapter. outputSeek consumes the exact upstream-reported prefix, process
    // handles the remaining source in bounded chunks, and flush drains the
    // final output tail. A raw Signalsmith exact() render is the reference.
    constexpr std::uint32_t renderFrames = 32768U;
    constexpr std::uint32_t callbackFrames = 8192U;
    constexpr float playbackRate = 1.0f;
    ProcessSpec renderSpec{sampleRate, callbackFrames, 2U};
    SignalsmithStretchSettings renderSettings{PitchQualityMode::HqRender, 2U,
                                               16384U, 1024U, false, seed};
    SignalsmithStretchAdapter seekAdapter(seed);
    const auto seekAdapterBytes = SignalsmithStretchAdapter::requiredPrepareBytes(
        renderSpec, renderSettings);
    check(seekAdapterBytes > 0U &&
          seekAdapter.prepare(renderSpec, renderSettings, seekAdapterBytes),
          "prepare 16k HQ adapter with bounded callback and offline seek scratch");
    check(seekAdapter.setTransposeFactor(1.25f),
          "configure a pitch-shifted fixed-length render before output seek");

    std::array<std::vector<float>, 2U> renderInput{{std::vector<float>(renderFrames),
                                                    std::vector<float>(renderFrames)}};
    std::array<std::vector<float>, 2U> seekOutput{{std::vector<float>(renderFrames),
                                                   std::vector<float>(renderFrames)}};
    std::array<std::vector<float>, 2U> exactOutput{{std::vector<float>(renderFrames),
                                                    std::vector<float>(renderFrames)}};
    for (std::uint32_t frame = 0U; frame < renderFrames; ++frame) {
        const double time = static_cast<double>(frame) / sampleRate;
        renderInput[0][frame] = 0.21f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 55.0 * time));
        renderInput[1][frame] = 0.17f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 997.0 * time + 0.2));
    }
    const float* seekInputPointers[2]{renderInput[0].data(), renderInput[1].data()};
    float* seekOutputPointers[2]{seekOutput[0].data(), seekOutput[1].data()};
    std::uint32_t seekFrames = 0U;
    check(seekAdapter.outputSeekLength(playbackRate, seekFrames) &&
          seekFrames > 0U && seekFrames < renderFrames,
          "report a bounded exact() pre-roll input prefix for the selected playback rate");
    std::uint32_t invalidSeekLengthSentinel = 731U;
    check(!seekAdapter.outputSeekLength(0.0f, invalidSeekLengthSentinel) &&
          invalidSeekLengthSentinel == 731U &&
          !seekAdapter.outputSeekLength(std::numeric_limits<float>::quiet_NaN(),
                                        invalidSeekLengthSentinel) &&
          invalidSeekLengthSentinel == 731U &&
          !seekAdapter.outputSeekLength(4.01f, invalidSeekLengthSentinel) &&
          invalidSeekLengthSentinel == 731U,
          "invalid or non-finite playback rates fail without mutating the seek-length output");

    signalsmith::stretch::SignalsmithStretch<float> exactEngine(static_cast<long>(seed));
    exactEngine.configure(2, static_cast<int>(renderSettings.blockSamples),
                          static_cast<int>(renderSettings.intervalSamples),
                          renderSettings.splitComputation);
    exactEngine.setTransposeFactor(1.25f);
    check(exactEngine.exact(PlanarInputView{renderInput[0].data(), renderInput[1].data()},
                            static_cast<int>(renderFrames),
                            PlanarOutputView{exactOutput[0].data(), exactOutput[1].data()},
                            static_cast<int>(renderFrames)),
          "upstream exact() accepts the same finite input/output duration");

    allocationCount.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    const bool rejectedShortSeek = seekFrames > 1U &&
        !seekAdapter.outputSeek(seekInputPointers, seekFrames - 1U, playbackRate);
    const bool seekSucceeded = seekAdapter.outputSeek(seekInputPointers, seekFrames, playbackRate);
    bool processedAll = seekSucceeded;
    std::uint32_t processedInput = 0U;
    while (processedAll && processedInput < renderFrames - seekFrames) {
        const auto count = std::min(callbackFrames, renderFrames - seekFrames - processedInput);
        const float* inputChunk[2]{renderInput[0].data() + seekFrames + processedInput,
                                   renderInput[1].data() + seekFrames + processedInput};
        float* outputChunk[2]{seekOutput[0].data() + processedInput,
                              seekOutput[1].data() + processedInput};
        processedAll = seekAdapter.process(inputChunk, count, outputChunk, count);
        processedInput += count;
    }
    float* flushOutput[2]{seekOutput[0].data() + processedInput,
                          seekOutput[1].data() + processedInput};
    const bool flushed = processedAll &&
        seekAdapter.flush(flushOutput, renderFrames - processedInput, playbackRate);
    countAllocations.store(false, std::memory_order_release);

    double renderErrorSquared = 0.0;
    double renderSignalSquared = 0.0;
    double seekLowMain = 0.0;
    double seekHighMain = 0.0;
    double seekCrossLow = 0.0;
    double seekCrossHigh = 0.0;
    for (std::uint32_t frame = 0U; frame < renderFrames; ++frame) {
        for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
            const double difference = static_cast<double>(seekOutput[channel][frame]) -
                                      exactOutput[channel][frame];
            renderErrorSquared += difference * difference;
            renderSignalSquared += static_cast<double>(exactOutput[channel][frame]) *
                                   exactOutput[channel][frame];
        }
    }
    constexpr std::uint32_t renderAnalysisStart = 16384U;
    constexpr std::uint32_t renderAnalysisFrames = 16384U;
    seekLowMain = toneAmplitude(seekOutput[0].data(), renderAnalysisStart,
                                renderAnalysisFrames, 68.75, sampleRate);
    seekHighMain = toneAmplitude(seekOutput[1].data(), renderAnalysisStart,
                                 renderAnalysisFrames, 1246.25, sampleRate);
    seekCrossLow = toneAmplitude(seekOutput[0].data(), renderAnalysisStart,
                                 renderAnalysisFrames, 1246.25, sampleRate);
    seekCrossHigh = toneAmplitude(seekOutput[1].data(), renderAnalysisStart,
                                  renderAnalysisFrames, 68.75, sampleRate);
    const double renderRelativeRmsError = renderSignalSquared > 0.0
        ? std::sqrt(renderErrorSquared / renderSignalSquared) : 1.0;
    check(rejectedShortSeek && seekSucceeded && processedAll && flushed,
          "seek rejects an undersized prefix without consuming state, then process/flush drains successfully");
    check(allocationCount.load(std::memory_order_relaxed) == 0U,
          "bounded outputSeek, process chunks and flush perform no C++ heap allocation after prepare");
    check(renderRelativeRmsError < 1.0e-5,
          "adapter outputSeek/chunked process/flush matches the pinned upstream exact() render");
    check(seekLowMain > 1.0e-3 && seekHighMain > 1.0e-3 &&
          seekCrossLow < seekLowMain * 0.10 && seekCrossHigh < seekHighMain * 0.10,
          "16k HQ fixed-length render retains 55/997 Hz stereo separation after 1.25x transpose");

    // Exercise non-unity duration ratios as well. Each source is just long
    // enough to contain the exact() seek prefix plus one bounded process call;
    // any remaining output is drained with flush at the engine-derived rate.
    for (const float requestedRate : {0.5f, 2.0f}) {
        SignalsmithStretchAdapter rateAdapter(seed);
        const auto rateBytes = SignalsmithStretchAdapter::requiredPrepareBytes(
            renderSpec, renderSettings);
        const bool prepared = rateBytes > 0U && rateAdapter.prepare(
            renderSpec, renderSettings, rateBytes) &&
            rateAdapter.setTransposeFactor(1.25f);
        std::uint32_t guessedSeekFrames = 0U;
        bool rateOk = prepared && rateAdapter.outputSeekLength(
            requestedRate, guessedSeekFrames);
        std::uint32_t remainingInputFrames = requestedRate < 1.0f ? 2048U : 4096U;
        if (requestedRate > 1.0f && ((guessedSeekFrames + remainingInputFrames) & 1U) != 0U)
            ++remainingInputFrames;
        const auto rateInputFrames = guessedSeekFrames + remainingInputFrames;
        const auto rateOutputFrames = static_cast<std::uint32_t>(
            std::lround(static_cast<double>(rateInputFrames) / requestedRate));
        const float actualRate = rateOutputFrames == 0U ? 0.0f :
            static_cast<float>(rateInputFrames) / static_cast<float>(rateOutputFrames);
        std::uint32_t exactSeekFrames = 0U;
        rateOk = rateOk && rateInputFrames >= guessedSeekFrames &&
            rateAdapter.outputSeekLength(actualRate, exactSeekFrames);
        const auto processInputFrames = rateInputFrames >= exactSeekFrames
            ? rateInputFrames - exactSeekFrames : 0U;
        const auto seekOutputFrames = actualRate > 0.0f
            ? static_cast<std::uint32_t>(static_cast<float>(exactSeekFrames) / actualRate) : 0U;
        const auto processOutputFrames = rateOutputFrames >= seekOutputFrames
            ? rateOutputFrames - seekOutputFrames : 0U;
        rateOk = rateOk && exactSeekFrames <= rateInputFrames &&
            processInputFrames > 0U && processInputFrames <= renderSpec.maxBlockFrames &&
            processOutputFrames > 0U && processOutputFrames <= renderSpec.maxBlockFrames &&
            rateOutputFrames > processOutputFrames;

        std::array<std::vector<float>, 2U> rateInput{{
            std::vector<float>(rateInputFrames), std::vector<float>(rateInputFrames)}};
        std::array<std::vector<float>, 2U> rateExpected{{
            std::vector<float>(rateOutputFrames), std::vector<float>(rateOutputFrames)}};
        std::array<std::vector<float>, 2U> rateActual{{
            std::vector<float>(rateOutputFrames), std::vector<float>(rateOutputFrames)}};
        for (std::uint32_t frame = 0U; frame < rateInputFrames; ++frame) {
            const double time = static_cast<double>(frame) / sampleRate;
            rateInput[0][frame] = 0.22f * static_cast<float>(
                std::sin(2.0 * 3.141592653589793 * 220.0 * time));
            rateInput[1][frame] = 0.17f * static_cast<float>(
                std::sin(2.0 * 3.141592653589793 * 317.0 * time + 0.31));
        }
        signalsmith::stretch::SignalsmithStretch<float> rateReference(static_cast<long>(seed));
        rateReference.configure(2, static_cast<int>(renderSettings.blockSamples),
                                static_cast<int>(renderSettings.intervalSamples),
                                renderSettings.splitComputation);
        rateReference.setTransposeFactor(1.25f);
        const bool referenceOk = rateOk && rateReference.exact(
            PlanarInputView{rateInput[0].data(), rateInput[1].data()},
            static_cast<int>(rateInputFrames),
            PlanarOutputView{rateExpected[0].data(), rateExpected[1].data()},
            static_cast<int>(rateOutputFrames));

        const float* rateInputPointers[2]{rateInput[0].data(), rateInput[1].data()};
        float* rateOutputPointers[2]{rateActual[0].data(), rateActual[1].data()};
        allocationCount.store(0U, std::memory_order_relaxed);
        countAllocations.store(true, std::memory_order_release);
        const bool seekOk = referenceOk && rateAdapter.outputSeek(
            rateInputPointers, exactSeekFrames, actualRate);
        const float* processInput[2]{rateInput[0].data() + exactSeekFrames,
                                      rateInput[1].data() + exactSeekFrames};
        float* processOutput[2]{rateActual[0].data(), rateActual[1].data()};
        const bool processOk = seekOk && rateAdapter.process(
            processInput, processInputFrames, processOutput, processOutputFrames);
        float* tailOutput[2]{rateActual[0].data() + processOutputFrames,
                             rateActual[1].data() + processOutputFrames};
        const bool flushOk = processOk && rateAdapter.flush(
            tailOutput, rateOutputFrames - processOutputFrames, actualRate);
        countAllocations.store(false, std::memory_order_release);
        double errorSquared = 0.0;
        double referenceSquared = 0.0;
        for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
            for (std::uint32_t frame = 0U; frame < rateOutputFrames; ++frame) {
                const double difference = static_cast<double>(rateActual[channel][frame]) -
                                          rateExpected[channel][frame];
                errorSquared += difference * difference;
                referenceSquared += static_cast<double>(rateExpected[channel][frame]) *
                                    rateExpected[channel][frame];
            }
        }
        const double relativeError = referenceSquared > 0.0
            ? std::sqrt(errorSquared / referenceSquared) : 1.0;
        check(rateOk && referenceOk && seekOk && processOk && flushOk &&
              allocationCount.load(std::memory_order_relaxed) == 0U &&
              relativeError < 1.0e-5,
              requestedRate < 1.0f
                  ? "0.5x bounded seek/process/flush matches upstream exact() with no callback allocation"
                  : "2x bounded seek/process/flush matches upstream exact() with no callback allocation");
    }

    constexpr std::uint32_t lowHqFrames = 96000U;
    constexpr std::uint32_t lowHqTailFrames = 8192U;
    constexpr std::uint32_t lowHqRenderedFrames = lowHqFrames + lowHqTailFrames;
    constexpr std::uint32_t lowHqAnalysisStart = 48000U;
    constexpr std::uint32_t lowHqAnalysisFrames = 32768U;
    PitchProfileProcessor lowHq(seed);
    check(lowHq.prepare(hqSettings, hqBytes) && lowHq.setPitchRatio(0.5f),
          "prepare the 16k HQ profile for a low-frequency one-octave render");
    std::array<std::vector<float>, 2U> lowHqInput{{std::vector<float>(lowHqRenderedFrames),
                                                   std::vector<float>(lowHqRenderedFrames)}};
    std::array<std::vector<float>, 2U> lowHqOutput{{std::vector<float>(lowHqRenderedFrames),
                                                    std::vector<float>(lowHqRenderedFrames)}};
    for (std::uint32_t frame = 0U; frame < lowHqFrames; ++frame) {
        const double time = static_cast<double>(frame) / sampleRate;
        lowHqInput[0][frame] = 0.25f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 55.0 * time));
        lowHqInput[1][frame] = 0.20f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 68.75 * time + 0.4));
    }
    bool lowHqProcessed = true;
    for (std::uint32_t offset = 0U; offset < lowHqRenderedFrames;) {
        const auto count = std::min(maxBlockFrames, lowHqRenderedFrames - offset);
        lowHqProcessed = lowHqProcessed && lowHq.processStereo(
            lowHqInput[0].data() + offset, lowHqInput[1].data() + offset,
            lowHqOutput[0].data() + offset, lowHqOutput[1].data() + offset, count);
        if (!lowHqProcessed) break;
        offset += count;
    }
    const auto lowHqLeftFundamental = toneAmplitude(lowHqOutput[0].data(),
        lowHqAnalysisStart, lowHqAnalysisFrames, 27.5, sampleRate);
    const auto lowHqRightFundamental = toneAmplitude(lowHqOutput[1].data(),
        lowHqAnalysisStart, lowHqAnalysisFrames, 34.375, sampleRate);
    const auto lowHqLeftOctave = toneAmplitude(lowHqOutput[0].data(),
        lowHqAnalysisStart, lowHqAnalysisFrames, 55.0, sampleRate);
    const auto lowHqRightOctave = toneAmplitude(lowHqOutput[1].data(),
        lowHqAnalysisStart, lowHqAnalysisFrames, 68.75, sampleRate);
    std::printf("HQ16 low one-octave projections: L=%0.6f @27.5 / %0.6f @55, R=%0.6f @34.375 / %0.6f @68.75\n",
                lowHqLeftFundamental, lowHqLeftOctave,
                lowHqRightFundamental, lowHqRightOctave);
    const auto lowHqEarlierLeft = toneAmplitude(lowHqOutput[0].data(), 24000U,
        lowHqAnalysisFrames, 27.5, sampleRate);
    const auto lowHqEarlierRight = toneAmplitude(lowHqOutput[1].data(), 24000U,
        lowHqAnalysisFrames, 34.375, sampleRate);
    const auto lowHqLateLeft = toneAmplitude(lowHqOutput[0].data(), 63232U,
        lowHqAnalysisFrames, 27.5, sampleRate);
    const auto lowHqLateRight = toneAmplitude(lowHqOutput[1].data(), 63232U,
        lowHqAnalysisFrames, 34.375, sampleRate);
    std::printf("HQ16 low target projections by window: 24k L/R=%0.6f/%0.6f, 64k=%0.6f/%0.6f\n",
                lowHqEarlierLeft, lowHqEarlierRight, lowHqLateLeft, lowHqLateRight);
    const auto lowHqLeftPeak = peakBelow200Hz(lowHqOutput[0].data(),
        lowHqAnalysisStart, lowHqAnalysisFrames, sampleRate);
    const auto lowHqRightPeak = peakBelow200Hz(lowHqOutput[1].data(),
        lowHqAnalysisStart, lowHqAnalysisFrames, sampleRate);
    std::printf("HQ16 low global 1-200Hz peaks: L=%0.4fHz/%0.6f, R=%0.4fHz/%0.6f\n",
                lowHqLeftPeak.frequencyHz, lowHqLeftPeak.amplitude,
                lowHqRightPeak.frequencyHz, lowHqRightPeak.amplitude);
    for (std::uint32_t start = 0U; start < lowHqRenderedFrames; start += 16000U) {
        double rmsSquared[2]{};
        float peak[2]{};
        std::uint32_t finite[2]{};
        const auto end = std::min(start + 16000U, lowHqRenderedFrames);
        for (std::uint32_t frame = start; frame < end; ++frame) {
            for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
                const auto sample = lowHqOutput[channel][frame];
                finite[channel] += std::isfinite(sample) ? 1U : 0U;
                peak[channel] = std::max(peak[channel], std::abs(sample));
                rmsSquared[channel] += static_cast<double>(sample) * sample;
            }
        }
        const auto count = static_cast<double>(end - start);
        std::printf("HQ16 window[%u,%u): L rms=%0.6f peak=%0.6f finite=%u; R rms=%0.6f peak=%0.6f finite=%u\n",
                    start, end,
                    std::sqrt(rmsSquared[0] / count), peak[0], finite[0],
                    std::sqrt(rmsSquared[1] / count), peak[1], finite[1]);
    }
    bool lowHqAllFinite = lowHqProcessed;
    for (const auto& channel : lowHqOutput) {
        for (const auto sample : channel) lowHqAllFinite = lowHqAllFinite && std::isfinite(sample);
    }
    const bool lowHqTargetBinsPass = std::abs(lowHqLeftPeak.frequencyHz - 27.5) < 1.5 &&
                                     std::abs(lowHqRightPeak.frequencyHz - 34.375) < 1.5;
    std::printf("HQ16 low-frequency target-bin quality: %s (expected 27.5/34.375 Hz; measured %0.4f/%0.4f Hz)\n",
                lowHqTargetBinsPass ? "PASS" : "NOT PASSED",
                lowHqLeftPeak.frequencyHz, lowHqRightPeak.frequencyHz);
    if (const char* diagnosticDirectory = std::getenv("WEBRC_PITCH_DIAGNOSTICS_DIR")) {
        const auto latency = lowHq.latency();
        check(*diagnosticDirectory != '\0' && writeLowHqArtifacts(
                  diagnosticDirectory, sampleRate, lowHqFrames, lowHqRenderedFrames,
                  lowHqInput, lowHqOutput, lowHqLeftPeak, lowHqRightPeak, latency),
              "write deterministic interleaved stereo PCM, RMS windows and full low-band FFT diagnostics");
    }
    check(lowHqAllFinite && lowHqLeftFundamental > 1.0e-3 &&
          lowHqRightFundamental > 1.0e-3 && lowHqLeftOctave < lowHqLeftFundamental &&
          lowHqRightOctave < lowHqRightFundamental,
          "16k HQ emits finite low-frequency stereo output and the expected tones remain measurable; quality remains separately reported");

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
