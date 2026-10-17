#include "native_audio_core.hpp"
#include "native_hrm_auto_processor.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <limits>
#include <sstream>
#include <thread>

namespace webrc::native {

namespace {

RtAudio::Api toRtAudioApi(Backend backend) {
    return backend == Backend::Asio ? RtAudio::WINDOWS_ASIO : RtAudio::WINDOWS_WASAPI;
}

std::string makeDeviceId(const std::string& backend, unsigned int deviceId) {
    return backend + ":" + std::to_string(deviceId);
}

bool parseDeviceId(const std::string& raw, unsigned int& outDeviceId) {
    const auto separator = raw.find(':');
    const auto numeric = separator == std::string::npos ? raw : raw.substr(separator + 1);
    try {
        outDeviceId = static_cast<unsigned int>(std::stoul(numeric));
        return true;
    } catch (...) {
        return false;
    }
}

} // namespace

std::string backendToString(Backend backend) {
    return backend == Backend::Asio ? "ASIO" : "WASAPI";
}

std::string looperStateToString(LooperState state) {
    switch (state) {
    case LooperState::Recording: return "Recording";
    case LooperState::Stopped: return "Stopped";
    case LooperState::Playing: return "Playing";
    case LooperState::Overdubbing: return "Overdubbing";
    case LooperState::Empty:
    default: return "Empty";
    }
}

std::optional<Backend> backendFromString(const std::string& raw) {
    if (raw == "WASAPI") return Backend::Wasapi;
    if (raw == "ASIO") return Backend::Asio;
    return std::nullopt;
}

NativeAudioCore::NativeAudioCore()
    : deviceCatalog_(buildCatalog()),
      looper_(48000U, 0U, 2U),
      additionalLoopers_{
          LooperCore(48000U, 0U, 2U), LooperCore(48000U, 0U, 2U),
          LooperCore(48000U, 0U, 2U), LooperCore(48000U, 0U, 2U)
      } {}

NativeAudioCore::~NativeAudioCore() {
    std::string ignored;
    stop(ignored);
}

DeviceCatalog NativeAudioCore::getDeviceCatalog() const {
    std::lock_guard<std::mutex> lock(controlMutex_);
    return deviceCatalog_;
}

std::optional<EngineConfig> NativeAudioCore::getCurrentConfig() const {
    std::lock_guard<std::mutex> lock(controlMutex_);
    return currentConfig_;
}

EngineStatus NativeAudioCore::getStatus() const {
    std::lock_guard<std::mutex> lock(controlMutex_);

    EngineStatus status;
    status.engineRunning = engineRunning_.load(std::memory_order_acquire);
    if (currentConfig_) {
        status.backend = currentConfig_->backend;
        status.inputDeviceId = currentConfig_->inputDeviceId;
        status.outputDeviceId = currentConfig_->outputDeviceId;
        status.sampleRate = currentConfig_->sampleRate;
        status.bufferFrames = currentConfig_->bufferFrames;
        status.monitoringEnabled = currentConfig_->monitoringEnabled;
    }

    const auto backendKey = backendToString(status.backend);
    if (const auto inputsIt = deviceCatalog_.inputsByBackend.find(backendKey); inputsIt != deviceCatalog_.inputsByBackend.end()) {
        if (const auto* device = findDeviceLocked(inputsIt->second, status.inputDeviceId)) {
            status.inputDeviceName = device->name;
        }
    }
    if (const auto outputsIt = deviceCatalog_.outputsByBackend.find(backendKey); outputsIt != deviceCatalog_.outputsByBackend.end()) {
        if (const auto* device = findDeviceLocked(outputsIt->second, status.outputDeviceId)) {
            status.outputDeviceName = device->name;
        }
    }

    status.state = static_cast<LooperState>(looperState_.load(std::memory_order_acquire));
    status.nativeLooperTrackCount = static_cast<unsigned int>(kNativeTrackCount);
    status.nativeLooperMultiTrackImplemented = true;
    status.nativeLooperTracksStereo = true;
    status.nativeLooperMaxRecordSeconds = static_cast<unsigned int>(nativeLooperMaxRecordSeconds_);
    status.nativeLooperPreallocatedBytes = nativeLooperPreallocatedBytes_;
    status.nativeLooperStorageBudgetBytes = currentConfig_
        ? currentConfig_->nativeLooperStorageBudgetBytes
        : LooperCore::kDefaultAggregateLoopStorageBudgetBytes;
    status.nativeOutputLowPassAvailable = true;
    status.nativeOutputLowPassEnabled = outputLowPassEnabled_.load(std::memory_order_acquire);
    status.nativeOutputHighPassAvailable = true;
    status.nativeOutputHighPassEnabled = outputHighPassEnabled_.load(std::memory_order_acquire);
    status.nativeOutputDriveAvailable = false;
    status.nativeOutputDriveEnabled = false;
    status.nativeReverbAvailable = true;
    status.nativeReverbEnabled = nativeReverbConfig_.enabled;
    status.nativeReverbWetMix = nativeReverbConfig_.wetMix;
    status.nativeReverbRt60Seconds = nativeReverbConfig_.rt60Seconds;
    status.nativeReverbDampingCutoffHz = nativeReverbConfig_.dampingCutoffHz;
    status.nativeReverbAlgorithmicLatencyFrames = NativeOutputStage::reverbMinimumDelayFramesForSampleRate(status.sampleRate);
    status.nativeTrackOutputBankAvailable = true;
    status.nativeTrackOutputSlotActive = NativeTrackOutputBank::kActiveSlots;
    status.nativeTrackOutputMultiTrackImplemented = false;
    status.nativeFractionalDelayAvailable = true;
    status.nativeFractionalDelayEnabled = nativeFractionalDelayConfig_.enabled;
    status.nativeFractionalDelaySlot = nativeFractionalDelayConfig_.slot;
    status.nativeFractionalDelayAlgorithm = nativeFractionalDelayConfig_.algorithm;
    status.nativeFractionalDelayMs = nativeFractionalDelayConfig_.delayMs;
    status.nativeFractionalDelayWetMix = nativeFractionalDelayConfig_.wetMix;
    status.nativeFractionalDelayFeedback = nativeFractionalDelayConfig_.feedback;
    status.nativeFractionalDelayMaxMs = 2000.0f;
    status.nativeCompressorAvailable = true;
    status.nativeCompressorEnabled = nativeCompressorConfig_.enabled;
    status.nativeCompressorSlot = nativeCompressorConfig_.slot;
    status.nativeCompressorAlgorithm = nativeCompressorConfig_.algorithm;
    status.nativeCompressorThresholdDb = nativeCompressorConfig_.thresholdDb;
    status.nativeCompressorRatio = nativeCompressorConfig_.ratio;
    status.nativeCompressorAttackMs = nativeCompressorConfig_.attackMs;
    status.nativeCompressorReleaseMs = nativeCompressorConfig_.releaseMs;
    status.nativeCompressorWetMix = nativeCompressorConfig_.wetMix;
    status.nativeCompressorMakeupDb = nativeCompressorConfig_.makeupDb;
    status.nativeChorusAvailable = true;
    status.nativeChorusEnabled = nativeChorusConfig_.enabled;
    status.nativeChorusSlot = nativeChorusConfig_.slot;
    status.nativeChorusAlgorithm = nativeChorusConfig_.algorithm;
    status.nativeChorusRateHz = nativeChorusConfig_.rateHz;
    status.nativeChorusDepthMs = nativeChorusConfig_.depthMs;
    status.nativeChorusFeedback = nativeChorusConfig_.feedback;
    status.nativeChorusWetMix = nativeChorusConfig_.wetMix;
    status.nativePhaserAvailable = true;
    status.nativePhaserEnabled = nativePhaserConfig_.enabled;
    status.nativePhaserSlot = nativePhaserConfig_.slot;
    status.nativePhaserAlgorithm = nativePhaserConfig_.algorithm;
    status.nativePhaserStages = nativePhaserConfig_.stages;
    status.nativePhaserRateHz = nativePhaserConfig_.rateHz;
    status.nativePhaserDepth = nativePhaserConfig_.depth;
    status.nativePhaserFeedback = nativePhaserConfig_.feedback;
    status.nativePhaserWetMix = nativePhaserConfig_.wetMix;
    status.nativeAutoPanAvailable = true;
    status.nativeAutoPanEnabled = nativeAutoPanConfig_.enabled;
    status.nativeAutoPanSlot = nativeAutoPanConfig_.slot;
    status.nativeAutoPanAlgorithm = nativeAutoPanConfig_.algorithm;
    status.nativeAutoPanRateHz = nativeAutoPanConfig_.rateHz;
    status.nativeAutoPanDepth = nativeAutoPanConfig_.depth;
    status.nativeAutoPanWaveform = nativeAutoPanConfig_.waveform;
    status.nativeAutoPanWetMix = nativeAutoPanConfig_.wetMix;
    status.nativeCatalogGraphAvailable = true;
    for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
        const auto nativeSlot = static_cast<NativeEffectSlot>(slot);
        status.nativeCatalogSlotEffectIds[slot] = std::string(outputStage_.trackFxBank().effectId(nativeSlot));
        status.nativeCatalogSlotBypassed[slot] = nativeCatalogSlotBypassed_[slot];
        status.nativeInputCatalogSlotEffectIds[slot] = std::string(nativeInputFxBank_.effectId(nativeSlot));
        status.nativeInputCatalogSlotBypassed[slot] = nativeInputCatalogSlotBypassed_[slot];
    }
    status.fullFxGraphImplemented = false;
    status.nativeRhythmAvailable = true;
    status.nativeRhythmEnabled = nativeRhythmConfig_.enabled;
    status.nativeRhythmPatternCatalogAvailable = true;
    status.nativeRhythmPatternIndex = nativeRhythmConfig_.patternIndex;
    if (const auto* pattern = nativeRhythmPatternByIndex(nativeRhythmConfig_.patternIndex)) {
        status.nativeRhythmPatternId = std::string(pattern->id);
        status.nativeRhythmGenre = std::string(pattern->genre);
        status.nativeRhythmPatternName = std::string(pattern->pattern);
        status.nativeRhythmBeat = std::string(pattern->beat);
        status.nativeRhythmMeterNumerator = pattern->meterNumerator;
        status.nativeRhythmMeterDenominator = pattern->meterDenominator;
    }
    status.nativeRhythmEventsCleanRoomProcedural = true;
    status.nativePitchCorrectionAvailable = nativePitchConfig_.mode == NativePitchMode::LivePolyPhaseVocoder
        ? nativePolyPitchProcessor_.prepared()
        : nativePitchProcessor_.prepared();
    status.nativePitchCorrectionImplemented = true;
    status.nativePitchEnabled = nativePitchConfig_.enabled;
    status.nativePitchTrackId = nativePitchConfig_.trackId;
    status.nativePitchMode = nativePitchConfig_.mode;
    status.nativePitchReversePlayback = nativePitchConfig_.reversePlayback;
    status.nativePitchActive = nativePitchActive_.load(std::memory_order_acquire);
    status.nativePitchVoiced = nativePitchVoiced_.load(std::memory_order_acquire);
    status.nativePitchSemitones = nativePitchConfig_.semitones;
    status.nativePitchFrequencyHz = nativePitchFrequencyHz_.load(std::memory_order_acquire);
    status.nativePitchConfidence = nativePitchConfidence_.load(std::memory_order_acquire);
    status.nativePitchLatencySamples = nativePitchConfig_.mode == NativePitchMode::LivePolyPhaseVocoder
        ? nativePolyPitchProcessor_.latencySamples()
        : nativePitchProcessor_.latencySamples();
    status.nativePitchFallbackReason = nativePitchFallbackReason_.load(std::memory_order_acquire);
    status.nativeRhythmBpm = nativeRhythmConfig_.bpm;
    status.nativeRhythmKitIndex = nativeRhythmConfig_.kitIndex;
    status.nativeRhythmVariation = nativeRhythmConfig_.variation;
    status.nativeRhythmSection = nativeRhythmConfig_.section;
    status.nativeRhythmSwingPercent = nativeRhythmConfig_.swingPercent;
    status.nativeRhythmQuantizeGrid = nativeRhythmConfig_.quantizeGrid;
    status.nativeRhythmVolume = nativeRhythmConfig_.volume;
    status.loopProgress = loopProgress_.load(std::memory_order_acquire);
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        status.nativeTrackStates[track] = static_cast<LooperState>(trackStates_[track].load(std::memory_order_acquire));
        status.nativeTrackProgress[track] = trackProgress_[track].load(std::memory_order_acquire);
        status.nativeTrackLoopTransportStatus[track] = trackLoopTransportStatus_[track].load(std::memory_order_acquire);
    }
    status.inputPeak = inputPeak_.load(std::memory_order_acquire);
    status.outputPeak = outputPeak_.load(std::memory_order_acquire);
    status.xrunsOrDropouts = xrunsOrDropouts_.load(std::memory_order_acquire);
    status.callbackTicks = callbackTicks_.load(std::memory_order_acquire);
    status.nativeSampleFrame = publishedCallbackFrameCursor_.load(std::memory_order_acquire);
    const auto collectOscVocSlots = [](const NativeEffectBank& bank,
                                       auto& destination) {
        for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
            const auto* processor = dynamic_cast<const NativeOscVocProcessor*>(
                bank.processor(static_cast<NativeEffectSlot>(slot)));
            if (processor == nullptr) continue;
            auto& item = destination[slot];
            item.selected = true;
            item.currentFrame = processor->currentFrame();
            item.queuedEvents = processor->queuedEventCount();
            item.overflowEventCount = processor->overflowEventCount();
            item.lateEventCount = processor->lateEventCount();
            item.rejectedEventCount = processor->rejectedEventCount();
        }
    };
    collectOscVocSlots(nativeInputFxBank_, status.nativeInputOscVocSlots);
    collectOscVocSlots(outputStage_.trackFxBank(), status.nativeTrackOscVocSlots);
    const auto collectCatalogMidiSlots = [](const NativeEffectBank& bank, auto& destination) {
        for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
            auto& item = destination[slot];
            const auto* selected = bank.processor(static_cast<NativeEffectSlot>(slot));
            const auto* oscVoc = dynamic_cast<const NativeOscVocProcessor*>(selected);
            const auto* hrmAuto = dynamic_cast<const NativeHrmAutoProcessor*>(selected);
            if (oscVoc != nullptr) {
                item.selected = true;
                item.effectId = std::string(oscVoc->stableId());
                item.queueCapacity = kNativeOscVocEventQueueCapacity;
                item.currentFrame = oscVoc->currentFrame();
                item.queuedEvents = oscVoc->queuedEventCount();
                item.overflowEventCount = oscVoc->overflowEventCount();
                item.lateEventCount = oscVoc->lateEventCount();
                item.rejectedEventCount = oscVoc->rejectedEventCount();
            } else if (hrmAuto != nullptr) {
                item.selected = true;
                item.effectId = std::string(hrmAuto->stableId());
                item.queueCapacity = NativeHrmAutoProcessor::eventQueueCapacity();
                item.currentFrame = hrmAuto->currentFrame();
                item.queuedEvents = hrmAuto->queuedEventCount();
                item.overflowEventCount = hrmAuto->overflowEventCount();
                item.lateEventCount = hrmAuto->lateEventCount();
                item.rejectedEventCount = hrmAuto->rejectedEventCount();
            }
        }
    };
    collectCatalogMidiSlots(nativeInputFxBank_, status.nativeInputCatalogMidiSlots);
    collectCatalogMidiSlots(outputStage_.trackFxBank(), status.nativeTrackCatalogMidiSlots);
    status.nativeCatalogControlFaultCount = nativeCatalogControlFaultCount_.load(std::memory_order_acquire);
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        const auto& bank = nativePerTrackFxBanks_[track];
        collectCatalogMidiSlots(bank, status.nativePerTrackCatalogMidiSlots[track]);
        for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
            auto& destination = status.nativePerTrackCatalogSlots[track][slot];
            const auto* processor = bank.processor(static_cast<NativeEffectSlot>(slot));
            destination.effectId = std::string(bank.effectId(static_cast<NativeEffectSlot>(slot)));
            destination.bypassed = nativePerTrackSlotBypassed_[track][slot];
            destination.appliedBypassed = nativePerTrackFxPublished_[track][slot].appliedBypassed.load(std::memory_order_acquire);
            destination.prepared = processor != nullptr && currentConfig_ && processor->sampleRate() == currentConfig_->sampleRate;
            destination.processingFaulted = nativePerTrackFxPublished_[track][slot].processingFaulted.load(std::memory_order_acquire);
            destination.requestedRevision = nativePerTrackSlotRevision_[track][slot];
            destination.appliedRevision = nativePerTrackFxPublished_[track][slot].appliedRevision.load(std::memory_order_acquire);
            destination.controlFaulted = destination.requestedRevision != 0U && destination.requestedRevision ==
                nativePerTrackFxPublished_[track][slot].controlFaultRevision.load(std::memory_order_acquire);
        }
    }
    if (audio_ && audio_->isStreamOpen()) {
        status.streamTimeSeconds = audio_->getStreamTime();
    } else if (captureAudio_ && captureAudio_->isStreamOpen()) {
        status.streamTimeSeconds = captureAudio_->getStreamTime();
    }
    status.inputLatencyMs = status.sampleRate > 0
        ? (static_cast<double>(status.bufferFrames) / static_cast<double>(status.sampleRate)) * 1000.0
        : 0.0;
    status.outputLatencyMs = status.inputLatencyMs;
    status.roundTripEstimateMs = status.inputLatencyMs + status.outputLatencyMs;
    status.lastError = lastError_;
    return status;
}

