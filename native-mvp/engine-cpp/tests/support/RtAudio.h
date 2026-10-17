#pragma once

// Minimal compile-time test double for the RtAudio surface used by
// NativeAudioCore. Portable tests invoke the real static callback directly;
// this shim does not open a device or pretend to emulate the audio backend.

#include <string>
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
    int stopStream() noexcept { return RTAUDIO_NO_ERROR; }
    void closeStream() noexcept {}
    [[nodiscard]] bool isStreamOpen() const noexcept { return false; }
    [[nodiscard]] bool isStreamRunning() const noexcept { return false; }
    [[nodiscard]] double getStreamTime() const noexcept { return 0.0; }

private:
    Api api_;
};
