#include "native_audio_core.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <limits>
#include <iostream>
#include <map>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#if defined(__linux__)
#include <sys/resource.h>
#include <sys/utsname.h>
#endif

#if defined(NATIVE_BENCH_GPROF_CALLBACK_ONLY)
extern "C" void moncontrol(int mode);
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

    static bool configureCatalogSlot(
        NativeAudioCore& core,
        NativeEffectSlot slot,
        std::string_view effectId,
        NativeCatalogFxPath path,
        std::uint8_t trackId,
        std::string& error
    ) {
        return core.setNativeCatalogSlot(slot, std::string(effectId), {}, false, error, path, trackId);
    }

    static bool slotReady(
        const NativeAudioCore& core,
        NativeEffectSlot slot,
        std::string_view effectId,
        NativeCatalogFxPath path,
        std::uint8_t trackId
    ) {
        const NativeEffectBank* bank = nullptr;
        if (path == NativeCatalogFxPath::Input) {
            bank = &core.nativeInputFxBank_;
        } else if (trackId == 0U) {
            bank = &core.outputStage_.trackFxBank();
        } else if (trackId <= kNativeTrackCount) {
            bank = &core.nativePerTrackFxBanks_[trackId - 1U];
        }
        if (bank == nullptr || bank->effectId(slot) != effectId || bank->isBypassed(slot)) return false;
        const auto* processor = bank->processor(slot);
        return processor != nullptr && processor->sampleRate() == 48000U &&
            !processor->isBypassed() && !processor->processingFaulted();
    }

    static bool configureRhythm(NativeAudioCore& core, const NativeRhythmConfig& config, std::string& error) {
        return core.setNativeRhythmConfig(config, error);
    }

    static bool rhythmEnabled(const NativeAudioCore& core) noexcept {
        return core.nativeRhythmEngine_.enabled();
    }

    static std::size_t activeRhythmVoices(const NativeAudioCore& core) noexcept {
        return core.nativeRhythmEngine_.activeVoiceCount();
    }

    static float inputFxScratchPeak(const NativeAudioCore& core, unsigned int frames) noexcept {
        float peak = 0.0f;
        for (std::size_t index = 0U; index < static_cast<std::size_t>(frames) * 2U; ++index) {
            peak = std::max(peak, std::fabs(core.nativeInputFxScratch_[index]));
        }
        return peak;
    }

    static bool monitoringEnabled(const NativeAudioCore& core) noexcept {
        return core.getStatus().monitoringEnabled;
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

enum class BenchTopology { Baseline, Extended, AllBanks };

struct BenchConfig {
    BenchTopology topology = BenchTopology::Baseline;
    std::size_t warmupCallbacks = kWarmupCallbacks;
    std::size_t measuredCallbacks = kMeasuredCallbacks;
};

struct BenchPitchConfig {
    enum class Mode { Off, LiveMono, LivePoly } mode = Mode::Off;
    std::uint8_t trackId = 1U;
    float semitones = 7.0f;
};

const char* pitchModeName(BenchPitchConfig::Mode mode) noexcept {
    switch (mode) {
    case BenchPitchConfig::Mode::Off: return "off";
    case BenchPitchConfig::Mode::LiveMono: return "live-mono";
    case BenchPitchConfig::Mode::LivePoly: return "live-poly";
    }
    return "unknown";
}

const char* topologyName(BenchTopology topology) noexcept {
    switch (topology) {
    case BenchTopology::Baseline: return "baseline-20-private";
    case BenchTopology::Extended: return "extended-20-private-1-input-1-shared-rhythm";
    case BenchTopology::AllBanks: return "all-banks-20-private-4-input-4-shared-rhythm";
    }
    return "unknown";
}

const char* pitchFallbackName(NativePitchFallbackReason reason) noexcept {
    switch (reason) {
    case NativePitchFallbackReason::None: return "none";
    case NativePitchFallbackReason::NotRequested: return "notRequested";
    case NativePitchFallbackReason::ProcessorNotPrepared: return "processorNotPrepared";
    case NativePitchFallbackReason::PlaybackBufferUnavailable: return "playbackBufferUnavailable";
    case NativePitchFallbackReason::ReversePlayback: return "reversePlayback";
    case NativePitchFallbackReason::UnsupportedChannelCount: return "unsupportedChannelCount";
    case NativePitchFallbackReason::LoopShorterThanLatency: return "loopShorterThanLatency";
    }
    return "unknown";
}

bool parseUnsigned(std::string_view text, unsigned int& result) noexcept {
    if (text.empty()) return false;
    const auto parsed = std::from_chars(text.data(), text.data() + text.size(), result);
    return parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size();
}

bool parseFloat(std::string_view text, float& result) noexcept {
    if (text.empty()) return false;
    std::string copy(text);
    char* end = nullptr;
    result = std::strtof(copy.c_str(), &end);
    return end == copy.c_str() + copy.size() && std::isfinite(result);
}

bool parseArgs(int argc, char** argv, BenchPitchConfig& pitchConfig, BenchConfig& benchConfig) {
    for (int index = 1; index < argc; ++index) {
        const std::string_view argument(argv[index]);
        if (argument.rfind("--pitch=", 0U) == 0U) {
            const auto value = argument.substr(8U);
            if (value == "off") pitchConfig.mode = BenchPitchConfig::Mode::Off;
            else if (value == "live-mono") pitchConfig.mode = BenchPitchConfig::Mode::LiveMono;
            else if (value == "live-poly") pitchConfig.mode = BenchPitchConfig::Mode::LivePoly;
            else return false;
        } else if (argument.rfind("--pitch-track=", 0U) == 0U) {
            unsigned int track = 0U;
            if (!parseUnsigned(argument.substr(14U), track) || track < 1U || track > kNativeTrackCount) return false;
            pitchConfig.trackId = static_cast<std::uint8_t>(track);
        } else if (argument.rfind("--pitch-semitones=", 0U) == 0U) {
            if (!parseFloat(argument.substr(18U), pitchConfig.semitones) ||
                pitchConfig.semitones < -12.0f || pitchConfig.semitones > 12.0f) return false;
        } else if (argument.rfind("--topology=", 0U) == 0U) {
            const auto value = argument.substr(11U);
            if (value == "baseline") benchConfig.topology = BenchTopology::Baseline;
            else if (value == "extended") benchConfig.topology = BenchTopology::Extended;
            else if (value == "all-banks") benchConfig.topology = BenchTopology::AllBanks;
            else return false;
        } else if (argument.rfind("--warmup-callbacks=", 0U) == 0U) {
            unsigned int callbacks = 0U;
            if (!parseUnsigned(argument.substr(19U), callbacks) || callbacks > 1'000'000U) return false;
            benchConfig.warmupCallbacks = callbacks;
        } else if (argument.rfind("--measured-callbacks=", 0U) == 0U) {
            unsigned int callbacks = 0U;
            if (!parseUnsigned(argument.substr(21U), callbacks) || callbacks == 0U || callbacks > 1'000'000U) return false;
            benchConfig.measuredCallbacks = callbacks;
        } else {
            return false;
        }
    }
    return true;
}

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

int main(int argc, char** argv) {
#if defined(NATIVE_BENCH_GPROF_CALLBACK_ONLY)
    // Keep profile samples focused on the measured workload. In particular, loop
    // materialization and warmup must not dominate the report for the measured
    // steady-playback workload.
    moncontrol(0);
#endif
    BenchPitchConfig pitchConfig;
    BenchConfig benchConfig;
    if (!parseArgs(argc, argv, pitchConfig, benchConfig)) {
        std::cerr << "usage: native_per_track_fx_bench [--pitch=off|live-mono|live-poly] "
                     "[--pitch-track=1..5] [--pitch-semitones=-12..12] "
                     "[--topology=baseline|extended|all-banks] "
                     "[--warmup-callbacks=0..1000000 (rhythm topologies need enough warmup to observe a hit)] "
                     "[--measured-callbacks=1..1000000]\n";
        return 1;
    }
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
    constexpr std::array<std::string_view, NativeEffectBank::kSlotCount> allInputFxIds{{
        "filter.lpf", "manual_pan", "dynamics", "radio",
    }};
    constexpr std::array<std::string_view, NativeEffectBank::kSlotCount> allSharedFxIds{{
        "chorus", "reverb", "tape_echo", "stereo_enhance",
    }};
    constexpr std::array<std::string_view, 1U> extendedInputFxIds{{"filter.lpf"}};
    constexpr std::array<std::string_view, 1U> extendedSharedFxIds{{"chorus"}};
    const std::size_t inputFxConfigured = benchConfig.topology == BenchTopology::AllBanks
        ? NativeEffectBank::kSlotCount
        : benchConfig.topology == BenchTopology::Extended ? 1U : 0U;
    const std::size_t sharedFxConfigured = inputFxConfigured;
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

    std::array<std::string_view, NativeEffectBank::kSlotCount> inputFxIds{};
    std::array<std::string_view, NativeEffectBank::kSlotCount> sharedFxIds{};
    if (benchConfig.topology == BenchTopology::AllBanks) {
        inputFxIds = allInputFxIds;
        sharedFxIds = allSharedFxIds;
    } else if (benchConfig.topology == BenchTopology::Extended) {
        inputFxIds[0] = extendedInputFxIds[0];
        sharedFxIds[0] = extendedSharedFxIds[0];
    }
    for (std::size_t slotIndex = 0U; slotIndex < inputFxConfigured; ++slotIndex) {
        std::string error;
        if (!NativeAudioCoreTestAccess::configureCatalogSlot(core, static_cast<NativeEffectSlot>(slotIndex),
                inputFxIds[slotIndex], NativeCatalogFxPath::Input, 0U, error)) {
            std::cerr << "failed Input effect setup slot=" << slotIndex << " id=" << inputFxIds[slotIndex]
                      << " error=" << error << '\n';
            return 3;
        }
    }
    for (std::size_t slotIndex = 0U; slotIndex < sharedFxConfigured; ++slotIndex) {
        std::string error;
        if (!NativeAudioCoreTestAccess::configureCatalogSlot(core, static_cast<NativeEffectSlot>(slotIndex),
                sharedFxIds[slotIndex], NativeCatalogFxPath::Track, 0U, error)) {
            std::cerr << "failed shared playback effect setup slot=" << slotIndex << " id=" << sharedFxIds[slotIndex]
                      << " error=" << error << '\n';
            return 3;
        }
    }
    const bool rhythmRequested = benchConfig.topology != BenchTopology::Baseline;
    if (rhythmRequested) {
        NativeRhythmConfig rhythm;
        rhythm.enabled = true;
        rhythm.bpm = 120.0;
        rhythm.kitIndex = 1U;
        rhythm.patternIndex = 1U;
        rhythm.variation = NativeRhythmVariation::A;
        rhythm.section = NativeRhythmSection::Main;
        rhythm.swingPercent = 50U;
        rhythm.quantizeGrid = NativeRhythmQuantizeGrid::Sixteenth;
        rhythm.volume = 70U;
        std::string error;
        if (!NativeAudioCoreTestAccess::configureRhythm(core, rhythm, error)) {
            std::cerr << "failed to enable rhythm for benchmark topology: " << error << '\n';
            return 3;
        }
    }

    if (pitchConfig.mode != BenchPitchConfig::Mode::Off) {
        NativePitchConfig nativePitch;
        nativePitch.enabled = true;
        nativePitch.trackId = pitchConfig.trackId;
        nativePitch.mode = pitchConfig.mode == BenchPitchConfig::Mode::LivePoly
            ? NativePitchMode::LivePolyPhaseVocoder : NativePitchMode::LiveMonoKeepPitch;
        nativePitch.semitones = pitchConfig.semitones;
        std::string error;
        if (!core.setNativePitchConfig(nativePitch, error)) {
            std::cerr << "failed to enable pitch mode " << pitchModeName(pitchConfig.mode)
                      << " track=" << static_cast<unsigned int>(pitchConfig.trackId)
                      << " semitones=" << pitchConfig.semitones << " error=" << error << '\n';
            return 3;
        }
    }

    std::array<float, kFrames> input{};
    std::array<float, kFrames * 2U> output{};
    for (unsigned int frame = 0U; frame < kFrames; ++frame) {
        input[frame] = 0.1f * std::sin(static_cast<float>(2.0 * 3.14159265358979323846 * 330.0 * frame / kSampleRate));
    }
    double inputPeak = 0.0;
    for (const float sample : input) inputPeak = std::max(inputPeak, std::abs(static_cast<double>(sample)));
    if (!(inputPeak > 0.0)) {
        std::cerr << "synthetic benchmark input unexpectedly silent\n";
        return 4;
    }
    std::uint64_t finiteSamples = 0U;
    double peak = 0.0;
    double inputFxOutputPeak = 0.0;
    std::size_t rhythmObservedActiveVoicesMax = 0U;
    for (std::size_t block = 0U; block < benchConfig.warmupCallbacks; ++block) {
        if (NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), kFrames) != 0) return 4;
        if (inputFxConfigured != 0U) {
            inputFxOutputPeak = std::max(inputFxOutputPeak,
                static_cast<double>(NativeAudioCoreTestAccess::inputFxScratchPeak(core, kFrames)));
        }
        if (rhythmRequested) {
            rhythmObservedActiveVoicesMax = std::max(rhythmObservedActiveVoicesMax,
                NativeAudioCoreTestAccess::activeRhythmVoices(core));
        }
    }
    const auto warmupStatus = core.getStatus();
    const bool pitchRouteActive = pitchConfig.mode != BenchPitchConfig::Mode::Off && warmupStatus.nativePitchActive;
    if (pitchConfig.mode != BenchPitchConfig::Mode::Off &&
        (!pitchRouteActive || warmupStatus.nativePitchFallbackReason != NativePitchFallbackReason::None)) {
        std::cerr << "requested pitch route inactive after warmup; active=" << pitchRouteActive
                  << " fallback=" << pitchFallbackName(warmupStatus.nativePitchFallbackReason) << '\n';
        return 4;
    }

    bool topologyRoutesReady = !warmupStatus.monitoringEnabled &&
        NativeAudioCoreTestAccess::rhythmEnabled(core) == rhythmRequested &&
        warmupStatus.nativeRhythmEnabled == rhythmRequested;
    for (std::size_t slotIndex = 0U; slotIndex < inputFxConfigured; ++slotIndex) {
        topologyRoutesReady = topologyRoutesReady && NativeAudioCoreTestAccess::slotReady(core,
            static_cast<NativeEffectSlot>(slotIndex), inputFxIds[slotIndex], NativeCatalogFxPath::Input, 0U);
    }
    for (std::size_t slotIndex = 0U; slotIndex < sharedFxConfigured; ++slotIndex) {
        topologyRoutesReady = topologyRoutesReady && NativeAudioCoreTestAccess::slotReady(core,
            static_cast<NativeEffectSlot>(slotIndex), sharedFxIds[slotIndex], NativeCatalogFxPath::Track, 0U);
    }
    for (std::size_t track = 0U; track < kNativeTrackCount; ++track) {
        for (std::size_t slotIndex = 0U; slotIndex < NativeEffectBank::kSlotCount; ++slotIndex) {
            topologyRoutesReady = topologyRoutesReady && NativeAudioCoreTestAccess::slotReady(core,
                static_cast<NativeEffectSlot>(slotIndex), effectIds[track][slotIndex], NativeCatalogFxPath::Track,
                static_cast<std::uint8_t>(track + 1U));
        }
    }
    if (inputFxConfigured != 0U && !(inputFxOutputPeak > 1.0e-8)) topologyRoutesReady = false;
    if (rhythmRequested && rhythmObservedActiveVoicesMax == 0U) topologyRoutesReady = false;
    if (!topologyRoutesReady) {
        std::cerr << "requested topology failed runtime-route validation: topology=" << topologyName(benchConfig.topology)
                  << " inputFxOutputPeak=" << inputFxOutputPeak
                  << " rhythmEnabled=" << NativeAudioCoreTestAccess::rhythmEnabled(core)
                  << " observedActiveRhythmVoices=" << rhythmObservedActiveVoicesMax << '\n';
        return 4;
    }

    std::vector<std::uint64_t> durationsNs;
    durationsNs.reserve(benchConfig.measuredCallbacks);
    std::size_t overBudget = 0U;
    std::uint64_t outputHash = 14695981039346656037ULL;
    const auto wallStart = std::chrono::steady_clock::now();
