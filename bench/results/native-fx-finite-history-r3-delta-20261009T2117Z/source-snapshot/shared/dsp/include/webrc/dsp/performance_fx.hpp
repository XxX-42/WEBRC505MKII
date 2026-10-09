#pragma once

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kPerformanceFxApiVersion = 1;

enum class PerformanceFxKind : std::uint8_t {
    BeatScatter,
    BeatRepeat,
    BeatShift,
    VinylFlick,
};

enum class PerformanceFxControl : std::uint8_t {
    Active,
    TempoBpm,
    SubdivisionBeats,
    Wet,
    Feedback,
    ScatterAmount,
    PitchRatio,
    ShiftBeats,
    FlickImpulse,
};

// Events are applied before the named sample is rendered. Offsets must be
// ordered and lie inside the current block. At most 64 control changes may be
// supplied per block; invalid lists are rejected before state or audio changes.
struct PerformanceFxEvent {
    std::uint32_t frameOffset = 0;
    PerformanceFxControl control = PerformanceFxControl::Active;
    float value = 0.0f;
};

// Standalone track processor family. prepare() allocates a bounded history
// buffer and (for Beat Repeat) two bounded loop buffers. Build and prepare an
// inactive instance off the callback, then swap it into the graph. Processing
// is in-place interleaved stereo and performs no allocation or locking. The
// object is single-owner: prepare/reset/setSeed must run while it is quiescent;
// processBlock and direct queries must not race each other.
class PerformanceFxProcessor {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64;
    static constexpr float kMaximumHistorySeconds = 4.0f;
    static constexpr float kMaximumBeatShiftHistorySeconds = 7.0f;
    static constexpr float kMaximumRepeatSeconds = 2.0f;

    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec,
                                                          PerformanceFxKind kind) noexcept;
    bool prepare(const ProcessSpec& spec);
    void reset(std::uint64_t absoluteFrame = 0) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const PerformanceFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0) noexcept;
    // Seed changes are only accepted while inactive and quiescent; this keeps
    // scatter fixtures deterministic without introducing a cross-thread command.
    bool setSeed(std::uint64_t seed) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] PerformanceFxKind kind() const noexcept { return kind_; }
    [[nodiscard]] float activeGain() const noexcept { return activeGain_; }
    [[nodiscard]] float tempoBpm() const noexcept { return tempoBpm_; }
    [[nodiscard]] float subdivisionBeats() const noexcept { return subdivisionBeats_; }
    [[nodiscard]] std::uint32_t activeGrains() const noexcept;
    // Number of history taps rejected because their absolute-frame tag did not
    // match the ring slot. This is owner-thread telemetry for diagnostics; it
    // does not count as an audio fault and never changes processing state.
    [[nodiscard]] std::uint64_t historyTagMissCount() const noexcept {
        return historyTagMissCount_;
    }
    [[nodiscard]] std::uint32_t repeatFrames() const noexcept { return repeatFrames_; }
    [[nodiscard]] std::uint32_t repeatCaptureFramesCopiedLastBlock() const noexcept {
        return repeatCaptureFramesCopiedLastBlock_;
    }
    [[nodiscard]] std::uint32_t repeatCaptureFramesRemaining() const noexcept {
        return repeatCapturePending_ && repeatCaptureCursor_ < repeatCaptureFrames_
            ? repeatCaptureFrames_ - repeatCaptureCursor_ : 0U;
    }
    [[nodiscard]] double vinylReadPosition() const noexcept { return vinylReadPosition_; }
    [[nodiscard]] float vinylSpeedRatio() const noexcept { return vinylSpeedRatio_; }
    [[nodiscard]] std::uint32_t algorithmicLatencySamples() const noexcept;
    [[nodiscard]] static constexpr std::uint32_t maximumControlEventCount() noexcept {
        return kMaximumControlEventsPerBlock;
    }

protected:
    explicit PerformanceFxProcessor(PerformanceFxKind kind) noexcept : kind_(kind) {}

