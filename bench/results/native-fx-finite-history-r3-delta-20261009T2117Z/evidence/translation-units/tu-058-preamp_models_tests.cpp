#include "webrc/dsp/preamp_models.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
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
void operator delete[](void* pointer) noexcept { operator delete(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { operator delete(pointer); }

namespace {

using namespace webrc::dsp;
constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kFrames = 24000U;
constexpr double kPi = 3.141592653589793238462643383279502884;
int gFailures = 0;
double gAmpHarmonicSpread = 0.0;
double gSpeakerRatioSpread = 0.0;
double gMicRatioSpread = 0.0;
double gMicPositionDifference = 0.0;
double gMicDistanceDifference = 0.0;
std::uint32_t gOnMicDirectDelay = 0U;
std::uint32_t gOffMicDirectDelay = 0U;
std::uint32_t gOnMicReflectionDelay = 0U;
std::uint32_t gOffMicReflectionDelay = 0U;
std::uint32_t gCallbackAllocations = 0U;
std::uint32_t gCallbackFrees = 0U;
std::uint32_t gLeftToRightLeakage = 0U;
std::uint32_t gColdWetOnset = 0U;
std::array<double, 9U> gAmpSignatures{};
std::array<double, 9U> gAmpSpectralRatios{};
std::array<double, 9U> gSpeakerSignatures{};
std::array<double, 5U> gMicSignatures{};
std::array<double, 11U> gMicPositionGain{};
std::array<std::uint32_t, 9U> gSpeakerIrFrameCounts{};
std::uint32_t gFixedMixedPathSamples = 0U;

bool check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++gFailures;
    }
    return condition;
}

constexpr ProcessSpec makeSpec(std::uint32_t block = 128U) {
    return {static_cast<float>(kSampleRate), block, 2U};
}

struct RenderResult {
    std::vector<StereoFrame> audio;
    PreampModelLatency latency{};
    bool ok = false;
};

RenderResult renderTone(const PreampModelOptions& options, float frequencyHz,
                        float amplitude, float drive,
                        std::uint32_t callbackFrames = 128U,
                        std::uint32_t frames = kFrames) {
    RenderResult result;
    result.audio.resize(frames);
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const auto phase = 2.0 * kPi * static_cast<double>(frequencyHz) * i / kSampleRate;
        const float sample = amplitude * static_cast<float>(std::sin(phase));
        result.audio[i] = {sample, sample};
    }
    PreampModelFxProcessor processor;
    if (!processor.prepare(makeSpec(callbackFrames), options)) return result;
    result.latency = processor.latency();
    const std::array<PreampFxEvent, 3U> events{{
        {0U, PreampFxControl::Active, 1.0f},
        {0U, PreampFxControl::Mix, 1.0f},
        {0U, PreampFxControl::Drive, drive},
    }};
    std::uint32_t start = 0U;
    while (start < frames) {
        const auto count = std::min(callbackFrames, frames - start);
        if (!processor.processBlock(start, result.audio.data() + start, count,
                start == 0U ? events.data() : nullptr, start == 0U
                    ? static_cast<std::uint32_t>(events.size()) : 0U)) return result;
        start += count;
    }
    result.ok = true;
    return result;
}

RenderResult renderAmpProbe(const PreampModelOptions& options) {
    constexpr std::uint32_t callbackFrames = 128U;
    RenderResult result;
    result.audio.resize(kFrames);
    for (std::uint32_t frame = 0U; frame < kFrames; ++frame) {
        const double time = static_cast<double>(frame) / kSampleRate;
        const float sample = 0.10f * static_cast<float>(
            std::sin(2.0 * kPi * 80.0 * time) + std::sin(2.0 * kPi * 6000.0 * time));
        result.audio[frame] = {sample, sample};
    }
    PreampModelFxProcessor processor;
    if (!processor.prepare(makeSpec(callbackFrames), options)) return result;
    result.latency = processor.latency();
    const std::array<PreampFxEvent, 3U> events{{
        {0U, PreampFxControl::Active, 1.0f},
        {0U, PreampFxControl::Mix, 1.0f},
        {0U, PreampFxControl::Drive, 0.1f},
    }};
    for (std::uint32_t start = 0U; start < kFrames; start += callbackFrames) {
        const auto count = std::min(callbackFrames, kFrames - start);
        if (!processor.processBlock(start, result.audio.data() + start, count,
                start == 0U ? events.data() : nullptr, start == 0U
                    ? static_cast<std::uint32_t>(events.size()) : 0U)) return result;
    }
    result.ok = true;
    return result;
}

