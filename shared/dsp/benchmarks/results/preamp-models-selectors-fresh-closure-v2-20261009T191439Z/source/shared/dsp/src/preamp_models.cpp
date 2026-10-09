#include "webrc/dsp/preamp_models.hpp"

#include "webrc/dsp/fft.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_PREAMP_MODELS_TRY try
#define WEBRC_PREAMP_MODELS_CATCH_ALL catch (...)
#else
#define WEBRC_PREAMP_MODELS_TRY if (true)
#define WEBRC_PREAMP_MODELS_CATCH_ALL else if (false)
#endif

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::uint64_t kMaximumExactlyRepresentableFrame = 9007199254740992ULL;
constexpr std::size_t kAllocatorAllowanceBytes = 64U * 1024U;
constexpr std::size_t kMaximumPreparedBytes = 32U * 1024U * 1024U;
constexpr float kMinimumSampleRate = 24000.0f;
constexpr float kMaximumSampleRate = 192000.0f;

[[nodiscard]] bool finiteRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] bool validSpec(const ProcessSpec& spec) noexcept {
    return validProcessSpec(spec) && spec.channels == 2U &&
        spec.sampleRate >= kMinimumSampleRate && spec.sampleRate <= kMaximumSampleRate &&
        spec.maxBlockFrames <= PreampModelFxProcessor::kMaximumBlockFrames;
}

[[nodiscard]] std::uint32_t roundedSamples(float sampleRate, double milliseconds) noexcept {
    const double samples = static_cast<double>(sampleRate) * milliseconds * 0.001;
    if (!std::isfinite(samples) || samples < 0.0 ||
        samples > static_cast<double>(std::numeric_limits<std::uint32_t>::max())) return 0U;
    return static_cast<std::uint32_t>(std::floor(samples + 0.5));
}

struct SpeakerProfile {
    double lowModeHz;
    double lowDecayMs;
    double lowAmplitude;
    double midModeHz;
    double midDecayMs;
    double midAmplitude;
    double highModeHz;
    double highDecayMs;
    double highAmplitude;
    double responseMs;
};

// These are clean-room cabinet resonator profiles. They model different
// frequency-dependent impulse responses; they are not copied from Roland data.
constexpr std::array<SpeakerProfile, 8U> kSpeakerProfiles{{
    {84.0, 14.0, 0.0068, 710.0, 9.5, 0.0050, 3450.0, 4.2, 0.0028, 17.0},
    {116.0, 6.0, 0.0088, 1380.0, 4.4, 0.0058, 5600.0, 2.1, 0.0032, 10.0},
    {94.0, 8.0, 0.0074, 920.0, 5.8, 0.0054, 4300.0, 2.7, 0.0030, 12.0},
    {76.0, 10.5, 0.0078, 635.0, 7.2, 0.0055, 3180.0, 3.1, 0.0031, 14.0},
    {71.0, 13.0, 0.0081, 545.0, 8.0, 0.0058, 2910.0, 3.7, 0.0032, 16.0},
    {102.0, 7.5, 0.0070, 510.0, 5.1, 0.0051, 4160.0, 2.6, 0.0035, 12.0},
    {64.0, 15.0, 0.0085, 420.0, 9.0, 0.0060, 2520.0, 4.3, 0.0035, 18.0},
    {58.0, 16.5, 0.0090, 355.0, 9.8, 0.0063, 2180.0, 4.7, 0.0037, 19.0},
}};

struct MicProfile {
    float highPassHz;
    float presenceHz;
    float presenceDb;
    float presenceQ;
    float topShelfHz;
    float topShelfDb;
};

struct AmpVoicingProfile {
    float inputHighpassHz;
    float nonlinearEmphasisHz;
    float nonlinearEmphasisDb;
    float nonlinearEmphasisQ;
    float inputLowpassHz;
};

