#include "webrc/dsp/synthesis_pitch_fx.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <new>
#include <string>
#include <vector>

namespace {

bool gCountAllocations = false;
std::uint64_t gAllocations = 0U;
std::uint64_t gFrees = 0U;

struct TestState {
    int passed = 0;
    int failed = 0;
    void check(bool condition, const char* name) {
        if (condition) { ++passed; std::cout << "PASS " << name << '\n'; }
        else { ++failed; std::cout << "FAIL " << name << '\n'; }
    }
};

std::vector<webrc::dsp::StereoFrame> tone(std::uint32_t frames, float leftHz,
                                         float rightHz, float sampleRate,
                                         float amplitude = 0.35f) {
    std::vector<webrc::dsp::StereoFrame> result(frames);
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const double t = static_cast<double>(i) / sampleRate;
        result[i] = {amplitude * static_cast<float>(std::sin(2.0 * 3.141592653589793 * leftHz * t)),
                     amplitude * static_cast<float>(std::sin(2.0 * 3.141592653589793 * rightHz * t))};
    }
    return result;
}

float projection(const std::vector<webrc::dsp::StereoFrame>& audio, std::uint32_t first,
                 std::uint32_t last, float sampleRate, float frequency, bool right = false) {
    double real = 0.0;
    double imag = 0.0;
    for (std::uint32_t i = first; i < last; ++i) {
        const double phase = 2.0 * 3.141592653589793 * frequency * i / sampleRate;
        const double value = right ? audio[i].right : audio[i].left;
        real += value * std::cos(phase);
        imag -= value * std::sin(phase);
    }
    const auto count = std::max<std::uint32_t>(1U, last - first);
    return static_cast<float>(2.0 * std::sqrt(real * real + imag * imag) / count);
}

double rms(const std::vector<webrc::dsp::StereoFrame>& audio, std::uint32_t first,
           std::uint32_t last, bool right = false) {
    double energy = 0.0;
    for (std::uint32_t i = first; i < last; ++i) {
        const double value = right ? audio[i].right : audio[i].left;
        energy += value * value;
    }
    return std::sqrt(energy / std::max<std::uint32_t>(1U, last - first));
}

template <class Processor>
bool render(Processor& processor, std::vector<webrc::dsp::StereoFrame>& audio,
            std::uint32_t blockSize = 64U) {
    std::uint64_t frame = 0U;
    while (frame < audio.size()) {
        const auto count = static_cast<std::uint32_t>(std::min<std::uint64_t>(
            blockSize, static_cast<std::uint64_t>(audio.size()) - frame));
        if (!processor.processBlock(frame, audio.data() + frame, count)) return false;
        frame += count;
    }
    return true;
}

} // namespace