double rms(const std::vector<StereoFrame>& audio, std::uint32_t first,
           std::uint32_t count, bool left = true) {
    double sum = 0.0;
    for (std::uint32_t i = 0U; i < count; ++i) {
        const double value = left ? audio[first + i].left : audio[first + i].right;
        sum += value * value;
    }
    return std::sqrt(sum / std::max<std::uint32_t>(1U, count));
}

double projection(const std::vector<StereoFrame>& audio, bool left,
                  std::uint32_t first, std::uint32_t count, double frequency) {
    double real = 0.0;
    double imag = 0.0;
    for (std::uint32_t i = 0U; i < count; ++i) {
        const double value = left ? audio[first + i].left : audio[first + i].right;
        const double phase = 2.0 * kPi * frequency * (first + i) / kSampleRate;
        real += value * std::cos(phase);
        imag -= value * std::sin(phase);
    }
    return 2.0 * std::sqrt(real * real + imag * imag) / count;
}

double harmonicRatio(const std::vector<StereoFrame>& audio, double fundamental,
                     std::uint32_t first = 12000U, std::uint32_t count = 12000U) {
    const double h1 = projection(audio, true, first, count, fundamental);
    const double h3 = projection(audio, true, first, count, fundamental * 3.0);
    const double h5 = projection(audio, true, first, count, fundamental * 5.0);
    return std::sqrt(h3 * h3 + h5 * h5) / std::max(h1, 1.0e-12);
}

void checkAmpModels() {
    for (std::uint8_t index = 0U; index < gAmpSignatures.size(); ++index) {
        PreampModelOptions options{};
        options.ampType = static_cast<PreampAmpModel>(index);
        options.speakerType = PreampSpeakerModel::Off;
        options.micType = PreampMicModel::Flat;
        options.micDistance = PreampMicDistance::OnMic;
        const auto rendered = renderTone(options, 384.0f, 0.58f, 24.0f);
        const auto spectralProbe = renderAmpProbe(options);
        check(rendered.ok, "every published amp selector prepares and renders");
        check(spectralProbe.ok, "every published amp selector renders a low/high probe");
        if (rendered.ok)
            gAmpSignatures[index] = harmonicRatio(rendered.audio, 384.0);
        if (spectralProbe.ok) {
            const double low = projection(spectralProbe.audio, true, 12000U, 12000U, 80.0);
            const double high = projection(spectralProbe.audio, true, 12000U, 12000U, 6000.0);
            gAmpSpectralRatios[index] = high / std::max(low, 1.0e-12);
        }
    }
    double minimumSeparation = std::numeric_limits<double>::infinity();
    double minimumSpectral = std::numeric_limits<double>::infinity();
    double maximumSpectral = 0.0;
    double maximum = 0.0;
    double minimum = std::numeric_limits<double>::infinity();
    for (std::size_t i = 0U; i < gAmpSignatures.size(); ++i) {
        minimum = std::min(minimum, gAmpSignatures[i]);
        maximum = std::max(maximum, gAmpSignatures[i]);
        minimumSpectral = std::min(minimumSpectral, gAmpSpectralRatios[i]);
        maximumSpectral = std::max(maximumSpectral, gAmpSpectralRatios[i]);
        for (std::size_t j = i + 1U; j < gAmpSignatures.size(); ++j)
            minimumSeparation = std::min(minimumSeparation,
                std::fabs(gAmpSignatures[i] - gAmpSignatures[j]));
    }
    gAmpHarmonicSpread = maximum - minimum;
    check(gAmpHarmonicSpread > 0.001,
          "amp selectors change normalized nonlinear harmonic content");
    check(minimumSeparation > 1.0e-5,
          "amp profiles are not all identical after removing output level");
    check(maximumSpectral - minimumSpectral > 0.3,
          "amp selectors change normalized low-to-high circuit response");
}

