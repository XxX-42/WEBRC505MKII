#include "webrc/dsp/musical_fx_registry_bridge.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <iterator>
#include <new>

namespace {
std::atomic<bool> gMeasureAllocations{false};
std::atomic<std::size_t> gNewCount{0U};
std::atomic<std::size_t> gDeleteCount{0U};

bool require(bool value, const char* message) {
    if (value) return true;
    std::fprintf(stderr, "FAIL: %s\n", message);
    return false;
}

void fillInput(float* left, float* right, std::uint32_t frames,
               std::uint64_t firstFrame = 0U) {
    constexpr double twoPi = 6.283185307179586476925286766559;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const auto frame = firstFrame + i;
        left[i] = 0.18f * static_cast<float>(std::sin(twoPi * 220.0 * frame / 48000.0));
        right[i] = 0.13f * static_cast<float>(std::sin(twoPi * 329.6276 * frame / 48000.0 + 0.17));
    }
}

bool allFinite(const float* left, const float* right, std::uint32_t frames) {
    for (std::uint32_t i = 0U; i < frames; ++i)
        if (!std::isfinite(left[i]) || !std::isfinite(right[i])) return false;
    return true;
}

bool testAllKinds() {
    constexpr std::array<std::uint16_t, 9U> ordinals{{6U, 10U, 12U, 16U, 17U, 19U, 20U, 21U, 22U}};
    constexpr std::uint32_t frames = 256U;
    const webrc::dsp::ProcessSpec spec{48000.0f, frames, 2U};
    std::array<float, frames> inLeft{};
    std::array<float, frames> inRight{};
    std::array<float, frames> outLeft{};
    std::array<float, frames> outRight{};
    std::array<float, frames> carrierLeft{};
    std::array<float, frames> carrierRight{};
    fillInput(inLeft.data(), inRight.data(), frames);
    fillInput(carrierLeft.data(), carrierRight.data(), frames);
    const float* input[2]{inLeft.data(), inRight.data()};
    float* output[2]{outLeft.data(), outRight.data()};

    for (const auto ordinal : ordinals) {
        webrc::dsp::MusicalFxRegistryBridge bridge(ordinal);
        const auto required = webrc::dsp::MusicalFxRegistryBridge::requiredPrepareBytes(ordinal, spec);
        if (!require(required > sizeof(bridge), "bridge byte estimator returns a supported requirement")) return false;
        bridge.setMaximumPreparePeakBytes(required - 1U);
        if (!require(!bridge.prepare(spec), "one-byte-short initial admission is rejected")) return false;
        bridge.setMaximumPreparePeakBytes(static_cast<std::size_t>(-1));
        if (!require(bridge.prepare(spec), "default options prepare for every musical ordinal")) return false;
        if (!require(bridge.ordinal() == ordinal && bridge.validateBlockRequest(2U, frames),
                     "prepared bridge reports correct ordinal and stereo request")) return false;
        const auto latency = bridge.adapter().latency();
        const bool mixedDryAndPsolaWet = ordinal == 10U || ordinal == 12U || ordinal == 16U ||
                                         ordinal == 17U || ordinal == 19U;
        const auto expectedFixedLatency = mixedDryAndPsolaWet
            ? -1LL
            : static_cast<std::int64_t>(latency.fixedAlgorithmicSamples) +
              latency.psolaLookaheadSamples;
        const bool expectedFrequencyDependent = ordinal == 20U || ordinal == 21U;
        if (!require(bridge.fixedLatencySamples() == expectedFixedLatency &&
                     bridge.latencyIsFrequencyDependent() == expectedFrequencyDependent,
                     "mixed dry/PSOLA paths and vocoder group delay have honest latency models")) return false;
        const auto expectedWarmup = std::max<std::uint64_t>(
            latency.conservativePitchOnsetFrames,
            static_cast<std::uint64_t>(latency.analysisWindowFrames) +
                latency.analysisHopFrames + latency.psolaLookaheadSamples);
        if (!require(bridge.startupWarmupFrames() == expectedWarmup,
                     "pitch estimator warmup includes the PSOLA lookahead bound")) return false;
        outLeft.fill(0.0f);
        outRight.fill(0.0f);
        const webrc::dsp::FxProcessContext empty{};
        if (ordinal == 20U) {
            outLeft.fill(-91.0f);
            outRight.fill(-91.0f);
            if (!require(!bridge.processBlock(input, output, 2U, frames),
                         "VOCODER20 rejects ordinary process without external carrier")) return false;
            if (!require(outLeft[0] == -91.0f && outRight[0] == -91.0f,
                         "missing carrier leaves caller output untouched")) return false;
            webrc::dsp::FxProcessContext context{};
            context.carrierLeft = carrierLeft.data();
            context.carrierRight = carrierRight.data();
            context.carrierChannels = 2U;
            context.carrierFrames = frames;
            if (!require(bridge.processBlockWithContext(input, output, 2U, frames,
                                                       nullptr, 0U, context),
                         "VOCODER20 renders only through explicit stereo carrier context")) return false;
        } else {
            if (!require(bridge.processBlockWithContext(input, output, 2U, frames,
                                                       nullptr, 0U, empty),
                         "context bridge processes ordinary stereo input")) return false;
        }
        if (!require(allFinite(outLeft.data(), outRight.data(), frames),
                     "all nine bridge processors return finite stereo output")) return false;
    }
    return true;
}

