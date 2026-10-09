#include "webrc/dsp/octave_signalsmith_models.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <new>
#include <string>
#include <vector>

using namespace webrc::dsp;

namespace {

constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kBlockLimit = 256U;
constexpr double kPi = 3.1415926535897932384626433832795;
std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gAllocationCount{0U};
std::atomic<std::uint64_t> gFreeCount{0U};
std::uint32_t gFailures = 0U;
std::uint64_t gCallbackAllocations = 0U;
std::uint64_t gCallbackFrees = 0U;
double gPartitionMaximumDifference = 0.0;
std::uint32_t gDryImpulseFirst = std::numeric_limits<std::uint32_t>::max();
std::uint32_t gDryImpulsePeak = 0U;
std::uint32_t gWetImpulseFirst = std::numeric_limits<std::uint32_t>::max();
std::uint32_t gWetImpulsePeak = 0U;
double gImpulseCrossCorrelationPeak = 0.0;
std::int32_t gImpulseCrossCorrelationOffset = 0;
std::uint32_t gImpulseFixedDelay = 0U;
int gAdapterInputLatency = 0;
int gAdapterOutputLatency = 0;
double gGatedDurationMs = 0.0;
std::uint32_t gGatedFirstActiveFrame = 0U;
std::uint32_t gGatedLastActiveFrame = 0U;
double gLeftOnlyLeakageRms = 0.0;

struct ToneMetric {
    double inputHz = 0.0;
    double rightInputHz = 0.0;
    double oneLeftHz = 0.0;
    double oneRightHz = 0.0;
    double twoLeftHz = 0.0;
    double twoRightHz = 0.0;
    double dualOneLeftHz = 0.0;
    double dualTwoLeftHz = 0.0;
    double dualOneRightHz = 0.0;
    double dualTwoRightHz = 0.0;
    double dualOneLeft = 0.0;
    double dualTwoLeft = 0.0;
    double dualOneRight = 0.0;
    double dualTwoRight = 0.0;
    double oneLeftAmplitude = 0.0;
    double oneRightAmplitude = 0.0;
    double twoLeftAmplitude = 0.0;
    double twoRightAmplitude = 0.0;
    double oneLeftExactTargetAmplitude = 0.0;
    double oneRightExactTargetAmplitude = 0.0;
    double twoLeftExactTargetAmplitude = 0.0;
    double twoRightExactTargetAmplitude = 0.0;
    bool dualMeasured = false;
};
std::array<ToneMetric, 4U> gToneMetrics{};
double gHighResolutionLeftPeakHz = 0.0;
double gHighResolutionRightPeakHz = 0.0;
double gHighResolutionLeftZeroCrossingHz = 0.0;
double gHighResolutionRightZeroCrossingHz = 0.0;
double gHighResolutionLeftExactTargetAmplitude = 0.0;
double gHighResolutionRightExactTargetAmplitude = 0.0;
int gHighResolutionInputLatency = 0;
int gHighResolutionOutputLatency = 0;

void check(bool condition, const char* message) {
    if (!condition) {
        ++gFailures;
        std::fprintf(stderr, "FAIL: %s\n", message);
    }
}

ProcessSpec makeSpec(std::uint32_t maxFrames = kBlockLimit) {
    return {static_cast<float>(kSampleRate), maxFrames, 2U};
}

OctaveSignalsmithEvent event(std::uint32_t frame, OctaveSignalsmithControl control,
                             float value) {
    return {frame, control, value};
}

float sine(double frequency, std::uint64_t frame, double amplitude = 0.5,
           double phase = 0.0) {
    return static_cast<float>(amplitude * std::sin(
        2.0 * kPi * frequency * static_cast<double>(frame) / kSampleRate + phase));
}

void saveInterleaved(const std::string& path, const std::vector<StereoFrame>& frames) {
    if (path.empty()) return;
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) {
        check(false, "capture PCM sidecar opens");
        return;
    }
    for (const auto& frame : frames) {
        const std::array<float, 2U> values{{frame.left, frame.right}};
        output.write(reinterpret_cast<const char*>(values.data()), sizeof(values));
    }
    check(static_cast<bool>(output), "capture PCM sidecar is written completely");
}

bool renderScheduled(OctaveSignalsmithModelsFxProcessor& processor,
                     std::vector<StereoFrame>& audio, const std::vector<std::uint32_t>& partitions,
                     const std::vector<std::pair<std::uint64_t, OctaveSignalsmithEvent>>& events) {
    std::uint64_t frame = 0U;
    std::size_t partitionIndex = 0U;
    while (frame < audio.size()) {
        const auto requested = partitions[partitionIndex++ % partitions.size()];
        const auto frames = static_cast<std::uint32_t>(std::min<std::uint64_t>(
            requested, audio.size() - frame));
        std::array<OctaveSignalsmithEvent,
                   OctaveSignalsmithModelsFxProcessor::kMaximumControlEventsPerBlock> blockEvents{};
        std::uint32_t count = 0U;
        for (const auto& scheduled : events) {
            if (scheduled.first >= frame && scheduled.first < frame + frames) {
                if (count == blockEvents.size()) return false;
                blockEvents[count] = scheduled.second;
                blockEvents[count].frameOffset = static_cast<std::uint32_t>(scheduled.first - frame);
                ++count;
            }
        }
        if (!processor.processBlock(frame, audio.data() + frame, frames,
                                    count == 0U ? nullptr : blockEvents.data(), count)) return false;
        frame += frames;
    }
    return true;
}

struct Projection {
    double frequency = 0.0;
    double amplitude = 0.0;
};