void checkSpeakerModels() {
    for (std::uint8_t index = 0U; index < gSpeakerSignatures.size(); ++index) {
        PreampModelOptions options{};
        options.ampType = PreampAmpModel::FullRange;
        options.speakerType = static_cast<PreampSpeakerModel>(index);
        options.micType = PreampMicModel::Flat;
        options.micDistance = PreampMicDistance::OnMic;
        const auto low = renderTone(options, 250.0f, 0.18f, 0.1f);
        const auto high = renderTone(options, 4100.0f, 0.18f, 0.1f);
        check(low.ok && high.ok, "every published speaker selector prepares and renders");
        if (low.ok) gSpeakerIrFrameCounts[index] = low.latency.generatedSpeakerIrFrames;
        if (low.ok && high.ok) {
            const double lowGain = projection(low.audio, true, 12000U, 12000U, 250.0) / 0.18;
            const double highGain = projection(high.audio, true, 12000U, 12000U, 4100.0) / 0.18;
            gSpeakerSignatures[index] = highGain / std::max(lowGain, 1.0e-12);
        }
    }
    double minimum = std::numeric_limits<double>::infinity();
    double maximum = 0.0;
    double minimumSeparation = std::numeric_limits<double>::infinity();
    for (std::size_t i = 0U; i < gSpeakerSignatures.size(); ++i) {
        minimum = std::min(minimum, gSpeakerSignatures[i]);
        maximum = std::max(maximum, gSpeakerSignatures[i]);
        for (std::size_t j = i + 1U; j < gSpeakerSignatures.size(); ++j)
            minimumSeparation = std::min(minimumSeparation,
                std::fabs(gSpeakerSignatures[i] - gSpeakerSignatures[j]));
    }
    gSpeakerRatioSpread = maximum - minimum;
    check(gSpeakerRatioSpread > 0.002,
          "speaker selectors alter frequency response, beyond a scalar level change");
    check(minimumSeparation > 1.0e-7,
          "speaker selector responses are not all identical");
}

