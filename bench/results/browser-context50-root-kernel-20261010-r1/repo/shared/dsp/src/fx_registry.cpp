#include "webrc/dsp/fx_registry.hpp"
#include "webrc/dsp/musical_fx_registry_bridge.hpp"

#include "webrc/dsp/performance_fx.hpp"
#include "webrc/dsp/modulation_fx.hpp"
#include "webrc/dsp/composite_fx.hpp"
#include "webrc/dsp/modulated_delay_fx.hpp"
#include "webrc/dsp/rhythmic_fx.hpp"
#include "webrc/dsp/spatial_fx_adapters.hpp"
#include "webrc/dsp/spatial_temporal.hpp"
#include "webrc/dsp/preamp_models.hpp"
#include "webrc/dsp/distortion_fx.hpp"
#include "webrc/dsp/octave_fx.hpp"
#include "webrc/dsp/octave_models.hpp"
#include "webrc/dsp/temporal_fx_adapters.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <new>
#include <type_traits>
#include <utility>
#include <variant>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_FX_TRY try
#define WEBRC_FX_CATCH_ALL catch (...)
#else
// Browser/WASM builds rely on the memory preflight API and compile with exceptions off.
#define WEBRC_FX_TRY if (true)
#define WEBRC_FX_CATCH_ALL else if (false)
#endif

namespace webrc::dsp {
namespace {

constexpr FxReadiness kFilterReady = FxReadiness::ProcessorAvailable;
constexpr FxReadiness kProcessorReady = FxReadiness::ProcessorAvailable;
constexpr FxReadiness kMetadata = FxReadiness::MetadataOnly;

constexpr std::array<FxDescriptor, kFxCatalogSize> kCatalog{{
    {1,"rc505mkii.fx.lpf","LPF","Filter",true,true,kFilterReady,false},
    {2,"rc505mkii.fx.bpf","BPF","Filter",true,true,kFilterReady,false},
    {3,"rc505mkii.fx.hpf","HPF","Filter",true,true,kFilterReady,false},
    {4,"rc505mkii.fx.phaser","PHASER","Modulation",true,true,kProcessorReady,false},
    {5,"rc505mkii.fx.flanger","FLANGER","Modulated delay",true,true,kProcessorReady,false},
    {6,"rc505mkii.fx.synth","SYNTH","Pitch/synthesis",true,true,kProcessorReady,false},
    {7,"rc505mkii.fx.lo-fi","LO-FI","Lo-fi",true,true,kProcessorReady,false},
    {8,"rc505mkii.fx.radio","RADIO","Lo-fi",true,true,kProcessorReady,false},
    {9,"rc505mkii.fx.ring-mod","RING.MOD","Modulation",true,true,kProcessorReady,false},
    {10,"rc505mkii.fx.g2b","G2B","Pitch",true,true,kProcessorReady,false},
    {11,"rc505mkii.fx.sustainer","SUSTAINER","Dynamics",true,true,kProcessorReady,false},
    {12,"rc505mkii.fx.auto-riff","AUTO RIFF","Pitch/sequencer",true,true,kProcessorReady,false},
    {13,"rc505mkii.fx.slow-gear","SLOW GEAR","Envelope",true,true,kProcessorReady,false},
    {14,"rc505mkii.fx.transpose","TRANSPOSE","Pitch",true,true,kMetadata,false},
    {15,"rc505mkii.fx.pitch-bend","PITCH BEND","Pitch",true,true,kMetadata,false},
    {16,"rc505mkii.fx.robot","ROBOT","Voice",true,true,kProcessorReady,false},
    {17,"rc505mkii.fx.electric","ELECTRIC","Voice character",true,true,kProcessorReady,false},
    {18,"rc505mkii.fx.hrm-manual","HRM MANUAL","Harmony",true,true,kMetadata,false},
    {19,"rc505mkii.fx.hrm-auto-m","HRM AUTO (M)","Harmony/MIDI",true,true,kProcessorReady,false},
    {20,"rc505mkii.fx.vocoder","VOCODER","Vocoder",true,true,kProcessorReady,false},
    {21,"rc505mkii.fx.osc-voc-m","OSC VOC (M)","Vocoder/MIDI",true,true,kProcessorReady,false},
    {22,"rc505mkii.fx.osc-bot","OSC BOT","Voice/synthesis",true,true,kProcessorReady,false},
    {23,"rc505mkii.fx.preamp","PREAMP","Amp simulation",true,true,kProcessorReady,false},
    {24,"rc505mkii.fx.dist","DIST","Nonlinear",true,true,kProcessorReady,false},
    {25,"rc505mkii.fx.dynamics","DYNAMICS","Dynamics",true,true,kProcessorReady,false},
    {26,"rc505mkii.fx.eq","EQ","EQ",true,true,kProcessorReady,false},
    {27,"rc505mkii.fx.isolator","ISOLATOR","Multiband/gate",true,true,kProcessorReady,false},
    {28,"rc505mkii.fx.octave","OCTAVE","Pitch",true,true,kProcessorReady,false},
    {29,"rc505mkii.fx.auto-pan","AUTO PAN","Pan modulation",true,true,kProcessorReady,false},
    {30,"rc505mkii.fx.manual-pan","MANUAL PAN","Pan",true,true,kProcessorReady,false},
    {31,"rc505mkii.fx.stereo-enhance","STEREO ENHANCE","Stereo",true,true,kProcessorReady,false},
    {32,"rc505mkii.fx.tremolo","TREMOLO","Amplitude modulation",true,true,kProcessorReady,false},
    {33,"rc505mkii.fx.vibrato","VIBRATO","Modulated delay",true,true,kProcessorReady,false},
    {34,"rc505mkii.fx.pattern-slicer","PATTERN SLICER","Rhythmic gate",true,true,kProcessorReady,false},
    {35,"rc505mkii.fx.step-slicer","STEP SLICER","Rhythmic gate",true,true,kProcessorReady,false},
    {36,"rc505mkii.fx.delay","DELAY","Delay",true,true,kProcessorReady,false},
    {37,"rc505mkii.fx.panning-delay","PANNING DELAY","Stereo delay",true,true,kProcessorReady,false},
    {38,"rc505mkii.fx.reverse-delay","REVERSE DELAY","Reverse delay",true,true,kProcessorReady,false},
    {39,"rc505mkii.fx.mod-delay","MOD DELAY","Modulated delay",true,true,kProcessorReady,false},
    {40,"rc505mkii.fx.tape-echo","TAPE ECHO","Tape delay",true,true,kProcessorReady,false},
    {41,"rc505mkii.fx.granular-delay","GRANULAR DELAY","Granular",true,true,kProcessorReady,false},
    {42,"rc505mkii.fx.warp","WARP","Granular/freeze macro",true,true,kProcessorReady,false},
    {43,"rc505mkii.fx.twist","TWIST","Performance macro",true,true,kProcessorReady,false},
    {44,"rc505mkii.fx.roll","ROLL","Beat repeat",true,true,kProcessorReady,false},
    {45,"rc505mkii.fx.freeze","FREEZE","Freeze",true,true,kProcessorReady,false},
    {46,"rc505mkii.fx.chorus","CHORUS","Modulated delay",true,true,kProcessorReady,false},
    {47,"rc505mkii.fx.reverb","REVERB","Reverb",true,true,kProcessorReady,false},
    {48,"rc505mkii.fx.gate-reverb","GATE REVERB","Reverb/gate",true,true,kProcessorReady,false},
    {49,"rc505mkii.fx.reverse-reverb","REVERSE REVERB","Reverse reverb",true,true,kProcessorReady,false},
    {50,"rc505mkii.fx.beat-scatter","BEAT SCATTER","Track-only beat FX",false,true,kProcessorReady,false},
    {51,"rc505mkii.fx.beat-repeat","BEAT REPEAT","Track-only beat FX",false,true,kProcessorReady,false},
    {52,"rc505mkii.fx.beat-shift","BEAT SHIFT","Track-only beat FX",false,true,kProcessorReady,false},
    {53,"rc505mkii.fx.vinyl-flick","VINYL FLICK","Track-only transport FX",false,true,kProcessorReady,false},
}};

constexpr std::array<FxParameterDescriptor, 4> kFilterParameters{{
    {FxParameterId::FrequencyHz,"frequencyHz","Hz",20.0f,20000.0f,1000.0f,
     FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Q,"q","Q",0.1f,20.0f,0.70710678f,
     FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Mix,"mix","linear",0.0f,1.0f,1.0f,
     FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SmoothingMs,"smoothingMs","ms",0.0f,100.0f,5.0f,
     FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 6> kPhaserParameters{{
    {FxParameterId::FrequencyHz,"centerHz","Hz",40.0f,8000.0f,700.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",0.05f,8.0f,0.35f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Depth,"depthOctaves","octaves",0.0f,2.0f,0.7f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",-0.85f,0.85f,0.25f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Mix,"mix","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SmoothingMs,"smoothingMs","ms",0.0f,100.0f,5.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 9> kDynamicsParameters{{
    {FxParameterId::ThresholdDb,"thresholdDb","dB",-60.0f,0.0f,-18.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Ratio,"ratio","ratio",1.0f,20.0f,4.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::KneeDb,"kneeDb","dB",0.0f,24.0f,6.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::AttackMs,"attackMs","ms",0.1f,1000.0f,5.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ReleaseMs,"releaseMs","ms",1.0f,5000.0f,80.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RmsMix,"rmsMix","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::MakeupDb,"makeupDb","dB",-24.0f,24.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Mix,"mix","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SmoothingMs,"smoothingMs","ms",0.0f,100.0f,5.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 14> kEqParameters{{
    {FxParameterId::EqLowFrequencyHz,"lowShelfFrequencyHz","Hz",20.0f,2000.0f,120.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqLowGainDb,"lowShelfGainDb","dB",-18.0f,18.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqLowSlope,"lowShelfSlope","slope",0.1f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqLowMidFrequencyHz,"lowMidFrequencyHz","Hz",40.0f,8000.0f,500.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqLowMidGainDb,"lowMidGainDb","dB",-18.0f,18.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqLowMidQ,"lowMidQ","Q",0.1f,20.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighMidFrequencyHz,"highMidFrequencyHz","Hz",100.0f,16000.0f,3000.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighMidGainDb,"highMidGainDb","dB",-18.0f,18.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighMidQ,"highMidQ","Q",0.1f,20.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighFrequencyHz,"highShelfFrequencyHz","Hz",1000.0f,20000.0f,3000.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighGainDb,"highShelfGainDb","dB",-18.0f,18.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighSlope,"highShelfSlope","slope",0.1f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Mix,"mix","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SmoothingMs,"smoothingMs","ms",0.0f,100.0f,5.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 4> kDelayParameters{{
    {FxParameterId::DelayMs,"delayMs","ms",0.3f,2000.0f,375.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",0.0f,0.95f,0.35f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Mix,"mix","linear",0.0f,1.0f,0.35f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SmoothingMs,"smoothingMs","ms",0.0f,100.0f,10.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 7> kReverbParameters{{
    {FxParameterId::ReverbTimeSeconds,"rt60Seconds","s",0.1f,20.0f,1.8f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::DampingHz,"dampingHz","Hz",50.0f,18000.0f,2000.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationRateHz,"modulationRateHz","Hz",0.0f,8.0f,0.25f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"modulationDepthMs","ms",0.0f,5.0f,0.8f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::MaximumFeedback,"maximumFeedback","linear",0.0f,0.9995f,0.98f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.35f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SmoothingMs,"smoothingMs","ms",0.0f,100.0f,20.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 8> kRadioParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RadioHighPassHz,"highPassHz","Hz",20.0f,1200.0f,220.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RadioLowPassHz,"lowPassHz","Hz",300.0f,12000.0f,3400.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Drive,"drive","ratio",0.1f,12.0f,2.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::BitDepth,"bitDepth","bits",4.0f,16.0f,12.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::HoldFrames,"holdFrames","frames",1.0f,32.0f,2.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::BitMix,"bitMix","linear",0.0f,1.0f,0.35f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 8> kSustainerParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ThresholdDb,"thresholdDb","dB",-60.0f,0.0f,-24.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Ratio,"ratio","ratio",1.0f,40.0f,8.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::AttackMs,"attackMs","ms",0.1f,2000.0f,8.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ReleaseMs,"releaseMs","ms",1.0f,10000.0f,450.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RmsMix,"rmsMix","linear",0.0f,1.0f,0.55f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::MakeupDb,"makeupDb","dB",-24.0f,24.0f,4.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 5> kSlowGearParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SlowGearAttackMs,"attackMs","ms",10.0f,2000.0f,300.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SlowGearReleaseMs,"releaseMs","ms",10.0f,5000.0f,120.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Sensitivity,"sensitivity","ratio",0.5f,8.0f,2.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 5> kStereoEnhanceParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::StereoHighWidth,"highWidth","ratio",0.0f,2.0f,1.6f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::StereoLowWidth,"lowWidth","ratio",0.0f,1.0f,0.35f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SmoothingMs,"smoothingMs","ms",0.0f,1000.0f,20.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 6> kFlangerParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.45f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",0.01f,20.0f,0.25f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::DelayMs,"baseDelayMs","ms",0.3f,30.0f,8.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"depthMs","ms",0.0f,8.0f,5.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",-0.88f,0.88f,0.52f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 6> kChorusParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.48f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",0.01f,20.0f,0.8f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::DelayMs,"baseDelayMs","ms",0.3f,120.0f,30.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"depthMs","ms",0.0f,20.0f,8.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",-0.80f,0.80f,0.20f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 6> kVibratoParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",0.01f,20.0f,5.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::DelayMs,"baseDelayMs","ms",0.3f,35.0f,10.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"depthMs","ms",0.0f,10.0f,4.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",0.0f,0.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 6> kModDelayParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.40f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",0.01f,20.0f,0.45f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::DelayMs,"baseDelayMs","ms",0.3f,2000.0f,280.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"depthMs","ms",0.0f,50.0f,12.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",-0.88f,0.88f,0.28f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 9> kPanningDelayParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.42f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",0.01f,20.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::DelayMs,"baseDelayMs","ms",0.3f,2000.0f,280.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"depthMs","ms",0.0f,50.0f,12.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",0.0f,0.90f,0.42f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Pan,"pan","linear",-1.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Depth,"panDepth","linear",0.0f,1.0f,0.72f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::CrossFeedback,"crossFeedback","linear",0.0f,1.0f,0.88f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 9> kIsolatorParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::TempoBpm,"tempoBpm","BPM",20.0f,300.0f,120.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::LowGainDb,"lowGainDb","dB",-80.0f,12.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::MidGainDb,"midGainDb","dB",-80.0f,12.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::HighGainDb,"highGainDb","dB",-80.0f,12.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::LowMute,"lowMute","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::MidMute,"midMute","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::HighMute,"highMute","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 5> kRhythmicSlicerParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::TempoBpm,"tempoBpm","BPM",20.0f,300.0f,120.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EdgeMilliseconds,"edgeMilliseconds","ms",0.1f,10.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::PatternId,"patternId","index",0.0f,7.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 5> kStepSlicerParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::TempoBpm,"tempoBpm","BPM",20.0f,300.0f,120.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EdgeMilliseconds,"edgeMilliseconds","ms",0.1f,10.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::PatternId,"patternId","index",0.0f,5.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 3> kReverseDelayParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",0.0f,0.9f,0.25f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 9> kGateReverbParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ReverbTimeSeconds,"rt60Seconds","s",0.1f,20.0f,1.2f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::DampingHz,"dampingHz","Hz",50.0f,18000.0f,8000.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationRateHz,"modulationRateHz","Hz",0.0f,8.0f,0.17f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"modulationDepthMs","ms",0.0f,5.0f,0.15f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::GateThresholdDb,"gateThresholdDb","dB",-90.0f,0.0f,-30.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::GateHoldMs,"gateHoldMs","ms",0.0f,500.0f,70.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::GateReleaseMs,"gateReleaseMs","ms",5.0f,2000.0f,160.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 6> kReverseReverbParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ReverbTimeSeconds,"rt60Seconds","s",0.1f,20.0f,1.2f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::DampingHz,"dampingHz","Hz",50.0f,18000.0f,8000.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationRateHz,"modulationRateHz","Hz",0.0f,8.0f,0.17f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"modulationDepthMs","ms",0.0f,5.0f,0.15f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 7> kBeatScatterParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::TempoBpm,"tempoBpm","BPM",20.0f,300.0f,120.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SubdivisionBeats,"subdivisionBeats","beats",0.125f,4.0f,0.25f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",0.0f,0.95f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ScatterAmount,"scatterAmount","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::PitchRatio,"pitchRatio","ratio",-2.0f,2.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 5> kBeatRepeatParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::TempoBpm,"tempoBpm","BPM",20.0f,300.0f,120.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SubdivisionBeats,"subdivisionBeats","beats",0.125f,0.5f,0.25f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",0.0f,0.95f,0.72f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 6> kBeatShiftParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::TempoBpm,"tempoBpm","BPM",20.0f,300.0f,120.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SubdivisionBeats,"subdivisionBeats","beats",0.125f,4.0f,0.25f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Feedback,"feedback","linear",0.0f,0.95f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ShiftBeats,"shiftBeats","beats",0.0f,2.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 3> kVinylFlickParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::FlickImpulse,"flickImpulse","linear",-1.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 5> kLoFiParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::BitDepth,"bitDepth","bits",4.0f,16.0f,8.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::HoldFrames,"holdFrames","frames",1.0f,64.0f,4.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Dither,"dither","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 4> kRingModParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",1.0f,8000.0f,110.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Waveform,"waveform","enum",0.0f,3.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 5> kAutoPanParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",0.01f,20.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Depth,"depth","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Pan,"pan","linear",-1.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 3> kManualPanParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Pan,"pan","linear",-1.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr std::array<FxParameterDescriptor, 4> kTremoloParameters{{
    {FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::RateHz,"rateHz","Hz",0.01f,20.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Depth,"depth","linear",0.0f,1.0f,0.5f,FxParameterOrigin::ReconstructionSafeBounds},
}};

constexpr FxParameterDescriptor localParameter(FxParameterId id, std::string_view name,
                                                std::string_view unit, float minimum,
                                                float maximum, float defaultValue) noexcept {
    return {id, name, unit, minimum, maximum, defaultValue,
            FxParameterOrigin::ReconstructionSafeBounds};
}

constexpr std::array<FxParameterDescriptor, 13> kPreampModelParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Mix,"mix","linear",0.0f,1.0f,1.0f),
    localParameter(FxParameterId::Drive,"drive","ratio",0.1f,24.0f,4.0f),
    localParameter(FxParameterId::BassDb,"bassDb","dB",-12.0f,12.0f,0.0f),
    localParameter(FxParameterId::MidDb,"midDb","dB",-12.0f,12.0f,0.0f),
    localParameter(FxParameterId::TrebleDb,"trebleDb","dB",-12.0f,12.0f,0.0f),
    localParameter(FxParameterId::PresenceDb,"presenceDb","dB",-12.0f,12.0f,0.0f),
    localParameter(FxParameterId::OutputDb,"outputDb","dB",-24.0f,12.0f,0.0f),
    localParameter(FxParameterId::AmpModel,"ampModel","selector",0.0f,8.0f,3.0f),
    localParameter(FxParameterId::SpeakerModel,"speakerModel","selector",0.0f,8.0f,1.0f),
    localParameter(FxParameterId::MicModel,"micModel","selector",0.0f,4.0f,0.0f),
    localParameter(FxParameterId::MicDistance,"micDistance","selector",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::MicPositionCm,"micPositionCm","selector",0.0f,10.0f,0.0f),
}};

constexpr std::array<FxParameterDescriptor, 5> kDistortionParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Mix,"mix","linear",0.0f,1.0f,1.0f),
    localParameter(FxParameterId::Drive,"drive","ratio",0.1f,24.0f,1.0f),
    localParameter(FxParameterId::ToneHz,"toneHz","Hz",100.0f,18000.0f,14000.0f),
    localParameter(FxParameterId::OutputDb,"outputDb","dB",-24.0f,12.0f,0.0f),
}};

constexpr std::array<FxParameterDescriptor, 3> kOctaveParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Mix,"mix","linear",0.0f,1.0f,0.5f),
    localParameter(FxParameterId::OctaveMode,"mode","choice",0.0f,2.0f,0.0f),
}};

// These are reconstruction-safe runtime controls for the musical adapters.
// Their domains and curves are deliberately separate from published Roland
// UI facts, which remain non-normative until independently extracted.
constexpr std::array<FxParameterDescriptor, 5> kSynthParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::SynthFrequencyMacro,"frequencyMacro","macro",0.0f,100.0f,50.0f),
    localParameter(FxParameterId::SynthResonanceMacro,"resonanceMacro","macro",0.0f,100.0f,50.0f),
    localParameter(FxParameterId::SynthDecayMacro,"decayMacro","macro",0.0f,100.0f,50.0f),
    localParameter(FxParameterId::BalancePercent,"balancePercent","percent",0.0f,100.0f,50.0f),
}};

