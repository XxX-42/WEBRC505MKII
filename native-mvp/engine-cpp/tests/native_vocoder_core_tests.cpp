#include "native_vocoder_core.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>

using namespace webrc::native;

namespace {

constexpr std::uint32_t kSampleRate = 48000U;
constexpr std::size_t kBandCount = 16U;
constexpr double kPi = 3.141592653589793238462643383279502884;

[[nodiscard]] float sine(double frequency, std::size_t frame, std::uint32_t sampleRate,
                         float amplitude = 0.5f) {
    return amplitude * static_cast<float>(std::sin(
        (2.0 * kPi * frequency * static_cast<double>(frame)) / static_cast<double>(sampleRate)));
}

[[nodiscard]] double rms(const std::array<float, 8192U>& samples, std::size_t first, std::size_t end) {
    double sum = 0.0;
    for (std::size_t frame = first; frame < end; ++frame) {
        const double value = static_cast<double>(samples[frame]);
        sum += value * value;
    }
    return std::sqrt(sum / static_cast<double>(end - first));
}

[[nodiscard]] double projectedAmplitude(const std::array<float, 8192U>& samples, double frequency,
                                        std::uint32_t sampleRate) {
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t frame = 0U; frame < samples.size(); ++frame) {
        const double phase = (2.0 * kPi * frequency * static_cast<double>(frame)) /
            static_cast<double>(sampleRate);
        real += static_cast<double>(samples[frame]) * std::cos(phase);
        imaginary -= static_cast<double>(samples[frame]) * std::sin(phase);
    }
    return 2.0 * std::hypot(real, imaginary) / static_cast<double>(samples.size());
}

void testErbBandsAndConfigurationBounds() {
    NativeVocoderFilterBank bank;
    assert(bank.prepare(kSampleRate));
    assert(bank.bandCount() == kBandCount);
    assert(bank.sampleRate() == kSampleRate);
    assert(std::fabs(bank.centerFrequencyHz(0U) - 80.0f) < 0.1f);
    assert(std::fabs(bank.centerFrequencyHz(kBandCount - 1U) - 10000.0f) < 1.0f);
    assert(bank.centerFrequencyHz(kBandCount) == 0.0f);

    double previousRate = -1.0;
    double minRateSpacing = std::numeric_limits<double>::max();
    double maxRateSpacing = 0.0;
    for (std::size_t band = 0U; band < kBandCount; ++band) {
        const double center = static_cast<double>(bank.centerFrequencyHz(band));
        const double rate = 21.4 * std::log10(1.0 + 0.00437 * center);
        assert(center > 0.0);
        if (band != 0U) {
            const double spacing = rate - previousRate;
            minRateSpacing = std::min(minRateSpacing, spacing);
            maxRateSpacing = std::max(maxRateSpacing, spacing);
        }
        previousRate = rate;
    }
    assert((maxRateSpacing - minRateSpacing) < 1.0e-4);

    NativeVocoderFilterBank lowBandBank;
    NativeVocoderFilterBank highBandBank;
    assert(lowBandBank.prepare(8000U, 8U));
    assert(highBandBank.prepare(96000U, 24U));
    assert(lowBandBank.bandCount() == 8U);
    assert(highBandBank.bandCount() == 24U);
    assert(!bank.prepare(7999U, 16U));
    assert(!bank.prepare(48000U, 7U));
    assert(!bank.prepare(48000U, 25U));

    NativeVocoderCore minimumRateCore;
    NativeVocoderConfig squareConfig;
    squareConfig.carrier = NativeVocoderCarrier::Square;
    assert(minimumRateCore.setConfig(squareConfig));
    assert(minimumRateCore.prepare(8000U));
    std::array<float, 64U> minimumRateInput{};
    std::array<float, 64U> minimumRateOutput{};
    for (std::size_t frame = 0U; frame < minimumRateInput.size(); ++frame) {
        minimumRateInput[frame] = sine(440.0, frame, 8000U);
    }
    assert(minimumRateCore.process(minimumRateInput.data(), nullptr, minimumRateOutput.data(),
                                   minimumRateOutput.size()));
    for (const float sample : minimumRateOutput) {
        assert(std::isfinite(sample));
    }
}

