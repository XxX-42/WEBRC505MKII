#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

enum class LooperState : std::uint8_t {
    Empty = 0,
    Recording,
    Stopped,
    Playing,
    Overdubbing,
};

enum class CommandType : std::uint8_t {
    Record = 0,
    StopRecordOrPlayback,
    Play,
    ToggleOverdub,
    Clear,
    SetMonitoring,
};

struct Command {
    CommandType type;
    bool boolValue = false;
};

struct ProcessStats {
    LooperState state = LooperState::Empty;
    float loopProgress = 0.0f;
    float inputPeak = 0.0f;
    float outputPeak = 0.0f;
};

class LooperCore {
public:
    explicit LooperCore(unsigned int sampleRate = 48000, std::size_t maxLoopSeconds = 300);

    void prepare(unsigned int sampleRate, std::size_t maxLoopSeconds = 300);
    void applyCommand(const Command& command);
    ProcessStats process(
        const float* inputInterleaved,
        float* outputInterleaved,
        unsigned int frames,
        unsigned int inputChannels,
        unsigned int outputChannels
    );

    [[nodiscard]] LooperState state() const noexcept;
    [[nodiscard]] bool monitoringEnabled() const noexcept;
    [[nodiscard]] unsigned int sampleRate() const noexcept;

private:
    void clearLoop();
    static float clampSample(float value) noexcept;

    unsigned int sampleRate_;
    std::size_t maxLoopSeconds_;
    std::size_t capacityFrames_;
    std::vector<float> loopBuffer_;
    LooperState state_;
    bool monitoringEnabled_;
    std::size_t recordedFrames_;
    std::size_t finalizedFrames_;
    std::size_t playhead_;
};

} // namespace webrc::native
