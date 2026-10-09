#include "webrc/dsp/voice_fx.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <new>
#include <vector>

namespace {

std::atomic<bool> gTrackAllocations{false};
std::atomic<std::uint64_t> gAllocations{0U};
std::atomic<std::uint64_t> gFrees{0U};
std::atomic<int> gFailAllocationCountdown{-1};
std::uint32_t gFailures = 0U;

bool failAllocationNow() noexcept {
    int remaining = gFailAllocationCountdown.load(std::memory_order_relaxed);
    while (remaining >= 0) {
        const int next = remaining == 0 ? -1 : remaining - 1;
        if (gFailAllocationCountdown.compare_exchange_weak(
                remaining, next, std::memory_order_relaxed))
            return remaining == 0;
    }
    return false;
}

void checkResult(bool pass, int line) noexcept {
    if (!pass) {
        ++gFailures;
        std::fprintf(stderr, "voice-fx assertion failed at line %d\n", line);
    }
}

#define check(condition) checkResult((condition), __LINE__)

double maxDifference(const std::vector<webrc::dsp::StereoFrame>& left,
                     const std::vector<webrc::dsp::StereoFrame>& right) noexcept {
    if (left.size() != right.size()) return std::numeric_limits<double>::infinity();
    double maximum = 0.0;
    for (std::size_t i = 0U; i < left.size(); ++i) {
        maximum = std::max(maximum, std::fabs(static_cast<double>(left[i].left) - right[i].left));
        maximum = std::max(maximum, std::fabs(static_cast<double>(left[i].right) - right[i].right));
    }
    return maximum;
}

double channelRms(const std::vector<webrc::dsp::StereoFrame>& pcm,
                  std::size_t begin, std::size_t frames, bool right) noexcept {
    if (begin + frames > pcm.size() || frames == 0U) return 0.0;
    double sum = 0.0;
    for (std::size_t i = begin; i < begin + frames; ++i) {
        const double sample = right ? pcm[i].right : pcm[i].left;
        sum += sample * sample;
    }
    return std::sqrt(sum / static_cast<double>(frames));
}

double estimateFrequency(const std::vector<webrc::dsp::StereoFrame>& pcm,
                         std::size_t begin, std::size_t frames, bool right,
                         double sampleRate, double minimumHz, double maximumHz) noexcept {
    if (begin + frames > pcm.size() || frames < 256U) return 0.0;
    const auto minLag = static_cast<std::size_t>(std::floor(sampleRate / maximumHz));
    const auto maxLag = static_cast<std::size_t>(std::ceil(sampleRate / minimumHz));
    const std::size_t available = frames / 2U;
    const auto lastLag = std::min(maxLag, available - 1U);
    if (minLag < 1U || minLag >= lastLag) return 0.0;
    std::size_t bestLag = minLag;
    double bestCorrelation = -std::numeric_limits<double>::infinity();
    for (std::size_t lag = minLag; lag <= lastLag; ++lag) {
        double correlation = 0.0;
        double energyA = 0.0;
        double energyB = 0.0;
        for (std::size_t i = 0U; i < frames - lag; ++i) {
            const double a = right ? pcm[begin + i].right : pcm[begin + i].left;
            const double b = right ? pcm[begin + i + lag].right : pcm[begin + i + lag].left;
            correlation += a * b;
            energyA += a * a;
            energyB += b * b;
        }
        const double normalized = correlation /
            std::sqrt(std::max(1.0e-30, energyA * energyB));
        if (normalized > bestCorrelation) {
            bestCorrelation = normalized;
            bestLag = lag;
        }
    }
    double fractionalLag = static_cast<double>(bestLag);
    if (bestLag > minLag && bestLag < lastLag) {
        const auto corrAt = [&](std::size_t lag) noexcept {
            double correlation = 0.0;
            double energyA = 0.0;
            double energyB = 0.0;
            for (std::size_t i = 0U; i < frames - lag; ++i) {
                const double a = right ? pcm[begin + i].right : pcm[begin + i].left;
                const double b = right ? pcm[begin + i + lag].right : pcm[begin + i + lag].left;
                correlation += a * b;
                energyA += a * a;
                energyB += b * b;
            }
            return correlation / std::sqrt(std::max(1.0e-30, energyA * energyB));
        };
        const double lower = corrAt(bestLag - 1U);
        const double center = corrAt(bestLag);
        const double upper = corrAt(bestLag + 1U);
        const double denominator = lower - 2.0 * center + upper;
        if (std::fabs(denominator) > 1.0e-12)
            fractionalLag += std::clamp(0.5 * (lower - upper) / denominator, -0.5, 0.5);
    }
    return sampleRate / fractionalLag;
}

double toneAmplitude(const std::vector<webrc::dsp::StereoFrame>& pcm,
                     std::size_t begin, std::size_t frames, bool right,
                     double sampleRate, double frequencyHz) noexcept {
    if (begin + frames > pcm.size() || frames == 0U || !(frequencyHz > 0.0)) return 0.0;
    constexpr double tau = 6.283185307179586476925286766559;
    double sine = 0.0;
    double cosine = 0.0;
    for (std::size_t i = begin; i < begin + frames; ++i) {
        const double phase = tau * frequencyHz * static_cast<double>(i) / sampleRate;
        const double sample = right ? pcm[i].right : pcm[i].left;
        sine += sample * std::sin(phase);
        cosine += sample * std::cos(phase);
    }
    return std::sqrt(2.0 * (sine * sine + cosine * cosine) /
                     (static_cast<double>(frames) * static_cast<double>(frames)));
}

std::vector<webrc::dsp::StereoFrame> makeTone(std::size_t frames, double leftHz,
                                              double rightHz, float amplitude = 0.32f) {
    std::vector<webrc::dsp::StereoFrame> pcm(frames);
    constexpr double tau = 6.283185307179586476925286766559;
    for (std::size_t i = 0U; i < frames; ++i) {
        const double t = static_cast<double>(i) / 48000.0;
        pcm[i] = {static_cast<float>(amplitude * std::sin(tau * leftHz * t)),
                  static_cast<float>(amplitude * std::sin(tau * rightHz * t + 0.37))};
    }
    return pcm;
}

template <typename Processor, typename Event>
bool render(Processor& processor, std::vector<webrc::dsp::StereoFrame>& pcm,
            std::uint32_t quantum, const Event* firstEvents = nullptr,
            std::uint32_t firstEventCount = 0U) noexcept {
    std::size_t position = 0U;
    bool first = true;
    while (position < pcm.size()) {
        const auto frames = static_cast<std::uint32_t>(std::min<std::size_t>(
            quantum, pcm.size() - position));
        const auto* events = first ? firstEvents : nullptr;
        const auto count = first ? firstEventCount : 0U;
        if (!processor.processBlock(position, pcm.data() + position, frames, events, count))
            return false;
        first = false;
        position += frames;
    }
    return true;
}

void testPrepareBoundsAndRobotPitch() {
    using namespace webrc::dsp;
    ProcessSpec spec{48000.0f, 128U, 2U};
    RobotFxOptions options{};
    options.mode = RobotFxMode::PitchClass;
    options.noteClass = 0U;
    options.mix = 1.0f;
    auto robot = std::make_unique<RobotFxProcessor>();
    check(RobotFxProcessor::requiredPrepareBytes(spec, options) > sizeof(RobotFxProcessor));
    check(robot->prepare(spec, options));
    const auto preparedBytes = robot->preparedBytes();
    check(!robot->prepare({192000.0f, 8192U, 1U}, options));
    check(robot->prepared() && robot->preparedBytes() == preparedBytes);
    auto referenceRobot = std::make_unique<RobotFxProcessor>();
    check(referenceRobot->prepare(spec, options));
    gFailAllocationCountdown.store(0, std::memory_order_relaxed);
    const bool rejectedPathObjectAllocation = !robot->prepare(spec, options);
    gFailAllocationCountdown.store(-1, std::memory_order_relaxed);
    check(rejectedPathObjectAllocation);
    check(robot->prepared() && robot->preparedBytes() == preparedBytes);
    // Let the path and both staged object pairs allocate, then fail the first
    // dynamic detector scratch allocation. Exception-enabled builds must roll
    // back the candidate and keep the old renderer intact.
    gFailAllocationCountdown.store(3, std::memory_order_relaxed);
    const bool rejectedDynamicScratchAllocation = !robot->prepare(spec, options);
    gFailAllocationCountdown.store(-1, std::memory_order_relaxed);
    check(rejectedDynamicScratchAllocation);
    check(robot->prepared() && robot->preparedBytes() == preparedBytes);
    auto pcm = makeTone(48000U, 440.0, 330.0);
    auto referencePcm = pcm;
    const RobotFxEvent enable{0U, RobotFxControl::Active, 1.0f};
    check(render(*robot, pcm, spec.maxBlockFrames, &enable, 1U));
    check(render(*referenceRobot, referencePcm, spec.maxBlockFrames, &enable, 1U));
    check(maxDifference(pcm, referencePcm) == 0.0);
    const auto leftEstimate = robot->pitchEstimate(0U);
    const auto rightEstimate = robot->pitchEstimate(1U);
    check(leftEstimate.voiced && std::fabs(leftEstimate.frequencyHz - 440.0f) < 2.0f);
    check(rightEstimate.voiced && std::fabs(rightEstimate.frequencyHz - 330.0f) < 2.0f);
    const auto measuredLeft = estimateFrequency(pcm, 32000U, 12000U, false, 48000.0, 480.0, 570.0);
    const auto measuredRight = estimateFrequency(pcm, 32000U, 12000U, true, 48000.0, 220.0, 300.0);
    check(std::fabs(measuredLeft - 523.251f) < 5.0);
    check(std::fabs(measuredRight - 261.626f) < 5.0);
    const auto latency = robot->latency();
    check(latency.psolaLookaheadSamples > 0U && latency.analysisWindowFrames == 2048U &&
          latency.analysisHopFrames == 512U && latency.conservativePitchOnsetFrames >= 4000U);
    check(channelRms(pcm, 32000U, 12000U, false) > 0.05 &&
          channelRms(pcm, 32000U, 12000U, true) > 0.05);
    check(std::fabs(measuredLeft - measuredRight) > 200.0);
}

void testElectricControlsAndStereoPitch() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 128U, 2U};
    ElectricFxOptions options{};
    options.shiftSemitones = 12.0f;
    options.scaleRoot = -1;
    options.mix = 1.0f;
    options.metallicMix = 0.0f;
    options.bitCrushMix = 0.0f;
    options.stability = -10.0f;
    auto electric = std::make_unique<ElectricFxProcessor>();
    check(ElectricFxProcessor::requiredPrepareBytes(spec, options) > sizeof(ElectricFxProcessor));
    check(electric->prepare(spec, options));
    auto pcm = makeTone(48000U, 220.0, 330.0);
    const ElectricFxEvent enable{0U, ElectricFxControl::Active, 1.0f};
    check(render(*electric, pcm, spec.maxBlockFrames, &enable, 1U));
    const auto leftEstimate = electric->pitchEstimate(0U);
    const auto rightEstimate = electric->pitchEstimate(1U);
    check(leftEstimate.voiced && std::fabs(leftEstimate.frequencyHz - 220.0f) < 2.0f);
    check(rightEstimate.voiced && std::fabs(rightEstimate.frequencyHz - 330.0f) < 2.0f);
    const auto measuredLeft = estimateFrequency(pcm, 32000U, 12000U, false, 48000.0, 150.0, 1000.0);
    const auto measuredRight = estimateFrequency(pcm, 32000U, 12000U, true, 48000.0, 150.0, 1000.0);
    std::fprintf(stderr, "electric shift outputs %.4f / %.4f, yin %.4f / %.4f\n",
                 measuredLeft, measuredRight, leftEstimate.frequencyHz, rightEstimate.frequencyHz);
    std::fprintf(stderr, "electric output rms %.6f / %.6f\n",
        channelRms(pcm, 32000U, 12000U, false), channelRms(pcm, 32000U, 12000U, true));
    check(std::fabs(measuredLeft - 440.0) < 5.0 && std::fabs(measuredRight - 660.0) < 7.0);
    check(std::fabs(measuredLeft - measuredRight) > 150.0);

    ElectricFxOptions scaleC{};
    scaleC.scaleRoot = 0;
    scaleC.stability = -10.0f;
    scaleC.mix = 1.0f;
    scaleC.metallicMix = 0.0f;
    scaleC.bitCrushMix = 0.0f;
    ElectricFxOptions scaleA = scaleC;
    scaleA.scaleRoot = 9;
    auto cProcessor = std::make_unique<ElectricFxProcessor>();
    auto aProcessor = std::make_unique<ElectricFxProcessor>();
    check(cProcessor->prepare(spec, scaleC) && aProcessor->prepare(spec, scaleA));
    // 408 Hz lies close to G4 for C major and G#4 for A major, avoiding the
    // equal-distance G#/A tie that makes a nearest-note policy ambiguous.
    auto cTone = makeTone(48000U, 408.0, 408.0);
    auto aTone = cTone;
    check(render(*cProcessor, cTone, 128U, &enable, 1U));
    check(render(*aProcessor, aTone, 128U, &enable, 1U));
    const auto cAtG = toneAmplitude(cTone, 32000U, 12000U, false, 48000.0, 392.0);
    const auto cAtGSharp = toneAmplitude(cTone, 32000U, 12000U, false, 48000.0, 415.3);
    const auto aAtG = toneAmplitude(aTone, 32000U, 12000U, false, 48000.0, 392.0);
    const auto aAtGSharp = toneAmplitude(aTone, 32000U, 12000U, false, 48000.0, 415.3);
    std::fprintf(stderr, "electric scale targets C(G/G#)=%.4f/%.4f A(G/G#)=%.4f/%.4f, "
        "YIN %.4f/%.4f Hz\n", cAtG, cAtGSharp, aAtG, aAtGSharp,
        cProcessor->pitchEstimate(0U).frequencyHz, aProcessor->pitchEstimate(0U).frequencyHz);
    std::fprintf(stderr, "electric scale output rms %.6f / %.6f\n",
        channelRms(cTone, 32000U, 12000U, false), channelRms(aTone, 32000U, 12000U, false));
    check(cAtG > 0.15 && cAtG > cAtGSharp * 2.0);
    check(aAtGSharp > 0.15 && aAtGSharp > aAtG * 2.0);

    ElectricFxOptions fast{};
    fast.shiftSemitones = 0.0f;
    fast.stability = -10.0f;
    fast.mix = 1.0f;
    fast.metallicMix = 0.0f;
    fast.bitCrushMix = 0.45f;
    fast.speed = 0.0f;
    ElectricFxOptions slowHold = fast;
    slowHold.speed = 10.0f;
    auto fastProcessor = std::make_unique<ElectricFxProcessor>();
    auto slowProcessor = std::make_unique<ElectricFxProcessor>();
    check(fastProcessor->prepare(spec, fast) && slowProcessor->prepare(spec, slowHold));
    auto fastPcm = makeTone(48000U, 307.0, 311.0, 0.6f);
    auto slowPcm = fastPcm;
    check(render(*fastProcessor, fastPcm, 128U, &enable, 1U));
    check(render(*slowProcessor, slowPcm, 128U, &enable, 1U));
    double speedDifference = 0.0;
    for (std::size_t i = 16000U; i < 48000U; ++i)
        speedDifference += std::fabs(static_cast<double>(fastPcm[i].left) - slowPcm[i].left) +
                            std::fabs(static_cast<double>(fastPcm[i].right) - slowPcm[i].right);
    check(speedDifference / 64000.0 > 1.0e-3);
}

