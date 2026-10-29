#include "native_loop_frame_scheduler.hpp"

#include <algorithm>
#include <limits>

namespace webrc::native {

bool NativeLoopFrameScheduler::request(const NativeScheduledLoopRequest& requestValue) noexcept {
    if (requestValue.trackIndex >= kNativeScheduledLoopTrackCount || requestValue.revision == 0U ||
        requestValue.absoluteFrame == std::numeric_limits<std::uint64_t>::max() ||
        (requestValue.action != NativeScheduledLoopAction::Record &&
         requestValue.action != NativeScheduledLoopAction::Stop)) return false;

    const auto track = static_cast<std::size_t>(requestValue.trackIndex);
    auto previous = requested_[track].load(std::memory_order_acquire);
    const auto terminal = std::max({
        applied_[track].load(std::memory_order_acquire),
        cancelled_[track].load(std::memory_order_acquire),
        faulted_[track].load(std::memory_order_acquire),
    });
    if (previous != terminal || requestValue.revision <= previous ||
        !requested_[track].compare_exchange_strong(previous, requestValue.revision,
            std::memory_order_acq_rel, std::memory_order_acquire)) return false;
    lifecycle_[track].store(encodeLifecycle(requestValue.revision, RequestLifecycle::Pending),
        std::memory_order_release);

    const auto write = writeIndex_.load(std::memory_order_relaxed);
    const auto nextWrite = next(write);
    if (nextWrite == readIndex_.load(std::memory_order_acquire)) {
        publishFault(track, requestValue.revision, NativeScheduledLoopFault::QueueFull);
        lifecycle_[track].store(encodeLifecycle(requestValue.revision, RequestLifecycle::Faulted),
            std::memory_order_release);
        return false;
    }
    queue_[write] = requestValue;
    writeIndex_.store(nextWrite, std::memory_order_release);
    return true;
}

bool NativeLoopFrameScheduler::cancel(std::size_t trackIndex, std::uint64_t revision) noexcept {
    if (trackIndex >= kNativeScheduledLoopTrackCount || revision == 0U ||
        requested_[trackIndex].load(std::memory_order_acquire) != revision) return false;
    auto expected = encodeLifecycle(revision, RequestLifecycle::Pending);
    return lifecycle_[trackIndex].compare_exchange_strong(expected,
        encodeLifecycle(revision, RequestLifecycle::Cancelled),
        std::memory_order_acq_rel, std::memory_order_acquire);
}

std::size_t NativeLoopFrameScheduler::collectDue(
    std::uint64_t blockStart,
    unsigned int frameCount,
    std::uint64_t activePhaseEpoch,
    std::uint64_t activeSettingsRevision,
    std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount>& events,
    std::uint8_t blockedTrackMask
) noexcept {
    std::size_t count = 0U;
    NativeScheduledLoopRequest incoming{};
    while (true) {
        const auto read = readIndex_.load(std::memory_order_relaxed);
        if (read == writeIndex_.load(std::memory_order_acquire)) break;
        incoming = queue_[read];
        readIndex_.store(next(read), std::memory_order_release);
        const auto track = static_cast<std::size_t>(incoming.trackIndex);
        if (track >= kNativeScheduledLoopTrackCount) continue;
        auto& pending = pending_[track];
        if (pending.occupied) {
            publishFault(track, incoming.revision, NativeScheduledLoopFault::Superseded);
            lifecycle_[track].store(encodeLifecycle(incoming.revision, RequestLifecycle::Faulted),
                std::memory_order_release);
            continue;
        }
        pending.request = incoming;
        pending.occupied = true;
    }

    const auto blockEnd = blockStart > std::numeric_limits<std::uint64_t>::max() - frameCount
        ? std::numeric_limits<std::uint64_t>::max() : blockStart + frameCount;
    for (std::size_t track = 0U; track < pending_.size(); ++track) {
        auto& pending = pending_[track];
        if (!pending.occupied) continue;
        const auto& requestValue = pending.request;
        const auto pendingLifecycle = encodeLifecycle(requestValue.revision, RequestLifecycle::Pending);
        const auto currentLifecycle = lifecycle_[track].load(std::memory_order_acquire);
        if (currentLifecycle == encodeLifecycle(requestValue.revision, RequestLifecycle::Cancelled)) {
            publishCancelled(track, requestValue.revision);
            pending.occupied = false;
            continue;
        }
        if (requestValue.phaseEpoch != activePhaseEpoch) {
            auto expected = pendingLifecycle;
            if (lifecycle_[track].compare_exchange_strong(expected,
                    encodeLifecycle(requestValue.revision, RequestLifecycle::Faulted),
                    std::memory_order_acq_rel, std::memory_order_acquire)) {
                publishFault(track, requestValue.revision, NativeScheduledLoopFault::StalePhaseEpoch);
            } else if (expected == encodeLifecycle(requestValue.revision, RequestLifecycle::Cancelled)) {
                publishCancelled(track, requestValue.revision);
            }
            pending.occupied = false;
            continue;
        }
        if (requestValue.settingsRevision != activeSettingsRevision) {
            auto expected = pendingLifecycle;
            if (lifecycle_[track].compare_exchange_strong(expected,
                    encodeLifecycle(requestValue.revision, RequestLifecycle::Faulted),
                    std::memory_order_acq_rel, std::memory_order_acquire)) {
                publishFault(track, requestValue.revision, NativeScheduledLoopFault::StaleSettingsRevision);
            } else if (expected == encodeLifecycle(requestValue.revision, RequestLifecycle::Cancelled)) {
                publishCancelled(track, requestValue.revision);
            }
            pending.occupied = false;
            continue;
        }
        if ((blockedTrackMask & static_cast<std::uint8_t>(1U << track)) != 0U) continue;
        if (requestValue.absoluteFrame < blockStart) {
            auto expected = pendingLifecycle;
            if (lifecycle_[track].compare_exchange_strong(expected,
                    encodeLifecycle(requestValue.revision, RequestLifecycle::Faulted),
                    std::memory_order_acq_rel, std::memory_order_acquire)) {
                publishFault(track, requestValue.revision, NativeScheduledLoopFault::MissedFrame);
            } else if (expected == encodeLifecycle(requestValue.revision, RequestLifecycle::Cancelled)) {
                publishCancelled(track, requestValue.revision);
            }
            pending.occupied = false;
            continue;
        }
        if (requestValue.absoluteFrame >= blockEnd || count == events.size()) continue;

        auto expected = pendingLifecycle;
        if (!lifecycle_[track].compare_exchange_strong(expected,
                encodeLifecycle(requestValue.revision, RequestLifecycle::Dispatched),
                std::memory_order_acq_rel, std::memory_order_acquire)) {
            if (expected == encodeLifecycle(requestValue.revision, RequestLifecycle::Cancelled)) {
                publishCancelled(track, requestValue.revision);
            }
            pending.occupied = false;
            continue;
        }

        events[count].request = requestValue;
        events[count].frameOffset = static_cast<unsigned int>(requestValue.absoluteFrame - blockStart);
        ++count;
        pending.occupied = false;
    }
    return count;
}

void NativeLoopFrameScheduler::acknowledgeApplied(
    std::size_t trackIndex, std::uint64_t revision, bool didApply
) noexcept {
    if (trackIndex >= kNativeScheduledLoopTrackCount || revision == 0U ||
        requested_[trackIndex].load(std::memory_order_acquire) != revision) return;
    if (didApply) {
        applied_[trackIndex].store(revision, std::memory_order_release);
        fault_[trackIndex].store(NativeScheduledLoopFault::None, std::memory_order_release);
    } else {
        publishFault(trackIndex, revision, NativeScheduledLoopFault::ApplyRejected);
        lifecycle_[trackIndex].store(encodeLifecycle(revision, RequestLifecycle::Faulted),
            std::memory_order_release);
    }
}

NativeScheduledLoopStatus NativeLoopFrameScheduler::status(std::size_t trackIndex) const noexcept {
    if (trackIndex >= kNativeScheduledLoopTrackCount) return {};
    NativeScheduledLoopStatus result{};
    result.requestedRevision = requested_[trackIndex].load(std::memory_order_acquire);
    result.appliedRevision = applied_[trackIndex].load(std::memory_order_acquire);
    result.cancelledRevision = cancelled_[trackIndex].load(std::memory_order_acquire);
    result.faultRevision = faulted_[trackIndex].load(std::memory_order_acquire);
    result.fault = fault_[trackIndex].load(std::memory_order_acquire);
    return result;
}

void NativeLoopFrameScheduler::cancelAllStopped() noexcept {
    // The caller has joined/stopped every callback owner, so it is now safe to
    // discard callback-private pending slots and advance the consumer cursor.
    for (std::size_t track = 0U; track < pending_.size(); ++track) {
        const auto revision = requested_[track].load(std::memory_order_acquire);
        const auto terminal = std::max({
            applied_[track].load(std::memory_order_acquire),
            cancelled_[track].load(std::memory_order_acquire),
            faulted_[track].load(std::memory_order_acquire),
        });
        if (revision != 0U && revision != terminal) {
            const auto state = lifecycle_[track].load(std::memory_order_acquire);
            if (state == encodeLifecycle(revision, RequestLifecycle::Dispatched)) {
                lifecycle_[track].store(encodeLifecycle(revision, RequestLifecycle::Faulted),
                    std::memory_order_release);
                publishFault(track, revision, NativeScheduledLoopFault::StoppedAfterDispatch);
            } else {
                lifecycle_[track].store(encodeLifecycle(revision, RequestLifecycle::Cancelled),
                    std::memory_order_release);
                publishCancelled(track, revision);
            }
        }
        pending_[track].occupied = false;
    }
    const auto write = writeIndex_.load(std::memory_order_acquire);
    readIndex_.store(write, std::memory_order_release);
}

void NativeLoopFrameScheduler::publishCancelled(std::size_t trackIndex, std::uint64_t revision) noexcept {
    cancelled_[trackIndex].store(revision, std::memory_order_release);
    fault_[trackIndex].store(NativeScheduledLoopFault::None, std::memory_order_release);
}

void NativeLoopFrameScheduler::publishFault(
    std::size_t trackIndex, std::uint64_t revision, NativeScheduledLoopFault faultValue
) noexcept {
    fault_[trackIndex].store(faultValue, std::memory_order_release);
    faulted_[trackIndex].store(revision, std::memory_order_release);
}

} // namespace webrc::native
