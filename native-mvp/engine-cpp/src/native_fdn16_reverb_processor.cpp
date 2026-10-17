#include "native_fdn16_reverb_processor.hpp"

#include <algorithm>
#include <cmath>
#include <new>

namespace webrc::native {
namespace {

constexpr double kTwoPi = 6.28318530717958647692;
constexpr double kReferenceSampleRate = 48000.0;
// The input/output projections of this clean-room stereo FDN make the
// measured Schroeder energy-decay time about 0.88x the per-loop target. This
// empirical calibration brings the no-damping RT60 control in line with its
// measured value; damping still shortens high-frequency decay as intended.
constexpr double kMeasuredRt60Calibration = 1.14;
constexpr float kHadamardScale = 0.25f;
constexpr float kDenormalFloor = 1.0e-20f;
constexpr float kMaximumInputMagnitude = 16.0f;

// These are distinct primes at 48 kHz. At other rates their delay times are
// preserved and each rounded length is advanced to the next prime. The
// relatively prime, 31-112 ms lines create a dense late field without a
// Schroeder series/parallel comb-allpass structure.
constexpr std::array<unsigned int, NativeFdn16ReverbProcessor::kLineCount> kReferenceDelayFrames{{
    1493U, 1747U, 2011U, 2267U, 2521U, 2777U, 3037U, 3299U,
    3557U, 3821U, 4073U, 4327U, 4583U, 4861U, 5099U, 5351U,
}};

[[nodiscard]] bool isPrime(unsigned int value) noexcept {
    if (value < 2U) return false;
    if ((value % 2U) == 0U) return value == 2U;
    for (unsigned int divisor = 3U; divisor <= value / divisor; divisor += 2U) {
        if ((value % divisor) == 0U) return false;
    }
    return true;
}

[[nodiscard]] unsigned int nextPrime(unsigned int value) noexcept {
    if (value <= 2U) return 2U;
    unsigned int candidate = (value % 2U) == 0U ? value + 1U : value;
    while (!isPrime(candidate)) candidate += 2U;
    return candidate;
}

[[nodiscard]] float finiteInput(float sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return std::clamp(sample, -kMaximumInputMagnitude, kMaximumInputMagnitude);
}

[[nodiscard]] float flushDenormal(float sample) noexcept {
    return std::fabs(sample) < kDenormalFloor ? 0.0f : sample;
}

} // namespace

unsigned int NativeFdn16ReverbProcessor::minimumDelayFramesForSampleRate(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return 0U;
    const double scaledFrames = static_cast<double>(kReferenceDelayFrames[0]) *
        static_cast<double>(sampleRate) / kReferenceSampleRate;
    return nextPrime(static_cast<unsigned int>(std::max(2.0, std::round(scaledFrames))));
}

bool NativeFdn16ReverbProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < kMinimumSampleRate || sampleRate > kMaximumSampleRate) return false;

    sampleRate_ = 0U;
    std::array<unsigned int, kLineCount> nextDelayFrames{};
    try {
        for (std::size_t line = 0U; line < kLineCount; ++line) {
            const double scaledFrames = static_cast<double>(kReferenceDelayFrames[line]) *
                static_cast<double>(sampleRate) / kReferenceSampleRate;
            const auto roundedFrames = static_cast<unsigned int>(std::max(2.0, std::round(scaledFrames)));
            const unsigned int delayFrames = nextPrime(roundedFrames);
            nextDelayFrames[line] = delayFrames;
            delayLines_[line].assign(delayFrames, 0.0f);
        }
    } catch (const std::bad_alloc&) {
        return false;
    } catch (...) {
        return false;
    }

    delayFrames_ = nextDelayFrames;
    sampleRate_ = sampleRate;
    writeIndices_.fill(0U);
    dampingState_.fill(0.0f);
    wetMix_.reset(config_.enabled ? config_.wetMix : 0.0f);
    rt60Seconds_.reset(config_.rt60Seconds);
    dampingCutoffHz_.reset(config_.dampingCutoffHz);
    processedFrames_ = 0U;
    updateFeedbackAndDamping(rt60Seconds_.current(), dampingCutoffHz_.current());
    return true;
}

bool NativeFdn16ReverbProcessor::setConfig(
    const NativeFdn16ReverbConfig& config,
    std::uint64_t rampFrames
) noexcept {
    if (!std::isfinite(config.wetMix) || !std::isfinite(config.rt60Seconds) ||
        !std::isfinite(config.dampingCutoffHz) || config.wetMix < 0.0f || config.wetMix > 1.0f ||
        config.rt60Seconds < 0.1f || config.rt60Seconds > 20.0f ||
        config.dampingCutoffHz < 500.0f || config.dampingCutoffHz > 20000.0f) {
        return false;
    }

    config_ = config;
    wetMix_.setTarget(config.enabled ? config.wetMix : 0.0f, rampFrames);
    rt60Seconds_.setTarget(config.rt60Seconds, rampFrames);
    dampingCutoffHz_.setTarget(config.dampingCutoffHz, rampFrames);
    return true;
}

void NativeFdn16ReverbProcessor::updateFeedbackAndDamping(
    float rt60Seconds,
    float dampingCutoffHz
) noexcept {
    if (sampleRate_ == 0U || !std::isfinite(rt60Seconds) || !std::isfinite(dampingCutoffHz)) return;

    const double rate = static_cast<double>(sampleRate_);
    const double cutoff = std::clamp(
        static_cast<double>(dampingCutoffHz),
        1.0,
        rate * 0.45
    );
    dampingAlpha_ = static_cast<float>(std::exp(-kTwoPi * cutoff / rate));

    const double boundedRt60 = std::clamp(
        static_cast<double>(rt60Seconds) * kMeasuredRt60Calibration,
        0.1,
        20.0
    );
    for (std::size_t line = 0U; line < kLineCount; ++line) {
        const double delaySeconds = static_cast<double>(delayFrames_[line]) / rate;
        feedbackGains_[line] = static_cast<float>(std::pow(0.001, delaySeconds / boundedRt60));
    }
}

