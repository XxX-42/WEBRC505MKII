#pragma once

#include <cstdint>

namespace webrc::native {

enum class NativeDynamicsDetector : std::uint8_t {
    Peak = 0,
    Rms,
};

// Clean-room stereo-linked compressor parameters. Units and limits match the
// Browser DYNAMICS contract: dBFS threshold [-60, 0], ratio [1:1, 20:1],
// soft-knee width [0, 24] dB, attack [0.1, 100] ms, release [5, 1000] ms,
// output gain [-24, +12] dB. Defaults are -18 dB, 4:1, 6 dB, 10 ms,
// 120 ms, 0 dB and peak detection. No claim of Roland circuit emulation.
struct NativeDynamicsConfig {
    float thresholdDb = -18.0f;
    float ratio = 4.0f;
    float kneeDb = 6.0f;
    float attackMs = 10.0f;
    float releaseMs = 120.0f;
    float outputGainDb = 0.0f;
    NativeDynamicsDetector detector = NativeDynamicsDetector::Peak;
};

// Clean-room F08-style stereo-linked peak/RMS compressor with an exponential
// attack/release envelope and logarithmic soft-knee curve. The detector links
// the larger absolute value of L/R (or the sole channel for mono); RMS mode
// applies an exponential mean-square average to that linked magnitude. The
// class is single-owner: call prepare()/setConfig()/reset() on the DSP thread,
// and do not mutate the processor concurrently with processInPlace(). Config
// changes take effect immediately; smooth control changes in the owning layer.
class NativeDynamicsProcessor final {
public:
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeDynamicsConfig& config) noexcept;
    void reset() noexcept;

    // Processes the first one or two interleaved channels in place. Additional
    // channels bypass dynamics but still receive non-finite cleanup and the
    // safety ceiling. Non-finite samples are replaced with zero;
    // the returned value is the post-effect peak across all channels. Arbitrary
    // block sizes are supported, with no allocation, lock, or I/O in this path.
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] const NativeDynamicsConfig& config() const noexcept { return config_; }

private:
    static constexpr double kEnvelopeFloor = 1.0e-9;
    static constexpr double kDenormalFloor = 1.0e-30;
    static constexpr double kMaxGain = 16.0;
    // Bounds pathological finite inputs and transient overs while preserving
    // the normal normalized-audio range and Browser gain limits.
    static constexpr double kMaxOutputMagnitude = 64.0;

    [[nodiscard]] static bool isValidDetector(NativeDynamicsDetector detector) noexcept;
    [[nodiscard]] static double finiteInput(float sample) noexcept;
    [[nodiscard]] static float boundedOutput(double sample) noexcept;
    void updateDerivedParameters() noexcept;
    [[nodiscard]] double updateDetector(double linkedMagnitude) noexcept;

    NativeDynamicsConfig config_{};
    unsigned int sampleRate_ = 0U;
    double attackCoefficient_ = 0.0;
    double releaseCoefficient_ = 0.0;
    double outputGainLinear_ = 1.0;
    double peakEnvelope_ = 0.0;
    double rmsMeanSquare_ = 0.0;
};

} // namespace webrc::native
