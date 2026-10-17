#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Clean-room, deterministic tempo-slice grain scatter. Controls match the
// Browser BEAT SCATTER DSP/catalog ranges; this is not a Roland algorithm.
struct NativeBeatScatterConfig {
    float bpm = 120.0f;
    float sliceBeats = 0.25f;
    float scatterPercent = 50.0f;
    float pitchSemitones = 0.0f;
    unsigned int repeats = 4U;
    float wetMix = 0.5f;
};

struct NativeBeatScatterStatus {
    unsigned int sampleRate = 0U;
    std::size_t maxSliceFrames = 0U;
    std::size_t activeSliceFrames = 0U;
    std::uint64_t framesProcessed = 0U;
    std::uint64_t boundaryCount = 0U;
    std::int64_t lastBoundaryFrame = -1;
    unsigned int remainingFramesToBoundary = 0U;
    float activeBpm = 0.0f;
    float activeSliceBeats = 0.0f;
    float activeScatterPercent = 0.0f;
    float activePitchSemitones = 0.0f;
    unsigned int activeRepeats = 0U;
    bool hasCapturedSlice = false;
};

// A bounded, sample-clocked stereo slice capture/playback processor. Storage
// is allocated only by prepare(); arbitrary block sizes are accepted without
// callback allocation, locking, I/O, or logging. Channels beyond stereo pass
// through unchanged. Control calls must be serialized with processing or sent
// through the owning audio thread. This is clean-room DSP, not hardware code.
class NativeBeatScatterProcessor final {
public:
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr std::size_t kSliceCapacitySeconds = 6U;

    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeBeatScatterConfig& config,
        std::uint64_t mixRampFrames = 64U) noexcept;
    void reset() noexcept;

    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames,
        unsigned int channels) noexcept;

    [[nodiscard]] NativeBeatScatterStatus status() const noexcept;
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] std::size_t maxSliceFrames() const noexcept { return maxSliceFrames_; }
    [[nodiscard]] unsigned int remainingFramesToBoundary() const noexcept { return framesUntilBoundary_; }
    [[nodiscard]] const NativeBeatScatterConfig& activeConfig() const noexcept { return activeConfig_; }
    [[nodiscard]] const NativeBeatScatterConfig& pendingConfig() const noexcept { return pendingConfig_; }
    [[nodiscard]] bool hasCapturedSlice() const noexcept { return hasSlice_; }

private:
    static constexpr std::array<float, 5U> kSliceBeatOptions{{0.25f, 0.5f, 1.0f, 2.0f, 4.0f}};
    static constexpr std::uint32_t kInitialRandomState = 0x6d2b79f5U;

    [[nodiscard]] static bool validConfig(const NativeBeatScatterConfig& config) noexcept;
    [[nodiscard]] unsigned int intervalFrames(const NativeBeatScatterConfig& config) const noexcept;
    [[nodiscard]] static float finiteSample(float sample) noexcept;
    void processFrame(float* frame, unsigned int channels) noexcept;
    void renderGrain(float& left, float& right) noexcept;
    void onBoundary() noexcept;
    void prepareGrains() noexcept;
    [[nodiscard]] std::uint32_t nextRandom() noexcept;

    // bank, channel. Both banks are prepared off the audio thread.
    std::array<std::array<std::vector<float>, 2U>, 2U> buffers_{};
    std::array<std::size_t, 16U> grainStarts_{};
    std::array<std::size_t, 16U> grainLengths_{};
    dsp::ParameterSmoother wetMix_{0.5f};
    NativeBeatScatterConfig activeConfig_{};
    NativeBeatScatterConfig pendingConfig_{};
    unsigned int sampleRate_ = 0U;
    std::size_t maxSliceFrames_ = 0U;
    std::size_t captureFrames_ = 0U;
    std::size_t playbackLength_ = 0U;
    std::size_t playbackElapsedFrames_ = 0U;
    unsigned int framesUntilBoundary_ = 0U;
    unsigned int activeIntervalFrames_ = 0U;
    unsigned int captureBufferIndex_ = 0U;
    int playbackBufferIndex_ = -1;
    std::uint32_t randomState_ = kInitialRandomState;
    float pitchRatio_ = 1.0f;
    float previousWetLeft_ = 0.0f;
    float previousWetRight_ = 0.0f;
    bool hasSlice_ = false;
    std::uint64_t framesProcessed_ = 0U;
    std::uint64_t boundaryCount_ = 0U;
    std::int64_t lastBoundaryFrame_ = -1;
};

} // namespace webrc::native