void checkMicModelsAndPlacement() {
    for (std::uint8_t index = 0U; index < gMicSignatures.size(); ++index) {
        PreampModelOptions options{};
        options.ampType = PreampAmpModel::FullRange;
        options.speakerType = PreampSpeakerModel::Off;
        options.micType = static_cast<PreampMicModel>(index);
        options.micDistance = PreampMicDistance::OnMic;
        const auto low = renderTone(options, 220.0f, 0.16f, 0.1f);
        const auto high = renderTone(options, 6200.0f, 0.16f, 0.1f);
        check(low.ok && high.ok, "every published mic selector prepares and renders");
        if (low.ok && high.ok) {
            const double lowGain = projection(low.audio, true, 12000U, 12000U, 220.0) / 0.16;
            const double highGain = projection(high.audio, true, 12000U, 12000U, 6200.0) / 0.16;
            gMicSignatures[index] = highGain / std::max(lowGain, 1.0e-12);
        }
    }
    double minimum = std::numeric_limits<double>::infinity();
    double maximum = 0.0;
    for (const auto value : gMicSignatures) {
        minimum = std::min(minimum, value);
        maximum = std::max(maximum, value);
    }
    gMicRatioSpread = maximum - minimum;
    check(gMicRatioSpread > 0.02,
          "mic selectors alter normalized frequency response");

    PreampModelOptions centerOptions{};
    centerOptions.ampType = PreampAmpModel::FullRange;
    centerOptions.speakerType = PreampSpeakerModel::Off;
    centerOptions.micType = PreampMicModel::Flat;
    centerOptions.micDistance = PreampMicDistance::OnMic;
    centerOptions.micPositionCm = 0U;
    auto edgeOptions = centerOptions;
    edgeOptions.micPositionCm = 10U;
    const auto center = renderTone(centerOptions, 7000.0f, 0.2f, 0.1f);
    const auto edge = renderTone(edgeOptions, 7000.0f, 0.2f, 0.1f);
    for (std::uint8_t position = 0U; position <= 10U; ++position) {
        auto positionOptions = centerOptions;
        positionOptions.micPositionCm = position;
        const auto rendered = renderTone(positionOptions, 7000.0f, 0.2f, 0.1f);
        check(rendered.ok, "each printed mic position prepares and renders");
        if (rendered.ok)
            gMicPositionGain[position] = projection(rendered.audio, true,
                12000U, 12000U, 7000.0) / 0.2;
    }
    auto offMicOptions = centerOptions;
    offMicOptions.micType = PreampMicModel::Dyn57;
    offMicOptions.micDistance = PreampMicDistance::OffMic;
    const auto offMicTone = renderTone(offMicOptions, 1500.0f, 0.2f, 0.1f);
    auto onMicOptions = offMicOptions;
    onMicOptions.micDistance = PreampMicDistance::OnMic;
    const auto onMicTone = renderTone(onMicOptions, 1500.0f, 0.2f, 0.1f);
    check(center.ok && edge.ok, "CENTER and 10 cm mic positions prepare and render");
    if (center.ok && edge.ok) {
        double difference = 0.0;
        for (std::uint32_t i = 12000U; i < kFrames; ++i)
            difference = std::max(difference, std::fabs(
                static_cast<double>(center.audio[i].left) - edge.audio[i].left));
        gMicPositionDifference = difference;
    }
    check(gMicPositionDifference > 1.0e-4,
          "mic position changes a spectral filter rather than acting as an alias");
    bool allPositionsDistinctAndOrdered = true;
    for (std::size_t position = 1U; position < gMicPositionGain.size(); ++position) {
        if (!(gMicPositionGain[position] < gMicPositionGain[position - 1U] - 1.0e-6))
            allPositionsDistinctAndOrdered = false;
    }
    check(allPositionsDistinctAndOrdered,
          "CENTER and each centimetre selector has a distinct monotone local response");
    check(offMicTone.ok && onMicTone.ok,
          "OFF MIC and ON MIC retain the selected microphone model");
    if (offMicTone.ok && onMicTone.ok) {
        for (std::uint32_t i = 12000U; i < kFrames; ++i)
            gMicDistanceDifference = std::max(gMicDistanceDifference, std::fabs(
                static_cast<double>(offMicTone.audio[i].left) - onMicTone.audio[i].left));
    }
    check(gMicDistanceDifference > 1.0e-4,
          "OFF MIC changes mic distance response without disabling mic coloration");

    PreampModelOptions nearOptions = centerOptions;
    nearOptions.micType = PreampMicModel::Dyn57;
    nearOptions.micDistance = PreampMicDistance::OnMic;
    PreampModelFxProcessor nearProcessor;
    check(nearProcessor.prepare(makeSpec(), nearOptions), "ON MIC prepare succeeds");
    if (nearProcessor.prepared()) {
        gOnMicDirectDelay = nearProcessor.latency().micDirectDelaySamples;
        gOnMicReflectionDelay = nearProcessor.latency().micReflectionDelaySamples;
    }
    auto farOptions = nearOptions;
    farOptions.micDistance = PreampMicDistance::OffMic;
    PreampModelFxProcessor farProcessor;
    check(farProcessor.prepare(makeSpec(), farOptions), "OFF MIC prepare succeeds");
    if (farProcessor.prepared()) {
        gOffMicDirectDelay = farProcessor.latency().micDirectDelaySamples;
        gOffMicReflectionDelay = farProcessor.latency().micReflectionDelaySamples;
    }
    check(gOnMicDirectDelay > 0U && gOffMicDirectDelay > gOnMicDirectDelay,
          "OFF MIC is modeled as a more distant mic, not a mic-bypass switch");
}