constexpr std::array<FxParameterDescriptor, 3> kGuitarToBassParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::BalancePercent,"balancePercent","percent",0.0f,100.0f,50.0f),
    localParameter(FxParameterId::ModeIndex,"modeIndex","choice",1.0f,2.0f,2.0f),
}};

constexpr std::array<FxParameterDescriptor, 8> kAutoRiffParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::PhraseIndex,"phraseIndex","index",1.0f,30.0f,1.0f),
    localParameter(FxParameterId::TempoBpm,"tempoBpmLocal","BPM",30.0f,300.0f,120.0f),
    localParameter(FxParameterId::Hold,"hold","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Loop,"loop","boolean",0.0f,1.0f,1.0f),
    localParameter(FxParameterId::AttackMacro,"attackMacro","macro",0.0f,100.0f,20.0f),
    localParameter(FxParameterId::KeyIndex,"keyIndex","index",0.0f,11.0f,0.0f),
    localParameter(FxParameterId::BalancePercent,"balancePercent","percent",0.0f,100.0f,70.0f),
}};

constexpr std::array<FxParameterDescriptor, 5> kRobotParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Mix,"mix","linear",0.0f,1.0f,0.75f),
    localParameter(FxParameterId::NoteClass,"noteClass","index",0.0f,11.0f,0.0f),
    localParameter(FxParameterId::ModeIndex,"modeIndex","choice",1.0f,2.0f,2.0f),
    localParameter(FxParameterId::FormantMacro,"formantMacro","macro",-50.0f,50.0f,0.0f),
}};

constexpr std::array<FxParameterDescriptor, 7> kElectricParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Mix,"mix","linear",0.0f,1.0f,0.7f),
    localParameter(FxParameterId::Semitones,"shiftSemitones","semitones",-12.0f,12.0f,0.0f),
    localParameter(FxParameterId::FormantMacro,"formantMacro","macro",-50.0f,50.0f,0.0f),
    localParameter(FxParameterId::SpeedMacro,"speedMacro","macro",0.0f,10.0f,5.0f),
    localParameter(FxParameterId::StabilityMacro,"stabilityMacro","macro",-10.0f,10.0f,0.0f),
    localParameter(FxParameterId::ScaleRoot,"scaleRoot","index",-1.0f,11.0f,-1.0f),
}};

constexpr std::array<FxParameterDescriptor, 8> kHarmonyAutoParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::VoiceSelector,"voiceSelector","choice",0.0f,6.0f,4.0f),
    localParameter(FxParameterId::FormantMacro,"formantMacro","macro",-50.0f,50.0f,0.0f),
    localParameter(FxParameterId::Pan,"pan","linear",-1.0f,1.0f,0.0f),
    localParameter(FxParameterId::ModeIndex,"modeIndex","choice",1.0f,2.0f,2.0f),
    localParameter(FxParameterId::KeyIndex,"keyIndex","index",0.0f,11.0f,0.0f),
    localParameter(FxParameterId::DryLevelPercent,"dryLevelPercent","percent",0.0f,100.0f,100.0f),
    localParameter(FxParameterId::HarmonyLevelPercent,"harmonyLevelPercent","percent",0.0f,100.0f,80.0f),
}};

constexpr std::array<FxParameterDescriptor, 5> kVocoderRuntimeParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Mix,"mix","linear",0.0f,1.0f,1.0f),
    localParameter(FxParameterId::OutputDb,"outputDb","dB",-60.0f,12.0f,0.0f),
    localParameter(FxParameterId::AttackMs,"envelopeAttackMs","ms",0.1f,500.0f,8.0f),
    localParameter(FxParameterId::ReleaseMs,"envelopeReleaseMs","ms",1.0f,3000.0f,90.0f),
}};

constexpr std::array<FxParameterDescriptor, 6> kOscVocRuntimeParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Mix,"mix","linear",0.0f,1.0f,1.0f),
    localParameter(FxParameterId::OutputDb,"outputDb","dB",-60.0f,12.0f,0.0f),
    localParameter(FxParameterId::AttackMs,"envelopeAttackMs","ms",0.1f,500.0f,8.0f),
    localParameter(FxParameterId::ReleaseMs,"envelopeReleaseMs","ms",1.0f,3000.0f,90.0f),
    localParameter(FxParameterId::Waveform,"waveform","choice",0.0f,4.0f,0.0f),
}};

constexpr std::array<FxParameterDescriptor, 9> kOscBotRuntimeParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Mix,"mix","linear",0.0f,1.0f,0.75f),
    localParameter(FxParameterId::Waveform,"waveform","choice",0.0f,4.0f,0.0f),
    localParameter(FxParameterId::ToneMacro,"toneMacro","macro",-50.0f,50.0f,0.0f),
    localParameter(FxParameterId::AttackMacro,"attackMacro","macro",0.0f,100.0f,50.0f),
    localParameter(FxParameterId::OscNoteMidi,"oscNoteMidi","MIDI note",24.0f,127.0f,36.0f),
    localParameter(FxParameterId::ModulationSensitivityMacro,"modulationSensitivityMacro","macro",-50.0f,50.0f,0.0f),
    localParameter(FxParameterId::BalancePercent,"balancePercent","percent",0.0f,100.0f,50.0f),
    localParameter(FxParameterId::PatternIndex,"patternIndex","index",0.0f,3.0f,0.0f),
}};

constexpr std::array<FxParameterDescriptor, 8> kTapeEchoParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.42f),
    localParameter(FxParameterId::DelayMs,"delayMs","ms",50.0f,800.0f,240.0f),
    localParameter(FxParameterId::Feedback,"feedback","linear",0.0f,0.92f,0.35f),
    localParameter(FxParameterId::ToneHz,"toneHz","Hz",100.0f,16000.0f,6500.0f),
    localParameter(FxParameterId::WowDepthMs,"wowDepthMs","ms",0.0f,8.0f,1.1f),
    localParameter(FxParameterId::WowRateHz,"wowRateHz","Hz",0.02f,8.0f,0.35f),
    localParameter(FxParameterId::Drive,"drive","ratio",1.0f,16.0f,2.0f),
}};

constexpr std::array<FxParameterDescriptor, 7> kGranularDelayParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.65f),
    localParameter(FxParameterId::Feedback,"feedback","linear",0.0f,0.78f,0.35f),
    localParameter(FxParameterId::GrainMs,"grainMs","ms",12.0f,800.0f,180.0f),
    localParameter(FxParameterId::DensityHz,"densityHz","Hz",1.0f,80.0f,12.0f),
    localParameter(FxParameterId::PitchRatio,"pitchRatio","ratio",0.25f,4.0f,1.0f),
    localParameter(FxParameterId::PositionSpread,"positionSpread","linear",0.0f,1.0f,0.45f),
}};

constexpr std::array<FxParameterDescriptor, 6> kWarpParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.65f),
    localParameter(FxParameterId::Freeze,"freeze","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::WarpAmount,"warpAmount","linear",0.0f,1.0f,0.55f),
    localParameter(FxParameterId::ReverbTimeSeconds,"reverbTimeSeconds","s",0.25f,12.0f,2.2f),
    localParameter(FxParameterId::DampingHz,"dampingHz","Hz",100.0f,18000.0f,6500.0f),
}};

constexpr std::array<FxParameterDescriptor, 6> kTwistParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.65f),
    localParameter(FxParameterId::DelayMs,"delayMs","ms",30.0f,2000.0f,180.0f),
    localParameter(FxParameterId::TwistMacro,"twistMacro","linear",-1.0f,1.0f,0.0f),
    localParameter(FxParameterId::Feedback,"feedback","linear",0.0f,0.85f,0.35f),
    localParameter(FxParameterId::ToneHz,"toneHz","Hz",100.0f,16000.0f,6500.0f),
}};

constexpr std::array<FxParameterDescriptor, 5> kRollParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.65f),
    localParameter(FxParameterId::TempoBpm,"tempoBpm","BPM",20.0f,300.0f,120.0f),
    localParameter(FxParameterId::SubdivisionBeats,"subdivisionBeats","beats",0.0625f,4.0f,0.25f),
    localParameter(FxParameterId::Feedback,"feedback","linear",0.0f,0.95f,0.72f),
}};

constexpr std::array<FxParameterDescriptor, 3> kFreezeParameters{{
    localParameter(FxParameterId::Active,"active","boolean",0.0f,1.0f,0.0f),
    localParameter(FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.65f),
    localParameter(FxParameterId::Freeze,"freeze","boolean",0.0f,1.0f,0.0f),
}};

class TptFilterProcessor final : public FxProcessor {
public:
    explicit TptFilterProcessor(std::uint16_t ordinal) noexcept : ordinal_(ordinal) {}

    std::uint16_t ordinal() const noexcept override { return ordinal_; }

    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec) || (spec.channels != 1U && spec.channels != 2U) ||
            frequencyHz_ > static_cast<float>(spec.sampleRate * 0.49)) return false;
        std::array<TptStateVariableFilter, 2> candidateFilters{};
        for (auto& filter : candidateFilters) {
            if (!filter.prepare(spec)) return false;
            if (!filter.setFrequencyQ(frequencyHz_, q_, smoothingMs_)) return false;
        }
        ParameterSmoother candidateMix{};
        if (!candidateMix.prepare(spec)) return false;
        candidateMix.reset(mixTarget_);
        filters_ = candidateFilters;
        mix_ = candidateMix;
        spec_ = spec;
        prepared_ = true;
        return true;
    }

    void reset() noexcept override {
        for (auto& filter : filters_) filter.reset();
        mix_.reset(mixTarget_);
    }

    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == spec_.channels && channels > 0U && channels <= 2U &&
               frames <= spec_.maxBlockFrames;
    }

    bool validParameter(FxParameterId id, float value) const noexcept override {
        if (!std::isfinite(value)) return false;
        switch (id) {
        case FxParameterId::FrequencyHz:
            return value >= 20.0f && value <= 20000.0f &&
                   (!prepared_ || value <= static_cast<float>(spec_.sampleRate * 0.49));
        case FxParameterId::Q: return value >= 0.1f && value <= 20.0f;
        case FxParameterId::Mix: return value >= 0.0f && value <= 1.0f;
        case FxParameterId::SmoothingMs: return value >= 0.0f && value <= 100.0f;
        }
        return false;
    }

    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!validParameter(id, value)) return false;
        switch (id) {
        case FxParameterId::FrequencyHz: frequencyHz_ = value; break;
        case FxParameterId::Q: q_ = value; break;
        case FxParameterId::Mix:
            mixTarget_ = value;
            return !prepared_ || mix_.setTarget(value, smoothingMs_);
        case FxParameterId::SmoothingMs: smoothingMs_ = value; break;
        }
        if (prepared_) {
            for (auto& filter : filters_) {
                if (!filter.setFrequencyQ(frequencyHz_, q_, smoothingMs_)) return false;
            }
        }
        return true;
    }

    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) ||
            (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        for (std::uint32_t channel = 0; channel < channels; ++channel) {
            if (!input[channel] || !output[channel]) return false;
        }
        for (std::uint32_t i = 0; i < frames; ++i) {
            const float mix = mix_.next();
            for (std::uint32_t channel = 0; channel < channels; ++channel) {
                const float dry = sanitize(input[channel][i]);
                const auto result = filters_[channel].processSample(dry);
                float wet = result.low;
                if (ordinal_ == 2U) wet = result.band;
                else if (ordinal_ == 3U) wet = result.high;
                output[channel][i] = sanitize(dry + mix * (wet - dry));
            }
        }
        return true;
    }

    std::int32_t fixedLatencySamples() const noexcept override { return 0; }
    bool latencyIsFrequencyDependent() const noexcept override { return true; }

private:
    std::uint16_t ordinal_ = 0;
    ProcessSpec spec_{};
    std::array<TptStateVariableFilter, 2> filters_{};
    ParameterSmoother mix_{};
    float frequencyHz_ = 1000.0f;
    float q_ = 0.70710678f;
    float smoothingMs_ = 5.0f;
    float mixTarget_ = 1.0f;
    bool prepared_ = false;
};

class PhaserProcessor final : public FxProcessor {
public:
    std::uint16_t ordinal() const noexcept override { return 4U; }

    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec) || centerHz_ > spec.sampleRate * 0.45f) return false;
        std::array<AllPass1, 8> candidateStages{};
        for (std::size_t channel = 0; channel < 2U; ++channel) {
            for (std::size_t stage = 0; stage < 4U; ++stage) {
                auto& filter = candidateStages[channel * 4U + stage];
                if (!filter.prepare(spec) || !filter.setFrequency(stageFrequency(centerHz_, stage, spec), 0.0f))
                    return false;
            }
        }
        Lfo candidateLfo{};
        if (!candidateLfo.prepare(spec) || !candidateLfo.setFrequency(rateHz_)) return false;
        std::array<ParameterSmoother, 4> candidateSmoothers{};
        for (std::size_t i = 0; i < candidateSmoothers.size(); ++i) {
            if (!candidateSmoothers[i].prepare(spec)) return false;
        }
        candidateSmoothers[0].reset(centerHz_);
        candidateSmoothers[1].reset(depthOctaves_);
        candidateSmoothers[2].reset(feedback_);
        candidateSmoothers[3].reset(mix_);
        stages_ = candidateStages;
        lfo_ = candidateLfo;
        smoothers_ = candidateSmoothers;
        spec_ = spec;
        feedbackState_ = {};
        prepared_ = true;
        return true;
    }

    void reset() noexcept override {
        for (auto& stage : stages_) stage.reset();
        feedbackState_ = {};
        for (std::size_t i = 0; i < smoothers_.size(); ++i)
            smoothers_[i].reset(i == 0U ? centerHz_ : i == 1U ? depthOctaves_ : i == 2U ? feedback_ : mix_);
        lfo_.reset();
    }

    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == spec_.channels && channels > 0U && channels <= 2U &&
               frames <= spec_.maxBlockFrames;
    }

    bool validParameter(FxParameterId id, float value) const noexcept override {
        if (!std::isfinite(value)) return false;
        switch (id) {
        case FxParameterId::FrequencyHz:
            return value >= 40.0f && value <= 8000.0f &&
                   (!prepared_ || value <= spec_.sampleRate * 0.45f);
        case FxParameterId::RateHz: return value >= 0.05f && value <= 8.0f;
        case FxParameterId::Depth: return value >= 0.0f && value <= 2.0f;
        case FxParameterId::Feedback: return value >= -0.85f && value <= 0.85f;
        case FxParameterId::Mix: return value >= 0.0f && value <= 1.0f;
        case FxParameterId::SmoothingMs: return value >= 0.0f && value <= 100.0f;
        default: return false;
        }
    }

    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!validParameter(id, value)) return false;
        switch (id) {
        case FxParameterId::FrequencyHz: centerHz_ = value; return setSmooth(0U, value);
        case FxParameterId::RateHz: rateHz_ = value; return !prepared_ || lfo_.setFrequency(value);
        case FxParameterId::Depth: depthOctaves_ = value; return setSmooth(1U, value);
        case FxParameterId::Feedback: feedback_ = value; return setSmooth(2U, value);
        case FxParameterId::Mix: mix_ = value; return setSmooth(3U, value);
        case FxParameterId::SmoothingMs: smoothingMs_ = value; return retargetSmoothers();
        default: return false;
        }
    }

    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) ||
            (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        for (std::uint32_t c = 0; c < channels; ++c) if (!input[c] || !output[c]) return false;
        constexpr std::array<float, 4> stageRatios{{0.5f,0.75f,1.5f,2.0f}};
        for (std::uint32_t i = 0; i < frames; ++i) {
            const float center = smoothers_[0].next();
            const float depth = smoothers_[1].next();
            const float feedback = smoothers_[2].next();
            const float mix = smoothers_[3].next();
            const float sweep = static_cast<float>(center * std::exp2(depth * lfo_.next()));
            for (std::uint32_t c = 0; c < channels; ++c) {
                const float dry = sanitize(input[c][i]);
                float wet = sanitize(dry + feedback * feedbackState_[c]);
                for (std::uint32_t stage = 0; stage < 4U; ++stage) {
                    const float frequency = std::clamp(sweep * stageRatios[stage], 0.5f,
                                                       static_cast<float>(spec_.sampleRate * 0.45));
                    (void)stages_[c * 4U + stage].setFrequency(frequency, 0.0f);
                    wet = stages_[c * 4U + stage].processSample(wet);
                }
                feedbackState_[c] = wet;
                output[c][i] = sanitize(dry + mix * (wet - dry));
            }
        }
        return true;
    }

    std::int32_t fixedLatencySamples() const noexcept override { return 0; }
    bool latencyIsFrequencyDependent() const noexcept override { return true; }

