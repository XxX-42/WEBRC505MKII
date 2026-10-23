#include "native_audio_core.hpp"
#include "native_official_domains.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

using namespace webrc::native;

namespace webrc::native {

struct NativeAudioCoreTestAccess {
    static void prepareWithoutDevice(NativeAudioCore& core) {
        EngineConfig config;
        config.sampleRate = 48000U;
        core.currentConfig_ = config;
        assert(core.looper_.prepare(config.sampleRate, 1U, 2U));
        for (auto& track : core.additionalLoopers_) assert(track.prepare(config.sampleRate, 1U, 2U));
        core.nativeLooperMaxRecordSeconds_ = 1U;
        core.nativeLooperPreallocatedBytes_ = core.looper_.storageBytes();
        for (const auto& track : core.additionalLoopers_) core.nativeLooperPreallocatedBytes_ += track.storageBytes();
        assert(core.outputStage_->prepare(config.sampleRate));
        assert(core.nativeInputFxBank_.prepare(config.sampleRate));
        assert(core.nativePitchProcessor_->prepare(config.sampleRate, 70.0f, 1200.0f));
        assert(core.nativePolyPitchProcessor_->prepare(config.sampleRate));
        assert(core.nativeRhythmEngine_.prepare(config.sampleRate));
        assert(core.nativeRhythmEngine_.setConfig(core.nativeRhythmConfig_, 0U));
    }

    static void setInputChannels(NativeAudioCore& core, unsigned int channels) {
        core.inputChannels_ = channels;
    }

    static void setRunning(NativeAudioCore& core, bool running) {
        core.engineRunning_.store(running, std::memory_order_release);
    }

    static void command(NativeAudioCore& core, CommandType type, bool value = false, std::uint8_t trackIndex = 0U) {
        assert(core.commandQueue_.push({type, value, trackIndex}));
    }

    static int callback(NativeAudioCore& core, const float* input, float* output, unsigned int frames) {
        return NativeAudioCore::audioCallback(
            output, const_cast<float*>(input), frames, 0.0, static_cast<RtAudioStreamStatus>(0), &core);
    }

    static const float* processInputFx(
        NativeAudioCore& core,
        const float* input,
        unsigned int frames,
        unsigned int* processedChannels = nullptr
    ) {
        core.applyNativeCatalogFxCommands();
        return core.processInputFxForCallback(input, frames, processedChannels);
    }

    static void processSharedTrackFx(NativeAudioCore& core, float* audio, unsigned int frames) {
        core.applyNativeCatalogFxCommands();
        (void)core.outputStage_->trackFxBank().processInPlace(audio, frames, 2U);
    }

    static void prepareSelectedCatalog(NativeAudioCore& core) { assert(core.nativeInputFxBank_.prepare(48000.0)); }
    static void splitInputCallback(NativeAudioCore& core, const float* input, unsigned int frames) {
        (void)core.handleInputAudioCallback(const_cast<float*>(input), frames, static_cast<RtAudioStreamStatus>(0));
    }
    static void resetRuntime(NativeAudioCore& core) { core.resetRuntimeStateLocked(); }

    static NativeVocoderCarrierStatus carrierStatus(const NativeAudioCore& core, std::size_t track) {
        return core.nativeVocoderCarrierStatuses_[track].load(std::memory_order_acquire);
    }
    static void prepareCarriers(NativeAudioCore& core, unsigned int frames) { core.prepareVocoderCarriers(frames); }
    static void pinCarrierSource(NativeAudioCore& core, std::size_t track) { core.historyPinnedTrackIndex_ = track; }
    static void restoreSourceLoop(NativeAudioCore& core, const std::vector<float>& samples, std::size_t track) {
        auto& source = core.looperForTrack(track);
        std::vector<float> replacement(source.capacityFrames() * 2U, 0.0f);
        std::copy(samples.begin(), samples.end(), replacement.begin());
        assert(source.swapImportedStereoStorage(replacement, samples.size() / 2U));
    }
    static void loadSourceLoop(NativeAudioCore& core, const std::vector<float>& samples, std::size_t index = 0U) {
        auto& track = core.looperForTrack(index);
        track.applyCommand({CommandType::Clear, false});
        track.applyCommand({CommandType::Record, false});
        (void)track.process(samples.data(), nullptr, static_cast<unsigned int>(samples.size() / 2U), 2U, 2U);
        track.applyCommand({CommandType::StopRecordOrPlayback, false});
        track.applyCommand({CommandType::Play, false});
    }
    static const LoopTransportConfig& transport(const NativeAudioCore& core, std::size_t track) {
        return core.looperForTrack(track).loopTransportConfig();
    }
    static void applySourceQueue(NativeAudioCore& core) {
        core.applyNativeCatalogFxCommands(); core.applyNativePitchCommands(); core.applyNativeLoopTransportCommands();
    }

    static bool copyTrackStereo(NativeAudioCore& core, std::size_t trackIndex,
                                float* destination, std::size_t destinationFrames,
                                std::size_t& copiedFrames) {
        return core.looperForTrack(trackIndex).copyFinalizedStereoLoopSnapshot(
            destination, destinationFrames, copiedFrames);
    }

    static bool queueTrackCommand(NativeAudioCore& core, CommandType type,
                                  std::size_t trackIndex, std::string& error) {
        return core.queueTrackCommand(type, trackIndex, error);
    }

};

} // namespace webrc::native

namespace {

constexpr unsigned int kPreampTestFrames = 4096U;
constexpr unsigned int kSynthRouteTestFrames = 16384U;
constexpr unsigned int kG2BRouteTestFrames = 16384U;
constexpr unsigned int kRobotRouteTestFrames = 32768U;

[[nodiscard]] std::vector<float> makeSynthRouteSignal() {
    std::vector<float> signal(kSynthRouteTestFrames);
    for (unsigned int frame = 0U; frame < kSynthRouteTestFrames; ++frame) {
        signal[frame] = 0.32f * std::sin(2.0f * 3.14159265358979323846f * 440.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    return signal;
}

[[nodiscard]] double vectorDifferenceRms(
    const std::vector<float>& left,
    const std::vector<float>& right,
    unsigned int firstFrame
) {
    assert(left.size() == right.size() && left.size() % 2U == 0U);
    const unsigned int frames = static_cast<unsigned int>(left.size() / 2U);
    double energy = 0.0;
    std::size_t count = 0U;
    for (unsigned int frame = firstFrame; frame < frames; ++frame) {
        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            const std::size_t index = (static_cast<std::size_t>(frame) * 2U) + channel;
            const double delta = static_cast<double>(left[index] - right[index]);
            energy += delta * delta;
            ++count;
        }
    }
    return count == 0U ? 0.0 : std::sqrt(energy / static_cast<double>(count));
}

void callbackInChunks(NativeAudioCore& core, const float* input, float* output, unsigned int frames) {
    unsigned int position = 0U;
    while (position < frames) {
        const unsigned int chunk = std::min(2048U, frames - position);
        const float* inputChunk = input == nullptr
            ? nullptr : input + (static_cast<std::size_t>(position) * 1U);
        (void)NativeAudioCoreTestAccess::callback(
            core, inputChunk, output + (static_cast<std::size_t>(position) * 2U), chunk);
        position += chunk;
    }
}

void testOscVocMidiUsesSelectedInputAndSharedTrackSlots() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 1U);
    std::string error;
    const std::map<std::string, float> parameters{
        {"waveform", 0.0f}, {"midi-channel", 1.0f}, {"octave", 0.0f}, {"mix", 100.0f},
    };
    assert(core.setNativeCatalogSlot(NativeEffectSlot::B, "osc_voc_m", parameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    assert(core.setNativeCatalogSlot(NativeEffectSlot::D, "osc_voc_m", parameters,
        false, error, NativeCatalogFxPath::Track));

    auto status = core.getStatus();
    assert(status.nativeInputOscVocSlots[1].selected);
    assert(!status.nativeInputOscVocSlots[0].selected);
    assert(status.nativeTrackOscVocSlots[3].selected);
    assert(!status.nativeTrackOscVocSlots[0].selected);
    assert(status.nativeSampleFrame == 0U);

    NativeAudioCoreTestAccess::setRunning(core, true);
    assert(!core.queueNativeOscVocMidiEvent(NativeCatalogFxPath::Input, NativeEffectSlot::A,
        true, 1, 60, 100, 0U, error));
    assert(error.find("not selected") != std::string::npos);
    assert(core.queueNativeOscVocMidiEvent(NativeCatalogFxPath::Input, NativeEffectSlot::B,
        true, 1, 69, 127, 0U, error));
    assert(core.queueNativeOscVocMidiEvent(NativeCatalogFxPath::Track, NativeEffectSlot::D,
        true, 1, 60, 96, 0U, error));
    assert(!core.queueNativeOscVocMidiEvent(NativeCatalogFxPath::Input, NativeEffectSlot::B,
        true, 17, 69, 127, 0U, error));
    assert(error.find("outside its supported range") != std::string::npos);

    status = core.getStatus();
    assert(status.nativeInputOscVocSlots[1].queuedEvents == 1U);
    assert(status.nativeInputOscVocSlots[1].rejectedEventCount == 1U);
    assert(status.nativeTrackOscVocSlots[3].queuedEvents == 1U);
    assert(status.nativeInputOscVocSlots[0].queuedEvents == 0U);
    assert(status.nativeTrackOscVocSlots[0].queuedEvents == 0U);

    constexpr unsigned int frames = 64U;
    std::array<float, frames> input{};
    std::array<float, frames * 2U> output{};
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        input[frame] = 0.3f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
            static_cast<float>(frame) / 48000.0f);
    }
    (void)NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), frames);
    status = core.getStatus();
    assert(status.nativeSampleFrame == frames);
    assert(status.nativeInputOscVocSlots[1].currentFrame == frames);
    assert(status.nativeTrackOscVocSlots[3].currentFrame == frames);
    assert(status.nativeInputOscVocSlots[1].queuedEvents == 0U);
    assert(status.nativeTrackOscVocSlots[3].queuedEvents == 0U);

    assert(!core.queueNativeOscVocMidiEvent(NativeCatalogFxPath::Input, NativeEffectSlot::B,
        false, 1, 69, 0, frames - 1U, error));
    status = core.getStatus();
    assert(status.nativeInputOscVocSlots[1].lateEventCount == 1U);
    for (std::size_t index = 0U; index < kNativeOscVocEventQueueCapacity; ++index) {
        assert(core.queueNativeOscVocMidiEvent(NativeCatalogFxPath::Track, NativeEffectSlot::D,
            true, 1, 48, 100, frames + index, error));
    }
    assert(!core.queueNativeOscVocMidiEvent(NativeCatalogFxPath::Track, NativeEffectSlot::D,
        true, 1, 48, 100, frames + kNativeOscVocEventQueueCapacity, error));
    assert(error.find("queue is full") != std::string::npos);
    status = core.getStatus();
    assert(status.nativeTrackOscVocSlots[3].queuedEvents == kNativeOscVocEventQueueCapacity);
    assert(status.nativeTrackOscVocSlots[3].overflowEventCount == 1U);
    NativeAudioCoreTestAccess::setRunning(core, false);

    // A selected Input slot can miss audio blocks (for example, a backend
    // callback with no capture pointer). Its absolute clock must catch up and
    // drop/count events that became stale rather than triggering them later.
    NativeAudioCore skippedInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(skippedInputCore);
    NativeAudioCoreTestAccess::setInputChannels(skippedInputCore, 1U);
    error.clear();
    assert(skippedInputCore.setNativeCatalogSlot(NativeEffectSlot::A, "osc_voc_m", parameters,
        false, error, NativeCatalogFxPath::Input));
    NativeAudioCoreTestAccess::setRunning(skippedInputCore, true);
    assert(skippedInputCore.queueNativeOscVocMidiEvent(NativeCatalogFxPath::Input,
        NativeEffectSlot::A, true, 1, 69, 127, 100U, error));
    assert(NativeAudioCoreTestAccess::callback(skippedInputCore, nullptr, output.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(skippedInputCore, nullptr, output.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(skippedInputCore, nullptr, output.data(), 64U) == 0);
    const auto skippedStatus = skippedInputCore.getStatus();
    assert(skippedStatus.nativeSampleFrame == 192U);
    assert(skippedStatus.nativeInputOscVocSlots[0].currentFrame == 128U);
    assert(skippedStatus.nativeInputOscVocSlots[0].queuedEvents == 0U);
    assert(skippedStatus.nativeInputOscVocSlots[0].lateEventCount == 1U);
    NativeAudioCoreTestAccess::setRunning(skippedInputCore, false);
}

[[nodiscard]] std::vector<float> makePreampTestSignal() {
    std::vector<float> signal(kPreampTestFrames);
    for (unsigned int frame = 0U; frame < kPreampTestFrames; ++frame) {
        signal[frame] = 0.56f * std::sin(2.0f * 3.14159265358979323846f * 440.0f *
                                         static_cast<float>(frame) / 48000.0f) +
                        0.17f * std::sin(2.0f * 3.14159265358979323846f * 1700.0f *
                                         static_cast<float>(frame) / 48000.0f);
    }
    return signal;
}

[[nodiscard]] double tailRms(const std::array<float, kPreampTestFrames * 2U>& output) {
    constexpr unsigned int firstFrame = 2500U;
    double energy = 0.0;
    for (unsigned int frame = firstFrame; frame < kPreampTestFrames; ++frame) {
        const double sample = output[frame * 2U];
        energy += sample * sample;
    }
    return std::sqrt(energy / static_cast<double>(kPreampTestFrames - firstFrame));
}

[[nodiscard]] double outputDifferenceRms(
    const std::array<float, kPreampTestFrames * 2U>& left,
    const std::array<float, kPreampTestFrames * 2U>& right
) {
    constexpr unsigned int firstFrame = 2500U;
    double energy = 0.0;
    for (unsigned int frame = firstFrame; frame < kPreampTestFrames; ++frame) {
        const double delta = static_cast<double>(left[frame * 2U] - right[frame * 2U]);
        energy += delta * delta;
    }
    return std::sqrt(energy / static_cast<double>(kPreampTestFrames - firstFrame));
}

void testPreampAudioRunsThroughInputAndTrackBanks() {
    const auto signal = makePreampTestSignal();
    std::string error;

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "preamp", {
        {"model", 1.0f}, {"gain", 68.0f}, {"bass", 4.0f},
        {"middle", -3.0f}, {"treble", 2.0f}, {"level", -1.0f},
    }, false, error, NativeCatalogFxPath::Input));
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::array<float, kPreampTestFrames * 2U> inputOutput{};
    std::array<float, kPreampTestFrames * 2U> dryInputOutput{};
    assert(NativeAudioCoreTestAccess::callback(
        inputCore, signal.data(), inputOutput.data(), kPreampTestFrames) == 0);
    assert(NativeAudioCoreTestAccess::callback(
        dryInputCore, signal.data(), dryInputOutput.data(), kPreampTestFrames) == 0);
    assert(tailRms(inputOutput) > 0.01);
    assert(outputDifferenceRms(inputOutput, dryInputOutput) > 0.025);

    // Track FX deliberately uses a different model and tone setting. Its bank
    // processes only the playback bus, not the signal entering the loop buffer.
    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "preamp", {
        {"model", 3.0f}, {"gain", 86.0f}, {"bass", -5.0f},
        {"middle", 3.0f}, {"treble", -2.0f}, {"level", 1.5f},
    }, false, error, NativeCatalogFxPath::Track));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::array<float, kPreampTestFrames * 2U> trackOutput{};
    std::array<float, kPreampTestFrames * 2U> dryTrackOutput{};
    assert(NativeAudioCoreTestAccess::callback(
        trackCore, signal.data(), trackOutput.data(), kPreampTestFrames) == 0);
    assert(NativeAudioCoreTestAccess::callback(
        dryTrackCore, signal.data(), dryTrackOutput.data(), kPreampTestFrames) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    std::array<float, 128U> shortOutput{};
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(
        trackCore, nullptr, trackOutput.data(), kPreampTestFrames) == 0);
    assert(NativeAudioCoreTestAccess::callback(
        dryTrackCore, nullptr, dryTrackOutput.data(), kPreampTestFrames) == 0);
    assert(tailRms(trackOutput) > 0.01);
    assert(outputDifferenceRms(trackOutput, dryTrackOutput) > 0.025);
}

