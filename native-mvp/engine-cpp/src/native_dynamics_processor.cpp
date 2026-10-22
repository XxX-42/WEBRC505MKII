#include "native_dynamics_processor.hpp"
#include "native_official_domains.hpp"

#include <algorithm>
#include <cstddef>
#include <cmath>

namespace webrc::native {
namespace {

constexpr double kDbPerOctaveScale = 20.0;
constexpr double kMillisecondsToSeconds = 0.001;

// Same independently authored profiles as OfficialDynamicsProfiles.ts.
// The hardware's preset internals are unpublished; these are functional
// interpretations of its names, not measurements or recovered factory data.
struct OfficialDynamicsProfile {
    float threshold, ratio, knee, attack, release, makeup;
    float low, high, lowCut, highCut;
    NativeDynamicsDetector detector;
};
constexpr auto kPeak = NativeDynamicsDetector::Peak;
constexpr auto kRms = NativeDynamicsDetector::Rms;
constexpr std::array<OfficialDynamicsProfile, 19U> kOfficialProfiles{{
    {-18, 2.5f, 12, 20, 180, 2, 0, 0, 0, 0, kRms}, // NATURALCOMP
    {-20, 3, 6, 10, 100, 3, 0, 0, 0, 0, kRms}, // MIXER COMP
    {-16, 4, 4, 5, 80, 3, -1, 1, 0, 0, kPeak}, // LIVE COMP
    {-6, 10, 6, 2, 120, 0, 0, 0, 0, 0, kPeak}, // NATURAL LIM
    {-3, 20, 0, 0.1f, 60, 0, 0, 0, 0, 0, kPeak}, // HARD LIM
    {-26, 8, 3, 1, 50, 6, 2, 3, 0, 0, kRms}, // JINGL COMP
    {-22, 10, 0, 2, 100, 5, 0, 0, 0, 0, kPeak}, // HARD COMP
    {-24, 2, 18, 30, 240, 3, 0, 0, 0, 0, kRms}, // SOFT COMP
    {-15, 1.8f, 12, 15, 150, 1, 0, 1, 0, 0, kRms}, // CLEAN COMP
    {-20, 5, 6, 20, 75, 4, 4, 2, 0, 0, kPeak}, // DANCE COMP
    {-18, 2, 14, 50, 400, 1, 0, 0, 0, 0, kRms}, // ORCH COMP
    {-24, 4, 8, 6, 160, 4, -2, 2, 80, 0, kRms}, // VOCAL COMP
    {-18, 2.5f, 10, 35, 200, 2, -1, 3, 0, 0, kRms}, // ACOUSTIC
    {-20, 6, 4, 10, 120, 4, 2, 1, 0, 0, kPeak}, // ROCK BAND
    {-12, 1.5f, 16, 80, 600, 1, 1, -1, 0, 0, kRms}, // ORCHESTRA
    {-18, 2.5f, 10, 20, 200, 2, 6, 0, 0, 0, kRms}, // LOW BOOST
    {-18, 2, 8, 10, 180, 2, 0, 6, 0, 0, kRms}, // BRIGHTEN
    {-28, 6, 4, 2, 100, 5, 4, 2, 80, 8500, kPeak}, // DJs VOICE
    {-24, 5, 2, 2, 100, 3, -6, -3, 300, 3400, kPeak}, // PHONE VOX
}};

[[nodiscard]] double dbToLinear(double db) noexcept {
    return std::pow(10.0, db / kDbPerOctaveScale);
}

} // namespace

bool NativeDynamicsProcessor::isValidDetector(NativeDynamicsDetector detector) noexcept {
    return detector == NativeDynamicsDetector::Peak || detector == NativeDynamicsDetector::Rms;
}

double NativeDynamicsProcessor::finiteInput(float sample) noexcept {
    return std::isfinite(sample) ? static_cast<double>(sample) : 0.0;
}

float NativeDynamicsProcessor::boundedOutput(double sample) noexcept {
    if (!std::isfinite(sample)) return 0.0f;
    return static_cast<float>(std::clamp(sample, -kMaxOutputMagnitude, kMaxOutputMagnitude));
}

bool NativeDynamicsProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U) {
        sampleRate_ = 0U;
        attackCoefficient_ = 0.0;
        releaseCoefficient_ = 0.0;
        return false;
    }

    sampleRate_ = sampleRate;
    if (officialActive_) updateOfficialParameters();
    updateDerivedParameters();
    reset();
    return true;
}

