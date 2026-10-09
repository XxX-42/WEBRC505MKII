#include "webrc/dsp/fx_registry.hpp"

#include "webrc/dsp/spatial_temporal.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <new>
#include <utility>

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
    {5,"rc505mkii.fx.flanger","FLANGER","Modulated delay",true,true,kMetadata,false},
    {6,"rc505mkii.fx.synth","SYNTH","Pitch/synthesis",true,true,kMetadata,false},
    {7,"rc505mkii.fx.lo-fi","LO-FI","Lo-fi",true,true,kMetadata,false},
    {8,"rc505mkii.fx.radio","RADIO","Lo-fi",true,true,kMetadata,false},
    {9,"rc505mkii.fx.ring-mod","RING.MOD","Modulation",true,true,kMetadata,false},
    {10,"rc505mkii.fx.g2b","G2B","Pitch",true,true,kMetadata,false},
    {11,"rc505mkii.fx.sustainer","SUSTAINER","Dynamics",true,true,kMetadata,false},
    {12,"rc505mkii.fx.auto-riff","AUTO RIFF","Pitch/sequencer",true,true,kMetadata,false},
    {13,"rc505mkii.fx.slow-gear","SLOW GEAR","Envelope",true,true,kMetadata,false},
    {14,"rc505mkii.fx.transpose","TRANSPOSE","Pitch",true,true,kMetadata,false},
    {15,"rc505mkii.fx.pitch-bend","PITCH BEND","Pitch",true,true,kMetadata,false},
    {16,"rc505mkii.fx.robot","ROBOT","Voice",true,true,kMetadata,false},
    {17,"rc505mkii.fx.electric","ELECTRIC","Voice character",true,true,kMetadata,false},
    {18,"rc505mkii.fx.hrm-manual","HRM MANUAL","Harmony",true,true,kMetadata,false},
    {19,"rc505mkii.fx.hrm-auto-m","HRM AUTO (M)","Harmony/MIDI",true,true,kMetadata,false},
    {20,"rc505mkii.fx.vocoder","VOCODER","Vocoder",true,true,kMetadata,false},
    {21,"rc505mkii.fx.osc-voc-m","OSC VOC (M)","Vocoder/MIDI",true,true,kMetadata,false},
    {22,"rc505mkii.fx.osc-bot","OSC BOT","Voice/synthesis",true,true,kMetadata,false},
    {23,"rc505mkii.fx.preamp","PREAMP","Amp simulation",true,true,kMetadata,false},
    {24,"rc505mkii.fx.dist","DIST","Nonlinear",true,true,kMetadata,false},
    {25,"rc505mkii.fx.dynamics","DYNAMICS","Dynamics",true,true,kProcessorReady,false},
    {26,"rc505mkii.fx.eq","EQ","EQ",true,true,kProcessorReady,false},
    {27,"rc505mkii.fx.isolator","ISOLATOR","Multiband/gate",true,true,kMetadata,false},
    {28,"rc505mkii.fx.octave","OCTAVE","Pitch",true,true,kMetadata,false},
    {29,"rc505mkii.fx.auto-pan","AUTO PAN","Pan modulation",true,true,kMetadata,false},
    {30,"rc505mkii.fx.manual-pan","MANUAL PAN","Pan",true,true,kMetadata,false},
    {31,"rc505mkii.fx.stereo-enhance","STEREO ENHANCE","Stereo",true,true,kMetadata,false},
    {32,"rc505mkii.fx.tremolo","TREMOLO","Amplitude modulation",true,true,kMetadata,false},
    {33,"rc505mkii.fx.vibrato","VIBRATO","Modulated delay",true,true,kMetadata,false},
    {34,"rc505mkii.fx.pattern-slicer","PATTERN SLICER","Rhythmic gate",true,true,kMetadata,false},
    {35,"rc505mkii.fx.step-slicer","STEP SLICER","Rhythmic gate",true,true,kMetadata,false},
    {36,"rc505mkii.fx.delay","DELAY","Delay",true,true,kProcessorReady,false},
    {37,"rc505mkii.fx.panning-delay","PANNING DELAY","Stereo delay",true,true,kMetadata,false},
    {38,"rc505mkii.fx.reverse-delay","REVERSE DELAY","Reverse delay",true,true,kMetadata,false},
    {39,"rc505mkii.fx.mod-delay","MOD DELAY","Modulated delay",true,true,kMetadata,false},
    {40,"rc505mkii.fx.tape-echo","TAPE ECHO","Tape delay",true,true,kMetadata,false},
    {41,"rc505mkii.fx.granular-delay","GRANULAR DELAY","Granular",true,true,kMetadata,false},
    {42,"rc505mkii.fx.warp","WARP","Granular/freeze macro",true,true,kMetadata,false},
    {43,"rc505mkii.fx.twist","TWIST","Performance macro",true,true,kMetadata,false},
    {44,"rc505mkii.fx.roll","ROLL","Beat repeat",true,true,kMetadata,false},
    {45,"rc505mkii.fx.freeze","FREEZE","Freeze",true,true,kMetadata,false},
    {46,"rc505mkii.fx.chorus","CHORUS","Modulated delay",true,true,kMetadata,false},
    {47,"rc505mkii.fx.reverb","REVERB","Reverb",true,true,kProcessorReady,false},
    {48,"rc505mkii.fx.gate-reverb","GATE REVERB","Reverb/gate",true,true,kMetadata,false},
    {49,"rc505mkii.fx.reverse-reverb","REVERSE REVERB","Reverse reverb",true,true,kMetadata,false},
    {50,"rc505mkii.fx.beat-scatter","BEAT SCATTER","Track-only beat FX",false,true,kMetadata,false},
    {51,"rc505mkii.fx.beat-repeat","BEAT REPEAT","Track-only beat FX",false,true,kMetadata,false},
    {52,"rc505mkii.fx.beat-shift","BEAT SHIFT","Track-only beat FX",false,true,kMetadata,false},
    {53,"rc505mkii.fx.vinyl-flick","VINYL FLICK","Track-only transport FX",false,true,kMetadata,false},
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
    {FxParameterId::EqLowSlope,"lowShelfSlope","slope",0.1f,4.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqLowMidFrequencyHz,"lowMidFrequencyHz","Hz",40.0f,8000.0f,500.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqLowMidGainDb,"lowMidGainDb","dB",-18.0f,18.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqLowMidQ,"lowMidQ","Q",0.1f,20.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighMidFrequencyHz,"highMidFrequencyHz","Hz",100.0f,16000.0f,3000.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighMidGainDb,"highMidGainDb","dB",-18.0f,18.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighMidQ,"highMidQ","Q",0.1f,20.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighFrequencyHz,"highShelfFrequencyHz","Hz",1000.0f,20000.0f,8000.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighGainDb,"highShelfGainDb","dB",-18.0f,18.0f,0.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::EqHighSlope,"highShelfSlope","slope",0.1f,4.0f,1.0f,FxParameterOrigin::ReconstructionSafeBounds},
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
    {FxParameterId::DampingHz,"dampingHz","Hz",50.0f,18000.0f,7000.0f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationRateHz,"modulationRateHz","Hz",0.0f,8.0f,0.25f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::ModulationDepthMs,"modulationDepthMs","ms",0.0f,5.0f,0.8f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::MaximumFeedback,"maximumFeedback","linear",0.0f,0.9995f,0.98f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::Wet,"wet","linear",0.0f,1.0f,0.35f,FxParameterOrigin::ReconstructionSafeBounds},
    {FxParameterId::SmoothingMs,"smoothingMs","ms",0.0f,100.0f,20.0f,FxParameterOrigin::ReconstructionSafeBounds},
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
        case FxParameterId::EqLowSlope: case FxParameterId::EqHighSlope: return value >= 0.1f && value <= 4.0f;
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
        try {
            for (auto& delay : candidate) if (!delay.prepare(spec, maxDelay)) return false;
        } catch (...) {
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
        try {
            FdnReverb candidate;
            if (!candidate.prepare(spec, FdnLineCount::Eight, 0.12f) ||
                !candidate.setParameters(rt60_, dampingHz_, modRateHz_, modDepthMs_, maximumFeedback_, wet_, smoothingMs_))
                return false;
            reverb_ = std::move(candidate);
            spec_ = spec;
            prepared_ = true;
            return true;
        } catch (...) {
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
    bool latencyIsFrequencyDependent() const noexcept override { return true; }
private:
    ProcessSpec spec_{};
    FdnReverb reverb_{};
    float rt60_=1.8f, dampingHz_=7000.0f, modRateHz_=0.25f, modDepthMs_=0.8f;
    float maximumFeedback_=0.98f, wet_=0.35f, smoothingMs_=20.0f;
    bool prepared_=false;
};

} // namespace

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
        (eventCount > 0U && (!events || frames == 0U)) ||
        (frames > 0U && (!input || !output))) return false;
    for (std::uint32_t channel = 0; channel < channels && frames > 0U; ++channel) {
        if (!input[channel] || !output[channel]) return false;
    }
    if (eventCount == 0U) return processBlock(input, output, channels, frames);
    std::uint32_t previousOffset = 0;
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        const auto& event = events[i];
        if (event.frameOffset > frames || (i > 0U && event.frameOffset < previousOffset) ||
            !validParameter(event.parameter, event.value)) return false;
        previousOffset = event.frameOffset;
    }
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

std::unique_ptr<FxProcessor> createFxProcessor(std::uint16_t ordinal) noexcept {
    const auto* descriptor = findFxByOrdinal(ordinal);
    if (!descriptor || descriptor->readiness != FxReadiness::ProcessorAvailable) return nullptr;
    if (ordinal <= 3U) return std::unique_ptr<FxProcessor>(new (std::nothrow) TptFilterProcessor(ordinal));
    if (ordinal == 4U) return std::unique_ptr<FxProcessor>(new (std::nothrow) PhaserProcessor());
    if (ordinal == 25U) return std::unique_ptr<FxProcessor>(new (std::nothrow) DynamicsProcessor());
    if (ordinal == 26U) return std::unique_ptr<FxProcessor>(new (std::nothrow) EqProcessor());
    if (ordinal == 36U) return std::unique_ptr<FxProcessor>(new (std::nothrow) DelayProcessor());
    if (ordinal == 47U) return std::unique_ptr<FxProcessor>(new (std::nothrow) ReverbProcessor());
    return nullptr;
}

} // namespace webrc::dsp
