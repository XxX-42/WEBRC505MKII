#include "native_rhythm_engine.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <new>
#include <string_view>

using namespace webrc::native;

namespace {
bool trackingAllocations = false;
std::size_t allocationCount = 0U;
}

void* operator new(std::size_t size) {
    if (trackingAllocations) ++allocationCount;
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (trackingAllocations) ++allocationCount;
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

namespace {

void testConfigValidationAndRoundTripNames() {
    NativeRhythmEngine engine;
    assert(!engine.prepare(0));
    assert(engine.prepare(48000));
    assert(!engine.enabled());

    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = 120.0;
    config.kitIndex = 1;
    assert(engine.setConfig(config, 0));
    assert(engine.enabled());

    config.kitIndex = 17;
    assert(!engine.setConfig(config, 0));
    config.kitIndex = 1;
    config.bpm = 301.0;
    assert(!engine.setConfig(config, 0));
    config.bpm = 120.0;
    config.patternIndex = 0U;
    assert(!engine.setConfig(config, 0U));
    config.patternIndex = 241U;
    assert(!engine.setConfig(config, 0U));
    config.patternIndex = 1U;

    NativeRhythmVariation variation = NativeRhythmVariation::A;
    NativeRhythmSection section = NativeRhythmSection::Main;
    NativeRhythmQuantizeGrid quantizeGrid = NativeRhythmQuantizeGrid::Sixteenth;
    assert(nativeRhythmVariationFromString("D", variation));
    assert(variation == NativeRhythmVariation::D);
    assert(nativeRhythmSectionFromString("fill", section));
    assert(section == NativeRhythmSection::Fill);
    assert(nativeRhythmQuantizeGridFromString("1/8", quantizeGrid));
    assert(quantizeGrid == NativeRhythmQuantizeGrid::Eighth);
    assert(std::string_view(nativeRhythmQuantizeGridToString(quantizeGrid)) == "1/8");
    assert(nativeRhythmQuantizeGridFromString("1/4", quantizeGrid));
    assert(quantizeGrid == NativeRhythmQuantizeGrid::Quarter);
    assert(!nativeRhythmQuantizeGridFromString("1/32", quantizeGrid));
    assert(!nativeRhythmVariationFromString("E", variation));
    assert(!nativeRhythmSectionFromString("factory", section));

    config.bpm = 39.99;
    assert(!engine.setConfig(config, 0U));
    config.bpm = 40.0;
    assert(engine.setConfig(config, 0U));
    config.swingPercent = 49U;
    assert(!engine.setConfig(config, 0U));
    config.swingPercent = 76U;
    assert(!engine.setConfig(config, 0U));
    config.swingPercent = 50U;
    config.volume = 101U;
    assert(!engine.setConfig(config, 0U));
    config.volume = 50U;
    config.quantizeGrid = static_cast<NativeRhythmQuantizeGrid>(99U);
    assert(!engine.setConfig(config, 0U));
}

void testEmptyDisabledRendererPassesThrough() {
    NativeRhythmEngine engine;
    assert(engine.prepare(48000));
    const std::array<float, 128> initial{{
        0.3f, -0.3f, 0.2f, -0.2f, 0.1f, -0.1f, 0.0f, 0.0f,
    }};
    std::array<float, 128> output = initial;
    engine.processAdditive(output.data(), 64, 2, 1000);
    for (std::size_t index = 0; index < output.size(); ++index) {
        assert(output[index] == initial[index]);
    }
    assert(engine.activeVoiceCount() == 0);
}

void testMetadataOnlyPatternCatalogIsStableAndComplete() {
    NativeRhythmEngine availabilityEngine;
    assert(availabilityEngine.prepare(8000U));
    assert(kNativeRhythmPatternCatalog.size() == 240U);
    for (std::size_t index = 0U; index < kNativeRhythmPatternCatalog.size(); ++index) {
        const auto& metadata = kNativeRhythmPatternCatalog[index];
        const auto expectedIndex = static_cast<std::uint16_t>(index + 1U);
        std::array<char, 11U> expectedId{};
        std::array<char, 8U> expectedBeat{};
        (void)std::snprintf(expectedId.data(), expectedId.size(), "rhythm-%03u", static_cast<unsigned int>(expectedIndex));
        (void)std::snprintf(expectedBeat.data(), expectedBeat.size(), "%u/%u",
            static_cast<unsigned int>(metadata.meterNumerator), static_cast<unsigned int>(metadata.meterDenominator));
        assert(metadata.globalIndex == expectedIndex);
        assert(metadata.id == expectedId.data());
        assert(!metadata.genre.empty() && !metadata.pattern.empty());
        assert(metadata.beat == expectedBeat.data());
        assert(metadata.variationCount == 4U);
        assert(metadata.sourceSectionSupport == "supported globally");
        assert(nativeRhythmPatternByIndex(expectedIndex) == &metadata);
        assert(nativeRhythmPatternById(metadata.id) == &metadata);
        assert(metadata.meterNumerator >= 2U && metadata.meterNumerator <= 15U);
        assert(metadata.meterDenominator == 4U || metadata.meterDenominator == 8U);
        assert(16U % metadata.meterDenominator == 0U);

        NativeRhythmConfig config;
        config.patternIndex = expectedIndex;
        for (unsigned int variation = 0U; variation < 4U; ++variation) {
            config.variation = static_cast<NativeRhythmVariation>(variation);
            const bool supported = variation + 1U <= metadata.variationCount;
            assert(availabilityEngine.setConfig(config, index) == supported);
        }
    }
    assert(nativeRhythmPatternByIndex(1U)->id == "rhythm-001");
    assert(nativeRhythmPatternByIndex(240U)->id == "rhythm-240");
    assert(nativeRhythmPatternByIndex(0U) == nullptr);
    assert(nativeRhythmPatternByIndex(241U) == nullptr);
    assert(nativeRhythmPatternById("rhythm-240")->genre == "USER");
    assert(nativeRhythmPatternById("rhythm-012")->beat == "3/4");
    assert(nativeRhythmPatternById("rhythm-229")->beat == "5/8");
    assert(nativeRhythmPatternById("rhythm-000") == nullptr);
    assert(nativeRhythmPatternById("rhythm-241") == nullptr);
    assert(nativeRhythmPatternById("rhythm-240")->sourceNote ==
        "User rhythm slot; official footnote says SMF patterns can be imported with RC-505mkII Rhythm Converter.");

    // Golden FNV-1a digest covers every row's one-based ID, labels, beat/meter,
    // variation count, source section note, and source note. It is derived from
    // Browser SOURCE_RHYTHM_ROWS and guards the native metadata projection.
    std::uint32_t digest = 0x811c9dc5U;
    const auto addByte = [&digest](std::uint8_t byte) {
        digest ^= byte;
        digest *= 0x01000193U;
    };
    const auto addText = [&addByte](std::string_view text) {
        for (const char character : text) addByte(static_cast<std::uint8_t>(character));
        addByte(0xffU);
    };
    for (const auto& metadata : kNativeRhythmPatternCatalog) {
        addByte(static_cast<std::uint8_t>(metadata.globalIndex & 0xffU));
        addByte(static_cast<std::uint8_t>((metadata.globalIndex >> 8U) & 0xffU));
        addText(metadata.id);
        addText(metadata.genre);
        addText(metadata.pattern);
        addText(metadata.beat);
        addByte(metadata.meterNumerator);
        addByte(metadata.meterDenominator);
        addByte(metadata.variationCount);
        addText(metadata.sourceSectionSupport);
        addText(metadata.sourceNote);
    }
    assert(digest == 0x45dfc074U);
}

void processUntil(NativeRhythmEngine& engine, std::uint64_t& cursor, std::uint64_t endFrame) {
    std::array<float, 2U * 127U> output{};
    unsigned int nextChunk = 13U;
    while (cursor < endFrame) {
        const auto remaining = endFrame - cursor;
        const auto frames = static_cast<unsigned int>(std::min<std::uint64_t>(remaining, nextChunk));
        output.fill(0.0f);
        engine.processAdditive(output.data(), frames, 2U, cursor);
        cursor += frames;
        nextChunk = nextChunk == 13U ? 127U : 13U;
    }
}

std::uint64_t expectedSixteenthFrame(
    std::uint64_t startFrame,
    std::uint64_t stepOrdinal,
    unsigned int sampleRate,
    double bpm
) {
    const double offset = static_cast<double>(stepOrdinal) * static_cast<double>(sampleRate) * 15.0 / bpm;
    return startFrame + static_cast<std::uint64_t>(std::floor(offset + 0.5));
}

void testMeterAwareSampleFrameScheduling() {
    constexpr unsigned int sampleRate = 44100U;
    constexpr double bpm = 127.3;
    constexpr std::uint64_t startFrame = 321U;
    NativeRhythmEngine engine;
    assert(engine.prepare(sampleRate));

    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = bpm;
    config.kitIndex = 16U;
    config.patternIndex = 12U; // 3/4: twelve sixteenth-grid steps per bar.
    config.variation = NativeRhythmVariation::B;
    config.section = NativeRhythmSection::Main;
    assert(engine.setConfig(config, startFrame));
    assert(engine.patternIndex() == 12U);
    assert(engine.patternMetadata().id == "rhythm-012");
    assert(engine.meterNumerator() == 3U && engine.meterDenominator() == 4U);
    assert(engine.stepsPerBeat() == 4U && engine.stepsPerBar() == 12U);
    assert(engine.nextScheduledStepFrame() == startFrame);

    std::uint64_t cursor = startFrame;
    for (std::uint64_t ordinal = 0U; ordinal < 24U; ++ordinal) {
        const auto expectedFrame = expectedSixteenthFrame(startFrame, ordinal, sampleRate, bpm);
        assert(engine.scheduledStepOrdinal() == ordinal);
        assert(engine.nextScheduledStepFrame() == expectedFrame);
        processUntil(engine, cursor, expectedFrame);
        assert(engine.scheduledStepOrdinal() == ordinal);
        std::array<float, 2U> onset{};
        engine.processAdditive(onset.data(), 1U, 2U, expectedFrame);
        cursor = expectedFrame + 1U;
        assert(engine.scheduledStepOrdinal() == ordinal + 1U);
        assert(engine.nextScheduledStepFrame() == expectedSixteenthFrame(startFrame, ordinal + 1U, sampleRate, bpm));
        assert(std::isfinite(onset[0]) && std::isfinite(onset[1]));
        if (ordinal == 0U || ordinal == 12U) {
            assert(std::fabs(onset[0]) + std::fabs(onset[1]) > 1.0e-6f);
        }
    }
    const auto secondBarFrame = expectedSixteenthFrame(startFrame, 24U, sampleRate, bpm);
    assert(engine.scheduledStepOrdinal() == 24U);
    assert(engine.nextScheduledStepFrame() == secondBarFrame);

    // Reconfigure at a non-zero absolute frame to an eighth-note meter. The
    // scheduler restarts at that frame and uses ten 16th-grid steps per bar.
    config.patternIndex = 229U; // 5/8
    config.section = NativeRhythmSection::Fill;
    const std::uint64_t changedAt = cursor;
    assert(engine.setConfig(config, changedAt));
    assert(engine.patternMetadata().id == "rhythm-229");
    assert(engine.meterNumerator() == 5U && engine.meterDenominator() == 8U);
    assert(engine.stepsPerBeat() == 2U && engine.stepsPerBar() == 10U);
    assert(engine.scheduledStepOrdinal() == 0U);
    assert(engine.nextScheduledStepFrame() == changedAt);

    cursor = changedAt;
    for (std::uint64_t ordinal = 0U; ordinal < 20U; ++ordinal) {
        const auto expectedFrame = expectedSixteenthFrame(changedAt, ordinal, sampleRate, bpm);
        assert(engine.scheduledStepOrdinal() == ordinal);
        assert(engine.nextScheduledStepFrame() == expectedFrame);
        processUntil(engine, cursor, expectedFrame);
        assert(engine.scheduledStepOrdinal() == ordinal);
        std::array<float, 2U> onset{};
        engine.processAdditive(onset.data(), 1U, 2U, expectedFrame);
        cursor = expectedFrame + 1U;
        assert(engine.scheduledStepOrdinal() == ordinal + 1U);
        assert(engine.nextScheduledStepFrame() == expectedSixteenthFrame(changedAt, ordinal + 1U, sampleRate, bpm));
        if (ordinal == 0U || ordinal == 10U) {
            assert(std::fabs(onset[0]) + std::fabs(onset[1]) > 1.0e-6f);
        }
    }
    const auto fifthEighthBarFrame = expectedSixteenthFrame(changedAt, 20U, sampleRate, bpm);
    assert(engine.scheduledStepOrdinal() == 20U);
    assert(engine.nextScheduledStepFrame() == fifthEighthBarFrame);

    // A config change to another pattern updates meter and resets active voices
    // and scheduling without changing the stable synthetic kit selection.
    config.patternIndex = 231U;
    config.kitIndex = 16U;
    config.variation = NativeRhythmVariation::D;
    config.section = NativeRhythmSection::Ending;
    config.enabled = false;
    const std::uint64_t disabledAt = cursor;
    assert(engine.setConfig(config, disabledAt));
    assert(!engine.enabled());
    assert(engine.patternIndex() == 231U);
    assert(engine.stepsPerBar() == 14U);
    assert(engine.activeVoiceCount() == 0U);
}

void testRhythmCallbackDoesNotAllocate() {
    NativeRhythmEngine engine;
    assert(engine.prepare(48000U));
    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = 109.7;
    config.kitIndex = 8U;
    config.patternIndex = 231U; // 7/8 metadata, 14 sixteenth-grid steps.
    config.variation = NativeRhythmVariation::D;
    config.section = NativeRhythmSection::Fill;
    assert(engine.setConfig(config, 0U));

    std::array<float, 128U> audio{};
    const std::size_t before = allocationCount;
    trackingAllocations = true;
    for (unsigned int block = 0U; block < 128U; ++block) {
        audio.fill(0.0f);
        engine.processAdditive(audio.data(), 64U, 2U, static_cast<std::uint64_t>(block) * 64U);
    }
    trackingAllocations = false;
    assert(allocationCount == before);
}

void renderFourFourBar(
    NativeRhythmEngine& engine,
    const NativeRhythmConfig& config,
    std::array<float, 32000U>& output
) {
    assert(engine.setConfig(config, 0U));
    output.fill(0.0f);
    engine.processAdditive(output.data(), 16000U, 2U, 0U);
    float peak = 0.0f;
    for (const float sample : output) {
        assert(std::isfinite(sample));
        peak = std::max(peak, std::fabs(sample));
    }
    assert(peak > 0.0f);
}

double totalDifference(const std::array<float, 32000U>& left, const std::array<float, 32000U>& right) {
    double difference = 0.0;
    for (std::size_t index = 0U; index < left.size(); ++index) {
        difference += std::fabs(static_cast<double>(left[index]) - right[index]);
    }
    return difference;
}

void testVariationsSectionsAndSixteenSyntheticKits() {
    constexpr unsigned int sampleRate = 8000U;
    NativeRhythmEngine engine;
    assert(engine.prepare(sampleRate));
    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = 120.0;
    config.kitIndex = 1U;
    config.patternIndex = 1U;

    std::array<float, 32000U> reference{};
    std::array<float, 32000U> candidate{};
    config.variation = NativeRhythmVariation::A;
    config.section = NativeRhythmSection::Main;
    renderFourFourBar(engine, config, reference);

    for (unsigned int variation = 1U; variation < 4U; ++variation) {
        config.variation = static_cast<NativeRhythmVariation>(variation);
        renderFourFourBar(engine, config, candidate);
        assert(totalDifference(reference, candidate) > 0.01);
    }

    config.variation = NativeRhythmVariation::A;
    for (unsigned int section = 1U; section < 4U; ++section) {
        config.section = static_cast<NativeRhythmSection>(section);
        renderFourFourBar(engine, config, candidate);
        assert(totalDifference(reference, candidate) > 0.01);
    }

    config.variation = NativeRhythmVariation::A;
    config.section = NativeRhythmSection::Main;
    for (std::uint8_t kitIndex = 1U; kitIndex <= 16U; ++kitIndex) {
        config.kitIndex = kitIndex;
        renderFourFourBar(engine, config, candidate);
        assert(engine.patternIndex() == 1U);
        if (kitIndex == 1U) {
            reference = candidate;
        } else {
            assert(totalDifference(reference, candidate) > 0.01);
        }
    }
}

void testSixteenKitProfilesRenderDeterministicallyInSixtyFourFrameBlocks() {
    constexpr unsigned int sampleRate = 8000;
    constexpr unsigned int frameCount = 16384;
    constexpr unsigned int channels = 2;
    NativeRhythmEngine wholeEngine;
    NativeRhythmEngine blockEngine;
    NativeRhythmEngine alternateEngine;
    assert(wholeEngine.prepare(sampleRate));
    assert(blockEngine.prepare(sampleRate));
    assert(alternateEngine.prepare(sampleRate));

    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = 127.2;
    config.kitIndex = 16;
    config.variation = NativeRhythmVariation::A;
    config.section = NativeRhythmSection::Main;
    assert(wholeEngine.setConfig(config, 2048));
    assert(blockEngine.setConfig(config, 2048));

    std::array<float, frameCount * channels> whole{};
    std::array<float, frameCount * channels> blocks{};
    wholeEngine.processAdditive(whole.data(), frameCount, channels, 2048);
    for (unsigned int offset = 0; offset < frameCount; offset += 64U) {
        blockEngine.processAdditive(
            blocks.data() + static_cast<std::size_t>(offset) * channels,
            64,
            channels,
            2048U + offset
        );
    }
    assert(whole == blocks);

    config.variation = NativeRhythmVariation::D;
    config.section = NativeRhythmSection::Fill;
    assert(alternateEngine.setConfig(config, 2048));
    std::array<float, frameCount * channels> alternate{};
    for (unsigned int offset = 0; offset < frameCount; offset += 64U) {
        alternateEngine.processAdditive(
            alternate.data() + static_cast<std::size_t>(offset) * channels,
            64,
            channels,
            2048U + offset
        );
    }

    bool variationChangedAudio = false;
    bool outputIsFinite = true;
    float maximumPeak = 0.0f;
    for (std::size_t index = 0; index < whole.size(); ++index) {
        variationChangedAudio = variationChangedAudio || std::fabs(whole[index] - alternate[index]) > 1.0e-6f;
        outputIsFinite = outputIsFinite && std::isfinite(whole[index]) && std::isfinite(alternate[index]);
        maximumPeak = std::max(maximumPeak, std::max(std::fabs(whole[index]), std::fabs(alternate[index])));
    }
    assert(variationChangedAudio);
    assert(outputIsFinite);
    assert(maximumPeak < 1.0f);
    assert(wholeEngine.activeVoiceCount() > 0);
    assert(alternateEngine.activeVoiceCount() > 0);
}

void testSwingUsesAbsoluteSampleFramesAndDelaysOffbeatOnsets() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr double bpm = 120.0;
    constexpr std::uint64_t baseOffbeatFrame = 12000U;
    constexpr std::uint64_t swungOffbeatFrame = 18000U;
    constexpr unsigned int frameCount = 24000U;
    NativeRhythmEngine straightEngine;
    NativeRhythmEngine swungEngine;
    assert(straightEngine.prepare(sampleRate));
    assert(swungEngine.prepare(sampleRate));

    NativeRhythmConfig straight;
    straight.enabled = true;
    straight.bpm = bpm;
    straight.kitIndex = 16U;
    straight.variation = NativeRhythmVariation::D;
    straight.patternIndex = 1U;
    straight.swingPercent = 50U;
    NativeRhythmConfig swung = straight;
    swung.swingPercent = 75U;
    assert(straightEngine.setConfig(straight, 0U));
    assert(swungEngine.setConfig(swung, 0U));

    std::array<float, frameCount * 2U> straightOutput{};
    std::array<float, frameCount * 2U> swungOutput{};
    straightEngine.processAdditive(straightOutput.data(), frameCount, 2U, 0U);
    swungEngine.processAdditive(swungOutput.data(), frameCount, 2U, 0U);

    double beforeOffbeatDifference = 0.0;
    double earlyOffbeatDifference = 0.0;
    for (std::size_t frame = 0U; frame < frameCount; ++frame) {
        const double difference = std::fabs(
            static_cast<double>(straightOutput[frame * 2U]) - static_cast<double>(swungOutput[frame * 2U])) +
            std::fabs(static_cast<double>(straightOutput[frame * 2U + 1U]) -
                static_cast<double>(swungOutput[frame * 2U + 1U]));
        if (frame < baseOffbeatFrame) beforeOffbeatDifference += difference;
        else if (frame < swungOffbeatFrame) earlyOffbeatDifference += difference;
    }
    assert(beforeOffbeatDifference == 0.0);
    assert(earlyOffbeatDifference > 1.0e-3);
    assert(swungEngine.scheduledStepOrdinal() == 4U);
}

void testQuantizeGridAndVolumeAreAppliedWithoutRealtimeAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    NativeRhythmEngine fineGrid;
    NativeRhythmEngine quarterGrid;
    NativeRhythmEngine fullVolume;
    NativeRhythmEngine halfVolume;
    assert(fineGrid.prepare(sampleRate));
    assert(quarterGrid.prepare(sampleRate));
    assert(fullVolume.prepare(sampleRate));
    assert(halfVolume.prepare(sampleRate));

    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = 120.0;
    config.kitIndex = 16U;
    config.variation = NativeRhythmVariation::D;
    config.patternIndex = 1U;
    config.volume = 100U;
    assert(fineGrid.setConfig(config, 0U));
    config.quantizeGrid = NativeRhythmQuantizeGrid::Quarter;
    assert(quarterGrid.setConfig(config, 0U));
    std::array<float, 2U * 6001U> fineOutput{};
    std::array<float, 2U * 6001U> quarterOutput{};
    fineGrid.processAdditive(fineOutput.data(), 6001U, 2U, 0U);
    quarterGrid.processAdditive(quarterOutput.data(), 6001U, 2U, 0U);
    // Nearest-grid quantization preserves source events: the quarter grid has
    // queued off-grid notes at their snapped frames instead of dropping them.
    assert(quarterGrid.activeVoiceCount() > fineGrid.activeVoiceCount());

    NativeRhythmConfig volumeConfig = config;
    volumeConfig.quantizeGrid = NativeRhythmQuantizeGrid::Sixteenth;
    volumeConfig.variation = NativeRhythmVariation::A;
    volumeConfig.volume = 100U;
    assert(fullVolume.setConfig(volumeConfig, 0U));
    volumeConfig.volume = 50U;
    assert(halfVolume.setConfig(volumeConfig, 0U));
    std::array<float, 2U * 256U> fullOutput{};
    std::array<float, 2U * 256U> halfOutput{};
    fullVolume.processAdditive(fullOutput.data(), 256U, 2U, 0U);
    halfVolume.processAdditive(halfOutput.data(), 256U, 2U, 0U);
    for (std::size_t index = 0U; index < fullOutput.size(); ++index) {
        assert(std::fabs(halfOutput[index] - fullOutput[index] * 0.5f) < 1.0e-7f);
    }

    NativeRhythmEngine liveVolume;
    assert(liveVolume.prepare(sampleRate));
    volumeConfig.volume = 100U;
    assert(liveVolume.setConfig(volumeConfig, 0U));
    std::array<float, 2U> firstFrame{};
    liveVolume.processAdditive(firstFrame.data(), 1U, 2U, 0U);
    assert(liveVolume.scheduledStepOrdinal() == 1U);
    const auto voicesBeforeVolumeChange = liveVolume.activeVoiceCount();
    volumeConfig.volume = 25U;
    assert(liveVolume.setConfig(volumeConfig, 1U));
    assert(liveVolume.scheduledStepOrdinal() == 1U);
    assert(liveVolume.activeVoiceCount() == voicesBeforeVolumeChange);
}