// Local clean-room circuit voicings. The pre-emphasis is before the nonlinear
// core, so it changes which parts of the signal drive the circuit instead of
// applying a cosmetic output gain after it.
constexpr std::array<AmpVoicingProfile, 9U> kAmpVoicings{{
    {28.0f, 1850.0f, 0.4f, 0.75f, 14500.0f}, // JC-120
    {24.0f, 2400.0f, 0.2f, 0.75f, 13500.0f}, // Natural Clean
    {18.0f, 1200.0f, 0.0f, 0.75f, 11000.0f}, // Full Range
    {58.0f, 950.0f, 1.7f, 0.85f, 9000.0f},   // Combo Crunch
    {76.0f, 1450.0f, 1.9f, 0.90f, 10000.0f}, // Stack Crunch
    {98.0f, 2350.0f, 2.8f, 1.00f, 8500.0f},  // High-gain stack
    {48.0f, 690.0f, 2.2f, 0.80f, 6900.0f},   // Power drive
    {112.0f, 1750.0f, 3.2f, 1.10f, 7600.0f}, // Extreme lead
    {136.0f, 2650.0f, 3.6f, 1.20f, 6700.0f}, // Core metal
}};

constexpr std::array<MicProfile, 5U> kMicProfiles{{
    {78.0f, 5100.0f, 2.8f, 0.85f, 10500.0f, -1.8f}, // DYN57
    {48.0f, 3150.0f, 1.8f, 0.95f, 11200.0f, -1.0f}, // DYN421
    {32.0f, 4600.0f, 2.1f, 0.75f, 8500.0f, 1.2f},   // CND451
    {24.0f, 3900.0f, 1.4f, 0.78f, 9800.0f, 0.8f},   // CND87
    {0.0f, 1000.0f, 0.0f, 0.707f, 1000.0f, 0.0f},   // FLAT
}};

[[nodiscard]] BiquadCoefficients identityCoefficients() noexcept {
    return {};
}

[[nodiscard]] float finiteAudio(float value) noexcept {
    return std::isfinite(value) && std::fabs(value) >= 1.0e-20f ? value : 0.0f;
}

} // namespace

bool PreampModelFxProcessor::validOptions(const PreampModelOptions& options) noexcept {
    return static_cast<std::uint8_t>(options.ampType) <=
               static_cast<std::uint8_t>(PreampAmpModel::CoreMetal) &&
        static_cast<std::uint8_t>(options.speakerType) <=
               static_cast<std::uint8_t>(PreampSpeakerModel::EightByTwelve) &&
        static_cast<std::uint8_t>(options.micType) <=
               static_cast<std::uint8_t>(PreampMicModel::Flat) &&
        static_cast<std::uint8_t>(options.micDistance) <=
               static_cast<std::uint8_t>(PreampMicDistance::OnMic) &&
        options.micPositionCm <= 10U &&
        fft::isPowerOfTwo(options.cabinetPartitionFrames) &&
        options.cabinetPartitionFrames >= 16U && options.cabinetPartitionFrames <= 2048U &&
        finiteRange(options.controlSmoothingMs, 1.0f, 100.0f) &&
        finiteRange(options.toneCoefficientSmoothingMs, 1.0f, 100.0f);
}

std::uint32_t PreampModelFxProcessor::generatedIrFrames(
    const ProcessSpec& spec, PreampSpeakerModel speaker) noexcept {
    if (static_cast<std::uint8_t>(speaker) >
        static_cast<std::uint8_t>(PreampSpeakerModel::EightByTwelve)) return 0U;
    if (speaker == PreampSpeakerModel::Off) return 1U;
    const auto profileIndex = static_cast<std::size_t>(speaker) - 1U;
    const auto& profile = kSpeakerProfiles[profileIndex];
    const double requested = static_cast<double>(spec.sampleRate) *
        profile.responseMs * 0.001;
    if (!std::isfinite(requested) || requested < 1.0) return 0U;
    const auto rounded = static_cast<std::uint64_t>(std::ceil(requested));
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(
        rounded, kMaximumModelIrFrames));
}

std::size_t PreampModelFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const PreampModelOptions& options) noexcept {
    if (!validSpec(spec) || !validOptions(options)) return 0U;
    const std::uint32_t irFrames = generatedIrFrames(spec, options.speakerType);
    if (irFrames == 0U || irFrames > kMaximumModelIrFrames) return 0U;
    const PreampFxOptions coreOptions{
        NonlinearModel::WdfSymmetricDiode,
        options.cabinetPartitionFrames,
        diodeProfile(options.ampType).portResistance,
        diodeProfile(options.ampType).saturationCurrent,
        diodeProfile(options.ampType).thermalVoltage,
        diodeProfile(options.ampType).ideality,
        options.controlSmoothingMs,
        options.toneCoefficientSmoothingMs,
    };
    const auto coreBytes = PreampFxProcessor::requiredPrepareBytes(spec, coreOptions, irFrames);
    if (coreBytes < sizeof(PreampFxProcessor)) return 0U;
    const std::uint64_t scratchBytes =
        2ULL * static_cast<std::uint64_t>(spec.maxBlockFrames) * sizeof(float);
    const std::uint64_t total = sizeof(PreampModelFxProcessor) +
        static_cast<std::uint64_t>(coreBytes - sizeof(PreampFxProcessor)) +
        scratchBytes + kAllocatorAllowanceBytes;
    if (total > kMaximumPreparedBytes || total > std::numeric_limits<std::size_t>::max())
        return 0U;
    return static_cast<std::size_t>(total);
}

