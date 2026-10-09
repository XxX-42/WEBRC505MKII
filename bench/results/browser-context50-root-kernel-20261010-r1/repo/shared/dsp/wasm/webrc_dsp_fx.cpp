#include "webrc_dsp_fx.h"

#include "handle_registry.hpp"
#include "webrc/dsp/fx_registry.hpp"
#include "webrc/dsp/musical_fx_context.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>

namespace {

using namespace webrc::dsp;
using webrc::dsp::wasm::HandleDomain;
using webrc::dsp::wasm::HandleRegistry;
using webrc::dsp::wasm::HandleStatus;
using webrc::dsp::wasm::HandleView;
using webrc::dsp::wasm::registry;

constexpr std::uint32_t kFxAllocatorAllowance = 2048U;
constexpr std::uint32_t kConfiguredCreateV2ApiVersion = 2U;
constexpr std::uint32_t kFxTypedContextApiVersion = 1U;
constexpr std::uint32_t kFxMidiContextEventCapacity = 64U;

static_assert(sizeof(WebrcDspFxMidiEventV1) == 8U,
              "WebrcDspFxMidiEventV1 is a fixed 8-byte C ABI record");
static_assert(alignof(WebrcDspFxMidiEventV1) == alignof(std::uint32_t),
              "WebrcDspFxMidiEventV1 alignment is part of the C ABI");

struct InitialParameter {
    FxParameterId id = FxParameterId::FrequencyHz;
    float value = 0.0f;
};

struct FxState {
    std::unique_ptr<FxProcessor> processor{};
};

std::int32_t gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;

void destroyFxState(void* payload) noexcept {
    delete static_cast<FxState*>(payload);
}

std::int32_t fxStateFor(WebrcDspHandle handle, FxState*& output,
                        HandleView* viewOutput = nullptr) noexcept {
    HandleView view{};
    const auto status = registry().lookup(handle, view);
    if (status != HandleStatus::HandleOk) return status;
    if (view.domain != HandleDomain::Fx) return WEBRC_DSP_BAD_KIND;
    auto* state = static_cast<FxState*>(view.payload);
    if (!state || !state->processor || state->processor->ordinal() != view.kind) {
        return WEBRC_DSP_BAD_HANDLE;
    }
    output = state;
    if (viewOutput) *viewOutput = view;
    return WEBRC_DSP_OK;
}

bool supportedOrdinal(std::uint32_t ordinal) noexcept {
    return ordinal > 0U && ordinal <= std::numeric_limits<std::uint16_t>::max() &&
           fxMemoryRequirement(static_cast<std::uint16_t>(ordinal), ProcessSpec{48000.0f, 128U, 2U}).supported;
}

template <typename T>
bool validLinearMemorySpan(const T* pointer, std::uint32_t count) noexcept {
    if (count == 0U) return true;
    if (!pointer) return false;
    const auto address = reinterpret_cast<std::uintptr_t>(pointer);
    if ((address % alignof(T)) != 0U) return false;
    const auto byteCount = static_cast<std::uint64_t>(count) * sizeof(T);
#if defined(__wasm__) || defined(__wasm32__)
    const auto memoryBytes = static_cast<std::uint64_t>(__builtin_wasm_memory_size(0)) * 65536ULL;
    if (address > memoryBytes || byteCount > memoryBytes - address) return false;
#endif
    return byteCount <= std::numeric_limits<std::uintptr_t>::max() - address;
}

bool copyAndValidateInitialParameters(std::uint16_t ordinal,
                                      const std::uint32_t* parameterIds,
                                      const float* parameterValues,
                                      std::uint32_t parameterCount,
                                      std::array<InitialParameter, kFxEventCapacity>& output) noexcept {
    if (parameterCount > kFxEventCapacity ||
        !validLinearMemorySpan(parameterIds, parameterCount) ||
        !validLinearMemorySpan(parameterValues, parameterCount)) return false;

    std::size_t descriptorCount = 0U;
    const auto* descriptors = fxParameterDescriptors(ordinal, descriptorCount);
    if (!descriptors && parameterCount != 0U) return false;

    std::uint32_t selectorMask = 0U;
    for (std::uint32_t index = 0U; index < parameterCount; ++index) {
        const auto rawId = parameterIds[index];
        const auto value = parameterValues[index];
        if (rawId > std::numeric_limits<std::uint16_t>::max() || !std::isfinite(value)) return false;
        const auto id = static_cast<FxParameterId>(rawId);
        const auto duplicate = std::find_if(output.begin(), output.begin() + index,
            [id](const InitialParameter& item) { return item.id == id; });
        if (duplicate != output.begin() + index) return false;

        const FxParameterDescriptor* match = nullptr;
        for (std::size_t descriptorIndex = 0U; descriptorIndex < descriptorCount; ++descriptorIndex) {
            if (descriptors[descriptorIndex].id == id) {
                match = &descriptors[descriptorIndex];
                break;
            }
        }
        if (!match || value < match->minimum || value > match->maximum) return false;
        output[index] = {id, value};

        if (ordinal == 23U) {
            switch (id) {
            case FxParameterId::AmpModel: selectorMask |= 1U << 0U; break;
            case FxParameterId::SpeakerModel: selectorMask |= 1U << 1U; break;
            case FxParameterId::MicModel: selectorMask |= 1U << 2U; break;
            case FxParameterId::MicDistance: selectorMask |= 1U << 3U; break;
            case FxParameterId::MicPositionCm: selectorMask |= 1U << 4U; break;
            default: break;
            }
        }
    }

    // PREAMP model selectors are a prepare-time contract. Require all five so
    // an omitted selector can never silently choose a clean-room default.
    return ordinal != 23U || selectorMask == 0x1fU;
}

WebrcDspHandle createFxHandleV2(std::uint32_t ordinal, const ProcessSpec& spec,
                                const std::uint32_t* parameterIds,
                                const float* parameterValues,
                                std::uint32_t parameterCount) noexcept {
    if (ordinal > std::numeric_limits<std::uint16_t>::max()) {
        gLastCreateStatus = WEBRC_DSP_BAD_KIND;
        return 0U;
    }
    const auto narrowOrdinal = static_cast<std::uint16_t>(ordinal);
    const auto requirement = fxMemoryRequirement(narrowOrdinal, spec);
    const auto warmupLimit = fxStartupWarmupUpperBoundSamples(narrowOrdinal, spec);
    if (!requirement.supported || !warmupLimit.supported) {
        gLastCreateStatus = WEBRC_DSP_BAD_KIND;
        return 0U;
    }

    std::array<InitialParameter, kFxEventCapacity> initialParameters{};
    if (!copyAndValidateInitialParameters(narrowOrdinal, parameterIds, parameterValues,
                                          parameterCount, initialParameters)) {
        gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }

    if (requirement.peakBytes() > std::numeric_limits<std::uint32_t>::max() - kFxAllocatorAllowance) {
        gLastCreateStatus = WEBRC_DSP_MEMORY_BUDGET;
        return 0U;
    }
    const auto accountedBytes = static_cast<std::uint32_t>(requirement.peakBytes()) + kFxAllocatorAllowance;
    HandleRegistry::Reservation reservation{};
    const auto reserveStatus = registry().reserve(accountedBytes, reservation);
    if (reserveStatus != WEBRC_DSP_OK) {
        gLastCreateStatus = reserveStatus;
        return 0U;
    }

    auto* state = new (std::nothrow) FxState{};
    if (!state) {
        gLastCreateStatus = WEBRC_DSP_ALLOCATION_FAILED;
        return 0U;
    }
    state->processor = createFxProcessor(narrowOrdinal);
    if (!state->processor) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_ALLOCATION_FAILED;
        return 0U;
    }

