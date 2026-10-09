#pragma once

#include "webrc/dsp/primitives.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string_view>

namespace webrc::dsp {

// Ordinals and IDs are sourced from dsp/spec/fx_catalog.json.  Availability describes
// the documented RC-505mkII routing; processorAvailable describes this reconstruction.
enum class FxReadiness : std::uint8_t {
    MetadataOnly,
    ProcessorAvailable,
};

enum class FxParameterOrigin : std::uint8_t {
    ReconstructionSafeBounds,
};

struct FxDescriptor {
    std::uint16_t ordinal = 0;
    std::string_view id{};
    std::string_view displayName{};
    std::string_view family{};
    bool inputFx = false;
    bool trackFx = false;
    FxReadiness readiness = FxReadiness::MetadataOnly;
    bool officialParameterContractValidated = false;
};

constexpr std::size_t kFxCatalogSize = 53;
constexpr std::size_t kInputFxCount = 49;
constexpr std::size_t kTrackFxCount = 53;

[[nodiscard]] const FxDescriptor* fxCatalogData() noexcept;
[[nodiscard]] std::size_t fxCatalogSize() noexcept;
[[nodiscard]] const FxDescriptor* findFxByOrdinal(std::uint16_t ordinal) noexcept;
[[nodiscard]] const FxDescriptor* findFxById(std::string_view id) noexcept;

enum class FxParameterId : std::uint16_t {
    FrequencyHz = 1,
    Q = 2,
    Mix = 3,
    SmoothingMs = 4,
    RateHz = 5,
    Depth = 6,
    Feedback = 7,
    DelayMs = 8,
    ThresholdDb = 9,
    Ratio = 10,
    KneeDb = 11,
    AttackMs = 12,
    ReleaseMs = 13,
    RmsMix = 14,
    MakeupDb = 15,
    ReverbTimeSeconds = 16,
    DampingHz = 17,
    ModulationRateHz = 18,
    ModulationDepthMs = 19,
    MaximumFeedback = 20,
    Wet = 21,
    EqLowFrequencyHz = 32,
    EqLowGainDb = 33,
    EqLowSlope = 34,
    EqLowMidFrequencyHz = 35,
    EqLowMidGainDb = 36,
    EqLowMidQ = 37,
    EqHighMidFrequencyHz = 38,
    EqHighMidGainDb = 39,
    EqHighMidQ = 40,
    EqHighFrequencyHz = 41,
    EqHighGainDb = 42,
    EqHighSlope = 43,
};

struct FxParameterDescriptor {
    FxParameterId id = FxParameterId::FrequencyHz;
    std::string_view name{};
    std::string_view unit{};
    float minimum = 0.0f;
    float maximum = 0.0f;
    float defaultValue = 0.0f;
    FxParameterOrigin origin = FxParameterOrigin::ReconstructionSafeBounds;
};

[[nodiscard]] const FxParameterDescriptor* fxParameterDescriptors(
    std::uint16_t ordinal, std::size_t& count) noexcept;

struct FxParameterEvent {
    // Offset is relative to the current block and must be nondecreasing.
    std::uint32_t frameOffset = 0;
    FxParameterId parameter = FxParameterId::FrequencyHz;
    float value = 0.0f;
};

constexpr std::uint32_t kFxEventCapacity = 256;

class FxProcessor {
public:
    virtual ~FxProcessor() = default;
    FxProcessor(const FxProcessor&) = delete;
    FxProcessor& operator=(const FxProcessor&) = delete;

    // prepare/reset/create/destroy must be serialized while the processor is inactive.
    // After activation, every setter/process call belongs to one audio owner.  For
    // cross-thread controls, send bounded timestamped events to that owner and apply
    // them with processBlockWithEvents; this class takes no locks.
    [[nodiscard]] virtual std::uint16_t ordinal() const noexcept = 0;
    [[nodiscard]] virtual bool prepare(const ProcessSpec& spec) noexcept = 0;
    virtual void reset() noexcept = 0;
    [[nodiscard]] virtual bool validateBlockRequest(std::uint32_t channels,
                                                    std::uint32_t frames) const noexcept = 0;
    [[nodiscard]] virtual bool validParameter(FxParameterId id, float value) const noexcept = 0;
    [[nodiscard]] virtual bool setParameter(FxParameterId id, float value) noexcept = 0;
    [[nodiscard]] virtual bool processBlock(const float* const* inputPlanar,
                                             float* const* outputPlanar,
                                             std::uint32_t channels,
                                             std::uint32_t frames) noexcept = 0;

    [[nodiscard]] bool processBlockWithEvents(const float* const* inputPlanar,
                                              float* const* outputPlanar,
                                              std::uint32_t channels,
                                              std::uint32_t frames,
                                              const FxParameterEvent* events,
                                              std::uint32_t eventCount) noexcept;
    [[nodiscard]] virtual std::int32_t fixedLatencySamples() const noexcept = 0;
    [[nodiscard]] virtual bool latencyIsFrequencyDependent() const noexcept = 0;

protected:
    FxProcessor() = default;
};

// Factory allocation is intentionally outside the audio callback.  Metadata-only
// catalog entries return nullptr and remain explicitly unavailable as processors.
[[nodiscard]] std::unique_ptr<FxProcessor> createFxProcessor(std::uint16_t ordinal) noexcept;

} // namespace webrc::dsp
