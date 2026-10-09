#include "webrc/dsp/temporal_fx_adapters.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <vector>

std::atomic<bool> gTemporalWatchAllocations{false};
std::atomic<std::uint64_t> gTemporalAllocations{0U};
std::atomic<std::uint64_t> gTemporalDeallocations{0U};

void* operator new(std::size_t size) {
    if (gTemporalWatchAllocations.load(std::memory_order_relaxed))
        gTemporalAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (gTemporalWatchAllocations.load(std::memory_order_relaxed))
        gTemporalAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}

void operator delete(void* pointer) noexcept {
    if (pointer != nullptr && gTemporalWatchAllocations.load(std::memory_order_relaxed))
        gTemporalDeallocations.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}

void operator delete[](void* pointer) noexcept {
    if (pointer != nullptr && gTemporalWatchAllocations.load(std::memory_order_relaxed))
        gTemporalDeallocations.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}

void operator delete(void* pointer, std::size_t) noexcept { operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { operator delete[](pointer); }

namespace {

using namespace webrc::dsp;
constexpr std::uint32_t kFrames = 12288U;
constexpr double kPi = 3.141592653589793238462643383279502884;
int gFailures = 0;
double gMaximumPartitionDifference = 0.0;
std::array<double, 6> gEnergyLeft{};
std::array<double, 6> gEnergyRight{};
std::array<std::uint64_t, 6> gAllocations{};
std::uint32_t gTapeFirstEcho = 0U;
double gTapeNonlinearReferenceError = 0.0;
double gTapeOversampledAliasRatio = 0.0;
double gTapeReferenceBestFractionalDelay = 0.0;
double gTapeReferenceBestRms = 0.0;
double gTapeLateToEarlyTailEnergy = 0.0;
double gTapeTailPeak = 0.0;
double gTapeHighFeedbackEnergy = 0.0;
double gTapeLowFeedbackEnergy = 0.0;
double gFreezeLeftPeakHz = 0.0;
double gFreezeRightPeakHz = 0.0;
double gFreezeLeftLeakAmplitude = 0.0;
double gFreezeRightLeakAmplitude = 0.0;
std::array<std::uint32_t, 2> gStftWetImpulseFirst{};
std::uint32_t gRollCapturedFrames = 0U;

bool check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++gFailures;
    }
    return condition;
}

constexpr ProcessSpec makeSpec(std::uint32_t maxBlock = 256U, float sampleRate = 48000.0f) {
    return {sampleRate, maxBlock, 2U};
}

TemporalFxOptions makeOptions() {
    return {2.0f, 1.0f, 1024U, 256U};
}

TemporalFxEvent event(std::uint32_t frame, TemporalFxControl control, float value) {
    return {frame, control, value};
}

std::vector<TemporalFxEvent> schedule(TemporalFxKind kind) {
    switch (kind) {
    case TemporalFxKind::TapeEcho:
        return {event(0, TemporalFxControl::Active, 1.0f),
                event(0, TemporalFxControl::Wet, 0.92f),
                event(0, TemporalFxControl::DelayMs, 60.0f),
                event(0, TemporalFxControl::Feedback, 0.48f),
                event(0, TemporalFxControl::ToneHz, 5200.0f),
                event(0, TemporalFxControl::WowDepthMs, 2.5f),
                event(0, TemporalFxControl::WowRateHz, 0.71f),
                event(0, TemporalFxControl::Drive, 7.5f),
                event(4096, TemporalFxControl::Feedback, 0.24f),
                event(8192, TemporalFxControl::Drive, 4.0f)};
    case TemporalFxKind::GranularDelay:
        return {event(0, TemporalFxControl::Active, 1.0f),
                event(0, TemporalFxControl::Wet, 0.86f),
                event(0, TemporalFxControl::GrainMs, 170.0f),
                event(0, TemporalFxControl::DensityHz, 44.0f),
                event(0, TemporalFxControl::PitchRatio, 1.25f),
                event(0, TemporalFxControl::PositionSpread, 0.32f),
                event(0, TemporalFxControl::Feedback, 0.31f),
                event(8192, TemporalFxControl::Feedback, 0.05f)};
    case TemporalFxKind::Warp:
        return {event(0, TemporalFxControl::Active, 1.0f),
                event(0, TemporalFxControl::Wet, 0.9f),
                event(0, TemporalFxControl::WarpAmount, 0.8f),
                event(0, TemporalFxControl::ReverbTimeSeconds, 2.3f),
                event(0, TemporalFxControl::DampingHz, 5600.0f),
                event(4096, TemporalFxControl::Freeze, 1.0f),
                event(8192, TemporalFxControl::Freeze, 0.0f),
                event(9216, TemporalFxControl::Freeze, 1.0f)};
    case TemporalFxKind::Twist:
        return {event(0, TemporalFxControl::Active, 1.0f),
                event(0, TemporalFxControl::Wet, 0.88f),
                event(0, TemporalFxControl::DelayMs, 120.0f),
                event(0, TemporalFxControl::TwistMacro, 0.0f),
                event(4096, TemporalFxControl::TwistMacro, 0.55f),
                event(8192, TemporalFxControl::TwistMacro, -0.48f)};
    case TemporalFxKind::Roll:
        return {event(0, TemporalFxControl::Active, 1.0f),
                event(0, TemporalFxControl::Wet, 1.0f),
                event(0, TemporalFxControl::TempoBpm, 120.0f),
                event(0, TemporalFxControl::SubdivisionBeats, 0.125f),
                event(0, TemporalFxControl::Feedback, 0.42f),
                event(9216, TemporalFxControl::SubdivisionBeats, 0.25f)};
    case TemporalFxKind::Freeze:
        return {event(0, TemporalFxControl::Active, 1.0f),
                event(0, TemporalFxControl::Wet, 1.0f),
                event(3072, TemporalFxControl::Freeze, 1.0f),
                event(8192, TemporalFxControl::Freeze, 0.0f),
                event(9216, TemporalFxControl::Freeze, 1.0f)};
    }
    return {};
}