bool testParameterMappingAndQueue() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 128U, 2U};
    std::array<float, 128U> inL{};
    std::array<float, 128U> inR{};
    std::array<float, 128U> outL{};
    std::array<float, 128U> outR{};
    fillInput(inL.data(), inR.data(), 128U);
    const float* input[2]{inL.data(), inR.data()};
    float* output[2]{outL.data(), outR.data()};
    const FxProcessContext empty{};

    MusicalFxRegistryBridge synth(6U);
    if (!require(synth.validParameter(FxParameterId::SynthFrequencyMacro, 100.0f) &&
                 !synth.validParameter(FxParameterId::SynthFrequencyMacro, 100.1f) &&
                 synth.validParameter(FxParameterId::BalancePercent, 50.0f),
                 "SYNTH macro IDs use finite 0..100 reconstruction controls")) return false;
    if (!require(synth.setParameter(FxParameterId::SynthFrequencyMacro, 42.0f),
                 "direct setter is bounded and may be queued before prepare")) return false;
    if (!require(synth.prepare(spec), "SYNTH prepares after a pre-prepare control")) return false;
    if (!require(synth.processBlockWithContext(input, output, 2U, 128U,
                                               nullptr, 0U, empty),
                 "pre-prepare direct setter applies on the first block")) return false;

    MusicalFxRegistryBridge autoRiff(12U);
    if (!require(autoRiff.validParameter(FxParameterId::TempoBpm, 120.0f) &&
                 !autoRiff.validParameter(FxParameterId::TempoBpm, 20.0f) &&
                 autoRiff.validParameter(FxParameterId::PhraseIndex, 30.0f) &&
                 !autoRiff.validParameter(FxParameterId::PhraseIndex, 30.5f),
                 "AUTO RIFF tempo/phrase are range- and integer-checked")) return false;

    MusicalFxRegistryBridge harmony(19U);
    if (!require(harmony.validParameter(FxParameterId::ModeIndex, 2.0f) &&
                 !harmony.validParameter(FxParameterId::ModeIndex, 0.0f) &&
                 harmony.validParameter(FxParameterId::Pan, -1.0f) &&
                 !harmony.validParameter(FxParameterId::Pan, 1.01f),
                 "HRM mode index and normalized pan translate to local control domain")) return false;

    MusicalFxRegistryBridge oscBot(22U);
    if (!require(oscBot.validParameter(FxParameterId::BalancePercent, 100.0f) &&
                 !oscBot.validParameter(FxParameterId::BalancePercent, 101.0f) &&
                 oscBot.validParameter(FxParameterId::OscNoteMidi, 36.0f) &&
                 !oscBot.validParameter(FxParameterId::OscNoteMidi, 36.5f),
                 "OSC BOT percent balance maps to normalized local range and note is integral")) return false;
    return true;
}

bool testSuccessfulReprepareRestartsTimeline() {
    using namespace webrc::dsp;
    constexpr std::uint32_t frames = 64U;
    const ProcessSpec spec{48000.0f, frames, 2U};
    MusicalFxRegistryBridge bridge(21U);
    if (!require(bridge.prepare(spec), "timeline bridge initially prepares")) return false;
    std::array<float, frames> inL{};
    std::array<float, frames> inR{};
    std::array<float, frames> outL{};
    std::array<float, frames> outR{};
    fillInput(inL.data(), inR.data(), frames);
    const float* input[2]{inL.data(), inR.data()};
    float* output[2]{outL.data(), outR.data()};
    if (!require(bridge.processBlock(input, output, 2U, frames),
                 "first OSC VOC(M) block advances the bridge timeline")) return false;
    if (!require(bridge.prepare(spec), "successful reprepare stages a fresh processor")) return false;
    if (!require(bridge.processBlock(input, output, 2U, frames),
                 "successful reprepare restarts at the fresh processor's frame zero")) return false;
    return true;
}