bool NativeAudioCore::validateLoopStorageBudgetLocked(
    unsigned int sampleRate,
    std::uint64_t budgetBytes,
    std::string& error
) const {
    constexpr std::size_t kChannels = 2U;
    if (budgetBytes < LooperCore::kMinimumAggregateLoopStorageBudgetBytes ||
        budgetBytes > LooperCore::kMaximumAggregateLoopStorageBudgetBytes) {
        std::ostringstream message;
        message << "Native loop-storage budget must be between "
                << (LooperCore::kMinimumAggregateLoopStorageBudgetBytes / (1024U * 1024U))
                << " MiB and "
                << (LooperCore::kMaximumAggregateLoopStorageBudgetBytes / (1024U * 1024U))
                << " MiB.";
        error = message.str();
        return false;
    }
    const std::size_t safeSeconds = LooperCore::maximumDurationSecondsForBudget(
        sampleRate,
        static_cast<unsigned int>(kChannels),
        kNativeTrackCount,
        LooperCore::kMaximumLoopSeconds,
        budgetBytes
    );
    const std::size_t requestedSeconds = LooperCore::kMaximumLoopSeconds;
    if (safeSeconds < requestedSeconds) {
        const std::uint64_t requiredBytes = static_cast<std::uint64_t>(requestedSeconds) * sampleRate *
            kChannels * sizeof(float) * kNativeTrackCount;
        std::ostringstream message;
        message << "Native five-track stereo loops need " << requiredBytes
                << " bytes for " << requestedSeconds << " seconds per track at " << sampleRate
                << " Hz, exceeding the selected " << (budgetBytes / (1024U * 1024U))
                << " MiB loop-storage budget. This setting supports at most " << safeSeconds
                << " seconds per track; select a larger budget (up to "
                << (LooperCore::kMaximumAggregateLoopStorageBudgetBytes / (1024U * 1024U))
                << " MiB) to preserve the " << requestedSeconds << "-second maximum at this rate.";
        error = message.str();
        return false;
    }
    error.clear();
    return true;
}

bool NativeAudioCore::prepareLoopStorageLocked(
    unsigned int sampleRate,
    std::uint64_t budgetBytes,
    std::string& error
) {
    constexpr std::size_t kChannels = 2U;
    if (!validateLoopStorageBudgetLocked(sampleRate, budgetBytes, error)) return false;
    const std::size_t requestedSeconds = LooperCore::kMaximumLoopSeconds;

    const std::uint64_t expectedAggregateBytes = static_cast<std::uint64_t>(requestedSeconds) * sampleRate *
        kChannels * sizeof(float) * kNativeTrackCount;
    const bool alreadyPreparedForFormat = nativeLooperMaxRecordSeconds_ == requestedSeconds &&
        nativeLooperPreallocatedBytes_ == expectedAggregateBytes &&
        looper_.capacityFrames() == static_cast<std::size_t>(sampleRate) * requestedSeconds &&
        looper_.sampleRate() == sampleRate && looper_.channels() == kChannels &&
        std::all_of(additionalLoopers_.begin(), additionalLoopers_.end(), [sampleRate](const LooperCore& track) {
            return track.capacityFrames() == static_cast<std::size_t>(sampleRate) * LooperCore::kMaximumLoopSeconds &&
                track.sampleRate() == sampleRate && track.channels() == 2U;
        });
    if (alreadyPreparedForFormat) {
        // Stream/backend/buffer changes and budget adjustments must not erase
        // a finalized loop when its storage format is already compatible.
        error.clear();
        return true;
    }

    nativeLooperPreallocatedBytes_ = 0U;
    nativeLooperMaxRecordSeconds_ = 0U;
    if (!looper_.prepare(sampleRate, requestedSeconds, static_cast<unsigned int>(kChannels))) {
        error = "Unable to allocate and pre-touch the bounded Native loop store within the configured memory budget.";
        nativeLooperPreallocatedBytes_ = looper_.storageBytes();
        return false;
    }
    nativeLooperPreallocatedBytes_ = looper_.storageBytes();
    for (auto& track : additionalLoopers_) {
        if (!track.prepare(sampleRate, requestedSeconds, static_cast<unsigned int>(kChannels))) {
            error = "Unable to allocate and pre-touch all five bounded Native loop stores within the configured memory budget.";
            for (const auto& preparedTrack : additionalLoopers_) nativeLooperPreallocatedBytes_ += preparedTrack.storageBytes();
            return false;
        }
        nativeLooperPreallocatedBytes_ += track.storageBytes();
    }
    nativeLooperMaxRecordSeconds_ = requestedSeconds;
    error.clear();
    return true;
}

bool NativeAudioCore::hasNonEmptyTrackLocked() const noexcept {
    for (const auto& state : trackStates_) {
        if (state.load(std::memory_order_acquire) != static_cast<int>(LooperState::Empty)) return true;
    }
    return false;
}

bool NativeAudioCore::applyConfig(const EngineConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    EngineConfig validated = config;
    if (!validateConfigLocked(validated, error)) {
        updateLastErrorLocked(error);
        return false;
    }
    // Reject a known-over-budget rate before closing the current stream or
    // changing its configuration. Failed admission must leave a valid
    // existing 300-second setup intact.
    if (!validateLoopStorageBudgetLocked(validated.sampleRate, validated.nativeLooperStorageBudgetBytes, error)) {
        updateLastErrorLocked(error);
        return false;
    }

    const std::optional<EngineConfig> previousConfig = currentConfig_;
    const bool loopFormatChanged = !previousConfig || previousConfig->sampleRate != validated.sampleRate;
    const auto nonEmptyLoopError = [] {
        return std::string("Sample-rate changes are blocked while any Native track contains a loop or is recording. Export or back up the loops, clear all five tracks, then try again.");
    };
    // Avoid interrupting a running engine for a configuration that would
    // invalidate existing loop samples. Recheck after stopping below to close
    // the race with a callback that begins recording just after this check.
    if (loopFormatChanged && hasNonEmptyTrackLocked()) {
        error = nonEmptyLoopError();
        updateLastErrorLocked(error);
        return false;
    }

    const bool wasRunning = engineRunning_.load(std::memory_order_acquire);
    if (wasRunning) {
        closeStreamLocked();
    }

    const auto restorePreviousConfiguration = [&](const std::string& failure, bool restoreLoopStorage) {
        std::string result = failure;
        if (previousConfig) {
            currentConfig_ = *previousConfig;
            if (restoreLoopStorage) {
                std::string storageError;
                if (!prepareLoopStorageLocked(
                        previousConfig->sampleRate,
                        previousConfig->nativeLooperStorageBudgetBytes,
                        storageError)) {
                    result += " Previous loop-storage format could not be restored: " + storageError;
                }
            }
            (void)nativePitchProcessor_.prepare(
                previousConfig->sampleRate,
                70.0f,
                1200.0f,
                nativePitchConfig_.semitones
            );
            (void)nativePolyPitchProcessor_.prepare(
                previousConfig->sampleRate,
                nativePitchConfig_.semitones
            );
            resetRuntimeStateLocked();
            if (wasRunning) {
                std::string restartError;
                if (!openStreamLocked(restartError)) {
                    result += " Previous audio configuration could not be restarted: " + restartError;
                }
            }
        } else {
            currentConfig_.reset();
        }
        error = std::move(result);
        updateLastErrorLocked(error);
        return false;
    };

    if (loopFormatChanged && hasNonEmptyTrackLocked()) {
        const auto failure = nonEmptyLoopError();
        if (wasRunning) {
            std::string restartError;
            if (!openStreamLocked(restartError)) {
                error = failure + " The previous audio stream could not be restarted: " + restartError;
                updateLastErrorLocked(error);
                return false;
            }
        }
        error = failure;
        updateLastErrorLocked(error);
        return false;
    }

    const bool pitchPrepared = nativePitchProcessor_.prepare(
        validated.sampleRate,
        70.0f,
        1200.0f,
        nativePitchConfig_.semitones
    );
    const bool polyPitchPrepared = nativePolyPitchProcessor_.prepare(
        validated.sampleRate,
        nativePitchConfig_.semitones
    );
    const bool selectedPitchPrepared = nativePitchConfig_.mode == NativePitchMode::LivePolyPhaseVocoder
        ? polyPitchPrepared
        : pitchPrepared;
    if (!selectedPitchPrepared && nativePitchConfig_.enabled) {
        error = nativePitchConfig_.mode == NativePitchMode::LivePolyPhaseVocoder
            ? "Native LIVE_POLY Signalsmith pitch could not allocate its pre-stream buffers."
            : "Native LIVE_MONO pitch could not allocate its pre-stream history buffers.";
        return restorePreviousConfiguration(error, false);
    }

    if (loopFormatChanged || nativeLooperMaxRecordSeconds_ == 0U) {
        if (!prepareLoopStorageLocked(validated.sampleRate, validated.nativeLooperStorageBudgetBytes, error)) {
            const std::string allocationError = error;
            return restorePreviousConfiguration(allocationError, loopFormatChanged || nativeLooperMaxRecordSeconds_ == 0U);
        }
    }

    currentConfig_ = validated;
    looper_.applyCommand({CommandType::SetMonitoring, currentConfig_->monitoringEnabled});
    resetRuntimeStateLocked();
    lastError_.clear();

    if (wasRunning && !openStreamLocked(error)) {
        const std::string openError = error;
        return restorePreviousConfiguration(openError, loopFormatChanged);
    }

    return true;
}

bool NativeAudioCore::start(std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        if (deviceCatalog_.backends.empty()) {
            error = "No supported native audio backend was detected.";
            updateLastErrorLocked(error);
            return false;
        }

        EngineConfig defaultConfig;
        defaultConfig.backend = Backend::Wasapi;
        const auto backendKey = backendToString(defaultConfig.backend);
        const auto inputs = deviceCatalog_.inputsByBackend[backendKey];
        const auto outputs = deviceCatalog_.outputsByBackend[backendKey];
        defaultConfig.inputDeviceId = deviceCatalog_.defaultInputIdByBackend[backendKey];
        defaultConfig.outputDeviceId = deviceCatalog_.defaultOutputIdByBackend[backendKey];
        if (defaultConfig.inputDeviceId.empty() && !inputs.empty()) {
            defaultConfig.inputDeviceId = inputs.front().id;
        }
        if (defaultConfig.outputDeviceId.empty() && !outputs.empty()) {
            defaultConfig.outputDeviceId = outputs.front().id;
        }
        defaultConfig.sampleRate = 48000;
        defaultConfig.bufferFrames = 128;
        if (!validateConfigLocked(defaultConfig, error)) {
            updateLastErrorLocked(error);
            return false;
        }
        if (!validateLoopStorageBudgetLocked(defaultConfig.sampleRate, defaultConfig.nativeLooperStorageBudgetBytes, error)) {
            updateLastErrorLocked(error);
            return false;
        }
        currentConfig_ = defaultConfig;
        if (!prepareLoopStorageLocked(currentConfig_->sampleRate, currentConfig_->nativeLooperStorageBudgetBytes, error)) {
            updateLastErrorLocked(error);
            return false;
        }
    }

    if (engineRunning_.load(std::memory_order_acquire)) {
        return true;
    }

    if (!openStreamLocked(error)) {
        updateLastErrorLocked(error);
        return false;
    }

    return true;
}

bool NativeAudioCore::stop(std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    (void)error;
    closeStreamLocked();
    return true;
}

bool NativeAudioCore::record(std::string& error) {
    return recordTrack(0U, error);
}

bool NativeAudioCore::recordTrack(std::size_t trackIndex, std::string& error) {
    return queueTrackCommand(CommandType::Record, trackIndex, error);
}

bool NativeAudioCore::stopTrack(std::size_t trackIndex, std::string& error) {
    return queueTrackCommand(CommandType::StopRecordOrPlayback, trackIndex, error);
}

bool NativeAudioCore::playTrack(std::size_t trackIndex, std::string& error) {
    return queueTrackCommand(CommandType::Play, trackIndex, error);
}

bool NativeAudioCore::toggleTrackOverdub(std::size_t trackIndex, std::string& error) {
    return queueTrackCommand(CommandType::ToggleOverdub, trackIndex, error);
}

bool NativeAudioCore::clearTrack(std::size_t trackIndex, std::string& error) {
    return queueTrackCommand(CommandType::Clear, trackIndex, error);
}

