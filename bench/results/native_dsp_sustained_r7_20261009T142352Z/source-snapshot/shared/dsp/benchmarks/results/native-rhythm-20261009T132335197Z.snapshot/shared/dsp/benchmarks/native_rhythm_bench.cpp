#include "webrc/dsp/cleanroom_rhythm_data.hpp"
#include "webrc/dsp/rhythm.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#elif defined(__unix__) || defined(__APPLE__)
#include <time.h>
#endif

namespace {

using namespace webrc::dsp;
using Clock = std::chrono::steady_clock;

struct Features {
    double attackEnergy = 0.0;
    double bodyEnergy = 0.0;
    double tailEnergy = 0.0;
    double lowBandEnergy = 0.0;
    double highBandEnergy = 0.0;
    double stereoDifferenceEnergy = 0.0;
    double totalRms = 0.0;
    double peak = 0.0;
    std::uint64_t zeroCrossings = 0;
};

Features measure(const std::vector<float>& left, const std::vector<float>& right) {
    Features result{};
    double totalEnergy = 0.0;
    double lowState = 0.0;
    double highState = 0.0;
    const double lowCoefficient = std::exp(-2.0 * 3.14159265358979323846 * 140.0 / 48000.0);
    const double highCoefficient = std::exp(-2.0 * 3.14159265358979323846 * 4200.0 / 48000.0);
    for (std::size_t index = 0; index < left.size(); ++index) {
        const double sample = left[index];
        const double low = lowCoefficient * lowState + (1.0 - lowCoefficient) * sample;
        const double highStateNow = highCoefficient * highState + (1.0 - highCoefficient) * sample;
        lowState = low;
        highState = highStateNow;
        const double high = sample - highStateNow;
        const double square = sample * sample;
        totalEnergy += square;
        if (index < 256) result.attackEnergy += square;
        else if (index < 2048) result.bodyEnergy += square;
        else result.tailEnergy += square;
        result.lowBandEnergy += low * low;
        result.highBandEnergy += high * high;
        const double difference = static_cast<double>(left[index]) - right[index];
        result.stereoDifferenceEnergy += difference * difference;
        result.peak = std::max(result.peak, std::abs(sample));
        if (index > 0 && ((left[index] < 0.0f) != (left[index - 1] < 0.0f))) {
            ++result.zeroCrossings;
        }
    }
    result.totalRms = left.empty() ? 0.0 : std::sqrt(totalEnergy / left.size());
    return result;
}

RhythmPatternView oneHitPattern(const RhythmEvent& event) {
    RhythmPatternView pattern{};
    pattern.numerator = 4;
    pattern.denominator = 4;
    for (auto& variation : pattern.variations) variation = {&event, 1};
    pattern.intro = {&event, 1};
    pattern.fill = {&event, 1};
    pattern.ending = {&event, 1};
    return pattern;
}

bool renderKitVoice(std::uint32_t kitIndex, RhythmInstrument instrument,
                    std::uint32_t frames, Features& features) {
    const RhythmEvent event{0, instrument, 100, false,
                            instrument == RhythmInstrument::BrushSweep ? 480U : 0U};
    const auto pattern = oneHitPattern(event);
    RhythmRenderer renderer;
    constexpr std::uint32_t blockSize = 256;
    if (!renderer.prepare({48000.0f, blockSize, 2}, 120.0) ||
        !renderer.setPattern(&pattern) || !renderer.setKit(kitIndex) ||
        !renderer.startAtFrame(0, false)) return false;
    std::vector<float> left(frames);
    std::vector<float> right(frames);
    for (std::uint32_t offset = 0; offset < frames;) {
        const auto count = std::min(blockSize, frames - offset);
        if (!renderer.processBlock(offset, left.data() + offset, right.data() + offset, count)) return false;
        offset += count;
    }
    if (renderer.triggeredEvents() != 1) return false;
    features = measure(left, right);
    return std::all_of(left.begin(), left.end(), [](float value) { return std::isfinite(value); }) &&
           std::all_of(right.begin(), right.end(), [](float value) { return std::isfinite(value); });
}

std::array<double, 9> featureValues(const Features& features) {
    return {{features.attackEnergy, features.bodyEnergy, features.tailEnergy,
             features.lowBandEnergy, features.highBandEnergy,
             features.stereoDifferenceEnergy, features.totalRms, features.peak,
             static_cast<double>(features.zeroCrossings)}};
}

double normalizedFeatureDistance(const Features& a, const Features& b,
                                 const std::array<double, 9>& scales) {
    const auto av = featureValues(a);
    const auto bv = featureValues(b);
    double squareDistance = 0.0;
    for (std::size_t index = 0; index < av.size(); ++index) {
        const double scale = scales[index] > 0.0 ? scales[index] : 1.0;
        const double delta = (av[index] - bv[index]) / scale;
        squareDistance += delta * delta;
    }
    return std::sqrt(squareDistance / static_cast<double>(av.size()));
}

const char* instrumentName(RhythmInstrument instrument) {
    switch (instrument) {
    case RhythmInstrument::Kick: return "kick";
    case RhythmInstrument::Snare: return "snare";
    case RhythmInstrument::ClosedHat: return "closed_hat";
    case RhythmInstrument::TomLow: return "tom_low_modal";
    case RhythmInstrument::BrushSweep: return "brush_sweep";
    default: return "unknown";
    }
}

bool runVoiceMetrics(std::ostream& output) {
    constexpr std::array<RhythmInstrument, 5> instruments{{
        RhythmInstrument::Kick, RhythmInstrument::Snare, RhythmInstrument::ClosedHat,
        RhythmInstrument::TomLow, RhythmInstrument::BrushSweep,
    }};
    output << "  \"kitSingleEventFeatures\": [\n";
    bool firstInstrument = true;
    for (const auto instrument : instruments) {
        const std::uint32_t frames = instrument == RhythmInstrument::BrushSweep ? 18000U : 8192U;
        std::array<Features, 16> featureSets{};
        for (std::uint32_t kit = 0; kit < cleanRoomKitCount(); ++kit) {
            if (!renderKitVoice(kit, instrument, frames, featureSets[kit])) return false;
        }
        std::array<double, 9> scales{};
        for (const auto& features : featureSets) {
            const auto values = featureValues(features);
            for (std::size_t index = 0; index < scales.size(); ++index) {
                scales[index] = std::max(scales[index], values[index]);
            }
        }
        double minimumDistance = std::numeric_limits<double>::infinity();
        for (std::size_t first = 0; first < featureSets.size(); ++first) {
            for (std::size_t second = first + 1; second < featureSets.size(); ++second) {
                minimumDistance = std::min(minimumDistance,
                    normalizedFeatureDistance(featureSets[first], featureSets[second], scales));
            }
        }
        if (!std::isfinite(minimumDistance) || minimumDistance <= 0.0) return false;
        if (!firstInstrument) output << ",\n";
        firstInstrument = false;
        output << "    {\"instrument\": \"" << instrumentName(instrument)
               << "\", \"frames\": " << frames
               << ", \"minNormalizedFeatureDistance\": " << minimumDistance
               << ", \"interpretation\": \"numeric spectral/envelope proxies only; no perceptual or listening evaluation\",\n"
               << "     \"kits\": [\n";
        for (std::uint32_t kit = 0; kit < cleanRoomKitCount(); ++kit) {
            const auto& features = featureSets[kit];
            const auto* profile = cleanRoomKitProfile(kit);
            output << "      {\"kitIndex\": " << kit << ", \"kitName\": \"" << profile->name
                   << "\", \"attackEnergy\": " << features.attackEnergy
                   << ", \"bodyEnergy\": " << features.bodyEnergy
                   << ", \"tailEnergy\": " << features.tailEnergy
                   << ", \"lowBandEnergy\": " << features.lowBandEnergy
                   << ", \"highBandEnergy\": " << features.highBandEnergy
                   << ", \"stereoDifferenceEnergy\": " << features.stereoDifferenceEnergy
                   << ", \"totalRms\": " << features.totalRms
                   << ", \"peak\": " << features.peak
                   << ", \"zeroCrossings\": " << features.zeroCrossings << "}"
                   << (kit + 1U == cleanRoomKitCount() ? "\n" : ",\n");
        }
        output << "     ]}";
    }
    output << "\n  ]";
    return static_cast<bool>(output);
}

bool runKitPolyphonyStress(std::ostream& output) {
    constexpr std::uint32_t kFrames = 192000; // two full 4/4 bars at 120 BPM
    constexpr std::uint32_t kBlock = 256;
    constexpr std::uint32_t kEventsPerBar = 52;
    std::array<RhythmEvent, kEventsPerBar> events{};
    for (std::uint32_t index = 0; index < events.size(); ++index) {
        const auto instrument = static_cast<RhythmInstrument>(index %
            static_cast<std::uint32_t>(RhythmInstrument::Count));
        events[index] = { (index / static_cast<std::uint32_t>(RhythmInstrument::Count)) * 960U,
                          instrument, static_cast<std::uint8_t>(88U + index % 32U), false,
                          instrument == RhythmInstrument::BrushSweep ? 960U : 0U };
    }
    RhythmPatternView pattern{};
    pattern.numerator = 4;
    pattern.denominator = 4;
    for (auto& variation : pattern.variations) variation = {events.data(), kEventsPerBar};
    pattern.intro = pattern.fill = pattern.ending = {events.data(), kEventsPerBar};
    output << "  \"kitSustainedPolyphony\": {\"sampleRate\": 48000, \"tempoBpm\": 120, "
           << "\"bars\": 2, \"eventsPerBar\": " << kEventsPerBar
           << ", \"eventFixture\": \"four downbeat clusters with all 13 instrument kinds; fixed schedule and velocity across kits\", "
           << "\"interpretation\": \"voice-load and PCM proxies; no listening evaluation\", \"kits\": [\n";
    for (std::uint32_t kit = 0; kit < cleanRoomKitCount(); ++kit) {
        RhythmRenderer renderer;
        if (!renderer.prepare({48000.0f, kBlock, 2}, 120.0) || !renderer.setPattern(&pattern) ||
            !renderer.setKit(kit) || !renderer.startAtFrame(0, false)) return false;
        std::vector<float> left(kFrames);
        std::vector<float> right(kFrames);
        std::uint32_t maximumVoices = 0;
        std::uint32_t maximumBrushes = 0;
        std::uint32_t maximumRetiringBrushes = 0;
        std::uint32_t maximumEventsPerBlock = 0;
        std::uint64_t previousEvents = 0;
        bool finite = true;
        for (std::uint32_t offset = 0; offset < kFrames; offset += kBlock) {
            if (!renderer.processBlock(offset, left.data() + offset, right.data() + offset, kBlock)) return false;
            maximumVoices = std::max(maximumVoices, renderer.activeVoices());
            maximumBrushes = std::max(maximumBrushes, renderer.activeBrushSweepVoices());
            maximumRetiringBrushes = std::max(maximumRetiringBrushes, renderer.retiringBrushSweepVoices());
            const auto currentEvents = renderer.triggeredEvents();
            maximumEventsPerBlock = std::max(maximumEventsPerBlock,
                static_cast<std::uint32_t>(currentEvents - previousEvents));
            previousEvents = currentEvents;
        }
        double energy = 0.0;
        double peak = 0.0;
        for (std::size_t index = 0; index < left.size(); ++index) {
            if (!std::isfinite(left[index]) || !std::isfinite(right[index])) {
                finite = false;
                break;
            }
            energy += static_cast<double>(left[index]) * left[index] +
                      static_cast<double>(right[index]) * right[index];
            peak = std::max({peak, std::abs(static_cast<double>(left[index])),
                             std::abs(static_cast<double>(right[index]))});
        }
        const double rms = std::sqrt(energy / (2.0 * kFrames));
        const auto* profile = cleanRoomKitProfile(kit);
        output << "    {\"kitIndex\": " << kit << ", \"kitName\": \"" << profile->name
               << "\", \"triggeredEvents\": " << renderer.triggeredEvents()
               << ", \"maxEventsPerCallback\": " << maximumEventsPerBlock
               << ", \"maxActiveDrumVoices\": " << maximumVoices
               << ", \"maxActiveBrushVoices\": " << maximumBrushes
               << ", \"maxRetiringBrushVoices\": " << maximumRetiringBrushes
               << ", \"rms\": " << rms << ", \"peak\": " << peak
               << ", \"finite\": " << (finite ? "true" : "false") << "}"
               << (kit + 1U == cleanRoomKitCount() ? "\n" : ",\n");
        if (!finite || renderer.triggeredEvents() != 2U * kEventsPerBar ||
            maximumVoices == 0U || rms <= 0.0 || peak >= 1.0) return false;
    }
    output << "  ]}";
    return static_cast<bool>(output);
}

struct TimingSample {
    std::uint64_t frame = 0;
    std::uint64_t durationNs = 0;
    std::uint64_t threadCpuNs = 0;
    std::uint64_t threadCpuCycles = 0;
    std::uint64_t eventsTriggered = 0;
    std::uint64_t completedBars = 0;
    std::uint32_t frames = 0;
    std::uint32_t activeVoices = 0;
    std::uint32_t activeBrushVoices = 0;
    std::uint32_t retiringBrushVoices = 0;
    std::uint32_t eventsInCallback = 0;
    bool startup = false;
    bool barBoundary = false;
    bool eventCollision = false;
    bool commandBoundary = false;
    bool threadCpuTimingValid = false;
    bool withinP99Target = false;
    bool withinP999Target = false;
    bool hardDeadlineMiss = false;
};

struct CycleCalibration {
    std::uint64_t threadCpuNs = 0;
    std::uint64_t cycles = 0;
    std::uint64_t wallNs = 0;
    double nsPerCycle = 0.0;
    bool valid = false;
};

bool threadCpuTimeNs(std::uint64_t& result) noexcept {
#if defined(_WIN32)
    FILETIME creation{};
    FILETIME exit{};
    FILETIME kernel{};
    FILETIME user{};
    if (!::GetThreadTimes(::GetCurrentThread(), &creation, &exit, &kernel, &user)) return false;
    ULARGE_INTEGER kernelTicks{};
    ULARGE_INTEGER userTicks{};
    kernelTicks.LowPart = kernel.dwLowDateTime;
    kernelTicks.HighPart = kernel.dwHighDateTime;
    userTicks.LowPart = user.dwLowDateTime;
    userTicks.HighPart = user.dwHighDateTime;
    constexpr std::uint64_t kHundredNs = 100U;
    const auto ticks = kernelTicks.QuadPart + userTicks.QuadPart;
    if (ticks > std::numeric_limits<std::uint64_t>::max() / kHundredNs) return false;
    result = ticks * kHundredNs;
    return true;
#elif defined(CLOCK_THREAD_CPUTIME_ID)
    timespec value{};
    if (::clock_gettime(CLOCK_THREAD_CPUTIME_ID, &value) != 0 || value.tv_sec < 0 || value.tv_nsec < 0)
        return false;
    result = static_cast<std::uint64_t>(value.tv_sec) * 1000000000ULL +
             static_cast<std::uint64_t>(value.tv_nsec);
    return true;
#else
    (void)result;
    return false;
#endif
}

bool threadCycleCount(std::uint64_t& result) noexcept {
#if defined(_WIN32)
    ULONG64 cycles = 0;
    if (!::QueryThreadCycleTime(::GetCurrentThread(), &cycles)) return false;
    result = static_cast<std::uint64_t>(cycles);
    return true;
#else
    (void)result;
    return false;
#endif
}

CycleCalibration calibrateCycleClock() noexcept {
    CycleCalibration result{};
#if defined(_WIN32)
    std::uint64_t cpuStart = 0;
    std::uint64_t cyclesStart = 0;
    if (!threadCpuTimeNs(cpuStart) || !threadCycleCount(cyclesStart)) return result;
    const auto wallStart = Clock::now();
    volatile std::uint64_t accumulator = 0x123456789abcdef0ULL;
    constexpr auto kCalibrationDuration = std::chrono::seconds(2);
    do {
        for (std::uint64_t index = 0; index < 65536U; ++index) {
            accumulator = (accumulator * 6364136223846793005ULL) + index + 1U;
        }
    } while (Clock::now() - wallStart < kCalibrationDuration);
    std::atomic_signal_fence(std::memory_order_seq_cst);
    const auto wallStop = Clock::now();
    std::uint64_t cpuStop = 0;
    std::uint64_t cyclesStop = 0;
    if (!threadCpuTimeNs(cpuStop) || !threadCycleCount(cyclesStop) ||
        cpuStop <= cpuStart || cyclesStop <= cyclesStart) return result;
    result.threadCpuNs = cpuStop - cpuStart;
    result.cycles = cyclesStop - cyclesStart;
    result.wallNs = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(wallStop - wallStart).count());
    result.nsPerCycle = static_cast<double>(result.threadCpuNs) / static_cast<double>(result.cycles);
    result.valid = std::isfinite(result.nsPerCycle) && result.nsPerCycle > 0.0;
    (void)accumulator;
#endif
    return result;
}

