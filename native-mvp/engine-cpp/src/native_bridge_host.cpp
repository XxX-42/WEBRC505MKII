#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#include <bcrypt.h>
#endif

#include "native_audio_core.hpp"
#include "native_official_domains.hpp"
#include "project_archive_codec.hpp"
#if defined(NATIVE_RUBBERBAND_HQ_AVAILABLE)
#include "native_rubberband_renderer.hpp"
#endif

#include <cmath>
#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <thread>
#include <mutex>
#include <unordered_map>

#include "httplib.h"
#include "nlohmann/json.hpp"

using json = nlohmann::json;
using namespace webrc::native;

namespace {

constexpr std::uint64_t kMaximumSafeTempoRevision = 9007199254740991ULL;

std::string createHostIncarnationId() {
    std::array<unsigned char, 16U> bytes{};
#if defined(_WIN32)
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) {
        throw std::runtime_error("System cryptographic RNG failed to create Native host incarnation ID.");
    }
#else
    std::random_device random;
    if (random.entropy() <= 0.0) {
        throw std::runtime_error("System random source has no advertised entropy for Native host incarnation ID.");
    }
    for (auto& byte : bytes) byte = static_cast<unsigned char>(random() & 0xffU);
#endif
    std::ostringstream result;
    result << std::hex << std::setfill('0');
    for (const auto byte : bytes) result << std::setw(2) << static_cast<unsigned int>(byte);
    return result.str();
}

const std::string& hostIncarnationId() {
    static const std::string id = createHostIncarnationId();
    return id;
}

bool requestMatchesHostIncarnation(const httplib::Request& request) {
    return request.get_header_value_count("X-Native-Host-Incarnation") == 1U &&
        request.get_header_value("X-Native-Host-Incarnation") == hostIncarnationId();
}