std::size_t PreampModelFxProcessor::replacementPeakBytes(
    std::size_t activePreparedBytes, const ProcessSpec& spec,
    const PreampModelOptions& options) noexcept {
    const std::size_t candidate = requiredPrepareBytes(spec, options);
    if (candidate == 0U || activePreparedBytes >
        std::numeric_limits<std::size_t>::max() - candidate) return 0U;
    return activePreparedBytes + candidate;
}

PreampModelFxProcessor::DiodeProfile PreampModelFxProcessor::diodeProfile(
    PreampAmpModel model) noexcept {
    // Each amp selector changes the local diode circuit parameters, not a
    // post-nonlinear scalar. Values are authored here as model assumptions.
    switch (model) {
    case PreampAmpModel::JC120:       return {1500.0, 1.6e-9, 0.02585, 1.00};
    case PreampAmpModel::NaturalClean:return {2700.0, 0.8e-9, 0.02800, 1.15};
    case PreampAmpModel::FullRange:   return {5600.0, 0.3e-9, 0.03300, 1.30};
    case PreampAmpModel::ComboCrunch:return {1000.0, 2.0e-9, 0.02585, 1.00};
    case PreampAmpModel::StackCrunch:return {680.0, 3.0e-9, 0.02585, 1.10};
    case PreampAmpModel::HighGainStack:return {330.0, 6.0e-9, 0.02600, 1.20};
    case PreampAmpModel::PowerDrive:  return {470.0, 5.0e-9, 0.02800, 1.25};
    case PreampAmpModel::ExtremLead:  return {220.0, 1.2e-8, 0.02500, 1.30};
    case PreampAmpModel::CoreMetal:   return {150.0, 2.0e-8, 0.02585, 1.50};
    }
    return {0.0, 0.0, 0.0, 0.0};
}

void PreampModelFxProcessor::generateSpeakerIr(
    const ProcessSpec& spec, PreampSpeakerModel speaker) noexcept {
    for (auto& channel : speakerIr_) channel.fill(0.0f);
    speakerIrFrames_ = generatedIrFrames(spec, speaker);
    if (speakerIrFrames_ == 0U) return;
    if (speaker == PreampSpeakerModel::Off) {
        speakerIr_[0U][0U] = 1.0f;
        speakerIr_[1U][0U] = 1.0f;
        return;
    }

    const auto profileIndex = static_cast<std::size_t>(speaker) - 1U;
    const auto& profile = kSpeakerProfiles[profileIndex];
    const std::uint32_t reflection = roundedSamples(spec.sampleRate, 0.32);
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        const double detune = channel == 0U ? 1.0 : 1.004;
        auto* ir = speakerIr_[channel].data();
        ir[0U] = 0.72f;
        if (reflection < speakerIrFrames_) ir[reflection] += 0.11f;
        const std::array<double, 3U> frequencies{
            profile.lowModeHz, profile.midModeHz, profile.highModeHz};
        const std::array<double, 3U> decays{
            profile.lowDecayMs, profile.midDecayMs, profile.highDecayMs};
        const std::array<double, 3U> amplitudes{
            profile.lowAmplitude, profile.midAmplitude, profile.highAmplitude};
        for (std::uint32_t frame = 0U; frame < speakerIrFrames_; ++frame) {
            if (frame == 0U) continue;
            double sample = ir[frame];
            const double timeSeconds = static_cast<double>(frame) / spec.sampleRate;
            for (std::size_t mode = 0U; mode < frequencies.size(); ++mode) {
                const double frequency = frequencies[mode] * detune;
                const double decaySeconds = decays[mode] * 0.001;
                const double envelope = std::exp(-timeSeconds / decaySeconds);
                const double phase = 2.0 * kPi * frequency * timeSeconds +
                    (0.31 * static_cast<double>(mode) +
                     0.17 * static_cast<double>(channel));
                sample += amplitudes[mode] * envelope * std::sin(phase);
            }
            ir[frame] = static_cast<float>(sample);
        }
    }
}

