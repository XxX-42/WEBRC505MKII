#include "native_audio_core.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <new>
#include <string>
#include <thread>
#include <vector>

namespace {
bool trackAllocations = false;
std::size_t trackedAllocations = 0;
std::size_t trackedDeallocations = 0;
}

void* operator new(std::size_t size) {
    if (trackAllocations) {
        ++trackedAllocations;
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) {
        return memory;
    }
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (trackAllocations) {
        ++trackedAllocations;
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) {
        return memory;
    }
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept {
    if (trackAllocations && memory != nullptr) ++trackedDeallocations;
    std::free(memory);
}
void operator delete[](void* memory) noexcept {
    if (trackAllocations && memory != nullptr) ++trackedDeallocations;
    std::free(memory);
}
void operator delete(void* memory, std::size_t) noexcept {
    if (trackAllocations && memory != nullptr) ++trackedDeallocations;
    std::free(memory);
}
void operator delete[](void* memory, std::size_t) noexcept {
    if (trackAllocations && memory != nullptr) ++trackedDeallocations;
    std::free(memory);
}

namespace webrc::native {

struct NativeAudioCoreTestAccess {
    static std::uint64_t setMemoryBudgetEstimate(NativeAudioCore& core, std::uint64_t bytes) {
        const auto previous = core.nativeLooperPreallocatedBytes_;
        core.nativeLooperPreallocatedBytes_ = bytes; return previous;
    }
    static const NativeEffectProcessor* memoryProcessor(const NativeAudioCore& core, std::size_t bank) {
        return bank == 0U ? core.nativeInputFxBank_.processor(NativeEffectSlot::A) :
            bank == 1U ? core.outputStage_->trackFxBank().processor(NativeEffectSlot::A) :
            core.nativePerTrackFxBanks_[bank - 2U].processor(NativeEffectSlot::A);
    }
    static bool retainsMemoryGraph(const NativeAudioCore& core) {
        return core.projectImportTransaction_ && core.projectImportTransaction_->memory;
    }
    static void reserveGraphReader(NativeAudioCore& core, bool reserve) {
        core.projectGraphReaders_.store(reserve ? 1U : 0U, std::memory_order_seq_cst);
    }
    static void prepareWithoutDevice(NativeAudioCore& core) {
        EngineConfig config;
        config.sampleRate = 48000;
        core.currentConfig_ = config;
        assert(core.looper_.prepare(config.sampleRate, 1, 2));
        for (auto& track : core.additionalLoopers_) assert(track.prepare(config.sampleRate, 1, 2));
        core.nativeLooperMaxRecordSeconds_ = 1U;
        core.nativeLooperPreallocatedBytes_ = core.looper_.storageBytes();
        for (const auto& track : core.additionalLoopers_) core.nativeLooperPreallocatedBytes_ += track.storageBytes();
        assert(core.outputStage_->prepare(config.sampleRate));
        assert(core.nativeInputFxBank_.prepare(config.sampleRate));
        assert(core.nativePitchProcessor_->prepare(config.sampleRate, 70.0f, 1200.0f));
        assert(core.nativePolyPitchProcessor_->prepare(config.sampleRate));
        core.outputStage_->setLowPassEnabled(false, 0);
        assert(core.nativeRhythmEngine_.prepare(config.sampleRate));
        assert(core.nativeRhythmEngine_.setConfig(core.nativeRhythmConfig_, 0));
        std::uint64_t tempoBits = 0U;
        const double initialBpm = core.nativeRhythmConfig_.bpm;
        std::memcpy(&tempoBits, &initialBpm, sizeof(tempoBits));
        core.nativeTempoAppliedBpmBits_.store(tempoBits, std::memory_order_release);
        core.nativeTempoAppliedRevision_.store(core.nativeTempoRequestedRevision_, std::memory_order_release);
        core.nativeTempoAppliedValid_.store(true, std::memory_order_release);
    }

    static void installConfigTestDevices(NativeAudioCore& core) {
        DeviceDescriptor input;
        input.id = "WASAPI:1";
        input.name = "Test input";
        input.sampleRates = {48000U, 96000U, 192000U};
        input.maxInputChannels = 2U;
        DeviceDescriptor output;
        output.id = "WASAPI:2";
        output.name = "Test output";
        output.sampleRates = {48000U, 96000U, 192000U};
        output.maxOutputChannels = 2U;
        core.deviceCatalog_.inputsByBackend["WASAPI"] = {input};
        core.deviceCatalog_.outputsByBackend["WASAPI"] = {output};
        core.deviceCatalog_.defaultInputIdByBackend["WASAPI"] = input.id;
        core.deviceCatalog_.defaultOutputIdByBackend["WASAPI"] = output.id;
    }

    static void command(NativeAudioCore& core, CommandType type, bool value = false) {
        assert(core.commandQueue_.push({type, value}));
    }

    static void commandTrack(NativeAudioCore& core, CommandType type, std::size_t trackIndex, bool value = false) {
        assert(trackIndex < kNativeTrackCount);
        if (type != CommandType::SetRecordAction && type != CommandType::SetMonitoring)
            core.pendingTrackStateCommands_[trackIndex].fetch_add(1U, std::memory_order_acq_rel);
        assert(core.commandQueue_.push({type, value, static_cast<std::uint8_t>(trackIndex)}));
    }

    static LoopMetadata trackMetadata(const NativeAudioCore& core, std::size_t trackIndex) {
        return core.looperForTrack(trackIndex).metadata();
    }
    static std::optional<double> originalTempo(const NativeAudioCore& core, std::size_t trackIndex) {
        assert(trackIndex < kNativeTrackCount);
        const auto bits = core.originalTempoBpmBits_[trackIndex].load(std::memory_order_acquire);
        if (bits == 0U) return std::nullopt;
        double value = 0.0;
        std::memcpy(&value, &bits, sizeof(value));
        return value;
    }
    static void requestTrackSnapshotMetadata(NativeAudioCore& core, std::size_t trackIndex) {
        core.loopSnapshotTrackIndex_.store(trackIndex, std::memory_order_relaxed);
        const auto generation = core.loopSnapshotNextGeneration_.fetch_add(1U, std::memory_order_acq_rel) + 1U;
        core.loopSnapshotRequestGeneration_.store(generation, std::memory_order_relaxed);
        core.loopSnapshotCancelledGeneration_.store(0U, std::memory_order_relaxed);
        core.loopSnapshotAcknowledged_.store(false, std::memory_order_relaxed);
        core.loopSnapshotRequested_.store(true, std::memory_order_release);
    }
    static std::optional<double> snapshotOriginalTempo(const NativeAudioCore& core) {
        const auto bits = core.loopSnapshotOriginalTempoBits_.load(std::memory_order_acquire);
        if (bits == 0U) return std::nullopt;
        double value = 0.0;
        std::memcpy(&value, &bits, sizeof(value));
        return value;
    }
    static std::uint64_t snapshotTrackContentRevision(const NativeAudioCore& core) {
        return core.loopSnapshotContentRevision_.load(std::memory_order_acquire);
    }
    static void releaseTrackSnapshot(NativeAudioCore& core) {
        core.loopSnapshotRequested_.store(false, std::memory_order_release);
    }

    static void changeProjectRevisionForTest(NativeAudioCore& core, std::size_t trackIndex) {
        assert(trackIndex < kNativeTrackCount);
        core.trackContentRevision_[trackIndex].fetch_add(1U, std::memory_order_release);
        core.projectContentRevision_.fetch_add(1U, std::memory_order_release);
    }

    static void setProjectRevisionForTest(NativeAudioCore& core, std::uint64_t revision) {
        core.projectContentRevision_.store(revision, std::memory_order_release);
    }
    static void setLoopTransportFaultForTest(NativeAudioCore& core, std::size_t trackIndex, std::uint64_t revision) {
        assert(trackIndex < kNativeTrackCount);
        core.nativeLoopTransportFaultRevision_[trackIndex].store(revision, std::memory_order_release);
    }

    static void recordLoop(
        NativeAudioCore& core,
        std::size_t trackIndex,
        const std::vector<float>& samples,
        unsigned int blockFrames,
        float* output
    ) {
        assert(samples.size() % blockFrames == 0U);
        commandTrack(core, CommandType::Record, trackIndex);
        for (std::size_t offset = 0U; offset < samples.size(); offset += blockFrames) {
            assert(callback(core, samples.data() + offset, output, blockFrames) == 0);
        }
        commandTrack(core, CommandType::StopRecordOrPlayback, trackIndex);
        assert(callback(core, nullptr, output, blockFrames) == 0);
    }

    static void setInputChannels(NativeAudioCore& core, unsigned int channels) {
        assert(channels == 1U || channels == 2U);
        core.inputChannels_ = channels;
    }

    static bool storageBudgetAdmitted(
        const NativeAudioCore& core,
        unsigned int sampleRate,
        std::uint64_t budgetBytes,
        std::string& error
    ) {
        return core.validateLoopStorageBudgetLocked(sampleRate, budgetBytes, error);
    }

    static int callback(
        NativeAudioCore& core,
        const float* input,
        float* output,
        unsigned int frames
    ) {
        return NativeAudioCore::audioCallback(
            output,
            const_cast<float*>(input),
            frames,
            0.0,
            static_cast<RtAudioStreamStatus>(0),
            &core
        );
    }

    static void setRunningForQueueTest(NativeAudioCore& core, bool running) {
        core.engineRunning_.store(running, std::memory_order_release);
    }

    static void injectRejectedPerTrackControl(NativeAudioCore& core) {
        const auto revision = ++core.nativePerTrackSlotRevision_[0U][0U];
        assert(core.nativeCatalogFxCommandQueue_.push({NativeCatalogFxCommand::Type::SetParameter,
            NativeCatalogFxPath::Track, NativeEffectSlot::A, 255U, 0.0f, 1U, revision}));
        assert(core.nativeCatalogFxCommandQueue_.push({NativeCatalogFxCommand::Type::SetBypassed,
            NativeCatalogFxPath::Track, NativeEffectSlot::A, 0U, 0.0f, 1U, revision}));
    }

    static bool copyStereoTrack(NativeAudioCore& core, std::size_t trackIndex, float* destination,
        std::size_t destinationFrames, std::size_t& copiedFrames) {
        return core.looperForTrack(trackIndex).copyFinalizedStereoLoopSnapshot(destination, destinationFrames, copiedFrames);
    }

    static void injectUnpreparedPerTrackProcessor(NativeAudioCore& core) {
        assert(core.nativePerTrackFxBanks_[0U].setEffect(NativeEffectSlot::A, "dist"));
    }

    static std::size_t totalLooperStorageBytes(const NativeAudioCore& core) {
        std::size_t bytes = core.looper_.storageBytes();
        for (const auto& track : core.additionalLoopers_) bytes += track.storageBytes();
        return bytes;
    }

    static NativePitchMode runtimePitchMode(const NativeAudioCore& core) {
        return core.nativePitchRuntimeMode_;
    }

    static float monoPitchSemitones(const NativeAudioCore& core) {
        return core.nativePitchProcessor_->semitones();
    }

    static bool captureLoopSnapshot(
        NativeAudioCore& core,
        std::vector<float>& samples,
        unsigned int& sampleRate,
        std::string& error
    ) {
        return core.captureLoopSnapshot(samples, sampleRate, error);
    }

    static bool captureTrackSnapshot(
        NativeAudioCore& core,
        std::size_t trackIndex,
        std::vector<float>& samples,
        unsigned int& sampleRate,
        std::string& error
    ) {
        return core.captureTrackSnapshot(trackIndex, samples, sampleRate, error);
    }

    static bool loopSnapshotRequested(const NativeAudioCore& core) {
        return core.loopSnapshotRequested_.load(std::memory_order_acquire);
    }

    static void setHistoryRetainedBytesForBudgetTest(NativeAudioCore& core, std::uint64_t bytes) {
        core.historyRetainedBytes_.store(bytes, std::memory_order_release);
    }

    static std::uint64_t requestHistoryPinForTest(NativeAudioCore& core, std::size_t trackIndex) {
        const auto generation = core.historyPinNextGeneration_.fetch_add(1U, std::memory_order_acq_rel) + 1U;
        core.historyPinTrackIndex_.store(trackIndex, std::memory_order_relaxed);
        core.historyPinCancelledGeneration_.store(0U, std::memory_order_relaxed);
        core.historyPinRequestGeneration_.store(generation, std::memory_order_release);
        return generation;
    }

    static void releaseHistoryPinForTest(NativeAudioCore& core, std::uint64_t generation) {
        core.historyPinReleaseGeneration_.store(generation, std::memory_order_relaxed);
        core.historyPinRequestGeneration_.store(0U, std::memory_order_release);
    }

    static std::uint64_t historyPinAcknowledged(const NativeAudioCore& core) {
        return core.historyPinAcknowledgedGeneration_.load(std::memory_order_acquire);
    }

    static std::uint64_t historyPinReleased(const NativeAudioCore& core) {
        return core.historyPinReleasedGeneration_.load(std::memory_order_acquire);
    }

    static std::uint64_t historyPinRequest(const NativeAudioCore& core) {
        return core.historyPinRequestGeneration_.load(std::memory_order_acquire);
    }

    static std::uint64_t historyPinNextGeneration(const NativeAudioCore& core) {
        return core.historyPinNextGeneration_.load(std::memory_order_acquire);
    }

    static std::uint64_t historyPinReleaseRequest(const NativeAudioCore& core) {
        return core.historyPinReleaseGeneration_.load(std::memory_order_acquire);
    }

    static std::uint64_t markBytes(const NativeAudioCore& core, std::size_t trackIndex) {
        return core.markPcmBytes_[trackIndex].load(std::memory_order_acquire);
    }

    static bool markBusy(const NativeAudioCore& core, std::size_t trackIndex) {
        return core.markBusy_[trackIndex].load(std::memory_order_acquire);
    }

    static std::uint64_t markAppliedGeneration(const NativeAudioCore& core, std::size_t trackIndex) {
        return core.markAppliedGeneration_[trackIndex].load(std::memory_order_acquire);
    }

    static std::vector<float> copyMarkPcm(const NativeAudioCore& core, std::size_t trackIndex) {
        return core.markPcm_[trackIndex];
    }

    static std::size_t historyPinAcknowledgedTrack(const NativeAudioCore& core) {
        return core.historyPinAcknowledgedTrackIndex_.load(std::memory_order_acquire);
    }

    static void cancelPinAndInjectLateAckForTest(NativeAudioCore& core, std::uint64_t generation) {
        core.historyPinCancelledGeneration_.store(generation, std::memory_order_release);
        core.historyPinRequestGeneration_.store(0U, std::memory_order_release);
        core.historyPinAcknowledgedGeneration_.store(generation, std::memory_order_release);
    }

    static std::size_t commandQueueSize(const NativeAudioCore& core) { return core.commandQueue_.size(); }
    static std::size_t loopTransportQueueSize(const NativeAudioCore& core) {
        return core.nativeLoopTransportCommandQueue_.size();
    }
};

} // namespace webrc::native

using namespace webrc::native;

namespace {
std::vector<float> makeCallbackTestTone(float frequency, std::size_t count, float amplitude) {
    constexpr double pi = 3.14159265358979323846;
    constexpr double sampleRate = 48000.0;
    std::vector<float> values(count);
    for (std::size_t i = 0U; i < count; ++i) {
        values[i] = amplitude * static_cast<float>(std::sin(2.0 * pi * frequency * static_cast<double>(i) / sampleRate));
    }
    return values;
}

double callbackTestToneAmplitude(
    const std::vector<float>& interleavedStereo,
    std::size_t startFrame,
    std::size_t frameCount,
    float frequency
) {
    constexpr double pi = 3.14159265358979323846;
    constexpr double sampleRate = 48000.0;
    double sine = 0.0;
    double cosine = 0.0;
    for (std::size_t offset = 0U; offset < frameCount; ++offset) {
        const double phase = 2.0 * pi * frequency * static_cast<double>(offset) / sampleRate;
        const double sample = interleavedStereo[(startFrame + offset) * 2U];
        sine += sample * std::sin(phase);
        cosine += sample * std::cos(phase);
    }
    return 2.0 * std::sqrt(sine * sine + cosine * cosine) / static_cast<double>(frameCount);
}
}

void testNativePitchTargetsOnlySelectedTrackAndFallsBackOnItsLoopLength() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int blockFrames = 64U;
    constexpr unsigned int loopFrames = sampleRate;
    constexpr unsigned int analysisFrames = 4800U; // Exact integer periods for 110/220/330 Hz.
    constexpr unsigned int analysisStart = 24000U;
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    std::string error;
    NativePitchConfig config;
    config.enabled = true;
    config.trackId = 2U;
    config.mode = NativePitchMode::LivePolyPhaseVocoder;
    config.semitones = 7.0f;
    assert(core.setNativePitchConfig(config, error));

    const auto dryTrack = makeCallbackTestTone(110.0f, loopFrames, 0.15f);
    const auto pitchedTrack = makeCallbackTestTone(220.0f, loopFrames, 0.15f);
    std::array<float, blockFrames * 2U> blockOutput{};
    NativeAudioCoreTestAccess::recordLoop(core, 0U, dryTrack, blockFrames, blockOutput.data());
    NativeAudioCoreTestAccess::recordLoop(core, 1U, pitchedTrack, blockFrames, blockOutput.data());
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, blockOutput.data(), blockFrames) == 0);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 1U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, blockOutput.data(), blockFrames) == 0);

    std::vector<float> rendered(static_cast<std::size_t>(loopFrames) * 2U);
    for (unsigned int offset = 0U; offset < loopFrames; offset += blockFrames) {
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, blockOutput.data(), blockFrames) == 0);
        std::copy(blockOutput.begin(), blockOutput.end(), rendered.begin() + static_cast<std::ptrdiff_t>(offset * 2U));
    }
    const auto status = core.getStatus();
    assert(status.nativePitchTrackId == 2U);
    assert(status.nativePitchActive);
    assert(status.nativePitchFallbackReason == NativePitchFallbackReason::None);

    const double dryTrackAmplitude = callbackTestToneAmplitude(rendered, analysisStart, analysisFrames, 110.0f);
    const double selectedPitchAmplitude = callbackTestToneAmplitude(rendered, analysisStart, analysisFrames, 330.0f);
    const double selectedDryAmplitude = callbackTestToneAmplitude(rendered, analysisStart, analysisFrames, 220.0f);
    // Track 1's 110 Hz component retains its current phase and level, while
    // selected Track 2 moves from 220 Hz to the expected 330 Hz.
    assert(dryTrackAmplitude > 0.13 && dryTrackAmplitude < 0.17);
    assert(selectedPitchAmplitude > 0.05);
    assert(selectedDryAmplitude < selectedPitchAmplitude * 0.55);

    config.trackId = 0U;
    assert(core.setNativePitchConfig(config, error));
    std::vector<float> globalRendered(static_cast<std::size_t>(loopFrames) * 2U);
    for (unsigned int offset = 0U; offset < loopFrames; offset += blockFrames) {
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, blockOutput.data(), blockFrames) == 0);
        std::copy(blockOutput.begin(), blockOutput.end(), globalRendered.begin() + static_cast<std::ptrdiff_t>(offset * 2U));
    }
    const auto globalStatus = core.getStatus();
    assert(globalStatus.nativePitchTrackId == 0U);
    assert(globalStatus.nativePitchActive);
    const double globalTrack1Pitch = callbackTestToneAmplitude(globalRendered, analysisStart, analysisFrames, 165.0f);
    const double globalTrack2Pitch = callbackTestToneAmplitude(globalRendered, analysisStart, analysisFrames, 330.0f);
    const double globalTrack1Dry = callbackTestToneAmplitude(globalRendered, analysisStart, analysisFrames, 110.0f);
    const double globalTrack2Dry = callbackTestToneAmplitude(globalRendered, analysisStart, analysisFrames, 220.0f);
    assert(globalTrack1Pitch > 0.04 && globalTrack2Pitch > 0.04);
    assert(globalTrack1Dry < globalTrack1Pitch * 0.6);
    assert(globalTrack2Dry < globalTrack2Pitch * 0.6);

    config.trackId = 2U;
    NativeAudioCore shortSelectedCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(shortSelectedCore);
    assert(shortSelectedCore.setNativePitchConfig(config, error));
    std::array<float, 64U> shortTake{};
    shortTake.fill(0.08f);
    NativeAudioCoreTestAccess::recordLoop(shortSelectedCore, 0U, dryTrack, blockFrames, blockOutput.data());
    std::vector<float> shortSamples(shortTake.begin(), shortTake.end());
    NativeAudioCoreTestAccess::recordLoop(shortSelectedCore, 1U, shortSamples, blockFrames, blockOutput.data());
    NativeAudioCoreTestAccess::commandTrack(shortSelectedCore, CommandType::Play, 0U);
    assert(NativeAudioCoreTestAccess::callback(shortSelectedCore, nullptr, blockOutput.data(), blockFrames) == 0);
    NativeAudioCoreTestAccess::commandTrack(shortSelectedCore, CommandType::Play, 1U);
    assert(NativeAudioCoreTestAccess::callback(shortSelectedCore, nullptr, blockOutput.data(), blockFrames) == 0);
    assert(NativeAudioCoreTestAccess::callback(shortSelectedCore, nullptr, blockOutput.data(), blockFrames) == 0);
    const auto shortStatus = shortSelectedCore.getStatus();
    assert(shortStatus.nativePitchTrackId == 2U);
    assert(!shortStatus.nativePitchActive);
    assert(shortStatus.nativePitchFallbackReason == NativePitchFallbackReason::LoopShorterThanLatency);
}