void testModulatorEnvelopeBandSensitivityAndPerBandSynthesis() {
    NativeVocoderFilterBank bank;
    assert(bank.prepare(kSampleRate));
    constexpr std::size_t targetBand = 5U;
    const double targetFrequency = static_cast<double>(bank.centerFrequencyHz(targetBand));
    for (std::size_t frame = 0U; frame < kSampleRate; ++frame) {
        bank.analyzeModulatorSample(sine(targetFrequency, frame, kSampleRate));
    }

    const float targetEnvelope = bank.envelope(targetBand);
    const float distantEnvelope = bank.envelope(kBandCount - 1U);
    assert(targetEnvelope > 0.2f);
    assert(targetEnvelope > distantEnvelope * 3.0f);
    for (std::size_t band = 0U; band < kBandCount; ++band) {
        assert(std::isfinite(bank.envelope(band)));
        assert(bank.envelope(band) >= 0.0f && bank.envelope(band) <= 8.0f);
    }

    std::array<float, kNativeVocoderMaxBands> carriers{};
    carriers[targetBand] = 1.0f;
    const float targetSynthesis = bank.synthesizeSample(carriers.data(), kBandCount);
    assert(std::fabs(targetSynthesis - (targetEnvelope / std::sqrt(static_cast<float>(kBandCount)))) < 1.0e-5f);
    carriers.fill(0.0f);
    carriers[kBandCount - 1U] = 1.0f;
    const float remoteSynthesis = bank.synthesizeSample(carriers.data(), kBandCount);
    assert(std::fabs(remoteSynthesis - (distantEnvelope / std::sqrt(static_cast<float>(kBandCount)))) < 1.0e-5f);
    assert(targetSynthesis > remoteSynthesis * 3.0f);

    NativeVocoderFilterBank carrierBank;
    assert(carrierBank.prepare(kSampleRate));
    std::array<double, kBandCount> energy{};
    constexpr std::size_t frames = 24000U;
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float carrier = sine(targetFrequency, frame, kSampleRate);
        for (std::size_t band = 0U; band < kBandCount; ++band) {
            const float output = carrierBank.filterCarrierSample(band, carrier);
            if (frame >= 12000U) {
                energy[band] += static_cast<double>(output) * static_cast<double>(output);
            }
        }
    }
    const double targetRms = std::sqrt(energy[targetBand] / 12000.0);
    const double distantRms = std::sqrt(energy[kBandCount - 1U] / 12000.0);
    assert(targetRms > 0.2);
    assert(targetRms > distantRms * 3.0);
}

void testOscillatorPolyBlepAntiAliasingAndClocking() {
    constexpr std::uint32_t sampleRate = 8000U;
    constexpr float frequency = 1500.0f;
    NativeVocoderOscillator square;
    assert(square.prepare(sampleRate, frequency, NativeVocoderWaveform::Square));
    std::array<float, 8192U> samples{};
    for (float& sample : samples) {
        sample = square.processSample();
        assert(std::isfinite(sample));
    }
    const double fundamental = projectedAmplitude(samples, frequency, sampleRate);
    const double foldedThirdHarmonic = projectedAmplitude(samples, 3500.0, sampleRate);
    assert(fundamental > 0.7);
    // An uncorrected square has about 0.424 amplitude from its 3rd harmonic
    // folded from 4.5 kHz to 3.5 kHz. PolyBLEP softens that discontinuity.
    assert(foldedThirdHarmonic < 0.35);

    NativeVocoderOscillator saw;
    assert(saw.prepare(44100U, 440.0f, NativeVocoderWaveform::Saw));
    NativeVocoderOscillator chunked;
    assert(chunked.prepare(44100U, 440.0f, NativeVocoderWaveform::Saw));
    std::array<float, 44100U> whole{};
    std::array<float, 44100U> segmented{};
    for (float& sample : whole) {
        sample = saw.processSample();
    }
    constexpr std::array<std::size_t, 5U> chunks{{1U, 17U, 128U, 511U, 2048U}};
    std::size_t cursor = 0U;
    std::size_t chunkIndex = 0U;
    while (cursor < segmented.size()) {
        const std::size_t count = std::min(chunks[chunkIndex % chunks.size()], segmented.size() - cursor);
        for (std::size_t offset = 0U; offset < count; ++offset) {
            segmented[cursor + offset] = chunked.processSample();
        }
        cursor += count;
        ++chunkIndex;
    }
    for (std::size_t frame = 0U; frame < whole.size(); ++frame) {
        assert(std::fabs(whole[frame] - segmented[frame]) < 1.0e-7f);
    }
    assert(std::fabs(saw.phase()) < 1.0e-9 || std::fabs(saw.phase() - 1.0) < 1.0e-9);
    const float beforeInvalidFrequency = saw.frequencyHz();
    assert(!saw.setFrequency(std::numeric_limits<float>::quiet_NaN()));
    assert(!saw.setFrequency(22050.0f));
    assert(saw.frequencyHz() == beforeInvalidFrequency);
    assert(!saw.setWaveform(static_cast<NativeVocoderWaveform>(99U)));
    assert(!saw.prepare(8000U, 4000.0f, NativeVocoderWaveform::Square));
    assert(saw.frequencyHz() == beforeInvalidFrequency);
}

