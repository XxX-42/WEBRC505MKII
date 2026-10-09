#include "webrc_dsp_wasm.h"

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cmath>
#include <cstdlib>
#include <new>

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

constexpr std::size_t kMaxHandles = 1024;
constexpr uint32_t kMaxTransferFrames = 1U << 20U;
constexpr uint32_t kHandleSlotBits = 10U;
constexpr uint32_t kHandleSlotMask = (1U << kHandleSlotBits) - 1U;
constexpr uint32_t kHandleGenerationMask = (1U << (32U - kHandleSlotBits)) - 1U;
constexpr uint32_t kManagedHeapBudgetBytes = 48U * 1024U * 1024U;
constexpr uint32_t kAllocatorHeadroomBytes = 1024U;
constexpr std::size_t kMaxTransferAllocations = 1024;

struct State {
    uint32_t kind = 0;
    ProcessSpec spec{};
    ParameterSmoother smoother{};
    BiquadDf2T biquad{};
    TptStateVariableFilter svf{};
    AllPass1 allPass{};
    LagrangeDelay lagrange{};
    Lfo lfo{};
    PolyBlepOscillator oscillator{};
    AdaaCubicShaper shaper{};
    DualDetectorCompressor compressor{};
    DelayMatrix2 delayMatrix{};
    Pcg32 random{};

    bool prepare(uint32_t requestedKind, const ProcessSpec& requestedSpec,
                 uint32_t maxDelaySamples) noexcept {
        kind = requestedKind;
        spec = requestedSpec;
        switch (kind) {
        case WEBRC_DSP_PARAMETER_SMOOTHER:
            return smoother.prepare(spec);
        case WEBRC_DSP_BIQUAD_DF2T:
            return biquad.prepare(spec);
        case WEBRC_DSP_TPT_SVF:
            return svf.prepare(spec);
        case WEBRC_DSP_ALLPASS1:
            return allPass.prepare(spec);
        case WEBRC_DSP_LAGRANGE_DELAY:
            return maxDelaySamples > 0 && lagrange.prepare(spec, maxDelaySamples);
        case WEBRC_DSP_LFO:
            return lfo.prepare(spec);
        case WEBRC_DSP_POLYBLEP_OSCILLATOR:
            return oscillator.prepare(spec);
        case WEBRC_DSP_ADAA_CUBIC_SHAPER:
            return shaper.prepare(spec);
        case WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR:
            return compressor.prepare(spec);
        case WEBRC_DSP_DELAY_MATRIX2:
            return webrc::dsp::validProcessSpec(spec);
        case WEBRC_DSP_PCG32:
            return true;
        default:
            return false;
        }
    }

    void reset() noexcept {
        switch (kind) {
        case WEBRC_DSP_PARAMETER_SMOOTHER: smoother.reset(); break;
        case WEBRC_DSP_BIQUAD_DF2T: biquad.reset(); break;
        case WEBRC_DSP_TPT_SVF: svf.reset(); break;
        case WEBRC_DSP_ALLPASS1: allPass.reset(); break;
        case WEBRC_DSP_LAGRANGE_DELAY: lagrange.reset(); break;
        case WEBRC_DSP_LFO: lfo.reset(); break;
        case WEBRC_DSP_POLYBLEP_OSCILLATOR: oscillator.reset(); break;
        case WEBRC_DSP_ADAA_CUBIC_SHAPER: shaper.reset(); break;
        case WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR: compressor.reset(); break;
        case WEBRC_DSP_DELAY_MATRIX2: delayMatrix.reset(); break;
        case WEBRC_DSP_PCG32: random.seed(0U); break;
        default: break;
        }
    }
};

std::array<State*, kMaxHandles> gStates{};
std::array<uint32_t, kMaxHandles> gGenerations = [] {
    std::array<uint32_t, kMaxHandles> generations{};
    generations.fill(1U);
    return generations;
}();
std::array<uint32_t, kMaxHandles> gStateBytes{};

struct TransferAllocation {
    void* address = nullptr;
    uint32_t bytes = 0;
};

std::array<TransferAllocation, kMaxTransferAllocations> gTransferAllocations{};
uint32_t gManagedBytes = 0;
int32_t gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;

WebrcDspHandle makeHandle(std::size_t slot) noexcept {
    return static_cast<WebrcDspHandle>((gGenerations[slot] << kHandleSlotBits) |
                                       static_cast<uint32_t>(slot));
}

uint32_t advanceGeneration(uint32_t generation) noexcept {
    generation = (generation + 1U) & kHandleGenerationMask;
    return generation == 0U ? 1U : generation;
}

uint32_t estimateStateBytes(uint32_t kind, uint32_t maxDelaySamples) noexcept {
    uint64_t bytes = sizeof(State) + kAllocatorHeadroomBytes;
    if (kind == WEBRC_DSP_LAGRANGE_DELAY) {
        bytes += (static_cast<uint64_t>(maxDelaySamples) + 4U) * sizeof(float) +
                 kAllocatorHeadroomBytes;
    }
    return bytes > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(bytes);
}

