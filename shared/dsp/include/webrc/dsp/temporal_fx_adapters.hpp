#pragma once

#include "webrc/dsp/nonlinear.hpp"
#include "webrc/dsp/performance_fx.hpp"
#include "webrc/dsp/spatial_temporal.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kTemporalFxAdapterApiVersion = 1U;

enum class TemporalFxKind : std::uint8_t {
    TapeEcho,
    GranularDelay,
    Warp,
    Twist,
    Roll,
    Freeze,
};

enum class TemporalFxControl : std::uint8_t {
    Active,
    Wet,
    DelayMs,
    Feedback,
    ToneHz,
    WowDepthMs,
    WowRateHz,
    Drive,
    GrainMs,
    DensityHz,
    PitchRatio,
    PositionSpread,
    Freeze,
    WarpAmount,
    ReverbTimeSeconds,
    DampingHz,
    TempoBpm,
    SubdivisionBeats,
    TwistMacro,
};

struct TemporalFxEvent {
    // Events are applied immediately before the addressed sample. Offsets must
    // be ordered, inside the block, and no block may contain more than 64.
    std::uint32_t frameOffset = 0U;
    TemporalFxControl control = TemporalFxControl::Active;
    float value = 0.0f;
};

struct TemporalFxOptions {
    float maximumDelaySeconds = 2.0f;
    float granularCaptureSeconds = 2.0f;
    std::uint32_t freezeWindowFrames = 1024U;
    std::uint32_t freezeHopFrames = 256U;
};

struct TemporalFxLatency {
    // -1 means variable wet-path latency. Dry path alignment is fixed per kind.
    std::int32_t fixedAlgorithmicSamples = 0;
    std::uint32_t minimumWetDelaySamples = 0U;
    std::uint32_t maximumWetDelaySamples = 0U;
    // Additional signal-processing group delay, such as the 4x tape record path.
    double wetPathGroupDelaySamples = 0.0;
};

// Prepared stereo time FX. Call requiredPrepareBytes() and account for the
// entire active+staged graph before prepare; prepare a fresh inactive instance
// and swap it into the callback graph only after success. processBlock is
// allocation-free, lock-free and single-owner, accepts variable blocks up to
// ProcessSpec::maxBlockFrames, and rejects gaps/overlaps without state changes.
// All control values are reconstruction controls, not the manufacturer's UI
// parameter contract. No class in this file claims complete product-FX quality.
class TemporalFxAdapter final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;
    static constexpr std::uint32_t kInterpolationPhaseCount = 256U;
    static constexpr std::uint32_t kInterpolationTapCount = 8U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, TemporalFxKind kind,
        const TemporalFxOptions& options = {}) noexcept;

    bool prepare(const ProcessSpec& spec, TemporalFxKind kind,
                 const TemporalFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool setSeed(std::uint64_t seed) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const TemporalFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] TemporalFxKind kind() const noexcept { return kind_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] TemporalFxLatency latency() const noexcept;
    [[nodiscard]] std::uint32_t activeGrains() const noexcept;
    [[nodiscard]] std::uint32_t repeatFrames() const noexcept;

private:
    [[nodiscard]] static bool validKind(TemporalFxKind kind) noexcept;
    [[nodiscard]] static std::uint32_t historyCapacityFrames(const ProcessSpec& spec,
                                                              float seconds) noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const TemporalFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const TemporalFxEvent& event) const noexcept;
    void applyEvent(const TemporalFxEvent& event, std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] StereoFrame processSample(StereoFrame input,
                                            std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] StereoFrame processTapeEcho(StereoFrame input,
                                              std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] StereoFrame processGranularDelay(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processWarp(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processFreeze(StereoFrame input) noexcept;
    [[nodiscard]] StereoFrame processTwist(StereoFrame input,
                                           std::uint64_t absoluteFrame) noexcept;
    void updateWarpParameters() noexcept;
    [[nodiscard]] StereoFrame readHistory(double absoluteFrame,
                                          std::uint64_t newestFrame) const noexcept;
    void writeHistory(std::uint64_t absoluteFrame, StereoFrame sample) noexcept;
    void advanceControls() noexcept;
    void prepareInterpolationTable() noexcept;

    ProcessSpec spec_{};
    TemporalFxOptions options_{};
    TemporalFxKind kind_ = TemporalFxKind::TapeEcho;
    std::vector<StereoFrame> history_;
    GranularTexture granular_{};
    SpectralFreeze spectralFreeze_{};
    FdnReverb warpReverb_{};
    BeatRepeat roll_{};
    std::array<PerformanceFxEvent, 64U> rollEvents_{};
    // The last row is phase 1.0, permitting coefficient interpolation without
    // a discontinuity where the fractional position wraps to the next sample.
    std::array<std::array<float, kInterpolationTapCount>, kInterpolationPhaseCount + 1U> sinc8Table_{};
    std::array<OversampledNonlinear, 2> tapeSaturator_{};
    std::array<float, 2> feedbackFilterState_{};
    Lfo wowLfo_{};
    PlatterInertia twistInertia_{};
    std::uint32_t historyMask_ = 0U;
    std::uint32_t historyFrames_ = 0U;
    std::uint32_t freezeWindowFrames_ = 1024U;
    std::uint32_t freezeHopFrames_ = 256U;
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    std::uint64_t randomSeed_ = 0x6a09e667f3bcc909ULL;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float wetTarget_ = 0.5f;
    float wetCurrent_ = 0.5f;
    float delayMsTarget_ = 240.0f;
    double delayMsCurrent_ = 240.0;
    float feedbackTarget_ = 0.35f;
    float feedbackCurrent_ = 0.35f;
    float toneHzTarget_ = 6500.0f;
    float toneHzCurrent_ = 6500.0f;
    float wowDepthMsTarget_ = 1.1f;
    float wowDepthMsCurrent_ = 1.1f;
    float wowRateHz_ = 0.35f;
    float driveTarget_ = 2.0f;
    float driveCurrent_ = 2.0f;
    float grainMs_ = 180.0f;
    float densityHz_ = 12.0f;
    float pitchRatio_ = 1.0f;
    float positionSpread_ = 0.45f;
    float warpAmount_ = 0.55f;
    float rt60Seconds_ = 2.2f;
    float dampingHz_ = 6500.0f;
    float tempoBpm_ = 120.0f;
    float subdivisionBeats_ = 0.25f;
    float twistMacro_ = 0.0f;
    float twistMacroCurrent_ = 0.0f;
    double toneCoefficientCurrent_ = 0.0;
    double toneCoefficientTarget_ = 0.0;
    double controlSmoothingCoefficient_ = 0.0;
    double twistReadPosition_ = 0.0;
    StereoFrame granularFeedbackState_{};
    bool twistReadInitialized_ = false;
    bool freezeRequested_ = false;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
