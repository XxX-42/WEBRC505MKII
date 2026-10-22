#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::native::dsp {

// Stateful processors are single-owner objects with no hidden locking. Send
// parameter updates through the engine's existing control/audio handoff, then
// apply them on the owning DSP thread instead of mutating them concurrently.

// A per-sample linear ramp for scalar parameters. Call setTarget() from the
// same owning thread as next()/skip(), typically after consuming a control
// update at a block boundary; the class has no internal synchronization.
class ParameterSmoother final {
public:
    explicit ParameterSmoother(float initialValue = 0.0f) noexcept;

    void reset(float value) noexcept;
    void setTarget(float value, std::uint64_t rampFrames) noexcept;
    [[nodiscard]] float next() noexcept {
        if (remainingFrames_ != 0) {
            current_ = static_cast<float>(static_cast<double>(current_) + step_);
            --remainingFrames_;
            if (remainingFrames_ == 0) {
                current_ = target_;
                step_ = 0.0;
            }
        }
        return current_;
    }
    void skip(std::uint64_t frames) noexcept;

    [[nodiscard]] float current() const noexcept { return current_; }
    [[nodiscard]] float target() const noexcept { return target_; }
    [[nodiscard]] bool isSmoothing() const noexcept { return remainingFrames_ != 0; }
    [[nodiscard]] std::uint64_t remainingFrames() const noexcept { return remainingFrames_; }

private:
    float current_ = 0.0f;
    float target_ = 0.0f;
    double step_ = 0.0;
    std::uint64_t remainingFrames_ = 0;
};

struct CrossfadeGains {
    float first = 1.0f;
    float second = 0.0f;
};

// Position is clamped to [0, 1]. Endpoints are exactly (1, 0) and (0, 1).
[[nodiscard]] CrossfadeGains equalPowerCrossfadeGains(float position) noexcept;
[[nodiscard]] float equalPowerCrossfade(float first, float second, float position) noexcept;

enum class BiquadType : std::uint8_t {
    LowPass,
    HighPass,
    BandPass,
    Notch,
    Peaking,
    LowShelf,
    HighShelf,
};

struct BiquadCoefficients {
    // Normalized coefficients for y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2]
    //                           - a1*y[n-1] - a2*y[n-2].
    double b0 = 1.0;
    double b1 = 0.0;
    double b2 = 0.0;
    double a1 = 0.0;
    double a2 = 0.0;
};

// Cookbook RBJ filters implemented using the transposed direct-form II
// structure. Coefficient design and processing are both allocation-free.
class Biquad final {
public:
    Biquad() noexcept = default;

    [[nodiscard]] bool setParameters(
        BiquadType type,
        double sampleRate,
        double frequencyHz,
        double q = 0.7071067811865476,
        double gainDb = 0.0,
        double shelfSlope = 1.0
    ) noexcept;
    [[nodiscard]] bool setCoefficients(const BiquadCoefficients& coefficients) noexcept;
    void reset() noexcept;
    [[nodiscard]] float process(float input) noexcept;

    [[nodiscard]] const BiquadCoefficients& coefficients() const noexcept { return coefficients_; }

private:
    BiquadCoefficients coefficients_{};
    double state1_ = 0.0;
    double state2_ = 0.0;
};

struct SvfOutput {
    float lowPass = 0.0f;
    float bandPass = 0.0f;
    float highPass = 0.0f;
    float notch = 0.0f;
};

// Topology-preserving-transform state-variable filter. It exposes all four
// outputs from the same state update, which avoids duplicating filter state.
class TptStateVariableFilter final {
public:
    [[nodiscard]] bool setParameters(double sampleRate, double cutoffHz, double q) noexcept;
    void reset() noexcept;
    [[nodiscard]] SvfOutput process(float input) noexcept;

private:
    double a1_ = 1.0;
    double a2_ = 0.0;
    double a3_ = 0.0;
    double k_ = 1.4142135623730951;
    double integrator1_ = 0.0;
    double integrator2_ = 0.0;
};

