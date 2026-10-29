#pragma once

// Minimal compile-time test double for the RtAudio surface used by
// NativeAudioCore. Portable tests invoke the real static callback directly;
// this shim does not open a device or pretend to emulate the audio backend.

#include <string>
#include <atomic>
#include <cstddef>
#include <array>
#include <thread>
#include <vector>

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

    [[nodiscard]] std::vector<unsigned int> getDeviceIds() const { return {}; }
    [[nodiscard]] unsigned int getDefaultInputDevice() const noexcept { return 0U; }
    [[nodiscard]] unsigned int getDefaultOutputDevice() const noexcept { return 0U; }
    [[nodiscard]] DeviceInfo getDeviceInfo(unsigned int) const { return {}; }
    [[nodiscard]] Api getCurrentApi() const noexcept { return api_; }
    [[nodiscard]] int openStream(
        StreamParameters*,
        StreamParameters*,
        unsigned int,
        unsigned int,
        unsigned int*,
        Callback,
        void*,
        StreamOptions*
    ) noexcept { return RTAUDIO_NO_ERROR; }
    [[nodiscard]] std::string getErrorText() const { return {}; }
    [[nodiscard]] int startStream() noexcept { return RTAUDIO_NO_ERROR; }
    int stopStream() noexcept {
        streamRunning_.store(false, std::memory_order_release);
        if (callbackThread_.joinable()) callbackThread_.join();
        return RTAUDIO_NO_ERROR;
    }
    void closeStream() noexcept { (void)stopStream(); streamOpen_.store(false, std::memory_order_release); }
    [[nodiscard]] bool isStreamOpen() const noexcept { return streamOpen_.load(std::memory_order_acquire); }
    [[nodiscard]] bool isStreamRunning() const noexcept { return streamRunning_.load(std::memory_order_acquire); }
    [[nodiscard]] double getStreamTime() const noexcept { return 0.0; }

    // Deterministic lifecycle seam for NativeAudioCore stop/join race tests.
    void configureGatedTestCallback(Callback callback, void* userData, unsigned int frames) {
        callback_ = callback;
        userData_ = userData;
        frames_ = frames;
        output_.assign(static_cast<std::size_t>(frames) * 2U, 0.0f);
        streamOpen_.store(true, std::memory_order_release);
        streamRunning_.store(true, std::memory_order_release);
    }
    void launchGatedTestCallback() {
        callbackThread_ = std::thread([this] {
            callbackResult_.store(callback_ != nullptr
                ? callback_(output_.data(), nullptr, frames_, 0.0, 0U, userData_) : -1,
                std::memory_order_release);
            callbackDone_.store(true, std::memory_order_release);
        });
    }
    [[nodiscard]] bool gatedTestCallbackDone() const noexcept {
        return callbackDone_.load(std::memory_order_acquire);
    }
    [[nodiscard]] int gatedTestCallbackResult() const noexcept {
        return callbackResult_.load(std::memory_order_acquire);
    }

private:
    Api api_;
    std::atomic<bool> streamOpen_{false};
    std::atomic<bool> streamRunning_{false};
    Callback callback_ = nullptr;
    void* userData_ = nullptr;
    unsigned int frames_ = 0U;
    std::vector<float> output_;
    std::thread callbackThread_;
    std::atomic<bool> callbackDone_{false};
    std::atomic<int> callbackResult_{-1};
};
