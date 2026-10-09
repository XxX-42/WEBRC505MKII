#include "webrc/dsp/signalsmith_adapter.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <string>
#include <vector>

namespace {

using namespace webrc::dsp;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr float kSampleRate = 48000.0f;
constexpr std::uint32_t kFrames = 15360;
constexpr std::uint32_t kMaximumBlock = 512;
constexpr std::uint32_t kBaseEngineSeed = 0x50524cU;

struct ChannelLayout {
    PitchQualityMode mode;
    const char* modeName;
    std::uint32_t channels;
    const char* inputKey;
};

struct PartitionProfile {
    const char* id;
    const char* kind;
    std::uint32_t fixedFrames;
    std::vector<std::uint32_t> callbackFrames;
};

struct RunMetrics {
    double rms = 0.0;
    double peak = 0.0;
    std::int64_t firstNonzeroFrame = -1;
};

std::uint32_t nextNoise(std::uint32_t& state) noexcept {
    state = state * 1664525U + 1013904223U;
    return state;
}

float noiseSample(std::uint32_t& state) noexcept {
    const std::uint32_t word = nextNoise(state);
    const auto signedWord = static_cast<std::int32_t>(word >> 8U) - 0x7fffff;
    return static_cast<float>(signedWord) / 8388608.0f;
}

std::vector<float> makeChannel(std::uint32_t channel) {
    std::vector<float> samples(kFrames, 0.0f);
    std::uint32_t noiseState = 0x62f31a9dU ^ (channel * 0x9e3779b9U);
    const double f0 = channel == 0U ? 220.37 : 311.13;
    const double f1 = channel == 0U ? 659.11 : 493.27;
    for (std::uint32_t frame = 0; frame < kFrames; ++frame) {
        double envelope = 0.0;
        if (frame >= 512U && frame < 1024U) {
            const double t = static_cast<double>(frame - 512U + 1U) / 512.0;
            envelope = 0.5 * (1.0 - std::cos(kPi * t));
        } else if (frame >= 1024U && frame < 13312U) {
            envelope = 1.0;
        } else if (frame >= 13312U && frame < 13824U) {
            const double t = static_cast<double>(frame - 13312U + 1U) / 512.0;
            envelope = 0.5 * (1.0 + std::cos(kPi * t));
        }
        if (envelope == 0.0) continue;

        const double phase = 2.0 * kPi * f0 * static_cast<double>(frame) /
                             static_cast<double>(kSampleRate);
        const double overtonePhase = 2.0 * kPi * f1 * static_cast<double>(frame) /
                                     static_cast<double>(kSampleRate);
        double sample = 0.34 * std::sin(phase) + 0.11 * std::sin(overtonePhase);
        sample += 0.0007 * static_cast<double>(noiseSample(noiseState));
        if (frame == 4096U) sample += 0.22;
        samples[frame] = static_cast<float>(sample * envelope);
    }
    return samples;
}

bool writePcm(const std::filesystem::path& path, const std::vector<float>& interleaved) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) return false;
    for (const float sample : interleaved) {
        if (!std::isfinite(sample)) return false;
        std::uint32_t bits = 0;
        static_assert(sizeof(bits) == sizeof(sample), "float32 output requires 32-bit float");
        std::memcpy(&bits, &sample, sizeof(bits));
        const char bytes[4] = {
            static_cast<char>(bits & 0xffU),
            static_cast<char>((bits >> 8U) & 0xffU),
            static_cast<char>((bits >> 16U) & 0xffU),
            static_cast<char>((bits >> 24U) & 0xffU),
        };
        output.write(bytes, sizeof(bytes));
    }
    return static_cast<bool>(output);
}