void testOscBotSequenceWaveformsAndStereo() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    OscBotFxOptions options{};
    options.waveform = OscBotWaveform::Saw;
    options.note = 36U;
    options.pattern = 0U;
    options.stepRateHz = 4.0f;
    options.mix = 1.0f;
    options.balance = 0.5f;
    OscBotFxProcessor fixed;
    OscBotFxProcessor partitioned;
    check(OscBotFxProcessor::requiredPrepareBytes(spec, options) == sizeof(OscBotFxProcessor));
    check(fixed.prepare(spec, options) && partitioned.prepare(spec, options));
    auto fixedPcm = makeTone(96000U, 220.0, 330.0, 0.25f);
    auto partitionedPcm = fixedPcm;
    const std::array<OscBotFxEvent, 2U> startEvents{{
        {0U, OscBotControl::Active, 1.0f}, {0U, OscBotControl::Mix, 1.0f}}};
    check(render(fixed, fixedPcm, 128U, startEvents.data(),
                 static_cast<std::uint32_t>(startEvents.size())));
    std::size_t position = 0U;
    constexpr std::array<std::uint32_t, 4U> partitions{{64U, 256U, 96U, 128U}};
    std::size_t partitionIndex = 0U;
    while (position < partitionedPcm.size()) {
        const auto frames = static_cast<std::uint32_t>(std::min<std::size_t>(
            partitions[partitionIndex++ % partitions.size()], partitionedPcm.size() - position));
        const bool first = position == 0U;
        check(partitioned.processBlock(position, partitionedPcm.data() + position, frames,
            first ? startEvents.data() : nullptr,
            first ? static_cast<std::uint32_t>(startEvents.size()) : 0U));
        position += frames;
    }
    check(maxDifference(fixedPcm, partitionedPcm) == 0.0);
    check(fixed.stepCount() == 8U && partitioned.stepCount() == 8U);
    const double leftRms = channelRms(fixedPcm, 24000U, 24000U, false);
    const double rightRms = channelRms(fixedPcm, 24000U, 24000U, true);
    check(leftRms > 0.02 && rightRms > 0.02 &&
          maxDifference(fixedPcm, std::vector<StereoFrame>(fixedPcm.size(), StereoFrame{})) > 0.01);
    double stereoDifference = 0.0;
    for (std::size_t i = 24000U; i < 48000U; ++i)
        stereoDifference += std::fabs(static_cast<double>(fixedPcm[i].left) - fixedPcm[i].right);
    check(stereoDifference / 24000.0 > 1.0e-3);

    OscBotFxOptions patternOne = options;
    patternOne.pattern = 1U;
    OscBotFxProcessor patternProcessor;
    check(patternProcessor.prepare(spec, patternOne));
    auto patternPcm = makeTone(96000U, 220.0, 330.0, 0.25f);
    check(render(patternProcessor, patternPcm, 128U, startEvents.data(), 2U));
    double patternDifference = 0.0;
    for (std::size_t i = 12000U; i < 96000U; ++i)
        patternDifference += std::fabs(static_cast<double>(fixedPcm[i].left) - patternPcm[i].left) +
                             std::fabs(static_cast<double>(fixedPcm[i].right) - patternPcm[i].right);
    check(patternDifference / 168000.0 > 1.0e-3);

    std::array<double, 5U> harmonicRatios{};
    std::array<double, 5U> evenHarmonicRatios{};
    const std::array<OscBotWaveform, 5U> waveforms{{OscBotWaveform::Saw,
        OscBotWaveform::VintageSaw, OscBotWaveform::DetuneSaw,
        OscBotWaveform::Square, OscBotWaveform::Rect}};
    for (std::size_t w = 0U; w < waveforms.size(); ++w) {
        OscBotFxOptions shaped = options;
        shaped.waveform = waveforms[w];
        shaped.pattern = 0U;
        shaped.stepRateHz = 0.25f;
        OscBotFxProcessor processor;
        check(processor.prepare(spec, shaped));
        auto samples = makeTone(36000U, 0.0, 0.0, 0.0f);
        check(render(processor, samples, 128U, startEvents.data(), 2U));
        const auto f0 = 65.4063913;
        const auto begin = 12000U;
        const auto count = 8192U;
        const auto projection = [&](double frequency) noexcept {
            double real = 0.0;
            double imag = 0.0;
            for (std::size_t i = 0U; i < count; ++i) {
                const double phase = 6.2831853071795864769 * frequency * i / 48000.0;
                const double window = 0.5 - 0.5 * std::cos(
                    6.2831853071795864769 * i / static_cast<double>(count - 1U));
                real += static_cast<double>(samples[begin + i].left) * window * std::cos(phase);
                imag -= static_cast<double>(samples[begin + i].left) * window * std::sin(phase);
            }
            return std::sqrt(real * real + imag * imag);
        };
        const double fundamental = projection(f0);
        double harmonics = 0.0;
        double evenHarmonics = 0.0;
        for (int h = 2; h <= 10; ++h) {
            const double magnitude = projection(f0 * h);
            harmonics += magnitude * magnitude;
            if (h % 2 == 0) evenHarmonics += magnitude * magnitude;
        }
        harmonicRatios[w] = std::sqrt(harmonics) / std::max(1.0e-12, fundamental);
        evenHarmonicRatios[w] = std::sqrt(evenHarmonics) / std::max(1.0e-12, fundamental);
    }
    std::fprintf(stderr, "OSC harmonic ratios: all %.4f %.4f %.4f %.4f %.4f, "
        "even %.4f %.4f %.4f %.4f %.4f\n",
        harmonicRatios[0], harmonicRatios[1], harmonicRatios[2], harmonicRatios[3], harmonicRatios[4],
        evenHarmonicRatios[0], evenHarmonicRatios[1], evenHarmonicRatios[2],
        evenHarmonicRatios[3], evenHarmonicRatios[4]);
    check(harmonicRatios[0] > 0.0 && std::fabs(harmonicRatios[0] - harmonicRatios[1]) > 0.015);
    check(std::fabs(harmonicRatios[3] - harmonicRatios[4]) > 0.015);
    check(evenHarmonicRatios[3] < 0.02 && evenHarmonicRatios[4] > 0.05);
}

