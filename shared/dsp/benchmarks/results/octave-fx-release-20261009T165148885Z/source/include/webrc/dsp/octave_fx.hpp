#pragma once

#include "webrc/dsp/pitch.hpp"
#include "webrc/dsp/primitives.hpp"

#include <array>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kOctaveFxApiVersion = 1U;

enum class OctaveFxControl : std::uint8_t {
    Active,
    Mix,
    Semitones,
};

struct OctaveFxOptions {
    // Defaults balance low-register frequency resolution and fixed latency.
    std::uint32_t windowFrames = 2048U;
    std::uint32_t hopFrames = 256U;
    float controlSmoothingMs = 10.0f;
};

struct OctaveFxEvent {
    // Applied immediately before frameOffset. Events are ordered and bounded
    // to 64 per callback.
    std::uint32_t frameOffset = 0U;
    OctaveFxControl control = OctaveFxControl::Active;
    float value = 0.0f;
};

struct OctaveFxLatency {
    // Dry and phase-vocoder wet signals share this fixed time-axis alignment.
    // Equal analysis/synthesis hops preserve duration. A transient may smear
    // into the earliest available analysis hop; this onset is separate from
    // the steady-state aligned delay. Transient phase locking is not implemented.
    std::uint32_t fixedAlgorithmicSamples = 0U;
};

// Standalone clean-room OCTAVE voice adapter. It is not registered in the FX
// graph by this module. Call requiredPrepareBytes() and admit active plus
// staged graph memory before preparing a fresh inactive instance. The audio
// callback uses only prepared FFT, phase, input-history, and overlap-add state.
class OctaveFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock = 64U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const OctaveFxOptions& options = {}) noexcept;
    bool prepare(const ProcessSpec& spec, const OctaveFxOptions& options = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const OctaveFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] OctaveFxLatency latency() const noexcept {
        return {prepared_ ? options_.windowFrames : 0U};
    }
    [[nodiscard]] float targetSemitones() const noexcept { return semitonesTarget_; }
    [[nodiscard]] float currentPitchRatio() const noexcept { return pitchRatioCurrent_; }

private:
    [[nodiscard]] static bool validOptions(const OctaveFxOptions& options) noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames, const OctaveFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validateEvent(const OctaveFxEvent& event) const noexcept;
    void applyEvent(const OctaveFxEvent& event) noexcept;
    void advanceControls() noexcept;
    void analyzeFrame(std::int64_t frameStart) noexcept;
    [[nodiscard]] StereoFrame readDry(std::uint64_t elapsedFrame) const noexcept;

    ProcessSpec spec_{};
    OctaveFxOptions options_{};
    std::array<PhaseVocoder, 2U> phaseVocoder_{};
    std::array<std::vector<std::complex<float>>, 2U> fftInput_{};
    std::array<std::vector<std::complex<float>>, 2U> fftOutput_{};
    std::array<std::vector<double>, 2U> overlap_{};
    std::vector<double> overlapWeight_;
    std::vector<StereoFrame> inputHistory_;
    std::vector<float> window_;
    std::size_t ringMask_ = 0U;
    std::uint64_t expectedAbsoluteFrame_ = 0U;
    std::uint64_t elapsedFrame_ = 0U;
    std::int64_t nextAnalysisStart_ = 0;
    std::size_t preparedBytes_ = 0U;
    double controlSmoothingCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 0.5f;
    float mixCurrent_ = 0.5f;
    float semitonesTarget_ = 12.0f;
    float pitchRatioTarget_ = 2.0f;
    float pitchRatioCurrent_ = 2.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