bool isOperationId(const std::string& value) {
    return value.size() == 32U && std::all_of(value.begin(), value.end(), [](unsigned char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

struct NativeImportOperationRecord {
    std::string archiveSha256;
    std::uint64_t expectedProjectContentRevision = 0U;
    std::uint64_t generation = 0U;
};
constexpr std::size_t kNativeImportOperationLimit = 256U;

#if defined(NATIVE_BRIDGE_SIMULATION_ONLY)
bool consumeImportLedgerReservationFailure(const std::string& operationId) {
    static bool consumed = false;
    const char* configuredId = std::getenv("WEBRC_NATIVE_TEST_FAIL_IMPORT_LEDGER_OPERATION_ID");
    if (!consumed && configuredId != nullptr && operationId == configuredId) {
        consumed = true;
        return true;
    }
    return false;
}

bool consumeImportBeginException(const std::string& operationId) {
    static bool consumed = false;
    const char* configuredId = std::getenv("WEBRC_NATIVE_TEST_THROW_BEFORE_IMPORT_BEGIN_OPERATION_ID");
    if (!consumed && configuredId != nullptr && operationId == configuredId) {
        consumed = true;
        return true;
    }
    return false;
}

bool consumeImportPostBeginException(const std::string& operationId) {
    static bool consumed = false;
    const char* configuredId = std::getenv("WEBRC_NATIVE_TEST_THROW_AFTER_IMPORT_BEGIN_OPERATION_ID");
    if (!consumed && configuredId != nullptr && operationId == configuredId) {
        consumed = true;
        return true;
    }
    return false;
}

bool consumeImportIndeterminateBeginException(const std::string& operationId) {
    static bool consumed = false;
    const char* configuredId = std::getenv("WEBRC_NATIVE_TEST_THROW_DURING_IMPORT_BEGIN_OPERATION_ID");
    if (!consumed && configuredId != nullptr && operationId == configuredId) {
        consumed = true;
        return true;
    }
    return false;
}
#endif

std::mutex& nativeImportOperationsMutex() { static std::mutex value; return value; }
std::unordered_map<std::string, NativeImportOperationRecord>& nativeImportOperations() {
    static std::unordered_map<std::string, NativeImportOperationRecord> value;
    return value;
}

bool exactMemoryKeys(const json& value, std::initializer_list<const char*> keys) {
    return value.is_object() && value.size() == keys.size() && std::all_of(keys.begin(), keys.end(),
        [&value](const char* key) { return value.contains(key); });
}

std::size_t memoryStringLength(const std::string& value, bool utf16Units = false) noexcept {
    std::size_t count = 0U;
    for (const auto character : value) {
        const auto byte = static_cast<unsigned char>(character);
        if ((byte & 0xc0U) == 0x80U) continue;
        count += utf16Units && byte >= 0xf0U ? 2U : 1U;
    }
    return count;
}

bool memoryJsonSafe(const json& value, unsigned int depth = 0U) {
    if (depth > 12U) return false;
    if (value.is_null() || value.is_boolean()) return true;
    if (value.is_number()) return std::isfinite(value.get<double>());
    if (value.is_string()) return memoryStringLength(value.get_ref<const std::string&>(), true) <= 8192U;
    if (value.is_array()) return value.size() <= 4096U && std::all_of(value.begin(), value.end(),
        [depth](const json& child) { return memoryJsonSafe(child, depth + 1U); });
    if (!value.is_object()) return false;
    for (auto entry = value.begin(); entry != value.end(); ++entry) {
        if (entry.key() == "__proto__" || entry.key() == "constructor" || entry.key() == "prototype" ||
            !memoryJsonSafe(entry.value(), depth + 1U)) return false;
    }
    return true;
}

bool boundedMemoryInteger(const json& value, std::int64_t minimum, std::int64_t maximum) {
    if (!value.is_number_integer()) return false;
    if (value.is_number_unsigned()) {
        const auto number = value.get<std::uint64_t>();
        return number <= static_cast<std::uint64_t>(maximum) && number >= static_cast<std::uint64_t>(minimum);
    }
    const auto number = value.get<std::int64_t>();
    return number >= minimum && number <= maximum;
}

void validateNativeMemoryMetadata(const json& metadata) {
    if (!exactMemoryKeys(metadata, {"version", "memoryNumber", "name", "semantics", "extensions"}) ||
        !boundedMemoryInteger(metadata.at("version"), 1, 1) ||
        !(metadata.at("memoryNumber").is_null() || boundedMemoryInteger(metadata.at("memoryNumber"), 1, 99)) ||
        !metadata.at("name").is_string()) throw std::runtime_error("Invalid Memory metadata schema/version/slot.");
    const auto& name = metadata.at("name").get_ref<const std::string&>();
    if (memoryStringLength(name) > 12U || std::any_of(name.begin(), name.end(), [](char character) {
        const auto byte = static_cast<unsigned char>(character); return byte < 0x20U || byte == 0x7fU;
    })) throw std::runtime_error("Memory name must contain at most twelve visible characters.");
    const auto& semantics = metadata.at("semantics");
    if (!exactMemoryKeys(semantics, {"tempo", "meter", "fields"}) || !semantics.at("tempo").is_number() ||
        !std::isfinite(semantics.at("tempo").get<double>()) || semantics.at("tempo").get<double>() < 40.0 ||
        semantics.at("tempo").get<double>() > 300.0 || !semantics.at("meter").is_array() ||
        semantics.at("meter").size() != 2U || !boundedMemoryInteger(semantics.at("meter")[0U], 1, 32) ||
        !boundedMemoryInteger(semantics.at("meter")[1U], 1, 32) || !semantics.at("fields").is_object()) {
        throw std::runtime_error("Invalid Memory semantic tempo/meter/fields.");
    }
    const auto denominator = semantics.at("meter")[1U].get<unsigned int>();
    if ((denominator & (denominator - 1U)) != 0U) throw std::runtime_error("Invalid Memory meter denominator.");
    const auto& extensions = metadata.at("extensions");
    if (!exactMemoryKeys(extensions, {"WEBRC"}) || !extensions.at("WEBRC").is_object() || !memoryJsonSafe(extensions)) {
        throw std::runtime_error("Invalid or unbounded Memory extensions.");
    }
    const auto validAddress = [](const std::string& address) {
        constexpr std::array<std::string_view, 13U> roots{{"track.1", "track.2", "track.3", "track.4", "track.5",
            "record", "play", "inputFx", "trackFx", "rhythm", "routing", "assign", "mixer"}};
        for (const auto root : roots) {
            if (address.size() <= root.size() + 1U || address.compare(0U, root.size(), root) != 0 || address[root.size()] != '.') continue;
            return std::all_of(address.begin() + static_cast<std::ptrdiff_t>(root.size() + 1U), address.end(), [](char value) {
                return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
                    (value >= '0' && value <= '9') || value == '_' || value == '.' || value == '-';
            });
        }
        return false;
    };
    for (auto field = semantics.at("fields").begin(); field != semantics.at("fields").end(); ++field) {
        const auto& value = field.value();
        if (!validAddress(field.key()) || !value.is_object() || !value.contains("value") ||
            !value.contains("availability") || !value.at("availability").is_string() || !memoryJsonSafe(value.at("value"))) {
            throw std::runtime_error("Invalid Memory semantic field address/value.");
        }
        for (auto key = value.begin(); key != value.end(); ++key) {
            if (key.key() != "value" && key.key() != "availability" && key.key() != "reason") throw std::runtime_error("Unknown Memory semantic field property.");
        }
        const auto availability = value.at("availability").get<std::string>();
        if (availability != "supported" && availability != "unsupported" && availability != "unknown") throw std::runtime_error("Invalid Memory field availability.");
        if (value.contains("reason") && !value.at("reason").is_string()) throw std::runtime_error("Invalid Memory field reason.");
        if (availability != "supported" && (!value.at("value").is_null() || !value.contains("reason") || value.at("reason").get_ref<const std::string&>().empty())) {
            throw std::runtime_error("Unavailable Memory fields require a null value and reason.");
        }
    }
}

// The semantic envelope contains the exact v1 archive as its final byte range.
// Native settings are additive software metadata, never Roland binary data.
bool unwrapNativeMemory(std::vector<std::uint8_t>& bytes,
                        std::unique_ptr<NativeMemorySettings>& memory, std::array<unsigned int, 2U>& semanticMeter, std::string& error) {
    constexpr std::string_view magic = "RC505ME1";
    if (bytes.size() < magic.size() || !std::equal(magic.begin(), magic.end(), bytes.begin())) return true;
    try {
        if (bytes.size() < 12U) throw std::runtime_error("Truncated Memory header.");
        const auto length = static_cast<std::uint32_t>(bytes[8U]) |
            (static_cast<std::uint32_t>(bytes[9U]) << 8U) |
            (static_cast<std::uint32_t>(bytes[10U]) << 16U) |
            (static_cast<std::uint32_t>(bytes[11U]) << 24U);
        if (length == 0U || length > 256U * 1024U || 12U + length >= bytes.size()) throw std::runtime_error("Invalid Memory metadata length.");
        const auto metadata = json::parse(bytes.begin() + 12U, bytes.begin() + 12U + length);
        validateNativeMemoryMetadata(metadata);
        semanticMeter = {{metadata.at("semantics").at("meter")[0U].get<unsigned int>(), metadata.at("semantics").at("meter")[1U].get<unsigned int>()}};
        const auto& settings = metadata.at("extensions").at("WEBRC").at("nativeMemory");
        auto candidate = std::make_unique<NativeMemorySettings>();
        if (settings.contains("recAction")) {
            const auto action = settings.at("recAction").get<std::string>();
            if (action != "REC->PLAY" && action != "REC->DUB") throw std::runtime_error("Invalid Memory REC ACTION.");
            candidate->recordActionIncluded = true; candidate->recordActionDub = action == "REC->DUB";
        }
        const auto& banks = settings.at("banks");
        if (!banks.is_array() || banks.size() != 7U) throw std::runtime_error("Memory requires seven FX banks.");
        for (std::size_t bank = 0U; bank < 7U; ++bank) {
            if (!banks[bank].is_array() || banks[bank].size() != 4U) throw std::runtime_error("Memory requires four slots per bank.");
            for (std::size_t slot = 0U; slot < 4U; ++slot) {
                const auto& saved = banks[bank][slot];
                auto& target = candidate->banks[bank][slot];
                target.effectId = saved.at("effectId").get<std::string>();
                target.bypassed = saved.at("bypassed").get<bool>();
                const auto& parameters = saved.at("parameters");
                if (!parameters.is_object() || parameters.size() > 256U || target.effectId.size() > 128U) throw std::runtime_error("Invalid Memory FX parameter map.");
                for (auto item = parameters.begin(); item != parameters.end(); ++item) {
                    if (!item.value().is_number() || item.key().size() > 128U) throw std::runtime_error("Invalid Memory FX parameter.");
                    const float value = item.value().get<float>();
                    if (!std::isfinite(value)) throw std::runtime_error("Non-finite Memory FX parameter.");
                    target.parameters.emplace(item.key(), value);
                }
            }
        }
        const auto boundedInteger = [](const json& value, int minimum, int maximum) {
            if (!value.is_number_integer()) throw std::runtime_error("Memory setting must be an integer.");
            const auto number = value.get<std::int64_t>();
            if (number < minimum || number > maximum) throw std::runtime_error("Memory setting integer is out of range.");
            return static_cast<unsigned int>(number);
        };
        const auto& levels = settings.at("mixerLevels");
        if (!levels.is_array() || levels.size() != 7U) throw std::runtime_error("Memory requires seven mixer levels.");
        for (std::size_t channel = 0U; channel < 7U; ++channel) candidate->mixerLevels[channel] = boundedInteger(levels[channel], 0, 200);
        const auto& gates = settings.at("trackFxApply");
        if (!gates.is_array() || gates.size() != 5U) throw std::runtime_error("Memory requires five FX gate values.");
        for (std::size_t track = 0U; track < 5U; ++track) candidate->trackFxApply[track] = gates[track].get<bool>();
        const auto& rhythm = settings.at("rhythm");
        auto& targetRhythm = candidate->rhythm;
        targetRhythm.enabled = rhythm.at("enabled").get<bool>();
        targetRhythm.bpm = rhythm.at("bpm").get<double>();
        if (metadata.at("semantics").at("tempo").get<double>() != targetRhythm.bpm) throw std::runtime_error("Memory tempo mismatch.");
        targetRhythm.kitIndex = static_cast<std::uint8_t>(boundedInteger(rhythm.at("kitIndex"), 1, 16));
        targetRhythm.patternIndex = static_cast<std::uint16_t>(boundedInteger(rhythm.at("patternIndex"), 1, 240));
        targetRhythm.variation = static_cast<NativeRhythmVariation>(boundedInteger(rhythm.at("variation"), 0, 3));
        targetRhythm.section = static_cast<NativeRhythmSection>(boundedInteger(rhythm.at("section"), 0, 3));
        targetRhythm.quantizeGrid = static_cast<NativeRhythmQuantizeGrid>(boundedInteger(rhythm.at("quantizeGrid"), 0, 2));
        targetRhythm.swingPercent = boundedInteger(rhythm.at("swingPercent"), 50, 75);
        targetRhythm.volume = boundedInteger(rhythm.at("volume"), 0, 100);
        const auto& transports = settings.at("loopTransports");
        if (!transports.is_array() || transports.size() != 5U) throw std::runtime_error("Memory requires five source transports.");
        for (std::size_t track = 0U; track < 5U; ++track) {
            const auto& source = transports[track];
            auto& target = candidate->loopTransports[track];
            target.mode = static_cast<LoopTransportMode>(boundedInteger(source.at("mode"), 0, 2));
            target.oneShot = source.value("oneShot", false);
            target.reverse = source.value("reverse", false);
            target.beatOffsetBeats = source.at("beatOffsetBeats").get<float>();
            target.bpm = source.at("bpm").get<float>();
            target.crossfadeMs = source.at("crossfadeMs").get<float>();
            target.vinylSpeedPercent = source.at("vinylSpeedPercent").get<float>();
            target.motorReturnSeconds = source.at("motorReturnSeconds").get<float>();
            target.brakePercent = source.at("brakePercent").get<float>();
            target.vinylMixPercent = source.at("vinylMixPercent").get<float>();
        }
        // Older Native Memory envelopes did not store DUB MODE; preserve their
        // historical OVERDUB default. New envelopes store one validated value
        // for each track inside the same atomic Memory transaction.
        if (settings.contains("dubModes")) {
            const auto& dubModes = settings.at("dubModes");
            if (!dubModes.is_array() || dubModes.size() != kNativeTrackCount) {
                throw std::runtime_error("Memory requires five DUB MODE values.");
            }
            for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
                if (!dubModes[track].is_string()) throw std::runtime_error("Memory DUB MODE values must be strings.");
                const auto mode = dubModes[track].get<std::string>();
                if (mode == "OVERDUB") candidate->dubModes[track] = NativeDubMode::Overdub;
                else if (mode == "REPLACE1") candidate->dubModes[track] = NativeDubMode::Replace1;
                else if (mode == "REPLACE2") candidate->dubModes[track] = NativeDubMode::Replace2;
                else throw std::runtime_error("Invalid Memory DUB MODE value.");
            }
            candidate->dubModesIncluded = true;
        }
        if (settings.contains("bounce")) {
            const auto& bounce = settings.at("bounce");
            if (!bounce.is_object() || !bounce.contains("bounceSw") || !bounce.at("bounceSw").is_boolean()
                || !bounce.contains("bounceIn") || !bounce.at("bounceIn").is_array() || bounce.at("bounceIn").size() != 5U
                || !bounce.contains("bounceTrack") || !bounce.at("bounceTrack").is_array() || bounce.at("bounceTrack").size() != 5U) {
                throw std::runtime_error("Memory Bounce settings are invalid.");
            }
            candidate->bounce.bounceSw = bounce.at("bounceSw").get<bool>();
            for (std::size_t track = 0U; track < 5U; ++track) {
                if (!bounce.at("bounceIn")[track].is_boolean() || !bounce.at("bounceTrack")[track].is_boolean()) throw std::runtime_error("Memory Bounce switches must be booleans.");
                candidate->bounce.bounceIn[track] = bounce.at("bounceIn")[track].get<bool>();
                candidate->bounce.bounceTrack[track] = bounce.at("bounceTrack")[track].get<bool>();
            }
        }
        const auto& outputState = metadata.at("extensions").at("WEBRC").at("nativeOutputState");
        const auto& fx = outputState.at("fx");
        candidate->lowPass = fx.at("outputLowPassEnabled").get<bool>();
        candidate->highPass = fx.at("outputHighPassEnabled").get<bool>();
        candidate->reverb.enabled = fx.at("outputReverbEnabled").get<bool>();
        candidate->reverb.wetMix = fx.at("outputReverbWetMix").get<float>();
        candidate->reverb.rt60Seconds = fx.at("outputReverbRt60Seconds").get<float>();
        candidate->reverb.dampingCutoffHz = fx.at("outputReverbDampingCutoffHz").get<float>();
        const auto readOutput = [](const json& source) {
            if (source.at("slot") != "A") throw std::runtime_error("Memory output DSP supports only slot A.");
        };
        const auto& delay = fx.at("fractionalDelay"); readOutput(delay);
        candidate->delay.enabled = delay.at("enabled").get<bool>();
        candidate->delay.delayMs = delay.at("delayMs").get<float>();
        candidate->delay.wetMix = delay.at("wetMix").get<float>();
        candidate->delay.feedback = delay.at("feedback").get<float>();
        const auto& compressor = fx.at("compressor"); readOutput(compressor);
        candidate->compressor.enabled = compressor.at("enabled").get<bool>();
        candidate->compressor.thresholdDb = compressor.at("thresholdDb").get<float>();
        candidate->compressor.ratio = compressor.at("ratio").get<float>();
        candidate->compressor.attackMs = compressor.at("attackMs").get<float>();
        candidate->compressor.releaseMs = compressor.at("releaseMs").get<float>();
        candidate->compressor.wetMix = compressor.at("wetMix").get<float>();
        candidate->compressor.makeupDb = compressor.at("makeupDb").get<float>();
        const auto& chorus = fx.at("chorus"); readOutput(chorus);
        candidate->chorus.enabled = chorus.at("enabled").get<bool>();
        candidate->chorus.rateHz = chorus.at("rateHz").get<float>();
        candidate->chorus.depthMs = chorus.at("depthMs").get<float>();
        candidate->chorus.feedback = chorus.at("feedback").get<float>();
        candidate->chorus.wetMix = chorus.at("wetMix").get<float>();
        const auto& phaser = fx.at("phaser"); readOutput(phaser);
        candidate->phaser.enabled = phaser.at("enabled").get<bool>();
        candidate->phaser.stages = boundedInteger(phaser.at("stages"), 4, 12);
        candidate->phaser.rateHz = phaser.at("rateHz").get<float>();
        candidate->phaser.depth = phaser.at("depth").get<float>();
        candidate->phaser.feedback = phaser.at("feedback").get<float>();
        candidate->phaser.wetMix = phaser.at("wetMix").get<float>();
        const auto& autoPan = fx.at("autoPan"); readOutput(autoPan);
        candidate->autoPan.enabled = autoPan.at("enabled").get<bool>();
        candidate->autoPan.rateHz = autoPan.at("rateHz").get<float>();
        candidate->autoPan.depth = autoPan.at("depth").get<float>();
        candidate->autoPan.wetMix = autoPan.at("wetMix").get<float>();
        const auto waveform = autoPan.at("waveform").get<std::string>();
        if (waveform == "sine") candidate->autoPan.waveform = NativeAutoPanWaveform::Sine;
        else if (waveform == "triangle") candidate->autoPan.waveform = NativeAutoPanWaveform::Triangle;
        else if (waveform == "square") candidate->autoPan.waveform = NativeAutoPanWaveform::Square;
        else throw std::runtime_error("Invalid Memory AUTO PAN waveform.");
        const auto& pitch = outputState.at("pitch");
        candidate->pitch.enabled = pitch.at("enabled").get<bool>();
        candidate->pitch.trackId = static_cast<std::uint8_t>(boundedInteger(pitch.at("trackId"), 0, 5));
        candidate->pitch.semitones = pitch.at("semitones").get<float>();
        candidate->pitch.reversePlayback = pitch.at("reversePlayback").get<bool>();
        const auto pitchMode = pitch.at("mode").get<std::string>();
        if (pitchMode == "liveMonoKeepPitch") candidate->pitch.mode = NativePitchMode::LiveMonoKeepPitch;
        else if (pitchMode == "livePolyPhaseVocoder") candidate->pitch.mode = NativePitchMode::LivePolyPhaseVocoder;
        else throw std::runtime_error("Invalid Memory pitch mode.");
        json expectedFields{{"rhythm.settings", settings.at("rhythm")}, {"inputFx.bank", banks[0U]},
            {"mixer.mainLevel", levels[0U]}, {"mixer.masterLevel", levels[1U]}};
        expectedFields["record.bounceSw"] = candidate->bounce.bounceSw;
        if (candidate->recordActionIncluded) expectedFields["record.recAction"] = settings.at("recAction");
        json trackBanks = json::array();
        for (std::size_t bank = 1U; bank < 7U; ++bank) trackBanks.push_back(banks[bank]);
        expectedFields["trackFx.banks"] = std::move(trackBanks);
        for (std::size_t track = 0U; track < 5U; ++track) {
            const auto root = "track." + std::to_string(track + 1U);
            expectedFields[root + ".fxApply"] = gates[track];
            expectedFields[root + ".level"] = levels[track + 2U];
            expectedFields[root + ".bounceIn"] = candidate->bounce.bounceIn[track];
            expectedFields[root + ".bounceTrack"] = candidate->bounce.bounceTrack[track];
            if (candidate->dubModesIncluded) expectedFields[root + ".dubMode"] = settings.at("dubModes")[track];
        }
        for (auto field = metadata.at("semantics").at("fields").begin(); field != metadata.at("semantics").at("fields").end(); ++field) {
            if (field.value().at("availability") == "supported" &&
                (!expectedFields.contains(field.key()) || expectedFields.at(field.key()) != field.value().at("value"))) {
                throw std::runtime_error("Native Memory has unsupported or inconsistent semantic field: " + field.key());
            }
        }
        bytes.erase(bytes.begin(), bytes.begin() + 12U + length);
        memory = std::move(candidate);
        return true;
    } catch (const std::exception& exception) {
        error = exception.what(); return false;
    }
}

json deviceToJson(const DeviceDescriptor& device) {
    return json{
        {"id", device.id},
        {"name", device.name},
        {"sampleRates", device.sampleRates},
        {"isDefault", device.isDefault},
    };
}

json catalogToJson(const DeviceCatalog& catalog) {
    json inputs = json::object();
    json outputs = json::object();

    for (const auto& [backend, devices] : catalog.inputsByBackend) {
        inputs[backend] = json::array();
        for (const auto& device : devices) {
            inputs[backend].push_back(deviceToJson(device));
        }
    }

    for (const auto& [backend, devices] : catalog.outputsByBackend) {
        outputs[backend] = json::array();
        for (const auto& device : devices) {
            outputs[backend].push_back(deviceToJson(device));
        }
    }

    return json{
        {"ok", true},
        {"backends", catalog.backends},
        {"inputsByBackend", inputs},
        {"outputsByBackend", outputs},
        {"defaultInputIdByBackend", catalog.defaultInputIdByBackend},
        {"defaultOutputIdByBackend", catalog.defaultOutputIdByBackend},
        {"bufferOptions", catalog.bufferOptions},
    };
}

const char* outputSlotToString(NativeTrackOutputSlot slot) {
    switch (slot) {
    case NativeTrackOutputSlot::A: return "A";
    case NativeTrackOutputSlot::B: return "B";
    case NativeTrackOutputSlot::C: return "C";
    case NativeTrackOutputSlot::D: return "D";
    }
    return "A";
}

const char* fractionalDelayAlgorithmToString(NativeFractionalDelayAlgorithm algorithm) {
    switch (algorithm) {
    case NativeFractionalDelayAlgorithm::Lagrange4: return "lagrange4";
    }
    return "unknown";
}

const char* compressorAlgorithmToString(NativeCompressorAlgorithm algorithm) {
    switch (algorithm) {
    case NativeCompressorAlgorithm::PeakCompressor: return "peakCompressor";
    }
    return "unknown";
}

const char* chorusAlgorithmToString(NativeChorusAlgorithm algorithm) {
    switch (algorithm) {
    case NativeChorusAlgorithm::StereoLfoLagrange4: return "stereoLfoLagrange4";
    }
    return "unknown";
}

const char* phaserAlgorithmToString(NativePhaserAlgorithm algorithm) {
    switch (algorithm) {
    case NativePhaserAlgorithm::AllpassSweep: return "allpassSweep";
    }
    return "unknown";
}

const char* autoPanAlgorithmToString(NativeAutoPanAlgorithm algorithm) {
    switch (algorithm) {
    case NativeAutoPanAlgorithm::EqualPowerMidSideLfo: return "equalPowerMidSideLfo";
    }
    return "unknown";
}

const char* autoPanWaveformToString(NativeAutoPanWaveform waveform) {
    switch (waveform) {
    case NativeAutoPanWaveform::Sine: return "sine";
    case NativeAutoPanWaveform::Triangle: return "triangle";
    case NativeAutoPanWaveform::Square: return "square";
    }
    return "unknown";
}

const char* nativePitchFallbackReasonToString(NativePitchFallbackReason reason) {
    switch (reason) {
    case NativePitchFallbackReason::None: return "none";
    case NativePitchFallbackReason::NotRequested: return "notRequested";
    case NativePitchFallbackReason::ProcessorNotPrepared: return "processorNotPrepared";
    case NativePitchFallbackReason::PlaybackBufferUnavailable: return "playbackBufferUnavailable";
    case NativePitchFallbackReason::ReversePlayback: return "reversePlayback";
    case NativePitchFallbackReason::UnsupportedChannelCount: return "unsupportedChannelCount";
    case NativePitchFallbackReason::LoopShorterThanLatency: return "loopShorterThanLatency";
    }
    return "unknown";
}

const char* vocoderCarrierStatusToString(NativeVocoderCarrierStatus status) {
    switch (status) {
    case NativeVocoderCarrierStatus::NotRequested: return "notRequested";
    case NativeVocoderCarrierStatus::Ready: return "ready";
    case NativeVocoderCarrierStatus::Empty: return "empty";
    case NativeVocoderCarrierStatus::Stopped: return "stopped";
    case NativeVocoderCarrierStatus::UnsupportedRecording: return "unsupportedRecording";
    case NativeVocoderCarrierStatus::UnsupportedOverdubbing: return "unsupportedOverdubbing";
    case NativeVocoderCarrierStatus::UnsupportedPitchProcessing: return "unsupportedPitchProcessing";
    case NativeVocoderCarrierStatus::HistoryPinned: return "historyPinned";
    case NativeVocoderCarrierStatus::BufferUnavailable: return "bufferUnavailable";
    }
    return "bufferUnavailable";
}

const char* loopTransportStatusToString(LoopTransportStatus status) {
    switch (status) {
    case LoopTransportStatus::Disabled: return "disabled";
    case LoopTransportStatus::WaitingForLoop: return "waitingForLoop";
    case LoopTransportStatus::WaitingForPlayback: return "waitingForPlayback";
    case LoopTransportStatus::Active: return "active";
    case LoopTransportStatus::UnsupportedRecording: return "unsupportedRecording";
    case LoopTransportStatus::UnsupportedOverdubbing: return "unsupportedOverdubbing";
    case LoopTransportStatus::UnsupportedPitchProcessing: return "unsupportedPitchProcessing";
    }
    return "unknown";
}

const char* nativeDubModeToString(NativeDubMode mode) {
    switch (mode) {
    case NativeDubMode::Overdub: return "OVERDUB";
    case NativeDubMode::Replace1: return "REPLACE1";
    case NativeDubMode::Replace2: return "REPLACE2";
    }
    return "OVERDUB";
}

const char* nativeHistoryFailureToString(NativeHistoryFailure failure) {
    switch (failure) {
    case NativeHistoryFailure::None: return "none";
    case NativeHistoryFailure::BudgetExceeded: return "budgetExceeded";
    case NativeHistoryFailure::SnapshotUnavailable: return "snapshotUnavailable";
    case NativeHistoryFailure::NoUndo: return "noUndo";
    case NativeHistoryFailure::NoRedo: return "noRedo";
    case NativeHistoryFailure::TrackMustBeStopped: return "trackMustBeStopped";
    }
    return "unknown";
}

json callbackTelemetryToJson(const NativeCallbackTelemetryStatus& value) {
    const auto count=[](std::uint64_t number,bool observed) {return observed ? json(number) : json(nullptr);};
    const bool hardware=value.hardwareCallbackCount!=0U;
    const auto source=!value.observed ? "NO_CALLBACKS" : !hardware ? "NO_HARDWARE_SIMULATION"
        : value.hardwareCallbackCount==value.callbackCount ? "RTAUDIO_STREAM" : "MIXED_CALLBACK_SOURCES";
    json kinds=json::array();
    const std::array<const char*,3U> names{{"duplex","input","output"}};
    for(std::size_t kind=0U;kind<names.size();++kind) {
        const auto rate=value.latestSampleRate[kind];const auto frames=value.latestBufferFrames[kind];
        kinds.push_back({{"kind",names[kind]},{"callbacks",count(value.callbacksByKind[kind],value.observed)},
            {"latestSampleRateHz",rate!=0U ? json(rate) : json(nullptr)},
            {"latestBufferFrames",value.callbacksByKind[kind]!=0U ? json(frames) : json(nullptr)},
            {"latestBudgetNs",rate!=0U && frames!=0U ? json(static_cast<std::uint64_t>(frames)*1000000000ULL/rate) : json(nullptr)}});
    }
    return {{"schemaVersion",1},{"sourceKind",source},{"observed",value.observed},
        {"counterScope","lifetime; independent relaxed atomic snapshots, not a transactional stream snapshot"},
        {"callbackCount",count(value.callbackCount,value.observed)},
        {"hardwareCallbackCount",count(value.hardwareCallbackCount,hardware)},{"byKind",kinds},
        {"statusFlags",{{"sourceKind",hardware ? "RTAUDIO_CALLBACK_FLAGS_MAY_INCLUDE_MANUAL" : "NO_HARDWARE_CALLBACK_FLAGS"},
            {"inputOverflow",count(value.statusFlags[0U],value.observed)},
            {"outputUnderflow",count(value.statusFlags[1U],value.observed)},
            {"unknownStatus",count(value.statusFlags[2U],value.observed)}}},
        {"driver",{{"sourceKind",hardware ? "RTAUDIO_OPENED_STREAM_FLAGS" : "UNAVAILABLE_NO_REAL_DRIVER_CALLBACK"},
            {"inputOverflow",count(value.hardwareStatusFlags[0U],hardware)},
            {"outputUnderflow",count(value.hardwareStatusFlags[1U],hardware)},
            {"resetCount",nullptr},{"globalStatistics",nullptr}}},
        {"software",{{"sourceKind","NATIVE_CORE_INSTRUMENTATION"},
            {"audioQueueOverflow",count(value.audioQueueOverflow,value.observed)},
            {"audioQueueUnderflow",count(value.audioQueueUnderflow,value.observed)},
            {"controlQueueReject",count(value.controlQueueReject,value.observed || value.controlQueueReject!=0U)},
            {"oversizeCallback",count(value.oversizeCallback,value.observed)},
            {"nonFiniteInput",count(value.nonFiniteInput,value.observed)},
            {"nonFiniteOutput",count(value.nonFiniteOutput,value.observed)},
            {"deadlineMiss",count(value.deadlineMiss,value.deadlineEvaluatedCallbacks!=0U)},
            {"deadlineEvaluatedCallbacks",count(value.deadlineEvaluatedCallbacks,value.observed)},
            {"runtimeResetCount",count(value.runtimeResetCount,value.observed || value.runtimeResetCount!=0U)}}},
        {"duration",{{"sourceKind","STEADY_CLOCK_CALLBACK_ENTRY_TO_POST_OUTPUT_SCAN"},
            {"scope","all callback kinds and buffer/sample-rate configurations; atomic publication cost excluded"},
            {"samples",count(value.timingSamples,value.timingSamples!=0U)},
            {"sampleResolutionFraction",value.timingSamples!=0U ? json(1.0/static_cast<double>(value.timingSamples)) : json(nullptr)},
            {"recommendedMinimumSamplesForP999",10000},
            {"binWidthNs",kNativeCallbackDurationBinWidthNs},{"binCount",kNativeCallbackDurationBins},
            {"overflowSamples",count(value.durationHistogram.back(),value.timingSamples!=0U)},
            {"histogram",value.timingSamples!=0U ? json(value.durationHistogram) : json(nullptr)},
            {"p99UpperBoundNs",value.p99UpperBoundNs ? json(*value.p99UpperBoundNs) : json(nullptr)},
            {"p999UpperBoundNs",value.p999UpperBoundNs ? json(*value.p999UpperBoundNs) : json(nullptr)},
            {"quantileUnavailableReason",value.timingSamples==0U ? json("NO_COMPLETED_CALLBACK")
                : !value.p99UpperBoundNs || !value.p999UpperBoundNs ? json("Selected rank is in unbounded overflow bin") : json(nullptr)},
            {"maximumNs",count(value.maximumDurationNs,value.timingSamples!=0U)}}}};
}

json statusToJson(const EngineStatus& status) {
    json memoryTransports = json::array();
    json memoryDubModes = json::array();
    for (std::size_t track = 0U; track < status.nativeMemoryLoopTransports.size(); ++track) {
        const auto& config = status.nativeMemoryLoopTransports[track];
        memoryTransports.push_back({{"mode", static_cast<unsigned int>(config.mode)},
            {"oneShot", status.nativeLoopTransportAppliedOneShot[track]},
            {"reverse", status.nativeLoopTransportAppliedReverse[track]},
            {"beatOffsetBeats", config.beatOffsetBeats}, {"bpm", config.bpm}, {"crossfadeMs", config.crossfadeMs},
            {"vinylSpeedPercent", config.vinylSpeedPercent}, {"motorReturnSeconds", config.motorReturnSeconds},
            {"brakePercent", config.brakePercent}, {"vinylMixPercent", config.vinylMixPercent}});
    }
    for (const auto mode : status.nativeMemoryDubModes) memoryDubModes.push_back(nativeDubModeToString(mode));
    json bounceIn = json::array();
    json bounceTrack = json::array();
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        bounceIn.push_back(status.nativeBounce.bounceIn[track]);
        bounceTrack.push_back(status.nativeBounce.bounceTrack[track]);
    }
    json nativeTracks = json::array();
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        const auto& history = status.nativeTrackHistory[track];
        const auto& mark = status.nativeTrackMarks[track];
        nativeTracks.push_back({
            {"trackId", track + 1U},
            {"state", looperStateToString(status.nativeTrackStates[track])},
            {"loopProgress", status.nativeTrackProgress[track]},
            {"contentRevision", status.nativeTrackContentRevision[track]},
            {"loopTransportRequestedRevision", status.nativeLoopTransportRequestedRevision[track]},
            {"loopTransportAppliedRevision", status.nativeLoopTransportAppliedRevision[track]},
            {"loopTransportFaultRevision", status.nativeLoopTransportFaultRevision[track]},
            {"loopTransportAppliedOneShot", status.nativeLoopTransportAppliedOneShot[track]},
            {"loopTransportAppliedReverse", status.nativeLoopTransportAppliedReverse[track]},
            {"loopTransportStatus", loopTransportStatusToString(status.nativeTrackLoopTransportStatus[track])},
            {"dubMode", {
                {"applied", nativeDubModeToString(status.nativeTrackDubModes[track])},
                {"requested", nativeDubModeToString(status.nativeTrackRequestedDubModes[track])},
                {"requestedRevision", status.nativeDubModeRequestedRevision[track]},
                {"appliedRevision", status.nativeDubModeAppliedRevision[track]},
            }},
            {"vocoderCarrierStatus", vocoderCarrierStatusToString(status.nativeVocoderCarrierStatuses[track])},
            {"history", {
                {"canUndo", history.canUndo},
                {"canRedo", history.canRedo},
                {"retainedPcmBytes", history.retainedPcmBytes},
                {"unavailableReason", nativeHistoryFailureToString(history.unavailableReason)},
            }},
            {"mark", {
                {"exists", mark.exists},
                {"canSet", mark.canSet},
                {"canClear", mark.canClear},
                {"busy", mark.busy},
                {"retainedPcmBytes", mark.retainedPcmBytes},
                {"unavailableReason", mark.unavailableReason},
                {"requestedGeneration", mark.requestedGeneration},
                {"appliedGeneration", mark.appliedGeneration},
            }},
        });
    }
    json trackOutputLayout = json::array();
    json activeTrackOutputSlots = json::array();
    json catalogEffectIds = json::array();
    json catalogSlots = json::array();
    json inputCatalogSlots = json::array();
    json perTrackCatalogBanks = json::array();
    json inputOscVocSlots = json::array();
    json trackOscVocSlots = json::array();
    json inputCatalogMidiSlots = json::array();
    json trackCatalogMidiSlots = json::array();
    json trackFxApply = json::array();
    json catalogEffectAvailability = json::array();
    std::size_t catalogCount = 0U;
    const auto* catalog = nativeEffectCatalog(catalogCount);
    for (std::size_t index = 0U; index < catalogCount; ++index) {
        catalogEffectIds.push_back(catalog[index].id);
        json parameters = json::array();
        for (std::size_t parameterIndex = 0U; parameterIndex < catalog[index].parameterCount; ++parameterIndex) {
            const auto& parameter = catalog[index].parameters[parameterIndex];
            json descriptor{
                {"id", parameter.id}, {"label", parameter.label},
                {"minimum", parameter.minimum}, {"maximum", parameter.maximum},
                {"defaultValue", parameter.defaultValue}, {"smoothingMs", parameter.smoothingMs},
                {"discrete", parameter.discrete},
            };
            if (parameter.discreteValues != nullptr && parameter.discreteValueCount > 0U) {
                json choices = json::array();
                for (std::size_t choiceIndex = 0U; choiceIndex < parameter.discreteValueCount; ++choiceIndex) {
                    choices.push_back(parameter.discreteValues[choiceIndex]);
                }
                descriptor["discreteValues"] = std::move(choices);
            }
            parameters.push_back(std::move(descriptor));
        }
        json officialParameters = json::array();
        std::size_t officialParameterCount = 0U;
        const auto* officialDescriptors = nativeEffectOfficialParameters(catalog[index].id, officialParameterCount);
        for (std::size_t parameterIndex = 0U; parameterIndex < officialParameterCount; ++parameterIndex) {
            const auto& parameter = officialDescriptors[parameterIndex];
            json descriptor{
                {"id", parameter.id}, {"label", parameter.label},
                {"minimum", parameter.minimum}, {"maximum", parameter.maximum},
                {"defaultValue", parameter.defaultValue}, {"smoothingMs", parameter.smoothingMs},
                {"discrete", parameter.discrete}, {"implementation", "clean-room"},
                {"hardwareEquivalent", false},
            };
            if (parameter.discreteValues != nullptr && parameter.discreteValueCount > 0U) {
                json choices = json::array();
                for (std::size_t choiceIndex = 0U; choiceIndex < parameter.discreteValueCount; ++choiceIndex)
                    choices.push_back(parameter.discreteValues[choiceIndex]);
                descriptor["discreteValues"] = std::move(choices);
            }
            if (catalog[index].id == "vinyl_flick" || catalog[index].id == "beat_shift") {
                descriptor["semanticSupport"] = "partial_source_modes";
                descriptor["limitation"] = "Source-aware finalized forward loop playback in shared Track FX A only; recording, overdubbing and LIVE pitch/reverse processing are not supported. Bare streaming DSP rejects these controls.";
            }
            if (catalog[index].id == "vocoder" && parameter.id == "official_carrier") {
                descriptor["semanticSupport"] = "partial_source_modes";
                descriptor["limitation"] = "TRACK1-5 only, finalized Playing pre-FX/pre-LIVE-pitch source, same-block read-only tap. Empty/stopped/recording/overdub/pitch-conflicted/pinned sources are silent. Physical MIC/INST sources and CARRIER THRU are unsupported.";
            }
            if (catalog[index].id == "tape_echo" || catalog[index].id == "roll") {
                descriptor["applicableVariants"] = json::array();
                for (unsigned int variant = 1U; variant <= 2U; ++variant) {
                    const auto* domain = official::parameterDomain(nativeEffectOfficialDomainId(catalog[index].id, variant), parameter.id);
                    if (parameter.id == "official_variant" || domain != nullptr)
                        descriptor["applicableVariants"].push_back(variant);
                    if (domain != nullptr) {
                        json choices = json::array();
                        for (std::size_t choice = 0U; choice < domain->count; ++choice)
                            choices.push_back(official::kDomainOptions[domain->offset + choice]);
                        descriptor["variantDomains"][std::to_string(variant)] = {
                            {"minimum", domain->minimum}, {"maximum", domain->maximum}, {"step", domain->step},
                            {"values", choices}, {"documentedDefault", domain->hasDefault ? json(domain->defaultValue) : json(nullptr)}};
                    }
                }
                if (parameter.id == "official_variant") descriptor["provenance"] = "routing";
            }
            officialParameters.push_back(std::move(descriptor));
        }
        std::size_t legacyAliasCount = 0U;
        const auto* legacyAliases = nativeEffectLegacyParameterAliases(catalog[index].id, legacyAliasCount);
        json legacyParameters = json::array();
        for (std::size_t aliasIndex = 0U; aliasIndex < legacyAliasCount; ++aliasIndex) {
            const auto& alias = legacyAliases[aliasIndex];
            legacyParameters.push_back({
                {"id", alias.id}, {"label", alias.label},
                {"minimum", alias.minimum}, {"maximum", alias.maximum},
                {"defaultValue", alias.defaultValue}, {"smoothingMs", alias.smoothingMs},
                {"discrete", alias.discrete}, {"legacyAlias", true},
            });
        }
        catalogEffectAvailability.push_back({
            {"effectId", catalog[index].id},
            {"sourceIndex", catalog[index].sourceIndex},
            {"input", catalog[index].inputAvailable},
            {"track", catalog[index].trackAvailable},
            {"perTrackInsert", nativeEffectSupportsPerTrackInsert(catalog[index].id)},
            {"parameters", parameters},
            {"officialParameters", officialParameters},
            {"legacyParameterAliases", legacyParameters},
        });
    }
    for (std::size_t slot = 0; slot < NativeTrackOutputBank::kSlotNames.size(); ++slot) {
        trackOutputLayout.push_back(NativeTrackOutputBank::kSlotNames[slot]);
        if (status.nativeTrackOutputSlotActive[slot]) {
            activeTrackOutputSlots.push_back(NativeTrackOutputBank::kSlotNames[slot]);
        }
    }
    const auto catalogSlotJson = [](std::size_t slot, const auto& item) {
        return json{{"slot", NativeEffectBank::kSlotNames[slot]}, {"effectId", item.effectId},
            {"parameters", item.parameters}, {"bypassed", item.bypassed}, {"appliedBypassed", item.appliedBypassed},
            {"prepared", item.prepared}, {"processingFaulted", item.processingFaulted},
            {"controlFaulted", item.controlFaulted}, {"requestedRevision", item.requestedRevision},
            {"appliedRevision", item.appliedRevision}};
    };
    for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
        catalogSlots.push_back(catalogSlotJson(slot, status.nativeCatalogSlots[slot]));
        inputCatalogSlots.push_back(catalogSlotJson(slot, status.nativeInputCatalogSlots[slot]));
        const auto& inputOscVoc = status.nativeInputOscVocSlots[slot];
        inputOscVocSlots.push_back({
            {"slot", NativeEffectBank::kSlotNames[slot]},
            {"selected", inputOscVoc.selected},
            {"currentFrame", inputOscVoc.currentFrame},
            {"queuedEvents", inputOscVoc.queuedEvents},
            {"overflowEventCount", inputOscVoc.overflowEventCount},
            {"lateEventCount", inputOscVoc.lateEventCount},
            {"rejectedEventCount", inputOscVoc.rejectedEventCount},
        });
        const auto& trackOscVoc = status.nativeTrackOscVocSlots[slot];
        trackOscVocSlots.push_back({
            {"slot", NativeEffectBank::kSlotNames[slot]},
            {"selected", trackOscVoc.selected},
            {"currentFrame", trackOscVoc.currentFrame},
            {"queuedEvents", trackOscVoc.queuedEvents},
            {"overflowEventCount", trackOscVoc.overflowEventCount},
            {"lateEventCount", trackOscVoc.lateEventCount},
            {"rejectedEventCount", trackOscVoc.rejectedEventCount},
        });
        const auto& inputCatalogMidi = status.nativeInputCatalogMidiSlots[slot];
        inputCatalogMidiSlots.push_back({
            {"slot", NativeEffectBank::kSlotNames[slot]},
            {"selected", inputCatalogMidi.selected},
            {"effectId", inputCatalogMidi.effectId},
            {"queueCapacity", inputCatalogMidi.queueCapacity},
            {"currentFrame", inputCatalogMidi.currentFrame},
            {"queuedEvents", inputCatalogMidi.queuedEvents},
            {"overflowEventCount", inputCatalogMidi.overflowEventCount},
            {"lateEventCount", inputCatalogMidi.lateEventCount},
            {"rejectedEventCount", inputCatalogMidi.rejectedEventCount},
        });
        const auto& trackCatalogMidi = status.nativeTrackCatalogMidiSlots[slot];
        trackCatalogMidiSlots.push_back({
            {"slot", NativeEffectBank::kSlotNames[slot]},
            {"selected", trackCatalogMidi.selected},
            {"effectId", trackCatalogMidi.effectId},
            {"queueCapacity", trackCatalogMidi.queueCapacity},
            {"currentFrame", trackCatalogMidi.currentFrame},
            {"queuedEvents", trackCatalogMidi.queuedEvents},
            {"overflowEventCount", trackCatalogMidi.overflowEventCount},
            {"lateEventCount", trackCatalogMidi.lateEventCount},
            {"rejectedEventCount", trackCatalogMidi.rejectedEventCount},
        });
    }
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        json slots = json::array();
        json midiSlots = json::array();
        for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
            const auto& item = status.nativePerTrackCatalogSlots[track][slot];
            slots.push_back(catalogSlotJson(slot, item));
            const auto& midi = status.nativePerTrackCatalogMidiSlots[track][slot];
            midiSlots.push_back({{"slot", NativeEffectBank::kSlotNames[slot]}, {"selected", midi.selected},
                {"effectId", midi.effectId}, {"queueCapacity", midi.queueCapacity}, {"currentFrame", midi.currentFrame},
                {"queuedEvents", midi.queuedEvents}, {"overflowEventCount", midi.overflowEventCount},
                {"lateEventCount", midi.lateEventCount}, {"rejectedEventCount", midi.rejectedEventCount}});
        }
        perTrackCatalogBanks.push_back({{"trackId", track + 1U}, {"slots", slots}, {"midiSlots", midiSlots}});
        const auto& apply = status.nativeTrackFxApply[track];
        trackFxApply.push_back({
            {"trackId", track + 1U},
            {"requested", apply.requested},
            {"applied", apply.applied},
            {"requestedRevision", apply.requestedRevision},
            {"appliedRevision", apply.appliedRevision},
            {"semanticRevision", apply.semanticRevision},
            {"controlFaulted", apply.controlFaulted},
            {"peak", apply.peak},
            {"rms", apply.rms},
        });
    }
    return json{
        {"ok", true},
        {"mixerLevels", status.mixerLevels},
        {"nativeRecordPlay", {{"version", 1}, {"recActionAvailable", true}, {"quantizeAvailable", false},
            {"recAction", status.nativeRecordActionDub ? "REC->DUB" : "REC->PLAY"},
            {"requestedRevision", status.nativeRecordActionRequestedRevision}, {"appliedRevision", status.nativeRecordActionAppliedRevision},
            {"finishRequested", status.nativeRecordFinishRequested}, {"finishApplied", status.nativeRecordFinishApplied}, {"finishCancelled", status.nativeRecordFinishCancelled},
            {"stopRequested", status.nativeRecordStopRequested}, {"stopApplied", status.nativeRecordStopApplied},
            {"stopCommittedRevision", status.nativeRecordStopCommittedRevision}}},
        {"nativeRecordTempoProvenance", {{"version", 1},
            {"requestedRevision", status.nativeRecordTempoConfirmRequested},
            {"appliedRevision", status.nativeRecordTempoConfirmApplied},
            {"acceptedRevision", status.nativeRecordTempoConfirmAccepted}}},
        {"bridgeHealthy", status.bridgeHealthy},
        {"engineRunning", status.engineRunning},
        {"backend", backendToString(status.backend)},
        {"inputDeviceId", status.inputDeviceId},
        {"outputDeviceId", status.outputDeviceId},
        {"inputDeviceName", status.inputDeviceName},
        {"outputDeviceName", status.outputDeviceName},
        {"sampleRate", status.sampleRate},
        {"bufferFrames", status.bufferFrames},
        {"hostIncarnationId", hostIncarnationId()},
        {"projectContentRevision", status.projectContentRevision},
        {"projectContentRevisionSnapshotStable", status.projectContentRevisionSnapshotStable},
        {"monitoringEnabled", status.monitoringEnabled},
        {"nativeFx", {
            {"parameterSchemaVersion", 1},
            {"catalogParameterReplacement", true},
            {"implementedCatalogEffects", catalogEffectIds},
            {"catalogEffectAvailability", catalogEffectAvailability},
            {"implementedOutputEffects", {"lowPass", "highPass", "fdn16Reverb", "fractionalDelay", "compressor", "chorus", "phaser"}},
            {"catalogGraphAvailable", status.nativeCatalogGraphAvailable},
            {"catalogSlots", catalogSlots},
            {"trackFxApplyAvailable", status.nativeTrackFxApplyAvailable},
            {"trackFxApply", trackFxApply},
            {"perTrackCatalogAvailable", status.nativePerTrackCatalogAvailable},
            {"sourceAwareLoopTransport", {{"experimental", true}, {"stage", "preInsert"},
                {"orderedInsertPlacementSupported", false}, {"effects", {"beat_shift", "vinyl_flick"}},
                {"statusNote", "Separate source-read transport stage before per-track A-D. Recording and overdubbing transport are unsupported. These source-aware effects cannot be selected in ordered per-track insert slots."}}},
            {"perTrackCatalogBanks", perTrackCatalogBanks},
            {"catalogControlFaultCount", status.nativeCatalogControlFaultCount},
            {"inputCatalogSlots", inputCatalogSlots},
            {"oscVocMidi", {
                {"eventQueueCapacity", kNativeOscVocEventQueueCapacity},
                {"currentSampleFrame", status.nativeSampleFrame},
                {"inputSlots", inputOscVocSlots},
                {"trackSlots", trackOscVocSlots},
                {"statusNote", "MIDI note events are queued by absolute Native sample frame to exactly one selected OSC VOC (M) Input or explicitly targeted Track slot (trackId 0 shared, 1-5 pre-sum); bridge channels are 1-based (1-16)."},
            }},
            {"catalogMidi", {
                {"inputSlots", inputCatalogMidiSlots},
                {"trackSlots", trackCatalogMidiSlots},
                {"statusNote", "Catalog MIDI events are sample-frame scheduled to one explicitly selected supported MIDI processor slot in Input A-D or Track A-D target 0 (shared) or 1-5 (independent pre-sum). queueCapacity is reported per slot because processors may have different bounded queue sizes."},
            }},
            {"catalogPathNote", "Input A-D precedes recording/monitoring and only accepts trackId 0. Track trackId 1-5 selects one independent pre-sum playback-only A-D chain; trackId omitted or 0 preserves the legacy shared summed-playback bank. Per-track pitch precedes that track's A-D chain; shared A-D and global pitch follow summing. Monitoring/rhythm and recorded PCM are outside these playback FX chains. Selected chains process silence for effect tails while stopped."},
            {"outputLowPassAvailable", status.nativeOutputLowPassAvailable},
            {"outputLowPassEnabled", status.nativeOutputLowPassEnabled},
            {"outputHighPassAvailable", status.nativeOutputHighPassAvailable},
            {"outputHighPassEnabled", status.nativeOutputHighPassEnabled},
            {"outputDriveAvailable", status.nativeOutputDriveAvailable},
            {"outputDriveEnabled", status.nativeOutputDriveEnabled},
            {"outputReverbAvailable", status.nativeReverbAvailable},
            {"outputReverbEnabled", status.nativeReverbEnabled},
            {"outputReverbWetMix", status.nativeReverbWetMix},
            {"outputReverbRt60Seconds", status.nativeReverbRt60Seconds},
            {"outputReverbDampingCutoffHz", status.nativeReverbDampingCutoffHz},
            {"outputReverbAlgorithmicLatencyFrames", status.nativeReverbAlgorithmicLatencyFrames},
            {"trackOutputBank", {
                {"available", status.nativeTrackOutputBankAvailable},
                {"layout", trackOutputLayout},
                {"activeSlots", activeTrackOutputSlots},
                {"multiTrackImplemented", status.nativeTrackOutputMultiTrackImplemented},
                {"statusNote", "Legacy global output-stage controls are postmix and use slot A. Native Input catalog A-D runs before the five stereo loopers record/monitor; Native Track catalog target 0 runs on the summed loop-playback bus; explicit targets 1-5 each run an independent playback-only A-D chain before summing. These legacy output-stage controls remain global."},
            }},
            {"fractionalDelay", {
                {"available", status.nativeFractionalDelayAvailable},
                {"enabled", status.nativeFractionalDelayEnabled},
                {"slot", outputSlotToString(status.nativeFractionalDelaySlot)},
                {"algorithm", fractionalDelayAlgorithmToString(status.nativeFractionalDelayAlgorithm)},
                {"delayMs", status.nativeFractionalDelayMs},
                {"wetMix", status.nativeFractionalDelayWetMix},
                {"feedback", status.nativeFractionalDelayFeedback},
                {"maxDelayMs", status.nativeFractionalDelayMaxMs},
                {"statusNote", "Fractional delay uses cubic 4-point Lagrange interpolation on Native output slot A; no other output slot or algorithm is implemented."},
            }},
            {"compressor", {
                {"available", status.nativeCompressorAvailable},
                {"enabled", status.nativeCompressorEnabled},
                {"slot", outputSlotToString(status.nativeCompressorSlot)},
                {"algorithm", compressorAlgorithmToString(status.nativeCompressorAlgorithm)},
                {"thresholdDb", status.nativeCompressorThresholdDb},
                {"ratio", status.nativeCompressorRatio},
                {"attackMs", status.nativeCompressorAttackMs},
                {"releaseMs", status.nativeCompressorReleaseMs},
                {"wetMix", status.nativeCompressorWetMix},
                {"makeupDb", status.nativeCompressorMakeupDb},
                {"statusNote", "One stereo-linked peak compressor is implemented on Native output slot A; slots B-D and other dynamics algorithms are unavailable."},
            }},
            {"chorus", {
                {"available", status.nativeChorusAvailable},
                {"enabled", status.nativeChorusEnabled},
                {"slot", outputSlotToString(status.nativeChorusSlot)},
                {"algorithm", chorusAlgorithmToString(status.nativeChorusAlgorithm)},
                {"rateHz", status.nativeChorusRateHz},
                {"depthMs", status.nativeChorusDepthMs},
                {"feedback", status.nativeChorusFeedback},
                {"wetMix", status.nativeChorusWetMix},
                {"statusNote", "Clean-room stereo chorus uses quadrature sine LFOs, Lagrange4 interpolation, and a 30 ms center delay with the configured depth around it; only slot A is active."},
            }},
            {"phaser", {
                {"available", status.nativePhaserAvailable},
                {"enabled", status.nativePhaserEnabled},
                {"slot", outputSlotToString(status.nativePhaserSlot)},
                {"algorithm", phaserAlgorithmToString(status.nativePhaserAlgorithm)},
                {"stages", status.nativePhaserStages},
                {"rateHz", status.nativePhaserRateHz},
                {"depth", status.nativePhaserDepth},
                {"feedback", status.nativePhaserFeedback},
                {"wetMix", status.nativePhaserWetMix},
                {"statusNote", "Clean-room single-sweep phaser uses 4/8/12 cascaded first-order all-pass sections with smoothed modulation and bounded feedback on slot A; BI-PHASE dual sweeps are not implemented."},
            }},
            {"autoPan", {
                {"available", status.nativeAutoPanAvailable},
                {"enabled", status.nativeAutoPanEnabled},
                {"slot", outputSlotToString(status.nativeAutoPanSlot)},
                {"algorithm", autoPanAlgorithmToString(status.nativeAutoPanAlgorithm)},
                {"rateHz", status.nativeAutoPanRateHz},
                {"depth", status.nativeAutoPanDepth},
                {"waveform", autoPanWaveformToString(status.nativeAutoPanWaveform)},
                {"wetMix", status.nativeAutoPanWetMix},
                {"statusNote", "Compatibility AUTO PAN control maps to catalog slot A. It uses mid/side rotation with smoothed Side narrowing; the general catalog-slots endpoint exposes A-D. The Native engine has five independent stereo loopers, and shared rhythm/monitoring stages are outside the playback-only A-D chain."},
            }},
            {"fullFxGraphImplemented", status.fullFxGraphImplemented},
            {"statusNote", "The Native playback-only catalog A-D serial chain processes the summed playback bus from five independent stereo loopers once and is independent of global post-output stages; only catalog effects listed in implementedCatalogEffects are executable. Five independent per-looper catalog A-D chains are available through explicit trackId 1-5; omitted/0 retains the shared bank. This does not claim the full Browser catalog or hardware graph is implemented. The output stage also exposes optional low-pass, high-pass, clean-room 16-line FDN reverb, Lagrange4 fractional delay, a peak compressor, stereo chorus, and a single-sweep all-pass phaser. The FDN has no block buffering; its shortest delay is algorithmic echo timing, not acoustic or device latency. Effects remain clean-room functional reconstructions, not Roland DSP emulation."},
        }},
        {"nativeRhythm", {
            {"available", status.nativeRhythmAvailable},
            {"enabled", status.nativeRhythmEnabled},
            {"patternCatalogAvailable", status.nativeRhythmPatternCatalogAvailable},
            {"patternIndex", status.nativeRhythmPatternIndex},
            {"patternId", status.nativeRhythmPatternId},
            {"genre", status.nativeRhythmGenre},
            {"pattern", status.nativeRhythmPatternName},
            {"beat", status.nativeRhythmBeat},
            {"meterNumerator", status.nativeRhythmMeterNumerator},
            {"meterDenominator", status.nativeRhythmMeterDenominator},
            {"eventsCleanRoomProcedural", status.nativeRhythmEventsCleanRoomProcedural},
            {"bpm", status.nativeRhythmBpm},
            {"tempoRequestedRevision", status.nativeTempoRequestedRevision},
            {"tempoAppliedRevision", status.nativeTempoAppliedRevision},
            {"tempoAppliedValid", status.nativeTempoAppliedValid},
            {"kitIndex", status.nativeRhythmKitIndex},
            {"variation", nativeRhythmVariationToString(status.nativeRhythmVariation)},
            {"section", nativeRhythmSectionToString(status.nativeRhythmSection)},
            {"swingPercent", status.nativeRhythmSwingPercent},
            {"quantizeGrid", nativeRhythmQuantizeGridToString(status.nativeRhythmQuantizeGrid)},
            {"volume", status.nativeRhythmVolume},
            {"patternSource", "metadata-only-240-pattern-catalog"},
            {"statusNote", "Pattern names, styles, meter, and source notes are metadata-only projections of the 240-entry Browser catalog. Audio events are generated procedurally in clean-room code with 16 synthetic timbre profiles; factory MIDI, event sequences, and samples are not implemented."},
        }},
        {"nativePitch", {
            {"pitchCorrectionAvailable", status.nativePitchCorrectionAvailable},
            {"pitchCorrectionImplemented", status.nativePitchCorrectionImplemented},
            {"enabled", status.nativePitchEnabled},
            {"active", status.nativePitchActive},
            {"trackId", status.nativePitchTrackId},
            {"reversePlayback", status.nativePitchReversePlayback},
            {"mode", status.nativePitchMode == NativePitchMode::LivePolyPhaseVocoder
                ? "livePolyPhaseVocoder" : "liveMonoKeepPitch"},
            {"algorithm", status.nativePitchMode == NativePitchMode::LivePolyPhaseVocoder
                ? "signalsmithStretch132Cheaper" : "cleanRoomYinPsola"},
            {"semitones", status.nativePitchSemitones},
            {"frequencyHz", status.nativePitchFrequencyHz},
            {"confidence", status.nativePitchConfidence},
            {"voiced", status.nativePitchVoiced},
            {"latencySamples", status.nativePitchLatencySamples},
            {"fallbackReason", nativePitchFallbackReasonToString(status.nativePitchFallbackReason)},
            {"statusNote", "Native LIVE_MONO and LIVE_POLY use one bounded pitch processor. trackId 0 preserves the legacy route on the summed playback bus after the shared A-D bank; trackId 1-5 processes only that loop before it is mixed with other playback, before that track's independent A-D chain and the shared playback mix chain. Live monitoring/recording, input FX, rhythm, and global output stages remain outside the pitch path. Reverse playback and a selected loop no longer than the configured latency fall back dry. HQ_RENDER uses a metadata preflight, audio-callback-pinned loop snapshot, and optional C++ Rubber Band offline renderer; WAV encoding occurs in the UI."},
        }},
        {"state", looperStateToString(status.state)},
        {"inputLatencyMs", status.inputLatencyMs},
        {"outputLatencyMs", status.outputLatencyMs},
        {"roundTripEstimateMs", status.roundTripEstimateMs},
        {"inputPeak", status.inputPeak},
        {"outputPeak", status.outputPeak},
        {"xrunsOrDropouts", status.xrunsOrDropouts},
        {"callbackTelemetry", callbackTelemetryToJson(status.callbackTelemetry)},
        {"lastError", status.lastError},
        {"loopProgress", status.loopProgress},
        {"nativeLooperTrackCount", status.nativeLooperTrackCount},
        {"nativeLooperMultiTrackImplemented", status.nativeLooperMultiTrackImplemented},
        {"nativeLooperTracksStereo", status.nativeLooperTracksStereo},
        {"projectArchiveV2Supported", status.projectArchiveV2Supported},
        {"nativeTempoRecordProvenanceVersion", 1U},
        {"nativeLooperMaxRecordSeconds", status.nativeLooperMaxRecordSeconds},
        {"nativeLooperPreallocatedBytes", status.nativeLooperPreallocatedBytes},
        {"nativeLooperStorageBudgetBytes", status.nativeLooperStorageBudgetBytes},
        {"nativeTracks", nativeTracks},
        {"nativeMemory", {{"version", 1U}, {"loopTransports", memoryTransports}, {"dubModes", memoryDubModes},
            {"bounce", {{"bounceSw", status.nativeBounce.bounceSw}, {"bounceIn", bounceIn}, {"bounceTrack", bounceTrack}}}}},
        {"nativeBounce", {{"version", 1U}, {"bounceSw", status.nativeBounce.bounceSw}, {"bounceIn", bounceIn}, {"bounceTrack", bounceTrack},
            {"requestedRevision", status.nativeBounceRequestedRevision}, {"appliedRevision", status.nativeBounceAppliedRevision},
            {"sourceTap", "pre-track-insert"}, {"hardwareFxPlacementVerified", false}}},
        {"nativeHistory", {
            {"budgetBytes", status.nativeHistoryBudgetBytes},
            {"retainedBytes", status.nativeHistoryRetainedBytes},
        }},
        {"nativeMarkVersion", status.nativeMarkVersion},
        {"nativeMarks", {
            {"budgetBytes", status.nativeMarkBudgetBytes},
            {"retainedBytes", status.nativeMarkRetainedBytes},
        }},
        {"streamTimeSeconds", status.streamTimeSeconds},
        {"callbackTicks", status.callbackTicks},
#if defined(NATIVE_RUBBERBAND_HQ_AVAILABLE)
        {"nativeHqRenderer", {
            {"available", true},
            {"engines", json::array({"R2", "R3"})},
            {"algorithm", "RubberBandOffline"},
            {"license", "GPL-2.0-or-later"},
            {"statusNote", "Native HQ_RENDER is an offline Rubber Band R2/R3 renderer. It is never called from the audio callback."},
        }},
#else
        {"nativeHqRenderer", {
            {"available", false},
            {"engines", json::array()},
            {"algorithm", "unavailable"},
            {"statusNote", "Native Rubber Band HQ_RENDER was disabled at build time; no pitch-shifted fallback is used."},
        }},
#endif
        {"nativeSampleFrame", status.nativeSampleFrame},
    };
}

