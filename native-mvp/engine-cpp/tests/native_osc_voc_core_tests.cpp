#include "native_osc_voc_core.hpp"
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
constexpr double kPi = 3.141592653589793238462643383279502884;

[[nodiscard]] float makeModulator(std::size_t frame, double frequency = 250.0) {
    return 0.45f * static_cast<float>(std::sin(
        2.0 * kPi * frequency * static_cast<double>(frame) / static_cast<double>(kSampleRate)));
}

template <std::size_t N>
void fillModulator(std::array<float, N>& samples, double frequency = 250.0) {
    for (std::size_t frame = 0U; frame < N; ++frame) {
        samples[frame] = makeModulator(frame, frequency);
    }
}

template <std::size_t N>
[[nodiscard]] double rms(const std::array<float, N>& samples, std::size_t first, std::size_t end) {
    double sum = 0.0;
    for (std::size_t frame = first; frame < end; ++frame) {
        const double value = static_cast<double>(samples[frame]);
        sum += value * value;
    }
    return std::sqrt(sum / static_cast<double>(end - first));
}

template <std::size_t N>
[[nodiscard]] double projectedAmplitude(const std::array<float, N>& samples, std::size_t first,
                                        std::size_t end, double frequency,
                                        std::uint32_t sampleRate = kSampleRate) {
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t frame = first; frame < end; ++frame) {
        const double phase = 2.0 * kPi * frequency * static_cast<double>(frame - first) /
            static_cast<double>(sampleRate);
        real += static_cast<double>(samples[frame]) * std::cos(phase);
        imaginary -= static_cast<double>(samples[frame]) * std::sin(phase);
    }
    return 2.0 * std::hypot(real, imaginary) / static_cast<double>(end - first);
}

template <std::size_t N>
void renderSustainedNote(NativeOscVocWaveform waveform, int note, int octave,
                         std::array<float, N>& output, float pulseWidth = 0.5f,
                         int velocity = 127) {
    NativeOscVocCore core;
    NativeOscVocConfig config;
    config.waveform = waveform;
    config.octaveShift = octave;
    config.pulseWidth = pulseWidth;
    config.wetMix = 1.0f;
    assert(core.setConfig(config));
    assert(core.prepare(kSampleRate));
    assert(core.scheduleMidiNoteOn(0, note, velocity, 0U));
    std::array<float, N> input{};
    fillModulator(input);
    assert(core.processBlock(input.data(), output.data(), N));
}

void testPitchOctaveVelocityAndWaveformSpectrum() {
    constexpr std::size_t frames = 32768U;
    std::array<float, frames> noteA4{};
    std::array<float, frames> noteA5{};
    std::array<float, frames> noteA4OctaveUp{};
    std::array<float, frames> noteA4SoftVelocity{};
    std::array<float, frames> saw{};
    std::array<float, frames> square{};
    std::array<float, frames> pulse{};
    renderSustainedNote(NativeOscVocWaveform::Saw, 69, 0, noteA4);
    renderSustainedNote(NativeOscVocWaveform::Saw, 81, 0, noteA5);
    renderSustainedNote(NativeOscVocWaveform::Saw, 69, 1, noteA4OctaveUp);
    renderSustainedNote(NativeOscVocWaveform::Saw, 69, 0, noteA4SoftVelocity, 0.5f, 64);
    constexpr std::size_t analysisStart = 12000U;
    const double a4At440 = projectedAmplitude(noteA4, analysisStart, frames, 440.0);
    const double a4At880 = projectedAmplitude(noteA4, analysisStart, frames, 880.0);
    const double a5At880 = projectedAmplitude(noteA5, analysisStart, frames, 880.0);
    const double octaveAt880 = projectedAmplitude(noteA4OctaveUp, analysisStart, frames, 880.0);
    assert(a4At440 > a4At880 * 1.5);
    assert(a5At880 > projectedAmplitude(noteA5, analysisStart, frames, 440.0) * 1.5);
    assert(std::fabs(a5At880 - octaveAt880) < (a5At880 * 1.0e-4));
    const double velocityRatio = projectedAmplitude(noteA4SoftVelocity, analysisStart, frames, 440.0) / a4At440;
    assert(std::fabs(velocityRatio - (64.0 / 127.0)) < 0.04);

    renderSustainedNote(NativeOscVocWaveform::Saw, 69, 0, saw);
    renderSustainedNote(NativeOscVocWaveform::Square, 69, 0, square);
    renderSustainedNote(NativeOscVocWaveform::Pulse, 69, 0, pulse, 0.25f);
    const double sawSecond = projectedAmplitude(saw, analysisStart, frames, 880.0);
    const double squareSecond = projectedAmplitude(square, analysisStart, frames, 880.0);
    const double squareThird = projectedAmplitude(square, analysisStart, frames, 1320.0);
    const double sawThird = projectedAmplitude(saw, analysisStart, frames, 1320.0);
    assert(sawSecond > squareSecond * 1.25);
    assert(squareThird > sawThird * 1.15);
    assert(std::fabs(rms(saw, analysisStart, frames) - rms(square, analysisStart, frames)) > 1.0e-4);
    assert(std::fabs(rms(square, analysisStart, frames) - rms(pulse, analysisStart, frames)) > 1.0e-4);
}

