#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstdint>

namespace webrc::native {

// Clean-room 4x oversampled soft-saturation processor for the F16 nonlinear
// saturation family. This is an original approximation and does not claim to
// reproduce Roland's proprietary F16 sound or parameter law.
// A 97-tap polyphase interpolation FIR, memoryless tanh shaper, and 97-tap
// reconstruction FIR run at 4x sample rate. The two linear-phase FIRs add a
// fixed 24-frame latency; dry and wet paths are aligned to that latency.
// Wet transfer: tanh(10^(driveDb/20) * x) / tanh(10^(driveDb/20)).
struct NativeDistortionConfig {
    // Pre-shaper drive in dB. 0 dB is the gentlest available saturation;
    // values are limited to 0..36 dB.
    float driveDb = 12.0f;
    // Linear dry/wet blend, 0% = latency-aligned dry, 100% = saturated wet.
    float mixPercent = 100.0f;
};

class NativeDistortionProcessor final {
public:
    // Supports sample rates from 8 kHz through 192 kHz inclusive.
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeDistortionConfig& config, std::uint64_t rampFrames = 64U) noexcept;
    void reset() noexcept;

    // In-place interleaved processing. The first one or two channels are
    // processed as mono/stereo; any additional channels pass through unchanged.
    // A fixed 24-frame latency keeps dry and wet paths phase-aligned. No memory
    // is allocated, locks taken, or I/O performed by this callback method.
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] unsigned int latencyFrames() const noexcept { return kLatencyFrames; }
    [[nodiscard]] const NativeDistortionConfig& config() const noexcept { return config_; }

private:
    static constexpr unsigned int kOversampling = 4U;
    static constexpr unsigned int kFirTaps = 97U; // High-rate, odd-length linear-phase filters.
    static constexpr unsigned int kPolyphaseTaps = (kFirTaps + kOversampling - 1U) / kOversampling;
    static constexpr unsigned int kLatencyFrames = 2U * ((kFirTaps - 1U) / (2U * kOversampling));

    struct ChannelState {
        std::array<float, kPolyphaseTaps> inputHistory{};
        std::array<float, kFirTaps> reconstructionHistory{};
        std::array<float, kLatencyFrames> dryDelay{};
        unsigned int inputWrite = 0U;
        unsigned int reconstructionWrite = 0U;
        unsigned int dryWrite = 0U;
    };

    [[nodiscard]] float processSample(
        unsigned int channel,
        float input,
        float driveGain,
        float makeupGain,
        float& delayedDry
    ) noexcept;
    [[nodiscard]] float interpolate(unsigned int channel, unsigned int phase) const noexcept;
    [[nodiscard]] float reconstruct(unsigned int channel, float sample, bool computeOutput) noexcept;
    void designFilters() noexcept;

    NativeDistortionConfig config_{};
    std::array<float, kFirTaps> interpolationTaps_{};
    std::array<float, kFirTaps> reconstructionTaps_{};
    std::array<ChannelState, 2U> channels_{};
    // Smoothed independently so callback processing needs no exp/tanh
    // coefficient design. Their ramped values remain continuous on updates.
    dsp::ParameterSmoother driveGain_{3.9810717f};
    dsp::ParameterSmoother makeupGain_{1.0006971f};
    dsp::ParameterSmoother mix_{1.0f};
    unsigned int sampleRate_ = 0U;
};

} // namespace webrc::native