void writeJson(httplib::Response& response, const json& payload) {
    response.set_content(payload.dump(), "application/json");
}

void writeError(httplib::Response& response, const std::string& error) {
    writeJson(response, json{{"ok", false}, {"error", error}});
}

const char* projectImportStateToString(NativeProjectImportState state) {
    switch (state) {
    case NativeProjectImportState::Idle: return "idle";
    case NativeProjectImportState::Prepared: return "prepared";
    case NativeProjectImportState::Pending: return "pending";
    case NativeProjectImportState::Claimed: return "claimed";
    case NativeProjectImportState::Committed: return "committed";
    case NativeProjectImportState::Cancelled: return "cancelled";
    }
    return "unknown";
}

json projectImportStatusToJson(const NativeProjectImportStatus& status) {
    json result{
        {"ok", true},
        {"hostIncarnationId", hostIncarnationId()},
        {"generation", status.generation},
        {"state", projectImportStateToString(status.state)},
    };
    if (!status.error.empty()) result["error"] = status.error;
    if (status.state == NativeProjectImportState::Committed && status.projectContentRevision > 0U) {
        result["projectContentRevision"] = status.projectContentRevision;
    }
    return result;
}

bool parseProjectImportGeneration(const std::string& text, std::uint64_t& generation) {
    if (text.empty()) return false;
    const auto [end, status] = std::from_chars(text.data(), text.data() + text.size(), generation);
    return status == std::errc{} && end == text.data() + text.size() && generation != 0U;
}