bool testParameterOnlyContextEntryIsAtomicForExternalCarrier() {
    using namespace webrc::dsp;
    constexpr std::uint32_t frames = 128U;
    const ProcessSpec spec{48000.0f, frames, 2U};
    MusicalFxRegistryBridge rejected(20U);
    MusicalFxRegistryBridge reference(20U);
    if (!require(rejected.prepare(spec) && reference.prepare(spec),
                 "VOCODER20 parameter-only atomic pair prepares")) return false;

    std::array<float, frames> modL{};
    std::array<float, frames> modR{};
    std::array<float, frames> carL{};
    std::array<float, frames> carR{};
    std::array<float, frames> rejectedL{};
    std::array<float, frames> rejectedR{};
    std::array<float, frames> referenceL{};
    std::array<float, frames> referenceR{};
    fillInput(modL.data(), modR.data(), frames);
    fillInput(carL.data(), carR.data(), frames, 11U);
    const float* input[2]{modL.data(), modR.data()};
    float* rejectedOutput[2]{rejectedL.data(), rejectedR.data()};
    float* referenceOutput[2]{referenceL.data(), referenceR.data()};

    if (!require(rejected.setParameter(FxParameterId::Active, 1.0f) &&
                 reference.setParameter(FxParameterId::Active, 1.0f),
                 "queued controls are held identically before both paths")) return false;
    const FxParameterEvent missingCarrierEvents[1]{{0U, FxParameterId::Mix, 0.65f}};
    rejectedL.fill(-77.0f);
    rejectedR.fill(-77.0f);
    FxProcessor* base = &rejected;
    if (!require(!base->processBlockWithEvents(input, rejectedOutput, 2U, frames,
                                               missingCarrierEvents, 1U),
                 "base-signature parameter entry rejects VOCODER20 without its carrier")) return false;
    if (!require(rejectedL[0] == -77.0f && rejectedR[0] == -77.0f,
                 "missing-carrier event rejection leaves caller output untouched")) return false;

    FxProcessContext context{};
    context.carrierLeft = carL.data();
    context.carrierRight = carR.data();
    context.carrierFrames = frames;
    context.carrierChannels = 2U;
    if (!require(base->processBlockWithContext(input, rejectedOutput, 2U, frames,
                                              nullptr, 0U, context) &&
                 reference.processBlockWithContext(input, referenceOutput, 2U, frames,
                                                   nullptr, 0U, context),
                 "the base-class typed-context virtual continues with only the prequeued Active event")) return false;
    for (std::uint32_t frame = 0U; frame < frames; ++frame)
        if (!require(rejectedL[frame] == referenceL[frame] &&
                     rejectedR[frame] == referenceR[frame],
                     "failed ordinary event call neither consumes queued setters nor mutates DSP state"))
            return false;
    return true;
}

