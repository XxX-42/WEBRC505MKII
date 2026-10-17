#include "native_vocoder_core.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kErbRateScale = 21.4;
constexpr double kErbRateHzScale = 0.00437;
constexpr double kMinCenterHz = 80.0;
constexpr double kMaxInputMagnitude = 8.0;
constexpr double kMaxEnvelope = 8.0;
constexpr double kMaxOutputMagnitude = 8.0;
constexpr double kAttackSeconds = 0.005;
constexpr double kReleaseSeconds = 0.070;

[[nodiscard]] bool validWaveform(NativeVocoderWaveform waveform) noexcept {
    return waveform == NativeVocoderWaveform::Saw || waveform == NativeVocoderWaveform::Square;
}

[[nodiscard]] bool validCarrier(NativeVocoderCarrier carrier) noexcept {
    return carrier == NativeVocoderCarrier::VoiceInput || carrier == NativeVocoderCarrier::Saw ||
        carrier == NativeVocoderCarrier::Square;
}

[[nodiscard]] float boundedSample(float sample) noexcept {
    if (!std::isfinite(sample)) {
        return 0.0f;
    }
    return std::clamp(sample, -static_cast<float>(kMaxInputMagnitude),
                      static_cast<float>(kMaxInputMagnitude));
}

[[nodiscard]] float boundedOutput(double sample) noexcept {
    if (!std::isfinite(sample)) {
        return 0.0f;
    }
    return static_cast<float>(std::clamp(sample, -kMaxOutputMagnitude, kMaxOutputMagnitude));
}

[[nodiscard]] double erbRate(double frequencyHz) noexcept {
    return kErbRateScale * std::log10(1.0 + kErbRateHzScale * frequencyHz);
}

[[nodiscard]] double inverseErbRate(double rate) noexcept {
    return (std::pow(10.0, rate / kErbRateScale) - 1.0) / kErbRateHzScale;
}

} // namespace

bool NativeVocoderOscillator::prepare(std::uint32_t sampleRate, float frequencyHz,
                                      NativeVocoderWaveform waveform) noexcept {
    if (sampleRate < 8000U || sampleRate > 384000U || !validWaveform(waveform) ||
        !std::isfinite(frequencyHz) || frequencyHz <= 0.0f ||
        static_cast<double>(frequencyHz) >= static_cast<double>(sampleRate) * 0.45) {
        return false;
    }
    sampleRate_ = sampleRate;
    waveform_ = waveform;
    phase_ = 0.0;
    frequencyHz_ = frequencyHz;
    return true;
}

bool NativeVocoderOscillator::setFrequency(float frequencyHz) noexcept {
    if (sampleRate_ == 0U || !std::isfinite(frequencyHz) || frequencyHz <= 0.0f ||
        static_cast<double>(frequencyHz) >= static_cast<double>(sampleRate_) * 0.45) {
        return false;
    }
    frequencyHz_ = frequencyHz;
    return true;
}

bool NativeVocoderOscillator::setWaveform(NativeVocoderWaveform waveform) noexcept {
    if (!validWaveform(waveform)) {
        return false;
    }
    waveform_ = waveform;
    return true;
}

void NativeVocoderOscillator::reset(double phase) noexcept {
    if (!std::isfinite(phase)) {
        phase_ = 0.0;
        return;
    }
    phase_ = std::fmod(phase, 1.0);
    if (phase_ < 0.0) {
        phase_ += 1.0;
    }
}

float NativeVocoderOscillator::polyBlep(double phase, double phaseIncrement) noexcept {
    if (!(phaseIncrement > 0.0) || phaseIncrement >= 0.5) {
        return 0.0f;
    }
    if (phase < phaseIncrement) {
        const double normalized = phase / phaseIncrement;
        return static_cast<float>((normalized + normalized) - (normalized * normalized) - 1.0);
    }
    if (phase > 1.0 - phaseIncrement) {
        const double normalized = (phase - 1.0) / phaseIncrement;
        return static_cast<float>((normalized * normalized) + (normalized + normalized) + 1.0);
    }
    return 0.0f;
}

float NativeVocoderOscillator::processSample() noexcept {
    if (sampleRate_ == 0U || !(frequencyHz_ > 0.0f)) {
        return 0.0f;
    }

    const double increment = static_cast<double>(frequencyHz_) / static_cast<double>(sampleRate_);
    double sample = 0.0;
    if (waveform_ == NativeVocoderWaveform::Saw) {
        sample = (2.0 * phase_) - 1.0 - static_cast<double>(polyBlep(phase_, increment));
    } else {
        sample = phase_ < 0.5 ? 1.0 : -1.0;
        sample += static_cast<double>(polyBlep(phase_, increment));
        double shiftedPhase = phase_ + 0.5;
        if (shiftedPhase >= 1.0) {
            shiftedPhase -= 1.0;
        }
        sample -= static_cast<double>(polyBlep(shiftedPhase, increment));
    }

    phase_ += increment;
    if (phase_ >= 1.0) {
        phase_ -= 1.0;
    }
    return static_cast<float>(sample);
}

