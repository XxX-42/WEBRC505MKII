#pragma once

#include "looper_core.hpp"
#include "native_fx_control.hpp"
#include "native_track_host.hpp"

#include <algorithm>
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
    unsigned int trackBufferSeconds = 60;
    std::uint64_t trackMemoryBudgetBytes = 0;
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
    unsigned int trackBufferSeconds = 0;
    std::uint64_t trackMemoryBudgetBytes = 0;
    bool monitoringEnabled = false;
    LooperState state = LooperState::Empty;
    std::optional<double> inputLatencyMs;
    std::optional<double> outputLatencyMs;
    std::optional<double> roundTripEstimateMs;
    std::optional<double> physicalRoundTripMs;
    std::optional<double> driverReportedStreamLatencyMs;
    std::string inputLatencySource;
    std::string outputLatencySource;
    std::string driverReportedStreamLatencySource;
    std::string roundTripLatencyNote = "Physical round-trip latency has not been measured.";
    float inputPeak = 0.0f;
    float outputPeak = 0.0f;
    unsigned int xrunsOrDropouts = 0;
    unsigned int callbackStatusFaults = 0;
    unsigned int inputQueueOverruns = 0;
    unsigned int outputQueueUnderruns = 0;
    unsigned int callbackFrameLimitViolations = 0;
    std::size_t droppedCommands = 0;
    std::size_t outputQueueDepthBlocks = 0;
    std::size_t outputQueueCapacityBlocks = 0;
    unsigned long long inputCallbackTicks = 0;
    unsigned long long outputCallbackTicks = 0;
    long long callbackCountSkew = 0;
    std::string lastError;
    float loopProgress = 0.0f;
    double streamTimeSeconds = 0.0;
    unsigned long long callbackTicks = 0;
    NativeTrackHostStatus trackHost{};
};

struct NativeFxBankSnapshot {
    bool configured = false;
    bool stageAccepted = false;
    bool adopted = false;
    std::uint64_t producerGeneration = 0U;
    std::uint64_t activeGeneration = 0U;
    std::optional<NativeFxBankConfig> configuration;
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