void NativeFdn16ReverbProcessor::hadamardTransform(
    std::array<float, kLineCount>& values
) noexcept {
    for (std::size_t width = 1U; width < kLineCount; width *= 2U) {
        const std::size_t blockSize = width * 2U;
        for (std::size_t block = 0U; block < kLineCount; block += blockSize) {
            for (std::size_t offset = 0U; offset < width; ++offset) {
                const float first = values[block + offset];
                const float second = values[block + offset + width];
                values[block + offset] = first + second;
                values[block + offset + width] = first - second;
            }
        }
    }
}

float NativeFdn16ReverbProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) return 0.0f;

    float peak = 0.0f;
    const unsigned int processedChannels = std::min<unsigned int>(channels, 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float wetMix = std::clamp(wetMix_.next(), 0.0f, 1.0f);
        const float rt60 = rt60Seconds_.next();
        const float cutoff = dampingCutoffHz_.next();
        if ((processedFrames_ % kControlUpdateInterval) == 0U) {
            updateFeedbackAndDamping(rt60, cutoff);
        }
        ++processedFrames_;

        const std::size_t offset = static_cast<std::size_t>(frame) * channels;
        const float rawLeft = interleaved[offset];
        const float rawRight = processedChannels > 1U ? interleaved[offset + 1U] : 0.0f;
        const float dryLeft = std::isfinite(rawLeft) ? rawLeft : 0.0f;
        const float dryRight = std::isfinite(rawRight) ? rawRight : 0.0f;
        const float injectionLeft = finiteInput(dryLeft);
        const float injectionRight = finiteInput(dryRight);
        std::array<float, kLineCount> delayed{};
        std::array<float, kLineCount> feedbackInput{};
        std::array<float, kLineCount> injected{};
        double wetLeft = 0.0;
        double wetRight = 0.0;

        for (std::size_t line = 0U; line < kLineCount; ++line) {
            const float sample = delayLines_[line][writeIndices_[line]];
            delayed[line] = sample;
            float damped = ((1.0f - dampingAlpha_) * sample) + (dampingAlpha_ * dampingState_[line]);
            damped = flushDenormal(damped);
            dampingState_[line] = damped;
            feedbackInput[line] = damped;

            // Four orthogonal rows of H16 form stereo input/output vectors.
            // This keeps L/R injection energy-normalized and produces distinct
            // left/right late-field projections without random modulation.
            const float inputRightBasis = (line & 1U) == 0U ? 1.0f : -1.0f;
            const float outputLeftBasis = (line & 2U) == 0U ? 1.0f : -1.0f;
            const bool outputRightNegative = ((line & 1U) != 0U) != ((line & 2U) != 0U);
            const float outputRightBasis = outputRightNegative ? -1.0f : 1.0f;
            injected[line] = kHadamardScale * (injectionLeft + (inputRightBasis * injectionRight));
            wetLeft += static_cast<double>(sample) * static_cast<double>(outputLeftBasis * kHadamardScale);
            wetRight += static_cast<double>(sample) * static_cast<double>(outputRightBasis * kHadamardScale);
        }

        hadamardTransform(feedbackInput);
        for (std::size_t line = 0U; line < kLineCount; ++line) {
            const float reflected = feedbackInput[line] * kHadamardScale;
            float writeValue = injected[line] + (feedbackGains_[line] * reflected);
            if (!std::isfinite(writeValue)) writeValue = 0.0f;
            delayLines_[line][writeIndices_[line]] = writeValue;
            const std::size_t next = writeIndices_[line] + 1U;
            writeIndices_[line] = next == delayLines_[line].size() ? 0U : next;
        }

        const auto gains = dsp::equalPowerCrossfadeGains(wetMix);
        const float outputLeft = (dryLeft * gains.first) + (static_cast<float>(wetLeft) * gains.second);
        const float outputRight = (dryRight * gains.first) + (static_cast<float>(wetRight) * gains.second);
        if (processedChannels > 0U) {
            interleaved[offset] = outputLeft;
            peak = std::max(peak, std::fabs(outputLeft));
        }
        if (processedChannels > 1U) {
            interleaved[offset + 1U] = outputRight;
            peak = std::max(peak, std::fabs(outputRight));
        }
        for (unsigned int channel = processedChannels; channel < channels; ++channel) {
            peak = std::max(peak, std::fabs(interleaved[offset + channel]));
        }
    }
    return peak;
}

void NativeFdn16ReverbProcessor::resetState() noexcept {
    if (sampleRate_ == 0U) return;
    for (auto& line : delayLines_) std::fill(line.begin(), line.end(), 0.0f);
    writeIndices_.fill(0U);
    dampingState_.fill(0.0f);
    wetMix_.reset(config_.enabled ? config_.wetMix : 0.0f);
    rt60Seconds_.reset(config_.rt60Seconds);
    dampingCutoffHz_.reset(config_.dampingCutoffHz);
    processedFrames_ = 0U;
    updateFeedbackAndDamping(rt60Seconds_.current(), dampingCutoffHz_.current());
}

} // namespace webrc::native
