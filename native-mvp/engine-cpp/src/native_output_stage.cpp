#include "native_output_stage.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {

namespace {

} // namespace

bool NativeOutputStage::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) {
        return false;
    }

    const double cutoffHz = std::min(18000.0, static_cast<double>(sampleRate) * 0.45);
    const double highPassHz = std::min(80.0, static_cast<double>(sampleRate) * 0.08);
    for (auto& filter : lowPassFilters_) {
        if (!filter.setParameters(dsp::BiquadType::LowPass, static_cast<double>(sampleRate), cutoffHz, 0.7071067811865476)) {
            return false;
        }
        filter.reset();
    }
    for (auto& filter : highPassFilters_) {
        if (!filter.setParameters(dsp::BiquadType::HighPass, static_cast<double>(sampleRate), highPassHz, 0.7071067811865476)) {
            return false;
        }
        filter.reset();
    }

    try {
        fractionalDelayMaximumFrames_ = static_cast<std::size_t>(std::max(
            2.0,
            std::round(static_cast<double>(kMaximumDelaySeconds) * static_cast<double>(sampleRate))
        ));
        const auto fractionalDelayCapacity = fractionalDelayMaximumFrames_ + 4U;
        for (auto& delayLine : fractionalDelayBuffers_) {
            delayLine.assign(fractionalDelayCapacity, 0.0f);
        }
    } catch (const std::bad_alloc&) {
        sampleRate_ = 0;
        return false;
    } catch (...) {
        sampleRate_ = 0;
        return false;
    }

    if (!chorusProcessor_.prepare(sampleRate)) {
        sampleRate_ = 0U;
        return false;
    }
    if (!phaserProcessor_.prepare(sampleRate)) {
        sampleRate_ = 0U;
        return false;
    }
    if (!reverbProcessor_.prepare(sampleRate)) {
        sampleRate_ = 0U;
        return false;
    }
    const NativeFdn16ReverbConfig reverbProcessorConfig{
        reverbConfig_.enabled,
        reverbConfig_.wetMix,
        reverbConfig_.rt60Seconds,
        reverbConfig_.dampingCutoffHz,
    };
    if (!reverbProcessor_.setConfig(reverbProcessorConfig, 0U)) {
        sampleRate_ = 0U;
        return false;
    }

    sampleRate_ = sampleRate;
    fractionalDelayWriteIndices_.fill(0U);
    updateCompressorParameters();
    lowPassMix_.reset(0.0f);
    highPassMix_.reset(0.0f);
    fractionalDelayMix_.reset(0.0f);
    fractionalDelayFeedback_.reset(fractionalDelayConfig_.feedback);
    const float initialDelayFrames = std::clamp(
        fractionalDelayConfig_.delayMs * static_cast<float>(sampleRate_) / 1000.0f,
        2.0f,
        static_cast<float>(fractionalDelayMaximumFrames_)
    );
    fractionalDelayFrames_.reset(initialDelayFrames);
    compressorEnvelope_ = 0.0f;
    lowPassMix_.setTarget(lowPassEnabled_ ? 1.0f : 0.0f, lowPassEnabled_ ? 64U : 0U);
    highPassMix_.setTarget(highPassEnabled_ ? 1.0f : 0.0f, highPassEnabled_ ? 64U : 0U);
    fractionalDelayMix_.setTarget(
        fractionalDelayConfig_.enabled ? fractionalDelayConfig_.wetMix : 0.0f,
        fractionalDelayConfig_.enabled ? 64U : 0U
    );
    compressorMix_.reset(compressorConfig_.enabled ? compressorConfig_.wetMix : 0.0f);
    const ChorusProcessorConfig chorusProcessorConfig{
        chorusConfig_.enabled,
        chorusConfig_.rateHz,
        chorusConfig_.depthMs,
        chorusConfig_.feedback,
        chorusConfig_.wetMix,
    };
    if (!chorusProcessor_.setConfig(chorusProcessorConfig, 0U)) {
        sampleRate_ = 0U;
        return false;
    }
    const PhaserProcessorConfig phaserProcessorConfig{
        phaserConfig_.enabled,
        phaserConfig_.stages,
        phaserConfig_.rateHz,
        phaserConfig_.depth,
        phaserConfig_.feedback,
        phaserConfig_.wetMix,
    };
    if (!phaserProcessor_.setConfig(phaserProcessorConfig, 0U)) {
        sampleRate_ = 0U;
        return false;
    }
    if (!trackFxBank_.prepare(sampleRate_)) {
        sampleRate_ = 0U;
        return false;
    }
    return true;
}

