#include "native_robot_core.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;

std::vector<float> makeTone(std::size_t frames, unsigned int channels, unsigned int sampleRate,
                            double frequency, float amplitude = 0.35f) {
    std::vector<float> result(frames * channels);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float sample = static_cast<float>(static_cast<double>(amplitude) * std::sin(
            2.0 * kPi * frequency * static_cast<double>(frame) / static_cast<double>(sampleRate)));
        for (unsigned int channel = 0U; channel < channels; ++channel) {
            result[frame * channels + channel] = sample;
        }
    }
    return result;
}

std::vector<float> makeHarmonicVoice(unsigned int frames, unsigned int sampleRate, double fundamentalHz) {
    std::vector<float> result(frames);
    double peak = 0.0;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        double sample = 0.0;
        for (unsigned int harmonic = 1U; harmonic < 220U; ++harmonic) {
            const double frequency = fundamentalHz * static_cast<double>(harmonic);
            if (frequency >= static_cast<double>(sampleRate) * 0.48) break;
            const double formant1 = 0.8 * std::exp(-0.5 * std::pow((frequency - 700.0) / 180.0, 2.0));
            const double formant2 = 0.55 * std::exp(-0.5 * std::pow((frequency - 1500.0) / 260.0, 2.0));
            const double formant3 = 0.25 * std::exp(-0.5 * std::pow((frequency - 2700.0) / 500.0, 2.0));
            const double amplitude = formant1 + formant2 + formant3;
            sample += amplitude * std::sin(2.0 * kPi * frequency * static_cast<double>(frame) /
                                           static_cast<double>(sampleRate) + 0.13 * harmonic);
        }
        result[frame] = static_cast<float>(sample);
        peak = std::max(peak, std::fabs(sample));
    }
    if (peak > 0.0) {
        for (float& sample : result) sample = static_cast<float>(static_cast<double>(sample) * 0.35 / peak);
    }
    return result;
}

std::vector<float> makeSingleFormantVoice(unsigned int frames, unsigned int sampleRate,
                                          double fundamentalHz, double formantHz) {
    std::vector<float> result(frames);
    double peak = 0.0;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        double sample = 0.0;
        for (unsigned int harmonic = 1U; harmonic < 220U; ++harmonic) {
            const double frequency = fundamentalHz * static_cast<double>(harmonic);
            if (frequency >= static_cast<double>(sampleRate) * 0.48) break;
            const double envelope = std::exp(-0.5 * std::pow((frequency - formantHz) / 180.0, 2.0));
            sample += envelope * std::sin(2.0 * kPi * frequency * static_cast<double>(frame) /
                                          static_cast<double>(sampleRate) + 0.13 * harmonic);
        }
        result[frame] = static_cast<float>(sample);
        peak = std::max(peak, std::fabs(sample));
    }
    if (peak > 0.0) {
        for (float& sample : result) sample = static_cast<float>(static_cast<double>(sample) * 0.35 / peak);
    }
    return result;
}

void appendVariableMidiTone(std::vector<float>& output, unsigned int frames, unsigned int sampleRate,
                            double midiCenter, double vibratoDepth, double vibratoHz, double& phase) {
    const std::size_t firstFrame = output.size();
    output.resize(firstFrame + frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const double time = static_cast<double>(frame) / static_cast<double>(sampleRate);
        const double midi = midiCenter + vibratoDepth * std::sin(2.0 * kPi * vibratoHz * time);
        const double frequency = 440.0 * std::pow(2.0, (midi - 69.0) / 12.0);
        phase += 2.0 * kPi * frequency / static_cast<double>(sampleRate);
        output[firstFrame + frame] = static_cast<float>(0.3 * std::sin(phase));
    }
}

void processBlocks(NativeRobotCore& core, std::vector<float>& audio, unsigned int channels,
                   const std::array<unsigned int, 7U>& blockSizes) {
    std::size_t offsetFrames = 0U;
    std::size_t blockIndex = 0U;
    const std::size_t totalFrames = audio.size() / channels;
    while (offsetFrames < totalFrames) {
        const unsigned int requested = blockSizes[blockIndex % blockSizes.size()];
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            requested, totalFrames - offsetFrames));
        assert(count > 0U);
        assert(core.processInterleaved(audio.data() + offsetFrames * channels, count, channels));
        offsetFrames += count;
        ++blockIndex;
    }
}