StereoFrame sourceFrame(std::uint64_t frame) {
    const double time = static_cast<double>(frame) / 48000.0;
    const float left = static_cast<float>(0.31 * std::sin(2.0 * kPi * 431.0 * time) +
                                          0.09 * std::sin(2.0 * kPi * 73.0 * time + 0.2));
    const float right = static_cast<float>(-0.24 * std::sin(2.0 * kPi * 997.0 * time + 0.31) +
                                           0.06 * std::sin(2.0 * kPi * 193.0 * time));
    return {left + (frame == 0U ? 0.8f : 0.0f), right + (frame == 200U ? -0.45f : 0.0f)};
}

struct RenderResult {
    std::vector<StereoFrame> audio;
    TemporalFxLatency latency{};
    std::uint32_t activeGrains = 0U;
    std::uint32_t repeatFrames = 0U;
    bool valid = false;
};

RenderResult render(TemporalFxKind kind, std::uint32_t blockFrames) {
    const auto spec = makeSpec();
    const auto options = makeOptions();
    TemporalFxAdapter processor;
    RenderResult result;
    result.audio.resize(kFrames);
    if (!check(TemporalFxAdapter::requiredPrepareBytes(spec, kind, options) > sizeof(processor),
               "kind reports nonzero bounded prepared memory")) return result;
    if (!check(processor.prepare(spec, kind, options), "temporal adapter prepares")) return result;
    if (kind == TemporalFxKind::GranularDelay)
        check(processor.setSeed(0x1234abcddcba4321ULL), "granular seed accepted while inactive");

    const auto controls = schedule(kind);
    std::size_t eventStart = 0U;
    for (std::uint32_t start = 0U; start < kFrames; start += blockFrames) {
        const auto count = std::min(blockFrames, kFrames - start);
        std::array<TemporalFxEvent, 64U> local{};
        std::uint32_t localCount = 0U;
        while (eventStart < controls.size() && controls[eventStart].frameOffset < start + count) {
            if (controls[eventStart].frameOffset >= start) {
                local[localCount] = controls[eventStart];
                local[localCount].frameOffset -= start;
                ++localCount;
            }
            ++eventStart;
        }
        for (std::uint32_t i = 0U; i < count; ++i) result.audio[start + i] = sourceFrame(start + i);
        if (!check(processor.processBlock(start, result.audio.data() + start, count,
                    localCount == 0U ? nullptr : local.data(), localCount),
                   "valid contiguous block is processed")) return result;
    }
    result.latency = processor.latency();
    result.activeGrains = processor.activeGrains();
    result.repeatFrames = processor.repeatFrames();
    result.valid = true;
    return result;
}

double energy(const std::vector<StereoFrame>& frames, bool left) {
    double sum = 0.0;
    for (const auto& frame : frames) {
        const double value = left ? frame.left : frame.right;
        sum += value * value;
    }
    return sum;
}

double maximumDifference(const std::vector<StereoFrame>& a,
                         const std::vector<StereoFrame>& b) {
    double maximum = 0.0;
    for (std::size_t i = 0U; i < a.size(); ++i) {
        maximum = std::max(maximum, std::fabs(static_cast<double>(a[i].left) - b[i].left));
        maximum = std::max(maximum, std::fabs(static_cast<double>(a[i].right) - b[i].right));
    }
    return maximum;
}

std::uint32_t countNonFinite(const std::vector<StereoFrame>& frames) {
    std::uint32_t count = 0U;
    for (const auto& frame : frames)
        count += (!std::isfinite(frame.left) || !std::isfinite(frame.right)) ? 1U : 0U;
    return count;
}

double peakFrequency(const std::vector<StereoFrame>& audio, bool left,
                     std::uint32_t begin, std::uint32_t count,
                     double lowHz, double highHz) {
    double bestPower = -1.0;
    double bestHz = 0.0;
    for (double hz = lowHz; hz <= highHz; hz += 1.0) {
        double real = 0.0;
        double imag = 0.0;
        for (std::uint32_t i = 0U; i < count; ++i) {
            const double phase = 2.0 * kPi * hz * i / 48000.0;
            const double sample = left ? audio[begin + i].left : audio[begin + i].right;
            real += sample * std::cos(phase);
            imag -= sample * std::sin(phase);
        }
        const double power = real * real + imag * imag;
        if (power > bestPower) { bestPower = power; bestHz = hz; }
    }
    return bestHz;
}

