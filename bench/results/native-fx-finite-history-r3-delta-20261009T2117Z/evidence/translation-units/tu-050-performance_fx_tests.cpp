#include "webrc/dsp/performance_fx.hpp"

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

namespace {

using namespace webrc::dsp;

std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gWatchedAllocations{0};

bool check(bool condition, const char* message) {
    if (!condition) std::fprintf(stderr, "FAIL: %s\n", message);
    return condition;
}

ProcessSpec spec(std::uint32_t block = 256) { return {48000.0f, block, 2}; }

StereoFrame source(std::uint64_t frame) {
    const double t = static_cast<double>(frame) / 48000.0;
    return {static_cast<float>(0.31 * std::sin(2.0 * 3.141592653589793 * 431.0 * t) +
                               0.11 * std::sin(2.0 * 3.141592653589793 * 73.0 * t)),
            static_cast<float>(0.27 * std::sin(2.0 * 3.141592653589793 * 587.0 * t + 0.71) +
                               0.08 * std::sin(2.0 * 3.141592653589793 * 109.0 * t))};
}

template <typename Processor>
std::vector<StereoFrame> render(std::uint32_t blockSize, std::uint32_t frames) {
    Processor processor;
    if (!processor.prepare(spec(256)) || !processor.setSeed(0x123456789abcdefULL)) return {};
    std::vector<StereoFrame> output(frames);
    const std::uint64_t enableAt = 40000;
    const std::uint64_t changeAt = 45513;
    const std::uint64_t stopAt = 59003;
    for (std::uint32_t offset = 0; offset < frames;) {
        const auto count = std::min(blockSize, frames - offset);
        std::array<PerformanceFxEvent, 4> events{};
        std::uint32_t eventCount = 0;
        const auto blockStart = static_cast<std::uint64_t>(offset);
        if (enableAt >= blockStart && enableAt < blockStart + count) {
            events[eventCount++] = {static_cast<std::uint32_t>(enableAt - blockStart),
                                    PerformanceFxControl::Active, 1.0f};
        }
        if (changeAt >= blockStart && changeAt < blockStart + count) {
            const auto control = Processor{}.kind() == PerformanceFxKind::BeatScatter
                ? PerformanceFxControl::PitchRatio
                : (Processor{}.kind() == PerformanceFxKind::BeatShift
                    ? PerformanceFxControl::ShiftBeats
                    : (Processor{}.kind() == PerformanceFxKind::VinylFlick
                        ? PerformanceFxControl::FlickImpulse
                        : PerformanceFxControl::Feedback));
            const float value = control == PerformanceFxControl::PitchRatio ? -0.75f
                : control == PerformanceFxControl::ShiftBeats ? 0.125f
                : control == PerformanceFxControl::FlickImpulse ? 0.75f : 0.82f;
            events[eventCount++] = {static_cast<std::uint32_t>(changeAt - blockStart), control, value};
        }
        if (stopAt >= blockStart && stopAt < blockStart + count) {
            events[eventCount++] = {static_cast<std::uint32_t>(stopAt - blockStart),
                                    PerformanceFxControl::Active, 0.0f};
        }
        for (std::uint32_t i = 0; i < count; ++i) output[offset + i] = source(offset + i);
        if (!processor.processBlock(blockStart, output.data() + offset, count,
                                    eventCount == 0 ? nullptr : events.data(), eventCount)) return {};
        offset += count;
    }
    return output;
}

double rms(const std::vector<StereoFrame>& data) {
    double sum = 0.0;
    for (const auto& frame : data) sum += static_cast<double>(frame.left) * frame.left +
                                          static_cast<double>(frame.right) * frame.right;
    return data.empty() ? 0.0 : std::sqrt(sum / (2.0 * data.size()));
}

StereoFrame nonPeriodicStereoSource(std::uint64_t frame) {
    const auto noise = [frame](std::uint64_t salt) noexcept {
        std::uint64_t value = frame + salt + 0x9e3779b97f4a7c15ULL;
        value = (value ^ (value >> 30U)) * 0xbf58476d1ce4e5b9ULL;
        value = (value ^ (value >> 27U)) * 0x94d049bb133111ebULL;
        value ^= value >> 31U;
        const auto mantissa = static_cast<std::uint32_t>((value >> 40U) & 0x00ffffffU);
        return (static_cast<float>(mantissa) * (2.0f / 16777216.0f) - 1.0f) * 0.24f;
    };
    return {noise(0x243f6a8885a308d3ULL), noise(0x13198a2e03707344ULL)};
}

class TaggedHistoryReference {
public:
    explicit TaggedHistoryReference(std::uint32_t capacity)
        : samples_(capacity), tags_(capacity, std::numeric_limits<std::uint64_t>::max()) {}

    void write(std::uint64_t frame, StereoFrame sample) noexcept {
        const auto index = static_cast<std::size_t>(frame % samples_.size());
        samples_[index] = sample;
        tags_[index] = frame;
    }

    bool hasFrame(std::int64_t frame, std::uint64_t latestFrame) const noexcept {
        if (frame < 0 || static_cast<std::uint64_t>(frame) > latestFrame) return false;
        const auto unsignedFrame = static_cast<std::uint64_t>(frame);
        if (latestFrame - unsignedFrame >= samples_.size()) return false;
        const auto index = static_cast<std::size_t>(unsignedFrame % samples_.size());
        return tags_[index] == unsignedFrame;
    }

