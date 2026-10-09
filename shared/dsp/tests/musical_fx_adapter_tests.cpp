#include "webrc/dsp/musical_fx_adapter.hpp"

#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <type_traits>
#include <utility>

namespace {

std::atomic<bool> gTrackHeap{false};
std::atomic<std::uint64_t> gTrackedNews{0U};
std::atomic<std::uint64_t> gTrackedDeletes{0U};

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        std::exit(1);
    }
}

void* countedAlloc(std::size_t size) {
    if (gTrackHeap.load(std::memory_order_relaxed))
        gTrackedNews.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}

void countedFree(void* memory) noexcept {
    if (memory != nullptr && gTrackHeap.load(std::memory_order_relaxed))
        gTrackedDeletes.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}

constexpr float kPi = 3.14159265358979323846f;

webrc::dsp::StereoFrame inputAt(std::uint64_t frame, float leftHz = 220.0f,
                                float rightHz = 330.0f) {
    const float t = static_cast<float>(frame) / 48000.0f;
    return {0.24f * std::sin(2.0f * kPi * leftHz * t),
            0.16f * std::sin(2.0f * kPi * rightHz * t + 0.31f)};
}

webrc::dsp::StereoFrame carrierAt(std::uint64_t frame) {
    const float t = static_cast<float>(frame) / 48000.0f;
    return {0.21f * std::sin(2.0f * kPi * 130.0f * t + 0.14f),
            0.17f * std::sin(2.0f * kPi * 196.0f * t + 0.63f)};
}

void fill(std::array<webrc::dsp::StereoFrame, 256U>& block, std::uint64_t start) {
    for (std::uint32_t i = 0U; i < block.size(); ++i) block[i] = inputAt(start + i);
}

double channelEnergy(const webrc::dsp::StereoFrame* audio, std::uint32_t frames,
                     bool right) {
    double sum = 0.0;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const double x = right ? audio[i].right : audio[i].left;
        sum += x * x;
    }
    return sum;
}

template <std::size_t N>
bool sameFrames(const std::array<webrc::dsp::StereoFrame, N>& a,
                const std::array<webrc::dsp::StereoFrame, N>& b) {
    for (std::size_t i = 0U; i < N; ++i)
        if (a[i].left != b[i].left || a[i].right != b[i].right) return false;
    return true;
}

template <class Options>
void exerciseKind(const webrc::dsp::ProcessSpec& spec, Options options,
                  webrc::dsp::MusicalFxKind expectedKind, std::uint16_t expectedOrdinal,
                  webrc::dsp::MusicalFxParameter secondParameter, float secondValue,
                  bool carrier) {
    using namespace webrc::dsp;
    MusicalFxOptions wrapped{options};
    check(MusicalFxAdapter::kindForOptions(wrapped) == expectedKind,
          "option type resolves to the expected local kind");
    const auto bytes = MusicalFxAdapter::requiredPrepareBytes(spec, wrapped);
    check(bytes > sizeof(MusicalFxAdapter), "prepare requirement includes adapter and processor");

    MusicalFxAdapter adapter;
    check(adapter.replacementPeakBytes(spec, wrapped) == bytes,
          "initial peak requirement equals the candidate requirement");
    check(adapter.prepare(spec, wrapped, bytes), "candidate prepare succeeds at exact budget");
    check(adapter.prepared() && adapter.kind() == expectedKind &&
          adapter.catalogOrdinal() == expectedOrdinal,
          "prepared kind and catalog ordinal are stable");
    check(adapter.preparedBytes() == bytes, "prepared byte ledger matches estimator");

    std::array<MusicalFxEvent, 2U> events{};
    events[0] = {0U, MusicalFxEventType::Parameter, MusicalFxParameter::Active,
                 1.0f, 0U, 60U, 100U};
    events[1] = {37U, MusicalFxEventType::Parameter, secondParameter,
                 secondValue, 0U, 60U, 100U};
    std::array<StereoFrame, 256U> block{};
    std::array<StereoFrame, 256U> carrierBlock{};
    double left = 0.0;
    double right = 0.0;
    for (std::uint64_t start = 0U; start < 8192U; start += block.size()) {
        fill(block, start);
        if (start == 0U) {
            for (std::uint32_t i = 0U; i < carrierBlock.size(); ++i)
                carrierBlock[i] = carrierAt(i);
        }
        const auto* inputEvents = start == 0U ? events.data() : nullptr;
        const auto eventCount = start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U;
        const bool ok = carrier
            ? adapter.processBlockWithCarrier(start, block.data(), carrierBlock.data(),
                                               static_cast<std::uint32_t>(block.size()),
                                               inputEvents, eventCount)
            : adapter.processBlock(start, block.data(), static_cast<std::uint32_t>(block.size()),
                                   inputEvents, eventCount);
        check(ok, "processor accepts valid stereo audio and controls");
        left += channelEnergy(block.data(), static_cast<std::uint32_t>(block.size()), false);
        right += channelEnergy(block.data(), static_cast<std::uint32_t>(block.size()), true);
        for (const auto& sample : block)
            check(std::isfinite(sample.left) && std::isfinite(sample.right),
                  "processor output remains finite");
    }
    check(left > 1.0e-7 && right > 1.0e-7, "both stereo output channels carry signal");
    check(std::fabs(left - right) > 1.0e-5, "distinct L/R inputs remain distinguishable");
    check(adapter.latency().fixedAlgorithmicSamples <= 8192U,
          "normalized fixed latency is bounded");
}

