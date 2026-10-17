#include "native_fx_catalog.hpp"

#include "native_autopan_processor.hpp"
#include "native_chorus_processor.hpp"
#include "native_mod_delay_processor.hpp"
#include "native_beat_repeat_processor.hpp"
#include "native_beat_scatter_processor.hpp"
#include "native_roll_processor.hpp"
#include "native_freeze_processor.hpp"
#include "native_distortion_processor.hpp"
#include "native_preamp_processor.hpp"
#include "native_dynamics_processor.hpp"
#include "native_fdn16_reverb_processor.hpp"
#include "native_flanger_processor.hpp"
#include "native_g2b_processor.hpp"
#include "native_phaser_processor.hpp"
#include "native_panning_delay_processor.hpp"
#include "native_stereo_enhance_processor.hpp"
#include "native_tape_echo_processor.hpp"
#include "native_reverse_delay_processor.hpp"
#include "native_vinyl_flick_processor.hpp"
#include "native_poly_pitch_processor.hpp"
#include "native_auto_riff_core.hpp"
#include "native_hrm_auto_processor.hpp"
#include "native_robot_core.hpp"
#include "native_vocoder_core.hpp"
#include "native_osc_bot_processor.hpp"
#include "native_osc_voc_processor.hpp"
#include "native_electric_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>
#include <vector>