    [[nodiscard]] static constexpr std::size_t usableCapacity() noexcept {
        return Capacity - 1;
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

// Serializes only control-thread producers. The callback remains a lock-free
// single consumer; clear() is for use only after the stream has stopped.
template <typename T, std::size_t Capacity>
class SerializedProducerRingQueue {
public:
    bool push(const T& value) noexcept {
        std::lock_guard<std::mutex> lock(producerMutex_);
        if (queue_.push(value)) {
            return true;
        }
        dropped_.fetch_add(1, std::memory_order_relaxed);
        return false;
    }

    bool pop(T& value) noexcept {
        return queue_.pop(value);
    }

    [[nodiscard]] std::size_t size() const noexcept {
        return queue_.size();
    }

    [[nodiscard]] static constexpr std::size_t usableCapacity() noexcept {
        return SpscRingQueue<T, Capacity>::usableCapacity();
    }

    [[nodiscard]] std::size_t dropped() const noexcept {
        return dropped_.load(std::memory_order_relaxed);
    }

    // Only call after the consumer callback has stopped.
    void clear() noexcept {
        std::lock_guard<std::mutex> lock(producerMutex_);
        queue_.clear();
    }

    void resetDropped() noexcept {
        dropped_.store(0, std::memory_order_relaxed);
    }

private:
    SpscRingQueue<T, Capacity> queue_;
    mutable std::mutex producerMutex_;
    std::atomic<std::size_t> dropped_{0};
};

class NativeAudioCore {
public:
    NativeAudioCore();
    ~NativeAudioCore();

    DeviceCatalog getDeviceCatalog() const;
    std::optional<EngineConfig> getCurrentConfig() const;
    EngineStatus getStatus() const;
    NativeFxBankSnapshot getFxBankSnapshot() const;
    NativeFxBankResult configureFxBank(const NativeFxBankConfig& configuration);
    NativeFxBankResult postFxBankEvents(const NativeFxBankEvent* events,
                                        std::uint32_t eventCount);

    bool applyConfig(const EngineConfig& config, std::string& error);
    bool start(std::string& error);
    bool stop(std::string& error);

    bool record(std::string& error);
    bool stopRecordOrPlayback(std::string& error);
    bool play(std::string& error);
    bool toggleOverdub(std::string& error);
    bool clear(std::string& error);
    bool setMonitoring(bool enabled, std::string& error);
    bool recordTrack(std::uint8_t trackIndex, std::string& error);
    bool stopTrack(std::uint8_t trackIndex, std::string& error);
    bool playTrack(std::uint8_t trackIndex, std::string& error);
    bool toggleOverdubTrack(std::uint8_t trackIndex, std::string& error);
    bool clearTrack(std::uint8_t trackIndex, std::string& error);
    bool setTrackInputRoute(std::uint8_t trackIndex, bool enabled, std::string& error);
    bool setTrackGain(std::uint8_t trackIndex, float gain, std::string& error);
    bool setTrackPan(std::uint8_t trackIndex, float pan, std::string& error);
    bool setTrackMute(std::uint8_t trackIndex, bool muted, std::string& error);
    bool setTrackSolo(std::uint8_t trackIndex, bool solo, std::string& error);
    bool setTempoBpm(double bpm, std::string& error);

private:
    static constexpr unsigned int kMaxCallbackFrames = 4096;

    struct AudioBlock {
        unsigned int frames = 0;
        std::array<float, kMaxCallbackFrames * 2> samples;

        AudioBlock& operator=(const AudioBlock& other) noexcept {
            if (this != &other) {
                frames = other.frames;
                const auto validSamples = static_cast<std::size_t>(other.frames) * 2;
                std::copy_n(other.samples.data(), validSamples, samples.data());
            }
            return *this;
        }
    };

    DeviceCatalog buildCatalog() const;
    std::vector<RtAudio::Api> compiledApis() const;
    bool ensureAudioInstanceLocked(std::unique_ptr<RtAudio>& instance, Backend backend, std::string& error);
    bool validateConfigLocked(EngineConfig& config, std::string& error) const;
    bool openStreamLocked(std::string& error);
    bool enqueueCommand(const Command& command, std::string& error);
    bool enqueueTrackCommand(std::uint8_t trackIndex, TrackCommandType type,
                             float value, bool boolValue, std::string& error);
    void publishCoreTelemetry(const MultiTrackProcessStats& stats) noexcept;
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
    std::mutex commandProducerMutex_;
    mutable std::string lastError_;
    std::unique_ptr<RtAudio> audio_;
    std::unique_ptr<RtAudio> captureAudio_;
    std::optional<EngineConfig> currentConfig_;
    DeviceCatalog deviceCatalog_;
    LooperCore looper_;
    // Reclaimed only by control-side telemetry/configuration calls after the
    // audio callback has published retirement; logically mutable maintenance.
    mutable NativeTrackHost trackHost_;
    NativeFxBank fxBank_;
    unsigned int inputChannels_ = 1;
    unsigned int outputChannels_ = 2;

    SpscRingQueue<AudioBlock, 8> outputQueue_;
    std::atomic<bool> engineRunning_{false};
    std::atomic<int> looperState_{static_cast<int>(LooperState::Empty)};
    std::atomic<float> loopProgress_{0.0f};
    std::atomic<float> inputPeak_{0.0f};
    std::atomic<float> outputPeak_{0.0f};
    std::atomic<unsigned int> xrunsOrDropouts_{0};
    std::atomic<unsigned int> callbackStatusFaults_{0};
    std::atomic<unsigned int> inputQueueOverruns_{0};
    std::atomic<unsigned int> outputQueueUnderruns_{0};
    std::atomic<unsigned int> callbackFrameLimitViolations_{0};
    std::atomic<unsigned long long> callbackTicks_{0};
    std::atomic<unsigned long long> inputCallbackTicks_{0};
    std::atomic<unsigned long long> outputCallbackTicks_{0};
    std::atomic<bool> renderPrimed_{false};
};

std::string backendToString(Backend backend);
std::string looperStateToString(LooperState state);
std::optional<Backend> backendFromString(const std::string& raw);

} // namespace webrc::native