double powerAt(const std::vector<float>& samples, std::size_t begin, std::size_t end,
               unsigned int channels, unsigned int channel, unsigned int sampleRate, double frequency) {
    assert(channel < channels);
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t frame = begin; frame < end; ++frame) {
        const double phase = 2.0 * kPi * frequency * static_cast<double>(frame) /
            static_cast<double>(sampleRate);
        const double sample = samples[frame * channels + channel];
        real += sample * std::cos(phase);
        imaginary -= sample * std::sin(phase);
    }
    return real * real + imaginary * imaginary;
}

double bandEnergy(const std::vector<float>& samples, std::size_t begin, std::size_t end,
                  unsigned int sampleRate, double lowHz, double highHz) {
    double energy = 0.0;
    for (double frequency = lowHz; frequency <= highHz; frequency += 25.0) {
        energy += powerAt(samples, begin, end, 1U, 0U, sampleRate, frequency);
    }
    return energy;
}

void testConfigAndExplicitFormantPolicies() {
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    assert(config.pitchMode == NativeRobotCore::PitchMode::NearestSemitone);
    assert(config.formantPolicy == NativeRobotCore::FormantPolicy::IndependentShift);
    assert(!core.prepare(NativeRobotCore::Config{0U, 1U}));
    assert(!core.prepare(NativeRobotCore::Config{48000U, 3U}));

    config.sampleRate = 48000U;
    config.channels = 1U;
    config.pitchSemitones = 24.01f;
    assert(!core.prepare(config));
    config.pitchSemitones = 0.0f;
    config.formantSemitones = 12.01f;
    assert(!core.prepare(config));
    config.formantSemitones = 0.0f;
    config.mixPercent = std::numeric_limits<float>::quiet_NaN();
    assert(!core.prepare(config));

    config.mixPercent = 100.0f;
    config.formantPolicy = static_cast<NativeRobotCore::FormantPolicy>(3U);
    assert(!core.prepare(config));
    assert(!NativeRobotCore::supportsFormantPolicy(static_cast<NativeRobotCore::FormantPolicy>(3U)));

    config.formantPolicy = NativeRobotCore::FormantPolicy::Preserve;
    config.formantSemitones = 1.0f; // Preserve cannot silently consume an independent shift.
    assert(!core.prepare(config));
    config.formantSemitones = 0.0f;
    assert(core.prepare(config));
    assert(core.prepared());
    assert(core.formantPolicy() == NativeRobotCore::FormantPolicy::Preserve);
    assert(core.latencyFrames() == NativeRobotCore::calculateLatencyFrames(48000U));
    assert(core.latencyFrames() == 1920U);
    assert(core.signalsmithAlgorithmLatencyFrames() == 1920U);
    assert(core.psolaAlgorithmLatencyFrames() == NativePitchProcessor::calculateLatencySamples(
        48000U, NativeRobotCore::kPsolaMinimumFrequencyHz));
    assert(core.psolaAlgorithmLatencyFrames() == 1416U);
    assert(core.psolaAlgorithmLatencyFrames() < 48000U * 30U / 1000U);
    assert(core.psolaOutputAlignmentFrames() == 504U);
    assert(core.pitchAnalysisWindowFrames() == 2628U);
    assert(core.pitchAnalysisHopFrames() == 240U);
    assert(core.estimatedPitchAcquisitionFrames() == 3348U);
    assert(!core.setFormantSemitones(1.0f));
    assert(!core.setPitchSemitones(std::numeric_limits<float>::infinity()));
    assert(!core.setMixPercent(-1.0f));
    assert(!core.setPitchMode(static_cast<NativeRobotCore::PitchMode>(2U)));

    config.formantPolicy = NativeRobotCore::FormantPolicy::IndependentShift;
    config.formantSemitones = -4.0f;
    assert(core.configure(config));
    assert(core.formantPolicy() == NativeRobotCore::FormantPolicy::IndependentShift);
    assert(core.setFormantSemitones(-5.0f));
    assert(std::fabs(core.appliedFormantSemitones() + 5.0f) < 0.001f);
    assert(core.formantCompensationEnabled());
    config.formantPolicy = NativeRobotCore::FormantPolicy::CoupledToPitch;
    config.formantSemitones = 0.0f;
    assert(core.configure(config));
    assert(core.formantPolicy() == NativeRobotCore::FormantPolicy::CoupledToPitch);
    assert(!core.setFormantSemitones(1.0f));
}