void testAllProcessors() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    exerciseKind(spec, SynthFxOptions{}, MusicalFxKind::Synth, 6U,
                 MusicalFxParameter::Frequency, 72.0f, false);
    exerciseKind(spec, GuitarToBassFxOptions{}, MusicalFxKind::GuitarToBass, 10U,
                 MusicalFxParameter::Balance, 42.0f, false);
    exerciseKind(spec, AutoRiffFxOptions{}, MusicalFxKind::AutoRiff, 12U,
                 MusicalFxParameter::TempoBpm, 137.0f, false);
    exerciseKind(spec, RobotFxOptions{}, MusicalFxKind::Robot, 16U,
                 MusicalFxParameter::Mix, 0.61f, false);
    exerciseKind(spec, ElectricFxOptions{}, MusicalFxKind::Electric, 17U,
                 MusicalFxParameter::ShiftSemitones, 3.0f, false);
    exerciseKind(spec, HarmonyAutoFxOptions{}, MusicalFxKind::HarmonyAuto, 19U,
                 MusicalFxParameter::HarmonyLevel, 67.0f, false);
    VocoderFxOptions external{};
    external.kind = VocoderFxKind::Vocoder;
    exerciseKind(spec, external, MusicalFxKind::Vocoder, 20U,
                 MusicalFxParameter::OutputDb, -1.0f, true);
    VocoderFxOptions oscillator{};
    oscillator.kind = VocoderFxKind::OscVocMidi;
    exerciseKind(spec, oscillator, MusicalFxKind::OscVocMidi, 21U,
                 MusicalFxParameter::OutputDb, 0.0f, false);
    exerciseKind(spec, OscBotFxOptions{}, MusicalFxKind::OscBot, 22U,
                 MusicalFxParameter::Tone, 12.0f, false);
}

