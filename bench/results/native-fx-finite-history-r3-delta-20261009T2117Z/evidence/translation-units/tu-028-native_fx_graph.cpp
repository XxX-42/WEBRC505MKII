#include "native_fx_graph.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace webrc::native {
namespace {

using webrc::dsp::StereoFrame;

constexpr std::uint64_t kMaximumExactFrame = (std::uint64_t{1} << 53U) - 1U;
constexpr std::uint32_t kMaximumInitialParameters = kNativeFxGraphParameterCapacity;

bool finite(float value) noexcept { return std::isfinite(value); }

bool validEventKind(NativeFxGraphEventKind kind) noexcept {
    return kind == NativeFxGraphEventKind::ProcessorParameter ||
           kind == NativeFxGraphEventKind::SlotMix;
}

} // namespace

bool NativeFxGraph::validBusAddress(NativeFxBusAddress bus) noexcept {
    switch (bus.kind) {
    case NativeFxBusKind::Input:
    case NativeFxBusKind::Send:
    case NativeFxBusKind::Master:
        return bus.trackIndex == 0U;
    case NativeFxBusKind::Track:
        return bus.trackIndex < 5U;
    }
    return false;
}

std::uint32_t NativeFxGraph::busIndex(NativeFxBusAddress bus) noexcept {
    switch (bus.kind) {
    case NativeFxBusKind::Input: return 0U;
    case NativeFxBusKind::Track: return static_cast<std::uint32_t>(1U + bus.trackIndex);
    case NativeFxBusKind::Send: return 6U;
    case NativeFxBusKind::Master: return 7U;
    }
    return kNativeFxGraphBusCount;
}

bool NativeFxGraph::busAccepts(const webrc::dsp::FxDescriptor& descriptor,
                               NativeFxBusAddress bus) noexcept {
    switch (bus.kind) {
    case NativeFxBusKind::Input: return descriptor.inputFx;
    case NativeFxBusKind::Track: return descriptor.trackFx;
    // Send and master placement are Native reconstruction routing extensions.
    // The catalog has no independently validated official send/master domain.
    case NativeFxBusKind::Send:
    case NativeFxBusKind::Master: return descriptor.trackFx;
    }
    return false;
}

bool NativeFxGraph::addFits(std::uint64_t a, std::uint64_t b,
                            std::uint64_t& sum) noexcept {
    if (b > std::numeric_limits<std::uint64_t>::max() - a) return false;
    sum = a + b;
    return true;
}

NativeFxGraph::Slot* NativeFxGraph::findSlot(NativeFxBusAddress bus,
                                             std::uint8_t slotIndex) noexcept {
    if (!validBusAddress(bus) || slotIndex >= kNativeFxGraphSlotsPerBus) return nullptr;
    const auto index = static_cast<std::size_t>(busIndex(bus)) * kNativeFxGraphSlotsPerBus + slotIndex;
    return index < slots_.size() ? &slots_[index] : nullptr;
}

const NativeFxGraph::Slot* NativeFxGraph::findSlot(NativeFxBusAddress bus,
                                                   std::uint8_t slotIndex) const noexcept {
    if (!validBusAddress(bus) || slotIndex >= kNativeFxGraphSlotsPerBus) return nullptr;
    const auto index = static_cast<std::size_t>(busIndex(bus)) * kNativeFxGraphSlotsPerBus + slotIndex;
    return index < slots_.size() ? &slots_[index] : nullptr;
}

