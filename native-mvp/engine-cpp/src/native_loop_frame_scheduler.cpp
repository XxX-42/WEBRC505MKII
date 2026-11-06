#include "native_loop_frame_scheduler.hpp"

#include <algorithm>
#include <cstring>
#include <limits>

namespace webrc::native {

bool NativeLoopFrameScheduler::batchReadyToArchive(std::size_t trackIndex) const noexcept {
    const auto batchId = requestedBatchId_[trackIndex].load(std::memory_order_acquire);
    if (batchId == 0U) return true;
    {
        std::lock_guard<std::mutex> lock(batchReceiptHistoryMutex_);
        for (const auto& archived : batchReceiptHistory_) if (archived.batchId == batchId) return true;
    }
    const auto mask = requestedBatchMask_[trackIndex].load(std::memory_order_acquire);
    const auto leader = static_cast<std::size_t>(requestedBatchLeader_[trackIndex].load(std::memory_order_acquire));
    if (leader >= kNativeScheduledLoopTrackCount || batchLifecycleId_[leader].load(std::memory_order_acquire) != batchId)
        return false;
    const auto state = static_cast<BatchLifecycle>(batchLifecycle_[leader].load(std::memory_order_acquire));
    if (state != BatchLifecycle::Applied && state != BatchLifecycle::Cancelled && state != BatchLifecycle::Faulted)
        return false;
    for (std::size_t member = 0U; member < kNativeScheduledLoopTrackCount; ++member) {
        if ((mask & static_cast<std::uint8_t>(1U << member)) == 0U) continue;
        if (requestedBatchId_[member].load(std::memory_order_acquire) != batchId) return false;
        const auto revision = requested_[member].load(std::memory_order_acquire);
        if (revision == 0U || (applied_[member].load(std::memory_order_acquire) != revision &&
            cancelled_[member].load(std::memory_order_acquire) != revision &&
            faulted_[member].load(std::memory_order_acquire) != revision)) return false;
    }
    return true;
}

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
    if (previous != terminal || requestValue.revision <= previous || !batchReadyToArchive(track)) return false;
    archiveTerminalBatchForTrack(track);
    requestSnapshotSequence_[track].fetch_add(1U, std::memory_order_seq_cst); // odd: writer active
    requestedAbsoluteFrame_[track].store(requestValue.absoluteFrame, std::memory_order_seq_cst);
    requestedPhaseEpoch_[track].store(requestValue.phaseEpoch, std::memory_order_seq_cst);
    requestedSettingsRevision_[track].store(requestValue.settingsRevision, std::memory_order_seq_cst);
    requestedAction_[track].store(requestValue.action, std::memory_order_seq_cst);
    requestedIntentIdHigh_[track].store(requestValue.intentIdHigh, std::memory_order_seq_cst);
    requestedIntentIdLow_[track].store(requestValue.intentIdLow, std::memory_order_seq_cst);
    requestedBatchId_[track].store(0U, std::memory_order_seq_cst);
    requestedBatchMask_[track].store(0U, std::memory_order_seq_cst);
    requestedBatchLeader_[track].store(std::numeric_limits<std::uint8_t>::max(), std::memory_order_seq_cst);
    requestedStopRevision_[track].store(0U, std::memory_order_seq_cst);
    requestedProvenanceValid_[track].store(false, std::memory_order_seq_cst);
    requestedProvenanceBpmBits_[track].store(0U, std::memory_order_seq_cst);
    requestedProvenanceRevision_[track].store(0U, std::memory_order_seq_cst);
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
            item.intentIdHigh != first.intentIdHigh || item.intentIdLow != first.intentIdLow ||
            item.batchId != first.batchId || item.batchMask != first.batchMask ||
            item.batchExpectedStates != first.batchExpectedStates ||
            (item.action != NativeScheduledLoopAction::Stop && item.action != NativeScheduledLoopAction::Play) ||
            (item.action == NativeScheduledLoopAction::Stop && item.stopRevision == 0U) ||
            (item.action == NativeScheduledLoopAction::Play && item.stopRevision != 0U)) return false;
        const auto bit = static_cast<std::uint8_t>(1U << item.trackIndex);
        if ((seenMask & bit) != 0U) return false;
        seenMask = static_cast<std::uint8_t>(seenMask | bit);
    }
    if (seenMask != first.batchMask) return false;
    std::size_t leader = 0U;
    while (leader < kNativeScheduledLoopTrackCount &&
        (first.batchMask & static_cast<std::uint8_t>(1U << leader)) == 0U) ++leader;
    if (leader >= kNativeScheduledLoopTrackCount) return false;

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
        if (previous != terminal || item.revision <= previous || !batchReadyToArchive(track)) return false;
    }

    for (std::size_t i = 0U; i < count; ++i)
        archiveTerminalBatchForTrack(static_cast<std::size_t>(requests[i].trackIndex));

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
        requestedBatchLeader_[track].store(static_cast<std::uint8_t>(leader), std::memory_order_seq_cst);
        requestedStopRevision_[track].store(item.stopRevision, std::memory_order_seq_cst);
        requestedProvenanceValid_[track].store(item.provenanceValid, std::memory_order_seq_cst);
        std::uint64_t bpmBits = 0U;
        std::memcpy(&bpmBits, &item.provenanceBpm, sizeof(bpmBits));
        requestedProvenanceBpmBits_[track].store(bpmBits, std::memory_order_seq_cst);
        requestedProvenanceRevision_[track].store(item.provenanceRevision, std::memory_order_seq_cst);
        lifecycle_[track].store(encodeLifecycle(item.revision, RequestLifecycle::Pending), std::memory_order_seq_cst);
        requested_[track].store(item.revision, std::memory_order_seq_cst);
        requestSnapshotSequence_[track].fetch_add(1U, std::memory_order_seq_cst);
        queue_[probe] = item;
        probe = next(probe);
    }
    batchLifecycleId_[leader].store(first.batchId, std::memory_order_seq_cst);
    batchLifecycle_[leader].store(static_cast<std::uint8_t>(BatchLifecycle::Pending), std::memory_order_seq_cst);
    writeIndex_.store(probe, std::memory_order_release);
    return true;
}

