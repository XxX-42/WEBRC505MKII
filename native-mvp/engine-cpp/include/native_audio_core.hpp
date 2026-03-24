#pragma once

#include "looper_core.hpp"

#include <array>
#include <atomic>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "RtAudio.h"

namespace webrc::native {

enum class Backend : std::uint8_t {
    Wasapi = 0,
    Asio,
};

struct DeviceDescriptor {
    std::string id;
    std::string name;
    std::vector<unsigned int> sampleRates;
    bool isDefault = false;
};

struct DeviceCatalog {
    std::vector<std::string> backends;
    std::map<std::string, std::vector<DeviceDescriptor>> inputsByBackend;
    std::map<std::string, std::vector<DeviceDescriptor>> outputsByBackend;
    std::map<std::string, std::string> defaultInputIdByBackend;
    std::map<std::string, std::string> defaultOutputIdByBackend;
    std::vector<unsigned int> bufferOptions;
};

struct EngineConfig {
    Backend backend = Backend::Wasapi;
    std::string inputDeviceId;
    std::string outputDeviceId;
    unsigned int sampleRate = 48000;
    unsigned int bufferFrames = 128;
    bool monitoringEnabled = false;
};

struct EngineStatus {
    bool bridgeHealthy = true;
    bool engineRunning = false;
    Backend backend = Backend::Wasapi;
    std::string inputDeviceId;
    std::string outputDeviceId;
    std::string inputDeviceName;
    std::string outputDeviceName;
    unsigned int sampleRate = 0;
    unsigned int bufferFrames = 0;
    bool monitoringEnabled = false;
    LooperState state = LooperState::Empty;
    double inputLatencyMs = 0.0;
    double outputLatencyMs = 0.0;
    double roundTripEstimateMs = 0.0;
    float inputPeak = 0.0f;
    float outputPeak = 0.0f;
    unsigned int xrunsOrDropouts = 0;
    std::string lastError;
    float loopProgress = 0.0f;
    double streamTimeSeconds = 0.0;
    unsigned long long callbackTicks = 0;
};

template <typename T, std::size_t Capacity>
class SpscRingQueue {
public:
    bool push(const T& value) noexcept {
        const auto write = writeIndex_.load(std::memory_order_relaxed);
        const auto next = increment(write);
        if (next == readIndex_.load(std::memory_order_acquire)) {
            return false;
        }
        buffer_[write] = value;
        writeIndex_.store(next, std::memory_order_release);
        return true;
    }

    bool pop(T& value) noexcept {
        const auto read = readIndex_.load(std::memory_order_relaxed);
        if (read == writeIndex_.load(std::memory_order_acquire)) {
            return false;
        }
        value = buffer_[read];
        readIndex_.store(increment(read), std::memory_order_release);
        return true;
    }

    [[nodiscard]] std::size_t size() const noexcept {
        const auto write = writeIndex_.load(std::memory_order_acquire);
        const auto read = readIndex_.load(std::memory_order_acquire);
        return write >= read ? write - read : Capacity - (read - write);
    }

    void clear() noexcept {
        readIndex_.store(0, std::memory_order_release);
        writeIndex_.store(0, std::memory_order_release);
    }

private:
    static constexpr std::size_t increment(std::size_t index) noexcept {
        return (index + 1) % Capacity;
    }

    std::array<T, Capacity> buffer_{};
    std::atomic<std::size_t> readIndex_{0};
    std::atomic<std::size_t> writeIndex_{0};
};

class NativeAudioCore {
public:
    NativeAudioCore();
    ~NativeAudioCore();

    DeviceCatalog getDeviceCatalog() const;
    std::optional<EngineConfig> getCurrentConfig() const;
    EngineStatus getStatus() const;

    bool applyConfig(const EngineConfig& config, std::string& error);
    bool start(std::string& error);
    bool stop(std::string& error);

    bool record(std::string& error);
    bool stopRecordOrPlayback(std::string& error);
    bool play(std::string& error);
    bool toggleOverdub(std::string& error);
    bool clear(std::string& error);
    bool setMonitoring(bool enabled, std::string& error);

private:
    static constexpr unsigned int kMaxCallbackFrames = 4096;

    struct AudioBlock {
        unsigned int frames = 0;
        std::array<float, kMaxCallbackFrames * 2> samples{};
    };

    DeviceCatalog buildCatalog() const;
    std::vector<RtAudio::Api> compiledApis() const;
    bool ensureAudioInstanceLocked(std::unique_ptr<RtAudio>& instance, Backend backend, std::string& error);
    bool validateConfigLocked(EngineConfig& config, std::string& error) const;
    bool openStreamLocked(std::string& error);
    void closeStreamLocked() noexcept;
    void resetRuntimeStateLocked() noexcept;
    void updateLastErrorLocked(const std::string& error) const;
    const DeviceDescriptor* findDeviceLocked(const std::vector<DeviceDescriptor>& devices, const std::string& id) const;

    static int audioCallback(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int nBufferFrames,
        double streamTime,
        RtAudioStreamStatus status,
        void* userData
    );

    static int inputAudioCallback(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int nBufferFrames,
        double streamTime,
        RtAudioStreamStatus status,
        void* userData
    );

    static int outputAudioCallback(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int nBufferFrames,
        double streamTime,
        RtAudioStreamStatus status,
        void* userData
    );

    int handleAudioCallback(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int nBufferFrames,
        RtAudioStreamStatus status
    );

    int handleInputAudioCallback(
        void* inputBuffer,
        unsigned int nBufferFrames,
        RtAudioStreamStatus status
    );

    int handleOutputAudioCallback(
        void* outputBuffer,
        unsigned int nBufferFrames,
        RtAudioStreamStatus status
    );

    mutable std::mutex controlMutex_;
    mutable std::string lastError_;
    std::unique_ptr<RtAudio> audio_;
    std::unique_ptr<RtAudio> captureAudio_;
    std::optional<EngineConfig> currentConfig_;
    DeviceCatalog deviceCatalog_;
    LooperCore looper_;
    unsigned int inputChannels_ = 1;
    unsigned int outputChannels_ = 2;

    SpscRingQueue<Command, 64> commandQueue_;
    SpscRingQueue<AudioBlock, 8> outputQueue_;
    std::atomic<bool> engineRunning_{false};
    std::atomic<int> looperState_{static_cast<int>(LooperState::Empty)};
    std::atomic<float> loopProgress_{0.0f};
    std::atomic<float> inputPeak_{0.0f};
    std::atomic<float> outputPeak_{0.0f};
    std::atomic<unsigned int> xrunsOrDropouts_{0};
    std::atomic<unsigned long long> callbackTicks_{0};
    std::atomic<bool> renderPrimed_{false};
};

std::string backendToString(Backend backend);
std::string looperStateToString(LooperState state);
std::optional<Backend> backendFromString(const std::string& raw);

} // namespace webrc::native
