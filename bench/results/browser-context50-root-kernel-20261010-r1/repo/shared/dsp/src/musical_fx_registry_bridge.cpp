#include "webrc/dsp/musical_fx_registry_bridge.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::dsp {
namespace {

[[nodiscard]] bool validSpec(const ProcessSpec& spec) noexcept {
    return std::isfinite(spec.sampleRate) && spec.sampleRate >= 8000.0f &&
           spec.sampleRate <= 384000.0f && spec.channels == 2U &&
           spec.maxBlockFrames > 0U && spec.maxBlockFrames <= 8192U;
}

[[nodiscard]] bool isInteger(float value) noexcept {
    return std::isfinite(value) && std::floor(value) == value;
}

[[nodiscard]] bool checkedAdd(std::size_t a, std::size_t b,
                              std::size_t& output) noexcept {
    if (a > std::numeric_limits<std::size_t>::max() - b) return false;
    output = a + b;
    return true;
}

[[nodiscard]] bool checkedMultiply(std::size_t a, std::size_t b,
                                   std::size_t& output) noexcept {
    if (a != 0U && b > std::numeric_limits<std::size_t>::max() / a) return false;
    output = a * b;
    return true;
}

[[nodiscard]] std::uint16_t optionsOrdinal(const MusicalFxOptions& options) noexcept {
    switch (MusicalFxAdapter::kindForOptions(options)) {
    case MusicalFxKind::Synth: return 6U;
    case MusicalFxKind::GuitarToBass: return 10U;
    case MusicalFxKind::AutoRiff: return 12U;
    case MusicalFxKind::Robot: return 16U;
    case MusicalFxKind::Electric: return 17U;
    case MusicalFxKind::HarmonyAuto: return 19U;
    case MusicalFxKind::Vocoder: return 20U;
    case MusicalFxKind::OscVocMidi: return 21U;
    case MusicalFxKind::OscBot: return 22U;
    case MusicalFxKind::Unprepared: return 0U;
    }
    return 0U;
}

} // namespace

MusicalFxRegistryBridge::MusicalFxRegistryBridge(std::uint16_t ordinal) noexcept
    : ordinal_(ordinal) {
    (void)makeDefaultOptions(ordinal_, options_);
}

std::size_t MusicalFxRegistryBridge::requiredPrepareBytes(
    std::uint16_t ordinal, const ProcessSpec& spec,
    const MusicalFxOptions* requestedOptions) noexcept {
    if (!validSpec(spec)) return 0U;
    MusicalFxOptions defaults{};
    if (requestedOptions == nullptr) {
        if (!makeDefaultOptions(ordinal, defaults)) return 0U;
        requestedOptions = &defaults;
    }
    if (optionsOrdinal(*requestedOptions) != ordinal) return 0U;
    const std::size_t adapterBytes = MusicalFxAdapter::requiredPrepareBytes(spec,
                                                                            *requestedOptions);
    std::size_t scratchFrames = 0U;
    std::size_t scratchBytes = 0U;
    std::size_t total = 0U;
    if (adapterBytes == 0U ||
        !checkedMultiply(static_cast<std::size_t>(spec.maxBlockFrames), 2U, scratchFrames) ||
        !checkedMultiply(scratchFrames, sizeof(StereoFrame), scratchBytes) ||
        !checkedAdd(sizeof(MusicalFxRegistryBridge), adapterBytes, total) ||
        !checkedAdd(total, scratchBytes, total)) return 0U;
    return total;
}

std::size_t MusicalFxRegistryBridge::replacementPeakBytes(
    const ProcessSpec& spec) const noexcept {
    const std::size_t candidate = requiredPrepareBytes(ordinal_, spec, &options_);
    if (candidate == 0U) return 0U;
    std::size_t scratchFrames = 0U;
    std::size_t newScratch = 0U;
    std::size_t oldScratch = 0U;
    std::size_t outer = 0U;
    if (!checkedMultiply(static_cast<std::size_t>(spec.maxBlockFrames), 2U, scratchFrames) ||
        !checkedMultiply(scratchFrames, sizeof(StereoFrame), newScratch)) return 0U;
    if (prepared_) {
        if (!checkedMultiply(static_cast<std::size_t>(spec_.maxBlockFrames), 2U, scratchFrames) ||
            !checkedMultiply(scratchFrames, sizeof(StereoFrame), oldScratch)) return 0U;
    }
    if (!checkedAdd(sizeof(MusicalFxRegistryBridge), newScratch, outer) ||
        !checkedAdd(outer, oldScratch, outer)) return 0U;

    const std::size_t adapterPeak = adapter_.replacementPeakBytes(spec, options_);
    std::size_t peak = 0U;
    if (adapterPeak == 0U || !checkedAdd(adapterPeak, outer, peak)) return 0U;
    return peak;
}

