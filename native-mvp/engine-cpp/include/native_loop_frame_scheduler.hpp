#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <mutex>

namespace webrc::native {

constexpr std::size_t kNativeScheduledLoopTrackCount = 5U;

enum class NativeScheduledLoopAction : std::uint8_t {
    Record = 0U,
    Stop,
    Play,
};

enum class NativeScheduledLoopFault : std::uint8_t {
    None = 0U,
    QueueFull,
    Superseded,
    StalePhaseEpoch,
    StaleSettingsRevision,
    MissedFrame,
    ApplyRejected,
    StoppedAfterDispatch,
};

struct NativeScheduledLoopRequest {
    std::uint64_t revision = 0U;
    std::uint64_t absoluteFrame = 0U;
    std::uint64_t phaseEpoch = 0U;
    std::uint64_t settingsRevision = 0U;
    std::uint8_t trackIndex = 0U;
    NativeScheduledLoopAction action = NativeScheduledLoopAction::Record;
    std::uint64_t intentIdHigh = 0U;
    std::uint64_t intentIdLow = 0U;
    // Nonzero batchId marks a group published atomically by requestBatch.
    // Every member shares batchId, absoluteFrame, phase/settings revisions,
    // and batchMask. A group is dispatched only when every member is ready.
    std::uint64_t batchId = 0U;
    std::uint8_t batchMask = 0U;
    std::uint64_t stopRevision = 0U;
    bool provenanceValid = false;
    double provenanceBpm = 0.0;
    std::uint64_t provenanceRevision = 0U;
    // Snapshot of every track at admission. The callback revalidates this
    // complete fence after applying queued control commands at the due block.
    std::array<std::uint8_t, kNativeScheduledLoopTrackCount> batchExpectedStates{};
};

struct NativeScheduledLoopEvent {
    NativeScheduledLoopRequest request{};
    unsigned int frameOffset = 0U;
};

struct NativeScheduledLoopStatus {
    std::uint64_t requestedRevision = 0U;
    std::uint64_t requestedAbsoluteFrame = 0U;
    std::uint64_t requestedPhaseEpoch = 0U;
    std::uint64_t requestedSettingsRevision = 0U;
    NativeScheduledLoopAction requestedAction = NativeScheduledLoopAction::Record;
    std::uint64_t intentIdHigh = 0U;
    std::uint64_t intentIdLow = 0U;
    std::uint64_t batchId = 0U;
    std::uint8_t batchMask = 0U;
    std::uint64_t stopRevision = 0U;
    bool provenanceValid = false;
    double provenanceBpm = 0.0;
    std::uint64_t provenanceRevision = 0U;
    std::uint64_t appliedRevision = 0U;
    std::uint64_t appliedAbsoluteFrame = 0U;
    std::uint64_t cancelledRevision = 0U;
    std::uint64_t faultRevision = 0U;
    NativeScheduledLoopFault fault = NativeScheduledLoopFault::None;
};

enum class NativeScheduledLoopBatchState : std::uint8_t {
    Unknown = 0U,
    Pending,
    CancellationRequested,
    Dispatched,
    Cancelled,
    Applied,
    Faulted,
};

struct NativeScheduledLoopBatchReceipt {
    NativeScheduledLoopBatchState state = NativeScheduledLoopBatchState::Unknown;
    std::uint64_t batchId = 0U;
    std::uint8_t batchMask = 0U;
    std::uint64_t intentIdHigh = 0U;
    std::uint64_t intentIdLow = 0U;
    std::array<std::uint64_t, kNativeScheduledLoopTrackCount> revisions{};
    std::array<NativeScheduledLoopStatus, kNativeScheduledLoopTrackCount> members{};
};

// Fixed-storage handoff for future REC/STOP events. Producers enqueue requests
// from a control thread; the audio callback drains and evaluates them without
// waiting, allocation, or locks. A due event is only ACKed as applied after the
// callback owner reports the actual Looper transition result.
class NativeLoopFrameScheduler final {
public:
    static constexpr std::size_t kQueueCapacity = 32U;

    [[nodiscard]] bool request(const NativeScheduledLoopRequest& request) noexcept;
    [[nodiscard]] bool requestBatch(
        const std::array<NativeScheduledLoopRequest, kNativeScheduledLoopTrackCount>& requests,
        std::size_t count
    ) noexcept;
    [[nodiscard]] bool cancelBatch(std::uint64_t batchId, std::uint8_t batchMask,
        std::uint64_t intentIdHigh, std::uint64_t intentIdLow,
        const std::array<std::uint64_t, kNativeScheduledLoopTrackCount>& revisions) noexcept;
    [[nodiscard]] bool readBatchReceipt(std::uint64_t batchId, std::uint8_t batchMask,
        std::uint64_t intentIdHigh, std::uint64_t intentIdLow,
        const std::array<std::uint64_t, kNativeScheduledLoopTrackCount>& revisions,
        NativeScheduledLoopBatchReceipt& receipt) const noexcept;
    [[nodiscard]] bool cancel(std::size_t trackIndex, std::uint64_t revision) noexcept;