void testNativePitchChangesOnlyLoopPlaybackAndIsRealtimeSafe() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 64U;
    constexpr unsigned int loopFrames = 12288U; // Whole 64-frame callbacks, including the final block
    constexpr double pi = 3.14159265358979323846;
    const auto makeTone = [=](float frequency, std::size_t count, float amplitude) {
        std::vector<float> values(count);
        for (std::size_t i = 0U; i < count; ++i) {
            values[i] = amplitude * static_cast<float>(std::sin(2.0 * pi * frequency * static_cast<double>(i) / sampleRate));
        }
        return values;
    };

    NativeAudioCore pitchCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(pitchCore);
    std::string error;
    NativePitchConfig pitchConfig;
    pitchConfig.enabled = true;
    pitchConfig.semitones = 7.0f;
    assert(pitchCore.setNativePitchConfig(pitchConfig, error));
    auto take = makeTone(220.0f, loopFrames, 0.3f);
    std::array<float, frames * 2U> output{};
    NativeAudioCoreTestAccess::command(pitchCore, CommandType::Record);
    for (unsigned int offset = 0U; offset < loopFrames; offset += frames) {
        assert(NativeAudioCoreTestAccess::callback(pitchCore, take.data() + offset, output.data(), frames) == 0);
    }
    NativeAudioCoreTestAccess::command(pitchCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(pitchCore, nullptr, output.data(), frames) == 0);
    NativeAudioCoreTestAccess::command(pitchCore, CommandType::Play);

    double changedEnergy = 0.0;
    double dryEnergy = 0.0;
    const auto latency = pitchCore.getStatus().nativePitchLatencySamples;
    for (unsigned int offset = 0U; offset < loopFrames; offset += frames) {
        const auto allocationsBefore = trackedAllocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(pitchCore, nullptr, output.data(), frames) == 0);
        trackAllocations = false;
        assert(trackedAllocations == allocationsBefore);
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            const unsigned int absoluteFrame = offset + frame;
            const float rendered = output[frame * 2U];
            assert(std::isfinite(rendered));
            if (absoluteFrame >= latency + sampleRate / 10U) {
                changedEnergy += std::fabs(static_cast<double>(rendered) - take[absoluteFrame]);
                dryEnergy += std::fabs(static_cast<double>(take[absoluteFrame]));
            }
        }
    }
    auto status = pitchCore.getStatus();
    assert(status.nativePitchEnabled && status.nativePitchCorrectionImplemented);
    assert(status.nativePitchTrackId == 0U); // Legacy global playback bus remains the default.
    assert(status.nativePitchActive && status.nativePitchFallbackReason == NativePitchFallbackReason::None);
    assert(status.nativePitchVoiced && status.nativePitchFrequencyHz > 205.0f && status.nativePitchFrequencyHz < 235.0f);
    assert(changedEnergy > dryEnergy * 0.15);

    NativeAudioCoreTestAccess::command(pitchCore, CommandType::StopRecordOrPlayback);
    const auto stopAllocations = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(pitchCore, nullptr, output.data(), frames) == 0);
    trackAllocations = false;
    assert(trackedAllocations == stopAllocations);
    NativeAudioCoreTestAccess::command(pitchCore, CommandType::Play);
    const auto restartAllocations = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(pitchCore, nullptr, output.data(), frames) == 0);
    trackAllocations = false;
    assert(trackedAllocations == restartAllocations);
    for (const float sample : output) {
        // The fixed-latency processor has just reset; old OLA grains from the
        // previous play pass must not leak into the new transport epoch.
        assert(std::fabs(sample) < 1.0e-6f);
    }

    // A silent stored loop keeps the playback tap at zero. A live tone on the
    // monitoring path must pass unchanged even while the pitch route is active.
    NativeAudioCore monitorCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(monitorCore);
    assert(monitorCore.setNativePitchConfig(pitchConfig, error));
    std::array<float, frames> silent{};
    NativeAudioCoreTestAccess::command(monitorCore, CommandType::Record);
    for (unsigned int offset = 0U; offset < loopFrames; offset += frames) {
        assert(NativeAudioCoreTestAccess::callback(monitorCore, silent.data(), output.data(), frames) == 0);
    }
    NativeAudioCoreTestAccess::command(monitorCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(monitorCore, nullptr, output.data(), frames) == 0);
    NativeAudioCoreTestAccess::command(monitorCore, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::command(monitorCore, CommandType::Play);
    auto live = makeTone(220.0f, frames, 0.2f);
    for (unsigned int block = 0U; block < 8U; ++block) {
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            live[frame] = 0.2f * static_cast<float>(std::sin(2.0 * pi * 220.0 *
                static_cast<double>(block * frames + frame) / sampleRate));
        }
        assert(NativeAudioCoreTestAccess::callback(monitorCore, live.data(), output.data(), frames) == 0);
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            assert(std::fabs(output[frame * 2U] - live[frame]) < 1.0e-6f);
            assert(std::fabs(output[frame * 2U + 1U] - live[frame]) < 1.0e-6f);
        }
    }
    status = monitorCore.getStatus();
    assert(status.nativePitchActive);

    // A short loop takes the explicit dry fallback; restarting after a stop
    // also resets the processor's fixed state before playback resumes.
    NativeAudioCore shortCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(shortCore);
    assert(shortCore.setNativePitchConfig(pitchConfig, error));
    std::array<float, 64> shortTake{};
    shortTake.fill(0.1f);
    NativeAudioCoreTestAccess::command(shortCore, CommandType::Record);
    assert(NativeAudioCoreTestAccess::callback(shortCore, shortTake.data(), output.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(shortCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(shortCore, nullptr, output.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(shortCore, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(shortCore, nullptr, output.data(), 64U) == 0);
    status = shortCore.getStatus();
    assert(!status.nativePitchActive);
    assert(status.nativePitchFallbackReason == NativePitchFallbackReason::LoopShorterThanLatency);
    pitchConfig.reversePlayback = true;
    assert(shortCore.setNativePitchConfig(pitchConfig, error));
    NativeAudioCoreTestAccess::command(shortCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(shortCore, nullptr, output.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(shortCore, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(shortCore, nullptr, output.data(), 64U) == 0);
    status = shortCore.getStatus();
    assert(status.nativePitchFallbackReason == NativePitchFallbackReason::ReversePlayback);
}

void testNativeLivePolyPitchUsesOnlyPlaybackTap() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 64U;
    constexpr unsigned int loopFrames = sampleRate;
    constexpr double pi = 3.14159265358979323846;
    const auto makeTone = [=](float frequency, std::size_t count, float amplitude) {
        std::vector<float> values(count);
        for (std::size_t i = 0U; i < count; ++i) {
            values[i] = amplitude * static_cast<float>(std::sin(2.0 * pi * frequency * static_cast<double>(i) / sampleRate));
        }
        return values;
    };

    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    std::string error;
    NativePitchConfig config;
    config.enabled = true;
    config.mode = NativePitchMode::LivePolyPhaseVocoder;
    config.semitones = 7.0f;
    assert(core.setNativePitchConfig(config, error));
    const auto take = makeTone(220.0f, loopFrames, 0.3f);
    std::array<float, frames * 2U> output{};
    NativeAudioCoreTestAccess::command(core, CommandType::Record);
    for (unsigned int offset = 0U; offset < loopFrames; offset += frames) {
        assert(NativeAudioCoreTestAccess::callback(core, take.data() + offset, output.data(), frames) == 0);
    }
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);

    std::vector<float> rendered(static_cast<std::size_t>(loopFrames) * 2U);
    for (unsigned int offset = 0U; offset < loopFrames; offset += frames) {
        const auto allocationsBefore = trackedAllocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
        trackAllocations = false;
        assert(trackedAllocations == allocationsBefore);
        std::copy(output.begin(), output.end(), rendered.begin() + static_cast<std::ptrdiff_t>(offset * 2U));
    }
    const auto status = core.getStatus();
    assert(status.nativePitchMode == NativePitchMode::LivePolyPhaseVocoder);
    assert(status.nativePitchLatencySamples == NativePolyPitchProcessor::calculateLatencySamples(sampleRate));
    assert(status.nativePitchLatencySamples == 6720U);
    assert(status.nativePitchActive);
    assert(status.nativePitchFallbackReason == NativePitchFallbackReason::None);

    std::vector<float> left(loopFrames);
    for (unsigned int frame = 0U; frame < loopFrames; ++frame) left[frame] = rendered[frame * 2U];
    const auto start = static_cast<std::size_t>(status.nativePitchLatencySamples) + sampleRate / 5U;
    const auto end = start + sampleRate / 2U;
    std::size_t crossings = 0U;
    for (std::size_t i = start + 1U; i < end; ++i) {
        if (left[i - 1U] <= 0.0f && left[i] > 0.0f) ++crossings;
    }
    const double measuredHz = static_cast<double>(crossings) * sampleRate / static_cast<double>(end - start);
    const double expectedHz = 220.0 * std::pow(2.0, 7.0 / 12.0);
    assert(measuredHz > expectedHz * 0.94 && measuredHz < expectedHz * 1.06);

    // A running mode/parameter change is handed over through the bounded
    // command queue and becomes active only when the callback drains it.
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    config.mode = NativePitchMode::LiveMonoKeepPitch;
    config.semitones = 2.0f;
    assert(core.setNativePitchConfig(config, error));
    assert(NativeAudioCoreTestAccess::runtimePitchMode(core) == NativePitchMode::LivePolyPhaseVocoder);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    assert(NativeAudioCoreTestAccess::runtimePitchMode(core) == NativePitchMode::LiveMonoKeepPitch);
    assert(std::fabs(NativeAudioCoreTestAccess::monoPitchSemitones(core) - 2.0f) < 1.0e-6f);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);

    // Reverse and short-loop routes must leave this mode on ordinary dry
    // playback, without moving input monitoring into the Signalsmith path.
    config.mode = NativePitchMode::LivePolyPhaseVocoder;
    config.semitones = 7.0f;
    config.reversePlayback = true;
    assert(core.setNativePitchConfig(config, error));
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    assert(core.getStatus().nativePitchFallbackReason == NativePitchFallbackReason::ReversePlayback);

    NativeAudioCore monitorCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(monitorCore);
    config.reversePlayback = false;
    assert(monitorCore.setNativePitchConfig(config, error));
    std::vector<float> silentTake(loopFrames, 0.0f);
    NativeAudioCoreTestAccess::command(monitorCore, CommandType::Record);
    for (unsigned int offset = 0U; offset < loopFrames; offset += frames) {
        assert(NativeAudioCoreTestAccess::callback(monitorCore, silentTake.data() + offset, output.data(), frames) == 0);
    }
    NativeAudioCoreTestAccess::command(monitorCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(monitorCore, nullptr, output.data(), frames) == 0);
    NativeAudioCoreTestAccess::command(monitorCore, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::command(monitorCore, CommandType::Play);
    auto monitoredTone = makeTone(220.0f, frames, 0.2f);
    for (unsigned int block = 0U; block < 16U; ++block) {
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            monitoredTone[frame] = 0.2f * static_cast<float>(std::sin(
                2.0 * pi * 220.0 * static_cast<double>(block * frames + frame) / sampleRate));
        }
        assert(NativeAudioCoreTestAccess::callback(monitorCore, monitoredTone.data(), output.data(), frames) == 0);
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            assert(std::fabs(output[frame * 2U] - monitoredTone[frame]) < 1.0e-6f);
            assert(std::fabs(output[frame * 2U + 1U] - monitoredTone[frame]) < 1.0e-6f);
        }
    }
    assert(monitorCore.getStatus().nativePitchActive);

    NativeAudioCore shortCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(shortCore);
    assert(shortCore.setNativePitchConfig(config, error));
    std::array<float, frames> shortTake{};
    shortTake.fill(0.1f);
    NativeAudioCoreTestAccess::command(shortCore, CommandType::Record);
    assert(NativeAudioCoreTestAccess::callback(shortCore, shortTake.data(), output.data(), frames) == 0);
    NativeAudioCoreTestAccess::command(shortCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(shortCore, nullptr, output.data(), frames) == 0);
    NativeAudioCoreTestAccess::command(shortCore, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(shortCore, nullptr, output.data(), frames) == 0);
    const auto shortStatus = shortCore.getStatus();
    assert(shortStatus.nativePitchMode == NativePitchMode::LivePolyPhaseVocoder);
    assert(!shortStatus.nativePitchActive);
    assert(shortStatus.nativePitchFallbackReason == NativePitchFallbackReason::LoopShorterThanLatency);
}

void testNativeCatalogSlotsRunInsidePlaybackCallback() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    std::string error;
    const std::map<std::string, float> lowPassParameters{
        {"cutoff_hz", 300.0f},
        {"resonance_percent", 15.0f},
    };
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "filter.lpf", lowPassParameters, false, error));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::B, "filter.bpf", {}, true, error));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::C, "filter.hpf", {}, true, error));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::D, "auto_pan", {}, true, error));
    auto status = core.getStatus();
    assert(status.nativeCatalogGraphAvailable);
    assert(status.nativeCatalogSlotEffectIds[0] == "filter.lpf");
    assert(status.nativeCatalogSlotEffectIds[1] == "filter.bpf");
    assert(status.nativeCatalogSlotEffectIds[2] == "filter.hpf");
    assert(status.nativeCatalogSlotEffectIds[3] == "auto_pan");
    assert(!status.nativeCatalogSlotBypassed[0]);
    assert(status.nativeCatalogSlotBypassed[1] && status.nativeCatalogSlotBypassed[2] && status.nativeCatalogSlotBypassed[3]);

    NativeAudioCoreTestAccess::command(core, CommandType::SetMonitoring, true);
    std::array<float, 64U> take{};
    take[0] = 0.7f;
    take[1] = -0.35f;
    std::array<float, 64U> live{};
    live.fill(0.1f);
    std::array<float, 128U> output{};
    NativeAudioCoreTestAccess::command(core, CommandType::Record);
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 64U) == 0);
    for (std::size_t frame = 0U; frame < take.size(); ++frame) {
        assert(std::fabs(output[frame * 2U] - take[frame]) < 1.0e-6f);
        assert(std::fabs(output[frame * 2U + 1U] - take[frame]) < 1.0e-6f);
    }

    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "filter.lpf",
        {{"cutoff_hz", 600.0f}, {"q", 0.8f}}, false, error));
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "phaser", {}, false, error));
    assert(error.find("Stop Native audio") != std::string::npos);

    const auto allocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, live.data(), output.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationsBefore);
    assert(std::isfinite(output[0]));
    assert(std::fabs(output[0] - (take[0] + live[0])) > 0.1f);
    assert(output[0] > live[0] + 1.0e-5f);
}

void testNativeInputCatalogBankProcessesBeforeRecordAndMonitor() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    std::string error;
    const std::map<std::string, float> parameters{
        {"cutoff_hz", 300.0f},
        {"resonance_percent", 15.0f},
    };
    assert(core.setNativeCatalogSlot(
        NativeEffectSlot::A,
        "filter.lpf",
        parameters,
        false,
        error,
        NativeCatalogFxPath::Input
    ));
    auto status = core.getStatus();
    assert(status.nativeInputCatalogSlotEffectIds[0] == "filter.lpf");
    assert(status.nativeCatalogSlotEffectIds[0].empty());
    assert(!status.nativeInputCatalogSlotBypassed[0]);

    NativeAudioCoreTestAccess::command(core, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::command(core, CommandType::Record);
    std::array<float, 64U> impulse{};
    impulse[0] = 0.7f;
    std::array<float, 128U> output{};
    const std::size_t allocationCount = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, impulse.data(), output.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationCount);

    // The mono impulse is filtered before LooperCore receives it, so the live
    // monitor and recorded take begin below the original 0.7 amplitude.
    assert(std::isfinite(output[0]) && std::fabs(output[0]) < 0.1f);
    double filteredEnergy = 0.0;
    for (std::size_t frame = 0U; frame < 64U; ++frame) {
        assert(std::isfinite(output[frame * 2U]));
        assert(std::isfinite(output[frame * 2U + 1U]));
        filteredEnergy += static_cast<double>(output[frame * 2U]) * output[frame * 2U];
    }
    assert(filteredEnergy > 1.0e-4 && filteredEnergy < 0.49);
}

