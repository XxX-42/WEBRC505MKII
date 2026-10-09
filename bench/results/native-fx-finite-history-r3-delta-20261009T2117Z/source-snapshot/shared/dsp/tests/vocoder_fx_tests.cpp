#include "webrc/dsp/vocoder_fx.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>
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
void operator delete[](void* pointer) noexcept {
    if (pointer && gWatchAllocations.load(std::memory_order_relaxed))
        gFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}
void operator delete(void* pointer, std::size_t) noexcept { operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { operator delete(pointer); }

namespace {

using namespace webrc::dsp;
constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::uint32_t kRenderFrames = 32768U;
constexpr double kPi = 3.141592653589793238462643383279502884;
int gFailures = 0;
double gPartitionMaximumDifference = 0.0;
double gVocoderWetRms = 0.0;
double gMidiLowNoteRms = 0.0;
double gMidiHighNoteRms = 0.0;
std::uint32_t gCallbackAllocations = 0U;
std::uint32_t gCallbackFrees = 0U;

bool check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++gFailures;
    }
    return condition;
}

ProcessSpec makeSpec(std::uint32_t maxBlockFrames = 256U,
                     std::uint32_t channels = 2U,
                     float sampleRate = static_cast<float>(kSampleRate)) {
    return {sampleRate, maxBlockFrames, channels};
}

VocoderFxOptions optionsFor(VocoderFxKind kind) {
    VocoderFxOptions options{};
    options.kind = kind;
    options.bandCount = 16U;
    options.minimumBandHz = 80.0f;
    options.maximumBandHz = 10000.0f;
    options.bandQ = 1.25f;
    options.envelopeAttackMs = 5.0f;
    options.envelopeReleaseMs = 45.0f;
    options.oscillatorAttackMs = 3.0f;
    options.oscillatorReleaseMs = 24.0f;
    options.controlSmoothingMs = 5.0f;
    options.carrierStereoWidth = 0.35f;
    options.waveform = OscVocWaveform::Saw;
    return options;
}

StereoFrame modulator(std::uint32_t frame) {
    const double phase = static_cast<double>(frame) / kSampleRate;
    const float left = 0.18f * static_cast<float>(std::sin(2.0 * kPi * 197.0 * phase)) +
                       0.12f * static_cast<float>(std::sin(2.0 * kPi * 443.0 * phase + 0.23)) +
                       0.07f * static_cast<float>(std::sin(2.0 * kPi * 1103.0 * phase + 0.91)) +
                       0.035f * static_cast<float>(std::sin(2.0 * kPi * 4109.0 * phase));
    const float right = -0.16f * static_cast<float>(std::sin(2.0 * kPi * 239.0 * phase + 0.49)) +
                        0.11f * static_cast<float>(std::sin(2.0 * kPi * 617.0 * phase)) +
                        0.065f * static_cast<float>(std::sin(2.0 * kPi * 1709.0 * phase + 0.31)) -
                        0.03f * static_cast<float>(std::sin(2.0 * kPi * 5903.0 * phase));
    return {left, right};
}

std::vector<VocoderFxEvent> scheduleFor(VocoderFxKind kind) {
    std::vector<VocoderFxEvent> events{
        {0U, VocoderFxControl::Active, 0U, 1.0f},
        {0U, VocoderFxControl::Mix, 0U, 0.92f},
        {0U, VocoderFxControl::OutputDb, 0U, 0.0f},
        {5003U, VocoderFxControl::EnvelopeAttackMs, 0U, 7.0f},
        {13007U, VocoderFxControl::EnvelopeReleaseMs, 0U, 52.0f},
        {22019U, VocoderFxControl::Mix, 0U, 0.78f},
        {28001U, VocoderFxControl::Active, 0U, 0.0f},
    };
    if (kind == VocoderFxKind::OscVocMidi) {
        events.insert(events.begin() + 3,
            {0U, VocoderFxControl::MidiNoteOn, 48U, 0.86f});
        events.insert(events.begin() + 4,
            {4099U, VocoderFxControl::MidiNoteOn, 55U, 0.58f});
        events.insert(events.begin() + 5,
            {12001U, VocoderFxControl::MidiNoteOff, 48U, 0.0f});
        events.insert(events.begin() + 6,
            {17003U, VocoderFxControl::MidiNoteOn, 72U, 0.72f});
        events.insert(events.begin() + 10,
            {24011U, VocoderFxControl::MidiAllNotesOff, 0U, 0.0f});
    }
    std::stable_sort(events.begin(), events.end(), [](const auto& left, const auto& right) {
        return left.frameOffset < right.frameOffset;
    });
    return events;
}

struct RenderResult {
    std::vector<StereoFrame> audio;
    bool ok = false;
};

