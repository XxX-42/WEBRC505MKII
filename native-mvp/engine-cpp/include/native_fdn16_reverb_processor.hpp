#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

struct NativeFdn16ReverbConfig {
    bool enabled = false;
    float wetMix = 0.25f;
    float rt60Seconds = 2.0f;
    float dampingCutoffHz = 7000.0f;
};

// Clean-room stereo reverberator based on a 16-line feedback delay network.
// The feedback matrix is the normalized order-16 Hadamard matrix. Delay-line
// storage is allocated by prepare(); processing has no locks, I/O, or dynamic
// allocation. Controls must be applied on the DSP-owner thread.
class NativeFdn16ReverbProcessor final {
public:
    static constexpr std::size_t kLineCount = 16U;
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;

    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] static unsigned int minimumDelayFramesForSampleRate(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeFdn16ReverbConfig& config, std::uint64_t rampFrames = 64U) noexcept;
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;
    void resetState() noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool enabled() const noexcept { return config_.enabled; }
    [[nodiscard]] float wetMix() const noexcept { return config_.wetMix; }
    [[nodiscard]] float rt60Seconds() const noexcept { return config_.rt60Seconds; }
    [[nodiscard]] float dampingCutoffHz() const noexcept { return config_.dampingCutoffHz; }
    [[nodiscard]] unsigned int lineDelayFrames(std::size_t line) const noexcept {
        return line < kLineCount ? delayFrames_[line] : 0U;
    }

private:
    static constexpr std::uint64_t kControlUpdateInterval = 16U;

    std::array<std::vector<float>, kLineCount> delayLines_{};
    std::array<unsigned int, kLineCount> delayFrames_{};
    std::array<std::size_t, kLineCount> writeIndices_{};
    std::array<float, kLineCount> dampingState_{};
    std::array<float, kLineCount> feedbackGains_{};
    dsp::ParameterSmoother wetMix_{0.0f};
    dsp::ParameterSmoother rt60Seconds_{2.0f};
    dsp::ParameterSmoother dampingCutoffHz_{7000.0f};
    NativeFdn16ReverbConfig config_{};
    unsigned int sampleRate_ = 0U;
    float dampingAlpha_ = 0.0f;
    std::uint64_t processedFrames_ = 0U;

    void updateFeedbackAndDamping(float rt60Seconds, float dampingCutoffHz) noexcept;
    static void hadamardTransform(std::array<float, kLineCount>& values) noexcept;
};

} // namespace webrc::native