bool NativeAudioCore::queueTrackCommand(CommandType type, std::size_t trackIndex, std::string& error) {
    if (trackIndex >= kNativeTrackCount) {
        error = "Native track index must be between 0 and 4.";
        return false;
    }
    if (!engineRunning_.load(std::memory_order_acquire)) {
        error = "Engine is not running.";
        return false;
    }
    if (!commandQueue_.push({type, false, static_cast<std::uint8_t>(trackIndex)})) {
        error = "Command queue is full.";
        return false;
    }
    return true;
}

bool NativeAudioCore::stopRecordOrPlayback(std::string& error) {
    return stopTrack(0U, error);
}

bool NativeAudioCore::play(std::string& error) {
    return playTrack(0U, error);
}

bool NativeAudioCore::toggleOverdub(std::string& error) {
    return toggleTrackOverdub(0U, error);
}

bool NativeAudioCore::clear(std::string& error) {
    return clearTrack(0U, error);
}

bool NativeAudioCore::setMonitoring(bool enabled, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    currentConfig_->monitoringEnabled = enabled;
    if (!engineRunning_.load(std::memory_order_acquire)) {
        looper_.applyCommand({CommandType::SetMonitoring, enabled});
        return true;
    }
    if (!commandQueue_.push({CommandType::SetMonitoring, enabled})) {
        error = "Command queue is full.";
        return false;
    }
    return true;
}

bool NativeAudioCore::setOutputLowPassEnabled(bool enabled, std::string& error) {
    return setOutputEffectEnabled(NativeOutputEffect::LowPass, enabled, error);
}

bool NativeAudioCore::setOutputHighPassEnabled(bool enabled, std::string& error) {
    return setOutputEffectEnabled(NativeOutputEffect::HighPass, enabled, error);
}

bool NativeAudioCore::setNativeReverbConfig(const NativeReverbConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    if (!std::isfinite(config.wetMix) || !std::isfinite(config.rt60Seconds) ||
        !std::isfinite(config.dampingCutoffHz) ||
        config.wetMix < 0.0f || config.wetMix > 1.0f ||
        config.rt60Seconds < 0.1f || config.rt60Seconds > 20.0f ||
        config.dampingCutoffHz < 500.0f || config.dampingCutoffHz > 20000.0f) {
        error = "Native FDN16 reverb requires wetMix 0..1, rt60Seconds 0.1..20, and dampingCutoffHz 500..20000.";
        return false;
    }

    if (engineRunning_.load(std::memory_order_acquire)) {
        if (!nativeReverbCommandQueue_.push({config})) {
            error = "Native reverb command queue is full.";
            return false;
        }
    } else if (outputStage_.sampleRate() != 0U && !outputStage_.setReverbConfig(config, 0U)) {
        error = "Unable to apply the native FDN16 reverb configuration.";
        return false;
    }
    nativeReverbConfig_ = config;
    return true;
}

bool NativeAudioCore::setNativeFractionalDelayConfig(const NativeFractionalDelayConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    if (config.slot != NativeTrackOutputSlot::A) {
        error = "Only Native output slot A is active; slots B-D are not implemented.";
        return false;
    }
    if (config.algorithm != NativeFractionalDelayAlgorithm::Lagrange4 ||
        !std::isfinite(config.delayMs) || !std::isfinite(config.wetMix) || !std::isfinite(config.feedback) ||
        config.delayMs < 10.0f || config.delayMs > 2000.0f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f ||
        config.feedback < 0.0f || config.feedback > 0.95f) {
        error = "Native fractional delay requires algorithm lagrange4, delayMs 10-2000, wetMix 0-1, and feedback 0-0.95.";
        return false;
    }

    if (engineRunning_.load(std::memory_order_acquire)) {
        if (!nativeFractionalDelayCommandQueue_.push({config})) {
            error = "Native fractional-delay command queue is full.";
            return false;
        }
    } else if (outputStage_.sampleRate() != 0U && !outputStage_.setFractionalDelayConfig(config, 0U)) {
        error = "Unable to apply the Native fractional-delay configuration.";
        return false;
    }
    nativeFractionalDelayConfig_ = config;
    return true;
}

bool NativeAudioCore::setNativeCompressorConfig(const NativeCompressorConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    if (config.slot != NativeTrackOutputSlot::A) {
        error = "Only Native output slot A is active; slots B-D are not implemented.";
        return false;
    }
    if (config.algorithm != NativeCompressorAlgorithm::PeakCompressor ||
        !std::isfinite(config.thresholdDb) || !std::isfinite(config.ratio) ||
        !std::isfinite(config.attackMs) || !std::isfinite(config.releaseMs) ||
        !std::isfinite(config.wetMix) || !std::isfinite(config.makeupDb) ||
        config.thresholdDb < -60.0f || config.thresholdDb > 0.0f ||
        config.ratio < 1.0f || config.ratio > 20.0f ||
        config.attackMs < 0.1f || config.attackMs > 200.0f ||
        config.releaseMs < 5.0f || config.releaseMs > 2000.0f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f ||
        config.makeupDb < -12.0f || config.makeupDb > 12.0f) {
        error = "Native peak compressor requires thresholdDb -60 to 0, ratio 1 to 20, attackMs 0.1 to 200, releaseMs 5 to 2000, wetMix 0 to 1, and makeupDb -12 to 12.";
        return false;
    }

    if (engineRunning_.load(std::memory_order_acquire)) {
        if (!nativeCompressorCommandQueue_.push({config})) {
            error = "Native compressor command queue is full.";
            return false;
        }
    } else if (outputStage_.sampleRate() != 0U && !outputStage_.setCompressorConfig(config, 0U)) {
        error = "Unable to apply the Native peak-compressor configuration.";
        return false;
    }
    nativeCompressorConfig_ = config;
    return true;
}

bool NativeAudioCore::setNativeChorusConfig(const NativeChorusConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    if (config.slot != NativeTrackOutputSlot::A) {
        error = "Only Native output slot A is active; slots B-D are not implemented.";
        return false;
    }
    if (config.algorithm != NativeChorusAlgorithm::StereoLfoLagrange4 ||
        !std::isfinite(config.rateHz) || !std::isfinite(config.depthMs) ||
        !std::isfinite(config.feedback) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.1f || config.rateHz > 8.0f ||
        config.depthMs < 0.0f || config.depthMs > 25.0f ||
        config.feedback < 0.0f || config.feedback > 0.95f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        error = "Native stereo chorus requires rateHz 0.1-8, depthMs 0-25, feedback 0-0.95, and wetMix 0-1.";
        return false;
    }

    if (engineRunning_.load(std::memory_order_acquire)) {
        if (!nativeChorusCommandQueue_.push({config})) {
            error = "Native chorus command queue is full.";
            return false;
        }
    } else if (outputStage_.sampleRate() != 0U && !outputStage_.setChorusConfig(config, 0U)) {
        error = "Unable to apply the Native stereo-chorus configuration.";
        return false;
    }
    nativeChorusConfig_ = config;
    return true;
}

bool NativeAudioCore::setNativePhaserConfig(const NativePhaserConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    if (config.slot != NativeTrackOutputSlot::A) {
        error = "Only Native output slot A is active; slots B-D are not implemented.";
        return false;
    }
    if (config.algorithm != NativePhaserAlgorithm::AllpassSweep ||
        (config.stages != 4U && config.stages != 8U && config.stages != 12U) ||
        !std::isfinite(config.rateHz) || !std::isfinite(config.depth) ||
        !std::isfinite(config.feedback) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.05f || config.rateHz > 10.0f ||
        config.depth < 0.0f || config.depth > 1.0f ||
        config.feedback < -0.9f || config.feedback > 0.9f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        error = "Native allpass-sweep phaser requires stages 4, 8, or 12, rateHz 0.05-10, depth 0-1, feedback -0.9 to 0.9, and wetMix 0-1.";
        return false;
    }

    if (engineRunning_.load(std::memory_order_acquire)) {
        if (!nativePhaserCommandQueue_.push({config})) {
            error = "Native phaser command queue is full.";
            return false;
        }
    } else if (outputStage_.sampleRate() != 0U && !outputStage_.setPhaserConfig(config, 0U)) {
        error = "Unable to apply the Native allpass-sweep phaser configuration.";
        return false;
    }
    nativePhaserConfig_ = config;
    return true;
}

bool NativeAudioCore::setNativeCatalogSlot(
    NativeEffectSlot slot,
    const std::string& effectId,
    const std::map<std::string, float>& parameters,
    bool bypassed,
    std::string& error,
    NativeCatalogFxPath path,
    std::uint8_t trackId
) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    return configureNativeCatalogSlotLocked(slot, effectId, parameters, bypassed, error, path, trackId);
}

bool NativeAudioCore::queueNativeOscVocMidiEvent(
    NativeCatalogFxPath path,
    NativeEffectSlot slot,
    bool noteOn,
    int channel,
    int note,
    int velocity,
    std::uint64_t absoluteFrame,
    std::string& error,
    std::uint8_t trackId
) {
    return queueNativeCatalogMidiEvent("osc_voc_m", path, slot, noteOn, channel,
                                       note, velocity, absoluteFrame, error, trackId);
}

bool NativeAudioCore::queueNativeCatalogMidiEvent(
    std::string_view effectId,
    NativeCatalogFxPath path,
    NativeEffectSlot slot,
    bool noteOn,
    int channel,
    int note,
    int velocity,
    std::uint64_t absoluteFrame,
    std::string& error,
    std::uint8_t trackId
) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (effectId != "osc_voc_m" && effectId != "hrm_auto_m") {
        error = "Native catalog MIDI effect must be 'osc_voc_m' or 'hrm_auto_m'.";
        return false;
    }
    if (path != NativeCatalogFxPath::Input && path != NativeCatalogFxPath::Track) {
        error = "Native catalog MIDI path must be 'input' or 'track'.";
        return false;
    }
    if (static_cast<std::size_t>(slot) >= NativeEffectBank::kSlotCount) {
        error = "Native catalog MIDI slot must be A, B, C, or D.";
        return false;
    }
    if (!engineRunning_.load(std::memory_order_acquire)) {
        error = "Native catalog MIDI events require a running Native engine.";
        return false;
    }
    if (trackId > kNativeTrackCount || (path == NativeCatalogFxPath::Input && trackId != 0U)) {
        error = "Native catalog trackId must be 0 for Input or 0-5 for Track (0 is the shared bank).";
        return false;
    }
    auto& bank = path == NativeCatalogFxPath::Input ? nativeInputFxBank_
        : trackId == 0U ? outputStage_.trackFxBank() : nativePerTrackFxBanks_[trackId - 1U];
    auto* selectedProcessor = bank.processor(slot);
    if (selectedProcessor == nullptr || selectedProcessor->stableId() != effectId) {
        error = "The requested Native MIDI effect slot is not selected on that path.";
        return false;
    }
    auto* oscVocProcessor = effectId == "osc_voc_m"
        ? dynamic_cast<NativeOscVocProcessor*>(selectedProcessor) : nullptr;
    auto* hrmAutoProcessor = effectId == "hrm_auto_m"
        ? dynamic_cast<NativeHrmAutoProcessor*>(selectedProcessor) : nullptr;
    if (oscVocProcessor == nullptr && hrmAutoProcessor == nullptr) {
        error = "The requested Native MIDI effect processor is not wired.";
        return false;
    }
    const auto currentProcessorFrame = [&]() noexcept {
        return oscVocProcessor != nullptr ? oscVocProcessor->currentFrame() : hrmAutoProcessor->currentFrame();
    };
    const auto overflowCount = [&]() noexcept {
        return oscVocProcessor != nullptr ? oscVocProcessor->overflowEventCount() : hrmAutoProcessor->overflowEventCount();
    };
    const auto lateCount = [&]() noexcept {
        return oscVocProcessor != nullptr ? oscVocProcessor->lateEventCount() : hrmAutoProcessor->lateEventCount();
    };
    const auto rejectedCount = [&]() noexcept {
        return oscVocProcessor != nullptr ? oscVocProcessor->rejectedEventCount() : hrmAutoProcessor->rejectedEventCount();
    };
    const auto recordRejected = [&]() noexcept {
        if (oscVocProcessor != nullptr) oscVocProcessor->recordRejectedEvent();
        else hrmAutoProcessor->recordRejectedEvent();
    };
    const auto recordLate = [&]() noexcept {
        if (oscVocProcessor != nullptr) oscVocProcessor->recordLateEvent();
        else hrmAutoProcessor->recordLateEvent();
    };
    if (channel < 1 || channel > 16 || note < 0 || note > 127 ||
        velocity < 0 || velocity > 127 ||
        absoluteFrame == std::numeric_limits<std::uint64_t>::max()) {
        recordRejected();
        error = "Native catalog MIDI channel, note, velocity, or frame is outside its supported range.";
        return false;
    }

    const auto currentFrame = std::max(
        publishedCallbackFrameCursor_.load(std::memory_order_acquire),
        currentProcessorFrame());
    // HRM AUTO synchronizes its sample clock at each callback boundary. If a
    // slot is selected while the engine is already running, it may lag the
    // global frame briefly; future events are still safe because the next
    // callback advances its clock before processing.
    if (oscVocProcessor != nullptr && currentProcessorFrame() < currentFrame) {
        // This path did not process the latest callback block (for example,
        // an oversized input block was dropped). Reject until the callback
        // synchronizes its local clock, rather than enqueueing an event that
        // would fire late when this slot next runs.
        recordLate();
        error = "Native MIDI event path sample clock is behind the engine; retry at a future sample frame.";
        return false;
    }
    if (absoluteFrame < currentFrame) {
        recordLate();
        error = "Native catalog MIDI event frame is late; use the current or a future sample frame.";
        return false;
    }
    const auto lateBefore = lateCount();
    const auto overflowBefore = overflowCount();
    const auto rejectedBefore = rejectedCount();
    const bool queued = oscVocProcessor != nullptr
        ? (noteOn
            ? oscVocProcessor->queueNoteOn(channel - 1, note, velocity, absoluteFrame)
            : oscVocProcessor->queueNoteOff(channel - 1, note, absoluteFrame))
        : hrmAutoProcessor->queueMidiEvent(noteOn, channel, note, velocity, absoluteFrame);
    if (!queued) {
        const auto statusFrame = currentProcessorFrame();
        if (lateCount() != lateBefore || absoluteFrame < statusFrame ||
            absoluteFrame < publishedCallbackFrameCursor_.load(std::memory_order_acquire)) {
            error = "Native catalog MIDI event frame is late; use the current or a future sample frame.";
        } else if (overflowCount() != overflowBefore) {
            error = "Native catalog MIDI event queue is full.";
        } else if (rejectedCount() != rejectedBefore) {
            error = "Native catalog MIDI event was rejected for its configured channel or timestamp order.";
        } else {
            error = "Native catalog MIDI event was rejected; timestamps must be nondecreasing.";
        }
        return false;
    }
    error.clear();
    return true;
}