private:
    static float stageFrequency(float center, std::size_t stage, const ProcessSpec& spec) noexcept {
        constexpr std::array<float, 4> ratios{{0.5f,0.75f,1.5f,2.0f}};
        return std::clamp(center * ratios[stage], 0.5f, static_cast<float>(spec.sampleRate * 0.45));
    }
    bool setSmooth(std::size_t index, float value) noexcept {
        return !prepared_ || smoothers_[index].setTarget(value, smoothingMs_);
    }
    bool retargetSmoothers() noexcept {
        return !prepared_ || (smoothers_[0].setTarget(centerHz_, smoothingMs_) &&
                              smoothers_[1].setTarget(depthOctaves_, smoothingMs_) &&
                              smoothers_[2].setTarget(feedback_, smoothingMs_) &&
                              smoothers_[3].setTarget(mix_, smoothingMs_));
    }

    ProcessSpec spec_{};
    std::array<AllPass1, 8> stages_{};
    Lfo lfo_{};
    std::array<ParameterSmoother, 4> smoothers_{};
    std::array<float, 2> feedbackState_{};
    float centerHz_ = 700.0f;
    float rateHz_ = 0.35f;
    float depthOctaves_ = 0.7f;
    float feedback_ = 0.25f;
    float mix_ = 0.5f;
    float smoothingMs_ = 5.0f;
    bool prepared_ = false;
};

class DynamicsProcessor final : public FxProcessor {
public:
    std::uint16_t ordinal() const noexcept override { return 25U; }
    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec) || spec.channels != 2U) return false;
        DualDetectorCompressor candidateCompressor;
        if (!candidateCompressor.prepare(spec) ||
            !candidateCompressor.setParameters(thresholdDb_, ratio_, kneeDb_, attackMs_, releaseMs_, rmsMix_, makeupDb_))
            return false;
        ParameterSmoother mix;
        if (!mix.prepare(spec)) return false;
        mix.reset(mixTarget_);
        compressor_ = candidateCompressor;
        spec_ = spec;
        mix_ = mix;
        prepared_ = true;
        return true;
    }
    void reset() noexcept override { compressor_.reset(); mix_.reset(mixTarget_); }
    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == spec_.channels && channels == 2U && frames <= spec_.maxBlockFrames;
    }
    bool validParameter(FxParameterId id, float value) const noexcept override {
        if (!std::isfinite(value)) return false;
        switch (id) {
        case FxParameterId::ThresholdDb: return value >= -60.0f && value <= 0.0f;
        case FxParameterId::Ratio: return value >= 1.0f && value <= 20.0f;
        case FxParameterId::KneeDb: return value >= 0.0f && value <= 24.0f;
        case FxParameterId::AttackMs: return value >= 0.1f && value <= 1000.0f;
        case FxParameterId::ReleaseMs: return value >= 1.0f && value <= 5000.0f;
        case FxParameterId::RmsMix: case FxParameterId::Mix: return value >= 0.0f && value <= 1.0f;
        case FxParameterId::MakeupDb: return value >= -24.0f && value <= 24.0f;
        case FxParameterId::SmoothingMs: return value >= 0.0f && value <= 100.0f;
        default: return false;
        }
    }
    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!validParameter(id, value)) return false;
        switch (id) {
        case FxParameterId::ThresholdDb: thresholdDb_ = value; break;
        case FxParameterId::Ratio: ratio_ = value; break;
        case FxParameterId::KneeDb: kneeDb_ = value; break;
        case FxParameterId::AttackMs: attackMs_ = value; break;
        case FxParameterId::ReleaseMs: releaseMs_ = value; break;
        case FxParameterId::RmsMix: rmsMix_ = value; break;
        case FxParameterId::MakeupDb: makeupDb_ = value; break;
        case FxParameterId::Mix:
            mixTarget_ = value;
            return !prepared_ || mix_.setTarget(value, smoothingMs_);
        case FxParameterId::SmoothingMs:
            smoothingMs_ = value;
            return !prepared_ || mix_.setTarget(mixTarget_, smoothingMs_);
        default: return false;
        }
        return !prepared_ || applyCompressorParameters();
    }
    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) || (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        if (!input[0] || !input[1] || !output[0] || !output[1]) return false;
        for (std::uint32_t i = 0; i < frames; ++i) {
            const float dryL = sanitize(input[0][i]);
            const float dryR = sanitize(input[1][i]);
            const auto wet = compressor_.processSample(dryL, dryR);
            const float mix = mix_.next();
            output[0][i] = sanitize(dryL + mix * (wet.left - dryL));
            output[1][i] = sanitize(dryR + mix * (wet.right - dryR));
        }
        return true;
    }
    std::int32_t fixedLatencySamples() const noexcept override { return 0; }
    bool latencyIsFrequencyDependent() const noexcept override { return false; }
private:
    bool applyCompressorParameters() noexcept {
        return compressor_.setParameters(thresholdDb_, ratio_, kneeDb_, attackMs_, releaseMs_, rmsMix_, makeupDb_);
    }
    ProcessSpec spec_{};
    DualDetectorCompressor compressor_{};
    ParameterSmoother mix_{};
    float thresholdDb_ = -18.0f, ratio_ = 4.0f, kneeDb_ = 6.0f;
    float attackMs_ = 5.0f, releaseMs_ = 80.0f, rmsMix_ = 0.5f, makeupDb_ = 0.0f;
    float mixTarget_ = 1.0f, smoothingMs_ = 5.0f;
    bool prepared_ = false;
};

class EqProcessor final : public FxProcessor {
public:
    std::uint16_t ordinal() const noexcept override { return 26U; }
    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec)) return false;
        std::array<BiquadDf2T, 8> candidate{};
        for (auto& filter : candidate) {
            if (!filter.prepare(spec)) return false;
        }
        ParameterSmoother mix;
        if (!mix.prepare(spec)) return false;
        mix.reset(mixTarget_);
        for (std::size_t section = 0; section < 4U; ++section)
            if (!configureSection(candidate, section, spec)) return false;
        filters_ = std::move(candidate);
        mix_ = mix;
        spec_ = spec;
        prepared_ = true;
        return true;
    }
    void reset() noexcept override { for (auto& filter : filters_) filter.reset(); mix_.reset(mixTarget_); }
    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == spec_.channels && channels > 0U && channels <= 2U && frames <= spec_.maxBlockFrames;
    }
    bool validParameter(FxParameterId id, float value) const noexcept override {
        if (!std::isfinite(value)) return false;
        const float nyquist = prepared_ ? static_cast<float>(spec_.sampleRate * 0.49) : 384000.0f * 0.49f;
        switch (id) {
        case FxParameterId::EqLowFrequencyHz: return value >= 20.0f && value <= std::min(2000.0f, nyquist);
        case FxParameterId::EqLowGainDb: case FxParameterId::EqLowMidGainDb:
        case FxParameterId::EqHighMidGainDb: case FxParameterId::EqHighGainDb: return value >= -18.0f && value <= 18.0f;
        // S <= 1 keeps the RBJ shelf radicand non-negative throughout the
        // supported +/-18 dB gain range, including event batches.
        case FxParameterId::EqLowSlope: case FxParameterId::EqHighSlope: return value >= 0.1f && value <= 1.0f;
        case FxParameterId::EqLowMidFrequencyHz: return value >= 40.0f && value <= std::min(8000.0f, nyquist);
        case FxParameterId::EqLowMidQ: case FxParameterId::EqHighMidQ: return value >= 0.1f && value <= 20.0f;
        case FxParameterId::EqHighMidFrequencyHz: return value >= 100.0f && value <= std::min(16000.0f, nyquist);
        case FxParameterId::EqHighFrequencyHz: return value >= 1000.0f && value <= std::min(20000.0f, nyquist);
        case FxParameterId::Mix: return value >= 0.0f && value <= 1.0f;
        case FxParameterId::SmoothingMs: return value >= 0.0f && value <= 100.0f;
        default: return false;
        }
    }
    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!validParameter(id, value)) return false;
        if (id == FxParameterId::Mix) { mixTarget_ = value; return !prepared_ || mix_.setTarget(value, smoothingMs_); }
        if (id == FxParameterId::SmoothingMs) { smoothingMs_ = value; return !prepared_ || updateAllSections(); }
        float* target = nullptr;
        std::size_t section = 0U;
        switch (id) {
        case FxParameterId::EqLowFrequencyHz: target = &lowHz_; section = 0U; break;
        case FxParameterId::EqLowGainDb: target = &lowDb_; section = 0U; break;
        case FxParameterId::EqLowSlope: target = &lowSlope_; section = 0U; break;
        case FxParameterId::EqLowMidFrequencyHz: target = &lowMidHz_; section = 1U; break;
        case FxParameterId::EqLowMidGainDb: target = &lowMidDb_; section = 1U; break;
        case FxParameterId::EqLowMidQ: target = &lowMidQ_; section = 1U; break;
        case FxParameterId::EqHighMidFrequencyHz: target = &highMidHz_; section = 2U; break;
        case FxParameterId::EqHighMidGainDb: target = &highMidDb_; section = 2U; break;
        case FxParameterId::EqHighMidQ: target = &highMidQ_; section = 2U; break;
        case FxParameterId::EqHighFrequencyHz: target = &highHz_; section = 3U; break;
        case FxParameterId::EqHighGainDb: target = &highDb_; section = 3U; break;
        case FxParameterId::EqHighSlope: target = &highSlope_; section = 3U; break;
        default: return false;
        }
        const float old = *target;
        *target = value;
        if (prepared_ && !updateSection(section)) { *target = old; (void)updateSection(section); return false; }
        return true;
    }
    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) || (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        for (std::uint32_t c = 0; c < channels; ++c) if (!input[c] || !output[c]) return false;
        for (std::uint32_t i = 0; i < frames; ++i) {
            const float mix = mix_.next();
            for (std::uint32_t c = 0; c < channels; ++c) {
                const float dry = sanitize(input[c][i]);
                float wet = dry;
                for (std::size_t section = 0; section < 4U; ++section)
                    wet = filters_[c * 4U + section].processSample(wet);
                output[c][i] = sanitize(dry + mix * (wet - dry));
            }
        }
        return true;
    }
    std::int32_t fixedLatencySamples() const noexcept override { return 0; }
    bool latencyIsFrequencyDependent() const noexcept override { return true; }
private:
    bool configureSection(std::array<BiquadDf2T, 8>& filters, std::size_t section,
                          const ProcessSpec& spec) const noexcept {
        const float nyquist = static_cast<float>(spec.sampleRate * 0.49);
        const float frequency = section == 0U ? lowHz_ : section == 1U ? lowMidHz_ :
                                section == 2U ? highMidHz_ : highHz_;
        if (frequency > nyquist) return false;
        for (std::size_t channel = 0; channel < 2U; ++channel) {
            auto& filter = filters[channel * 4U + section];
            bool ok = false;
            if (section == 0U) ok = filter.setLowShelf(lowHz_, lowDb_, lowSlope_, smoothingMs_);
            else if (section == 1U) ok = filter.setPeaking(lowMidHz_, lowMidQ_, lowMidDb_, smoothingMs_);
            else if (section == 2U) ok = filter.setPeaking(highMidHz_, highMidQ_, highMidDb_, smoothingMs_);
            else if (section == 3U) ok = filter.setHighShelf(highHz_, highDb_, highSlope_, smoothingMs_);
            if (!ok) return false;
        }
        return true;
    }
    bool updateSection(std::size_t section) noexcept {
        return configureSection(filters_, section, spec_);
    }
    bool updateAllSections() noexcept {
        for (std::size_t section = 0; section < 4U; ++section) if (!updateSection(section)) return false;
        return true;
    }
    ProcessSpec spec_{};
    std::array<BiquadDf2T, 8> filters_{};
    ParameterSmoother mix_{};
    float lowHz_=120.0f, lowDb_=0.0f, lowSlope_=1.0f;
    float lowMidHz_=500.0f, lowMidDb_=0.0f, lowMidQ_=1.0f;
    float highMidHz_=3000.0f, highMidDb_=0.0f, highMidQ_=1.0f;
    float highHz_=8000.0f, highDb_=0.0f, highSlope_=1.0f;
    float mixTarget_=1.0f, smoothingMs_=5.0f;
    bool prepared_=false;
};

class DelayProcessor final : public FxProcessor {
public:
    std::uint16_t ordinal() const noexcept override { return 36U; }
    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec) || (spec.channels != 1U && spec.channels != 2U)) return false;
        const auto maxDelay = static_cast<std::uint32_t>(spec.sampleRate * 2.0f);
        std::array<LagrangeDelay, 2> candidate{};
        WEBRC_FX_TRY {
            for (auto& delay : candidate) if (!delay.prepare(spec, maxDelay)) return false;
        } WEBRC_FX_CATCH_ALL {
            return false;
        }
        std::array<ParameterSmoother, 3> candidateSmooth{};
        for (auto& smoother : candidateSmooth) if (!smoother.prepare(spec)) return false;
        candidateSmooth[0].reset(delayMs_);
        candidateSmooth[1].reset(feedback_);
        candidateSmooth[2].reset(mix_);
        delays_ = std::move(candidate);
        smoothers_ = candidateSmooth;
        spec_ = spec;
        feedbackState_ = {};
        prepared_ = true;
        return true;
    }
    void reset() noexcept override {
        for (auto& delay : delays_) delay.reset();
        feedbackState_ = {};
        smoothers_[0].reset(delayMs_); smoothers_[1].reset(feedback_); smoothers_[2].reset(mix_);
    }
    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == spec_.channels && channels > 0U && channels <= 2U && frames <= spec_.maxBlockFrames;
    }
    bool validParameter(FxParameterId id, float value) const noexcept override {
        if (!std::isfinite(value)) return false;
        switch (id) {
        case FxParameterId::DelayMs:
            return value >= std::max(0.3f, prepared_ ? 2500.0f / spec_.sampleRate : 0.3f) && value <= 2000.0f;
        case FxParameterId::Feedback: return value >= 0.0f && value <= 0.95f;
        case FxParameterId::Mix: return value >= 0.0f && value <= 1.0f;
        case FxParameterId::SmoothingMs: return value >= 0.0f && value <= 100.0f;
        default: return false;
        }
    }
    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!validParameter(id, value)) return false;
        if (id == FxParameterId::DelayMs) { delayMs_ = value; return !prepared_ || smoothers_[0].setTarget(value, smoothingMs_); }
        if (id == FxParameterId::Feedback) { feedback_ = value; return !prepared_ || smoothers_[1].setTarget(value, smoothingMs_); }
        if (id == FxParameterId::Mix) { mix_ = value; return !prepared_ || smoothers_[2].setTarget(value, smoothingMs_); }
        if (id == FxParameterId::SmoothingMs) {
            smoothingMs_ = value;
            return !prepared_ || (smoothers_[0].setTarget(delayMs_, smoothingMs_) &&
                                  smoothers_[1].setTarget(feedback_, smoothingMs_) &&
                                  smoothers_[2].setTarget(mix_, smoothingMs_));
        }
        return false;
    }
    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) || (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        for (std::uint32_t c = 0; c < channels; ++c) if (!input[c] || !output[c]) return false;
        for (std::uint32_t i = 0; i < frames; ++i) {
            const float delaySamples = std::clamp(smoothers_[0].next() * spec_.sampleRate * 0.001f,
                                                  LagrangeDelay::minimumDelaySamples(),
                                                  static_cast<float>(delays_[0].maxDelaySamples()));
            const float feedback = smoothers_[1].next();
            const float mix = smoothers_[2].next();
            for (std::uint32_t c = 0; c < channels; ++c) {
                const float dry = sanitize(input[c][i]);
                const float delayed = delays_[c].processSample(dry + feedback * feedbackState_[c], delaySamples);
                feedbackState_[c] = delayed;
                output[c][i] = sanitize(dry + mix * (delayed - dry));
            }
        }
        return true;
    }
    std::int32_t fixedLatencySamples() const noexcept override { return -1; }
    std::uint32_t startupWarmupFrames() const noexcept override {
        if (!prepared_) return 0U;
        const auto warmup = fxStartupWarmupUpperBoundSamples(36U, spec_);
        return warmup.supported ? warmup.frames : 0U;
    }
    bool latencyIsFrequencyDependent() const noexcept override { return false; }
private:
    ProcessSpec spec_{};
    std::array<LagrangeDelay, 2> delays_{};
    std::array<ParameterSmoother, 3> smoothers_{};
    std::array<float, 2> feedbackState_{};
    float delayMs_=375.0f, feedback_=0.35f, mix_=0.35f, smoothingMs_=10.0f;
    bool prepared_=false;
};