NativeFxGraphResult NativeFxGraph::prepare(const webrc::dsp::ProcessSpec& spec,
                                           std::uint64_t memoryBudgetBytes) noexcept {
    if (sealed_) return NativeFxGraphResult::AlreadySealed;
    if (prepared_ || !webrc::dsp::validProcessSpec(spec) || spec.channels != 2U ||
        spec.maxBlockFrames == 0U || spec.maxBlockFrames > kNativeFxGraphMaximumFrames)
        return NativeFxGraphResult::InvalidSpec;
    if (memoryBudgetBytes != 0U && sizeof(*this) > memoryBudgetBytes)
        return NativeFxGraphResult::MemoryBudgetExceeded;
    spec_ = spec;
    memoryBudgetBytes_ = memoryBudgetBytes;
    nextBlockFrame_ = 0U;
    prepared_ = true;
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraph::configureSlot(
    NativeFxBusAddress bus, std::uint8_t slotIndex, std::uint16_t ordinal,
    float mix, float smoothingMs, const NativeFxInitialParameter* initialParameters,
    std::uint32_t initialParameterCount) noexcept {
    if (!prepared_) return NativeFxGraphResult::NotPrepared;
    if (sealed_) return NativeFxGraphResult::AlreadySealed;
    if (!validBusAddress(bus)) return NativeFxGraphResult::InvalidBus;
    if (slotIndex >= kNativeFxGraphSlotsPerBus) return NativeFxGraphResult::InvalidSlot;
    if (!finite(mix) || mix < 0.0f || mix > 1.0f || !finite(smoothingMs) ||
        smoothingMs < 0.0f || smoothingMs > 1000.0f ||
        (initialParameterCount != 0U && initialParameters == nullptr) ||
        initialParameterCount > kMaximumInitialParameters)
        return NativeFxGraphResult::InvalidParameter;

    const auto* descriptor = webrc::dsp::findFxByOrdinal(ordinal);
    if (descriptor == nullptr || descriptor->readiness != webrc::dsp::FxReadiness::ProcessorAvailable)
        return NativeFxGraphResult::UnsupportedOrdinal;
    if (!busAccepts(*descriptor, bus)) return NativeFxGraphResult::InvalidRoute;
    const auto requirement = webrc::dsp::fxMemoryRequirement(ordinal, spec_);
    std::uint64_t candidatePermanentBytes = 0U;
    std::uint64_t candidatePeakBytes = 0U;
    if (!requirement.supported ||
        !addFits(requirement.objectBytes, requirement.persistentPreparedBytes, candidatePermanentBytes) ||
        !addFits(candidatePermanentBytes, requirement.prepareScratchBytes, candidatePeakBytes))
        return NativeFxGraphResult::UnsupportedOrdinal;

    auto* targetSlot = findSlot(bus, slotIndex);
    if (targetSlot == nullptr) return NativeFxGraphResult::InvalidSlot;
    const auto oldPermanentBytes = targetSlot->configured ? targetSlot->estimatedPermanentBytes : 0U;
    const auto withoutOld = permanentProcessorBytes_ - oldPermanentBytes;
    const auto startupUpper = webrc::dsp::fxStartupWarmupUpperBoundSamples(ordinal, spec_);
    if (!startupUpper.supported) return NativeFxGraphResult::UnsupportedOrdinal;
    const auto alignmentUpper = webrc::dsp::fxAlignmentUpperBoundSamples(ordinal, spec_);
    if (!alignmentUpper.supported) return NativeFxGraphResult::UnsupportedOrdinal;
    const auto alignmentUpperSamples = static_cast<std::uint64_t>(alignmentUpper.frames);
    if (alignmentUpperSamples > std::numeric_limits<std::uint64_t>::max() /
            (2U * sizeof(float)))
        return NativeFxGraphResult::MemoryBudgetExceeded;
    const auto alignmentUpperBytes = alignmentUpperSamples * 2U * sizeof(float);
    std::uint64_t projected = 0U;
    // The old slot remains alive while the candidate object and its prepare
    // scratch are admitted/prepared. Do not subtract it until after commit.
    if (!addFits(sizeof(*this), permanentProcessorBytes_, projected) ||
        !addFits(projected, candidatePeakBytes, projected) ||
        !addFits(projected, alignmentUpperBytes, projected) ||
        (memoryBudgetBytes_ != 0U && projected > memoryBudgetBytes_))
        return NativeFxGraphResult::MemoryBudgetExceeded;

    auto candidate = webrc::dsp::createFxProcessor(ordinal);
    if (!candidate) return NativeFxGraphResult::UnsupportedOrdinal;
    Slot staged{};
    staged.processor = std::move(candidate);
    staged.ordinal = ordinal;
    staged.configured = true;

    std::size_t parameterCount = 0U;
    const auto* parameters = webrc::dsp::fxParameterDescriptors(ordinal, parameterCount);
    if (parameterCount > staged.cachedParameters.size()) return NativeFxGraphResult::UnsupportedOrdinal;
    staged.cachedParameterCount = static_cast<std::uint8_t>(parameterCount);
    for (std::size_t index = 0U; index < parameterCount; ++index) {
        staged.cachedParameters[index] = {parameters[index].id, parameters[index].defaultValue};
    }

    std::array<webrc::dsp::FxParameterEvent, kMaximumInitialParameters> prepareEvents{};
    std::array<webrc::dsp::FxParameterEvent, kMaximumInitialParameters> runtimeEvents{};
    std::uint32_t prepareEventCount = 0U;
    std::uint32_t runtimeEventCount = 0U;
    for (std::uint32_t index = 0U; index < initialParameterCount; ++index) {
        const auto& initial = initialParameters[index];
        if (!staged.processor->validParameter(initial.parameter, initial.value))
            return NativeFxGraphResult::InvalidParameter;
        bool found = false;
        for (std::uint8_t cached = 0U; cached < staged.cachedParameterCount; ++cached) {
            if (staged.cachedParameters[cached].id == initial.parameter) {
                staged.cachedParameters[cached].target = initial.value;
                found = true;
                break;
            }
        }
        if (!found) return NativeFxGraphResult::InvalidParameter;
        auto& events = staged.processor->isPrepareTimeParameter(initial.parameter)
            ? prepareEvents : runtimeEvents;
        auto& eventCount = staged.processor->isPrepareTimeParameter(initial.parameter)
            ? prepareEventCount : runtimeEventCount;
        events[eventCount++] = {0U, initial.parameter, initial.value};
    }
    if (prepareEventCount != 0U && !staged.processor->validateParameterEvents(nullptr, 0U))
        return NativeFxGraphResult::InvalidParameter;
    if (runtimeEventCount != 0U &&
        !staged.processor->validateParameterEvents(runtimeEvents.data(), runtimeEventCount))
        return NativeFxGraphResult::InvalidParameter;
    // Selector events are applied only to this unpublished candidate before
    // prepare(), so model-specific convolution resources are budgeted and
    // constructed for the selected configuration. They never reach the RT
    // event queue after activation.
    for (std::uint32_t index = 0U; index < prepareEventCount; ++index) {
        if (!staged.processor->setParameter(prepareEvents[index].parameter,
                                            prepareEvents[index].value))
            return NativeFxGraphResult::InvalidParameter;
    }
    if (!staged.processor->prepare(spec_)) return NativeFxGraphResult::InvalidSpec;
    // Revalidate against the concrete prepared sample rate and state before
    // queuing any ordinary parameters. No active graph state has changed yet.
    if (runtimeEventCount != 0U &&
        !staged.processor->validateParameterEvents(runtimeEvents.data(), runtimeEventCount))
        return NativeFxGraphResult::InvalidParameter;

    const auto latencySamples = staged.processor->fixedLatencySamples();
    const auto startupWarmupFrames = staged.processor->startupWarmupFrames();
    if (startupWarmupFrames > startupUpper.frames)
        return NativeFxGraphResult::UnsupportedOrdinal;
    if (latencySamples < 0 && mix != 1.0f) return NativeFxGraphResult::InvalidParameter;
    const auto alignSamples = latencySamples > 0 ? static_cast<std::uint64_t>(latencySamples) : 0U;
    if (alignSamples > alignmentUpperSamples) return NativeFxGraphResult::UnsupportedOrdinal;
    if (alignSamples > std::numeric_limits<std::uint64_t>::max() / (2U * sizeof(float)))
        return NativeFxGraphResult::MemoryBudgetExceeded;
    const auto alignBytes = alignSamples * 2U * sizeof(float);
    std::uint64_t expandedPermanent = 0U;
    std::uint64_t expandedPeak = 0U;
    if (!addFits(candidatePermanentBytes, alignBytes, expandedPermanent) ||
        !addFits(candidatePeakBytes, alignBytes, expandedPeak) ||
        !addFits(sizeof(*this), permanentProcessorBytes_, projected) ||
        !addFits(projected, expandedPeak, projected) ||
        (memoryBudgetBytes_ != 0U && projected > memoryBudgetBytes_))
        return NativeFxGraphResult::MemoryBudgetExceeded;

    staged.estimatedPermanentBytes = expandedPermanent;
    staged.latencySamples = latencySamples;
    staged.startupWarmupFrames = startupWarmupFrames;
    staged.outerMixSupported = latencySamples >= 0;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        staged.dryAlignLeft.resize(static_cast<std::size_t>(alignSamples), 0.0f);
        staged.dryAlignRight.resize(static_cast<std::size_t>(alignSamples), 0.0f);
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return NativeFxGraphResult::MemoryBudgetExceeded;
    }
#endif
    if (!staged.mixSmoother.prepare(spec_)) return NativeFxGraphResult::InvalidSpec;
    staged.mixSmoother.reset(mix);

    for (std::uint32_t index = 0U; index < runtimeEventCount; ++index) {
        const auto& initial = runtimeEvents[index];
        if (!staged.processor->setParameter(initial.parameter, initial.value))
            return NativeFxGraphResult::InvalidParameter;
    }

    const bool wasConfigured = targetSlot->configured;
    *targetSlot = std::move(staged);
    permanentProcessorBytes_ = withoutOld + expandedPermanent;
    if (!wasConfigured) ++configuredSlotCount_;
    recomputeTransitionWarmupFrames();
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraph::clearSlot(NativeFxBusAddress bus,
                                             std::uint8_t slotIndex) noexcept {
    if (!prepared_) return NativeFxGraphResult::NotPrepared;
    if (sealed_) return NativeFxGraphResult::AlreadySealed;
    if (!validBusAddress(bus)) return NativeFxGraphResult::InvalidBus;
    if (slotIndex >= kNativeFxGraphSlotsPerBus) return NativeFxGraphResult::InvalidSlot;
    auto* target = findSlot(bus, slotIndex);
    if (target == nullptr || !target->configured) return NativeFxGraphResult::InvalidSlot;
    permanentProcessorBytes_ -= target->estimatedPermanentBytes;
    *target = Slot{}; // processors are destroyed only on the control thread.
    --configuredSlotCount_;
    recomputeTransitionWarmupFrames();
    return NativeFxGraphResult::Ok;
}

void NativeFxGraph::recomputeTransitionWarmupFrames() noexcept {
    std::array<std::uint64_t, kNativeFxGraphBusCount> busWarmup{};
    const auto addSaturated = [](std::uint64_t left, std::uint64_t right) noexcept {
        return right > std::numeric_limits<std::uint64_t>::max() - left
            ? std::numeric_limits<std::uint64_t>::max() : left + right;
    };
    for (std::uint32_t bus = 0U; bus < kNativeFxGraphBusCount; ++bus) {
        for (std::uint32_t slotIndex = 0U; slotIndex < kNativeFxGraphSlotsPerBus; ++slotIndex) {
            const auto& slot = slots_[bus * kNativeFxGraphSlotsPerBus + slotIndex];
            if (slot.configured)
                busWarmup[bus] = addSaturated(
                    busWarmup[bus], slot.startupWarmupFrames);
        }
    }

    // Slots on one bus are serial, not parallel: an upstream fixed-latency FX
    // must have produced a complete window before the downstream FX can be
    // considered warm. The Native signal path also serializes Input into the
    // recorder/monitor, then Track into Master on playback. Use a conservative
    // maximum for Input -> Track -> Master, while accounting for every Track
    // bus and the optional Send -> Master branch separately.
    std::uint64_t maximumTrackWarmup = 0U;
    for (std::uint32_t track = 0U; track < 5U; ++track)
        maximumTrackWarmup = std::max(maximumTrackWarmup, busWarmup[1U + track]);
    const auto inputTrackMaster = addSaturated(
        addSaturated(busWarmup[0U], maximumTrackWarmup), busWarmup[7U]);
    const auto sendMaster = addSaturated(busWarmup[6U], busWarmup[7U]);
    std::uint64_t maximum = std::max(inputTrackMaster, sendMaster);
    for (const auto busWarmupFrames : busWarmup) maximum = std::max(maximum, busWarmupFrames);
    transitionWarmupFrames_ = static_cast<std::uint32_t>(std::min<std::uint64_t>(
        maximum, std::numeric_limits<std::uint32_t>::max()));
}

NativeFxGraphResult NativeFxGraph::seal() noexcept {
    if (!prepared_) return NativeFxGraphResult::NotPrepared;
    if (sealed_) return NativeFxGraphResult::AlreadySealed;
    sealed_ = true;
    return NativeFxGraphResult::Ok;
}

std::uint64_t NativeFxGraph::estimatedPermanentBytes() const noexcept {
    std::uint64_t result = 0U;
    return addFits(sizeof(*this), permanentProcessorBytes_, result) ? result
                                                                   : std::numeric_limits<std::uint64_t>::max();
}

bool NativeFxGraph::hasSlot(NativeFxBusAddress bus, std::uint8_t slotIndex) const noexcept {
    const auto* slot = findSlot(bus, slotIndex);
    return slot != nullptr && slot->configured;
}

std::uint16_t NativeFxGraph::slotOrdinal(NativeFxBusAddress bus,
                                         std::uint8_t slotIndex) const noexcept {
    const auto* slot = findSlot(bus, slotIndex);
    return slot != nullptr && slot->configured ? slot->ordinal : 0U;
}

NativeFxGraphResult NativeFxGraph::validateBlock(const NativeFxGraphBlock& block,
                                                 std::uint32_t frames) const noexcept {
    if (!prepared_) return NativeFxGraphResult::NotPrepared;
    if (!sealed_) return NativeFxGraphResult::GraphNotSealed;
    if (frames > spec_.maxBlockFrames || frames > kNativeFxGraphMaximumFrames)
        return NativeFxGraphResult::BlockTooLarge;
    if (frames == 0U) return NativeFxGraphResult::Ok;

    for (std::uint32_t bus = 0U; bus < kNativeFxGraphBusCount; ++bus) {
        bool configured = false;
        for (std::uint32_t slot = 0U; slot < kNativeFxGraphSlotsPerBus; ++slot)
            configured = configured || slots_[bus * kNativeFxGraphSlotsPerBus + slot].configured;
        if (!configured) continue;
        const StereoFrame* buffer = nullptr;
        if (bus == 0U) buffer = block.inputCapture;
        else if (bus >= 1U && bus <= 5U) buffer = block.trackPlayback[bus - 1U];
        else if (bus == 6U) buffer = block.sendReturn;
        else buffer = block.masterMix;
        if (buffer == nullptr) return NativeFxGraphResult::MissingBusBuffer;
        for (std::uint32_t slot = 0U; slot < kNativeFxGraphSlotsPerBus; ++slot) {
            const auto& configuredSlot = slots_[bus * kNativeFxGraphSlotsPerBus + slot];
            if (configuredSlot.configured &&
                !configuredSlot.processor->validateBlockRequest(2U, frames))
                return NativeFxGraphResult::InvalidBlock;
        }
    }
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraph::validateEvents(
    const NativeFxGraphBlock& block, std::uint32_t frames,
    std::uint64_t absoluteStartFrame, const NativeFxGraphEvent* events,
    std::uint32_t eventCount) const noexcept {
    if (eventCount > kNativeFxGraphEventCapacity || (eventCount != 0U && events == nullptr))
        return NativeFxGraphResult::TooManyEvents;
    if (eventCount == 0U) return NativeFxGraphResult::Ok;
    if (frames == 0U) return NativeFxGraphResult::InvalidEvent;

    const auto blockEnd = absoluteStartFrame + frames; // caller checks the addition.
    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        const auto& event = events[index];
        if (!validBusAddress(event.bus) || event.slotIndex >= kNativeFxGraphSlotsPerBus ||
            !validEventKind(event.kind) || !finite(event.value) ||
            event.graphGeneration != generation_ ||
            event.absoluteFrame >= blockEnd ||
            (index > 0U && event.absoluteFrame < events[index - 1U].absoluteFrame))
            return NativeFxGraphResult::InvalidEvent;
        const auto* slot = findSlot(event.bus, event.slotIndex);
        if (slot == nullptr || !slot->configured) return NativeFxGraphResult::InvalidEvent;
        const auto bus = busIndex(event.bus);
        const StereoFrame* buffer = nullptr;
        if (bus == 0U) buffer = block.inputCapture;
        else if (bus >= 1U && bus <= 5U) buffer = block.trackPlayback[bus - 1U];
        else if (bus == 6U) buffer = block.sendReturn;
        else buffer = block.masterMix;
        if (buffer == nullptr) return NativeFxGraphResult::MissingBusBuffer;
        if (event.kind == NativeFxGraphEventKind::SlotMix) {
            if (event.value < 0.0f || event.value > 1.0f || !finite(event.smoothingMs) ||
                event.smoothingMs < 0.0f || event.smoothingMs > 1000.0f ||
                (!slot->outerMixSupported && event.value != 1.0f))
                return NativeFxGraphResult::InvalidParameter;
        } else if (!slot->processor->validParameter(event.parameter, event.value)) {
            return NativeFxGraphResult::InvalidParameter;
        }
    }

    // Every distinct timestamp forms a setter group. Adapters queue controls
    // until their next process segment, so validate each group's bounded queue
    // capacity before any bus or processor state has advanced.
    for (std::uint32_t bus = 0U; bus < kNativeFxGraphBusCount; ++bus) {
        for (std::uint32_t slotIndex = 0U; slotIndex < kNativeFxGraphSlotsPerBus; ++slotIndex) {
            const auto& slot = slots_[bus * kNativeFxGraphSlotsPerBus + slotIndex];
            if (!slot.configured) continue;
            std::uint64_t groupFrame = std::numeric_limits<std::uint64_t>::max();
            std::uint32_t groupParameters = 0U;
            for (std::uint32_t index = 0U; index <= eventCount; ++index) {
                const auto currentFrame = index < eventCount ? events[index].absoluteFrame
                    : std::numeric_limits<std::uint64_t>::max();
                if (groupFrame != currentFrame && groupParameters != 0U) {
                    const auto frameOffset = groupFrame <= absoluteStartFrame ? 0U :
                        static_cast<std::uint32_t>(groupFrame - absoluteStartFrame);
                    if (groupParameters > slot.processor->maximumParameterEventsPerBlock() ||
                        (frameOffset == 0U &&
                         !slot.processor->canAcceptParameterEvents(groupParameters)))
                        return NativeFxGraphResult::InvalidParameter;
                }
                if (groupFrame != currentFrame) {
                    groupFrame = currentFrame;
                    groupParameters = 0U;
                }
                if (index < eventCount && busIndex(events[index].bus) == bus &&
                    events[index].slotIndex == slotIndex &&
                    events[index].kind == NativeFxGraphEventKind::ProcessorParameter)
                    ++groupParameters;
            }
        }
    }

    // Validate each slot's parameter state on a fixed-size shadow before any
    // bus can advance. This catches coupled controls whose individual values
    // are legal but whose combination is not. Processors may add stricter
    // same-timestamp validation through validateParameterEvents().
    for (std::uint32_t bus = 0U; bus < kNativeFxGraphBusCount; ++bus) {
        for (std::uint32_t slotIndex = 0U; slotIndex < kNativeFxGraphSlotsPerBus; ++slotIndex) {
            const auto& slot = slots_[bus * kNativeFxGraphSlotsPerBus + slotIndex];
            if (!slot.configured) continue;
            for (std::uint8_t parameter = 0U; parameter < slot.cachedParameterCount; ++parameter)
                parameterValidationScratch_[parameter] = slot.cachedParameters[parameter].target;
            std::array<webrc::dsp::FxParameterEvent, kNativeFxGraphEventCapacity> processorEvents{};
            std::uint32_t processorEventCount = 0U;
            std::uint32_t index = 0U;
            while (index < eventCount) {
                const auto frame = events[index].absoluteFrame;
                std::uint32_t groupEnd = index + 1U;
                while (groupEnd < eventCount && events[groupEnd].absoluteFrame == frame) ++groupEnd;
                std::uint32_t groupCount = 0U;
                for (std::uint32_t eventIndex = index; eventIndex < groupEnd; ++eventIndex) {
                    const auto& event = events[eventIndex];
                    if (busIndex(event.bus) != bus || event.slotIndex != slotIndex ||
                        event.kind != NativeFxGraphEventKind::ProcessorParameter) continue;
                    const webrc::dsp::FxParameterEvent processorEvent{
                        event.absoluteFrame <= absoluteStartFrame ? 0U :
                            static_cast<std::uint32_t>(event.absoluteFrame - absoluteStartFrame),
                        event.parameter, event.value};
                    processorEvents[processorEventCount++] = processorEvent;
                    ++groupCount;
                    for (std::uint8_t parameter = 0U; parameter < slot.cachedParameterCount; ++parameter) {
                        if (slot.cachedParameters[parameter].id == event.parameter) {
                            parameterValidationScratch_[parameter] = event.value;
                            break;
                        }
                    }
                }
                if (groupCount != 0U && !validShadowParameters(slot))
                    return NativeFxGraphResult::InvalidParameter;
                index = groupEnd;
            }
            // Validate the complete chronological batch once. Family adapters
            // carry their shadow controls between timestamps, so coupled values
            // that cross a temporary invalid state cannot slip through as
            // independently accepted groups. This runs before any bus is read
            // into mutable DSP state.
            if (processorEventCount != 0U &&
                !slot.processor->validateParameterEvents(processorEvents.data(), processorEventCount))
                return NativeFxGraphResult::InvalidParameter;
        }
    }
    return NativeFxGraphResult::Ok;
}

bool NativeFxGraph::validShadowParameters(const Slot& slot) const noexcept {
    const auto valueFor = [this, &slot](webrc::dsp::FxParameterId id, float fallback) noexcept {
        for (std::uint8_t index = 0U; index < slot.cachedParameterCount; ++index)
            if (slot.cachedParameters[index].id == id) return parameterValidationScratch_[index];
        return fallback;
    };
    using webrc::dsp::FxParameterId;
    if (slot.ordinal == 26U) {
        return valueFor(FxParameterId::EqLowSlope, 1.0f) <= 1.0f &&
               valueFor(FxParameterId::EqHighSlope, 1.0f) <= 1.0f;
    }
    if (slot.ordinal == 8U) {
        return valueFor(FxParameterId::RadioHighPassHz, 220.0f) <
               valueFor(FxParameterId::RadioLowPassHz, 3400.0f);
    }
    // Modulated delays use delay ± modulation depth as read bounds. Check the
    // full projected controls for every family before any earlier bus segment
    // can advance its DSP history.
    if (slot.ordinal == 5U || slot.ordinal == 33U || slot.ordinal == 37U ||
        slot.ordinal == 39U || slot.ordinal == 46U) {
        const double baseMs = valueFor(FxParameterId::DelayMs, 0.0f);
        const double depthMs = valueFor(FxParameterId::ModulationDepthMs, 0.0f);
        const double minMs = 2.0 * 1000.0 / static_cast<double>(spec_.sampleRate);
        const double maxMs = slot.ordinal == 5U ? 30.0
            : slot.ordinal == 33U ? 35.0
            : slot.ordinal == 46U ? 120.0 : 2000.0;
        return baseMs - depthMs >= minMs && baseMs + depthMs <= maxMs;
    }
    return true;
}

NativeFxGraphResult NativeFxGraph::processSlot(
    Slot& slot, NativeFxBusAddress bus, std::uint8_t slotIndex,
    std::uint32_t frames, std::uint64_t absoluteStartFrame,
    const NativeFxGraphEvent* events, std::uint32_t eventCount) noexcept {
    std::array<const float*, 2U> input{};
    std::array<float*, 2U> output{};

    const auto renderSegment = [this, &slot, &input, &output](std::uint32_t start,
                                                              std::uint32_t length) noexcept {
        if (length == 0U) return true;
        input[0] = work_[0].data() + start;
        input[1] = work_[1].data() + start;
        output[0] = result_[0].data() + start;
        output[1] = result_[1].data() + start;
        if (!slot.processor->processBlock(input.data(), output.data(), 2U, length)) return false;
        for (std::uint32_t sample = 0U; sample < length; ++sample) {
            const auto index = start + sample;
            float dryLeft = work_[0][index];
            float dryRight = work_[1][index];
            if (slot.latencySamples > 0) {
                const auto delayedLeft = slot.dryAlignLeft[slot.dryAlignWrite];
                const auto delayedRight = slot.dryAlignRight[slot.dryAlignWrite];
                slot.dryAlignLeft[slot.dryAlignWrite] = dryLeft;
                slot.dryAlignRight[slot.dryAlignWrite] = dryRight;
                ++slot.dryAlignWrite;
                if (slot.dryAlignWrite >= static_cast<std::uint32_t>(slot.latencySamples))
                    slot.dryAlignWrite = 0U;
                dryLeft = delayedLeft;
                dryRight = delayedRight;
            }
            const float mix = slot.mixSmoother.next();
            work_[0][index] = webrc::dsp::sanitize(
                dryLeft + mix * (result_[0][index] - dryLeft));
            work_[1][index] = webrc::dsp::sanitize(
                dryRight + mix * (result_[1][index] - dryRight));
        }
        return true;
    };

    std::uint32_t cursor = 0U;
    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        const auto& event = events[index];
        if (event.bus.kind != bus.kind || event.bus.trackIndex != bus.trackIndex ||
            event.slotIndex != slotIndex) continue;
        const auto offset = event.absoluteFrame <= absoluteStartFrame ? 0U :
            static_cast<std::uint32_t>(event.absoluteFrame - absoluteStartFrame);
        if (offset > frames) return NativeFxGraphResult::InvalidEvent;
        if (offset > cursor && !renderSegment(cursor, offset - cursor))
            return NativeFxGraphResult::InvalidBlock;
        cursor = offset;

        std::uint32_t groupEnd = index + 1U;
        while (groupEnd < eventCount && events[groupEnd].absoluteFrame == event.absoluteFrame &&
               events[groupEnd].bus.kind == bus.kind &&
               events[groupEnd].bus.trackIndex == bus.trackIndex &&
               events[groupEnd].slotIndex == slotIndex) ++groupEnd;
        for (std::uint32_t group = index; group < groupEnd; ++group) {
            const auto& current = events[group];
            if (current.kind == NativeFxGraphEventKind::SlotMix) {
                if (!slot.mixSmoother.setTarget(current.value, current.smoothingMs))
                    return NativeFxGraphResult::InvalidParameter;
            } else {
                if (!slot.processor->setParameter(current.parameter, current.value))
                    return NativeFxGraphResult::InvalidParameter;
                for (std::uint8_t parameter = 0U; parameter < slot.cachedParameterCount; ++parameter) {
                    if (slot.cachedParameters[parameter].id == current.parameter) {
                        slot.cachedParameters[parameter].target = current.value;
                        break;
                    }
                }
            }
        }
        index = groupEnd - 1U;
    }
    if (cursor < frames && !renderSegment(cursor, frames - cursor))
        return NativeFxGraphResult::InvalidBlock;
    // The work bank contains the processor result blended with the input. The
    // caller copies it back to the bus buffer after the complete chain.
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraph::processBus(
    NativeFxBusAddress bus, webrc::dsp::StereoFrame* samples, std::uint32_t frames,
    std::uint64_t absoluteStartFrame, const NativeFxGraphEvent* events,
    std::uint32_t eventCount, NativeFxGraphStats& stats) noexcept {
    const auto busPosition = busIndex(bus);
    if (busPosition >= kNativeFxGraphBusCount) return NativeFxGraphResult::InvalidBus;
    bool anySlot = false;
    for (std::uint32_t slot = 0U; slot < kNativeFxGraphSlotsPerBus; ++slot)
        anySlot = anySlot || slots_[busPosition * kNativeFxGraphSlotsPerBus + slot].configured;
    if (!anySlot) return NativeFxGraphResult::Ok;
    if (samples == nullptr) return NativeFxGraphResult::MissingBusBuffer;

    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        work_[0][frame] = webrc::dsp::sanitize(samples[frame].left);
        work_[1][frame] = webrc::dsp::sanitize(samples[frame].right);
    }
    for (std::uint8_t slotIndex = 0U; slotIndex < kNativeFxGraphSlotsPerBus; ++slotIndex) {
        auto& slot = slots_[busPosition * kNativeFxGraphSlotsPerBus + slotIndex];
        if (!slot.configured) continue;
        const auto result = processSlot(slot, bus, slotIndex, frames, absoluteStartFrame,
                                        events, eventCount);
        if (result != NativeFxGraphResult::Ok) return result;
    }
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        samples[frame].left = webrc::dsp::sanitize(work_[0][frame]);
        samples[frame].right = webrc::dsp::sanitize(work_[1][frame]);
    }
    stats.processedBusMask |= (std::uint32_t{1U} << busPosition);
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraph::processBlock(
    const NativeFxGraphBlock& block, std::uint32_t frames,
    NativeFxGraphStats* stats) noexcept {
    return processBlockWithEvents(block, frames, nextBlockFrame_, nullptr, 0U, stats);
}