void testTwistCatalogRoutingThroughInputAndSharedTrackSlots() {
    std::vector<float> signal(kSynthRouteTestFrames);
    for (unsigned int frame = 0U; frame < kSynthRouteTestFrames; ++frame) {
        signal[frame] = 0.32f * std::sin(2.0f * 3.14159265358979323846f * 440.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    const std::map<std::string, float> parameters{
        {"amount_percent", 100.0f}, {"trajectory", 0.0f}, {"mix_percent", 100.0f},
    };
    std::string error;

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "twist", parameters,
        false, error, NativeCatalogFxPath::Input));
    const auto inputStatus = inputCore.getStatus();
    assert(inputStatus.nativeInputCatalogSlotEffectIds[0] == "twist");
    assert(inputStatus.nativeInputCatalogSlotEffectIds[1].empty());
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(kSynthRouteTestFrames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), kSynthRouteTestFrames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), kSynthRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 0U) > 0.02);

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "twist", parameters,
        false, error, NativeCatalogFxPath::Track));
    const auto trackStatus = trackCore.getStatus();
    assert(trackStatus.nativeCatalogSlotEffectIds[3] == "twist");
    assert(trackStatus.nativeCatalogSlotEffectIds[0].empty());
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), kSynthRouteTestFrames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), kSynthRouteTestFrames);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    std::array<float, 128U> shortOutput{};
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), kSynthRouteTestFrames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), kSynthRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 0U) > 0.02);
    NativeAudioCoreTestAccess::setRunning(inputCore, false);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, false);
    NativeAudioCoreTestAccess::setRunning(trackCore, false);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, false);
}

void testWarpRunsThroughInputAndTrackBanksAThroughD() {
    const std::map<std::string, float> parameters{
        {"bpm", 120.0f}, {"capture_beats", 0.25f}, {"smear_percent", 45.0f},
        {"pitch_semitones", 7.0f}, {"feedback_percent", 55.0f},
        {"freeze", 0.0f}, {"mix_percent", 100.0f},
    };
    std::string error;
    const std::array<NativeEffectSlot, 4U> slots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};

    // Verify both A-D banks accept WARP. This scoped route-only core releases
    // its fixed capture banks before the audio-through-route checks below.
    {
        NativeAudioCore routes;
        NativeAudioCoreTestAccess::prepareWithoutDevice(routes);
        for (const auto slot : slots) {
            error.clear();
            assert(routes.setNativeCatalogSlot(slot, "warp", parameters,
                false, error, NativeCatalogFxPath::Input));
            error.clear();
            assert(routes.setNativeCatalogSlot(slot, "warp", parameters,
                false, error, NativeCatalogFxPath::Track));
        }
        const auto status = routes.getStatus();
        for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
            assert(status.nativeInputCatalogSlotEffectIds[slot] == "warp");
            assert(status.nativeCatalogSlotEffectIds[slot] == "warp");
            assert(!status.nativeInputCatalogSlotBypassed[slot]);
            assert(!status.nativeCatalogSlotBypassed[slot]);
        }
        error.clear();
        assert(!routes.setNativeCatalogSlot(NativeEffectSlot::A, "warp",
            {{"spectral_mode", 1.0f}}, false, error, NativeCatalogFxPath::Track));
        assert(error.find("spectral_mode") != std::string::npos);
    }

    const auto signal = makeSynthRouteSignal();
    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "warp", parameters,
        false, error, NativeCatalogFxPath::Input));
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(signal.size() * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(),
        static_cast<unsigned int>(signal.size()));
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(),
        static_cast<unsigned int>(signal.size()));
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.01);
    for (const float sample : inputOutput) assert(std::isfinite(sample));

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "warp", parameters,
        false, error, NativeCatalogFxPath::Track));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::vector<float> trackOutput(signal.size() * 2U);
    std::vector<float> dryTrackOutput(trackOutput.size());
    callbackInChunks(trackCore, signal.data(), trackOutput.data(),
        static_cast<unsigned int>(signal.size()));
    callbackInChunks(dryTrackCore, signal.data(), dryTrackOutput.data(),
        static_cast<unsigned int>(signal.size()));
    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    std::array<float, 128U> shortOutput{};
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, trackOutput.data(), static_cast<unsigned int>(signal.size()));
    callbackInChunks(dryTrackCore, nullptr, dryTrackOutput.data(), static_cast<unsigned int>(signal.size()));
    assert(vectorDifferenceRms(trackOutput, dryTrackOutput, 4096U) > 0.01);
    for (const float sample : trackOutput) assert(std::isfinite(sample));
    NativeAudioCoreTestAccess::setRunning(inputCore, false);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, false);
    NativeAudioCoreTestAccess::setRunning(trackCore, false);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, false);
}

void testSynthRunsThroughInputAndSharedTrackPlaybackRoutes() {
    const auto signal = makeSynthRouteSignal();
    std::string error;
    const std::map<std::string, float> synthParameters{
        {"sensitivity", 80.0f}, {"waveform", 0.0f}, {"octave", 0.0f},
        {"tone", 4000.0f}, {"mix", 100.0f},
    };

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "synth", synthParameters,
        false, error, NativeCatalogFxPath::Input));
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(kSynthRouteTestFrames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), kSynthRouteTestFrames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), kSynthRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) > 0.02);

    // The Input bank's processed monitor signal is what the looper records.
    NativeAudioCoreTestAccess::command(inputCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::StopRecordOrPlayback);
    std::array<float, 128U> shortOutput{};
    assert(NativeAudioCoreTestAccess::callback(inputCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryInputCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Play);
    callbackInChunks(inputCore, nullptr, inputOutput.data(), kSynthRouteTestFrames);
    callbackInChunks(dryInputCore, nullptr, dryInputOutput.data(), kSynthRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) > 0.02);

    // Track SYNTH is on the one shared playback bus: live monitoring/recording
    // stays dry, then the recorded track is synthesized during playback.
    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::B, "synth", synthParameters,
        false, error, NativeCatalogFxPath::Track));
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    // Record two synchronized tracks to exercise the shared post-sum Track FX bus.
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record, false, 0U);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record, false, 1U);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record, false, 0U);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record, false, 1U);
    std::fill(inputOutput.begin(), inputOutput.end(), 0.0f);
    std::fill(dryInputOutput.begin(), dryInputOutput.end(), 0.0f);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), kSynthRouteTestFrames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), kSynthRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback, false, 0U);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback, false, 1U);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback, false, 0U);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback, false, 1U);
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play, false, 0U);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play, false, 1U);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play, false, 0U);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play, false, 1U);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), kSynthRouteTestFrames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), kSynthRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) > 0.02);
}

void testG2BRunsThroughNativeInputAndSharedTrackPlaybackRoutes() {
    std::vector<float> signal(kG2BRouteTestFrames);
    for (unsigned int frame = 0U; frame < kG2BRouteTestFrames; ++frame) {
        signal[frame] = 0.32f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    const std::map<std::string, float> parameters{
        {"tracking_percent", 100.0f}, {"blend_percent", 100.0f}, {"body_hz", 1000.0f},
    };
    std::string error;

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "g2b", parameters,
        false, error, NativeCatalogFxPath::Input));
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(kG2BRouteTestFrames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);

    // Input G2B is part of the recorded loop path as well as monitoring.
    NativeAudioCoreTestAccess::command(inputCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::StopRecordOrPlayback);
    std::array<float, 128U> shortOutput{};
    assert(NativeAudioCoreTestAccess::callback(inputCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryInputCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Play);
    callbackInChunks(inputCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);

    // Track G2B is excluded from record/live monitor and only alters playback.
    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::B, "g2b", parameters,
        false, error, NativeCatalogFxPath::Track));
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::fill(inputOutput.begin(), inputOutput.end(), 0.0f);
    std::fill(dryInputOutput.begin(), dryInputOutput.end(), 0.0f);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);
}

void testRobotRunsThroughNativeInputAndTrackSlotsAThroughD() {
    constexpr double kPi = 3.14159265358979323846;
    const std::array<NativeEffectSlot, 4U> slots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};
    const std::map<std::string, float> parameters{
        {"pitch_semitones", 7.0f}, {"formant_semitones", 0.0f}, {"mix_percent", 100.0f},
    };
    std::vector<float> signal(kRobotRouteTestFrames);
    for (unsigned int frame = 0U; frame < kRobotRouteTestFrames; ++frame) {
        signal[frame] = 0.32f * std::sin(2.0 * kPi * 220.0 * static_cast<double>(frame) / 48000.0);
    }
    std::string error;

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    for (const auto slot : slots) {
        error.clear();
        assert(inputCore.setNativeCatalogSlot(slot, "robot", parameters, false, error,
            NativeCatalogFxPath::Input));
    }
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(kRobotRouteTestFrames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), kRobotRouteTestFrames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), kRobotRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) > 0.01);
    const auto inputStatus = inputCore.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(inputStatus.nativeInputCatalogSlotEffectIds[slot] == "robot");
        assert(!inputStatus.nativeInputCatalogSlotBypassed[slot]);
    }

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    for (const auto slot : slots) {
        error.clear();
        assert(trackCore.setNativeCatalogSlot(slot, "robot", parameters, false, error,
            NativeCatalogFxPath::Track));
    }
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), kRobotRouteTestFrames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), kRobotRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    std::array<float, 128U> shortOutput{};
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), kRobotRouteTestFrames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), kRobotRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) > 0.01);
    const auto trackStatus = trackCore.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(trackStatus.nativeCatalogSlotEffectIds[slot] == "robot");
        assert(!trackStatus.nativeCatalogSlotBypassed[slot]);
    }
}

void testElectricRunsThroughInputAndSharedTrackSlotsAThroughD() {
    constexpr unsigned int frames = 8192U;
    constexpr double pi = 3.14159265358979323846;
    const std::array<NativeEffectSlot, 4U> slots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};
    std::vector<float> signal(frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        signal[frame] = 0.28f * static_cast<float>(std::sin(
            2.0 * pi * 220.0 * static_cast<double>(frame) / 48000.0));
    }
    std::string error;
    const auto* descriptor = findNativeEffectDescriptor("electric");
    assert(descriptor != nullptr && descriptor->sourceIndex == 17);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);

    const auto parametersForCharacter = [](unsigned int character) {
        return std::map<std::string, float>{
            {"character", static_cast<float>(character)}, {"pitch-snap", 100.0f},
            {"tone", 16000.0f}, {"mix", 100.0f},
        };
    };

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    for (std::size_t slotIndex = 0U; slotIndex < slots.size(); ++slotIndex) {
        error.clear();
        assert(inputCore.setNativeCatalogSlot(slots[slotIndex], "electric",
            parametersForCharacter(static_cast<unsigned int>(slotIndex)), false, error,
            NativeCatalogFxPath::Input));
    }
    const auto configuredInput = inputCore.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(configuredInput.nativeInputCatalogSlotEffectIds[slot] == "electric");
        assert(!configuredInput.nativeInputCatalogSlotBypassed[slot]);
    }
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(frames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), frames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), frames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 2048U) > 0.01);
    for (std::size_t frame = 2048U; frame < frames; ++frame) {
        assert(std::isfinite(inputOutput[frame * 2U]));
        assert(std::isfinite(inputOutput[frame * 2U + 1U]));
    }

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    for (std::size_t slotIndex = 0U; slotIndex < slots.size(); ++slotIndex) {
        error.clear();
        assert(trackCore.setNativeCatalogSlot(slots[slotIndex], "electric",
            parametersForCharacter(static_cast<unsigned int>(slotIndex)), false, error,
            NativeCatalogFxPath::Track));
    }
    const auto configuredTrack = trackCore.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(configuredTrack.nativeCatalogSlotEffectIds[slot] == "electric");
        assert(!configuredTrack.nativeCatalogSlotBypassed[slot]);
    }
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::fill(inputOutput.begin(), inputOutput.end(), 0.0f);
    std::fill(dryInputOutput.begin(), dryInputOutput.end(), 0.0f);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), frames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), frames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 2048U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    std::array<float, 128U> shortOutput{};
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), frames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), frames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 2048U) > 0.01);
    for (std::size_t frame = 2048U; frame < frames; ++frame) {
        assert(std::isfinite(inputOutput[frame * 2U]));
        assert(std::isfinite(inputOutput[frame * 2U + 1U]));
    }
}

