#include "native_rhythm_engine.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>

using namespace webrc::native;

namespace {
struct EventRecord {
    std::uint64_t frame = 0U;
    std::uint8_t instrument = 0U;
    float velocity = 0.0f;
    std::uint32_t seed = 0U;
};

struct TraceBuffer {
    std::array<EventRecord, 128U> events{};
    std::size_t count = 0U;
    bool overflow = false;
    std::uint8_t scenario = 0U;
    std::uint16_t pattern = 0U;
    NativeRhythmVariation variation = NativeRhythmVariation::A;
    NativeRhythmSection section = NativeRhythmSection::Main;
    std::uint8_t kit = 1U;
    unsigned int sampleRate = 0U;
    double bpm = 120.0;
    unsigned int bars = 1U;
    unsigned int blockSize = 0U;
    std::uint64_t startFrame = 0U;
};

void recordEvent(void* context, std::uint64_t frame, std::uint8_t instrument,
    float velocity, std::uint32_t seed) noexcept {
    auto& trace = *static_cast<TraceBuffer*>(context);
    if (trace.count == trace.events.size()) {
        trace.overflow = true;
        return;
    }
    trace.events[trace.count++] = {frame, instrument, velocity, seed};
}

std::uint64_t oneBarFrames(const NativeRhythmPatternMetadata& metadata, unsigned int sampleRate, double bpm) {
    const double frames = static_cast<double>(sampleRate) * 60.0 / bpm * metadata.meterNumerator *
        4.0 / metadata.meterDenominator;
    return static_cast<std::uint64_t>(std::floor(frames + 0.5));
}

const char* instrumentName(std::uint8_t instrument) {
    static constexpr const char* names[] = {
        "kick", "snare", "closedHat", "openHat", "tom", "ride", "clap", "brush",
    };
    return instrument < 8U ? names[instrument] : "invalid";
}

unsigned int variationIndex(NativeRhythmVariation variation) {
    return static_cast<unsigned int>(variation);
}

unsigned int sectionIndex(NativeRhythmSection section) {
    return static_cast<unsigned int>(section);
}

void emitTrace(const TraceBuffer& trace) {
    const auto* metadata = nativeRhythmPatternByIndex(trace.pattern);
    if (metadata == nullptr) return;
    const double span = static_cast<double>(trace.bars) * static_cast<double>(trace.sampleRate) * 60.0 /
        trace.bpm * static_cast<double>(metadata->meterNumerator) * 4.0 /
        static_cast<double>(metadata->meterDenominator);
    const auto endFrame = trace.startFrame + static_cast<std::uint64_t>(std::floor(span + 0.5));
    for (std::size_t i = 0U; i < trace.count; ++i) {
        const auto& event = trace.events[i];
        if (event.frame < trace.startFrame || event.frame >= endFrame) continue;
        std::printf("%u\t%u\t%u\t%u\t%u\t%.6f\t%u\t%u\t%u\t%llu\t%llu\t%s\t%.0f\t%u\n",
            static_cast<unsigned int>(trace.scenario), static_cast<unsigned int>(trace.pattern),
            variationIndex(trace.variation), sectionIndex(trace.section), static_cast<unsigned int>(trace.kit),
            trace.bpm, trace.sampleRate, trace.bars, trace.blockSize,
            static_cast<unsigned long long>(trace.startFrame),
            static_cast<unsigned long long>(event.frame), instrumentName(event.instrument),
            static_cast<double>(event.velocity), event.seed);
    }
}

bool traceOnePattern(std::uint8_t scenario, std::uint16_t index, NativeRhythmVariation variation,
    NativeRhythmSection section, std::uint8_t kit, unsigned int sampleRate, double bpm,
    unsigned int bars, unsigned int blockSize) {
    NativeRhythmEngine engine;
    if (!engine.prepare(sampleRate)) return false;
    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = bpm;
    config.patternIndex = index;
    config.kitIndex = kit;
    config.variation = variation;
    config.section = section;
    config.swingPercent = 50U;
    config.quantizeGrid = NativeRhythmQuantizeGrid::Sixteenth;
    if (!engine.setConfig(config, 0U)) return false;

    TraceBuffer trace;
    trace.scenario = scenario;
    trace.pattern = index;
    trace.variation = variation;
    trace.section = section;
    trace.kit = kit;
    trace.sampleRate = sampleRate;
    trace.bpm = bpm;
    trace.bars = bars;
    trace.blockSize = blockSize;
    trace.startFrame = 0U;
    engine.setEventTraceCallbackForTesting(recordEvent, &trace);
    std::array<float, 2048U> scratch{};
    std::uint64_t cursor = 0U;
    const double span = static_cast<double>(sampleRate) * 60.0 / bpm *
        static_cast<double>(engine.patternMetadata().meterNumerator) * 4.0 /
        static_cast<double>(engine.patternMetadata().meterDenominator) * static_cast<double>(bars);
    const auto end = static_cast<std::uint64_t>(std::floor(span + 0.5));
    while (cursor < end) {
        const auto frames = static_cast<unsigned int>(std::min<std::uint64_t>(blockSize, end - cursor));
        scratch.fill(0.0f);
        engine.processAdditive(scratch.data(), frames, 2U, cursor);
        cursor += frames;
    }
    if (trace.overflow) return false;

    emitTrace(trace);
    return true;
}

bool traceSectionAndTempoTransition(unsigned int blockSize) {
    constexpr unsigned int sampleRate = 44100U;
    constexpr std::uint16_t patternIndex = 155U;
    constexpr std::uint8_t kitIndex = 6U;
    constexpr double firstBpm = 127.3;
    constexpr double secondBpm = 139.7;
    NativeRhythmEngine engine;
    if (!engine.prepare(sampleRate)) return false;
    std::array<float, 2048U> scratch{};
    TraceBuffer trace;
    trace.scenario = 3U;
    trace.pattern = patternIndex;
    trace.variation = NativeRhythmVariation::B;
    trace.kit = kitIndex;
    trace.sampleRate = sampleRate;
    trace.bars = 1U;
    trace.blockSize = blockSize;
    engine.setEventTraceCallbackForTesting(recordEvent, &trace);

    auto renderSegment = [&](NativeRhythmSection section, double bpm, std::uint64_t startFrame) {
        NativeRhythmConfig config;
        config.enabled = true;
        config.bpm = bpm;
        config.patternIndex = patternIndex;
        config.kitIndex = kitIndex;
        config.variation = NativeRhythmVariation::B;
        config.section = section;
        config.swingPercent = 50U;
        config.quantizeGrid = NativeRhythmQuantizeGrid::Sixteenth;
        if (!engine.setConfig(config, startFrame)) return false;
        trace.section = section;
        trace.bpm = bpm;
        trace.startFrame = startFrame;
        trace.count = 0U;
        const auto endFrame = startFrame + oneBarFrames(engine.patternMetadata(), sampleRate, bpm);
        auto cursor = startFrame;
        while (cursor < endFrame) {
            const auto frames = static_cast<unsigned int>(std::min<std::uint64_t>(blockSize, endFrame - cursor));
            scratch.fill(0.0f);
            engine.processAdditive(scratch.data(), frames, 2U, cursor);
            cursor += frames;
        }
        if (trace.overflow) return false;
        emitTrace(trace);
        return true;
    };

    const auto firstBarFrames = oneBarFrames(*nativeRhythmPatternByIndex(patternIndex), sampleRate, firstBpm);
    return renderSegment(NativeRhythmSection::Intro, firstBpm, 0U) &&
        renderSegment(NativeRhythmSection::Fill, secondBpm, firstBarFrames);
}

bool traceMatrix() {
    // The primary matrix covers every one of the 240 metadata IDs with all four
    // variations and all four section settings on the same selected kit.
    for (std::uint16_t index = 1U; index <= 240U; ++index) {
        for (const auto variation : {NativeRhythmVariation::A, NativeRhythmVariation::B,
                 NativeRhythmVariation::C, NativeRhythmVariation::D}) {
            for (const auto section : {NativeRhythmSection::Main, NativeRhythmSection::Intro,
                     NativeRhythmSection::Ending, NativeRhythmSection::Fill}) {
                if (!traceOnePattern(0U, index, variation, section, 6U, 8000U, 300.0, 1U, 128U)) return false;
            }
        }
    }

    // Explicitly probe that METAL event decisions and seeds do not change with
    // the selected kit; this is the Browser contract (kit changes timbre only).
    for (const auto variation : {NativeRhythmVariation::A, NativeRhythmVariation::B,
             NativeRhythmVariation::C, NativeRhythmVariation::D}) {
        for (const auto section : {NativeRhythmSection::Main, NativeRhythmSection::Intro,
                 NativeRhythmSection::Ending, NativeRhythmSection::Fill}) {
            for (const auto kit : {1U, 6U, 16U}) {
                if (!traceOnePattern(1U, 155U, variation, section, static_cast<std::uint8_t>(kit), 8000U, 300.0, 1U, 128U)) return false;
            }
        }
    }

    // Fractional-tempo, odd-meter, multi-bar and variable-block cases exercise
    // absolute-frame retiming and the repeated intro/fill template boundaries.
    struct BoundaryCase {
        std::uint16_t pattern;
        NativeRhythmVariation variation;
        NativeRhythmSection section;
        unsigned int blockSize;
    };
    constexpr BoundaryCase boundaries[] = {
        {155U, NativeRhythmVariation::B, NativeRhythmSection::Intro, 13U},
        {155U, NativeRhythmVariation::B, NativeRhythmSection::Intro, 1024U},
        {155U, NativeRhythmVariation::D, NativeRhythmSection::Fill, 127U},
        {155U, NativeRhythmVariation::D, NativeRhythmSection::Fill, 1024U},
        {210U, NativeRhythmVariation::D, NativeRhythmSection::Fill, 64U},
        {210U, NativeRhythmVariation::D, NativeRhythmSection::Fill, 1024U},
        {12U, NativeRhythmVariation::B, NativeRhythmSection::Main, 13U},
        {12U, NativeRhythmVariation::B, NativeRhythmSection::Main, 1024U},
        {229U, NativeRhythmVariation::C, NativeRhythmSection::Ending, 127U},
        {229U, NativeRhythmVariation::C, NativeRhythmSection::Ending, 1024U},
        {22U, NativeRhythmVariation::D, NativeRhythmSection::Fill, 64U},
        {22U, NativeRhythmVariation::D, NativeRhythmSection::Fill, 1024U},
    };
    for (const auto& item : boundaries) {
        if (!traceOnePattern(2U, item.pattern, item.variation, item.section, 6U,
                44100U, 127.3, 2U, item.blockSize)) return false;
    }
    return traceSectionAndTempoTransition(13U) && traceSectionAndTempoTransition(1024U);
}
} // namespace

int main() {
    return traceMatrix() ? 0 : 2;
}