RenderResult render(VocoderFxKind kind, std::uint32_t callbackFrames,
                    std::uint32_t totalFrames = kRenderFrames) {
    RenderResult result;
    result.audio.resize(totalFrames);
    for (std::uint32_t frame = 0U; frame < totalFrames; ++frame)
        result.audio[frame] = modulator(frame);

    VocoderFxProcessor processor;
    const auto options = optionsFor(kind);
    if (!processor.prepare(makeSpec(), options)) return result;
    const auto events = scheduleFor(kind);
    std::size_t eventIndex = 0U;
    std::array<StereoFrame, 256U> carrierBlock{};
    for (std::uint32_t start = 0U; start < totalFrames;) {
        const auto frames = std::min(callbackFrames, totalFrames - start);
        std::array<VocoderFxEvent, VocoderFxProcessor::kMaximumControlEventsPerBlock> local{};
        std::uint32_t localCount = 0U;
        while (eventIndex < events.size() && events[eventIndex].frameOffset < start + frames) {
            local[localCount] = events[eventIndex];
            local[localCount++].frameOffset -= start;
            ++eventIndex;
        }
        for (std::uint32_t i = 0U; i < frames; ++i) {
            const double t = static_cast<double>(start + i) / kSampleRate;
            carrierBlock[i] = {
                0.45f * static_cast<float>(std::sin(2.0 * kPi * 219.0 * t)),
                0.38f * static_cast<float>(std::sin(2.0 * kPi * 331.0 * t + 0.31))};
        }
        const bool processed = kind == VocoderFxKind::Vocoder
            ? processor.processBlockWithCarrier(start, result.audio.data() + start,
                  carrierBlock.data(), frames,
                  localCount == 0U ? nullptr : local.data(), localCount)
            : processor.processBlock(start, result.audio.data() + start, frames,
                  localCount == 0U ? nullptr : local.data(), localCount);
        if (!processed) {
            std::fprintf(stderr, "render failed kind=%u block=%u frames=%u events=%u first=%u\n",
                         static_cast<unsigned>(kind), start, frames, localCount,
                         localCount == 0U ? 0U : local[0U].frameOffset);
            return result;
        }
        start += frames;
    }
    result.ok = eventIndex == events.size();
    return result;
}

double rms(const std::vector<StereoFrame>& audio, bool left,
           std::uint32_t begin, std::uint32_t frames) {
    double sum = 0.0;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const double sample = left ? audio[begin + i].left : audio[begin + i].right;
        sum += sample * sample;
    }
    return std::sqrt(sum / std::max<std::uint32_t>(1U, frames));
}

double rmsDifference(const std::vector<StereoFrame>& left,
                     const std::vector<StereoFrame>& right) {
    double sum = 0.0;
    for (std::size_t i = 0U; i < left.size(); ++i) {
        const double dl = static_cast<double>(left[i].left) - right[i].left;
        const double dr = static_cast<double>(left[i].right) - right[i].right;
        sum += dl * dl + dr * dr;
    }
    return std::sqrt(sum / std::max<std::size_t>(1U, 2U * left.size()));
}

double harmonicMagnitude(const std::vector<StereoFrame>& audio, bool left,
                         std::uint32_t start, std::uint32_t frames,
                         double frequencyHz, std::uint32_t sampleRate) {
    double real = 0.0;
    double imag = 0.0;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const double phase = 2.0 * kPi * frequencyHz * i / sampleRate;
        const double window = 0.5 - 0.5 * std::cos(
            2.0 * kPi * i / static_cast<double>(frames - 1U));
        const double sample = left ? audio[start + i].left : audio[start + i].right;
        real += sample * window * std::cos(phase);
        imag -= sample * window * std::sin(phase);
    }
    return std::sqrt(real * real + imag * imag);
}

std::array<double, 2U> harmonicFeatures(const std::vector<StereoFrame>& audio) {
    constexpr std::uint32_t start = 2048U;
    constexpr std::uint32_t frames = 4096U;
    constexpr double fundamentalHz = 220.0;
    const double fundamental = harmonicMagnitude(audio, true, start, frames,
                                                 fundamentalHz, kSampleRate);
    double allHarmonicsSquared = 0.0;
    double evenHarmonicsSquared = 0.0;
    for (std::uint32_t harmonic = 2U; harmonic <= 10U; ++harmonic) {
        const double magnitude = harmonicMagnitude(audio, true, start, frames,
            fundamentalHz * harmonic, kSampleRate);
        allHarmonicsSquared += magnitude * magnitude;
        if ((harmonic & 1U) == 0U) evenHarmonicsSquared += magnitude * magnitude;
    }
    const double denominator = std::max(1.0e-12, fundamental);
    return {std::sqrt(allHarmonicsSquared) / denominator,
            std::sqrt(evenHarmonicsSquared) / denominator};
}

std::vector<StereoFrame> renderOneMidiNote(std::uint8_t note) {
    constexpr std::uint32_t frames = 16384U;
    std::vector<StereoFrame> audio(frames);
    for (std::uint32_t frame = 0U; frame < frames; ++frame) audio[frame] = modulator(frame);
    VocoderFxProcessor processor;
    auto options = optionsFor(VocoderFxKind::OscVocMidi);
    if (!processor.prepare(makeSpec(), options)) return {};
    const std::array<VocoderFxEvent, 2U> events{ {
        {0U, VocoderFxControl::Active, 0U, 1.0f},
        {0U, VocoderFxControl::MidiNoteOn, note, 0.9f},
    } };
    if (!processor.processBlock(0U, audio.data(), 256U, events.data(),
                                static_cast<std::uint32_t>(events.size()))) return {};
    std::uint32_t start = 256U;
    while (start < frames) {
        const auto count = std::min<std::uint32_t>(256U, frames - start);
        if (!processor.processBlock(start, audio.data() + start, count)) return {};
        start += count;
    }
    return audio;
}