double frequencyAmplitude(const std::vector<StereoFrame>& audio, bool left,
                          std::uint32_t begin, std::uint32_t count, double hz) {
    double real = 0.0;
    double imag = 0.0;
    double windowSum = 0.0;
    for (std::uint32_t i = 0U; i < count; ++i) {
        const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * i / (count - 1U));
        const double phase = 2.0 * kPi * hz * i / 48000.0;
        const double sample = left ? audio[begin + i].left : audio[begin + i].right;
        real += sample * window * std::cos(phase);
        imag -= sample * window * std::sin(phase);
        windowSum += window;
    }
    return 2.0 * std::hypot(real, imag) / std::max(1.0, windowSum);
}

void testBudgetsAndTransactions() {
    const auto spec = makeSpec();
    const auto options = makeOptions();
    for (std::uint8_t raw = 0U; raw <= static_cast<std::uint8_t>(TemporalFxKind::Freeze); ++raw) {
        const auto kind = static_cast<TemporalFxKind>(raw);
        TemporalFxAdapter processor;
        check(TemporalFxAdapter::requiredPrepareBytes(spec, kind, options) > sizeof(processor),
              "all six kinds have a memory preflight");
        check(processor.prepare(spec, kind, options), "all six kinds prepare");
        check(processor.preparedBytes() == TemporalFxAdapter::requiredPrepareBytes(spec, kind, options),
              "reported prepared bytes equal preflight");
        std::array<StereoFrame, 64U> samples{};
        for (auto& sample : samples) sample = {0.12f, -0.07f};
        const auto before = samples;
        const std::array<TemporalFxEvent, 1> invalid{{event(3U, TemporalFxControl::Wet, 1.5f)}};
        check(!processor.processBlock(0U, samples.data(), 64U, invalid.data(), 1U),
              "invalid event is rejected transactionally");
        bool unchanged = true;
        for (std::size_t i = 0U; i < samples.size(); ++i)
            unchanged = unchanged && samples[i].left == before[i].left &&
                        samples[i].right == before[i].right;
        check(unchanged, "rejected event leaves audio buffer unchanged");
        const std::array<TemporalFxEvent, 2> unsorted{{event(20U, TemporalFxControl::Wet, 0.2f),
                                                        event(10U, TemporalFxControl::Wet, 0.8f)}};
        check(!processor.processBlock(0U, samples.data(), 64U, unsorted.data(), 2U),
              "unsorted events are rejected transactionally");
    }
    TemporalFxOptions tooLarge = options;
    tooLarge.maximumDelaySeconds = 2.01f;
    check(TemporalFxAdapter::requiredPrepareBytes(spec, TemporalFxKind::TapeEcho, tooLarge) == 0U,
          "over-budget delay options fail preflight");
    TemporalFxOptions badFreeze = options;
    badFreeze.freezeWindowFrames = 1000U;
    check(TemporalFxAdapter::requiredPrepareBytes(spec, TemporalFxKind::Freeze, badFreeze) == 0U,
          "invalid FFT geometry fails preflight");
}

void testPartitionInvarianceAndAudio() {
    const std::array<TemporalFxKind, 6> kinds{{TemporalFxKind::TapeEcho,
        TemporalFxKind::GranularDelay, TemporalFxKind::Warp, TemporalFxKind::Twist,
        TemporalFxKind::Roll, TemporalFxKind::Freeze}};
    for (std::size_t index = 0U; index < kinds.size(); ++index) {
        const auto at64 = render(kinds[index], 64U);
        const auto at128 = render(kinds[index], 128U);
        const auto at256 = render(kinds[index], 256U);
        check(at64.valid && at128.valid && at256.valid, "partition fixtures render");
        if (!at64.valid || !at128.valid || !at256.valid) continue;
        const double difference = std::max(maximumDifference(at64.audio, at128.audio),
                                           maximumDifference(at128.audio, at256.audio));
        gMaximumPartitionDifference = std::max(gMaximumPartitionDifference, difference);
        check(difference < 2.0e-5, "64/128/256 frame output is partition invariant");
        check(countNonFinite(at64.audio) == 0U, "output remains finite");
        gEnergyLeft[index] = energy(at64.audio, true);
        gEnergyRight[index] = energy(at64.audio, false);
        check(gEnergyLeft[index] > 1.0e-4 && gEnergyRight[index] > 1.0e-4,
              "effect produces non-silent stereo audio");
        if (kinds[index] == TemporalFxKind::GranularDelay)
            check(at64.activeGrains > 0U, "granular delay spawns live grains");
        if (kinds[index] == TemporalFxKind::Roll) {
            gRollCapturedFrames = at64.repeatFrames;
            check(at64.repeatFrames > 0U, "Roll captures its live input segment");
        }
        if (kinds[index] == TemporalFxKind::Freeze)
            check(at64.latency.fixedAlgorithmicSamples == 1024,
                  "spectral Freeze declares its aligned 1024-frame path latency");
        if (kinds[index] == TemporalFxKind::Warp)
            check(at64.latency.fixedAlgorithmicSamples == 1024,
                  "Warp declares its aligned STFT path latency");
    }
}