void NativeVocoderFilterBank::BandPass::configure(double sampleRate, double centerHz, double q) noexcept {
    const double omega = kTwoPi * centerHz / sampleRate;
    const double cosine = std::cos(omega);
    const double alpha = std::sin(omega) / (2.0 * q);
    const double inverseA0 = 1.0 / (1.0 + alpha);

    // RBJ constant-skirt bandpass, whose magnitude is unity at its center.
    b0 = alpha * inverseA0;
    b1 = 0.0;
    b2 = -alpha * inverseA0;
    a1 = -2.0 * cosine * inverseA0;
    a2 = (1.0 - alpha) * inverseA0;
    reset();
}

void NativeVocoderFilterBank::BandPass::reset() noexcept {
    z1 = 0.0;
    z2 = 0.0;
}

float NativeVocoderFilterBank::BandPass::process(float sample) noexcept {
    const double input = static_cast<double>(sample);
    const double output = (b0 * input) + z1;
    z1 = (b1 * input) - (a1 * output) + z2;
    z2 = (b2 * input) - (a2 * output);
    if (std::fabs(z1) < 1.0e-24) {
        z1 = 0.0;
    }
    if (std::fabs(z2) < 1.0e-24) {
        z2 = 0.0;
    }
    return boundedSample(static_cast<float>(output));
}

bool NativeVocoderFilterBank::prepare(std::uint32_t sampleRate, std::size_t bandCount) noexcept {
    if (sampleRate < 8000U || sampleRate > 384000U || bandCount < 8U ||
        bandCount > kNativeVocoderMaxBands) {
        return false;
    }

    sampleRate_ = sampleRate;
    bandCount_ = bandCount;
    envelopes_.fill(0.0f);
    centers_.fill(0.0f);

    const double lowest = kMinCenterHz;
    // Stay below the oscillator bank's 0.45 * sample-rate tuning ceiling.
    const double highest = std::min(10000.0, static_cast<double>(sampleRate) * 0.44);
    const double lowestRate = erbRate(lowest);
    const double highestRate = erbRate(highest);
    const double denominator = static_cast<double>(bandCount - 1U);
    for (std::size_t band = 0U; band < bandCount; ++band) {
        const double fraction = static_cast<double>(band) / denominator;
        centers_[band] = static_cast<float>(inverseErbRate(lowestRate + (fraction * (highestRate - lowestRate))));
    }

    attackCoefficient_ = std::exp(-1.0 / (kAttackSeconds * static_cast<double>(sampleRate)));
    releaseCoefficient_ = std::exp(-1.0 / (kReleaseSeconds * static_cast<double>(sampleRate)));
    for (std::size_t band = 0U; band < bandCount_; ++band) {
        const double center = static_cast<double>(centers_[band]);
        const double neighborSpacing = band == 0U
            ? static_cast<double>(centers_[1U]) - center
            : (band + 1U == bandCount_
                ? center - static_cast<double>(centers_[band - 1U])
                : 0.5 * (static_cast<double>(centers_[band + 1U]) -
                         static_cast<double>(centers_[band - 1U])));
        const double q = std::clamp(center / std::max(neighborSpacing, 1.0), 0.5, 24.0);
        modulatorFilters_[band].configure(static_cast<double>(sampleRate), center, q);
        carrierFilters_[band].configure(static_cast<double>(sampleRate), center, q);
    }
    return true;
}

void NativeVocoderFilterBank::reset() noexcept {
    envelopes_.fill(0.0f);
    for (std::size_t band = 0U; band < bandCount_; ++band) {
        modulatorFilters_[band].reset();
        carrierFilters_[band].reset();
    }
}

void NativeVocoderFilterBank::analyzeModulatorSample(float sample) noexcept {
    if (bandCount_ == 0U) {
        return;
    }
    const float safeSample = boundedSample(sample);
    for (std::size_t band = 0U; band < bandCount_; ++band) {
        const float magnitude = std::fabs(modulatorFilters_[band].process(safeSample));
        const double coefficient = magnitude > envelopes_[band] ? attackCoefficient_ : releaseCoefficient_;
        const double updated = (coefficient * static_cast<double>(envelopes_[band])) +
            ((1.0 - coefficient) * static_cast<double>(magnitude));
        envelopes_[band] = static_cast<float>(std::clamp(updated, 0.0, kMaxEnvelope));
    }
}

float NativeVocoderFilterBank::filterCarrierSample(std::size_t band, float sample) noexcept {
    if (band >= bandCount_) {
        return 0.0f;
    }
    return carrierFilters_[band].process(boundedSample(sample));
}