bool testAllMappedControlsRunThroughBridge() {
    using namespace webrc::dsp;
    constexpr std::uint32_t frames = 64U;
    const ProcessSpec spec{48000.0f, frames, 2U};
    std::array<float, frames> inL{};
    std::array<float, frames> inR{};
    std::array<float, frames> outL{};
    std::array<float, frames> outR{};
    std::array<float, frames> carrierL{};
    std::array<float, frames> carrierR{};
    fillInput(inL.data(), inR.data(), frames);
    fillInput(carrierL.data(), carrierR.data(), frames);
    const float* input[2]{inL.data(), inR.data()};
    float* output[2]{outL.data(), outR.data()};
    struct Control { FxParameterId id; float value; };
    struct Batch { std::uint16_t ordinal; const Control* controls; std::uint32_t count; };
    const Control synth[]{{FxParameterId::Active, 1.0f}, {FxParameterId::SynthFrequencyMacro, 55.0f},
        {FxParameterId::SynthResonanceMacro, 47.0f}, {FxParameterId::SynthDecayMacro, 62.0f},
        {FxParameterId::BalancePercent, 51.0f}};
    const Control g2b[]{{FxParameterId::Active, 1.0f}, {FxParameterId::BalancePercent, 48.0f},
        {FxParameterId::ModeIndex, 1.0f}};
    const Control riff[]{{FxParameterId::Active, 1.0f}, {FxParameterId::PhraseIndex, 2.0f},
        {FxParameterId::TempoBpm, 123.5f}, {FxParameterId::Hold, 1.0f},
        {FxParameterId::Loop, 0.0f}, {FxParameterId::AttackMacro, 25.0f},
        {FxParameterId::KeyIndex, 5.0f}, {FxParameterId::BalancePercent, 66.0f}};
    const Control robot[]{{FxParameterId::Active, 1.0f}, {FxParameterId::Mix, 0.6f},
        {FxParameterId::NoteClass, 4.0f}, {FxParameterId::ModeIndex, 1.0f},
        {FxParameterId::FormantMacro, -4.0f}};
    const Control electric[]{{FxParameterId::Active, 1.0f}, {FxParameterId::Mix, 0.6f},
        {FxParameterId::Semitones, 2.0f}, {FxParameterId::FormantMacro, 6.0f},
        {FxParameterId::SpeedMacro, 4.0f}, {FxParameterId::StabilityMacro, 2.0f},
        {FxParameterId::ScaleRoot, 7.0f}};
    const Control harmony[]{{FxParameterId::Active, 1.0f}, {FxParameterId::VoiceSelector, 4.0f},
        {FxParameterId::FormantMacro, -2.0f}, {FxParameterId::Pan, 0.4f},
        {FxParameterId::ModeIndex, 1.0f}, {FxParameterId::KeyIndex, 9.0f},
        {FxParameterId::DryLevelPercent, 90.0f}, {FxParameterId::HarmonyLevelPercent, 70.0f}};
    const Control vocoder[]{{FxParameterId::Active, 1.0f}, {FxParameterId::Mix, 1.0f},
        {FxParameterId::OutputDb, -3.0f}, {FxParameterId::AttackMs, 20.0f},
        {FxParameterId::ReleaseMs, 120.0f}};
    const Control oscVoc[]{{FxParameterId::Active, 1.0f}, {FxParameterId::Mix, 0.7f},
        {FxParameterId::OutputDb, 0.0f}, {FxParameterId::AttackMs, 10.0f},
        {FxParameterId::ReleaseMs, 100.0f}, {FxParameterId::Waveform, 2.0f}};
    const Control oscBot[]{{FxParameterId::Active, 1.0f}, {FxParameterId::Mix, 0.5f},
        {FxParameterId::Waveform, 3.0f}, {FxParameterId::ToneMacro, 12.0f},
        {FxParameterId::AttackMacro, 37.0f}, {FxParameterId::OscNoteMidi, 48.0f},
        {FxParameterId::ModulationSensitivityMacro, -5.0f},
        {FxParameterId::BalancePercent, 64.0f}, {FxParameterId::PatternIndex, 2.0f}};
    const Batch batches[]{{6U, synth, static_cast<std::uint32_t>(std::size(synth))},
        {10U, g2b, static_cast<std::uint32_t>(std::size(g2b))},
        {12U, riff, static_cast<std::uint32_t>(std::size(riff))},
        {16U, robot, static_cast<std::uint32_t>(std::size(robot))},
        {17U, electric, static_cast<std::uint32_t>(std::size(electric))},
        {19U, harmony, static_cast<std::uint32_t>(std::size(harmony))},
        {20U, vocoder, static_cast<std::uint32_t>(std::size(vocoder))},
        {21U, oscVoc, static_cast<std::uint32_t>(std::size(oscVoc))},
        {22U, oscBot, static_cast<std::uint32_t>(std::size(oscBot))}};
    for (const auto& batch : batches) {
        MusicalFxRegistryBridge bridge(batch.ordinal);
        if (!require(bridge.prepare(spec), "control-map bridge prepares")) return false;
        std::array<FxParameterEvent, 9U> events{};
        for (std::uint32_t i = 0U; i < batch.count; ++i) {
            events[i] = {0U, batch.controls[i].id, batch.controls[i].value};
            if (!require(bridge.validParameter(batch.controls[i].id, batch.controls[i].value),
                         "every declared local control maps to a valid typed control")) return false;
        }
        FxProcessContext context{};
        if (batch.ordinal == 20U) {
            context.carrierLeft = carrierL.data();
            context.carrierRight = carrierR.data();
            context.carrierFrames = frames;
            context.carrierChannels = 2U;
        }
        FxMidiEvent midi[2]{{3U, FxMidiEventType::NoteOn, 0U, 64U, 105U},
                            {42U, FxMidiEventType::NoteOff, 0U, 64U, 0U}};
        if (batch.ordinal == 19U || batch.ordinal == 21U) {
            context.midiEvents = midi;
            context.midiEventCount = 2U;
        }
        if (!require(bridge.processBlockWithContext(input, output, 2U, frames,
                                                   events.data(), batch.count, context),
                     "all nine parameter maps reach their actual processor with typed inputs")) return false;
        if (!require(allFinite(outL.data(), outR.data(), frames),
                     "mapped controls keep audio finite")) return false;
    }
    return true;
}