bool PreampModelFxProcessor::prepareMicFilters(
    const ProcessSpec& spec, const PreampModelOptions& options) noexcept {
    const auto micIndex = static_cast<std::size_t>(options.micType);
    if (micIndex >= kMicProfiles.size()) return false;
    const auto& mic = kMicProfiles[micIndex];
    const float position = static_cast<float>(options.micPositionCm) / 10.0f;
    const float positionShelfHz = 6500.0f + 1800.0f * (1.0f - position);
    const float positionShelfDb = -5.0f * position;
    for (auto& channel : micFilters_) {
        for (auto& filter : channel) if (!filter.prepare(spec)) return false;
        if (options.micType == PreampMicModel::Flat) {
            if (!channel[0U].setCoefficients(identityCoefficients()) ||
                !channel[1U].setCoefficients(identityCoefficients()) ||
                !channel[2U].setHighShelf(positionShelfHz, positionShelfDb, 0.8f, 0.0f))
                return false;
        } else {
            if (!channel[0U].setHighpass(mic.highPassHz, 0.707f, 0.0f) ||
                !channel[1U].setPeaking(mic.presenceHz, mic.presenceQ,
                                        mic.presenceDb, 0.0f) ||
                !channel[2U].setHighShelf(mic.topShelfHz,
                    mic.topShelfDb + positionShelfDb, 0.8f, 0.0f)) return false;
        }
        if (options.micDistance == PreampMicDistance::OffMic) {
            if (!channel[3U].setLowpass(7200.0f, 0.707f, 0.0f)) return false;
        } else if (!channel[3U].setCoefficients(identityCoefficients())) {
            return false;
        }
    }
    return true;
}

bool PreampModelFxProcessor::prepareAmpFilters(
    const ProcessSpec& spec, PreampAmpModel amp) noexcept {
    const auto index = static_cast<std::size_t>(amp);
    if (index >= kAmpVoicings.size()) return false;
    const auto& profile = kAmpVoicings[index];
    const float maximumFrequency = spec.sampleRate * 0.45f;
    for (auto& channel : ampFilters_) {
        for (auto& filter : channel) if (!filter.prepare(spec)) return false;
        if (!channel[0U].setHighpass(profile.inputHighpassHz, 0.707f, 0.0f) ||
            !channel[1U].setPeaking(profile.nonlinearEmphasisHz,
                profile.nonlinearEmphasisQ, profile.nonlinearEmphasisDb, 0.0f) ||
            !channel[2U].setLowpass(std::min(profile.inputLowpassHz, maximumFrequency),
                                    0.707f, 0.0f)) return false;
    }
    return true;
}