NativeFxGraphResult NativeFxGraph::processBlockWithEvents(
    const NativeFxGraphBlock& block, std::uint32_t frames, std::uint64_t absoluteStartFrame,
    const NativeFxGraphEvent* events, std::uint32_t eventCount,
    NativeFxGraphStats* stats) noexcept {
    auto result = beginBlock(block, frames, absoluteStartFrame, events, eventCount, stats);
    if (result != NativeFxGraphResult::Ok || frames == 0U) return result;
    result = processInputBus();
    if (result == NativeFxGraphResult::Ok) {
        for (std::uint8_t track = 0U; track < 5U && result == NativeFxGraphResult::Ok; ++track)
            result = processTrackBus(track);
    }
    if (result == NativeFxGraphResult::Ok) result = processSendBus();
    if (result == NativeFxGraphResult::Ok) result = processMasterBus();
    if (result == NativeFxGraphResult::Ok) result = endBlock(stats);
    else cancelBlock();
    return result;
}

NativeFxGraphResult NativeFxGraph::beginBlock(
    const NativeFxGraphBlock& block, std::uint32_t frames, std::uint64_t absoluteStartFrame,
    const NativeFxGraphEvent* events, std::uint32_t eventCount,
    NativeFxGraphStats* stats) noexcept {
    NativeFxGraphStats stagedStats{};
    if (currentBlockOpen_) return NativeFxGraphResult::InvalidBlock;
    auto result = validateBlock(block, frames);
    if (result != NativeFxGraphResult::Ok) {
        if (stats != nullptr) *stats = stagedStats;
        return result;
    }
    if (frames == 0U && eventCount != 0U) return NativeFxGraphResult::InvalidEvent;
    if (absoluteStartFrame > kMaximumExactFrame - frames) return NativeFxGraphResult::InvalidBlock;
    result = validateEvents(block, frames, absoluteStartFrame, events, eventCount);
    if (result != NativeFxGraphResult::Ok) {
        stagedStats.rejectedEvents = eventCount;
        if (stats != nullptr) *stats = stagedStats;
        return result;
    }
    if (frames == 0U) {
        if (stats != nullptr) *stats = stagedStats;
        return NativeFxGraphResult::Ok;
    }

    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        if (events[index].absoluteFrame < absoluteStartFrame)
            ++stagedStats.lateEventsAppliedAtBlockStart;
        currentEvents_[index] = events[index];
    }
    currentBlock_ = block;
    currentFrames_ = frames;
    currentBlockStartFrame_ = absoluteStartFrame;
    currentEventCount_ = eventCount;
    currentStats_ = stagedStats;
    nextTrackBus_ = 0U;
    inputBusDone_ = false;
    sendBusDone_ = false;
    masterBusDone_ = false;
    currentBlockOpen_ = true;
    if (stats != nullptr) *stats = stagedStats;
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraph::processCurrentBus(NativeFxBusAddress bus,
                                                      StereoFrame* samples) noexcept {
    if (!currentBlockOpen_) return NativeFxGraphResult::InvalidBlock;
    return processBus(bus, samples, currentFrames_, currentBlockStartFrame_,
                      currentEvents_.data(), currentEventCount_, currentStats_);
}