void testIncrementalStereoAnalysisBudget() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    auto path = std::make_unique<YinPsolaStereoPath>();
    check(YinPsolaStereoPath::requiredPrepareBytes(spec) > sizeof(YinPsolaStereoPath));
    check(path->prepare(spec));
    check(path->latency().analysisCold && path->latency().workUnitsPerChannelPerCallback ==
          YinPsolaStereoPath::kAnalysisWorkUnitsPerChannelPerCallback);

    auto input = makeTone(32768U, 440.0, 277.18, 0.3f);
    std::vector<StereoFrame> output(input.size());
    constexpr std::array<std::uint32_t, 3U> partitions{{64U, 128U, 256U}};
    std::size_t position = 0U;
    std::size_t partition = 0U;
    std::uint32_t maximumWorkLeft = 0U;
    std::uint32_t maximumWorkRight = 0U;
    std::uint64_t promotions = 0U;
    gAllocations.store(0U);
    gFrees.store(0U);
    gTrackAllocations.store(true);
    while (position < input.size()) {
        const auto frames = static_cast<std::uint32_t>(std::min<std::size_t>(
            partitions[partition++ % partitions.size()], input.size() - position));
        if (path->processAnalysisBlock(input.data() + position, frames)) ++promotions;
        maximumWorkLeft = std::max(maximumWorkLeft, path->lastAnalysisWorkUnits(0U));
        maximumWorkRight = std::max(maximumWorkRight, path->lastAnalysisWorkUnits(1U));
        for (std::uint32_t frame = 0U; frame < frames; ++frame)
            output[position + frame] = path->processSample(input[position + frame]);
        position += frames;
    }
    const auto finalMetrics = path->latency();
    gTrackAllocations.store(false);
    check(gAllocations.load() == 0U && gFrees.load() == 0U);
    check(maximumWorkLeft <= finalMetrics.workUnitsPerChannelPerCallback &&
          maximumWorkRight <= finalMetrics.workUnitsPerChannelPerCallback);
    check(finalMetrics.analysisCounts[0U] > 0U && finalMetrics.analysisCounts[1U] > 0U &&
          !finalMetrics.analysisCold && promotions > 0U);
    check(path->estimate(0U).voiced && std::fabs(path->estimate(0U).frequencyHz - 440.0f) < 2.0f);
    check(path->estimate(1U).voiced && std::fabs(path->estimate(1U).frequencyHz - 277.18f) < 2.0f);
    check(finalMetrics.psolaLookaheadSamples > 0U &&
          finalMetrics.conservativePitchOnsetFrames > finalMetrics.psolaLookaheadSamples);
    std::fprintf(stderr,
        "incremental YIN max work=%u/%u budget=%u, counts=%llu/%llu, active age=%u/%u frames, promotions=%llu\n",
        maximumWorkLeft, maximumWorkRight, finalMetrics.workUnitsPerChannelPerCallback,
        static_cast<unsigned long long>(finalMetrics.analysisCounts[0U]),
        static_cast<unsigned long long>(finalMetrics.analysisCounts[1U]),
        finalMetrics.activeEstimateAgeFrames[0U], finalMetrics.activeEstimateAgeFrames[1U],
        static_cast<unsigned long long>(promotions));
}

