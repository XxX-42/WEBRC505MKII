#include "multitrack_looper_core.hpp"

#include <array>
#include <cmath>
#include <cstdint>
#include <iostream>

namespace {

bool check(bool value, const char* message) {
    if (!value) std::cerr << "FAIL: " << message << '\n';
    return value;
}

webrc::native::TrackCommand command(std::uint64_t frame,
                                    webrc::native::TrackCommandType type,
                                    std::uint8_t track = 0,
                                    float value = 0.0f,
                                    bool boolValue = false) {
    return {frame, type, track, boolValue, value};
}

bool prepareAllTracks(webrc::native::MultiTrackLooperCore& engine) {
    using namespace webrc::native;
    constexpr std::uint32_t sampleRate = 48000;
    const auto oneSecond = MultiTrackLooperCore::requiredTrackBufferBytes(sampleRate, 1);
    if (!check(oneSecond == 384000U, "one-second stereo memory estimate is exact")) return false;
    if (!check(engine.prepare(sampleRate, 64U, oneSecond * kNativeTrackCount),
               "prepare fixed-quantum five-track engine under exact memory budget")) return false;
    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        if (!check(engine.prepareTrackBuffer(track, 1U), "prepare one-second stereo track buffer")) return false;
    }
    return check(engine.preparedHistoryBytes() == oneSecond * kNativeTrackCount,
                 "history byte accounting includes all five stereo buffers");
}

bool renderStereoPanFixture(float pan, float inLeft, float inRight,
                            float& outLeft, float& outRight) {
    using namespace webrc::native;
    MultiTrackLooperCore engine;
    if (!prepareAllTracks(engine)) return false;
    if (!engine.postCommand(command(0U, TrackCommandType::SetTrackPan, 0U, pan)) ||
        !engine.postCommand(command(0U, TrackCommandType::Record, 0U)) ||
        !engine.postCommand(command(64U, TrackCommandType::Stop, 0U)) ||
        !engine.postCommand(command(64U, TrackCommandType::Play, 0U))) return false;

    std::array<float,128> input{};
    std::array<float,128> output{};
    for (std::size_t frame = 0U; frame < 64U; ++frame) {
        input[2U * frame] = inLeft;
        input[2U * frame + 1U] = inRight;
    }
    if (!engine.processBlock(input.data(), output.data(), 64U, 0U)) return false;
    input.fill(0.0f);
    for (std::uint64_t block = 1U; block <= 100U; ++block) {
        if (!engine.processBlock(input.data(), output.data(), 64U, block * 64U)) return false;
    }
    outLeft = output[2U * 63U];
    outRight = output[2U * 63U + 1U];
    return true;
}

bool testTrueStereoPanContract() {
    float left = 0.0f;
    float right = 0.0f;
    if (!check(renderStereoPanFixture(0.0f, 0.2f, -0.1f, left, right) &&
               std::abs(left - 0.2f) < 1.0e-4f && std::abs(right + 0.1f) < 1.0e-4f,
               "stereo center pan preserves independent left/right amplitude and polarity")) return false;
    if (!check(renderStereoPanFixture(-1.0f, 0.2f, -0.1f, left, right) &&
               std::abs(left - 0.1f) < 1.0e-4f && std::abs(right) < 1.0e-4f,
               "hard-left stereo pan folds both input channels into the left output")) return false;
    if (!check(renderStereoPanFixture(1.0f, 0.2f, -0.1f, left, right) &&
               std::abs(left) < 1.0e-4f && std::abs(right - 0.1f) < 1.0e-4f,
               "hard-right stereo pan folds both input channels into the right output")) return false;
    if (!check(renderStereoPanFixture(0.0f, 0.2f, 0.2f, left, right) &&
               std::abs(left - 0.2f) < 1.0e-4f && std::abs(right - 0.2f) < 1.0e-4f,
               "a duplicated mono signal remains unchanged at center pan")) return false;
    if (!check(renderStereoPanFixture(-1.0f, 0.2f, 0.2f, left, right) &&
               std::abs(left - 0.4f) < 1.0e-4f && std::abs(right) < 1.0e-4f,
               "a duplicated mono signal sums to the selected hard-panned side")) return false;
    return check(renderStereoPanFixture(1.0f, 0.2f, 0.2f, left, right) &&
                 std::abs(left) < 1.0e-4f && std::abs(right - 0.4f) < 1.0e-4f,
                 "a duplicated mono signal sums to the right hard-panned side");
}