    std::array<FxParameterEvent, kFxEventCapacity> ordinaryParameters{};
    std::uint32_t ordinaryCount = 0U;
    for (std::uint32_t index = 0U; index < parameterCount; ++index) {
        const auto& initial = initialParameters[index];
        if (!state->processor->validParameter(initial.id, initial.value)) {
            delete state;
            gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
            return 0U;
        }
        if (state->processor->isPrepareTimeParameter(initial.id)) {
            if (!state->processor->setParameter(initial.id, initial.value)) {
                delete state;
                gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
                return 0U;
            }
        } else {
            ordinaryParameters[ordinaryCount++] = {0U, initial.id, initial.value};
        }
    }

    if (!state->processor->prepare(spec)) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    if (ordinaryCount != 0U &&
        !state->processor->validateParameterEvents(ordinaryParameters.data(), ordinaryCount)) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }
    for (std::uint32_t index = 0U; index < ordinaryCount; ++index) {
        const auto& initial = ordinaryParameters[index];
        if (!state->processor->setParameter(initial.parameter, initial.value)) {
            delete state;
            gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
            return 0U;
        }
    }
    const auto startupFrames = state->processor->startupWarmupFrames();
    if (startupFrames > warmupLimit.frames) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }

    const auto handle = registry().publish(reservation, HandleDomain::Fx, ordinal, spec,
                                           state, destroyFxState);
    if (!handle) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    gLastCreateStatus = WEBRC_DSP_OK;
    return handle;
}

} // namespace