bool PreampModelFxProcessor::prepare(const ProcessSpec& spec,
                                    const PreampModelOptions& options) {
    prepared_ = false;
    if (!validSpec(spec) || !validOptions(options)) return false;
    const std::size_t admittedBytes = requiredPrepareBytes(spec, options);
    if (admittedBytes == 0U) return false;

    generateSpeakerIr(spec, options.speakerType);
    if (speakerIrFrames_ == 0U) return false;
    const auto circuit = diodeProfile(options.ampType);
    const PreampFxOptions coreOptions{
        NonlinearModel::WdfSymmetricDiode,
        options.cabinetPartitionFrames,
        circuit.portResistance,
        circuit.saturationCurrent,
        circuit.thermalVoltage,
        circuit.ideality,
        options.controlSmoothingMs,
        options.toneCoefficientSmoothingMs,
    };

    WEBRC_PREAMP_MODELS_TRY {
        std::array<std::vector<float>, 2U> candidateDryBlock;
        for (auto& channel : candidateDryBlock)
            channel.assign(spec.maxBlockFrames, 0.0f);
        const PreampCabinetIr ir{speakerIrFrames_, speakerIr_[0U].data(),
                                 speakerIr_[1U].data()};
        if (!core_.prepare(spec, coreOptions, ir) ||
            !prepareMicFilters(spec, options) ||
            !prepareAmpFilters(spec, options.ampType)) return false;
        // Prime the internal wet-only core while still on the control thread.
        // reset() preserves its target controls, so its Active/Mix remain 1
        // without reserving callback event slots or applying a cold fade twice.
        StereoFrame prime{};
        const PreampFxEvent enable{0U, PreampFxControl::Active, 1.0f};
        if (!core_.processBlock(0U, &prime, 1U, &enable, 1U)) return false;
        core_.reset(0U);
        dryAlignedBlock_ = std::move(candidateDryBlock);
    } WEBRC_PREAMP_MODELS_CATCH_ALL {
        return false;
    }

    spec_ = spec;
    options_ = options;
    const auto coreLatency = core_.latency();
    fixedDelaySamples_ = coreLatency.fixedAlgorithmicSamples;
    if (fixedDelaySamples_ > kMaximumFixedDelaySamples) return false;
    const double directMs = options.micDistance == PreampMicDistance::OnMic ? 0.125 : 1.5;
    const double reflectionExtraMs = options.micDistance == PreampMicDistance::OnMic
        ? 0.25 : 2.0;
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        micDelaySamples_[channel] = std::max(1U, roundedSamples(spec.sampleRate, directMs));
        micReflectionDelaySamples_[channel] = micDelaySamples_[channel] +
            roundedSamples(spec.sampleRate, reflectionExtraMs);
        if (micReflectionDelaySamples_[channel] >= kMaximumMicDistanceRingSamples)
            return false;
        micDelay_[channel].fill(0.0f);
        dryDelay_[channel].fill(0.0f);
    }
    preparedBytes_ = admittedBytes;
    mixSmoothingCoefficient_ = 1.0 - std::exp(
        -1.0 / (static_cast<double>(options.controlSmoothingMs) * 0.001 * spec.sampleRate));
    activeTarget_ = activeCurrent_ = 0.0f;
    mixTarget_ = mixCurrent_ = 1.0f;
    prepared_ = true;
    reset();
    return true;
}

bool PreampModelFxProcessor::validEvents(std::uint32_t frames,
    const PreampFxEvent* events, std::uint32_t eventCount) noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    std::uint32_t previousOffset = 0U;
    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        const auto& event = events[index];
        if (event.frameOffset >= frames ||
            (index != 0U && event.frameOffset < previousOffset)) return false;
        bool valid = false;
        switch (event.control) {
        case PreampFxControl::Active:
        case PreampFxControl::Mix:
            valid = finiteRange(event.value, 0.0f, 1.0f);
            break;
        case PreampFxControl::Drive:
            valid = finiteRange(event.value, 0.1f, 24.0f);
            break;
        case PreampFxControl::BassDb:
        case PreampFxControl::MidDb:
        case PreampFxControl::TrebleDb:
        case PreampFxControl::PresenceDb:
            valid = finiteRange(event.value, -12.0f, 12.0f);
            break;
        case PreampFxControl::OutputDb:
            valid = finiteRange(event.value, -24.0f, 12.0f);
            break;
        }
        if (!valid) return false;
        previousOffset = event.frameOffset;
    }
    return true;
}

void PreampModelFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    absoluteFrame = std::min(absoluteFrame, kMaximumExactlyRepresentableFrame);
    core_.reset(absoluteFrame);
    for (auto& channel : micDelay_) channel.fill(0.0f);
    for (auto& channel : dryDelay_) channel.fill(0.0f);
    for (auto& channel : dryAlignedBlock_) std::fill(channel.begin(), channel.end(), 0.0f);
    for (auto& channel : ampFilters_) for (auto& filter : channel) filter.reset();
    for (auto& channel : micFilters_) for (auto& filter : channel) filter.reset();
    micWritePosition_ = 0U;
    dryWritePosition_ = 0U;
    activeCurrent_ = activeTarget_;
    mixCurrent_ = mixTarget_;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = true;
}

void PreampModelFxProcessor::applyUserEvent(const PreampFxEvent& event) noexcept {
    switch (event.control) {
    case PreampFxControl::Active: activeTarget_ = event.value; break;
    case PreampFxControl::Mix: mixTarget_ = event.value; break;
    default: break;
    }
}

