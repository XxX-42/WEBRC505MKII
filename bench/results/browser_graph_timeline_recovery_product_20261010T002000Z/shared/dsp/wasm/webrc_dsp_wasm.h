#pragma once

#include <stdint.h>

#if defined(__cplusplus)
extern "C" {
#endif

typedef uint32_t WebrcDspHandle;

enum WebrcDspKind {
    WEBRC_DSP_PARAMETER_SMOOTHER = 1,
    WEBRC_DSP_BIQUAD_DF2T = 2,
    WEBRC_DSP_TPT_SVF = 3,
    WEBRC_DSP_ALLPASS1 = 4,
    WEBRC_DSP_LAGRANGE_DELAY = 5,
    WEBRC_DSP_LFO = 6,
    WEBRC_DSP_POLYBLEP_OSCILLATOR = 7,
    WEBRC_DSP_ADAA_CUBIC_SHAPER = 8,
    WEBRC_DSP_DUAL_DETECTOR_COMPRESSOR = 9,
    WEBRC_DSP_DELAY_MATRIX2 = 10,
    WEBRC_DSP_PCG32 = 11,
};

enum WebrcDspControl {
    WEBRC_DSP_CONTROL_SMOOTHER_TARGET = 1,
    WEBRC_DSP_CONTROL_BIQUAD_LOWPASS = 2,
    WEBRC_DSP_CONTROL_BIQUAD_HIGHPASS = 3,
    WEBRC_DSP_CONTROL_BIQUAD_BANDPASS = 4,
    WEBRC_DSP_CONTROL_BIQUAD_PEAKING = 5,
    WEBRC_DSP_CONTROL_SVF_FREQUENCY_Q = 6,
    WEBRC_DSP_CONTROL_ALLPASS_FREQUENCY = 7,
    WEBRC_DSP_CONTROL_LFO_FREQUENCY = 8,
    WEBRC_DSP_CONTROL_OSCILLATOR_FREQUENCY = 9,
    WEBRC_DSP_CONTROL_OSCILLATOR_WAVEFORM = 10,
    WEBRC_DSP_CONTROL_ADAA_DRIVE = 11,
    WEBRC_DSP_CONTROL_COMPRESSOR_PARAMETERS = 12,
    WEBRC_DSP_CONTROL_DELAY_MATRIX_FEEDBACK = 13,
    // Added in ABI v2 as new control IDs; existing IDs retain their meaning.
    WEBRC_DSP_CONTROL_BIQUAD_LOW_SHELF = 14,
    WEBRC_DSP_CONTROL_BIQUAD_HIGH_SHELF = 15,
    WEBRC_DSP_CONTROL_SMOOTHER_RESET_VALUE = 16,
    WEBRC_DSP_CONTROL_LFO_RESET_PHASE = 17,
    WEBRC_DSP_CONTROL_OSCILLATOR_RESET_PHASE = 18,
};

enum WebrcDspStatus {
    WEBRC_DSP_OK = 0,
    WEBRC_DSP_BAD_HANDLE = -1,
    WEBRC_DSP_BAD_ARGUMENT = -2,
    WEBRC_DSP_BAD_KIND = -3,
    WEBRC_DSP_BLOCK_TOO_LARGE = -4,
    WEBRC_DSP_NO_SLOTS = -5,
    WEBRC_DSP_PREPARE_FAILED = -6,
    WEBRC_DSP_MEMORY_BUDGET = -7,
    WEBRC_DSP_ALLOCATION_FAILED = -8,
};

uint32_t webrc_dsp_api_version(void);
uint32_t webrc_dsp_abi_version(void);
uint32_t webrc_dsp_extended_api_version(void);
uint32_t webrc_dsp_capabilities(void);
uint32_t webrc_dsp_max_block_frames(WebrcDspHandle handle);
int32_t webrc_dsp_last_create_status(void);
uint32_t webrc_dsp_managed_memory_bytes(void);
uint32_t webrc_dsp_managed_memory_capacity_bytes(void);

// Create/destroy/configure are control-thread operations. create prepares the
// selected state object; process never allocates, locks, or grows WASM memory.
WebrcDspHandle webrc_dsp_create(uint32_t kind, float sample_rate,
                                uint32_t max_block_frames, uint32_t channels,
                                uint32_t max_delay_samples);
int32_t webrc_dsp_destroy(WebrcDspHandle handle);
int32_t webrc_dsp_reset(WebrcDspHandle handle);
int32_t webrc_dsp_configure(WebrcDspHandle handle, uint32_t control,
                            const float* values, uint32_t value_count);
int32_t webrc_dsp_seed(WebrcDspHandle handle, uint64_t state, uint64_t sequence);

// `input*`, `output*`, and `parameters` are linear-memory float pointers.
// Their interpretation depends on the kind. Lagrange delay uses parameters as
// per-sample delay time; SVF writes low/band/high to output0/1/2; delay-matrix
// uses input0/1 as dry input and parameters + parameters+frames as delayed L/R.
// The caller copies AudioWorklet arrays into preallocated WASM buffers and
// back; the frames argument is always the actual block length.
int32_t webrc_dsp_process(WebrcDspHandle handle,
                          const float* input0, const float* input1,
                          float* output0, float* output1, float* output2,
                          const float* parameters, uint32_t frames);

int32_t webrc_dsp_equal_power_crossfade(float a, float b, float phase,
                                        float* output);
int32_t webrc_dsp_equal_power_pan(float pan, float* left_gain, float* right_gain);
float webrc_dsp_sinc8_read(const float* input, uint32_t frames, double position,
                           uint32_t boundary_mode);
uint32_t webrc_dsp_sinc8_lookahead_samples(void);

// Legacy raw-address allocation/release for compatibility. Setup only; stale
// frees are not generation-protected if the allocator later reuses an address.
// New clients should use the token-aware allocation functions below.
uint32_t webrc_dsp_alloc_f32(uint32_t frames);
void webrc_dsp_free(uint32_t address);
// Preferred token-aware setup allocation API. A stale/double-freed generation
// token cannot release a later allocation even if the allocator reuses its address.
uint32_t webrc_dsp_alloc_f32_token(uint32_t frames);
uint32_t webrc_dsp_transfer_address(uint32_t token);
int32_t webrc_dsp_free_transfer_token(uint32_t token);

#if defined(__cplusplus)
}
#endif