void* operator new(std::size_t size) {
    if (gCountAllocations) ++gAllocations;
    if (void* pointer = std::malloc(size)) return pointer;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (gCountAllocations) ++gAllocations;
    if (void* pointer = std::malloc(size)) return pointer;
    throw std::bad_alloc();
}
void operator delete(void* pointer) noexcept {
    if (gCountAllocations && pointer != nullptr) ++gFrees;
    std::free(pointer);
}
void operator delete[](void* pointer) noexcept {
    if (gCountAllocations && pointer != nullptr) ++gFrees;
    std::free(pointer);
}
void operator delete(void* pointer, std::size_t) noexcept { ::operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { ::operator delete[](pointer); }

int main() {
    using namespace webrc::dsp;
    TestState test;
    constexpr float sampleRate = 48000.0f;
    constexpr std::uint32_t frames = 48000U;
    constexpr std::uint32_t block = 64U;
    const ProcessSpec spec{sampleRate, 256U, 2U};

    test.check(SynthFxProcessor::requiredPrepareBytes(spec) > sizeof(SynthFxProcessor),
               "synth prepare memory accounts pitch-analysis path");
    auto synth = std::make_unique<SynthFxProcessor>();
    test.check(synth->prepare(spec, SynthFxOptions{50.0f, 35.0f, 45.0f, 100.0f}),
               "synth prepares clean-room oscillator and incremental pitch path");
    auto synthAudio = tone(frames, 220.0f, 330.0f, sampleRate);
    SynthFxEvent invalidSynthEvent{64U, SynthFxControl::Balance, 50.0f};
    const auto beforeInvalid = synthAudio.front();
    test.check(!synth->processBlock(0U, synthAudio.data(), block, &invalidSynthEvent, 1U) &&
               synthAudio.front().left == beforeInvalid.left,
               "synth rejects out-of-block event transactionally");
    test.check(render(*synth, synthAudio), "synth renders 220/330 Hz independent stereo inputs");
    test.check(projection(synthAudio, 36000U, frames, sampleRate, 220.0f) > 0.01f &&
               projection(synthAudio, 36000U, frames, sampleRate, 330.0f, true) > 0.01f,
               "synth follows independent left/right fundamentals");

    auto g2b = std::make_unique<GuitarToBassFxProcessor>();
    test.check(g2b->prepare(spec, GuitarToBassFxOptions{100.0f, GuitarToBassMode::PsolaBody}),
               "G2B prepares independent stereo PSOLA and divider paths");
    auto bassAudio = tone(frames, 220.0f, 330.0f, sampleRate);
    test.check(render(*g2b, bassAudio), "G2B renders independent stereo tracked input");
    test.check(projection(bassAudio, 36000U, frames, sampleRate, 110.0f) >
                   projection(bassAudio, 36000U, frames, sampleRate, 220.0f) * 1.5f &&
               projection(bassAudio, 36000U, frames, sampleRate, 165.0f, true) >
                   projection(bassAudio, 36000U, frames, sampleRate, 330.0f, true) * 1.5f,
               "G2B mode 2 resynthesizes true octave-down stereo fundamentals");
    auto dividerBass = std::make_unique<GuitarToBassFxProcessor>();
    test.check(dividerBass->prepare(spec,
               GuitarToBassFxOptions{100.0f, GuitarToBassMode::DividerBlend}),
               "G2B mode 1 prepares its divider-resynthesis path");
    auto dividerAudio = tone(frames, 220.0f, 330.0f, sampleRate);
    test.check(render(*dividerBass, dividerAudio), "G2B mode 1 renders its divider blend");
    double modeDifference = 0.0;
    for (std::uint32_t i = 24000U; i < frames; ++i) {
        const double delta = static_cast<double>(dividerAudio[i].left) - bassAudio[i].left;
        modeDifference += delta * delta;
    }
    modeDifference = std::sqrt(modeDifference / 24000.0);
    test.check(modeDifference > 0.02,
               "G2B modes produce distinct resynthesized audio, not aliases");

    auto riff = std::make_unique<AutoRiffFxProcessor>();
    AutoRiffFxOptions riffOptions{};
    riffOptions.tempoBpm = 120.0f;
    riffOptions.loop = true;
    riffOptions.balance = 100.0f;
    test.check(riff->prepare(spec, riffOptions), "AUTO RIFF prepares fixed-point phrase transport");
    std::array<std::array<std::int8_t, AutoRiffFxProcessor::kStepsPerPhrase>,
               AutoRiffFxProcessor::kPhraseCount> phraseTable{};
    for (std::uint8_t phrase = 1U; phrase <= AutoRiffFxProcessor::kPhraseCount; ++phrase)
        for (std::uint8_t step = 0U; step < AutoRiffFxProcessor::kStepsPerPhrase; ++step)
            phraseTable[phrase - 1U][step] = AutoRiffFxProcessor::phraseStep(phrase, step);
    std::uint32_t uniquePhrases = 0U;
    for (std::size_t i = 0U; i < phraseTable.size(); ++i) {
        bool unique = true;
        for (std::size_t j = 0U; j < i; ++j) unique = unique && phraseTable[i] != phraseTable[j];
        if (unique) ++uniquePhrases;
    }
    test.check(uniquePhrases == AutoRiffFxProcessor::kPhraseCount,
               "AUTO RIFF exposes 30 distinct authored eight-step phrase tables");
    auto riffAudio = tone(frames * 2U, 220.0f, 330.0f, sampleRate);
    test.check(render(*riff, riffAudio), "AUTO RIFF renders continuous detected-pitch phrase");
    const auto riffStepsAfterRender = riff->stepCount();
    test.check(riffStepsAfterRender == 8U && riff->stepIndex() == 7U,
               "AUTO RIFF advances eight eighth-note slots over its 2-second phrase at 120 BPM");
    const AutoRiffFxEvent phraseChange{31U, AutoRiffControl::Phrase, 2.0f};
    std::array<StereoFrame, block> riffControlAudio{};
    riffControlAudio.fill({0.1f, -0.1f});
    test.check(riff->processBlock(frames * 2U, riffControlAudio.data(), block,
                                  &phraseChange, 1U) && riff->stepCount() == 1U &&
               riff->stepIndex() == 0U && riff->selectedPhrase() == 2U,
               "AUTO RIFF phrase control starts a new phrase at its exact sample offset");
    AutoRiffFxEvent invalidTempo{0U, AutoRiffControl::TempoBpm, 301.0f};
    std::array<StereoFrame, 256U> unchanged{};
    unchanged.fill({0.125f, -0.25f});
    test.check(!riff->processBlock(frames * 2U + block, unchanged.data(), block,
                                   &invalidTempo, 1U) &&
               unchanged[0U].left == 0.125f && unchanged[0U].right == -0.25f,
               "AUTO RIFF rejects invalid tempo before changing PCM");

    auto harmony = std::make_unique<HarmonyAutoFxProcessor>();
    HarmonyAutoFxOptions harmonyOptions{};
    harmonyOptions.voice = HarmonyAutoVoice::High;
    harmonyOptions.mode = HarmonyAutoMode::Auto;
    harmonyOptions.key = 0U;
    harmonyOptions.dryLevel = 0.0f;
    harmonyOptions.harmonyLevel = 100.0f;
    test.check(harmony->prepare(spec, harmonyOptions), "HRM AUTO prepares key-aware stereo harmony");
    auto harmonyAudio = tone(frames, 220.0f, 0.0f, sampleRate);
    test.check(render(*harmony, harmonyAudio), "HRM AUTO renders independent mono/stereo pitch paths");
    test.check(projection(harmonyAudio, 36000U, frames, sampleRate, 261.6256f) > 0.025f &&
               rms(harmonyAudio, 36000U, frames, true) < 1.0e-5,
               "HRM AUTO selects a C-major diatonic third and keeps right-channel silence");
    auto midiTail = tone(24000U, 220.0f, 0.0f, sampleRate);
    const std::array<HarmonyAutoFxEvent, 2U> midiEvents{{
        {0U, HarmonyAutoControl::Mode, 60U, 1.0f},
        {0U, HarmonyAutoControl::MidiNoteOn, 69U, 1.0f}}};
    std::uint64_t midiFrame = frames;
    for (std::uint32_t position = 0U; position < midiTail.size();) {
        const auto count = std::min<std::uint32_t>(block,
            static_cast<std::uint32_t>(midiTail.size()) - position);
        const auto* scheduled = position == 0U ? midiEvents.data() : nullptr;
        const auto eventCount = position == 0U
            ? static_cast<std::uint32_t>(midiEvents.size()) : 0U;
        if (!harmony->processBlock(midiFrame, midiTail.data() + position, count,
                                   scheduled, eventCount)) break;
        midiFrame += count;
        position += count;
    }
    test.check(harmony->midiTargetActive() &&
               projection(midiTail, 12000U, 24000U, sampleRate, 440.0f) > 0.025f,
               "HRM AUTO hybrid accepts a sample-accurate MIDI target override");

    // Count only the actual callback body; buffers, processors and events are prepared above.
    std::array<StereoFrame, 256U> noAllocAudio{};
    for (std::uint32_t i = 0U; i < noAllocAudio.size(); ++i)
        noAllocAudio[i] = {0.2f * std::sin(static_cast<float>(2.0 * 3.141592653589793 * 220.0 * i / sampleRate)),
                           0.0f};
    gAllocations = gFrees = 0U;
    gCountAllocations = true;
    const bool synthOk = synth->processBlock(frames, noAllocAudio.data(), 64U);
    const bool g2bOk = g2b->processBlock(frames, noAllocAudio.data(), 128U);
    const bool riffOk = riff->processBlock(frames * 2U + block, noAllocAudio.data(), 256U);
    const bool harmonyOk = harmony->processBlock(frames + midiTail.size(),
                                                  noAllocAudio.data(), 64U);
    gCountAllocations = false;
    test.check(synthOk && g2bOk && riffOk && harmonyOk && gAllocations == 0U && gFrees == 0U,
               "all four processors perform callbacks without heap allocation or free");

    std::cout << "METRICS {\"synthLeft220Projection\":"
              << projection(synthAudio, 36000U, frames, sampleRate, 220.0f)
              << ",\"synthRight330Projection\":"
              << projection(synthAudio, 36000U, frames, sampleRate, 330.0f, true)
              << ",\"g2bLeft110Projection\":"
              << projection(bassAudio, 36000U, frames, sampleRate, 110.0f)
              << ",\"g2bLeft220Projection\":"
              << projection(bassAudio, 36000U, frames, sampleRate, 220.0f)
              << ",\"harmonyLeft261Projection\":"
              << projection(harmonyAudio, 36000U, frames, sampleRate, 261.6256f)
              << ",\"harmonyMidi440Projection\":"
              << projection(midiTail, 12000U, 24000U, sampleRate, 440.0f)
              << ",\"harmonyRightRms\":" << rms(harmonyAudio, 36000U, frames, true)
              << ",\"autoRiffStepsAfterRender\":" << riffStepsAfterRender
              << ",\"callbackAllocations\":" << gAllocations
              << ",\"callbackFrees\":" << gFrees << "}\n";
    std::cout << "SUMMARY {\"passed\":" << test.passed << ",\"failed\":"
              << test.failed << "}\n";
    return test.failed == 0 ? 0 : 1;
}
