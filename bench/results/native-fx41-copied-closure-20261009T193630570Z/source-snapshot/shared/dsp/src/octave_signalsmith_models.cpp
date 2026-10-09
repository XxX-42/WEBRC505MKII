#include "webrc/dsp/octave_signalsmith_models.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_OCTAVE_SMITH_TRY try
#define WEBRC_OCTAVE_SMITH_CATCH_ALL catch (...)
#else
#define WEBRC_OCTAVE_SMITH_TRY if (true)
#define WEBRC_OCTAVE_SMITH_CATCH_ALL else if (false)
#endif

namespace webrc::dsp {
namespace {

constexpr std::uint64_t kMaximumExactlyRepresentableFrame = 9007199254740992ULL;
constexpr std::uint64_t kAllocatorAllowanceBytes = 96U * 1024U;
constexpr std::uint64_t kMaximumPreparedBytes = 48U * 1024U * 1024U;

[[nodiscard]] bool checkedAdd(std::uint64_t& total, std::uint64_t value) noexcept {
    if (value > std::numeric_limits<std::uint64_t>::max() - total) return false;
    total += value;
    return true;
}

[[nodiscard]] bool checkedMultiply(std::uint64_t a, std::uint64_t b,
                                   std::uint64_t& result) noexcept {
    if (a != 0U && b > std::numeric_limits<std::uint64_t>::max() / a) return false;
    result = a * b;
    return true;
}

[[nodiscard]] std::uint64_t nextPowerOfTwo(std::uint64_t value) noexcept {
    if (value <= 1U) return 1U;
    --value;
    for (std::uint32_t shift = 1U; shift < 64U; shift <<= 1U) value |= value >> shift;
    return value == std::numeric_limits<std::uint64_t>::max() ? 0U : value + 1U;
}

[[nodiscard]] std::uint64_t fixedPathFrames(const OctaveSignalsmithOptions& options) noexcept {
    const std::uint64_t splitFrames = options.splitComputation ? options.intervalSamples : 0U;
    return static_cast<std::uint64_t>(options.blockSamples) + splitFrames;
}

[[nodiscard]] std::uint64_t alignmentRingFrames(const ProcessSpec& spec,
                                                const OctaveSignalsmithOptions& options) noexcept {
    const auto delay = fixedPathFrames(options);
    if (delay > std::numeric_limits<std::uint64_t>::max() - spec.maxBlockFrames - 1U)
        return 0U;
    return nextPowerOfTwo(delay + spec.maxBlockFrames + 1U);
}

[[nodiscard]] float boundedAudio(float value) noexcept {
    return std::clamp(sanitize(value), -8.0f, 8.0f);
}

} // namespace

OctaveSignalsmithModelsFxProcessor::OctaveSignalsmithModelsFxProcessor(
    std::uint32_t seed) noexcept : seed_(seed & 0x7fffffffU) {}

bool OctaveSignalsmithModelsFxProcessor::validOptions(
    const ProcessSpec& spec, const OctaveSignalsmithOptions& options) noexcept {
    return validProcessSpec(spec) && spec.channels == 2U && spec.maxBlockFrames <= 8192U &&
        options.blockSamples >= 64U && options.blockSamples <= 8192U &&
        options.intervalSamples >= 16U && options.intervalSamples <= options.blockSamples &&
        std::isfinite(options.controlSmoothingMs) && options.controlSmoothingMs >= 1.0f &&
        options.controlSmoothingMs <= 100.0f;
}

std::size_t OctaveSignalsmithModelsFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const OctaveSignalsmithOptions& options) noexcept {
    if (!validOptions(spec, options)) return 0U;

    SignalsmithStretchSettings settings{};
    settings.mode = PitchQualityMode::LivePoly;
    settings.channels = 2U;
    settings.blockSamples = options.blockSamples;
    settings.intervalSamples = options.intervalSamples;
    settings.splitComputation = options.splitComputation;
    const auto branchBytes = SignalsmithStretchAdapter::requiredPrepareBytes(spec, settings);
    const auto ringFrames = alignmentRingFrames(spec, options);
    if (branchBytes == 0U || ringFrames == 0U || ringFrames > (1U << 20U)) return 0U;

    std::uint64_t bytes = sizeof(OctaveSignalsmithModelsFxProcessor);
    std::uint64_t branchesBytes = 0U;
    std::uint64_t scratchFrames = 0U;
    std::uint64_t ringBytes = 0U;
    if (!checkedMultiply(2U, branchBytes, branchesBytes) ||
        !checkedMultiply(6U, spec.maxBlockFrames, scratchFrames) ||
        !checkedMultiply(ringFrames, sizeof(StereoFrame), ringBytes) ||
        !checkedAdd(bytes, branchesBytes) ||
        !checkedAdd(bytes, scratchFrames * sizeof(float)) ||
        !checkedAdd(bytes, ringBytes) ||
        !checkedAdd(bytes, kAllocatorAllowanceBytes) ||
        bytes > kMaximumPreparedBytes || bytes > std::numeric_limits<std::size_t>::max()) {
        return 0U;
    }
    return static_cast<std::size_t>(bytes);
}