void testSignalsmithTransposeRunsThroughNativeInputAndTrackBanks() {
    std::vector<float> signal(kG2BRouteTestFrames);
    for (unsigned int frame = 0U; frame < kG2BRouteTestFrames; ++frame) {
        signal[frame] = 0.32f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    const std::map<std::string, float> parameters{
        {"shift_semitones", 12.0f}, {"mix_percent", 100.0f},
    };
    std::string error;
    std::array<float, 128U> shortOutput{};

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "transpose", parameters,
        false, error, NativeCatalogFxPath::Input));
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(kG2BRouteTestFrames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) > 0.02);

    NativeAudioCoreTestAccess::command(inputCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(inputCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryInputCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Play);
    callbackInChunks(inputCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) > 0.02);

    // Track TRANSPOSE is after recording and monitor, on the shared playback
    // bank. This guards the real Native FX route rather than the standalone
    // processor/catalog factory only.
    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "transpose", parameters,
        false, error, NativeCatalogFxPath::Track));
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::fill(inputOutput.begin(), inputOutput.end(), 0.0f);
    std::fill(dryInputOutput.begin(), dryInputOutput.end(), 0.0f);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 8192U) > 0.02);
}

void testPitchBendRunsThroughNativeInputAndTrackBanks() {
    std::vector<float> signal(kG2BRouteTestFrames);
    for (unsigned int frame = 0U; frame < kG2BRouteTestFrames; ++frame) {
        signal[frame] = 0.32f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    const std::map<std::string, float> parameters{
        {"range", 12.0f}, {"time_ms", 200.0f}, {"direction", 0.0f}, {"mix_percent", 100.0f},
    };
    const std::map<std::string, float> invalidParameters{{"time_ms", 4000.1f}};
    std::string error;
    std::array<float, 128U> shortOutput{};

    const auto* descriptor = findNativeEffectDescriptor("pitch_bend");
    assert(descriptor != nullptr && descriptor->sourceIndex == 15);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "pitch_bend", parameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    assert(!inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "pitch_bend", invalidParameters,
        false, error, NativeCatalogFxPath::Input));
    assert(error.find("time_ms") != std::string::npos);
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(kG2BRouteTestFrames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);

    NativeAudioCoreTestAccess::command(inputCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(inputCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryInputCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Play);
    callbackInChunks(inputCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "pitch_bend", parameters,
        false, error, NativeCatalogFxPath::Track));
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::fill(inputOutput.begin(), inputOutput.end(), 0.0f);
    std::fill(dryInputOutput.begin(), dryInputOutput.end(), 0.0f);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);
}

void testManualHarmonistRunsThroughNativeInputAndTrackBanks() {
    std::vector<float> signal(kG2BRouteTestFrames);
    for (unsigned int frame = 0U; frame < kG2BRouteTestFrames; ++frame) {
        signal[frame] = 0.32f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    const std::map<std::string, float> parameters{
        {"voice_1_interval", 7.0f}, {"voice_2_interval", 12.0f},
        {"pan_percent", 0.0f}, {"mix_percent", 100.0f},
    };
    const std::map<std::string, float> invalidParameters{{"voice_2_interval", 24.1f}};
    std::string error;
    std::array<float, 128U> shortOutput{};

    const auto* descriptor = findNativeEffectDescriptor("hrm_manual");
    assert(descriptor != nullptr && descriptor->sourceIndex == 18);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "hrm_manual", parameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    assert(!inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "hrm_manual", invalidParameters,
        false, error, NativeCatalogFxPath::Input));
    assert(error.find("voice_2_interval") != std::string::npos);
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(kG2BRouteTestFrames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);

    NativeAudioCoreTestAccess::command(inputCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(inputCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryInputCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Play);
    callbackInChunks(inputCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "hrm_manual", parameters,
        false, error, NativeCatalogFxPath::Track));
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::fill(inputOutput.begin(), inputOutput.end(), 0.0f);
    std::fill(dryInputOutput.begin(), dryInputOutput.end(), 0.0f);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);
}

void testOctaveRunsThroughMonoNativeInputAndSharedTrackSlotsAThroughD() {
    std::vector<float> signal(kG2BRouteTestFrames);
    for (unsigned int frame = 0U; frame < kG2BRouteTestFrames; ++frame) {
        signal[frame] = 0.32f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    const std::map<std::string, float> parameters{
        {"minus_24_level", 0.0f}, {"minus_12_level", 100.0f},
        {"plus_12_level", 0.0f}, {"mix_percent", 100.0f},
    };
    std::string error;
    std::array<float, 128U> shortOutput{};
    const std::array<NativeEffectSlot, 4U> slots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};

    const auto* descriptor = findNativeEffectDescriptor("octave");
    assert(descriptor != nullptr && descriptor->sourceIndex == 28);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "octave", parameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    assert(!inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "octave",
        {{"tracking_percent", 60.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("tracking_percent") != std::string::npos);
    error.clear();
    assert(!inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "octave",
        {{"formant", 0.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("formant") != std::string::npos);
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(kG2BRouteTestFrames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);
    for (std::size_t frame = 4096U; frame < kG2BRouteTestFrames; ++frame) {
        assert(std::isfinite(inputOutput[frame * 2U]));
        assert(std::isfinite(inputOutput[frame * 2U + 1U]));
        assert(std::fabs(inputOutput[frame * 2U] - inputOutput[frame * 2U + 1U]) < 1.0e-5f);
    }

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    for (const auto slot : slots) {
        error.clear();
        assert(trackCore.setNativeCatalogSlot(slot, "octave", parameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto trackRoutes = trackCore.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(trackRoutes.nativeCatalogSlotEffectIds[slot] == "octave");
        assert(!trackRoutes.nativeCatalogSlotBypassed[slot]);
    }

    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::fill(inputOutput.begin(), inputOutput.end(), 0.0f);
    std::fill(dryInputOutput.begin(), dryInputOutput.end(), 0.0f);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), kG2BRouteTestFrames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), kG2BRouteTestFrames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 4096U) > 0.02);
    for (std::size_t frame = 4096U; frame < kG2BRouteTestFrames; ++frame) {
        assert(std::isfinite(inputOutput[frame * 2U]));
        assert(std::isfinite(inputOutput[frame * 2U + 1U]));
    }
}

void testVocoderRunsThroughNativeInputAndSharedTrackSlotsAThroughD() {
    constexpr unsigned int frames = 8192U;
    std::vector<float> signal(frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        signal[frame] = 0.28f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    const std::map<std::string, float> parameters{
        {"bands", 16.0f}, {"carrier", 1.0f}, {"mix_percent", 100.0f},
    };
    std::string error;
    const auto* descriptor = findNativeEffectDescriptor("vocoder");
    assert(descriptor != nullptr && descriptor->sourceIndex == 20);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    std::array<float, 128U> shortOutput{};

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder", parameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    assert(!inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder",
        {{"bands", 7.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("bands") != std::string::npos);
    error.clear();
    assert(!inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder",
        {{"carrier", 3.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("carrier") != std::string::npos);
    error.clear();
    assert(!inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder",
        {{"formant", 0.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("formant") != std::string::npos);
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(frames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), frames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), frames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 2048U) > 0.015);
    for (std::size_t frame = 2048U; frame < frames; ++frame) {
        assert(std::isfinite(inputOutput[frame * 2U]));
        assert(std::isfinite(inputOutput[frame * 2U + 1U]));
        assert(std::fabs(inputOutput[frame * 2U] - inputOutput[frame * 2U + 1U]) < 1.0e-5f);
    }

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    const std::array<NativeEffectSlot, 4U> slots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};
    for (const auto slot : slots) {
        error.clear();
        assert(trackCore.setNativeCatalogSlot(slot, "vocoder", parameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto trackRoutes = trackCore.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(trackRoutes.nativeCatalogSlotEffectIds[slot] == "vocoder");
        assert(!trackRoutes.nativeCatalogSlotBypassed[slot]);
    }
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::fill(inputOutput.begin(), inputOutput.end(), 0.0f);
    std::fill(dryInputOutput.begin(), dryInputOutput.end(), 0.0f);
    callbackInChunks(trackCore, signal.data(), inputOutput.data(), frames);
    callbackInChunks(dryTrackCore, signal.data(), dryInputOutput.data(), frames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 2048U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, inputOutput.data(), frames);
    callbackInChunks(dryTrackCore, nullptr, dryInputOutput.data(), frames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 2048U) > 0.015);
    for (std::size_t frame = 2048U; frame < frames; ++frame) {
        assert(std::isfinite(inputOutput[frame * 2U]));
        assert(std::isfinite(inputOutput[frame * 2U + 1U]));
    }
}

void testOscBotRunsThroughSelectedInputAndSharedTrackSlots() {
    constexpr unsigned int frames = 8192U;
    std::vector<float> signal(frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        signal[frame] = 0.28f * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
                                        static_cast<float>(frame) / 48000.0f);
    }
    const std::map<std::string, float> parameters{
        {"bands", 16.0f}, {"waveform", 1.0f}, {"pattern", 3.0f},
        {"tone", 8000.0f}, {"tempo", 120.0f}, {"mix", 100.0f},
    };
    const auto* descriptor = findNativeEffectDescriptor("osc_bot");
    assert(descriptor != nullptr && descriptor->sourceIndex == 22);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    std::string error;
    std::array<float, 128U> shortOutput{};

    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::B, "osc_bot", parameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    assert(!inputCore.setNativeCatalogSlot(NativeEffectSlot::B, "osc_bot",
        {{"pattern", 8.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("pattern") != std::string::npos);
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(static_cast<std::size_t>(frames) * 2U);
    std::vector<float> dryInputOutput(inputOutput.size());
    callbackInChunks(inputCore, signal.data(), inputOutput.data(), frames);
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(), frames);
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 2048U) > 0.01);
    const auto inputStatus = inputCore.getStatus();
    assert(inputStatus.nativeInputCatalogSlotEffectIds[1] == "osc_bot");
    assert(inputStatus.nativeInputCatalogSlotEffectIds[0].empty());
    for (std::size_t sample = 0U; sample < inputOutput.size(); ++sample) {
        assert(std::isfinite(inputOutput[sample]));
    }

    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "osc_bot", parameters,
        false, error, NativeCatalogFxPath::Track));
    assert(trackCore.setMonitoring(true, error));
    assert(dryTrackCore.setMonitoring(true, error));
    const auto trackStatus = trackCore.getStatus();
    assert(trackStatus.nativeCatalogSlotEffectIds[3] == "osc_bot");
    assert(trackStatus.nativeCatalogSlotEffectIds[0].empty());
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::vector<float> trackOutput(inputOutput.size(), 0.0f);
    std::vector<float> dryTrackOutput(trackOutput.size(), 0.0f);
    callbackInChunks(trackCore, signal.data(), trackOutput.data(), frames);
    callbackInChunks(dryTrackCore, signal.data(), dryTrackOutput.data(), frames);
    assert(vectorDifferenceRms(trackOutput, dryTrackOutput, 2048U) < 1.0e-6);

    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    callbackInChunks(trackCore, nullptr, trackOutput.data(), frames);
    callbackInChunks(dryTrackCore, nullptr, dryTrackOutput.data(), frames);
    assert(vectorDifferenceRms(trackOutput, dryTrackOutput, 2048U) > 0.01);
    for (std::size_t sample = 0U; sample < trackOutput.size(); ++sample) {
        assert(std::isfinite(trackOutput[sample]));
    }
}

void testFreezeRunsThroughInputBypassAndTrackSharedPlayback() {
    const auto signal = makePreampTestSignal();
    const std::map<std::string, float> parameters{
        {"capture_ms", 20.0f}, {"mode", 0.0f}, {"pitch_semitones", 0.0f},
        {"freeze", 0.0f}, {"mix_percent", 100.0f},
    };
    std::string error;

    // The Input bank must keep pre-roll capture active while its host bypass
    // is on, then expose the captured loop when the slot is unbypassed.
    NativeAudioCore inputCore;
    NativeAudioCore dryInputCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(inputCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryInputCore);
    NativeAudioCoreTestAccess::setInputChannels(inputCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryInputCore, 1U);
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "freeze", parameters,
        true, error, NativeCatalogFxPath::Input));
    assert(inputCore.setMonitoring(true, error));
    assert(dryInputCore.setMonitoring(true, error));
    NativeAudioCoreTestAccess::setRunning(inputCore, true);
    NativeAudioCoreTestAccess::setRunning(dryInputCore, true);
    NativeAudioCoreTestAccess::command(inputCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryInputCore, CommandType::Record);
    std::vector<float> inputOutput(signal.size() * 2U, 0.0f);
    std::vector<float> dryInputOutput(signal.size() * 2U, 0.0f);
    callbackInChunks(inputCore, signal.data(), inputOutput.data(),
        static_cast<unsigned int>(signal.size()));
    callbackInChunks(dryInputCore, signal.data(), dryInputOutput.data(),
        static_cast<unsigned int>(signal.size()));
    assert(vectorDifferenceRms(inputOutput, dryInputOutput, 0U) < 1.0e-6);

    error.clear();
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "freeze", {{"freeze", 1.0f}},
        true, error, NativeCatalogFxPath::Input));
    const float zero = 0.0f;
    std::array<float, 2U> triggerOutput{};
    assert(NativeAudioCoreTestAccess::callback(inputCore, &zero, triggerOutput.data(), 1U) == 0);
    error.clear();
    assert(inputCore.setNativeCatalogSlot(NativeEffectSlot::A, "freeze", {},
        false, error, NativeCatalogFxPath::Input));
    std::vector<float> silence(2048U, 0.0f);
    std::vector<float> frozenInputOutput(silence.size() * 2U, 0.0f);
    std::vector<float> drySilenceOutput(silence.size() * 2U, 0.0f);
    callbackInChunks(inputCore, silence.data(), frozenInputOutput.data(),
        static_cast<unsigned int>(silence.size()));
    callbackInChunks(dryInputCore, silence.data(), drySilenceOutput.data(),
        static_cast<unsigned int>(silence.size()));
    assert(vectorDifferenceRms(frozenInputOutput, drySilenceOutput, 512U) > 0.02);

    // Track FREEZE reads the shared playback bus. Slot D is exercised here;
    // the adjacent route test configures the same processor in all A-D slots.
    NativeAudioCore trackCore;
    NativeAudioCore dryTrackCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(trackCore);
    NativeAudioCoreTestAccess::prepareWithoutDevice(dryTrackCore);
    NativeAudioCoreTestAccess::setInputChannels(trackCore, 1U);
    NativeAudioCoreTestAccess::setInputChannels(dryTrackCore, 1U);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "freeze", parameters,
        true, error, NativeCatalogFxPath::Track));
    NativeAudioCoreTestAccess::setRunning(trackCore, true);
    NativeAudioCoreTestAccess::setRunning(dryTrackCore, true);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Record);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Record);
    std::vector<float> recordOutput(signal.size() * 2U, 0.0f);
    std::vector<float> dryRecordOutput(recordOutput.size(), 0.0f);
    callbackInChunks(trackCore, signal.data(), recordOutput.data(),
        static_cast<unsigned int>(signal.size()));
    callbackInChunks(dryTrackCore, signal.data(), dryRecordOutput.data(),
        static_cast<unsigned int>(signal.size()));
    NativeAudioCoreTestAccess::command(trackCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::StopRecordOrPlayback);
    std::array<float, 128U> shortOutput{};
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(dryTrackCore, nullptr, shortOutput.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(trackCore, CommandType::Play);
    NativeAudioCoreTestAccess::command(dryTrackCore, CommandType::Play);
    std::vector<float> playbackOutput(signal.size() * 2U, 0.0f);
    std::vector<float> dryPlaybackOutput(playbackOutput.size(), 0.0f);
    callbackInChunks(trackCore, nullptr, playbackOutput.data(),
        static_cast<unsigned int>(signal.size()));
    callbackInChunks(dryTrackCore, nullptr, dryPlaybackOutput.data(),
        static_cast<unsigned int>(signal.size()));

    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "freeze", {{"freeze", 1.0f}},
        true, error, NativeCatalogFxPath::Track));
    assert(NativeAudioCoreTestAccess::callback(trackCore, nullptr, shortOutput.data(), 1U) == 0);
    error.clear();
    assert(trackCore.setNativeCatalogSlot(NativeEffectSlot::D, "freeze", {},
        false, error, NativeCatalogFxPath::Track));
    std::vector<float> playbackAfterFreeze(signal.size() * 2U, 0.0f);
    std::vector<float> dryPlaybackAfterFreeze(playbackAfterFreeze.size(), 0.0f);
    callbackInChunks(trackCore, nullptr, playbackAfterFreeze.data(),
        static_cast<unsigned int>(signal.size()));
    callbackInChunks(dryTrackCore, nullptr, dryPlaybackAfterFreeze.data(),
        static_cast<unsigned int>(signal.size()));
    assert(vectorDifferenceRms(playbackAfterFreeze, dryPlaybackAfterFreeze, 512U) > 0.02);
}

