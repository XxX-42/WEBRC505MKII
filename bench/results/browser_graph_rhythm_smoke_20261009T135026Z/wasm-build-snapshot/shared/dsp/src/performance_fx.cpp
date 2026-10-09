#include "webrc/dsp/performance_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kMaxExactFrame = 9007199254740992.0; // 2^53
constexpr std::uint32_t kHistoryGuardFrames = 16;
constexpr std::uint32_t kMinimumGrainFrames = 64;
constexpr std::uint32_t kMaximumGrainFrames = 12000;
constexpr std::uint32_t kVinylLatencyMs = 20;

[[nodiscard]] bool finiteInRange(float value, float low, float high) noexcept {
    return std::isfinite(value) && value >= low && value <= high;
}

[[nodiscard]] float boundedAudio(float value) noexcept {
    return std::clamp(sanitize(value), -8.0f, 8.0f);
}

[[nodiscard]] std::uint32_t wrapIndex(std::int64_t index, std::uint32_t size) noexcept {
    const auto n = static_cast<std::int64_t>(size);
    auto wrapped = index % n;
    if (wrapped < 0) wrapped += n;
    return static_cast<std::uint32_t>(wrapped);
}

[[nodiscard]] float lagrange4(float x0, float x1, float x2, float x3,
                              float fraction) noexcept {
    const float c0 = -fraction * (fraction - 1.0f) * (fraction - 2.0f) / 6.0f;
    const float c1 = (fraction + 1.0f) * (fraction - 1.0f) * (fraction - 2.0f) / 2.0f;
    const float c2 = -(fraction + 1.0f) * fraction * (fraction - 2.0f) / 2.0f;
    const float c3 = (fraction + 1.0f) * fraction * (fraction - 1.0f) / 6.0f;
    return sanitize(c0 * x0 + c1 * x1 + c2 * x2 + c3 * x3);
}

[[nodiscard]] std::uint32_t clampFrameCount(double frames, std::uint32_t maximum) noexcept {
    if (!std::isfinite(frames) || frames <= 1.0) return 2U;
    const auto rounded = std::ceil(frames);
    return static_cast<std::uint32_t>(std::clamp(rounded, 2.0, static_cast<double>(maximum)));
}

} // namespace

std::size_t PerformanceFxProcessor::requiredPrepareBytes(const ProcessSpec& spec,
                                                         PerformanceFxKind kind) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2 || spec.sampleRate > 192000.0f ||
        static_cast<std::uint8_t>(kind) > static_cast<std::uint8_t>(PerformanceFxKind::VinylFlick)) {
        return 0;
    }
    const auto sampleRate = static_cast<std::uint64_t>(std::ceil(spec.sampleRate));
    const auto historyFrames = sampleRate * static_cast<std::uint64_t>(kMaximumHistorySeconds) +
                               spec.maxBlockFrames + kHistoryGuardFrames;
    const auto historyBytes = historyFrames * sizeof(StereoFrame);
    std::uint64_t repeatBytes = 0;
    if (kind == PerformanceFxKind::BeatRepeat) {
        const auto repeatFrames = sampleRate * static_cast<std::uint64_t>(kMaximumRepeatSeconds);
        repeatBytes = repeatFrames * 2U * sizeof(StereoFrame);
    }
    constexpr std::uint64_t kAllocatorAllowance = 64U * 1024U;
    const auto total = historyBytes + repeatBytes + kAllocatorAllowance;
    if (total > std::numeric_limits<std::size_t>::max()) return 0;
    return static_cast<std::size_t>(total);
}

