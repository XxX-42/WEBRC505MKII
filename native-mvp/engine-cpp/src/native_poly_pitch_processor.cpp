#include "native_poly_pitch_processor.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native {

unsigned int NativePolyPitchProcessor::calculateLatencySamples(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return 0U;
    // Matches Signalsmith Stretch 1.3.2 presetCheaper(sampleRate, split=true):
    // analysis + synthesis window delays sum to blockSamples and split work
    // adds one interval to outputLatency().
    const auto blockSamples = static_cast<unsigned int>(static_cast<float>(sampleRate) * 0.1f);
    const auto intervalSamples = static_cast<unsigned int>(static_cast<float>(sampleRate) * 0.04f);
    return blockSamples + intervalSamples;
}

unsigned int NativePolyPitchProcessor::calculateFxLatencySamples(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return 0U;
    // Catalog TRANSPOSE uses a 32 ms analysis window, 8 ms split-compute hop:
    // the Signalsmith API reports their sum as its input + output latency.
    const auto blockSamples = static_cast<unsigned int>(static_cast<float>(sampleRate) * 0.032f);
    const auto intervalSamples = static_cast<unsigned int>(static_cast<float>(sampleRate) * 0.008f);
    return blockSamples + intervalSamples;
}

bool NativePolyPitchProcessor::validSemitones(float semitones) noexcept {
    return std::isfinite(semitones) && semitones >= -static_cast<float>(kMaximumSemitones) &&
        semitones <= static_cast<float>(kMaximumSemitones);
}

bool NativePolyPitchProcessor::validFormantSemitones(float semitones) noexcept {
    return std::isfinite(semitones) && semitones >= -12.0f && semitones <= 12.0f;
}

bool NativePolyPitchProcessor::prepare(unsigned int sampleRate, float semitones) noexcept {
    return prepareConfigured(sampleRate, semitones, 100U, 40U, true);
}

bool NativePolyPitchProcessor::prepareForFx(unsigned int sampleRate, float semitones) noexcept {
    return prepareConfigured(sampleRate, semitones, 32U, 8U, true);
}

bool NativePolyPitchProcessor::prepareConfigured(
    unsigned int sampleRate,
    float semitones,
    unsigned int blockMilliseconds,
    unsigned int intervalMilliseconds,
    bool splitComputation
) noexcept {
    prepared_ = false;
    sampleRate_ = 0U;
    latencySamples_ = 0U;
    inputChannels_ = 0U;
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate ||
        blockMilliseconds < 16U || blockMilliseconds > 120U || intervalMilliseconds == 0U ||
        intervalMilliseconds > blockMilliseconds || !validSemitones(semitones)) {
        return false;
    }

    try {
        const auto blockSamples = static_cast<int>(static_cast<float>(sampleRate) *
            static_cast<float>(blockMilliseconds) / 1000.0f);
        const auto intervalSamples = static_cast<int>(static_cast<float>(sampleRate) *
            static_cast<float>(intervalMilliseconds) / 1000.0f);
        engine_.configure(static_cast<int>(kEngineChannels), blockSamples, intervalSamples, splitComputation);
        engine_.reset();
        targetFormantSemitones_ = 0.0f;
        formantBaseHz_ = 0.0f;
        formantCompensation_ = false;
        engine_.setFormantSemitones(0.0f, false);
        engine_.setFormantBase(0.0f);
        sampleRate_ = sampleRate;
        latencySamples_ = static_cast<unsigned int>(engine_.inputLatency() + engine_.outputLatency());
        targetSemitones_ = semitones;
        engine_.setTransposeSemitones(semitones, 8000.0f / static_cast<float>(sampleRate));
    } catch (...) {
        sampleRate_ = 0U;
        latencySamples_ = 0U;
        return false;
    }

    const auto expectedLatency = blockMilliseconds == 100U && intervalMilliseconds == 40U
        ? calculateLatencySamples(sampleRate)
        : calculateFxLatencySamples(sampleRate);
    if (latencySamples_ != expectedLatency) {
        sampleRate_ = 0U;
        latencySamples_ = 0U;
        return false;
    }
    prepared_ = true;
    return true;
}

