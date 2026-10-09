#include "webrc/dsp/cleanroom_rhythm_data.hpp"
#include "webrc/dsp/control_dynamics.hpp"
#include "webrc/dsp/fft.hpp"
#include "webrc/dsp/fx_registry.hpp"
#include "webrc/dsp/nonlinear.hpp"
#include "webrc/dsp/pitch.hpp"
#include "webrc/dsp/primitives.hpp"
#include "webrc/dsp/rhythm.hpp"
#include "webrc/dsp/signalsmith_adapter.hpp"
#include "webrc/dsp/spatial_temporal.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <new>
#include <string>
#include <utility>
#include <vector>

#if defined(_WIN32)
#include <malloc.h>
#endif

namespace {

using namespace webrc::dsp;
using Clock = std::chrono::steady_clock;
constexpr std::uint32_t kSampleRate = 48000;
constexpr std::uint32_t kHostFrames = 64;
constexpr std::uint64_t kBudgetNs = 1'333'333;
constexpr std::uint32_t kStartupCalls = 256;
constexpr std::uint32_t kWarmupCalls = 1024;
constexpr std::uint32_t kSteadyCalls = 10000;
constexpr std::uint32_t kFlushCalls = 512;
thread_local bool gTrackAllocations = false;
std::atomic<std::uint64_t> gProcessNewCalls{0};

std::array<float, kHostFrames> gInputLeft{};
std::array<float, kHostFrames> gInputRight{};
std::array<float, kHostFrames> gOutputLeft{};
std::array<float, kHostFrames> gOutputRight{};

struct StageSamples {
    const char* name = "";
    std::uint64_t firstCallback = 0;
    std::vector<std::uint64_t> nanoseconds;
};

struct CaseResult {
    std::string id;
    std::string workload;
    std::string latencyModel;
    double declaredLatencySamples = -1.0;
    std::uint32_t operationFrames = kHostFrames;
    std::uint32_t hostFrames = kHostFrames;
    std::uint64_t processNewCalls = 0;
    std::uint64_t callbacks = 0;
    std::uint64_t finiteOutputSamples = 0;
    std::uint64_t nonzeroOutputSamples = 0;
    std::uint64_t activeHighWater = 0;
    std::uint64_t eventCountFinal = 0;
    double inputPeak = 0.0;
    double outputEnergy = 0.0;
    double outputPeak = 0.0;
    bool outputRequired = false;
    bool processSucceeded = true;
    std::array<StageSamples, 4> stages{};
};

enum class Stage : std::size_t { Startup = 0, Warmup = 1, Steady = 2, Flush = 3 };

std::uint64_t stageCalls(Stage stage) noexcept {
    switch (stage) {
    case Stage::Startup: return kStartupCalls;
    case Stage::Warmup: return kWarmupCalls;
    case Stage::Steady: return kSteadyCalls;
    case Stage::Flush: return kFlushCalls;
    }
    return 0;
}

const char* stageName(Stage stage) noexcept {
    switch (stage) {
    case Stage::Startup: return "startup";
    case Stage::Warmup: return "warmup";
    case Stage::Steady: return "steady";
    case Stage::Flush: return "flush";
    }
    return "unknown";
}

void fillInput(std::uint64_t absoluteFrame, bool zero) noexcept {
    for (std::uint32_t i = 0; i < kHostFrames; ++i) {
        if (zero) {
            gInputLeft[i] = 0.0f;
            gInputRight[i] = 0.0f;
            continue;
        }
        const double frame = static_cast<double>(absoluteFrame + i);
        const double p440 = 2.0 * 3.14159265358979323846 * 440.0 * frame / kSampleRate;
        const double p997 = 2.0 * 3.14159265358979323846 * 997.0 * frame / kSampleRate;
        const double p554 = 2.0 * 3.14159265358979323846 * 554.37 * frame / kSampleRate;
        const double p1301 = 2.0 * 3.14159265358979323846 * 1301.0 * frame / kSampleRate;
        const auto frame32 = static_cast<std::uint32_t>(absoluteFrame + i);
        const auto noiseWordL = frame32 * 1664525U + 1013904223U;
        const auto noiseWordR = frame32 * 22695477U + 1U;
        const double noiseL = static_cast<double>(noiseWordL) /
                              static_cast<double>(std::numeric_limits<std::uint32_t>::max()) - 0.5;
        const double noiseR = static_cast<double>(noiseWordR) /
                              static_cast<double>(std::numeric_limits<std::uint32_t>::max()) - 0.5;
        gInputLeft[i] = static_cast<float>(0.20 * std::sin(p440) + 0.055 * std::sin(p997) + 0.006 * noiseL);
        gInputRight[i] = static_cast<float>(0.17 * std::cos(p554) + 0.047 * std::sin(p1301) + 0.006 * noiseR);
    }
}

template <class Process, class Observe>
bool runCase(CaseResult& result, Process&& process, Observe&& observe) {
    std::uint64_t callbackIndex = 0;
    std::uint64_t absoluteFrame = 0;
    // Validate the deterministic fixture before starting any timing capture.
    // This catches integer-width or recipe regressions before they contaminate
    // the measured workload and its aggregate statistics.
    fillInput(0U, false);
    for (std::uint32_t i = 0; i < kHostFrames; ++i) {
        const double left = gInputLeft[i];
        const double right = gInputRight[i];
        if (!std::isfinite(left) || !std::isfinite(right) ||
            std::abs(left) > 0.2580001 || std::abs(right) > 0.2200001) {
            result.processSucceeded = false;
            return false;
        }
    }
    std::uint64_t allocationStart = gProcessNewCalls.load(std::memory_order_relaxed);
    for (std::size_t stageIndex = 0; stageIndex < result.stages.size(); ++stageIndex) {
        const auto stage = static_cast<Stage>(stageIndex);
        auto& capture = result.stages[stageIndex];
        capture.name = stageName(stage);
        capture.firstCallback = callbackIndex;
        capture.nanoseconds.reserve(static_cast<std::size_t>(stageCalls(stage)));
        for (std::uint64_t local = 0; local < stageCalls(stage); ++local, ++callbackIndex) {
            fillInput(absoluteFrame, stage == Stage::Flush);
            for (std::uint32_t i = 0; i < kHostFrames; ++i) {
                result.inputPeak = std::max(result.inputPeak,
                    std::max(std::abs(static_cast<double>(gInputLeft[i])),
                             std::abs(static_cast<double>(gInputRight[i]))));
            }
            gOutputLeft.fill(0.0f);
            gOutputRight.fill(0.0f);
            const auto beforeAllocations = gProcessNewCalls.load(std::memory_order_relaxed);
            gTrackAllocations = true;
            const auto start = Clock::now();
            const bool success = process(stage, local, callbackIndex, absoluteFrame);
            const auto stop = Clock::now();
            gTrackAllocations = false;
            const auto afterAllocations = gProcessNewCalls.load(std::memory_order_relaxed);
            if (!success) {
                result.processSucceeded = false;
                return false;
            }
            result.processNewCalls += afterAllocations - beforeAllocations;
            const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start).count();
            capture.nanoseconds.push_back(static_cast<std::uint64_t>(std::max<std::int64_t>(0, ns)));
            ++result.callbacks;
            const auto activeAndEvents = observe();
            result.activeHighWater = std::max(result.activeHighWater, activeAndEvents.first);
            result.eventCountFinal = activeAndEvents.second;
            for (std::uint32_t i = 0; i < kHostFrames; ++i) {
                const float left = gOutputLeft[i];
                const float right = gOutputRight[i];
                if (std::isfinite(left)) ++result.finiteOutputSamples;
                if (std::isfinite(right)) ++result.finiteOutputSamples;
                if (left != 0.0f) ++result.nonzeroOutputSamples;
                if (right != 0.0f) ++result.nonzeroOutputSamples;
                if (std::isfinite(left)) {
                    result.outputEnergy += static_cast<double>(left) * left;
                    result.outputPeak = std::max(result.outputPeak, std::abs(static_cast<double>(left)));
                }
                if (std::isfinite(right)) {
                    result.outputEnergy += static_cast<double>(right) * right;
                    result.outputPeak = std::max(result.outputPeak, std::abs(static_cast<double>(right)));
                }
            }
            absoluteFrame += kHostFrames;
        }
    }
    result.processNewCalls += gProcessNewCalls.load(std::memory_order_relaxed) - allocationStart - result.processNewCalls;
    return true;
}

