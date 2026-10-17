#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Clean-room implementation for Native catalog FX #37 PANNING DELAY. Its
// provisional control ranges/defaults come from the supplied catalog
// descriptor; the cross-feedback topology and panning law are authored
// behavior, not a claim about Roland's implementation.
struct NativePanningDelayProcessorConfig {
    float timeMs = 500.0f;
    float feedbackPercent = 30.0f;
    float panPercent = 70.0f;
    float mixPercent = 25.0f;
};

// Two bounded stereo delay lines with fractional Lagrange reads. Delayed L/R
// are cross-fed through a contractive matrix. A mono image of each repeat is
// placed by an equal-power pan law. Buffers are allocated only by prepare();
// processInPlace() accepts variable block sizes and does not allocate, lock,
// log, or perform I/O. Control changes and processing share one DSP-owner
// thread, like the other Native effects.
class NativePanningDelayProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(
        const NativePanningDelayProcessorConfig& config,
        std::uint64_t rampFrames = 64U
    ) noexcept;
    void reset() noexcept;

    // Processes mono or stereo in place; channels beyond the first two pass
    // through (non-finite extras are replaced with zero). Returns peak output.
    [[nodiscard]] float processInPlace(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] std::size_t delayCapacityFrames() const noexcept { return delayLines_[0].size(); }
    [[nodiscard]] const NativePanningDelayProcessorConfig& config() const noexcept { return config_; }

private:
    static constexpr std::size_t kLineCount = 2U;
    static constexpr float kMinimumTimeMs = 1.0f;
    static constexpr float kMaximumTimeMs = 2000.0f;
    static constexpr float kMaximumFeedbackPercent = 95.0f;
    static constexpr float kMinimumPanPercent = -100.0f;
    static constexpr float kMaximumPanPercent = 100.0f;
    static constexpr float kMaximumMixPercent = 100.0f;
    static constexpr float kMaximumStateMagnitude = 8.0f;

    std::array<std::vector<float>, kLineCount> delayLines_{};
    std::array<std::size_t, kLineCount> writeIndices_{};
    dsp::ParameterSmoother timeMs_{500.0f};
    dsp::ParameterSmoother feedbackPercent_{30.0f};
    dsp::ParameterSmoother panPercent_{70.0f};
    dsp::ParameterSmoother mixPercent_{25.0f};
    NativePanningDelayProcessorConfig config_{};
    unsigned int sampleRate_ = 0U;

    [[nodiscard]] float readFractionalDelay(
        const std::vector<float>& line,
        std::size_t writeIndex,
        double delayFrames
    ) const noexcept;
};

} // namespace webrc::native
