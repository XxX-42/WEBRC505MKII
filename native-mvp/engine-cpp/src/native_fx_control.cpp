#include "native_fx_control.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::native {
namespace {

using webrc::dsp::FxParameterEvent;
using webrc::dsp::FxParameterId;
using webrc::dsp::FxProcessor;
using webrc::dsp::FxReadiness;
using webrc::dsp::FxMemoryRequirement;
using webrc::dsp::FxAlignmentRequirement;
using webrc::dsp::FxStartupWarmupRequirement;
using webrc::dsp::ProcessSpec;

constexpr std::uint64_t kMaximumExactFrame = (std::uint64_t{1} << 53U) - 1U;

bool finite(float value) noexcept { return std::isfinite(value); }

bool validMidi(const NativeFxBankEvent& event) noexcept {
    if (event.midiChannel != 0U || event.midiNote > 127U || event.midiVelocity > 127U)
        return false;
    switch (event.midiType) {
    case webrc::dsp::FxMidiEventType::NoteOn:
        return event.midiVelocity != 0U;
    case webrc::dsp::FxMidiEventType::NoteOff:
        return true;
    case webrc::dsp::FxMidiEventType::AllNotesOff:
        return event.midiNote == 0U && event.midiVelocity == 0U;
    }
    return false;
}

bool addFits(std::uint64_t a, std::uint64_t b, std::uint64_t& result) noexcept {
    if (b > std::numeric_limits<std::uint64_t>::max() - a) return false;
    result = a + b;
    return true;
}

bool multiplyFits(std::uint64_t a, std::uint64_t b, std::uint64_t& result) noexcept {
    if (a != 0U && b > std::numeric_limits<std::uint64_t>::max() / a) return false;
    result = a * b;
    return true;
}

bool makeInitialParameterEvents(const NativeFxBankSlotConfig& slot,
                                std::array<FxParameterEvent,
                                           kNativeFxBankMaximumParameters>& events,
                                std::uint32_t& eventCount) noexcept {
    if (slot.parameterCount > events.size()) return false;
    eventCount = slot.parameterCount;
    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        const auto& parameter = slot.parameters[index];
        events[index] = {0U, parameter.parameter, parameter.value};
    }
    return true;
}

NativeFxBusAddress addressFor(std::uint8_t busIndex) noexcept {
    if (busIndex == 0U) return {NativeFxBusKind::Input, 0U};
    if (busIndex <= 5U)
        return {NativeFxBusKind::Track, static_cast<std::uint8_t>(busIndex - 1U)};
    if (busIndex == 6U) return {NativeFxBusKind::Send, 0U};
    return {NativeFxBusKind::Master, 0U};
}

NativeFxBankResult failure(NativeFxBankStatus status,
                           std::uint8_t bus = 0xffU,
                           std::uint8_t slot = 0xffU,
                           NativeFxGraphResult graph = NativeFxGraphResult::Ok) noexcept {
    return {status, graph, bus, slot};
}

const webrc::dsp::FxParameterDescriptor* findParameterDescriptor(
    std::uint16_t ordinal, FxParameterId id) noexcept {
    std::size_t count = 0U;
    const auto* descriptors = webrc::dsp::fxParameterDescriptors(ordinal, count);
    if (descriptors == nullptr) return nullptr;
    for (std::size_t index = 0U; index < count; ++index)
        if (descriptors[index].id == id) return &descriptors[index];
    return nullptr;
}

bool descriptorAcceptsBus(const webrc::dsp::FxDescriptor& descriptor,
                          std::uint8_t busIndex) noexcept {
    if (busIndex == 0U) return descriptor.inputFx;
    if (busIndex >= 1U && busIndex <= 5U) return descriptor.trackFx;
    if (busIndex == 7U) return descriptor.trackFx;
    return false; // Send is explicitly unrouted by NativeTrackHost.
}

