#include "native_audio_core.hpp"

#include <algorithm>
#include <chrono>
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

LooperState toLooperState(TrackPlaybackState state) noexcept {
    switch (state) {
    case TrackPlaybackState::Recording: return LooperState::Recording;
    case TrackPlaybackState::Stopped: return LooperState::Stopped;
    case TrackPlaybackState::Playing: return LooperState::Playing;
    case TrackPlaybackState::Overdubbing: return LooperState::Overdubbing;
    case TrackPlaybackState::Empty:
    default: return LooperState::Empty;
    }
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

NativeAudioCore::NativeAudioCore(bool softwareOnly)
    : softwareOnly_(softwareOnly),
      deviceCatalog_(softwareOnly_ ? DeviceCatalog{} : buildCatalog()),
      fxBank_(trackHost_) {}

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
    // A replaced graph is reclaimed only on this control-side path after the
    // callback finishes its crossfade; no FX processor is destroyed in audio.
    (void)trackHost_.reclaimRetiredFxGraph();

    EngineStatus status;
    status.engineRunning = engineRunning_.load(std::memory_order_acquire);
    status.softwareOnly = softwareOnly_;
    status.monitoringEnabled = softwareMonitoringEnabled_;
    if (currentConfig_) {
        status.backend = currentConfig_->backend;
        status.inputDeviceId = currentConfig_->inputDeviceId;
        status.outputDeviceId = currentConfig_->outputDeviceId;
        status.sampleRate = currentConfig_->sampleRate;
        status.bufferFrames = currentConfig_->bufferFrames;
        status.trackBufferSeconds = currentConfig_->trackBufferSeconds;
        status.trackMemoryBudgetBytes = currentConfig_->trackMemoryBudgetBytes;
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
    status.loopProgress = loopProgress_.load(std::memory_order_acquire);
    status.inputPeak = inputPeak_.load(std::memory_order_acquire);
    status.outputPeak = outputPeak_.load(std::memory_order_acquire);
    status.xrunsOrDropouts = xrunsOrDropouts_.load(std::memory_order_acquire);
    status.callbackStatusFaults = callbackStatusFaults_.load(std::memory_order_acquire);
    status.inputQueueOverruns = inputQueueOverruns_.load(std::memory_order_acquire);
    status.outputQueueUnderruns = outputQueueUnderruns_.load(std::memory_order_acquire);
    status.callbackFrameLimitViolations = callbackFrameLimitViolations_.load(std::memory_order_acquire);
    status.trackHost = trackHost_.status();
    if (!status.trackHost.tracks.empty()) {
        const auto& primaryTrack = status.trackHost.tracks[0];
        status.state = toLooperState(primaryTrack.state);
        status.loopProgress = primaryTrack.loopFrames > 0U
            ? static_cast<float>(primaryTrack.playhead) / static_cast<float>(primaryTrack.loopFrames)
            : 0.0f;
    }
    status.inputPeak = status.trackHost.lastProcess.inputPeak;
    status.outputPeak = status.trackHost.lastProcess.outputPeak;
    status.droppedCommands = static_cast<std::size_t>(status.trackHost.lastProcess.droppedCommands);
    status.outputQueueDepthBlocks = outputQueue_.size();
    status.outputQueueCapacityBlocks = SpscRingQueue<AudioBlock, 8>::usableCapacity();
    status.callbackTicks = callbackTicks_.load(std::memory_order_acquire);
    status.inputCallbackTicks = inputCallbackTicks_.load(std::memory_order_acquire);
    status.outputCallbackTicks = outputCallbackTicks_.load(std::memory_order_acquire);
    status.callbackCountSkew = static_cast<long long>(status.inputCallbackTicks) - static_cast<long long>(status.outputCallbackTicks);
    if (audio_ && audio_->isStreamOpen()) {
        status.streamTimeSeconds = audio_->getStreamTime();
    } else if (captureAudio_ && captureAudio_->isStreamOpen()) {
        status.streamTimeSeconds = captureAudio_->getStreamTime();
    }
    if (status.sampleRate > 0) {
        constexpr auto kDriverLatencySource = "RtAudio driver-reported stream buffering; not a physical loopback measurement.";
        const auto framesToMs = [sampleRate = status.sampleRate](long frames) -> std::optional<double> {
            if (frames <= 0) {
                return std::nullopt;
            }
            return static_cast<double>(frames) * 1000.0 / static_cast<double>(sampleRate);
        };

        if (status.backend == Backend::Wasapi) {
            if (captureAudio_ && captureAudio_->isStreamOpen()) {
                status.inputLatencyMs = framesToMs(captureAudio_->getStreamLatency());
                if (status.inputLatencyMs) {
                    status.inputLatencySource = kDriverLatencySource;
                }
            }
            if (audio_ && audio_->isStreamOpen()) {
                status.outputLatencyMs = framesToMs(audio_->getStreamLatency());
                if (status.outputLatencyMs) {
                    status.outputLatencySource = kDriverLatencySource;
                }
            }
        } else if (audio_ && audio_->isStreamOpen()) {
            // RtAudio reports one aggregate value for a duplex stream. Keep it
            // visible as a driver report without inventing per-direction data.
            status.driverReportedStreamLatencyMs = framesToMs(audio_->getStreamLatency());
            if (status.driverReportedStreamLatencyMs) {
                status.driverReportedStreamLatencySource = kDriverLatencySource;
            }
        }
    }
    status.lastError = lastError_;
    return status;
}

NativeFxBankSnapshot NativeAudioCore::getFxBankSnapshot() const {
    std::lock_guard<std::mutex> lock(controlMutex_);
    NativeFxBankSnapshot snapshot;
    const auto hostStatus = trackHost_.status();
    snapshot.producerGeneration = hostStatus.fxGraphGeneration;
    snapshot.activeGeneration = hostStatus.fxGraphActiveGeneration;
    snapshot.stageAccepted = fxBank_.configured() && hostStatus.fxGraphGeneration != 0U;
    snapshot.adopted = snapshot.stageAccepted && hostStatus.fxGraphActive &&
                       hostStatus.fxGraphActiveGeneration == hostStatus.fxGraphGeneration;
    snapshot.configured = snapshot.stageAccepted;
    if (snapshot.configured) snapshot.configuration = *fxBank_.configuration();
    return snapshot;
}

NativeFxBankResult NativeAudioCore::configureFxBank(
    const NativeFxBankConfig& configuration) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    (void)trackHost_.reclaimRetiredFxGraph();
    return fxBank_.configure(configuration);
}

