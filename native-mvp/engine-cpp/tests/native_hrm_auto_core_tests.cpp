#include "native_hrm_auto_core.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;

NativeHrmAutoCore::MidiEvent noteEvent(std::uint64_t frame, bool on, std::uint8_t note,
                                       std::uint8_t velocity = 100U, std::uint8_t channel = 0U) {
    return {frame, static_cast<std::uint8_t>((on ? 0x90U : 0x80U) | channel), note, velocity};
}

std::vector<float> makeTone(std::size_t frames, unsigned int channels, unsigned int sampleRate,
                            double frequency, float amplitude = 0.35f) {
    std::vector<float> result(frames * channels);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float sample = static_cast<float>(static_cast<double>(amplitude) * std::sin(
            2.0 * kPi * frequency * static_cast<double>(frame) / static_cast<double>(sampleRate)));
        for (unsigned int channel = 0U; channel < channels; ++channel) {
            result[frame * channels + channel] = sample;
        }
    }
    return result;
}

void processBlocks(NativeHrmAutoCore& core, std::vector<float>& audio, unsigned int channels,
                   const std::array<unsigned int, 7U>& blockSizes) {
    std::size_t offsetFrames = 0U;
    std::size_t blockIndex = 0U;
    const std::size_t totalFrames = audio.size() / channels;
    while (offsetFrames < totalFrames) {
        const unsigned int requested = blockSizes[blockIndex % blockSizes.size()];
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            requested, totalFrames - offsetFrames));
        assert(count > 0U);
        assert(core.processInterleaved(audio.data() + offsetFrames * channels, count, channels));
        offsetFrames += count;
        ++blockIndex;
    }
}

double powerAt(const std::vector<float>& mono, std::size_t begin, std::size_t end,
               unsigned int sampleRate, double frequency) {
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        const double phase = 2.0 * kPi * frequency * static_cast<double>(i) /
            static_cast<double>(sampleRate);
        real += static_cast<double>(mono[i]) * std::cos(phase);
        imaginary -= static_cast<double>(mono[i]) * std::sin(phase);
    }
    return real * real + imaginary * imaginary;
}

void testConfigurationAndQueueValidation() {
    NativeHrmAutoCore core;
    NativeHrmAutoCore::Config config{};
    assert(!core.prepare(NativeHrmAutoCore::Config{0U, 1U, 0U, NativeHrmAutoCore::Scale::Major, 1U, 100.0f}));
    assert(!core.prepare(NativeHrmAutoCore::Config{48000U, 3U, 0U, NativeHrmAutoCore::Scale::Major, 1U, 100.0f}));
    assert(!core.prepare(NativeHrmAutoCore::Config{48000U, 1U, 12U, NativeHrmAutoCore::Scale::Major, 1U, 100.0f}));
    assert(!core.prepare(NativeHrmAutoCore::Config{48000U, 1U, 0U,
        static_cast<NativeHrmAutoCore::Scale>(5U), 1U, 100.0f}));
    assert(!core.prepare(NativeHrmAutoCore::Config{48000U, 1U, 0U, NativeHrmAutoCore::Scale::Major, 0U, 100.0f}));
    assert(!core.prepare(NativeHrmAutoCore::Config{48000U, 1U, 0U, NativeHrmAutoCore::Scale::Major, 1U,
        std::numeric_limits<float>::infinity()}));

    config.sampleRate = 48000U;
    config.channels = 1U;
    config.key = 0U;
    config.scale = NativeHrmAutoCore::Scale::Major;
    config.midiChannel = 1U;
    config.mixPercent = 100.0f;
    assert(core.prepare(config));
    assert(core.prepared());
    assert(core.latencyFrames() == NativeHrmAutoCore::calculateLatencyFrames(48000U));
    assert(core.latencyFrames() == 1920U);
    assert(core.currentFrame() == 0U);
    assert(!core.enqueueMidi(noteEvent(0U, true, 60U, 100U, 1U))); // wrong MIDI channel
    assert(!core.enqueueMidi({0U, 0xf0U, 60U, 100U}));
    assert(!core.enqueueMidi({0U, 0x90U, 128U, 100U}));
    assert(!core.enqueueMidi({0U, 0x90U, 60U, 128U}));
    assert(!core.enqueueMidi(noteEvent(0U, true, 60U, 100U, 1U)));
    assert(core.rejectedEventCount() == 5U);
    assert(core.configure(NativeHrmAutoCore::Config{48000U, 1U, 2U,
        NativeHrmAutoCore::Scale::NaturalMinor, 1U, 0.0f}));
    assert(core.mixPercent() == 0.0f);
    assert(!core.configure(NativeHrmAutoCore::Config{48000U, 1U, 2U,
        NativeHrmAutoCore::Scale::NaturalMinor, 17U, 0.0f}));

    assert(core.enqueueMidi(noteEvent(100U, true, 60U)));
    assert(!core.enqueueMidi(noteEvent(99U, true, 61U)));
    assert(core.rejectedEventCount() == 6U);
    core.reset();
    for (std::uint64_t frame = 100U; frame < 100U + NativeHrmAutoCore::kMidiQueueCapacity; ++frame) {
        assert(core.enqueueMidi(noteEvent(frame, true, static_cast<std::uint8_t>(60U + frame % 12U))));
    }
    assert(!core.enqueueMidi(noteEvent(400U, true, 61U))); // queue is full
    assert(core.queueDepth() == NativeHrmAutoCore::kMidiQueueCapacity);
    assert(core.overflowCount() == 1U);
    assert(core.rejectedEventCount() == 0U);
    core.reset();
    assert(core.currentFrame() == 0U);
    assert(core.heldNoteCount() == 0U);
    assert(core.queueDepth() == 0U);
    assert(core.overflowCount() == 0U && core.rejectedEventCount() == 0U);
}

