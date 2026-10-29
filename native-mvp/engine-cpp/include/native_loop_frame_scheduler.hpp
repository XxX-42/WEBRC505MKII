#pragma once

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace webrc::native {

constexpr std::size_t kNativeScheduledLoopTrackCount = 5U;

enum class NativeScheduledLoopAction : std::uint8_t {
    Record = 0U,
    Stop,
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
};

struct NativeScheduledLoopEvent {
    NativeScheduledLoopRequest request{};
    unsigned int frameOffset = 0U;
};

struct NativeScheduledLoopStatus {
    std::uint64_t requestedRevision = 0U;
    std::uint64_t appliedRevision = 0U;
    std::uint64_t cancelledRevision = 0U;
    std::uint64_t faultRevision = 0U;
    NativeScheduledLoopFault fault = NativeScheduledLoopFault::None;
};

// Fixed-storage handoff for future REC/STOP events. Producers enqueue requests
// from a control thread; the audio callback drains and evaluates them without
// waiting, allocation, or locks. A due event is only ACKed as applied after the
// callback owner reports the actual Looper transition result.
class NativeLoopFrameScheduler final {
public:
    static constexpr std::size_t kQueueCapacity = 32U;

    [[nodiscard]] bool request(const NativeScheduledLoopRequest& request) noexcept;
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

    void acknowledgeApplied(std::size_t trackIndex, std::uint64_t revision, bool applied) noexcept;
    [[nodiscard]] NativeScheduledLoopStatus status(std::size_t trackIndex) const noexcept;
    // Call only after the audio stream has stopped and no callback can access
    // the pending slots. Outstanding events receive a cancelled ACK.
    void cancelAllStopped() noexcept;

private:
    enum class RequestLifecycle : std::uint8_t { Idle = 0U, Pending, Cancelled, Dispatched, Faulted };
    [[nodiscard]] static constexpr std::uint64_t encodeLifecycle(
        std::uint64_t revision, RequestLifecycle lifecycle) noexcept {
        return (revision << 3U) | static_cast<std::uint64_t>(lifecycle);
    }

    struct Slot {
        NativeScheduledLoopRequest request{};
        bool occupied = false; // Audio callback owned.
    };

    [[nodiscard]] static constexpr std::size_t next(std::size_t index) noexcept {
        return (index + 1U) % kQueueCapacity;
    }
    void publishCancelled(std::size_t trackIndex, std::uint64_t revision) noexcept;
    void publishFault(std::size_t trackIndex, std::uint64_t revision, NativeScheduledLoopFault fault) noexcept;

    std::array<NativeScheduledLoopRequest, kQueueCapacity> queue_{};
    std::atomic<std::size_t> writeIndex_{0U};
    std::atomic<std::size_t> readIndex_{0U};
    std::array<Slot, kNativeScheduledLoopTrackCount> pending_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> requested_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> applied_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> cancelled_{};
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> faulted_{};
    std::array<std::atomic<NativeScheduledLoopFault>, kNativeScheduledLoopTrackCount> fault_{};
    // CAS is the linearization point between cancellation and callback dispatch.
    std::array<std::atomic<std::uint64_t>, kNativeScheduledLoopTrackCount> lifecycle_{};
};

} // namespace webrc::native