class ReverbProcessor final : public FxProcessor {
public:
    std::uint16_t ordinal() const noexcept override { return 47U; }
    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec) || spec.channels != 2U) return false;
        WEBRC_FX_TRY {
            FdnReverb candidate;
            if (!candidate.prepare(spec, FdnLineCount::Eight, 0.12f) ||
                !candidate.setParameters(rt60_, dampingHz_, modRateHz_, modDepthMs_, maximumFeedback_, wet_, smoothingMs_))
                return false;
            reverb_ = std::move(candidate);
            spec_ = spec;
            prepared_ = true;
            return true;
        } WEBRC_FX_CATCH_ALL {
            return false;
        }
    }
    void reset() noexcept override { reverb_.reset(); }
    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == spec_.channels && channels == 2U && frames <= spec_.maxBlockFrames;
    }
    bool validParameter(FxParameterId id, float value) const noexcept override {
        if (!std::isfinite(value)) return false;
        switch (id) {
        case FxParameterId::ReverbTimeSeconds: return value >= 0.1f && value <= 20.0f;
        case FxParameterId::DampingHz: return value >= 50.0f && value <= (prepared_ ? spec_.sampleRate * 0.49f : 18000.0f);
        case FxParameterId::ModulationRateHz: return value >= 0.0f && value <= 8.0f;
        case FxParameterId::ModulationDepthMs: return value >= 0.0f && value <= 5.0f;
        case FxParameterId::MaximumFeedback: return value >= 0.0f && value <= 0.9995f;
        case FxParameterId::Wet: case FxParameterId::Mix: return value >= 0.0f && value <= 1.0f;
        case FxParameterId::SmoothingMs: return value >= 0.0f && value <= 100.0f;
        default: return false;
        }
    }
    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!validParameter(id, value)) return false;
        switch (id) {
        case FxParameterId::ReverbTimeSeconds: rt60_ = value; break;
        case FxParameterId::DampingHz: dampingHz_ = value; break;
        case FxParameterId::ModulationRateHz: modRateHz_ = value; break;
        case FxParameterId::ModulationDepthMs: modDepthMs_ = value; break;
        case FxParameterId::MaximumFeedback: maximumFeedback_ = value; break;
        case FxParameterId::Wet: case FxParameterId::Mix: wet_ = value; break;
        case FxParameterId::SmoothingMs: smoothingMs_ = value; break;
        default: return false;
        }
        return !prepared_ || reverb_.setParameters(rt60_, dampingHz_, modRateHz_, modDepthMs_, maximumFeedback_, wet_, smoothingMs_);
    }
    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) || (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        return input[0] && input[1] && output[0] && output[1] &&
               reverb_.processBlock(input[0], input[1], output[0], output[1], frames);
    }
    std::int32_t fixedLatencySamples() const noexcept override { return 0; }
    std::uint32_t startupWarmupFrames() const noexcept override {
        if (!prepared_) return 0U;
        const auto warmup = fxStartupWarmupUpperBoundSamples(47U, spec_);
        return warmup.supported ? warmup.frames : 0U;
    }
    bool latencyIsFrequencyDependent() const noexcept override { return true; }
private:
    ProcessSpec spec_{};
    FdnReverb reverb_{};
    float rt60_=1.8f, dampingHz_=7000.0f, modRateHz_=0.25f, modDepthMs_=0.8f;
    float maximumFeedback_=0.98f, wet_=0.35f, smoothingMs_=20.0f;
    bool prepared_=false;
};

using PerformanceVariant = std::variant<BeatScatter, BeatRepeat, BeatShift, VinylFlick>;

bool parameterControl(FxParameterId id, PerformanceFxControl& control) noexcept {
    switch (id) {
    case FxParameterId::Active: control = PerformanceFxControl::Active; return true;
    case FxParameterId::TempoBpm: control = PerformanceFxControl::TempoBpm; return true;
    case FxParameterId::SubdivisionBeats: control = PerformanceFxControl::SubdivisionBeats; return true;
    case FxParameterId::Wet: control = PerformanceFxControl::Wet; return true;
    case FxParameterId::Feedback: control = PerformanceFxControl::Feedback; return true;
    case FxParameterId::ScatterAmount: control = PerformanceFxControl::ScatterAmount; return true;
    case FxParameterId::PitchRatio: control = PerformanceFxControl::PitchRatio; return true;
    case FxParameterId::ShiftBeats: control = PerformanceFxControl::ShiftBeats; return true;
    case FxParameterId::FlickImpulse: control = PerformanceFxControl::FlickImpulse; return true;
    default: return false;
    }
}

PerformanceFxKind performanceKindForOrdinal(std::uint16_t ordinal) noexcept {
    switch (ordinal) {
    case 50U: return PerformanceFxKind::BeatScatter;
    case 51U: return PerformanceFxKind::BeatRepeat;
    case 52U: return PerformanceFxKind::BeatShift;
    default: return PerformanceFxKind::VinylFlick;
    }
}

class PerformanceFxAdapter final : public FxProcessor {
public:
    explicit PerformanceFxAdapter(std::uint16_t ordinal) noexcept
        : ordinal_(ordinal), kind_(performanceKindForOrdinal(ordinal)) {}

    std::uint16_t ordinal() const noexcept override { return ordinal_; }

    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec) || spec.channels != 2U) return false;
        WEBRC_FX_TRY {
            PerformanceVariant candidate{};
            switch (ordinal_) {
            case 50U: candidate.emplace<BeatScatter>(); break;
            case 51U: candidate.emplace<BeatRepeat>(); break;
            case 52U: candidate.emplace<BeatShift>(); break;
            case 53U: candidate.emplace<VinylFlick>(); break;
            default: return false;
            }
            const bool candidateReady = std::visit([&spec](auto& processor) {
                return processor.prepare(spec);
            }, candidate);
            if (!candidateReady) return false;
            const auto warmup = fxStartupWarmupUpperBoundSamples(ordinal_, spec);
            if (!warmup.supported) return false;
            std::vector<StereoFrame> candidateScratch(spec.maxBlockFrames);
            processor_ = std::move(candidate);
            interleavedScratch_ = std::move(candidateScratch);
            spec_ = spec;
            startupWarmupFrames_ = warmup.frames;
            nextFrame_ = 0U;
            pendingCount_ = 0U;
            prepared_ = true;
            restoreParameterState();
            return true;
        } WEBRC_FX_CATCH_ALL {
            return false;
        }
    }

    void reset() noexcept override {
        if (!prepared_) return;
        std::visit([](auto& processor) { processor.reset(0U); }, processor_);
        nextFrame_ = 0U;
        pendingCount_ = 0U;
        restoreParameterState();
    }

    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == 2U && channels == spec_.channels &&
               frames <= spec_.maxBlockFrames;
    }

    bool validParameter(FxParameterId id, float value) const noexcept override {
        if (!std::isfinite(value)) return false;
        PerformanceFxControl control{};
        if (!parameterControl(id, control)) return false;
        switch (control) {
        case PerformanceFxControl::Active:
            return value == 0.0f || value == 1.0f;
        case PerformanceFxControl::TempoBpm:
            return kind_ != PerformanceFxKind::VinylFlick && value >= 20.0f && value <= 300.0f;
        case PerformanceFxControl::SubdivisionBeats:
            return kind_ != PerformanceFxKind::VinylFlick && value >= 0.125f &&
                   value <= (kind_ == PerformanceFxKind::BeatRepeat ? 0.5f : 4.0f);
        case PerformanceFxControl::Wet:
            return value >= 0.0f && value <= 1.0f;
        case PerformanceFxControl::Feedback:
            return kind_ != PerformanceFxKind::VinylFlick && value >= 0.0f && value <= 0.95f;
        case PerformanceFxControl::ScatterAmount:
            return kind_ == PerformanceFxKind::BeatScatter && value >= 0.0f && value <= 1.0f;
        case PerformanceFxControl::PitchRatio:
            return kind_ == PerformanceFxKind::BeatScatter &&
                   ((value >= 0.25f && value <= 2.0f) || (value <= -0.25f && value >= -2.0f));
        case PerformanceFxControl::ShiftBeats:
            return kind_ == PerformanceFxKind::BeatShift && value >= 0.0f && value <= 2.0f;
        case PerformanceFxControl::FlickImpulse:
            return kind_ == PerformanceFxKind::VinylFlick && value >= -1.0f && value <= 1.0f;
        }
        return false;
    }

    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!prepared_ || !validParameter(id, value) ||
            pendingCount_ >= PerformanceFxProcessor::kMaximumControlEventsPerBlock) return false;
        PerformanceFxControl control{};
        if (!parameterControl(id, control)) return false;
        const auto index = static_cast<std::size_t>(control);
        const PerformanceFxEvent event{0U, control, value};
        parameterState_[index] = event;
        hasParameterState_[index] = true;
        pendingEvents_[pendingCount_++] = event;
        return true;
    }

    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) || (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        if (!input[0] || !input[1] || !output[0] || !output[1] ||
            nextFrame_ >= kMaximumExactFrame || frames > kMaximumExactFrame - nextFrame_) return false;

        for (std::uint32_t frame = 0U; frame < frames; ++frame) {
            interleavedScratch_[frame] = {sanitize(input[0][frame]), sanitize(input[1][frame])};
        }
        const bool processed = std::visit([this, frames](auto& processor) {
            return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                          pendingEvents_.data(), pendingCount_);
        }, processor_);
        if (!processed) return false;
        for (std::uint32_t frame = 0U; frame < frames; ++frame) {
            output[0][frame] = sanitize(interleavedScratch_[frame].left);
            output[1][frame] = sanitize(interleavedScratch_[frame].right);
        }
        nextFrame_ += frames;
        pendingCount_ = 0U;
        return true;
    }

    std::uint32_t maximumParameterEventsPerBlock() const noexcept override {
        return PerformanceFxProcessor::kMaximumControlEventsPerBlock;
    }

    bool canAcceptParameterEvents(std::uint32_t eventCount) const noexcept override {
        return eventCount <= pendingEvents_.size() - pendingCount_;
    }

    std::int32_t fixedLatencySamples() const noexcept override {
        if (!prepared_) return -1;
        if (kind_ != PerformanceFxKind::VinylFlick) return -1;
        return static_cast<std::int32_t>(std::visit([](const auto& processor) {
            return processor.algorithmicLatencySamples();
        }, processor_));
    }
    std::uint32_t startupWarmupFrames() const noexcept override {
        return prepared_ ? startupWarmupFrames_ : 0U;
    }
    bool latencyIsFrequencyDependent() const noexcept override { return false; }

private:
    static constexpr std::uint64_t kMaximumExactFrame = 1ULL << 53U;

    void restoreParameterState() noexcept {
        for (std::size_t i = 0U; i < parameterState_.size(); ++i) {
            if (hasParameterState_[i] && pendingCount_ < pendingEvents_.size())
                pendingEvents_[pendingCount_++] = parameterState_[i];
        }
    }

    std::uint16_t ordinal_ = 0U;
    PerformanceFxKind kind_ = PerformanceFxKind::BeatScatter;
    PerformanceVariant processor_{};
    ProcessSpec spec_{};
    std::vector<StereoFrame> interleavedScratch_;
    std::array<PerformanceFxEvent, PerformanceFxProcessor::kMaximumControlEventsPerBlock> pendingEvents_{};
    std::array<PerformanceFxEvent, 9U> parameterState_{};
    std::array<bool, 9U> hasParameterState_{};
    std::uint64_t nextFrame_ = 0U;
    std::uint32_t pendingCount_ = 0U;
    std::uint32_t startupWarmupFrames_ = 0U;
    bool prepared_ = false;
};



using ModulationVariant = std::variant<LoFi, StereoRingModulatorFx, AutoPan, ManualPan, Tremolo>;

ModulationFxKind modulationKindForOrdinal(std::uint16_t ordinal) noexcept {
    switch (ordinal) {
    case 7U: return ModulationFxKind::LoFi;
    case 9U: return ModulationFxKind::RingModulator;
    case 29U: return ModulationFxKind::AutoPan;
    case 30U: return ModulationFxKind::ManualPan;
    default: return ModulationFxKind::Tremolo;
    }
}

bool modulationControlForParameter(FxParameterId id, ModulationFxControl& control) noexcept {
    switch (id) {
    case FxParameterId::Active: control = ModulationFxControl::Active; return true;
    case FxParameterId::Wet: control = ModulationFxControl::Wet; return true;
    case FxParameterId::RateHz: control = ModulationFxControl::RateHz; return true;
    case FxParameterId::Depth: control = ModulationFxControl::Depth; return true;
    case FxParameterId::Pan: control = ModulationFxControl::Pan; return true;
    case FxParameterId::BitDepth: control = ModulationFxControl::BitDepth; return true;
    case FxParameterId::HoldFrames: control = ModulationFxControl::HoldFrames; return true;
    case FxParameterId::Dither: control = ModulationFxControl::Dither; return true;
    case FxParameterId::Waveform: control = ModulationFxControl::Waveform; return true;
    default: return false;
    }
}

class ModulationFxAdapter final : public FxProcessor {
public:
    explicit ModulationFxAdapter(std::uint16_t ordinal) noexcept
        : ordinal_(ordinal), kind_(modulationKindForOrdinal(ordinal)) {}

    std::uint16_t ordinal() const noexcept override { return ordinal_; }

    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec) || spec.channels != 2U ||
            ModulationFxProcessor::requiredPrepareBytes(spec, kind_) == 0U) return false;
        WEBRC_FX_TRY {
            ModulationVariant candidate{};
            switch (ordinal_) {
            case 7U: candidate.emplace<LoFi>(); break;
            case 9U: candidate.emplace<StereoRingModulatorFx>(); break;
            case 29U: candidate.emplace<AutoPan>(); break;
            case 30U: candidate.emplace<ManualPan>(); break;
            case 32U: candidate.emplace<Tremolo>(); break;
            default: return false;
            }
            if (!std::visit([&spec](auto& processor) { return processor.prepare(spec); }, candidate))
                return false;
            std::vector<StereoFrame> candidateScratch(spec.maxBlockFrames);
            processor_ = std::move(candidate);
            interleavedScratch_ = std::move(candidateScratch);
            spec_ = spec;
            nextFrame_ = 0U;
            pendingCount_ = 0U;
            prepared_ = true;
            restoreParameterState();
            return true;
        } WEBRC_FX_CATCH_ALL {
            return false;
        }
    }

    void reset() noexcept override {
        if (!prepared_) return;
        std::visit([](auto& processor) { processor.reset(0U); }, processor_);
        nextFrame_ = 0U;
        pendingCount_ = 0U;
        restoreParameterState();
    }

    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == 2U && channels == spec_.channels &&
               frames <= spec_.maxBlockFrames;
    }

    bool validParameter(FxParameterId id, float value) const noexcept override {
        if (!std::isfinite(value)) return false;
        ModulationFxControl control{};
        if (!modulationControlForParameter(id, control)) return false;
        const float sampleRate = prepared_ ? spec_.sampleRate : 192000.0f;
        switch (control) {
        case ModulationFxControl::Active:
            return value == 0.0f || value == 1.0f;
        case ModulationFxControl::Wet:
            return value >= 0.0f && value <= 1.0f;
        case ModulationFxControl::RateHz:
            if (kind_ == ModulationFxKind::RingModulator)
                return value >= 1.0f && value <= std::min(8000.0f, sampleRate * 0.45f);
            return (kind_ == ModulationFxKind::AutoPan || kind_ == ModulationFxKind::Tremolo) &&
                   value >= 0.01f && value <= std::min(20.0f, sampleRate * 0.25f);
        case ModulationFxControl::Depth:
            return (kind_ == ModulationFxKind::AutoPan || kind_ == ModulationFxKind::Tremolo) &&
                   value >= 0.0f && value <= 1.0f;
        case ModulationFxControl::Pan:
            return (kind_ == ModulationFxKind::AutoPan || kind_ == ModulationFxKind::ManualPan) &&
                   value >= -1.0f && value <= 1.0f;
        case ModulationFxControl::BitDepth:
            return kind_ == ModulationFxKind::LoFi && value >= 4.0f && value <= 16.0f &&
                   std::floor(value) == value;
        case ModulationFxControl::HoldFrames:
            return kind_ == ModulationFxKind::LoFi && value >= 1.0f && value <= 64.0f &&
                   std::floor(value) == value;
        case ModulationFxControl::Dither:
            return kind_ == ModulationFxKind::LoFi && value >= 0.0f && value <= 1.0f;
        case ModulationFxControl::Waveform:
            return kind_ == ModulationFxKind::RingModulator && value >= 0.0f && value <= 3.0f &&
                   std::floor(value) == value;
        }
        return false;
    }

    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!validParameter(id, value)) return false;
        ModulationFxControl control{};
        if (!modulationControlForParameter(id, control)) return false;
        const auto index = static_cast<std::size_t>(control);
        const ModulationFxEvent event{0U, control, value};
        if (prepared_) {
            if (pendingCount_ >= pendingEvents_.size()) return false;
            pendingEvents_[pendingCount_++] = event;
        }
        parameterState_[index] = event;
        hasParameterState_[index] = true;
        return true;
    }

    bool canAcceptParameterEvents(std::uint32_t eventCount) const noexcept override {
        return eventCount <= pendingEvents_.size() - pendingCount_;
    }

    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) || (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        if (!input[0] || !input[1] || !output[0] || !output[1] ||
            nextFrame_ >= kMaximumExactFrame || frames > kMaximumExactFrame - nextFrame_) return false;
        for (std::uint32_t frame = 0U; frame < frames; ++frame)
            interleavedScratch_[frame] = {sanitize(input[0][frame]), sanitize(input[1][frame])};
        const bool processed = std::visit([this, frames](auto& processor) {
            return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                          pendingEvents_.data(), pendingCount_);
        }, processor_);
        if (!processed) return false;
        for (std::uint32_t frame = 0U; frame < frames; ++frame) {
            output[0][frame] = sanitize(interleavedScratch_[frame].left);
            output[1][frame] = sanitize(interleavedScratch_[frame].right);
        }
        nextFrame_ += frames;
        pendingCount_ = 0U;
        return true;
    }

    std::uint32_t maximumParameterEventsPerBlock() const noexcept override {
        return ModulationFxProcessor::kMaximumControlEventsPerBlock;
    }

    std::int32_t fixedLatencySamples() const noexcept override {
        return prepared_ ? static_cast<std::int32_t>(ModulationFxProcessor::algorithmicLatencySamples()) : -1;
    }
    std::uint32_t startupWarmupFrames() const noexcept override {
        if (!prepared_) return 0U;
        const auto warmup = fxStartupWarmupUpperBoundSamples(ordinal_, spec_);
        return warmup.supported ? warmup.frames : 0U;
    }
    bool latencyIsFrequencyDependent() const noexcept override { return false; }