void testFreezeStereoCaptureAndTapeEcho() {
    const auto spec = makeSpec();
    const auto options = makeOptions();
    TemporalFxAdapter freeze;
    check(freeze.prepare(spec, TemporalFxKind::Freeze, options), "freeze prepares for stereo fixture");
    constexpr std::uint32_t total = 18432U;
    std::vector<StereoFrame> audio(total);
    for (std::uint32_t i = 0U; i < total; ++i) {
        const double time = static_cast<double>(i) / 48000.0;
        audio[i] = i < 4096U
            ? StereoFrame{0.25f * static_cast<float>(std::sin(2.0 * kPi * 440.0 * time)),
                          0.22f * static_cast<float>(std::sin(2.0 * kPi * 997.0 * time + 0.3))}
            : StereoFrame{};
    }
    const std::array<TemporalFxEvent, 3> freezeEvents{{event(0U, TemporalFxControl::Active, 1.0f),
        event(0U, TemporalFxControl::Wet, 1.0f), event(4096U, TemporalFxControl::Freeze, 1.0f)}};
    std::size_t eventIndex = 0U;
    for (std::uint32_t start = 0U; start < total; start += 256U) {
        const auto count = std::min(256U, total - start);
        std::array<TemporalFxEvent, 4> current{};
        std::uint32_t currentCount = 0U;
        while (eventIndex < freezeEvents.size() && freezeEvents[eventIndex].frameOffset < start + count) {
            current[currentCount] = freezeEvents[eventIndex];
            current[currentCount++].frameOffset -= start;
            ++eventIndex;
        }
        check(freeze.processBlock(start, audio.data() + start, count,
            currentCount == 0U ? nullptr : current.data(), currentCount),
            "freeze preserves independent L/R spectra");
    }
    gFreezeLeftPeakHz = peakFrequency(audio, true, 8192U, 8192U, 420.0, 460.0);
    gFreezeRightPeakHz = peakFrequency(audio, false, 8192U, 8192U, 970.0, 1020.0);
    gFreezeLeftLeakAmplitude = frequencyAmplitude(audio, true, 8192U, 8192U, 997.0);
    gFreezeRightLeakAmplitude = frequencyAmplitude(audio, false, 8192U, 8192U, 440.0);
    check(std::fabs(gFreezeLeftPeakHz - 440.0) <= 5.0, "left frozen channel retains its off-bin 440 Hz pitch");
    check(std::fabs(gFreezeRightPeakHz - 997.0) <= 5.0, "right frozen channel retains its off-bin 997 Hz pitch");
    check(gFreezeLeftLeakAmplitude < 1.0e-4,
          "the independent right-channel 997 Hz tone does not leak into the frozen left channel");
    check(gFreezeRightLeakAmplitude < 1.0e-4,
          "the independent left-channel 440 Hz tone does not leak into the frozen right channel");

    for (std::uint32_t mode = 0U; mode < 2U; ++mode) {
        const auto kind = mode == 0U ? TemporalFxKind::Freeze : TemporalFxKind::Warp;
        TemporalFxAdapter stft;
        check(stft.prepare(spec, kind, options), "STFT kind prepares for wet-onset probe");
        constexpr std::uint32_t kProbeFrames = 4096U;
        std::vector<StereoFrame> probe(kProbeFrames);
        probe[0] = {0.7f, -0.2f};
        std::array<TemporalFxEvent, 3> probeEvents{{event(0U, TemporalFxControl::Active, 1.0f),
                                                   event(0U, TemporalFxControl::Wet, 1.0f),
                                                   event(0U, TemporalFxControl::WarpAmount, 1.0f)}};
        const std::uint32_t probeCount = mode == 0U ? 2U : 3U;
        for (std::uint32_t start = 0U; start < kProbeFrames; start += 256U) {
            const auto count = std::min(256U, kProbeFrames - start);
            check(stft.processBlock(start, probe.data() + start, count,
                start == 0U ? probeEvents.data() : nullptr, start == 0U ? probeCount : 0U),
                "STFT wet impulse block processes");
        }
        for (std::uint32_t i = 0U; i < kProbeFrames; ++i) {
            if (std::fabs(probe[i].left) + std::fabs(probe[i].right) > 1.0e-6f) {
                gStftWetImpulseFirst[mode] = i;
                break;
            }
        }
        check(stft.latency().fixedAlgorithmicSamples == 1024,
              "STFT dry alignment latency is explicitly 1024 samples");
        check(gStftWetImpulseFirst[mode] == 1024U,
              "STFT wet impulse onset is measured at the dry-alignment boundary");
    }

    TemporalFxAdapter tape;
    check(tape.prepare(spec, TemporalFxKind::TapeEcho, options), "Tape Echo prepares for echo fixture");
    check(tape.latency().fixedAlgorithmicSamples == 0 &&
          tape.latency().wetPathGroupDelaySamples > 0.0,
          "Tape Echo reports dry zero latency separately from x4 nonlinear group delay");
    constexpr std::uint32_t echoFrames = 12288U;
    std::vector<StereoFrame> impulse(echoFrames);
    impulse[0] = {0.8f, 0.0f};
    const std::array<TemporalFxEvent, 4> tapeEvents{{event(0U, TemporalFxControl::Active, 1.0f),
        event(0U, TemporalFxControl::Wet, 1.0f), event(0U, TemporalFxControl::DelayMs, 50.0f),
        event(0U, TemporalFxControl::Drive, 8.0f)}};
    std::uint32_t firstEcho = 0U;
    for (std::uint32_t start = 0U; start < echoFrames; start += 256U) {
        const auto count = std::min(256U, echoFrames - start);
        const auto ev = start == 0U ? tapeEvents.data() : nullptr;
        const auto evCount = start == 0U ? static_cast<std::uint32_t>(tapeEvents.size()) : 0U;
        check(tape.processBlock(start, impulse.data() + start, count, ev, evCount),
              "Tape Echo impulse block processes");
        for (std::uint32_t i = 0U; i < count; ++i) {
            const auto frame = start + i;
            if (frame >= 1000U && std::fabs(impulse[frame].left) > 1.0e-5f && firstEcho == 0U)
                firstEcho = frame;
        }
    }
    gTapeFirstEcho = firstEcho;
    check(firstEcho >= 2400U && firstEcho <= 2432U,
          "Tape Echo emits its multi-head delayed impulse after a nonzero delay");
}