void testFixedPitchShiftUsesSignalsmithAndLatencyAlignedDry() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate;
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.pitchMode = NativeRobotCore::PitchMode::FixedShift;
    config.pitchSemitones = 7.0f;
    config.formantPolicy = NativeRobotCore::FormantPolicy::IndependentShift;
    config.formantSemitones = -3.0f;
    config.mixPercent = 100.0f;
    assert(core.prepare(config));
    auto audio = makeTone(frames, 1U, sampleRate, 220.0);
    webrc::native::test_alloc::beginTracking();
    processBlocks(core, audio, 1U, {{1U, 17U, 255U, 4096U, 43U, 7U, 513U}});
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == 0U);

    assert(core.currentFrame() == frames);
    assert(core.sourceVoiced());
    assert(core.sourceFrequencyHz() > 215.0f && core.sourceFrequencyHz() < 225.0f);
    assert(core.wetActive());
    assert(core.processingMode() == NativeRobotCore::ProcessingMode::SignalsmithFallback);
    assert(core.fallbackReason() == NativeRobotCore::FallbackReason::IndependentFormantShiftRequiresSignalsmith);
    assert(core.targetMidiNote() > 63 && core.targetMidiNote() < 66);
    assert(std::fabs(core.appliedPitchSemitones() - 7.0f) < 0.001f);
    assert(std::fabs(core.appliedFormantSemitones() + 3.0f) < 0.001f);
    assert(core.formantCompensationEnabled());
    assert(core.trackedFormantBaseHz() > 215.0f && core.trackedFormantBaseHz() < 225.0f);

    const std::size_t begin = static_cast<std::size_t>(core.latencyFrames()) + sampleRate / 3U;
    const std::size_t end = begin + sampleRate / 3U;
    const double expectedHz = 220.0 * std::pow(2.0, 7.0 / 12.0);
    const double targetPower = powerAt(audio, begin, end, 1U, 0U, sampleRate, expectedHz);
    const double sourcePower = powerAt(audio, begin, end, 1U, 0U, sampleRate, 220.0);
    assert(targetPower > 1.0);
    assert(targetPower > sourcePower * 100.0);
    for (unsigned int frame = 0U; frame < core.latencyFrames(); ++frame) {
        assert(std::fabs(audio[frame]) < 1.0e-7f);
    }
    for (float sample : audio) assert(std::isfinite(sample));
}

void testPsolaStableStereoPreservesChannelsWithoutAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate;
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 2U;
    config.pitchMode = NativeRobotCore::PitchMode::FixedShift;
    config.pitchSemitones = -5.0f;
    config.formantPolicy = NativeRobotCore::FormantPolicy::Preserve;
    config.mixPercent = 100.0f;
    assert(core.prepare(config));
    std::vector<float> audio(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float left = static_cast<float>(0.3 * std::sin(2.0 * kPi * 220.0 *
            static_cast<double>(frame) / static_cast<double>(sampleRate)));
        audio[frame * 2U] = left;
        audio[frame * 2U + 1U] = left * 0.5f;
    }
    webrc::native::test_alloc::beginTracking();
    std::size_t offset = 0U;
    constexpr std::array<unsigned int, 7U> blockSizes{{127U, 256U, 1U, 511U, 31U, 1024U, 19U}};
    std::size_t blockIndex = 0U;
    while (offset < frames) {
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            blockSizes[blockIndex % blockSizes.size()], frames - offset));
        assert(core.processInterleaved(audio.data() + offset * 2U, count, 2U));
        offset += count;
        ++blockIndex;
    }
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == 0U);
    assert(core.psolaActive());
    assert(core.processingMode() == NativeRobotCore::ProcessingMode::TdPsola);
    assert(core.currentFrame() == frames);
    const std::size_t begin = static_cast<std::size_t>(core.latencyFrames()) + sampleRate / 3U;
    const std::size_t end = begin + sampleRate / 3U;
    const double leftTarget = 220.0 * std::pow(2.0, -5.0 / 12.0);
    const double leftPower = powerAt(audio, begin, end, 2U, 0U, sampleRate, leftTarget);
    const double rightPower = powerAt(audio, begin, end, 2U, 1U, sampleRate, leftTarget);
    assert(leftPower > 1.0);
    assert(rightPower > 1.0);
    assert(rightPower > leftPower * 0.15 && rightPower < leftPower * 0.35);
    for (const float sample : audio) assert(std::isfinite(sample));
}

