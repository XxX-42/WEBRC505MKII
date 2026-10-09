#include "webrc/dsp/control_dynamics.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {

namespace {
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kInvSqrt2 = 0.707106781186547524400844362104849039;

float flushControl(float value) noexcept {
    return !std::isfinite(value) || std::fabs(value) < 1.0e-20f ? 0.0f : value;
}

float finiteFloat(double value) noexcept {
    constexpr double limit = static_cast<double>(std::numeric_limits<float>::max());
    if (!std::isfinite(value)) {
        return std::signbit(value) ? -std::numeric_limits<float>::max()
                                   : std::numeric_limits<float>::max();
    }
    return static_cast<float>(std::clamp(value, -limit, limit));
}

} // namespace

bool pitchRatioSemitones(float semitones, float& ratio) noexcept {
    if (!std::isfinite(semitones) || semitones < -48.0f || semitones > 48.0f) {
        return false;
    }
    const auto candidate = std::exp2(static_cast<double>(semitones) / 12.0);
    if (!std::isfinite(candidate) || candidate < 1.0 / 16.0 || candidate > 16.0) {
        return false;
    }
    ratio = static_cast<float>(candidate);
    return true;
}

bool PatternSlicer::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) return false;
    maxBlockFrames_ = spec.maxBlockFrames;
    prepared_ = true;
    reset();
    return true;
}

void PatternSlicer::reset() noexcept {
    if (stepCount_ == 0) gains_.fill(1.0f);
}

bool PatternSlicer::setPattern(const float* stepGains, std::uint32_t stepCount,
                               float edgeFraction) noexcept {
    if (!stepGains || stepCount == 0 || stepCount > gains_.size() ||
        !std::isfinite(edgeFraction) || edgeFraction < 0.0f || edgeFraction > 0.5f) {
        return false;
    }
    for (std::uint32_t i = 0; i < stepCount; ++i) {
        if (!std::isfinite(stepGains[i]) || stepGains[i] < 0.0f || stepGains[i] > 1.0f) {
            return false;
        }
    }
    std::copy_n(stepGains, stepCount, gains_.begin());
    stepCount_ = stepCount;
    edgeFraction_ = edgeFraction;
    return true;
}

float PatternSlicer::gainAtPhase(double cyclePhase) const noexcept {
    if (stepCount_ == 0 || !std::isfinite(cyclePhase)) return 1.0f;
    double phase = std::fmod(cyclePhase, 1.0);
    if (phase < 0.0) phase += 1.0;
    const double stepPhase = phase * stepCount_;
    const auto step = std::min<std::uint32_t>(static_cast<std::uint32_t>(stepPhase),
                                               stepCount_ - 1U);
    const double local = stepPhase - step;
    const float current = gains_[step];
    if (edgeFraction_ <= 0.0f || local >= edgeFraction_) return current;
    const auto previousIndex = step == 0 ? stepCount_ - 1U : step - 1U;
    const double u = local / edgeFraction_;
    const double curve = 0.5 - 0.5 * std::cos(kPi * u);
    return flushControl(static_cast<float>((1.0 - curve) * gains_[previousIndex] + curve * current));
}

float PatternSlicer::processSample(float input, double cyclePhase) const noexcept {
    return sanitize(input) * gainAtPhase(cyclePhase);
}

bool PatternSlicer::processBlock(const float* input, const double* cyclePhases, float* output,
                                 std::uint32_t frames) const noexcept {
    if (!prepared_ || !input || !cyclePhases || !output || frames > maxBlockFrames_) return false;
    for (std::uint32_t i = 0; i < frames; ++i) output[i] = processSample(input[i], cyclePhases[i]);
    return true;
}

bool SampleAccurateScheduler::prepare(const ProcessSpec& spec, double bpm,
                                      std::uint32_t ppq) noexcept {
    if (!validProcessSpec(spec) || !std::isfinite(bpm) || bpm < 10.0 || bpm > 400.0 ||
        ppq == 0 || ppq > 9600) return false;
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    count_ = 0;
    bpm_ = bpm;
    ppq_ = ppq;
    prepared_ = true;
    return true;
}

