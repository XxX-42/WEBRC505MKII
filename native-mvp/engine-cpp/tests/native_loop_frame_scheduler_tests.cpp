#include "native_loop_frame_scheduler.hpp"
#include "looper_core.hpp"

#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>

using namespace webrc::native;

namespace {
struct LooperCommandContext {
    LooperCore* looper = nullptr;
    Command command{};
};

void applyLooperCommand(void* context) noexcept {
    auto* const commandContext = static_cast<LooperCommandContext*>(context);
    commandContext->looper->applyCommand(commandContext->command);
}

NativeScheduledLoopRequest request(
    std::uint64_t revision,
    std::uint64_t frame,
    std::uint64_t epoch = 7U,
    std::uint64_t settings = 11U,
    std::uint8_t track = 0U,
    NativeScheduledLoopAction action = NativeScheduledLoopAction::Record
) {
    return {revision, frame, epoch, settings, track, action};
}

void dueEventsUseExactCallbackOffsetsAndRequireApplyAck() {
    NativeLoopFrameScheduler scheduler;
    assert(scheduler.request(request(1U, 105U)));
    assert(scheduler.request(request(1U, 110U, 7U, 11U, 1U, NativeScheduledLoopAction::Stop)));
    std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount> events{};
    assert(scheduler.collectDue(100U, 10U, 7U, 11U, events) == 1U);
    assert(events[0].request.trackIndex == 0U);
    assert(events[0].request.action == NativeScheduledLoopAction::Record);
    assert(events[0].frameOffset == 5U);
    assert(!scheduler.cancel(0U, 1U)); // Dispatch wins; cancellation cannot falsely succeed.
    assert(scheduler.status(0U).appliedRevision == 0U);
    scheduler.acknowledgeApplied(0U, 1U, true);
    assert(scheduler.status(0U).appliedRevision == 1U);

    // The block-end frame belongs to the next callback, not this one.
    assert(scheduler.collectDue(110U, 4U, 7U, 11U, events) == 1U);
    assert(events[0].request.trackIndex == 1U);
    assert(events[0].frameOffset == 0U);
    scheduler.acknowledgeApplied(1U, 1U, true);
}

void phaseAndSettingsEpochChangesFailClosed() {
    NativeLoopFrameScheduler scheduler;
    std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount> events{};
    assert(scheduler.request(request(1U, 120U, 7U, 11U, 0U)));
    assert(scheduler.collectDue(100U, 32U, 8U, 11U, events) == 0U);
    auto state = scheduler.status(0U);
    assert(state.faultRevision == 1U);
    assert(state.fault == NativeScheduledLoopFault::StalePhaseEpoch);

    assert(scheduler.request(request(2U, 120U, 8U, 11U, 0U)));
    assert(scheduler.collectDue(100U, 32U, 8U, 12U, events) == 0U);
    state = scheduler.status(0U);
    assert(state.faultRevision == 2U);
    assert(state.fault == NativeScheduledLoopFault::StaleSettingsRevision);
}

void cancellationAndRejectedApplyHaveDistinctAcks() {
    NativeLoopFrameScheduler scheduler;
    std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount> events{};
    assert(scheduler.request(request(1U, 150U)));
    assert(scheduler.cancel(0U, 1U));
    assert(scheduler.collectDue(100U, 64U, 7U, 11U, events) == 0U);
    auto state = scheduler.status(0U);
    assert(state.cancelledRevision == 1U);
    assert(state.appliedRevision == 0U);
    assert(!scheduler.cancel(0U, 1U));

    assert(scheduler.request(request(2U, 105U)));
    assert(scheduler.collectDue(100U, 10U, 7U, 11U, events) == 1U);
    scheduler.acknowledgeApplied(0U, 2U, false);
    state = scheduler.status(0U);
    assert(state.appliedRevision == 0U);
    assert(state.faultRevision == 2U);
    assert(state.fault == NativeScheduledLoopFault::ApplyRejected);
}

void blockedTrackDoesNotLoseItsEventOrLeaveItUnacknowledged() {
    NativeLoopFrameScheduler scheduler;
    std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount> events{};
    assert(scheduler.request(request(1U, 105U)));
    assert(scheduler.collectDue(100U, 10U, 7U, 11U, events, 1U) == 0U);
    assert(scheduler.status(0U).faultRevision == 0U);
    assert(scheduler.status(0U).appliedRevision == 0U);
    // If a blocking pin spans the target, the next eligible callback faults
    // the missed frame instead of silently dropping or retaining it forever.
    assert(scheduler.collectDue(110U, 8U, 7U, 11U, events) == 0U);
    assert(scheduler.status(0U).faultRevision == 1U);
    assert(scheduler.status(0U).fault == NativeScheduledLoopFault::MissedFrame);
}

void stoppingTheCallbackCancelsOutstandingRequests() {
    NativeLoopFrameScheduler scheduler;
    assert(scheduler.request(request(1U, 105U)));
    scheduler.cancelAllStopped();
    const auto state = scheduler.status(0U);
    assert(state.requestedRevision == 1U);
    assert(state.cancelledRevision == 1U);
    assert(state.appliedRevision == 0U);
    assert(scheduler.request(request(2U, 205U)));
}

void stoppingAfterDispatchIsFaultedInsteadOfReportedAsCancelled() {
    NativeLoopFrameScheduler scheduler;
    std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount> events{};
    assert(scheduler.request(request(1U, 105U)));
    assert(scheduler.collectDue(100U, 10U, 7U, 11U, events) == 1U);
    assert(!scheduler.cancel(0U, 1U));
    scheduler.cancelAllStopped();
    const auto state = scheduler.status(0U);
    assert(state.appliedRevision == 0U);
    assert(state.cancelledRevision == 0U);
    assert(state.faultRevision == 1U);
    assert(state.fault == NativeScheduledLoopFault::StoppedAfterDispatch);
}

void lateFramesAndInvalidRequestsDoNotRun() {
    NativeLoopFrameScheduler scheduler;
    std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount> events{};
    assert(!scheduler.request(request(1U, 100U, 7U, 11U, 5U)));
    assert(!scheduler.request(request(0U, 100U)));
    assert(scheduler.request(request(1U, 99U)));
    assert(scheduler.collectDue(100U, 16U, 7U, 11U, events) == 0U);
    const auto state = scheduler.status(0U);
    assert(state.faultRevision == 1U);
    assert(state.fault == NativeScheduledLoopFault::MissedFrame);
}

void looperStartsAndStopsOnTheExactScheduledSample() {
    LooperCore looper(48000U, 1U, 2U);
    assert(looper.prepare(48000U, 1U, 2U));
    NativeLoopFrameScheduler scheduler;
    std::array<NativeScheduledLoopEvent, kNativeScheduledLoopTrackCount> events{};
    assert(scheduler.request(request(1U, 104U)));
    assert(scheduler.collectDue(100U, 16U, 7U, 11U, events) == 1U);

    std::array<float, 32U> input{};
    std::array<float, 32U> output{};
    for (std::size_t frame = 0U; frame < input.size() / 2U; ++frame) {
        input[frame * 2U] = static_cast<float>(frame + 1U);
        input[frame * 2U + 1U] = -static_cast<float>(frame + 1U);
    }
    LooperCommandContext context{&looper, {CommandType::Record}};
    const auto recordStats = looper.process(input.data(), output.data(), 16U, 2U, 2U,
        nullptr, false, nullptr, 0U, applyLooperCommand, &context, events[0].frameOffset);
    assert(recordStats.state == LooperState::Recording);
    assert(looper.metadata().recordedFrames == 12U);
    scheduler.acknowledgeApplied(0U, 1U, recordStats.state == LooperState::Recording);
    assert(scheduler.status(0U).appliedRevision == 1U);

    assert(scheduler.request(request(2U, 126U, 7U, 11U, 0U, NativeScheduledLoopAction::Stop)));
    assert(scheduler.collectDue(116U, 16U, 7U, 11U, events) == 1U);
    context.command = {CommandType::StopRecordOrPlayback};
    const auto stopStats = looper.process(input.data(), output.data(), 16U, 2U, 2U,
        nullptr, false, nullptr, 0U, applyLooperCommand, &context, events[0].frameOffset);
    assert(stopStats.state == LooperState::Stopped);
    assert(looper.metadata().finalizedFrames == 22U);
    std::array<float, 44U> pcm{};
    std::size_t copied = 0U;
    assert(looper.copyFinalizedStereoLoopSnapshot(pcm.data(), 22U, copied));
    assert(copied == 22U);
    assert(pcm[0U] == 5.0f && pcm[1U] == -5.0f);
    scheduler.acknowledgeApplied(0U, 2U, stopStats.state == LooperState::Stopped);
    assert(scheduler.status(0U).appliedRevision == 2U);
}
} // namespace

int main() {
    dueEventsUseExactCallbackOffsetsAndRequireApplyAck();
    phaseAndSettingsEpochChangesFailClosed();
    cancellationAndRejectedApplyHaveDistinctAcks();
    blockedTrackDoesNotLoseItsEventOrLeaveItUnacknowledged();
    stoppingTheCallbackCancelsOutstandingRequests();
    stoppingAfterDispatchIsFaultedInsteadOfReportedAsCancelled();
    lateFramesAndInvalidRequestsDoNotRun();
    looperStartsAndStopsOnTheExactScheduledSample();
    return 0;
}