bool NativeAudioCore::configureNativeCatalogSlotLocked(
    NativeEffectSlot slot,
    const std::string& effectId,
    const std::map<std::string, float>& parameters,
    bool bypassed,
    std::string& error,
    NativeCatalogFxPath path,
    std::uint8_t trackId
) {
    const auto slotIndex = static_cast<std::size_t>(slot);
    if (slotIndex >= NativeEffectBank::kSlotCount) {
        error = "Native catalog FX slot must be A, B, C, or D.";
        return false;
    }
    if (path != NativeCatalogFxPath::Input && path != NativeCatalogFxPath::Track) {
        error = "Native catalog FX path must be 'input' or 'track'.";
        return false;
    }
    if (trackId > kNativeTrackCount || (path == NativeCatalogFxPath::Input && trackId != 0U)) {
        error = "Native catalog trackId must be 0 for Input or 0-5 for Track (0 is the shared bank).";
        return false;
    }
    auto& bank = path == NativeCatalogFxPath::Input ? nativeInputFxBank_
        : trackId == 0U ? outputStage_.trackFxBank() : nativePerTrackFxBanks_[trackId - 1U];
    auto& bypassedSlots = path == NativeCatalogFxPath::Input
        ? nativeInputCatalogSlotBypassed_
        : trackId == 0U ? nativeCatalogSlotBypassed_ : nativePerTrackSlotBypassed_[trackId - 1U];
    if (effectId.empty()) {
        if (!parameters.empty()) {
            error = "Clearing a Native catalog FX slot cannot include parameters.";
            return false;
        }
        if (engineRunning_.load(std::memory_order_acquire)) {
            error = "Stop Native audio before clearing or replacing a catalog FX slot.";
            return false;
        }
        if (!bank.clearSlot(slot)) {
            error = "Unable to clear the requested Native catalog FX slot.";
            return false;
        }
        bypassedSlots[slotIndex] = false;
        if (trackId != 0U) {
            nativePerTrackFxPublished_[trackId - 1U][slotIndex].appliedBypassed.store(false, std::memory_order_release);
            nativePerTrackFxPublished_[trackId - 1U][slotIndex].processingFaulted.store(false, std::memory_order_release);
            nativePerTrackFxPublished_[trackId - 1U][slotIndex].appliedRevision.store(
                ++nativePerTrackSlotRevision_[trackId - 1U][slotIndex], std::memory_order_release);
        }
        return true;
    }

    const std::string_view stableId(effectId);
    if (trackId != 0U && (stableId == "beat_shift" || stableId == "vinyl_flick")) {
        error = "Source-aware BEAT SHIFT/VINYL FLICK cannot occupy ordered per-track A-D insert slots. Use the separate experimental pre-insert loop-transport route.";
        return false;
    }
    const auto* effectDescriptor = findNativeEffectDescriptor(stableId);
    if (effectDescriptor == nullptr) {
        error = "Unknown or unimplemented Native catalog FX ID: " + effectId;
        return false;
    }
    if ((path == NativeCatalogFxPath::Input && !effectDescriptor->inputAvailable) ||
        (path == NativeCatalogFxPath::Track && !effectDescriptor->trackAvailable)) {
        error = "Native catalog FX " + effectId + " is not available on the requested " +
            (path == NativeCatalogFxPath::Input ? std::string("input") : std::string("track")) + " path.";
        return false;
    }
    if (trackId != 0U && !nativeEffectSupportsPerTrackInsert(stableId)) {
        error = "Native catalog FX " + effectId + " is not available in ordered per-track A-D insert slots.";
        return false;
    }
    for (const auto& [parameterId, value] : parameters) {
        const auto* descriptor = findNativeEffectParameter(stableId, std::string_view(parameterId));
        if (descriptor == nullptr || !std::isfinite(value) || value < descriptor->minimum || value > descriptor->maximum) {
            error = "Invalid Native catalog FX parameter '" + parameterId + "' for " + effectId + ".";
            return false;
        }
        if (descriptor->discrete) {
            bool supported = false;
            for (std::size_t index = 0U; index < descriptor->discreteValueCount; ++index) {
                supported = supported || value == descriptor->discreteValues[index];
            }
            if (!supported) {
                error = "Unsupported discrete Native catalog FX value for parameter '" + parameterId + "'.";
                return false;
            }
        }
    }

    if (engineRunning_.load(std::memory_order_acquire)) {
        if (bank.effectId(slot) != stableId) {
            error = "Stop Native audio before changing the FX type in a catalog slot; live parameter edits require the currently selected effect.";
            return false;
        }
        const std::size_t requiredCommands = parameters.size() + 1U;
        constexpr std::size_t kUsableQueueCapacity = 63U;
        if (nativeCatalogFxCommandQueue_.size() + requiredCommands > kUsableQueueCapacity) {
            error = "Native catalog FX command queue is full.";
            return false;
        }
        const std::uint64_t revision = trackId == 0U ? 0U : ++nativePerTrackSlotRevision_[trackId - 1U][slotIndex];
        for (const auto& [parameterId, value] : parameters) {
            std::size_t parameterIndex = 0U;
            for (; parameterIndex < effectDescriptor->parameterCount; ++parameterIndex) {
                if (effectDescriptor->parameters[parameterIndex].id == std::string_view(parameterId)) break;
            }
            if (parameterIndex >= effectDescriptor->parameterCount || parameterIndex > 255U ||
                !nativeCatalogFxCommandQueue_.push({
                    NativeCatalogFxCommand::Type::SetParameter,
                    path,
                    slot,
                    static_cast<std::uint8_t>(parameterIndex),
                    value,
                    trackId,
                    revision
                })) {
                error = "Unable to queue a Native catalog FX parameter update.";
                return false;
            }
        }
        if (!nativeCatalogFxCommandQueue_.push({
                NativeCatalogFxCommand::Type::SetBypassed,
                path,
                slot,
                0U,
                bypassed ? 1.0f : 0.0f,
                trackId,
                revision
            })) {
            error = "Unable to queue a Native catalog FX bypass update.";
            return false;
        }
        bypassedSlots[slotIndex] = bypassed;
        return true;
    }

    if (trackId != 0U && (!currentConfig_ ||
        (bank.sampleRate() != currentConfig_->sampleRate && !bank.prepare(currentConfig_->sampleRate)))) {
        error = "Configure Native audio before preparing a per-track catalog bank.";
        return false;
    }
    if (!bank.setEffect(slot, stableId)) {
        error = "Unable to instantiate Native catalog FX " + effectId + ".";
        return false;
    }
    for (const auto& [parameterId, value] : parameters) {
        if (!bank.setParameter(slot, std::string_view(parameterId), value)) {
            error = "Unable to set Native catalog FX parameter '" + parameterId + "'.";
            (void)bank.clearSlot(slot);
            return false;
        }
    }
    if (stableId == "beat_repeat" && parameters.find("bpm") == parameters.end() &&
        !bank.setParameter(slot, "bpm", static_cast<float>(nativeRhythmConfig_.bpm), 0U)) {
        error = "Unable to initialize Native Beat Repeat from the current rhythm transport BPM.";
        (void)bank.clearSlot(slot);
        return false;
    }
    if (stableId == "reverse_reverb" && parameters.find("bpm") == parameters.end() &&
        !bank.setParameter(slot, "bpm", static_cast<float>(nativeRhythmConfig_.bpm), 0U)) {
        error = "Unable to initialize Native Reverse Reverb from the current rhythm transport BPM.";
        (void)bank.clearSlot(slot);
        return false;
    }
    if (stableId == "auto_riff" && parameters.find("bpm") == parameters.end() &&
        !bank.setParameter(slot, "bpm", static_cast<float>(nativeRhythmConfig_.bpm), 0U)) {
        error = "Unable to initialize Native AUTO RIFF from the current rhythm transport BPM.";
        (void)bank.clearSlot(slot);
        return false;
    }
    if (!bank.setBypassed(slot, bypassed)) {
        error = "Unable to set Native catalog FX bypass state.";
        (void)bank.clearSlot(slot);
        return false;
    }
    bypassedSlots[slotIndex] = bypassed;
    if (trackId != 0U) {
        nativePerTrackFxPublished_[trackId - 1U][slotIndex].appliedBypassed.store(bypassed, std::memory_order_release);
        nativePerTrackFxPublished_[trackId - 1U][slotIndex].processingFaulted.store(false, std::memory_order_release);
        nativePerTrackFxPublished_[trackId - 1U][slotIndex].appliedRevision.store(
            ++nativePerTrackSlotRevision_[trackId - 1U][slotIndex], std::memory_order_release);
    }
    return true;
}

bool NativeAudioCore::setNativeAutoPanConfig(const NativeAutoPanConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    if (config.slot != NativeTrackOutputSlot::A) {
        error = "Native AUTO PAN compatibility route maps to catalog slot A; use the catalog slots endpoint for A-D routing.";
        return false;
    }
    const bool validWaveform = config.waveform == NativeAutoPanWaveform::Sine ||
        config.waveform == NativeAutoPanWaveform::Triangle ||
        config.waveform == NativeAutoPanWaveform::Square;
    if (config.algorithm != NativeAutoPanAlgorithm::EqualPowerMidSideLfo || !validWaveform ||
        !std::isfinite(config.rateHz) || !std::isfinite(config.depth) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.05f || config.rateHz > 20.0f ||
        config.depth < 0.0f || config.depth > 1.0f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        error = "Native equal-power AUTO PAN requires rateHz 0.05-20, depth 0-1, a sine/triangle/square waveform, and wetMix 0-1.";
        return false;
    }
    const std::map<std::string, float> parameters{
        {"rate_hz", config.rateHz},
        {"depth", config.depth},
        {"waveform", static_cast<float>(config.waveform)},
        {"wet_mix", config.wetMix},
    };
    if (!configureNativeCatalogSlotLocked(
            NativeEffectSlot::A,
            "auto_pan",
            parameters,
            !config.enabled,
            error,
            NativeCatalogFxPath::Track)) {
        return false;
    }
    nativeAutoPanConfig_ = config;
    return true;
}

bool NativeAudioCore::setNativePitchConfig(const NativePitchConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    if (config.mode != NativePitchMode::LiveMonoKeepPitch &&
        config.mode != NativePitchMode::LivePolyPhaseVocoder) {
        error = "Native pitch mode is unsupported.";
        return false;
    }
    if (config.trackId > kNativeTrackCount) {
        error = "Native pitch trackId must be 0 (global) or a track ID from 1 to 5.";
        return false;
    }
    if (!std::isfinite(config.semitones) || config.semitones < -12.0f || config.semitones > 12.0f) {
        error = "Native pitch semitones must be between -12 and +12.";
        return false;
    }

    if (!engineRunning_.load(std::memory_order_acquire)) {
        if (config.mode == NativePitchMode::LivePolyPhaseVocoder) {
            if (!nativePolyPitchProcessor_.prepared() && !nativePolyPitchProcessor_.prepare(
                    currentConfig_->sampleRate, config.semitones)) {
                error = "Unable to prepare the Native LIVE_POLY Signalsmith processor for this sample rate.";
                return false;
            }
        } else if (!nativePitchProcessor_.prepared() && !nativePitchProcessor_.prepare(
                currentConfig_->sampleRate, 70.0f, 1200.0f, config.semitones)) {
            error = "Unable to prepare the Native LIVE_MONO pitch processor for this sample rate.";
            return false;
        }
        const bool resetProcessor = config.enabled != nativePitchConfig_.enabled ||
            config.trackId != nativePitchConfig_.trackId ||
            config.reversePlayback != nativePitchConfig_.reversePlayback ||
            config.mode != nativePitchConfig_.mode;
        const bool selectedShiftUpdated = config.mode == NativePitchMode::LivePolyPhaseVocoder
            ? nativePolyPitchProcessor_.setSemitones(config.semitones)
            : nativePitchProcessor_.setSemitones(config.semitones);
        if (!selectedShiftUpdated) {
            error = config.mode == NativePitchMode::LivePolyPhaseVocoder
                ? "Unable to set the Native LIVE_POLY pitch shift."
                : "Unable to set the Native LIVE_MONO pitch shift.";
            return false;
        }
        if (nativePitchProcessor_.prepared()) (void)nativePitchProcessor_.setSemitones(config.semitones);
        if (nativePolyPitchProcessor_.prepared()) (void)nativePolyPitchProcessor_.setSemitones(config.semitones);
        if (resetProcessor) {
            nativePitchProcessor_.reset();
            nativePolyPitchProcessor_.reset();
        }
        nativePitchRuntimeEnabled_ = config.enabled;
        nativePitchRuntimeTrackId_ = config.trackId;
        nativePitchRuntimeMode_ = config.mode;
        nativePitchRuntimeReverse_ = config.reversePlayback;
        nativePitchConfig_ = config;
        nativePitchActive_.store(false, std::memory_order_release);
        nativePitchVoiced_.store(config.mode == NativePitchMode::LiveMonoKeepPitch && nativePitchProcessor_.voiced(), std::memory_order_release);
        nativePitchFrequencyHz_.store(config.mode == NativePitchMode::LiveMonoKeepPitch ? nativePitchProcessor_.frequencyHz() : 0.0f, std::memory_order_release);
        nativePitchConfidence_.store(config.mode == NativePitchMode::LiveMonoKeepPitch ? nativePitchProcessor_.confidence() : 0.0f, std::memory_order_release);
        nativePitchFallbackReason_.store(NativePitchFallbackReason::NotRequested, std::memory_order_release);
        return true;
    }

    const bool requestedModePrepared = config.mode == NativePitchMode::LivePolyPhaseVocoder
        ? nativePolyPitchProcessor_.prepared()
        : nativePitchProcessor_.prepared();
    if (!requestedModePrepared) {
        error = "The requested Native pitch mode was not prepared before the audio stream started.";
        return false;
    }

    const bool resetProcessor = config.enabled != nativePitchConfig_.enabled ||
        config.trackId != nativePitchConfig_.trackId ||
        config.reversePlayback != nativePitchConfig_.reversePlayback ||
        config.mode != nativePitchConfig_.mode;
    if (!nativePitchCommandQueue_.push({config, resetProcessor})) {
        error = "Native pitch command queue is full.";
        return false;
    }
    if (resetProcessor) {
        // Do not report the previous target as active in the request ACK while
        // the callback-boundary route change is still queued.
        nativePitchActive_.store(false, std::memory_order_release);
        nativePitchVoiced_.store(false, std::memory_order_release);
        nativePitchFrequencyHz_.store(0.0f, std::memory_order_release);
        nativePitchConfidence_.store(0.0f, std::memory_order_release);
        nativePitchFallbackReason_.store(NativePitchFallbackReason::NotRequested, std::memory_order_release);
    }
    nativePitchConfig_ = config;
    return true;
}

