#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kApiVersion = 1;

struct ProcessSpec {
    float sampleRate = 48000.0f;
    std::uint32_t maxBlockFrames = 64;
    std::uint32_t channels = 2;
};

struct StereoFrame {
    float left = 0.0f;
    float right = 0.0f;
};

struct StereoGains {
    float left = 0.7071067811865475f;
    float right = 0.7071067811865475f;
};

struct SvfOutput {
    float low = 0.0f;
    float band = 0.0f;
    float high = 0.0f;
};

enum class BoundaryMode : std::uint8_t {
    Zero,
    Clamp,
    Wrap,
};

enum class OscillatorWaveform : std::uint8_t {
    Sine,
    Saw,
    Square,
    Triangle,
};

[[nodiscard]] bool validProcessSpec(const ProcessSpec& spec) noexcept;
[[nodiscard]] float sanitize(float value) noexcept;
[[nodiscard]] float equalPowerCrossfade(float a, float b, float phase) noexcept;
[[nodiscard]] StereoGains equalPowerPan(float pan) noexcept;

class ParameterSmoother {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset(float value = 0.0f) noexcept;
    bool setTarget(float value, float timeMs) noexcept;
    [[nodiscard]] float next() noexcept;
    bool processBlock(float* output, std::uint32_t frames) noexcept;
    [[nodiscard]] float current() const noexcept { return current_; }
    [[nodiscard]] float target() const noexcept { return target_; }
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    float sampleRate_ = 48000.0f;
    std::uint32_t maxBlockFrames_ = 64;
    float current_ = 0.0f;
    float target_ = 0.0f;
    float coefficient_ = 0.0f;
};

struct BiquadCoefficients {
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
};

class BiquadDf2T {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool setCoefficients(const BiquadCoefficients& coefficients, float smoothingMs = 5.0f) noexcept;
    bool setLowpass(float frequencyHz, float q, float smoothingMs = 5.0f) noexcept;
    bool setHighpass(float frequencyHz, float q, float smoothingMs = 5.0f) noexcept;
    bool setBandpass(float frequencyHz, float q, float smoothingMs = 5.0f) noexcept;
    bool setPeaking(float frequencyHz, float q, float gainDb, float smoothingMs = 5.0f) noexcept;
    [[nodiscard]] float processSample(float input) noexcept;
    bool processBlock(const float* input, float* output, std::uint32_t frames) noexcept;
    [[nodiscard]] const BiquadCoefficients& coefficients() const noexcept { return coefficients_; }
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    bool makeRbJ(float frequencyHz, float q, float gainDb, unsigned int type,
                 float smoothingMs) noexcept;
    void advanceCoefficients() noexcept;

    double sampleRate_ = 48000.0;
    std::uint32_t maxBlockFrames_ = 64;
    BiquadCoefficients coefficients_{};
    BiquadCoefficients targetCoefficients_{};
    BiquadCoefficients coefficientStep_{};
    std::uint32_t coefficientRampRemaining_ = 0;
    double z1_ = 0.0;
    double z2_ = 0.0;
    bool prepared_ = false;
};

class TptStateVariableFilter {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool setFrequencyQ(float frequencyHz, float q, float smoothingMs = 5.0f) noexcept;
    [[nodiscard]] SvfOutput processSample(float input) noexcept;
    bool processBlock(const float* input, float* low, float* band, float* high,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    double sampleRate_ = 48000.0;
    std::uint32_t maxBlockFrames_ = 64;
    float g_ = 0.0f;
    float k_ = 1.41421356237f;
    float a1_ = 1.0f;
    float a2_ = 0.0f;
    float a3_ = 0.0f;
    float targetG_ = 0.0f;
    float targetK_ = 1.41421356237f;
    float stepG_ = 0.0f;
    float stepK_ = 0.0f;
    float stepA1_ = 0.0f;
    float stepA2_ = 0.0f;
    float stepA3_ = 0.0f;
    std::uint32_t coefficientRampRemaining_ = 0;
    float ic1_ = 0.0f;
    float ic2_ = 0.0f;
    bool prepared_ = false;
};

class AllPass1 {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool setFrequency(float frequencyHz, float smoothingMs = 5.0f) noexcept;
    [[nodiscard]] float processSample(float input) noexcept;
    bool processBlock(const float* input, float* output, std::uint32_t frames) noexcept;
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    double sampleRate_ = 48000.0;
    std::uint32_t maxBlockFrames_ = 64;
    float coefficient_ = 0.0f;
    float targetCoefficient_ = 0.0f;
    float coefficientStep_ = 0.0f;
    std::uint32_t coefficientRampRemaining_ = 0;
    float x1_ = 0.0f;
    float y1_ = 0.0f;
    bool prepared_ = false;
};

class LagrangeDelay {
public:
    bool prepare(const ProcessSpec& spec, std::uint32_t maxDelaySamples);
    void reset() noexcept;
    [[nodiscard]] float processSample(float input, float delaySamples) noexcept;
    bool processBlock(const float* input, float* output, const float* delaySamples,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t maxDelaySamples() const noexcept { return maxDelaySamples_; }
    [[nodiscard]] static constexpr float minimumDelaySamples() noexcept { return 2.5f; }
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    [[nodiscard]] float read(std::int64_t index) const noexcept;
    [[nodiscard]] std::size_t wrapIndex(std::int64_t index) const noexcept;

    std::vector<float> buffer_;
    std::size_t writePosition_ = 0;
    std::uint32_t maxBlockFrames_ = 64;
    std::uint32_t maxDelaySamples_ = 0;
};

[[nodiscard]] float sinc8Read(const float* input, std::size_t frames, double position,
                              BoundaryMode boundary = BoundaryMode::Zero) noexcept;
[[nodiscard]] constexpr std::uint32_t sinc8LookaheadSamples() noexcept { return 4; }

class Lfo {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset(float phaseCycles = 0.0f) noexcept;
    bool setFrequency(float frequencyHz) noexcept;
    [[nodiscard]] float next() noexcept;
    bool processBlock(float* output, std::uint32_t frames) noexcept;

private:
    double sampleRate_ = 48000.0;
    std::uint32_t maxBlockFrames_ = 64;
    double phase_ = 0.0;
    double sine_ = 0.0;
    double cosine_ = 1.0;
    double sinStep_ = 0.0;
    double cosStep_ = 1.0;
    std::uint32_t samplesSinceNormalize_ = 0;
};

class PolyBlepOscillator {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset(float phaseCycles = 0.0f) noexcept;
    bool setFrequency(float frequencyHz) noexcept;
    void setWaveform(OscillatorWaveform waveform) noexcept;
    [[nodiscard]] float next() noexcept;
    bool processBlock(float* output, std::uint32_t frames) noexcept;

private:
    [[nodiscard]] static float polyBlep(double phase, double increment) noexcept;
    [[nodiscard]] static double integratedPolyBlep(double phase, double increment) noexcept;

