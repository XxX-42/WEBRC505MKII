#pragma once

#include "webrc/dsp/fx_registry.hpp"
#include "webrc/dsp/live_mono_pitch.hpp"
#include "webrc/dsp/signalsmith_adapter.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>

namespace webrc::dsp {

constexpr std::uint32_t kPitchFxAdapterApiVersion = 1U;

// Values are stable for the shared Native/WASM factory. They are local
// reconstruction backend choices, separate from the official UI selectors.
enum class PitchFxProfile : std::uint8_t {
    LiveMono = 0U,
    LivePoly = 1U,
    HqRender = 2U,
};

struct PitchFxLatencyReport {
    PitchFxProfile profile = PitchFxProfile::LiveMono;
    // LIVE_MONO component values; this declared startup bound is not measured
    // end-to-end latency. Left/right detector and resynthesis state is separate.
    std::uint32_t detectorWindowFrames = 0U;
    std::uint32_t detectorHopFrames = 0U;
    std::uint32_t psolaLookaheadFrames = 0U;
    // Pinned Signalsmith getters are reported separately. They are not a
    // measured dry/wet alignment or end-to-end latency.
    std::int32_t signalsmithInputFrames = 0;
    std::int32_t signalsmithOutputFrames = 0;
    // The adapter tapers the wet engine's unaligned streaming output to zero
    // at unity and smoothly engages it over the nearest quarter semitone.
    // For non-unity pitch, its dry/wet mix is a parallel effect blend; no
    // fixed dry/wet sample alignment has been measured or promised.
    bool unityWetUsesBitExactInput = true;
    bool nonUnityDryWetAlignmentMeasured = false;
    std::uint32_t startupWarmupUpperBoundFrames = 0U;
};

// Shared reconstruction processors for the canonical catalog identities:
// ordinal 14 TRANSPOSE, 15 PITCH BEND, and 18 HRM MANUAL. TRANSPOSE applies a
// constant semitone ratio with optional Signalsmith formant compensation;
// PITCH BEND smooths a changing semitone target; HRM MANUAL renders up to two
// fixed-interval voices with independent formant and stereo-pan controls.
// Runtime controls are reconstruction-safe bounds, not claimed official UI
// mappings or a clone of proprietary processing.
class PitchFxAdapter final : public FxProcessor {
public:
    explicit PitchFxAdapter(std::uint16_t ordinal) noexcept;
    ~PitchFxAdapter() override;

    [[nodiscard]] static std::size_t requiredPreparedStateBytes(
        std::uint16_t ordinal, const ProcessSpec& spec,
        PitchFxProfile profile) noexcept;
    [[nodiscard]] static std::size_t maximumPreparedStateBytes(
        std::uint16_t ordinal, const ProcessSpec& spec) noexcept;
    [[nodiscard]] static std::uint32_t startupWarmupUpperBoundFrames(
        std::uint16_t ordinal, const ProcessSpec& spec,
        PitchFxProfile profile) noexcept;
    [[nodiscard]] static std::uint32_t maximumStartupWarmupUpperBoundFrames(
        std::uint16_t ordinal, const ProcessSpec& spec) noexcept;

    [[nodiscard]] std::uint16_t ordinal() const noexcept override { return ordinal_; }
    [[nodiscard]] bool prepare(const ProcessSpec& spec) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] bool validateBlockRequest(std::uint32_t channels,
                                             std::uint32_t frames) const noexcept override;
    [[nodiscard]] bool validParameter(FxParameterId id, float value) const noexcept override;
    [[nodiscard]] bool isPrepareTimeParameter(FxParameterId id) const noexcept override;
    [[nodiscard]] bool setParameter(FxParameterId id, float value) noexcept override;
    [[nodiscard]] bool processBlock(const float* const* inputPlanar,
                                    float* const* outputPlanar,
                                    std::uint32_t channels,
                                    std::uint32_t frames) noexcept override;
    [[nodiscard]] std::uint32_t maximumParameterEventsPerBlock() const noexcept override {
        return 64U;
    }
    [[nodiscard]] bool validateParameterEvents(const FxParameterEvent* events,
                                               std::uint32_t eventCount) const noexcept override;
    [[nodiscard]] std::int32_t fixedLatencySamples() const noexcept override { return -1; }
    [[nodiscard]] std::uint32_t startupWarmupFrames() const noexcept override;
    [[nodiscard]] bool latencyIsFrequencyDependent() const noexcept override { return false; }

    [[nodiscard]] PitchFxProfile profile() const noexcept { return profile_; }
    [[nodiscard]] PitchFxLatencyReport latencyReport() const noexcept;

private:
    struct PreparedState;

    [[nodiscard]] bool prepareState(const ProcessSpec& spec,
                                    std::unique_ptr<PreparedState>& candidate) noexcept;
    [[nodiscard]] bool processSinglePitch(const float* const* input,
                                          float* const* output,
                                          std::uint32_t frames) noexcept;
    [[nodiscard]] bool processHarmony(const float* const* input,
                                      std::uint32_t frames) noexcept;
    [[nodiscard]] bool retargetPitch(float semitones) noexcept;
    [[nodiscard]] bool retargetHarmonyVoice(std::uint32_t voice,
                                            float semitones,
                                            float formantFactor) noexcept;
    void applyCurrentPitchRatio() noexcept;
    void applyHarmonyPanMix(const float* const* input,
                            float* const* output,
                            std::uint32_t frames) noexcept;

    const std::uint16_t ordinal_;
    std::unique_ptr<PreparedState> state_;
    ProcessSpec spec_{};
    PitchFxProfile profile_ = PitchFxProfile::LiveMono;
    float semitones_ = 0.0f;
    float bendTargetSemitones_ = 0.0f;
    float bendCurrentSemitones_ = 0.0f;
    float bendSmoothingMs_ = 40.0f;
    std::uint32_t bendRampRemaining_ = 0U;
    float formantFactor_ = 1.0f;
    bool formantCompensation_ = false;
    std::uint32_t harmonyVoiceCount_ = 2U;
    std::array<float, 2> harmonySemitones_{{4.0f, 7.0f}};
    std::array<float, 2> harmonyFormant_{{1.0f, 1.0f}};
    std::array<float, 2> harmonyPan_{{-0.25f, 0.25f}};
    float wet_ = 1.0f;
    float wetTarget_ = 0.0f;
    float wetCurrent_ = 0.0f;
    std::uint32_t wetRampRemaining_ = 0U;
    bool active_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
