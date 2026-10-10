#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>

#include "native_audio_core.hpp"

#include <algorithm>
#include <iostream>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "httplib.h"
#include "nlohmann/json.hpp"

using json = nlohmann::json;
using namespace webrc::native;

namespace {

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

json optionalNumber(const std::optional<double>& value) {
    return value.has_value() ? json(*value) : json(nullptr);
}

const char* rhythmSectionToString(webrc::dsp::RhythmSection section) noexcept {
    switch (section) {
    case webrc::dsp::RhythmSection::Stopped: return "stopped";
    case webrc::dsp::RhythmSection::Intro: return "intro";
    case webrc::dsp::RhythmSection::VariationA: return "A";
    case webrc::dsp::RhythmSection::VariationB: return "B";
    case webrc::dsp::RhythmSection::VariationC: return "C";
    case webrc::dsp::RhythmSection::VariationD: return "D";
    case webrc::dsp::RhythmSection::Fill: return "fill";
    case webrc::dsp::RhythmSection::Ending: return "ending";
    }
    return "unknown";
}

json rhythmStatusToJson(const NativeTrackHostStatus& status) {
    const auto externalPattern = status.rhythmPatternIndex ==
        webrc::dsp::RhythmRenderer::kExternalPatternSelection;
    return json{
        {"prepared", status.rhythmPrepared},
        {"playing", status.rhythmPlaying},
        {"patternIndex", externalPattern ? json(nullptr) : json(status.rhythmPatternIndex)},
        {"kitIndex", status.rhythmKitIndex},
        {"selectedPatternIndex", externalPattern ? json(nullptr) : json(status.rhythmPatternIndex)},
        {"selectedKitIndex", status.rhythmKitIndex},
        {"variation", status.rhythmVariation},
        {"section", rhythmSectionToString(status.rhythmSection)},
        {"tempoPolicy", "shared-at-command; rhythm-effective-next-bar"},
        {"requestedBpm", status.rhythmTempoTargetBpm},
        {"effectiveBpm", status.rhythmTempoBpm},
        {"tempoPending", status.rhythmTempoPending},
        {"loopTempoPolicy", "sample-locked-no-tempo-resampling"},
        {"requestedVolume", status.rhythmVolumeTarget},
        {"effectiveVolume", status.rhythmVolume},
        {"volumePending", status.rhythmVolumePending},
        {"barIndex", status.rhythmCompletedBars},
        {"absoluteFrame", status.nextFrame},
        {"lastTriggeredFrame", status.rhythmLastTriggeredFrame},
        {"triggerCount", status.rhythmTriggeredEvents},
        {"activeVoices", status.rhythmActiveVoices},
        {"rejectedCommands", status.rejectedRhythmCommands},
        {"lateCommands", status.lateRhythmCommands},
        {"faultCount", status.rhythmFaultCount},
        {"lastFaultFrame", status.lastRhythmFaultFrame},
    };
}

const char* trackStateToString(TrackPlaybackState state) {
    switch (state) {
    case TrackPlaybackState::Recording: return "Recording";
    case TrackPlaybackState::Stopped: return "Stopped";
    case TrackPlaybackState::Playing: return "Playing";
    case TrackPlaybackState::Overdubbing: return "Overdubbing";
    case TrackPlaybackState::Empty:
    default: return "Empty";
    }
}

const char* fxFaultName(NativeFxGraphResult result) noexcept {
    switch (result) {
    case NativeFxGraphResult::Ok: return "Ok";
    case NativeFxGraphResult::NotPrepared: return "NotPrepared";
    case NativeFxGraphResult::AlreadySealed: return "AlreadySealed";
    case NativeFxGraphResult::InvalidSpec: return "InvalidSpec";
    case NativeFxGraphResult::UnsupportedOrdinal: return "UnsupportedOrdinal";
    case NativeFxGraphResult::InvalidRoute: return "InvalidRoute";
    case NativeFxGraphResult::InvalidBus: return "InvalidBus";
    case NativeFxGraphResult::InvalidSlot: return "InvalidSlot";
    case NativeFxGraphResult::InvalidParameter: return "InvalidParameter";
    case NativeFxGraphResult::MemoryBudgetExceeded: return "MemoryBudgetExceeded";
    case NativeFxGraphResult::GraphNotSealed: return "GraphNotSealed";
    case NativeFxGraphResult::BlockTooLarge: return "BlockTooLarge";
    case NativeFxGraphResult::InvalidBlock: return "InvalidBlock";
    case NativeFxGraphResult::MissingBusBuffer: return "MissingBusBuffer";
    case NativeFxGraphResult::MissingCarrier: return "MissingCarrier";
    case NativeFxGraphResult::InvalidEvent: return "InvalidEvent";
    case NativeFxGraphResult::TooManyEvents: return "TooManyEvents";
    case NativeFxGraphResult::EventQueueFull: return "EventQueueFull";
    case NativeFxGraphResult::TimestampOutOfOrder: return "TimestampOutOfOrder";
    case NativeFxGraphResult::NoActiveGraph: return "NoActiveGraph";
    case NativeFxGraphResult::SwapBusy: return "SwapBusy";
    case NativeFxGraphResult::SpecMismatch: return "SpecMismatch";
    case NativeFxGraphResult::EventBatchRejected: return "EventBatchRejected";
    }
    return "Unknown";
}

json statusToJson(const EngineStatus& status) {
    json tracks = json::array();
    for (std::size_t index = 0; index < status.trackHost.tracks.size(); ++index) {
        const auto& track = status.trackHost.tracks[index];
        const float progress = track.loopFrames > 0U
            ? static_cast<float>(track.playhead) / static_cast<float>(track.loopFrames)
            : 0.0f;
        tracks.push_back(json{
            {"id", index + 1U},
            {"state", trackStateToString(track.state)},
            {"recordedFrames", track.recordedFrames},
            {"loopFrames", track.loopFrames},
            {"playhead", track.playhead},
            {"progress", progress},
            {"gain", track.gain},
            {"pan", track.pan},
            {"muted", track.muted},
            {"solo", track.solo},
            {"inputRouted", track.inputRouted},
            {"bufferPrepared", track.bufferPrepared},
        });
    }
    return json{
        {"ok", true},
        {"bridgeHealthy", status.bridgeHealthy},
        {"engineRunning", status.engineRunning},
        {"softwareOnly", status.softwareOnly},
        {"backend", backendToString(status.backend)},
        {"inputDeviceId", status.inputDeviceId},
        {"outputDeviceId", status.outputDeviceId},
        {"inputDeviceName", status.inputDeviceName},
        {"outputDeviceName", status.outputDeviceName},
        {"sampleRate", status.sampleRate},
        {"bufferFrames", status.bufferFrames},
        {"trackEngineVersion", 2},
        {"trackCount", tracks.size()},
        {"trackBufferSeconds", status.trackBufferSeconds},
        {"trackMemoryBudgetBytes", status.trackMemoryBudgetBytes},
        {"trackHistoryBytes", status.trackHost.preparedHistoryBytes},
        {"trackAggregateMemoryBudgetBytes", status.trackHost.aggregateMemoryBudgetBytes},
        {"trackPreparedFixedBytes", status.trackHost.preparedFixedBytes},
        {"fxGraphPreparedBytes", status.trackHost.preparedFxGraphBytes},
        {"fxGraphCandidateBudgetBytes", status.trackHost.candidateFxGraphBudgetBytes},
        {"fxGraphActive", status.trackHost.fxGraphActive},
        {"fxGraphGeneration", status.trackHost.fxGraphGeneration},
        {"fxGraphActiveGeneration", status.trackHost.fxGraphActiveGeneration},
        {"fxDspFaultCount", status.trackHost.fxDspFaultCount},
        {"lastFxDspFaultFrame", status.trackHost.lastFxDspFaultFrame},
        {"lastFxDspFaultCode", static_cast<std::uint8_t>(status.trackHost.lastFxDspFault)},
        {"lastFxDspFault", fxFaultName(status.trackHost.lastFxDspFault)},
        {"nextAudioFrame", status.trackHost.nextFrame},
        {"tempoBpm", status.trackHost.tempoBpm},
        {"rhythm", rhythmStatusToJson(status.trackHost)},
        {"tracks", tracks},
        {"monitoringEnabled", status.monitoringEnabled},
        {"state", looperStateToString(status.state)},
        {"inputLatencyMs", optionalNumber(status.inputLatencyMs)},
        {"outputLatencyMs", optionalNumber(status.outputLatencyMs)},
        {"roundTripEstimateMs", optionalNumber(status.roundTripEstimateMs)},
        {"physicalRoundTripMs", optionalNumber(status.physicalRoundTripMs)},
        {"driverReportedStreamLatencyMs", optionalNumber(status.driverReportedStreamLatencyMs)},
        {"inputLatencySource", status.inputLatencySource},
        {"outputLatencySource", status.outputLatencySource},
        {"driverReportedStreamLatencySource", status.driverReportedStreamLatencySource},
        {"roundTripLatencyNote", status.roundTripLatencyNote},
        {"inputPeak", status.inputPeak},
        {"outputPeak", status.outputPeak},
        {"xrunsOrDropouts", status.xrunsOrDropouts},
        {"callbackStatusFaults", status.callbackStatusFaults},
        {"inputQueueOverruns", status.inputQueueOverruns},
        {"outputQueueUnderruns", status.outputQueueUnderruns},
        {"callbackFrameLimitViolations", status.callbackFrameLimitViolations},
        {"droppedCommands", status.droppedCommands},
        {"outputQueueDepthBlocks", status.outputQueueDepthBlocks},
        {"outputQueueCapacityBlocks", status.outputQueueCapacityBlocks},
        {"lastError", status.lastError},
        {"loopProgress", status.loopProgress},
        {"streamTimeSeconds", status.streamTimeSeconds},
        {"callbackTicks", status.callbackTicks},
        {"inputCallbackTicks", status.inputCallbackTicks},
        {"outputCallbackTicks", status.outputCallbackTicks},
        {"callbackCountSkew", status.callbackCountSkew},
    };
}

void writeJson(httplib::Response& response, const json& payload) {
    response.set_content(payload.dump(), "application/json");
}

void writeError(httplib::Response& response, const std::string& error) {
    writeJson(response, json{{"ok", false}, {"error", error}});
}

const char* fxBusKindName(NativeFxBusKind kind) {
    switch (kind) {
    case NativeFxBusKind::Input: return "input";
    case NativeFxBusKind::Track: return "track";
    case NativeFxBusKind::Send: return "send";
    case NativeFxBusKind::Master: return "master";
    }
    return "input";
}

NativeFxBusKind fxBusKindAt(std::size_t index) {
    if (index == 0U) return NativeFxBusKind::Input;
    if (index <= 5U) return NativeFxBusKind::Track;
    if (index == 6U) return NativeFxBusKind::Send;
    return NativeFxBusKind::Master;
}

bool jsonUnsigned(const json& value, std::uint64_t maximum, std::uint64_t& result) {
    if (!value.is_number_integer() && !value.is_number_unsigned()) return false;
    if (value.is_number_integer()) {
        const auto signedValue = value.get<std::int64_t>();
        if (signedValue < 0) return false;
        result = static_cast<std::uint64_t>(signedValue);
    } else {
        result = value.get<std::uint64_t>();
    }
    return result <= maximum;
}

bool jsonFloat(const json& value, float& result) {
    if (!value.is_number()) return false;
    const double wide = value.get<double>();
    if (!std::isfinite(wide) || wide < -std::numeric_limits<float>::max() ||
        wide > std::numeric_limits<float>::max()) return false;
    result = static_cast<float>(wide);
    return std::isfinite(result);
}

bool hasOnlyKeys(const json& value,
                 std::initializer_list<const char*> allowed) {
    if (!value.is_object()) return false;
    for (auto iterator = value.begin(); iterator != value.end(); ++iterator) {
        const auto key = iterator.key();
        const bool found = std::any_of(allowed.begin(), allowed.end(),
            [&key](const char* candidate) { return key == candidate; });
        if (!found) return false;
    }
    return true;
}

bool parseRhythmCommand(const json& body, NativeRhythmCommandType type,
                        NativeRhythmCommand& command, std::string& error) {
    if (!body.is_object()) {
        error = "Rhythm command body must be a JSON object.";
        return false;
    }
    command = {};
    command.type = type;
    constexpr std::uint64_t maximumExactFrame = (std::uint64_t{1} << 53U) - 1U;
    if (body.contains("absoluteFrame")) {
        std::uint64_t frame = 0U;
        if (!jsonUnsigned(body["absoluteFrame"], maximumExactFrame, frame)) {
            error = "absoluteFrame must be an exact nonnegative integer no greater than 2^53-1.";
            return false;
        }
        command.absoluteFrame = frame;
    }
    std::uint64_t integer = 0U;
    switch (type) {
    case NativeRhythmCommandType::PatternKit:
        if (!hasOnlyKeys(body, {"absoluteFrame", "patternIndex", "kitIndex"}) ||
            !body.contains("patternIndex") || !jsonUnsigned(body["patternIndex"], 239U, integer)) {
            error = "pattern-kit requires patternIndex 0..239, kitIndex 0..15, and optional absoluteFrame.";
            return false;
        }
        command.patternIndex = static_cast<std::uint32_t>(integer);
        if (!body.contains("kitIndex") || !jsonUnsigned(body["kitIndex"], 15U, integer)) {
            error = "pattern-kit requires patternIndex 0..239, kitIndex 0..15, and optional absoluteFrame.";
            return false;
        }
        command.kitIndex = static_cast<std::uint32_t>(integer);
        return true;
    case NativeRhythmCommandType::Start:
        if (!hasOnlyKeys(body, {"absoluteFrame", "playIntro"}) ||
            !body.contains("playIntro") || !body["playIntro"].is_boolean()) {
            error = "start requires boolean playIntro and optional absoluteFrame.";
            return false;
        }
        command.playIntro = body["playIntro"].get<bool>();
        return true;
    case NativeRhythmCommandType::Variation:
        if (!hasOnlyKeys(body, {"absoluteFrame", "variation"}) ||
            !body.contains("variation") || !jsonUnsigned(body["variation"], 3U, integer)) {
            error = "variation requires an integer variation 0..3 and optional absoluteFrame.";
            return false;
        }
        command.variation = static_cast<std::uint8_t>(integer);
        return true;
    case NativeRhythmCommandType::Tempo: {
        float bpm = 0.0f;
        if (!hasOnlyKeys(body, {"absoluteFrame", "bpm"}) ||
            !body.contains("bpm") || !jsonFloat(body["bpm"], bpm) || bpm < 20.0f || bpm > 300.0f) {
            error = "tempo requires finite bpm in the shared 20..300 range and optional absoluteFrame.";
            return false;
        }
        command.bpm = bpm;
        return true;
    }
    case NativeRhythmCommandType::Volume:
        if (!hasOnlyKeys(body, {"absoluteFrame", "volume"}) ||
            !body.contains("volume") || !jsonFloat(body["volume"], command.volume) ||
            command.volume < 0.0f || command.volume > 1.0f) {
            error = "volume requires finite linear gain in [0,1] and optional absoluteFrame.";
            return false;
        }
        return true;
    case NativeRhythmCommandType::Fill:
    case NativeRhythmCommandType::Ending:
    case NativeRhythmCommandType::Stop:
        if (!hasOnlyKeys(body, {"absoluteFrame"})) {
            error = "This rhythm command accepts only an optional absoluteFrame.";
            return false;
        }
        return true;
    }
    error = "Unknown Native rhythm command.";
    return false;
}

void handleRhythmCommand(NativeAudioCore& engine, const httplib::Request& request,
                         httplib::Response& response,
                         NativeRhythmCommandType type) {
    try {
        const auto body = request.body.empty() ? json::object() : json::parse(request.body);
        NativeRhythmCommand command{};
        std::string error;
        if (!parseRhythmCommand(body, type, command, error)) {
            response.status = 400;
            writeError(response, error);
            return;
        }
        std::uint64_t acceptedFrame = 0U;
        if (!engine.postRhythmCommand(command, acceptedFrame, error)) {
            response.status = 409;
            writeError(response, error);
            return;
        }
        const auto status = engine.getStatus();
        auto result = json{
            {"ok", true}, {"accepted", true}, {"acceptedFrame", acceptedFrame},
            {"rhythm", rhythmStatusToJson(status.trackHost)},
        };
        if (type == NativeRhythmCommandType::Tempo) {
            result["requestedBpm"] = status.trackHost.rhythmTempoTargetBpm;
            result["effectiveBpm"] = status.trackHost.rhythmTempoBpm;
            result["tempoPending"] = status.trackHost.rhythmTempoPending;
        } else if (type == NativeRhythmCommandType::Volume) {
            result["requestedVolume"] = status.trackHost.rhythmVolumeTarget;
            result["effectiveVolume"] = status.trackHost.rhythmVolume;
            result["volumePending"] = status.trackHost.rhythmVolumePending;
        }
        writeJson(response, result);
    } catch (const std::exception& exception) {
        response.status = 400;
        writeError(response, exception.what());
    }
}

bool parseStereoPcm(const json& value, std::size_t maximumSamples,
                    std::vector<float>& samples, std::string& error) {
    if (!value.is_array() || value.empty() || value.size() % 2U != 0U ||
        value.size() > maximumSamples) {
        error = "Software render PCM must be a non-empty interleaved stereo array of at most 4096 frames.";
        return false;
    }
    samples.resize(value.size());
    for (std::size_t index = 0U; index < value.size(); ++index) {
        if (!jsonFloat(value[index], samples[index])) {
            error = "Software render PCM samples must be finite float-range numbers.";
            return false;
        }
    }
    return true;
}

bool parseFxBankConfiguration(const json& input, NativeFxBankConfig& result,
                              std::string& error) {
    constexpr std::uint64_t maximumOrdinal = 65535U;
    constexpr std::uint64_t maximumParameterId = 65535U;
    if (!input.is_object()) { error = "FX bank must be a JSON object."; return false; }
    std::uint64_t integer = 0U;
    if (!input.contains("sampleRateHz") ||
        !jsonUnsigned(input["sampleRateHz"], 384000U, integer) || integer < 8000U) {
        error = "FX bank sampleRateHz must be an unsigned integer from 8000 through 384000.";
        return false;
    }
    result.sampleRateHz = static_cast<std::uint32_t>(integer);
    if (!input.contains("channels") || !jsonUnsigned(input["channels"], 2U, integer) || integer != 2U) {
        error = "Native FX banks require exactly two channels.";
        return false;
    }
    result.channels = 2U;
    if (!input.contains("maxBlockFrames") ||
        !jsonUnsigned(input["maxBlockFrames"], kNativeFxGraphMaximumFrames, integer) ||
        integer != kNativeFxGraphMaximumFrames) {
        error = "Native FX banks require a 64-frame maximum block.";
        return false;
    }
    result.maxBlockFrames = kNativeFxGraphMaximumFrames;
    if (!input.contains("buses") || !input["buses"].is_array() ||
        input["buses"].size() != kNativeFxBankBusCount) {
        error = "Native FX banks require exactly eight ordered buses.";
        return false;
    }

    for (std::size_t busIndex = 0U; busIndex < kNativeFxBankBusCount; ++busIndex) {
        const auto& busValue = input["buses"][busIndex];
        if (!busValue.is_object() || !busValue.contains("kind") ||
            !busValue["kind"].is_string() ||
            busValue["kind"].get<std::string>() != fxBusKindName(fxBusKindAt(busIndex))) {
            error = "Native FX bus kind or order is invalid.";
            return false;
        }
        if (busIndex >= 1U && busIndex <= 5U) {
            if (!busValue.contains("trackIndex") ||
                !jsonUnsigned(busValue["trackIndex"], 4U, integer) ||
                integer != busIndex - 1U) {
                error = "Native FX track bus index does not match its position.";
                return false;
            }
        } else if (busValue.contains("trackIndex")) {
            error = "Only track buses may include trackIndex.";
            return false;
        }
        if (!busValue.contains("slots") || !busValue["slots"].is_array() ||
            busValue["slots"].size() != kNativeFxBankSlotsPerBus) {
            error = "Each Native FX bus requires exactly four ordered slots.";
            return false;
        }
        for (std::size_t slotIndex = 0U; slotIndex < kNativeFxBankSlotsPerBus; ++slotIndex) {
            const auto& slotValue = busValue["slots"][slotIndex];
            if (!slotValue.is_object() || !slotValue.contains("enabled") ||
                !slotValue["enabled"].is_boolean()) {
                error = "Each Native FX slot requires a boolean enabled field.";
                return false;
            }
            auto& slot = result.buses[busIndex][slotIndex];
            slot.enabled = slotValue["enabled"].get<bool>();
            if (!slotValue.contains("ordinal") || !jsonUnsigned(slotValue["ordinal"], maximumOrdinal, integer)) {
                error = "Each Native FX slot requires an unsigned ordinal.";
                return false;
            }
            slot.ordinal = static_cast<std::uint16_t>(integer);
            if (!slotValue.contains("mix") || !jsonFloat(slotValue["mix"], slot.mix) ||
                !slotValue.contains("smoothingMs") || !jsonFloat(slotValue["smoothingMs"], slot.smoothingMs)) {
                error = "Each Native FX slot requires finite mix and smoothingMs values.";
                return false;
            }
            if (!slotValue.contains("parameters") || !slotValue["parameters"].is_array() ||
                slotValue["parameters"].size() > kNativeFxBankMaximumParameters) {
                error = "Native FX slot parameters must be an array of at most 64 values.";
                return false;
            }
            slot.parameterCount = static_cast<std::uint8_t>(slotValue["parameters"].size());
            for (std::size_t parameterIndex = 0U;
                 parameterIndex < slotValue["parameters"].size(); ++parameterIndex) {
                const auto& parameterValue = slotValue["parameters"][parameterIndex];
                std::uint64_t parameterId = 0U;
                float value = 0.0f;
                if (!parameterValue.is_object() || !parameterValue.contains("id") ||
                    !jsonUnsigned(parameterValue["id"], maximumParameterId, parameterId) ||
                    !parameterValue.contains("value") || !jsonFloat(parameterValue["value"], value)) {
                    error = "Native FX parameters require an unsigned id and finite value.";
                    return false;
                }
                slot.parameters[parameterIndex] = {
                    static_cast<webrc::dsp::FxParameterId>(parameterId), value};
            }
        }
    }
    return true;
}

json fxBankConfigurationToJson(const NativeFxBankConfig& configuration) {
    json buses = json::array();
    for (std::size_t busIndex = 0U; busIndex < kNativeFxBankBusCount; ++busIndex) {
        json slots = json::array();
        for (std::size_t slotIndex = 0U; slotIndex < kNativeFxBankSlotsPerBus; ++slotIndex) {
            const auto& slot = configuration.buses[busIndex][slotIndex];
            json parameters = json::array();
            for (std::uint8_t index = 0U; index < slot.parameterCount; ++index) {
                parameters.push_back({
                    {"id", static_cast<std::uint16_t>(slot.parameters[index].parameter)},
                    {"value", slot.parameters[index].value},
                });
            }
            slots.push_back({
                {"enabled", slot.enabled}, {"ordinal", slot.ordinal}, {"mix", slot.mix},
                {"smoothingMs", slot.smoothingMs}, {"parameters", std::move(parameters)},
            });
        }
        json bus = {{"kind", fxBusKindName(fxBusKindAt(busIndex))}, {"slots", std::move(slots)}};
        if (busIndex >= 1U && busIndex <= 5U) bus["trackIndex"] = busIndex - 1U;
        buses.push_back(std::move(bus));
    }
    return {{"sampleRateHz", configuration.sampleRateHz}, {"channels", configuration.channels},
            {"maxBlockFrames", configuration.maxBlockFrames}, {"buses", std::move(buses)}};
}

json fxCatalogToJson() {
    json entries = json::array();
    const auto* descriptors = webrc::dsp::fxCatalogData();
    const auto count = webrc::dsp::fxCatalogSize();
    for (std::size_t index = 0U; descriptors != nullptr && index < count; ++index) {
        const auto& descriptor = descriptors[index];
        std::size_t parameterCount = 0U;
        const auto* parameters = webrc::dsp::fxParameterDescriptors(descriptor.ordinal, parameterCount);
        const bool processorAvailable = descriptor.readiness == webrc::dsp::FxReadiness::ProcessorAvailable;
        const bool contextRoutePending = descriptor.ordinal == 20U;
        const bool hostRouteable = processorAvailable && !contextRoutePending;
        std::string routeReason;
        if (descriptor.ordinal == 20U)
            routeReason = "NativeTrackHost does not yet route the required external stereo carrier.";
        else if (!processorAvailable)
            routeReason = "No implemented processor is available in the Native host.";
        json parameterArray = json::array();
        for (std::size_t parameterIndex = 0U;
             parameters != nullptr && parameterIndex < parameterCount; ++parameterIndex) {
            const auto& parameter = parameters[parameterIndex];
            parameterArray.push_back({
                {"id", static_cast<std::uint16_t>(parameter.id)},
                {"name", std::string(parameter.name)}, {"unit", std::string(parameter.unit)},
                {"minimum", parameter.minimum}, {"maximum", parameter.maximum},
                {"defaultValue", parameter.defaultValue},
                {"origin", static_cast<std::uint8_t>(parameter.origin)},
            });
        }
        entries.push_back({
            {"ordinal", descriptor.ordinal}, {"id", std::string(descriptor.id)},
            {"displayName", std::string(descriptor.displayName)},
            {"family", std::string(descriptor.family)}, {"inputFx", descriptor.inputFx},
            {"trackFx", descriptor.trackFx}, {"processorAvailable", processorAvailable},
            {"hostRouteable", hostRouteable}, {"routeLimitReason", routeReason},
            {"officialParameterContractValidated", descriptor.officialParameterContractValidated},
            {"parameters", std::move(parameterArray)},
        });
    }
    return entries;
}

json fxBankSnapshotToJson(const NativeFxBankSnapshot& snapshot, bool ok = true,
                          const std::string& error = {}) {
    json result = {
        {"ok", ok}, {"configured", snapshot.configured},
        {"configuration", snapshot.configuration
            ? fxBankConfigurationToJson(*snapshot.configuration) : json(nullptr)},
        {"stageAccepted", snapshot.stageAccepted}, {"adopted", snapshot.adopted},
        {"producerGeneration", snapshot.producerGeneration == 0U
            ? json(nullptr) : json(snapshot.producerGeneration)},
        {"activeGeneration", snapshot.activeGeneration == 0U
            ? json(nullptr) : json(snapshot.activeGeneration)},
    };
    if (!error.empty()) result["error"] = error;
    return result;
}

const char* fxBankError(const NativeFxBankResult& result) {
    using Status = NativeFxBankStatus;
    switch (result.status) {
    case Status::Ok: return "";
    case Status::HostNotPrepared: return "Native audio host is not prepared.";
    case Status::InvalidConfiguration: return "Native FX bank configuration is invalid.";
    case Status::InvalidSpec: return "Native FX bank audio specification does not match the prepared host.";
    case Status::InvalidBus: return "Native FX event addresses an invalid bus.";
    case Status::InvalidSlot: return "Native FX event addresses an empty or invalid slot.";
    case Status::InvalidMix: return "Native FX slot mix is unsupported or outside its safe range.";
    case Status::UnsupportedOrdinal: return "Native FX processor ordinal is not implemented.";
    case Status::InvalidRoute: return "Native FX processor or mode is not routed by this host.";
    case Status::TooManyParameters: return "Native FX slot has too many parameters.";
    case Status::DuplicateParameter: return "Native FX slot repeats a parameter identifier.";
    case Status::InvalidParameter: return "Native FX parameter value or combined target state is invalid.";
    case Status::PrepareTimeParameterNotAllowed: return "Prepare-time Native FX selectors require restaging the whole bank.";
    case Status::TooManyEvents: return "Native FX event batch exceeds its 64-event bound.";
    case Status::InvalidEvent: return "Native FX event is malformed.";
    case Status::EventOrderRejected: return "Native FX events must be ordered by absolute frame.";
    case Status::MemoryBudgetUnavailable: return "Native FX graph memory admission is unavailable.";
    case Status::MemoryBudgetExceeded: return "Native FX graph exceeds the remaining memory budget.";
    case Status::AllocationFailed: return "Native FX graph allocation failed.";
    case Status::ControlEventRejected: return "Native FX event batch could not be queued atomically.";
    case Status::GraphPrepareFailed: return "Native FX graph prepare failed.";
    case Status::GraphConfigureFailed: return "Native FX graph slot configuration failed.";
    case Status::GraphSealFailed: return "Native FX graph seal failed.";
    case Status::StageFailed: return "Native FX graph was not accepted for staging.";
    }
    return "Native FX request failed.";
}

void writeFxBankResult(httplib::Response& response, NativeAudioCore& engine,
                       const NativeFxBankResult& operation) {
    const auto error = fxBankError(operation);
    if (operation.ok()) {
        writeJson(response, fxBankSnapshotToJson(engine.getFxBankSnapshot()));
        return;
    }
    response.status = 400;
    writeJson(response, fxBankSnapshotToJson(engine.getFxBankSnapshot(), false, error));
}

} // namespace

