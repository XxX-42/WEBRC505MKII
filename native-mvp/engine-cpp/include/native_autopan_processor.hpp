#pragma once

#include "dsp_primitives.hpp"
#include "native_output_stage.hpp"

#include <cstdint>

namespace webrc::native {

enum class NativeAutoPanAlgorithm : std::uint8_t {
    EqualPowerMidSideLfo = 0,
};

enum class NativeAutoPanWaveform : std::uint8_t {
    Sine = 0,
    Triangle,
    Square,
};

struct NativeAutoPanConfig {
    bool enabled = false;
    NativeTrackOutputSlot slot = NativeTrackOutputSlot::A;
    NativeAutoPanAlgorithm algorithm = NativeAutoPanAlgorithm::EqualPowerMidSideLfo;
    float rateHz = 0.5f;
    float depth = 0.7f;
    NativeAutoPanWaveform waveform = NativeAutoPanWaveform::Sine;
    float wetMix = 1.0f;
};

// Clean-room AUTO PAN (catalog ID 29). Stereo processing rotates the Mid
// component with equal-power gains while preserving, then smoothly narrowing,
// the Side component. A separate mono-to-stereo entrypoint applies the same
// LFO to equal-power mono pan gains. All state is single-owner and all DSP
// storage is fixed-size; setConfig() must be called on the DSP-owner thread.
class NativeAutoPanProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeAutoPanConfig& config, std::uint64_t rampFrames = 64U) noexcept;

    // Processes the first two interleaved channels in place; channels beyond
    // stereo pass through unchanged. Returns the post-effect peak.
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

    // Expands a mono input block to stereo using equal-power pan gains. Input
    // and output may alias only when caller provides sufficient 2x capacity.
    [[nodiscard]] float processMonoToStereo(
        const float* monoInput,
        float* stereoOutput,
        unsigned int frames
    ) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool enabled() const noexcept { return config_.enabled; }
    [[nodiscard]] float rateHz() const noexcept { return config_.rateHz; }
    [[nodiscard]] float depth() const noexcept { return config_.depth; }
    [[nodiscard]] NativeAutoPanWaveform waveform() const noexcept { return config_.waveform; }
    [[nodiscard]] float wetMix() const noexcept { return config_.wetMix; }

private:
    static constexpr double kTwoPi = 6.28318530717958647692;
    static constexpr float kSqrtTwo = 1.41421356237309504880f;

    struct FrameState {
        float leftGain = 0.70710678f;
        float rightGain = 0.70710678f;
        float sideGain = 1.0f;
        float dryGain = 1.0f;
        float wetGain = 0.0f;
    };

    unsigned int sampleRate_ = 0U;
    double phase_ = 0.0;
    NativeAutoPanConfig config_{};
    NativeAutoPanWaveform waveformOld_ = NativeAutoPanWaveform::Sine;
    NativeAutoPanWaveform waveformTarget_ = NativeAutoPanWaveform::Sine;
    dsp::ParameterSmoother rateHz_{0.5f};
    dsp::ParameterSmoother depth_{0.7f};
    dsp::ParameterSmoother wetMix_{0.0f};
    dsp::ParameterSmoother waveformBlend_{1.0f};

    [[nodiscard]] static bool validWaveform(NativeAutoPanWaveform waveform) noexcept;
    [[nodiscard]] static float polyBlep(double phase, double phaseStep) noexcept;
    [[nodiscard]] static float lfoValue(NativeAutoPanWaveform waveform, double phase, double phaseStep) noexcept;
    [[nodiscard]] FrameState nextFrameState() noexcept;
    void advancePhase(float rateHz) noexcept;
};

} // namespace webrc::native