bool MusicalFxRegistryBridge::setOptions(const MusicalFxOptions& options) noexcept {
    if (prepared_ || MusicalFxAdapter::kindForOptions(options) == MusicalFxKind::Unprepared)
        return false;
    if (optionsOrdinal(options) != ordinal_) return false;
    options_ = options;
    return true;
}

void MusicalFxRegistryBridge::setMaximumPreparePeakBytes(std::size_t bytes) noexcept {
    maximumPreparePeakBytes_ = bytes;
}

bool MusicalFxRegistryBridge::prepare(const ProcessSpec& spec) noexcept {
    if (!validSpec(spec)) return false;
    const std::size_t required = requiredPrepareBytes(ordinal_, spec, &options_);
    const std::size_t peak = replacementPeakBytes(spec);
    if (required == 0U || peak == 0U || peak > maximumPreparePeakBytes_) return false;

    std::size_t candidateFrames = 0U;
    std::size_t candidateScratchBytes = 0U;
    if (!checkedMultiply(static_cast<std::size_t>(spec.maxBlockFrames), 2U,
                         candidateFrames) ||
        !checkedMultiply(candidateFrames, sizeof(StereoFrame), candidateScratchBytes))
        return false;
    std::unique_ptr<StereoFrame[]> newAudio(
        new (std::nothrow) StereoFrame[spec.maxBlockFrames]);
    if (!newAudio) return false;
    std::unique_ptr<StereoFrame[]> newCarrier(
        new (std::nothrow) StereoFrame[spec.maxBlockFrames]);
    if (!newCarrier) return false;

    std::size_t externalPeak = sizeof(MusicalFxRegistryBridge);
    std::size_t oldScratchBytes = 0U;
    if (prepared_) {
        std::size_t oldFrames = 0U;
        if (!checkedMultiply(static_cast<std::size_t>(spec_.maxBlockFrames), 2U, oldFrames) ||
            !checkedMultiply(oldFrames, sizeof(StereoFrame), oldScratchBytes)) return false;
    }
    if (!checkedAdd(externalPeak, candidateScratchBytes, externalPeak) ||
        !checkedAdd(externalPeak, oldScratchBytes, externalPeak) ||
        externalPeak > maximumPreparePeakBytes_) return false;
    const std::size_t adapterBudget = maximumPreparePeakBytes_ - externalPeak;
    if (!adapter_.prepare(spec, options_, adapterBudget)) return false;

    audioScratch_.swap(newAudio);
    carrierScratch_.swap(newCarrier);
    spec_ = spec;
    preparedBytes_ = required;
    prepared_ = true;
    // adapter_.prepare stages a new processor generation at frame zero. Keep
    // the bridge timeline in lockstep when a prepared route is replaced.
    nextFrame_ = 0U;
    return true;
}

void MusicalFxRegistryBridge::reset() noexcept {
    if (prepared_) adapter_.reset();
    pendingSetterCount_ = 0U;
    nextFrame_ = 0U;
}

bool MusicalFxRegistryBridge::validateBlockRequest(std::uint32_t channels,
                                                   std::uint32_t frames) const noexcept {
    return prepared_ && channels == 2U && channels == spec_.channels &&
           frames > 0U && frames <= spec_.maxBlockFrames;
}

