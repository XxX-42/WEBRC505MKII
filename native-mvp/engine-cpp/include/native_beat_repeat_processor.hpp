#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

enum class NativeBeatRepeatDirection : std::uint8_t {
    Forward = 0U,
    Reverse = 1U,
    Alternate = 2U,
};

// Clean-room Beat Repeat controls. BPM is supplied by the host transport;
// division is a stepped beat count, decay is percent removed at each repeat,
// and wetMix is normalized [0, 1].
struct NativeBeatRepeatConfig {
    float bpm = 120.0f;
    float division = 0.5f;
    float decay = 15.0f;
    NativeBeatRepeatDirection direction = NativeBeatRepeatDirection::Forward;
    float wetMix = 0.5f;
};

struct NativeBeatRepeatStatus {
    unsigned int sampleRate = 0U;
    std::size_t maxSliceFrames = 0U;
    std::size_t activeSliceFrames = 0U;
    std::uint64_t framesProcessed = 0U;
    std::uint64_t boundaryCount = 0U;
    std::int64_t lastBoundaryFrame = -1;
    unsigned int remainingFramesToBoundary = 0U;
    float activeBpm = 0.0f;
    float activeDivision = 0.0f;
    float activeDecay = 0.0f;
    NativeBeatRepeatDirection activeDirection = NativeBeatRepeatDirection::Forward;
    bool hasCapturedSlice = false;
    bool reversePlayback = false;
};

// Sample-clocked dual-buffer beat-slice capture/retrigger processor. Each
// slice is bounded to six seconds (the 4-beat, 40-BPM catalog maximum).
// Capture storage is allocated only by prepare(); processInPlace supports
// arbitrary block sizes and actual channel counts without allocating,
// locking, I/O, or logging. Channels 1 and 2 are processed; channels beyond
// stereo pass through unchanged. Parameter/state calls must share the DSP
// owner thread with processInPlace(). This is a clean-room functional DSP,
// not a claim of Roland hardware fidelity.
class NativeBeatRepeatProcessor final {
public:
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr std::size_t kSliceCapacitySeconds = 6U;

    NativeBeatRepeatProcessor() = default;

    // Prepare bounded stereo capture memory before the audio callback starts.
    // A failed allocation leaves the previous prepared state intact.
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;

    // BPM, division, decay, and direction latch at the next slice boundary.
    // Mix ramps immediately over rampFrames; zero applies it at the next
    // processed sample. Invalid configurations are rejected without changes.
    [[nodiscard]] bool setConfig(
        const NativeBeatRepeatConfig& config,
        std::uint64_t rampFrames = 64U
    ) noexcept;

    // Reset the beat clock and captured-slice state. Pending controls become
    // active immediately; buffer clearing is unnecessary because capture
    // lengths gate every read.
    void reset() noexcept;

    // Returns the finite post-effect peak across processed and passthrough
    // channels. Null, empty, zero-channel, or unprepared calls return zero.
    [[nodiscard]] float processInPlace(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] NativeBeatRepeatStatus status() const noexcept;
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] std::size_t maxSliceFrames() const noexcept { return maxSliceFrames_; }
    [[nodiscard]] unsigned int remainingFramesToBoundary() const noexcept { return framesUntilBoundary_; }
    [[nodiscard]] const NativeBeatRepeatConfig& activeConfig() const noexcept { return activeConfig_; }
    [[nodiscard]] const NativeBeatRepeatConfig& pendingConfig() const noexcept { return pendingConfig_; }
    [[nodiscard]] bool hasCapturedSlice() const noexcept { return hasSlice_; }

private:
    static constexpr float kMinimumBpm = 30.0f;
    static constexpr float kMaximumBpm = 300.0f;

    [[nodiscard]] static bool validConfig(const NativeBeatRepeatConfig& config) noexcept;
    [[nodiscard]] static bool validDirection(NativeBeatRepeatDirection direction) noexcept;
    [[nodiscard]] unsigned int intervalFrames(const NativeBeatRepeatConfig& config) const noexcept;
    [[nodiscard]] std::size_t crossfadeFrames(std::size_t sliceFrames) const noexcept;
    [[nodiscard]] bool isAtLoopTail(std::size_t readIndex, std::size_t fadeFrames) const noexcept;
    void renderPlayback(float& left, float& right) noexcept;
    void advancePlaybackPosition() noexcept;
    void onRetrigger() noexcept;
    void onBoundary() noexcept;
    [[nodiscard]] float captureSample(float sample) const noexcept;

    // Bank then channel. Both banks are sized to maxSliceFrames_ in prepare().
    std::array<std::array<std::vector<float>, 2U>, 2U> buffers_{};
    dsp::ParameterSmoother wetMix_{0.5f};
    NativeBeatRepeatConfig activeConfig_{};
    NativeBeatRepeatConfig pendingConfig_{};
    unsigned int sampleRate_ = 0U;
    std::size_t maxSliceFrames_ = 0U;
    std::size_t captureFrames_ = 0U;
    std::size_t playbackLength_ = 0U;
    std::size_t playbackPosition_ = 0U;
    unsigned int framesUntilBoundary_ = 0U;
    unsigned int captureBufferIndex_ = 0U;
    int playbackBufferIndex_ = -1;
    bool directionReverse_ = false;
    bool hasSlice_ = false;
    float repeatGain_ = 1.0f;
    std::uint64_t framesProcessed_ = 0U;
    std::uint64_t boundaryCount_ = 0U;
    std::int64_t lastBoundaryFrame_ = -1;
};

} // namespace webrc::native