void testNativeTrackFxApplySelectsRecordingSourceAtCallbackBoundary() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    std::string error;
    const std::map<std::string, float> parameters{
        {"cutoff_hz", 300.0f},
        {"resonance_percent", 15.0f},
    };
    assert(core.setNativeCatalogSlot(
        NativeEffectSlot::A, "filter.lpf", parameters, false, error, NativeCatalogFxPath::Input));

    std::array<float, 128U> firstInput{};
    firstInput[0U] = 0.7f;
    firstInput[1U] = -0.4f;
    std::array<float, 256U> firstOutput{};
    NativeAudioCoreTestAccess::command(core, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Record, 0U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::uint64_t rejectedRevision = 17U;
    assert(!core.setNativeTrackFxApply(6U, false, rejectedRevision, error));
    assert(rejectedRevision == 17U);

    const auto allocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, firstInput.data(), firstOutput.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationsBefore);

    // Track 1 starts with the default InputFX recording source. Switch it off
    // while the same take is recording; the next callback must both ACK and
    // write the raw lane while monitor output continues through InputFX.
    std::array<float, 128U> rawInput{};
    for (std::size_t frame = 0U; frame < 64U; ++frame) {
        rawInput[frame * 2U] = 0.25f;
        rawInput[frame * 2U + 1U] = -0.5f;
    }
    std::array<float, 256U> secondOutput{};
    std::uint64_t requestedRevision = 0U;
    assert(core.setNativeTrackFxApply(1U, false, requestedRevision, error));
    assert(requestedRevision == 1U);
    const auto secondAllocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, rawInput.data(), secondOutput.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == secondAllocationsBefore);

    const auto status = core.getStatus();
    assert(status.nativeTrackFxApplyAvailable);
    assert(!status.nativeTrackFxApply[0U].requested);
    assert(!status.nativeTrackFxApply[0U].applied);
    assert(status.nativeTrackFxApply[0U].requestedRevision == requestedRevision);
    assert(status.nativeTrackFxApply[0U].appliedRevision == requestedRevision);
    assert(status.nativeTrackFxApply[0U].semanticRevision == 1U);
    assert(std::isfinite(status.nativeTrackFxApply[0U].peak));
    assert(std::isfinite(status.nativeTrackFxApply[0U].rms));

    // The monitor stays on the processed input path after the recording
    // selector changes to raw.
    assert(std::fabs(secondOutput[0U] - rawInput[0U]) > 1.0e-4f);
    assert(std::fabs(secondOutput[1U] - rawInput[1U]) > 1.0e-4f);

    NativeAudioCoreTestAccess::commandTrack(core, CommandType::StopRecordOrPlayback, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, secondOutput.data(), 64U) == 0);
    std::array<float, 256U> recorded{};
    std::size_t copiedFrames = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, recorded.data(), 128U, copiedFrames));
    assert(copiedFrames == 128U);
    assert(std::fabs(recorded[0U] - firstInput[0U]) > 0.1f);
    assert(std::fabs(recorded[1U] - firstInput[1U]) > 0.1f);
    for (std::size_t frame = 0U; frame < 64U; ++frame) {
        assert(recorded[(frame + 64U) * 2U] == rawInput[frame * 2U]);
        assert(recorded[(frame + 64U) * 2U + 1U] == rawInput[frame * 2U + 1U]);
    }
    std::uint64_t repeatedRevision = 0U;
    assert(core.setNativeTrackFxApply(1U, false, repeatedRevision, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, secondOutput.data(), 64U) == 0);
    assert(core.getStatus().nativeTrackFxApply[0U].semanticRevision == 1U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeTrackFxApplyPlaybackPreservesPrivateChainsAndStereoIsolation() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    constexpr unsigned int frames = 64U;
    std::array<float, frames * 2U> output{};
    std::string error;
    NativeAudioCoreTestAccess::recordLoop(core, 0U, std::vector<float>(2048U, 0.1f), frames, output.data());
    NativeAudioCoreTestAccess::recordLoop(core, 1U, std::vector<float>(2048U, 0.2f), frames, output.data());
    // Private banks remain before the selector: track 1 right, track 2 left.
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {{"position", 100.0f}}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {{"position", -100.0f}}, false, error, NativeCatalogFxPath::Track, 2U));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {{"position", -100.0f}}, false, error, NativeCatalogFxPath::Track));
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 0U);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 1U);
    const auto render = [&] {
        const auto allocations = trackedAllocations;
        const auto deallocations = trackedDeallocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
        trackAllocations = false;
        assert(trackedAllocations == allocations && trackedDeallocations == deallocations);
    };
    const auto assertPcm = [&](float left, float right) {
        for (std::size_t frame = 0U; frame < frames; ++frame) {
            assert(std::fabs(output[frame * 2U] - left) < 1.0e-6f);
            assert(std::fabs(output[frame * 2U + 1U] - right) < 1.0e-6f);
        }
    };
    for (unsigned int block = 0U; block < 20U; ++block) render();
    // Default all-on matches the old summed-bus shared pan result exactly.
    assertPcm(0.2f, 0.0f);
    std::uint64_t revision = 0U;
    assert(core.setNativeTrackFxApply(1U, false, revision, error));
    assert(core.getStatus().nativeTrackFxApply[0U].appliedRevision < revision);
    render();
    assertPcm(0.2f, 0.1f);
    auto status = core.getStatus();
    assert(status.nativeTrackFxApply[0U].appliedRevision == revision);
    assert(!status.nativeTrackFxApply[0U].applied && status.nativeTrackFxApply[1U].applied);
    for (std::size_t track = 2U; track < kNativeTrackCount; ++track) {
        assert(status.nativeTrackFxApply[track].peak == 0.0f && status.nativeTrackFxApply[track].rms == 0.0f);
    }
    assert(core.setNativeTrackFxApply(2U, false, revision, error));
    render();
    assertPcm(0.2f, 0.1f);
    assert(core.setNativeTrackFxApply(1U, true, revision, error));
    render();
    assertPcm(0.2f, 0.0f);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeInputCatalogLoFiProcessesLiveBeforeRecord() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    std::string error;
    const std::map<std::string, float> parameters{
        {"bit_depth", 6.0f},
        {"sample_rate_hz", 6000.0f},
        {"filter_hz", 4000.0f},
        {"mix_percent", 100.0f},
    };
    assert(core.setNativeCatalogSlot(
        NativeEffectSlot::B,
        "lo_fi",
        parameters,
        false,
        error,
        NativeCatalogFxPath::Input
    ));
    assert(core.getStatus().nativeInputCatalogSlotEffectIds[1] == "lo_fi");

    NativeAudioCoreTestAccess::command(core, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::command(core, CommandType::Record);
    std::array<float, 64U> input{};
    for (std::size_t frame = 0U; frame < input.size(); ++frame) {
        input[frame] = 0.65f * std::sin(static_cast<float>(frame) * 0.37f);
    }
    std::array<float, 128U> output{};
    const std::size_t allocationCount = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationCount);

    double differenceEnergy = 0.0;
    double outputEnergy = 0.0;
    for (std::size_t frame = 0U; frame < 64U; ++frame) {
        const float left = output[frame * 2U];
        const float right = output[frame * 2U + 1U];
        assert(std::isfinite(left) && std::isfinite(right));
        differenceEnergy += static_cast<double>(left - input[frame]) * (left - input[frame]);
        outputEnergy += static_cast<double>(left) * left;
    }
    assert(outputEnergy > 1.0e-4);
    assert(differenceEnergy > 1.0e-3);
}

void testNativeLoopSnapshotPinsTransportMutations() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);

    std::array<float, 128U> take{};
    for (std::size_t frame = 0U; frame < take.size(); ++frame) {
        take[frame] = static_cast<float>(frame) / 128.0f - 0.5f;
    }
    std::array<float, 256U> output{};
    NativeAudioCoreTestAccess::command(core, CommandType::Record);
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::callback(core, take.data() + 64U, output.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.getStatus().state == LooperState::Stopped);

    std::vector<float> snapshot;
    unsigned int sampleRate = 0U;
    std::string error;
    bool captured = false;
    std::thread exporter([&] {
        captured = NativeAudioCoreTestAccess::captureLoopSnapshot(core, snapshot, sampleRate, error);
    });

    for (unsigned int wait = 0U; wait < 200U && !NativeAudioCoreTestAccess::loopSnapshotRequested(core); ++wait) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    assert(NativeAudioCoreTestAccess::loopSnapshotRequested(core));

    // The clear request is queued after snapshot request but before the next
    // callback. That callback must pin the existing take before draining it.
    NativeAudioCoreTestAccess::command(core, CommandType::Clear);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    exporter.join();

    assert(captured);
    assert(error.empty());
    assert(sampleRate == 48000U);
    assert(snapshot.size() == take.size());
    assert(std::equal(snapshot.begin(), snapshot.end(), take.begin()));
    assert(core.getStatus().state == LooperState::Stopped);

    // Releasing the pin lets the pending Clear apply on the next callback.
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.getStatus().state == LooperState::Empty);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeLoopSnapshotRejectsEmptyRecordingAndOverdubbing() {
    const auto captureWithCallback = [](NativeAudioCore& core, std::string& error) {
        std::vector<float> snapshot;
        unsigned int sampleRate = 0U;
        bool captured = false;
        std::thread exporter([&] {
            captured = NativeAudioCoreTestAccess::captureLoopSnapshot(core, snapshot, sampleRate, error);
        });
        for (unsigned int wait = 0U; wait < 200U && !NativeAudioCoreTestAccess::loopSnapshotRequested(core); ++wait) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        assert(NativeAudioCoreTestAccess::loopSnapshotRequested(core));
        std::array<float, 64U> input{};
        std::array<float, 128U> output{};
        assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 64U) == 0);
        exporter.join();
        assert(!captured);
        assert(snapshot.empty());
    };

    std::string error;
    NativeAudioCore emptyCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(emptyCore);
    NativeAudioCoreTestAccess::setRunningForQueueTest(emptyCore, true);
    captureWithCallback(emptyCore, error);
    assert(error.find("finalized, non-empty loop") != std::string::npos);
    NativeAudioCoreTestAccess::setRunningForQueueTest(emptyCore, false);

    error.clear();
    NativeAudioCore recordingCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(recordingCore);
    NativeAudioCoreTestAccess::setRunningForQueueTest(recordingCore, true);
    NativeAudioCoreTestAccess::command(recordingCore, CommandType::Record);
    std::array<float, 64U> input{};
    std::array<float, 128U> output{};
    assert(NativeAudioCoreTestAccess::callback(recordingCore, input.data(), output.data(), 64U) == 0);
    captureWithCallback(recordingCore, error);
    assert(error.find("Stop recording or overdubbing") != std::string::npos);
    NativeAudioCoreTestAccess::setRunningForQueueTest(recordingCore, false);

    error.clear();
    NativeAudioCore overdubCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(overdubCore);
    NativeAudioCoreTestAccess::setRunningForQueueTest(overdubCore, true);
    NativeAudioCoreTestAccess::command(overdubCore, CommandType::Record);
    assert(NativeAudioCoreTestAccess::callback(overdubCore, input.data(), output.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(overdubCore, CommandType::StopRecordOrPlayback);
    assert(NativeAudioCoreTestAccess::callback(overdubCore, nullptr, output.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(overdubCore, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(overdubCore, nullptr, output.data(), 64U) == 0);
    NativeAudioCoreTestAccess::command(overdubCore, CommandType::ToggleOverdub);
    assert(NativeAudioCoreTestAccess::callback(overdubCore, input.data(), output.data(), 64U) == 0);
    assert(overdubCore.getStatus().state == LooperState::Overdubbing);
    captureWithCallback(overdubCore, error);
    assert(error.find("Stop recording or overdubbing") != std::string::npos);
    NativeAudioCoreTestAccess::setRunningForQueueTest(overdubCore, false);
}

void testNativeFiveTrackStereoMixAndTrackCommands() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);

    std::array<float, 128U> input{};
    std::array<float, 128U> output{};
    std::string error;
    for (std::size_t trackIndex = 0U; trackIndex < kNativeTrackCount; ++trackIndex) {
        const float left = 0.1f * static_cast<float>(trackIndex + 1U);
        const float right = -0.05f * static_cast<float>(trackIndex + 1U);
        for (std::size_t frame = 0U; frame < 64U; ++frame) {
            input[frame * 2U] = left;
            input[frame * 2U + 1U] = right;
        }
        assert(core.recordTrack(trackIndex, error));
        assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 64U) == 0);
        assert(core.stopTrack(trackIndex, error));
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    }

    for (std::size_t trackIndex = 0U; trackIndex < kNativeTrackCount; ++trackIndex) {
        assert(core.playTrack(trackIndex, error));
    }
    const auto allocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationsBefore);
    for (std::size_t frame = 0U; frame < 64U; ++frame) {
        assert(std::fabs(output[frame * 2U] - 1.0f) < 1.0e-6f);
        assert(std::fabs(output[frame * 2U + 1U] + 0.75f) < 1.0e-6f);
    }

    auto status = core.getStatus();
    assert(status.nativeLooperTrackCount == 5U);
    assert(status.nativeLooperMultiTrackImplemented);
    assert(status.nativeLooperTracksStereo);
    assert(status.nativeLooperMaxRecordSeconds == 1U);
    assert(status.nativeLooperPreallocatedBytes == 5U * 48000U * 2U * sizeof(float));
    assert(status.nativeLooperStorageBudgetBytes == LooperCore::kDefaultAggregateLoopStorageBudgetBytes);
    assert(!NativeAudioCoreTestAccess::storageBudgetAdmitted(
        core, 96000U, LooperCore::kDefaultAggregateLoopStorageBudgetBytes, error));
    assert(error.find("at most 209 seconds per track") != std::string::npos);
    assert(NativeAudioCoreTestAccess::storageBudgetAdmitted(
        core, 96000U, 1536ULL * 1024ULL * 1024ULL, error));
    assert(NativeAudioCoreTestAccess::storageBudgetAdmitted(
        core, 192000U, 2560ULL * 1024ULL * 1024ULL, error));
    assert(!NativeAudioCoreTestAccess::storageBudgetAdmitted(core, 48000U, 32ULL * 1024ULL * 1024ULL, error));
    assert(error.find("between 64 MiB and 3072 MiB") != std::string::npos);
    const auto statusAfterRejectedRate = core.getStatus();
    assert(statusAfterRejectedRate.sampleRate == 48000U);
    assert(statusAfterRejectedRate.nativeLooperMaxRecordSeconds == status.nativeLooperMaxRecordSeconds);
    assert(statusAfterRejectedRate.nativeLooperPreallocatedBytes == status.nativeLooperPreallocatedBytes);
    error.clear();
    for (std::size_t trackIndex = 0U; trackIndex < kNativeTrackCount; ++trackIndex) {
        assert(status.nativeTrackStates[trackIndex] == LooperState::Playing);
    }

    // Track export preserves distinct left/right channels and pins playback
    // against queued mutations at the callback boundary.
    std::vector<float> snapshot;
    unsigned int sampleRate = 0U;
    bool captured = false;
    std::thread exporter([&] {
        captured = NativeAudioCoreTestAccess::captureTrackSnapshot(core, 2U, snapshot, sampleRate, error);
    });
    for (unsigned int wait = 0U; wait < 200U && !NativeAudioCoreTestAccess::loopSnapshotRequested(core); ++wait) {
        // Track snapshots first ask the callback to release the previous pin.
        // This test drives callbacks manually, so keep doing so while the
        // exporter waits for that release acknowledgement and requests its
        // new track generation.
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    assert(NativeAudioCoreTestAccess::loopSnapshotRequested(core));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    exporter.join();
    assert(captured);
    assert(error.empty());
    assert(sampleRate == 48000U);
    assert(snapshot.size() == 128U);
    for (std::size_t frame = 0U; frame < 64U; ++frame) {
        assert(std::fabs(snapshot[frame * 2U] - 0.3f) < 1.0e-6f);
        assert(std::fabs(snapshot[frame * 2U + 1U] + 0.15f) < 1.0e-6f);
    }

    assert(core.clearTrack(2U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    status = core.getStatus();
    assert(status.nativeTrackStates[2U] == LooperState::Empty);
    assert(status.nativeTrackStates[1U] == LooperState::Playing);
    assert(status.nativeTrackStates[3U] == LooperState::Playing);
    assert(!core.clearTrack(kNativeTrackCount, error));
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testSampleRateChangeRejectsNonEmptyTrackWithoutLosingPcm() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::installConfigTestDevices(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);

    constexpr unsigned int frames = 64U;
    std::array<float, frames * 2U> input{};
    std::array<float, frames * 2U> output{};
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        input[frame * 2U] = 0.25f;
        input[frame * 2U + 1U] = -0.125f;
    }
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Record, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), frames) == 0);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::StopRecordOrPlayback, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);

    auto requested = core.getCurrentConfig().value();
    requested.sampleRate = 96000U;
    requested.nativeLooperStorageBudgetBytes = 1536ULL * 1024ULL * 1024ULL;
    std::string error;
    assert(!core.applyConfig(requested, error));
    assert(error.find("Export or back up the loops") != std::string::npos);
    const auto retainedConfig = core.getCurrentConfig();
    assert(retainedConfig.has_value());
    assert(retainedConfig->sampleRate == 48000U);
    assert(retainedConfig->nativeLooperStorageBudgetBytes == LooperCore::kDefaultAggregateLoopStorageBudgetBytes);
    assert(core.getStatus().nativeTrackStates[0] == LooperState::Stopped);

    // The rejected reconfiguration must leave the finalized stereo PCM intact.
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        assert(std::fabs(output[frame * 2U] - 0.25f) < 1.0e-6f);
        assert(std::fabs(output[frame * 2U + 1U] + 0.125f) < 1.0e-6f);
    }
}

void testNativeRecordingCallbackUsesPreparedStorageWithoutAllocation() {
    constexpr unsigned int frames = 64U;
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    assert(NativeAudioCoreTestAccess::totalLooperStorageBytes(core) ==
        kNativeTrackCount * 48000U * 2U * sizeof(float));
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);

    std::array<float, frames * 2U> input{};
    std::array<float, frames * 2U> output{};
    input.fill(0.125f);
    std::string error;
    for (std::size_t trackIndex = 0U; trackIndex < kNativeTrackCount; ++trackIndex) {
        assert(core.recordTrack(trackIndex, error));
        const auto allocationsBefore = trackedAllocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), frames) == 0);
        trackAllocations = false;
        assert(trackedAllocations == allocationsBefore);
        assert(core.stopTrack(trackIndex, error));
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    }
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeLoopTransportQueueCallbackAndEngineStatus() {
    constexpr unsigned int frames = 64U;
    constexpr std::size_t selectedTrack = 2U;
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);

    std::vector<float> loop(4U * frames);
    for (std::size_t frame = 0U; frame < loop.size(); ++frame) {
        loop[frame] = static_cast<float>(frame) / static_cast<float>(loop.size());
    }
    std::array<float, frames * 2U> output{};
    NativeAudioCoreTestAccess::recordLoop(core, selectedTrack, loop, frames, output.data());
    assert(core.getStatus().nativeTrackLoopTransportStatus[selectedTrack] == LoopTransportStatus::Disabled);

    LoopTransportConfig config;
    config.mode = LoopTransportMode::BeatShift;
    config.beatOffsetBeats = 0.25f;
    config.bpm = 120.0f;
    config.crossfadeMs = 1.0f;
    std::string error;
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    assert(core.setNativeLoopTransport(selectedTrack, config, error));
    assert(error.empty());
    // A running engine applies the bounded command only at the callback seam.
    assert(core.getStatus().nativeTrackLoopTransportStatus[selectedTrack] == LoopTransportStatus::Disabled);
    const auto allocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationsBefore);
    assert(core.getStatus().nativeTrackLoopTransportStatus[selectedTrack] == LoopTransportStatus::WaitingForPlayback);

    assert(core.playTrack(selectedTrack, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    assert(core.getStatus().nativeTrackLoopTransportStatus[selectedTrack] == LoopTransportStatus::Active);
    assert(std::fabs(output[0]) < 1.0e-6f);
    bool transportedSignal = false;
    for (std::size_t sample = 0U; sample < output.size(); ++sample) {
        transportedSignal = transportedSignal || output[sample] > 0.01f;
    }
    assert(transportedSignal);

    config.mode = LoopTransportMode::Off;
    assert(core.setNativeLoopTransport(selectedTrack, config, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    assert(core.getStatus().nativeTrackLoopTransportStatus[selectedTrack] == LoopTransportStatus::Disabled);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

// Exercise the real Native callback entry point at the requested 64 frames.
// RtAudio device creation is stubbed; no claim about physical driver timing.
void testNativePerTrackCatalogControlsAndIndependentOutput() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    constexpr unsigned int frames = 64U;
    std::array<float, frames * 2U> output{};
    std::string error;
    const std::vector<float> first(2048U, 0.1f);
    const std::vector<float> second(2048U, 0.2f);
    NativeAudioCoreTestAccess::recordLoop(core, 0U, first, frames, output.data());
    NativeAudioCoreTestAccess::recordLoop(core, 1U, second, frames, output.data());
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {{"position", -100.0f}}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {{"position", 100.0f}}, false, error, NativeCatalogFxPath::Track, 2U));
    auto state = core.getStatus();
    assert(state.nativePerTrackCatalogAvailable);
    assert(state.nativeCatalogSlotEffectIds[0].empty());
    assert(state.nativePerTrackCatalogSlots[0][0].prepared);
    assert(state.nativePerTrackCatalogSlots[0][0].appliedRevision == state.nativePerTrackCatalogSlots[0][0].requestedRevision);
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {}, false, error, NativeCatalogFxPath::Track, 6U));
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {}, false, error, NativeCatalogFxPath::Input, 1U));
    assert(!core.setNativeCatalogSlot(static_cast<NativeEffectSlot>(4U), "manual_pan", {}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "missing_processor", {}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(error.find("Unknown or unimplemented Native catalog FX ID") != std::string::npos);
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {{"position", std::numeric_limits<float>::quiet_NaN()}}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {{"unknown", 0.0f}}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::B, "freeze", {{"mode", 1.0f}}, false, error, NativeCatalogFxPath::Track, 1U));
    for (const auto* transportId : {"beat_shift", "vinyl_flick"}) {
        assert(!core.setNativeCatalogSlot(NativeEffectSlot::D, transportId, {}, false, error, NativeCatalogFxPath::Track, 1U));
        assert(error.find("BEAT SHIFT/VINYL FLICK") != std::string::npos);
        assert(error.find("experimental pre-insert loop-transport route") != std::string::npos);
    }
    assert(core.getStatus().nativePerTrackCatalogSlots[0][0].effectId == "manual_pan");
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 0U);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 1U);
    const auto render = [&] {
        const auto before = trackedAllocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
        trackAllocations = false;
        assert(trackedAllocations == before);
    };
    for (unsigned int block = 0U; block < 20U; ++block) render();
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        assert(std::fabs(output[frame * 2U] - 0.1f) < 1.0e-6f);
        assert(std::fabs(output[frame * 2U + 1U] - 0.2f) < 1.0e-6f);
    }
    const auto secondRevision = core.getStatus().nativePerTrackCatalogSlots[1][0].requestedRevision;
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {{"position", 100.0f}}, false, error, NativeCatalogFxPath::Track, 1U));
    state = core.getStatus();
    assert(state.nativePerTrackCatalogSlots[0][0].requestedRevision > state.nativePerTrackCatalogSlots[0][0].appliedRevision);
    assert(state.nativePerTrackCatalogSlots[1][0].requestedRevision == secondRevision);
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "dist", {}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "", {}, false, error, NativeCatalogFxPath::Track, 1U));
    for (unsigned int block = 0U; block < 20U; ++block) render();
    assert(std::fabs(output[0]) < 1.0e-6f && std::fabs(output[1] - 0.3f) < 1.0e-6f);
    state = core.getStatus();
    assert(state.nativePerTrackCatalogSlots[0][0].requestedRevision == state.nativePerTrackCatalogSlots[0][0].appliedRevision);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {}, true, error, NativeCatalogFxPath::Track, 1U));
    assert(!core.getStatus().nativePerTrackCatalogSlots[0][0].appliedBypassed);
    for (unsigned int block = 0U; block < 20U; ++block) render();
    state = core.getStatus();
    assert(state.nativePerTrackCatalogSlots[0][0].appliedBypassed);
    assert(std::fabs(output[0] - 0.1f) < 1.0e-6f && std::fabs(output[1] - 0.3f) < 1.0e-6f);
    assert(!state.nativePerTrackCatalogSlots[1][0].appliedBypassed);
    // Queue admission is all-or-nothing; a rejected update cannot mutate the
    // accepted revision or bypass state, and drains allocate nothing.
    for (unsigned int command = 0U; command < 63U; ++command) {
        assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {}, true, error, NativeCatalogFxPath::Track, 1U));
    }
    const auto fullRevision = core.getStatus().nativePerTrackCatalogSlots[0][0].requestedRevision;
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(error.find("queue is full") != std::string::npos);
    assert(core.getStatus().nativePerTrackCatalogSlots[0][0].requestedRevision == fullRevision);
    render();
    state = core.getStatus();
    assert(state.nativePerTrackCatalogSlots[0][0].appliedRevision == fullRevision);
    assert(state.nativeCatalogControlFaultCount == 0U);
    assert(!state.nativePerTrackCatalogSlots[0][0].processingFaulted);
    // Unexpected DSP-owner control failures cannot masquerade as an applied
    // configuration or silently bypass: fault status and the missed ACK persist.
    NativeAudioCoreTestAccess::injectRejectedPerTrackControl(core);
    render();
    state = core.getStatus();
    assert(state.nativeCatalogControlFaultCount == 1U);
    assert(state.nativePerTrackCatalogSlots[0][0].controlFaulted);
    assert(state.nativePerTrackCatalogSlots[0][0].appliedRevision < state.nativePerTrackCatalogSlots[0][0].requestedRevision);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "manual_pan", {}, false, error, NativeCatalogFxPath::Track, 1U));
    render();
    assert(!core.getStatus().nativePerTrackCatalogSlots[0][0].controlFaulted);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "", {}, false, error, NativeCatalogFxPath::Track, 1U));
    assert(core.getStatus().nativePerTrackCatalogSlots[0][0].effectId.empty());
}

