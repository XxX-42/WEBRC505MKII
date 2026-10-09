#include "webrc/dsp/control_dynamics.hpp"
#include "webrc/dsp/fft.hpp"
#include "webrc/dsp/nonlinear.hpp"
#include "webrc/dsp/pitch.hpp"
#include "webrc/dsp/primitives.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <locale>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace {
using namespace webrc::dsp;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr float kSampleRate = 48000.0f;
constexpr std::uint32_t kFrames = 15360;
constexpr std::uint32_t kMaxBlock = 512;

struct Profile {
    std::string id;
    std::vector<std::uint32_t> blocks;
};
struct Event {
    std::uint32_t frame = 0;
    std::uint32_t control = 0;
    std::vector<float> values;
};
struct Ref {
    std::string path;
    std::uint32_t frames = 0;
    std::uint32_t channels = 0;
    std::string encoding = "float32-le-interleaved";
    std::uint32_t fftFrames = 0;
};
struct Fixture {
    std::string json;
};

std::uint32_t lcg(std::uint32_t& s) noexcept {
    s = s * 1664525U + 1013904223U;
    return s;
}
float noise(std::uint32_t& s) noexcept {
    const std::int32_t value = static_cast<std::int32_t>(lcg(s) >> 8U) - 0x7fffff;
    return static_cast<float>(value) / 8388608.0f;
}

std::vector<float> makeSignal(std::uint32_t channel, double fundamental = 220.37) {
    std::vector<float> result(kFrames, 0.0f);
    std::uint32_t random = 0x62f31a9dU ^ (channel * 0x9e3779b9U);
    const double second = channel == 0U ? 659.11 : 493.27;
    for (std::uint32_t i = 0; i < kFrames; ++i) {
        double env = 0.0;
        if (i >= 512U && i < 1024U) {
            const double t = static_cast<double>(i - 511U) / 512.0;
            env = 0.5 * (1.0 - std::cos(kPi * t));
        } else if (i >= 1024U && i < 13312U) {
            env = 1.0;
        } else if (i >= 13312U && i < 13824U) {
            const double t = static_cast<double>(i - 13311U) / 512.0;
            env = 0.5 * (1.0 + std::cos(kPi * t));
        }
        if (env == 0.0) continue;
        const double a = 2.0 * kPi * fundamental * i / kSampleRate;
        const double b = 2.0 * kPi * second * i / kSampleRate;
        double sample = 0.34 * std::sin(a) + 0.11 * std::sin(b);
        sample += 0.0007 * noise(random);
        if (i == 4096U) sample += 0.22;
        result[i] = static_cast<float>(sample * env);
    }
    return result;
}

std::vector<float> interleave(const std::vector<float>& left,
                              const std::vector<float>& right) {
    std::vector<float> result;
    result.reserve(left.size() * 2U);
    for (std::size_t i = 0; i < left.size(); ++i) {
        result.push_back(left[i]);
        result.push_back(right[i]);
    }
    return result;
}

bool writeFloat32(const std::filesystem::path& path, const std::vector<float>& values) {
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    for (float value : values) {
        if (!std::isfinite(value)) return false;
        std::uint32_t bits = 0;
        std::memcpy(&bits, &value, sizeof(bits));
        const char bytes[] = {static_cast<char>(bits), static_cast<char>(bits >> 8U),
                              static_cast<char>(bits >> 16U), static_cast<char>(bits >> 24U)};
        out.write(bytes, 4);
    }
    return static_cast<bool>(out);
}

bool writeComplex32(const std::filesystem::path& path,
                    const std::vector<std::complex<float>>& values) {
    std::vector<float> interleavedValues;
    interleavedValues.reserve(values.size() * 2U);
    for (const auto value : values) {
        interleavedValues.push_back(value.real());
        interleavedValues.push_back(value.imag());
    }
    return writeFloat32(path, interleavedValues);
}

std::string jsonString(const std::string& value) {
    std::ostringstream out;
    out << '"';
    for (const char c : value) {
        if (c == '"' || c == '\\') out << '\\' << c;
        else if (static_cast<unsigned char>(c) < 0x20U) out << ' ';
        else out << c;
    }
    out << '"';
    return out.str();
}

void writeUIntArray(std::ostream& out, const std::vector<std::uint32_t>& values) {
    out << '[';
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i) out << ',';
        out << values[i];
    }
    out << ']';
}

void writeFloatArray(std::ostream& out, const std::vector<float>& values) {
    out << '[' << std::setprecision(9);
    for (std::size_t i = 0; i < values.size(); ++i) {
        if (i) out << ',';
        out << values[i];
    }
    out << ']';
}

std::string refJson(const Ref& ref) {
    std::ostringstream out;
    out << "{\"path\":" << jsonString(ref.path) << ",\"frames\":" << ref.frames
        << ",\"channels\":" << ref.channels << ",\"encoding\":"
        << jsonString(ref.encoding);
    if (ref.fftFrames) out << ",\"fftFrames\":" << ref.fftFrames;
    out << '}';
    return out.str();
}

std::string eventsJson(const std::vector<Event>& events) {
    std::ostringstream out;
    out << '[';
    for (std::size_t i = 0; i < events.size(); ++i) {
        if (i) out << ',';
        out << "{\"frameOffset\":" << events[i].frame << ",\"controlId\":"
            << events[i].control << ",\"values\":";
        writeFloatArray(out, events[i].values);
        out << '}';
    }
    out << ']';
    return out.str();
}

std::string setupJson(const std::vector<std::pair<std::string, Ref>>& payloads) {
    std::ostringstream out;
    out << '[';
    for (std::size_t i = 0; i < payloads.size(); ++i) {
        if (i) out << ',';
        out << "{\"role\":" << jsonString(payloads[i].first) << ",\"pcm\":"
            << refJson(payloads[i].second) << '}';
    }
    out << ']';
    return out.str();
}

