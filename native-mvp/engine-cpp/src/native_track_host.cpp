#include "native_track_host.hpp"
#include "webrc/dsp/cleanroom_rhythm_data.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {
namespace {

constexpr std::uint64_t kMaximumCommandFrame = (std::uint64_t{1} << 53U) - 1U;

bool finite(float value) noexcept { return std::isfinite(value); }

} // namespace

std::uint64_t NativeTrackHost::requiredFixedMemoryBytes() noexcept {
    // This includes the host's fixed callback scratch/event storage plus the
    // separately allocated looper-core and rhythm renderer objects. Rhythm
    // state is fully static after construction; its object bytes are included
    // here once, while prepared loop history and FX state are separate ledger
    // entries.
    return static_cast<std::uint64_t>(sizeof(NativeTrackHost)) +
           static_cast<std::uint64_t>(sizeof(MultiTrackLooperCore)) +
           static_cast<std::uint64_t>(sizeof(webrc::dsp::RhythmRenderer));
}

std::uint64_t NativeTrackHost::candidateFxGraphBudgetBytes() const noexcept {
    if (!core_ || !fxGraphExchange_.canStageCandidate()) return 0U;
    const auto aggregate = aggregateMemoryBudgetBytes_.load(std::memory_order_acquire);
    const auto fixed = preparedFixedBytes_.load(std::memory_order_relaxed);
    const auto history = preparedHistoryBytes_.load(std::memory_order_relaxed);
    const auto graph = fxGraphExchange_.residentGraphBytes();
    if (fixed > aggregate || history > aggregate - fixed ||
        graph > aggregate - fixed - history)
        return 0U;
    return aggregate - fixed - history - graph;
}

bool NativeTrackHost::prepare(std::uint32_t sampleRate,
                              std::uint32_t maxLoopSeconds,
                              std::uint64_t memoryBudgetBytes) {
    // Reprepare is deliberately rejected: it would retire audio-owned state
    // without a stopped-host handoff. A failed first prepare leaves the host
    // unprepared; a repeated prepare leaves the working instance untouched.
    if (core_ || sampleRate < 8000U || sampleRate > 384000U ||
        maxLoopSeconds == 0U || maxLoopSeconds > 300U) return false;

    const auto aggregateBudget = memoryBudgetBytes == 0U
        ? kDefaultNativeAudioAggregateMemoryBudgetBytes : memoryBudgetBytes;
    const auto fixedBytes = requiredFixedMemoryBytes();
    if (aggregateBudget <= fixedBytes) return false;

    std::unique_ptr<MultiTrackLooperCore> candidate;
    std::unique_ptr<webrc::dsp::RhythmRenderer> rhythmCandidate;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        candidate = std::make_unique<MultiTrackLooperCore>();
        rhythmCandidate = std::make_unique<webrc::dsp::RhythmRenderer>();
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif
    if (!candidate->prepare(sampleRate, kNativeTrackHostQuantumFrames,
                            aggregateBudget - fixedBytes)) return false;
    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        if (!candidate->prepareTrackBuffer(track, maxLoopSeconds)) return false;
    }
    const webrc::dsp::ProcessSpec rhythmSpec{
        static_cast<float>(sampleRate), kNativeTrackHostQuantumFrames, 2U};
    if (!rhythmCandidate->prepare(rhythmSpec, 120.0) ||
        !rhythmCandidate->setPattern(webrc::dsp::cleanRoomRhythmPattern(0U)) ||
        !rhythmCandidate->setKit(0U)) return false;

    core_ = std::move(candidate);
    rhythmRenderer_ = std::move(rhythmCandidate);
    sampleRate_ = sampleRate;
    nextFrame_.store(0U, std::memory_order_relaxed);
    lastQueuedFrame_ = 0U;
    hasQueuedFrame_ = false;
    rhythmCommandWrite_.store(0U, std::memory_order_relaxed);
    rhythmCommandRead_.store(0U, std::memory_order_relaxed);
    lastRhythmCommandFrame_ = 0U;
    hasRhythmCommandFrame_ = false;
    rejectedRhythmCommands_.store(0U, std::memory_order_relaxed);
    lateRhythmCommands_.store(0U, std::memory_order_relaxed);
    rhythmFaultCount_.store(0U, std::memory_order_relaxed);
    lastRhythmFaultFrame_.store(0U, std::memory_order_relaxed);
    rhythmPreparedPublished_.store(true, std::memory_order_release);
    rhythmPlayingPublished_.store(false, std::memory_order_relaxed);
    rhythmPatternIndexPublished_.store(0U, std::memory_order_relaxed);
    rhythmKitIndexPublished_.store(0U, std::memory_order_relaxed);
    rhythmVariationPublished_.store(0U, std::memory_order_relaxed);
    rhythmSectionPublished_.store(static_cast<std::uint8_t>(
        webrc::dsp::RhythmSection::Stopped), std::memory_order_relaxed);
    rhythmActiveVoicesPublished_.store(0U, std::memory_order_relaxed);
    rhythmCompletedBarsPublished_.store(0U, std::memory_order_relaxed);
    rhythmTriggeredEventsPublished_.store(0U, std::memory_order_relaxed);
    rhythmLastTriggeredFramePublished_.store(0U, std::memory_order_relaxed);
    rhythmTempoBpmPublished_.store(120.0, std::memory_order_relaxed);
    rhythmTempoTargetBpmPublished_.store(120.0, std::memory_order_relaxed);
    rhythmVolumeCurrent_ = 1.0f;
    rhythmVolumeTarget_ = 1.0f;
    rhythmVolumeStep_ = 0.0f;
    rhythmVolumeRemaining_ = 0U;
    rhythmVolumePublished_.store(1.0f, std::memory_order_relaxed);
    rhythmVolumeTargetPublished_.store(1.0f, std::memory_order_relaxed);
    preparedHistoryBytes_.store(core_->preparedHistoryBytes(), std::memory_order_relaxed);
    aggregateMemoryBudgetBytes_.store(aggregateBudget, std::memory_order_release);
    preparedFixedBytes_.store(fixedBytes, std::memory_order_relaxed);
    tempoBpm_.store(120.0, std::memory_order_relaxed);
    lastProcessFrames_.store(0U, std::memory_order_relaxed);
    lastProcessLateCommands_.store(0U, std::memory_order_relaxed);
    lastProcessDroppedCommands_.store(0U, std::memory_order_relaxed);
    lastProcessInputPeak_.store(0.0f, std::memory_order_relaxed);
    lastProcessOutputPeak_.store(0.0f, std::memory_order_relaxed);
    lastProcessActiveTracks_.store(0U, std::memory_order_relaxed);
    lastProcessRecordingTracks_.store(0U, std::memory_order_relaxed);
    fxDspFaultCount_.store(0U, std::memory_order_relaxed);
    lastFxDspFaultFrame_.store(0U, std::memory_order_relaxed);
    lastFxDspFaultCode_.store(static_cast<std::uint8_t>(NativeFxGraphResult::Ok),
                              std::memory_order_relaxed);
    publishRhythmStatus();
    publishTrackStatuses();
    return true;
}

