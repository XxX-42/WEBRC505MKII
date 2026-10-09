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
// Versioned configured-create/startup metadata extension. The v1 catalog and
// legacy create symbols remain available for existing clients.
uint32_t webrc_dsp_fx_create_v2_api_version(void);
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
// PREAMP ordinal 23 is rejected here because this v1 call cannot supply its
// required prepare-time model selectors.
WebrcDspHandle webrc_dsp_fx_create(uint32_t ordinal, float sampleRate,
                                  uint32_t maxBlockFrames, uint32_t channels);
// SETUP ONLY. Applies prepare-time selector IDs to a fresh, unpublished
// candidate before prepare(), then applies regular initial values, validates
// the prepared startup bound, and publishes only after the full batch succeeds.
// The two value arrays must be aligned spans inside this module's linear memory.
// Ordinal 23 must provide exactly one finite, in-range value for every
// prepare-time selector: AmpModel (82), SpeakerModel (83), MicModel (84),
// MicDistance (85), and MicPositionCm (86). Missing or duplicate selectors
// are rejected before reserving memory. Browser callers fill omitted saved
// values from the loaded catalog's descriptor defaults, then send all five.
WebrcDspHandle webrc_dsp_fx_create_v2(uint32_t ordinal, float sampleRate,
                                    uint32_t maxBlockFrames, uint32_t channels,
                                    const uint32_t* parameterIds,
                                    const float* parameterValues,
                                    uint32_t parameterCount);
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
// Startup warmup is an input-history bound, distinct from fixed latency.
// Returns UINT32_MAX for an invalid/unprepared handle.
uint32_t webrc_dsp_fx_startup_warmup_frames(WebrcDspHandle handle);
// Returns WEBRC_DSP_OK and writes the supported ordinal/spec upper bound, or
// a nonzero status without publishing a fabricated zero bound.
int32_t webrc_dsp_fx_startup_warmup_upper_bound_samples(
    uint32_t ordinal, float sampleRate, uint32_t maxBlockFrames,
    uint32_t channels, uint32_t* outputFrames);

#if defined(__cplusplus)
}
#endif