extern "C" {

std::uint32_t webrc_dsp_fx_api_version(void) { return 1U; }

std::uint32_t webrc_dsp_fx_create_v2_api_version(void) {
    return kConfiguredCreateV2ApiVersion;
}

std::uint32_t webrc_dsp_fx_context_api_version(void) {
    return kFxTypedContextApiVersion;
}

std::uint32_t webrc_dsp_fx_catalog_size(void) {
    return static_cast<std::uint32_t>(fxCatalogSize());
}

std::uint32_t webrc_dsp_fx_id_pointer(std::uint32_t ordinal) {
    const auto* descriptor = ordinal <= std::numeric_limits<std::uint16_t>::max()
        ? findFxByOrdinal(static_cast<std::uint16_t>(ordinal)) : nullptr;
    return descriptor ? static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(descriptor->id.data())) : 0U;
}

std::uint32_t webrc_dsp_fx_name_pointer(std::uint32_t ordinal) {
    const auto* descriptor = ordinal <= std::numeric_limits<std::uint16_t>::max()
        ? findFxByOrdinal(static_cast<std::uint16_t>(ordinal)) : nullptr;
    return descriptor ? static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(descriptor->displayName.data())) : 0U;
}

std::uint32_t webrc_dsp_fx_family_pointer(std::uint32_t ordinal) {
    const auto* descriptor = ordinal <= std::numeric_limits<std::uint16_t>::max()
        ? findFxByOrdinal(static_cast<std::uint16_t>(ordinal)) : nullptr;
    return descriptor ? static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(descriptor->family.data())) : 0U;
}

std::uint32_t webrc_dsp_fx_is_processor_available(std::uint32_t ordinal) {
    return supportedOrdinal(ordinal) ? 1U : 0U;
}

std::uint32_t webrc_dsp_fx_official_parameters_validated(std::uint32_t ordinal) {
    const auto* descriptor = ordinal <= std::numeric_limits<std::uint16_t>::max()
        ? findFxByOrdinal(static_cast<std::uint16_t>(ordinal)) : nullptr;
    return descriptor && descriptor->officialParameterContractValidated ? 1U : 0U;
}

std::uint32_t webrc_dsp_fx_parameter_count(std::uint32_t ordinal) {
    if (ordinal > std::numeric_limits<std::uint16_t>::max()) return 0U;
    std::size_t count = 0;
    (void)fxParameterDescriptors(static_cast<std::uint16_t>(ordinal), count);
    return count > UINT32_MAX ? 0U : static_cast<std::uint32_t>(count);
}

