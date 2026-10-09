#include "webrc/dsp/modulation_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kMaxExactFrame = 9007199254740992.0;
constexpr double kSmoothingSeconds = 0.005;

[[nodiscard]] bool finiteInRange(float value, float low, float high) noexcept {
    return std::isfinite(value) && value >= low && value <= high;
}

[[nodiscard]] bool isInteger(float value) noexcept {
    return std::isfinite(value) && std::floor(value) == value;
}

[[nodiscard]] float boundedAudio(float value) noexcept {
    return std::clamp(sanitize(value), -8.0f, 8.0f);
}

[[nodiscard]] bool validKind(ModulationFxKind kind) noexcept {
    return static_cast<std::uint8_t>(kind) <=
           static_cast<std::uint8_t>(ModulationFxKind::Tremolo);
}

} // namespace

std::size_t ModulationFxProcessor::requiredPrepareBytes(const ProcessSpec& spec,
                                                        ModulationFxKind kind) noexcept {
    if (!validProcessSpec(spec) || spec.channels != 2 || spec.sampleRate > 192000.0f ||
        !validKind(kind)) return 0;
    // These processors use fixed-size state and allocate nothing in prepare or
    // processBlock. Return the in-object budget so graph admission can ledger it.
    return sizeof(ModulationFxProcessor);
}

bool ModulationFxProcessor::prepare(const ProcessSpec& spec) {
    if (requiredPrepareBytes(spec, kind_) == 0 || !lfo_.prepare(spec) ||
        !carrier_.prepare(spec)) {
        prepared_ = false;
        return false;
    }
    spec_ = spec;
    wet_ = 1.0f;
    wetCurrent_ = 1.0f;
    depth_ = 0.5f;
    depthCurrent_ = depth_;
    pan_ = 0.0f;
    panCurrent_ = pan_;
    activeGain_ = 0.0f;
    targetActiveGain_ = 0.0f;
    active_ = false;
    rateHz_ = 1.0f;
    if (kind_ == ModulationFxKind::AutoPan) rateHz_ = 0.5f;
    if (kind_ == ModulationFxKind::RingModulator) rateHz_ = 110.0f;
    bitDepth_ = 8;
    holdFrames_ = 4;
    holdCountdown_ = 0;
    dither_ = 0.5f;
    waveform_ = OscillatorWaveform::Sine;
    heldSample_ = {};
    smoothingCoefficient_ = 1.0 - std::exp(-1.0 /
        (static_cast<double>(spec.sampleRate) * kSmoothingSeconds));
    lfo_.reset(0.0f);
    carrier_.reset(0.0f);
    if (kind_ == ModulationFxKind::RingModulator) {
        if (!carrier_.setFrequency(rateHz_)) return false;
    } else {
        if (!lfo_.setFrequency(rateHz_)) return false;
    }
    carrier_.setWaveform(waveform_);
    ditherRandom_.seed(randomSeed_);
    expectedFrame_ = 0;
    hasExpectedFrame_ = false;
    prepared_ = true;
    return true;
}

void ModulationFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    lfo_.reset(0.0f);
    carrier_.reset(0.0f);
    if (kind_ == ModulationFxKind::RingModulator) (void)carrier_.setFrequency(rateHz_);
    else (void)lfo_.setFrequency(rateHz_);
    carrier_.setWaveform(waveform_);
    ditherRandom_.seed(randomSeed_);
    wetCurrent_ = wet_;
    depthCurrent_ = depth_;
    panCurrent_ = pan_;
    activeGain_ = 0.0f;
    targetActiveGain_ = 0.0f;
    active_ = false;
    holdCountdown_ = 0;
    heldSample_ = {};
    expectedFrame_ = absoluteFrame;
    hasExpectedFrame_ = true;
}

bool ModulationFxProcessor::setSeed(std::uint64_t seed) noexcept {
    if (!prepared_ || active_ || activeGain_ != 0.0f || targetActiveGain_ != 0.0f) return false;
    randomSeed_ = seed == 0 ? 0x4d595df4d0f33173ULL : seed;
    ditherRandom_.seed(randomSeed_);
    return true;
}