void testPreparationAndContracts() {
    auto fixedOptions = optionsFor(VocoderFxKind::Vocoder);
    auto midiOptions = optionsFor(VocoderFxKind::OscVocMidi);
    check(VocoderFxProcessor::effectOrdinal(VocoderFxKind::Vocoder) == 20U &&
          VocoderFxProcessor::effectOrdinal(VocoderFxKind::OscVocMidi) == 21U,
          "VOCODER and OSC VOC(M) expose catalog ordinals 20 and 21");
    check(VocoderFxProcessor::requiredPrepareBytes(makeSpec(), fixedOptions) ==
              sizeof(VocoderFxProcessor),
          "prepare memory admission exactly covers all inline fixed processor state");
    check(VocoderFxProcessor::requiredPrepareBytes(makeSpec(256U, 1U), fixedOptions) == 0U,
          "stereo processor rejects mono ProcessSpec before setup");
    auto invalid = midiOptions;
    invalid.bandCount = 3U;
    check(VocoderFxProcessor::requiredPrepareBytes(makeSpec(), invalid) == 0U,
          "prepare rejects fewer than four bands");
    invalid = midiOptions;
    invalid.maximumBandHz = 30000.0f;
    check(VocoderFxProcessor::requiredPrepareBytes(makeSpec(), invalid) == 0U,
          "prepare rejects a band edge at or above Nyquist guard");
    invalid = midiOptions;
    invalid.carrierStereoWidth = 1.1f;
    check(VocoderFxProcessor::requiredPrepareBytes(makeSpec(), invalid) == 0U,
          "prepare rejects non-finite or out-of-range stereo phase width");
    invalid = midiOptions;
    invalid.waveform = static_cast<OscVocWaveform>(99U);
    check(VocoderFxProcessor::requiredPrepareBytes(makeSpec(), invalid) == 0U,
          "prepare rejects invalid waveform enum values");

    VocoderFxProcessor fixed;
    VocoderFxProcessor midi;
    check(fixed.prepare(makeSpec(), fixedOptions) && fixed.activeVoices() == 0U,
          "VOCODER20 prepares without inventing a carrier or active oscillator voice");
    check(midi.prepare(makeSpec(), midiOptions) && midi.activeVoices() == 0U,
          "OSC VOC(M) begins silent until a MIDI note arrives");
    check(fixed.latency().fixedAlgorithmicSamples == 0 &&
          midi.latency().fixedAlgorithmicSamples == 0,
          "latency contract reports no whole-sample buffering and defers filter group delay");
}

void testInvalidEventsAreTransactional() {
    VocoderFxProcessor processor;
    check(processor.prepare(makeSpec(), optionsFor(VocoderFxKind::OscVocMidi)),
          "invalid-event fixture processor prepares");
    std::array<StereoFrame, 64U> audio{};
    for (std::size_t i = 0U; i < audio.size(); ++i)
        audio[i] = {0.1f + static_cast<float>(i) * 0.001f,
                    -0.2f + static_cast<float>(i) * 0.002f};
    const auto original = audio;
    const std::array<VocoderFxEvent, 1U> outside{ {{64U, VocoderFxControl::Active, 0U, 1.0f}} };
    check(!processor.processBlock(0U, audio.data(), 64U, outside.data(), 1U) &&
          std::equal(audio.begin(), audio.end(), original.begin(), [](const auto& a, const auto& b) {
              return a.left == b.left && a.right == b.right;
          }) && processor.activeVoices() == 0U,
          "out-of-block event rejects without touching audio or processor state");
    const std::array<VocoderFxEvent, 2U> simultaneousChord{ {
        {1U, VocoderFxControl::MidiNoteOn, 60U, 0.5f},
        {1U, VocoderFxControl::MidiNoteOn, 64U, 0.5f},
    } };
    check(processor.processBlock(0U, audio.data(), 64U,
                                 simultaneousChord.data(), 2U) &&
          processor.activeVoices() == 2U,
          "positive note-ons at one timestamp form a valid polyphonic chord");
    processor.reset(0U);
    audio = original;
    const std::array<VocoderFxEvent, 2U> unsorted{ {
        {3U, VocoderFxControl::Active, 0U, 1.0f},
        {2U, VocoderFxControl::MidiNoteOn, 60U, 0.5f},
    } };
    check(!processor.processBlock(0U, audio.data(), 64U, unsorted.data(), 2U) &&
          processor.activeVoices() == 0U,
          "unsorted event list rejects transactionally");
    const std::array<VocoderFxEvent, 1U> badVelocity{ {
        {3U, VocoderFxControl::MidiNoteOn, 60U, 1.01f},
    } };
    check(!processor.processBlock(0U, audio.data(), 64U, badVelocity.data(), 1U) &&
          processor.activeVoices() == 0U,
          "out-of-range normalized MIDI velocity rejects transactionally");
    const std::array<VocoderFxEvent, 1U> fixedMidi{ {
        {0U, VocoderFxControl::MidiNoteOn, 60U, 0.5f},
    } };
    auto fixed = VocoderFxProcessor{};
    std::array<StereoFrame, 64U> carrier{};
    check(fixed.prepare(makeSpec(), optionsFor(VocoderFxKind::Vocoder)) &&
          !fixed.processBlock(0U, audio.data(), 64U, fixedMidi.data(), 1U) &&
          !fixed.processBlockWithCarrier(0U, audio.data(), nullptr, 64U) &&
          !fixed.processBlockWithCarrier(0U, audio.data(), carrier.data(), 64U,
                                        fixedMidi.data(), 1U) &&
          fixed.activeVoices() == 0U,
          "VOCODER20 rejects missing carrier and MIDI events before touching prepared state");
}

