#include "native_audio_core.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <iostream>
#include <map>
#include <string>
#include <thread>
#include <vector>

#if defined(__linux__)
#include <sys/resource.h>
#include <sys/utsname.h>
#endif

using namespace webrc::native;

constexpr std::size_t kLoopCapacitySeconds = 300U;

namespace webrc::native {

// Private access is deliberately confined to this opt-in benchmark executable;
// the production audio API and bridge are unchanged.
struct NativeAudioCoreTestAccess {
    static bool prepareWithoutDevice(NativeAudioCore& core) {
        EngineConfig config;
        config.sampleRate = 48000U;
        config.bufferFrames = 64U;
        core.currentConfig_ = config;
        if (!core.looper_.prepare(config.sampleRate, kLoopCapacitySeconds, 2U)) return false;
        for (auto& track : core.additionalLoopers_) {
            if (!track.prepare(config.sampleRate, kLoopCapacitySeconds, 2U)) return false;
        }
        core.nativeLooperMaxRecordSeconds_ = kLoopCapacitySeconds;
        core.nativeLooperPreallocatedBytes_ = core.looper_.storageBytes();
        for (const auto& track : core.additionalLoopers_) core.nativeLooperPreallocatedBytes_ += track.storageBytes();
        if (!core.outputStage_.prepare(config.sampleRate) || !core.nativeInputFxBank_.prepare(config.sampleRate) ||
            !core.nativePitchProcessor_.prepare(config.sampleRate, 70.0f, 1200.0f) ||
            !core.nativePolyPitchProcessor_.prepare(config.sampleRate) ||
            !core.nativeRhythmEngine_.prepare(config.sampleRate) ||
            !core.nativeRhythmEngine_.setConfig(core.nativeRhythmConfig_, 0U)) return false;
        return true;
    }

    static bool enqueue(NativeAudioCore& core, CommandType type, std::size_t track) {
        return track < kNativeTrackCount && core.commandQueue_.push({type, false, static_cast<std::uint8_t>(track)});
    }

    static int callback(NativeAudioCore& core, const float* input, float* output, unsigned int frames) {
        return NativeAudioCore::audioCallback(
            output, const_cast<float*>(input), frames, 0.0, static_cast<RtAudioStreamStatus>(0), &core);
    }
};

} // namespace webrc::native

namespace {
constexpr unsigned int kSampleRate = 48000U;
constexpr unsigned int kFrames = 64U;
constexpr unsigned int kCaptureFrames = 4096U;
constexpr double kCallbackPeriodNs = 1'000'000'000.0 * static_cast<double>(kFrames) / kSampleRate;
constexpr std::size_t kWarmupCallbacks = 5000U;
constexpr std::size_t kMeasuredCallbacks = 100000U;

std::uint64_t rssKiB() noexcept {
#if defined(__linux__)
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) == 0) return static_cast<std::uint64_t>(usage.ru_maxrss);
#endif
    return 0U;
}

std::uint64_t observedClockQuantumNs() noexcept {
    auto previous = std::chrono::steady_clock::now();
    std::uint64_t minimum = std::numeric_limits<std::uint64_t>::max();
    for (std::size_t read = 0U; read < 50000U; ++read) {
        const auto current = std::chrono::steady_clock::now();
        const auto delta = std::chrono::duration_cast<std::chrono::nanoseconds>(current - previous).count();
        if (delta > 0) minimum = std::min(minimum, static_cast<std::uint64_t>(delta));
        previous = current;
    }
    return minimum == std::numeric_limits<std::uint64_t>::max() ? 0U : minimum;
}

std::string platformName() {
#if defined(__linux__)
    utsname info{};
    if (uname(&info) == 0) return std::string(info.sysname) + " " + info.release + " " + info.machine;
#endif
    return "unknown-platform";
}

double quantile(std::vector<std::uint64_t> values, double q) {
    std::sort(values.begin(), values.end());
    if (values.empty()) return 0.0;
    const auto index = static_cast<std::size_t>(std::ceil(q * static_cast<double>(values.size()))) - 1U;
    return static_cast<double>(values[std::min(index, values.size() - 1U)]);
}