void testDryPathAndArbitraryBlocks() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate;
    NativeHrmAutoCore core;
    NativeHrmAutoCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.mixPercent = 100.0f;
    assert(core.prepare(config));
    auto audio = makeTone(frames, 1U, sampleRate, 440.0);
    processBlocks(core, audio, 1U, {{1U, 17U, 255U, 4096U, 43U, 7U, 513U}});
    assert(core.currentFrame() == frames);
    assert(!core.sourceVoiced() || core.sourceFrequencyHz() > 430.0f);
    assert(core.activeVoiceCount() == 0U); // without MIDI the wet harmony is off

    const std::size_t begin = static_cast<std::size_t>(core.latencyFrames()) + sampleRate / 3U;
    const std::size_t end = begin + sampleRate / 3U;
    const double sourcePower = powerAt(audio, begin, end, sampleRate, 440.0);
    const double competingPower = std::max(powerAt(audio, begin, end, sampleRate, 392.0),
                                           powerAt(audio, begin, end, sampleRate, 329.627556));
    assert(sourcePower > 1.0);
    assert(sourcePower > competingPower * 100.0);
    for (unsigned int frame = 0U; frame < core.latencyFrames(); ++frame) {
        assert(std::fabs(audio[frame]) < 1.0e-7f);
    }
    assert(std::fabs(audio[core.latencyFrames() + 1U] -
        static_cast<float>(0.35 * std::sin(2.0 * kPi * 440.0 / sampleRate))) < 1.0e-5f);
    for (float sample : audio) assert(std::isfinite(sample));
}

