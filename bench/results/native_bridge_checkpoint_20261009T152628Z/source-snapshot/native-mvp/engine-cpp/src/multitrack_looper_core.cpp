#include "multitrack_looper_core.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>
#include <utility>

namespace webrc::native {
namespace {

constexpr std::uint64_t kMaximumTimelineFrame = (std::uint64_t{1} << 53U) - 1U;
constexpr float kMinimumGain = 0.0f;
constexpr float kMaximumGain = 2.0f;
constexpr float kMinimumPan = -1.0f;
constexpr float kMaximumPan = 1.0f;
constexpr float kMinimumTempo = 20.0f;
constexpr float kMaximumTempo = 300.0f;
constexpr float kParameterSmoothingMs = 10.0f;
constexpr double kPi = 3.14159265358979323846264338327950288;

bool finite(float value) noexcept {
    return std::isfinite(value);
}

void setLinearRamp(float current, float targetValue, float& target,
                   float& step, std::uint32_t& remaining,
                   std::uint32_t rampFrames) noexcept {
    if (target == targetValue) return;
    target = targetValue;
    remaining = std::max(1U, rampFrames);
    step = (target - current) / static_cast<float>(remaining);
}

float advanceLinearRamp(float& current, float target, float step,
                        std::uint32_t& remaining) noexcept {
    if (remaining == 0U) return current;
    current += step;
    --remaining;
    if (remaining == 0U) current = target;
    return current;
}

webrc::dsp::StereoFrame panStereoFrame(webrc::dsp::StereoFrame input,
                                       float position) noexcept {
    const auto pan = static_cast<double>(std::clamp(position, -1.0f, 1.0f));
    if (pan < 0.0) {
        const auto angle = (pan + 1.0) * kPi * 0.5;
        return {
            webrc::dsp::sanitize(input.left + static_cast<float>(std::cos(angle)) * input.right),
            webrc::dsp::sanitize(static_cast<float>(std::sin(angle)) * input.right),
        };
    }
    const auto angle = pan * kPi * 0.5;
    return {
        webrc::dsp::sanitize(static_cast<float>(std::cos(angle)) * input.left),
        webrc::dsp::sanitize(input.right + static_cast<float>(std::sin(angle)) * input.left),
    };
}

} // namespace

std::uint64_t MultiTrackLooperCore::requiredTrackBufferBytes(
    std::uint32_t sampleRate, std::uint32_t maxLoopSeconds) noexcept {
    if (sampleRate < 8000U || sampleRate > 384000U || maxLoopSeconds == 0U || maxLoopSeconds > 300U) {
        return 0;
    }
    const std::uint64_t frames = static_cast<std::uint64_t>(sampleRate) * maxLoopSeconds;
    constexpr std::uint64_t kBytesPerFrame = 2U * sizeof(float);
    if (frames > std::numeric_limits<std::uint64_t>::max() / kBytesPerFrame) return 0;
    const auto bytes = frames * kBytesPerFrame;
    return bytes <= static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max()) ? bytes : 0;
}

bool MultiTrackLooperCore::prepare(std::uint32_t sampleRate,
                                   std::uint32_t maxBlockFrames,
                                   std::uint64_t memoryBudgetBytes) noexcept {
    if (prepared_ || sampleRate < 8000U || sampleRate > 384000U ||
        maxBlockFrames == 0U || maxBlockFrames > 64U) {
        return false;
    }
    sampleRate_ = sampleRate;
    maxBlockFrames_ = maxBlockFrames;
    memoryBudgetBytes_ = memoryBudgetBytes;
    const webrc::dsp::ProcessSpec smootherSpec{static_cast<float>(sampleRate), maxBlockFrames, 2U};
    for (auto& track : tracks_) {
        if (!track.gainSmoother.prepare(smootherSpec) || !track.panSmoother.prepare(smootherSpec)) {
            return false;
        }
        track.gainSmoother.reset(1.0f);
        track.panSmoother.reset(0.0f);
        track.gateTargetAudible = true;
        track.gateCurrent = 1.0f;
        track.gateTarget = 1.0f;
        track.gateStep = 0.0f;
        track.gateRemaining = 0U;
    }
    commandRead_.store(0U, std::memory_order_relaxed);
    commandWrite_.store(0U, std::memory_order_relaxed);
    droppedCommandCount_.store(0U, std::memory_order_relaxed);
    hasPostedFrame_ = false;
    hasExpectedFrame_ = false;
    monitorCurrent_ = 0.0f;
    monitorTarget_ = 0.0f;
    monitorStep_ = 0.0f;
    monitorRemaining_ = 0U;
    anySolo_ = false;
    tempoBpm_ = 120.0;
    lateCommandCount_ = 0;
    historyBytes_ = 0;
    prepared_ = true;
    return true;
}

