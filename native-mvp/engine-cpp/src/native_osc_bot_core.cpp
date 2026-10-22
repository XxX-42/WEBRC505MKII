#include "native_osc_bot_core.hpp"
#include "native_official_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::native {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kResonanceQ = 2.2;
constexpr double kMaxInputMagnitude = 8.0;
constexpr double kMaxOutputMagnitude = 4.0;
constexpr double kMaxOscillatorFrequencyRatio = 0.449;
constexpr double kTriangleLeak = 0.99999;
constexpr float kTriangleMin = -1.0f;
constexpr float kTriangleMax = 1.0f;

// Authored clean-room semitone patterns. No factory ROM or Roland code is used.
constexpr int kPatterns[kNativeOscBotPatternCount][kNativeOscBotStepsPerPattern] = {
    {0, 0, 7, 0, 12, 0, 7, 0},
    {0, 3, 7, 10, 12, 10, 7, 3},
    {0, 0, 0, 7, 0, 0, 12, 7},
    {0, 5, 7, 12, 7, 5, 3, 0},
    {0, 12, 7, 5, 0, 12, 10, 7},
    {0, 0, 5, 7, 10, 7, 5, 3},
    {0, 4, 7, 11, 12, 11, 7, 4},
    {0, -5, 0, 7, 0, -5, 12, 7},
};

[[nodiscard]] double flushDenormal(double value) noexcept {
    return std::fabs(value) < 1.0e-24 ? 0.0 : value;
}

} // namespace

bool NativeOscBotCore::ToneFilter::configure(std::uint32_t sampleRate,
                                              float cutoffHz) noexcept {
    if (sampleRate < 8000U || !std::isfinite(cutoffHz) || cutoffHz <= 0.0f ||
        static_cast<double>(cutoffHz) >= static_cast<double>(sampleRate) * 0.49) {
        return false;
    }
    const double g = std::tan(kPi * static_cast<double>(cutoffHz) /
                              static_cast<double>(sampleRate));
    const double nextK = 1.0 / kResonanceQ;
    const double denominator = 1.0 + g * (g + nextK);
    const double nextA1 = 1.0 / denominator;
    const double nextA2 = g * nextA1;
    const double nextA3 = g * nextA2;
    if (!std::isfinite(nextA1) || !std::isfinite(nextA2) || !std::isfinite(nextA3)) {
        return false;
    }
    a1 = nextA1;
    a2 = nextA2;
    a3 = nextA3;
    k = nextK;
    return true;
}

void NativeOscBotCore::ToneFilter::reset() noexcept {
    integrator1 = 0.0;
    integrator2 = 0.0;
}

float NativeOscBotCore::ToneFilter::process(float input) noexcept {
    const double x = static_cast<double>(input);
    const double v3 = x - integrator2;
    const double v1 = (a1 * integrator1) + (a2 * v3);
    const double v2 = integrator2 + (a2 * integrator1) + (a3 * v3);
    integrator1 = flushDenormal((2.0 * v1) - integrator1);
    integrator2 = flushDenormal((2.0 * v2) - integrator2);
    return std::isfinite(v2) ? static_cast<float>(v2) : 0.0f;
}

bool NativeOscBotCore::validWaveform(NativeOscBotWaveform waveform) noexcept {
    return waveform == NativeOscBotWaveform::Saw ||
        waveform == NativeOscBotWaveform::Square ||
        waveform == NativeOscBotWaveform::Triangle;
}

bool NativeOscBotCore::validTone(float value, std::uint32_t sampleRate) noexcept {
    if (!std::isfinite(value) || value < 100.0f || value > 16000.0f) {
        return false;
    }
    return sampleRate == 0U || static_cast<double>(value) <
        (static_cast<double>(sampleRate) * 0.49);
}

bool NativeOscBotCore::validTempo(float value) noexcept {
    return std::isfinite(value) && value >= 30.0f && value <= 300.0f;
}

bool NativeOscBotCore::integral(float value) noexcept {
    return std::isfinite(value) && std::floor(value) == value;
}