void testEveryAdvertisedPerTrackCatalogTypeThroughNativeCoreAt64Frames() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    constexpr unsigned int frames = 64U;
    std::array<float, frames * 2U> output{};
    std::string error;
    const std::array<NativeEffectSlot, NativeEffectBank::kSlotCount> slots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};
    std::size_t catalogCount = 0U;
    const auto* catalog = nativeEffectCatalog(catalogCount);
    assert(catalog != nullptr);
    std::size_t advertisedCount = 0U;

    for (std::size_t effectIndex = 0U; effectIndex < catalogCount; ++effectIndex) {
        const auto& descriptor = catalog[effectIndex];
        if (!nativeEffectSupportsPerTrackInsert(descriptor.id)) continue;
        ++advertisedCount;

        for (std::size_t slotIndex = 0U; slotIndex < slots.size(); ++slotIndex) {
            const auto slot = slots[slotIndex];
            assert(core.setNativeCatalogSlot(slot, std::string(descriptor.id), {}, false, error,
                NativeCatalogFxPath::Track, 1U));
            auto status = core.getStatus();
            assert(status.nativePerTrackCatalogAvailable);
            auto slotStatus = status.nativePerTrackCatalogSlots[0][slotIndex];
            assert(slotStatus.effectId == descriptor.id);
            assert(slotStatus.prepared);
            assert(slotStatus.requestedRevision == slotStatus.appliedRevision);
            assert(!slotStatus.processingFaulted && !slotStatus.controlFaulted);

            assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
            for (const float sample : output) assert(std::isfinite(sample));
            status = core.getStatus();
            slotStatus = status.nativePerTrackCatalogSlots[0][slotIndex];
            assert(slotStatus.effectId == descriptor.id && slotStatus.prepared);
            assert(slotStatus.requestedRevision == slotStatus.appliedRevision);
            assert(!slotStatus.processingFaulted && !slotStatus.controlFaulted);
        }
    }
    assert(advertisedCount == 51U);
}

void testNativePerTrackFxLeavesRecordOverdubAndMonitoringCanonical() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    constexpr unsigned int frames = 64U;
    std::array<float, frames> input{};
    input.fill(0.1f);
    std::array<float, frames * 2U> output{}, snapshot{};
    std::string error;
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "dist", {{"drive_db", 36.0f}}, false, error,
        NativeCatalogFxPath::Track, 1U));
    NativeAudioCoreTestAccess::command(core, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Record, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), frames) == 0);
    // Recording/monitoring is dry even with the selected playback insert.
    for (const auto sample : output) assert(std::fabs(sample - 0.1f) < 1.0e-6f);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::StopRecordOrPlayback, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    std::size_t copied = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, snapshot.data(), frames, copied) && copied == frames);
    for (const auto sample : snapshot) assert(std::fabs(sample - 0.1f) < 1.0e-6f);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 0U);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::ToggleOverdub, 0U);
    const auto before = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), frames) == 0);
    trackAllocations = false;
    assert(trackedAllocations == before);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::StopRecordOrPlayback, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, snapshot.data(), frames, copied));
    for (const auto sample : snapshot) assert(std::fabs(sample - 0.2f) < 1.0e-6f);
    // Once the stored loop is empty and the nonlinear tail settles, live
    // monitoring still goes around the insert chain.
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Clear, 0U);
    NativeAudioCoreTestAccess::command(core, CommandType::SetMonitoring, true);
    for (unsigned int block = 0U; block < 128U; ++block) assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), frames) == 0);
    for (const auto sample : output) assert(std::fabs(sample - 0.1f) < 1.0e-6f);
}

void testNativePerTrackUnpreparedProcessorPublishesFault() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::injectUnpreparedPerTrackProcessor(core);
    std::array<float, 128U> output{};
    const auto before = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == before);
    const auto slot = core.getStatus().nativePerTrackCatalogSlots[0U][0U];
    assert(!slot.prepared && slot.processingFaulted);
}

void testNativeTwentySlotChainsMatchIndependentOrderedReferencesAt64Frames() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    constexpr unsigned int frames = 64U;
    constexpr unsigned int loopFrames = 2048U;
    std::array<float, frames * 2U> output{};
    std::array<std::vector<float>, kNativeTrackCount> loops{};
    std::array<NativeEffectBank, kNativeTrackCount> reference{};
    NativeEffectBank sharedReference;
    assert(sharedReference.prepare(48000U));
    std::string error;
    // Record canonical dry PCM first; every reference starts from silence just
    // as the real per-track banks do before the first Play command.
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        loops[track] = makeCallbackTestTone(180.0f + static_cast<float>(track) * 110.0f, loopFrames, 0.035f);
        NativeAudioCoreTestAccess::recordLoop(core, track, loops[track], frames, output.data());
    }
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        assert(reference[track].prepare(48000U));
        const std::array<std::string, 4U> ids{{"dist", "filter.lpf", "fractional_delay", "manual_pan"}};
        const std::array<std::map<std::string, float>, 4U> parameters{{
            {{"drive_db", 12.0f}, {"mix_percent", 20.0f}},
            {{"cutoff_hz", 900.0f}, {"resonance_percent", 15.0f}},
            {{"delay_ms", 10.0f + static_cast<float>(track)}, {"feedback", 0.2f}, {"wet_mix", 0.4f}},
            {{"position", -70.0f + 35.0f * static_cast<float>(track)}}
        }};
        for (std::size_t slot = 0U; slot < 4U; ++slot) {
            const auto selected = static_cast<NativeEffectSlot>(slot);
            assert(core.setNativeCatalogSlot(selected, ids[slot], parameters[slot], false, error,
                NativeCatalogFxPath::Track, static_cast<std::uint8_t>(track + 1U)));
            assert(reference[track].setEffect(selected, ids[slot]));
            for (const auto& [key, value] : parameters[slot]) assert(reference[track].setParameter(selected, key, value));
        }
    }
    assert(core.setNativeCatalogSlot(NativeEffectSlot::B, "manual_pan", {{"position", 30.0f}}, false, error));
    assert(sharedReference.setEffect(NativeEffectSlot::B, "manual_pan"));
    assert(sharedReference.setParameter(NativeEffectSlot::B, "position", 30.0f));
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, track);
    const auto ticksBefore = core.getStatus().callbackTicks;
    for (unsigned int block = 0U; block < 96U; ++block) {
        std::array<float, frames * 2U> expected{};
        for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
            std::array<float, frames * 2U> scratch{};
            for (unsigned int frame = 0U; frame < frames; ++frame) {
                scratch[frame * 2U] = scratch[frame * 2U + 1U] = loops[track][(block * frames + frame) % loopFrames];
            }
            (void)reference[track].processInPlace(scratch.data(), frames, 2U);
            for (std::size_t sample = 0U; sample < expected.size(); ++sample) expected[sample] += scratch[sample];
        }
        (void)sharedReference.processInPlace(expected.data(), frames, 2U);
        const auto allocationsBefore = trackedAllocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
        trackAllocations = false;
        assert(trackedAllocations == allocationsBefore);
        for (std::size_t sample = 0U; sample < expected.size(); ++sample) assert(std::fabs(output[sample] - expected[sample]) < 1.0e-6f);
    }
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    for (std::uint8_t trackId = 1U; trackId <= kNativeTrackCount; ++trackId) {
        assert(core.setNativeCatalogSlot(NativeEffectSlot::C, "fractional_delay",
            {{"delay_ms", 18.0f}, {"feedback", 0.35f}, {"wet_mix", 0.7f}}, false, error, NativeCatalogFxPath::Track, trackId));
    }
    const auto beforeLiveDelayEdits = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    trackAllocations = false;
    assert(trackedAllocations == beforeLiveDelayEdits);
    const auto state = core.getStatus();
    assert(state.callbackTicks == ticksBefore + 97U);
    for (const auto& track : state.nativePerTrackCatalogSlots) for (const auto& slot : track) {
        assert(!slot.effectId.empty() && slot.prepared && !slot.processingFaulted && !slot.controlFaulted);
    }
    // Demonstrate that the reference order assertion is meaningful: nonlinear
    // DIST and LPF do not commute, so a reversed implementation would fail.
    NativeEffectBank forward, reversed;
    assert(forward.prepare(48000U) && reversed.prepare(48000U));
    assert(forward.setEffect(NativeEffectSlot::A, "dist") && forward.setEffect(NativeEffectSlot::B, "filter.lpf"));
    assert(reversed.setEffect(NativeEffectSlot::A, "filter.lpf") && reversed.setEffect(NativeEffectSlot::B, "dist"));
    std::array<float, 2048U> a{}, b{};
    assert(forward.setParameter(NativeEffectSlot::A, "drive_db", 36.0f));
    assert(reversed.setParameter(NativeEffectSlot::B, "drive_db", 36.0f));
    for (unsigned int sample = 0U; sample < a.size(); ++sample) {
        a[sample] = b[sample] = 0.8f * std::sin(static_cast<float>(sample / 2U) * 0.3f);
    }
    (void)forward.processInPlace(a.data(), 1024U, 2U);
    (void)reversed.processInPlace(b.data(), 1024U, 2U);
    float difference = 0.0f;
    for (std::size_t sample = 0U; sample < a.size(); ++sample) difference += std::fabs(a[sample] - b[sample]);
    assert(difference > 0.1f);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

class CallbackPump {
public:
    explicit CallbackPump(NativeAudioCore& core, const float* input = nullptr) : core_(core), input_(input), worker_([this] {
        std::array<float, 128U> output{};
        while (running_.load(std::memory_order_acquire)) {
            (void)NativeAudioCoreTestAccess::callback(core_, input_, output.data(), 64U);
            std::this_thread::yield();
        }
    }) {}
    ~CallbackPump() {
        running_.store(false, std::memory_order_release);
        if (worker_.joinable()) worker_.join();
    }
    CallbackPump(const CallbackPump&) = delete;
    CallbackPump& operator=(const CallbackPump&) = delete;
private:
    NativeAudioCore& core_;
    const float* input_ = nullptr;
    std::atomic<bool> running_{true};
    std::thread worker_;
};