bool NativeLoopFrameScheduler::cancelBatch(
    std::uint64_t batchId, std::uint8_t batchMask, std::uint64_t intentIdHigh, std::uint64_t intentIdLow,
    const std::array<std::uint64_t, kNativeScheduledLoopTrackCount>& revisions
) noexcept {
    if (batchId == 0U || batchMask == 0U) return false;
    std::size_t leader = 0U;
    while (leader < kNativeScheduledLoopTrackCount &&
        (batchMask & static_cast<std::uint8_t>(1U << leader)) == 0U) ++leader;
    if (leader >= kNativeScheduledLoopTrackCount ||
        batchLifecycleId_[leader].load(std::memory_order_acquire) != batchId) return false;

    bool unlocked = false;
    while (!requestWriterLocked_.compare_exchange_weak(unlocked, true,
            std::memory_order_acquire, std::memory_order_relaxed)) unlocked = false;
    struct WriterUnlock final {
        std::atomic<bool>& lock;
        ~WriterUnlock() { lock.store(false, std::memory_order_release); }
    } writerUnlock{requestWriterLocked_};

    for (std::size_t track = 0U; track < kNativeScheduledLoopTrackCount; ++track) {
        if ((batchMask & static_cast<std::uint8_t>(1U << track)) == 0U) continue;
        if (requestedBatchId_[track].load(std::memory_order_acquire) != batchId ||
            requestedBatchMask_[track].load(std::memory_order_acquire) != batchMask ||
            requested_[track].load(std::memory_order_acquire) != revisions[track] ||
            requestedIntentIdHigh_[track].load(std::memory_order_acquire) != intentIdHigh ||
            requestedIntentIdLow_[track].load(std::memory_order_acquire) != intentIdLow) return false;
    }
    auto expected = static_cast<std::uint8_t>(BatchLifecycle::Pending);
    return batchLifecycle_[leader].compare_exchange_strong(expected,
        static_cast<std::uint8_t>(BatchLifecycle::Cancelled),
        std::memory_order_acq_rel, std::memory_order_acquire);
}