NativeFxGraphResult NativeFxGraph::processInputBus() noexcept {
    if (!currentBlockOpen_ || inputBusDone_ || nextTrackBus_ != 0U)
        return NativeFxGraphResult::InvalidBlock;
    const auto result = processCurrentBus({NativeFxBusKind::Input, 0U}, currentBlock_.inputCapture);
    if (result == NativeFxGraphResult::Ok) inputBusDone_ = true;
    return result;
}

NativeFxGraphResult NativeFxGraph::processTrackBus(std::uint8_t trackIndex) noexcept {
    if (!currentBlockOpen_ || !inputBusDone_ || trackIndex != nextTrackBus_ ||
        trackIndex >= 5U || sendBusDone_)
        return NativeFxGraphResult::InvalidBlock;
    const auto result = processCurrentBus({NativeFxBusKind::Track, trackIndex},
                                          currentBlock_.trackPlayback[trackIndex]);
    if (result == NativeFxGraphResult::Ok) ++nextTrackBus_;
    return result;
}

NativeFxGraphResult NativeFxGraph::processSendBus() noexcept {
    if (!currentBlockOpen_ || !inputBusDone_ || nextTrackBus_ != 5U || sendBusDone_)
        return NativeFxGraphResult::InvalidBlock;
    const auto result = processCurrentBus({NativeFxBusKind::Send, 0U}, currentBlock_.sendReturn);
    if (result == NativeFxGraphResult::Ok) sendBusDone_ = true;
    return result;
}