bool NativeAudioCore::setNativeLoopTransport(
    std::size_t trackIndex,
    const LoopTransportConfig& config,
    std::string& error
) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (trackIndex >= kNativeTrackCount) {
        error = "Native loop transport track index must be between 0 and 4.";
        return false;
    }
    if (!LooperCore::validLoopTransportConfig(config)) {
        error = "Native loop transport configuration is outside the supported Beat Shift/Vinyl Flick ranges.";
        return false;
    }
    if (config.mode == LoopTransportMode::VinylFlick &&
        looperForTrack(trackIndex).sampleRate() < 8000U) {
        error = "Native Vinyl Flick requires a loop sample rate of at least 8000 Hz.";
        return false;
    }
    if (engineRunning_.load(std::memory_order_acquire)) {
        if (!nativeLoopTransportCommandQueue_.push({trackIndex, config})) {
            error = "Native loop transport command queue is full.";
            return false;
        }
    } else {
        if (!looperForTrack(trackIndex).setLoopTransportConfig(config)) {
            error = "Unable to apply the Native loop transport configuration.";
            return false;
        }
        trackLoopTransportStatus_[trackIndex].store(
            looperForTrack(trackIndex).loopTransportStatus(), std::memory_order_release);
    }
    error.clear();
    return true;
}

bool NativeAudioCore::setOutputEffectEnabled(NativeOutputEffect effect, bool enabled, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }

    if (!engineRunning_.load(std::memory_order_acquire)) {
        outputStage_.setEffectEnabled(effect, enabled, 0);
        switch (effect) {
        case NativeOutputEffect::LowPass:
            outputLowPassEnabled_.store(enabled, std::memory_order_release);
            break;
        case NativeOutputEffect::HighPass:
            outputHighPassEnabled_.store(enabled, std::memory_order_release);
            break;
        }
        return true;
    }

    if (!outputStageCommandQueue_.push({effect, enabled})) {
        error = "Output DSP command queue is full.";
        return false;
    }
    switch (effect) {
    case NativeOutputEffect::LowPass:
        outputLowPassEnabled_.store(enabled, std::memory_order_release);
        break;
    case NativeOutputEffect::HighPass:
        outputHighPassEnabled_.store(enabled, std::memory_order_release);
        break;
    }
    return true;
}

bool NativeAudioCore::setNativeRhythmConfig(const NativeRhythmConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    const bool validVariation = config.variation == NativeRhythmVariation::A ||
        config.variation == NativeRhythmVariation::B ||
        config.variation == NativeRhythmVariation::C ||
        config.variation == NativeRhythmVariation::D;
    const bool validSection = config.section == NativeRhythmSection::Main ||
        config.section == NativeRhythmSection::Intro ||
        config.section == NativeRhythmSection::Ending ||
        config.section == NativeRhythmSection::Fill;
    const bool validQuantizeGrid = config.quantizeGrid == NativeRhythmQuantizeGrid::Sixteenth ||
        config.quantizeGrid == NativeRhythmQuantizeGrid::Eighth ||
        config.quantizeGrid == NativeRhythmQuantizeGrid::Quarter;
    if (!std::isfinite(config.bpm) || config.bpm < 40.0 || config.bpm > 300.0 ||
        config.kitIndex < 1U || config.kitIndex > 16U || !validVariation || !validSection ||
        !validQuantizeGrid || config.swingPercent < 50U || config.swingPercent > 75U || config.volume > 100U ||
        nativeRhythmPatternByIndex(config.patternIndex) == nullptr) {
        error = "Native rhythm requires BPM 40-300, kit 1-16, pattern 1-240, variation A-D, section main/intro/ending/fill, swing 50-75, quantize 1/16|1/8|1/4, and volume 0-100.";
        return false;
    }

    std::array<NativeCatalogFxCommand, (kNativeTrackCount + 2U) * NativeEffectBank::kSlotCount> tempoCommands{};
    std::size_t count = 0U;
    const auto collectTempoCommands = [&](const NativeEffectBank& bank, NativeCatalogFxPath path, std::uint8_t trackId) {
        for (std::size_t slotIndex = 0U; slotIndex < NativeEffectBank::kSlotCount; ++slotIndex) {
            const auto slot = static_cast<NativeEffectSlot>(slotIndex);
            const auto id = bank.effectId(slot);
            if (id != "beat_repeat" && id != "reverse_reverb" && id != "auto_riff") continue;
            const auto* descriptor = findNativeEffectDescriptor(id);
            if (descriptor == nullptr) return false;
            std::size_t parameter = 0U;
            while (parameter < descriptor->parameterCount && descriptor->parameters[parameter].id != "bpm") ++parameter;
            if (parameter >= descriptor->parameterCount || parameter > 255U) return false;
            tempoCommands[count++] = {NativeCatalogFxCommand::Type::SetParameter, path, slot,
                static_cast<std::uint8_t>(parameter), static_cast<float>(config.bpm), trackId};
        }
        return true;
    };
    bool valid = collectTempoCommands(nativeInputFxBank_, NativeCatalogFxPath::Input, 0U) &&
        collectTempoCommands(outputStage_.trackFxBank(), NativeCatalogFxPath::Track, 0U);
    for (std::size_t track = 0U; track < kNativeTrackCount && valid; ++track) {
        valid = collectTempoCommands(nativePerTrackFxBanks_[track], NativeCatalogFxPath::Track,
            static_cast<std::uint8_t>(track + 1U));
    }
    if (!valid) {
        error = "Native tempo-based FX descriptor is unavailable for tempo synchronization.";
        return false;
    }
    if (engineRunning_.load(std::memory_order_acquire)) {
        if (nativeCatalogFxCommandQueue_.size() + count > 63U || nativeRhythmCommandQueue_.size() >= 15U) {
            error = "Native catalog FX command queue is full while synchronizing tempo-based catalog FX.";
            return false;
        }
        (void)nativeRhythmCommandQueue_.push(config);
        for (std::size_t index = 0U; index < count; ++index) (void)nativeCatalogFxCommandQueue_.push(tempoCommands[index]);
    } else {
        if (nativeRhythmEngine_.sampleRate() != 0U && !nativeRhythmEngine_.setConfig(config, callbackFrameCursor_)) {
            error = "Unable to apply the native rhythm configuration.";
            return false;
        }
        for (std::size_t index = 0U; index < count; ++index) {
            const auto& command = tempoCommands[index];
            auto& bank = command.path == NativeCatalogFxPath::Input ? nativeInputFxBank_
                : command.trackId == 0U ? outputStage_.trackFxBank() : nativePerTrackFxBanks_[command.trackId - 1U];
            if (!bank.setParameter(command.slot, "bpm", command.value, 0U)) {
                error = "Unable to synchronize Native catalog FX with rhythm BPM.";
                return false;
            }
        }
    }
    nativeRhythmConfig_ = config;
    return true;
}

bool NativeAudioCore::captureLoopSnapshot(
    std::vector<float>& samples,
    unsigned int& sampleRate,
    std::string& error
) {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    std::lock_guard<std::mutex> snapshotLock(loopSnapshotMutex_);
    samples.clear();
    sampleRate = 0U;

    if (!currentConfig_ || !engineRunning_.load(std::memory_order_acquire)) {
        error = "Native HQ WAV export requires a running audio engine.";
        return false;
    }

    loopSnapshotAcknowledged_.store(false, std::memory_order_relaxed);
    loopSnapshotEligible_.store(false, std::memory_order_relaxed);
    loopSnapshotState_.store(LooperState::Empty, std::memory_order_relaxed);
    loopSnapshotTrackIndex_.store(0U, std::memory_order_relaxed);
    loopSnapshotRequested_.store(true, std::memory_order_release);

    constexpr auto snapshotTimeout = std::chrono::milliseconds(1000);
    const auto deadline = std::chrono::steady_clock::now() + snapshotTimeout;
    while (!loopSnapshotAcknowledged_.load(std::memory_order_acquire)) {
        if (std::chrono::steady_clock::now() >= deadline) {
            loopSnapshotRequested_.store(false, std::memory_order_release);
            error = "Native HQ WAV export could not synchronize with the audio callback.";
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    const auto snapshotState = loopSnapshotState_.load(std::memory_order_acquire);
    if (snapshotState == LooperState::Empty) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        error = "Native HQ WAV export requires a finalized, non-empty loop.";
        return false;
    }
    if (!loopSnapshotEligible_.load(std::memory_order_acquire)) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        error = "Stop recording or overdubbing before exporting a Native HQ WAV.";
        return false;
    }

    const auto frameCount64 = looper_.loopLengthSamples();
    if (frameCount64 == 0U || frameCount64 > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        error = "Native HQ WAV export requires a finalized, non-empty loop.";
        return false;
    }

    const auto frameCount = static_cast<std::size_t>(frameCount64);
    try {
        samples.resize(frameCount);
    } catch (const std::exception&) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        samples.clear();
        error = "Not enough memory to copy the Native loop for HQ WAV export.";
        return false;
    }

    std::size_t copiedFrames = 0U;
    if (!looper_.copyFinalizedLoopSnapshot(samples.data(), samples.size(), copiedFrames) ||
        copiedFrames != frameCount) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        samples.clear();
        error = "Native loop changed before its HQ WAV snapshot could be copied.";
        return false;
    }

    sampleRate = currentConfig_->sampleRate;
    loopSnapshotRequested_.store(false, std::memory_order_release);
    return true;
}

bool NativeAudioCore::captureTrackSnapshot(
    std::size_t trackIndex,
    std::vector<float>& interleavedStereo,
    unsigned int& sampleRate,
    std::string& error,
    std::size_t maximumFrameCount
) {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    std::lock_guard<std::mutex> snapshotLock(loopSnapshotMutex_);
    interleavedStereo.clear();
    sampleRate = 0U;
    if (trackIndex >= kNativeTrackCount) {
        error = "Native track index must be between 0 and 4.";
        return false;
    }
    if (!currentConfig_ || !engineRunning_.load(std::memory_order_acquire)) {
        error = "Native track export requires a running audio engine.";
        return false;
    }

    // The previous callback pin may still be held even after its control-side
    // copy returned. A fresh release acknowledgement prevents a new request
    // for another track from reusing that old callback's track/state snapshot.
    loopSnapshotReleaseAcknowledged_.store(false, std::memory_order_relaxed);
    loopSnapshotReleaseRequested_.store(true, std::memory_order_release);
    loopSnapshotRequested_.store(false, std::memory_order_release);
    constexpr auto releaseTimeout = std::chrono::milliseconds(1000);
    const auto releaseDeadline = std::chrono::steady_clock::now() + releaseTimeout;
    while (!loopSnapshotReleaseAcknowledged_.load(std::memory_order_acquire)) {
        if (std::chrono::steady_clock::now() >= releaseDeadline) {
            error = "Native track export could not release the previous callback snapshot pin.";
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    loopSnapshotTrackIndex_.store(trackIndex, std::memory_order_relaxed);
    loopSnapshotAcknowledged_.store(false, std::memory_order_relaxed);
    loopSnapshotEligible_.store(false, std::memory_order_relaxed);
    loopSnapshotState_.store(LooperState::Empty, std::memory_order_relaxed);
    loopSnapshotRequested_.store(true, std::memory_order_release);
    constexpr auto snapshotTimeout = std::chrono::milliseconds(1000);
    const auto deadline = std::chrono::steady_clock::now() + snapshotTimeout;
    while (!loopSnapshotAcknowledged_.load(std::memory_order_acquire)) {
        if (std::chrono::steady_clock::now() >= deadline) {
            loopSnapshotRequested_.store(false, std::memory_order_release);
            error = "Native track export could not synchronize with the audio callback.";
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    const auto snapshotState = loopSnapshotState_.load(std::memory_order_acquire);
    if (snapshotState == LooperState::Empty) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        error = "Native track export requires a finalized, non-empty loop.";
        return false;
    }
    if (!loopSnapshotEligible_.load(std::memory_order_acquire)) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        error = "Stop recording or overdubbing before exporting a Native track.";
        return false;
    }

    const auto& track = looperForTrack(trackIndex);
    const auto frameCount64 = track.loopLengthSamples();
    if (frameCount64 == 0U || frameCount64 > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max() / 2U)) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        error = "Native track export requires a finalized, non-empty loop.";
        return false;
    }
    const auto frameCount = static_cast<std::size_t>(frameCount64);
    if (frameCount > maximumFrameCount) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        error = "Native HQ WAV export exceeds its admitted memory budget; the loop was not changed.";
        return false;
    }
    try {
        interleavedStereo.resize(frameCount * 2U);
    } catch (const std::exception&) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        interleavedStereo.clear();
        error = "Not enough memory to copy the Native stereo track for export.";
        return false;
    }
    std::size_t copiedFrames = 0U;
    if (!track.copyFinalizedStereoLoopSnapshot(interleavedStereo.data(), frameCount, copiedFrames) || copiedFrames != frameCount) {
        loopSnapshotRequested_.store(false, std::memory_order_release);
        interleavedStereo.clear();
        error = "Native track changed before its stereo snapshot could be copied.";
        return false;
    }
    sampleRate = currentConfig_->sampleRate;
    loopSnapshotRequested_.store(false, std::memory_order_release);
    return true;
}