void prepareNativeMarkEligibleTrack(NativeAudioCore& core, const std::array<float, 8U>& base,
                                   const std::array<float, 8U>& overdub, std::array<float, 128U>& output) {
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::string error;
    assert(core.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, base.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    assert(core.playTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    {
        CallbackPump pump(core);
        assert(core.toggleTrackOverdub(0U, error));
        bool enteredOverdub = false;
        for (unsigned int wait = 0U; wait < 1000U; ++wait) {
            if (core.getStatus().nativeTrackStates[0U] == LooperState::Overdubbing) {
                enteredOverdub = true;
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        assert(enteredOverdub);
    }
    assert(NativeAudioCoreTestAccess::callback(core, overdub.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
}

void testNativeIndependentMarkRequiresCallbackReleaseAckAndClearKeepsHistory() {
    NativeAudioCore core;
    std::array<float, 128U> output{};
    const std::array<float, 8U> base{{0.1f, -0.1f, 0.2f, -0.2f, 0.3f, -0.3f, 0.4f, -0.4f}};
    const std::array<float, 8U> firstOverdub{{0.02f, 0.03f, 0.04f, 0.05f, 0.06f, 0.07f, 0.08f, 0.09f}};
    const std::array<float, 8U> secondOverdub{{-0.03f, -0.02f, -0.01f, 0.01f, 0.02f, 0.03f, 0.04f, 0.05f}};
    prepareNativeMarkEligibleTrack(core, base, firstOverdub, output);

    auto status = core.getStatus();
    assert(status.nativeMarkVersion == 1U);
    assert(status.nativeMarkBudgetBytes == kNativeHistoryBudgetBytes);
    assert(status.nativeMarkRetainedBytes == 0U);
    assert(!status.nativeTrackMarks[0U].exists && status.nativeTrackMarks[0U].canSet);
    assert(status.nativeTrackMarks[0U].requestedGeneration == 0U && status.nativeTrackMarks[0U].appliedGeneration == 0U);

    std::array<float, 8U> expectedMark{};
    std::size_t frames = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, expectedMark.data(), 4U, frames));
    assert(frames == 4U);

    std::atomic<bool> setSucceeded{false};
    std::string setError;
    std::thread setter([&] { setSucceeded.store(core.setTrackMark(0U, 1U, setError), std::memory_order_release); });
    const auto pinDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    std::uint64_t pinGeneration = 0U;
    while ((pinGeneration = NativeAudioCoreTestAccess::historyPinRequest(core)) == 0U &&
           std::chrono::steady_clock::now() < pinDeadline) std::this_thread::yield();
    assert(pinGeneration != 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    assert(NativeAudioCoreTestAccess::historyPinAcknowledged(core) == pinGeneration);

    const auto releaseDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while ((NativeAudioCoreTestAccess::historyPinRequest(core) != 0U ||
            NativeAudioCoreTestAccess::historyPinReleaseRequest(core) != pinGeneration) &&
           std::chrono::steady_clock::now() < releaseDeadline) std::this_thread::yield();
    assert(NativeAudioCoreTestAccess::historyPinRequest(core) == 0U);
    assert(NativeAudioCoreTestAccess::historyPinReleaseRequest(core) == pinGeneration);
    // Copy completion and request acceptance do not commit a MARK. The core
    // waits for this second callback to acknowledge releasing the source pin.
    assert(NativeAudioCoreTestAccess::markBusy(core, 0U));
    assert(NativeAudioCoreTestAccess::markBytes(core, 0U) == 0U);
    assert(NativeAudioCoreTestAccess::markAppliedGeneration(core, 0U) == 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    setter.join();
    assert(setSucceeded.load(std::memory_order_acquire));
    status = core.getStatus();
    assert(status.nativeTrackMarks[0U].exists && status.nativeTrackMarks[0U].canClear);
    assert(status.nativeTrackMarks[0U].requestedGeneration == 1U && status.nativeTrackMarks[0U].appliedGeneration == 1U);
    assert(status.nativeTrackMarks[0U].retainedPcmBytes == sizeof(expectedMark));
    assert(status.nativeHistoryRetainedBytes == sizeof(expectedMark) + status.nativeTrackHistory[0U].retainedPcmBytes);
    assert(NativeAudioCoreTestAccess::copyMarkPcm(core, 0U) == std::vector<float>(expectedMark.begin(), expectedMark.end()));

    // A later overdub changes the live loop but leaves the independent MARK
    // stereo snapshot byte-for-byte intact.
    std::string error;
    assert(core.playTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    {
        CallbackPump pump(core);
        assert(core.toggleTrackOverdub(0U, error));
        bool enteredOverdub = false;
        for (unsigned int wait = 0U; wait < 1000U; ++wait) {
            if (core.getStatus().nativeTrackStates[0U] == LooperState::Overdubbing) {
                enteredOverdub = true;
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        assert(enteredOverdub);
    }
    assert(NativeAudioCoreTestAccess::callback(core, secondOverdub.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    std::array<float, 8U> liveAfterSecondOverdub{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, liveAfterSecondOverdub.data(), 4U, frames));
    assert(liveAfterSecondOverdub != expectedMark);
    assert(NativeAudioCoreTestAccess::copyMarkPcm(core, 0U) == std::vector<float>(expectedMark.begin(), expectedMark.end()));

    const auto historyBeforeClear = core.getStatus().nativeTrackHistory[0U];
    assert(core.clearTrackMark(0U, 2U, error));
    status = core.getStatus();
    assert(!status.nativeTrackMarks[0U].exists && status.nativeTrackMarks[0U].appliedGeneration == 2U);
    assert(status.nativeHistoryRetainedBytes == historyBeforeClear.retainedPcmBytes);
    assert(status.nativeTrackHistory[0U].canUndo == historyBeforeClear.canUndo);
    assert(status.nativeTrackHistory[0U].retainedPcmBytes == historyBeforeClear.retainedPcmBytes);
    std::array<float, 8U> liveAfterMarkClear{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, liveAfterMarkClear.data(), 4U, frames));
    assert(liveAfterMarkClear == liveAfterSecondOverdub);
    assert(status.nativeTrackMarks[0U].canSet);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeMarkStatusReportsBudgetFailureWithoutApplyingSnapshot() {
    NativeAudioCore core;
    std::array<float, 128U> output{};
    const std::array<float, 8U> base{{0.1f, -0.1f, 0.2f, -0.2f, 0.3f, -0.3f, 0.4f, -0.4f}};
    const std::array<float, 8U> overdub{{0.01f, 0.02f, 0.03f, 0.04f, 0.05f, 0.06f, 0.07f, 0.08f}};
    prepareNativeMarkEligibleTrack(core, base, overdub, output);
    NativeAudioCoreTestAccess::setHistoryRetainedBytesForBudgetTest(core, kNativeHistoryBudgetBytes);
    std::string error;
    {
        CallbackPump pump(core);
        assert(!core.setTrackMark(0U, 1U, error));
    }
    assert(error.find("512 MiB") != std::string::npos);
    const auto status = core.getStatus();
    assert(status.nativeTrackMarks[0U].requestedGeneration == 1U);
    assert(status.nativeTrackMarks[0U].appliedGeneration == 0U);
    assert(!status.nativeTrackMarks[0U].exists && !status.nativeTrackMarks[0U].canSet);
    assert(status.nativeTrackMarks[0U].unavailableReason == "budgetExceeded");
    assert(NativeAudioCoreTestAccess::markBytes(core, 0U) == 0U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativePerTrackPcmHistoryAndPinnedRestore() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::array<float, 8U> input{{0.1f, -0.1f, 0.2f, -0.2f, 0.3f, -0.3f, 0.4f, -0.4f}};
    std::array<float, 128U> output{};
    std::string error;

    assert(core.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    auto status = core.getStatus();
    assert(status.nativeTrackHistory[0U].canUndo && !status.nativeTrackHistory[0U].canRedo);
    assert(status.nativeTrackHistory[1U].canUndo == false);

    {
        CallbackPump pump(core);
        assert(core.undoTrack(0U, error));
        status = core.getStatus();
        assert(status.nativeTrackStates[0U] == LooperState::Empty);
        assert(!status.nativeTrackHistory[0U].canUndo && status.nativeTrackHistory[0U].canRedo);
        assert(core.redoTrack(0U, error));
    }
    std::array<float, 8U> exact{};
    std::size_t frames = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, exact.data(), 4U, frames));
    assert(frames == 4U && exact == input);

    // Clear uses metadata-only history; its bytes stay untouched for undo.
    assert(core.clearTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    assert(core.getStatus().nativeTrackHistory[0U].canUndo);
    {
        CallbackPump pump(core);
        assert(core.undoTrack(0U, error));
        assert(core.getStatus().nativeTrackStates[0U] == LooperState::Stopped);
        assert(core.redoTrack(0U, error));
    }
    assert(core.getStatus().nativeTrackStates[0U] == LooperState::Empty);

    for (std::size_t trackIndex = 2U; trackIndex < kNativeTrackCount; ++trackIndex) {
        assert(core.recordTrack(trackIndex, error));
        assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 4U) == 0);
        assert(core.stopTrack(trackIndex, error));
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    }

    // One track's restore never changes another track's history or PCM.
    assert(core.recordTrack(1U, error));
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(1U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    {
        CallbackPump pump(core);
        assert(core.undoTrack(1U, error));
        assert(core.getStatus().nativeTrackStates[1U] == LooperState::Empty);
        assert(core.redoTrack(1U, error));
    }
    status = core.getStatus();
    assert(status.nativeTrackStates[1U] == LooperState::Stopped);
    assert(status.nativeTrackStates[0U] == LooperState::Empty);
    for (std::size_t trackIndex = 2U; trackIndex < kNativeTrackCount; ++trackIndex) {
        assert(status.nativeTrackHistory[trackIndex].canUndo);
        assert(status.nativeTrackStates[trackIndex] == LooperState::Stopped);
    }

    // A fresh record after undo replaces (and invalidates) redo history.
    {
        CallbackPump pump(core);
        assert(core.undoTrack(1U, error));
    }
    assert(core.recordTrack(1U, error));
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(1U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    status = core.getStatus();
    assert(status.nativeTrackHistory[1U].canUndo && !status.nativeTrackHistory[1U].canRedo);
    std::array<float, 8U> originalOverdub{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 1U, originalOverdub.data(), 4U, frames));

    // Overdub must snapshot before entering destructive write mode, and undo
    // and redo exchange exact interleaved PCM while the callback is pinned.
    assert(core.playTrack(1U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    {
        CallbackPump pump(core);
        assert(core.toggleTrackOverdub(1U, error));
        bool enteredOverdub = false;
        for (unsigned int wait = 0U; wait < 200U; ++wait) {
            if (core.getStatus().nativeTrackStates[1U] == LooperState::Overdubbing) { enteredOverdub = true; break; }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        assert(enteredOverdub);
    }
    assert(core.getStatus().nativeTrackStates[1U] == LooperState::Overdubbing);
    std::array<float, 8U> overdubInput{{0.05f, 0.02f, 0.05f, 0.02f, 0.05f, 0.02f, 0.05f, 0.02f}};
    assert(NativeAudioCoreTestAccess::callback(core, overdubInput.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(1U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    std::array<float, 8U> afterOverdub{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 1U, afterOverdub.data(), 4U, frames));
    assert(afterOverdub != input);
    assert(core.getStatus().nativeTrackHistory[1U].canUndo);
    {
        CallbackPump pump(core);
        assert(core.undoTrack(1U, error));
        std::array<float, 8U> undoneOverdub{};
        assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 1U, undoneOverdub.data(), 4U, frames));
        assert(undoneOverdub == originalOverdub);
        assert(core.redoTrack(1U, error));
    }
    std::array<float, 8U> redoneOverdub{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 1U, redoneOverdub.data(), 4U, frames));
    assert(redoneOverdub == afterOverdub);
    assert(core.getStatus().nativeHistoryRetainedBytes == 4U * 2U * sizeof(float));
    assert(core.clearTrack(1U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    auto clearedStatus = core.getStatus();
    assert(clearedStatus.nativeTrackHistory[1U].canUndo);
    assert(clearedStatus.nativeHistoryRetainedBytes == 0U);
    {
        CallbackPump pump(core);
        assert(core.undoTrack(1U, error));
        std::array<float, 8U> restoredAfterClear{};
        assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 1U, restoredAfterClear.data(), 4U, frames));
        assert(restoredAfterClear == afterOverdub);
        assert(core.redoTrack(1U, error));
    }
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeHistoryBudgetRefusalAndGenerationAck() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::array<float, 64U> output{};
    std::array<float, 8U> input{{0.1f, -0.1f, 0.2f, -0.2f, 0.3f, -0.3f, 0.4f, -0.4f}};
    std::string error;
    assert(core.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    assert(core.playTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    NativeAudioCoreTestAccess::setHistoryRetainedBytesForBudgetTest(core, kNativeHistoryBudgetBytes);
    {
        CallbackPump pump(core);
        assert(!core.toggleTrackOverdub(0U, error));
    }
    assert(error.find("512 MiB") != std::string::npos);
    assert(core.getStatus().nativeTrackStates[0U] == LooperState::Playing);
    assert(core.getStatus().nativeTrackHistory[0U].unavailableReason == NativeHistoryFailure::BudgetExceeded);
    NativeAudioCoreTestAccess::setHistoryRetainedBytesForBudgetTest(core, 0U);

    // A timed-out generation's late ACK must never satisfy a later pin.
    const auto stale = NativeAudioCoreTestAccess::requestHistoryPinForTest(core, 0U);
    NativeAudioCoreTestAccess::cancelPinAndInjectLateAckForTest(core, stale);
    const auto current = NativeAudioCoreTestAccess::requestHistoryPinForTest(core, 1U);
    const auto allocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationsBefore);
    assert(NativeAudioCoreTestAccess::historyPinAcknowledged(core) == current);
    assert(NativeAudioCoreTestAccess::historyPinAcknowledgedTrack(core) == 1U);
    NativeAudioCoreTestAccess::releaseHistoryPinForTest(core, current);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    assert(NativeAudioCoreTestAccess::historyPinReleased(core) == current);

    // Native transport commands share the pinned callback boundary. They must
    // remain queued while history restoration owns the target LooperCore.
    const auto transportPin = NativeAudioCoreTestAccess::requestHistoryPinForTest(core, 1U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    assert(NativeAudioCoreTestAccess::historyPinAcknowledged(core) == transportPin);
    LoopTransportConfig transport;
    transport.mode = LoopTransportMode::BeatShift;
    transport.beatOffsetBeats = 0.25f;
    transport.crossfadeMs = 1.0f;
    assert(core.setNativeLoopTransport(1U, transport, error));
    assert(NativeAudioCoreTestAccess::loopTransportQueueSize(core) == 1U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    assert(NativeAudioCoreTestAccess::loopTransportQueueSize(core) == 1U);
    NativeAudioCoreTestAccess::releaseHistoryPinForTest(core, transportPin);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);
    assert(NativeAudioCoreTestAccess::historyPinReleased(core) == transportPin);
    assert(NativeAudioCoreTestAccess::loopTransportQueueSize(core) == 0U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeHistoryRestoreSerializesRapidCommandProducer() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::array<float, 8U> input{{0.1f, -0.1f, 0.2f, -0.2f, 0.3f, -0.3f, 0.4f, -0.4f}};
    std::array<float, 128U> output{};
    std::string error;
    assert(core.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 4U) == 0);
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 4U) == 0);

    std::atomic<bool> attempted{false};
    std::atomic<bool> accepted{false};
    std::thread producer([&] {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (NativeAudioCoreTestAccess::historyPinNextGeneration(core) == 0U &&
               std::chrono::steady_clock::now() < deadline) std::this_thread::yield();
        attempted.store(true, std::memory_order_release);
        std::string producerError;
        accepted.store(core.recordTrack(0U, producerError), std::memory_order_release);
    });
    {
        CallbackPump pump(core);
        assert(core.undoTrack(0U, error));
        auto status = core.getStatus();
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        while (std::chrono::steady_clock::now() < deadline &&
               (!accepted.load(std::memory_order_acquire) || status.nativeTrackStates[0U] != LooperState::Recording)) {
            std::this_thread::yield();
            status = core.getStatus();
        }
        assert(attempted.load(std::memory_order_acquire));
        assert(accepted.load(std::memory_order_acquire));
        assert(status.nativeTrackStates[0U] == LooperState::Recording);
        assert(!status.nativeTrackHistory[0U].canRedo);
    }
    producer.join();
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeTrackCommandQueueSerializesConcurrentProducers() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    constexpr std::size_t kThreads = 6U;
    constexpr std::size_t kAttemptsPerThread = 40U;
    std::array<std::size_t, kThreads> accepted{};
    std::array<std::thread, kThreads> workers;
    for (std::size_t thread = 0U; thread < kThreads; ++thread) {
        workers[thread] = std::thread([&, thread] {
            std::string error;
            for (std::size_t attempt = 0U; attempt < kAttemptsPerThread; ++attempt) {
                if (core.recordTrack(thread % kNativeTrackCount, error)) ++accepted[thread];
            }
        });
    }
    for (auto& worker : workers) worker.join();
    std::size_t totalAccepted = 0U;
    for (const auto count : accepted) totalAccepted += count;
    assert(totalAccepted == NativeAudioCoreTestAccess::commandQueueSize(core));
    assert(totalAccepted <= 63U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeProjectArchiveImportIsAtomicAndReclaimsOnControlThread() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    std::string error;
    NativeReverbConfig reverb;
    reverb.enabled = true;
    reverb.wetMix = 0.27f;
    reverb.rt60Seconds = 1.8f;
    reverb.dampingCutoffHz = 6200.0f;
    assert(core.setNativeReverbConfig(reverb, error));

    constexpr unsigned int blockFrames = 64U;
    std::vector<float> output(512U * 2U, 0.0f);
    std::vector<float> oldTake(blockFrames * 2U);
    for (std::size_t frame = 0U; frame < blockFrames; ++frame) {
        oldTake[frame * 2U] = 0.2f;
        oldTake[(frame * 2U) + 1U] = -0.2f;
    }
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    const auto recordStereo = [&](std::size_t trackIndex, const std::vector<float>& samples, unsigned int frames) {
        NativeAudioCoreTestAccess::commandTrack(core, CommandType::Record, trackIndex);
        assert(NativeAudioCoreTestAccess::callback(core, samples.data(), output.data(), frames) == 0);
        NativeAudioCoreTestAccess::commandTrack(core, CommandType::StopRecordOrPlayback, trackIndex);
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
    };
    recordStereo(0U, oldTake, blockFrames);
    recordStereo(1U, oldTake, blockFrames);
    const auto before = core.getStatus();
    assert(before.nativeTrackHistory[0U].canUndo);
    assert(before.nativeTrackHistory[1U].canUndo);
    assert(before.nativeReverbEnabled);
    assert(std::fabs(before.nativeReverbWetMix - reverb.wetMix) < 1.0e-6f);

    const auto makeArchive = [] {
        DecodedProjectArchive archive;
        archive.version = 1U;
        archive.name = "Native import fixture";
        archive.bpm = 120.0;
        ProjectArchiveTrackData stereo;
        stereo.sampleRate = 48000U;
        stereo.frameCount = 4U;
        stereo.channels = 2U;
        stereo.pcm = {0.9f, -0.9f, 0.7f, -0.7f, 0.5f, -0.5f, 0.3f, -0.3f};
        archive.payloadByteLength += stereo.pcm.size() * sizeof(float);
        archive.tracks[0U] = std::move(stereo);
        ProjectArchiveTrackData mono;
        mono.sampleRate = 48000U;
        mono.frameCount = 2U;
        mono.channels = 1U;
        mono.pcm = {0.15f, -0.35f};
        archive.payloadByteLength += mono.pcm.size() * sizeof(float);
        archive.tracks[2U] = std::move(mono);
        return archive;
    };

    auto wrongRate = makeArchive();
    wrongRate.tracks[0U]->sampleRate = 44100U;
    std::uint64_t generation = 0U;
    assert(!core.beginProjectArchiveImport(std::move(wrongRate), 256U, before.projectContentRevision, generation, error));
    assert(generation == 0U && error.find("running sample rate") != std::string::npos);
    std::array<float, blockFrames * 2U> preserved{};
    std::size_t copiedFrames = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, preserved.data(), blockFrames, copiedFrames));
    assert(copiedFrames == blockFrames && std::equal(preserved.begin(), preserved.end(), oldTake.begin()));
    const auto afterRejected = core.getStatus();
    assert(afterRejected.nativeTrackHistory[0U].canUndo && afterRejected.nativeTrackHistory[1U].canUndo);
    assert(afterRejected.nativeReverbEnabled && afterRejected.nativeReverbWetMix == before.nativeReverbWetMix);

    // Reproduce a project load that began before a new recording. The host
    // project epoch must reject the stale archive before staging any candidate.
    const auto operationStartRevision = core.getStatus().projectContentRevision;
    recordStereo(2U, oldTake, blockFrames);
    const auto afterConcurrentRecording = core.getStatus();
    assert(afterConcurrentRecording.projectContentRevision > operationStartRevision);
    assert(afterConcurrentRecording.nativeTrackHistory[2U].canUndo);
    auto stale = makeArchive();
    assert(!core.beginProjectArchiveImport(std::move(stale), 256U, operationStartRevision, generation, error));
    assert(generation == 0U && error.find("changed while the archive was being read") != std::string::npos);
    std::array<float, blockFrames * 2U> concurrentTake{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 2U, concurrentTake.data(), blockFrames, copiedFrames));
    assert(copiedFrames == blockFrames && std::equal(concurrentTake.begin(), concurrentTake.end(), oldTake.begin()));
    const auto afterStaleImport = core.getStatus();
    assert(afterStaleImport.nativeTrackHistory[0U].canUndo && afterStaleImport.nativeTrackHistory[1U].canUndo &&
        afterStaleImport.nativeTrackHistory[2U].canUndo);

    // Playback state is also overwritten by archive commit. A user Play or
    // Stop accepted after load start must invalidate that stale operation,
    // while natural playhead movement itself does not change the project epoch.
    const auto beforeConcurrentPlayRevision = afterStaleImport.projectContentRevision;
    assert(core.playTrack(2U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    const auto afterConcurrentPlay = core.getStatus();
    assert(afterConcurrentPlay.nativeTrackStates[2U] == LooperState::Playing);
    assert(afterConcurrentPlay.projectContentRevision > beforeConcurrentPlayRevision);
    const auto afterNaturalPlaybackRevision = core.getStatus().projectContentRevision;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    assert(core.getStatus().projectContentRevision == afterNaturalPlaybackRevision);
    auto stalePlayback = makeArchive();
    assert(!core.beginProjectArchiveImport(std::move(stalePlayback), 256U,
        beforeConcurrentPlayRevision, generation, error));
    assert(generation == 0U && error.find("changed while the archive was being read") != std::string::npos);
    assert(core.stopTrack(2U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    const auto afterConcurrentStop = core.getStatus();
    assert(afterConcurrentStop.nativeTrackStates[2U] == LooperState::Stopped);
    assert(afterConcurrentStop.projectContentRevision > afterNaturalPlaybackRevision);

    auto valid = makeArchive();
    assert(core.beginProjectArchiveImport(std::move(valid), 256U, afterConcurrentStop.projectContentRevision, generation, error));
    assert(generation != 0U && core.getProjectArchiveImportStatus(generation).state == NativeProjectImportState::Pending);
    assert(!core.recordTrack(4U, error));
    assert(error.find("project import is pending") != std::string::npos);
    const auto allocationsBeforeImportCallback = trackedAllocations;
    const auto deallocationsBeforeImportCallback = trackedDeallocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationsBeforeImportCallback);
    assert(trackedDeallocations == deallocationsBeforeImportCallback);

    NativeProjectImportStatus status = core.getProjectArchiveImportStatus(generation);
    assert(status.found && status.state == NativeProjectImportState::Committed && status.error.empty());
    std::array<float, 8U> imported{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, imported.data(), 4U, copiedFrames));
    assert(copiedFrames == 4U);
    assert((imported == std::array<float, 8U>{{0.9f, -0.9f, 0.7f, -0.7f, 0.5f, -0.5f, 0.3f, -0.3f}}));
    assert(!NativeAudioCoreTestAccess::copyStereoTrack(core, 1U, preserved.data(), blockFrames, copiedFrames));
    std::array<float, 4U> duplicatedMono{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 2U, duplicatedMono.data(), 2U, copiedFrames));
    assert(copiedFrames == 2U && (duplicatedMono == std::array<float, 4U>{{0.15f, 0.15f, -0.35f, -0.35f}}));
    const auto afterImport = core.getStatus();
    assert(!afterImport.nativeTrackHistory[0U].canUndo && !afterImport.nativeTrackHistory[1U].canUndo);
    assert(afterImport.nativeReverbEnabled && afterImport.nativeReverbWetMix == before.nativeReverbWetMix);

    // The callback repeats the expected-epoch comparison as a final guard
    // against an edit that races after the control-thread candidate stage.
    auto callbackStale = makeArchive();
    std::uint64_t callbackStaleGeneration = 0U;
    assert(core.beginProjectArchiveImport(std::move(callbackStale), 256U,
        afterImport.projectContentRevision, callbackStaleGeneration, error));
    NativeAudioCoreTestAccess::changeProjectRevisionForTest(core, 0U);
    const auto deallocationsBeforeStaleCallback = trackedDeallocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    trackAllocations = false;
    assert(trackedDeallocations == deallocationsBeforeStaleCallback);
    const auto callbackStaleStatus = core.getProjectArchiveImportStatus(callbackStaleGeneration);
    assert(callbackStaleStatus.state == NativeProjectImportState::Cancelled);
    assert(callbackStaleStatus.error.find("callback boundary") != std::string::npos);
    std::array<float, 8U> afterCallbackStale{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, afterCallbackStale.data(), 4U, copiedFrames));
    assert(afterCallbackStale == imported);

    // A second import cancelled before callback claim must preserve the
    // successfully imported PCM and must never be freed by the audio thread.
    auto cancelled = makeArchive();
    cancelled.tracks[0U]->pcm[0U] = -0.88f;
    std::uint64_t cancelledGeneration = 0U;
    const auto afterCallbackStaleRevision = core.getStatus().projectContentRevision;
    assert(core.beginProjectArchiveImport(std::move(cancelled), 256U, afterCallbackStaleRevision, cancelledGeneration, error));
    NativeProjectImportStatus cancelStatus;
    assert(core.cancelProjectArchiveImport(cancelledGeneration, cancelStatus, error));
    assert(cancelStatus.state == NativeProjectImportState::Cancelled);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    std::array<float, 8U> afterCancel{};
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, afterCancel.data(), 4U, copiedFrames));
    assert(afterCancel == imported);

    // Imported short loops retain the full prepared primary capacity.
    std::vector<float> longTake(512U * 2U);
    for (std::size_t sample = 0U; sample < longTake.size(); ++sample) longTake[sample] = 0.01f * static_cast<float>(sample);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Clear, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    recordStereo(0U, longTake, 512U);
    std::vector<float> longSnapshot(longTake.size());
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, longSnapshot.data(), 512U, copiedFrames));
    assert(copiedFrames == 512U && longSnapshot == longTake);

    // JSON transports numbers exactly only through Number.MAX_SAFE_INTEGER.
    // Saturate rather than wrap: no subsequent project import may reuse a
    // revision and accidentally accept a stale baseline.
    NativeAudioCoreTestAccess::setProjectRevisionForTest(
        core, NativeAudioCore::kMaximumSafeProjectContentRevision - 1U);
    assert(core.playTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    assert(core.getStatus().projectContentRevision == NativeAudioCore::kMaximumSafeProjectContentRevision);
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), blockFrames) == 0);
    assert(core.getStatus().projectContentRevision == NativeAudioCore::kMaximumSafeProjectContentRevision);
    auto exhaustedRevision = makeArchive();
    assert(!core.beginProjectArchiveImport(std::move(exhaustedRevision), 256U,
        NativeAudioCore::kMaximumSafeProjectContentRevision, generation, error));
    assert(generation == 0U && error.find("safe JSON integer limit") != std::string::npos);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testMixerIndependentPcmGains() {
    webrc::native::NativeAudioCore core;
    webrc::native::NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    std::vector<float> output(256U * 2U);
    webrc::native::NativeAudioCoreTestAccess::recordLoop(core, 0U, std::vector<float>(2048U, 0.2f), 256U, output.data());
    webrc::native::NativeAudioCoreTestAccess::commandTrack(core, webrc::native::CommandType::Play, 0U);
    std::string error;
    const auto peak = [&]() {
        webrc::native::NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 256U);
        float result = 0.0f;
        for (float sample : output) result = std::max(result, std::fabs(sample));
        return result;
    };
    const float baseline = peak();
    assert(baseline > 0.1f);
    assert(core.setMixerLevel(2U, 50U, error));
    assert(std::fabs(peak() - baseline * 0.5f) < 0.001f);
    assert(core.setMixerLevel(0U, 50U, error));
    assert(std::fabs(peak() - baseline * 0.25f) < 0.001f);
    assert(core.setMixerLevel(1U, 50U, error));
    assert(std::fabs(peak() - baseline * 0.125f) < 0.001f);
    assert(core.getStatus().mixerLevels[0U] == 50U);
    assert(core.getStatus().mixerLevels[1U] == 50U);
    assert(core.setMixerLevel(3U, 0U, error));
    assert(std::fabs(peak() - baseline * 0.125f) < 0.001f);
    assert(!core.setMixerLevel(7U, 100U, error));
    assert(!core.setMixerLevel(0U, 201U, error));

    NativeAudioCore monitor;
    NativeAudioCoreTestAccess::prepareWithoutDevice(monitor);
    NativeAudioCoreTestAccess::command(monitor, CommandType::SetMonitoring, true);
    assert(monitor.setMixerLevel(0U, 0U, error));
    std::vector<float> input(256U, 0.2f);
    assert(NativeAudioCoreTestAccess::callback(monitor, input.data(), output.data(), 256U) == 0);
    assert(std::fabs(output[0U] - 0.2f) < 0.001f); // MAIN does not mute monitoring.
    assert(monitor.setMixerLevel(1U, 0U, error));
    assert(NativeAudioCoreTestAccess::callback(monitor, input.data(), output.data(), 256U) == 0);
    for (float sample : output) assert(sample == 0.0f); // MASTER mutes the final sum.
}

void testNativeProjectArchiveTempoMetadataLifecycle() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::string error;
    std::array<float, 128U> output{};
    const auto makeArchive = [](std::uint32_t version, std::optional<double> tempo) {
        DecodedProjectArchive archive;
        archive.version = version;
        archive.name = "Tempo metadata lifecycle";
        archive.bpm = 120.0;
        ProjectArchiveTrackData track;
        track.sampleRate = 48000U;
        track.frameCount = 64U;
        track.channels = 2U;
        track.originalTempoBpm = tempo;
        track.pcm.assign(128U, 0.125f);
        archive.payloadByteLength = track.pcm.size() * sizeof(float);
        archive.tracks[0U] = std::move(track);
        return archive;
    };
    const auto import = [&](DecodedProjectArchive archive) {
        const auto baseline = core.getStatus().projectContentRevision;
        std::uint64_t generation = 0U;
        assert(core.beginProjectArchiveImport(std::move(archive), 512U, baseline, generation, error));
        assert(generation != 0U);
        assert(core.getProjectArchiveImportStatus(generation).state == NativeProjectImportState::Pending);
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
        const auto status = core.getProjectArchiveImportStatus(generation);
        assert(status.state == NativeProjectImportState::Committed && status.error.empty());
    };

    std::uint64_t rejectedGeneration = 0U;
    const auto emptyRevision = core.getStatus().projectContentRevision;
    assert(!core.beginProjectArchiveImport(makeArchive(1U, 123.5), 512U, emptyRevision,
        rejectedGeneration, error));
    assert(rejectedGeneration == 0U && error.find("incompatible with its archive version") != std::string::npos);

    import(makeArchive(2U, 123.5));
    assert(NativeAudioCoreTestAccess::originalTempo(core, 0U) == std::optional<double>{123.5});
    NativeAudioCoreTestAccess::requestTrackSnapshotMetadata(core, 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::snapshotOriginalTempo(core) == std::optional<double>{123.5});
    assert(NativeAudioCoreTestAccess::snapshotTrackContentRevision(core) == core.getStatus().nativeTrackContentRevision[0U]);
    NativeAudioCoreTestAccess::releaseTrackSnapshot(core);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);

    assert(core.clearTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));
    assert(core.getStatus().nativeTrackHistory[0U].canUndo);
    std::atomic<bool> pump{true};
    std::thread audioPump([&] {
        while (pump.load(std::memory_order_acquire)) {
            (void)NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U);
            std::this_thread::yield();
        }
    });
    assert(core.undoTrack(0U, error));
    assert(NativeAudioCoreTestAccess::originalTempo(core, 0U) == std::optional<double>{123.5});
    assert(core.redoTrack(0U, error));
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));
    pump.store(false, std::memory_order_release);
    audioPump.join();

    std::array<float, 128U> take{};
    take.fill(0.25f);
    assert(core.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 64U) == 0);
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));

    assert(core.clearTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    NativeRhythmConfig authority;
    authority.bpm = 120.0;
    assert(core.setNativeRhythmConfig(authority, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.recordTrack(0U, error, 120.0, 7U));
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 64U) == 0);
    assert(core.finishRecordingTrack(0U, error, 120.0, 7U));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    const auto stagedRevision = core.getStatus().nativeTrackContentRevision[0U];
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));
    std::uint64_t confirmationRevision = 0U;
    assert(core.confirmTrackTempoProvenance(0U, stagedRevision, 120.0, 7U, error, &confirmationRevision));
    assert(confirmationRevision > 0U);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::originalTempo(core, 0U) == std::optional<double>{120.0});
    assert(core.undoTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));
    assert(core.redoTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::originalTempo(core, 0U) == std::optional<double>{120.0});

    assert(core.clearTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    // The callback may stage a candidate, but a host rhythm change queued
    // before confirmation must invalidate it at the confirmation boundary.
    assert(core.recordTrack(0U, error, 120.0, 20U));
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 64U) == 0);
    assert(core.finishRecordingTrack(0U, error, 120.0, 20U));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    const auto staleCandidateRevision = core.getStatus().nativeTrackContentRevision[0U];
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));
    authority.bpm = 121.0;
    assert(core.setNativeRhythmConfig(authority, error));
    std::uint64_t staleConfirmationRevision = 0U;
    assert(core.confirmTrackTempoProvenance(0U, staleCandidateRevision, 120.0, 20U,
        error, &staleConfirmationRevision));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.getStatus().nativeRecordTempoConfirmApplied[0U] == staleConfirmationRevision);
    assert(core.getStatus().nativeRecordTempoConfirmAccepted[0U] != staleConfirmationRevision);
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));

    assert(core.clearTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    authority.bpm = 120.0;
    assert(core.setNativeRhythmConfig(authority, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.recordTrack(0U, error, 120.0, 8U));
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 64U) == 0);
    authority.bpm = 121.0;
    assert(core.setNativeRhythmConfig(authority, error));
    // A tempo update queued during REC is applied before FINISH at this same
    // callback boundary. The UI token also changes, so provenance stays unknown.
    assert(core.finishRecordingTrack(0U, error, 121.0, 9U));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));

    assert(core.clearTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    authority.bpm = 120.0;
    assert(core.setNativeRhythmConfig(authority, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    // The UI BPM changes away and back before the pending host tempo update is
    // enqueued. Same BPM is insufficient: the Transport revision must match.
    assert(core.recordTrack(0U, error, 120.0, 10U));
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 64U) == 0);
    assert(core.finishRecordingTrack(0U, error, 120.0, 12U));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));

    assert(core.clearTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.recordTrack(0U, error, 120.0, 13U));
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 64U) == 0);
    // Transport changed before finish, but its asynchronous rhythm update has
    // not reached the host queue. The per-request Transport token still fails.
    assert(core.finishRecordingTrack(0U, error, 121.0, 14U));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));

    import(makeArchive(1U, std::nullopt));
    assert(!NativeAudioCoreTestAccess::originalTempo(core, 0U));
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeWholeMemoryPreparedBanksCommitAndControlAck() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    std::string error;
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "phaser", {}, false, error));
    const auto* incumbent = NativeAudioCoreTestAccess::memoryProcessor(core, 1U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    const auto makeArchive = [] {
        DecodedProjectArchive archive;
        archive.version = 1U; archive.name = "Whole Memory"; archive.bpm = 120.0;
        ProjectArchiveTrackData track;
        track.sampleRate = 48000U; track.frameCount = 2U; track.channels = 2U;
        track.pcm = {0.25f, -0.25f, 0.5f, -0.5f};
        archive.payloadByteLength = track.pcm.size() * sizeof(float);
        archive.tracks[0U] = std::move(track);
        return archive;
    };
    const auto makeMemory = [] {
        auto memory = std::make_unique<NativeMemorySettings>();
        memory->recordActionIncluded = true; memory->recordActionDub = true;
        for (auto& bank : memory->banks) bank[0U].effectId = "fractional_delay";
        memory->rhythm.volume = 37U;
        memory->reverb.enabled = true;
        memory->reverb.wetMix = 0.4f;
        memory->pitch.enabled = true;
        memory->pitch.semitones = 3.0f;
        memory->trackFxApply = {{false, true, false, true, false}};
        memory->mixerLevels = {{80U, 90U, 100U, 110U, 120U, 130U, 140U}};
        memory->dubModes = {{NativeDubMode::Replace1, NativeDubMode::Overdub, NativeDubMode::Replace2,
            NativeDubMode::Overdub, NativeDubMode::Replace1}};
        memory->dubModesIncluded = true;
        return memory;
    };
    LoopTransportConfig pendingTransport;
    pendingTransport.oneShot = true;
    std::uint64_t acceptedTransportRevision = 0U;
    assert(core.setNativeLoopTransport(0U, pendingTransport, error, &acceptedTransportRevision));
    std::uint64_t generation = 0U;
    const auto pendingBaseline = core.getStatus().projectContentRevision;
    assert(!core.beginProjectArchiveImport(makeArchive(), 256U, pendingBaseline, generation, error, makeMemory()));
    assert(generation == 0U && error.find("queued FX/rhythm/source") != std::string::npos);
    std::array<float, 128U> output{};
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    const auto transportApplied = core.getStatus();
    assert(transportApplied.nativeLoopTransportRequestedRevision[0U] == acceptedTransportRevision);
    assert(transportApplied.nativeLoopTransportAppliedRevision[0U] == acceptedTransportRevision);
    NativeAudioCoreTestAccess::setLoopTransportFaultForTest(core, 0U, acceptedTransportRevision);
    const auto faultBaseline = core.getStatus().projectContentRevision;
    assert(!core.beginProjectArchiveImport(makeArchive(), 256U, faultBaseline, generation, error, makeMemory()));
    assert(generation == 0U && error.find("loop transport settings") != std::string::npos);
    NativeAudioCoreTestAccess::setLoopTransportFaultForTest(core, 0U, 0U);
    auto invalid = makeMemory(); invalid->banks[6U][3U].effectId = "missing";
    const auto baseline = core.getStatus().projectContentRevision;
    assert(!core.beginProjectArchiveImport(makeArchive(), 256U, baseline, generation, error, std::move(invalid)));
    assert(generation == 0U && NativeAudioCoreTestAccess::memoryProcessor(core, 1U) == incumbent);
    const auto oldEstimate = NativeAudioCoreTestAccess::setMemoryBudgetEstimate(core, kNativeProjectImportPeakBudgetBytes);
    assert(!core.beginProjectArchiveImport(makeArchive(), 256U, baseline, generation, error, makeMemory()));
    assert(generation == 0U && error.find("peak estimate") != std::string::npos);
    (void)NativeAudioCoreTestAccess::setMemoryBudgetEstimate(core, oldEstimate);
    assert(core.beginProjectArchiveImport(makeArchive(), 256U, baseline, generation, error, makeMemory()));
    assert(core.getProjectArchiveImportStatus(generation).state == NativeProjectImportState::Prepared);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::memoryProcessor(core, 1U) == incumbent);
    assert(core.commitPreparedMemory(generation, error));
    NativeAudioCoreTestAccess::reserveGraphReader(core, true);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(NativeAudioCoreTestAccess::memoryProcessor(core, 1U) == incumbent);
    NativeAudioCoreTestAccess::reserveGraphReader(core, false);
    const auto allocations = trackedAllocations;
    const auto deallocations = trackedDeallocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocations && trackedDeallocations == deallocations);
    assert(NativeAudioCoreTestAccess::retainsMemoryGraph(core));
    for (std::size_t bank = 0U; bank < 7U; ++bank) {
        assert(NativeAudioCoreTestAccess::memoryProcessor(core, bank) != nullptr);
    }
    const auto status = core.getStatus(); // ACK + control-only old graph reclamation.
    assert(!NativeAudioCoreTestAccess::retainsMemoryGraph(core));
    assert(core.getProjectArchiveImportStatus(generation).state == NativeProjectImportState::Committed);
    assert(status.nativeCatalogSlots[0U].effectId == "fractional_delay" && status.nativeRhythmVolume == 37U);
    assert(status.nativeTrackStates[0U] == LooperState::Stopped);
    assert(status.nativeReverbEnabled && std::fabs(status.nativeReverbWetMix - 0.4f) < 1.0e-6f);
    assert(status.nativePitchEnabled && status.nativePitchSemitones == 3.0f);
    assert(status.nativeRecordActionDub && status.nativeRecordActionRequestedRevision == status.nativeRecordActionAppliedRevision);
    assert((status.nativeMemoryDubModes == std::array<NativeDubMode, kNativeTrackCount>{{
        NativeDubMode::Replace1, NativeDubMode::Overdub, NativeDubMode::Replace2,
        NativeDubMode::Overdub, NativeDubMode::Replace1}}));
    assert(status.nativeTrackDubModes == status.nativeMemoryDubModes);
    assert(status.nativeTrackRequestedDubModes == status.nativeMemoryDubModes);
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        assert(status.nativeDubModeRequestedRevision[track] == status.nativeDubModeAppliedRevision[track]);
    }
    for (std::size_t track = 0U; track < 5U; ++track) {
        assert(status.nativeTrackFxApply[track].requested == (track % 2U == 1U));
        assert(status.nativeTrackFxApply[track].applied == status.nativeTrackFxApply[track].requested);
        assert(status.nativeTrackFxApply[track].appliedRevision == status.nativeTrackFxApply[track].requestedRevision);
    }
    assert((status.mixerLevels == std::array<unsigned int, 7U>{{80U, 90U, 100U, 110U, 120U, 130U, 140U}}));
    const auto beforeAba = status.projectContentRevision;
    NativeRhythmConfig rhythm; rhythm.volume = 38U;
    assert(core.setNativeRhythmConfig(rhythm, error));
    rhythm.volume = 37U;
    assert(core.setNativeRhythmConfig(rhythm, error));
    assert(core.getStatus().projectContentRevision > beforeAba);
    assert(!core.beginProjectArchiveImport(makeArchive(), 256U, beforeAba, generation, error, makeMemory()));
    assert(generation == 0U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeRecActionAtomicCompletionAndBudgetedShadow() {
    for (const bool dub : {false, true}) {
        NativeAudioCore core;
        NativeAudioCoreTestAccess::prepareWithoutDevice(core);
        NativeAudioCoreTestAccess::setInputChannels(core, 2U);
        NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
        std::array<float, 128U> input{}, output{}; input.fill(0.25f);
        std::string error;
        assert(core.setRecordAction(dub, error));
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
        const auto action = core.getStatus();
        assert(action.nativeRecordActionDub == dub);
        assert(action.nativeRecordActionAppliedRevision == action.nativeRecordActionRequestedRevision);
        assert(core.recordTrack(0U, error));
        assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 64U) == 0);
        assert(core.getStatus().nativeTrackStates[0U] == LooperState::Recording);
        assert(!core.setRecordAction(!dub, error)); // Cannot invalidate the shadow contract mid-take.
        assert(core.finishRecordingTrack(0U, error));
        assert(!core.finishRecordingTrack(0U, error));
        const auto accepted = core.getStatus();
        assert(accepted.nativeRecordFinishRequested[0U] > accepted.nativeRecordFinishApplied[0U]);
        input.fill(0.125f);
        const auto allocations = trackedAllocations, deallocations = trackedDeallocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 64U) == 0);
        trackAllocations = false;
        assert(trackedAllocations == allocations && trackedDeallocations == deallocations);
        const auto applied = core.getStatus();
        assert(applied.nativeTrackStates[0U] == (dub ? LooperState::Overdubbing : LooperState::Playing));
        assert(applied.nativeRecordFinishApplied[0U] == applied.nativeRecordFinishRequested[0U]);
        for (const auto sample : output) assert(std::fabs(sample - (dub ? 0.375f : 0.25f)) < 1.0e-6f);
        assert(!core.finishRecordingTrack(0U, error));
        if (dub) {
            assert(applied.nativeHistoryRetainedBytes == 64U * 2U * sizeof(float));
            assert(core.toggleTrackOverdub(0U, error));
            assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
            assert(core.stopTrack(0U, error));
            assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
            { CallbackPump pump(core); assert(core.undoTrack(0U, error)); }
            std::array<float, 128U> restored{}; std::size_t frames = 0U;
            assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, restored.data(), 64U, frames));
            assert(frames == 64U); for (const auto sample : restored) assert(sample == 0.25f);
        }
        NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
    }
    NativeAudioCore full;
    NativeAudioCoreTestAccess::prepareWithoutDevice(full);
    NativeAudioCoreTestAccess::setRunningForQueueTest(full, true);
    std::array<float, 128U> output{}; std::string error;
    assert(full.setRecordAction(true, error));
    assert(NativeAudioCoreTestAccess::callback(full, nullptr, output.data(), 64U) == 0);
    NativeAudioCoreTestAccess::setHistoryRetainedBytesForBudgetTest(full, kNativeHistoryBudgetBytes);
    assert(!full.recordTrack(0U, error));
    assert(error.find("history budget") != std::string::npos);
    assert(full.getStatus().nativeTrackStates[0U] == LooperState::Empty);
    assert(NativeAudioCoreTestAccess::commandQueueSize(full) == 0U);
    NativeAudioCoreTestAccess::setHistoryRetainedBytesForBudgetTest(full, 0U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(full, false);
}