bool requestedCallbackCount(std::uint32_t& count) noexcept {
    constexpr std::uint32_t kDefaultCallbacks = 10000;
    const char* text = std::getenv("WEBRC_RHYTHM_CALLBACK_COUNT");
    if (!text || !*text) {
        count = kDefaultCallbacks;
        return true;
    }
    const char* end = text;
    while (*end) ++end;
    std::uint32_t parsed = 0;
    const auto conversion = std::from_chars(text, end, parsed);
    if (conversion.ec != std::errc{} || conversion.ptr != end || parsed < 1000U || parsed > 1000000U)
        return false;
    count = parsed;
    return true;
}

std::uint64_t quantile(std::vector<std::uint64_t> values, double p) {
    if (values.empty()) return 0;
    std::sort(values.begin(), values.end());
    const auto rank = static_cast<std::size_t>(std::ceil(p * values.size()));
    return values[std::min(values.size() - 1U, rank == 0 ? 0U : rank - 1U)];
}

bool makeMaximumCollisionPattern(std::array<RhythmEvent, RhythmRenderer::kMaxEventsPerSection>& events,
                                RhythmPatternView& pattern) noexcept {
    constexpr auto instruments = static_cast<std::uint32_t>(RhythmInstrument::Count);
    for (std::uint32_t index = 0; index < events.size(); ++index) {
        const auto instrument = static_cast<RhythmInstrument>(index % instruments);
        events[index] = {index / instruments, instrument,
                         static_cast<std::uint8_t>(72U + index % 48U), false,
                         instrument == RhythmInstrument::BrushSweep ? 480U : 0U};
    }
    pattern = {};
    pattern.numerator = 4;
    pattern.denominator = 4;
    for (auto& variation : pattern.variations)
        variation = {events.data(), static_cast<std::uint32_t>(events.size())};
    pattern.intro = pattern.fill = pattern.ending = {events.data(), static_cast<std::uint32_t>(events.size())};
    return true;
}