bool recordAndStart(NativeAudioCore& core) {
    std::array<float, kCaptureFrames> mono{};
    std::array<float, kCaptureFrames * 2U> output{};
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        if (!NativeAudioCoreTestAccess::enqueue(core, CommandType::Record, track)) return false;
        const std::size_t totalFrames = static_cast<std::size_t>(kSampleRate) * kLoopCapacitySeconds;
        for (std::size_t baseFrame = 0U; baseFrame < totalFrames; baseFrame += kCaptureFrames) {
            for (unsigned int frame = 0U; frame < kCaptureFrames; ++frame) {
                const auto absoluteFrame = baseFrame + frame;
                mono[frame] = 0.2f * std::sin(static_cast<float>(2.0 * 3.14159265358979323846 *
                    (110.0 + static_cast<double>(track) * 55.0) * static_cast<double>(absoluteFrame) / kSampleRate));
            }
            if (NativeAudioCoreTestAccess::callback(core, mono.data(), output.data(), kCaptureFrames) != 0) return false;
        }
        if (!NativeAudioCoreTestAccess::enqueue(core, CommandType::StopRecordOrPlayback, track) ||
            NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), kCaptureFrames) != 0 ||
            !NativeAudioCoreTestAccess::enqueue(core, CommandType::Play, track) ||
            NativeAudioCoreTestAccess::callback(core, nullptr, output.data(), kCaptureFrames) != 0) return false;
    }
    return true;
}
} // namespace