double exactTargetAmplitude(const std::vector<StereoFrame>& audio, bool left,
                            std::uint32_t first, std::uint32_t count,
                            double frequency) {
    const auto last = std::min<std::uint64_t>(audio.size(),
        static_cast<std::uint64_t>(first) + count);
    if (last <= first) return 0.0;
    const auto omega = 2.0 * kPi * frequency / kSampleRate;
    const auto cosineStep = std::cos(omega);
    const auto sineStep = std::sin(omega);
    auto cosine = std::cos(omega * first);
    auto sineValue = std::sin(omega * first);
    double real = 0.0;
    double imaginary = 0.0;
    for (std::uint64_t frame = first; frame < last; ++frame) {
        const auto sample = left ? audio[frame].left : audio[frame].right;
        real += static_cast<double>(sample) * cosine;
        imaginary -= static_cast<double>(sample) * sineValue;
        const auto nextCosine = cosine * cosineStep - sineValue * sineStep;
        sineValue = sineValue * cosineStep + cosine * sineStep;
        cosine = nextCosine;
    }
    return 2.0 * std::hypot(real, imaginary) / static_cast<double>(last - first);
}

Projection peakProjection(const std::vector<StereoFrame>& audio, bool left,
                          std::uint32_t first, std::uint32_t count,
                          double expectedHz, double searchHz = 3.0) {
    Projection best{};
    double bestAmplitude = -1.0;
    constexpr double step = 0.25;
    const auto last = std::min<std::uint64_t>(audio.size(),
        static_cast<std::uint64_t>(first) + count);
    if (last <= first) return best;
    const auto n = static_cast<double>(last - first);
    const auto minHz = std::max(1.0, expectedHz - searchHz);
    const auto maxHz = std::min(static_cast<double>(kSampleRate) * 0.49,
                                expectedHz + searchHz);
    for (double frequency = minHz; frequency <= maxHz + 1.0e-9; frequency += step) {
        const double omega = 2.0 * kPi * frequency / kSampleRate;
        const double cosineStep = std::cos(omega);
        const double sineStep = std::sin(omega);
        double cosine = std::cos(omega * first);
        double sineValue = std::sin(omega * first);
        double real = 0.0;
        double imaginary = 0.0;
        for (std::uint64_t frame = first; frame < last; ++frame) {
            const auto sample = left ? audio[frame].left : audio[frame].right;
            real += static_cast<double>(sample) * cosine;
            imaginary -= static_cast<double>(sample) * sineValue;
            const auto nextCosine = cosine * cosineStep - sineValue * sineStep;
            sineValue = sineValue * cosineStep + cosine * sineStep;
            cosine = nextCosine;
        }
        const double amplitude = 2.0 * std::hypot(real, imaginary) / n;
        if (amplitude > bestAmplitude) {
            bestAmplitude = amplitude;
            best = {frequency, amplitude};
        }
    }
    return best;
}

bool testOptionsAndTransactionalValidation() {
    auto options = OctaveSignalsmithOptions{};
    options.blockSamples = 8192U;
    options.intervalSamples = 1024U;
    const auto required = OctaveSignalsmithModelsFxProcessor::requiredPrepareBytes(
        makeSpec(), options);
    check(required > 0U && required < 48U * 1024U * 1024U,
          "stereo Signalsmith branches fit the fixed conservative budget");
    check(OctaveSignalsmithModelsFxProcessor::replacementPeakBytes(required, makeSpec(), options)
              == required * 2U,
          "replacement peak admission accounts for active and staged processors");
    check(OctaveSignalsmithModelsFxProcessor::requiredPrepareBytes(
              {48000.0f, kBlockLimit, 1U}, options) == 0U,
          "mono OCTAVE graphs fail closed because outputs are stereo");
    auto invalidOptions = options;
    invalidOptions.intervalSamples = invalidOptions.blockSamples + 1U;
    check(OctaveSignalsmithModelsFxProcessor::requiredPrepareBytes(makeSpec(), invalidOptions) == 0U,
          "invalid adapter interval is rejected before allocation");

    OctaveSignalsmithModelsFxProcessor processor(0x05aa1234U);
    check(processor.prepare(makeSpec(), options), "fresh Signalsmith OCTAVE graph prepares");
    check(processor.preparedBytes() == required, "prepared memory report matches preflight");
    const auto latency = processor.latency();
    gImpulseFixedDelay = latency.fixedMixedPathSamples;
    gAdapterInputLatency = latency.adapterInputLatencySamples;
    gAdapterOutputLatency = latency.adapterOutputLatencySamples;
    check(latency.fixedMixedPathSamples == 8192U,
          "dry mixed path aligns to analysis plus synthesis delay");
    check(latency.adapterInputLatencySamples == 4096 &&
          latency.adapterOutputLatencySamples == 4096,
          "Signalsmith input/output delay getters remain independently reported");
    check(!processor.prepare(makeSpec(), invalidOptions),
          "a prepared processor rejects invalid restaging without replacing active state");

    std::array<StereoFrame, 64U> block{};
    block.fill({0.13f, -0.07f});
    const auto before = block;
    const auto bad = event(37U, OctaveSignalsmithControl::Mode, 1.5f);
    check(!processor.processBlock(0U, block.data(), 64U, &bad, 1U),
          "fractional mode selection fails whole-callback validation");
    check(std::equal(block.begin(), block.end(), before.begin(), [](const auto& a, const auto& b) {
        return a.left == b.left && a.right == b.right;
    }), "invalid event leaves input/output PCM untouched");
    check(processor.processBlock(0U, block.data(), 64U),
          "invalid event leaves branch/timeline state reusable");
    return true;
}