void testVocoderTypedMidiAndCarrier() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    VocoderFxOptions options{};
    options.kind = VocoderFxKind::OscVocMidi;
    MusicalFxAdapter midi;
    check(midi.prepare(spec, MusicalFxOptions{options}), "prepare OSC VOC MIDI adapter");
    std::array<StereoFrame, 256U> block{};
    std::array<MusicalFxEvent, 4U> events{};
    events[0] = {0U, MusicalFxEventType::Parameter, MusicalFxParameter::Active, 1.0f};
    events[1] = {37U, MusicalFxEventType::MidiNoteOn, MusicalFxParameter::Active,
                 0.0f, 0U, 60U, 112U};
    events[2] = {37U, MusicalFxEventType::MidiNoteOn, MusicalFxParameter::Active,
                 0.0f, 0U, 64U, 94U};
    events[3] = {201U, MusicalFxEventType::MidiNoteOff, MusicalFxParameter::Active,
                 0.0f, 0U, 60U, 0U};
    fill(block, 0U);
    check(midi.processBlock(0U, block.data(), 256U, events.data(),
                            static_cast<std::uint32_t>(events.size())),
          "typed same-sample MIDI chord is accepted");

    VocoderFxOptions extOptions{};
    extOptions.kind = VocoderFxKind::Vocoder;
    MusicalFxAdapter external;
    MusicalFxAdapter externalReference;
    check(external.prepare(spec, MusicalFxOptions{extOptions}) &&
          externalReference.prepare(spec, MusicalFxOptions{extOptions}),
          "prepare paired external vocoder adapters");
    std::array<StereoFrame, 256U> mod{};
    std::array<StereoFrame, 256U> modReference{};
    std::array<StereoFrame, 256U> carrier{};
    for (std::uint32_t i = 0U; i < 256U; ++i)
        carrier[i] = {0.25f * std::sin(2.0f * kPi * 440.0f * i / 48000.0f), 0.0f};
    const std::array<MusicalFxEvent, 2U> wetAndActive{{
        {0U, MusicalFxEventType::Parameter, MusicalFxParameter::Active, 1.0f},
        {0U, MusicalFxEventType::Parameter, MusicalFxParameter::Mix, 1.0f}}};
    fill(mod, 0U);
    modReference = mod;
    const auto beforeBadRoute = mod;
    check(!external.processBlock(0U, mod.data(), 256U, wetAndActive.data(), 2U),
          "VOCODER20 rejects generic oscillator-carrier path");
    check(sameFrames(mod, beforeBadRoute), "wrong carrier route leaves caller audio unchanged");
    const auto beforeMissingCarrier = mod;
    check(!external.processBlockWithCarrier(0U, mod.data(), nullptr, 256U,
                                               wetAndActive.data(), 2U),
          "VOCODER20 rejects missing carrier");
    check(sameFrames(mod, beforeMissingCarrier), "null carrier leaves caller audio unchanged");
    double wetLeft = 0.0;
    double wetRight = 0.0;
    for (std::uint64_t start = 0U; start < 8192U; start += 256U) {
        for (std::uint32_t i = 0U; i < 256U; ++i) {
            const auto absolute = start + i;
            const float t = static_cast<float>(absolute) / 48000.0f;
            mod[i] = {0.2f * std::sin(2.0f * kPi * 190.0f * t),
                      0.2f * std::sin(2.0f * kPi * 230.0f * t)};
            modReference[i] = mod[i];
            carrier[i] = {0.25f * std::sin(2.0f * kPi * 440.0f * t), 0.0f};
        }
        const auto* controls = start == 0U ? wetAndActive.data() : nullptr;
        const auto controlCount = start == 0U ? 2U : 0U;
        check(external.processBlockWithCarrier(start, mod.data(), carrier.data(), 256U,
                                                controls, controlCount),
              "VOCODER20 accepts true external stereo carrier");
        check(externalReference.processBlockWithCarrier(start, modReference.data(),
                  carrier.data(), 256U, controls, controlCount),
              "reference carrier route accepts matching valid events");
        check(sameFrames(mod, modReference),
              "rejected carrier calls left processor state unchanged");
    }
    wetLeft = channelEnergy(mod.data(), 256U, false);
    wetRight = channelEnergy(mod.data(), 256U, true);
    std::printf("VOCODER20_CARRIER_LR_ENERGY %.9g %.9g\n", wetLeft, wetRight);
    check(wetLeft > 1.0e-5 && wetRight < wetLeft * 1.0e-4,
          "external carrier left/right paths remain independent");
}