void testReverseReverbInputAndTrackTempoFollowNativeRhythmConfig() {
    constexpr unsigned int kProbeFrames = 11000U;
    constexpr unsigned int kProcessBlock = 1024U;
    const std::map<std::string, float> parameters{
        {"segment_beats", 0.25f}, {"feedback_percent", 0.0f}, {"crossfade_ms", 20.0f},
        {"decay_seconds", 2.0f}, {"damping_cutoff_hz", 8000.0f}, {"mix_percent", 100.0f},
    };
    std::string error;

    const auto renderInputBank = [&](double rhythmBpm) {
        NativeAudioCore core;
        NativeAudioCoreTestAccess::prepareWithoutDevice(core);
        NativeAudioCoreTestAccess::setInputChannels(core, 1U);
        error.clear();
        assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "reverse_reverb", parameters,
            false, error, NativeCatalogFxPath::Input));
        if (rhythmBpm != 120.0) {
            auto rhythm = NativeRhythmConfig{};
            rhythm.bpm = rhythmBpm;
            error.clear();
            assert(core.setNativeRhythmConfig(rhythm, error));
        }

        std::vector<float> input(kProbeFrames, 0.0f);
        input[100U] = 0.8f;
        std::vector<float> output(kProbeFrames, 0.0f);
        for (unsigned int offset = 0U; offset < kProbeFrames;) {
            const unsigned int frames = std::min(kProcessBlock, kProbeFrames - offset);
            const float* processed = NativeAudioCoreTestAccess::processInputFx(core, input.data() + offset, frames);
            assert(processed != nullptr);
            std::copy_n(processed, frames, output.data() + offset);
            offset += frames;
        }
        return output;
    };

    const auto slowTempoOutput = renderInputBank(120.0);
    const auto fastTempoOutput = renderInputBank(300.0);
    double slowWindowEnergy = 0.0;
    double fastWindowEnergy = 0.0;
    for (std::size_t frame = 8000U; frame < kProbeFrames; ++frame) {
        slowWindowEnergy += static_cast<double>(slowTempoOutput[frame]) * slowTempoOutput[frame];
        fastWindowEnergy += static_cast<double>(fastTempoOutput[frame]) * fastTempoOutput[frame];
    }
    assert(fastWindowEnergy > 1.0e-8);
    assert(fastWindowEnergy > slowWindowEnergy * 100.0);
}

void testAutoRiffInputTempoFollowsNativeRhythmTransport() {
    constexpr unsigned int kProbeFrames = 48000U;
    constexpr unsigned int kProcessBlock = 512U;
    const std::map<std::string, float> parameters{
        {"scale", 1.0f}, {"rate_beats", 0.25f}, {"sensitivity_percent", 75.0f}, {"mix_percent", 100.0f},
    };
    const auto renderAtTempo = [&](double rhythmBpm, bool whileRunning = false) {
        NativeAudioCore core;
        NativeAudioCoreTestAccess::prepareWithoutDevice(core);
        NativeAudioCoreTestAccess::setInputChannels(core, 1U);
        std::string error;
        // Omitting effect BPM inherits the default rhythm transport. Changing
        // the transport afterward must synchronize the already-installed slot.
        assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "auto_riff", parameters,
            false, error, NativeCatalogFxPath::Input));
        if (rhythmBpm != 120.0) {
            if (whileRunning) NativeAudioCoreTestAccess::setRunning(core, true);
            auto rhythm = NativeRhythmConfig{};
            rhythm.bpm = rhythmBpm;
            error.clear();
            assert(core.setNativeRhythmConfig(rhythm, error));
        }

        std::vector<float> input(kProbeFrames, 0.0f);
        std::vector<float> output(kProbeFrames, 0.0f);
        for (unsigned int frame = 0U; frame < kProbeFrames; ++frame) {
            const float attack = std::min(1.0f, static_cast<float>(frame) / 192.0f);
            input[frame] = 0.32f * attack * std::sin(2.0f * 3.14159265358979323846f * 220.0f *
                static_cast<float>(frame) / 48000.0f);
        }
        for (unsigned int offset = 0U; offset < kProbeFrames;) {
            const unsigned int frames = std::min(kProcessBlock, kProbeFrames - offset);
            const float* processed = NativeAudioCoreTestAccess::processInputFx(core, input.data() + offset, frames);
            assert(processed != nullptr);
            std::copy_n(processed, frames, output.data() + offset);
            offset += frames;
        }
        return output;
    };

    const auto slowTempoOutput = renderAtTempo(120.0);
    const auto fastTempoOutput = renderAtTempo(300.0);
    const auto queuedFastTempoOutput = renderAtTempo(300.0, true);
    double differenceEnergy = 0.0;
    std::size_t comparedSamples = 0U;
    for (std::size_t frame = 12000U; frame < kProbeFrames; ++frame) {
        const double difference = static_cast<double>(slowTempoOutput[frame] - fastTempoOutput[frame]);
        differenceEnergy += difference * difference;
        ++comparedSamples;
    }
    const double differenceRms = std::sqrt(differenceEnergy / static_cast<double>(comparedSamples));
    assert(differenceRms > 0.01);
    double queuedDifferenceEnergy = 0.0;
    for (std::size_t frame = 0U; frame < kProbeFrames; ++frame) {
        const double difference = static_cast<double>(fastTempoOutput[frame] - queuedFastTempoOutput[frame]);
        queuedDifferenceEnergy += difference * difference;
    }
    const double queuedDifferenceRms = std::sqrt(queuedDifferenceEnergy / static_cast<double>(kProbeFrames));
    assert(queuedDifferenceRms < 1.0e-6);
}

void testOfficialControlsTraverseLiveHostQueue() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    std::size_t effectCount = 0U;
    const auto* effects = nativeEffectCatalog(effectCount);
    std::array<float, 512U> input{};
    for (std::size_t i = 0U; i < input.size(); ++i) input[i] = 0.1f * std::sin(static_cast<float>(i) * 0.17f);
    for (std::size_t e = 0U; e < effectCount; ++e) {
        std::size_t count = 0U;
        const auto* descriptors = nativeEffectOfficialParameters(effects[e].id, count);
        if (count == 0U) continue;
        const bool variants = effects[e].id == "tape_echo" || effects[e].id == "roll";
        for (unsigned int variant = variants ? 1U : 0U; variant <= (variants ? 2U : 0U); ++variant) {
            std::map<std::string, float> defaults{{"official_bpm", 120.0f}}, updates{{"official_bpm", 180.0f}, {"official_quarter_notes_per_measure", 3.5f}};
            if (variants) { defaults["official_variant"] = static_cast<float>(variant); updates["official_variant"] = static_cast<float>(variant); }
            const auto domainId = nativeEffectOfficialDomainId(effects[e].id, variant);
            for (std::size_t i = 0U; i < count; ++i) {
                const auto* domain = official::parameterDomain(domainId, descriptors[i].id);
                if (!domain) continue;
                defaults[std::string(descriptors[i].id)] = domain->hasDefault ? domain->defaultValue : descriptors[i].defaultValue;
                float maximum = domain->step > 0.0f ? domain->maximum : official::kDomainOptions[domain->offset];
                for (std::size_t choice = 0U; choice < domain->count; ++choice)
                    maximum = std::max(maximum, official::kDomainOptions[domain->offset + choice]);
                updates[std::string(descriptors[i].id)] = maximum;
            }
            const auto path = effects[e].inputAvailable ? NativeCatalogFxPath::Input : NativeCatalogFxPath::Track;
            std::string error;
            NativeAudioCoreTestAccess::setRunning(core, false);
            assert(core.setNativeCatalogSlot(NativeEffectSlot::A, std::string(effects[e].id), defaults, false, error, path));
            NativeAudioCoreTestAccess::setRunning(core, true);
            assert(core.setNativeCatalogSlot(NativeEffectSlot::A, std::string(effects[e].id), updates, false, error, path));
            auto trackOutput = input;
            const float* output = trackOutput.data();
            if (path == NativeCatalogFxPath::Input) output = NativeAudioCoreTestAccess::processInputFx(core, input.data(), 256U);
            else NativeAudioCoreTestAccess::processSharedTrackFx(core, trackOutput.data(), 256U);
            assert(output != nullptr);
            for (std::size_t i = 0U; i < input.size(); ++i) assert(std::isfinite(output[i]));
            assert(core.getStatus().nativeCatalogControlFaultCount == 0U);
        }
    }
    NativeAudioCoreTestAccess::setRunning(core, false);
}

void testVariantQueueUsesProspectiveBranch() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    std::string error;
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_variant", 1.0f}, {"official_bass", 20.0f}}, false, error, NativeCatalogFxPath::Input));
    NativeAudioCoreTestAccess::setRunning(core, true);
    // No callback is allowed between these edits: pending selector must already
    // control validation, and a rejected cross-branch batch must be atomic.
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_variant", 2.0f}, {"official_high_cut", 4000.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_low_cut", 200.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_variant", 1.0f}, {"official_high_cut", 3000.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_low_cut", 300.0f}}, false, error, NativeCatalogFxPath::Input));
    std::array<float, 128U> input{};
    assert(NativeAudioCoreTestAccess::processInputFx(core, input.data(), 64U));
    assert(core.getStatus().nativeCatalogControlFaultCount == 0U);
    // Switching back exercises lexical BASS-before-VARIANT ordering.
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_variant", 1.0f}, {"official_bass", -20.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(NativeAudioCoreTestAccess::processInputFx(core, input.data(), 64U));
    assert(core.getStatus().nativeCatalogControlFaultCount == 0U);
    NativeAudioCoreTestAccess::setRunning(core, false);
}

void testParameterReplacementCannotAcknowledgeStaleState() {
    NativeAudioCore core; NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    std::string error;
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "step_slicer",
        {{"official_depth", 0.0f}, {"official_comp_gain", 20.0f}}, false, error, NativeCatalogFxPath::Input, 0U, true));
    NativeAudioCoreTestAccess::setRunning(core, true);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "step_slicer", {}, false, error, NativeCatalogFxPath::Input));
    std::vector<float> input(4096U, 0.01f);
    const auto* wet = NativeAudioCoreTestAccess::processInputFx(core, input.data(), 2048U); assert(wet);
    const float oldGain = wet[4094U];
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "step_slicer",
        {{"official_depth", 0.0f}}, false, error, NativeCatalogFxPath::Input, 0U, true));
    assert(error.find("Stop Native audio") != std::string::npos);
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "step_slicer", {}, false, error, NativeCatalogFxPath::Input, 0U, true));
    NativeAudioCoreTestAccess::setRunning(core, false);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "step_slicer",
        {{"official_depth", 0.0f}}, false, error, NativeCatalogFxPath::Input, 0U, true));
    wet = NativeAudioCoreTestAccess::processInputFx(core, input.data(), 2048U); assert(wet);
    assert(oldGain > 0.08f && wet[4094U] < oldGain * 0.3f);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_variant", 1.0f}, {"official_bass", 20.0f}}, false, error, NativeCatalogFxPath::Input, 0U, true));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo", {}, false, error, NativeCatalogFxPath::Input, 0U, true));
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_bass", 20.0f}}, false, error, NativeCatalogFxPath::Input));
    // Explicit branch changes can reset branch state safely without restarting.
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_variant", 1.0f}, {"official_bass", 20.0f}}, false, error, NativeCatalogFxPath::Input, 0U, true));
    NativeAudioCoreTestAccess::setRunning(core, true);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "tape_echo",
        {{"official_variant", 2.0f}, {"official_high_cut", 4000.0f}}, false, error, NativeCatalogFxPath::Input, 0U, true));
    assert(NativeAudioCoreTestAccess::processInputFx(core, input.data(), 2048U));
    assert(core.getStatus().nativeCatalogControlFaultCount == 0U);
    NativeAudioCoreTestAccess::setRunning(core, false);
}

