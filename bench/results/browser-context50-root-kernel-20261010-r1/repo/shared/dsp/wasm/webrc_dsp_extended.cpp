#include "webrc_dsp_extended.h"

#include "handle_registry.hpp"
#include "webrc/dsp/control_dynamics.hpp"
#include "webrc/dsp/fft.hpp"
#include "webrc/dsp/nonlinear.hpp"
#include "webrc/dsp/pitch.hpp"
#include "webrc/dsp/cleanroom_rhythm_data.hpp"
#include "webrc/dsp/live_mono_pitch.hpp"
#include "webrc/dsp/rhythm.hpp"
#include "webrc/dsp/signalsmith_adapter.hpp"
#include "webrc/dsp/spatial_temporal.hpp"
#include "webrc/dsp/streaming_yin.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdint>
#include <limits>
#include <new>
#include <variant>

namespace {

using namespace webrc::dsp;
using webrc::dsp::wasm::HandleDomain;
using webrc::dsp::wasm::HandleRegistry;
using webrc::dsp::wasm::HandleStatus;
using webrc::dsp::wasm::HandleView;

constexpr std::uint32_t kAllocatorHeadroomBytes = 1024U;

bool parseUInt(float value, std::uint32_t minimum, std::uint32_t maximum,
               std::uint32_t& output) noexcept;

using ExtendedPayload = std::variant<
    WdfSymmetricDiode, OversampledNonlinear, PatternSlicer, SampleAccurateScheduler,
    MidSideWidth, OnsetDetector, BitRateReducer, RingModulator, YinPitchDetector,
    TdPsolaPitchShifter, StreamingTdPsolaPitchShifter, PhaseVocoder, MultibandVocoder,
    SignalsmithStretchAdapter, GranularTexture, FdnReverb, PartitionedConvolver,
    SpectralFreeze, ReverseSegment, PlatterInertia, DrumVoicePool, RhythmRenderer,
    IncrementalYinDetector, LiveMonoPitchRoute>;

struct ExtendedState {
    std::uint32_t kind = 0;
    ProcessSpec spec{};
    std::uint64_t firstEstimateColdStartFrames = 0U;
    std::uint32_t pitchHopFrames = 0U;
    ExtendedPayload payload{};

    bool prepare(std::uint32_t requestedKind, const ProcessSpec& requestedSpec,
                 const float* p, std::uint32_t count, std::uint64_t seed) noexcept {
        kind = requestedKind;
        spec = requestedSpec;
        switch (kind) {
        case WEBRC_DSP_EXT_WDF_DIODE: {
            if (count != 0U && count != 4U) return false;
            payload.emplace<WdfSymmetricDiode>();
            auto& item = std::get<WdfSymmetricDiode>(payload);
            const double r = count ? p[0] : 1000.0;
            const double is = count ? p[1] : 2.0e-9;
            const double vt = count ? p[2] : 0.02585;
            const double n = count ? p[3] : 1.0;
            return item.prepare(spec, r, is, vt, n);
        }
        case WEBRC_DSP_EXT_OVERSAMPLED_NONLINEAR: {
            if (!p || count < 2U || count > 3U) return false;
            std::uint32_t factor = 0;
            std::uint32_t model = 0;
            if (!parseUInt(p[0], 2U, 4U, factor) || (factor != 2U && factor != 4U) ||
                !parseUInt(p[1], 0U, 1U, model)) return false;
            payload.emplace<OversampledNonlinear>();
            auto& item = std::get<OversampledNonlinear>(payload);
            if (!item.prepare(spec, factor == 2U ? OversamplingFactor::x2 : OversamplingFactor::x4,
                              model == 0U ? NonlinearModel::AdaaCubic : NonlinearModel::WdfSymmetricDiode)) return false;
            return count == 2U || item.setDrive(p[2]);
        }
        case WEBRC_DSP_EXT_PATTERN_SLICER: {
            if (count != 0U && count != 2U) return false;
            payload.emplace<PatternSlicer>();
            auto& item = std::get<PatternSlicer>(payload);
            if (!item.prepare(spec)) return false;
            std::uint32_t steps = 16U;
            if (count && !parseUInt(p[0], 1U, 64U, steps)) return false;
            const float edge = count ? p[1] : 0.08f;
            std::array<float, 64> gains{};
            for (std::uint32_t index = 0; index < steps; ++index) gains[index] = 1.0f;
            return item.setPattern(gains.data(), steps, edge);
        }
        case WEBRC_DSP_EXT_SAMPLE_ACCURATE_SCHEDULER: {
            if (count != 0U && count != 2U) return false;
            std::uint32_t ppq = 960U;
            if (count && !parseUInt(p[1], 1U, 65535U, ppq)) return false;
            payload.emplace<SampleAccurateScheduler>();
            return std::get<SampleAccurateScheduler>(payload).prepare(spec, count ? p[0] : 120.0, ppq);
        }
        case WEBRC_DSP_EXT_MID_SIDE_WIDTH: {
            if (count > 1U) return false;
            payload.emplace<MidSideWidth>();
            return std::get<MidSideWidth>(payload).prepare(spec, count ? p[0] : 140.0f);
        }
        case WEBRC_DSP_EXT_ONSET_DETECTOR:
            if (count != 0U) return false;
            payload.emplace<OnsetDetector>();
            return std::get<OnsetDetector>(payload).prepare(spec);
        case WEBRC_DSP_EXT_BIT_RATE_REDUCER: {
            if (count != 0U) return false;
            payload.emplace<BitRateReducer>();
            auto& item = std::get<BitRateReducer>(payload);
            if (!item.prepare(spec)) return false;
            item.reset(seed, 7U);
            return item.setParameters(8U, 1U, 1.0f, true);
        }
        case WEBRC_DSP_EXT_RING_MODULATOR:
            if (count != 0U) return false;
            payload.emplace<RingModulator>();
            return std::get<RingModulator>(payload).prepare(spec);
        case WEBRC_DSP_EXT_YIN_PITCH: {
            if (!p || count != 4U) return false;
            std::uint32_t frameFrames = 0;
            if (!parseUInt(p[0], 32U, 65536U, frameFrames)) return false;
            payload.emplace<YinPitchDetector>();
            return std::get<YinPitchDetector>(payload).prepare(spec, frameFrames, p[1], p[2], p[3]);
        }
        case WEBRC_DSP_EXT_TD_PSOLA_BUFFER: {
            if (!p || count != 2U) return false;
            std::uint32_t maxFrames = 0, maxPeriod = 0;
            if (!parseUInt(p[0], 2U, 1U << 20U, maxFrames) ||
                !parseUInt(p[1], 2U, 1U << 18U, maxPeriod)) return false;
            payload.emplace<TdPsolaPitchShifter>();
            return std::get<TdPsolaPitchShifter>(payload).prepare(spec, maxFrames, maxPeriod);
        }
        case WEBRC_DSP_EXT_STREAMING_TD_PSOLA: {
            if (!p || count != 1U) return false;
            std::uint32_t maxPeriod = 0;
            if (!parseUInt(p[0], 2U, 1U << 18U, maxPeriod)) return false;
            payload.emplace<StreamingTdPsolaPitchShifter>();
            return std::get<StreamingTdPsolaPitchShifter>(payload).prepare(spec, maxPeriod);
        }
        case WEBRC_DSP_EXT_PHASE_VOCODER: {
            if (!p || count != 3U) return false;
            std::uint32_t fftFrames = 0, analysisHop = 0, synthesisHop = 0;
            if (!parseUInt(p[0], 2U, 1U << 16U, fftFrames) ||
                !parseUInt(p[1], 1U, fftFrames, analysisHop) ||
                !parseUInt(p[2], 1U, fftFrames, synthesisHop)) return false;
            payload.emplace<PhaseVocoder>();
            return std::get<PhaseVocoder>(payload).prepare(spec, fftFrames, analysisHop, synthesisHop);
        }
        case WEBRC_DSP_EXT_MULTIBAND_VOCODER: {
            if (count != 0U && count != 4U) return false;
            std::uint32_t bands = 16U;
            if (count && !parseUInt(p[0], 1U, 24U, bands)) return false;
            payload.emplace<MultibandVocoder>();
            return std::get<MultibandVocoder>(payload).prepare(
                spec, bands, count ? p[1] : 80.0f, count ? p[2] : 10000.0f, count ? p[3] : 1.25f);
        }
        case WEBRC_DSP_EXT_SIGNALSMITH_STRETCH: {
            if (!p || count != 5U || seed > UINT32_MAX) return false;
            std::uint32_t mode = 0, channels = 0, block = 0, interval = 0, split = 0;
            if (!parseUInt(p[0], 0U, 2U, mode) || !parseUInt(p[1], 1U, 2U, channels) ||
                !parseUInt(p[2], 1U, 65536U, block) ||
                !parseUInt(p[3], 1U, 65536U, interval) ||
                !parseUInt(p[4], 0U, 1U, split)) return false;
            SignalsmithStretchSettings settings{};
            settings.mode = static_cast<PitchQualityMode>(mode);
            settings.channels = channels;
            settings.blockSamples = block;
            settings.intervalSamples = interval;
            settings.splitComputation = split != 0U;
            settings.seed = static_cast<std::uint32_t>(seed);
            payload.emplace<SignalsmithStretchAdapter>(static_cast<std::uint32_t>(seed));
            auto& item = std::get<SignalsmithStretchAdapter>(payload);
            const auto budget = SignalsmithStretchAdapter::requiredPrepareBytes(spec, settings);
            return budget > 0U && item.prepare(spec, settings, budget);
        }
        case WEBRC_DSP_EXT_GRANULAR_TEXTURE: {
            if (count > 1U) return false;
            payload.emplace<GranularTexture>();
            auto& item = std::get<GranularTexture>(payload);
            if (!item.prepare(spec, count ? p[0] : 2.0f)) return false;
            return item.setParameters(50.0f, 20.0f, 1.0f, 0.5f, 1.0f, seed);
        }
        case WEBRC_DSP_EXT_FDN_REVERB: {
            if (count != 0U && count != 2U) return false;
            std::uint32_t lineCount = 8U;
            if (count && !parseUInt(p[0], 8U, 16U, lineCount)) return false;
            payload.emplace<FdnReverb>();
            return std::get<FdnReverb>(payload).prepare(
                spec, lineCount == 8U ? FdnLineCount::Eight : FdnLineCount::Sixteen,
                count ? p[1] : 0.12f);
        }
        case WEBRC_DSP_EXT_PARTITIONED_CONVOLVER: {
            if (!p || count != 2U) return false;
            std::uint32_t partition = 0, impulse = 0;
            if (!parseUInt(p[0], 16U, 1U << 15U, partition) ||
                !parseUInt(p[1], 1U, 1U << 20U, impulse)) return false;
            payload.emplace<PartitionedConvolver>();
            return std::get<PartitionedConvolver>(payload).prepare(
                spec, partition, impulse, nullptr, nullptr, nullptr, nullptr);
        }
        case WEBRC_DSP_EXT_SPECTRAL_FREEZE: {
            if (count != 0U && count != 2U) return false;
            std::uint32_t window = 1024U, hop = 256U;
            if (count && (!parseUInt(p[0], 64U, 1U << 15U, window) ||
                          !parseUInt(p[1], 1U, window, hop))) return false;
            payload.emplace<SpectralFreeze>();
            return std::get<SpectralFreeze>(payload).prepare(spec, window, hop);
        }
        case WEBRC_DSP_EXT_REVERSE_SEGMENT: {
            if (!p || count != 3U) return false;
            std::uint32_t maximum = 0, segment = 0, crossfade = 0;
            if (!parseUInt(p[0], 2U, 1U << 20U, maximum) ||
                !parseUInt(p[1], 2U, maximum, segment) ||
                !parseUInt(p[2], 1U, segment - 1U, crossfade)) return false;
            payload.emplace<ReverseSegment>();
            return std::get<ReverseSegment>(payload).prepare(spec, maximum, segment, crossfade);
        }
        case WEBRC_DSP_EXT_PLATTER_INERTIA:
            if (count != 0U) return false;
            payload.emplace<PlatterInertia>();
            return std::get<PlatterInertia>(payload).prepare(spec);
        case WEBRC_DSP_EXT_DRUM_VOICE_POOL:
            if (count != 0U) return false;
            payload.emplace<DrumVoicePool>();
            return std::get<DrumVoicePool>(payload).prepare(spec);
        case WEBRC_DSP_EXT_RHYTHM_RENDERER: {
            if ((count != 0U && count != 3U) || spec.channels != 2U) return false;
            std::uint32_t patternIndex = 0U;
            std::uint32_t kitIndex = 0U;
            if (count && (!parseUInt(p[0], 0U, cleanRoomRhythmPatternCount() - 1U, patternIndex) ||
                          !parseUInt(p[1], 0U, cleanRoomKitCount() - 1U, kitIndex))) return false;
            const double bpm = count ? static_cast<double>(p[2]) : 120.0;
            payload.emplace<RhythmRenderer>();
            auto& item = std::get<RhythmRenderer>(payload);
            if (!item.prepare(spec, bpm) || !item.setPattern(cleanRoomRhythmPattern(patternIndex)) ||
                !item.setKit(kitIndex)) return false;
            return true;
        }
        case WEBRC_DSP_EXT_INCREMENTAL_YIN: {
            if (!p || count != 6U || spec.channels != 1U) return false;
            std::uint32_t windowFrames = 0U, hopFrames = 0U, workUnits = 0U;
            if (!parseUInt(p[0], 64U, 8192U, windowFrames) ||
                !parseUInt(p[4], 1U, windowFrames, hopFrames) ||
                !parseUInt(p[5], windowFrames, 1'000'000U, workUnits)) return false;
            payload.emplace<IncrementalYinDetector>();
            pitchHopFrames = hopFrames;
            return std::get<IncrementalYinDetector>(payload).prepare(
                spec, windowFrames, p[1], p[2], p[3], hopFrames, workUnits);
        }
        case WEBRC_DSP_EXT_LIVE_MONO_PITCH: {
            if (!p || count != 6U || spec.channels != 1U) return false;
            std::uint32_t windowFrames = 0U, hopFrames = 0U, workUnits = 0U;
            if (!parseUInt(p[0], 64U, 8192U, windowFrames) ||
                !parseUInt(p[1], 1U, windowFrames, hopFrames) ||
                !parseUInt(p[2], windowFrames, 1'000'000U, workUnits)) return false;
            LiveMonoPitchSettings settings{};
            settings.spec = spec;
            settings.analysisWindowFrames = windowFrames;
            settings.analysisHopFrames = hopFrames;
            settings.analysisWorkUnitsPerCallback = workUnits;
            settings.minimumFrequencyHz = p[3];
            settings.maximumFrequencyHz = p[4];
            settings.yinThreshold = p[5];
            payload.emplace<LiveMonoPitchRoute>();
            pitchHopFrames = hopFrames;
            return std::get<LiveMonoPitchRoute>(payload).prepare(settings);
        }
        default:
            return false;
        }
    }

