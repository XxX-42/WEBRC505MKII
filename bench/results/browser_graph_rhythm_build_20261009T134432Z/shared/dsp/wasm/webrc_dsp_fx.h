#pragma once

#include "webrc_dsp_wasm.h"

#if defined(__cplusplus)
extern "C" {
#endif

typedef struct WebrcDspFxMemoryInfo {
    uint64_t objectBytes;
    uint64_t persistentPreparedBytes;
    uint64_t prepareScratchBytes;
    uint64_t peakBytes;
    uint32_t supported;
} WebrcDspFxMemoryInfo;

typedef struct WebrcDspFxParameterInfo {
    uint32_t id;
    float minimum;
    float maximum;
    float defaultValue;
    uint32_t namePointer;
    uint32_t unitPointer;
    uint32_t origin;
} WebrcDspFxParameterInfo;

// Registry and parameter metadata are reconstruction-safe DSP metadata only.
// A false official-parameters flag means this does not encode Roland's UI contract.
uint32_t webrc_dsp_fx_api_version(void);
uint32_t webrc_dsp_fx_catalog_size(void);
uint32_t webrc_dsp_fx_id_pointer(uint32_t ordinal);
uint32_t webrc_dsp_fx_name_pointer(uint32_t ordinal);
uint32_t webrc_dsp_fx_family_pointer(uint32_t ordinal);
uint32_t webrc_dsp_fx_is_processor_available(uint32_t ordinal);
uint32_t webrc_dsp_fx_official_parameters_validated(uint32_t ordinal);
uint32_t webrc_dsp_fx_parameter_count(uint32_t ordinal);
int32_t webrc_dsp_fx_parameter_info(uint32_t ordinal, uint32_t parameterIndex,
                                    WebrcDspFxParameterInfo* output);
int32_t webrc_dsp_fx_memory_info(uint32_t ordinal, float sampleRate,
                                 uint32_t maxBlockFrames, uint32_t channels,
                                 WebrcDspFxMemoryInfo* output);

// SETUP ONLY. Preflights and reserves the shared 48 MiB ledger before creating
// or preparing the processor. Do this on an inactive candidate while rendering
// is suspended; an allocation trap cannot be recovered in the active graph.
WebrcDspHandle webrc_dsp_fx_create(uint32_t ordinal, float sampleRate,
                                  uint32_t maxBlockFrames, uint32_t channels);
int32_t webrc_dsp_fx_last_create_status(void);
// SETUP/GRAPH CONTROL ONLY. Destroy/reset are serialized with all processing.
int32_t webrc_dsp_fx_destroy(WebrcDspHandle handle);
int32_t webrc_dsp_fx_reset(WebrcDspHandle handle);
// Call only on the processor's audio owner. These setters do not lock.
int32_t webrc_dsp_fx_set_parameter(WebrcDspHandle handle, uint32_t parameterId,
                                   float value);
// Mono uses only left pointers; stereo requires all four pointers. Callbacks
// must pass the actual frame count and valid, aligned spans inside WASM memory.
int32_t webrc_dsp_fx_process_stereo(WebrcDspHandle handle,
                                   const float* inputLeft, const float* inputRight,
                                   float* outputLeft, float* outputRight,
                                   uint32_t frames);
// Bounded sample-offset events use separate arrays to avoid struct-layout ABI.
// Offsets must be sorted and <= frames; eventCount is capped at 256.
int32_t webrc_dsp_fx_process_stereo_events(WebrcDspHandle handle,
                                           const float* inputLeft, const float* inputRight,
                                           float* outputLeft, float* outputRight,
                                           uint32_t frames,
                                           const uint32_t* eventOffsets,
                                           const uint32_t* parameterIds,
                                           const float* eventValues,
                                           uint32_t eventCount);
int32_t webrc_dsp_fx_fixed_latency_samples(WebrcDspHandle handle);
uint32_t webrc_dsp_fx_latency_model(WebrcDspHandle handle);

#if defined(__cplusplus)
}
#endif