#if defined(NATIVE_BENCH_GPROF_CALLBACK_ONLY)
    moncontrol(1);
#endif
    for (std::size_t block = 0U; block < benchConfig.measuredCallbacks; ++block) {
        const auto start = std::chrono::steady_clock::now();
        const int callbackStatus = NativeAudioCoreTestAccess::callback(core, input.data(), output.data(), kFrames);
        if (callbackStatus != 0) return 5;
        const auto end = std::chrono::steady_clock::now();
        const auto elapsed = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count());
        durationsNs.push_back(elapsed);
        if (static_cast<double>(elapsed) > kCallbackPeriodNs) ++overBudget;
        for (const float sample : output) {
            if (std::isfinite(sample)) ++finiteSamples;
            peak = std::max(peak, std::abs(static_cast<double>(sample)));
            std::uint32_t bits = 0U;
            std::memcpy(&bits, &sample, sizeof(bits));
            for (unsigned int byte = 0U; byte < sizeof(bits); ++byte) {
                outputHash ^= static_cast<std::uint8_t>(bits >> (byte * 8U));
                outputHash *= 1099511628211ULL;
            }
        }
    }
#if defined(NATIVE_BENCH_GPROF_CALLBACK_ONLY)
    moncontrol(0);
#endif
    const auto wallEnd = std::chrono::steady_clock::now();
    const auto elapsedMs = std::chrono::duration<double, std::milli>(wallEnd - wallStart).count();
    const auto stats = core.getStatus();
    const std::uint64_t rssAfterFxKiB = rssKiB();
    const std::uint64_t clockQuantumNs = observedClockQuantumNs();
    std::uint64_t callbackNsTotal = 0U;
    for (const auto duration : durationsNs) callbackNsTotal += duration;
    const double meanNs = static_cast<double>(callbackNsTotal) / static_cast<double>(durationsNs.size());
    std::size_t inputSharedFaultedSlots = 0U;
    for (std::size_t slotIndex = 0U; slotIndex < inputFxConfigured; ++slotIndex) {
        if (!NativeAudioCoreTestAccess::slotReady(core, static_cast<NativeEffectSlot>(slotIndex),
                inputFxIds[slotIndex], NativeCatalogFxPath::Input, 0U)) ++inputSharedFaultedSlots;
    }
    for (std::size_t slotIndex = 0U; slotIndex < sharedFxConfigured; ++slotIndex) {
        if (!NativeAudioCoreTestAccess::slotReady(core, static_cast<NativeEffectSlot>(slotIndex),
                sharedFxIds[slotIndex], NativeCatalogFxPath::Track, 0U)) ++inputSharedFaultedSlots;
    }
    const bool topologyRoutesHealthyAfterMeasure = inputSharedFaultedSlots == 0U &&
        !stats.monitoringEnabled &&
        NativeAudioCoreTestAccess::rhythmEnabled(core) == rhythmRequested &&
        (!rhythmRequested || rhythmObservedActiveVoicesMax > 0U);

    std::cout << std::fixed << std::setprecision(3)
              << "{\"benchmark\":\"native_audio_core_per_track_fx_callback\","
              << "\"evidenceScope\":\"portable Linux CPU callback simulation; no RtAudio device, no hardware acceptance\","
