#include "webrc/dsp/octave_fx.hpp"

#include "webrc/dsp/fft.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_OCTAVE_TRY try
#define WEBRC_OCTAVE_CATCH_ALL catch (...)
#else
// No-exception hosts must budget active plus staged graphs before prepare.
#define WEBRC_OCTAVE_TRY if (true)
#define WEBRC_OCTAVE_CATCH_ALL else if (false)
#endif

void octaveFxAuditCapture(std::uint64_t elapsedFrame, float left, float right) noexcept;

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr std::uint64_t kMaximumExactlyRepresentableFrame = 9007199254740992ULL;
constexpr float kMinimumSampleRate = 24000.0f;
constexpr float kMaximumSampleRate = 192000.0f;
constexpr std::uint32_t kMaximumBlockFrames = 8192U;
constexpr std::uint32_t kMinimumWindowFrames = 256U;
constexpr std::uint32_t kMaximumWindowFrames = 4096U;
constexpr std::uint64_t kMaximumPreparedBytes = 16U * 1024U * 1024U;
constexpr std::uint64_t kAllocatorAllowanceBytes = 64U * 1024U;

[[nodiscard]] bool finiteRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] bool validSpec(const ProcessSpec& spec) noexcept {
    return validProcessSpec(spec) && spec.channels == 2U &&
        spec.sampleRate >= kMinimumSampleRate && spec.sampleRate <= kMaximumSampleRate &&
        spec.maxBlockFrames <= kMaximumBlockFrames;
}

[[nodiscard]] float boundedSample(float value) noexcept {
    return std::clamp(sanitize(value), -8.0f, 8.0f);
}

} // namespace

bool OctaveFxProcessor::validOptions(const OctaveFxOptions& options) noexcept {
    return options.windowFrames >= kMinimumWindowFrames &&
        options.windowFrames <= kMaximumWindowFrames &&
        (options.windowFrames & (options.windowFrames - 1U)) == 0U &&
        options.hopFrames >= 32U && options.hopFrames <= options.windowFrames / 2U &&
        options.windowFrames % options.hopFrames == 0U &&
        (options.hopFrames & (options.hopFrames - 1U)) == 0U &&
        std::isfinite(options.controlSmoothingMs) &&
        options.controlSmoothingMs >= 1.0f && options.controlSmoothingMs <= 100.0f;
}

std::size_t OctaveFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const OctaveFxOptions& options) noexcept {
    if (!validSpec(spec) || !validOptions(options)) return 0U;
    const auto phaseBytes = PhaseVocoder::requiredPrepareBytes(options.windowFrames);
    if (phaseBytes == 0U) return 0U;

    const std::uint64_t ringFrames = static_cast<std::uint64_t>(options.windowFrames) * 2U;
    std::uint64_t bytes = sizeof(OctaveFxProcessor) + kAllocatorAllowanceBytes;
    bytes += 2U * static_cast<std::uint64_t>(phaseBytes);
    bytes += ringFrames * sizeof(StereoFrame);                 // input/dry history
    bytes += 4U * options.windowFrames * sizeof(std::complex<float>); // 2ch FFT in/out
    bytes += 4U * ringFrames * sizeof(double);                // 2ch OLA + shared norm
    bytes += static_cast<std::uint64_t>(options.windowFrames) * sizeof(float);
    if (bytes > kMaximumPreparedBytes || bytes > std::numeric_limits<std::size_t>::max())
        return 0U;
    return static_cast<std::size_t>(bytes);
}

bool OctaveFxProcessor::prepare(const ProcessSpec& spec, const OctaveFxOptions& options) {
    // Prepare a fresh inactive instance and publish it only when every bounded
    // buffer and both channel phase processors are ready.
    prepared_ = false;
    const auto admittedBytes = requiredPrepareBytes(spec, options);
    if (admittedBytes == 0U) return false;

    const auto ringFrames = static_cast<std::size_t>(options.windowFrames) * 2U;
    WEBRC_OCTAVE_TRY {
        std::array<PhaseVocoder, 2U> candidateVocoder{};
        std::array<std::vector<std::complex<float>>, 2U> candidateInput{};
        std::array<std::vector<std::complex<float>>, 2U> candidateOutput{};
        std::array<std::vector<double>, 2U> candidateOverlap{};
        std::vector<double> candidateWeight;
        std::vector<StereoFrame> candidateHistory;
        std::vector<float> candidateWindow;

        for (std::size_t channel = 0U; channel < 2U; ++channel) {
            if (!candidateVocoder[channel].prepare(
                    spec, options.windowFrames, options.hopFrames, options.hopFrames))
                return false;
            candidateInput[channel].assign(options.windowFrames, {});
            candidateOutput[channel].assign(options.windowFrames, {});
            candidateOverlap[channel].assign(ringFrames, 0.0);
        }
        candidateWeight.assign(ringFrames, 0.0);
        candidateHistory.assign(ringFrames, {});
        candidateWindow.resize(options.windowFrames);
        for (std::uint32_t i = 0U; i < options.windowFrames; ++i) {
            candidateWindow[i] = static_cast<float>(0.5 - 0.5 * std::cos(
                kTwoPi * static_cast<double>(i) / options.windowFrames));
        }

        phaseVocoder_ = std::move(candidateVocoder);
        fftInput_ = std::move(candidateInput);
        fftOutput_ = std::move(candidateOutput);
        overlap_ = std::move(candidateOverlap);
        overlapWeight_ = std::move(candidateWeight);
        inputHistory_ = std::move(candidateHistory);
        window_ = std::move(candidateWindow);
        spec_ = spec;
        options_ = options;
        ringMask_ = ringFrames - 1U;
        preparedBytes_ = admittedBytes;
        controlSmoothingCoefficient_ = 1.0 - std::exp(
            -1.0 / (static_cast<double>(spec.sampleRate) *
                    static_cast<double>(options.controlSmoothingMs) * 0.001));
        prepared_ = true;
        reset();
        return true;
    } WEBRC_OCTAVE_CATCH_ALL {
        return false;
    }
}

void OctaveFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    absoluteFrame = std::min(absoluteFrame, kMaximumExactlyRepresentableFrame);
    for (auto& vocoder : phaseVocoder_) vocoder.reset();
    for (auto& samples : fftInput_) std::fill(samples.begin(), samples.end(), std::complex<float>{});
    for (auto& samples : fftOutput_) std::fill(samples.begin(), samples.end(), std::complex<float>{});
    for (auto& values : overlap_) std::fill(values.begin(), values.end(), 0.0);
    std::fill(overlapWeight_.begin(), overlapWeight_.end(), 0.0);
    std::fill(inputHistory_.begin(), inputHistory_.end(), StereoFrame{});
    activeTarget_ = 0.0f;
    activeCurrent_ = 0.0f;
    mixCurrent_ = mixTarget_;
    pitchRatioCurrent_ = pitchRatioTarget_;
    expectedAbsoluteFrame_ = absoluteFrame;
    elapsedFrame_ = 0U;
    nextAnalysisStart_ = -static_cast<std::int64_t>(options_.windowFrames) +
                         static_cast<std::int64_t>(options_.hopFrames);
    hasExpectedFrame_ = true;
}

bool OctaveFxProcessor::validateEvent(const OctaveFxEvent& event) const noexcept {
    switch (event.control) {
    case OctaveFxControl::Active:
    case OctaveFxControl::Mix:
        return finiteRange(event.value, 0.0f, 1.0f);
    case OctaveFxControl::Semitones:
        return finiteRange(event.value, -12.0f, 12.0f);
    }
    return false;
}

bool OctaveFxProcessor::validateEvents(std::uint32_t frames,
                                       const OctaveFxEvent* events,
                                       std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    std::uint32_t previous = 0U;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames ||
            (i != 0U && events[i].frameOffset < previous) ||
            !validateEvent(events[i])) return false;
        previous = events[i].frameOffset;
    }
    return true;
}

void OctaveFxProcessor::applyEvent(const OctaveFxEvent& event) noexcept {
    switch (event.control) {
    case OctaveFxControl::Active: activeTarget_ = event.value; break;
    case OctaveFxControl::Mix: mixTarget_ = event.value; break;
    case OctaveFxControl::Semitones:
        semitonesTarget_ = event.value;
        pitchRatioTarget_ = std::exp2(semitonesTarget_ / 12.0f);
        break;
    }
}

void OctaveFxProcessor::advanceControls() noexcept {
    const float coefficient = static_cast<float>(controlSmoothingCoefficient_);
    activeCurrent_ += (activeTarget_ - activeCurrent_) * coefficient;
    mixCurrent_ += (mixTarget_ - mixCurrent_) * coefficient;
    pitchRatioCurrent_ += (pitchRatioTarget_ - pitchRatioCurrent_) * coefficient;
    if (std::fabs(activeTarget_ - activeCurrent_) < 2.0e-5f)
        activeCurrent_ = activeTarget_;
    if (std::fabs(mixTarget_ - mixCurrent_) < 2.0e-5f)
        mixCurrent_ = mixTarget_;
    if (std::fabs(pitchRatioTarget_ - pitchRatioCurrent_) < 1.0e-4f)
        pitchRatioCurrent_ = pitchRatioTarget_;
}