void testCombinedEventTransactions() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    MusicalFxOptions options{SynthFxOptions{}};
    MusicalFxAdapter rejected;
    MusicalFxAdapter reference;
    check(rejected.prepare(spec, options) && reference.prepare(spec, options),
          "prepare paired adapters for atomic rejection probe");
    std::array<StereoFrame, 256U> a{};
    std::array<StereoFrame, 256U> b{};
    fill(a, 0U);
    b = a;
    check(rejected.processBlock(0U, a.data(), 256U) &&
          reference.processBlock(0U, b.data(), 256U), "warm paired processors");

    std::array<MusicalFxEvent, 2U> invalidLast{{
        {0U, MusicalFxEventType::Parameter, MusicalFxParameter::Active, 0.0f},
        {37U, MusicalFxEventType::Parameter, MusicalFxParameter::Frequency, 101.0f}}};
    fill(a, 256U);
    const auto unchanged = a;
    check(!rejected.processBlock(256U, a.data(), 256U, invalidLast.data(), 2U),
          "late invalid parameter rejects the whole combined block");
    check(sameFrames(a, unchanged), "invalid trailing parameter leaves caller audio untouched");

    fill(a, 256U);
    fill(b, 256U);
    check(rejected.processBlock(256U, a.data(), 256U) &&
          reference.processBlock(256U, b.data(), 256U),
          "both adapters continue after rejected parameter transaction");
    check(sameFrames(a, b), "rejected event list leaves DSP state unchanged");

    std::array<MusicalFxEvent, 65U> tooMany{};
    for (std::uint32_t i = 0U; i < 33U; ++i)
        tooMany[i] = {1U, MusicalFxEventType::Parameter, MusicalFxParameter::Active,
                      1.0f, 0U, 60U, 100U};
    for (std::uint32_t i = 33U; i < tooMany.size(); ++i) {
        tooMany[i] = {1U, MusicalFxEventType::MidiNoteOn, MusicalFxParameter::Active,
                      0.0f, 0U, static_cast<std::uint8_t>(60U + i - 33U), 100U};
    }
    fill(a, 512U);
    const auto unchangedCount = a;
    check(!rejected.processBlock(512U, a.data(), 256U, tooMany.data(),
                                  static_cast<std::uint32_t>(tooMany.size())),
          "combined parameter/MIDI stream hard limit is 64");
    check(sameFrames(a, unchangedCount), "over-capacity list cannot alter audio");

    std::array<MusicalFxEvent, 2U> unordered{{
        {20U, MusicalFxEventType::Parameter, MusicalFxParameter::Active, 1.0f},
        {19U, MusicalFxEventType::Parameter, MusicalFxParameter::Frequency, 40.0f}}};
    check(!rejected.processBlock(512U, a.data(), 256U, unordered.data(), 2U),
          "out-of-order frame offsets reject before mutation");

    VocoderFxOptions midiOptions{};
    midiOptions.kind = VocoderFxKind::OscVocMidi;
    MusicalFxAdapter midiTrial;
    MusicalFxAdapter midiReference;
    check(midiTrial.prepare(spec, MusicalFxOptions{midiOptions}) &&
          midiReference.prepare(spec, MusicalFxOptions{midiOptions}),
          "prepare combined MIDI transaction pair");
    std::array<StereoFrame, 256U> midiA{};
    std::array<StereoFrame, 256U> midiB{};
    fill(midiA, 0U);
    midiB = midiA;
    check(midiTrial.processBlock(0U, midiA.data(), 256U) &&
          midiReference.processBlock(0U, midiB.data(), 256U), "warm MIDI transaction pair");
    std::array<MusicalFxEvent, 2U> invalidMidiTail{{
        {0U, MusicalFxEventType::Parameter, MusicalFxParameter::Active, 0.0f},
        {37U, MusicalFxEventType::MidiNoteOn, MusicalFxParameter::Active,
         0.0f, 1U, 69U, 100U}}};
    fill(midiA, 256U);
    const auto unchangedMidi = midiA;
    check(!midiTrial.processBlock(256U, midiA.data(), 256U,
                                  invalidMidiTail.data(), 2U),
          "invalid final MIDI event rejects preceding parameter event atomically");
    check(sameFrames(midiA, unchangedMidi), "invalid MIDI transaction leaves audio unchanged");
    fill(midiA, 256U);
    fill(midiB, 256U);
    check(midiTrial.processBlock(256U, midiA.data(), 256U) &&
          midiReference.processBlock(256U, midiB.data(), 256U),
          "both MIDI processors continue after invalid mixed transaction");
    check(sameFrames(midiA, midiB), "invalid trailing MIDI event leaves state unchanged");

    std::array<MusicalFxEvent, 64U> atCapacity{};
    for (std::uint32_t i = 0U; i < 32U; ++i)
        atCapacity[i] = {1U, MusicalFxEventType::Parameter, MusicalFxParameter::Active,
                         1.0f, 0U, 60U, 100U};
    for (std::uint32_t i = 32U; i < atCapacity.size(); ++i)
        atCapacity[i] = {1U, MusicalFxEventType::MidiNoteOff, MusicalFxParameter::Active,
                         0.0f, 0U, 60U, 0U};
    fill(midiA, 512U);
    check(midiTrial.processBlock(512U, midiA.data(), 256U, atCapacity.data(),
                                  static_cast<std::uint32_t>(atCapacity.size())),
          "64 mixed parameter and MIDI events are accepted at the shared limit");
}

