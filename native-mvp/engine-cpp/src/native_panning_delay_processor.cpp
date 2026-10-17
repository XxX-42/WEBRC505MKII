#include "native_panning_delay_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr unsigned int kMinimumSampleRate = 8000U;
constexpr unsigned int kMaximumSampleRate = 192000U;
constexpr float kMaximumFeedbackFraction = 0.95f;
constexpr float kFeedbackStabilityMargin = 0.98f;
constexpr float kMaximumInputMagnitude = 8.0f;
constexpr float kInverseSqrtTwo = 0.7071067811865475f;

[[nodiscard]] float finiteBounded(float value, float maximumMagnitude) noexcept {
    return std::isfinite(value) ? std::clamp(value, -maximumMagnitude, maximumMagnitude) : 0.0f;
}

} // namespace

bool NativePanningDelayProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return false;

    const std::size_t maximumDelayFrames = static_cast<std::size_t>(std::ceil(
        static_cast<double>(kMaximumTimeMs) * static_cast<double>(sampleRate) / 1000.0
    ));
    const std::size_t capacity = maximumDelayFrames + 4U;
    std::array<std::vector<float>, kLineCount> newLines{};
    try {
        for (auto& line : newLines) line.assign(capacity, 0.0f);
    } catch (const std::bad_alloc&) {
        return false;
    } catch (...) {
        return false;
    }

    delayLines_.swap(newLines);
    sampleRate_ = sampleRate;
    reset();
    return true;
}

bool NativePanningDelayProcessor::setConfig(
    const NativePanningDelayProcessorConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!std::isfinite(config.timeMs) || !std::isfinite(config.feedbackPercent) ||
        !std::isfinite(config.panPercent) || !std::isfinite(config.mixPercent) ||
        config.timeMs < kMinimumTimeMs || config.timeMs > kMaximumTimeMs ||
        config.feedbackPercent < 0.0f || config.feedbackPercent > kMaximumFeedbackPercent ||
        config.panPercent < kMinimumPanPercent || config.panPercent > kMaximumPanPercent ||
        config.mixPercent < 0.0f || config.mixPercent > kMaximumMixPercent) {
        return false;
    }

    config_ = config;
    timeMs_.setTarget(config.timeMs, rampFrames);
    feedbackPercent_.setTarget(config.feedbackPercent, rampFrames);
    panPercent_.setTarget(config.panPercent, rampFrames);
    mixPercent_.setTarget(config.mixPercent, rampFrames);
    return true;
}

void NativePanningDelayProcessor::reset() noexcept {
    for (auto& line : delayLines_) std::fill(line.begin(), line.end(), 0.0f);
    writeIndices_.fill(0U);
    timeMs_.reset(config_.timeMs);
    feedbackPercent_.reset(config_.feedbackPercent);
    panPercent_.reset(config_.panPercent);
    mixPercent_.reset(config_.mixPercent);
}

float NativePanningDelayProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U ||
        delayLines_[0].empty() || delayLines_[1].empty()) {
        return 0.0f;
    }

    const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
    const std::size_t maximumDelayFrames = delayLines_[0].size() - 4U;
    const float sampleRate = static_cast<float>(sampleRate_);
    float peak = 0.0f;

    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const std::size_t offset = static_cast<std::size_t>(frame) * channels;
        std::array<float, 2U> dry{};
        dry[0U] = finiteBounded(interleaved[offset], kMaximumInputMagnitude);
        if (processedChannels > 1U) {
            dry[1U] = finiteBounded(interleaved[offset + 1U], kMaximumInputMagnitude);
        } else {
            // Mono input is mirrored internally so its feedback remains
            // mono; its output stays mono and the pan control is immaterial.
            dry[1U] = dry[0U];
        }

        const double delayFrames = std::clamp(
            static_cast<double>(timeMs_.next()) * static_cast<double>(sampleRate) / 1000.0,
            2.0,
            static_cast<double>(maximumDelayFrames)
        );
        std::array<float, 2U> delayed{};
        for (std::size_t line = 0U; line < kLineCount; ++line) {
            delayed[line] = readFractionalDelay(delayLines_[line], writeIndices_[line], delayFrames);
        }

        const float feedback = std::clamp(
            feedbackPercent_.next() * 0.01f,
            0.0f,
            kMaximumFeedbackFraction
        ) * kFeedbackStabilityMargin;
        for (std::size_t line = 0U; line < kLineCount; ++line) {
            auto& buffer = delayLines_[line];
            const std::size_t writeIndex = writeIndices_[line];
            // The feedback matrix is the stable, bounded cross-coupling
            // [[0, feedback], [feedback, 0]]; each output line feeds the other.
            const float record = finiteBounded(
                dry[line] + feedback * delayed[1U - line],
                kMaximumStateMagnitude
            );
            buffer[writeIndex] = record;
            const std::size_t next = writeIndex + 1U;
            writeIndices_[line] = next == buffer.size() ? 0U : next;
        }

        const float pan = std::clamp(panPercent_.next(), -100.0f, 100.0f);
        const double panPosition = static_cast<double>(pan + 100.0f) / 200.0;
        const double panAngle = panPosition * (kPi * 0.5);
        const float leftPanGain = static_cast<float>(std::cos(panAngle));
        const float rightPanGain = static_cast<float>(std::sin(panAngle));
        // Clean-room equal-power fold-down of the two taps before positioning
        // the repeat. This keeps a one-sided repeat's power bounded.
        const float repeatMono = (delayed[0U] + delayed[1U]) * kInverseSqrtTwo;
        const float wetLeft = repeatMono * leftPanGain;
        const float wetRight = repeatMono * rightPanGain;
        const auto mixGains = dsp::equalPowerCrossfadeGains(
            std::clamp(mixPercent_.next() * 0.01f, 0.0f, 1.0f)
        );

        if (processedChannels == 1U) {
            // A mono stream has no pan dimension; retain a stable mono wet
            // level instead of summing two synthetic stereo pan outputs.
            const float wet = (delayed[0U] + delayed[1U]) * 0.5f;
            const float output = finiteBounded(
                dry[0U] * mixGains.first + wet * mixGains.second,
                kMaximumStateMagnitude
            );
            interleaved[offset] = output;
            peak = std::max(peak, std::fabs(output));
        } else {
            const float left = finiteBounded(
                dry[0U] * mixGains.first + wetLeft * mixGains.second,
                kMaximumStateMagnitude
            );
            const float right = finiteBounded(
                dry[1U] * mixGains.first + wetRight * mixGains.second,
                kMaximumStateMagnitude
            );
            interleaved[offset] = left;
            interleaved[offset + 1U] = right;
            peak = std::max(peak, std::max(std::fabs(left), std::fabs(right)));
        }

        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            const float passthrough = finiteBounded(interleaved[offset + channel], kMaximumInputMagnitude);
            interleaved[offset + channel] = passthrough;
            peak = std::max(peak, std::fabs(passthrough));
        }
    }

    return peak;
}

float NativePanningDelayProcessor::readFractionalDelay(
    const std::vector<float>& line,
    std::size_t writeIndex,
    double delayFrames
) const noexcept {
    const std::size_t capacity = line.size();
    if (capacity < 5U) return 0.0f;

    const double boundedDelay = std::clamp(delayFrames, 2.0, static_cast<double>(capacity - 4U));
    const std::size_t integerDelay = static_cast<std::size_t>(boundedDelay);
    const float fraction = static_cast<float>(boundedDelay - static_cast<double>(integerDelay));
    const auto readAtDelay = [&line, capacity, writeIndex](std::size_t framesAgo) noexcept {
        const std::size_t unwrapped = writeIndex + capacity - framesAgo;
        const std::size_t index = unwrapped >= capacity ? unwrapped - capacity : unwrapped;
        return line[index];
    };
    return dsp::lagrange4(
        readAtDelay(integerDelay - 1U),
        readAtDelay(integerDelay),
        readAtDelay(integerDelay + 1U),
        readAtDelay(integerDelay + 2U),
        fraction
    );
}

} // namespace webrc::native
