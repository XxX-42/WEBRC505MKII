#pragma once

// Test-only bridge adapter. It presents a single explicitly labelled fake
// endpoint so HTTP validation, control routes and snapshot serialization can
// be exercised in a headless build. Its deterministic callback pump is fake
// input only: this is never a device, XRUN, timing or audio-quality test.

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <thread>
#include <vector>

namespace webrc::native::test_support {
inline std::atomic<bool> simulationCallbackGateRequested{false};
inline std::atomic<bool> simulationCallbackGateParked{false};

inline void setSimulationCallbackGate(bool paused) noexcept {
    simulationCallbackGateRequested.store(paused, std::memory_order_release);
}

[[nodiscard]] inline bool isSimulationCallbackGateParked() noexcept {
    return simulationCallbackGateParked.load(std::memory_order_acquire);
}
} // namespace webrc::native::test_support

using RtAudioStreamStatus = unsigned int;

constexpr unsigned int RTAUDIO_FLOAT32 = 0U;
constexpr unsigned int RTAUDIO_SCHEDULE_REALTIME = 1U;
constexpr unsigned int RTAUDIO_MINIMIZE_LATENCY = 2U;
constexpr int RTAUDIO_NO_ERROR = 0;

class RtAudio {
public:
    enum Api {
        WINDOWS_WASAPI,
        WINDOWS_ASIO,
    };

    struct StreamParameters {
        unsigned int deviceId = 0;
        unsigned int nChannels = 0;
        unsigned int firstChannel = 0;
    };

    struct StreamOptions {
        unsigned int flags = 0;
    };

    struct DeviceInfo {
        std::string name;
        std::vector<unsigned int> sampleRates;
        unsigned int inputChannels = 0;
        unsigned int outputChannels = 0;
    };

    using Callback = int (*)(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int frames,
        double streamTime,
        RtAudioStreamStatus status,
        void* userData
    );

    explicit RtAudio(Api api) noexcept : api_(api) {}
    ~RtAudio() { closeStream(); }
    [[nodiscard]] std::vector<unsigned int> getDeviceIds() const { return {1U}; }
    [[nodiscard]] unsigned int getDefaultInputDevice() const noexcept { return 1U; }
    [[nodiscard]] unsigned int getDefaultOutputDevice() const noexcept { return 1U; }
    [[nodiscard]] DeviceInfo getDeviceInfo(unsigned int) const {
        return {"SIMULATION ONLY - NO PHYSICAL AUDIO DEVICE", {44100U, 48000U, 96000U}, 2U, 2U};
    }
    [[nodiscard]] Api getCurrentApi() const noexcept { return api_; }
    [[nodiscard]] int openStream(
        StreamParameters* outputParameters,
        StreamParameters* inputParameters,
        unsigned int,
        unsigned int sampleRate,
        unsigned int* bufferFrames,
        Callback callback,
        void* userData,
        StreamOptions*
    ) noexcept {
        streamOpen_ = true;
        callback_ = callback;
        userData_ = userData;
        frames_ = bufferFrames != nullptr ? *bufferFrames : 64U;
        sampleRate_ = sampleRate;
        outputChannels_ = outputParameters != nullptr ? outputParameters->nChannels : 0U;
        inputChannels_ = inputParameters != nullptr ? inputParameters->nChannels : 0U;
        streamTime_.store(0.0, std::memory_order_relaxed);
        frameCursor_ = 0U;
        return RTAUDIO_NO_ERROR;
    }
    [[nodiscard]] std::string getErrorText() const { return "simulation shim: no physical audio stream"; }
    [[nodiscard]] int startStream() noexcept {
        if (!streamOpen_) return 1;
        if (streamRunning_.exchange(true, std::memory_order_acq_rel)) return RTAUDIO_NO_ERROR;
        try {
            outputScratch_.assign(static_cast<std::size_t>(frames_) * outputChannels_, 0.0f);
            inputScratch_.assign(static_cast<std::size_t>(frames_) * inputChannels_, 0.0f);
            callbackThread_ = std::thread([this] {
                while (streamRunning_.load(std::memory_order_acquire)) {
                    if (webrc::native::test_support::simulationCallbackGateRequested.load(std::memory_order_acquire)) {
                        webrc::native::test_support::simulationCallbackGateParked.store(true, std::memory_order_release);
                        while (streamRunning_.load(std::memory_order_acquire) &&
                            webrc::native::test_support::simulationCallbackGateRequested.load(std::memory_order_acquire)) {
                            std::this_thread::sleep_for(std::chrono::milliseconds(1));
                        }
                        webrc::native::test_support::simulationCallbackGateParked.store(false, std::memory_order_release);
                        continue;
                    }
                    for (unsigned int frame = 0U; frame < frames_; ++frame) {
                        const float sample = sampleRate_ > 0U
                            ? static_cast<float>(0.1 * std::sin(
                                6.28318530717958647692 * 440.0 *
                                static_cast<double>(frameCursor_ + frame) / static_cast<double>(sampleRate_)))
                            : 0.0f;
                        for (unsigned int channel = 0U; channel < inputChannels_; ++channel) {
                            inputScratch_[static_cast<std::size_t>(frame) * inputChannels_ + channel] = sample;
                        }
                    }
                    const double streamTime = streamTime_.load(std::memory_order_relaxed);
                    const int result = callback_ != nullptr
                        ? callback_(outputChannels_ > 0U ? outputScratch_.data() : nullptr,
                                    inputChannels_ > 0U ? inputScratch_.data() : nullptr,
                                    frames_, streamTime, 0U, userData_)
                        : 0;
                    frameCursor_ += frames_;
                    if (sampleRate_ > 0U) {
                        streamTime_.store(static_cast<double>(frameCursor_) / static_cast<double>(sampleRate_),
                                          std::memory_order_relaxed);
                    }
                    if (result != 0) {
                        streamRunning_.store(false, std::memory_order_release);
                        break;
                    }
                    // Intentionally synthetic cadence for route tests only;
                    // never use this shim to measure callback deadlines.
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                }
            });
        } catch (...) {
            streamRunning_.store(false, std::memory_order_release);
            if (callbackThread_.joinable()) callbackThread_.join();
            return 1;
        }
        return RTAUDIO_NO_ERROR;
    }
    int stopStream() noexcept {
        streamRunning_.store(false, std::memory_order_release);
        if (callbackThread_.joinable()) callbackThread_.join();
        return RTAUDIO_NO_ERROR;
    }
    void closeStream() noexcept {
        stopStream();
        streamOpen_ = false;
    }
    [[nodiscard]] bool isStreamOpen() const noexcept { return streamOpen_; }
    [[nodiscard]] bool isStreamRunning() const noexcept { return streamRunning_.load(std::memory_order_acquire); }
    [[nodiscard]] double getStreamTime() const noexcept { return streamTime_.load(std::memory_order_relaxed); }

private:
    Api api_;
    bool streamOpen_ = false;
    std::atomic<bool> streamRunning_{false};
    unsigned int outputChannels_ = 0U;
    unsigned int inputChannels_ = 0U;
    unsigned int frames_ = 0;
    unsigned int sampleRate_ = 0U;
    std::uint64_t frameCursor_ = 0U;
    std::atomic<double> streamTime_{0.0};
    Callback callback_ = nullptr;
    void* userData_ = nullptr;
    std::thread callbackThread_;
    std::vector<float> outputScratch_;
    std::vector<float> inputScratch_;
};
