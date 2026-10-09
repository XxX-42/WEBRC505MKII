#pragma once

#include "webrc/dsp/pitch.hpp"
#include "webrc/dsp/streaming_yin.hpp"

#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kLiveMonoPitchRouteApiVersion = 1;

struct LiveMonoPitchSettings {
    ProcessSpec spec{}; // mono input, fixed maximum callback size
    std::uint32_t analysisWindowFrames = 4096U;
    std::uint32_t analysisHopFrames = 512U;
    std::uint32_t analysisWorkUnitsPerCallback = 32768U;
    float minimumFrequencyHz = 40.0f;
    float maximumFrequencyHz = 1000.0f;
    float yinThreshold = 0.15f;
};

// F10 -> F11 streaming route: bounded incremental YIN detection feeds the
// fixed-ring TD-PSOLA renderer. The analysis window, observed detector lag and
// PSOLA lookahead are exposed separately; no device or graph latency is hidden.
// prepare/reset/setPitchRatio and processBlock are single-owner operations.
class LiveMonoPitchRoute {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const LiveMonoPitchSettings& settings) noexcept;
    bool prepare(const LiveMonoPitchSettings& settings);
    void reset() noexcept;
    bool setPitchRatio(float ratio) noexcept;
    bool processBlock(const float* monoInput, float* monoOutput,
                      std::uint32_t frames) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] float pitchRatio() const noexcept { return pitchRatio_; }
    [[nodiscard]] const PitchEstimate& latestEstimate() const noexcept {
        return detector_.latestEstimate();
    }
    [[nodiscard]] std::uint64_t analysisCount() const noexcept { return detector_.analysisCount(); }
    [[nodiscard]] std::uint64_t inputFrames() const noexcept { return detector_.totalInputFrames(); }
    [[nodiscard]] std::uint64_t estimateWindowEndFrame() const noexcept {
        return detector_.latestWindowEndFrame();
    }
    [[nodiscard]] std::uint32_t observedDetectorProcessingLagFrames() const noexcept {
        return detector_.latestProcessingLagFrames();
    }
    [[nodiscard]] std::uint32_t analysisWindowFrames() const noexcept {
        return settings_.analysisWindowFrames;
    }
    [[nodiscard]] std::uint32_t resynthesisLatencySamples() const noexcept {
        return shifter_.latencySamples();
    }
    [[nodiscard]] std::uint64_t declaredDetectorPlusResynthesisLatencySamples() const noexcept {
        return static_cast<std::uint64_t>(settings_.analysisWindowFrames) +
               shifter_.latencySamples();
    }
    [[nodiscard]] std::uint32_t latestEstimateAgeFrames() const noexcept;
    [[nodiscard]] std::uint32_t lastAnalysisWorkUnits() const noexcept {
        return detector_.lastWorkUnits();
    }
    [[nodiscard]] std::uint32_t analysisWorkBudgetPerCallback() const noexcept {
        return settings_.analysisWorkUnitsPerCallback;
    }

private:
    LiveMonoPitchSettings settings_{};
    IncrementalYinDetector detector_{};
    StreamingTdPsolaPitchShifter shifter_{};
    float pitchRatio_ = 1.0f;
    std::uint64_t forwardedAnalysisCount_ = 0U;
    bool prepared_ = false;
};

} // namespace webrc::dsp