bool NativeTrackHost::processInputBlock(const float* inputInterleaved,
                                       std::uint32_t inputChannels,
                                       float* outputInterleavedStereo,
                                       std::uint32_t frames,
                                       MultiTrackProcessStats* stats) noexcept {
    return processInputBlockWithCarrier(inputInterleaved, inputChannels, nullptr, 0U,
                                        outputInterleavedStereo, frames, stats);
}

bool NativeTrackHost::processInputBlockWithCarrier(const float* inputInterleaved,
                                                   std::uint32_t inputChannels,
                                                   const float* carrierInterleaved,
                                                   std::uint32_t carrierChannels,
                                                   float* outputInterleavedStereo,
                                                   std::uint32_t frames,
                                                   MultiTrackProcessStats* stats) noexcept {
    if (!core_ || outputInterleavedStereo == nullptr || frames > kNativeTrackHostMaximumCallbackFrames ||
        inputChannels == 0U || inputChannels > 2U ||
        (carrierInterleaved == nullptr ? carrierChannels != 0U : carrierChannels != 2U)) {
        if (outputInterleavedStereo != nullptr && frames <= kNativeTrackHostMaximumCallbackFrames) {
            std::fill_n(outputInterleavedStereo, static_cast<std::size_t>(frames) * 2U, 0.0f);
        }
        return false;
    }

    const auto publishFxFault = [this](NativeFxGraphResult fault,
                                       std::uint64_t absoluteFrame) noexcept {
        if (fault == NativeFxGraphResult::Ok || fault == NativeFxGraphResult::NoActiveGraph)
            return;
        fxDspFaultCount_.fetch_add(1U, std::memory_order_relaxed);
        lastFxDspFaultFrame_.store(absoluteFrame, std::memory_order_relaxed);
        lastFxDspFaultCode_.store(static_cast<std::uint8_t>(fault),
                                  std::memory_order_release);
    };

    MultiTrackProcessStats total{};
    total.frames = frames;
    auto frame = nextFrame_.load(std::memory_order_relaxed);
    std::uint32_t offset = 0U;
    while (offset < frames) {
        const auto chunk = std::min(kNativeTrackHostQuantumFrames, frames - offset);
        processRhythmChunk(frame, chunk);
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
            fxInputScratch_[index] = {left, right};
            if (carrierInterleaved != nullptr) {
                const auto carrierIndex = sourceFrame * 2U;
                fxCarrierLeftScratch_[index] =
                    webrc::dsp::sanitize(carrierInterleaved[carrierIndex]);
                fxCarrierRightScratch_[index] =
                    webrc::dsp::sanitize(carrierInterleaved[carrierIndex + 1U]);
            }
        }

        MultiTrackProcessStats part{};
        NativeFxGraphBlock fxBlock{};
        fxBlock.inputCapture = fxInputScratch_.data();
        for (std::size_t track = 0U; track < kNativeTrackCount; ++track)
            fxBlock.trackPlayback[track] = fxTrackScratch_[track].data();
        fxBlock.sendReturn = fxSendScratch_.data();
        fxBlock.masterMix = fxMasterScratch_.data();
        if (carrierInterleaved != nullptr) {
            fxBlock.carrierLeft = fxCarrierLeftScratch_.data();
            fxBlock.carrierRight = fxCarrierRightScratch_.data();
            fxBlock.carrierFrames = chunk;
            fxBlock.carrierChannels = 2U;
        }
        std::fill_n(fxSendScratch_.data(), chunk, webrc::dsp::StereoFrame{});

        auto fxResult = fxGraphExchange_.beginBlock(fxBlock, chunk, frame);
        publishFxFault(fxResult, frame);
        bool graphBlockOpen = fxResult == NativeFxGraphResult::Ok;
        if (graphBlockOpen) {
            fxResult = fxGraphExchange_.processInputBus();
            if (fxResult != NativeFxGraphResult::Ok) {
                publishFxFault(fxResult, frame);
                fxGraphExchange_.cancelBlock();
                graphBlockOpen = false;
            }
        }
        if (graphBlockOpen) {
            for (std::uint32_t index = 0U; index < chunk; ++index) {
                inputScratch_[static_cast<std::size_t>(index) * 2U] = fxInputScratch_[index].left;
                inputScratch_[static_cast<std::size_t>(index) * 2U + 1U] = fxInputScratch_[index].right;
            }
            std::array<float*, kNativeTrackCount> stemPointers{};
            for (std::size_t track = 0U; track < kNativeTrackCount; ++track)
                stemPointers[track] = trackStemScratch_[track].data();
            if (!core_->processBlockWithTrackStems(inputScratch_.data(), outputScratch_.data(),
                                                   stemPointers, chunk, frame, &part)) {
                fxGraphExchange_.cancelBlock();
                std::fill_n(outputInterleavedStereo,
                            static_cast<std::size_t>(frames) * 2U, 0.0f);
                return false;
            }
            for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
                for (std::uint32_t index = 0U; index < chunk; ++index) {
                    const auto sample = static_cast<std::size_t>(index) * 2U;
                    fxTrackScratch_[track][index] = {
                        trackStemScratch_[track][sample], trackStemScratch_[track][sample + 1U]};
                }
            }
            for (std::uint8_t track = 0U; track < kNativeTrackCount; ++track) {
                fxResult = fxGraphExchange_.processTrackBus(track);
                if (fxResult != NativeFxGraphResult::Ok) break;
                // The graph operates on the fixed-size StereoFrame adapter,
                // while the looper's stem mixer owns interleaved float PCM.
                // Commit each completed insert back to its own stem before
                // gain/pan/mute/solo and master summing consume those stems.
                for (std::uint32_t index = 0U; index < chunk; ++index) {
                    const auto sample = static_cast<std::size_t>(index) * 2U;
                    trackStemScratch_[track][sample] = fxTrackScratch_[track][index].left;
                    trackStemScratch_[track][sample + 1U] = fxTrackScratch_[track][index].right;
                }
            }
            bool stemMixApplied = false;
            if (fxResult == NativeFxGraphResult::Ok) {
                stemMixApplied = core_->applyTrackMixToStems(stemPointers, chunk);
                if (!stemMixApplied) fxResult = NativeFxGraphResult::InvalidBlock;
            }

            if (fxResult == NativeFxGraphResult::Ok) {
                for (std::uint32_t index = 0U; index < chunk; ++index) {
                    const auto sample = static_cast<std::size_t>(index) * 2U;
                    float left = outputScratch_[sample];
                    float right = outputScratch_[sample + 1U];
                    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
                        left += trackStemScratch_[track][sample];
                        right += trackStemScratch_[track][sample + 1U];
                    }
                    left += rhythmLeftScratch_[index] * rhythmGainScratch_[index];
                    right += rhythmRightScratch_[index] * rhythmGainScratch_[index];
                    fxMasterScratch_[index] = {webrc::dsp::sanitize(left),
                                               webrc::dsp::sanitize(right)};
                }
                fxResult = fxGraphExchange_.processSendBus();
                if (fxResult == NativeFxGraphResult::Ok) {
                    for (std::uint32_t index = 0U; index < chunk; ++index) {
                        fxMasterScratch_[index].left = webrc::dsp::sanitize(
                            fxMasterScratch_[index].left + fxSendScratch_[index].left);
                        fxMasterScratch_[index].right = webrc::dsp::sanitize(
                            fxMasterScratch_[index].right + fxSendScratch_[index].right);
                    }
                    fxResult = fxGraphExchange_.processMasterBus();
                }
                if (fxResult == NativeFxGraphResult::Ok)
                    fxResult = fxGraphExchange_.endBlock();
            }
            if (fxResult == NativeFxGraphResult::Ok) {
                for (std::uint32_t index = 0U; index < chunk; ++index) {
                    outputScratch_[static_cast<std::size_t>(index) * 2U] = fxMasterScratch_[index].left;
                    outputScratch_[static_cast<std::size_t>(index) * 2U + 1U] = fxMasterScratch_[index].right;
                }
            } else {
                fxGraphExchange_.cancelBlock();
                publishFxFault(fxResult, frame);
                // A DSP fault bypasses the unfinished buses for this block;
                // already-rendered track stems remain separate and finite.
                if (!stemMixApplied) stemMixApplied = core_->applyTrackMixToStems(stemPointers, chunk);
                if (stemMixApplied) {
                    for (std::uint32_t index = 0U; index < chunk; ++index) {
                        const auto sample = static_cast<std::size_t>(index) * 2U;
                        float left = outputScratch_[sample];
                        float right = outputScratch_[sample + 1U];
                        for (const auto& stem : trackStemScratch_) {
                            left += stem[sample];
                            right += stem[sample + 1U];
                        }
                        left += rhythmLeftScratch_[index] * rhythmGainScratch_[index];
                        right += rhythmRightScratch_[index] * rhythmGainScratch_[index];
                        outputScratch_[sample] = webrc::dsp::sanitize(left);
                        outputScratch_[sample + 1U] = webrc::dsp::sanitize(right);
                    }
                }
            }
        } else {
            if (!core_->processBlock(inputScratch_.data(), outputScratch_.data(), chunk, frame, &part)) {
                std::fill_n(outputInterleavedStereo, static_cast<std::size_t>(frames) * 2U, 0.0f);
                return false;
            }
            for (std::uint32_t index = 0U; index < chunk; ++index) {
                const auto sample = static_cast<std::size_t>(index) * 2U;
                outputScratch_[sample] = webrc::dsp::sanitize(
                    outputScratch_[sample] + rhythmLeftScratch_[index] * rhythmGainScratch_[index]);
                outputScratch_[sample + 1U] = webrc::dsp::sanitize(
                    outputScratch_[sample + 1U] + rhythmRightScratch_[index]);
            }
        }
        const auto destinationOffset = static_cast<std::size_t>(offset) * 2U;
        for (std::uint32_t index = 0U; index < chunk * 2U; ++index)
            total.outputPeak = std::max(total.outputPeak, std::abs(outputScratch_[index]));
        std::copy_n(outputScratch_.data(), static_cast<std::size_t>(chunk) * 2U,
                    outputInterleavedStereo + destinationOffset);
        total.activeTracks = std::max(total.activeTracks, part.activeTracks);
        total.recordingTracks = std::max(total.recordingTracks, part.recordingTracks);
        total.lateCommands += part.lateCommands;
        total.droppedCommands = part.droppedCommands;
        total.inputPeak = std::max(total.inputPeak, part.inputPeak);
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
    publishRhythmStatus();
    if (stats != nullptr) *stats = total;
    return true;
}