std::vector<Profile> profiles() {
    std::vector<Profile> result;
    for (const auto frames : {64U, 128U, 256U, 512U}) {
        Profile p{};
        p.id = "uniform_" + std::to_string(frames);
        for (std::uint32_t offset = 0; offset < kFrames; offset += frames)
            p.blocks.push_back(frames);
        result.push_back(std::move(p));
    }
    Profile mixed{};
    mixed.id = "mixed_64_128_256_512";
    constexpr std::array<std::uint32_t, 4> schedule{64U,128U,256U,512U};
    std::uint32_t sum = 0;
    for (std::size_t i = 0; sum < kFrames; ++i) {
        const auto n = schedule[i % schedule.size()];
        if (sum + n > kFrames) return {};
        mixed.blocks.push_back(n);
        sum += n;
    }
    result.push_back(std::move(mixed));
    return result;
}

std::string partitionsJson(const Profile& profile) {
    std::ostringstream out;
    out << "{\"profileId\":" << jsonString(profile.id) << ",\"callbackFrames\":";
    writeUIntArray(out, profile.blocks);
    out << '}';
    return out.str();
}

struct BaseSpec {
    std::string module;
    std::string operation;
    std::string fixtureKey;
    std::string controlVariant;
    std::uint32_t kind = 0;
    std::uint32_t channels = 1;
    std::uint32_t outputChannels = 1;
    std::string settings;
    std::vector<Event> events;
    std::vector<std::pair<std::string, Ref>> setups;
    Ref input{};
    Ref output{};
    bool hasInput = true;
};

enum class BaseOp { Smoother, Biquad, Svf, AllPass, Delay, Lfo, Oscillator,
                    Adaa, Compressor, Matrix, Pcg };

bool applyBaseEvent(BaseOp op, const Event& e, BiquadDf2T& biquad,
                    TptStateVariableFilter& svf, AllPass1& allpass,
                    ParameterSmoother& smoother, Lfo& lfo,
                    PolyBlepOscillator& osc, AdaaCubicShaper& adaa,
                    DualDetectorCompressor& compressor, DelayMatrix2& matrix,
                    const std::string& biquadType) {
    const auto* v = e.values.data();
    switch (op) {
    case BaseOp::Smoother: return e.control == 1U && smoother.setTarget(v[0], v[1]);
    case BaseOp::Biquad:
        if (biquadType == "lowpass") return e.control == 2U && biquad.setLowpass(v[0], v[1], v[2]);
        if (biquadType == "highpass") return e.control == 3U && biquad.setHighpass(v[0], v[1], v[2]);
        if (biquadType == "peaking") return e.control == 5U && biquad.setPeaking(v[0],v[1],v[2],v[3]);
        if (biquadType == "lowShelf") return e.control == 14U && biquad.setLowShelf(v[0],v[1],v[2],v[3]);
        if (biquadType == "highShelf") return e.control == 15U && biquad.setHighShelf(v[0],v[1],v[2],v[3]);
        return false;
    case BaseOp::Svf: return e.control == 6U && svf.setFrequencyQ(v[0],v[1],v[2]);
    case BaseOp::AllPass: return e.control == 7U && allpass.setFrequency(v[0],v[1]);
    case BaseOp::Delay: return true; // per-sample delay trajectory is a sidecar, not a control event.
    case BaseOp::Lfo: return e.control == 8U && lfo.setFrequency(v[0]);
    case BaseOp::Oscillator:
        if (e.control == 9U) return osc.setFrequency(v[0]);
        if (e.control == 10U && v[0] >= 0.0f && v[0] <= 3.0f)
            { osc.setWaveform(static_cast<OscillatorWaveform>(static_cast<std::uint8_t>(v[0]))); return true; }
        return false;
    case BaseOp::Adaa: return e.control == 11U && adaa.setDrive(v[0]);
    case BaseOp::Compressor:
        return e.control == 12U && compressor.setParameters(v[0],v[1],v[2],v[3],v[4],v[5],v[6]);
    case BaseOp::Matrix: return e.control == 13U && matrix.setFeedback(v[0],v[1]);
    case BaseOp::Pcg: return false;
    }
    return false;
}