void testNoteOffReleaseAndSilence() {
    constexpr std::size_t frames = 96000U;
    NativeOscVocCore core;
    assert(core.prepare(kSampleRate));
    assert(core.scheduleMidiNoteOn(0, 60, 127, 0U));
    assert(core.scheduleMidiNoteOff(0, 60, 4800U));
    std::array<float, frames> input{};
    std::array<float, frames> output{};
    fillModulator(input, 220.0);
    assert(core.processBlock(input.data(), output.data(), frames));
    const double beforeNoteOff = rms(output, 1800U, 4500U);
    const double afterRelease = rms(output, 60000U, 72000U);
    const double finalTail = rms(output, 84000U, frames);
    assert(beforeNoteOff > 0.01);
    assert(afterRelease < beforeNoteOff * 0.01);
    assert(finalTail < 1.0e-5);
    assert(core.activeVoiceCount() == 0U);
    assert(core.queuedEventCount() == 0U);
}

void testAbsoluteEventsAcrossVariableBlocks() {
    constexpr std::size_t frames = 2048U;
    NativeOscVocCore whole;
    NativeOscVocCore chunked;
    NativeOscVocCore samplewise;
    assert(whole.prepare(kSampleRate, 1000U));
    assert(chunked.prepare(kSampleRate, 1000U));
    assert(samplewise.prepare(kSampleRate, 1000U));
    const auto queueEvents = [](NativeOscVocCore& core) {
        assert(core.scheduleMidiNoteOn(0, 60, 110, 1000U));
        assert(core.scheduleMidiNoteOff(0, 60, 1133U));
        assert(core.scheduleMidiNoteOn(0, 67, 80, 1250U));
        assert(core.scheduleMidiNoteOff(0, 67, 1411U));
    };
    queueEvents(whole);
    queueEvents(chunked);
    queueEvents(samplewise);

    std::array<float, frames> input{};
    std::array<float, frames> wholeOutput{};
    std::array<float, frames> chunkedOutput{};
    fillModulator(input, 300.0);
    assert(whole.processBlock(input.data(), wholeOutput.data(), frames));

    constexpr std::array<std::size_t, 6U> chunks{{17U, 31U, 64U, 5U, 255U, 128U}};
    std::size_t cursor = 0U;
    std::size_t chunkIndex = 0U;
    while (cursor < frames) {
        const std::size_t count = std::min(chunks[chunkIndex % chunks.size()], frames - cursor);
        assert(chunked.processBlock(input.data() + cursor, chunkedOutput.data() + cursor, count));
        cursor += count;
        ++chunkIndex;
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        assert(std::fabs(wholeOutput[frame] - chunkedOutput[frame]) < 1.0e-7f);
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        assert(std::fabs(wholeOutput[frame] - samplewise.processSample(input[frame])) < 1.0e-7f);
    }
    assert(whole.currentFrame() == 1000U + frames);
    assert(chunked.currentFrame() == 1000U + frames);
    assert(samplewise.currentFrame() == 1000U + frames);

    NativeOscVocCore synchronized;
    assert(synchronized.prepare(kSampleRate, 200U));
    assert(!synchronized.synchronizeFrame(199U));
    assert(synchronized.synchronizeFrame(250U));
    assert(synchronized.scheduleMidiNoteOn(0, 60, 100, 260U));
    assert(synchronized.synchronizeFrame(261U)); // A skipped path block drops/counts the stale event.
    assert(synchronized.queuedEventCount() == 0U);
    assert(synchronized.lateEventCount() == 1U);
    assert(synchronized.synchronizeFrame(261U));
    assert(synchronized.scheduleMidiNoteOn(0, 60, 100, 264U));
    std::array<float, 4U> shortInput{};
    std::array<float, 4U> shortOutput{};
    assert(synchronized.processBlock(shortInput.data(), shortOutput.data(), shortInput.size()));
    assert(synchronized.currentFrame() == 265U);
    assert(synchronized.queuedEventCount() == 0U);
}

