#pragma once

#include "multitrack_looper_core.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>

namespace webrc::native {

constexpr std::uint32_t kNativeTrackHostQuantumFrames = 64;
constexpr std::uint32_t kNativeTrackHostMaximumCallbackFrames = 4096;

struct NativeTrackHostStatus {
    std::array<TrackStatus, kNativeTrackCount> tracks{};
    std::uint64_t nextFrame = 0;
    std::uint64_t preparedHistoryBytes = 0;
    double tempoBpm = 120.0;
    MultiTrackProcessStats lastProcess{};
};

// Software-only host adapter between variable device callbacks and the
// fixed-quantum five-track core. It duplicates mono capture into stereo and
// splits larger callbacks into <=64-frame allocations-free core calls.
class NativeTrackHost {
public:
    NativeTrackHost() = default;
    NativeTrackHost(const NativeTrackHost&) = delete;
    NativeTrackHost& operator=(const NativeTrackHost&) = delete;

    bool prepare(std::uint32_t sampleRate,
                 std::uint32_t maxLoopSeconds = 60,
                 std::uint64_t memoryBudgetBytes = 0);

    bool processInputBlock(const float* inputInterleaved,
                           std::uint32_t inputChannels,
                           float* outputInterleavedStereo,
                           std::uint32_t frames,
                           MultiTrackProcessStats* stats = nullptr) noexcept;

    bool postTrackCommand(const TrackCommand& command) noexcept;
    bool record(std::uint8_t trackIndex) noexcept;
    bool stop(std::uint8_t trackIndex) noexcept;
    bool play(std::uint8_t trackIndex) noexcept;
    bool toggleOverdub(std::uint8_t trackIndex) noexcept;
    bool clear(std::uint8_t trackIndex) noexcept;
    bool setInputRoute(std::uint8_t trackIndex, bool enabled) noexcept;
    bool setGain(std::uint8_t trackIndex, float gain) noexcept;
    bool setPan(std::uint8_t trackIndex, float pan) noexcept;
    bool setMute(std::uint8_t trackIndex, bool muted) noexcept;
    bool setSolo(std::uint8_t trackIndex, bool solo) noexcept;
    bool setTempo(double bpm) noexcept;
    bool setMonitor(bool enabled) noexcept;

    [[nodiscard]] NativeTrackHostStatus status() const noexcept;
    [[nodiscard]] bool prepared() const noexcept { return static_cast<bool>(core_); }

private:
    struct PublishedTrackStatus {
        std::atomic<std::uint64_t> sequence{0};
        std::atomic<std::uint8_t> state{static_cast<std::uint8_t>(TrackPlaybackState::Empty)};
        std::atomic<std::uint64_t> recordedFrames{0};
        std::atomic<std::uint64_t> loopFrames{0};
        std::atomic<std::uint64_t> playhead{0};
        std::atomic<float> gain{1.0f};
        std::atomic<float> pan{0.0f};
        std::atomic<bool> muted{false};
        std::atomic<bool> solo{false};
        std::atomic<bool> inputRouted{true};
        std::atomic<bool> bufferPrepared{false};
    };

    bool queue(TrackCommandType type, std::uint8_t trackIndex,
               float value = 0.0f, bool boolValue = false) noexcept;
    void publishTrackStatuses() noexcept;

    std::unique_ptr<MultiTrackLooperCore> core_;
    mutable std::mutex commandProducerMutex_;
    std::array<PublishedTrackStatus, kNativeTrackCount> publishedTracks_{};
    std::array<float, kNativeTrackHostQuantumFrames * 2U> inputScratch_{};
    std::array<float, kNativeTrackHostQuantumFrames * 2U> outputScratch_{};
    std::atomic<std::uint64_t> nextFrame_{0};
    std::uint64_t lastQueuedFrame_ = 0;
    bool hasQueuedFrame_ = false;
    std::atomic<std::uint64_t> preparedHistoryBytes_{0};
    std::atomic<double> tempoBpm_{120.0};
    std::atomic<std::uint64_t> lastProcessFrames_{0};
    std::atomic<std::uint64_t> lastProcessLateCommands_{0};
    std::atomic<std::uint64_t> lastProcessDroppedCommands_{0};
    std::atomic<float> lastProcessInputPeak_{0.0f};
    std::atomic<float> lastProcessOutputPeak_{0.0f};
    std::atomic<std::uint32_t> lastProcessActiveTracks_{0};
    std::atomic<std::uint32_t> lastProcessRecordingTracks_{0};
};

} // namespace webrc::native
