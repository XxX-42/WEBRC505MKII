#include "native_hrm_auto_processor.hpp"

#include <cmath>

namespace webrc::native {

NativeHrmAutoProcessor::NativeHrmAutoProcessor(const NativeEffectDescriptor& descriptor) noexcept
    : NativeEffectProcessor(descriptor) {
    config_.mixPercent = 100.0f;
}

bool NativeHrmAutoProcessor::onPrepare() noexcept {
    config_.sampleRate = sampleRate();
    config_.channels = 2U;
    config_.mixPercent = 100.0f;
    return core_.prepare(config_);
}

bool NativeHrmAutoProcessor::onSetParameter(std::string_view parameterId, float value,
                                            std::uint64_t rampFrames) noexcept {
    (void)rampFrames;
    if (parameterId == "mix_percent") return true; // handled by NativeEffectProcessor

    NativeHrmAutoCore::Config next = config_;
    if (parameterId == "key") {
        if (value < 0.0f || value > 11.0f) return false;
        next.key = static_cast<std::uint8_t>(value);
    } else if (parameterId == "scale") {
        if (value < 0.0f || value > 4.0f) return false;
        next.scale = static_cast<NativeHrmAutoCore::Scale>(static_cast<std::uint8_t>(value));
    } else if (parameterId == "midi-channel") {
        if (value < 1.0f || value > 16.0f) return false;
        next.midiChannel = static_cast<std::uint8_t>(value);
    } else {
        return false;
    }

    if (sampleRate() != 0U) {
        next.sampleRate = sampleRate();
        next.channels = 2U;
        next.mixPercent = 100.0f;
        if (!core_.configure(next)) return false;
    }
    config_ = next;
    return true;
}

bool NativeHrmAutoProcessor::queueMidiEvent(bool noteOn, int channelOneBased, int note,
                                             int velocity, std::uint64_t absoluteFrame) noexcept {
    if (channelOneBased < 1 || channelOneBased > 16 || note < 0 || note > 127 ||
        velocity < 0 || velocity > 127) {
        recordRejectedEvent();
        return false;
    }
    NativeHrmAutoCore::MidiEvent event{};
    event.frame = absoluteFrame;
    event.status = static_cast<std::uint8_t>((noteOn ? 0x90U : 0x80U) |
                                             static_cast<unsigned int>(channelOneBased - 1));
    event.data1 = static_cast<std::uint8_t>(note);
    event.data2 = static_cast<std::uint8_t>(velocity);
    return core_.enqueueMidi(event);
}

void NativeHrmAutoProcessor::onResetState() noexcept {
    core_.reset();
}

void NativeHrmAutoProcessor::processEffectFrame(float*, unsigned int) noexcept {
    // The MIDI event scheduler, tracker and Signalsmith voices run in blocks.
}

bool NativeHrmAutoProcessor::processEffectBlock(float* interleaved, unsigned int frames,
                                                 unsigned int channels) noexcept {
    if (interleaved == nullptr || frames > kAdapterMaxFrames || channels == 0U || channels > 2U) {
        return false;
    }
    if (channels == 2U) return core_.processInterleaved(interleaved, frames, 2U);

    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = interleaved[frame];
        monoScratch_[static_cast<std::size_t>(frame) * 2U] = sample;
        monoScratch_[static_cast<std::size_t>(frame) * 2U + 1U] = sample;
    }
    if (!core_.processInterleaved(monoScratch_.data(), frames, 2U)) return false;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        interleaved[frame] = monoScratch_[static_cast<std::size_t>(frame) * 2U];
    }
    return true;
}

} // namespace webrc::native
