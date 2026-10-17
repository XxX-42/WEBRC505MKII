#include "native_preamp_processor.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>

namespace webrc::native {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kTwoPi = 2.0 * kPi;
constexpr double kCutoffCyclesPerOversample = 0.118;
constexpr float kMaxFiniteInput = 16.0f;
constexpr float kMaxFiniteOutput = 4.0f;
constexpr std::array<float, 5U> kMaxStageGain{{1.8f, 7.5f, 14.0f, 22.0f, 3.2f}};
constexpr std::array<float, 5U> kTriodeSlope{{0.9f, 1.05f, 1.18f, 1.28f, 0.78f}};
constexpr std::array<float, 5U> kGridBias{{0.0f, 0.12f, 0.045f, 0.16f, 0.025f}};
constexpr std::array<float, 4U> kStageDrive{{1.08f, 1.02f, 0.98f, 0.93f}};
constexpr std::array<float, 4U> kStageSlope{{0.94f, 1.04f, 0.91f, 1.12f}};
constexpr std::array<float, 5U> kModelBassGain{{1.0f, 1.12f, 0.92f, 0.96f, 1.18f}};
constexpr std::array<float, 5U> kModelMiddleGain{{1.0f, 0.92f, 0.72f, 1.08f, 1.0f}};
constexpr std::array<float, 5U> kModelTrebleGain{{1.0f, 0.86f, 0.92f, 1.0f, 0.76f}};
constexpr std::array<float, 5U> kCabinetCutoffHz{{7200.0f, 5900.0f, 5300.0f, 6400.0f, 4500.0f}};

[[nodiscard]] float finiteBoundedInput(float value) noexcept {
    return std::isfinite(value) ? std::clamp(value, -kMaxFiniteInput, kMaxFiniteInput) : 0.0f;
}

[[nodiscard]] float gainForDb(float gainDb) noexcept {
    return static_cast<float>(std::pow(10.0, static_cast<double>(gainDb) / 20.0));
}

[[nodiscard]] float onePoleCoefficient(float cutoffHz, unsigned int sampleRate) noexcept {
    const float safeCutoff = std::clamp(cutoffHz, 1.0f, static_cast<float>(sampleRate) * 0.45f);
    return static_cast<float>(1.0 - std::exp(-kTwoPi * static_cast<double>(safeCutoff) /
                                               static_cast<double>(sampleRate)));
}

[[nodiscard]] float modelValue(const std::array<float, 5U>& values, float position) noexcept {
    const float boundedPosition = std::clamp(position, 0.0f, 4.0f);
    const auto lower = static_cast<unsigned int>(boundedPosition);
    const unsigned int upper = std::min(lower + 1U, 4U);
    const float fraction = boundedPosition - static_cast<float>(lower);
    return values[lower] + (values[upper] - values[lower]) * fraction;
}

[[nodiscard]] float logCosh(float value) noexcept {
    const double absolute = std::min(std::fabs(static_cast<double>(value)), 32.0);
    return static_cast<float>(absolute + std::log1p(std::exp(-2.0 * absolute)) - std::log(2.0));
}

[[nodiscard]] float triodeTransfer(float input, float slope, float bias) noexcept {
    const float bounded = std::clamp(slope * (input + bias), -16.0f, 16.0f);
    const float biasValue = std::clamp(slope * bias, -16.0f, 16.0f);
    return std::tanh(bounded) - std::tanh(biasValue);
}

// First-order ADAA for the smooth, biased triode-like transfer. Its
// antiderivative is log(cosh(slope * (x + bias))) / slope minus the bias
// offset's linear term. The finite-difference form attenuates folded
// harmonics without a sample-rate-dependent waveshaping shortcut.
[[nodiscard]] float antialiasedTriode(float input, float previousInput, float slope, float bias) noexcept {
    const float delta = input - previousInput;
    if (std::fabs(delta) < 1.0e-4f) {
        return triodeTransfer(0.5f * (input + previousInput), slope, bias);
    }
    const auto antiderivative = [slope, bias](float value) noexcept {
        const float shifted = std::clamp(slope * (value + bias), -16.0f, 16.0f);
        const float biasArgument = std::clamp(slope * bias, -16.0f, 16.0f);
        return (logCosh(shifted) - logCosh(biasArgument)) / slope -
               std::tanh(biasArgument) * value;
    };
    const float result = (antiderivative(input) - antiderivative(previousInput)) / delta;
    return std::isfinite(result) ? std::clamp(result, -2.0f, 2.0f) : 0.0f;
}

} // namespace