bool parameterWithinSampleRate(std::uint16_t ordinal, FxParameterId parameter,
                               float value, float sampleRate) noexcept {
    const auto* descriptor = findParameterDescriptor(ordinal, parameter);
    if (descriptor == nullptr || !finite(value) || !finite(sampleRate)) return false;
    if (descriptor->unit == "Hz" && value > sampleRate * 0.49f) return false;
    if (ordinal == 8U && parameter == FxParameterId::RadioHighPassHz &&
        value > std::min(1200.0f, sampleRate * 0.40f)) return false;
    if (ordinal == 8U && parameter == FxParameterId::RadioLowPassHz &&
        value > std::min(12000.0f, sampleRate * 0.45f)) return false;
    const bool modulatedDelay = ordinal == 5U || ordinal == 33U || ordinal == 37U ||
                                ordinal == 39U || ordinal == 46U;
    if (modulatedDelay && parameter == FxParameterId::RateHz &&
        value > std::min(20.0f, sampleRate * 0.25f)) return false;
    if ((ordinal == 40U || ordinal == 43U || ordinal == 24U) &&
        parameter == FxParameterId::ToneHz && value > std::min(16000.0f, sampleRate * 0.45f))
        return false;
    if (ordinal == 42U && parameter == FxParameterId::DampingHz &&
        value > std::min(16000.0f, sampleRate * 0.45f)) return false;
    if ((ordinal == 48U || ordinal == 49U) && parameter == FxParameterId::DampingHz &&
        value > sampleRate * 0.49f) return false;
    if (modulatedDelay && parameter == FxParameterId::DelayMs) {
        const float minimumMs = 2.0f * 1000.0f / sampleRate;
        float maximumMs = 30.0f;
        if (ordinal == 33U) maximumMs = 35.0f;
        else if (ordinal == 37U || ordinal == 39U) maximumMs = 2000.0f;
        else if (ordinal == 46U) maximumMs = 120.0f;
        if (value < std::max(descriptor->minimum, minimumMs) || value > maximumMs) return false;
    }
    return true;
}

NativeFxBankResult validateSlotMetadata(const NativeFxBankSlotConfig& slot,
                                        std::uint8_t busIndex,
                                        std::uint8_t slotIndex,
                                        const ProcessSpec& spec) noexcept {
    if (!slot.enabled) {
        if (slot.ordinal != 0U || slot.parameterCount != 0U ||
            slot.mix != 1.0f || slot.smoothingMs != 5.0f)
            return failure(NativeFxBankStatus::InvalidConfiguration, busIndex, slotIndex);
        return failure(NativeFxBankStatus::Ok);
    }
    if (!finite(slot.mix) || slot.mix < 0.0f || slot.mix > 1.0f ||
        !finite(slot.smoothingMs) || slot.smoothingMs < 0.0f || slot.smoothingMs > 1000.0f)
        return failure(NativeFxBankStatus::InvalidMix, busIndex, slotIndex);
    if (slot.parameterCount > kNativeFxBankMaximumParameters)
        return failure(NativeFxBankStatus::TooManyParameters, busIndex, slotIndex);
    if (busIndex == 6U) return failure(NativeFxBankStatus::InvalidRoute, busIndex, slotIndex,
                                       NativeFxGraphResult::InvalidRoute);

    const auto* descriptor = webrc::dsp::findFxByOrdinal(slot.ordinal);
    if (descriptor == nullptr || descriptor->readiness != FxReadiness::ProcessorAvailable)
        return failure(NativeFxBankStatus::UnsupportedOrdinal, busIndex, slotIndex,
                       NativeFxGraphResult::UnsupportedOrdinal);
    // VOCODER still requires an explicit external-carrier route in the bank
    // configuration. OSC VOC has a typed MIDI path through the Native host.
    if (slot.ordinal == 20U)
        return failure(NativeFxBankStatus::InvalidRoute, busIndex, slotIndex,
                       NativeFxGraphResult::InvalidRoute);
    if (!descriptorAcceptsBus(*descriptor, busIndex))
        return failure(NativeFxBankStatus::InvalidRoute, busIndex, slotIndex,
                       NativeFxGraphResult::InvalidRoute);

    std::array<FxParameterId, kNativeFxBankMaximumParameters> seen{};
    std::uint32_t seenCount = 0U;
    for (std::uint32_t index = 0U; index < slot.parameterCount; ++index) {
        const auto& parameter = slot.parameters[index];
        const auto* parameterDescriptor = findParameterDescriptor(slot.ordinal,
                                                                    parameter.parameter);
        if (parameterDescriptor == nullptr || !finite(parameter.value) ||
            parameter.value < parameterDescriptor->minimum ||
            parameter.value > parameterDescriptor->maximum)
            return failure(NativeFxBankStatus::InvalidParameter, busIndex, slotIndex,
                           NativeFxGraphResult::InvalidParameter);
        for (std::uint32_t prior = 0U; prior < seenCount; ++prior)
            if (seen[prior] == parameter.parameter)
                return failure(NativeFxBankStatus::DuplicateParameter, busIndex, slotIndex,
                               NativeFxGraphResult::InvalidParameter);
        seen[seenCount++] = parameter.parameter;
        if (!parameterWithinSampleRate(slot.ordinal, parameter.parameter,
                                       parameter.value, spec.sampleRate))
            return failure(NativeFxBankStatus::InvalidParameter, busIndex, slotIndex,
                           NativeFxGraphResult::InvalidParameter);
    }
    return failure(NativeFxBankStatus::Ok);
}