int main(int argc, char** argv) {
    bool softwareFxTestHost = false;
    if (argc > 1) {
        if (argc != 2 || std::string(argv[1]) != "--software-fx-test-host") {
            std::cerr << "Usage: native_bridge_host [--software-fx-test-host]" << std::endl;
            return 2;
        }
        softwareFxTestHost = true;
    }

    NativeAudioCore engine(softwareFxTestHost);
    if (softwareFxTestHost) {
        std::string softwareHostError;
        if (!engine.prepareSoftwareFxHost(48000U, 3U, 0U, softwareHostError)) {
            std::cerr << softwareHostError << std::endl;
            return 1;
        }
        std::cout << "Software-only FX test host prepared at 48000 Hz; physical devices were neither enumerated nor opened."
                  << std::endl;
    }
    httplib::Server server;

    server.Get("/health", [&engine](const httplib::Request&, httplib::Response& response) {
        const auto status = engine.getStatus();
        writeJson(response, json{
            {"ok", true},
            {"version", "native-audio-core-mvp"},
            {"engineRunning", status.engineRunning},
            {"softwareOnly", status.softwareOnly},
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

    server.Get("/v2/rhythm/status", [&engine](const httplib::Request&, httplib::Response& response) {
        const auto status = engine.getStatus();
        writeJson(response, json{{"ok", true}, {"rhythm", rhythmStatusToJson(status.trackHost)}});
    });

    server.Post("/v2/rhythm/pattern-kit", [&engine](const httplib::Request& request,
                                                       httplib::Response& response) {
        handleRhythmCommand(engine, request, response, NativeRhythmCommandType::PatternKit);
    });
    server.Post("/v2/rhythm/start", [&engine](const httplib::Request& request,
                                                 httplib::Response& response) {
        handleRhythmCommand(engine, request, response, NativeRhythmCommandType::Start);
    });
    server.Post("/v2/rhythm/variation", [&engine](const httplib::Request& request,
                                                     httplib::Response& response) {
        handleRhythmCommand(engine, request, response, NativeRhythmCommandType::Variation);
    });
    server.Post("/v2/rhythm/fill", [&engine](const httplib::Request& request,
                                                httplib::Response& response) {
        handleRhythmCommand(engine, request, response, NativeRhythmCommandType::Fill);
    });
    server.Post("/v2/rhythm/ending", [&engine](const httplib::Request& request,
                                                   httplib::Response& response) {
        handleRhythmCommand(engine, request, response, NativeRhythmCommandType::Ending);
    });
    server.Post("/v2/rhythm/stop", [&engine](const httplib::Request& request,
                                                 httplib::Response& response) {
        handleRhythmCommand(engine, request, response, NativeRhythmCommandType::Stop);
    });
    server.Post("/v2/rhythm/tempo", [&engine](const httplib::Request& request,
                                                 httplib::Response& response) {
        handleRhythmCommand(engine, request, response, NativeRhythmCommandType::Tempo);
    });
    server.Post("/v2/rhythm/volume", [&engine](const httplib::Request& request,
                                                  httplib::Response& response) {
        handleRhythmCommand(engine, request, response, NativeRhythmCommandType::Volume);
    });

    server.Get("/v2/fx/catalog", [](const httplib::Request&, httplib::Response& response) {
        writeJson(response, json{{"ok", true}, {"entries", fxCatalogToJson()}});
    });

    server.Get("/v2/fx/bank", [&engine](const httplib::Request&, httplib::Response& response) {
        writeJson(response, fxBankSnapshotToJson(engine.getFxBankSnapshot()));
    });

    if (softwareFxTestHost) {
        server.Post("/v2/software/render", [&engine](const httplib::Request& request,
                                                       httplib::Response& response) {
            try {
                const auto body = json::parse(request.body);
                if (!body.is_object() || !body.contains("inputStereo")) {
                    response.status = 400;
                    writeError(response, "Software render requires inputStereo interleaved PCM.");
                    return;
                }
                std::vector<float> input;
                std::string parseError;
                if (!parseStereoPcm(body["inputStereo"],
                                    static_cast<std::size_t>(kNativeTrackHostMaximumCallbackFrames) * 2U,
                                    input, parseError)) {
                    response.status = 400;
                    writeError(response, parseError);
                    return;
                }
                std::vector<float> carrier;
                const float* carrierData = nullptr;
                if (body.contains("carrierStereo")) {
                    if (!parseStereoPcm(body["carrierStereo"], input.size(), carrier, parseError) ||
                        carrier.size() != input.size()) {
                        response.status = 400;
                        writeError(response, parseError.empty()
                            ? "carrierStereo must contain the same number of frames as inputStereo."
                            : parseError);
                        return;
                    }
                    carrierData = carrier.data();
                }

                const auto frames = static_cast<std::uint32_t>(input.size() / 2U);
                std::vector<float> output(input.size(), 0.0f);
                MultiTrackProcessStats processStats{};
                std::string error;
                if (!engine.processSoftwareFxBlock(input.data(), carrierData,
                                                  output.data(), frames,
                                                  &processStats, error)) {
                    response.status = 400;
                    writeError(response, error);
                    return;
                }
                const auto status = engine.getStatus();
                const auto snapshot = engine.getFxBankSnapshot();
                writeJson(response, json{
                    {"ok", true},
                    {"frames", frames},
                    {"nextAudioFrame", status.trackHost.nextFrame},
                    {"inputPeak", processStats.inputPeak},
                    {"outputPeak", processStats.outputPeak},
                    {"fxGraphGeneration", snapshot.producerGeneration},
                    {"fxGraphActiveGeneration", snapshot.activeGeneration},
                    {"fxGraphStageAccepted", snapshot.stageAccepted},
                    {"fxGraphAdopted", snapshot.adopted},
                    {"fxDspFaultCount", status.trackHost.fxDspFaultCount},
                    {"lastFxDspFaultFrame", status.trackHost.lastFxDspFaultFrame},
                    {"lastFxDspFaultCode", static_cast<std::uint8_t>(status.trackHost.lastFxDspFault)},
                    {"lastFxDspFault", fxFaultName(status.trackHost.lastFxDspFault)},
                    {"outputStereo", output},
                });
            } catch (const std::exception& exception) {
                response.status = 400;
                writeError(response, exception.what());
            }
        });
    }

    server.Put("/v2/fx/bank", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            NativeFxBankConfig configuration{};
            std::string parseError;
            if (!parseFxBankConfiguration(body, configuration, parseError)) {
                response.status = 400;
                writeError(response, parseError);
                return;
            }
            const auto operation = engine.configureFxBank(configuration);
            writeFxBankResult(response, engine, operation);
        } catch (const std::exception& exception) {
            response.status = 400;
            writeError(response, exception.what());
        }
    });

    server.Post("/v2/fx/parameters", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            constexpr std::uint64_t maximumExactFrame = (std::uint64_t{1} << 53U) - 1U;
            const auto body = json::parse(request.body);
            if (!body.is_object() || !body.contains("events") || !body["events"].is_array() ||
                body["events"].empty() || body["events"].size() > kNativeFxBankMaximumEventBatch) {
                response.status = 400;
                writeError(response, "Native FX parameter batch must contain 1 through 64 events.");
                return;
            }
            std::array<NativeFxBankEvent, kNativeFxBankMaximumEventBatch> events{};
            for (std::size_t index = 0U; index < body["events"].size(); ++index) {
                const auto& input = body["events"][index];
                std::uint64_t frame = 0U;
                std::uint64_t bus = 0U;
                std::uint64_t slot = 0U;
                if (!input.is_object() || !input.contains("absoluteFrame") ||
                    !jsonUnsigned(input["absoluteFrame"], maximumExactFrame, frame) ||
                    !input.contains("busIndex") || !jsonUnsigned(input["busIndex"], 7U, bus) ||
                    !input.contains("slotIndex") || !jsonUnsigned(input["slotIndex"], 3U, slot)) {
                    response.status = 400;
                    writeError(response, "Native FX event has a malformed address or absolute frame.");
                    return;
                }
                auto& event = events[index];
                event.absoluteFrame = frame;
                event.busIndex = static_cast<std::uint8_t>(bus);
                event.slotIndex = static_cast<std::uint8_t>(slot);
                if (input.contains("kind") &&
                    (!input["kind"].is_string() ||
                     (input["kind"].get<std::string>() != "midi" &&
                      input["kind"].get<std::string>() != "parameter"))) {
                    response.status = 400;
                    writeError(response, "Native FX event kind must be parameter or midi.");
                    return;
                }
                if (input.contains("kind") && input["kind"].is_string() &&
                    input["kind"].get<std::string>() == "midi") {
                    const auto type = input.value("midiType", std::string{});
                    std::uint64_t channel = 0U;
                    std::uint64_t note = 0U;
                    std::uint64_t velocity = 0U;
                    if (!input.contains("channel") ||
                        !jsonUnsigned(input["channel"], 15U, channel) ||
                        !input.contains("note") || !jsonUnsigned(input["note"], 127U, note) ||
                        !input.contains("velocity") || !jsonUnsigned(input["velocity"], 127U, velocity)) {
                        response.status = 400;
                        writeError(response, "Typed MIDI events require channel, note and velocity bytes.");
                        return;
                    }
                    // Restore the bus/slot fields after using temporaries for the
                    // MIDI byte range checks above.
                    if (type == "NoteOn") event.midiType = webrc::dsp::FxMidiEventType::NoteOn;
                    else if (type == "NoteOff") event.midiType = webrc::dsp::FxMidiEventType::NoteOff;
                    else if (type == "AllNotesOff") event.midiType = webrc::dsp::FxMidiEventType::AllNotesOff;
                    else {
                        response.status = 400;
                        writeError(response, "Typed MIDI midiType must be NoteOn, NoteOff or AllNotesOff.");
                        return;
                    }
                    event.kind = NativeFxBankEventKind::Midi;
                    event.midiChannel = static_cast<std::uint8_t>(channel);
                    event.midiNote = static_cast<std::uint8_t>(note);
                    event.midiVelocity = static_cast<std::uint8_t>(velocity);
                } else {
                    std::uint64_t parameter = 0U;
                    float value = 0.0f;
                    if (!input.contains("parameterId") ||
                        !jsonUnsigned(input["parameterId"], 135U, parameter) || parameter == 0U ||
                        !input.contains("value") || !jsonFloat(input["value"], value)) {
                        response.status = 400;
                        writeError(response, "Native FX parameter event has a malformed ID or value.");
                        return;
                    }
                    event.kind = NativeFxBankEventKind::ProcessorParameter;
                    event.parameter = static_cast<webrc::dsp::FxParameterId>(parameter);
                    event.value = value;
                    event.smoothingMs = 5.0f;
                }
            }
            const auto operation = engine.postFxBankEvents(
                events.data(), static_cast<std::uint32_t>(body["events"].size()));
            writeFxBankResult(response, engine, operation);
        } catch (const std::exception& exception) {
            response.status = 400;
            writeError(response, exception.what());
        }
    });

    server.Post("/v2/fx/slot-mix", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            constexpr std::uint64_t maximumExactFrame = (std::uint64_t{1} << 53U) - 1U;
            const auto body = json::parse(request.body);
            std::uint64_t frame = 0U;
            std::uint64_t bus = 0U;
            std::uint64_t slot = 0U;
            float mix = 0.0f;
            float smoothing = 0.0f;
            if (!body.is_object() || !body.contains("absoluteFrame") ||
                !jsonUnsigned(body["absoluteFrame"], maximumExactFrame, frame) ||
                !body.contains("busIndex") || !jsonUnsigned(body["busIndex"], 7U, bus) ||
                !body.contains("slotIndex") || !jsonUnsigned(body["slotIndex"], 3U, slot) ||
                !body.contains("mix") || !jsonFloat(body["mix"], mix) ||
                !body.contains("smoothingMs") || !jsonFloat(body["smoothingMs"], smoothing)) {
                response.status = 400;
                writeError(response, "Native FX slot-mix event is malformed.");
                return;
            }
            const NativeFxBankEvent event{frame, static_cast<std::uint8_t>(bus),
                static_cast<std::uint8_t>(slot), NativeFxBankEventKind::SlotMix,
                webrc::dsp::FxParameterId::Mix, mix, smoothing};
            const auto operation = engine.postFxBankEvents(&event, 1U);
            writeFxBankResult(response, engine, operation);
        } catch (const std::exception& exception) {
            response.status = 400;
            writeError(response, exception.what());
        }
    });

    server.Post("/v1/config/apply", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            const auto backend = backendFromString(body.value("backend", "WASAPI"));
            if (!backend) {
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
            config.trackBufferSeconds = body.value("trackBufferSeconds", 60u);
            config.trackMemoryBudgetBytes = body.value("trackMemoryBudgetBytes", std::uint64_t{0});

            std::string error;
            if (!engine.applyConfig(config, error)) {
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
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

    server.Post("/v1/transport/record", [&engine](const httplib::Request&, httplib::Response& response) {
        std::string error;
        if (!engine.record(error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/stop", [&engine](const httplib::Request&, httplib::Response& response) {
        std::string error;
        if (!engine.stopRecordOrPlayback(error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/play", [&engine](const httplib::Request&, httplib::Response& response) {
        std::string error;
        if (!engine.play(error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/overdub-toggle", [&engine](const httplib::Request&, httplib::Response& response) {
        std::string error;
        if (!engine.toggleOverdub(error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
    });

    server.Post("/v1/transport/clear", [&engine](const httplib::Request&, httplib::Response& response) {
        std::string error;
        if (!engine.clear(error)) {
            writeError(response, error);
            return;
        }
        writeJson(response, statusToJson(engine.getStatus()));
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

    server.Post(R"(/v2/tracks/([1-5])/(record|stop|play|overdub|clear|input-route|gain|pan|mute|solo))",
        [&engine](const httplib::Request& request, httplib::Response& response) {
            try {
                const auto trackNumber = static_cast<unsigned int>(std::stoul(request.matches[1].str()));
                const auto trackIndex = static_cast<std::uint8_t>(trackNumber - 1U);
                const auto action = request.matches[2].str();
                std::string error;
                bool ok = false;
                json body = json::object();
                if (!request.body.empty()) body = json::parse(request.body);
                if (action == "record") ok = engine.recordTrack(trackIndex, error);
                else if (action == "stop") ok = engine.stopTrack(trackIndex, error);
                else if (action == "play") ok = engine.playTrack(trackIndex, error);
                else if (action == "overdub") ok = engine.toggleOverdubTrack(trackIndex, error);
                else if (action == "clear") ok = engine.clearTrack(trackIndex, error);
                else if (action == "input-route") ok = engine.setTrackInputRoute(trackIndex, body.value("enabled", true), error);
                else if (action == "gain") ok = engine.setTrackGain(trackIndex, body.value("value", 1.0f), error);
                else if (action == "pan") ok = engine.setTrackPan(trackIndex, body.value("value", 0.0f), error);
                else if (action == "mute") ok = engine.setTrackMute(trackIndex, body.value("enabled", false), error);
                else if (action == "solo") ok = engine.setTrackSolo(trackIndex, body.value("enabled", false), error);
                if (!ok) {
                    writeError(response, error.empty() ? "Unsupported native track command." : error);
                    return;
                }
                writeJson(response, statusToJson(engine.getStatus()));
            } catch (const std::exception& error) {
                writeError(response, error.what());
            }
        });

    server.Post("/v2/tempo", [&engine](const httplib::Request& request, httplib::Response& response) {
        try {
            const auto body = json::parse(request.body);
            std::string error;
            if (!engine.setTempoBpm(body.value("bpm", 120.0), error)) {
                writeError(response, error);
                return;
            }
            writeJson(response, statusToJson(engine.getStatus()));
        } catch (const std::exception& error) {
            writeError(response, error.what());
        }
    });

    std::cout << "native_bridge_host listening on http://127.0.0.1:17755" << std::endl;
    if (!server.listen("127.0.0.1", 17755)) {
        std::cerr << "Failed to bind native_bridge_host on 127.0.0.1:17755" << std::endl;
        return 1;
    }

    return 0;
}
