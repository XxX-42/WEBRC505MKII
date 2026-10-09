#include "webrc/dsp/pitch.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <utility>
#include <vector>

namespace {
using namespace webrc::dsp;
constexpr float kSampleRate = 48000.0f;
constexpr std::uint32_t kFrames = 15360U;
constexpr std::uint32_t kProcessMaximumBlock = 512U;
constexpr std::uint32_t kMaximumPitchPeriod = 400U;
constexpr float kSourceFrequency = 220.37f;
constexpr std::array<float, 6U> kRatios{{0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f}};

struct Profile {
    const char* id;
    std::vector<std::uint32_t> blocks;
};

bool loadMono(const std::filesystem::path& path, std::vector<float>& output) {
    std::ifstream input(path, std::ios::binary | std::ios::ate);
    if (!input) return false;
    const auto end = input.tellg();
    if (end != static_cast<std::streamoff>(kFrames * sizeof(float))) return false;
    input.seekg(0, std::ios::beg);
    output.resize(kFrames);
    for (auto& sample : output) {
        std::array<unsigned char, 4U> bytes{};
        input.read(reinterpret_cast<char*>(bytes.data()), 4);
        if (!input) return false;
        const std::uint32_t bits = static_cast<std::uint32_t>(bytes[0]) |
            (static_cast<std::uint32_t>(bytes[1]) << 8U) |
            (static_cast<std::uint32_t>(bytes[2]) << 16U) |
            (static_cast<std::uint32_t>(bytes[3]) << 24U);
        std::memcpy(&sample, &bits, sizeof(sample));
        if (!std::isfinite(sample)) return false;
    }
    return true;
}

bool writeFloat32(const std::filesystem::path& path, const std::vector<float>& values) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) return false;
    for (const float sample : values) {
        if (!std::isfinite(sample)) return false;
        std::uint32_t bits = 0U;
        std::memcpy(&bits, &sample, sizeof(bits));
        const std::array<unsigned char, 4U> bytes{{
            static_cast<unsigned char>(bits),
            static_cast<unsigned char>(bits >> 8U),
            static_cast<unsigned char>(bits >> 16U),
            static_cast<unsigned char>(bits >> 24U),
        }};
        output.write(reinterpret_cast<const char*>(bytes.data()), 4);
    }
    return static_cast<bool>(output);
}

std::vector<Profile> makeProfiles() {
    std::vector<Profile> profiles;
    for (const auto frames : {64U, 128U, 256U, 512U}) {
        Profile profile{};
        profile.id = frames == 64U ? "uniform_64" : frames == 128U ? "uniform_128" :
                     frames == 256U ? "uniform_256" : "uniform_512";
        for (std::uint32_t offset = 0U; offset < kFrames; offset += frames)
            profile.blocks.push_back(frames);
        profiles.push_back(std::move(profile));
    }
    Profile mixed{};
    mixed.id = "mixed_64_128_256_512";
    constexpr std::array<std::uint32_t, 4U> schedule{{64U,128U,256U,512U}};
    std::uint32_t total = 0U;
    std::size_t index = 0U;
    while (total < kFrames) {
        const auto frames = schedule[index++ % schedule.size()];
        if (total + frames > kFrames) return {};
        mixed.blocks.push_back(frames);
        total += frames;
    }
    profiles.push_back(std::move(mixed));
    return profiles;
}

bool renderOffline(const std::filesystem::path& outputRoot, const std::vector<float>& input,
                   float ratio, std::size_t ratioIndex) {
    TdPsolaPitchShifter shifter{};
    const ProcessSpec spec{kSampleRate, kProcessMaximumBlock, 1U};
    if (!shifter.prepare(spec, kFrames, kMaximumPitchPeriod)) return false;
    std::vector<float> output(kFrames, 0.0f);
    if (!shifter.processBuffer(input.data(), output.data(), kFrames,
                               kSampleRate / kSourceFrequency, ratio)) return false;
    const auto filename = "psola_buffer_r" + std::to_string(ratioIndex) + ".f32le";
    return writeFloat32(outputRoot / filename, output);
}