NativeFxGraphResult NativeFxGraph::processMasterBus() noexcept {
    if (!currentBlockOpen_ || !sendBusDone_ || masterBusDone_)
        return NativeFxGraphResult::InvalidBlock;
    const auto result = processCurrentBus({NativeFxBusKind::Master, 0U}, currentBlock_.masterMix);
    if (result == NativeFxGraphResult::Ok) masterBusDone_ = true;
    return result;
}

NativeFxGraphResult NativeFxGraph::endBlock(NativeFxGraphStats* stats) noexcept {
    if (!currentBlockOpen_ || !masterBusDone_) return NativeFxGraphResult::InvalidBlock;
    currentStats_.eventsApplied = currentEventCount_;
    if (stats != nullptr) *stats = currentStats_;
    currentBlockOpen_ = false;
    currentEventCount_ = 0U;
    nextBlockFrame_ = currentBlockStartFrame_ + currentFrames_;
    currentFrames_ = 0U;
    return NativeFxGraphResult::Ok;
}

void NativeFxGraph::cancelBlock() noexcept {
    currentBlockOpen_ = false;
    currentEventCount_ = 0U;
    inputBusDone_ = false;
    nextTrackBus_ = 0U;
    sendBusDone_ = false;
    masterBusDone_ = false;
}

