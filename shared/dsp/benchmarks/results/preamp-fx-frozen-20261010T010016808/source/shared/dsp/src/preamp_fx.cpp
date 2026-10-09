#include "webrc/dsp/preamp_fx.hpp"

#include "webrc/dsp/fft.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>
#include <utility>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_PREAMP_TRY try
#define WEBRC_PREAMP_CATCH_ALL catch (...)
#else
// On no-exception hosts, admit the complete active + staged graph budget
// before setup. A failed allocator call is fail-fast on those runtimes.
#define WEBRC_PREAMP_TRY if (true)
#define WEBRC_PREAMP_CATCH_ALL else if (false)
#endif

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr float kMinimumSampleRate = 24000.0f;
constexpr float kMaximumSampleRate = 192000.0f;
constexpr std::uint32_t kMaximumBlockFrames = 8192U;
constexpr std::uint64_t kMaximumExactlyRepresentableFrame = 9007199254740992ULL;
constexpr std::uint64_t kMaximumPreparedBytes = 32U * 1024U * 1024U;
constexpr float kInputGuard = 8.0f;
constexpr float kOutputGuard = 16.0f;

[[nodiscard]] bool finiteRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] float cleanAudio(float value) noexcept {
    return std::isfinite(value) && std::fabs(value) >= 1.0e-20f ? value : 0.0f;
}

[[nodiscard]] bool validSpec(const ProcessSpec& spec) noexcept {
    return validProcessSpec(spec) && spec.channels == 2U &&
           spec.sampleRate >= kMinimumSampleRate && spec.sampleRate <= kMaximumSampleRate &&
           spec.maxBlockFrames <= kMaximumBlockFrames;
}

[[nodiscard]] bool validCabinetIr(const PreampCabinetIr& cabinetIr) noexcept {
    if (cabinetIr.frames == 0U || cabinetIr.frames > PreampFxProcessor::kMaximumCabinetIrFrames ||
        cabinetIr.left == nullptr) return false;
    const float* right = cabinetIr.right == nullptr ? cabinetIr.left : cabinetIr.right;
    double leftEnergy = 0.0;
    double rightEnergy = 0.0;
    for (std::uint32_t i = 0U; i < cabinetIr.frames; ++i) {
        const float left = cabinetIr.left[i];
        const float rightSample = right[i];
        if (!std::isfinite(left) || !std::isfinite(rightSample) ||
            std::fabs(left) > 8.0f || std::fabs(rightSample) > 8.0f) return false;
        leftEnergy += static_cast<double>(left) * left;
        rightEnergy += static_cast<double>(rightSample) * rightSample;
    }
    return leftEnergy > 1.0e-20 && rightEnergy > 1.0e-20;
}

[[nodiscard]] std::uint32_t shaperAlignment(const PreampFxOptions& options,
                                            const ProcessSpec& spec) noexcept {
    // The x4 31-tap half-band chain plus ADAA contributes 21.75 samples for
    // diode mode and 21.875 samples for cubic ADAA at low frequencies. Align
    // the parallel dry path to the nearest whole sample of that anchor.
    (void)options;
    (void)spec;
    return 22U;
}

} // namespace

bool PreampFxProcessor::validOptions(const PreampFxOptions& options) noexcept {
    const bool validModel = options.nonlinearModel == NonlinearModel::AdaaCubic ||
                            options.nonlinearModel == NonlinearModel::WdfSymmetricDiode;
    if (!validModel || !fft::isPowerOfTwo(options.cabinetPartitionFrames) ||
        options.cabinetPartitionFrames < 16U || options.cabinetPartitionFrames > 2048U ||
        !std::isfinite(options.controlSmoothingMs) || options.controlSmoothingMs < 1.0f ||
        options.controlSmoothingMs > 100.0f ||
        !std::isfinite(options.toneCoefficientSmoothingMs) ||
        options.toneCoefficientSmoothingMs < 1.0f ||
        options.toneCoefficientSmoothingMs > 100.0f) return false;
    if (options.nonlinearModel == NonlinearModel::AdaaCubic) return true;
    return std::isfinite(options.diodePortResistance) && options.diodePortResistance >= 1.0 &&
           options.diodePortResistance <= 1.0e6 &&
           std::isfinite(options.diodeSaturationCurrent) &&
           options.diodeSaturationCurrent >= 1.0e-12 &&
           options.diodeSaturationCurrent <= 1.0e-3 &&
           std::isfinite(options.diodeThermalVoltage) &&
           options.diodeThermalVoltage >= 0.005 && options.diodeThermalVoltage <= 0.2 &&
           std::isfinite(options.diodeIdeality) && options.diodeIdeality >= 0.5 &&
           options.diodeIdeality <= 4.0;
}