void testVoiceFxDirectPsolaDiagnostic() {
    using namespace webrc::dsp;
    const ProcessSpec monoSpec{48000.0f, 128U, 1U};
    const PitchEstimate inputEstimate{220.0f, 48000.0f / 220.0f, 0.99f, 0.3f, true};
    std::vector<float> input(48000U);
    for (std::size_t i = 0U; i < input.size(); ++i)
        input[i] = 0.3f * std::sin(2.0 * 3.14159265358979323846 * 220.0 * i / 48000.0);
    constexpr std::array<float, 6U> ratios{{0.5f, 0.75f, 0.94f, 1.0f, 1.5f, 2.0f}};
    for (const float ratio : ratios) {
        StreamingTdPsolaPitchShifter shifter;
        std::vector<float> output(input.size());
        check(shifter.prepare(monoSpec, 739U));
        check(shifter.setPitchEstimate(inputEstimate, ratio));
        for (std::uint32_t pos = 0U; pos < input.size(); pos += 128U)
            check(shifter.processBlock(input.data() + pos, output.data() + pos, 128U));
        double sum = 0.0;
        std::vector<StereoFrame> monoStereo(12000U);
        for (std::size_t i = 0U; i < monoStereo.size(); ++i) {
            monoStereo[i].left = output[32000U + i];
            sum += static_cast<double>(output[32000U + i]) * output[32000U + i];
        }
        const auto targetAmplitude = toneAmplitude(monoStereo, 0U, 12000U, false,
                                                    48000.0, 220.0 * ratio);
        const auto subharmonicAmplitude = toneAmplitude(monoStereo, 0U, 12000U, false,
                                                         48000.0, 110.0 * ratio);
        // Normalized autocorrelation can prefer a longer repeated period for a
        // periodic resynthesis. Tone projections identify the intended F0 and
        // explicitly reject a strong octave/subharmonic ambiguity.
        check(targetAmplitude > 0.1 && targetAmplitude > 10.0 * subharmonicAmplitude);
        std::fprintf(stderr, "direct PSOLA ratio %.2f rms %.6f autocorrCandidate %.3f "
            "projection(target/subharmonic)=%.4f/%.4f\n", ratio,
            std::sqrt(sum / 12000.0), estimateFrequency(monoStereo, 0U, 12000U, false,
                                                        48000.0, 80.0, 1200.0),
            targetAmplitude, subharmonicAmplitude);
    }
}

