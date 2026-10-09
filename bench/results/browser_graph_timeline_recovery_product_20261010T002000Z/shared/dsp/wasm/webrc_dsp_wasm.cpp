#include "webrc_dsp_wasm.h"

#include "handle_registry.hpp"
#include "webrc/dsp/primitives.hpp"

#include <cmath>
#include <new>
#include <variant>

namespace {

using webrc::dsp::AdaaCubicShaper;
using webrc::dsp::AllPass1;
using webrc::dsp::BiquadDf2T;
using webrc::dsp::BoundaryMode;
using webrc::dsp::DelayMatrix2;
using webrc::dsp::DualDetectorCompressor;
using webrc::dsp::LagrangeDelay;
using webrc::dsp::Lfo;
using webrc::dsp::OscillatorWaveform;
using webrc::dsp::ParameterSmoother;
using webrc::dsp::Pcg32;
using webrc::dsp::PolyBlepOscillator;
using webrc::dsp::ProcessSpec;
using webrc::dsp::TptStateVariableFilter;
using webrc::dsp::wasm::HandleDomain;
using webrc::dsp::wasm::HandleRegistry;
using webrc::dsp::wasm::HandleStatus;
using webrc::dsp::wasm::HandleView;

constexpr uint32_t kAllocatorHeadroomBytes = 1024U;

struct State {
    uint32_t kind = 0;
    ProcessSpec spec{};
    using Payload = std::variant<ParameterSmoother, BiquadDf2T, TptStateVariableFilter,
                                AllPass1, LagrangeDelay, Lfo, PolyBlepOscillator,
                                AdaaCubicShaper, DualDetectorCompressor, DelayMatrix2, Pcg32>;
    Payload payload{};

    bool prepare(uint32_t requestedKind, const ProcessSpec& requestedSpec,
                 uint32_t maxDelaySamples) noexcept {
        kind = requestedKind;
        spec = requestedSpec;
        switch (kind) {
        case WEBRC_DSP_PARAMETER_SMOOTHER: payload.emplace<ParameterSmoother>(); return std::get<ParameterSmoother>(payload).prepare(spec);
        case WEBRC_DSP_BIQUAD_DF2T: payload.emplace<BiquadDf2T>(); return std::get<BiquadDf2T>(payload).prepare(spec);
        case WEBRC_DSP_TPT_SVF: payload.emplace<TptStateVariableFilter>(); return std::get<TptStateVariableFilter>(payload).prepare(spec);
        case WEBRC_DSP_ALLPASS1: payload.emplace<AllPass1>(); return std::get<AllPass1>(payload).prepare(spec);
        case WEBRC_DSP_LAGRANGE_DELAY: payload.emplace<LagrangeDelay>(); return maxDelaySamples > 0 && std::get<LagrangeDelay>(payload).prepare(spec, maxDelaySamples);
        case WEBRC_DSP_LFO: payload.emplace<Lfo>(); return std::get<Lfo>(payload).prepare(spec);
        case WEBRC_DSP_POLYBLEP_OSCILLATOR: payload.emplace<PolyBlepOscillator>(); return std::get<PolyBlepOscillator>(payload).prepare(spec);
        case WEBRC_DSP_ADAA_CUBIC_SHAPER: payload.emplace<AdaaCubicShaper>(); return std::get<AdaaCubicShaper>(payload).prepare(spec);
        case WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR: payload.emplace<DualDetectorCompressor>(); return std::get<DualDetectorCompressor>(payload).prepare(spec);
        case WEBRC_DSP_DELAY_MATRIX2:
            payload.emplace<DelayMatrix2>();
            return webrc::dsp::validProcessSpec(spec);
        case WEBRC_DSP_PCG32: payload.emplace<Pcg32>(); return true;
        default:
            return false;
        }
    }