NativeFxBankResult validateSlotProcessorSemantics(
    const NativeFxBankSlotConfig& slot, std::uint8_t busIndex,
    std::uint8_t slotIndex, const ProcessSpec& spec) noexcept {
    if (!slot.enabled) return failure(NativeFxBankStatus::Ok);
    auto processor = webrc::dsp::createFxProcessor(slot.ordinal);
    if (!processor) return failure(NativeFxBankStatus::UnsupportedOrdinal, busIndex, slotIndex,
                                   NativeFxGraphResult::UnsupportedOrdinal);

    std::array<FxParameterEvent, kNativeFxBankMaximumParameters> prepareEvents{};
    std::array<FxParameterEvent, kNativeFxBankMaximumParameters> runtimeEvents{};
    std::uint32_t prepareCount = 0U;
    std::uint32_t runtimeCount = 0U;
    for (std::uint32_t index = 0U; index < slot.parameterCount; ++index) {
        const auto& parameter = slot.parameters[index];
        if (!processor->validParameter(parameter.parameter, parameter.value))
            return failure(NativeFxBankStatus::InvalidParameter, busIndex, slotIndex,
                           NativeFxGraphResult::InvalidParameter);
        auto& events = processor->isPrepareTimeParameter(parameter.parameter)
            ? prepareEvents : runtimeEvents;
        auto& count = processor->isPrepareTimeParameter(parameter.parameter)
            ? prepareCount : runtimeCount;
        events[count++] = {0U, parameter.parameter, parameter.value};
    }
    if (runtimeCount != 0U &&
        !processor->validateParameterEvents(runtimeEvents.data(), runtimeCount))
        return failure(NativeFxBankStatus::InvalidParameter, busIndex, slotIndex,
                       NativeFxGraphResult::InvalidParameter);
    for (std::uint32_t index = 0U; index < prepareCount; ++index) {
        if (!processor->setParameter(prepareEvents[index].parameter,
                                     prepareEvents[index].value))
            return failure(NativeFxBankStatus::InvalidParameter, busIndex, slotIndex,
                           NativeFxGraphResult::InvalidParameter);
    }
    if (!processor->prepare(spec))
        return failure(NativeFxBankStatus::GraphConfigureFailed, busIndex, slotIndex,
                       NativeFxGraphResult::InvalidSpec);
    if (runtimeCount != 0U &&
        !processor->validateParameterEvents(runtimeEvents.data(), runtimeCount))
        return failure(NativeFxBankStatus::InvalidParameter, busIndex, slotIndex,
                       NativeFxGraphResult::InvalidParameter);
    return failure(NativeFxBankStatus::Ok);
}

bool slotPeakBytes(const NativeFxBankSlotConfig& slot, const ProcessSpec& spec,
                   std::uint64_t& permanentBytes,
                   std::uint64_t& constructionPeakBytes) noexcept {
    std::array<FxParameterEvent, kNativeFxBankMaximumParameters> initialEvents{};
    std::uint32_t initialEventCount = 0U;
    if (!makeInitialParameterEvents(slot, initialEvents, initialEventCount)) return false;
    const auto* eventData = initialEventCount == 0U ? nullptr : initialEvents.data();
    const FxMemoryRequirement requirement =
        webrc::dsp::fxMemoryRequirementForParameters(
            slot.ordinal, spec, eventData, initialEventCount);
    const FxAlignmentRequirement alignment =
        webrc::dsp::fxAlignmentUpperBoundSamples(slot.ordinal, spec);
    const FxStartupWarmupRequirement warmup =
        webrc::dsp::fxStartupWarmupUpperBoundSamplesForParameters(
            slot.ordinal, spec, eventData, initialEventCount);
    if (!requirement.supported || !alignment.supported || !warmup.supported) return false;

    std::uint64_t objectAndPrepared = 0U;
    std::uint64_t alignBytes = 0U;
    if (!addFits(requirement.objectBytes, requirement.persistentPreparedBytes,
                 objectAndPrepared) ||
        !multiplyFits(alignment.frames, 2U * sizeof(float), alignBytes) ||
        !addFits(objectAndPrepared, alignBytes, permanentBytes)) return false;
    std::uint64_t peak = 0U;
    if (!addFits(objectAndPrepared, requirement.prepareScratchBytes, peak) ||
        !addFits(peak, alignBytes, constructionPeakBytes)) return false;
    return true;
}

NativeFxBankResult validateProcessorSemantics(
    const NativeFxBankConfig& candidate, const ProcessSpec& spec) noexcept {
    for (std::uint8_t bus = 0U; bus < kNativeFxBankBusCount; ++bus) {
        for (std::uint8_t slot = 0U; slot < kNativeFxBankSlotsPerBus; ++slot) {
            const auto result = validateSlotProcessorSemantics(
                candidate.buses[bus][slot], bus, slot, spec);
            if (!result.ok()) return result;
        }
    }
    return failure(NativeFxBankStatus::Ok);
}

} // namespace