bool NativePolyPitchProcessor::setSemitones(float semitones) noexcept {
    if (!prepared_ || !validSemitones(semitones)) return false;
    try {
        engine_.setTransposeSemitones(semitones, 8000.0f / static_cast<float>(sampleRate_));
    } catch (...) {
        return false;
    }
    targetSemitones_ = semitones;
    return true;
}

bool NativePolyPitchProcessor::setFormantSemitones(float semitones, bool compensatePitch) noexcept {
    if (!prepared_ || !validFormantSemitones(semitones)) return false;
    try {
        engine_.setFormantSemitones(semitones, compensatePitch);
    } catch (...) {
        return false;
    }
    targetFormantSemitones_ = semitones;
    formantCompensation_ = compensatePitch;
    return true;
}

bool NativePolyPitchProcessor::setFormantBaseHz(float frequencyHz) noexcept {
    if (!prepared_ || !std::isfinite(frequencyHz) || frequencyHz < 0.0f ||
        frequencyHz >= static_cast<float>(sampleRate_) * 0.5f) {
        return false;
    }
    try {
        engine_.setFormantBase(frequencyHz / static_cast<float>(sampleRate_));
    } catch (...) {
        return false;
    }
    formantBaseHz_ = frequencyHz;
    return true;
}

void NativePolyPitchProcessor::reset() noexcept {
    inputChannels_ = 0U;
    if (!prepared_) return;
    try {
        engine_.reset();
        engine_.setTransposeSemitones(targetSemitones_, 8000.0f / static_cast<float>(sampleRate_));
        engine_.setFormantSemitones(targetFormantSemitones_, formantCompensation_);
        engine_.setFormantBase(formantBaseHz_ / static_cast<float>(sampleRate_));
    } catch (...) {
        // The upstream engine's reset path is capacity-preserving after
        // presetCheaper(); retain safe fallback if that invariant ever breaks.
        prepared_ = false;
    }
}

bool NativePolyPitchProcessor::processInterleaved(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (!prepared_ || (frames > 0U && interleaved == nullptr) || channels == 0U || channels > kMaximumChannels) {
        return false;
    }
    if (frames == 0U) return true;
    if (inputChannels_ == 0U) inputChannels_ = channels;
    if (inputChannels_ != channels) return false;

    std::array<const float*, kEngineChannels> inputChannels{};
    std::array<float*, kEngineChannels> outputChannels{};
    inputChannels[0] = inputScratch_.data();
    inputChannels[1] = inputScratch_.data() + kMaximumProcessFrames;
    outputChannels[0] = outputScratch_.data();
    outputChannels[1] = outputScratch_.data() + kMaximumProcessFrames;

    unsigned int processedFrames = 0U;
    while (processedFrames < frames) {
        const auto chunkFrames = std::min(kMaximumProcessFrames, frames - processedFrames);
        for (unsigned int frame = 0U; frame < chunkFrames; ++frame) {
            const auto sourceOffset = static_cast<std::size_t>(processedFrames + frame) * channels;
            const float left = std::isfinite(interleaved[sourceOffset]) ? interleaved[sourceOffset] : 0.0f;
            inputScratch_[frame] = left;
            inputScratch_[kMaximumProcessFrames + frame] = channels > 1U
                ? (std::isfinite(interleaved[sourceOffset + 1U]) ? interleaved[sourceOffset + 1U] : 0.0f)
                : left;
        }

        try {
            engine_.process(inputChannels, static_cast<int>(chunkFrames), outputChannels, static_cast<int>(chunkFrames));
        } catch (...) {
            return false;
        }

        for (unsigned int frame = 0U; frame < chunkFrames; ++frame) {
            const auto destinationOffset = static_cast<std::size_t>(processedFrames + frame) * channels;
            interleaved[destinationOffset] = outputScratch_[frame];
            if (channels > 1U) interleaved[destinationOffset + 1U] = outputScratch_[kMaximumProcessFrames + frame];
        }
        processedFrames += chunkFrames;
    }
    return true;
}

} // namespace webrc::native