bool NativeDynamicsProcessor::setConfig(const NativeDynamicsConfig& config) noexcept {
    if (!std::isfinite(config.thresholdDb) || !std::isfinite(config.ratio) ||
        !std::isfinite(config.kneeDb) || !std::isfinite(config.attackMs) ||
        !std::isfinite(config.releaseMs) || !std::isfinite(config.outputGainDb) ||
        !isValidDetector(config.detector) || config.thresholdDb < -60.0f || config.thresholdDb > 0.0f ||
        config.ratio < 1.0f || config.ratio > 20.0f || config.kneeDb < 0.0f || config.kneeDb > 24.0f ||
        config.attackMs < 0.1f || config.attackMs > 100.0f ||
        config.releaseMs < 5.0f || config.releaseMs > 1000.0f ||
        config.outputGainDb < -24.0f || config.outputGainDb > 12.0f) {
        return false;
    }

    config_ = config;
    updateDerivedParameters();
    return true;
}

bool NativeDynamicsProcessor::setOfficialParameter(std::string_view key, float value) noexcept {
    if (!official::validParameter("dynamics", key, value)) return false;
    if (!officialActive_) {
        officialType_ = 0U;
        officialDynamics_ = 0.0f;
        officialActive_ = true;
    }
    if (key == "official_type") {
        officialType_ = static_cast<unsigned int>(value);
        officialTypeSpecified_ = true;
    } else if (key == "official_dynamics") officialDynamics_ = value;
    else return false;
    updateOfficialParameters();
    updateDerivedParameters();
    return true;
}

void NativeDynamicsProcessor::updateOfficialParameters() noexcept {
    const auto& profile = kOfficialProfiles[officialType_];
    officialConfig_.thresholdDb = std::clamp(profile.threshold + 0.18f * officialDynamics_, -60.0f, 0.0f);
    officialConfig_.ratio = std::clamp(std::pow(profile.ratio, 1.0f - officialDynamics_ / 30.0f), 1.0f, 20.0f);
    officialConfig_.kneeDb = profile.knee;
    officialConfig_.attackMs = profile.attack;
    officialConfig_.releaseMs = profile.release;
    officialConfig_.outputGainDb = profile.makeup;
    officialConfig_.detector = profile.detector;
    officialLowCutActive_ = profile.lowCut > 0.0f;
    officialHighCutActive_ = profile.highCut > 0.0f;
    if (sampleRate_ == 0U) return;
    const auto frequency = [this](float hz) noexcept {
        return std::min(static_cast<double>(hz), static_cast<double>(sampleRate_) * 0.45);
    };
    for (auto& tone : officialTone_) {
        (void)tone[0].setParameters(dsp::BiquadType::LowShelf, sampleRate_, frequency(100.0f), 0.70710678, profile.low);
        (void)tone[1].setParameters(dsp::BiquadType::HighShelf, sampleRate_, frequency(8000.0f), 0.70710678, profile.high);
        (void)tone[2].setParameters(dsp::BiquadType::HighPass, sampleRate_, frequency(std::max(20.0f, profile.lowCut)));
        (void)tone[3].setParameters(dsp::BiquadType::LowPass, sampleRate_, frequency(profile.highCut > 0.0f ? profile.highCut : 20000.0f));
    }
}

double NativeDynamicsProcessor::processOfficialTone(unsigned int channel, double sample) noexcept {
    auto& tone = officialTone_[channel];
    float value = boundedOutput(sample);
    value = tone[1].process(tone[0].process(value));
    const float highPassed = tone[2].process(value);
    if (officialLowCutActive_) value = highPassed;
    const float lowPassed = tone[3].process(value);
    if (officialHighCutActive_) value = lowPassed;
    return value;
}

void NativeDynamicsProcessor::reset() noexcept {
    for (auto& tone : officialTone_) for (auto& filter : tone) filter.reset();
    peakEnvelope_ = 0.0;
    rmsMeanSquare_ = 0.0;
}

void NativeDynamicsProcessor::updateDerivedParameters() noexcept {
    const auto& config = officialActive_ ? officialConfig_ : config_;
    outputGainLinear_ = dbToLinear(static_cast<double>(config.outputGainDb));
    if (sampleRate_ == 0U) {
        attackCoefficient_ = 0.0;
        releaseCoefficient_ = 0.0;
        return;
    }

    const double rate = static_cast<double>(sampleRate_);
    attackCoefficient_ = std::exp(-1.0 /
        (static_cast<double>(config.attackMs) * kMillisecondsToSeconds * rate));
    releaseCoefficient_ = std::exp(-1.0 /
        (static_cast<double>(config.releaseMs) * kMillisecondsToSeconds * rate));
}