bool PerformanceFxProcessor::prepare(const ProcessSpec& spec) {
    if (requiredPrepareBytes(spec, kind_) == 0) {
        prepared_ = false;
        return false;
    }
    // A failed prepare does not preserve the old instance. Callers build a new
    // inactive graph and replace it only after this method succeeds.
    prepared_ = false;
    spec_ = spec;
    const auto samples = static_cast<std::uint64_t>(std::ceil(spec.sampleRate));
    const auto historyFrames64 = samples * static_cast<std::uint64_t>(kMaximumHistorySeconds) +
                                 spec.maxBlockFrames + kHistoryGuardFrames;
    historyFrames_ = static_cast<std::uint32_t>(historyFrames64);
    history_.assign(historyFrames_, {});
    if (kind_ == PerformanceFxKind::BeatRepeat) {
        const auto repeatFrames = static_cast<std::uint32_t>(samples *
            static_cast<std::uint64_t>(kMaximumRepeatSeconds));
        repeatBuffers_[0].assign(repeatFrames, {});
        repeatBuffers_[1].assign(repeatFrames, {});
    }
    fadeFrames_ = std::max<std::uint32_t>(2U,
        static_cast<std::uint32_t>(std::ceil(spec.sampleRate * 0.005f)));
    wetSmoothingCoefficient_ = 1.0 - std::exp(-1.0 / (static_cast<double>(spec.sampleRate) * 0.005));
    feedbackSmoothingCoefficient_ = 1.0 - std::exp(-1.0 / (static_cast<double>(spec.sampleRate) * 0.010));
    tempoBpm_ = 120.0f;
    subdivisionBeats_ = 0.25f;
    wet_ = 1.0f;
    wetCurrent_ = 1.0f;
    feedback_ = kind_ == PerformanceFxKind::BeatRepeat ? 0.72f : 0.0f;
    feedbackCurrent_ = feedback_;
    scatterAmount_ = 0.5f;
    pitchRatio_ = 1.0f;
    shiftBeats_ = 0.0f;
    resetEffectState(0);
    hasExpectedFrame_ = false;
    prepared_ = true;
    return true;
}

void PerformanceFxProcessor::resetEffectState(std::uint64_t absoluteFrame) noexcept {
    std::fill(history_.begin(), history_.end(), StereoFrame{});
    for (auto& buffer : repeatBuffers_) std::fill(buffer.begin(), buffer.end(), StereoFrame{});
    grains_ = {};
    randomState_ = randomSeed_;
    expectedFrame_ = absoluteFrame;
    activeSinceFrame_ = absoluteFrame;
    repeatCycleStartFrame_ = absoluteFrame;
    repeatNextBoundaryFrame_ = absoluteFrame;
    vinylReferenceFrame_ = absoluteFrame;
    repeatFrames_ = 0;
    repeatPosition_ = 0;
    repeatActiveBuffer_ = 0;
    repeatFadePosition_ = 0;
    repeatFadeFrames_ = 0;
    fadePosition_ = 0;
    grainFrames_ = 0;
    beatIntervalFrames_ = static_cast<double>(spec_.sampleRate) * 0.125;
    nextGrainFrame_ = static_cast<double>(absoluteFrame);
    repeatBoundaryExactFrame_ = static_cast<double>(absoluteFrame);
    repeatReadPosition_ = 0.0;
    shiftCurrentDelay_ = static_cast<double>(spec_.maxBlockFrames) * 2.0 + 4.0;
    shiftOldDelay_ = shiftCurrentDelay_;
    shiftTargetDelay_ = shiftCurrentDelay_;
    vinylReadPosition_ = static_cast<double>(absoluteFrame) -
                         static_cast<double>(spec_.sampleRate) * kVinylLatencyMs / 1000.0;
    vinylSpeedRatio_ = 1.0f;
    vinylVelocity_ = 0.0f;
    activeGain_ = 0.0f;
    targetActiveGain_ = 0.0f;
    feedbackState_ = {};
    repeatSourceFrames_ = 0;
    repeatFadeTotalFrames_ = 0;
    historyWriteFrame_ = 0;
    repeatReady_ = false;
    vinylReadInitialized_ = false;
    active_ = false;
    hasExpectedFrame_ = false;
}

void PerformanceFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    resetEffectState(absoluteFrame);
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = true;
}

bool PerformanceFxProcessor::setSeed(std::uint64_t seed) noexcept {
    if (active_ || !prepared_) return false;
    randomSeed_ = seed == 0 ? 0x243f6a8885a308d3ULL : seed;
    randomState_ = randomSeed_;
    return true;
}