private:
    static constexpr std::uint64_t kMaximumExactFrame = 1ULL << 53U;

    void restoreParameterState() noexcept {
        for (std::size_t i = 0U; i < parameterState_.size(); ++i) {
            if (hasParameterState_[i] && pendingCount_ < pendingEvents_.size())
                pendingEvents_[pendingCount_++] = parameterState_[i];
        }
    }

    std::uint16_t ordinal_ = 0U;
    ModulationFxKind kind_ = ModulationFxKind::LoFi;
    ModulationVariant processor_{};
    ProcessSpec spec_{};
    std::vector<StereoFrame> interleavedScratch_;
    std::array<ModulationFxEvent, ModulationFxProcessor::kMaximumControlEventsPerBlock> pendingEvents_{};
    std::array<ModulationFxEvent, 9U> parameterState_{};
    std::array<bool, 9U> hasParameterState_{};
    std::uint64_t nextFrame_ = 0U;
    std::uint32_t pendingCount_ = 0U;
    bool prepared_ = false;
};

using AdditionalVariant = std::variant<RadioFx, SustainerFx, SlowGearFx, StereoEnhancerFx,
                                       ModulatedDelayFx, RhythmicFxProcessor,
                                       SpatialFxAdapter, PreampModelFxProcessor,
                                       DistortionFxProcessor, OctaveModelsFxProcessor,
                                       TemporalFxAdapter>;

struct AdditionalControlEvent {
    std::uint32_t frameOffset = 0U;
    std::uint8_t control = 0U;
    float value = 0.0f;
    FxParameterId parameter = FxParameterId::FrequencyHz;
};

class AdditionalFxAdapter final : public FxProcessor {
public:
    explicit AdditionalFxAdapter(std::uint16_t ordinal) noexcept : ordinal_(ordinal) {}

    std::uint16_t ordinal() const noexcept override { return ordinal_; }

    bool prepare(const ProcessSpec& spec) noexcept override {
        if (!validProcessSpec(spec) || spec.channels != 2U || !isAdditionalOrdinal(ordinal_)) return false;
        WEBRC_FX_TRY {
            AdditionalVariant candidate{};
            if (!makeVariant(candidate)) return false;
            const auto candidateReady = std::visit([this, &spec](auto& processor) {
                using T = std::decay_t<decltype(processor)>;
                if constexpr (std::is_base_of_v<CompositeFxProcessor, T>) {
                    return processor.prepare(spec);
                } else if constexpr (std::is_same_v<T, ModulatedDelayFx>) {
                    return processor.prepare(spec, modulatedDelayKind());
                } else if constexpr (std::is_same_v<T, RhythmicFxProcessor>) {
                    return processor.prepare(spec, rhythmicKind());
                } else if constexpr (std::is_same_v<T, PreampModelFxProcessor>) {
                    return processor.prepare(spec, preampModelOptions_);
                } else if constexpr (std::is_same_v<T, DistortionFxProcessor>) {
                    return processor.prepare(spec);
                } else if constexpr (std::is_same_v<T, OctaveModelsFxProcessor>) {
                    return processor.prepare(spec);
                } else if constexpr (std::is_same_v<T, TemporalFxAdapter>) {
                    return processor.prepare(spec, temporalKind());
                } else {
                    return processor.prepare(spec, spatialKind());
                }
            }, candidate);
            if (!candidateReady) return false;
            const auto warmup = fxStartupWarmupUpperBoundSamples(ordinal_, spec);
            if (!warmup.supported) return false;
            std::uint32_t candidateWarmupFrames = warmup.frames;
            if (ordinal_ == 23U) {
                const auto* model = std::get_if<PreampModelFxProcessor>(&candidate);
                if (!model) return false;
                const auto latency = model->latency();
                const std::uint64_t selectedWarmup =
                    static_cast<std::uint64_t>(latency.fixedMixedPathSamples) +
                    latency.generatedSpeakerIrFrames + latency.micReflectionDelaySamples;
                if (selectedWarmup > warmup.frames ||
                    selectedWarmup > std::numeric_limits<std::uint32_t>::max()) return false;
                candidateWarmupFrames = static_cast<std::uint32_t>(selectedWarmup);
            }
            std::vector<StereoFrame> candidateScratch(spec.maxBlockFrames);
            processor_ = std::move(candidate);
            interleavedScratch_ = std::move(candidateScratch);
            spec_ = spec;
            startupWarmupFrames_ = candidateWarmupFrames;
            nextFrame_ = 0U;
            pendingCount_ = 0U;
            prepared_ = true;
            initializeAppliedStateFromDefaults();
            restoreParameterState();
            return true;
        } WEBRC_FX_CATCH_ALL {
            return false;
        }
    }

    void reset() noexcept override {
        if (!prepared_) return;
        std::visit([](auto& processor) { processor.reset(0U); }, processor_);
        nextFrame_ = 0U;
        pendingCount_ = 0U;
        initializeAppliedStateFromTargets();
        restoreParameterState();
    }

    bool validateBlockRequest(std::uint32_t channels, std::uint32_t frames) const noexcept override {
        return prepared_ && channels == 2U && channels == spec_.channels &&
               frames <= spec_.maxBlockFrames;
    }

    bool validParameter(FxParameterId id, float value) const noexcept override {
        return parameterValueValid(id, value);
    }

    bool isPrepareTimeParameter(FxParameterId id) const noexcept override {
        return ordinal_ == 23U && isPreampModelSelector(id);
    }

    bool validateParameterEvents(const FxParameterEvent* events,
                                 std::uint32_t eventCount) const noexcept override {
        if (eventCount > maximumParameterEventsPerBlock() || (eventCount != 0U && !events)) return false;
        std::array<float, 64U> candidate{};
        std::array<FxParameterId, 64U> ids{};
        std::size_t count = 0U;
        std::size_t descriptorCount = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, descriptorCount);
        if (!descriptors || descriptorCount > candidate.size()) return false;
        for (std::size_t i = 0U; i < descriptorCount; ++i) {
            ids[i] = descriptors[i].id;
            candidate[i] = currentValue(ids[i]);
            count = descriptorCount;
        }

        std::uint32_t cursor = 0U;
        while (cursor < eventCount) {
            const auto frameOffset = events[cursor].frameOffset;
            auto end = cursor;
            while (end < eventCount && events[end].frameOffset == frameOffset) {
                // Model selectors allocate/rebuild model-dependent resources.
                // They are accepted only on a fresh inactive candidate before
                // prepare(), never as callback-time automation.
                if (ordinal_ == 23U && isPreampModelSelector(events[end].parameter)) return false;
                if (!parameterValueValid(events[end].parameter, events[end].value)) return false;
                std::size_t index = 0U;
                if (!parameterIndex(events[end].parameter, ids, count, index)) return false;
                candidate[index] = events[end].value;
                ++end;
            }
            if (!validCoupledState(ids, candidate, count)) return false;
            cursor = end;
        }
        return eventCount == 0U || count != 0U;
    }

    bool setParameter(FxParameterId id, float value) noexcept override {
        if (!parameterValueValid(id, value)) return false;
        if (ordinal_ == 23U && isPreampModelSelector(id)) {
            if (prepared_) return false;
            switch (id) {
            case FxParameterId::AmpModel:
                preampModelOptions_.ampType = static_cast<PreampAmpModel>(static_cast<std::uint8_t>(value));
                break;
            case FxParameterId::SpeakerModel:
                preampModelOptions_.speakerType = static_cast<PreampSpeakerModel>(static_cast<std::uint8_t>(value));
                break;
            case FxParameterId::MicModel:
                preampModelOptions_.micType = static_cast<PreampMicModel>(static_cast<std::uint8_t>(value));
                break;
            case FxParameterId::MicDistance:
                preampModelOptions_.micDistance = static_cast<PreampMicDistance>(static_cast<std::uint8_t>(value));
                break;
            case FxParameterId::MicPositionCm:
                preampModelOptions_.micPositionCm = static_cast<std::uint8_t>(value);
                break;
            default: return false;
            }
            return storeParameterValue(id, value);
        }
        std::uint8_t control = 0U;
        if (!controlForParameter(id, control)) return false;
        if (prepared_) {
            bool replaced = false;
            for (std::uint32_t i = pendingCount_; i > 0U; --i) {
                auto& pending = pendingEvents_[i - 1U];
                if (pending.frameOffset == 0U && pending.parameter == id) {
                    pending = {0U, control, value, id};
                    replaced = true;
                    break;
                }
            }
            if (!replaced) {
                if (pendingCount_ >= pendingEvents_.size()) return false;
                pendingEvents_[pendingCount_++] = {0U, control, value, id};
            }
        }
        return storeParameterValue(id, value);
    }

    bool processBlock(const float* const* input, float* const* output,
                      std::uint32_t channels, std::uint32_t frames) noexcept override {
        if (!validateBlockRequest(channels, frames) || (frames > 0U && (!input || !output))) return false;
        if (frames == 0U) return true;
        if (!input[0] || !input[1] || !output[0] || !output[1] ||
            nextFrame_ > kMaximumExactFrame || frames > kMaximumExactFrame - nextFrame_) return false;
        for (std::uint32_t frame = 0U; frame < frames; ++frame)
            interleavedScratch_[frame] = {sanitize(input[0][frame]), sanitize(input[1][frame])};

        const bool processed = std::visit([this, frames](auto& processor) {
            using T = std::decay_t<decltype(processor)>;
            if constexpr (std::is_base_of_v<CompositeFxProcessor, T>) {
                std::array<CompositeFxEvent, kMaximumFamilyEvents> events{};
                fillEvents(events);
                return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                              events.data(), pendingCount_);
            } else if constexpr (std::is_same_v<T, ModulatedDelayFx>) {
                std::array<ModulatedDelayEvent, kMaximumFamilyEvents> events{};
                fillEvents(events);
                return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                              events.data(), pendingCount_);
            } else if constexpr (std::is_same_v<T, RhythmicFxProcessor>) {
                std::array<RhythmicFxEvent, kMaximumFamilyEvents> events{};
                fillEvents(events);
                return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                              events.data(), pendingCount_);
            } else if constexpr (std::is_same_v<T, PreampModelFxProcessor>) {
                std::array<PreampFxEvent, kMaximumFamilyEvents> events{};
                fillEvents(events);
                return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                              events.data(), pendingCount_);
            } else if constexpr (std::is_same_v<T, DistortionFxProcessor>) {
                std::array<DistortionFxEvent, kMaximumFamilyEvents> events{};
                fillEvents(events);
                return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                              events.data(), pendingCount_);
            } else if constexpr (std::is_same_v<T, OctaveModelsFxProcessor>) {
                std::array<OctaveModelsEvent, kMaximumFamilyEvents> events{};
                fillEvents(events);
                return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                              events.data(), pendingCount_);
            } else if constexpr (std::is_same_v<T, TemporalFxAdapter>) {
                std::array<TemporalFxEvent, kMaximumFamilyEvents> events{};
                fillEvents(events);
                return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                              events.data(), pendingCount_);
            } else {
                std::array<SpatialFxEvent, kMaximumFamilyEvents> events{};
                fillEvents(events);
                return processor.processBlock(nextFrame_, interleavedScratch_.data(), frames,
                                              events.data(), pendingCount_);
            }
        }, processor_);
        if (!processed) return false;
        for (std::uint32_t frame = 0U; frame < frames; ++frame) {
            output[0][frame] = sanitize(interleavedScratch_[frame].left);
            output[1][frame] = sanitize(interleavedScratch_[frame].right);
        }
        rememberAppliedEvents();
        nextFrame_ += frames;
        pendingCount_ = 0U;
        return true;
    }

    std::uint32_t maximumParameterEventsPerBlock() const noexcept override {
        return kMaximumFamilyEvents;
    }

    bool canAcceptParameterEvents(std::uint32_t eventCount) const noexcept override {
        return eventCount <= pendingEvents_.size() - pendingCount_;
    }

    std::int32_t fixedLatencySamples() const noexcept override {
        if (!prepared_) return -1;
        if (isModulatedDelayOrdinal(ordinal_)) return -1;
        if (ordinal_ == 23U) {
            const auto* processor = std::get_if<PreampModelFxProcessor>(&processor_);
            return processor ? static_cast<std::int32_t>(processor->latency().fixedMixedPathSamples) : -1;
        }
        if (ordinal_ == 24U) {
            const auto* processor = std::get_if<DistortionFxProcessor>(&processor_);
            return processor ? processor->latency().fixedAlgorithmicSamples : -1;
        }
        if (ordinal_ == 28U) {
            const auto* processor = std::get_if<OctaveModelsFxProcessor>(&processor_);
            return processor ? static_cast<std::int32_t>(processor->latency().fixedMixedPathSamples) : -1;
        }
        if (ordinal_ >= 40U && ordinal_ <= 45U) {
            const auto* processor = std::get_if<TemporalFxAdapter>(&processor_);
            if (!processor) return -1;
            const auto timing = processor->latency();
            if (timing.fixedAlgorithmicSamples < 0 ||
                timing.maximumWetDelaySamples > timing.minimumWetDelaySamples) return -1;
            return timing.fixedAlgorithmicSamples;
        }
        return 0;
    }

    std::uint32_t startupWarmupFrames() const noexcept override {
        return prepared_ ? startupWarmupFrames_ : 0U;
    }

    bool latencyIsFrequencyDependent() const noexcept override {
        if (ordinal_ == 23U || ordinal_ == 24U) return true;
        if (ordinal_ >= 40U && ordinal_ <= 45U) {
            const auto* processor = std::get_if<TemporalFxAdapter>(&processor_);
            return processor && processor->latency().wetPathGroupDelaySamples > 0.0;
        }
        return ordinal_ == 8U || ordinal_ == 31U;
    }