bool renderBase(BaseOp op, const BaseSpec& config, const Profile& profile,
                const std::vector<float>& mono, const std::vector<float>& stereo,
                const std::vector<float>& delaySamples,
                const std::vector<float>& matrixLeft, const std::vector<float>& matrixRight,
                std::uint64_t pcgState, std::uint64_t pcgSequence,
                std::vector<float>& output) {
    const ProcessSpec spec{kSampleRate, kMaxBlock, config.channels};
    ParameterSmoother smoother;
    BiquadDf2T biquad;
    TptStateVariableFilter svf;
    AllPass1 allpass;
    LagrangeDelay delay;
    Lfo lfo;
    PolyBlepOscillator osc;
    AdaaCubicShaper adaa;
    DualDetectorCompressor compressor;
    DelayMatrix2 matrix;
    Pcg32 pcg;
    switch (op) {
    case BaseOp::Smoother: if (!smoother.prepare(spec)) return false; smoother.reset(-0.25f); break;
    case BaseOp::Biquad: if (!biquad.prepare(spec)) return false; break;
    case BaseOp::Svf: if (!svf.prepare(spec)) return false; break;
    case BaseOp::AllPass: if (!allpass.prepare(spec)) return false; break;
    case BaseOp::Delay: if (!delay.prepare(spec, 2048U)) return false; break;
    case BaseOp::Lfo: if (!lfo.prepare(spec)) return false; break;
    case BaseOp::Oscillator: if (!osc.prepare(spec)) return false; break;
    case BaseOp::Adaa: if (!adaa.prepare(spec)) return false; break;
    case BaseOp::Compressor: if (!compressor.prepare(spec)) return false; break;
    case BaseOp::Matrix: matrix.reset(); break;
    case BaseOp::Pcg: pcg.seed(pcgState, pcgSequence); break;
    }
    if (op == BaseOp::Oscillator) osc.reset(0.13f);
    if (op == BaseOp::Lfo) lfo.reset(0.21f);

    output.assign(static_cast<std::size_t>(kFrames) * config.outputChannels, 0.0f);
    std::vector<float> low(kMaxBlock), band(kMaxBlock), high(kMaxBlock);
    std::vector<float> inL(kMaxBlock), inR(kMaxBlock), outL(kMaxBlock), outR(kMaxBlock);
    std::uint32_t eventIndex = 0U;
    std::uint32_t frameOffset = 0U;
    for (const auto callbackFrames : profile.blocks) {
        std::uint32_t callbackOffset = 0U;
        while (callbackOffset < callbackFrames) {
            while (eventIndex < config.events.size() &&
                   config.events[eventIndex].frame == frameOffset + callbackOffset) {
                if (!applyBaseEvent(op, config.events[eventIndex], biquad, svf, allpass,
                                    smoother, lfo, osc, adaa, compressor, matrix,
                                    config.controlVariant)) return false;
                ++eventIndex;
            }
            std::uint32_t segment = callbackFrames - callbackOffset;
            if (eventIndex < config.events.size()) {
                const auto eventFrame = config.events[eventIndex].frame;
                if (eventFrame < frameOffset + callbackOffset) return false;
                segment = std::min(segment, eventFrame - frameOffset - callbackOffset);
                if (segment == 0U) continue;
            }
            const auto offset = frameOffset + callbackOffset;
            switch (op) {
            case BaseOp::Smoother:
                if (!smoother.processBlock(output.data() + offset, segment)) return false;
                break;
            case BaseOp::Biquad:
                if (!biquad.processBlock(mono.data() + offset, output.data() + offset, segment)) return false;
                break;
            case BaseOp::Svf:
                if (!svf.processBlock(mono.data() + offset, low.data(), band.data(), high.data(), segment)) return false;
                for (std::uint32_t i = 0; i < segment; ++i) {
                    const auto dest = static_cast<std::size_t>(offset + i) * 3U;
                    output[dest] = low[i]; output[dest + 1U] = band[i]; output[dest + 2U] = high[i];
                }
                break;
            case BaseOp::AllPass:
                if (!allpass.processBlock(mono.data() + offset, output.data() + offset, segment)) return false;
                break;
            case BaseOp::Delay:
                if (!delay.processBlock(mono.data() + offset, output.data() + offset,
                                        delaySamples.data() + offset, segment)) return false;
                break;
            case BaseOp::Lfo:
                if (!lfo.processBlock(output.data() + offset, segment)) return false;
                break;
            case BaseOp::Oscillator:
                if (!osc.processBlock(output.data() + offset, segment)) return false;
                break;
            case BaseOp::Adaa:
                if (!adaa.processBlock(mono.data() + offset, output.data() + offset, segment)) return false;
                break;
            case BaseOp::Compressor:
                for (std::uint32_t i = 0; i < segment; ++i) {
                    inL[i] = stereo[static_cast<std::size_t>(offset + i) * 2U];
                    inR[i] = stereo[static_cast<std::size_t>(offset + i) * 2U + 1U];
                }
                if (!compressor.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), segment)) return false;
                for (std::uint32_t i = 0; i < segment; ++i) {
                    const auto dest = static_cast<std::size_t>(offset + i) * 2U;
                    output[dest] = outL[i]; output[dest + 1U] = outR[i];
                }
                break;
            case BaseOp::Matrix:
                for (std::uint32_t i = 0; i < segment; ++i) {
                    const auto frame = offset + i;
                    const auto result = matrix.process(
                        {stereo[static_cast<std::size_t>(frame) * 2U], stereo[static_cast<std::size_t>(frame) * 2U + 1U]},
                        {matrixLeft[frame], matrixRight[frame]});
                    output[static_cast<std::size_t>(frame) * 2U] = result.left;
                    output[static_cast<std::size_t>(frame) * 2U + 1U] = result.right;
                }
                break;
            case BaseOp::Pcg:
                for (std::uint32_t i = 0; i < segment; ++i) output[offset + i] = pcg.nextBipolar();
                break;
            }
            callbackOffset += segment;
        }
        frameOffset += callbackFrames;
    }
    return frameOffset == kFrames && eventIndex == config.events.size();
}

std::string baseFixtureJson(const BaseSpec& spec, const Profile& profile,
                            const Ref& output, std::uint64_t seedState,
                            std::uint64_t seedSequence) {
    std::string settings = spec.settings;
    if (!settings.empty() && settings.back() == '}') {
        settings.pop_back();
        settings += ",\"controls\":[";
        bool first = true;
        for (const auto& event : spec.events) {
            if (event.frame != 0U) continue;
            if (!first) settings += ',';
            first = false;
            std::ostringstream control;
            control << "{\"controlId\":" << event.control << ",\"values\":";
            writeFloatArray(control, event.values);
            control << '}';
            settings += control.str();
        }
        settings += "]}";
    }
    std::vector<Event> automatedEvents;
    for (const auto& event : spec.events) if (event.frame != 0U) automatedEvents.push_back(event);
    const bool fixedNoBufferLatency = spec.kind == 1U || spec.kind == 6U || spec.kind == 7U ||
                                      spec.kind == 9U || spec.kind == 10U || spec.kind == 11U;
    const char* latencyModel = spec.kind == 5U ? "per-sample time-varying delay; declared latency follows delaySamples sidecar" :
        (spec.kind == 2U || spec.kind == 3U || spec.kind == 4U || spec.kind == 8U)
        ? "frequency-dependent phase/group delay; no fixed integer latency is declared" :
        spec.kind == 9U ? "zero inserted audio frames; compressor detector attack/release is dynamic gain response" :
        spec.kind == 10U ? "zero additional frames; delayed feedback inputs are supplied externally" :
        "zero whole-sample buffering in the primitive API";
    std::ostringstream out;
    out << "{\"fixtureId\":" << jsonString(spec.fixtureKey + "_" + profile.id)
        << ",\"module\":" << jsonString(spec.module)
        << ",\"operation\":" << jsonString(spec.operation)
        << ",\"wasmKindId\":" << spec.kind
        << ",\"sampleRateHz\":48000,\"channels\":" << spec.channels
        << ",\"outputChannels\":" << spec.outputChannels
        << ",\"maxBlockFrames\":" << kMaxBlock << ",\"frames\":" << kFrames
        << ",\"inputRecipeSeed\":1660099229"
        << ",\"seedState\":\"" << seedState << "\",\"seedSequence\":\"" << seedSequence << "\""
        << ",\"settings\":" << settings
        << ",\"eventFrameUnit\":\"sample-frame\",\"events\":" << eventsJson(automatedEvents)
        << ",\"resetPolicy\":\"fresh Native state per fixture; no reset during stream\""
        << ",\"declaredLatencySamples\":" << (fixedNoBufferLatency ? "0" : "null")
        << ",\"latencyModel\":" << jsonString(latencyModel)
        << ",\"latencyEvidence\":" << jsonString(latencyModel)
        << ",\"inputPcm\":" << (spec.hasInput ? refJson(spec.input) : "null")
        << ",\"setupPayloads\":" << setupJson(spec.setups)
        << ",\"partitions\":" << partitionsJson(profile)
        << ",\"nativeOutputPcm\":" << refJson(output)
        << ",\"tolerance\":{\"maxAbsError\":0.00002,\"rmsError\":0.000003,\"rejectNonFinite\":true}"
        << '}';
    return out.str();
}

