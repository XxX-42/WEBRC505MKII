#include "webrc/dsp/preamp_fx.hpp"

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

std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gAllocations{0U};
std::atomic<std::uint64_t> gFrees{0U};

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void operator delete(void* pointer) noexcept {
    if (pointer && gWatchAllocations.load(std::memory_order_relaxed))
        gFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}
void operator delete[](void* pointer) noexcept {
    if (pointer && gWatchAllocations.load(std::memory_order_relaxed))
        gFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(pointer);
}
void operator delete(void* pointer, std::size_t) noexcept { operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { operator delete[](pointer); }

namespace {

using namespace webrc::dsp;
constexpr std::uint32_t kSampleRate = 48000U;
constexpr double kPi = 3.141592653589793238462643383279502884;
int gFailures = 0;
std::uint64_t gCallbackAllocations = 0U;
std::uint64_t gCallbackFrees = 0U;
double gPartitionMaximumDifference = 0.0;
double gToneLowFrequencyRatio = 0.0;
double gCabinetChangedResponseRms = 0.0;
std::uint32_t gDryImpulseFrame = 0U;
std::uint32_t gWetImpulseFirstFrame = 0U;
std::uint32_t gWetImpulsePeakFrame = 0U;

bool check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++gFailures;
    }
    return condition;
}

constexpr ProcessSpec makeSpec(std::uint32_t maximumBlock = 256U) {
    return {static_cast<float>(kSampleRate), maximumBlock, 2U};
}

struct IrSet {
    std::array<float, 96U> left{};
    std::array<float, 96U> right{};
    PreampCabinetIr view() const noexcept {
        return {static_cast<std::uint32_t>(left.size()), left.data(), right.data()};
    }
};

IrSet neutralIr() {
    IrSet result;
    result.left[0U] = 1.0f;
    result.right[0U] = 1.0f;
    return result;
}

struct RenderResult {
    std::vector<StereoFrame> audio;
    bool ok = false;
};

std::vector<PreampFxEvent> eventSchedule() {
    return {{0U, PreampFxControl::Active, 1.0f},
            {0U, PreampFxControl::Mix, 0.85f},
            {0U, PreampFxControl::Drive, 5.0f},
            {0U, PreampFxControl::BassDb, 2.0f},
            {0U, PreampFxControl::MidDb, -1.0f},
            {0U, PreampFxControl::TrebleDb, 3.0f},
            {0U, PreampFxControl::PresenceDb, 1.0f},
            {5003U, PreampFxControl::Drive, 12.0f},
            {9271U, PreampFxControl::BassDb, -5.0f},
            {15009U, PreampFxControl::OutputDb, -3.0f},
            {18000U, PreampFxControl::Mix, 0.7f}};
}

RenderResult render(const IrSet& ir, std::uint32_t callbackFrames,
                    NonlinearModel model = NonlinearModel::WdfSymmetricDiode) {
    constexpr std::uint32_t frames = 24000U;
    RenderResult result;
    result.audio.resize(frames);
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const double t = static_cast<double>(i) / kSampleRate;
        result.audio[i] = {
            0.19f * static_cast<float>(std::sin(2.0 * kPi * 431.0 * t)) +
                0.035f * static_cast<float>(std::sin(2.0 * kPi * 6100.0 * t)),
            -0.14f * static_cast<float>(std::sin(2.0 * kPi * 997.0 * t + 0.17)) +
                0.03f * static_cast<float>(std::sin(2.0 * kPi * 4300.0 * t))};
    }
    PreampFxProcessor processor;
    PreampFxOptions options{};
    options.nonlinearModel = model;
    if (!processor.prepare(makeSpec(), options, ir.view())) return result;
    const auto schedule = eventSchedule();
    std::size_t eventIndex = 0U;
    for (std::uint32_t start = 0U; start < frames; start += callbackFrames) {
        const auto count = std::min(callbackFrames, frames - start);
        std::array<PreampFxEvent, 64U> local{};
        std::uint32_t localCount = 0U;
        while (eventIndex < schedule.size() && schedule[eventIndex].frameOffset < start + count) {
            local[localCount] = schedule[eventIndex];
            local[localCount++].frameOffset -= start;
            ++eventIndex;
        }
        if (!processor.processBlock(start, result.audio.data() + start, count,
                                    localCount == 0U ? nullptr : local.data(), localCount))
            return result;
    }
    result.ok = true;
    return result;
}

double maxDifference(const std::vector<StereoFrame>& a,
                     const std::vector<StereoFrame>& b) {
    double result = 0.0;
    for (std::size_t i = 0U; i < a.size(); ++i) {
        result = std::max(result, std::fabs(static_cast<double>(a[i].left) - b[i].left));
        result = std::max(result, std::fabs(static_cast<double>(a[i].right) - b[i].right));
    }
    return result;
}