void testSameFrameChordsAndRetirementAdmission() {
    const auto makeChord = [](std::uint32_t offset, std::uint8_t firstNote) {
        std::array<VocoderFxEvent, VocoderFxProcessor::kVoiceCount> result{};
        for (std::uint32_t voice = 0U; voice < result.size(); ++voice)
            result[voice] = {offset, VocoderFxControl::MidiNoteOn,
                             static_cast<std::uint8_t>(firstNote + voice),
                             0.72f - 0.025f * static_cast<float>(voice)};
        return result;
    };

    // Exercise a same-frame eight-note chord and an eight-note replacement
    // across short and ordinary callback durations. The replacement needs one
    // tail per displaced note and must not repeatedly steal notes just started
    // at the same sample.
    for (const std::uint32_t callbackFrames : {1U, 64U, 128U}) {
        VocoderFxProcessor processor;
        const auto options = optionsFor(VocoderFxKind::OscVocMidi);
        check(processor.prepare(makeSpec(256U), options),
              "chord-capacity processor prepares");
        std::array<StereoFrame, 128U> audio{};
        for (std::uint32_t i = 0U; i < callbackFrames; ++i) audio[i] = modulator(i);
        const auto chordA = makeChord(0U, 48U);
        check(processor.processBlock(0U, audio.data(), callbackFrames,
                                     chordA.data(), static_cast<std::uint32_t>(chordA.size())) &&
              processor.activeVoices() == VocoderFxProcessor::kVoiceCount,
              "eight same-offset note-ons create a full polyphonic chord");
        for (std::uint32_t i = 0U; i < callbackFrames; ++i)
            audio[i] = modulator(callbackFrames + i);
        const auto chordB = makeChord(callbackFrames - 1U, 60U);
        check(processor.processBlock(callbackFrames, audio.data(), callbackFrames,
                                     chordB.data(), static_cast<std::uint32_t>(chordB.size())) &&
              processor.activeVoices() == VocoderFxProcessor::kVoiceCount &&
              processor.retiredVoices() == VocoderFxProcessor::kVoiceCount &&
              processor.retiredVoiceOverflowCount() == 0U,
              "same-frame chord replacement keeps eight distinct attacks and eight retirement tails");
    }

    // Sixty-four events are eight complete chords. All eight displacements at
    // a timestamp are preflighted against the fixed tail pool before audio is
    // touched. A one-frame callback accepts the unsaturated initial burst;
    // 64/128-frame cases age and retire tails under the same exact schedule.
    for (const std::uint32_t callbackFrames : {1U, 64U, 128U}) {
        VocoderFxProcessor processor;
        check(processor.prepare(makeSpec(256U), optionsFor(VocoderFxKind::OscVocMidi)),
              "64-event burst processor prepares");
        std::array<StereoFrame, 128U> audio{};
        std::array<VocoderFxEvent, VocoderFxProcessor::kMaximumControlEventsPerBlock> burst{};
        for (std::uint32_t i = 0U; i < burst.size(); ++i) {
            const auto offset = callbackFrames == 1U ? 0U : i / 8U;
            burst[i] = {offset, VocoderFxControl::MidiNoteOn,
                        static_cast<std::uint8_t>(40U + (i % 48U)), 0.65f};
        }
        for (std::uint32_t i = 0U; i < callbackFrames; ++i) audio[i] = modulator(i);
        const auto allocationBefore = gAllocations.load(std::memory_order_relaxed);
        const auto freeBefore = gFrees.load(std::memory_order_relaxed);
        gWatchAllocations.store(true, std::memory_order_relaxed);
        const bool processed = processor.processBlock(0U, audio.data(), callbackFrames,
                                     burst.data(), static_cast<std::uint32_t>(burst.size()));
        gWatchAllocations.store(false, std::memory_order_relaxed);
        check(processed &&
              processor.activeVoices() == VocoderFxProcessor::kVoiceCount &&
              processor.retiredVoiceOverflowCount() == 0U,
              "64 ordered MIDI note events remain bounded for 1/64/128-frame blocks");
        check(gAllocations.load(std::memory_order_relaxed) == allocationBefore &&
              gFrees.load(std::memory_order_relaxed) == freeBefore,
              "64-event chord and steal path allocates and frees nothing");
    }

    // Begin with eight audible voices, then fill all 64 retired slots using
    // eight eight-note chord groups. The next replacement chord must reject
    // transactionally; after enough samples expire the oldest tails, it can be
    // accepted again.
    VocoderFxProcessor capacity;
    check(capacity.prepare(makeSpec(128U), optionsFor(VocoderFxKind::OscVocMidi)),
          "tail-capacity admission processor prepares");
    std::array<StereoFrame, 128U> block{};
    auto chord = makeChord(0U, 48U);
    check(capacity.processBlock(0U, block.data(), 1U, chord.data(), 8U),
          "tail-capacity fixture begins with an eight-note chord");
    std::array<VocoderFxEvent, 64U> fillTails{};
    for (std::uint32_t i = 0U; i < fillTails.size(); ++i)
        fillTails[i] = {i / 8U, VocoderFxControl::MidiNoteOn,
                        static_cast<std::uint8_t>(60U + (i % 48U)), 0.7f};
    check(capacity.processBlock(1U, block.data(), 8U, fillTails.data(), 64U) &&
          capacity.retiredVoices() == VocoderFxProcessor::kRetiredVoiceCount,
          "64-event chord burst fills every retirement slot without overflow");
    const auto rejectedAudio = block;
    const auto rejectedActive = capacity.activeVoices();
    const auto rejectedRetired = capacity.retiredVoices();
    const auto replacement = makeChord(0U, 72U);
    check(!capacity.processBlock(9U, block.data(), 1U, replacement.data(), 8U) &&
          std::equal(block.begin(), block.end(), rejectedAudio.begin(), [](const auto& a, const auto& b) {
              return a.left == b.left && a.right == b.right;
          }) && capacity.activeVoices() == rejectedActive &&
          capacity.retiredVoices() == rejectedRetired &&
          capacity.retiredVoiceOverflowCount() == 0U,
          "over-capacity simultaneous chord rejects before PCM, voices, or tail accounting changes");
    auto control = capacity;
    std::array<StereoFrame, 56U> delayedA{};
    std::array<StereoFrame, 56U> delayedB{};
    for (std::uint32_t i = 0U; i < delayedA.size(); ++i)
        delayedA[i] = delayedB[i] = modulator(9U + i);
    const bool advancedA = capacity.processBlock(9U, delayedA.data(), 56U);
    const bool advancedB = control.processBlock(9U, delayedB.data(), 56U);
    double advanceDifference = 0.0;
    for (std::size_t i = 0U; i < delayedA.size(); ++i) {
        advanceDifference = std::max(advanceDifference,
            std::fabs(static_cast<double>(delayedA[i].left) - delayedB[i].left));
        advanceDifference = std::max(advanceDifference,
            std::fabs(static_cast<double>(delayedA[i].right) - delayedB[i].right));
    }
    check(advancedA && advancedB && advanceDifference == 0.0,
          "rejected over-capacity block preserves exact render state versus control copy");
    for (std::uint32_t i = 0U; i < 64U; ++i) block[i] = modulator(65U + i);
    auto controlBlock = block;
    const bool replacedA = capacity.processBlock(65U, block.data(), 64U,
                                                  replacement.data(), 8U);
    const bool replacedB = control.processBlock(65U, controlBlock.data(), 64U,
                                                 replacement.data(), 8U);
    double replacementDifference = 0.0;
    for (std::uint32_t i = 0U; i < 64U; ++i) {
        replacementDifference = std::max(replacementDifference,
            std::fabs(static_cast<double>(block[i].left) - controlBlock[i].left));
        replacementDifference = std::max(replacementDifference,
            std::fabs(static_cast<double>(block[i].right) - controlBlock[i].right));
    }
    check(replacedA && replacedB && replacementDifference == 0.0 &&
          capacity.activeVoices() == 8U && capacity.retiredVoiceOverflowCount() == 0U,
          "replacement chord becomes admissible once old tails have expired");
}

