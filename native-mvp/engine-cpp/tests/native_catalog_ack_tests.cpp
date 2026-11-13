#include "native_audio_core.hpp"
#include <array>
#include <cassert>
#include <iostream>
#include <memory>
namespace webrc::native {
struct NativeAudioCoreTestAccess {
    static void prepare(NativeAudioCore& c) {
        EngineConfig config; config.sampleRate = 48000; c.currentConfig_ = config;
        assert(c.nativeInputFxBank_.prepare(48000)); assert(c.outputStage_->prepare(48000));
    }
    static void running(NativeAudioCore& c, bool v) { c.engineRunning_.store(v); }
    static void drain(NativeAudioCore& c) { c.applyNativeCatalogFxCommands(); }
    static void unavailableSharedOutput(NativeAudioCore& c) {
        (void)c.processNativeTracksForCallback(nullptr, nullptr, 1U, 1U, nullptr);
    }
    static void processSharedFault(NativeAudioCore& c, bool input) {
        auto& bank = input ? c.nativeInputFxBank_ : c.outputStage_->trackFxBank();
        auto* processor = bank.processor(NativeEffectSlot::A);
        assert(processor != nullptr);
        std::array<float, 128> samples{};
        // Real HRM AUTO adapter rejects a three-channel block and latches its fault.
        (void)processor->processInPlace(samples.data(), 1U, 3U);
        assert(processor->processingFaulted());
        if (input) (void)c.processInputFxForCallback(samples.data(), 1U);
        else (void)c.processNativeTracksForCallback(nullptr, samples.data(), 1U, 1U, nullptr);
    }
    static void corrupt(NativeAudioCore& c) {
        std::array<NativeCatalogFxCommand, 64> commands{}; std::size_t count = 0;
        while (c.nativeCatalogFxCommandQueue_.pop(commands[count])) ++count;
        assert(count >= 2); commands[0].parameterIndex = 250;
        for (std::size_t i = 0; i < count; ++i) assert(c.nativeCatalogFxCommandQueue_.push(commands[i]));
    }
};
}
int main() {
    using namespace webrc::native;
    auto ownedCore = std::make_unique<NativeAudioCore>();
    auto& core = *ownedCore; NativeAudioCoreTestAccess::prepare(core); std::string error;
    for (unsigned bank = 0; bank < 7; ++bank) {
        const auto path = bank == 0 ? NativeCatalogFxPath::Input : NativeCatalogFxPath::Track;
        const auto track = static_cast<std::uint8_t>(bank < 2 ? 0 : bank - 1);
        for (unsigned index = 0; index < 4; ++index) {
            const auto slot = static_cast<NativeEffectSlot>(index);
            const auto read = [&](const EngineStatus& status) {
                return bank == 0 ? status.nativeInputCatalogSlots[index] : bank == 1 ? status.nativeCatalogSlots[index]
                    : status.nativePerTrackCatalogSlots[track - 1][index];
            };
            assert(core.setNativeCatalogSlot(slot, "filter.lpf", {{"cutoff_hz", 1000.0f}}, false, error, path, track, true));
            const auto before = read(core.getStatus());
            assert(before.appliedRevision > 0 && before.appliedRevision == before.requestedRevision);
            assert(before.parameters.at("cutoff_hz") == 1000 && before.prepared);
            NativeAudioCoreTestAccess::running(core, true);
            assert(core.setNativeCatalogSlot(slot, "filter.lpf", {{"cutoff_hz", 2000.0f}}, true, error, path, track, true));
            const auto pending = read(core.getStatus());
            assert(pending.requestedRevision == before.requestedRevision + 1 && pending.appliedRevision == before.appliedRevision);
            assert(pending.parameters.at("cutoff_hz") == 2000 && pending.bypassed && !pending.appliedBypassed);
            NativeAudioCoreTestAccess::drain(core);
            const auto applied = read(core.getStatus());
            assert(applied.appliedRevision == pending.requestedRevision && applied.appliedBypassed && !applied.controlFaulted);
            // Both occupied and already-empty slots retain the live clear rejection.
            assert(!core.setNativeCatalogSlot(slot, "", {}, false, error, path, track));
            NativeAudioCoreTestAccess::running(core, false);
        }
    }
    NativeAudioCoreTestAccess::running(core, true);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "filter.lpf", {{"cutoff_hz", 3000.0f}}, false,
        error, NativeCatalogFxPath::Input, 0, true));
    const auto revision = core.getStatus().nativeInputCatalogSlots[0].requestedRevision;
    NativeAudioCoreTestAccess::corrupt(core); NativeAudioCoreTestAccess::drain(core);
    const auto failed = core.getStatus().nativeInputCatalogSlots[0];
    assert(failed.controlFaulted && failed.appliedRevision != revision);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "filter.lpf", {{"cutoff_hz", 4000.0f}}, false,
        error, NativeCatalogFxPath::Input, 0, true));
    NativeAudioCoreTestAccess::drain(core);
    const auto retried = core.getStatus().nativeInputCatalogSlots[0];
    assert(!retried.controlFaulted && retried.appliedRevision == revision + 1);
    assert(retried.parameters.at("cutoff_hz") == 4000);
    NativeAudioCoreTestAccess::running(core, false);
    assert(core.setNativeCatalogSlot(NativeEffectSlot::B, "", {}, false, error, NativeCatalogFxPath::Input));
    NativeAudioCoreTestAccess::running(core, true);
    assert(!core.setNativeCatalogSlot(NativeEffectSlot::B, "", {}, false, error, NativeCatalogFxPath::Input));
    NativeAudioCoreTestAccess::running(core, false);
    // Shared Track has the same unavailable-playback-buffer fault contract as private banks.
    NativeAudioCoreTestAccess::unavailableSharedOutput(core);
    assert(core.getStatus().nativeCatalogSlots[0].processingFaulted);
    assert(!core.getStatus().nativeInputCatalogSlots[0].processingFaulted);
    for (bool input : {true, false}) {
        const auto path = input ? NativeCatalogFxPath::Input : NativeCatalogFxPath::Track;
        assert(core.setNativeCatalogSlot(NativeEffectSlot::A, "hrm_auto_m", {}, false, error, path));
        NativeAudioCoreTestAccess::running(core, true);
        NativeAudioCoreTestAccess::processSharedFault(core, input);
        const auto status = core.getStatus();
        const auto& slot = input ? status.nativeInputCatalogSlots[0] : status.nativeCatalogSlots[0];
        assert(slot.requestedRevision == slot.appliedRevision && slot.processingFaulted);
        // Matching control revisions alone must not certify a faulted processor.
        const bool exactAck = slot.requestedRevision == slot.appliedRevision && slot.prepared &&
            !slot.controlFaulted && !slot.processingFaulted;
        assert(!exactAck);
        NativeAudioCoreTestAccess::running(core, false);
    }
    std::cout << "28 slots: pending, callback ACK, fault, and clear contracts passed\n";
}