bool PerformanceFxProcessor::validateEvent(const PerformanceFxEvent& event) const noexcept {
    switch (event.control) {
    case PerformanceFxControl::Active:
        return event.value == 0.0f || event.value == 1.0f;
    case PerformanceFxControl::TempoBpm:
        return finiteInRange(event.value, 20.0f, 300.0f);
    case PerformanceFxControl::SubdivisionBeats:
        return finiteInRange(event.value, 0.125f,
            kind_ == PerformanceFxKind::BeatRepeat ? 0.5f : 4.0f);
    case PerformanceFxControl::Wet:
        return finiteInRange(event.value, 0.0f, 1.0f);
    case PerformanceFxControl::Feedback:
        return kind_ != PerformanceFxKind::VinylFlick && finiteInRange(event.value, 0.0f, 0.95f);
    case PerformanceFxControl::ScatterAmount:
        return kind_ == PerformanceFxKind::BeatScatter && finiteInRange(event.value, 0.0f, 1.0f);
    case PerformanceFxControl::PitchRatio:
        return kind_ == PerformanceFxKind::BeatScatter && std::isfinite(event.value) &&
               ((event.value >= 0.25f && event.value <= 2.0f) ||
                (event.value <= -0.25f && event.value >= -2.0f));
    case PerformanceFxControl::ShiftBeats:
        return kind_ == PerformanceFxKind::BeatShift && finiteInRange(event.value, -2.0f, 2.0f);
    case PerformanceFxControl::FlickImpulse:
        return kind_ == PerformanceFxKind::VinylFlick && finiteInRange(event.value, -1.0f, 1.0f);
    }
    return false;
}

bool PerformanceFxProcessor::validateEvents(std::uint32_t frames,
                                            const PerformanceFxEvent* events,
                                            std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0 && !events)) return false;
    std::uint32_t previousOffset = 0;
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames ||
            (i != 0 && events[i].frameOffset < previousOffset) ||
            !validateEvent(events[i])) return false;
        previousOffset = events[i].frameOffset;
    }
    return true;
}

bool PerformanceFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                          StereoFrame* interleaved,
                                          std::uint32_t frames,
                                          const PerformanceFxEvent* events,
                                          std::uint32_t eventCount) noexcept {
    if (!prepared_ || !interleaved || frames == 0 || frames > spec_.maxBlockFrames ||
        blockStartFrame >= (1ULL << 53U) ||
        static_cast<std::uint64_t>(frames) > (1ULL << 53U) - blockStartFrame ||
        !validateEvents(frames, events, eventCount) ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_)) return false;
    if (!hasExpectedFrame_) {
        expectedFrame_ = blockStartFrame;
        if (!vinylReadInitialized_) {
            vinylReadPosition_ = static_cast<double>(blockStartFrame) -
                                 static_cast<double>(spec_.sampleRate) * kVinylLatencyMs / 1000.0;
        }
        hasExpectedFrame_ = true;
    }

    std::uint32_t eventIndex = 0;
    for (std::uint32_t offset = 0; offset < frames; ++offset) {
        const auto absoluteFrame = blockStartFrame + offset;
        while (eventIndex < eventCount && events[eventIndex].frameOffset == offset) {
            applyEvent(events[eventIndex], absoluteFrame);
            ++eventIndex;
        }
        interleaved[offset] = renderSample(interleaved[offset], absoluteFrame);
    }
    expectedFrame_ = blockStartFrame + frames;
    return true;
}

void PerformanceFxProcessor::updateBeatInterval(std::uint64_t absoluteFrame) noexcept {
    beatIntervalFrames_ = static_cast<double>(spec_.sampleRate) * 60.0 /
                          static_cast<double>(tempoBpm_) * subdivisionBeats_;
    beatIntervalFrames_ = std::clamp(beatIntervalFrames_, 2.0,
                                     static_cast<double>(historyFrames_ - kHistoryGuardFrames));
    if (kind_ == PerformanceFxKind::BeatScatter && active_) {
        nextGrainFrame_ = static_cast<double>(absoluteFrame) + beatIntervalFrames_;
    }
    if (kind_ == PerformanceFxKind::BeatShift) {
        const double baseDelay = static_cast<double>(spec_.maxBlockFrames) * 2.0 + 4.0;
        const double maxDelay = static_cast<double>(historyFrames_ - spec_.maxBlockFrames - 4U);
        const auto target = std::clamp(baseDelay + shiftBeats_ * beatIntervalFrames_ /
                                      static_cast<double>(subdivisionBeats_),
                                      static_cast<double>(spec_.maxBlockFrames) + 4.0, maxDelay);
        if (std::fabs(target - shiftTargetDelay_) > 0.5) {
            shiftOldDelay_ = shiftCurrentDelay_;
            shiftTargetDelay_ = target;
            fadePosition_ = 0;
        }
    }
}