void testPitchProcessorsKeepSilentSideSilent() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    for (const MusicalFxOptions options : {MusicalFxOptions{GuitarToBassFxOptions{}},
                                            MusicalFxOptions{RobotFxOptions{}},
                                            MusicalFxOptions{ElectricFxOptions{}}}) {
        MusicalFxAdapter leftOnly;
        MusicalFxAdapter rightOnly;
        check(leftOnly.prepare(spec, options) && rightOnly.prepare(spec, options),
              "prepare L/R isolation pair");
        std::array<StereoFrame, 256U> left{};
        std::array<StereoFrame, 256U> right{};
        double leftSignal = 0.0;
        double rightSignal = 0.0;
        double leftLeak = 0.0;
        double rightLeak = 0.0;
        const MusicalFxEvent activate{0U, MusicalFxEventType::Parameter,
                                      MusicalFxParameter::Active, 1.0f};
        for (std::uint64_t start = 0U; start < 8192U; start += 256U) {
            for (std::uint32_t i = 0U; i < 256U; ++i) {
                const auto absolute = start + i;
                const auto mono = inputAt(absolute, 220.0f, 220.0f).left;
                left[i] = {mono, 0.0f};
                right[i] = {0.0f, mono};
            }
            const auto* events = start == 0U ? &activate : nullptr;
            const std::uint32_t count = start == 0U ? 1U : 0U;
            check(leftOnly.processBlock(start, left.data(), 256U, events, count) &&
                  rightOnly.processBlock(start, right.data(), 256U, events, count),
                  "isolated pitch processors render both orientations");
            if (start >= 4096U) {
                leftSignal += channelEnergy(left.data(), 256U, false);
                leftLeak += channelEnergy(left.data(), 256U, true);
                rightSignal += channelEnergy(right.data(), 256U, true);
                rightLeak += channelEnergy(right.data(), 256U, false);
            }
        }
        check(leftSignal > 1.0e-6 && rightSignal > 1.0e-6,
              "each side's own pitch path carries energy");
        check(leftLeak < leftSignal * 1.0e-10 && rightLeak < rightSignal * 1.0e-10,
              "pitch resynthesis does not cross-feed the opposite channel");
    }
}

void testPrepareTransactionAndAdmission() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    MusicalFxAdapter adapter;
    const MusicalFxOptions synth{SynthFxOptions{}};
    check(adapter.prepare(spec, synth), "prepare initial live processor");
    const auto oldBytes = adapter.preparedBytes();
    MusicalFxOptions invalid{VocoderFxOptions{}};
    auto& badVocoder = std::get<VocoderFxOptions>(invalid);
    badVocoder.bandCount = 1U;
    check(!adapter.prepare(spec, invalid), "invalid candidate setup fails");
    check(adapter.prepared() && adapter.kind() == MusicalFxKind::Synth &&
          adapter.preparedBytes() == oldBytes,
          "failed prepare preserves prior prepared state");

    MusicalFxOptions next{OscBotFxOptions{}};
    const auto peak = adapter.replacementPeakBytes(spec, next);
    check(peak > oldBytes, "replacement estimator includes old and staged candidate");
    check(!adapter.prepare(spec, next, peak - 1U), "one-byte-short replacement budget rejects");
    check(adapter.kind() == MusicalFxKind::Synth, "budget rejection keeps old kind active");
    check(adapter.prepare(spec, next, peak), "candidate installs at exact replacement budget");
    check(adapter.kind() == MusicalFxKind::OscBot && adapter.prepared(),
          "successful prepare atomically replaces kind");
}