bool runTimingScenario(std::ostream& output, const char* scenario,
                       std::uint32_t blockFrames, std::uint32_t callbackCount,
                       const CycleCalibration& calibration) {
    constexpr std::uint32_t kSampleRate = 48000;
    constexpr double kSustainedTempo = 120.0;
    constexpr double kStressTempo = 400.0;
    const bool stressPattern = std::string(scenario) != "sustained_cleanroom";
    const bool transitionWorkload = std::string(scenario) == "fill_tempo_variation_boundaries";
    std::array<RhythmEvent, RhythmRenderer::kMaxEventsPerSection> denseEvents{};
    RhythmPatternView densePattern{};
    const RhythmPatternView* pattern = nullptr;
    std::uint32_t sourcePatternIndex = 0;
    double tempo = kSustainedTempo;
    if (stressPattern) {
        makeMaximumCollisionPattern(denseEvents, densePattern);
        pattern = &densePattern;
        tempo = kStressTempo;
    } else {
        constexpr std::uint32_t kCleanRoomPatternIndex = 37;
        pattern = cleanRoomRhythmPattern(kCleanRoomPatternIndex);
        sourcePatternIndex = kCleanRoomPatternIndex;
        if (!pattern) return false;
    }
    RhythmRenderer renderer;
    if (!renderer.prepare({static_cast<float>(kSampleRate), 256, 2}, tempo) ||
        !renderer.setPattern(pattern) || !renderer.setKit(0) || !renderer.startAtFrame(0, false)) return false;

    std::array<float, 256> left{};
    std::array<float, 256> right{};
    std::vector<TimingSample> samples;
    samples.reserve(callbackCount);
    std::vector<std::uint64_t> durations;
    durations.reserve(callbackCount);
    std::vector<std::uint64_t> cpuDurations;
    cpuDurations.reserve(callbackCount);
    std::uint64_t blockStart = 0;
    const double budgetNs = static_cast<double>(blockFrames) * 1.0e9 / kSampleRate;
    const double p99TargetNs = budgetNs * 0.60;
    const double p999TargetNs = budgetNs * 0.80;
    std::uint64_t previousEvents = 0;
    std::uint64_t previousBars = 0;
    std::uint64_t p99TargetExceedances = 0;
    std::uint64_t p999TargetExceedances = 0;
    std::uint64_t deadlineMisses = 0;
    std::uint64_t cpuTimingFailures = 0;
    std::uint64_t commandBoundaryCount = 0;
    std::uint64_t fillCommandCount = 0;
    std::uint32_t maxEventsInCallback = 0;
    std::uint32_t maxActiveVoices = 0;
    std::uint32_t maxActiveBrushVoices = 0;
    std::uint32_t maxRetiringBrushVoices = 0;
    std::uint64_t transitionTicksPerBar = static_cast<std::uint64_t>(pattern->numerator) *
                                          4U * kRhythmTicksPerQuarter / pattern->denominator;
    double transitionExactBoundary = 0.0;
    double bpmForNextInterval = tempo;
    std::uint64_t nextBoundaryFrame = std::numeric_limits<std::uint64_t>::max();
    bool transitionCommandQueued = false;
    if (transitionWorkload) {
        transitionExactBoundary = static_cast<double>(transitionTicksPerBar) * kSampleRate * 60.0 /
                                  (bpmForNextInterval * kRhythmTicksPerQuarter);
        nextBoundaryFrame = static_cast<std::uint64_t>(std::llround(transitionExactBoundary));
    }
    for (std::uint32_t callback = 0; callback < callbackCount; ++callback) {
        bool commandBoundary = false;
        if (transitionWorkload && !transitionCommandQueued &&
            blockStart + blockFrames >= nextBoundaryFrame) {
            const auto enteringBar = renderer.completedBars() + 1U;
            const auto variation = static_cast<std::uint8_t>(enteringBar % 4U);
            const double nextTempo = (enteringBar & 1U) ? 137.3 : 143.1;
            if (!renderer.queueVariation(variation) || !renderer.queueTempo(nextTempo)) return false;
            if ((enteringBar % 4U) == 0U) {
                if (!renderer.queueFill()) return false;
                ++fillCommandCount;
            }
            bpmForNextInterval = static_cast<double>(std::llround(nextTempo * 65536.0)) / 65536.0;
            transitionCommandQueued = true;
            commandBoundary = true;
            ++commandBoundaryCount;
        }
        const auto start = Clock::now();
        std::uint64_t cycleStart = 0;
        std::uint64_t threadCpuStart = 0;
#if defined(_WIN32)
        const bool cpuStartValid = threadCycleCount(cycleStart) && calibration.valid;
#elif defined(CLOCK_THREAD_CPUTIME_ID)
        const bool cpuStartValid = threadCpuTimeNs(threadCpuStart);
#else
        const bool cpuStartValid = false;
#endif
        const bool ok = renderer.processBlock(blockStart, left.data(), right.data(), blockFrames);
        std::uint64_t cycleStop = 0;
        std::uint64_t threadCpuStop = 0;
#if defined(_WIN32)
        const bool cpuStopValid = threadCycleCount(cycleStop);
#elif defined(CLOCK_THREAD_CPUTIME_ID)
        const bool cpuStopValid = threadCpuTimeNs(threadCpuStop);
#else
        const bool cpuStopValid = false;
#endif
        const auto stop = Clock::now();
        if (!ok) return false;
        const auto durationNs = static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start).count());
        std::uint64_t cpuCycles = 0;
        std::uint64_t threadCpuNs = 0;