bool ModulationFxProcessor::validateEvent(const ModulationFxEvent& event) const noexcept {
    switch (event.control) {
    case ModulationFxControl::Active:
        return event.value == 0.0f || event.value == 1.0f;
    case ModulationFxControl::Wet:
        return finiteInRange(event.value, 0.0f, 1.0f);
    case ModulationFxControl::RateHz:
        if (kind_ == ModulationFxKind::RingModulator) {
            return finiteInRange(event.value, 1.0f,
                std::min(8000.0f, spec_.sampleRate * 0.45f));
        }
        return (kind_ == ModulationFxKind::AutoPan || kind_ == ModulationFxKind::Tremolo) &&
               finiteInRange(event.value, 0.01f, std::min(20.0f, spec_.sampleRate * 0.25f));
    case ModulationFxControl::Depth:
        return (kind_ == ModulationFxKind::AutoPan || kind_ == ModulationFxKind::Tremolo) &&
               finiteInRange(event.value, 0.0f, 1.0f);
    case ModulationFxControl::Pan:
        return (kind_ == ModulationFxKind::AutoPan || kind_ == ModulationFxKind::ManualPan) &&
               finiteInRange(event.value, -1.0f, 1.0f);
    case ModulationFxControl::BitDepth:
        return kind_ == ModulationFxKind::LoFi && isInteger(event.value) &&
               finiteInRange(event.value, 4.0f, 16.0f);
    case ModulationFxControl::HoldFrames:
        return kind_ == ModulationFxKind::LoFi && isInteger(event.value) &&
               finiteInRange(event.value, 1.0f, 64.0f);
    case ModulationFxControl::Dither:
        return kind_ == ModulationFxKind::LoFi && finiteInRange(event.value, 0.0f, 1.0f);
    case ModulationFxControl::Waveform:
        return kind_ == ModulationFxKind::RingModulator && isInteger(event.value) &&
               finiteInRange(event.value, 0.0f, 3.0f);
    }
    return false;
}

bool ModulationFxProcessor::validateEvents(std::uint32_t frames,
                                           const ModulationFxEvent* events,
                                           std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock || (eventCount != 0U && !events)) return false;
    std::uint32_t previousOffset = 0;
    for (std::uint32_t i = 0; i < eventCount; ++i) {
        if (events[i].frameOffset >= frames ||
            (i != 0U && events[i].frameOffset < previousOffset) ||
            !validateEvent(events[i])) return false;
        previousOffset = events[i].frameOffset;
    }
    return true;
}

bool ModulationFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                         StereoFrame* interleaved,
                                         std::uint32_t frames,
                                         const ModulationFxEvent* events,
                                         std::uint32_t eventCount) noexcept {
    if (!prepared_ || !interleaved || frames == 0U || frames > spec_.maxBlockFrames ||
        blockStartFrame >= static_cast<std::uint64_t>(kMaxExactFrame) ||
        static_cast<std::uint64_t>(frames) >
            static_cast<std::uint64_t>(kMaxExactFrame) - blockStartFrame ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_) ||
        !validateEvents(frames, events, eventCount)) return false;
    if (!hasExpectedFrame_) {
        expectedFrame_ = blockStartFrame;
        hasExpectedFrame_ = true;
    }
    std::uint32_t eventIndex = 0;
    for (std::uint32_t offset = 0; offset < frames; ++offset) {
        while (eventIndex < eventCount && events[eventIndex].frameOffset == offset) {
            applyEvent(events[eventIndex]);
            ++eventIndex;
        }
        interleaved[offset] = processSample(interleaved[offset]);
    }
    expectedFrame_ = blockStartFrame + frames;
    return true;
}

void ModulationFxProcessor::applyEvent(const ModulationFxEvent& event) noexcept {
    switch (event.control) {
    case ModulationFxControl::Active:
        active_ = event.value > 0.5f;
        targetActiveGain_ = active_ ? 1.0f : 0.0f;
        if (active_ && kind_ == ModulationFxKind::LoFi) holdCountdown_ = 0;
        break;
    case ModulationFxControl::Wet:
        wet_ = event.value;
        break;
    case ModulationFxControl::RateHz:
        rateHz_ = event.value;
        if (kind_ == ModulationFxKind::RingModulator) (void)carrier_.setFrequency(rateHz_);
        else (void)lfo_.setFrequency(rateHz_);
        break;
    case ModulationFxControl::Depth:
        depth_ = event.value;
        break;
    case ModulationFxControl::Pan:
        pan_ = event.value;
        break;
    case ModulationFxControl::BitDepth:
        bitDepth_ = static_cast<std::uint32_t>(event.value);
        break;
    case ModulationFxControl::HoldFrames:
        holdFrames_ = static_cast<std::uint32_t>(event.value);
        holdCountdown_ = 0;
        break;
    case ModulationFxControl::Dither:
        dither_ = event.value;
        break;
    case ModulationFxControl::Waveform:
        waveform_ = static_cast<OscillatorWaveform>(static_cast<std::uint8_t>(event.value));
        carrier_.setWaveform(waveform_);
        break;
    }
}

