#include "webrc/dsp/musical_fx_adapter.hpp"

#include "webrc/dsp/voice_fx.hpp"

#include <array>
#include <cmath>
#include <limits>
#include <new>
#include <type_traits>
#include <utility>
#include <variant>

namespace webrc::dsp {
namespace {

using ProcessorVariant = std::variant<SynthFxProcessor, GuitarToBassFxProcessor,
    AutoRiffFxProcessor, HarmonyAutoFxProcessor, RobotFxProcessor,
    ElectricFxProcessor, VocoderFxProcessor, OscBotFxProcessor>;

[[nodiscard]] bool isMidiType(MusicalFxEventType type) noexcept {
    return type == MusicalFxEventType::MidiNoteOn ||
           type == MusicalFxEventType::MidiNoteOff ||
           type == MusicalFxEventType::MidiAllNotesOff;
}

[[nodiscard]] bool mapMidi(const MusicalFxEvent& source, std::uint8_t& note,
                           float& value, VocoderFxControl& control) noexcept {
    if (source.channel != 0U || source.note > 127U) return false;
    note = source.note;
    switch (source.type) {
    case MusicalFxEventType::MidiNoteOn:
        if (source.velocity == 0U) return false;
        value = static_cast<float>(source.velocity) / 127.0f;
        control = VocoderFxControl::MidiNoteOn;
        return true;
    case MusicalFxEventType::MidiNoteOff:
        value = 0.0f;
        control = VocoderFxControl::MidiNoteOff;
        return true;
    case MusicalFxEventType::MidiAllNotesOff:
        value = 0.0f;
        control = VocoderFxControl::MidiAllNotesOff;
        return true;
    case MusicalFxEventType::Parameter:
        return false;
    }
    return false;
}

[[nodiscard]] bool mapMidi(const MusicalFxEvent& source, std::uint8_t& note,
                           float& value, HarmonyAutoControl& control) noexcept {
    if (source.channel != 0U || source.note > 127U) return false;
    note = source.note;
    switch (source.type) {
    case MusicalFxEventType::MidiNoteOn:
        if (source.velocity == 0U) return false;
        value = static_cast<float>(source.velocity) / 127.0f;
        control = HarmonyAutoControl::MidiNoteOn;
        return true;
    case MusicalFxEventType::MidiNoteOff:
        value = 0.0f;
        control = HarmonyAutoControl::MidiNoteOff;
        return true;
    case MusicalFxEventType::MidiAllNotesOff:
        value = 0.0f;
        control = HarmonyAutoControl::MidiAllNotesOff;
        return true;
    case MusicalFxEventType::Parameter:
        return false;
    }
    return false;
}

[[nodiscard]] bool mapSynth(const MusicalFxEvent& input, SynthFxEvent& output) noexcept {
    if (input.type != MusicalFxEventType::Parameter) return false;
    output.frameOffset = input.frameOffset;
    output.value = input.value;
    switch (input.parameter) {
    case MusicalFxParameter::Active: output.control = SynthFxControl::Active; return true;
    case MusicalFxParameter::Frequency: output.control = SynthFxControl::Frequency; return true;
    case MusicalFxParameter::Resonance: output.control = SynthFxControl::Resonance; return true;
    case MusicalFxParameter::Decay: output.control = SynthFxControl::Decay; return true;
    case MusicalFxParameter::Balance: output.control = SynthFxControl::Balance; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapGuitarToBass(const MusicalFxEvent& input,
                                    GuitarToBassFxEvent& output) noexcept {
    if (input.type != MusicalFxEventType::Parameter) return false;
    output.frameOffset = input.frameOffset;
    output.value = input.value;
    switch (input.parameter) {
    case MusicalFxParameter::Active: output.control = GuitarToBassControl::Active; return true;
    case MusicalFxParameter::Balance: output.control = GuitarToBassControl::Balance; return true;
    case MusicalFxParameter::Mode: output.control = GuitarToBassControl::Mode; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapAutoRiff(const MusicalFxEvent& input, AutoRiffFxEvent& output) noexcept {
    if (input.type != MusicalFxEventType::Parameter) return false;
    output.frameOffset = input.frameOffset;
    output.value = input.value;
    switch (input.parameter) {
    case MusicalFxParameter::Active: output.control = AutoRiffControl::Active; return true;
    case MusicalFxParameter::Phrase: output.control = AutoRiffControl::Phrase; return true;
    case MusicalFxParameter::TempoBpm: output.control = AutoRiffControl::TempoBpm; return true;
    case MusicalFxParameter::Hold: output.control = AutoRiffControl::Hold; return true;
    case MusicalFxParameter::Loop: output.control = AutoRiffControl::Loop; return true;
    case MusicalFxParameter::Attack: output.control = AutoRiffControl::Attack; return true;
    case MusicalFxParameter::Key: output.control = AutoRiffControl::Key; return true;
    case MusicalFxParameter::Balance: output.control = AutoRiffControl::Balance; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapHarmony(const MusicalFxEvent& input,
                               HarmonyAutoFxEvent& output) noexcept {
    output.frameOffset = input.frameOffset;
    if (isMidiType(input.type)) {
        output.midiNote = input.note;
        return mapMidi(input, output.midiNote, output.value, output.control);
    }
    if (input.type != MusicalFxEventType::Parameter) return false;
    output.value = input.value;
    switch (input.parameter) {
    case MusicalFxParameter::Active: output.control = HarmonyAutoControl::Active; return true;
    case MusicalFxParameter::Voice: output.control = HarmonyAutoControl::Voice; return true;
    case MusicalFxParameter::Formant: output.control = HarmonyAutoControl::Formant; return true;
    case MusicalFxParameter::Pan: output.control = HarmonyAutoControl::Pan; return true;
    case MusicalFxParameter::Mode: output.control = HarmonyAutoControl::Mode; return true;
    case MusicalFxParameter::Key: output.control = HarmonyAutoControl::Key; return true;
    case MusicalFxParameter::DryLevel: output.control = HarmonyAutoControl::DryLevel; return true;
    case MusicalFxParameter::HarmonyLevel:
        output.control = HarmonyAutoControl::HarmonyLevel; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapRobot(const MusicalFxEvent& input, RobotFxEvent& output) noexcept {
    if (input.type != MusicalFxEventType::Parameter) return false;
    output.frameOffset = input.frameOffset;
    output.value = input.value;
    switch (input.parameter) {
    case MusicalFxParameter::Active: output.control = RobotFxControl::Active; return true;
    case MusicalFxParameter::Mix: output.control = RobotFxControl::Mix; return true;
    case MusicalFxParameter::NoteClass: output.control = RobotFxControl::NoteClass; return true;
    case MusicalFxParameter::Mode: output.control = RobotFxControl::Mode; return true;
    case MusicalFxParameter::Formant: output.control = RobotFxControl::Formant; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapElectric(const MusicalFxEvent& input, ElectricFxEvent& output) noexcept {
    if (input.type != MusicalFxEventType::Parameter) return false;
    output.frameOffset = input.frameOffset;
    output.value = input.value;
    switch (input.parameter) {
    case MusicalFxParameter::Active: output.control = ElectricFxControl::Active; return true;
    case MusicalFxParameter::Mix: output.control = ElectricFxControl::Mix; return true;
    case MusicalFxParameter::ShiftSemitones:
        output.control = ElectricFxControl::ShiftSemitones; return true;
    case MusicalFxParameter::Formant: output.control = ElectricFxControl::Formant; return true;
    case MusicalFxParameter::Speed: output.control = ElectricFxControl::Speed; return true;
    case MusicalFxParameter::Stability: output.control = ElectricFxControl::Stability; return true;
    case MusicalFxParameter::ScaleRoot: output.control = ElectricFxControl::ScaleRoot; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapVocoder(const MusicalFxEvent& input, VocoderFxEvent& output) noexcept {
    output.frameOffset = input.frameOffset;
    if (isMidiType(input.type))
        return mapMidi(input, output.midiNote, output.value, output.control);
    if (input.type != MusicalFxEventType::Parameter) return false;
    output.value = input.value;
    switch (input.parameter) {
    case MusicalFxParameter::Active: output.control = VocoderFxControl::Active; return true;
    case MusicalFxParameter::Mix: output.control = VocoderFxControl::Mix; return true;
    case MusicalFxParameter::OutputDb: output.control = VocoderFxControl::OutputDb; return true;
    case MusicalFxParameter::EnvelopeAttackMs:
        output.control = VocoderFxControl::EnvelopeAttackMs; return true;
    case MusicalFxParameter::EnvelopeReleaseMs:
        output.control = VocoderFxControl::EnvelopeReleaseMs; return true;
    case MusicalFxParameter::Waveform: output.control = VocoderFxControl::Waveform; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapOscBot(const MusicalFxEvent& input, OscBotFxEvent& output) noexcept {
    if (input.type != MusicalFxEventType::Parameter) return false;
    output.frameOffset = input.frameOffset;
    output.value = input.value;
    switch (input.parameter) {
    case MusicalFxParameter::Active: output.control = OscBotControl::Active; return true;
    case MusicalFxParameter::Mix: output.control = OscBotControl::Mix; return true;
    case MusicalFxParameter::Waveform: output.control = OscBotControl::Waveform; return true;
    case MusicalFxParameter::Tone: output.control = OscBotControl::Tone; return true;
    case MusicalFxParameter::Attack: output.control = OscBotControl::Attack; return true;
    case MusicalFxParameter::OscNote:
        // The existing enum's fifth selector slot is `Note`; spelling that
        // token is macro-hostile on the Windows SDK used by this repo.
        output.control = static_cast<OscBotControl>(5U); return true;
    case MusicalFxParameter::ModulationSensitivity:
        output.control = OscBotControl::ModSensitivity; return true;
    case MusicalFxParameter::Balance: output.control = OscBotControl::Balance; return true;
    case MusicalFxParameter::Pattern: output.control = OscBotControl::Pattern; return true;
    default: return false;
    }
}

template <class Processor, class Event, class Mapper>
[[nodiscard]] bool processTyped(Processor& processor, std::uint64_t blockStartFrame,
                                StereoFrame* audio, const StereoFrame* carrier,
                                std::uint32_t frames, const MusicalFxEvent* events,
                                std::uint32_t eventCount, bool carrierPath,
                                Mapper&& mapper) noexcept {
    std::array<Event, MusicalFxAdapter::kMaximumEventsPerBlock> converted{};
    for (std::uint32_t i = 0U; i < eventCount; ++i)
        if (!mapper(events[i], converted[i])) return false;
    const auto* translated = eventCount == 0U ? nullptr : converted.data();
    if constexpr (std::is_same_v<Processor, VocoderFxProcessor>) {
        if (carrierPath)
            return processor.processBlockWithCarrier(blockStartFrame, audio, carrier,
                frames, translated, eventCount);
    }
    return processor.processBlock(blockStartFrame, audio, frames, translated, eventCount);
}

template <class Processor, class Options>
[[nodiscard]] bool prepareCandidate(ProcessorVariant& storage, const ProcessSpec& spec,
                                    const Options& options) {
    auto& processor = storage.emplace<Processor>();
    return processor.prepare(spec, options);
}

} // namespace

struct MusicalFxAdapter::ProcessorStorage {
    ProcessorVariant processor{};
};

MusicalFxAdapter::MusicalFxAdapter() noexcept = default;
MusicalFxAdapter::~MusicalFxAdapter() = default;

MusicalFxKind MusicalFxAdapter::kindForOptions(const MusicalFxOptions& options) noexcept {
    return std::visit([](const auto& value) noexcept -> MusicalFxKind {
        using T = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<T, SynthFxOptions>) return MusicalFxKind::Synth;
        else if constexpr (std::is_same_v<T, GuitarToBassFxOptions>) return MusicalFxKind::GuitarToBass;
        else if constexpr (std::is_same_v<T, AutoRiffFxOptions>) return MusicalFxKind::AutoRiff;
        else if constexpr (std::is_same_v<T, HarmonyAutoFxOptions>) return MusicalFxKind::HarmonyAuto;
        else if constexpr (std::is_same_v<T, RobotFxOptions>) return MusicalFxKind::Robot;
        else if constexpr (std::is_same_v<T, ElectricFxOptions>) return MusicalFxKind::Electric;
        else if constexpr (std::is_same_v<T, VocoderFxOptions>)
            return value.kind == VocoderFxKind::Vocoder
                ? MusicalFxKind::Vocoder : MusicalFxKind::OscVocMidi;
        else return MusicalFxKind::OscBot;
    }, options);
}

std::size_t MusicalFxAdapter::requiredPrepareBytes(const ProcessSpec& spec,
                                                  const MusicalFxOptions& options) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2U) return 0U;
    std::size_t processorBytes = 0U;
    std::size_t concreteBytes = 0U;
    std::visit([&](const auto& value) noexcept {
        using T = std::decay_t<decltype(value)>;
        if constexpr (std::is_same_v<T, SynthFxOptions>) {
            processorBytes = SynthFxProcessor::requiredPrepareBytes(spec);
            concreteBytes = sizeof(SynthFxProcessor);
        } else if constexpr (std::is_same_v<T, GuitarToBassFxOptions>) {
            processorBytes = GuitarToBassFxProcessor::requiredPrepareBytes(spec);
            concreteBytes = sizeof(GuitarToBassFxProcessor);
        } else if constexpr (std::is_same_v<T, AutoRiffFxOptions>) {
            processorBytes = AutoRiffFxProcessor::requiredPrepareBytes(spec);
            concreteBytes = sizeof(AutoRiffFxProcessor);
        } else if constexpr (std::is_same_v<T, HarmonyAutoFxOptions>) {
            processorBytes = HarmonyAutoFxProcessor::requiredPrepareBytes(spec);
            concreteBytes = sizeof(HarmonyAutoFxProcessor);
        } else if constexpr (std::is_same_v<T, RobotFxOptions>) {
            processorBytes = RobotFxProcessor::requiredPrepareBytes(spec, value);
            concreteBytes = sizeof(RobotFxProcessor);
        } else if constexpr (std::is_same_v<T, ElectricFxOptions>) {
            processorBytes = ElectricFxProcessor::requiredPrepareBytes(spec, value);
            concreteBytes = sizeof(ElectricFxProcessor);
        } else if constexpr (std::is_same_v<T, VocoderFxOptions>) {
            processorBytes = VocoderFxProcessor::requiredPrepareBytes(spec, value);
            concreteBytes = sizeof(VocoderFxProcessor);
        } else if constexpr (std::is_same_v<T, OscBotFxOptions>) {
            processorBytes = OscBotFxProcessor::requiredPrepareBytes(spec, value);
            concreteBytes = sizeof(OscBotFxProcessor);
        }
    }, options);
    if (processorBytes == 0U || processorBytes < concreteBytes) return 0U;
    const std::size_t storageBytes = sizeof(ProcessorVariant);
    if (storageBytes < concreteBytes) return 0U;
    const std::size_t adapterBytes = sizeof(MusicalFxAdapter);
    if (processorBytes > std::numeric_limits<std::size_t>::max() - adapterBytes -
                         (storageBytes - concreteBytes)) return 0U;
    return adapterBytes + processorBytes + storageBytes - concreteBytes;
}

std::size_t MusicalFxAdapter::replacementPeakBytes(
    const ProcessSpec& spec, const MusicalFxOptions& options) const noexcept {
    const std::size_t candidate = requiredPrepareBytes(spec, options);
    if (candidate == 0U) return 0U;
    if (!active_) return candidate;
    const std::size_t candidateStorage = candidate - sizeof(MusicalFxAdapter);
    if (preparedBytes_ > std::numeric_limits<std::size_t>::max() - candidateStorage) return 0U;
    return preparedBytes_ + candidateStorage;
}

bool MusicalFxAdapter::prepare(const ProcessSpec& spec, const MusicalFxOptions& options,
                               std::size_t maximumPeakBytes) {
    const std::size_t candidateBytes = requiredPrepareBytes(spec, options);
    const std::size_t peakBytes = replacementPeakBytes(spec, options);
    if (candidateBytes == 0U || peakBytes == 0U || peakBytes > maximumPeakBytes) return false;

    auto candidate = std::unique_ptr<ProcessorStorage>(new (std::nothrow) ProcessorStorage{});
    if (!candidate) return false;
    bool ready = false;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        ready = std::visit([&](const auto& value) {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SynthFxOptions>)
                return prepareCandidate<SynthFxProcessor>(candidate->processor, spec, value);
            else if constexpr (std::is_same_v<T, GuitarToBassFxOptions>)
                return prepareCandidate<GuitarToBassFxProcessor>(candidate->processor, spec, value);
            else if constexpr (std::is_same_v<T, AutoRiffFxOptions>)
                return prepareCandidate<AutoRiffFxProcessor>(candidate->processor, spec, value);
            else if constexpr (std::is_same_v<T, HarmonyAutoFxOptions>)
                return prepareCandidate<HarmonyAutoFxProcessor>(candidate->processor, spec, value);
            else if constexpr (std::is_same_v<T, RobotFxOptions>)
                return prepareCandidate<RobotFxProcessor>(candidate->processor, spec, value);
            else if constexpr (std::is_same_v<T, ElectricFxOptions>)
                return prepareCandidate<ElectricFxProcessor>(candidate->processor, spec, value);
            else if constexpr (std::is_same_v<T, VocoderFxOptions>)
                return prepareCandidate<VocoderFxProcessor>(candidate->processor, spec, value);
            else
                return prepareCandidate<OscBotFxProcessor>(candidate->processor, spec, value);
        }, options);
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif
    if (!ready) return false;

    active_.swap(candidate);
    spec_ = spec;
    kind_ = kindForOptions(options);
    preparedBytes_ = candidateBytes;
    return true;
}

void MusicalFxAdapter::reset(std::uint64_t absoluteFrame) noexcept {
    if (!active_) return;
    std::visit([&](auto& processor) noexcept { processor.reset(absoluteFrame); },
               active_->processor);
}

bool MusicalFxAdapter::processBlock(std::uint64_t blockStartFrame,
                                    StereoFrame* interleaved, std::uint32_t frames,
                                    const MusicalFxEvent* events,
                                    std::uint32_t eventCount) noexcept {
    return processInternal(blockStartFrame, interleaved, nullptr, frames, events,
                           eventCount, false);
}

bool MusicalFxAdapter::processBlockWithCarrier(std::uint64_t blockStartFrame,
                                    StereoFrame* modulator, const StereoFrame* carrier,
                                    std::uint32_t frames, const MusicalFxEvent* events,
                                    std::uint32_t eventCount) noexcept {
    return processInternal(blockStartFrame, modulator, carrier, frames, events,
                           eventCount, true);
}

bool MusicalFxAdapter::processInternal(std::uint64_t blockStartFrame,
                                       StereoFrame* interleaved,
                                       const StereoFrame* carrier,
                                       std::uint32_t frames,
                                       const MusicalFxEvent* events,
                                       std::uint32_t eventCount,
                                       bool carrierPath) noexcept {
    if (!active_ || interleaved == nullptr || frames == 0U ||
        frames > spec_.maxBlockFrames || eventCount > kMaximumEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    if (carrierPath) {
        if (kind_ != MusicalFxKind::Vocoder || carrier == nullptr) return false;
    } else if (kind_ == MusicalFxKind::Vocoder) {
        return false;
    }
    std::uint32_t previousOffset = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        const auto& event = events[i];
        if (event.frameOffset >= frames || (i != 0U && event.frameOffset < previousOffset))
            return false;
        previousOffset = event.frameOffset;
        switch (event.type) {
        case MusicalFxEventType::Parameter:
            if (!std::isfinite(event.value)) return false;
            break;
        case MusicalFxEventType::MidiNoteOn:
            if (kind_ != MusicalFxKind::HarmonyAuto && kind_ != MusicalFxKind::OscVocMidi)
                return false;
            if (event.channel != 0U || event.note > 127U || event.velocity == 0U ||
                event.velocity > 127U) return false;
            break;
        case MusicalFxEventType::MidiNoteOff:
        case MusicalFxEventType::MidiAllNotesOff:
            if (kind_ != MusicalFxKind::HarmonyAuto && kind_ != MusicalFxKind::OscVocMidi)
                return false;
            if (event.channel != 0U || event.note > 127U || event.velocity > 127U) return false;
            break;
        default:
            return false;
        }
    }

    switch (kind_) {
    case MusicalFxKind::Synth:
        return processTyped<SynthFxProcessor, SynthFxEvent>(
            std::get<SynthFxProcessor>(active_->processor), blockStartFrame,
            interleaved, carrier, frames, events, eventCount, carrierPath, mapSynth);
    case MusicalFxKind::GuitarToBass:
        return processTyped<GuitarToBassFxProcessor, GuitarToBassFxEvent>(
            std::get<GuitarToBassFxProcessor>(active_->processor), blockStartFrame,
            interleaved, carrier, frames, events, eventCount, carrierPath, mapGuitarToBass);
    case MusicalFxKind::AutoRiff:
        return processTyped<AutoRiffFxProcessor, AutoRiffFxEvent>(
            std::get<AutoRiffFxProcessor>(active_->processor), blockStartFrame,
            interleaved, carrier, frames, events, eventCount, carrierPath, mapAutoRiff);
    case MusicalFxKind::HarmonyAuto:
        return processTyped<HarmonyAutoFxProcessor, HarmonyAutoFxEvent>(
            std::get<HarmonyAutoFxProcessor>(active_->processor), blockStartFrame,
            interleaved, carrier, frames, events, eventCount, carrierPath, mapHarmony);
    case MusicalFxKind::Robot:
        return processTyped<RobotFxProcessor, RobotFxEvent>(
            std::get<RobotFxProcessor>(active_->processor), blockStartFrame,
            interleaved, carrier, frames, events, eventCount, carrierPath, mapRobot);
    case MusicalFxKind::Electric:
        return processTyped<ElectricFxProcessor, ElectricFxEvent>(
            std::get<ElectricFxProcessor>(active_->processor), blockStartFrame,
            interleaved, carrier, frames, events, eventCount, carrierPath, mapElectric);
    case MusicalFxKind::Vocoder:
    case MusicalFxKind::OscVocMidi:
        return processTyped<VocoderFxProcessor, VocoderFxEvent>(
            std::get<VocoderFxProcessor>(active_->processor), blockStartFrame,
            interleaved, carrier, frames, events, eventCount, carrierPath, mapVocoder);
    case MusicalFxKind::OscBot:
        return processTyped<OscBotFxProcessor, OscBotFxEvent>(
            std::get<OscBotFxProcessor>(active_->processor), blockStartFrame,
            interleaved, carrier, frames, events, eventCount, carrierPath, mapOscBot);
    case MusicalFxKind::Unprepared:
        return false;
    }
    return false;
}

bool MusicalFxAdapter::prepared() const noexcept {
    if (!active_) return false;
    return std::visit([](const auto& processor) noexcept { return processor.prepared(); },
                      active_->processor);
}

MusicalFxLatency MusicalFxAdapter::latency() const noexcept {
    if (!active_) return {};
    return std::visit([](const auto& processor) noexcept -> MusicalFxLatency {
        using T = std::decay_t<decltype(processor)>;
        if constexpr (std::is_same_v<T, SynthFxProcessor> ||
                      std::is_same_v<T, GuitarToBassFxProcessor> ||
                      std::is_same_v<T, AutoRiffFxProcessor> ||
                      std::is_same_v<T, HarmonyAutoFxProcessor>) {
            const auto value = processor.latency();
            return {value.fixedAlgorithmicSamples, value.analysisWindowFrames,
                    value.analysisHopFrames, value.psolaLookaheadSamples,
                    0U, value.pitchAnalysisCold};
        } else if constexpr (std::is_same_v<T, RobotFxProcessor> ||
                             std::is_same_v<T, ElectricFxProcessor>) {
            const auto value = processor.latency();
            return {0U, value.analysisWindowFrames, value.analysisHopFrames,
                    value.psolaLookaheadSamples, value.conservativePitchOnsetFrames,
                    value.analysisCold};
        } else if constexpr (std::is_same_v<T, VocoderFxProcessor>) {
            const auto value = processor.latency();
            return {static_cast<std::uint32_t>(value.fixedAlgorithmicSamples),
                    0U, 0U, 0U, 0U, true};
        } else {
            return {};
        }
    }, active_->processor);
}

std::uint16_t MusicalFxAdapter::catalogOrdinal() const noexcept {
    switch (kind_) {
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

PitchEstimate MusicalFxAdapter::pitchEstimate(std::uint32_t channel) const noexcept {
    if (!active_ || channel > 1U) return {};
    if (kind_ == MusicalFxKind::Robot)
        return std::get<RobotFxProcessor>(active_->processor).pitchEstimate(channel);
    if (kind_ == MusicalFxKind::Electric)
        return std::get<ElectricFxProcessor>(active_->processor).pitchEstimate(channel);
    return {};
}

} // namespace webrc::dsp
