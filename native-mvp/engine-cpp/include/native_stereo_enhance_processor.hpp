#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstdint>

namespace webrc::native {

// Clean-room mid/side width processor with frequency-selective side reduction
// and two stable all-pass sections for decorrelation. It preserves the input
// channel count and has no fixed algorithmic delay.
struct NativeStereoEnhanceConfig {
    float widthPercent = 100.0f;
    float lowMonoCutoffHz = 120.0f;
    float decorrelationPercent = 25.0f;
    float wetMixPercent = 100.0f;
};

class NativeStereoEnhanceProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeStereoEnhanceConfig& config, std::uint64_t rampFrames = 64U) noexcept;
    void reset() noexcept;

    // Processes at most stereo in-place. Mono and channels beyond stereo are
    // kept at their original channel count; no memory is allocated here.
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] const NativeStereoEnhanceConfig& config() const noexcept { return config_; }

private:
    static constexpr std::uint64_t kCoefficientUpdateInterval = 16U;

    [[nodiscard]] float allpassCoefficient(float frequencyHz) const noexcept;
    void updateLowMonoCoefficient(float cutoffHz) noexcept;

    NativeStereoEnhanceConfig config_{};
    dsp::ParameterSmoother width_{1.0f};
    dsp::ParameterSmoother lowMonoCutoffHz_{120.0f};
    dsp::ParameterSmoother decorrelation_{0.25f};
    dsp::ParameterSmoother wetMix_{1.0f};
    unsigned int sampleRate_ = 0U;
    std::uint64_t processedFrames_ = 0U;
    float lowMonoAlpha_ = 0.0f;
    float allpass1Coefficient_ = 0.0f;
    float allpass2Coefficient_ = 0.0f;
    float lowSideState_ = 0.0f;
    std::array<float, 2U> allpassInput_{};
    std::array<float, 2U> allpassOutput_{};
};

} // namespace webrc::native
