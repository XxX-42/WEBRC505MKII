#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>

#include "native_audio_core.hpp"

#include <iostream>

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
        {"nextAudioFrame", status.trackHost.nextFrame},
        {"tempoBpm", status.trackHost.tempoBpm},
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

} // namespace

int main() {
    NativeAudioCore engine;
    httplib::Server server;

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