bool testCombinedMidiTransactionsAndSplit() {
    using namespace webrc::dsp;
    constexpr std::uint32_t frames = 256U;
    constexpr std::uint16_t ordinal = 21U;
    const ProcessSpec spec{48000.0f, frames, 2U};
    MusicalFxRegistryBridge whole(ordinal);
    MusicalFxRegistryBridge split(ordinal);
    if (!require(whole.prepare(spec) && split.prepare(spec), "OSC VOC(M) bridges prepare")) return false;

    std::array<float, frames> inL{};
    std::array<float, frames> inR{};
    std::array<float, frames> wholeL{};
    std::array<float, frames> wholeR{};
    std::array<float, frames> splitL{};
    std::array<float, frames> splitR{};
    fillInput(inL.data(), inR.data(), frames);
    const float* wholeInput[2]{inL.data(), inR.data()};
    float* wholeOutput[2]{wholeL.data(), wholeR.data()};
    const FxParameterEvent parameters[1]{{37U, FxParameterId::Mix, 0.63f}};
    const FxMidiEvent wholeMidi[2]{{37U, FxMidiEventType::NoteOn, 0U, 69U, 112U},
                                   {173U, FxMidiEventType::NoteOff, 0U, 69U, 0U}};
    FxProcessContext wholeContext{};
    wholeContext.midiEvents = wholeMidi;
    wholeContext.midiEventCount = 2U;
    if (!require(whole.processBlockWithContext(wholeInput, wholeOutput, 2U, frames,
                                               parameters, 1U, wholeContext),
                 "joint parameter and typed MIDI stream processes atomically")) return false;

    const std::array<std::uint32_t, 3U> sizes{{64U, 128U, 64U}};
    std::uint32_t start = 0U;
    for (std::size_t block = 0U; block < sizes.size(); ++block) {
        const auto count = sizes[block];
        const float* in[2]{inL.data() + start, inR.data() + start};
        float* out[2]{splitL.data() + start, splitR.data() + start};
        FxParameterEvent blockParameter{};
        const FxParameterEvent* parameterPointer = nullptr;
        std::uint32_t parameterCount = 0U;
        FxMidiEvent blockMidi[2]{};
        std::uint32_t midiCount = 0U;
        if (block == 0U) {
            blockParameter = {37U, FxParameterId::Mix, 0.63f};
            parameterPointer = &blockParameter;
            parameterCount = 1U;
            blockMidi[0] = {37U, FxMidiEventType::NoteOn, 0U, 69U, 112U};
            midiCount = 1U;
        } else if (block == 1U) {
            blockMidi[0] = {109U, FxMidiEventType::NoteOff, 0U, 69U, 0U};
            midiCount = 1U;
        }
        FxProcessContext context{};
        context.midiEvents = midiCount == 0U ? nullptr : blockMidi;
        context.midiEventCount = midiCount;
        if (!require(split.processBlockWithContext(in, out, 2U, count,
                                                   parameterPointer, parameterCount, context),
                     "sample-offset MIDI processing is invariant across 64/128/64 frames")) return false;
        start += count;
    }
    for (std::uint32_t i = 0U; i < frames; ++i)
        if (!require(wholeL[i] == splitL[i] && wholeR[i] == splitR[i],
                     "whole-block and split-block outputs match sample-for-sample")) return false;

    MusicalFxRegistryBridge transactional(ordinal);
    MusicalFxRegistryBridge reference(ordinal);
    if (!require(transactional.prepare(spec) && reference.prepare(spec),
                 "transactional pair prepares")) return false;
    if (!require(transactional.processBlockWithContext(wholeInput, wholeOutput, 2U, frames,
                                                       nullptr, 0U, FxProcessContext{}) &&
                 reference.processBlockWithContext(wholeInput, wholeOutput, 2U, frames,
                                                   nullptr, 0U, FxProcessContext{}),
                 "transactional pair enters the same warmed state")) return false;
    const FxParameterEvent badParameters[2]{{21U, FxParameterId::Mix, 0.7f},
        {177U, FxParameterId::Waveform, 5.0f}};
    const FxMidiEvent noteOn[1]{{21U, FxMidiEventType::NoteOn, 0U, 57U, 100U}};
    FxProcessContext badContext{};
    badContext.midiEvents = noteOn;
    badContext.midiEventCount = 1U;
    wholeL.fill(-77.0f);
    wholeR.fill(-77.0f);
    float* sentinelOutput[2]{wholeL.data(), wholeR.data()};
    if (!require(!transactional.processBlockWithContext(wholeInput, sentinelOutput, 2U,
                                                        frames, badParameters, 2U,
                                                        badContext),
                 "an invalid final parameter rejects the whole combined stream")) return false;
    if (!require(wholeL[0] == -77.0f && wholeR[0] == -77.0f,
                 "invalid combined stream leaves output untouched")) return false;
    std::array<float, frames> afterA_L{};
    std::array<float, frames> afterA_R{};
    std::array<float, frames> afterB_L{};
    std::array<float, frames> afterB_R{};
    float* afterA[2]{afterA_L.data(), afterA_R.data()};
    float* afterB[2]{afterB_L.data(), afterB_R.data()};
    if (!require(transactional.processBlockWithContext(wholeInput, afterA, 2U, frames,
                                                      nullptr, 0U, FxProcessContext{}) &&
                 reference.processBlockWithContext(wholeInput, afterB, 2U, frames,
                                                   nullptr, 0U, FxProcessContext{}),
                 "state remains usable after atomic rejection")) return false;
    for (std::uint32_t i = 0U; i < frames; ++i)
        if (!require(afterA_L[i] == afterB_L[i] && afterA_R[i] == afterB_R[i],
                     "invalid joint transaction leaves DSP state unchanged")) return false;
    return true;
}