#if defined(_WIN32)
        const bool cpuValid = cpuStartValid && cpuStopValid && cycleStop > cycleStart;
        if (cpuValid) {
            cpuCycles = cycleStop - cycleStart;
            const double estimate = static_cast<double>(cpuCycles) * calibration.nsPerCycle;
            if (std::isfinite(estimate) && estimate >= 0.0 &&
                estimate < static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
                threadCpuNs = static_cast<std::uint64_t>(std::llround(estimate));
            } else {
                cpuCycles = 0;
            }
        }
#elif defined(CLOCK_THREAD_CPUTIME_ID)
        const bool cpuValid = cpuStartValid && cpuStopValid && threadCpuStop >= threadCpuStart;
        if (cpuValid) threadCpuNs = threadCpuStop - threadCpuStart;
#else
        const bool cpuValid = false;
#endif
        const auto currentEvents = renderer.triggeredEvents();
        const auto currentBars = renderer.completedBars();
        const auto eventDelta = currentEvents - previousEvents;
        const bool overP99 = static_cast<double>(durationNs) > p99TargetNs;
        const bool overP999 = static_cast<double>(durationNs) > p999TargetNs;
        const bool deadlineMiss = static_cast<double>(durationNs) > budgetNs;
        if (overP99) ++p99TargetExceedances;
        if (overP999) ++p999TargetExceedances;
        if (deadlineMiss) ++deadlineMisses;
        if (!cpuValid || cpuCycles == 0 && threadCpuNs == 0) {
            ++cpuTimingFailures;
        } else {
            cpuDurations.push_back(threadCpuNs);
        }
        const auto activeVoices = renderer.activeVoices();
        const auto activeBrush = renderer.activeBrushSweepVoices();
        const auto retiringBrush = renderer.retiringBrushSweepVoices();
        maxEventsInCallback = std::max(maxEventsInCallback, static_cast<std::uint32_t>(eventDelta));
        maxActiveVoices = std::max(maxActiveVoices, activeVoices);
        maxActiveBrushVoices = std::max(maxActiveBrushVoices, activeBrush);
        maxRetiringBrushVoices = std::max(maxRetiringBrushVoices, retiringBrush);
        const bool barBoundary = currentBars != previousBars;
        samples.push_back({blockStart, durationNs, threadCpuNs, cpuCycles, currentEvents, currentBars,
                           blockFrames, activeVoices, activeBrush, retiringBrush,
                           static_cast<std::uint32_t>(eventDelta), callback == 0, barBoundary,
                           eventDelta > 1U, commandBoundary, cpuValid, !overP99, !overP999, deadlineMiss});
        durations.push_back(durationNs);
        previousEvents = currentEvents;
        if (barBoundary && transitionWorkload) {
            transitionExactBoundary += static_cast<double>(transitionTicksPerBar) * kSampleRate * 60.0 /
                                      (bpmForNextInterval * kRhythmTicksPerQuarter);
            nextBoundaryFrame = static_cast<std::uint64_t>(std::llround(transitionExactBoundary));
            transitionCommandQueued = false;
        }
        previousBars = currentBars;
        blockStart += blockFrames;
    }
    const auto p99 = quantile(durations, 0.99);
    const auto p999 = quantile(durations, 0.999);
    const auto maximum = *std::max_element(durations.begin(), durations.end());
    const auto cpuP99 = quantile(cpuDurations, 0.99);
    const auto cpuP999 = quantile(cpuDurations, 0.999);
    const auto cpuMaximum = cpuDurations.empty() ? 0 : *std::max_element(cpuDurations.begin(), cpuDurations.end());
    output << "    {\"scenario\": \"" << scenario << "\", \"patternSource\": \""
           << (stressPattern ? "synthetic_max_collision_192_event_section" : "clean_room_table")
           << "\", \"patternIndex\": " << (stressPattern ? -1 : static_cast<int>(sourcePatternIndex))
           << ", \"sampleRate\": " << kSampleRate << ", \"blockFrames\": " << blockFrames
           << ", \"callbacks\": " << callbackCount << ", \"tempoStartBpm\": " << tempo
           << ", \"deadlineBudgetNs\": " << static_cast<std::uint64_t>(budgetNs)
           << ", \"p99TargetNs\": " << static_cast<std::uint64_t>(p99TargetNs)
           << ", \"p999TargetNs\": " << static_cast<std::uint64_t>(p999TargetNs)
           << ", \"p99Ns\": " << p99 << ", \"p999Ns\": " << p999 << ", \"maxNs\": " << maximum
           << ", \"over60PercentBudget\": " << p99TargetExceedances
           << ", \"over80PercentBudget\": " << p999TargetExceedances
           << ", \"over100PercentBudget\": " << deadlineMisses
           << ", \"threadCpuP99Ns\": " << cpuP99 << ", \"threadCpuP999Ns\": " << cpuP999
           << ", \"threadCpuMaxNs\": " << cpuMaximum
           << ", \"threadCpuTimingFailures\": " << cpuTimingFailures
           << ", \"threadCpuValidSamples\": " << cpuDurations.size()
           << ", \"maxEventsTriggeredInOneCallback\": " << maxEventsInCallback
           << ", \"maxActiveDrumVoices\": " << maxActiveVoices
           << ", \"maxActiveBrushVoices\": " << maxActiveBrushVoices
           << ", \"maxRetiringBrushVoices\": " << maxRetiringBrushVoices
           << ", \"commandBoundaries\": " << commandBoundaryCount
           << ", \"fillCommands\": " << fillCommandCount
           << ", \"timingIncludesProbeOverhead\": true, \"samplesChronological\": [\n";
    for (std::size_t index = 0; index < samples.size(); ++index) {
        const auto& sample = samples[index];
        output << "      {\"frame\": " << sample.frame << ", \"frames\": " << sample.frames
               << ", \"durationNs\": " << sample.durationNs
               << ", \"threadCpuNs\": " << sample.threadCpuNs
               << ", \"threadCpuCycles\": " << sample.threadCpuCycles
               << ", \"threadCpuTimingValid\": " << (sample.threadCpuTimingValid ? "true" : "false")
               << ", \"eventsTriggered\": " << sample.eventsTriggered
               << ", \"eventsInCallback\": " << sample.eventsInCallback
               << ", \"completedBars\": " << sample.completedBars
               << ", \"activeVoices\": " << sample.activeVoices
               << ", \"activeBrushVoices\": " << sample.activeBrushVoices
               << ", \"retiringBrushVoices\": " << sample.retiringBrushVoices
               << ", \"startup\": " << (sample.startup ? "true" : "false")
               << ", \"barBoundary\": " << (sample.barBoundary ? "true" : "false")
               << ", \"eventCollision\": " << (sample.eventCollision ? "true" : "false")
               << ", \"commandBoundary\": " << (sample.commandBoundary ? "true" : "false")
               << ", \"withinP99Target\": " << (sample.withinP99Target ? "true" : "false")
               << ", \"withinP999Target\": " << (sample.withinP999Target ? "true" : "false")
               << ", \"hardDeadlineMiss\": " << (sample.hardDeadlineMiss ? "true" : "false") << "}"
               << (index + 1 == samples.size() ? "\n" : ",\n");
    }
    output << "    ]}";
    return static_cast<bool>(output);
}

