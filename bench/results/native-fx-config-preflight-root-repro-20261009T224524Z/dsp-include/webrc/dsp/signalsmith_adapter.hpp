#pragma once

#include "webrc/dsp/primitives.hpp"

#include <signalsmith-stretch/signalsmith-stretch.h>

#include <array>
#include <cstdint>
#include <memory>
#include <vector>

namespace webrc::dsp {

enum class PitchQualityMode : std::uint8_t {
    LiveMono,
    LivePoly,
    HqRender,
};

struct SignalsmithStretchSettings {
    PitchQualityMode mode = PitchQualityMode::LiveMono;
    std::uint32_t channels = 1;
    std::uint32_t blockSamples = 512;
    std::uint32_t intervalSamples = 128;
    bool splitComputation = false;
    std::uint32_t seed = 1;
};

// Thin wrapper over the pinned upstream Signalsmith Stretch engine. configure()
// is a preparation operation; process() only uses preallocated planar scratch
// and the engine's prepared work buffers. `peakBudgetBytes` is an adapter-local
// staging budget that must include both the active instance and its replacement
// during prepare. The estimate is deliberately conservative, but on builds
// without exceptions an allocator failure is still fail-fast; graph planners
// must preflight the total active + staged graph against the module memory cap.
// Mode names select metadata only: callers must separately validate each full
// LIVE_MONO / LIVE_POLY / HQ_RENDER route and its total algorithmic latency.
// prepare(), reset(), parameter setters, and process() are mutually exclusive
// operations on one instance. Build a separate inactive adapter off the audio
// callback, then publish/swap the containing graph at a controlled boundary.
class SignalsmithStretchAdapter {
public:
    explicit SignalsmithStretchAdapter(std::uint32_t seed = 1) noexcept;
    bool prepare(const ProcessSpec& spec,
                 const SignalsmithStretchSettings& settings,
                 std::size_t peakBudgetBytes) noexcept;
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const SignalsmithStretchSettings& settings) noexcept;
    void reset() noexcept;
    bool setTransposeFactor(float factor, float tonalityLimit = 0.0f) noexcept;
    bool setFormantFactor(float factor, bool compensatePitch = false) noexcept;
    bool process(const float* const* inputChannels, std::uint32_t inputFrames,
                 float* const* outputChannels, std::uint32_t outputFrames) noexcept;
    // Offline/fixed-length render priming. The required prefix length follows
    // the pinned engine's outputSeekLength() formula; outputSeek() accepts only
    // that exact prefix so its inferred playback rate cannot silently differ.
    // These calls are bounded by prepare-time scratch and are allocation-free,
    // but outputSeek performs an engine reset and is not an audio-callback call.
    [[nodiscard]] bool outputSeekLength(float playbackRate,
                                        std::uint32_t& inputFrames) const noexcept;
    bool outputSeek(const float* const* inputChannels, std::uint32_t inputFrames,
                    float playbackRate) noexcept;
    // Drain the prepared engine tail into caller-owned planar output buffers.
    // A flush ends the current fixed-length render session and resets engine
    // state according to the upstream implementation.
    bool flush(float* const* outputChannels, std::uint32_t outputFrames,
               float playbackRate) noexcept;
    [[nodiscard]] int inputLatencySamples() const noexcept;
    [[nodiscard]] int outputLatencySamples() const noexcept;
    [[nodiscard]] const SignalsmithStretchSettings& settings() const noexcept { return settings_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::uint32_t constructorSeed() const noexcept { return constructorSeed_; }

private:
    struct InputView {
        const float* const* channels;
        const float* operator[](int channel) const noexcept { return channels[channel]; }
    };
    struct OutputView {
        float* const* channels;
        float* operator[](int channel) const noexcept { return channels[channel]; }
    };

    ProcessSpec spec_{};
    SignalsmithStretchSettings settings_{};
    using Engine = signalsmith::stretch::SignalsmithStretch<float>;
    std::unique_ptr<Engine> engine_;
    std::array<std::vector<float>, 2> finiteInputScratch_;
    std::array<std::vector<float>, 2> finiteOutputScratch_;
    std::uint32_t seekInputCapacityFrames_ = 0U;
    std::size_t preparedBytes_ = 0;
    const std::uint32_t constructorSeed_;
    bool prepared_ = false;
};

} // namespace webrc::dsp