std::size_t PreampFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const PreampFxOptions& options,
    std::uint32_t cabinetIrFrames) noexcept {
    if (!validSpec(spec) || !validOptions(options) || cabinetIrFrames == 0U ||
        cabinetIrFrames > kMaximumCabinetIrFrames) return 0U;
    const auto convolverBytes = PartitionedConvolver::requiredPrepareBytes(
        options.cabinetPartitionFrames, cabinetIrFrames);
    if (convolverBytes == 0U) return 0U;

    const std::uint64_t dryDelay = static_cast<std::uint64_t>(
        options.cabinetPartitionFrames) + shaperAlignment(options, spec);
    const std::uint64_t floatSamples =
        4U * static_cast<std::uint64_t>(spec.maxBlockFrames) +
        2U * dryDelay + static_cast<std::uint64_t>(spec.maxBlockFrames);
    const std::uint64_t totalBytes = sizeof(PreampFxProcessor) +
        static_cast<std::uint64_t>(convolverBytes) + floatSamples * sizeof(float);
    if (totalBytes > kMaximumPreparedBytes ||
        totalBytes > std::numeric_limits<std::size_t>::max()) return 0U;
    return static_cast<std::size_t>(totalBytes);
}

bool PreampFxProcessor::prepare(const ProcessSpec& spec, const PreampFxOptions& options,
                                const PreampCabinetIr& cabinetIr) {
    prepared_ = false;
    if (!validCabinetIr(cabinetIr)) return false;
    const auto admittedBytes = requiredPrepareBytes(spec, options, cabinetIr.frames);
    if (admittedBytes == 0U) return false;

    for (auto& shaper : shapers_) {
        if (!shaper.prepare(spec, OversamplingFactor::x4, options.nonlinearModel)) return false;
        if (options.nonlinearModel == NonlinearModel::WdfSymmetricDiode &&
            !shaper.setDiodeParameters(options.diodePortResistance,
                options.diodeSaturationCurrent, options.diodeThermalVoltage,
                options.diodeIdeality)) return false;
    }

    for (auto& channel : tone_) {
        for (auto& filter : channel) {
            if (!filter.prepare(spec)) return false;
        }
        // Identity targets establish the four tone-stack sections before the
        // first event. Their fixed center frequencies are reconstruction
        // choices, independent of official user-interface values.
        if (!channel[0].setLowShelf(120.0f, 0.0f, 0.8f,
                                     options.toneCoefficientSmoothingMs) ||
            !channel[1].setPeaking(800.0f, 0.72f, 0.0f,
                                    options.toneCoefficientSmoothingMs) ||
            !channel[2].setHighShelf(3800.0f, 0.0f, 0.8f,
                                      options.toneCoefficientSmoothingMs) ||
            !channel[3].setPeaking(5200.0f, 0.7f, 0.0f,
                                    options.toneCoefficientSmoothingMs)) return false;
    }

    const float* rightIr = cabinetIr.right == nullptr ? cabinetIr.left : cabinetIr.right;
    PartitionedConvolver candidateCabinet{};
    WEBRC_PREAMP_TRY {
        std::array<std::vector<float>, 2U> candidateCabinetInputOutput;
        std::array<std::vector<float>, 2U> candidateDryBlock;
        std::array<std::vector<float>, 2U> candidateDryRing;
        std::vector<float> candidateBlendBlock;
        for (std::size_t channel = 0U; channel < 2U; ++channel) {
            candidateCabinetInputOutput[channel].assign(spec.maxBlockFrames, 0.0f);
            candidateDryBlock[channel].assign(spec.maxBlockFrames, 0.0f);
            candidateDryRing[channel].assign(
                static_cast<std::size_t>(options.cabinetPartitionFrames) +
                    shaperAlignment(options, spec), 0.0f);
        }
        candidateBlendBlock.assign(spec.maxBlockFrames, 0.0f);
        if (!candidateCabinet.prepare(spec, options.cabinetPartitionFrames,
                cabinetIr.frames, cabinetIr.left, nullptr, nullptr, rightIr)) return false;

        cabinet_ = std::move(candidateCabinet);
        cabinetInputOutput_ = std::move(candidateCabinetInputOutput);
        alignedDryBlock_ = std::move(candidateDryBlock);
        dryRing_ = std::move(candidateDryRing);
        blendBlock_ = std::move(candidateBlendBlock);
    } WEBRC_PREAMP_CATCH_ALL {
        return false;
    }

    spec_ = spec;
    options_ = options;
    dryAlignmentSamples_ = options.cabinetPartitionFrames + shaperAlignment(options, spec);
    preparedBytes_ = admittedBytes;
    controlSmoothingCoefficient_ = 1.0 - std::exp(
        -1.0 / (static_cast<double>(options.controlSmoothingMs) * 0.001 * spec.sampleRate));
    activeTarget_ = activeCurrent_ = 0.0f;
    mixTarget_ = mixCurrent_ = 1.0f;
    driveTarget_ = driveCurrent_ = 4.0f;
    bassDbTarget_ = midDbTarget_ = trebleDbTarget_ = presenceDbTarget_ = 0.0f;
    outputGainTarget_ = outputGainCurrent_ = 1.0f;
    prepared_ = true;
    reset();
    return true;
}

void PreampFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    absoluteFrame = std::min(absoluteFrame, kMaximumExactlyRepresentableFrame);
    for (auto& shaper : shapers_) shaper.reset();
    for (auto& channel : tone_) for (auto& filter : channel) filter.reset();
    cabinet_.reset();
    for (auto& channel : cabinetInputOutput_)
        std::fill(channel.begin(), channel.end(), 0.0f);
    for (auto& channel : alignedDryBlock_)
        std::fill(channel.begin(), channel.end(), 0.0f);
    for (auto& channel : dryRing_) std::fill(channel.begin(), channel.end(), 0.0f);
    std::fill(blendBlock_.begin(), blendBlock_.end(), 0.0f);
    dryWritePosition_ = 0U;
    activeCurrent_ = activeTarget_;
    mixCurrent_ = mixTarget_;
    driveCurrent_ = driveTarget_;
    outputGainCurrent_ = outputGainTarget_;
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = true;
}

bool PreampFxProcessor::validateEvent(const PreampFxEvent& event) const noexcept {
    switch (event.control) {
    case PreampFxControl::Active:
    case PreampFxControl::Mix:
        return finiteRange(event.value, 0.0f, 1.0f);
    case PreampFxControl::Drive:
        return finiteRange(event.value, 0.1f, 24.0f);
    case PreampFxControl::BassDb:
    case PreampFxControl::MidDb:
    case PreampFxControl::TrebleDb:
    case PreampFxControl::PresenceDb:
        return finiteRange(event.value, -12.0f, 12.0f);
    case PreampFxControl::OutputDb:
        return finiteRange(event.value, -24.0f, 12.0f);
    }
    return false;
}

bool PreampFxProcessor::validateEvents(std::uint32_t frames,
                                       const PreampFxEvent* events,
                                       std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    std::uint32_t previousOffset = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames ||
            (i != 0U && events[i].frameOffset < previousOffset) ||
            !validateEvent(events[i])) return false;
        previousOffset = events[i].frameOffset;
    }
    return true;
}

void PreampFxProcessor::updateToneTargets(PreampFxControl changed) noexcept {
    for (auto& channel : tone_) {
        switch (changed) {
        case PreampFxControl::BassDb:
            (void)channel[0].setLowShelf(120.0f, bassDbTarget_, 0.8f,
                                         options_.toneCoefficientSmoothingMs);
            break;
        case PreampFxControl::MidDb:
            (void)channel[1].setPeaking(800.0f, 0.72f, midDbTarget_,
                                        options_.toneCoefficientSmoothingMs);
            break;
        case PreampFxControl::TrebleDb:
            (void)channel[2].setHighShelf(3800.0f, trebleDbTarget_, 0.8f,
                                          options_.toneCoefficientSmoothingMs);
            break;
        case PreampFxControl::PresenceDb:
            (void)channel[3].setPeaking(5200.0f, 0.7f, presenceDbTarget_,
                                        options_.toneCoefficientSmoothingMs);
            break;
        default:
            break;
        }
    }
}

void PreampFxProcessor::applyEvent(const PreampFxEvent& event) noexcept {
    switch (event.control) {
    case PreampFxControl::Active:
        activeTarget_ = event.value;
        break;
    case PreampFxControl::Mix:
        mixTarget_ = event.value;
        break;
    case PreampFxControl::Drive:
        driveTarget_ = event.value;
        break;
    case PreampFxControl::BassDb:
        bassDbTarget_ = event.value;
        updateToneTargets(event.control);
        break;
    case PreampFxControl::MidDb:
        midDbTarget_ = event.value;
        updateToneTargets(event.control);
        break;
    case PreampFxControl::TrebleDb:
        trebleDbTarget_ = event.value;
        updateToneTargets(event.control);
        break;
    case PreampFxControl::PresenceDb:
        presenceDbTarget_ = event.value;
        updateToneTargets(event.control);
        break;
    case PreampFxControl::OutputDb:
        outputGainTarget_ = std::pow(10.0f, event.value / 20.0f);
        break;
    }
}