bool MultiTrackLooperCore::prepareTrackBuffer(std::uint8_t trackIndex,
                                              std::uint32_t maxLoopSeconds) noexcept {
    if (!prepared_ || trackIndex >= tracks_.size()) return false;
    auto& track = tracks_[trackIndex];
    if (!track.historyInterleaved.empty() || track.state != TrackPlaybackState::Empty) return false;
    const auto bytes = requiredTrackBufferBytes(sampleRate_, maxLoopSeconds);
    if (bytes == 0U || bytes / sizeof(float) > std::numeric_limits<std::size_t>::max()) return false;
    if (memoryBudgetBytes_ != 0U &&
        (historyBytes_ > memoryBudgetBytes_ || bytes > memoryBudgetBytes_ - historyBytes_)) return false;

    std::vector<float> candidate;
    try {
        candidate.assign(static_cast<std::size_t>(bytes / sizeof(float)), 0.0f);
    } catch (const std::bad_alloc&) {
        return false;
    } catch (...) {
        return false;
    }
    track.historyInterleaved = std::move(candidate);
    track.maxLoopSeconds = maxLoopSeconds;
    historyBytes_ += bytes;
    return true;
}

std::uint64_t MultiTrackLooperCore::preparedHistoryBytes() const noexcept {
    return historyBytes_;
}

bool MultiTrackLooperCore::validateCommand(const TrackCommand& command) const noexcept {
    switch (command.type) {
    case TrackCommandType::Record:
    case TrackCommandType::Stop:
    case TrackCommandType::Play:
    case TrackCommandType::ToggleOverdub:
    case TrackCommandType::ClearTrack:
    case TrackCommandType::SetTrackInputRoute:
    case TrackCommandType::SetTrackGain:
    case TrackCommandType::SetTrackPan:
    case TrackCommandType::SetTrackMute:
    case TrackCommandType::SetTrackSolo:
        if (command.trackIndex >= tracks_.size()) return false;
        break;
    case TrackCommandType::ClearAll:
    case TrackCommandType::SetInputMonitor:
        break;
    case TrackCommandType::SetTempoBpm:
        if (!finite(command.value) || command.value < kMinimumTempo || command.value > kMaximumTempo) return false;
        break;
    default:
        return false;
    }

    switch (command.type) {
    case TrackCommandType::Record:
        return !tracks_[command.trackIndex].historyInterleaved.empty();
    case TrackCommandType::SetTrackGain:
        return finite(command.value) && command.value >= kMinimumGain && command.value <= kMaximumGain;
    case TrackCommandType::SetTrackPan:
        return finite(command.value) && command.value >= kMinimumPan && command.value <= kMaximumPan;
    default:
        return true;
    }
}