bool testFiveIndependentStereoHistoriesAndCommands() {
    using namespace webrc::native;
    MultiTrackLooperCore engine;
    if (!prepareAllTracks(engine)) return false;

    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        const float pan = track == 0U ? -1.0f : (track == 1U ? 1.0f : 0.0f);
        if (!check(engine.postCommand(command(0U, TrackCommandType::SetTrackPan, track, pan)),
                   "queue initial track pan at frame zero")) return false;
    }
    if (!check(engine.postCommand(command(0U, TrackCommandType::SetTempoBpm, 0U, 137.0f)),
               "queue tempo metadata update")) return false;
    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        if (!check(engine.postCommand(command(0U, TrackCommandType::Record, track)),
                   "arm simultaneous record on each independently routed stereo track")) return false;
    }
    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        if (!check(engine.postCommand(command(64U, TrackCommandType::Stop, track)),
                   "queue simultaneous sample-accurate record stop")) return false;
    }
    if (!check(engine.postCommand(command(64U, TrackCommandType::Record, 2U)),
               "record a new independent take into only track two")) return false;
    if (!check(engine.postCommand(command(128U, TrackCommandType::Stop, 2U)),
               "finalize the independent track-two take")) return false;
    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        if (!check(engine.postCommand(command(128U, TrackCommandType::Play, track)),
                   "queue simultaneous playback for all five tracks")) return false;
    }

    std::array<float, 128> input{};
    std::array<float, 128> output{};
    MultiTrackProcessStats stats{};
    for (std::size_t i = 0; i < input.size(); i += 2U) {
        input[i] = 0.2f;
        input[i + 1U] = -0.1f;
    }
    if (!check(engine.processBlock(input.data(), output.data(), 64U, 0U, &stats) &&
               stats.recordingTracks == 5U,
               "all five stereo tracks record simultaneously with a fixed 64-frame block")) return false;

    for (std::size_t i = 0; i < input.size(); i += 2U) {
        input[i] = 0.4f;
        input[i + 1U] = -0.3f;
    }
    if (!check(engine.processBlock(input.data(), output.data(), 64U, 64U, &stats) &&
               stats.recordingTracks == 1U,
               "a second route records track two independently while other histories stop")) return false;

    input.fill(0.0f);
    if (!check(engine.processBlock(input.data(), output.data(), 64U, 128U, &stats),
               "play five tracks at a common absolute-frame boundary")) return false;
    if (!check(stats.activeTracks == 5U, "all five tracks are independently active")) return false;
    if (!check(std::abs(output[0]) > 0.05f && std::abs(output[1]) > 0.05f &&
               std::abs(output[0] - output[1]) > 0.05f,
               "stereo history is preserved with distinct left/right content and panning")) return false;
    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        const auto status = engine.trackStatus(track);
        if (!check(status.state == TrackPlaybackState::Playing && status.loopFrames == 64U &&
                   status.bufferPrepared,
                   "five independent track states retain their own recorded lengths")) return false;
    }
    if (!check(std::abs(engine.tempoBpm() - 137.0) < 1.0e-9,
               "tempo command is applied at its absolute frame")) return false;

    if (!check(engine.postCommand(command(192U, TrackCommandType::ClearTrack, 2U)),
               "queue constant-time clear of track two")) return false;
    if (!check(engine.processBlock(input.data(), output.data(), 64U, 192U, &stats),
               "continue other track histories after one-track clear")) return false;
    if (!check(engine.trackStatus(2U).state == TrackPlaybackState::Empty &&
               engine.trackStatus(2U).loopFrames == 0U && stats.activeTracks == 4U,
               "clearing one track preserves the remaining four active loops")) return false;

    output.fill(123.0f);
    if (!check(!engine.processBlock(input.data(), output.data(), 64U, 400U, &stats),
               "reject noncontiguous host timeline")) return false;
    if (!check(output[0] == 0.0f && output[1] == 0.0f,
               "timeline discontinuity returns silence")) return false;
    return true;
}

