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

json statusToJson(const EngineStatus& status) {
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
        {"monitoringEnabled", status.monitoringEnabled},
        {"state", looperStateToString(status.state)},
        {"inputLatencyMs", status.inputLatencyMs},
        {"outputLatencyMs", status.outputLatencyMs},
        {"roundTripEstimateMs", status.roundTripEstimateMs},
        {"inputPeak", status.inputPeak},
        {"outputPeak", status.outputPeak},
        {"xrunsOrDropouts", status.xrunsOrDropouts},
        {"lastError", status.lastError},
        {"loopProgress", status.loopProgress},
        {"streamTimeSeconds", status.streamTimeSeconds},
        {"callbackTicks", status.callbackTicks},
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

    std::cout << "native_bridge_host listening on http://127.0.0.1:17755" << std::endl;
    if (!server.listen("127.0.0.1", 17755)) {
        std::cerr << "Failed to bind native_bridge_host on 127.0.0.1:17755" << std::endl;
        return 1;
    }

    return 0;
}