void testNearestSemitoneTargetAndOffset() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate * 3U / 2U;
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.pitchMode = NativeRobotCore::PitchMode::NearestSemitone;
    config.pitchSemitones = 7.0f;
    config.formantPolicy = NativeRobotCore::FormantPolicy::Preserve;
    config.mixPercent = 100.0f;
    assert(core.prepare(config));

    // 225 Hz is closer to A3 (220 Hz) than A#3. The +7 semitone offset should
    // target E4 (MIDI 64), with the tracked F0 providing the exact correction.
    auto audio = makeTone(frames, 1U, sampleRate, 225.0);
    processBlocks(core, audio, 1U, {{64U, 128U, 7U, 256U, 4096U, 37U, 511U}});
    assert(core.sourceVoiced());
    assert(core.targetMidiNote() == 64);
    assert(core.appliedPitchSemitones() > 6.0f && core.appliedPitchSemitones() < 7.0f);
    assert(std::fabs(core.appliedFormantSemitones()) < 0.001f);
    assert(core.formantCompensationEnabled());
    assert(core.trackedFormantBaseHz() > 220.0f && core.trackedFormantBaseHz() < 230.0f);
    assert(core.psolaActive());
    assert(core.processingMode() == NativeRobotCore::ProcessingMode::TdPsola);
    assert(core.fallbackReason() == NativeRobotCore::FallbackReason::None);

    const std::size_t begin = static_cast<std::size_t>(core.latencyFrames()) + sampleRate / 3U;
    const std::size_t end = begin + sampleRate / 2U;
    const double targetPower = powerAt(audio, begin, end, 1U, 0U, sampleRate, 329.627556);
    const double inputPower = powerAt(audio, begin, end, 1U, 0U, sampleRate, 225.0);
    assert(targetPower > inputPower * 50.0);
}

void testFormantPolicyChangesHarmonicSpectralEnvelope() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = sampleRate * 2U;
    constexpr std::array<unsigned int, 7U> blocks{{256U, 256U, 256U, 256U, 256U, 256U, 256U}};
    std::array<std::vector<float>, 3U> rendered{};
    const std::array<NativeRobotCore::FormantPolicy, 3U> policies{{
        NativeRobotCore::FormantPolicy::CoupledToPitch,
        NativeRobotCore::FormantPolicy::Preserve,
        NativeRobotCore::FormantPolicy::IndependentShift
    }};
    for (std::size_t policyIndex = 0U; policyIndex < policies.size(); ++policyIndex) {
        NativeRobotCore core;
        NativeRobotCore::Config config{};
        config.sampleRate = sampleRate;
        config.channels = 1U;
        config.pitchMode = NativeRobotCore::PitchMode::FixedShift;
        config.pitchSemitones = 12.0f;
        config.formantPolicy = policies[policyIndex];
        config.formantSemitones = policies[policyIndex] == NativeRobotCore::FormantPolicy::IndependentShift
            ? 6.0f : 0.0f;
        config.mixPercent = 100.0f;
        assert(core.prepare(config));
        rendered[policyIndex] = makeHarmonicVoice(frames, sampleRate, 110.0);
        processBlocks(core, rendered[policyIndex], 1U, blocks);
        assert(core.sourceVoiced());
        assert(core.formantCompensationEnabled() ==
            (policies[policyIndex] != NativeRobotCore::FormantPolicy::CoupledToPitch));
    }

    const std::size_t begin = NativeRobotCore::calculateLatencyFrames(sampleRate) + sampleRate / 2U;
    const std::size_t end = begin + sampleRate / 2U;
    const double coupledOriginalF1 = bandEnergy(rendered[0], begin, end, sampleRate, 450.0, 900.0);
    const double preservedOriginalF1 = bandEnergy(rendered[1], begin, end, sampleRate, 450.0, 900.0);
    const double preservedShiftedF1 = bandEnergy(rendered[1], begin, end, sampleRate, 1800.0, 2400.0);
    const double independentlyShiftedF1 = bandEnergy(rendered[2], begin, end, sampleRate, 1800.0, 2400.0);
    // Broad Goertzel-like bands show that Signalsmith's formant controls change
    // the spectral envelope. This is a signal-level regression, not perceptual
    // quality acceptance or proof of vocal-naturalness.
    assert(preservedOriginalF1 > coupledOriginalF1 * 20.0);
    assert(independentlyShiftedF1 > preservedShiftedF1 * 2.0);
}