void PerformanceFxProcessor::applyEvent(const PerformanceFxEvent& event,
                                        std::uint64_t absoluteFrame) noexcept {
    switch (event.control) {
    case PerformanceFxControl::Active: {
        const bool nextActive = event.value > 0.5f;
        if (nextActive == active_) break;
        active_ = nextActive;
        targetActiveGain_ = nextActive ? 1.0f : 0.0f;
        fadePosition_ = 0;
        if (nextActive) {
            activeSinceFrame_ = absoluteFrame;
            updateBeatInterval(absoluteFrame);
            if (kind_ == PerformanceFxKind::BeatScatter) {
                nextGrainFrame_ = static_cast<double>(absoluteFrame);
            } else if (kind_ == PerformanceFxKind::BeatRepeat) {
                captureRepeat(absoluteFrame, false);
                repeatCycleStartFrame_ = absoluteFrame;
                repeatBoundaryExactFrame_ = static_cast<double>(absoluteFrame) + beatIntervalFrames_;
                repeatFadePosition_ = repeatFadeTotalFrames_;
                repeatReadPosition_ = static_cast<double>(repeatFadeTotalFrames_);
            } else if (kind_ == PerformanceFxKind::VinylFlick) {
                vinylReadPosition_ = static_cast<double>(absoluteFrame) -
                                     static_cast<double>(spec_.sampleRate) * kVinylLatencyMs / 1000.0;
                vinylReadInitialized_ = true;
            }
        }
        break;
    }
    case PerformanceFxControl::TempoBpm:
        tempoBpm_ = event.value;
        updateBeatInterval(absoluteFrame);
        if (kind_ == PerformanceFxKind::BeatRepeat && active_) {
            captureRepeat(absoluteFrame, true);
            repeatCycleStartFrame_ = absoluteFrame;
            repeatBoundaryExactFrame_ = static_cast<double>(absoluteFrame) + beatIntervalFrames_;
            repeatReadPosition_ = static_cast<double>(repeatFadeTotalFrames_);
        }
        break;
    case PerformanceFxControl::SubdivisionBeats:
        subdivisionBeats_ = event.value;
        updateBeatInterval(absoluteFrame);
        if (kind_ == PerformanceFxKind::BeatRepeat && active_) {
            captureRepeat(absoluteFrame, true);
            repeatCycleStartFrame_ = absoluteFrame;
            repeatBoundaryExactFrame_ = static_cast<double>(absoluteFrame) + beatIntervalFrames_;
            repeatReadPosition_ = static_cast<double>(repeatFadeTotalFrames_);
        }
        break;
    case PerformanceFxControl::Wet:
        wet_ = event.value;
        break;
    case PerformanceFxControl::Feedback:
        feedback_ = event.value;
        break;
    case PerformanceFxControl::ScatterAmount:
        scatterAmount_ = event.value;
        break;
    case PerformanceFxControl::PitchRatio:
        pitchRatio_ = event.value;
        break;
    case PerformanceFxControl::ShiftBeats:
        shiftBeats_ = event.value;
        updateBeatInterval(absoluteFrame);
        break;
    case PerformanceFxControl::FlickImpulse:
        vinylVelocity_ = std::clamp(vinylVelocity_ + event.value * 20.0f, -40.0f, 40.0f);
        break;
    }
}

void PerformanceFxProcessor::captureRepeat(std::uint64_t absoluteFrame,
                                           bool feedbackFromPrevious) noexcept {
    if (repeatBuffers_[0].empty() || history_.empty()) return;
    const auto maximum = static_cast<std::uint32_t>(repeatBuffers_[0].size());
    const auto desired = clampFrameCount(beatIntervalFrames_, maximum);
    repeatFrames_ = std::min(desired, maximum);
    const auto destination = repeatReady_ ? 1U - repeatActiveBuffer_ : 0U;
    const auto start = static_cast<std::int64_t>(absoluteFrame) - repeatFrames_;
    const auto feedbackGain = feedbackFromPrevious ? feedbackCurrent_ : 0.0f;
    for (std::uint32_t i = 0; i < repeatFrames_; ++i) {
        auto sample = historyAt(start + static_cast<std::int64_t>(i));
        if (feedbackGain > 0.0f && repeatReady_) {
            const auto previous = repeatBuffers_[repeatActiveBuffer_][i % repeatFrames_];
            sample.left = std::clamp(sample.left + feedbackGain * previous.left, -8.0f, 8.0f);
            sample.right = std::clamp(sample.right + feedbackGain * previous.right, -8.0f, 8.0f);
        }
        repeatBuffers_[destination][i] = sample;
    }
    if (repeatReady_) {
        repeatFadeTotalFrames_ = std::max<std::uint32_t>(2U,
            std::min(fadeFrames_, repeatFrames_ / 4U));
        repeatFadePosition_ = 0;
    } else {
        repeatFadeTotalFrames_ = 0;
        repeatFadePosition_ = 0;
    }
    repeatActiveBuffer_ = destination;
    repeatPosition_ = 0;
    repeatSourceFrames_ = repeatFrames_;
    repeatReady_ = true;
}