void PreampModelFxProcessor::advanceMixControls() noexcept {
    const float coefficient = static_cast<float>(mixSmoothingCoefficient_);
    activeCurrent_ += (activeTarget_ - activeCurrent_) * coefficient;
    mixCurrent_ += (mixTarget_ - mixCurrent_) * coefficient;
    if (std::fabs(activeTarget_ - activeCurrent_) < 1.0e-7f)
        activeCurrent_ = activeTarget_;
    if (std::fabs(mixTarget_ - mixCurrent_) < 1.0e-7f) mixCurrent_ = mixTarget_;
}

StereoFrame PreampModelFxProcessor::processMicAndDistance(StereoFrame wet) noexcept {
    StereoFrame output{};
    const std::array<float, 2U> input{finiteAudio(wet.left), finiteAudio(wet.right)};
    std::array<float, 2U> result{};
    for (std::size_t channel = 0U; channel < 2U; ++channel) {
        float value = input[channel];
        for (auto& filter : micFilters_[channel]) value = filter.processSample(value);
        auto& ring = micDelay_[channel];
        ring[micWritePosition_] = finiteAudio(value);
        const auto ringSize = static_cast<std::uint32_t>(ring.size());
        const auto primary = (micWritePosition_ + ringSize - micDelaySamples_[channel]) % ringSize;
        const auto reflection = (micWritePosition_ + ringSize -
            micReflectionDelaySamples_[channel]) % ringSize;
        result[channel] = finiteAudio(0.92f * ring[primary] + 0.08f * ring[reflection]);
    }
    if (++micWritePosition_ == kMaximumMicDistanceRingSamples) micWritePosition_ = 0U;
    output.left = result[0U];
    output.right = result[1U];
    return output;
}

bool PreampModelFxProcessor::processBlock(std::uint64_t blockStartFrame,
    StereoFrame* interleaved, std::uint32_t frames, const PreampFxEvent* events,
    std::uint32_t eventCount) noexcept {
    if (!prepared_ || frames > spec_.maxBlockFrames ||
        (frames != 0U && interleaved == nullptr) ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        blockStartFrame + frames > kMaximumExactlyRepresentableFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;

    std::array<PreampFxEvent, kMaximumControlEventsPerBlock> coreEvents{};
    std::uint32_t coreEventCount = 0U;
    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        const auto& event = events[index];
        if (event.control == PreampFxControl::Active || event.control == PreampFxControl::Mix)
            continue;
        if (coreEventCount == coreEvents.size()) return false;
        coreEvents[coreEventCount++] = event;
    }

    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        for (std::size_t channel = 0U; channel < 2U; ++channel) {
            const float input = std::clamp(finiteAudio(
                channel == 0U ? interleaved[frame].left : interleaved[frame].right), -8.0f, 8.0f);
            dryAlignedBlock_[channel][frame] = dryDelay_[channel][dryWritePosition_];
            dryDelay_[channel][dryWritePosition_] = input;
            float ampInput = input;
            for (auto& filter : ampFilters_[channel]) ampInput = filter.processSample(ampInput);
            if (channel == 0U) interleaved[frame].left = finiteAudio(ampInput);
            else interleaved[frame].right = finiteAudio(ampInput);
        }
        if (++dryWritePosition_ == fixedDelaySamples_) dryWritePosition_ = 0U;
    }

    if (!core_.processBlock(blockStartFrame, interleaved, frames,
            coreEventCount == 0U ? nullptr : coreEvents.data(), coreEventCount)) return false;

    std::uint32_t eventIndex = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame)
            applyUserEvent(events[eventIndex++]);
        advanceMixControls();
        const StereoFrame wet = processMicAndDistance(interleaved[frame]);
        const float blend = std::clamp(activeCurrent_ * mixCurrent_, 0.0f, 1.0f);
        interleaved[frame].left = finiteAudio(dryAlignedBlock_[0U][frame] +
            (wet.left - dryAlignedBlock_[0U][frame]) * blend);
        interleaved[frame].right = finiteAudio(dryAlignedBlock_[1U][frame] +
            (wet.right - dryAlignedBlock_[1U][frame]) * blend);
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

PreampModelLatency PreampModelFxProcessor::latency() const noexcept {
    if (!prepared_) return {};
    const auto coreLatency = core_.latency();
    return {fixedDelaySamples_, coreLatency.cabinetPartitionSamples, speakerIrFrames_,
            micDelaySamples_[0U], micReflectionDelaySamples_[0U]};
}

} // namespace webrc::dsp

#undef WEBRC_PREAMP_MODELS_TRY
#undef WEBRC_PREAMP_MODELS_CATCH_ALL