namespace webrc::native {
namespace {

constexpr std::string_view kLowPassId{"filter.lpf"};
constexpr std::string_view kBandPassId{"filter.bpf"};
constexpr std::string_view kHighPassId{"filter.hpf"};
constexpr std::string_view kPhaserId{"phaser"};
constexpr std::string_view kFlangerId{"flanger"};
constexpr std::string_view kDynamicsId{"dynamics"};
constexpr std::string_view kDistortionId{"dist"};
constexpr std::string_view kPreampId{"preamp"};
constexpr std::string_view kReverbId{"reverb"};
constexpr std::string_view kGateReverbId{"gate_reverb"};
constexpr std::string_view kBeatRepeatId{"beat_repeat"};
constexpr std::string_view kBeatScatterId{"beat_scatter"};
constexpr std::string_view kRollId{"roll"};
constexpr std::string_view kFreezeId{"freeze"};
constexpr std::string_view kWarpId{"warp"};
constexpr std::string_view kTapeEchoId{"tape_echo"};
constexpr std::string_view kReverseDelayId{"reverse_delay"};
constexpr std::string_view kReverseReverbId{"reverse_reverb"};
constexpr std::string_view kFractionalDelayId{"fractional_delay"};
constexpr std::string_view kModDelayId{"mod_delay"};
constexpr std::string_view kPanningDelayId{"panning_delay"};
constexpr std::string_view kTwistId{"twist"};
constexpr std::string_view kGranularDelayId{"granular_delay"};
constexpr std::string_view kAutoPanId{"auto_pan"};
constexpr std::string_view kManualPanId{"manual_pan"};
constexpr std::string_view kChorusId{"chorus"};
constexpr std::string_view kTremoloId{"tremolo"};
constexpr std::string_view kRingModId{"ring_mod"};
constexpr std::string_view kEqualizerId{"eq"};
constexpr std::string_view kIsolatorId{"isolator"};
constexpr std::string_view kStereoEnhanceId{"stereo_enhance"};
constexpr std::string_view kLoFiId{"lo_fi"};
constexpr std::string_view kRadioId{"radio"};
constexpr std::string_view kSustainerId{"sustainer"};
constexpr std::string_view kVibratoId{"vibrato"};
constexpr std::string_view kSlowGearId{"slow_gear"};
constexpr std::string_view kPatternSlicerId{"pattern_slicer"};
constexpr std::string_view kStepSlicerId{"step_slicer"};
constexpr std::string_view kVinylFlickId{"vinyl_flick"};
constexpr std::string_view kSynthId{"synth"};
constexpr std::string_view kG2BId{"g2b"};
constexpr std::string_view kTransposeId{"transpose"};
constexpr std::string_view kPitchBendId{"pitch_bend"};
constexpr std::string_view kManualHarmonistId{"hrm_manual"};
constexpr std::string_view kOctaveId{"octave"};
constexpr std::string_view kVocoderId{"vocoder"};
constexpr std::string_view kOscVocMId{"osc_voc_m"};
constexpr std::string_view kOscBotId{"osc_bot"};
constexpr std::string_view kAutoRiffId{"auto_riff"};
constexpr std::string_view kHrmAutoMId{"hrm_auto_m"};
constexpr std::string_view kRobotId{"robot"};
constexpr std::string_view kElectricId{"electric"};
constexpr double kTwoPi = 6.28318530717958647692;

constexpr NativeEffectParameterDescriptor kFilterParameters[] = {
    {"cutoff_hz", "Cutoff", 20.0f, 20000.0f, 1000.0f, 15U, false},
    {"q", "Resonance", 0.5f, 12.0f, 0.70710678f, 15U, false},
};
constexpr float kPhaserStageValues[] = {4.0f, 8.0f, 12.0f};
constexpr NativeEffectParameterDescriptor kPhaserParameters[] = {
    {"stages", "Stages", 4.0f, 12.0f, 8.0f, 40U, true, kPhaserStageValues,
        sizeof(kPhaserStageValues) / sizeof(kPhaserStageValues[0])},
    {"rate_hz", "Rate", 0.05f, 10.0f, 0.5f, 20U, false},
    {"depth", "Depth", 0.0f, 1.0f, 0.65f, 20U, false},
    {"feedback", "Feedback", -0.9f, 0.9f, 0.0f, 20U, false},
    {"wet_mix", "Wet", 0.0f, 1.0f, 0.5f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kFlangerParameters[] = {
    {"delay_ms", "Delay time", 0.2f, 10.0f, 3.0f, 20U, false},
    {"rate_hz", "Rate", 0.05f, 20.0f, 0.3f, 20U, false},
    {"depth", "Depth", 0.0f, 1.0f, 0.6f, 20U, false},
    {"feedback", "Feedback", -0.95f, 0.95f, 0.25f, 20U, false},
    {"wet_mix", "Effect mix", 0.0f, 1.0f, 0.5f, 10U, false},
};
constexpr float kDynamicsDetectorValues[] = {0.0f, 1.0f};
constexpr NativeEffectParameterDescriptor kDynamicsParameters[] = {
    {"threshold_db", "Threshold", -60.0f, 0.0f, -18.0f, 20U, false},
    {"ratio", "Compression ratio", 1.0f, 20.0f, 4.0f, 20U, false},
    {"knee_db", "Soft knee", 0.0f, 24.0f, 6.0f, 20U, false},
    {"attack_ms", "Attack", 0.1f, 100.0f, 10.0f, 20U, false},
    {"release_ms", "Release", 5.0f, 1000.0f, 120.0f, 20U, false},
    {"output_gain_db", "Output level", -24.0f, 12.0f, 0.0f, 10U, false},
    {"detector", "Detector", 0.0f, 1.0f, 0.0f, 20U, true,
        kDynamicsDetectorValues, sizeof(kDynamicsDetectorValues) / sizeof(kDynamicsDetectorValues[0])},
};
constexpr NativeEffectParameterDescriptor kDistortionParameters[] = {
    {"drive_db", "Drive", 0.0f, 36.0f, 12.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr float kPreampModelValues[] = {0.0f, 1.0f, 2.0f, 3.0f, 4.0f};
constexpr NativeEffectParameterDescriptor kPreampParameters[] = {
    {"model", "Preamp model", 0.0f, 4.0f, 0.0f, 40U, true, kPreampModelValues,
        sizeof(kPreampModelValues) / sizeof(kPreampModelValues[0])},
    {"gain", "Preamp gain", 0.0f, 100.0f, 35.0f, 20U, false},
    {"bass", "Bass", -12.0f, 12.0f, 0.0f, 20U, false},
    {"middle", "Middle", -12.0f, 12.0f, 0.0f, 20U, false},
    {"treble", "Treble", -12.0f, 12.0f, 0.0f, 20U, false},
    {"level", "Output level", -24.0f, 12.0f, 0.0f, 20U, false},
};
constexpr NativeEffectParameterDescriptor kReverbParameters[] = {
    {"decay_seconds", "Decay time", 0.1f, 20.0f, 2.5f, 40U, false},
    {"damping_cutoff_hz", "Damping cutoff", 500.0f, 16000.0f, 8000.0f, 20U, false},
    {"wet_mix", "Effect mix", 0.0f, 1.0f, 0.25f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kGateReverbParameters[] = {
    {"decay_seconds", "Reverb decay", 0.1f, 20.0f, 2.5f, 40U, false},
    {"damping_cutoff_hz", "Damping cutoff", 500.0f, 20000.0f, 8000.0f, 20U, false},
    {"wet_mix", "Reverb level", 0.0f, 1.0f, 0.35f, 10U, false},
    {"threshold_db", "Gate threshold", -60.0f, 0.0f, -24.0f, 15U, false},
    {"hysteresis_db", "Gate hysteresis", 0.0f, 24.0f, 6.0f, 15U, false},
    {"hold_ms", "Gate hold", 0.0f, 2000.0f, 120.0f, 10U, false},
    {"release_ms", "Gate release", 10.0f, 2000.0f, 250.0f, 15U, false},
};
constexpr float kBeatRepeatDivisionValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr float kBeatRepeatDirectionValues[] = {0.0f, 1.0f, 2.0f};
constexpr NativeEffectParameterDescriptor kBeatRepeatParameters[] = {
    {"bpm", "Tempo", 30.0f, 300.0f, 120.0f, 0U, false},
    {"division", "Beat division", 0.25f, 4.0f, 0.5f, 0U, true, kBeatRepeatDivisionValues,
        sizeof(kBeatRepeatDivisionValues) / sizeof(kBeatRepeatDivisionValues[0])},
    {"decay", "Repeat decay", 0.0f, 100.0f, 15.0f, 0U, false},
    {"direction", "Direction", 0.0f, 2.0f, 0.0f, 0U, true, kBeatRepeatDirectionValues,
        sizeof(kBeatRepeatDirectionValues) / sizeof(kBeatRepeatDirectionValues[0])},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 50.0f, 10U, false},
};
constexpr float kBeatScatterSliceBeatValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr NativeEffectParameterDescriptor kBeatScatterParameters[] = {
    {"bpm", "Tempo", 40.0f, 300.0f, 120.0f, 0U, false},
    {"slice_beats", "Slice size", 0.25f, 4.0f, 0.25f, 0U, true, kBeatScatterSliceBeatValues,
        sizeof(kBeatScatterSliceBeatValues) / sizeof(kBeatScatterSliceBeatValues[0])},
    {"scatter_percent", "Scatter amount", 0.0f, 100.0f, 50.0f, 0U, false},
    {"pitch_semitones", "Pitch range", -24.0f, 24.0f, 0.0f, 0U, false},
    {"repeats", "Repeat count", 1.0f, 16.0f, 4.0f, 0U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 50.0f, 10U, false},
};
constexpr float kRollSliceBeatValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr float kRollDirectionValues[] = {0.0f, 1.0f, 2.0f};
constexpr NativeEffectParameterDescriptor kRollParameters[] = {
    {"bpm", "Tempo", 40.0f, 300.0f, 120.0f, 0U, false},
    {"slice_beats", "Slice size", 0.25f, 4.0f, 0.5f, 0U, true, kRollSliceBeatValues,
        sizeof(kRollSliceBeatValues) / sizeof(kRollSliceBeatValues[0])},
    {"decay_percent", "Repeat decay", 0.0f, 100.0f, 20.0f, 0U, false},
    {"pitch_semitones", "Playback pitch", -24.0f, 24.0f, 0.0f, 0U, false},
    {"direction", "Direction", 0.0f, 2.0f, 0.0f, 0U, true, kRollDirectionValues,
        sizeof(kRollDirectionValues) / sizeof(kRollDirectionValues[0])},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 50.0f, 10U, false},
};
constexpr float kFreezeModeValues[] = {0.0f};
constexpr float kFreezeStateValues[] = {0.0f, 1.0f};
constexpr NativeEffectParameterDescriptor kFreezeParameters[] = {
    {"capture_ms", "Capture length", 2.0f, 2000.0f, 250.0f, 0U, false},
    // Only mode 0 is implemented. Keeping 1 outside the supported discrete
    // values makes the Native catalog/HTTP layer reject spectral mode clearly.
    {"mode", "Mode", 0.0f, 1.0f, 0.0f, 0U, true, kFreezeModeValues,
        sizeof(kFreezeModeValues) / sizeof(kFreezeModeValues[0])},
    {"pitch_semitones", "Playback pitch", -24.0f, 24.0f, 0.0f, 0U, false},
    {"freeze", "Freeze", 0.0f, 1.0f, 0.0f, 0U, true, kFreezeStateValues,
        sizeof(kFreezeStateValues) / sizeof(kFreezeStateValues[0])},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 50.0f, 10U, false},
};
constexpr float kWarpCaptureBeatValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr float kWarpFreezeValues[] = {0.0f, 1.0f};
constexpr NativeEffectParameterDescriptor kWarpParameters[] = {
    {"bpm", "Tempo (BPM)", 30.0f, 300.0f, 120.0f, 20U, false},
    {"capture_beats", "Capture length (beats)", 0.25f, 4.0f, 1.0f, 20U, true,
        kWarpCaptureBeatValues, sizeof(kWarpCaptureBeatValues) / sizeof(kWarpCaptureBeatValues[0])},
    {"smear_percent", "Grain smear", 0.0f, 100.0f, 30.0f, 20U, false},
    {"pitch_semitones", "Pitch shift", -24.0f, 24.0f, 0.0f, 20U, false},
    {"feedback_percent", "Regeneration", 0.0f, 95.0f, 20.0f, 20U, false},
    {"freeze", "Capture hold", 0.0f, 1.0f, 0.0f, 0U, true,
        kWarpFreezeValues, sizeof(kWarpFreezeValues) / sizeof(kWarpFreezeValues[0])},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 40.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kTapeEchoParameters[] = {
    {"time_ms", "Head delay", 20.0f, 2000.0f, 350.0f, 30U, false},
    {"feedback_percent", "Feedback", 0.0f, 95.0f, 35.0f, 20U, false},
    {"wow_flutter_percent", "Wow/flutter", 0.0f, 100.0f, 15.0f, 20U, false},
    {"saturation_percent", "Tape saturation", 0.0f, 100.0f, 25.0f, 20U, false},
    {"tone_hz", "Tape loss cutoff", 500.0f, 16000.0f, 6000.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 30.0f, 10U, false},
};
constexpr float kReverseDelayBeatValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr NativeEffectParameterDescriptor kReverseDelayParameters[] = {
    {"bpm", "Tempo", 30.0f, 300.0f, 120.0f, 0U, false},
    {"segment_beats", "Segment length", 0.25f, 4.0f, 1.0f, 0U, true, kReverseDelayBeatValues,
        sizeof(kReverseDelayBeatValues) / sizeof(kReverseDelayBeatValues[0])},
    {"feedback_percent", "Feedback", 0.0f, 95.0f, 20.0f, 20U, false},
    {"crossfade_ms", "Crossfade", 1.0f, 100.0f, 20.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 30.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kReverseReverbParameters[] = {
    {"bpm", "Tempo", 30.0f, 300.0f, 120.0f, 0U, false},
    {"segment_beats", "Reverse segment", 0.25f, 4.0f, 0.5f, 0U, true, kReverseDelayBeatValues,
        sizeof(kReverseDelayBeatValues) / sizeof(kReverseDelayBeatValues[0])},
    {"feedback_percent", "Segment feedback", 0.0f, 80.0f, 0.0f, 20U, false},
    {"crossfade_ms", "Segment crossfade", 1.0f, 100.0f, 20.0f, 20U, false},
    {"decay_seconds", "Diffuse tail", 0.1f, 10.0f, 2.0f, 40U, false},
    {"damping_cutoff_hz", "Tail damping", 500.0f, 16000.0f, 8000.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 35.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kFractionalDelayParameters[] = {
    {"delay_ms", "Delay", 10.0f, 2000.0f, 350.0f, 30U, false},
    {"feedback", "Feedback", 0.0f, 0.95f, 0.35f, 20U, false},
    {"wet_mix", "Wet", 0.0f, 1.0f, 0.3f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kModDelayParameters[] = {
    {"rate_hz", "Rate", 0.05f, 10.0f, 0.3f, 20U, false},
    {"depth_ms", "Modulation depth", 0.0f, 50.0f, 10.0f, 20U, false},
    {"delay_ms", "Delay time", 10.0f, 2000.0f, 500.0f, 30U, false},
    {"feedback", "Feedback", 0.0f, 0.95f, 0.25f, 20U, false},
    {"wet_mix", "Effect mix", 0.0f, 1.0f, 0.25f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kPanningDelayParameters[] = {
    {"time_ms", "Delay time", 1.0f, 2000.0f, 500.0f, 30U, false},
    {"feedback_percent", "Feedback", 0.0f, 95.0f, 30.0f, 20U, false},
    {"pan_percent", "Repeat pan", -100.0f, 100.0f, 70.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 25.0f, 10U, false},
};
constexpr float kTwistTrajectoryValues[] = {0.0f, 1.0f, 2.0f, 3.0f};
constexpr NativeEffectParameterDescriptor kTwistParameters[] = {
    {"amount_percent", "Macro amount", -100.0f, 100.0f, 0.0f, 20U, false},
    {"trajectory", "Trajectory", 0.0f, 3.0f, 0.0f, 20U, true, kTwistTrajectoryValues,
        sizeof(kTwistTrajectoryValues) / sizeof(kTwistTrajectoryValues[0])},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 50.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kGranularDelayParameters[] = {
    {"grain_size_ms", "Grain size", 10.0f, 1000.0f, 120.0f, 20U, false},
    {"density_hz", "Grain density", 1.0f, 80.0f, 12.0f, 20U, false},
    {"pitch_semitones", "Grain pitch", -24.0f, 24.0f, 0.0f, 20U, false},
    {"position_jitter_percent", "Position jitter", 0.0f, 100.0f, 15.0f, 20U, false},
    {"feedback_percent", "Feedback", 0.0f, 95.0f, 15.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 35.0f, 10U, false},
};
constexpr float kAutoPanWaveformValues[] = {0.0f, 1.0f, 2.0f};
constexpr NativeEffectParameterDescriptor kAutoPanParameters[] = {
    {"rate_hz", "Rate", 0.05f, 20.0f, 0.5f, 20U, false},
    {"depth", "Depth", 0.0f, 1.0f, 0.7f, 20U, false},
    {"waveform", "Waveform", 0.0f, 2.0f, 0.0f, 20U, true, kAutoPanWaveformValues,
        sizeof(kAutoPanWaveformValues) / sizeof(kAutoPanWaveformValues[0])},
    {"wet_mix", "Wet", 0.0f, 1.0f, 1.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kManualPanParameters[] = {
    {"position", "Pan position", -100.0f, 100.0f, 0.0f, 15U, false},
};
constexpr NativeEffectParameterDescriptor kChorusParameters[] = {
    {"rate_hz", "Rate", 0.1f, 8.0f, 0.8f, 20U, false},
    {"depth_ms", "Depth", 0.0f, 25.0f, 5.0f, 20U, false},
    {"feedback", "Feedback", 0.0f, 0.95f, 0.0f, 20U, false},
    {"wet_mix", "Wet", 0.0f, 1.0f, 0.25f, 10U, false},
};
constexpr float kTremoloWaveformValues[] = {0.0f, 1.0f, 2.0f};
constexpr NativeEffectParameterDescriptor kTremoloParameters[] = {
    {"rate_hz", "Rate", 0.05f, 20.0f, 4.0f, 20U, false},
    {"depth", "Depth", 0.0f, 1.0f, 0.5f, 20U, false},
    {"waveform", "Waveform", 0.0f, 2.0f, 0.0f, 20U, true, kTremoloWaveformValues,
        sizeof(kTremoloWaveformValues) / sizeof(kTremoloWaveformValues[0])},
    {"wet_mix", "Wet", 0.0f, 1.0f, 1.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kRingModParameters[] = {
    {"carrier_hz", "Carrier", 20.0f, 20000.0f, 440.0f, 20U, false},
    {"depth", "Depth", 0.0f, 1.0f, 1.0f, 20U, false},
    {"wet_mix", "Wet", 0.0f, 1.0f, 1.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kEqualizerParameters[] = {
    {"low_frequency_hz", "Low shelf frequency", 20.0f, 500.0f, 100.0f, 20U, false},
    {"low_gain_db", "Low shelf gain", -15.0f, 15.0f, 0.0f, 20U, false},
    {"mid1_frequency_hz", "Mid 1 frequency", 80.0f, 8000.0f, 500.0f, 20U, false},
    {"mid1_q", "Mid 1 Q", 0.1f, 12.0f, 1.0f, 20U, false},
    {"mid1_gain_db", "Mid 1 gain", -15.0f, 15.0f, 0.0f, 20U, false},
    {"mid2_frequency_hz", "Mid 2 frequency", 80.0f, 12000.0f, 2500.0f, 20U, false},
    {"mid2_q", "Mid 2 Q", 0.1f, 12.0f, 1.0f, 20U, false},
    {"mid2_gain_db", "Mid 2 gain", -15.0f, 15.0f, 0.0f, 20U, false},
    {"high_frequency_hz", "High shelf frequency", 1000.0f, 20000.0f, 8000.0f, 20U, false},
    {"high_gain_db", "High shelf gain", -15.0f, 15.0f, 0.0f, 20U, false},
};
constexpr float kIsolatorGateEnabledValues[] = {0.0f, 1.0f};
constexpr float kIsolatorGateDivisionValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr NativeEffectParameterDescriptor kIsolatorParameters[] = {
    {"low_crossover_hz", "Low crossover", 40.0f, 8000.0f, 250.0f, 20U, false},
    {"high_crossover_hz", "High crossover", 100.0f, 18000.0f, 4000.0f, 20U, false},
    {"low_gain_db", "Low band level", -24.0f, 12.0f, 0.0f, 20U, false},
    {"mid_gain_db", "Mid band level", -24.0f, 12.0f, 0.0f, 20U, false},
    {"high_gain_db", "High band level", -24.0f, 12.0f, 0.0f, 20U, false},
    {"gate_enabled", "Rhythmic gate", 0.0f, 1.0f, 0.0f, 0U, true,
        kIsolatorGateEnabledValues, sizeof(kIsolatorGateEnabledValues) / sizeof(kIsolatorGateEnabledValues[0])},
    {"gate_bpm", "Gate tempo", 30.0f, 300.0f, 120.0f, 20U, false},
    {"gate_division_beats", "Gate period", 0.25f, 4.0f, 0.5f, 0U, true,
        kIsolatorGateDivisionValues, sizeof(kIsolatorGateDivisionValues) / sizeof(kIsolatorGateDivisionValues[0])},
    {"gate_duty_percent", "Gate open time", 5.0f, 95.0f, 50.0f, 20U, false},
    {"gate_attack_ms", "Gate attack", 0.1f, 50.0f, 1.0f, 20U, false},
    {"gate_release_ms", "Gate release", 1.0f, 250.0f, 25.0f, 20U, false},
};
constexpr NativeEffectParameterDescriptor kStereoEnhanceParameters[] = {
    {"width", "Stereo width", 0.0f, 200.0f, 100.0f, 20U, false},
    {"low_mono_cutoff_hz", "Low mono cutoff", 20.0f, 1000.0f, 120.0f, 20U, false},
    {"decorrelation", "Decorrelation", 0.0f, 100.0f, 25.0f, 20U, false},
    {"wet_mix", "Effect mix", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kLoFiParameters[] = {
    {"bit_depth", "Bit depth", 4.0f, 24.0f, 12.0f, 20U, false},
    {"sample_rate_hz", "Sample rate", 500.0f, 48000.0f, 12000.0f, 20U, false},
    {"filter_hz", "Post-filter cutoff", 20.0f, 20000.0f, 12000.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 70.0f, 10U, false},
};
constexpr float kRadioBandValues[] = {0.0f, 1.0f, 2.0f};
constexpr NativeEffectParameterDescriptor kRadioParameters[] = {
    {"band", "Radio band", 0.0f, 2.0f, 0.0f, 40U, true, kRadioBandValues,
        sizeof(kRadioBandValues) / sizeof(kRadioBandValues[0])},
    {"drive", "Saturation drive", 0.0f, 100.0f, 35.0f, 20U, false},
    {"noise", "Noise/dropout", 0.0f, 100.0f, 8.0f, 20U, false},
    {"mix", "Effect mix", 0.0f, 100.0f, 70.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kSustainerParameters[] = {
    {"threshold_db", "Threshold", -60.0f, 0.0f, -24.0f, 15U, false},
    {"ratio", "Compression ratio", 1.0f, 20.0f, 4.0f, 15U, false},
    {"release_ms", "Release", 10.0f, 1000.0f, 180.0f, 15U, false},
    {"output_db", "Output level", -24.0f, 12.0f, 0.0f, 15U, false},
};
constexpr NativeEffectParameterDescriptor kVibratoParameters[] = {
    {"rate_hz", "Rate", 0.05f, 20.0f, 5.0f, 20U, false},
    {"depth", "Depth", 0.0f, 100.0f, 35.0f, 20U, false},
    {"delay_ms", "Base delay", 0.2f, 10.0f, 2.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kSlowGearParameters[] = {
    {"attack_ms", "Attack time", 5.0f, 2000.0f, 250.0f, 10U, false},
    {"sensitivity_percent", "Onset sensitivity", 0.0f, 100.0f, 50.0f, 10U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr float kPatternSlicerPatternValues[] = {0.0f, 1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f, 7.0f};
constexpr float kPatternSlicerRateValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr NativeEffectParameterDescriptor kPatternSlicerParameters[] = {
    {"pattern", "Pattern", 0.0f, 7.0f, 0.0f, 0U, true, kPatternSlicerPatternValues,
        sizeof(kPatternSlicerPatternValues) / sizeof(kPatternSlicerPatternValues[0])},
    {"rate", "Step rate", 0.25f, 4.0f, 0.25f, 0U, true, kPatternSlicerRateValues,
        sizeof(kPatternSlicerRateValues) / sizeof(kPatternSlicerRateValues[0])},
    {"depth", "Gate depth", 0.0f, 100.0f, 100.0f, 10U, false},
    {"edge_ms", "Edge smoothing", 0.5f, 20.0f, 2.0f, 10U, false},
    // Tempo is supplied by the Native host's transport macro, rather than a
    // visible PATTERN SLICER panel control.
    {"bpm", "Tempo", 30.0f, 300.0f, 120.0f, 20U, false},
};
constexpr float kStepSlicerStepCountValues[] = {4.0f, 8.0f, 16.0f};
constexpr float kStepSlicerRateValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr NativeEffectParameterDescriptor kStepSlicerParameters[] = {
    {"step_count", "Active steps", 4.0f, 16.0f, 16.0f, 0U, true, kStepSlicerStepCountValues,
        sizeof(kStepSlicerStepCountValues) / sizeof(kStepSlicerStepCountValues[0])},
    {"rate_beats", "Step rate", 0.25f, 4.0f, 0.25f, 0U, true, kStepSlicerRateValues,
        sizeof(kStepSlicerRateValues) / sizeof(kStepSlicerRateValues[0])},
    // The browser/native adapter updates this hidden transport macro from the
    // active rhythm tempo; it is accepted here so the sample clock stays in sync.
    {"bpm", "Tempo", 30.0f, 300.0f, 120.0f, 20U, false},
    {"depth_percent", "Gate depth", 0.0f, 100.0f, 100.0f, 10U, false},
    {"pan_depth_percent", "Pan depth", 0.0f, 100.0f, 0.0f, 10U, false},
    {"filter_hz", "Low-pass cutoff", 20.0f, 20000.0f, 20000.0f, 20U, false},
    {"step_01", "Step 1 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_02", "Step 2 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_03", "Step 3 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_04", "Step 4 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_05", "Step 5 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_06", "Step 6 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_07", "Step 7 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_08", "Step 8 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_09", "Step 9 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_10", "Step 10 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_11", "Step 11 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_12", "Step 12 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_13", "Step 13 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_14", "Step 14 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_15", "Step 15 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
    {"step_16", "Step 16 amplitude", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kVinylFlickParameters[] = {
    {"speed_percent", "Platter speed", -100.0f, 100.0f, -100.0f, 20U, false},
    {"motor_return_seconds", "Motor return", 0.05f, 10.0f, 1.5f, 20U, false},
    {"brake_percent", "Brake", 0.0f, 100.0f, 35.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr float kSynthWaveformValues[] = {0.0f, 1.0f, 2.0f};
constexpr NativeEffectParameterDescriptor kSynthParameters[] = {
    {"sensitivity", "Tracking sensitivity", 0.0f, 100.0f, 60.0f, 20U, false},
    {"waveform", "Oscillator waveform", 0.0f, 2.0f, 0.0f, 20U, true, kSynthWaveformValues,
        sizeof(kSynthWaveformValues) / sizeof(kSynthWaveformValues[0])},
    {"octave", "Oscillator semitones", -24.0f, 24.0f, 0.0f, 20U, false},
    {"tone", "Tone cutoff", 100.0f, 16000.0f, 4000.0f, 20U, false},
    {"mix", "Effect mix", 0.0f, 100.0f, 50.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kG2BParameters[] = {
    {"tracking_percent", "Tracking", 0.0f, 100.0f, 65.0f, 20U, false},
    {"blend_percent", "Blend", 0.0f, 100.0f, 65.0f, 10U, false},
    {"body_hz", "Body cutoff", 60.0f, 1200.0f, 180.0f, 20U, false},
};
constexpr NativeEffectParameterDescriptor kTransposeParameters[] = {
    {"shift_semitones", "Pitch shift", -24.0f, 24.0f, 0.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr float kPitchBendDirectionValues[] = {0.0f, 1.0f};
constexpr NativeEffectParameterDescriptor kPitchBendParameters[] = {
    {"range", "Pitch range", 0.0f, 24.0f, 12.0f, 0U, false},
    {"time_ms", "Sweep time", 20.0f, 4000.0f, 500.0f, 0U, false},
    {"direction", "Direction", 0.0f, 1.0f, 0.0f, 0U, true, kPitchBendDirectionValues,
        sizeof(kPitchBendDirectionValues) / sizeof(kPitchBendDirectionValues[0])},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kManualHarmonistParameters[] = {
    {"voice_1_interval", "Voice 1 interval", -24.0f, 24.0f, 7.0f, 20U, false},
    {"voice_2_interval", "Voice 2 interval", -24.0f, 24.0f, 12.0f, 20U, false},
    {"pan_percent", "Harmony pan", -100.0f, 100.0f, 0.0f, 20U, false},
    {"mix_percent", "Harmony level", 0.0f, 100.0f, 70.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kOctaveParameters[] = {
    {"minus_24_level", "-24 semitone level", 0.0f, 100.0f, 0.0f, 20U, false},
    {"minus_12_level", "-12 semitone level", 0.0f, 100.0f, 40.0f, 20U, false},
    {"plus_12_level", "+12 semitone level", 0.0f, 100.0f, 0.0f, 20U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 70.0f, 10U, false},
};
constexpr float kVocoderBandValues[] = {
    8.0f, 9.0f, 10.0f, 11.0f, 12.0f, 13.0f, 14.0f, 15.0f, 16.0f,
    17.0f, 18.0f, 19.0f, 20.0f, 21.0f, 22.0f, 23.0f, 24.0f,
};
constexpr float kVocoderCarrierValues[] = {0.0f, 1.0f, 2.0f};
constexpr NativeEffectParameterDescriptor kVocoderParameters[] = {
    {"bands", "Filterbank bands", 8.0f, 24.0f, 16.0f, 0U, true, kVocoderBandValues,
        sizeof(kVocoderBandValues) / sizeof(kVocoderBandValues[0])},
    {"carrier", "Carrier", 0.0f, 2.0f, 1.0f, 0U, true, kVocoderCarrierValues,
        sizeof(kVocoderCarrierValues) / sizeof(kVocoderCarrierValues[0])},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 70.0f, 10U, false},
};
constexpr float kOscVocWaveformValues[] = {0.0f, 1.0f, 2.0f};
constexpr float kOscVocChannelValues[] = {
    1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f, 7.0f, 8.0f,
    9.0f, 10.0f, 11.0f, 12.0f, 13.0f, 14.0f, 15.0f, 16.0f,
};
constexpr NativeEffectParameterDescriptor kOscVocMParameters[] = {
    {"waveform", "Carrier waveform", 0.0f, 2.0f, 0.0f, 0U, true, kOscVocWaveformValues,
        sizeof(kOscVocWaveformValues) / sizeof(kOscVocWaveformValues[0])},
    {"midi-channel", "MIDI channel", 1.0f, 16.0f, 1.0f, 0U, true, kOscVocChannelValues,
        sizeof(kOscVocChannelValues) / sizeof(kOscVocChannelValues[0])},
    {"octave", "Carrier transpose", -24.0f, 24.0f, 0.0f, 0U, false},
    {"mix", "Effect mix", 0.0f, 100.0f, 70.0f, 10U, false},
};
constexpr float kOscBotBandValues[] = {
    8.0f, 9.0f, 10.0f, 11.0f, 12.0f, 13.0f, 14.0f, 15.0f, 16.0f,
    17.0f, 18.0f, 19.0f, 20.0f, 21.0f, 22.0f, 23.0f, 24.0f,
};
constexpr float kOscBotWaveformValues[] = {0.0f, 1.0f, 2.0f};
constexpr float kOscBotPatternValues[] = {0.0f, 1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f, 7.0f};
constexpr float kAutoRiffScaleValues[] = {0.0f, 1.0f, 2.0f, 3.0f, 4.0f};
constexpr float kAutoRiffStepRateValues[] = {0.25f, 0.5f, 1.0f, 2.0f, 4.0f};
constexpr NativeEffectParameterDescriptor kAutoRiffParameters[] = {
    {"bpm", "Tempo", 20.0f, 300.0f, 120.0f, 0U, false},
    {"scale", "Scale", 0.0f, 4.0f, 0.0f, 0U, true, kAutoRiffScaleValues,
        sizeof(kAutoRiffScaleValues) / sizeof(kAutoRiffScaleValues[0])},
    {"rate_beats", "Step rate", 0.25f, 4.0f, 0.5f, 0U, true, kAutoRiffStepRateValues,
        sizeof(kAutoRiffStepRateValues) / sizeof(kAutoRiffStepRateValues[0])},
    {"sensitivity_percent", "Onset sensitivity", 0.0f, 100.0f, 55.0f, 0U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 65.0f, 10U, false},
};
constexpr float kHrmAutoKeyValues[] = {0.0f, 1.0f, 2.0f, 3.0f, 4.0f, 5.0f,
                                       6.0f, 7.0f, 8.0f, 9.0f, 10.0f, 11.0f};
constexpr float kHrmAutoScaleValues[] = {0.0f, 1.0f, 2.0f, 3.0f, 4.0f};
constexpr float kHrmAutoChannelValues[] = {
    1.0f, 2.0f, 3.0f, 4.0f, 5.0f, 6.0f, 7.0f, 8.0f,
    9.0f, 10.0f, 11.0f, 12.0f, 13.0f, 14.0f, 15.0f, 16.0f,
};
constexpr NativeEffectParameterDescriptor kHrmAutoMParameters[] = {
    {"key", "Key", 0.0f, 11.0f, 0.0f, 0U, true, kHrmAutoKeyValues,
        sizeof(kHrmAutoKeyValues) / sizeof(kHrmAutoKeyValues[0])},
    {"scale", "Scale", 0.0f, 4.0f, 0.0f, 0U, true, kHrmAutoScaleValues,
        sizeof(kHrmAutoScaleValues) / sizeof(kHrmAutoScaleValues[0])},
    {"midi-channel", "MIDI channel", 1.0f, 16.0f, 1.0f, 0U, true, kHrmAutoChannelValues,
        sizeof(kHrmAutoChannelValues) / sizeof(kHrmAutoChannelValues[0])},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 70.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kRobotParameters[] = {
    {"pitch_semitones", "Target pitch", -24.0f, 24.0f, 0.0f, 0U, false},
    {"formant_semitones", "Formant shift", -12.0f, 12.0f, 0.0f, 0U, false},
    {"mix_percent", "Effect mix", 0.0f, 100.0f, 100.0f, 10U, false},
};
constexpr float kElectricCharacterValues[] = {0.0f, 1.0f, 2.0f, 3.0f};
constexpr NativeEffectParameterDescriptor kElectricParameters[] = {
    {"character", "Character", 0.0f, 3.0f, 0.0f, 0U, true, kElectricCharacterValues,
        sizeof(kElectricCharacterValues) / sizeof(kElectricCharacterValues[0])},
    {"pitch-snap", "Pitch snap", 0.0f, 100.0f, 50.0f, 20U, false},
    {"tone", "Tone cutoff", 100.0f, 16000.0f, 5000.0f, 20U, false},
    {"mix", "Effect mix", 0.0f, 100.0f, 70.0f, 10U, false},
};
constexpr NativeEffectParameterDescriptor kOscBotParameters[] = {
    {"bands", "Filterbank bands", 8.0f, 24.0f, 16.0f, 0U, true, kOscBotBandValues,
        sizeof(kOscBotBandValues) / sizeof(kOscBotBandValues[0])},
    {"waveform", "Carrier waveform", 0.0f, 2.0f, 1.0f, 0U, true, kOscBotWaveformValues,
        sizeof(kOscBotWaveformValues) / sizeof(kOscBotWaveformValues[0])},
    {"pattern", "Pattern", 0.0f, 7.0f, 0.0f, 0U, true, kOscBotPatternValues,
        sizeof(kOscBotPatternValues) / sizeof(kOscBotPatternValues[0])},
    {"tone", "Tone cutoff (Hz)", 100.0f, 16000.0f, 3000.0f, 0U, false},
    {"tempo", "Tempo (BPM)", 30.0f, 300.0f, 120.0f, 0U, false},
    {"mix", "Effect mix", 0.0f, 100.0f, 70.0f, 10U, false},
};
const NativeEffectDescriptor kCatalog[] = {
    {kLowPassId, "Low-pass filter", kFilterParameters, sizeof(kFilterParameters) / sizeof(kFilterParameters[0])},
    {kBandPassId, "Band-pass filter", kFilterParameters, sizeof(kFilterParameters) / sizeof(kFilterParameters[0])},
    {kHighPassId, "High-pass filter", kFilterParameters, sizeof(kFilterParameters) / sizeof(kFilterParameters[0])},
    {kPhaserId, "Phaser", kPhaserParameters, sizeof(kPhaserParameters) / sizeof(kPhaserParameters[0])},
    {kFlangerId, "FLANGER", kFlangerParameters, sizeof(kFlangerParameters) / sizeof(kFlangerParameters[0])},
    {kDynamicsId, "DYNAMICS", kDynamicsParameters, sizeof(kDynamicsParameters) / sizeof(kDynamicsParameters[0])},
    {kDistortionId, "DIST", kDistortionParameters, sizeof(kDistortionParameters) / sizeof(kDistortionParameters[0])},
    {kReverbId, "REVERB (FDN16)", kReverbParameters, sizeof(kReverbParameters) / sizeof(kReverbParameters[0])},
    {kGateReverbId, "GATE REVERB (FDN16)", kGateReverbParameters,
        sizeof(kGateReverbParameters) / sizeof(kGateReverbParameters[0]), true, true, 48},
    {kBeatRepeatId, "BEAT REPEAT", kBeatRepeatParameters,
        sizeof(kBeatRepeatParameters) / sizeof(kBeatRepeatParameters[0]), false, true},
    {kBeatScatterId, "BEAT SCATTER", kBeatScatterParameters,
        sizeof(kBeatScatterParameters) / sizeof(kBeatScatterParameters[0]), false, true, 50},
    {kRollId, "ROLL", kRollParameters,
        sizeof(kRollParameters) / sizeof(kRollParameters[0]), true, true, 44},
    {kFreezeId, "FREEZE", kFreezeParameters,
        sizeof(kFreezeParameters) / sizeof(kFreezeParameters[0]), true, true, 45},
    {kWarpId, "WARP (experimental clean-room granular FDN8)", kWarpParameters,
        sizeof(kWarpParameters) / sizeof(kWarpParameters[0]), true, true, 42},
    {kTapeEchoId, "TAPE ECHO", kTapeEchoParameters,
        sizeof(kTapeEchoParameters) / sizeof(kTapeEchoParameters[0])},
    {kReverseDelayId, "REVERSE DELAY", kReverseDelayParameters,
        sizeof(kReverseDelayParameters) / sizeof(kReverseDelayParameters[0]), true, true, 38},
    {kReverseReverbId, "REVERSE REVERB (clean-room segmented diffuse tail)", kReverseReverbParameters,
        sizeof(kReverseReverbParameters) / sizeof(kReverseReverbParameters[0]), true, true, 49},
    {kFractionalDelayId, "Fractional delay", kFractionalDelayParameters,
        sizeof(kFractionalDelayParameters) / sizeof(kFractionalDelayParameters[0])},
    {kModDelayId, "MOD DELAY", kModDelayParameters,
        sizeof(kModDelayParameters) / sizeof(kModDelayParameters[0]), true, true, 39},
    {kPanningDelayId, "PANNING DELAY", kPanningDelayParameters,
        sizeof(kPanningDelayParameters) / sizeof(kPanningDelayParameters[0]), true, true, 37},
    {kTwistId, "TWIST", kTwistParameters,
        sizeof(kTwistParameters) / sizeof(kTwistParameters[0]), true, true, 43},
    {kGranularDelayId, "GRANULAR DELAY", kGranularDelayParameters,
        sizeof(kGranularDelayParameters) / sizeof(kGranularDelayParameters[0]), true, true, 41},
    {kAutoPanId, "AUTO PAN", kAutoPanParameters,
        sizeof(kAutoPanParameters) / sizeof(kAutoPanParameters[0])},
    {kManualPanId, "MANUAL PAN", kManualPanParameters,
        sizeof(kManualPanParameters) / sizeof(kManualPanParameters[0]), false, true, 30},
    {kChorusId, "Chorus", kChorusParameters,
        sizeof(kChorusParameters) / sizeof(kChorusParameters[0])},
    {kTremoloId, "Tremolo", kTremoloParameters,
        sizeof(kTremoloParameters) / sizeof(kTremoloParameters[0])},
    {kRingModId, "Ring modulator", kRingModParameters,
        sizeof(kRingModParameters) / sizeof(kRingModParameters[0])},
    {kEqualizerId, "EQ", kEqualizerParameters,
        sizeof(kEqualizerParameters) / sizeof(kEqualizerParameters[0])},
    {"isolator", "ISOLATOR", kIsolatorParameters,
        sizeof(kIsolatorParameters) / sizeof(kIsolatorParameters[0]), true, true, 27},
    {kStereoEnhanceId, "STEREO ENHANCE", kStereoEnhanceParameters,
        sizeof(kStereoEnhanceParameters) / sizeof(kStereoEnhanceParameters[0])},
    {kLoFiId, "LO-FI", kLoFiParameters,
        sizeof(kLoFiParameters) / sizeof(kLoFiParameters[0])},
    {kRadioId, "RADIO", kRadioParameters,
        sizeof(kRadioParameters) / sizeof(kRadioParameters[0]), true, true, 8},
    {kSustainerId, "SUSTAINER", kSustainerParameters,
        sizeof(kSustainerParameters) / sizeof(kSustainerParameters[0]), true, true, 11},
    {kVibratoId, "VIBRATO", kVibratoParameters,
        sizeof(kVibratoParameters) / sizeof(kVibratoParameters[0]), true, true, 33},
    {kSlowGearId, "SLOW GEAR", kSlowGearParameters,
        sizeof(kSlowGearParameters) / sizeof(kSlowGearParameters[0]), true, true, 13},
    {kPatternSlicerId, "PATTERN SLICER", kPatternSlicerParameters,
        sizeof(kPatternSlicerParameters) / sizeof(kPatternSlicerParameters[0]), true, true, 34},
    {kStepSlicerId, "STEP SLICER", kStepSlicerParameters,
        sizeof(kStepSlicerParameters) / sizeof(kStepSlicerParameters[0]), true, true, 35},
    {kVinylFlickId, "VINYL FLICK", kVinylFlickParameters,
        sizeof(kVinylFlickParameters) / sizeof(kVinylFlickParameters[0]), false, true, 53},
    {kPreampId, "PREAMP", kPreampParameters,
        sizeof(kPreampParameters) / sizeof(kPreampParameters[0]), true, true, 23},
    {kSynthId, "SYNTH", kSynthParameters,
        sizeof(kSynthParameters) / sizeof(kSynthParameters[0]), true, true, 6},
    {kG2BId, "G2B (experimental clean-room)", kG2BParameters,
        sizeof(kG2BParameters) / sizeof(kG2BParameters[0]), true, true, 10},
    {kTransposeId, "TRANSPOSE", kTransposeParameters,
        sizeof(kTransposeParameters) / sizeof(kTransposeParameters[0]), true, true, 14},
    {kPitchBendId, "PITCH BEND", kPitchBendParameters,
        sizeof(kPitchBendParameters) / sizeof(kPitchBendParameters[0]), true, true, 15},
    {kManualHarmonistId, "HRM MANUAL", kManualHarmonistParameters,
        sizeof(kManualHarmonistParameters) / sizeof(kManualHarmonistParameters[0]), true, true, 18},
    {kOctaveId, "OCTAVE", kOctaveParameters,
        sizeof(kOctaveParameters) / sizeof(kOctaveParameters[0]), true, true, 28},
    {kVocoderId, "VOCODER (clean-room filterbank)", kVocoderParameters,
        sizeof(kVocoderParameters) / sizeof(kVocoderParameters[0]), true, true, 20},
    {kOscVocMId, "OSC VOC (M) (clean-room MIDI vocoder)", kOscVocMParameters,
        sizeof(kOscVocMParameters) / sizeof(kOscVocMParameters[0]), true, true, 21},
    {kOscBotId, "OSC BOT (clean-room perceptual reconstruction)", kOscBotParameters,
        sizeof(kOscBotParameters) / sizeof(kOscBotParameters[0]), true, true, 22},
    {kAutoRiffId, "AUTO RIFF (experimental clean-room Signalsmith)", kAutoRiffParameters,
        sizeof(kAutoRiffParameters) / sizeof(kAutoRiffParameters[0]), true, true, 12},
    {kHrmAutoMId, "HRM AUTO (M) (clean-room MIDI harmonizer)", kHrmAutoMParameters,
        sizeof(kHrmAutoMParameters) / sizeof(kHrmAutoMParameters[0]), true, true, 19},
    {kRobotId, "ROBOT (experimental clean-room Signalsmith)", kRobotParameters,
        sizeof(kRobotParameters) / sizeof(kRobotParameters[0]), true, true, 16},
    {kElectricId, "ELECTRIC (clean-room voice character)", kElectricParameters,
        sizeof(kElectricParameters) / sizeof(kElectricParameters[0]), true, true, 17},
};

enum class FilterOutput : std::uint8_t { LowPass, BandPass, HighPass };

class NativeFilterProcessor final : public NativeEffectProcessor {
public:
    NativeFilterProcessor(const NativeEffectDescriptor& descriptor, FilterOutput output) noexcept
        : NativeEffectProcessor(descriptor), output_(output) {}

private:
    static constexpr std::uint64_t kCoefficientUpdateInterval = 8U;
    std::array<dsp::TptStateVariableFilter, 2U> filters_{};
    dsp::ParameterSmoother cutoffHz_{1000.0f};
    dsp::ParameterSmoother q_{0.70710678f};
    FilterOutput output_{};
    std::uint64_t processedFrames_ = 0U;

    [[nodiscard]] bool configure(float cutoffHz, float q) noexcept {
        if (sampleRate() == 0U) return false;
        const double boundedCutoff = std::clamp(
            static_cast<double>(cutoffHz),
            5.0,
            static_cast<double>(sampleRate()) * 0.45
        );
        bool okay = true;
        for (auto& filter : filters_) {
            okay = filter.setParameters(static_cast<double>(sampleRate()), boundedCutoff,
                                        static_cast<double>(q)) && okay;
        }
        return okay;
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        for (auto& filter : filters_) filter.reset();
        cutoffHz_.reset(cutoffHz_.target());
        q_.reset(q_.target());
        processedFrames_ = 0U;
        return configure(cutoffHz_.target(), q_.target());
    }

    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value, std::uint64_t rampFrames) noexcept override {
        if (parameterId == "cutoff_hz") {
            cutoffHz_.setTarget(value, rampFrames);
            if (!cutoffHz_.isSmoothing()) return configure(value, q_.target());
            return true;
        }
        if (parameterId == "q") {
            q_.setTarget(value, rampFrames);
            if (!q_.isSmoothing()) return configure(cutoffHz_.target(), value);
            return true;
        }
        return false;
    }

    void onResetState() noexcept override {
        for (auto& filter : filters_) filter.reset();
        cutoffHz_.reset(cutoffHz_.target());
        q_.reset(q_.target());
        processedFrames_ = 0U;
        (void)configure(cutoffHz_.target(), q_.target());
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const float cutoff = cutoffHz_.next();
        const float q = q_.next();
        // Parameter ramps stay sample-accurate; only the comparatively
        // expensive coefficient design is quantized to an absolute per-effect
        // 8-frame cadence so callback block boundaries cannot change it.
        if ((processedFrames_ % kCoefficientUpdateInterval) == 0U) {
            (void)configure(cutoff, q);
        }
        ++processedFrames_;
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < count; ++channel) {
            const auto result = filters_[channel].process(frame[channel]);
            switch (output_) {
            case FilterOutput::LowPass: frame[channel] = result.lowPass; break;
            case FilterOutput::BandPass: frame[channel] = result.bandPass; break;
            case FilterOutput::HighPass: frame[channel] = result.highPass; break;
            }
        }
    }
};

// Clean-room LO-FI processor: capture at a lower effective sample rate,
// quantize captured samples with deterministic TPDF dither, then apply a
// first-order post-filter. All state is fixed-size and preconstructed.
class NativeCatalogLoFi final : public NativeEffectProcessor {
public:
    explicit NativeCatalogLoFi(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::uint64_t kFilterCoefficientUpdateInterval = 16U;
    static constexpr double kRngUnit = 1.0 / 4294967296.0;
    dsp::ParameterSmoother bitDepth_{12.0f};
    dsp::ParameterSmoother sampleRateHz_{12000.0f};
    dsp::ParameterSmoother filterHz_{12000.0f};
    dsp::ParameterSmoother mixPercent_{70.0f};
    std::array<dsp::DeterministicRng, 2U> random_{{
        dsp::DeterministicRng{0x9e3779b97f4a7c15ULL},
        dsp::DeterministicRng{0xd1b54a32d192ed03ULL},
    }};
    std::array<float, 2U> heldSamples_{};
    std::array<float, 2U> filterState_{};
    double holdPhase_ = 0.0;
    float filterAlpha_ = 1.0f;
    std::uint64_t processedFrames_ = 0U;
    bool hasHeldSample_ = false;

    void resetRandom() noexcept {
        random_[0].seed(0x9e3779b97f4a7c15ULL);
        random_[1].seed(0xd1b54a32d192ed03ULL);
    }

    [[nodiscard]] float quantize(float input, unsigned int channel, float bits) noexcept {
        const double scale = std::exp2(static_cast<double>(bits - 1.0f));
        const double first = static_cast<double>(random_[channel].nextUInt32()) * kRngUnit;
        const double second = static_cast<double>(random_[channel].nextUInt32()) * kRngUnit;
        const double dither = first - second;
        const double scaled = std::clamp(static_cast<double>(input), -1.0, 1.0) * scale + dither;
        return static_cast<float>(std::clamp(std::round(scaled) / scale, -1.0, 1.0));
    }

    void updateFilterCoefficient(float cutoffHz) noexcept {
        if (sampleRate() == 0U) return;
        const double bounded = std::clamp(
            static_cast<double>(cutoffHz), 20.0, static_cast<double>(sampleRate()) * 0.45
        );
        filterAlpha_ = static_cast<float>(1.0 - std::exp(-kTwoPi * bounded / static_cast<double>(sampleRate())));
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        bitDepth_.reset(bitDepth_.target());
        sampleRateHz_.reset(sampleRateHz_.target());
        filterHz_.reset(filterHz_.target());
        mixPercent_.reset(mixPercent_.target());
        heldSamples_.fill(0.0f);
        filterState_.fill(0.0f);
        holdPhase_ = 0.0;
        processedFrames_ = 0U;
        hasHeldSample_ = false;
        resetRandom();
        updateFilterCoefficient(filterHz_.target());
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId, float value, std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "bit_depth") bitDepth_.setTarget(value, rampFrames);
        else if (parameterId == "sample_rate_hz") sampleRateHz_.setTarget(value, rampFrames);
        else if (parameterId == "filter_hz") filterHz_.setTarget(value, rampFrames);
        else if (parameterId == "mix_percent") mixPercent_.setTarget(value, rampFrames);
        else return false;
        return true;
    }

    void onResetState() noexcept override {
        bitDepth_.reset(bitDepth_.target());
        sampleRateHz_.reset(sampleRateHz_.target());
        filterHz_.reset(filterHz_.target());
        mixPercent_.reset(mixPercent_.target());
        heldSamples_.fill(0.0f);
        filterState_.fill(0.0f);
        holdPhase_ = 0.0;
        processedFrames_ = 0U;
        hasHeldSample_ = false;
        resetRandom();
        updateFilterCoefficient(filterHz_.target());
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const float bits = std::clamp(std::round(bitDepth_.next()), 4.0f, 24.0f);
        const float targetRate = std::clamp(sampleRateHz_.next(), 500.0f, static_cast<float>(sampleRate()));
        const float cutoff = filterHz_.next();
        const auto gains = dsp::equalPowerCrossfadeGains(std::clamp(mixPercent_.next() / 100.0f, 0.0f, 1.0f));
        if ((processedFrames_ % kFilterCoefficientUpdateInterval) == 0U) updateFilterCoefficient(cutoff);
        ++processedFrames_;

        const unsigned int count = std::min<unsigned int>(channels, 2U);
        bool capture = !hasHeldSample_;
        if (!capture) {
            holdPhase_ += static_cast<double>(targetRate) / static_cast<double>(sampleRate());
            if (holdPhase_ >= 1.0) {
                holdPhase_ -= std::floor(holdPhase_);
                capture = true;
            }
        }

        if (capture) {
            for (unsigned int channel = 0U; channel < count; ++channel) {
                const float input = std::isfinite(frame[channel]) ? frame[channel] : 0.0f;
                heldSamples_[channel] = quantize(input, channel, bits);
            }
            hasHeldSample_ = true;
        }

        for (unsigned int channel = 0U; channel < count; ++channel) {
            const float dry = std::isfinite(frame[channel]) ? frame[channel] : 0.0f;
            filterState_[channel] += filterAlpha_ * (heldSamples_[channel] - filterState_[channel]);
            frame[channel] = dry * gains.first + filterState_[channel] * gains.second;
        }
    }
};

class NativeCatalogPhaser final : public NativeEffectProcessor {
public:
    explicit NativeCatalogPhaser(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativePhaserProcessor phaser_{};
    PhaserProcessorConfig config_{true, 8U, 0.5f, 0.65f, 0.0f, 0.5f};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return phaser_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return phaser_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value, std::uint64_t rampFrames) noexcept override {
        if (parameterId == "stages") {
            if (value != 4.0f && value != 8.0f && value != 12.0f) return false;
            config_.stages = static_cast<unsigned int>(value);
        } else if (parameterId == "rate_hz") {
            config_.rateHz = value;
        } else if (parameterId == "depth") {
            config_.depth = value;
        } else if (parameterId == "feedback") {
            config_.feedback = value;
        } else if (parameterId == "wet_mix") {
            config_.wetMix = value;
        } else {
            return false;
        }
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        if (sampleRate() != 0U) {
            (void)phaser_.prepare(sampleRate());
            (void)apply(0U);
        }
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)phaser_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogFlanger final : public NativeEffectProcessor {
public:
    explicit NativeCatalogFlanger(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        config_.enabled = true;
    }

private:
    NativeFlangerProcessor flanger_{};
    NativeFlangerProcessorConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return flanger_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return flanger_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "delay_ms") {
            config_.delayMs = value;
        } else if (parameterId == "rate_hz") {
            config_.rateHz = value;
        } else if (parameterId == "depth") {
            config_.depth = value;
        } else if (parameterId == "feedback") {
            config_.feedback = value;
        } else if (parameterId == "wet_mix") {
            config_.wetMix = value;
        } else {
            return false;
        }
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        flanger_.reset();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)flanger_.processInPlace(frame, 1U, channels);
    }
};

// Two-voice, stereo fractional-delay vibrato. The circular buffers have a
// fixed 8,192-frame capacity (up to 15 ms at 384 kHz) and are fully initialized
// during prepare/reset; the audio callback only reads/writes that storage.
class NativeCatalogVibrato final : public NativeEffectProcessor {
public:
    explicit NativeCatalogVibrato(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::size_t kDelayBufferFrames = 8192U;
    static constexpr std::size_t kDelayBufferMask = kDelayBufferFrames - 1U;
    static constexpr double kMinimumCausalDelayFrames = 2.0;
    static constexpr double kDepthSpan = 0.5;
    std::array<std::array<float, kDelayBufferFrames>, 2U> delayBuffer_{};
    dsp::ParameterSmoother rateHz_{5.0f};
    dsp::ParameterSmoother depthPercent_{35.0f};
    dsp::ParameterSmoother delayMs_{2.0f};
    dsp::ParameterSmoother mixPercent_{100.0f};
    std::size_t writeIndex_ = 0U;
    double phase_ = 0.0;

    [[nodiscard]] static std::size_t wrapIndex(std::int64_t index) noexcept {
        // Buffer capacity is a power of two, so the unsigned low bits provide
        // defined wraparound for negative history indices as well.
        return static_cast<std::size_t>(index) & kDelayBufferMask;
    }

    [[nodiscard]] float readFractional(unsigned int channel, double delayFrames) const noexcept {
        const double readPosition = static_cast<double>(writeIndex_) - delayFrames;
        const auto baseIndex = static_cast<std::int64_t>(std::floor(readPosition));
        const double t = readPosition - static_cast<double>(baseIndex);
        const double tPlusOne = t + 1.0;
        const double tMinusOne = t - 1.0;
        const double tMinusTwo = t - 2.0;
        const double weightMinusOne = -(t * tMinusOne * tMinusTwo) / 6.0;
        const double weightZero = (tPlusOne * tMinusOne * tMinusTwo) * 0.5;
        const double weightPlusOne = -(tPlusOne * t * tMinusTwo) * 0.5;
        const double weightPlusTwo = (tPlusOne * t * tMinusOne) / 6.0;
        const auto& buffer = delayBuffer_[channel];
        const double value =
            (static_cast<double>(buffer[wrapIndex(baseIndex - 1)]) * weightMinusOne) +
            (static_cast<double>(buffer[wrapIndex(baseIndex)]) * weightZero) +
            (static_cast<double>(buffer[wrapIndex(baseIndex + 1)]) * weightPlusOne) +
            (static_cast<double>(buffer[wrapIndex(baseIndex + 2)]) * weightPlusTwo);
        return static_cast<float>(value);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        if (sampleRate() > 384000U) return false;
        for (auto& channel : delayBuffer_) channel.fill(0.0f);
        rateHz_.reset(rateHz_.target());
        depthPercent_.reset(depthPercent_.target());
        delayMs_.reset(delayMs_.target());
        mixPercent_.reset(mixPercent_.target());
        writeIndex_ = 0U;
        phase_ = 0.0;
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "rate_hz") {
            rateHz_.setTarget(value, rampFrames);
        } else if (parameterId == "depth") {
            depthPercent_.setTarget(value, rampFrames);
        } else if (parameterId == "delay_ms") {
            delayMs_.setTarget(value, rampFrames);
        } else if (parameterId == "mix_percent") {
            mixPercent_.setTarget(value, rampFrames);
        } else {
            return false;
        }
        return true;
    }

    void onResetState() noexcept override {
        for (auto& channel : delayBuffer_) channel.fill(0.0f);
        rateHz_.reset(rateHz_.target());
        depthPercent_.reset(depthPercent_.target());
        delayMs_.reset(delayMs_.target());
        mixPercent_.reset(mixPercent_.target());
        writeIndex_ = 0U;
        phase_ = 0.0;
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
        if (processedChannels == 0U) return;

        const float rate = rateHz_.next();
        const double depth = static_cast<double>(std::clamp(depthPercent_.next(), 0.0f, 100.0f)) * 0.01;
        const double baseDelay = static_cast<double>(delayMs_.next()) *
            static_cast<double>(sampleRate()) * 0.001;
        const double modulationSpan = baseDelay * kDepthSpan * depth;
        const double dryMix = 1.0 - (static_cast<double>(mixPercent_.next()) * 0.01);
        const double wetMix = 1.0 - dryMix;

        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            delayBuffer_[channel][writeIndex_] = frame[channel];
        }

        const double radians = phase_ * kTwoPi;
        const double sine = std::sin(radians);
        const double cosine = std::cos(radians);
        const std::array<std::array<double, 2U>, 2U> lfo{{
            {{sine, cosine}},
            {{cosine, -sine}},
        }};
        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            const double firstDelay = std::max(
                kMinimumCausalDelayFrames,
                baseDelay + (modulationSpan * lfo[channel][0])
            );
            const double secondDelay = std::max(
                kMinimumCausalDelayFrames,
                baseDelay + (modulationSpan * lfo[channel][1])
            );
            const double wet = (static_cast<double>(readFractional(channel, firstDelay)) +
                static_cast<double>(readFractional(channel, secondDelay))) * 0.5;
            frame[channel] = static_cast<float>((static_cast<double>(frame[channel]) * dryMix) + (wet * wetMix));
        }

        phase_ += static_cast<double>(rate) / static_cast<double>(sampleRate());
        if (phase_ >= 1.0) phase_ -= std::floor(phase_);
        writeIndex_ = (writeIndex_ + 1U) & kDelayBufferMask;
    }
};

class NativeCatalogDynamics final : public NativeEffectProcessor {
public:
    explicit NativeCatalogDynamics(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::uint64_t kControlUpdateInterval = 16U;
    NativeDynamicsProcessor processor_{};
    NativeDynamicsConfig targetConfig_{};
    NativeDynamicsConfig appliedConfig_{};
    dsp::ParameterSmoother thresholdDb_{-18.0f};
    dsp::ParameterSmoother ratio_{4.0f};
    dsp::ParameterSmoother kneeDb_{6.0f};
    dsp::ParameterSmoother attackMs_{10.0f};
    dsp::ParameterSmoother releaseMs_{120.0f};
    dsp::ParameterSmoother outputGainDb_{0.0f};
    std::uint64_t processedFrames_ = 0U;

    void resetSmoothers() noexcept {
        thresholdDb_.reset(targetConfig_.thresholdDb);
        ratio_.reset(targetConfig_.ratio);
        kneeDb_.reset(targetConfig_.kneeDb);
        attackMs_.reset(targetConfig_.attackMs);
        releaseMs_.reset(targetConfig_.releaseMs);
        outputGainDb_.reset(targetConfig_.outputGainDb);
        appliedConfig_ = targetConfig_;
        processedFrames_ = 0U;
    }

    void updateSmoothedConfig() noexcept {
        appliedConfig_.thresholdDb = thresholdDb_.next();
        appliedConfig_.ratio = ratio_.next();
        appliedConfig_.kneeDb = kneeDb_.next();
        appliedConfig_.attackMs = attackMs_.next();
        appliedConfig_.releaseMs = releaseMs_.next();
        appliedConfig_.outputGainDb = outputGainDb_.next();
        if ((processedFrames_ % kControlUpdateInterval) == 0U) {
            (void)processor_.setConfig(appliedConfig_);
        }
        ++processedFrames_;
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        if (!processor_.prepare(sampleRate())) return false;
        resetSmoothers();
        return processor_.setConfig(appliedConfig_);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "threshold_db") {
            targetConfig_.thresholdDb = value;
            thresholdDb_.setTarget(value, rampFrames);
        } else if (parameterId == "ratio") {
            targetConfig_.ratio = value;
            ratio_.setTarget(value, rampFrames);
        } else if (parameterId == "knee_db") {
            targetConfig_.kneeDb = value;
            kneeDb_.setTarget(value, rampFrames);
        } else if (parameterId == "attack_ms") {
            targetConfig_.attackMs = value;
            attackMs_.setTarget(value, rampFrames);
        } else if (parameterId == "release_ms") {
            targetConfig_.releaseMs = value;
            releaseMs_.setTarget(value, rampFrames);
        } else if (parameterId == "output_gain_db") {
            targetConfig_.outputGainDb = value;
            outputGainDb_.setTarget(value, rampFrames);
        } else if (parameterId == "detector") {
            targetConfig_.detector = value == 0.0f ? NativeDynamicsDetector::Peak : NativeDynamicsDetector::Rms;
            appliedConfig_.detector = targetConfig_.detector;
            (void)processor_.setConfig(appliedConfig_);
        } else {
            return false;
        }
        return true;
    }

    void onResetState() noexcept override {
        processor_.reset();
        resetSmoothers();
        (void)processor_.setConfig(appliedConfig_);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        updateSmoothedConfig();
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogDistortion final : public NativeEffectProcessor {
public:
    explicit NativeCatalogDistortion(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativeDistortionProcessor processor_{};
    NativeDistortionConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return processor_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "drive_db") config_.driveDb = value;
        else if (parameterId == "mix_percent") config_.mixPercent = value;
        else return false;
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogPreamp final : public NativeEffectProcessor {
public:
    explicit NativeCatalogPreamp(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativePreampProcessor processor_{};
    NativePreampConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return processor_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "model") config_.model = value;
        else if (parameterId == "gain") config_.gainPercent = value;
        else if (parameterId == "bass") config_.bassDb = value;
        else if (parameterId == "middle") config_.middleDb = value;
        else if (parameterId == "treble") config_.trebleDb = value;
        else if (parameterId == "level") config_.levelDb = value;
        else return false;
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

// Clean-room RADIO coloration. Band selection uses stereo RBJ HP/LP biquads;
// saturation is delegated to the already-tested 4x FIR oversampling core.
// Its 24-frame fixed latency is matched by fixed dry/noise/envelope delay
// storage here, so the native effect-mix control remains phase aligned.
class NativeCatalogRadio final : public NativeEffectProcessor {
public:
    explicit NativeCatalogRadio(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr unsigned int kSaturationLatencyFrames = 24U;
    static constexpr std::uint64_t kCoefficientUpdateInterval = 8U;
    static constexpr std::array<float, 3U> kBandHighPassHz{{420.0f, 180.0f, 45.0f}};
    static constexpr std::array<float, 3U> kBandLowPassHz{{3200.0f, 5200.0f, 14500.0f}};
    static constexpr std::array<std::uint64_t, 2U> kRandomSeeds{{0x52414431ULL, 0x52414432ULL}};

    NativeDistortionProcessor saturation_{};
    NativeDistortionConfig saturationConfig_{0.0f, 100.0f};
    std::array<dsp::Biquad, 2U> highPass_{};
    std::array<dsp::Biquad, 2U> lowPass_{};
    dsp::ParameterSmoother highPassHz_{420.0f};
    dsp::ParameterSmoother lowPassHz_{3200.0f};
    dsp::ParameterSmoother noisePercent_{8.0f};
    dsp::ParameterSmoother mixPercent_{70.0f};
    float drivePercentTarget_ = 35.0f;
    std::array<dsp::DeterministicRng, 2U> random_{{
        dsp::DeterministicRng{kRandomSeeds[0]}, dsp::DeterministicRng{kRandomSeeds[1]}
    }};
    std::array<std::array<float, kSaturationLatencyFrames>, 2U> dryDelay_{};
    std::array<std::array<float, kSaturationLatencyFrames>, 2U> noiseDelay_{};
    std::array<std::array<float, kSaturationLatencyFrames>, 2U> dropoutDelay_{};
    std::array<float, 2U> coloredNoise_{};
    std::array<float, 2U> dropoutEnvelope_{{1.0f, 1.0f}};
    std::array<unsigned int, 2U> dropoutRemaining_{};
    unsigned int delayWrite_ = 0U;
    float noiseAlpha_ = 0.0f;
    float dropoutAttackAlpha_ = 0.0f;
    float dropoutReleaseAlpha_ = 0.0f;
    std::uint64_t processedFrames_ = 0U;

    [[nodiscard]] static float driveDbForPercent(float percent) noexcept {
        // Match Browser RADIO's 1..12 linear drive-gain range.
        const double gain = 1.0 + 11.0 * static_cast<double>(percent) * 0.01;
        return static_cast<float>(20.0 * std::log10(gain));
    }

    [[nodiscard]] bool configureFilters(float highPassHz, float lowPassHz) noexcept {
        if (sampleRate() == 0U) return false;
        const double rate = static_cast<double>(sampleRate());
        const double maximumCutoff = rate * 0.45;
        const double hp = std::clamp(static_cast<double>(highPassHz), 5.0, maximumCutoff);
        const double lp = std::clamp(static_cast<double>(lowPassHz), 5.0, maximumCutoff);
        dsp::Biquad hpDesigner;
        dsp::Biquad lpDesigner;
        if (!hpDesigner.setParameters(dsp::BiquadType::HighPass, rate, hp, 0.7071067811865476) ||
            !lpDesigner.setParameters(dsp::BiquadType::LowPass, rate, lp, 0.7071067811865476)) {
            return false;
        }
        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            if (!highPass_[channel].setCoefficients(hpDesigner.coefficients()) ||
                !lowPass_[channel].setCoefficients(lpDesigner.coefficients())) {
                return false;
            }
        }
        return true;
    }

    void resetRandom() noexcept {
        random_[0].seed(kRandomSeeds[0]);
        random_[1].seed(kRandomSeeds[1]);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        for (auto& filter : highPass_) filter.reset();
        for (auto& filter : lowPass_) filter.reset();
        highPassHz_.reset(highPassHz_.target());
        lowPassHz_.reset(lowPassHz_.target());
        noisePercent_.reset(noisePercent_.target());
        mixPercent_.reset(mixPercent_.target());
        saturationConfig_ = {driveDbForPercent(drivePercentTarget_), 100.0f};
        if (!saturation_.prepare(sampleRate()) || !saturation_.setConfig(saturationConfig_, 0U)) return false;

        dryDelay_ = {};
        noiseDelay_ = {};
        for (auto& channelDelay : dropoutDelay_) channelDelay.fill(1.0f);
        coloredNoise_.fill(0.0f);
        dropoutEnvelope_.fill(1.0f);
        dropoutRemaining_.fill(0U);
        delayWrite_ = 0U;
        processedFrames_ = 0U;
        resetRandom();

        const double rate = static_cast<double>(sampleRate());
        noiseAlpha_ = static_cast<float>(1.0 - std::exp(-kTwoPi * 1900.0 / rate));
        dropoutAttackAlpha_ = static_cast<float>(1.0 - std::exp(-1.0 / (0.0005 * rate)));
        dropoutReleaseAlpha_ = static_cast<float>(1.0 - std::exp(-1.0 / (0.004 * rate)));
        return configureFilters(highPassHz_.target(), lowPassHz_.target());
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId, float value, std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "band") {
            const std::size_t band = static_cast<std::size_t>(value);
            highPassHz_.setTarget(kBandHighPassHz[band], rampFrames);
            lowPassHz_.setTarget(kBandLowPassHz[band], rampFrames);
            return true;
        }
        if (parameterId == "drive") {
            drivePercentTarget_ = value;
            saturationConfig_.driveDb = driveDbForPercent(value);
            return sampleRate() == 0U || saturation_.setConfig(saturationConfig_, rampFrames);
        }
        if (parameterId == "noise") {
            noisePercent_.setTarget(value, rampFrames);
            return true;
        }
        if (parameterId == "mix") {
            mixPercent_.setTarget(value, rampFrames);
            return true;
        }
        return false;
    }

    void onResetState() noexcept override {
        saturation_.reset();
        saturationConfig_.driveDb = driveDbForPercent(drivePercentTarget_);
        saturationConfig_.mixPercent = 100.0f;
        (void)saturation_.setConfig(saturationConfig_, 0U);
        highPassHz_.reset(highPassHz_.target());
        lowPassHz_.reset(lowPassHz_.target());
        noisePercent_.reset(noisePercent_.target());
        mixPercent_.reset(mixPercent_.target());
        for (auto& filter : highPass_) filter.reset();
        for (auto& filter : lowPass_) filter.reset();
        dryDelay_ = {};
        noiseDelay_ = {};
        for (auto& channelDelay : dropoutDelay_) channelDelay.fill(1.0f);
        coloredNoise_.fill(0.0f);
        dropoutEnvelope_.fill(1.0f);
        dropoutRemaining_.fill(0U);
        delayWrite_ = 0U;
        processedFrames_ = 0U;
        resetRandom();
        (void)configureFilters(highPassHz_.target(), lowPassHz_.target());
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        const float highPassHz = highPassHz_.next();
        const float lowPassHz = lowPassHz_.next();
        const float noise = noisePercent_.next() * 0.01f;
        const auto mixGains = dsp::equalPowerCrossfadeGains(mixPercent_.next() * 0.01f);
        if ((processedFrames_ % kCoefficientUpdateInterval) == 0U) {
            (void)configureFilters(highPassHz, lowPassHz);
        }
        ++processedFrames_;

        std::array<float, 2U> delayedDry{};
        std::array<float, 2U> delayedNoise{};
        std::array<float, 2U> delayedDropoutEnvelope{};
        for (unsigned int channel = 0U; channel < count; ++channel) {
            const float input = std::isfinite(frame[channel])
                ? std::clamp(frame[channel], -16.0f, 16.0f) : 0.0f;
            delayedDry[channel] = dryDelay_[channel][delayWrite_];
            dryDelay_[channel][delayWrite_] = input;

            const float bandLimited = lowPass_[channel].process(highPass_[channel].process(input));
            frame[channel] = std::isfinite(bandLimited) ? std::clamp(bandLimited, -16.0f, 16.0f) : 0.0f;

            if (dropoutRemaining_[channel] > 0U) {
                --dropoutRemaining_[channel];
            } else if (noise > 0.0f && random_[channel].nextUnitFloat() < noise * 0.000035f) {
                const float seconds = 0.008f + random_[channel].nextUnitFloat() * 0.017f;
                dropoutRemaining_[channel] = std::max(1U, static_cast<unsigned int>(
                    std::round(seconds * static_cast<float>(sampleRate()))));
            }

            const float dropoutTarget = dropoutRemaining_[channel] > 0U ? 0.0f : 1.0f;
            const float dropoutAlpha = dropoutTarget < dropoutEnvelope_[channel]
                ? dropoutAttackAlpha_ : dropoutReleaseAlpha_;
            dropoutEnvelope_[channel] += dropoutAlpha * (dropoutTarget - dropoutEnvelope_[channel]);
            if (dropoutEnvelope_[channel] < 1.0e-12f) dropoutEnvelope_[channel] = 0.0f;

            const float randomSample = random_[channel].nextBipolarFloat();
            coloredNoise_[channel] += noiseAlpha_ * (randomSample - coloredNoise_[channel]);
            const float currentNoise = coloredNoise_[channel] * noise * 0.006f;
            delayedNoise[channel] = noiseDelay_[channel][delayWrite_];
            noiseDelay_[channel][delayWrite_] = currentNoise;
            delayedDropoutEnvelope[channel] = dropoutDelay_[channel][delayWrite_];
            dropoutDelay_[channel][delayWrite_] = dropoutEnvelope_[channel];
        }

        // The 4x FIR path, including its polyphase anti-alias filtering, is
        // prepared above. No callback allocation or coefficient design occurs.
        (void)saturation_.processInPlace(frame, 1U, channels);
        for (unsigned int channel = 0U; channel < count; ++channel) {
            const float saturated = std::isfinite(frame[channel]) ? frame[channel] : 0.0f;
            const float wet = saturated * delayedDropoutEnvelope[channel] + delayedNoise[channel];
            frame[channel] = std::clamp(delayedDry[channel] * mixGains.first + wet * mixGains.second,
                                         -4.0f, 4.0f);
        }
        ++delayWrite_;
        if (delayWrite_ == kSaturationLatencyFrames) delayWrite_ = 0U;
    }
};

// Clean-room SLOW GEAR. A linked pair of broadband and high-band energy
// followers forms a small, causal spectral-flux/onset score. There is no
// lookahead buffer or fixed pipeline delay: the first detected frame begins
// a raised-cosine gain ramp from a deliberately attenuated level to unity.
// This is a functional reconstruction and does not claim device fidelity.
class NativeCatalogSlowGear final : public NativeEffectProcessor {
public:
    explicit NativeCatalogSlowGear(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr double kTwoPi = 6.28318530717958647692;
    static constexpr double kEnergyFloor = 1.0e-5;
    static constexpr float kInitialGain = 0.12f;
    static constexpr double kLowPassHz = 1400.0;
    static constexpr double kFastTimeSeconds = 0.003;
    static constexpr double kSlowTimeSeconds = 0.080;

    std::array<dsp::ParameterSmoother, 3U> controls_{{
        dsp::ParameterSmoother{250.0f}, // attack_ms
        dsp::ParameterSmoother{50.0f},  // sensitivity_percent
        dsp::ParameterSmoother{100.0f}, // mix_percent
    }};
    std::array<double, 2U> lowPassState_{};
    double fastEnergy_ = 0.0;
    double slowEnergy_ = 0.0;
    double fastHighEnergy_ = 0.0;
    double slowHighEnergy_ = 0.0;
    double lowPassCoefficient_ = 0.0;
    double fastCoefficient_ = 0.0;
    double slowCoefficient_ = 0.0;
    std::uint64_t quietFrames_ = 0U;
    std::uint64_t framesSinceOnset_ = 0U;
    std::uint64_t minimumRetriggerFrames_ = 1U;
    std::uint64_t rampPosition_ = 0U;
    std::uint64_t rampLength_ = 1U;
    bool onsetArmed_ = true;
    bool hasTriggered_ = false;
    bool rampActive_ = false;

    [[nodiscard]] static double onePoleCoefficient(double timeSeconds, unsigned int rate) noexcept {
        return 1.0 - std::exp(-1.0 / (timeSeconds * static_cast<double>(rate)));
    }

    void clearDetector() noexcept {
        lowPassState_.fill(0.0);
        fastEnergy_ = 0.0;
        slowEnergy_ = 0.0;
        fastHighEnergy_ = 0.0;
        slowHighEnergy_ = 0.0;
        quietFrames_ = 0U;
        framesSinceOnset_ = minimumRetriggerFrames_;
        rampPosition_ = 0U;
        rampLength_ = 1U;
        onsetArmed_ = true;
        hasTriggered_ = false;
        rampActive_ = false;
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        const unsigned int rate = sampleRate();
        lowPassCoefficient_ = 1.0 - std::exp(-kTwoPi * kLowPassHz / static_cast<double>(rate));
        fastCoefficient_ = onePoleCoefficient(kFastTimeSeconds, rate);
        slowCoefficient_ = onePoleCoefficient(kSlowTimeSeconds, rate);
        minimumRetriggerFrames_ = std::max<std::uint64_t>(1U, static_cast<std::uint64_t>(rate / 30U));
        for (auto& control : controls_) control.reset(control.target());
        clearDetector();
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "attack_ms") {
            controls_[0].setTarget(value, rampFrames);
        } else if (parameterId == "sensitivity_percent") {
            controls_[1].setTarget(value, rampFrames);
        } else if (parameterId == "mix_percent") {
            controls_[2].setTarget(value, rampFrames);
        } else {
            return false;
        }
        return true;
    }

    void onResetState() noexcept override {
        for (auto& control : controls_) control.reset(control.target());
        clearDetector();
    }

    void trigger(float attackMs) noexcept {
        const double samples = static_cast<double>(attackMs) * static_cast<double>(sampleRate()) / 1000.0;
        rampLength_ = std::max<std::uint64_t>(1U, static_cast<std::uint64_t>(std::llround(samples)));
        rampPosition_ = 0U;
        rampActive_ = true;
        onsetArmed_ = false;
        hasTriggered_ = true;
        framesSinceOnset_ = 0U;
    }

    [[nodiscard]] float nextEnvelopeGain() noexcept {
        if (!rampActive_) return 1.0f;
        const double position = static_cast<double>(rampPosition_ + 1U) / static_cast<double>(rampLength_);
        ++rampPosition_;
        if (position >= 1.0) {
            rampActive_ = false;
            return 1.0f;
        }
        const double shaped = 0.5 - 0.5 * std::cos(3.14159265358979323846 * position);
        return kInitialGain + (1.0f - kInitialGain) * static_cast<float>(shaped);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        if (count == 0U || sampleRate() == 0U) return;

        std::array<double, 2U> highBand{};
        double inputEnergy = 0.0;
        double highEnergy = 0.0;
        for (unsigned int channel = 0U; channel < count; ++channel) {
            const float raw = std::isfinite(frame[channel]) ? frame[channel] : 0.0f;
            const float sample = std::clamp(raw, -8.0f, 8.0f);
            frame[channel] = sample;
            const double value = static_cast<double>(sample);
            lowPassState_[channel] += lowPassCoefficient_ * (value - lowPassState_[channel]);
            highBand[channel] = value - lowPassState_[channel];
            inputEnergy += value * value;
            highEnergy += highBand[channel] * highBand[channel];
        }
        inputEnergy /= static_cast<double>(count);
        highEnergy /= static_cast<double>(count);

        fastEnergy_ += fastCoefficient_ * (inputEnergy - fastEnergy_);
        slowEnergy_ += slowCoefficient_ * (inputEnergy - slowEnergy_);
        fastHighEnergy_ += fastCoefficient_ * (highEnergy - fastHighEnergy_);
        slowHighEnergy_ += slowCoefficient_ * (highEnergy - slowHighEnergy_);

        if (inputEnergy <= kEnergyFloor) {
            if (quietFrames_ < minimumRetriggerFrames_) ++quietFrames_;
            if (quietFrames_ >= minimumRetriggerFrames_) {
                lowPassState_.fill(0.0);
                fastEnergy_ = 0.0;
                slowEnergy_ = 0.0;
                fastHighEnergy_ = 0.0;
                slowHighEnergy_ = 0.0;
                onsetArmed_ = true;
            }
        } else {
            quietFrames_ = 0U;
        }

        const float attackMs = controls_[0].next();
        const float sensitivity = controls_[1].next();
        const float mix = controls_[2].next() * 0.01f;
        const double normalization = std::max(kEnergyFloor, slowEnergy_ + 0.5 * slowHighEnergy_);
        const double broadbandRise = std::max(0.0, fastEnergy_ - slowEnergy_);
        const double spectralRise = std::max(0.0, fastHighEnergy_ - slowHighEnergy_);
        const double onsetScore = (broadbandRise + 0.65 * spectralRise) / normalization;
        const double threshold = 0.08 + (1.0 - static_cast<double>(sensitivity) * 0.01) * 1.42;

        if (onsetScore < threshold * 0.30) onsetArmed_ = true;
        const bool canRetrigger = !hasTriggered_ || framesSinceOnset_ >= minimumRetriggerFrames_;
        if (onsetArmed_ && canRetrigger && inputEnergy > kEnergyFloor && onsetScore >= threshold) {
            trigger(attackMs);
        }
        if (hasTriggered_ && framesSinceOnset_ < minimumRetriggerFrames_) ++framesSinceOnset_;

        const float envelopeGain = nextEnvelopeGain();
        const float wetGain = 1.0f + (envelopeGain - 1.0f) * mix;
        for (unsigned int channel = 0U; channel < count; ++channel) {
            frame[channel] *= wetGain;
        }
    }
};

// Clean-room SUSTAINER: linked upward/downward compression, a hysteretic
// noise gate, and a fixed-storage 1 ms lookahead peak limiter. This is kept
// distinct from Native DYNAMICS because the latter is downward-only and has
// no gate; SUSTAINER follows its own four-control catalog law.
class NativeCatalogSustainer final : public NativeEffectProcessor {
public:
    explicit NativeCatalogSustainer(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::size_t kMaximumLookaheadFrames = 192U;
    static constexpr std::size_t kDelayCapacity = kMaximumLookaheadFrames + 1U;
    static constexpr std::size_t kPeakDequeCapacity = kMaximumLookaheadFrames + 1U;
    static constexpr std::uint64_t kReleaseCoefficientUpdateInterval = 16U;
    static constexpr double kEnvelopeFloor = 1.0e-9;
    static constexpr float kLimiterCeiling = 0.9660508789898133f; // -0.3 dBFS

    std::array<dsp::ParameterSmoother, 4U> controls_{{
        dsp::ParameterSmoother{-24.0f}, // threshold dB
        dsp::ParameterSmoother{4.0f},   // ratio
        dsp::ParameterSmoother{180.0f}, // release ms
        dsp::ParameterSmoother{0.0f},   // output dB
    }};
    std::array<std::array<float, kDelayCapacity>, 2U> audioDelay_{};
    std::array<std::uint64_t, kPeakDequeCapacity> peakIndices_{};
    std::array<float, kPeakDequeCapacity> peakValues_{};
    std::size_t peakHead_ = 0U;
    std::size_t peakCount_ = 0U;
    std::size_t delayWrite_ = 0U;
    std::size_t lookaheadFrames_ = 48U;
    double compressorEnvelope_ = 0.0;
    double gateEnvelope_ = 0.0;
    float gateGain_ = 0.0f;
    float limiterGain_ = 1.0f;
    double compressorAttackCoefficient_ = 0.0;
    double compressorReleaseCoefficient_ = 0.0;
    double gateEnvelopeAttackCoefficient_ = 0.0;
    double gateEnvelopeReleaseCoefficient_ = 0.0;
    float gateOpenCoefficient_ = 0.0f;
    float gateCloseCoefficient_ = 0.0f;
    float limiterReleaseCoefficient_ = 0.0f;
    bool gateOpen_ = false;
    std::uint64_t processedFrames_ = 0U;

    [[nodiscard]] static double onePoleCoefficient(double timeMs, unsigned int rate) noexcept {
        return std::exp(-1.0 / (std::max(0.001, timeMs) * 0.001 * static_cast<double>(rate)));
    }

    [[nodiscard]] static float dbToLinear(float db) noexcept {
        return static_cast<float>(std::pow(10.0, static_cast<double>(db) / 20.0));
    }

    void updateReleaseCoefficient(float releaseMs) noexcept {
        compressorReleaseCoefficient_ = onePoleCoefficient(
            std::clamp(static_cast<double>(releaseMs), 10.0, 1000.0), sampleRate());
    }

    void clearLimiterState() noexcept {
        audioDelay_ = {};
        peakIndices_ = {};
        peakValues_ = {};
        peakHead_ = 0U;
        peakCount_ = 0U;
        delayWrite_ = 0U;
        limiterGain_ = 1.0f;
        processedFrames_ = 0U;
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        for (auto& control : controls_) control.reset(control.target());
        const unsigned int rate = sampleRate();
        lookaheadFrames_ = std::clamp<std::size_t>(rate / 1000U, 1U, kMaximumLookaheadFrames);
        compressorAttackCoefficient_ = onePoleCoefficient(2.0, rate);
        updateReleaseCoefficient(controls_[2U].target());
        gateEnvelopeAttackCoefficient_ = onePoleCoefficient(1.0, rate);
        gateEnvelopeReleaseCoefficient_ = onePoleCoefficient(60.0, rate);
        gateOpenCoefficient_ = static_cast<float>(onePoleCoefficient(1.0, rate));
        gateCloseCoefficient_ = static_cast<float>(onePoleCoefficient(60.0, rate));
        limiterReleaseCoefficient_ = static_cast<float>(onePoleCoefficient(50.0, rate));
        compressorEnvelope_ = 0.0;
        gateEnvelope_ = 0.0;
        gateGain_ = 0.0f;
        gateOpen_ = false;
        clearLimiterState();
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId, float value, std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "threshold_db") controls_[0U].setTarget(value, rampFrames);
        else if (parameterId == "ratio") controls_[1U].setTarget(value, rampFrames);
        else if (parameterId == "release_ms") controls_[2U].setTarget(value, rampFrames);
        else if (parameterId == "output_db") controls_[3U].setTarget(value, rampFrames);
        else return false;
        return true;
    }

    void onResetState() noexcept override {
        for (auto& control : controls_) control.reset(control.target());
        compressorEnvelope_ = 0.0;
        gateEnvelope_ = 0.0;
        gateGain_ = 0.0f;
        gateOpen_ = false;
        updateReleaseCoefficient(controls_[2U].target());
        clearLimiterState();
    }

    void updatePeakDeque(std::uint64_t frameIndex, float peak) noexcept {
        const std::uint64_t earliestFrame = frameIndex > lookaheadFrames_
            ? frameIndex - static_cast<std::uint64_t>(lookaheadFrames_) : 0U;
        while (peakCount_ > 0U && peakIndices_[peakHead_] < earliestFrame) {
            peakHead_ = (peakHead_ + 1U) % kPeakDequeCapacity;
            --peakCount_;
        }
        while (peakCount_ > 0U) {
            const std::size_t tail = (peakHead_ + peakCount_ - 1U) % kPeakDequeCapacity;
            if (peakValues_[tail] > peak) break;
            --peakCount_;
        }
        const std::size_t tail = (peakHead_ + peakCount_) % kPeakDequeCapacity;
        peakIndices_[tail] = frameIndex;
        peakValues_[tail] = peak;
        ++peakCount_;
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        const float thresholdDb = controls_[0U].next();
        const float ratio = std::max(1.0f, controls_[1U].next());
        const float releaseMs = controls_[2U].next();
        const float outputDb = controls_[3U].next();
        if ((processedFrames_ % kReleaseCoefficientUpdateInterval) == 0U) {
            updateReleaseCoefficient(releaseMs);
        }

        std::array<float, 2U> input{};
        for (unsigned int channel = 0U; channel < count; ++channel) {
            input[channel] = std::isfinite(frame[channel])
                ? std::clamp(frame[channel], -64.0f, 64.0f) : 0.0f;
        }
        const double linkedPeak = count == 2U
            ? std::max(std::fabs(static_cast<double>(input[0U])), std::fabs(static_cast<double>(input[1U])))
            : std::fabs(static_cast<double>(input[0U]));

        const double compressorCoefficient = linkedPeak > compressorEnvelope_
            ? compressorAttackCoefficient_ : compressorReleaseCoefficient_;
        compressorEnvelope_ = linkedPeak + compressorCoefficient * (compressorEnvelope_ - linkedPeak);
        const double gateEnvelopeCoefficient = linkedPeak > gateEnvelope_
            ? gateEnvelopeAttackCoefficient_ : gateEnvelopeReleaseCoefficient_;
        gateEnvelope_ = linkedPeak + gateEnvelopeCoefficient * (gateEnvelope_ - linkedPeak);

        const double gateDb = 20.0 * std::log10(std::max(kEnvelopeFloor, gateEnvelope_));
        if (gateOpen_) {
            if (gateDb <= static_cast<double>(thresholdDb) - 24.0) gateOpen_ = false;
        } else if (gateDb >= static_cast<double>(thresholdDb) - 18.0) {
            gateOpen_ = true;
        }
        const float gateTarget = gateOpen_ ? 1.0f : 0.0f;
        const float gateGainCoefficient = gateOpen_ ? gateOpenCoefficient_ : gateCloseCoefficient_;
        gateGain_ = gateTarget + gateGainCoefficient * (gateGain_ - gateTarget);

        const double envelopeDb = 20.0 * std::log10(std::max(kEnvelopeFloor, compressorEnvelope_));
        const double compressedDb = static_cast<double>(thresholdDb) +
            ((envelopeDb - static_cast<double>(thresholdDb)) / static_cast<double>(ratio));
        const double compressionGainDb = compressedDb - envelopeDb;
        const double gain = std::clamp(
            std::pow(10.0, compressionGainDb / 20.0) * static_cast<double>(gateGain_) *
                static_cast<double>(dbToLinear(outputDb)),
            0.0,
            64.0
        );

        std::array<float, 2U> preLimited{};
        float preLimitedPeak = 0.0f;
        for (unsigned int channel = 0U; channel < count; ++channel) {
            preLimited[channel] = static_cast<float>(std::clamp(
                static_cast<double>(input[channel]) * gain, -64.0, 64.0));
            preLimitedPeak = std::max(preLimitedPeak, std::fabs(preLimited[channel]));
        }

        updatePeakDeque(processedFrames_, preLimitedPeak);
        const float lookaheadPeak = peakCount_ == 0U ? 0.0f : peakValues_[peakHead_];
        const float limiterTarget = lookaheadPeak > kLimiterCeiling
            ? kLimiterCeiling / lookaheadPeak : 1.0f;
        if (limiterTarget < limiterGain_) limiterGain_ = limiterTarget;
        else limiterGain_ = limiterTarget + limiterReleaseCoefficient_ * (limiterGain_ - limiterTarget);

        for (unsigned int channel = 0U; channel < count; ++channel) {
            audioDelay_[channel][delayWrite_] = preLimited[channel];
            const std::size_t readIndex = (delayWrite_ + kDelayCapacity - lookaheadFrames_) % kDelayCapacity;
            const float delayed = processedFrames_ < lookaheadFrames_ ? 0.0f : audioDelay_[channel][readIndex];
            const float output = std::clamp(delayed * limiterGain_, -kLimiterCeiling, kLimiterCeiling);
            frame[channel] = std::isfinite(output) ? output : 0.0f;
        }

        ++delayWrite_;
        if (delayWrite_ == kDelayCapacity) delayWrite_ = 0U;
        ++processedFrames_;
    }
};

class NativeCatalogReverb final : public NativeEffectProcessor {
public:
    explicit NativeCatalogReverb(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        config_.enabled = true;
        config_.wetMix = 0.25f;
        config_.rt60Seconds = 2.5f;
        config_.dampingCutoffHz = 8000.0f;
    }

private:
    NativeFdn16ReverbProcessor processor_{};
    NativeFdn16ReverbConfig config_{true, 0.25f, 2.5f, 8000.0f};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return processor_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "decay_seconds") config_.rt60Seconds = value;
        else if (parameterId == "damping_cutoff_hz") config_.dampingCutoffHz = value;
        else if (parameterId == "wet_mix") config_.wetMix = value;
        else return false;
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        processor_.resetState();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

// Clean-room gated FDN reverb. The FDN runs continuously so its tail is ready
// when the sidechain opens; a stereo-linked input detector controls only the
// wet return. The sample-counted hold/release envelope is independent of host
// block sizes and keeps all callback state fixed-size.
class NativeCatalogGateReverb final : public NativeEffectProcessor {
public:
    explicit NativeCatalogGateReverb(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        reverbConfig_.enabled = true;
        reverbConfig_.wetMix = 1.0f;
        reverbConfig_.rt60Seconds = 2.5f;
        reverbConfig_.dampingCutoffHz = 8000.0f;
    }

private:
    static constexpr float kGateFloor = 1.0e-5f;
    static constexpr float kOutputLimit = 32.0f;
    static constexpr double kAttackMs = 1.0;

    NativeFdn16ReverbProcessor reverb_{};
    NativeFdn16ReverbConfig reverbConfig_{true, 1.0f, 2.5f, 8000.0f};
    dsp::ParameterSmoother wetMix_{0.35f};
    dsp::ParameterSmoother thresholdDb_{-24.0f};
    dsp::ParameterSmoother hysteresisDb_{6.0f};
    dsp::ParameterSmoother holdMs_{120.0f};
    dsp::ParameterSmoother releaseMs_{250.0f};
    std::uint64_t holdRemainingFrames_ = 0U;
    float gateGain_ = 0.0f;
    bool gateOpen_ = false;

    [[nodiscard]] bool applyReverb(std::uint64_t rampFrames) noexcept {
        return reverb_.setConfig(reverbConfig_, rampFrames);
    }

    void resetGate() noexcept {
        wetMix_.reset(wetMix_.target());
        thresholdDb_.reset(thresholdDb_.target());
        hysteresisDb_.reset(hysteresisDb_.target());
        holdMs_.reset(holdMs_.target());
        releaseMs_.reset(releaseMs_.target());
        holdRemainingFrames_ = 0U;
        gateGain_ = 0.0f;
        gateOpen_ = false;
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        if (!reverb_.prepare(sampleRate())) return false;
        resetGate();
        return applyReverb(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "decay_seconds") {
            reverbConfig_.rt60Seconds = value;
            return applyReverb(rampFrames);
        }
        if (parameterId == "damping_cutoff_hz") {
            reverbConfig_.dampingCutoffHz = value;
            return applyReverb(rampFrames);
        }
        if (parameterId == "wet_mix") wetMix_.setTarget(value, rampFrames);
        else if (parameterId == "threshold_db") thresholdDb_.setTarget(value, rampFrames);
        else if (parameterId == "hysteresis_db") hysteresisDb_.setTarget(value, rampFrames);
        else if (parameterId == "hold_ms") holdMs_.setTarget(value, rampFrames);
        else if (parameterId == "release_ms") releaseMs_.setTarget(value, rampFrames);
        else return false;
        return true;
    }

    void onResetState() noexcept override {
        reverb_.resetState();
        resetGate();
        (void)applyReverb(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        const float dryLeft = count > 0U && std::isfinite(frame[0]) ? frame[0] : 0.0f;
        const float dryRight = count > 1U && std::isfinite(frame[1]) ? frame[1] : 0.0f;
        const float detector = std::max(std::fabs(dryLeft), std::fabs(dryRight));
        const float thresholdDb = thresholdDb_.next();
        const float hysteresisDb = hysteresisDb_.next();
        const float holdMs = holdMs_.next();
        const float releaseMs = releaseMs_.next();
        const float wetMix = std::clamp(wetMix_.next(), 0.0f, 1.0f);

        const double openThreshold = std::pow(10.0, static_cast<double>(thresholdDb) / 20.0);
        const double closeThreshold = std::pow(
            10.0, static_cast<double>(thresholdDb - hysteresisDb) / 20.0);
        const auto holdFrames = static_cast<std::uint64_t>(std::max(
            0.0, std::floor(static_cast<double>(holdMs) * static_cast<double>(sampleRate()) / 1000.0 + 0.5)));
        if (!gateOpen_) {
            if (static_cast<double>(detector) >= openThreshold) {
                gateOpen_ = true;
                holdRemainingFrames_ = holdFrames;
            }
        } else if (static_cast<double>(detector) >= closeThreshold) {
            holdRemainingFrames_ = holdFrames;
        } else if (holdRemainingFrames_ > 0U) {
            --holdRemainingFrames_;
        } else {
            gateOpen_ = false;
        }

        if (gateOpen_) {
            const float attackFrames = std::max(
                1.0f, static_cast<float>(static_cast<double>(sampleRate()) * kAttackMs / 1000.0));
            gateGain_ += (1.0f - gateGain_) / attackFrames;
        } else {
            const double releaseFrames = std::max(
                1.0, static_cast<double>(releaseMs) * static_cast<double>(sampleRate()) / 1000.0);
            const float releaseCoefficient = static_cast<float>(1.0 - std::exp(-1.0 / releaseFrames));
            gateGain_ -= gateGain_ * releaseCoefficient;
            if (gateGain_ < kGateFloor) gateGain_ = 0.0f;
        }
        gateGain_ = std::clamp(gateGain_, 0.0f, 1.0f);

        if (count > 0U) frame[0] = dryLeft;
        if (count > 1U) frame[1] = dryRight;
        (void)reverb_.processInPlace(frame, 1U, channels);
        const float wetGain = wetMix * gateGain_;
        if (count > 0U) {
            const float mixed = dryLeft + (frame[0] * wetGain);
            frame[0] = std::isfinite(mixed) ? std::clamp(mixed, -kOutputLimit, kOutputLimit) : 0.0f;
        }
        if (count > 1U) {
            const float mixed = dryRight + (frame[1] * wetGain);
            frame[1] = std::isfinite(mixed) ? std::clamp(mixed, -kOutputLimit, kOutputLimit) : 0.0f;
        }
    }
};

class NativeCatalogBeatRepeat final : public NativeEffectProcessor {
public:
    explicit NativeCatalogBeatRepeat(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativeBeatRepeatProcessor processor_{};
    NativeBeatRepeatConfig config_{};

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && processor_.setConfig(config_, 0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "bpm") config_.bpm = value;
        else if (parameterId == "division") config_.division = value;
        else if (parameterId == "decay") config_.decay = value;
        else if (parameterId == "direction") config_.direction = static_cast<NativeBeatRepeatDirection>(static_cast<unsigned int>(value));
        else if (parameterId == "mix_percent") config_.wetMix = value / 100.0f;
        else return false;
        return processor_.setConfig(config_, rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)processor_.setConfig(config_, 0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogBeatScatter final : public NativeEffectProcessor {
public:
    explicit NativeCatalogBeatScatter(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativeBeatScatterProcessor processor_{};
    NativeBeatScatterConfig config_{};

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && processor_.setConfig(config_, 0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "bpm") config_.bpm = value;
        else if (parameterId == "slice_beats") config_.sliceBeats = value;
        else if (parameterId == "scatter_percent") config_.scatterPercent = value;
        else if (parameterId == "pitch_semitones") config_.pitchSemitones = value;
        else if (parameterId == "repeats") config_.repeats = static_cast<unsigned int>(std::lround(value));
        else if (parameterId == "mix_percent") config_.wetMix = value / 100.0f;
        else return false;
        return processor_.setConfig(config_, rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)processor_.setConfig(config_, 0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogRoll final : public NativeEffectProcessor {
public:
    explicit NativeCatalogRoll(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        config_.sliceBeats = 0.5f;
        config_.decayPercent = 20.0f;
        config_.wetMix = 0.5f;
    }

private:
    NativeRollProcessor processor_{};
    NativeRollConfig config_{};

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && processor_.setConfig(config_);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t
    ) noexcept override {
        if (parameterId == "bpm") config_.bpm = value;
        else if (parameterId == "slice_beats") config_.sliceBeats = value;
        else if (parameterId == "decay_percent") config_.decayPercent = value;
        else if (parameterId == "pitch_semitones") config_.pitchSemitones = value;
        else if (parameterId == "direction") {
            if (value != 0.0f && value != 1.0f && value != 2.0f) return false;
            config_.direction = static_cast<NativeRollDirection>(static_cast<std::uint8_t>(value));
        } else if (parameterId == "mix_percent") config_.wetMix = value / 100.0f;
        else return false;
        return processor_.setConfig(config_);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)processor_.setConfig(config_);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogFreeze final : public NativeEffectProcessor {
public:
    explicit NativeCatalogFreeze(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        config_.captureLengthMs = 250.0f;
        config_.mode = NativeFreezeMode::MicroLoop;
        config_.pitchSemitones = 0.0f;
        config_.wetMix = 0.5f;
        config_.frozen = false;
    }

private:
    NativeFreezeProcessor processor_{};
    NativeFreezeConfig config_{};
    bool freezePending_ = false;

    [[nodiscard]] bool applyConfig() noexcept {
        const auto result = processor_.setConfig(config_);
        if (result == NativeFreezeConfigResult::Accepted) {
            freezePending_ = false;
            return true;
        }
        if (result == NativeFreezeConfigResult::InsufficientCaptureHistory && config_.frozen) {
            // FREEZE is a momentary capture request represented by an explicit
            // parameter edge. If early, retain it and keep recording history
            // on the DSP thread until the selected window is available.
            freezePending_ = true;
            return true;
        }
        return false;
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        const bool requestedFreeze = config_.frozen;
        config_.mode = NativeFreezeMode::MicroLoop;
        config_.frozen = false;
        if (!processor_.prepare(sampleRate()) || !applyConfig()) return false;
        config_.frozen = requestedFreeze;
        freezePending_ = requestedFreeze;
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t
    ) noexcept override {
        if (parameterId == "capture_ms") {
            config_.captureLengthMs = value;
        } else if (parameterId == "mode") {
            if (value != 0.0f) return false;
            config_.mode = NativeFreezeMode::MicroLoop;
        } else if (parameterId == "pitch_semitones") {
            config_.pitchSemitones = value;
        } else if (parameterId == "freeze") {
            config_.frozen = value >= 0.5f;
        } else if (parameterId == "mix_percent") {
            config_.wetMix = value / 100.0f;
        } else {
            return false;
        }
        return applyConfig();
    }

    void onResetState() noexcept override {
        config_.frozen = false;
        freezePending_ = false;
        processor_.reset();
        (void)processor_.setConfig(config_);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        // NativeEffectProcessor calls this while bypassed too, then its outer
        // bypass mixer selects dry audio. Keeping this processor running here
        // preserves FREEZE pre-roll and loop phase without special core hooks.
        (void)processor_.processInPlace(frame, 1U, channels, false);
        if (!freezePending_) return;

        const auto state = processor_.status();
        if (state.validCaptureFrames >= state.requiredCaptureFrames && applyConfig()) {
            // The input frame that completed pre-roll remains live-through;
            // playback begins on the next frame.
            freezePending_ = false;
        }
    }
};

// Experimental lower-tier clean-room WARP. Two fixed stereo history banks
// support a tempo-sized freeze without callback copying; eight Hann-windowed
// grains resample the captured/live source, and an independent normalized
// Hadamard FDN8 supplies diffuse regeneration. Spectral mode is not exposed.
class NativeCatalogWarp final : public NativeEffectProcessor {
public:
    explicit NativeCatalogWarp(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::size_t kGrainCount = 8U;
    static constexpr std::size_t kWindowSize = 1024U;
    static constexpr float kMaximumState = 8.0f;
    static constexpr float kMaximumFeedback = 0.8f;
    static constexpr std::uint32_t kRandomSeed = 0x57415250U;
    static constexpr double kTwoPi = 6.28318530717958647692;
    static constexpr std::array<double, 8U> kFdnDelaySeconds{
        0.0297, 0.0371, 0.0411, 0.0533, 0.0617, 0.0719, 0.0797, 0.0893,
    };

    struct Grain {
        double position = 0.0;
        double step = 1.0;
        unsigned int age = 0U;
        unsigned int length = 0U;
    };

    std::array<std::array<std::vector<float>, 2U>, 2U> banks_{};
    std::array<std::vector<float>, 8U> fdnLines_{};
    std::array<unsigned int, 8U> fdnWrite_{};
    std::array<float, 8U> fdnDamping_{};
    std::array<float, 8U> fdnRead_{};
    std::array<float, 8U> fdnTransform_{};
    std::array<Grain, kGrainCount> grains_{};
    std::array<float, kWindowSize + 1U> window_{};
    dsp::ParameterSmoother bpm_{120.0f};
    dsp::ParameterSmoother captureBeats_{1.0f};
    dsp::ParameterSmoother smearPercent_{30.0f};
    dsp::ParameterSmoother pitchSemitones_{0.0f};
    dsp::ParameterSmoother feedbackPercent_{20.0f};
    float lastFdnLeft_ = 0.0f;
    float lastFdnRight_ = 0.0f;
    std::size_t capacityFrames_ = 0U;
    std::size_t writerPosition_ = 0U;
    std::size_t validFrames_ = 0U;
    std::size_t frozenStart_ = 0U;
    std::size_t frozenLength_ = 0U;
    std::size_t frameCounter_ = 0U;
    unsigned int writerBank_ = 0U;
    unsigned int frozenBank_ = 0U;
    std::size_t nextGrain_ = 0U;
    std::uint32_t randomState_ = kRandomSeed;
    double spawnPhase_ = 1.0;
    float dampingAlpha_ = 0.0f;
    bool hasFrozenBank_ = false;
    bool freezeRequested_ = false;
    bool freezePending_ = false;
    bool freezeActive_ = false;

    [[nodiscard]] static std::size_t wrapIndex(std::int64_t position, std::size_t length) noexcept {
        const auto modulus = static_cast<std::int64_t>(length);
        std::int64_t result = position % modulus;
        if (result < 0) result += modulus;
        return static_cast<std::size_t>(result);
    }

    [[nodiscard]] static unsigned int popcount(std::uint32_t value) noexcept {
        unsigned int count = 0U;
        while (value != 0U) {
            count += value & 1U;
            value >>= 1U;
        }
        return count;
    }

    [[nodiscard]] std::uint32_t nextRandom() noexcept {
        std::uint32_t value = randomState_;
        value ^= value << 13U;
        value ^= value >> 17U;
        value ^= value << 5U;
        randomState_ = value;
        return value;
    }

    [[nodiscard]] double randomUnit() noexcept {
        return static_cast<double>(nextRandom()) / 4294967296.0;
    }

    [[nodiscard]] double randomSigned() noexcept { return (randomUnit() * 2.0) - 1.0; }

    [[nodiscard]] std::size_t requestedCaptureFrames() const noexcept {
        const double bpmValue = std::clamp(static_cast<double>(bpm_.current()), 30.0, 300.0);
        const double beats = std::clamp(static_cast<double>(captureBeats_.current()), 0.25, 4.0);
        const auto requested = static_cast<std::size_t>(std::llround(
            static_cast<double>(sampleRate()) * 60.0 / bpmValue * beats));
        return std::clamp<std::size_t>(requested, 32U, capacityFrames_);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        if (sampleRate() < 8000U || sampleRate() > 192000U) return false;
        try {
            capacityFrames_ = static_cast<std::size_t>(sampleRate()) * 8U;
            for (auto& bank : banks_) {
                for (auto& channel : bank) channel.assign(capacityFrames_, 0.0f);
            }
            for (std::size_t line = 0U; line < fdnLines_.size(); ++line) {
                fdnLines_[line].assign(std::max<std::size_t>(1U, static_cast<std::size_t>(std::llround(
                    static_cast<double>(sampleRate()) * kFdnDelaySeconds[line]))), 0.0f);
            }
        } catch (const std::bad_alloc&) {
            return false;
        } catch (...) {
            return false;
        }
        for (std::size_t index = 0U; index <= kWindowSize; ++index) {
            const double phase = static_cast<double>(index) / static_cast<double>(kWindowSize);
            window_[index] = static_cast<float>(0.5 - (0.5 * std::cos(kTwoPi * phase)));
        }
        dampingAlpha_ = static_cast<float>(1.0 - std::exp(-kTwoPi * 6500.0 / sampleRate()));
        bpm_.reset(bpm_.target());
        captureBeats_.reset(captureBeats_.target());
        smearPercent_.reset(smearPercent_.target());
        pitchSemitones_.reset(pitchSemitones_.target());
        feedbackPercent_.reset(feedbackPercent_.target());
        clearState();
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "bpm") bpm_.setTarget(value, rampFrames);
        else if (parameterId == "capture_beats") captureBeats_.setTarget(value, rampFrames);
        else if (parameterId == "smear_percent") smearPercent_.setTarget(value, rampFrames);
        else if (parameterId == "pitch_semitones") pitchSemitones_.setTarget(value, rampFrames);
        else if (parameterId == "feedback_percent") feedbackPercent_.setTarget(value, rampFrames);
        else if (parameterId == "freeze") {
            const bool requested = value >= 0.5f;
            if (requested != freezeRequested_) {
                freezeRequested_ = requested;
                if (requested && !freezeActive_) freezePending_ = true;
                if (!requested) releaseCapture();
            }
        } else return false;
        return true;
    }

    void clearState() noexcept {
        // The four large capture arrays are intentionally not cleared on reset
        // (up to 23.44 MiB at 192 kHz). validFrames_ plus the live-grain history
        // gate below keep the old epoch unreachable without an RT-sized fill.
        for (auto& line : fdnLines_) std::fill(line.begin(), line.end(), 0.0f);
        fdnWrite_.fill(0U);
        fdnDamping_.fill(0.0f);
        fdnRead_.fill(0.0f);
        fdnTransform_.fill(0.0f);
        grains_.fill(Grain{});
        writerPosition_ = 0U;
        validFrames_ = 0U;
        frozenStart_ = 0U;
        frozenLength_ = 0U;
        frameCounter_ = 0U;
        writerBank_ = 0U;
        frozenBank_ = 0U;
        nextGrain_ = 0U;
        randomState_ = kRandomSeed;
        spawnPhase_ = 1.0;
        lastFdnLeft_ = 0.0f;
        lastFdnRight_ = 0.0f;
        hasFrozenBank_ = false;
        freezePending_ = freezeRequested_;
        freezeActive_ = false;
    }

    void onResetState() noexcept override {
        bpm_.reset(bpm_.target());
        captureBeats_.reset(captureBeats_.target());
        smearPercent_.reset(smearPercent_.target());
        pitchSemitones_.reset(pitchSemitones_.target());
        feedbackPercent_.reset(feedbackPercent_.target());
        clearState();
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }

    void tryCapture() noexcept {
        const std::size_t length = requestedCaptureFrames();
        if (!freezePending_ || validFrames_ < length) return;
        frozenBank_ = writerBank_;
        frozenLength_ = length;
        frozenStart_ = wrapIndex(static_cast<std::int64_t>(writerPosition_) - static_cast<std::int64_t>(length), capacityFrames_);
        writerBank_ = 1U - frozenBank_;
        writerPosition_ = 0U;
        validFrames_ = 0U;
        hasFrozenBank_ = true;
        freezePending_ = false;
        freezeActive_ = true;
    }

    void releaseCapture() noexcept {
        freezePending_ = false;
        if (!freezeActive_) return;
        freezeActive_ = false;
        if (hasFrozenBank_) {
            writerBank_ = frozenBank_;
            writerPosition_ = wrapIndex(
                static_cast<std::int64_t>(frozenStart_ + frozenLength_), capacityFrames_);
            validFrames_ = frozenLength_;
        }
        hasFrozenBank_ = false;
        frozenLength_ = 0U;
        for (auto& grain : grains_) grain = Grain{};
    }

    [[nodiscard]] float readSource(std::size_t channel, double position) const noexcept {
        const double bounded = std::max(0.0, position);
        const auto integral = static_cast<std::int64_t>(std::floor(bounded));
        const float fraction = static_cast<float>(bounded - static_cast<double>(integral));
        const auto& buffer = banks_[freezeActive_ ? frozenBank_ : writerBank_][channel];
        const auto sampleAt = [this, &buffer](std::int64_t index) noexcept {
            std::size_t wrapped = wrapIndex(index, capacityFrames_);
            if (freezeActive_ && frozenLength_ > 0U) {
                const auto relative = wrapIndex(static_cast<std::int64_t>(wrapped) -
                    static_cast<std::int64_t>(frozenStart_), frozenLength_);
                wrapped = wrapIndex(static_cast<std::int64_t>(frozenStart_ + relative), capacityFrames_);
            }
            return buffer[wrapped];
        };
        return dsp::lagrange4(sampleAt(integral - 1), sampleAt(integral),
                              sampleAt(integral + 1), sampleAt(integral + 2), fraction);
    }

    void spawnGrain(float smear) noexcept {
        auto& grain = grains_[nextGrain_];
        nextGrain_ = (nextGrain_ + 1U) % kGrainCount;
        grain.age = 0U;
        grain.length = 0U;
        const double bpmValue = std::clamp(static_cast<double>(bpm_.current()), 30.0, 300.0);
        const double beatFrames = static_cast<double>(sampleRate()) * 60.0 / bpmValue;
        const std::size_t captureLength = freezeActive_ ? frozenLength_ : std::max<std::size_t>(32U, validFrames_);
        const auto requestedLength = static_cast<std::size_t>(std::llround(
            static_cast<double>(sampleRate()) * 0.160));
        const auto beatLimitedLength = static_cast<std::size_t>(std::llround(
            beatFrames * std::clamp(static_cast<double>(captureBeats_.current()), 0.25, 4.0) / 4.0));
        const std::size_t grainLength = std::max<std::size_t>(
            32U, std::min({requestedLength, beatLimitedLength, captureLength}));
        const double pitch = std::clamp(static_cast<double>(pitchSemitones_.current()) + randomSigned() * smear * 4.0,
            -24.0, 24.0);
        grain.step = std::exp2(pitch / 12.0);
        const auto jitter = static_cast<std::int64_t>(std::llround(
            randomSigned() * smear * static_cast<double>(grainLength) * 0.25));
        if (freezeActive_ && frozenLength_ > 0U) {
            const std::size_t available = frozenLength_ > grainLength ? frozenLength_ - grainLength : 1U;
            const auto offset = static_cast<std::size_t>(randomUnit() * static_cast<double>(available));
            grain.position = static_cast<double>(wrapIndex(
                static_cast<std::int64_t>(frozenStart_ + offset) + jitter, capacityFrames_));
        } else {
            const auto age = std::min<std::size_t>(capacityFrames_ - 4U,
                std::max<std::size_t>(4U, static_cast<std::size_t>(std::ceil(
                    static_cast<double>(grainLength) * std::max(1.0, grain.step))) +
                    static_cast<std::size_t>(std::abs(jitter)) + 4U));
            // Do not read samples from the previous reset epoch. Wait until the
            // live ring contains this grain's complete source window.
            if (validFrames_ < age) return;
            grain.position = static_cast<double>(wrapIndex(
                static_cast<std::int64_t>(writerPosition_) - static_cast<std::int64_t>(age) + jitter,
                capacityFrames_));
        }
        grain.length = static_cast<unsigned int>(grainLength);
        grain.age = 0U;
    }

    void processFdn(float inputLeft, float inputRight, float feedback) noexcept {
        constexpr float kHadamardNormalization = 0.3535533905932738f;
        for (std::size_t line = 0U; line < 8U; ++line) {
            const float delayed = fdnLines_[line][fdnWrite_[line]];
            const float damped = fdnDamping_[line] + dampingAlpha_ * (delayed - fdnDamping_[line]);
            fdnDamping_[line] = std::isfinite(damped)
                ? std::clamp(damped, -kMaximumState, kMaximumState) : 0.0f;
            fdnRead_[line] = fdnDamping_[line];
        }
        for (std::size_t row = 0U; row < 8U; ++row) {
            float sum = 0.0f;
            for (std::size_t column = 0U; column < 8U; ++column) {
                const float sign = (popcount(static_cast<std::uint32_t>(row & column)) & 1U) == 0U ? 1.0f : -1.0f;
                sum += sign * fdnRead_[column];
            }
            fdnTransform_[row] = sum * kHadamardNormalization;
        }
        const float gain = std::clamp(feedback, 0.0f, kMaximumFeedback);
        for (std::size_t line = 0U; line < 8U; ++line) {
            const float injection = (line < 4U ? inputLeft : inputRight) * 0.25f;
            const float value = injection + (fdnTransform_[line] * gain);
            fdnLines_[line][fdnWrite_[line]] = std::isfinite(value)
                ? std::clamp(value, -kMaximumState, kMaximumState) : 0.0f;
            if (++fdnWrite_[line] >= fdnLines_[line].size()) fdnWrite_[line] = 0U;
        }
        lastFdnLeft_ = std::clamp((fdnRead_[0U] + fdnRead_[1U] + fdnRead_[2U] + fdnRead_[3U]) * 0.5f,
            -kMaximumState, kMaximumState);
        lastFdnRight_ = std::clamp((fdnRead_[4U] + fdnRead_[5U] + fdnRead_[6U] + fdnRead_[7U]) * 0.5f,
            -kMaximumState, kMaximumState);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        if (frame == nullptr || channels == 0U || capacityFrames_ == 0U) return;
        const float inputLeft = std::isfinite(frame[0U])
            ? std::clamp(frame[0U], -kMaximumState, kMaximumState) : 0.0f;
        const float inputRight = channels > 1U && std::isfinite(frame[1U])
            ? std::clamp(frame[1U], -kMaximumState, kMaximumState) : inputLeft;
        (void)bpm_.next();
        (void)captureBeats_.next();
        (void)pitchSemitones_.next();
        const float feedbackPercent = std::clamp(feedbackPercent_.next(), 0.0f, 95.0f);
        const float feedback = std::min(kMaximumFeedback, feedbackPercent * 0.01f);
        auto& capture = banks_[writerBank_];
        capture[0U][writerPosition_] = std::clamp(inputLeft + (feedback * lastFdnLeft_),
            -kMaximumState, kMaximumState);
        capture[1U][writerPosition_] = std::clamp(inputRight + (feedback * lastFdnRight_),
            -kMaximumState, kMaximumState);
        writerPosition_ = (writerPosition_ + 1U) % capacityFrames_;
        validFrames_ = std::min(validFrames_ + 1U, capacityFrames_);
        tryCapture();

        const float smear = std::clamp(smearPercent_.next(), 0.0f, 100.0f) * 0.01f;
        const double density = 6.0 + static_cast<double>(smear) * 34.0;
        spawnPhase_ += density / static_cast<double>(sampleRate());
        if (spawnPhase_ >= 1.0) {
            spawnPhase_ -= 1.0;
            spawnGrain(smear);
        }

        double wetLeft = 0.0;
        double wetRight = 0.0;
        double windowSum = 0.0;
        for (auto& grain : grains_) {
            if (grain.length < 2U || grain.age >= grain.length) continue;
            const double position = static_cast<double>(grain.age) * static_cast<double>(kWindowSize) /
                static_cast<double>(grain.length - 1U);
            const auto index = std::min<std::size_t>(static_cast<std::size_t>(position), kWindowSize - 1U);
            const float fraction = static_cast<float>(position - static_cast<double>(index));
            const float envelope = window_[index] + fraction * (window_[index + 1U] - window_[index]);
            wetLeft += static_cast<double>(readSource(0U, grain.position)) * envelope;
            wetRight += static_cast<double>(readSource(1U, grain.position)) * envelope;
            windowSum += envelope;
            grain.position += grain.step;
            if (freezeActive_ && frozenLength_ > 0U) {
                grain.position = static_cast<double>(frozenStart_) + std::fmod(
                    std::fmod(grain.position - static_cast<double>(frozenStart_), static_cast<double>(frozenLength_)) +
                    static_cast<double>(frozenLength_), static_cast<double>(frozenLength_));
            } else {
                grain.position = std::fmod(grain.position, static_cast<double>(capacityFrames_));
            }
            ++grain.age;
        }
        if (windowSum > 1.0e-8) {
            wetLeft /= windowSum;
            wetRight /= windowSum;
        } else {
            wetLeft = 0.0;
            wetRight = 0.0;
        }
        const float grainLeft = static_cast<float>(std::clamp(wetLeft, -static_cast<double>(kMaximumState), static_cast<double>(kMaximumState)));
        const float grainRight = static_cast<float>(std::clamp(wetRight, -static_cast<double>(kMaximumState), static_cast<double>(kMaximumState)));
        processFdn(grainLeft, grainRight, feedback);
        frame[0U] = std::clamp(grainLeft + lastFdnLeft_, -kMaximumState, kMaximumState);
        if (channels > 1U) frame[1U] = std::clamp(grainRight + lastFdnRight_, -kMaximumState, kMaximumState);
        ++frameCounter_;
    }
};

class NativeCatalogTapeEcho final : public NativeEffectProcessor {
public:
    explicit NativeCatalogTapeEcho(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        config_.enabled = true;
    }

private:
    NativeTapeEchoProcessor processor_{};
    NativeTapeEchoProcessorConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return processor_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "time_ms") config_.timeMs = value;
        else if (parameterId == "feedback_percent") config_.feedbackPercent = value;
        else if (parameterId == "wow_flutter_percent") config_.wowFlutterPercent = value;
        else if (parameterId == "saturation_percent") config_.saturationPercent = value;
        else if (parameterId == "tone_hz") config_.toneHz = value;
        else if (parameterId == "mix_percent") config_.mixPercent = value;
        else return false;
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogReverseDelay final : public NativeEffectProcessor {
public:
    explicit NativeCatalogReverseDelay(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativeReverseDelayProcessor processor_{};
    NativeReverseDelayConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return processor_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "bpm") config_.bpm = value;
        else if (parameterId == "segment_beats") config_.segmentBeats = value;
        else if (parameterId == "feedback_percent") config_.feedbackPercent = value;
        else if (parameterId == "crossfade_ms") config_.crossfadeMs = value;
        else if (parameterId == "mix_percent") config_.mixPercent = value;
        else return false;
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

// A reverse-reverb path is built from the existing bounded, tempo-clocked
// reverse-segment reader followed by the Native FDN16 diffuse tail.  It is
// deliberately distinct from REVERSE DELAY: the reversed segment is the FDN
// excitation, while the FDN return provides a decaying stereo late field.
class NativeCatalogReverseReverb final : public NativeEffectProcessor {
public:
    explicit NativeCatalogReverseReverb(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativeReverseDelayProcessor reverse_{};
    NativeReverseDelayConfig reverseConfig_{120.0f, 0.5f, 0.0f, 20.0f, 100.0f};
    NativeFdn16ReverbProcessor diffuse_{};
    NativeFdn16ReverbConfig diffuseConfig_{true, 1.0f, 2.0f, 8000.0f};
    dsp::ParameterSmoother mixPercent_{35.0f};

    [[nodiscard]] bool applyReverse(std::uint64_t rampFrames) noexcept {
        // This internal processor emits only the reversed segment stream; the
        // NativeReverseReverb owns the user-facing dry/wet control.
        reverseConfig_.mixPercent = 100.0f;
        return reverse_.setConfig(reverseConfig_, rampFrames);
    }

    [[nodiscard]] bool applyDiffuse(std::uint64_t rampFrames) noexcept {
        diffuseConfig_.enabled = true;
        diffuseConfig_.wetMix = 1.0f;
        return diffuse_.setConfig(diffuseConfig_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        mixPercent_.reset(35.0f);
        return reverse_.prepare(sampleRate()) && diffuse_.prepare(sampleRate()) &&
            applyReverse(0U) && applyDiffuse(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "bpm") reverseConfig_.bpm = value;
        else if (parameterId == "segment_beats") reverseConfig_.segmentBeats = value;
        else if (parameterId == "feedback_percent") reverseConfig_.feedbackPercent = value;
        else if (parameterId == "crossfade_ms") reverseConfig_.crossfadeMs = value;
        else if (parameterId == "decay_seconds") diffuseConfig_.rt60Seconds = value;
        else if (parameterId == "damping_cutoff_hz") diffuseConfig_.dampingCutoffHz = value;
        else if (parameterId == "mix_percent") {
            mixPercent_.setTarget(value, rampFrames);
            return true;
        } else {
            return false;
        }
        const bool reverseOk = parameterId == "bpm" || parameterId == "segment_beats" ||
            parameterId == "feedback_percent" || parameterId == "crossfade_ms"
            ? applyReverse(rampFrames)
            : true;
        const bool diffuseOk = parameterId == "decay_seconds" || parameterId == "damping_cutoff_hz"
            ? applyDiffuse(rampFrames)
            : true;
        return reverseOk && diffuseOk;
    }

    void onResetState() noexcept override {
        reverse_.reset();
        diffuse_.resetState();
        mixPercent_.reset(mixPercent_.target());
        (void)applyReverse(0U);
        (void)applyDiffuse(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
        if (processedChannels == 0U) return;

        std::array<float, 2U> wet{{
            std::isfinite(frame[0]) ? frame[0] : 0.0f,
            processedChannels > 1U && std::isfinite(frame[1]) ? frame[1] : 0.0f,
        }};
        const float dryLeft = wet[0];
        const float dryRight = wet[1];
        (void)reverse_.processInPlace(wet.data(), 1U, processedChannels);
        (void)diffuse_.processInPlace(wet.data(), 1U, processedChannels);

        const float wetAmount = std::clamp(mixPercent_.next(), 0.0f, 100.0f) * 0.01f;
        const auto gains = dsp::equalPowerCrossfadeGains(wetAmount);
        const float left = (dryLeft * gains.first) + (wet[0] * gains.second);
        frame[0] = std::isfinite(left) ? std::clamp(left, -8.0f, 8.0f) : 0.0f;
        if (processedChannels > 1U) {
            const float right = (dryRight * gains.first) + (wet[1] * gains.second);
            frame[1] = std::isfinite(right) ? std::clamp(right, -8.0f, 8.0f) : 0.0f;
        }
    }
};

class NativeCatalogPanningDelay final : public NativeEffectProcessor {
public:
    explicit NativeCatalogPanningDelay(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativePanningDelayProcessor processor_{};
    NativePanningDelayProcessorConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return processor_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "time_ms") config_.timeMs = value;
        else if (parameterId == "feedback_percent") config_.feedbackPercent = value;
        else if (parameterId == "pan_percent") config_.panPercent = value;
        else if (parameterId == "mix_percent") config_.mixPercent = value;
        else return false;
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

// Clean-room TWIST reconstruction: a signed macro curves a smoothed delay
// read-head trajectory and couples it to contractive saturation feedback,
// one-pole tone, and stereo balance. It is a functional inference from the
// catalog, not a recovered device law or Roland reproduction.
class NativeCatalogTwist final : public NativeEffectProcessor {
public:
    explicit NativeCatalogTwist(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr float kCenterDelayMs = 120.0f;
    static constexpr float kMinimumDelayMs = 30.0f;
    static constexpr float kMaximumDelayMs = 300.0f;
    static constexpr float kFeedbackStabilityMargin = 0.72f;
    static constexpr float kMaximumState = 8.0f;
    static constexpr double kTwoPi = 6.28318530717958647692;
    static constexpr std::size_t kTrajectoryTablePoints = 1024U;

    struct TrajectoryPoint {
        float mappedMagnitude = 0.0f;
        float positiveDelayMs = kCenterDelayMs;
        float negativeDelayMs = kCenterDelayMs;
        float feedback = 0.16f;
        float filterAlpha = 0.5f;
    };

    std::array<std::vector<float>, 2U> buffers_{};
    std::array<std::array<TrajectoryPoint, kTrajectoryTablePoints + 1U>, 4U> trajectoryTables_{};
    std::array<float, 2U> filterStates_{};
    std::size_t writeFrame_ = 0U;
    dsp::ParameterSmoother amountPercent_{0.0f};
    dsp::ParameterSmoother trajectory_{0.0f};
    unsigned int sampleRate_ = 0U;

    [[nodiscard]] static float transfer(float amount, unsigned int trajectory) noexcept {
        const float magnitude = std::clamp(std::fabs(amount), 0.0f, 1.0f);
        float shaped = magnitude * magnitude * (3.0f - (2.0f * magnitude));
        switch (trajectory) {
        case 1U: shaped = std::sqrt(magnitude); break;
        case 2U: shaped = magnitude * magnitude; break;
        case 3U: shaped = std::round(magnitude * 8.0f) / 8.0f; break;
        default: break;
        }
        return std::copysign(shaped, amount);
    }

    [[nodiscard]] TrajectoryPoint lookupTrajectory(unsigned int mode, float position) const noexcept {
        const float bounded = std::clamp(position, 0.0f, static_cast<float>(kTrajectoryTablePoints));
        const std::size_t point = std::min<std::size_t>(
            kTrajectoryTablePoints - 1U, static_cast<std::size_t>(bounded));
        const float fraction = bounded - static_cast<float>(point);
        const auto& first = trajectoryTables_[mode][point];
        const auto& second = trajectoryTables_[mode][point + 1U];
        const auto lerp = [fraction](float a, float b) noexcept { return a + ((b - a) * fraction); };
        return {
            lerp(first.mappedMagnitude, second.mappedMagnitude),
            lerp(first.positiveDelayMs, second.positiveDelayMs),
            lerp(first.negativeDelayMs, second.negativeDelayMs),
            lerp(first.feedback, second.feedback),
            lerp(first.filterAlpha, second.filterAlpha),
        };
    }

    [[nodiscard]] static TrajectoryPoint blendTrajectory(
        const TrajectoryPoint& first,
        const TrajectoryPoint& second,
        float blend
    ) noexcept {
        const auto lerp = [blend](float a, float b) noexcept { return a + ((b - a) * blend); };
        return {
            lerp(first.mappedMagnitude, second.mappedMagnitude),
            lerp(first.positiveDelayMs, second.positiveDelayMs),
            lerp(first.negativeDelayMs, second.negativeDelayMs),
            lerp(first.feedback, second.feedback),
            lerp(first.filterAlpha, second.filterAlpha),
        };
    }

    [[nodiscard]] float readFractional(std::size_t channel, float delayFrames) const noexcept {
        const auto& buffer = buffers_[channel];
        const std::size_t capacity = buffer.size();
        if (capacity < 5U) return 0.0f;
        const float boundedDelay = std::clamp(delayFrames, 4.0f, static_cast<float>(capacity - 3U));
        const auto integerDelay = static_cast<std::size_t>(boundedDelay);
        const float fraction = boundedDelay - static_cast<float>(integerDelay);
        const auto readAtDelay = [this, &buffer, capacity](std::size_t framesAgo) noexcept {
            std::size_t index = writeFrame_ + capacity - framesAgo;
            if (index >= capacity) index -= capacity;
            return buffer[index];
        };
        return dsp::lagrange4(
            readAtDelay(integerDelay - 1U),
            readAtDelay(integerDelay),
            readAtDelay(integerDelay + 1U),
            readAtDelay(integerDelay + 2U),
            fraction
        );
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        if (sampleRate() > 192000U) return false;
        sampleRate_ = sampleRate();
        for (unsigned int mode = 0U; mode < trajectoryTables_.size(); ++mode) {
            for (std::size_t point = 0U; point <= kTrajectoryTablePoints; ++point) {
                const float magnitude = static_cast<float>(point) / static_cast<float>(kTrajectoryTablePoints);
                const float mapped = transfer(magnitude, mode);
                auto& entry = trajectoryTables_[mode][point];
                entry.mappedMagnitude = mapped;
                entry.positiveDelayMs = kCenterDelayMs * std::pow(kMinimumDelayMs / kCenterDelayMs, mapped);
                entry.negativeDelayMs = kCenterDelayMs * std::pow(kMaximumDelayMs / kCenterDelayMs, mapped);
                entry.feedback = 0.16f + (0.66f * std::pow(mapped, 1.15f));
                const float cutoffHz = std::min(7800.0f * std::pow(0.1f, mapped),
                    static_cast<float>(sampleRate_) * 0.45f);
                entry.filterAlpha = static_cast<float>(1.0 - std::exp(-kTwoPi * cutoffHz / sampleRate_));
            }
        }
        const std::size_t capacity = static_cast<std::size_t>(
            std::ceil(static_cast<double>(kMaximumDelayMs) * sampleRate_ / 1000.0)
        ) + 8U;
        try {
            buffers_[0U].assign(capacity, 0.0f);
            buffers_[1U].assign(capacity, 0.0f);
        } catch (...) {
            buffers_[0U].clear();
            buffers_[1U].clear();
            sampleRate_ = 0U;
            return false;
        }
        writeFrame_ = 0U;
        filterStates_.fill(0.0f);
        amountPercent_.reset(0.0f);
        trajectory_.reset(0.0f);
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "amount_percent") amountPercent_.setTarget(value, rampFrames);
        else if (parameterId == "trajectory") trajectory_.setTarget(value, rampFrames);
        else return false;
        return true;
    }

    void onResetState() noexcept override {
        for (auto& buffer : buffers_) std::fill(buffer.begin(), buffer.end(), 0.0f);
        writeFrame_ = 0U;
        filterStates_.fill(0.0f);
        amountPercent_.reset(amountPercent_.target());
        trajectory_.reset(trajectory_.target());
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
        if (processedChannels == 0U || sampleRate_ == 0U) return;
        const float amount = std::clamp(amountPercent_.next() * 0.01f, -1.0f, 1.0f);
        const float trajectoryValue = std::clamp(trajectory_.next(), 0.0f, 3.0f);
        const unsigned int modeA = static_cast<unsigned int>(trajectoryValue);
        const unsigned int modeB = std::min(3U, modeA + 1U);
        const float modeBlend = trajectoryValue - static_cast<float>(modeA);
        const float tablePosition = std::fabs(amount) * static_cast<float>(kTrajectoryTablePoints);
        const auto macroCurve = blendTrajectory(
            lookupTrajectory(modeA, tablePosition), lookupTrajectory(modeB, tablePosition), modeBlend);
        const float macro = std::copysign(macroCurve.mappedMagnitude, amount);
        const float magnitude = std::clamp(macroCurve.mappedMagnitude, 0.0f, 1.0f);
        const float delayMs = amount >= 0.0f ? macroCurve.positiveDelayMs : macroCurve.negativeDelayMs;
        const float delayFrames = delayMs * static_cast<float>(sampleRate_) / 1000.0f;
        const float feedback = macroCurve.feedback * kFeedbackStabilityMargin;
        const float alpha = macroCurve.filterAlpha;
        std::array<float, 2U> delayed{};
        std::array<float, 2U> input{};
        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            input[channel] = std::isfinite(frame[channel])
                ? std::clamp(frame[channel], -kMaximumState, kMaximumState)
                : 0.0f;
            delayed[channel] = readFractional(channel, delayFrames);
            const float filtered = filterStates_[channel] + alpha * (delayed[channel] - filterStates_[channel]);
            filterStates_[channel] = std::isfinite(filtered)
                ? std::clamp(filtered, -kMaximumState, kMaximumState)
                : 0.0f;
            const float record = input[channel] + feedback * std::tanh(filterStates_[channel] * 1.5f);
            buffers_[channel][writeFrame_] = std::isfinite(record)
                ? std::clamp(record, -kMaximumState, kMaximumState)
                : 0.0f;
        }
        const float leftGain = macro > 0.0f ? std::cos(magnitude * static_cast<float>(kTwoPi * 0.25)) : 1.0f;
        const float rightGain = macro < 0.0f ? std::cos(magnitude * static_cast<float>(kTwoPi * 0.25)) : 1.0f;
        frame[0U] = std::clamp(filterStates_[0U] * leftGain, -kMaximumState, kMaximumState);
        if (processedChannels > 1U) frame[1U] = std::clamp(filterStates_[1U] * rightGain, -kMaximumState, kMaximumState);
        ++writeFrame_;
        if (writeFrame_ >= buffers_[0U].size()) writeFrame_ = 0U;
    }
};

// Clean-room granular delay. Input history, window lookup, RNG state, and the
// fixed grain pool are all prepared before playback; processEffectFrame never
// allocates. Grains read the captured ring with a four-point Lagrange kernel,
// and their shared stereo positions preserve channel coherence.
class NativeCatalogGranularDelay final : public NativeEffectProcessor {
public:
    explicit NativeCatalogGranularDelay(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::size_t kGrainCount = 16U;
    static constexpr std::size_t kWindowSize = 2048U;
    static constexpr float kMaximumState = 8.0f;
    static constexpr std::uint64_t kRandomSeed = 0x4752414e554c4152ULL;
    static constexpr double kMaximumJitterOfGrain = 0.25;
    static constexpr double kFeedbackStabilityScale = 0.75;

    struct Grain {
        double readPosition = 0.0;
        float pitchStep = 1.0f;
        unsigned int age = 0U;
        unsigned int length = 0U;
        bool active = false;
    };

    std::array<std::vector<float>, 2U> history_{};
    std::array<std::size_t, 2U> writeIndices_{};
    std::array<Grain, kGrainCount> grains_{};
    std::array<float, kWindowSize + 1U> window_{};
    dsp::ParameterSmoother grainSizeMs_{120.0f};
    dsp::ParameterSmoother densityHz_{12.0f};
    dsp::ParameterSmoother pitchSemitones_{0.0f};
    dsp::ParameterSmoother jitterPercent_{15.0f};
    dsp::ParameterSmoother feedbackPercent_{15.0f};
    dsp::ParameterSmoother mixPercent_{35.0f};
    dsp::DeterministicRng random_{kRandomSeed};
    std::array<float, 2U> lastWet_{};
    std::uint64_t frameCounter_ = 0U;
    double spawnPhase_ = 1.0;

    [[nodiscard]] bool onPrepare() noexcept override {
        if (sampleRate() < 8000U || sampleRate() > 192000U) return false;
        try {
            // The contract pitch range (4x), 25% grain-size jitter and a
            // read margin fit within the same 4.5 s history used by Browser.
            const std::size_t capacity = static_cast<std::size_t>(sampleRate()) * 9U / 2U + 16U;
            for (auto& channel : history_) channel.assign(capacity, 0.0f);
        } catch (const std::bad_alloc&) {
            return false;
        } catch (...) {
            return false;
        }
        constexpr double kPi = 3.141592653589793238462643383279502884;
        for (std::size_t index = 0U; index <= kWindowSize; ++index) {
            const double phase = static_cast<double>(index) / static_cast<double>(kWindowSize);
            window_[index] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * kPi * phase));
        }
        grainSizeMs_.reset(grainSizeMs_.target());
        densityHz_.reset(densityHz_.target());
        pitchSemitones_.reset(pitchSemitones_.target());
        jitterPercent_.reset(jitterPercent_.target());
        feedbackPercent_.reset(feedbackPercent_.target());
        mixPercent_.reset(mixPercent_.target());
        resetState();
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "grain_size_ms") grainSizeMs_.setTarget(value, rampFrames);
        else if (parameterId == "density_hz") densityHz_.setTarget(value, rampFrames);
        else if (parameterId == "pitch_semitones") pitchSemitones_.setTarget(value, rampFrames);
        else if (parameterId == "position_jitter_percent") jitterPercent_.setTarget(value, rampFrames);
        else if (parameterId == "feedback_percent") feedbackPercent_.setTarget(value, rampFrames);
        else if (parameterId == "mix_percent") mixPercent_.setTarget(value, rampFrames);
        else return false;
        return true;
    }

    void onResetState() noexcept override {
        for (auto& channel : history_) std::fill(channel.begin(), channel.end(), 0.0f);
        writeIndices_.fill(0U);
        grains_.fill(Grain{});
        lastWet_.fill(0.0f);
        frameCounter_ = 0U;
        spawnPhase_ = 1.0;
        random_.seed(kRandomSeed);
        grainSizeMs_.reset(grainSizeMs_.target());
        densityHz_.reset(densityHz_.target());
        pitchSemitones_.reset(pitchSemitones_.target());
        jitterPercent_.reset(jitterPercent_.target());
        feedbackPercent_.reset(feedbackPercent_.target());
        mixPercent_.reset(mixPercent_.target());
    }

    [[nodiscard]] float readWindow(unsigned int age, unsigned int length) const noexcept {
        if (length <= 1U) return 0.0f;
        const double position = static_cast<double>(age) * static_cast<double>(kWindowSize) /
            static_cast<double>(length - 1U);
        const auto lower = std::min<std::size_t>(static_cast<std::size_t>(position), kWindowSize - 1U);
        const float fraction = static_cast<float>(position - static_cast<double>(lower));
        return window_[lower] + fraction * (window_[lower + 1U] - window_[lower]);
    }

    [[nodiscard]] float readHistory(std::size_t channel, double position) const noexcept {
        const auto& line = history_[channel];
        const auto capacity = static_cast<std::int64_t>(line.size());
        const auto integral = static_cast<std::int64_t>(std::floor(position));
        const float fraction = static_cast<float>(position - static_cast<double>(integral));
        const auto sampleAt = [&line, capacity](std::int64_t index) noexcept {
            std::int64_t wrapped = index % capacity;
            if (wrapped < 0) wrapped += capacity;
            return line[static_cast<std::size_t>(wrapped)];
        };
        return dsp::lagrange4(
            sampleAt(integral - 1), sampleAt(integral), sampleAt(integral + 1), sampleAt(integral + 2), fraction
        );
    }

    void spawnGrain(float grainSizeMs, float densityHz, float pitchSemitones,
                    float jitterPercent) noexcept {
        std::size_t chosen = kGrainCount;
        float quietestWindow = 2.0f;
        for (std::size_t index = 0U; index < grains_.size(); ++index) {
            const auto& grain = grains_[index];
            if (!grain.active) {
                chosen = index;
                break;
            }
            const float envelope = readWindow(grain.age, grain.length);
            if (envelope < quietestWindow) {
                quietestWindow = envelope;
                chosen = index;
            }
        }
        if (chosen == kGrainCount || history_[0U].empty()) return;

        auto& grain = grains_[chosen];
        const auto requestedLength = std::max(2U, static_cast<unsigned int>(std::lround(
            static_cast<double>(grainSizeMs) * static_cast<double>(sampleRate()) / 1000.0
        )));
        const double periodFrames = static_cast<double>(sampleRate()) / std::clamp(static_cast<double>(densityHz), 1.0, 80.0);
        const auto voiceLimitedLength = static_cast<unsigned int>(std::max(2.0,
            std::floor(periodFrames * static_cast<double>(kGrainCount)) - 1.0));
        const auto length = std::min(requestedLength, voiceLimitedLength);
        const float pitchStep = std::exp2(pitchSemitones / 12.0f);
        const double jitter = std::clamp(static_cast<double>(jitterPercent), 0.0, 100.0) * 0.01 *
            kMaximumJitterOfGrain * static_cast<double>(length);
        const double sourceAge = std::max(1.0, static_cast<double>(pitchStep)) * static_cast<double>(length) +
            jitter + 4.0;
        double readPosition = static_cast<double>(frameCounter_) - sourceAge +
            static_cast<double>(random_.nextBipolarFloat()) * jitter;
        const double capacity = static_cast<double>(history_[0U].size());
        readPosition = std::fmod(readPosition, capacity);
        if (readPosition < 0.0) readPosition += capacity;
        grain.readPosition = readPosition;
        grain.pitchStep = pitchStep;
        grain.age = 0U;
        grain.length = length;
        grain.active = true;
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        if (frame == nullptr || channels == 0U || history_[0U].empty()) return;
        const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
        std::array<float, 2U> dry{};
        dry[0U] = std::isfinite(frame[0U]) ? std::clamp(frame[0U], -kMaximumState, kMaximumState) : 0.0f;
        dry[1U] = processedChannels > 1U && std::isfinite(frame[1U])
            ? std::clamp(frame[1U], -kMaximumState, kMaximumState) : dry[0U];

        const float grainSizeMs = grainSizeMs_.next();
        const float densityHz = densityHz_.next();
        const float pitchSemitones = pitchSemitones_.next();
        const float jitterPercent = jitterPercent_.next();
        const float feedback = std::clamp(feedbackPercent_.next() * 0.01f, 0.0f, 0.95f) *
            static_cast<float>(kFeedbackStabilityScale);
        const float wetMix = std::clamp(mixPercent_.next() * 0.01f, 0.0f, 1.0f);

        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            const float input = channel < processedChannels ? dry[channel] : dry[0U];
            const float record = std::clamp(input + feedback * lastWet_[channel], -kMaximumState, kMaximumState);
            history_[channel][writeIndices_[channel]] = record;
            if (++writeIndices_[channel] == history_[channel].size()) writeIndices_[channel] = 0U;
        }

        spawnPhase_ += std::clamp(static_cast<double>(densityHz), 1.0, 80.0) / static_cast<double>(sampleRate());
        if (spawnPhase_ >= 1.0) {
            spawnPhase_ -= 1.0;
            spawnGrain(grainSizeMs, densityHz, pitchSemitones, jitterPercent);
        }

        std::array<double, 2U> wetSum{};
        double windowSum = 0.0;
        const double capacity = static_cast<double>(history_[0U].size());
        for (auto& grain : grains_) {
            if (!grain.active) continue;
            const float envelope = readWindow(grain.age, grain.length);
            for (std::size_t channel = 0U; channel < 2U; ++channel) {
                wetSum[channel] += static_cast<double>(readHistory(channel, grain.readPosition)) * envelope;
            }
            windowSum += envelope;
            grain.readPosition += static_cast<double>(grain.pitchStep);
            if (grain.readPosition >= capacity) grain.readPosition -= capacity;
            ++grain.age;
            if (grain.age >= grain.length) grain.active = false;
        }

        if (windowSum > 1.0e-8) {
            lastWet_[0U] = static_cast<float>(wetSum[0U] / windowSum);
            lastWet_[1U] = static_cast<float>(wetSum[1U] / windowSum);
        } else {
            lastWet_.fill(0.0f);
        }
        const auto gains = dsp::equalPowerCrossfadeGains(wetMix);
        frame[0U] = std::clamp(dry[0U] * gains.first + lastWet_[0U] * gains.second, -kMaximumState, kMaximumState);
        if (processedChannels > 1U) {
            frame[1U] = std::clamp(dry[1U] * gains.first + lastWet_[1U] * gains.second,
                -kMaximumState, kMaximumState);
        }
        ++frameCounter_;
    }
};

class NativeCatalogAutoPan final : public NativeEffectProcessor {
public:
    explicit NativeCatalogAutoPan(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        config_.enabled = true;
    }

private:
    NativeAutoPanProcessor autoPan_{};
    NativeAutoPanConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return autoPan_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return autoPan_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value, std::uint64_t rampFrames) noexcept override {
        if (parameterId == "rate_hz") {
            config_.rateHz = value;
        } else if (parameterId == "depth") {
            config_.depth = value;
        } else if (parameterId == "waveform") {
            config_.waveform = static_cast<NativeAutoPanWaveform>(static_cast<unsigned int>(value));
        } else if (parameterId == "wet_mix") {
            config_.wetMix = value;
        } else {
            return false;
        }
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        if (sampleRate() != 0U) {
            (void)autoPan_.prepare(sampleRate());
            (void)apply(0U);
        }
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)autoPan_.processInPlace(frame, 1U, channels);
    }
};

// Static equal-power pan for mono-compatible stereo buffers. With a stereo
// signal, position attenuates only the far channel and preserves the center;
// a one-channel buffer remains one channel because this in-place interface
// cannot expand it to stereo.
class NativeCatalogManualPan final : public NativeEffectProcessor {
public:
    explicit NativeCatalogManualPan(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    dsp::ParameterSmoother position_{0.0f};

    [[nodiscard]] bool onPrepare() noexcept override {
        position_.reset(position_.target());
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId != "position") return false;
        position_.setTarget(value * 0.01f, rampFrames);
        return true;
    }

    void onResetState() noexcept override {
        position_.reset(position_.target());
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < count; ++channel) {
            if (!std::isfinite(frame[channel])) frame[channel] = 0.0f;
        }
        const float position = std::clamp(position_.next(), -1.0f, 1.0f);
        if (count < 2U || position == 0.0f) return;

        constexpr double kHalfPi = 1.57079632679489661923;
        constexpr float kSqrtTwo = 1.4142135623730950488f;
        const double pan = (static_cast<double>(position) + 1.0) * 0.5;
        const double angle = pan * kHalfPi;
        const float leftGain = static_cast<float>(std::cos(angle));
        const float rightGain = static_cast<float>(std::sin(angle));
        if (position > 0.0f) {
            frame[0U] *= leftGain * kSqrtTwo;
        } else {
            frame[1U] *= rightGain * kSqrtTwo;
        }
    }
};

class NativeCatalogChorus final : public NativeEffectProcessor {
public:
    explicit NativeCatalogChorus(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        config_.enabled = true;
    }

private:
    NativeChorusProcessor chorus_{};
    ChorusProcessorConfig config_{true, 0.8f, 5.0f, 0.0f, 0.25f};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return chorus_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return chorus_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value, std::uint64_t rampFrames) noexcept override {
        if (parameterId == "rate_hz") {
            config_.rateHz = value;
        } else if (parameterId == "depth_ms") {
            config_.depthMs = value;
        } else if (parameterId == "feedback") {
            config_.feedback = value;
        } else if (parameterId == "wet_mix") {
            config_.wetMix = value;
        } else {
            return false;
        }
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        if (sampleRate() != 0U) {
            (void)chorus_.prepare(sampleRate());
            (void)apply(0U);
        }
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)chorus_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogTremolo final : public NativeEffectProcessor {
public:
    explicit NativeCatalogTremolo(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    dsp::ParameterSmoother rateHz_{4.0f};
    dsp::ParameterSmoother depth_{0.5f};
    dsp::ParameterSmoother waveform_{0.0f};
    dsp::ParameterSmoother wetMix_{1.0f};
    double phase_ = 0.0;

    [[nodiscard]] float waveformAt(float phase, unsigned int waveform) const noexcept {
        switch (waveform) {
        case 1U: // Triangle: continuous, 0 -> 1 -> 0 over one cycle.
            return phase < 0.5f ? phase * 2.0f : (1.0f - phase) * 2.0f;
        case 2U: // Square: hard-gated half-cycle.
            return phase < 0.5f ? 0.0f : 1.0f;
        case 0U:
        default:
            return 0.5f + (0.5f * static_cast<float>(std::sin(phase * 6.28318530717958647692f)));
        }
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        rateHz_.reset(rateHz_.target());
        depth_.reset(depth_.target());
        waveform_.reset(waveform_.target());
        wetMix_.reset(wetMix_.target());
        phase_ = 0.0;
        return true;
    }

    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value, std::uint64_t rampFrames) noexcept override {
        if (parameterId == "rate_hz") {
            rateHz_.setTarget(value, rampFrames);
        } else if (parameterId == "depth") {
            depth_.setTarget(value, rampFrames);
        } else if (parameterId == "waveform") {
            waveform_.setTarget(value, rampFrames);
        } else if (parameterId == "wet_mix") {
            wetMix_.setTarget(value, rampFrames);
        } else {
            return false;
        }
        return true;
    }

    void onResetState() noexcept override {
        rateHz_.reset(rateHz_.target());
        depth_.reset(depth_.target());
        waveform_.reset(waveform_.target());
        wetMix_.reset(wetMix_.target());
        phase_ = 0.0;
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const float phase = static_cast<float>(phase_);
        const float waveform = std::clamp(waveform_.next(), 0.0f, 2.0f);
        const unsigned int lowerShape = static_cast<unsigned int>(waveform);
        const unsigned int upperShape = std::min(lowerShape + 1U, 2U);
        const float shapeBlend = waveform - static_cast<float>(lowerShape);
        const float lfo = waveformAt(phase, lowerShape) +
            ((waveformAt(phase, upperShape) - waveformAt(phase, lowerShape)) * shapeBlend);
        const float modulationDepth = depth_.next();
        const float wetMix = wetMix_.next();
        const float gain = 1.0f - (modulationDepth * lfo);
        const float wetGain = 1.0f + ((gain - 1.0f) * wetMix);
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < count; ++channel) frame[channel] *= wetGain;

        phase_ += static_cast<double>(rateHz_.next()) / static_cast<double>(sampleRate());
        if (phase_ >= 1.0) phase_ -= 1.0;
    }
};

class NativeCatalogRingMod final : public NativeEffectProcessor {
public:
    explicit NativeCatalogRingMod(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    dsp::ParameterSmoother carrierHz_{440.0f};
    dsp::ParameterSmoother depth_{1.0f};
    dsp::ParameterSmoother wetMix_{1.0f};
    double phase_ = 0.0;

    [[nodiscard]] float maximumCarrierHz() const noexcept {
        return static_cast<float>(sampleRate()) * 0.45f;
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        if (carrierHz_.target() >= maximumCarrierHz()) return false;
        carrierHz_.reset(carrierHz_.target());
        depth_.reset(depth_.target());
        wetMix_.reset(wetMix_.target());
        phase_ = 0.0;
        return true;
    }

    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value, std::uint64_t rampFrames) noexcept override {
        if (parameterId == "carrier_hz") {
            if (sampleRate() != 0U && value >= maximumCarrierHz()) return false;
            carrierHz_.setTarget(value, rampFrames);
        } else if (parameterId == "depth") {
            depth_.setTarget(value, rampFrames);
        } else if (parameterId == "wet_mix") {
            wetMix_.setTarget(value, rampFrames);
        } else {
            return false;
        }
        return true;
    }

    void onResetState() noexcept override {
        carrierHz_.reset(carrierHz_.target());
        depth_.reset(depth_.target());
        wetMix_.reset(wetMix_.target());
        phase_ = 0.0;
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const float carrier = static_cast<float>(std::sin(phase_));
        const float depth = depth_.next();
        const float wetMix = wetMix_.next();
        const float ringGain = 1.0f - depth + (depth * carrier);
        const float gain = 1.0f + ((ringGain - 1.0f) * wetMix);
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < count; ++channel) frame[channel] *= gain;

        phase_ += kTwoPi * static_cast<double>(carrierHz_.next()) / static_cast<double>(sampleRate());
        if (phase_ >= kTwoPi) phase_ -= kTwoPi;
    }
};

// Five-section parametric EQ: low/high shelves around two peaking bands.
// Controls move at audio rate, while the inexpensive but transcendental RBJ
// coefficient design runs on a fixed, absolute 16-frame cadence. This keeps
// updates deterministic across arbitrary callback segmentation and prevents
// parameter changes from racing the audio owner; coefficients are always
// generated from bounded, smoothed values and each installed biquad remains
// a stable RBJ design. State and coefficient work are fixed-storage/RT-safe.
class NativeCatalogEqualizer final : public NativeEffectProcessor {
public:
    explicit NativeCatalogEqualizer(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::uint64_t kCoefficientUpdateInterval = 16U;
    static constexpr double kShelfSlope = 1.0;
    std::array<std::array<dsp::Biquad, 2U>, 4U> filters_{};
    dsp::ParameterSmoother lowFrequencyHz_{100.0f};
    dsp::ParameterSmoother lowGainDb_{0.0f};
    dsp::ParameterSmoother mid1FrequencyHz_{500.0f};
    dsp::ParameterSmoother mid1Q_{1.0f};
    dsp::ParameterSmoother mid1GainDb_{0.0f};
    dsp::ParameterSmoother mid2FrequencyHz_{2500.0f};
    dsp::ParameterSmoother mid2Q_{1.0f};
    dsp::ParameterSmoother mid2GainDb_{0.0f};
    dsp::ParameterSmoother highFrequencyHz_{8000.0f};
    dsp::ParameterSmoother highGainDb_{0.0f};
    std::uint64_t processedFrames_ = 0U;

    [[nodiscard]] double boundedFrequency(float requestedHz) const noexcept {
        const double rate = static_cast<double>(sampleRate());
        return std::clamp(static_cast<double>(requestedHz), 5.0, rate * 0.45);
    }

    [[nodiscard]] bool configure(
        float lowFrequencyHz,
        float lowGainDb,
        float mid1FrequencyHz,
        float mid1Q,
        float mid1GainDb,
        float mid2FrequencyHz,
        float mid2Q,
        float mid2GainDb,
        float highFrequencyHz,
        float highGainDb
    ) noexcept {
        if (sampleRate() == 0U) return false;
        const double rate = static_cast<double>(sampleRate());
        const std::array<dsp::BiquadType, 4U> types{{
            dsp::BiquadType::LowShelf,
            dsp::BiquadType::Peaking,
            dsp::BiquadType::Peaking,
            dsp::BiquadType::HighShelf,
        }};
        const std::array<double, 4U> frequencies{{
            boundedFrequency(lowFrequencyHz),
            boundedFrequency(mid1FrequencyHz),
            boundedFrequency(mid2FrequencyHz),
            boundedFrequency(highFrequencyHz),
        }};
        const std::array<double, 4U> qValues{{
            0.7071067811865476,
            static_cast<double>(mid1Q),
            static_cast<double>(mid2Q),
            0.7071067811865476,
        }};
        const std::array<double, 4U> gains{{
            static_cast<double>(lowGainDb),
            static_cast<double>(mid1GainDb),
            static_cast<double>(mid2GainDb),
            static_cast<double>(highGainDb),
        }};

        for (std::size_t band = 0U; band < filters_.size(); ++band) {
            // Design once per band then copy coefficients to the two channels;
            // setParameters() preserves each channel's independent DF2T state.
            dsp::Biquad designer;
            if (!designer.setParameters(types[band], rate, frequencies[band], qValues[band], gains[band], kShelfSlope)) {
                return false;
            }
            const auto& coefficients = designer.coefficients();
            for (auto& channelFilter : filters_[band]) {
                if (!channelFilter.setCoefficients(coefficients)) return false;
            }
        }
        return true;
    }

    [[nodiscard]] bool configureCurrent() noexcept {
        return configure(
            lowFrequencyHz_.current(), lowGainDb_.current(),
            mid1FrequencyHz_.current(), mid1Q_.current(), mid1GainDb_.current(),
            mid2FrequencyHz_.current(), mid2Q_.current(), mid2GainDb_.current(),
            highFrequencyHz_.current(), highGainDb_.current()
        );
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        for (auto& band : filters_) for (auto& filter : band) filter.reset();
        lowFrequencyHz_.reset(lowFrequencyHz_.target());
        lowGainDb_.reset(lowGainDb_.target());
        mid1FrequencyHz_.reset(mid1FrequencyHz_.target());
        mid1Q_.reset(mid1Q_.target());
        mid1GainDb_.reset(mid1GainDb_.target());
        mid2FrequencyHz_.reset(mid2FrequencyHz_.target());
        mid2Q_.reset(mid2Q_.target());
        mid2GainDb_.reset(mid2GainDb_.target());
        highFrequencyHz_.reset(highFrequencyHz_.target());
        highGainDb_.reset(highGainDb_.target());
        processedFrames_ = 0U;
        return configureCurrent();
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "low_frequency_hz") lowFrequencyHz_.setTarget(value, rampFrames);
        else if (parameterId == "low_gain_db") lowGainDb_.setTarget(value, rampFrames);
        else if (parameterId == "mid1_frequency_hz") mid1FrequencyHz_.setTarget(value, rampFrames);
        else if (parameterId == "mid1_q") mid1Q_.setTarget(value, rampFrames);
        else if (parameterId == "mid1_gain_db") mid1GainDb_.setTarget(value, rampFrames);
        else if (parameterId == "mid2_frequency_hz") mid2FrequencyHz_.setTarget(value, rampFrames);
        else if (parameterId == "mid2_q") mid2Q_.setTarget(value, rampFrames);
        else if (parameterId == "mid2_gain_db") mid2GainDb_.setTarget(value, rampFrames);
        else if (parameterId == "high_frequency_hz") highFrequencyHz_.setTarget(value, rampFrames);
        else if (parameterId == "high_gain_db") highGainDb_.setTarget(value, rampFrames);
        else return false;
        return true;
    }

    void onResetState() noexcept override {
        for (auto& band : filters_) for (auto& filter : band) filter.reset();
        lowFrequencyHz_.reset(lowFrequencyHz_.target());
        lowGainDb_.reset(lowGainDb_.target());
        mid1FrequencyHz_.reset(mid1FrequencyHz_.target());
        mid1Q_.reset(mid1Q_.target());
        mid1GainDb_.reset(mid1GainDb_.target());
        mid2FrequencyHz_.reset(mid2FrequencyHz_.target());
        mid2Q_.reset(mid2Q_.target());
        mid2GainDb_.reset(mid2GainDb_.target());
        highFrequencyHz_.reset(highFrequencyHz_.target());
        highGainDb_.reset(highGainDb_.target());
        processedFrames_ = 0U;
        (void)configureCurrent();
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const float lowFrequencyHz = lowFrequencyHz_.next();
        const float lowGainDb = lowGainDb_.next();
        const float mid1FrequencyHz = mid1FrequencyHz_.next();
        const float mid1Q = mid1Q_.next();
        const float mid1GainDb = mid1GainDb_.next();
        const float mid2FrequencyHz = mid2FrequencyHz_.next();
        const float mid2Q = mid2Q_.next();
        const float mid2GainDb = mid2GainDb_.next();
        const float highFrequencyHz = highFrequencyHz_.next();
        const float highGainDb = highGainDb_.next();
        if ((processedFrames_ % kCoefficientUpdateInterval) == 0U) {
            (void)configure(
                lowFrequencyHz, lowGainDb,
                mid1FrequencyHz, mid1Q, mid1GainDb,
                mid2FrequencyHz, mid2Q, mid2GainDb,
                highFrequencyHz, highGainDb
            );
        }
        ++processedFrames_;

        const unsigned int count = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < count; ++channel) {
            float sample = frame[channel];
            for (std::size_t band = 0U; band < filters_.size(); ++band) {
                sample = filters_[band][channel].process(sample);
            }
            frame[channel] = sample;
        }
    }
};

// Clean-room three-band isolator. Two LR4 splits built from existing RBJ
// biquads form low, mid, and high bands that sum to the input at unity gain. A
// sample-clocked rhythmic gate follows the configured BPM and beat division.
// Control ramps and filter coefficient refreshes use absolute frame cadence,
// so arbitrary callback block sizes produce the same stream without callback
// allocations or any claim of matching a particular hardware implementation.
class NativeCatalogIsolator final : public NativeEffectProcessor {
public:
    explicit NativeCatalogIsolator(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::uint64_t kCoefficientUpdateInterval = 8U;
    static constexpr double kMinimumBandRatio = 1.1;
    static constexpr double kFilterQ = 0.7071067811865476;
    using FilterCascade = std::array<std::array<dsp::Biquad, 2U>, 2U>;
    FilterCascade lowPassCrossover_{};
    FilterCascade lowHighPassCrossover_{};
    FilterCascade highPassCrossover_{};
    FilterCascade highHighPassCrossover_{};
    dsp::ParameterSmoother lowCrossoverHz_{250.0f};
    dsp::ParameterSmoother highCrossoverHz_{4000.0f};
    dsp::ParameterSmoother lowGain_{1.0f};
    dsp::ParameterSmoother midGain_{1.0f};
    dsp::ParameterSmoother highGain_{1.0f};
    dsp::ParameterSmoother gateBpm_{120.0f};
    dsp::ParameterSmoother gateDivisionBeats_{0.5f};
    dsp::ParameterSmoother gateDutyPercent_{50.0f};
    dsp::ParameterSmoother gateAttackMs_{1.0f};
    dsp::ParameterSmoother gateReleaseMs_{25.0f};
    dsp::ParameterSmoother gateEnvelope_{1.0f};
    std::uint64_t processedFrames_ = 0U;
    double gatePhase_ = 0.0;
    bool gateEnabled_ = false;

    [[nodiscard]] static float decibelsToLinear(float decibels) noexcept {
        return std::pow(10.0f, decibels / 20.0f);
    }

    [[nodiscard]] bool configureCrossovers(float requestedLowHz, float requestedHighHz) noexcept {
        if (sampleRate() == 0U) return false;
        const double rate = static_cast<double>(sampleRate());
        const double maximumHz = rate * 0.45;
        const double maximumLowHz = std::max(40.0, maximumHz / kMinimumBandRatio);
        const double lowHz = std::clamp(static_cast<double>(requestedLowHz), 40.0, maximumLowHz);
        const double minimumHighHz = std::min(maximumHz, std::max(100.0, lowHz * kMinimumBandRatio));
        const double highHz = std::clamp(static_cast<double>(requestedHighHz), minimumHighHz, maximumHz);
        auto configureCascade = [rate](FilterCascade& cascade, dsp::BiquadType type, double cutoffHz) noexcept {
            dsp::Biquad designer;
            if (!designer.setParameters(type, rate, cutoffHz, kFilterQ)) return false;
            const auto& coefficients = designer.coefficients();
            for (auto& section : cascade) {
                for (auto& channel : section) {
                    if (!channel.setCoefficients(coefficients)) return false;
                }
            }
            return true;
        };
        // Each pair is a fourth-order Linkwitz-Riley split built from two
        // existing Butterworth biquads; each pair's low/high outputs sum flat.
        return configureCascade(lowPassCrossover_, dsp::BiquadType::LowPass, lowHz) &&
            configureCascade(lowHighPassCrossover_, dsp::BiquadType::HighPass, lowHz) &&
            configureCascade(highPassCrossover_, dsp::BiquadType::LowPass, highHz) &&
            configureCascade(highHighPassCrossover_, dsp::BiquadType::HighPass, highHz);
    }

    [[nodiscard]] static float processCascade(FilterCascade& cascade, unsigned int channel, float input) noexcept {
        return cascade[1U][channel].process(cascade[0U][channel].process(input));
    }

    [[nodiscard]] std::uint64_t gateRampFrames(float durationMs) const noexcept {
        const double frames = std::round(static_cast<double>(sampleRate()) *
                                         static_cast<double>(durationMs) / 1000.0);
        return static_cast<std::uint64_t>(std::max(1.0, frames));
    }

    void resetSmoothers() noexcept {
        lowCrossoverHz_.reset(lowCrossoverHz_.target());
        highCrossoverHz_.reset(highCrossoverHz_.target());
        lowGain_.reset(lowGain_.target());
        midGain_.reset(midGain_.target());
        highGain_.reset(highGain_.target());
        gateBpm_.reset(gateBpm_.target());
        gateDivisionBeats_.reset(gateDivisionBeats_.target());
        gateDutyPercent_.reset(gateDutyPercent_.target());
        gateAttackMs_.reset(gateAttackMs_.target());
        gateReleaseMs_.reset(gateReleaseMs_.target());
        gateEnvelope_.reset(1.0f);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        for (auto* cascade : {&lowPassCrossover_, &lowHighPassCrossover_, &highPassCrossover_, &highHighPassCrossover_}) {
            for (auto& section : *cascade) for (auto& filter : section) filter.reset();
        }
        resetSmoothers();
        gatePhase_ = 0.0;
        processedFrames_ = 0U;
        return configureCrossovers(lowCrossoverHz_.current(), highCrossoverHz_.current());
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "low_crossover_hz") lowCrossoverHz_.setTarget(value, rampFrames);
        else if (parameterId == "high_crossover_hz") highCrossoverHz_.setTarget(value, rampFrames);
        else if (parameterId == "low_gain_db") lowGain_.setTarget(decibelsToLinear(value), rampFrames);
        else if (parameterId == "mid_gain_db") midGain_.setTarget(decibelsToLinear(value), rampFrames);
        else if (parameterId == "high_gain_db") highGain_.setTarget(decibelsToLinear(value), rampFrames);
        else if (parameterId == "gate_enabled") {
            const bool enabled = value >= 0.5f;
            if (enabled && !gateEnabled_) gatePhase_ = 0.0;
            gateEnabled_ = enabled;
        } else if (parameterId == "gate_bpm") gateBpm_.setTarget(value, rampFrames);
        else if (parameterId == "gate_division_beats") gateDivisionBeats_.setTarget(value, rampFrames);
        else if (parameterId == "gate_duty_percent") gateDutyPercent_.setTarget(value, rampFrames);
        else if (parameterId == "gate_attack_ms") gateAttackMs_.setTarget(value, rampFrames);
        else if (parameterId == "gate_release_ms") gateReleaseMs_.setTarget(value, rampFrames);
        else return false;
        return true;
    }

    void onResetState() noexcept override {
        for (auto* cascade : {&lowPassCrossover_, &lowHighPassCrossover_, &highPassCrossover_, &highHighPassCrossover_}) {
            for (auto& section : *cascade) for (auto& filter : section) filter.reset();
        }
        resetSmoothers();
        gatePhase_ = 0.0;
        processedFrames_ = 0U;
        (void)configureCrossovers(lowCrossoverHz_.current(), highCrossoverHz_.current());
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const float lowCrossoverHz = lowCrossoverHz_.next();
        const float highCrossoverHz = highCrossoverHz_.next();
        const float lowGain = lowGain_.next();
        const float midGain = midGain_.next();
        const float highGain = highGain_.next();
        if ((processedFrames_ % kCoefficientUpdateInterval) == 0U) {
            (void)configureCrossovers(lowCrossoverHz, highCrossoverHz);
        }
        ++processedFrames_;

        const float bpm = gateBpm_.next();
        const float divisionBeats = gateDivisionBeats_.next();
        const float duty = gateDutyPercent_.next() * 0.01f;
        bool gateOpen = true;
        if (gateEnabled_) {
            const double phaseAdvance = static_cast<double>(bpm) /
                (60.0 * static_cast<double>(sampleRate()) * static_cast<double>(divisionBeats));
            gatePhase_ += phaseAdvance;
            gatePhase_ -= std::floor(gatePhase_);
            gateOpen = gatePhase_ < static_cast<double>(duty);
        }
        const float desiredEnvelope = gateOpen ? 1.0f : 0.0f;
        if (gateEnvelope_.target() != desiredEnvelope) {
            const float durationMs = gateOpen ? gateAttackMs_.current() : gateReleaseMs_.current();
            gateEnvelope_.setTarget(desiredEnvelope, gateRampFrames(durationMs));
        }
        const float gate = gateEnvelope_.next();

        const unsigned int count = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < count; ++channel) {
            const float input = std::isfinite(frame[channel]) ? frame[channel] : 0.0f;
            const float low = processCascade(lowPassCrossover_, channel, input);
            const float upper = processCascade(lowHighPassCrossover_, channel, input);
            const float mid = processCascade(highPassCrossover_, channel, upper);
            const float high = processCascade(highHighPassCrossover_, channel, upper);
            frame[channel] = ((low * lowGain) + (mid * midGain) + (high * highGain)) * gate;
        }
    }
};

class NativeCatalogStereoEnhance final : public NativeEffectProcessor {
public:
    explicit NativeCatalogStereoEnhance(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativeStereoEnhanceProcessor processor_{};
    NativeStereoEnhanceConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return processor_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "width") {
            config_.widthPercent = value;
        } else if (parameterId == "low_mono_cutoff_hz") {
            config_.lowMonoCutoffHz = value;
        } else if (parameterId == "decorrelation") {
            config_.decorrelationPercent = value;
        } else if (parameterId == "wet_mix") {
            config_.wetMixPercent = value;
        } else {
            return false;
        }
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

class NativeFractionalDelay final : public NativeEffectProcessor {
public:
    explicit NativeFractionalDelay(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    std::array<std::vector<float>, 2U> lines_{};
    std::array<std::size_t, 2U> writeIndices_{};
    dsp::ParameterSmoother delayMs_{350.0f};
    dsp::ParameterSmoother feedback_{0.35f};
    dsp::ParameterSmoother wetMix_{0.3f};
    std::size_t maximumDelayFrames_ = 0U;

    [[nodiscard]] float readFractional(const std::vector<float>& line, std::size_t writeIndex, double delayFrames) const noexcept {
        const std::size_t capacity = line.size();
        const double bounded = std::clamp(delayFrames, 2.0, static_cast<double>(maximumDelayFrames_));
        const auto integerDelay = static_cast<std::size_t>(bounded);
        const float fraction = static_cast<float>(bounded - static_cast<double>(integerDelay));
        const float position = 1.0f - fraction;
        const auto readAt = [&line, capacity, writeIndex](std::size_t delay) noexcept {
            const std::size_t index = writeIndex + capacity - delay;
            return line[index >= capacity ? index - capacity : index];
        };
        return dsp::lagrange4(
            readAt(integerDelay + 2U), readAt(integerDelay + 1U),
            readAt(integerDelay), readAt(integerDelay - 1U), position
        );
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        try {
            maximumDelayFrames_ = static_cast<std::size_t>(std::max(
                2.0, std::ceil(static_cast<double>(sampleRate()) * 2.0)
            ));
            const std::size_t capacity = maximumDelayFrames_ + 4U;
            for (auto& line : lines_) line.assign(capacity, 0.0f);
        } catch (const std::bad_alloc&) {
            maximumDelayFrames_ = 0U;
            return false;
        } catch (...) {
            maximumDelayFrames_ = 0U;
            return false;
        }
        writeIndices_.fill(0U);
        delayMs_.reset(delayMs_.target());
        feedback_.reset(feedback_.target());
        wetMix_.reset(wetMix_.target());
        return true;
    }

    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value, std::uint64_t rampFrames) noexcept override {
        if (parameterId == "delay_ms") {
            delayMs_.setTarget(value, rampFrames);
        } else if (parameterId == "feedback") {
            feedback_.setTarget(value, rampFrames);
        } else if (parameterId == "wet_mix") {
            wetMix_.setTarget(value, rampFrames);
        } else {
            return false;
        }
        return true;
    }

    void onResetState() noexcept override {
        for (auto& line : lines_) std::fill(line.begin(), line.end(), 0.0f);
        writeIndices_.fill(0U);
        delayMs_.reset(delayMs_.target());
        feedback_.reset(feedback_.target());
        wetMix_.reset(wetMix_.target());
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        if (maximumDelayFrames_ < 2U) return;
        const float delaySamples = std::clamp(
            delayMs_.next() * static_cast<float>(sampleRate()) / 1000.0f,
            2.0f,
            static_cast<float>(maximumDelayFrames_)
        );
        const float feedback = feedback_.next();
        const auto gains = dsp::equalPowerCrossfadeGains(wetMix_.next());
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < count; ++channel) {
            auto& line = lines_[channel];
            const float dry = frame[channel];
            const float delayed = readFractional(line, writeIndices_[channel], static_cast<double>(delaySamples));
            line[writeIndices_[channel]] = std::clamp(dry + delayed * feedback, -8.0f, 8.0f);
            ++writeIndices_[channel];
            if (writeIndices_[channel] == line.size()) writeIndices_[channel] = 0U;
            frame[channel] = (dry * gains.first) + (delayed * gains.second);
        }
    }
};

class NativeCatalogModDelay final : public NativeEffectProcessor {
public:
    explicit NativeCatalogModDelay(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        config_.enabled = true;
    }

private:
    NativeModDelayProcessor processor_{};
    NativeModDelayProcessorConfig config_{};

    [[nodiscard]] bool apply(std::uint64_t rampFrames) noexcept {
        return processor_.setConfig(config_, rampFrames);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.prepare(sampleRate()) && apply(0U);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "rate_hz") {
            config_.rateHz = value;
        } else if (parameterId == "depth_ms") {
            config_.depthMs = value;
        } else if (parameterId == "delay_ms") {
            config_.delayMs = value;
        } else if (parameterId == "feedback") {
            config_.feedback = value;
        } else if (parameterId == "wet_mix") {
            config_.wetMix = value;
        } else {
            return false;
        }
        return apply(rampFrames);
    }

    void onResetState() noexcept override {
        processor_.reset();
        (void)apply(0U);
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

// Clean-room preset gain-envelope reconstruction. The eight fixed tables and
// free-running step phase are deliberately authored choices; they do not claim
// to reproduce Roland's pattern data or downbeat phase. All modulation is
// sample-clocked and fixed-storage, with no callback allocation or locking.
class NativeCatalogPatternSlicer final : public NativeEffectProcessor {
public:
    explicit NativeCatalogPatternSlicer(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr double kPi = 3.14159265358979323846;
    static constexpr std::array<std::array<float, 8U>, 8U> kPatterns{{
        {{1.0f, 0.0f, 1.0f, 0.0f, 1.0f, 0.0f, 1.0f, 0.0f}},
        {{1.0f, 1.0f, 0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 0.0f}},
        {{1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 1.0f, 0.0f, 0.0f}},
        {{1.0f, 1.0f, 1.0f, 0.0f, 1.0f, 0.0f, 1.0f, 1.0f}},
        {{1.0f, 0.35f, 1.0f, 0.35f, 1.0f, 0.35f, 1.0f, 0.35f}},
        {{1.0f, 1.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 0.0f}},
        {{1.0f, 0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 0.0f, 1.0f}},
        {{1.0f, 0.2f, 0.6f, 0.0f, 1.0f, 0.2f, 0.6f, 0.0f}},
    }};

    dsp::ParameterSmoother depthPercent_{100.0f};
    dsp::ParameterSmoother edgeMs_{2.0f};
    dsp::ParameterSmoother bpm_{120.0f};
    unsigned int pattern_ = 0U;
    float rateBeats_ = 0.25f;
    double phaseSteps_ = 0.0;

    [[nodiscard]] bool onPrepare() noexcept override {
        depthPercent_.reset(depthPercent_.target());
        edgeMs_.reset(edgeMs_.target());
        bpm_.reset(bpm_.target());
        phaseSteps_ = 0.0;
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "pattern") {
            pattern_ = static_cast<unsigned int>(value);
        } else if (parameterId == "rate") {
            rateBeats_ = value;
        } else if (parameterId == "depth") {
            depthPercent_.setTarget(value, rampFrames);
        } else if (parameterId == "edge_ms") {
            edgeMs_.setTarget(value, rampFrames);
        } else if (parameterId == "bpm") {
            bpm_.setTarget(value, rampFrames);
        } else {
            return false;
        }
        return true;
    }

    void onResetState() noexcept override {
        phaseSteps_ = 0.0;
        depthPercent_.reset(depthPercent_.target());
        edgeMs_.reset(edgeMs_.target());
        bpm_.reset(bpm_.target());
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const float depth = std::clamp(depthPercent_.next() * 0.01f, 0.0f, 1.0f);
        const double edgeFramesRequested = static_cast<double>(edgeMs_.next()) *
            static_cast<double>(sampleRate()) / 1000.0;
        const double bpm = static_cast<double>(std::clamp(bpm_.next(), 30.0f, 300.0f));
        const double stepFrames = static_cast<double>(sampleRate()) * 60.0 / bpm *
            static_cast<double>(rateBeats_);

        // Addition of a fractional sample increment can leave an otherwise
        // exact step edge a few ulps early after a long run. Snap only those
        // sub-nanoframe residuals so the step table stays sample-clocked.
        const double nearestStep = std::round(phaseSteps_);
        if (std::fabs(phaseSteps_ - nearestStep) < 1.0e-12) phaseSteps_ = nearestStep;

        const auto stepIndex = static_cast<std::size_t>(phaseSteps_);
        const double localStepPhase = phaseSteps_ - static_cast<double>(stepIndex);
        const double localFrames = localStepPhase * stepFrames;
        const double edgeFrames = std::min(edgeFramesRequested, stepFrames * 0.45);
        float envelope = kPatterns[pattern_][stepIndex];
        if (edgeFrames >= 1.0 && localFrames < edgeFrames) {
            const std::size_t previousStep = (stepIndex + 7U) % 8U;
            const float previous = kPatterns[pattern_][previousStep];
            const double t = std::clamp(localFrames / edgeFrames, 0.0, 1.0);
            const float blend = static_cast<float>(0.5 - (0.5 * std::cos(kPi * t)));
            envelope = previous + ((envelope - previous) * blend);
        }

        const float gain = 1.0f - (depth * (1.0f - envelope));
        const unsigned int count = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < count; ++channel) frame[channel] *= gain;

        phaseSteps_ += 1.0 / stepFrames;
        if (phaseSteps_ >= 8.0) phaseSteps_ -= std::floor(phaseSteps_ / 8.0) * 8.0;
    }
};

// Clean-room editable 16-step gain/pan/low-pass sequence. Step values are
// supplied by the bridge as step_01..step_16 amplitude percentages. Values are
// latched at the next step boundary, with a fixed 2 ms raised-cosine edge to
// avoid clicks. This is an authored reconstruction and makes no claim about
// Roland's STEP SLICER tables or sound.
class NativeCatalogStepSlicer final : public NativeEffectProcessor {
public:
    explicit NativeCatalogStepSlicer(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {
        activeLevels_.fill(100.0f);
        pendingLevels_.fill(100.0f);
    }

private:
    static constexpr double kPi = 3.14159265358979323846;
    static constexpr std::array<std::string_view, 16U> kStepParameterIds{{
        "step_01", "step_02", "step_03", "step_04", "step_05", "step_06", "step_07", "step_08",
        "step_09", "step_10", "step_11", "step_12", "step_13", "step_14", "step_15", "step_16",
    }};

    std::array<float, 16U> activeLevels_{};
    std::array<float, 16U> pendingLevels_{};
    unsigned int activeStepCount_ = 16U;
    unsigned int pendingStepCount_ = 16U;
    float activeRateBeats_ = 0.25f;
    float pendingRateBeats_ = 0.25f;
    float activeBpm_ = 120.0f;
    float pendingBpm_ = 120.0f;
    float activeDepthPercent_ = 100.0f;
    float pendingDepthPercent_ = 100.0f;
    float activePanDepthPercent_ = 0.0f;
    float pendingPanDepthPercent_ = 0.0f;
    float activeFilterHz_ = 20000.0f;
    float pendingFilterHz_ = 20000.0f;
    std::array<float, 2U> lowPassState_{};
    double phaseSteps_ = 0.0;
    float filterAlpha_ = 1.0f;
    bool pendingControls_ = false;

    void updateFilterAlpha() noexcept {
        const double rate = static_cast<double>(sampleRate());
        const double cutoff = std::clamp(static_cast<double>(activeFilterHz_), 20.0, rate * 0.49);
        filterAlpha_ = static_cast<float>(1.0 - std::exp((-2.0 * kPi * cutoff) / rate));
    }

    void applyPendingControls() noexcept {
        activeLevels_ = pendingLevels_;
        activeStepCount_ = pendingStepCount_;
        activeRateBeats_ = pendingRateBeats_;
        activeBpm_ = pendingBpm_;
        activeDepthPercent_ = pendingDepthPercent_;
        activePanDepthPercent_ = pendingPanDepthPercent_;
        activeFilterHz_ = pendingFilterHz_;
        phaseSteps_ = std::fmod(phaseSteps_, static_cast<double>(activeStepCount_));
        if (phaseSteps_ < 0.0) phaseSteps_ += static_cast<double>(activeStepCount_);
        updateFilterAlpha();
        pendingControls_ = false;
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        phaseSteps_ = 0.0;
        lowPassState_.fill(0.0f);
        applyPendingControls();
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t
    ) noexcept override {
        if (parameterId == "step_count") {
            pendingStepCount_ = static_cast<unsigned int>(value);
        } else if (parameterId == "rate_beats") {
            pendingRateBeats_ = value;
        } else if (parameterId == "bpm") {
            pendingBpm_ = value;
        } else if (parameterId == "depth_percent") {
            pendingDepthPercent_ = value;
        } else if (parameterId == "pan_depth_percent") {
            pendingPanDepthPercent_ = value;
        } else if (parameterId == "filter_hz") {
            pendingFilterHz_ = value;
        } else {
            bool found = false;
            for (std::size_t step = 0U; step < kStepParameterIds.size(); ++step) {
                if (parameterId == kStepParameterIds[step]) {
                    pendingLevels_[step] = value;
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        pendingControls_ = true;
        return true;
    }

    void onResetState() noexcept override {
        phaseSteps_ = 0.0;
        lowPassState_.fill(0.0f);
        if (pendingControls_) applyPendingControls();
        else updateFilterAlpha();
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        // Snap only sub-picoframe residuals from fractional stepping so exact
        // tempo boundaries remain stable over long runs and arbitrary blocks.
        const double nearestStep = std::round(phaseSteps_);
        if (std::fabs(phaseSteps_ - nearestStep) < 1.0e-12) phaseSteps_ = nearestStep;
        if (phaseSteps_ >= static_cast<double>(activeStepCount_)) {
            phaseSteps_ -= static_cast<double>(activeStepCount_);
        }
        if (phaseSteps_ < 1.0e-12 && pendingControls_) applyPendingControls();

        const double bpm = static_cast<double>(std::clamp(activeBpm_, 30.0f, 300.0f));
        const double stepFrames = static_cast<double>(sampleRate()) * 60.0 / bpm *
            static_cast<double>(activeRateBeats_);
        const auto stepIndex = std::min<unsigned int>(
            static_cast<unsigned int>(phaseSteps_), activeStepCount_ - 1U);
        const unsigned int previousStep = (stepIndex + activeStepCount_ - 1U) % activeStepCount_;
        const double localStepPhase = phaseSteps_ - static_cast<double>(stepIndex);
        const double localFrames = localStepPhase * stepFrames;
        const double edgeFrames = std::min(static_cast<double>(sampleRate()) * 0.002, stepFrames * 0.45);
        float blend = 1.0f;
        if (edgeFrames >= 1.0 && localFrames < edgeFrames) {
            const double t = std::clamp(localFrames / edgeFrames, 0.0, 1.0);
            blend = static_cast<float>(0.5 - (0.5 * std::cos(kPi * t)));
        }

        const float depth = std::clamp(activeDepthPercent_ * 0.01f, 0.0f, 1.0f);
        const float previousLevel = std::clamp(activeLevels_[previousStep] * 0.01f, 0.0f, 1.0f);
        const float currentLevel = std::clamp(activeLevels_[stepIndex] * 0.01f, 0.0f, 1.0f);
        const float previousGain = 1.0f - (depth * (1.0f - previousLevel));
        const float currentGain = 1.0f - (depth * (1.0f - currentLevel));
        const float amplitudeGain = previousGain + ((currentGain - previousGain) * blend);

        const float panDepth = std::clamp(activePanDepthPercent_ * 0.01f, 0.0f, 1.0f);
        const float previousPan = (previousStep % 2U == 0U ? -panDepth : panDepth);
        const float currentPan = (stepIndex % 2U == 0U ? -panDepth : panDepth);
        const float pan = previousPan + ((currentPan - previousPan) * blend);
        const float leftGain = pan > 0.0f ? 1.0f - pan : 1.0f;
        const float rightGain = pan < 0.0f ? 1.0f + pan : 1.0f;

        const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            const float input = frame[channel];
            lowPassState_[channel] += filterAlpha_ * (input - lowPassState_[channel]);
            const float panGain = channel == 0U ? leftGain : rightGain;
            frame[channel] = lowPassState_[channel] * amplitudeGain * panGain;
        }

        phaseSteps_ += 1.0 / stepFrames;
        if (phaseSteps_ >= static_cast<double>(activeStepCount_)) {
            phaseSteps_ -= std::floor(phaseSteps_ / static_cast<double>(activeStepCount_)) *
                static_cast<double>(activeStepCount_);
        }
    }
};

// Clean-room monophonic synth effect. Input is low-passed and decimated toward
// 12 kHz, then a 640-sample YIN-style frame is searched every 128 tracker
// samples. This gives about 53 ms of analysis history plus up to 11 ms update
// cadence at 48 kHz (longer at low sample rates); this is analysis latency, not
// an aligned dry-path delay. Oscillators are a polyBLEP saw/square plus a
// triangle choice and a quieter square sub-oscillator, followed by a resonant
// TPT-SVF low-pass. The topology is inferred and is not a hardware emulation.
class NativeCatalogSynth final : public NativeEffectProcessor {
public:
    explicit NativeCatalogSynth(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr std::size_t kAnalysisWindow = 640U;
    static constexpr unsigned int kMinimumLag = 12U;
    static constexpr unsigned int kMaximumLag = 256U;
    static constexpr unsigned int kTrackerHop = 128U;
    static constexpr float kMaximumInput = 4.0f;
    static constexpr float kMaximumOutput = 3.0f;

    std::array<float, kAnalysisWindow> trackerRing_{};
    std::array<double, kMaximumLag + 1U> difference_{};
    std::array<double, kMaximumLag + 1U> cmnd_{};
    dsp::ParameterSmoother sensitivity_{60.0f};
    dsp::ParameterSmoother waveform_{0.0f};
    dsp::ParameterSmoother octave_{0.0f};
    dsp::ParameterSmoother toneHz_{4000.0f};
    dsp::ParameterSmoother mixPercent_{50.0f};
    dsp::TptStateVariableFilter filter_{};
    std::size_t trackerWrite_ = 0U;
    std::size_t trackerCount_ = 0U;
    unsigned int decimationFactor_ = 1U;
    unsigned int decimationPhase_ = 0U;
    unsigned int trackerHopCount_ = 0U;
    unsigned int filterUpdateCount_ = 0U;
    unsigned int trackerRate_ = 0U;
    double decimatorState_ = 0.0;
    double envelope_ = 0.0;
    double attackCoefficient_ = 0.0;
    double releaseCoefficient_ = 0.0;
    double oscillatorPhase_ = 0.0;
    double subPhase_ = 0.0;
    float trackedHz_ = 0.0f;
    float filterQ_ = 1.7f;

    [[nodiscard]] static double polyBlep(double phase, double increment) noexcept {
        if (increment <= 0.0) return 0.0;
        if (phase < increment) {
            const double normalized = phase / increment;
            return normalized + normalized - (normalized * normalized) - 1.0;
        }
        if (phase > 1.0 - increment) {
            const double normalized = (phase - 1.0) / increment;
            return (normalized * normalized) + normalized + normalized + 1.0;
        }
        return 0.0;
    }

    [[nodiscard]] static double wrappedPhase(double phase) noexcept {
        phase -= std::floor(phase);
        return phase < 0.0 ? phase + 1.0 : phase;
    }

    [[nodiscard]] static float oscillatorSample(unsigned int shape, double phase, double increment) noexcept {
        if (shape == 1U) {
            double square = phase < 0.5 ? 1.0 : -1.0;
            square += polyBlep(phase, increment);
            square -= polyBlep(wrappedPhase(phase + 0.5), increment);
            return static_cast<float>(square);
        }
        if (shape == 2U) {
            return static_cast<float>(1.0 - 4.0 * std::fabs(phase - 0.5));
        }
        const double saw = (2.0 * phase) - 1.0 - polyBlep(phase, increment);
        return static_cast<float>(saw);
    }

    [[nodiscard]] double sensitivityGate(float sensitivity) const noexcept {
        const double inverse = 1.0 - (static_cast<double>(sensitivity) * 0.01);
        return 0.0004 + (0.045 * inverse * inverse);
    }

    void pushTrackerSample(float sample) noexcept {
        trackerRing_[trackerWrite_] = sample;
        ++trackerWrite_;
        if (trackerWrite_ == kAnalysisWindow) trackerWrite_ = 0U;
        trackerCount_ = std::min<std::size_t>(trackerCount_ + 1U, kAnalysisWindow);
        if (trackerCount_ < kAnalysisWindow) return;

        ++trackerHopCount_;
        if (trackerHopCount_ < kTrackerHop) return;
        trackerHopCount_ = 0U;

        constexpr std::size_t comparisonCount = kAnalysisWindow - kMaximumLag;
        double signalEnergy = 0.0;
        for (std::size_t index = 0U; index < kAnalysisWindow; ++index) {
            const double value = static_cast<double>(trackerRing_[(trackerWrite_ + index) % kAnalysisWindow]);
            signalEnergy += value * value;
        }
        if (signalEnergy < 1.0e-9) return;

        for (unsigned int lag = kMinimumLag; lag <= kMaximumLag; ++lag) {
            double sum = 0.0;
            std::size_t firstIndex = trackerWrite_;
            std::size_t secondIndex = (trackerWrite_ + lag) % kAnalysisWindow;
            for (std::size_t index = 0U; index < comparisonCount; ++index) {
                const double delta = static_cast<double>(trackerRing_[firstIndex]) -
                    static_cast<double>(trackerRing_[secondIndex]);
                sum += delta * delta;
                if (++firstIndex == kAnalysisWindow) firstIndex = 0U;
                if (++secondIndex == kAnalysisWindow) secondIndex = 0U;
            }
            difference_[lag] = sum;
        }

        double cumulative = 0.0;
        cmnd_.fill(1.0);
        for (unsigned int lag = kMinimumLag; lag <= kMaximumLag; ++lag) {
            cumulative += difference_[lag];
            cmnd_[lag] = cumulative > 1.0e-20
                ? (difference_[lag] * static_cast<double>(lag)) / cumulative
                : 1.0;
        }

        unsigned int selectedLag = 0U;
        double bestValue = 1.0;
        const double threshold = 0.12 +
            (0.10 * (1.0 - static_cast<double>(sensitivity_.target()) * 0.01));
        for (unsigned int lag = kMinimumLag; lag <= kMaximumLag; ++lag) {
            if (cmnd_[lag] < bestValue) {
                bestValue = cmnd_[lag];
                selectedLag = lag;
            }
            if (cmnd_[lag] < threshold) {
                while (lag < kMaximumLag && cmnd_[lag + 1U] < cmnd_[lag]) ++lag;
                selectedLag = lag;
                bestValue = cmnd_[lag];
                break;
            }
        }
        if (selectedLag == 0U || bestValue > 0.28) return;

        double lagOffset = 0.0;
        if (selectedLag > kMinimumLag && selectedLag < kMaximumLag) {
            const double left = cmnd_[selectedLag - 1U];
            const double center = cmnd_[selectedLag];
            const double right = cmnd_[selectedLag + 1U];
            const double curvature = left - (2.0 * center) + right;
            if (std::fabs(curvature) > 1.0e-12) {
                lagOffset = std::clamp(0.5 * (left - right) / curvature, -0.5, 0.5);
            }
        }
        const double estimatedHz = static_cast<double>(trackerRate_) /
            (static_cast<double>(selectedLag) + lagOffset);
        if (!std::isfinite(estimatedHz) || estimatedHz < 35.0 || estimatedHz > 1200.0) return;
        if (trackedHz_ <= 0.0f) trackedHz_ = static_cast<float>(estimatedHz);
        else trackedHz_ += (static_cast<float>(estimatedHz) - trackedHz_) * 0.55f;
    }

    [[nodiscard]] bool configureFilter(float cutoffHz) noexcept {
        const double boundedCutoff = std::clamp(
            static_cast<double>(cutoffHz), 20.0, static_cast<double>(sampleRate()) * 0.45);
        return filter_.setParameters(static_cast<double>(sampleRate()), boundedCutoff,
                                     static_cast<double>(filterQ_));
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        if (sampleRate() > 192000U) return false;
        decimationFactor_ = std::max(1U, static_cast<unsigned int>(std::lround(
            static_cast<double>(sampleRate()) / 12000.0)));
        trackerRate_ = sampleRate() / decimationFactor_;
        attackCoefficient_ = std::exp(-1.0 / (static_cast<double>(sampleRate()) * 0.004));
        releaseCoefficient_ = std::exp(-1.0 / (static_cast<double>(sampleRate()) * 0.075));
        sensitivity_.reset(sensitivity_.target());
        waveform_.reset(waveform_.target());
        octave_.reset(octave_.target());
        toneHz_.reset(toneHz_.target());
        mixPercent_.reset(mixPercent_.target());
        trackerRing_.fill(0.0f);
        difference_.fill(0.0);
        cmnd_.fill(1.0);
        trackerWrite_ = 0U;
        trackerCount_ = 0U;
        decimationPhase_ = 0U;
        trackerHopCount_ = 0U;
        filterUpdateCount_ = 0U;
        decimatorState_ = 0.0;
        envelope_ = 0.0;
        oscillatorPhase_ = 0.0;
        subPhase_ = 0.0;
        trackedHz_ = 0.0f;
        filter_.reset();
        return configureFilter(toneHz_.target());
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId, float value, std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "sensitivity") sensitivity_.setTarget(value, rampFrames);
        else if (parameterId == "waveform") waveform_.setTarget(value, rampFrames);
        else if (parameterId == "octave") octave_.setTarget(value, rampFrames);
        else if (parameterId == "tone") toneHz_.setTarget(value, rampFrames);
        else if (parameterId == "mix") mixPercent_.setTarget(value, rampFrames);
        else return false;
        return true;
    }

    void onResetState() noexcept override {
        sensitivity_.reset(sensitivity_.target());
        waveform_.reset(waveform_.target());
        octave_.reset(octave_.target());
        toneHz_.reset(toneHz_.target());
        mixPercent_.reset(mixPercent_.target());
        trackerRing_.fill(0.0f);
        difference_.fill(0.0);
        cmnd_.fill(1.0);
        trackerWrite_ = 0U;
        trackerCount_ = 0U;
        decimationPhase_ = 0U;
        trackerHopCount_ = 0U;
        filterUpdateCount_ = 0U;
        decimatorState_ = 0.0;
        envelope_ = 0.0;
        oscillatorPhase_ = 0.0;
        subPhase_ = 0.0;
        trackedHz_ = 0.0f;
        filter_.reset();
        (void)configureFilter(toneHz_.target());
    }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
        if (processedChannels == 0U) return;

        const float left = std::isfinite(frame[0])
            ? std::clamp(frame[0], -kMaximumInput, kMaximumInput) : 0.0f;
        const float right = processedChannels > 1U
            ? (std::isfinite(frame[1]) ? std::clamp(frame[1], -kMaximumInput, kMaximumInput) : 0.0f)
            : left;
        const float mono = processedChannels > 1U ? (left + right) * 0.5f : left;

        const float sensitivity = std::clamp(sensitivity_.next(), 0.0f, 100.0f);
        const double absolute = std::fabs(static_cast<double>(mono));
        const double envelopeCoefficient = absolute > envelope_ ? attackCoefficient_ : releaseCoefficient_;
        envelope_ = (envelopeCoefficient * envelope_) + ((1.0 - envelopeCoefficient) * absolute);
        const double gate = sensitivityGate(sensitivity);

        decimatorState_ += 0.5 * (static_cast<double>(mono) - decimatorState_);
        ++decimationPhase_;
        if (decimationPhase_ >= decimationFactor_) {
            decimationPhase_ = 0U;
            if (envelope_ > gate) pushTrackerSample(static_cast<float>(decimatorState_));
        }

        float wet = 0.0f;
        if (trackedHz_ > 0.0f && envelope_ > gate) {
            const float semitones = std::clamp(octave_.next(), -24.0f, 24.0f);
            const double frequency = std::clamp(
                static_cast<double>(trackedHz_) * std::exp2(static_cast<double>(semitones) / 12.0),
                20.0, static_cast<double>(sampleRate()) * 0.20);
            const double increment = frequency / static_cast<double>(sampleRate());
            const unsigned int shape = static_cast<unsigned int>(std::clamp(
                std::round(waveform_.next()), 0.0f, 2.0f));
            const float main = oscillatorSample(shape, oscillatorPhase_, increment);
            const double subIncrement = increment * 0.5;
            const float sub = oscillatorSample(1U, subPhase_, subIncrement);
            oscillatorPhase_ = wrappedPhase(oscillatorPhase_ + increment);
            subPhase_ = wrappedPhase(subPhase_ + subIncrement);

            if ((filterUpdateCount_++ & 7U) == 0U) (void)configureFilter(toneHz_.next());
            const float oscillator = (0.82f * main) + (0.18f * sub);
            const float level = static_cast<float>(std::clamp(envelope_ * 3.0, 0.0, 1.0));
            const float filtered = filter_.process(oscillator * level).lowPass;
            wet = std::isfinite(filtered)
                ? std::clamp(filtered, -kMaximumOutput, kMaximumOutput) : 0.0f;
        } else {
            // Continue the smoothers through silence so parameter edits do not
            // restart a ramp when the next note arrives.
            (void)octave_.next();
            (void)waveform_.next();
            (void)toneHz_.next();
            oscillatorPhase_ = wrappedPhase(oscillatorPhase_ + 0.00001);
            subPhase_ = wrappedPhase(subPhase_ + 0.000005);
        }

        const float mix = std::clamp(mixPercent_.next() * 0.01f, 0.0f, 1.0f);
        for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
            const float dry = channel == 0U ? left : right;
            const float output = (dry * (1.0f - mix)) + (wet * mix);
            frame[channel] = std::isfinite(output)
                ? std::clamp(output, -kMaximumOutput, kMaximumOutput) : 0.0f;
        }
    }
};

class NativeCatalogVinylFlick final : public NativeEffectProcessor {
public:
    explicit NativeCatalogVinylFlick(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativeVinylFlickProcessor processor_{};
    NativeVinylFlickConfig config_{-100.0f, 1.5f, 35.0f, 100.0f};

    [[nodiscard]] bool onPrepare() noexcept override {
        return processor_.setConfig(config_, 0U) && processor_.prepare(sampleRate());
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId, float value, std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "speed_percent") config_.speedPercent = value;
        else if (parameterId == "motor_return_seconds") config_.motorReturnSeconds = value;
        else if (parameterId == "brake_percent") config_.brakePercent = value;
        else if (parameterId == "mix_percent") config_.mixPercent = value;
        else return false;
        return processor_.setConfig(config_, rampFrames);
    }

    void onResetState() noexcept override { processor_.reset(); }

    void processEffectFrame(float* frame, unsigned int channels) noexcept override {
        (void)processor_.processInPlace(frame, 1U, channels);
    }
};

class NativeCatalogTranspose final : public NativeEffectProcessor {
public:
    explicit NativeCatalogTranspose(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativePolyPitchProcessor processor_{};
    dsp::ParameterSmoother semitones_{0.0f};
    float appliedSemitones_ = 0.0f;

    [[nodiscard]] bool onPrepare() noexcept override {
        const float initialSemitones = semitones_.target();
        semitones_.reset(initialSemitones);
        appliedSemitones_ = initialSemitones;
        return processor_.prepareForFx(sampleRate(), initialSemitones);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId != "shift_semitones") return false;
        semitones_.setTarget(value, rampFrames);
        return true;
    }

    void onResetState() noexcept override {
        const float target = semitones_.target();
        processor_.reset();
        semitones_.reset(target);
        appliedSemitones_ = target;
    }

    void processEffectFrame(float*, unsigned int) noexcept override {
        // This is a block processor. NativeEffectProcessor dispatches its
        // Signalsmith algorithm through processEffectBlock() below.
    }

    [[nodiscard]] bool processEffectBlock(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept override {
        if (channels == 0U || channels > NativePolyPitchProcessor::kMaximumChannels) return false;
        constexpr unsigned int kPitchParameterUpdateFrames = 64U;
        unsigned int processedFrames = 0U;
        while (processedFrames < frames) {
            const auto chunkFrames = std::min(kPitchParameterUpdateFrames, frames - processedFrames);
            float nextSemitones = appliedSemitones_;
            for (unsigned int frame = 0U; frame < chunkFrames; ++frame) nextSemitones = semitones_.next();
            if (nextSemitones != appliedSemitones_) {
                if (!processor_.setSemitones(nextSemitones)) return false;
                appliedSemitones_ = nextSemitones;
            }
            float* const chunk = interleaved + static_cast<std::size_t>(processedFrames) * channels;
            if (!processor_.processInterleaved(chunk, chunkFrames, channels)) return false;
            processedFrames += chunkFrames;
        }
        return true;
    }

    [[nodiscard]] unsigned int algorithmicLatencySamples() const noexcept override {
        return processor_.latencySamples();
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }
};

// Experimental clean-room AUTO RIFF combines a bounded onset/YIN analyzer and
// sample-clocked scale sequence with the pinned Signalsmith LIVE_FX engine.
// NativeEffectProcessor owns the single latency-aligned dry/wet mix; the core's
// internal mix is therefore fixed to 100% wet in this catalog adapter.
class NativeCatalogAutoRiff final : public NativeEffectProcessor {
public:
    explicit NativeCatalogAutoRiff(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    NativeAutoRiffCore core_{};

    [[nodiscard]] bool onPrepare() noexcept override {
        return core_.prepare(sampleRate()) && core_.setParameter("mix", 100.0f);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        (void)rampFrames;
        if (parameterId == "bpm") return core_.setTempoBpm(value);
        if (parameterId == "scale") return core_.setParameter("scale", value);
        if (parameterId == "rate_beats") return core_.setParameter("rate", value);
        if (parameterId == "sensitivity_percent") return core_.setParameter("sensitivity", value);
        return false;
    }

    void onResetState() noexcept override { core_.reset(); }

    void processEffectFrame(float*, unsigned int) noexcept override {}

    [[nodiscard]] bool processEffectBlock(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept override {
        return core_.processInterleaved(interleaved, frames, channels);
    }

    [[nodiscard]] unsigned int algorithmicLatencySamples() const noexcept override {
        return core_.latencySamples();
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }
};

// ROBOT uses the bounded YIN tracker and Signalsmith shifter in the clean-room
// core. Scalar parameter edits use the core's DSP-owner-thread RT-safe setters;
// NativeEffectProcessor owns the latency-aligned dry/wet mix.
class NativeCatalogRobot final : public NativeEffectProcessor {
public:
    explicit NativeCatalogRobot(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr unsigned int kMaximumBlockFrames = 4096U;
    NativeRobotCore core_{};
    std::array<float, static_cast<std::size_t>(kMaximumBlockFrames) * 2U> monoScratch_{};
    float pitchSemitones_ = 0.0f;
    float formantSemitones_ = 0.0f;

    [[nodiscard]] bool onPrepare() noexcept override {
        NativeRobotCore::Config config{};
        config.sampleRate = sampleRate();
        config.channels = 2U;
        config.pitchMode = NativeRobotCore::PitchMode::NearestSemitone;
        config.pitchSemitones = pitchSemitones_;
        config.formantPolicy = NativeRobotCore::FormantPolicy::IndependentShift;
        config.formantSemitones = formantSemitones_;
        // The base processor applies the one and only latency-aligned mix.
        config.mixPercent = 100.0f;
        return core_.prepare(config);
    }

    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value,
                                      std::uint64_t rampFrames) noexcept override {
        (void)rampFrames;
        if (parameterId == "pitch_semitones") {
            if (!core_.setPitchSemitones(value)) return false;
            pitchSemitones_ = value;
            return true;
        }
        if (parameterId == "formant_semitones") {
            if (!core_.setFormantSemitones(value)) return false;
            formantSemitones_ = value;
            return true;
        }
        return false; // mix_percent is consumed by the base class
    }

    void onResetState() noexcept override { core_.reset(); }

    void processEffectFrame(float*, unsigned int) noexcept override {
        // The tracker and shifter run as a bounded block in processEffectBlock.
    }

    [[nodiscard]] bool processEffectBlock(float* interleaved, unsigned int frames,
                                          unsigned int channels) noexcept override {
        if (interleaved == nullptr || frames > kMaximumBlockFrames || channels == 0U || channels > 2U) {
            return false;
        }
        if (channels == 2U) return core_.processInterleaved(interleaved, frames, 2U);

        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const float sample = interleaved[frame];
            const std::size_t offset = static_cast<std::size_t>(frame) * 2U;
            monoScratch_[offset] = sample;
            monoScratch_[offset + 1U] = sample;
        }
        if (!core_.processInterleaved(monoScratch_.data(), frames, 2U)) return false;
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            interleaved[frame] = monoScratch_[static_cast<std::size_t>(frame) * 2U];
        }
        return true;
    }

    [[nodiscard]] unsigned int algorithmicLatencySamples() const noexcept override {
        return core_.latencyFrames();
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }
};

class NativeCatalogPitchBend final : public NativeEffectProcessor {
public:
    explicit NativeCatalogPitchBend(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr unsigned int kMaximumBlockFrames = 4096U;
    static constexpr unsigned int kParameterUpdateFrames = 32U;
    NativePolyPitchProcessor processor_{};
    std::array<float, kMaximumBlockFrames * NativePolyPitchProcessor::kMaximumChannels> pitchScratch_{};
    float rangeSemitones_ = 12.0f;
    float timeMs_ = 500.0f;
    float direction_ = 0.0f;
    float appliedSemitones_ = 0.0f;
    std::uint64_t elapsedFrames_ = 0U;
    bool sweepArmed_ = false;

    [[nodiscard]] std::uint64_t sweepDurationFrames() const noexcept {
        const double frames = static_cast<double>(sampleRate()) * static_cast<double>(timeMs_) / 1000.0;
        return static_cast<std::uint64_t>(std::max(1.0, std::round(frames)));
    }

    [[nodiscard]] float targetSemitones() const noexcept {
        const auto durationFrames = sweepDurationFrames();
        const double progress = std::min(1.0, static_cast<double>(elapsedFrames_) /
            static_cast<double>(durationFrames));
        const double sign = direction_ == 0.0f ? 1.0 : -1.0;
        return static_cast<float>(sign * static_cast<double>(rangeSemitones_) * progress);
    }

    void restartSweep() noexcept {
        elapsedFrames_ = 0U;
        appliedSemitones_ = 0.0f;
        if (processor_.prepared() && processor_.setSemitones(0.0f)) {
            sweepArmed_ = true;
        } else {
            sweepArmed_ = false;
        }
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        elapsedFrames_ = 0U;
        appliedSemitones_ = 0.0f;
        sweepArmed_ = true; // A newly selected, active slot starts its first sweep.
        return processor_.prepareForFx(sampleRate(), 0.0f);
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        (void)rampFrames;
        if (parameterId == "range") {
            if (value == rangeSemitones_) return true;
            rangeSemitones_ = value;
        } else if (parameterId == "time_ms") {
            if (value == timeMs_) return true;
            timeMs_ = value;
        } else if (parameterId == "direction") {
            if (value == direction_) return true;
            direction_ = value;
        }
        else return false;
        if (!isBypassed()) restartSweep();
        return true;
    }

    void onBypassChanged(bool bypassed) noexcept override {
        if (bypassed) {
            sweepArmed_ = false;
            return;
        }

        restartSweep();
    }

    void onResetState() noexcept override {
        elapsedFrames_ = 0U;
        appliedSemitones_ = 0.0f;
        if (processor_.prepared() && processor_.setSemitones(0.0f)) processor_.reset();
        sweepArmed_ = !isBypassed();
    }

    void processEffectFrame(float*, unsigned int) noexcept override {}

    [[nodiscard]] bool processEffectBlock(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept override {
        if (interleaved == nullptr || frames > kMaximumBlockFrames || channels == 0U ||
            channels > NativePolyPitchProcessor::kMaximumChannels) return false;
        const unsigned int pitchChannels = channels > 1U ? 2U : 1U;
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const auto sourceOffset = static_cast<std::size_t>(frame) * channels;
            const auto pitchOffset = static_cast<std::size_t>(frame) * pitchChannels;
            pitchScratch_[pitchOffset] = interleaved[sourceOffset];
            if (pitchChannels == 2U) pitchScratch_[pitchOffset + 1U] = interleaved[sourceOffset + 1U];
        }

        unsigned int processedFrames = 0U;
        while (processedFrames < frames) {
            const auto chunkFrames = std::min(kParameterUpdateFrames, frames - processedFrames);
            const float nextSemitones = (!isBypassed() && sweepArmed_) ? targetSemitones() : 0.0f;
            if (nextSemitones != appliedSemitones_) {
                if (!processor_.setSemitones(nextSemitones)) return false;
                appliedSemitones_ = nextSemitones;
            }

            float* const chunk = pitchScratch_.data() + static_cast<std::size_t>(processedFrames) * pitchChannels;
            if (!processor_.processInterleaved(chunk, chunkFrames, pitchChannels)) return false;
            if (!isBypassed() && sweepArmed_) {
                const auto durationFrames = sweepDurationFrames();
                elapsedFrames_ = std::min(durationFrames, elapsedFrames_ + chunkFrames);
            }
            processedFrames += chunkFrames;
        }

        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const auto destinationOffset = static_cast<std::size_t>(frame) * channels;
            const auto pitchOffset = static_cast<std::size_t>(frame) * pitchChannels;
            interleaved[destinationOffset] = pitchScratch_[pitchOffset];
            if (channels > 1U) interleaved[destinationOffset + 1U] = pitchScratch_[pitchOffset + 1U];
        }
        return true;
    }

    [[nodiscard]] unsigned int algorithmicLatencySamples() const noexcept override {
        return processor_.latencySamples();
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }
};

// Keep the original as the dry voice and add two independently pitch-shifted
// Signalsmith voices, with one stereo pan control for their combined bus.
class NativeCatalogManualHarmonist final : public NativeEffectProcessor {
public:
    explicit NativeCatalogManualHarmonist(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr unsigned int kMaximumBlockFrames = 4096U;
    static constexpr unsigned int kControlUpdateFrames = 64U;
    NativePolyPitchProcessor voice1Processor_{};
    NativePolyPitchProcessor voice2Processor_{};
    std::array<float, kMaximumBlockFrames * NativePolyPitchProcessor::kMaximumChannels> voice1Scratch_{};
    std::array<float, kMaximumBlockFrames * NativePolyPitchProcessor::kMaximumChannels> voice2Scratch_{};
    std::vector<float> dryAlignmentDelay_{};
    unsigned int dryAlignmentWriteFrame_ = 0U;
    dsp::ParameterSmoother voice1Interval_{7.0f};
    dsp::ParameterSmoother voice2Interval_{12.0f};
    dsp::ParameterSmoother voicePanPercent_{0.0f};
    float appliedVoice1Interval_ = 7.0f;
    float appliedVoice2Interval_ = 12.0f;

    [[nodiscard]] bool onPrepare() noexcept override {
        const float initialVoice1Interval = voice1Interval_.target();
        const float initialVoice2Interval = voice2Interval_.target();
        voice1Interval_.reset(initialVoice1Interval);
        voice2Interval_.reset(initialVoice2Interval);
        voicePanPercent_.reset(voicePanPercent_.target());
        appliedVoice1Interval_ = initialVoice1Interval;
        appliedVoice2Interval_ = initialVoice2Interval;
        dryAlignmentDelay_.clear();
        dryAlignmentWriteFrame_ = 0U;
        if (!voice1Processor_.prepareForFx(sampleRate(), initialVoice1Interval) ||
            !voice2Processor_.prepareForFx(sampleRate(), initialVoice2Interval) ||
            voice1Processor_.latencySamples() != voice2Processor_.latencySamples()) return false;
        try {
            dryAlignmentDelay_.assign(
                static_cast<std::size_t>(voice1Processor_.latencySamples()) *
                    NativePolyPitchProcessor::kMaximumChannels,
                0.0f);
        } catch (...) {
            dryAlignmentDelay_.clear();
            return false;
        }
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "voice_1_interval") {
            voice1Interval_.setTarget(value, rampFrames);
            return true;
        }
        if (parameterId == "voice_2_interval") {
            voice2Interval_.setTarget(value, rampFrames);
            return true;
        }
        if (parameterId == "pan_percent") {
            voicePanPercent_.setTarget(value, rampFrames);
            return true;
        }
        return false;
    }

    void onResetState() noexcept override {
        const float targetVoice1Interval = voice1Interval_.target();
        const float targetVoice2Interval = voice2Interval_.target();
        voice1Processor_.reset();
        voice2Processor_.reset();
        voice1Interval_.reset(targetVoice1Interval);
        voice2Interval_.reset(targetVoice2Interval);
        voicePanPercent_.reset(voicePanPercent_.target());
        appliedVoice1Interval_ = targetVoice1Interval;
        appliedVoice2Interval_ = targetVoice2Interval;
        std::fill(dryAlignmentDelay_.begin(), dryAlignmentDelay_.end(), 0.0f);
        dryAlignmentWriteFrame_ = 0U;
    }

    void processEffectFrame(float*, unsigned int) noexcept override {}

    [[nodiscard]] bool processEffectBlock(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept override {
        if (interleaved == nullptr || channels == 0U ||
            channels > NativePolyPitchProcessor::kMaximumChannels || frames > kMaximumBlockFrames ||
            dryAlignmentDelay_.empty() || voice1Processor_.latencySamples() == 0U) return false;
        const unsigned int pitchChannels = channels;
        const unsigned int latencyFrames = voice1Processor_.latencySamples();

        // Keep the wet-path dry voice aligned with Signalsmith. The base
        // processor has the same delay for its dry/wet transition, so the
        // additive harmony bus can be mixed without weakening the dry voice.
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const auto sourceOffset = static_cast<std::size_t>(frame) * channels;
            const auto delayOffset = static_cast<std::size_t>(dryAlignmentWriteFrame_) * 2U;
            const float inputLeft = interleaved[sourceOffset];
            const float inputRight = channels > 1U ? interleaved[sourceOffset + 1U] : inputLeft;
            const float delayedLeft = dryAlignmentDelay_[delayOffset];
            const float delayedRight = dryAlignmentDelay_[delayOffset + 1U];
            dryAlignmentDelay_[delayOffset] = inputLeft;
            dryAlignmentDelay_[delayOffset + 1U] = inputRight;
            interleaved[sourceOffset] = delayedLeft;
            if (channels > 1U) interleaved[sourceOffset + 1U] = delayedRight;
            dryAlignmentWriteFrame_ = (dryAlignmentWriteFrame_ + 1U) % latencyFrames;

            const auto voiceOffset = static_cast<std::size_t>(frame) * pitchChannels;
            voice1Scratch_[voiceOffset] = inputLeft;
            voice2Scratch_[voiceOffset] = inputLeft;
            if (channels > 1U) {
                voice1Scratch_[voiceOffset + 1U] = inputRight;
                voice2Scratch_[voiceOffset + 1U] = inputRight;
            }
        }

        unsigned int processedFrames = 0U;
        while (processedFrames < frames) {
            const auto chunkFrames = std::min(kControlUpdateFrames, frames - processedFrames);
            float nextVoice1Interval = appliedVoice1Interval_;
            float nextVoice2Interval = appliedVoice2Interval_;
            for (unsigned int frame = 0U; frame < chunkFrames; ++frame) {
                nextVoice1Interval = voice1Interval_.next();
                nextVoice2Interval = voice2Interval_.next();
            }
            if (nextVoice1Interval != appliedVoice1Interval_) {
                if (!voice1Processor_.setSemitones(nextVoice1Interval)) return false;
                appliedVoice1Interval_ = nextVoice1Interval;
            }
            if (nextVoice2Interval != appliedVoice2Interval_) {
                if (!voice2Processor_.setSemitones(nextVoice2Interval)) return false;
                appliedVoice2Interval_ = nextVoice2Interval;
            }
            const auto sampleOffset = static_cast<std::size_t>(processedFrames) * pitchChannels;
            if (!voice1Processor_.processInterleaved(voice1Scratch_.data() + sampleOffset,
                    chunkFrames, pitchChannels) ||
                !voice2Processor_.processInterleaved(voice2Scratch_.data() + sampleOffset,
                    chunkFrames, pitchChannels)) return false;
            processedFrames += chunkFrames;
        }

        constexpr double kPi = 3.141592653589793238462643383279502884;
        bool unsupportedMonoPan = false;
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const float pan = std::clamp(voicePanPercent_.next(), -100.0f, 100.0f);
            if (channels == 1U && pan != 0.0f) unsupportedMonoPan = true;
            const double angle = (static_cast<double>(pan) / 100.0 + 1.0) * (kPi * 0.25);
            const float leftGain = static_cast<float>(std::cos(angle) * 1.4142135623730951);
            const float rightGain = static_cast<float>(std::sin(angle) * 1.4142135623730951);
            const auto voiceOffset = static_cast<std::size_t>(frame) * pitchChannels;
            const float voice1 = pitchChannels == 2U
                ? 0.5f * (voice1Scratch_[voiceOffset] + voice1Scratch_[voiceOffset + 1U])
                : voice1Scratch_[voiceOffset];
            const float voice2 = pitchChannels == 2U
                ? 0.5f * (voice2Scratch_[voiceOffset] + voice2Scratch_[voiceOffset + 1U])
                : voice2Scratch_[voiceOffset];
            const float harmonyBus = voice1 + voice2;
            const auto outputOffset = static_cast<std::size_t>(frame) * channels;
            interleaved[outputOffset] += harmonyBus * leftGain;
            if (channels > 1U) interleaved[outputOffset + 1U] += harmonyBus * rightGain;
        }

        // Mono has no right channel for a non-center pan. Let the base class
        // fail closed to latency-aligned dry rather than silently ignoring pan.
        return !unsupportedMonoPan;
    }

    [[nodiscard]] unsigned int algorithmicLatencySamples() const noexcept override {
        return voice1Processor_.latencySamples();
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }
};

// OCTAVE is a fixed three-voice pitch layer. The independent Signalsmith
// streams intentionally do not infer pitch or pretend to preserve formants.
// Full-level dry stays underneath the mix-controlled harmony bus.
class NativeCatalogOctave final : public NativeEffectProcessor {
public:
    explicit NativeCatalogOctave(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr unsigned int kMaximumBlockFrames = 4096U;
    static constexpr unsigned int kChannels = NativePolyPitchProcessor::kMaximumChannels;
    NativePolyPitchProcessor minus24Processor_{};
    NativePolyPitchProcessor minus12Processor_{};
    NativePolyPitchProcessor plus12Processor_{};
    std::array<float, kMaximumBlockFrames * kChannels> minus24Scratch_{};
    std::array<float, kMaximumBlockFrames * kChannels> minus12Scratch_{};
    std::array<float, kMaximumBlockFrames * kChannels> plus12Scratch_{};
    std::vector<float> dryAlignmentDelay_{};
    unsigned int maximumVoiceLatencySamples_ = 0U;
    unsigned int dryAlignmentWriteFrame_ = 0U;
    dsp::ParameterSmoother minus24Level_{0.0f};
    dsp::ParameterSmoother minus12Level_{40.0f};
    dsp::ParameterSmoother plus12Level_{0.0f};

    [[nodiscard]] bool onPrepare() noexcept override {
        const float initialMinus24Level = minus24Level_.target();
        const float initialMinus12Level = minus12Level_.target();
        const float initialPlus12Level = plus12Level_.target();
        minus24Level_.reset(initialMinus24Level);
        minus12Level_.reset(initialMinus12Level);
        plus12Level_.reset(initialPlus12Level);
        dryAlignmentDelay_.clear();
        dryAlignmentWriteFrame_ = 0U;
        maximumVoiceLatencySamples_ = 0U;

        if (!minus24Processor_.prepareForFx(sampleRate(), -24.0f) ||
            !minus12Processor_.prepareForFx(sampleRate(), -12.0f) ||
            !plus12Processor_.prepareForFx(sampleRate(), 12.0f)) return false;
        maximumVoiceLatencySamples_ = std::max({
            minus24Processor_.latencySamples(),
            minus12Processor_.latencySamples(),
            plus12Processor_.latencySamples(),
        });
        if (maximumVoiceLatencySamples_ == 0U) return false;
        try {
            dryAlignmentDelay_.assign(
                static_cast<std::size_t>(maximumVoiceLatencySamples_) * kChannels,
                0.0f);
        } catch (...) {
            dryAlignmentDelay_.clear();
            maximumVoiceLatencySamples_ = 0U;
            return false;
        }
        return true;
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        if (parameterId == "minus_24_level") {
            minus24Level_.setTarget(value, rampFrames);
            return true;
        }
        if (parameterId == "minus_12_level") {
            minus12Level_.setTarget(value, rampFrames);
            return true;
        }
        if (parameterId == "plus_12_level") {
            plus12Level_.setTarget(value, rampFrames);
            return true;
        }
        return false;
    }

    void onResetState() noexcept override {
        minus24Processor_.reset();
        minus12Processor_.reset();
        plus12Processor_.reset();
        minus24Level_.reset(minus24Level_.target());
        minus12Level_.reset(minus12Level_.target());
        plus12Level_.reset(plus12Level_.target());
        std::fill(dryAlignmentDelay_.begin(), dryAlignmentDelay_.end(), 0.0f);
        dryAlignmentWriteFrame_ = 0U;
    }

    void processEffectFrame(float*, unsigned int) noexcept override {}

    [[nodiscard]] bool processEffectBlock(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept override {
        if (interleaved == nullptr || channels == 0U || channels > kChannels ||
            frames > kMaximumBlockFrames || dryAlignmentDelay_.empty() ||
            maximumVoiceLatencySamples_ == 0U) return false;

        // Stage the same mono/stereo source independently for all three fixed
        // voices while producing the matching max-latency dry signal.
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const auto sourceOffset = static_cast<std::size_t>(frame) * channels;
            const float inputLeft = std::isfinite(interleaved[sourceOffset])
                ? interleaved[sourceOffset] : 0.0f;
            const float inputRight = channels > 1U && std::isfinite(interleaved[sourceOffset + 1U])
                ? interleaved[sourceOffset + 1U] : inputLeft;
            const auto delayOffset = static_cast<std::size_t>(dryAlignmentWriteFrame_) * kChannels;
            const float delayedLeft = dryAlignmentDelay_[delayOffset];
            const float delayedRight = dryAlignmentDelay_[delayOffset + 1U];
            dryAlignmentDelay_[delayOffset] = inputLeft;
            dryAlignmentDelay_[delayOffset + 1U] = inputRight;
            interleaved[sourceOffset] = delayedLeft;
            if (channels > 1U) interleaved[sourceOffset + 1U] = delayedRight;
            dryAlignmentWriteFrame_ = (dryAlignmentWriteFrame_ + 1U) % maximumVoiceLatencySamples_;

            const auto voiceOffset = static_cast<std::size_t>(frame) * channels;
            minus24Scratch_[voiceOffset] = inputLeft;
            minus12Scratch_[voiceOffset] = inputLeft;
            plus12Scratch_[voiceOffset] = inputLeft;
            if (channels > 1U) {
                minus24Scratch_[voiceOffset + 1U] = inputRight;
                minus12Scratch_[voiceOffset + 1U] = inputRight;
                plus12Scratch_[voiceOffset + 1U] = inputRight;
            }
        }

        if (!minus24Processor_.processInterleaved(minus24Scratch_.data(), frames, channels) ||
            !minus12Processor_.processInterleaved(minus12Scratch_.data(), frames, channels) ||
            !plus12Processor_.processInterleaved(plus12Scratch_.data(), frames, channels)) return false;

        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const float minus24Gain = minus24Level_.next() * 0.01f;
            const float minus12Gain = minus12Level_.next() * 0.01f;
            const float plus12Gain = plus12Level_.next() * 0.01f;
            const auto sampleOffset = static_cast<std::size_t>(frame) * channels;
            for (unsigned int channel = 0U; channel < channels; ++channel) {
                const float voice24 = minus24Scratch_[sampleOffset + channel];
                const float voice12 = minus12Scratch_[sampleOffset + channel];
                const float voiceUp = plus12Scratch_[sampleOffset + channel];
                const float harmony =
                    (std::isfinite(voice24) ? voice24 : 0.0f) * minus24Gain +
                    (std::isfinite(voice12) ? voice12 : 0.0f) * minus12Gain +
                    (std::isfinite(voiceUp) ? voiceUp : 0.0f) * plus12Gain;
                const float output = interleaved[sampleOffset + channel] + harmony;
                interleaved[sampleOffset + channel] = std::isfinite(output) ? output : 0.0f;
            }
        }
        return true;
    }

    [[nodiscard]] unsigned int algorithmicLatencySamples() const noexcept override {
        return maximumVoiceLatencySamples_;
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }
};

// Clean-room sample-clocked filterbank vocoder. The reusable core shares one
// ERB analysis/envelope bank per audio channel; input and generated saw/square
// carriers are handled by the same resynthesis filters. The host owns wet/dry
// alignment and mix, while fixed arrays keep the callback allocation-free.
class NativeCatalogVocoder final : public NativeEffectProcessor {
public:
    explicit NativeCatalogVocoder(const NativeEffectDescriptor& descriptor) noexcept
        : NativeEffectProcessor(descriptor) {}

private:
    static constexpr unsigned int kMaximumBlockFrames = 4096U;
    NativeVocoderCore leftCore_{};
    NativeVocoderCore rightCore_{};
    NativeVocoderConfig config_{};
    std::array<float, kMaximumBlockFrames> leftScratch_{};
    std::array<float, kMaximumBlockFrames> rightScratch_{};

    [[nodiscard]] bool applyConfig() noexcept {
        // The core produces the wet-only signal. NativeEffectProcessor applies
        // the user mix and aligned bypass path around it.
        config_.wetMix = 1.0f;
        config_.enabled = true;
        return leftCore_.setConfig(config_) && rightCore_.setConfig(config_);
    }

    [[nodiscard]] bool onPrepare() noexcept override {
        config_ = NativeVocoderConfig{};
        config_.bands = 16U;
        config_.carrier = NativeVocoderCarrier::Saw;
        config_.wetMix = 1.0f;
        config_.enabled = true;
        return leftCore_.prepare(sampleRate()) && rightCore_.prepare(sampleRate()) && applyConfig();
    }

    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override {
        (void)rampFrames;
        if (parameterId == "bands") {
            config_.bands = static_cast<std::size_t>(value);
            return applyConfig();
        }
        if (parameterId == "carrier") {
            config_.carrier = static_cast<NativeVocoderCarrier>(static_cast<std::uint8_t>(value));
            return applyConfig();
        }
        return false;
    }

    void onResetState() noexcept override {
        leftCore_.reset();
        rightCore_.reset();
    }

    void processEffectFrame(float*, unsigned int) noexcept override {}

    [[nodiscard]] bool processEffectBlock(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept override {
        if (interleaved == nullptr || frames == 0U || frames > kMaximumBlockFrames ||
            channels == 0U || channels > 2U) return false;
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const auto offset = static_cast<std::size_t>(frame) * channels;
            leftScratch_[frame] = std::isfinite(interleaved[offset]) ? interleaved[offset] : 0.0f;
            if (channels > 1U) {
                rightScratch_[frame] = std::isfinite(interleaved[offset + 1U])
                    ? interleaved[offset + 1U] : 0.0f;
            }
        }
        if (!leftCore_.process(leftScratch_.data(), nullptr, leftScratch_.data(), frames)) return false;
        if (channels > 1U && !rightCore_.process(rightScratch_.data(), nullptr, rightScratch_.data(), frames)) {
            return false;
        }
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const auto offset = static_cast<std::size_t>(frame) * channels;
            interleaved[offset] = leftScratch_[frame];
            if (channels > 1U) interleaved[offset + 1U] = rightScratch_[frame];
        }
        return true;
    }

    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return true; }
};

} // namespace

const NativeEffectDescriptor* nativeEffectCatalog(std::size_t& count) noexcept {
    count = sizeof(kCatalog) / sizeof(kCatalog[0]);
    return kCatalog;
}

const NativeEffectDescriptor* findNativeEffectDescriptor(std::string_view stableId) noexcept {
    std::size_t count = 0U;
    const auto* catalog = nativeEffectCatalog(count);
    for (std::size_t index = 0U; index < count; ++index) {
        if (catalog[index].id == stableId) return &catalog[index];
    }
    return nullptr;
}

bool nativeEffectSupportsPerTrackInsert(std::string_view stableId) noexcept {
    const auto* descriptor = findNativeEffectDescriptor(stableId);
    return descriptor != nullptr && descriptor->trackAvailable &&
        descriptor->id != "vinyl_flick" && descriptor->id != "beat_shift";
}

const NativeEffectParameterDescriptor* findNativeEffectParameter(
    std::string_view stableEffectId,
    std::string_view parameterId
) noexcept {
    const auto* effect = findNativeEffectDescriptor(stableEffectId);
    if (effect == nullptr) return nullptr;
    for (std::size_t index = 0U; index < effect->parameterCount; ++index) {
        if (effect->parameters[index].id == parameterId) return &effect->parameters[index];
    }
    return nullptr;
}

NativeEffectProcessor::NativeEffectProcessor(const NativeEffectDescriptor& descriptor) noexcept
    : descriptor_(&descriptor) {}

std::uint64_t NativeEffectProcessor::defaultRampFrames(unsigned int smoothingMs) const noexcept {
    if (sampleRate_ == 0U) return 64U;
    const double frames = static_cast<double>(sampleRate_) * static_cast<double>(smoothingMs) / 1000.0;
    return static_cast<std::uint64_t>(std::max(1.0, std::round(frames)));
}

bool NativeEffectProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) return false;
    sampleRate_ = sampleRate;
    if (!onPrepare()) {
        sampleRate_ = 0U;
        return false;
    }
    const unsigned int latency = algorithmicLatencySamples();
    try {
        if (latency > 0U) {
            dryDelayRing_.assign(static_cast<std::size_t>(latency) * 2U, 0.0f);
            dryDelayGenerationTags_.assign(latency, 0U);
        } else {
            dryDelayRing_.clear();
            dryDelayGenerationTags_.clear();
        }
    } catch (...) {
        dryDelayRing_.clear();
        dryDelayGenerationTags_.clear();
        sampleRate_ = 0U;
        return false;
    }
    dryDelayFrames_ = latency;
    dryDelayWriteFrame_ = 0U;
    dryDelayGeneration_ = 1U;
    processingFaulted_ = false;
    bypassMix_.reset(bypassed_ ? 1.0f : 0.0f);
    float initialWetMix = 1.0f;
    if (usesBaseWetMix()) {
        for (std::size_t index = 0U; index < descriptor_->parameterCount; ++index) {
            const auto& parameter = descriptor_->parameters[index];
            if (parameter.id == "mix_percent") {
                initialWetMix = std::clamp(parameter.defaultValue, 0.0f, 100.0f) / 100.0f;
                break;
            }
        }
    }
    wetMix_.reset(initialWetMix);
    return true;
}

bool NativeEffectProcessor::setParameter(std::string_view parameterId, float value, std::uint64_t rampFrames) noexcept {
    const auto* parameter = findNativeEffectParameter(stableId(), parameterId);
    if (parameter == nullptr || !std::isfinite(value) || value < parameter->minimum || value > parameter->maximum) {
        return false;
    }
    if (parameter->discrete) {
        bool supportedValue = false;
        for (std::size_t index = 0U; index < parameter->discreteValueCount; ++index) {
            if (value == parameter->discreteValues[index]) {
                supportedValue = true;
                break;
            }
        }
        if (!supportedValue) return false;
    }
    const auto actualRamp = rampFrames == 0U ? defaultRampFrames(parameter->smoothingMs) : rampFrames;
    if (usesBaseWetMix() && parameterId == "mix_percent") {
        wetMix_.setTarget(value / 100.0f, actualRamp);
        return true;
    }
    return onSetParameter(parameterId, value, actualRamp);
}

void NativeEffectProcessor::setBypassed(bool bypassed, std::uint64_t rampFrames) noexcept {
    const bool changed = bypassed_ != bypassed;
    bypassed_ = bypassed;
    if (changed) onBypassChanged(bypassed);
    const auto actualRamp = rampFrames == 0U ? defaultRampFrames(10U) : rampFrames;
    bypassMix_.setTarget(bypassed ? 1.0f : 0.0f, actualRamp);
}

void NativeEffectProcessor::resetState() noexcept {
    if (sampleRate_ == 0U) return;
    bypassMix_.reset(bypassed_ ? 1.0f : 0.0f);
    if (usesBaseWetMix()) wetMix_.reset(wetMix_.target());
    dryDelayWriteFrame_ = 0U;
    ++dryDelayGeneration_;
    if (dryDelayGeneration_ == 0U) {
        std::fill(dryDelayGenerationTags_.begin(), dryDelayGenerationTags_.end(), 0U);
        dryDelayGeneration_ = 1U;
    }
    processingFaulted_ = false;
    onResetState();
}

bool NativeEffectProcessor::processEffectBlock(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || channels == 0U) return false;
    for (unsigned int frameIndex = 0U; frameIndex < frames; ++frameIndex) {
        processEffectFrame(interleaved + static_cast<std::size_t>(frameIndex) * channels, channels);
    }
    return true;
}

float NativeEffectProcessor::processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) return 0.0f;
    const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
    constexpr unsigned int kMaximumBlockFrames = 4096U;
    for (unsigned int blockStart = 0U; blockStart < frames;) {
        const unsigned int blockFrames = std::min(kMaximumBlockFrames, frames - blockStart);
        for (unsigned int frameIndex = 0U; frameIndex < blockFrames; ++frameIndex) {
            const std::size_t sourceOffset = static_cast<std::size_t>(blockStart + frameIndex) * channels;
            const std::size_t scratchOffset = static_cast<std::size_t>(frameIndex) * 2U;
            const bool hasHistory = dryDelayFrames_ > 0U &&
                dryDelayGenerationTags_[dryDelayWriteFrame_] == dryDelayGeneration_;
            for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
                const float input = interleaved[sourceOffset + channel];
                float delayed = input;
                if (dryDelayFrames_ > 0U) {
                    const std::size_t delayOffset = static_cast<std::size_t>(dryDelayWriteFrame_) * 2U;
                    delayed = hasHistory ? dryDelayRing_[delayOffset + channel] : 0.0f;
                    dryDelayRing_[delayOffset + channel] = input;
                }
                dryScratch_[scratchOffset + channel] = delayed;
            }
            if (dryDelayFrames_ > 0U) {
                // Tag once after every channel has read the prior generation;
                // otherwise a stereo channel 1 can observe stale history just
                // after reset when channel 0 updates the generation tag.
                dryDelayGenerationTags_[dryDelayWriteFrame_] = dryDelayGeneration_;
                dryDelayWriteFrame_ = (dryDelayWriteFrame_ + 1U) % dryDelayFrames_;
            }
        }

        float* const block = interleaved + static_cast<std::size_t>(blockStart) * channels;
        const bool processed = processEffectBlock(block, blockFrames, channels);
        if (!processed) processingFaulted_ = true;
        for (unsigned int frameIndex = 0U; frameIndex < blockFrames; ++frameIndex) {
            const std::size_t destinationOffset = static_cast<std::size_t>(frameIndex) * channels;
            const std::size_t scratchOffset = static_cast<std::size_t>(frameIndex) * 2U;
            const float bypass = bypassMix_.next();
            const float mix = usesBaseWetMix() ? wetMix_.next() : 1.0f;
            const float wetAmount = processed ? (1.0f - bypass) * mix : 0.0f;
            const float dryAmount = 1.0f - wetAmount;
            // If a block processor fails, explicitly return aligned dry audio
            // and latch a fault for diagnostics instead of silently bypassing.
            for (unsigned int channel = 0U; channel < processedChannels; ++channel) {
                const float dry = dryScratch_[scratchOffset + channel];
                const float wet = processed ? block[destinationOffset + channel] : dry;
                block[destinationOffset + channel] = dry * dryAmount + wet * wetAmount;
            }
        }
        blockStart += blockFrames;
    }

    float peak = 0.0f;
    const std::size_t sampleCount = static_cast<std::size_t>(frames) * channels;
    for (std::size_t index = 0U; index < sampleCount; ++index) peak = std::max(peak, std::fabs(interleaved[index]));
    return peak;
}

std::unique_ptr<NativeEffectProcessor> createNativeEffectProcessor(std::string_view stableId) {
    const auto* descriptor = findNativeEffectDescriptor(stableId);
    if (descriptor == nullptr) return nullptr;
    if (stableId == kLowPassId) return std::make_unique<NativeFilterProcessor>(*descriptor, FilterOutput::LowPass);
    if (stableId == kBandPassId) return std::make_unique<NativeFilterProcessor>(*descriptor, FilterOutput::BandPass);
    if (stableId == kHighPassId) return std::make_unique<NativeFilterProcessor>(*descriptor, FilterOutput::HighPass);
    if (stableId == kPhaserId) return std::make_unique<NativeCatalogPhaser>(*descriptor);
    if (stableId == kFlangerId) return std::make_unique<NativeCatalogFlanger>(*descriptor);
    if (stableId == kDynamicsId) return std::make_unique<NativeCatalogDynamics>(*descriptor);
    if (stableId == kDistortionId) return std::make_unique<NativeCatalogDistortion>(*descriptor);
    if (stableId == kPreampId) return std::make_unique<NativeCatalogPreamp>(*descriptor);
    if (stableId == kReverbId) return std::make_unique<NativeCatalogReverb>(*descriptor);
    if (stableId == kGateReverbId) return std::make_unique<NativeCatalogGateReverb>(*descriptor);
    if (stableId == kBeatRepeatId) return std::make_unique<NativeCatalogBeatRepeat>(*descriptor);
    if (stableId == kBeatScatterId) return std::make_unique<NativeCatalogBeatScatter>(*descriptor);
    if (stableId == kRollId) return std::make_unique<NativeCatalogRoll>(*descriptor);
    if (stableId == kFreezeId) return std::make_unique<NativeCatalogFreeze>(*descriptor);
    if (stableId == kWarpId) return std::make_unique<NativeCatalogWarp>(*descriptor);
    if (stableId == kTapeEchoId) return std::make_unique<NativeCatalogTapeEcho>(*descriptor);
    if (stableId == kReverseDelayId) return std::make_unique<NativeCatalogReverseDelay>(*descriptor);
    if (stableId == kReverseReverbId) return std::make_unique<NativeCatalogReverseReverb>(*descriptor);
    if (stableId == kFractionalDelayId) return std::make_unique<NativeFractionalDelay>(*descriptor);
    if (stableId == kModDelayId) return std::make_unique<NativeCatalogModDelay>(*descriptor);
    if (stableId == kPanningDelayId) return std::make_unique<NativeCatalogPanningDelay>(*descriptor);
    if (stableId == kTwistId) return std::make_unique<NativeCatalogTwist>(*descriptor);
    if (stableId == kGranularDelayId) return std::make_unique<NativeCatalogGranularDelay>(*descriptor);
    if (stableId == kAutoPanId) return std::make_unique<NativeCatalogAutoPan>(*descriptor);
    if (stableId == kManualPanId) return std::make_unique<NativeCatalogManualPan>(*descriptor);
    if (stableId == kChorusId) return std::make_unique<NativeCatalogChorus>(*descriptor);
    if (stableId == kTremoloId) return std::make_unique<NativeCatalogTremolo>(*descriptor);
    if (stableId == kRingModId) return std::make_unique<NativeCatalogRingMod>(*descriptor);
    if (stableId == kEqualizerId) return std::make_unique<NativeCatalogEqualizer>(*descriptor);
    if (stableId == kIsolatorId) return std::make_unique<NativeCatalogIsolator>(*descriptor);
    if (stableId == kStereoEnhanceId) return std::make_unique<NativeCatalogStereoEnhance>(*descriptor);
    if (stableId == kLoFiId) return std::make_unique<NativeCatalogLoFi>(*descriptor);
    if (stableId == kRadioId) return std::make_unique<NativeCatalogRadio>(*descriptor);
    if (stableId == kSustainerId) return std::make_unique<NativeCatalogSustainer>(*descriptor);
    if (stableId == kVibratoId) return std::make_unique<NativeCatalogVibrato>(*descriptor);
    if (stableId == kSlowGearId) return std::make_unique<NativeCatalogSlowGear>(*descriptor);
    if (stableId == kPatternSlicerId) return std::make_unique<NativeCatalogPatternSlicer>(*descriptor);
    if (stableId == kStepSlicerId) return std::make_unique<NativeCatalogStepSlicer>(*descriptor);
    if (stableId == kVinylFlickId) return std::make_unique<NativeCatalogVinylFlick>(*descriptor);
    if (stableId == kSynthId) return std::make_unique<NativeCatalogSynth>(*descriptor);
    if (stableId == kG2BId) return std::make_unique<NativeG2BProcessor>(*descriptor);
    if (stableId == kTransposeId) return std::make_unique<NativeCatalogTranspose>(*descriptor);
    if (stableId == kPitchBendId) return std::make_unique<NativeCatalogPitchBend>(*descriptor);
    if (stableId == kManualHarmonistId) return std::make_unique<NativeCatalogManualHarmonist>(*descriptor);
    if (stableId == kOctaveId) return std::make_unique<NativeCatalogOctave>(*descriptor);
    if (stableId == kVocoderId) return std::make_unique<NativeCatalogVocoder>(*descriptor);
    if (stableId == kOscVocMId) return std::make_unique<NativeOscVocProcessor>(*descriptor);
    if (stableId == kOscBotId) return std::make_unique<NativeOscBotProcessor>(*descriptor);
    if (stableId == kAutoRiffId) return std::make_unique<NativeCatalogAutoRiff>(*descriptor);
    if (stableId == kHrmAutoMId) return std::make_unique<NativeHrmAutoProcessor>(*descriptor);
    if (stableId == kRobotId) return std::make_unique<NativeCatalogRobot>(*descriptor);
    if (stableId == kElectricId) return std::make_unique<NativeElectricProcessor>(*descriptor);
    return nullptr;
}

bool NativeEffectBank::validSlot(NativeEffectSlot slot) noexcept {
    return static_cast<std::size_t>(slot) < kSlotCount;
}

bool NativeEffectBank::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) return false;
    for (auto& effect : slots_) {
        if (effect && !effect->prepare(sampleRate)) return false;
    }
    sampleRate_ = sampleRate;
    return true;
}

bool NativeEffectBank::setEffect(NativeEffectSlot slot, std::string_view stableId) {
    if (!validSlot(slot)) return false;
    auto effect = createNativeEffectProcessor(stableId);
    if (!effect) return false;
    if (sampleRate_ != 0U && !effect->prepare(sampleRate_)) return false;
    slots_[static_cast<std::size_t>(slot)] = std::move(effect);
    return true;
}

bool NativeEffectBank::clearSlot(NativeEffectSlot slot) noexcept {
    if (!validSlot(slot)) return false;
    slots_[static_cast<std::size_t>(slot)].reset();
    return true;
}

bool NativeEffectBank::setParameter(
    NativeEffectSlot slot,
    std::string_view parameterId,
    float value,
    std::uint64_t rampFrames
) noexcept {
    auto* effect = processor(slot);
    return effect != nullptr && effect->setParameter(parameterId, value, rampFrames);
}

bool NativeEffectBank::setBypassed(NativeEffectSlot slot, bool bypassed, std::uint64_t rampFrames) noexcept {
    auto* effect = processor(slot);
    if (effect == nullptr) return false;
    effect->setBypassed(bypassed, rampFrames);
    return true;
}

void NativeEffectBank::resetState() noexcept {
    for (auto& effect : slots_) if (effect) effect->resetState();
}

std::string_view NativeEffectBank::effectId(NativeEffectSlot slot) const noexcept {
    const auto* effect = processor(slot);
    return effect == nullptr ? std::string_view{} : effect->stableId();
}

bool NativeEffectBank::isBypassed(NativeEffectSlot slot) const noexcept {
    const auto* effect = processor(slot);
    return effect != nullptr && effect->isBypassed();
}

bool NativeEffectBank::hasEffects() const noexcept {
    for (const auto& effect : slots_) {
        if (effect) return true;
    }
    return false;
}

NativeEffectProcessor* NativeEffectBank::processor(NativeEffectSlot slot) noexcept {
    if (!validSlot(slot)) return nullptr;
    return slots_[static_cast<std::size_t>(slot)].get();
}

const NativeEffectProcessor* NativeEffectBank::processor(NativeEffectSlot slot) const noexcept {
    if (!validSlot(slot)) return nullptr;
    return slots_[static_cast<std::size_t>(slot)].get();
}

float NativeEffectBank::processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U) return 0.0f;
    for (auto& effect : slots_) if (effect) (void)effect->processInPlace(interleaved, frames, channels);
    float peak = 0.0f;
    const std::size_t sampleCount = static_cast<std::size_t>(frames) * channels;
    for (std::size_t index = 0U; index < sampleCount; ++index) peak = std::max(peak, std::fabs(interleaved[index]));
    return peak;
}

} // namespace webrc::native