std::int32_t webrc_dsp_fx_parameter_info(std::uint32_t ordinal,
                                         std::uint32_t parameterIndex,
                                         WebrcDspFxParameterInfo* output) {
    if (!validLinearMemorySpan(output, 1U) || ordinal > std::numeric_limits<std::uint16_t>::max())
        return WEBRC_DSP_BAD_ARGUMENT;
    std::size_t count = 0;
    const auto* descriptors = fxParameterDescriptors(static_cast<std::uint16_t>(ordinal), count);
    if (!descriptors) return WEBRC_DSP_BAD_KIND;
    if (parameterIndex >= count) return WEBRC_DSP_BAD_ARGUMENT;
    const auto& descriptor = descriptors[parameterIndex];
    output->id = static_cast<std::uint32_t>(descriptor.id);
    output->minimum = descriptor.minimum;
    output->maximum = descriptor.maximum;
    output->defaultValue = descriptor.defaultValue;
    output->namePointer = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(descriptor.name.data()));
    output->unitPointer = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(descriptor.unit.data()));
    output->origin = static_cast<std::uint32_t>(descriptor.origin);
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_fx_memory_info(std::uint32_t ordinal, float sampleRate,
                                     std::uint32_t maxBlockFrames, std::uint32_t channels,
                                     WebrcDspFxMemoryInfo* output) {
    if (!validLinearMemorySpan(output, 1U) || ordinal > std::numeric_limits<std::uint16_t>::max())
        return WEBRC_DSP_BAD_ARGUMENT;
    const ProcessSpec spec{sampleRate, maxBlockFrames, channels};
    const auto requirement = fxMemoryRequirement(static_cast<std::uint16_t>(ordinal), spec);
    output->objectBytes = requirement.objectBytes;
    output->persistentPreparedBytes = requirement.persistentPreparedBytes;
    output->prepareScratchBytes = requirement.prepareScratchBytes;
    output->peakBytes = requirement.peakBytes();
    output->supported = requirement.supported ? 1U : 0U;
    return requirement.supported ? WEBRC_DSP_OK : WEBRC_DSP_BAD_KIND;
}

WebrcDspHandle webrc_dsp_fx_create(std::uint32_t ordinal, float sampleRate,
                                   std::uint32_t maxBlockFrames, std::uint32_t channels) {
    // The legacy call cannot supply PREAMP's preparation selectors. Refuse it
    // rather than constructing a default model that the caller did not choose.
    if (ordinal == 23U) {
        gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }
    return createFxHandleV2(ordinal, ProcessSpec{sampleRate, maxBlockFrames, channels},
                            nullptr, nullptr, 0U);
}

WebrcDspHandle webrc_dsp_fx_create_v2(std::uint32_t ordinal, float sampleRate,
                                     std::uint32_t maxBlockFrames, std::uint32_t channels,
                                     const std::uint32_t* parameterIds,
                                     const float* parameterValues,
                                     std::uint32_t parameterCount) {
    return createFxHandleV2(ordinal, ProcessSpec{sampleRate, maxBlockFrames, channels},
                            parameterIds, parameterValues, parameterCount);
}

std::int32_t webrc_dsp_fx_last_create_status(void) { return gLastCreateStatus; }

std::int32_t webrc_dsp_fx_destroy(WebrcDspHandle handle) {
    return registry().destroy(handle, HandleDomain::Fx);
}

