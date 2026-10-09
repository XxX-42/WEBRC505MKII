#include "webrc/dsp/signalsmith_adapter.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

namespace webrc::dsp {

namespace {

bool validMode(PitchQualityMode mode) noexcept {
    return mode == PitchQualityMode::LiveMono ||
           mode == PitchQualityMode::LivePoly ||
           mode == PitchQualityMode::HqRender;
}

bool validStretchSettings(const ProcessSpec& spec,
                          const SignalsmithStretchSettings& settings) noexcept {
    return validProcessSpec(spec) && validMode(settings.mode) &&
           settings.channels >= 1 && settings.channels <= 2 &&
           settings.channels == spec.channels &&
           settings.blockSamples >= 64 && settings.blockSamples <= 16384 &&
           settings.intervalSamples >= 16 &&
           settings.intervalSamples <= settings.blockSamples &&
           spec.maxBlockFrames <= 8192;
}

bool validPlaybackRate(float playbackRate) noexcept {
    return std::isfinite(playbackRate) && playbackRate >= 0.25f && playbackRate <= 4.0f;
}

std::uint32_t seekScratchCapacity(const ProcessSpec& spec,
                                  const SignalsmithStretchSettings& settings) noexcept {
    // outputSeekLength() = inputLatency + rate * outputLatency(). The pinned
    // STFT's input latency is at most its window and its output latency is at
    // most window + interval (split computation). For the supported 0.25..4x
    // playback-rate range, this conservative bound is 5*window + 4*interval.
    const std::uint64_t window = settings.blockSamples;
    const std::uint64_t interval = settings.intervalSamples;
    const std::uint64_t maximumSeek = 5U * window + 4U * interval + 8U;
    const auto capacity = std::max<std::uint64_t>(spec.maxBlockFrames, maximumSeek);
    if (capacity > std::numeric_limits<std::uint32_t>::max()) return 0U;
    return static_cast<std::uint32_t>(capacity);
}

bool addWouldOverflow(std::size_t left, std::size_t right) noexcept {
    return right > std::numeric_limits<std::size_t>::max() - left;
}

} // namespace

SignalsmithStretchAdapter::SignalsmithStretchAdapter(std::uint32_t seed) noexcept
    : constructorSeed_(seed & 0x7fffffffU) {
    settings_.seed = constructorSeed_;
}

std::size_t SignalsmithStretchAdapter::requiredPrepareBytes(
    const ProcessSpec& spec, const SignalsmithStretchSettings& settings) noexcept {
    if (!validStretchSettings(spec, settings)) return 0;

    // Signalsmith's STFT and stretch workspaces are O(blockSamples * channels).
    // Reserve 512 bytes per configured channel-frame, plus planar callback
    // input/output sanitation scratch and a fixed allowance for FFT vectors, vector capacity/metadata,
    // and allocator bookkeeping. This intentionally exceeds observed payload
    // use for the pinned v1.4.0 source tree; it remains an estimate, so graph
    // planners also leave headroom within the fixed module memory cap.
    constexpr std::size_t bytesPerEngineChannelFrame = 512;
    constexpr std::size_t fixedAllowanceBytes = 64U * 1024U;
    const auto channels = static_cast<std::size_t>(settings.channels);
    const auto engineFrames = static_cast<std::size_t>(settings.blockSamples) +
                              static_cast<std::size_t>(settings.intervalSamples) + 1U;
    const auto callbackFrames = static_cast<std::size_t>(spec.maxBlockFrames);
    const auto seekFrames = static_cast<std::size_t>(seekScratchCapacity(spec, settings));
    if (seekFrames == 0U) return 0U;
    if (engineFrames > (std::numeric_limits<std::size_t>::max() - fixedAllowanceBytes) /
                           (channels * bytesPerEngineChannelFrame)) {
        return 0;
    }
    std::size_t total = fixedAllowanceBytes +
                        engineFrames * channels * bytesPerEngineChannelFrame;
    const auto seekScratchBytesPerFrame = channels * 2U * sizeof(float);
    if (seekFrames > (std::numeric_limits<std::size_t>::max() - total) /
                         seekScratchBytesPerFrame) {
        return 0;
    }
    total += seekFrames * seekScratchBytesPerFrame;
    (void)callbackFrames; // seek scratch is the larger of callback and render-tail bounds.
    return total;
}

bool SignalsmithStretchAdapter::prepare(const ProcessSpec& spec,
                                        const SignalsmithStretchSettings& settings,
                                        std::size_t peakBudgetBytes) noexcept {
    if (!validStretchSettings(spec, settings) ||
        (settings.seed & 0x7fffffffU) != constructorSeed_) {
        return false;
    }

    const std::size_t candidateBytes = requiredPrepareBytes(spec, settings);
    if (candidateBytes == 0) return false;
    std::size_t stagingPeakBytes = candidateBytes;
    if (prepared_) {
        if (addWouldOverflow(stagingPeakBytes, preparedBytes_)) return false;
        stagingPeakBytes += preparedBytes_;
    }
    if (stagingPeakBytes > peakBudgetBytes) return false;

    // Build a complete replacement off the active instance. Rejected settings
    // or a recoverable native allocation failure leave the current processor,
    // settings, and callback scratch usable.
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    try {
#endif
        auto candidate = std::unique_ptr<Engine>(
            new (std::nothrow) Engine(static_cast<long>(constructorSeed_)));
        if (!candidate) return false;
        candidate->configure(static_cast<int>(settings.channels),
                             static_cast<int>(settings.blockSamples),
                             static_cast<int>(settings.intervalSamples),
                             settings.splitComputation);
        candidate->setTransposeFactor(1.0f);
        candidate->setFormantFactor(1.0f, false);

        const auto candidateSeekCapacity = seekScratchCapacity(spec, settings);
        if (candidateSeekCapacity == 0U) return false;
        std::array<std::vector<float>, 2> candidateInputScratch;
        std::array<std::vector<float>, 2> candidateOutputScratch;
        for (std::uint32_t channel = 0; channel < settings.channels; ++channel) {
            candidateInputScratch[channel].resize(candidateSeekCapacity);
            candidateOutputScratch[channel].resize(candidateSeekCapacity);
        }

        engine_.swap(candidate);
        finiteInputScratch_.swap(candidateInputScratch);
        finiteOutputScratch_.swap(candidateOutputScratch);
        spec_ = spec;
        settings_ = settings;
        settings_.seed = constructorSeed_;
        seekInputCapacityFrames_ = candidateSeekCapacity;
        preparedBytes_ = candidateBytes;
        prepared_ = true;
        return true;
#if defined(__cpp_exceptions) || defined(_CPPUNWIND)
    } catch (...) {
        return false;
    }
#endif
}

void SignalsmithStretchAdapter::reset() noexcept {
    if (prepared_ && engine_) engine_->reset();
}

bool SignalsmithStretchAdapter::setTransposeFactor(float factor,
                                                   float tonalityLimit) noexcept {
    if (!prepared_ || !engine_ || !std::isfinite(factor) || factor < 0.25f || factor > 4.0f ||
        !std::isfinite(tonalityLimit) || tonalityLimit < 0.0f || tonalityLimit > 0.5f) {
        return false;
    }
    engine_->setTransposeFactor(factor, tonalityLimit);
    return true;
}

bool SignalsmithStretchAdapter::setFormantFactor(float factor,
                                                 bool compensatePitch) noexcept {
    if (!prepared_ || !engine_ || !std::isfinite(factor) || factor < 0.5f || factor > 2.0f) {
        return false;
    }
    engine_->setFormantFactor(factor, compensatePitch);
    return true;
}

bool SignalsmithStretchAdapter::process(const float* const* inputChannels,
                                        std::uint32_t inputFrames,
                                        float* const* outputChannels,
                                        std::uint32_t outputFrames) noexcept {
    if (!prepared_ || !engine_ || inputChannels == nullptr || outputChannels == nullptr ||
        inputFrames == 0 || outputFrames == 0 ||
        inputFrames > spec_.maxBlockFrames || outputFrames > spec_.maxBlockFrames ||
        inputFrames > 8192 || outputFrames > 8192) {
        return false;
    }
    for (std::uint32_t channel = 0; channel < settings_.channels; ++channel) {
        if (inputChannels[channel] == nullptr || outputChannels[channel] == nullptr) return false;
    }

    std::array<const float*, 2> finiteInputs{};
    std::array<float*, 2> finiteOutputs{};
    for (std::uint32_t channel = 0; channel < settings_.channels; ++channel) {
        auto& inputScratch = finiteInputScratch_[channel];
        auto& outputScratch = finiteOutputScratch_[channel];
        if (inputScratch.size() < inputFrames || outputScratch.size() < outputFrames) return false;
        for (std::uint32_t frame = 0; frame < inputFrames; ++frame) {
            inputScratch[frame] = sanitize(inputChannels[channel][frame]);
        }
        finiteInputs[channel] = inputScratch.data();
        finiteOutputs[channel] = outputScratch.data();
    }

    engine_->process(InputView{finiteInputs.data()}, static_cast<int>(inputFrames),
                     OutputView{finiteOutputs.data()}, static_cast<int>(outputFrames));
    for (std::uint32_t channel = 0; channel < settings_.channels; ++channel) {
        for (std::uint32_t frame = 0; frame < outputFrames; ++frame) {
            outputChannels[channel][frame] = sanitize(finiteOutputScratch_[channel][frame]);
        }
    }
    return true;
}

bool SignalsmithStretchAdapter::outputSeekLength(float playbackRate,
                                                 std::uint32_t& inputFrames) const noexcept {
    if (!prepared_ || !engine_ || !validPlaybackRate(playbackRate)) return false;
    const int required = engine_->outputSeekLength(playbackRate);
    if (required <= 0 || static_cast<std::uint32_t>(required) > seekInputCapacityFrames_) {
        return false;
    }
    inputFrames = static_cast<std::uint32_t>(required);
    return true;
}

bool SignalsmithStretchAdapter::outputSeek(const float* const* inputChannels,
                                           std::uint32_t inputFrames,
                                           float playbackRate) noexcept {
    std::uint32_t requiredFrames = 0U;
    if (!prepared_ || !engine_ || inputChannels == nullptr ||
        !validPlaybackRate(playbackRate) ||
        !outputSeekLength(playbackRate, requiredFrames) || inputFrames != requiredFrames ||
        inputFrames > seekInputCapacityFrames_) {
        return false;
    }

    std::array<const float*, 2> finiteInputs{};
    for (std::uint32_t channel = 0; channel < settings_.channels; ++channel) {
        if (inputChannels[channel] == nullptr ||
            finiteInputScratch_[channel].size() < inputFrames) return false;
        auto& scratch = finiteInputScratch_[channel];
        for (std::uint32_t frame = 0; frame < inputFrames; ++frame) {
            scratch[frame] = sanitize(inputChannels[channel][frame]);
        }
        finiteInputs[channel] = scratch.data();
    }

    engine_->outputSeek(InputView{finiteInputs.data()}, static_cast<int>(inputFrames));
    return true;
}

bool SignalsmithStretchAdapter::flush(float* const* outputChannels,
                                      std::uint32_t outputFrames,
                                      float playbackRate) noexcept {
    if (!prepared_ || !engine_ || outputChannels == nullptr || outputFrames == 0U ||
        outputFrames > seekInputCapacityFrames_ ||
        !validPlaybackRate(playbackRate)) {
        return false;
    }

    std::array<float*, 2> finiteOutputs{};
    for (std::uint32_t channel = 0; channel < settings_.channels; ++channel) {
        if (outputChannels[channel] == nullptr ||
            finiteOutputScratch_[channel].size() < outputFrames) return false;
        finiteOutputs[channel] = finiteOutputScratch_[channel].data();
    }

    engine_->flush(OutputView{finiteOutputs.data()}, static_cast<int>(outputFrames), playbackRate);
    for (std::uint32_t channel = 0; channel < settings_.channels; ++channel) {
        for (std::uint32_t frame = 0; frame < outputFrames; ++frame) {
            outputChannels[channel][frame] = sanitize(finiteOutputScratch_[channel][frame]);
        }
    }
    return true;
}

int SignalsmithStretchAdapter::inputLatencySamples() const noexcept {
    return prepared_ && engine_ ? engine_->inputLatency() : 0;
}

int SignalsmithStretchAdapter::outputLatencySamples() const noexcept {
    return prepared_ && engine_ ? engine_->outputLatency() : 0;
}

} // namespace webrc::dsp