NativeFxBankResult NativeAudioCore::postFxBankEvents(
    const NativeFxBankEvent* events, std::uint32_t eventCount) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    return fxBank_.postEvents(events, eventCount);
}

bool NativeAudioCore::prepareSoftwareFxHost(std::uint32_t sampleRateHz,
                                            std::uint32_t trackBufferSeconds,
                                            std::uint64_t memoryBudgetBytes,
                                            std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!softwareOnly_) {
        error = "Software FX host preparation requires software-only mode.";
        updateLastErrorLocked(error);
        return false;
    }
    if (engineRunning_.load(std::memory_order_acquire)) {
        error = "The software-only FX host cannot replace a running Native device host.";
        return false;
    }
    if (!trackHost_.prepare(sampleRateHz, trackBufferSeconds, memoryBudgetBytes)) {
        error = "Failed to prepare the software-only five-track FX host.";
        return false;
    }
    error.clear();
    return true;
}

bool NativeAudioCore::processSoftwareFxBlock(const float* inputInterleavedStereo,
                                            const float* carrierInterleavedStereo,
                                            float* outputInterleavedStereo,
                                            std::uint32_t frames,
                                            MultiTrackProcessStats* stats,
                                            std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!softwareOnly_) {
        error = "Software FX rendering requires software-only mode.";
        updateLastErrorLocked(error);
        return false;
    }
    if (engineRunning_.load(std::memory_order_acquire)) {
        error = "Software FX rendering is unavailable while a physical stream is running.";
        updateLastErrorLocked(error);
        return false;
    }
    if (!trackHost_.prepared()) {
        error = "The software-only NativeTrackHost has not been prepared.";
        updateLastErrorLocked(error);
        return false;
    }
    if (inputInterleavedStereo == nullptr || outputInterleavedStereo == nullptr ||
        frames == 0U || frames > kNativeTrackHostMaximumCallbackFrames) {
        error = "Software FX rendering requires stereo buffers and 1 through 4096 frames.";
        updateLastErrorLocked(error);
        return false;
    }

    const auto carrierChannels = carrierInterleavedStereo == nullptr ? 0U : 2U;
    if (!trackHost_.processInputBlockWithCarrier(
            inputInterleavedStereo, 2U, carrierInterleavedStereo, carrierChannels,
            outputInterleavedStereo, frames, stats)) {
        error = "NativeTrackHost rejected the software FX block.";
        updateLastErrorLocked(error);
        return false;
    }
    error.clear();
    lastError_.clear();
    return true;
}