void SampleAccurateScheduler::reset() noexcept {
    count_ = 0;
}

bool SampleAccurateScheduler::setTempo(double bpm, std::uint32_t ppq) noexcept {
    if (!prepared_ || !std::isfinite(bpm) || bpm < 10.0 || bpm > 400.0 || ppq == 0 ||
        ppq > 9600) {
        return false;
    }
    bpm_ = bpm;
    ppq_ = ppq;
    return true;
}

bool SampleAccurateScheduler::scheduleAbsolute(const ScheduledEvent& event) noexcept {
    if (!prepared_ || !std::isfinite(event.value) || count_ >= kCapacity) return false;
    const ScheduledEvent scheduled{event.absoluteFrame, event.eventId, event.value, 0, false};
    std::uint32_t insertion = count_;
    while (insertion > 0 && events_[insertion - 1U].absoluteFrame > event.absoluteFrame) {
        events_[insertion] = events_[insertion - 1U];
        --insertion;
    }
    events_[insertion] = scheduled;
    ++count_;
    return true;
}

std::uint64_t SampleAccurateScheduler::tickToFrame(std::uint64_t originFrame,
                                                   std::uint64_t tick) const noexcept {
    if (!prepared_) return std::numeric_limits<std::uint64_t>::max();
    const double samplesPerTick = sampleRate_ * 60.0 / (bpm_ * ppq_);
    const double offset = std::round(samplesPerTick * static_cast<double>(tick));
    if (!std::isfinite(offset) || offset < 0.0 ||
        offset >= static_cast<double>(std::numeric_limits<std::uint64_t>::max() - originFrame)) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    return originFrame + static_cast<std::uint64_t>(offset);
}

bool SampleAccurateScheduler::scheduleTick(std::uint64_t originFrame, std::uint64_t tick,
                                           std::uint32_t eventId, float value) noexcept {
    const auto frame = tickToFrame(originFrame, tick);
    if (frame == std::numeric_limits<std::uint64_t>::max()) return false;
    return scheduleAbsolute({frame, eventId, value});
}

bool SampleAccurateScheduler::collectBlock(std::uint64_t blockStartFrame, std::uint32_t frames,
                                           ScheduledEvent* output,
                                           std::uint32_t outputCapacity,
                                           std::uint32_t& outputCount) noexcept {
    outputCount = 0;
    if (!prepared_ || frames > maxBlockFrames_ || blockStartFrame >
        std::numeric_limits<std::uint64_t>::max() - frames) return false;
    if (frames == 0) return true;
    const auto blockEndFrame = blockStartFrame + frames;
    std::uint32_t dueCount = 0;
    while (dueCount < count_ && events_[dueCount].absoluteFrame < blockEndFrame) ++dueCount;
    if (dueCount > outputCapacity || (dueCount > 0 && !output)) return false;
    for (std::uint32_t i = 0; i < dueCount; ++i) {
        output[i] = events_[i];
        if (output[i].absoluteFrame < blockStartFrame) {
            output[i].blockOffset = 0;
            output[i].late = true;
        } else {
            output[i].blockOffset = static_cast<std::uint32_t>(
                output[i].absoluteFrame - blockStartFrame);
            output[i].late = false;
        }
    }
    for (std::uint32_t i = dueCount; i < count_; ++i) events_[i - dueCount] = events_[i];
    count_ -= dueCount;
    outputCount = dueCount;
    return true;
}