void testNativeDubModeCallbackAckPcmAndUndoCancellation() {
    for (const auto mode : {NativeDubMode::Replace1, NativeDubMode::Replace2}) {
        NativeAudioCore core;
        std::string error;
        NativeAudioCoreTestAccess::prepareWithoutDevice(core);
        NativeAudioCoreTestAccess::setInputChannels(core, 2U);
        NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
        constexpr unsigned int frames = 64U;
        std::vector<float> original(frames * 2U);
        std::vector<float> replacement(frames * 2U, 0.25f);
        for (std::size_t frame = 0U; frame < frames; ++frame) {
            original[frame * 2U] = 0.1f + static_cast<float>(frame) * 0.001f;
            original[frame * 2U + 1U] = -original[frame * 2U];
        }
        std::array<float, frames * 2U> output{};
        assert(core.recordTrack(0U, error));
        assert(NativeAudioCoreTestAccess::callback(core, original.data(), output.data(), frames) == 0);
        assert(core.stopTrack(0U, error));
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);

        std::uint64_t requestedRevision = 0U;
        assert(core.setNativeDubMode(0U, mode, requestedRevision, error));
        auto status = core.getStatus();
        assert(status.nativeTrackRequestedDubModes[0U] == mode);
        assert(status.nativeTrackDubModes[0U] == NativeDubMode::Overdub);
        assert(status.nativeDubModeRequestedRevision[0U] == requestedRevision);
        assert(status.nativeDubModeAppliedRevision[0U] < requestedRevision);
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
        status = core.getStatus();
        assert(status.nativeTrackDubModes[0U] == mode);
        assert(status.nativeDubModeAppliedRevision[0U] == requestedRevision);

        assert(core.playTrack(0U, error));
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
        {
            CallbackPump pump(core, replacement.data());
            assert(core.toggleTrackOverdub(0U, error));
            bool enteredOverdub = false;
            for (unsigned int wait = 0U; wait < 1000U; ++wait) {
                if (core.getStatus().nativeTrackStates[0U] == LooperState::Overdubbing) {
                    enteredOverdub = true;
                    break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(1));
            }
            assert(enteredOverdub);
        }
        const auto allocations = trackedAllocations;
        const auto deallocations = trackedDeallocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(core, replacement.data(), output.data(), frames) == 0);
        trackAllocations = false;
        assert(trackedAllocations == allocations && trackedDeallocations == deallocations);
        assert(core.getStatus().nativeTrackStates[0U] == LooperState::Overdubbing);
        assert(!core.setNativeDubMode(0U, NativeDubMode::Overdub, requestedRevision, error));

        assert(core.toggleTrackOverdub(0U, error));
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
        assert(core.stopTrack(0U, error));
        assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), frames) == 0);
        assert(core.getStatus().nativeTrackStates[0U] == LooperState::Stopped);
        assert(NativeAudioCoreTestAccess::trackMetadata(core, 0U).finalizedFrames == frames);
        std::vector<float> replaced(frames * 2U);
        std::size_t copiedFrames = 0U;
        assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, replaced.data(), frames, copiedFrames));
        assert(copiedFrames == frames && replaced == replacement);

        // Cancel the committed replacement using the same budgeted PCM history
        // transaction as OVERDUB; the restored loop must be bit-exact.
        { CallbackPump pump(core); assert(core.undoTrack(0U, error)); }
        std::vector<float> restored(frames * 2U);
        assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, restored.data(), frames, copiedFrames));
        assert(copiedFrames == frames && restored == original);
        status = core.getStatus();
        assert(status.nativeTrackHistory[0U].canRedo);
        NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
    }
}

