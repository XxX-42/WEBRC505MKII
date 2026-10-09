#include "webrc/dsp/octave_models.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_OCTAVE_MODELS_TRY try
#define WEBRC_OCTAVE_MODELS_CATCH_ALL catch (...)
#else
#define WEBRC_OCTAVE_MODELS_TRY if (true)
#define WEBRC_OCTAVE_MODELS_CATCH_ALL else if (false)
#endif

namespace webrc::dsp {
namespace {

constexpr std::uint64_t kMaximumExactlyRepresentableFrame = 9007199254740992ULL;
constexpr std::uint64_t kAllocatorAllowanceBytes = 64U * 1024U;
constexpr std::uint64_t kMaximumPreparedBytes = 32U * 1024U * 1024U;

[[nodiscard]] bool finiteRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

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

[[nodiscard]] std::uint64_t alignmentRingFrames(const ProcessSpec& spec,
                                                 const OctaveModelsOptions& options) noexcept {
    const std::uint64_t delay = static_cast<std::uint64_t>(options.voice.windowFrames) * 2U;
    if (delay > std::numeric_limits<std::uint64_t>::max() - spec.maxBlockFrames - 1U)
        return 0U;
    return nextPowerOfTwo(delay + spec.maxBlockFrames + 1U);
}

[[nodiscard]] float boundedAudio(float value) noexcept {
    return std::clamp(sanitize(value), -8.0f, 8.0f);
}

} // namespace

bool OctaveModelsFxProcessor::validOptions(const OctaveModelsOptions& options) noexcept {
    return std::isfinite(options.controlSmoothingMs) &&
        options.controlSmoothingMs >= 1.0f && options.controlSmoothingMs <= 100.0f;
}

std::size_t OctaveModelsFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const OctaveModelsOptions& options) noexcept {
    if (!validOptions(options)) return 0U;
    const auto voiceBytes = OctaveFxProcessor::requiredPrepareBytes(spec, options.voice);
    const auto ringFrames = alignmentRingFrames(spec, options);
    if (voiceBytes == 0U || ringFrames == 0U || ringFrames > (1U << 20U)) return 0U;

    std::uint64_t bytes = sizeof(OctaveModelsFxProcessor);
    std::uint64_t threeVoices = 0U;
    std::uint64_t scratchFrames = 0U;
    std::uint64_t ringSamples = 0U;
    if (!checkedMultiply(3U, voiceBytes, threeVoices) ||
        !checkedMultiply(2U, spec.maxBlockFrames, scratchFrames) ||
        !checkedMultiply(2U, ringFrames, ringSamples) ||
        !checkedAdd(bytes, threeVoices) ||
        !checkedAdd(bytes, scratchFrames * sizeof(StereoFrame)) ||
        !checkedAdd(bytes, ringSamples * sizeof(StereoFrame)) ||
        !checkedAdd(bytes, kAllocatorAllowanceBytes) ||
        bytes > kMaximumPreparedBytes || bytes > std::numeric_limits<std::size_t>::max()) {
        return 0U;
    }
    return static_cast<std::size_t>(bytes);
}

std::size_t OctaveModelsFxProcessor::replacementPeakBytes(
    std::size_t activeBytes, const ProcessSpec& spec,
    const OctaveModelsOptions& options) noexcept {
    const auto candidateBytes = requiredPrepareBytes(spec, options);
    if (candidateBytes == 0U ||
        activeBytes > std::numeric_limits<std::size_t>::max() - candidateBytes) return 0U;
    return activeBytes + candidateBytes;
}