struct Stats {
    double p50 = 0.0;
    double p95 = 0.0;
    double p99 = 0.0;
    double p999 = 0.0;
    std::uint64_t maximum = 0;
    std::uint64_t overBudget = 0;
};

Stats statsFor(const std::vector<std::uint64_t>& input) {
    Stats result{};
    if (input.empty()) return result;
    auto sorted = input;
    std::sort(sorted.begin(), sorted.end());
    const auto percentile = [&sorted](double p) {
        const auto rank = static_cast<std::size_t>(std::ceil(p * sorted.size()));
        return static_cast<double>(sorted[std::min(sorted.size() - 1U, rank == 0U ? 0U : rank - 1U)]);
    };
    result.p50 = percentile(0.50);
    result.p95 = percentile(0.95);
    result.p99 = percentile(0.99);
    result.p999 = percentile(0.999);
    result.maximum = sorted.back();
    result.overBudget = static_cast<std::uint64_t>(std::count_if(input.begin(), input.end(),
        [](std::uint64_t sample) { return sample > kBudgetNs; }));
    return result;
}

void writeSamples(std::ostream& out, const std::vector<std::uint64_t>& samples) {
    out << '[';
    for (std::size_t i = 0; i < samples.size(); ++i) {
        if (i != 0U) out << ',';
        out << samples[i];
    }
    out << ']';
}

void writeStats(std::ostream& out, const Stats& s) {
    out << "{\"p50Ns\":" << s.p50 << ",\"p95Ns\":" << s.p95
        << ",\"p99Ns\":" << s.p99 << ",\"p999Ns\":" << s.p999
        << ",\"maxNs\":" << s.maximum << ",\"overBudgetCallbacks\":" << s.overBudget << '}';
}

std::string jsonEscape(const char* value) {
    std::string result;
    if (!value) return result;
    for (const unsigned char ch : std::string(value)) {
        switch (ch) {
        case '"': result += "\\\""; break;
        case '\\': result += "\\\\"; break;
        case '\n': result += "\\n"; break;
        case '\r': result += "\\r"; break;
        case '\t': result += "\\t"; break;
        default: result += ch < 0x20 ? '?' : static_cast<char>(ch); break;
        }
    }
    return result;
}

void writeCase(std::ostream& out, const CaseResult& c) {
    out << "{\"id\":\"" << c.id << "\",\"workload\":\"" << c.workload
        << "\",\"hostCallbackFrames\":" << c.hostFrames
        << ",\"operationFrames\":" << c.operationFrames
        << ",\"latencyModel\":\"" << c.latencyModel << "\",\"declaredLatencySamples\":";
    if (c.declaredLatencySamples < 0) out << "null";
    else out << c.declaredLatencySamples;
    out << ",\"processOperatorNewCalls\":" << c.processNewCalls
        << ",\"callbacks\":" << c.callbacks
        << ",\"finiteOutputSamples\":" << c.finiteOutputSamples
        << ",\"nonzeroOutputSamples\":" << c.nonzeroOutputSamples
        << ",\"outputRequired\":" << (c.outputRequired ? "true" : "false")
        << ",\"activeHighWater\":" << c.activeHighWater
        << ",\"eventCountFinal\":" << c.eventCountFinal
        << ",\"inputPeak\":" << c.inputPeak
        << ",\"outputRmsAcrossCallbacks\":"
        << (c.finiteOutputSamples == 0U ? 0.0 : std::sqrt(c.outputEnergy / c.finiteOutputSamples))
        << ",\"outputPeak\":" << c.outputPeak << ",\"processSucceeded\":"
        << (c.processSucceeded ? "true" : "false") << ",\"stages\":[";
    for (std::size_t i = 0; i < c.stages.size(); ++i) {
        if (i != 0U) out << ',';
        const auto& stage = c.stages[i];
        out << "{\"name\":\"" << stage.name << "\",\"firstCallback\":" << stage.firstCallback
            << ",\"callbackCount\":" << stage.nanoseconds.size() << ",\"summary\":";
        writeStats(out, statsFor(stage.nanoseconds));
        out << ",\"samplesNs\":";
        writeSamples(out, stage.nanoseconds);
        out << '}';
    }
    out << "]}";
}