void PreampFxProcessor::advanceControls() noexcept {
    const float coefficient = static_cast<float>(controlSmoothingCoefficient_);
    activeCurrent_ += (activeTarget_ - activeCurrent_) * coefficient;
    mixCurrent_ += (mixTarget_ - mixCurrent_) * coefficient;
    driveCurrent_ += (driveTarget_ - driveCurrent_) * coefficient;
    outputGainCurrent_ += (outputGainTarget_ - outputGainCurrent_) * coefficient;
    if (std::fabs(activeTarget_ - activeCurrent_) < 1.0e-7f) activeCurrent_ = activeTarget_;
    if (std::fabs(mixTarget_ - mixCurrent_) < 1.0e-7f) mixCurrent_ = mixTarget_;
    if (std::fabs(driveTarget_ - driveCurrent_) < 1.0e-6f) driveCurrent_ = driveTarget_;
    if (std::fabs(outputGainTarget_ - outputGainCurrent_) < 1.0e-7f)
        outputGainCurrent_ = outputGainTarget_;
}

float PreampFxProcessor::processTone(std::size_t channel, float sample) noexcept {
    float output = tone_[channel][0].processSample(sample);
    output = tone_[channel][1].processSample(output);
    output = tone_[channel][2].processSample(output);
    output = tone_[channel][3].processSample(output);
    return cleanAudio(output);
}

bool PreampFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                     StereoFrame* interleaved,
                                     std::uint32_t frames,
                                     const PreampFxEvent* events,
                                     std::uint32_t eventCount) noexcept {
    if (!prepared_ || frames > spec_.maxBlockFrames ||
        (frames != 0U && interleaved == nullptr) ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        blockStartFrame + frames > kMaximumExactlyRepresentableFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;

    std::uint32_t eventIndex = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame)
            applyEvent(events[eventIndex++]);
        advanceControls();

        const StereoFrame input{
            std::clamp(cleanAudio(interleaved[frame].left), -kInputGuard, kInputGuard),
            std::clamp(cleanAudio(interleaved[frame].right), -kInputGuard, kInputGuard)};
        alignedDryBlock_[0U][frame] = dryRing_[0U][dryWritePosition_];
        alignedDryBlock_[1U][frame] = dryRing_[1U][dryWritePosition_];
        dryRing_[0U][dryWritePosition_] = input.left;
        dryRing_[1U][dryWritePosition_] = input.right;
        if (++dryWritePosition_ == dryAlignmentSamples_) dryWritePosition_ = 0U;

        const float drivenLeft = std::clamp(input.left * driveCurrent_, -192.0f, 192.0f);
        const float drivenRight = std::clamp(input.right * driveCurrent_, -192.0f, 192.0f);
        const float shapedLeft = shapers_[0U].processSample(drivenLeft);
        const float shapedRight = shapers_[1U].processSample(drivenRight);
        cabinetInputOutput_[0U][frame] = cleanAudio(
            std::clamp(processTone(0U, shapedLeft) * outputGainCurrent_, -16.0f, 16.0f));
        cabinetInputOutput_[1U][frame] = cleanAudio(
            std::clamp(processTone(1U, shapedRight) * outputGainCurrent_, -16.0f, 16.0f));
        blendBlock_[frame] = std::clamp(activeCurrent_ * mixCurrent_, 0.0f, 1.0f);
    }

    if (!cabinet_.processBlock(cabinetInputOutput_[0U].data(),
            cabinetInputOutput_[1U].data(), cabinetInputOutput_[0U].data(),
            cabinetInputOutput_[1U].data(), frames)) return false;

    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        const float blend = blendBlock_[frame];
        const float wetLeft = std::clamp(cleanAudio(cabinetInputOutput_[0U][frame]),
                                         -kOutputGuard, kOutputGuard);
        const float wetRight = std::clamp(cleanAudio(cabinetInputOutput_[1U][frame]),
                                          -kOutputGuard, kOutputGuard);
        interleaved[frame].left = std::clamp(cleanAudio(alignedDryBlock_[0U][frame] +
            (wetLeft - alignedDryBlock_[0U][frame]) * blend), -kOutputGuard, kOutputGuard);
        interleaved[frame].right = std::clamp(cleanAudio(alignedDryBlock_[1U][frame] +
            (wetRight - alignedDryBlock_[1U][frame]) * blend), -kOutputGuard, kOutputGuard);
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

PreampFxLatency PreampFxProcessor::latency() const noexcept {
    if (!prepared_) return {};
    return {dryAlignmentSamples_, options_.cabinetPartitionFrames,
            dryAlignmentSamples_,
            shapers_[0U].lowFrequencySmallSignalGroupDelaySamples()};
}

} // namespace webrc::dsp

#undef WEBRC_PREAMP_TRY
#undef WEBRC_PREAMP_CATCH_ALL
