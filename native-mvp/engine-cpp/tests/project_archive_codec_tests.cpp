#include "project_archive_codec.hpp"

#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using webrc::native::DecodedProjectArchive;
using webrc::native::ProjectArchiveDecodeResult;
using webrc::native::ProjectArchiveTrackData;

constexpr char kTrackOneSha[] = "dee9bee38d8ce139ee23552fc0ca83067114ae903518d7711ba7937b72c0d697";
constexpr char kTrackTwoSha[] = "05f4c29cfe26cefe4c9fb380b148349ac8dc2d66d808a6d32aef642fe63dfcca";
constexpr char kTrackOneInfinitySha[] = "f97a51b7b452736b7c873fcd7ab03375c62d8d4c1f1b713f6433b3ec192c8fff";

const std::vector<std::uint8_t>& samplePayload() {
    static const std::vector<std::uint8_t> payload{
        0x00U, 0x00U, 0x80U, 0x3FU, // Track 1 mono frame 1: +1
        0x00U, 0x00U, 0x80U, 0xBFU, // Track 1 mono frame 2: -1
        0x00U, 0x00U, 0x00U, 0x3FU, // Track 2 stereo frame 1 left: +0.5
        0x00U, 0x00U, 0x00U, 0xBFU, // Track 2 stereo frame 1 right: -0.5
        0x00U, 0x00U, 0x00U, 0x00U, // Track 2 stereo frame 2 left: 0
        0x00U, 0x00U, 0x80U, 0x3FU, // Track 2 stereo frame 2 right: +1
    };
    return payload;
}

std::string validManifest() {
    return std::string("{\"format\":\"rc505-project-archive\",\"version\":1,\"project\":{") +
        "\"name\":\"Loop \\u266b\",\"bpm\":120,\"transport\":{" +
        "\"masterTrackId\":2,\"measureLengthSeconds\":2,\"masterLoopLengthSamples\":2," +
        "\"timeSignatureNumerator\":4,\"timeSignatureDenominator\":4}},\"tracks\":[" +
        "{\"sampleRate\":48000,\"frameCount\":2,\"channels\":1,\"payloadOffset\":0," +
        "\"byteLength\":8,\"sha256\":\"" + kTrackOneSha + "\"}," +
        "{\"sampleRate\":44100,\"frameCount\":2,\"channels\":2,\"payloadOffset\":8," +
        "\"byteLength\":16,\"sha256\":\"" + kTrackTwoSha + "\"},null,null,null]}";
}

void setU32Le(std::vector<std::uint8_t>& bytes, std::size_t offset, std::uint32_t value) {
    bytes[offset] = static_cast<std::uint8_t>(value);
    bytes[offset + 1U] = static_cast<std::uint8_t>(value >> 8U);
    bytes[offset + 2U] = static_cast<std::uint8_t>(value >> 16U);
    bytes[offset + 3U] = static_cast<std::uint8_t>(value >> 24U);
}

std::vector<std::uint8_t> buildArchive(const std::string& manifest, const std::vector<std::uint8_t>& payload) {
    static constexpr std::uint8_t magic[]{0x52U, 0x43U, 0x35U, 0x30U, 0x35U, 0x50U, 0x41U, 0x00U};
    std::vector<std::uint8_t> archive(12U + manifest.size() + payload.size());
    for (std::size_t index = 0U; index < sizeof(magic); ++index) archive[index] = magic[index];
    setU32Le(archive, 8U, static_cast<std::uint32_t>(manifest.size()));
    for (std::size_t index = 0U; index < manifest.size(); ++index) {
        archive[12U + index] = static_cast<std::uint8_t>(manifest[index]);
    }
    for (std::size_t index = 0U; index < payload.size(); ++index) {
        archive[12U + manifest.size() + index] = payload[index];
    }
    return archive;
}

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

void requireRejected(const std::vector<std::uint8_t>& archive, const std::string& label) {
    const ProjectArchiveDecodeResult decoded = webrc::native::decodeProjectArchive(archive);
    require(!decoded.project.has_value(), label + " should be rejected");
    require(!decoded.error.empty(), label + " should provide an error");
}

std::string replaceOnce(std::string value, const std::string& from, const std::string& to) {
    const std::size_t position = value.find(from);
    require(position != std::string::npos, "test fixture replacement source not found: " + from);
    value.replace(position, from.size(), to);
    return value;
}

