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

bool accumulateVector(std::size_t count, std::size_t elementBytes,
                      std::size_t& total) noexcept {
    if (count != 0U && elementBytes >
        (std::numeric_limits<std::size_t>::max() - total) / count) return false;
    total += count * elementBytes;
    return true;
}

std::size_t splitFftFastSizeAbove(std::size_t size) noexcept {
    if (size == 0U) return 0U;
    std::size_t powerOfTwo = 1U;
    while (powerOfTwo < 16U && powerOfTwo < size) powerOfTwo *= 2U;
    while (powerOfTwo <= std::numeric_limits<std::size_t>::max() / 8U &&
           powerOfTwo * 8U < size) powerOfTwo *= 2U;
    const std::size_t multiple = (size + powerOfTwo - 1U) / powerOfTwo;
    const std::size_t adjustedMultiple = multiple == 7U ? multiple + 1U : multiple;
    if (adjustedMultiple > std::numeric_limits<std::size_t>::max() / powerOfTwo) return 0U;
    return adjustedMultiple * powerOfTwo;
}

// Payload model for the pinned Signalsmith Stretch 1.3.2 and the repository-
// pinned Signalsmith Linear source. This enumerates the vectors configured by SignalsmithStretch::configure
// and DynamicSTFT/ModifiedRealFFT/SplitFFT. The returned payload is padded by
// 50%, plus 64 bytes per vector, for the MSVC allocator's observed +39 byte
// vector overhead and additional WASM allocator/alignment slack. It is a bound
// for the pinned implementation/configuration, not a standard-library guarantee.
bool pinnedEngineVectorPayload(const SignalsmithStretchSettings& settings,
                               std::size_t& payloadBytes) noexcept {
    const std::size_t block = settings.blockSamples;
    const std::size_t interval = settings.intervalSamples;
    const std::size_t channels = settings.channels;
    if (block == 0U || interval == 0U || channels == 0U) return false;

    // Mirrors DynamicSTFT::configure -> RealFFT::fastSizeAbove -> SplitFFT::fastSizeAbove.
    const std::size_t stftMinimum = (block + 1U) / 2U;
    const std::size_t fftMinimum = (stftMinimum + 1U) / 2U;
    const std::size_t fftHalf = splitFftFastSizeAbove(fftMinimum);
    if (fftHalf == 0U || fftHalf > std::numeric_limits<std::size_t>::max() / 4U) return false;
    const std::size_t fftFrames = fftHalf * 4U;
    const std::size_t half = fftFrames / 2U;
    const std::size_t bands = half; // DynamicSTFT uses modified spectrum, not unpacked.

    std::size_t inner = 1U;
    std::size_t outer = half; // SplitFFT is configured at fftFrames / 2.
    while ((outer & 1U) == 0U && (outer > 1U || inner < 32U)) {
        inner *= 2U;
        outer /= 2U;
    }
    const std::size_t outerTwiddleCount = inner * (outer - 1U);
    const std::size_t planSteps = outer <= 1U ? 1U : outer + 3U;
    const bool genericFinal = outer > 1U && outer != 2U && outer != 3U &&
                              outer != 4U && outer != 5U;
    constexpr std::size_t complexBytes = sizeof(std::complex<float>);
    constexpr std::size_t floatBytes = sizeof(float);
    constexpr std::size_t peakBytes = sizeof(float) * 2U;
    constexpr std::size_t bandBytes = sizeof(std::complex<float>) * 3U + sizeof(float);
    constexpr std::size_t predictionBytes = sizeof(std::complex<float>) + sizeof(float);
    constexpr std::size_t stepAlignment = alignof(std::size_t);
    constexpr std::size_t stepBytes =
        ((sizeof(std::size_t) + sizeof(int) + stepAlignment - 1U) / stepAlignment) * stepAlignment;

    std::size_t payload = 0U;
    // STFT input/output and windows; input is also stashed, as is output state.
    if (!accumulateVector((block + interval + 1U) * channels, floatBytes, payload) ||
        !accumulateVector(block * channels, floatBytes, payload) ||
        !accumulateVector(block, floatBytes, payload) ||
        !accumulateVector(bands * channels, complexBytes, payload) ||
        !accumulateVector(std::max(fftFrames, block), floatBytes, payload) ||
        !accumulateVector(block * 2U, floatBytes, payload) ||
        !accumulateVector((block + interval + 1U) * channels, floatBytes, payload) ||
        !accumulateVector(block * channels, floatBytes, payload) ||
        !accumulateVector(block, floatBytes, payload)) return false;

    // RealFFT<..., split=false, halfBinShift=true> and its SplitFFT/Pow2FFT.
    if (!accumulateVector(half, complexBytes, payload) ||
        !accumulateVector((inner * 3U) / 4U, complexBytes, payload) ||
        !accumulateVector(inner, complexBytes, payload) ||
        !accumulateVector(outerTwiddleCount, complexBytes, payload) ||
        !accumulateVector(outerTwiddleCount * 2U, floatBytes, payload) ||
        !accumulateVector(genericFinal ? outer : 0U, complexBytes, payload) ||
        !accumulateVector(genericFinal ? outer : 0U, complexBytes, payload) ||
        !accumulateVector(planSteps, stepBytes, payload) ||
        !accumulateVector(half * 2U, complexBytes, payload) ||
        !accumulateVector(half / 2U + 1U, complexBytes, payload) ||
        !accumulateVector(half, complexBytes, payload)) return false;

    // Stretch state, copied STFT state, and processing/pre-roll workspaces.
    const std::size_t outputLatencyUpper = block + interval;
    if (!accumulateVector(block + interval, floatBytes, payload) ||
        !accumulateVector(outputLatencyUpper * channels, floatBytes, payload) ||
        !accumulateVector(bands * channels, bandBytes, payload) ||
        !accumulateVector(bands / 2U, peakBytes, payload) ||
        !accumulateVector(bands * 2U, floatBytes, payload) ||
        !accumulateVector(bands * 2U, floatBytes, payload) ||
        !accumulateVector(bands, floatBytes * 2U, payload) ||
        !accumulateVector(bands * channels, predictionBytes, payload) ||
        !accumulateVector(bands + 2U, floatBytes, payload)) return false;

    // The pinned source has at most 32 vector payload buffers across the
    // configured STFT, FFT, copied STFT state, and stretch workspaces. Some
    // buffers are zero-sized for power-of-two configurations; charging all 32
    // is conservative. The Linear source is pinned by the build manifest
    // because it does not publish a version constant.
    constexpr std::size_t vectorCount = 32U;
    if (payload > (std::numeric_limits<std::size_t>::max() - vectorCount * 64U) / 3U * 2U)
        return false;
    payload = (payload * 3U + 1U) / 2U;
    if (vectorCount * 64U > std::numeric_limits<std::size_t>::max() - payload) return false;
    payload += vectorCount * 64U;
    payloadBytes = payload;
    return true;
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
    // Reserve 512 bytes per configured channel-frame, plus planar seek/render
    // scratch and an allowance for FFT vectors, vector
    // capacity/metadata, and allocator bookkeeping. The exact vendor source
    // set is pinned by the build manifest; the live-only path uses the more
    // explicit container model above. This remains an estimate, so graph
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

std::size_t SignalsmithStretchAdapter::requiredLivePrepareBytes(
    const ProcessSpec& spec, const SignalsmithStretchSettings& settings) noexcept {
    if (Engine::version[0] != 1U || Engine::version[1] != 3U || Engine::version[2] != 2U ||
        !validStretchSettings(spec, settings)) return 0U;
    std::size_t vendorPayload = 0U;
    if (!pinnedEngineVectorPayload(settings, vendorPayload)) return 0U;
    std::size_t total = sizeof(Engine);
    if (vendorPayload > std::numeric_limits<std::size_t>::max() - total) return 0U;
    total += vendorPayload;
    // Four planar sanitation/output vectors are sized to the maximum callback,
    // never to the offline outputSeekLength bound.
    const std::size_t callbackFrames = spec.maxBlockFrames;
    const std::size_t scratchBytes = static_cast<std::size_t>(settings.channels) *
                                     callbackFrames * sizeof(float) * 2U;
    if (scratchBytes > std::numeric_limits<std::size_t>::max() - total - 4U * 64U) return 0U;
    total += scratchBytes + 4U * 64U;
    return total;
}

bool SignalsmithStretchAdapter::prepare(const ProcessSpec& spec,
                                        const SignalsmithStretchSettings& settings,
                                        std::size_t peakBudgetBytes) noexcept {
    return prepareWithScratch(spec, settings, peakBudgetBytes, true);
}

bool SignalsmithStretchAdapter::prepareLive(const ProcessSpec& spec,
                                            const SignalsmithStretchSettings& settings,
                                            std::size_t peakBudgetBytes) noexcept {
    return prepareWithScratch(spec, settings, peakBudgetBytes, false);
}

bool SignalsmithStretchAdapter::prepareWithScratch(
    const ProcessSpec& spec, const SignalsmithStretchSettings& settings,
    std::size_t peakBudgetBytes, bool offlineRenderScratch) noexcept {
    if (!validStretchSettings(spec, settings) ||
        (settings.seed & 0x7fffffffU) != constructorSeed_) {
        return false;
    }

    const std::size_t candidateBytes = offlineRenderScratch
        ? requiredPrepareBytes(spec, settings)
        : requiredLivePrepareBytes(spec, settings);
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

        const auto candidateSeekCapacity = offlineRenderScratch
            ? seekScratchCapacity(spec, settings) : spec.maxBlockFrames;
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
        offlineRenderScratch_ = offlineRenderScratch;
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
    if (!prepared_ || !engine_ || !offlineRenderScratch_ ||
        !validPlaybackRate(playbackRate)) return false;
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
    if (!prepared_ || !engine_ || !offlineRenderScratch_ || inputChannels == nullptr ||
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
    if (!prepared_ || !engine_ || !offlineRenderScratch_ ||
        outputChannels == nullptr || outputFrames == 0U ||
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