    double sampleRate_ = 48000.0;
    std::uint32_t maxBlockFrames_ = 64;
    double phase_ = 0.0;
    double increment_ = 0.0;
    double sine_ = 0.0;
    double cosine_ = 1.0;
    double sinStep_ = 0.0;
    double cosStep_ = 1.0;
    std::uint32_t samplesSinceNormalize_ = 0;
    OscillatorWaveform waveform_ = OscillatorWaveform::Sine;
};

class AdaaCubicShaper {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool setDrive(float drive) noexcept;
    [[nodiscard]] float processSample(float input) noexcept;
    bool processBlock(const float* input, float* output, std::uint32_t frames) noexcept;
    // No whole-sample buffering is inserted. The ADAA divided difference has
    // frequency-dependent small-signal group delay (about 0.5 sample at low
    // frequencies for this first-order formulation); it is not literally zero-delay.
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    static double shape(double input) noexcept;
    static double antiderivative(double input) noexcept;

    std::uint32_t maxBlockFrames_ = 64;
    double drive_ = 1.0;
    double previousInput_ = 0.0;
    bool prepared_ = false;
};

class DualDetectorCompressor {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool setParameters(float thresholdDb, float ratio, float kneeDb, float attackMs,
                       float releaseMs, float rmsMix, float makeupDb) noexcept;
    [[nodiscard]] StereoFrame processSample(float left, float right) noexcept;
    bool processBlock(const float* inputLeft, const float* inputRight, float* outputLeft,
                      float* outputRight, std::uint32_t frames) noexcept;
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    static float timeCoefficient(float timeMs, float sampleRate) noexcept;
    float gainForLevel(float level) noexcept;

    double sampleRate_ = 48000.0;
    std::uint32_t maxBlockFrames_ = 64;
    float thresholdDb_ = -18.0f;
    float ratio_ = 4.0f;
    float kneeDb_ = 6.0f;
    float attackMs_ = 5.0f;
    float releaseMs_ = 80.0f;
    float rmsMix_ = 0.5f;
    float makeupDb_ = 0.0f;
    double peakEnvelope_ = 0.0;
    double rmsEnvelopeSquared_ = 0.0;
    float attackCoefficient_ = 0.0f;
    float releaseCoefficient_ = 0.0f;
    bool prepared_ = false;
};

class DelayMatrix2 {
public:
    void reset() noexcept;
    bool setFeedback(float sameChannel, float crossChannel) noexcept;
    [[nodiscard]] StereoFrame process(StereoFrame input, StereoFrame delayed) const noexcept;
    [[nodiscard]] float sameChannelFeedback() const noexcept { return sameChannel_; }
    [[nodiscard]] float crossChannelFeedback() const noexcept { return crossChannel_; }

private:
    float sameChannel_ = 0.0f;
    float crossChannel_ = 0.0f;
};

class Pcg32 {
public:
    void seed(std::uint64_t initialState, std::uint64_t sequence = 1) noexcept;
    [[nodiscard]] std::uint32_t nextU32() noexcept;
    [[nodiscard]] float nextBipolar() noexcept;

private:
    std::uint64_t state_ = 0x853c49e6748fea9bULL;
    std::uint64_t increment_ = 0xda3e39cb94b95bdbULL;
};

} // namespace webrc::dsp