State* stateFor(WebrcDspHandle handle) noexcept {
    const auto generation = handle >> kHandleSlotBits;
    const auto slot = handle & kHandleSlotMask;
    if (handle == 0 || generation == 0U || slot >= gStates.size() ||
        gGenerations[slot] != generation) {
        return nullptr;
    }
    return gStates[slot];
}

int32_t configure(State& state, uint32_t control, const float* values,
                  uint32_t valueCount) noexcept {
    if (!values) {
        return WEBRC_DSP_BAD_ARGUMENT;
    }
    switch (control) {
    case WEBRC_DSP_CONTROL_SMOOTHER_TARGET:
        if (state.kind != WEBRC_DSP_PARAMETER_SMOOTHER || valueCount != 2U) break;
        return state.smoother.setTarget(values[0], values[1]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_LOWPASS:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 2U && valueCount != 3U)) break;
        return state.biquad.setLowpass(values[0], values[1], valueCount == 3U ? values[2] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_HIGHPASS:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 2U && valueCount != 3U)) break;
        return state.biquad.setHighpass(values[0], values[1], valueCount == 3U ? values[2] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_BANDPASS:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 2U && valueCount != 3U)) break;
        return state.biquad.setBandpass(values[0], values[1], valueCount == 3U ? values[2] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_BIQUAD_PEAKING:
        if (state.kind != WEBRC_DSP_BIQUAD_DF2T || (valueCount != 3U && valueCount != 4U)) break;
        return state.biquad.setPeaking(values[0], values[1], values[2], valueCount == 4U ? values[3] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_SVF_FREQUENCY_Q:
        if (state.kind != WEBRC_DSP_TPT_SVF || (valueCount != 2U && valueCount != 3U)) break;
        return state.svf.setFrequencyQ(values[0], values[1], valueCount == 3U ? values[2] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_ALLPASS_FREQUENCY:
        if (state.kind != WEBRC_DSP_ALLPASS1 || (valueCount != 1U && valueCount != 2U)) break;
        return state.allPass.setFrequency(values[0], valueCount == 2U ? values[1] : 5.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_LFO_FREQUENCY:
        if (state.kind != WEBRC_DSP_LFO || valueCount != 1U) break;
        return state.lfo.setFrequency(values[0]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_OSCILLATOR_FREQUENCY:
        if (state.kind != WEBRC_DSP_POLYBLEP_OSCILLATOR || valueCount != 1U) break;
        return state.oscillator.setFrequency(values[0]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_OSCILLATOR_WAVEFORM:
        if (state.kind != WEBRC_DSP_POLYBLEP_OSCILLATOR || valueCount != 1U ||
            !std::isfinite(values[0]) || values[0] < 0.0f || values[0] > 3.0f ||
            std::floor(values[0]) != values[0]) break;
        state.oscillator.setWaveform(static_cast<OscillatorWaveform>(static_cast<uint8_t>(values[0])));
        return WEBRC_DSP_OK;
    case WEBRC_DSP_CONTROL_ADAA_DRIVE:
        if (state.kind != WEBRC_DSP_ADAA_CUBIC_SHAPER || valueCount != 1U) break;
        return state.shaper.setDrive(values[0]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_COMPRESSOR_PARAMETERS:
        if (state.kind != WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR || valueCount != 7U) break;
        return state.compressor.setParameters(values[0], values[1], values[2], values[3],
                                              values[4], values[5], values[6])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_CONTROL_DELAY_MATRIX_FEEDBACK:
        if (state.kind != WEBRC_DSP_DELAY_MATRIX2 || valueCount != 2U) break;
        return state.delayMatrix.setFeedback(values[0], values[1]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
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

uint32_t webrc_dsp_max_block_frames(WebrcDspHandle handle) {
    const auto* state = stateFor(handle);
    return state ? state->spec.maxBlockFrames : 0U;
}

int32_t webrc_dsp_last_create_status(void) {
    return gLastCreateStatus;
}

uint32_t webrc_dsp_managed_memory_bytes(void) {
    return gManagedBytes;
}

uint32_t webrc_dsp_managed_memory_capacity_bytes(void) {
    return kManagedHeapBudgetBytes;
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
    std::size_t slot = 0;
    while (slot < gStates.size() && gStates[slot] != nullptr) {
        ++slot;
    }
    if (slot == gStates.size()) {
        gLastCreateStatus = WEBRC_DSP_NO_SLOTS;
        return 0U;
    }
    const auto allocationBytes = estimateStateBytes(kind, maxDelaySamples);
    if (allocationBytes == UINT32_MAX || allocationBytes > kManagedHeapBudgetBytes ||
        gManagedBytes > kManagedHeapBudgetBytes - allocationBytes) {
        gLastCreateStatus = WEBRC_DSP_MEMORY_BUDGET;
        return 0U;
    }
    gManagedBytes += allocationBytes;
    auto* state = new (std::nothrow) State{};
    if (!state) {
        gManagedBytes -= allocationBytes;
        gLastCreateStatus = WEBRC_DSP_ALLOCATION_FAILED;
        return 0U;
    }
    if (!state->prepare(kind, spec, maxDelaySamples)) {
        delete state;
        gManagedBytes -= allocationBytes;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    gStates[slot] = state;
    gStateBytes[slot] = allocationBytes;
    gLastCreateStatus = WEBRC_DSP_OK;
    return makeHandle(slot);
}

int32_t webrc_dsp_destroy(WebrcDspHandle handle) {
    auto* state = stateFor(handle);
    if (!state) {
        return WEBRC_DSP_BAD_HANDLE;
    }
    const auto slot = handle & kHandleSlotMask;
    delete state;
    gStates[slot] = nullptr;
    gManagedBytes -= gStateBytes[slot];
    gStateBytes[slot] = 0U;
    gGenerations[slot] = advanceGeneration(gGenerations[slot]);
    return WEBRC_DSP_OK;
}

int32_t webrc_dsp_reset(WebrcDspHandle handle) {
    auto* state = stateFor(handle);
    if (!state) {
        return WEBRC_DSP_BAD_HANDLE;
    }
    state->reset();
    return WEBRC_DSP_OK;
}

int32_t webrc_dsp_configure(WebrcDspHandle handle, uint32_t control,
                            const float* values, uint32_t valueCount) {
    auto* state = stateFor(handle);
    if (!state) {
        return WEBRC_DSP_BAD_HANDLE;
    }
    return configure(*state, control, values, valueCount);
}

int32_t webrc_dsp_seed(WebrcDspHandle handle, uint64_t initialState, uint64_t sequence) {
    auto* state = stateFor(handle);
    if (!state) {
        return WEBRC_DSP_BAD_HANDLE;
    }
    if (state->kind != WEBRC_DSP_PCG32) {
        return WEBRC_DSP_BAD_KIND;
    }
    state->random.seed(initialState, sequence);
    return WEBRC_DSP_OK;
}

int32_t webrc_dsp_process(WebrcDspHandle handle,
                          const float* input0, const float* input1,
                          float* output0, float* output1, float* output2,
                          const float* parameters, uint32_t frames) {
    auto* state = stateFor(handle);
    if (!state) {
        return WEBRC_DSP_BAD_HANDLE;
    }
    if (frames > state->spec.maxBlockFrames) {
        return WEBRC_DSP_BLOCK_TOO_LARGE;
    }
    switch (state->kind) {
    case WEBRC_DSP_PARAMETER_SMOOTHER:
        return state->smoother.processBlock(output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_BIQUAD_DF2T:
        return state->biquad.processBlock(input0, output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_TPT_SVF:
        return state->svf.processBlock(input0, output0, output1, output2, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_ALLPASS1:
        return state->allPass.processBlock(input0, output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_LAGRANGE_DELAY:
        return state->lagrange.processBlock(input0, output0, parameters, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_LFO:
        return state->lfo.processBlock(output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_POLYBLEP_OSCILLATOR:
        return state->oscillator.processBlock(output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_ADAA_CUBIC_SHAPER:
        return state->shaper.processBlock(input0, output0, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR:
        return state->compressor.processBlock(input0, input1, output0, output1, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_DELAY_MATRIX2:
        if (!input0 || !input1 || !output0 || !output1 || !parameters) return WEBRC_DSP_BAD_ARGUMENT;
        for (uint32_t frame = 0; frame < frames; ++frame) {
            const auto out = state->delayMatrix.process(
                {input0[frame], input1[frame]}, {parameters[frame], parameters[frames + frame]});
            output0[frame] = out.left;
            output1[frame] = out.right;
        }
        return WEBRC_DSP_OK;
    case WEBRC_DSP_PCG32:
        if (!output0) return WEBRC_DSP_BAD_ARGUMENT;
        for (uint32_t frame = 0; frame < frames; ++frame) {
            output0[frame] = state->random.nextBipolar();
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
    if (frames == 0U || frames > kMaxTransferFrames) return 0U;
    if (static_cast<uint64_t>(frames) * sizeof(float) > UINT32_MAX) return 0U;
    std::size_t slot = 0;
    while (slot < gTransferAllocations.size() && gTransferAllocations[slot].address != nullptr) {
        ++slot;
    }
    if (slot == gTransferAllocations.size()) return 0U;
    const auto bytes = frames * static_cast<uint32_t>(sizeof(float));
    const auto reservedBytes = bytes + kAllocatorHeadroomBytes;
    if (reservedBytes > kManagedHeapBudgetBytes ||
        gManagedBytes > kManagedHeapBudgetBytes - reservedBytes) return 0U;
    auto* address = std::malloc(bytes);
    if (!address) return 0U;
    gTransferAllocations[slot] = {address, reservedBytes};
    gManagedBytes += reservedBytes;
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(address));
}

void webrc_dsp_free(uint32_t address) {
    for (auto& allocation : gTransferAllocations) {
        if (allocation.address == reinterpret_cast<void*>(static_cast<uintptr_t>(address))) {
            std::free(allocation.address);
            gManagedBytes -= allocation.bytes;
            allocation = {};
            return;
        }
    }
}

} // extern "C"