void PerformanceFxProcessor::spawnGrain(std::uint64_t absoluteFrame) noexcept {
    std::uint32_t slot = static_cast<std::uint32_t>(grains_.size());
    std::uint32_t oldestAge = 0;
    for (std::uint32_t i = 0; i < grains_.size(); ++i) {
        if (!grains_[i].active) {
            slot = i;
            break;
        }
        if (grains_[i].age > oldestAge) {
            oldestAge = grains_[i].age;
            slot = i;
        }
    }
    const auto maxGrain = std::min<std::uint32_t>(kMaximumGrainFrames,
        static_cast<std::uint32_t>(std::ceil(spec_.sampleRate * 0.15f)));
    const auto length = std::clamp<std::uint32_t>(
        static_cast<std::uint32_t>(std::ceil(std::min(beatIntervalFrames_ * 0.5,
                                                     static_cast<double>(maxGrain)))),
        kMinimumGrainFrames, maxGrain);
    const double grainSpan = static_cast<double>(length) * std::fabs(pitchRatio_);
    const double minimumDelay = grainSpan + 8.0;
    const double historyWindow = std::max(0.0,
        static_cast<double>(historyFrames_ - spec_.maxBlockFrames - 8U) - minimumDelay);
    const double maximumWindow = std::min(beatIntervalFrames_ * 4.0, historyWindow);
    const double scatterWindow = maximumWindow * static_cast<double>(scatterAmount_);
    const double grainDelay = minimumDelay + randomUnit() * scatterWindow;
    auto& grain = grains_[slot];
    grain.readPosition = static_cast<double>(absoluteFrame) - grainDelay;
    grain.readStep = pitchRatio_;
    grain.age = 0;
    grain.length = length;
    grain.active = true;
}

StereoFrame PerformanceFxProcessor::readHistory(double absoluteFrame) const noexcept {
    if (history_.empty() || !std::isfinite(absoluteFrame) || absoluteFrame < 0.0) return {};
    const auto base = static_cast<std::int64_t>(std::floor(absoluteFrame));
    const auto phase = static_cast<float>(absoluteFrame - static_cast<double>(base));
    const auto a = historyAt(base - 1);
    const auto b = historyAt(base);
    const auto c = historyAt(base + 1);
    const auto d = historyAt(base + 2);
    return {lagrange4(a.left, b.left, c.left, d.left, phase),
            lagrange4(a.right, b.right, c.right, d.right, phase)};
}

StereoFrame PerformanceFxProcessor::historyAt(std::int64_t absoluteFrame) const noexcept {
    if (history_.empty() || absoluteFrame < 0) return {};
    return history_[wrapIndex(absoluteFrame, historyFrames_)];
}

void PerformanceFxProcessor::writeHistory(std::uint64_t absoluteFrame,
                                          StereoFrame frame) noexcept {
    frame.left = boundedAudio(frame.left + feedbackCurrent_ * feedbackState_.left);
    frame.right = boundedAudio(frame.right + feedbackCurrent_ * feedbackState_.right);
    historyWriteFrame_ = static_cast<std::uint32_t>(absoluteFrame % historyFrames_);
    history_[historyWriteFrame_] = frame;
}

float PerformanceFxProcessor::randomUnit() noexcept {
    auto value = randomState_;
    value ^= value >> 12U;
    value ^= value << 25U;
    value ^= value >> 27U;
    randomState_ = value;
    const auto bits = static_cast<std::uint32_t>((value * 0x2545f4914f6cdd1dULL) >> 40U);
    return static_cast<float>(bits) / 16777216.0f;
}