void testNativeOneShotOverdubAdmissionIsSideEffectFree() {
    using namespace webrc::native;
    std::string error;
    std::array<float, 128U> output{};
    const std::array<float, 8U> input{{0.1f, -0.1f, 0.2f, -0.2f, 0.3f, -0.3f, 0.4f, -0.4f}};

    NativeAudioCore overdubCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(overdubCore);
    LoopTransportConfig oneShot;
    oneShot.oneShot = true;
    assert(overdubCore.setNativeLoopTransport(0U, oneShot, error));
    NativeAudioCoreTestAccess::setRunningForQueueTest(overdubCore, true);
    NativeAudioCoreTestAccess::recordLoop(overdubCore, 0U,
        std::vector<float>(input.begin(), input.end()), 4U, output.data());
    assert(overdubCore.playTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(overdubCore, nullptr, output.data(), 1U) == 0);
    auto before = overdubCore.getStatus();
    assert(before.nativeTrackStates[0U] == LooperState::Playing);
    assert(before.nativeLoopTransportAppliedOneShot[0U]);
    assert(before.nativeTrackHistory[0U].canUndo);
    const auto queueBefore = NativeAudioCoreTestAccess::commandQueueSize(overdubCore);
    assert(!overdubCore.toggleTrackOverdub(0U, error));
    assert(error.find("1SHOT") != std::string::npos);
    const auto after = overdubCore.getStatus();
    assert(after.nativeTrackStates[0U] == before.nativeTrackStates[0U]);
    assert(after.nativeHistoryRetainedBytes == before.nativeHistoryRetainedBytes);
    assert(after.nativeTrackHistory[0U].canUndo == before.nativeTrackHistory[0U].canUndo);
    assert(after.nativeTrackHistory[0U].canRedo == before.nativeTrackHistory[0U].canRedo);
    assert(NativeAudioCoreTestAccess::commandQueueSize(overdubCore) == queueBefore);
    NativeAudioCoreTestAccess::setRunningForQueueTest(overdubCore, false);

    NativeAudioCore recDubCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(recDubCore);
    assert(recDubCore.setNativeLoopTransport(0U, oneShot, error));
    assert(recDubCore.setRecordAction(true, error));
    NativeAudioCoreTestAccess::setRunningForQueueTest(recDubCore, true);
    assert(recDubCore.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(recDubCore, input.data(), output.data(), 4U) == 0);
    const auto recBefore = recDubCore.getStatus();
    assert(recBefore.nativeTrackStates[0U] == LooperState::Recording);
    assert(recBefore.nativeHistoryRetainedBytes == 0U); // 1SHOT takes do not reserve REC->DUB shadow PCM.
    assert(recDubCore.finishRecordingTrack(0U, error));
    assert(NativeAudioCoreTestAccess::commandQueueSize(recDubCore) == 1U);
    assert(NativeAudioCoreTestAccess::callback(recDubCore, nullptr, output.data(), 1U) == 0);
    const auto recAfter = recDubCore.getStatus();
    assert(recAfter.nativeTrackStates[0U] == LooperState::Playing); // 1SHOT REC->DUB falls back to REC->PLAY.
    assert(recAfter.nativeRecordFinishApplied[0U] == recAfter.nativeRecordFinishRequested[0U]);
    assert(recAfter.nativeHistoryRetainedBytes == 0U);
    std::array<float, 8U> completedPcm{};
    std::size_t completedFrames = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(recDubCore, 0U, completedPcm.data(), 4U, completedFrames));
    assert(completedFrames == 4U);
    for (std::size_t frame = 0U; frame < completedFrames; ++frame) {
        assert(completedPcm[frame * 2U] == input[frame]);
        assert(completedPcm[frame * 2U + 1U] == input[frame]);
    }
    assert(recDubCore.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(recDubCore, nullptr, output.data(), 4U) == 0);
    NativeAudioCoreTestAccess::setRunningForQueueTest(recDubCore, false);
}

void testNativeDubModeCannotOvertakePendingTrackCommands() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::array<float, 128U> input{}, output{};
    input.fill(0.2f);
    std::string error;
    assert(core.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 64U) == 0);
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.playTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);

    // A queued overdub start owns the next callback boundary. A later DUB MODE
    // request must not jump ahead of it through the separate control queue.
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::ToggleOverdub, 0U);
    std::uint64_t requestedRevision = 0U;
    assert(!core.setNativeDubMode(0U, NativeDubMode::Replace1, requestedRevision, error));
    assert(error.find("queued Native track commands") != std::string::npos);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    auto status = core.getStatus();
    assert(status.nativeTrackStates[0U] == LooperState::Overdubbing);
    assert(status.nativeTrackDubModes[0U] == NativeDubMode::Overdub);
    assert(status.nativeTrackRequestedDubModes[0U] == NativeDubMode::Overdub);
    assert(status.nativeDubModeRequestedRevision[0U] == status.nativeDubModeAppliedRevision[0U]);

    NativeAudioCore pending;
    NativeAudioCoreTestAccess::prepareWithoutDevice(pending);
    NativeAudioCoreTestAccess::setInputChannels(pending, 2U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(pending, true);
    assert(pending.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(pending, input.data(), output.data(), 64U) == 0);
    assert(pending.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(pending, nullptr, output.data(), 64U) == 0);
    assert(pending.playTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(pending, nullptr, output.data(), 64U) == 0);
    assert(pending.setNativeDubMode(0U, NativeDubMode::Replace2, requestedRevision, error));
    assert(!pending.toggleTrackOverdub(0U, error));
    assert(error.find("DUB MODE callback acknowledgement") != std::string::npos);
    assert(NativeAudioCoreTestAccess::callback(pending, nullptr, output.data(), 64U) == 0);
    status = pending.getStatus();
    assert(status.nativeTrackDubModes[0U] == NativeDubMode::Replace2);
    assert(status.nativeDubModeRequestedRevision[0U] == status.nativeDubModeAppliedRevision[0U]);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
    NativeAudioCoreTestAccess::setRunningForQueueTest(pending, false);
}

void testNativeLoopTransportAndTrackCommandsShareAdmissionOrder() {
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    NativeAudioCoreTestAccess::setInputChannels(core, 2U);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::array<float, 128U> input{}, output{};
    input.fill(0.2f);
    std::string error;
    LoopTransportConfig config;
    config.mode = LoopTransportMode::BeatShift;
    config.beatOffsetBeats = 0.25f;
    config.bpm = 120.0f;
    config.crossfadeMs = 1.0f;

    // A queued transport setting must be applied before a new track command
    // can enter the callback's earlier-consumed track queue.
    assert(core.setNativeLoopTransport(0U, config, error));
    assert(!core.recordTrack(0U, error));
    assert(error.find("loop transport callback acknowledgement") != std::string::npos);
    assert(core.stopTrack(0U, error)); // Safety actions remain admissible during a transport update.
    assert(core.clearTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.recordTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), 64U) == 0);

    // Conversely, a track transition already queued owns the next callback
    // boundary; later transport configuration cannot overtake it.
    assert(core.stopTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.playTrack(0U, error));
    assert(!core.setNativeLoopTransport(0U, config, error));
    assert(error.find("queued Native track commands") != std::string::npos);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    assert(core.setNativeLoopTransport(0U, config, error));
    assert(!core.toggleTrackOverdub(0U, error));
    assert(error.find("loop transport callback acknowledgement") != std::string::npos);
    assert(NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), 64U) == 0);
    {
        CallbackPump pump(core, input.data());
        assert(core.toggleTrackOverdub(0U, error));
        bool enteredOverdub = false;
        for (unsigned int wait = 0U; wait < 1000U; ++wait) {
            if (core.getStatus().nativeTrackStates[0U] == LooperState::Overdubbing) {
                enteredOverdub = true;
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        assert(enteredOverdub);
    }
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeBounceSumsBlockStableSourcesExcludesSelfAndIgnoresInactiveTracks() {
    using namespace webrc::native;
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    constexpr unsigned int frames = 64U;
    constexpr std::size_t loopFrames = 128U;
    std::array<float, frames * 2U> output{};
    std::vector<float> first(loopFrames, 0.2f), second(loopFrames, 0.3f);
    NativeAudioCoreTestAccess::recordLoop(core, 0U, first, frames, output.data());
    NativeAudioCoreTestAccess::recordLoop(core, 1U, second, frames, output.data());

    NativeBounceSettings bounce;
    bounce.bounceSw = true;
    bounce.bounceIn[2U] = true;
    bounce.bounceTrack[0U] = true;
    bounce.bounceTrack[1U] = true;
    bounce.bounceTrack[2U] = true; // Destination self-route must be excluded.
    bounce.bounceTrack[3U] = true; // Empty/inactive source contributes silence.
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::string error;
    assert(core.setNativeBounceSettings(bounce, error));
    auto status = core.getStatus();
    assert(status.nativeBounceRequestedRevision > status.nativeBounceAppliedRevision);
    assert(!status.nativeBounce.bounceSw); // Status exposes only the callback-applied configuration.
    std::array<float, frames * 2U> silence{};
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
    status = core.getStatus();
    assert(status.nativeBounceRequestedRevision == status.nativeBounceAppliedRevision);
    assert(status.nativeBounce.bounceSw && status.nativeBounce.bounceIn[2U]);

    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 0U);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 1U);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Record, 2U);
    for (unsigned int block = 0U; block < 2U; ++block) {
        assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
        for (const auto sample : output) assert(std::fabs(sample - 0.5f) < 1.0e-6f);
    }
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::StopRecordOrPlayback, 2U);
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
    std::array<float, loopFrames * 2U> captured{};
    std::size_t copied = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 2U, captured.data(), loopFrames, copied));
    assert(copied == loopFrames);
    for (const auto sample : captured) assert(std::fabs(sample - 0.5f) < 1.0e-6f);

    bounce.bounceIn[2U] = false;
    bounce.bounceIn[4U] = true;
    assert(core.setNativeBounceSettings(bounce, error));
    status = core.getStatus();
    assert(status.nativeBounceRequestedRevision > status.nativeBounceAppliedRevision);
    assert(status.nativeBounce.bounceIn[2U] && !status.nativeBounce.bounceIn[4U]);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Record, 4U);
    for (unsigned int block = 0U; block < 2U; ++block) assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::StopRecordOrPlayback, 4U);
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
    captured.fill(-1.0f); copied = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 4U, captured.data(), loopFrames, copied));
    assert(copied == loopFrames);
    for (const auto sample : captured) assert(std::fabs(sample - 0.5f) < 1.0e-6f);

    NativeAudioCoreTestAccess::commandTrack(core, CommandType::Play, 4U);
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::ToggleOverdub, 4U);
    for (unsigned int block = 0U; block < 2U; ++block) {
        assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
        assert(core.getStatus().nativeTrackStates[4U] == LooperState::Overdubbing);
    }
    NativeAudioCoreTestAccess::commandTrack(core, CommandType::StopRecordOrPlayback, 4U);
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
    captured.fill(-1.0f); copied = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 4U, captured.data(), loopFrames, copied));
    assert(copied == loopFrames);
    for (const auto sample : captured) assert(std::fabs(sample - 1.0f) < 1.0e-6f);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

void testNativeBounceUsesOverdubbingSourcePreviewWithoutOrderDependentAdvance() {
    using namespace webrc::native;
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);
    constexpr unsigned int frames = 64U;
    constexpr std::size_t loopFrames = 128U;
    std::array<float, frames * 2U> output{};
    std::array<float, frames * 2U> silence{};
    std::vector<float> source(loopFrames, 0.2f);
    NativeAudioCoreTestAccess::recordLoop(core, 4U, source, frames, output.data());

    NativeBounceSettings bounce;
    bounce.bounceSw = true;
    bounce.bounceIn[0U] = true;
    bounce.bounceTrack[4U] = true; // Source is processed after destination track 1.
    std::string error;
    assert(core.setNativeBounceSettings(bounce, error));
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    assert(core.playTrack(4U, error));
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
    assert(core.getStatus().nativeTrackStates[4U] == LooperState::Playing);
    {
        CallbackPump pump(core);
        assert(core.toggleTrackOverdub(4U, error));
        bool enteredOverdub = false;
        for (unsigned int wait = 0U; wait < 1000U; ++wait) {
            if (core.getStatus().nativeTrackStates[4U] == LooperState::Overdubbing) {
                enteredOverdub = true;
                break;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        assert(enteredOverdub);
    }

    assert(core.recordTrack(0U, error));
    for (unsigned int block = 0U; block < 2U; ++block) {
        const auto allocationsBefore = trackedAllocations;
        trackAllocations = true;
        assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
        trackAllocations = false;
        assert(trackedAllocations == allocationsBefore);
    }
    assert(core.finishRecordingTrack(0U, error));
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), frames) == 0);
    std::array<float, loopFrames * 2U> captured{};
    std::size_t copied = 0U;
    assert(NativeAudioCoreTestAccess::copyStereoTrack(core, 0U, captured.data(), loopFrames, copied));
    assert(copied == loopFrames);
    for (const auto sample : captured) assert(std::fabs(sample - 0.2f) < 1.0e-6f);
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
}