void testRootDiatonicTargetsAndSignalsmithVoices() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate;
    NativeHrmAutoCore core;
    NativeHrmAutoCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.key = 0U;
    config.scale = NativeHrmAutoCore::Scale::Major;
    config.midiChannel = 1U;
    config.mixPercent = 100.0f;
    assert(core.prepare(config));
    assert(core.enqueueMidi(noteEvent(0U, true, 60U))); // C root -> diatonic E/G
    auto audio = makeTone(frames, 1U, sampleRate, 440.0);
    processBlocks(core, audio, 1U, {{64U, 128U, 7U, 256U, 4096U, 37U, 511U}});
    assert(core.currentFrame() == frames);
    assert(core.heldNoteCount() == 1U);
    assert(core.sourceVoiced());
    assert(core.sourceFrequencyHz() > 430.0f && core.sourceFrequencyHz() < 450.0f);
    assert(core.activeVoiceCount() == 2U);
    assert(core.targetMidiNote(0U) == 64); // E4
    assert(core.targetMidiNote(1U) == 67); // G4
    assert(std::fabs(core.targetSemitones(0U) + 5.0f) < 0.15f);
    assert(std::fabs(core.targetSemitones(1U) + 2.0f) < 0.15f);

    const std::size_t begin = static_cast<std::size_t>(core.latencyFrames()) + sampleRate / 3U;
    const std::size_t end = begin + sampleRate / 3U;
    const double ePower = powerAt(audio, begin, end, sampleRate, 440.0 * std::pow(2.0, -5.0 / 12.0));
    const double gPower = powerAt(audio, begin, end, sampleRate, 440.0 * std::pow(2.0, -2.0 / 12.0));
    const double sourcePower = powerAt(audio, begin, end, sampleRate, 440.0);
    assert(ePower > 1.0);
    assert(gPower > 1.0);
    assert(ePower + gPower > sourcePower * 3.0);
}

void testChordAssignmentScaleSnappingAndEvents() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate * 3U / 4U;
    NativeHrmAutoCore core;
    NativeHrmAutoCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.key = 0U;
    config.scale = NativeHrmAutoCore::Scale::Major;
    config.midiChannel = 1U;
    config.mixPercent = 35.0f;
    assert(core.prepare(config));
    // A two-note chord selects its lowest notes; the source pitch is not removed.
    assert(core.enqueueMidi(noteEvent(0U, true, 67U)));
    assert(core.enqueueMidi(noteEvent(0U, true, 69U)));
    // Out-of-key F# is snapped to F (the lower of the two equally close notes).
    // Inspect while it is held, then release it later in the same arbitrary block.
    assert(core.enqueueMidi(noteEvent(12000U, true, 66U)));
    assert(core.enqueueMidi(noteEvent(24000U, false, 66U)));
    auto audio = makeTone(frames, 1U, sampleRate, 261.625565);
    assert(core.processInterleaved(audio.data(), 20000U, 1U));
    assert(core.heldNoteCount() == 3U);
    assert(core.activeVoiceCount() == 2U);
    assert(core.targetMidiNote(0U) == 65);
    assert(core.targetMidiNote(1U) == 55);
    std::size_t offsetFrames = 20000U;
    std::size_t blockIndex = 0U;
    const std::array<unsigned int, 7U> blockSizes{{511U, 3000U, 73U, 1U, 2048U, 125U, 8191U}};
    while (offsetFrames < frames) {
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            blockSizes[blockIndex % blockSizes.size()], frames - offsetFrames));
        assert(core.processInterleaved(audio.data() + offsetFrames, count, 1U));
        offsetFrames += count;
        ++blockIndex;
    }
    assert(core.currentFrame() == frames);
    assert(core.heldNoteCount() == 2U);
    assert(core.activeVoiceCount() == 2U);
    assert(core.targetMidiNote(0U) == 55); // G3 is closest to the C4 source
    assert(core.targetMidiNote(1U) == 57); // A3 is closest to the C4 source

    assert(core.enqueueMidi(noteEvent(frames, false, 67U)));
    std::array<float, 32U> tail{};
    assert(core.processInterleaved(tail.data(), 32U, 1U));
    assert(core.heldNoteCount() == 1U);
    assert(core.currentFrame() == frames + tail.size());
    assert(core.configure(NativeHrmAutoCore::Config{sampleRate, 1U, 2U,
        NativeHrmAutoCore::Scale::Dorian, 1U, 35.0f}));
    assert(core.heldNoteCount() == 1U);
    assert(core.activeVoiceCount() == 2U);
}

