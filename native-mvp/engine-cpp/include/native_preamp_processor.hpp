#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstdint>
#include <string_view>

namespace webrc::native {

// Clean-room model of a small family of guitar/bass preamps. It is not an
// emulation of any proprietary device or circuit. Four cascaded triode-like
// stages use first-order antiderivative anti-aliasing at 4x between linear-phase
// interpolation/reconstruction filters. A stateful three-band tone stack and
// generated, finite 129-tap cabinet IR follow. The FIRs contribute 88 fixed
// frames of algorithmic latency. The opt-in official interface adds nine
// authored amp styles and independently adjustable speaker/microphone profiles
// without changing the legacy five-model control or default render path.
struct NativePreampConfig {
    // Clean, Tweed, Stack, Lead, Bass.
    float model = 0.0f;
    float gainPercent = 35.0f;
    float bassDb = 0.0f;
    float middleDb = 0.0f;
    float trebleDb = 0.0f;
    float levelDb = 0.0f;
};

class NativePreampProcessor final {
public:
    // Supports sample rates from 8 kHz through 192 kHz inclusive.
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativePreampConfig& config, std::uint64_t rampFrames = 64U) noexcept;
    void reset() noexcept;

    // Exact manual domains. First valid write enables the additive authored
    // nine-amp/speaker/mic path; legacy configuration/rendering stays intact.
    [[nodiscard]] bool setOfficialParameter(std::string_view key, float value) noexcept;
    [[nodiscard]] bool officialControlsActive() const noexcept { return officialActive_; }

    // Processes the first one or two interleaved channels in-place. Additional
    // channels pass through unchanged. No allocations or locks occur here.
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] unsigned int latencyFrames() const noexcept { return kLatencyFrames; }
    [[nodiscard]] const NativePreampConfig& config() const noexcept { return config_; }

private:
    static constexpr unsigned int kOversampling = 4U;
    static constexpr unsigned int kFirTaps = 97U;
    static constexpr unsigned int kCabinetIrTaps = 129U;
    static constexpr unsigned int kPolyphaseTaps = (kFirTaps + kOversampling - 1U) / kOversampling;
    static constexpr unsigned int kOversamplerLatencyFrames =
        2U * ((kFirTaps - 1U) / (2U * kOversampling));
    static constexpr unsigned int kCabinetIrLatencyFrames = (kCabinetIrTaps - 1U) / 2U;
    static constexpr unsigned int kLatencyFrames = kOversamplerLatencyFrames + kCabinetIrLatencyFrames;
    static constexpr unsigned int kModelCount = 5U;
    static constexpr unsigned int kNonlinearStageCount = 4U;

    struct ChannelState {
        std::array<float, kPolyphaseTaps> inputHistory{};
        std::array<float, kFirTaps> reconstructionHistory{};
        std::array<float, kCabinetIrTaps> cabinetHistory{};
        std::array<float, kNonlinearStageCount> previousStageInput{};
        std::array<float, kNonlinearStageCount> previousAntiderivative{};
        std::array<bool, kNonlinearStageCount> antiderivativeValid{};
        unsigned int inputWrite = 0U;
        unsigned int reconstructionWrite = 0U;
        unsigned int cabinetWrite = 0U;
        float toneLowState = 0.0f;
        float toneUpperState = 0.0f;
        float cabinetHighPassState = 0.0f;
        std::array<dsp::Biquad, 4U> officialTone{};
        // The official cabinet is causal rather than linear phase. Preserve
        // the established 88-frame pure latency with an explicit 64-frame pad.
        std::array<float, kCabinetIrLatencyFrames> officialLatencyHistory{};
        unsigned int officialLatencyWrite = 0U;
    };

    struct StageFrameParameters {
        float slope = 0.0f;
        float bias = 0.0f;
        float biasArgument = 0.0f;
        float biasTanh = 0.0f;
        float biasLogCosh = 0.0f;
    };

    struct FrameParameters {
        std::array<StageFrameParameters, kNonlinearStageCount> stages{};
        std::array<float, kCabinetIrTaps> cabinetCoefficients{};
        float commonStageGain = 1.0f;
        float bassGain = 1.0f;
        float middleGain = 1.0f;
        float trebleGain = 1.0f;
        float lowModelGain = 1.0f;
        float middleModelGain = 1.0f;
        float highModelGain = 1.0f;
        float levelGain = 1.0f;
        unsigned int lowerModel = 0U;
        unsigned int upperModel = 0U;
        float modelFraction = 0.0f;
        bool officialProfile = false;
        float officialBlend = 1.0f;
        float officialDynamicGain = 1.0f;
    };

    [[nodiscard]] FrameParameters makeFrameParameters(
        float modelPosition,
        float gainPercent,
        float bassGain,
        float middleGain,
        float trebleGain,
        float levelGain
    ) const noexcept;

    [[nodiscard]] float processSample(
        unsigned int channel,
        float input,
        const FrameParameters& parameters
    ) noexcept;
    [[nodiscard]] float interpolate(unsigned int channel, unsigned int phase) const noexcept;
    [[nodiscard]] float reconstruct(unsigned int channel, float sample, bool computeOutput) noexcept;
    [[nodiscard]] float processOfficialInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;
    void updateOfficialParameters(bool cabinetChanged) noexcept;
    void designFilters() noexcept;
    void designCabinetImpulseResponses() noexcept;
    void clearChannelState() noexcept;

    // Exact-value cache: smoothing still advances every sample.
    FrameParameters cachedFrameParameters_{};
    std::array<float, 6U> cachedControls_{};
    bool frameParametersValid_ = false;
    bool rightChannelPristineZero_ = true;
    NativePreampConfig config_{};
    bool officialActive_ = false;
    std::array<float, 12U> officialControls_{};
    FrameParameters officialFrameParameters_{};
    dsp::ParameterSmoother officialGain_{50.0f};
    dsp::ParameterSmoother officialCompression_{0.0f};
    dsp::ParameterSmoother officialLevel_{0.5f};
    float officialEnvelope_ = 0.0f;
    float officialAttackCoefficient_ = 0.0f;
    float officialReleaseCoefficient_ = 0.0f;
    std::array<float, kFirTaps> interpolationTaps_{};
    std::array<float, kFirTaps> reconstructionTaps_{};
    std::array<std::array<float, kCabinetIrTaps>, kModelCount> cabinetImpulseResponses_{};
    std::array<ChannelState, 2U> channels_{};
    dsp::ParameterSmoother modelPosition_{0.0f};
    dsp::ParameterSmoother gainPercent_{35.0f};
    dsp::ParameterSmoother bassGain_{1.0f};
    dsp::ParameterSmoother middleGain_{1.0f};
    dsp::ParameterSmoother trebleGain_{1.0f};
    dsp::ParameterSmoother levelGain_{1.0f};
    float toneLowCoefficient_ = 0.0f;
    float toneUpperCoefficient_ = 0.0f;
    float cabinetHighPassCoefficient_ = 0.0f;
    unsigned int sampleRate_ = 0U;
};

} // namespace webrc::native