double aliasEnergyAtKnownBins(const std::vector<float>& signal, std::uint32_t begin,
                              std::uint32_t frames) {
    constexpr std::array<double, 5> aliasBins{{2000.0, 6000.0, 10000.0, 18000.0, 22000.0}};
    double sumWindow = 0.0;
    for (std::uint32_t i = 0U; i < frames; ++i)
        sumWindow += 0.5 - 0.5 * std::cos(2.0 * kPi * i / (frames - 1U));
    double energy = 0.0;
    for (const auto hz : aliasBins) {
        double real = 0.0;
        double imag = 0.0;
        for (std::uint32_t i = 0U; i < frames; ++i) {
            const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * i / (frames - 1U));
            const double phase = 2.0 * kPi * hz * i / 48000.0;
            const double value = signal[begin + i] * window;
            real += value * std::cos(phase);
            imag -= value * std::sin(phase);
        }
        const double amplitude = 2.0 * std::hypot(real, imag) / sumWindow;
        energy += amplitude * amplitude;
    }
    return energy;
}

void testTapeOversampledAdaaPath() {
    const auto spec = makeSpec();
    TemporalFxAdapter tape;
    check(tape.prepare(spec, TemporalFxKind::TapeEcho, makeOptions()),
          "Tape Echo prepares for high-frequency nonlinear parity");
    OversampledNonlinear x4;
    AdaaCubicShaper x1;
    check(x4.prepare(spec, OversamplingFactor::x4, NonlinearModel::AdaaCubic) &&
          x1.prepare(spec), "both ADAA reference paths prepare");
    check(x4.setDrive(16.0f) && x1.setDrive(16.0f), "nonlinear references use identical maximum drive");

    constexpr std::uint32_t total = 48000U;
    std::vector<StereoFrame> actual(total);
    std::vector<float> referenceX4(total);
    std::vector<float> referenceX1(total);
    const std::array<TemporalFxEvent, 6> events{{event(0U, TemporalFxControl::Active, 1.0f),
        event(0U, TemporalFxControl::Wet, 1.0f), event(0U, TemporalFxControl::DelayMs, 50.0f),
        event(0U, TemporalFxControl::Feedback, 0.0f), event(0U, TemporalFxControl::WowDepthMs, 0.0f),
        event(0U, TemporalFxControl::Drive, 16.0f)}};
    for (std::uint32_t start = 0U; start < total; start += 256U) {
        const auto count = std::min(256U, total - start);
        for (std::uint32_t i = 0U; i < count; ++i) {
            const auto frame = start + i;
            const float input = 0.72f * static_cast<float>(std::sin(
                2.0 * kPi * 14000.0 * frame / 48000.0));
            actual[frame] = {input, 0.0f};
            referenceX4[frame] = x4.processSample(input);
            referenceX1[frame] = x1.processSample(input);
        }
        check(tape.processBlock(start, actual.data() + start, count,
            start == 0U ? events.data() : nullptr,
            start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U),
            "tape high-frequency fixture processes");
    }
    constexpr std::uint32_t compareBegin = 24000U;
    constexpr std::uint32_t compareFrames = 4096U;
    double bestSse = std::numeric_limits<double>::infinity();
    for (double delay = 2399.0; delay <= 2401.0001; delay += 0.02) {
        double sse = 0.0;
        for (std::uint32_t i = compareBegin; i < compareBegin + compareFrames; ++i) {
            const float expected = 0.67f * sinc8Read(referenceX4.data(), referenceX4.size(),
                static_cast<double>(i) - delay, BoundaryMode::Zero) +
                0.33f * sinc8Read(referenceX4.data(), referenceX4.size(),
                static_cast<double>(i) - delay * 1.5, BoundaryMode::Zero);
            const double difference = static_cast<double>(actual[i].left) - expected;
            sse += difference * difference;
        }
        if (sse < bestSse) {
            bestSse = sse;
            gTapeReferenceBestFractionalDelay = delay;
        }
    }
    gTapeReferenceBestRms = std::sqrt(bestSse / compareFrames);
    for (std::uint32_t i = compareBegin; i < compareBegin + compareFrames; ++i) {
        const float expected = 0.67f * referenceX4[i - 2400U] +
                               0.33f * referenceX4[i - 3600U];
        gTapeNonlinearReferenceError = std::max(gTapeNonlinearReferenceError,
            std::fabs(static_cast<double>(actual[i].left) - expected));
    }
    gTapeOversampledAliasRatio = aliasEnergyAtKnownBins(referenceX4, 32768U, 8192U) /
        std::max(1.0e-20, aliasEnergyAtKnownBins(referenceX1, 32768U, 8192U));
    check(gTapeNonlinearReferenceError < 0.01,
          "Tape Echo record path stays within 1% of the nominal 4x ADAA echo reference");
    check(std::isfinite(gTapeOversampledAliasRatio) && gTapeOversampledAliasRatio > 0.0,
          "high-frequency harmonic-folding metric is captured");
    check(gTapeOversampledAliasRatio < 0.5,
          "4x ADAA path suppresses the measured 14 kHz folded energy versus 1x ADAA");
}