unsigned int NativeOutputStage::reverbMinimumDelayFramesForSampleRate(unsigned int sampleRate) noexcept {
    return NativeFdn16ReverbProcessor::minimumDelayFramesForSampleRate(sampleRate);
}

void NativeOutputStage::setLowPassEnabled(bool enabled, std::uint64_t rampFrames) noexcept {
    setEffectEnabled(NativeOutputEffect::LowPass, enabled, rampFrames);
}

void NativeOutputStage::setHighPassEnabled(bool enabled, std::uint64_t rampFrames) noexcept {
    setEffectEnabled(NativeOutputEffect::HighPass, enabled, rampFrames);
}

void NativeOutputStage::setEffectEnabled(NativeOutputEffect effect, bool enabled, std::uint64_t rampFrames) noexcept {
    const float target = enabled ? 1.0f : 0.0f;
    switch (effect) {
    case NativeOutputEffect::LowPass:
        lowPassEnabled_ = enabled;
        lowPassMix_.setTarget(target, rampFrames);
        break;
    case NativeOutputEffect::HighPass:
        highPassEnabled_ = enabled;
        highPassMix_.setTarget(target, rampFrames);
        break;
    }
}

bool NativeOutputStage::setReverbConfig(const NativeReverbConfig& config, std::uint64_t rampFrames) noexcept {
    if (!std::isfinite(config.wetMix) || !std::isfinite(config.rt60Seconds) ||
        !std::isfinite(config.dampingCutoffHz) ||
        config.wetMix < 0.0f || config.wetMix > 1.0f ||
        config.rt60Seconds < 0.1f || config.rt60Seconds > 20.0f ||
        config.dampingCutoffHz < 500.0f || config.dampingCutoffHz > 20000.0f) {
        return false;
    }
    const NativeFdn16ReverbConfig processorConfig{
        config.enabled,
        config.wetMix,
        config.rt60Seconds,
        config.dampingCutoffHz,
    };
    if (!reverbProcessor_.setConfig(processorConfig, rampFrames)) return false;
    reverbConfig_ = config;
    return true;
}

bool NativeOutputStage::setFractionalDelayConfig(
    const NativeFractionalDelayConfig& config,
    std::uint64_t rampFrames
) noexcept {
    const bool validSlot = config.slot == NativeTrackOutputSlot::A ||
        config.slot == NativeTrackOutputSlot::B ||
        config.slot == NativeTrackOutputSlot::C ||
        config.slot == NativeTrackOutputSlot::D;
    if (!validSlot || !NativeTrackOutputBank::isActive(config.slot) ||
        config.algorithm != NativeFractionalDelayAlgorithm::Lagrange4 ||
        !std::isfinite(config.delayMs) || !std::isfinite(config.wetMix) || !std::isfinite(config.feedback) ||
        config.delayMs < 10.0f || config.delayMs > 2000.0f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f ||
        config.feedback < 0.0f || config.feedback > 0.95f) {
        return false;
    }

    fractionalDelayConfig_ = config;
    fractionalDelayMix_.setTarget(config.enabled ? config.wetMix : 0.0f, rampFrames);
    fractionalDelayFeedback_.setTarget(config.feedback, rampFrames);
    if (sampleRate_ != 0U) {
        const float targetDelayFrames = std::clamp(
            config.delayMs * static_cast<float>(sampleRate_) / 1000.0f,
            2.0f,
            static_cast<float>(fractionalDelayMaximumFrames_)
        );
        fractionalDelayFrames_.setTarget(targetDelayFrames, rampFrames);
    }
    return true;
}