bool parseProjectImportExpectedContentRevision(const httplib::Request& request, std::uint64_t& revision) {
    // cpp-httplib intentionally de-duplicates identical raw query pairs in
    // its Params map. Checking only get_param_value_count() therefore cannot
    // distinguish `?expectedContentRevision=7` from
    // `?expectedContentRevision=7&expectedContentRevision=7`. Require the
    // single canonical raw target before consulting the decoded query map.
    constexpr std::string_view prefix = "/v1/project/import?expectedContentRevision=";
    if (request.target.compare(0U, prefix.size(), prefix) != 0) return false;
    const auto value = std::string_view(request.target).substr(prefix.size());
    if (value.empty() || value.find_first_not_of("0123456789") != std::string_view::npos ||
        request.get_param_value_count("expectedContentRevision") != 1U ||
        request.get_param_value("expectedContentRevision") != value) return false;
    const auto [end, status] = std::from_chars(value.data(), value.data() + value.size(), revision);
    return status == std::errc{} && end == value.data() + value.size();
}

bool parseProjectImportContentLength(const httplib::Request& request, std::uint64_t& byteLength) {
    if (request.get_header_value_count("Content-Length") != 1U) return false;
    const auto value = request.get_header_value("Content-Length");
    if (value.empty()) return false;
    const auto [end, status] = std::from_chars(value.data(), value.data() + value.size(), byteLength);
    return status == std::errc{} && end == value.data() + value.size();
}

std::string normalizedHeaderValue(std::string value) {
    const auto isSpace = [](unsigned char character) { return character == ' ' || character == '\t'; };
    while (!value.empty() && isSpace(static_cast<unsigned char>(value.front()))) value.erase(value.begin());
    while (!value.empty() && isSpace(static_cast<unsigned char>(value.back()))) value.pop_back();
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    return value;
}

bool readUnsignedJsonInteger(const json& value, std::uint64_t maximum, std::uint64_t& result) {
    if (value.is_number_unsigned()) {
        result = value.get<std::uint64_t>();
        return result <= maximum;
    }
    if (!value.is_number_integer()) return false;
    const auto signedValue = value.get<std::int64_t>();
    if (signedValue < 0) return false;
    result = static_cast<std::uint64_t>(signedValue);
    return result <= maximum;
}

bool readRecordTempoToken(const httplib::Request& request, std::optional<double>& bpm, std::uint64_t& revision) {
    const bool hasBpm = request.has_param("tempoBpm");
    const bool hasRevision = request.has_param("tempoRevision");
    if (!hasBpm && !hasRevision) { bpm.reset(); revision = 0U; return true; }
    if (!hasBpm || !hasRevision || request.get_param_value_count("tempoBpm") != 1U ||
        request.get_param_value_count("tempoRevision") != 1U) return false;
    try {
        const auto bpmText = request.get_param_value("tempoBpm");
        std::size_t consumed = 0U;
        const double value = std::stod(bpmText, &consumed);
        if (consumed != bpmText.size() || !std::isfinite(value) || value < 40.0 || value > 300.0) return false;
        const auto revisionText = request.get_param_value("tempoRevision");
        const auto [end, status] = std::from_chars(revisionText.data(), revisionText.data() + revisionText.size(), revision);
        if (status != std::errc{} || end != revisionText.data() + revisionText.size() ||
            revision > kMaximumSafeTempoRevision) return false;
        bpm = value;
        return true;
    } catch (...) { return false; }
}

bool readRecordTempoToken(const json& body, std::optional<double>& bpm, std::uint64_t& revision) {
    const bool hasBpm = body.contains("tempoBpm");
    const bool hasRevision = body.contains("tempoRevision");
    if (!hasBpm && !hasRevision) { bpm.reset(); revision = 0U; return true; }
    std::uint64_t parsedRevision = 0U;
    if (!hasBpm || !hasRevision || !body.at("tempoBpm").is_number() ||
        !readUnsignedJsonInteger(body.at("tempoRevision"), kMaximumSafeTempoRevision, parsedRevision)) return false;
    const double value = body.at("tempoBpm").get<double>();
    if (!std::isfinite(value) || value < 40.0 || value > 300.0) return false;
    bpm = value; revision = parsedRevision;
    return true;
}

bool isAllowedUiOrigin(const std::string& origin) {
    // The bridge is an unauthenticated loopback control API. Only the exact
    // local Vite dev/preview origins used by the project are allowed to issue
    // browser requests; do not reflect arbitrary loopback ports or remote
    // origins from webpages running on the same machine.
    return origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173" ||
        origin == "http://localhost:4173" || origin == "http://127.0.0.1:4173" ||
        origin == "http://localhost:4174" || origin == "http://127.0.0.1:4174";
}

bool readTrackIndex(const httplib::Request& request, std::size_t& trackIndex, std::string& error) {
    // Legacy transport and snapshot URLs without a selector continue to mean
    // Track 1. Public track IDs are one-based; NativeAudioCore uses zero-based.
    trackIndex = 0U;
    if (!request.has_param("trackId")) return true;
    const std::string value = request.get_param_value("trackId");
    unsigned int trackId = 0U;
    const auto [end, status] = std::from_chars(value.data(), value.data() + value.size(), trackId);
    if (status != std::errc{} || end != value.data() + value.size() || trackId < 1U || trackId > kNativeTrackCount) {
        error = "Native trackId must be an integer between 1 and 5.";
        return false;
    }
    trackIndex = static_cast<std::size_t>(trackId - 1U);
    return true;
}

bool readTrackMarkRequest(const httplib::Request& request, std::string_view path,
                          std::size_t& trackIndex, std::uint64_t& generation, std::string& error) {
    const std::string prefix = std::string(path) + "?trackId=";
    if (request.target.compare(0U, prefix.size(), prefix) != 0 ||
        request.get_param_value_count("trackId") != 1U ||
        request.get_param_value_count("generation") != 1U) {
        error = "Native MARK requests require exactly one trackId and generation query parameter.";
        return false;
    }
    const auto rawQuery = std::string_view(request.target).substr(prefix.size());
    const auto separator = rawQuery.find("&generation=");
    if (separator == std::string_view::npos || rawQuery.find('&', separator + 1U) != std::string_view::npos ||
        rawQuery.find('?', 0U) != std::string_view::npos) {
        error = "Native MARK requests require the canonical trackId and generation query.";
        return false;
    }
    const auto rawTrackId = rawQuery.substr(0U, separator);
    const auto rawGeneration = rawQuery.substr(separator + std::string_view("&generation=").size());
    if (rawTrackId.empty() || rawGeneration.empty() ||
        request.get_param_value("trackId") != rawTrackId ||
        request.get_param_value("generation") != rawGeneration) {
        error = "Native MARK request query values are invalid.";
        return false;
    }
    const auto [trackEnd, trackStatus] = std::from_chars(rawTrackId.data(), rawTrackId.data() + rawTrackId.size(), trackIndex);
    if (trackStatus != std::errc{} || trackEnd != rawTrackId.data() + rawTrackId.size() ||
        trackIndex < 1U || trackIndex > kNativeTrackCount) {
        error = "Native trackId must be an integer between 1 and 5.";
        return false;
    }
    const auto [generationEnd, generationStatus] =
        std::from_chars(rawGeneration.data(), rawGeneration.data() + rawGeneration.size(), generation);
    if (generationStatus != std::errc{} || generationEnd != rawGeneration.data() + rawGeneration.size() || generation == 0U) {
        error = "Native MARK generation must be a positive integer.";
        return false;
    }
    --trackIndex;
    return true;
}

void addLoopSnapshotCorsHeaders(const httplib::Request& request, httplib::Response& response) {
    const auto origin = request.get_header_value("Origin");
    if (!isAllowedUiOrigin(origin)) return;

    // enableLoopbackCors installs the single ACAO/Vary pair for every
    // allowlisted request before routing. Do not append a second ACAO value
    // here: browsers reject duplicate Access-Control-Allow-Origin headers.
    response.set_header(
        "Access-Control-Expose-Headers",
        "X-Native-Loop-Sample-Rate, X-Native-Loop-Frame-Count, X-Native-Loop-Channels, "
        "X-Native-Loop-Sample-Format, X-Native-Loop-Revision"
    );
}

void addNativeHqCorsHeaders(const httplib::Request& request, httplib::Response& response) {
    const auto origin = request.get_header_value("Origin");
    if (!isAllowedUiOrigin(origin)) return;
    response.set_header(
        "Access-Control-Expose-Headers",
        "X-Native-Loop-Sample-Rate, X-Native-Loop-Frame-Count, X-Native-Loop-Channels, "
        "X-Native-Loop-Sample-Format, X-Native-HQ-Engine, X-Native-HQ-Latency-Samples"
    );
}

void enableLoopbackCors(httplib::Server& server) {
    server.set_pre_routing_handler([](const httplib::Request& request, httplib::Response& response) {
        const std::string origin = request.get_header_value("Origin");
        const bool allowedOrigin = isAllowedUiOrigin(origin);
        if (allowedOrigin) {
            response.set_header("Access-Control-Allow-Origin", origin);
            response.set_header("Vary", "Origin");
        }

        const auto requestedMethod = request.get_header_value("Access-Control-Request-Method");
        if (request.method == "OPTIONS" && !requestedMethod.empty()) {
            if (!allowedOrigin) {
                response.status = 403;
                writeError(response, "Native bridge CORS origin is not allowed.");
                return httplib::Server::HandlerResponse::Handled;
            }
            if (requestedMethod != "GET" && requestedMethod != "POST") {
                response.status = 405;
                writeError(response, "Native bridge CORS only allows GET and POST requests.");
                return httplib::Server::HandlerResponse::Handled;
            }

            const auto requestedHeaders = request.get_header_value("Access-Control-Request-Headers");
            if (!requestedHeaders.empty()) {
                bool sawContentType = false;
                bool sawHostIncarnation = false;
                bool sawOperationId = false;
                std::istringstream headerStream(requestedHeaders);
                std::string token;
                bool validHeaders = true;
                while (std::getline(headerStream, token, ',')) {
                    const auto first = token.find_first_not_of(" \t");
                    const auto last = token.find_last_not_of(" \t");
                    if (first == std::string::npos) {
                        validHeaders = false;
                        break;
                    }
                    token = token.substr(first, last - first + 1U);
                    std::transform(token.begin(), token.end(), token.begin(), [](unsigned char value) {
                        return static_cast<char>(std::tolower(value));
                    });
                    if (token == "content-type" && !sawContentType) sawContentType = true;
                    else if (token == "x-native-host-incarnation" && !sawHostIncarnation) sawHostIncarnation = true;
                    else if (token == "x-native-operation-id" && !sawOperationId) sawOperationId = true;
                    else {
                        validHeaders = false;
                        break;
                    }
                }
                if (!validHeaders) {
                    response.status = 400;
                    writeError(response, "Native bridge CORS only allows Content-Type, X-Native-Host-Incarnation, and X-Native-Operation-Id request headers.");
                    return httplib::Server::HandlerResponse::Handled;
                }
            }

            response.status = 204;
            response.set_header("Access-Control-Allow-Methods", "GET, POST");
            response.set_header("Access-Control-Allow-Headers", "Content-Type, X-Native-Host-Incarnation, X-Native-Operation-Id");
            response.set_header("Access-Control-Max-Age", "600");
            return httplib::Server::HandlerResponse::Handled;
        }

        // Prevent cross-site form POSTs to transport commands, which can be
        // sent without a preflight. The UI always sends an Origin on fetch POSTs.
        if (request.method == "POST" && !allowedOrigin) {
            response.status = 403;
            writeError(response, "Native bridge write requires an approved WebRC-505 local UI Origin.");
            return httplib::Server::HandlerResponse::Handled;
        }

        if (request.method == "POST") {
            // cpp-httplib's configured payload maximum applies to Content-Length
            // bodies but its chunked reader has no aggregate byte counter. Reject
            // transfer/content encoding before any body is buffered or dispatched.
            if (request.has_header("Transfer-Encoding")) {
                response.status = 411;
                writeError(response, "Native bridge writes require a bounded Content-Length request body.");
                return httplib::Server::HandlerResponse::Handled;
            }
            if (request.has_header("Content-Encoding")) {
                response.status = 415;
                writeError(response, "Native bridge writes do not accept Content-Encoding.");
                return httplib::Server::HandlerResponse::Handled;
            }

            if (request.path != "/v1/project/import") {
                std::uint64_t bodyBytes = 0U;
                if (request.get_header_value_count("Content-Length") != 1U ||
                    !parseProjectImportContentLength(request, bodyBytes)) {
                    response.status = 411;
                    writeError(response, "Native bridge writes require exactly one valid Content-Length header.");
                    return httplib::Server::HandlerResponse::Handled;
                }
                if (bodyBytes > 1024U * 1024U) {
                    response.status = 413;
                    writeError(response, "Native bridge control request body exceeds the 1 MiB limit.");
                    return httplib::Server::HandlerResponse::Handled;
                }
            }
        }

        if (request.method == "OPTIONS") {
            return httplib::Server::HandlerResponse::Unhandled;
        }
        return httplib::Server::HandlerResponse::Unhandled;
    });
}