RunMetrics measure(const std::vector<float>& interleaved, std::uint32_t channels) {
    RunMetrics result{};
    double energy = 0.0;
    for (std::size_t index = 0; index < interleaved.size(); ++index) {
        const float value = interleaved[index];
        energy += static_cast<double>(value) * value;
        result.peak = std::max(result.peak, std::abs(static_cast<double>(value)));
        if (result.firstNonzeroFrame < 0 && std::abs(value) > 1.0e-6f) {
            result.firstNonzeroFrame = static_cast<std::int64_t>(index / channels);
        }
    }
    if (!interleaved.empty()) {
        result.rms = std::sqrt(energy / static_cast<double>(interleaved.size()));
    }
    return result;
}

std::string ratioId(float ratio) {
    if (ratio == 0.5f) return "050";
    if (ratio == 0.75f) return "075";
    if (ratio == 1.0f) return "100";
    if (ratio == 1.25f) return "125";
    return "200";
}

std::vector<PartitionProfile> makeProfiles() {
    std::vector<PartitionProfile> profiles;
    for (const auto blockFrames : {64U, 128U, 256U, 512U}) {
        PartitionProfile profile{};
        profile.id = blockFrames == 64U ? "uniform_64" :
                     blockFrames == 128U ? "uniform_128" :
                     blockFrames == 256U ? "uniform_256" : "uniform_512";
        profile.kind = "uniform";
        profile.fixedFrames = blockFrames;
        for (std::uint32_t offset = 0; offset < kFrames; offset += blockFrames)
            profile.callbackFrames.push_back(blockFrames);
        profiles.push_back(std::move(profile));
    }

    PartitionProfile mixed{};
    mixed.id = "mixed_64_128_256_512";
    mixed.kind = "repeatingPattern";
    mixed.fixedFrames = 0U;
    constexpr std::array<std::uint32_t, 4> pattern{64U, 128U, 256U, 512U};
    std::uint32_t total = 0U;
    std::size_t cursor = 0U;
    while (total < kFrames) {
        const auto block = pattern[cursor++ % pattern.size()];
        if (total + block > kFrames) return {};
        mixed.callbackFrames.push_back(block);
        total += block;
    }
    profiles.push_back(std::move(mixed));
    return profiles;
}

bool processOneRun(const std::filesystem::path& outputPath,
                   const std::vector<float>& left, const std::vector<float>& right,
                   std::uint32_t channels, PitchQualityMode mode,
                   const PartitionProfile& profile, float transposeRatio,
                   std::uint32_t seed, int& inputLatency, int& outputLatency,
                   RunMetrics& metrics) {
    const ProcessSpec spec{kSampleRate, kMaximumBlock, channels};
    SignalsmithStretchSettings settings{};
    settings.mode = mode;
    settings.channels = channels;
    settings.blockSamples = 512U;
    settings.intervalSamples = 128U;
    settings.splitComputation = false;
    settings.seed = seed;

    SignalsmithStretchAdapter stretcher(seed);
    const auto budget = SignalsmithStretchAdapter::requiredPrepareBytes(spec, settings);
    if (budget == 0U || !stretcher.prepare(spec, settings, budget) ||
        !stretcher.setTransposeFactor(transposeRatio, 0.0f) ||
        !stretcher.setFormantFactor(1.0f, false)) {
        return false;
    }
    inputLatency = stretcher.inputLatencySamples();
    outputLatency = stretcher.outputLatencySamples();

    std::array<std::vector<float>, 2> outputPlanes{
        std::vector<float>(kMaximumBlock),
        std::vector<float>(kMaximumBlock),
    };
    const float* inputPlanes[2]{left.data(), right.data()};
    std::vector<float> interleaved;
    interleaved.reserve(static_cast<std::size_t>(kFrames) * channels);
    std::uint32_t frameOffset = 0U;
    for (const auto block : profile.callbackFrames) {
        if (block == 0U || block > kMaximumBlock || frameOffset + block > kFrames) return false;
        const float* blockInputPointers[2]{
            inputPlanes[0] + frameOffset,
            channels == 2U ? inputPlanes[1] + frameOffset : nullptr,
        };
        float* outputPointers[2]{outputPlanes[0].data(), outputPlanes[1].data()};
        if (!stretcher.process(blockInputPointers, block, outputPointers, block)) {
            return false;
        }
        for (std::uint32_t frame = 0; frame < block; ++frame) {
            interleaved.push_back(outputPlanes[0][frame]);
            if (channels == 2U) interleaved.push_back(outputPlanes[1][frame]);
        }
        frameOffset += block;
    }
    if (frameOffset != kFrames || interleaved.size() != static_cast<std::size_t>(kFrames) * channels)
        return false;
    metrics = measure(interleaved, channels);
    return writePcm(outputPath, interleaved);
}