void testNoAllocationAndTransactionalEvents() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 128U, 2U};
    std::array<RobotFxEvent, 64U> robotEvents{};
    std::array<ElectricFxEvent, 64U> electricEvents{};
    std::array<OscBotFxEvent, 64U> botEvents{};
    for (std::uint32_t i = 0U; i < 64U; ++i) {
        robotEvents[i] = {i * 2U, i % 2U == 0U ? RobotFxControl::Active : RobotFxControl::Mix,
                          static_cast<float>(i % 2U)};
        electricEvents[i] = {i * 2U, i % 2U == 0U ? ElectricFxControl::Speed : ElectricFxControl::Stability,
                             i % 2U == 0U ? static_cast<float>(i % 11U) :
                                 static_cast<float>(static_cast<int>(i % 21U) - 10)};
        botEvents[i] = {i * 2U, OscBotControl::Pattern, static_cast<float>(i % 4U)};
    }
    auto robot = std::make_unique<RobotFxProcessor>();
    auto electric = std::make_unique<ElectricFxProcessor>();
    OscBotFxProcessor bot;
    check(robot->prepare(spec) && electric->prepare(spec) && bot.prepare(spec));
    std::vector<StereoFrame> robotPcm(128U);
    std::vector<StereoFrame> electricPcm(128U);
    std::vector<StereoFrame> botPcm(128U);
    for (std::size_t i = 0U; i < 128U; ++i) {
        const float sample = 0.1f * std::sin(static_cast<float>(i) * 0.13f);
        robotPcm[i] = electricPcm[i] = botPcm[i] = {sample, -0.5f * sample};
    }
    gAllocations.store(0U);
    gFrees.store(0U);
    gTrackAllocations.store(true);
    const bool robotOk = robot->processBlock(0U, robotPcm.data(), 128U,
        robotEvents.data(), static_cast<std::uint32_t>(robotEvents.size()));
    const bool electricOk = electric->processBlock(0U, electricPcm.data(), 128U,
        electricEvents.data(), static_cast<std::uint32_t>(electricEvents.size()));
    const bool botOk = bot.processBlock(0U, botPcm.data(), 128U,
        botEvents.data(), static_cast<std::uint32_t>(botEvents.size()));
    gTrackAllocations.store(false);
    check(robotOk && electricOk && botOk);
    check(gAllocations.load() == 0U && gFrees.load() == 0U);

    auto first = std::make_unique<RobotFxProcessor>();
    auto reference = std::make_unique<RobotFxProcessor>();
    check(first->prepare(spec) && reference->prepare(spec));
    std::vector<StereoFrame> firstBlock(64U, {0.2f, -0.1f});
    auto referenceBlock = firstBlock;
    const auto before = firstBlock;
    const RobotFxEvent invalid{64U, RobotFxControl::Active, 1.0f};
    check(!first->processBlock(0U, firstBlock.data(), 64U, &invalid, 1U));
    check(maxDifference(firstBlock, before) == 0.0);
    check(first->processBlock(0U, firstBlock.data(), 64U));
    check(reference->processBlock(0U, referenceBlock.data(), 64U));
    check(maxDifference(firstBlock, referenceBlock) == 0.0);

    auto electricFirst = std::make_unique<ElectricFxProcessor>();
    auto electricReference = std::make_unique<ElectricFxProcessor>();
    check(electricFirst->prepare(spec) && electricReference->prepare(spec));
    std::vector<StereoFrame> electricFirstBlock(64U, {0.12f, -0.07f});
    auto electricReferenceBlock = electricFirstBlock;
    const auto electricBefore = electricFirstBlock;
    const ElectricFxEvent electricInvalid{0U, ElectricFxControl::ShiftSemitones, 13.0f};
    check(!electricFirst->processBlock(0U, electricFirstBlock.data(), 64U, &electricInvalid, 1U));
    check(maxDifference(electricFirstBlock, electricBefore) == 0.0);
    check(electricFirst->processBlock(0U, electricFirstBlock.data(), 64U));
    check(electricReference->processBlock(0U, electricReferenceBlock.data(), 64U));
    check(maxDifference(electricFirstBlock, electricReferenceBlock) == 0.0);

    OscBotFxProcessor botFirst;
    OscBotFxProcessor botReference;
    check(botFirst.prepare(spec) && botReference.prepare(spec));
    std::vector<StereoFrame> botFirstBlock(64U, {0.12f, -0.07f});
    auto botReferenceBlock = botFirstBlock;
    const auto botBefore = botFirstBlock;
    const OscBotFxEvent botInvalid{0U, OscBotControl::Tone, 50.1f};
    check(!botFirst.processBlock(0U, botFirstBlock.data(), 64U, &botInvalid, 1U));
    check(maxDifference(botFirstBlock, botBefore) == 0.0);
    check(botFirst.processBlock(0U, botFirstBlock.data(), 64U));
    check(botReference.processBlock(0U, botReferenceBlock.data(), 64U));
    check(maxDifference(botFirstBlock, botReferenceBlock) == 0.0);
}

} // namespace