bool addBaseFixture(const std::filesystem::path& outputRoot,
                    const Profile& profile, const std::vector<float>& mono,
                    const std::vector<float>& stereo,
                    const std::vector<float>& delaySamples,
                    const std::vector<float>& feedbackLeft,
                    const std::vector<float>& feedbackRight,
                    BaseOp op, BaseSpec config,
                    std::vector<Fixture>& fixtures) {
    config.input = config.channels == 2U
        ? Ref{"inputs/base_stereo.f32le", kFrames, 2U}
        : Ref{"inputs/base_mono.f32le", kFrames, 1U};
    if (op == BaseOp::Delay) {
        config.setups.push_back({"delaySamples", Ref{"inputs/lagrange_delay_samples.f32le", kFrames, 1U}});
    }
    if (op == BaseOp::Matrix) {
        config.setups.push_back({"delayedLeft", Ref{"inputs/delay_feedback_left.f32le", kFrames, 1U}});
        config.setups.push_back({"delayedRight", Ref{"inputs/delay_feedback_right.f32le", kFrames, 1U}});
    }
    config.hasInput = op != BaseOp::Smoother && op != BaseOp::Lfo &&
                      op != BaseOp::Oscillator && op != BaseOp::Pcg;
    const std::uint64_t seedState = 0x4d595df4ULL;
    const std::uint64_t seedSequence = 7U;
    std::vector<float> output;
    if (!renderBase(op, config, profile, mono, stereo, delaySamples, feedbackLeft,
                    feedbackRight, seedState, seedSequence, output)) {
        std::cerr << "Native base processing failed: " << config.fixtureKey << '/' << profile.id << '\n';
        return false;
    }
    const auto rel = "pcm/native/" + config.fixtureKey + "_" + profile.id + ".f32le";
    if (!writeFloat32(outputRoot / rel, output)) return false;
    Ref outRef{rel, kFrames, config.outputChannels};
    fixtures.push_back({baseFixtureJson(config, profile, outRef, seedState, seedSequence)});
    return true;
}

std::string pitchFixtureJson(const std::string& id, const std::string& module,
                             const std::string& operation, std::uint32_t kind,
                             std::uint32_t channels, const Profile& profile,
                             const std::string& settings, const std::string& inputRef,
                             const std::string& outputRef, std::uint32_t maxBlockFrames,
                             const std::string& latencyJson,
                             const std::string& latencyEvidence,
                             const std::string& extraFields = "") {
    std::ostringstream out;
    out << "{\"fixtureId\":" << jsonString(id) << ",\"module\":" << jsonString(module)
        << ",\"operation\":" << jsonString(operation) << ",\"wasmKindId\":" << kind
        << ",\"sampleRateHz\":48000,\"channels\":" << channels
        << ",\"maxBlockFrames\":" << maxBlockFrames << ",\"frames\":" << kFrames
        << ",\"inputRecipeSeed\":1660099229"
        << ",\"settings\":" << settings << ",\"eventFrameUnit\":\"sample-frame\",\"events\":[]"
        << ",\"resetPolicy\":\"fresh Native state per fixture; deterministic initialized state\""
        << ",\"processingScope\":\"" << (operation == "psola-buffer" ? "whole-buffer-offline" : "streaming-blocks")
        << "\",\"declaredLatencySamples\":" << latencyJson
        << ",\"latencyEvidence\":" << jsonString(latencyEvidence)
        << ",\"inputPcm\":" << inputRef << ",\"setupPayloads\":[]"
        << ",\"partitions\":" << partitionsJson(profile)
        << ",\"nativeOutputPcm\":" << outputRef
        << ",\"tolerance\":{\"maxAbsError\":0.001,\"rmsError\":0.0001,\"rejectNonFinite\":true}"
        << extraFields << '}';
    return out.str();
}