void testSplitBlockInvariance() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    VocoderFxOptions options{};
    options.kind = VocoderFxKind::OscVocMidi;
    MusicalFxAdapter whole;
    MusicalFxAdapter split;
    check(whole.prepare(spec, MusicalFxOptions{options}) &&
          split.prepare(spec, MusicalFxOptions{options}), "prepare split-run pair");
    std::array<StereoFrame, 256U> one{};
    const std::array<MusicalFxEvent, 3U> events{{
        {0U, MusicalFxEventType::Parameter, MusicalFxParameter::Active, 1.0f},
        {37U, MusicalFxEventType::MidiNoteOn, MusicalFxParameter::Active, 0.0f, 0U, 57U, 110U},
        {173U, MusicalFxEventType::MidiNoteOff, MusicalFxParameter::Active, 0.0f, 0U, 57U, 0U}}};
    for (std::uint64_t i = 0U; i < one.size(); ++i) one[static_cast<std::size_t>(i)] = inputAt(i);
    check(whole.processBlock(0U, one.data(), 256U, events.data(), 3U),
          "whole-block MIDI render succeeds");

    std::array<StereoFrame, 256U> splitAudio{};
    for (std::uint64_t i = 0U; i < splitAudio.size(); ++i)
        splitAudio[static_cast<std::size_t>(i)] = inputAt(i);
    check(split.processBlock(0U, splitAudio.data(), 64U, events.data(), 2U),
          "first 64-frame segment includes note-on at 37");
    const std::array<MusicalFxEvent, 1U> noteOff{{
        {109U, MusicalFxEventType::MidiNoteOff, MusicalFxParameter::Active,
         0.0f, 0U, 57U, 0U}}};
    check(split.processBlock(64U, splitAudio.data() + 64U, 128U, noteOff.data(), 1U),
          "128-frame middle segment includes same absolute note-off");
    check(split.processBlock(192U, splitAudio.data() + 192U, 64U),
          "final 64-frame segment succeeds");
    check(sameFrames(one, splitAudio), "sample-offset MIDI output is invariant under 64/128/64 splits");
}

void testNoHeapInCallback() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256U, 2U};
    VocoderFxOptions options{};
    options.kind = VocoderFxKind::OscVocMidi;
    MusicalFxAdapter adapter;
    check(adapter.prepare(spec, MusicalFxOptions{options}), "prepare no-allocation fixture");
    std::array<StereoFrame, 256U> audio{};
    const std::array<MusicalFxEvent, 4U> events{{
        {0U, MusicalFxEventType::Parameter, MusicalFxParameter::Active, 1.0f},
        {0U, MusicalFxEventType::MidiNoteOn, MusicalFxParameter::Active, 0.0f, 0U, 60U, 100U},
        {61U, MusicalFxEventType::MidiNoteOn, MusicalFxParameter::Active, 0.0f, 0U, 64U, 90U},
        {201U, MusicalFxEventType::MidiNoteOff, MusicalFxParameter::Active, 0.0f, 0U, 60U, 0U}}};
    fill(audio, 0U);
    gTrackedNews.store(0U, std::memory_order_relaxed);
    gTrackedDeletes.store(0U, std::memory_order_relaxed);
    gTrackHeap.store(true, std::memory_order_relaxed);
    const bool first = adapter.processBlock(0U, audio.data(), 256U, events.data(), 4U);
    bool rest = true;
    for (std::uint64_t frame = 256U; frame < 4096U; frame += 256U) {
        fill(audio, frame);
        rest = rest && adapter.processBlock(frame, audio.data(), 256U);
    }
    gTrackHeap.store(false, std::memory_order_relaxed);
    check(first && rest, "no-allocation callback render succeeds");
    check(gTrackedNews.load(std::memory_order_relaxed) == 0U &&
          gTrackedDeletes.load(std::memory_order_relaxed) == 0U,
          "callback performs no C++ heap allocation or free");
}

} // namespace

void* operator new(std::size_t size) { return countedAlloc(size); }
void* operator new[](std::size_t size) { return countedAlloc(size); }
void operator delete(void* memory) noexcept { countedFree(memory); }
void operator delete[](void* memory) noexcept { countedFree(memory); }
void operator delete(void* memory, std::size_t) noexcept { countedFree(memory); }
void operator delete[](void* memory, std::size_t) noexcept { countedFree(memory); }

int main() {
    testAllProcessors();
    testVocoderTypedMidiAndCarrier();
    testCombinedEventTransactions();
    testPitchProcessorsKeepSilentSideSilent();
    testPrepareTransactionAndAdmission();
    testSplitBlockInvariance();
    testNoHeapInCallback();
    std::puts("musical_fx_adapter_tests: PASS");
    return 0;
}