    void reset() noexcept {
        switch (kind) {
        case WEBRC_DSP_PARAMETER_SMOOTHER: std::get<ParameterSmoother>(payload).reset(); break;
        case WEBRC_DSP_BIQUAD_DF2T: std::get<BiquadDf2T>(payload).reset(); break;
        case WEBRC_DSP_TPT_SVF: std::get<TptStateVariableFilter>(payload).reset(); break;
        case WEBRC_DSP_ALLPASS1: std::get<AllPass1>(payload).reset(); break;
        case WEBRC_DSP_LAGRANGE_DELAY: std::get<LagrangeDelay>(payload).reset(); break;
        case WEBRC_DSP_LFO: std::get<Lfo>(payload).reset(); break;
        case WEBRC_DSP_POLYBLEP_OSCILLATOR: std::get<PolyBlepOscillator>(payload).reset(); break;
        case WEBRC_DSP_ADAA_CUBIC_SHAPER: std::get<AdaaCubicShaper>(payload).reset(); break;
        case WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR: std::get<DualDetectorCompressor>(payload).reset(); break;
        case WEBRC_DSP_DELAY_MATRIX2: std::get<DelayMatrix2>(payload).reset(); break;
        case WEBRC_DSP_PCG32: std::get<Pcg32>(payload).seed(0U); break;
        default: break;
        }
    }
};

int32_t gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;

void destroyState(void* payload) noexcept {
    delete static_cast<State*>(payload);
}

uint32_t estimateStateBytes(uint32_t kind, uint32_t maxDelaySamples) noexcept {
    uint64_t bytes = sizeof(State) + kAllocatorHeadroomBytes;
    if (kind == WEBRC_DSP_LAGRANGE_DELAY) {
        bytes += (static_cast<uint64_t>(maxDelaySamples) + 4U) * sizeof(float) +
                 kAllocatorHeadroomBytes;
    }
    return bytes > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(bytes);
}

int32_t stateFor(WebrcDspHandle handle, State*& output) noexcept {
    HandleView view{};
    const auto status = webrc::dsp::wasm::registry().lookup(handle, view);
    if (status != HandleStatus::HandleOk) return status;
    if (view.domain != HandleDomain::Base) return WEBRC_DSP_BAD_KIND;
    output = static_cast<State*>(view.payload);
    return WEBRC_DSP_OK;
}

int32_t configure(State& state, uint32_t control, const float* values,
                  uint32_t valueCount) noexcept {
    if (!values) {
        return WEBRC_DSP_BAD_ARGUMENT;
    }
    switch (control) {
    case WEBRC_DSP_CONTROL_SMOOTHER_TARGET:
        if (state.kind != WEBRC_DSP_PARAMETER_SMOOTHER || valueCount != 2U) break;
        return std::get<ParameterSmoother>(state.payload).setTarget(values[0], values[1]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_LOWPASS:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 2U && valueCount != 3U)) break;
        return std::get<BiquadDf2T>(state.payload).setLowpass(values[0], values[1], valueCount == 3U ? values[2] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_HIGHPASS:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 2U && valueCount != 3U)) break;
        return std::get<BiquadDf2T>(state.payload).setHighpass(values[0], values[1], valueCount == 3U ? values[2] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_BANDPASS:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 2U && valueCount != 3U)) break;
        return std::get<BiquadDf2T>(state.payload).setBandpass(values[0], values[1], valueCount == 3U ? values[2] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_PEAKING:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 3U && valueCount != 4U)) break;
        return std::get<BiquadDf2T>(state.payload).setPeaking(values[0], values[1], values[2], valueCount == 4U ? values[3] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_LOW_SHELF:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 3U && valueCount != 4U)) break;
        return std::get<BiquadDf2T>(state.payload).setLowShelf(values[0], values[1], values[2],
                                                               valueCount == 4U ? values[3] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_HIGH_SHELF:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 3U && valueCount != 4U)) break;
        return std::get<BiquadDf2T>(state.payload).setHighShelf(values[0], values[1], values[2],
                                                                valueCount == 4U ? values[3] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_SMOOTHER_RESET_VALUE:
        if (state.kind != WEBRC_DSP_PARAMETER_SMOOTHER || valueCount != 1U ||
            !std::isfinite(values[0])) break;
        std::get<ParameterSmoother>(state.payload).reset(values[0]);
        return WEBRC_DSP_OK;
    case WEBRC_DSP_CONTROL_LFO_RESET_PHASE:
        if (state.kind != WEBRC_DSP_LFO || valueCount != 1U ||
            !std::isfinite(values[0])) break;
        std::get<Lfo>(state.payload).reset(values[0]);
        return WEBRC_DSP_OK;
    case WEBRC_DSP_CONTROL_OSCILLATOR_RESET_PHASE:
        if (state.kind != WEBRC_DSP_POLYBLEP_OSCILLATOR || valueCount != 1U ||
            !std::isfinite(values[0])) break;
        std::get<PolyBlepOscillator>(state.payload).reset(values[0]);
        return WEBRC_DSP_OK;
    case WEBRC_DSP_CONTROL_SVF_FREQUENCY_Q:
        if (state.kind != WEBRC_DSP_TPT_SVF || (valueCount != 2U && valueCount != 3U)) break;
        return std::get<TptStateVariableFilter>(state.payload).setFrequencyQ(values[0], values[1], valueCount == 3U ? values[2] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_ALLPASS_FREQUENCY:
        if (state.kind != WEBRC_DSP_ALLPASS1 || (valueCount != 1U && valueCount != 2U)) break;
        return std::get<AllPass1>(state.payload).setFrequency(values[0], valueCount == 2U ? values[1] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_LFO_FREQUENCY:
        if (state.kind != WEBRC_DSP_LFO || valueCount != 1U) break;
        return std::get<Lfo>(state.payload).setFrequency(values[0]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_OSCILLATOR_FREQUENCY:
        if (state.kind != WEBRC_DSP_POLYBLEP_OSCILLATOR || valueCount != 1U) break;
        return std::get<PolyBlepOscillator>(state.payload).setFrequency(values[0]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_OSCILLATOR_WAVEFORM:
        if (state.kind != WEBRC_DSP_POLYBLEP_OSCILLATOR || valueCount != 1U ||
            !std::isfinite(values[0]) || values[0] < 0.0f || values[0] > 3.0f ||
            std::floor(values[0]) != values[0]) break;
        std::get<PolyBlepOscillator>(state.payload).setWaveform(static_cast<OscillatorWaveform>(static_cast<uint8_t>(values[0])));
        return WEBRC_DSP_OK;
    case WEBRC_DSP_CONTROL_ADAA_DRIVE:
        if (state.kind != WEBRC_DSP_ADAA_CUBIC_SHAPER || valueCount != 1U) break;
        return std::get<AdaaCubicShaper>(state.payload).setDrive(values[0]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_COMPRESSOR_PARAMETERS:
        if (state.kind != WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR || valueCount != 7U) break;
        return std::get<DualDetectorCompressor>(state.payload).setParameters(values[0], values[1], values[2], values[3],
                                              values[4], values[5], values[6])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_DELAY_MATRIX_FEEDBACK:
        if (state.kind != WEBRC_DSP_DELAY_MATRIX2 || valueCount != 2U) break;
        return std::get<DelayMatrix2>(state.payload).setFeedback(values[0], values[1]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    default:
        return WEBRC_DSP_BAD_ARGUMENT;
    }
    return WEBRC_DSP_BAD_KIND;
}

} // namespace

extern "C" {

uint32_t webrc_dsp_api_version(void) {
    return webrc::dsp::kApiVersion;
}

uint32_t webrc_dsp_abi_version(void) {
    return 2U;
}

uint32_t webrc_dsp_capabilities(void) {
    return 0x00000007U; // base primitives, extended kinds, and the shared FX registry
}

uint32_t webrc_dsp_extended_api_version(void) {
    return 1U;
}

uint32_t webrc_dsp_max_block_frames(WebrcDspHandle handle) {
    HandleView view{};
    return webrc::dsp::wasm::registry().lookup(handle, view) == WEBRC_DSP_OK
               ? view.spec.maxBlockFrames : 0U;
}

int32_t webrc_dsp_last_create_status(void) {
    return gLastCreateStatus;
}

uint32_t webrc_dsp_managed_memory_bytes(void) {
    return webrc::dsp::wasm::registry().managedBytes();
}

uint32_t webrc_dsp_managed_memory_capacity_bytes(void) {
    return HandleRegistry::capacityBytes();
}

WebrcDspHandle webrc_dsp_create(uint32_t kind, float sampleRate,
                                uint32_t maxBlockFrames, uint32_t channels,
                                uint32_t maxDelaySamples) {
    const ProcessSpec spec{sampleRate, maxBlockFrames, channels};
    if (!webrc::dsp::validProcessSpec(spec)) {
        gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }
    if (kind < WEBRC_DSP_PARAMETER_SMOOTHER || kind > WEBRC_DSP_PCG32) {
        gLastCreateStatus = WEBRC_DSP_BAD_KIND;
        return 0U;
    }
    if (kind == WEBRC_DSP_LAGRANGE_DELAY &&
        (maxDelaySamples < 3U || maxDelaySamples > static_cast<uint32_t>(sampleRate * 10.0f))) {
        gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }
    const auto allocationBytes = estimateStateBytes(kind, maxDelaySamples);
    if (allocationBytes == UINT32_MAX) {
        gLastCreateStatus = WEBRC_DSP_MEMORY_BUDGET;
        return 0U;
    }
    HandleRegistry::Reservation reservation{};
    const auto reserveStatus = webrc::dsp::wasm::registry().reserve(allocationBytes, reservation);
    if (reserveStatus != WEBRC_DSP_OK) {
        gLastCreateStatus = reserveStatus;
        return 0U;
    }
    auto* state = new (std::nothrow) State{};
    if (!state) {
        gLastCreateStatus = WEBRC_DSP_ALLOCATION_FAILED;
        return 0U;
    }
    if (!state->prepare(kind, spec, maxDelaySamples)) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    const auto handle = webrc::dsp::wasm::registry().publish(
        reservation, HandleDomain::Base, kind, spec, state, destroyState);
    if (handle == 0U) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    gLastCreateStatus = WEBRC_DSP_OK;
    return handle;
}

int32_t webrc_dsp_destroy(WebrcDspHandle handle) {
    return webrc::dsp::wasm::registry().destroy(handle, HandleDomain::Base);
}

int32_t webrc_dsp_reset(WebrcDspHandle handle) {
    State* state = nullptr;
    const auto status = stateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    state->reset();
    return WEBRC_DSP_OK;
}

int32_t webrc_dsp_configure(WebrcDspHandle handle, uint32_t control,
                            const float* values, uint32_t valueCount) {
    State* state = nullptr;
    const auto status = stateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    return configure(*state, control, values, valueCount);
}

int32_t webrc_dsp_seed(WebrcDspHandle handle, uint64_t initialState, uint64_t sequence) {
    State* state = nullptr;
    const auto status = stateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_PCG32) {
        return WEBRC_DSP_BAD_KIND;
    }
    std::get<Pcg32>(state->payload).seed(initialState, sequence);
    return WEBRC_DSP_OK;
}

int32_t webrc_dsp_process(WebrcDspHandle handle,
                          const float* input0, const float* input1,
                          float* output0, float* output1, float* output2,
                          const float* parameters, uint32_t frames) {
    State* state = nullptr;
    const auto status = stateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (frames > state->spec.maxBlockFrames) {
        return WEBRC_DSP_BLOCK_TOO_LARGE;
    }
    switch (state->kind) {
    case WEBRC_DSP_PARAMETER_SMOOTHER:
        return std::get<ParameterSmoother>(state->payload).processBlock(output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_BIQUAD_DF2T:
        return std::get<BiquadDf2T>(state->payload).processBlock(input0, output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_TPT_SVF:
        return std::get<TptStateVariableFilter>(state->payload).processBlock(input0, output0, output1, output2, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_ALLPASS1:
        return std::get<AllPass1>(state->payload).processBlock(input0, output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_LAGRANGE_DELAY:
        return std::get<LagrangeDelay>(state->payload).processBlock(input0, output0, parameters, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_LFO:
        return std::get<Lfo>(state->payload).processBlock(output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_POLYBLEP_OSCILLATOR:
        return std::get<PolyBlepOscillator>(state->payload).processBlock(output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_ADAA_CUBIC_SHAPER:
        return std::get<AdaaCubicShaper>(state->payload).processBlock(input0, output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR:
        return std::get<DualDetectorCompressor>(state->payload).processBlock(input0, input1, output0, output1, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_DELAY_MATRIX2:
        if (!input0 || !input1 || !output0 || !output1 || !parameters) return WEBRC_DSP_BAD_ARGUMENT;
        for (uint32_t frame = 0; frame < frames; ++frame) {
            const auto out = std::get<DelayMatrix2>(state->payload).process(
                {input0[frame], input1[frame]}, {parameters[frame], parameters[frames + frame]});
            output0[frame] = out.left;
            output1[frame] = out.right;
        }
        return WEBRC_DSP_OK;
    case WEBRC_DSP_PCG32:
        if (!output0) return WEBRC_DSP_BAD_ARGUMENT;
        for (uint32_t frame = 0; frame < frames; ++frame) {
            output0[frame] = std::get<Pcg32>(state->payload).nextBipolar();
        }
        return WEBRC_DSP_OK;
    default:
        return WEBRC_DSP_BAD_KIND;
    }
}

int32_t webrc_dsp_equal_power_crossfade(float a, float b, float phase, float* output) {
    if (!output) return WEBRC_DSP_BAD_ARGUMENT;
    *output = webrc::dsp::equalPowerCrossfade(a, b, phase);
    return WEBRC_DSP_OK;
}

int32_t webrc_dsp_equal_power_pan(float pan, float* leftGain, float* rightGain) {
    if (!leftGain || !rightGain) return WEBRC_DSP_BAD_ARGUMENT;
    const auto gains = webrc::dsp::equalPowerPan(pan);
    *leftGain = gains.left;
    *rightGain = gains.right;
    return WEBRC_DSP_OK;
}

float webrc_dsp_sinc8_read(const float* input, uint32_t frames, double position,
                           uint32_t boundaryMode) {
    if (boundaryMode > static_cast<uint32_t>(BoundaryMode::Wrap)) return 0.0f;
    return webrc::dsp::sinc8Read(input, frames, position, static_cast<BoundaryMode>(boundaryMode));
}

uint32_t webrc_dsp_sinc8_lookahead_samples(void) {
    return webrc::dsp::sinc8LookaheadSamples();
}

uint32_t webrc_dsp_alloc_f32(uint32_t frames) {
    return webrc::dsp::wasm::registry().allocateTransferF32(frames);
}

void webrc_dsp_free(uint32_t address) {
    webrc::dsp::wasm::registry().freeTransfer(address);
}

uint32_t webrc_dsp_alloc_f32_token(uint32_t frames) {
    uint32_t address = 0U;
    return webrc::dsp::wasm::registry().allocateTransferF32Token(frames, address);
}

uint32_t webrc_dsp_transfer_address(uint32_t token) {
    return webrc::dsp::wasm::registry().transferAddress(token);
}

int32_t webrc_dsp_free_transfer_token(uint32_t token) {
    return webrc::dsp::wasm::registry().freeTransferToken(token);
}

} // extern "C"