bool OctaveModelsFxProcessor::prepare(const ProcessSpec& spec,
                                      const OctaveModelsOptions& options) {
    // Instances are prepared once while inactive. Refusing a second prepare
    // preserves the prior usable instance and makes staging the host's job.
    if (prepared_) return false;
    const auto admittedBytes = requiredPrepareBytes(spec, options);
    if (admittedBytes == 0U) return false;

    const auto ringFrames = alignmentRingFrames(spec, options);
    const auto branchFrames = static_cast<std::size_t>(spec.maxBlockFrames);
    WEBRC_OCTAVE_MODELS_TRY {
        std::array<OctaveFxProcessor, 3U> candidateBranches{};
        std::vector<StereoFrame> candidateOneScratch;
        std::vector<StereoFrame> candidateTwoScratch;
        std::vector<StereoFrame> candidateDryHistory;
        std::vector<StereoFrame> candidateOneAlignment;

        constexpr std::array<OctaveFxEvent, 3U> primeControls{{
            {0U, OctaveFxControl::Active, 1.0f},
            {0U, OctaveFxControl::Mix, 1.0f},
            {0U, OctaveFxControl::Semitones, -12.0f},
        }};
        for (auto& branch : candidateBranches) {
            if (!branch.prepare(spec, options.voice)) return false;
            StereoFrame silentPrimer{};
            if (!branch.processBlock(0U, &silentPrimer, 1U,
                                     primeControls.data(),
                                     static_cast<std::uint32_t>(primeControls.size()))) return false;
            // Prime the branch's discrete target controls on the setup thread,
            // then clear analyzer/history state. This prevents the first live
            // note from gliding down from the underlying processor's default
            // +12 semitones while the clean-room mode is -12.
            branch.reset(0U);
        }
        candidateOneScratch.assign(branchFrames, {});
        candidateTwoScratch.assign(branchFrames, {});
        candidateDryHistory.assign(static_cast<std::size_t>(ringFrames), {});
        candidateOneAlignment.assign(static_cast<std::size_t>(ringFrames), {});

        branches_ = std::move(candidateBranches);
        oneOctaveScratch_ = std::move(candidateOneScratch);
        twoOctaveScratch_ = std::move(candidateTwoScratch);
        dryHistory_ = std::move(candidateDryHistory);
        oneOctaveAlignment_ = std::move(candidateOneAlignment);
        spec_ = spec;
        options_ = options;
        ringMask_ = static_cast<std::size_t>(ringFrames - 1U);
        preparedBytes_ = admittedBytes;
        controlSmoothingCoefficient_ = 1.0 - std::exp(
            -1.0 / (static_cast<double>(spec.sampleRate) *
                    static_cast<double>(options.controlSmoothingMs) * 0.001));
        prepared_ = true;
        reset();
        return true;
    } WEBRC_OCTAVE_MODELS_CATCH_ALL {
        return false;
    }
}

void OctaveModelsFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    absoluteFrame = std::min(absoluteFrame, kMaximumExactlyRepresentableFrame);
    for (auto& branch : branches_) branch.reset(absoluteFrame);
    std::fill(oneOctaveScratch_.begin(), oneOctaveScratch_.end(), StereoFrame{});
    std::fill(twoOctaveScratch_.begin(), twoOctaveScratch_.end(), StereoFrame{});
    std::fill(dryHistory_.begin(), dryHistory_.end(), StereoFrame{});
    std::fill(oneOctaveAlignment_.begin(), oneOctaveAlignment_.end(), StereoFrame{});
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
    modeTarget_ = OctaveModelsMode::DownOneOctave;
    branchControlsSent_ = false;
    hasExpectedFrame_ = true;
}

bool OctaveModelsFxProcessor::validateEvent(const OctaveModelsEvent& event) const noexcept {
    switch (event.control) {
    case OctaveModelsControl::Active:
    case OctaveModelsControl::Mix:
        return finiteRange(event.value, 0.0f, 1.0f);
    case OctaveModelsControl::Mode:
        return event.value == 0.0f || event.value == 1.0f || event.value == 2.0f;
    }
    return false;
}

