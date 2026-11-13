// Device-free AUTO REC callback benchmark. CPU deadline exceedances are not hardware XRUNs.
#include "native_audio_core.hpp"
#include "native_alloc_tracker.hpp"
#include "native_benchmark_access.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <exception>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using namespace webrc::native;

namespace {
bool runCase(const char* name, unsigned rate, unsigned frames, unsigned count,
             bool enabled, unsigned armedTracks, bool trigger) {
    auto coreOwner = std::make_unique<NativeAudioCore>();
    auto& core = *coreOwner;
    if (!NativeAudioCoreTestAccess::prepare(core, rate, frames, 2U, 1U)) return false;
    NativeAudioCoreTestAccess::setRunning(core, true);
    std::vector<float> input(frames * 2U, 0.01f), output(frames * 2U, 0.0f);
    std::string error;
    auto callback = [&]() { return NativeAudioCoreTestAccess::run(core, input.data(), output.data(), frames) == 0; };
    // These settings are applied synchronously, unlike AUTO REC settings/arm.
    if (!core.setRecordQuantizeMeasure(false, error)) return false;
    for (unsigned track = 0; track < kNativeTrackCount; ++track)
        if (!core.setTrackLoopSync(track, false, error)) return false;
    if (!callback()) return false;
    const auto initialStatus = core.getStatus();
    if (initialStatus.nativeRecordQuantizeMeasure) return false;
    for (unsigned track = 0; track < kNativeTrackCount; ++track)
        if (initialStatus.nativeLoopSync[track]) return false;
    if (enabled) {
        std::uint64_t revision = 0U;
        if (!core.setNativeAutoRecSettings(true, 1U, 0U, revision, error) || !callback()) return false;
        const auto status = core.getStatus();
        if (!status.nativeAutoRecEnabled || status.nativeAutoRecAppliedRevision != revision) return false;
    } else if (core.getStatus().nativeAutoRecEnabled) return false;

    auto arm = [&](unsigned track) {
        const auto before = core.getStatus();
        const auto previous = before.nativeAutoRecArmRequestedRevision[track];
        char intent[33];
        std::snprintf(intent, sizeof(intent), "%032llx", static_cast<unsigned long long>(previous + 1U));
        std::uint64_t accepted = 0U;
        bool duplicate = false;
        if (!core.armNativeAutoRec(track, intent, previous, accepted, duplicate, error) || duplicate || accepted != previous + 1U) return false;
        return true;
    };
    for (unsigned track = 0; track < armedTracks; ++track) if (!arm(track)) return false;
    if (!callback()) return false;
    auto status = core.getStatus();
    for (unsigned track = 0; track < armedTracks; ++track) {
        if (!status.nativeAutoRecArmed[track] ||
            status.nativeAutoRecArmAppliedRevision[track] != status.nativeAutoRecArmRequestedRevision[track] ||
            status.nativeAutoRecTriggerAppliedRevision[track] != 0U) return false;
    }
    // Warm only the steady-state paths. Trigger iterations rearm outside the measured interval.
    for (unsigned i = 0; i < 256U; ++i) if (!callback()) return false;
    std::vector<double> timings;
    timings.reserve(count);
    const double budget = 1e9 * frames / rate;
    unsigned over = 0U;
    double sum = 0.0;
    const auto allocationsBefore = test_alloc::count();
    for (unsigned i = 0; i < count; ++i) {
        if (trigger) input[(frames - 1U) * 2U + 1U] = 0.5f; // sensitivity 1 threshold is about 0.251
        test_alloc::beginTracking();
        const auto begin = std::chrono::steady_clock::now();
        const int result = NativeAudioCoreTestAccess::run(core, input.data(), output.data(), frames);
        const auto end = std::chrono::steady_clock::now();
        test_alloc::endTracking();
        if (result != 0) return false;
        const double ns = std::chrono::duration<double, std::nano>(end - begin).count();
        timings.push_back(ns); sum += ns; if (ns > budget) ++over;
        if (trigger) {
            status = core.getStatus();
            if (status.nativeTrackStates[0] != LooperState::Recording || status.nativeAutoRecArmed[0] ||
                status.nativeAutoRecTriggerAppliedRevision[0] != status.nativeAutoRecArmRequestedRevision[0] ||
                NativeAudioCoreTestAccess::recordedFrames(core, 0U) != 1U) return false;
            input[(frames - 1U) * 2U + 1U] = 0.01f;
            if (!core.clearTrack(0U, error) || !callback() || core.getStatus().nativeTrackStates[0] != LooperState::Empty ||
                !arm(0U) || !callback()) return false;
            status = core.getStatus();
            if (!status.nativeAutoRecArmed[0] || status.nativeAutoRecArmAppliedRevision[0] != status.nativeAutoRecArmRequestedRevision[0]) return false;
        }
    }
    status = core.getStatus();
    for (unsigned track = 0; track < armedTracks; ++track) {
        if (!status.nativeAutoRecArmed[track] || status.nativeTrackStates[track] != LooperState::Empty) return false;
    }
    const auto allocations = test_alloc::count() - allocationsBefore;
    std::sort(timings.begin(), timings.end());
    auto percentile = [&](double p) { return timings[static_cast<std::size_t>(std::ceil(p * static_cast<double>(timings.size()))) - 1U]; };
    std::cout << "{\"case\":\"" << name << "\",\"sampleRate\":" << rate << ",\"frames\":" << frames
              << ",\"inputChannels\":2,\"callbacks\":" << count << ",\"armedTracks\":" << armedTracks
              << ",\"meanNs\":" << sum / count << ",\"p50Ns\":" << percentile(0.5)
              << ",\"p95Ns\":" << percentile(0.95) << ",\"p99Ns\":" << percentile(0.99) << ",\"p999Ns\":" << percentile(0.999)
              << ",\"maxNs\":" << timings.back() << ",\"budgetNs\":" << budget
              << ",\"cpuBudgetExceedances\":" << over << ",\"callbackAllocations\":" << allocations
              << ",\"scope\":\"device-free callback; CPU exceedances are not hardware XRUNs\"}" << std::endl;
    NativeAudioCoreTestAccess::setRunning(core, false);
    return allocations == 0U;
}
}

int main(int argc, char** argv) {
    try {
        const auto rateArg = argc > 1 ? std::stoul(argv[1]) : 48000UL;
        const auto framesArg = argc > 2 ? std::stoul(argv[2]) : 64UL;
        const auto countArg = argc > 3 ? std::stoul(argv[3]) : 3000UL;
        if (rateArg > 48000UL || framesArg > 256UL || countArg > 1000000UL) return 1;
        const auto rate = static_cast<unsigned>(rateArg);
        const auto frames = static_cast<unsigned>(framesArg);
        const auto count = static_cast<unsigned>(countArg);
        if ((rate != 44100U && rate != 48000U) || (frames != 64U && frames != 128U && frames != 256U) || count == 0U) return 1;
        if (!runCase("off", rate, frames, count, false, 0U, false) ||
            !runCase("on_unarmed", rate, frames, count, true, 0U, false) ||
            !runCase("armed_1_below_threshold", rate, frames, count, true, 1U, false) ||
            !runCase("armed_5_below_threshold", rate, frames, count, true, 5U, false) ||
            !runCase("armed_1_trigger_last_frame", rate, frames, count, true, 1U, true)) {
            std::cerr << "AUTO REC callback benchmark setup, state, callback or allocation check failed\n";
            return 2;
        }
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n'; return 1;
    }
    return 0;
}