    StereoFrame read(double position, std::uint64_t latestFrame, bool& valid) const noexcept {
        if (!std::isfinite(position) || position < 0.0) {
            valid = false;
            return {};
        }
        const auto base = static_cast<std::int64_t>(std::floor(position));
        const auto fraction = static_cast<float>(position - static_cast<double>(base));
        const auto aFrame = base - 1;
        const auto bFrame = base;
        const auto cFrame = base + 1;
        const auto dFrame = base + 2;
        valid = hasFrame(aFrame, latestFrame) && hasFrame(bFrame, latestFrame) &&
                hasFrame(cFrame, latestFrame) && hasFrame(dFrame, latestFrame);
        const auto tap = [this](std::int64_t frame) noexcept {
            if (frame < 0) return StereoFrame{};
            return samples_[static_cast<std::size_t>(frame) % samples_.size()];
        };
        const auto sampleA = tap(aFrame);
        const auto sampleB = tap(bFrame);
        const auto sampleC = tap(cFrame);
        const auto sampleD = tap(dFrame);
        const auto interpolate = [fraction](float x0, float x1, float x2, float x3) noexcept {
            const float c0 = -fraction * (fraction - 1.0f) * (fraction - 2.0f) / 6.0f;
            const float c1 = (fraction + 1.0f) * (fraction - 1.0f) * (fraction - 2.0f) / 2.0f;
            const float c2 = -(fraction + 1.0f) * fraction * (fraction - 2.0f) / 2.0f;
            const float c3 = (fraction + 1.0f) * fraction * (fraction - 1.0f) / 6.0f;
            return c0 * x0 + c1 * x1 + c2 * x2 + c3 * x3;
        };
        return {interpolate(sampleA.left, sampleB.left, sampleC.left, sampleD.left),
                interpolate(sampleA.right, sampleB.right, sampleC.right, sampleD.right)};
    }

private:
    std::vector<StereoFrame> samples_;
    std::vector<std::uint64_t> tags_;
};

std::vector<StereoFrame> renderTaggedMaxNegativeScatterReference(
    std::uint32_t ringFrames, std::uint32_t warmFrames, std::uint32_t grainFrames,
    double firstRead, bool& allTapsValid) {
    TaggedHistoryReference history(ringFrames);
    for (std::uint32_t frame = 0U; frame < warmFrames; ++frame)
        history.write(frame, nonPeriodicStereoSource(frame));

    std::vector<StereoFrame> output(grainFrames);
    float activeGain = 0.0f;
    constexpr float sampleRate = 48000.0f;
    const float activeCoefficient = static_cast<float>(
        1.0 - std::exp(-1.0 / (static_cast<double>(sampleRate) * 0.005)));
    allTapsValid = true;
    for (std::uint32_t age = 0U; age < grainFrames; ++age) {
        const auto absoluteFrame = static_cast<std::uint64_t>(warmFrames) + age;
        const auto input = nonPeriodicStereoSource(absoluteFrame);
        history.write(absoluteFrame, input);

        const float phase = static_cast<float>(age) / static_cast<float>(grainFrames - 1U);
        const float window = 0.5f - 0.5f * std::cos(
            static_cast<float>(2.0 * 3.141592653589793238462643383279502884) * phase);
        bool sampleValid = false;
        const auto grain = history.read(firstRead - 2.0 * age, absoluteFrame, sampleValid);
        allTapsValid = allTapsValid && sampleValid;
        const StereoFrame wet{grain.left * window * 0.25f,
                              grain.right * window * 0.25f};

        activeGain += (1.0f - activeGain) * activeCoefficient;
        if (std::fabs(1.0f - activeGain) < 1.0e-6f) activeGain = 1.0f;
        output[age] = {input.left + (wet.left - input.left) * activeGain,
                       input.right + (wet.right - input.right) * activeGain};
    }
    return output;
}

std::vector<StereoFrame> renderMaxNegativeScatter(std::uint32_t callbackFrames,
                                                  std::uint64_t& tagMisses) {
    constexpr ProcessSpec preparedSpec{48000.0f, 256U, 2U};
    constexpr std::uint64_t warmFrames = 220000U; // > four seconds of changing stereo history.
    // Float32 48000 * 0.15 rounds slightly above 7200, and the production
    // ceil() therefore prepares 7201 samples at this exact rate.
    constexpr std::uint32_t grainFrames = 7201U;
    constexpr std::uint64_t seed = 1056U;          // first xorshift draw is 0.999865..., near max scatter.
    BeatScatter scatter;
    if (!scatter.prepare(preparedSpec) || !scatter.setSeed(seed)) return {};
    std::array<StereoFrame, 256U> block{};
    for (std::uint64_t start = 0U; start < warmFrames;) {
        const auto count = static_cast<std::uint32_t>(std::min<std::uint64_t>(
            callbackFrames, warmFrames - start));
        for (std::uint32_t i = 0U; i < count; ++i)
            block[i] = nonPeriodicStereoSource(start + i);
        if (!scatter.processBlock(start, block.data(), count)) return {};
        start += count;
    }

    std::vector<StereoFrame> output(grainFrames);
    constexpr std::array<PerformanceFxEvent, 5U> events{{
        {0U, PerformanceFxControl::TempoBpm, 20.0f},
        {0U, PerformanceFxControl::SubdivisionBeats, 4.0f},
        {0U, PerformanceFxControl::PitchRatio, -2.0f},
        {0U, PerformanceFxControl::ScatterAmount, 1.0f},
        {0U, PerformanceFxControl::Active, 1.0f},
    }};
    for (std::uint32_t start = 0U; start < grainFrames;) {
        const auto count = std::min(callbackFrames, grainFrames - start);
        for (std::uint32_t i = 0U; i < count; ++i)
            block[i] = nonPeriodicStereoSource(warmFrames + start + i);
        if (!scatter.processBlock(warmFrames + start, block.data(), count,
                                  start == 0U ? events.data() : nullptr,
                                  start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U))
            return {};
        std::copy_n(block.begin(), count, output.begin() + start);
        start += count;
    }
    tagMisses = scatter.historyTagMissCount();
    return output;
}

bool testNegativeScatterKeepsCompleteTaggedGrainInHistory() {
    constexpr std::uint32_t maxBlockFrames = 256U;
    constexpr std::uint32_t sampleRate = 48000U;
    constexpr std::uint32_t ringFrames = sampleRate * 4U + maxBlockFrames + 16U;
    constexpr std::uint64_t warmFrames = 220000U;
    constexpr std::uint32_t grainFrames = 7201U;
    constexpr std::uint64_t seed = 1056U;
    constexpr double pitchRatio = -2.0;
    constexpr double grainSpan = static_cast<double>(grainFrames) * 2.0;
    constexpr double minimumDelay = grainSpan + 8.0;
    constexpr double tailAge = (1.0 - pitchRatio) * (grainFrames - 1U);
    const double maxWindow = static_cast<double>(ringFrames - 2U) - minimumDelay - tailAge;
    if (!check(maxWindow > 0.0, "ring can admit the maximum legal scatter grain")) return false;

    std::uint64_t randomState = seed;
    randomState ^= randomState >> 12U;
    randomState ^= randomState << 25U;
    randomState ^= randomState >> 27U;
    const auto randomBits = static_cast<std::uint32_t>(
        (randomState * 0x2545f4914f6cdd1dULL) >> 40U);
    const float randomUnit = static_cast<float>(randomBits) / 16777216.0f;
    const double firstRead = static_cast<double>(warmFrames) - minimumDelay -
                             static_cast<double>(randomUnit) * maxWindow;

    // Demonstrate that the pre-fix scatter bound (which reserved the current
    // block but not the reverse grain's full read-head trajectory) really
    // crosses the ring boundary for this deterministic near-maximum draw.
    const double legacyWindow = std::max(0.0,
        static_cast<double>(ringFrames) - maxBlockFrames - 8.0 - minimumDelay);
    const double legacyFirstRead = static_cast<double>(warmFrames) - minimumDelay -
                                   static_cast<double>(randomUnit) * legacyWindow;
    TaggedHistoryReference legacyHistory(ringFrames);
    for (std::uint64_t frame = 0U; frame < warmFrames; ++frame)
        legacyHistory.write(frame, nonPeriodicStereoSource(frame));
    bool legacyAlgorithmLostHistory = false;
    for (std::uint32_t age = 0U; age < grainFrames; ++age) {
        const auto currentFrame = static_cast<std::uint64_t>(warmFrames) + age;
        legacyHistory.write(currentFrame, nonPeriodicStereoSource(currentFrame));
        const auto base = static_cast<std::int64_t>(std::floor(legacyFirstRead - 2.0 * age));
        for (std::int64_t tap = base - 1; tap <= base + 2; ++tap)
            legacyAlgorithmLostHistory = legacyAlgorithmLostHistory ||
                                         !legacyHistory.hasFrame(tap, currentFrame);
    }
    if (!check(legacyAlgorithmLostHistory,
               "legacy scatter window demonstrably requests overwritten history during the reverse grain"))
        return false;

    TaggedHistoryReference taggedHistory(ringFrames);
    for (std::uint64_t frame = 0U; frame < warmFrames; ++frame)
        taggedHistory.write(frame, nonPeriodicStereoSource(frame));
    std::uint64_t oldestRequestedAge = 0U;
    bool everyTapWasCurrentGeneration = true;
    for (std::uint32_t age = 0U; age < grainFrames; ++age) {
        const auto currentFrame = warmFrames + age;
        taggedHistory.write(currentFrame, nonPeriodicStereoSource(currentFrame));
        const double readPosition = firstRead + pitchRatio * age;
        const auto base = static_cast<std::int64_t>(std::floor(readPosition));
        for (std::int64_t tap = base - 1; tap <= base + 2; ++tap) {
            everyTapWasCurrentGeneration = everyTapWasCurrentGeneration &&
                                           taggedHistory.hasFrame(tap, currentFrame);
            if (tap >= 0 && static_cast<std::uint64_t>(tap) <= currentFrame)
                oldestRequestedAge = std::max(oldestRequestedAge,
                    currentFrame - static_cast<std::uint64_t>(tap));
        }
    }
    if (!check(everyTapWasCurrentGeneration,
               "independent tagged-ring reference retains all four interpolation taps for the full reverse grain") ||
        !check(oldestRequestedAge >= ringFrames - 64U,
               "near-maximum negative scatter exercises the retained-history boundary")) return false;

    std::uint64_t misses64 = 0U;
    std::uint64_t misses128 = 0U;
    const auto output64 = renderMaxNegativeScatter(64U, misses64);
    const auto output128 = renderMaxNegativeScatter(128U, misses128);
    bool referenceTapsValid = false;
    const auto reference = renderTaggedMaxNegativeScatterReference(
        ringFrames, static_cast<std::uint32_t>(warmFrames), grainFrames,
        firstRead, referenceTapsValid);
    if (!check(output64.size() == grainFrames && output128.size() == grainFrames,
               "long-history scatter renders complete 64/128-frame callback runs") ||
        !check(misses64 == 0U && misses128 == 0U,
               "generation-tagged processor ring never serves an overwritten or unwritten frame") ||
        !check(referenceTapsValid && reference.size() == grainFrames,
               "independent sample reference has every interpolation tap from the correct absolute frame") ||
        !check(rms(output64) > 0.02 && rms(output128) > 0.02,
               "the reverse scatter grain retains substantial stereo signal at its history boundary"))
        return false;
    double maximumDifference = 0.0;
    double maximumReferenceError = 0.0;
    for (std::uint32_t i = 0U; i < grainFrames; ++i) {
        maximumDifference = std::max(maximumDifference,
            std::max(std::fabs(static_cast<double>(output64[i].left) - output128[i].left),
                     std::fabs(static_cast<double>(output64[i].right) - output128[i].right)));
        maximumReferenceError = std::max(maximumReferenceError,
            std::max(std::fabs(static_cast<double>(output64[i].left) - reference[i].left),
                     std::fabs(static_cast<double>(output64[i].right) - reference[i].right)));
    }
    if (!check(maximumReferenceError < 2.0e-6,
               "negative-scatter output matches independent tagged PCM/Lagrange/Hann reference")) {
        std::uint32_t worst = 0U;
        for (std::uint32_t i = 1U; i < grainFrames; ++i) {
            const auto error = std::max(
                std::fabs(static_cast<double>(output64[i].left) - reference[i].left),
                std::fabs(static_cast<double>(output64[i].right) - reference[i].right));
            const auto previous = std::max(
                std::fabs(static_cast<double>(output64[worst].left) - reference[worst].left),
                std::fabs(static_cast<double>(output64[worst].right) - reference[worst].right));
            if (error > previous) worst = i;
        }
        std::fprintf(stderr,
                     "negative scatter reference max error=%.9g at=%u actual=(%.9g,%.9g) ref=(%.9g,%.9g) firstRead=%.9f\n",
                     maximumReferenceError, worst, output64[worst].left, output64[worst].right,
                     reference[worst].left, reference[worst].right, firstRead);
        for (const auto index : {0U, 1U, 10U, 100U, 1000U, 3879U, 7199U})
            std::fprintf(stderr, "  sample[%u] actual=(%.7g,%.7g) ref=(%.7g,%.7g)\n",
                         index, output64[index].left, output64[index].right,
                         reference[index].left, reference[index].right);
        return false;
    }
    if (!check(maximumDifference < 2.0e-6,
               "negative-pitch boundary scatter PCM is invariant to actual callback partitions")) {
        std::fprintf(stderr, "negative scatter boundary max partition difference=%.9g\n",
                     maximumDifference);
        return false;
    }
    return true;
}

template <typename Processor>
double activeEffectDifference(const std::vector<StereoFrame>& output) {
    const auto probe = Processor{};
    const auto expectedLatency = probe.algorithmicLatencySamples();
    const std::uint32_t begin = 40000;
    const std::uint32_t end = std::min<std::uint32_t>(59003,
        static_cast<std::uint32_t>(output.size()));
    double sum = 0.0;
    std::uint64_t count = 0;
    for (std::uint32_t frame = begin; frame < end; ++frame) {
        const auto referenceFrame = frame >= expectedLatency ? frame - expectedLatency : 0U;
        const auto reference = source(referenceFrame);
        const double left = static_cast<double>(output[frame].left) - reference.left;
        const double right = static_cast<double>(output[frame].right) - reference.right;
        sum += left * left + right * right;
        count += 2;
    }
    return count == 0 ? 0.0 : std::sqrt(sum / static_cast<double>(count));
}

bool testPrepareBoundsAndEventTransactions() {
    BeatScatter scatter;
    const auto scatterBytes = PerformanceFxProcessor::requiredPrepareBytes(
        spec(), PerformanceFxKind::BeatScatter);
    const auto scatterFrames = static_cast<std::uint64_t>(48000U * 4U + 256U + 16U);
    const auto taggedRingBytes = scatterFrames * (sizeof(StereoFrame) + sizeof(std::uint64_t));
    if (!check(scatterBytes >= taggedRingBytes + 64U * 1024U,
               "scatter memory preflight includes both PCM history and generation tags") ||
        !check(PerformanceFxProcessor::requiredPrepareBytes({384000.0f, 64, 2},
                       PerformanceFxKind::BeatRepeat) == 0,
               "unsupported high-rate allocation is rejected before prepare") ||
        !check(scatter.prepare(spec()), "scatter prepares with stereo bounded history")) return false;
    std::array<StereoFrame, 8> block{};
    block[0] = {0.25f, -0.25f};
    const auto beforeGain = scatter.activeGain();
    const PerformanceFxEvent invalid{8, PerformanceFxControl::Active, 1.0f};
    if (!check(!scatter.processBlock(0, block.data(), static_cast<std::uint32_t>(block.size()),
                                     &invalid, 1),
               "out-of-block event is rejected") ||
        !check(block[0].left == 0.25f && block[0].right == -0.25f &&
               scatter.activeGain() == beforeGain,
               "invalid event leaves audio and processor state unchanged")) return false;
    const std::array<PerformanceFxEvent, 2> unordered{{
        {3, PerformanceFxControl::Active, 1.0f},
        {2, PerformanceFxControl::Active, 0.0f},
    }};
    if (!check(!scatter.processBlock(0, block.data(), static_cast<std::uint32_t>(block.size()),
                                     unordered.data(), static_cast<std::uint32_t>(unordered.size())),
               "unsorted automation is rejected transactionally")) return false;
    VinylFlick vinyl;
    if (!check(vinyl.prepare(spec()), "vinyl prepares before control-domain validation")) return false;
    block[0] = {0.125f, -0.125f};
    const auto vinylReadBefore = vinyl.vinylReadPosition();
    const PerformanceFxEvent unusedTempo{0, PerformanceFxControl::TempoBpm, 90.0f};
    if (!check(!vinyl.processBlock(0, block.data(), static_cast<std::uint32_t>(block.size()),
                                   &unusedTempo, 1),
               "vinyl rejects tempo controls that have no effect on the platter model") ||
        !check(block[0].left == 0.125f && block[0].right == -0.125f &&
               vinyl.vinylReadPosition() == vinylReadBefore,
               "unsupported vinyl control rejection preserves audio and read-head state")) return false;
    return true;
}

template <typename Processor>
bool testBlockInvariantAndNoAlloc(const char* label) {
    constexpr std::uint32_t frames = 65536;
    const auto small = render<Processor>(64, frames);
    const auto large = render<Processor>(256, frames);
    if (!check(small.size() == frames && large.size() == frames, label)) return false;
    double maxDifference = 0.0;
    double maxStep = 0.0;
    double stereoDifference = 0.0;
    for (std::uint32_t i = 0; i < frames; ++i) {
        maxDifference = std::max(maxDifference, std::fabs(static_cast<double>(small[i].left) - large[i].left));
        maxDifference = std::max(maxDifference, std::fabs(static_cast<double>(small[i].right) - large[i].right));
        stereoDifference += std::fabs(static_cast<double>(small[i].left) - small[i].right);
        if (i != 0) {
            const auto leftStep = std::fabs(static_cast<double>(small[i].left) - small[i - 1].left);
            const auto rightStep = std::fabs(static_cast<double>(small[i].right) - small[i - 1].right);
            maxStep = std::max(maxStep, std::max(leftStep, rightStep));
        }
        if (!std::isfinite(small[i].left) || !std::isfinite(small[i].right)) return false;
    }
    if (!check(maxDifference < 2.0e-6, "absolute-frame automation is invariant to 64/256 block schedules") ||
        !check(rms(small) > 0.025, "active processor produces audible nonzero stereo output") ||
        !check(stereoDifference / frames > 0.01, "stereo channels retain distinct input histories") ||
        !check(activeEffectDifference<Processor>(small) > 0.005,
               "active processor measurably changes the latency-aligned dry signal") ||
        !check(maxStep < 1.3, "bounded feedback and crossfades keep sample steps bounded")) {
        std::fprintf(stderr, "%s rms=%.9g maxDiff=%.9g maxStep=%.9g\n", label,
                     rms(small), maxDifference, maxStep);
        return false;
    }

    Processor noalloc;
    if (!noalloc.prepare(spec()) || !noalloc.setSeed(123)) return false;
    std::array<StereoFrame, 64> block{};
    std::array<PerformanceFxEvent, 2> controls{{
        {0, PerformanceFxControl::Active, 1.0f},
        {17, PerformanceFxControl::Active, 0.0f},
    }};
    gWatchedAllocations.store(0, std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    const bool processed = noalloc.processBlock(0, block.data(),
        static_cast<std::uint32_t>(block.size()), controls.data(),
        static_cast<std::uint32_t>(controls.size()));
    gWatchAllocations.store(false, std::memory_order_relaxed);
    return check(processed && gWatchedAllocations.load(std::memory_order_relaxed) == 0,
                 "control application and block processing allocate no heap memory");
}

bool testStereoSeparationAndEffectBehavior() {
    BeatScatter scatter;
    BeatRepeat repeat;
    BeatShift shift;
    VinylFlick vinyl;
    if (!scatter.prepare(spec()) || !repeat.prepare(spec()) || !shift.prepare(spec()) ||
        !vinyl.prepare(spec())) return false;
    if (!check(vinyl.algorithmicLatencySamples() == 960,
               "vinyl reports its fixed 20 ms history-read latency") ||
        !check(scatter.algorithmicLatencySamples() == 0 && repeat.algorithmicLatencySamples() == 0 &&
               shift.algorithmicLatencySamples() == 240,
               "beat shift reports its fixed 5 ms causal base delay")) return false;
    constexpr std::uint32_t warm = 40000;
    std::array<PerformanceFxProcessor*, 4> processors{{&scatter, &repeat, &shift, &vinyl}};
    for (auto* processor : processors) {
        for (std::uint32_t offset = 0; offset < warm;) {
            const auto count = std::min<std::uint32_t>(256, warm - offset);
            std::array<StereoFrame, 256> block{};
            for (std::uint32_t i = 0; i < count; ++i) block[i] = source(offset + i);
            if (!processor->processBlock(offset, block.data(), count)) return false;
            offset += count;
        }
    }
    std::array<StereoFrame, 256> block{};
    for (std::uint32_t i = 0; i < block.size(); ++i) block[i] = source(warm + i);
    const PerformanceFxEvent start{7, PerformanceFxControl::Active, 1.0f};
    if (!scatter.processBlock(warm, block.data(), static_cast<std::uint32_t>(block.size()), &start, 1)) return false;
    double stereoDifference = 0.0;
    for (const auto& frame : block) stereoDifference += std::fabs(frame.left - frame.right);
    if (!check(stereoDifference > 0.1, "scatter preserves distinct stereo histories")) return false;

    const PerformanceFxEvent repeatStart{0, PerformanceFxControl::Active, 1.0f};
    std::array<StereoFrame, 256> repeatBlock{};
    for (std::uint32_t i = 0; i < repeatBlock.size(); ++i) repeatBlock[i] = source(warm + i);
    if (!repeat.processBlock(warm, repeatBlock.data(), static_cast<std::uint32_t>(repeatBlock.size()),
                            &repeatStart, 1) ||
        !check(repeat.repeatFrames() == 6000, "beat repeat captures exactly one 1/4-beat slice at 120 BPM") ||
        !check(repeat.repeatCaptureFramesRemaining() == 5744,
               "beat repeat schedules a bounded capture after the first 256 rendered frames")) return false;
    for (std::uint32_t offset = 256; offset < 6000;) {
        const auto count = std::min<std::uint32_t>(256, 6000 - offset);
        std::array<StereoFrame, 256> captureBlock{};
        for (std::uint32_t i = 0; i < count; ++i) captureBlock[i] = source(warm + offset + i);
        if (!repeat.processBlock(warm + offset, captureBlock.data(), count)) return false;
        offset += count;
    }
    if (!check(repeat.repeatCaptureFramesRemaining() == 0,
               "bounded stereo slice capture completes before the next beat boundary")) return false;
    std::array<StereoFrame, 256> repeatedBlock{};
    for (std::uint32_t i = 0; i < repeatedBlock.size(); ++i) repeatedBlock[i] = source(warm + 6000 + i);
    if (!repeat.processBlock(warm + 6000, repeatedBlock.data(),
                             static_cast<std::uint32_t>(repeatedBlock.size()) ) ||
        !check(rms(std::vector<StereoFrame>(repeatedBlock.begin(), repeatedBlock.end())) > 0.04,
               "beat repeat renders the completed captured stereo slice")) return false;

    const PerformanceFxEvent vinylStart{0, PerformanceFxControl::Active, 1.0f};
    const PerformanceFxEvent flick{17, PerformanceFxControl::FlickImpulse, 1.0f};
    std::array<PerformanceFxEvent, 2> vinylEvents{{vinylStart, flick}};
    std::array<StereoFrame, 256> vinylBlock{};
    for (std::uint32_t i = 0; i < vinylBlock.size(); ++i) vinylBlock[i] = source(warm + i);
    if (!vinyl.processBlock(warm, vinylBlock.data(), static_cast<std::uint32_t>(vinylBlock.size()),
                            vinylEvents.data(), static_cast<std::uint32_t>(vinylEvents.size()))) return false;
    if (!check(vinyl.vinylReadPosition() > static_cast<double>(warm) - vinyl.algorithmicLatencySamples() &&
               vinyl.vinylSpeedRatio() >= 0.5f && vinyl.vinylSpeedRatio() <= 1.5f,
               "flick impulse moves an actual bounded audio read head")) return false;
    return true;
}

bool testBeatRepeatCaptureWorkIsBoundedPerBlock() {
    BeatRepeat repeat;
    if (!check(repeat.prepare(spec(64)), "bounded-capture repeat prepares at 64 frames")) return false;
    constexpr std::uint64_t warmFrames = 80000;
    for (std::uint64_t start = 0; start < warmFrames; start += 64) {
        std::array<StereoFrame, 64> warm{};
        warm.fill({0.5f, -0.25f});
        if (!repeat.processBlock(start, warm.data(), 64)) return false;
    }
    std::vector<StereoFrame> capturedOutput(72064);
    std::array<PerformanceFxEvent, 64> events{};
    events[0] = {0, PerformanceFxControl::TempoBpm, 20.0f};
    events[1] = {0, PerformanceFxControl::SubdivisionBeats, 0.5f};
    for (std::uint32_t i = 2; i < 63; ++i) {
        events[i] = {0, PerformanceFxControl::Active,
                     ((i - 2U) & 1U) == 0U ? 1.0f : 0.0f};
    }
    events[63] = {0, PerformanceFxControl::Feedback, 0.5f};
    std::array<StereoFrame, 64> block{};
    block.fill({});
    if (!check(repeat.processBlock(warmFrames, block.data(), 64, events.data(), 64),
               "maximum same-sample control burst starts the long repeat capture") ||
        !check(repeat.repeatFrames() == 72000,
               "20 BPM half-beat capture is the expected 72000-frame stereo segment") ||
               !check(repeat.repeatCaptureFramesCopiedLastBlock() == 64 &&
                repeat.repeatCaptureFramesRemaining() == 71936,
                "64-frame callback copies at most one stereo frame per rendered sample")) return false;
    std::copy(block.begin(), block.end(), capturedOutput.begin());

    std::uint64_t totalCopied = repeat.repeatCaptureFramesCopiedLastBlock();
    for (std::uint64_t start = warmFrames + 64; start < warmFrames + 72000; start += 64) {
        std::array<StereoFrame, 64> chunk{};
        chunk.fill({});
        if (!repeat.processBlock(start, chunk.data(), 64) ||
            !check(repeat.repeatCaptureFramesCopiedLastBlock() <= 64,
                   "repeat capture work remains capped at 64 frames on every callback")) return false;
        totalCopied += repeat.repeatCaptureFramesCopiedLastBlock();
        std::copy(chunk.begin(), chunk.end(),
                  capturedOutput.begin() + static_cast<std::ptrdiff_t>(start - warmFrames));
    }
    if (!check(totalCopied == 72000 && repeat.repeatCaptureFramesRemaining() == 0,
               "incremental copy completes exactly one full stereo capture without a burst")) return false;
    std::array<StereoFrame, 64> audible{};
    audible.fill({});
    if (!repeat.processBlock(warmFrames + 72000, audible.data(), 64)) return false;
    std::copy(audible.begin(), audible.end(), capturedOutput.begin() + 72000);
    std::uint32_t onset = 0;
    while (onset < capturedOutput.size() &&
           std::fabs(capturedOutput[onset].left) + std::fabs(capturedOutput[onset].right) < 1.0e-4f) ++onset;
    double maximumTransitionStep = 0.0;
    std::uint32_t maximumTransitionIndex = 0;
    for (std::uint32_t i = 71996; i < 72064; ++i) {
        const auto step = std::max(std::fabs(static_cast<double>(capturedOutput[i].left) - capturedOutput[i - 1].left),
                                   std::fabs(static_cast<double>(capturedOutput[i].right) - capturedOutput[i - 1].right));
        if (step > maximumTransitionStep) {
            maximumTransitionStep = step;
            maximumTransitionIndex = i;
        }
    }
    if (maximumTransitionStep >= 0.01)
        std::fprintf(stderr, "repeat boundary step=%.9g at %u, L %.9g -> %.9g R %.9g -> %.9g onset=%u\n",
                     maximumTransitionStep, maximumTransitionIndex,
                     capturedOutput[maximumTransitionIndex - 1].left,
                     capturedOutput[maximumTransitionIndex].left,
                     capturedOutput[maximumTransitionIndex - 1].right,
                     capturedOutput[maximumTransitionIndex].right, onset);
    const bool earlyWet = check(onset < 240,
        "first capture reads the protected history immediately instead of waiting 1.5 seconds");
    const bool boundedTransition = check(maximumTransitionStep < 0.01,
        "history-to-buffer handoff and next-boundary scheduling remain click bounded");
    std::printf("BeatRepeat 20BPM/half-beat: copied=%llu frames, per64fCallback<=64, wetOnset=%u frames, boundaryMaxStep=%.9g\n",
                static_cast<unsigned long long>(totalCopied), onset, maximumTransitionStep);
    return earlyWet && boundedTransition;
}

bool renderBeatShift(std::uint32_t capacity, std::uint32_t blockFrames, float shiftBeats,
                     std::vector<StereoFrame>& output) {
    constexpr std::uint32_t inputFrame = 4000;
    constexpr std::uint32_t totalFrames = 30000;
    BeatShift shift;
    if (!shift.prepare(spec(capacity))) return false;
    output.assign(totalFrames, {});
    const std::array<PerformanceFxEvent, 2> events{{
        {0, PerformanceFxControl::Active, 1.0f},
        {0, PerformanceFxControl::ShiftBeats, shiftBeats},
    }};
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min(blockFrames, totalFrames - start);
        if (start <= inputFrame && inputFrame < start + count) {
            output[inputFrame].left = 0.75f;
            output[inputFrame].right = -0.25f;
        }
        if (!shift.processBlock(start, output.data() + start, count,
                                start == 0 ? events.data() : nullptr,
                                start == 0 ? static_cast<std::uint32_t>(events.size()) : 0U)) return false;
        start += count;
    }
    return shift.algorithmicLatencySamples() == 240;
}

std::uint32_t peakFrame(const std::vector<StereoFrame>& output) {
    std::uint32_t peak = 0;
    float amplitude = 0.0f;
    for (std::uint32_t i = 0; i < output.size(); ++i) {
        const auto candidate = std::fabs(output[i].left);
        if (candidate > amplitude) {
            peak = i;
            amplitude = candidate;
        }
    }
    return peak;
}

bool testBeatShiftIsCausalAndBlockSizeInvariant() {
    BeatShift invalid;
    if (!invalid.prepare(spec(64))) return false;
    std::array<StereoFrame, 64> untouched{};
    untouched[0] = {0.125f, -0.25f};
    const auto before = untouched;
    const PerformanceFxEvent negative{0, PerformanceFxControl::ShiftBeats, -0.5f};
    if (!check(!invalid.processBlock(0, untouched.data(), 64, &negative, 1),
               "unsupported negative causal shift is rejected") ||
        !check(untouched[0].left == before[0].left && untouched[0].right == before[0].right &&
               invalid.activeGain() == 0.0f,
               "negative shift rejection is transactional")) return false;

    std::vector<StereoFrame> base64, base128, shifted64, shifted128;
    if (!renderBeatShift(64, 64, 0.0f, base64) ||
        !renderBeatShift(128, 128, 0.0f, base128) ||
        !renderBeatShift(64, 64, 1.0f, shifted64) ||
        !renderBeatShift(128, 128, 1.0f, shifted128)) return false;
    const auto basePeak64 = peakFrame(base64);
    const auto basePeak128 = peakFrame(base128);
    const auto shiftedPeak64 = peakFrame(shifted64);
    const auto shiftedPeak128 = peakFrame(shifted128);
    double maxBlockScheduleDifference = 0.0;
    for (std::uint32_t i = 0; i < base64.size(); ++i) {
        maxBlockScheduleDifference = std::max(maxBlockScheduleDifference,
            std::max(std::fabs(static_cast<double>(base64[i].left) - base128[i].left),
                     std::fabs(static_cast<double>(base64[i].right) - base128[i].right)));
        maxBlockScheduleDifference = std::max(maxBlockScheduleDifference,
            std::max(std::fabs(static_cast<double>(shifted64[i].left) - shifted128[i].left),
                     std::fabs(static_cast<double>(shifted64[i].right) - shifted128[i].right)));
    }
    if (!check(basePeak64 == 4240 && basePeak128 == 4240,
               "5 ms BeatShift base latency is identical for 64- and 128-frame prepares") ||
        !check(shiftedPeak64 == 28240 && shiftedPeak128 == 28240,
               "positive one-beat control adds a real 24000-frame causal offset") ||
        !check(maxBlockScheduleDifference < 1.0e-7,
               "BeatShift PCM is invariant between 64- and 128-frame block schedules")) {
        std::fprintf(stderr, "BeatShift peaks base=%u/%u shifted=%u/%u\n",
                     basePeak64, basePeak128, shiftedPeak64, shiftedPeak128);
        std::fprintf(stderr, "BeatShift block-size max difference=%.9g\n",
                     maxBlockScheduleDifference);
        return false;
    }
    return true;
}

bool testBeatShiftSixSecondHistoryPath() {
    constexpr std::uint32_t inputFrame = 4096;
    constexpr std::uint32_t expectedDelay = 288240;
    constexpr std::uint32_t totalFrames = inputFrame + expectedDelay + 128;
    const auto shiftBudget = PerformanceFxProcessor::requiredPrepareBytes(
        spec(64), PerformanceFxKind::BeatShift);
    const auto ordinaryBudget = PerformanceFxProcessor::requiredPrepareBytes(
        spec(64), PerformanceFxKind::BeatScatter);
    if (!check(shiftBudget > ordinaryBudget,
               "BeatShift prepares its extended history budget rather than clamping long controls")) return false;
    BeatShift shift;
    if (!shift.prepare(spec(64))) return false;
    std::vector<StereoFrame> output(totalFrames);
    const std::array<PerformanceFxEvent, 3> events{{
        {0, PerformanceFxControl::TempoBpm, 20.0f},
        {0, PerformanceFxControl::ShiftBeats, 2.0f},
        {0, PerformanceFxControl::Active, 1.0f},
    }};
    for (std::uint32_t start = 0; start < totalFrames; start += 64) {
        const auto count = std::min<std::uint32_t>(64, totalFrames - start);
        if (start <= inputFrame && inputFrame < start + count)
            output[inputFrame] = {0.75f, -0.25f};
        if (!shift.processBlock(start, output.data() + start, count,
                                start == 0 ? events.data() : nullptr,
                                start == 0 ? 3U : 0U)) return false;
    }
    const auto observed = peakFrame(output);
    if (observed != inputFrame + expectedDelay) {
        std::fprintf(stderr, "BeatShift 6s path expected=%u observed=%u\n",
                     inputFrame + expectedDelay, observed);
    }
    std::printf("BeatShift 20BPM/+2beats: expectedDelay=%u frames (%.3f s), observedImpulse=%u, historyBudget=%zu bytes\n",
                expectedDelay, static_cast<double>(expectedDelay) / 48000.0, observed, shiftBudget);
    return check(observed == inputFrame + expectedDelay,
                 "20 BPM positive two-beat shift reads the impulse at its true 6 s offset");
}

} // namespace

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gWatchedAllocations.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc{};
}

void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gWatchedAllocations.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc{};
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    bool ok = true;
    ok = testPrepareBoundsAndEventTransactions() && ok;
    ok = testNegativeScatterKeepsCompleteTaggedGrainInHistory() && ok;
    ok = testStereoSeparationAndEffectBehavior() && ok;
    ok = testBeatRepeatCaptureWorkIsBoundedPerBlock() && ok;
    ok = testBeatShiftIsCausalAndBlockSizeInvariant() && ok;
    ok = testBeatShiftSixSecondHistoryPath() && ok;
    ok = testBlockInvariantAndNoAlloc<BeatScatter>("BeatScatter 64/256 block invariance") && ok;
    ok = testBlockInvariantAndNoAlloc<BeatRepeat>("BeatRepeat 64/256 block invariance") && ok;
    ok = testBlockInvariantAndNoAlloc<BeatShift>("BeatShift 64/256 block invariance") && ok;
    ok = testBlockInvariantAndNoAlloc<VinylFlick>("VinylFlick 64/256 block invariance") && ok;
    if (!ok) return 1;
    std::puts("PASS: track performance FX stereo history, sample events, bounded state, and noalloc tests");
    return 0;
}