NativeFxGraphResult NativeTrackHost::stageFxGraph(
    std::unique_ptr<NativeFxGraph>& candidate) noexcept {
    std::lock_guard<std::mutex> lock(fxProducerMutex_);
    if (!core_) return NativeFxGraphResult::NotPrepared;
    if (!candidate || !candidate->prepared() || !candidate->sealed())
        return NativeFxGraphResult::GraphNotSealed;
    const auto& spec = candidate->spec();
    if (spec.channels != 2U || spec.maxBlockFrames != kNativeTrackHostQuantumFrames ||
        spec.sampleRate != static_cast<float>(sampleRate_)) return NativeFxGraphResult::SpecMismatch;
    // The Native host has no per-track send level/source route yet. A Send
    // insert would process the zero-initialized return scratch, so fail closed
    // instead of advertising a configured but silent send chain.
    for (std::uint8_t slot = 0U; slot < kNativeFxGraphSlotsPerBus; ++slot) {
        if (candidate->hasSlot({NativeFxBusKind::Send, 0U}, slot))
            return NativeFxGraphResult::InvalidRoute;
    }
    const auto candidateBudget = candidateFxGraphBudgetBytes();
    if (!fxGraphExchange_.canStageCandidate() || candidateBudget == 0U ||
        candidate->memoryBudgetBytes() == 0U ||
        candidate->memoryBudgetBytes() > candidateBudget ||
        candidate->estimatedPermanentBytes() > candidateBudget)
        return NativeFxGraphResult::MemoryBudgetExceeded;
    return fxGraphExchange_.stage(candidate);
}