void testLegacyMetronomeCatalogIndexUsesCleanRoomKickSnareClicks() {
    NativeRhythmEngine metronome;
    NativeRhythmEngine ordinaryGuide;
    assert(metronome.prepare(48000U));
    assert(ordinaryGuide.prepare(48000U));
    NativeRhythmConfig config;
    config.enabled = true;
    config.patternIndex = 210U;
    assert(metronome.setConfig(config, 0U));
    config.patternIndex = 1U;
    assert(ordinaryGuide.setConfig(config, 0U));
    std::array<float, 2U> metronomeOnset{};
    std::array<float, 2U> ordinaryOnset{};
    metronome.processAdditive(metronomeOnset.data(), 1U, 2U, 0U);
    ordinaryGuide.processAdditive(ordinaryOnset.data(), 1U, 2U, 0U);
    assert(metronome.activeVoiceCount() == 1U);
    assert(ordinaryGuide.activeVoiceCount() == 2U);
}

} // namespace

int main() {
    testConfigValidationAndRoundTripNames();
    testMetadataOnlyPatternCatalogIsStableAndComplete();
    testEmptyDisabledRendererPassesThrough();
    testMeterAwareSampleFrameScheduling();
    testRhythmCallbackDoesNotAllocate();
    testVariationsSectionsAndSixteenSyntheticKits();
    testSixteenKitProfilesRenderDeterministicallyInSixtyFourFrameBlocks();
    testSwingUsesAbsoluteSampleFramesAndDelaysOffbeatOnsets();
    testQuantizeGridAndVolumeAreAppliedWithoutRealtimeAllocation();
    testLegacyMetronomeCatalogIndexUsesCleanRoomKickSnareClicks();
    return 0;
}
