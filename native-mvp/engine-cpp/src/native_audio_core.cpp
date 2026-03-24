#include "native_audio_core.hpp"

#include <algorithm>
#include <chrono>
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
    : deviceCatalog_(buildCatalog()) {}

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
    status.loopProgress = loopProgress_.load(std::memory_order_acquire);
    status.inputPeak = inputPeak_.load(std::memory_order_acquire);
    status.outputPeak = outputPeak_.load(std::memory_order_acquire);
    status.xrunsOrDropouts = xrunsOrDropouts_.load(std::memory_order_acquire);
    status.callbackTicks = callbackTicks_.load(std::memory_order_acquire);
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

bool NativeAudioCore::applyConfig(const EngineConfig& config, std::string& error) {
    std::lock_guard<std::mutex> lock(controlMutex_);
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

bool NativeAudioCore::record(std::string& error) {
    if (!engineRunning_.load(std::memory_order_acquire)) {
        error = "Engine is not running.";
        return false;
    }
    if (!commandQueue_.push({CommandType::Record, false})) {
        error = "Command queue is full.";
        return false;
    }
    return true;
}

bool NativeAudioCore::stopRecordOrPlayback(std::string& error) {
    if (!engineRunning_.load(std::memory_order_acquire)) {
        error = "Engine is not running.";
        return false;
    }
    if (!commandQueue_.push({CommandType::StopRecordOrPlayback, false})) {
        error = "Command queue is full.";
        return false;
    }
    return true;
}

bool NativeAudioCore::play(std::string& error) {
    if (!engineRunning_.load(std::memory_order_acquire)) {
        error = "Engine is not running.";
        return false;
    }
    if (!commandQueue_.push({CommandType::Play, false})) {
        error = "Command queue is full.";
        return false;
    }
    return true;
}

bool NativeAudioCore::toggleOverdub(std::string& error) {
    if (!engineRunning_.load(std::memory_order_acquire)) {
        error = "Engine is not running.";
        return false;
    }
    if (!commandQueue_.push({CommandType::ToggleOverdub, false})) {
        error = "Command queue is full.";
        return false;
    }
    return true;
}

bool NativeAudioCore::clear(std::string& error) {
    if (!engineRunning_.load(std::memory_order_acquire)) {
        error = "Engine is not running.";
        return false;
    }
    if (!commandQueue_.push({CommandType::Clear, false})) {
        error = "Command queue is full.";
        return false;
    }
    return true;
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

    looper_.prepare(currentConfig_->sampleRate);
    looper_.applyCommand({CommandType::SetMonitoring, currentConfig_->monitoringEnabled});
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
}

void NativeAudioCore::resetRuntimeStateLocked() noexcept {
    commandQueue_.clear();
    outputQueue_.clear();
    looperState_.store(static_cast<int>(LooperState::Empty), std::memory_order_release);
    loopProgress_.store(0.0f, std::memory_order_release);
    inputPeak_.store(0.0f, std::memory_order_release);
    outputPeak_.store(0.0f, std::memory_order_release);
    xrunsOrDropouts_.store(0, std::memory_order_release);
    callbackTicks_.store(0, std::memory_order_release);
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

    Command command{};
    while (commandQueue_.pop(command)) {
        looper_.applyCommand(command);
    }

    const auto stats = looper_.process(
        static_cast<const float*>(inputBuffer),
        static_cast<float*>(outputBuffer),
        nBufferFrames,
        inputChannels_,
        outputChannels_
    );

    looperState_.store(static_cast<int>(stats.state), std::memory_order_release);
    loopProgress_.store(stats.loopProgress, std::memory_order_release);
    inputPeak_.store(stats.inputPeak, std::memory_order_release);
    outputPeak_.store(stats.outputPeak, std::memory_order_release);
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

    Command command{};
    while (commandQueue_.pop(command)) {
        looper_.applyCommand(command);
    }

    if (nBufferFrames > kMaxCallbackFrames) {
        xrunsOrDropouts_.fetch_add(1, std::memory_order_acq_rel);
        return 0;
    }

    AudioBlock block{};
    block.frames = nBufferFrames;

    const auto stats = looper_.process(
        static_cast<const float*>(inputBuffer),
        block.samples.data(),
        nBufferFrames,
        inputChannels_,
        outputChannels_
    );

    if (!outputQueue_.push(block)) {
        xrunsOrDropouts_.fetch_add(1, std::memory_order_acq_rel);
    }

    looperState_.store(static_cast<int>(stats.state), std::memory_order_release);
    loopProgress_.store(stats.loopProgress, std::memory_order_release);
    inputPeak_.store(stats.inputPeak, std::memory_order_release);
    outputPeak_.store(stats.outputPeak, std::memory_order_release);
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
