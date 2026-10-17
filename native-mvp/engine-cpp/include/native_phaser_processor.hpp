#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::native {

struct PhaserProcessorConfig {
    bool enabled = false;
    unsigned int stages = 8U;
    float rateHz = 0.5f;
    float depth = 0.65f;
    float feedback = 0.0f;
    float wetMix = 0.5f;
};

// Clean-room phaser built from cascaded first-order all-pass sections. It has
// fixed storage and a sample-smoothed LFO, and is intended to be configured on
// the audio-owner thread after the Native command queue is consumed.
class NativePhaserProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const PhaserProcessorConfig& config, std::uint64_t rampFrames = 64U) noexcept;
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool enabled() const noexcept { return config_.enabled; }
    [[nodiscard]] unsigned int stages() const noexcept { return config_.stages; }
    [[nodiscard]] float rateHz() const noexcept { return config_.rateHz; }
    [[nodiscard]] float depth() const noexcept { return config_.depth; }
    [[nodiscard]] float feedback() const noexcept { return config_.feedback; }
    [[nodiscard]] float wetMix() const noexcept { return config_.wetMix; }

private:
    static constexpr std::size_t kChannels = 2U;
    static constexpr std::size_t kMaximumStages = 12U;
    static constexpr std::size_t kStageGroupSize = 4U;

    struct AllpassState {
        float previousInput = 0.0f;
        float previousOutput = 0.0f;
    };

    std::array<std::array<AllpassState, kMaximumStages>, kChannels> allpassStates_{};
    std::array<float, kChannels> feedbackState_{};
    dsp::ParameterSmoother rateHz_{0.5f};
    dsp::ParameterSmoother depth_{0.65f};
    dsp::ParameterSmoother feedback_{0.0f};
    dsp::ParameterSmoother wetMix_{0.0f};
    dsp::ParameterSmoother stageCount_{8.0f};
    PhaserProcessorConfig config_{};
    unsigned int sampleRate_ = 0U;
    double phase_ = 0.0;

    [[nodiscard]] float processAllpass(float input, float coefficient, AllpassState& state) noexcept;
    [[nodiscard]] float coefficientForSweep(float normalizedSweep) const noexcept;
};

} // namespace webrc::native
