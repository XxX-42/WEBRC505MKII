#pragma once

#include <signalsmith-stretch/signalsmith-stretch.h>

#include <array>
#include <cstdint>

namespace webrc::native {

// Native adapter for the pinned, MIT-licensed Signalsmith Stretch C++ engine.
// It uses the same cheaper/split-computation preset as Browser LIVE_POLY.
// Memory is configured before streaming; input/output are staged in fixed
// buffers so the upstream engine can safely process an in-place host block.
class NativePolyPitchProcessor final {
public:
    static constexpr unsigned int kMinimumSampleRate = 8000U;
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr unsigned int kMaximumChannels = 2U;
    static constexpr unsigned int kMaximumSemitones = 24U;
    static constexpr unsigned int kMaximumProcessFrames = 4096U;

    NativePolyPitchProcessor() noexcept = default;

    [[nodiscard]] bool prepare(unsigned int sampleRate, float semitones = 0.0f) noexcept;
    // Lower-latency Signalsmith configuration used by catalog FX. The existing
    // LIVE_POLY playback route keeps its cheaper, 140 ms preset via prepare().
    [[nodiscard]] bool prepareForFx(unsigned int sampleRate, float semitones = 0.0f) noexcept;
    [[nodiscard]] bool setSemitones(float semitones) noexcept;
    // Official PITCH BEND supports -3..+4 octaves. Keep the legacy setter
    // and playback-domain limits unchanged. Scalar, allocation-free update.
    [[nodiscard]] bool setOfficialBendSemitones(float semitones) noexcept;
    // Signalsmith's formant mapping is configured outside render-buffer setup;
    // these setters only update bounded scalar state in the live engine.
    [[nodiscard]] bool setFormantSemitones(float semitones, bool compensatePitch = false) noexcept;
    [[nodiscard]] bool setFormantBaseHz(float frequencyHz) noexcept;
    void reset() noexcept;

    [[nodiscard]] bool processInterleaved(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] unsigned int latencySamples() const noexcept { return latencySamples_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] float semitones() const noexcept { return targetSemitones_; }
    [[nodiscard]] float formantSemitones() const noexcept { return targetFormantSemitones_; }
    [[nodiscard]] float formantBaseHz() const noexcept { return formantBaseHz_; }
    [[nodiscard]] static unsigned int calculateLatencySamples(unsigned int sampleRate) noexcept;
    [[nodiscard]] static unsigned int calculateFxLatencySamples(unsigned int sampleRate) noexcept;

private:
    static constexpr unsigned int kEngineChannels = 2U;
    static constexpr unsigned int kScratchSamples = kMaximumProcessFrames * kEngineChannels;

    [[nodiscard]] static bool validSemitones(float semitones) noexcept;
    [[nodiscard]] static bool validFormantSemitones(float semitones) noexcept;
    [[nodiscard]] bool prepareConfigured(
        unsigned int sampleRate,
        float semitones,
        unsigned int blockMilliseconds,
        unsigned int intervalMilliseconds,
        bool splitComputation
    ) noexcept;

    // Fixed seed avoids random_device activity during engine construction and
    // makes the two-channel processing path reproducible across test runs.
    signalsmith::stretch::SignalsmithStretch<float> engine_{0x5050505L};
    std::array<float, kScratchSamples> inputScratch_{};
    std::array<float, kScratchSamples> outputScratch_{};
    unsigned int sampleRate_ = 0U;
    unsigned int latencySamples_ = 0U;
    unsigned int inputChannels_ = 0U;
    float targetSemitones_ = 0.0f;
    float targetFormantSemitones_ = 0.0f;
    float formantBaseHz_ = 0.0f;
    bool formantCompensation_ = false;
    bool prepared_ = false;
};

} // namespace webrc::native