std::int64_t SampleAccurateScheduler::swingOffsetFrames(double sampleRate, double bpm,
                                                         std::uint32_t subdivisionsPerBeat,
                                                         double swing) noexcept {
    if (!std::isfinite(sampleRate) || sampleRate < 8000.0 || sampleRate > 384000.0 ||
        !std::isfinite(bpm) || bpm < 10.0 || bpm > 400.0 || subdivisionsPerBeat == 0 ||
        subdivisionsPerBeat > 64 || !std::isfinite(swing) || swing < -1.0 || swing > 1.0) {
        return 0;
    }
    const double offset = std::round(swing * sampleRate * 60.0 / bpm /
                                     (2.0 * subdivisionsPerBeat));
    return static_cast<std::int64_t>(offset);
}

bool MidSideWidth::prepare(const ProcessSpec& spec, float crossoverHz) noexcept {
    if (!validProcessSpec(spec) || !std::isfinite(crossoverHz) || crossoverHz < 20.0f ||
        crossoverHz > spec.sampleRate * 0.45f || !highWidth_.prepare(spec) ||
        !lowWidth_.prepare(spec)) return false;
    // A one-pole complementary crossover gives low + high = input exactly:
    // high = input - low. This keeps width 1/1 transparent and avoids the
    // phase-cancellation bump caused by subtracting a biquad low-pass output.
    crossoverPole_ = std::exp(-2.0 * kPi * crossoverHz / spec.sampleRate);
    maxBlockFrames_ = spec.maxBlockFrames;
    correlationCoefficient_ = std::exp(-1.0 / (0.05 * spec.sampleRate));
    highWidth_.reset(1.0f);
    lowWidth_.reset(1.0f);
    prepared_ = true;
    reset();
    return true;
}

void MidSideWidth::reset() noexcept {
    lowSideState_ = 0.0;
    highWidth_.reset(highWidth_.target());
    lowWidth_.reset(lowWidth_.target());
    leftPower_ = rightPower_ = crossPower_ = 0.0;
    correlation_ = 1.0f;
}

bool MidSideWidth::setWidth(float highFrequencyWidth, float lowFrequencyWidth,
                            float smoothingMs) noexcept {
    if (!std::isfinite(highFrequencyWidth) || highFrequencyWidth < 0.0f ||
        highFrequencyWidth > 2.0f || !std::isfinite(lowFrequencyWidth) ||
        lowFrequencyWidth < 0.0f || lowFrequencyWidth > 1.0f || !prepared_ ||
        !std::isfinite(smoothingMs) || smoothingMs < 0.0f || smoothingMs > 10000.0f) {
        return false;
    }
    const bool highAccepted = highWidth_.setTarget(highFrequencyWidth, smoothingMs);
    const bool lowAccepted = lowWidth_.setTarget(lowFrequencyWidth, smoothingMs);
    return highAccepted && lowAccepted;
}

StereoFrame MidSideWidth::processSample(float left, float right) noexcept {
    const double l = sanitize(left);
    const double r = sanitize(right);
    const double mid = (l + r) * kInvSqrt2;
    const double side = (l - r) * kInvSqrt2;
    lowSideState_ = (1.0 - crossoverPole_) * side + crossoverPole_ * lowSideState_;
    const double highSide = side - lowSideState_;
    const double scaledSide = lowSideState_ * lowWidth_.next() + highSide * highWidth_.next();
    const float outL = sanitize(finiteFloat((mid + scaledSide) * kInvSqrt2));
    const float outR = sanitize(finiteFloat((mid - scaledSide) * kInvSqrt2));
    const double correlationMix = 1.0 - correlationCoefficient_;
    leftPower_ = correlationCoefficient_ * leftPower_ + correlationMix * outL * outL;
    rightPower_ = correlationCoefficient_ * rightPower_ + correlationMix * outR * outR;
    crossPower_ = correlationCoefficient_ * crossPower_ + correlationMix * outL * outR;
    const double denominator = std::sqrt(std::max(leftPower_ * rightPower_, 0.0));
    if (denominator > 1.0e-15) {
        correlation_ = static_cast<float>(std::clamp(crossPower_ / denominator, -1.0, 1.0));
    }
    return {outL, outR};
}