void NativeLoopFrameScheduler::archiveTerminalBatchForTrack(std::size_t trackIndex) noexcept {
    if (trackIndex >= kNativeScheduledLoopTrackCount) return;
    const auto batchId = requestedBatchId_[trackIndex].load(std::memory_order_acquire);
    const auto batchMask = requestedBatchMask_[trackIndex].load(std::memory_order_acquire);
    if (batchId == 0U || batchMask == 0U) return;
    const auto first = status(trackIndex);
    std::array<std::uint64_t, kNativeScheduledLoopTrackCount> revisions{};
    for (std::size_t member = 0U; member < kNativeScheduledLoopTrackCount; ++member) {
        if ((batchMask & static_cast<std::uint8_t>(1U << member)) == 0U) continue;
        const auto memberStatus = status(member);
        if (memberStatus.batchId != batchId || memberStatus.batchMask != batchMask ||
            memberStatus.intentIdHigh != first.intentIdHigh || memberStatus.intentIdLow != first.intentIdLow) return;
        revisions[member] = memberStatus.requestedRevision;
    }

    NativeScheduledLoopBatchReceipt receipt{};
    if (!readLiveBatchReceipt(batchId, batchMask, first.intentIdHigh, first.intentIdLow, revisions, receipt) ||
        (receipt.state != NativeScheduledLoopBatchState::Applied &&
         receipt.state != NativeScheduledLoopBatchState::Cancelled &&
         receipt.state != NativeScheduledLoopBatchState::Faulted)) return;

    std::lock_guard<std::mutex> lock(batchReceiptHistoryMutex_);
    for (const auto& existing : batchReceiptHistory_) {
        if (existing.batchId == batchId) return;
    }
    batchReceiptHistory_[batchReceiptHistoryNext_] = receipt;
    batchReceiptHistoryNext_ = (batchReceiptHistoryNext_ + 1U) % batchReceiptHistory_.size();
}

bool NativeLoopFrameScheduler::readBatchReceipt(
    std::uint64_t batchId, std::uint8_t batchMask, std::uint64_t intentIdHigh,
    std::uint64_t intentIdLow,
    const std::array<std::uint64_t, kNativeScheduledLoopTrackCount>& revisions,
    NativeScheduledLoopBatchReceipt& receipt) const noexcept {
    if (readLiveBatchReceipt(batchId, batchMask, intentIdHigh, intentIdLow, revisions, receipt)) return true;
    std::lock_guard<std::mutex> lock(batchReceiptHistoryMutex_);
    for (const auto& archived : batchReceiptHistory_) {
        if (archived.batchId == batchId && archived.batchMask == batchMask &&
            archived.intentIdHigh == intentIdHigh && archived.intentIdLow == intentIdLow &&
            archived.revisions == revisions) {
            receipt = archived;
            return true;
        }
    }
    receipt = {};
    return false;
}