NativeFxGraphExchange::~NativeFxGraphExchange() {
    delete pending_.exchange(nullptr, std::memory_order_acq_rel);
    delete active_.exchange(nullptr, std::memory_order_acq_rel);
    delete retired_.exchange(nullptr, std::memory_order_acq_rel);
}

NativeFxGraphResult NativeFxGraphExchange::stage(
    std::unique_ptr<NativeFxGraph>& candidate) noexcept {
    if (!candidate || !candidate->sealed() || !candidate->prepared())
        return NativeFxGraphResult::GraphNotSealed;
    if (expectedSpecSet_) {
        const auto& spec = candidate->spec();
        if (spec.sampleRate != expectedSpec_.sampleRate ||
            spec.maxBlockFrames != expectedSpec_.maxBlockFrames ||
            spec.channels != expectedSpec_.channels)
            return NativeFxGraphResult::SpecMismatch;
    }
    bool expected = false;
    if (!swapInFlight_.compare_exchange_strong(expected, true,
                                                std::memory_order_acq_rel,
                                                std::memory_order_acquire))
        return NativeFxGraphResult::SwapBusy;
    NativeFxGraph* empty = nullptr;
    auto* raw = candidate.get();
    const auto candidateBytes = raw->estimatedPermanentBytes();
    const auto residentBytes = residentGraphBytes_.load(std::memory_order_relaxed);
    if (candidateBytes > std::numeric_limits<std::uint64_t>::max() - residentBytes) {
        swapInFlight_.store(false, std::memory_order_release);
        return NativeFxGraphResult::MemoryBudgetExceeded;
    }
    const auto currentGeneration = producerGeneration_.load(std::memory_order_relaxed);
    if (currentGeneration >= kMaximumExactFrame) {
        swapInFlight_.store(false, std::memory_order_release);
        return NativeFxGraphResult::InvalidBlock;
    }
    raw->setGeneration(currentGeneration + 1U);
    // Reserve the candidate's resident footprint before making it visible to
    // the audio owner. The old graph remains charged through crossfade and
    // retirement until reclaimRetired() has destroyed it.
    residentGraphBytes_.store(residentBytes + candidateBytes, std::memory_order_release);
    if (!pending_.compare_exchange_strong(empty, raw, std::memory_order_release,
                                          std::memory_order_relaxed)) {
        residentGraphBytes_.store(residentBytes, std::memory_order_release);
        swapInFlight_.store(false, std::memory_order_release);
        return NativeFxGraphResult::SwapBusy;
    }
    producerGeneration_.store(currentGeneration + 1U, std::memory_order_release);
    // Timestamp order belongs to one graph generation. A newly staged graph
    // may accept an early event even while old-generation future events remain
    // queued; the audio owner discards those stale events on its next block.
    producerLastFrame_ = 0U;
    producerHasFrame_ = false;
    expectedSpec_ = candidate->spec();
    expectedSpecSet_ = true;
    (void)candidate.release();
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraphExchange::postEvent(const NativeFxGraphEvent& event) noexcept {
    if (!NativeFxGraph::validBusAddress(event.bus) ||
        event.slotIndex >= kNativeFxGraphSlotsPerBus || !validEventKind(event.kind) ||
        !finite(event.value) || event.absoluteFrame > kMaximumExactFrame ||
        (event.kind == NativeFxGraphEventKind::SlotMix &&
         (!finite(event.smoothingMs) || event.smoothingMs < 0.0f ||
          event.smoothingMs > 1000.0f)))
        return NativeFxGraphResult::InvalidEvent;
    auto queued = event;
    const auto currentGeneration = producerGeneration_.load(std::memory_order_acquire);
    if (currentGeneration == 0U) return NativeFxGraphResult::NoActiveGraph;
    if (queued.graphGeneration == 0U) queued.graphGeneration = currentGeneration;
    // Only generation-zero events are implicitly bound to the current graph.
    // Reject explicit stale/future generations before consulting or mutating
    // producer timestamp order; an old far-future event must not poison a new
    // graph's near-term control stream.
    if (queued.graphGeneration != currentGeneration) return NativeFxGraphResult::InvalidEvent;
    if (producerHasFrame_ && event.absoluteFrame < producerLastFrame_)
        return NativeFxGraphResult::TimestampOutOfOrder;
    const auto write = eventWrite_.load(std::memory_order_relaxed);
    const auto read = eventRead_.load(std::memory_order_acquire);
    if (write - read >= kNativeFxGraphEventQueueCapacity)
        return NativeFxGraphResult::EventQueueFull;
    eventQueue_[static_cast<std::size_t>(write % kNativeFxGraphEventQueueCapacity)].event = queued;
    eventWrite_.store(write + 1U, std::memory_order_release);
    producerLastFrame_ = event.absoluteFrame;
    producerHasFrame_ = true;
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraphExchange::processBlock(
    const NativeFxGraphBlock& block, std::uint32_t frames, std::uint64_t absoluteStartFrame,
    NativeFxGraphStats* stats) noexcept {
    auto result = beginBlock(block, frames, absoluteStartFrame, stats);
    if (result != NativeFxGraphResult::Ok || frames == 0U) return result;
    result = processInputBus();
    if (result == NativeFxGraphResult::Ok) {
        for (std::uint8_t track = 0U; track < 5U && result == NativeFxGraphResult::Ok; ++track)
            result = processTrackBus(track);
    }
    if (result == NativeFxGraphResult::Ok) result = processSendBus();
    if (result == NativeFxGraphResult::Ok) result = processMasterBus();
    if (result == NativeFxGraphResult::Ok) result = endBlock(stats);
    else cancelBlock();
    return result;
}

NativeFxGraphResult NativeFxGraphExchange::beginBlock(
    const NativeFxGraphBlock& block, std::uint32_t frames, std::uint64_t absoluteStartFrame,
    NativeFxGraphStats* stats) noexcept {
    NativeFxGraphStats stagedStats{};
    if (currentBlockOpen_) return NativeFxGraphResult::InvalidBlock;
    (void)activatePendingAtBoundary();
    auto* graph = active_.load(std::memory_order_acquire);
    if (graph == nullptr) {
        if (stats != nullptr) *stats = stagedStats;
        return NativeFxGraphResult::NoActiveGraph;
    }
    const auto blockValidation = graph->validateBlock(block, frames);
    if (blockValidation != NativeFxGraphResult::Ok) {
        if (stats != nullptr) *stats = stagedStats;
        return blockValidation;
    }
    if (absoluteStartFrame > kMaximumExactFrame - frames) {
        if (stats != nullptr) *stats = stagedStats;
        return NativeFxGraphResult::InvalidBlock;
    }
    if (frames == 0U) {
        if (stats != nullptr) *stats = stagedStats;
        return NativeFxGraphResult::Ok;
    }

    const auto blockEnd = absoluteStartFrame + frames;
    auto read = eventRead_.load(std::memory_order_relaxed);
    const auto write = eventWrite_.load(std::memory_order_acquire);
    std::uint32_t dueCount = 0U;
    std::uint32_t dueTotal = 0U;
    std::uint32_t staleCount = 0U;
    bool tooMany = false;
    while (read < write) {
        const auto& event = eventQueue_[static_cast<std::size_t>(read % kNativeFxGraphEventQueueCapacity)].event;
        if (event.graphGeneration < graph->generation()) {
            ++staleCount;
            ++dueTotal;
            ++read;
            continue;
        }
        if (event.graphGeneration > graph->generation()) break;
        if (event.absoluteFrame >= blockEnd) break;
        if (dueCount < dueEvents_.size()) dueEvents_[dueCount++] = event;
        else tooMany = true;
        ++dueTotal;
        ++read;
    }
    eventRead_.store(read, std::memory_order_release);
    if (staleCount != 0U) {
        staleGenerationEventCount_.fetch_add(staleCount, std::memory_order_relaxed);
        stagedStats.staleGenerationEventsDiscarded = staleCount;
    }
    if (tooMany) {
        stagedStats.rejectedEvents = dueTotal;
        if (stats != nullptr) *stats = stagedStats;
        return NativeFxGraphResult::TooManyEvents;
    }

    NativeFxGraphStats graphStats{};
    const auto result = graph->beginBlock(block, frames, absoluteStartFrame,
                                           dueEvents_.data(), dueCount, &graphStats);
    if (result != NativeFxGraphResult::Ok) {
        stagedStats.lateEventsAppliedAtBlockStart = graphStats.lateEventsAppliedAtBlockStart;
        if (stats != nullptr) {
            stagedStats.rejectedEvents = dueTotal;
            *stats = stagedStats;
        }
        return result == NativeFxGraphResult::InvalidParameter ||
               result == NativeFxGraphResult::InvalidEvent
            ? NativeFxGraphResult::EventBatchRejected : result;
    }
    if (crossfadeGraph_ != nullptr) {
        const auto previousValidation = crossfadeGraph_->validateBlock(block, frames);
        if (previousValidation != NativeFxGraphResult::Ok) {
            // The new graph can legitimately alter which host buses it needs.
            // When the prior topology cannot process this host block, retire it
            // without running a partial or unsafe crossfade.
            NativeFxGraph* empty = nullptr;
            if (retired_.compare_exchange_strong(empty, crossfadeGraph_,
                    std::memory_order_release, std::memory_order_relaxed)) {
                crossfadeGraph_ = nullptr;
                crossfadeProgress_ = 0U;
            }
        } else {
            crossfadeBlock_.inputCapture = block.inputCapture ? crossfadeInput_.data() : nullptr;
            for (std::size_t track = 0U; track < block.trackPlayback.size(); ++track)
                crossfadeBlock_.trackPlayback[track] = block.trackPlayback[track]
                    ? crossfadeTracks_[track].data() : nullptr;
            crossfadeBlock_.sendReturn = block.sendReturn ? crossfadeSend_.data() : nullptr;
            crossfadeBlock_.masterMix = block.masterMix ? crossfadeMaster_.data() : nullptr;
            const auto previousResult = crossfadeGraph_->beginBlock(
                crossfadeBlock_, frames, absoluteStartFrame, nullptr, 0U, nullptr);
            if (previousResult != NativeFxGraphResult::Ok) {
                graph->cancelBlock();
                stagedStats.rejectedEvents = dueTotal;
                if (stats != nullptr) *stats = stagedStats;
                return previousResult;
            }
        }
    }
    stagedStats.lateEventsAppliedAtBlockStart = graphStats.lateEventsAppliedAtBlockStart;
    processingGraph_ = graph;
    currentStats_ = stagedStats;
    currentBlockOpen_ = true;
    if (stats != nullptr) *stats = currentStats_;
    return NativeFxGraphResult::Ok;
}

NativeFxGraphResult NativeFxGraphExchange::processInputBus() noexcept {
    if (!currentBlockOpen_ || processingGraph_ == nullptr) return NativeFxGraphResult::InvalidBlock;
    auto* inputCapture = processingGraph_->currentBlock_.inputCapture;
    const auto frames = processingGraph_->currentFrames_;
    const bool transitioning = crossfadeGraph_ != nullptr || crossfadeFromDry_;
    if (transitioning && inputCapture != nullptr) {
        copyCrossfadeBus({NativeFxBusKind::Input, 0U}, inputCapture, frames);
    }
    auto result = processingGraph_->processInputBus();
    if (result != NativeFxGraphResult::Ok || !transitioning) return result;
    if (crossfadeGraph_ != nullptr) result = processPreviousBus({NativeFxBusKind::Input, 0U});
    if (result == NativeFxGraphResult::Ok && inputCapture != nullptr)
        blendCrossfadeBus(inputCapture, crossfadeInput_.data(), frames);
    return result;
}

NativeFxGraphResult NativeFxGraphExchange::processTrackBus(std::uint8_t trackIndex) noexcept {
    if (!currentBlockOpen_ || processingGraph_ == nullptr) return NativeFxGraphResult::InvalidBlock;
    auto* track = trackIndex < processingGraph_->currentBlock_.trackPlayback.size()
        ? processingGraph_->currentBlock_.trackPlayback[trackIndex] : nullptr;
    const auto frames = processingGraph_->currentFrames_;
    const bool transitioning = crossfadeGraph_ != nullptr || crossfadeFromDry_;
    if (transitioning && track != nullptr)
        copyCrossfadeBus({NativeFxBusKind::Track, trackIndex},
                         track, frames);
    auto result = processingGraph_->processTrackBus(trackIndex);
    if (result != NativeFxGraphResult::Ok || !transitioning) return result;
    if (crossfadeGraph_ != nullptr) result = processPreviousBus({NativeFxBusKind::Track, trackIndex});
    if (result == NativeFxGraphResult::Ok && track != nullptr)
        blendCrossfadeBus(track, crossfadeTracks_[trackIndex].data(), frames);
    return result;
}

NativeFxGraphResult NativeFxGraphExchange::processSendBus() noexcept {
    if (!currentBlockOpen_ || processingGraph_ == nullptr) return NativeFxGraphResult::InvalidBlock;
    auto* send = processingGraph_->currentBlock_.sendReturn;
    const auto frames = processingGraph_->currentFrames_;
    const bool transitioning = crossfadeGraph_ != nullptr || crossfadeFromDry_;
    if (transitioning && send != nullptr)
        copyCrossfadeBus({NativeFxBusKind::Send, 0U}, send, frames);
    auto result = processingGraph_->processSendBus();
    if (result != NativeFxGraphResult::Ok || !transitioning) return result;
    if (crossfadeGraph_ != nullptr) result = processPreviousBus({NativeFxBusKind::Send, 0U});
    if (result == NativeFxGraphResult::Ok && send != nullptr)
        blendCrossfadeBus(send, crossfadeSend_.data(), frames);
    return result;
}

NativeFxGraphResult NativeFxGraphExchange::processMasterBus() noexcept {
    if (!currentBlockOpen_ || processingGraph_ == nullptr) return NativeFxGraphResult::InvalidBlock;
    auto* master = processingGraph_->currentBlock_.masterMix;
    const auto frames = processingGraph_->currentFrames_;
    const bool transitioning = crossfadeGraph_ != nullptr || crossfadeFromDry_;
    if (transitioning && master != nullptr)
        copyCrossfadeBus({NativeFxBusKind::Master, 0U}, master, frames);
    auto result = processingGraph_->processMasterBus();
    if (result != NativeFxGraphResult::Ok || !transitioning) return result;
    if (crossfadeGraph_ != nullptr) result = processPreviousBus({NativeFxBusKind::Master, 0U});
    if (result == NativeFxGraphResult::Ok && master != nullptr)
        blendCrossfadeBus(master, crossfadeMaster_.data(), frames);
    return result;
}

NativeFxGraphResult NativeFxGraphExchange::endBlock(NativeFxGraphStats* stats) noexcept {
    if (!currentBlockOpen_ || processingGraph_ == nullptr)
        return NativeFxGraphResult::InvalidBlock;
    NativeFxGraphStats graphStats{};
    const auto blockFrames = processingGraph_->currentFrames_;
    const auto result = processingGraph_->endBlock(&graphStats);
    if (result == NativeFxGraphResult::Ok &&
        (crossfadeGraph_ != nullptr || crossfadeFromDry_)) {
        if (crossfadeGraph_ != nullptr) {
            const auto previousResult = crossfadeGraph_->endBlock(nullptr);
            if (previousResult != NativeFxGraphResult::Ok) return previousResult;
        }
        if (crossfadeWarmupRemaining_ != 0U) {
            crossfadeWarmupRemaining_ = blockFrames >= crossfadeWarmupRemaining_
                ? 0U : crossfadeWarmupRemaining_ - blockFrames;
        } else {
            crossfadeProgress_ = std::min(kNativeFxGraphSwapCrossfadeFrames,
                                          crossfadeProgress_ + blockFrames);
        }
        if (crossfadeProgress_ >= kNativeFxGraphSwapCrossfadeFrames) {
            if (crossfadeGraph_ != nullptr) {
                NativeFxGraph* empty = nullptr;
                if (retired_.compare_exchange_strong(empty, crossfadeGraph_,
                        std::memory_order_release, std::memory_order_relaxed)) {
                    crossfadeGraph_ = nullptr;
                    crossfadeProgress_ = 0U;
                    crossfadeWarmupRemaining_ = 0U;
                }
            } else {
                crossfadeFromDry_ = false;
                crossfadeProgress_ = 0U;
                crossfadeWarmupRemaining_ = 0U;
                swapInFlight_.store(false, std::memory_order_release);
            }
        }
    }
    currentBlockOpen_ = false;
    processingGraph_ = nullptr;
    if (result != NativeFxGraphResult::Ok) return result;
    graphStats.staleGenerationEventsDiscarded = currentStats_.staleGenerationEventsDiscarded;
    if (stats != nullptr) *stats = graphStats;
    return NativeFxGraphResult::Ok;
}

void NativeFxGraphExchange::cancelBlock() noexcept {
    if (processingGraph_ != nullptr) processingGraph_->cancelBlock();
    if (crossfadeGraph_ != nullptr) crossfadeGraph_->cancelBlock();
    processingGraph_ = nullptr;
    currentBlockOpen_ = false;
}

void NativeFxGraphExchange::copyCrossfadeBus(NativeFxBusAddress bus,
                                             const webrc::dsp::StereoFrame* source,
                                             std::uint32_t frames) noexcept {
    if (source == nullptr || frames > kNativeFxGraphMaximumFrames) return;
    webrc::dsp::StereoFrame* destination = nullptr;
    switch (NativeFxGraph::busIndex(bus)) {
    case 0U: destination = crossfadeInput_.data(); break;
    case 1U: case 2U: case 3U: case 4U: case 5U:
        destination = crossfadeTracks_[bus.trackIndex].data(); break;
    case 6U: destination = crossfadeSend_.data(); break;
    case 7U: destination = crossfadeMaster_.data(); break;
    default: return;
    }
    std::copy_n(source, frames, destination);
}

void NativeFxGraphExchange::blendCrossfadeBus(
    webrc::dsp::StereoFrame* current, const webrc::dsp::StereoFrame* previous,
    std::uint32_t frames) noexcept {
    if (current == nullptr || previous == nullptr || frames > kNativeFxGraphMaximumFrames) return;
    if (crossfadeWarmupRemaining_ != 0U) {
        std::copy_n(previous, frames, current);
        return;
    }
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        const auto progressed = std::min(kNativeFxGraphSwapCrossfadeFrames,
            crossfadeProgress_ + frame + 1U);
        const float mix = static_cast<float>(progressed) /
                          static_cast<float>(kNativeFxGraphSwapCrossfadeFrames);
        current[frame].left = webrc::dsp::sanitize(
            previous[frame].left + mix * (current[frame].left - previous[frame].left));
        current[frame].right = webrc::dsp::sanitize(
            previous[frame].right + mix * (current[frame].right - previous[frame].right));
    }
}

NativeFxGraphResult NativeFxGraphExchange::processPreviousBus(NativeFxBusAddress bus) noexcept {
    if (crossfadeGraph_ == nullptr) return NativeFxGraphResult::Ok;
    switch (bus.kind) {
    case NativeFxBusKind::Input: return crossfadeGraph_->processInputBus();
    case NativeFxBusKind::Track: return crossfadeGraph_->processTrackBus(bus.trackIndex);
    case NativeFxBusKind::Send: return crossfadeGraph_->processSendBus();
    case NativeFxBusKind::Master: return crossfadeGraph_->processMasterBus();
    }
    return NativeFxGraphResult::InvalidBus;
}

bool NativeFxGraphExchange::reclaimRetired() noexcept {
    auto* graph = retired_.exchange(nullptr, std::memory_order_acq_rel);
    if (graph == nullptr) return false;
    const auto graphBytes = graph->estimatedPermanentBytes();
    delete graph;

    auto resident = residentGraphBytes_.load(std::memory_order_acquire);
    if (resident < graphBytes) {
        // Fail closed if an internal accounting invariant is ever violated:
        // keep swaps blocked rather than admit a candidate against an
        // understated aggregate footprint.
        return false;
    }
    residentGraphBytes_.fetch_sub(graphBytes, std::memory_order_acq_rel);
    // This release publishes the completed destruction and ledger update to
    // any subsequent candidate preflight.
    swapInFlight_.store(false, std::memory_order_release);
    return true;
}

std::uint64_t NativeFxGraphExchange::eventQueueDepth() const noexcept {
    const auto write = eventWrite_.load(std::memory_order_acquire);
    const auto read = eventRead_.load(std::memory_order_acquire);
    return write >= read ? write - read : 0U;
}

std::uint32_t NativeFxGraphExchange::queuedEventCount() const noexcept {
    return static_cast<std::uint32_t>(eventQueueDepth());
}

std::uint64_t NativeFxGraphExchange::activeGraphBytes() const noexcept {
    return activeGraphBytes_.load(std::memory_order_acquire);
}

std::uint64_t NativeFxGraphExchange::residentGraphBytes() const noexcept {
    return residentGraphBytes_.load(std::memory_order_acquire);
}

NativeFxGraph* NativeFxGraphExchange::activatePendingAtBoundary() noexcept {
    auto* candidate = pending_.exchange(nullptr, std::memory_order_acq_rel);
    if (candidate == nullptr) return active_.load(std::memory_order_acquire);
    auto* previous = active_.exchange(candidate, std::memory_order_acq_rel);
    if (previous == nullptr) {
        crossfadeGraph_ = nullptr;
        crossfadeFromDry_ = true;
        crossfadeProgress_ = 0U;
        crossfadeWarmupRemaining_ = candidate->transitionWarmupFrames();
        activeGraphBytes_.store(candidate->estimatedPermanentBytes(),
                                std::memory_order_release);
    } else {
        if (crossfadeGraph_ != nullptr || retired_.load(std::memory_order_acquire) != nullptr) {
            // The control API keeps a swap blocked until the prior graph has
            // been reclaimed. Defensively restore the prior graph if that
            // single-owner invariant is ever violated.
            active_.store(previous, std::memory_order_release);
            pending_.store(candidate, std::memory_order_release);
        } else {
            crossfadeGraph_ = previous;
            crossfadeFromDry_ = false;
            crossfadeProgress_ = 0U;
            crossfadeWarmupRemaining_ = candidate->transitionWarmupFrames();
            activeGraphBytes_.store(candidate->estimatedPermanentBytes(),
                                    std::memory_order_release);
        }
    }
    return active_.load(std::memory_order_acquire);
}

} // namespace webrc::native