void testDiatonicIntervalMaps() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate / 4U;
    struct Case final {
        std::uint8_t key;
        NativeHrmAutoCore::Scale scale;
        std::uint8_t root;
        int expectedFirst;
        int expectedSecond;
    };
    constexpr std::array<Case, 5U> cases{{
        {0U, NativeHrmAutoCore::Scale::Major, 60U, 64, 67},
        {9U, NativeHrmAutoCore::Scale::NaturalMinor, 69U, 72, 64},
        {9U, NativeHrmAutoCore::Scale::HarmonicMinor, 69U, 72, 64},
        {2U, NativeHrmAutoCore::Scale::Dorian, 62U, 65, 69},
        {7U, NativeHrmAutoCore::Scale::Mixolydian, 67U, 71, 74},
    }};
    for (const Case& testCase : cases) {
        NativeHrmAutoCore core;
        NativeHrmAutoCore::Config config{};
        config.sampleRate = sampleRate;
        config.channels = 1U;
        config.key = testCase.key;
        config.scale = testCase.scale;
        config.mixPercent = 0.0f;
        assert(core.prepare(config));
        assert(core.enqueueMidi(noteEvent(0U, true, testCase.root)));
        auto audio = makeTone(frames, 1U, sampleRate, 440.0);
        processBlocks(core, audio, 1U, {{127U, 256U, 19U, 1024U, 61U, 3U, 2000U}});
        assert(core.sourceVoiced());
        assert(core.activeVoiceCount() == 2U);
        assert(core.targetMidiNote(0U) == testCase.expectedFirst);
        assert(core.targetMidiNote(1U) == testCase.expectedSecond);
    }
}

void testGlobalFrameSynchronization() {
    NativeHrmAutoCore core;
    NativeHrmAutoCore::Config config{};
    config.channels = 1U;
    assert(core.prepare(config));
    assert(core.enqueueMidi(noteEvent(10U, true, 60U)));
    assert(core.enqueueMidi(noteEvent(50U, false, 60U)));
    assert(core.enqueueMidi(noteEvent(100U, true, 64U)));
    assert(core.queueDepth() == 3U);
    assert(core.synchronizeFrame(100U));
    assert(core.currentFrame() == 100U);
    assert(core.heldNoteCount() == 0U); // note-on/off before selection are folded in
    assert(core.queueDepth() == 1U); // exact-boundary event is left for the next process block
    assert(core.lateEventCount() == 2U);
    assert(!core.synchronizeFrame(99U));
    assert(core.currentFrame() == 100U);
    assert(!core.enqueueMidi(noteEvent(99U, true, 64U)));
    assert(core.rejectedEventCount() == 1U);
    std::array<float, 8U> block{};
    assert(core.processInterleaved(block.data(), 1U, 1U));
    assert(core.currentFrame() == 101U);
    assert(core.heldNoteCount() == 1U);
    assert(core.queueDepth() == 0U);
    core.recordLateExternalSubmission();
    core.recordRejectedExternalSubmission();
    core.recordExternalQueueOverflow();
    assert(core.lateEventCount() == 3U);
    assert(core.rejectedEventCount() == 2U);
    assert(core.overflowCount() == 1U);
}