bool NativeAudioCore::rhythmControlReadyLocked(std::string& error) const {
    if (!trackHost_.prepared()) {
        error = "NativeTrackHost must be prepared before rhythm controls are available.";
        return false;
    }
    if (!engineRunning_.load(std::memory_order_acquire) && !softwareOnly_) {
        error = "Start the Native audio engine before scheduling rhythm controls.";
        return false;
    }
    return true;
}

bool NativeAudioCore::postRhythmCommand(const NativeRhythmCommand& command,
                                        std::uint64_t& acceptedFrame,
                                        std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (!rhythmControlReadyLocked(error)) {
        updateLastErrorLocked(error);
        return false;
    }

    constexpr std::uint64_t kMaximumExactFrame = (std::uint64_t{1} << 53U) - 1U;
    constexpr std::uint32_t kPhysicalSafeLeadFrames =
        kNativeTrackHostMaximumCallbackFrames + kNativeTrackHostQuantumFrames;
    const auto softwareRender = softwareOnly_;
    const auto safeLead = softwareRender
        ? kNativeTrackHostQuantumFrames : kPhysicalSafeLeadFrames;
    const auto hostStatus = trackHost_.status();
    std::uint64_t frame = 0U;
    if (command.absoluteFrame.has_value()) {
        frame = *command.absoluteFrame;
        if (frame > kMaximumExactFrame) {
            error = "absoluteFrame must be an exact nonnegative integer no greater than 2^53-1.";
            updateLastErrorLocked(error);
            return false;
        }
        if (!softwareRender) {
            const auto earliest = hostStatus.nextFrame >
                kMaximumExactFrame - kPhysicalSafeLeadFrames
                ? kMaximumExactFrame + 1U
                : hostStatus.nextFrame + kPhysicalSafeLeadFrames;
            if (frame < earliest) {
                error = "Physical rhythm events must be at least one maximum callback plus one quantum ahead.";
                updateLastErrorLocked(error);
                return false;
            }
        }
    } else {
        frame = trackHost_.nextRhythmCommandFrame(safeLead);
    }
    if (frame > kMaximumExactFrame) {
        error = "No safe rhythm command frame remains in the exact sample timeline.";
        updateLastErrorLocked(error);
        return false;
    }

    bool accepted = false;
    switch (command.type) {
    case NativeRhythmCommandType::PatternKit:
        accepted = trackHost_.queueRhythmPatternKit(frame, command.patternIndex,
                                                    command.kitIndex);
        break;
    case NativeRhythmCommandType::Start:
        accepted = trackHost_.startRhythm(frame, command.playIntro);
        break;
    case NativeRhythmCommandType::Variation:
        accepted = trackHost_.queueRhythmVariation(frame, command.variation);
        break;
    case NativeRhythmCommandType::Fill:
        accepted = trackHost_.queueRhythmFill(frame);
        break;
    case NativeRhythmCommandType::Ending:
        accepted = trackHost_.queueRhythmEnding(frame);
        break;
    case NativeRhythmCommandType::Stop:
        accepted = trackHost_.stopRhythm(frame);
        break;
    case NativeRhythmCommandType::Tempo:
        accepted = trackHost_.setTempoAtFrame(frame, command.bpm);
        break;
    case NativeRhythmCommandType::Volume:
        accepted = trackHost_.setRhythmVolumeAtFrame(frame, command.volume);
        break;
    default:
        error = "Unknown Native rhythm command.";
        updateLastErrorLocked(error);
        return false;
    }
    if (!accepted) {
        error = "Native rhythm command was rejected by its bounded sample-clock queue.";
        updateLastErrorLocked(error);
        return false;
    }
    acceptedFrame = frame;
    error.clear();
    lastError_.clear();
    return true;
}