bool NativePreampProcessor::prepare(unsigned int sampleRate) noexcept {
    if (sampleRate < 8000U || sampleRate > 192000U) return false;
    sampleRate_ = sampleRate;
    designFilters();
    designCabinetImpulseResponses();
    toneLowCoefficient_ = onePoleCoefficient(180.0f, sampleRate_);
    toneUpperCoefficient_ = onePoleCoefficient(2500.0f, sampleRate_);
    cabinetHighPassCoefficient_ = onePoleCoefficient(72.0f, sampleRate_);
    reset();
    return true;
}

bool NativePreampProcessor::setConfig(const NativePreampConfig& config, std::uint64_t rampFrames) noexcept {
    if (!std::isfinite(config.model) || !std::isfinite(config.gainPercent) ||
        !std::isfinite(config.bassDb) || !std::isfinite(config.middleDb) ||
        !std::isfinite(config.trebleDb) || !std::isfinite(config.levelDb) ||
        config.model < 0.0f || config.model > 4.0f || std::floor(config.model) != config.model ||
        config.gainPercent < 0.0f || config.gainPercent > 100.0f ||
        config.bassDb < -12.0f || config.bassDb > 12.0f ||
        config.middleDb < -12.0f || config.middleDb > 12.0f ||
        config.trebleDb < -12.0f || config.trebleDb > 12.0f ||
        config.levelDb < -24.0f || config.levelDb > 12.0f) {
        return false;
    }

    config_ = config;
    modelPosition_.setTarget(config.model, rampFrames);
    gainPercent_.setTarget(config.gainPercent, rampFrames);
    bassGain_.setTarget(gainForDb(config.bassDb), rampFrames);
    middleGain_.setTarget(gainForDb(config.middleDb), rampFrames);
    trebleGain_.setTarget(gainForDb(config.trebleDb), rampFrames);
    levelGain_.setTarget(gainForDb(config.levelDb), rampFrames);
    return true;
}

void NativePreampProcessor::reset() noexcept {
    clearChannelState();
    modelPosition_.reset(config_.model);
    gainPercent_.reset(config_.gainPercent);
    bassGain_.reset(gainForDb(config_.bassDb));
    middleGain_.reset(gainForDb(config_.middleDb));
    trebleGain_.reset(gainForDb(config_.trebleDb));
    levelGain_.reset(gainForDb(config_.levelDb));
}

float NativePreampProcessor::processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept {
    if (interleaved == nullptr || frames == 0U || channels == 0U || sampleRate_ == 0U) return 0.0f;

    float peak = 0.0f;
    for (unsigned int frameIndex = 0U; frameIndex < frames; ++frameIndex) {
        const std::size_t offset = static_cast<std::size_t>(frameIndex) * channels;
        const float model = modelPosition_.next();
        const float gain = gainPercent_.next();
        const float bass = bassGain_.next();
        const float middle = middleGain_.next();
        const float treble = trebleGain_.next();
        const float level = levelGain_.next();

        const float left = processSample(0U, finiteBoundedInput(interleaved[offset]),
            model, gain, bass, middle, treble, level);
        interleaved[offset] = left;
        peak = std::max(peak, std::fabs(left));

        const float rightInput = channels >= 2U
            ? finiteBoundedInput(interleaved[offset + 1U])
            : 0.0f;
        const float right = processSample(1U, rightInput, model, gain, bass, middle, treble, level);
        if (channels >= 2U) {
            interleaved[offset + 1U] = right;
            peak = std::max(peak, std::fabs(right));
        }
    }
    return peak;
}