void testBoundedQueueAndNoAudioThreadAllocations() {
    constexpr unsigned int sampleRate = 48000U;
    NativeHrmAutoCore core;
    NativeHrmAutoCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 2U;
    config.mixPercent = 65.0f;
    assert(core.prepare(config));
    std::array<float, 512U * 2U> block{};
    for (std::size_t frame = 0U; frame < 512U; ++frame) {
        const float sample = static_cast<float>(0.3 * std::sin(2.0 * kPi * 220.0 *
            static_cast<double>(frame) / sampleRate));
        block[frame * 2U] = sample;
        block[frame * 2U + 1U] = sample;
    }

    webrc::native::test_alloc::beginTracking();
    const bool queued = core.enqueueMidi(noteEvent(0U, true, 60U));
    const bool processedA = core.processInterleaved(block.data(), 127U, 2U);
    const bool processedB = core.processInterleaved(block.data() + 127U * 2U, 385U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(queued && processedA && processedB);
    assert(webrc::native::test_alloc::count() == 0U);
    assert(core.currentFrame() == 512U);
    for (float sample : block) assert(std::isfinite(sample));
}

void testOfficialHarmonyControls() {
    constexpr unsigned int rate = 16000U;
    NativeHrmAutoCore core;
    NativeHrmAutoCore::Config config{};
    config.sampleRate = rate; config.channels = 2U; config.mixPercent = 100.0f;
    assert(core.prepare(config));
    assert(!core.setOfficialParameter("official_mode", 1.0f, true));
    assert(!core.setOfficialParameter("official_voice", 6.5f, true));
    assert(!core.setOfficialParameter("official_voice", 11.0f, true));
    assert(core.setOfficialParameter("official_voice", 6.0f, true));
    assert(core.setOfficialParameter("official_d_level", 0.0f, true));
    auto tone = makeTone(rate, 2U, rate, 220.0);
    processBlocks(core, tone, 2U, {{64U, 127U, 32U, 63U, 256U, 11U, 77U}});
    assert(core.activeVoiceCount() == 1U);
    assert(core.targetMidiNote(0U) == 60);
    assert(std::fabs(core.targetSemitones(0U) - 3.0f) < 0.12f);
    assert(core.setOfficialParameter("official_key", 2.0f, true));
    assert(core.targetMidiNote(0U) == 61);
    assert(core.setOfficialParameter("official_voice", 0.0f, true));
    assert(core.targetSemitones(0U) == -12.0f);
    assert(core.setOfficialParameter("official_voice", 1.0f, true));
    assert(core.targetSemitones(0U) == 12.0f);
    assert(core.setOfficialParameter("official_voice", 10.0f, true));
    assert(std::fabs(core.targetSemitones(0U) - 0.08f) < 0.001f);
    assert(core.setOfficialParameter("official_voice", 6.0f, true));
    assert(core.setOfficialParameter("official_pan", -50.0f, true));
    tone = makeTone(rate / 2U, 2U, rate, 220.0);
    processBlocks(core, tone, 2U, {{64U, 64U, 64U, 64U, 64U, 64U, 64U}});
    double left = 0.0, right = 0.0;
    for (unsigned int f = rate / 4U; f < rate / 2U; ++f) {
        left += tone[f * 2U] * tone[f * 2U]; right += tone[f * 2U + 1U] * tone[f * 2U + 1U];
    }
    assert(left > 0.01 && right < 1.0e-8);
    assert(core.setOfficialParameter("official_hrm_level", 0.0f, true));
    tone = makeTone(rate / 8U, 2U, rate, 220.0);
    processBlocks(core, tone, 2U, {{64U, 64U, 64U, 64U, 64U, 64U, 64U}});
    for (std::size_t i = 256U; i < tone.size(); ++i) assert(tone[i] == 0.0f);

    NativeHrmAutoCore automatic;
    assert(automatic.prepare(config));
    assert(automatic.setOfficialParameter("official_voice", 4.0f));
    assert(automatic.enqueueMidi(noteEvent(0U, true, 61U)));
    tone = makeTone(rate, 2U, rate, 220.0);
    processBlocks(automatic, tone, 2U, {{64U, 127U, 32U, 63U, 256U, 11U, 77U}});
    assert(automatic.targetMidiNote(0U) == 61); // AUTO follows C# MIDI.
    assert(automatic.setOfficialParameter("official_hrm_mode", 0.0f));
    assert(automatic.targetMidiNote(0U) == 59); // HYBRID C major fallback: B.
    std::array<float, 256U> block{};
    test_alloc::beginTracking();
    assert(automatic.setOfficialParameter("official_formant", 50.0f));
    assert(automatic.setOfficialParameter("official_pan", 50.0f));
    assert(automatic.processInterleaved(block.data(), 128U, 2U));
    test_alloc::endTracking();
    assert(test_alloc::count() == 0U);
}

} // namespace

int main() {
    testOfficialHarmonyControls();
    testConfigurationAndQueueValidation();
    testDryPathAndArbitraryBlocks();
    testRootDiatonicTargetsAndSignalsmithVoices();
    testChordAssignmentScaleSnappingAndEvents();
    testDiatonicIntervalMaps();
    testGlobalFrameSynchronization();
    testBoundedQueueAndNoAudioThreadAllocations();
    return 0;
}