bool NativeAudioCore::getTrackSnapshotMetadata(
    std::size_t trackIndex,
    std::size_t& frameCount,
    unsigned int& sampleRate,
    std::string& error
) {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    std::lock_guard<std::mutex> snapshotLock(loopSnapshotMutex_);
    frameCount = 0U;
    sampleRate = 0U;
    if (trackIndex >= kNativeTrackCount) {
        error = "Native track index must be between 0 and 4.";
        return false;
    }
    if (!currentConfig_ || !engineRunning_.load(std::memory_order_acquire)) {
        error = "Native track export requires a running audio engine.";
        return false;
    }

    loopSnapshotReleaseAcknowledged_.store(false, std::memory_order_relaxed);
    loopSnapshotReleaseRequested_.store(true, std::memory_order_release);
    loopSnapshotRequested_.store(false, std::memory_order_release);
    constexpr auto releaseTimeout = std::chrono::milliseconds(1000);
    const auto releaseDeadline = std::chrono::steady_clock::now() + releaseTimeout;
    while (!loopSnapshotReleaseAcknowledged_.load(std::memory_order_acquire)) {
        if (std::chrono::steady_clock::now() >= releaseDeadline) {
            error = "Native track metadata could not release the previous callback snapshot pin.";
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    loopSnapshotTrackIndex_.store(trackIndex, std::memory_order_relaxed);
    loopSnapshotAcknowledged_.store(false, std::memory_order_relaxed);
    loopSnapshotEligible_.store(false, std::memory_order_relaxed);
    loopSnapshotState_.store(LooperState::Empty, std::memory_order_relaxed);
    loopSnapshotRequested_.store(true, std::memory_order_release);
    const auto cancelSnapshot = [this]() {
        loopSnapshotRequested_.store(false, std::memory_order_release);
    };
    constexpr auto snapshotTimeout = std::chrono::milliseconds(1000);
    const auto deadline = std::chrono::steady_clock::now() + snapshotTimeout;
    while (!loopSnapshotAcknowledged_.load(std::memory_order_acquire)) {
        if (std::chrono::steady_clock::now() >= deadline) {
            cancelSnapshot();
            error = "Native track metadata could not synchronize with the audio callback.";
            return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }

    const auto snapshotState = loopSnapshotState_.load(std::memory_order_acquire);
    if (snapshotState == LooperState::Empty) {
        cancelSnapshot();
        error = "Native track export requires a finalized, non-empty loop.";
        return false;
    }
    if (!loopSnapshotEligible_.load(std::memory_order_acquire)) {
        cancelSnapshot();
        error = "Stop recording or overdubbing before exporting a Native track.";
        return false;
    }

    const auto frameCount64 = looperForTrack(trackIndex).loopLengthSamples();
    if (frameCount64 == 0U ||
        frameCount64 > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max() / 2U)) {
        cancelSnapshot();
        error = "Native track export requires a finalized, non-empty loop.";
        return false;
    }
    frameCount = static_cast<std::size_t>(frameCount64);
    sampleRate = currentConfig_->sampleRate;
    cancelSnapshot();
    return true;
}

DeviceCatalog NativeAudioCore::buildCatalog() const {
    DeviceCatalog catalog;
    catalog.bufferOptions = {64, 128, 256, 512, 1024};

    for (const auto api : compiledApis()) {
        const auto backend = api == RtAudio::WINDOWS_ASIO ? Backend::Asio : Backend::Wasapi;
        const auto backendKey = backendToString(backend);

        try {
            RtAudio audio(api);
            const auto ids = audio.getDeviceIds();
            const auto defaultInputId = audio.getDefaultInputDevice();
            const auto defaultOutputId = audio.getDefaultOutputDevice();

            catalog.backends.push_back(backendKey);

            for (const auto deviceId : ids) {
                const auto info = audio.getDeviceInfo(deviceId);
                DeviceDescriptor descriptor;
                descriptor.id = makeDeviceId(backendKey, deviceId);
                descriptor.name = info.name;
                descriptor.sampleRates = info.sampleRates;
                descriptor.maxInputChannels = info.inputChannels;
                descriptor.maxOutputChannels = info.outputChannels;

                if (info.inputChannels > 0) {
                    descriptor.isDefault = deviceId == defaultInputId;
                    catalog.inputsByBackend[backendKey].push_back(descriptor);
                    if (descriptor.isDefault) {
                        catalog.defaultInputIdByBackend[backendKey] = descriptor.id;
                    }
                }

                if (info.outputChannels > 0) {
                    descriptor.isDefault = deviceId == defaultOutputId;
                    catalog.outputsByBackend[backendKey].push_back(descriptor);
                    if (descriptor.isDefault) {
                        catalog.defaultOutputIdByBackend[backendKey] = descriptor.id;
                    }
                }
            }
        } catch (...) {
        }
    }

    return catalog;
}

std::vector<RtAudio::Api> NativeAudioCore::compiledApis() const {
    std::vector<RtAudio::Api> apis{RtAudio::WINDOWS_WASAPI};
#ifdef RTAUDIO_API_ASIO
    apis.push_back(RtAudio::WINDOWS_ASIO);
#endif
    return apis;
}

bool NativeAudioCore::ensureAudioInstanceLocked(std::unique_ptr<RtAudio>& instance, Backend backend, std::string& error) {
    const auto desiredApi = toRtAudioApi(backend);
    if (!instance || instance->getCurrentApi() != desiredApi) {
        instance = std::make_unique<RtAudio>(desiredApi);
    }
    if (!instance) {
        error = "Failed to create RtAudio instance.";
        return false;
    }
    return true;
}

bool NativeAudioCore::validateConfigLocked(EngineConfig& config, std::string& error) const {
    const auto backendKey = backendToString(config.backend);
    const auto inputsIt = deviceCatalog_.inputsByBackend.find(backendKey);
    const auto outputsIt = deviceCatalog_.outputsByBackend.find(backendKey);

    if (inputsIt == deviceCatalog_.inputsByBackend.end() || inputsIt->second.empty()) {
        error = backendKey + " has no available input devices.";
        return false;
    }
    if (outputsIt == deviceCatalog_.outputsByBackend.end() || outputsIt->second.empty()) {
        error = backendKey + " has no available output devices.";
        return false;
    }

    if (config.inputDeviceId.empty()) {
        const auto defaultInput = deviceCatalog_.defaultInputIdByBackend.find(backendKey);
        config.inputDeviceId = defaultInput != deviceCatalog_.defaultInputIdByBackend.end()
            ? defaultInput->second
            : inputsIt->second.front().id;
    }
    if (config.outputDeviceId.empty()) {
        const auto defaultOutput = deviceCatalog_.defaultOutputIdByBackend.find(backendKey);
        config.outputDeviceId = defaultOutput != deviceCatalog_.defaultOutputIdByBackend.end()
            ? defaultOutput->second
            : outputsIt->second.front().id;
    }

    const auto* inputDevice = findDeviceLocked(inputsIt->second, config.inputDeviceId);
    const auto* outputDevice = findDeviceLocked(outputsIt->second, config.outputDeviceId);
    if (!inputDevice) {
        error = "Input device not found for backend " + backendKey + ".";
        return false;
    }
    if (!outputDevice) {
        error = "Output device not found for backend " + backendKey + ".";
        return false;
    }

    const auto inputHasRate = std::find(inputDevice->sampleRates.begin(), inputDevice->sampleRates.end(), config.sampleRate) != inputDevice->sampleRates.end();
    const auto outputHasRate = std::find(outputDevice->sampleRates.begin(), outputDevice->sampleRates.end(), config.sampleRate) != outputDevice->sampleRates.end();
    if (!inputHasRate || !outputHasRate) {
        std::ostringstream message;
        message << "Requested sample rate " << config.sampleRate << " is not supported by both selected devices.";
        error = message.str();
        return false;
    }

    if (config.sampleRate == 0U || config.sampleRate > LooperCore::kMaximumSampleRate) {
        error = "sampleRate must be in the supported 1–192000 Hz loop-storage range.";
        return false;
    }

    if (config.bufferFrames == 0) {
        error = "bufferFrames must be greater than 0.";
        return false;
    }

    return true;
}

bool NativeAudioCore::openStreamLocked(std::string& error) {
    if (!currentConfig_) {
        error = "Engine has not been configured.";
        return false;
    }

    closeStreamLocked();

    unsigned int inputDeviceId = 0;
    unsigned int outputDeviceId = 0;
    if (!parseDeviceId(currentConfig_->inputDeviceId, inputDeviceId) ||
        !parseDeviceId(currentConfig_->outputDeviceId, outputDeviceId)) {
        error = "Invalid device id.";
        return false;
    }

    const auto inputBackendKey = backendToString(currentConfig_->backend);
    const auto inputDevices = deviceCatalog_.inputsByBackend.find(inputBackendKey);
    const auto* selectedInput = inputDevices == deviceCatalog_.inputsByBackend.end()
        ? nullptr
        : findDeviceLocked(inputDevices->second, currentConfig_->inputDeviceId);
    inputChannels_ = selectedInput != nullptr && selectedInput->maxInputChannels > 1U ? 2U : 1U;

    RtAudio::StreamParameters inputParams;
    inputParams.deviceId = inputDeviceId;
    inputParams.nChannels = inputChannels_;
    inputParams.firstChannel = 0;

    RtAudio::StreamParameters outputParams;
    outputParams.deviceId = outputDeviceId;
    outputParams.nChannels = outputChannels_;
    outputParams.firstChannel = 0;

    unsigned int bufferFrames = currentConfig_->bufferFrames;
    RtAudio::StreamOptions options;
    options.flags = RTAUDIO_SCHEDULE_REALTIME | RTAUDIO_MINIMIZE_LATENCY;

    if (!prepareLoopStorageLocked(currentConfig_->sampleRate, currentConfig_->nativeLooperStorageBudgetBytes, error)) return false;
    looper_.applyCommand({CommandType::SetMonitoring, currentConfig_->monitoringEnabled});
    if (!outputStage_.prepare(currentConfig_->sampleRate)) {
        error = "Unable to prepare the native output DSP stage for the configured sample rate.";
        return false;
    }
    if (!nativeInputFxBank_.prepare(currentConfig_->sampleRate)) {
        error = "Unable to prepare the Native input FX bank for the configured sample rate.";
        return false;
    }
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        if (!nativePerTrackFxBanks_[track].prepare(currentConfig_->sampleRate)) {
            error = "Unable to prepare Native per-track FX bank " + std::to_string(track + 1U) + ".";
            return false;
        }
        for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
            if (auto* processor = nativePerTrackFxBanks_[track].processor(static_cast<NativeEffectSlot>(slot))) {
                processor->setBypassed(nativePerTrackSlotBypassed_[track][slot]);
                nativePerTrackFxPublished_[track][slot].appliedBypassed.store(processor->isBypassed(), std::memory_order_release);
                nativePerTrackFxPublished_[track][slot].processingFaulted.store(false, std::memory_order_release);
            }
        }
    }
    outputStage_.setLowPassEnabled(outputLowPassEnabled_.load(std::memory_order_acquire));
    outputStage_.setHighPassEnabled(outputHighPassEnabled_.load(std::memory_order_acquire));
    if (!nativeRhythmEngine_.prepare(currentConfig_->sampleRate) ||
        !nativeRhythmEngine_.setConfig(nativeRhythmConfig_, 0)) {
        error = "Unable to prepare the native clean-room rhythm stage for the configured sample rate.";
        return false;
    }
    if (!outputStage_.setReverbConfig(nativeReverbConfig_)) {
        error = "Unable to prepare the native FDN16 reverb configuration.";
        return false;
    }
    if (!outputStage_.setFractionalDelayConfig(nativeFractionalDelayConfig_)) {
        error = "Unable to prepare the Native fractional-delay configuration.";
        return false;
    }
    if (!outputStage_.setCompressorConfig(nativeCompressorConfig_)) {
        error = "Unable to prepare the Native peak-compressor configuration.";
        return false;
    }
    if (!outputStage_.setChorusConfig(nativeChorusConfig_)) {
        error = "Unable to prepare the Native stereo-chorus configuration.";
        return false;
    }
    if (!outputStage_.setPhaserConfig(nativePhaserConfig_)) {
        error = "Unable to prepare the Native allpass-sweep phaser configuration.";
        return false;
    }
    resetRuntimeStateLocked();

    if (currentConfig_->backend == Backend::Wasapi) {
        if (!ensureAudioInstanceLocked(audio_, currentConfig_->backend, error) ||
            !ensureAudioInstanceLocked(captureAudio_, currentConfig_->backend, error)) {
            return false;
        }

        unsigned int outputBufferFrames = bufferFrames;
        const auto openOutputResult = audio_->openStream(
            &outputParams,
            nullptr,
            RTAUDIO_FLOAT32,
            currentConfig_->sampleRate,
            &outputBufferFrames,
            &NativeAudioCore::outputAudioCallback,
            this,
            &options
        );
        if (openOutputResult != RTAUDIO_NO_ERROR) {
            error = audio_->getErrorText();
            closeStreamLocked();
            return false;
        }
        if (outputBufferFrames > kMaxCallbackFrames) {
            error = "Output buffer is larger than the native MVP callback limit.";
            closeStreamLocked();
            return false;
        }

        unsigned int inputBufferFrames = bufferFrames;
        const auto openInputResult = captureAudio_->openStream(
            nullptr,
            &inputParams,
            RTAUDIO_FLOAT32,
            currentConfig_->sampleRate,
            &inputBufferFrames,
            &NativeAudioCore::inputAudioCallback,
            this,
            &options
        );
        if (openInputResult != RTAUDIO_NO_ERROR) {
            error = captureAudio_->getErrorText();
            closeStreamLocked();
            return false;
        }
        if (inputBufferFrames > kMaxCallbackFrames) {
            error = "Input buffer is larger than the native MVP callback limit.";
            closeStreamLocked();
            return false;
        }
        if (inputBufferFrames != outputBufferFrames) {
            error = "Split WASAPI mode requires matching input and output buffer sizes.";
            closeStreamLocked();
            return false;
        }

        const auto startOutputResult = audio_->startStream();
        if (startOutputResult != RTAUDIO_NO_ERROR) {
            error = audio_->getErrorText();
            closeStreamLocked();
            return false;
        }

        const auto startInputResult = captureAudio_->startStream();
        if (startInputResult != RTAUDIO_NO_ERROR) {
            error = captureAudio_->getErrorText();
            closeStreamLocked();
            return false;
        }

        bufferFrames = inputBufferFrames;
    } else {
        if (!ensureAudioInstanceLocked(audio_, currentConfig_->backend, error)) {
            return false;
        }

        const auto openResult = audio_->openStream(
            &outputParams,
            &inputParams,
            RTAUDIO_FLOAT32,
            currentConfig_->sampleRate,
            &bufferFrames,
            &NativeAudioCore::audioCallback,
            this,
            &options
        );
        if (openResult != RTAUDIO_NO_ERROR) {
            error = audio_->getErrorText();
            closeStreamLocked();
            return false;
        }
        if (bufferFrames > kMaxCallbackFrames) {
            error = "Duplex buffer is larger than the native MVP callback limit.";
            closeStreamLocked();
            return false;
        }

        const auto startResult = audio_->startStream();
        if (startResult != RTAUDIO_NO_ERROR) {
            error = audio_->getErrorText();
            closeStreamLocked();
            return false;
        }
    }

    constexpr auto callbackStartTimeout = std::chrono::milliseconds(500);
    constexpr auto callbackPollStep = std::chrono::milliseconds(20);
    auto waited = std::chrono::milliseconds(0);
    while (waited < callbackStartTimeout) {
        const auto callbacksStarted = callbackTicks_.load(std::memory_order_acquire) > 0;
        const auto duplexTimeStarted = audio_ && audio_->isStreamRunning() && audio_->getStreamTime() > 0.0;
        if (callbacksStarted || (currentConfig_->backend != Backend::Wasapi && duplexTimeStarted)) {
            break;
        }
        std::this_thread::sleep_for(callbackPollStep);
        waited += callbackPollStep;
    }

    if (callbackTicks_.load(std::memory_order_acquire) == 0 &&
        (currentConfig_->backend == Backend::Wasapi ||
         !audio_ || !audio_->isStreamRunning() || audio_->getStreamTime() <= 0.0)) {
        error = "WASAPI stream opened but callback never became active. This device input/output combination is not producing a running duplex callback.";
        closeStreamLocked();
        updateLastErrorLocked(error);
        return false;
    }

    currentConfig_->bufferFrames = bufferFrames;
    engineRunning_.store(true, std::memory_order_release);
    lastError_.clear();
    return true;
}