private:
    static constexpr std::uint32_t kMaximumFamilyEvents = 64U;
    static constexpr std::uint64_t kMaximumExactFrame = 1ULL << 53U;

    static bool isModulatedDelayOrdinal(std::uint16_t ordinal) noexcept {
        return ordinal == 5U || ordinal == 33U || ordinal == 37U || ordinal == 39U || ordinal == 46U;
    }

    static bool isAdditionalOrdinal(std::uint16_t ordinal) noexcept {
        return ordinal == 5U || ordinal == 8U || ordinal == 11U || ordinal == 13U ||
               ordinal == 27U || ordinal == 31U || ordinal == 33U || ordinal == 34U ||
               ordinal == 35U || ordinal == 37U || ordinal == 38U || ordinal == 39U ||
               ordinal == 46U || ordinal == 48U || ordinal == 49U || ordinal == 23U ||
               ordinal == 24U || ordinal == 28U || (ordinal >= 40U && ordinal <= 45U);
    }

    static bool isPreampModelSelector(FxParameterId id) noexcept {
        return id == FxParameterId::AmpModel || id == FxParameterId::SpeakerModel ||
               id == FxParameterId::MicModel || id == FxParameterId::MicDistance ||
               id == FxParameterId::MicPositionCm;
    }

    ModulatedDelayKind modulatedDelayKind() const noexcept {
        switch (ordinal_) {
        case 5U: return ModulatedDelayKind::Flanger;
        case 33U: return ModulatedDelayKind::Vibrato;
        case 37U: return ModulatedDelayKind::PanningDelay;
        case 39U: return ModulatedDelayKind::ModDelay;
        default: return ModulatedDelayKind::Chorus;
        }
    }

    RhythmicFxKind rhythmicKind() const noexcept {
        if (ordinal_ == 27U) return RhythmicFxKind::Isolator;
        return ordinal_ == 34U ? RhythmicFxKind::PatternSlicer : RhythmicFxKind::StepSlicer;
    }

    SpatialFxKind spatialKind() const noexcept {
        if (ordinal_ == 38U) return SpatialFxKind::ReverseDelay;
        return ordinal_ == 48U ? SpatialFxKind::GateReverb : SpatialFxKind::ReverseReverb;
    }

    TemporalFxKind temporalKind() const noexcept {
        switch (ordinal_) {
        case 40U: return TemporalFxKind::TapeEcho;
        case 41U: return TemporalFxKind::GranularDelay;
        case 42U: return TemporalFxKind::Warp;
        case 43U: return TemporalFxKind::Twist;
        case 44U: return TemporalFxKind::Roll;
        default: return TemporalFxKind::Freeze;
        }
    }

    bool makeVariant(AdditionalVariant& out) const noexcept {
        switch (ordinal_) {
        case 8U: out.emplace<RadioFx>(); return true;
        case 11U: out.emplace<SustainerFx>(); return true;
        case 13U: out.emplace<SlowGearFx>(); return true;
        case 31U: out.emplace<StereoEnhancerFx>(); return true;
        case 5U: case 33U: case 37U: case 39U: case 46U:
            out.emplace<ModulatedDelayFx>(); return true;
        case 27U: case 34U: case 35U:
            out.emplace<RhythmicFxProcessor>(); return true;
        case 38U: case 48U: case 49U:
            out.emplace<SpatialFxAdapter>(); return true;
        case 23U: out.emplace<PreampModelFxProcessor>(); return true;
        case 24U: out.emplace<DistortionFxProcessor>(); return true;
        case 28U: out.emplace<OctaveModelsFxProcessor>(); return true;
        case 40U: case 41U: case 42U: case 43U: case 44U: case 45U:
            out.emplace<TemporalFxAdapter>(); return true;
        default: return false;
        }
    }

    bool controlForParameter(FxParameterId id, std::uint8_t& control) const noexcept {
        if (ordinal_ == 23U) {
            PreampFxControl value{};
            switch (id) {
            case FxParameterId::Active: value = PreampFxControl::Active; break;
            case FxParameterId::Mix: value = PreampFxControl::Mix; break;
            case FxParameterId::Drive: value = PreampFxControl::Drive; break;
            case FxParameterId::BassDb: value = PreampFxControl::BassDb; break;
            case FxParameterId::MidDb: value = PreampFxControl::MidDb; break;
            case FxParameterId::TrebleDb: value = PreampFxControl::TrebleDb; break;
            case FxParameterId::PresenceDb: value = PreampFxControl::PresenceDb; break;
            case FxParameterId::OutputDb: value = PreampFxControl::OutputDb; break;
            default: return false;
            }
            control = static_cast<std::uint8_t>(value);
            return true;
        }
        if (ordinal_ == 24U) {
            DistortionFxControl value{};
            switch (id) {
            case FxParameterId::Active: value = DistortionFxControl::Active; break;
            case FxParameterId::Mix: value = DistortionFxControl::Mix; break;
            case FxParameterId::Drive: value = DistortionFxControl::Drive; break;
            case FxParameterId::ToneHz: value = DistortionFxControl::ToneHz; break;
            case FxParameterId::OutputDb: value = DistortionFxControl::OutputDb; break;
            default: return false;
            }
            control = static_cast<std::uint8_t>(value);
            return true;
        }
        if (ordinal_ == 28U) {
            OctaveModelsControl value{};
            switch (id) {
            case FxParameterId::Active: value = OctaveModelsControl::Active; break;
            case FxParameterId::Mix: value = OctaveModelsControl::Mix; break;
            case FxParameterId::OctaveMode: value = OctaveModelsControl::Mode; break;
            default: return false;
            }
            control = static_cast<std::uint8_t>(value);
            return true;
        }
        if (ordinal_ >= 40U && ordinal_ <= 45U) {
            TemporalFxControl value{};
            switch (id) {
            case FxParameterId::Active: value = TemporalFxControl::Active; break;
            case FxParameterId::Wet: value = TemporalFxControl::Wet; break;
            case FxParameterId::DelayMs: value = TemporalFxControl::DelayMs; break;
            case FxParameterId::Feedback: value = TemporalFxControl::Feedback; break;
            case FxParameterId::ToneHz: value = TemporalFxControl::ToneHz; break;
            case FxParameterId::WowDepthMs: value = TemporalFxControl::WowDepthMs; break;
            case FxParameterId::WowRateHz: value = TemporalFxControl::WowRateHz; break;
            case FxParameterId::Drive: value = TemporalFxControl::Drive; break;
            case FxParameterId::GrainMs: value = TemporalFxControl::GrainMs; break;
            case FxParameterId::DensityHz: value = TemporalFxControl::DensityHz; break;
            case FxParameterId::PitchRatio: value = TemporalFxControl::PitchRatio; break;
            case FxParameterId::PositionSpread: value = TemporalFxControl::PositionSpread; break;
            case FxParameterId::Freeze: value = TemporalFxControl::Freeze; break;
            case FxParameterId::WarpAmount: value = TemporalFxControl::WarpAmount; break;
            case FxParameterId::ReverbTimeSeconds: value = TemporalFxControl::ReverbTimeSeconds; break;
            case FxParameterId::DampingHz: value = TemporalFxControl::DampingHz; break;
            case FxParameterId::TempoBpm: value = TemporalFxControl::TempoBpm; break;
            case FxParameterId::SubdivisionBeats: value = TemporalFxControl::SubdivisionBeats; break;
            case FxParameterId::TwistMacro: value = TemporalFxControl::TwistMacro; break;
            default: return false;
            }
            control = static_cast<std::uint8_t>(value);
            return true;
        }
        if (ordinal_ == 8U || ordinal_ == 11U || ordinal_ == 13U || ordinal_ == 31U) {
            CompositeFxControl value{};
            switch (id) {
            case FxParameterId::Active: value = CompositeFxControl::Active; break;
            case FxParameterId::Wet: value = CompositeFxControl::Wet; break;
            case FxParameterId::RadioHighPassHz: value = CompositeFxControl::RadioHighPassHz; break;
            case FxParameterId::RadioLowPassHz: value = CompositeFxControl::RadioLowPassHz; break;
            case FxParameterId::Drive: value = CompositeFxControl::RadioDrive; break;
            case FxParameterId::BitDepth: value = CompositeFxControl::RadioBitDepth; break;
            case FxParameterId::HoldFrames: value = CompositeFxControl::RadioHoldFrames; break;
            case FxParameterId::BitMix: value = CompositeFxControl::RadioBitMix; break;
            case FxParameterId::ThresholdDb: value = CompositeFxControl::SustainerThresholdDb; break;
            case FxParameterId::Ratio: value = CompositeFxControl::SustainerRatio; break;
            case FxParameterId::AttackMs: value = CompositeFxControl::SustainerAttackMs; break;
            case FxParameterId::ReleaseMs: value = CompositeFxControl::SustainerReleaseMs; break;
            case FxParameterId::RmsMix: value = CompositeFxControl::SustainerRmsMix; break;
            case FxParameterId::MakeupDb: value = CompositeFxControl::SustainerMakeupDb; break;
            case FxParameterId::SlowGearAttackMs: value = CompositeFxControl::SlowGearAttackMs; break;
            case FxParameterId::SlowGearReleaseMs: value = CompositeFxControl::SlowGearReleaseMs; break;
            case FxParameterId::Sensitivity: value = CompositeFxControl::SlowGearSensitivity; break;
            case FxParameterId::StereoHighWidth: value = CompositeFxControl::StereoHighWidth; break;
            case FxParameterId::StereoLowWidth: value = CompositeFxControl::StereoLowWidth; break;
            case FxParameterId::SmoothingMs: value = CompositeFxControl::StereoSmoothingMs; break;
            default: return false;
            }
            control = static_cast<std::uint8_t>(value);
            return true;
        }
        if (isModulatedDelayOrdinal(ordinal_)) {
            ModulatedDelayControl value{};
            switch (id) {
            case FxParameterId::Active: value = ModulatedDelayControl::Active; break;
            case FxParameterId::Wet: value = ModulatedDelayControl::Wet; break;
            case FxParameterId::RateHz: value = ModulatedDelayControl::RateHz; break;
            case FxParameterId::DelayMs: value = ModulatedDelayControl::BaseDelayMs; break;
            case FxParameterId::ModulationDepthMs: value = ModulatedDelayControl::DepthMs; break;
            case FxParameterId::Feedback: value = ModulatedDelayControl::Feedback; break;
            case FxParameterId::Pan: value = ModulatedDelayControl::Pan; break;
            case FxParameterId::Depth: value = ModulatedDelayControl::PanDepth; break;
            case FxParameterId::CrossFeedback: value = ModulatedDelayControl::CrossFeedback; break;
            default: return false;
            }
            control = static_cast<std::uint8_t>(value);
            return true;
        }
        if (ordinal_ == 27U || ordinal_ == 34U || ordinal_ == 35U) {
            RhythmicFxControl value{};
            switch (id) {
            case FxParameterId::Active: value = RhythmicFxControl::Active; break;
            case FxParameterId::Wet: value = RhythmicFxControl::Wet; break;
            case FxParameterId::TempoBpm: value = RhythmicFxControl::TempoBpm; break;
            case FxParameterId::EdgeMilliseconds: value = RhythmicFxControl::EdgeMilliseconds; break;
            case FxParameterId::PatternId: value = RhythmicFxControl::PatternId; break;
            case FxParameterId::LowGainDb: value = RhythmicFxControl::LowGainDb; break;
            case FxParameterId::MidGainDb: value = RhythmicFxControl::MidGainDb; break;
            case FxParameterId::HighGainDb: value = RhythmicFxControl::HighGainDb; break;
            case FxParameterId::LowMute: value = RhythmicFxControl::LowMute; break;
            case FxParameterId::MidMute: value = RhythmicFxControl::MidMute; break;
            case FxParameterId::HighMute: value = RhythmicFxControl::HighMute; break;
            default: return false;
            }
            control = static_cast<std::uint8_t>(value);
            return true;
        }

        SpatialFxControl value{};
        switch (id) {
        case FxParameterId::Active: value = SpatialFxControl::Active; break;
        case FxParameterId::Wet: value = SpatialFxControl::Wet; break;
        case FxParameterId::Feedback: value = SpatialFxControl::Feedback; break;
        case FxParameterId::ReverbTimeSeconds: value = SpatialFxControl::ReverbTimeSeconds; break;
        case FxParameterId::DampingHz: value = SpatialFxControl::DampingHz; break;
        case FxParameterId::ModulationRateHz: value = SpatialFxControl::ModulationRateHz; break;
        case FxParameterId::ModulationDepthMs: value = SpatialFxControl::ModulationDepthMs; break;
        case FxParameterId::GateThresholdDb: value = SpatialFxControl::GateThresholdDb; break;
        case FxParameterId::GateHoldMs: value = SpatialFxControl::GateHoldMs; break;
        case FxParameterId::GateReleaseMs: value = SpatialFxControl::GateReleaseMs; break;
        default: return false;
        }
        control = static_cast<std::uint8_t>(value);
        return true;
    }

    bool parameterValueValid(FxParameterId id, float value) const noexcept {
        if (!std::isfinite(value)) return false;
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, count);
        const FxParameterDescriptor* descriptor = nullptr;
        for (std::size_t i = 0U; i < count; ++i) if (descriptors[i].id == id) { descriptor = &descriptors[i]; break; }
        if (!descriptor || value < descriptor->minimum || value > descriptor->maximum) return false;
        const float sampleRate = prepared_ ? spec_.sampleRate : 192000.0f;
        if (id == FxParameterId::RadioHighPassHz && value > std::min(1200.0f, sampleRate * 0.40f)) return false;
        if (id == FxParameterId::RadioLowPassHz && value > std::min(12000.0f, sampleRate * 0.45f)) return false;
        if (id == FxParameterId::RateHz && isModulatedDelayOrdinal(ordinal_) &&
            value > std::min(20.0f, sampleRate * 0.25f)) return false;
        if (id == FxParameterId::DelayMs && isModulatedDelayOrdinal(ordinal_)) {
            const float minimumMs = static_cast<float>(ModulatedDelayFx::kMinimumDelaySamples * 1000.0 / sampleRate);
            float maximumMs = 30.0f;
            if (ordinal_ == 33U) maximumMs = 35.0f;
            else if (ordinal_ == 37U || ordinal_ == 39U) maximumMs = 2000.0f;
            else if (ordinal_ == 46U) maximumMs = 120.0f;
            if (value < std::max(descriptor->minimum, minimumMs) || value > maximumMs) return false;
        }
        if (id == FxParameterId::ModulationDepthMs && isModulatedDelayOrdinal(ordinal_)) {
            float maxDepth = 8.0f;
            if (ordinal_ == 33U) maxDepth = 10.0f;
            else if (ordinal_ == 37U || ordinal_ == 39U) maxDepth = 50.0f;
            else if (ordinal_ == 46U) maxDepth = 20.0f;
            if (value > maxDepth) return false;
        }
        if (id == FxParameterId::Feedback && isModulatedDelayOrdinal(ordinal_)) {
            if (ordinal_ == 33U) return value == 0.0f;
            if (ordinal_ == 37U) return value >= 0.0f && value <= 0.90f;
            if (ordinal_ == 46U) return value >= -0.80f && value <= 0.80f;
            return value >= -0.88f && value <= 0.88f;
        }
        if (id == FxParameterId::DampingHz && (ordinal_ == 48U || ordinal_ == 49U) &&
            value > sampleRate * 0.49f) return false;
        if ((id == FxParameterId::ToneHz && (ordinal_ == 40U || ordinal_ == 43U)) ||
            (id == FxParameterId::DampingHz && ordinal_ == 42U)) {
            if (value > std::min(16000.0f, sampleRate * 0.45f)) return false;
        }
        if (ordinal_ == 40U && id == FxParameterId::DelayMs) {
            const float maxDelayMs = std::min(800.0f,
                TemporalFxOptions{}.maximumDelaySeconds * 1000.0f / 1.5f);
            if (value > maxDelayMs) return false;
        }
        if (ordinal_ == 43U && id == FxParameterId::DelayMs &&
            value > TemporalFxOptions{}.maximumDelaySeconds * 1000.0f) return false;
        if (id == FxParameterId::PatternId) {
            const auto patternCount = rhythmicFxPatternCount(rhythmicKind());
            if (patternCount == 0U || value >= static_cast<float>(patternCount) || std::floor(value) != value)
                return false;
        }
        if (ordinal_ == 23U && isPreampModelSelector(id)) {
            if (std::floor(value) != value) return false;
            switch (id) {
            case FxParameterId::AmpModel: return value <= static_cast<float>(PreampAmpModel::CoreMetal);
            case FxParameterId::SpeakerModel: return value <= static_cast<float>(PreampSpeakerModel::EightByTwelve);
            case FxParameterId::MicModel: return value <= static_cast<float>(PreampMicModel::Flat);
            case FxParameterId::MicDistance: return value <= static_cast<float>(PreampMicDistance::OnMic);
            case FxParameterId::MicPositionCm: return value <= 10.0f;
            default: return false;
            }
        }
        if (ordinal_ == 28U && id == FxParameterId::OctaveMode && std::floor(value) != value)
            return false;
        if (ordinal_ == 24U && id == FxParameterId::ToneHz && prepared_ &&
            value > spec_.sampleRate * 0.45f) return false;
        if (id == FxParameterId::Active || id == FxParameterId::LowMute ||
            id == FxParameterId::MidMute || id == FxParameterId::HighMute ||
            id == FxParameterId::Freeze) {
            if (value != 0.0f && value != 1.0f) return false;
        }
        if (id == FxParameterId::BitDepth || id == FxParameterId::HoldFrames ||
            id == FxParameterId::Waveform) {
            if (std::floor(value) != value) return false;
        }
        return true;
    }

    float currentValue(FxParameterId id) const noexcept {
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, count);
        if (!descriptors) return 0.0f;
        for (std::size_t i = 0U; i < count; ++i) {
            if (descriptors[i].id != id) continue;
            return hasParameterValue_[i] ? parameterValues_[i] : descriptors[i].defaultValue;
        }
        return 0.0f;
    }

    static bool parameterIndex(FxParameterId id, const std::array<FxParameterId, 64U>& ids,
                               std::size_t count, std::size_t& index) noexcept {
        for (std::size_t i = 0U; i < count; ++i) if (ids[i] == id) { index = i; return true; }
        return false;
    }

    bool validCoupledState(const std::array<FxParameterId, 64U>& ids,
                           const std::array<float, 64U>& values,
                           std::size_t count) const noexcept {
        const auto valueFor = [&ids, &values, count](FxParameterId id, float fallback) {
            for (std::size_t i = 0U; i < count; ++i) if (ids[i] == id) return values[i];
            return fallback;
        };
        if (ordinal_ == 8U) {
            return valueFor(FxParameterId::RadioHighPassHz, 220.0f) <
                   valueFor(FxParameterId::RadioLowPassHz, 3400.0f);
        }
        if (isModulatedDelayOrdinal(ordinal_)) {
            const float base = valueFor(FxParameterId::DelayMs, 8.0f);
            const float depth = valueFor(FxParameterId::ModulationDepthMs, 5.5f);
            const float maximumMs = ordinal_ == 5U ? 30.0f
                : ordinal_ == 33U ? 35.0f
                : ordinal_ == 46U ? 120.0f : 2000.0f;
            const float sampleRate = prepared_ ? spec_.sampleRate : 48000.0f;
            const float minimumMs = static_cast<float>(ModulatedDelayFx::kMinimumDelaySamples *
                1000.0 / static_cast<double>(sampleRate));
            return base - depth >= minimumMs && base + depth <= maximumMs;
        }
        if (ordinal_ == 40U) {
            // Tape wow modulates the read position around the requested base.
            // Validate the pair as a single shadow state before any block is
            // processed so an out-of-range late event cannot partially apply.
            const float delay = valueFor(FxParameterId::DelayMs, 240.0f);
            const float wowDepth = valueFor(FxParameterId::WowDepthMs, 1.1f);
            const float maxDelayMs = std::min(800.0f,
                TemporalFxOptions{}.maximumDelaySeconds * 1000.0f / 1.5f);
            return delay >= 50.0f && delay + wowDepth <= maxDelayMs;
        }
        return true;
    }

    bool storeParameterValue(FxParameterId id, float value) noexcept {
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, count);
        for (std::size_t i = 0U; descriptors && i < count; ++i) {
            if (descriptors[i].id != id) continue;
            parameterValues_[i] = value;
            hasParameterValue_[i] = true;
            return true;
        }
        return false;
    }

    void fillEvents(std::array<CompositeFxEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<CompositeFxControl>(pendingEvents_[i].control), pendingEvents_[i].value};
        if (ordinal_ == 8U) {
            std::uint32_t highPassIndex = pendingCount_;
            std::uint32_t lowPassIndex = pendingCount_;
            float targetHighPass = appliedValue(FxParameterId::RadioHighPassHz, 220.0f);
            float targetLowPass = appliedValue(FxParameterId::RadioLowPassHz, 3400.0f);
            for (std::uint32_t i = 0U; i < pendingCount_; ++i) {
                if (pendingEvents_[i].parameter == FxParameterId::RadioHighPassHz) {
                    highPassIndex = i;
                    targetHighPass = pendingEvents_[i].value;
                } else if (pendingEvents_[i].parameter == FxParameterId::RadioLowPassHz) {
                    lowPassIndex = i;
                    targetLowPass = pendingEvents_[i].value;
                }
            }
            // The processor validates each filter update against the other
            // filter's current cutoff. Order simultaneous moves to keep every
            // intermediate state inside the valid high-pass < low-pass region.
            if (highPassIndex < pendingCount_ && lowPassIndex < pendingCount_) {
                const auto appliedHighPass = appliedValue(FxParameterId::RadioHighPassHz, 220.0f);
                const auto appliedLowPass = appliedValue(FxParameterId::RadioLowPassHz, 3400.0f);
                const bool lowPassMustMoveFirst = targetHighPass >= appliedLowPass;
                const bool highPassMustMoveFirst = targetLowPass <= appliedHighPass;
                if (lowPassMustMoveFirst && !highPassMustMoveFirst && highPassIndex < lowPassIndex)
                    std::swap(out[highPassIndex], out[lowPassIndex]);
                else if (highPassMustMoveFirst && !lowPassMustMoveFirst && lowPassIndex < highPassIndex)
                    std::swap(out[highPassIndex], out[lowPassIndex]);
            }
        }
    }
    void fillEvents(std::array<ModulatedDelayEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<ModulatedDelayControl>(pendingEvents_[i].control), pendingEvents_[i].value};
    }
    void fillEvents(std::array<RhythmicFxEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<RhythmicFxControl>(pendingEvents_[i].control), 0U, pendingEvents_[i].value};
    }
    void fillEvents(std::array<SpatialFxEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<SpatialFxControl>(pendingEvents_[i].control), pendingEvents_[i].value};
    }
    void fillEvents(std::array<PreampFxEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<PreampFxControl>(pendingEvents_[i].control), pendingEvents_[i].value};
    }
    void fillEvents(std::array<DistortionFxEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<DistortionFxControl>(pendingEvents_[i].control), pendingEvents_[i].value};
    }
    void fillEvents(std::array<OctaveFxEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<OctaveFxControl>(pendingEvents_[i].control), pendingEvents_[i].value};
    }
    void fillEvents(std::array<OctaveModelsEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<OctaveModelsControl>(pendingEvents_[i].control), pendingEvents_[i].value};
    }
    void fillEvents(std::array<TemporalFxEvent, kMaximumFamilyEvents>& out) const noexcept {
        for (std::uint32_t i = 0U; i < pendingCount_; ++i)
            out[i] = {pendingEvents_[i].frameOffset,
                      static_cast<TemporalFxControl>(pendingEvents_[i].control), pendingEvents_[i].value};
    }

    void restoreParameterState() noexcept {
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, count);
        if (!descriptors) return;
        for (std::size_t i = 0U; i < count && pendingCount_ < pendingEvents_.size(); ++i) {
            if (!hasParameterValue_[i]) continue;
            std::uint8_t control = 0U;
            if (controlForParameter(descriptors[i].id, control))
                pendingEvents_[pendingCount_++] = {0U, control, parameterValues_[i], descriptors[i].id};
        }
    }

    float appliedValue(FxParameterId id, float fallback) const noexcept {
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, count);
        for (std::size_t i = 0U; descriptors && i < count; ++i)
            if (descriptors[i].id == id) return hasAppliedValue_[i] ? appliedParameterValues_[i] : fallback;
        return fallback;
    }

    void initializeAppliedStateFromDefaults() noexcept {
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, count);
        for (std::size_t i = 0U; descriptors && i < count; ++i) {
            appliedParameterValues_[i] = descriptors[i].defaultValue;
            hasAppliedValue_[i] = true;
        }
    }

    void initializeAppliedStateFromTargets() noexcept {
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, count);
        for (std::size_t i = 0U; descriptors && i < count; ++i) {
            appliedParameterValues_[i] = currentValue(descriptors[i].id);
            hasAppliedValue_[i] = true;
        }
    }

    void rememberAppliedEvents() noexcept {
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal_, count);
        for (std::uint32_t eventIndex = 0U; eventIndex < pendingCount_; ++eventIndex) {
            const auto& event = pendingEvents_[eventIndex];
            for (std::size_t parameterIndexValue = 0U; descriptors && parameterIndexValue < count;
                 ++parameterIndexValue) {
                if (descriptors[parameterIndexValue].id != event.parameter) continue;
                appliedParameterValues_[parameterIndexValue] = event.value;
                hasAppliedValue_[parameterIndexValue] = true;
                break;
            }
        }
    }

    std::uint16_t ordinal_ = 0U;
    AdditionalVariant processor_{};
    ProcessSpec spec_{};
    std::vector<StereoFrame> interleavedScratch_;
    std::array<AdditionalControlEvent, kMaximumFamilyEvents> pendingEvents_{};
    std::array<float, 64U> parameterValues_{};
    std::array<bool, 64U> hasParameterValue_{};
    std::array<float, 64U> appliedParameterValues_{};
    std::array<bool, 64U> hasAppliedValue_{};
    PreampModelOptions preampModelOptions_{};
    std::uint64_t nextFrame_ = 0U;
    std::uint32_t pendingCount_ = 0U;
    std::uint32_t startupWarmupFrames_ = 0U;
    bool prepared_ = false;
};

} // namespace

