#include "webrc_dsp_fx.h"

#include "handle_registry.hpp"
#include "webrc/dsp/fx_registry.hpp"

#include <array>
#include <limits>
#include <memory>
#include <new>

namespace {

using namespace webrc::dsp;
using webrc::dsp::wasm::HandleDomain;
using webrc::dsp::wasm::HandleRegistry;
using webrc::dsp::wasm::HandleStatus;
using webrc::dsp::wasm::HandleView;

constexpr std::uint32_t kFxAllocatorAllowance = 2048U;

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

} // namespace

extern "C" {

std::uint32_t webrc_dsp_fx_api_version(void) { return 1U; }

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
    if (!output || ordinal > std::numeric_limits<std::uint16_t>::max()) return WEBRC_DSP_BAD_ARGUMENT;
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
    if (!output || ordinal > std::numeric_limits<std::uint16_t>::max()) return WEBRC_DSP_BAD_ARGUMENT;
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
    if (ordinal > std::numeric_limits<std::uint16_t>::max()) {
        gLastCreateStatus = WEBRC_DSP_BAD_KIND;
        return 0U;
    }
    const ProcessSpec spec{sampleRate, maxBlockFrames, channels};
    const auto requirement = fxMemoryRequirement(static_cast<std::uint16_t>(ordinal), spec);
    if (!requirement.supported) {
        gLastCreateStatus = WEBRC_DSP_BAD_KIND;
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
    state->processor = createFxProcessor(static_cast<std::uint16_t>(ordinal));
    if (!state->processor) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_ALLOCATION_FAILED;
        return 0U;
    }
    if (!state->processor->prepare(spec)) {
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
    if (frames > 0U && (!inputLeft || !outputLeft ||
        (view.spec.channels == 2U && (!inputRight || !outputRight)))) return WEBRC_DSP_BAD_ARGUMENT;
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
        (eventCount > 0U && (!eventOffsets || !parameterIds || !eventValues))) return WEBRC_DSP_BAD_ARGUMENT;
    if (frames > 0U && (!inputLeft || !outputLeft ||
        (view.spec.channels == 2U && (!inputRight || !outputRight)))) return WEBRC_DSP_BAD_ARGUMENT;
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

} // extern "C"