void testTonesAndPublishedModes(const std::string& captureDirectory) {
    constexpr std::uint32_t totalFrames = 6U * kSampleRate;
    const std::array<double, 4U> inputTones{{55.0, 110.0, 220.0, 880.0}};
    const std::vector<std::uint32_t> mixedPartitions{{64U, 128U, 256U, 128U, 64U, 256U}};
    for (std::size_t toneIndex = 0U; toneIndex < inputTones.size(); ++toneIndex) {
        const auto frequency = inputTones[toneIndex];
        std::vector<StereoFrame> audio(totalFrames);
        for (std::uint32_t frame = 0U; frame < totalFrames; ++frame) {
            audio[frame] = {sine(frequency, frame, 0.55),
                            sine(frequency * 1.25, frame, 0.43, 0.31)};
        }
        OctaveSignalsmithModelsFxProcessor processor(0x05aa1234U);
        OctaveSignalsmithOptions options{};
        options.blockSamples = 8192U;
        options.intervalSamples = 1024U;
        check(processor.prepare(makeSpec(), options), "longtone processor prepares");
        const auto firstSwitch = static_cast<std::uint64_t>(kSampleRate) * 2U + 37U;
        const auto secondSwitch = static_cast<std::uint64_t>(kSampleRate) * 4U + 37U;
        const std::vector<std::pair<std::uint64_t, OctaveSignalsmithEvent>> events{
            {0U, event(0U, OctaveSignalsmithControl::Active, 1.0f)},
            {0U, event(0U, OctaveSignalsmithControl::Mix, 1.0f)},
            {firstSwitch, event(0U, OctaveSignalsmithControl::Mode,
                                static_cast<float>(OctaveSignalsmithMode::DownTwoOctaves))},
            {secondSwitch, event(0U, OctaveSignalsmithControl::Mode,
                                 static_cast<float>(OctaveSignalsmithMode::DualDownOctaves))}};
        check(renderScheduled(processor, audio, mixedPartitions, events),
              "both continuous voices render all modes over mixed callback sizes");

        constexpr std::uint32_t windowFirstOne = 48000U;
        constexpr std::uint32_t windowFirstTwo = 144000U;
        constexpr std::uint32_t windowFirstDual = 240000U;
        constexpr std::uint32_t windowCount = 48000U;
        const auto oneLeft = peakProjection(audio, true, windowFirstOne, windowCount, frequency / 2.0);
        const auto oneRight = peakProjection(audio, false, windowFirstOne, windowCount,
                                             frequency * 1.25 / 2.0);
        const auto twoLeft = peakProjection(audio, true, windowFirstTwo, windowCount, frequency / 4.0);
        const auto twoRight = peakProjection(audio, false, windowFirstTwo, windowCount,
                                             frequency * 1.25 / 4.0);
        auto& metric = gToneMetrics[toneIndex];
        metric.inputHz = frequency;
        metric.rightInputHz = frequency * 1.25;
        metric.oneLeftHz = oneLeft.frequency;
        metric.oneRightHz = oneRight.frequency;
        metric.twoLeftHz = twoLeft.frequency;
        metric.twoRightHz = twoRight.frequency;
        metric.oneLeftAmplitude = oneLeft.amplitude;
        metric.oneRightAmplitude = oneRight.amplitude;
        metric.twoLeftAmplitude = twoLeft.amplitude;
        metric.twoRightAmplitude = twoRight.amplitude;
        metric.oneLeftExactTargetAmplitude = exactTargetAmplitude(
            audio, true, windowFirstOne, windowCount, frequency / 2.0);
        metric.oneRightExactTargetAmplitude = exactTargetAmplitude(
            audio, false, windowFirstOne, windowCount, frequency * 1.25 / 2.0);
        metric.twoLeftExactTargetAmplitude = exactTargetAmplitude(
            audio, true, windowFirstTwo, windowCount, frequency / 4.0);
        metric.twoRightExactTargetAmplitude = exactTargetAmplitude(
            audio, false, windowFirstTwo, windowCount, frequency * 1.25 / 4.0);
        check(oneLeft.amplitude > 0.01 && oneRight.amplitude > 0.01,
              "-1OCT has measurable independent stereo tone output");
        check(twoLeft.amplitude > 0.003 && twoRight.amplitude > 0.003,
              "-2OCT has measurable independent stereo tone output");
        const auto lowRegisterTolerance = frequency == 55.0 ? 4.0 : 2.5;
        check(std::fabs(oneLeft.frequency - frequency / 2.0) <= lowRegisterTolerance &&
              std::fabs(oneRight.frequency - frequency * 1.25 / 2.0) <= lowRegisterTolerance,
              "-1OCT spectral projections match half-frequency targets");
        check(std::fabs(twoLeft.frequency - frequency / 4.0) <= lowRegisterTolerance &&
              std::fabs(twoRight.frequency - frequency * 1.25 / 4.0) <= lowRegisterTolerance,
              "-2OCT spectral projections match quarter-frequency targets");

        if (frequency == 220.0 || frequency == 880.0) {
            const auto dualOneLeft = peakProjection(audio, true, windowFirstDual, windowCount,
                                                    frequency / 2.0);
            const auto dualTwoLeft = peakProjection(audio, true, windowFirstDual, windowCount,
                                                    frequency / 4.0);
            const auto dualOneRight = peakProjection(audio, false, windowFirstDual, windowCount,
                                                     frequency * 1.25 / 2.0);
            const auto dualTwoRight = peakProjection(audio, false, windowFirstDual, windowCount,
                                                     frequency * 1.25 / 4.0);
            metric.dualOneLeftHz = dualOneLeft.frequency;
            metric.dualTwoLeftHz = dualTwoLeft.frequency;
            metric.dualOneRightHz = dualOneRight.frequency;
            metric.dualTwoRightHz = dualTwoRight.frequency;
            metric.dualOneLeft = dualOneLeft.amplitude;
            metric.dualTwoLeft = dualTwoLeft.amplitude;
            metric.dualOneRight = dualOneRight.amplitude;
            metric.dualTwoRight = dualTwoRight.amplitude;
            metric.dualMeasured = true;
            check(dualOneLeft.amplitude > 0.02 && dualTwoLeft.amplitude > 0.01 &&
                  dualOneRight.amplitude > 0.02 && dualTwoRight.amplitude > 0.01,
                  "dual mode contains both octave components on independent stereo inputs");
            check(std::fabs(dualOneLeft.frequency - frequency / 2.0) <= 2.5 &&
                  std::fabs(dualTwoLeft.frequency - frequency / 4.0) <= 2.5 &&
                  std::fabs(dualOneRight.frequency - frequency * 1.25 / 2.0) <= 2.5 &&
                  std::fabs(dualTwoRight.frequency - frequency * 1.25 / 4.0) <= 2.5,
                  "dual-mode stereo projections remain on both intended octave pitches");
        }

        if (!captureDirectory.empty()) {
            const auto stem = captureDirectory + "\\octave-signalsmith-tone-" +
                std::to_string(static_cast<unsigned>(frequency)) + "Hz";
            std::vector<StereoFrame> input(totalFrames);
            for (std::uint32_t frame = 0U; frame < totalFrames; ++frame) {
                input[frame] = {sine(frequency, frame, 0.55),
                                sine(frequency * 1.25, frame, 0.43, 0.31)};
            }
            saveInterleaved(stem + "-input.f32le", input);
            saveInterleaved(stem + "-output.f32le", audio);
        }
    }
}

