#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Host routing (including the shared A-D output bank) is deliberately kept
// outside this reusable signal processor.
struct ChorusProcessorConfig {
    bool enabled = false;
    float rateHz = 0.8f;
    float depthMs = 5.0f;
    float feedback = 0.0f;
    float wetMix = 0.25f;
    bool officialControls = false;
};

// Clean-room stereo chorus using a quadrature sine LFO and cubic Lagrange
// interpolation. Delay storage is allocated only by prepare(); processing is
// in-place and does not allocate, lock, perform I/O, or log.
class NativeChorusProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    // Mutate this object only on its DSP-owner thread. The Native engine
    // hands UI/bridge values across its bounded SPSC queue before this call.
    [[nodiscard]] bool setConfig(const ChorusProcessorConfig& config, std::uint64_t rampFrames = 64U) noexcept;
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool enabled() const noexcept { return config_.enabled; }
    [[nodiscard]] float rateHz() const noexcept { return config_.rateHz; }
    [[nodiscard]] float depthMs() const noexcept { return config_.depthMs; }
    [[nodiscard]] float feedback() const noexcept { return config_.feedback; }
    [[nodiscard]] float wetMix() const noexcept { return config_.wetMix; }

private:
    static constexpr std::size_t kChannels = 2U;
    static constexpr float kCenterDelayMs = 30.0f;
    static constexpr float kMaximumDepthMs = 25.0f;

    std::array<std::vector<float>, kChannels> delayBuffers_{};
    std::array<std::size_t, kChannels> writeIndices_{};
    dsp::ParameterSmoother rateHz_{0.8f};
    dsp::ParameterSmoother depthMs_{5.0f};
    dsp::ParameterSmoother feedback_{0.0f};
    dsp::ParameterSmoother wetMix_{0.0f};
    ChorusProcessorConfig config_{};
    unsigned int sampleRate_ = 0U;
    std::size_t maximumDelayFrames_ = 0U;
    double leftPhase_ = 0.0;
    double rightPhase_ = 1.57079632679489661923;

    [[nodiscard]] float readFractionalDelay(
        const std::vector<float>& buffer,
        std::size_t writeIndex,
        double delayFrames
    ) const noexcept;
};

} // namespace webrc::native