void testTapeFeedbackTailBounds() {
    TemporalFxAdapter tape;
    check(tape.prepare(makeSpec(256U), TemporalFxKind::TapeEcho, makeOptions()),
          "Tape Echo prepares for long feedback-tail probe");
    constexpr std::uint32_t total = 96000U;
    std::vector<StereoFrame> audio(total);
    audio[0] = {0.6f, -0.3f};
    const std::array<TemporalFxEvent, 5> events{{
        event(0U, TemporalFxControl::Active, 1.0f),
        event(0U, TemporalFxControl::Wet, 1.0f),
        event(0U, TemporalFxControl::DelayMs, 50.0f),
        event(0U, TemporalFxControl::Feedback, 0.92f),
        event(0U, TemporalFxControl::ToneHz, 8000.0f)}};
    double earlyEnergy = 0.0;
    double lateEnergy = 0.0;
    for (std::uint32_t start = 0U; start < total; start += 256U) {
        const auto count = std::min(256U, total - start);
        check(tape.processBlock(start, audio.data() + start, count,
            start == 0U ? events.data() : nullptr,
            start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U),
            "Tape Echo long-tail block processes");
        for (std::uint32_t i = 0U; i < count; ++i) {
            const auto frame = start + i;
            const auto& sample = audio[frame];
            gTapeTailPeak = std::max(gTapeTailPeak,
                static_cast<double>(std::max(std::fabs(sample.left), std::fabs(sample.right))));
            const double energy = static_cast<double>(sample.left) * sample.left +
                                  static_cast<double>(sample.right) * sample.right;
            if (frame >= 2000U && frame < 12000U) earlyEnergy += energy;
            if (frame >= 84000U) lateEnergy += energy;
        }
    }
    gTapeLateToEarlyTailEnergy = lateEnergy / std::max(1.0e-20, earlyEnergy);
    check(countNonFinite(audio) == 0U, "feedback tail remains finite for two seconds");
    check(gTapeTailPeak < 1.0, "bounded feedback keeps the impulse response below full scale");
    check(earlyEnergy > 1.0e-7 && lateEnergy > 0.0,
          "long feedback tail remains measurable instead of collapsing to silence");
    check(gTapeLateToEarlyTailEnergy < 0.2,
          "damped feedback tail loses energy over the two-second observation window");
}