void testNearestSemitoneHysteresisAcrossHalfStep() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int halfSecond = sampleRate / 2U;
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.pitchMode = NativeRobotCore::PitchMode::NearestSemitone;
    config.pitchSemitones = 0.0f;
    config.formantPolicy = NativeRobotCore::FormantPolicy::Preserve;
    assert(core.prepare(config));

    std::vector<float> input;
    input.reserve(static_cast<std::size_t>(sampleRate) * 3U);
    double phase = 0.0;
    appendVariableMidiTone(input, halfSecond, sampleRate, 57.40, 0.0, 0.0, phase);
    appendVariableMidiTone(input, sampleRate, sampleRate, 57.50, 0.03, 3.0, phase);
    appendVariableMidiTone(input, halfSecond, sampleRate, 57.60, 0.0, 0.0, phase);
    appendVariableMidiTone(input, halfSecond, sampleRate, 57.48, 0.0, 0.0, phase);
    appendVariableMidiTone(input, halfSecond, sampleRate, 57.40, 0.0, 0.0, phase);

    unsigned int jitterTransitions = 0U;
    const auto processSection = [&core, &input, &jitterTransitions](std::size_t begin,
            std::size_t frames, bool countJitterTransitions) {
        std::size_t offset = begin;
        const std::size_t end = begin + frames;
        int previousTarget = core.targetMidiNote();
        while (offset < end) {
            const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(256U, end - offset));
            assert(core.processInterleaved(input.data() + offset, count, 1U));
            offset += count;
            const int target = core.targetMidiNote();
            if (countJitterTransitions && target != previousTarget) ++jitterTransitions;
            previousTarget = target;
        }
    };

    const std::size_t jitterStart = halfSecond;
    processSection(0U, halfSecond, false);
    assert(core.targetMidiNote() == 57);
    processSection(jitterStart, sampleRate, true);
    assert(core.targetMidiNote() == 57);
    processSection(jitterStart + sampleRate, halfSecond, false);
    assert(core.targetMidiNote() == 58);
    processSection(jitterStart + sampleRate + halfSecond, halfSecond, false);
    assert(core.targetMidiNote() == 58);
    processSection(jitterStart + sampleRate + sampleRate, halfSecond, false);
    assert(core.targetMidiNote() == 57);
    assert(jitterTransitions == 0U);
    assert(core.targetMidiNote() == 57);
}

void testNoWetWithoutTrackedVoiceAndGlobalClock() {
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.channels = 1U;
    config.pitchMode = NativeRobotCore::PitchMode::FixedShift;
    config.pitchSemitones = 12.0f;
    assert(core.prepare(config));
    assert(core.synchronizeFrame(500U));
    assert(core.currentFrame() == 500U);
    assert(!core.synchronizeFrame(499U));

    std::array<float, 8192U> silence{};
    assert(core.processInterleaved(silence.data(), 257U, 1U));
    assert(core.processInterleaved(silence.data() + 257U, 8192U - 257U, 1U));
    assert(!core.sourceVoiced());
    assert(!core.wetActive());
    assert(core.processingMode() == NativeRobotCore::ProcessingMode::SignalsmithFallback);
    assert(core.fallbackReason() == NativeRobotCore::FallbackReason::Unvoiced);
    assert(core.targetMidiNote() == -1);
    assert(core.currentFrame() == 500U + silence.size());
    for (const float sample : silence) assert(sample == 0.0f);
}