struct SignalsmithInputView {
    const float* const* channels;
    const float* operator[](int channel) const noexcept { return channels[channel]; }
};

struct SignalsmithOutputView {
    float* const* channels;
    float* operator[](int channel) const noexcept { return channels[channel]; }
};

double positiveCrossingFrequency(const std::vector<StereoFrame>& audio, bool left,
                                 std::uint32_t first, std::uint32_t count) {
    const auto last = std::min<std::uint64_t>(audio.size(),
        static_cast<std::uint64_t>(first) + count);
    if (last <= static_cast<std::uint64_t>(first) + 1U) return 0.0;
    double intervalSum = 0.0;
    std::uint32_t intervals = 0U;
    double previous = left ? audio[first].left : audio[first].right;
    double previousCrossing = -1.0;
    for (std::uint64_t frame = static_cast<std::uint64_t>(first) + 1U;
         frame < last; ++frame) {
        const auto sample = static_cast<double>(left ? audio[frame].left : audio[frame].right);
        if (previous <= 0.0 && sample > 0.0) {
            const auto denominator = sample - previous;
            const auto fraction = denominator > 0.0 ? -previous / denominator : 0.0;
            const auto crossing = static_cast<double>(frame - 1U) + fraction;
            if (previousCrossing >= 0.0) {
                intervalSum += crossing - previousCrossing;
                ++intervals;
            }
            previousCrossing = crossing;
        }
        previous = sample;
    }
    return intervals < 2U ? 0.0 : kSampleRate / (intervalSum / intervals);
}

void testHighResolutionLowRegisterProbe(const std::string& captureDirectory) {
    constexpr std::uint32_t maxBlock = 256U;
    constexpr std::uint32_t totalFrames = 6U * kSampleRate;
    constexpr std::uint32_t measureFirst = 4U * kSampleRate;
    constexpr std::uint32_t measureCount = 2U * kSampleRate;
    signalsmith::stretch::SignalsmithStretch<float> engine(0x05aa1234L);
    engine.configure(2, 16384, 2048, false);
    engine.setTransposeFactor(0.25f);
    gHighResolutionInputLatency = engine.inputLatency();
    gHighResolutionOutputLatency = engine.outputLatency();
    std::array<std::vector<float>, 2U> input{{std::vector<float>(totalFrames),
                                               std::vector<float>(totalFrames)}};
    std::array<std::vector<float>, 2U> output{{std::vector<float>(totalFrames),
                                                std::vector<float>(totalFrames)}};
    for (std::uint32_t frame = 0U; frame < totalFrames; ++frame) {
        input[0U][frame] = sine(55.0, frame, 0.55);
        input[1U][frame] = sine(68.75, frame, 0.43, 0.31);
    }
    for (std::uint32_t start = 0U; start < totalFrames; start += maxBlock) {
        const auto frames = std::min(maxBlock, totalFrames - start);
        const std::array<const float*, 2U> inputs{{input[0U].data() + start,
                                                   input[1U].data() + start}};
        const std::array<float*, 2U> outputs{{output[0U].data() + start,
                                              output[1U].data() + start}};
        engine.process(SignalsmithInputView{inputs.data()}, static_cast<int>(frames),
                       SignalsmithOutputView{outputs.data()}, static_cast<int>(frames));
    }
    std::vector<StereoFrame> interleaved(totalFrames);
    for (std::uint32_t frame = 0U; frame < totalFrames; ++frame)
        interleaved[frame] = {output[0U][frame], output[1U][frame]};
    const auto leftPeak = peakProjection(interleaved, true, measureFirst, measureCount, 13.75, 3.0);
    const auto rightPeak = peakProjection(interleaved, false, measureFirst, measureCount, 17.1875, 3.0);
    gHighResolutionLeftPeakHz = leftPeak.frequency;
    gHighResolutionRightPeakHz = rightPeak.frequency;
    gHighResolutionLeftExactTargetAmplitude = exactTargetAmplitude(
        interleaved, true, measureFirst, measureCount, 13.75);
    gHighResolutionRightExactTargetAmplitude = exactTargetAmplitude(
        interleaved, false, measureFirst, measureCount, 17.1875);
    gHighResolutionLeftZeroCrossingHz = positiveCrossingFrequency(
        interleaved, true, measureFirst, measureCount);
    gHighResolutionRightZeroCrossingHz = positiveCrossingFrequency(
        interleaved, false, measureFirst, measureCount);
    check(leftPeak.amplitude > 0.005 && rightPeak.amplitude > 0.005,
          "16k-window low-register probe produces measurable quarter-frequency energy");
    check(std::fabs(leftPeak.frequency - 13.75) < 1.0 &&
          std::fabs(rightPeak.frequency - 17.1875) < 1.0,
          "16k-window diagnostic resolves the 55/68.75 Hz quarter-frequency targets");
    check(gHighResolutionLeftZeroCrossingHz > 0.0 && gHighResolutionRightZeroCrossingHz > 0.0,
          "independent positive-crossing estimate is available for warmed low-register output");
    if (!captureDirectory.empty()) {
        std::vector<StereoFrame> source(totalFrames);
        for (std::uint32_t frame = 0U; frame < totalFrames; ++frame)
            source[frame] = {input[0U][frame], input[1U][frame]};
        saveInterleaved(captureDirectory + "\\octave-signalsmith-55Hz-16384-input.f32le", source);
        saveInterleaved(captureDirectory + "\\octave-signalsmith-55Hz-16384-output.f32le",
                        interleaved);
    }
    // Emit the independent spectral and zero-crossing estimators for the
    // highest-resolution low-register diagnostic window.
    std::fprintf(stderr,
        "LOW_REGISTER_16384 {\"leftPeakHz\":%.6g,\"leftZeroCrossingHz\":%.6g,"
        "\"leftExactTargetAmplitude\":%.9g,\"leftPeakAmplitude\":%.9g,"
        "\"rightPeakHz\":%.6g,\"rightZeroCrossingHz\":%.6g,"
        "\"rightExactTargetAmplitude\":%.9g,\"rightPeakAmplitude\":%.9g,"
        "\"inputLatencySamples\":%d,\"outputLatencySamples\":%d}\n",
        leftPeak.frequency, gHighResolutionLeftZeroCrossingHz,
        gHighResolutionLeftExactTargetAmplitude, leftPeak.amplitude,
        rightPeak.frequency, gHighResolutionRightZeroCrossingHz,
        gHighResolutionRightExactTargetAmplitude, rightPeak.amplitude,
        gHighResolutionInputLatency, gHighResolutionOutputLatency);
}