NativeFxGraphResult NativeTrackHost::postFxEvent(const NativeFxGraphEvent& event) noexcept {
    std::lock_guard<std::mutex> lock(fxProducerMutex_);
    if (!core_) return NativeFxGraphResult::NotPrepared;
    return fxGraphExchange_.postEvent(event);
}

NativeFxGraphResult NativeTrackHost::postFxEvents(const NativeFxGraphEvent* events,
                                                  std::uint32_t eventCount) noexcept {
    std::lock_guard<std::mutex> lock(fxProducerMutex_);
    if (!core_) return NativeFxGraphResult::NotPrepared;
    return fxGraphExchange_.postEvents(events, eventCount);
}

bool NativeTrackHost::reclaimRetiredFxGraph() noexcept {
    std::lock_guard<std::mutex> lock(fxProducerMutex_);
    return fxGraphExchange_.reclaimRetired();
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
    const auto frame = nextSharedTempoCommandFrame(kNativeTrackHostQuantumFrames);
    return frame <= kMaximumCommandFrame && setTempoAtFrame(frame, bpm);
}
bool NativeTrackHost::setMonitor(bool enabled) noexcept {
    return queue(TrackCommandType::SetInputMonitor, 0U, 0.0f, enabled);
}

bool NativeTrackHost::queueRhythmCommand(const RhythmCommand& command) noexcept {
    std::lock_guard<std::mutex> lock(rhythmProducerMutex_);
    return queueRhythmCommandLocked(command);
}

