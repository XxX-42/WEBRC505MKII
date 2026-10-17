#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Clean-room REVERSE DELAY controls. The segment length is a stepped beat
// value clocked from BPM; feedback and crossfade use percent/ms units as
// displayed by the Native catalog.
struct NativeReverseDelayConfig {
    float bpm = 120.0f;
    float segmentBeats = 1.0f;
    float feedbackPercent = 20.0f;
    float crossfadeMs = 20.0f;
    float mixPercent = 30.0f;
};

struct NativeReverseDelayStatus {
    unsigned int sampleRate = 0U;
    std::size_t maxSegmentFrames = 0U;
    std::size_t activeSegmentFrames = 0U;
    std::size_t captureFrames = 0U;
    std::size_t playbackFrames = 0U;
    std::size_t crossfadeFrames = 0U;
    std::size_t wetLookaheadFrames = 0U;
    std::size_t causalSegmentLatencyFrames = 0U;
    std::uint64_t framesProcessed = 0U;
    std::uint64_t boundaryCount = 0U;
    bool hasCapturedSegment = false;
};

// Bounded two-segment reverse delay. One stereo segment is captured while the
// previous complete segment is played backwards. Segment length follows the
// sample clock (rounded beat duration), and tempo/beat changes latch only at
// segment boundaries. A fixed 100 ms wet lookahead lets a completed segment
// overlap-crossfade causally with the prior segment's held tail. Thus the
// first reverse arrival is one complete segment plus that lookahead after its
// capture begins; query causalSegmentLatencyFrames() for the active setting.
// Storage is allocated in prepare(), capped at eight seconds per segment and
// 100 ms for the crossfade queue. processInPlace() accepts arbitrary blocks,
// performs no allocations/locks/I/O, and supports one or two processed
// channels (additional channels pass through, with non-finite values cleared).
// This is a functional clean-room approximation, not a claim of Roland
// hardware fidelity or sound-quality acceptance.
class NativeReverseDelayProcessor final {
public:
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr float kMinimumBpm = 30.0f;
    static constexpr float kMaximumBpm = 300.0f;

    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(
        const NativeReverseDelayConfig& config,
        std::uint64_t rampFrames = 64U
    ) noexcept;
    void reset() noexcept;

    [[nodiscard]] float processInPlace(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] NativeReverseDelayStatus status() const noexcept;
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] std::size_t maxSegmentFrames() const noexcept { return maxSegmentFrames_; }
    [[nodiscard]] std::size_t causalSegmentLatencyFrames() const noexcept;
    [[nodiscard]] const NativeReverseDelayConfig& activeConfig() const noexcept { return activeConfig_; }
    [[nodiscard]] const NativeReverseDelayConfig& pendingConfig() const noexcept { return pendingConfig_; }

private:
    static constexpr std::size_t kChannelCount = 2U;
    static constexpr std::size_t kSegmentBufferCount = 2U;
    static constexpr std::size_t kMaxSegmentSeconds = 8U;
    static constexpr unsigned int kMaxCrossfadeMs = 100U;
    static constexpr float kMaxFeedbackPercent = 95.0f;
    static constexpr float kMaxMixPercent = 100.0f;
    static constexpr float kMaxCrossfadeSample = 8.0f;
    static constexpr float kMaxOutputSample = 16.0f;

    std::array<std::array<std::vector<float>, kChannelCount>, kSegmentBufferCount> segments_{};
    std::array<std::vector<float>, kChannelCount> wetDelay_{};
    dsp::ParameterSmoother feedbackPercent_{20.0f};
    dsp::ParameterSmoother crossfadeMs_{20.0f};
    dsp::ParameterSmoother mixPercent_{30.0f};
    NativeReverseDelayConfig activeConfig_{};
    NativeReverseDelayConfig pendingConfig_{};
    unsigned int sampleRate_ = 0U;
    std::size_t maxSegmentFrames_ = 0U;
    std::size_t activeSegmentFrames_ = 0U;
    std::size_t captureFrames_ = 0U;
    std::size_t playbackLength_ = 0U;
    std::size_t playbackPosition_ = 0U;
    std::size_t crossfadeFrames_ = 0U;
    std::size_t wetLookaheadFrames_ = 0U;
    std::size_t wetDelayWriteIndex_ = 0U;
    unsigned int captureBufferIndex_ = 0U;
    unsigned int playbackBufferIndex_ = 0U;
    bool hasPlaybackSegment_ = false;
    bool playbackActive_ = false;
    std::uint64_t framesProcessed_ = 0U;
    std::uint64_t boundaryCount_ = 0U;

    [[nodiscard]] static bool validConfig(const NativeReverseDelayConfig& config) noexcept;
    [[nodiscard]] std::size_t segmentFramesFor(const NativeReverseDelayConfig& config) const noexcept;
    [[nodiscard]] std::size_t requestedCrossfadeFrames(float crossfadeMs) const noexcept;
    [[nodiscard]] float renderPlaybackSample(unsigned int channel) noexcept;
    void completeCaptureSegment() noexcept;
    [[nodiscard]] static float finiteBounded(float value, float magnitude) noexcept;
};

} // namespace webrc::native
