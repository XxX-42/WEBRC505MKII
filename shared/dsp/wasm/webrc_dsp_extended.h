#pragma once

#include "webrc_dsp_wasm.h"

#if defined(__cplusplus)
extern "C" {
#endif

// Extended kinds use stable, versioned IDs independent of formula references.
enum WebrcDspExtendedKind {
    WEBRC_DSP_EXT_WDF_DIODE = 100,
    WEBRC_DSP_EXT_OVERSAMPLED_NONLINEAR = 101,
    WEBRC_DSP_EXT_PATTERN_SLICER = 102,
    WEBRC_DSP_EXT_SAMPLE_ACCURATE_SCHEDULER = 103,
    WEBRC_DSP_EXT_MID_SIDE_WIDTH = 104,
    WEBRC_DSP_EXT_ONSET_DETECTOR = 105,
    WEBRC_DSP_EXT_BIT_RATE_REDUCER = 106,
    WEBRC_DSP_EXT_RING_MODULATOR = 107,
    WEBRC_DSP_EXT_YIN_PITCH = 108,
    WEBRC_DSP_EXT_TD_PSOLA_BUFFER = 109,
    WEBRC_DSP_EXT_STREAMING_TD_PSOLA = 110,
    WEBRC_DSP_EXT_PHASE_VOCODER = 111,
    WEBRC_DSP_EXT_MULTIBAND_VOCODER = 112,
    WEBRC_DSP_EXT_SIGNALSMITH_STRETCH = 113,
    WEBRC_DSP_EXT_GRANULAR_TEXTURE = 114,
    WEBRC_DSP_EXT_FDN_REVERB = 115,
    WEBRC_DSP_EXT_PARTITIONED_CONVOLVER = 116,
    WEBRC_DSP_EXT_SPECTRAL_FREEZE = 117,
    WEBRC_DSP_EXT_REVERSE_SEGMENT = 118,
    WEBRC_DSP_EXT_PLATTER_INERTIA = 119,
    WEBRC_DSP_EXT_DRUM_VOICE_POOL = 120,
};

enum WebrcDspExtendedControl {
    WEBRC_DSP_EXT_CONTROL_WDF_DIODE_PARAMETERS = 1,
    WEBRC_DSP_EXT_CONTROL_NONLINEAR_DRIVE = 2,
    WEBRC_DSP_EXT_CONTROL_PATTERN_GAINS = 3,
    WEBRC_DSP_EXT_CONTROL_SCHEDULER_TEMPO = 4,
    WEBRC_DSP_EXT_CONTROL_MID_SIDE_WIDTH = 5,
    WEBRC_DSP_EXT_CONTROL_ONSET_PARAMETERS = 6,
    WEBRC_DSP_EXT_CONTROL_BIT_RATE_PARAMETERS = 7,
    WEBRC_DSP_EXT_CONTROL_RING_MOD_PARAMETERS = 8,
    WEBRC_DSP_EXT_CONTROL_STREAMING_PITCH = 9,
    WEBRC_DSP_EXT_CONTROL_VOCODER_ENVELOPE = 10,
    WEBRC_DSP_EXT_CONTROL_VOCODER_GAIN = 11,
    WEBRC_DSP_EXT_CONTROL_STRETCH_TRANSPOSE = 12,
    WEBRC_DSP_EXT_CONTROL_STRETCH_FORMANT = 13,
    WEBRC_DSP_EXT_CONTROL_FDN_PARAMETERS = 14,
    WEBRC_DSP_EXT_CONTROL_GRANULAR_PARAMETERS = 15,
    WEBRC_DSP_EXT_CONTROL_SPECTRAL_FREEZE = 16,
    WEBRC_DSP_EXT_CONTROL_REVERSE_SEGMENT = 17,
    WEBRC_DSP_EXT_CONTROL_PLATTER_TARGET_SPEED = 18,
    WEBRC_DSP_EXT_CONTROL_PLATTER_INERTIA = 19,
};

enum WebrcDspExtendedEventId {
    WEBRC_DSP_EXT_EVENT_ONSET = 1,
    WEBRC_DSP_EXT_EVENT_NOTE = 2,
    WEBRC_DSP_EXT_EVENT_TRIGGER = 3,
};

enum WebrcDspDrumVoiceType {
    WEBRC_DSP_EXT_DRUM_MODAL = 1,
    WEBRC_DSP_EXT_DRUM_KICK = 2,
    WEBRC_DSP_EXT_DRUM_SNARE = 3,
    WEBRC_DSP_EXT_DRUM_HIHAT = 4,
};

typedef struct WebrcDspPitchEstimate {
    float frequencyHz;
    float periodSamples;
    float confidence;
    float rms;
    uint32_t voiced;
} WebrcDspPitchEstimate;

typedef struct WebrcDspOnsetResult {
    float envelope;
    float flux;
    uint32_t onset;
} WebrcDspOnsetResult;

typedef struct WebrcDspScheduledEvent {
    uint64_t absoluteFrame;
    uint32_t eventId;
    float value;
    uint32_t blockOffset;
    uint32_t late;
} WebrcDspScheduledEvent;

typedef struct WebrcDspDrumVoiceParameters {
    float fundamentalHz;
    float decaySeconds;
    float tone;
    float noise;
    float amplitude;
    float stereoWidth;
    uint64_t seed;
} WebrcDspDrumVoiceParameters;

typedef struct WebrcDspKickVoiceParameters {
    float startFrequencyHz;
    float endFrequencyHz;
    float sweepSeconds;
    float decaySeconds;
    float amplitude;
} WebrcDspKickVoiceParameters;

typedef struct WebrcDspSnareVoiceParameters {
    float bodyFrequencyHz;
    float bodyDecaySeconds;
    float noiseDecaySeconds;
    float noiseLevel;
    float amplitude;
    float stereoWidth;
    uint64_t seed;
} WebrcDspSnareVoiceParameters;

typedef struct WebrcDspHiHatVoiceParameters {
    float baseFrequencyHz;
    float decaySeconds;
    float noiseLevel;
    float amplitude;
    float stereoWidth;
    uint64_t seed;
} WebrcDspHiHatVoiceParameters;

// SETUP ONLY. Prepare and publish a candidate before activating its graph.
WebrcDspHandle webrc_dsp_extended_create(uint32_t kind, float sampleRate,
                                         uint32_t maxBlockFrames, uint32_t channels,
                                         const float* prepareParameters,
                                         uint32_t parameterCount, uint64_t seed);
// SETUP ONLY. Prepare a real 2x2 convolver and copy its impulse responses
// before publishing/activating its handle. Reconfiguring an active convolver
// is not supported; prepare a replacement candidate instead.
WebrcDspHandle webrc_dsp_extended_create_convolver(float sampleRate,
                                                   uint32_t maxBlockFrames,
                                                   uint32_t channels,
                                                   uint32_t partitionFrames,
                                                   uint32_t impulseFrames,
                                                   const float* impulseLL,
                                                   const float* impulseLR,
                                                   const float* impulseRL,
                                                   const float* impulseRR);
int32_t webrc_dsp_extended_last_create_status(void);
// SETUP/GRAPH CONTROL ONLY. Destroy, reset, and configure must be serialized
// with processing; reset may clear large prepared delay/history buffers.
int32_t webrc_dsp_extended_destroy(WebrcDspHandle handle);
int32_t webrc_dsp_extended_reset(WebrcDspHandle handle);
int32_t webrc_dsp_extended_configure(WebrcDspHandle handle, uint32_t control,
                                     const float* values, uint32_t valueCount,
                                     uint64_t seed);
// Prepared process calls use the actual frame count and do not allocate or
// lock. This property alone does not certify callback deadlines. All pointer
// spans must be valid, correctly aligned WASM-linear-memory ranges for the
// entire call; this C ABI does not validate arbitrary addresses.
int32_t webrc_dsp_extended_process_mono(WebrcDspHandle handle, const float* input,
                                       float* output, uint32_t frames);
int32_t webrc_dsp_extended_process_stereo(WebrcDspHandle handle,
                                          const float* inputLeft, const float* inputRight,
                                          float* outputLeft, float* outputRight,
                                          uint32_t frames);
int32_t webrc_dsp_extended_process_vocoder(WebrcDspHandle handle,
                                           const float* modulatorLeft,
                                           const float* modulatorRight,
                                           const float* carrierLeft,
                                           const float* carrierRight,
                                           float* outputLeft, float* outputRight,
                                           uint32_t frames);
int32_t webrc_dsp_extended_process_pattern(WebrcDspHandle handle, const float* input,
                                           const double* phaseCycles, float* output,
                                           uint32_t frames);
int32_t webrc_dsp_extended_process_onset(WebrcDspHandle handle, const float* input,
                                         WebrcDspOnsetResult* output,
                                         uint32_t frames);
int32_t webrc_dsp_extended_process_platter(WebrcDspHandle handle, float* speedRatios,
                                           double* phaseCycles, float* accelerations,
                                           uint32_t frames);
int32_t webrc_dsp_extended_process_pitch_stretch(WebrcDspHandle handle,
                                                const float* inputLeft,
                                                const float* inputRight,
                                                uint32_t inputFrames,
                                                float* outputLeft,
                                                float* outputRight,
                                                uint32_t outputFrames);
int32_t webrc_dsp_extended_process_spectrum(WebrcDspHandle handle,
                                            const float* inputInterleavedComplex,
                                            float* outputInterleavedComplex,
                                            float pitchRatio);
int32_t webrc_dsp_extended_process_pitch_buffer(WebrcDspHandle handle,
                                                const float* input, float* output,
                                                uint32_t frames, float sourcePeriodSamples,
                                                float pitchRatio);
// Bounded but compute-heavy frame analysis; measure before scheduling on a
// realtime thread. Input and estimate must be valid, aligned WASM spans.
int32_t webrc_dsp_extended_yin_analyze(WebrcDspHandle handle, const float* input,
                                      uint32_t frames, WebrcDspPitchEstimate* estimate);
int32_t webrc_dsp_extended_streaming_set_pitch(WebrcDspHandle handle,
                                              const WebrcDspPitchEstimate* estimate,
                                              float pitchRatio);
int32_t webrc_dsp_extended_pattern_set_gains(WebrcDspHandle handle,
                                             const float* gains, uint32_t stepCount,
                                             float edgeFraction);
int32_t webrc_dsp_extended_schedule_absolute(WebrcDspHandle handle,
                                             uint64_t absoluteFrame,
                                             uint32_t eventId, float value);
int32_t webrc_dsp_extended_schedule_tick(WebrcDspHandle handle,
                                         uint64_t originFrame, uint64_t tick,
                                         uint32_t eventId, float value);
int32_t webrc_dsp_extended_collect_events(WebrcDspHandle handle,
                                          uint64_t blockStartFrame, uint32_t frames,
                                          WebrcDspScheduledEvent* output,
                                          uint32_t outputCapacity, uint32_t* outputCount);
// SETUP ONLY. This applies only to FDN early taps and copies bounded tap data;
// it is not an active-convolver reconfiguration API. Do not race process calls.
int32_t webrc_dsp_extended_set_impulse_response(WebrcDspHandle handle,
                                                uint32_t frames, const float* ll,
                                                const float* lr, const float* rl,
                                                const float* rr);
int32_t webrc_dsp_extended_trigger_drum(WebrcDspHandle handle, uint32_t voiceType,
                                        const void* parameters, uint32_t parameterBytes);
uint32_t webrc_dsp_extended_input_latency_samples(WebrcDspHandle handle);
uint32_t webrc_dsp_extended_output_latency_samples(WebrcDspHandle handle);
int32_t webrc_dsp_extended_fft_transform(float* interleavedComplex,
                                         uint32_t complexCount, uint32_t direction);
int32_t webrc_dsp_extended_normalized_hadamard(float* values, uint32_t count);
int32_t webrc_dsp_extended_pitch_ratio(float semitones, float* ratio);

#if defined(__cplusplus)
}
#endif