NativeFxBankResult NativeFxBank::validateConfiguration(
    const NativeFxBankConfig& candidate) noexcept {
    if (candidate.channels != 2U || candidate.maxBlockFrames != kNativeFxGraphMaximumFrames ||
        candidate.sampleRateHz < 8000U || candidate.sampleRateHz > 384000U)
        return failure(NativeFxBankStatus::InvalidSpec, 0xffU, 0xffU,
                       NativeFxGraphResult::InvalidSpec);
    const ProcessSpec spec{static_cast<float>(candidate.sampleRateHz),
                           candidate.maxBlockFrames, candidate.channels};
    if (!webrc::dsp::validProcessSpec(spec))
        return failure(NativeFxBankStatus::InvalidSpec, 0xffU, 0xffU,
                       NativeFxGraphResult::InvalidSpec);

    for (std::uint8_t bus = 0U; bus < kNativeFxBankBusCount; ++bus) {
        for (std::uint8_t slot = 0U; slot < kNativeFxBankSlotsPerBus; ++slot) {
            const auto result = validateSlotMetadata(candidate.buses[bus][slot], bus, slot,
                                                     spec);
            if (!result.ok()) return result;
        }
    }
    return failure(NativeFxBankStatus::Ok);
}

std::uint64_t NativeFxBank::requiredCandidatePeakBytes(
    const NativeFxBankConfig& candidate) noexcept {
    if (!validateConfiguration(candidate).ok()) return 0U;
    const ProcessSpec spec{static_cast<float>(candidate.sampleRateHz),
                           candidate.maxBlockFrames, candidate.channels};
    std::uint64_t permanent = 0U;
    std::uint64_t maximumPeak = sizeof(NativeFxGraph);
    for (std::uint8_t bus = 0U; bus < kNativeFxBankBusCount; ++bus) {
        for (std::uint8_t slot = 0U; slot < kNativeFxBankSlotsPerBus; ++slot) {
            const auto& item = candidate.buses[bus][slot];
            if (!item.enabled) continue;
            std::uint64_t slotPermanent = 0U;
            std::uint64_t slotPeak = 0U;
            if (!slotPeakBytes(item, spec, slotPermanent, slotPeak)) return 0U;
            std::uint64_t construction = 0U;
            if (!addFits(sizeof(NativeFxGraph), permanent, construction) ||
                !addFits(construction, slotPeak, construction)) return 0U;
            maximumPeak = std::max(maximumPeak, construction);
            if (!addFits(permanent, slotPermanent, permanent)) return 0U;
        }
    }
    return maximumPeak;
}

