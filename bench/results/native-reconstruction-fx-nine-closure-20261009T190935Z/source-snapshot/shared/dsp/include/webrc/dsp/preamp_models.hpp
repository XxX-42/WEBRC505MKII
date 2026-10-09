#pragma once

#include "webrc/dsp/preamp_fx.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kPreampModelsApiVersion = 1U;

// Selector order follows the reviewed RC-505mkII Parameter Guide page 38.
// The values below identify the published choices; the signal models are
// explicitly clean-room reconstructions and do not claim Roland equivalence.
enum class PreampAmpModel : std::uint8_t {
    JC120,
    NaturalClean,
    FullRange,
    ComboCrunch,
    StackCrunch,
    HighGainStack,
    PowerDrive,
    ExtremLead,
    CoreMetal,
};

enum class PreampSpeakerModel : std::uint8_t {
    Off,
    Original,
    OneByEight,
    OneByTen,
    OneByTwelve,
    TwoByTwelve,
    FourByTen,
    FourByTwelve,
    EightByTwelve,
};

enum class PreampMicModel : std::uint8_t {
    Dyn57,
    Dyn421,
    Cnd451,
    Cnd87,
    Flat,
};

// OFF MIC / ON MIC are published as choices. Their far / near placement meaning
// is inferred from other Roland product manuals; this implementation models
// distance while retaining the selected mic response in both positions.
enum class PreampMicDistance : std::uint8_t {
    OffMic,
    OnMic,
};

struct PreampModelOptions {
    PreampAmpModel ampType = PreampAmpModel::ComboCrunch;
    PreampSpeakerModel speakerType = PreampSpeakerModel::Original;
    PreampMicModel micType = PreampMicModel::Dyn57;
    PreampMicDistance micDistance = PreampMicDistance::OffMic;
    // 0 means CENTER; 1..10 are the printed centimetre selections. This is
    // stored separately from the published domain because its intermediate
    // selector enumeration has not been promoted to an official fact.
    std::uint8_t micPositionCm = 0U;
    std::uint32_t cabinetPartitionFrames = 64U;
    float controlSmoothingMs = 10.0f;
    float toneCoefficientSmoothingMs = 8.0f;
};

struct PreampModelLatency {
    // Fixed processing path used to align the wrapper's dry path with the core.
    std::uint32_t fixedMixedPathSamples = 0U;
    std::uint32_t speakerConvolverPartitionSamples = 0U;
    std::uint32_t generatedSpeakerIrFrames = 0U;
    // Extra wet-only microphone placement delay. This is a local model choice,
    // not an asserted end-to-end device latency or the full mic phase response.
    std::uint32_t micDirectDelaySamples = 0U;
    std::uint32_t micReflectionDelaySamples = 0U;
};

// PREAMP selector adapter over the separately implemented PREAMP nonlinear,
// tone, and partitioned-convolution core. Selector resources are generated
// during prepare() only. Build a fresh inactive instance, admit active plus
// candidate bytes, prepare it off the audio thread, then swap it in the host.
// processBlock accepts the core's ordered control events and performs no
// allocation, locking, file I/O, or selector resource generation.
class PreampModelFxProcessor final {
public:
    static constexpr std::uint32_t kMaximumControlEventsPerBlock =
        PreampFxProcessor::kMaximumControlEventsPerBlock;
    static constexpr std::uint32_t kMaximumModelIrFrames = 4096U;
    static constexpr std::uint32_t kMaximumBlockFrames = 8192U;
    static constexpr std::uint32_t kMaximumFixedDelaySamples = 2048U + 22U;
    static constexpr std::uint32_t kMaximumMicDistanceRingSamples = 1024U;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, const PreampModelOptions& options) noexcept;
    // Includes active instance plus candidate instance for safe off-thread
    // staging. The returned value is zero for invalid options/specs/overflow.
    [[nodiscard]] static std::size_t replacementPeakBytes(
        std::size_t activePreparedBytes, const ProcessSpec& spec,
        const PreampModelOptions& options) noexcept;

    bool prepare(const ProcessSpec& spec, const PreampModelOptions& options);
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames, const PreampFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] PreampModelLatency latency() const noexcept;
    [[nodiscard]] static constexpr std::uint16_t effectOrdinal() noexcept { return 23U; }
    [[nodiscard]] static constexpr const char* reconstructionBoundary() noexcept {
        return "Published selectors only; clean-room models are not Roland tone clones.";
    }

private:
    struct DiodeProfile {
        double portResistance;
        double saturationCurrent;
        double thermalVoltage;
        double ideality;
    };

    [[nodiscard]] static bool validOptions(const PreampModelOptions& options) noexcept;
    [[nodiscard]] static bool validEvents(std::uint32_t frames,
        const PreampFxEvent* events, std::uint32_t eventCount) noexcept;
    [[nodiscard]] static std::uint32_t generatedIrFrames(
        const ProcessSpec& spec, PreampSpeakerModel speaker) noexcept;
    [[nodiscard]] static DiodeProfile diodeProfile(PreampAmpModel model) noexcept;
    void generateSpeakerIr(const ProcessSpec& spec,
                           PreampSpeakerModel speaker) noexcept;
    bool prepareAmpFilters(const ProcessSpec& spec,
                           PreampAmpModel amp) noexcept;
    bool prepareMicFilters(const ProcessSpec& spec,
                           const PreampModelOptions& options) noexcept;
    [[nodiscard]] StereoFrame processMicAndDistance(StereoFrame wet) noexcept;
    void applyUserEvent(const PreampFxEvent& event) noexcept;
    void advanceMixControls() noexcept;

    ProcessSpec spec_{};
    PreampModelOptions options_{};
    PreampFxProcessor core_{};
    std::array<std::array<float, kMaximumModelIrFrames>, 2U> speakerIr_{};
    std::array<std::array<BiquadDf2T, 3U>, 2U> ampFilters_{};
    std::array<std::array<BiquadDf2T, 4U>, 2U> micFilters_{};
    std::array<std::array<float, kMaximumMicDistanceRingSamples>, 2U> micDelay_{};
    std::array<std::array<float, kMaximumFixedDelaySamples>, 2U> dryDelay_{};
    std::array<std::vector<float>, 2U> dryAlignedBlock_{};
    std::array<std::uint32_t, 2U> micDelaySamples_{};
    std::array<std::uint32_t, 2U> micReflectionDelaySamples_{};
    std::uint32_t speakerIrFrames_ = 0U;
    std::uint32_t fixedDelaySamples_ = 0U;
    std::uint32_t dryWritePosition_ = 0U;
    std::uint32_t micWritePosition_ = 0U;
    std::uint64_t expectedFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    double mixSmoothingCoefficient_ = 0.0;
    float activeTarget_ = 0.0f;
    float activeCurrent_ = 0.0f;
    float mixTarget_ = 1.0f;
    float mixCurrent_ = 1.0f;
    bool hasExpectedFrame_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
