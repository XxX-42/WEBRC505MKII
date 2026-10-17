#pragma once

#include "dsp_primitives.hpp"
#include "native_distortion_processor.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Clean-room control model for Browser matrix FX #40 (TAPE ECHO). The
// descriptor's provisional ranges are retained: time 20..2000 ms, feedback
// 0..95%, wow/flutter 0..100%, saturation 0..100%, tone 500..16000 Hz, and
// wet mix 0..100%. This is a functional approximation, not Roland fidelity.
struct NativeTapeEchoProcessorConfig {
    bool enabled = false;
    float timeMs = 350.0f;
    float feedbackPercent = 35.0f;
    float wowFlutterPercent = 15.0f;
    float saturationPercent = 25.0f;
    float toneHz = 6000.0f;
    float mixPercent = 30.0f;
};

// Standalone stereo tape-echo approximation. Three fractional playback heads
// read the same feedback tape buffer at 1x, 2x and 3x the configured delay;
// their normalized output weights are 0.55/0.30/0.15. A slow wow oscillator
// plus a faster flutter oscillator modulate each head proportionally to its
// delay. Feedback passes through a one-pole tone-loss filter and the native
// 4x oversampled saturation stage. The record path therefore has 24 samples of
// fixed saturation-stage latency, in addition to each intentional head delay.
//
// Delay buffers are allocated only in prepare(). At the maximum supported
// rate (192 kHz), storage is bounded to about 8.8 MiB for both channels and
// holds the longest (3x) head including full wow excursion. processInPlace()
// is chunk-invariant and performs no allocations, locks, logging, or I/O.
// Call prepare(), setConfig(), reset(), and processInPlace() on one DSP-owner
// thread; setConfig() may be used at block boundaries and ramps changes.
class NativeTapeEchoProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(
        const NativeTapeEchoProcessorConfig& config,
        std::uint64_t rampFrames = 64U
    ) noexcept;
    void reset() noexcept;

    // Processes the first one or two channels of interleaved audio. Additional
    // channels pass through unchanged (non-finite extras are replaced by zero).
    // Returns the peak absolute output level among all finite output channels.
    [[nodiscard]] float processInPlace(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] unsigned int recordPathLatencyFrames() const noexcept {
        return kRecordPathLatencyFrames;
    }
    [[nodiscard]] std::size_t delayCapacityFrames() const noexcept {
        return delayBuffers_[0].size();
    }
    [[nodiscard]] const NativeTapeEchoProcessorConfig& config() const noexcept { return config_; }

private:
    static constexpr std::size_t kChannels = 2U;
    static constexpr std::size_t kHeadCount = 3U;
    static constexpr unsigned int kRecordPathLatencyFrames = 24U;
    static constexpr float kMinimumTimeMs = 20.0f;
    static constexpr float kMaximumTimeMs = 2000.0f;
    static constexpr float kMaximumFeedbackPercent = 95.0f;
    static constexpr float kMaximumWowFlutterPercent = 100.0f;
    static constexpr float kMaximumSaturationPercent = 100.0f;
    static constexpr float kMinimumToneHz = 500.0f;
    static constexpr float kMaximumToneHz = 16000.0f;
    static constexpr float kMaximumMixPercent = 100.0f;
    static constexpr float kMaximumWowFraction = 0.004f;
    static constexpr float kMaximumStateMagnitude = 8.0f;

    std::array<std::vector<float>, kChannels> delayBuffers_{};
    std::array<std::size_t, kChannels> writeIndices_{};
    std::array<float, kChannels> feedbackToneStates_{};
    std::array<double, kChannels> wowPhases_{};
    std::array<double, kChannels> flutterPhases_{};
    dsp::ParameterSmoother timeMs_{350.0f};
    dsp::ParameterSmoother feedbackPercent_{35.0f};
    dsp::ParameterSmoother wowFlutterPercent_{15.0f};
    dsp::ParameterSmoother saturationPercent_{25.0f};
    dsp::ParameterSmoother toneAlpha_{0.5f};
    dsp::ParameterSmoother mixPercent_{0.0f};
    NativeDistortionProcessor saturation_{};
    NativeTapeEchoProcessorConfig config_{};
    unsigned int sampleRate_ = 0U;

    [[nodiscard]] static float coefficientForTone(float toneHz, unsigned int sampleRate) noexcept;
    [[nodiscard]] float readFractionalDelay(
        const std::vector<float>& buffer,
        std::size_t writeIndex,
        double delayFrames
    ) const noexcept;
};

} // namespace webrc::native