StereoFrame ModulationFxProcessor::processSample(StereoFrame input) noexcept {
    input.left = boundedAudio(input.left);
    input.right = boundedAudio(input.right);
    wetCurrent_ += (wet_ - wetCurrent_) * static_cast<float>(smoothingCoefficient_);
    depthCurrent_ += (depth_ - depthCurrent_) * static_cast<float>(smoothingCoefficient_);
    panCurrent_ += (pan_ - panCurrent_) * static_cast<float>(smoothingCoefficient_);
    activeGain_ += (targetActiveGain_ - activeGain_) * static_cast<float>(smoothingCoefficient_);
    if (std::fabs(targetActiveGain_ - activeGain_) < 1.0e-6f) activeGain_ = targetActiveGain_;

    StereoFrame wet = input;
    switch (kind_) {
    case ModulationFxKind::LoFi:
        wet = processLoFi(input);
        break;
    case ModulationFxKind::RingModulator: {
        const auto carrier = carrier_.next();
        wet = {input.left * carrier, input.right * carrier};
        break;
    }
    case ModulationFxKind::AutoPan: {
        const auto position = std::clamp(panCurrent_ + depthCurrent_ * lfo_.next(), -1.0f, 1.0f);
        wet = applyBalance(input, position);
        break;
    }
    case ModulationFxKind::ManualPan:
        wet = applyBalance(input, panCurrent_);
        break;
    case ModulationFxKind::Tremolo: {
        const auto lfo = 0.5f + 0.5f * lfo_.next();
        const auto gain = 1.0f - depthCurrent_ * (1.0f - lfo);
        wet = {input.left * gain, input.right * gain};
        break;
    }
    }
    const auto mix = activeGain_ * wetCurrent_;
    return {boundedAudio(input.left + (wet.left - input.left) * mix),
            boundedAudio(input.right + (wet.right - input.right) * mix)};
}

StereoFrame ModulationFxProcessor::processLoFi(StereoFrame input) noexcept {
    if (holdCountdown_ == 0U) {
        heldSample_ = {quantize(input.left), quantize(input.right)};
        holdCountdown_ = holdFrames_ - 1U;
    } else {
        --holdCountdown_;
    }
    return heldSample_;
}

StereoFrame ModulationFxProcessor::applyBalance(StereoFrame input, float pan) noexcept {
    // Match StereoPannerNode's stereo-input law: the pan parameter moves the
    // existing stereo image, preserving center unchanged and crossfeeding the
    // opposite side as the image reaches either hard edge.
    const auto boundedPan = static_cast<double>(std::clamp(pan, -1.0f, 1.0f));
    const auto x = boundedPan <= 0.0 ? boundedPan + 1.0 : boundedPan;
    const auto angle = x * kPi * 0.5;
    const auto leftGain = static_cast<float>(std::cos(angle));
    const auto rightGain = static_cast<float>(std::sin(angle));
    if (boundedPan <= 0.0) {
        return {input.left + input.right * leftGain, input.right * rightGain};
    }
    return {input.left * leftGain, input.right + input.left * rightGain};
}

float ModulationFxProcessor::quantize(float input) noexcept {
    const auto levels = static_cast<float>((1U << (bitDepth_ - 1U)) - 1U);
    const auto step = 1.0f / levels;
    auto scaled = std::clamp(input, -1.0f, 1.0f) / step;
    if (dither_ > 0.0f) {
        const auto triangular = 0.5f * (ditherRandom_.nextBipolar() + ditherRandom_.nextBipolar());
        scaled += triangular * dither_;
    }
    return std::round(scaled) * step;
}

} // namespace webrc::dsp