void OctaveFxProcessor::analyzeFrame(std::int64_t frameStart) noexcept {
    const auto frameCount = static_cast<std::int64_t>(options_.windowFrames);
    for (std::uint32_t i = 0U; i < options_.windowFrames; ++i) {
        const std::int64_t sourceFrame = frameStart + i;
        const StereoFrame sample = sourceFrame < 0
            ? StereoFrame{}
            : inputHistory_[static_cast<std::size_t>(sourceFrame) & ringMask_];
        fftInput_[0U][i] = {sample.left * window_[i], 0.0f};
        fftInput_[1U][i] = {sample.right * window_[i], 0.0f};
    }
    for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
        if (!fft::transform(fftInput_[channel].data(), options_.windowFrames,
                            fft::Direction::Forward)) {
            continue;
        }
        if (!phaseVocoder_[channel].processSpectrumFrame(
                fftInput_[channel].data(), fftOutput_[channel].data(), pitchRatioCurrent_)) {
            continue;
        }
        if (std::fabs(pitchRatioCurrent_ - 1.0f) < 1.0e-7f) {
            std::copy(fftInput_[channel].begin(), fftInput_[channel].end(),
                      fftOutput_[channel].begin());
        }
        if (!fft::transform(fftOutput_[channel].data(), options_.windowFrames,
                            fft::Direction::Inverse)) continue;
    }

    for (std::uint32_t i = 0U; i < options_.windowFrames; ++i) {
        const std::int64_t outputFrame = frameStart + frameCount + i;
        if (outputFrame < 0) continue;
        const auto slot = static_cast<std::size_t>(outputFrame) & ringMask_;
        const double synthesisWindow = window_[i];
        overlap_[0U][slot] += static_cast<double>(fftOutput_[0U][i].real()) * synthesisWindow;
        overlap_[1U][slot] += static_cast<double>(fftOutput_[1U][i].real()) * synthesisWindow;
        overlapWeight_[slot] += synthesisWindow * synthesisWindow;
    }
}

StereoFrame OctaveFxProcessor::readDry(std::uint64_t elapsedFrame) const noexcept {
    if (elapsedFrame < options_.windowFrames) return {};
    const auto delayedFrame = elapsedFrame - options_.windowFrames;
    return inputHistory_[static_cast<std::size_t>(delayedFrame) & ringMask_];
}

bool OctaveFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                     StereoFrame* interleaved,
                                     std::uint32_t frames,
                                     const OctaveFxEvent* events,
                                     std::uint32_t eventCount) noexcept {
    if (!prepared_ || frames > spec_.maxBlockFrames ||
        (frames != 0U && interleaved == nullptr) ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        blockStartFrame + frames > kMaximumExactlyRepresentableFrame ||
        elapsedFrame_ > kMaximumExactlyRepresentableFrame - frames ||
        (hasExpectedFrame_ && blockStartFrame != expectedAbsoluteFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;

    std::uint32_t eventIndex = 0U;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == i) {
            applyEvent(events[eventIndex]);
            ++eventIndex;
        }
        advanceControls();
        const auto input = StereoFrame{boundedSample(interleaved[i].left),
                                       boundedSample(interleaved[i].right)};
        const auto inputSlot = static_cast<std::size_t>(elapsedFrame_) & ringMask_;
        inputHistory_[inputSlot] = input;

        const auto currentSignedFrame = static_cast<std::int64_t>(elapsedFrame_);
        while (nextAnalysisStart_ + static_cast<std::int64_t>(options_.windowFrames) - 1 <=
               currentSignedFrame) {
            analyzeFrame(nextAnalysisStart_);
            nextAnalysisStart_ += static_cast<std::int64_t>(options_.hopFrames);
        }

        const auto outputSlot = static_cast<std::size_t>(elapsedFrame_) & ringMask_;
        const double weight = overlapWeight_[outputSlot];
        StereoFrame wet{};
        float rawWetLeft = 0.0f;
        float rawWetRight = 0.0f;
        if (weight > 1.0e-12 && std::isfinite(weight)) {
            rawWetLeft = static_cast<float>(overlap_[0U][outputSlot] / weight);
            rawWetRight = static_cast<float>(overlap_[1U][outputSlot] / weight);
            wet = {boundedSample(rawWetLeft), boundedSample(rawWetRight)};
        }
        octaveFxAuditCapture(elapsedFrame_, rawWetLeft, rawWetRight);
        overlap_[0U][outputSlot] = 0.0;
        overlap_[1U][outputSlot] = 0.0;
        overlapWeight_[outputSlot] = 0.0;

        const auto dry = readDry(elapsedFrame_);
        const float mix = std::clamp(activeCurrent_ * mixCurrent_, 0.0f, 1.0f);
        interleaved[i] = {
            boundedSample(dry.left + (wet.left - dry.left) * mix),
            boundedSample(dry.right + (wet.right - dry.right) * mix)};
        ++elapsedFrame_;
    }
    expectedAbsoluteFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

} // namespace webrc::dsp