void testImpulseAndCrossChannelIsolation(const std::string& captureDirectory) {
    constexpr std::uint32_t totalFrames = 32768U;
    OctaveSignalsmithOptions options{};
    options.blockSamples = 8192U;
    options.intervalSamples = 1024U;
    auto runImpulse = [&](float mix) {
        OctaveSignalsmithModelsFxProcessor processor(0x05aa1234U);
        check(processor.prepare(makeSpec(), options), "impulse processor prepares");
        std::vector<StereoFrame> audio(totalFrames);
        audio[0U] = {0.7f, -0.3f};
        const std::vector<std::pair<std::uint64_t, OctaveSignalsmithEvent>> events{
            {0U, event(0U, OctaveSignalsmithControl::Active, 1.0f)},
            {0U, event(0U, OctaveSignalsmithControl::Mix, mix)}};
        check(renderScheduled(processor, audio, {64U, 128U, 256U}, events),
              "impulse runs through measured stereo pipeline");
        return audio;
    };
    auto dry = runImpulse(0.0f);
    auto wet = runImpulse(1.0f);
    std::vector<StereoFrame> impulseInput(totalFrames);
    impulseInput[0U] = {0.7f, -0.3f};
    double dryEnergy = 0.0;
    double wetEnergy = 0.0;
    for (std::uint32_t frame = 0U; frame < totalFrames; ++frame) {
        const double dryAmplitude = std::max(std::fabs(dry[frame].left), std::fabs(dry[frame].right));
        const double wetAmplitude = std::max(std::fabs(wet[frame].left), std::fabs(wet[frame].right));
        dryEnergy += static_cast<double>(dry[frame].left) * dry[frame].left +
                     static_cast<double>(dry[frame].right) * dry[frame].right;
        wetEnergy += static_cast<double>(wet[frame].left) * wet[frame].left +
                     static_cast<double>(wet[frame].right) * wet[frame].right;
        if (dryAmplitude > 1.0e-7 && gDryImpulseFirst == std::numeric_limits<std::uint32_t>::max())
            gDryImpulseFirst = frame;
        if (dryAmplitude > std::max(std::fabs(dry[gDryImpulsePeak].left),
                                    std::fabs(dry[gDryImpulsePeak].right))) gDryImpulsePeak = frame;
        if (wetAmplitude > 1.0e-7 && gWetImpulseFirst == std::numeric_limits<std::uint32_t>::max())
            gWetImpulseFirst = frame;
        if (wetAmplitude > std::max(std::fabs(wet[gWetImpulsePeak].left),
                                    std::fabs(wet[gWetImpulsePeak].right))) gWetImpulsePeak = frame;
    }
    check(gDryImpulseFirst == gImpulseFixedDelay && gDryImpulsePeak == gImpulseFixedDelay,
          "dry impulse onset and peak equal declared mixed-path alignment");
    check(gWetImpulseFirst < totalFrames && gWetImpulsePeak < totalFrames && wetEnergy > 1.0e-8,
          "wet impulse onset, peak, and energy are measured independently");
    const auto dryPeak = std::max(std::fabs(dry[gDryImpulsePeak].left),
                                  std::fabs(dry[gDryImpulsePeak].right));
    const auto wetPeak = std::max(std::fabs(wet[gWetImpulsePeak].left),
                                  std::fabs(wet[gWetImpulsePeak].right));
    if (dryPeak > 0.0 && wetPeak > 0.0) {
        const auto dryNorm = std::sqrt(0.7 * 0.7 + 0.3 * 0.3);
        const auto denominator = dryNorm * std::sqrt(wetEnergy);
        for (std::int32_t offset = -static_cast<std::int32_t>(gImpulseFixedDelay);
             offset < static_cast<std::int32_t>(totalFrames - gImpulseFixedDelay); ++offset) {
            const auto wetFrame = static_cast<std::int64_t>(gDryImpulsePeak) + offset;
            if (wetFrame < 0 || wetFrame >= static_cast<std::int64_t>(wet.size())) continue;
            const auto& sample = wet[static_cast<std::size_t>(wetFrame)];
            const auto correlation = std::fabs((0.7 * sample.left - 0.3 * sample.right) /
                                               std::max(denominator, 1.0e-20));
            if (correlation > gImpulseCrossCorrelationPeak) {
                gImpulseCrossCorrelationPeak = correlation;
                gImpulseCrossCorrelationOffset = offset;
            }
        }
    }
    check(dryEnergy > 0.0 && wetEnergy > 0.0,
          "wet/dry impulse fixtures both carry nonzero signal energy");

    OctaveSignalsmithModelsFxProcessor isolation(0x05aa1234U);
    check(isolation.prepare(makeSpec(), options), "left-only leakage processor prepares");
    std::vector<StereoFrame> leftOnly(65536U);
    for (std::uint32_t frame = 0U; frame < leftOnly.size(); ++frame)
        leftOnly[frame].left = sine(880.0, frame, 0.52);
    const auto leftOnlyInput = leftOnly;
    const std::vector<std::pair<std::uint64_t, OctaveSignalsmithEvent>> events{
        {0U, event(0U, OctaveSignalsmithControl::Active, 1.0f)},
        {0U, event(0U, OctaveSignalsmithControl::Mix, 1.0f)},
        {0U, event(0U, OctaveSignalsmithControl::Mode,
                   static_cast<float>(OctaveSignalsmithMode::DualDownOctaves))}};
    check(renderScheduled(isolation, leftOnly, {64U, 128U, 256U}, events),
          "left-only sine traverses dual mode");
    double rightEnergy = 0.0;
    for (std::uint32_t frame = 0U; frame < leftOnly.size(); ++frame)
        rightEnergy += static_cast<double>(leftOnly[frame].right) * leftOnly[frame].right;
    gLeftOnlyLeakageRms = std::sqrt(rightEnergy / leftOnly.size());
    check(gLeftOnlyLeakageRms < 1.0e-7,
          "left-only dual mode does not leak into the right channel");

    if (!captureDirectory.empty()) {
        saveInterleaved(captureDirectory + "\\octave-signalsmith-impulse-input.f32le",
                        impulseInput);
        saveInterleaved(captureDirectory + "\\octave-signalsmith-impulse-dry.f32le", dry);
        saveInterleaved(captureDirectory + "\\octave-signalsmith-impulse-wet.f32le", wet);
        saveInterleaved(captureDirectory + "\\octave-signalsmith-left-only-input.f32le",
                        leftOnlyInput);
        saveInterleaved(captureDirectory + "\\octave-signalsmith-left-only.f32le", leftOnly);
    }
}

