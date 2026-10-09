#include "native_track_host.hpp"

#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
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
    const auto exactAggregateBytes = oneSecondBytes * kNativeTrackCount +
        NativeTrackHost::requiredFixedMemoryBytes();
    if (!require(host.prepare(48000U, 1U, exactAggregateBytes),
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

bool testTrackAndMasterFxReachRecordedFiveTrackOutput() {
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U),
                 "prepare five stereo history buffers for the real FX routing test")) return false;

    using namespace webrc::dsp;
    auto graph = std::make_unique<NativeFxGraph>();
    const ProcessSpec spec{48000.0f, kNativeTrackHostQuantumFrames, 2U};
    const std::array<NativeFxInitialParameter, 1U> trackLpf{{
        {FxParameterId::FrequencyHz, 400.0f},
    }};
    const std::array<NativeFxInitialParameter, 3U> masterShelf{{
        {FxParameterId::EqHighFrequencyHz, 3000.0f},
        {FxParameterId::EqHighGainDb, -18.0f},
        {FxParameterId::EqHighSlope, 1.0f},
    }};
    if (!require(graph->prepare(spec, host.candidateFxGraphBudgetBytes()) == NativeFxGraphResult::Ok &&
                 graph->configureSlot({NativeFxBusKind::Track, 0U}, 0U, 1U,
                     1.0f, 5.0f, trackLpf.data(),
                     static_cast<std::uint32_t>(trackLpf.size())) == NativeFxGraphResult::Ok &&
                 graph->configureSlot({NativeFxBusKind::Master, 0U}, 0U, 26U,
                     1.0f, 5.0f, masterShelf.data(),
                     static_cast<std::uint32_t>(masterShelf.size())) == NativeFxGraphResult::Ok &&
                 graph->seal() == NativeFxGraphResult::Ok &&
                 host.stageFxGraph(graph) == NativeFxGraphResult::Ok && !graph,
                 "stage Track LPF and Master EQ processors in the actual host buses")) return false;

    std::array<float, 128U> input{};
    std::array<float, 128U> output{};
    MultiTrackProcessStats stats{};
    if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U, &stats) &&
                 host.status().fxGraphActive,
                 "activate the prepared graph on the software callback path")) return false;

    constexpr std::uint32_t recordedFrames = 1536U; // 256 exact cycles of 8 kHz at 48 kHz.
    constexpr std::uint32_t recordBlocks = recordedFrames / kNativeTrackHostQuantumFrames;
    std::uint64_t frame = host.status().nextFrame;
    std::array<float, kNativeTrackCount> inputLeft{};
    std::array<float, kNativeTrackCount> inputRight{};
    for (std::uint8_t track = 0U; track < kNativeTrackCount; ++track) {
        inputLeft[track] = 0.08f + 0.01f * static_cast<float>(track);
        inputRight[track] = 0.05f + 0.006f * static_cast<float>(track);
        if (!require(host.postTrackCommand({frame, TrackCommandType::Record,
                                             track, false, 0.0f}),
                     "start each independent stereo recording at the shared frame cursor")) return false;
        for (std::uint32_t blockIndex = 0U; blockIndex < recordBlocks; ++blockIndex) {
            for (std::uint32_t sample = 0U; sample < kNativeTrackHostQuantumFrames; ++sample) {
                const auto relative = blockIndex * kNativeTrackHostQuantumFrames + sample;
                const auto phase = 2.0f * 3.14159265358979323846f * 8000.0f *
                                   static_cast<float>(relative) / 48000.0f;
                input[2U * sample] = inputLeft[track] * std::sin(phase);
                input[2U * sample + 1U] = inputRight[track] * std::sin(phase + 0.37f);
            }
            if (!require(host.processInputBlock(input.data(), 2U, output.data(),
                                                 kNativeTrackHostQuantumFrames, &stats),
                         "record a unique high-frequency stereo signature without hardware")) return false;
        }
        frame += recordedFrames;
        if (!require(host.postTrackCommand({frame, TrackCommandType::Stop,
                                             track, false, 0.0f}),
                     "stop the completed high-frequency loop at its exact end frame")) return false;
    }
    input.fill(0.0f);
    if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U, &stats),
                 "publish all five independent recorded loops before playback")) return false;
    for (const auto& track : host.status().tracks) {
        if (!require(track.state == TrackPlaybackState::Stopped &&
                     track.loopFrames == recordedFrames,
                     "each FX test track retains the same exact high-frequency recording span")) return false;
    }

    constexpr std::uint32_t analysisFrames = 2048U;
    constexpr std::uint32_t analysisBlocks = analysisFrames / kNativeTrackHostQuantumFrames;
    constexpr std::uint32_t measuredFrames = recordedFrames;
    constexpr std::uint32_t measureStart = analysisFrames - measuredFrames;
    std::array<double, kNativeTrackCount> leftRms{};
    std::array<double, kNativeTrackCount> rightRms{};
    std::array<float, analysisFrames * 2U> capture{};
    frame = host.status().nextFrame;
    std::uint8_t previouslyPlaying = 0xffU;
    for (std::uint8_t selected = 0U; selected < kNativeTrackCount; ++selected) {
        if (previouslyPlaying < kNativeTrackCount &&
            !require(host.postTrackCommand({frame, TrackCommandType::Stop,
                                             previouslyPlaying, false, 0.0f}),
                     "stop the prior solo playback before measuring the next stem")) return false;
        for (std::uint8_t track = 0U; track < kNativeTrackCount; ++track) {
            if (!require(host.postTrackCommand({frame, TrackCommandType::SetTrackSolo,
                                                track, track == selected, 0.0f}),
                         "solo one exact Native track for the downstream bus measurement")) return false;
        }
        if (!require(host.postTrackCommand({frame, TrackCommandType::Play,
                                             selected, false, 0.0f}),
                     "play the selected recorded stereo stem through Track FX and Master FX")) return false;
        for (std::uint32_t block = 0U; block < analysisBlocks; ++block) {
            if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U, &stats),
                         "render the selected stem through the actual host mixer and master chain")) return false;
            std::copy_n(output.data(), output.size(), capture.data() + block * output.size());
        }
        frame += analysisFrames;
        previouslyPlaying = selected;
        double leftPower = 0.0;
        double rightPower = 0.0;
        for (std::uint32_t sample = measureStart; sample < analysisFrames; ++sample) {
            const auto index = static_cast<std::size_t>(sample) * 2U;
            leftPower += static_cast<double>(capture[index]) * capture[index];
            rightPower += static_cast<double>(capture[index + 1U]) * capture[index + 1U];
        }
        leftRms[selected] = std::sqrt(leftPower / measuredFrames);
        rightRms[selected] = std::sqrt(rightPower / measuredFrames);
    }

    for (std::uint8_t track = 1U; track < kNativeTrackCount; ++track) {
        const auto dryLeftRms = static_cast<double>(inputLeft[track]) / std::sqrt(2.0);
        const auto dryRightRms = static_cast<double>(inputRight[track]) / std::sqrt(2.0);
        if (!require(leftRms[track] > 0.001 && rightRms[track] > 0.001 &&
                     leftRms[track] < dryLeftRms * 0.30 &&
                     rightRms[track] < dryRightRms * 0.30,
                     "Master EQ audibly attenuates 8 kHz on every unfiltered track")) return false;
    }
    if (!require(leftRms[0] < leftRms[1] * 0.10 &&
                 rightRms[0] < rightRms[1] * 0.10,
                 "Track 0 LPF attenuates its recorded stem independently before master summing")) return false;
    if (!require(leftRms[4] > leftRms[1] * 1.15 && leftRms[4] < leftRms[1] * 1.55 &&
                 rightRms[4] > rightRms[1] * 1.15 && rightRms[4] < rightRms[1] * 1.55,
                 "five independent stereo gain signatures survive the Track and Master FX path")) return false;
    return true;
}

bool testHostRejectsUnroutedSendBusFx() {
    NativeTrackHost host;
    auto graph = std::make_unique<NativeFxGraph>();
    const webrc::dsp::ProcessSpec spec{48000.0f, kNativeTrackHostQuantumFrames, 2U};
    if (!require(host.prepare(48000U, 1U) &&
                 graph->prepare(spec, host.candidateFxGraphBudgetBytes()) == NativeFxGraphResult::Ok &&
                 graph->configureSlot({NativeFxBusKind::Send, 0U}, 0U, 47U) == NativeFxGraphResult::Ok &&
                 graph->seal() == NativeFxGraphResult::Ok,
                 "prepare an explicit send-return FX chain for fail-closed routing")) return false;
    const auto result = host.stageFxGraph(graph);
    return require(result == NativeFxGraphResult::InvalidRoute && graph &&
                   !host.status().fxGraphActive,
                   "reject a Native send insert until its send source and level are actually routed");
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
           testTrackAndMasterFxReachRecordedFiveTrackOutput() &&
           testHostRejectsUnroutedSendBusFx() &&
           testProcessPathDoesNotAllocate() ? 0 : 1;
}
