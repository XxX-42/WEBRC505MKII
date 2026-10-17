#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Clean-room, provisional controls for the Native MOD DELAY processor. The
// right-channel oscillator is fixed at a quarter-cycle offset to match Browser.
struct NativeModDelayProcessorConfig {
    bool enabled = false;
    float rateHz = 0.3f;
    float depthMs = 10.0f;
    float delayMs = 500.0f;
    float feedback = 0.25f;
    float wetMix = 0.25f;
};

// Fixed-capacity-after-prepare stereo modulated fractional delay. Memory is
// allocated on prepare(), never by processInPlace(). The write path is
// bounded and contractive for the configured feedback range; processing is
// chunk-invariant and performs no allocation, locking, I/O, or logging.
class NativeModDelayProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(
        const NativeModDelayProcessorConfig& config,
        std::uint64_t rampFrames = 64U
    ) noexcept;
    void reset() noexcept;
    [[nodiscard]] float processInPlace(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] const NativeModDelayProcessorConfig& config() const noexcept { return config_; }
    [[nodiscard]] std::size_t delayCapacityFrames() const noexcept { return delayBuffers_[0].size(); }

private:
    static constexpr std::size_t kChannels = 2U;
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr float kMinimumDelayMs = 10.0f;
    static constexpr float kMaximumDelayMs = 2000.0f;
    static constexpr float kMaximumDepthMs = 50.0f;
    static constexpr float kMaximumRateHz = 10.0f;
    static constexpr float kMaximumFeedback = 0.95f;
    static constexpr float kMaximumStateMagnitude = 8.0f;

    std::array<std::vector<float>, kChannels> delayBuffers_{};
    std::array<std::size_t, kChannels> writeIndices_{};
    std::array<float, kChannels> feedbackFilterState_{};
    dsp::ParameterSmoother rateHz_{0.3f};
    dsp::ParameterSmoother depthMs_{10.0f};
    dsp::ParameterSmoother delayMs_{500.0f};
    dsp::ParameterSmoother feedback_{0.25f};
    dsp::ParameterSmoother wetMix_{0.0f};
    NativeModDelayProcessorConfig config_{};
    unsigned int sampleRate_ = 0U;
    std::size_t maximumDelayFrames_ = 0U;
    float feedbackToneAlpha_ = 0.0f;
    double leftPhase_ = 0.0;

    [[nodiscard]] float readFractionalDelay(
        const std::vector<float>& buffer,
        std::size_t writeIndex,
        double delayFrames
    ) const noexcept;
};

} // namespace webrc::native