bool estimateNativeHqMemory(std::size_t inputFrames, double playbackRate, std::uint64_t& estimateBytes);

std::size_t maximumHqInputFrames(std::uint64_t memoryBudgetBytes, double playbackRate) {
    std::size_t low = 0U;
    std::size_t high = static_cast<std::size_t>(0xffffffffULL);
    while (low + 1U < high) {
        const std::size_t middle = low + (high - low) / 2U;
        std::uint64_t estimate = 0U;
        if (estimateNativeHqMemory(middle, playbackRate, estimate) && estimate <= memoryBudgetBytes) {
            low = middle;
        } else {
            high = middle;
        }
    }
    return low;
}

bool estimateNativeHqMemory(std::size_t inputFrames, double playbackRate, std::uint64_t& estimateBytes) {
    if (inputFrames == 0U || !std::isfinite(playbackRate) || playbackRate < 0.5 || playbackRate > 2.0) return false;
    const long double outputFrames = std::ceil(static_cast<long double>(inputFrames) / playbackRate);
    const long double inputBytes = static_cast<long double>(inputFrames) * 2.0L * sizeof(float);
    const long double renderedBytes = outputFrames * 2.0L * sizeof(float);
    // Account for the pinned interleaved snapshot plus bounded library working
    // storage, the renderer output plus HTTP response copy, and 64 MiB for the
    // process/runtime. This is a conservative admission estimate, not an OS cap.
    const long double estimate = inputBytes * 3.0L + renderedBytes * 2.0L + 64.0L * 1024.0L * 1024.0L;
    if (!std::isfinite(static_cast<double>(estimate)) ||
        estimate > static_cast<long double>(std::numeric_limits<std::uint64_t>::max())) return false;
    estimateBytes = static_cast<std::uint64_t>(estimate);
    return true;
}

bool wavSizeIsRepresentable(std::size_t frameCount, const std::string& format) {
    std::uint64_t bytesPerSample = 0U;
    std::uint64_t headerBytes = 44U;
    if (format == "pcm16") bytesPerSample = 2U;
    else if (format == "pcm24") bytesPerSample = 3U;
    else if (format == "float32") { bytesPerSample = 4U; headerBytes = 56U; }
    else return false;
    const auto frames = static_cast<std::uint64_t>(frameCount);
    if (frames > std::numeric_limits<std::uint64_t>::max() / (2U * bytesPerSample)) return false;
    const std::uint64_t dataBytes = frames * 2U * bytesPerSample;
    const std::uint64_t padBytes = dataBytes % 2U;
    const std::uint64_t fileBytes = headerBytes + dataBytes + padBytes;
    return dataBytes <= 0xffffffffULL && fileBytes >= 8U && fileBytes - 8U <= 0xffffffffULL &&
        (format != "float32" || frames <= 0xffffffffULL);
}

} // namespace