bool MusicalFxRegistryBridge::mapParameter(FxParameterId id, float value,
                                           MappedParameter& mapped) const noexcept {
    if (!std::isfinite(value)) return false;
    switch (id) {
    case FxParameterId::Active:
        mapped = {MusicalFxParameter::Active, value}; return true;
    case FxParameterId::Mix:
        mapped = {MusicalFxParameter::Mix, value}; return true;
    case FxParameterId::TempoBpm:
        mapped = {MusicalFxParameter::TempoBpm, value}; return true;
    case FxParameterId::Waveform:
        mapped = {MusicalFxParameter::Waveform, value}; return true;
    case FxParameterId::OutputDb:
        mapped = {MusicalFxParameter::OutputDb, value}; return true;
    case FxParameterId::Semitones:
        mapped = {MusicalFxParameter::ShiftSemitones, value}; return true;
    case FxParameterId::AttackMs:
        mapped = {MusicalFxParameter::EnvelopeAttackMs, value}; return true;
    case FxParameterId::ReleaseMs:
        mapped = {MusicalFxParameter::EnvelopeReleaseMs, value}; return true;
    case FxParameterId::Pan:
        if (ordinal_ != 19U) return false;
        mapped = {MusicalFxParameter::Pan, value * 50.0f}; return true;
    default: break;
    }

    // These are reconstruction-safe runtime controls assigned by the global
    // registry; the shared adapter retains its independent local enum.
    switch (id) {
    case FxParameterId::SynthFrequencyMacro:
        mapped = {MusicalFxParameter::Frequency, value}; return true;
    case FxParameterId::SynthResonanceMacro:
        mapped = {MusicalFxParameter::Resonance, value}; return true;
    case FxParameterId::SynthDecayMacro:
        mapped = {MusicalFxParameter::Decay, value}; return true;
    case FxParameterId::BalancePercent:
        mapped = {MusicalFxParameter::Balance,
                  ordinal_ == 22U ? value * 0.01f : value};
        return true;
    case FxParameterId::ModeIndex: mapped = {MusicalFxParameter::Mode, value}; return true;
    case FxParameterId::PhraseIndex: mapped = {MusicalFxParameter::Phrase, value}; return true;
    case FxParameterId::Hold: mapped = {MusicalFxParameter::Hold, value}; return true;
    case FxParameterId::Loop: mapped = {MusicalFxParameter::Loop, value}; return true;
    case FxParameterId::AttackMacro: mapped = {MusicalFxParameter::Attack, value}; return true;
    case FxParameterId::KeyIndex: mapped = {MusicalFxParameter::Key, value}; return true;
    case FxParameterId::NoteClass: mapped = {MusicalFxParameter::NoteClass, value}; return true;
    case FxParameterId::FormantMacro: mapped = {MusicalFxParameter::Formant, value}; return true;
    case FxParameterId::SpeedMacro: mapped = {MusicalFxParameter::Speed, value}; return true;
    case FxParameterId::StabilityMacro: mapped = {MusicalFxParameter::Stability, value}; return true;
    case FxParameterId::ScaleRoot: mapped = {MusicalFxParameter::ScaleRoot, value}; return true;
    case FxParameterId::VoiceSelector: mapped = {MusicalFxParameter::Voice, value}; return true;
    case FxParameterId::DryLevelPercent: mapped = {MusicalFxParameter::DryLevel, value}; return true;
    case FxParameterId::HarmonyLevelPercent: mapped = {MusicalFxParameter::HarmonyLevel, value}; return true;
    case FxParameterId::ToneMacro: mapped = {MusicalFxParameter::Tone, value}; return true;
    case FxParameterId::ModulationSensitivityMacro:
        mapped = {MusicalFxParameter::ModulationSensitivity, value}; return true;
    case FxParameterId::OscNoteMidi: mapped = {MusicalFxParameter::OscNote, value}; return true;
    case FxParameterId::PatternIndex: mapped = {MusicalFxParameter::Pattern, value}; return true;
    default: return false;
    }
}

