#include "webrc/dsp/reconstruction_fx_adapter.hpp"

#include <cmath>
#include <limits>
#include <type_traits>
#include <utility>

namespace webrc::dsp {
namespace {

[[nodiscard]] std::size_t wrapMemoryRequirement(std::size_t childBytes,
                                                std::size_t childObjectBytes) noexcept {
    if (childBytes == 0U || childBytes < childObjectBytes) return 0U;
    const auto dynamicBytes = childBytes - childObjectBytes;
    if (dynamicBytes > std::numeric_limits<std::size_t>::max() -
                           sizeof(ReconstructionFxAdapter)) return 0U;
    return sizeof(ReconstructionFxAdapter) + dynamicBytes;
}

[[nodiscard]] bool validCabinetIrForPreflight(const PreampCabinetIr& ir) noexcept {
    if (ir.frames == 0U || ir.frames > PreampFxProcessor::kMaximumCabinetIrFrames ||
        ir.left == nullptr) return false;
    const auto* right = ir.right == nullptr ? ir.left : ir.right;
    double leftEnergy = 0.0;
    double rightEnergy = 0.0;
    double leftL1 = 0.0;
    double rightL1 = 0.0;
    for (std::uint32_t i = 0U; i < ir.frames; ++i) {
        const float left = ir.left[i];
        const float r = right[i];
        if (!std::isfinite(left) || !std::isfinite(r) || std::fabs(left) > 8.0f ||
            std::fabs(r) > 8.0f) return false;
        leftEnergy += static_cast<double>(left) * left;
        rightEnergy += static_cast<double>(r) * r;
        leftL1 += std::fabs(static_cast<double>(left));
        rightL1 += std::fabs(static_cast<double>(r));
    }
    return leftEnergy > 1.0e-20 && rightEnergy > 1.0e-20 &&
           leftL1 <= PreampFxProcessor::kMaximumCabinetIrL1 &&
           rightL1 <= PreampFxProcessor::kMaximumCabinetIrL1;
}

[[nodiscard]] bool mapTemporalControl(ReconstructionFxControl input,
                                      TemporalFxControl& output) noexcept {
    switch (input) {
    case ReconstructionFxControl::Active: output = TemporalFxControl::Active; return true;
    case ReconstructionFxControl::Mix: output = TemporalFxControl::Wet; return true;
    case ReconstructionFxControl::DelayMs: output = TemporalFxControl::DelayMs; return true;
    case ReconstructionFxControl::Feedback: output = TemporalFxControl::Feedback; return true;
    case ReconstructionFxControl::ToneHz: output = TemporalFxControl::ToneHz; return true;
    case ReconstructionFxControl::WowDepthMs: output = TemporalFxControl::WowDepthMs; return true;
    case ReconstructionFxControl::WowRateHz: output = TemporalFxControl::WowRateHz; return true;
    case ReconstructionFxControl::Drive: output = TemporalFxControl::Drive; return true;
    case ReconstructionFxControl::GrainMs: output = TemporalFxControl::GrainMs; return true;
    case ReconstructionFxControl::DensityHz: output = TemporalFxControl::DensityHz; return true;
    case ReconstructionFxControl::PitchRatio: output = TemporalFxControl::PitchRatio; return true;
    case ReconstructionFxControl::PositionSpread: output = TemporalFxControl::PositionSpread; return true;
    case ReconstructionFxControl::Freeze: output = TemporalFxControl::Freeze; return true;
    case ReconstructionFxControl::WarpAmount: output = TemporalFxControl::WarpAmount; return true;
    case ReconstructionFxControl::ReverbTimeSeconds:
        output = TemporalFxControl::ReverbTimeSeconds; return true;
    case ReconstructionFxControl::DampingHz: output = TemporalFxControl::DampingHz; return true;
    case ReconstructionFxControl::TempoBpm: output = TemporalFxControl::TempoBpm; return true;
    case ReconstructionFxControl::SubdivisionBeats:
        output = TemporalFxControl::SubdivisionBeats; return true;
    case ReconstructionFxControl::TwistMacro: output = TemporalFxControl::TwistMacro; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapDistortionControl(ReconstructionFxControl input,
                                        DistortionFxControl& output) noexcept {
    switch (input) {
    case ReconstructionFxControl::Active: output = DistortionFxControl::Active; return true;
    case ReconstructionFxControl::Mix: output = DistortionFxControl::Mix; return true;
    case ReconstructionFxControl::Drive: output = DistortionFxControl::Drive; return true;
    case ReconstructionFxControl::ToneHz: output = DistortionFxControl::ToneHz; return true;
    case ReconstructionFxControl::OutputDb: output = DistortionFxControl::OutputDb; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapPreampControl(ReconstructionFxControl input,
                                    PreampFxControl& output) noexcept {
    switch (input) {
    case ReconstructionFxControl::Active: output = PreampFxControl::Active; return true;
    case ReconstructionFxControl::Mix: output = PreampFxControl::Mix; return true;
    case ReconstructionFxControl::Drive: output = PreampFxControl::Drive; return true;
    case ReconstructionFxControl::BassDb: output = PreampFxControl::BassDb; return true;
    case ReconstructionFxControl::MidDb: output = PreampFxControl::MidDb; return true;
    case ReconstructionFxControl::TrebleDb: output = PreampFxControl::TrebleDb; return true;
    case ReconstructionFxControl::PresenceDb: output = PreampFxControl::PresenceDb; return true;
    case ReconstructionFxControl::OutputDb: output = PreampFxControl::OutputDb; return true;
    default: return false;
    }
}

[[nodiscard]] bool mapOctaveControl(ReconstructionFxControl input,
                                    OctaveFxControl& output) noexcept {
    switch (input) {
    case ReconstructionFxControl::Active: output = OctaveFxControl::Active; return true;
    case ReconstructionFxControl::Mix: output = OctaveFxControl::Mix; return true;
    case ReconstructionFxControl::Semitones: output = OctaveFxControl::Semitones; return true;
    default: return false;
    }
}

} // namespace

bool isReconstructionFxOrdinal(std::uint16_t ordinal) noexcept {
    return ordinal == 23U || ordinal == 24U || ordinal == 28U ||
           (ordinal >= 40U && ordinal <= 45U);
}

bool reconstructionFxSupportsControl(std::uint16_t ordinal,
                                     ReconstructionFxControl control) noexcept {
    if (!isReconstructionFxOrdinal(ordinal)) return false;
    if (control == ReconstructionFxControl::Active || control == ReconstructionFxControl::Mix)
        return true;
    if (ordinal == 40U) {
        return control == ReconstructionFxControl::DelayMs ||
            control == ReconstructionFxControl::Feedback ||
            control == ReconstructionFxControl::ToneHz ||
            control == ReconstructionFxControl::WowDepthMs ||
            control == ReconstructionFxControl::WowRateHz ||
            control == ReconstructionFxControl::Drive;
    }
    if (ordinal == 41U) {
        return control == ReconstructionFxControl::Feedback ||
            control == ReconstructionFxControl::GrainMs ||
            control == ReconstructionFxControl::DensityHz ||
            control == ReconstructionFxControl::PitchRatio ||
            control == ReconstructionFxControl::PositionSpread;
    }
    if (ordinal == 42U) {
        return control == ReconstructionFxControl::Freeze ||
            control == ReconstructionFxControl::WarpAmount ||
            control == ReconstructionFxControl::ReverbTimeSeconds ||
            control == ReconstructionFxControl::DampingHz;
    }
    if (ordinal == 43U) {
        return control == ReconstructionFxControl::DelayMs ||
            control == ReconstructionFxControl::TwistMacro ||
            control == ReconstructionFxControl::Feedback ||
            control == ReconstructionFxControl::ToneHz;
    }
    if (ordinal == 44U) {
        return control == ReconstructionFxControl::TempoBpm ||
            control == ReconstructionFxControl::SubdivisionBeats ||
            control == ReconstructionFxControl::Feedback;
    }
    if (ordinal == 45U) return control == ReconstructionFxControl::Freeze;
    if (ordinal == 24U) {
        return control == ReconstructionFxControl::Drive ||
            control == ReconstructionFxControl::ToneHz ||
            control == ReconstructionFxControl::OutputDb;
    }
    if (ordinal == 23U) {
        return control == ReconstructionFxControl::Drive ||
            control == ReconstructionFxControl::BassDb ||
            control == ReconstructionFxControl::MidDb ||
            control == ReconstructionFxControl::TrebleDb ||
            control == ReconstructionFxControl::PresenceDb ||
            control == ReconstructionFxControl::OutputDb;
    }
    return ordinal == 28U && control == ReconstructionFxControl::Semitones;
}

std::string_view reconstructionFxControlName(ReconstructionFxControl control) noexcept {
    switch (control) {
    case ReconstructionFxControl::Active: return "active";
    case ReconstructionFxControl::Mix: return "mix";
    case ReconstructionFxControl::DelayMs: return "delayMs";
    case ReconstructionFxControl::Feedback: return "feedback";
    case ReconstructionFxControl::ToneHz: return "toneHz";
    case ReconstructionFxControl::WowDepthMs: return "wowDepthMs";
    case ReconstructionFxControl::WowRateHz: return "wowRateHz";
    case ReconstructionFxControl::Drive: return "drive";
    case ReconstructionFxControl::GrainMs: return "grainMs";
    case ReconstructionFxControl::DensityHz: return "densityHz";
    case ReconstructionFxControl::PitchRatio: return "pitchRatio";
    case ReconstructionFxControl::PositionSpread: return "positionSpread";
    case ReconstructionFxControl::Freeze: return "freeze";
    case ReconstructionFxControl::WarpAmount: return "warpAmount";
    case ReconstructionFxControl::ReverbTimeSeconds: return "reverbTimeSeconds";
    case ReconstructionFxControl::DampingHz: return "dampingHz";
    case ReconstructionFxControl::TempoBpm: return "tempoBpm";
    case ReconstructionFxControl::SubdivisionBeats: return "subdivisionBeats";
    case ReconstructionFxControl::TwistMacro: return "twistMacro";
    case ReconstructionFxControl::OutputDb: return "outputDb";
    case ReconstructionFxControl::BassDb: return "bassDb";
    case ReconstructionFxControl::MidDb: return "midDb";
    case ReconstructionFxControl::TrebleDb: return "trebleDb";
    case ReconstructionFxControl::PresenceDb: return "presenceDb";
    case ReconstructionFxControl::Semitones: return "semitones";
    }
    return {};
}

bool ReconstructionFxAdapter::mapTemporalKind(std::uint16_t ordinal,
                                               TemporalFxKind& kind) noexcept {
    switch (ordinal) {
    case 40U: kind = TemporalFxKind::TapeEcho; return true;
    case 41U: kind = TemporalFxKind::GranularDelay; return true;
    case 42U: kind = TemporalFxKind::Warp; return true;
    case 43U: kind = TemporalFxKind::Twist; return true;
    case 44U: kind = TemporalFxKind::Roll; return true;
    case 45U: kind = TemporalFxKind::Freeze; return true;
    default: return false;
    }
}

std::size_t ReconstructionFxAdapter::requiredPrepareBytes(
    const ProcessSpec& spec, std::uint16_t ordinal,
    const ReconstructionFxConfiguration& config) noexcept {
    if (!isReconstructionFxOrdinal(ordinal) || spec.channels != 2U) return 0U;
    if (ordinal >= 40U && ordinal <= 45U) {
        TemporalFxKind kind{};
        if (!mapTemporalKind(ordinal, kind)) return 0U;
        const auto bytes = TemporalFxAdapter::requiredPrepareBytes(spec, kind, config.temporal);
        return wrapMemoryRequirement(bytes, sizeof(TemporalFxAdapter));
    }
    if (ordinal == 24U) {
        const auto bytes = DistortionFxProcessor::requiredPrepareBytes(spec, config.distortion);
        return wrapMemoryRequirement(bytes, sizeof(DistortionFxProcessor));
    }
    if (ordinal == 23U) {
        if (!validCabinetIrForPreflight(config.cabinetIr)) return 0U;
        const auto bytes = PreampFxProcessor::requiredPrepareBytes(
            spec, config.preamp, config.cabinetIr.frames);
        return wrapMemoryRequirement(bytes, sizeof(PreampFxProcessor));
    }
    return wrapMemoryRequirement(OctaveFxProcessor::requiredPrepareBytes(spec, config.octave),
                                 sizeof(OctaveFxProcessor));
}

bool ReconstructionFxAdapter::prepare(const ProcessSpec& spec, std::uint16_t ordinal,
                                     const ReconstructionFxConfiguration& config) {
    if (prepared_ || requiredPrepareBytes(spec, ordinal, config) == 0U) return false;

    Processor candidate{};
    bool ready = false;
    if (ordinal >= 40U && ordinal <= 45U) {
        TemporalFxKind kind{};
        if (!mapTemporalKind(ordinal, kind)) return false;
        auto& processor = candidate.emplace<TemporalFxAdapter>();
        ready = processor.prepare(spec, kind, config.temporal);
        if (ready && kind == TemporalFxKind::GranularDelay)
            ready = processor.setSeed(config.randomSeed);
    } else if (ordinal == 24U) {
        ready = candidate.emplace<DistortionFxProcessor>().prepare(spec, config.distortion);
    } else if (ordinal == 23U) {
        ready = candidate.emplace<PreampFxProcessor>().prepare(
            spec, config.preamp, config.cabinetIr);
    } else if (ordinal == 28U) {
        ready = candidate.emplace<OctaveFxProcessor>().prepare(spec, config.octave);
    }
    if (!ready) return false;

    processor_ = std::move(candidate);
    ordinal_ = ordinal;
    preparedBytes_ = requiredPrepareBytes(spec, ordinal, config);
    prepared_ = preparedBytes_ != 0U;
    return prepared_;
}

void ReconstructionFxAdapter::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    std::visit([absoluteFrame](auto& processor) { processor.reset(absoluteFrame); }, processor_);
}

bool ReconstructionFxAdapter::validateEvents(
    std::uint32_t frames, const ReconstructionFxEvent* events,
    std::uint32_t eventCount) const noexcept {
    if (eventCount > kReconstructionFxMaximumEventsPerBlock ||
        (eventCount != 0U && (events == nullptr || frames == 0U))) return false;
    std::uint32_t previousOffset = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames ||
            (i != 0U && events[i].frameOffset < previousOffset) ||
            !std::isfinite(events[i].value) ||
            !reconstructionFxSupportsControl(ordinal_, events[i].control)) return false;
        previousOffset = events[i].frameOffset;
    }
    return true;
}

bool ReconstructionFxAdapter::processBlock(
    std::uint64_t blockStartFrame, StereoFrame* interleaved, std::uint32_t frames,
    const ReconstructionFxEvent* events, std::uint32_t eventCount) noexcept {
    if (!prepared_ || (frames != 0U && interleaved == nullptr) ||
        !validateEvents(frames, events, eventCount)) return false;

    if (ordinal_ >= 40U && ordinal_ <= 45U) {
        std::array<TemporalFxEvent, kReconstructionFxMaximumEventsPerBlock> converted{};
        for (std::uint32_t i = 0U; i < eventCount; ++i) {
            TemporalFxControl control{};
            if (!mapTemporalControl(events[i].control, control)) return false;
            converted[i] = {events[i].frameOffset, control, events[i].value};
        }
        return std::get<TemporalFxAdapter>(processor_).processBlock(
            blockStartFrame, interleaved, frames,
            eventCount == 0U ? nullptr : converted.data(), eventCount);
    }
    if (ordinal_ == 24U) {
        std::array<DistortionFxEvent, kReconstructionFxMaximumEventsPerBlock> converted{};
        for (std::uint32_t i = 0U; i < eventCount; ++i) {
            DistortionFxControl control{};
            if (!mapDistortionControl(events[i].control, control)) return false;
            converted[i] = {events[i].frameOffset, control, events[i].value};
        }
        return std::get<DistortionFxProcessor>(processor_).processBlock(
            blockStartFrame, interleaved, frames,
            eventCount == 0U ? nullptr : converted.data(), eventCount);
    }
    if (ordinal_ == 23U) {
        std::array<PreampFxEvent, kReconstructionFxMaximumEventsPerBlock> converted{};
        for (std::uint32_t i = 0U; i < eventCount; ++i) {
            PreampFxControl control{};
            if (!mapPreampControl(events[i].control, control)) return false;
            converted[i] = {events[i].frameOffset, control, events[i].value};
        }
        return std::get<PreampFxProcessor>(processor_).processBlock(
            blockStartFrame, interleaved, frames,
            eventCount == 0U ? nullptr : converted.data(), eventCount);
    }

    std::array<OctaveFxEvent, kReconstructionFxMaximumEventsPerBlock> converted{};
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        OctaveFxControl control{};
        if (!mapOctaveControl(events[i].control, control)) return false;
        converted[i] = {events[i].frameOffset, control, events[i].value};
    }
    return std::get<OctaveFxProcessor>(processor_).processBlock(
        blockStartFrame, interleaved, frames,
        eventCount == 0U ? nullptr : converted.data(), eventCount);
}

ReconstructionFxLatency ReconstructionFxAdapter::latency() const noexcept {
    if (!prepared_) return {};
    return std::visit([](const auto& processor) -> ReconstructionFxLatency {
        using T = std::decay_t<decltype(processor)>;
        if constexpr (std::is_same_v<T, TemporalFxAdapter>) {
            const auto value = processor.latency();
            return {value.fixedAlgorithmicSamples < 0
                        ? ReconstructionFxLatencyKind::VariableDelay
                        : (value.wetPathGroupDelaySamples > 0.0
                            ? ReconstructionFxLatencyKind::FrequencyDependentGroupDelay
                            : ReconstructionFxLatencyKind::Fixed),
                    value.fixedAlgorithmicSamples, value.minimumWetDelaySamples,
                    value.maximumWetDelaySamples, value.wetPathGroupDelaySamples};
        } else if constexpr (std::is_same_v<T, DistortionFxProcessor>) {
            const auto value = processor.latency();
            return {value.frequencyDependentGroupDelaySamples > 0.0
                        ? ReconstructionFxLatencyKind::FrequencyDependentGroupDelay
                        : ReconstructionFxLatencyKind::Fixed,
                    value.fixedAlgorithmicSamples, 0U, 0U,
                    value.frequencyDependentGroupDelaySamples};
        } else if constexpr (std::is_same_v<T, PreampFxProcessor>) {
            const auto value = processor.latency();
            return {value.nonlinearLowFrequencyGroupDelaySamples > 0.0
                        ? ReconstructionFxLatencyKind::FrequencyDependentGroupDelay
                        : ReconstructionFxLatencyKind::Fixed,
                    static_cast<std::int32_t>(value.fixedAlgorithmicSamples),
                    value.cabinetPartitionSamples, value.cabinetPartitionSamples,
                    value.nonlinearLowFrequencyGroupDelaySamples};
        } else {
            const auto value = processor.latency();
            return {ReconstructionFxLatencyKind::Fixed,
                    static_cast<std::int32_t>(value.fixedAlgorithmicSamples), 0U, 0U, 0.0};
        }
    }, processor_);
}

} // namespace webrc::dsp