void testOfficialSourceChunkInvariance() {
    for (const auto id : {"vinyl_flick", "beat_shift"}) {
        const auto render = [id](unsigned int chunk) {
            NativeAudioCore core; NativeAudioCoreTestAccess::prepareWithoutDevice(core);
            NativeAudioCoreTestAccess::setInputChannels(core, 0U);
            std::vector<float> loop(9600U);
            for (std::size_t f = 0; f < 4800U; ++f) {
                loop[f * 2U] = 0.1f * std::sin(static_cast<float>(f) * 6.28318530718f / 4800.0f);
                loop[f * 2U + 1U] = -0.5f * loop[f * 2U];
            }
            NativeAudioCoreTestAccess::loadSourceLoop(core, loop);
            const std::map<std::string, float> controls = std::string_view(id) == "vinyl_flick"
                ? std::map<std::string, float>{{"official_flick", 100.0f}, {"motor_return_seconds", 0.05f}}
                : std::map<std::string, float>{{"official_shift", -0.25f}, {"official_bpm", 113.0f}};
            std::string error; assert(core.setNativeCatalogSlot(NativeEffectSlot::A, id, controls, false, error));
            NativeAudioCoreTestAccess::setRunning(core, true);
            std::vector<float> result(32768U);
            for (unsigned int f = 0; f < 16384U;) {
                const auto frames = std::min(chunk, 16384U - f);
                assert(NativeAudioCoreTestAccess::callback(core, nullptr, result.data() + f * 2U, frames) == 0);
                f += frames;
            }
            NativeAudioCoreTestAccess::setRunning(core, false); return result;
        };
        assert(vectorDifferenceRms(render(13U), render(127U), 0U) < 1.0e-7);
    }
}

void testOfficialSourceReadheadsAndRestoration() {
    NativeAudioCore core; NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 0U);
    std::string error;
    std::vector<float> ramp(96000U);
    for (std::size_t f = 0; f < ramp.size() / 2U; ++f) { ramp[f * 2U] = static_cast<float>(f) * 1.0e-6f; ramp[f * 2U + 1U] = -ramp[f * 2U] * 0.5f; }
    NativeAudioCoreTestAccess::loadSourceLoop(core, ramp);
    std::array<LoopTransportConfig, kNativeTrackCount> originals{};
    for (std::size_t t = 0; t < kNativeTrackCount; ++t) {
        originals[t].mode = LoopTransportMode::BeatShift;
        originals[t].beatOffsetBeats = -0.125f * static_cast<float>(t + 1U);
        originals[t].bpm = 120.0f + static_cast<float>(t);
        assert(core.setNativeLoopTransport(t, originals[t], error));
    }
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "beat_shift",
        {{"official_type", 0.0f}, {"official_shift", -0.25f}, {"official_bpm", 120.0f}}, false, error));
    NativeAudioCoreTestAccess::setRunning(core, true);
    std::vector<float> output(2048U);
    callbackInChunks(core, nullptr, output.data(), 1024U);
    assert(std::fabs(output[2046U] - ramp[2U * (1023U + 6000U)]) < 1.0e-6f);
    assert(std::fabs(output[2047U] - ramp[2U * (1023U + 6000U) + 1U]) < 1.0e-6f);
    assert(core.getStatus().nativeTrackLoopTransportStatus[0] == LoopTransportStatus::Active);
    // PAST is a genuinely different stored-loop location, not delayed live input.
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "beat_shift", {{"official_type", 1.0f}}, false, error));
    callbackInChunks(core, nullptr, output.data(), 512U);
    assert(std::fabs(output[1022U] - ramp[2U * (1535U + 48000U - 6000U)]) < 1.0e-6f);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "beat_shift", {{"official_shift", -1000.0f}}, false, error));
    callbackInChunks(core, nullptr, output.data(), 512U);
    assert(std::fabs(output[1022U] - ramp[2U * 2047U]) < 1.0e-6f);
    // Updates to the underlying independent route survive the temporary overlay.
    originals[2].beatOffsetBeats = 0.75f;
    assert(core.setNativeLoopTransport(2U, originals[2], error));
    NativeAudioCoreTestAccess::applySourceQueue(core);
    assert(NativeAudioCoreTestAccess::transport(core, 2U).beatOffsetBeats == 0.0f);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "beat_shift", {}, true, error));
    callbackInChunks(core, nullptr, output.data(), 512U);
    for (std::size_t t = 0; t < kNativeTrackCount; ++t) {
        const auto& restored = NativeAudioCoreTestAccess::transport(core, t);
        assert(restored.mode == originals[t].mode && restored.beatOffsetBeats == originals[t].beatOffsetBeats && restored.bpm == originals[t].bpm);
    }
    assert(std::fabs(output[1022U] - ramp[2U * (2559U + 48000U - 3000U)]) < 1.0e-6f);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "beat_shift", {{"official_shift", -1.0f}}, false, error));
    NativeAudioCoreTestAccess::applySourceQueue(core);
    assert(NativeAudioCoreTestAccess::transport(core, 0U).beatOffsetBeats == -1.0f);
    NativeAudioCoreTestAccess::setRunning(core, false);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "", {}, false, error));
    for (std::size_t t = 0; t < kNativeTrackCount; ++t)
        assert(NativeAudioCoreTestAccess::transport(core, t).beatOffsetBeats == originals[t].beatOffsetBeats);
}

void testOfficialVinylSustainedSpeedAndUnsupportedModes() {
    NativeAudioCore core; NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 0U);
    std::vector<float> loop(9600U);
    for (std::size_t f = 0; f < loop.size() / 2U; ++f) { loop[2U * f] = 0.1f * std::sin(static_cast<float>(f) * 6.28318530718f / 4800.0f); loop[2U * f + 1U] = -0.5f * loop[2U * f]; }
    NativeAudioCoreTestAccess::loadSourceLoop(core, loop);
    std::string error;
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vinyl_flick",
        {{"official_flick", 100.0f}, {"motor_return_seconds", 0.05f}, {"brake_percent", 100.0f}}, false, error));
    NativeAudioCoreTestAccess::setRunning(core, true);
    std::vector<float> output(48000U * 8U * 2U);
    const auto allocations = test_alloc::count(); test_alloc::beginTracking();
    callbackInChunks(core, nullptr, output.data(), 48000U * 8U);
    test_alloc::endTracking(); assert(test_alloc::count() == allocations);
    unsigned int positiveCrossings = 0U;
    for (std::size_t f = 48000U * 4U + 1U; f < 48000U * 8U; ++f) {
        if (output[2U * (f - 1U)] <= 0.0f && output[2U * f] > 0.0f) ++positiveCrossings;
        assert(std::fabs(output[2U * f + 1U] + 0.5f * output[2U * f]) < 1.0e-6f);
    }
    assert(positiveCrossings >= 79U && positiveCrossings <= 81U); // 20 Hz, after 40+ source wraps.
    assert(core.getStatus().nativeTrackLoopTransportStatus[0] == LoopTransportStatus::Active);
    // Stop the platter, rather than resuming a causal history writer.
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vinyl_flick", {{"official_flick", 0.0f}}, false, error));
    callbackInChunks(core, nullptr, output.data(), 48000U * 2U);
    for (std::size_t f = 48000U * 2U - 256U; f < 48000U * 2U; ++f)
        assert(std::fabs(output[2U * f] - output[2U * (48000U * 2U - 256U)]) < 1.0e-5f);
    NativeAudioCoreTestAccess::command(core, CommandType::ToggleOverdub);
    callbackInChunks(core, nullptr, output.data(), 512U);
    assert(core.getStatus().nativeTrackLoopTransportStatus[0] == LoopTransportStatus::UnsupportedOverdubbing);
    NativeAudioCoreTestAccess::command(core, CommandType::ToggleOverdub);
    NativePitchConfig pitch; pitch.enabled = true; pitch.trackId = 1U;
    assert(core.setNativePitchConfig(pitch, error));
    callbackInChunks(core, nullptr, output.data(), 512U);
    assert(core.getStatus().nativeTrackLoopTransportStatus[0] == LoopTransportStatus::UnsupportedPitchProcessing);
    assert(NativeAudioCoreTestAccess::transport(core, 0U).mode == LoopTransportMode::Off);
    pitch.enabled = false; assert(core.setNativePitchConfig(pitch, error));
    callbackInChunks(core, nullptr, output.data(), 512U);
    assert(core.getStatus().nativeTrackLoopTransportStatus[0] == LoopTransportStatus::Active);
    pitch.reversePlayback = true; assert(core.setNativePitchConfig(pitch, error));
    callbackInChunks(core, nullptr, output.data(), 512U);
    assert(core.getStatus().nativeTrackLoopTransportStatus[0] == LoopTransportStatus::UnsupportedPitchProcessing);
    pitch.reversePlayback = false; assert(core.setNativePitchConfig(pitch, error));
    callbackInChunks(core, nullptr, output.data(), 512U);
    NativeAudioCoreTestAccess::setRunning(core, false);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vinyl_flick", {}, false, error, NativeCatalogFxPath::Track, 0U, true));
    assert(NativeAudioCoreTestAccess::transport(core, 0U).mode == LoopTransportMode::Off);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "filter.lpf", {}, false, error));
    assert(NativeAudioCoreTestAccess::transport(core, 0U).mode == LoopTransportMode::Off);
}

std::vector<float> carrierSignal(std::size_t frames, float frequency) {
    std::vector<float> result(frames * 2U);
    for (std::size_t f = 0U; f < frames; ++f) {
        result[f * 2U] = 0.12f * std::sin(static_cast<float>(f) * frequency * 6.28318530718f / 48000.0f) +
            0.06f * std::sin(static_cast<float>(f) * frequency * 1.719f * 6.28318530718f / 48000.0f);
        result[f * 2U + 1U] = -0.73f * result[f * 2U];
    }
    return result;
}

std::vector<float> renderVocoderCarrierRoute(std::size_t carrierTrack, bool privateRoute, unsigned int chunk) {
    NativeAudioCore core; NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    const auto carrier = carrierSignal(479U, 880.0f);
    const auto modulator = carrierSignal(257U, 220.0f);
    NativeAudioCoreTestAccess::loadSourceLoop(core, carrier, carrierTrack);
    const auto modulatorTrack = carrierTrack == 0U ? 4U : 0U;
    if (privateRoute) NativeAudioCoreTestAccess::loadSourceLoop(core, modulator, modulatorTrack);
    std::string error;
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder",
        {{"official_carrier", static_cast<float>(carrierTrack + 6U)}, {"official_balance", 100.0f}}, false,
        error, privateRoute ? NativeCatalogFxPath::Track : NativeCatalogFxPath::Input,
        privateRoute ? static_cast<std::uint8_t>(modulatorTrack + 1U) : 0U));
    if (!privateRoute) NativeAudioCoreTestAccess::command(core, CommandType::SetMonitoring, true);
    constexpr std::size_t frames = 8192U;
    std::vector<float> input(frames * 2U, 0.0f), output(frames * 2U);
    if (!privateRoute) for (std::size_t f = 0U; f < frames; ++f) {
        input[f * 2U] = modulator[(f % 257U) * 2U]; input[f * 2U + 1U] = modulator[(f % 257U) * 2U + 1U];
    }
    NativeAudioCoreTestAccess::setRunning(core, true);
    test_alloc::beginTracking();
    for (std::size_t offset = 0U; offset < frames;) {
        const auto count = static_cast<unsigned int>(std::min<std::size_t>(chunk, frames - offset));
        NativeAudioCoreTestAccess::callback(core, input.data() + offset * 2U, output.data() + offset * 2U, count);
        offset += count;
    }
    test_alloc::endTracking(); assert(test_alloc::count() == 0U);
    assert(NativeAudioCoreTestAccess::carrierStatus(core, carrierTrack) == NativeVocoderCarrierStatus::Ready);
    NativeAudioCoreTestAccess::setRunning(core, false);
    if (!privateRoute) {
        NativeVocoderCore left, right;
        NativeVocoderConfig config; config.carrier = NativeVocoderCarrier::VoiceInput; config.wetMix = 1.0f;
        for (auto* processor : {&left, &right}) {
            assert(processor->prepare(48000U)); assert(processor->setConfig(config));
            assert(processor->setParameter("official_tone", 0.0f));
            assert(processor->setParameter("official_attack", 50.0f));
            assert(processor->setParameter("official_mod_sens", 0.0f));
            assert(processor->setParameter("official_balance", 100.0f));
        }
        std::vector<float> modL(frames), modR(frames), sourceL(frames), sourceR(frames), wetL(frames), wetR(frames);
        for (std::size_t f = 0U; f < frames; ++f) {
            modL[f] = input[f * 2U]; modR[f] = input[f * 2U + 1U];
            sourceL[f] = carrier[(f % 479U) * 2U]; sourceR[f] = carrier[(f % 479U) * 2U + 1U];
        }
        assert(left.process(modL.data(), sourceL.data(), wetL.data(), frames));
        assert(right.process(modR.data(), sourceR.data(), wetR.data(), frames));
        double firstBlockEnergy = 0.0;
        for (std::size_t f = 0U; f < frames; ++f) {
            assert(std::abs(output[f * 2U] - (sourceL[f] + wetL[f])) < 0.000002f);
            assert(std::abs(output[f * 2U + 1U] - (sourceR[f] + wetR[f])) < 0.000002f);
            if (f < 13U) firstBlockEnergy += static_cast<double>(wetL[f]) * wetL[f];
        }
        assert(firstBlockEnergy > 1.0e-15); // Current block, not a preceding-block carrier cache.
    }
    return output;
}

void testVocoderTrackCarriersUseSameBlockReadOnlyPlayback() {
    const auto inputFirst = renderVocoderCarrierRoute(0U, false, 13U);
    const auto inputLast = renderVocoderCarrierRoute(4U, false, 127U);
    assert(vectorDifferenceRms(inputFirst, inputLast, 0U) < 1.0e-7);
    const auto trackFirst = renderVocoderCarrierRoute(0U, true, 13U);
    const auto trackLast = renderVocoderCarrierRoute(4U, true, 127U);
    assert(vectorDifferenceRms(trackFirst, trackLast, 0U) < 1.0e-7);
    for (std::size_t track = 1U; track < 4U; ++track) {
        const auto other = renderVocoderCarrierRoute(track, false, 4096U);
        assert(vectorDifferenceRms(inputFirst, other, 0U) < 1.0e-7);
    }
}