void testPsolaStableMonophonicRouteAndAlignedOutput() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate;
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.pitchMode = NativeRobotCore::PitchMode::FixedShift;
    config.pitchSemitones = 7.0f;
    config.formantPolicy = NativeRobotCore::FormantPolicy::Preserve;
    config.mixPercent = 100.0f;
    assert(core.prepare(config));
    auto audio = makeTone(frames, 1U, sampleRate, 220.0);
    processBlocks(core, audio, 1U, {{1U, 17U, 255U, 4096U, 43U, 7U, 513U}});

    assert(core.sourceVoiced());
    assert(core.sourceFrequencyHz() > 215.0f && core.sourceFrequencyHz() < 225.0f);
    assert(core.psolaActive());
    assert(core.fallbackReason() == NativeRobotCore::FallbackReason::None);
    for (unsigned int frame = 0U; frame < core.latencyFrames(); ++frame) assert(std::fabs(audio[frame]) < 1.0e-7f);
    const std::size_t begin = static_cast<std::size_t>(core.latencyFrames()) + sampleRate / 3U;
    const std::size_t end = begin + sampleRate / 3U;
    const double expectedHz = 220.0 * std::pow(2.0, 7.0 / 12.0);
    assert(powerAt(audio, begin, end, 1U, 0U, sampleRate, expectedHz) >
        powerAt(audio, begin, end, 1U, 0U, sampleRate, 220.0) * 50.0);
    for (const float sample : audio) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) < 1.5f);
    }
}

void testPsolaFormantEnvelopeLimitIsMeasuredAndExplicit() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = sampleRate * 2U;
    constexpr double sourceF0 = 220.0;
    constexpr double formantHz = 700.0;
    constexpr float pitchShift = 7.0f;
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.pitchMode = NativeRobotCore::PitchMode::FixedShift;
    config.pitchSemitones = pitchShift;
    config.formantPolicy = NativeRobotCore::FormantPolicy::Preserve;
    config.mixPercent = 100.0f;
    assert(core.prepare(config));
    auto input = makeSingleFormantVoice(frames, sampleRate, sourceF0, formantHz);
    auto rendered = input;
    processBlocks(core, rendered, 1U, {{256U, 127U, 64U, 31U, 511U, 19U, 1024U}});
    assert(core.psolaActive());
    const std::size_t begin = static_cast<std::size_t>(core.latencyFrames()) + sampleRate / 2U;
    const std::size_t end = begin + sampleRate / 2U;
    const double sourceFormantBand = bandEnergy(input, begin - core.latencyFrames(), end - core.latencyFrames(),
        sampleRate, 500.0, 900.0);
    const double outputSourceFormantBand = bandEnergy(rendered, begin, end, sampleRate, 500.0, 900.0);
    const double outputPitchShiftedFormantBand = bandEnergy(rendered, begin, end, sampleRate,
        950.0, 1350.0);
    // This broad-band signal check confirms that PSOLA does not simply multiply
    // every spectral peak by the pitch ratio. It is not a formant-naturalness
    // or listening acceptance test; energy varies with harmonic-grid overlap.
    assert(outputSourceFormantBand > sourceFormantBand * 0.15);
    assert(outputSourceFormantBand > outputPitchShiftedFormantBand * 1.2);
    assert(outputSourceFormantBand < sourceFormantBand * 4.0);
}