bool runTimingScenarios(std::ostream& output, const CycleCalibration& calibration) {
    std::uint32_t primaryCallbacks = 0;
    if (!requestedCallbackCount(primaryCallbacks)) return false;
    const auto stressCallbacks = std::max<std::uint32_t>(1000U, primaryCallbacks / 5U);
    output << "  \"cycleCalibration\": {\"valid\": " << (calibration.valid ? "true" : "false")
           << ", \"method\": \""
#if defined(_WIN32)
           << "QueryThreadCycleTime delta calibrated against GetThreadTimes user+kernel over a busy interval"
#elif defined(CLOCK_THREAD_CPUTIME_ID)
           << "CLOCK_THREAD_CPUTIME_ID per callback; cycle calibration not used"
#else
           << "unavailable"
#endif
           << "\", \"threadCpuNs\": " << calibration.threadCpuNs
           << ", \"cycles\": " << calibration.cycles
           << ", \"wallNs\": " << calibration.wallNs
           << ", \"nsPerCycle\": " << calibration.nsPerCycle
           << ", \"cyclesPerThreadCpuSecond\": "
           << (calibration.threadCpuNs > 0 ? static_cast<double>(calibration.cycles) * 1.0e9 /
                                                static_cast<double>(calibration.threadCpuNs) : 0.0)
           << ", \"limitation\": \"The earlier per-callback GetThreadTimes probe was observed quantized at 15.625 ms and is not valid for callback CPU percentiles. QueryThreadCycleTime estimates are scaled by this interval; DVFS, turbo, thermal, and power-state changes can alter the ratio. Estimated CPU time does not remove or discount any wall-clock maximum.\"},\n"
           << "  \"timingScenarios\": [\n";
    struct ScenarioRun { const char* name; std::uint32_t block; std::uint32_t callbacks; };
    const std::array<ScenarioRun, 7> runs{{
        {"sustained_cleanroom", 64, primaryCallbacks},
        {"sustained_cleanroom", 128, stressCallbacks},
        {"sustained_cleanroom", 256, stressCallbacks},
        {"maximum_event_collisions", 64, stressCallbacks},
        {"maximum_event_collisions", 128, stressCallbacks},
        {"maximum_event_collisions", 256, stressCallbacks},
        {"fill_tempo_variation_boundaries", 64, stressCallbacks},
    }};
    for (std::size_t index = 0; index < runs.size(); ++index) {
        const auto& run = runs[index];
        if (!runTimingScenario(output, run.name, run.block, run.callbacks, calibration)) return false;
        output << (index + 1U == runs.size() ? "\n" : ",\n");
    }
    output << "  ]";
    return static_cast<bool>(output);
}