void NativeAudioCore::closeStreamLocked() noexcept {
    outputQueue_.clear();
    commandQueue_.clear();
    if (captureAudio_) {
        if (captureAudio_->isStreamRunning()) {
            captureAudio_->stopStream();
        }
        if (captureAudio_->isStreamOpen()) {
            captureAudio_->closeStream();
        }
    }
    if (audio_) {
        if (audio_->isStreamRunning()) {
            audio_->stopStream();
        }
        if (audio_->isStreamOpen()) {
            audio_->closeStream();
        }
    }
    engineRunning_.store(false, std::memory_order_release);
    outputStageCommandQueue_.clear();
    nativeReverbCommandQueue_.clear();
    nativeFractionalDelayCommandQueue_.clear();
    nativeCompressorCommandQueue_.clear();
    nativeChorusCommandQueue_.clear();
    nativePhaserCommandQueue_.clear();
    applyNativeCatalogFxCommands();
    nativeCatalogFxCommandQueue_.clear();
    nativePitchCommandQueue_.clear();
    nativeRhythmCommandQueue_.clear();
}

void NativeAudioCore::resetRuntimeStateLocked() noexcept {
    commandQueue_.clear();
    outputStageCommandQueue_.clear();
    nativeReverbCommandQueue_.clear();
    nativeFractionalDelayCommandQueue_.clear();
    nativeCompressorCommandQueue_.clear();
    nativeChorusCommandQueue_.clear();
    nativePhaserCommandQueue_.clear();
    nativeCatalogFxCommandQueue_.clear();
    nativePitchCommandQueue_.clear();
    nativeRhythmCommandQueue_.clear();
    outputQueue_.clear();
    nativePitchProcessor_.reset();
    nativePolyPitchProcessor_.reset();
    (void)nativePitchProcessor_.setSemitones(nativePitchConfig_.semitones);
    (void)nativePolyPitchProcessor_.setSemitones(nativePitchConfig_.semitones);
    nativePitchRuntimeEnabled_ = nativePitchConfig_.enabled;
    nativePitchRuntimeTrackId_ = nativePitchConfig_.trackId;
    nativePitchRuntimeMode_ = nativePitchConfig_.mode;
    nativePitchRuntimeReverse_ = nativePitchConfig_.reversePlayback;
    nativePitchActive_.store(false, std::memory_order_release);
    nativePitchVoiced_.store(false, std::memory_order_release);
    nativePitchFrequencyHz_.store(0.0f, std::memory_order_release);
    nativePitchConfidence_.store(0.0f, std::memory_order_release);
    nativePitchFallbackReason_.store(NativePitchFallbackReason::NotRequested, std::memory_order_release);
    callbackFrameCursor_ = 0;
    publishedCallbackFrameCursor_.store(0U, std::memory_order_release);
    loopSnapshotRequested_.store(false, std::memory_order_release);
    loopSnapshotAcknowledged_.store(false, std::memory_order_release);
    loopSnapshotReleaseRequested_.store(false, std::memory_order_release);
    loopSnapshotReleaseAcknowledged_.store(true, std::memory_order_release);
    loopSnapshotEligible_.store(false, std::memory_order_release);
    loopSnapshotState_.store(LooperState::Empty, std::memory_order_release);
    loopSnapshotPinned_ = false;
    looperState_.store(static_cast<int>(LooperState::Empty), std::memory_order_release);
    loopProgress_.store(0.0f, std::memory_order_release);
    inputPeak_.store(0.0f, std::memory_order_release);
    outputPeak_.store(0.0f, std::memory_order_release);
    xrunsOrDropouts_.store(0, std::memory_order_release);
    callbackTicks_.store(0, std::memory_order_release);
    renderPrimed_.store(false, std::memory_order_release);
}

void NativeAudioCore::applyOutputStageCommands() noexcept {
    NativeOutputEffectCommand command;
    while (outputStageCommandQueue_.pop(command)) {
        outputStage_.setEffectEnabled(command.effect, command.enabled);
    }
}

void NativeAudioCore::applyNativeReverbCommands() noexcept {
    NativeReverbCommand command;
    while (nativeReverbCommandQueue_.pop(command)) {
        (void)outputStage_.setReverbConfig(command.config);
    }
}

void NativeAudioCore::applyNativeFractionalDelayCommands() noexcept {
    NativeFractionalDelayCommand command;
    while (nativeFractionalDelayCommandQueue_.pop(command)) {
        (void)outputStage_.setFractionalDelayConfig(command.config);
    }
}

void NativeAudioCore::applyNativeCompressorCommands() noexcept {
    NativeCompressorCommand command;
    while (nativeCompressorCommandQueue_.pop(command)) {
        (void)outputStage_.setCompressorConfig(command.config);
    }
}

void NativeAudioCore::applyNativeChorusCommands() noexcept {
    NativeChorusCommand command;
    while (nativeChorusCommandQueue_.pop(command)) {
        (void)outputStage_.setChorusConfig(command.config);
    }
}

void NativeAudioCore::applyNativePhaserCommands() noexcept {
    NativePhaserCommand command;
    while (nativePhaserCommandQueue_.pop(command)) {
        (void)outputStage_.setPhaserConfig(command.config);
    }
}

void NativeAudioCore::applyNativeCatalogFxCommands() noexcept {
    NativeCatalogFxCommand command;
    while (nativeCatalogFxCommandQueue_.pop(command)) {
        if (command.trackId > kNativeTrackCount ||
            (command.path != NativeCatalogFxPath::Input && command.path != NativeCatalogFxPath::Track) ||
            (command.path == NativeCatalogFxPath::Input && command.trackId != 0U)) {
            nativeCatalogControlFaultCount_.fetch_add(1U, std::memory_order_relaxed);
            continue;
        }
        auto& bank = command.path == NativeCatalogFxPath::Input ? nativeInputFxBank_
            : command.trackId == 0U ? outputStage_.trackFxBank() : nativePerTrackFxBanks_[command.trackId - 1U];
        auto* processor = bank.processor(command.slot);
        bool applied = processor != nullptr;
        if (processor != nullptr && command.type == NativeCatalogFxCommand::Type::SetBypassed) {
            processor->setBypassed(command.value >= 0.5f);
            if (command.trackId != 0U) {
                nativePerTrackFxPublished_[command.trackId - 1U][static_cast<std::size_t>(command.slot)]
                    .appliedBypassed.store(processor->isBypassed(), std::memory_order_release);
                auto& published = nativePerTrackFxPublished_[command.trackId - 1U][static_cast<std::size_t>(command.slot)];
                if (published.controlFaultRevision.load(std::memory_order_relaxed) != command.revision) {
                    published.appliedRevision.store(command.revision, std::memory_order_release);
                }
            }
        } else if (processor != nullptr && command.type == NativeCatalogFxCommand::Type::SetParameter) {
            const auto* descriptor = findNativeEffectDescriptor(processor->stableId());
            applied = descriptor != nullptr && command.parameterIndex < descriptor->parameterCount &&
                processor->setParameter(descriptor->parameters[command.parameterIndex].id, command.value);
        } else {
            applied = false;
        }
        if (!applied) {
            nativeCatalogControlFaultCount_.fetch_add(1U, std::memory_order_relaxed);
            if (command.trackId != 0U && static_cast<std::size_t>(command.slot) < NativeEffectBank::kSlotCount) {
                nativePerTrackFxPublished_[command.trackId - 1U][static_cast<std::size_t>(command.slot)]
                    .controlFaultRevision.store(command.revision, std::memory_order_release);
            }
        }
    }
}

namespace {

void synchronizeOscVocSlotClocks(NativeEffectBank& bank, std::uint64_t frame) noexcept {
    for (std::size_t index = 0U; index < NativeEffectBank::kSlotCount; ++index) {
        auto* processor = dynamic_cast<NativeOscVocProcessor*>(
            bank.processor(static_cast<NativeEffectSlot>(index)));
        if (processor != nullptr && processor->currentFrame() < frame) {
            (void)processor->synchronizeFrame(frame);
        }
    }
}

void synchronizeHrmAutoSlotClocks(NativeEffectBank& bank, std::uint64_t frame) noexcept {
    for (std::size_t index = 0U; index < NativeEffectBank::kSlotCount; ++index) {
        auto* processor = dynamic_cast<NativeHrmAutoProcessor*>(
            bank.processor(static_cast<NativeEffectSlot>(index)));
        if (processor != nullptr && processor->currentFrame() < frame) {
            (void)processor->synchronizeFrame(frame);
        }
    }
}

} // namespace

const float* NativeAudioCore::processInputFxForCallback(
    const float* inputInterleaved,
    unsigned int frames
) noexcept {
    if (inputInterleaved == nullptr || !nativeInputFxBank_.hasEffects() ||
        inputChannels_ == 0U || inputChannels_ > 2U || frames > kMaxCallbackFrames) {
        return inputInterleaved;
    }
    const std::size_t sampleCount = static_cast<std::size_t>(frames) * inputChannels_;
    std::copy_n(inputInterleaved, sampleCount, nativeInputFxScratch_.data());
    (void)nativeInputFxBank_.processInPlace(nativeInputFxScratch_.data(), frames, inputChannels_);
    return nativeInputFxScratch_.data();
}

void NativeAudioCore::applyNativeRhythmCommands() noexcept {
    NativeRhythmConfig config;
    while (nativeRhythmCommandQueue_.pop(config)) {
        (void)nativeRhythmEngine_.setConfig(config, callbackFrameCursor_);
    }
}

void NativeAudioCore::applyNativePitchCommands() noexcept {
    NativePitchCommand command;
    while (nativePitchCommandQueue_.pop(command)) {
        if (command.resetProcessor) {
            nativePitchProcessor_.reset();
            nativePolyPitchProcessor_.reset();
        }
        (void)nativePitchProcessor_.setSemitones(command.config.semitones);
        (void)nativePolyPitchProcessor_.setSemitones(command.config.semitones);
        nativePitchRuntimeEnabled_ = command.config.enabled;
        nativePitchRuntimeTrackId_ = command.config.trackId;
        nativePitchRuntimeMode_ = command.config.mode;
        nativePitchRuntimeReverse_ = command.config.reversePlayback;
    }
}

void NativeAudioCore::applyNativeLoopTransportCommands() noexcept {
    NativeLoopTransportCommand command;
    while (nativeLoopTransportCommandQueue_.pop(command)) {
        if (command.trackIndex >= kNativeTrackCount) continue;
        auto& track = looperForTrack(command.trackIndex);
        if (track.setLoopTransportConfig(command.config)) {
            trackLoopTransportStatus_[command.trackIndex].store(track.loopTransportStatus(), std::memory_order_release);
        }
    }
}

LooperCore& NativeAudioCore::looperForTrack(std::size_t trackIndex) noexcept {
    return trackIndex == 0U || trackIndex >= kNativeTrackCount
        ? looper_
        : additionalLoopers_[trackIndex - 1U];
}

const LooperCore& NativeAudioCore::looperForTrack(std::size_t trackIndex) const noexcept {
    return trackIndex == 0U || trackIndex >= kNativeTrackCount
        ? looper_
        : additionalLoopers_[trackIndex - 1U];
}

ProcessStats NativeAudioCore::processNativeTracksForCallback(
    const float* inputInterleaved,
    float* outputInterleaved,
    unsigned int frames,
    NativePitchRouteDecision* pitchRouteDecision
) noexcept {
    ProcessStats stats{};
    stats.state = looper_.state();
    if (outputInterleaved == nullptr || frames > kMaxCallbackFrames || outputChannels_ == 0U || outputChannels_ > 2U) {
        if (pitchRouteDecision != nullptr) *pitchRouteDecision = {false, NativePitchFallbackReason::PlaybackBufferUnavailable};
        return stats;
    }

    for (auto& bank : nativePerTrackFxBanks_) {
        synchronizeOscVocSlotClocks(bank, callbackFrameCursor_);
        synchronizeHrmAutoSlotClocks(bank, callbackFrameCursor_);
    }
    NativeEffectBank* const trackFx = &outputStage_.trackFxBank();
    const bool trackFxActive = trackFx->hasEffects();
    NativePitchProcessor* const monoProcessor = nativePitchRuntimeMode_ == NativePitchMode::LivePolyPhaseVocoder
        ? nullptr : &nativePitchProcessor_;
    NativePolyPitchProcessor* const polyProcessor = nativePitchRuntimeMode_ == NativePitchMode::LivePolyPhaseVocoder
        ? &nativePolyPitchProcessor_ : nullptr;
    const bool processorPrepared = monoProcessor != nullptr ? monoProcessor->prepared() : polyProcessor->prepared();
    const unsigned int pitchLatency = monoProcessor != nullptr ? monoProcessor->latencySamples() : polyProcessor->latencySamples();
    bool pitchPlaybackRequested = false;
    std::uint64_t shortestPlayingLoop = std::numeric_limits<std::uint64_t>::max();
    for (std::size_t trackIndex = 0U; trackIndex < kNativeTrackCount; ++trackIndex) {
        if (nativePitchRuntimeTrackId_ != 0U && trackIndex + 1U != nativePitchRuntimeTrackId_) continue;
        const auto& track = looperForTrack(trackIndex);
        const auto state = track.state();
        if (state == LooperState::Playing || state == LooperState::Overdubbing) {
            pitchPlaybackRequested = true;
            shortestPlayingLoop = std::min(shortestPlayingLoop, track.loopLengthSamples());
        }
    }
    pitchPlaybackRequested = pitchPlaybackRequested && nativePitchRuntimeEnabled_;
    if (shortestPlayingLoop == std::numeric_limits<std::uint64_t>::max()) shortestPlayingLoop = 0U;
    NativePitchRouteDecision pitchRoute = decideNativePitchRoute(
        pitchPlaybackRequested, processorPrepared, nativePitchRuntimeReverse_, outputChannels_,
        shortestPlayingLoop, pitchLatency
    );
    float* const playbackBus = outputStage_.playbackOnlyScratch();
    const bool playbackBufferAvailable = playbackBus != nullptr && frames <= NativeOutputStage::kMaxProcessFrames;
    if (pitchRoute.useProcessor && !playbackBufferAvailable) {
        pitchRoute = {false, NativePitchFallbackReason::PlaybackBufferUnavailable};
    }
    if (pitchRouteDecision != nullptr) *pitchRouteDecision = pitchRoute;

    const std::size_t sampleCount = static_cast<std::size_t>(frames) * outputChannels_;
    std::fill_n(outputInterleaved, sampleCount, 0.0f);
    if (playbackBufferAvailable) std::fill_n(playbackBus, sampleCount, 0.0f);
    for (std::size_t trackIndex = 0U; trackIndex < kNativeTrackCount; ++trackIndex) {
        auto& track = looperForTrack(trackIndex);
        const auto trackStats = track.process(
            inputInterleaved,
            nativeTrackMixScratch_.data(),
            frames,
            inputChannels_,
            outputChannels_,
            playbackBufferAvailable ? nativeTrackPlaybackScratch_.data() : nullptr
        );
        stats.inputPeak = std::max(stats.inputPeak, trackStats.inputPeak);
        trackStates_[trackIndex].store(static_cast<int>(trackStats.state), std::memory_order_release);
        trackProgress_[trackIndex].store(trackStats.loopProgress, std::memory_order_release);
        trackLoopTransportStatus_[trackIndex].store(trackStats.loopTransportStatus, std::memory_order_release);
        for (std::size_t sample = 0U; sample < sampleCount; ++sample) {
            outputInterleaved[sample] += nativeTrackMixScratch_[sample] -
                (playbackBufferAvailable ? nativeTrackPlaybackScratch_[sample] : 0.0f);
        }
        const bool isPitchTargetTrack = nativePitchRuntimeTrackId_ != 0U &&
            trackIndex + 1U == nativePitchRuntimeTrackId_;
        if (playbackBufferAvailable && isPitchTargetTrack && pitchRoute.useProcessor) {
            std::copy_n(nativeTrackPlaybackScratch_.data(), sampleCount, nativePitchTargetDryScratch_.data());
            const bool processed = monoProcessor != nullptr
                ? monoProcessor->processInterleaved(nativeTrackPlaybackScratch_.data(), frames, outputChannels_)
                : polyProcessor->processInterleaved(nativeTrackPlaybackScratch_.data(), frames, outputChannels_);
            if (!processed) {
                std::copy_n(nativePitchTargetDryScratch_.data(), sampleCount, nativeTrackPlaybackScratch_.data());
                pitchRoute = {false, NativePitchFallbackReason::PlaybackBufferUnavailable};
            }
        }
        auto& localBank = nativePerTrackFxBanks_[trackIndex];
        if (playbackBufferAvailable && localBank.hasEffects()) {
            (void)localBank.processInPlace(nativeTrackPlaybackScratch_.data(), frames, outputChannels_);
        }
        for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
            const auto* processor = localBank.processor(static_cast<NativeEffectSlot>(slot));
            const bool faulted = processor != nullptr &&
                (!playbackBufferAvailable || processor->sampleRate() == 0U || processor->processingFaulted());
            nativePerTrackFxPublished_[trackIndex][slot].processingFaulted.store(faulted, std::memory_order_release);
        }
        if (playbackBufferAvailable) {
            for (std::size_t sample = 0U; sample < sampleCount; ++sample) playbackBus[sample] += nativeTrackPlaybackScratch_[sample];
        }
    }

    stats.state = looper_.state();
    stats.loopProgress = trackProgress_[0U].load(std::memory_order_relaxed);
    if (playbackBufferAvailable) {
        if (trackFxActive) (void)trackFx->processInPlace(playbackBus, frames, outputChannels_);
        if (pitchRoute.useProcessor && nativePitchRuntimeTrackId_ == 0U) {
            const bool processed = monoProcessor != nullptr
                ? monoProcessor->processInterleaved(playbackBus, frames, outputChannels_)
                : polyProcessor->processInterleaved(playbackBus, frames, outputChannels_);
            if (!processed) pitchRoute = {false, NativePitchFallbackReason::PlaybackBufferUnavailable};
        }
        for (std::size_t sample = 0U; sample < sampleCount; ++sample) outputInterleaved[sample] += playbackBus[sample];
    }
    if (pitchRouteDecision != nullptr) *pitchRouteDecision = pitchRoute;

    nativeRhythmEngine_.processAdditive(outputInterleaved, frames, outputChannels_, callbackFrameCursor_);
    for (std::size_t sample = 0U; sample < sampleCount; ++sample) {
        outputInterleaved[sample] = std::max(-1.0f, std::min(1.0f, outputInterleaved[sample]));
    }
    stats.outputPeak = outputStage_.processInPlace(outputInterleaved, frames, outputChannels_);
    return stats;
}