int main() {
    NativeAudioCore core;
    if (!NativeAudioCoreTestAccess::prepareWithoutDevice(core) || !recordAndStart(core)) {
        std::cerr << "failed to prepare five synthetic stereo loop tracks\n";
        return 2;
    }
    const std::uint64_t rssBeforeFxKiB = rssKiB();

    // Exercise a five-track / four-slot workload with a mix of sustained,
    // delay-line, convolution-free reverb, and tempo-window processors.
    constexpr std::array<std::array<std::string_view, 4U>, kNativeTrackCount> effectIds{{
        {{"reverse_reverb", "reverse_delay", "warp", "granular_delay"}},
        {{"beat_scatter", "beat_repeat", "roll", "freeze"}},
        {{"reverb", "fractional_delay", "panning_delay", "tape_echo"}},
        {{"dist", "preamp", "dynamics", "flanger"}},
        {{"chorus", "vocoder", "robot", "electric"}},
    }};
    std::size_t configured = 0U;
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
            std::string error;
            if (!core.setNativeCatalogSlot(static_cast<NativeEffectSlot>(slot), std::string(effectIds[track][slot]),
                    {}, false, error, NativeCatalogFxPath::Track, static_cast<std::uint8_t>(track + 1U))) {
                std::cerr << "failed per-track effect setup t=" << (track + 1U) << " slot=" << slot
                          << " id=" << effectIds[track][slot] << " error=" << error << '\n';
                return 3;
            }
            ++configured;
        }
    }

    std::array<float, kFrames> input{};
    std::array<float, kFrames * 2U> output{};
    for (unsigned int frame = 0U; frame < kFrames; ++frame) {
        input[frame] = 0.1f * std::sin(static_cast<float>(2.0 * 3.14159265358979323846 * 330.0 * frame / kSampleRate));
    }
    std::uint64_t finiteSamples = 0U;
    double peak = 0.0;
    for (std::size_t block = 0U; block < kWarmupCallbacks; ++block) {
        if (NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), kFrames) != 0) return 4;
    }

    std::vector<std::uint64_t> durationsNs;
    durationsNs.reserve(kMeasuredCallbacks);
    std::size_t overBudget = 0U;
    const auto wallStart = std::chrono::steady_clock::now();
    for (std::size_t block = 0U; block < kMeasuredCallbacks; ++block) {
        const auto start = std::chrono::steady_clock::now();
        if (NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), kFrames) != 0) return 5;
        const auto end = std::chrono::steady_clock::now();
        const auto elapsed = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count());
        durationsNs.push_back(elapsed);
        if (static_cast<double>(elapsed) > kCallbackPeriodNs) ++overBudget;
        for (const float sample : output) {
            if (std::isfinite(sample)) ++finiteSamples;
            peak = std::max(peak, std::abs(static_cast<double>(sample)));
        }
    }
    const auto wallEnd = std::chrono::steady_clock::now();
    const auto elapsedMs = std::chrono::duration<double, std::milli>(wallEnd - wallStart).count();
    const auto stats = core.getStatus();
    const std::uint64_t rssAfterFxKiB = rssKiB();
    const std::uint64_t clockQuantumNs = observedClockQuantumNs();
    std::uint64_t callbackNsTotal = 0U;
    for (const auto duration : durationsNs) callbackNsTotal += duration;
    const double meanNs = static_cast<double>(callbackNsTotal) / static_cast<double>(durationsNs.size());

    std::cout << std::fixed << std::setprecision(3)
              << "{\"benchmark\":\"native_audio_core_per_track_fx_callback\","
              << "\"evidenceScope\":\"portable Linux CPU callback simulation; no RtAudio device, no hardware acceptance\","
              << "\"platform\":\"" << platformName() << "\",\"hardwareConcurrency\":"
              << std::thread::hardware_concurrency() << ",\"measurementClock\":\"std::chrono::steady_clock\","
              << "\"observedClockQuantumNs\":" << clockQuantumNs << ","
              << "\"sampleRate\":" << kSampleRate << ",\"framesPerCallback\":" << kFrames
              << ",\"callbackDeadlineNs\":" << kCallbackPeriodNs
              << ",\"loopCapacitySecondsPerTrack\":" << kLoopCapacitySeconds
              << ",\"loopTracks\":" << kNativeTrackCount << ",\"configuredPerTrackFxSlots\":" << configured
              << ",\"warmupCallbacks\":" << kWarmupCallbacks << ",\"measuredCallbacks\":" << durationsNs.size()
              << ",\"callbackMeanNs\":" << meanNs << ",\"callbackP50Ns\":" << quantile(durationsNs, 0.50)
              << ",\"callbackP95Ns\":" << quantile(durationsNs, 0.95) << ",\"callbackP99Ns\":" << quantile(durationsNs, 0.99)
              << ",\"callbackP999Ns\":" << quantile(durationsNs, 0.999)
              << ",\"callbackMaxNs\":" << *std::max_element(durationsNs.begin(), durationsNs.end())
              << ",\"callbacksOverDeadline\":" << overBudget << ",\"measuredWallMs\":" << elapsedMs
              << ",\"finiteOutputSamples\":" << finiteSamples << ",\"expectedOutputSamples\":" << (durationsNs.size() * output.size())
              << ",\"outputPeak\":" << peak << ",\"reportedFaultedSlots\":";
    std::size_t faultedSlots = 0U;
    for (const auto& track : stats.nativePerTrackCatalogSlots) {
        for (const auto& slot : track) if (slot.processingFaulted || !slot.prepared) ++faultedSlots;
    }
    std::cout << faultedSlots << ",\"fxIdsByTrack\":[";
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        if (track != 0U) std::cout << ',';
        std::cout << '[';
        for (std::size_t slot = 0U; slot < NativeEffectBank::kSlotCount; ++slot) {
            if (slot != 0U) std::cout << ',';
            std::cout << '"' << effectIds[track][slot] << '"';
        }
        std::cout << ']';
    }
    std::cout << "],\"nativeLoopBuffersBytes\":" << stats.nativeLooperPreallocatedBytes
              << ",\"loopStorageBudgetBytes\":" << stats.nativeLooperStorageBudgetBytes
              << ",\"rssBeforeFxSetupKiB\":" << rssBeforeFxKiB
              << ",\"rssAfterFxAndCallbacksKiB\":" << rssAfterFxKiB
              << ",\"rssDeltaKiB\":" << (rssAfterFxKiB >= rssBeforeFxKiB ? rssAfterFxKiB - rssBeforeFxKiB : 0U)
              << ",\"rssMetric\":\"getrusage ru_maxrss high-water mark, KiB on Linux; includes loop store and runtime; not PSS\"}\n";
    return finiteSamples == durationsNs.size() * output.size() && faultedSlots == 0U ? 0 : 6;
}