FxMemoryRequirement fxMemoryRequirement(std::uint16_t ordinal,
                                         const ProcessSpec& spec) noexcept {
    FxMemoryRequirement result{};
    if (!validProcessSpec(spec)) return result;

    std::uint64_t preparedBytes = 0;
    switch (ordinal) {
    case 6U: case 10U: case 12U: case 16U: case 17U: case 19U:
    case 20U: case 21U: case 22U: {
        if (spec.channels != 2U) return {};
        const auto totalBytes = MusicalFxRegistryBridge::requiredPrepareBytes(ordinal, spec);
        if (totalBytes < sizeof(MusicalFxRegistryBridge)) return {};
        result.objectBytes = sizeof(MusicalFxRegistryBridge);
        // This reservation includes the bridge's retained planar scratch and
        // the prepared musical adapter's complete setup peak. The adapter's
        // byte estimator includes its in-object variant storage, so this is a
        // conservative per-instance reservation rather than a compile-time
        // ABI size claim about the wrapped processor.
        result.persistentPreparedBytes = totalBytes - sizeof(MusicalFxRegistryBridge);
        result.supported = true;
        return result;
    }
    case 1U: case 2U: case 3U:
        result.objectBytes = sizeof(TptFilterProcessor);
        break;
    case 4U:
        result.objectBytes = sizeof(PhaserProcessor);
        break;
    case 25U:
        if (spec.channels != 2U) return {};
        result.objectBytes = sizeof(DynamicsProcessor);
        break;
    case 26U:
        result.objectBytes = sizeof(EqProcessor);
        break;
    case 36U: {
        if (spec.channels != 1U && spec.channels != 2U) return {};
        result.objectBytes = sizeof(DelayProcessor);
        const auto maxDelaySamples = static_cast<std::uint64_t>(spec.sampleRate * 2.0f);
        const auto oneDelayBytes = (maxDelaySamples + 4U) * sizeof(float);
        if (oneDelayBytes > std::numeric_limits<std::uint64_t>::max() / 2U) return {};
        preparedBytes = oneDelayBytes * 2U; // two candidate LagrangeDelay buffers
        break;
    }
    case 47U: {
        if (spec.channels != 2U) return {};
        result.objectBytes = sizeof(ReverbProcessor);
        preparedBytes = FdnReverb::requiredPrepareBytes(spec, FdnLineCount::Eight, 0.12f);
        if (preparedBytes == 0U) return {};
        break;
    }
    case 50U: case 51U: case 52U: case 53U: {
        if (spec.channels != 2U) return {};
        result.objectBytes = sizeof(PerformanceFxAdapter);
        const auto kind = performanceKindForOrdinal(ordinal);
        const auto processorBytes = PerformanceFxProcessor::requiredPrepareBytes(spec, kind);
        const auto scratchBytes = static_cast<std::uint64_t>(spec.maxBlockFrames) * sizeof(StereoFrame);
        if (processorBytes == 0U || processorBytes > std::numeric_limits<std::uint64_t>::max() - scratchBytes)
            return {};
        preparedBytes = static_cast<std::uint64_t>(processorBytes) + scratchBytes;
        break;
    }
    case 7U: case 9U: case 29U: case 30U: case 32U: {
        if (spec.channels != 2U) return {};
        result.objectBytes = sizeof(ModulationFxAdapter);
        const auto processorBytes = ModulationFxProcessor::requiredPrepareBytes(
            spec, modulationKindForOrdinal(ordinal));
        const auto scratchBytes = static_cast<std::uint64_t>(spec.maxBlockFrames) * sizeof(StereoFrame);
        if (processorBytes == 0U || scratchBytes > std::numeric_limits<std::uint64_t>::max() / 2U)
            return {};
        // The fixed DSP state is embedded in ModulationVariant (objectBytes);
        // only the planar adapter scratch is separately allocated. Reprepare
        // keeps one current and one candidate scratch buffer alive.
        preparedBytes = scratchBytes;
        result.persistentPreparedBytes = preparedBytes;
        result.prepareScratchBytes = scratchBytes;
        result.supported = true;
        return result;
    }
    case 23U: case 24U: case 28U: case 40U: case 41U: case 42U: case 43U: case 44U: case 45U: {
        if (spec.channels != 2U) return {};
        result.objectBytes = sizeof(AdditionalFxAdapter);
        std::uint64_t moduleBytes = 0U;
        std::uint64_t moduleObjectBytes = 0U;
        if (ordinal == 23U) {
            // Selector choices can change the generated cabinet IR size. The
            // graph preflight has no selector payload yet, so reserve the
            // worst published speaker choice before any model is prepared.
            moduleObjectBytes = sizeof(PreampModelFxProcessor);
            for (std::uint8_t speaker = 0U;
                 speaker <= static_cast<std::uint8_t>(PreampSpeakerModel::EightByTwelve); ++speaker) {
                PreampModelOptions options{};
                options.speakerType = static_cast<PreampSpeakerModel>(speaker);
                const auto bytes = PreampModelFxProcessor::requiredPrepareBytes(spec, options);
                if (bytes == 0U) return {};
                moduleBytes = std::max<std::uint64_t>(moduleBytes, bytes);
            }
        } else if (ordinal == 24U) {
            moduleBytes = DistortionFxProcessor::requiredPrepareBytes(spec);
            moduleObjectBytes = sizeof(DistortionFxProcessor);
        } else if (ordinal == 28U) {
            moduleBytes = OctaveModelsFxProcessor::requiredPrepareBytes(spec);
            moduleObjectBytes = sizeof(OctaveModelsFxProcessor);
        } else {
            const auto kind = ordinal == 40U ? TemporalFxKind::TapeEcho
                : ordinal == 41U ? TemporalFxKind::GranularDelay
                : ordinal == 42U ? TemporalFxKind::Warp
                : ordinal == 43U ? TemporalFxKind::Twist
                : ordinal == 44U ? TemporalFxKind::Roll : TemporalFxKind::Freeze;
            moduleBytes = TemporalFxAdapter::requiredPrepareBytes(spec, kind);
            moduleObjectBytes = sizeof(TemporalFxAdapter);
        }
        if (moduleBytes < moduleObjectBytes) return {};
        const auto moduleHeapBytes = moduleBytes - moduleObjectBytes;
        const auto scratchBytes = static_cast<std::uint64_t>(spec.maxBlockFrames) * sizeof(StereoFrame);
        if (scratchBytes > std::numeric_limits<std::uint64_t>::max() - moduleHeapBytes)
            return {};
        const auto retainedBytes = moduleHeapBytes + scratchBytes;
        if (retainedBytes > std::numeric_limits<std::uint64_t>::max() / 2U ||
            result.objectBytes > std::numeric_limits<std::uint64_t>::max() - 2U * retainedBytes)
            return {};
        result.persistentPreparedBytes = retainedBytes;
        result.prepareScratchBytes = retainedBytes;
        result.supported = moduleBytes != 0U;
        return result;
    }
    case 5U: case 8U: case 11U: case 13U: case 27U: case 31U: case 33U:
    case 34U: case 35U: case 37U: case 38U: case 39U: case 46U: case 48U: case 49U: {
        if (spec.channels != 2U) return {};
        result.objectBytes = sizeof(AdditionalFxAdapter);
        std::uint64_t moduleBytes = 0U;
        std::uint64_t moduleObjectBytes = 0U;
        if (ordinal == 8U) {
            moduleBytes = CompositeFxProcessor::requiredPrepareBytes(spec, CompositeFxKind::Radio);
            moduleObjectBytes = sizeof(RadioFx);
        } else if (ordinal == 11U) {
            moduleBytes = CompositeFxProcessor::requiredPrepareBytes(spec, CompositeFxKind::Sustainer);
            moduleObjectBytes = sizeof(SustainerFx);
        } else if (ordinal == 13U) {
            moduleBytes = CompositeFxProcessor::requiredPrepareBytes(spec, CompositeFxKind::SlowGear);
            moduleObjectBytes = sizeof(SlowGearFx);
        } else if (ordinal == 31U) {
            moduleBytes = CompositeFxProcessor::requiredPrepareBytes(spec, CompositeFxKind::StereoEnhance);
            moduleObjectBytes = sizeof(StereoEnhancerFx);
        } else if (ordinal == 5U || ordinal == 33U || ordinal == 37U ||
                   ordinal == 39U || ordinal == 46U) {
            const auto kind = ordinal == 5U ? ModulatedDelayKind::Flanger
                : ordinal == 33U ? ModulatedDelayKind::Vibrato
                : ordinal == 37U ? ModulatedDelayKind::PanningDelay
                : ordinal == 39U ? ModulatedDelayKind::ModDelay : ModulatedDelayKind::Chorus;
            moduleBytes = ModulatedDelayFx::requiredPrepareBytes(spec, kind);
            moduleObjectBytes = sizeof(ModulatedDelayFx);
        } else if (ordinal == 27U || ordinal == 34U || ordinal == 35U) {
            const auto kind = ordinal == 27U ? RhythmicFxKind::Isolator
                : ordinal == 34U ? RhythmicFxKind::PatternSlicer : RhythmicFxKind::StepSlicer;
            moduleBytes = RhythmicFxProcessor::requiredMemoryBytes(spec, kind);
            moduleObjectBytes = sizeof(RhythmicFxProcessor);
        } else {
            const auto kind = ordinal == 38U ? SpatialFxKind::ReverseDelay
                : ordinal == 48U ? SpatialFxKind::GateReverb : SpatialFxKind::ReverseReverb;
            moduleBytes = SpatialFxAdapter::requiredPrepareBytes(spec, kind);
            moduleObjectBytes = sizeof(SpatialFxAdapter);
        }
        if (moduleBytes < moduleObjectBytes) return {};
        const auto moduleHeapBytes = moduleBytes - moduleObjectBytes;
        const auto scratchBytes = static_cast<std::uint64_t>(spec.maxBlockFrames) * sizeof(StereoFrame);
        if (scratchBytes > std::numeric_limits<std::uint64_t>::max() - moduleHeapBytes) return {};
        const auto retainedBytes = moduleHeapBytes + scratchBytes;
        if (retainedBytes > std::numeric_limits<std::uint64_t>::max() / 2U ||
            result.objectBytes > std::numeric_limits<std::uint64_t>::max() - 2U * retainedBytes)
            return {};
        result.persistentPreparedBytes = retainedBytes;
        // Adapter reprepare is transactional: the existing prepared processor
        // and planar scratch remain live while the candidate family and its
        // scratch are constructed. Reserve the full candidate heap again.
        result.prepareScratchBytes = moduleHeapBytes + scratchBytes;
        result.supported = true;
        return result;
    }
    default:
        return result;
    }

    // Delay and FDN preparation builds a candidate while any active instance is
    // still alive. Reserve both sides of that transactional reprepare peak.
    result.persistentPreparedBytes = preparedBytes;
    result.prepareScratchBytes = preparedBytes;
    result.supported = true;
    return result;
}