bool NativeAudioCore::processLoopSnapshotRequestAtCallback() noexcept {
    if (!loopSnapshotRequested_.load(std::memory_order_acquire)) {
        loopSnapshotPinned_ = false;
        if (loopSnapshotReleaseRequested_.exchange(false, std::memory_order_acq_rel)) {
            loopSnapshotReleaseAcknowledged_.store(true, std::memory_order_release);
        }
        return false;
    }

    if (!loopSnapshotPinned_) {
        const auto trackIndex = loopSnapshotTrackIndex_.load(std::memory_order_acquire);
        const auto state = looperForTrack(trackIndex).state();
        loopSnapshotState_.store(state, std::memory_order_release);
        loopSnapshotPinned_ = state == LooperState::Stopped || state == LooperState::Playing;
        loopSnapshotEligible_.store(loopSnapshotPinned_, std::memory_order_release);
    } else {
        // A second request may arrive before this callback has observed the
        // previous release. The pin still protects the same immutable loop.
        loopSnapshotEligible_.store(true, std::memory_order_release);
    }

    // Publish every requested generation, including requests that arrive
    // while an earlier pin is still owned by this callback.
    loopSnapshotAcknowledged_.store(true, std::memory_order_release);
    return loopSnapshotPinned_;
}

void NativeAudioCore::updateLastErrorLocked(const std::string& error) const {
    lastError_ = error;
}

const DeviceDescriptor* NativeAudioCore::findDeviceLocked(const std::vector<DeviceDescriptor>& devices, const std::string& id) const {
    const auto match = std::find_if(devices.begin(), devices.end(), [&id](const DeviceDescriptor& device) {
        return device.id == id;
    });
    return match == devices.end() ? nullptr : &(*match);
}

int NativeAudioCore::audioCallback(
    void* outputBuffer,
    void* inputBuffer,
    unsigned int nBufferFrames,
    double,
    RtAudioStreamStatus status,
    void* userData
) {
    return static_cast<NativeAudioCore*>(userData)->handleAudioCallback(outputBuffer, inputBuffer, nBufferFrames, status);
}

int NativeAudioCore::inputAudioCallback(
    void*,
    void* inputBuffer,
    unsigned int nBufferFrames,
    double,
    RtAudioStreamStatus status,
    void* userData
) {
    return static_cast<NativeAudioCore*>(userData)->handleInputAudioCallback(inputBuffer, nBufferFrames, status);
}

int NativeAudioCore::outputAudioCallback(
    void* outputBuffer,
    void*,
    unsigned int nBufferFrames,
    double,
    RtAudioStreamStatus status,
    void* userData
) {
    return static_cast<NativeAudioCore*>(userData)->handleOutputAudioCallback(outputBuffer, nBufferFrames, status);
}

int NativeAudioCore::handleAudioCallback(
    void* outputBuffer,
    void* inputBuffer,
    unsigned int nBufferFrames,
    RtAudioStreamStatus status
) {
    if (status != 0) {
    xrunsOrDropouts_.fetch_add(1, std::memory_order_acq_rel);
  }

    callbackTicks_.fetch_add(1, std::memory_order_acq_rel);

    const bool loopSnapshotPinned = processLoopSnapshotRequestAtCallback();
    if (!loopSnapshotPinned) {
        Command command{};
        while (commandQueue_.pop(command)) {
            if (command.type == CommandType::Record || command.type == CommandType::StopRecordOrPlayback ||
                command.type == CommandType::Play || command.type == CommandType::Clear) {
                nativePitchProcessor_.reset();
                nativePolyPitchProcessor_.reset();
            }
            looperForTrack(command.trackIndex).applyCommand(command);
        }
    }

    applyOutputStageCommands();
    applyNativeReverbCommands();
    applyNativeFractionalDelayCommands();
    applyNativeCompressorCommands();
    applyNativeChorusCommands();
    applyNativePhaserCommands();
    applyNativeCatalogFxCommands();
    applyNativePitchCommands();
    applyNativeLoopTransportCommands();
    applyNativeRhythmCommands();
    synchronizeOscVocSlotClocks(nativeInputFxBank_, callbackFrameCursor_);
    synchronizeOscVocSlotClocks(outputStage_.trackFxBank(), callbackFrameCursor_);
    synchronizeHrmAutoSlotClocks(nativeInputFxBank_, callbackFrameCursor_);
    synchronizeHrmAutoSlotClocks(outputStage_.trackFxBank(), callbackFrameCursor_);

    NativePitchRouteDecision pitchRoute{};
    const float* processedInput = processInputFxForCallback(
        static_cast<const float*>(inputBuffer),
        nBufferFrames
    );

    auto stats = processNativeTracksForCallback(
        processedInput,
        static_cast<float*>(outputBuffer),
        nBufferFrames,
        &pitchRoute
    );
    callbackFrameCursor_ += nBufferFrames;
    publishedCallbackFrameCursor_.store(callbackFrameCursor_, std::memory_order_release);

    looperState_.store(static_cast<int>(stats.state), std::memory_order_release);
    loopProgress_.store(stats.loopProgress, std::memory_order_release);
    inputPeak_.store(stats.inputPeak, std::memory_order_release);
    outputPeak_.store(stats.outputPeak, std::memory_order_release);
    nativePitchActive_.store(pitchRoute.useProcessor, std::memory_order_release);
    nativePitchFallbackReason_.store(pitchRoute.fallbackReason, std::memory_order_release);
    const bool monoPitchMode = nativePitchRuntimeMode_ == NativePitchMode::LiveMonoKeepPitch;
    nativePitchVoiced_.store(monoPitchMode && nativePitchProcessor_.voiced(), std::memory_order_release);
    nativePitchFrequencyHz_.store(monoPitchMode ? nativePitchProcessor_.frequencyHz() : 0.0f, std::memory_order_release);
    nativePitchConfidence_.store(monoPitchMode ? nativePitchProcessor_.confidence() : 0.0f, std::memory_order_release);
    return 0;
}

int NativeAudioCore::handleInputAudioCallback(
    void* inputBuffer,
    unsigned int nBufferFrames,
    RtAudioStreamStatus status
) {
    if (status != 0) {
        xrunsOrDropouts_.fetch_add(1, std::memory_order_acq_rel);
    }

    callbackTicks_.fetch_add(1, std::memory_order_acq_rel);

    const bool loopSnapshotPinned = processLoopSnapshotRequestAtCallback();
    if (!loopSnapshotPinned) {
        Command command{};
        while (commandQueue_.pop(command)) {
            if (command.type == CommandType::Record || command.type == CommandType::StopRecordOrPlayback ||
                command.type == CommandType::Play || command.type == CommandType::Clear) {
                nativePitchProcessor_.reset();
                nativePolyPitchProcessor_.reset();
            }
            looperForTrack(command.trackIndex).applyCommand(command);
        }
    }

    applyOutputStageCommands();
    applyNativeReverbCommands();
    applyNativeFractionalDelayCommands();
    applyNativeCompressorCommands();
    applyNativeChorusCommands();
    applyNativePhaserCommands();
    applyNativeCatalogFxCommands();
    applyNativePitchCommands();
    applyNativeLoopTransportCommands();
    applyNativeRhythmCommands();
    synchronizeOscVocSlotClocks(nativeInputFxBank_, callbackFrameCursor_);
    synchronizeOscVocSlotClocks(outputStage_.trackFxBank(), callbackFrameCursor_);

    bool pitchPlaybackRequested = false;
    for (std::size_t trackIndex = 0U; trackIndex < kNativeTrackCount; ++trackIndex) {
        const auto state = looperForTrack(trackIndex).state();
        pitchPlaybackRequested = pitchPlaybackRequested ||
            (state == LooperState::Playing || state == LooperState::Overdubbing);
    }
    pitchPlaybackRequested = pitchPlaybackRequested && nativePitchRuntimeEnabled_;
    NativePitchRouteDecision pitchRoute{};

    if (nBufferFrames > kMaxCallbackFrames) {
        xrunsOrDropouts_.fetch_add(1, std::memory_order_acq_rel);
        callbackFrameCursor_ += nBufferFrames;
        publishedCallbackFrameCursor_.store(callbackFrameCursor_, std::memory_order_release);
        nativePitchActive_.store(false, std::memory_order_release);
        nativePitchFallbackReason_.store(pitchPlaybackRequested
            ? NativePitchFallbackReason::PlaybackBufferUnavailable
            : NativePitchFallbackReason::NotRequested, std::memory_order_release);
        return 0;
    }

    AudioBlock block{};
    block.frames = nBufferFrames;
    const float* processedInput = processInputFxForCallback(
        static_cast<const float*>(inputBuffer),
        nBufferFrames
    );

    auto stats = processNativeTracksForCallback(
        processedInput,
        block.samples.data(),
        nBufferFrames,
        &pitchRoute
    );
    callbackFrameCursor_ += nBufferFrames;
    publishedCallbackFrameCursor_.store(callbackFrameCursor_, std::memory_order_release);

    if (!outputQueue_.push(block)) {
        xrunsOrDropouts_.fetch_add(1, std::memory_order_acq_rel);
    }

    looperState_.store(static_cast<int>(stats.state), std::memory_order_release);
    loopProgress_.store(stats.loopProgress, std::memory_order_release);
    inputPeak_.store(stats.inputPeak, std::memory_order_release);
    outputPeak_.store(stats.outputPeak, std::memory_order_release);
    nativePitchActive_.store(pitchRoute.useProcessor, std::memory_order_release);
    nativePitchFallbackReason_.store(pitchRoute.fallbackReason, std::memory_order_release);
    const bool monoPitchMode = nativePitchRuntimeMode_ == NativePitchMode::LiveMonoKeepPitch;
    nativePitchVoiced_.store(monoPitchMode && nativePitchProcessor_.voiced(), std::memory_order_release);
    nativePitchFrequencyHz_.store(monoPitchMode ? nativePitchProcessor_.frequencyHz() : 0.0f, std::memory_order_release);
    nativePitchConfidence_.store(monoPitchMode ? nativePitchProcessor_.confidence() : 0.0f, std::memory_order_release);
    return 0;
}

int NativeAudioCore::handleOutputAudioCallback(
    void* outputBuffer,
    unsigned int nBufferFrames,
    RtAudioStreamStatus status
) {
    if (status != 0) {
        xrunsOrDropouts_.fetch_add(1, std::memory_order_acq_rel);
    }

    auto* output = static_cast<float*>(outputBuffer);
    if (output == nullptr) {
        return 0;
    }

    const auto sampleCount = static_cast<std::size_t>(nBufferFrames) * outputChannels_;
    std::fill_n(output, sampleCount, 0.0f);

    if (!renderPrimed_.load(std::memory_order_acquire)) {
        if (outputQueue_.size() < 2) {
            return 0;
        }
        renderPrimed_.store(true, std::memory_order_release);
    }

    AudioBlock block{};
    if (!outputQueue_.pop(block)) {
        if (callbackTicks_.load(std::memory_order_acquire) > 0) {
            xrunsOrDropouts_.fetch_add(1, std::memory_order_acq_rel);
        }
        renderPrimed_.store(false, std::memory_order_release);
        return 0;
    }

    const auto framesToCopy = std::min(nBufferFrames, block.frames);
    const auto samplesToCopy = static_cast<std::size_t>(framesToCopy) * outputChannels_;
    std::copy_n(block.samples.data(), samplesToCopy, output);
    return 0;
}

} // namespace webrc::native