void testTapeFeedbackMonotonicityAndDelayCoupling() {
    constexpr std::uint32_t renderFrames = 48000U;
    const auto renderFeedback = [renderFrames](float feedback) {
        TemporalFxAdapter tape;
        const bool prepared = tape.prepare(makeSpec(256U), TemporalFxKind::TapeEcho, makeOptions());
        if (!check(prepared, "Tape Echo prepares for feedback monotonicity fixture"))
            return 0.0;
        std::vector<StereoFrame> audio(renderFrames);
        audio[0] = {0.7f, -0.2f};
        const std::array<TemporalFxEvent, 4U> events{{
            event(0U, TemporalFxControl::Active, 1.0f),
            event(0U, TemporalFxControl::Wet, 1.0f),
            event(0U, TemporalFxControl::Drive, 2.0f),
            event(0U, TemporalFxControl::Feedback, feedback)}};
        for (std::uint32_t start = 0U; start < audio.size(); start += 256U) {
            const auto count = std::min<std::uint32_t>(256U,
                static_cast<std::uint32_t>(audio.size()) - start);
            if (!check(tape.processBlock(start, audio.data() + start, count,
                    start == 0U ? events.data() : nullptr,
                    start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U),
                    "feedback comparison block processes")) return 0.0;
        }
        double total = 0.0;
        for (std::uint32_t i = 12000U; i < audio.size(); ++i)
            total += static_cast<double>(audio[i].left) * audio[i].left +
                     static_cast<double>(audio[i].right) * audio[i].right;
        return total;
    };
    gTapeLowFeedbackEnergy = renderFeedback(0.3f);
    gTapeHighFeedbackEnergy = renderFeedback(0.9f);
    check(gTapeHighFeedbackEnergy > gTapeLowFeedbackEnergy * 1.1,
          "increasing Tape feedback strictly increases the measured echo-tail energy");

    auto shortHistory = makeOptions();
    shortHistory.maximumDelaySeconds = 0.1f;
    TemporalFxAdapter validEdge;
    check(validEdge.prepare(makeSpec(64U), TemporalFxKind::TapeEcho, shortHistory),
          "Tape Echo prepares for the 100 ms maximum-delay edge");
    check(validEdge.latency().maximumWetDelaySamples == 4800U,
          "reported maximum wet delay matches the admitted 100 ms history");
    check(validEdge.latency().minimumWetDelaySamples == 2016U,
          "minimum wet delay includes the maximum negative wow excursion at 48 kHz");
    std::array<StereoFrame, 64U> audio{};
    const std::array<TemporalFxEvent, 2U> validPair{{
        event(0U, TemporalFxControl::DelayMs, 58.0f),
        event(0U, TemporalFxControl::WowDepthMs, 8.0f)}};
    check(validEdge.processBlock(0U, audio.data(), 64U, validPair.data(), 2U),
          "delay plus maximum wow depth is admitted exactly at the 100 ms bound");

    TemporalFxAdapter reverseOrderEdge;
    check(reverseOrderEdge.prepare(makeSpec(64U), TemporalFxKind::TapeEcho, shortHistory),
          "Tape Echo prepares for same-frame parameter transaction");
    const std::array<TemporalFxEvent, 2U> reverseOrderPair{{
        event(0U, TemporalFxControl::WowDepthMs, 8.0f),
        event(0U, TemporalFxControl::DelayMs, 58.0f)}};
    check(reverseOrderEdge.processBlock(0U, audio.data(), 64U,
            reverseOrderPair.data(), static_cast<std::uint32_t>(reverseOrderPair.size())),
          "same-frame delay and wow controls validate their final coupled values atomically");

    TemporalFxAdapter invalidEdge;
    check(invalidEdge.prepare(makeSpec(64U), TemporalFxKind::TapeEcho, shortHistory),
          "Tape Echo prepares for over-bound rejection");
    const auto before = audio;
    const std::array<TemporalFxEvent, 2U> invalidPair{{
        event(0U, TemporalFxControl::DelayMs, 60.0f),
        event(0U, TemporalFxControl::WowDepthMs, 8.0f)}};
    check(!invalidEdge.processBlock(0U, audio.data(), 64U, invalidPair.data(), 2U),
          "coupled delay and wow values beyond allocated history are rejected");
    check(std::equal(audio.begin(), audio.end(), before.begin(), [](const auto& a, const auto& b) {
        return a.left == b.left && a.right == b.right;
    }), "rejected delay pair leaves the input block unchanged");

    for (const float sampleRate : {44100.0f, 48000.0f, 96000.0f}) {
        auto rateOptions = makeOptions();
        rateOptions.maximumDelaySeconds = 0.1f;
        TemporalFxAdapter rateProcessor;
        const auto expectedMinimum = static_cast<std::uint32_t>(
            std::ceil(static_cast<double>(sampleRate) * 42.0 / 1000.0));
        check(rateProcessor.prepare(makeSpec(64U, sampleRate),
                                    TemporalFxKind::TapeEcho, rateOptions),
              "Tape Echo prepares for sample-rate-specific minimum delay evidence");
        check(rateProcessor.latency().minimumWetDelaySamples == expectedMinimum,
              "minimum wet delay is derived from 50 ms base minus 8 ms wow at each sample rate");
    }
}

void testEventCapacityAndNoAllocation() {
    for (std::uint8_t raw = 0U; raw <= static_cast<std::uint8_t>(TemporalFxKind::Freeze); ++raw) {
        const auto kind = static_cast<TemporalFxKind>(raw);
        TemporalFxAdapter processor;
        check(processor.prepare(makeSpec(64U), kind, makeOptions()), "kind prepares for callback guard");
        std::array<StereoFrame, 64U> samples{};
        std::array<TemporalFxEvent, 64U> events{};
        for (std::uint32_t i = 0U; i < events.size(); ++i)
            events[i] = event(i, TemporalFxControl::Active, (i & 1U) == 0U ? 1.0f : 0.0f);
        const auto beforeAlloc = gTemporalAllocations.load(std::memory_order_relaxed);
        const auto beforeFree = gTemporalDeallocations.load(std::memory_order_relaxed);
        gTemporalWatchAllocations.store(true, std::memory_order_relaxed);
        bool accepted = true;
        for (std::uint32_t block = 0U; block < 16U; ++block) {
            for (std::uint32_t i = 0U; i < samples.size(); ++i)
                samples[i] = {0.2f * std::sin(static_cast<float>(i + block * 64U) * 0.03f),
                              -0.17f * std::sin(static_cast<float>(i + block * 64U) * 0.071f)};
            accepted = accepted && processor.processBlock(block * 64U, samples.data(), 64U,
                                                           events.data(), 64U);
        }
        gTemporalWatchAllocations.store(false, std::memory_order_relaxed);
        const auto allocations = gTemporalAllocations.load(std::memory_order_relaxed) - beforeAlloc;
        const auto deallocations = gTemporalDeallocations.load(std::memory_order_relaxed) - beforeFree;
        gAllocations[raw] = allocations + deallocations;
        check(accepted, "64 ordered events per 64-frame callback are accepted");
        check(allocations == 0U && deallocations == 0U,
              "processing with maximum event count has no allocation or free");

        std::array<TemporalFxEvent, 65U> excessive{};
        for (std::uint32_t i = 0U; i < excessive.size(); ++i)
            excessive[i] = event(0U, TemporalFxControl::Active, 1.0f);
        check(!processor.processBlock(1024U, samples.data(), 64U, excessive.data(), 65U),
              "65-event list is rejected");
        check(!processor.processBlock(2048U, samples.data(), 64U, nullptr, 0U),
              "gap in absolute callback frames is rejected");
        check(!processor.processBlock(std::numeric_limits<std::uint64_t>::max() - 8U,
                                      samples.data(), 64U, nullptr, 0U),
              "absolute-frame overflow is rejected");
    }
}

