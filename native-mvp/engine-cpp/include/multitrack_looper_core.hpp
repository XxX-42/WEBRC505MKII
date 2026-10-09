#pragma once

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>
#include <vector>

namespace webrc::native {

constexpr std::size_t kNativeTrackCount = 5;
constexpr std::size_t kTrackCommandCapacity = 256;

enum class TrackPlaybackState : std::uint8_t {
    Empty = 0,
    Recording,
    Stopped,
    Playing,
    Overdubbing,
};

enum class TrackCommandType : std::uint8_t {
    Record = 0,
    Stop,
    Play,
    ToggleOverdub,
    ClearTrack,
    ClearAll,
    SetInputMonitor,
    SetTrackInputRoute,
    SetTrackGain,
    SetTrackPan,
    SetTrackMute,
    SetTrackSolo,
    SetTempoBpm,
};

struct TrackCommand {
    std::uint64_t absoluteFrame = 0;
    TrackCommandType type = TrackCommandType::Play;
    std::uint8_t trackIndex = 0;
    bool boolValue = false;
    float value = 0.0f;
};

struct TrackStatus {
    TrackPlaybackState state = TrackPlaybackState::Empty;
    std::uint64_t recordedFrames = 0;
    std::uint64_t loopFrames = 0;
    std::uint64_t playhead = 0;
    float gain = 1.0f;
    float pan = 0.0f;
    bool muted = false;
    bool solo = false;
    bool inputRouted = true;
    bool bufferPrepared = false;
};

struct MultiTrackProcessStats {
    std::uint32_t frames = 0;
    std::uint32_t activeTracks = 0;
    std::uint32_t recordingTracks = 0;
    std::uint64_t lateCommands = 0;
    std::uint64_t droppedCommands = 0;
    float inputPeak = 0.0f;
    float outputPeak = 0.0f;
};

// A software-only five-track stereo loop engine. History allocation and any
// graph reconfiguration happen on a stopped/control thread. processBlock is
// allocation-free, lock-free, and expects one 64-frame owner quantum (or fewer).
// Commands are timestamped in the same absolute-frame timeline and are applied
// sample-accurately by the processing owner. Status accessors are owner-thread
// only; a host should publish a copied snapshot to other threads.
class MultiTrackLooperCore {
public:
    MultiTrackLooperCore() = default;
    ~MultiTrackLooperCore() = default;
    MultiTrackLooperCore(const MultiTrackLooperCore&) = delete;
    MultiTrackLooperCore& operator=(const MultiTrackLooperCore&) = delete;

    [[nodiscard]] static std::uint64_t requiredTrackBufferBytes(
        std::uint32_t sampleRate, std::uint32_t maxLoopSeconds) noexcept;

    // This reserves the five-track engine state only. Each stereo history is
    // then provisioned separately so memory can be budgeted before activation.
    [[nodiscard]] bool prepare(std::uint32_t sampleRate,
                               std::uint32_t maxBlockFrames = 64,
                               std::uint64_t memoryBudgetBytes = 0) noexcept;
    [[nodiscard]] bool prepareTrackBuffer(std::uint8_t trackIndex,
                                          std::uint32_t maxLoopSeconds) noexcept;
    [[nodiscard]] std::uint64_t preparedHistoryBytes() const noexcept;

    // Multi-producer controls are serialized here; the audio consumer never
    // takes this mutex. Nondecreasing timestamps are required from producers.
    [[nodiscard]] bool postCommand(const TrackCommand& command) noexcept;

    [[nodiscard]] bool processBlock(const float* inputInterleavedStereo,
                                    float* outputInterleavedStereo,
                                    std::uint32_t frames,
                                    std::uint64_t absoluteStartFrame,
                                    MultiTrackProcessStats* stats = nullptr) noexcept;

    [[nodiscard]] TrackStatus trackStatus(std::uint8_t trackIndex) const noexcept;
    [[nodiscard]] double tempoBpm() const noexcept { return tempoBpm_; }
    [[nodiscard]] std::uint64_t expectedFrame() const noexcept { return expectedFrame_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }

private:
    struct Track {
        std::vector<float> historyInterleaved;
        webrc::dsp::ParameterSmoother gainSmoother;
        webrc::dsp::ParameterSmoother panSmoother;
        std::uint64_t writeFrame = 0;
        std::uint64_t loopFrames = 0;
        std::uint64_t playhead = 0;
        TrackPlaybackState state = TrackPlaybackState::Empty;
        bool muted = false;
        bool solo = false;
        bool inputRouted = true;
        bool gateTargetAudible = true;
        float gateCurrent = 1.0f;
        float gateTarget = 1.0f;
        float gateStep = 0.0f;
        std::uint32_t gateRemaining = 0;
        bool hasTail = false;
        float lastLeft = 0.0f;
        float lastRight = 0.0f;
        float defaultGain = 1.0f;
        float defaultPan = 0.0f;
        std::uint32_t maxLoopSeconds = 0;
    };

    [[nodiscard]] bool validateCommand(const TrackCommand& command) const noexcept;
    [[nodiscard]] bool tryPeekCommand(TrackCommand& command) const noexcept;
    void popCommand() noexcept;
    void applyCommand(const TrackCommand& command) noexcept;
    void applyDueCommands(std::uint64_t frame, std::uint32_t& commandBudget,
                          MultiTrackProcessStats& stats) noexcept;
    void clearTrack(Track& track) noexcept;
    void finalizeTrack(Track& track) noexcept;

    std::array<Track, kNativeTrackCount> tracks_{};
    std::array<TrackCommand, kTrackCommandCapacity + 1> commands_{};
    std::atomic<std::size_t> commandWrite_{0};
    std::atomic<std::size_t> commandRead_{0};
    mutable std::mutex commandProducerMutex_;
    std::uint64_t lastPostedFrame_ = 0;
    bool hasPostedFrame_ = false;
    std::uint32_t sampleRate_ = 48000;
    std::uint32_t maxBlockFrames_ = 64;
    std::uint64_t memoryBudgetBytes_ = 0;
    std::uint64_t historyBytes_ = 0;
    std::uint64_t expectedFrame_ = 0;
    bool hasExpectedFrame_ = false;
    float monitorCurrent_ = 0.0f;
    float monitorTarget_ = 0.0f;
    float monitorStep_ = 0.0f;
    std::uint32_t monitorRemaining_ = 0;
    bool anySolo_ = false;
    bool prepared_ = false;
    double tempoBpm_ = 120.0;
    std::uint64_t lateCommandCount_ = 0;
    std::atomic<std::uint64_t> droppedCommandCount_{0};
};

} // namespace webrc::native