    void reset() noexcept {
        switch (kind) {
        case WEBRC_DSP_EXT_WDF_DIODE: std::get<WdfSymmetricDiode>(payload).reset(); break;
        case WEBRC_DSP_EXT_OVERSAMPLED_NONLINEAR: std::get<OversampledNonlinear>(payload).reset(); break;
        case WEBRC_DSP_EXT_PATTERN_SLICER: std::get<PatternSlicer>(payload).reset(); break;
        case WEBRC_DSP_EXT_SAMPLE_ACCURATE_SCHEDULER: std::get<SampleAccurateScheduler>(payload).reset(); break;
        case WEBRC_DSP_EXT_MID_SIDE_WIDTH: std::get<MidSideWidth>(payload).reset(); break;
        case WEBRC_DSP_EXT_ONSET_DETECTOR: std::get<OnsetDetector>(payload).reset(); break;
        case WEBRC_DSP_EXT_BIT_RATE_REDUCER: std::get<BitRateReducer>(payload).reset(); break;
        case WEBRC_DSP_EXT_RING_MODULATOR: std::get<RingModulator>(payload).reset(); break;
        case WEBRC_DSP_EXT_YIN_PITCH: std::get<YinPitchDetector>(payload).reset(); break;
        case WEBRC_DSP_EXT_TD_PSOLA_BUFFER: std::get<TdPsolaPitchShifter>(payload).reset(); break;
        case WEBRC_DSP_EXT_STREAMING_TD_PSOLA: std::get<StreamingTdPsolaPitchShifter>(payload).reset(); break;
        case WEBRC_DSP_EXT_PHASE_VOCODER: std::get<PhaseVocoder>(payload).reset(); break;
        case WEBRC_DSP_EXT_MULTIBAND_VOCODER: std::get<MultibandVocoder>(payload).reset(); break;
        case WEBRC_DSP_EXT_SIGNALSMITH_STRETCH: std::get<SignalsmithStretchAdapter>(payload).reset(); break;
        case WEBRC_DSP_EXT_GRANULAR_TEXTURE: std::get<GranularTexture>(payload).reset(); break;
        case WEBRC_DSP_EXT_FDN_REVERB: std::get<FdnReverb>(payload).reset(); break;
        case WEBRC_DSP_EXT_PARTITIONED_CONVOLVER: std::get<PartitionedConvolver>(payload).reset(); break;
        case WEBRC_DSP_EXT_SPECTRAL_FREEZE: std::get<SpectralFreeze>(payload).reset(); break;
        case WEBRC_DSP_EXT_REVERSE_SEGMENT: std::get<ReverseSegment>(payload).reset(); break;
        case WEBRC_DSP_EXT_PLATTER_INERTIA: std::get<PlatterInertia>(payload).reset(); break;
        case WEBRC_DSP_EXT_DRUM_VOICE_POOL: std::get<DrumVoicePool>(payload).reset(); break;
        case WEBRC_DSP_EXT_RHYTHM_RENDERER: std::get<RhythmRenderer>(payload).reset(); break;
        case WEBRC_DSP_EXT_INCREMENTAL_YIN:
            std::get<IncrementalYinDetector>(payload).reset();
            firstEstimateColdStartFrames = 0U;
            break;
        case WEBRC_DSP_EXT_LIVE_MONO_PITCH:
            std::get<LiveMonoPitchRoute>(payload).reset();
            firstEstimateColdStartFrames = 0U;
            break;
        default: break;
        }
    }
};

std::int32_t gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;

bool parseUInt(float value, std::uint32_t minimum, std::uint32_t maximum,
               std::uint32_t& output) noexcept {
    if (!std::isfinite(value) || value < static_cast<float>(minimum) ||
        value > static_cast<float>(maximum) || std::floor(value) != value) return false;
    output = static_cast<std::uint32_t>(value);
    return true;
}

std::uint32_t stateBytes(std::size_t extra) noexcept {
    const auto bytes = sizeof(ExtendedState) + extra + kAllocatorHeadroomBytes;
    return bytes > UINT32_MAX ? UINT32_MAX : static_cast<std::uint32_t>(bytes);
}

std::uint32_t requiredBytes(std::uint32_t kind, const ProcessSpec& spec,
                            const float* p, std::uint32_t count,
                            std::uint64_t seed) noexcept {
    std::size_t extra = 0U;
    std::uint32_t parsed = 0U;
    switch (kind) {
    case WEBRC_DSP_EXT_WDF_DIODE:
        if (count != 0U && count != 4U) return 0U;
        break;
    case WEBRC_DSP_EXT_OVERSAMPLED_NONLINEAR:
        if (!p || count < 2U || count > 3U ||
            !parseUInt(p[0], 2U, 4U, parsed) || (parsed != 2U && parsed != 4U) ||
            !parseUInt(p[1], 0U, 1U, parsed)) return 0U;
        break;
    case WEBRC_DSP_EXT_PATTERN_SLICER:
        if (count != 0U && count != 2U) return 0U;
        if (count && !parseUInt(p[0], 1U, 64U, parsed)) return 0U;
        break;
    case WEBRC_DSP_EXT_SAMPLE_ACCURATE_SCHEDULER:
        if (count != 0U && count != 2U) return 0U;
        if (count && !parseUInt(p[1], 1U, 65535U, parsed)) return 0U;
        break;
    case WEBRC_DSP_EXT_MID_SIDE_WIDTH:
        if (count > 1U) return 0U;
        break;
    case WEBRC_DSP_EXT_ONSET_DETECTOR:
    case WEBRC_DSP_EXT_BIT_RATE_REDUCER:
    case WEBRC_DSP_EXT_RING_MODULATOR:
    case WEBRC_DSP_EXT_PLATTER_INERTIA:
    case WEBRC_DSP_EXT_DRUM_VOICE_POOL:
        if (count != 0U) return 0U;
        break;
    case WEBRC_DSP_EXT_RHYTHM_RENDERER: {
        if ((count != 0U && count != 3U) || spec.channels != 2U) return 0U;
        std::uint32_t patternIndex = 0U;
        std::uint32_t kitIndex = 0U;
        if (count && (!parseUInt(p[0], 0U, cleanRoomRhythmPatternCount() - 1U, patternIndex) ||
                      !parseUInt(p[1], 0U, cleanRoomKitCount() - 1U, kitIndex) ||
                      !std::isfinite(p[2]) || p[2] < 10.0f || p[2] > 400.0f)) return 0U;
        break;
    }
    case WEBRC_DSP_EXT_INCREMENTAL_YIN: {
        if (!p || count != 6U || spec.channels != 1U) return 0U;
        std::uint32_t windowFrames = 0U, hopFrames = 0U, workUnits = 0U;
        if (!parseUInt(p[0], 64U, 8192U, windowFrames) ||
            !parseUInt(p[4], 1U, windowFrames, hopFrames) ||
            !parseUInt(p[5], windowFrames, 1'000'000U, workUnits) ||
            !std::isfinite(p[3]) || p[3] <= 0.0f || p[3] >= 1.0f) return 0U;
        extra = IncrementalYinDetector::requiredPrepareBytes(
            spec, windowFrames, p[1], p[2], workUnits);
        if (extra == 0U) return 0U;
        break;
    }
    case WEBRC_DSP_EXT_LIVE_MONO_PITCH: {
        if (!p || count != 6U || spec.channels != 1U) return 0U;
        std::uint32_t windowFrames = 0U, hopFrames = 0U, workUnits = 0U;
        if (!parseUInt(p[0], 64U, 8192U, windowFrames) ||
            !parseUInt(p[1], 1U, windowFrames, hopFrames) ||
            !parseUInt(p[2], windowFrames, 1'000'000U, workUnits)) return 0U;
        LiveMonoPitchSettings settings{};
        settings.spec = spec;
        settings.analysisWindowFrames = windowFrames;
        settings.analysisHopFrames = hopFrames;
        settings.analysisWorkUnitsPerCallback = workUnits;
        settings.minimumFrequencyHz = p[3];
        settings.maximumFrequencyHz = p[4];
        settings.yinThreshold = p[5];
        extra = LiveMonoPitchRoute::requiredPrepareBytes(settings);
        if (extra == 0U) return 0U;
        break;
    }
    case WEBRC_DSP_EXT_YIN_PITCH:
        if (!p || count != 4U || !parseUInt(p[0], 32U, 65536U, parsed)) return 0U;
        extra = YinPitchDetector::requiredPrepareBytes(spec, parsed, p[1], p[2]);
        if (extra == 0U) return 0U;
        break;
    case WEBRC_DSP_EXT_TD_PSOLA_BUFFER:
        if (!p || count != 2U || !parseUInt(p[0], 2U, 1U << 20U, parsed)) return 0U;
        if (!parseUInt(p[1], 2U, 1U << 18U, parsed)) return 0U;
        extra = TdPsolaPitchShifter::requiredPrepareBytes(static_cast<std::uint32_t>(p[0]));
        if (extra == 0U) return 0U;
        break;
    case WEBRC_DSP_EXT_STREAMING_TD_PSOLA:
        if (!p || count != 1U || !parseUInt(p[0], 2U, 1U << 18U, parsed)) return 0U;
        extra = StreamingTdPsolaPitchShifter::requiredPrepareBytes(spec, parsed);
        if (extra == 0U) return 0U;
        break;
    case WEBRC_DSP_EXT_PHASE_VOCODER:
        {
        if (!p || count != 3U) return 0U;
        std::uint32_t fftFrames = 0U, analysisHop = 0U, synthesisHop = 0U;
        if (!parseUInt(p[0], 2U, 1U << 16U, fftFrames) ||
            !parseUInt(p[1], 1U, fftFrames, analysisHop) ||
            !parseUInt(p[2], 1U, fftFrames, synthesisHop)) return 0U;
        extra = PhaseVocoder::requiredPrepareBytes(static_cast<std::uint32_t>(p[0]));
        if (extra == 0U) return 0U;
        break;
        }
    case WEBRC_DSP_EXT_MULTIBAND_VOCODER:
        if (count != 0U && count != 4U) return 0U;
        if (count && !parseUInt(p[0], 1U, 24U, parsed)) return 0U;
        extra = MultibandVocoder::requiredPrepareBytes();
        break;
    case WEBRC_DSP_EXT_SIGNALSMITH_STRETCH: {
        if (!p || count != 5U || seed > UINT32_MAX) return 0U;
        std::uint32_t mode = 0U, channels = 0U, block = 0U, interval = 0U, split = 0U;
        if (!parseUInt(p[0], 0U, 2U, mode) || !parseUInt(p[1], 1U, 2U, channels) ||
            !parseUInt(p[2], 1U, 65536U, block) || !parseUInt(p[3], 1U, 65536U, interval) ||
            !parseUInt(p[4], 0U, 1U, split)) return 0U;
        SignalsmithStretchSettings settings{};
        settings.mode = static_cast<PitchQualityMode>(mode);
        settings.channels = channels;
        settings.blockSamples = block;
        settings.intervalSamples = interval;
        settings.splitComputation = split != 0U;
        settings.seed = static_cast<std::uint32_t>(seed);
        extra = SignalsmithStretchAdapter::requiredPrepareBytes(spec, settings);
        if (extra == 0U) return 0U;
        break;
    }
    case WEBRC_DSP_EXT_GRANULAR_TEXTURE:
        if (count > 1U) return 0U;
        extra = GranularTexture::requiredPrepareBytes(spec, count ? p[0] : 2.0f);
        if (extra == 0U) return 0U;
        break;
    case WEBRC_DSP_EXT_FDN_REVERB: {
        if (count != 0U && count != 2U) return 0U;
        std::uint32_t lines = 8U;
        if (count && !parseUInt(p[0], 8U, 16U, lines)) return 0U;
        if (lines != 8U && lines != 16U) return 0U;
        extra = FdnReverb::requiredPrepareBytes(spec, lines == 8U ? FdnLineCount::Eight : FdnLineCount::Sixteen,
                                               count ? p[1] : 0.12f);
        if (extra == 0U) return 0U;
        break;
    }
    case WEBRC_DSP_EXT_PARTITIONED_CONVOLVER:
        if (!p || count != 2U || !parseUInt(p[0], 16U, 1U << 15U, parsed)) return 0U;
        if (!parseUInt(p[1], 1U, 1U << 20U, parsed)) return 0U;
        extra = PartitionedConvolver::requiredPrepareBytes(static_cast<std::uint32_t>(p[0]),
                                                            static_cast<std::uint32_t>(p[1]));
        if (extra == 0U) return 0U;
        break;
    case WEBRC_DSP_EXT_SPECTRAL_FREEZE: {
        if (count != 0U && count != 2U) return 0U;
        std::uint32_t window = 1024U, hop = 256U;
        if (count && (!parseUInt(p[0], 64U, 1U << 15U, window) ||
                      !parseUInt(p[1], 1U, window, hop))) return 0U;
        extra = SpectralFreeze::requiredPrepareBytes(spec, window, hop);
        if (extra == 0U) return 0U;
        break;
    }
    case WEBRC_DSP_EXT_REVERSE_SEGMENT: {
        if (!p || count != 3U) return 0U;
        std::uint32_t maximum = 0U, segment = 0U, overlap = 0U;
        if (!parseUInt(p[0], 2U, 1U << 20U, maximum) || !parseUInt(p[1], 2U, maximum, segment) ||
            !parseUInt(p[2], 1U, segment - 1U, overlap)) return 0U;
        extra = ReverseSegment::requiredPrepareBytes(spec, maximum);
        if (extra == 0U) return 0U;
        break;
    }
    default:
        return 0U;
    }
    return stateBytes(extra);
}

bool isKnownExtendedKind(std::uint32_t kind) noexcept {
    return (kind >= WEBRC_DSP_EXT_WDF_DIODE && kind <= WEBRC_DSP_EXT_RHYTHM_RENDERER) ||
           kind == WEBRC_DSP_EXT_INCREMENTAL_YIN || kind == WEBRC_DSP_EXT_LIVE_MONO_PITCH;
}

void destroyExtended(void* payload) noexcept {
    delete static_cast<ExtendedState*>(payload);
}

std::int32_t extendedStateFor(WebrcDspHandle handle, ExtendedState*& output) noexcept {
    HandleView view{};
    const auto status = webrc::dsp::wasm::registry().lookup(handle, view);
    if (status != HandleStatus::HandleOk) return status;
    if (view.domain != HandleDomain::Extended) return WEBRC_DSP_BAD_KIND;
    output = static_cast<ExtendedState*>(view.payload);
    return WEBRC_DSP_OK;
}

std::int32_t checkFrames(const ExtendedState& state, std::uint32_t frames) noexcept {
    return frames > state.spec.maxBlockFrames ? WEBRC_DSP_BLOCK_TOO_LARGE : WEBRC_DSP_OK;
}

template <typename T>
bool validLinearMemorySpan(const T* pointer, std::uint32_t count) noexcept {
    if (count == 0U) return true;
    if (!pointer) return false;
    const auto address = reinterpret_cast<std::uintptr_t>(pointer);
    if ((address % alignof(T)) != 0U) return false;
    const auto byteCount = static_cast<std::uint64_t>(count) * sizeof(T);
#if defined(__wasm__) || defined(__wasm32__)
    const auto memoryBytes = static_cast<std::uint64_t>(__builtin_wasm_memory_size(0)) * 65536ULL;
    if (address > memoryBytes || byteCount > memoryBytes - address) return false;
#endif
    return byteCount <= std::numeric_limits<std::uintptr_t>::max() - address;
}

template <typename T>
T* payload(ExtendedState& state) noexcept {
    return std::get_if<T>(&state.payload);
}

std::int32_t setConfigure(ExtendedState& state, std::uint32_t control,
                          const float* values, std::uint32_t count,
                          std::uint64_t seed) noexcept {
    if (count != 0U && !values) return WEBRC_DSP_BAD_ARGUMENT;
    std::uint32_t a = 0U, b = 0U;
    switch (control) {
    case WEBRC_DSP_EXT_CONTROL_WDF_DIODE_PARAMETERS:
        if (state.kind != WEBRC_DSP_EXT_WDF_DIODE || count != 4U) break;
        return payload<WdfSymmetricDiode>(state)->setParameters(values[0], values[1], values[2], values[3])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_NONLINEAR_DRIVE:
        if (state.kind != WEBRC_DSP_EXT_OVERSAMPLED_NONLINEAR || count != 1U) break;
        return payload<OversampledNonlinear>(state)->setDrive(values[0]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_PATTERN_GAINS:
        if (state.kind != WEBRC_DSP_EXT_PATTERN_SLICER || count < 2U || count > 65U) break;
        return payload<PatternSlicer>(state)->setPattern(values + 1, count - 1U, values[0])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_SCHEDULER_TEMPO:
        if (state.kind != WEBRC_DSP_EXT_SAMPLE_ACCURATE_SCHEDULER || count != 2U ||
            !parseUInt(values[1], 1U, 65535U, b)) break;
        return payload<SampleAccurateScheduler>(state)->setTempo(values[0], b)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_MID_SIDE_WIDTH:
        if (state.kind != WEBRC_DSP_EXT_MID_SIDE_WIDTH || (count != 2U && count != 3U)) break;
        return payload<MidSideWidth>(state)->setWidth(values[0], values[1], count == 3U ? values[2] : 10.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_ONSET_PARAMETERS:
        if (state.kind != WEBRC_DSP_EXT_ONSET_DETECTOR || (count != 3U && count != 4U)) break;
        return payload<OnsetDetector>(state)->setParameters(values[0], values[1], values[2],
                                                             count == 4U ? values[3] : 35.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_BIT_RATE_PARAMETERS: {
        if (state.kind != WEBRC_DSP_EXT_BIT_RATE_REDUCER || count != 5U ||
            !parseUInt(values[0], 1U, 24U, a) || !parseUInt(values[1], 1U, 1024U, b) ||
            !std::isfinite(values[3]) || (values[3] != 0.0f && values[3] != 1.0f)) break;
        return payload<BitRateReducer>(state)->setParameters(a, b, values[2], values[3] != 0.0f, values[4])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    }
    case WEBRC_DSP_EXT_CONTROL_RING_MOD_PARAMETERS:
        if (state.kind != WEBRC_DSP_EXT_RING_MODULATOR || count != 3U) break;
        return payload<RingModulator>(state)->setParameters(values[0], values[1], values[2])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_STREAMING_PITCH:
        if (state.kind != WEBRC_DSP_EXT_STREAMING_TD_PSOLA || count != 3U ||
            !std::isfinite(values[2]) || (values[2] != 0.0f && values[2] != 1.0f)) break;
        return payload<StreamingTdPsolaPitchShifter>(state)->setPitch(values[0], values[1], values[2] != 0.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_VOCODER_ENVELOPE:
        if (state.kind != WEBRC_DSP_EXT_MULTIBAND_VOCODER || count != 2U) break;
        return payload<MultibandVocoder>(state)->setEnvelopeTimes(values[0], values[1])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_VOCODER_GAIN:
        if (state.kind != WEBRC_DSP_EXT_MULTIBAND_VOCODER || count != 1U) break;
        return payload<MultibandVocoder>(state)->setOutputGain(values[0])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_STRETCH_TRANSPOSE:
        if (state.kind != WEBRC_DSP_EXT_SIGNALSMITH_STRETCH || count != 2U) break;
        return payload<SignalsmithStretchAdapter>(state)->setTransposeFactor(values[0], values[1])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_STRETCH_FORMANT:
        if (state.kind != WEBRC_DSP_EXT_SIGNALSMITH_STRETCH || count != 2U ||
            !std::isfinite(values[1]) || (values[1] != 0.0f && values[1] != 1.0f)) break;
        return payload<SignalsmithStretchAdapter>(state)->setFormantFactor(values[0], values[1] != 0.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_FDN_PARAMETERS:
        if (state.kind != WEBRC_DSP_EXT_FDN_REVERB || (count != 6U && count != 7U)) break;
        return payload<FdnReverb>(state)->setParameters(values[0], values[1], values[2], values[3],
                                                        values[4], values[5], count == 7U ? values[6] : 20.0f)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_GRANULAR_PARAMETERS:
        if (state.kind != WEBRC_DSP_EXT_GRANULAR_TEXTURE || count != 5U) break;
        return payload<GranularTexture>(state)->setParameters(values[0], values[1], values[2],
                                                              values[3], values[4], seed)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_SPECTRAL_FREEZE:
        if (state.kind != WEBRC_DSP_EXT_SPECTRAL_FREEZE || count != 2U) break;
        if (!std::isfinite(values[0]) || (values[0] != 0.0f && values[0] != 1.0f) ||
            !std::isfinite(values[1])) return WEBRC_DSP_BAD_ARGUMENT;
        if (!payload<SpectralFreeze>(state)->setFreeze(values[0] != 0.0f)) return WEBRC_DSP_BAD_ARGUMENT;
        return payload<SpectralFreeze>(state)->setMix(values[1]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_REVERSE_SEGMENT:
        if (state.kind != WEBRC_DSP_EXT_REVERSE_SEGMENT || count != 2U ||
            !parseUInt(values[0], 2U, UINT32_MAX, a) || !parseUInt(values[1], 1U, UINT32_MAX, b)) break;
        return payload<ReverseSegment>(state)->setSegment(a, b) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_PLATTER_TARGET_SPEED:
        if (state.kind != WEBRC_DSP_EXT_PLATTER_INERTIA || count != 1U) break;
        return payload<PlatterInertia>(state)->setTargetSpeed(values[0]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_PLATTER_INERTIA:
        if (state.kind != WEBRC_DSP_EXT_PLATTER_INERTIA || count != 2U) break;
        return payload<PlatterInertia>(state)->setInertia(values[0], values[1]) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_CONTROL_LIVE_MONO_PITCH_RATIO:
        if (state.kind != WEBRC_DSP_EXT_LIVE_MONO_PITCH || count != 1U) break;
        return payload<LiveMonoPitchRoute>(state)->setPitchRatio(values[0])
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    default:
        return WEBRC_DSP_BAD_ARGUMENT;
    }
    return WEBRC_DSP_BAD_KIND;
}

std::int32_t rhythmStateFor(WebrcDspHandle handle, ExtendedState*& state,
                            RhythmRenderer*& renderer) noexcept {
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_RHYTHM_RENDERER) return WEBRC_DSP_BAD_KIND;
    renderer = payload<RhythmRenderer>(*state);
    return renderer ? WEBRC_DSP_OK : WEBRC_DSP_PREPARE_FAILED;
}

std::int32_t pitchEstimateFor(ExtendedState& state, PitchEstimate& estimate,
                              std::uint64_t& analysisCount,
                              std::uint64_t& totalInputFrames,
                              std::uint64_t& latestWindowEndFrame) noexcept {
    if (state.kind == WEBRC_DSP_EXT_INCREMENTAL_YIN) {
        auto& detector = *payload<IncrementalYinDetector>(state);
        analysisCount = detector.analysisCount();
        totalInputFrames = detector.totalInputFrames();
        latestWindowEndFrame = detector.latestWindowEndFrame();
        estimate = detector.latestEstimate();
    } else if (state.kind == WEBRC_DSP_EXT_LIVE_MONO_PITCH) {
        auto& route = *payload<LiveMonoPitchRoute>(state);
        analysisCount = route.analysisCount();
        totalInputFrames = route.inputFrames();
        latestWindowEndFrame = route.estimateWindowEndFrame();
        estimate = route.latestEstimate();
    } else {
        return WEBRC_DSP_BAD_KIND;
    }
    return analysisCount == 0U ? WEBRC_DSP_NO_ESTIMATE : WEBRC_DSP_OK;
}

} // namespace

extern "C" {

WebrcDspHandle webrc_dsp_extended_create(std::uint32_t kind, float sampleRate,
                                         std::uint32_t maxBlockFrames,
                                         std::uint32_t channels,
                                         const float* prepareParameters,
                                         std::uint32_t parameterCount,
                                         std::uint64_t seed) {
    const ProcessSpec spec{sampleRate, maxBlockFrames, channels};
    if (!validProcessSpec(spec) || (parameterCount != 0U && !prepareParameters)) {
        gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }
    const auto accountedBytes = requiredBytes(kind, spec, prepareParameters, parameterCount, seed);
    if (accountedBytes == 0U || accountedBytes == UINT32_MAX) {
        gLastCreateStatus = !isKnownExtendedKind(kind) ? WEBRC_DSP_BAD_KIND : WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }
    HandleRegistry::Reservation reservation{};
    const auto reserveStatus = webrc::dsp::wasm::registry().reserve(accountedBytes, reservation);
    if (reserveStatus != WEBRC_DSP_OK) {
        gLastCreateStatus = reserveStatus;
        return 0U;
    }
    auto* state = new (std::nothrow) ExtendedState{};
    if (!state) {
        gLastCreateStatus = WEBRC_DSP_ALLOCATION_FAILED;
        return 0U;
    }
    if (!state->prepare(kind, spec, prepareParameters, parameterCount, seed)) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    const auto handle = webrc::dsp::wasm::registry().publish(
        reservation, HandleDomain::Extended, kind, spec, state, destroyExtended);
    if (handle == 0U) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    gLastCreateStatus = WEBRC_DSP_OK;
    return handle;
}

WebrcDspHandle webrc_dsp_extended_create_convolver(float sampleRate,
                                                   std::uint32_t maxBlockFrames,
                                                   std::uint32_t channels,
                                                   std::uint32_t partitionFrames,
                                                   std::uint32_t impulseFrames,
                                                   const float* impulseLL,
                                                   const float* impulseLR,
                                                   const float* impulseRL,
                                                   const float* impulseRR) {
    const ProcessSpec spec{sampleRate, maxBlockFrames, channels};
    if (!validProcessSpec(spec)) {
        gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }
    const auto extra = PartitionedConvolver::requiredPrepareBytes(partitionFrames, impulseFrames);
    const auto accountedBytes = extra == 0U ? 0U : stateBytes(extra);
    if (accountedBytes == 0U || accountedBytes == UINT32_MAX) {
        gLastCreateStatus = WEBRC_DSP_BAD_ARGUMENT;
        return 0U;
    }
    HandleRegistry::Reservation reservation{};
    const auto reserveStatus = webrc::dsp::wasm::registry().reserve(accountedBytes, reservation);
    if (reserveStatus != WEBRC_DSP_OK) {
        gLastCreateStatus = reserveStatus;
        return 0U;
    }
    auto* state = new (std::nothrow) ExtendedState{};
    if (!state) {
        gLastCreateStatus = WEBRC_DSP_ALLOCATION_FAILED;
        return 0U;
    }
    state->kind = WEBRC_DSP_EXT_PARTITIONED_CONVOLVER;
    state->spec = spec;
    state->payload.emplace<PartitionedConvolver>();
    if (!payload<PartitionedConvolver>(*state)->prepare(
            spec, partitionFrames, impulseFrames, impulseLL, impulseLR, impulseRL, impulseRR)) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    const auto handle = webrc::dsp::wasm::registry().publish(
        reservation, HandleDomain::Extended, WEBRC_DSP_EXT_PARTITIONED_CONVOLVER,
        spec, state, destroyExtended);
    if (handle == 0U) {
        delete state;
        gLastCreateStatus = WEBRC_DSP_PREPARE_FAILED;
        return 0U;
    }
    gLastCreateStatus = WEBRC_DSP_OK;
    return handle;
}

std::int32_t webrc_dsp_extended_last_create_status(void) {
    return gLastCreateStatus;
}

std::int32_t webrc_dsp_extended_destroy(WebrcDspHandle handle) {
    return webrc::dsp::wasm::registry().destroy(handle, HandleDomain::Extended);
}

std::int32_t webrc_dsp_extended_reset(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    state->reset();
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_configure(WebrcDspHandle handle, std::uint32_t control,
                                          const float* values, std::uint32_t valueCount,
                                          std::uint64_t seed) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    return setConfigure(*state, control, values, valueCount, seed);
}

std::int32_t webrc_dsp_extended_process_mono(WebrcDspHandle handle, const float* input,
                                              float* output, std::uint32_t frames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    const auto frameStatus = checkFrames(*state, frames);
    if (frameStatus != WEBRC_DSP_OK) return frameStatus;
    switch (state->kind) {
    case WEBRC_DSP_EXT_WDF_DIODE:
        return payload<WdfSymmetricDiode>(*state)->processBlock(input, output, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_OVERSAMPLED_NONLINEAR:
        return payload<OversampledNonlinear>(*state)->processBlock(input, output, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_BIT_RATE_REDUCER:
        return payload<BitRateReducer>(*state)->processBlock(input, output, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_RING_MODULATOR:
        return payload<RingModulator>(*state)->processBlock(input, output, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_STREAMING_TD_PSOLA:
        return payload<StreamingTdPsolaPitchShifter>(*state)->processBlock(input, output, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_LIVE_MONO_PITCH: {
        auto& route = *payload<LiveMonoPitchRoute>(*state);
        if (!route.processBlock(input, output, frames)) return WEBRC_DSP_BAD_ARGUMENT;
        if (state->firstEstimateColdStartFrames == 0U && route.analysisCount() != 0U)
            state->firstEstimateColdStartFrames = route.inputFrames();
        return WEBRC_DSP_OK;
    }
    default:
        return WEBRC_DSP_BAD_KIND;
    }
}

std::int32_t webrc_dsp_extended_process_stereo(WebrcDspHandle handle,
                                               const float* inputLeft,
                                               const float* inputRight,
                                               float* outputLeft, float* outputRight,
                                               std::uint32_t frames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    const auto frameStatus = checkFrames(*state, frames);
    if (frameStatus != WEBRC_DSP_OK) return frameStatus;
    switch (state->kind) {
    case WEBRC_DSP_EXT_MID_SIDE_WIDTH:
        return payload<MidSideWidth>(*state)->processBlock(inputLeft, inputRight, outputLeft, outputRight, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_FDN_REVERB:
        return payload<FdnReverb>(*state)->processBlock(inputLeft, inputRight, outputLeft, outputRight, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_PARTITIONED_CONVOLVER:
        return payload<PartitionedConvolver>(*state)->processBlock(inputLeft, inputRight, outputLeft, outputRight, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_GRANULAR_TEXTURE:
        return payload<GranularTexture>(*state)->processBlock(inputLeft, inputRight, outputLeft, outputRight, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_SPECTRAL_FREEZE:
        return payload<SpectralFreeze>(*state)->processBlock(inputLeft, inputRight, outputLeft, outputRight, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_REVERSE_SEGMENT:
        return payload<ReverseSegment>(*state)->processBlock(inputLeft, inputRight, outputLeft, outputRight, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    case WEBRC_DSP_EXT_DRUM_VOICE_POOL:
        return payload<DrumVoicePool>(*state)->processBlock(outputLeft, outputRight, frames)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    default:
        return WEBRC_DSP_BAD_KIND;
    }
}

std::int32_t webrc_dsp_extended_process_vocoder(WebrcDspHandle handle,
                                                const float* modulatorLeft,
                                                const float* modulatorRight,
                                                const float* carrierLeft,
                                                const float* carrierRight,
                                                float* outputLeft, float* outputRight,
                                                std::uint32_t frames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_MULTIBAND_VOCODER) return WEBRC_DSP_BAD_KIND;
    const auto frameStatus = checkFrames(*state, frames);
    if (frameStatus != WEBRC_DSP_OK) return frameStatus;
    return payload<MultibandVocoder>(*state)->processBlock(
               modulatorLeft, modulatorRight, carrierLeft, carrierRight,
               outputLeft, outputRight, frames) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_process_pattern(WebrcDspHandle handle, const float* input,
                                                 const double* phaseCycles, float* output,
                                                 std::uint32_t frames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_PATTERN_SLICER) return WEBRC_DSP_BAD_KIND;
    const auto frameStatus = checkFrames(*state, frames);
    if (frameStatus != WEBRC_DSP_OK) return frameStatus;
    return payload<PatternSlicer>(*state)->processBlock(input, phaseCycles, output, frames)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_process_onset(WebrcDspHandle handle, const float* input,
                                               WebrcDspOnsetResult* output,
                                               std::uint32_t frames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_ONSET_DETECTOR) return WEBRC_DSP_BAD_KIND;
    const auto frameStatus = checkFrames(*state, frames);
    if (frameStatus != WEBRC_DSP_OK) return frameStatus;
    if (!input || !output) return WEBRC_DSP_BAD_ARGUMENT;
    auto& detector = *payload<OnsetDetector>(*state);
    for (std::uint32_t index = 0; index < frames; ++index) {
        const auto result = detector.processSample(input[index]);
        output[index] = {result.envelope, result.flux, result.onset ? 1U : 0U};
    }
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_process_platter(WebrcDspHandle handle, float* speedRatios,
                                                 double* phaseCycles, float* accelerations,
                                                 std::uint32_t frames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_PLATTER_INERTIA) return WEBRC_DSP_BAD_KIND;
    const auto frameStatus = checkFrames(*state, frames);
    if (frameStatus != WEBRC_DSP_OK) return frameStatus;
    return payload<PlatterInertia>(*state)->processBlock(speedRatios, phaseCycles, accelerations, frames)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_process_pitch_stretch(WebrcDspHandle handle,
                                                      const float* inputLeft,
                                                      const float* inputRight,
                                                      std::uint32_t inputFrames,
                                                      float* outputLeft,
                                                      float* outputRight,
                                                      std::uint32_t outputFrames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_SIGNALSMITH_STRETCH) return WEBRC_DSP_BAD_KIND;
    if (inputFrames > state->spec.maxBlockFrames || outputFrames > state->spec.maxBlockFrames)
        return WEBRC_DSP_BLOCK_TOO_LARGE;
    auto& stretcher = *payload<SignalsmithStretchAdapter>(*state);
    const auto channels = stretcher.settings().channels;
    if (!inputLeft || !outputLeft || (channels == 2U && (!inputRight || !outputRight)))
        return WEBRC_DSP_BAD_ARGUMENT;
    const std::array<const float*, 2> inputChannels{inputLeft, inputRight};
    std::array<float*, 2> outputChannels{outputLeft, outputRight};
    return stretcher.process(inputChannels.data(), inputFrames, outputChannels.data(), outputFrames)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_pitch_output_seek_length(WebrcDspHandle handle,
                                                         float playbackRate,
                                                         std::uint32_t* inputFrames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_SIGNALSMITH_STRETCH) return WEBRC_DSP_BAD_KIND;
    if (!inputFrames || !validLinearMemorySpan(inputFrames, 1U)) return WEBRC_DSP_BAD_ARGUMENT;
    auto& stretcher = *payload<SignalsmithStretchAdapter>(*state);
    if (stretcher.settings().channels != 2U) return WEBRC_DSP_BAD_KIND;
    std::uint32_t requiredFrames = 0U;
    if (!stretcher.outputSeekLength(playbackRate, requiredFrames)) return WEBRC_DSP_BAD_ARGUMENT;
    *inputFrames = requiredFrames;
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_pitch_output_seek(WebrcDspHandle handle,
                                                  const float* inputLeft,
                                                  const float* inputRight,
                                                  std::uint32_t inputFrames,
                                                  float playbackRate) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_SIGNALSMITH_STRETCH) return WEBRC_DSP_BAD_KIND;
    auto& stretcher = *payload<SignalsmithStretchAdapter>(*state);
    if (stretcher.settings().channels != 2U) return WEBRC_DSP_BAD_KIND;
    if (inputFrames == 0U || !validLinearMemorySpan(inputLeft, inputFrames) ||
        !validLinearMemorySpan(inputRight, inputFrames)) return WEBRC_DSP_BAD_ARGUMENT;
    const std::array<const float*, 2> inputChannels{inputLeft, inputRight};
    return stretcher.outputSeek(inputChannels.data(), inputFrames, playbackRate)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_pitch_flush(WebrcDspHandle handle,
                                            float* outputLeft,
                                            float* outputRight,
                                            std::uint32_t outputFrames,
                                            float playbackRate,
                                            std::uint32_t* producedFrames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_SIGNALSMITH_STRETCH) return WEBRC_DSP_BAD_KIND;
    if (!producedFrames || !validLinearMemorySpan(producedFrames, 1U) || outputFrames == 0U ||
        !validLinearMemorySpan(outputLeft, outputFrames) ||
        !validLinearMemorySpan(outputRight, outputFrames)) return WEBRC_DSP_BAD_ARGUMENT;
    auto& stretcher = *payload<SignalsmithStretchAdapter>(*state);
    if (stretcher.settings().channels != 2U) return WEBRC_DSP_BAD_KIND;
    std::array<float*, 2> outputChannels{outputLeft, outputRight};
    if (!stretcher.flush(outputChannels.data(), outputFrames, playbackRate)) return WEBRC_DSP_BAD_ARGUMENT;
    *producedFrames = outputFrames;
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_process_spectrum(WebrcDspHandle handle,
                                                  const float* inputInterleavedComplex,
                                                  float* outputInterleavedComplex,
                                                  float pitchRatio) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_PHASE_VOCODER) return WEBRC_DSP_BAD_KIND;
    if (!inputInterleavedComplex || !outputInterleavedComplex || !std::isfinite(pitchRatio))
        return WEBRC_DSP_BAD_ARGUMENT;
    return payload<PhaseVocoder>(*state)->processSpectrumFrame(
               reinterpret_cast<const std::complex<float>*>(inputInterleavedComplex),
               reinterpret_cast<std::complex<float>*>(outputInterleavedComplex), pitchRatio)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_process_pitch_buffer(WebrcDspHandle handle,
                                                      const float* input, float* output,
                                                      std::uint32_t frames,
                                                      float sourcePeriodSamples,
                                                      float pitchRatio) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_TD_PSOLA_BUFFER) return WEBRC_DSP_BAD_KIND;
    if (frames > payload<TdPsolaPitchShifter>(*state)->maximumBufferFrames())
        return WEBRC_DSP_BLOCK_TOO_LARGE;
    return payload<TdPsolaPitchShifter>(*state)->processBuffer(
               input, output, frames, sourcePeriodSamples, pitchRatio)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_yin_analyze(WebrcDspHandle handle, const float* input,
                                            std::uint32_t frames,
                                            WebrcDspPitchEstimate* estimate) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_YIN_PITCH) return WEBRC_DSP_BAD_KIND;
    if (!estimate) return WEBRC_DSP_BAD_ARGUMENT;
    PitchEstimate result{};
    if (!payload<YinPitchDetector>(*state)->analyze(input, frames, result)) return WEBRC_DSP_BAD_ARGUMENT;
    *estimate = {result.frequencyHz, result.periodSamples, result.confidence,
                 result.rms, result.voiced ? 1U : 0U};
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_process_yin(WebrcDspHandle handle, const float* input,
                                            std::uint32_t frames) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_INCREMENTAL_YIN) return WEBRC_DSP_BAD_KIND;
    const auto frameStatus = checkFrames(*state, frames);
    if (frameStatus != WEBRC_DSP_OK) return frameStatus;
    auto& detector = *payload<IncrementalYinDetector>(*state);
    if (!detector.processBlock(input, frames)) return WEBRC_DSP_BAD_ARGUMENT;
    if (state->firstEstimateColdStartFrames == 0U && detector.analysisCount() != 0U)
        state->firstEstimateColdStartFrames = detector.totalInputFrames();
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_pitch_get_estimate(WebrcDspHandle handle,
                                                   WebrcDspPitchEstimate* estimate) {
    if (!estimate) return WEBRC_DSP_BAD_ARGUMENT;
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    PitchEstimate result{};
    std::uint64_t analysisCount = 0U, totalInputFrames = 0U, latestWindowEndFrame = 0U;
    const auto resultStatus = pitchEstimateFor(*state, result, analysisCount,
                                               totalInputFrames, latestWindowEndFrame);
    if (resultStatus != WEBRC_DSP_OK) return resultStatus;
    *estimate = {result.frequencyHz, result.periodSamples, result.confidence,
                 result.rms, result.voiced ? 1U : 0U};
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_pitch_get_metrics(WebrcDspHandle handle,
                                                  WebrcDspPitchRuntimeMetrics* metrics) {
    if (!metrics) return WEBRC_DSP_BAD_ARGUMENT;
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    *metrics = {};
    metrics->preparedKind = state->kind;
    metrics->analysisHopFrames = state->pitchHopFrames;
    metrics->firstEstimateColdStartFrames = state->firstEstimateColdStartFrames;
    if (state->kind == WEBRC_DSP_EXT_INCREMENTAL_YIN) {
        const auto& detector = *payload<IncrementalYinDetector>(*state);
        metrics->analysisCount = detector.analysisCount();
        metrics->totalInputFrames = detector.totalInputFrames();
        metrics->latestWindowEndFrame = detector.latestWindowEndFrame();
        metrics->analysisBusy = detector.analysisBusy() ? 1U : 0U;
        metrics->analysisWindowFrames = detector.windowFrames();
        metrics->latestProcessingLagFrames = detector.latestProcessingLagFrames();
        const auto age = metrics->totalInputFrames >= metrics->latestWindowEndFrame
            ? metrics->totalInputFrames - metrics->latestWindowEndFrame : 0U;
        metrics->estimateAgeFrames = static_cast<std::uint32_t>(
            std::min<std::uint64_t>(age, UINT32_MAX));
        metrics->lastWorkUnits = detector.lastWorkUnits();
        metrics->workBudgetPerCallback = detector.workUnitsPerBlock();
        metrics->latencyModel = 1U; // Window-availability observation; no PSOLA stage.
        return WEBRC_DSP_OK;
    }
    if (state->kind == WEBRC_DSP_EXT_LIVE_MONO_PITCH) {
        const auto& route = *payload<LiveMonoPitchRoute>(*state);
        metrics->analysisCount = route.analysisCount();
        metrics->totalInputFrames = route.inputFrames();
        metrics->latestWindowEndFrame = route.estimateWindowEndFrame();
        metrics->analysisWindowFrames = route.analysisWindowFrames();
        metrics->latestProcessingLagFrames = route.observedDetectorProcessingLagFrames();
        metrics->estimateAgeFrames = route.latestEstimateAgeFrames();
        // The route owns a synchronous detector adapter and does not expose
        // an analysis-busy query. Keep this unavailable instead of reporting
        // a fabricated idle state.
        metrics->analysisBusy = UINT32_MAX;
        metrics->lastWorkUnits = route.lastAnalysisWorkUnits();
        metrics->workBudgetPerCallback = route.analysisWorkBudgetPerCallback();
        metrics->resynthesisLatencySamples = route.resynthesisLatencySamples();
        metrics->declaredDetectorPlusResynthesisLatencySamples =
            route.declaredDetectorPlusResynthesisLatencySamples();
        metrics->pitchRatio = route.pitchRatio();
        metrics->latencyModel = 2U; // Detector window plus PSOLA lookahead bound.
        return WEBRC_DSP_OK;
    }
    return WEBRC_DSP_BAD_KIND;
}

std::int32_t webrc_dsp_extended_streaming_set_pitch(WebrcDspHandle handle,
                                                    const WebrcDspPitchEstimate* estimate,
                                                    float pitchRatio) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_STREAMING_TD_PSOLA) return WEBRC_DSP_BAD_KIND;
    if (!estimate || estimate->voiced > 1U) return WEBRC_DSP_BAD_ARGUMENT;
    const PitchEstimate nativeEstimate{estimate->frequencyHz, estimate->periodSamples,
                                       estimate->confidence, estimate->rms,
                                       estimate->voiced != 0U};
    return payload<StreamingTdPsolaPitchShifter>(*state)->setPitchEstimate(nativeEstimate, pitchRatio)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_pattern_set_gains(WebrcDspHandle handle,
                                                   const float* gains,
                                                   std::uint32_t stepCount,
                                                   float edgeFraction) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_PATTERN_SLICER) return WEBRC_DSP_BAD_KIND;
    return payload<PatternSlicer>(*state)->setPattern(gains, stepCount, edgeFraction)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_schedule_absolute(WebrcDspHandle handle,
                                                   std::uint64_t absoluteFrame,
                                                   std::uint32_t eventId, float value) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_SAMPLE_ACCURATE_SCHEDULER) return WEBRC_DSP_BAD_KIND;
    return payload<SampleAccurateScheduler>(*state)->scheduleAbsolute({absoluteFrame, eventId, value, 0U, false})
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_schedule_tick(WebrcDspHandle handle,
                                               std::uint64_t originFrame,
                                               std::uint64_t tick,
                                               std::uint32_t eventId, float value) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_SAMPLE_ACCURATE_SCHEDULER) return WEBRC_DSP_BAD_KIND;
    return payload<SampleAccurateScheduler>(*state)->scheduleTick(originFrame, tick, eventId, value)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_collect_events(WebrcDspHandle handle,
                                                std::uint64_t blockStartFrame,
                                                std::uint32_t frames,
                                                WebrcDspScheduledEvent* output,
                                                std::uint32_t outputCapacity,
                                                std::uint32_t* outputCount) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_SAMPLE_ACCURATE_SCHEDULER) return WEBRC_DSP_BAD_KIND;
    if (frames > state->spec.maxBlockFrames) return WEBRC_DSP_BLOCK_TOO_LARGE;
    if (!output || !outputCount) return WEBRC_DSP_BAD_ARGUMENT;
    std::array<ScheduledEvent, SampleAccurateScheduler::kCapacity> nativeEvents{};
    std::uint32_t count = 0U;
    if (!payload<SampleAccurateScheduler>(*state)->collectBlock(
            blockStartFrame, frames, nativeEvents.data(),
            std::min(outputCapacity, static_cast<std::uint32_t>(nativeEvents.size())), count))
        return WEBRC_DSP_BAD_ARGUMENT;
    for (std::uint32_t index = 0; index < count; ++index) {
        const auto& event = nativeEvents[index];
        output[index] = {event.absoluteFrame, event.eventId, event.value,
                         event.blockOffset, event.late ? 1U : 0U};
    }
    *outputCount = count;
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_set_impulse_response(WebrcDspHandle handle,
                                                      std::uint32_t frames,
                                                      const float* ll, const float* lr,
                                                      const float* rl, const float* rr) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind == WEBRC_DSP_EXT_FDN_REVERB)
        return payload<FdnReverb>(*state)->setEarlyImpulseResponse(frames, ll, lr, rl, rr)
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    return WEBRC_DSP_BAD_KIND;
}

std::int32_t webrc_dsp_extended_trigger_drum(WebrcDspHandle handle,
                                              std::uint32_t voiceType,
                                              const void* parameters,
                                              std::uint32_t parameterBytes) {
    ExtendedState* state = nullptr;
    const auto status = extendedStateFor(handle, state);
    if (status != WEBRC_DSP_OK) return status;
    if (state->kind != WEBRC_DSP_EXT_DRUM_VOICE_POOL) return WEBRC_DSP_BAD_KIND;
    if (!parameters) return WEBRC_DSP_BAD_ARGUMENT;
    auto& pool = *payload<DrumVoicePool>(*state);
    switch (voiceType) {
    case WEBRC_DSP_EXT_DRUM_MODAL: {
        if (parameterBytes != sizeof(WebrcDspDrumVoiceParameters)) break;
        const auto& p = *static_cast<const WebrcDspDrumVoiceParameters*>(parameters);
        return pool.triggerModal({p.fundamentalHz, p.decaySeconds, p.tone, p.noise,
                                  p.amplitude, p.stereoWidth, p.seed})
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    }
    case WEBRC_DSP_EXT_DRUM_KICK: {
        if (parameterBytes != sizeof(WebrcDspKickVoiceParameters)) break;
        const auto& p = *static_cast<const WebrcDspKickVoiceParameters*>(parameters);
        return pool.triggerKick({p.startFrequencyHz, p.endFrequencyHz, p.sweepSeconds,
                                 p.decaySeconds, p.amplitude})
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    }
    case WEBRC_DSP_EXT_DRUM_SNARE: {
        if (parameterBytes != sizeof(WebrcDspSnareVoiceParameters)) break;
        const auto& p = *static_cast<const WebrcDspSnareVoiceParameters*>(parameters);
        return pool.triggerSnare({p.bodyFrequencyHz, p.bodyDecaySeconds, p.noiseDecaySeconds,
                                  p.noiseLevel, p.amplitude, p.stereoWidth, p.seed})
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    }
    case WEBRC_DSP_EXT_DRUM_HIHAT: {
        if (parameterBytes != sizeof(WebrcDspHiHatVoiceParameters)) break;
        const auto& p = *static_cast<const WebrcDspHiHatVoiceParameters*>(parameters);
        return pool.triggerHiHat({p.baseFrequencyHz, p.decaySeconds, p.noiseLevel,
                                  p.amplitude, p.stereoWidth, p.seed})
                   ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
    }
    default:
        return WEBRC_DSP_BAD_ARGUMENT;
    }
    return WEBRC_DSP_BAD_ARGUMENT;
}

std::uint32_t webrc_dsp_extended_input_latency_samples(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    if (extendedStateFor(handle, state) != WEBRC_DSP_OK) return 0U;
    if (state->kind == WEBRC_DSP_EXT_SIGNALSMITH_STRETCH) {
        const auto latency = payload<SignalsmithStretchAdapter>(*state)->inputLatencySamples();
        return latency > 0 ? static_cast<std::uint32_t>(latency) : 0U;
    }
    return 0U;
}

std::uint32_t webrc_dsp_extended_output_latency_samples(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    if (extendedStateFor(handle, state) != WEBRC_DSP_OK) return 0U;
    switch (state->kind) {
    case WEBRC_DSP_EXT_STREAMING_TD_PSOLA:
        return payload<StreamingTdPsolaPitchShifter>(*state)->latencySamples();
    case WEBRC_DSP_EXT_LIVE_MONO_PITCH:
        return payload<LiveMonoPitchRoute>(*state)->resynthesisLatencySamples();
    case WEBRC_DSP_EXT_SIGNALSMITH_STRETCH: {
        const auto latency = payload<SignalsmithStretchAdapter>(*state)->outputLatencySamples();
        return latency > 0 ? static_cast<std::uint32_t>(latency) : 0U;
    }
    case WEBRC_DSP_EXT_PARTITIONED_CONVOLVER:
        return payload<PartitionedConvolver>(*state)->algorithmicLatencySamples();
    case WEBRC_DSP_EXT_SPECTRAL_FREEZE:
        return payload<SpectralFreeze>(*state)->algorithmicLatencySamples();
    case WEBRC_DSP_EXT_REVERSE_SEGMENT:
        return payload<ReverseSegment>(*state)->algorithmicLatencySamples();
    case WEBRC_DSP_EXT_RHYTHM_RENDERER:
        return RhythmRenderer::algorithmicLatencySamples();
    default:
        return 0U;
    }
}

std::uint32_t webrc_dsp_extended_rhythm_pattern_count(void) {
    return cleanRoomRhythmPatternCount();
}

std::uint32_t webrc_dsp_extended_rhythm_kit_count(void) {
    return cleanRoomKitCount();
}

const char* webrc_dsp_extended_rhythm_patterns_sha256(void) {
    return cleanRoomRhythmPatternsSha256();
}

const char* webrc_dsp_extended_rhythm_kits_sha256(void) {
    return cleanRoomKitProfilesSha256();
}

std::uint32_t webrc_dsp_extended_rhythm_algorithmic_latency_samples(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    if (rhythmStateFor(handle, state, renderer) != WEBRC_DSP_OK) return 0U;
    return renderer->algorithmicLatencySamples();
}

std::int32_t webrc_dsp_extended_rhythm_get_metrics(WebrcDspHandle handle,
                                                   WebrcDspRhythmMetrics* metrics) {
    if (!metrics) return WEBRC_DSP_BAD_ARGUMENT;
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    *metrics = {
        renderer->playing() ? 1U : 0U,
        static_cast<std::uint32_t>(renderer->currentSection()),
        renderer->currentVariation(),
        renderer->activeVoices(),
        renderer->activeBrushSweepVoices(),
        renderer->retiringBrushSweepVoices(),
        renderer->completedBars(),
        renderer->triggeredEvents(),
        renderer->lastTriggeredFrame(),
        renderer->tempoBpm(),
    };
    return WEBRC_DSP_OK;
}

std::int32_t webrc_dsp_extended_rhythm_set_pattern(WebrcDspHandle handle,
                                                   std::uint32_t patternIndex) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    const auto* pattern = cleanRoomRhythmPattern(patternIndex);
    if (!pattern) return WEBRC_DSP_BAD_ARGUMENT;
    return renderer->setPattern(pattern) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_set_kit(WebrcDspHandle handle,
                                               std::uint32_t kitIndex) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    return renderer->setKit(kitIndex) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_queue_pattern_kit(WebrcDspHandle handle,
                                                        std::uint32_t patternIndex,
                                                        std::uint32_t kitIndex) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    return renderer->queuePatternKit(patternIndex, kitIndex)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::uint32_t webrc_dsp_extended_rhythm_selected_pattern(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    if (rhythmStateFor(handle, state, renderer) != WEBRC_DSP_OK) return UINT32_MAX;
    return renderer->selectedPatternIndex();
}

std::uint32_t webrc_dsp_extended_rhythm_selected_kit(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    if (rhythmStateFor(handle, state, renderer) != WEBRC_DSP_OK) return UINT32_MAX;
    return renderer->selectedKitIndex();
}

std::int32_t webrc_dsp_extended_rhythm_start(WebrcDspHandle handle,
                                              std::uint64_t absoluteFrame,
                                              std::uint32_t playIntro) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    if (playIntro > 1U) return WEBRC_DSP_BAD_ARGUMENT;
    return renderer->startAtFrame(absoluteFrame, playIntro != 0U)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_start_words(WebrcDspHandle handle,
                                                   std::uint32_t frameLow,
                                                   std::uint32_t frameHigh,
                                                   std::uint32_t playIntro) {
    if (playIntro > 1U) return WEBRC_DSP_BAD_ARGUMENT;
    const std::uint64_t frame = static_cast<std::uint64_t>(frameLow) |
                                (static_cast<std::uint64_t>(frameHigh) << 32U);
    return webrc_dsp_extended_rhythm_start(handle, frame, playIntro);
}

std::int32_t webrc_dsp_extended_rhythm_queue_variation(WebrcDspHandle handle,
                                                       std::uint32_t variation) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    if (variation > 3U) return WEBRC_DSP_BAD_ARGUMENT;
    return renderer->queueVariation(static_cast<std::uint8_t>(variation))
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_queue_fill(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    return renderer->queueFill() ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_queue_ending(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    return renderer->queueEnding() ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_queue_stop(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    return renderer->queueStop() ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_queue_tempo(WebrcDspHandle handle, double bpm) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    return renderer->queueTempo(bpm) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_process_block(WebrcDspHandle handle,
                                                     std::uint64_t blockStartFrame,
                                                     float* outputLeft,
                                                     float* outputRight,
                                                     std::uint32_t frames) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    const auto status = rhythmStateFor(handle, state, renderer);
    if (status != WEBRC_DSP_OK) return status;
    if (frames > state->spec.maxBlockFrames) return WEBRC_DSP_BLOCK_TOO_LARGE;
    if (!outputLeft || !outputRight) return WEBRC_DSP_BAD_ARGUMENT;
    return renderer->processBlock(blockStartFrame, outputLeft, outputRight, frames)
               ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_rhythm_process_block_words(WebrcDspHandle handle,
                                                           std::uint32_t frameLow,
                                                           std::uint32_t frameHigh,
                                                           float* outputLeft,
                                                           float* outputRight,
                                                           std::uint32_t frames) {
    const std::uint64_t frame = static_cast<std::uint64_t>(frameLow) |
                                (static_cast<std::uint64_t>(frameHigh) << 32U);
    return webrc_dsp_extended_rhythm_process_block(handle, frame, outputLeft, outputRight, frames);
}

std::uint32_t webrc_dsp_extended_rhythm_is_playing(WebrcDspHandle handle) {
    ExtendedState* state = nullptr;
    RhythmRenderer* renderer = nullptr;
    if (rhythmStateFor(handle, state, renderer) != WEBRC_DSP_OK) return 0U;
    return renderer->playing() ? 1U : 0U;
}

std::int32_t webrc_dsp_extended_fft_transform(float* interleavedComplex,
                                              std::uint32_t complexCount,
                                              std::uint32_t direction) {
    if (!interleavedComplex || direction > 1U) return WEBRC_DSP_BAD_ARGUMENT;
    const auto fftDirection = direction == 0U ? fft::Direction::Forward : fft::Direction::Inverse;
    return fft::transform(reinterpret_cast<std::complex<float>*>(interleavedComplex),
                          complexCount, fftDirection) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_normalized_hadamard(float* values,
                                                    std::uint32_t count) {
    return normalizedHadamard(values, count) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

std::int32_t webrc_dsp_extended_pitch_ratio(float semitones, float* ratio) {
    if (!ratio) return WEBRC_DSP_BAD_ARGUMENT;
    return pitchRatioSemitones(semitones, *ratio) ? WEBRC_DSP_OK : WEBRC_DSP_BAD_ARGUMENT;
}

} // extern "C"