bool MusicalFxRegistryBridge::parameterValueValid(MusicalFxParameter parameter,
                                                  float value) const noexcept {
    if (!std::isfinite(value)) return false;
    switch (parameter) {
    case MusicalFxParameter::Active: return value == 0.0f || value == 1.0f;
    case MusicalFxParameter::Mix:
        return (ordinal_ == 16U || ordinal_ == 17U || ordinal_ == 20U ||
                ordinal_ == 21U || ordinal_ == 22U) && value >= 0.0f && value <= 1.0f;
    case MusicalFxParameter::Frequency:
    case MusicalFxParameter::Resonance:
    case MusicalFxParameter::Decay:
        return ordinal_ == 6U && value >= 0.0f && value <= 100.0f;
    case MusicalFxParameter::Balance:
        if (ordinal_ == 22U) return value >= 0.0f && value <= 1.0f;
        return (ordinal_ == 6U || ordinal_ == 10U || ordinal_ == 12U) &&
               value >= 0.0f && value <= 100.0f;
    case MusicalFxParameter::Mode:
        if (ordinal_ == 19U) return value == 1.0f || value == 2.0f;
        return (ordinal_ == 10U || ordinal_ == 16U) && isInteger(value) &&
               value >= 1.0f && value <= 2.0f;
    case MusicalFxParameter::Phrase: return ordinal_ == 12U && isInteger(value) && value >= 1.0f && value <= 30.0f;
    case MusicalFxParameter::TempoBpm: return ordinal_ == 12U && value >= 30.0f && value <= 300.0f;
    case MusicalFxParameter::Hold:
    case MusicalFxParameter::Loop:
        return ordinal_ == 12U && (value == 0.0f || value == 1.0f);
    case MusicalFxParameter::Attack:
        return (ordinal_ == 12U || ordinal_ == 22U) && value >= 0.0f && value <= 100.0f;
    case MusicalFxParameter::Key:
        return (ordinal_ == 12U || ordinal_ == 19U) && isInteger(value) &&
               value >= 0.0f && value <= 11.0f;
    case MusicalFxParameter::Voice:
        return ordinal_ == 19U && isInteger(value) && value >= 0.0f && value <= 6.0f;
    case MusicalFxParameter::Formant:
        return (ordinal_ == 16U || ordinal_ == 17U || ordinal_ == 19U) &&
               value >= -50.0f && value <= 50.0f;
    case MusicalFxParameter::Pan:
        return ordinal_ == 19U && value >= -50.0f && value <= 50.0f;
    case MusicalFxParameter::DryLevel:
    case MusicalFxParameter::HarmonyLevel:
        return ordinal_ == 19U && value >= 0.0f && value <= 100.0f;
    case MusicalFxParameter::NoteClass:
        return ordinal_ == 16U && isInteger(value) && value >= 0.0f && value <= 11.0f;
    case MusicalFxParameter::ShiftSemitones:
        return ordinal_ == 17U && value >= -12.0f && value <= 12.0f;
    case MusicalFxParameter::Speed: return ordinal_ == 17U && value >= 0.0f && value <= 10.0f;
    case MusicalFxParameter::Stability:
        return ordinal_ == 17U && value >= -10.0f && value <= 10.0f;
    case MusicalFxParameter::ScaleRoot:
        return ordinal_ == 17U && isInteger(value) && value >= -1.0f && value <= 11.0f;
    case MusicalFxParameter::Waveform:
        return (ordinal_ == 21U || ordinal_ == 22U) && isInteger(value) &&
               value >= 0.0f && value <= 4.0f;
    case MusicalFxParameter::Tone:
        return ordinal_ == 22U && value >= -50.0f && value <= 50.0f;
    case MusicalFxParameter::OscNote:
        return ordinal_ == 22U && isInteger(value) && value >= 24.0f && value <= 127.0f;
    case MusicalFxParameter::ModulationSensitivity:
        return ordinal_ == 22U && value >= -50.0f && value <= 50.0f;
    case MusicalFxParameter::Pattern:
        return ordinal_ == 22U && isInteger(value) && value >= 0.0f && value <= 3.0f;
    case MusicalFxParameter::OutputDb:
        return (ordinal_ == 20U || ordinal_ == 21U) && value >= -60.0f && value <= 12.0f;
    case MusicalFxParameter::EnvelopeAttackMs:
        return (ordinal_ == 20U || ordinal_ == 21U) && value >= 0.1f && value <= 500.0f;
    case MusicalFxParameter::EnvelopeReleaseMs:
        return (ordinal_ == 20U || ordinal_ == 21U) && value >= 1.0f && value <= 3000.0f;
    }
    return false;
}