float NativeOscBotCore::boundedInput(float value) noexcept {
    if (!std::isfinite(value)) {
        return 0.0f;
    }
    return std::clamp(value, -static_cast<float>(kMaxInputMagnitude),
                      static_cast<float>(kMaxInputMagnitude));
}

float NativeOscBotCore::boundedOutput(double value) noexcept {
    if (!std::isfinite(value)) {
        return 0.0f;
    }
    return static_cast<float>(std::clamp(value, -kMaxOutputMagnitude, kMaxOutputMagnitude));
}

std::uint64_t NativeOscBotCore::computeStepFrames(std::uint32_t sampleRate,
                                                  float tempoBpm) noexcept {
    const double exactFrames = (static_cast<double>(sampleRate) * 60.0) /
        (static_cast<double>(tempoBpm) * 4.0);
    return std::max<std::uint64_t>(1U, static_cast<std::uint64_t>(std::floor(exactFrames + 0.5)));
}

bool NativeOscBotCore::prepare(std::uint32_t sampleRate,
                               std::uint64_t firstFrame) noexcept {
    if (sampleRate < 8000U || sampleRate > 384000U ||
        firstFrame == std::numeric_limits<std::uint64_t>::max() ||
        config_.bands < 8U || config_.bands > kNativeOscBotMaxBands ||
        !validTone(config_.toneCutoffHz, sampleRate)) {
        return false;
    }

    if (!filterBank_.prepare(sampleRate, config_.bands) ||
        !toneFilter_.configure(sampleRate, config_.toneCutoffHz)) {
        sampleRate_ = 0U;
        return false;
    }
    sampleRate_ = sampleRate;
    initialFrame_ = firstFrame;
    frameClock_ = firstFrame;
    activeStep_ = 0U;
    stepFrames_ = computeStepFrames(sampleRate_, config_.tempoBpm);
    framesUntilStep_ = stepFrames_;
    oscillatorPrepared_.fill(false);
    triangleIntegrators_.fill(0.0f);
    bandCarriers_.fill(0.0f);
    wetMixCurrent_ = config_.wetMix;
    wetMixTarget_ = config_.wetMix;
    wetMixStep_ = 0.0;
    wetMixRampRemaining_ = 0U;
    updateCarrierBank();
    official_.prepare(sampleRate_);
    if (official_.active()) {
        (void)filterBank_.setEnvelopeTimes(official_.attackSeconds(), 0.070f);
        (void)officialOscillator_.prepare(sampleRate_, 440.0f * std::exp2(
            (static_cast<float>(officialNote_) - 69.0f) / 12.0f), officialWaveform_);
    }
    return true;
}