StereoFrame PerformanceFxProcessor::renderSample(StereoFrame input,
                                                 std::uint64_t absoluteFrame) noexcept {
    input.left = boundedAudio(input.left);
    input.right = boundedAudio(input.right);
    wetCurrent_ += (wet_ - wetCurrent_) * static_cast<float>(wetSmoothingCoefficient_);
    feedbackCurrent_ += (feedback_ - feedbackCurrent_) *
                        static_cast<float>(feedbackSmoothingCoefficient_);
    const auto activeCoefficient = static_cast<float>(wetSmoothingCoefficient_);
    activeGain_ += (targetActiveGain_ - activeGain_) * activeCoefficient;
    if (std::fabs(targetActiveGain_ - activeGain_) < 1.0e-6f) activeGain_ = targetActiveGain_;

    writeHistory(absoluteFrame, input);
    StereoFrame wet{};
    switch (kind_) {
    case PerformanceFxKind::BeatScatter: {
        if (active_ && static_cast<double>(absoluteFrame) >= nextGrainFrame_) {
            spawnGrain(absoluteFrame);
            nextGrainFrame_ += beatIntervalFrames_;
        }
        constexpr float kFixedGrainGain = 0.25f;
        for (auto& grain : grains_) {
            if (!grain.active) continue;
            if (grain.length < 2 || grain.age >= grain.length) {
                grain.active = false;
                continue;
            }
            const float phase = static_cast<float>(grain.age) /
                                static_cast<float>(grain.length - 1U);
            const float window = 0.5f - 0.5f * std::cos(static_cast<float>(2.0 * kPi) * phase);
            const auto sample = readHistory(grain.readPosition);
            wet.left += sample.left * window * kFixedGrainGain;
            wet.right += sample.right * window * kFixedGrainGain;
            grain.readPosition += grain.readStep;
            ++grain.age;
            if (grain.age >= grain.length) grain.active = false;
        }
        wet.left = boundedAudio(wet.left);
        wet.right = boundedAudio(wet.right);
        break;
    }
    case PerformanceFxKind::BeatRepeat: {
        if (active_ && repeatReady_ &&
            static_cast<double>(absoluteFrame) >= repeatBoundaryExactFrame_) {
            captureRepeat(absoluteFrame, true);
            repeatCycleStartFrame_ = absoluteFrame;
            repeatBoundaryExactFrame_ += beatIntervalFrames_;
            repeatReadPosition_ = static_cast<double>(repeatFadeTotalFrames_);
        }
        if (repeatReady_ && repeatFrames_ > 0 && (active_ || activeGain_ > 1.0e-5f)) {
            const auto loopLimit = static_cast<double>(repeatFrames_);
            const auto seamFrames = std::min<std::uint32_t>(
                std::max<std::uint32_t>(2U, static_cast<std::uint32_t>(std::ceil(spec_.sampleRate * 0.001f))),
                std::max<std::uint32_t>(2U, repeatFrames_ / 4U));
            const auto playLength = std::max(2.0, loopLimit - seamFrames);
            const auto position = std::clamp(repeatReadPosition_, 0.0,
                                              std::max(0.0, loopLimit - 1.0));
            const auto readLoop = [this](std::uint32_t bufferIndex, double index) noexcept {
                const auto size = static_cast<std::int64_t>(repeatFrames_);
                const auto wrappedIndex = [size](std::int64_t value) noexcept {
                    auto wrapped = value % size;
                    if (wrapped < 0) wrapped += size;
                    return static_cast<std::uint32_t>(wrapped);
                };
                const auto base = static_cast<std::int64_t>(std::floor(index));
                const auto fraction = static_cast<float>(index - static_cast<double>(base));
                const auto& loop = repeatBuffers_[bufferIndex];
                const auto a = loop[wrappedIndex(base - 1)];
                const auto b = loop[wrappedIndex(base)];
                const auto c = loop[wrappedIndex(base + 1)];
                const auto d = loop[wrappedIndex(base + 2)];
                return StereoFrame{lagrange4(a.left, b.left, c.left, d.left, fraction),
                                   lagrange4(a.right, b.right, c.right, d.right, fraction)};
            };
            const auto current = readLoop(repeatActiveBuffer_, position);
            if (position >= loopLimit - seamFrames) {
                const auto seamPhase = static_cast<float>((position - (loopLimit - seamFrames)) /
                                                          std::max(1.0, static_cast<double>(seamFrames)));
                const auto head = readLoop(repeatActiveBuffer_, position - (loopLimit - seamFrames));
                wet.left = equalPowerCrossfade(current.left, head.left, seamPhase);
                wet.right = equalPowerCrossfade(current.right, head.right, seamPhase);
            } else {
                wet = current;
            }
            if (repeatFadePosition_ < repeatFadeTotalFrames_) {
                const auto oldBuffer = 1U - repeatActiveBuffer_;
                const auto phase = static_cast<float>(repeatFadePosition_) /
                    static_cast<float>(std::max<std::uint32_t>(1U, repeatFadeTotalFrames_ - 1U));
                const auto oldSample = readLoop(oldBuffer, position);
                wet.left = equalPowerCrossfade(oldSample.left, wet.left, phase);
                wet.right = equalPowerCrossfade(oldSample.right, wet.right, phase);
                ++repeatFadePosition_;
            }
            repeatReadPosition_ += playLength / beatIntervalFrames_;
            if (repeatReadPosition_ >= loopLimit) repeatReadPosition_ -= playLength;
        } else if (targetActiveGain_ == 0.0f && activeGain_ < 1.0e-5f) {
            repeatReady_ = false;
        }
        break;
    }
    case PerformanceFxKind::BeatShift: {
        if (fadePosition_ < fadeFrames_) {
            const auto phase = static_cast<float>(fadePosition_) /
                static_cast<float>(std::max<std::uint32_t>(1U, fadeFrames_ - 1U));
            const auto oldSample = readHistory(static_cast<double>(absoluteFrame) - shiftOldDelay_);
            const auto newSample = readHistory(static_cast<double>(absoluteFrame) - shiftTargetDelay_);
            wet.left = equalPowerCrossfade(oldSample.left, newSample.left, phase);
            wet.right = equalPowerCrossfade(oldSample.right, newSample.right, phase);
            ++fadePosition_;
            if (fadePosition_ >= fadeFrames_) shiftCurrentDelay_ = shiftTargetDelay_;
        } else {
            wet = readHistory(static_cast<double>(absoluteFrame) - shiftCurrentDelay_);
        }
        break;
    }
    case PerformanceFxKind::VinylFlick: {
        constexpr double kNaturalFrequencyHz = 8.0;
        constexpr double kDamping = 0.82;
        const double omega = 2.0 * kPi * kNaturalFrequencyHz;
        const double dt = 1.0 / static_cast<double>(spec_.sampleRate);
        const double acceleration = -omega * omega * (vinylSpeedRatio_ - 1.0) -
                                    2.0 * kDamping * omega * vinylVelocity_;
        vinylVelocity_ = std::clamp(static_cast<float>(vinylVelocity_ + acceleration * dt),
                                    -40.0f, 40.0f);
        vinylSpeedRatio_ = std::clamp(static_cast<float>(vinylSpeedRatio_ + vinylVelocity_ * dt),
                                     0.5f, 1.5f);
        const double latency = std::ceil(static_cast<double>(spec_.sampleRate) *
                                         kVinylLatencyMs / 1000.0);
        const double maximumReadPosition = static_cast<double>(absoluteFrame) - latency;
        const double minimumReadPosition = static_cast<double>(absoluteFrame) -
                                           historyFrames_ + spec_.maxBlockFrames + 4.0;
        if (!vinylReadInitialized_) {
            vinylReadPosition_ = maximumReadPosition;
            vinylReadInitialized_ = true;
        }
        vinylReadPosition_ = std::clamp(vinylReadPosition_, minimumReadPosition,
                                        maximumReadPosition);
        wet = readHistory(vinylReadPosition_);
        vinylReadPosition_ += vinylSpeedRatio_;
        const auto delayedDry = readHistory(maximumReadPosition);
        feedbackState_ = wet;
        const float mix = activeGain_ * wetCurrent_;
        return {sanitize(delayedDry.left + (wet.left - delayedDry.left) * mix),
                sanitize(delayedDry.right + (wet.right - delayedDry.right) * mix)};
    }
    }

    feedbackState_ = wet;
    const float mix = activeGain_ * wetCurrent_;
    return {sanitize(input.left + (wet.left - input.left) * mix),
            sanitize(input.right + (wet.right - input.right) * mix)};
}

std::uint32_t PerformanceFxProcessor::activeGrains() const noexcept {
    std::uint32_t count = 0;
    for (const auto& grain : grains_) count += grain.active ? 1U : 0U;
    return count;
}

std::uint32_t PerformanceFxProcessor::algorithmicLatencySamples() const noexcept {
    return kind_ == PerformanceFxKind::VinylFlick
        ? static_cast<std::uint32_t>(std::ceil(spec_.sampleRate * kVinylLatencyMs / 1000.0f))
        : 0U;
}

} // namespace webrc::dsp