void testPartitionsAndStereoAnalysis() {
    const auto vocoder64 = render(VocoderFxKind::Vocoder, 64U);
    const auto vocoder128 = render(VocoderFxKind::Vocoder, 128U);
    const auto vocoder256 = render(VocoderFxKind::Vocoder, 256U);
    const auto midi64 = render(VocoderFxKind::OscVocMidi, 64U);
    const auto midi128 = render(VocoderFxKind::OscVocMidi, 128U);
    const auto midi256 = render(VocoderFxKind::OscVocMidi, 256U);
    check(vocoder64.ok && vocoder128.ok && vocoder256.ok &&
          midi64.ok && midi128.ok && midi256.ok,
          "fixed and MIDI vocoder render under 64/128/256 frame partition schedules");
    if (!vocoder64.ok || !vocoder128.ok || !vocoder256.ok ||
        !midi64.ok || !midi128.ok || !midi256.ok) return;
    gPartitionMaximumDifference = std::max({
        rmsDifference(vocoder64.audio, vocoder128.audio),
        rmsDifference(vocoder64.audio, vocoder256.audio),
        rmsDifference(midi64.audio, midi128.audio),
        rmsDifference(midi64.audio, midi256.audio)});
    check(gPartitionMaximumDifference < 1.0e-7,
          "sample-accurate events and oscillator/vocoder state are partition invariant");
    gVocoderWetRms = rms(vocoder64.audio, true, 8192U, 8192U);
    check(gVocoderWetRms > 1.0e-4,
          "external-carrier vocoder produces measurable multiband voiced output");
    check(rms(midi64.audio, true, 8192U, 8192U) > 1.0e-4 &&
          rms(midi64.audio, false, 8192U, 8192U) > 1.0e-4,
          "MIDI oscillator vocoder retains real independent left and right output");

    // Equal positive input in both channels with zero phase spread is a useful
    // stereo invariant: a linked detector must not introduce a channel split.
    std::array<StereoFrame, 512U> equalInput{};
    std::array<StereoFrame, 512U> equalCarrier{};
    for (std::uint32_t frame = 0U; frame < equalInput.size(); ++frame) {
        const float sample = 0.25f * static_cast<float>(std::sin(
            2.0 * kPi * 431.0 * frame / kSampleRate));
        equalInput[frame] = {sample, sample};
        equalCarrier[frame] = {0.3f * sample, 0.3f * sample};
    }
    auto monoWidth = optionsFor(VocoderFxKind::Vocoder);
    monoWidth.carrierStereoWidth = 0.0f;
    VocoderFxProcessor equalProcessor;
    const std::array<VocoderFxEvent, 1U> activate{{
        {0U, VocoderFxControl::Active, 0U, 1.0f}}};
    check(equalProcessor.prepare(makeSpec(512U), monoWidth) &&
          equalProcessor.processBlockWithCarrier(0U, equalInput.data(), equalCarrier.data(),
              static_cast<std::uint32_t>(equalInput.size()), activate.data(), 1U),
          "identical stereo external modulator/carrier fixture processes");
    double channelDifference = 0.0;
    for (const auto& sample : equalInput)
        channelDifference = std::max(channelDifference,
            std::fabs(static_cast<double>(sample.left) - sample.right));
    check(channelDifference < 1.0e-6,
          "linked detector and zero phase spread preserve identical stereo inputs equally");
}

