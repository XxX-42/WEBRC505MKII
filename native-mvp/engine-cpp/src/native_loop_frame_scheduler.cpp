#include "native_loop_frame_scheduler.hpp"

#include <algorithm>
#include <limits>

namespace webrc::native {

bool NativeLoopFrameScheduler::request(const NativeScheduledLoopRequest& requestValue) noexcept {
    if (requestValue.trackIndex >= kNativeScheduledLoopTrackCount || requestValue.revision == 0U ||
        requestValue.absoluteFrame == std::numeric_limits<std::uint64_t>::max() ||
        requestValue.batchId != 0U || requestValue.batchMask != 0U ||
        (requestValue.action != NativeScheduledLoopAction::Record &&
         requestValue.action != NativeScheduledLoopAction::Stop &&
         requestValue.action != NativeScheduledLoopAction::Play)) return false;

    // The ring is SPSC, but public command paths can have multiple control
    // producers. Serialize them here; the audio callback never takes this lock.
    bool unlocked = false;
    while (!requestWriterLocked_.compare_exchange_weak(unlocked, true,
            std::memory_order_acquire, std::memory_order_relaxed)) {
        unlocked = false;
    }
    struct WriterUnlock final {
        std::atomic<bool>& lock;
        ~WriterUnlock() { lock.store(false, std::memory_order_release); }
    } writerUnlock{requestWriterLocked_};

    const auto track = static_cast<std::size_t>(requestValue.trackIndex);
    auto previous = requested_[track].load(std::memory_order_acquire);
    const auto terminal = std::max({
        applied_[track].load(std::memory_order_acquire),
        cancelled_[track].load(std::memory_order_acquire),
        faulted_[track].load(std::memory_order_acquire),
    });
    if (previous != terminal || requestValue.revision <= previous) return false;
    requestSnapshotSequence_[track].fetch_add(1U, std::memory_order_seq_cst); // odd: writer active
    requestedAbsoluteFrame_[track].store(requestValue.absoluteFrame, std::memory_order_seq_cst);
    requestedPhaseEpoch_[track].store(requestValue.phaseEpoch, std::memory_order_seq_cst);
    requestedSettingsRevision_[track].store(requestValue.settingsRevision, std::memory_order_seq_cst);
    requestedAction_[track].store(requestValue.action, std::memory_order_seq_cst);
    requestedIntentIdHigh_[track].store(requestValue.intentIdHigh, std::memory_order_seq_cst);
    requestedIntentIdLow_[track].store(requestValue.intentIdLow, std::memory_order_seq_cst);
    requestedBatchId_[track].store(0U, std::memory_order_seq_cst);
    requestedBatchMask_[track].store(0U, std::memory_order_seq_cst);
    lifecycle_[track].store(encodeLifecycle(requestValue.revision, RequestLifecycle::Pending),
        std::memory_order_seq_cst);
    // Publish revision last so callback/status consumers identify the tuple.
    requested_[track].store(requestValue.revision, std::memory_order_seq_cst);
    requestSnapshotSequence_[track].fetch_add(1U, std::memory_order_seq_cst); // even: stable snapshot

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

bool NativeLoopFrameScheduler::requestBatch(
    const std::array<NativeScheduledLoopRequest, kNativeScheduledLoopTrackCount>& requests,
    std::size_t count
) noexcept {
    if (count < 2U || count > kNativeScheduledLoopTrackCount) return false;
    const auto& first = requests[0U];
    if (first.batchId == 0U || first.batchMask == 0U || first.absoluteFrame == std::numeric_limits<std::uint64_t>::max()) return false;
    std::uint8_t seenMask = 0U;
    for (std::size_t i = 0U; i < count; ++i) {
        const auto& item = requests[i];
        if (item.trackIndex >= kNativeScheduledLoopTrackCount || item.revision == 0U ||
            item.absoluteFrame != first.absoluteFrame || item.phaseEpoch != first.phaseEpoch ||
            item.settingsRevision != first.settingsRevision || item.action != first.action ||
            item.batchId != first.batchId || item.batchMask != first.batchMask ||
            (item.action != NativeScheduledLoopAction::Record &&
             item.action != NativeScheduledLoopAction::Stop &&
             item.action != NativeScheduledLoopAction::Play)) return false;
        const auto bit = static_cast<std::uint8_t>(1U << item.trackIndex);
        if ((seenMask & bit) != 0U) return false;
        seenMask = static_cast<std::uint8_t>(seenMask | bit);
    }
    if (seenMask != first.batchMask) return false;

    // Serialize control producers once, then publish the complete fixed-size
    // group through one write-index release. The callback sees either every
    // member or none of them.
    bool unlocked = false;
    while (!requestWriterLocked_.compare_exchange_weak(unlocked, true,
            std::memory_order_acquire, std::memory_order_relaxed)) unlocked = false;
    struct WriterUnlock final {
        std::atomic<bool>& lock;
        ~WriterUnlock() { lock.store(false, std::memory_order_release); }
    } writerUnlock{requestWriterLocked_};

    const auto write = writeIndex_.load(std::memory_order_relaxed);
    const auto read = readIndex_.load(std::memory_order_acquire);
    const auto freeSlots = write >= read ? kQueueCapacity - (write - read) - 1U : read - write - 1U;
    if (count > freeSlots) return false;

    for (std::size_t i = 0U; i < count; ++i) {
        const auto& item = requests[i];
        const auto track = static_cast<std::size_t>(item.trackIndex);
        const auto previous = requested_[track].load(std::memory_order_acquire);
        const auto terminal = std::max({applied_[track].load(std::memory_order_acquire),
            cancelled_[track].load(std::memory_order_acquire), faulted_[track].load(std::memory_order_acquire)});
        if (previous != terminal || item.revision <= previous) return false;
    }

    auto probe = write;
    for (std::size_t i = 0U; i < count; ++i) {
        const auto& item = requests[i];
        const auto track = static_cast<std::size_t>(item.trackIndex);
        requestSnapshotSequence_[track].fetch_add(1U, std::memory_order_seq_cst);
        requestedAbsoluteFrame_[track].store(item.absoluteFrame, std::memory_order_seq_cst);
        requestedPhaseEpoch_[track].store(item.phaseEpoch, std::memory_order_seq_cst);
        requestedSettingsRevision_[track].store(item.settingsRevision, std::memory_order_seq_cst);
        requestedAction_[track].store(item.action, std::memory_order_seq_cst);
        requestedIntentIdHigh_[track].store(item.intentIdHigh, std::memory_order_seq_cst);
        requestedIntentIdLow_[track].store(item.intentIdLow, std::memory_order_seq_cst);
        requestedBatchId_[track].store(item.batchId, std::memory_order_seq_cst);
        requestedBatchMask_[track].store(item.batchMask, std::memory_order_seq_cst);
        lifecycle_[track].store(encodeLifecycle(item.revision, RequestLifecycle::Pending), std::memory_order_seq_cst);
        requested_[track].store(item.revision, std::memory_order_seq_cst);
        requestSnapshotSequence_[track].fetch_add(1U, std::memory_order_seq_cst);
        queue_[probe] = item;
        probe = next(probe);
    }
    writeIndex_.store(probe, std::memory_order_release);
    return true;
}

bool NativeLoopFrameScheduler::cancel(std::size_t trackIndex, std::uint64_t revision) noexcept {
    if (trackIndex >= kNativeScheduledLoopTrackCount || revision == 0U ||
        requested_[trackIndex].load(std::memory_order_acquire) != revision ||
        requestedBatchMask_[trackIndex].load(std::memory_order_acquire) != 0U) return false;
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

    // Batch members are handled as one scheduling unit. Since requestBatch
    // publishes the queue write index once, all members are visible together.
    // A group waits if any member is callback-blocked and faults as a group if
    // its target frame is missed or its phase/settings token becomes stale.
    for (std::size_t track = 0U; track < pending_.size(); ++track) {
        auto& leader = pending_[track];
        if (!leader.occupied || leader.request.batchId == 0U) continue;
        const auto& batch = leader.request;
        bool alreadyHandled = false;
        for (std::size_t prior = 0U; prior < track; ++prior) {
            if (pending_[prior].occupied && pending_[prior].request.batchId == batch.batchId) {
                alreadyHandled = true;
                break;
            }
        }
        if (alreadyHandled) continue;

        std::uint8_t presentMask = 0U;
        for (std::size_t member = 0U; member < pending_.size(); ++member) {
            const auto& slot = pending_[member];
            if (slot.occupied && slot.request.batchId == batch.batchId) {
                presentMask = static_cast<std::uint8_t>(presentMask | (1U << member));
            }
        }
        NativeScheduledLoopFault failure = NativeScheduledLoopFault::None;
        if (presentMask != batch.batchMask) failure = NativeScheduledLoopFault::Superseded;
        else if (batch.phaseEpoch != activePhaseEpoch) failure = NativeScheduledLoopFault::StalePhaseEpoch;
        else if (batch.settingsRevision != activeSettingsRevision) failure = NativeScheduledLoopFault::StaleSettingsRevision;
        else if (batch.absoluteFrame < blockStart) failure = NativeScheduledLoopFault::MissedFrame;
        else if ((batch.batchMask & blockedTrackMask) != 0U && batch.absoluteFrame < blockEnd) continue;

        if (failure != NativeScheduledLoopFault::None) {
            for (std::size_t member = 0U; member < pending_.size(); ++member) {
                auto& slot = pending_[member];
                if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
                const auto revision = slot.request.revision;
                auto expected = encodeLifecycle(revision, RequestLifecycle::Pending);
                if (lifecycle_[member].compare_exchange_strong(expected,
                        encodeLifecycle(revision, RequestLifecycle::Faulted),
                        std::memory_order_acq_rel, std::memory_order_acquire)) {
                    publishFault(member, revision, failure);
                }
                slot.occupied = false;
            }
            continue;
        }
        if (batch.absoluteFrame >= blockEnd) continue;

        // Batch cancellation is intentionally unsupported: this CAS set is
        // therefore stable against control-thread cancellation between members.
        bool dispatched = true;
        for (std::size_t member = 0U; member < pending_.size(); ++member) {
            const auto& slot = pending_[member];
            if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
            const auto revision = slot.request.revision;
            auto expected = encodeLifecycle(revision, RequestLifecycle::Pending);
            if (!lifecycle_[member].compare_exchange_strong(expected,
                    encodeLifecycle(revision, RequestLifecycle::Dispatched),
                    std::memory_order_acq_rel, std::memory_order_acquire)) {
                dispatched = false;
                break;
            }
        }
        if (!dispatched) {
            for (std::size_t member = 0U; member < pending_.size(); ++member) {
                auto& slot = pending_[member];
                if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
                const auto revision = slot.request.revision;
                auto expected = encodeLifecycle(revision, RequestLifecycle::Dispatched);
                (void)lifecycle_[member].compare_exchange_strong(expected,
                    encodeLifecycle(revision, RequestLifecycle::Faulted),
                    std::memory_order_acq_rel, std::memory_order_acquire);
                publishFault(member, revision, NativeScheduledLoopFault::ApplyRejected);
                slot.occupied = false;
            }
            continue;
        }
        for (std::size_t member = 0U; member < pending_.size(); ++member) {
            auto& slot = pending_[member];
            if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
            events[count].request = slot.request;
            events[count].frameOffset = static_cast<unsigned int>(batch.absoluteFrame - blockStart);
            ++count;
            slot.occupied = false;
        }
    }

    for (std::size_t track = 0U; track < pending_.size(); ++track) {
        auto& pending = pending_[track];
        if (!pending.occupied) continue;
        const auto& requestValue = pending.request;
        if (requestValue.batchId != 0U) continue;
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
    std::size_t trackIndex, std::uint64_t revision, std::uint64_t appliedAbsoluteFrame, bool didApply
) noexcept {
    if (trackIndex >= kNativeScheduledLoopTrackCount || revision == 0U ||
        requested_[trackIndex].load(std::memory_order_acquire) != revision) return;
    if (didApply && appliedAbsoluteFrame == requestedAbsoluteFrame_[trackIndex].load(std::memory_order_acquire)) {
        appliedSnapshotSequence_[trackIndex].fetch_add(1U, std::memory_order_seq_cst); // odd: ACK writer active
        appliedAbsoluteFrame_[trackIndex].store(appliedAbsoluteFrame, std::memory_order_seq_cst);
        applied_[trackIndex].store(revision, std::memory_order_seq_cst);
        appliedSnapshotSequence_[trackIndex].fetch_add(1U, std::memory_order_seq_cst); // even: stable ACK
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
    for (;;) {
        const auto sequenceBefore = requestSnapshotSequence_[trackIndex].load(std::memory_order_seq_cst);
        if ((sequenceBefore & 1U) != 0U) continue;
        result.requestedAbsoluteFrame = requestedAbsoluteFrame_[trackIndex].load(std::memory_order_seq_cst);
        result.requestedPhaseEpoch = requestedPhaseEpoch_[trackIndex].load(std::memory_order_seq_cst);
        result.requestedSettingsRevision = requestedSettingsRevision_[trackIndex].load(std::memory_order_seq_cst);
        result.requestedAction = requestedAction_[trackIndex].load(std::memory_order_seq_cst);
        result.intentIdHigh = requestedIntentIdHigh_[trackIndex].load(std::memory_order_seq_cst);
        result.intentIdLow = requestedIntentIdLow_[trackIndex].load(std::memory_order_seq_cst);
        result.batchId = requestedBatchId_[trackIndex].load(std::memory_order_seq_cst);
        result.batchMask = requestedBatchMask_[trackIndex].load(std::memory_order_seq_cst);
        result.requestedRevision = requested_[trackIndex].load(std::memory_order_seq_cst);
        if (sequenceBefore == requestSnapshotSequence_[trackIndex].load(std::memory_order_seq_cst)) break;
    }
    for (;;) {
        const auto sequenceBefore = appliedSnapshotSequence_[trackIndex].load(std::memory_order_seq_cst);
        if ((sequenceBefore & 1U) != 0U) continue;
        result.appliedAbsoluteFrame = appliedAbsoluteFrame_[trackIndex].load(std::memory_order_seq_cst);
        result.appliedRevision = applied_[trackIndex].load(std::memory_order_seq_cst);
        if (sequenceBefore == appliedSnapshotSequence_[trackIndex].load(std::memory_order_seq_cst)) break;
    }
    result.cancelledRevision = cancelled_[trackIndex].load(std::memory_order_acquire);
    result.faultRevision = faulted_[trackIndex].load(std::memory_order_acquire);
    result.fault = fault_[trackIndex].load(std::memory_order_acquire);
    return result;
}

bool NativeLoopFrameScheduler::hasCancelledOrFaulted(std::size_t trackIndex, std::uint64_t revision) const noexcept {
    if (trackIndex >= kNativeScheduledLoopTrackCount || revision == 0U) return false;
    return cancelled_[trackIndex].load(std::memory_order_acquire) == revision ||
        faulted_[trackIndex].load(std::memory_order_acquire) == revision;
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