void testDecodeMonoStereoAndTransport() {
    const auto archive = buildArchive(validManifest(), samplePayload());
    const auto result = webrc::native::decodeProjectArchive(archive);
    require(result.project.has_value(), "valid v1 archive rejected: " + result.error);
    const DecodedProjectArchive& project = *result.project;
    require(project.version == 1U, "decoded archive version mismatch");
    require(project.name == "Loop \xE2\x99\xAB", "UTF-8 project name was not preserved");
    require(project.bpm == 120.0, "BPM mismatch");
    require(project.transport.masterTrackId == 2U, "master track ID mismatch");
    require(project.transport.measureLengthSeconds == 2.0, "measure length mismatch");
    require(project.transport.masterLoopLengthSamples == 2U, "master sample count mismatch");
    require(project.transport.timeSignatureNumerator == 4U && project.transport.timeSignatureDenominator == 4U,
        "time signature mismatch");
    require(project.payloadByteLength == 24U, "aggregate payload size mismatch");
    require(project.tracks[0].has_value() && project.tracks[1].has_value(), "expected mono and stereo tracks");
    require(!project.tracks[2] && !project.tracks[3] && !project.tracks[4], "null tracks were not preserved");
    const auto& mono = *project.tracks[0];
    require(mono.sampleRate == 48000U && mono.frameCount == 2U && mono.channels == 1U, "mono metadata mismatch");
    require(!mono.originalTempoBpm.has_value(), "v1 track tempo must decode as unknown");
    require(mono.pcm.size() == 2U && mono.pcm[0] == 1.0F && mono.pcm[1] == -1.0F, "mono PCM mismatch");
    const auto& stereo = *project.tracks[1];
    require(stereo.sampleRate == 44100U && stereo.frameCount == 2U && stereo.channels == 2U, "stereo metadata mismatch");
    require(stereo.pcm.size() == 4U && stereo.pcm[0] == 0.5F && stereo.pcm[1] == -0.5F &&
        stereo.pcm[2] == 0.0F && stereo.pcm[3] == 1.0F, "interleaved stereo PCM mismatch");
}

void testV2TempoMetadataAndStrictV1Schema() {
    std::string v2 = replaceOnce(validManifest(), "\"version\":1", "\"version\":2");
    v2 = replaceOnce(v2, "\"channels\":1,", "\"channels\":1,\"originalTempoBpm\":96.5,");
    v2 = replaceOnce(v2, "\"channels\":2,", "\"channels\":2,\"originalTempoBpm\":null,");
    const auto decoded = webrc::native::decodeProjectArchive(buildArchive(v2, samplePayload()));
    require(decoded.project.has_value(), "valid v2 archive rejected: " + decoded.error);
    require(decoded.project->version == 2U, "v2 archive version mismatch");
    require(decoded.project->tracks[0]->originalTempoBpm == 96.5, "v2 original tempo mismatch");
    require(!decoded.project->tracks[1]->originalTempoBpm.has_value(), "v2 null tempo was not preserved as unknown");

    const std::string v1WithNewField = replaceOnce(validManifest(), "\"channels\":1,", "\"channels\":1,\"originalTempoBpm\":null,");
    requireRejected(buildArchive(v1WithNewField, samplePayload()), "v1 track with v2 metadata field");

    const std::string missingV2Field = replaceOnce(v2, "\"originalTempoBpm\":96.5,", "");
    requireRejected(buildArchive(missingV2Field, samplePayload()), "v2 track missing nullable tempo field");

    const std::string badV2Tempo = replaceOnce(v2, "\"originalTempoBpm\":96.5", "\"originalTempoBpm\":301");
    requireRejected(buildArchive(badV2Tempo, samplePayload()), "v2 original tempo out of range");
}

void testV2EncodeDecodeRoundTrip() {
    DecodedProjectArchive source;
    source.name = "Native codec v2";
    source.bpm = 120.0;
    ProjectArchiveTrackData track;
    track.sampleRate = 48000U;
    track.frameCount = 3U;
    track.channels = 2U;
    track.originalTempoBpm = 87.25;
    track.pcm = {1.0F, -1.0F, 0.5F, -0.5F, 0.0F, 0.25F};
    source.tracks[0] = track;
    source.tracks[1] = track;
    source.tracks[1]->originalTempoBpm.reset();

    const auto encoded = webrc::native::encodeProjectArchive(source, {2U});
    const auto decoded = webrc::native::decodeProjectArchive(encoded);
    require(decoded.project.has_value(), "C++ v2 encoder output was rejected: " + decoded.error);
    require(decoded.project->version == 2U, "C++ encoder did not emit v2");
    require(decoded.project->tracks[0]->originalTempoBpm == 87.25, "C++ encoder lost known original tempo");
    require(!decoded.project->tracks[1]->originalTempoBpm.has_value(), "C++ encoder lost null original tempo");
    require(decoded.project->tracks[0]->pcm == track.pcm, "C++ encoder changed Float32 PCM");
}