bool testBudgetAndQueueBounds() {
    using namespace webrc::native;
    MultiTrackLooperCore engine;
    if (!check(engine.prepare(48000U, 64U, 100000U), "prepare engine with explicit small history budget")) return false;
    if (!check(!engine.prepareTrackBuffer(0U, 1U), "reject track allocation exceeding reserved memory")) return false;
    if (!check(engine.prepareTrackBuffer(0U, 0U) == false,
               "reject zero-second track history")) return false;
    if (!check(engine.preparedHistoryBytes() == 0U, "failed allocations do not change ledger")) return false;

    MultiTrackLooperCore queued;
    if (!prepareAllTracks(queued)) return false;
    for (std::uint32_t index = 0; index < kTrackCommandCapacity; ++index) {
        if (!check(queued.postCommand(command(1000U, TrackCommandType::SetInputMonitor,
                                               0U, 0.0f, (index & 1U) != 0U)),
                   "fill bounded timestamped command queue")) return false;
    }
    if (!check(!queued.postCommand(command(1000U, TrackCommandType::SetInputMonitor)),
               "reject queue overflow without blocking audio consumer")) return false;
    if (!check(!queued.postCommand(command(999U, TrackCommandType::SetInputMonitor)),
               "reject out-of-order producer timestamp")) return false;
    std::array<float, 128> silence{};
    MultiTrackProcessStats stats{};
    if (!check(queued.processBlock(silence.data(), silence.data(), 64U, 0U, &stats),
               "process before future controls without consuming them early")) return false;
    return check(stats.droppedCommands == 1U,
                 "queue overflow is visible in process statistics");
}