bool NativeOscBotCore::setConfig(const NativeOscBotConfig& config) noexcept {
    if (config.bands < 8U || config.bands > kNativeOscBotMaxBands ||
        !validWaveform(config.waveform) || config.pattern < 0 ||
        config.pattern >= static_cast<int>(kNativeOscBotPatternCount) ||
        !validTone(config.toneCutoffHz, sampleRate_) || !validTempo(config.tempoBpm) ||
        !std::isfinite(config.wetMix) || config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    const NativeOscBotConfig previous = config_;
    const bool bandsChanged = config.bands != previous.bands;
    const bool tempoChanged = config.tempoBpm != previous.tempoBpm;
    const bool wetChanged = config.wetMix != previous.wetMix;
    const bool toneChanged = config.toneCutoffHz != previous.toneCutoffHz;
    const bool carriersChanged = bandsChanged || config.waveform != previous.waveform ||
        config.pattern != previous.pattern;

    // All inputs are validated first, so the following reconfiguration cannot
    // leave a partially accepted parameter set.
    if (sampleRate_ != 0U && bandsChanged && !filterBank_.prepare(sampleRate_, config.bands)) {
        return false;
    }
    if (sampleRate_ != 0U && toneChanged &&
        !toneFilter_.configure(sampleRate_, config.toneCutoffHz)) {
        return false;
    }

    config_ = config;
    if (sampleRate_ != 0U && official_.active())
        (void)filterBank_.setEnvelopeTimes(official_.attackSeconds(), 0.070f);
    if (tempoChanged && sampleRate_ != 0U) {
        const std::uint64_t oldStepFrames = stepFrames_;
        const std::uint64_t elapsed = oldStepFrames > framesUntilStep_
            ? oldStepFrames - framesUntilStep_ : 0U;
        const double phase = oldStepFrames == 0U ? 0.0 : std::clamp(
            static_cast<double>(elapsed) / static_cast<double>(oldStepFrames), 0.0, 1.0);
        stepFrames_ = computeStepFrames(sampleRate_, config_.tempoBpm);
        const double remaining = static_cast<double>(stepFrames_) * (1.0 - phase);
        framesUntilStep_ = static_cast<std::uint64_t>(std::floor(remaining + 0.5));
    }
    if (wetChanged) {
        wetMixTarget_ = config_.wetMix;
        wetMixCurrent_ = wetMixTarget_;
        wetMixStep_ = 0.0;
        wetMixRampRemaining_ = 0U;
    }
    if (carriersChanged && sampleRate_ != 0U) {
        updateCarrierBank();
    }
    return true;
}

bool NativeOscBotCore::setParameter(std::string_view parameterId, float value,
                                    std::uint64_t rampFrames) noexcept {
    if (parameterId.substr(0U, 9U) == "official_") {
        if (!official::validParameter("osc_bot", parameterId, value)) return false;
        if (!official_.active()) {
            official_.activate("osc_bot");
            if (sampleRate_ != 0U) (void)officialOscillator_.prepare(sampleRate_,
                440.0f * std::exp2((static_cast<float>(officialNote_) - 69.0f) / 12.0f), officialWaveform_);
            constexpr std::string_view keys[]{"official_osc", "official_tone", "official_attack",
                "official_note", "official_mod_sens", "official_balance"};
            for (const auto key : keys) {
                const auto* domain = official::parameterDomain("osc_bot", key);
                if (domain != nullptr && domain->hasDefault) (void)setParameter(key, domain->defaultValue, 0U);
            }
        }
        if (parameterId == "official_osc") {
            officialWaveform_ = static_cast<unsigned int>(value);
            (void)officialOscillator_.setWaveform(officialWaveform_);
        } else if (parameterId == "official_note") {
            officialNote_ = static_cast<unsigned int>(value);
            if (sampleRate_ != 0U) (void)officialOscillator_.setFrequency(
                440.0f * std::exp2((value - 69.0f) / 12.0f));
        } else if (parameterId == "official_balance") {
            return setParameter("mix", value, rampFrames);
        } else if (!official_.setParameter("osc_bot", parameterId, value)) return false;
        if (sampleRate_ != 0U) (void)filterBank_.setEnvelopeTimes(official_.attackSeconds(), 0.070f);
        return true;
    }
    NativeOscBotConfig candidate = config_;
    if (parameterId == "bands") {
        if (!integral(value) || value < 8.0f || value >
            static_cast<float>(kNativeOscBotMaxBands)) {
            return false;
        }
        candidate.bands = static_cast<std::size_t>(value);
        return setConfig(candidate);
    }
    if (parameterId == "waveform") {
        if (!integral(value) || value < 0.0f || value > 2.0f) {
            return false;
        }
        candidate.waveform = static_cast<NativeOscBotWaveform>(static_cast<std::uint8_t>(value));
        return setConfig(candidate);
    }
    if (parameterId == "pattern") {
        if (!integral(value) || value < 0.0f || value >=
            static_cast<float>(kNativeOscBotPatternCount)) {
            return false;
        }
        candidate.pattern = static_cast<int>(value);
        return setConfig(candidate);
    }
    if (parameterId == "tone" || parameterId == "toneCutoffHz") {
        candidate.toneCutoffHz = value;
        return setConfig(candidate);
    }
    if (parameterId == "tempo" || parameterId == "tempoBpm" || parameterId == "bpm") {
        candidate.tempoBpm = value;
        return setConfig(candidate);
    }
    if (parameterId == "mix") {
        if (!std::isfinite(value) || value < 0.0f || value > 100.0f) {
            return false;
        }
        const float start = wetMixCurrent_;
        candidate.wetMix = value * 0.01f;
        if (!setConfig(candidate)) {
            return false;
        }
        if (rampFrames != 0U && wetMixTarget_ != start) {
            wetMixCurrent_ = start;
            wetMixRampRemaining_ = rampFrames;
            wetMixStep_ = (static_cast<double>(wetMixTarget_) -
                           static_cast<double>(wetMixCurrent_)) /
                static_cast<double>(wetMixRampRemaining_);
        }
        return true;
    }
    return false;
}

void NativeOscBotCore::reset() noexcept {
    if (sampleRate_ == 0U) {
        return;
    }
    filterBank_.reset();
    toneFilter_.reset();
    official_.reset();
    officialOscillator_.reset();
    for (auto& oscillator : oscillators_) {
        oscillator.reset();
    }
    triangleIntegrators_.fill(0.0f);
    bandCarriers_.fill(0.0f);
    frameClock_ = initialFrame_;
    activeStep_ = 0U;
    framesUntilStep_ = stepFrames_;
    wetMixCurrent_ = config_.wetMix;
    wetMixTarget_ = config_.wetMix;
    wetMixStep_ = 0.0;
    wetMixRampRemaining_ = 0U;
    updateCarrierBank();
}

float NativeOscBotCore::nextWetMix() noexcept {
    if (wetMixRampRemaining_ == 0U) {
        return wetMixCurrent_;
    }
    wetMixCurrent_ = static_cast<float>(static_cast<double>(wetMixCurrent_) + wetMixStep_);
    --wetMixRampRemaining_;
    if (wetMixRampRemaining_ == 0U) {
        wetMixCurrent_ = wetMixTarget_;
        wetMixStep_ = 0.0;
    }
    return wetMixCurrent_;
}

void NativeOscBotCore::advanceStepIfDue() noexcept {
    if (framesUntilStep_ != 0U) {
        return;
    }
    activeStep_ = (activeStep_ + 1U) % kNativeOscBotStepsPerPattern;
    framesUntilStep_ = stepFrames_;
    updateCarrierBank();
}

void NativeOscBotCore::updateCarrierBank() noexcept {
    if (sampleRate_ == 0U || filterBank_.bandCount() == 0U) {
        return;
    }
    const int semitones = kPatterns[static_cast<std::size_t>(config_.pattern)][activeStep_];
    const double transposition = std::pow(2.0, static_cast<double>(semitones) / 12.0);
    const NativeVocoderWaveform primitiveWaveform = config_.waveform == NativeOscBotWaveform::Saw
        ? NativeVocoderWaveform::Saw : NativeVocoderWaveform::Square;
    const double frequencyCeiling = static_cast<double>(sampleRate_) * kMaxOscillatorFrequencyRatio;
    for (std::size_t band = 0U; band < filterBank_.bandCount(); ++band) {
        const double base = static_cast<double>(filterBank_.centerFrequencyHz(band)) * transposition;
        const float frequency = static_cast<float>(std::clamp(base, 1.0, frequencyCeiling));
        if (!oscillatorPrepared_[band]) {
            oscillatorPrepared_[band] = oscillators_[band].prepare(
                sampleRate_, frequency, primitiveWaveform);
        } else {
            (void)oscillators_[band].setFrequency(frequency);
            (void)oscillators_[band].setWaveform(primitiveWaveform);
        }
    }
}

float NativeOscBotCore::processWet(float modulator) noexcept {
    if (official_.active()) {
        filterBank_.analyzeModulatorSample(official_.modulator(modulator));
        const float carrier = officialOscillator_.processSample();
        for (std::size_t band = 0U; band < filterBank_.bandCount(); ++band)
            bandCarriers_[band] = filterBank_.filterCarrierSample(band, carrier);
        return boundedOutput(official_.tone(filterBank_.synthesizeSample(
            bandCarriers_.data(), filterBank_.bandCount())));
    }
    advanceStepIfDue();
    filterBank_.analyzeModulatorSample(modulator);
    for (std::size_t band = 0U; band < filterBank_.bandCount(); ++band) {
        const float raw = oscillators_[band].processSample();
        float carrier = raw;
        if (config_.waveform == NativeOscBotWaveform::Triangle) {
            const double increment = static_cast<double>(oscillators_[band].frequencyHz()) /
                static_cast<double>(sampleRate_);
            const double integrated = (static_cast<double>(triangleIntegrators_[band]) *
                                       kTriangleLeak) + (4.0 * increment *
                                                         static_cast<double>(raw));
            triangleIntegrators_[band] = static_cast<float>(std::clamp(
                integrated, static_cast<double>(kTriangleMin),
                static_cast<double>(kTriangleMax)));
            carrier = triangleIntegrators_[band];
        }
        bandCarriers_[band] = filterBank_.filterCarrierSample(band, carrier);
    }
    const float vocoded = filterBank_.synthesizeSample(bandCarriers_.data(),
                                                       filterBank_.bandCount());
    const float filtered = toneFilter_.process(vocoded);
    --framesUntilStep_;
    return boundedOutput(filtered);
}

bool NativeOscBotCore::processFrame(float modulator, float dryLeft, float dryRight,
                                    float* outputLeft, float* outputRight) noexcept {
    const float wet = processWet(modulator);
    const float mix = config_.enabled ? nextWetMix() : 0.0f;
    const double inverseMix = 1.0 - static_cast<double>(mix);
    *outputLeft = boundedOutput((static_cast<double>(dryLeft) * inverseMix) +
                                (static_cast<double>(wet) * static_cast<double>(mix)));
    if (outputRight != nullptr) {
        *outputRight = boundedOutput((static_cast<double>(dryRight) * inverseMix) +
                                     (static_cast<double>(wet) * static_cast<double>(mix)));
    }
    ++frameClock_;
    return true;
}

float NativeOscBotCore::processSample(float input) noexcept {
    if (sampleRate_ == 0U || frameClock_ == std::numeric_limits<std::uint64_t>::max()) {
        return 0.0f;
    }
    const float bounded = boundedInput(input);
    float output = 0.0f;
    (void)processFrame(bounded, bounded, bounded, &output, nullptr);
    return output;
}

bool NativeOscBotCore::processMono(const float* input, float* output,
                                   std::size_t frames) noexcept {
    if (sampleRate_ == 0U) {
        return false;
    }
    if (frames == 0U) {
        return true;
    }
    if (input == nullptr || output == nullptr ||
        frames > (std::numeric_limits<std::uint64_t>::max() - frameClock_)) {
        return false;
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float dry = boundedInput(input[frame]);
        float wetOutput = 0.0f;
        (void)processFrame(dry, dry, dry, &wetOutput, nullptr);
        output[frame] = wetOutput;
    }
    return true;
}

bool NativeOscBotCore::processStereo(const float* interleavedInput,
                                     float* interleavedOutput,
                                     std::size_t frames) noexcept {
    if (sampleRate_ == 0U) {
        return false;
    }
    if (frames == 0U) {
        return true;
    }
    if (interleavedInput == nullptr || interleavedOutput == nullptr ||
        frames > (std::numeric_limits<std::uint64_t>::max() - frameClock_) ||
        frames > (std::numeric_limits<std::size_t>::max() / 2U)) {
        return false;
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const std::size_t index = frame * 2U;
        const float dryLeft = boundedInput(interleavedInput[index]);
        const float dryRight = boundedInput(interleavedInput[index + 1U]);
        const float modulator = boundedInput((dryLeft + dryRight) * 0.5f);
        float outputLeft = 0.0f;
        float outputRight = 0.0f;
        (void)processFrame(modulator, dryLeft, dryRight, &outputLeft, &outputRight);
        interleavedOutput[index] = outputLeft;
        interleavedOutput[index + 1U] = outputRight;
    }
    return true;
}

bool NativeOscBotCore::processInPlace(float* interleaved, std::size_t frames,
                                      std::size_t channels) noexcept {
    if (channels == 1U) {
        return processMono(interleaved, interleaved, frames);
    }
    if (channels != 2U) {
        return false;
    }
    return processStereo(interleaved, interleaved, frames);
}

} // namespace webrc::native