    // Returns at most one event per track. Events are due in [blockStart,
    // blockStart + frameCount); an event exactly at blockEnd belongs to the
    // next callback. Phase/settings changes and missed frames fail closed.
    [[nodiscard]] std::size_t collectDue(
        std::uint64_t blockStart,
        unsigned int frameCount,
        std::uint64_t activePhaseEpoch,
        std::uint64_t activeSettingsRevision,
        std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount>& events,
        std::uint8_t blockedTrackMask = 0U
    ) noexcept;

    void acknowledgeApplied(std::size_t trackIndex, std::uint64_t revision,
        std::uint64_t appliedAbsoluteFrame, bool applied) noexcept;
    [[nodiscard]] NativeScheduledLoopStatus status(std::size_t trackIndex) const noexcept;
    // Bounded, lock-free callback query. Never reads the request snapshot seqlock.
    [[nodiscard]] bool hasCancelledOrFaulted(std::size_t trackIndex, std::uint64_t revision) const noexcept;
    // Call only after the audio stream has stopped and no callback can access
    // the pending slots. Outstanding events receive a cancelled ACK.
    void cancelAllStopped() noexcept;

private:
    enum class RequestLifecycle : std::uint8_t { Idle = 0U, Pending, Cancelled, Dispatched, Faulted };
    enum class BatchLifecycle : std::uint8_t { Idle = 0U, Pending, Cancelled, Dispatched, Faulted, Applied };
    [[nodiscard]] bool batchReadyToArchive(std::size_t trackIndex) const noexcept;
    [[nodiscard]] static constexpr std::uint64_t encodeLifecycle(
        std::uint64_t revision, RequestLifecycle lifecycle) noexcept {
        return (revision << 3U) | static_cast<std::uint64_t>(lifecycle);
    }

    struct Slot {
        NativeScheduledLoopRequest request{};
        bool occupied = false; // Audio callback owned.
    };

    static constexpr std::size_t kBatchReceiptHistoryCapacity = 64U;
    void archiveTerminalBatchForTrack(std::size_t trackIndex) noexcept;
    [[nodiscard]] bool readLiveBatchReceipt(std::uint64_t batchId, std::uint8_t batchMask,
        std::uint64_t intentIdHigh, std::uint64_t intentIdLow,
        const std::array<std::uint64_t, kNativeScheduledLoopTrackCount>& revisions,
        NativeScheduledLoopBatchReceipt& receipt) const noexcept;

    [[nodiscard]] static constexpr std::size_t next(std::size_t index) noexcept {
        return (index + 1U) % kQueueCapacity;
    }
    void publishCancelled(std::size_t trackIndex, std::uint64_t revision) noexcept;
    void publishFault(std::size_t trackIndex, std::uint64_t revision, NativeScheduledLoopFault fault) noexcept;

    std::array<NativeScheduledLoopRequest, kQueueCapacity> queue_{};
    std::atomic<bool> requestWriterLocked_{false};
    std::atomic<std::size_t> writeIndex_{0U};
    std::atomic<std::size_t> readIndex_{0U};
    std::array<Slot, kNativeScheduledLoopTrackCount> pending_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requested_{};
    // Status readers retry if a request's metadata/revision tuple changes mid-read.
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestSnapshotSequence_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedAbsoluteFrame_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedPhaseEpoch_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedSettingsRevision_{};
    std::array<std::atomic<NativeScheduledLoopAction>, kNativeScheduledLoopTrackCount> requestedAction_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedIntentIdHigh_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedIntentIdLow_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedBatchId_{};
    std::array<std::atomic<std::uint8_t>, kNativeScheduledLoopTrackCount> requestedBatchMask_{};
    std::array<std::atomic<std::uint8_t>, kNativeScheduledLoopTrackCount> requestedBatchLeader_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedStopRevision_{};
    std::array<std::atomic<bool>, kNativeScheduledLoopTrackCount> requestedProvenanceValid_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedProvenanceBpmBits_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requestedProvenanceRevision_{};
    std::array<std::atomic<std::uint8_t>, kNativeScheduledLoopTrackCount> batchLifecycle_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> batchLifecycleId_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> applied_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> appliedSnapshotSequence_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> appliedAbsoluteFrame_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> cancelled_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> faulted_{};
    std::array<std::atomic<NativeScheduledLoopFault>, kNativeScheduledLoopTrackCount> fault_{};
    // CAS is the linearization point between cancellation and callback dispatch.
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> lifecycle_{};
    // Fixed-size, control-thread-only history of the 64 newest terminal batches lets a reconnect reconcile a
    // terminal batch after a later command supersedes its live per-track slots.
    // The audio callback never reads or locks this history.
    mutable std::mutex batchReceiptHistoryMutex_;
    std::array<NativeScheduledLoopBatchReceipt, kBatchReceiptHistoryCapacity> batchReceiptHistory_{};
    std::size_t batchReceiptHistoryNext_ = 0U;
};

} // namespace webrc::native