void testSampleOffsetModeEvent() {
    OctaveSignalsmithModelsFxProcessor switched(0x7291U);
    OctaveSignalsmithModelsFxProcessor control(0x7291U);
    check(switched.prepare(makeSpec()) && control.prepare(makeSpec()),
          "paired sample-offset mode processors prepare");
    std::vector<StereoFrame> warmA(16384U), warmB(16384U);
    for (std::uint32_t frame = 0U; frame < warmA.size(); ++frame) {
        warmA[frame] = {sine(880.0, frame, 0.42), sine(660.0, frame, 0.29, 0.2)};
        warmB[frame] = warmA[frame];
    }
    const std::vector<std::pair<std::uint64_t, OctaveSignalsmithEvent>> oneMode{
        {0U, event(0U, OctaveSignalsmithControl::Active, 1.0f)},
        {0U, event(0U, OctaveSignalsmithControl::Mix, 1.0f)}};
    check(renderScheduled(switched, warmA, {128U}, oneMode) &&
          renderScheduled(control, warmB, {128U}, oneMode),
          "mode pair warms with deterministic lockstep histories");

    std::array<StereoFrame, 128U> blockA{}, blockB{};
    for (std::uint32_t frame = 0U; frame < blockA.size(); ++frame) {
        const auto absolute = warmA.size() + frame;
        blockA[frame] = {sine(880.0, absolute, 0.42), sine(660.0, absolute, 0.29, 0.2)};
        blockB[frame] = blockA[frame];
    }
    const auto modeChange = event(37U, OctaveSignalsmithControl::Mode,
        static_cast<float>(OctaveSignalsmithMode::DownTwoOctaves));
    check(switched.processBlock(warmA.size(), blockA.data(), 128U, &modeChange, 1U) &&
          control.processBlock(warmB.size(), blockB.data(), 128U),
          "mode event at frame 37 is accepted without resetting either branch");
    double preEventDifference = 0.0;
    double postEventDifference = 0.0;
    for (std::uint32_t frame = 0U; frame < blockA.size(); ++frame) {
        const auto difference = static_cast<double>(std::max(
            std::fabs(blockA[frame].left - blockB[frame].left),
            std::fabs(blockA[frame].right - blockB[frame].right)));
        if (frame < 37U) preEventDifference = std::max(preEventDifference, difference);
        else postEventDifference = std::max(postEventDifference, difference);
    }
    check(preEventDifference == 0.0,
          "frame-37 mode event preserves all preceding samples exactly");
    check(postEventDifference > 1.0e-5,
          "frame-37 mode event changes the output mix from its declared sample");
}