std::vector<float> renderOfficialSpatialInput(const std::string& effect,
    const std::map<std::string, float>& parameters, unsigned int inputChannels, bool official) {
    NativeAudioCore core; NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, inputChannels);
    std::string error;
    // The M/S enhancer widens existing stereo, not a perfectly mono signal.
    // Generate that stereo upstream inside the same mono-input bank.
    const bool stagedEnhancer = official && effect == "stereo_enhance";
    if (stagedEnhancer) assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "auto_pan",
        {{"official_rate", 100.0f}, {"official_depth", 60.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(core.setNativeCatalogSlot(stagedEnhancer ? NativeEffectSlot::B : NativeEffectSlot::A,
        effect, parameters, false, error, NativeCatalogFxPath::Input));
    constexpr unsigned int frames = 8192U;
    std::vector<float> input(frames * inputChannels), output(frames * 2U);
    for (unsigned int f = 0U; f < frames; ++f) {
        const float sample = 0.1f * std::sin(static_cast<float>(f) * 0.071f) + 0.05f * std::sin(static_cast<float>(f) * 0.177f);
        for (unsigned int c = 0U; c < inputChannels; ++c) input[f * inputChannels + c] = sample;
    }
    const auto before = test_alloc::count(); test_alloc::beginTracking();
    for (unsigned int offset = 0U; offset < frames;) {
        const auto count = std::min(127U, frames - offset); unsigned int channels = 0U;
        const auto* processed = NativeAudioCoreTestAccess::processInputFx(core, input.data() + offset * inputChannels, count, &channels);
        assert(processed && channels == (official ? 2U : inputChannels));
        for (unsigned int f = 0U; f < count; ++f) {
            output[(offset + f) * 2U] = processed[f * channels];
            output[(offset + f) * 2U + 1U] = processed[f * channels + (channels > 1U ? 1U : 0U)];
        }
        offset += count;
    }
    test_alloc::endTracking(); assert(test_alloc::count() == before);
    return output;
}

void testOfficialMonoSpatialParametersProduceRealStereo() {
    const std::array<std::pair<std::string, std::map<std::string, float>>, 4U> effects{{
        {"auto_pan", {{"official_rate", 100.0f}, {"official_depth", 100.0f}, {"official_waveform", 0.0f}}},
        {"stereo_enhance", {{"official_enhance", 100.0f}}},
        {"panning_delay", {{"official_time", 5.0f}, {"official_feedback", 2.0f}, {"official_d_level", 0.0f}, {"official_e_level", 100.0f}}},
        {"chorus", {{"official_rate", 70.0f}, {"official_depth", 100.0f}, {"official_d_level", 0.0f}, {"official_e_level", 100.0f}}},
    }};
    for (const auto& [effect, parameters] : effects) {
        const auto mono = renderOfficialSpatialInput(effect, parameters, 1U, true);
        const auto stereo = renderOfficialSpatialInput(effect, parameters, 2U, true);
        assert(vectorDifferenceRms(mono, stereo, 0U) < 1.0e-7);
        double sideEnergy = 0.0;
        for (std::size_t f = 2048U; f < mono.size() / 2U; ++f) {
            const double side = mono[f * 2U] - mono[f * 2U + 1U]; sideEnergy += side * side;
        }
        assert(sideEnergy > 0.01); // Not merely advertised as stereo: actual L/R audio differs.
        const auto legacy = renderOfficialSpatialInput(effect, {}, 1U, false);
        const auto tempoOnly = renderOfficialSpatialInput(effect,
            {{"official_bpm", 120.0f}, {"official_quarter_notes_per_measure", 4.0f}}, 1U, false);
        assert(legacy == tempoOnly); // Auxiliary transport broadcasts retain legacy mono PCM.
    }
    const auto enhanced = renderOfficialSpatialInput("stereo_enhance", {{"official_enhance", 100.0f}}, 1U, true);
    const auto unenhanced = renderOfficialSpatialInput("stereo_enhance", {{"official_enhance", 0.0f}}, 1U, true);
    assert(vectorDifferenceRms(enhanced, unenhanced, 2048U) > 0.001);
    const auto pan = renderOfficialSpatialInput("auto_pan", effects[0U].second, 1U, true);
    for (const auto& edit : {std::pair<std::string, float>{"official_depth", 0.0f},
                            {"official_rate", 0.0f}, {"official_waveform", 100.0f}}) {
        auto parameters = effects[0U].second; parameters[edit.first] = edit.second;
        const auto changed = renderOfficialSpatialInput("auto_pan", parameters, 1U, true);
        assert(vectorDifferenceRms(pan, changed, 2048U) > 0.001);
        if (edit.first == "official_depth") for (std::size_t f = 2048U; f < changed.size() / 2U; ++f)
            assert(std::abs(changed[f * 2U] - changed[f * 2U + 1U]) < 1.0e-7f);
    }
    auto panProcessor = createNativeEffectProcessor("auto_pan"); assert(panProcessor && panProcessor->prepare(48000U));
    assert(!panProcessor->officialParametersActive());
    assert(panProcessor->setParameter("official_bpm", 120.0f)); assert(!panProcessor->officialParametersActive());
    assert(!panProcessor->setParameter("official_rate", -3.14159f)); assert(!panProcessor->officialParametersActive());
    assert(panProcessor->setParameter("official_depth", 100.0f)); assert(panProcessor->officialParametersActive());
    auto roll = createNativeEffectProcessor("roll"); assert(roll && roll->prepare(48000U));
    assert(!roll->officialParametersActive()); assert(roll->setParameter("official_variant", 1.0f));
    assert(roll->officialParametersActive());
}

void testVocoderMonoInputRetainsStereoCarrierAndRejectsUnroutedControls() {
    NativeAudioCore core; NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 1U);
    std::string error;
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder", {}, false, error, NativeCatalogFxPath::Input));
    for (float value = 0.0f; value <= 5.0f; value += 1.0f) {
        assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder",
            {{"official_carrier", value}, {"official_balance", 100.0f}}, false, error, NativeCatalogFxPath::Input));
        NativeAudioCoreTestAccess::prepareCarriers(core, 256U);
        assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == NativeVocoderCarrierStatus::NotRequested);
    }
    for (bool rightOnly : {false, true}) {
        auto source = carrierSignal(4096U, 880.0f);
        for (std::size_t f = 0U; f < 4096U; ++f) source[f * 2U + (rightOnly ? 0U : 1U)] = 0.0f;
        NativeAudioCoreTestAccess::loadSourceLoop(core, source);
        assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder",
            {{"official_carrier", 6.0f}, {"official_balance", 100.0f}}, false, error, NativeCatalogFxPath::Input, 0U, true));
        auto stereoInput = carrierSignal(4096U, 220.0f);
        std::vector<float> mono(4096U), external(4096U), reference(4096U);
        for (std::size_t f = 0U; f < 4096U; ++f) {
            mono[f] = stereoInput[f * 2U]; external[f] = source[f * 2U + (rightOnly ? 1U : 0U)];
        }
        NativeVocoderCore ref; assert(ref.prepare(48000U));
        NativeVocoderConfig config; config.carrier = NativeVocoderCarrier::VoiceInput;
        assert(ref.setConfig(config)); assert(ref.setParameter("official_tone", 0.0f));
        assert(ref.setParameter("official_attack", 50.0f)); assert(ref.setParameter("official_mod_sens", 0.0f));
        assert(ref.setParameter("official_balance", 100.0f));
        assert(ref.process(mono.data(), external.data(), reference.data(), 4096U));
        NativeAudioCoreTestAccess::prepareCarriers(core, 4096U);
        unsigned int channels = 0U;
        const auto* actual = NativeAudioCoreTestAccess::processInputFx(core, mono.data(), 4096U, &channels);
        assert(actual && channels == 2U);
        double energy = 0.0;
        for (std::size_t f = 0U; f < 4096U; ++f) {
            assert(actual[f * 2U + (rightOnly ? 0U : 1U)] == 0.0f);
            assert(std::abs(actual[f * 2U + (rightOnly ? 1U : 0U)] - reference[f]) < 1.0e-7f);
            energy += static_cast<double>(reference[f]) * reference[f];
        }
        assert(energy > 0.00001);
        NativeAudioCoreTestAccess::setRunning(core, true);
        assert(core.getStatus().nativeVocoderCarrierStatuses[0] == NativeVocoderCarrierStatus::Ready);
        NativeAudioCoreTestAccess::splitInputCallback(core, mono.data(), 4097U);
        assert(core.getStatus().nativeVocoderCarrierStatuses[0] == NativeVocoderCarrierStatus::BufferUnavailable);
        NativeAudioCoreTestAccess::setRunning(core, false);
        assert(core.getStatus().nativeVocoderCarrierStatuses[0] == NativeVocoderCarrierStatus::NotRequested);
        assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "", {}, false, error, NativeCatalogFxPath::Input));
        assert(core.getStatus().nativeVocoderCarrierStatuses[0] == NativeVocoderCarrierStatus::NotRequested);
        NativeAudioCoreTestAccess::resetRuntime(core);
        assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == NativeVocoderCarrierStatus::NotRequested);
    }
    // A legacy-only mono vocoder must not be silently promoted by the new tap.
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder", {}, false, error, NativeCatalogFxPath::Input));
    std::vector<float> mono(256U, 0.1f); unsigned int channels = 0U;
    assert(NativeAudioCoreTestAccess::processInputFx(core, mono.data(), 256U, &channels)); assert(channels == 1U);
}

void testVocoderTrackCarrierLifecycleAndExplicitSilence() {
    NativeAudioCore core; NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    std::string error;
    // Another official field also opts into the documented TRACK 1 default.
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder", {{"official_balance", 100.0f}}, false, error, NativeCatalogFxPath::Input));
    NativeAudioCoreTestAccess::setRunning(core, true);
    const auto input = carrierSignal(256U, 220.0f), source = carrierSignal(479U, 880.0f);
    std::vector<float> output(512U), processed(512U);
    const auto checkSilence = [&](NativeVocoderCarrierStatus expected) {
        NativeAudioCoreTestAccess::prepareCarriers(core, 256U);
        assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == expected);
        const auto* wet = NativeAudioCoreTestAccess::processInputFx(core, input.data(), 256U);
        assert(wet); std::copy(wet, wet + 512U, processed.begin());
        assert(std::all_of(processed.begin(), processed.end(), [](float x) { return x == 0.0f; }));
    };
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    checkSilence(NativeVocoderCarrierStatus::Empty);
    NativeAudioCoreTestAccess::command(core, CommandType::Record);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    checkSilence(NativeVocoderCarrierStatus::UnsupportedRecording);
    NativeAudioCoreTestAccess::command(core, CommandType::Clear);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    NativeAudioCoreTestAccess::loadSourceLoop(core, source);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == NativeVocoderCarrierStatus::Ready);
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    checkSilence(NativeVocoderCarrierStatus::Stopped);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == NativeVocoderCarrierStatus::Ready);
    NativeAudioCoreTestAccess::command(core, CommandType::ToggleOverdub);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    checkSilence(NativeVocoderCarrierStatus::UnsupportedOverdubbing);
    NativeAudioCoreTestAccess::command(core, CommandType::ToggleOverdub);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    NativeAudioCoreTestAccess::pinCarrierSource(core, 0U);
    checkSilence(NativeVocoderCarrierStatus::HistoryPinned);
    NativeAudioCoreTestAccess::pinCarrierSource(core, kNativeTrackCount);
    NativePitchConfig pitch; pitch.enabled = true; pitch.trackId = 1U;
    assert(core.setNativePitchConfig(pitch, error));
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    checkSilence(NativeVocoderCarrierStatus::UnsupportedPitchProcessing);
    pitch.enabled = false; assert(core.setNativePitchConfig(pitch, error));
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    NativeAudioCoreTestAccess::prepareCarriers(core, 4097U);
    assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == NativeVocoderCarrierStatus::BufferUnavailable);
    const auto* wet = NativeAudioCoreTestAccess::processInputFx(core, input.data(), 256U);
        assert(wet); std::copy(wet, wet + 512U, processed.begin());
    assert(std::all_of(processed.begin(), processed.end(), [](float x) { return x == 0.0f; }));
    NativeAudioCoreTestAccess::command(core, CommandType::Clear);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    checkSilence(NativeVocoderCarrierStatus::Empty);
    NativeAudioCoreTestAccess::setRunning(core, false);
    NativeAudioCoreTestAccess::restoreSourceLoop(core, source, 0U);
    NativeAudioCoreTestAccess::setRunning(core, true);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    checkSilence(NativeVocoderCarrierStatus::Stopped);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == NativeVocoderCarrierStatus::Ready);
    // Prepare/restart retains the official source and BALANCE rather than resetting to a saw.
    NativeAudioCoreTestAccess::setRunning(core, false);
    NativeAudioCoreTestAccess::prepareSelectedCatalog(core);
    NativeAudioCoreTestAccess::setRunning(core, true);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == NativeVocoderCarrierStatus::Ready);
    NativeAudioCoreTestAccess::setRunning(core, false);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "vocoder", {}, false, error, NativeCatalogFxPath::Input, 0U, true));
    NativeAudioCoreTestAccess::setRunning(core, true);
    NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 256U);
    assert(NativeAudioCoreTestAccess::carrierStatus(core, 0U) == NativeVocoderCarrierStatus::NotRequested);
    NativeAudioCoreTestAccess::setRunning(core, false);
}

} // namespace

