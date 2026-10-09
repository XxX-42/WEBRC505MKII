#pragma once

#include "webrc/dsp/primitives.hpp"
#include "webrc/dsp/signalsmith_adapter.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kOctaveSignalsmithModelsApiVersion = 1U;

enum class OctaveSignalsmithMode : std::uint8_t {
    DownOneOctave = 0U,
    DownTwoOctaves = 1U,
    DualDownOctaves = 2U,
};

enum class OctaveSignalsmithControl : std::uint8_t {
    Active,
    Mix,
    Mode,
};

struct OctaveSignalsmithOptions {
    std::uint32_t blockSamples = 512U;
    std::uint32_t intervalSamples = 128U;
    bool splitComputation = false;
    float controlSmoothingMs = 8.0f;
};

struct OctaveSignalsmithEvent {
    std::uint32_t frameOffset = 0U;
    OctaveSignalsmithControl control = OctaveSignalsmithControl::Active;
    float value = 0.0f;
};

struct OctaveSignalsmithLatency {
    std::uint32_t fixedMixedPathSamples = 0U;
    int adapterInputLatencySamples = 0;
    int adapterOutputLatencySamples = 0;
};

// Experimental clean-room implementation of OCTAVE -1OCT, -2OCT, and
// -1OCT&-2OCT, backed by two continuously-running pinned Signalsmith Stretch
// branches at 0.5x and 0.25x. Equal input/output frame counts preserve duration.
// Mode events change a smoothed branch mix at their sample offset. This is a
// functional candidate only: spectral/transient quality, total graph timing,
// runtime integration, and cross-runtime/device qualification remain open.
//
// Prepare only a fresh inactive instance and swap it into a graph off the
// audio callback. The conservative budget includes both branches, all wrapper
// scratch and alignment history. In no-exception builds the budget is only a
// preflight; allocator OOM during prepare remains fail-fast. processBlock is
// allocation/free/lock/IO-free after successful prepare.
class OctaveSignalsmithModelsFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;

    explicit OctaveSignalsmithModelsFxProcessor(std::uint32_t seed = 1U) noexcept;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const OctaveSignalsmithOptions& options = {}) noexcept;
    [[nodiscard]] static std::size_t replacementPeakBytes(
        std::size_t activeBytes, const ProcessSpec& spec,
        const OctaveSignalsmithOptions& options = {}) noexcept;

    bool prepare(const ProcessSpec& spec, const OctaveSignalsmithOptions& options = {}) noexcept;
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const OctaveSignalsmithEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] OctaveSignalsmithLatency latency() const noexcept;
    [[nodiscard]] OctaveSignalsmithMode targetMode() const noexcept { return modeTarget_; }
    [[nodiscard]] std::uint32_t seed() const noexcept { return seed_; }

private:
    [[nodiscard]] static bool validOptions(const ProcessSpec& spec,
                                           const OctaveSignalsmithOptions& options) noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames,
                                     const OctaveSignalsmithEvent* events,
                                     std::uint32_t eventCount) const noexcept;
    [[nodiscard]] static bool validateEvent(const OctaveSignalsmithEvent& event) noexcept;
    void applyEvent(const OctaveSignalsmithEvent& event) noexcept;
    void advanceControls() noexcept;

    ProcessSpec spec_{};
    OctaveSignalsmithOptions options_{};
    std::uint32_t seed_ = 1U;
    std::array<std::unique_ptr<SignalsmithStretchAdapter>, 2U> branches_{};
    std::array<std::vector<float>, 2U> inputPlanar_{};
    std::array<std::vector<float>, 2U> oneOctavePlanar_{};
    std::array<std::vector<float>, 2U> twoOctavePlanar_{};
    std::vector<StereoFrame> dryHistory_;
    std::size_t ringMask_ = 0U;
    std::uint32_t fixedPathFrames_ = 0U;
    std::uint64_t expectedAbsoluteFrame_ = 0U;
    std::uint64_t processedFrames_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double controlSmoothingCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 0.5f;
    float mixCurrent_ = 0.5f;
    float oneVoiceTarget_ = 1.0f;
    float oneVoiceCurrent_ = 1.0f;
    float twoVoiceTarget_ = 0.0f;
    float twoVoiceCurrent_ = 0.0f;
    OctaveSignalsmithMode modeTarget_ = OctaveSignalsmithMode::DownOneOctave;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