void testDurationPartitioningAndNoAllocation() {
    OctaveSignalsmithOptions options{};
    options.blockSamples = 8192U;
    options.intervalSamples = 1024U;
    constexpr std::uint32_t total = 65536U;
    std::vector<StereoFrame> input(total);
    for (std::uint32_t frame = 0U; frame < total; ++frame) {
        const auto pseudo = static_cast<std::int32_t>((frame * 1664525U + 1013904223U) >> 16U);
        input[frame] = {0.24f * sine(997.0, frame, 1.0) + 0.08f * (pseudo / 32768.0f),
                        -0.21f * sine(733.0, frame, 1.0) + 0.06f * (pseudo / 32768.0f)};
    }
    auto audio64 = input;
    auto audio128 = input;
    auto audio256 = input;
    const std::vector<std::pair<std::uint64_t, OctaveSignalsmithEvent>> setup{
        {0U, event(0U, OctaveSignalsmithControl::Active, 1.0f)},
        {0U, event(0U, OctaveSignalsmithControl::Mix, 0.83f)},
        {0U, event(0U, OctaveSignalsmithControl::Mode,
                   static_cast<float>(OctaveSignalsmithMode::DualDownOctaves))}};
    OctaveSignalsmithModelsFxProcessor p64(0x1199U), p128(0x1199U), p256(0x1199U);
    check(p64.prepare(makeSpec()) && p128.prepare(makeSpec()) && p256.prepare(makeSpec()),
          "partition comparison instances prepare with identical seeds");
    check(renderScheduled(p64, audio64, {64U}, setup) &&
          renderScheduled(p128, audio128, {128U}, setup) &&
          renderScheduled(p256, audio256, {256U}, setup),
          "64/128/256 sample and same-stream mixed schedules are accepted");
    for (std::uint32_t frame = 0U; frame < total; ++frame) {
        gPartitionMaximumDifference = std::max(gPartitionMaximumDifference,
            static_cast<double>(std::max({std::fabs(audio64[frame].left - audio128[frame].left),
                                          std::fabs(audio64[frame].right - audio128[frame].right),
                                          std::fabs(audio128[frame].left - audio256[frame].left),
                                          std::fabs(audio128[frame].right - audio256[frame].right)})));
    }
    check(gPartitionMaximumDifference < 1.0e-6,
          "partition schedules preserve the Signalsmith continuous stream within tolerance");

    OctaveSignalsmithModelsFxProcessor gated(0x8831U);
    check(gated.prepare(makeSpec(), options), "gated duration processor prepares");
    constexpr std::uint32_t noteFrames = kSampleRate;
    constexpr std::uint32_t gatedTotal = 3U * kSampleRate;
    std::vector<StereoFrame> audio(gatedTotal);
    for (std::uint32_t frame = 0U; frame < noteFrames; ++frame) {
        const auto envelope = std::min(1.0, std::min(static_cast<double>(frame) / 512.0,
            static_cast<double>(noteFrames - frame) / 512.0));
        audio[frame] = {sine(220.0, frame, 0.48 * envelope),
                        sine(277.0, frame, 0.31 * envelope, 0.2)};
    }
    const std::vector<std::pair<std::uint64_t, OctaveSignalsmithEvent>> gatedEvents{
        {0U, event(0U, OctaveSignalsmithControl::Active, 1.0f)},
        {0U, event(0U, OctaveSignalsmithControl::Mix, 1.0f)},
        {0U, event(0U, OctaveSignalsmithControl::Mode,
                   static_cast<float>(OctaveSignalsmithMode::DownTwoOctaves))}};
    check(renderScheduled(gated, audio, {64U, 128U, 256U}, gatedEvents),
          "finite gate note and release tail render at equal input/output rates");
    constexpr std::uint32_t block = 256U;
    std::uint32_t firstActive = gatedTotal / block;
    std::uint32_t lastActive = 0U;
    for (std::uint32_t blockIndex = 0U; blockIndex < gatedTotal / block; ++blockIndex) {
        double energy = 0.0;
        for (std::uint32_t i = 0U; i < block; ++i) {
            const auto& sample = audio[blockIndex * block + i];
            energy += static_cast<double>(sample.left) * sample.left +
                      static_cast<double>(sample.right) * sample.right;
        }
        if (std::sqrt(energy / (2.0 * block)) > 0.01) {
            firstActive = std::min(firstActive, blockIndex);
            lastActive = blockIndex;
        }
    }
    gGatedFirstActiveFrame = firstActive * block;
    gGatedLastActiveFrame = (lastActive + 1U) * block;
    const auto observedDuration = (lastActive - firstActive + 1U) * block;
    gGatedDurationMs = 1000.0 * observedDuration / kSampleRate;
    check(firstActive * block < 8192U + 2U * options.blockSamples,
          "cold start remains inside the separately measured STFT transient window");
    check(std::abs(static_cast<std::int64_t>(observedDuration) - noteFrames) <=
              2LL * options.blockSamples,
          "downward transposition preserves gated event duration within two analysis windows");

    OctaveSignalsmithModelsFxProcessor noalloc(0x7731U);
    check(noalloc.prepare(makeSpec()), "no-allocation processor prepares");
    std::array<StereoFrame, 256U> blockData{};
    std::array<OctaveSignalsmithEvent, 64U> events{};
    for (std::uint32_t index = 0U; index < events.size(); ++index) {
        switch (index % 3U) {
        case 0U: events[index] = event(index * 4U, OctaveSignalsmithControl::Active,
                                       index & 1U ? 0.7f : 1.0f); break;
        case 1U: events[index] = event(index * 4U, OctaveSignalsmithControl::Mix,
                                       index & 1U ? 0.3f : 0.9f); break;
        default: events[index] = event(index * 4U, OctaveSignalsmithControl::Mode,
            static_cast<float>((index / 3U) % 3U)); break;
        }
    }
    const auto beforeAlloc = gAllocationCount.load(std::memory_order_relaxed);
    const auto beforeFree = gFreeCount.load(std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    bool accepted = true;
    std::uint64_t absolute = 0U;
    for (std::uint32_t callback = 0U; callback < 64U; ++callback) {
        for (std::uint32_t frame = 0U; frame < blockData.size(); ++frame) {
            const auto at = absolute + frame;
            blockData[frame] = {0.21f * sine(377.0, at, 1.0),
                                -0.17f * sine(619.0, at, 1.0)};
        }
        accepted = noalloc.processBlock(absolute, blockData.data(),
                                        static_cast<std::uint32_t>(blockData.size()),
                                        events.data(), static_cast<std::uint32_t>(events.size())) && accepted;
        absolute += blockData.size();
    }
    gWatchAllocations.store(false, std::memory_order_relaxed);
    gCallbackAllocations = gAllocationCount.load(std::memory_order_relaxed) - beforeAlloc;
    gCallbackFrees = gFreeCount.load(std::memory_order_relaxed) - beforeFree;
    check(accepted, "64 ordered per-block events remain inside the fixed callback limit");
    check(gCallbackAllocations == 0U && gCallbackFrees == 0U,
          "prepared Signalsmith OCTAVE callbacks allocate and free no memory");
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

int main(int argc, char** argv) {
    const std::string captureDirectory = argc > 2 && std::strcmp(argv[1], "--capture-dir") == 0
        ? argv[2] : std::string{};
    testOptionsAndTransactionalValidation();
    testTonesAndPublishedModes(captureDirectory);
    testImpulseAndCrossChannelIsolation(captureDirectory);
    testSampleOffsetModeEvent();
    testDurationPartitioningAndNoAllocation();
    testHighResolutionLowRegisterProbe(captureDirectory);

    std::printf(
        "{\"schemaVersion\":1,\"suite\":\"octave-signalsmith-models\","
        "\"sampleRate\":%u,\"fixedMixedPathSamples\":%u,"
        "\"adapterInputLatencySamples\":%d,\"adapterOutputLatencySamples\":%d,"
        "\"dryImpulseFirstSample\":%u,\"dryImpulsePeakSample\":%u,"
        "\"wetImpulseFirstSample\":%u,\"wetImpulsePeakSample\":%u,"
        "\"impulseCrossCorrelationPeakNormalized\":%.12g,"
        "\"impulseCrossCorrelationOffsetSamples\":%d,"
        "\"tones\":[",
        kSampleRate, gImpulseFixedDelay, gAdapterInputLatency, gAdapterOutputLatency,
        gDryImpulseFirst, gDryImpulsePeak, gWetImpulseFirst, gWetImpulsePeak,
        gImpulseCrossCorrelationPeak, gImpulseCrossCorrelationOffset);
    for (std::size_t i = 0U; i < gToneMetrics.size(); ++i) {
        const auto& m = gToneMetrics[i];
        if (i != 0U) std::printf(",");
        std::printf(
            "{\"inputHz\":%.6g,\"rightInputHz\":%.6g,"
            "\"oneLeftHz\":%.6g,\"oneRightHz\":%.6g,"
            "\"twoLeftHz\":%.6g,\"twoRightHz\":%.6g,"
            "\"oneLeftFrequencyErrorHz\":%.6g,\"oneRightFrequencyErrorHz\":%.6g,"
            "\"twoLeftFrequencyErrorHz\":%.6g,\"twoRightFrequencyErrorHz\":%.6g,"
            "\"oneLeftExactTargetAmplitude\":%.9g,\"oneRightExactTargetAmplitude\":%.9g,"
            "\"twoLeftExactTargetAmplitude\":%.9g,\"twoRightExactTargetAmplitude\":%.9g,"
            "\"oneLeftAmplitude\":%.9g,\"oneRightAmplitude\":%.9g,"
            "\"twoLeftAmplitude\":%.9g,\"twoRightAmplitude\":%.9g,"
            "\"dualMeasured\":%s,\"dualOneLeftHz\":%.6g,\"dualTwoLeftHz\":%.6g,"
            "\"dualOneRightHz\":%.6g,\"dualTwoRightHz\":%.6g,"
            "\"dualOneLeftAmplitude\":%.9g,\"dualTwoLeftAmplitude\":%.9g,"
            "\"dualOneRightAmplitude\":%.9g,\"dualTwoRightAmplitude\":%.9g}",
            m.inputHz, m.rightInputHz, m.oneLeftHz, m.oneRightHz,
            m.twoLeftHz, m.twoRightHz, m.oneLeftHz - m.inputHz / 2.0,
            m.oneRightHz - m.rightInputHz / 2.0,
            m.twoLeftHz - m.inputHz / 4.0, m.twoRightHz - m.rightInputHz / 4.0,
            m.oneLeftExactTargetAmplitude, m.oneRightExactTargetAmplitude,
            m.twoLeftExactTargetAmplitude, m.twoRightExactTargetAmplitude,
            m.oneLeftAmplitude, m.oneRightAmplitude,
            m.twoLeftAmplitude, m.twoRightAmplitude, m.dualMeasured ? "true" : "false",
            m.dualOneLeftHz, m.dualTwoLeftHz, m.dualOneRightHz, m.dualTwoRightHz,
            m.dualOneLeft, m.dualTwoLeft,
            m.dualOneRight, m.dualTwoRight);
    }
    std::printf(
        "],\"highResolution16384\":{\"blockSamples\":16384,\"intervalSamples\":2048,"
        "\"measureFirstFrame\":%u,\"measureFrames\":%u,"
        "\"leftPeakHz\":%.6g,\"leftZeroCrossingHz\":%.6g,"
        "\"leftExactTargetAmplitude\":%.9g,\"rightPeakHz\":%.6g,"
        "\"rightZeroCrossingHz\":%.6g,\"rightExactTargetAmplitude\":%.9g,"
        "\"inputLatencySamples\":%d,\"outputLatencySamples\":%d},"
        "\"leftOnlyLeakageRms\":%.12g,\"gatedFirstActiveFrame\":%u,"
        "\"gatedLastActiveFrameExclusive\":%u,\"gatedDurationMs\":%.6g,"
        "\"partitionMaximumDifference\":%.12g,\"callbackAllocations\":%llu,"
        "\"callbackFrees\":%llu,\"failures\":%u}\n",
        4U * kSampleRate, 2U * kSampleRate,
        gHighResolutionLeftPeakHz, gHighResolutionLeftZeroCrossingHz,
        gHighResolutionLeftExactTargetAmplitude, gHighResolutionRightPeakHz,
        gHighResolutionRightZeroCrossingHz, gHighResolutionRightExactTargetAmplitude,
        gHighResolutionInputLatency, gHighResolutionOutputLatency,
        gLeftOnlyLeakageRms, gGatedFirstActiveFrame, gGatedLastActiveFrame,
        gGatedDurationMs, gPartitionMaximumDifference,
        static_cast<unsigned long long>(gCallbackAllocations),
        static_cast<unsigned long long>(gCallbackFrees), gFailures);
    return gFailures == 0U ? 0 : 1;
}