NativeFxBankResult NativeFxBank::configure(const NativeFxBankConfig& candidate) noexcept {
    // Run all cheap checks before constructing any processor. This lets host,
    // rate and budget rejection stay allocation-free.
    auto result = validateConfiguration(candidate);
    if (!result.ok()) return result;
    if (host_ == nullptr || !host_->prepared())
        return failure(NativeFxBankStatus::HostNotPrepared,
                       0xffU, 0xffU, NativeFxGraphResult::NotPrepared);
    const auto actualSampleRateHz = host_->sampleRateHz();
    if (actualSampleRateHz < 8000U || actualSampleRateHz > 384000U ||
        candidate.sampleRateHz != actualSampleRateHz)
        return failure(NativeFxBankStatus::InvalidSpec, 0xffU, 0xffU,
                       NativeFxGraphResult::SpecMismatch);

    const auto requiredPeak = requiredCandidatePeakBytes(candidate);
    const auto budget = host_->candidateFxGraphBudgetBytes();
    if (budget == 0U)
        return failure(NativeFxBankStatus::MemoryBudgetUnavailable,
                       0xffU, 0xffU, NativeFxGraphResult::MemoryBudgetExceeded);
    if (requiredPeak == 0U || requiredPeak > budget)
        return failure(NativeFxBankStatus::MemoryBudgetExceeded,
                       0xffU, 0xffU, NativeFxGraphResult::MemoryBudgetExceeded);

    // Processor-specific ranges, coupled controls and selector behavior are
    // checked with one prepared shadow at a time only after admission. The
    // estimate above includes the largest single-processor prepare peak, so
    // this validation does not add to the graph candidate's peak budget.
    const ProcessSpec spec{static_cast<float>(candidate.sampleRateHz),
                           candidate.maxBlockFrames, candidate.channels};
    result = validateProcessorSemantics(candidate, spec);
    if (!result.ok()) return result;

    std::unique_ptr<NativeFxGraph> graph(new (std::nothrow) NativeFxGraph());
    if (!graph) return failure(NativeFxBankStatus::AllocationFailed);
    auto graphResult = graph->prepare(spec, budget);
    if (graphResult != NativeFxGraphResult::Ok)
        return failure(NativeFxBankStatus::GraphPrepareFailed, 0xffU, 0xffU, graphResult);

    for (std::uint8_t bus = 0U; bus < kNativeFxBankBusCount; ++bus) {
        for (std::uint8_t slot = 0U; slot < kNativeFxBankSlotsPerBus; ++slot) {
            const auto& item = candidate.buses[bus][slot];
            if (!item.enabled) continue;
            graphResult = graph->configureSlot(addressFor(bus), slot, item.ordinal,
                item.mix, item.smoothingMs, item.parameters.data(), item.parameterCount);
            if (graphResult != NativeFxGraphResult::Ok)
                return failure(NativeFxBankStatus::GraphConfigureFailed, bus, slot,
                               graphResult);
        }
    }
    graphResult = graph->seal();
    if (graphResult != NativeFxGraphResult::Ok)
        return failure(NativeFxBankStatus::GraphSealFailed, 0xffU, 0xffU, graphResult);

    // Cache capability from the actual fully prepared candidate graph. This
    // avoids re-preparing a duplicate processor for every live slot-mix event
    // and makes admission use the same sample rate and prepare-time selectors
    // as the object that will run in the callback.
    std::array<std::array<bool, kNativeFxBankSlotsPerBus>, kNativeFxBankBusCount>
        candidateOuterMixSupported{};
    std::array<std::array<std::int32_t, kNativeFxBankSlotsPerBus>, kNativeFxBankBusCount>
        candidateFixedLatency{};
    for (std::uint8_t bus = 0U; bus < kNativeFxBankBusCount; ++bus) {
        for (std::uint8_t slot = 0U; slot < kNativeFxBankSlotsPerBus; ++slot) {
            if (!candidate.buses[bus][slot].enabled) continue;
            std::int32_t fixedLatency = 0;
            if (!graph->slotFixedLatencySamples(addressFor(bus), slot, fixedLatency))
                return failure(NativeFxBankStatus::GraphConfigureFailed, bus, slot,
                               NativeFxGraphResult::InvalidSlot);
            candidateFixedLatency[bus][slot] = fixedLatency;
            candidateOuterMixSupported[bus][slot] =
                graph->slotSupportsOuterMix(addressFor(bus), slot);
            if (!candidateOuterMixSupported[bus][slot] &&
                candidate.buses[bus][slot].mix != 1.0f)
                return failure(NativeFxBankStatus::InvalidMix, bus, slot,
                               NativeFxGraphResult::InvalidParameter);
        }
    }

    graphResult = host_->stageFxGraph(graph);
    if (graphResult != NativeFxGraphResult::Ok)
        return failure(NativeFxBankStatus::StageFailed, 0xffU, 0xffU, graphResult);

    configuration_ = candidate;
    outerMixSupported_ = candidateOuterMixSupported;
    fixedLatencySamples_ = candidateFixedLatency;
    configured_ = true;
    return failure(NativeFxBankStatus::Ok);
}