void* operator new(std::size_t size) {
    if (failAllocationNow()) throw std::bad_alloc{};
    if (void* memory = std::malloc(size == 0U ? 1U : size)) {
        if (gTrackAllocations.load()) gAllocations.fetch_add(1U);
        return memory;
    }
    throw std::bad_alloc{};
}

void* operator new[](std::size_t size) {
    if (failAllocationNow()) throw std::bad_alloc{};
    if (void* memory = std::malloc(size == 0U ? 1U : size)) {
        if (gTrackAllocations.load()) gAllocations.fetch_add(1U);
        return memory;
    }
    throw std::bad_alloc{};
}

void operator delete(void* memory) noexcept {
    if (memory != nullptr) {
        if (gTrackAllocations.load()) gFrees.fetch_add(1U);
        std::free(memory);
    }
}

void operator delete[](void* memory) noexcept {
    if (memory != nullptr) {
        if (gTrackAllocations.load()) gFrees.fetch_add(1U);
        std::free(memory);
    }
}

void operator delete(void* memory, std::size_t) noexcept { ::operator delete(memory); }
void operator delete[](void* memory, std::size_t) noexcept { ::operator delete[](memory); }

int main() {
    testPrepareBoundsAndRobotPitch();
    testElectricControlsAndStereoPitch();
    testOscBotSequenceWaveformsAndStereo();
    testIncrementalStereoAnalysisBudget();
    testVoiceFxDirectPsolaDiagnostic();
    testNoAllocationAndTransactionalEvents();
    std::printf("{\"schemaVersion\":1,\"suite\":\"voice-fx\",\"failures\":%u,"
                "\"callbacksAllocations\":%llu,\"callbacksFrees\":%llu}\n",
                gFailures,
                static_cast<unsigned long long>(gAllocations.load()),
                static_cast<unsigned long long>(gFrees.load()));
    return gFailures == 0U ? 0 : 1;
}