double rms(const std::vector<StereoFrame>& audio, bool left, std::uint32_t begin,
           std::uint32_t count) {
    double sum = 0.0;
    for (std::uint32_t i = 0U; i < count; ++i) {
        const double sample = left ? audio[begin + i].left : audio[begin + i].right;
        sum += sample * sample;
    }
    return std::sqrt(sum / std::max<std::uint32_t>(1U, count));
}

std::vector<StereoFrame> renderTone(float frequencyHz, float bassDb,
                                   float trebleDb = 0.0f) {
    constexpr std::uint32_t frames = 48000U;
    std::vector<StereoFrame> audio(frames);
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const float sample = 0.2f * static_cast<float>(std::sin(
            2.0 * kPi * frequencyHz * static_cast<double>(i) / kSampleRate));
        audio[i] = {sample, sample};
    }
    auto ir = neutralIr();
    PreampFxProcessor processor;
    if (!processor.prepare(makeSpec(), {}, ir.view())) return {};
    const std::array<PreampFxEvent, 4U> events{{
        {0U, PreampFxControl::Active, 1.0f},
        {0U, PreampFxControl::Drive, 0.1f},
        {0U, PreampFxControl::BassDb, bassDb},
        {0U, PreampFxControl::TrebleDb, trebleDb}}};
    for (std::uint32_t start = 0U; start < frames; start += 256U) {
        const std::uint32_t count = std::min(256U, frames - start);
        if (!processor.processBlock(start, audio.data() + start, count,
                start == 0U ? events.data() : nullptr, start == 0U ? 4U : 0U)) return {};
    }
    return audio;
}

bool testMemoryAndValidation() {
    const auto spec = makeSpec();
    auto ir = neutralIr();
    PreampFxOptions options{};
    check(PreampFxProcessor::requiredPrepareBytes(spec, options,
              static_cast<std::uint32_t>(ir.left.size())) > sizeof(PreampFxProcessor),
          "budget includes partitioned IR and streaming buffers");
    check(PreampFxProcessor::requiredPrepareBytes(spec, options, 0U) == 0U,
          "empty IR has no valid setup budget");
    check(PreampFxProcessor::requiredPrepareBytes(spec, options,
              PreampFxProcessor::kMaximumCabinetIrFrames + 1U) == 0U,
          "IR beyond fixed cap is rejected by preflight");
    auto invalidOptions = options;
    invalidOptions.cabinetPartitionFrames = 63U;
    check(PreampFxProcessor::requiredPrepareBytes(spec, invalidOptions, 96U) == 0U,
          "non power-of-two partition is rejected");

    PreampFxProcessor processor;
    auto badIr = ir;
    badIr.left[1U] = std::numeric_limits<float>::quiet_NaN();
    check(!processor.prepare(spec, options, badIr.view()),
          "non-finite IR tap is rejected before setup");
    badIr = ir;
    badIr.left.fill(0.0f);
    badIr.right.fill(0.0f);
    check(!processor.prepare(spec, options, badIr.view()),
          "silent cabinet IR is rejected instead of creating a silent wet path");
    check(processor.prepare(spec, options, ir.view()),
          "valid dual-mono clean-room IR prepares after invalid candidates");
    check(processor.latency().fixedAlgorithmicSamples ==
              processor.latency().cabinetPartitionSamples + 22U,
          "reported dry alignment includes cabinet partition and x4 delay anchor");
    return gFailures == 0;
}

