#include "native_track_host.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {
namespace {

constexpr std::uint64_t kMaximumCommandFrame = (std::uint64_t{1} << 53U) - 1U;

bool finite(float value) noexcept { return std::isfinite(value); }

} // namespace

bool NativeTrackHost::prepare(std::uint32_t sampleRate,
                              std::uint32_t maxLoopSeconds,
                              std::uint64_t memoryBudgetBytes) {
    if (sampleRate < 8000U || sampleRate > 384000U ||
        maxLoopSeconds == 0U || maxLoopSeconds > 300U) return false;

    std::unique_ptr<MultiTrackLooperCore> candidate;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        candidate = std::make_unique<MultiTrackLooperCore>();
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif
    if (!candidate->prepare(sampleRate, kNativeTrackHostQuantumFrames, memoryBudgetBytes)) return false;
    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        if (!candidate->prepareTrackBuffer(track, maxLoopSeconds)) return false;
    }

    core_ = std::move(candidate);
    nextFrame_.store(0U, std::memory_order_relaxed);
    lastQueuedFrame_ = 0U;
    hasQueuedFrame_ = false;
    preparedHistoryBytes_.store(core_->preparedHistoryBytes(), std::memory_order_relaxed);
    tempoBpm_.store(120.0, std::memory_order_relaxed);
    lastProcessFrames_.store(0U, std::memory_order_relaxed);
    lastProcessLateCommands_.store(0U, std::memory_order_relaxed);
    lastProcessDroppedCommands_.store(0U, std::memory_order_relaxed);
    lastProcessInputPeak_.store(0.0f, std::memory_order_relaxed);
    lastProcessOutputPeak_.store(0.0f, std::memory_order_relaxed);
    lastProcessActiveTracks_.store(0U, std::memory_order_relaxed);
    lastProcessRecordingTracks_.store(0U, std::memory_order_relaxed);
    publishTrackStatuses();
    return true;
}

bool NativeTrackHost::processInputBlock(const float* inputInterleaved,
                                       std::uint32_t inputChannels,
                                       float* outputInterleavedStereo,
                                       std::uint32_t frames,
                                       MultiTrackProcessStats* stats) noexcept {
    if (!core_ || outputInterleavedStereo == nullptr || frames > kNativeTrackHostMaximumCallbackFrames ||
        inputChannels == 0U || inputChannels > 2U) {
        if (outputInterleavedStereo != nullptr && frames <= kNativeTrackHostMaximumCallbackFrames) {
            std::fill_n(outputInterleavedStereo, static_cast<std::size_t>(frames) * 2U, 0.0f);
        }
        return false;
    }

    MultiTrackProcessStats total{};
    total.frames = frames;
    auto frame = nextFrame_.load(std::memory_order_relaxed);
    std::uint32_t offset = 0U;
    while (offset < frames) {
        const auto chunk = std::min(kNativeTrackHostQuantumFrames, frames - offset);
        for (std::uint32_t index = 0U; index < chunk; ++index) {
            const auto sourceFrame = static_cast<std::size_t>(offset + index);
            float left = 0.0f;
            float right = 0.0f;
            if (inputInterleaved != nullptr) {
                const auto inputIndex = sourceFrame * inputChannels;
                left = inputInterleaved[inputIndex];
                right = inputChannels == 2U ? inputInterleaved[inputIndex + 1U] : left;
            }
            inputScratch_[static_cast<std::size_t>(index) * 2U] = left;
            inputScratch_[static_cast<std::size_t>(index) * 2U + 1U] = right;
        }

        MultiTrackProcessStats part{};
        if (!core_->processBlock(inputScratch_.data(), outputScratch_.data(), chunk, frame, &part)) {
            std::fill_n(outputInterleavedStereo, static_cast<std::size_t>(frames) * 2U, 0.0f);
            return false;
        }
        const auto destinationOffset = static_cast<std::size_t>(offset) * 2U;
        std::copy_n(outputScratch_.data(), static_cast<std::size_t>(chunk) * 2U,
                    outputInterleavedStereo + destinationOffset);
        total.activeTracks = std::max(total.activeTracks, part.activeTracks);
        total.recordingTracks = std::max(total.recordingTracks, part.recordingTracks);
        total.lateCommands += part.lateCommands;
        total.droppedCommands = part.droppedCommands;
        total.inputPeak = std::max(total.inputPeak, part.inputPeak);
        total.outputPeak = std::max(total.outputPeak, part.outputPeak);
        frame += chunk;
        offset += chunk;
    }

    nextFrame_.store(frame, std::memory_order_release);
    lastProcessFrames_.store(total.frames, std::memory_order_relaxed);
    lastProcessLateCommands_.store(total.lateCommands, std::memory_order_relaxed);
    lastProcessDroppedCommands_.store(total.droppedCommands, std::memory_order_relaxed);
    lastProcessInputPeak_.store(total.inputPeak, std::memory_order_relaxed);
    lastProcessOutputPeak_.store(total.outputPeak, std::memory_order_relaxed);
    lastProcessActiveTracks_.store(total.activeTracks, std::memory_order_relaxed);
    lastProcessRecordingTracks_.store(total.recordingTracks, std::memory_order_relaxed);
    publishTrackStatuses();
    if (stats != nullptr) *stats = total;
    return true;
}