void testExternalCarrierAndOscillatorWaveforms() {
    constexpr std::uint32_t frames = 8192U;
    std::array<StereoFrame, frames> inputA{};
    std::array<StereoFrame, frames> inputB{};
    std::array<StereoFrame, frames> inputZero{};
    std::array<StereoFrame, frames> carrierA{};
    std::array<StereoFrame, frames> carrierB{};
    std::array<StereoFrame, frames> carrierZero{};
    for (std::uint32_t i = 0U; i < frames; ++i) {
        inputA[i] = inputB[i] = inputZero[i] = modulator(i);
        const double t = static_cast<double>(i) / kSampleRate;
        carrierA[i] = {0.45f * static_cast<float>(std::sin(2.0 * kPi * 220.0 * t)),
                       0.4f * static_cast<float>(std::sin(2.0 * kPi * 330.0 * t))};
        carrierB[i] = {0.45f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * t)),
                       0.4f * static_cast<float>(std::sin(2.0 * kPi * 660.0 * t))};
    }
    const std::array<VocoderFxEvent, 2U> enable{{
        {0U, VocoderFxControl::Active, 0U, 1.0f},
        {0U, VocoderFxControl::Mix, 0U, 1.0f}}};
    VocoderFxProcessor carrierProcessorA;
    VocoderFxProcessor carrierProcessorB;
    VocoderFxProcessor zeroProcessor;
    check(carrierProcessorA.prepare(makeSpec(frames), optionsFor(VocoderFxKind::Vocoder)) &&
          carrierProcessorB.prepare(makeSpec(frames), optionsFor(VocoderFxKind::Vocoder)) &&
          zeroProcessor.prepare(makeSpec(frames), optionsFor(VocoderFxKind::Vocoder)),
          "external-carrier routing processors prepare");
    check(carrierProcessorA.processBlockWithCarrier(0U, inputA.data(), carrierA.data(),
              frames, enable.data(), static_cast<std::uint32_t>(enable.size())) &&
          carrierProcessorB.processBlockWithCarrier(0U, inputB.data(), carrierB.data(),
              frames, enable.data(), static_cast<std::uint32_t>(enable.size())) &&
          zeroProcessor.processBlockWithCarrier(0U, inputZero.data(), carrierZero.data(),
              frames, enable.data(), static_cast<std::uint32_t>(enable.size())),
          "external stereo carrier routes process without hidden internal oscillators");
    double replacementDifference = 0.0;
    double leftWet = 0.0;
    double rightWet = 0.0;
    double zeroWet = 0.0;
    for (std::uint32_t i = 4096U; i < frames; ++i) {
        replacementDifference += std::pow(static_cast<double>(inputA[i].left - inputB[i].left), 2.0) +
                                 std::pow(static_cast<double>(inputA[i].right - inputB[i].right), 2.0);
        leftWet += static_cast<double>(inputA[i].left) * inputA[i].left;
        rightWet += static_cast<double>(inputA[i].right) * inputA[i].right;
        zeroWet += static_cast<double>(inputZero[i].left) * inputZero[i].left +
                    static_cast<double>(inputZero[i].right) * inputZero[i].right;
    }
    check(replacementDifference > 1.0,
          "replacing the external carrier frequency materially changes voiced PCM");
    check(leftWet > 1.0e-3 && rightWet > 1.0e-3,
          "external carrier renders independent nonzero left and right channels");
    check(zeroWet < 1.0e-8,
          "zero external carrier produces silence after the wet path settles");

    std::array<std::vector<StereoFrame>, 5U> waveformRenders{};
    constexpr std::array<OscVocWaveform, 5U> waveforms{{
        OscVocWaveform::Saw, OscVocWaveform::Vintage, OscVocWaveform::Detune,
        OscVocWaveform::Square, OscVocWaveform::Rect}};
    for (std::size_t wi = 0U; wi < waveforms.size(); ++wi) {
        waveformRenders[wi].resize(8192U);
        std::uint32_t noiseState = 0x4f1bbcdcU;
        for (std::uint32_t i = 0U; i < waveformRenders[wi].size(); ++i) {
            noiseState = noiseState * 1664525U + 1013904223U;
            const float left = (static_cast<float>(noiseState >> 8U) / 16777215.0f - 0.5f) * 0.6f;
            noiseState = noiseState * 1664525U + 1013904223U;
            const float right = (static_cast<float>(noiseState >> 8U) / 16777215.0f - 0.5f) * 0.6f;
            waveformRenders[wi][i] = {left, right};
        }
        VocoderFxProcessor oscillator;
        auto options = optionsFor(VocoderFxKind::OscVocMidi);
        options.waveform = waveforms[wi];
        check(oscillator.prepare(makeSpec(8192U), options),
              "OSC VOC(M) selected oscillator waveform prepares");
        const std::array<VocoderFxEvent, 2U> note{{
            {0U, VocoderFxControl::Active, 0U, 1.0f},
            {0U, VocoderFxControl::MidiNoteOn, 57U, 0.9f}}};
        check(oscillator.processBlock(0U, waveformRenders[wi].data(), 8192U,
              note.data(), static_cast<std::uint32_t>(note.size())),
              "each OSC VOC(M) waveform produces a bounded stereo block");
    }
    for (std::size_t a = 0U; a < waveforms.size(); ++a) {
        for (std::size_t b = a + 1U; b < waveforms.size(); ++b) {
            check(rmsDifference(waveformRenders[a], waveformRenders[b]) > 1.0e-5,
                  "all five OSC VOC(M) carrier choices produce measurably distinct PCM");
        }
    }
    std::array<std::array<double, 2U>, 5U> shapeFeatures{};
    for (std::size_t wi = 0U; wi < waveformRenders.size(); ++wi)
        shapeFeatures[wi] = harmonicFeatures(waveformRenders[wi]);
    std::fprintf(stderr,
        "OSC VOC harmonic ratios saw/vintage/detune/square/rect = "
        "%.4f/%.4f %.4f/%.4f %.4f/%.4f %.4f/%.4f %.4f/%.4f\n",
        shapeFeatures[0][0], shapeFeatures[0][1], shapeFeatures[1][0], shapeFeatures[1][1],
        shapeFeatures[2][0], shapeFeatures[2][1], shapeFeatures[3][0], shapeFeatures[3][1],
        shapeFeatures[4][0], shapeFeatures[4][1]);
    check(shapeFeatures[1][0] < shapeFeatures[0][0] * 0.92,
          "Vintage is a saw-derived waveform with measurably lower upper-harmonic energy");
    check(shapeFeatures[3][1] < 0.03 && shapeFeatures[4][1] > 0.10 &&
          shapeFeatures[4][1] > 20.0 * shapeFeatures[3][1],
          "Rect has even-harmonic pulse energy distinct from 50-percent Square");

    std::array<StereoFrame, 1024U> switched{};
    for (std::uint32_t i = 0U; i < switched.size(); ++i) switched[i] = modulator(i);
    VocoderFxProcessor automated;
    check(automated.prepare(makeSpec(1024U), optionsFor(VocoderFxKind::OscVocMidi)),
          "waveform automation processor prepares");
    const std::array<VocoderFxEvent, 2U> waveformChange{{
        {0U, VocoderFxControl::MidiNoteOn, 60U, 0.9f},
        {512U, VocoderFxControl::Waveform, 0U,
         static_cast<float>(OscVocWaveform::Rect)}}};
    check(automated.processBlock(0U, switched.data(), 1024U,
              waveformChange.data(), static_cast<std::uint32_t>(waveformChange.size())) &&
          std::all_of(switched.begin(), switched.end(), [](const StereoFrame& frame) {
              return std::isfinite(frame.left) && std::isfinite(frame.right);
          }),
          "sample-accurate waveform changes crossfade over a fixed 64-sample window");
}