bool testDryLatencyAndStereoCabinet() {
    auto ir = neutralIr();
    PreampFxOptions options{};
    options.cabinetPartitionFrames = 64U;
    PreampFxProcessor dry;
    check(dry.prepare(makeSpec(), options, ir.view()), "dry latency processor prepares");
    std::vector<StereoFrame> impulse(512U);
    impulse[0U] = {0.5f, -0.25f};
    const PreampFxEvent inactive{0U, PreampFxControl::Active, 0.0f};
    check(dry.processBlock(0U, impulse.data(), 256U, &inactive, 1U),
          "inactive pass processes the initial impulse block");
    check(dry.processBlock(256U, impulse.data() + 256U, 256U),
          "inactive pass processes the impulse tail");
    const auto expectedFrame = dry.latency().dryAlignmentSamples;
    gDryImpulseFrame = expectedFrame;
    check(impulse[expectedFrame].left == 0.5f && impulse[expectedFrame].right == -0.25f,
          "bypass path is delayed by the declared wet alignment anchor");

    PreampFxProcessor wet;
    check(wet.prepare(makeSpec(), options, ir.view()), "wet impulse processor prepares");
    std::vector<StereoFrame> wetImpulse(1024U);
    wetImpulse[0U] = {0.25f, 0.25f};
    const std::array<PreampFxEvent, 3U> activeEvents{{
        {0U, PreampFxControl::Active, 1.0f},
        {0U, PreampFxControl::Drive, 0.1f},
        {0U, PreampFxControl::Mix, 1.0f}}};
    check(wet.processBlock(0U, wetImpulse.data(), 256U, activeEvents.data(),
                           static_cast<std::uint32_t>(activeEvents.size())),
          "wet impulse processor renders first block");
    check(wet.processBlock(256U, wetImpulse.data() + 256U, 256U) &&
              wet.processBlock(512U, wetImpulse.data() + 512U, 256U) &&
              wet.processBlock(768U, wetImpulse.data() + 768U, 256U),
          "wet impulse response is rendered across partitions");
    double peak = 0.0;
    std::uint32_t first = 0U;
    bool found = false;
    for (std::uint32_t i = 0U; i < wetImpulse.size(); ++i) {
        const double magnitude = std::max(std::fabs(static_cast<double>(wetImpulse[i].left)),
                                          std::fabs(static_cast<double>(wetImpulse[i].right)));
        if (!found && magnitude > 1.0e-8) { first = i; found = true; }
        if (magnitude > peak) { peak = magnitude; gWetImpulsePeakFrame = i; }
    }
    gWetImpulseFirstFrame = first;
    check(found && peak > 1.0e-4, "wet cabinet convolution produces a real impulse response");
    check(found && first >= options.cabinetPartitionFrames,
          "partitioned cabinet response begins after its partition staging interval");
    check(std::isfinite(peak), "wet cabinet impulse peak remains finite");

    std::vector<StereoFrame> leftOnly(1024U);
    leftOnly[0U] = {0.25f, 0.0f};
    PreampFxProcessor stereo;
    check(stereo.prepare(makeSpec(), options, ir.view()), "stereo isolation processor prepares");
    check(stereo.processBlock(0U, leftOnly.data(), 256U, activeEvents.data(), 3U) &&
              stereo.processBlock(256U, leftOnly.data() + 256U, 256U) &&
              stereo.processBlock(512U, leftOnly.data() + 512U, 256U) &&
              stereo.processBlock(768U, leftOnly.data() + 768U, 256U),
          "left-only impulse is processed through both cabinet channels");
    double rightLeak = 0.0;
    double leftEnergy = 0.0;
    for (const auto& frame : leftOnly) {
        rightLeak = std::max(rightLeak, std::fabs(static_cast<double>(frame.right)));
        leftEnergy += static_cast<double>(frame.left) * frame.left;
    }
    check(leftEnergy > 1.0e-6 && rightLeak < 1.0e-8,
          "left cabinet response retains independent stereo channel state");
    return gFailures == 0;
}

bool testCabinetConvolutionAndPartitionInvariance() {
    auto irA = neutralIr();
    auto irB = neutralIr();
    irA.right[0U] = 0.5f;
    irB.left[20U] = 0.5f;
    const auto a64 = render(irA, 64U);
    const auto a128 = render(irA, 128U);
    const auto a256 = render(irA, 256U);
    const auto b64 = render(irB, 64U);
    if (!check(a64.ok && a128.ok && a256.ok && b64.ok,
               "preamp renders in 64/128/256 variable callback schedules")) return false;
    gPartitionMaximumDifference = std::max(maxDifference(a64.audio, a128.audio),
                                           maxDifference(a64.audio, a256.audio));
    check(gPartitionMaximumDifference < 2.0e-6,
          "eventful stereo PREAMP PCM is invariant to host block partitioning");
    double cabinetDelta = 0.0;
    for (std::size_t i = 0U; i < a64.audio.size(); ++i) {
        const double l = static_cast<double>(a64.audio[i].left) - b64.audio[i].left;
        const double r = static_cast<double>(a64.audio[i].right) - b64.audio[i].right;
        cabinetDelta += l * l + r * r;
    }
    gCabinetChangedResponseRms = std::sqrt(cabinetDelta / (2.0 * a64.audio.size()));
    check(gCabinetChangedResponseRms > 1.0e-5,
          "cabinet impulse taps alter the convolved wet response");
    check(maxDifference(a64.audio, b64.audio) > 1.0e-4,
          "PREAMP output responds to the actual cabinet convolution taps");
    return gFailures == 0;
}