bool addPitchFixtures(const std::filesystem::path& root,
                      const std::vector<Profile>& ps,
                      const std::vector<float>& mono,
                      const std::vector<float>& modulatorRight,
                      const std::vector<float>& carrierLeft,
                      const std::vector<float>& carrierRight,
                      std::vector<Fixture>& fixtures) {
    const float sourcePeriod = kSampleRate / 220.37f;
    const std::vector<float> ratios{0.5f,0.75f,1.0f,1.25f,2.0f};
    const Ref monoRef{"inputs/pitch_mono.f32le", kFrames, 1U};
    const Ref stereoRef{"inputs/pitch_stereo.f32le", kFrames, 2U};

    // YIN: five deterministic analysis windows over the voiced portion.
    {
        const ProcessSpec spec{kSampleRate,kMaxBlock,1U};
        YinPitchDetector yin;
        if (!yin.prepare(spec,2048U,150.0f,500.0f,0.15f)) return false;
        const std::array<std::uint32_t,5> starts{1024U,4096U,6144U,8192U,10240U};
        std::ostringstream analysis, windows;
        analysis << '[' << std::setprecision(9);
        windows << '[';
        for (std::size_t i=0;i<starts.size();++i) {
            PitchEstimate value{};
            if (!yin.analyze(mono.data()+starts[i],2048U,value)) return false;
            if (i) analysis << ',';
            if (i) windows << ',';
            windows << "{\"startFrame\":" << starts[i] << ",\"frameFrames\":2048}";
            analysis << "{\"startFrame\":" << starts[i] << ",\"frameFrames\":2048"
                     << ",\"frequencyHz\":" << value.frequencyHz
                     << ",\"periodSamples\":" << value.periodSamples
                     << ",\"confidence\":" << value.confidence
                     << ",\"rms\":" << value.rms
                     << ",\"voiced\":" << (value.voiced ? "true":"false") << '}';
        }
        analysis << ']'; windows << ']';
        const auto fixture = std::string("pitch_yin_mono_5windows");
        std::ostringstream out;
        out << "{\"fixtureId\":" << jsonString(fixture)
            << ",\"module\":\"YinPitchDetector\",\"catalogFormulaId\":\"F10\","
            << "\"operation\":\"yin-analyze\",\"wasmKindId\":108,\"sampleRateHz\":48000,"
            << "\"channels\":1,\"maxBlockFrames\":512,\"frames\":" << kFrames << ",\"inputRecipeSeed\":1660099229"
            << ",\"settings\":{\"prepareParameters\":[2048,150,500,0.15],\"frameFrames\":2048,\"minimumFrequencyHz\":150,"
            << "\"maximumFrequencyHz\":500,\"threshold\":0.15},"
            << "\"analysisWindows\":" << windows.str()
            << ",\"eventFrameUnit\":\"sample-frame\",\"events\":[]"
            << ",\"inputPcm\":" << refJson(monoRef) << ",\"nativeAnalysis\":" << analysis.str()
            << ",\"declaredLatencySamples\":{\"input\":0,\"output\":0},"
            << "\"latencyEvidence\":\"one explicit 2048-sample analysis frame per result; analysis scheduling latency is caller-owned\","
            << "\"tolerance\":{\"rejectNonFinite\":true,\"analysisFields\":{"
            << "\"frequencyHz\":{\"maxAbs\":0.02},\"periodSamples\":{\"maxAbs\":0.02},"
            << "\"confidence\":{\"maxAbs\":0.00002},\"rms\":{\"maxAbs\":0.00002},"
            << "\"voiced\":{\"exact\":true}}}}";
        fixtures.push_back({out.str()});
    }

    // Offline whole-buffer TD-PSOLA. This is intentionally not represented as callback streaming.
    for (std::size_t ri=0;ri<ratios.size();++ri) {
        TdPsolaPitchShifter shifter;
        if (!shifter.prepare({kSampleRate,kMaxBlock,1U},kFrames,400U)) return false;
        std::vector<float> output(kFrames);
        if (!shifter.processBuffer(mono.data(),output.data(),kFrames,sourcePeriod,ratios[ri])) return false;
        const auto id="pitch_tdpsola_offline_r"+std::to_string(ri);
        const auto path="pcm/native/"+id+".f32le";
        if (!writeFloat32(root/path,output)) return false;
        std::ostringstream settings;
        settings << std::setprecision(9) << "{\"maxBufferFrames\":" << kFrames
                 << ",\"prepareParameters\":[15360,400],\"maxPitchPeriodSamples\":400,\"sourcePeriodSamples\":" << sourcePeriod
                 << ",\"pitchRatio\":" << ratios[ri] << '}';
        Profile whole{"whole_buffer",{kFrames}};
        const auto json=pitchFixtureJson(id,"TdPsolaPitchShifter","psola-buffer",109,1U,whole,
            settings.str(),refJson(monoRef),refJson({path,kFrames,1U}),kFrames,"null",
            "offline whole-buffer renderer has no declared streaming latency",
            ",\"catalogFormulaId\":\"F11\"");
        fixtures.push_back({json});
    }

    // Streaming TD-PSOLA: 5 ratios crossed with all five actual callback schedules.
    for (std::size_t ri=0;ri<ratios.size();++ri) {
        for (const auto& profile:ps) {
            StreamingTdPsolaPitchShifter shifter;
            if (!shifter.prepare({kSampleRate,kMaxBlock,1U},400U) ||
                !shifter.setPitch(sourcePeriod,ratios[ri],true)) return false;
            std::vector<float> output(kFrames);
            std::uint32_t offset=0;
            for (const auto block:profile.blocks) {
                if (!shifter.processBlock(mono.data()+offset,output.data()+offset,block)) return false;
                offset+=block;
            }
            if (offset!=kFrames) return false;
            const auto id="pitch_tdpsola_stream_r"+std::to_string(ri)+"_"+profile.id;
            const auto path="pcm/native/"+id+".f32le";
            if (!writeFloat32(root/path,output)) return false;
            std::ostringstream settings;
            settings << std::setprecision(9) << "{\"prepareParameters\":[400],\"maximumPitchPeriodSamples\":400,\"sourcePeriodSamples\":"
                     << sourcePeriod << ",\"pitchRatio\":" << ratios[ri] << ",\"voiced\":true}";
            std::string streamSettings=settings.str();
            streamSettings.pop_back();
            streamSettings += ",\"controls\":[{\"controlId\":9,\"values\":[" +
                std::to_string(sourcePeriod) + "," + std::to_string(ratios[ri]) + ",1]}]}";
            fixtures.push_back({pitchFixtureJson(id,"StreamingTdPsolaPitchShifter","streaming-psola",110,
                1U,profile,streamSettings,refJson(monoRef),refJson({path,kFrames,1U}),
                kMaxBlock,"{\"input\":0,\"output\":"+std::to_string(shifter.latencySamples())+"}",
                "latencySamples() getter reports fixed 3*maximumPitchPeriodSamples()",
                ",\"catalogFormulaId\":\"F11\"" )});
        }
    }

    // Four Hann-windowed complex spectra, streamed through PhaseVocoder for each pitch ratio.
    constexpr std::uint32_t fftFrames=1024U;
    constexpr std::uint32_t spectralFrames=4U;
    std::vector<std::complex<float>> spectra(static_cast<std::size_t>(spectralFrames)*fftFrames);
    for (std::uint32_t frame=0;frame<spectralFrames;++frame) {
        auto* spectrum=spectra.data()+static_cast<std::size_t>(frame)*fftFrames;
        const auto start=1024U+frame*256U;
        for (std::uint32_t i=0;i<fftFrames;++i) {
            const double hann=0.5-0.5*std::cos(2.0*kPi*i/(fftFrames-1U));
            spectrum[i]={static_cast<float>(mono[start+i]*hann),0.0f};
        }
        if (!fft::transform(spectrum,fftFrames,fft::Direction::Forward)) return false;
    }
    for (const float ratio:{0.75f,1.0f,1.25f}) {
        PhaseVocoder phase;
        if (!phase.prepare({kSampleRate,256U,1U},fftFrames,256U,256U)) return false;
        std::vector<std::complex<float>> transformed(spectra.size());
        for (std::uint32_t frame=0;frame<spectralFrames;++frame) {
            if (!phase.processSpectrumFrame(spectra.data()+static_cast<std::size_t>(frame)*fftFrames,
                    transformed.data()+static_cast<std::size_t>(frame)*fftFrames,ratio)) return false;
        }
        const auto ratioTag=ratio==0.75f?"075":ratio==1.0f?"100":"125";
        const auto id=std::string("pitch_phase_vocoder_")+ratioTag;
        const auto inPath="inputs/phase_input_"+std::string(ratioTag)+".f32le";
        const auto outPath="pcm/native/"+id+".f32le";
        if (!writeComplex32(root/inPath,spectra)||!writeComplex32(root/outPath,transformed)) return false;
        Profile spectralProfile{"spectral_frames_4",{1U,1U,1U,1U}};
        const Ref inRef{inPath,spectralFrames,1U,"float32-le-interleaved-complex",fftFrames};
        const Ref outRef{outPath,spectralFrames,1U,"float32-le-interleaved-complex",fftFrames};
        std::ostringstream settings;
        settings<<std::setprecision(9)<<"{\"prepareParameters\":[1024,256,256],\"fftFrames\":1024,\"analysisHopFrames\":256,\"synthesisHopFrames\":256,\"pitchRatio\":"<<ratio<<'}';
        std::ostringstream json;
        json<<"{\"fixtureId\":"<<jsonString(id)<<",\"module\":\"PhaseVocoder\",\"catalogFormulaId\":\"F12\","
            <<"\"operation\":\"phase-vocoder-frame-stream\",\"wasmKindId\":111,\"sampleRateHz\":48000,"
            <<"\"channels\":1,\"maxBlockFrames\":1,\"frames\":4,\"inputRecipeSeed\":1660099229,\"settings\":"<<settings.str()
            <<",\"eventFrameUnit\":\"sample-frame\",\"events\":[]"
            <<",\"inputComplex\":"<<refJson(inRef)<<",\"nativeOutputComplex\":"<<refJson(outRef)
            <<",\"partitions\":{\"profileId\":\"spectral_frames_4\",\"callbackFrames\":[1,1,1,1]}"
            <<",\"declaredLatencySamples\":{\"input\":0,\"output\":0},\"latencyEvidence\":\"caller owns STFT windowing and overlap-add; this is a four-frame spectral state test\","
            <<"\"tolerance\":{\"maxAbsError\":0.0001,\"rmsError\":0.00001,\"rejectNonFinite\":true}}";
        fixtures.push_back({json.str()});
    }

    // Linked stereo 16-band vocoder; independent modulator and carrier material.
    const Ref carrierRef{"inputs/vocoder_carrier_stereo.f32le",kFrames,2U};
    for (const auto& profile:ps) {
        MultibandVocoder vocoder;
        if (!vocoder.prepare({kSampleRate,kMaxBlock,2U},16U,80.0f,10000.0f,1.25f) ||
            !vocoder.setEnvelopeTimes(10.0f,100.0f)||!vocoder.setOutputGain(1.0f)) return false;
        std::vector<float> output(static_cast<std::size_t>(kFrames)*2U);
        std::uint32_t offset=0U;
        for (const auto block:profile.blocks) {
            std::vector<float> left(block),right(block),carrierL(block),carrierR(block),outL(block),outR(block);
            for (std::uint32_t i=0;i<block;++i) {
                left[i]=mono[offset+i]; right[i]=modulatorRight[offset+i];
                carrierL[i]=carrierLeft[offset+i]; carrierR[i]=carrierRight[offset+i];
            }
            if (!vocoder.processBlock(left.data(),right.data(),carrierL.data(),carrierR.data(),outL.data(),outR.data(),block)) return false;
            for (std::uint32_t i=0;i<block;++i) {
                output[static_cast<std::size_t>(offset+i)*2U]=outL[i];
                output[static_cast<std::size_t>(offset+i)*2U+1U]=outR[i];
            }
            offset+=block;
        }
        const auto id="pitch_multiband_vocoder_"+profile.id;
        const auto path="pcm/native/"+id+".f32le";
        if (!writeFloat32(root/path,output)) return false;
        std::ostringstream json;
        json<<"{\"fixtureId\":"<<jsonString(id)<<",\"module\":\"MultibandVocoder\",\"catalogFormulaId\":\"F13\","
            <<"\"operation\":\"multiband-vocoder\",\"wasmKindId\":112,\"sampleRateHz\":48000,"
            <<"\"channels\":2,\"maxBlockFrames\":512,\"frames\":"<<kFrames<<",\"inputRecipeSeed\":1660099229"
            <<",\"settings\":{\"prepareParameters\":[16,80,10000,1.25],\"bands\":16,\"minimumFrequencyHz\":80,\"maximumFrequencyHz\":10000,\"bandQ\":1.25,\"attackMs\":10,\"releaseMs\":100,\"outputGain\":1,\"controls\":[{\"controlId\":10,\"values\":[10,100]},{\"controlId\":11,\"values\":[1]}]}"
            <<",\"eventFrameUnit\":\"sample-frame\",\"events\":[]"
            <<",\"inputPcm\":"<<refJson(stereoRef)<<",\"setupPayloads\":[{\"role\":\"carrier\",\"pcm\":"<<refJson(carrierRef)<<"}]"
            <<",\"partitions\":"<<partitionsJson(profile)<<",\"nativeOutputPcm\":"<<refJson({path,kFrames,2U})
            <<",\"declaredLatencySamples\":null,\"latencyModel\":\"frequency-dependent bandpass filterbank phase/group delay; no inserted frame buffering\","
            <<"\"latencyEvidence\":\"no fixed integer latency is declared; first nonzero onset is descriptive fixture data, not a latency threshold\","
            <<"\"observedOutputOnsetFrameAtThreshold1e-6\":";
        std::int64_t onset=-1;
        for(std::size_t sample=0;sample<output.size();++sample){
            if(std::abs(output[sample])>1.0e-6f){onset=static_cast<std::int64_t>(sample/2U);break;}
        }
        json<<onset<<','
            <<"\"tolerance\":{\"maxAbsError\":0.0002,\"rmsError\":0.00002,\"rejectNonFinite\":true}}";
        fixtures.push_back({json.str()});
    }
    (void)carrierLeft;
    (void)carrierRight;
    return true;
}

} // namespace