#if defined(NATIVE_BENCH_GPROF_CALLBACK_ONLY)
              << "\"profileScope\":\"GNU gprof samples enabled for the measured loop only (callback plus harness bookkeeping); instrumented diagnostic\","
#else
              << "\"profileScope\":\"unprofiled callback benchmark\","
#endif
              << "\"platform\":\"" << platformName() << "\",\"hardwareConcurrency\":"
              << std::thread::hardware_concurrency() << ",\"measurementClock\":\"std::chrono::steady_clock\","
              << "\"observedClockQuantumNs\":" << clockQuantumNs << ","
              << "\"sampleRate\":" << kSampleRate << ",\"framesPerCallback\":" << kFrames
              << ",\"topology\":\"" << topologyName(benchConfig.topology)
              << "\",\"topologyRoutesValidatedAfterWarmup\":true"
              << ",\"pitchMode\":\"" << pitchModeName(pitchConfig.mode) << "\",\"pitchEnabled\":"
              << (pitchConfig.mode != BenchPitchConfig::Mode::Off ? "true" : "false")
              << ",\"pitchTrackId\":" << static_cast<unsigned int>(pitchConfig.trackId)
              << ",\"pitchSemitones\":" << pitchConfig.semitones
              << ",\"pitchRouteActive\":" << (pitchRouteActive ? "true" : "false")
              << ",\"pitchFallbackReason\":\"" << pitchFallbackName(warmupStatus.nativePitchFallbackReason) << "\""
              << ",\"inputChannels\":1,\"outputChannels\":2,\"inputPeak\":" << inputPeak
              << ",\"inputMonitoringEnabled\":"
              << (NativeAudioCoreTestAccess::monitoringEnabled(core) ? "true" : "false")
              << ",\"inputFxSlotsConfigured\":" << inputFxConfigured
              << ",\"inputFxIds\":[";
    for (std::size_t slotIndex = 0U; slotIndex < inputFxConfigured; ++slotIndex) {
        if (slotIndex != 0U) std::cout << ',';
        std::cout << '"' << inputFxIds[slotIndex] << '"';
    }
    std::cout << "],\"inputFxOutputPeakDuringWarmup\":" << inputFxOutputPeak
              << ",\"inputSharedFaultedSlotsAfterMeasure\":" << inputSharedFaultedSlots
              << ",\"topologyRoutesHealthyAfterMeasure\":"
              << (topologyRoutesHealthyAfterMeasure ? "true" : "false")
              << ",\"sharedFxSlotsConfigured\":" << sharedFxConfigured << ",\"sharedFxIds\":[";
    for (std::size_t slotIndex = 0U; slotIndex < sharedFxConfigured; ++slotIndex) {
        if (slotIndex != 0U) std::cout << ',';
        std::cout << '"' << sharedFxIds[slotIndex] << '"';
    }
    std::cout << "],\"rhythmEnabled\":" << (rhythmRequested ? "true" : "false")
              << ",\"rhythmObservedActiveVoicesMaxDuringWarmup\":" << rhythmObservedActiveVoicesMax
              << ",\"callbackDeadlineNs\":" << kCallbackPeriodNs
              << ",\"loopCapacitySecondsPerTrack\":" << kLoopCapacitySeconds
              << ",\"loopTracks\":" << kNativeTrackCount << ",\"configuredPerTrackFxSlots\":" << configured
              << ",\"warmupCallbacks\":" << benchConfig.warmupCallbacks << ",\"measuredCallbacks\":" << durationsNs.size()
              << ",\"callbackMeanNs\":" << meanNs << ",\"callbackP50Ns\":" << quantile(durationsNs, 0.50)
              << ",\"callbackP95Ns\":" << quantile(durationsNs, 0.95) << ",\"callbackP99Ns\":" << quantile(durationsNs, 0.99)
              << ",\"callbackP999Ns\":" << quantile(durationsNs, 0.999)
              << ",\"callbackMaxNs\":" << *std::max_element(durationsNs.begin(), durationsNs.end())
              << ",\"callbacksOverDeadline\":" << overBudget << ",\"measuredWallMs\":" << elapsedMs
              << ",\"finiteOutputSamples\":" << finiteSamples << ",\"expectedOutputSamples\":" << (durationsNs.size() * output.size())
              << ",\"outputPeak\":" << peak << ",\"reportedPerTrackFaultedSlots\":";
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
              << ",\"outputHashFnv1a64\":\"0x" << std::hex << outputHash << std::dec << "\""
              << ",\"rssMetric\":\"getrusage ru_maxrss high-water mark, KiB on Linux; includes loop store and runtime; not PSS\"}\n";
    return finiteSamples == durationsNs.size() * output.size() && faultedSlots == 0U &&
        topologyRoutesHealthyAfterMeasure ? 0 : 6;
}