void testPsolaExplicitFallbackForLowF0AmbiguousPitchAndFormantControl() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate;
    NativeRobotCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 1U;
    config.pitchMode = NativeRobotCore::PitchMode::FixedShift;
    config.pitchSemitones = 7.0f;
    config.formantPolicy = NativeRobotCore::FormantPolicy::Preserve;
    config.mixPercent = 100.0f;

    NativeRobotCore lowVoice;
    assert(lowVoice.prepare(config));
    auto lowTone = makeTone(frames, 1U, sampleRate, 110.0);
    processBlocks(lowVoice, lowTone, 1U, {{127U, 256U, 64U, 31U, 511U, 19U, 1024U}});
    assert(lowVoice.sourceVoiced());
    assert(lowVoice.sourceFrequencyHz() > 105.0f && lowVoice.sourceFrequencyHz() < 115.0f);
    assert(!lowVoice.psolaActive());
    assert(lowVoice.processingMode() == NativeRobotCore::ProcessingMode::SignalsmithFallback);
    assert(lowVoice.fallbackReason() == NativeRobotCore::FallbackReason::BelowPsolaFrequencyRange);
    assert(lowVoice.wetActive());
    const std::size_t lowBegin = static_cast<std::size_t>(lowVoice.latencyFrames()) + sampleRate / 3U;
    const std::size_t lowEnd = lowBegin + sampleRate / 3U;
    const double shiftedLowHz = 110.0 * std::pow(2.0, 7.0 / 12.0);
    assert(powerAt(lowTone, lowBegin, lowEnd, 1U, 0U, sampleRate, shiftedLowHz) >
        powerAt(lowTone, lowBegin, lowEnd, 1U, 0U, sampleRate, 110.0) * 20.0);

    // Two nearby fundamentals can make a YIN estimate look periodic without
    // proving a single source. The conservative confidence gate must keep this
    // ambiguous case on the pinned fallback, and status reports why.
    NativeRobotCore ambiguous;
    assert(ambiguous.prepare(config));
    std::vector<float> chord(frames);
    for (std::size_t frame = 0U; frame < chord.size(); ++frame) {
        const double time = static_cast<double>(frame) / static_cast<double>(sampleRate);
        chord[frame] = static_cast<float>(0.18 * std::sin(2.0 * kPi * 220.0 * time) +
            0.18 * std::sin(2.0 * kPi * 250.0 * time));
    }
    processBlocks(ambiguous, chord, 1U, {{113U, 257U, 64U, 31U, 509U, 19U, 1021U}});
    assert(ambiguous.sourceVoiced());
    assert(!ambiguous.psolaActive());
    assert(ambiguous.processingMode() == NativeRobotCore::ProcessingMode::SignalsmithFallback);
    assert(ambiguous.fallbackReason() == NativeRobotCore::FallbackReason::AmbiguousOrLowConfidence);
    assert(ambiguous.wetActive());

    // A 3:2 two-tone chord can present a strong 110 Hz subharmonic to YIN.
    // The explicit 130 Hz PSOLA floor keeps that ambiguous chord on the
    // Signalsmith route rather than treating the subharmonic as a mono voice.
    NativeRobotCore relatedChord;
    assert(relatedChord.prepare(config));
    std::vector<float> related(frames);
    for (std::size_t frame = 0U; frame < related.size(); ++frame) {
        const double time = static_cast<double>(frame) / static_cast<double>(sampleRate);
        related[frame] = static_cast<float>(0.18 * std::sin(2.0 * kPi * 220.0 * time) +
            0.18 * std::sin(2.0 * kPi * 330.0 * time));
    }
    processBlocks(relatedChord, related, 1U, {{113U, 257U, 64U, 31U, 509U, 19U, 1021U}});
    assert(relatedChord.sourceVoiced());
    assert(relatedChord.sourceFrequencyHz() < NativeRobotCore::kPsolaMinimumFrequencyHz);
    assert(relatedChord.processingMode() == NativeRobotCore::ProcessingMode::SignalsmithFallback);
    assert(relatedChord.fallbackReason() == NativeRobotCore::FallbackReason::BelowPsolaFrequencyRange);

    NativeRobotCore formant;
    config.formantPolicy = NativeRobotCore::FormantPolicy::IndependentShift;
    config.formantSemitones = 3.0f;
    assert(formant.prepare(config));
    auto formantVoice = makeTone(frames, 1U, sampleRate, 220.0);
    processBlocks(formant, formantVoice, 1U, {{256U, 127U, 64U, 31U, 511U, 19U, 1024U}});
    assert(formant.sourceVoiced());
    assert(formant.processingMode() == NativeRobotCore::ProcessingMode::SignalsmithFallback);
    assert(formant.fallbackReason() == NativeRobotCore::FallbackReason::IndependentFormantShiftRequiresSignalsmith);
}