bool testToneStackAndNonlinearModel() {
    const auto bassPlus = renderTone(90.0f, 10.0f);
    const auto bassMinus = renderTone(90.0f, -10.0f);
    const auto treblePlus = renderTone(6000.0f, 0.0f, 10.0f);
    const auto trebleMinus = renderTone(6000.0f, 0.0f, -10.0f);
    if (!check(bassPlus.size() == 48000U && bassMinus.size() == 48000U &&
               treblePlus.size() == 48000U && trebleMinus.size() == 48000U,
               "tone fixtures render all requested frequencies")) return false;
    const double bassHigh = rms(bassPlus, true, 24000U, 24000U);
    const double bassLow = rms(bassMinus, true, 24000U, 24000U);
    gToneLowFrequencyRatio = bassHigh / std::max(1.0e-12, bassLow);
    const double trebleGainRatio = rms(treblePlus, true, 24000U, 24000U) /
        std::max(1.0e-12, rms(trebleMinus, true, 24000U, 24000U));
    check(gToneLowFrequencyRatio > 2.0,
          "bass control measurably changes low-frequency gain");
    check(trebleGainRatio > 2.0,
          "treble control measurably changes high-frequency gain");

    auto ir = neutralIr();
    const auto diode = render(ir, 256U, NonlinearModel::WdfSymmetricDiode);
    const auto cubic = render(ir, 256U, NonlinearModel::AdaaCubic);
    if (!check(diode.ok && cubic.ok, "both prepared x4 nonlinear models render")) return false;
    check(maxDifference(diode.audio, cubic.audio) > 1.0e-3,
          "default diode PREAMP saturation has a distinct response from cubic ADAA");
    return gFailures == 0;
}

bool testTransactionalEventsAndNoAlloc() {
    auto ir = neutralIr();
    PreampFxProcessor processor;
    check(processor.prepare(makeSpec(), {}, ir.view()), "transaction processor prepares");
    std::array<StereoFrame, 256U> audio{};
    for (std::uint32_t i = 0U; i < audio.size(); ++i) {
        audio[i] = {0.1f * std::sin(static_cast<float>(i) * 0.07f),
                    -0.08f * std::cos(static_cast<float>(i) * 0.11f)};
    }
    const auto original = audio;
    const PreampFxEvent invalid{255U, PreampFxControl::Drive, 25.0f};
    check(!processor.processBlock(0U, audio.data(), 256U, &invalid, 1U),
          "hostile parameter is transactionally rejected");
    bool unchanged = true;
    for (std::size_t i = 0U; i < audio.size(); ++i)
        unchanged = unchanged && audio[i].left == original[i].left &&
                    audio[i].right == original[i].right;
    check(unchanged, "rejected control list leaves audio unchanged");

    std::array<PreampFxEvent, 64U> burst{};
    for (std::uint32_t i = 0U; i < burst.size(); ++i) {
        burst[i] = {i * 4U, (i & 1U) ? PreampFxControl::Drive : PreampFxControl::Mix,
                    (i & 1U) ? 8.0f : 0.7f};
    }
    gAllocations.store(0U, std::memory_order_relaxed);
    gFrees.store(0U, std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    const bool result = processor.processBlock(0U, audio.data(), 256U,
                                                burst.data(), 64U);
    gWatchAllocations.store(false, std::memory_order_relaxed);
    gCallbackAllocations = gAllocations.load(std::memory_order_relaxed);
    gCallbackFrees = gFrees.load(std::memory_order_relaxed);
    check(result, "maximum-size bounded event list processes");
    check(gCallbackAllocations == 0U && gCallbackFrees == 0U,
          "audio callback allocates and frees no memory");
    for (const auto& frame : audio)
        check(std::isfinite(frame.left) && std::isfinite(frame.right),
              "hostile-but-valid signal stays finite");
    return gFailures == 0;
}

} // namespace

int main() {
    testMemoryAndValidation();
    testDryLatencyAndStereoCabinet();
    testCabinetConvolutionAndPartitionInvariance();
    testToneStackAndNonlinearModel();
    testTransactionalEventsAndNoAlloc();
    std::printf("{\"schemaVersion\":1,\"suite\":\"preamp-fx\",\"sampleRate\":%u,"
                "\"defaultNonlinearModel\":\"WdfSymmetricDiode4x\","
                "\"callbackAllocationsAndFrees\":[%llu,%llu],"
                "\"partitionMaximumDifference\":%.12g,\"toneLowFrequencyPlusMinusRatio\":%.9g,"
                "\"cabinetChangedResponseRms\":%.12g,\"dryImpulseFrame\":%u,"
                "\"wetImpulseFirstFrame\":%u,\"wetImpulsePeakFrame\":%u,\"failures\":%d}\n",
                kSampleRate,
                static_cast<unsigned long long>(gCallbackAllocations),
                static_cast<unsigned long long>(gCallbackFrees),
                gPartitionMaximumDifference, gToneLowFrequencyRatio,
                gCabinetChangedResponseRms, gDryImpulseFrame, gWetImpulseFirstFrame,
                gWetImpulsePeakFrame, gFailures);
    return gFailures == 0 ? 0 : 1;
}