int main(int argc,char** argv) {
    if(argc!=2){std::cerr<<"usage: native_dsp_parity_v21_generator <output-directory>\n";return 2;}
    const std::filesystem::path root(argv[1]);
    for(const auto& dir:{root/"inputs",root/"pcm"/"native"}){
        std::error_code ec; std::filesystem::create_directories(dir,ec);
        if(ec){std::cerr<<"failed create output directory\n";return 1;}
    }
    const auto mono=makeSignal(0U);
    const auto right=makeSignal(1U,311.13);
    const auto stereo=interleave(mono,right);
    const auto carrierL=makeSignal(2U,146.83);
    const auto carrierR=makeSignal(3U,392.0);
    std::vector<float> delaySamples(kFrames),feedbackL(kFrames),feedbackR(kFrames);
    for(std::uint32_t i=0;i<kFrames;++i){
        delaySamples[i]=12.5f+18.0f*static_cast<float>(0.5+0.5*std::sin(2.0*kPi*0.37*i/kSampleRate));
        feedbackL[i]=0.12f*mono[i]; feedbackR[i]=0.10f*right[i];
    }
    if(!writeFloat32(root/"inputs/base_mono.f32le",mono)||
       !writeFloat32(root/"inputs/base_stereo.f32le",stereo)||
       !writeFloat32(root/"inputs/pitch_mono.f32le",mono)||
       !writeFloat32(root/"inputs/pitch_stereo.f32le",stereo)||
       !writeFloat32(root/"inputs/vocoder_carrier_stereo.f32le",interleave(carrierL,carrierR))||
       !writeFloat32(root/"inputs/lagrange_delay_samples.f32le",delaySamples)||
       !writeFloat32(root/"inputs/delay_feedback_left.f32le",feedbackL)||
       !writeFloat32(root/"inputs/delay_feedback_right.f32le",feedbackR)){
       std::cerr<<"failed writing deterministic input PCM\n";return 1;
    }

    const auto ps=profiles();
    if(ps.size()!=5U){std::cerr<<"partition profiles do not cover 15360 frames\n";return 1;}
    std::vector<Fixture> fixtures;
    for(const auto& p:ps){
        // 5 RBJ designs × 5 callback schedules, with true in-stream coefficient automation.
        for(const auto& type:std::array<std::string,5>{"lowpass","highpass","peaking","lowShelf","highShelf"}){
            BaseSpec c{}; c.module="BiquadDf2T"; c.operation="base-biquad-stream"; c.fixtureKey="base_biquad_"+type;
            c.controlVariant=type;
            c.kind=2U;c.settings="{\"filterType\":\""+type+"\",\"smoothingMs\":12}";
            const std::uint32_t id=type=="lowpass"?2U:type=="highpass"?3U:type=="peaking"?5U:type=="lowShelf"?14U:15U;
            if(type=="lowpass"||type=="highpass") c.events={{0U,id,{1200.0f,0.707f,12.0f}},{8192U,id,{3900.0f,0.9f,24.0f}}};
            else if(type=="peaking") c.events={{0U,id,{1200.0f,1.1f,5.0f,12.0f}},{8192U,id,{2600.0f,0.8f,-4.0f,20.0f}}};
            else c.events={{0U,id,{900.0f,5.0f,1.0f,12.0f}},{8192U,id,{3400.0f,-3.0f,0.8f,20.0f}}};
            c.settings="{\"filterType\":"+jsonString(type)+",\"initialControlId\":"+std::to_string(id)+"}";
            if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Biquad,c,fixtures))return 1;
        }
        BaseSpec smoother{};smoother.module="ParameterSmoother";smoother.operation="base-smoother-stream";
        smoother.fixtureKey="base_smoother";smoother.kind=1U;smoother.hasInput=false;
        smoother.settings="{\"initialValue\":-0.25,\"timeMs\":20}";
        smoother.events={{0U,1U,{0.65f,20.0f}},{6144U,1U,{-0.35f,35.0f}},{11264U,1U,{0.2f,5.0f}}};
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Smoother,smoother,fixtures))return 1;

        BaseSpec svf{};svf.module="TptStateVariableFilter";svf.operation="base-svf-stream";svf.fixtureKey="base_svf";
        svf.kind=3U;svf.outputChannels=3U;svf.settings="{\"outputs\":[\"low\",\"band\",\"high\"]}";
        svf.events={{0U,6U,{850.0f,0.707f,12.0f}},{8192U,6U,{2800.0f,1.4f,16.0f}}};
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Svf,svf,fixtures))return 1;

        BaseSpec ap{};ap.module="AllPass1";ap.operation="base-allpass-stream";ap.fixtureKey="base_allpass";ap.kind=4U;
        ap.settings="{\"smoothingMs\":15}";ap.events={{0U,7U,{420.0f,15.0f}},{8192U,7U,{3600.0f,20.0f}}};
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::AllPass,ap,fixtures))return 1;

        BaseSpec lag{};lag.module="LagrangeDelay";lag.operation="base-lagrange-delay-stream";lag.fixtureKey="base_lagrange_delay";lag.kind=5U;
        lag.settings="{\"maximumDelaySamples\":2048,\"minimumDelaySamples\":2.5,\"delayParameterRole\":\"delaySamples\"}";
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Delay,lag,fixtures))return 1;

        BaseSpec lfo{};lfo.module="Lfo";lfo.operation="base-lfo-stream";lfo.fixtureKey="base_lfo";lfo.kind=6U;lfo.hasInput=false;
        lfo.settings="{\"initialPhaseCycles\":0.21}";lfo.events={{0U,8U,{2.5f}},{8192U,8U,{7.25f}}};
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Lfo,lfo,fixtures))return 1;

        BaseSpec osc{};osc.module="PolyBlepOscillator";osc.operation="base-polyblep-stream";osc.fixtureKey="base_polyblep";osc.kind=7U;osc.hasInput=false;
        osc.settings="{\"initialPhaseCycles\":0.13,\"initialWaveform\":0}";
        osc.events={{0U,9U,{110.0f}},{0U,10U,{1.0f}},{8192U,9U,{6500.0f}},{11264U,10U,{2.0f}}};
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Oscillator,osc,fixtures))return 1;

        BaseSpec ad{};ad.module="AdaaCubicShaper";ad.operation="base-adaa-stream";ad.fixtureKey="base_adaa";ad.kind=8U;
        ad.settings="{\"driveAutomation\":true}";ad.events={{0U,11U,{1.25f}},{8192U,11U,{3.5f}}};
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Adaa,ad,fixtures))return 1;

        BaseSpec comp{};comp.module="DualDetectorCompressor";comp.operation="base-compressor-stereo-stream";comp.fixtureKey="base_compressor";comp.kind=9U;comp.channels=2U;comp.outputChannels=2U;
        comp.settings="{\"linkedStereo\":true,\"parameterOrder\":[\"thresholdDb\",\"ratio\",\"kneeDb\",\"attackMs\",\"releaseMs\",\"rmsMix\",\"makeupDb\"]}";
        comp.events={{0U,12U,{-18.0f,4.0f,6.0f,5.0f,80.0f,0.5f,0.0f}},{8192U,12U,{-24.0f,8.0f,3.0f,2.0f,150.0f,0.8f,2.0f}}};
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Compressor,comp,fixtures))return 1;

        BaseSpec matrix{};matrix.module="DelayMatrix2";matrix.operation="base-delay-matrix-stereo-stream";matrix.fixtureKey="base_delay_matrix";matrix.kind=10U;matrix.channels=2U;matrix.outputChannels=2U;
        matrix.settings="{\"sameChannelFeedback\":0.37,\"crossChannelFeedback\":0.22,\"feedbackLeftRole\":\"delayedLeft\",\"feedbackRightRole\":\"delayedRight\"}";
        matrix.events={{0U,13U,{0.37f,0.22f}},{8192U,13U,{0.21f,0.31f}}};
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Matrix,matrix,fixtures))return 1;

        BaseSpec pcg{};pcg.module="Pcg32";pcg.operation="base-pcg32-stream";pcg.fixtureKey="base_pcg32";pcg.kind=11U;pcg.hasInput=false;
        pcg.settings="{\"seedState\":\"1297757684\",\"seedSequence\":\"7\",\"output\":\"nextBipolar\"}";
        if(!addBaseFixture(root,p,mono,stereo,delaySamples,feedbackL,feedbackR,BaseOp::Pcg,pcg,fixtures))return 1;
    }

    if(!addPitchFixtures(root,ps,mono,right,carrierL,carrierR,fixtures)){
        std::cerr << "Native pitch fixture processing failed.\n";
        return 1;
    }
    if(fixtures.size()!=114U){
        std::cerr<<"unexpected fixture count "<<fixtures.size()<<" (expected 114)\n";
        return 1;
    }
    std::ofstream manifest(root/"manifest.draft.json",std::ios::out|std::ios::trunc);
    manifest.imbue(std::locale::classic());
    manifest<<"{\n  \"schemaVersion\":3,\n  \"producer\":\"native_dsp_parity_v21_generator\",\n"
            <<"  \"purpose\":\"long deterministic Native/WASM PCM and analysis parity for base kinds 1-11 and pitch kinds 108-112; not product FX coverage, quality acceptance, callback deadline or hardware evidence\",\n"
            <<"  \"sampleRateHz\":48000,\n  \"framesPerFixture\":"<<kFrames<<",\n  \"fixtureCount\":"<<fixtures.size()<<",\n"
            <<"  \"partitionProfiles\":[";
    for(std::size_t i=0;i<ps.size();++i){if(i)manifest<<',';manifest<<"{\"id\":"<<jsonString(ps[i].id)<<",\"callbackFrames\":";writeUIntArray(manifest,ps[i].blocks);manifest<<'}';}
    manifest<<",{\"id\":\"whole_buffer\",\"callbackFrames\":[15360]},{\"id\":\"spectral_frames_4\",\"callbackFrames\":[1,1,1,1]}";
    manifest<<"],\n  \"fixtures\":[\n";
    for(std::size_t i=0;i<fixtures.size();++i){manifest<<"    "<<fixtures[i].json<<(i+1==fixtures.size()?"\n":",\n");}
    manifest<<"  ]\n}\n";
    if(!manifest){std::cerr<<"failed writing draft manifest\n";return 1;}
    std::cout<<"Generated "<<fixtures.size()<<" v2.1 Native parity fixtures (base 1-11, pitch 108-112); "<<kFrames<<" PCM frames at 48 kHz; no hardware stream opened.\n";
    return 0;
}