// Stateless four-point cubic Lagrange interpolation. `fraction` is the offset
// from x0 toward xPlus1 and is clamped to [0, 1].
[[nodiscard]] float lagrange4(float xMinus1, float x0, float xPlus1, float xPlus2, float fraction) noexcept;

// Fixed-storage, causal fractional delay. The buffer is part of the object and
// never grows. Delay is clamped to [1, Capacity - 3] samples; this leaves the
// four interpolation taps available without requiring future audio.
template <std::size_t Capacity>
class LagrangeDelayLine final {
    static_assert(Capacity >= 4, "LagrangeDelayLine needs at least four samples of storage");

public:
    void reset(float value = 0.0f) noexcept {
        samples_.fill(value);
        writeIndex_ = 0;
    }

    [[nodiscard]] float process(float input, float delaySamples) noexcept {
        samples_[writeIndex_] = input;
        const float maxDelay = static_cast<float>(Capacity - 3);
        const float delay = clampDelay(delaySamples, maxDelay);
        const auto integerDelay = static_cast<std::size_t>(delay);
        const float fraction = delay - static_cast<float>(integerDelay);

        const float xMinus1 = readDelay(integerDelay - 1);
        const float x0 = readDelay(integerDelay);
        const float xPlus1 = readDelay(integerDelay + 1);
        const float xPlus2 = readDelay(integerDelay + 2);
        writeIndex_ = increment(writeIndex_);
        return lagrange4(xMinus1, x0, xPlus1, xPlus2, fraction);
    }

    [[nodiscard]] static constexpr std::size_t capacity() noexcept { return Capacity; }
    [[nodiscard]] static constexpr float maxDelaySamples() noexcept {
        return static_cast<float>(Capacity - 3);
    }

private:
    [[nodiscard]] static float clampDelay(float value, float maximum) noexcept {
        if (!(value >= 1.0f)) {
            return 1.0f; // Also handles NaN without introducing NaNs into the line.
        }
        return value < maximum ? value : maximum;
    }

    [[nodiscard]] float readDelay(std::size_t delay) const noexcept {
        const std::size_t index = (writeIndex_ + Capacity - (delay % Capacity)) % Capacity;
        return samples_[index];
    }

    [[nodiscard]] static constexpr std::size_t increment(std::size_t index) noexcept {
        return (index + 1) == Capacity ? 0 : index + 1;
    }

    std::array<float, Capacity> samples_{};
    std::size_t writeIndex_ = 0;
};

// SplitMix64 is compact, deterministic, and has no global or platform state.
class DeterministicRng final {
public:
    explicit DeterministicRng(std::uint64_t seed = 0x6a09e667f3bcc909ULL) noexcept;

    void seed(std::uint64_t value) noexcept { state_ = value; }
    [[nodiscard]] std::uint32_t nextUInt32() noexcept;
    [[nodiscard]] float nextUnitFloat() noexcept; // [0, 1)
    [[nodiscard]] float nextBipolarFloat() noexcept; // [-1, 1)

private:
    std::uint64_t state_;
};

// Maps integer beat indices to absolute sample frames from a fixed origin.
// Each lookup is computed from the origin (rather than accumulated intervals),
// so rounding does not drift over long sessions.
class AbsoluteBeatClock final {
public:
    [[nodiscard]] bool configure(std::uint32_t sampleRate, double bpm, std::uint64_t originFrame = 0) noexcept;
    [[nodiscard]] std::uint64_t frameForBeat(std::uint64_t beatIndex) const noexcept;
    [[nodiscard]] std::uint64_t beatAtFrame(std::uint64_t frame) const noexcept;

    [[nodiscard]] std::uint32_t sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] double bpm() const noexcept { return bpm_; }
    [[nodiscard]] std::uint64_t originFrame() const noexcept { return originFrame_; }

private:
    std::uint32_t sampleRate_ = 0;
    double bpm_ = 0.0;
    std::uint64_t originFrame_ = 0;
};

} // namespace webrc::native::dsp
