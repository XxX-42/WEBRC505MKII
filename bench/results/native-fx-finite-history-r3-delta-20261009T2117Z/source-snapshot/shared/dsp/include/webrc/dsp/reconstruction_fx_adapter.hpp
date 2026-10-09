#pragma once

#include "webrc/dsp/distortion_fx.hpp"
#include "webrc/dsp/octave_fx.hpp"
#include "webrc/dsp/preamp_fx.hpp"
#include "webrc/dsp/temporal_fx_adapters.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>
#include <variant>

namespace webrc::dsp {

// This adapter maps existing clean-room DSP processors to the catalog ordinals
// which are not yet part of the stable FxProcessor registry. These are local
// reconstruction controls: no Roland UI range or curve is inferred here.
constexpr std::uint32_t kReconstructionFxAdapterApiVersion = 1U;
constexpr std::uint32_t kReconstructionFxMaximumEventsPerBlock = 64U;

enum class ReconstructionFxControl : std::uint8_t {
    Active,
    Mix,
    DelayMs,
    Feedback,
    ToneHz,
    WowDepthMs,
    WowRateHz,
    Drive,
    GrainMs,
    DensityHz,
    PitchRatio,
    PositionSpread,
    Freeze,
    WarpAmount,
    ReverbTimeSeconds,
    DampingHz,
    TempoBpm,
    SubdivisionBeats,
    TwistMacro,
    OutputDb,
    BassDb,
    MidDb,
    TrebleDb,
    PresenceDb,
    Semitones,
};

struct ReconstructionFxEvent {
    std::uint32_t frameOffset = 0U;
    ReconstructionFxControl control = ReconstructionFxControl::Active;
    float value = 0.0f;
};

struct ReconstructionFxConfiguration {
    TemporalFxOptions temporal{};
    DistortionFxOptions distortion{};
    PreampFxOptions preamp{};
    // PREAMP requires a caller-supplied, validated cabinet response. The
    // adapter copies it during prepare and retains no pointers into this view.
    PreampCabinetIr cabinetIr{};
    OctaveFxOptions octave{};
    std::uint64_t randomSeed = 0x6a09e667f3bcc909ULL;
};

enum class ReconstructionFxLatencyKind : std::uint8_t {
    Fixed,
    FrequencyDependentGroupDelay,
    VariableDelay,
};

struct ReconstructionFxLatency {
    ReconstructionFxLatencyKind kind = ReconstructionFxLatencyKind::Fixed;
    std::int32_t fixedSamples = 0;
    std::uint32_t minimumWetDelaySamples = 0U;
    std::uint32_t maximumWetDelaySamples = 0U;
    double groupDelaySamples = 0.0;
};

[[nodiscard]] bool isReconstructionFxOrdinal(std::uint16_t ordinal) noexcept;
[[nodiscard]] bool reconstructionFxSupportsControl(
    std::uint16_t ordinal, ReconstructionFxControl control) noexcept;
[[nodiscard]] std::string_view reconstructionFxControlName(
    ReconstructionFxControl control) noexcept;

// In-place stereo adapter for the standalone temporal, distortion, preamp,
// and octave processors. Prepare only a fresh inactive adapter after admitting
// requiredPrepareBytes(); processBlock is bounded to the prepared maximum block
// and 64 ordered sample-offset events, with no allocation, lock, or I/O.
class ReconstructionFxAdapter final {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const ProcessSpec& spec, std::uint16_t ordinal,
        const ReconstructionFxConfiguration& config = {}) noexcept;

    bool prepare(const ProcessSpec& spec, std::uint16_t ordinal,
                 const ReconstructionFxConfiguration& config = {});
    void reset(std::uint64_t absoluteFrame = 0U) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, StereoFrame* interleaved,
                      std::uint32_t frames,
                      const ReconstructionFxEvent* events = nullptr,
                      std::uint32_t eventCount = 0U) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] std::uint16_t ordinal() const noexcept { return ordinal_; }
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] ReconstructionFxLatency latency() const noexcept;

private:
    using Processor = std::variant<TemporalFxAdapter, DistortionFxProcessor,
                                   PreampFxProcessor, OctaveFxProcessor>;

    [[nodiscard]] static bool mapTemporalKind(std::uint16_t ordinal,
                                              TemporalFxKind& kind) noexcept;
    [[nodiscard]] bool validateEvents(std::uint32_t frames,
                                      const ReconstructionFxEvent* events,
                                      std::uint32_t eventCount) const noexcept;

    Processor processor_{};
    std::uint16_t ordinal_ = 0U;
    std::size_t preparedBytes_ = 0U;
    bool prepared_ = false;
};

} // namespace webrc::dsp
