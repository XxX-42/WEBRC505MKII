#include "native_osc_voc_processor.hpp"

namespace webrc::native {

NativeOscVocProcessor::NativeOscVocProcessor(const NativeEffectDescriptor& descriptor) noexcept
    : NativeEffectProcessor(descriptor) {
    NativeOscVocConfig config;
    // The Native catalog's balanced choice is the full 24-band filterbank.
    config.bands = kNativeVocoderMaxBands;
    config.pulseWidth = 0.25f;
    config.wetMix = 0.70f;
    config.enabled = true;
    (void)core_.setConfig(config);
}

bool NativeOscVocProcessor::onPrepare() noexcept {
    // Keep any values configured before engine start. prepare() uses the
    // retained config and allocates filterbank memory off the callback thread.
    return core_.prepare(sampleRate());
}

bool NativeOscVocProcessor::onSetParameter(std::string_view parameterId, float value,
                                           std::uint64_t rampFrames) noexcept {
    if (parameterId == "midi-channel") {
        if (value < 1.0f || value > 16.0f) return false;
        return core_.setParameter("channel", value - 1.0f, rampFrames);
    }
    if (parameterId == "mix") {
        return core_.setParameter("mix", value, rampFrames);
    }
    return core_.setParameter(parameterId, value, rampFrames);
}

void NativeOscVocProcessor::onResetState() noexcept {
    core_.reset();
}

void NativeOscVocProcessor::processEffectFrame(float*, unsigned int) noexcept {
    // The filterbank and event scheduler run through processEffectBlock().
}

bool NativeOscVocProcessor::processEffectBlock(float* interleaved, unsigned int frames,
                                               unsigned int channels) noexcept {
    return core_.processInPlace(interleaved, frames, channels);
}

} // namespace webrc::native
