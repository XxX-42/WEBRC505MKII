#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

enum class NativeFreezeMode : std::uint8_t {
    MicroLoop = 0U,
    Spectral = 1U,
};

enum class NativeFreezeConfigResult : std::uint8_t {
    Accepted = 0U,
    InvalidConfig = 1U,
    UnsupportedMode = 2U,
    InsufficientCaptureHistory = 3U,
};

// Clean-room Native FREEZE controls. Only MicroLoop is currently implemented;
// Spectral is explicitly rejected rather than routed to a different algorithm.
struct NativeFreezeConfig {
    float captureLengthMs = 250.0f;
    NativeFreezeMode mode = NativeFreezeMode::MicroLoop;
    float pitchSemitones = 0.0f;
    float wetMix = 1.0f;
    bool frozen = false;
};

struct NativeFreezeStatus {
    unsigned int sampleRate = 0U;
    std::size_t ringCapacityFrames = 0U;
    std::size_t validCaptureFrames = 0U;
    std::size_t requiredCaptureFrames = 0U;
    std::size_t loopFrames = 0U;
    std::size_t crossfadeFrames = 0U;
    std::uint64_t framesProcessed = 0U;
    double playbackPosition = 0.0;
    float playbackRateRatio = 1.0f;
    NativeFreezeConfig config{};
    bool prepared = false;
    bool frozen = false;
    bool hasCapturedLoop = false;
};

// Fixed-capacity stereo ring-buffer micro-loop freeze. prepare() allocates up
// to two seconds per channel; processInPlace() accepts arbitrary block lengths
// and performs no allocation, locking, I/O, or logging. State-changing calls
// and processInPlace() must be serialized on the DSP owner thread. While
// un-frozen, input is passed through and captured continuously, even when the
// host-bypass argument is true. Releasing resumes capture and blends from the
// last rendered stereo output to live input over a fixed 5 ms fade. This is a
// provisional clean-room DSP
// implementation, not a hardware-fidelity or quality-acceptance claim.
class NativeFreezeProcessor final {
public:
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr float kMinimumCaptureLengthMs = 2.0f;
    static constexpr float kMaximumCaptureLengthMs = 2000.0f;
    static constexpr float kMinimumPitchSemitones = -24.0f;
    static constexpr float kMaximumPitchSemitones = 24.0f;
    static constexpr float kMinimumWetMix = 0.0f;
    static constexpr float kMaximumWetMix = 1.0f;

    NativeFreezeProcessor() = default;

    // Allocate bounded capture memory before the audio callback starts. A
    // failed prepare leaves any prior prepared state and captured audio intact.
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;

    // Invalid controls, Spectral mode, or a freeze request before the requested
    // history is available leave both controls and processor state unchanged.
    [[nodiscard]] NativeFreezeConfigResult setConfig(const NativeFreezeConfig& config) noexcept;

    // Reset capture/playback state while retaining the current non-freeze
    // controls and preallocated memory.
    void reset() noexcept;

    // Process interleaved audio in place and return the finite post-effect peak.
    // When hostBypassed is true, wet audio is muted to dry while ring capture
    // and frozen playback timing continue. Channels 1 and 2 use linked stereo
    // playback; later channels are finite-clamped passthrough.
    [[nodiscard]] float processInPlace(
        float* interleaved,
        unsigned int frames,
        unsigned int channels,
        bool hostBypassed = false
    ) noexcept;

    [[nodiscard]] NativeFreezeStatus status() const noexcept;
    [[nodiscard]] NativeFreezeStatus diagnostics() const noexcept { return status(); }
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool isFrozen() const noexcept { return frozen_; }
    [[nodiscard]] bool hasCapturedLoop() const noexcept { return hasLoop_; }
    [[nodiscard]] const NativeFreezeConfig& activeConfig() const noexcept { return config_; }

private:
    static constexpr std::size_t kMaximumCrossfadeFrames = 960U;

    [[nodiscard]] static bool validConfig(const NativeFreezeConfig& config) noexcept;
    [[nodiscard]] static float finiteSample(float sample) noexcept;
    [[nodiscard]] static float boundedOutput(double sample) noexcept;
    [[nodiscard]] static float rateRatio(float semitones) noexcept;
    [[nodiscard]] std::size_t captureFramesFor(float milliseconds) const noexcept;
    [[nodiscard]] std::size_t crossfadeFrames(std::size_t loopFrames) const noexcept;
    [[nodiscard]] static std::size_t wrapIndex(std::int64_t index, std::size_t length) noexcept;
    [[nodiscard]] float readLoop(unsigned int channel, double position) const noexcept;
    void captureFrame(float left, float right) noexcept;
    void renderFrozen(float& left, float& right) noexcept;
    void latchLoop(std::size_t length) noexcept;
    void releaseLoop() noexcept;

    std::vector<float> ringLeft_{};
    std::vector<float> ringRight_{};
    NativeFreezeConfig config_{};
    unsigned int sampleRate_ = 0U;
    std::size_t writePosition_ = 0U;
    std::size_t validCaptureFrames_ = 0U;
    std::size_t loopStart_ = 0U;
    std::size_t loopFrames_ = 0U;
    std::size_t crossfadeFrames_ = 0U;
    std::size_t releaseFadeLength_ = 0U;
    std::size_t releaseFadePosition_ = 0U;
    double playbackPosition_ = 0.0;
    float playbackRateRatio_ = 1.0f;
    float mixCurrent_ = 1.0f;
    float mixSmoothingCoefficient_ = 1.0f;
    float lastOutputLeft_ = 0.0f;
    float lastOutputRight_ = 0.0f;
    float releaseFadeStartLeft_ = 0.0f;
    float releaseFadeStartRight_ = 0.0f;
    std::uint64_t framesProcessed_ = 0U;
    bool frozen_ = false;
    bool hasLoop_ = false;
};

} // namespace webrc::native