bool NativeOutputStage::setCompressorConfig(const NativeCompressorConfig& config, std::uint64_t rampFrames) noexcept {
    const bool validSlot = config.slot == NativeTrackOutputSlot::A ||
        config.slot == NativeTrackOutputSlot::B ||
        config.slot == NativeTrackOutputSlot::C ||
        config.slot == NativeTrackOutputSlot::D;
    if (!validSlot || !NativeTrackOutputBank::isActive(config.slot) ||
        config.algorithm != NativeCompressorAlgorithm::PeakCompressor ||
        !std::isfinite(config.thresholdDb) || !std::isfinite(config.ratio) ||
        !std::isfinite(config.attackMs) || !std::isfinite(config.releaseMs) ||
        !std::isfinite(config.wetMix) || !std::isfinite(config.makeupDb) ||
        config.thresholdDb < -60.0f || config.thresholdDb > 0.0f ||
        config.ratio < 1.0f || config.ratio > 20.0f ||
        config.attackMs < 0.1f || config.attackMs > 200.0f ||
        config.releaseMs < 5.0f || config.releaseMs > 2000.0f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f ||
        config.makeupDb < -12.0f || config.makeupDb > 12.0f) {
        return false;
    }

    compressorConfig_ = config;
    updateCompressorParameters();
    compressorMix_.setTarget(config.enabled ? config.wetMix : 0.0f, rampFrames);
    return true;
}