bool MusicalFxRegistryBridge::validParameter(FxParameterId id, float value) const noexcept {
    MappedParameter mapped{};
    return mapParameter(id, value, mapped) &&
           parameterValueValid(mapped.parameter, mapped.value);
}

bool MusicalFxRegistryBridge::validateParameterEvents(
    const FxParameterEvent* events, std::uint32_t eventCount) const noexcept {
    if ((eventCount != 0U && events == nullptr) || eventCount > kMaximumEventsPerBlock ||
        eventCount + pendingSetterCount_ > kMaximumEventsPerBlock) return false;
    for (std::uint32_t i = 0U; i < eventCount; ++i)
        if (!validParameter(events[i].parameter, events[i].value)) return false;
    return true;
}

bool MusicalFxRegistryBridge::canAcceptParameterEvents(std::uint32_t eventCount) const noexcept {
    return eventCount <= kMaximumEventsPerBlock &&
           eventCount + pendingSetterCount_ <= kMaximumEventsPerBlock;
}

bool MusicalFxRegistryBridge::setParameter(FxParameterId id, float value) noexcept {
    if (!validParameter(id, value) ||
        pendingSetterCount_ >= kMaximumEventsPerBlock) return false;
    MappedParameter mapped{};
    if (!mapParameter(id, value, mapped)) return false;
    pendingSetters_[pendingSetterCount_++] = {0U, MusicalFxEventType::Parameter,
                                               mapped.parameter, mapped.value};
    return true;
}

bool MusicalFxRegistryBridge::validateContext(const FxProcessContext& context,
                                             std::uint32_t frames) const noexcept {
    if (context.midiEventCount > kMaximumEventsPerBlock ||
        (context.midiEventCount != 0U && context.midiEvents == nullptr)) return false;
    const bool carrierGiven = context.carrierLeft != nullptr || context.carrierRight != nullptr ||
                              context.carrierFrames != 0U || context.carrierChannels != 0U;
    if (ordinal_ == 20U) {
        if (context.midiEventCount != 0U || !carrierGiven ||
            context.carrierChannels != 2U || context.carrierFrames != frames ||
            context.carrierLeft == nullptr || context.carrierRight == nullptr) return false;
    } else if (carrierGiven) {
        return false;
    }
    if (context.midiEventCount != 0U && ordinal_ != 19U && ordinal_ != 21U) return false;

    std::uint32_t previousOffset = 0U;
    for (std::uint32_t i = 0U; i < context.midiEventCount; ++i) {
        const auto& event = context.midiEvents[i];
        if (event.frameOffset >= frames ||
            (i != 0U && event.frameOffset < previousOffset) || event.channel != 0U ||
            event.note > 127U || event.velocity > 127U) return false;
        previousOffset = event.frameOffset;
        switch (event.type) {
        case FxMidiEventType::NoteOn:
            if (event.velocity == 0U) return false;
            break;
        case FxMidiEventType::NoteOff:
        case FxMidiEventType::AllNotesOff:
            break;
        default:
            return false;
        }
    }
    return true;
}

bool MusicalFxRegistryBridge::processBlock(
    const float* const* inputPlanar, float* const* outputPlanar,
    std::uint32_t channels, std::uint32_t frames) noexcept {
    const FxProcessContext empty{};
    return processInternal(inputPlanar, outputPlanar, nullptr, nullptr, channels, frames,
                           nullptr, 0U, empty);
}

bool MusicalFxRegistryBridge::processBlockWithEvents(
    const float* const* inputPlanar, float* const* outputPlanar,
    std::uint32_t channels, std::uint32_t frames,
    const FxParameterEvent* events, std::uint32_t eventCount) noexcept {
    const FxProcessContext empty{};
    return processInternal(inputPlanar, outputPlanar, nullptr, nullptr, channels, frames,
                           events, eventCount, empty);
}

bool MusicalFxRegistryBridge::processBlockWithContext(
    const float* const* inputPlanar, float* const* outputPlanar,
    std::uint32_t channels, std::uint32_t frames,
    const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount,
    const FxProcessContext& context) noexcept {
    return processInternal(inputPlanar, outputPlanar, context.carrierLeft,
                           context.carrierRight, channels, frames, parameterEvents,
                           parameterEventCount, context);
}

