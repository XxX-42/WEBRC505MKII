#include "native_osc_bot_processor.hpp"

namespace webrc::native {

NativeOscBotProcessor::NativeOscBotProcessor(const NativeEffectDescriptor& descriptor) noexcept
    : NativeEffectProcessor(descriptor) {
    NativeOscBotConfig config;
    config.bands = kNativeVocoderDefaultBands;
    config.waveform = NativeOscBotWaveform::Square;
    config.pattern = 0;
    config.toneCutoffHz = 3000.0f;
    config.tempoBpm = 120.0f;
    config.wetMix = 0.70f;
    config.enabled = true;
    (void)core_.setConfig(config);
}

bool NativeOscBotProcessor::onPrepare() noexcept {
    return core_.prepare(sampleRate());
}

bool NativeOscBotProcessor::onSetParameter(std::string_view parameterId, float value,
                                           std::uint64_t rampFrames) noexcept {
    return core_.setParameter(parameterId, value, rampFrames);
}

void NativeOscBotProcessor::onResetState() noexcept {
    core_.reset();
}

void NativeOscBotProcessor::processEffectFrame(float*, unsigned int) noexcept {
    // The sample-clocked filterbank/sequencer run through processEffectBlock().
}

bool NativeOscBotProcessor::processEffectBlock(float* interleaved, unsigned int frames,
                                               unsigned int channels) noexcept {
    return core_.processInPlace(interleaved, frames, channels);
}

} // namespace webrc::native
