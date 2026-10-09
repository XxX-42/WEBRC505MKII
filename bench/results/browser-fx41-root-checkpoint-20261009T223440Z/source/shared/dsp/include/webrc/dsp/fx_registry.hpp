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

enum class FxLatencyModel : std::uint8_t {
    Fixed,
    FrequencyDependentGroupDelay,
    VariableDelay,
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

struct FxMemoryRequirement {
    std::uint64_t objectBytes = 0;
    // Retained heap storage once prepared; excludes the C++ object itself.
    std::uint64_t persistentPreparedBytes = 0;
    // Temporary candidate storage needed while a prepared instance is replaced.
    std::uint64_t prepareScratchBytes = 0;
    bool supported = false;

    [[nodiscard]] std::uint64_t peakBytes() const noexcept {
        return objectBytes + persistentPreparedBytes + prepareScratchBytes;
    }
};

// Startup history/window bound is separate from algorithmic/fixed latency.
// `supported` distinguishes an unknown/unavailable processor from a processor
// whose output needs no startup-history wait (frames == 0).
struct FxStartupWarmupRequirement {
    std::uint32_t frames = 0U;
    bool supported = false;
};

struct FxAlignmentRequirement {
    std::uint32_t frames = 0U;
    bool supported = false;
};

[[nodiscard]] FxMemoryRequirement fxMemoryRequirement(std::uint16_t ordinal,
                                                       const ProcessSpec& spec) noexcept;
[[nodiscard]] FxStartupWarmupRequirement fxStartupWarmupUpperBoundSamples(
    std::uint16_t ordinal, const ProcessSpec& spec) noexcept;
// Static upper bound for dry-alignment storage. This is intentionally separate
// from startup history/window warmup and from measured end-to-end latency.
[[nodiscard]] FxAlignmentRequirement fxAlignmentUpperBoundSamples(
    std::uint16_t ordinal, const ProcessSpec& spec) noexcept;

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
    Active = 48,
    TempoBpm = 49,
    SubdivisionBeats = 50,
    ScatterAmount = 52,
    PitchRatio = 53,
    ShiftBeats = 54,
    FlickImpulse = 55,
    Pan = 56,
    BitDepth = 57,
    HoldFrames = 58,
    Dither = 59,
    Waveform = 60,
    Drive = 61,
    RadioHighPassHz = 62,
    RadioLowPassHz = 63,
    BitMix = 64,
    EdgeMilliseconds = 65,
    PatternId = 66,
    LowGainDb = 67,
    MidGainDb = 68,
    HighGainDb = 69,
    LowMute = 70,
    MidMute = 71,
    HighMute = 72,
    GateThresholdDb = 73,
    GateHoldMs = 74,
    GateReleaseMs = 75,
    SlowGearAttackMs = 76,
    SlowGearReleaseMs = 77,
    Sensitivity = 78,
    StereoHighWidth = 79,
    StereoLowWidth = 80,
    CrossFeedback = 81,
    AmpModel = 82,
    SpeakerModel = 83,
    MicModel = 84,
    MicDistance = 85,
    MicPositionCm = 86,
    BassDb = 87,
    MidDb = 88,
    TrebleDb = 89,
    PresenceDb = 90,
    OutputDb = 91,
    ToneHz = 92,
    Semitones = 93,
    GrainMs = 94,
    DensityHz = 95,
    PositionSpread = 96,
    Freeze = 97,
    WarpAmount = 98,
    WowDepthMs = 99,
    WowRateHz = 100,
    TwistMacro = 101,
    OctaveMode = 102,
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
    // Prepare-time selectors are changed only on a fresh inactive candidate,
    // before prepare() allocates model-dependent resources.
    [[nodiscard]] virtual bool isPrepareTimeParameter(FxParameterId) const noexcept {
        return false;
    }
    [[nodiscard]] virtual bool setParameter(FxParameterId id, float value) noexcept = 0;
    [[nodiscard]] virtual bool processBlock(const float* const* inputPlanar,
                                             float* const* outputPlanar,
                                             std::uint32_t channels,
                                             std::uint32_t frames) noexcept = 0;
    [[nodiscard]] virtual std::uint32_t maximumParameterEventsPerBlock() const noexcept {
        return kFxEventCapacity;
    }
    // Adapters with already queued direct setters can reserve room before the
    // block is split, preserving all-or-nothing event-list validation.
    [[nodiscard]] virtual bool canAcceptParameterEvents(std::uint32_t eventCount) const noexcept {
        return eventCount <= maximumParameterEventsPerBlock();
    }
    [[nodiscard]] virtual bool validateParameterEvents(const FxParameterEvent* events,
                                                       std::uint32_t eventCount) const noexcept {
        if (eventCount != 0U && events == nullptr) return false;
        for (std::uint32_t i = 0U; i < eventCount; ++i)
            if (!validParameter(events[i].parameter, events[i].value)) return false;
        return true;
    }

    [[nodiscard]] bool processBlockWithEvents(const float* const* inputPlanar,
                                              float* const* outputPlanar,
                                              std::uint32_t channels,
                                              std::uint32_t frames,
                                              const FxParameterEvent* events,
                                              std::uint32_t eventCount) noexcept;
    [[nodiscard]] virtual std::int32_t fixedLatencySamples() const noexcept = 0;
    // Prepared-state finite input-history/window bound before a candidate may
    // be exposed in a transition. This is not algorithmic latency. Zero means
    // that this adapter has no finite startup-history bound to report; it does
    // not claim recursive filter/reverb state or a level-dependent envelope is
    // fully settled. Reverb decay and IIR settling remain separate policies.
    [[nodiscard]] virtual std::uint32_t startupWarmupFrames() const noexcept {
        return 0U;
    }
    [[nodiscard]] virtual bool latencyIsFrequencyDependent() const noexcept = 0;
    [[nodiscard]] bool latencyIsVariable() const noexcept { return fixedLatencySamples() < 0; }
    [[nodiscard]] FxLatencyModel latencyModel() const noexcept {
        if (latencyIsVariable()) return FxLatencyModel::VariableDelay;
        return latencyIsFrequencyDependent() ? FxLatencyModel::FrequencyDependentGroupDelay
                                             : FxLatencyModel::Fixed;
    }

protected:
    FxProcessor() = default;
};

// Factory allocation is intentionally outside the audio callback.  Metadata-only
// catalog entries return nullptr and remain explicitly unavailable as processors.
[[nodiscard]] std::unique_ptr<FxProcessor> createFxProcessor(std::uint16_t ordinal) noexcept;

} // namespace webrc::dsp