bool renderStreaming(const std::filesystem::path& outputRoot, const std::vector<float>& input,
                     float ratio, std::size_t ratioIndex, const Profile& profile) {
    StreamingTdPsolaPitchShifter shifter{};
    const ProcessSpec spec{kSampleRate, kProcessMaximumBlock, 1U};
    if (!shifter.prepare(spec, kMaximumPitchPeriod) ||
        !shifter.setPitch(kSampleRate / kSourceFrequency, ratio, true)) return false;

    std::vector<float> output(kFrames, 0.0f);
    std::uint32_t offset = 0U;
    for (const auto frames : profile.blocks) {
        if (!shifter.processBlock(input.data() + offset, output.data() + offset, frames)) return false;
        offset += frames;
    }
    if (offset != kFrames) return false;
    const auto filename = "stream_psola_r" + std::to_string(ratioIndex) + "_" +
                          profile.id + ".f32le";
    return writeFloat32(outputRoot / filename, output);
}

void writeArray(std::ostream& stream, const std::vector<std::uint32_t>& values) {
    stream << '[';
    for (std::size_t i = 0U; i < values.size(); ++i) {
        if (i != 0U) stream << ',';
        stream << values[i];
    }
    stream << ']';
}

void writeRef(std::ostream& stream, const std::string& path, const char* encoding = "float32-le-interleaved") {
    stream << "{\"path\":\"" << path << "\",\"frames\":" << kFrames
           << ",\"channels\":1,\"encoding\":\"" << encoding << "\"}";
}