bool writeReport(const std::vector<CaseResult>& cases, const char* path) {
    std::ofstream file;
    std::ostream* out = &std::cout;
    if (path && path[0] != '\0') {
        file.open(path, std::ios::out | std::ios::trunc);
        if (!file) return false;
        out = &file;
    }
    *out << "{\n\"schemaVersion\":\"webrc-native-sustained-dsp-v1\",\n"
         << "\"scope\":\"software-only 64-frame processor workloads; per-call wall-clock timings; no audio device, full-product graph, 30-minute soak, or XRUN claim\",\n"
         << "\"timingMethod\":\"one steady_clock interval around each processor callback; timer overhead included; input generation, output scan, stats, and JSON excluded\",\n"
         << "\"sampleRateHz\":" << kSampleRate << ",\"hostCallbackFrames\":" << kHostFrames
         << ",\"hostCallbackBudgetNs\":" << kBudgetNs
         << ",\"calls\":{\"startup\":" << kStartupCalls << ",\"warmup\":" << kWarmupCalls
         << ",\"steady\":" << kSteadyCalls << ",\"flush\":" << kFlushCalls << "},\n"
         << "\"sourceCommit\":\"" << jsonEscape(std::getenv("WEBRC_DSP_SOURCE_REV"))
         << "\",\"sourceFingerprintSha256\":\"" << jsonEscape(std::getenv("WEBRC_DSP_SOURCE_HASH"))
         << "\",\"compilerFlags\":\"" << jsonEscape(std::getenv("WEBRC_DSP_BUILD_FLAGS"))
         << "\",\"cpuModel\":\"" << jsonEscape(std::getenv("WEBRC_DSP_CPU"))
         << "\",\"os\":\"" << jsonEscape(std::getenv("WEBRC_DSP_OS")) << "\",\"compiler\":\"";
#if defined(_MSC_VER)
    *out << "MSVC " << _MSC_VER;
#elif defined(__clang__)
    *out << "Clang " << __clang_version__;
#elif defined(__GNUC__)
    *out << "GCC " << __VERSION__;
#else
    *out << "unknown";
#endif
    *out << "\",\"cases\":[\n";
    for (std::size_t i = 0; i < cases.size(); ++i) {
        if (i != 0U) *out << ",\n";
        writeCase(*out, cases[i]);
    }
    *out << "\n]}\n";
    return static_cast<bool>(*out);
}

template <class Process, class Observe>
bool addCase(std::vector<CaseResult>& cases, const char* id, const char* workload,
             const char* latencyModel, double latency, bool outputRequired,
             std::uint32_t operationFrames, Process&& process, Observe&& observe) {
    CaseResult item{};
    item.id = id;
    item.workload = workload;
    item.latencyModel = latencyModel;
    item.declaredLatencySamples = latency;
    item.outputRequired = outputRequired;
    item.operationFrames = operationFrames;
    if (!runCase(item, std::forward<decltype(process)>(process), std::forward<decltype(observe)>(observe))) return false;
    if (item.finiteOutputSamples != (item.callbacks * kHostFrames * 2U)) return false;
    if (item.processNewCalls != 0U) return false;
    if (item.outputRequired && item.nonzeroOutputSamples == 0U) return false;
    cases.push_back(std::move(item));
    return true;
}

template <class Processor>
bool addBlockCase(std::vector<CaseResult>& cases, const char* id, const char* workload,
                  Processor& processor, double latency = 0.0,
                  const char* latencyModel = "fixed", bool outputRequired = true) {
    return addCase(cases, id, workload, latencyModel, latency, outputRequired, kHostFrames,
        [&processor](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
            return processor.processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames);
        }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; });
}

} // namespace