int main() {
    NativeAudioCore engine;
    httplib::Server server;
    std::mutex nativeHqRenderMutex;
    // cpp-httplib applies this to ContentReader routes too. Set the global cap
    // to the v1 archive maximum, then use the pre-routing guard above to keep
    // ordinary control POSTs at 1 MiB without blocking legitimate archives.
    server.set_payload_max_length(static_cast<std::size_t>(kProjectArchiveMaxBytes));
    enableLoopbackCors(server);

    server.Get("/health", [&engine](const httplib::Request&, httplib::Response& response) {
        const auto status = engine.getStatus();
        writeJson(response, json{
            {"ok", true},
            {"version", "native-audio-core-mvp"},
            {"engineRunning", status.engineRunning},
            {"backends", engine.getDeviceCatalog().backends},
            {"lastError", status.lastError},
        });
    });

    server.Get("/v1/devices", [&engine](const httplib::Request&, httplib::Response& response) {
        writeJson(response, catalogToJson(engine.getDeviceCatalog()));
    });

    server.Get("/v1/status", [&engine](const httplib::Request&, httplib::Response& response) {
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/project/import", [&engine](const httplib::Request& request, httplib::Response& response,
                                                const httplib::ContentReader& contentReader) {
        if (!requestMatchesHostIncarnation(request)) {
            response.status = 409;
            writeError(response, "Native host incarnation changed or is unsupported; project import was not accepted.");
            return;
        }
        const auto operationId = request.get_header_value("X-Native-Operation-Id");
        if (request.get_header_value_count("X-Native-Operation-Id") != 1U || !isOperationId(operationId)) {
            response.status = 400;
            writeError(response, "Native project import requires one client-persisted 128-bit X-Native-Operation-Id.");
            return;
        }
        if (normalizedHeaderValue(request.get_header_value("Content-Type")) != "application/octet-stream") {
            response.status = 415;
            writeError(response, "Native project import requires an application/octet-stream archive body.");
            return;
        }
        if (request.has_header("Transfer-Encoding") || request.has_header("Content-Encoding")) {
            response.status = 400;
            writeError(response, "Native project import requires an unencoded body with a single Content-Length header.");
            return;
        }

        std::uint64_t expectedProjectContentRevision = 0U;
        if (!parseProjectImportExpectedContentRevision(request, expectedProjectContentRevision)) {
            response.status = 400;
            writeError(response, "Native project import requires exactly one valid operation-start expectedContentRevision query parameter.");
            return;
        }

        std::uint64_t encodedBytes = 0U;
        if (!parseProjectImportContentLength(request, encodedBytes)) {
            response.status = 411;
            writeError(response, "Native project import requires exactly one valid Content-Length header.");
            return;
        }
        if (encodedBytes > kProjectArchiveMaxBytes) {
            response.status = 413;
            writeError(response, "Native project archive exceeds the v1 archive size limit.");
            return;
        }
        if (encodedBytes > std::numeric_limits<std::size_t>::max()) {
            response.status = 413;
            writeError(response, "Native project archive is too large for this process to address.");
            return;
        }

        std::vector<std::uint8_t> archiveBytes;
        try {
            archiveBytes.reserve(static_cast<std::size_t>(encodedBytes));
        } catch (const std::bad_alloc&) {
            response.status = 503;
            writeError(response, "Native project import could not reserve bounded request storage.");
            return;
        } catch (const std::length_error&) {
            response.status = 413;
            writeError(response, "Native project archive is too large for this process to address.");
            return;
        }

        bool bodyExceededLimit = false;
        bool storageAllocationFailed = false;
        const bool bodyRead = contentReader([&archiveBytes, encodedBytes, &bodyExceededLimit, &storageAllocationFailed](
                                                const char* data, std::size_t dataLength) {
            if (dataLength > encodedBytes - archiveBytes.size()) {
                bodyExceededLimit = true;
                return false;
            }
            try {
                const auto* first = reinterpret_cast<const std::uint8_t*>(data);
                archiveBytes.insert(archiveBytes.end(), first, first + dataLength);
            } catch (const std::bad_alloc&) {
                storageAllocationFailed = true;
                return false;
            } catch (const std::length_error&) {
                storageAllocationFailed = true;
                return false;
            }
            return true;
        });
        if (!bodyRead) {
            response.status = storageAllocationFailed ? 503 : (bodyExceededLimit ? 413 : 400);
            writeError(response, storageAllocationFailed
                ? "Native project import could not store the bounded request body."
                : (bodyExceededLimit
                    ? "Native project archive body exceeds its declared Content-Length."
                    : "Native project archive request body was incomplete or malformed."));
            return;
        }
        if (archiveBytes.size() != encodedBytes) {
            response.status = 400;
            writeError(response, "Native project archive body length does not match Content-Length.");
            return;
        }

        const auto archiveSha256 = projectArchiveSha256(archiveBytes.data(), archiveBytes.size());
        {
            std::lock_guard<std::mutex> lock(nativeImportOperationsMutex());
            const auto existing = nativeImportOperations().find(operationId);
            if (existing != nativeImportOperations().end()) {
                if (existing->second.generation == 0U) {
                    response.status = 503;
                    writeError(response, "Native import operation is reserved but its begin outcome is indeterminate; do not retry this ID until the host incarnation changes.");
                    return;
                }
                if (existing->second.archiveSha256 != archiveSha256 ||
                    existing->second.expectedProjectContentRevision != expectedProjectContentRevision) {
                    response.status = 409;
                writeError(response, "Native project import operation ID is already bound to a different request fingerprint.");
                    return;
                }
                response.status = 202;
                writeJson(response, json{{"ok", true}, {"generation", existing->second.generation},
                    {"hostIncarnationId", hostIncarnationId()}, {"operationId", operationId}, {"duplicate", true}});
                return;
            }
        }

        std::unique_ptr<NativeMemorySettings> memory;
        std::string memoryError;
        std::array<unsigned int, 2U> semanticMeter{};
        if (!unwrapNativeMemory(archiveBytes, memory, semanticMeter, memoryError)) {
            response.status = 400; writeError(response, memoryError); return;
        }
        auto decoded = decodeProjectArchive(archiveBytes);
        if (!decoded.project) {
            response.status = 400;
            writeError(response, decoded.error.empty() ? "Native project archive is invalid." : decoded.error);
            return;
        }

        if (memory && (memory->rhythm.bpm != decoded.project->bpm ||
            semanticMeter[0U] != decoded.project->transport.timeSignatureNumerator ||
            semanticMeter[1U] != decoded.project->transport.timeSignatureDenominator)) {
            response.status = 400; writeError(response, "Memory semantic tempo/meter does not match its PCM archive."); return;
        }
        std::uint64_t generation = 0U;
        std::string error;
        {
            std::lock_guard<std::mutex> lock(nativeImportOperationsMutex());
            const auto existing = nativeImportOperations().find(operationId);
            if (existing != nativeImportOperations().end()) {
                if (existing->second.generation == 0U) {
                    response.status = 503;
                    writeError(response, "Native import operation is reserved but its begin outcome is indeterminate; do not retry this ID until the host incarnation changes.");
                    return;
                }
                if (existing->second.archiveSha256 != archiveSha256 ||
                    existing->second.expectedProjectContentRevision != expectedProjectContentRevision) {
                    response.status = 409;
                    writeError(response, "Native project import operation ID is already bound to a different request fingerprint.");
                    return;
                }
                response.status = 202;
                writeJson(response, json{{"ok", true}, {"generation", existing->second.generation},
                    {"hostIncarnationId", hostIncarnationId()}, {"operationId", operationId}, {"duplicate", true}});
                return;
            }
            if (nativeImportOperations().size() >= kNativeImportOperationLimit) {
                response.status = 503;
                writeError(response, "Native import operation status capacity is exhausted; restart the host before submitting another import.");
                return;
            }
            auto& operations = nativeImportOperations();
            auto reserved = operations.end();
            try {
#if defined(NATIVE_BRIDGE_SIMULATION_ONLY)
                if (consumeImportLedgerReservationFailure(operationId)) throw std::bad_alloc();
#endif
                auto insertion = operations.try_emplace(operationId,
                    NativeImportOperationRecord{archiveSha256, expectedProjectContentRevision, 0U});
                reserved = insertion.first;
                if (!insertion.second) {
                    response.status = 409;
                    writeError(response, "Native project import operation ID was claimed concurrently; query its status before retrying.");
                    return;
                }
            } catch (const std::bad_alloc&) {
                response.status = 503;
                writeError(response, "Native project import could not reserve its durable in-process operation status; no import was started.");
                return;
            } catch (const std::length_error&) {
                response.status = 503;
                writeError(response, "Native project import operation status reservation exceeded process limits; no import was started.");
                return;
            }
            bool beginEntered = false;
            bool began = false;
            try {
#if defined(NATIVE_BRIDGE_SIMULATION_ONLY)
                if (consumeImportBeginException(operationId)) throw std::runtime_error("simulation exception before begin entry");
#endif
                beginEntered = true;
#if defined(NATIVE_BRIDGE_SIMULATION_ONLY)
                if (consumeImportIndeterminateBeginException(operationId)) throw std::runtime_error("simulation indeterminate begin exception");
#endif
                began = engine.beginProjectArchiveImport(
                    std::move(*decoded.project), encodedBytes, expectedProjectContentRevision, generation, error, std::move(memory));
#if defined(NATIVE_BRIDGE_SIMULATION_ONLY)
                if (began && consumeImportPostBeginException(operationId)) {
                    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
                    while (std::chrono::steady_clock::now() < deadline) {
                        const auto acceptedStatus = engine.getProjectArchiveImportStatus(generation);
                        if (acceptedStatus.found && (acceptedStatus.state == NativeProjectImportState::Committed ||
                            acceptedStatus.state == NativeProjectImportState::Cancelled)) break;
                        std::this_thread::yield();
                    }
                    throw std::runtime_error("simulation exception after begin and terminal callback state");
                }
#endif
            } catch (...) {
                if (!beginEntered) {
                    operations.erase(reserved);
                    response.status = 503;
                    writeError(response, "Native project import failed before begin entry; no import was started.");
                    return;
                }
                try {
                    if (generation != 0U && engine.getProjectArchiveImportStatus(generation).found) {
                        reserved->second.generation = generation;
                        response.status = 202;
                        writeJson(response, json{{"ok", true}, {"generation", generation},
                            {"hostIncarnationId", hostIncarnationId()}, {"operationId", operationId}, {"duplicate", false}});
                        return;
                    }
                } catch (...) {
                    // A failure while checking the engine cannot prove that
                    // begin failed. Keep the sentinel and fail closed below.
                }
                // begin was entered but did not yield a queryable generation.
                // Retain a sentinel so neither duplicate requests nor status
                // queries can mistake the outcome for rejection/cancellation.
                reserved->second.generation = 0U;
                response.status = 503;
                writeError(response, "Native project import begin outcome is indeterminate; its operation ID remains reserved and must not be retried.");
                return;
            }
            if (!began) {
                operations.erase(reserved);
                response.status = 409;
                writeError(response, error);
                return;
            }
            reserved->second.generation = generation;
        }
        response.status = 202;
        writeJson(response, json{{"ok", true}, {"generation", generation}, {"hostIncarnationId", hostIncarnationId()},
            {"operationId", operationId}, {"duplicate", false}});
    });

    server.Post("/v1/project/import/commit", [&engine](const httplib::Request& request, httplib::Response& response) {
        if (!requestMatchesHostIncarnation(request)) {
            response.status = 409;
            writeError(response, "Native host incarnation changed or is unsupported; prepared generation was not committed.");
            return;
        }
        std::uint64_t generation = 0U;
        if (!parseProjectImportGeneration(request.body, generation)) {
            response.status = 400; writeError(response, "Expected a prepared Memory generation."); return;
        }
        std::string error;
        if (!engine.commitPreparedMemory(generation, error)) {
            response.status = 409; writeError(response, error); return;
        }
        writeJson(response, json{{"ok", true}, {"generation", generation}, {"hostIncarnationId", hostIncarnationId()}});
    });

    server.Get("/v1/project/import/status", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::uint64_t generation = 0U;
        if (request.get_param_value_count("generation") != 1U ||
            !parseProjectImportGeneration(request.get_param_value("generation"), generation)) {
            response.status = 400;
            writeError(response, "Native project import status requires one positive integer generation query parameter.");
            return;
        }
        const auto status = engine.getProjectArchiveImportStatus(generation);
        if (!status.found) {
            response.status = 404;
            writeError(response, "Native project import generation was not found.");
            return;
        }
        writeJson(response, projectImportStatusToJson(status));
    });

    server.Get("/v1/project/import/status-by-operation", [&engine](const httplib::Request& request, httplib::Response& response) {
        if (!requestMatchesHostIncarnation(request)) {
            response.status = 409;
            writeError(response, "Native host incarnation changed or is unsupported; operation status is unavailable.");
            return;
        }
        const auto operationId = request.get_param_value("operationId");
        if (request.get_param_value_count("operationId") != 1U || !isOperationId(operationId)) {
            response.status = 400;
            writeError(response, "Operation status requires one valid 128-bit operationId.");
            return;
        }
        NativeImportOperationRecord operation;
        {
            std::lock_guard<std::mutex> lock(nativeImportOperationsMutex());
            const auto found = nativeImportOperations().find(operationId);
            if (found == nativeImportOperations().end()) {
                response.status = 404;
                writeError(response, "Native project import operation is not known in this host incarnation; absence does not prove the request was rejected.");
                return;
            }
            operation = found->second;
        }
        if (operation.generation == 0U) {
            response.status = 503;
            writeError(response, "Native import operation is reserved but its begin outcome is indeterminate; absence cannot be interpreted as cancellation and this ID must not be retried.");
            return;
        }
        const auto status = engine.getProjectArchiveImportStatus(operation.generation);
        if (!status.found) {
            response.status = 404;
            writeError(response, "Native project import operation status was evicted; absence does not prove cancellation.");
            return;
        }
        auto result = projectImportStatusToJson(status);
        result["operationId"] = operationId;
        result["archiveSha256"] = operation.archiveSha256;
        result["expectedProjectContentRevision"] = operation.expectedProjectContentRevision;
        writeJson(response, result);
    });

    server.Post("/v1/project/import/cancel", [&engine](const httplib::Request& request, httplib::Response& response) {
        if (!requestMatchesHostIncarnation(request)) {
            response.status = 409;
            writeError(response, "Native host incarnation changed or is unsupported; generation cancellation was not attempted.");
            return;
        }
        // Fetch supplies a charset parameter for string bodies. Compare only the
        // media type token here; other routes retain their existing header rules.
        const auto contentType = request.get_header_value("Content-Type");
        const auto mediaType = contentType.substr(0U, contentType.find(';'));
        if (normalizedHeaderValue(mediaType) != "text/plain") {
            response.status = 415;
            writeError(response, "Native project import cancellation requires a text/plain JSON body.");
            return;
        }
        try {
            const auto body = json::parse(request.body);
            std::uint64_t generation = 0U;
            if (!body.is_object() || body.size() != 1U || !body.contains("generation") ||
                !readUnsignedJsonInteger(body["generation"], std::numeric_limits<std::uint64_t>::max(), generation) ||
                generation == 0U) {
                response.status = 400;
                writeError(response, "Native project import cancellation requires one positive integer generation.");
                return;
            }

            NativeProjectImportStatus status;
            std::string error;
            const bool cancelledOrFound = engine.cancelProjectArchiveImport(generation, status, error);
            if (!status.found) {
                response.status = 404;
                writeError(response, error.empty() ? "Native project import generation was not found." : error);
                return;
            }
            if (!cancelledOrFound || status.state == NativeProjectImportState::Claimed) {
                response.status = 409;
                auto result = projectImportStatusToJson(status);
                result["ok"] = false;
                result["error"] = error.empty()
                    ? "Native project import is no longer pending and cannot be cancelled."
                    : error;
                writeJson(response, result);
                return;
            }
            writeJson(response, projectImportStatusToJson(status));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Get("/v1/export/loop-snapshot", [&engine](const httplib::Request& request, httplib::Response& response) {
        addLoopSnapshotCorsHeaders(request, response);
        std::vector<float> samples;
        unsigned int sampleRate = 0U;
        std::string error;
        std::size_t trackIndex = 0U;
        std::uint64_t contentRevision = 0U;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!engine.captureTrackSnapshot(trackIndex, samples, sampleRate, error,
                                         std::numeric_limits<std::size_t>::max(), &contentRevision)) {
            response.status = 409;
            writeError(response, error);
            return;
        }

        response.set_header("X-Native-Loop-Sample-Rate", std::to_string(sampleRate));
        response.set_header("X-Native-Loop-Frame-Count", std::to_string(samples.size() / 2U));
        response.set_header("X-Native-Loop-Channels", "2");
        response.set_header("X-Native-Loop-Sample-Format", "float32le");
        response.set_header("X-Native-Loop-Revision", std::to_string(contentRevision));
        response.set_content(
            reinterpret_cast<const char*>(samples.data()),
            samples.size() * sizeof(float),
            "application/octet-stream"
        );
    });

    server.Get("/v1/export/track-metadata", [&engine](const httplib::Request& request, httplib::Response& response) {
        addLoopSnapshotCorsHeaders(request, response);
        std::size_t trackIndex = 0U;
        std::string error;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        std::size_t frameCount = 0U;
        unsigned int sampleRate = 0U;
        std::uint64_t contentRevision = 0U;
        std::optional<double> originalTempoBpm;
        if (!engine.getTrackSnapshotMetadata(trackIndex, frameCount, sampleRate, error, &contentRevision, &originalTempoBpm)) {
            response.status = 409;
            writeError(response, error);
            return;
        }
        writeJson(response, json{
            {"ok", true},
            {"trackId", trackIndex + 1U},
            {"sampleRate", sampleRate},
            {"frameCount", frameCount},
            {"channels", 2},
            {"contentRevision", contentRevision},
            {"originalTempoBpm", originalTempoBpm ? json(*originalTempoBpm) : json(nullptr)},
            {"sampleFormat", "float32le"},
        });
    });

    server.Post("/v1/export/hq-render", [&engine, &nativeHqRenderMutex](const httplib::Request& request, httplib::Response& response) {
        addNativeHqCorsHeaders(request, response);
#if !defined(NATIVE_RUBBERBAND_HQ_AVAILABLE)
        response.status = 501;
        writeError(response, "Native Rubber Band HQ_RENDER is disabled in this build; no pitch-shifted fallback is available.");
        return;
#else
        const auto lock = std::unique_lock<std::mutex>(nativeHqRenderMutex, std::try_to_lock);
        if (!lock.owns_lock()) {
            response.status = 429;
            writeError(response, "Another Native HQ_RENDER export is already running; retry after it completes.");
            return;
        }

        std::size_t trackIndex = 0U;
        std::string error;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }

        try {
            const json body = json::parse(request.body);
            if (!body.is_object() || !body.contains("semitones") || !body["semitones"].is_number() ||
                !body.contains("playbackRate") || !body["playbackRate"].is_number() ||
                !body.contains("engine") || !body["engine"].is_string() ||
                !body.contains("format") || !body["format"].is_string()) {
                response.status = 400;
                writeError(response, "HQ_RENDER requires numeric semitones/playbackRate and explicit engine/format values.");
                return;
            }

            const double semitones = body["semitones"].get<double>();
            const double playbackRate = body["playbackRate"].get<double>();
            const std::string engineName = body["engine"].get<std::string>();
            const std::string format = body["format"].get<std::string>();
            if (!std::isfinite(semitones) || semitones < -24.0 || semitones > 24.0 ||
                !std::isfinite(playbackRate) || playbackRate < 0.5 || playbackRate > 2.0) {
                response.status = 400;
                writeError(response, "HQ_RENDER pitch must be between -24 and +24 semitones and playback rate between 0.5 and 2.");
                return;
            }
            native_mvp::RubberBandEngine selectedEngine;
            if (engineName == "R2") selectedEngine = native_mvp::RubberBandEngine::R2Faster;
            else if (engineName == "R3") selectedEngine = native_mvp::RubberBandEngine::R3Finer;
            else {
                response.status = 400;
                writeError(response, "HQ_RENDER engine must be R2 or R3.");
                return;
            }
            if (format != "pcm16" && format != "pcm24" && format != "float32") {
                response.status = 400;
                writeError(response, "HQ_RENDER WAV format must be pcm16, pcm24, or float32.");
                return;
            }

            std::uint64_t memoryBudgetBytes = 512ULL * 1024ULL * 1024ULL;
            if (body.contains("memoryBudgetBytes") &&
                !readUnsignedJsonInteger(body["memoryBudgetBytes"], 4ULL * 1024ULL * 1024ULL * 1024ULL, memoryBudgetBytes)) {
                response.status = 400;
                writeError(response, "HQ_RENDER memoryBudgetBytes must be an integer from 64 MiB through 4 GiB.");
                return;
            }
            if (memoryBudgetBytes < 64ULL * 1024ULL * 1024ULL) {
                response.status = 400;
                writeError(response, "HQ_RENDER memoryBudgetBytes must be at least 64 MiB.");
                return;
            }

            std::size_t metadataFrames = 0U;
            unsigned int metadataRate = 0U;
            if (!engine.getTrackSnapshotMetadata(trackIndex, metadataFrames, metadataRate, error)) {
                response.status = 409;
                writeError(response, "HQ_RENDER metadata preflight failed: " + error);
                return;
            }
            const long double targetFramesValue = std::ceil(static_cast<long double>(metadataFrames) / playbackRate);
            if (!std::isfinite(static_cast<double>(targetFramesValue)) || targetFramesValue <= 0.0L ||
                targetFramesValue > static_cast<long double>(std::numeric_limits<std::size_t>::max() / 2U)) {
                response.status = 413;
                writeError(response, "HQ_RENDER output duration is not representable.");
                return;
            }
            const auto targetFrames = static_cast<std::size_t>(targetFramesValue);
            if (!wavSizeIsRepresentable(targetFrames, format)) {
                response.status = 413;
                writeError(response, "HQ_RENDER result would exceed the selected WAV format's RIFF size limits.");
                return;
            }
            std::uint64_t estimatedBytes = 0U;
            if (!estimateNativeHqMemory(metadataFrames, playbackRate, estimatedBytes) || estimatedBytes > memoryBudgetBytes) {
                response.status = 413;
                writeError(response, "HQ_RENDER exceeds the configured Native memory estimate; raise the budget or reduce loop length. The recording was not changed.");
                return;
            }

            std::vector<float> snapshot;
            unsigned int sampleRate = 0U;
            const auto maximumFrames = maximumHqInputFrames(memoryBudgetBytes, playbackRate);
            if (!engine.captureTrackSnapshot(trackIndex, snapshot, sampleRate, error, maximumFrames)) {
                response.status = error.find("memory budget") != std::string::npos ? 413 : 409;
                writeError(response, "HQ_RENDER snapshot failed: " + error);
                return;
            }
            if (sampleRate != metadataRate || snapshot.size() != metadataFrames * 2U) {
                response.status = 409;
                writeError(response, "Native track changed after HQ_RENDER admission; retry after the loop is stable.");
                return;
            }

            const double exactDurationRatio = static_cast<double>(targetFrames) / static_cast<double>(metadataFrames);
            const auto rendered = native_mvp::NativeRubberBandRenderer::render(
                snapshot, metadataFrames, 2U, sampleRate, semitones, exactDurationRatio, selectedEngine);
            if (!rendered) {
                response.status = rendered.error == native_mvp::RubberBandRenderError::InvalidArgument ? 400 : 500;
                writeError(response, rendered.message);
                return;
            }
            if (rendered.frames + 1U < targetFrames || rendered.frames > targetFrames + 1U) {
                response.status = 500;
                writeError(response, "Rubber Band output duration differs from the admitted HQ_RENDER duration.");
                return;
            }
            if (rendered.frames != targetFrames) {
                response.status = 500;
                writeError(response, "Rubber Band output requires more than a one-sample boundary adjustment; refusing to pad or resample it.");
                return;
            }

            response.set_header("X-Native-Loop-Sample-Rate", std::to_string(sampleRate));
            response.set_header("X-Native-Loop-Frame-Count", std::to_string(rendered.frames));
            response.set_header("X-Native-Loop-Channels", "2");
            response.set_header("X-Native-Loop-Sample-Format", "float32le");
            response.set_header("X-Native-HQ-Engine", engineName);
            response.set_header("X-Native-HQ-Latency-Samples", "0");
            response.set_content(
                reinterpret_cast<const char*>(rendered.interleaved.data()),
                rendered.interleaved.size() * sizeof(float),
                "application/octet-stream"
            );
        } catch (const std::exception& exception) {
            response.status = 400;
            writeError(response, exception.what());
        }
#endif
    });

    server.Post("/v1/config/apply", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            const auto backend = backendFromString(body.value("backend", "WASAPI"));
            if (!backend) {
                response.status = 400;
                writeError(response, "Unsupported backend.");
                return;
            }

            EngineConfig config;
            config.backend = *backend;
            config.inputDeviceId = body.value("inputDeviceId", "");
            config.outputDeviceId = body.value("outputDeviceId", "");
            config.sampleRate = body.value("sampleRate", 48000u);
            config.bufferFrames = body.value("bufferFrames", 128u);
            config.monitoringEnabled = body.value("monitoringEnabled", false);
            config.nativeLooperStorageBudgetBytes = body.value(
                "nativeLooperStorageBudgetBytes",
                LooperCore::kDefaultAggregateLoopStorageBudgetBytes
            );

            std::string error;
            if (!engine.applyConfig(config, error)) {
                response.status = 400;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/engine/start", [&engine](const httplib::Request&, httplib::Response& response) {
        std::string error;
        if (!engine.start(error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/engine/stop", [&engine](const httplib::Request&, httplib::Response& response) {
        std::string error;
        if (!engine.stop(error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/record", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        std::optional<double> tempoBpm;
        std::uint64_t tempoRevision = 0U;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!readRecordTempoToken(request, tempoBpm, tempoRevision)) {
            response.status = 400; writeError(response, "REC tempo token requires tempoBpm 40..300 and a nonnegative safe tempoRevision."); return;
        }
        if (!engine.recordTrack(trackIndex, error, tempoBpm, tempoRevision)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/record/settings", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object() || body.size() != 1U || !body.contains("recAction") || !body.at("recAction").is_string()) {
                response.status = 400; writeError(response, "REC settings require only recAction."); return;
            }
            const auto action = body.at("recAction").get<std::string>();
            if (action != "REC->PLAY" && action != "REC->DUB") { response.status = 400; writeError(response, "Invalid REC ACTION."); return; }
            std::string error;
            if (!engine.setRecordAction(action == "REC->DUB", error)) { response.status = 409; writeError(response, error); return; }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) { response.status = 400; writeError(response, error.what()); }
    });
    server.Post("/v1/native-bounce/settings", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object() || body.size() != 3U || !body.contains("bounceSw") || !body.contains("bounceIn") || !body.contains("bounceTrack")
                || !body.at("bounceSw").is_boolean() || !body.at("bounceIn").is_array() || !body.at("bounceTrack").is_array()
                || body.at("bounceIn").size() != kNativeTrackCount || body.at("bounceTrack").size() != kNativeTrackCount) {
                response.status = 400; writeError(response, "Native Bounce requires BOUNCE SW and five BOUNCE IN / BOUNCE TRACK booleans."); return;
            }
            NativeBounceSettings settings{};
            settings.bounceSw = body.at("bounceSw").get<bool>();
            for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
                if (!body.at("bounceIn")[track].is_boolean() || !body.at("bounceTrack")[track].is_boolean()) {
                    response.status = 400; writeError(response, "Native Bounce switches must be booleans."); return;
                }
                settings.bounceIn[track] = body.at("bounceIn")[track].get<bool>();
                settings.bounceTrack[track] = body.at("bounceTrack")[track].get<bool>();
            }
            std::string error;
            std::uint64_t acceptedRevision = 0U;
            if (!engine.setNativeBounceSettings(settings, error, &acceptedRevision)) { response.status = 409; writeError(response, error); return; }
            auto status = statusToJson(engine.getStatus());
            status["nativeBounce"]["acceptedRevision"] = acceptedRevision;
            writeJson(response, status);
        } catch (const std::exception& error) { response.status = 400; writeError(response, error.what()); }
    });
    server.Post("/v1/transport/finish-record", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object() || !body.contains("trackId") || !body.at("trackId").is_number_unsigned() ||
                (body.size() != 1U && body.size() != 3U)) {
                response.status = 400; writeError(response, "REC completion requires trackId 1..5."); return;
            }
            const auto trackId = body.at("trackId").get<unsigned int>();
            if (trackId < 1U || trackId > 5U) { response.status = 400; writeError(response, "Invalid REC completion track."); return; }
            std::optional<double> tempoBpm;
            std::uint64_t tempoRevision = 0U;
            if (!readRecordTempoToken(body, tempoBpm, tempoRevision)) {
                response.status = 400; writeError(response, "REC completion tempo token requires tempoBpm 40..300 and a nonnegative safe tempoRevision."); return;
            }
            std::string error;
            if (!engine.finishRecordingTrack(trackId - 1U, error, tempoBpm, tempoRevision)) { response.status = 409; writeError(response, error); return; }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) { response.status = 400; writeError(response, error.what()); }
    });
    server.Post("/v1/transport/record-tempo/confirm", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            std::uint64_t trackId = 0U, expectedContentRevision = 0U, tempoRevision = 0U, expectedStopRevision = 0U;
            std::optional<double> tempoBpm;
            if (!body.is_object() || (body.size() != 4U && body.size() != 5U) ||
                !readUnsignedJsonInteger(body.value("trackId", json()), kNativeTrackCount, trackId) || trackId < 1U ||
                !readUnsignedJsonInteger(body.value("expectedContentRevision", json()), kMaximumSafeTempoRevision, expectedContentRevision) ||
                (body.contains("stopRevision") &&
                    (!readUnsignedJsonInteger(body.at("stopRevision"), kMaximumSafeTempoRevision, expectedStopRevision) || expectedStopRevision == 0U)) ||
                (body.size() == 5U) != body.contains("stopRevision") ||
                !readRecordTempoToken(body, tempoBpm, tempoRevision) || !tempoBpm.has_value()) {
                response.status = 400; writeError(response, "REC tempo confirmation requires trackId, expectedContentRevision, tempoBpm, tempoRevision, and optional stopRevision."); return;
            }
            std::string error;
            std::uint64_t requestedRevision = 0U;
            if (!engine.confirmTrackTempoProvenance(trackId - 1U, expectedContentRevision, *tempoBpm,
                    tempoRevision, error, &requestedRevision, expectedStopRevision)) {
                response.status = 409; writeError(response, error); return;
            }
            auto status = statusToJson(engine.getStatus());
            status["nativeRecordTempoProvenance"]["acceptedRequestRevision"] = requestedRevision;
            writeJson(response, status);
        } catch (const std::exception& error) { response.status = 400; writeError(response, error.what()); }
    });
    server.Post("/v1/transport/stop", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        std::optional<double> tempoBpm;
        std::uint64_t tempoRevision = 0U;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!readRecordTempoToken(request, tempoBpm, tempoRevision)) {
            response.status = 400; writeError(response, "Stop tempo token requires tempoBpm 40..300 and a nonnegative safe tempoRevision."); return;
        }
        std::uint64_t requestedRevision = 0U;
        if (!engine.stopTrack(trackIndex, error, tempoBpm, tempoRevision, &requestedRevision)) {
            writeError(response, error);
            return;
        }
        auto status = statusToJson(engine.getStatus());
        status["nativeRecordPlay"]["acceptedStopRequestRevision"] = requestedRevision;
        writeJson(response, status);
    });

    server.Post("/v1/transport/play", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!engine.playTrack(trackIndex, error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/overdub-toggle", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!engine.toggleTrackOverdub(trackIndex, error)) {
            response.status = 409;
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/clear", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!engine.clearTrack(trackIndex, error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/mark-set", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        std::uint64_t generation = 0U;
        if (!readTrackMarkRequest(request, "/v1/transport/mark-set", trackIndex, generation, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!engine.setTrackMark(trackIndex, generation, error)) {
            response.status = 409;
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/mark-clear", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        std::uint64_t generation = 0U;
        if (!readTrackMarkRequest(request, "/v1/transport/mark-clear", trackIndex, generation, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!engine.clearTrackMark(trackIndex, generation, error)) {
            response.status = 409;
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/undo", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!engine.undoTrack(trackIndex, error)) {
            response.status = 409;
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/redo", [&engine](const httplib::Request& request, httplib::Response& response) {
        std::string error;
        std::size_t trackIndex = 0U;
        if (!readTrackIndex(request, trackIndex, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        if (!engine.redoTrack(trackIndex, error)) {
            response.status = 409;
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/native-loop-transport/config", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            std::uint64_t trackId = 0U;
            if (!body.contains("trackId") ||
                !readUnsignedJsonInteger(body["trackId"], kNativeTrackCount, trackId) || trackId < 1U) {
                response.status = 400;
                writeError(response, "'trackId' must be an integer between 1 and 5.");
                return;
            }
            if (!body.contains("mode") || !body["mode"].is_string()) {
                response.status = 400;
                writeError(response, "'mode' must be 'off', 'beatShift', or 'vinylFlick'.");
                return;
            }

            LoopTransportConfig config;
            const auto mode = body["mode"].get<std::string>();
            if (mode == "off") config.mode = LoopTransportMode::Off;
            else if (mode == "beatShift") config.mode = LoopTransportMode::BeatShift;
            else if (mode == "vinylFlick") config.mode = LoopTransportMode::VinylFlick;
            else {
                response.status = 400;
                writeError(response, "'mode' must be 'off', 'beatShift', or 'vinylFlick'.");
                return;
            }
            if (body.contains("oneShot")) {
                if (!body["oneShot"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'oneShot' must be a boolean.");
                    return;
                }
                config.oneShot = body["oneShot"].get<bool>();
            }
            if (body.contains("reverse")) {
                if (!body["reverse"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'reverse' must be a boolean.");
                    return;
                }
                config.reverse = body["reverse"].get<bool>();
            }
            std::optional<std::uint64_t> expectedRevision;
            if (body.contains("expectedRevision")) {
                std::uint64_t parsedExpectedRevision = 0U;
                if (!readUnsignedJsonInteger(body["expectedRevision"], kMaximumSafeTempoRevision, parsedExpectedRevision)) {
                    response.status = 400;
                    writeError(response, "'expectedRevision' must be a non-negative safe integer.");
                    return;
                }
                expectedRevision = parsedExpectedRevision;
            }

            const auto readBoundedFloat = [&body, &response](const char* name, double minimum, double maximum, float& target) {
                if (!body.contains(name) || !body[name].is_number()) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' must be numeric.");
                    return false;
                }
                const double value = body[name].get<double>();
                if (!std::isfinite(value) || value < minimum || value > maximum) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' must be between " +
                        std::to_string(minimum) + " and " + std::to_string(maximum) + ".");
                    return false;
                }
                target = static_cast<float>(value);
                return true;
            };
            if (!readBoundedFloat("beatOffsetBeats", -4.0, 4.0, config.beatOffsetBeats) ||
                !readBoundedFloat("bpm", 20.0, 300.0, config.bpm) ||
                !readBoundedFloat("crossfadeMs", 1.0, 10.0, config.crossfadeMs) ||
                !readBoundedFloat("vinylSpeedPercent", -100.0, 100.0, config.vinylSpeedPercent) ||
                !readBoundedFloat("motorReturnSeconds", 0.05, 10.0, config.motorReturnSeconds) ||
                !readBoundedFloat("brakePercent", 0.0, 100.0, config.brakePercent) ||
                !readBoundedFloat("vinylMixPercent", 0.0, 100.0, config.vinylMixPercent)) {
                return;
            }

            std::string error;
            std::uint64_t acceptedRevision = 0U;
            if (!engine.setNativeLoopTransport(static_cast<std::size_t>(trackId - 1U), config, error,
                &acceptedRevision, expectedRevision)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            auto status = statusToJson(engine.getStatus());
            status["nativeTracks"][static_cast<std::size_t>(trackId - 1U)]["loopTransportAcceptedRevision"] = acceptedRevision;
            writeJson(response, status);
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-dub-mode/config", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be an object containing trackId and mode.");
                return;
            }
            std::uint64_t trackId = 0U;
            if (!body.contains("trackId") || !readUnsignedJsonInteger(body["trackId"], kNativeTrackCount, trackId) || trackId < 1U) {
                response.status = 400;
                writeError(response, "'trackId' must be an integer between 1 and 5.");
                return;
            }
            if (!body.contains("mode") || !body["mode"].is_string()) {
                response.status = 400;
                writeError(response, "'mode' must be OVERDUB, REPLACE1, or REPLACE2.");
                return;
            }
            const auto modeName = body["mode"].get<std::string>();
            NativeDubMode mode = NativeDubMode::Overdub;
            if (modeName == "REPLACE1") mode = NativeDubMode::Replace1;
            else if (modeName == "REPLACE2") mode = NativeDubMode::Replace2;
            else if (modeName != "OVERDUB") {
                response.status = 400;
                writeError(response, "'mode' must be OVERDUB, REPLACE1, or REPLACE2.");
                return;
            }
            std::string error;
            std::uint64_t acceptedRevision = 0U;
            if (!engine.setNativeDubMode(static_cast<std::size_t>(trackId - 1U), mode, acceptedRevision, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            auto status = statusToJson(engine.getStatus());
            status["nativeTracks"][trackId - 1U]["dubMode"]["acceptedRevision"] = acceptedRevision;
            writeJson(response, status);
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/monitoring", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            std::string error;
            if (!engine.setMonitoring(body.value("enabled", false), error)) {
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/output-low-pass", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object() || !body.contains("enabled") || !body["enabled"].is_boolean()) {
                response.status = 400;
                writeError(response, "Body must contain a boolean 'enabled' field.");
                return;
            }

            std::string error;
            if (!engine.setOutputLowPassEnabled(body["enabled"].get<bool>(), error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/output-high-pass", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object() || !body.contains("enabled") || !body["enabled"].is_boolean()) {
                response.status = 400;
                writeError(response, "Body must contain a boolean 'enabled' field.");
                return;
            }
            std::string error;
            if (!engine.setOutputHighPassEnabled(body["enabled"].get<bool>(), error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/reverb", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            const auto current = engine.getStatus();
            NativeReverbConfig config;
            config.enabled = current.nativeReverbEnabled;
            config.wetMix = current.nativeReverbWetMix;
            config.rt60Seconds = current.nativeReverbRt60Seconds;
            config.dampingCutoffHz = current.nativeReverbDampingCutoffHz;
            if (body.contains("enabled")) {
                if (!body["enabled"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'enabled' must be a boolean.");
                    return;
                }
                config.enabled = body["enabled"].get<bool>();
            }
            if (body.contains("wetMix")) {
                if (!body["wetMix"].is_number()) {
                    response.status = 400;
                    writeError(response, "'wetMix' must be numeric from 0 to 1.");
                    return;
                }
                const double wetMix = body["wetMix"].get<double>();
                if (!std::isfinite(wetMix) || wetMix < 0.0 || wetMix > 1.0) {
                    response.status = 400;
                    writeError(response, "'wetMix' must be numeric from 0 to 1.");
                    return;
                }
                config.wetMix = static_cast<float>(wetMix);
            }
            if (body.contains("rt60Seconds")) {
                if (!body["rt60Seconds"].is_number()) {
                    response.status = 400;
                    writeError(response, "'rt60Seconds' must be numeric from 0.1 to 20.");
                    return;
                }
                const double rt60Seconds = body["rt60Seconds"].get<double>();
                if (!std::isfinite(rt60Seconds) || rt60Seconds < 0.1 || rt60Seconds > 20.0) {
                    response.status = 400;
                    writeError(response, "'rt60Seconds' must be numeric from 0.1 to 20.");
                    return;
                }
                config.rt60Seconds = static_cast<float>(rt60Seconds);
            }
            if (body.contains("dampingCutoffHz")) {
                if (!body["dampingCutoffHz"].is_number()) {
                    response.status = 400;
                    writeError(response, "'dampingCutoffHz' must be numeric from 500 to 20000.");
                    return;
                }
                const double dampingCutoffHz = body["dampingCutoffHz"].get<double>();
                if (!std::isfinite(dampingCutoffHz) || dampingCutoffHz < 500.0 || dampingCutoffHz > 20000.0) {
                    response.status = 400;
                    writeError(response, "'dampingCutoffHz' must be numeric from 500 to 20000.");
                    return;
                }
                config.dampingCutoffHz = static_cast<float>(dampingCutoffHz);
            }

            std::string error;
            if (!engine.setNativeReverbConfig(config, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/fractional-delay", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            const auto current = engine.getStatus();
            NativeFractionalDelayConfig config;
            config.enabled = current.nativeFractionalDelayEnabled;
            config.slot = current.nativeFractionalDelaySlot;
            config.algorithm = current.nativeFractionalDelayAlgorithm;
            config.delayMs = current.nativeFractionalDelayMs;
            config.wetMix = current.nativeFractionalDelayWetMix;
            config.feedback = current.nativeFractionalDelayFeedback;

            if (body.contains("slot")) {
                if (!body["slot"].is_string()) {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
                const auto slot = body["slot"].get<std::string>();
                if (slot == "A") {
                    config.slot = NativeTrackOutputSlot::A;
                } else if (slot == "B") {
                    config.slot = NativeTrackOutputSlot::B;
                } else if (slot == "C") {
                    config.slot = NativeTrackOutputSlot::C;
                } else if (slot == "D") {
                    config.slot = NativeTrackOutputSlot::D;
                } else {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
            }
            if (body.contains("enabled")) {
                if (!body["enabled"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'enabled' must be a boolean.");
                    return;
                }
                config.enabled = body["enabled"].get<bool>();
            }
            if (body.contains("algorithm")) {
                if (!body["algorithm"].is_string()) {
                    response.status = 400;
                    writeError(response, "'algorithm' must be a string.");
                    return;
                }
                const auto algorithm = body["algorithm"].get<std::string>();
                if (algorithm != "lagrange4") {
                    response.status = 409;
                    writeError(response, "Only algorithm 'lagrange4' is implemented for Native fractional delay.");
                    return;
                }
                config.algorithm = NativeFractionalDelayAlgorithm::Lagrange4;
            }

            const auto readBoundedFloat = [&body, &response](const char* name, double minimum, double maximum, float& target) {
                if (!body.contains(name)) {
                    return true;
                }
                if (!body[name].is_number()) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' must be numeric.");
                    return false;
                }
                const double value = body[name].get<double>();
                if (!std::isfinite(value) || value < minimum || value > maximum) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' is outside its supported range.");
                    return false;
                }
                target = static_cast<float>(value);
                return true;
            };
            if (!readBoundedFloat("delayMs", 10.0, 2000.0, config.delayMs) ||
                !readBoundedFloat("wetMix", 0.0, 1.0, config.wetMix) ||
                !readBoundedFloat("feedback", 0.0, 0.95, config.feedback)) {
                return;
            }

            std::string error;
            if (!engine.setNativeFractionalDelayConfig(config, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/compressor", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            const auto current = engine.getStatus();
            NativeCompressorConfig config;
            config.enabled = current.nativeCompressorEnabled;
            config.slot = current.nativeCompressorSlot;
            config.algorithm = current.nativeCompressorAlgorithm;
            config.thresholdDb = current.nativeCompressorThresholdDb;
            config.ratio = current.nativeCompressorRatio;
            config.attackMs = current.nativeCompressorAttackMs;
            config.releaseMs = current.nativeCompressorReleaseMs;
            config.wetMix = current.nativeCompressorWetMix;
            config.makeupDb = current.nativeCompressorMakeupDb;

            if (body.contains("slot")) {
                if (!body["slot"].is_string()) {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
                const auto slot = body["slot"].get<std::string>();
                if (slot == "A") {
                    config.slot = NativeTrackOutputSlot::A;
                } else if (slot == "B") {
                    config.slot = NativeTrackOutputSlot::B;
                } else if (slot == "C") {
                    config.slot = NativeTrackOutputSlot::C;
                } else if (slot == "D") {
                    config.slot = NativeTrackOutputSlot::D;
                } else {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
            }
            if (body.contains("enabled")) {
                if (!body["enabled"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'enabled' must be a boolean.");
                    return;
                }
                config.enabled = body["enabled"].get<bool>();
            }
            if (body.contains("algorithm")) {
                if (!body["algorithm"].is_string()) {
                    response.status = 400;
                    writeError(response, "'algorithm' must be a string.");
                    return;
                }
                if (body["algorithm"].get<std::string>() != "peakCompressor") {
                    response.status = 409;
                    writeError(response, "Only algorithm 'peakCompressor' is implemented for Native compression.");
                    return;
                }
                config.algorithm = NativeCompressorAlgorithm::PeakCompressor;
            }

            const auto readBoundedFloat = [&body, &response](const char* name, double minimum, double maximum, float& target) {
                if (!body.contains(name)) {
                    return true;
                }
                if (!body[name].is_number()) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' must be numeric.");
                    return false;
                }
                const double value = body[name].get<double>();
                if (!std::isfinite(value) || value < minimum || value > maximum) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' is outside its supported range.");
                    return false;
                }
                target = static_cast<float>(value);
                return true;
            };
            if (!readBoundedFloat("thresholdDb", -60.0, 0.0, config.thresholdDb) ||
                !readBoundedFloat("ratio", 1.0, 20.0, config.ratio) ||
                !readBoundedFloat("attackMs", 0.1, 200.0, config.attackMs) ||
                !readBoundedFloat("releaseMs", 5.0, 2000.0, config.releaseMs) ||
                !readBoundedFloat("wetMix", 0.0, 1.0, config.wetMix) ||
                !readBoundedFloat("makeupDb", -12.0, 12.0, config.makeupDb)) {
                return;
            }

            std::string error;
            if (!engine.setNativeCompressorConfig(config, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/chorus", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            const auto current = engine.getStatus();
            NativeChorusConfig config;
            config.enabled = current.nativeChorusEnabled;
            config.slot = current.nativeChorusSlot;
            config.algorithm = current.nativeChorusAlgorithm;
            config.rateHz = current.nativeChorusRateHz;
            config.depthMs = current.nativeChorusDepthMs;
            config.feedback = current.nativeChorusFeedback;
            config.wetMix = current.nativeChorusWetMix;

            if (body.contains("slot")) {
                if (!body["slot"].is_string()) {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
                const auto slot = body["slot"].get<std::string>();
                if (slot == "A") {
                    config.slot = NativeTrackOutputSlot::A;
                } else if (slot == "B") {
                    config.slot = NativeTrackOutputSlot::B;
                } else if (slot == "C") {
                    config.slot = NativeTrackOutputSlot::C;
                } else if (slot == "D") {
                    config.slot = NativeTrackOutputSlot::D;
                } else {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
            }
            if (body.contains("enabled")) {
                if (!body["enabled"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'enabled' must be a boolean.");
                    return;
                }
                config.enabled = body["enabled"].get<bool>();
            }
            if (body.contains("algorithm")) {
                if (!body["algorithm"].is_string()) {
                    response.status = 400;
                    writeError(response, "'algorithm' must be a string.");
                    return;
                }
                if (body["algorithm"].get<std::string>() != "stereoLfoLagrange4") {
                    response.status = 409;
                    writeError(response, "Only algorithm 'stereoLfoLagrange4' is implemented for Native chorus.");
                    return;
                }
                config.algorithm = NativeChorusAlgorithm::StereoLfoLagrange4;
            }

            const auto readBoundedFloat = [&body, &response](const char* name, double minimum, double maximum, float& target) {
                if (!body.contains(name)) {
                    return true;
                }
                if (!body[name].is_number()) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' must be numeric.");
                    return false;
                }
                const double value = body[name].get<double>();
                if (!std::isfinite(value) || value < minimum || value > maximum) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' is outside its supported range.");
                    return false;
                }
                target = static_cast<float>(value);
                return true;
            };
            if (!readBoundedFloat("rateHz", 0.1, 8.0, config.rateHz) ||
                !readBoundedFloat("depthMs", 0.0, 25.0, config.depthMs) ||
                !readBoundedFloat("feedback", 0.0, 0.95, config.feedback) ||
                !readBoundedFloat("wetMix", 0.0, 1.0, config.wetMix)) {
                return;
            }

            std::string error;
            if (!engine.setNativeChorusConfig(config, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/phaser", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            const auto current = engine.getStatus();
            NativePhaserConfig config;
            config.enabled = current.nativePhaserEnabled;
            config.slot = current.nativePhaserSlot;
            config.algorithm = current.nativePhaserAlgorithm;
            config.stages = current.nativePhaserStages;
            config.rateHz = current.nativePhaserRateHz;
            config.depth = current.nativePhaserDepth;
            config.feedback = current.nativePhaserFeedback;
            config.wetMix = current.nativePhaserWetMix;

            if (body.contains("slot")) {
                if (!body["slot"].is_string()) {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
                const auto slot = body["slot"].get<std::string>();
                if (slot == "A") {
                    config.slot = NativeTrackOutputSlot::A;
                } else if (slot == "B") {
                    config.slot = NativeTrackOutputSlot::B;
                } else if (slot == "C") {
                    config.slot = NativeTrackOutputSlot::C;
                } else if (slot == "D") {
                    config.slot = NativeTrackOutputSlot::D;
                } else {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
            }
            if (body.contains("enabled")) {
                if (!body["enabled"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'enabled' must be a boolean.");
                    return;
                }
                config.enabled = body["enabled"].get<bool>();
            }
            if (body.contains("algorithm")) {
                if (!body["algorithm"].is_string()) {
                    response.status = 400;
                    writeError(response, "'algorithm' must be a string.");
                    return;
                }
                if (body["algorithm"].get<std::string>() != "allpassSweep") {
                    response.status = 409;
                    writeError(response, "Only algorithm 'allpassSweep' is implemented for Native phaser; BI-PHASE is unavailable.");
                    return;
                }
                config.algorithm = NativePhaserAlgorithm::AllpassSweep;
            }
            if (body.contains("stages")) {
                if (!body["stages"].is_number_integer()) {
                    response.status = 400;
                    writeError(response, "'stages' must be the integer 4, 8, or 12.");
                    return;
                }
                const auto stages = body["stages"].get<int>();
                if (stages != 4 && stages != 8 && stages != 12) {
                    response.status = 400;
                    writeError(response, "'stages' must be the integer 4, 8, or 12.");
                    return;
                }
                config.stages = static_cast<unsigned int>(stages);
            }

            const auto readBoundedFloat = [&body, &response](const char* name, double minimum, double maximum, float& target) {
                if (!body.contains(name)) {
                    return true;
                }
                if (!body[name].is_number()) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' must be numeric.");
                    return false;
                }
                const double value = body[name].get<double>();
                if (!std::isfinite(value) || value < minimum || value > maximum) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' is outside its supported range.");
                    return false;
                }
                target = static_cast<float>(value);
                return true;
            };
            if (!readBoundedFloat("rateHz", 0.05, 10.0, config.rateHz) ||
                !readBoundedFloat("depth", 0.0, 1.0, config.depth) ||
                !readBoundedFloat("feedback", -0.9, 0.9, config.feedback) ||
                !readBoundedFloat("wetMix", 0.0, 1.0, config.wetMix)) {
                return;
            }

            std::string error;
            if (!engine.setNativePhaserConfig(config, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/catalog-slot", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }
            if (!body.contains("slot") || !body["slot"].is_string() ||
                !body.contains("effectId") || !body["effectId"].is_string()) {
                response.status = 400;
                writeError(response, "Fields 'slot' and 'effectId' must be strings.");
                return;
            }
            NativeEffectSlot slot;
            const auto slotName = body["slot"].get<std::string>();
            if (slotName == "A") slot = NativeEffectSlot::A;
            else if (slotName == "B") slot = NativeEffectSlot::B;
            else if (slotName == "C") slot = NativeEffectSlot::C;
            else if (slotName == "D") slot = NativeEffectSlot::D;
            else {
                response.status = 400;
                writeError(response, "'slot' must be one of A, B, C, or D.");
                return;
            }

            const std::string effectId = body["effectId"].get<std::string>();
            NativeCatalogFxPath path = NativeCatalogFxPath::Track;
            if (body.contains("path")) {
                if (!body["path"].is_string()) {
                    response.status = 400;
                    writeError(response, "'path' must be 'input' or 'track'.");
                    return;
                }
                const auto pathName = body["path"].get<std::string>();
                if (pathName == "input") path = NativeCatalogFxPath::Input;
                else if (pathName != "track") {
                    response.status = 400;
                    writeError(response, "'path' must be 'input' or 'track'.");
                    return;
                }
            }
            std::map<std::string, float> parameters;
            if (body.contains("parameters")) {
                if (!body["parameters"].is_object()) {
                    response.status = 400;
                    writeError(response, "'parameters' must be a JSON object of numeric values.");
                    return;
                }
                for (const auto& [parameterId, value] : body["parameters"].items()) {
                    if (!value.is_number()) {
                        response.status = 400;
                        writeError(response, "Every catalog FX parameter value must be numeric.");
                        return;
                    }
                    const double number = value.get<double>();
                    if (!std::isfinite(number) ||
                        number < -static_cast<double>(std::numeric_limits<float>::max()) ||
                        number > static_cast<double>(std::numeric_limits<float>::max())) {
                        response.status = 400;
                        writeError(response, "Every catalog FX parameter must be finite and representable as a float.");
                        return;
                    }
                    parameters.emplace(parameterId, static_cast<float>(number));
                }
            }

            std::uint64_t trackIdValue = 0U;
            if (body.contains("trackId") && !readUnsignedJsonInteger(body["trackId"], kNativeTrackCount, trackIdValue)) {
                response.status = 400;
                writeError(response, "'trackId' must be an integer 0-5; Input only accepts 0.");
                return;
            }
            if (path == NativeCatalogFxPath::Input && trackIdValue != 0U) {
                response.status = 400;
                writeError(response, "Input catalog FX only accepts trackId 0.");
                return;
            }
            const auto trackId = static_cast<std::uint8_t>(trackIdValue);
            bool bypassed = false;
            if (body.contains("bypassed")) {
                if (!body["bypassed"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'bypassed' must be a boolean.");
                    return;
                }
                bypassed = body["bypassed"].get<bool>();
            } else {
                const auto current = engine.getStatus();
                const auto index = static_cast<std::size_t>(slot);
                bypassed = path == NativeCatalogFxPath::Input
                    ? current.nativeInputCatalogSlotBypassed[index]
                    : trackId == 0U ? current.nativeCatalogSlotBypassed[index]
                    : current.nativePerTrackCatalogSlots[trackId - 1U][index].bypassed;
            }

            bool replaceParameters = false;
            if (body.contains("replaceParameters")) {
                if (!body["replaceParameters"].is_boolean()) {
                    response.status = 400; writeError(response, "'replaceParameters' must be a boolean."); return;
                }
                replaceParameters = body["replaceParameters"].get<bool>();
            }
            std::string error;
            if (!engine.setNativeCatalogSlot(slot, effectId, parameters, bypassed, error, path, trackId, replaceParameters)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-track-fx/apply", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object() || !body.contains("trackId") || !body.contains("enabled") ||
                !body["enabled"].is_boolean()) {
                response.status = 400;
                writeError(response, "Fields 'trackId' (1-5) and 'enabled' (boolean) are required.");
                return;
            }
            std::uint64_t trackId = 0U;
            if (!readUnsignedJsonInteger(body["trackId"], kNativeTrackCount, trackId) || trackId < 1U) {
                response.status = 400;
                writeError(response, "'trackId' must be an integer between 1 and 5.");
                return;
            }
            const bool enabled = body["enabled"].get<bool>();
            std::uint64_t requestedRevision = 0U;
            std::string error;
            if (!engine.setNativeTrackFxApply(static_cast<std::size_t>(trackId), enabled, requestedRevision, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }

            constexpr auto acknowledgementTimeout = std::chrono::milliseconds(500);
            const auto deadline = std::chrono::steady_clock::now() + acknowledgementTimeout;
            EngineStatus latest;
            const std::size_t trackIndex = static_cast<std::size_t>(trackId - 1U);
            do {
                latest = engine.getStatus();
                const auto& apply = latest.nativeTrackFxApply[trackIndex];
                if (apply.appliedRevision >= requestedRevision) {
                    if (apply.requestedRevision != requestedRevision || apply.appliedRevision != requestedRevision ||
                        apply.controlFaulted || apply.requested != enabled || apply.applied != enabled) {
                        response.status = 409;
                        writeError(response, "Native audio callback did not leave the Track FX route at the requested state.");
                        return;
                    }
                    writeJson(response, statusToJson(latest));
                    return;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            } while (std::chrono::steady_clock::now() < deadline);

            latest = engine.getStatus(); // One authoritative readback; this command is never retried.
            response.status = 504;
            auto payload = statusToJson(latest);
            payload["ok"] = false;
            payload["error"] = "Native audio callback did not acknowledge Track FX apply revision " +
                std::to_string(requestedRevision) + " before the deadline; inspect trackFxApply status before any retry.";
            writeJson(response, payload);
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/osc-voc-midi", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }
            const auto requireString = [&body](const char* key) {
                return body.contains(key) && body[key].is_string();
            };
            if (!requireString("path") || !requireString("slot") || !requireString("type")) {
                response.status = 400;
                writeError(response, "Fields 'path', 'slot', and 'type' must be strings.");
                return;
            }
            const auto pathName = body["path"].get<std::string>();
            NativeCatalogFxPath path;
            if (pathName == "input") path = NativeCatalogFxPath::Input;
            else if (pathName == "track") path = NativeCatalogFxPath::Track;
            else {
                response.status = 400;
                writeError(response, "'path' must be 'input' or 'track'.");
                return;
            }

            const auto slotName = body["slot"].get<std::string>();
            NativeEffectSlot slot;
            if (slotName == "A") slot = NativeEffectSlot::A;
            else if (slotName == "B") slot = NativeEffectSlot::B;
            else if (slotName == "C") slot = NativeEffectSlot::C;
            else if (slotName == "D") slot = NativeEffectSlot::D;
            else {
                response.status = 400;
                writeError(response, "'slot' must be one of A, B, C, or D.");
                return;
            }

            const auto eventType = body["type"].get<std::string>();
            bool noteOn = false;
            if (eventType == "noteOn") noteOn = true;
            else if (eventType != "noteOff") {
                response.status = 400;
                writeError(response, "'type' must be 'noteOn' or 'noteOff'.");
                return;
            }
            if (!body.contains("channel") || !body.contains("note") ||
                !body.contains("velocity") || !body.contains("frame")) {
                response.status = 400;
                writeError(response, "Fields 'channel', 'note', 'velocity', and 'frame' are required integers.");
                return;
            }
            std::uint64_t channelValue = 0U;
            std::uint64_t noteValue = 0U;
            std::uint64_t velocityValue = 0U;
            std::uint64_t frameValue = 0U;
            if (!readUnsignedJsonInteger(body["channel"], 16U, channelValue) || channelValue < 1U ||
                !readUnsignedJsonInteger(body["note"], 127U, noteValue) ||
                !readUnsignedJsonInteger(body["velocity"], 127U, velocityValue) ||
                !readUnsignedJsonInteger(body["frame"], std::numeric_limits<std::uint64_t>::max() - 1U, frameValue)) {
                response.status = 400;
                writeError(response, "MIDI channel must be 1-16, note/velocity 0-127, and frame a nonnegative integer below uint64 max.");
                return;
            }

            std::uint64_t trackIdValue = 0U;
            if (body.contains("trackId") && !readUnsignedJsonInteger(body["trackId"], kNativeTrackCount, trackIdValue)) {
                response.status = 400;
                writeError(response, "'trackId' must be an integer 0-5; Input only accepts 0.");
                return;
            }
            if (path == NativeCatalogFxPath::Input && trackIdValue != 0U) {
                response.status = 400;
                writeError(response, "Input catalog FX only accepts trackId 0.");
                return;
            }
            const auto trackId = static_cast<std::uint8_t>(trackIdValue);
            std::string error;
            if (!engine.queueNativeOscVocMidiEvent(path, slot, noteOn,
                    static_cast<int>(channelValue), static_cast<int>(noteValue),
                    static_cast<int>(velocityValue), frameValue, error, trackId)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/catalog-midi", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }
            const auto requireString = [&body](const char* key) {
                return body.contains(key) && body[key].is_string();
            };
            if (!requireString("effectId") || !requireString("path") ||
                !requireString("slot") || !requireString("type")) {
                response.status = 400;
                writeError(response, "Fields 'effectId', 'path', 'slot', and 'type' must be strings.");
                return;
            }
            const auto effectId = body["effectId"].get<std::string>();
            const auto pathName = body["path"].get<std::string>();
            NativeCatalogFxPath path;
            if (pathName == "input") path = NativeCatalogFxPath::Input;
            else if (pathName == "track") path = NativeCatalogFxPath::Track;
            else {
                response.status = 400;
                writeError(response, "'path' must be 'input' or 'track'.");
                return;
            }

            const auto slotName = body["slot"].get<std::string>();
            NativeEffectSlot slot;
            if (slotName == "A") slot = NativeEffectSlot::A;
            else if (slotName == "B") slot = NativeEffectSlot::B;
            else if (slotName == "C") slot = NativeEffectSlot::C;
            else if (slotName == "D") slot = NativeEffectSlot::D;
            else {
                response.status = 400;
                writeError(response, "'slot' must be one of A, B, C, or D.");
                return;
            }

            const auto eventType = body["type"].get<std::string>();
            bool noteOn = false;
            if (eventType == "noteOn") noteOn = true;
            else if (eventType != "noteOff") {
                response.status = 400;
                writeError(response, "'type' must be 'noteOn' or 'noteOff'.");
                return;
            }
            if (!body.contains("channel") || !body.contains("note") ||
                !body.contains("velocity") || !body.contains("frame")) {
                response.status = 400;
                writeError(response, "Fields 'channel', 'note', 'velocity', and 'frame' are required integers.");
                return;
            }
            std::uint64_t channelValue = 0U;
            std::uint64_t noteValue = 0U;
            std::uint64_t velocityValue = 0U;
            std::uint64_t frameValue = 0U;
            if (!readUnsignedJsonInteger(body["channel"], 16U, channelValue) || channelValue < 1U ||
                !readUnsignedJsonInteger(body["note"], 127U, noteValue) ||
                !readUnsignedJsonInteger(body["velocity"], 127U, velocityValue) ||
                !readUnsignedJsonInteger(body["frame"], std::numeric_limits<std::uint64_t>::max() - 1U, frameValue)) {
                response.status = 400;
                writeError(response, "MIDI channel must be 1-16, note/velocity 0-127, and frame a nonnegative integer below uint64 max.");
                return;
            }

            std::uint64_t trackIdValue = 0U;
            if (body.contains("trackId") && !readUnsignedJsonInteger(body["trackId"], kNativeTrackCount, trackIdValue)) {
                response.status = 400;
                writeError(response, "'trackId' must be an integer 0-5; Input only accepts 0.");
                return;
            }
            if (path == NativeCatalogFxPath::Input && trackIdValue != 0U) {
                response.status = 400;
                writeError(response, "Input catalog FX only accepts trackId 0.");
                return;
            }
            const auto trackId = static_cast<std::uint8_t>(trackIdValue);
            std::string error;
            if (!engine.queueNativeCatalogMidiEvent(effectId, path, slot, noteOn,
                    static_cast<int>(channelValue), static_cast<int>(noteValue),
                    static_cast<int>(velocityValue), frameValue, error, trackId)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-fx/auto-pan", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            const auto current = engine.getStatus();
            NativeAutoPanConfig config;
            config.enabled = current.nativeAutoPanEnabled;
            config.slot = current.nativeAutoPanSlot;
            config.algorithm = current.nativeAutoPanAlgorithm;
            config.rateHz = current.nativeAutoPanRateHz;
            config.depth = current.nativeAutoPanDepth;
            config.waveform = current.nativeAutoPanWaveform;
            config.wetMix = current.nativeAutoPanWetMix;

            if (body.contains("slot")) {
                if (!body["slot"].is_string()) {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
                const auto slot = body["slot"].get<std::string>();
                if (slot == "A") {
                    config.slot = NativeTrackOutputSlot::A;
                } else if (slot == "B") {
                    config.slot = NativeTrackOutputSlot::B;
                } else if (slot == "C") {
                    config.slot = NativeTrackOutputSlot::C;
                } else if (slot == "D") {
                    config.slot = NativeTrackOutputSlot::D;
                } else {
                    response.status = 400;
                    writeError(response, "'slot' must be one of A, B, C, or D.");
                    return;
                }
            }
            if (body.contains("enabled")) {
                if (!body["enabled"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'enabled' must be a boolean.");
                    return;
                }
                config.enabled = body["enabled"].get<bool>();
            }
            if (body.contains("algorithm")) {
                if (!body["algorithm"].is_string()) {
                    response.status = 400;
                    writeError(response, "'algorithm' must be a string.");
                    return;
                }
                if (body["algorithm"].get<std::string>() != "equalPowerMidSideLfo") {
                    response.status = 409;
                    writeError(response, "Only clean-room algorithm 'equalPowerMidSideLfo' is implemented for Native AUTO PAN.");
                    return;
                }
                config.algorithm = NativeAutoPanAlgorithm::EqualPowerMidSideLfo;
            }
            if (body.contains("waveform")) {
                if (!body["waveform"].is_string()) {
                    response.status = 400;
                    writeError(response, "'waveform' must be sine, triangle, or square.");
                    return;
                }
                const auto waveform = body["waveform"].get<std::string>();
                if (waveform == "sine") {
                    config.waveform = NativeAutoPanWaveform::Sine;
                } else if (waveform == "triangle") {
                    config.waveform = NativeAutoPanWaveform::Triangle;
                } else if (waveform == "square") {
                    config.waveform = NativeAutoPanWaveform::Square;
                } else {
                    response.status = 400;
                    writeError(response, "'waveform' must be sine, triangle, or square.");
                    return;
                }
            }

            const auto readBoundedFloat = [&body, &response](const char* name, double minimum, double maximum, float& target) {
                if (!body.contains(name)) {
                    return true;
                }
                if (!body[name].is_number()) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' must be numeric.");
                    return false;
                }
                const double value = body[name].get<double>();
                if (!std::isfinite(value) || value < minimum || value > maximum) {
                    response.status = 400;
                    writeError(response, std::string("'") + name + "' is outside its supported range.");
                    return false;
                }
                target = static_cast<float>(value);
                return true;
            };
            if (!readBoundedFloat("rateHz", 0.05, 20.0, config.rateHz) ||
                !readBoundedFloat("depth", 0.0, 1.0, config.depth) ||
                !readBoundedFloat("wetMix", 0.0, 1.0, config.wetMix)) {
                return;
            }

            std::string error;
            if (!engine.setNativeAutoPanConfig(config, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-pitch/config", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            const auto current = engine.getStatus();
            NativePitchConfig config;
            config.enabled = current.nativePitchEnabled;
            config.mode = current.nativePitchMode;
            config.semitones = current.nativePitchSemitones;
            config.reversePlayback = current.nativePitchReversePlayback;
            // Omitted trackId remains the legacy global bus for existing callers.
            config.trackId = 0U;
            if (body.contains("trackId")) {
                if (!body["trackId"].is_number_integer()) {
                    response.status = 400;
                    writeError(response, "'trackId' must be an integer from 0 to 5.");
                    return;
                }
                const auto trackId = body["trackId"].get<std::int64_t>();
                if (trackId < 0 || trackId > static_cast<std::int64_t>(kNativeTrackCount)) {
                    response.status = 400;
                    writeError(response, "'trackId' must be 0 (global) or a track ID from 1 to 5.");
                    return;
                }
                config.trackId = static_cast<std::uint8_t>(trackId);
            }
            if (body.contains("mode")) {
                if (!body["mode"].is_string()) {
                    response.status = 400;
                    writeError(response, "'mode' must be a string.");
                    return;
                }
                const auto mode = body["mode"].get<std::string>();
                if (mode == "liveMonoKeepPitch" || mode == "LIVE_MONO") {
                    config.mode = NativePitchMode::LiveMonoKeepPitch;
                } else if (mode == "livePolyPhaseVocoder" || mode == "LIVE_POLY") {
                    config.mode = NativePitchMode::LivePolyPhaseVocoder;
                } else {
                    response.status = 400;
                    writeError(response, "'mode' must be 'liveMonoKeepPitch' or 'livePolyPhaseVocoder'.");
                    return;
                }
            }
            if (body.contains("enabled")) {
                if (!body["enabled"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'enabled' must be a boolean.");
                    return;
                }
                config.enabled = body["enabled"].get<bool>();
            }
            if (body.contains("reversePlayback")) {
                if (!body["reversePlayback"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'reversePlayback' must be a boolean.");
                    return;
                }
                config.reversePlayback = body["reversePlayback"].get<bool>();
            }
            if (body.contains("semitones")) {
                if (!body["semitones"].is_number()) {
                    response.status = 400;
                    writeError(response, "'semitones' must be numeric.");
                    return;
                }
                const double semitones = body["semitones"].get<double>();
                if (!std::isfinite(semitones) || semitones < -12.0 || semitones > 12.0) {
                    response.status = 400;
                    writeError(response, "'semitones' must be between -12 and +12.");
                    return;
                }
                config.semitones = static_cast<float>(semitones);
            }

            std::string error;
            if (!engine.setNativePitchConfig(config, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/native-rhythm/config", [&engine](const httplib::Request& request, httplib::Response& response) {
        if (request.has_header("X-Native-Host-Incarnation") && !requestMatchesHostIncarnation(request)) {
            response.status = 409;
            writeError(response, "Native host incarnation changed; project-import rhythm synchronization was not applied.");
            return;
        }
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object()) {
                response.status = 400;
                writeError(response, "Body must be a JSON object.");
                return;
            }

            const auto current = engine.getStatus();
            NativeRhythmConfig config;
            config.enabled = current.nativeRhythmEnabled;
            config.bpm = current.nativeRhythmBpm;
            config.kitIndex = static_cast<std::uint8_t>(current.nativeRhythmKitIndex);
            config.variation = current.nativeRhythmVariation;
            config.section = current.nativeRhythmSection;
            config.patternIndex = static_cast<std::uint16_t>(current.nativeRhythmPatternIndex);
            config.swingPercent = current.nativeRhythmSwingPercent;
            config.quantizeGrid = current.nativeRhythmQuantizeGrid;
            config.volume = current.nativeRhythmVolume;

            if (body.contains("enabled")) {
                if (!body["enabled"].is_boolean()) {
                    response.status = 400;
                    writeError(response, "'enabled' must be a boolean.");
                    return;
                }
                config.enabled = body["enabled"].get<bool>();
            }
            if (body.contains("bpm")) {
                if (!body["bpm"].is_number()) {
                    response.status = 400;
                    writeError(response, "'bpm' must be numeric.");
                    return;
                }
                config.bpm = body["bpm"].get<double>();
            }
            if (body.contains("kitIndex")) {
                if (!body["kitIndex"].is_number_integer()) {
                    response.status = 400;
                    writeError(response, "'kitIndex' must be an integer from 1 to 16.");
                    return;
                }
                const int kitIndex = body["kitIndex"].get<int>();
                if (kitIndex < 1 || kitIndex > 16) {
                    response.status = 400;
                    writeError(response, "'kitIndex' must be an integer from 1 to 16.");
                    return;
                }
                config.kitIndex = static_cast<std::uint8_t>(kitIndex);
            }
            if (body.contains("patternIndex")) {
                if (!body["patternIndex"].is_number_integer()) {
                    response.status = 400;
                    writeError(response, "'patternIndex' must be an integer from 1 to 240.");
                    return;
                }
                const int patternIndex = body["patternIndex"].get<int>();
                if (patternIndex < 1 || patternIndex > 240) {
                    response.status = 400;
                    writeError(response, "'patternIndex' must be an integer from 1 to 240.");
                    return;
                }
                config.patternIndex = static_cast<std::uint16_t>(patternIndex);
            }
            if (body.contains("variation")) {
                if (!body["variation"].is_string() ||
                    !nativeRhythmVariationFromString(body["variation"].get_ref<const std::string&>().c_str(), config.variation)) {
                    response.status = 400;
                    writeError(response, "'variation' must be one of A, B, C, or D.");
                    return;
                }
            }
            if (body.contains("section")) {
                if (!body["section"].is_string() ||
                    !nativeRhythmSectionFromString(body["section"].get_ref<const std::string&>().c_str(), config.section)) {
                    response.status = 400;
                    writeError(response, "'section' must be main, intro, ending, or fill.");
                    return;
                }
            }
            if (body.contains("swingPercent")) {
                if (!body["swingPercent"].is_number_integer()) {
                    response.status = 400;
                    writeError(response, "'swingPercent' must be an integer from 50 to 75.");
                    return;
                }
                const int swingPercent = body["swingPercent"].get<int>();
                if (swingPercent < 50 || swingPercent > 75) {
                    response.status = 400;
                    writeError(response, "'swingPercent' must be an integer from 50 to 75.");
                    return;
                }
                config.swingPercent = static_cast<unsigned int>(swingPercent);
            }
            if (body.contains("quantizeGrid")) {
                if (!body["quantizeGrid"].is_string() ||
                    !nativeRhythmQuantizeGridFromString(body["quantizeGrid"].get_ref<const std::string&>().c_str(),
                        config.quantizeGrid)) {
                    response.status = 400;
                    writeError(response, "'quantizeGrid' must be 1/16, 1/8, or 1/4.");
                    return;
                }
            }
            if (body.contains("volume")) {
                if (!body["volume"].is_number_integer()) {
                    response.status = 400;
                    writeError(response, "'volume' must be an integer from 0 to 100.");
                    return;
                }
                const int volume = body["volume"].get<int>();
                if (volume < 0 || volume > 100) {
                    response.status = 400;
                    writeError(response, "'volume' must be an integer from 0 to 100.");
                    return;
                }
                config.volume = static_cast<unsigned int>(volume);
            }

            std::string error;
            if (!engine.setNativeRhythmConfig(config, error)) {
                response.status = 409;
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            response.status = 400;
            writeError(response, error.what());
        }
    });

    server.Post("/v1/mixer/level", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            if (!body.is_object() || !body.contains("channel") || !body.contains("percent") ||
                !body["channel"].is_number_unsigned() || !body["percent"].is_number_unsigned() ||
                body["channel"].get<std::uint64_t>() > 6U || body["percent"].get<std::uint64_t>() > 200U) {
                response.status = 400; writeError(response, "Expected channel 0..6 and percent 0..200."); return;
            }
            std::string error;
            if (!engine.setMixerLevel(body["channel"].get<unsigned int>(), body["percent"].get<unsigned int>(), error)) {
                response.status = 409; writeError(response, error); return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) { response.status = 400; writeError(response, error.what()); }
    });

    unsigned int listenPort = 17755U;
#if defined(NATIVE_BRIDGE_SIMULATION_ONLY)
#if defined(_MSC_VER)
    char* configuredPort = nullptr;
    std::size_t configuredPortLength = 0U;
    if (_dupenv_s(&configuredPort, &configuredPortLength, "WEBRC_NATIVE_BRIDGE_PORT") != 0) {
        std::cerr << "Unable to read WEBRC_NATIVE_BRIDGE_PORT." << std::endl;
        return 2;
    }
    const std::unique_ptr<char, decltype(&std::free)> configuredPortOwner(configuredPort, &std::free);
#else
    const char* configuredPort = std::getenv("WEBRC_NATIVE_BRIDGE_PORT");
#endif
    if (configuredPort != nullptr) {
        const std::string_view text(configuredPort);
        const auto parsed = std::from_chars(text.data(), text.data() + text.size(), listenPort);
        if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || listenPort == 0U || listenPort > 65535U) {
            std::cerr << "WEBRC_NATIVE_BRIDGE_PORT must be an integer from 1 to 65535." << std::endl;
            return 2;
        }
    }
#endif
    std::cout << "native_bridge_host listening on http://127.0.0.1:" << listenPort << std::endl;
    if (!server.listen("127.0.0.1", listenPort)) {
        std::cerr << "Failed to bind native_bridge_host on 127.0.0.1:" << listenPort << std::endl;
        return 1;
    }

    return 0;
}
