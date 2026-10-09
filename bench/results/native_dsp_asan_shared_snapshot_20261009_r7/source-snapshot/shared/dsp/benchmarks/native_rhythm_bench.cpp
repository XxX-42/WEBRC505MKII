#include "webrc/dsp/cleanroom_rhythm_data.hpp"
#include "webrc/dsp/rhythm.hpp"

#include <algorithm>
#include <array>
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
    output << "  \"kitAudioFeatures\": [\n";
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

struct TimingSample {
    std::uint64_t frame = 0;
    std::uint64_t durationNs = 0;
    std::uint64_t eventsTriggered = 0;
    std::uint64_t completedBars = 0;
    std::uint32_t frames = 128;
    bool startup = false;
    bool barBoundary = false;
    bool eventCollision = false;
    bool withinP99Target = false;
    bool withinP999Target = false;
    bool hardDeadlineMiss = false;
};

std::uint64_t quantile(std::vector<std::uint64_t> values, double p) {
    if (values.empty()) return 0;
    std::sort(values.begin(), values.end());
    const auto rank = static_cast<std::size_t>(std::ceil(p * values.size()));
    return values[std::min(values.size() - 1U, rank == 0 ? 0U : rank - 1U)];
}

bool runTimingScenario(std::ostream& output) {
    constexpr std::uint32_t kSampleRate = 48000;
    constexpr std::uint32_t kBlock = 128;
    constexpr std::uint32_t kCallbackCount = 10000;
    constexpr double kTempo = 400.0;
    constexpr std::uint32_t kEventCount = RhythmRenderer::kMaxEventsPerSection;
    std::array<RhythmEvent, kEventCount> denseEvents{};
    for (std::uint32_t index = 0; index < denseEvents.size(); ++index) {
        const auto instrument = static_cast<RhythmInstrument>(index % static_cast<std::uint32_t>(RhythmInstrument::Count));
        denseEvents[index] = {
            (index / static_cast<std::uint32_t>(RhythmInstrument::Count)) * 240U,
            instrument, static_cast<std::uint8_t>(72U + index % 48U), false,
            instrument == RhythmInstrument::BrushSweep ? 480U : 0U,
        };
    }
    RhythmPatternView pattern{};
    pattern.numerator = 4;
    pattern.denominator = 4;
    for (auto& variation : pattern.variations) variation = {denseEvents.data(), kEventCount};
    pattern.intro = pattern.fill = pattern.ending = {denseEvents.data(), kEventCount};
    RhythmRenderer renderer;
    if (!renderer.prepare({static_cast<float>(kSampleRate), kBlock, 2}, kTempo) ||
        !renderer.setPattern(&pattern) || !renderer.startAtFrame(0, false)) return false;

    std::array<float, kBlock> left{};
    std::array<float, kBlock> right{};
    std::vector<TimingSample> samples;
    samples.reserve(kCallbackCount);
    std::vector<std::uint64_t> durations;
    durations.reserve(kCallbackCount);
    std::uint64_t blockStart = 0;
    constexpr double budgetNs = static_cast<double>(kBlock) * 1.0e9 / kSampleRate;
    constexpr double p99TargetNs = budgetNs * 0.60;
    constexpr double p999TargetNs = budgetNs * 0.80;
    std::uint64_t previousEvents = 0;
    std::uint64_t previousBars = 0;
    std::uint64_t p99TargetExceedances = 0;
    std::uint64_t p999TargetExceedances = 0;
    std::uint64_t deadlineMisses = 0;
    for (std::uint32_t callback = 0; callback < kCallbackCount; ++callback) {
        const auto start = Clock::now();
        const bool ok = renderer.processBlock(blockStart, left.data(), right.data(), kBlock);
        const auto stop = Clock::now();
        if (!ok) return false;
        const auto durationNs = static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(stop - start).count());
        const auto currentEvents = renderer.triggeredEvents();
        const auto currentBars = renderer.completedBars();
        const auto eventDelta = currentEvents - previousEvents;
        const bool overP99 = static_cast<double>(durationNs) > p99TargetNs;
        const bool overP999 = static_cast<double>(durationNs) > p999TargetNs;
        const bool deadlineMiss = static_cast<double>(durationNs) > budgetNs;
        if (overP99) ++p99TargetExceedances;
        if (overP999) ++p999TargetExceedances;
        if (deadlineMiss) ++deadlineMisses;
        samples.push_back({blockStart, durationNs, currentEvents, currentBars, kBlock,
                           callback == 0, currentBars != previousBars, eventDelta > 1,
                           !overP99, !overP999, deadlineMiss});
        durations.push_back(durationNs);
        previousEvents = currentEvents;
        previousBars = currentBars;
        blockStart += kBlock;
    }
    const auto p99 = quantile(durations, 0.99);
    const auto p999 = quantile(durations, 0.999);
    const auto maximum = *std::max_element(durations.begin(), durations.end());
    output << "  \"timingScenario\": {\n"
           << "    \"scenario\": \"fixed_192_event_dense_bar_at_400_bpm\",\n"
           << "    \"sampleRate\": " << kSampleRate << ", \"blockFrames\": " << kBlock
           << ", \"callbacks\": " << kCallbackCount << ", \"tempoBpmQ16_16\": "
           << static_cast<std::uint32_t>(std::llround(kTempo * 65536.0)) << ",\n"
           << "    \"eventCountPerSection\": " << kEventCount
           << ", \"deadlineBudgetNs\": " << static_cast<std::uint64_t>(budgetNs)
           << ", \"p99TargetNs\": " << static_cast<std::uint64_t>(p99TargetNs)
           << ", \"p999TargetNs\": " << static_cast<std::uint64_t>(p999TargetNs) << ",\n"
           << "    \"p99Ns\": " << p99 << ", \"p999Ns\": " << p999
           << ", \"maxNs\": " << maximum << ", \"p99TargetExceedances\": "
           << p99TargetExceedances << ", \"p999TargetExceedances\": " << p999TargetExceedances
           << ", \"deadlineMisses\": " << deadlineMisses << ",\n"
           << "    \"samplesChronological\": [\n";
    for (std::size_t index = 0; index < samples.size(); ++index) {
        const auto& sample = samples[index];
        output << "      {\"frame\": " << sample.frame << ", \"frames\": " << sample.frames
               << ", \"durationNs\": " << sample.durationNs
               << ", \"eventsTriggered\": " << sample.eventsTriggered
               << ", \"completedBars\": " << sample.completedBars
               << ", \"startup\": " << (sample.startup ? "true" : "false")
               << ", \"barBoundary\": " << (sample.barBoundary ? "true" : "false")
               << ", \"eventCollision\": " << (sample.eventCollision ? "true" : "false")
               << ", \"withinP99Target\": " << (sample.withinP99Target ? "true" : "false")
               << ", \"withinP999Target\": " << (sample.withinP999Target ? "true" : "false")
               << ", \"hardDeadlineMiss\": " << (sample.hardDeadlineMiss ? "true" : "false") << "}"
               << (index + 1 == samples.size() ? "\n" : ",\n");
    }
    output << "    ]\n  }";
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
    *output << "{\n  \"schemaVersion\": \"webrc-native-rhythm-bench-v1\",\n"
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
    if (!runTimingScenario(*output)) return 4;
    *output << ",\n";
    if (!runBrushOverlapMetrics(*output)) return 6;
    *output << "\n}\n";
    if (!*output) return 5;
    if (file.is_open()) file.close();
    return 0;
}