bool testMidiEventChangesAudioAtItsSampleOffset() {
    using namespace webrc::dsp;
    constexpr std::uint32_t frames = 512U;
    const ProcessSpec spec{48000.0f, frames, 2U};
    MusicalFxRegistryBridge withMidi(21U);
    MusicalFxRegistryBridge withoutMidi(21U);
    if (!require(withMidi.prepare(spec) && withoutMidi.prepare(spec),
                 "sample-offset MIDI pair prepares")) return false;
    std::array<float, frames> inL{};
    std::array<float, frames> inR{};
    std::array<float, frames> midiL{};
    std::array<float, frames> midiR{};
    std::array<float, frames> controlL{};
    std::array<float, frames> controlR{};
    fillInput(inL.data(), inR.data(), frames);
    const float* input[2]{inL.data(), inR.data()};
    float* midiOutput[2]{midiL.data(), midiR.data()};
    float* controlOutput[2]{controlL.data(), controlR.data()};
    const FxParameterEvent controls[2]{{0U, FxParameterId::Active, 1.0f},
                                       {0U, FxParameterId::Mix, 1.0f}};
    const FxMidiEvent note{37U, FxMidiEventType::NoteOn, 0U, 69U, 112U};
    FxProcessContext midiContext{};
    midiContext.midiEvents = &note;
    midiContext.midiEventCount = 1U;
    if (!require(withMidi.processBlockWithContext(input, midiOutput, 2U, frames,
                                                 controls, 2U, midiContext) &&
                 withoutMidi.processBlockWithContext(input, controlOutput, 2U, frames,
                                                    controls, 2U, FxProcessContext{}),
                 "OSC VOC(M) accepts a typed NoteOn at frame 37")) return false;
    double postEventDifferenceEnergy = 0.0;
    for (std::uint32_t frame = 0U; frame < 37U; ++frame)
        if (!require(midiL[frame] == controlL[frame] && midiR[frame] == controlR[frame],
                     "timed MIDI has no effect before its declared sample offset")) return false;
    for (std::uint32_t frame = 37U; frame < frames; ++frame) {
        const double left = static_cast<double>(midiL[frame]) - controlL[frame];
        const double right = static_cast<double>(midiR[frame]) - controlR[frame];
        postEventDifferenceEnergy += left * left + right * right;
    }
    return require(postEventDifferenceEnergy > 1.0e-8,
                   "timed NoteOn changes later stereo PCM after frame 37");
}

