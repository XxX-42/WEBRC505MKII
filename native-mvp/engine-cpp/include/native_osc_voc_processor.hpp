#pragma once

#include "native_fx_catalog.hpp"
#include "native_osc_voc_core.hpp"

#include <cstdint>
#include <string_view>

namespace webrc::native {

// Native catalog adapter for OSC VOC (M). Each selected catalog slot owns a
// separate processor/core, so MIDI events can only affect the requested
// Input A-D or shared post-mix Track A-D slot.
class NativeOscVocProcessor final : public NativeEffectProcessor {
public:
    explicit NativeOscVocProcessor(const NativeEffectDescriptor& descriptor) noexcept;

    [[nodiscard]] bool queueNoteOn(int zeroBasedChannel, int note, int velocity,
                                   std::uint64_t absoluteFrame) noexcept {
        return core_.queueNoteOn(zeroBasedChannel, note, velocity, absoluteFrame);
    }
    [[nodiscard]] bool queueNoteOff(int zeroBasedChannel, int note,
                                    std::uint64_t absoluteFrame) noexcept {
        return core_.queueNoteOff(zeroBasedChannel, note, absoluteFrame);
    }
    [[nodiscard]] std::uint64_t currentFrame() const noexcept { return core_.currentFrame(); }
    [[nodiscard]] bool synchronizeFrame(std::uint64_t absoluteFrame) noexcept {
        return core_.synchronizeFrame(absoluteFrame);
    }
    [[nodiscard]] std::size_t queuedEventCount() const noexcept { return core_.queuedEventCount(); }
    [[nodiscard]] std::uint64_t overflowEventCount() const noexcept { return core_.overflowEventCount(); }
    [[nodiscard]] std::uint64_t lateEventCount() const noexcept { return core_.lateEventCount(); }
    [[nodiscard]] std::uint64_t rejectedEventCount() const noexcept { return core_.rejectedEventCount(); }
    void recordLateEvent() noexcept { core_.recordLateEvent(); }
    void recordRejectedEvent() noexcept { core_.recordRejectedEvent(); }

private:
    NativeOscVocCore core_{};

    [[nodiscard]] bool onPrepare() noexcept override;
    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value,
                                      std::uint64_t rampFrames) noexcept override;
    void onResetState() noexcept override;
    void processEffectFrame(float* frame, unsigned int channels) noexcept override;
    [[nodiscard]] bool processEffectBlock(float* interleaved, unsigned int frames,
                                          unsigned int channels) noexcept override;
};

} // namespace webrc::native
