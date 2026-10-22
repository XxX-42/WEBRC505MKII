#pragma once

#include "native_fx_catalog.hpp"
#include "native_hrm_auto_core.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace webrc::native {

// Native catalog adapter for HRM AUTO (M). It preserves absolute sample-frame
// event routing and leaves latency-aligned dry/wet blending to the base class.
class NativeHrmAutoProcessor final : public NativeEffectProcessor {
public:
    static constexpr std::size_t kMidiQueueCapacity = NativeHrmAutoCore::kMidiQueueCapacity;

    explicit NativeHrmAutoProcessor(const NativeEffectDescriptor& descriptor) noexcept;

    [[nodiscard]] bool queueMidiEvent(bool noteOn, int channelOneBased, int note,
                                      int velocity, std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] std::uint64_t currentFrame() const noexcept { return core_.currentFrame(); }
    [[nodiscard]] bool synchronizeFrame(std::uint64_t absoluteFrame) noexcept {
        return core_.synchronizeFrame(absoluteFrame);
    }
    [[nodiscard]] static constexpr std::size_t eventQueueCapacity() noexcept { return kMidiQueueCapacity; }
    [[nodiscard]] std::size_t queuedEventCount() const noexcept { return core_.queueDepth(); }
    [[nodiscard]] std::uint64_t overflowEventCount() const noexcept { return core_.overflowCount(); }
    [[nodiscard]] std::uint64_t lateEventCount() const noexcept { return core_.lateEventCount(); }
    [[nodiscard]] std::uint64_t rejectedEventCount() const noexcept { return core_.rejectedEventCount(); }
    void recordLateEvent() noexcept { core_.recordLateExternalSubmission(); }
    void recordRejectedEvent() noexcept { core_.recordRejectedExternalSubmission(); }

private:
    static constexpr unsigned int kAdapterMaxFrames = NativeHrmAutoCore::kMaximumProcessFrames;
    NativeHrmAutoCore core_{};
    NativeHrmAutoCore::Config config_{};
    std::array<float, static_cast<std::size_t>(kAdapterMaxFrames) * 2U> monoScratch_{};

    [[nodiscard]] bool onPrepare() noexcept override;
    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value,
                                      std::uint64_t rampFrames) noexcept override;
    void onResetState() noexcept override;
    void processEffectFrame(float* frame, unsigned int channels) noexcept override;
    [[nodiscard]] bool processEffectBlock(float* interleaved, unsigned int frames,
                                          unsigned int channels) noexcept override;
    [[nodiscard]] unsigned int algorithmicLatencySamples() const noexcept override {
        return core_.latencyFrames();
    }
    [[nodiscard]] bool usesBaseWetMix() const noexcept override { return !core_.officialControlsActive(); }
};

} // namespace webrc::native