bool MidSideWidth::processBlock(const float* inputLeft, const float* inputRight,
                                float* outputLeft, float* outputRight,
                                std::uint32_t frames) noexcept {
    if (!prepared_ || !inputLeft || !inputRight || !outputLeft || !outputRight ||
        frames > maxBlockFrames_) return false;
    for (std::uint32_t i = 0; i < frames; ++i) {
        const auto output = processSample(inputLeft[i], inputRight[i]);
        outputLeft[i] = output.left;
        outputRight[i] = output.right;
    }
    return true;
}

bool OnsetDetector::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec)) return false;
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    fastCoefficient_ = std::exp(-1.0 / (0.0005 * sampleRate_));
    slowCoefficient_ = std::exp(-1.0 / (0.030 * sampleRate_));
    prepared_ = true;
    reset();
    return true;
}

void OnsetDetector::reset() noexcept {
    fastLevel_ = slowLevel_ = envelope_ = 0.0f;
    ageSamples_ = refractoryRemaining_ = 0;
    triggered_ = false;
}

bool OnsetDetector::setParameters(float threshold, float adaptiveSensitivity, float attackMs,
                                  float refractoryMs) noexcept {
    if (!prepared_ || !std::isfinite(threshold) || threshold < 0.0f || threshold > 1.0f ||
        !std::isfinite(adaptiveSensitivity) || adaptiveSensitivity < 0.0f ||
        adaptiveSensitivity > 100.0f || !std::isfinite(attackMs) || attackMs < 1.0f ||
        attackMs > 5000.0f || !std::isfinite(refractoryMs) || refractoryMs < 0.0f ||
        refractoryMs > 1000.0f) return false;
    threshold_ = threshold;
    sensitivity_ = adaptiveSensitivity;
    attackSamples_ = std::max(1U, static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(attackMs) * 0.001 * sampleRate_)));
    refractorySamples_ = static_cast<std::uint32_t>(
        std::ceil(static_cast<double>(refractoryMs) * 0.001 * sampleRate_));
    return true;
}

OnsetResult OnsetDetector::processSample(float input) noexcept {
    if (!prepared_) return {};
    const float level = std::fabs(sanitize(input));
    fastLevel_ = flushControl(static_cast<float>(fastCoefficient_ * fastLevel_ +
                                                 (1.0 - fastCoefficient_) * level));
    slowLevel_ = flushControl(static_cast<float>(slowCoefficient_ * slowLevel_ +
                                                 (1.0 - slowCoefficient_) * level));
    const float flux = std::max(0.0f, fastLevel_ - slowLevel_);
    if (refractoryRemaining_ > 0) --refractoryRemaining_;
    bool onset = false;
    if (refractoryRemaining_ == 0 && flux > threshold_ + sensitivity_ * slowLevel_) {
        onset = true;
        triggered_ = true;
        ageSamples_ = 0;
        refractoryRemaining_ = refractorySamples_;
    }
    if (triggered_) {
        const double phase = std::min(1.0, static_cast<double>(ageSamples_) / attackSamples_);
        envelope_ = static_cast<float>(0.5 - 0.5 * std::cos(kPi * phase));
        if (ageSamples_ < attackSamples_) ++ageSamples_;
        else envelope_ = 1.0f;
    }
    return {onset, flushControl(envelope_), flushControl(flux)};
}

bool OnsetDetector::processBlock(const float* input, OnsetResult* output,
                                 std::uint32_t frames) noexcept {
    if (!prepared_ || !input || !output || frames > maxBlockFrames_) return false;
    for (std::uint32_t i = 0; i < frames; ++i) output[i] = processSample(input[i]);
    return true;
}

bool BitRateReducer::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec) || !mixSmoother_.prepare(spec)) return false;
    maxBlockFrames_ = spec.maxBlockFrames;
    prepared_ = true;
    mixSmoother_.reset(mix_);
    reset();
    return true;
}