int main() {
    testOfficialMonoSpatialParametersProduceRealStereo();
    testVocoderTrackCarriersUseSameBlockReadOnlyPlayback();
    testVocoderTrackCarrierLifecycleAndExplicitSilence();
    testVocoderMonoInputRetainsStereoCarrierAndRejectsUnroutedControls();
    testOfficialSourceChunkInvariance();
    testOfficialSourceReadheadsAndRestoration();
    testOfficialVinylSustainedSpeedAndUnsupportedModes();
    testParameterReplacementCannotAcknowledgeStaleState();
    testVariantQueueUsesProspectiveBranch();
    testOfficialControlsTraverseLiveHostQueue();
    testOscVocMidiUsesSelectedInputAndSharedTrackSlots();
    testPreampAudioRunsThroughInputAndTrackBanks();
    testTwistCatalogRoutingThroughInputAndSharedTrackSlots();
    testWarpRunsThroughInputAndTrackBanksAThroughD();
    testFreezeRunsThroughInputBypassAndTrackSharedPlayback();
    testSynthRunsThroughInputAndSharedTrackPlaybackRoutes();
    testG2BRunsThroughNativeInputAndSharedTrackPlaybackRoutes();
    testRobotRunsThroughNativeInputAndTrackSlotsAThroughD();
    testElectricRunsThroughInputAndSharedTrackSlotsAThroughD();
    testSignalsmithTransposeRunsThroughNativeInputAndTrackBanks();
    testPitchBendRunsThroughNativeInputAndTrackBanks();
    testManualHarmonistRunsThroughNativeInputAndTrackBanks();
    testOctaveRunsThroughMonoNativeInputAndSharedTrackSlotsAThroughD();
    testVocoderRunsThroughNativeInputAndSharedTrackSlotsAThroughD();
    testReverseReverbInputAndTrackTempoFollowNativeRhythmConfig();
    testAutoRiffInputTempoFollowsNativeRhythmTransport();
    testOscBotRunsThroughSelectedInputAndSharedTrackSlots();
    const auto* reverseDescriptor = findNativeEffectDescriptor("reverse_delay");
    assert(reverseDescriptor != nullptr);
    assert(reverseDescriptor->sourceIndex == 38);
    assert(reverseDescriptor->inputAvailable && reverseDescriptor->trackAvailable);
    const auto* reverseReverbDescriptor = findNativeEffectDescriptor("reverse_reverb");
    assert(reverseReverbDescriptor != nullptr);
    assert(reverseReverbDescriptor->sourceIndex == 49);
    assert(reverseReverbDescriptor->inputAvailable && reverseReverbDescriptor->trackAvailable);

    const auto* descriptor = findNativeEffectDescriptor("panning_delay");
    assert(descriptor != nullptr);
    assert(descriptor->sourceIndex == 37);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    const auto* modDelayDescriptor = findNativeEffectDescriptor("mod_delay");
    assert(modDelayDescriptor != nullptr);
    assert(modDelayDescriptor->sourceIndex == 39);
    assert(modDelayDescriptor->inputAvailable && modDelayDescriptor->trackAvailable);
    const auto* granularDescriptor = findNativeEffectDescriptor("granular_delay");
    assert(granularDescriptor != nullptr && granularDescriptor->sourceIndex == 41);
    assert(granularDescriptor->inputAvailable && granularDescriptor->trackAvailable);
    const auto* radioDescriptor = findNativeEffectDescriptor("radio");
    assert(radioDescriptor != nullptr && radioDescriptor->sourceIndex == 8);
    assert(radioDescriptor->inputAvailable && radioDescriptor->trackAvailable);
    const auto* sustainerDescriptor = findNativeEffectDescriptor("sustainer");
    assert(sustainerDescriptor != nullptr && sustainerDescriptor->sourceIndex == 11);
    assert(sustainerDescriptor->inputAvailable && sustainerDescriptor->trackAvailable);
    const auto* vibratoDescriptor = findNativeEffectDescriptor("vibrato");
    assert(vibratoDescriptor != nullptr && vibratoDescriptor->sourceIndex == 33);
    assert(vibratoDescriptor->inputAvailable && vibratoDescriptor->trackAvailable);
    const auto* isolatorDescriptor = findNativeEffectDescriptor("isolator");
    assert(isolatorDescriptor != nullptr && isolatorDescriptor->sourceIndex == 27);
    assert(isolatorDescriptor->inputAvailable && isolatorDescriptor->trackAvailable);
    const auto* gateReverbDescriptor = findNativeEffectDescriptor("gate_reverb");
    assert(gateReverbDescriptor != nullptr && gateReverbDescriptor->sourceIndex == 48);
    assert(gateReverbDescriptor->inputAvailable && gateReverbDescriptor->trackAvailable);
    const auto* patternSlicerDescriptor = findNativeEffectDescriptor("pattern_slicer");
    assert(patternSlicerDescriptor != nullptr && patternSlicerDescriptor->sourceIndex == 34);
    assert(patternSlicerDescriptor->inputAvailable && patternSlicerDescriptor->trackAvailable);
    const auto* stepSlicerDescriptor = findNativeEffectDescriptor("step_slicer");
    assert(stepSlicerDescriptor != nullptr && stepSlicerDescriptor->sourceIndex == 35);
    assert(stepSlicerDescriptor->inputAvailable && stepSlicerDescriptor->trackAvailable);

    NativeAudioCore engine;
    std::string error;
    const std::map<std::string, float> trackParameters{
        {"time_ms", 125.5f},
        {"feedback_percent", 35.0f},
        {"pan_percent", -70.0f},
        {"mix_percent", 80.0f},
    };
    assert(engine.setNativeCatalogSlot(
        NativeEffectSlot::A,
        "panning_delay",
        trackParameters,
        false,
        error,
        NativeCatalogFxPath::Track
    ));

    error.clear();
    const std::map<std::string, float> inputParameters{
        {"time_ms", 333.25f},
        {"feedback_percent", 62.0f},
        {"pan_percent", 55.0f},
        {"mix_percent", 45.0f},
    };
    assert(engine.setNativeCatalogSlot(
        NativeEffectSlot::A,
        "panning_delay",
        inputParameters,
        false,
        error,
        NativeCatalogFxPath::Input
    ));

    error.clear();
    const std::map<std::string, float> modDelayTrackParameters{
        {"rate_hz", 1.2f}, {"depth_ms", 7.0f},
        {"delay_ms", 180.0f}, {"feedback", 0.4f}, {"wet_mix", 0.7f},
    };
    assert(engine.setNativeCatalogSlot(
        NativeEffectSlot::B,
        "mod_delay",
        modDelayTrackParameters,
        false,
        error,
        NativeCatalogFxPath::Track
    ));
    error.clear();
    const std::map<std::string, float> modDelayInputParameters{
        {"rate_hz", 0.25f}, {"depth_ms", 2.0f},
        {"delay_ms", 60.0f}, {"feedback", 0.25f}, {"wet_mix", 0.5f},
    };
    assert(engine.setNativeCatalogSlot(
        NativeEffectSlot::C,
        "mod_delay",
        modDelayInputParameters,
        false,
        error,
        NativeCatalogFxPath::Input
    ));
    error.clear();
    assert(!engine.setNativeCatalogSlot(
        NativeEffectSlot::C,
        "mod_delay",
        {{"feedback", 0.96f}},
        false,
        error,
        NativeCatalogFxPath::Input
    ));
    assert(error.find("feedback") != std::string::npos);
    const auto modDelayRoutes = engine.getStatus();
    assert(modDelayRoutes.nativeCatalogSlotEffectIds[1] == "mod_delay");
    assert(modDelayRoutes.nativeInputCatalogSlotEffectIds[2] == "mod_delay");
    assert(!modDelayRoutes.nativeCatalogSlotBypassed[1]);
    assert(!modDelayRoutes.nativeInputCatalogSlotBypassed[2]);

    const auto status = engine.getStatus();
    assert(status.nativeCatalogGraphAvailable);
    assert(status.nativeCatalogSlotEffectIds[0] == "panning_delay");
    assert(status.nativeInputCatalogSlotEffectIds[0] == "panning_delay");
    assert(status.nativeCatalogSlotBypassed[0] == false);
    assert(status.nativeInputCatalogSlotBypassed[0] == false);

    error.clear();
    const std::map<std::string, float> invalidPan{{"pan_percent", 100.1f}};
    assert(!engine.setNativeCatalogSlot(
        NativeEffectSlot::A,
        "panning_delay",
        invalidPan,
        false,
        error,
        NativeCatalogFxPath::Input
    ));
    assert(error.find("pan_percent") != std::string::npos);
    const auto afterInvalid = engine.getStatus();
    assert(afterInvalid.nativeCatalogSlotEffectIds[0] == "panning_delay");
    assert(afterInvalid.nativeInputCatalogSlotEffectIds[0] == "panning_delay");

    error.clear();
    assert(engine.setNativeCatalogSlot(
        NativeEffectSlot::A,
        "panning_delay",
        {},
        true,
        error,
        NativeCatalogFxPath::Input
    ));
    const auto bypassed = engine.getStatus();
    assert(bypassed.nativeInputCatalogSlotBypassed[0]);
    assert(!bypassed.nativeCatalogSlotBypassed[0]);

    error.clear();
    const std::map<std::string, float> granularInputParameters{
        {"grain_size_ms", 60.0f}, {"density_hz", 18.0f},
        {"pitch_semitones", 7.0f}, {"position_jitter_percent", 25.0f}, {"feedback_percent", 20.0f}, {"mix_percent", 65.0f},
    };
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::B, "granular_delay", granularInputParameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    const std::map<std::string, float> granularTrackParameters{
        {"grain_size_ms", 90.0f}, {"density_hz", 24.0f},
        {"pitch_semitones", -5.0f}, {"position_jitter_percent", 40.0f}, {"feedback_percent", 35.0f}, {"mix_percent", 75.0f},
    };
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::C, "granular_delay", granularTrackParameters,
        false, error, NativeCatalogFxPath::Track));
    const auto granular = engine.getStatus();
    assert(granular.nativeInputCatalogSlotEffectIds[1] == "granular_delay");
    assert(granular.nativeCatalogSlotEffectIds[2] == "granular_delay");

    error.clear();
    const std::map<std::string, float> radioInputParameters{
        {"band", 0.0f}, {"drive", 31.0f}, {"noise", 7.0f}, {"mix", 68.0f},
    };
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::A, "radio", radioInputParameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    const std::map<std::string, float> radioTrackParameters{
        {"band", 2.0f}, {"drive", 76.0f}, {"noise", 22.0f}, {"mix", 54.0f},
    };
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::D, "radio", radioTrackParameters,
        false, error, NativeCatalogFxPath::Track));
    const auto radio = engine.getStatus();
    assert(radio.nativeInputCatalogSlotEffectIds[0] == "radio");
    assert(radio.nativeCatalogSlotEffectIds[3] == "radio");
    assert(!radio.nativeInputCatalogSlotBypassed[0] && !radio.nativeCatalogSlotBypassed[3]);

    error.clear();
    const std::map<std::string, float> invalidRadioInput{{"band", 1.5f}};
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::B, "radio", invalidRadioInput,
        false, error, NativeCatalogFxPath::Input));
    assert(error.find("band") != std::string::npos);

    error.clear();
    const std::map<std::string, float> sustainerInputParameters{
        {"threshold_db", -31.0f}, {"ratio", 6.0f}, {"release_ms", 210.0f}, {"output_db", 1.5f},
    };
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::B, "sustainer", sustainerInputParameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    const std::map<std::string, float> sustainerTrackParameters{
        {"threshold_db", -19.0f}, {"ratio", 11.0f}, {"release_ms", 420.0f}, {"output_db", -2.0f},
    };
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::C, "sustainer", sustainerTrackParameters,
        false, error, NativeCatalogFxPath::Track));
    const auto sustainer = engine.getStatus();
    assert(sustainer.nativeInputCatalogSlotEffectIds[1] == "sustainer");
    assert(sustainer.nativeCatalogSlotEffectIds[2] == "sustainer");
    assert(!sustainer.nativeInputCatalogSlotBypassed[1] && !sustainer.nativeCatalogSlotBypassed[2]);

    error.clear();
    const std::map<std::string, float> vibratoInputParameters{
        {"rate_hz", 3.5f}, {"depth", 60.0f}, {"delay_ms", 2.7f}, {"mix_percent", 85.0f},
    };
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::A, "vibrato", vibratoInputParameters,
        false, error, NativeCatalogFxPath::Input));
    error.clear();
    const std::map<std::string, float> vibratoTrackParameters{
        {"rate_hz", 8.0f}, {"depth", 91.0f}, {"delay_ms", 7.4f}, {"mix_percent", 48.0f},
    };
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::D, "vibrato", vibratoTrackParameters,
        false, error, NativeCatalogFxPath::Track));
    const auto vibrato = engine.getStatus();
    assert(vibrato.nativeInputCatalogSlotEffectIds[0] == "vibrato");
    assert(vibrato.nativeCatalogSlotEffectIds[3] == "vibrato");
    assert(!vibrato.nativeInputCatalogSlotBypassed[0] && !vibrato.nativeCatalogSlotBypassed[3]);

    const auto* slowGearDescriptor = findNativeEffectDescriptor("slow_gear");
    assert(slowGearDescriptor != nullptr && slowGearDescriptor->sourceIndex == 13);
    assert(slowGearDescriptor->inputAvailable && slowGearDescriptor->trackAvailable);
    const std::array<NativeEffectSlot, 4U> slots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};
    const auto* preampDescriptor = findNativeEffectDescriptor("preamp");
    assert(preampDescriptor != nullptr && preampDescriptor->sourceIndex == 23);
    assert(preampDescriptor->inputAvailable && preampDescriptor->trackAvailable);
    const std::map<std::string, float> preampInputParameters{
        {"model", 1.0f}, {"gain", 28.0f}, {"bass", 3.0f},
        {"middle", -1.5f}, {"treble", 2.0f}, {"level", -2.0f},
    };
    const std::map<std::string, float> preampTrackParameters{
        {"model", 3.0f}, {"gain", 82.0f}, {"bass", -4.0f},
        {"middle", 2.5f}, {"treble", -1.0f}, {"level", 1.0f},
    };
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "preamp", preampInputParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "preamp", preampTrackParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto preampRoutes = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(preampRoutes.nativeInputCatalogSlotEffectIds[slot] == "preamp");
        assert(preampRoutes.nativeCatalogSlotEffectIds[slot] == "preamp");
        assert(!preampRoutes.nativeInputCatalogSlotBypassed[slot]);
        assert(!preampRoutes.nativeCatalogSlotBypassed[slot]);
    }
    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::A, "preamp",
        {{"model", 2.5f}}, false, error, NativeCatalogFxPath::Track));
    assert(error.find("model") != std::string::npos);

    const std::map<std::string, float> slowGearParameters{
        {"attack_ms", 375.0f}, {"sensitivity_percent", 68.0f}, {"mix_percent", 92.0f},
    };
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "slow_gear", slowGearParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "slow_gear", slowGearParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto slowGear = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(slowGear.nativeInputCatalogSlotEffectIds[slot] == "slow_gear");
        assert(slowGear.nativeCatalogSlotEffectIds[slot] == "slow_gear");
        assert(!slowGear.nativeInputCatalogSlotBypassed[slot]);
        assert(!slowGear.nativeCatalogSlotBypassed[slot]);
    }

    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::A, "slow_gear",
        {{"attack_ms", 2000.1f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("attack_ms") != std::string::npos);

    const std::map<std::string, float> patternSlicerInputParameters{
        {"pattern", 2.0f}, {"rate", 0.5f}, {"depth", 84.0f}, {"edge_ms", 1.5f}, {"bpm", 107.0f},
    };
    const std::map<std::string, float> patternSlicerTrackParameters{
        {"pattern", 6.0f}, {"rate", 1.0f}, {"depth", 63.0f}, {"edge_ms", 3.0f}, {"bpm", 132.0f},
    };
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "pattern_slicer", patternSlicerInputParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "pattern_slicer", patternSlicerTrackParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto patternSlicers = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(patternSlicers.nativeInputCatalogSlotEffectIds[slot] == "pattern_slicer");
        assert(patternSlicers.nativeCatalogSlotEffectIds[slot] == "pattern_slicer");
        assert(!patternSlicers.nativeInputCatalogSlotBypassed[slot]);
        assert(!patternSlicers.nativeCatalogSlotBypassed[slot]);
    }

    const std::map<std::string, float> stepSlicerParameters{
        {"step_count", 16.0f}, {"rate_beats", 0.25f}, {"bpm", 121.0f},
        {"depth_percent", 92.0f}, {"pan_depth_percent", 30.0f}, {"filter_hz", 9000.0f},
        {"step_01", 100.0f}, {"step_02", 15.0f}, {"step_03", 85.0f}, {"step_16", 55.0f},
    };
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "step_slicer", stepSlicerParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "step_slicer", stepSlicerParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto stepSlicers = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(stepSlicers.nativeInputCatalogSlotEffectIds[slot] == "step_slicer");
        assert(stepSlicers.nativeCatalogSlotEffectIds[slot] == "step_slicer");
        assert(!stepSlicers.nativeInputCatalogSlotBypassed[slot]);
        assert(!stepSlicers.nativeCatalogSlotBypassed[slot]);
    }

    const std::map<std::string, float> isolatorInputParameters{
        {"low_crossover_hz", 180.0f}, {"high_crossover_hz", 4500.0f},
        {"low_gain_db", 8.0f}, {"mid_gain_db", -2.0f}, {"high_gain_db", -8.0f},
        {"gate_enabled", 1.0f}, {"gate_bpm", 110.0f}, {"gate_division_beats", 0.5f},
        {"gate_duty_percent", 55.0f}, {"gate_attack_ms", 2.0f}, {"gate_release_ms", 30.0f},
    };
    const std::map<std::string, float> isolatorTrackParameters{
        {"low_crossover_hz", 320.0f}, {"high_crossover_hz", 6200.0f},
        {"low_gain_db", -6.0f}, {"mid_gain_db", 3.0f}, {"high_gain_db", 9.0f},
        {"gate_enabled", 0.0f}, {"gate_bpm", 90.0f}, {"gate_division_beats", 1.0f},
        {"gate_duty_percent", 42.0f}, {"gate_attack_ms", 4.0f}, {"gate_release_ms", 45.0f},
    };
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "isolator", isolatorInputParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "isolator", isolatorTrackParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto isolators = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(isolators.nativeInputCatalogSlotEffectIds[slot] == "isolator");
        assert(isolators.nativeCatalogSlotEffectIds[slot] == "isolator");
        assert(!isolators.nativeInputCatalogSlotBypassed[slot]);
        assert(!isolators.nativeCatalogSlotBypassed[slot]);
    }

    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::B, "isolator",
        {{"gate_division_beats", 3.0f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("gate_division_beats") != std::string::npos);

    const auto* beatScatterDescriptor = findNativeEffectDescriptor("beat_scatter");
    assert(beatScatterDescriptor != nullptr && beatScatterDescriptor->sourceIndex == 50);
    assert(!beatScatterDescriptor->inputAvailable && beatScatterDescriptor->trackAvailable);
    const std::map<std::string, float> beatScatterParameters{
        {"bpm", 120.0f}, {"slice_beats", 0.5f}, {"scatter_percent", 68.0f},
        {"pitch_semitones", -7.0f}, {"repeats", 6.0f}, {"mix_percent", 75.0f},
    };
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "beat_scatter", beatScatterParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto beatScatter = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(beatScatter.nativeCatalogSlotEffectIds[slot] == "beat_scatter");
        assert(!beatScatter.nativeCatalogSlotBypassed[slot]);
    }

    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::A, "beat_scatter", beatScatterParameters,
        false, error, NativeCatalogFxPath::Input));
    assert(error.find("not available on the requested input path") != std::string::npos);
    const auto stillTrackOnly = engine.getStatus();
    assert(stillTrackOnly.nativeCatalogSlotEffectIds[0] == "beat_scatter");
    assert(stillTrackOnly.nativeInputCatalogSlotEffectIds[0] == "isolator");

    const auto* rollDescriptor = findNativeEffectDescriptor("roll");
    assert(rollDescriptor != nullptr && rollDescriptor->sourceIndex == 44);
    assert(rollDescriptor->inputAvailable && rollDescriptor->trackAvailable);
    const std::map<std::string, float> rollParameters{
        {"bpm", 120.0f}, {"slice_beats", 0.5f}, {"decay_percent", 20.0f},
        {"pitch_semitones", -12.0f}, {"direction", 2.0f}, {"mix_percent", 65.0f},
    };
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "roll", rollParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "roll", rollParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto rolls = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(rolls.nativeInputCatalogSlotEffectIds[slot] == "roll");
        assert(rolls.nativeCatalogSlotEffectIds[slot] == "roll");
        assert(!rolls.nativeInputCatalogSlotBypassed[slot]);
        assert(!rolls.nativeCatalogSlotBypassed[slot]);
    }

    const auto* freezeDescriptor = findNativeEffectDescriptor("freeze");
    assert(freezeDescriptor != nullptr && freezeDescriptor->sourceIndex == 45);
    assert(freezeDescriptor->inputAvailable && freezeDescriptor->trackAvailable);
    const std::map<std::string, float> freezeParameters{
        {"capture_ms", 20.0f}, {"mode", 0.0f}, {"pitch_semitones", 0.0f},
        {"freeze", 0.0f}, {"mix_percent", 75.0f},
    };
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "freeze", freezeParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "freeze", freezeParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto freezes = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(freezes.nativeInputCatalogSlotEffectIds[slot] == "freeze");
        assert(freezes.nativeCatalogSlotEffectIds[slot] == "freeze");
        assert(!freezes.nativeInputCatalogSlotBypassed[slot]);
        assert(!freezes.nativeCatalogSlotBypassed[slot]);
    }
    auto spectralParameters = freezeParameters;
    spectralParameters["mode"] = 1.0f;
    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::A, "freeze", spectralParameters,
        false, error, NativeCatalogFxPath::Track));
    assert(error.find("mode") != std::string::npos);

    const auto* manualPanDescriptor = findNativeEffectDescriptor("manual_pan");
    assert(manualPanDescriptor != nullptr && manualPanDescriptor->sourceIndex == 30);
    assert(manualPanDescriptor->inputAvailable && manualPanDescriptor->trackAvailable);
    const std::map<std::string, float> manualPanParameters{{"position", -75.0f}};
    for (const auto slot : slots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "manual_pan", manualPanParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto manualPanTracks = engine.getStatus();
    for (std::size_t slot = 0U; slot < slots.size(); ++slot) {
        assert(manualPanTracks.nativeCatalogSlotEffectIds[slot] == "manual_pan");
        assert(!manualPanTracks.nativeCatalogSlotBypassed[slot]);
    }
    NativeAudioCore monoPanEngine;
    NativeAudioCoreTestAccess::prepareWithoutDevice(monoPanEngine);
    NativeAudioCoreTestAccess::setInputChannels(monoPanEngine, 1U);
    const std::map<std::string, float> monoInputPanParameters{{"position", 100.0f}};
    error.clear();
    assert(monoPanEngine.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", monoInputPanParameters,
        false, error, NativeCatalogFxPath::Input));
    const auto manualPanInput = monoPanEngine.getStatus();
    assert(manualPanInput.nativeInputCatalogSlotEffectIds[0] == "manual_pan");
    assert(!manualPanInput.nativeInputCatalogSlotBypassed[0]);
    constexpr unsigned int monoPanFrames = 1024U;
    std::array<float, monoPanFrames> monoPanSource{};
    monoPanSource.fill(0.25f);
    unsigned int processedInputChannels = 0U;
    const float* pannedMono = NativeAudioCoreTestAccess::processInputFx(
        monoPanEngine, monoPanSource.data(), monoPanFrames, &processedInputChannels);
    assert(pannedMono != nullptr && processedInputChannels == 2U);
    for (unsigned int frame = 960U; frame < monoPanFrames; ++frame) {
        const std::size_t offset = static_cast<std::size_t>(frame) * 2U;
        assert(std::fabs(pannedMono[offset]) < 1e-5f);
        assert(std::fabs(pannedMono[offset + 1U] - 0.25f) < 1e-5f);
    }
    NativeAudioCoreTestAccess::setRunning(monoPanEngine, true);
    error.clear();
    assert(NativeAudioCoreTestAccess::queueTrackCommand(monoPanEngine, CommandType::Record, 0U, error));
    std::array<float, monoPanFrames * 2U> monitorOutput{};
    assert(NativeAudioCoreTestAccess::callback(monoPanEngine, monoPanSource.data(),
        monitorOutput.data(), monoPanFrames) == 0);
    error.clear();
    assert(NativeAudioCoreTestAccess::queueTrackCommand(
        monoPanEngine, CommandType::StopRecordOrPlayback, 0U, error));
    assert(NativeAudioCoreTestAccess::callback(monoPanEngine, monoPanSource.data(),
        monitorOutput.data(), monoPanFrames) == 0);
    std::vector<float> recordedStereo(monoPanFrames * 2U);
    std::size_t recordedFrames = 0U;
    assert(NativeAudioCoreTestAccess::copyTrackStereo(monoPanEngine, 0U, recordedStereo.data(),
        monoPanFrames, recordedFrames));
    assert(recordedFrames == monoPanFrames);
    for (unsigned int frame = 0U; frame < monoPanFrames; ++frame) {
        assert(std::fabs(recordedStereo[static_cast<std::size_t>(frame) * 2U]) < 1e-5f);
        assert(std::fabs(recordedStereo[static_cast<std::size_t>(frame) * 2U + 1U] - 0.25f) < 1e-5f);
    }
    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan",
        {{"position", 100.1f}}, false, error, NativeCatalogFxPath::Track));
    assert(error.find("position") != std::string::npos);

    const std::map<std::string, float> gateParameters{
        {"threshold_db", -30.0f}, {"hysteresis_db", 5.0f}, {"hold_ms", 80.0f}, {"release_ms", 180.0f},
    };
    error.clear();
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::A, "gate_reverb", gateParameters,
        false, error, NativeCatalogFxPath::Track));
    error.clear();
    assert(engine.setNativeCatalogSlot(NativeEffectSlot::B, "gate_reverb", gateParameters,
        false, error, NativeCatalogFxPath::Input));
    const auto gateReverbRoutes = engine.getStatus();
    assert(gateReverbRoutes.nativeCatalogSlotEffectIds[0] == "gate_reverb");
    assert(gateReverbRoutes.nativeInputCatalogSlotEffectIds[1] == "gate_reverb");
    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::B, "gate_reverb",
        {{"release_ms", 2000.1f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("release_ms") != std::string::npos);

    const std::array<NativeEffectSlot, 4U> reverseSlots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};
    const std::map<std::string, float> reverseParameters{
        {"bpm", 120.0f}, {"segment_beats", 1.0f}, {"feedback_percent", 20.0f},
        {"crossfade_ms", 20.0f}, {"mix_percent", 30.0f},
    };
    for (const auto slot : reverseSlots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "reverse_delay", reverseParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "reverse_delay", reverseParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto reverseRoutes = engine.getStatus();
    for (std::size_t slot = 0U; slot < reverseSlots.size(); ++slot) {
        assert(reverseRoutes.nativeInputCatalogSlotEffectIds[slot] == "reverse_delay");
        assert(reverseRoutes.nativeCatalogSlotEffectIds[slot] == "reverse_delay");
        assert(!reverseRoutes.nativeInputCatalogSlotBypassed[slot]);
        assert(!reverseRoutes.nativeCatalogSlotBypassed[slot]);
    }
    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::A, "reverse_delay",
        {{"crossfade_ms", 100.1f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("crossfade_ms") != std::string::npos);

    const std::map<std::string, float> reverseReverbParameters{
        {"bpm", 120.0f}, {"segment_beats", 0.5f}, {"feedback_percent", 0.0f},
        {"crossfade_ms", 20.0f}, {"decay_seconds", 2.0f},
        {"damping_cutoff_hz", 8000.0f}, {"mix_percent", 35.0f},
    };
    for (const auto slot : reverseSlots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "reverse_reverb", reverseReverbParameters,
            false, error, NativeCatalogFxPath::Input));
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "reverse_reverb", reverseReverbParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto reverseReverbRoutes = engine.getStatus();
    for (std::size_t slot = 0U; slot < reverseSlots.size(); ++slot) {
        assert(reverseReverbRoutes.nativeInputCatalogSlotEffectIds[slot] == "reverse_reverb");
        assert(reverseReverbRoutes.nativeCatalogSlotEffectIds[slot] == "reverse_reverb");
        assert(!reverseReverbRoutes.nativeInputCatalogSlotBypassed[slot]);
        assert(!reverseReverbRoutes.nativeCatalogSlotBypassed[slot]);
    }
    error.clear();
    assert(!engine.setNativeCatalogSlot(NativeEffectSlot::A, "reverse_reverb",
        {{"decay_seconds", 10.1f}}, false, error, NativeCatalogFxPath::Input));
    assert(error.find("decay_seconds") != std::string::npos);

    const auto* vinylFlickDescriptor = findNativeEffectDescriptor("vinyl_flick");
    assert(vinylFlickDescriptor != nullptr && vinylFlickDescriptor->sourceIndex == 53);
    assert(!vinylFlickDescriptor->inputAvailable && vinylFlickDescriptor->trackAvailable);
    const std::map<std::string, float> vinylFlickParameters{
        {"speed_percent", 0.0f}, {"motor_return_seconds", 1.5f},
        {"brake_percent", 35.0f}, {"mix_percent", 100.0f},
    };
    for (const auto slot : reverseSlots) {
        error.clear();
        assert(engine.setNativeCatalogSlot(slot, "vinyl_flick", vinylFlickParameters,
            false, error, NativeCatalogFxPath::Track));
    }
    const auto vinylTrackRoutes = engine.getStatus();
    for (std::size_t slot = 0U; slot < reverseSlots.size(); ++slot) {
        assert(vinylTrackRoutes.nativeCatalogSlotEffectIds[slot] == "vinyl_flick");
        assert(!vinylTrackRoutes.nativeCatalogSlotBypassed[slot]);
    }
    for (const auto slot : reverseSlots) {
        error.clear();
        assert(!engine.setNativeCatalogSlot(slot, "vinyl_flick", vinylFlickParameters,
            false, error, NativeCatalogFxPath::Input));
        assert(error.find("not available on the requested input path") != std::string::npos);
    }
    const auto vinylInputRejected = engine.getStatus();
    for (std::size_t slot = 0U; slot < reverseSlots.size(); ++slot) {
        assert(vinylInputRejected.nativeCatalogSlotEffectIds[slot] == "vinyl_flick");
        assert(vinylInputRejected.nativeInputCatalogSlotEffectIds[slot] != "vinyl_flick");
    }
}