bool OctaveModelsFxProcessor::validateEvents(std::uint32_t frames,
                                             const OctaveModelsEvent* events,
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

void OctaveModelsFxProcessor::applyEvent(const OctaveModelsEvent& event) noexcept {
    switch (event.control) {
    case OctaveModelsControl::Active:
        activeTarget_ = event.value;
        break;
    case OctaveModelsControl::Mix:
        mixTarget_ = event.value;
        break;
    case OctaveModelsControl::Mode:
        modeTarget_ = static_cast<OctaveModelsMode>(static_cast<std::uint8_t>(event.value));
        switch (modeTarget_) {
        case OctaveModelsMode::DownOneOctave:
            oneVoiceTarget_ = 1.0f;
            twoVoiceTarget_ = 0.0f;
            break;
        case OctaveModelsMode::DownTwoOctaves:
            oneVoiceTarget_ = 0.0f;
            twoVoiceTarget_ = 1.0f;
            break;
        case OctaveModelsMode::DualDownOctaves:
            oneVoiceTarget_ = 0.5f;
            twoVoiceTarget_ = 0.5f;
            break;
        }
        break;
    }
}

void OctaveModelsFxProcessor::advanceControls() noexcept {
    const float coefficient = static_cast<float>(controlSmoothingCoefficient_);
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

bool OctaveModelsFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                           StereoFrame* interleaved,
                                           std::uint32_t frames,
                                           const OctaveModelsEvent* events,
                                           std::uint32_t eventCount) noexcept {
    if (!prepared_ || frames > spec_.maxBlockFrames ||
        (frames != 0U && interleaved == nullptr) ||
        blockStartFrame > std::numeric_limits<std::uint64_t>::max() - frames ||
        blockStartFrame + frames > kMaximumExactlyRepresentableFrame ||
        processedFrames_ > kMaximumExactlyRepresentableFrame - frames ||
        (hasExpectedFrame_ && blockStartFrame != expectedAbsoluteFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (frames == 0U) return eventCount == 0U;

    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        const StereoFrame input{boundedAudio(interleaved[frame].left),
                                boundedAudio(interleaved[frame].right)};
        oneOctaveScratch_[frame] = input;
        twoOctaveScratch_[frame] = input;
        dryHistory_[static_cast<std::size_t>(processedFrames_ + frame) & ringMask_] = input;
    }

    constexpr std::array<OctaveFxEvent, 3U> branchSetup{{
        {0U, OctaveFxControl::Active, 1.0f},
        {0U, OctaveFxControl::Mix, 1.0f},
        {0U, OctaveFxControl::Semitones, -12.0f},
    }};
    const auto* initialEvents = branchControlsSent_ ? nullptr : branchSetup.data();
    const std::uint32_t initialEventCount = branchControlsSent_
        ? 0U : static_cast<std::uint32_t>(branchSetup.size());
    if (!branches_[0U].processBlock(blockStartFrame, oneOctaveScratch_.data(), frames,
                                    initialEvents, initialEventCount) ||
        !branches_[1U].processBlock(blockStartFrame, twoOctaveScratch_.data(), frames,
                                    initialEvents, initialEventCount) ||
        !branches_[2U].processBlock(blockStartFrame, twoOctaveScratch_.data(), frames,
                                    initialEvents, initialEventCount)) return false;
    branchControlsSent_ = true;

    const std::uint64_t extraOneDelay = options_.voice.windowFrames;
    const std::uint64_t dryDelay = static_cast<std::uint64_t>(options_.voice.windowFrames) * 2U;
    std::uint32_t eventIndex = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame) {
            applyEvent(events[eventIndex]);
            ++eventIndex;
        }
        advanceControls();
        const std::uint64_t relativeFrame = processedFrames_ + frame;
        const auto slot = static_cast<std::size_t>(relativeFrame) & ringMask_;
        oneOctaveAlignment_[slot] = oneOctaveScratch_[frame];

        StereoFrame alignedOne{};
        StereoFrame alignedDry{};
        if (relativeFrame >= extraOneDelay) {
            alignedOne = oneOctaveAlignment_[
                static_cast<std::size_t>(relativeFrame - extraOneDelay) & ringMask_];
        }
        if (relativeFrame >= dryDelay) {
            alignedDry = dryHistory_[static_cast<std::size_t>(relativeFrame - dryDelay) & ringMask_];
        }

        const float wetGain = std::clamp(activeCurrent_ * mixCurrent_, 0.0f, 1.0f);
        const float dryGain = 1.0f - wetGain;
        const float oneGain = wetGain * oneVoiceCurrent_;
        const float twoGain = wetGain * twoVoiceCurrent_;
        interleaved[frame] = {
            sanitize(alignedDry.left * dryGain + alignedOne.left * oneGain +
                     twoOctaveScratch_[frame].left * twoGain),
            sanitize(alignedDry.right * dryGain + alignedOne.right * oneGain +
                     twoOctaveScratch_[frame].right * twoGain)};
    }

    processedFrames_ += frames;
    expectedAbsoluteFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

} // namespace webrc::dsp