void testMidiPitchAndRelease() {
    const auto low = renderOneMidiNote(48U);
    const auto high = renderOneMidiNote(72U);
    check(low.size() == 16384U && high.size() == 16384U,
          "independent MIDI note fixtures render");
    if (low.size() != 16384U || high.size() != 16384U) return;
    gMidiLowNoteRms = rms(low, true, 8192U, 4096U);
    gMidiHighNoteRms = rms(high, true, 8192U, 4096U);
    check(gMidiLowNoteRms > 1.0e-4 && gMidiHighNoteRms > 1.0e-4,
          "MIDI notes create sustained modulated oscillator output");
    check(rmsDifference(low, high) > 5.0e-4,
          "note 48 and note 72 materially change vocoder carrier spectrum");

    VocoderFxProcessor processor;
    auto options = optionsFor(VocoderFxKind::OscVocMidi);
    check(processor.prepare(makeSpec(), options), "release processor prepares");
    std::array<StereoFrame, 64U> block{};
    for (std::uint32_t i = 0U; i < block.size(); ++i) block[i] = modulator(i);
    const std::array<VocoderFxEvent, 1U> on{{
        {0U, VocoderFxControl::MidiNoteOn, 60U, 1.0f}}};
    check(processor.processBlock(0U, block.data(), 64U, on.data(), 1U) &&
          processor.activeVoices() == 1U,
          "note-on allocates one bounded active voice");
    for (std::uint32_t i = 0U; i < block.size(); ++i) block[i] = modulator(64U + i);
    const std::array<VocoderFxEvent, 1U> zeroVelocityOff{{
        {0U, VocoderFxControl::MidiNoteOn, 60U, 0.0f}}};
    check(processor.processBlock(64U, block.data(), 64U,
              zeroVelocityOff.data(), 1U) && processor.activeVoices() == 1U,
          "zero-velocity note-on enters a smooth note-off release");
    std::uint64_t start = 128U;
    for (; start < 48000U; start += 64U) {
        for (std::uint32_t i = 0U; i < block.size(); ++i)
            block[i] = modulator(static_cast<std::uint32_t>(start) + i);
        if (!processor.processBlock(start, block.data(), 64U)) break;
    }
    check(start >= 48000U && processor.activeVoices() == 0U,
          "released MIDI voice naturally returns to idle without truncating its envelope");
}