std::size_t OctaveSignalsmithModelsFxProcessor::replacementPeakBytes(
    std::size_t activeBytes, const ProcessSpec& spec,
    const OctaveSignalsmithOptions& options) noexcept {
    const auto candidateBytes = requiredPrepareBytes(spec, options);
    if (candidateBytes == 0U ||
        activeBytes > std::numeric_limits<std::size_t>::max() - candidateBytes) return 0U;
    return activeBytes + candidateBytes;
}

bool OctaveSignalsmithModelsFxProcessor::prepare(
    const ProcessSpec& spec, const OctaveSignalsmithOptions& options) noexcept {
    if (prepared_) return false;
    const auto admittedBytes = requiredPrepareBytes(spec, options);
    if (admittedBytes == 0U) return false;

    SignalsmithStretchSettings settings{};
    settings.mode = PitchQualityMode::LivePoly;
    settings.channels = 2U;
    settings.blockSamples = options.blockSamples;
    settings.intervalSamples = options.intervalSamples;
    settings.splitComputation = options.splitComputation;

    WEBRC_OCTAVE_SMITH_TRY {
        std::array<std::unique_ptr<SignalsmithStretchAdapter>, 2U> candidateBranches{};
        candidateBranches[0U].reset(new (std::nothrow) SignalsmithStretchAdapter(
            seed_ ^ 0x13579bdfU));
        candidateBranches[1U].reset(new (std::nothrow) SignalsmithStretchAdapter(
            seed_ ^ 0x2468ace0U));
        if (!candidateBranches[0U] || !candidateBranches[1U]) return false;
        for (std::size_t branch = 0U; branch < candidateBranches.size(); ++branch) {
            settings.seed = candidateBranches[branch]->constructorSeed();
            if (!candidateBranches[branch]->prepare(spec, settings, admittedBytes) ||
                !candidateBranches[branch]->setTransposeFactor(branch == 0U ? 0.5f : 0.25f)) {
                return false;
            }
        }

        std::array<std::vector<float>, 2U> candidateInput{};
        std::array<std::vector<float>, 2U> candidateOne{};
        std::array<std::vector<float>, 2U> candidateTwo{};
        for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
            candidateInput[channel].resize(spec.maxBlockFrames);
            candidateOne[channel].resize(spec.maxBlockFrames);
            candidateTwo[channel].resize(spec.maxBlockFrames);
        }
        const auto ringFrames = alignmentRingFrames(spec, options);
        std::vector<StereoFrame> candidateDry(static_cast<std::size_t>(ringFrames), {});

        branches_ = std::move(candidateBranches);
        inputPlanar_ = std::move(candidateInput);
        oneOctavePlanar_ = std::move(candidateOne);
        twoOctavePlanar_ = std::move(candidateTwo);
        dryHistory_ = std::move(candidateDry);
        spec_ = spec;
        options_ = options;
        fixedPathFrames_ = static_cast<std::uint32_t>(fixedPathFrames(options));
        ringMask_ = static_cast<std::size_t>(ringFrames - 1U);
        preparedBytes_ = admittedBytes;
        controlSmoothingCoefficient_ = 1.0 - std::exp(
            -1.0 / (static_cast<double>(spec.sampleRate) *
                    static_cast<double>(options.controlSmoothingMs) * 0.001));
        prepared_ = true;
        reset();
        return true;
    } WEBRC_OCTAVE_SMITH_CATCH_ALL {
        return false;
    }
}

void OctaveSignalsmithModelsFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    absoluteFrame = std::min(absoluteFrame, kMaximumExactlyRepresentableFrame);
    for (auto& branch : branches_) if (branch) branch->reset();
    for (auto& channel : inputPlanar_) std::fill(channel.begin(), channel.end(), 0.0f);
    for (auto& channel : oneOctavePlanar_) std::fill(channel.begin(), channel.end(), 0.0f);
    for (auto& channel : twoOctavePlanar_) std::fill(channel.begin(), channel.end(), 0.0f);
    std::fill(dryHistory_.begin(), dryHistory_.end(), StereoFrame{});
    expectedAbsoluteFrame_ = absoluteFrame;
    processedFrames_ = 0U;
    activeTarget_ = 0.0f;
    activeCurrent_ = 0.0f;
    mixTarget_ = 0.5f;
    mixCurrent_ = 0.5f;
    oneVoiceTarget_ = 1.0f;
    oneVoiceCurrent_ = 1.0f;
    twoVoiceTarget_ = 0.0f;
    twoVoiceCurrent_ = 0.0f;
    modeTarget_ = OctaveSignalsmithMode::DownOneOctave;
    hasExpectedFrame_ = true;
}

bool OctaveSignalsmithModelsFxProcessor::validateEvent(
    const OctaveSignalsmithEvent& event) noexcept {
    switch (event.control) {
    case OctaveSignalsmithControl::Active:
    case OctaveSignalsmithControl::Mix:
        return std::isfinite(event.value) && event.value >= 0.0f && event.value <= 1.0f;
    case OctaveSignalsmithControl::Mode:
        return event.value == 0.0f || event.value == 1.0f || event.value == 2.0f;
    }
    return false;
}

bool OctaveSignalsmithModelsFxProcessor::validateEvents(
    std::uint32_t frames, const OctaveSignalsmithEvent* events,
    std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount != 0U && events == nullptr)) return false;
    std::uint32_t previousOffset = 0U;
    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        if (events[index].frameOffset >= frames ||
            (index != 0U && events[index].frameOffset < previousOffset) ||
            !validateEvent(events[index])) return false;
        previousOffset = events[index].frameOffset;
    }
    return true;
}

void OctaveSignalsmithModelsFxProcessor::applyEvent(
    const OctaveSignalsmithEvent& event) noexcept {
    switch (event.control) {
    case OctaveSignalsmithControl::Active:
        activeTarget_ = event.value;
        break;
    case OctaveSignalsmithControl::Mix:
        mixTarget_ = event.value;
        break;
    case OctaveSignalsmithControl::Mode:
        modeTarget_ = static_cast<OctaveSignalsmithMode>(static_cast<std::uint8_t>(event.value));
        switch (modeTarget_) {
        case OctaveSignalsmithMode::DownOneOctave:
            oneVoiceTarget_ = 1.0f;
            twoVoiceTarget_ = 0.0f;
            break;
        case OctaveSignalsmithMode::DownTwoOctaves:
            oneVoiceTarget_ = 0.0f;
            twoVoiceTarget_ = 1.0f;
            break;
        case OctaveSignalsmithMode::DualDownOctaves:
            oneVoiceTarget_ = 0.5f;
            twoVoiceTarget_ = 0.5f;
            break;
        }
        break;
    }
}

