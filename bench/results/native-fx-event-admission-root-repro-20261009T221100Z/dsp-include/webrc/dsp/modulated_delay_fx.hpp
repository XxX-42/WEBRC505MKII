#pragma once

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kModulatedDelayFxApiVersion = 1;

enum class ModulatedDelayKind : std::uint8_t {
    Flanger,
    Chorus,
    Vibrato,
    ModDelay,
    PanningDelay,
};

enum class ModulatedDelayControl : std::uint8_t {
    Active,
    Wet,
    RateHz,
    BaseDelayMs,
    DepthMs,
    Feedback,
    Pan,
    PanDepth,
    CrossFeedback,
};

struct ModulatedDelayEvent {
    std::uint32_t frameOffset = 0;
    ModulatedDelayControl control = ModulatedDelayControl::Active;
    float value = 0.0f;
};

struct ModulatedDelayWindow {
    // Wet-path variable delay bounds in frames. The dry path contributes zero
    // delay; this range describes the modulated delay read head only.
    double minimumSamples = 0.0;
    double maximumSamples = 0.0;
};

// Standalone, allocation-free-in-process stereo delay processors. Prepare a
// fresh inactive instance after admitting requiredPrepareBytes() to the graph
// memory budget, then atomically replace the old instance after prepare succeeds.
// prepare/reset are setup operations; processBlock is single-owner realtime work.
class ModulatedDelayFx final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64;
    static constexpr std::uint32_t kInterpolationTaps = 8;
    static constexpr double kMinimumDelaySamples = 6.0;

    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec,
                                                          ModulatedDelayKind kind) noexcept;
    [[nodiscard]] static std::uint16_t effectOrdinal(ModulatedDelayKind kind) noexcept;
    bool prepare(const ProcessSpec& spec, ModulatedDelayKind kind);
    void reset(std::uint64_t absoluteFrame = 0) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const ModulatedDelayEvent* events = nullptr,
                      std::uint32_t eventCount = 0) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] ModulatedDelayKind kind() const noexcept { return kind_; }
    [[nodiscard]] bool active() const noexcept { return active_; }
    [[nodiscard]] float wet() const noexcept { return wet_; }
    [[nodiscard]] float feedback() const noexcept { return feedback_; }
    [[nodiscard]] std::uint32_t ringFrames() const noexcept { return ringMask_ + 1U; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] ModulatedDelayWindow delayWindowSamples() const noexcept;
    // No fixed block latency is inserted. The wet path has the variable delay
    // window returned by delayWindowSamples().
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept {
        return 0U;
    }

private:
    [[nodiscard]] bool validateEvent(const ModulatedDelayEvent& event) const noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const ModulatedDelayEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    void applyEvent(const ModulatedDelayEvent& event) noexcept;
    [[nodiscard]] StereoFrame processSample(StereoFrame input) noexcept;
    [[nodiscard]] float readDelay(std::uint32_t channel, double delaySamples) const noexcept;
    [[nodiscard]] float feedbackHighpass(std::uint32_t channel, float input) noexcept;
    [[nodiscard]] static StereoFrame applyStereoPan(StereoFrame input, float pan) noexcept;

    ProcessSpec spec_{};
    std::vector<StereoFrame> delayLine_;
    std::vector<std::uint32_t> generationTags_;
    Lfo leftLfo_{};
    Lfo rightLfo_{};
    ModulatedDelayKind kind_ = ModulatedDelayKind::Flanger;
    std::uint64_t expectedFrame_ = 0;
    std::size_t preparedBytes_ = 0;
    std::uint32_t ringMask_ = 0;
    std::uint32_t writeIndex_ = 0;
    std::uint32_t generation_ = 1;
    std::uint32_t maximumDelaySamples_ = 0;
    double interpolationSmoothingCoefficient_ = 0.0;
    double feedbackDcCoefficient_ = 0.0;
    std::array<double, 2> feedbackPreviousInput_{};
    std::array<double, 2> feedbackDcState_{};
    float wet_ = 0.5f;
    float wetCurrent_ = 0.5f;
    float rateHz_ = 0.5f;
    float baseDelayMs_ = 8.0f;
    float baseDelayCurrentMs_ = 8.0f;
    float depthMs_ = 5.5f;
    float depthCurrentMs_ = 5.5f;
    float feedback_ = 0.45f;
    float feedbackCurrent_ = 0.45f;
    float pan_ = 0.0f;
    float panCurrent_ = 0.0f;
    float panDepth_ = 0.0f;
    float panDepthCurrent_ = 0.0f;
    float crossFeedback_ = 0.0f;
    float crossFeedbackCurrent_ = 0.0f;
    float activeGain_ = 0.0f;
    float targetActiveGain_ = 0.0f;
    bool active_ = false;
    bool prepared_ = false;
    bool hasExpectedFrame_ = false;
};

} // namespace webrc::dsp