private:
    struct Grain {
        double readPosition = 0.0;
        float readStep = 1.0f;
        std::uint32_t age = 0;
        std::uint32_t length = 0;
        bool active = false;
    };

    [[nodiscard]] bool validateEvents(std::uint32_t frames,
                                      const PerformanceFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const PerformanceFxEvent& event) const noexcept;
    void applyEvent(const PerformanceFxEvent& event, std::uint64_t absoluteFrame) noexcept;
    void updateBeatInterval(std::uint64_t absoluteFrame) noexcept;
    void captureRepeat(std::uint64_t absoluteFrame, bool feedbackFromPrevious) noexcept;
    void advanceRepeatCapture() noexcept;
    void spawnGrain(std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] StereoFrame renderSample(StereoFrame input,
                                           std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] StereoFrame readHistory(double absoluteFrame) const noexcept;
    [[nodiscard]] StereoFrame historyAt(std::int64_t absoluteFrame) const noexcept;
    void writeHistory(std::uint64_t absoluteFrame, StereoFrame frame) noexcept;
    [[nodiscard]] float randomUnit() noexcept;
    void resetEffectState(std::uint64_t absoluteFrame) noexcept;

    PerformanceFxKind kind_ = PerformanceFxKind::BeatScatter;
    ProcessSpec spec_{};
    std::vector<StereoFrame> history_;
    std::vector<std::uint64_t> historyFrameTags_;
    std::array<std::vector<StereoFrame>, 2> repeatBuffers_;
    std::array<Grain, 16> grains_{};
    std::uint64_t expectedFrame_ = 0;
    std::uint64_t randomSeed_ = 0x243f6a8885a308d3ULL;
    std::uint64_t randomState_ = 0x243f6a8885a308d3ULL;
    std::uint64_t activeSinceFrame_ = 0;
    std::uint64_t repeatCycleStartFrame_ = 0;
    std::uint64_t repeatNextBoundaryFrame_ = 0;
    std::uint64_t vinylReferenceFrame_ = 0;
    std::uint32_t repeatFrames_ = 0;
    std::uint32_t repeatPosition_ = 0;
    std::uint32_t repeatActiveBuffer_ = 0;
    std::uint32_t repeatFadePosition_ = 0;
    std::uint32_t repeatFadeFrames_ = 0;
    std::uint32_t repeatCaptureBuffer_ = 0;
    std::uint32_t repeatCaptureCursor_ = 0;
    std::uint32_t repeatCaptureFrames_ = 0;
    std::uint32_t repeatFeedbackBuffer_ = 0;
    std::uint32_t repeatFeedbackFrames_ = 0;
    std::uint32_t repeatFadeBuffer_ = 0;
    std::uint32_t repeatFadeSourceFrames_ = 0;
    std::uint32_t repeatCaptureFramesCopiedLastBlock_ = 0;
    std::uint32_t historyFrames_ = 0;
    std::uint32_t fadeFrames_ = 0;
    std::uint32_t fadePosition_ = 0;
    std::uint32_t grainFrames_ = 0;
    double beatIntervalFrames_ = 0.0;
    double nextGrainFrame_ = 0.0;
    double repeatBoundaryExactFrame_ = 0.0;
    double repeatReadPosition_ = 0.0;
    std::int64_t repeatHistoryStartFrame_ = 0;
    double shiftCurrentDelay_ = 0.0;
    double shiftOldDelay_ = 0.0;
    double shiftTargetDelay_ = 0.0;
    double vinylReadPosition_ = 0.0;
    float tempoBpm_ = 120.0f;
    float subdivisionBeats_ = 0.25f;
    float wet_ = 1.0f;
    float wetCurrent_ = 1.0f;
    float feedback_ = 0.0f;
    float feedbackCurrent_ = 0.0f;
    float repeatCaptureFeedback_ = 0.0f;
    float scatterAmount_ = 0.5f;
    float pitchRatio_ = 1.0f;
    float shiftBeats_ = 0.0f;
    float vinylSpeedRatio_ = 1.0f;
    float vinylVelocity_ = 0.0f;
    float activeGain_ = 0.0f;
    float targetActiveGain_ = 0.0f;
    double wetSmoothingCoefficient_ = 0.0;
    double feedbackSmoothingCoefficient_ = 0.0;
    StereoFrame feedbackState_{};
    std::uint32_t repeatSourceFrames_ = 0;
    std::uint32_t repeatFadeTotalFrames_ = 0;
    std::uint32_t historyWriteFrame_ = 0;
    mutable std::uint64_t historyTagMissCount_ = 0;
    std::int64_t repeatCaptureStartFrame_ = 0;
    bool repeatReady_ = false;
    bool repeatBufferValid_ = false;
    bool repeatSourceHistory_ = false;
    bool repeatCapturePending_ = false;
    bool repeatFadeHasSource_ = false;
    bool vinylReadInitialized_ = false;
    bool hasExpectedFrame_ = false;
    bool active_ = false;
    bool prepared_ = false;
};

class BeatScatter final : public PerformanceFxProcessor {
public:
    BeatScatter() noexcept : PerformanceFxProcessor(PerformanceFxKind::BeatScatter) {}
};

class BeatRepeat final : public PerformanceFxProcessor {
public:
    BeatRepeat() noexcept : PerformanceFxProcessor(PerformanceFxKind::BeatRepeat) {}
};

class BeatShift final : public PerformanceFxProcessor {
public:
    BeatShift() noexcept : PerformanceFxProcessor(PerformanceFxKind::BeatShift) {}
};

class VinylFlick final : public PerformanceFxProcessor {
public:
    VinylFlick() noexcept : PerformanceFxProcessor(PerformanceFxKind::VinylFlick) {}
};

} // namespace webrc::dsp