void checkSpeakerIrAndLatency() {
    PreampModelOptions offOptions{};
    offOptions.speakerType = PreampSpeakerModel::Off;
    PreampModelFxProcessor off;
    check(off.prepare(makeSpec(), offOptions), "speaker OFF prepares");
    if (off.prepared()) {
        const auto latency = off.latency();
        gFixedMixedPathSamples = latency.fixedMixedPathSamples;
        check(latency.generatedSpeakerIrFrames == 1U,
              "speaker OFF uses a one-tap identity response");
        check(latency.speakerConvolverPartitionSamples == offOptions.cabinetPartitionFrames,
              "speaker OFF retains the declared shared convolver partition latency");
        check(latency.fixedMixedPathSamples >= latency.speakerConvolverPartitionSamples,
              "reported fixed mixed path includes partition and nonlinear alignment");
    }
    PreampModelOptions invalid{};
    invalid.micPositionCm = 11U;
    check(PreampModelFxProcessor::requiredPrepareBytes(makeSpec(), invalid) == 0U,
          "invalid mic position fails memory preflight");
    PreampModelFxProcessor invalidProcessor;
    check(!invalidProcessor.prepare(makeSpec(), invalid) && !invalidProcessor.prepared(),
          "invalid selector options leave a fresh instance unprepared");
    invalid = {};
    invalid.speakerType = static_cast<PreampSpeakerModel>(255U);
    check(PreampModelFxProcessor::requiredPrepareBytes(makeSpec(), invalid) == 0U,
          "invalid speaker enum fails memory preflight");
    const auto activeBytes = off.preparedBytes();
    invalid = {};
    check(PreampModelFxProcessor::replacementPeakBytes(activeBytes, makeSpec(), invalid) ==
              activeBytes + PreampModelFxProcessor::requiredPrepareBytes(makeSpec(), invalid),
          "replacement ledger includes the old active object and fresh candidate");
}

void checkSupportedSampleRates() {
    constexpr std::array<float, 3U> rates{24000.0f, 96000.0f, 192000.0f};
    for (const float rate : rates) {
        PreampModelOptions options{};
        options.ampType = PreampAmpModel::CoreMetal;
        options.speakerType = PreampSpeakerModel::EightByTwelve;
        options.micType = PreampMicModel::Dyn57;
        options.micDistance = PreampMicDistance::OffMic;
        PreampModelFxProcessor processor;
        const ProcessSpec spec{rate, 64U, 2U};
        check(PreampModelFxProcessor::requiredPrepareBytes(spec, options) > 0U,
              "supported sample rate has a bounded preparation estimate");
        check(processor.prepare(spec, options),
              "published selector choices prepare across supported sample rates");
    }
}