int main() {
    testNativeRecActionAtomicCompletionAndBudgetedShadow();
    testNativeOneShotOverdubAdmissionIsSideEffectFree();
    testMixerIndependentPcmGains();
#if defined(NATIVE_MEMORY_TESTS_ONLY)
    testNativeWholeMemoryPreparedBanksCommitAndControlAck();
    testNativeDubModeCallbackAckPcmAndUndoCancellation();
    testNativeDubModeCannotOvertakePendingTrackCommands();
    testNativeLoopTransportAndTrackCommandsShareAdmissionOrder();
    testNativeProjectArchiveImportIsAtomicAndReclaimsOnControlThread();
    testNativeProjectArchiveTempoMetadataLifecycle();
    return 0;
#elif defined(NATIVE_TRACK_MARK_TESTS_ONLY)
    testNativeIndependentMarkRequiresCallbackReleaseAckAndClearKeepsHistory();
    testNativeMarkStatusReportsBudgetFailureWithoutApplyingSnapshot();
    return 0;
#else
    testNativeIndependentMarkRequiresCallbackReleaseAckAndClearKeepsHistory();
    testNativeMarkStatusReportsBudgetFailureWithoutApplyingSnapshot();
    testNativePerTrackCatalogControlsAndIndependentOutput();
    testEveryAdvertisedPerTrackCatalogTypeThroughNativeCoreAt64Frames();
    testNativePerTrackUnpreparedProcessorPublishesFault();
    testNativePerTrackPcmHistoryAndPinnedRestore();
    testNativeHistoryBudgetRefusalAndGenerationAck();
    testNativeHistoryRestoreSerializesRapidCommandProducer();
    testNativeTrackCommandQueueSerializesConcurrentProducers();
    testNativePerTrackFxLeavesRecordOverdubAndMonitoringCanonical();
    testNativeTwentySlotChainsMatchIndependentOrderedReferencesAt64Frames();
    testNativePitchTargetsOnlySelectedTrackAndFallsBackOnItsLoopLength();
    testNativePitchChangesOnlyLoopPlaybackAndIsRealtimeSafe();
    testNativeLivePolyPitchUsesOnlyPlaybackTap();
    testNativeInputCatalogLoFiProcessesLiveBeforeRecord();
    testNativeTrackFxApplySelectsRecordingSourceAtCallbackBoundary();
    testNativeTrackFxApplyPlaybackPreservesPrivateChainsAndStereoIsolation();
    testNativeLoopSnapshotPinsTransportMutations();
    testNativeLoopSnapshotRejectsEmptyRecordingAndOverdubbing();
    testNativeFiveTrackStereoMixAndTrackCommands();
    testSampleRateChangeRejectsNonEmptyTrackWithoutLosingPcm();
    testNativeRecordingCallbackUsesPreparedStorageWithoutAllocation();
    testNativeLoopTransportQueueCallbackAndEngineStatus();
    NativeAudioCore core;
    NativeAudioCoreTestAccess::prepareWithoutDevice(core);

    auto status = core.getStatus();
    assert(status.nativeOutputLowPassAvailable);
    assert(!status.nativeOutputLowPassEnabled);
    assert(status.nativeOutputHighPassAvailable);
    assert(!status.nativeOutputHighPassEnabled);
    assert(!status.nativeOutputDriveAvailable);
    assert(!status.nativeOutputDriveEnabled);
    assert(status.nativeReverbAvailable);
    assert(!status.nativeReverbEnabled);
    assert(status.nativeReverbWetMix == 0.25f);
    assert(status.nativeReverbRt60Seconds == 2.0f);
    assert(status.nativeReverbAlgorithmicLatencyFrames == NativeOutputStage::reverbMinimumDelayFramesForSampleRate(48000));
    assert(status.nativeTrackOutputBankAvailable);
    assert(status.nativeTrackOutputSlotActive[0]);
    assert(!status.nativeTrackOutputSlotActive[1]);
    assert(!status.nativeTrackOutputMultiTrackImplemented);
    assert(status.nativeFractionalDelayAvailable);
    assert(!status.nativeFractionalDelayEnabled);
    assert(status.nativeCompressorAvailable);
    assert(!status.nativeCompressorEnabled);
    assert(status.nativeCompressorSlot == NativeTrackOutputSlot::A);
    assert(status.nativeCompressorAlgorithm == NativeCompressorAlgorithm::PeakCompressor);
    assert(status.nativeChorusAvailable);
    assert(!status.nativeChorusEnabled);
    assert(status.nativeChorusSlot == NativeTrackOutputSlot::A);
    assert(status.nativeChorusAlgorithm == NativeChorusAlgorithm::StereoLfoLagrange4);
    assert(status.nativePhaserAvailable);
    assert(!status.nativePhaserEnabled);
    assert(status.nativePhaserSlot == NativeTrackOutputSlot::A);
    assert(status.nativePhaserAlgorithm == NativePhaserAlgorithm::AllpassSweep);
    assert(status.nativePhaserStages == 8U);
    assert(status.nativeAutoPanAvailable);
    assert(!status.nativeAutoPanEnabled);
    assert(status.nativeAutoPanSlot == NativeTrackOutputSlot::A);
    assert(status.nativeAutoPanAlgorithm == NativeAutoPanAlgorithm::EqualPowerMidSideLfo);
    assert(status.nativeAutoPanRateHz == 0.5f);
    assert(status.nativeAutoPanDepth == 0.7f);
    assert(status.nativeAutoPanWaveform == NativeAutoPanWaveform::Sine);
    assert(!status.fullFxGraphImplemented);
    assert(status.nativeRhythmAvailable);
    assert(!status.nativeRhythmEnabled);
    assert(status.nativeRhythmPatternCatalogAvailable);
    assert(status.nativeRhythmPatternIndex == 1U);
    assert(status.nativeRhythmPatternId == "rhythm-001");
    assert(status.nativeRhythmEventsCleanRoomProcedural);
    assert(status.nativePitchCorrectionAvailable);
    assert(status.nativePitchCorrectionImplemented);

    const std::array<float, 4> take{{0.25f, -0.5f, 0.75f, -0.25f}};
    const std::array<float, 4> silence{};
    std::array<float, 8> output{};

    NativeAudioCoreTestAccess::command(core, CommandType::Record);
    assert(NativeAudioCoreTestAccess::callback(core, take.data(), output.data(), 4) == 0);
    assert(core.getStatus().state == LooperState::Recording);
    for (const float sample : output) {
        assert(sample == 0.0f);
    }

    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), 4) == 0);
    std::array<float, 8> dryPlayback = output;
    for (std::size_t frame = 0; frame < take.size(); ++frame) {
        assert(dryPlayback[frame * 2] == take[frame]);
        assert(dryPlayback[frame * 2 + 1] == take[frame]);
    }

    // Exercise the same SPSC command queue used while RtAudio is active, then
    // call the actual static RtAudio callback entry point with a test block.
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    std::string error;
    assert(core.setOutputLowPassEnabled(true, error));
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), 4) == 0);
    status = core.getStatus();
    assert(status.nativeOutputLowPassEnabled);
    assert(status.outputPeak > 0.0f);

    bool outputChanged = false;
    for (std::size_t i = 0; i < output.size(); ++i) {
        assert(std::isfinite(output[i]));
        outputChanged = outputChanged || std::fabs(output[i] - dryPlayback[i]) > 1.0e-5f;
    }
    assert(outputChanged);

    // The FX stage runs after LooperCore's record/play/overdub update, so a
    // bypassed replay still returns the original stored take.
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
    assert(core.setOutputLowPassEnabled(false, error));
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), 4) == 0);
    for (std::size_t i = 0; i < output.size(); ++i) {
        assert(output[i] == dryPlayback[i]);
    }

    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    assert(core.setOutputHighPassEnabled(true, error));
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(core, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(core, silence.data(), output.data(), 4) == 0);
    status = core.getStatus();
    assert(status.nativeOutputHighPassEnabled);
    assert(!status.nativeOutputDriveAvailable);
    assert(!status.nativeOutputDriveEnabled);
    for (const float sample : output) {
        assert(std::isfinite(sample));
    }
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
    assert(core.setOutputHighPassEnabled(false, error));

    // Native rhythm configuration crosses the same bounded command queue and
    // produces sound in the actual callback's 64-frame output block.
    NativeRhythmConfig rhythmConfig;
    rhythmConfig.enabled = true;
    rhythmConfig.bpm = 120.0;
    rhythmConfig.kitIndex = 5;
    rhythmConfig.variation = NativeRhythmVariation::B;
    rhythmConfig.section = NativeRhythmSection::Main;
    const std::array<float, 64> rhythmSilence{};
    std::array<float, 128> rhythmOutput{};
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, true);
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    assert(core.setNativeRhythmConfig(rhythmConfig, error));
    const auto allocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, rhythmSilence.data(), rhythmOutput.data(), 64) == 0);
    trackAllocations = false;
    assert(trackedAllocations == allocationsBefore);
    status = core.getStatus();
    assert(status.nativeRhythmEnabled);
    assert(status.nativeRhythmKitIndex == 5);
    assert(status.nativeRhythmVariation == NativeRhythmVariation::B);
    assert(status.nativeRhythmPatternCatalogAvailable);
    assert(status.outputPeak > 0.0f);
    bool rhythmOutputPresent = false;
    for (std::size_t i = 0; i < rhythmOutput.size(); ++i) {
        assert(std::isfinite(rhythmOutput[i]));
        rhythmOutputPresent = rhythmOutputPresent || std::fabs(rhythmOutput[i]) > 1.0e-6f;
    }
    assert(rhythmOutputPresent);

    // The same actual callback consumes the bounded Native reverb command and
    // renders a full 64-frame-multiple block without any heap allocation.
    NativeReverbConfig reverbConfig;
    reverbConfig.enabled = true;
    reverbConfig.wetMix = 0.65f;
    reverbConfig.rt60Seconds = 1.4f;
    reverbConfig.dampingCutoffHz = 12000.0f;
    assert(core.setNativeReverbConfig(reverbConfig, error));
    NativeReverbConfig invalidReverbConfig = reverbConfig;
    invalidReverbConfig.dampingCutoffHz = 499.0f;
    assert(!core.setNativeReverbConfig(invalidReverbConfig, error));
    const auto reverbStatus = core.getStatus();
    assert(reverbStatus.nativeReverbAvailable);
    assert(reverbStatus.nativeReverbEnabled);
    assert(std::fabs(reverbStatus.nativeReverbWetMix - 0.65f) < 1.0e-6f);
    assert(std::fabs(reverbStatus.nativeReverbRt60Seconds - 1.4f) < 1.0e-6f);
    assert(std::fabs(reverbStatus.nativeReverbDampingCutoffHz - 12000.0f) < 1.0e-6f);
    rhythmConfig.enabled = false;
    assert(core.setNativeRhythmConfig(rhythmConfig, error));
    std::array<float, 1600> reverbInput{};
    reverbInput[0] = 1.0f;
    std::array<float, 3200> reverbOutput{};
    NativeAudioCoreTestAccess::command(core, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(core, CommandType::SetMonitoring, true);
    const auto reverbAllocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, reverbInput.data(), reverbOutput.data(), 1600) == 0);
    trackAllocations = false;
    assert(trackedAllocations == reverbAllocationsBefore);
    for (const float sample : reverbOutput) {
        assert(std::isfinite(sample));
    }
    const auto firstWetFrame = static_cast<std::size_t>(reverbStatus.nativeReverbAlgorithmicLatencyFrames);
    assert(std::fabs(reverbOutput[firstWetFrame * 2U]) > 1.0e-3f);

    NativeFractionalDelayConfig delayConfig;
    delayConfig.enabled = true;
    delayConfig.slot = NativeTrackOutputSlot::A;
    delayConfig.algorithm = NativeFractionalDelayAlgorithm::Lagrange4;
    delayConfig.delayMs = 10.53f;
    delayConfig.wetMix = 1.0f;
    delayConfig.feedback = 0.6f;
    assert(core.setNativeFractionalDelayConfig(delayConfig, error));
    NativeFractionalDelayConfig unsupportedSlot = delayConfig;
    unsupportedSlot.slot = NativeTrackOutputSlot::B;
    assert(!core.setNativeFractionalDelayConfig(unsupportedSlot, error));
    reverbConfig.enabled = false;
    assert(core.setNativeReverbConfig(reverbConfig, error));
    std::array<float, 1600> delayInput{};
    delayInput[0] = 1.0f;
    std::array<float, 3200> delayOutput{};
    const auto delayAllocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(core, delayInput.data(), delayOutput.data(), 1600) == 0);
    trackAllocations = false;
    assert(trackedAllocations == delayAllocationsBefore);
    const auto expectedDelayFrame = static_cast<std::size_t>(std::round(0.01053 * 48000.0));
    float delayPeak = 0.0f;
    for (std::size_t frame = expectedDelayFrame - 3U; frame <= expectedDelayFrame + 3U; ++frame) {
        delayPeak = std::max(delayPeak, std::fabs(delayOutput[frame * 2U]));
    }
    assert(delayPeak > 0.1f);
    const auto delayStatus = core.getStatus();
    assert(delayStatus.nativeFractionalDelayAvailable);
    assert(delayStatus.nativeFractionalDelayEnabled);
    assert(delayStatus.nativeFractionalDelaySlot == NativeTrackOutputSlot::A);
    assert(delayStatus.nativeFractionalDelayAlgorithm == NativeFractionalDelayAlgorithm::Lagrange4);
    assert(std::fabs(delayStatus.nativeFractionalDelayMs - 10.53f) < 1.0e-6f);

    NativeAudioCore compressorCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(compressorCore);
    NativeAudioCoreTestAccess::command(compressorCore, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::setRunningForQueueTest(compressorCore, true);
    NativeCompressorConfig compressorConfig;
    compressorConfig.enabled = true;
    compressorConfig.slot = NativeTrackOutputSlot::A;
    compressorConfig.algorithm = NativeCompressorAlgorithm::PeakCompressor;
    compressorConfig.thresholdDb = -18.0f;
    compressorConfig.ratio = 4.0f;
    compressorConfig.attackMs = 0.1f;
    compressorConfig.releaseMs = 50.0f;
    compressorConfig.wetMix = 1.0f;
    compressorConfig.makeupDb = 0.0f;
    assert(compressorCore.setNativeCompressorConfig(compressorConfig, error));
    NativeCompressorConfig unsupportedCompressorSlot = compressorConfig;
    unsupportedCompressorSlot.slot = NativeTrackOutputSlot::D;
    assert(!compressorCore.setNativeCompressorConfig(unsupportedCompressorSlot, error));

    std::array<float, 64> compressorInput{};
    std::array<float, 128> compressorOutput{};
    compressorInput.fill(0.8f);
    const auto compressorAllocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(compressorCore, compressorInput.data(), compressorOutput.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == compressorAllocationsBefore);
    for (const float sample : compressorOutput) {
        assert(std::isfinite(sample));
    }
    const float compressedLeft = compressorOutput[compressorOutput.size() - 2U];
    const float compressedRight = compressorOutput.back();
    assert(compressedLeft > 0.1f && compressedLeft < 0.3f);
    assert(compressedRight > 0.1f && compressedRight < 0.3f);
    assert(std::fabs(compressedLeft - compressedRight) < 1.0e-6f);
    const auto compressorStatus = compressorCore.getStatus();
    assert(compressorStatus.nativeCompressorAvailable);
    assert(compressorStatus.nativeCompressorEnabled);
    assert(compressorStatus.nativeCompressorSlot == NativeTrackOutputSlot::A);
    assert(compressorStatus.nativeCompressorAlgorithm == NativeCompressorAlgorithm::PeakCompressor);
    assert(std::fabs(compressorStatus.nativeCompressorThresholdDb + 18.0f) < 1.0e-6f);

    NativeAudioCore chorusCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(chorusCore);
    NativeAudioCoreTestAccess::command(chorusCore, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::setRunningForQueueTest(chorusCore, true);
    std::array<float, 1600> chorusPrefillInput{};
    std::array<float, 3200> chorusPrefillOutput{};
    for (std::size_t frame = 0; frame < chorusPrefillInput.size(); ++frame) {
        chorusPrefillInput[frame] = static_cast<float>(0.7 * std::sin(
            2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(frame) / 48000.0
        ));
    }
    assert(NativeAudioCoreTestAccess::callback(
        chorusCore, chorusPrefillInput.data(), chorusPrefillOutput.data(), 1600U
    ) == 0);
    NativeChorusConfig chorusConfig;
    chorusConfig.enabled = true;
    chorusConfig.slot = NativeTrackOutputSlot::A;
    chorusConfig.algorithm = NativeChorusAlgorithm::StereoLfoLagrange4;
    chorusConfig.rateHz = 0.8f;
    chorusConfig.depthMs = 10.0f;
    chorusConfig.feedback = 0.0f;
    chorusConfig.wetMix = 1.0f;
    assert(chorusCore.setNativeChorusConfig(chorusConfig, error));
    NativeChorusConfig inactiveChorusSlot = chorusConfig;
    inactiveChorusSlot.slot = NativeTrackOutputSlot::B;
    assert(!chorusCore.setNativeChorusConfig(inactiveChorusSlot, error));
    std::array<float, 64> chorusInput{};
    std::array<float, 128> chorusOutput{};
    for (std::size_t frame = 0; frame < chorusInput.size(); ++frame) {
        const auto absoluteFrame = 1600U + frame;
        chorusInput[frame] = static_cast<float>(0.7 * std::sin(
            2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(absoluteFrame) / 48000.0
        ));
    }
    const auto chorusAllocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(chorusCore, chorusInput.data(), chorusOutput.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == chorusAllocationsBefore);
    double chorusChangeEnergy = 0.0;
    for (std::size_t frame = 0; frame < chorusInput.size(); ++frame) {
        assert(std::isfinite(chorusOutput[frame * 2U]));
        assert(std::isfinite(chorusOutput[frame * 2U + 1U]));
        const double difference = static_cast<double>(chorusOutput[frame * 2U] - chorusInput[frame]);
        chorusChangeEnergy += difference * difference;
    }
    assert(chorusChangeEnergy > 0.1);
    const auto chorusStatus = chorusCore.getStatus();
    assert(chorusStatus.nativeChorusAvailable);
    assert(chorusStatus.nativeChorusEnabled);
    assert(chorusStatus.nativeChorusSlot == NativeTrackOutputSlot::A);
    assert(chorusStatus.nativeChorusAlgorithm == NativeChorusAlgorithm::StereoLfoLagrange4);
    assert(std::fabs(chorusStatus.nativeChorusRateHz - 0.8f) < 1.0e-6f);

    NativeAudioCore phaserCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(phaserCore);
    NativeAudioCoreTestAccess::command(phaserCore, CommandType::SetMonitoring, true);
    NativeAudioCoreTestAccess::setRunningForQueueTest(phaserCore, true);
    NativePhaserConfig phaserConfig;
    phaserConfig.enabled = true;
    phaserConfig.slot = NativeTrackOutputSlot::A;
    phaserConfig.algorithm = NativePhaserAlgorithm::AllpassSweep;
    phaserConfig.stages = 12U;
    phaserConfig.rateHz = 0.05f;
    phaserConfig.depth = 0.8f;
    phaserConfig.feedback = -0.9f;
    phaserConfig.wetMix = 1.0f;
    assert(phaserCore.setNativePhaserConfig(phaserConfig, error));
    NativePhaserConfig inactivePhaserSlot = phaserConfig;
    inactivePhaserSlot.slot = NativeTrackOutputSlot::B;
    assert(!phaserCore.setNativePhaserConfig(inactivePhaserSlot, error));
    NativePhaserConfig invalidPhaserStages = phaserConfig;
    invalidPhaserStages.stages = 6U;
    assert(!phaserCore.setNativePhaserConfig(invalidPhaserStages, error));

    std::array<float, 64> phaserInput{};
    std::array<float, 128> phaserOutput{};
    for (std::size_t frame = 0; frame < phaserInput.size(); ++frame) {
        phaserInput[frame] = static_cast<float>(0.7 * std::sin(
            2.0 * 3.14159265358979323846 * 440.0 * static_cast<double>(frame) / 48000.0
        ));
    }
    const auto phaserAllocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(phaserCore, phaserInput.data(), phaserOutput.data(), 64U) == 0);
    trackAllocations = false;
    assert(trackedAllocations == phaserAllocationsBefore);
    double phaserChangeEnergy = 0.0;
    for (std::size_t frame = 0; frame < phaserInput.size(); ++frame) {
        assert(std::isfinite(phaserOutput[frame * 2U]));
        assert(std::isfinite(phaserOutput[frame * 2U + 1U]));
        const double difference = static_cast<double>(phaserOutput[frame * 2U] - phaserInput[frame]);
        phaserChangeEnergy += difference * difference;
    }
    assert(phaserChangeEnergy > 1.0e-4);
    const auto phaserStatus = phaserCore.getStatus();
    assert(phaserStatus.nativePhaserAvailable);
    assert(phaserStatus.nativePhaserEnabled);
    assert(phaserStatus.nativePhaserSlot == NativeTrackOutputSlot::A);
    assert(phaserStatus.nativePhaserAlgorithm == NativePhaserAlgorithm::AllpassSweep);
    assert(phaserStatus.nativePhaserStages == 12U);
    assert(std::fabs(phaserStatus.nativePhaserRateHz - 0.05f) < 1.0e-6f);
    assert(std::fabs(phaserStatus.nativePhaserFeedback + 0.9f) < 1.0e-6f);

    NativeAudioCore autoPanCore;
    NativeAudioCoreTestAccess::prepareWithoutDevice(autoPanCore);
    NativeAudioCoreTestAccess::command(autoPanCore, CommandType::SetMonitoring, true);
    NativeAutoPanConfig autoPanConfig;
    autoPanConfig.enabled = true;
    autoPanConfig.slot = NativeTrackOutputSlot::A;
    autoPanConfig.algorithm = NativeAutoPanAlgorithm::EqualPowerMidSideLfo;
    autoPanConfig.rateHz = 4.0f;
    autoPanConfig.depth = 1.0f;
    autoPanConfig.waveform = NativeAutoPanWaveform::Sine;
    autoPanConfig.wetMix = 1.0f;
    assert(autoPanCore.setNativeAutoPanConfig(autoPanConfig, error));
    // The compatibility route selects AUTO PAN in catalog slot A while
    // stopped; its parameter edits are then applied from the callback queue.
    NativeAudioCoreTestAccess::setRunningForQueueTest(autoPanCore, true);
    for (unsigned int queued = 0U; queued < 12U; ++queued) {
        assert(autoPanCore.setNativeAutoPanConfig(autoPanConfig, error));
    }
    assert(!autoPanCore.setNativeAutoPanConfig(autoPanConfig, error));
    assert(error.find("catalog FX command queue is full") != std::string::npos);
    NativeAutoPanConfig inactiveAutoPanSlot = autoPanConfig;
    inactiveAutoPanSlot.slot = NativeTrackOutputSlot::B;
    assert(!autoPanCore.setNativeAutoPanConfig(inactiveAutoPanSlot, error));
    std::array<float, 4096U> autoPanInput{};
    autoPanInput.fill(0.5f);
    std::array<float, 8192U> autoPanOutput{};
    NativeAudioCoreTestAccess::command(autoPanCore, CommandType::Record);
    const auto autoPanAllocationsBefore = trackedAllocations;
    trackAllocations = true;
    assert(NativeAudioCoreTestAccess::callback(
        autoPanCore, autoPanInput.data(), autoPanOutput.data(), 4096U
    ) == 0);
    trackAllocations = false;
    assert(trackedAllocations == autoPanAllocationsBefore);
    for (std::size_t sample = 0U; sample < autoPanOutput.size(); ++sample) {
        assert(std::fabs(autoPanOutput[sample] - 0.5f) < 1.0e-6f);
    }
    NativeAudioCoreTestAccess::command(autoPanCore, CommandType::StopRecordOrPlayback);
    NativeAudioCoreTestAccess::command(autoPanCore, CommandType::Play);
    assert(NativeAudioCoreTestAccess::callback(
        autoPanCore, autoPanInput.data(), autoPanOutput.data(), 4096U
    ) == 0);
    bool autoPanChanged = false;
    for (std::size_t sample = 0U; sample < autoPanOutput.size(); ++sample) {
        assert(std::isfinite(autoPanOutput[sample]));
        autoPanChanged = autoPanChanged || std::fabs(autoPanOutput[sample] - 0.5f) > 0.05f;
    }
    assert(autoPanChanged);
    const auto autoPanStatus = autoPanCore.getStatus();
    assert(autoPanStatus.nativeAutoPanAvailable);
    assert(autoPanStatus.nativeAutoPanEnabled);
    assert(autoPanStatus.nativeAutoPanSlot == NativeTrackOutputSlot::A);
    assert(autoPanStatus.nativeAutoPanAlgorithm == NativeAutoPanAlgorithm::EqualPowerMidSideLfo);
    assert(std::fabs(autoPanStatus.nativeAutoPanRateHz - 4.0f) < 1.0e-6f);
    assert(autoPanStatus.nativeAutoPanDepth == 1.0f);
    assert(autoPanStatus.nativeAutoPanWaveform == NativeAutoPanWaveform::Sine);
    NativeAudioCoreTestAccess::setRunningForQueueTest(autoPanCore, false);
    autoPanConfig.enabled = false;
    assert(autoPanCore.setNativeAutoPanConfig(autoPanConfig, error));
    NativeAudioCoreTestAccess::command(autoPanCore, CommandType::Clear);
    NativeAudioCoreTestAccess::command(autoPanCore, CommandType::SetMonitoring, true);
    assert(NativeAudioCoreTestAccess::callback(
        autoPanCore, autoPanInput.data(), autoPanOutput.data(), 64U
    ) == 0);
    for (std::size_t sample = 0U; sample < 128U; ++sample) {
        assert(std::fabs(autoPanOutput[sample] - 0.5f) < 1.0e-6f);
    }

    NativeAudioCoreTestAccess::setRunningForQueueTest(chorusCore, false);
    chorusConfig.enabled = false;
    assert(chorusCore.setNativeChorusConfig(chorusConfig, error));
    NativeAudioCoreTestAccess::setRunningForQueueTest(phaserCore, false);
    phaserConfig.enabled = false;
    assert(phaserCore.setNativePhaserConfig(phaserConfig, error));
    NativeAudioCoreTestAccess::setRunningForQueueTest(autoPanCore, false);
    NativeAudioCoreTestAccess::setRunningForQueueTest(compressorCore, false);
    compressorConfig.enabled = false;
    assert(compressorCore.setNativeCompressorConfig(compressorConfig, error));
    NativeAudioCoreTestAccess::setRunningForQueueTest(core, false);
    reverbConfig.enabled = false;
    assert(core.setNativeReverbConfig(reverbConfig, error));
    delayConfig.enabled = false;
    assert(core.setNativeFractionalDelayConfig(delayConfig, error));
    assert(core.setNativeRhythmConfig(rhythmConfig, error));
    const auto finalStatus = core.getStatus();
    assert(!finalStatus.nativeOutputLowPassEnabled);
    assert(!finalStatus.fullFxGraphImplemented);
    assert(!finalStatus.nativeRhythmEnabled);
    assert(!finalStatus.nativeReverbEnabled);
    assert(!finalStatus.nativeFractionalDelayEnabled);
    assert(!finalStatus.nativeCompressorEnabled);
    assert(!finalStatus.nativePhaserEnabled);
    testNativeCatalogSlotsRunInsidePlaybackCallback();
    testNativeDubModeCallbackAckPcmAndUndoCancellation();
    testNativeDubModeCannotOvertakePendingTrackCommands();
    testNativeLoopTransportAndTrackCommandsShareAdmissionOrder();
    testNativeBounceSumsBlockStableSourcesExcludesSelfAndIgnoresInactiveTracks();
    testNativeBounceUsesOverdubbingSourcePreviewWithoutOrderDependentAdvance();
    testNativeInputCatalogBankProcessesBeforeRecordAndMonitor();
    testNativeProjectArchiveImportIsAtomicAndReclaimsOnControlThread();
    return 0;
#endif
}