NativeFxBankResult NativeFxBank::postEvents(const NativeFxBankEvent* events,
                                            std::uint32_t eventCount) noexcept {
    if (!configured_) return failure(NativeFxBankStatus::InvalidConfiguration);
    if (eventCount == 0U || events == nullptr)
        return failure(NativeFxBankStatus::InvalidEvent, 0xffU, 0xffU,
                       NativeFxGraphResult::InvalidEvent);
    if (eventCount > kNativeFxBankMaximumEventBatch)
        return failure(NativeFxBankStatus::TooManyEvents, 0xffU, 0xffU,
                       NativeFxGraphResult::TooManyEvents);
    if (host_ == nullptr || !host_->prepared())
        return failure(NativeFxBankStatus::HostNotPrepared, 0xffU, 0xffU,
                       NativeFxGraphResult::NotPrepared);
    if (host_->sampleRateHz() != configuration_.sampleRateHz)
        return failure(NativeFxBankStatus::InvalidSpec, 0xffU, 0xffU,
                       NativeFxGraphResult::SpecMismatch);

    struct ValidationGroup {
        std::uint8_t busIndex = 0U;
        std::uint8_t slotIndex = 0U;
        std::uint16_t ordinal = 0U;
        std::array<FxParameterEvent, kNativeFxBankMaximumEventBatch> parameters{};
        std::uint32_t parameterCount = 0U;
        std::uint64_t lastAbsoluteFrame = 0U;
        std::uint32_t nextValidationOffset = 0U;
        bool hasFrame = false;
    };

    std::array<ValidationGroup, kNativeFxBankMaximumEventBatch> groups{};
    std::uint32_t groupCount = 0U;
    std::array<NativeFxGraphEvent, kNativeFxBankMaximumEventBatch> graphEvents{};
    std::uint64_t previousFrame = 0U;

    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        const auto& source = events[index];
        if (source.absoluteFrame > kMaximumExactFrame || source.busIndex >= kNativeFxBankBusCount)
            return failure(NativeFxBankStatus::InvalidEvent, source.busIndex, source.slotIndex,
                           NativeFxGraphResult::InvalidEvent);
        if (index != 0U && source.absoluteFrame < previousFrame)
            return failure(NativeFxBankStatus::EventOrderRejected, source.busIndex, source.slotIndex,
                           NativeFxGraphResult::TimestampOutOfOrder);
        previousFrame = source.absoluteFrame;
        if (source.slotIndex >= kNativeFxBankSlotsPerBus ||
            !configuration_.buses[source.busIndex][source.slotIndex].enabled)
            return failure(NativeFxBankStatus::InvalidSlot, source.busIndex, source.slotIndex,
                           NativeFxGraphResult::InvalidSlot);

        auto& target = graphEvents[index];
        target.absoluteFrame = source.absoluteFrame;
        target.bus = addressFor(source.busIndex);
        target.slotIndex = source.slotIndex;
        if (source.kind == NativeFxBankEventKind::SlotMix) {
            if (!finite(source.value) || source.value < 0.0f || source.value > 1.0f ||
                !finite(source.smoothingMs) || source.smoothingMs < 0.0f ||
                source.smoothingMs > 1000.0f ||
                (source.value != 1.0f && !outerMixSupported_[source.busIndex][source.slotIndex]))
                return failure(NativeFxBankStatus::InvalidMix, source.busIndex, source.slotIndex,
                               NativeFxGraphResult::InvalidParameter);
            target.kind = NativeFxGraphEventKind::SlotMix;
            target.value = source.value;
            target.smoothingMs = source.smoothingMs;
            continue;
        }
        const auto& configured = configuration_.buses[source.busIndex][source.slotIndex];
        const auto ordinal = configured.ordinal;
        if (source.kind == NativeFxBankEventKind::Midi) {
            bool midiRoute = ordinal == 21U;
            if (ordinal == 19U) {
                float mode = 2.0f;
                for (std::uint8_t parameterIndex = 0U;
                     parameterIndex < configured.parameterCount; ++parameterIndex) {
                    const auto& parameter = configured.parameters[parameterIndex];
                    if (parameter.parameter == FxParameterId::ModeIndex) mode = parameter.value;
                }
                midiRoute = mode < 1.5f;
            }
            if (!midiRoute)
                return failure(NativeFxBankStatus::InvalidRoute, source.busIndex,
                               source.slotIndex, NativeFxGraphResult::InvalidRoute);
            if (!validMidi(source))
                return failure(NativeFxBankStatus::InvalidEvent, source.busIndex,
                               source.slotIndex, NativeFxGraphResult::InvalidEvent);
            target.kind = NativeFxGraphEventKind::Midi;
            target.midiType = source.midiType;
            target.midiChannel = source.midiChannel;
            target.midiNote = source.midiNote;
            target.midiVelocity = source.midiVelocity;
            continue;
        }
        if (source.kind != NativeFxBankEventKind::ProcessorParameter || !finite(source.value))
            return failure(NativeFxBankStatus::InvalidEvent, source.busIndex, source.slotIndex,
                           NativeFxGraphResult::InvalidEvent);

        auto groupIndex = std::uint32_t{0U};
        while (groupIndex < groupCount &&
               (groups[groupIndex].busIndex != source.busIndex ||
                groups[groupIndex].slotIndex != source.slotIndex)) ++groupIndex;
        if (groupIndex == groupCount) {
            auto& group = groups[groupCount++];
            group.busIndex = source.busIndex;
            group.slotIndex = source.slotIndex;
        group.ordinal = configured.ordinal;
        }
        auto& group = groups[groupIndex];
        if (findParameterDescriptor(ordinal, source.parameter) == nullptr)
            return failure(NativeFxBankStatus::InvalidParameter, source.busIndex,
                           source.slotIndex, NativeFxGraphResult::InvalidParameter);
        if (!parameterWithinSampleRate(ordinal,
                                       source.parameter, source.value,
                                       static_cast<float>(host_->sampleRateHz())))
            return failure(NativeFxBankStatus::InvalidParameter, source.busIndex,
                           source.slotIndex, NativeFxGraphResult::InvalidParameter);
        if (group.parameterCount >= group.parameters.size())
            return failure(NativeFxBankStatus::TooManyEvents, source.busIndex, source.slotIndex,
                           NativeFxGraphResult::TooManyEvents);
        if (!group.hasFrame) {
            group.lastAbsoluteFrame = source.absoluteFrame;
            group.hasFrame = true;
        } else if (source.absoluteFrame != group.lastAbsoluteFrame) {
            ++group.nextValidationOffset;
            group.lastAbsoluteFrame = source.absoluteFrame;
        }
        group.parameters[group.parameterCount++] = {
            group.nextValidationOffset, source.parameter, source.value};
        target.kind = NativeFxGraphEventKind::ProcessorParameter;
        target.parameter = source.parameter;
        target.value = source.value;
    }

    // Validation shadows are temporary control-thread allocations. Construct
    // only one at a time, and charge its concrete object footprint against
    // the host's remaining aggregate FX budget before creating it. This keeps
    // peak shadow memory bounded independently of the number of addressed
    // slots in the batch.
    const ProcessSpec spec{static_cast<float>(configuration_.sampleRateHz),
                           configuration_.maxBlockFrames, configuration_.channels};
    std::uint64_t maximumShadowBytes = 0U;
    for (std::uint32_t index = 0U; index < groupCount; ++index) {
        const auto& configured = configuration_.buses[groups[index].busIndex]
                                                    [groups[index].slotIndex];
        std::array<FxParameterEvent, kNativeFxBankMaximumParameters> initialEvents{};
        std::uint32_t initialEventCount = 0U;
        if (!makeInitialParameterEvents(configured, initialEvents, initialEventCount))
            return failure(NativeFxBankStatus::TooManyParameters, groups[index].busIndex,
                           groups[index].slotIndex, NativeFxGraphResult::InvalidParameter);
        const auto* initialEventData = initialEventCount == 0U ? nullptr : initialEvents.data();
        const auto requirement = webrc::dsp::fxMemoryRequirementForParameters(
            groups[index].ordinal, spec, initialEventData, initialEventCount);
        std::uint64_t shadowPeak = 0U;
        if (!requirement.supported || requirement.objectBytes == 0U ||
            !addFits(requirement.objectBytes, requirement.persistentPreparedBytes, shadowPeak) ||
            !addFits(shadowPeak, requirement.prepareScratchBytes, shadowPeak))
            return failure(NativeFxBankStatus::UnsupportedOrdinal, groups[index].busIndex,
                           groups[index].slotIndex, NativeFxGraphResult::UnsupportedOrdinal);
        maximumShadowBytes = std::max(maximumShadowBytes, shadowPeak);
    }
    if (groupCount != 0U) {
        const auto hostStatus = host_->status();
        const auto aggregate = hostStatus.aggregateMemoryBudgetBytes;
        if (hostStatus.preparedFixedBytes > aggregate ||
            hostStatus.preparedHistoryBytes > aggregate - hostStatus.preparedFixedBytes ||
            hostStatus.preparedFxGraphBytes > aggregate - hostStatus.preparedFixedBytes -
                                               hostStatus.preparedHistoryBytes)
            return failure(NativeFxBankStatus::MemoryBudgetUnavailable, 0xffU, 0xffU,
                           NativeFxGraphResult::MemoryBudgetExceeded);
        const auto availableShadowBudget = aggregate - hostStatus.preparedFixedBytes -
                                           hostStatus.preparedHistoryBytes -
                                           hostStatus.preparedFxGraphBytes;
        // The fixed validation arrays live on this control thread's stack.
        // Charge the heap object, prepared state and transient prepare storage
        // of the one-at-a-time validation shadow against the real budget.
        if (maximumShadowBytes > availableShadowBudget)
            return failure(NativeFxBankStatus::MemoryBudgetExceeded, 0xffU, 0xffU,
                           NativeFxGraphResult::MemoryBudgetExceeded);
    }

    // Validate every parameter's full target state before the one atomic queue
    // operation. No accepted bank snapshot changes on any rejection.
    for (std::uint32_t index = 0U; index < groupCount; ++index) {
        const auto& group = groups[index];
        std::unique_ptr<FxProcessor> shadow = webrc::dsp::createFxProcessor(group.ordinal);
        if (!shadow)
            return failure(NativeFxBankStatus::AllocationFailed, group.busIndex,
                           group.slotIndex, NativeFxGraphResult::MemoryBudgetExceeded);
        const auto& configured = configuration_.buses[group.busIndex][group.slotIndex];
        for (std::uint8_t parameterIndex = 0U;
             parameterIndex < configured.parameterCount; ++parameterIndex) {
            const auto& current = configured.parameters[parameterIndex];
            if (!shadow->setParameter(current.parameter, current.value))
                return failure(NativeFxBankStatus::InvalidParameter, group.busIndex,
                               group.slotIndex, NativeFxGraphResult::InvalidParameter);
        }
        if (group.parameterCount > shadow->maximumParameterEventsPerBlock())
            return failure(NativeFxBankStatus::TooManyEvents, group.busIndex,
                           group.slotIndex, NativeFxGraphResult::TooManyEvents);
        for (std::uint32_t eventIndex = 0U; eventIndex < group.parameterCount; ++eventIndex) {
            const auto& parameter = group.parameters[eventIndex];
            if (!shadow->validParameter(parameter.parameter, parameter.value))
                return failure(NativeFxBankStatus::InvalidParameter, group.busIndex,
                               group.slotIndex, NativeFxGraphResult::InvalidParameter);
            // HRM AUTO (M) switches between automatic harmony and typed MIDI
            // routing. The selector is legal in a staged bank configuration,
            // but changing it must replace the whole processor graph so host
            // routeability and processor mode become effective together.
            if (shadow->isPrepareTimeParameter(parameter.parameter) ||
                (group.ordinal == 19U && parameter.parameter == FxParameterId::ModeIndex))
                return failure(NativeFxBankStatus::PrepareTimeParameterNotAllowed,
                               group.busIndex, group.slotIndex,
                               NativeFxGraphResult::InvalidParameter);
        }
        if (!shadow->validateParameterEvents(group.parameters.data(), group.parameterCount))
            return failure(NativeFxBankStatus::InvalidParameter, group.busIndex,
                           group.slotIndex, NativeFxGraphResult::InvalidParameter);
    }

    const auto queued = host_->postFxEvents(graphEvents.data(), eventCount);
    if (queued != NativeFxGraphResult::Ok)
        return failure(NativeFxBankStatus::ControlEventRejected, 0xffU, 0xffU, queued);

    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        const auto& event = events[index];
        auto& slot = configuration_.buses[event.busIndex][event.slotIndex];
        if (event.kind == NativeFxBankEventKind::SlotMix) {
            slot.mix = event.value;
            slot.smoothingMs = event.smoothingMs;
            continue;
        }
        if (event.kind == NativeFxBankEventKind::Midi) continue;
        std::uint8_t parameterIndex = 0U;
        while (parameterIndex < slot.parameterCount &&
               slot.parameters[parameterIndex].parameter != event.parameter) ++parameterIndex;
        if (parameterIndex < slot.parameterCount) {
            slot.parameters[parameterIndex].value = event.value;
        } else if (slot.parameterCount < kNativeFxBankMaximumParameters) {
            slot.parameters[slot.parameterCount++] = {event.parameter, event.value};
        }
    }
    return failure(NativeFxBankStatus::Ok);
}