bool testCombinedCapacityAndNoAlloc() {
    using namespace webrc::dsp;
    constexpr std::uint32_t frames = 64U;
    const ProcessSpec spec{48000.0f, frames, 2U};
    MusicalFxRegistryBridge bridge(21U);
    if (!require(bridge.prepare(spec), "capacity bridge prepares")) return false;
    std::array<float, frames> inL{};
    std::array<float, frames> inR{};
    std::array<float, frames> outL{};
    std::array<float, frames> outR{};
    fillInput(inL.data(), inR.data(), frames);
    const float* input[2]{inL.data(), inR.data()};
    float* output[2]{outL.data(), outR.data()};
    std::array<FxParameterEvent, 33U> parameters{};
    std::array<FxMidiEvent, 32U> midi{};
    for (std::uint32_t i = 0U; i < parameters.size(); ++i)
        parameters[i] = {0U, FxParameterId::Mix, 0.5f};
    for (std::uint32_t i = 0U; i < midi.size(); ++i)
        midi[i] = {0U, FxMidiEventType::AllNotesOff, 0U, 60U, 0U};
    FxProcessContext context{};
    context.midiEvents = midi.data();
    context.midiEventCount = static_cast<std::uint32_t>(midi.size());
    outL.fill(-13.0f);
    outR.fill(-13.0f);
    if (!require(!bridge.processBlockWithContext(input, output, 2U, frames,
                                                 parameters.data(),
                                                 static_cast<std::uint32_t>(parameters.size()),
                                                 context),
                 "33 parameter plus 32 MIDI events reject total 65")) return false;
    if (!require(outL[0] == -13.0f && outR[0] == -13.0f,
                 "over-capacity event list leaves caller output unchanged")) return false;

    const FxParameterEvent validMix[1]{{0U, FxParameterId::Mix, 0.5f}};
    const FxMidiEvent wrongChannel[1]{{0U, FxMidiEventType::NoteOn, 1U, 60U, 100U}};
    FxProcessContext invalidChannelContext{};
    invalidChannelContext.midiEvents = wrongChannel;
    invalidChannelContext.midiEventCount = 1U;
    if (!require(!bridge.processBlockWithContext(input, output, 2U, frames,
                                                 validMix, 1U, invalidChannelContext),
                 "unsupported nonzero MIDI channel is rejected before render")) return false;

    std::array<FxParameterEvent, 32U> exactParameters{};
    for (std::uint32_t i = 0U; i < exactParameters.size(); ++i)
        exactParameters[i] = {0U, FxParameterId::Mix, 0.5f};
    context.midiEventCount = 32U;
    if (!require(bridge.processBlockWithContext(input, output, 2U, frames,
                                               exactParameters.data(), 32U, context),
                 "exactly 64 mixed parameter and MIDI events are accepted")) return false;

    MusicalFxRegistryBridge realtime(22U);
    if (!require(realtime.prepare(spec), "no-allocation OSC BOT bridge prepares")) return false;
    const FxParameterEvent control[2]{{0U, FxParameterId::OscNoteMidi, 60.0f},
                                      {31U, FxParameterId::ToneMacro, 15.0f}};
    for (int run = 0; run < 2; ++run) {
        gNewCount.store(0U, std::memory_order_relaxed);
        gDeleteCount.store(0U, std::memory_order_relaxed);
        gMeasureAllocations.store(true, std::memory_order_release);
        const bool ok = realtime.processBlockWithContext(input, output, 2U, frames,
                                                         control, 2U, FxProcessContext{});
        gMeasureAllocations.store(false, std::memory_order_release);
        if (!require(ok, "measured bridge block succeeds")) return false;
        if (!require(gNewCount.load(std::memory_order_relaxed) == 0U &&
                     gDeleteCount.load(std::memory_order_relaxed) == 0U,
                     "typed bridge callback performs no C++ allocation or deletion")) return false;
    }

    MusicalFxRegistryBridge carrierBridge(20U);
    MusicalFxRegistryBridge carrierReference(20U);
    if (!require(carrierBridge.prepare(spec), "external-carrier no-allocation bridge prepares")) return false;
    if (!require(carrierReference.prepare(spec), "external-carrier reference bridge prepares")) return false;
    std::array<float, frames> carrierL{};
    std::array<float, frames> carrierR{};
    fillInput(carrierL.data(), carrierR.data(), frames, 19U);
    FxProcessContext carrierContext{};
    carrierContext.carrierLeft = carrierL.data();
    carrierContext.carrierRight = carrierR.data();
    carrierContext.carrierFrames = frames;
    carrierContext.carrierChannels = 2U;
    const FxParameterEvent carrierControls[2]{{0U, FxParameterId::Active, 1.0f},
                                              {0U, FxParameterId::Mix, 1.0f}};
    FxProcessor* carrierBase = &carrierBridge;
    outL.fill(-24.0f);
    outR.fill(-24.0f);
    const FxProcessContext noCarrier{};
    if (!require(!carrierBase->processBlockWithContext(input, output, 2U, frames,
                                                       carrierControls, 2U, noCarrier) &&
                 outL[0] == -24.0f && outR[0] == -24.0f,
                 "polymorphic VOCODER20 context rejects missing carrier without output mutation"))
        return false;
    gNewCount.store(0U, std::memory_order_relaxed);
    gDeleteCount.store(0U, std::memory_order_relaxed);
    gMeasureAllocations.store(true, std::memory_order_release);
    const bool carrierOk = carrierBase->processBlockWithContext(
        input, output, 2U, frames, carrierControls, 2U, carrierContext);
    gMeasureAllocations.store(false, std::memory_order_release);
    if (!require(carrierOk, "VOCODER20 carrier callback succeeds through FxProcessor under allocation guard") ||
        !require(gNewCount.load(std::memory_order_relaxed) == 0U &&
                 gDeleteCount.load(std::memory_order_relaxed) == 0U,
                 "VOCODER20 external-carrier callback performs no allocation or deletion")) return false;
    std::array<float, frames> referenceCarrierOutL{};
    std::array<float, frames> referenceCarrierOutR{};
    float* referenceCarrierOutput[2]{referenceCarrierOutL.data(), referenceCarrierOutR.data()};
    if (!require(carrierReference.processBlockWithContext(
                     input, referenceCarrierOutput, 2U, frames, carrierControls, 2U, carrierContext),
                 "the reference carrier path processes only the accepted combined control batch")) return false;
    for (std::uint32_t frame = 0U; frame < frames; ++frame)
        if (!require(outL[frame] == referenceCarrierOutL[frame] &&
                     outR[frame] == referenceCarrierOutR[frame],
                     "the failed polymorphic missing-carrier call changed neither parameters nor DSP state"))
            return false;

    MusicalFxRegistryBridge midiBridge(21U);
    if (!require(midiBridge.prepare(spec), "typed-MIDI no-allocation bridge prepares")) return false;
    const FxMidiEvent timedNotes[2]{{7U, FxMidiEventType::NoteOn, 0U, 60U, 100U},
                                    {51U, FxMidiEventType::NoteOff, 0U, 60U, 0U}};
    FxProcessContext midiContext{};
    midiContext.midiEvents = timedNotes;
    midiContext.midiEventCount = 2U;
    FxProcessor* midiBase = &midiBridge;
    const FxParameterEvent midiControls[2]{{0U, FxParameterId::Active, 1.0f},
                                           {0U, FxParameterId::Mix, 1.0f}};
    gNewCount.store(0U, std::memory_order_relaxed);
    gDeleteCount.store(0U, std::memory_order_relaxed);
    gMeasureAllocations.store(true, std::memory_order_release);
    const bool midiOk = midiBase->processBlockWithContext(
        input, output, 2U, frames, midiControls, 2U, midiContext);
    gMeasureAllocations.store(false, std::memory_order_release);
    if (!require(midiOk, "timed MIDI callback succeeds under allocation guard") ||
        !require(gNewCount.load(std::memory_order_relaxed) == 0U &&
                 gDeleteCount.load(std::memory_order_relaxed) == 0U,
                 "typed-MIDI callback performs no allocation or deletion")) return false;
    return true;
}

