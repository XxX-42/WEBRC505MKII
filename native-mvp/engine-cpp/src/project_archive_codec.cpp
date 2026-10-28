#include "project_archive_codec.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

namespace webrc::native {
namespace {

using Json = nlohmann::json;

constexpr std::array<std::uint8_t, 8U> kMagic{{
    0x52U, 0x43U, 0x35U, 0x30U, 0x35U, 0x50U, 0x41U, 0x00U,
}};
constexpr std::uint64_t kMaxSafeInteger = 9007199254740991ULL;
constexpr std::uint32_t kMinSampleRate = 8000U;
constexpr std::uint32_t kMaxSampleRate = 384000U;
constexpr double kMinBpm = 40.0;
constexpr double kMaxBpm = 300.0;
constexpr int kMaximumJsonDepth = 32;

class CodecError final : public std::runtime_error {
public:
    explicit CodecError(const char* message) : std::runtime_error(message) {}
    explicit CodecError(const std::string& message) : std::runtime_error(message) {}
};

[[noreturn]] void fail(const char* message) {
    throw CodecError(message);
}

bool isContinuationByte(std::uint8_t value) noexcept {
    return (value & 0xC0U) == 0x80U;
}

bool decodeUtf8CodePoint(const std::uint8_t* bytes, std::size_t length, std::size_t& offset) noexcept {
    if (offset >= length) return false;
    const std::uint8_t first = bytes[offset];
    if (first <= 0x7FU) {
        ++offset;
        return true;
    }
    if (first >= 0xC2U && first <= 0xDFU) {
        if (length - offset < 2U || !isContinuationByte(bytes[offset + 1U])) return false;
        offset += 2U;
        return true;
    }
    if (first >= 0xE0U && first <= 0xEFU) {
        if (length - offset < 3U || !isContinuationByte(bytes[offset + 1U]) || !isContinuationByte(bytes[offset + 2U])) return false;
        const std::uint8_t second = bytes[offset + 1U];
        if ((first == 0xE0U && second < 0xA0U) || (first == 0xEDU && second >= 0xA0U)) return false;
        offset += 3U;
        return true;
    }
    if (first >= 0xF0U && first <= 0xF4U) {
        if (length - offset < 4U || !isContinuationByte(bytes[offset + 1U]) ||
            !isContinuationByte(bytes[offset + 2U]) || !isContinuationByte(bytes[offset + 3U])) return false;
        const std::uint8_t second = bytes[offset + 1U];
        if ((first == 0xF0U && second < 0x90U) || (first == 0xF4U && second > 0x8FU)) return false;
        offset += 4U;
        return true;
    }
    return false;
}

bool isStrictUtf8(const std::uint8_t* bytes, std::size_t length) noexcept {
    std::size_t offset = 0U;
    while (offset < length) {
        if (!decodeUtf8CodePoint(bytes, length, offset)) return false;
    }
    return true;
}

int hexDigit(char value) noexcept {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

bool readEscapedCodeUnit(std::string_view input, std::size_t escapeOffset, std::uint16_t& result) noexcept {
    // `escapeOffset` points to the backslash in a \uXXXX sequence.
    if (escapeOffset > input.size() || input.size() - escapeOffset < 6U ||
        input[escapeOffset] != '\\' || input[escapeOffset + 1U] != 'u') return false;
    result = 0U;
    for (std::size_t index = 0U; index < 4U; ++index) {
        const int digit = hexDigit(input[escapeOffset + 2U + index]);
        if (digit < 0) return false;
        result = static_cast<std::uint16_t>((result << 4U) | static_cast<std::uint16_t>(digit));
    }
    return true;
}

/**
 * JavaScript JSON.parse can produce lone UTF-16 surrogates and TextEncoder
 * replaces them with U+FFFD. Normalize only those escape sequences before
 * handing the full JSON grammar to nlohmann; syntax and structure are never
 * parsed here. This keeps v1 browser interoperability while nlohmann remains
 * the sole JSON parser.
 */
std::string normalizeUnpairedSurrogateEscapes(std::string_view input) {
    std::string output;
    output.reserve(input.size());
    bool inString = false;
    for (std::size_t index = 0U; index < input.size();) {
        const char value = input[index];
        if (!inString) {
            output.push_back(value);
            if (value == '"') inString = true;
            ++index;
            continue;
        }
        if (value == '"') {
            output.push_back(value);
            inString = false;
            ++index;
            continue;
        }
        if (value != '\\') {
            output.push_back(value);
            ++index;
            continue;
        }

        std::uint16_t codeUnit = 0U;
        if (!readEscapedCodeUnit(input, index, codeUnit)) {
            output.push_back(value);
            ++index;
            if (index < input.size()) output.push_back(input[index++]);
            continue;
        }

        if (codeUnit >= 0xD800U && codeUnit <= 0xDBFFU) {
            std::uint16_t lowSurrogate = 0U;
            const std::size_t nextEscape = index + 6U;
            if (readEscapedCodeUnit(input, nextEscape, lowSurrogate) &&
                lowSurrogate >= 0xDC00U && lowSurrogate <= 0xDFFFU) {
                output.append(input.substr(index, 12U));
                index += 12U;
            } else {
                output.append("\\uFFFD");
                index += 6U;
            }
            continue;
        }
        if (codeUnit >= 0xDC00U && codeUnit <= 0xDFFFU) {
            output.append("\\uFFFD");
            index += 6U;
            continue;
        }
        output.append(input.substr(index, 6U));
        index += 6U;
    }
    return output;
}

Json parseJsonManifest(std::string_view input) {
    const std::string normalized = normalizeUnpairedSurrogateEscapes(input);
    std::vector<std::unordered_set<std::string>> objectKeys;
    const Json::parser_callback_t callback = [&objectKeys](int depth, Json::parse_event_t event, Json& parsed) {
        if (depth > kMaximumJsonDepth) fail("Project archive manifest JSON is nested too deeply.");
        switch (event) {
        case Json::parse_event_t::object_start:
            objectKeys.emplace_back();
            break;
        case Json::parse_event_t::key:
            if (objectKeys.empty() || !parsed.is_string()) {
                fail("Project archive manifest contains an invalid JSON object key.");
            }
            if (!objectKeys.back().insert(parsed.get<std::string>()).second) {
                fail("Project archive manifest contains duplicate JSON object keys.");
            }
            break;
        case Json::parse_event_t::object_end:
            if (objectKeys.empty()) fail("Project archive manifest JSON object nesting is invalid.");
            objectKeys.pop_back();
            break;
        default:
            break;
        }
        return true;
    };

    try {
        // nlohmann/json validates JSON syntax and UTF-8. Its parser also accepts
        // an initial UTF-8 BOM, matching TextDecoder's default behavior.
        return Json::parse(normalized.begin(), normalized.end(), callback, true, false);
    } catch (const CodecError&) {
        throw;
    } catch (const Json::exception&) {
        fail("Project archive manifest is not valid UTF-8 JSON.");
    }
}

bool objectHasOnlyKeys(const Json& value, std::initializer_list<std::string_view> allowed) {
    if (!value.is_object()) return false;
    for (auto iterator = value.begin(); iterator != value.end(); ++iterator) {
        const std::string_view key(iterator.key());
        if (std::find(allowed.begin(), allowed.end(), key) == allowed.end()) return false;
    }
    return true;
}

bool objectHasExactKeys(const Json& value, std::initializer_list<std::string_view> expected) {
    if (!objectHasOnlyKeys(value, expected) || value.size() != expected.size()) return false;
    for (const auto key : expected) {
        if (!value.contains(std::string(key))) return false;
    }
    return true;
}

const Json& requiredField(const Json& value, const char* key) {
    if (!value.is_object()) fail("Project archive manifest has an unsupported schema.");
    const auto found = value.find(key);
    if (found == value.end()) fail("Project archive manifest is missing a required field.");
    return *found;
}

double requiredNumber(const Json& value, const char* error) {
    if (!value.is_number()) fail(error);
    const double number = value.get<double>();
    if (!std::isfinite(number)) fail(error);
    return number;
}

std::uint64_t safeInteger(const Json& value, std::uint64_t minimum, std::uint64_t maximum, const char* error) {
    const double number = requiredNumber(value, error);
    if (number < static_cast<double>(minimum) || number > static_cast<double>(maximum) || std::floor(number) != number) {
        fail(error);
    }
    return static_cast<std::uint64_t>(number);
}

std::uint64_t checkedMultiply(std::uint64_t left, std::uint64_t right, const char* error) {
    if (right != 0U && left > std::numeric_limits<std::uint64_t>::max() / right) fail(error);
    return left * right;
}

std::uint64_t checkedAdd(std::uint64_t left, std::uint64_t right, const char* error) {
    if (left > std::numeric_limits<std::uint64_t>::max() - right) fail(error);
    return left + right;
}

std::uint32_t readU32Le(const std::uint8_t* bytes) noexcept {
    return static_cast<std::uint32_t>(bytes[0]) |
        (static_cast<std::uint32_t>(bytes[1]) << 8U) |
        (static_cast<std::uint32_t>(bytes[2]) << 16U) |
        (static_cast<std::uint32_t>(bytes[3]) << 24U);
}

void writeU32Le(std::uint8_t* bytes, std::uint32_t value) noexcept {
    bytes[0] = static_cast<std::uint8_t>(value);
    bytes[1] = static_cast<std::uint8_t>(value >> 8U);
    bytes[2] = static_cast<std::uint8_t>(value >> 16U);
    bytes[3] = static_cast<std::uint8_t>(value >> 24U);
}

std::uint32_t rotateRight(std::uint32_t value, unsigned int amount) noexcept {
    return (value >> amount) | (value << (32U - amount));
}

void sha256Transform(std::array<std::uint32_t, 8U>& state, const std::uint8_t* block) noexcept {
    static constexpr std::array<std::uint32_t, 64U> constants{{
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
        0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
        0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
        0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
        0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
        0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
        0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
        0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
    }};
    std::array<std::uint32_t, 64U> words{};
    for (std::size_t index = 0U; index < 16U; ++index) {
        const std::size_t offset = index * 4U;
        words[index] = (static_cast<std::uint32_t>(block[offset]) << 24U) |
            (static_cast<std::uint32_t>(block[offset + 1U]) << 16U) |
            (static_cast<std::uint32_t>(block[offset + 2U]) << 8U) |
            static_cast<std::uint32_t>(block[offset + 3U]);
    }
    for (std::size_t index = 16U; index < words.size(); ++index) {
        const std::uint32_t x = words[index - 15U];
        const std::uint32_t y = words[index - 2U];
        const std::uint32_t s0 = rotateRight(x, 7U) ^ rotateRight(x, 18U) ^ (x >> 3U);
        const std::uint32_t s1 = rotateRight(y, 17U) ^ rotateRight(y, 19U) ^ (y >> 10U);
        words[index] = words[index - 16U] + s0 + words[index - 7U] + s1;
    }

    std::uint32_t a = state[0];
    std::uint32_t b = state[1];
    std::uint32_t c = state[2];
    std::uint32_t d = state[3];
    std::uint32_t e = state[4];
    std::uint32_t f = state[5];
    std::uint32_t g = state[6];
    std::uint32_t h = state[7];
    for (std::size_t index = 0U; index < words.size(); ++index) {
        const std::uint32_t sum1 = rotateRight(e, 6U) ^ rotateRight(e, 11U) ^ rotateRight(e, 25U);
        const std::uint32_t choose = (e & f) ^ (~e & g);
        const std::uint32_t temp1 = h + sum1 + choose + constants[index] + words[index];
        const std::uint32_t sum0 = rotateRight(a, 2U) ^ rotateRight(a, 13U) ^ rotateRight(a, 22U);
        const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
        const std::uint32_t temp2 = sum0 + majority;
        h = g;
        g = f;
        f = e;
        e = d + temp1;
        d = c;
        c = b;
        b = a;
        a = temp1 + temp2;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

std::string sha256Hex(const std::uint8_t* bytes, std::size_t length) {
    std::array<std::uint32_t, 8U> state{{
        0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
        0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
    }};
    const std::size_t fullBlocks = length / 64U;
    for (std::size_t block = 0U; block < fullBlocks; ++block) sha256Transform(state, bytes + block * 64U);

    std::array<std::uint8_t, 128U> tail{};
    const std::size_t remainder = length % 64U;
    if (remainder != 0U) std::memcpy(tail.data(), bytes + fullBlocks * 64U, remainder);
    tail[remainder] = 0x80U;
    const std::size_t tailLength = remainder < 56U ? 64U : 128U;
    const std::uint64_t bitLength = static_cast<std::uint64_t>(length) * 8U;
    for (std::size_t index = 0U; index < 8U; ++index) {
        tail[tailLength - 1U - index] = static_cast<std::uint8_t>(bitLength >> (index * 8U));
    }
    sha256Transform(state, tail.data());
    if (tailLength == 128U) sha256Transform(state, tail.data() + 64U);

    static constexpr char hex[] = "0123456789abcdef";
    std::string result(64U, '0');
    for (std::size_t word = 0U; word < state.size(); ++word) {
        for (std::size_t byte = 0U; byte < 4U; ++byte) {
            const auto value = static_cast<std::uint8_t>(state[word] >> (24U - byte * 8U));
            result[word * 8U + byte * 2U] = hex[value >> 4U];
            result[word * 8U + byte * 2U + 1U] = hex[value & 0x0FU];
        }
    }
    return result;
}

bool isLowerHexDigest(const Json& value) {
    if (!value.is_string()) return false;
    const auto& digest = value.get_ref<const std::string&>();
    if (digest.size() != 64U) return false;
    return std::all_of(digest.begin(), digest.end(), [](char character) {
        return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
    });
}

struct TrackDescriptor {
    std::uint32_t sampleRate = 0U;
    std::uint64_t frameCount = 0U;
    std::uint8_t channels = 0U;
    std::optional<double> originalTempoBpm;
    std::uint64_t payloadOffset = 0U;
    std::uint64_t byteLength = 0U;
    std::string sha256;
};

std::uint64_t pcmByteLength(const TrackDescriptor& track) {
    const auto samples = checkedMultiply(track.frameCount, track.channels, "Track PCM sample count overflows.");
    const auto bytes = checkedMultiply(samples, sizeof(float), "Track PCM byte length overflows.");
    if (bytes > kProjectArchiveMaxBytes) fail("Track PCM exceeds the project archive size limit.");
    return bytes;
}

ProjectArchiveTransportMetadata parseTransport(
    const Json& value,
    const std::array<std::optional<TrackDescriptor>, kProjectArchiveTrackCount>& tracks,
    double bpm
) {
    if (!objectHasExactKeys(value, {
            "masterTrackId", "measureLengthSeconds", "masterLoopLengthSamples",
            "timeSignatureNumerator", "timeSignatureDenominator"})) {
        fail("Transport metadata has an unsupported schema.");
    }

    ProjectArchiveTransportMetadata transport;
    const auto& masterTrackId = requiredField(value, "masterTrackId");
    if (masterTrackId.is_null()) {
        transport.masterTrackId.reset();
    } else {
        const auto trackId = safeInteger(masterTrackId, 1U, kProjectArchiveTrackCount,
            "Master track ID must be null or an integer from 1 to 5.");
        transport.masterTrackId = static_cast<std::uint8_t>(trackId);
    }

    const auto measureLength = requiredNumber(requiredField(value, "measureLengthSeconds"),
        "Measure length must be between zero and 24 hours.");
    if (measureLength < 0.0 || measureLength > 86400.0) fail("Measure length must be between zero and 24 hours.");
    transport.measureLengthSeconds = measureLength;
    transport.masterLoopLengthSamples = safeInteger(requiredField(value, "masterLoopLengthSamples"), 0U,
        kMaxSafeInteger, "Master loop length must be a non-negative safe integer.");
    const auto numerator = safeInteger(requiredField(value, "timeSignatureNumerator"), 1U, 32U,
        "Time signature numerator must be an integer from 1 to 32.");
    transport.timeSignatureNumerator = static_cast<std::uint8_t>(numerator);

    const auto denominator = safeInteger(requiredField(value, "timeSignatureDenominator"), 1U, 32U,
        "Time signature denominator must be a supported power of two from 1 to 32.");
    if (denominator != 1U && denominator != 2U && denominator != 4U && denominator != 8U && denominator != 16U && denominator != 32U) {
        fail("Time signature denominator must be a supported power of two from 1 to 32.");
    }
    transport.timeSignatureDenominator = static_cast<std::uint8_t>(denominator);

    if (!transport.masterTrackId.has_value()) {
        if (transport.masterLoopLengthSamples != 0U || transport.measureLengthSeconds != 0.0) {
            fail("An unmastered project must have zero master loop and measure lengths.");
        }
        return transport;
    }

    const auto& masterTrack = tracks[static_cast<std::size_t>(*transport.masterTrackId - 1U)];
    if (!masterTrack.has_value() || masterTrack->frameCount == 0U) fail("Master track ID must point to a nonempty track.");
    if (transport.masterLoopLengthSamples == 0U || transport.measureLengthSeconds == 0.0) {
        fail("A mastered project must have positive loop and measure lengths.");
    }
    if (transport.masterLoopLengthSamples != masterTrack->frameCount) {
        fail("Master loop sample length must exactly match the referenced master track PCM frame count.");
    }
    const double quarterNotesPerMeasure = static_cast<double>(transport.timeSignatureNumerator) * 4.0 /
        static_cast<double>(transport.timeSignatureDenominator);
    const double expectedMeasureLength = quarterNotesPerMeasure * 60.0 / bpm;
    const double tolerance = std::max(1.0e-9, expectedMeasureLength * 1.0e-9);
    if (std::abs(transport.measureLengthSeconds - expectedMeasureLength) > tolerance) {
        fail("Master measure length is inconsistent with the saved BPM and time-signature numerator.");
    }
    return transport;
}

DecodedProjectArchive validateManifest(const Json& root, const std::uint8_t* payload, std::size_t payloadLength) {
    if (!objectHasExactKeys(root, {"format", "version", "project", "tracks"})) {
        fail("Project archive manifest has an unsupported schema.");
    }
    const auto& format = requiredField(root, "format");
    if (!format.is_string() || format.get_ref<const std::string&>() != "rc505-project-archive") {
        fail("Project archive manifest format is unsupported.");
    }
    const auto versionNumber = safeInteger(requiredField(root, "version"), 1U, 2U,
        "Project archive version is unsupported.");
    if (versionNumber != 1U && versionNumber != 2U) fail("Project archive version is unsupported.");
    const auto version = static_cast<std::uint32_t>(versionNumber);

    const auto& project = requiredField(root, "project");
    if (!objectHasOnlyKeys(project, {"name", "bpm", "transport"}) ||
        !project.contains("name") || !project.contains("bpm")) {
        fail("Project archive project metadata has an unsupported schema.");
    }
    const auto& nameValue = requiredField(project, "name");
    if (!nameValue.is_string()) fail("Project name must be a string of at most 512 UTF-8 bytes.");
    const std::string name = nameValue.get<std::string>();
    if (name.size() > 512U) fail("Project name must be a string of at most 512 UTF-8 bytes.");
    const double bpm = requiredNumber(requiredField(project, "bpm"), "Project BPM must be between 40 and 300.");
    if (bpm < kMinBpm || bpm > kMaxBpm) fail("Project BPM must be between 40 and 300.");

    const auto& trackValues = requiredField(root, "tracks");
    if (!trackValues.is_array() || trackValues.size() != kProjectArchiveTrackCount) {
        fail("Project archive manifest must contain exactly five tracks.");
    }

    std::array<std::optional<TrackDescriptor>, kProjectArchiveTrackCount> descriptors{};
    for (std::size_t index = 0U; index < kProjectArchiveTrackCount; ++index) {
        const auto& trackValue = trackValues[index];
        if (trackValue.is_null()) continue;
        const bool correctTrackSchema = version == 1U
            ? objectHasExactKeys(trackValue, {"sampleRate", "frameCount", "channels", "payloadOffset", "byteLength", "sha256"})
            : objectHasExactKeys(trackValue, {"sampleRate", "frameCount", "channels", "originalTempoBpm", "payloadOffset", "byteLength", "sha256"});
        if (!correctTrackSchema) {
            fail("Track metadata has an unsupported schema.");
        }
        TrackDescriptor descriptor;
        descriptor.sampleRate = static_cast<std::uint32_t>(safeInteger(requiredField(trackValue, "sampleRate"),
            kMinSampleRate, kMaxSampleRate, "Track sample rate is outside the supported range."));
        descriptor.frameCount = safeInteger(requiredField(trackValue, "frameCount"), 1U,
            kMaxSafeInteger, "Track frame count must be a positive safe integer; use null for an empty track.");
        const auto channels = safeInteger(requiredField(trackValue, "channels"), 1U, 2U, "Track must be mono or stereo.");
        descriptor.channels = static_cast<std::uint8_t>(channels);
        if (version == 2U) {
            const auto& originalTempoValue = requiredField(trackValue, "originalTempoBpm");
            if (!originalTempoValue.is_null()) {
                const double originalTempo = requiredNumber(originalTempoValue,
                    "Track original tempo must be null or between 40 and 300 BPM.");
                if (originalTempo < kMinBpm || originalTempo > kMaxBpm) {
                    fail("Track original tempo must be null or between 40 and 300 BPM.");
                }
                descriptor.originalTempoBpm = originalTempo;
            }
        }
        descriptor.payloadOffset = safeInteger(requiredField(trackValue, "payloadOffset"), 0U,
            kMaxSafeInteger, "Track payload offsets must be non-negative safe integers.");
        descriptor.byteLength = safeInteger(requiredField(trackValue, "byteLength"), 0U,
            kMaxSafeInteger, "Track payload offsets must be non-negative safe integers.");
        const auto& digest = requiredField(trackValue, "sha256");
        if (!isLowerHexDigest(digest)) fail("Track SHA-256 digest is malformed.");
        descriptor.sha256 = digest.get<std::string>();
        (void)pcmByteLength(descriptor);
        descriptors[index] = std::move(descriptor);
    }

    ProjectArchiveTransportMetadata transport{};
    const auto transportValue = project.find("transport");
    if (transportValue != project.end()) transport = parseTransport(*transportValue, descriptors, bpm);

    DecodedProjectArchive decoded;
    decoded.version = version;
    decoded.name = name;
    decoded.bpm = bpm;
    decoded.transport = transport;

    std::uint64_t expectedOffset = 0U;
    for (std::size_t index = 0U; index < kProjectArchiveTrackCount; ++index) {
        const auto& descriptor = descriptors[index];
        if (!descriptor.has_value()) continue;
        const std::uint64_t expectedBytes = pcmByteLength(*descriptor);
        if (descriptor->byteLength != expectedBytes) fail("Track has inconsistent PCM byte length.");
        if (descriptor->payloadOffset != expectedOffset) fail("Track payload is not contiguous.");
        const std::uint64_t endOffset = checkedAdd(expectedOffset, expectedBytes, "Track payload end overflows.");
        if (endOffset > payloadLength) fail("Track PCM payload is truncated.");

        const auto* trackPayload = payload + static_cast<std::size_t>(expectedOffset);
        if (sha256Hex(trackPayload, static_cast<std::size_t>(expectedBytes)) != descriptor->sha256) {
            fail("Track PCM hash does not match the manifest.");
        }

        const auto sampleCount64 = checkedMultiply(descriptor->frameCount, descriptor->channels,
            "Track PCM sample count overflows.");
        if (sampleCount64 > std::numeric_limits<std::size_t>::max()) fail("Track PCM sample count is not addressable.");
        ProjectArchiveTrackData track;
        track.sampleRate = descriptor->sampleRate;
        track.frameCount = descriptor->frameCount;
        track.channels = descriptor->channels;
        track.originalTempoBpm = descriptor->originalTempoBpm;
        track.pcm.resize(static_cast<std::size_t>(sampleCount64));
        for (std::size_t sample = 0U; sample < track.pcm.size(); ++sample) {
            const std::uint32_t bits = readU32Le(trackPayload + sample * sizeof(float));
            float value = 0.0F;
            static_assert(sizeof(value) == sizeof(bits), "Float32 PCM requires a 32-bit float type.");
            std::memcpy(&value, &bits, sizeof(value));
            if (!std::isfinite(value)) fail("Track contains a non-finite PCM sample.");
            track.pcm[sample] = value;
        }
        decoded.tracks[index] = std::move(track);
        expectedOffset = endOffset;
    }

    if (expectedOffset != payloadLength) fail("Project archive contains trailing or unaccounted payload bytes.");
    decoded.payloadByteLength = expectedOffset;
    return decoded;
}

ProjectArchiveDecodeResult decodeImpl(const std::uint8_t* bytes, std::size_t byteLength) {
    if (bytes == nullptr && byteLength != 0U) return {std::nullopt, "Project archive input is null."};
    if (byteLength > kProjectArchiveMaxBytes) return {std::nullopt, "Project archive exceeds the 805371916-byte limit."};
    if (byteLength < kProjectArchiveHeaderBytes) return {std::nullopt, "Project archive is truncated before its header."};
    if (!std::equal(kMagic.begin(), kMagic.end(), bytes)) return {std::nullopt, "Project archive has invalid magic bytes."};

    const std::uint64_t manifestByteLength = readU32Le(bytes + kMagic.size());
    if (manifestByteLength == 0U || manifestByteLength > kProjectArchiveMaxManifestBytes) {
        return {std::nullopt, "Project archive manifest length is invalid."};
    }
    const std::uint64_t payloadStart64 = checkedAdd(kProjectArchiveHeaderBytes, manifestByteLength,
        "Project archive manifest end overflows.");
    if (payloadStart64 > byteLength) return {std::nullopt, "Project archive is truncated inside its manifest."};
    const auto payloadStart = static_cast<std::size_t>(payloadStart64);
    const std::size_t payloadLength = byteLength - payloadStart;
    if (payloadLength > kProjectArchiveMaxPayloadBytes) {
        return {std::nullopt, "Project PCM payload exceeds the archive payload limit."};
    }

    const auto* manifestBytes = bytes + kProjectArchiveHeaderBytes;
    const auto manifestLength = static_cast<std::size_t>(manifestByteLength);
    if (!isStrictUtf8(manifestBytes, manifestLength)) {
        return {std::nullopt, "Project archive manifest is not valid UTF-8 JSON."};
    }
    const std::string_view manifestText(reinterpret_cast<const char*>(manifestBytes), manifestLength);
    const Json manifest = parseJsonManifest(manifestText);
    auto decoded = validateManifest(manifest, bytes + payloadStart, payloadLength);
    return {std::move(decoded), {}};
}

std::vector<std::uint8_t> encodeImpl(const DecodedProjectArchive& project) {
    if (!isStrictUtf8(reinterpret_cast<const std::uint8_t*>(project.name.data()), project.name.size()) || project.name.size() > 512U) {
        fail("Project name must be a string of at most 512 UTF-8 bytes.");
    }
    if (!std::isfinite(project.bpm) || project.bpm < kMinBpm || project.bpm > kMaxBpm) {
        fail("Project BPM must be between 40 and 300.");
    }

    std::array<std::optional<TrackDescriptor>, kProjectArchiveTrackCount> descriptors{};
    std::uint64_t payloadByteLength = 0U;
    for (std::size_t index = 0U; index < kProjectArchiveTrackCount; ++index) {
        const auto& source = project.tracks[index];
        if (!source.has_value()) continue;
        if (source->sampleRate < kMinSampleRate || source->sampleRate > kMaxSampleRate) {
            fail("Track sample rate is outside the supported range.");
        }
        if (source->frameCount == 0U || source->frameCount > kMaxSafeInteger) {
            fail("Track frame count must be a positive safe integer; use null for an empty track.");
        }
        if (source->channels != 1U && source->channels != 2U) fail("Track must be mono or stereo.");
        const auto sampleCount = checkedMultiply(source->frameCount, source->channels, "Track PCM sample count overflows.");
        if (sampleCount != source->pcm.size()) fail("Track PCM length does not match its frame and channel metadata.");
        if (source->originalTempoBpm.has_value() && (!std::isfinite(*source->originalTempoBpm)
            || *source->originalTempoBpm < kMinBpm || *source->originalTempoBpm > kMaxBpm)) {
            fail("Track original tempo must be null or between 40 and 300 BPM.");
        }
        for (float sample : source->pcm) {
            if (!std::isfinite(sample)) fail("Track contains a non-finite PCM sample.");
        }
        TrackDescriptor descriptor;
        descriptor.sampleRate = source->sampleRate;
        descriptor.frameCount = source->frameCount;
        descriptor.channels = source->channels;
        descriptor.originalTempoBpm = source->originalTempoBpm;
        descriptor.payloadOffset = payloadByteLength;
        descriptor.byteLength = pcmByteLength(descriptor);
        payloadByteLength = checkedAdd(payloadByteLength, descriptor.byteLength, "Project PCM payload size overflows.");
        if (payloadByteLength > kProjectArchiveMaxPayloadBytes) fail("Project PCM payload exceeds the archive payload limit.");
        descriptors[index] = std::move(descriptor);
    }

    const auto transport = parseTransport(Json{
        {"masterTrackId", project.transport.masterTrackId ? Json(*project.transport.masterTrackId) : Json(nullptr)},
        {"measureLengthSeconds", project.transport.measureLengthSeconds},
        {"masterLoopLengthSamples", project.transport.masterLoopLengthSamples},
        {"timeSignatureNumerator", project.transport.timeSignatureNumerator},
        {"timeSignatureDenominator", project.transport.timeSignatureDenominator},
    }, descriptors, project.bpm);
    Json trackManifest = Json::array();
    for (const auto& descriptor : descriptors) {
        if (!descriptor.has_value()) {
            trackManifest.push_back(nullptr);
            continue;
        }
        trackManifest.push_back({
            {"sampleRate", descriptor->sampleRate},
            {"frameCount", descriptor->frameCount},
            {"channels", descriptor->channels},
            {"originalTempoBpm", descriptor->originalTempoBpm ? Json(*descriptor->originalTempoBpm) : Json(nullptr)},
            {"payloadOffset", descriptor->payloadOffset},
            {"byteLength", descriptor->byteLength},
            {"sha256", ""},
        });
    }

    Json manifest = {
        {"format", "rc505-project-archive"},
        {"version", 2},
        {"project", {
            {"name", project.name},
            {"bpm", project.bpm},
            {"transport", {
                {"masterTrackId", transport.masterTrackId ? Json(*transport.masterTrackId) : Json(nullptr)},
                {"measureLengthSeconds", transport.measureLengthSeconds},
                {"masterLoopLengthSamples", transport.masterLoopLengthSamples},
                {"timeSignatureNumerator", transport.timeSignatureNumerator},
                {"timeSignatureDenominator", transport.timeSignatureDenominator},
            }},
        }},
        {"tracks", std::move(trackManifest)},
    };

    const auto payloadLength = static_cast<std::size_t>(payloadByteLength);
    std::vector<std::uint8_t> payload(payloadLength);
    for (std::size_t index = 0U; index < kProjectArchiveTrackCount; ++index) {
        const auto& source = project.tracks[index];
        auto& descriptor = descriptors[index];
        if (!source.has_value() || !descriptor.has_value()) continue;
        const auto offset = static_cast<std::size_t>(descriptor->payloadOffset);
        for (std::size_t sampleIndex = 0U; sampleIndex < source->pcm.size(); ++sampleIndex) {
            std::uint32_t bits = 0U;
            std::memcpy(&bits, &source->pcm[sampleIndex], sizeof(bits));
            writeU32Le(payload.data() + offset + sampleIndex * sizeof(float), bits);
        }
        descriptor->sha256 = sha256Hex(payload.data() + offset, static_cast<std::size_t>(descriptor->byteLength));
        manifest["tracks"][index]["sha256"] = descriptor->sha256;
    }

    const std::string manifestBytes = manifest.dump(-1, ' ', false, Json::error_handler_t::strict);
    if (manifestBytes.empty() || manifestBytes.size() > kProjectArchiveMaxManifestBytes) {
        fail("Project archive manifest exceeds the 65536-byte limit.");
    }
    const auto archiveLength = checkedAdd(kProjectArchiveHeaderBytes + manifestBytes.size(), payloadByteLength,
        "Project archive size overflows.");
    if (archiveLength > kProjectArchiveMaxBytes || manifestBytes.size() > std::numeric_limits<std::uint32_t>::max()) {
        fail("Project archive exceeds the 805371916-byte limit.");
    }
    std::vector<std::uint8_t> archive(static_cast<std::size_t>(archiveLength));
    std::copy(kMagic.begin(), kMagic.end(), archive.begin());
    writeU32Le(archive.data() + kMagic.size(), static_cast<std::uint32_t>(manifestBytes.size()));
    std::copy(manifestBytes.begin(), manifestBytes.end(), archive.begin() + static_cast<std::ptrdiff_t>(kProjectArchiveHeaderBytes));
    std::copy(payload.begin(), payload.end(), archive.begin() + static_cast<std::ptrdiff_t>(kProjectArchiveHeaderBytes + manifestBytes.size()));
    return archive;
}

} // namespace

std::vector<std::uint8_t> encodeProjectArchive(const DecodedProjectArchive& project) {
    try {
        return encodeImpl(project);
    } catch (const std::exception& error) {
        throw std::invalid_argument(error.what());
    }
}

ProjectArchiveDecodeResult decodeProjectArchive(const std::uint8_t* bytes, std::size_t byteLength) noexcept {
    try {
        return decodeImpl(bytes, byteLength);
    } catch (const std::exception& error) {
        return {std::nullopt, error.what()};
    } catch (...) {
        return {std::nullopt, "Project archive could not be decoded."};
    }
}

ProjectArchiveDecodeResult decodeProjectArchive(const std::vector<std::uint8_t>& bytes) noexcept {
    return decodeProjectArchive(bytes.data(), bytes.size());
}

} // namespace webrc::native