bool NativeOutputStage::setChorusConfig(const NativeChorusConfig& config, std::uint64_t rampFrames) noexcept {
    const bool validSlot = config.slot == NativeTrackOutputSlot::A ||
        config.slot == NativeTrackOutputSlot::B ||
        config.slot == NativeTrackOutputSlot::C ||
        config.slot == NativeTrackOutputSlot::D;
    if (!validSlot || !NativeTrackOutputBank::isActive(config.slot) ||
        config.algorithm != NativeChorusAlgorithm::StereoLfoLagrange4 ||
        !std::isfinite(config.rateHz) || !std::isfinite(config.depthMs) ||
        !std::isfinite(config.feedback) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.1f || config.rateHz > 8.0f ||
        config.depthMs < 0.0f || config.depthMs > 25.0f ||
        config.feedback < 0.0f || config.feedback > 0.95f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    const ChorusProcessorConfig processorConfig{
        config.enabled,
        config.rateHz,
        config.depthMs,
        config.feedback,
        config.wetMix,
    };
    if (!chorusProcessor_.setConfig(processorConfig, rampFrames)) {
        return false;
    }
    chorusConfig_ = config;
    return true;
}

bool NativeOutputStage::setPhaserConfig(const NativePhaserConfig& config, std::uint64_t rampFrames) noexcept {
    const bool validSlot = config.slot == NativeTrackOutputSlot::A ||
        config.slot == NativeTrackOutputSlot::B ||
        config.slot == NativeTrackOutputSlot::C ||
        config.slot == NativeTrackOutputSlot::D;
    if (!validSlot || !NativeTrackOutputBank::isActive(config.slot) ||
        config.algorithm != NativePhaserAlgorithm::AllpassSweep ||
        (config.stages != 4U && config.stages != 8U && config.stages != 12U) ||
        !std::isfinite(config.rateHz) || !std::isfinite(config.depth) ||
        !std::isfinite(config.feedback) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.05f || config.rateHz > 10.0f ||
        config.depth < 0.0f || config.depth > 1.0f ||
        config.feedback < -0.9f || config.feedback > 0.9f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    const PhaserProcessorConfig processorConfig{
        config.enabled,
        config.stages,
        config.rateHz,
        config.depth,
        config.feedback,
        config.wetMix,
    };
    if (!phaserProcessor_.setConfig(processorConfig, rampFrames)) {
        return false;
    }
    phaserConfig_ = config;
    return true;
}

void NativeOutputStage::updateCompressorParameters() noexcept {
    if (sampleRate_ == 0U) {
        compressorAttackCoefficient_ = 0.0f;
        compressorReleaseCoefficient_ = 0.0f;
    } else {
        const double rate = static_cast<double>(sampleRate_);
        compressorAttackCoefficient_ = static_cast<float>(std::exp(
            -1.0 / (static_cast<double>(compressorConfig_.attackMs) * 0.001 * rate)
        ));
        compressorReleaseCoefficient_ = static_cast<float>(std::exp(
            -1.0 / (static_cast<double>(compressorConfig_.releaseMs) * 0.001 * rate)
        ));
    }
    compressorThresholdAmplitude_ = static_cast<float>(std::pow(10.0, static_cast<double>(compressorConfig_.thresholdDb) / 20.0));
    compressorRatioExponent_ = 1.0f - (1.0f / compressorConfig_.ratio);
    compressorMakeupGain_ = static_cast<float>(std::pow(10.0, static_cast<double>(compressorConfig_.makeupDb) / 20.0));
}

void NativeOutputStage::processCompressor(
    float inputLeft,
    float inputRight,
    float& outputLeft,
    float& outputRight
) noexcept {
    const float detector = std::max(std::fabs(inputLeft), std::fabs(inputRight));
    const float coefficient = detector > compressorEnvelope_ ? compressorAttackCoefficient_ : compressorReleaseCoefficient_;
    compressorEnvelope_ = (coefficient * compressorEnvelope_) + ((1.0f - coefficient) * detector);
    float gain = 1.0f;
    if (compressorEnvelope_ > compressorThresholdAmplitude_) {
        gain = std::pow(compressorThresholdAmplitude_ / compressorEnvelope_, compressorRatioExponent_);
    }
    gain *= compressorMakeupGain_;
    outputLeft = inputLeft * gain;
    outputRight = inputRight * gain;
}

void NativeOutputStage::processFractionalDelay(
    float inputLeft,
    float inputRight,
    float& outputLeft,
    float& outputRight
) noexcept {
    outputLeft = 0.0f;
    outputRight = 0.0f;
    if (sampleRate_ == 0U || fractionalDelayMaximumFrames_ < 2U) {
        return;
    }

    const double delay = std::clamp(
        static_cast<double>(fractionalDelayFrames_.next()),
        2.0,
        static_cast<double>(fractionalDelayMaximumFrames_)
    );
    const auto integerDelay = static_cast<std::size_t>(delay);
    const float fractionalDelay = static_cast<float>(delay - static_cast<double>(integerDelay));
    const float interpolationPosition = 1.0f - fractionalDelay;
    const float feedback = fractionalDelayFeedback_.next();

    for (std::size_t channel = 0; channel < kFilterChannels; ++channel) {
        auto& buffer = fractionalDelayBuffers_[channel];
        const std::size_t capacity = buffer.size();
        const std::size_t writeIndex = fractionalDelayWriteIndices_[channel];
        const auto readAtDelay = [&buffer, capacity, writeIndex](std::size_t delayFrames) noexcept {
            const std::size_t index = writeIndex + capacity - delayFrames;
            return buffer[index >= capacity ? index - capacity : index];
        };

        const float delayed = dsp::lagrange4(
            readAtDelay(integerDelay + 2U),
            readAtDelay(integerDelay + 1U),
            readAtDelay(integerDelay),
            readAtDelay(integerDelay - 1U),
            interpolationPosition
        );
        const float input = channel == 0U ? inputLeft : inputRight;
        buffer[writeIndex] = input + (feedback * delayed);
        const std::size_t next = writeIndex + 1U;
        fractionalDelayWriteIndices_[channel] = next == capacity ? 0U : next;
        if (channel == 0U) {
            outputLeft = delayed;
        } else {
            outputRight = delayed;
        }
    }
}

float NativeOutputStage::processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept {
    if (interleaved == nullptr || frames == 0 || channels == 0) {
        return 0.0f;
    }

    float peak = 0.0f;
    for (unsigned int frame = 0; frame < frames; ++frame) {
        const float lowPassMix = lowPassMix_.next();
        const float highPassMix = highPassMix_.next();
        const std::size_t offset = static_cast<std::size_t>(frame) * channels;
        const unsigned int filteredChannels = std::min(channels, kFilterChannels);

        const float dryLeft = interleaved[offset];
        const float dryRight = channels > 1U ? interleaved[offset + 1U] : 0.0f;
        float delayedLeft = 0.0f;
        float delayedRight = 0.0f;
        processFractionalDelay(dryLeft, dryRight, delayedLeft, delayedRight);
        const float fractionalDelayMix = fractionalDelayMix_.next();
        const auto delayGains = dsp::equalPowerCrossfadeGains(fractionalDelayMix);
        const float delayOutputLeft = (dryLeft * delayGains.first) + (delayedLeft * delayGains.second);
        const float delayOutputRight = (dryRight * delayGains.first) + (delayedRight * delayGains.second);

        interleaved[offset] = delayOutputLeft;
        if (channels > 1U) {
            interleaved[offset + 1U] = delayOutputRight;
        }
        (void)chorusProcessor_.processInPlace(interleaved + offset, 1U, channels);
        (void)phaserProcessor_.processInPlace(interleaved + offset, 1U, channels);
        if (channels > 1U) {
            (void)reverbProcessor_.processInPlace(interleaved + offset, 1U, channels);
        } else {
            // Feed a correlated stereo pair through the FDN and fold the wet
            // return back to mono without allocating in the callback.
            std::array<float, 2U> monoPair{{interleaved[offset], interleaved[offset]}};
            (void)reverbProcessor_.processInPlace(monoPair.data(), 1U, 2U);
            interleaved[offset] = 0.5f * (monoPair[0] + monoPair[1]);
        }
        const float reverberatedLeft = interleaved[offset];
        const float reverberatedRight = channels > 1U ? interleaved[offset + 1U] : reverberatedLeft;

        float compressedLeft = 0.0f;
        float compressedRight = 0.0f;
        processCompressor(reverberatedLeft, reverberatedRight, compressedLeft, compressedRight);
        const float compressorMix = compressorMix_.next();
        const auto compressorGains = dsp::equalPowerCrossfadeGains(compressorMix);

        for (unsigned int channel = 0; channel < filteredChannels; ++channel) {
            const std::size_t index = offset + channel;
            const float reverberated = channel == 0U ? reverberatedLeft : reverberatedRight;
            const float compressed = channel == 0U ? compressedLeft : compressedRight;
            const float compressedOutput = (reverberated * compressorGains.first) + (compressed * compressorGains.second);
            const float highPassed = highPassFilters_[channel].process(compressedOutput);
            float output = compressedOutput + ((highPassed - compressedOutput) * highPassMix);
            const float lowPassed = lowPassFilters_[channel].process(output);
            output += (lowPassed - output) * lowPassMix;
            interleaved[index] = output;
            peak = std::max(peak, std::fabs(output));
        }

        for (unsigned int channel = filteredChannels; channel < channels; ++channel) {
            const float output = interleaved[offset + channel];
            peak = std::max(peak, std::fabs(output));
        }
    }
    return peak;
}

ProcessStats processNativeAudioBlock(
    LooperCore& looper,
    NativeOutputStage& outputStage,
    const float* inputInterleaved,
    float* outputInterleaved,
    unsigned int frames,
    unsigned int inputChannels,
    unsigned int outputChannels,
    NativeRhythmEngine* rhythmEngine,
    std::uint64_t startFrame,
    NativeEffectBank* trackFxBank,
    float* playbackOnlyInterleaved,
    NativePitchProcessor* pitchProcessor,
    bool pitchRequested,
    bool reversePlayback,
    NativePitchRouteDecision* pitchRouteDecision,
    NativePolyPitchProcessor* polyPitchProcessor,
    bool polyPitchMode
) {
    NativeEffectBank* effectiveTrackFxBank = trackFxBank != nullptr ? trackFxBank : &outputStage.trackFxBank();
    float* playbackOnly = playbackOnlyInterleaved != nullptr ? playbackOnlyInterleaved : outputStage.playbackOnlyScratch();
    const bool trackFxActive = effectiveTrackFxBank != nullptr && effectiveTrackFxBank->hasEffects();
    NativePitchProcessor* selectedMonoProcessor = polyPitchMode ? nullptr : pitchProcessor;
    NativePolyPitchProcessor* selectedPolyProcessor = polyPitchMode ? polyPitchProcessor : nullptr;
    const bool processorPrepared = selectedMonoProcessor != nullptr
        ? selectedMonoProcessor->prepared()
        : selectedPolyProcessor != nullptr && selectedPolyProcessor->prepared();
    const unsigned int pitchLatency = selectedMonoProcessor != nullptr
        ? selectedMonoProcessor->latencySamples()
        : selectedPolyProcessor != nullptr ? selectedPolyProcessor->latencySamples() : 0U;
    auto pitchRoute = !processorPrepared
        ? NativePitchRouteDecision{false, pitchRequested
            ? NativePitchFallbackReason::ProcessorNotPrepared
            : NativePitchFallbackReason::NotRequested}
        : decideNativePitchRoute(
            pitchRequested,
            processorPrepared,
            reversePlayback,
            outputChannels,
            looper.loopLengthSamples(),
            pitchLatency
        );
    const bool playbackBufferAvailable = playbackOnly != nullptr && outputInterleaved != nullptr &&
        outputChannels > 0U && outputChannels <= 2U && frames <= NativeOutputStage::kMaxProcessFrames;
    if (pitchRoute.useProcessor && !playbackBufferAvailable) {
        pitchRoute = {false, NativePitchFallbackReason::PlaybackBufferUnavailable};
    }
    if (pitchRouteDecision != nullptr) *pitchRouteDecision = pitchRoute;

    const bool hasSelectedPitchProcessor = selectedMonoProcessor != nullptr || selectedPolyProcessor != nullptr;
    const bool playbackFxActive = playbackBufferAvailable &&
        (trackFxActive || (hasSelectedPitchProcessor && pitchRequested));
    if (!playbackFxActive) {
        effectiveTrackFxBank = nullptr;
    }

    auto stats = looper.process(
        inputInterleaved,
        outputInterleaved,
        frames,
        inputChannels,
        outputChannels,
        playbackFxActive ? playbackOnly : nullptr
    );
    if (playbackFxActive && playbackOnly != nullptr && outputInterleaved != nullptr) {
        const std::size_t sampleCount = static_cast<std::size_t>(frames) * outputChannels;
        // Preserve the live component (monitor/overdub input) while replacing
        // only the dry loop component with its processed A-D chain output.
        for (std::size_t sample = 0U; sample < sampleCount; ++sample) {
            outputInterleaved[sample] -= playbackOnly[sample];
        }
        if (effectiveTrackFxBank != nullptr && trackFxActive) {
            (void)effectiveTrackFxBank->processInPlace(playbackOnly, frames, outputChannels);
        }
        if (pitchRoute.useProcessor) {
            const bool processed = selectedMonoProcessor != nullptr
                ? selectedMonoProcessor->processInterleaved(playbackOnly, frames, outputChannels)
                : selectedPolyProcessor != nullptr &&
                    selectedPolyProcessor->processInterleaved(playbackOnly, frames, outputChannels);
            if (!processed) {
                pitchRoute = {false, NativePitchFallbackReason::PlaybackBufferUnavailable};
                if (pitchRouteDecision != nullptr) *pitchRouteDecision = pitchRoute;
            }
        }
        for (std::size_t sample = 0U; sample < sampleCount; ++sample) {
            outputInterleaved[sample] += playbackOnly[sample];
        }
    }
    if (rhythmEngine != nullptr) {
        rhythmEngine->processAdditive(outputInterleaved, frames, outputChannels, startFrame);
    }
    stats.outputPeak = outputStage.processInPlace(outputInterleaved, frames, outputChannels);
    return stats;
}

} // namespace webrc::native