bool NativeTrackHost::postTrackCommand(const TrackCommand& command) noexcept {
    std::lock_guard<std::mutex> lock(commandProducerMutex_);
    if (!core_ || command.absoluteFrame > kMaximumCommandFrame) return false;
    if (hasQueuedFrame_ && command.absoluteFrame < lastQueuedFrame_) return false;
    if (!core_->postCommand(command)) return false;
    lastQueuedFrame_ = command.absoluteFrame;
    hasQueuedFrame_ = true;
    return true;
}

bool NativeTrackHost::queue(TrackCommandType type, std::uint8_t trackIndex,
                            float value, bool boolValue) noexcept {
    std::lock_guard<std::mutex> lock(commandProducerMutex_);
    if (!core_ || trackIndex >= kNativeTrackCount || !finite(value)) return false;
    const auto current = nextFrame_.load(std::memory_order_acquire);
    if (current > kMaximumCommandFrame - kNativeTrackHostQuantumFrames) return false;
    const auto commandFrame = std::max(current + kNativeTrackHostQuantumFrames,
        hasQueuedFrame_ ? lastQueuedFrame_ : std::uint64_t{0});
    if (!core_->postCommand({commandFrame, type, trackIndex, boolValue, value})) return false;
    lastQueuedFrame_ = commandFrame;
    hasQueuedFrame_ = true;
    return true;
}

bool NativeTrackHost::record(std::uint8_t trackIndex) noexcept {
    return queue(TrackCommandType::Record, trackIndex);
}
bool NativeTrackHost::stop(std::uint8_t trackIndex) noexcept {
    return queue(TrackCommandType::Stop, trackIndex);
}
bool NativeTrackHost::play(std::uint8_t trackIndex) noexcept {
    return queue(TrackCommandType::Play, trackIndex);
}
bool NativeTrackHost::toggleOverdub(std::uint8_t trackIndex) noexcept {
    return queue(TrackCommandType::ToggleOverdub, trackIndex);
}
bool NativeTrackHost::clear(std::uint8_t trackIndex) noexcept {
    return queue(TrackCommandType::ClearTrack, trackIndex);
}
bool NativeTrackHost::setInputRoute(std::uint8_t trackIndex, bool enabled) noexcept {
    return queue(TrackCommandType::SetTrackInputRoute, trackIndex, 0.0f, enabled);
}
bool NativeTrackHost::setGain(std::uint8_t trackIndex, float gain) noexcept {
    return queue(TrackCommandType::SetTrackGain, trackIndex, gain);
}
bool NativeTrackHost::setPan(std::uint8_t trackIndex, float pan) noexcept {
    return queue(TrackCommandType::SetTrackPan, trackIndex, pan);
}
bool NativeTrackHost::setMute(std::uint8_t trackIndex, bool muted) noexcept {
    return queue(TrackCommandType::SetTrackMute, trackIndex, 0.0f, muted);
}
bool NativeTrackHost::setSolo(std::uint8_t trackIndex, bool solo) noexcept {
    return queue(TrackCommandType::SetTrackSolo, trackIndex, 0.0f, solo);
}
bool NativeTrackHost::setTempo(double bpm) noexcept {
    if (!core_ || !std::isfinite(bpm) || bpm < 20.0 || bpm > 300.0) return false;
    return queue(TrackCommandType::SetTempoBpm, 0U, static_cast<float>(bpm));
}
bool NativeTrackHost::setMonitor(bool enabled) noexcept {
    return queue(TrackCommandType::SetInputMonitor, 0U, 0.0f, enabled);
}