void testStereoAndCallbackNoAllocations() {
    constexpr unsigned int sampleRate = 48000U;
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.sampleRate = sampleRate;
    config.channels = 2U;
    config.pitchMode = NativeRobotCore::PitchMode::FixedShift;
    config.pitchSemitones = -5.0f;
    config.formantPolicy = NativeRobotCore::FormantPolicy::IndependentShift;
    config.formantSemitones = 2.0f;
    config.mixPercent = 65.0f;
    assert(core.prepare(config));
    std::array<float, 512U * 2U> block{};
    for (std::size_t frame = 0U; frame < 512U; ++frame) {
        const float sample = static_cast<float>(0.3 * std::sin(2.0 * kPi * 220.0 *
            static_cast<double>(frame) / static_cast<double>(sampleRate)));
        block[frame * 2U] = sample;
        block[frame * 2U + 1U] = sample;
    }

    webrc::native::test_alloc::beginTracking();
    const bool changedPitch = core.setPitchSemitones(-6.0f);
    const bool changedFormant = core.setFormantSemitones(3.0f);
    const bool changedMode = core.setPitchMode(NativeRobotCore::PitchMode::NearestSemitone);
    const bool changedMix = core.setMixPercent(60.0f);
    const bool processedA = core.processInterleaved(block.data(), 127U, 2U);
    const bool processedB = core.processInterleaved(block.data() + 127U * 2U, 385U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(changedPitch && changedFormant && changedMode && changedMix && processedA && processedB);
    assert(webrc::native::test_alloc::count() == 0U);
    assert(core.currentFrame() == 512U);
    for (const float sample : block) assert(std::isfinite(sample));
    assert(!core.processInterleaved(block.data(), 1U, 1U)); // prepared channel count is strict
}

void testOfficialFixedNote() {
    NativeRobotCore core;
    NativeRobotCore::Config config{};
    config.sampleRate = 16000U; config.channels = 1U; config.mixPercent = 100.0f;
    assert(core.prepare(config));
    assert(!core.setFixedMidiNote(59U));
    assert(!core.setFixedMidiNote(72U));
    assert(core.setFixedMidiNote(60U));
    for (double frequency : {220.0, 330.0}) {
        auto tone = makeTone(16000U, 1U, 16000U, frequency);
        for (unsigned int f = 0U; f < 16000U; f += 64U) assert(core.processInterleaved(tone.data() + f, 64U, 1U));
        assert(core.targetMidiNote() == 60);
        assert(std::fabs(core.sourceMidiNote() + core.appliedPitchSemitones() - 60.0f) < 0.01f);
    }
    test_alloc::beginTracking();
    assert(core.setFixedMidiNote(71U));
    assert(core.setFormantSemitones(12.0f));
    test_alloc::endTracking();
    assert(test_alloc::count() == 0U);
    assert(core.targetMidiNote() == 71);
    assert(core.setPitchSemitones(0.0f)); // Existing legacy control resumes nearest-note behavior.
    assert(core.targetMidiNote() == 64);
}

} // namespace

int main() {
    testOfficialFixedNote();
    testConfigAndExplicitFormantPolicies();
    testFixedPitchShiftUsesSignalsmithAndLatencyAlignedDry();
    testNearestSemitoneTargetAndOffset();
    testFormantPolicyChangesHarmonicSpectralEnvelope();
    testNearestSemitoneHysteresisAcrossHalfStep();
    testNoWetWithoutTrackedVoiceAndGlobalClock();
    testPsolaStableMonophonicRouteAndAlignedOutput();
    testPsolaFormantEnvelopeLimitIsMeasuredAndExplicit();
    testPsolaStableStereoPreservesChannelsWithoutAllocation();
    testPsolaExplicitFallbackForLowF0AmbiguousPitchAndFormantControl();
    testStereoAndCallbackNoAllocations();
    return 0;
}