bool NativeTrackHost::queueRhythmCommandLocked(const RhythmCommand& command) noexcept {
    if (!rhythmPreparedPublished_.load(std::memory_order_acquire) ||
        command.absoluteFrame > kMaximumCommandFrame) {
        rejectedRhythmCommands_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    const auto current = nextFrame_.load(std::memory_order_acquire);
    if (command.absoluteFrame < current ||
        (hasRhythmCommandFrame_ && command.absoluteFrame < lastRhythmCommandFrame_)) {
        rejectedRhythmCommands_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    const auto write = rhythmCommandWrite_.load(std::memory_order_relaxed);
    const auto read = rhythmCommandRead_.load(std::memory_order_acquire);
    if (write - read >= kNativeTrackHostRhythmCommandCapacity) {
        rejectedRhythmCommands_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    rhythmCommands_[static_cast<std::size_t>(write % kNativeTrackHostRhythmCommandCapacity)] = command;
    rhythmCommandWrite_.store(write + 1U, std::memory_order_release);
    lastRhythmCommandFrame_ = command.absoluteFrame;
    hasRhythmCommandFrame_ = true;
    return true;
}

bool NativeTrackHost::queueRhythmPatternKit(std::uint64_t absoluteFrame,
                                            std::uint32_t patternIndex,
                                            std::uint32_t kitIndex) noexcept {
    if (!webrc::dsp::cleanRoomRhythmPattern(patternIndex) ||
        !webrc::dsp::cleanRoomKitProfile(kitIndex)) {
        rejectedRhythmCommands_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    RhythmCommand command{};
    command.absoluteFrame = absoluteFrame;
    command.type = RhythmCommandType::PatternKit;
    command.patternIndex = patternIndex;
    command.kitIndex = kitIndex;
    return queueRhythmCommand(command);
}

bool NativeTrackHost::startRhythm(std::uint64_t absoluteFrame, bool playIntro) noexcept {
    RhythmCommand command{};
    command.absoluteFrame = absoluteFrame;
    command.type = RhythmCommandType::Start;
    command.playIntro = playIntro;
    return queueRhythmCommand(command);
}

bool NativeTrackHost::queueRhythmVariation(std::uint64_t absoluteFrame,
                                           std::uint8_t variation) noexcept {
    if (variation > 3U) {
        rejectedRhythmCommands_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    RhythmCommand command{};
    command.absoluteFrame = absoluteFrame;
    command.type = RhythmCommandType::Variation;
    command.variation = variation;
    return queueRhythmCommand(command);
}

bool NativeTrackHost::queueRhythmFill(std::uint64_t absoluteFrame) noexcept {
    RhythmCommand command{};
    command.absoluteFrame = absoluteFrame;
    command.type = RhythmCommandType::Fill;
    return queueRhythmCommand(command);
}

bool NativeTrackHost::queueRhythmEnding(std::uint64_t absoluteFrame) noexcept {
    RhythmCommand command{};
    command.absoluteFrame = absoluteFrame;
    command.type = RhythmCommandType::Ending;
    return queueRhythmCommand(command);
}

bool NativeTrackHost::stopRhythm(std::uint64_t absoluteFrame) noexcept {
    RhythmCommand command{};
    command.absoluteFrame = absoluteFrame;
    command.type = RhythmCommandType::Stop;
    return queueRhythmCommand(command);
}

bool NativeTrackHost::setRhythmTempoAtFrame(std::uint64_t absoluteFrame,
                                            double bpm) noexcept {
    return setTempoAtFrame(absoluteFrame, bpm);
}

bool NativeTrackHost::setTempoAtFrame(std::uint64_t absoluteFrame,
                                      double bpm) noexcept {
    if (!std::isfinite(bpm) || bpm < 20.0 || bpm > 300.0) {
        rejectedRhythmCommands_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    std::lock_guard<std::mutex> lock(rhythmProducerMutex_);
    return setTempoAtFrameLocked(absoluteFrame, bpm);
}

bool NativeTrackHost::setTempoAtFrameLocked(std::uint64_t absoluteFrame,
                                            double bpm) noexcept {
    RhythmCommand command{};
    command.absoluteFrame = absoluteFrame;
    command.type = RhythmCommandType::Tempo;
    command.bpm = bpm;
    if (!queueRhythmCommandLocked(command)) return false;
    rhythmTempoTargetBpmPublished_.store(bpm, std::memory_order_release);
    return true;
}

bool NativeTrackHost::setRhythmVolumeAtFrame(std::uint64_t absoluteFrame,
                                             float volume) noexcept {
    if (!finite(volume) || volume < 0.0f || volume > 1.0f) {
        rejectedRhythmCommands_.fetch_add(1U, std::memory_order_relaxed);
        return false;
    }
    RhythmCommand command{};
    command.absoluteFrame = absoluteFrame;
    command.type = RhythmCommandType::Volume;
    command.volume = volume;
    if (!queueRhythmCommand(command)) return false;
    rhythmVolumeTargetPublished_.store(volume, std::memory_order_release);
    return true;
}

std::uint64_t NativeTrackHost::nextRhythmCommandFrame(std::uint32_t leadFrames) const noexcept {
    std::lock_guard<std::mutex> lock(rhythmProducerMutex_);
    const auto current = nextFrame_.load(std::memory_order_acquire);
    if (current > kMaximumCommandFrame - leadFrames) return kMaximumCommandFrame + 1U;
    const auto safeFrame = current + leadFrames;
    return hasRhythmCommandFrame_ ? std::max(safeFrame, lastRhythmCommandFrame_) : safeFrame;
}

std::uint64_t NativeTrackHost::nextSharedTempoCommandFrame(std::uint32_t leadFrames) const noexcept {
    // Shared tempo is published through the single rhythm command queue, so
    // no two-queue reservation/partial-publication window exists.
    return nextRhythmCommandFrame(leadFrames);
}

bool NativeTrackHost::peekRhythmCommand(RhythmCommand& command) const noexcept {
    const auto read = rhythmCommandRead_.load(std::memory_order_relaxed);
    if (read == rhythmCommandWrite_.load(std::memory_order_acquire)) return false;
    command = rhythmCommands_[static_cast<std::size_t>(read % kNativeTrackHostRhythmCommandCapacity)];
    return true;
}

void NativeTrackHost::popRhythmCommand() noexcept {
    const auto read = rhythmCommandRead_.load(std::memory_order_relaxed);
    rhythmCommandRead_.store(read + 1U, std::memory_order_release);
}

void NativeTrackHost::applyRhythmCommand(const RhythmCommand& command,
                                         std::uint64_t applyFrame) noexcept {
    bool accepted = false;
    switch (command.type) {
    case RhythmCommandType::PatternKit:
        accepted = rhythmRenderer_->queuePatternKit(command.patternIndex, command.kitIndex);
        break;
    case RhythmCommandType::Start:
        accepted = rhythmRenderer_->startAtFrame(applyFrame, command.playIntro);
        break;
    case RhythmCommandType::Variation:
        accepted = rhythmRenderer_->queueVariation(command.variation);
        break;
    case RhythmCommandType::Fill:
        accepted = rhythmRenderer_->queueFill();
        break;
    case RhythmCommandType::Ending:
        accepted = rhythmRenderer_->queueEnding();
        break;
    case RhythmCommandType::Stop:
        accepted = rhythmRenderer_->queueStop();
        break;
    case RhythmCommandType::Tempo:
        accepted = rhythmRenderer_->queueTempo(command.bpm);
        if (accepted) core_->applyTempoBpmFromAudioThread(command.bpm);
        break;
    case RhythmCommandType::Volume: {
        rhythmVolumeTarget_ = command.volume;
        const auto rampFrames = static_cast<std::uint32_t>(std::max(1.0,
            std::ceil(static_cast<double>(sampleRate_) * 0.010)));
        rhythmVolumeRemaining_ = rampFrames;
        rhythmVolumeStep_ = (rhythmVolumeTarget_ - rhythmVolumeCurrent_) /
                            static_cast<float>(rampFrames);
        accepted = true;
        break;
    }
    }
    if (!accepted) {
        rhythmFaultCount_.fetch_add(1U, std::memory_order_relaxed);
        lastRhythmFaultFrame_.store(applyFrame, std::memory_order_release);
    }
}

void NativeTrackHost::processRhythmChunk(std::uint64_t blockStartFrame,
                                         std::uint32_t frames) noexcept {
    std::uint32_t outputOffset = 0U;
    auto cursor = blockStartFrame;
    const auto blockEnd = blockStartFrame + frames;
    const auto writeGain = [this](std::uint32_t offset, std::uint32_t count) noexcept {
        for (std::uint32_t index = 0U; index < count; ++index) {
            if (rhythmVolumeRemaining_ > 0U) {
                rhythmVolumeCurrent_ += rhythmVolumeStep_;
                --rhythmVolumeRemaining_;
                if (rhythmVolumeRemaining_ == 0U)
                    rhythmVolumeCurrent_ = rhythmVolumeTarget_;
            }
            rhythmGainScratch_[offset + index] = rhythmVolumeCurrent_;
        }
    };
    RhythmCommand command{};
    while (peekRhythmCommand(command) && command.absoluteFrame < blockEnd) {
        const auto commandFrame = std::max(cursor, command.absoluteFrame);
        const auto segmentFrames = static_cast<std::uint32_t>(commandFrame - cursor);
        if (segmentFrames > 0U && !rhythmRenderer_->processBlock(
                cursor, rhythmLeftScratch_.data() + outputOffset,
                rhythmRightScratch_.data() + outputOffset, segmentFrames)) {
            // A rejected renderer segment must never replay samples left in
            // the fixed scratch arrays by an earlier callback.
            std::fill_n(rhythmLeftScratch_.data() + outputOffset, segmentFrames, 0.0f);
            std::fill_n(rhythmRightScratch_.data() + outputOffset, segmentFrames, 0.0f);
            rhythmFaultCount_.fetch_add(1U, std::memory_order_relaxed);
            lastRhythmFaultFrame_.store(cursor, std::memory_order_release);
        }
        writeGain(outputOffset, segmentFrames);
        if (command.absoluteFrame < commandFrame)
            lateRhythmCommands_.fetch_add(1U, std::memory_order_relaxed);
        applyRhythmCommand(command, commandFrame);
        popRhythmCommand();
        cursor = commandFrame;
        outputOffset += segmentFrames;
    }
    const auto remaining = static_cast<std::uint32_t>(blockEnd - cursor);
    if (remaining > 0U && !rhythmRenderer_->processBlock(
            cursor, rhythmLeftScratch_.data() + outputOffset,
            rhythmRightScratch_.data() + outputOffset, remaining)) {
        std::fill_n(rhythmLeftScratch_.data() + outputOffset, remaining, 0.0f);
        std::fill_n(rhythmRightScratch_.data() + outputOffset, remaining, 0.0f);
        rhythmFaultCount_.fetch_add(1U, std::memory_order_relaxed);
        lastRhythmFaultFrame_.store(cursor, std::memory_order_release);
    }
    writeGain(outputOffset, remaining);
}

void NativeTrackHost::publishRhythmStatus() noexcept {
    const auto sequence = rhythmStatusSequence_.load(std::memory_order_relaxed);
    rhythmStatusSequence_.store(sequence + 1U, std::memory_order_release);
    rhythmPreparedPublished_.store(rhythmRenderer_->prepared(), std::memory_order_relaxed);
    rhythmPlayingPublished_.store(rhythmRenderer_->playing(), std::memory_order_relaxed);
    rhythmPatternIndexPublished_.store(rhythmRenderer_->selectedPatternIndex(), std::memory_order_relaxed);
    rhythmKitIndexPublished_.store(rhythmRenderer_->selectedKitIndex(), std::memory_order_relaxed);
    rhythmVariationPublished_.store(rhythmRenderer_->currentVariation(), std::memory_order_relaxed);
    rhythmSectionPublished_.store(static_cast<std::uint8_t>(rhythmRenderer_->currentSection()),
                                  std::memory_order_relaxed);
    rhythmActiveVoicesPublished_.store(rhythmRenderer_->activeVoices(), std::memory_order_relaxed);
    rhythmCompletedBarsPublished_.store(rhythmRenderer_->completedBars(), std::memory_order_relaxed);
    rhythmTriggeredEventsPublished_.store(rhythmRenderer_->triggeredEvents(), std::memory_order_relaxed);
    rhythmLastTriggeredFramePublished_.store(rhythmRenderer_->lastTriggeredFrame(), std::memory_order_relaxed);
    rhythmTempoBpmPublished_.store(rhythmRenderer_->tempoBpm(), std::memory_order_release);
    rhythmVolumePublished_.store(rhythmVolumeCurrent_, std::memory_order_release);
    rhythmStatusSequence_.store(sequence + 2U, std::memory_order_release);
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
    result.aggregateMemoryBudgetBytes = aggregateMemoryBudgetBytes_.load(std::memory_order_acquire);
    result.preparedFixedBytes = preparedFixedBytes_.load(std::memory_order_relaxed);
    result.preparedFxGraphBytes = fxGraphExchange_.residentGraphBytes();
    result.candidateFxGraphBudgetBytes = candidateFxGraphBudgetBytes();
    result.tempoBpm = tempoBpm_.load(std::memory_order_acquire);
    result.fxGraphActive = fxGraphExchange_.hasActiveGraph();
    result.fxGraphGeneration = fxGraphExchange_.producerGeneration();
    result.fxGraphActiveGeneration = fxGraphExchange_.activeGraphGeneration();
    result.staleFxEventsDiscarded = fxGraphExchange_.staleGenerationEventCount();
    result.fxDspFaultCount = fxDspFaultCount_.load(std::memory_order_acquire);
    result.lastFxDspFaultFrame = lastFxDspFaultFrame_.load(std::memory_order_relaxed);
    result.lastFxDspFault = static_cast<NativeFxGraphResult>(
        lastFxDspFaultCode_.load(std::memory_order_acquire));
    for (unsigned int attempt = 0U; attempt < 3U; ++attempt) {
        const auto before = rhythmStatusSequence_.load(std::memory_order_acquire);
        if ((before & 1U) != 0U) continue;
        result.rhythmPrepared = rhythmPreparedPublished_.load(std::memory_order_relaxed);
        result.rhythmPlaying = rhythmPlayingPublished_.load(std::memory_order_relaxed);
        result.rhythmPatternIndex = rhythmPatternIndexPublished_.load(std::memory_order_relaxed);
        result.rhythmKitIndex = rhythmKitIndexPublished_.load(std::memory_order_relaxed);
        result.rhythmVariation = rhythmVariationPublished_.load(std::memory_order_relaxed);
        result.rhythmSection = static_cast<webrc::dsp::RhythmSection>(
            rhythmSectionPublished_.load(std::memory_order_relaxed));
        result.rhythmActiveVoices = rhythmActiveVoicesPublished_.load(std::memory_order_relaxed);
        result.rhythmCompletedBars = rhythmCompletedBarsPublished_.load(std::memory_order_relaxed);
        result.rhythmTriggeredEvents = rhythmTriggeredEventsPublished_.load(std::memory_order_relaxed);
        result.rhythmLastTriggeredFrame = rhythmLastTriggeredFramePublished_.load(std::memory_order_relaxed);
        result.rhythmTempoBpm = rhythmTempoBpmPublished_.load(std::memory_order_relaxed);
        result.rhythmTempoTargetBpm = rhythmTempoTargetBpmPublished_.load(std::memory_order_relaxed);
        result.rhythmTempoPending = std::abs(result.rhythmTempoTargetBpm - result.rhythmTempoBpm) > 1.0e-6;
        result.rhythmVolume = rhythmVolumePublished_.load(std::memory_order_relaxed);
        result.rhythmVolumeTarget = rhythmVolumeTargetPublished_.load(std::memory_order_relaxed);
        result.rhythmVolumePending = std::abs(result.rhythmVolumeTarget - result.rhythmVolume) > 1.0e-6f;
        if (rhythmStatusSequence_.load(std::memory_order_acquire) == before) break;
    }
    result.rejectedRhythmCommands = rejectedRhythmCommands_.load(std::memory_order_relaxed);
    result.lateRhythmCommands = lateRhythmCommands_.load(std::memory_order_relaxed);
    result.rhythmFaultCount = rhythmFaultCount_.load(std::memory_order_acquire);
    result.lastRhythmFaultFrame = lastRhythmFaultFrame_.load(std::memory_order_relaxed);
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
