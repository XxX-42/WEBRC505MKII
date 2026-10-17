#include "native_autopan_processor.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native {

bool NativeAutoPanProcessor::validWaveform(NativeAutoPanWaveform waveform) noexcept {
    return waveform == NativeAutoPanWaveform::Sine ||
        waveform == NativeAutoPanWaveform::Triangle ||
        waveform == NativeAutoPanWaveform::Square;
}

float NativeAutoPanProcessor::polyBlep(double phase, double phaseStep) noexcept {
    if (!(phaseStep > 0.0) || phaseStep >= 0.5) {
        return 0.0f;
    }
    if (phase < phaseStep) {
        const double position = phase / phaseStep;
        return static_cast<float>((position + position) - (position * position) - 1.0);
    }
    if (phase > 1.0 - phaseStep) {
        const double position = (phase - 1.0) / phaseStep;
        return static_cast<float>((position * position) + (position + position) + 1.0);
    }
    return 0.0f;
}

float NativeAutoPanProcessor::lfoValue(
    NativeAutoPanWaveform waveform,
    double phase,
    double phaseStep
) noexcept {
    switch (waveform) {
    case NativeAutoPanWaveform::Sine:
        return static_cast<float>(std::sin(kTwoPi * phase));
    case NativeAutoPanWaveform::Triangle:
        return static_cast<float>(1.0 - (4.0 * std::fabs(phase - 0.5)));
    case NativeAutoPanWaveform::Square: {
        float square = phase < 0.5 ? 1.0f : -1.0f;
        square += polyBlep(phase, phaseStep);
        const double fallingEdgePhase = phase < 0.5 ? phase + 0.5 : phase - 0.5;
        square -= polyBlep(fallingEdgePhase, phaseStep);
        return std::clamp(square, -1.0f, 1.0f);
    }
    }
    return 0.0f;
}

bool NativeAutoPanProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) {
        sampleRate_ = 0U;
        return false;
    }
    sampleRate_ = sampleRate;
    phase_ = 0.0;
    waveformOld_ = config_.waveform;
    waveformTarget_ = config_.waveform;
    rateHz_.reset(config_.rateHz);
    depth_.reset(config_.depth);
    wetMix_.reset(config_.enabled ? config_.wetMix : 0.0f);
    waveformBlend_.reset(1.0f);
    return true;
}

bool NativeAutoPanProcessor::setConfig(const NativeAutoPanConfig& config, std::uint64_t rampFrames) noexcept {
    const bool validSlot = config.slot == NativeTrackOutputSlot::A ||
        config.slot == NativeTrackOutputSlot::B ||
        config.slot == NativeTrackOutputSlot::C ||
        config.slot == NativeTrackOutputSlot::D;
    if (!validSlot || config.algorithm != NativeAutoPanAlgorithm::EqualPowerMidSideLfo ||
        !validWaveform(config.waveform) || !std::isfinite(config.rateHz) ||
        !std::isfinite(config.depth) || !std::isfinite(config.wetMix) ||
        config.rateHz < 0.05f || config.rateHz > 20.0f ||
        config.depth < 0.0f || config.depth > 1.0f ||
        config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    if (waveformTarget_ != config.waveform) {
        waveformOld_ = waveformTarget_;
        waveformTarget_ = config.waveform;
        waveformBlend_.reset(rampFrames == 0U ? 1.0f : 0.0f);
        waveformBlend_.setTarget(1.0f, rampFrames);
    }
    config_ = config;
    rateHz_.setTarget(config.rateHz, rampFrames);
    depth_.setTarget(config.depth, rampFrames);
    wetMix_.setTarget(config.enabled ? config.wetMix : 0.0f, rampFrames);
    return true;
}

NativeAutoPanProcessor::FrameState NativeAutoPanProcessor::nextFrameState() noexcept {
    const float rate = rateHz_.next();
    const float depth = depth_.next();
    const float mix = wetMix_.next();
    const float waveformBlend = waveformBlend_.next();
    const double phaseStep = static_cast<double>(rate) / static_cast<double>(sampleRate_);
    const float oldLfo = lfoValue(waveformOld_, phase_, phaseStep);
    const float targetLfo = lfoValue(waveformTarget_, phase_, phaseStep);
    const float lfo = oldLfo + (targetLfo - oldLfo) * waveformBlend;
    const float pan = std::clamp(depth * lfo, -1.0f, 1.0f);
    constexpr double kQuarterPi = 0.78539816339744830962;
    const double angle = (static_cast<double>(pan) + 1.0) * kQuarterPi;
    const auto mixGains = dsp::equalPowerCrossfadeGains(mix);

    FrameState state;
    state.leftGain = static_cast<float>(std::cos(angle));
    state.rightGain = static_cast<float>(std::sin(angle));
    state.sideGain = 1.0f - depth * std::fabs(lfo);
    state.dryGain = mixGains.first;
    state.wetGain = mixGains.second;
    advancePhase(rate);
    return state;
}

void NativeAutoPanProcessor::advancePhase(float rateHz) noexcept {
    phase_ += static_cast<double>(rateHz) / static_cast<double>(sampleRate_);
    if (phase_ >= 1.0) {
        phase_ -= std::floor(phase_);
    }
}

float NativeAutoPanProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U) {
        return 0.0f;
    }

    float peak = 0.0f;
    const bool canProcess = channels >= 2U && sampleRate_ != 0U;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const auto offset = static_cast<std::size_t>(frame) * channels;
        if (canProcess) {
            const float inputLeft = interleaved[offset];
            const float inputRight = interleaved[offset + 1U];
            const auto state = nextFrameState();
            const float mid = 0.5f * (inputLeft + inputRight);
            const float side = 0.5f * (inputLeft - inputRight);
            const float wetLeft = mid * state.leftGain * kSqrtTwo + side * state.sideGain;
            const float wetRight = mid * state.rightGain * kSqrtTwo - side * state.sideGain;
            interleaved[offset] = inputLeft * state.dryGain + wetLeft * state.wetGain;
            interleaved[offset + 1U] = inputRight * state.dryGain + wetRight * state.wetGain;
        }

        for (unsigned int channel = 0U; channel < channels; ++channel) {
            peak = std::max(peak, std::fabs(interleaved[offset + channel]));
        }
    }
    return peak;
}

float NativeAutoPanProcessor::processMonoToStereo(
    const float* monoInput,
    float* stereoOutput,
    unsigned int frames
) noexcept {
    if (monoInput == nullptr || stereoOutput == nullptr || frames == 0U) {
        return 0.0f;
    }

    float peak = 0.0f;
    const bool canProcess = sampleRate_ != 0U;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float input = monoInput[frame];
        float outputLeft = input;
        float outputRight = input;
        if (canProcess) {
            const auto state = nextFrameState();
            const float wetLeft = input * state.leftGain;
            const float wetRight = input * state.rightGain;
            outputLeft = input * state.dryGain + wetLeft * state.wetGain;
            outputRight = input * state.dryGain + wetRight * state.wetGain;
        }
        stereoOutput[static_cast<std::size_t>(frame) * 2U] = outputLeft;
        stereoOutput[(static_cast<std::size_t>(frame) * 2U) + 1U] = outputRight;
        peak = std::max(peak, std::max(std::fabs(outputLeft), std::fabs(outputRight)));
    }
    return peak;
}

} // namespace webrc::native