void checkStereoIsolationAndNoAllocation() {
    PreampModelOptions options{};
    options.speakerType = PreampSpeakerModel::FourByTwelve;
    options.micType = PreampMicModel::Cnd451;
    options.micDistance = PreampMicDistance::OffMic;
    PreampModelFxProcessor processor;
    check(processor.prepare(makeSpec(), options), "stereo isolation processor prepares");
    if (!processor.prepared()) return;

    std::array<StereoFrame, 128U> frames{};
    frames[0U].left = 0.7f;
    std::array<PreampFxEvent, 64U> events{};
    for (std::size_t index = 0U; index < events.size(); ++index) {
        events[index] = {0U,
            index % 2U == 0U ? PreampFxControl::Active : PreampFxControl::Mix,
            0.4f};
    }
    events[62U].value = 1.0f;
    events[63U].value = 1.0f;
    std::array<PreampFxEvent, 64U> variedEvents{};
    for (std::size_t index = 0U; index < variedEvents.size(); ++index) {
        auto& event = variedEvents[index];
        event.frameOffset = static_cast<std::uint32_t>(index * 2U);
        switch (index % 8U) {
        case 0U: event.control = PreampFxControl::Active; event.value = 1.0f; break;
        case 1U: event.control = PreampFxControl::Mix; event.value = 0.75f; break;
        case 2U: event.control = PreampFxControl::Drive;
                 event.value = 0.1f + static_cast<float>(index % 24U); break;
        case 3U: event.control = PreampFxControl::BassDb; event.value = -12.0f; break;
        case 4U: event.control = PreampFxControl::MidDb; event.value = 12.0f; break;
        case 5U: event.control = PreampFxControl::TrebleDb; event.value = -12.0f; break;
        case 6U: event.control = PreampFxControl::PresenceDb; event.value = 12.0f; break;
        default: event.control = PreampFxControl::OutputDb; event.value = -24.0f; break;
        }
    }
    gAllocations.store(0U, std::memory_order_relaxed);
    gFrees.store(0U, std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    bool ok = processor.processBlock(0U, frames.data(), 128U, events.data(),
                                     static_cast<std::uint32_t>(events.size()));
    for (const auto& frame : frames)
        if (std::fabs(frame.right) > 1.0e-12f) ++gLeftToRightLeakage;
    for (std::uint32_t block = 1U; block < 40U; ++block) {
        frames.fill({});
        ok = ok && processor.processBlock(static_cast<std::uint64_t>(block) * 128U,
            frames.data(), 128U, block == 1U ? variedEvents.data() : nullptr,
            block == 1U ? static_cast<std::uint32_t>(variedEvents.size()) : 0U);
        for (const auto& frame : frames)
            if (std::fabs(frame.right) > 1.0e-12f) ++gLeftToRightLeakage;
    }
    gWatchAllocations.store(false, std::memory_order_relaxed);
    gCallbackAllocations = static_cast<std::uint32_t>(
        gAllocations.load(std::memory_order_relaxed));
    gCallbackFrees = static_cast<std::uint32_t>(gFrees.load(std::memory_order_relaxed));
    check(ok, "stereo impulse processing succeeds");
    check(gLeftToRightLeakage == 0U,
          "left-only input has zero right-channel leakage through speaker and mic models");
    check(gCallbackAllocations == 0U && gCallbackFrees == 0U,
          "prepared processBlock performs zero allocations and frees");
}

void checkPartitionConsistencyAndFailureAtomicity() {
    PreampModelOptions options{};
    options.speakerType = PreampSpeakerModel::TwoByTwelve;
    options.micType = PreampMicModel::Dyn421;
    options.micDistance = PreampMicDistance::OnMic;
    const auto one = renderTone(options, 997.0f, 0.21f, 4.2f, 64U, 12288U);
    const auto two = renderTone(options, 997.0f, 0.21f, 4.2f, 128U, 12288U);
    check(one.ok && two.ok, "64- and 128-frame callback variants prepare and run");
    if (one.ok && two.ok) {
        double maximumDifference = 0.0;
        for (std::size_t i = 0U; i < one.audio.size(); ++i) {
            maximumDifference = std::max(maximumDifference, std::fabs(
                static_cast<double>(one.audio[i].left) - two.audio[i].left));
            maximumDifference = std::max(maximumDifference, std::fabs(
                static_cast<double>(one.audio[i].right) - two.audio[i].right));
        }
        check(maximumDifference < 2.0e-5,
              "selector output remains stable across callback partitioning");
    }

    PreampModelFxProcessor processor;
    check(processor.prepare(makeSpec(), options), "failure-atomicity processor prepares");
    if (!processor.prepared()) return;
    std::array<StereoFrame, 64U> block{};
    block.fill({0.1f, -0.2f});
    const auto original = block;
    const PreampFxEvent bad{12U, PreampFxControl::Drive, 1000.0f};
    check(!processor.processBlock(0U, block.data(), 64U, &bad, 1U),
          "invalid parameter event is rejected before processing");
    check(std::equal(block.begin(), block.end(), original.begin(), [](const auto& a, const auto& b) {
        return a.left == b.left && a.right == b.right;
    }), "invalid event preserves caller PCM");
    check(processor.processBlock(0U, block.data(), 64U),
          "rejected event does not advance processor frame or delay state");
}

void checkMicDistanceWetOutputAndColdOnset() {
    PreampModelOptions options{};
    options.ampType = PreampAmpModel::FullRange;
    options.speakerType = PreampSpeakerModel::Off;
    options.micType = PreampMicModel::Flat;
    options.micDistance = PreampMicDistance::OnMic;
    PreampModelFxProcessor processor;
    check(processor.prepare(makeSpec(), options), "cold-onset processor prepares");
    if (!processor.prepared()) return;
    std::vector<StereoFrame> impulse(1024U);
    impulse[0U] = {1.0f, 0.0f};
    const std::array<PreampFxEvent, 2U> events{{
        {0U, PreampFxControl::Active, 1.0f},
        {0U, PreampFxControl::Mix, 1.0f},
    }};
    bool processOk = true;
    for (std::uint32_t start = 0U; start < impulse.size(); start += 128U) {
        processOk = processOk && processor.processBlock(start, impulse.data() + start,
            128U, start == 0U ? events.data() : nullptr,
            start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U);
    }
    check(processOk, "cold impulse process succeeds");
    const float threshold = 1.0e-7f;
    for (std::uint32_t i = 0U; i < impulse.size(); ++i) {
        if (std::fabs(impulse[i].left) > threshold) {
            gColdWetOnset = i;
            break;
        }
    }
    const auto latency = processor.latency();
    check(gColdWetOnset > latency.micDirectDelaySamples,
          "cold wet onset includes a nonzero core response plus near-mic staging");
    check(gColdWetOnset <= latency.fixedMixedPathSamples +
          latency.micReflectionDelaySamples + 8U,
          "identity speaker/mic cold onset remains bounded by declared staged path");
}

} // namespace

