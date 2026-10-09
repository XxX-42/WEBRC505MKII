#pragma once

#include "webrc/dsp/octave_fx.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kOctaveModelsApiVersion = 1U;

enum class OctaveModelsMode : std::uint8_t {
    DownOneOctave = 0U,
    DownTwoOctaves = 1U,
    DualDownOctaves = 2U,
};

enum class OctaveModelsControl : std::uint8_t {
    Active,
    Mix,
    Mode,
};

struct OctaveModelsOptions {
    // The existing phase-vocoder voice is run at -12 semitones. The -2 voice
    // cascades two independently prepared -12 stages. This preserves the
    // existing primitive's ratio contract instead of pretending its single
    // octave mode can synthesize -24 semitones.
    OctaveFxOptions voice{};
    float controlSmoothingMs = 8.0f;
};

struct OctaveModelsEvent {
    // Mode values are the exact integer enum encodings 0, 1, and 2.
    // Events apply immediately before frameOffset and are bounded to 64/block.
    std::uint32_t frameOffset = 0U;
    OctaveModelsControl control = OctaveModelsControl::Active;
    float value = 0.0f;
};

struct OctaveModelsLatency {
    // Dry, -1 octave and -2 octave timeline paths are aligned to two windows.
    // This is fixed mixed-path alignment, not earliest wet onset or E2E delay.
    std::uint32_t fixedMixedPathSamples = 0U;
};

// Clean-room selector wrapper for the published OCTAVE modes -1OCT, -2OCT,
// and -1OCT&-2OCT. This class is not yet registered by this module.
//
// All three phase-vocoder branches run continuously so mode events can switch
// at sample offsets without cold branch initialization. Prepare a fresh
// inactive object, budget requiredPrepareBytes() (and active+candidate peak in
// the host), then swap outside the callback. With no-exception builds the
// estimate is a preflight; allocator OOM cannot be recovered in-process.
class OctaveModelsFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const OctaveModelsOptions& options = {}) noexcept;
    [[nodiscard]] static std::size_t replacementPeakBytes(
        std::size_t activeBytes, const ProcessSpec& spec,
        const OctaveModelsOptions& options = {}) noexcept;

    bool prepare(const ProcessSpec& spec, const OctaveModelsOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const OctaveModelsEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] OctaveModelsLatency latency() const noexcept {
        return {prepared_ ? 2U * options_.voice.windowFrames : 0U};
    }
    [[nodiscard]] OctaveModelsMode targetMode() const noexcept { return modeTarget_; }

private:
    [[nodiscard]] static bool validOptions(const OctaveModelsOptions& options) noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames,
                                     const OctaveModelsEvent* events,
                                     std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const OctaveModelsEvent& event) const noexcept;
    void applyEvent(const OctaveModelsEvent& event) noexcept;
    void advanceControls() noexcept;

    ProcessSpec spec_{};
    OctaveModelsOptions options_{};
    std::array<OctaveFxProcessor, 3U> branches_{};
    std::vector<StereoFrame> oneOctaveScratch_;
    std::vector<StereoFrame> twoOctaveScratch_;
    std::vector<StereoFrame> dryHistory_;
    std::vector<StereoFrame> oneOctaveAlignment_;
    std::size_t ringMask_ = 0U;
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
    OctaveModelsMode modeTarget_ = OctaveModelsMode::DownOneOctave;
    bool hasExpectedFrame_ = false;
    bool branchControlsSent_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
