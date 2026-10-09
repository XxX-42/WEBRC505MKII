#pragma once

#include "webrc/dsp/primitives.hpp"
#include "webrc/dsp/spatial_temporal.hpp"

#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kSpatialFxAdapterApiVersion = 1U;

enum class SpatialFxKind : std::uint8_t {
    ReverseDelay,
    GateReverb,
    ReverseReverb,
};

enum class SpatialFxControl : std::uint8_t {
    Active,
    Wet,
    Feedback,
    ReverbTimeSeconds,
    DampingHz,
    ModulationRateHz,
    ModulationDepthMs,
    GateThresholdDb,
    GateHoldMs,
    GateReleaseMs,
};

struct SpatialFxEvent {
    std::uint32_t frameOffset = 0U;
    SpatialFxControl control = SpatialFxControl::Active;
    float value = 0.0f;
};

struct SpatialFxPrepareOptions {
    // ReverseSegment is configured at prepare time. Changing segment geometry
    // requires staging a new inactive adapter and swapping it off the callback.
    float maximumReverseSeconds = 0.5f;
    float reverseSegmentSeconds = 0.25f;
    float reverseCrossfadeSeconds = 0.01f;
    float reverbMaximumDelaySeconds = 0.12f;
};

// Stereo-only adapters for the remaining spatial/reverb catalog entries.
// Their ordinals are stable catalog identities, not claims of full Roland
// algorithm or official-parameter equivalence. prepare/reset are setup-thread
// operations; processBlock has fixed state and is allocation/lock/IO free.
class SpatialFxAdapter final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;

    [[nodiscard]] static std::uint16_t effectOrdinal(SpatialFxKind kind) noexcept;
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, SpatialFxKind kind,
        const SpatialFxPrepareOptions& options = {}) noexcept;

    // prepare only on a fresh inactive adapter after the returned budget has
    // been admitted. On no-exception hosts, the caller must reserve this full
    // object + nested primitive budget before constructing the staged graph.
    bool prepare(const ProcessSpec& spec, SpatialFxKind kind,
                 const SpatialFxPrepareOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const SpatialFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] SpatialFxKind kind() const noexcept { return kind_; }
    [[nodiscard]] bool active() const noexcept { return targetActive_; }
    [[nodiscard]] float wet() const noexcept { return targetWet_; }
    [[nodiscard]] float feedback() const noexcept { return targetFeedback_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    // Dry-through is immediate for all three mixed effects. Reverse output
    // becomes available after wetPathWarmupSamples(), so report zero fixed
    // graph latency and expose that wet-path staging interval separately.
    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0U; }
    [[nodiscard]] std::uint32_t wetPathWarmupSamples() const noexcept;

private:
    [[nodiscard]] bool validateEvents(std::uint32_t frames,
                                      const SpatialFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const SpatialFxEvent& event) const noexcept;
    void applyEvent(const SpatialFxEvent& event) noexcept;
    void applyReverbParameters() noexcept;
    [[nodiscard]] StereoFrame processSample(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processReverseDelay(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processGateReverb(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processReverseReverb(StereoFrame input) noexcept;
    void updateSmoothers() noexcept;

    ProcessSpec spec_{};
    SpatialFxPrepareOptions options_{};
    FdnReverb reverb_{};
    ReverseSegment reverse_{};
    std::uint64_t expectedFrame_ = 0U;
    std::uint64_t processedFrames_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double smootherCoefficient_ = 0.0;
    double gateAttackCoefficient_ = 0.0;
    double gateReleaseCoefficient_ = 0.0;
    double detectorAttackCoefficient_ = 0.0;
    double detectorReleaseCoefficient_ = 0.0;
    float targetWet_ = 0.5f;
    float currentWet_ = 0.5f;
    float targetFeedback_ = 0.0f;
    float currentFeedback_ = 0.0f;
    float targetActiveGain_ = 1.0f;
    float currentActiveGain_ = 1.0f;
    float targetRt60_ = 1.2f;
    float targetDampingHz_ = 8000.0f;
    float targetModulationRateHz_ = 0.17f;
    float targetModulationDepthMs_ = 0.15f;
    float gateThresholdDb_ = -30.0f;
    float gateThresholdLinear_ = 0.0316227766f;
    float gateHoldMs_ = 70.0f;
    float gateReleaseMs_ = 160.0f;
    float detectorEnvelope_ = 0.0f;
    float gateGain_ = 0.0f;
    float reverseFeedbackStateLeft_ = 0.0f;
    float reverseFeedbackStateRight_ = 0.0f;
    std::uint64_t gateHoldRemaining_ = 0U;
    SpatialFxKind kind_ = SpatialFxKind::ReverseDelay;
    bool targetActive_ = true;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
