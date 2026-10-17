#pragma once

#include "native_fx_catalog.hpp"
#include "native_osc_bot_core.hpp"

#include <string_view>

namespace webrc::native {

// Catalog adapter for the clean-room OSC BOT perceptual reconstruction. Each
// Input A-D or shared Track A-D slot owns an independent processor instance.
class NativeOscBotProcessor final : public NativeEffectProcessor {
public:
    explicit NativeOscBotProcessor(const NativeEffectDescriptor& descriptor) noexcept;

private:
    NativeOscBotCore core_{};

    [[nodiscard]] bool onPrepare() noexcept override;
    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value,
                                      std::uint64_t rampFrames) noexcept override;
    void onResetState() noexcept override;
    void processEffectFrame(float* frame, unsigned int channels) noexcept override;
    [[nodiscard]] bool processEffectBlock(float* interleaved, unsigned int frames,
                                          unsigned int channels) noexcept override;
};

} // namespace webrc::native