bool NativeLoopFrameScheduler::readLiveBatchReceipt(
    std::uint64_t batchId, std::uint8_t batchMask, std::uint64_t intentIdHigh,
    std::uint64_t intentIdLow,
    const std::array<std::uint64_t, kNativeScheduledLoopTrackCount>& revisions,
    NativeScheduledLoopBatchReceipt& receipt) const noexcept {
    receipt = {};
    constexpr auto allTracksMask = static_cast<std::uint8_t>((1U << kNativeScheduledLoopTrackCount) - 1U);
    if (batchId == 0U || batchMask == 0U || (batchMask & static_cast<std::uint8_t>(~allTracksMask)) != 0U ||
        intentIdHigh == 0U && intentIdLow == 0U) return false;
    std::size_t leader = 0U;
    while (leader < kNativeScheduledLoopTrackCount &&
        (batchMask & static_cast<std::uint8_t>(1U << leader)) == 0U) ++leader;
    if (leader >= kNativeScheduledLoopTrackCount ||
        batchLifecycleId_[leader].load(std::memory_order_acquire) != batchId) return false;

    for (std::size_t track = 0U; track < kNativeScheduledLoopTrackCount; ++track) {
        const auto statusValue = status(track);
        if ((batchMask & static_cast<std::uint8_t>(1U << track)) == 0U) {
            if (statusValue.batchId == batchId) return false;
            continue;
        }
        if (revisions[track] == 0U || statusValue.batchId != batchId || statusValue.batchMask != batchMask ||
            statusValue.requestedRevision != revisions[track] ||
            statusValue.intentIdHigh != intentIdHigh || statusValue.intentIdLow != intentIdLow) return false;
        receipt.members[track] = statusValue;
        receipt.revisions[track] = revisions[track];
    }

    const auto rawState = batchLifecycle_[leader].load(std::memory_order_acquire);
    if (batchLifecycleId_[leader].load(std::memory_order_acquire) != batchId) return false;
    switch (static_cast<BatchLifecycle>(rawState)) {
    case BatchLifecycle::Pending: receipt.state = NativeScheduledLoopBatchState::Pending; break;
    case BatchLifecycle::Cancelled: {
        bool everyMemberAcknowledged = true;
        for (std::size_t track = 0U; track < kNativeScheduledLoopTrackCount; ++track) {
            if ((batchMask & static_cast<std::uint8_t>(1U << track)) != 0U)
                everyMemberAcknowledged = everyMemberAcknowledged &&
                    receipt.members[track].cancelledRevision == revisions[track];
        }
        receipt.state = everyMemberAcknowledged
            ? NativeScheduledLoopBatchState::Cancelled
            : NativeScheduledLoopBatchState::CancellationRequested;
        break;
    }
    case BatchLifecycle::Dispatched: receipt.state = NativeScheduledLoopBatchState::Dispatched; break;
    case BatchLifecycle::Applied: receipt.state = NativeScheduledLoopBatchState::Applied; break;
    case BatchLifecycle::Faulted: receipt.state = NativeScheduledLoopBatchState::Faulted; break;
    case BatchLifecycle::Idle: return false;
    }
    receipt.batchId = batchId;
    receipt.batchMask = batchMask;
    receipt.intentIdHigh = intentIdHigh;
    receipt.intentIdLow = intentIdLow;
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
        auto& pendingLeader = pending_[track];
        if (!pendingLeader.occupied || pendingLeader.request.batchId == 0U) continue;
        const auto& batch = pendingLeader.request;
        bool alreadyHandled = false;
        for (std::size_t prior = 0U; prior < track; ++prior) {
            if (pending_[prior].occupied && pending_[prior].request.batchId == batch.batchId) {
                alreadyHandled = true;
                break;
            }
        }
        if (alreadyHandled) continue;

        const auto batchLeader = static_cast<std::size_t>(requestedBatchLeader_[track].load(std::memory_order_acquire));
        if (batchLeader >= batchLifecycle_.size() ||
            batchLifecycleId_[batchLeader].load(std::memory_order_acquire) != batch.batchId) {
            // A batch identity mismatch must reject the visible members as a
            // group; it cannot be allowed to fall through to single dispatch.
            for (std::size_t member = 0U; member < pending_.size(); ++member) {
                auto& slot = pending_[member];
                if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
                publishFault(member, slot.request.revision, NativeScheduledLoopFault::Superseded);
                lifecycle_[member].store(encodeLifecycle(slot.request.revision, RequestLifecycle::Faulted),
                    std::memory_order_release);
                slot.occupied = false;
            }
            continue;
        }
        auto groupState = static_cast<BatchLifecycle>(batchLifecycle_[batchLeader].load(std::memory_order_acquire));
        if (groupState == BatchLifecycle::Cancelled) {
            for (std::size_t member = 0U; member < pending_.size(); ++member) {
                auto& slot = pending_[member];
                if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
                const auto revision = slot.request.revision;
                lifecycle_[member].store(encodeLifecycle(revision, RequestLifecycle::Cancelled), std::memory_order_release);
                publishCancelled(member, revision);
                slot.occupied = false;
            }
            continue;
        }
        if (groupState != BatchLifecycle::Pending) {
            for (std::size_t member = 0U; member < pending_.size(); ++member) {
                auto& slot = pending_[member];
                if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
                publishFault(member, slot.request.revision, NativeScheduledLoopFault::Superseded);
                lifecycle_[member].store(encodeLifecycle(slot.request.revision, RequestLifecycle::Faulted),
                    std::memory_order_release);
                slot.occupied = false;
            }
            continue;
        }

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
            auto expectedGroup = static_cast<std::uint8_t>(BatchLifecycle::Pending);
            if (!batchLifecycle_[batchLeader].compare_exchange_strong(expectedGroup,
                    static_cast<std::uint8_t>(BatchLifecycle::Faulted),
                    std::memory_order_acq_rel, std::memory_order_acquire) &&
                expectedGroup == static_cast<std::uint8_t>(BatchLifecycle::Cancelled)) {
                for (std::size_t member = 0U; member < pending_.size(); ++member) {
                    auto& slot = pending_[member];
                    if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
                    const auto revision = slot.request.revision;
                    lifecycle_[member].store(encodeLifecycle(revision, RequestLifecycle::Cancelled), std::memory_order_release);
                    publishCancelled(member, revision);
                    slot.occupied = false;
                }
                continue;
            }
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

        auto expectedGroup = static_cast<std::uint8_t>(BatchLifecycle::Pending);
        if (!batchLifecycle_[batchLeader].compare_exchange_strong(expectedGroup,
                static_cast<std::uint8_t>(BatchLifecycle::Dispatched),
                std::memory_order_acq_rel, std::memory_order_acquire)) {
            if (expectedGroup == static_cast<std::uint8_t>(BatchLifecycle::Cancelled)) {
                for (std::size_t member = 0U; member < pending_.size(); ++member) {
                    auto& slot = pending_[member];
                    if (!slot.occupied || slot.request.batchId != batch.batchId) continue;
                    const auto revision = slot.request.revision;
                    lifecycle_[member].store(encodeLifecycle(revision, RequestLifecycle::Cancelled), std::memory_order_release);
                    publishCancelled(member, revision);
                    slot.occupied = false;
                }
                continue;
            }
            continue;
        }
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
            batchLifecycle_[batchLeader].store(static_cast<std::uint8_t>(BatchLifecycle::Faulted), std::memory_order_release);
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
        const auto batchMask = requestedBatchMask_[trackIndex].load(std::memory_order_acquire);
        if (batchMask != 0U) {
            const auto batchId = requestedBatchId_[trackIndex].load(std::memory_order_acquire);
            const auto leader = static_cast<std::size_t>(requestedBatchLeader_[trackIndex].load(std::memory_order_acquire));
            bool allApplied = leader < batchLifecycle_.size() && batchLifecycleId_[leader].load(std::memory_order_acquire) == batchId;
            for (std::size_t member = 0U; allApplied && member < kNativeScheduledLoopTrackCount; ++member) {
                if ((batchMask & static_cast<std::uint8_t>(1U << member)) == 0U) continue;
                allApplied = requestedBatchId_[member].load(std::memory_order_acquire) == batchId &&
                    applied_[member].load(std::memory_order_acquire) == requested_[member].load(std::memory_order_acquire);
            }
            if (allApplied) batchLifecycle_[leader].store(static_cast<std::uint8_t>(BatchLifecycle::Applied), std::memory_order_release);
        }
    } else {
        publishFault(trackIndex, revision, NativeScheduledLoopFault::ApplyRejected);
        lifecycle_[trackIndex].store(encodeLifecycle(revision, RequestLifecycle::Faulted),
            std::memory_order_release);
        const auto batchMask = requestedBatchMask_[trackIndex].load(std::memory_order_acquire);
        const auto leader = static_cast<std::size_t>(requestedBatchLeader_[trackIndex].load(std::memory_order_acquire));
        if (batchMask != 0U && leader < batchLifecycle_.size())
            batchLifecycle_[leader].store(static_cast<std::uint8_t>(BatchLifecycle::Faulted), std::memory_order_release);
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
        result.stopRevision = requestedStopRevision_[trackIndex].load(std::memory_order_seq_cst);
        result.provenanceValid = requestedProvenanceValid_[trackIndex].load(std::memory_order_seq_cst);
        const auto provenanceBpmBits = requestedProvenanceBpmBits_[trackIndex].load(std::memory_order_seq_cst);
        std::memcpy(&result.provenanceBpm, &provenanceBpmBits, sizeof(provenanceBpmBits));
        result.provenanceRevision = requestedProvenanceRevision_[trackIndex].load(std::memory_order_seq_cst);
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
        const auto batchMask = requestedBatchMask_[track].load(std::memory_order_acquire);
        const auto leader = static_cast<std::size_t>(requestedBatchLeader_[track].load(std::memory_order_acquire));
        if (batchMask != 0U && leader < batchLifecycle_.size()) {
            const auto state = static_cast<BatchLifecycle>(batchLifecycle_[leader].load(std::memory_order_acquire));
            if (state == BatchLifecycle::Dispatched)
                batchLifecycle_[leader].store(static_cast<std::uint8_t>(BatchLifecycle::Faulted), std::memory_order_release);
            else if (state == BatchLifecycle::Pending)
                batchLifecycle_[leader].store(static_cast<std::uint8_t>(BatchLifecycle::Cancelled), std::memory_order_release);
        }
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