void testDefaultV1ExportAndKnownTempoRejection() {
    DecodedProjectArchive source;
    require(source.version == 1U, "default project archive struct version changed from v1");
    source.name = "Legacy default";
    source.bpm = 120.0;
    ProjectArchiveTrackData track;
    track.sampleRate = 48000U;
    track.frameCount = 2U;
    track.channels = 1U;
    track.pcm = {0.25F, -0.25F};
    source.tracks[0] = track;

    const auto encoded = webrc::native::encodeProjectArchive(source);
    const auto manifestLength = static_cast<std::size_t>(encoded[8U])
        | (static_cast<std::size_t>(encoded[9U]) << 8U)
        | (static_cast<std::size_t>(encoded[10U]) << 16U)
        | (static_cast<std::size_t>(encoded[11U]) << 24U);
    const std::string manifest(encoded.begin() + 12, encoded.begin() + static_cast<std::ptrdiff_t>(12U + manifestLength));
    require(manifest.find("\"version\":1") != std::string::npos, "default C++ exporter changed from v1");
    require(manifest.find("originalTempoBpm") == std::string::npos, "default v1 export changed its exact track schema");
    const auto decoded = webrc::native::decodeProjectArchive(encoded);
    require(decoded.project.has_value() && decoded.project->version == 1U, "default v1 C++ archive did not round-trip");
    require(!decoded.project->tracks[0]->originalTempoBpm, "default v1 export must represent source tempo as unknown");

    source.tracks[0]->originalTempoBpm = 96.0;
    bool rejected = false;
    try {
        (void)webrc::native::encodeProjectArchive(source);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    require(rejected, "known tempo must not be silently discarded by default v1 export");
}

void testOptionalTransportDefaultsAndBom() {
    const std::string manifest =
        std::string("{\"format\":\"rc505-project-archive\",\"version\":1,\"project\":{\"name\":\"No loops\",\"bpm\":90},") +
        "\"tracks\":[null,null,null,null,null]}";
    const auto ordinary = webrc::native::decodeProjectArchive(buildArchive(manifest, {}));
    require(ordinary.project.has_value(), "valid archive without optional transport rejected: " + ordinary.error);
    require(!ordinary.project->transport.masterTrackId && ordinary.project->transport.measureLengthSeconds == 0.0 &&
        ordinary.project->transport.masterLoopLengthSamples == 0U &&
        ordinary.project->transport.timeSignatureNumerator == 4U && ordinary.project->transport.timeSignatureDenominator == 4U,
        "omitted transport defaults were not normalized");

    const std::string withBom = std::string("\xEF\xBB\xBF", 3U) + manifest;
    const auto bomResult = webrc::native::decodeProjectArchive(buildArchive(withBom, {}));
    require(bomResult.project.has_value(), "UTF-8 BOM should match TextDecoder default behavior");

    const std::string loneSurrogateName = replaceOnce(manifest, "No loops", "\\ud800");
    const auto surrogateResult = webrc::native::decodeProjectArchive(buildArchive(loneSurrogateName, {}));
    require(surrogateResult.project.has_value(), "JSON lone surrogate name should follow TextEncoder replacement behavior");
    require(surrogateResult.project->name == "\xEF\xBF\xBD", "lone surrogate was not encoded as U+FFFD");

    const std::string escapedBackslashName = replaceOnce(manifest, "No loops", R"(No \\uD800)");
    const auto escapedBackslashResult = webrc::native::decodeProjectArchive(buildArchive(escapedBackslashName, {}));
    require(escapedBackslashResult.project.has_value(), "escaped backslash before a surrogate-looking sequence was rejected");
    require(escapedBackslashResult.project->name == R"(No \uD800)",
        "surrogate normalization changed a literal backslash escape sequence");

    const std::string pairedSurrogateName = replaceOnce(manifest, "No loops", R"(\ud83d\ude03)");
    const auto pairedSurrogateResult = webrc::native::decodeProjectArchive(buildArchive(pairedSurrogateName, {}));
    require(pairedSurrogateResult.project.has_value(), "paired JSON surrogate escapes were rejected");
    require(pairedSurrogateResult.project->name == "\xF0\x9F\x98\x83", "paired surrogate escapes were not preserved as UTF-8");
}

void testJsonDepthLimit() {
    const std::string tooDeep = std::string("{\"x\":") + std::string(33U, '[') + "0" + std::string(33U, ']') + "}";
    requireRejected(buildArchive(tooDeep, {}), "manifest JSON nesting over depth limit");
}

void testHeaderManifestAndJsonRejections() {
    const auto valid = buildArchive(validManifest(), samplePayload());
    std::vector<std::uint8_t> shortHeader(11U, 0U);
    requireRejected(shortHeader, "short header");

    auto badMagic = valid;
    badMagic[0] ^= 0xFFU;
    requireRejected(badMagic, "bad magic");

    auto unsupportedVersion = buildArchive(replaceOnce(validManifest(), "\"version\":1", "\"version\":3"), samplePayload());
    requireRejected(unsupportedVersion, "unsupported version");

    auto unknownRoot = buildArchive(replaceOnce(validManifest(), "\"tracks\":[", "\"other\":true,\"tracks\":["), samplePayload());
    requireRejected(unknownRoot, "unknown top-level field");

    auto unknownTrack = buildArchive(replaceOnce(validManifest(), "\"byteLength\":8", "\"byteLength\":8,\"extra\":1"), samplePayload());
    requireRejected(unknownTrack, "unknown track field");

    auto duplicateRoot = buildArchive(replaceOnce(validManifest(), "\"version\":1", "\"version\":1,\"version\":1"), samplePayload());
    requireRejected(duplicateRoot, "duplicate root key");

    auto duplicateEscapedKey = buildArchive(replaceOnce(validManifest(), "\"frameCount\":2", "\"frameCount\":2,\"frame\\u0043ount\":2"), samplePayload());
    requireRejected(duplicateEscapedKey, "duplicate escaped nested key");

    auto invalidUtf8 = validManifest();
    const std::size_t nameByte = invalidUtf8.find("Loop");
    require(nameByte != std::string::npos, "UTF-8 fixture name not found");
    invalidUtf8[nameByte] = static_cast<char>(0xFF);
    requireRejected(buildArchive(invalidUtf8, samplePayload()), "invalid UTF-8");

    auto emptyManifestLength = valid;
    setU32Le(emptyManifestLength, 8U, 0U);
    requireRejected(emptyManifestLength, "empty manifest length");

    auto truncatedManifest = valid;
    setU32Le(truncatedManifest, 8U, 1000U);
    requireRejected(truncatedManifest, "truncated manifest");

    std::vector<std::uint8_t> oversizedManifest(12U + 65537U, 0U);
    static constexpr std::uint8_t magic[]{0x52U, 0x43U, 0x35U, 0x30U, 0x35U, 0x50U, 0x41U, 0x00U};
    for (std::size_t index = 0U; index < sizeof(magic); ++index) oversizedManifest[index] = magic[index];
    setU32Le(oversizedManifest, 8U, 65537U);
    requireRejected(oversizedManifest, "manifest over size bound");

    // The archive-size guard must run before attempting to read the supplied
    // bytes, so a tiny sentinel is safe with a synthetic over-limit length.
    const std::uint8_t sentinel = 0U;
    const auto oversizedArchive = webrc::native::decodeProjectArchive(
        &sentinel, static_cast<std::size_t>(webrc::native::kProjectArchiveMaxBytes + 1U));
    require(!oversizedArchive.project.has_value(), "archive over total size limit should be rejected");
}

void testMetadataAndTransportRejections() {
    const auto payload = samplePayload();
    auto invalid = [&](const std::string& source, const std::string& target, const std::string& label) {
        requireRejected(buildArchive(replaceOnce(validManifest(), source, target), payload), label);
    };
    invalid("\"bpm\":120", "\"bpm\":301", "BPM out of range");
    invalid("\"bpm\":120", "\"bpm\":true", "boolean BPM");
    invalid("\"frameCount\":2", "\"frameCount\":2.5", "fractional frame count");
    invalid("\"frameCount\":2", "\"frameCount\":9007199254740992", "unsafe frame count");
    invalid("\"sampleRate\":48000", "\"sampleRate\":7999", "sample rate below range");
    invalid("\"channels\":1", "\"channels\":3", "unsupported channel count");
    invalid("\"payloadOffset\":8", "\"payloadOffset\":9", "noncontiguous PCM offset");
    invalid("\"byteLength\":16", "\"byteLength\":12", "inconsistent PCM length");
    invalid("\"sha256\":\"" + std::string(kTrackOneSha) + "\"", "\"sha256\":\"ABC\"", "malformed digest");
    invalid("\"masterTrackId\":2", "\"masterTrackId\":3", "master points to empty track");
    invalid("\"masterLoopLengthSamples\":2", "\"masterLoopLengthSamples\":1", "master sample length mismatch");
    invalid("\"measureLengthSeconds\":2", "\"measureLengthSeconds\":3", "measure timing mismatch");
    invalid("\"timeSignatureDenominator\":4", "\"timeSignatureDenominator\":3", "unsupported time denominator");
    invalid("\"timeSignatureNumerator\":4", "\"timeSignatureNumerator\":33", "time numerator out of range");
    invalid("\"timeSignatureNumerator\":4,\"timeSignatureDenominator\":4", "\"timeSignatureNumerator\":4,\"timeSignatureDenominator\":4,\"extra\":0", "unknown transport field");

    const auto tooLongName = replaceOnce(validManifest(), "Loop \\u266b", std::string(513U, 'n'));
    requireRejected(buildArchive(tooLongName, payload), "project name over UTF-8 byte limit");
}

void testPcmHashPayloadAndFiniteChecks() {
    const auto valid = buildArchive(validManifest(), samplePayload());
    auto badHash = valid;
    badHash.back() ^= 1U;
    requireRejected(badHash, "PCM hash mismatch");

    auto trailing = buildArchive(validManifest(), samplePayload());
    trailing.push_back(0U);
    requireRejected(trailing, "trailing payload byte");

    auto truncated = buildArchive(validManifest(), std::vector<std::uint8_t>(samplePayload().begin(), samplePayload().end() - 1));
    requireRejected(truncated, "truncated payload");

    std::string infiniteManifest = replaceOnce(validManifest(), kTrackOneSha, kTrackOneInfinitySha);
    auto infinitePayload = samplePayload();
    infinitePayload[0] = 0x00U;
    infinitePayload[1] = 0x00U;
    infinitePayload[2] = 0x80U;
    infinitePayload[3] = 0x7FU;
    requireRejected(buildArchive(infiniteManifest, infinitePayload), "non-finite float32 sample with valid hash");
}

void testFuzzStyleInputsDoNotEscapeDecoder() {
    std::uint32_t state = 0x8F31A6C5U;
    for (std::size_t iteration = 0U; iteration < 512U; ++iteration) {
        state ^= state << 13U;
        state ^= state >> 17U;
        state ^= state << 5U;
        const std::size_t length = iteration % 160U;
        std::vector<std::uint8_t> bytes(length);
        for (auto& byte : bytes) {
            state ^= state << 13U;
            state ^= state >> 17U;
            state ^= state << 5U;
            byte = static_cast<std::uint8_t>(state >> 24U);
        }
        (void)webrc::native::decodeProjectArchive(bytes);
    }

    // Mutate each manifest byte in turn. Some mutations may remain valid JSON,
    // but none may escape the validator or read beyond the supplied archive.
    const auto valid = buildArchive(validManifest(), samplePayload());
    for (std::size_t index = 12U; index < valid.size() - samplePayload().size(); ++index) {
        auto mutated = valid;
        mutated[index] ^= static_cast<std::uint8_t>(index * 37U + 1U);
        (void)webrc::native::decodeProjectArchive(mutated);
    }
}

} // namespace

int main() {
    try {
        testDecodeMonoStereoAndTransport();
        testV2TempoMetadataAndStrictV1Schema();
        testV2EncodeDecodeRoundTrip();
        testDefaultV1ExportAndKnownTempoRejection();
        testOptionalTransportDefaultsAndBom();
        testJsonDepthLimit();
        testHeaderManifestAndJsonRejections();
        testMetadataAndTransportRejections();
        testPcmHashPayloadAndFiniteChecks();
        testFuzzStyleInputsDoNotEscapeDecoder();
        std::cout << "Project archive codec tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "Project archive codec test failed: " << error.what() << '\n';
        return 1;
    }
}