FxStartupWarmupRequirement fxStartupWarmupUpperBoundSamples(
    std::uint16_t ordinal, const ProcessSpec& spec) noexcept {
    FxStartupWarmupRequirement result{};
    const auto* descriptor = findFxByOrdinal(ordinal);
    if (!descriptor || descriptor->readiness != FxReadiness::ProcessorAvailable ||
        !fxMemoryRequirement(ordinal, spec).supported) return result;

    const double sampleRate = static_cast<double>(spec.sampleRate);
    const auto ceilFrames = [sampleRate](double seconds, std::uint64_t& frames) noexcept {
        const double value = std::ceil(sampleRate * seconds);
        if (!std::isfinite(value) || value < 0.0 ||
            value > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) return false;
        frames = static_cast<std::uint64_t>(value);
        return true;
    };
    const auto roundedMilliseconds = [sampleRate](double milliseconds,
                                                   std::uint64_t& frames) noexcept {
        const double value = std::floor(sampleRate * milliseconds * 0.001 + 0.5);
        if (!std::isfinite(value) || value < 0.0 ||
            value > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) return false;
        frames = static_cast<std::uint64_t>(value);
        return true;
    };
    const auto roundedFrames = [sampleRate](double seconds, std::uint64_t& frames) noexcept {
        const double value = std::floor(sampleRate * seconds + 0.5);
        if (!std::isfinite(value) || value < 0.0 ||
            value > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) return false;
        frames = static_cast<std::uint64_t>(value);
        return true;
    };

    std::uint64_t frames = 0U;
    switch (ordinal) {
    case 6U: {
        // Synth pitch analysis uses a 2048-frame window plus a 512-frame hop.
        frames = 2048U + 512U;
        break;
    }
    case 10U: case 12U: case 19U: {
        // These paths use dual-mono incremental YIN and PSOLA. Their bounded
        // startup history is the observation window/hop plus three maximum
        // periods at the documented 65 Hz lower trackable F0.
        const auto maxPeriod = std::ceil(sampleRate / 65.0);
        if (!std::isfinite(maxPeriod) || maxPeriod < 1.0 ||
            maxPeriod > static_cast<double>(std::numeric_limits<std::uint32_t>::max() / 3U))
            return result;
        frames = 2048U + 512U + 3U * static_cast<std::uint64_t>(maxPeriod);
        break;
    }
    case 16U: case 17U: {
        // ROBOT/ELECTRIC incrementally distribute their bounded detector work
        // across callbacks; preserve the full worst-case callback cadence in
        // the preflight history bound, not only the 2048-frame window.
        constexpr std::uint64_t fftFrames = 4096U;
        constexpr std::uint64_t maximumLag = (192000U + 64U) / 65U;
        constexpr std::uint64_t maximumFftWork = (fftFrames / 2U) * 12U;
        constexpr std::uint64_t maximumWorkUnits = 2048U + 5U * fftFrames +
            2U * maximumFftWork + 3U * maximumLag;
        constexpr std::uint64_t workUnitsPerCallback = 4096U;
        constexpr std::uint64_t analysisCallbacks =
            (maximumWorkUnits + workUnitsPerCallback - 1U) / workUnitsPerCallback;
        const auto maxPeriod = std::ceil(sampleRate / 65.0);
        if (!std::isfinite(maxPeriod) || maxPeriod < 1.0 ||
            maxPeriod > static_cast<double>(std::numeric_limits<std::uint32_t>::max() / 3U))
            return result;
        frames = 2048U + (analysisCallbacks + 1U) * spec.maxBlockFrames +
                 3U * static_cast<std::uint64_t>(maxPeriod);
        break;
    }
    case 20U: case 21U: case 22U:
        // Vocoder filterbank and internal oscillator routes have no finite
        // input-history window; their group delay is reported separately.
        frames = 0U;
        break;
    case 5U: // Flanger: largest permitted base-plus-depth read and sinc guard.
        if (!ceilFrames(0.030, frames)) return result;
        frames += ModulatedDelayFx::kInterpolationTaps;
        break;
    case 7U: // LoFi sample-and-hold supports up to 64 frames.
        frames = 64U;
        break;
    case 24U: // Prime the selected 4x oversampling half-band state.
        frames = 22U;
        break;
    case 33U: // Vibrato maximum fractional-delay excursion.
        if (!ceilFrames(0.035, frames)) return result;
        frames += ModulatedDelayFx::kInterpolationTaps;
        break;
    case 37U: case 39U: // Panning / modulated delay maximum read plus sinc guard.
        if (!ceilFrames(2.0, frames)) return result;
        frames += ModulatedDelayFx::kInterpolationTaps;
        break;
    case 46U: // Chorus maximum fractional-delay excursion.
        if (!ceilFrames(0.120, frames)) return result;
        frames += ModulatedDelayFx::kInterpolationTaps;
        break;
    case 36U: // Lagrange delay's complete supported two-second read horizon.
        if (!ceilFrames(2.0, frames)) return result;
        frames += 4U;
        break;
    case 38U: { // ReverseSegment needs its default segment/history window.
        std::uint64_t segmentFrames = 0U;
        std::uint64_t crossfadeFrames = 0U;
        if (!roundedFrames(0.25, segmentFrames) ||
            !roundedFrames(0.01, crossfadeFrames)) return result;
        frames = 2U * segmentFrames - crossfadeFrames;
        break;
    }
    case 47U: case 48U: { // FDN finite early-delay ring; feedback decay is not settled.
        if (!ceilFrames(0.100, frames)) return result;
        frames += 2U; // FdnReverb allocates ceil(100 ms) + two guard samples.
        break;
    }
    case 49U: { // FDN early ring followed by the default ReverseSegment window.
        std::uint64_t reverseFrames = 0U;
        std::uint64_t segmentFrames = 0U;
        std::uint64_t crossfadeFrames = 0U;
        if (!ceilFrames(0.100, reverseFrames) ||
            !roundedFrames(0.25, segmentFrames) ||
            !roundedFrames(0.01, crossfadeFrames)) return result;
        frames = reverseFrames + 2U + 2U * segmentFrames - crossfadeFrames;
        break;
    }
    case 23U: {
        // The longest authored cabinet model is 19 ms (EightByTwelve),
        // generatedIrFrames() rounds that to ceil() and caps at fixed storage.
        // PREAMP's default partition and x4 shaper alignment are 64 + 22.
        // OffMic is the longest model placement: independently rounded 1.5 ms
        // direct delay plus 2 ms reflection extension, matching prepare().
        std::uint64_t irFrames = 0U;
        std::uint64_t micDirectFrames = 0U;
        std::uint64_t micReflectionExtraFrames = 0U;
        if (!ceilFrames(0.019, irFrames) ||
            !roundedMilliseconds(1.5, micDirectFrames) ||
            !roundedMilliseconds(2.0, micReflectionExtraFrames)) return result;
        irFrames = std::min<std::uint64_t>(irFrames,
            PreampModelFxProcessor::kMaximumModelIrFrames);
        frames = 64U + 22U + irFrames + micDirectFrames + micReflectionExtraFrames;
        break;
    }
    case 28U: frames = 4096U; break;
    case 40U: // Tape Echo max legal delay excursion, including wow depth.
        if (!ceilFrames(1.5 * (800.0 + 8.0) * 0.001, frames)) return result;
        break;
    case 41U: // Full prepared granular capture horizon.
    case 43U: // Full prepared Twist causal history.
        if (!ceilFrames(2.0, frames)) return result;
        break;
    case 42U: { // Freeze STFT window followed by the FDN finite early-delay ring.
        if (!ceilFrames(0.100, frames)) return result;
        frames += 2U + 1024U;
        break;
    }
    case 45U: frames = 1024U; break;
    case 44U: // Roll's prepared repeat window is capped at two seconds.
        if (!ceilFrames(2.0, frames)) return result;
        break;
    case 50U: // Oldest legal negative-pitch scatter tap can reach the ring's full past horizon.
        if (!ceilFrames(4.0, frames)) return result;
        // PerformanceFxProcessor allocates 4 s + maxBlockFrames + 16 guard
        // frames. Scatter reserves the entire output-time/read-head trajectory
        // plus interpolation support, so the maximum legal warmup is H - 2.
        frames += spec.maxBlockFrames + 14U;
        break;
    case 51U: // 20 BPM x 1/2 beat repeat window, plus interpolation support.
        if (!ceilFrames(1.5, frames)) return result;
        frames += 2U;
        break;
    case 52U:
        // At 20 BPM, +2 beats is 6 seconds; the 5 ms base delay and
        // four-tap history interpolation are additional finite lookback.
        if (!ceilFrames(6.005, frames)) return result;
        frames += 4U;
        break;
    case 53U: // Slowest VinylFlick trajectory can reach the retained 4 s history edge.
        if (!ceilFrames(4.0, frames)) return result;
        frames += spec.maxBlockFrames + 12U;
        break;
    default:
        // Recursive filters, compressors, and other pointwise processors have
        // no finite input-history window. Zero is not an IIR/reverb settling
        // claim; that state policy remains separately unqualified.
        frames = 0U;
        break;
    }
    if (frames > std::numeric_limits<std::uint32_t>::max()) return result;
    result.frames = static_cast<std::uint32_t>(frames);
    result.supported = true;
    return result;
}

FxAlignmentRequirement fxAlignmentUpperBoundSamples(
    std::uint16_t ordinal, const ProcessSpec& spec) noexcept {
    FxAlignmentRequirement result{};
    const auto* descriptor = findFxByOrdinal(ordinal);
    if (!descriptor || descriptor->readiness != FxReadiness::ProcessorAvailable ||
        !fxMemoryRequirement(ordinal, spec).supported) return result;

    switch (ordinal) {
    case 6U: case 10U: case 12U: case 16U: case 17U: case 19U:
    case 20U: case 21U: case 22U:
        // Musical pitch routes either have a variable wet/dry time alignment
        // or no whole-sample fixed buffering. The processor getter reports
        // its prepared fixed/variable latency; all have a zero static buffer
        // reservation for that alignment anchor.
        result.frames = 0U;
        break;
    case 24U:
        // The registered distortion insert uses the x4 half-band shaper's
        // integer dry-path alignment anchor; frequency-dependent phase is
        // reported independently by the processor.
        result.frames = 22U;
        break;
    case 23U:
        // The registered PREAMP model uses a 64-frame convolver partition and
        // the x4 shaper's 22-frame integer dry anchor.
        result.frames = 86U;
        break;
    case 28U:
        // OCTAVE's prepared v1 selector aligns all three branches to 2*N,
        // with N=2048 frames in the registered profile.
        result.frames = 4096U;
        break;
    case 42U: case 45U:
        // Registered Warp and Freeze adapters prepare a 1024-frame STFT.
        result.frames = 1024U;
        break;
    case 53U: {
        const double samples = std::ceil(static_cast<double>(spec.sampleRate) * 0.020);
        if (!std::isfinite(samples) || samples < 0.0 ||
            samples > static_cast<double>(std::numeric_limits<std::uint32_t>::max()))
            return result;
        result.frames = static_cast<std::uint32_t>(samples);
        break;
    }
    default:
        // All other registered processors either have variable wet latency or
        // report a zero-sample fixed alignment path.
        result.frames = 0U;
        break;
    }
    result.supported = true;
    return result;
}

const FxDescriptor* fxCatalogData() noexcept { return kCatalog.data(); }
std::size_t fxCatalogSize() noexcept { return kCatalog.size(); }

const FxDescriptor* findFxByOrdinal(std::uint16_t ordinal) noexcept {
    if (ordinal == 0U || ordinal > kCatalog.size()) return nullptr;
    const auto& result = kCatalog[ordinal - 1U];
    return result.ordinal == ordinal ? &result : nullptr;
}

const FxDescriptor* findFxById(std::string_view id) noexcept {
    const auto found = std::find_if(kCatalog.begin(), kCatalog.end(),
                                    [id](const FxDescriptor& descriptor) { return descriptor.id == id; });
    return found == kCatalog.end() ? nullptr : &*found;
}

const FxParameterDescriptor* fxParameterDescriptors(std::uint16_t ordinal,
                                                     std::size_t& count) noexcept {
    count = 0;
    switch (ordinal) {
    case 1U: case 2U: case 3U:
        count = kFilterParameters.size(); return kFilterParameters.data();
    case 4U:
        count = kPhaserParameters.size(); return kPhaserParameters.data();
    case 25U:
        count = kDynamicsParameters.size(); return kDynamicsParameters.data();
    case 26U:
        count = kEqParameters.size(); return kEqParameters.data();
    case 36U:
        count = kDelayParameters.size(); return kDelayParameters.data();
    case 47U:
        count = kReverbParameters.size(); return kReverbParameters.data();
    case 5U:
        count = kFlangerParameters.size(); return kFlangerParameters.data();
    case 33U:
        count = kVibratoParameters.size(); return kVibratoParameters.data();
    case 39U:
        count = kModDelayParameters.size(); return kModDelayParameters.data();
    case 46U:
        count = kChorusParameters.size(); return kChorusParameters.data();
    case 37U:
        count = kPanningDelayParameters.size(); return kPanningDelayParameters.data();
    case 8U:
        count = kRadioParameters.size(); return kRadioParameters.data();
    case 11U:
        count = kSustainerParameters.size(); return kSustainerParameters.data();
    case 13U:
        count = kSlowGearParameters.size(); return kSlowGearParameters.data();
    case 31U:
        count = kStereoEnhanceParameters.size(); return kStereoEnhanceParameters.data();
    case 27U:
        count = kIsolatorParameters.size(); return kIsolatorParameters.data();
    case 34U:
        count = kRhythmicSlicerParameters.size(); return kRhythmicSlicerParameters.data();
    case 35U:
        count = kStepSlicerParameters.size(); return kStepSlicerParameters.data();
    case 38U:
        count = kReverseDelayParameters.size(); return kReverseDelayParameters.data();
    case 48U:
        count = kGateReverbParameters.size(); return kGateReverbParameters.data();
    case 49U:
        count = kReverseReverbParameters.size(); return kReverseReverbParameters.data();
    case 50U:
        count = kBeatScatterParameters.size(); return kBeatScatterParameters.data();
    case 51U:
        count = kBeatRepeatParameters.size(); return kBeatRepeatParameters.data();
    case 52U:
        count = kBeatShiftParameters.size(); return kBeatShiftParameters.data();
    case 53U:
        count = kVinylFlickParameters.size(); return kVinylFlickParameters.data();
    case 7U:
        count = kLoFiParameters.size(); return kLoFiParameters.data();
    case 9U:
        count = kRingModParameters.size(); return kRingModParameters.data();
    case 29U:
        count = kAutoPanParameters.size(); return kAutoPanParameters.data();
    case 30U:
        count = kManualPanParameters.size(); return kManualPanParameters.data();
    case 32U:
        count = kTremoloParameters.size(); return kTremoloParameters.data();
    case 23U:
        count = kPreampModelParameters.size(); return kPreampModelParameters.data();
    case 24U:
        count = kDistortionParameters.size(); return kDistortionParameters.data();
    case 28U:
        count = kOctaveParameters.size(); return kOctaveParameters.data();
    case 6U:
        count = kSynthParameters.size(); return kSynthParameters.data();
    case 10U:
        count = kGuitarToBassParameters.size(); return kGuitarToBassParameters.data();
    case 12U:
        count = kAutoRiffParameters.size(); return kAutoRiffParameters.data();
    case 16U:
        count = kRobotParameters.size(); return kRobotParameters.data();
    case 17U:
        count = kElectricParameters.size(); return kElectricParameters.data();
    case 19U:
        count = kHarmonyAutoParameters.size(); return kHarmonyAutoParameters.data();
    case 20U:
        count = kVocoderRuntimeParameters.size(); return kVocoderRuntimeParameters.data();
    case 21U:
        count = kOscVocRuntimeParameters.size(); return kOscVocRuntimeParameters.data();
    case 22U:
        count = kOscBotRuntimeParameters.size(); return kOscBotRuntimeParameters.data();
    case 40U:
        count = kTapeEchoParameters.size(); return kTapeEchoParameters.data();
    case 41U:
        count = kGranularDelayParameters.size(); return kGranularDelayParameters.data();
    case 42U:
        count = kWarpParameters.size(); return kWarpParameters.data();
    case 43U:
        count = kTwistParameters.size(); return kTwistParameters.data();
    case 44U:
        count = kRollParameters.size(); return kRollParameters.data();
    case 45U:
        count = kFreezeParameters.size(); return kFreezeParameters.data();
    default: return nullptr;
    }
}

bool FxProcessor::processBlockWithEvents(const float* const* input,
                                         float* const* output,
                                         std::uint32_t channels,
                                         std::uint32_t frames,
                                         const FxParameterEvent* events,
                                         std::uint32_t eventCount) noexcept {
    if (!validateBlockRequest(channels, frames) || eventCount > kFxEventCapacity ||
        eventCount > maximumParameterEventsPerBlock() || !canAcceptParameterEvents(eventCount) ||
        (eventCount > 0U && (!events || frames == 0U)) ||
        (frames > 0U && (!input || !output))) return false;
    for (std::uint32_t channel = 0; channel < channels && frames > 0U; ++channel) {
        if (!input[channel] || !output[channel]) return false;
    }
    if (eventCount == 0U) return processBlock(input, output, channels, frames);
    std::uint32_t previousOffset = 0;
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        const auto& event = events[i];
        if (event.frameOffset > frames || (i > 0U && event.frameOffset < previousOffset)) return false;
        previousOffset = event.frameOffset;
    }
    if (!validateParameterEvents(events, eventCount)) return false;
    std::uint32_t cursor = 0;
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        const auto& event = events[i];
        const auto segment = event.frameOffset - cursor;
        if (segment > 0U) {
            const float* inOffset[2]{};
            float* outOffset[2]{};
            for (std::uint32_t channel = 0; channel < channels && channel < 2U; ++channel) {
                inOffset[channel] = input[channel] + cursor;
                outOffset[channel] = output[channel] + cursor;
            }
            if (!processBlock(inOffset, outOffset, channels, segment)) return false;
        }
        if (!setParameter(event.parameter, event.value)) return false;
        cursor = event.frameOffset;
    }
    if (cursor < frames) {
        const float* inOffset[2]{};
        float* outOffset[2]{};
        for (std::uint32_t channel = 0; channel < channels && channel < 2U; ++channel) {
            inOffset[channel] = input[channel] + cursor;
            outOffset[channel] = output[channel] + cursor;
        }
        if (!processBlock(inOffset, outOffset, channels, frames - cursor)) return false;
    }
    return true;
}

bool FxProcessor::processBlockWithContext(
    const float* const* input, float* const* output,
    std::uint32_t channels, std::uint32_t frames,
    const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount,
    const FxProcessContext& context) noexcept {
    const bool hasCarrier = context.carrierLeft != nullptr || context.carrierRight != nullptr ||
                            context.carrierFrames != 0U || context.carrierChannels != 0U;
    const bool hasMidi = context.midiEvents != nullptr || context.midiEventCount != 0U;
    if (hasCarrier || hasMidi) return false;
    return processBlockWithEvents(input, output, channels, frames,
                                  parameterEvents, parameterEventCount);
}

std::unique_ptr<FxProcessor> createFxProcessor(std::uint16_t ordinal) noexcept {
    const auto* descriptor = findFxByOrdinal(ordinal);
    if (!descriptor || descriptor->readiness != FxReadiness::ProcessorAvailable) return nullptr;
    if (ordinal <= 3U) return std::unique_ptr<FxProcessor>(new (std::nothrow) TptFilterProcessor(ordinal));
    if (ordinal == 4U) return std::unique_ptr<FxProcessor>(new (std::nothrow) PhaserProcessor());
    if (ordinal == 25U) return std::unique_ptr<FxProcessor>(new (std::nothrow) DynamicsProcessor());
    if (ordinal == 26U) return std::unique_ptr<FxProcessor>(new (std::nothrow) EqProcessor());
    if (ordinal == 36U) return std::unique_ptr<FxProcessor>(new (std::nothrow) DelayProcessor());
    if (ordinal == 47U) return std::unique_ptr<FxProcessor>(new (std::nothrow) ReverbProcessor());
    if (ordinal == 6U || ordinal == 10U || ordinal == 12U || ordinal == 16U ||
        ordinal == 17U || ordinal == 19U || ordinal == 20U || ordinal == 21U || ordinal == 22U)
        return std::unique_ptr<FxProcessor>(new (std::nothrow) MusicalFxRegistryBridge(ordinal));
    if (ordinal >= 50U && ordinal <= 53U)
        return std::unique_ptr<FxProcessor>(new (std::nothrow) PerformanceFxAdapter(ordinal));
    if (ordinal == 7U || ordinal == 9U || ordinal == 29U || ordinal == 30U || ordinal == 32U)
        return std::unique_ptr<FxProcessor>(new (std::nothrow) ModulationFxAdapter(ordinal));
    if (ordinal == 5U || ordinal == 8U || ordinal == 11U || ordinal == 13U ||
        ordinal == 27U || ordinal == 31U || ordinal == 33U || ordinal == 34U ||
        ordinal == 35U || ordinal == 37U || ordinal == 38U || ordinal == 39U ||
        ordinal == 46U || ordinal == 48U || ordinal == 49U || ordinal == 23U ||
        ordinal == 24U || ordinal == 28U ||
        (ordinal >= 40U && ordinal <= 45U))
        return std::unique_ptr<FxProcessor>(new (std::nothrow) AdditionalFxAdapter(ordinal));
    return nullptr;
}

} // namespace webrc::dsp