void testCoreCarrierModesMixingAndInvalidControls() {
    NativeVocoderCore core;
    assert(!core.process(nullptr, nullptr, nullptr, 1U));
    assert(core.prepare(kSampleRate));
    assert(core.config().carrier == NativeVocoderCarrier::VoiceInput);

    NativeVocoderConfig invalid = core.config();
    invalid.bands = 7U;
    assert(!core.setConfig(invalid));
    invalid = core.config();
    invalid.wetMix = std::numeric_limits<float>::quiet_NaN();
    assert(!core.setConfig(invalid));
    invalid = core.config();
    invalid.wetMix = 1.01f;
    assert(!core.setConfig(invalid));
    invalid = core.config();
    invalid.carrier = static_cast<NativeVocoderCarrier>(99U);
    assert(!core.setConfig(invalid));
    invalid = core.config();
    invalid.formantShiftSemitones = 1.0f;
    assert(!core.setConfig(invalid));
    assert(core.config().carrier == NativeVocoderCarrier::VoiceInput);
    assert(core.config().wetMix == 1.0f);

    constexpr std::size_t frameCount = 8192U;
    std::array<float, frameCount> modulator{};
    std::array<float, frameCount> carrier{};
    std::array<float, frameCount> output{};
    const float pitch = core.filterBank().centerFrequencyHz(6U);
    for (std::size_t frame = 0U; frame < frameCount; ++frame) {
        modulator[frame] = sine(pitch, frame, kSampleRate);
        carrier[frame] = sine(pitch, frame, kSampleRate, 0.4f);
    }
    assert(core.process(modulator.data(), carrier.data(), output.data(), frameCount));
    const double voiceCarrierRms = rms(output, 4000U, frameCount);
    assert(voiceCarrierRms > 0.02);

    NativeVocoderCore silentCarrierCore;
    assert(silentCarrierCore.prepare(kSampleRate));
    std::array<float, frameCount> zeroCarrier{};
    std::array<float, frameCount> silentCarrierOutput{};
    assert(silentCarrierCore.process(modulator.data(), zeroCarrier.data(), silentCarrierOutput.data(), frameCount));
    assert(voiceCarrierRms > rms(silentCarrierOutput, 4000U, frameCount) * 1.5);

    NativeVocoderConfig config = core.config();
    config.wetMix = 0.0f;
    assert(core.setConfig(config));
    assert(core.process(modulator.data(), nullptr, output.data(), frameCount));
    for (std::size_t frame = 0U; frame < frameCount; ++frame) {
        assert(output[frame] == modulator[frame]);
    }

    config.wetMix = 1.0f;
    config.enabled = false;
    assert(core.setConfig(config));
    assert(core.process(modulator.data(), carrier.data(), output.data(), frameCount));
    for (std::size_t frame = 0U; frame < frameCount; ++frame) {
        assert(output[frame] == modulator[frame]);
    }

    config.enabled = true;
    config.carrier = NativeVocoderCarrier::Saw;
    assert(core.setConfig(config));
    core.reset();
    std::array<float, frameCount> sawOutput{};
    assert(core.process(modulator.data(), nullptr, sawOutput.data(), frameCount));
    const double sawRms = rms(sawOutput, 4000U, frameCount);
    assert(sawRms > 0.01);
    core.reset();
    std::array<float, frameCount> ignoredVoiceCarrierOutput{};
    assert(core.process(modulator.data(), carrier.data(), ignoredVoiceCarrierOutput.data(), frameCount));
    for (std::size_t frame = 0U; frame < frameCount; ++frame) {
        assert(ignoredVoiceCarrierOutput[frame] == sawOutput[frame]);
    }
    config.carrier = NativeVocoderCarrier::Square;
    assert(core.setConfig(config));
    core.reset();
    std::array<float, frameCount> squareOutput{};
    assert(core.process(modulator.data(), nullptr, squareOutput.data(), frameCount));
    const double squareRms = rms(squareOutput, 4000U, frameCount);
    assert(squareRms > 0.01);
    double difference = 0.0;
    for (std::size_t frame = 4000U; frame < frameCount; ++frame) {
        difference += std::fabs(static_cast<double>(squareOutput[frame]) - static_cast<double>(sawOutput[frame]));
    }
    assert(difference / static_cast<double>(frameCount - 4000U) > 0.001);

    std::array<float, 8U> hostile{{0.0f, std::numeric_limits<float>::infinity(),
        -std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN(),
        std::numeric_limits<float>::max(), -std::numeric_limits<float>::max(), 0.1f, -0.1f}};
    std::array<float, 8U> sanitized{};
    assert(core.process(hostile.data(), nullptr, sanitized.data(), sanitized.size()));
    for (const float sample : sanitized) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 8.0f);
    }
    assert(!core.process(nullptr, nullptr, output.data(), 1U));
    assert(!core.process(modulator.data(), nullptr, nullptr, 1U));
    assert(core.process(nullptr, nullptr, nullptr, 0U));
}