float NativePreampProcessor::processSample(
    unsigned int channel,
    float input,
    float modelPosition,
    float gainPercent,
    float bassGain,
    float middleGain,
    float trebleGain,
    float levelGain
) noexcept {
    auto& state = channels_[channel];
    const float safeInput = finiteBoundedInput(input);
    const float boundedModel = std::clamp(modelPosition, 0.0f, 4.0f);
    const float gain = std::clamp(gainPercent, 0.0f, 100.0f) * 0.01f;
    const float totalDrive = 1.0f + modelValue(kMaxStageGain, boundedModel) * gain;
    const float commonStageGain = std::pow(std::max(totalDrive, 0.01f), 0.25f);

    state.inputHistory[state.inputWrite] = safeInput;
    float cabinetInput = 0.0f;
    for (unsigned int phase = 0U; phase < kOversampling; ++phase) {
        float stageSignal = interpolate(channel, phase);
        for (unsigned int stage = 0U; stage < kNonlinearStageCount; ++stage) {
            const float stageInput = std::clamp(
                stageSignal * commonStageGain * kStageDrive[stage], -16.0f, 16.0f);
            const float slope = modelValue(kTriodeSlope, boundedModel) * kStageSlope[stage];
            const float bias = modelValue(kGridBias, boundedModel) * (0.72f + 0.17f * static_cast<float>(stage));
            const float shaped = antialiasedTriode(
                stageInput, state.previousStageInput[stage], slope, bias);
            state.previousStageInput[stage] = stageInput;
            // Interstage coupling gain and loading. The product remains near
            // unity at low gain while high-gain models drive successive stages.
            stageSignal = std::clamp(shaped * 1.42f, -8.0f, 8.0f);
        }
        const float reconstructed = reconstruct(channel, std::isfinite(stageSignal) ? stageSignal : 0.0f, phase == 0U);
        if (phase == 0U) cabinetInput = reconstructed;
    }
    ++state.inputWrite;
    if (state.inputWrite == kPolyphaseTaps) state.inputWrite = 0U;

    const float lowModelGain = modelValue(kModelBassGain, boundedModel);
    const float middleModelGain = modelValue(kModelMiddleGain, boundedModel);
    const float highModelGain = modelValue(kModelTrebleGain, boundedModel);
    state.toneLowState += toneLowCoefficient_ * (cabinetInput - state.toneLowState);
    state.toneUpperState += toneUpperCoefficient_ * (cabinetInput - state.toneUpperState);
    const float lowBand = state.toneLowState;
    const float middleBand = state.toneUpperState - state.toneLowState;
    const float highBand = cabinetInput - state.toneUpperState;
    const float toneOutput = lowBand * bassGain * lowModelGain +
                             middleBand * middleGain * middleModelGain +
                             highBand * trebleGain * highModelGain;

    state.cabinetHighPassState += cabinetHighPassCoefficient_ * (toneOutput - state.cabinetHighPassState);
    const float cabinetHighPassed = toneOutput - state.cabinetHighPassState;
    state.cabinetHistory[state.cabinetWrite] = cabinetHighPassed;
    const auto lowerModel = static_cast<unsigned int>(boundedModel);
    const auto upperModel = std::min(lowerModel + 1U, kModelCount - 1U);
    const float modelFraction = boundedModel - static_cast<float>(lowerModel);
    float cabinetOutput = 0.0f;
    unsigned int historyIndex = state.cabinetWrite;
    for (unsigned int tap = 0U; tap < kCabinetIrTaps; ++tap) {
        const float lowerCoefficient = cabinetImpulseResponses_[lowerModel][tap];
        const float coefficient = lowerCoefficient +
            (cabinetImpulseResponses_[upperModel][tap] - lowerCoefficient) * modelFraction;
        cabinetOutput += coefficient * state.cabinetHistory[historyIndex];
        if (historyIndex == 0U) historyIndex = kCabinetIrTaps - 1U;
        else --historyIndex;
    }
    ++state.cabinetWrite;
    if (state.cabinetWrite == kCabinetIrTaps) state.cabinetWrite = 0U;

    const float output = cabinetOutput * levelGain;
    return std::isfinite(output) ? std::clamp(output, -kMaxFiniteOutput, kMaxFiniteOutput) : 0.0f;
}

float NativePreampProcessor::interpolate(unsigned int channel, unsigned int phase) const noexcept {
    const auto& state = channels_[channel];
    unsigned int historyIndex = state.inputWrite;
    float sum = 0.0f;
    for (unsigned int tap = phase; tap < kFirTaps; tap += kOversampling) {
        sum += interpolationTaps_[tap] * state.inputHistory[historyIndex];
        if (historyIndex == 0U) historyIndex = kPolyphaseTaps - 1U;
        else --historyIndex;
    }
    return std::isfinite(sum) ? std::clamp(sum, -kMaxFiniteInput, kMaxFiniteInput) : 0.0f;
}

float NativePreampProcessor::reconstruct(unsigned int channel, float sample, bool computeOutput) noexcept {
    auto& state = channels_[channel];
    state.reconstructionHistory[state.reconstructionWrite] = sample;
    float sum = 0.0f;
    if (computeOutput) {
        unsigned int historyIndex = state.reconstructionWrite;
        for (unsigned int tap = 0U; tap < kFirTaps; ++tap) {
            sum += reconstructionTaps_[tap] * state.reconstructionHistory[historyIndex];
            if (historyIndex == 0U) historyIndex = kFirTaps - 1U;
            else --historyIndex;
        }
    }
    ++state.reconstructionWrite;
    if (state.reconstructionWrite == kFirTaps) state.reconstructionWrite = 0U;
    return std::isfinite(sum) ? sum : 0.0f;
}