bool testCarrierStereoRouteAndPreparePreservation() {
    using namespace webrc::dsp;
    constexpr std::uint32_t frames = 256U;
    const ProcessSpec spec{48000.0f, frames, 2U};
    MusicalFxRegistryBridge bridge(20U);
    if (!require(bridge.prepare(spec), "VOCODER20 bridge prepares")) return false;
    std::array<float, frames> modL{};
    std::array<float, frames> modR{};
    std::array<float, frames> carL{};
    std::array<float, frames> carR{};
    std::array<float, frames> outL{};
    std::array<float, frames> outR{};
    fillInput(modL.data(), modR.data(), frames);
    constexpr double twoPi = 6.283185307179586476925286766559;
    double leftEnergy = 0.0;
    double rightEnergy = 0.0;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        carL[i] = 0.4f * static_cast<float>(std::sin(twoPi * 440.0 * i / 48000.0));
        carR[i] = 0.0f;
    }
    const float* input[2]{modL.data(), modR.data()};
    float* output[2]{outL.data(), outR.data()};
    FxProcessContext context{};
    context.carrierLeft = carL.data();
    context.carrierRight = carR.data();
    context.carrierFrames = frames;
    context.carrierChannels = 2U;
    const FxParameterEvent carrierControls[2]{{0U, FxParameterId::Active, 1.0f},
                                               {0U, FxParameterId::Mix, 1.0f}};
    if (!require(bridge.processBlockWithContext(input, output, 2U, frames,
                                               carrierControls, 2U, context),
                 "external stereo carrier context reaches VOCODER20")) return false;
    for (std::uint32_t warm = 0U; warm < 32U; ++warm)
        if (!require(bridge.processBlockWithContext(input, output, 2U, frames,
                                                   nullptr, 0U, context),
                     "VOCODER20 active/mix ramp settles on the routed carrier")) return false;
    if (!require(bridge.processBlockWithContext(input, output, 2U, frames,
                                               nullptr, 0U, context),
                 "VOCODER20 retains the same stereo carrier route after warmup")) return false;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        leftEnergy += static_cast<double>(outL[i]) * outL[i];
        rightEnergy += static_cast<double>(outR[i]) * outR[i];
    }
    std::printf("BRIDGE_VOCODER20_CARRIER_LR_ENERGY %.9g %.9g\n", leftEnergy, rightEnergy);
    if (!require(leftEnergy > 1.0e-5 && rightEnergy < 1.0e-9,
                 "left-only carrier stays independent of the zero right carrier")) return false;

    const auto smallerPeak = bridge.replacementPeakBytes(ProcessSpec{48000.0f, 128U, 2U});
    if (!require(smallerPeak > 0U, "replacement peak estimator supports a smaller candidate")) return false;
    bridge.setMaximumPreparePeakBytes(smallerPeak - 1U);
    if (!require(!bridge.prepare(ProcessSpec{48000.0f, 128U, 2U}),
                 "insufficient bridge replacement peak rejects before swapping")) return false;
    if (!require(bridge.validateBlockRequest(2U, frames),
                 "failed replacement preserves the old prepared bridge")) return false;
    bridge.setMaximumPreparePeakBytes(static_cast<std::size_t>(-1));
    if (!require(bridge.processBlockWithContext(input, output, 2U, frames,
                                               nullptr, 0U, context),
                 "old carrier route remains usable after failed replacement")) return false;
    return true;
}

} // namespace

void* operator new(std::size_t size) {
    if (gMeasureAllocations.load(std::memory_order_acquire))
        gNewCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}

void* operator new[](std::size_t size) {
    if (gMeasureAllocations.load(std::memory_order_acquire))
        gNewCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}

void operator delete(void* memory) noexcept {
    if (gMeasureAllocations.load(std::memory_order_acquire) && memory != nullptr)
        gDeleteCount.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}

void operator delete[](void* memory) noexcept {
    if (gMeasureAllocations.load(std::memory_order_acquire) && memory != nullptr)
        gDeleteCount.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept {
    if (gMeasureAllocations.load(std::memory_order_acquire) && memory != nullptr)
        gDeleteCount.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}

void operator delete[](void* memory, std::size_t) noexcept {
    if (gMeasureAllocations.load(std::memory_order_acquire) && memory != nullptr)
        gDeleteCount.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}

int main() {
    using namespace webrc::dsp;
    const bool ok = testAllKinds() && testParameterMappingAndQueue() &&
                    testSuccessfulReprepareRestartsTimeline() &&
                    testParameterOnlyContextEntryIsAtomicForExternalCarrier() &&
                    testAllMappedControlsRunThroughBridge() &&
                    testCombinedMidiTransactionsAndSplit() &&
                    testMidiEventChangesAudioAtItsSampleOffset() &&
                    testCombinedCapacityAndNoAlloc() &&
                    testCarrierStereoRouteAndPreparePreservation();
    if (!ok) return 1;
    std::puts("musical_fx_registry_bridge_tests: PASS");
    return 0;
}