void testVariableBlocksAndZeroCallbackAllocations() {
    constexpr std::size_t frames = 8192U;
    NativeVocoderCore wholeCore;
    NativeVocoderCore chunkedCore;
    assert(wholeCore.prepare(kSampleRate));
    assert(chunkedCore.prepare(kSampleRate));
    NativeVocoderConfig config;
    config.carrier = NativeVocoderCarrier::Square;
    config.wetMix = 0.63f;
    assert(wholeCore.setConfig(config));
    assert(chunkedCore.setConfig(config));

    std::array<float, frames> input{};
    std::array<float, frames> wholeOutput{};
    std::array<float, frames> chunkedOutput{};
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame] = sine(330.0, frame, kSampleRate, 0.35f) + sine(1300.0, frame, kSampleRate, 0.1f);
    }

    const std::size_t before = test_alloc::count();
    test_alloc::beginTracking();
    assert(wholeCore.process(input.data(), nullptr, wholeOutput.data(), frames));
    test_alloc::endTracking();
    assert(test_alloc::count() == before);

    constexpr std::array<std::size_t, 7U> chunks{{1U, 63U, 64U, 127U, 255U, 511U, 1024U}};
    std::size_t cursor = 0U;
    std::size_t chunkIndex = 0U;
    while (cursor < frames) {
        const std::size_t count = std::min(chunks[chunkIndex % chunks.size()], frames - cursor);
        assert(chunkedCore.process(input.data() + cursor, nullptr, chunkedOutput.data() + cursor, count));
        cursor += count;
        ++chunkIndex;
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        assert(std::fabs(wholeOutput[frame] - chunkedOutput[frame]) < 1.0e-7f);
    }

    NativeVocoderFilterBank bank;
    assert(bank.prepare(kSampleRate));
    std::array<float, kNativeVocoderMaxBands> carriers{};
    NativeVocoderOscillator oscillator;
    assert(oscillator.prepare(kSampleRate, 440.0f, NativeVocoderWaveform::Saw));
    const std::size_t callbackBefore = test_alloc::count();
    test_alloc::beginTracking();
    for (std::size_t frame = 0U; frame < 1024U; ++frame) {
        bank.analyzeModulatorSample(input[frame]);
        for (std::size_t band = 0U; band < bank.bandCount(); ++band) {
            carriers[band] = bank.filterCarrierSample(band, oscillator.processSample());
        }
        (void)bank.synthesizeSample(carriers.data(), bank.bandCount());
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == callbackBefore);
}

} // namespace

int main() {
    testErbBandsAndConfigurationBounds();
    testModulatorEnvelopeBandSensitivityAndPerBandSynthesis();
    testOscillatorPolyBlepAntiAliasingAndClocking();
    testCoreCarrierModesMixingAndInvalidControls();
    testVariableBlocksAndZeroCallbackAllocations();
    return 0;
}