void* operator new(std::size_t size) {
    if (gTrackAllocations) gProcessNewCalls.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) { return ::operator new(size); }
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    try {
        std::vector<CaseResult> cases;
        cases.reserve(64U);
        const ProcessSpec stereoSpec{static_cast<float>(kSampleRate), kHostFrames, 2U};
        const ProcessSpec monoSpec{static_cast<float>(kSampleRate), kHostFrames, 1U};
        std::array<float, kHostFrames> out3{};
        std::array<float, kHostFrames> delays{};
        std::array<double, kHostFrames> phases{};
        std::array<SvfOutput, kHostFrames> svf{};
        std::array<OnsetResult, kHostFrames> onset{};
        std::array<float, 2048> yinInput{};
        std::array<std::complex<float>, 1024> spectrum{};
        std::array<float, 256> ir{};
        std::array<float, 4096> longIr{};
        for (std::uint32_t i = 0; i < kHostFrames; ++i) {
            delays[i] = 180.25f;
            phases[i] = static_cast<double>(i) / kHostFrames;
        }
        for (std::size_t i = 0; i < yinInput.size(); ++i) {
            yinInput[i] = static_cast<float>(0.5 * std::sin(2.0 * 3.14159265358979323846 * 220.0 * i / kSampleRate));
        }
        for (std::size_t i = 0; i < spectrum.size(); ++i) {
            const double phase = 2.0 * 3.14159265358979323846 * 17.0 * i / spectrum.size();
            spectrum[i] = {static_cast<float>(std::sin(phase)), static_cast<float>(0.1 * std::cos(phase))};
        }
        for (std::size_t i = 0; i < ir.size(); ++i) ir[i] = static_cast<float>(0.7 * std::exp(-static_cast<double>(i) / 45.0));
        for (std::size_t i = 0; i < longIr.size(); ++i) {
            const double decay = std::exp(-6.0 * static_cast<double>(i) / static_cast<double>(longIr.size()));
            longIr[i] = static_cast<float>(0.24 * decay *
                (std::cos(2.0 * 3.14159265358979323846 * 0.0031 * i) +
                 0.32 * std::sin(2.0 * 3.14159265358979323846 * 0.0117 * i)));
        }

        ParameterSmoother smoother;
        if (!smoother.prepare(stereoSpec)) return 10;
        smoother.reset(0.2f);
        if (!smoother.setTarget(0.8f, 20.0f) || !addCase(cases, "ParameterSmoother", "64-sample exponential smoothing with target automation every 128 callbacks", "fixed", 0, true, 64,
            [&smoother](Stage, std::uint64_t local, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !smoother.setTarget((callback & 128U) ? 0.25f : 0.85f, 20.0f)) return false;
                if (!smoother.processBlock(gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                (void)local;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 11;

        std::array<BiquadDf2T, 2> biquad{};
        if (!biquad[0].prepare(stereoSpec) || !biquad[1].prepare(stereoSpec) ||
            !biquad[0].setLowpass(6200.0f, 0.707f, 5.0f) || !biquad[1].setLowpass(6200.0f, 0.707f, 5.0f) ||
            !addCase(cases, "BiquadDf2T", "stereo LPF with smoothed cutoff automation", "frequency_dependent_group_delay", 0, true, 64,
            [&biquad](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U &&
                    (!biquad[0].setLowpass((callback & 128U) ? 6200.0f : 4100.0f, 0.707f, 5.0f) ||
                     !biquad[1].setLowpass((callback & 128U) ? 6200.0f : 4100.0f, 0.707f, 5.0f))) return false;
                if (!biquad[0].processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames)) return false;
                if (!biquad[1].processBlock(gInputRight.data(), gOutputRight.data(), kHostFrames)) return false;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 12;

        TptStateVariableFilter svfFilter;
        if (!svfFilter.prepare(monoSpec) || !svfFilter.setFrequencyQ(1400.0f, 0.8f, 5.0f) ||
            !addCase(cases, "TptStateVariableFilter", "mono three-output TPT SVF; low/band/high represented in output arrays", "frequency_dependent_group_delay", 0, true, 64,
            [&svfFilter, &out3](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !svfFilter.setFrequencyQ((callback & 128U) ? 1400.0f : 3800.0f, 0.8f, 5.0f)) return false;
                if (!svfFilter.processBlock(gInputLeft.data(), gOutputLeft.data(), out3.data(), gOutputRight.data(), kHostFrames)) return false;
                for (std::uint32_t i = 0; i < kHostFrames; ++i) gOutputRight[i] += out3[i];
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 13;

        std::array<AllPass1, 2> allpass{};
        if (!allpass[0].prepare(stereoSpec) || !allpass[1].prepare(stereoSpec) ||
            !allpass[0].setFrequency(1200.0f) || !allpass[1].setFrequency(1200.0f) ||
            !addCase(cases, "AllPass1", "stereo all-pass with smoothed frequency automation", "frequency_dependent_group_delay", 0, true, 64,
            [&allpass](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U &&
                    (!allpass[0].setFrequency((callback & 128U) ? 1200.0f : 3600.0f) ||
                     !allpass[1].setFrequency((callback & 128U) ? 1200.0f : 3600.0f))) return false;
                return allpass[0].processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames) &&
                       allpass[1].processBlock(gInputRight.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 14;

        std::array<LagrangeDelay, 2> delay{};
        if (!delay[0].prepare(stereoSpec, 2048U) || !delay[1].prepare(stereoSpec, 2048U)) return 15;
        if (!addCase(cases, "LagrangeDelay", "stereo fractional-delay read with a 180.25-sample automated trajectory", "variable_delay", -1, true, 64,
            [&delay, &delays](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                const float currentDelay = (callback & 128U) ? 180.25f : 400.5f;
                delays.fill(currentDelay);
                return delay[0].processBlock(gInputLeft.data(), gOutputLeft.data(), delays.data(), kHostFrames) &&
                       delay[1].processBlock(gInputRight.data(), gOutputRight.data(), delays.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 16;

        if (!addCase(cases, "Sinc8Read", "stereo 8-tap windowed-sinc fractional reads at 0.37-sample phase", "four_sample_lookahead", 4.0, true, 64,
            [](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                for (std::uint32_t i = 0; i < kHostFrames; ++i) {
                    const double position = static_cast<double>(i) + 0.37;
                    gOutputLeft[i] = sinc8Read(gInputLeft.data(), kHostFrames, position, BoundaryMode::Wrap);
                    gOutputRight[i] = sinc8Read(gInputRight.data(), kHostFrames, position, BoundaryMode::Wrap);
                }
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 58;

        Lfo lfo;
        if (!lfo.prepare(stereoSpec) || !lfo.setFrequency(4.2f) ||
            !addCase(cases, "Lfo", "single sine LFO stream", "fixed", 0, true, 64,
            [&lfo](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 256U) == 0U && !lfo.setFrequency((callback & 256U) ? 4.2f : 7.5f)) return false;
                if (!lfo.processBlock(gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 17;

        PolyBlepOscillator oscillator;
        if (!oscillator.prepare(stereoSpec) || !oscillator.setFrequency(220.0f)) return 18;
        oscillator.setWaveform(OscillatorWaveform::Saw);
        if (!addCase(cases, "PolyBlepOscillator", "band-limited saw with low-rate pitch automation", "fixed", 0, true, 64,
            [&oscillator](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !oscillator.setFrequency((callback & 128U) ? 220.0f : 330.0f)) return false;
                if (!oscillator.processBlock(gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 19;

        std::array<AdaaCubicShaper, 2> adaa{};
        if (!adaa[0].prepare(stereoSpec) || !adaa[1].prepare(stereoSpec) ||
            !adaa[0].setDrive(2.4f) || !adaa[1].setDrive(2.4f) ||
            !addCase(cases, "AdaaCubicShaper", "stereo first-order cubic ADAA with drive automation", "frequency_dependent_group_delay", -1, true, 64,
            [&adaa](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U &&
                    (!adaa[0].setDrive((callback & 128U) ? 2.4f : 1.5f) ||
                     !adaa[1].setDrive((callback & 128U) ? 2.4f : 1.5f))) return false;
                return adaa[0].processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames) &&
                       adaa[1].processBlock(gInputRight.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 20;

        DualDetectorCompressor compressor;
        if (!compressor.prepare(stereoSpec) || !compressor.setParameters(-18.0f, 4.0f, 6.0f, 5.0f, 80.0f, 0.5f, 0.0f) ||
            !addCase(cases, "DualDetectorCompressor", "stereo peak/RMS detector with sustained dual-tone input", "fixed", 0, true, 64,
            [&compressor](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 256U) == 0U && !compressor.setParameters((callback & 256U) ? -18.0f : -22.0f, 4.0f, 6.0f, 5.0f, 80.0f, 0.5f, 0.0f)) return false;
                return compressor.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 21;

        DelayMatrix2 matrix;
        if (!matrix.setFeedback(0.55f, 0.28f) ||
            !addCase(cases, "DelayMatrix2", "2x2 feedback matrix using externally delayed stereo signal", "fixed", 0, true, 64,
            [&matrix](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                for (std::uint32_t i = 0; i < kHostFrames; ++i) {
                    const auto frame = matrix.process({gInputLeft[i], gInputRight[i]},
                                                      {gInputLeft[(i + 13U) % kHostFrames], gInputRight[(i + 29U) % kHostFrames]});
                    gOutputLeft[i] = frame.left;
                    gOutputRight[i] = frame.right;
                }
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 22;

        Pcg32 pcg;
        pcg.seed(0x4d595df4ULL, 7ULL);
        if (!addCase(cases, "Pcg32", "64 deterministic PCG32 draws with float conversion", "fixed", 0, true, 64,
            [&pcg](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                for (std::uint32_t i = 0; i < kHostFrames; ++i) gOutputLeft[i] = pcg.nextBipolar();
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 23;

        PatternSlicer slicer;
        constexpr std::array<float, 8> gains{{1.0f,0.0f,0.45f,0.0f,0.8f,0.0f,0.45f,0.0f}};
        if (!slicer.prepare(stereoSpec) || !slicer.setPattern(gains.data(), gains.size(), 0.08f) ||
            !addCase(cases, "PatternSlicer", "8-step gain pattern with sample-varying cycle phase", "fixed", 0, true, 64,
            [&slicer, &phases](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                for (std::uint32_t i = 0; i < kHostFrames; ++i) phases[i] = std::fmod((callback * kHostFrames + i) * 0.00031, 1.0);
                return slicer.processBlock(gInputLeft.data(), phases.data(), gOutputLeft.data(), kHostFrames) &&
                       slicer.processBlock(gInputRight.data(), phases.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 24;

        SampleAccurateScheduler scheduler;
        if (!scheduler.prepare(stereoSpec, 127.0, 960U)) return 25;
        std::array<ScheduledEvent, 4> scheduled{};
        if (!addCase(cases, "SampleAccurateScheduler", "schedule and collect one sample-accurate event per 64-frame callback", "fixed", 0, false, 64,
            [&scheduler, &scheduled](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t frame) {
                const ScheduledEvent event{frame + 32U, static_cast<std::uint32_t>(callback), 0.5f, 0U, false};
                std::uint32_t count = 0;
                if (!scheduler.scheduleAbsolute(event) || !scheduler.collectBlock(frame, kHostFrames, scheduled.data(), scheduled.size(), count)) return false;
                gOutputLeft[0] = static_cast<float>(count);
                return true;
            }, [&scheduler] { return std::pair<std::uint64_t, std::uint64_t>{scheduler.queuedCount(), 0U}; })) return 26;

        MidSideWidth width;
        if (!width.prepare(stereoSpec) || !width.setWidth(1.35f, 0.65f) ||
            !addCase(cases, "MidSideWidth", "stereo low/high-band width with correlation tracking", "frequency_dependent_group_delay", 0, true, 64,
            [&width](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !width.setWidth((callback & 128U) ? 1.35f : 0.85f, 0.65f, 10.0f)) return false;
                return width.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [&width] { return std::pair<std::uint64_t, std::uint64_t>{0U, static_cast<std::uint64_t>(std::abs(width.correlationEstimate()) * 1000000.0f)}; })) return 27;

        OnsetDetector onsetDetector;
        if (!onsetDetector.prepare(monoSpec) || !onsetDetector.setParameters(0.008f, 1.2f, 1.0f, 35.0f) ||
            !addCase(cases, "OnsetDetector", "64-sample onset detector with independent transient/noise input", "fixed", 0, false, 64,
            [&onsetDetector, &onset](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                if (!onsetDetector.processBlock(gInputLeft.data(), onset.data(), kHostFrames)) return false;
                for (std::uint32_t i = 0; i < kHostFrames; ++i) gOutputLeft[i] = onset[i].envelope;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 28;

        BitRateReducer reducerLeft, reducerRight;
        if (!reducerLeft.prepare(monoSpec) || !reducerRight.prepare(monoSpec)) return 29;
        reducerLeft.reset(0x4d595df4ULL, 7ULL);
        reducerRight.reset(0x9e3779b9ULL, 13ULL);
        if (!reducerLeft.setParameters(8U, 3U, 0.8f, true) || !reducerRight.setParameters(8U, 3U, 0.8f, true) ||
            !addCase(cases, "BitRateReducer", "stereo dithered 8-bit reducer using independent left/right mono states and automated wet mix", "fixed", 0, true, 64,
            [&reducerLeft, &reducerRight](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U &&
                    (!reducerLeft.setParameters(8U, 3U, (callback & 128U) ? 0.8f : 0.55f, true) ||
                     !reducerRight.setParameters(8U, 3U, (callback & 128U) ? 0.8f : 0.55f, true))) return false;
                return reducerLeft.processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames) &&
                       reducerRight.processBlock(gInputRight.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 30;

        RingModulator ringMod;
        if (!ringMod.prepare(monoSpec) || !ringMod.setParameters(997.0f, 0.7f) ||
            !addCase(cases, "RingModulator", "mono 997-Hz LFO ring modulation with depth automation", "fixed", 0, true, 64,
            [&ringMod](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !ringMod.setParameters(997.0f, (callback & 128U) ? 0.7f : 0.35f)) return false;
                if (!ringMod.processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 31;

        WdfSymmetricDiode diode;
        if (!diode.prepare(monoSpec, 1000.0, 2.0e-9, 0.02585, 1.0) ||
            !addCase(cases, "WdfSymmetricDiode", "mono nonlinear diode one-port scattering solve", "fixed", 0, true, 64,
            [&diode](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !diode.setParameters((callback & 128U) ? 1000.0 : 680.0, 2.0e-9, 0.02585, 1.0)) return false;
                if (!diode.processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 32;

        OversampledNonlinear os2;
        if (!os2.prepare(monoSpec, OversamplingFactor::x2, NonlinearModel::AdaaCubic) || !os2.setDrive(2.0f) ||
            !addCase(cases, "OversampledNonlinear_2x_ADAA", "mono 2x half-band ADAA saturator", "frequency_dependent_group_delay", -1, true, 64,
            [&os2](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !os2.setDrive((callback & 128U) ? 2.0f : 3.0f)) return false;
                if (!os2.processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 33;

        OversampledNonlinear os4;
        if (!os4.prepare(monoSpec, OversamplingFactor::x4, NonlinearModel::AdaaCubic) || !os4.setDrive(2.0f) ||
            !addCase(cases, "OversampledNonlinear_4x_ADAA", "mono cascaded 4x half-band ADAA saturator", "frequency_dependent_group_delay", -1, true, 64,
            [&os4](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !os4.setDrive((callback & 128U) ? 2.0f : 3.0f)) return false;
                if (!os4.processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 34;

        OversampledNonlinear os2Diode;
        if (!os2Diode.prepare(monoSpec, OversamplingFactor::x2, NonlinearModel::WdfSymmetricDiode) ||
            !addCase(cases, "OversampledNonlinear_2x_WDF", "mono 2x half-band WDF diode; measured FIR group delay 14.75 samples, nonlinear phase remains signal dependent", "measured_halfband_fir_group_delay", 14.75, true, 64,
            [&os2Diode](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !os2Diode.setDiodeParameters((callback & 128U) ? 1000.0 : 680.0, 2.0e-9, 0.02585, 1.0)) return false;
                if (!os2Diode.processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 35;

        std::array<float, 256> convLL = ir, convLR{}, convRL{}, convRR = ir;
        PartitionedConvolver convolver;
        if (!convolver.prepare(stereoSpec, 64U, 256U, convLL.data(), convLR.data(), convRL.data(), convRR.data()) ||
            !addCase(cases, "PartitionedConvolver", "stereo 2x2 256-tap FIR, uniform 64-sample overlap-save", "fixed", 64, true, 64,
            [&convolver](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                return convolver.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 36;

        PartitionedConvolver longConvolver;
        if (!longConvolver.prepare(stereoSpec, 64U, static_cast<std::uint32_t>(longIr.size()),
                                   longIr.data(), nullptr, nullptr, longIr.data()) ||
            !addCase(cases, "PartitionedConvolver_4096tap", "stereo diagonal 2x2 4096-tap decaying multi-tone IR, 64-sample overlap-save", "fixed", 64, true, 64,
            [&longConvolver](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                return longConvolver.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 59;

        FdnReverb fdn8;
        if (!fdn8.prepare(stereoSpec, FdnLineCount::Eight, 0.12f) ||
            !fdn8.setParameters(2.0f, 6500.0f, 0.25f, 0.8f, 0.985f, 0.65f, 20.0f) ||
            !addCase(cases, "FdnReverb_8", "8-line modulated FDN at sustained stereo input", "frequency_dependent_group_delay", -1, true, 64,
            [&fdn8](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 256U) == 0U && !fdn8.setParameters((callback & 256U) ? 2.0f : 1.4f, 6500.0f, 0.25f, 0.8f, 0.985f, 0.65f, 20.0f)) return false;
                return fdn8.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 37;

        FdnReverb fdn16;
        if (!fdn16.prepare(stereoSpec, FdnLineCount::Sixteen, 0.12f) ||
            !fdn16.setParameters(2.0f, 6500.0f, 0.25f, 0.8f, 0.985f, 0.65f, 20.0f) ||
            !addCase(cases, "FdnReverb_16", "16-line modulated FDN at sustained stereo input", "frequency_dependent_group_delay", -1, true, 64,
            [&fdn16](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 256U) == 0U && !fdn16.setParameters((callback & 256U) ? 2.0f : 1.4f, 6500.0f, 0.25f, 0.8f, 0.985f, 0.65f, 20.0f)) return false;
                return fdn16.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 38;

        GranularTexture granular;
        if (!granular.prepare(stereoSpec, 2.0f) || !granular.setParameters(64.0f, 200.0f, 1.25f, 0.7f, 0.7f, 0x4d595df4ULL) ||
            !addCase(cases, "GranularTexture", "stereo 64-ms grains at maximum admitted 200-Hz density (about 13 live slots)", "observed_grain_window", -1, true, 64,
            [&granular](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 256U) == 0U && !granular.setParameters((callback & 256U) ? 64.0f : 52.0f, 200.0f, 1.25f, 0.7f, 0.7f, 0x4d595df4ULL)) return false;
                return granular.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [&granular] { return std::pair<std::uint64_t, std::uint64_t>{granular.activeGrains(), 0U}; })) return 39;

        GranularTexture granularFullPool;
        if (!granularFullPool.prepare(stereoSpec, 2.0f) || !granularFullPool.setParameters(200.0f, 200.0f, 1.25f, 0.7f, 0.7f, 0x74ac3e91ULL) ||
            !addCase(cases, "GranularTexture_32Slot", "stereo 200-ms grains at maximum admitted 200-Hz density; 32-slot pool high-water must saturate", "observed_grain_window", -1, true, 64,
            [&granularFullPool](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                return granularFullPool.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [&granularFullPool] { return std::pair<std::uint64_t, std::uint64_t>{granularFullPool.activeGrains(), 0U}; })) return 60;

        SpectralFreeze freeze;
        if (!freeze.prepare(stereoSpec, 1024U, 256U) || !freeze.setMix(0.75f) ||
            !addCase(cases, "SpectralFreeze", "stereo WOLA freeze: capture during startup/warmup then remain frozen in steady/flush", "fixed", 1024, true, 64,
            [&freeze](Stage stage, std::uint64_t local, std::uint64_t callback, std::uint64_t) {
                if (stage == Stage::Steady && local == 0U && !freeze.setFreeze(true)) return false;
                if (stage == Stage::Flush && local == 0U && !freeze.setFreeze(false)) return false;
                if ((callback % 256U) == 0U && !freeze.setMix((callback & 256U) ? 0.75f : 0.55f)) return false;
                return freeze.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [&freeze] { return std::pair<std::uint64_t, std::uint64_t>{freeze.frozen() ? 1U : 0U, 0U}; })) return 40;

        ReverseSegment reverse;
        if (!reverse.prepare(stereoSpec, 1024U, 256U, 64U) ||
            !addCase(cases, "ReverseSegment", "dual-history fixed 256-frame reverse segments with 64-frame crossfade", "fixed", reverse.algorithmicLatencySamples(), true, 64,
            [&reverse](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                return reverse.processBlock(gInputLeft.data(), gInputRight.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 41;

        PlatterInertia platter;
        if (!platter.prepare(stereoSpec) || !platter.setInertia(1.5f, 0.8f) ||
            !addCase(cases, "PlatterInertia", "target-speed automation with phase/speed/acceleration outputs", "fixed", 0, true, 64,
            [&platter, &phases, &out3](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 128U) == 0U && !platter.setTargetSpeed((callback & 128U) ? 1.0f : 0.75f)) return false;
                if (!platter.processBlock(gOutputLeft.data(), phases.data(), out3.data(), kHostFrames)) return false;
                for (std::uint32_t i = 0; i < kHostFrames; ++i) gOutputRight[i] = out3[i];
                return true;
            }, [&platter] { return std::pair<std::uint64_t, std::uint64_t>{0U, static_cast<std::uint64_t>(std::abs(platter.currentSpeedRatio()) * 1000.0f)}; })) return 42;

        DrumVoicePool drums;
        if (!drums.prepare(stereoSpec) ||
            !addCase(cases, "DrumVoicePool", "mixed fixed 8-slot modal/kick/snare/hat voices, retrigger every fourth callback", "fixed", 0, true, 64,
            [&drums](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 4U) == 0U) {
                    const auto ordinal = callback / 4U;
                    bool triggered = false;
                    if ((ordinal % 4U) == 0U) triggered = drums.triggerKick({150.0f,45.0f,0.08f,0.65f,0.7f});
                    else if ((ordinal % 4U) == 1U) triggered = drums.triggerSnare({185.0f,0.3f,0.22f,0.8f,0.65f,0.2f,ordinal + 1U});
                    else if ((ordinal % 4U) == 2U) triggered = drums.triggerHiHat({4200.0f,0.18f,0.5f,0.4f,0.3f,ordinal + 1U});
                    else triggered = drums.triggerModal({120.0f,0.4f,0.7f,0.1f,0.65f,0.2f,ordinal + 1U});
                    if (!triggered) return false;
                }
                return drums.processBlock(gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [&drums] { return std::pair<std::uint64_t, std::uint64_t>{drums.activeVoices(), 0U}; })) return 43;

        std::array<RhythmEvent, 32> rhythmEvents{};
        for (std::uint32_t i = 0; i < rhythmEvents.size(); ++i) {
            const auto instrument = static_cast<RhythmInstrument>(i % static_cast<std::uint32_t>(RhythmInstrument::Count));
            // 32 events span one complete 4/4 bar (3840 PPQ ticks).
            rhythmEvents[i] = {i * 120U, instrument, static_cast<std::uint8_t>(80U + i % 40U), false, instrument == RhythmInstrument::BrushSweep ? 240U : 0U};
        }
        RhythmPatternView densePattern{};
        densePattern.numerator = 4;
        densePattern.denominator = 4;
        for (auto& variation : densePattern.variations) variation = {rhythmEvents.data(), static_cast<std::uint32_t>(rhythmEvents.size())};
        densePattern.intro = densePattern.fill = densePattern.ending = {rhythmEvents.data(), static_cast<std::uint32_t>(rhythmEvents.size())};
        RhythmRenderer rhythm;
        if (!rhythm.prepare(stereoSpec, 400.0) || !rhythm.setPattern(&densePattern) || !rhythm.setKit(7U) || !rhythm.startAtFrame(0U, false) ||
            !addCase(cases, "RhythmRenderer_Dense", "400 BPM synthetic 32-event/bar pattern on brush kit; active-voice and event counters", "scheduled_event_onset", -1, true, 64,
            [&rhythm](Stage, std::uint64_t, std::uint64_t, std::uint64_t frame) {
                return rhythm.processBlock(frame, gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [&rhythm] { return std::pair<std::uint64_t, std::uint64_t>{rhythm.activeVoices(), rhythm.triggeredEvents()}; })) return 44;

        YinPitchDetector yin;
        if (!yin.prepare(monoSpec, static_cast<std::uint32_t>(yinInput.size()), 60.0f, 1000.0f, 0.15f)) return 45;
        PitchEstimate estimate{};
        if (!addCase(cases, "YinPitchDetector_2048cadence", "2048-sample YIN analysis once per 32 host callbacks; other callbacks carry no analysis", "analysis_window", 2048, false, 2048,
            [&yin, &estimate, &yinInput](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 32U) == 0U && !yin.analyze(yinInput.data(), static_cast<std::uint32_t>(yinInput.size()), estimate)) return false;
                gOutputLeft[0] = estimate.voiced ? estimate.frequencyHz / 1000.0f : 0.0f;
                return true;
            }, [&estimate] { return std::pair<std::uint64_t, std::uint64_t>{estimate.voiced ? 1U : 0U, 0U}; })) return 46;

        YinPitchDetector yinWorstCase;
        PitchEstimate worstCaseEstimate{};
        if (!yinWorstCase.prepare(monoSpec, static_cast<std::uint32_t>(yinInput.size()), 60.0f, 1000.0f, 0.15f) ||
            !addCase(cases, "YinPitchDetector_2048EveryCallback", "one complete 2048-sample YIN window analysis on every 64-frame callback; reused window, not a streaming LIVE_MONO tracker", "analysis_window", 2048, false, 2048,
            [&yinWorstCase, &worstCaseEstimate, &yinInput](Stage, std::uint64_t, std::uint64_t, std::uint64_t) {
                if (!yinWorstCase.analyze(yinInput.data(), static_cast<std::uint32_t>(yinInput.size()), worstCaseEstimate)) return false;
                gOutputLeft[0] = worstCaseEstimate.voiced ? worstCaseEstimate.frequencyHz : 0.0f;
                gOutputRight[0] = worstCaseEstimate.confidence;
                return true;
            }, [&worstCaseEstimate] { return std::pair<std::uint64_t, std::uint64_t>{worstCaseEstimate.voiced ? 1U : 0U, 0U}; })) return 61;

        StreamingTdPsolaPitchShifter streamingPsola;
        if (!streamingPsola.prepare(monoSpec, 400U) || !streamingPsola.setPitch(220.0f, 1.25f, true) ||
            !addCase(cases, "StreamingTdPsolaPitchShifter", "mono 64-frame streaming PSOLA with fixed 220-Hz source period", "fixed_lookahead", streamingPsola.latencySamples(), true, 64,
            [&streamingPsola](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 256U) == 0U && !streamingPsola.setPitch(220.0f, (callback & 256U) ? 1.25f : 0.9f, true)) return false;
                if (!streamingPsola.processBlock(gInputLeft.data(), gOutputLeft.data(), kHostFrames)) return false;
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 47;

        PhaseVocoder phaseVocoder;
        if (!phaseVocoder.prepare(monoSpec, 1024U, 64U, 64U)) return 48;
        std::array<std::complex<float>, 1024> spectrumOutput{};
        if (!addCase(cases, "PhaseVocoder_1024frame", "one 1024-bin complex STFT frame per 64-frame host callback (upper-bound stress, not a cadence-qualified streaming graph)", "caller_STFT_overlap_add", -1, true, 1024,
            [&phaseVocoder, &spectrum, &spectrumOutput](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if (!phaseVocoder.processSpectrumFrame(spectrum.data(), spectrumOutput.data(), (callback & 128U) ? 1.1f : 1.0f)) return false;
                for (std::uint32_t i = 0; i < kHostFrames; ++i) gOutputLeft[i] = spectrumOutput[i].real();
                gOutputRight = gOutputLeft;
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 49;

        MultibandVocoder vocoder;
        if (!vocoder.prepare(stereoSpec, 16U, 80.0f, 10000.0f, 1.25f) ||
            !vocoder.setEnvelopeTimes(10.0f, 120.0f) || !vocoder.setOutputGain(1.0f) ||
            !addCase(cases, "MultibandVocoder", "linked-stereo 16-band vocoder with independent carrier and modulator", "fixed", 0, true, 64,
            [&vocoder](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 256U) == 0U && !vocoder.setEnvelopeTimes((callback & 256U) ? 10.0f : 25.0f, 120.0f)) return false;
                return vocoder.processBlock(gInputLeft.data(), gInputRight.data(), gInputRight.data(), gInputLeft.data(), gOutputLeft.data(), gOutputRight.data(), kHostFrames);
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 50;

        SignalsmithStretchAdapter signalsmith(0x5051U);
        SignalsmithStretchSettings stretchSettings{};
        stretchSettings.mode = PitchQualityMode::LiveMono;
        stretchSettings.channels = 1U;
        stretchSettings.blockSamples = 64U;
        stretchSettings.intervalSamples = 16U;
        stretchSettings.splitComputation = true;
        stretchSettings.seed = 0x5051U;
        const auto stretchBytes = SignalsmithStretchAdapter::requiredPrepareBytes(monoSpec, stretchSettings);
        if (!signalsmith.prepare(monoSpec, stretchSettings, stretchBytes) || !signalsmith.setTransposeFactor(1.25f, 0.0f)) return 51;
        const float* stretchInput[1]{gInputLeft.data()};
        float* stretchOutput[1]{gOutputLeft.data()};
        if (!addCase(cases, "SignalsmithStretchAdapter_LIVE_MONO", "pinned Signalsmith v1.4.0, 64-sample block/16-sample interval, split computation; live mono pitch factor 1.25", "upstream_reported_input_output", -1, true, 64,
            [&signalsmith, &stretchInput, &stretchOutput](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback % 256U) == 0U && !signalsmith.setTransposeFactor((callback & 256U) ? 1.25f : 1.1f, 0.0f)) return false;
                stretchInput[0] = gInputLeft.data();
                stretchOutput[0] = gOutputLeft.data();
                const bool ok = signalsmith.process(stretchInput, kHostFrames, stretchOutput, kHostFrames);
                gOutputRight = gOutputLeft;
                return ok;
            }, [&signalsmith] { return std::pair<std::uint64_t, std::uint64_t>{0U, static_cast<std::uint64_t>(std::max(0, signalsmith.inputLatencySamples()) + std::max(0, signalsmith.outputLatencySamples()))}; })) return 52;

        for (const std::uint16_t ordinal : {1U,2U,3U,4U,25U,26U,36U,47U}) {
            auto processor = createFxProcessor(ordinal);
            const ProcessSpec fxSpec{static_cast<float>(kSampleRate), kHostFrames, 2U};
            if (!processor || !processor->prepare(fxSpec)) return 53;
            std::size_t parameterCount = 0;
            const auto* parameterDescriptors = fxParameterDescriptors(ordinal, parameterCount);
            for (std::size_t i = 0; i < parameterCount; ++i) {
                if (parameterDescriptors[i].id == FxParameterId::Mix) {
                    if (!processor->setParameter(FxParameterId::Mix, 0.62f)) return 54;
                    break;
                }
            }
            const auto* descriptor = findFxByOrdinal(ordinal);
            std::string id = "FX_";
            id += descriptor ? descriptor->id.data() : "unknown";
            std::uint64_t fxEventApplied = 0;
            const auto eventId = static_cast<FxParameterId>(FxParameterId::Mix);
            FxParameterEvent event{0U, eventId, 0.62f};
            const char* latencyModel = processor->latencyModel() == FxLatencyModel::VariableDelay ? "variable_delay" :
                                       processor->latencyModel() == FxLatencyModel::FrequencyDependentGroupDelay ? "frequency_dependent_group_delay" : "fixed";
            const auto latency = processor->latencyIsVariable() ? -1 : processor->fixedLatencySamples();
            if (!addCase(cases, id.c_str(), "stereo registered adapter processBlockWithEvents; wet mix event at callback cadence 128", latencyModel, latency, true, 64,
                [p=processor.get(), &event, &fxEventApplied](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                    if ((callback % 128U) == 0U) { event.value = (callback & 128U) ? 0.62f : 0.48f; ++fxEventApplied; }
                    const float* input[2]{gInputLeft.data(),gInputRight.data()};
                    float* output[2]{gOutputLeft.data(),gOutputRight.data()};
                    const FxParameterEvent* events = ((callback % 128U) == 0U) ? &event : nullptr;
                    const std::uint32_t count = events ? 1U : 0U;
                    return p->processBlockWithEvents(input,output,2U,kHostFrames,events,count);
                }, [&fxEventApplied] { return std::pair<std::uint64_t,std::uint64_t>{0U,fxEventApplied}; })) return 55;
        }

        std::array<float, 16> hadamard{};
        if (!addCase(cases, "NormalizedHadamard_16", "four in-place normalized 16-channel transforms per 64-frame callback", "fixed", 0, true, 64,
            [&hadamard](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                for (std::uint32_t n = 0; n < 4U; ++n) {
                    for (std::uint32_t i = 0; i < hadamard.size(); ++i) hadamard[i] = static_cast<float>(std::sin((callback * 4U + n + i) * 0.1));
                    if (!normalizedHadamard(hadamard.data(), hadamard.size())) return false;
                    gOutputLeft[n] = hadamard[0];
                    gOutputRight[n] = hadamard[1];
                }
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 56;

        if (!addCase(cases, "Radix2FFT_64", "one 64-point in-place complex FFT per 64-frame callback", "fixed", 0, true, 64,
            [&spectrum](Stage, std::uint64_t, std::uint64_t callback, std::uint64_t) {
                if ((callback & 31U) == 0U) {
                    for (std::uint32_t i = 0; i < 64U; ++i) spectrum[i] = {gInputLeft[i], gInputRight[i]};
                }
                if (!fft::transform(spectrum.data(), 64U, fft::Direction::Forward)) return false;
                for (std::uint32_t i = 0; i < kHostFrames; ++i) { gOutputLeft[i] = spectrum[i].real(); gOutputRight[i] = spectrum[i].imag(); }
                return true;
            }, [] { return std::pair<std::uint64_t, std::uint64_t>{0U, 0U}; })) return 57;

        for (const auto& item : cases) {
            if (!item.processSucceeded || item.processNewCalls != 0U ||
                (item.outputRequired && item.nonzeroOutputSamples == 0U)) {
                std::fprintf(stderr, "case failed validation: %s new_calls=%llu finite=%llu nonzero=%llu\n",
                    item.id.c_str(), static_cast<unsigned long long>(item.processNewCalls),
                    static_cast<unsigned long long>(item.finiteOutputSamples), static_cast<unsigned long long>(item.nonzeroOutputSamples));
                return 90;
            }
        }
        const char* output = std::getenv("WEBRC_DSP_SUSTAINED_JSON");
        if (!writeReport(cases, output)) return 91;
        std::printf("cases=%zu host_frames=%u sample_rate=%u calls_per_case=%u+%u+%u+%u\n",
                    cases.size(), kHostFrames, kSampleRate, kStartupCalls, kWarmupCalls, kSteadyCalls, kFlushCalls);
        std::printf("scope=software-only 64-frame processor measurements; no device/XRUN/full-graph/30-minute-soak qualification\n");
        if (output) std::printf("json=%s\n", output);
        return 0;
    } catch (const std::exception& exception) {
        std::fprintf(stderr, "sustained benchmark setup/report failure: %s\n", exception.what());
        return 92;
    }
}