void NativePreampProcessor::designFilters() noexcept {
    // Blackman-windowed sinc at 0.118 cycles per 4x sample. The symmetric
    // prototype is normalized for interpolation gain (4) and reconstruction
    // gain (1), then each interpolation phase is DC-balanced independently.
    const double center = static_cast<double>(kFirTaps - 1U) * 0.5;
    double rawSum = 0.0;
    for (unsigned int tap = 0U; tap < kFirTaps; ++tap) {
        const double position = static_cast<double>(tap) - center;
        const double ideal = position == 0.0
            ? 2.0 * kCutoffCyclesPerOversample
            : std::sin(kTwoPi * kCutoffCyclesPerOversample * position) / (kPi * position);
        const double normalizedPosition = static_cast<double>(tap) / static_cast<double>(kFirTaps - 1U);
        const double window = 0.42 - 0.5 * std::cos(kTwoPi * normalizedPosition) +
                              0.08 * std::cos(2.0 * kTwoPi * normalizedPosition);
        interpolationTaps_[tap] = static_cast<float>(ideal * window);
        rawSum += ideal * window;
    }

    if (rawSum == 0.0 || !std::isfinite(rawSum)) {
        interpolationTaps_.fill(0.0f);
        reconstructionTaps_.fill(0.0f);
        interpolationTaps_[(kFirTaps - 1U) / 2U] = static_cast<float>(kOversampling);
        reconstructionTaps_[(kFirTaps - 1U) / 2U] = 1.0f;
        return;
    }

    for (unsigned int tap = 0U; tap < kFirTaps; ++tap) {
        const float unityCoefficient = interpolationTaps_[tap] / static_cast<float>(rawSum);
        reconstructionTaps_[tap] = unityCoefficient;
        interpolationTaps_[tap] = unityCoefficient * static_cast<float>(kOversampling);
    }
    for (unsigned int phase = 0U; phase < kOversampling; ++phase) {
        double phaseSum = 0.0;
        for (unsigned int tap = phase; tap < kFirTaps; tap += kOversampling) {
            phaseSum += interpolationTaps_[tap];
        }
        if (std::fabs(phaseSum) < 1.0e-12) continue;
        const float correction = static_cast<float>(1.0 / phaseSum);
        for (unsigned int tap = phase; tap < kFirTaps; tap += kOversampling) {
            interpolationTaps_[tap] *= correction;
        }
    }
}

void NativePreampProcessor::designCabinetImpulseResponses() noexcept {
    const double center = static_cast<double>(kCabinetIrTaps - 1U) * 0.5;
    for (unsigned int model = 0U; model < kModelCount; ++model) {
        auto& impulse = cabinetImpulseResponses_[model];
        double coefficientSum = 0.0;
        const double normalizedCutoff = std::clamp(
            static_cast<double>(kCabinetCutoffHz[model]) / static_cast<double>(sampleRate_),
            0.015, 0.44);
        for (unsigned int tap = 0U; tap < kCabinetIrTaps; ++tap) {
            const double offset = static_cast<double>(tap) - center;
            const double ideal = offset == 0.0
                ? 2.0 * normalizedCutoff
                : std::sin(kTwoPi * normalizedCutoff * offset) / (kPi * offset);
            const double normalizedPosition = static_cast<double>(tap) /
                                              static_cast<double>(kCabinetIrTaps - 1U);
            const double window = 0.42 - 0.5 * std::cos(kTwoPi * normalizedPosition) +
                                  0.08 * std::cos(2.0 * kTwoPi * normalizedPosition);
            // A quiet, symmetric broad cone resonance gives each clean-room
            // cabinet response a little body in addition to its low-pass rolloff.
            const double resonanceWindow = std::exp(-std::fabs(offset) / 17.0);
            const double resonance = 0.012 * resonanceWindow *
                std::cos(kTwoPi * 185.0 * offset / static_cast<double>(sampleRate_));
            impulse[tap] = static_cast<float>(ideal * window + resonance * window);
            coefficientSum += impulse[tap];
        }
        if (!std::isfinite(coefficientSum) || std::fabs(coefficientSum) < 1.0e-12) {
            impulse.fill(0.0f);
            impulse[(kCabinetIrTaps - 1U) / 2U] = 1.0f;
            continue;
        }
        const float normalization = static_cast<float>(1.0 / coefficientSum);
        for (float& coefficient : impulse) coefficient *= normalization;
    }
}

void NativePreampProcessor::clearChannelState() noexcept {
    for (auto& state : channels_) {
        state.inputHistory.fill(0.0f);
        state.reconstructionHistory.fill(0.0f);
        state.cabinetHistory.fill(0.0f);
        state.previousStageInput.fill(0.0f);
        state.inputWrite = 0U;
        state.reconstructionWrite = 0U;
        state.cabinetWrite = 0U;
        state.toneLowState = 0.0f;
        state.toneUpperState = 0.0f;
        state.cabinetHighPassState = 0.0f;
    }
}

} // namespace webrc::native
