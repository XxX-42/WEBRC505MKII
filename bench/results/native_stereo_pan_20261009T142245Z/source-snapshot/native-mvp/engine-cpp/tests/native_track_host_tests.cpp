#include "native_track_host.hpp"

#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <new>

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<std::uint64_t> allocationCount{0};
}

void* operator new(std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

namespace {
using namespace webrc::native;

bool require(bool condition, const char* message) {
    if (!condition) std::cerr << "FAIL: " << message << '\n';
    return condition;
}

bool testVariableDeviceCallbacksAndFiveStereoTracks() {
    NativeTrackHost host;
    constexpr std::uint64_t oneSecondBytes = 48000U * 2U * sizeof(float);
    if (!require(host.prepare(48000U, 1U, oneSecondBytes * kNativeTrackCount),
                 "prepare the software host and all five stereo histories")) return false;
    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        if (!require(host.record(track), "queue simultaneous track record at next fixed quantum")) return false;
    }

    std::array<float, 256> mono{};
    std::array<float, 256> stereoOutput{};
    for (std::size_t i = 0; i < mono.size(); ++i) mono[i] = 0.2f + 0.05f * std::sin(static_cast<float>(i) * 0.1f);
    std::array<std::uint32_t, 4> callbackFrames{{32U, 96U, 64U, 64U}};
    std::uint32_t monoOffset = 0U;
    MultiTrackProcessStats stats{};
    for (const auto callbackFramesNow : callbackFrames) {
        if (!require(host.processInputBlock(mono.data() + monoOffset, 1U,
                                             stereoOutput.data(), callbackFramesNow, &stats),
                     "adapt a variable-size mono device callback through 64-frame chunks")) return false;
        monoOffset += callbackFramesNow;
    }
    if (!require(monoOffset == mono.size(), "callback chunks consume the full mono fixture")) return false;

    for (std::uint8_t track = 0; track < kNativeTrackCount; ++track) {
        if (!require(host.stop(track), "queue stop for every track after common recording window")) return false;
    }
    std::array<float, 128> silence{};
    if (!require(host.processInputBlock(silence.data(), 1U, stereoOutput.data(), 64U, &stats) &&
                 stats.frames == 64U && host.processInputBlock(silence.data(), 1U,
                    stereoOutput.data(), 64U, &stats),
                 "finish all track histories and transition without a hardware stream")) return false;
    auto status = host.status();
    if (!require(status.nextFrame == 384U && status.preparedHistoryBytes == oneSecondBytes * 5U,
                 "publish frame cursor and exact five-track memory ledger")) return false;
    for (const auto& track : status.tracks) {
        if (!require(track.state == TrackPlaybackState::Stopped && track.loopFrames == 256U &&
                     track.bufferPrepared,
                     "each track publishes its own recorded stereo loop")) return false;
    }

    if (!require(host.play(0U), "queue playback through the Native host adapter")) return false;
    std::array<float, 128> stereoInput{};
    for (std::size_t frame = 0; frame < 64U; ++frame) {
        stereoInput[2U * frame] = 0.25f;
        stereoInput[2U * frame + 1U] = -0.125f;
    }
    if (!require(host.processInputBlock(stereoInput.data(), 2U, stereoOutput.data(), 64U, &stats) &&
                 host.processInputBlock(stereoInput.data(), 2U, stereoOutput.data(), 32U, &stats),
                 "accept two-channel capture, a 64-frame callback and a sub-quantum tail")) return false;
    for (std::uint32_t block = 0U; block < 5U; ++block) {
        if (!require(host.processInputBlock(stereoInput.data(), 2U, stereoOutput.data(), 64U, &stats),
                     "advance the prepared playback gate through its bounded 10ms fade")) return false;
    }
    status = host.status();
    if (!require(status.tracks[0].state == TrackPlaybackState::Playing &&
                 status.tracks[0].loopFrames == 256U && std::abs(stereoOutput[0]) > 0.01f,
                 "the first native track remains independently playable")) return false;
    return true;
}

bool testFiveTrackStereoCaptureIsolationThroughHost() {
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U),
                 "prepare five stereo histories for per-track signature capture")) return false;

    std::array<float,128> input{};
    std::array<float,128> output{};
    MultiTrackProcessStats stats{};
    if (!require(host.postTrackCommand({0U, TrackCommandType::Record, 0U, false, 0.0f}),
                 "start track one at the first software frame")) return false;

    std::uint64_t frame = 0U;
    std::array<float, kNativeTrackCount> expectedLeft{};
    std::array<float, kNativeTrackCount> expectedRight{};
    for (std::uint8_t track = 0U; track < kNativeTrackCount; ++track) {
        expectedLeft[track] = 0.1f + 0.05f * static_cast<float>(track);
        expectedRight[track] = -0.02f - 0.03f * static_cast<float>(track);
        for (std::size_t sample = 0U; sample < 64U; ++sample) {
            input[2U * sample] = expectedLeft[track];
            input[2U * sample + 1U] = expectedRight[track];
        }
        if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U, &stats),
                     "capture a distinct stereo signature through the Native callback adapter")) return false;
        frame += 64U;
        if (!require(host.postTrackCommand({frame, TrackCommandType::Stop, track, false, 0.0f}),
                     "stop only the track whose stereo signature has been captured")) return false;
        if (track + 1U < kNativeTrackCount &&
            !require(host.postTrackCommand({frame, TrackCommandType::Record,
                                             static_cast<std::uint8_t>(track + 1U), false, 0.0f}),
                     "start the next track without modifying earlier histories")) return false;
    }

    input.fill(0.0f);
    if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U, &stats),
                 "finalize the fifth independent stereo recording")) return false;
    frame += 64U;
    auto status = host.status();
    if (!require(status.nextFrame == frame, "five-track capture advances one shared frame timeline")) return false;
    for (const auto& track : status.tracks) {
        if (!require(track.state == TrackPlaybackState::Stopped && track.loopFrames == 64U,
                     "all five tracks own a separate 64-frame stereo history")) return false;
    }

    for (std::uint8_t selected = 0U; selected < kNativeTrackCount; ++selected) {
        const auto startFrame = host.status().nextFrame;
        if (selected > 0U &&
            !require(host.postTrackCommand({startFrame, TrackCommandType::Stop,
                                             static_cast<std::uint8_t>(selected - 1U), false, 0.0f}),
                     "stop the previously isolated playback track")) return false;
        for (std::uint8_t track = 0U; track < kNativeTrackCount; ++track) {
            if (!require(host.postTrackCommand({startFrame, TrackCommandType::SetTrackSolo,
                                                 track, track == selected, 0.0f}),
                         "solo exactly one Native track for crosstalk verification")) return false;
        }
        if (!require(host.postTrackCommand({startFrame, TrackCommandType::Play, selected, false, 0.0f}),
                     "play the selected track from its own captured history")) return false;

        for (std::uint32_t block = 0U; block < 100U; ++block) {
            if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U, &stats),
                         "render isolated stereo playback with no hardware device")) return false;
        }
        const auto sample = static_cast<std::size_t>(63U) * 2U;
        if (!require(std::abs(output[sample] - expectedLeft[selected]) < 1.0e-4f &&
                     std::abs(output[sample + 1U] - expectedRight[selected]) < 1.0e-4f,
                     "track playback preserves its own left/right signature without channel or track crosstalk")) return false;
    }
    return true;
}

bool testProcessPathDoesNotAllocate() {
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U), "prepare allocation guard host")) return false;
    std::array<float, 256> input{};
    std::array<float, 512> output{};
    for (std::size_t i = 0; i < input.size(); i += 2U) {
        input[i] = 0.2f;
        input[i + 1U] = -0.1f;
    }
    if (!require(host.record(0U) && host.processInputBlock(input.data(), 2U, output.data(), 64U),
                 "prime an active track before guarded processing")) return false;
    allocationCount.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    bool ok = true;
    for (std::uint32_t block = 0U; block < 32U; ++block) {
        ok = ok && host.processInputBlock(input.data(), 2U, output.data(), 64U);
    }
    countAllocations.store(false, std::memory_order_release);
    if (!require(ok, "process a long active sequence of 64-frame stereo callbacks")) return false;
    return require(allocationCount.load(std::memory_order_relaxed) == 0U,
                   "device callback adaptation and five-track processing allocate nothing");
}

} // namespace

int main() {
    return testVariableDeviceCallbacksAndFiveStereoTracks() &&
           testFiveTrackStereoCaptureIsolationThroughHost() &&
           testProcessPathDoesNotAllocate() ? 0 : 1;
}