std::int32_t webrc_dsp_fx_reset(WebrcDspHandle handle) {
    FxState* state = nullptr;
    const auto status = fxStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    state->processor->reset();
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_fx_set_parameter(WebrcDspHandle handle,
                                        std::uint32_t parameterId, float value) {
    FxState* state = nullptr;
    const auto status = fxStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (parameterId > std::numeric_limits<std::uint16_t>::max()) return WEBRC_DSP_BAD_ARGUMENT;
    const auto parameter = static_cast<FxParameterId>(parameterId);
    return state->processor->setParameter(parameter, value) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_fx_process_stereo(WebrcDspHandle handle,
                                        const float* inputLeft, const float* inputRight,
                                        float* outputLeft, float* outputRight,
                                        std::uint32_t frames) {
    FxState* state = nullptr;
    HandleView view{};
    const auto status = fxStateFor(handle, state, &view);
    if (status != WEBRC_DSP_OK) return status;
    if (frames > view.spec.maxBlockFrames) return WEBRC_DSP_BLOCK_TOO_LARGE;
    if (frames > 0U && (!validLinearMemorySpan(inputLeft, frames) ||
        !validLinearMemorySpan(outputLeft, frames) ||
        (view.spec.channels == 2U && (!validLinearMemorySpan(inputRight, frames) ||
                                      !validLinearMemorySpan(outputRight, frames))))) return WEBRC_DSP_BAD_ARGUMENT;
    const float* input[2]{inputLeft, inputRight};
    float* output[2]{outputLeft, outputRight};
    return state->processor->processBlock(input, output, view.spec.channels, frames)
        ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_fx_process_stereo_events(WebrcDspHandle handle,
                                                const float* inputLeft, const float* inputRight,
                                                float* outputLeft, float* outputRight,
                                                std::uint32_t frames,
                                                const std::uint32_t* eventOffsets,
                                                const std::uint32_t* parameterIds,
                                                const float* eventValues,
                                                std::uint32_t eventCount) {
    FxState* state = nullptr;
    HandleView view{};
    const auto status = fxStateFor(handle, state, &view);
    if (status != WEBRC_DSP_OK) return status;
    if (frames > view.spec.maxBlockFrames) return WEBRC_DSP_BLOCK_TOO_LARGE;
    if (eventCount > kFxEventCapacity ||
        (eventCount > 0U && (!validLinearMemorySpan(eventOffsets, eventCount) ||
                             !validLinearMemorySpan(parameterIds, eventCount) ||
                             !validLinearMemorySpan(eventValues, eventCount)))) return WEBRC_DSP_BAD_ARGUMENT;
    if (frames > 0U && (!validLinearMemorySpan(inputLeft, frames) ||
        !validLinearMemorySpan(outputLeft, frames) ||
        (view.spec.channels == 2U && (!validLinearMemorySpan(inputRight, frames) ||
                                      !validLinearMemorySpan(outputRight, frames))))) return WEBRC_DSP_BAD_ARGUMENT;
    std::array<FxParameterEvent, kFxEventCapacity> events{};
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        if (parameterIds[i] > std::numeric_limits<std::uint16_t>::max()) return WEBRC_DSP_BAD_ARGUMENT;
        events[i].frameOffset = eventOffsets[i];
        events[i].parameter = static_cast<FxParameterId>(parameterIds[i]);
        events[i].value = eventValues[i];
    }
    const float* input[2]{inputLeft, inputRight};
    float* output[2]{outputLeft, outputRight};
    return state->processor->processBlockWithEvents(input, output, view.spec.channels,
        frames, eventCount ? events.data() : nullptr, eventCount)
        ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_fx_process_stereo_context_v1(
    WebrcDspHandle handle,
    const float* inputLeft, const float* inputRight,
    float* outputLeft, float* outputRight, std::uint32_t frames,
    const std::uint32_t* parameterEventOffsets,
    const std::uint32_t* parameterIds,
    const float* parameterValues, std::uint32_t parameterEventCount,
    const float* carrierLeft, const float* carrierRight,
    std::uint32_t carrierFrames, std::uint32_t carrierChannels,
    const WebrcDspFxMidiEventV1* midiEvents, std::uint32_t midiEventCount) {
    FxState* state = nullptr;
    HandleView view{};
    const auto status = fxStateFor(handle, state, &view);
    if (status != WEBRC_DSP_OK) return status;
    if (frames > view.spec.maxBlockFrames) return WEBRC_DSP_BLOCK_TOO_LARGE;
    if (frames == 0U || !validLinearMemorySpan(inputLeft, frames) ||
        !validLinearMemorySpan(outputLeft, frames) ||
        (view.spec.channels == 2U &&
         (!validLinearMemorySpan(inputRight, frames) ||
          !validLinearMemorySpan(outputRight, frames)))) return WEBRC_DSP_BAD_ARGUMENT;
    if (parameterEventCount > kFxEventCapacity || midiEventCount > kFxMidiContextEventCapacity ||
        (parameterEventCount != 0U &&
         (!validLinearMemorySpan(parameterEventOffsets, parameterEventCount) ||
          !validLinearMemorySpan(parameterIds, parameterEventCount) ||
          !validLinearMemorySpan(parameterValues, parameterEventCount))) ||
        !validLinearMemorySpan(midiEvents, midiEventCount)) return WEBRC_DSP_BAD_ARGUMENT;

    const bool carrierSupplied = carrierLeft != nullptr || carrierRight != nullptr ||
                                 carrierFrames != 0U || carrierChannels != 0U;
    if (carrierSupplied) {
        if (!carrierLeft || !carrierRight || carrierChannels != 2U ||
            carrierFrames != frames ||
            !validLinearMemorySpan(carrierLeft, carrierFrames) ||
            !validLinearMemorySpan(carrierRight, carrierFrames)) return WEBRC_DSP_BAD_ARGUMENT;
    }

    std::array<FxParameterEvent, kFxEventCapacity> nativeParameters{};
    std::uint32_t previousParameterOffset = 0U;
    for (std::uint32_t index = 0U; index < parameterEventCount; ++index) {
        if (parameterIds[index] > std::numeric_limits<std::uint16_t>::max() ||
            parameterEventOffsets[index] >= frames ||
            (index != 0U && parameterEventOffsets[index] < previousParameterOffset) ||
            !std::isfinite(parameterValues[index])) return WEBRC_DSP_BAD_ARGUMENT;
        previousParameterOffset = parameterEventOffsets[index];
        nativeParameters[index] = {parameterEventOffsets[index],
            static_cast<FxParameterId>(parameterIds[index]), parameterValues[index]};
    }

    std::array<FxMidiEvent, kFxMidiContextEventCapacity> nativeMidi{};
    std::uint32_t previousMidiOffset = 0U;
    for (std::uint32_t index = 0U; index < midiEventCount; ++index) {
        const auto& source = midiEvents[index];
        if (source.type > 2U || source.frameOffset >= frames ||
            (index != 0U && source.frameOffset < previousMidiOffset)) return WEBRC_DSP_BAD_ARGUMENT;
        previousMidiOffset = source.frameOffset;
        FxMidiEventType type{};
        switch (source.type) {
        case 0U: type = FxMidiEventType::NoteOn; break;
        case 1U: type = FxMidiEventType::NoteOff; break;
        case 2U: type = FxMidiEventType::AllNotesOff; break;
        default: return WEBRC_DSP_BAD_ARGUMENT;
        }
        nativeMidi[index] = {source.frameOffset, type, source.channel, source.note, source.velocity};
    }

    const float* inputPlanar[2]{inputLeft, inputRight};
    float* outputPlanar[2]{outputLeft, outputRight};
    FxProcessContext context{};
    context.carrierLeft = carrierLeft;
    context.carrierRight = carrierRight;
    context.carrierFrames = carrierFrames;
    context.carrierChannels = carrierChannels;
    context.midiEvents = midiEventCount == 0U ? nullptr : nativeMidi.data();
    context.midiEventCount = midiEventCount;
    return state->processor->processBlockWithContext(
        inputPlanar, outputPlanar, view.spec.channels, frames,
        parameterEventCount == 0U ? nullptr : nativeParameters.data(),
        parameterEventCount, context) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_fx_fixed_latency_samples(WebrcDspHandle handle) {
    FxState* state = nullptr;
    return fxStateFor(handle, state) == WEBRC_DSP_OK
        ? state->processor->fixedLatencySamples() : WEBRC_DSP_BAD_HANDLE;
}

std::uint32_t webrc_dsp_fx_latency_model(WebrcDspHandle handle) {
    FxState* state = nullptr;
    if (fxStateFor(handle, state) != WEBRC_DSP_OK) return UINT32_MAX;
    return static_cast<std::uint32_t>(state->processor->latencyModel());
}

std::uint32_t webrc_dsp_fx_startup_warmup_frames(WebrcDspHandle handle) {
    FxState* state = nullptr;
    if (fxStateFor(handle, state) != WEBRC_DSP_OK) return UINT32_MAX;
    return state->processor->startupWarmupFrames();
}

std::int32_t webrc_dsp_fx_startup_warmup_upper_bound_samples(
    std::uint32_t ordinal, float sampleRate, std::uint32_t maxBlockFrames,
    std::uint32_t channels, std::uint32_t* outputFrames) {
    if (!outputFrames || !validLinearMemorySpan(outputFrames, 1U) ||
        ordinal > std::numeric_limits<std::uint16_t>::max()) return WEBRC_DSP_BAD_ARGUMENT;
    const auto requirement = fxStartupWarmupUpperBoundSamples(
        static_cast<std::uint16_t>(ordinal), ProcessSpec{sampleRate, maxBlockFrames, channels});
    if (!requirement.supported) return WEBRC_DSP_BAD_KIND;
    *outputFrames = requirement.frames;
    return WEBRC_DSP_OK;
}

} // extern "C"