bool MultiTrackLooperCore::postCommand(const TrackCommand& command) noexcept {
    if (!prepared_ || !validateCommand(command) || command.absoluteFrame > kMaximumTimelineFrame) return false;
    std::lock_guard<std::mutex> lock(commandProducerMutex_);
    if (hasPostedFrame_ && command.absoluteFrame < lastPostedFrame_) return false;

    const auto write = commandWrite_.load(std::memory_order_relaxed);
    const auto next = (write + 1U) % commands_.size();
    if (next == commandRead_.load(std::memory_order_acquire)) {
        droppedCommandCount_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    commands_[write] = command;
    commandWrite_.store(next, std::memory_order_release);
    lastPostedFrame_ = command.absoluteFrame;
    hasPostedFrame_ = true;
    return true;
}

bool MultiTrackLooperCore::tryPeekCommand(TrackCommand& command) const noexcept {
    const auto read = commandRead_.load(std::memory_order_relaxed);
    if (read == commandWrite_.load(std::memory_order_acquire)) return false;
    command = commands_[read];
    return true;
}

void MultiTrackLooperCore::popCommand() noexcept {
    const auto read = commandRead_.load(std::memory_order_relaxed);
    commandRead_.store((read + 1U) % commands_.size(), std::memory_order_release);
}

void MultiTrackLooperCore::clearTrack(Track& track) noexcept {
    // History is left untouched. A zero published length makes old samples
    // unreachable, and a subsequent record overwrites every sample before use.
    if (track.state == TrackPlaybackState::Playing || track.state == TrackPlaybackState::Overdubbing) {
        track.hasTail = true;
        track.gateTargetAudible = false;
        setLinearRamp(track.gateCurrent, 0.0f, track.gateTarget,
                      track.gateStep, track.gateRemaining,
                      static_cast<std::uint32_t>(std::ceil(sampleRate_ * kParameterSmoothingMs / 1000.0f)));
    }
    track.writeFrame = 0;
    track.loopFrames = 0;
    track.playhead = 0;
    track.state = TrackPlaybackState::Empty;
}

void MultiTrackLooperCore::finalizeTrack(Track& track) noexcept {
    track.loopFrames = track.writeFrame;
    track.playhead = 0;
    track.state = track.loopFrames > 0U ? TrackPlaybackState::Stopped : TrackPlaybackState::Empty;
}

void MultiTrackLooperCore::applyCommand(const TrackCommand& command) noexcept {
    if (command.type == TrackCommandType::ClearAll) {
        for (auto& track : tracks_) clearTrack(track);
        return;
    }
    if (command.type == TrackCommandType::SetInputMonitor) {
        setLinearRamp(monitorCurrent_, command.boolValue ? 1.0f : 0.0f,
                      monitorTarget_, monitorStep_, monitorRemaining_,
                      static_cast<std::uint32_t>(std::ceil(sampleRate_ * kParameterSmoothingMs / 1000.0f)));
        return;
    }
    if (command.type == TrackCommandType::SetTempoBpm) {
        tempoBpm_ = command.value;
        return;
    }

    auto& track = tracks_[command.trackIndex];
    switch (command.type) {
    case TrackCommandType::Record:
        if (track.historyInterleaved.empty()) return;
        if (track.state == TrackPlaybackState::Playing || track.state == TrackPlaybackState::Overdubbing) {
            track.hasTail = true;
            track.gateTargetAudible = false;
            setLinearRamp(track.gateCurrent, 0.0f, track.gateTarget,
                          track.gateStep, track.gateRemaining,
                          static_cast<std::uint32_t>(std::ceil(sampleRate_ * kParameterSmoothingMs / 1000.0f)));
        }
        track.writeFrame = 0;
        track.loopFrames = 0;
        track.playhead = 0;
        track.state = TrackPlaybackState::Recording;
        break;
    case TrackCommandType::Stop:
        if (track.state == TrackPlaybackState::Recording) {
            finalizeTrack(track);
        } else if (track.state == TrackPlaybackState::Playing ||
                   track.state == TrackPlaybackState::Overdubbing) {
            track.hasTail = true;
            track.gateTargetAudible = false;
            setLinearRamp(track.gateCurrent, 0.0f, track.gateTarget,
                          track.gateStep, track.gateRemaining,
                          static_cast<std::uint32_t>(std::ceil(sampleRate_ * kParameterSmoothingMs / 1000.0f)));
            track.playhead = 0;
            track.state = TrackPlaybackState::Stopped;
        }
        break;
    case TrackCommandType::Play:
        if (track.state == TrackPlaybackState::Stopped && track.loopFrames > 0U) {
            track.playhead = 0;
            track.state = TrackPlaybackState::Playing;
            track.hasTail = false;
        }
        break;
    case TrackCommandType::ToggleOverdub:
        if (track.state == TrackPlaybackState::Playing) {
            track.state = TrackPlaybackState::Overdubbing;
        } else if (track.state == TrackPlaybackState::Overdubbing) {
            track.state = TrackPlaybackState::Playing;
        }
        break;
    case TrackCommandType::ClearTrack:
        clearTrack(track);
        break;
    case TrackCommandType::SetTrackInputRoute:
        track.inputRouted = command.boolValue;
        break;
    case TrackCommandType::SetTrackGain:
        track.defaultGain = command.value;
        (void)track.gainSmoother.setTarget(command.value, kParameterSmoothingMs);
        break;
    case TrackCommandType::SetTrackPan:
        track.defaultPan = command.value;
        (void)track.panSmoother.setTarget(command.value, kParameterSmoothingMs);
        break;
    case TrackCommandType::SetTrackMute:
        track.muted = command.boolValue;
        break;
    case TrackCommandType::SetTrackSolo:
        track.solo = command.boolValue;
        anySolo_ = false;
        for (const auto& candidate : tracks_) anySolo_ = anySolo_ || candidate.solo;
        break;
    case TrackCommandType::ClearAll:
    case TrackCommandType::SetInputMonitor:
    case TrackCommandType::SetTempoBpm:
        break;
    }
}

void MultiTrackLooperCore::applyDueCommands(std::uint64_t frame,
                                            std::uint32_t& commandBudget,
                                            MultiTrackProcessStats& stats) noexcept {
    TrackCommand command{};
    while (commandBudget > 0U && tryPeekCommand(command) && command.absoluteFrame <= frame) {
        if (command.absoluteFrame < frame) {
            ++lateCommandCount_;
            ++stats.lateCommands;
        }
        applyCommand(command);
        popCommand();
        --commandBudget;
    }
}

bool MultiTrackLooperCore::processBlock(const float* inputInterleavedStereo,
                                        float* outputInterleavedStereo,
                                        std::uint32_t frames,
                                        std::uint64_t absoluteStartFrame,
                                        MultiTrackProcessStats* stats) noexcept {
    if (!prepared_ || outputInterleavedStereo == nullptr || frames > maxBlockFrames_ ||
        absoluteStartFrame > kMaximumTimelineFrame || frames > kMaximumTimelineFrame - absoluteStartFrame) {
        if (outputInterleavedStereo != nullptr && frames <= maxBlockFrames_) {
            std::fill_n(outputInterleavedStereo, static_cast<std::size_t>(frames) * 2U, 0.0f);
        }
        return false;
    }
    if (hasExpectedFrame_ && absoluteStartFrame != expectedFrame_) {
        std::fill_n(outputInterleavedStereo, static_cast<std::size_t>(frames) * 2U, 0.0f);
        return false;
    }
    if (frames == 0U) {
        if (!hasExpectedFrame_) {
            expectedFrame_ = absoluteStartFrame;
            hasExpectedFrame_ = true;
        }
        if (stats != nullptr) *stats = {};
        return true;
    }

    MultiTrackProcessStats localStats{};
    localStats.frames = frames;
    std::uint32_t commandBudget = static_cast<std::uint32_t>(kTrackCommandCapacity);
    for (std::uint32_t offset = 0; offset < frames; ++offset) {
        const auto frame = absoluteStartFrame + offset;
        applyDueCommands(frame, commandBudget, localStats);
        std::uint32_t activeTracksNow = 0;
        std::uint32_t recordingTracksNow = 0;
        const float inputLeft = inputInterleavedStereo == nullptr
            ? 0.0f : webrc::dsp::sanitize(inputInterleavedStereo[static_cast<std::size_t>(offset) * 2U]);
        const float inputRight = inputInterleavedStereo == nullptr
            ? 0.0f : webrc::dsp::sanitize(inputInterleavedStereo[static_cast<std::size_t>(offset) * 2U + 1U]);
        localStats.inputPeak = std::max(localStats.inputPeak, std::max(std::abs(inputLeft), std::abs(inputRight)));

        const float monitor = advanceLinearRamp(monitorCurrent_, monitorTarget_,
                                                monitorStep_, monitorRemaining_);
        float mixLeft = inputLeft * monitor;
        float mixRight = inputRight * monitor;
        for (auto& track : tracks_) {
            const bool recordInput = track.state == TrackPlaybackState::Recording;
            if (recordInput) {
                const auto frameCapacity = static_cast<std::uint64_t>(track.historyInterleaved.size() / 2U);
                if (track.writeFrame < frameCapacity) {
                    const auto sampleIndex = static_cast<std::size_t>(track.writeFrame) * 2U;
                    track.historyInterleaved[sampleIndex] = track.inputRouted ? inputLeft : 0.0f;
                    track.historyInterleaved[sampleIndex + 1U] = track.inputRouted ? inputRight : 0.0f;
                    ++track.writeFrame;
                }
                if (track.writeFrame >= frameCapacity) finalizeTrack(track);
            }

            float sourceLeft = 0.0f;
            float sourceRight = 0.0f;
            const bool hasLoopPlayback =
                (track.state == TrackPlaybackState::Playing || track.state == TrackPlaybackState::Overdubbing) &&
                track.loopFrames > 0U;
            if (hasLoopPlayback) {
                const auto sampleIndex = static_cast<std::size_t>(track.playhead) * 2U;
                sourceLeft = track.historyInterleaved[sampleIndex];
                sourceRight = track.historyInterleaved[sampleIndex + 1U];
                if (track.state == TrackPlaybackState::Overdubbing && track.inputRouted) {
                    sourceLeft = webrc::dsp::sanitize(sourceLeft + inputLeft);
                    sourceRight = webrc::dsp::sanitize(sourceRight + inputRight);
                    track.historyInterleaved[sampleIndex] = sourceLeft;
                    track.historyInterleaved[sampleIndex + 1U] = sourceRight;
                }
                track.playhead = (track.playhead + 1U) % track.loopFrames;
                track.lastLeft = sourceLeft;
                track.lastRight = sourceRight;
                track.hasTail = false;
                ++activeTracksNow;
            }

            const bool audible = hasLoopPlayback && !track.muted && (!anySolo_ || track.solo);
            if (audible != track.gateTargetAudible) {
                track.gateTargetAudible = audible;
                setLinearRamp(track.gateCurrent, audible ? 1.0f : 0.0f,
                              track.gateTarget, track.gateStep, track.gateRemaining,
                              static_cast<std::uint32_t>(std::ceil(sampleRate_ * kParameterSmoothingMs / 1000.0f)));
            }
            float gatedLeft = sourceLeft;
            float gatedRight = sourceRight;
            if (!hasLoopPlayback && track.hasTail) {
                gatedLeft = track.lastLeft;
                gatedRight = track.lastRight;
            }
            const auto gain = track.gainSmoother.next();
            const auto panned = panStereoFrame({gatedLeft, gatedRight}, track.panSmoother.next());
            const auto gate = advanceLinearRamp(track.gateCurrent, track.gateTarget,
                                                track.gateStep, track.gateRemaining);
            mixLeft += panned.left * gain * gate;
            mixRight += panned.right * gain * gate;
            if (!hasLoopPlayback && track.hasTail && gate < 0.0001f) track.hasTail = false;
            if (track.state == TrackPlaybackState::Recording) ++recordingTracksNow;
        }
        localStats.activeTracks = std::max(localStats.activeTracks, activeTracksNow);
        localStats.recordingTracks = std::max(localStats.recordingTracks, recordingTracksNow);
        const float outputLeft = webrc::dsp::sanitize(mixLeft);
        const float outputRight = webrc::dsp::sanitize(mixRight);
        outputInterleavedStereo[static_cast<std::size_t>(offset) * 2U] = outputLeft;
        outputInterleavedStereo[static_cast<std::size_t>(offset) * 2U + 1U] = outputRight;
        localStats.outputPeak = std::max(localStats.outputPeak, std::max(std::abs(outputLeft), std::abs(outputRight)));
    }

    expectedFrame_ = absoluteStartFrame + frames;
    hasExpectedFrame_ = true;
    localStats.droppedCommands = droppedCommandCount_.load(std::memory_order_relaxed);
    if (stats != nullptr) *stats = localStats;
    return true;
}

TrackStatus MultiTrackLooperCore::trackStatus(std::uint8_t trackIndex) const noexcept {
    if (trackIndex >= tracks_.size()) return {};
    const auto& track = tracks_[trackIndex];
    return {track.state, track.writeFrame, track.loopFrames, track.playhead,
            track.gainSmoother.current(), track.panSmoother.current(), track.muted,
            track.solo, track.inputRouted, !track.historyInterleaved.empty()};
}

} // namespace webrc::native
