#include "looper_core.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <vector>

using namespace webrc::native;

int main() {
    assert(LooperCore::maximumDurationSecondsForBudget(48000U, 2U, 5U) == 300U);
    assert(LooperCore::maximumDurationSecondsForBudget(96000U, 2U, 5U) == 209U);
    assert(LooperCore::maximumDurationSecondsForBudget(192000U, 2U, 5U) == 104U);
    assert(LooperCore::maximumDurationSecondsForBudget(
        96000U, 2U, 5U, 300U, 1536ULL * 1024ULL * 1024ULL) == 300U);
    assert(LooperCore::maximumDurationSecondsForBudget(
        192000U, 2U, 5U, 300U, 2560ULL * 1024ULL * 1024ULL) == 300U);
    assert(LooperCore::maximumDurationSecondsForBudget(192001U, 2U, 5U) == 0U);
    assert(LooperCore::maximumDurationSecondsForBudget(48000U, 2U, 0U) == 0U);
    LooperCore looper(48000, 10);
    assert(looper.capacityFrames() == 48000U * 10U);
    assert(looper.storageBytes() == 48000U * 10U * sizeof(float));
    const auto preparedStorageBytes = looper.storageBytes();
    std::vector<float> input(256, 0.25f);
    std::vector<float> output(512, 0.0f);
    std::vector<float> playback(512, -9.0f);

    looper.applyCommand({CommandType::Record, false});
    auto stats = looper.process(input.data(), output.data(), 256, 1, 2);
    assert(stats.state == LooperState::Recording);
    assert(looper.storageBytes() == preparedStorageBytes);

    looper.applyCommand({CommandType::StopRecordOrPlayback, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Stopped);

    std::vector<float> loopSnapshot(256, -1.0f);
    std::size_t copiedFrames = 0U;
    assert(looper.copyFinalizedLoopSnapshot(loopSnapshot.data(), loopSnapshot.size(), copiedFrames));
    assert(copiedFrames == input.size());
    assert(std::all_of(loopSnapshot.begin(), loopSnapshot.end(), [](float sample) { return sample == 0.25f; }));
    assert(!looper.copyFinalizedLoopSnapshot(loopSnapshot.data(), loopSnapshot.size() - 1U, copiedFrames));
    assert(copiedFrames == 0U);

    looper.applyCommand({CommandType::Play, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2, playback.data());
    assert(stats.state == LooperState::Playing);
    assert(output[0] == 0.25f && output[1] == 0.25f);
    assert(playback[0] == 0.25f && playback[1] == 0.25f);

    // Playback advances only the playhead, so a caller with the Native host's
    // callback pin can still copy an identical finalized loop while playing.
    std::fill(loopSnapshot.begin(), loopSnapshot.end(), -1.0f);
    assert(looper.copyFinalizedLoopSnapshot(loopSnapshot.data(), loopSnapshot.size(), copiedFrames));
    assert(copiedFrames == input.size());
    assert(std::all_of(loopSnapshot.begin(), loopSnapshot.end(), [](float sample) { return sample == 0.25f; }));

    looper.applyCommand({CommandType::SetMonitoring, true});
    std::fill(input.begin(), input.end(), -0.1f);
    stats = looper.process(input.data(), output.data(), 16, 1, 2, playback.data());
    assert(output[0] > 0.14f && output[0] < 0.16f);
    assert(playback[0] == 0.25f && playback[1] == 0.25f);

    looper.applyCommand({CommandType::ToggleOverdub, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2, playback.data());
    assert(stats.state == LooperState::Overdubbing);
    assert(playback[0] == 0.25f && playback[1] == 0.25f);
    assert(output[0] > 0.14f && output[0] < 0.16f);

    looper.applyCommand({CommandType::ToggleOverdub, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Playing);

    looper.applyCommand({CommandType::Clear, false});
    stats = looper.process(input.data(), output.data(), 16, 1, 2);
    assert(stats.state == LooperState::Empty);
    assert(!looper.copyFinalizedLoopSnapshot(loopSnapshot.data(), loopSnapshot.size(), copiedFrames));
    assert(copiedFrames == 0U);

    // Stereo loop storage keeps left/right samples independent and exports a
    // frame-counted interleaved stereo snapshot.
    LooperCore stereo(48000U, 1U, 2U);
    assert(stereo.capacityFrames() == 48000U);
    assert(stereo.storageBytes() == 48000U * 2U * sizeof(float));
    const std::array<float, 8> stereoInput{{0.1f, -0.1f, 0.2f, -0.2f, 0.3f, -0.3f, 0.4f, -0.4f}};
    std::array<float, 8> stereoOutput{};
    std::array<float, 8> stereoSnapshot{};
    stereo.applyCommand({CommandType::Record, false});
    (void)stereo.process(stereoInput.data(), stereoOutput.data(), 4U, 2U, 2U);
    stereo.applyCommand({CommandType::StopRecordOrPlayback, false});
    std::size_t stereoCopiedFrames = 0U;
    assert(stereo.copyFinalizedStereoLoopSnapshot(stereoSnapshot.data(), 4U, stereoCopiedFrames));
    assert(stereoCopiedFrames == 4U);
    assert(stereoSnapshot == stereoInput);
    stereo.applyCommand({CommandType::Play, false});
    (void)stereo.process(nullptr, stereoOutput.data(), 4U, 0U, 2U);
    assert(stereoOutput == stereoInput);

    // Tiny one-second capacity makes the duration guard testable without
    // allocating the full five-minute Native maximum. Extra callback frames
    // at capacity must not extend or overwrite the finalized loop.
    LooperCore bounded(2U, 1U, 2U);
    const std::array<float, 6> beyondCapacity{{0.11f, -0.11f, 0.22f, -0.22f, 0.33f, -0.33f}};
    std::array<float, 10> boundedOutput{};
    std::array<float, 4> boundedSnapshot{};
    bounded.applyCommand({CommandType::Record, false});
    (void)bounded.process(beyondCapacity.data(), boundedOutput.data(), 3U, 2U, 2U);
    (void)bounded.process(beyondCapacity.data(), boundedOutput.data(), 2U, 2U, 2U);
    bounded.applyCommand({CommandType::StopRecordOrPlayback, false});
    assert(bounded.state() == LooperState::Stopped);
    assert(bounded.loopLengthSamples() == 2U);
    std::size_t boundedCopiedFrames = 0U;
    assert(bounded.copyFinalizedStereoLoopSnapshot(boundedSnapshot.data(), 2U, boundedCopiedFrames));
    assert(boundedCopiedFrames == 2U);
    assert((boundedSnapshot == std::array<float, 4>{{0.11f, -0.11f, 0.22f, -0.22f}}));

    // Prepared capacity is a fixed, explicit 300-second/192-kHz maximum. An
    // over-limit request is rejected without replacing a working buffer.
    const auto boundedStorageBytes = bounded.storageBytes();
    const auto boundedCapacityFrames = bounded.capacityFrames();
    assert(!bounded.prepare(192001U, 1U, 2U));
    assert(!bounded.prepare(48000U, LooperCore::kMaximumLoopSeconds + 1U, 2U));
    assert(bounded.storageBytes() == boundedStorageBytes);
    assert(bounded.capacityFrames() == boundedCapacityFrames);

    // Source-aware loop transport stays inert by default, reports unsupported
    // record/overdub states explicitly, and leaves overdub writes on the
    // canonical playhead.
    LooperCore sourceAware(8000U, 1U, 1U);
    std::array<float, 8000> sourceRamp{};
    std::array<float, 8000> sourceOutput{};
    std::array<float, 8000> sourcePlayback{};
    for (std::size_t frame = 0U; frame < sourceRamp.size(); ++frame) {
        sourceRamp[frame] = static_cast<float>(frame) * 0.000025f;
    }
    LoopTransportConfig beatShift;
    beatShift.mode = LoopTransportMode::BeatShift;
    beatShift.beatOffsetBeats = 0.1f;
    beatShift.bpm = 120.0f;
    beatShift.crossfadeMs = 5.0f;
    assert(LooperCore::validLoopTransportConfig(beatShift));
    auto invalidBeatShift = beatShift;
    invalidBeatShift.crossfadeMs = 10.1f;
    assert(!sourceAware.setLoopTransportConfig(invalidBeatShift));
    assert(sourceAware.loopTransportStatus() == LoopTransportStatus::Disabled);
    assert(sourceAware.setLoopTransportConfig(beatShift));
    auto sourceStats = sourceAware.process(nullptr, sourceOutput.data(), 1U, 0U, 1U, sourcePlayback.data());
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::WaitingForLoop);
    sourceAware.applyCommand({CommandType::Record, false});
    sourceStats = sourceAware.process(sourceRamp.data(), sourceOutput.data(), 8000U, 1U, 1U, sourcePlayback.data());
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::UnsupportedRecording);
    sourceAware.applyCommand({CommandType::StopRecordOrPlayback, false});
    sourceStats = sourceAware.process(nullptr, sourceOutput.data(), 1U, 0U, 1U, sourcePlayback.data());
    assert(sourceStats.state == LooperState::Stopped);
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::WaitingForPlayback);
    sourceAware.applyCommand({CommandType::Play, false});
    sourceStats = sourceAware.process(nullptr, sourceOutput.data(), 40U, 0U, 1U, sourcePlayback.data());
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::Active);
    // The signed +0.1 beat shift reads +400 frames at 8 kHz / 120 BPM. It
    // crossfades from the canonical head at start of playback over 40 frames.
    assert(std::fabs(sourcePlayback[0] - sourceRamp[0U]) < 0.00001f);
    assert(std::fabs(sourcePlayback[39U] - sourceRamp[439U]) < 0.0001f);

    // Parameter jumps use an equal-power crossfade of exactly the configured
    // 5 ms (40 frames); the old and new head positions remain loop-relative.
    beatShift.beatOffsetBeats = -0.1f;
    assert(sourceAware.setLoopTransportConfig(beatShift));
    sourceStats = sourceAware.process(nullptr, sourceOutput.data(), 40U, 0U, 1U, sourcePlayback.data());
    assert(std::fabs(sourcePlayback[39U] - sourceRamp[7679U]) < 0.0001f);
    assert(sourcePlayback[0] > sourceRamp[439U]);
    assert(sourcePlayback[0] < sourceRamp[7679U]);

    // Integer read-head wrap remains phase-continuous for a periodic source;
    // Beat Shift changes pointer position but preserves the loop period.
    LooperCore seam(8000U, 1U, 1U);
    std::array<float, 1000> periodicLoop{};
    std::array<float, 1000> seamRecordOutput{};
    std::array<float, 602> seamOutput{};
    for (std::size_t frame = 0U; frame < periodicLoop.size(); ++frame) {
        periodicLoop[frame] = std::sin(static_cast<float>(frame) * 6.2831853071795864769f /
                                       static_cast<float>(periodicLoop.size()));
    }
    seam.applyCommand({CommandType::Record, false});
    (void)seam.process(periodicLoop.data(), seamRecordOutput.data(), static_cast<unsigned int>(periodicLoop.size()), 1U, 1U);
    seam.applyCommand({CommandType::StopRecordOrPlayback, false});
    beatShift.beatOffsetBeats = 0.1f;
    assert(seam.setLoopTransportConfig(beatShift));
    seam.applyCommand({CommandType::Play, false});
    (void)seam.process(nullptr, seamOutput.data(), static_cast<unsigned int>(seamOutput.size()), 0U, 1U);
    // +400 frames wraps from loop frame 999 to frame 0 at output frame 600.
    assert(std::fabs(seamOutput[600U] - seamOutput[599U]) < 0.02f);

    // Fractional Beat Shift positions use the shared Native four-point
    // Lagrange interpolator. A 0.1-beat shift at 123 BPM is 390.2439 samples;
    // the 1 kHz loop tone should stay within 2% amplitude of its 0.5 input
    // level after the short startup crossfade has completed.
    LooperCore fractionalBeatShift(8000U, 1U, 1U);
    std::array<float, 8000> fractionalTone{};
    std::array<float, 8000> fractionalOutput{};
    std::array<float, 8000> fractionalPlayback{};
    constexpr double fractionalToneHz = 1000.0;
    constexpr double fractionalSampleRate = 8000.0;
    constexpr double fractionalPi = 3.14159265358979323846;
    for (std::size_t frame = 0U; frame < fractionalTone.size(); ++frame) {
        fractionalTone[frame] = 0.5f * static_cast<float>(std::sin(
            2.0 * fractionalPi * fractionalToneHz * static_cast<double>(frame) / fractionalSampleRate));
    }
    fractionalBeatShift.applyCommand({CommandType::Record, false});
    (void)fractionalBeatShift.process(fractionalTone.data(), fractionalOutput.data(),
        static_cast<unsigned int>(fractionalTone.size()), 1U, 1U);
    fractionalBeatShift.applyCommand({CommandType::StopRecordOrPlayback, false});
    LoopTransportConfig fractionalBeatConfig;
    fractionalBeatConfig.mode = LoopTransportMode::BeatShift;
    fractionalBeatConfig.beatOffsetBeats = 0.1f;
    fractionalBeatConfig.bpm = 123.0f;
    fractionalBeatConfig.crossfadeMs = 1.0f;
    const double requestedOffset = fractionalSampleRate * 60.0 / 123.0 * 0.1;
    const double offsetFraction = requestedOffset - std::floor(requestedOffset);
    assert(offsetFraction > 0.2 && offsetFraction < 0.3);
    assert(fractionalBeatShift.setLoopTransportConfig(fractionalBeatConfig));
    fractionalBeatShift.applyCommand({CommandType::Play, false});
    (void)fractionalBeatShift.process(nullptr, fractionalOutput.data(),
        static_cast<unsigned int>(fractionalOutput.size()), 0U, 1U, fractionalPlayback.data());
    constexpr std::size_t amplitudeStart = 64U;
    constexpr std::size_t amplitudeFrames = 4000U;
    double toneSineProjection = 0.0;
    double toneCosineProjection = 0.0;
    for (std::size_t frame = 0U; frame < amplitudeFrames; ++frame) {
        const double phase = 2.0 * fractionalPi * fractionalToneHz *
            static_cast<double>(frame) / fractionalSampleRate;
        const double sample = fractionalPlayback[amplitudeStart + frame];
        toneSineProjection += sample * std::sin(phase);
        toneCosineProjection += sample * std::cos(phase);
    }
    const double fractionalToneAmplitude = 2.0 * std::sqrt(
        toneSineProjection * toneSineProjection + toneCosineProjection * toneCosineProjection) /
        static_cast<double>(amplitudeFrames);
    assert(fractionalToneAmplitude > 0.49 && fractionalToneAmplitude < 0.51);

    sourceAware.applyCommand({CommandType::ToggleOverdub, false});
    const std::array<float, 1> overdubInput{{0.25f}};
    sourceStats = sourceAware.process(overdubInput.data(), sourceOutput.data(), 1U, 1U, 1U, sourcePlayback.data());
    assert(sourceStats.loopTransportStatus == LoopTransportStatus::UnsupportedOverdubbing);
    // Canonical playhead is at frame 80; transport is excluded from both the
    // playback tap used by overdub and the data written back to the loop.
    assert(std::fabs(sourcePlayback[0] - sourceRamp[80U]) < 0.00001f);
    std::array<float, 8000> afterOverdub{};
    std::size_t afterOverdubFrames = 0U;
    sourceAware.applyCommand({CommandType::StopRecordOrPlayback, false});
    assert(sourceAware.copyFinalizedLoopSnapshot(afterOverdub.data(), afterOverdub.size(), afterOverdubFrames));
    assert(afterOverdubFrames == sourceRamp.size());
    assert(std::fabs(afterOverdub[80U] - (sourceRamp[80U] + overdubInput[0])) < 0.00001f);

    // VINYL FLICK's second-order platter approaches a 2x target and the
    // stored-loop reader consequently crosses this one-cycle loop faster.
    LooperCore vinyl(8000U, 1U, 1U);
    std::array<float, 1000> vinylLoop{};
    std::array<float, 8000> vinylOutput{};
    for (std::size_t frame = 0U; frame < vinylLoop.size(); ++frame) {
        vinylLoop[frame] = std::sin(static_cast<float>(frame) * 6.2831853071795864769f /
                                    static_cast<float>(vinylLoop.size()));
    }
    vinyl.applyCommand({CommandType::Record, false});
    (void)vinyl.process(vinylLoop.data(), vinylOutput.data(), static_cast<unsigned int>(vinylLoop.size()), 1U, 1U);
    vinyl.applyCommand({CommandType::StopRecordOrPlayback, false});
    LoopTransportConfig vinylFlick;
    vinylFlick.mode = LoopTransportMode::VinylFlick;
    vinylFlick.vinylSpeedPercent = 100.0f;
    vinylFlick.motorReturnSeconds = 0.05f;
    vinylFlick.brakePercent = 0.0f;
    vinylFlick.vinylMixPercent = 100.0f;
    assert(vinyl.setLoopTransportConfig(vinylFlick));
    vinyl.applyCommand({CommandType::Play, false});
    (void)vinyl.process(nullptr, vinylOutput.data(), 8000U, 0U, 1U);
    std::size_t positiveCrossings = 0U;
    float maximumWrappedStep = 0.0f;
    for (std::size_t frame = 4001U; frame < vinylOutput.size(); ++frame) {
        if (vinylOutput[frame - 1U] <= 0.0f && vinylOutput[frame] > 0.0f) ++positiveCrossings;
        maximumWrappedStep = std::max(maximumWrappedStep, std::fabs(vinylOutput[frame] - vinylOutput[frame - 1U]));
    }
    assert(positiveCrossings >= 7U && positiveCrossings <= 9U);
    assert(maximumWrappedStep < 0.03f);

    return 0;
}