void testInvalidControlsMidiEventsAndQueueOverflow() {
    NativeOscVocCore core;
    assert(!core.scheduleMidiNoteOn(0, 60, 100, 0U));
    NativeOscVocCore invalidClock;
    assert(!invalidClock.prepare(kSampleRate, std::numeric_limits<std::uint64_t>::max()));
    assert(core.prepare(kSampleRate));

    assert(!core.setParameter("waveform", 3.0f));
    assert(!core.setParameter("waveform", 1.5f));
    assert(!core.setParameter("channel", -1.0f));
    assert(!core.setParameter("channel", 16.0f));
    assert(!core.setParameter("octave", 25.0f));
    assert(!core.setParameter("octave", 0.5f));
    assert(!core.setParameter("pulseWidth", std::numeric_limits<float>::quiet_NaN()));
    assert(!core.setParameter("mix", 100.1f));
    assert(!core.setParameter("unknown", 1.0f));
    assert(core.setParameter("waveform", 2.0f));
    assert(core.setParameter("octave", -2.0f));
    assert(core.setParameter("pulseWidth", 0.25f));
    assert(core.setParameter("mix", 75.0f, 16U));
    assert(!core.scheduleMidiNoteOn(-1, 60, 100, 0U));
    assert(!core.scheduleMidiNoteOn(16, 60, 100, 0U));
    assert(!core.scheduleMidiNoteOn(0, -1, 100, 0U));
    assert(!core.scheduleMidiNoteOn(0, 128, 100, 0U));
    assert(!core.scheduleMidiNoteOn(0, 60, -1, 0U));
    assert(!core.scheduleMidiNoteOn(0, 60, 128, 0U));
    assert(!core.scheduleMidiNoteOn(0, 60, 100, std::numeric_limits<std::uint64_t>::max()));
    assert(!core.scheduleMidiNoteOn(1, 60, 100, 0U));
    assert(core.setParameter("octave", 24.0f));
    assert(!core.scheduleMidiNoteOn(0, 127, 100, 0U)); // The shifted pitch is above this sample rate's oscillator ceiling.

    // MIDI channel selection is zero-based, and mismatched valid channels are rejected.
    assert(core.setParameter("octave", 0.0f));
    assert(core.setParameter("channel", 15.0f));
    assert(core.scheduleMidiNoteOn(15, 60, 127, 0U));
    assert(core.scheduleMidiNoteOn(15, 60, 0, 1U)); // Velocity-zero note-on means note-off.
    assert(!core.scheduleMidiNoteOff(0, 60, 2U));
    assert(!core.scheduleMidiNoteOff(15, 60, 0U)); // Out-of-order timestamp.
    std::array<float, 2U> tinyInput{{0.25f, 0.25f}};
    std::array<float, 2U> tinyOutput{};
    assert(core.processBlock(tinyInput.data(), tinyOutput.data(), tinyInput.size()));
    assert(!core.scheduleMidiNoteOff(15, 60, 0U));
    assert(!core.scheduleMidiNoteOff(15, 60, 1U)); // This timestamp is now stale.
    assert(core.lateEventCount() == 2U);
    assert(core.rejectedEventCount() >= 10U);

    NativeOscVocCore orderCore;
    assert(orderCore.prepare(kSampleRate));
    assert(orderCore.scheduleMidiNoteOn(0, 60, 100, 20U));
    assert(!orderCore.scheduleMidiNoteOff(0, 60, 19U));
    assert(orderCore.rejectedEventCount() == 1U);
    assert(!orderCore.processInPlace(nullptr, 1U, 3U));

    NativeOscVocCore overflowCore;
    assert(overflowCore.prepare(kSampleRate));
    for (std::size_t event = 0U; event < kNativeOscVocEventQueueCapacity; ++event) {
        assert(overflowCore.scheduleMidiNoteOn(0, 60, 100,
            static_cast<std::uint64_t>(event)));
    }
    assert(overflowCore.queuedEventCount() == kNativeOscVocEventQueueCapacity);
    assert(!overflowCore.scheduleMidiNoteOff(0, 60,
        static_cast<std::uint64_t>(kNativeOscVocEventQueueCapacity)));
    assert(overflowCore.queuedEventCount() == kNativeOscVocEventQueueCapacity);
    assert(overflowCore.overflowEventCount() == 1U);
}