bool NativeAudioCore::applyConfig(const EngineConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (softwareOnly_) {
        error = "Physical audio configuration is disabled in software-only mode.";
        updateLastErrorLocked(error);
        return false;
    }
    EngineConfig validated = config;
    if (!validateConfigLocked(validated, error)) {
        updateLastErrorLocked(error);
        return false;
    }

    const bool wasRunning = engineRunning_.load(std::memory_order_acquire);
    if (wasRunning) {
        closeStreamLocked();
    }

    currentConfig_ = validated;
    looper_.prepare(currentConfig_->sampleRate);
    looper_.applyCommand({CommandType::SetMonitoring, currentConfig_->monitoringEnabled});
    resetRuntimeStateLocked();
    lastError_.clear();

    if (wasRunning && !openStreamLocked(error)) {
        updateLastErrorLocked(error);
        return false;
    }

    return true;
}

bool NativeAudioCore::start(std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (softwareOnly_) {
        error = "Starting a physical audio stream is disabled in software-only mode.";
        updateLastErrorLocked(error);
        return false;
    }
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
        currentConfig_ = defaultConfig;
        looper_.prepare(currentConfig_->sampleRate);
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

bool NativeAudioCore::enqueueCommand(const Command& command, std::string& error) {
    switch (command.type) {
    case CommandType::Record: return recordTrack(0U, error);
    case CommandType::StopRecordOrPlayback: return stopTrack(0U, error);
    case CommandType::Play: return playTrack(0U, error);
    case CommandType::ToggleOverdub: return toggleOverdubTrack(0U, error);
    case CommandType::Clear: return clearTrack(0U, error);
    case CommandType::SetMonitoring:
        return setMonitoring(command.boolValue, error);
    default:
        error = "Unsupported legacy transport command.";
        return false;
    }
}

bool NativeAudioCore::record(std::string& error) {
    return enqueueCommand({CommandType::Record, false}, error);
}

bool NativeAudioCore::stopRecordOrPlayback(std::string& error) {
    return enqueueCommand({CommandType::StopRecordOrPlayback, false}, error);
}

bool NativeAudioCore::play(std::string& error) {
    return enqueueCommand({CommandType::Play, false}, error);
}

bool NativeAudioCore::toggleOverdub(std::string& error) {
    return enqueueCommand({CommandType::ToggleOverdub, false}, error);
}

bool NativeAudioCore::clear(std::string& error) {
    return enqueueCommand({CommandType::Clear, false}, error);
}

bool NativeAudioCore::setMonitoring(bool enabled, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
    if (softwareOnly_) {
        if (!trackHost_.prepared()) {
            error = "The software-only NativeTrackHost has not been prepared.";
            updateLastErrorLocked(error);
            return false;
        }
        if (!trackHost_.setMonitor(enabled)) {
            error = "Native input-monitor command was rejected.";
            updateLastErrorLocked(error);
            return false;
        }
        softwareMonitoringEnabled_ = enabled;
        error.clear();
        return true;
    }
    if (!currentConfig_) {
        error = "Engine has not been configured yet.";
        return false;
    }
    if (!engineRunning_.load(std::memory_order_acquire)) {
        currentConfig_->monitoringEnabled = enabled;
        return true;
    }
    std::lock_guard<std::mutex> producerLock(commandProducerMutex_);
    if (!trackHost_.setMonitor(enabled)) {
        error = "Native input-monitor command was rejected.";
        return false;
    }
    currentConfig_->monitoringEnabled = enabled;
    return true;
}

bool NativeAudioCore::enqueueTrackCommand(std::uint8_t trackIndex, TrackCommandType type,
                                          float value, bool boolValue,
                                          std::string& error) {
    std::lock_guard<std::mutex> controlLock(controlMutex_);
    if (softwareOnly_) {
        if (!trackHost_.prepared()) {
            error = "The software-only NativeTrackHost has not been prepared.";
            return false;
        }
    } else if (!engineRunning_.load(std::memory_order_acquire)) {
        error = "Engine is not running.";
        return false;
    }
    std::lock_guard<std::mutex> lock(commandProducerMutex_);
    bool queued = false;
    switch (type) {
    case TrackCommandType::Record: queued = trackHost_.record(trackIndex); break;
    case TrackCommandType::Stop: queued = trackHost_.stop(trackIndex); break;
    case TrackCommandType::Play: queued = trackHost_.play(trackIndex); break;
    case TrackCommandType::ToggleOverdub: queued = trackHost_.toggleOverdub(trackIndex); break;
    case TrackCommandType::ClearTrack: queued = trackHost_.clear(trackIndex); break;
    case TrackCommandType::SetTrackInputRoute: queued = trackHost_.setInputRoute(trackIndex, boolValue); break;
    case TrackCommandType::SetTrackGain: queued = trackHost_.setGain(trackIndex, value); break;
    case TrackCommandType::SetTrackPan: queued = trackHost_.setPan(trackIndex, value); break;
    case TrackCommandType::SetTrackMute: queued = trackHost_.setMute(trackIndex, boolValue); break;
    case TrackCommandType::SetTrackSolo: queued = trackHost_.setSolo(trackIndex, boolValue); break;
    default: break;
    }
    if (!queued) error = "Native track command is invalid or the bounded queue rejected it.";
    return queued;
}

bool NativeAudioCore::recordTrack(std::uint8_t trackIndex, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::Record, 0.0f, false, error);
}
bool NativeAudioCore::stopTrack(std::uint8_t trackIndex, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::Stop, 0.0f, false, error);
}
bool NativeAudioCore::playTrack(std::uint8_t trackIndex, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::Play, 0.0f, false, error);
}
bool NativeAudioCore::toggleOverdubTrack(std::uint8_t trackIndex, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::ToggleOverdub, 0.0f, false, error);
}
bool NativeAudioCore::clearTrack(std::uint8_t trackIndex, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::ClearTrack, 0.0f, false, error);
}
bool NativeAudioCore::setTrackInputRoute(std::uint8_t trackIndex, bool enabled, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::SetTrackInputRoute, 0.0f, enabled, error);
}
bool NativeAudioCore::setTrackGain(std::uint8_t trackIndex, float gain, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::SetTrackGain, gain, false, error);
}
bool NativeAudioCore::setTrackPan(std::uint8_t trackIndex, float pan, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::SetTrackPan, pan, false, error);
}
bool NativeAudioCore::setTrackMute(std::uint8_t trackIndex, bool muted, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::SetTrackMute, 0.0f, muted, error);
}
bool NativeAudioCore::setTrackSolo(std::uint8_t trackIndex, bool solo, std::string& error) {
    return enqueueTrackCommand(trackIndex, TrackCommandType::SetTrackSolo, 0.0f, solo, error);
}
bool NativeAudioCore::setTempoBpm(double bpm, std::string& error) {
    NativeRhythmCommand command{};
    command.type = NativeRhythmCommandType::Tempo;
    command.bpm = bpm;
    std::uint64_t acceptedFrame = 0U;
    return postRhythmCommand(command, acceptedFrame, error);
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

    if (config.bufferFrames == 0) {
        error = "bufferFrames must be greater than 0.";
        return false;
    }
    if (config.trackBufferSeconds == 0U || config.trackBufferSeconds > 300U) {
        error = "trackBufferSeconds must be in the supported range 1–300 seconds.";
        return false;
    }

    if (config.sampleRate == 96000) {
        error = "96000 Hz is disabled until the native 96 kHz performance gate has a validated P99 callback measurement below the buffer deadline with zero XRUNs.";
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

    if (currentConfig_->backend == Backend::Wasapi) {
        if (!ensureAudioInstanceLocked(audio_, currentConfig_->backend, error) ||
            !ensureAudioInstanceLocked(captureAudio_, currentConfig_->backend, error)) return false;
    } else if (!ensureAudioInstanceLocked(audio_, currentConfig_->backend, error)) {
        return false;
    }

    try {
        const auto inputInfo = currentConfig_->backend == Backend::Wasapi
            ? captureAudio_->getDeviceInfo(inputDeviceId) : audio_->getDeviceInfo(inputDeviceId);
        const auto outputInfo = audio_->getDeviceInfo(outputDeviceId);
        if (inputInfo.inputChannels == 0U || outputInfo.outputChannels < 2U) {
            error = "The selected native devices require at least one input and two output channels.";
            return false;
        }
        inputChannels_ = std::min(2U, inputInfo.inputChannels);
        outputChannels_ = 2U;
    } catch (const std::exception& exception) {
        error = std::string("Failed to inspect selected native device channels: ") + exception.what();
        return false;
    }

    if (!trackHost_.prepare(currentConfig_->sampleRate, currentConfig_->trackBufferSeconds,
                            currentConfig_->trackMemoryBudgetBytes)) {
        error = "Failed to prepare the five-track stereo history within the configured memory budget.";
        return false;
    }
    if (!trackHost_.postTrackCommand({0U, TrackCommandType::SetInputMonitor, 0U,
                                      currentConfig_->monitoringEnabled, 0.0f})) {
        error = "Failed to initialize native monitor routing before stream start.";
        return false;
    }

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
        const auto callbacksStarted = currentConfig_->backend == Backend::Wasapi
            ? inputCallbackTicks_.load(std::memory_order_acquire) > 0 && outputCallbackTicks_.load(std::memory_order_acquire) > 0
            : callbackTicks_.load(std::memory_order_acquire) > 0;
        const auto duplexTimeStarted = audio_ && audio_->isStreamRunning() && audio_->getStreamTime() > 0.0;
        if (callbacksStarted || (currentConfig_->backend != Backend::Wasapi && duplexTimeStarted)) {
            break;
        }
        std::this_thread::sleep_for(callbackPollStep);
        waited += callbackPollStep;
    }

    const bool requiredCallbacksStarted = currentConfig_->backend == Backend::Wasapi
        ? inputCallbackTicks_.load(std::memory_order_acquire) > 0 && outputCallbackTicks_.load(std::memory_order_acquire) > 0
        : callbackTicks_.load(std::memory_order_acquire) > 0;
    if (!requiredCallbacksStarted &&
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
    // Prevent a producer from enqueueing after the callback has stopped and
    // the queue is cleared below.
    {
        std::lock_guard<std::mutex> producerLock(commandProducerMutex_);
        engineRunning_.store(false, std::memory_order_release);
    }
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
    outputQueue_.clear();
}

void NativeAudioCore::resetRuntimeStateLocked() noexcept {
    outputQueue_.clear();
    looperState_.store(static_cast<int>(LooperState::Empty), std::memory_order_release);
    loopProgress_.store(0.0f, std::memory_order_release);
    inputPeak_.store(0.0f, std::memory_order_release);
    outputPeak_.store(0.0f, std::memory_order_release);
    xrunsOrDropouts_.store(0, std::memory_order_release);
    callbackStatusFaults_.store(0, std::memory_order_release);
    inputQueueOverruns_.store(0, std::memory_order_release);
    outputQueueUnderruns_.store(0, std::memory_order_release);
    callbackFrameLimitViolations_.store(0, std::memory_order_release);
    callbackTicks_.store(0, std::memory_order_release);
    inputCallbackTicks_.store(0, std::memory_order_release);
    outputCallbackTicks_.store(0, std::memory_order_release);
    renderPrimed_.store(false, std::memory_order_release);
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

void NativeAudioCore::publishCoreTelemetry(const MultiTrackProcessStats& stats) noexcept {
    const auto snapshot = trackHost_.status();
    const auto& primaryTrack = snapshot.tracks[0];
    looperState_.store(static_cast<int>(toLooperState(primaryTrack.state)), std::memory_order_release);
    const float progress = primaryTrack.loopFrames > 0U
        ? static_cast<float>(primaryTrack.playhead) / static_cast<float>(primaryTrack.loopFrames)
        : 0.0f;
    loopProgress_.store(progress, std::memory_order_release);
    inputPeak_.store(stats.inputPeak, std::memory_order_release);
    outputPeak_.store(stats.outputPeak, std::memory_order_release);
}

int NativeAudioCore::handleAudioCallback(
    void* outputBuffer,
    void* inputBuffer,
    unsigned int nBufferFrames,
    RtAudioStreamStatus status
) {
    if (status != 0) {
        callbackStatusFaults_.fetch_add(1, std::memory_order_relaxed);
        xrunsOrDropouts_.fetch_add(1, std::memory_order_relaxed);
    }

    callbackTicks_.fetch_add(1, std::memory_order_acq_rel);
    inputCallbackTicks_.fetch_add(1, std::memory_order_relaxed);
    outputCallbackTicks_.fetch_add(1, std::memory_order_relaxed);

    MultiTrackProcessStats stats{};
    if (nBufferFrames > kMaxCallbackFrames ||
        !trackHost_.processInputBlock(static_cast<const float*>(inputBuffer), inputChannels_,
                                      static_cast<float*>(outputBuffer), nBufferFrames, &stats)) {
        callbackFrameLimitViolations_.fetch_add(1U, std::memory_order_relaxed);
        xrunsOrDropouts_.fetch_add(1U, std::memory_order_relaxed);
        if (outputBuffer != nullptr && nBufferFrames <= kMaxCallbackFrames)
            std::fill_n(static_cast<float*>(outputBuffer), static_cast<std::size_t>(nBufferFrames) * outputChannels_, 0.0f);
        return 0;
    }

    publishCoreTelemetry(stats);
    return 0;
}

int NativeAudioCore::handleInputAudioCallback(
    void* inputBuffer,
    unsigned int nBufferFrames,
    RtAudioStreamStatus status
) {
    if (status != 0) {
        callbackStatusFaults_.fetch_add(1, std::memory_order_relaxed);
        xrunsOrDropouts_.fetch_add(1, std::memory_order_relaxed);
    }

    callbackTicks_.fetch_add(1, std::memory_order_acq_rel);
    inputCallbackTicks_.fetch_add(1, std::memory_order_relaxed);

    if (nBufferFrames > kMaxCallbackFrames) {
        callbackFrameLimitViolations_.fetch_add(1, std::memory_order_relaxed);
        xrunsOrDropouts_.fetch_add(1, std::memory_order_relaxed);
        return 0;
    }

    AudioBlock block;
    block.frames = nBufferFrames;

    MultiTrackProcessStats stats{};
    if (!trackHost_.processInputBlock(static_cast<const float*>(inputBuffer), inputChannels_,
                                     block.samples.data(), nBufferFrames, &stats)) {
        callbackFrameLimitViolations_.fetch_add(1U, std::memory_order_relaxed);
        xrunsOrDropouts_.fetch_add(1U, std::memory_order_relaxed);
        return 0;
    }

    if (!outputQueue_.push(block)) {
        inputQueueOverruns_.fetch_add(1, std::memory_order_relaxed);
        xrunsOrDropouts_.fetch_add(1, std::memory_order_relaxed);
    }

    publishCoreTelemetry(stats);
    return 0;
}

int NativeAudioCore::handleOutputAudioCallback(
    void* outputBuffer,
    unsigned int nBufferFrames,
    RtAudioStreamStatus status
) {
    if (status != 0) {
        callbackStatusFaults_.fetch_add(1, std::memory_order_relaxed);
        xrunsOrDropouts_.fetch_add(1, std::memory_order_relaxed);
    }

    callbackTicks_.fetch_add(1, std::memory_order_acq_rel);
    outputCallbackTicks_.fetch_add(1, std::memory_order_relaxed);

    auto* output = static_cast<float*>(outputBuffer);
    if (output == nullptr) {
        return 0;
    }

    if (nBufferFrames > kMaxCallbackFrames) {
        const auto maxFrames = std::numeric_limits<std::size_t>::max() / outputChannels_;
        if (nBufferFrames <= maxFrames) {
            std::fill_n(output, static_cast<std::size_t>(nBufferFrames) * outputChannels_, 0.0f);
        }
        callbackFrameLimitViolations_.fetch_add(1, std::memory_order_relaxed);
        xrunsOrDropouts_.fetch_add(1, std::memory_order_relaxed);
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

    AudioBlock block;
    if (!outputQueue_.pop(block)) {
        if (callbackTicks_.load(std::memory_order_acquire) > 0) {
            outputQueueUnderruns_.fetch_add(1, std::memory_order_relaxed);
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