float NativeVocoderFilterBank::synthesizeSample(const float* bandCarriers,
                                                 std::size_t carrierCount) const noexcept {
    if (bandCount_ == 0U || bandCarriers == nullptr || carrierCount < bandCount_) {
        return 0.0f;
    }
    double sum = 0.0;
    for (std::size_t band = 0U; band < bandCount_; ++band) {
        sum += static_cast<double>(envelopes_[band]) *
            static_cast<double>(boundedSample(bandCarriers[band]));
    }
    return boundedOutput(sum / std::sqrt(static_cast<double>(bandCount_)));
}

float NativeVocoderFilterBank::centerFrequencyHz(std::size_t band) const noexcept {
    return band < bandCount_ ? centers_[band] : 0.0f;
}

float NativeVocoderFilterBank::envelope(std::size_t band) const noexcept {
    return band < bandCount_ ? envelopes_[band] : 0.0f;
}

bool NativeVocoderCore::prepare(std::uint32_t sampleRate) noexcept {
    if (sampleRate < 8000U || sampleRate > 384000U || config_.bands < 8U ||
        config_.bands > kNativeVocoderMaxBands) {
        return false;
    }
    sampleRate_ = sampleRate;
    if (!filterBank_.prepare(sampleRate_, config_.bands) || !configureOscillators()) {
        sampleRate_ = 0U;
        return false;
    }
    return true;
}

bool NativeVocoderCore::setConfig(const NativeVocoderConfig& config) noexcept {
    if (config.bands < 8U || config.bands > kNativeVocoderMaxBands || !validCarrier(config.carrier) ||
        !std::isfinite(config.wetMix) || config.wetMix < 0.0f || config.wetMix > 1.0f ||
        !std::isfinite(config.formantShiftSemitones) || config.formantShiftSemitones != 0.0f) {
        return false;
    }

    const bool bandsChanged = config.bands != config_.bands;
    const bool carrierChanged = config.carrier != config_.carrier;
    config_ = config;
    if (sampleRate_ != 0U && bandsChanged) {
        if (!filterBank_.prepare(sampleRate_, config_.bands)) {
            return false;
        }
    }
    if (sampleRate_ != 0U && (bandsChanged || carrierChanged)) {
        if (!configureOscillators()) {
            return false;
        }
    }
    return true;
}

void NativeVocoderCore::reset() noexcept {
    filterBank_.reset();
    for (std::size_t band = 0U; band < filterBank_.bandCount(); ++band) {
        oscillators_[band].reset();
    }
    bandCarriers_.fill(0.0f);
}

bool NativeVocoderCore::configureOscillators() noexcept {
    if (sampleRate_ == 0U) {
        return true;
    }
    const NativeVocoderWaveform waveform = config_.carrier == NativeVocoderCarrier::Square
        ? NativeVocoderWaveform::Square : NativeVocoderWaveform::Saw;
    for (std::size_t band = 0U; band < filterBank_.bandCount(); ++band) {
        if (!oscillators_[band].prepare(sampleRate_, filterBank_.centerFrequencyHz(band), waveform)) {
            return false;
        }
    }
    return true;
}

bool NativeVocoderCore::process(const float* modulator,
                                const float* voiceCarrier,
                                float* output,
                                std::size_t frames) noexcept {
    if (sampleRate_ == 0U) {
        return false;
    }
    if (frames == 0U) {
        return true;
    }
    if (modulator == nullptr || output == nullptr) {
        return false;
    }

    const double dryGain = config_.enabled ? 1.0 - static_cast<double>(config_.wetMix) : 1.0;
    const double wetGain = config_.enabled ? static_cast<double>(config_.wetMix) : 0.0;
    const bool voiceMode = config_.carrier == NativeVocoderCarrier::VoiceInput;
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        // Read both sources before writing output so in-place processing is safe.
        const float modSample = boundedSample(modulator[frame]);
        const float carrierSample = voiceMode
            ? boundedSample(voiceCarrier == nullptr ? modulator[frame] : voiceCarrier[frame])
            : 0.0f;
        filterBank_.analyzeModulatorSample(modSample);
        for (std::size_t band = 0U; band < filterBank_.bandCount(); ++band) {
            const float bandCarrier = voiceMode
                ? filterBank_.filterCarrierSample(band, carrierSample)
                : filterBank_.filterCarrierSample(band, oscillators_[band].processSample());
            bandCarriers_[band] = bandCarrier;
        }
        const float wet = filterBank_.synthesizeSample(bandCarriers_.data(), filterBank_.bandCount());
        output[frame] = boundedOutput((static_cast<double>(modSample) * dryGain) +
                                      (static_cast<double>(wet) * wetGain));
    }
    return true;
}

} // namespace webrc::native
