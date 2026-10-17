#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>

namespace webrc::native {

struct NativeVinylFlickConfig {
    // -100 stops the platter, 0 is nominal 1x playback, and +100 is 2x.
    // Negative settings slow the platter; this processor does not reverse it.
    float speedPercent = 0.0f;
    // Motor response time constant in seconds, not a user-event timeout.
    float motorReturnSeconds = 1.0f;
    // Viscous brake drag, expressed as a percentage of maximum.
    float brakePercent = 0.0f;
    // Linear dry/wet blend. Zero is dry; 100 is resampled signal only.
    float mixPercent = 100.0f;
};

// Clean-room VINYL FLICK stereo processor. A bounded rolling history feeds a
// cubic variable-rate resampler. A normalized platter velocity is driven by
// finite motor torque toward the requested speed, with bearing friction and
// an additional viscous brake load. All history is fixed/preallocated; processInPlace()
// performs no allocation. Configure/reset on the DSP-owner thread or through
// the host's bounded command queue. This is not a Roland implementation.
// The fixed 131,072-frame history is a rolling loop. At 48 kHz it retains
// about 2.73 seconds; a reader that reaches either edge wraps to the opposite
// edge and uses a 64-frame blend. A fully stopped platter holds its last
// stereo sample; when it spins up again, its read head is reseeded halfway
// into retained history and faded in. The nominal 1x/dry-alignment latency is
// exactly three frames; variable-rate playback changes content timing.
class NativeVinylFlickProcessor final {
public:
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr std::size_t kHistoryFrames = 131072U;
    static constexpr unsigned int kNominalLatencyFrames = 3U;

    NativeVinylFlickProcessor() noexcept = default;

    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(
        const NativeVinylFlickConfig& config,
        std::uint64_t rampFrames = 0U
    ) noexcept;
    void reset() noexcept;

    // Processes the first two interleaved channels. Mono and extra channels
    // pass through unchanged. Arbitrary block lengths are supported.
    [[nodiscard]] float processInPlace(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool prepared() const noexcept { return sampleRate_ != 0U; }
    [[nodiscard]] float speedPercent() const noexcept { return config_.speedPercent; }
    [[nodiscard]] float motorReturnSeconds() const noexcept { return config_.motorReturnSeconds; }
    [[nodiscard]] float brakePercent() const noexcept { return config_.brakePercent; }
    [[nodiscard]] float mixPercent() const noexcept { return config_.mixPercent; }
    [[nodiscard]] double platterSpeedRatio() const noexcept { return platterSpeedRatio_; }
    [[nodiscard]] static constexpr unsigned int latencyFrames() noexcept { return kNominalLatencyFrames; }

private:
    static constexpr std::size_t kHistoryMask = kHistoryFrames - 1U;
    static constexpr std::size_t kWarmupFrames = 1024U;
    static constexpr unsigned int kFadeFrames = 64U;
    static constexpr double kMinimumReadAge = 3.0;
    static constexpr double kViscousFriction = 0.1;
    static constexpr double kStoppedVelocity = 1.0e-5;

    [[nodiscard]] static bool validConfig(const NativeVinylFlickConfig& config) noexcept;
    [[nodiscard]] static float sanitizeSample(float sample) noexcept;
    [[nodiscard]] static double wrapCursor(double cursor) noexcept;
    [[nodiscard]] static double cursorAge(std::size_t newestIndex, double cursor) noexcept;
    [[nodiscard]] float readHistory(const float* history, std::size_t index) const noexcept;
    [[nodiscard]] float resample(const float* history) const noexcept;
    void advancePlatter(float targetSpeed, double motorReturnSeconds, float brakePercent) noexcept;
    void beginFadeFrom(float left, float right) noexcept;

    // Storage is exactly 2 * kHistoryFrames samples and is allocated only in
    // prepare(), so large buffers never live on the audio thread's stack.
    std::unique_ptr<float[]> history_{};
    std::array<float, kNominalLatencyFrames> dryDelayLeft_{};
    std::array<float, kNominalLatencyFrames> dryDelayRight_{};
    std::size_t dryDelayCursor_ = 0U;
    std::size_t writeCursor_ = 0U;
    std::size_t validFrames_ = 0U;
    double readCursor_ = static_cast<double>(kHistoryFrames - 3U);
    unsigned int sampleRate_ = 0U;
    NativeVinylFlickConfig config_{};
    dsp::ParameterSmoother speedPercent_{0.0f};
    dsp::ParameterSmoother motorReturnSeconds_{1.0f};
    dsp::ParameterSmoother brakePercent_{0.0f};
    dsp::ParameterSmoother mixPercent_{100.0f};
    double platterSpeedRatio_ = 1.0;
    float lastWetLeft_ = 0.0f;
    float lastWetRight_ = 0.0f;
    float fadeFromLeft_ = 0.0f;
    float fadeFromRight_ = 0.0f;
    float frozenLeft_ = 0.0f;
    float frozenRight_ = 0.0f;
    unsigned int fadeRemaining_ = 0U;
    bool loopReady_ = false;
    bool platterStopped_ = false;
};

} // namespace webrc::native
