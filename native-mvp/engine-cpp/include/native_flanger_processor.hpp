#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Clean-room reconstruction of the Browser FLANGER controls. `delayMs` is
// the center/base delay (0.2..10 ms), `depth` is normalized (0..1, up to
// +/-5 ms around the base delay), `rateHz` is the sine-LFO rate, `feedback`
// is signed, and `wetMix` is normalized (0 = dry, 1 = wet). The final delay
// excursion is clamped to 0.2..10 ms and to a causal, interpolation-safe
// sample range at the prepared sample rate.
struct NativeFlangerProcessorConfig {
    bool enabled = false;
    float delayMs = 3.0f;
    float rateHz = 0.3f;
    float depth = 0.6f;
    float feedback = 0.25f;
    float wetMix = 0.5f;
};

// Standalone stereo flanger DSP. Delay storage is allocated only by
// prepare(); processInPlace() supports arbitrary block sizes, is chunk
// invariant, and does not allocate, lock, perform I/O, or log. Apply control
// changes on the same DSP-owner thread that calls processInPlace().
class NativeFlangerProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeFlangerProcessorConfig& config, std::uint64_t rampFrames = 64U) noexcept;
    void reset() noexcept;
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool enabled() const noexcept { return config_.enabled; }
    [[nodiscard]] float delayMs() const noexcept { return config_.delayMs; }
    [[nodiscard]] float rateHz() const noexcept { return config_.rateHz; }
    [[nodiscard]] float depth() const noexcept { return config_.depth; }
    [[nodiscard]] float feedback() const noexcept { return config_.feedback; }
    [[nodiscard]] float wetMix() const noexcept { return config_.wetMix; }

private:
    static constexpr std::size_t kChannels = 2U;
    static constexpr float kMinimumDelayMs = 0.2f;
    static constexpr float kMaximumDelayMs = 10.0f;
    static constexpr float kMaximumDepthMs = 5.0f;
    static constexpr float kFeedbackLimit = 0.95f;
    static constexpr float kFeedbackStateLimit = 4.0f;

    std::array<std::vector<float>, kChannels> delayBuffers_{};
    std::array<std::size_t, kChannels> writeIndices_{};
    std::array<float, kChannels> feedbackStates_{};
    dsp::ParameterSmoother delayMs_{3.0f};
    dsp::ParameterSmoother rateHz_{0.3f};
    dsp::ParameterSmoother depth_{0.6f};
    dsp::ParameterSmoother feedback_{0.25f};
    dsp::ParameterSmoother wetMix_{0.0f};
    NativeFlangerProcessorConfig config_{};
    unsigned int sampleRate_ = 0U;
    std::size_t maximumDelayFrames_ = 0U;
    double feedbackDampingAlpha_ = 0.0;
    double leftPhase_ = 0.0;
    double rightPhase_ = 3.14159265358979323846;

    [[nodiscard]] float readFractionalDelay(
        const std::vector<float>& buffer,
        std::size_t writeIndex,
        double delayFrames
    ) const noexcept;
};

} // namespace webrc::native