void testRollLiveInputCapture() {
    TemporalFxAdapter roll;
    check(roll.prepare(makeSpec(128U), TemporalFxKind::Roll, makeOptions()), "Roll prepares independently");
    constexpr std::uint32_t frames = 10000U;
    std::vector<StereoFrame> input(frames);
    for (std::uint32_t i = 0U; i < frames; ++i) input[i] = sourceFrame(i);
    const std::array<TemporalFxEvent, 5> events{{event(0U, TemporalFxControl::Active, 1.0f),
        event(0U, TemporalFxControl::Wet, 1.0f), event(0U, TemporalFxControl::TempoBpm, 120.0f),
        event(0U, TemporalFxControl::SubdivisionBeats, 0.125f),
        event(0U, TemporalFxControl::Feedback, 0.4f)}};
    std::size_t eventIndex = 0U;
    for (std::uint32_t start = 0U; start < frames; start += 128U) {
        const auto count = std::min(128U, frames - start);
        std::array<TemporalFxEvent, 8> current{};
        std::uint32_t currentCount = 0U;
        while (eventIndex < events.size() && events[eventIndex].frameOffset < start + count) {
            current[currentCount] = events[eventIndex];
            current[currentCount++].frameOffset -= start;
            ++eventIndex;
        }
        check(roll.processBlock(start, input.data() + start, count,
            currentCount == 0U ? nullptr : current.data(), currentCount),
            "Roll captures and repeats incoming stereo samples without host transport");
    }
    gRollCapturedFrames = roll.repeatFrames();
    check(gRollCapturedFrames == 3000U, "Roll uses the requested sample-accurate 1/8 beat capture");
    check(energy(input, true) > 1.0, "Roll output contains rendered live input and repeated segments");
}

void emitQualityJson() {
    std::printf("{\"schemaVersion\":1,\"suite\":\"temporal-fx-adapters\",\"sampleRate\":48000,"
                "\"kinds\":[\"TAPE ECHO\",\"GRANULAR DELAY\",\"WARP\",\"TWIST\",\"ROLL\",\"FREEZE\"],"
                "\"partitionMaximumDifference\":%.12g,\"energyLeft\":[",
                gMaximumPartitionDifference);
    for (std::size_t i = 0U; i < gEnergyLeft.size(); ++i)
        std::printf("%s%.12g", i == 0U ? "" : ",", gEnergyLeft[i]);
    std::printf("],\"energyRight\":[");
    for (std::size_t i = 0U; i < gEnergyRight.size(); ++i)
        std::printf("%s%.12g", i == 0U ? "" : ",", gEnergyRight[i]);
    std::printf("],\"noallocAllocsPlusFreesByKind\":[");
    for (std::size_t i = 0U; i < gAllocations.size(); ++i)
        std::printf("%s%llu", i == 0U ? "" : ",", static_cast<unsigned long long>(gAllocations[i]));
    std::printf("],\"tapeEchoFirstEchoFrame\":%u,\"tape4xAdaaReferenceMaxError\":%.12g,"
                "\"tapeReferenceBestFitDelayFrames\":%.3f,\"tapeReferenceRmsAtBestFit\":%.12g,"
                "\"tapeTailPeak\":%.12g,\"tapeLateToEarlyTailEnergy\":%.12g,"
                "\"tapeFeedbackTailEnergyLowHigh\":[%.12g,%.12g],"
                "\"tapeOversampledAliasEnergyRatioVs1x\":%.12g,\"freezePeakHz\":[%.3f,%.3f],"
                "\"freezeOppositeToneLeakAmplitude\":[%.12g,%.12g],"
                "\"stftWetImpulseOnset\":[%u,%u],\"rollCapturedFrames\":%u}\n",
                gTapeFirstEcho, gTapeNonlinearReferenceError, gTapeReferenceBestFractionalDelay,
                gTapeReferenceBestRms, gTapeTailPeak, gTapeLateToEarlyTailEnergy,
                gTapeLowFeedbackEnergy, gTapeHighFeedbackEnergy,
                gTapeOversampledAliasRatio,
                gFreezeLeftPeakHz, gFreezeRightPeakHz,
                gFreezeLeftLeakAmplitude, gFreezeRightLeakAmplitude,
                gStftWetImpulseFirst[0], gStftWetImpulseFirst[1], gRollCapturedFrames);
}

} // namespace

int main() {
    testBudgetsAndTransactions();
    testPartitionInvarianceAndAudio();
    testFreezeStereoCaptureAndTapeEcho();
    testTapeOversampledAdaaPath();
    testTapeFeedbackTailBounds();
    testTapeFeedbackMonotonicityAndDelayCoupling();
    testEventCapacityAndNoAllocation();
    testRollLiveInputCapture();
    emitQualityJson();
    if (gFailures != 0) {
        std::fprintf(stderr, "temporal_fx_adapters_tests: %d failure(s)\n", gFailures);
        return EXIT_FAILURE;
    }
    std::puts("Temporal FX adapters: six real stereo processors, partition/bounds/noalloc and tonal checks passed");
    return EXIT_SUCCESS;
}