bool runBrushOverlapMetrics(std::ostream& output) {
    constexpr std::uint32_t kEventCount = 40;
    constexpr std::uint32_t kFrames = 512;
    std::array<RhythmEvent, kEventCount> events{};
    for (std::uint32_t index = 0; index < kEventCount; ++index) {
        events[index] = {index * 2U, RhythmInstrument::BrushSweep, 100, false, 240};
    }
    RhythmPatternView pattern{};
    pattern.numerator = 4;
    pattern.denominator = 4;
    for (auto& variation : pattern.variations) variation = {events.data(), kEventCount};
    pattern.intro = pattern.fill = pattern.ending = {events.data(), kEventCount};
    RhythmRenderer renderer;
    if (!renderer.prepare({8000.0f, 64, 2}, 400.0) ||
        !renderer.setPattern(&pattern) || !renderer.setKit(7) ||
        !renderer.startAtFrame(0, false)) return false;
    std::array<float, kFrames> left{};
    std::array<float, kFrames> right{};
    std::uint32_t maximumActive = 0;
    std::uint32_t maximumRetiring = 0;
    for (std::uint32_t offset = 0; offset < kFrames; offset += 64) {
        if (!renderer.processBlock(offset, left.data() + offset, right.data() + offset, 64)) return false;
        maximumActive = std::max(maximumActive, renderer.activeBrushSweepVoices());
        maximumRetiring = std::max(maximumRetiring, renderer.retiringBrushSweepVoices());
    }
    if (renderer.triggeredEvents() != kEventCount || maximumRetiring == 0) return false;
    double energy = 0.0;
    double peak = 0.0;
    double maxStep = 0.0;
    double maxEventBoundaryStep = 0.0;
    for (std::size_t index = 0; index < left.size(); ++index) {
        if (!std::isfinite(left[index]) || !std::isfinite(right[index])) return false;
        energy += static_cast<double>(left[index]) * left[index] +
                  static_cast<double>(right[index]) * right[index];
        peak = std::max({peak, std::abs(static_cast<double>(left[index])),
                         std::abs(static_cast<double>(right[index]))});
        if (index == 0) continue;
        const double step = std::max(std::abs(static_cast<double>(left[index] - left[index - 1U])),
                                     std::abs(static_cast<double>(right[index] - right[index - 1U])));
        maxStep = std::max(maxStep, step);
        for (std::uint32_t event = 1; event < kEventCount; ++event) {
            const auto expectedFrame = static_cast<std::size_t>(std::llround(event * 2.5));
            if (index + 1U >= expectedFrame && index <= expectedFrame + 1U) {
                maxEventBoundaryStep = std::max(maxEventBoundaryStep, step);
            }
        }
    }
    const double rms = std::sqrt(energy / (2.0 * kFrames));
    output << "  \"brushOverlap\": {\"sampleRate\": 8000, \"tempoBpm\": 400, \"eventCount\": "
           << kEventCount << ", \"durationTicks\": 240, \"frames\": " << kFrames
           << ", \"maxActiveVoices\": " << maximumActive
           << ", \"maxRetiringVoices\": " << maximumRetiring
           << ", \"rms\": " << rms << ", \"peak\": " << peak
           << ", \"maxAdjacentStep\": " << maxStep
           << ", \"maxEventBoundaryStep\": " << maxEventBoundaryStep
           << ", \"normalizedAdjacentStep\": " << maxStep / std::max(rms, 1.0e-15)
           << ", \"interpretation\": \"numeric transient proxy only; no perceptual or listening evaluation\"}";
    return static_cast<bool>(output) && rms > 0.0 && peak < 0.5 &&
           maxStep < 0.12 && maxEventBoundaryStep < 0.12;
}

} // namespace