bool MusicalFxRegistryBridge::processBlockWithMusicalEvents(
    const float* const* inputPlanar, float* const* outputPlanar,
    std::uint32_t channels, std::uint32_t frames,
    const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount,
    const FxMidiEvent* midiEvents, std::uint32_t midiEventCount) noexcept {
    FxProcessContext context{};
    context.midiEvents = midiEvents;
    context.midiEventCount = midiEventCount;
    return processBlockWithContext(inputPlanar, outputPlanar, channels, frames,
                                   parameterEvents, parameterEventCount, context);
}

bool MusicalFxRegistryBridge::processBlockWithCarrier(
    const float* const* modulatorPlanar, const float* carrierLeft,
    const float* carrierRight, float* const* outputPlanar,
    std::uint32_t channels, std::uint32_t frames,
    const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount) noexcept {
    FxProcessContext context{};
    context.carrierLeft = carrierLeft;
    context.carrierRight = carrierRight;
    context.carrierFrames = frames;
    context.carrierChannels = 2U;
    return processBlockWithContext(modulatorPlanar, outputPlanar, channels, frames,
                                   parameterEvents, parameterEventCount, context);
}

bool MusicalFxRegistryBridge::processInternal(
    const float* const* inputPlanar, float* const* outputPlanar,
    const float* carrierLeft, const float* carrierRight,
    std::uint32_t channels, std::uint32_t frames,
    const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount,
    const FxProcessContext& context) noexcept {
    if (!validateBlockRequest(channels, frames) || inputPlanar == nullptr ||
        outputPlanar == nullptr || !audioScratch_ || !carrierScratch_ ||
        (parameterEventCount != 0U && parameterEvents == nullptr) ||
        parameterEventCount > kMaximumEventsPerBlock ||
        pendingSetterCount_ + parameterEventCount + context.midiEventCount >
            kMaximumEventsPerBlock || !validateContext(context, frames)) return false;
    if (nextFrame_ > std::numeric_limits<std::uint64_t>::max() - frames) return false;
    if (!inputPlanar[0] || !inputPlanar[1] || !outputPlanar[0] || !outputPlanar[1]) return false;

    std::array<MusicalFxEvent, kMaximumEventsPerBlock> merged{};
    std::uint32_t mergedCount = 0U;
    for (std::uint32_t i = 0U; i < pendingSetterCount_; ++i)
        merged[mergedCount++] = pendingSetters_[i];

    std::uint32_t parameterIndex = 0U;
    std::uint32_t midiIndex = 0U;
    std::uint32_t previousParameterOffset = 0U;
    for (std::uint32_t i = 0U; i < parameterEventCount; ++i) {
        const auto& event = parameterEvents[i];
        if (event.frameOffset >= frames ||
            (i != 0U && event.frameOffset < previousParameterOffset)) return false;
        previousParameterOffset = event.frameOffset;
        MappedParameter mapped{};
        if (!mapParameter(event.parameter, event.value, mapped) ||
            !parameterValueValid(mapped.parameter, mapped.value)) return false;
    }
    while (parameterIndex < parameterEventCount || midiIndex < context.midiEventCount) {
        const bool takeParameter = midiIndex >= context.midiEventCount ||
            (parameterIndex < parameterEventCount &&
             parameterEvents[parameterIndex].frameOffset <=
                 context.midiEvents[midiIndex].frameOffset);
        if (takeParameter) {
            const auto& source = parameterEvents[parameterIndex++];
            MappedParameter mapped{};
            if (!mapParameter(source.parameter, source.value, mapped)) return false;
            merged[mergedCount++] = {source.frameOffset, MusicalFxEventType::Parameter,
                                      mapped.parameter, mapped.value};
        } else {
            const auto& source = context.midiEvents[midiIndex++];
            MusicalFxEvent converted{};
            converted.frameOffset = source.frameOffset;
            converted.channel = source.channel;
            converted.note = source.note;
            converted.velocity = source.velocity;
            switch (source.type) {
            case FxMidiEventType::NoteOn:
                converted.type = MusicalFxEventType::MidiNoteOn; break;
            case FxMidiEventType::NoteOff:
                converted.type = MusicalFxEventType::MidiNoteOff; break;
            case FxMidiEventType::AllNotesOff:
                converted.type = MusicalFxEventType::MidiAllNotesOff; break;
            }
            merged[mergedCount++] = converted;
        }
    }

    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        audioScratch_[frame] = {inputPlanar[0][frame], inputPlanar[1][frame]};
        if (ordinal_ == 20U)
            carrierScratch_[frame] = {carrierLeft[frame], carrierRight[frame]};
    }
    const auto* events = mergedCount == 0U ? nullptr : merged.data();
    const bool processed = ordinal_ == 20U
        ? adapter_.processBlockWithCarrier(nextFrame_, audioScratch_.get(), carrierScratch_.get(),
                                           frames, events, mergedCount)
        : adapter_.processBlock(nextFrame_, audioScratch_.get(), frames, events, mergedCount);
    if (!processed) return false;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        outputPlanar[0][frame] = audioScratch_[frame].left;
        outputPlanar[1][frame] = audioScratch_[frame].right;
    }
    pendingSetterCount_ = 0U;
    nextFrame_ += frames;
    return true;
}