NativeFxBankResult NativeFxBank::postParameterEvent(
    std::uint8_t busIndex, std::uint8_t slotIndex, FxParameterId parameter,
    float value, std::uint64_t absoluteFrame) noexcept {
    const NativeFxBankEvent event{absoluteFrame, busIndex, slotIndex,
        NativeFxBankEventKind::ProcessorParameter, parameter, value, 5.0f};
    return postEvents(&event, 1U);
}

NativeFxBankResult NativeFxBank::postSlotMixEvent(
    std::uint8_t busIndex, std::uint8_t slotIndex, float mix,
    float smoothingMs, std::uint64_t absoluteFrame) noexcept {
    const NativeFxBankEvent event{absoluteFrame, busIndex, slotIndex,
        NativeFxBankEventKind::SlotMix, FxParameterId::Mix, mix, smoothingMs};
    return postEvents(&event, 1U);
}

bool NativeFxBank::slotFixedLatencySamples(std::uint8_t busIndex,
                                            std::uint8_t slotIndex,
                                            std::int32_t& samples) const noexcept {
    if (!configured_ || busIndex >= kNativeFxBankBusCount ||
        slotIndex >= kNativeFxBankSlotsPerBus ||
        !configuration_.buses[busIndex][slotIndex].enabled) return false;
    samples = fixedLatencySamples_[busIndex][slotIndex];
    return true;
}

bool NativeFxBank::slotSupportsOuterMix(std::uint8_t busIndex,
                                         std::uint8_t slotIndex) const noexcept {
    return configured_ && busIndex < kNativeFxBankBusCount &&
           slotIndex < kNativeFxBankSlotsPerBus &&
           configuration_.buses[busIndex][slotIndex].enabled &&
           outerMixSupported_[busIndex][slotIndex];
}

} // namespace webrc::native