bool testInputRouteAndMuteStopRamps() {
    using namespace webrc::native;
    MultiTrackLooperCore engine;
    const auto oneSecond = MultiTrackLooperCore::requiredTrackBufferBytes(48000U, 1U);
    if (!check(engine.prepare(48000U, 64U, oneSecond) && engine.prepareTrackBuffer(0U, 1U),
               "prepare route and transition fixture")) return false;

    if (!check(engine.postCommand(command(0U, TrackCommandType::SetTrackInputRoute, 0U, 0.0f, false)) &&
               engine.postCommand(command(0U, TrackCommandType::Record, 0U)) &&
               engine.postCommand(command(32U, TrackCommandType::SetTrackInputRoute, 0U, 0.0f, true)) &&
               engine.postCommand(command(64U, TrackCommandType::Stop, 0U)),
               "queue a route change during an active record timeline")) return false;
    std::array<float, 128> input{};
    std::array<float, 128> output{};
    input.fill(0.35f);
    if (!check(engine.processBlock(input.data(), output.data(), 64U, 0U) &&
               engine.processBlock(input.data(), output.data(), 64U, 64U),
               "record silence while disconnected and continue the same timeline when connected")) return false;
    if (!check(engine.trackStatus(0U).state == TrackPlaybackState::Stopped &&
               engine.trackStatus(0U).loopFrames == 64U && engine.trackStatus(0U).inputRouted,
               "route-off recording still creates a time-aligned silent section in the loop")) return false;
    if (!check(engine.postCommand(command(128U, TrackCommandType::Play, 0U)) &&
               engine.processBlock(input.data(), output.data(), 64U, 128U),
               "play back the route transition without altering its recorded timeline")) return false;
    if (!check(std::abs(output[0]) < 0.001f && std::abs(output[64U]) > 0.05f,
               "the first half remains silent and the reconnected second half contains stereo input")) return false;

    MultiTrackLooperCore monitor;
    if (!check(monitor.prepare(48000U, 64U) &&
               monitor.postCommand(command(0U, TrackCommandType::SetInputMonitor, 0U, 0.0f, true)),
               "prepare and enable smoothed input monitoring")) return false;
    if (!check(monitor.processBlock(input.data(), output.data(), 64U, 0U),
               "render a monitor fade-in without loop playback")) return false;
    if (!check(std::abs(output[0]) < 0.002f && std::abs(output[126U]) > 0.04f,
               "input monitoring reaches a smooth finite 10ms linear fade")) return false;
    const float monitorBeforeDisable = output[126U];
    if (!check(monitor.postCommand(command(64U, TrackCommandType::SetInputMonitor, 0U, 0.0f, false)) &&
               monitor.processBlock(input.data(), output.data(), 64U, 64U),
               "render a monitor fade-out at an absolute-frame event")) return false;
    if (!check(std::abs(output[0] - monitorBeforeDisable) < 0.002f &&
               std::abs(output[0]) > std::abs(output[126U]),
               "monitor disable starts as a continuous fade rather than a block-edge mute")) return false;
    for (std::uint64_t frame = 128U; frame < 576U; frame += 64U) {
        if (!check(monitor.processBlock(input.data(), output.data(), 64U, frame),
                   "complete the prepared 10ms monitor fade")) return false;
    }
    if (!check(std::abs(output[126U]) < 0.01f,
               "monitor disable reaches silence within the configured 10ms ramp")) return false;

    MultiTrackLooperCore transitions;
    if (!check(transitions.prepare(48000U, 64U, oneSecond) && transitions.prepareTrackBuffer(0U, 1U),
               "prepare click-ramp fixture")) return false;
    if (!check(transitions.postCommand(command(0U, TrackCommandType::Record, 0U)) &&
               transitions.postCommand(command(64U, TrackCommandType::Stop, 0U)) &&
               transitions.postCommand(command(64U, TrackCommandType::Play, 0U)) &&
               transitions.postCommand(command(1152U, TrackCommandType::SetTrackMute, 0U, 0.0f, true)) &&
               transitions.postCommand(command(1216U, TrackCommandType::SetTrackMute, 0U, 0.0f, false)) &&
               transitions.postCommand(command(1280U, TrackCommandType::Stop, 0U)),
               "queue sample-accurate start/mute/unmute/stop transitions")) return false;
    input.fill(0.0f);
    for (std::size_t i = 0; i < input.size(); i += 2U) {
        input[i] = 0.4f;
        input[i + 1U] = -0.2f;
    }
    if (!check(transitions.processBlock(input.data(), output.data(), 64U, 0U),
               "record a stable stereo signal")) return false;
    input.fill(0.0f);
    for (std::uint64_t frame = 64U; frame < 1152U; frame += 64U) {
        if (!check(transitions.processBlock(input.data(), output.data(), 64U, frame),
                   "warm up playback gate before mute")) return false;
    }
    const float beforeMute = output[126U];
    if (!check(transitions.processBlock(input.data(), output.data(), 64U, 1152U),
               "apply mute through a smoothed gate")) return false;
    const float firstMuted = output[0];
    const float lastMuted = output[126U];
    if (!check(std::abs(firstMuted - beforeMute) < 0.02f && lastMuted < firstMuted && lastMuted > 0.05f,
               "mute ramps without a block-edge discontinuity")) return false;
    if (!check(transitions.processBlock(input.data(), output.data(), 64U, 1216U),
               "apply unmute through a smoothed gate")) return false;
    if (!check(std::abs(output[0] - lastMuted) < 0.02f && output[126U] > output[0],
               "unmute ramps without a block-edge discontinuity")) return false;
    const float beforeStop = output[126U];
    if (!check(transitions.processBlock(input.data(), output.data(), 64U, 1280U),
               "start a stop-tail ramp")) return false;
    if (!check(std::abs(output[0] - beforeStop) < 0.02f,
               "stop preserves a bounded fade tail at the transition")) return false;
    for (std::uint64_t frame = 1344U; frame < 4480U; frame += 64U) {
        if (!check(transitions.processBlock(input.data(), output.data(), 64U, frame),
                   "finish the bounded stop fade")) return false;
    }
    return check(std::abs(output[126U]) < 0.01f,
                 "stop tail returns to silence within the prepared fade interval");
}

} // namespace

int main() {
    return testTrueStereoPanContract() && testFiveIndependentStereoHistoriesAndCommands() &&
           testBudgetAndQueueBounds() &&
           testInputRouteAndMuteStopRamps() ? 0 : 1;
}