void writeFloatArray(std::ostream& out, const std::vector<std::uint32_t>& values) {
    out << '[';
    for (std::size_t index = 0; index < values.size(); ++index) {
        if (index != 0U) out << ',';
        out << values[index];
    }
    out << ']';
}

bool writeDraftManifest(const std::filesystem::path& path,
                        const std::vector<PartitionProfile>& profiles,
                        const std::vector<ChannelLayout>& layouts,
                        const std::vector<float>& ratios,
                        std::uint32_t inputLatency, std::uint32_t outputLatency,
                        const std::vector<RunMetrics>& allMetrics) {
    std::ofstream out(path, std::ios::out | std::ios::trunc);
    if (!out) return false;
    out.imbue(std::locale::classic());
    out << std::setprecision(9);
    out << "{\n"
        << "  \"schemaVersion\": 2,\n"
        << "  \"producer\": \"native_dsp_pcm_fixture_generator\",\n"
        << "  \"purpose\": \"long deterministic Native/Web PCM parity; not callback deadline or hardware evidence\",\n"
        << "  \"sampleRateHz\": 48000,\n"
        << "  \"framesPerFixture\": " << kFrames << ",\n"
        << "  \"partitionProfiles\": [\n";
    for (std::size_t index = 0; index < profiles.size(); ++index) {
        const auto& profile = profiles[index];
        out << "    {\"id\":\"" << profile.id << "\",\"kind\":\"" << profile.kind << "\",";
        if (profile.fixedFrames != 0U)
            out << "\"blockFrames\":" << profile.fixedFrames << ',';
        out << "\"callbackFrames\":";
        writeFloatArray(out, profile.callbackFrames);
        out << '}' << (index + 1U == profiles.size() ? "\n" : ",\n");
    }
    out << "  ],\n  \"fixtures\": [\n";

    std::size_t fixtureIndex = 0U;
    for (const auto& layout : layouts) {
        for (std::size_t ratioIndex = 0; ratioIndex < ratios.size(); ++ratioIndex) {
            const float ratio = ratios[ratioIndex];
            const std::uint32_t seed = kBaseEngineSeed +
                static_cast<std::uint32_t>(layout.mode) * 31U +
                static_cast<std::uint32_t>(layout.channels) * 7U +
                static_cast<std::uint32_t>(ratioIndex);
            const std::string baseFixtureId = std::string("pitch_signalsmith_") +
                layout.modeName + "_" + layout.inputKey + "_ratio_" + ratioId(ratio);
            for (std::size_t profileIndex = 0; profileIndex < profiles.size(); ++profileIndex) {
                const auto& profile = profiles[profileIndex];
                const std::string fixtureId = baseFixtureId + "_" + profile.id;
                const std::string runPath = "pcm/native/" + fixtureId + ".f32le";
                const auto& metrics = allMetrics[fixtureIndex];
                out << "    {\n"
                    << "      \"fixtureId\":\"" << fixtureId << "\",\n"
                    << "      \"module\":\"F10-F13\",\n"
                    << "      \"primitive\":\"SignalsmithStretchAdapter\",\n"
                    << "      \"wasmKindId\":113,\n"
                    << "      \"mode\":\"" << layout.modeName << "\",\n"
                    << "      \"modeSemantics\":\"metadata-only in the current adapter; does not select a distinct processing algorithm\",\n"
                    << "      \"sampleRateHz\":48000,\n"
                    << "      \"channels\":" << layout.channels << ",\n"
                    << "      \"maxBlockFrames\":" << kMaximumBlock << ",\n"
                    << "      \"frames\":" << kFrames << ",\n"
                    << "      \"seed\":" << seed << ",\n"
                    << "      \"settings\":{\"mode\":\"" << layout.modeName << "\",\"modeIsMetadataOnly\":true,"
                    << "\"channels\":" << layout.channels << ",\"blockSamples\":512,"
                    << "\"intervalSamples\":128,\"splitComputation\":false,"
                    << "\"transposeRatio\":" << ratio << ",\"transposeFactor\":" << ratio
                    << ",\"tonalityLimit\":0,\"formantFactor\":1,\"compensatePitch\":false},\n"
                    << "      \"resetPolicy\":\"fresh engine instance for this one partition schedule\",\n"
                    << "      \"flushPolicy\":\"no explicit final/drain API; input sidecar includes an explicit silent tail and each call emits an equal frame count\",\n"
                    << "      \"inputSections\":["
                    << "{\"name\":\"leadingSilence\",\"startFrame\":0,\"frames\":512},"
                    << "{\"name\":\"attack\",\"startFrame\":512,\"frames\":512},"
                    << "{\"name\":\"sustain\",\"startFrame\":1024,\"frames\":12288},"
                    << "{\"name\":\"release\",\"startFrame\":13312,\"frames\":512},"
                    << "{\"name\":\"tailSilence\",\"startFrame\":13824,\"frames\":1536}],\n"
                    << "      \"inputPcm\":{\"path\":\"inputs/pitch_" << layout.inputKey
                    << ".f32le\",\"frames\":" << kFrames << ",\"channels\":" << layout.channels
                    << ",\"encoding\":\"float32-le-interleaved\"},\n"
                    << "      \"declaredLatencySamples\":{\"input\":" << inputLatency
                    << ",\"output\":" << outputLatency << "},\n"
                    << "      \"latencyEvidence\":\"Signalsmith adapter inputLatencySamples()/outputLatencySamples() getters; first nonzero output is measured separately and is not substituted for the declared values\",\n"
                    << "      \"tolerance\":{\"maxAbsError\":0.001,\"rmsError\":0.0001,\"rejectNonFinite\":true,"
                    << "\"note\":\"initial Native/WASM compiler-portability bounds; promote only after the paired run reports actual errors\"},\n"
                    << "      \"events\":[],\n"
                    << "      \"setupPayloads\":[],\n"
                    << "      \"partitions\":{\"profileId\":\"" << profile.id << "\",\"callbackFrames\":";
                writeFloatArray(out, profile.callbackFrames);
                out << "},\n"
                    << "      \"nativeOutputPcm\":{\"path\":\"" << runPath << "\",\"frames\":"
                    << kFrames << ",\"channels\":" << layout.channels
                    << ",\"encoding\":\"float32-le-interleaved\"},\n"
                    << "      \"outputMetrics\":{\"rms\":" << metrics.rms
                    << ",\"peak\":" << metrics.peak
                    << ",\"firstNonzeroFrameAtThreshold1e-6\":" << metrics.firstNonzeroFrame
                    << "}\n"
                    << "    }"
                    << (++fixtureIndex == allMetrics.size() ? "\n" : ",\n");
            }
        }
    }
    out << "  ]\n}\n";
    return static_cast<bool>(out);
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: native_dsp_pcm_fixture_generator <output-directory>\n";
        return 2;
    }
    const std::filesystem::path outputRoot(argv[1]);
    std::error_code filesystemError;
    std::filesystem::create_directories(outputRoot / "inputs", filesystemError);
    if (filesystemError) {
        std::cerr << "failed to create input output directory: " << filesystemError.message() << '\n';
        return 1;
    }
    std::filesystem::create_directories(outputRoot / "pcm" / "native", filesystemError);
    if (filesystemError) {
        std::cerr << "failed to create PCM output directory: " << filesystemError.message() << '\n';
        return 1;
    }

    const auto mono = makeChannel(0U);
    const auto stereoRight = makeChannel(1U);
    std::vector<float> monoInterleaved = mono;
    std::vector<float> stereoInterleaved;
    stereoInterleaved.reserve(static_cast<std::size_t>(kFrames) * 2U);
    for (std::uint32_t frame = 0; frame < kFrames; ++frame) {
        stereoInterleaved.push_back(mono[frame]);
        stereoInterleaved.push_back(stereoRight[frame]);
    }
    if (!writePcm(outputRoot / "inputs" / "pitch_mono.f32le", monoInterleaved) ||
        !writePcm(outputRoot / "inputs" / "pitch_stereo.f32le", stereoInterleaved)) {
        std::cerr << "failed writing finite deterministic input PCM payloads\n";
        return 1;
    }

    const auto profiles = makeProfiles();
    if (profiles.size() != 5U) {
        std::cerr << "partition profile does not exactly cover the fixture frame count\n";
        return 1;
    }
    const std::vector<ChannelLayout> layouts{
        {PitchQualityMode::LiveMono, "LIVE_MONO", 1U, "mono"},
        {PitchQualityMode::LivePoly, "LIVE_POLY", 2U, "stereo"},
        {PitchQualityMode::HqRender, "HQ_RENDER", 1U, "mono"},
        {PitchQualityMode::HqRender, "HQ_RENDER", 2U, "stereo"},
    };
    const std::vector<float> ratios{0.5f, 0.75f, 1.0f, 1.25f, 2.0f};
    std::vector<RunMetrics> allMetrics(layouts.size() * ratios.size() * profiles.size());
    int commonInputLatency = -1;
    int commonOutputLatency = -1;
    std::size_t fixtureIndex = 0U;

    for (const auto& layout : layouts) {
        for (std::size_t ratioIndex = 0; ratioIndex < ratios.size(); ++ratioIndex) {
            const float ratio = ratios[ratioIndex];
            const std::uint32_t seed = kBaseEngineSeed +
                static_cast<std::uint32_t>(layout.mode) * 31U +
                static_cast<std::uint32_t>(layout.channels) * 7U +
                static_cast<std::uint32_t>(ratioIndex);
            const std::string fixtureId = std::string("pitch_signalsmith_") +
                layout.modeName + "_" + layout.inputKey + "_ratio_" + ratioId(ratio);
            for (const auto& profile : profiles) {
                const auto path = outputRoot / "pcm" / "native" /
                                  (fixtureId + "_" + profile.id + ".f32le");
                int inputLatency = 0;
                int outputLatency = 0;
                RunMetrics metrics{};
                if (!processOneRun(path, mono, stereoRight, layout.channels, layout.mode,
                                   profile, ratio, seed, inputLatency, outputLatency, metrics)) {
                    std::cerr << "failed Signalsmith fixture " << fixtureId
                              << " partition " << profile.id << '\n';
                    return 1;
                }
                if (commonInputLatency < 0) {
                    commonInputLatency = inputLatency;
                    commonOutputLatency = outputLatency;
                } else if (inputLatency != commonInputLatency || outputLatency != commonOutputLatency) {
                    std::cerr << "reported latency varied across fixture configuration\n";
                    return 1;
                }
                allMetrics[fixtureIndex++] = metrics;
            }
        }
    }
    if (fixtureIndex != allMetrics.size()) {
        std::cerr << "generated fixture count did not match the manifest matrix\n";
        return 1;
    }

    if (!writeDraftManifest(outputRoot / "manifest.draft.json", profiles, layouts, ratios,
                            static_cast<std::uint32_t>(std::max(0, commonInputLatency)),
                            static_cast<std::uint32_t>(std::max(0, commonOutputLatency)),
                            allMetrics)) {
        std::cerr << "failed writing fixture manifest draft\n";
        return 1;
    }
    std::cout << "Generated 100 long Signalsmith fixture/run records across 5 partition profiles; "
              << kFrames << " frames at 48 kHz. No hardware stream opened.\n";
    return 0;
}