void writeFixture(std::ostream& out, const std::string& id, const char* module,
                  const char* operation, std::uint32_t kind, float ratio,
                  const Profile& profile, const std::string& outputPath,
                  bool offline, std::uint32_t latency) {
    const float sourcePeriod = kSampleRate / kSourceFrequency;
    out << "{\"fixtureId\":\"" << id << "\",\"module\":\"" << module
        << "\",\"operation\":\"" << operation << "\",\"wasmKindId\":" << kind
        << ",\"catalogFormulaId\":\"F11\",\"sampleRateHz\":48000,\"channels\":1"
        << ",\"maxBlockFrames\":" << kProcessMaximumBlock << ",\"frames\":" << kFrames
        << ",\"inputRecipeSeed\":1660099229,\"settings\":{\"maximumPitchPeriodSamples\":"
        << kMaximumPitchPeriod << ",\"sourcePeriodSamples\":" << std::setprecision(9)
        << sourcePeriod << ",\"pitchRatio\":" << ratio << ",\"voiced\":true";
    if (offline) {
        out << ",\"maxBufferFrames\":" << kFrames;
    } else {
        out << ",\"controls\":[{\"controlId\":9,\"values\":[" << sourcePeriod
            << ',' << ratio << ",1]}]";
    }
    out << "},\"eventFrameUnit\":\"sample-frame\",\"events\":[]"
        << ",\"resetPolicy\":\"fresh Native state per fixture; deterministic initialized state\""
        << ",\"processingScope\":\"" << (offline ? "whole-buffer-offline" : "streaming-blocks") << "\""
        << ",\"declaredLatencySamples\":";
    if (offline) out << "null";
    else out << "{\"input\":0,\"output\":" << latency << '}';
    out << ",\"latencyEvidence\":\"";
    if (offline) out << "offline whole-buffer renderer; no streaming latency is claimed";
    else out << "source getter latencySamples() = 3 * maximumPitchPeriodSamples; excludes detector observation and end-to-end route latency";
    out << "\",\"inputPcm\":";
    writeRef(out, "inputs/pitch_mono.f32le");
    out << ",\"setupPayloads\":[],\"partitions\":{\"profileId\":\"" << profile.id << '\"';
    if (offline) {
        out << ",\"processCallFrames\":" << kFrames;
    } else {
        out << ",\"callbackFrames\":";
        writeArray(out, profile.blocks);
    }
    out << "},\"nativeOutputPcm\":";
    writeRef(out, outputPath);
    out << ",\"tolerance\":{\"maxAbsError\":0.001,\"rmsError\":0.0001,\"rejectNonFinite\":true}}";
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "usage: native_streaming_psola_ratio_fixture <input-mono-f32le> <output-directory>\n";
        return 2;
    }
    const std::filesystem::path inputPath(argv[1]);
    const std::filesystem::path outputRoot(argv[2]);
    const auto pcmRoot = outputRoot / "pcm" / "native";
    std::error_code ec;
    std::filesystem::create_directories(pcmRoot, ec);
    if (ec) return 1;

    std::vector<float> input;
    if (!loadMono(inputPath, input)) {
        std::cerr << "failed to load exact 15360-frame finite mono input\n";
        return 1;
    }
    const auto profiles = makeProfiles();
    if (profiles.size() != 5U) return 1;
    std::size_t outputCount = 0U;
    for (std::size_t ratioIndex = 0U; ratioIndex < kRatios.size(); ++ratioIndex) {
        if (!renderOffline(pcmRoot, input, kRatios[ratioIndex], ratioIndex)) return 1;
        ++outputCount;
        for (const auto& profile : profiles) {
            if (!renderStreaming(pcmRoot, input, kRatios[ratioIndex], ratioIndex, profile)) return 1;
            ++outputCount;
        }
    }

    std::ofstream draft(outputRoot / "manifest.draft.json", std::ios::binary | std::ios::trunc);
    if (!draft) return 1;
    draft << "{\n  \"schemaVersion\":3,\n  \"producer\":\"native_streaming_psola_ratio_fixture\",\n"
          << "  \"purpose\":\"Fresh Native output vectors for offline TD-PSOLA and streaming TD-PSOLA ratio coverage after the ratio-domain resampling correction; this is numerical parity evidence, not F0 detection, formant-preservation, broadband quality, realtime deadline, or hardware acceptance.\",\n"
          << "  \"sampleRateHz\":48000,\n  \"pcmFramesPerFixture\":" << kFrames
          << ",\n  \"fixtureCount\":" << outputCount << ",\n"
          << "  \"partitionProfiles\":[";
    for (std::size_t i = 0U; i < profiles.size(); ++i) {
        if (i != 0U) draft << ',';
        draft << "{\"id\":\"" << profiles[i].id << "\",\"callbackFrames\":";
        writeArray(draft, profiles[i].blocks);
        draft << '}';
    }
    draft << ",{\"id\":\"whole_buffer_offline\",\"processCallFrames\":15360}],\n  \"fixtures\":[\n";

    bool first = true;
    for (std::size_t ratioIndex = 0U; ratioIndex < kRatios.size(); ++ratioIndex) {
        Profile whole{"whole_buffer", {kFrames}};
        if (!first) draft << ",\n";
        first = false;
        writeFixture(draft, "psola_buffer_r" + std::to_string(ratioIndex),
                     "TdPsolaPitchShifter", "psola-buffer", 109U,
                     kRatios[ratioIndex], whole,
                     "pcm/native/psola_buffer_r" + std::to_string(ratioIndex) + ".f32le",
                     true, 0U);
        for (const auto& profile : profiles) {
            draft << ",\n";
            writeFixture(draft, "stream_psola_r" + std::to_string(ratioIndex) + "_" + profile.id,
                         "StreamingTdPsolaPitchShifter", "streaming-psola", 110U,
                         kRatios[ratioIndex], profile,
                         "pcm/native/stream_psola_r" + std::to_string(ratioIndex) + "_" +
                             profile.id + ".f32le",
                         false, 3U * kMaximumPitchPeriod);
        }
    }
    draft << "\n  ]\n}\n";
    if (!draft) return 1;
    std::cout << "Generated " << outputCount
              << " Native PSOLA fixtures from the supplied unchanged 15360-frame mono input.\n";
    return 0;
}