void BitRateReducer::reset(std::uint64_t seed, std::uint64_t sequence) noexcept {
    held_ = 0.0f;
    samplesUntilQuantize_ = 0;
    mixSmoother_.reset(mix_);
    random_.seed(seed, sequence);
}

bool BitRateReducer::setParameters(std::uint32_t bits, std::uint32_t holdSamples,
                                   float mix, bool tpdfDither, float mixSmoothingMs) noexcept {
    if (!prepared_ || bits < 2 || bits > 24 || holdSamples == 0 || holdSamples > 4096 ||
        !std::isfinite(mix) || mix < 0.0f || mix > 1.0f ||
        !std::isfinite(mixSmoothingMs) || mixSmoothingMs < 0.0f ||
        mixSmoothingMs > 10000.0f) return false;
    if (!mixSmoother_.setTarget(mix, mixSmoothingMs)) return false;
    bits_ = bits;
    holdSamples_ = holdSamples;
    mix_ = mix;
    tpdfDither_ = tpdfDither;
    samplesUntilQuantize_ = 0;
    return true;
}

float BitRateReducer::processSample(float input) noexcept {
    const float dry = sanitize(input);
    const float quantizerInput = std::clamp(dry, -1.0f, 1.0f);
    if (samplesUntilQuantize_ == 0) {
        const float scale = std::ldexp(1.0f, static_cast<int>(bits_ - 1U));
        const float dither = tpdfDither_ ? 0.5f *
            (random_.nextBipolar() + random_.nextBipolar()) : 0.0f;
        held_ = std::clamp(std::round(quantizerInput * scale + dither) / scale, -1.0f, 1.0f);
        samplesUntilQuantize_ = holdSamples_;
    }
    --samplesUntilQuantize_;
    const float wetMix = mixSmoother_.next();
    return sanitize((1.0f - wetMix) * dry + wetMix * held_);
}

bool BitRateReducer::processBlock(const float* input, float* output,
                                  std::uint32_t frames) noexcept {
    if (!prepared_ || !input || !output || frames > maxBlockFrames_) return false;
    for (std::uint32_t i = 0; i < frames; ++i) output[i] = processSample(input[i]);
    return true;
}

bool RingModulator::prepare(const ProcessSpec& spec) noexcept {
    if (!validProcessSpec(spec) || !carrier_.prepare(spec) ||
        !depthSmoother_.prepare(spec)) return false;
    sampleRate_ = spec.sampleRate;
    maxBlockFrames_ = spec.maxBlockFrames;
    prepared_ = true;
    depthSmoother_.reset(depth_);
    reset();
    return true;
}

void RingModulator::reset(float phaseCycles) noexcept {
    carrier_.reset(phaseCycles);
    depthSmoother_.reset(depth_);
}

bool RingModulator::setParameters(float frequencyHz, float depth,
                                  float depthSmoothingMs) noexcept {
    if (!prepared_ || !std::isfinite(frequencyHz) || frequencyHz < 0.0f ||
        frequencyHz > sampleRate_ * 0.45 || !std::isfinite(depth) || depth < 0.0f ||
        depth > 1.0f || !std::isfinite(depthSmoothingMs) || depthSmoothingMs < 0.0f ||
        depthSmoothingMs > 10000.0f || !carrier_.setFrequency(frequencyHz) ||
        !depthSmoother_.setTarget(depth, depthSmoothingMs)) return false;
    depth_ = depth;
    return true;
}

float RingModulator::processSample(float input) noexcept {
    const float x = sanitize(input);
    const float carrier = carrier_.next();
    const float depth = depthSmoother_.next();
    return sanitize(x * ((1.0f - depth) + depth * carrier));
}

bool RingModulator::processBlock(const float* input, float* output,
                                 std::uint32_t frames) noexcept {
    if (!prepared_ || !input || !output || frames > maxBlockFrames_) return false;
    for (std::uint32_t i = 0; i < frames; ++i) output[i] = processSample(input[i]);
    return true;
}

} // namespace webrc::dsp