std::int32_t MusicalFxRegistryBridge::fixedLatencySamples() const noexcept {
    if (!prepared_) return 0;
    // The current pitch adapters combine immediate dry and PSOLA-lookahead
    // wet paths. Until those are explicitly aligned, no single fixed delay
    // describes the mixed result, regardless of the current mix control.
    switch (ordinal_) {
    case 10U: // Guitar-to-bass
    case 12U: // Auto riff
    case 16U: // Robot
    case 17U: // Electric
    case 19U: // Harmony auto(M)
        return -1;
    default: break;
    }
    const auto info = adapter_.latency();
    // For the remaining processors, fixed PSOLA lookahead (when present) is
    // an actual audio-path delay. YIN analysis is control-estimator warmup and
    // is reported separately.
    const std::uint64_t fixed = static_cast<std::uint64_t>(info.fixedAlgorithmicSamples) +
                                info.psolaLookaheadSamples;
    return fixed > static_cast<std::uint64_t>(std::numeric_limits<std::int32_t>::max())
        ? std::numeric_limits<std::int32_t>::max()
        : static_cast<std::int32_t>(fixed);
}

std::uint32_t MusicalFxRegistryBridge::startupWarmupFrames() const noexcept {
    if (!prepared_) return 0U;
    const auto info = adapter_.latency();
    const std::uint64_t estimatorAndPath =
        static_cast<std::uint64_t>(info.analysisWindowFrames) +
        info.analysisHopFrames + info.psolaLookaheadSamples;
    const std::uint64_t conservative = std::max<std::uint64_t>(
        info.conservativePitchOnsetFrames, estimatorAndPath);
    return conservative > std::numeric_limits<std::uint32_t>::max()
        ? std::numeric_limits<std::uint32_t>::max()
        : static_cast<std::uint32_t>(conservative);
}

bool MusicalFxRegistryBridge::latencyIsFrequencyDependent() const noexcept {
    // Multiband vocoder filters contribute band-dependent group delay even
    // though they add no whole-sample buffering. Pitch-analysis window/hop and
    // PSOLA startup lookahead are reported through separate measurements.
    return ordinal_ == 20U || ordinal_ == 21U;
}

bool MusicalFxRegistryBridge::makeDefaultOptions(std::uint16_t ordinal,
                                                 MusicalFxOptions& options) noexcept {
    switch (ordinal) {
    case 6U: options = SynthFxOptions{}; return true;
    case 10U: options = GuitarToBassFxOptions{}; return true;
    case 12U: options = AutoRiffFxOptions{}; return true;
    case 16U: options = RobotFxOptions{}; return true;
    case 17U: options = ElectricFxOptions{}; return true;
    case 19U: options = HarmonyAutoFxOptions{}; return true;
    case 20U: {
        VocoderFxOptions value{};
        value.kind = VocoderFxKind::Vocoder;
        options = value;
        return true;
    }
    case 21U: {
        VocoderFxOptions value{};
        value.kind = VocoderFxKind::OscVocMidi;
        options = value;
        return true;
    }
    case 22U: options = OscBotFxOptions{}; return true;
    default: return false;
    }
}

} // namespace webrc::dsp