void testMaximumEventBurstsAndNoAllocations() {
    VocoderFxProcessor processor;
    auto options = optionsFor(VocoderFxKind::OscVocMidi);
    check(processor.prepare(makeSpec(256U), options), "bounded MIDI burst processor prepares");
    std::array<StereoFrame, 256U> audio{};
    std::array<VocoderFxEvent, VocoderFxProcessor::kMaximumControlEventsPerBlock> events{};
    for (std::uint32_t i = 0U; i < events.size(); ++i) {
        events[i] = {i, VocoderFxControl::MidiNoteOn,
                     static_cast<std::uint8_t>(36U + (i % 48U)),
                     0.45f + 0.005f * static_cast<float>(i % 40U)};
        audio[i] = modulator(i);
    }
    const auto allocationsBefore = gAllocations.load(std::memory_order_relaxed);
    const auto freesBefore = gFrees.load(std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    bool processed = processor.processBlock(0U, audio.data(), 64U,
                                             events.data(), 64U);
    for (std::uint32_t blockIndex = 1U; processed && blockIndex < 4U; ++blockIndex) {
        for (std::uint32_t i = 0U; i < events.size(); ++i) {
            events[i] = {i, VocoderFxControl::MidiNoteOn,
                         static_cast<std::uint8_t>(48U + ((i + blockIndex) % 40U)),
                         0.75f};
            audio[i] = modulator(blockIndex * 64U + i);
        }
        if (!processor.processBlock(blockIndex * 64U, audio.data(), 64U,
                                    events.data(), 64U)) {
            processed = false;
            break;
        }
    }
    gWatchAllocations.store(false, std::memory_order_relaxed);
    gCallbackAllocations = static_cast<std::uint32_t>(
        gAllocations.load(std::memory_order_relaxed) - allocationsBefore);
    gCallbackFrees = static_cast<std::uint32_t>(
        gFrees.load(std::memory_order_relaxed) - freesBefore);
    check(processed, "64 ordered note events in one block process without dropping the call");
    check(processor.activeVoices() == VocoderFxProcessor::kVoiceCount,
          "polyphony remains within the fixed eight-voice pool under dense note-ons");
    check(processor.retiredVoices() > 0U && processor.retiredVoiceOverflowCount() == 0U,
          "voice stealing retains short crossfaded tails within the fixed retirement pool");
    check(gCallbackAllocations == 0U && gCallbackFrees == 0U,
          "ordinary and 64-event MIDI callback paths allocate and free nothing");
}

} // namespace

int main() {
    testPreparationAndContracts();
    testInvalidEventsAreTransactional();
    testSameFrameChordsAndRetirementAdmission();
    testPartitionsAndStereoAnalysis();
    testExternalCarrierAndOscillatorWaveforms();
    testMidiPitchAndRelease();
    testMaximumEventBurstsAndNoAllocations();

    std::printf("{\"schemaVersion\":1,\"suite\":\"vocoder-fx\","
                "\"sampleRate\":%u,\"bands\":16,\"fixedVocoderWetRms\":%.9g,"
                "\"midiNote48Rms\":%.9g,\"midiNote72Rms\":%.9g,"
                "\"partitionMaxRmsDifference\":%.9g,\"callbackAllocations\":%u,"
                "\"callbackFrees\":%u,\"failures\":%d}\n",
                kSampleRate, gVocoderWetRms, gMidiLowNoteRms, gMidiHighNoteRms,
                gPartitionMaximumDifference, gCallbackAllocations,
                gCallbackFrees, gFailures);
    return gFailures == 0 ? 0 : 1;
}