int main() {
    const char* path = std::getenv("WEBRC_RHYTHM_BENCH_JSON");
    std::ofstream file;
    std::ostream* output = &std::cout;
    if (path && *path) {
        file.open(path, std::ios::out | std::ios::trunc);
        if (!file) {
            std::cerr << "cannot open rhythm benchmark output path\n";
            return 2;
        }
        output = &file;
    }
    *output << std::setprecision(17);
    *output << "{\n  \"schemaVersion\": \"webrc-native-rhythm-bench-v2\",\n"
            << "  \"qualification\": \"isolated shared RhythmRenderer native reference; not product RT Gate 1/7\",\n"
            << "  \"patternTableSha256\": \"" << cleanRoomRhythmPatternsSha256() << "\",\n"
            << "  \"kitProfileTableSha256\": \"" << cleanRoomKitProfilesSha256() << "\",\n"
            << "  \"fixture\": {\"sampleRate\": 48000, \"fixedEventFrame\": 0, \"velocity\": 100, "
               "\"seedPolicy\": \"fixed across kits: salt XOR absoluteFrame XOR instrument<<40 XOR triggerOrdinal\", "
               "\"bandFeatureMethod\": \"one-pole lowpass at 140 Hz and 4.2 kHz; energies over raw PCM\", "
               "\"envelopeWindowsFrames\": {\"attack\": {\"start\": 0, \"endExclusive\": 256}, "
               "\"body\": {\"start\": 256, \"endExclusive\": 2048}, "
               "\"tail\": {\"start\": 2048, \"endExclusive\": \"end\"}}, "
               "\"featureDistance\": \"RMS Euclidean distance over each of 9 feature dimensions normalized by the maximum across 16 kits\", "
               "\"featureInterpretation\": \"numeric spectral/envelope proxies only; no perceptual or listening evaluation\"},\n";
    if (!runVoiceMetrics(*output)) return 3;
    *output << ",\n";
    if (!runKitPolyphonyStress(*output)) return 4;
    *output << ",\n";
    const auto calibration = calibrateCycleClock();
    if (!runTimingScenarios(*output, calibration)) return 5;
    *output << ",\n";
    if (!runBrushOverlapMetrics(*output)) return 6;
    *output << "\n}\n";
    if (!*output) return 5;
    if (file.is_open()) file.close();
    return 0;
}
