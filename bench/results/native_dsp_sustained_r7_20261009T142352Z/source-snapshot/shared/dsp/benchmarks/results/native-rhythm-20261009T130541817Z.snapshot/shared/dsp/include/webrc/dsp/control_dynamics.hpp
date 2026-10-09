#pragma once

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

[[nodiscard]] bool pitchRatioSemitones(float semitones, float& ratio) noexcept;

class PatternSlicer {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool setPattern(const float* stepGains, std::uint32_t stepCount,
                    float edgeFraction = 0.08f) noexcept;
    [[nodiscard]] float gainAtPhase(double cyclePhase) const noexcept;
    [[nodiscard]] float processSample(float input, double cyclePhase) const noexcept;
    bool processBlock(const float* input, const double* cyclePhases, float* output,
                      std::uint32_t frames) const noexcept;
    [[nodiscard]] std::uint32_t stepCount() const noexcept { return stepCount_; }

private:
    std::array<float, 64> gains_{};
    std::uint32_t maxBlockFrames_ = 64;
    std::uint32_t stepCount_ = 0;
    float edgeFraction_ = 0.08f;
    bool prepared_ = false;
};

struct ScheduledEvent {
    std::uint64_t absoluteFrame = 0;
    std::uint32_t eventId = 0;
    float value = 0.0f;
    std::uint32_t blockOffset = 0;
    bool late = false;
};

class SampleAccurateScheduler {
public:
    static constexpr std::uint32_t kCapacity = 256;

    bool prepare(const ProcessSpec& spec, double bpm, std::uint32_t ppq) noexcept;
    void reset() noexcept;
    bool setTempo(double bpm, std::uint32_t ppq) noexcept;
    bool scheduleAbsolute(const ScheduledEvent& event) noexcept;
    bool scheduleTick(std::uint64_t originFrame, std::uint64_t tick,
                      std::uint32_t eventId, float value) noexcept;
    [[nodiscard]] bool collectBlock(std::uint64_t blockStartFrame, std::uint32_t frames,
                                    ScheduledEvent* output, std::uint32_t outputCapacity,
                                    std::uint32_t& outputCount) noexcept;
    [[nodiscard]] std::uint32_t queuedCount() const noexcept { return count_; }
    [[nodiscard]] std::uint64_t tickToFrame(std::uint64_t originFrame,
                                            std::uint64_t tick) const noexcept;
    [[nodiscard]] double sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] double bpm() const noexcept { return bpm_; }
    [[nodiscard]] std::uint32_t ppq() const noexcept { return ppq_; }
    [[nodiscard]] static std::int64_t swingOffsetFrames(double sampleRate, double bpm,
                                                        std::uint32_t subdivisionsPerBeat,
                                                        double swing) noexcept;

private:
    std::array<ScheduledEvent, kCapacity> events_{};
    double sampleRate_ = 48000.0;
    double bpm_ = 120.0;
    std::uint32_t maxBlockFrames_ = 64;
    std::uint32_t ppq_ = 960;
    std::uint32_t count_ = 0;
    bool prepared_ = false;
};

class MidSideWidth {
public:
    bool prepare(const ProcessSpec& spec, float crossoverHz = 140.0f) noexcept;
    void reset() noexcept;
    bool setWidth(float highFrequencyWidth, float lowFrequencyWidth,
                  float smoothingMs = 10.0f) noexcept;
    [[nodiscard]] StereoFrame processSample(float left, float right) noexcept;
    bool processBlock(const float* inputLeft, const float* inputRight, float* outputLeft,
                      float* outputRight, std::uint32_t frames) noexcept;
    [[nodiscard]] float correlationEstimate() const noexcept { return correlation_; }
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    double crossoverPole_ = 0.0;
    double lowSideState_ = 0.0;
    double correlationCoefficient_ = 0.0;
    double leftPower_ = 0.0;
    double rightPower_ = 0.0;
    double crossPower_ = 0.0;
    ParameterSmoother highWidth_;
    ParameterSmoother lowWidth_;
    float correlation_ = 1.0f;
    std::uint32_t maxBlockFrames_ = 64;
    bool prepared_ = false;
};

struct OnsetResult {
    bool onset = false;
    float envelope = 0.0f;
    float flux = 0.0f;
};

class OnsetDetector {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool setParameters(float threshold, float adaptiveSensitivity, float attackMs,
                       float refractoryMs = 35.0f) noexcept;
    [[nodiscard]] OnsetResult processSample(float input) noexcept;
    bool processBlock(const float* input, OnsetResult* output,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    double sampleRate_ = 48000.0;
    double fastCoefficient_ = 0.0;
    double slowCoefficient_ = 0.0;
    float threshold_ = 0.01f;
    float sensitivity_ = 1.5f;
    std::uint32_t attackSamples_ = 480;
    std::uint32_t refractorySamples_ = 1680;
    std::uint32_t ageSamples_ = 0;
    std::uint32_t refractoryRemaining_ = 0;
    float fastLevel_ = 0.0f;
    float slowLevel_ = 0.0f;
    float envelope_ = 0.0f;
    bool triggered_ = false;
    std::uint32_t maxBlockFrames_ = 64;
    bool prepared_ = false;
};

class BitRateReducer {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset(std::uint64_t seed = 0x4d595df4d0f33173ULL,
               std::uint64_t sequence = 7) noexcept;
    bool setParameters(std::uint32_t bits, std::uint32_t holdSamples, float mix,
                       bool tpdfDither, float mixSmoothingMs = 10.0f) noexcept;
    [[nodiscard]] float processSample(float input) noexcept;
    bool processBlock(const float* input, float* output, std::uint32_t frames) noexcept;
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    Pcg32 random_;
    float held_ = 0.0f;
    float mix_ = 1.0f;
    std::uint32_t bits_ = 8;
    std::uint32_t holdSamples_ = 1;
    std::uint32_t samplesUntilQuantize_ = 0;
    ParameterSmoother mixSmoother_;
    std::uint32_t maxBlockFrames_ = 64;
    bool tpdfDither_ = true;
    bool prepared_ = false;
};

class RingModulator {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset(float phaseCycles = 0.0f) noexcept;
    bool setParameters(float frequencyHz, float depth,
                       float depthSmoothingMs = 10.0f) noexcept;
    [[nodiscard]] float processSample(float input) noexcept;
    bool processBlock(const float* input, float* output, std::uint32_t frames) noexcept;
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }

private:
    Lfo carrier_;
    double sampleRate_ = 48000.0;
    float depth_ = 1.0f;
    ParameterSmoother depthSmoother_;
    std::uint32_t maxBlockFrames_ = 64;
    bool prepared_ = false;
};

} // namespace webrc::dsp
