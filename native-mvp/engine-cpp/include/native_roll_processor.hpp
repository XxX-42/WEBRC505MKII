#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

enum class NativeRollDirection : std::uint8_t {
    Forward = 0U,
    Reverse = 1U,
    Alternate = 2U,
};

// Clean-room ROLL controls. Playback pitch is implemented by resampling the
// captured slice, so pitch changes also change its playback duration. This is
// a functional MVP, not a quality-accepted or hardware-faithful algorithm.
struct NativeRollConfig {
    float bpm = 120.0f;
    float sliceBeats = 0.5f;
    float decayPercent = 15.0f;
    float pitchSemitones = 0.0f;
    NativeRollDirection direction = NativeRollDirection::Forward;
    float wetMix = 0.5f;
};

struct NativeRollStatus {
    unsigned int sampleRate = 0U;
    std::size_t maxSliceFrames = 0U;
    std::size_t captureFrames = 0U;
    std::size_t playbackFrames = 0U;
    std::uint64_t framesProcessed = 0U;
    std::uint64_t boundaryCount = 0U;
    std::int64_t lastBoundaryFrame = -1;
    unsigned int remainingFramesToBoundary = 0U;
    unsigned int transitionFramesRemaining = 0U;
    float playbackRateRatio = 1.0f;
    float repeatGain = 1.0f;
    NativeRollConfig activeConfig{};
    NativeRollConfig pendingConfig{};
    bool hasCapturedSlice = false;
    bool reversePlayback = false;
};

// Sample-clocked short-slice capture/retrigger processor with two fixed-capacity
// stereo capture banks. The banks are allocated only by prepare(); processInPlace
// accepts arbitrary block lengths and performs no allocation, locking, I/O or
// logging. Channels 1 and 2 are processed; later channels are finite-clamped
// passthrough. Calls that touch processor state must share the DSP owner thread.
// This is a clean-room implementation, not a claim of Roland hardware fidelity
// or quality acceptance.
class NativeRollProcessor final {
public:
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr std::size_t kSliceCapacitySeconds = 6U;
    static constexpr std::size_t kMaximumCrossfadeFrames = 960U;

    NativeRollProcessor() = default;

    // Allocate bounded capture memory before the audio callback starts. A
    // failed prepare leaves the prior prepared state and captured audio usable.
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;

    // Controls latch at a slice boundary. Invalid values leave both active and
    // pending state unchanged. Before clocking begins, controls apply immediately.
    [[nodiscard]] bool setConfig(const NativeRollConfig& config) noexcept;

    // Reset the sample clock and capture state while retaining the prepared
    // buffers and the most recently accepted controls.
    void reset() noexcept;

    // Process interleaved audio in place and return the finite post-effect peak.
    // Null, empty, zero-channel, or unprepared calls return zero.
    [[nodiscard]] float processInPlace(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] NativeRollStatus status() const noexcept;
    [[nodiscard]] NativeRollStatus diagnostics() const noexcept { return status(); }
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] std::size_t maxSliceFrames() const noexcept { return maxSliceFrames_; }
    [[nodiscard]] bool hasCapturedSlice() const noexcept { return hasSlice_; }
    [[nodiscard]] const NativeRollConfig& activeConfig() const noexcept { return activeConfig_; }
    [[nodiscard]] const NativeRollConfig& pendingConfig() const noexcept { return pendingConfig_; }

private:
    static constexpr float kMinimumBpm = 40.0f;
    static constexpr float kMaximumBpm = 300.0f;

    [[nodiscard]] static bool validConfig(const NativeRollConfig& config) noexcept;
    [[nodiscard]] static bool validDirection(NativeRollDirection direction) noexcept;
    [[nodiscard]] unsigned int intervalFrames(const NativeRollConfig& config) const noexcept;
    [[nodiscard]] std::size_t crossfadeFrames(std::size_t sliceFrames) const noexcept;
    [[nodiscard]] static float finiteSample(float sample) noexcept;
    [[nodiscard]] static float boundedOutput(double sample) noexcept;
    [[nodiscard]] static float rateRatio(float semitones) noexcept;
    [[nodiscard]] static std::size_t wrapIndex(std::int64_t index, std::size_t length) noexcept;
    [[nodiscard]] float interpolate(
        std::size_t bufferIndex,
        unsigned int channel,
        double position,
        std::size_t length
    ) const noexcept;
    void renderPlayback(float& left, float& right) noexcept;
    void advancePlaybackPosition() noexcept;
    void onRetrigger() noexcept;
    void onBoundary() noexcept;
    [[nodiscard]] bool nextDirectionReverse() const noexcept;

    // Bank then channel. Each vector is sized to maxSliceFrames_ in prepare().
    std::array<std::array<std::vector<float>, 2U>, 2U> buffers_{};
    // A bounded outgoing lookahead lets a captured slice crossfade cleanly into
    // either forward or reverse playback without a third dynamic audio buffer.
    std::array<std::array<float, kMaximumCrossfadeFrames>, 2U> transitionTail_{};
    NativeRollConfig activeConfig_{};
    NativeRollConfig pendingConfig_{};
    unsigned int sampleRate_ = 0U;
    std::size_t maxSliceFrames_ = 0U;
    std::size_t captureFrames_ = 0U;
    std::size_t playbackLength_ = 0U;
    double playbackPosition_ = 0.0;
    unsigned int framesUntilBoundary_ = 0U;
    unsigned int transitionFramesTotal_ = 0U;
    unsigned int transitionFramesRemaining_ = 0U;
    unsigned int captureBufferIndex_ = 0U;
    int playbackBufferIndex_ = -1;
    bool directionReverse_ = false;
    bool hasSlice_ = false;
    float activeRateRatio_ = 1.0f;
    float repeatGain_ = 1.0f;
    std::uint64_t framesProcessed_ = 0U;
    std::uint64_t boundaryCount_ = 0U;
    std::int64_t lastBoundaryFrame_ = -1;
};

} // namespace webrc::native