int main() {
    check(PreampModelFxProcessor::effectOrdinal() == 23U,
          "PREAMP model adapter retains published ordinal");
    check(PreampModelFxProcessor::requiredPrepareBytes(makeSpec(), {}) > sizeof(
        PreampModelFxProcessor), "memory admission includes wrapper and processor storage");
    checkAmpModels();
    checkSpeakerModels();
    checkMicModelsAndPlacement();
    checkSpeakerIrAndLatency();
    checkSupportedSampleRates();
    checkStereoIsolationAndNoAllocation();
    checkPartitionConsistencyAndFailureAtomicity();
    checkMicDistanceWetOutputAndColdOnset();

    std::printf("{\"test\":\"preamp-models\",\"failures\":%d,"
        "\"ampHarmonicSpread\":%.12g,\"speakerFrequencyResponseSpread\":%.12g,"
        "\"micFrequencyResponseSpread\":%.12g,\"micPositionMaxDiff\":%.12g,"
        "\"micDistanceMaxDiff\":%.12g,"
        "\"onMicDirectDelaySamples\":%u,\"offMicDirectDelaySamples\":%u,"
        "\"onMicReflectionDelaySamples\":%u,\"offMicReflectionDelaySamples\":%u,"
        "\"coldWetOnsetFrame\":%u,\"fixedMixedPathSamples\":%u,"
        "\"callbackAllocations\":%u,"
        "\"callbackFrees\":%u,\"leftToRightLeakageSamples\":%u,"
        "\"ampHarmonicRatios\":[",
        gFailures, gAmpHarmonicSpread, gSpeakerRatioSpread, gMicRatioSpread,
        gMicPositionDifference, gMicDistanceDifference, gOnMicDirectDelay,
        gOffMicDirectDelay, gOnMicReflectionDelay, gOffMicReflectionDelay,
        gColdWetOnset,
        gFixedMixedPathSamples, gCallbackAllocations, gCallbackFrees,
        gLeftToRightLeakage);
    for (std::size_t index = 0U; index < gAmpSignatures.size(); ++index)
        std::printf("%s%.12g", index == 0U ? "" : ",", gAmpSignatures[index]);
    std::printf("],\"ampLowHighGainRatios\":[");
    for (std::size_t index = 0U; index < gAmpSpectralRatios.size(); ++index)
        std::printf("%s%.12g", index == 0U ? "" : ",", gAmpSpectralRatios[index]);
    std::printf("],\"speakerHighLowGainRatios\":[");
    for (std::size_t index = 0U; index < gSpeakerSignatures.size(); ++index)
        std::printf("%s%.12g", index == 0U ? "" : ",", gSpeakerSignatures[index]);
    std::printf("],\"speakerIrFrames\":[");
    for (std::size_t index = 0U; index < gSpeakerIrFrameCounts.size(); ++index)
        std::printf("%s%u", index == 0U ? "" : ",", gSpeakerIrFrameCounts[index]);
    std::printf("],\"micHighLowGainRatios\":[");
    for (std::size_t index = 0U; index < gMicSignatures.size(); ++index)
        std::printf("%s%.12g", index == 0U ? "" : ",", gMicSignatures[index]);
    std::printf("],\"micPositionGainRatios\":[");
    for (std::size_t index = 0U; index < gMicPositionGain.size(); ++index)
        std::printf("%s%.12g", index == 0U ? "" : ",", gMicPositionGain[index]);
    std::printf("]}\n");
    return gFailures == 0 ? 0 : 1;
}