void testFiniteStereoInPlaceAndCallbackAllocationFree() {
    constexpr std::size_t frames = 1024U;
    NativeOscVocCore core;
    assert(core.prepare(kSampleRate));
    assert(core.scheduleMidiNoteOn(0, 69, 100, 0U));

    std::array<float, frames * 2U> stereo{};
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        stereo[frame * 2U] = makeModulator(frame);
        stereo[(frame * 2U) + 1U] = -makeModulator(frame, 180.0);
    }
    stereo[4U] = std::numeric_limits<float>::infinity();
    stereo[5U] = std::numeric_limits<float>::quiet_NaN();
    stereo[6U] = std::numeric_limits<float>::max();
    stereo[7U] = -std::numeric_limits<float>::max();

    const std::size_t before = test_alloc::count();
    test_alloc::beginTracking();
    assert(core.processInPlace(stereo.data(), frames, 2U));
    test_alloc::endTracking();
    assert(test_alloc::count() == before);
    for (const float sample : stereo) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 8.0f);
    }
    assert(!core.processInPlace(stereo.data(), frames, 3U));

    NativeOscVocCore stereoOutCore;
    assert(stereoOutCore.prepare(kSampleRate));
    assert(stereoOutCore.scheduleMidiNoteOn(0, 69, 100, 0U));
    std::array<float, frames * 2U> input{};
    std::array<float, frames * 2U> output{};
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = makeModulator(frame);
        input[(frame * 2U) + 1U] = makeModulator(frame, 180.0);
    }
    assert(stereoOutCore.processStereo(input.data(), output.data(), frames));
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        assert(std::isfinite(output[frame * 2U]));
        assert(std::isfinite(output[(frame * 2U) + 1U]));
        assert(std::fabs(output[frame * 2U] - output[(frame * 2U) + 1U]) < 1.0e-6f);
    }

    NativeOscVocCore monoInPlace;
    assert(monoInPlace.prepare(kSampleRate));
    assert(monoInPlace.scheduleMidiNoteOn(0, 69, 127, 0U));
    std::array<float, frames> mono{};
    fillModulator(mono);
    assert(monoInPlace.processInPlace(mono.data(), frames, 1U));
    for (const float sample : mono) {
        assert(std::isfinite(sample));
    }
}

} // namespace

int main() {
    testPitchOctaveVelocityAndWaveformSpectrum();
    testNoteOffReleaseAndSilence();
    testAbsoluteEventsAcrossVariableBlocks();
    testInvalidControlsMidiEventsAndQueueOverflow();
    testFiniteStereoInPlaceAndCallbackAllocationFree();
    return 0;
}