void NativeTrackHost::publishTrackStatuses() noexcept {
    if (!core_) return;
    tempoBpm_.store(core_->tempoBpm(), std::memory_order_relaxed);
    for (std::uint8_t index = 0U; index < kNativeTrackCount; ++index) {
        auto& published = publishedTracks_[index];
        const auto sequence = published.sequence.load(std::memory_order_relaxed);
        published.sequence.store(sequence + 1U, std::memory_order_release);
        const auto current = core_->trackStatus(index);
        published.state.store(static_cast<std::uint8_t>(current.state), std::memory_order_relaxed);
        published.recordedFrames.store(current.recordedFrames, std::memory_order_relaxed);
        published.loopFrames.store(current.loopFrames, std::memory_order_relaxed);
        published.playhead.store(current.playhead, std::memory_order_relaxed);
        published.gain.store(current.gain, std::memory_order_relaxed);
        published.pan.store(current.pan, std::memory_order_relaxed);
        published.muted.store(current.muted, std::memory_order_relaxed);
        published.solo.store(current.solo, std::memory_order_relaxed);
        published.inputRouted.store(current.inputRouted, std::memory_order_relaxed);
        published.bufferPrepared.store(current.bufferPrepared, std::memory_order_relaxed);
        published.sequence.store(sequence + 2U, std::memory_order_release);
    }
}

NativeTrackHostStatus NativeTrackHost::status() const noexcept {
    NativeTrackHostStatus result{};
    result.nextFrame = nextFrame_.load(std::memory_order_acquire);
    result.preparedHistoryBytes = preparedHistoryBytes_.load(std::memory_order_relaxed);
    result.tempoBpm = tempoBpm_.load(std::memory_order_acquire);
    result.lastProcess.frames = static_cast<std::uint32_t>(lastProcessFrames_.load(std::memory_order_relaxed));
    result.lastProcess.lateCommands = lastProcessLateCommands_.load(std::memory_order_relaxed);
    result.lastProcess.droppedCommands = lastProcessDroppedCommands_.load(std::memory_order_relaxed);
    result.lastProcess.inputPeak = lastProcessInputPeak_.load(std::memory_order_relaxed);
    result.lastProcess.outputPeak = lastProcessOutputPeak_.load(std::memory_order_relaxed);
    result.lastProcess.activeTracks = lastProcessActiveTracks_.load(std::memory_order_relaxed);
    result.lastProcess.recordingTracks = lastProcessRecordingTracks_.load(std::memory_order_relaxed);

    for (std::size_t index = 0U; index < result.tracks.size(); ++index) {
        const auto& published = publishedTracks_[index];
        TrackStatus snapshot{};
        for (unsigned int attempt = 0U; attempt < 3U; ++attempt) {
            const auto before = published.sequence.load(std::memory_order_acquire);
            if ((before & 1U) != 0U) continue;
            snapshot.state = static_cast<TrackPlaybackState>(published.state.load(std::memory_order_relaxed));
            snapshot.recordedFrames = published.recordedFrames.load(std::memory_order_relaxed);
            snapshot.loopFrames = published.loopFrames.load(std::memory_order_relaxed);
            snapshot.playhead = published.playhead.load(std::memory_order_relaxed);
            snapshot.gain = published.gain.load(std::memory_order_relaxed);
            snapshot.pan = published.pan.load(std::memory_order_relaxed);
            snapshot.muted = published.muted.load(std::memory_order_relaxed);
            snapshot.solo = published.solo.load(std::memory_order_relaxed);
            snapshot.inputRouted = published.inputRouted.load(std::memory_order_relaxed);
            snapshot.bufferPrepared = published.bufferPrepared.load(std::memory_order_relaxed);
            if (published.sequence.load(std::memory_order_acquire) == before) break;
        }
        result.tracks[index] = snapshot;
    }
    return result;
}

} // namespace webrc::native