double NativeDynamicsProcessor::updateDetector(double linkedMagnitude) noexcept {
    const auto& config = officialActive_ ? officialConfig_ : config_;
    double envelope = 0.0;
    if (config.detector == NativeDynamicsDetector::Rms) {
        const double power = linkedMagnitude * linkedMagnitude;
        const double coefficient = power > rmsMeanSquare_ ? attackCoefficient_ : releaseCoefficient_;
        rmsMeanSquare_ = coefficient * rmsMeanSquare_ + (1.0 - coefficient) * power;
        if (rmsMeanSquare_ < kDenormalFloor) rmsMeanSquare_ = 0.0;
        envelope = std::sqrt(std::max(0.0, rmsMeanSquare_));
    } else {
        const double coefficient = linkedMagnitude > peakEnvelope_ ? attackCoefficient_ : releaseCoefficient_;
        peakEnvelope_ = coefficient * peakEnvelope_ + (1.0 - coefficient) * linkedMagnitude;
        if (peakEnvelope_ < kDenormalFloor) peakEnvelope_ = 0.0;
        envelope = peakEnvelope_;
    }

    const double levelDb = kDbPerOctaveScale * std::log10(std::max(kEnvelopeFloor, envelope));
    const double thresholdDb = static_cast<double>(config.thresholdDb);
    const double ratio = static_cast<double>(config.ratio);
    const double kneeDb = static_cast<double>(config.kneeDb);
    const double slope = (1.0 / ratio) - 1.0;
    double gainReductionDb = 0.0;

    if (kneeDb <= 1.0e-6) {
        if (levelDb > thresholdDb) gainReductionDb = slope * (levelDb - thresholdDb);
    } else {
        const double lowerKnee = thresholdDb - kneeDb * 0.5;
        const double upperKnee = thresholdDb + kneeDb * 0.5;
        if (levelDb >= upperKnee) {
            gainReductionDb = slope * (levelDb - thresholdDb);
        } else if (levelDb > lowerKnee) {
            const double kneePosition = levelDb - lowerKnee;
            gainReductionDb = slope * kneePosition * kneePosition / (2.0 * kneeDb);
        }
    }

    const double compressionGain = dbToLinear(gainReductionDb);
    return std::isfinite(compressionGain)
        ? std::clamp(compressionGain * outputGainLinear_, 0.0, kMaxGain)
        : 0.0;
}

float NativeDynamicsProcessor::processInPlace(
    float* interleaved,
    unsigned int frames,
    unsigned int channels
) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U) return 0.0f;

    float peak = 0.0f;
    const bool canProcess = sampleRate_ != 0U;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const auto offset = static_cast<std::size_t>(frame) * channels;
        const double inputLeft = finiteInput(interleaved[offset]);
        const double inputRight = channels >= 2U ? finiteInput(interleaved[offset + 1U]) : 0.0;
        const double linkedMagnitude = std::max(std::fabs(inputLeft), std::fabs(inputRight));
        const double gain = canProcess ? updateDetector(linkedMagnitude) : 1.0;

        if (officialActive_ && canProcess) {
            interleaved[offset] = boundedOutput(processOfficialTone(0U, inputLeft * gain));
            if (channels >= 2U) interleaved[offset + 1U] = boundedOutput(processOfficialTone(1U, inputRight * gain));
        } else {
            interleaved[offset] = boundedOutput(inputLeft * gain);
            if (channels >= 2U) interleaved[offset + 1U] = boundedOutput(inputRight * gain);
        }

        for (unsigned int channel = 0U; channel < channels; ++channel) {
            const auto sampleIndex = offset + channel;
            if (channel >= 2U) {
                // Extra channels bypass the compressor but still cannot carry
                // NaN/Inf through this finite-safe processor boundary.
                const double extra = finiteInput(interleaved[sampleIndex]);
                interleaved[sampleIndex] = boundedOutput(extra);
            }
            peak = std::max(peak, std::fabs(interleaved[sampleIndex]));
        }
    }
    return peak;
}

} // namespace webrc::native