void OctaveSignalsmithModelsFxProcessor::advanceControls() noexcept {
    const auto coefficient = static_cast<float>(controlSmoothingCoefficient_);
    activeCurrent_ += (activeTarget_ - activeCurrent_) * coefficient;
    mixCurrent_ += (mixTarget_ - mixCurrent_) * coefficient;
    oneVoiceCurrent_ += (oneVoiceTarget_ - oneVoiceCurrent_) * coefficient;
    twoVoiceCurrent_ += (twoVoiceTarget_ - twoVoiceCurrent_) * coefficient;
    if (std::fabs(activeTarget_ - activeCurrent_) < 2.0e-5f) activeCurrent_ = activeTarget_;
    if (std::fabs(mixTarget_ - mixCurrent_) < 2.0e-5f) mixCurrent_ = mixTarget_;
    if (std::fabs(oneVoiceTarget_ - oneVoiceCurrent_) < 2.0e-5f)
        oneVoiceCurrent_ = oneVoiceTarget_;
    if (std::fabs(twoVoiceTarget_ - twoVoiceCurrent_) < 2.0e-5f)
        twoVoiceCurrent_ = twoVoiceTarget_;
}

bool OctaveSignalsmithModelsFxProcessor::processBlock(
    std::uint64_t blockStartFrame, StereoFrame* interleaved, std::uint32_t frames,
    const OctaveSignalsmithEvent* events, std::uint32_t eventCount) noexcept {
    if (!prepared_ || frames > spec_.maxBlockFrames ||
        (frames != 0U && interleaved == nullptr) ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        blockStartFrame + frames > kMaximumExactlyRepresentableFrame ||
        processedFrames_ > kMaximumExactlyRepresentableFrame - frames ||
        (hasExpectedFrame_ && blockStartFrame != expectedAbsoluteFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;

    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        inputPlanar_[0U][frame] = boundedAudio(interleaved[frame].left);
        inputPlanar_[1U][frame] = boundedAudio(interleaved[frame].right);
    }
    const std::array<const float*, 2U> inputPointers{{
        inputPlanar_[0U].data(), inputPlanar_[1U].data()}};
    const std::array<float*, 2U> onePointers{{
        oneOctavePlanar_[0U].data(), oneOctavePlanar_[1U].data()}};
    const std::array<float*, 2U> twoPointers{{
        twoOctavePlanar_[0U].data(), twoOctavePlanar_[1U].data()}};
    if (!branches_[0U] || !branches_[1U] ||
        !branches_[0U]->process(inputPointers.data(), frames, onePointers.data(), frames) ||
        !branches_[1U]->process(inputPointers.data(), frames, twoPointers.data(), frames)) {
        return false;
    }

    std::uint32_t eventIndex = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame) {
            applyEvent(events[eventIndex]);
            ++eventIndex;
        }
        advanceControls();
        const auto relativeFrame = processedFrames_ + frame;
        const auto slot = static_cast<std::size_t>(relativeFrame) & ringMask_;
        const StereoFrame input{inputPlanar_[0U][frame], inputPlanar_[1U][frame]};
        dryHistory_[slot] = input;

        StereoFrame delayedDry{};
        if (relativeFrame >= fixedPathFrames_) {
            delayedDry = dryHistory_[static_cast<std::size_t>(
                relativeFrame - fixedPathFrames_) & ringMask_];
        }
        const auto wetGain = std::clamp(activeCurrent_ * mixCurrent_, 0.0f, 1.0f);
        const auto dryGain = 1.0f - wetGain;
        const auto oneGain = wetGain * oneVoiceCurrent_;
        const auto twoGain = wetGain * twoVoiceCurrent_;
        interleaved[frame] = {
            sanitize(delayedDry.left * dryGain + oneOctavePlanar_[0U][frame] * oneGain +
                     twoOctavePlanar_[0U][frame] * twoGain),
            sanitize(delayedDry.right * dryGain + oneOctavePlanar_[1U][frame] * oneGain +
                     twoOctavePlanar_[1U][frame] * twoGain)};
    }

    processedFrames_ += frames;
    expectedAbsoluteFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

OctaveSignalsmithLatency OctaveSignalsmithModelsFxProcessor::latency() const noexcept {
    if (!prepared_) return {};
    return {fixedPathFrames_, branches_[0U] ? branches_[0U]->inputLatencySamples() : 0,
            branches_[0U] ? branches_[0U]->outputLatencySamples() : 0};
}

} // namespace webrc::dsp
