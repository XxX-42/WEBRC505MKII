#include "webrc/dsp/rhythm.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <vector>

namespace {

std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gWatchedAllocations{0};

constexpr std::array<webrc::dsp::RhythmEvent, 1> kKickAtQuarter{{
    {webrc::dsp::kRhythmTicksPerQuarter, webrc::dsp::RhythmInstrument::Kick, 112, false, 0},
}};
constexpr std::array<webrc::dsp::RhythmEvent, 1> kKickOnSwingOffbeat{{
    {webrc::dsp::kRhythmTicksPerQuarter / 2U, webrc::dsp::RhythmInstrument::Kick, 112, true, 0},
}};
constexpr std::array<webrc::dsp::RhythmEvent, 1> kKickAtStart{{
    {0, webrc::dsp::RhythmInstrument::Kick, 112, false, 0},
}};
constexpr std::array<webrc::dsp::RhythmEvent, 1> kSnareAtStart{{
    {0, webrc::dsp::RhythmInstrument::Snare, 100, false, 0},
}};
constexpr std::array<webrc::dsp::RhythmEvent, 1> kTomAtStart{{
    {0, webrc::dsp::RhythmInstrument::TomLow, 100, false, 0},
}};
constexpr std::array<webrc::dsp::RhythmEvent, 1> kRideAtStart{{
    {0, webrc::dsp::RhythmInstrument::Ride, 92, false, 0},
}};
constexpr std::array<webrc::dsp::RhythmEvent, 1> kHatAtStart{{
    {0, webrc::dsp::RhythmInstrument::ClosedHat, 92, false, 0},
}};
constexpr std::array<webrc::dsp::RhythmEvent, 1> kBrushAtStart{{
    {0, webrc::dsp::RhythmInstrument::BrushSweep, 80, false, 480},
}};

using namespace webrc::dsp;

RhythmPatternView makePattern(const RhythmEvent* mainEvents, std::uint32_t mainCount,
                              float swing = 0.0f) {
    RhythmPatternView pattern{};
    pattern.numerator = 4;
    pattern.denominator = 4;
    pattern.swingAmount = swing;
    for (auto& variation : pattern.variations) variation = {mainEvents, mainCount};
    pattern.intro = {kSnareAtStart.data(), 1};
    pattern.fill = {kTomAtStart.data(), 1};
    pattern.ending = {kRideAtStart.data(), 1};
    return pattern;
}

bool check(bool condition, const char* message) {
    if (!condition) std::fprintf(stderr, "FAIL: %s\n", message);
    return condition;
}

ProcessSpec testSpec(std::uint32_t maxBlock = 512) {
    return {48000.0f, maxBlock, 2};
}

struct Rendered {
    std::vector<float> left;
    std::vector<float> right;
    std::uint64_t eventCount = 0;
};

Rendered render(std::uint32_t blockSize, const RhythmPatternView& pattern,
                std::uint32_t kitIndex, std::uint32_t frames) {
    Rendered result{};
    result.left.resize(frames);
    result.right.resize(frames);
    RhythmRenderer renderer;
    if (!renderer.prepare(testSpec(512), 120.0) || !renderer.setPattern(&pattern) ||
        !renderer.setKit(kitIndex) || !renderer.startAtFrame(0, false)) return result;
    for (std::uint32_t offset = 0; offset < frames;) {
        const auto count = std::min(blockSize, frames - offset);
        if (!renderer.processBlock(offset, result.left.data() + offset,
                                   result.right.data() + offset, count)) return result;
        offset += count;
    }
    result.eventCount = renderer.triggeredEvents();
    return result;
}

std::uint64_t pcmHash(const std::vector<float>& samples) {
    std::uint64_t hash = 1469598103934665603ULL;
    for (float sample : samples) {
        std::uint32_t bits = 0;
        std::memcpy(&bits, &sample, sizeof(bits));
        hash ^= bits;
        hash *= 1099511628211ULL;
    }
    return hash;
}

struct KickFeatures {
    std::uint64_t pcm = 0;
    std::uint64_t earlyEnergy = 0;
    std::uint64_t bodyEnergy = 0;
    std::uint64_t tailEnergy = 0;
    std::uint32_t crossings = 0;
};

KickFeatures measureKick(const std::vector<float>& samples) {
    double early = 0.0;
    double body = 0.0;
    double tail = 0.0;
    std::uint32_t crossings = 0;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        const double square = static_cast<double>(samples[i]) * samples[i];
        if (i < 512) early += square;
        else if (i < 3072) body += square;
        else tail += square;
        if (i > 0 && ((samples[i] < 0.0f) != (samples[i - 1] < 0.0f))) ++crossings;
    }
    return {pcmHash(samples), static_cast<std::uint64_t>(std::llround(early * 1.0e12)),
            static_cast<std::uint64_t>(std::llround(body * 1.0e12)),
            static_cast<std::uint64_t>(std::llround(tail * 1.0e12)), crossings};
}

bool testValidationAndBounds() {
    RhythmRenderer renderer;
    if (!check(!renderer.prepare({48000.0f, 0, 2}, 120.0), "reject invalid process specification")) return false;
    if (!check(renderer.prepare(testSpec(), 120.0), "prepare renderer")) return false;
    if (!check(cleanRoomKitCount() == 16 && cleanRoomKitProfile(16) == nullptr,
               "kit table bounds are exact")) return false;
    auto pattern = makePattern(kKickAtQuarter.data(), 1);
    pattern.denominator = 5;
    if (!check(!renderer.setPattern(&pattern), "reject malformed meter")) return false;
    pattern = makePattern(kKickAtQuarter.data(), 1);
    const RhythmEvent badEvents[] = {{0, RhythmInstrument::BrushSweep, 90, false, 0}};
    pattern.variations[0] = {badEvents, 1};
    if (!check(!renderer.setPattern(&pattern), "reject brush sweep without bounded duration")) return false;
    if (!check(!renderer.queueTempo(std::numeric_limits<float>::quiet_NaN()), "reject nonfinite tempo")) return false;
    if (!check(!renderer.queueTempo(401.0f), "reject out-of-range tempo")) return false;
    return true;
}

bool testSampleAccurateSwingAndBlockInvariance() {
    const auto straightPattern = makePattern(kKickAtQuarter.data(), 1);
    const auto a = render(64, straightPattern, 0, 48000);
    const auto b = render(128, straightPattern, 0, 48000);
    const auto c = render(256, straightPattern, 0, 48000);
    if (!check(a.left.size() == 48000 && a.eventCount > 0, "straight fixture renders")) return false;
    if (!check(a.left == b.left && a.right == b.right && a.left == c.left && a.right == c.right,
               "64/128/256 block schedules produce identical PCM")) return false;
    for (std::size_t i = 0; i < 24000; ++i) {
        if (a.left[i] != 0.0f || a.right[i] != 0.0f) return check(false, "no pre-event audio");
    }
    const auto first = std::find_if(a.left.begin(), a.left.end(), [](float value) {
        return std::abs(value) > 1.0e-7f;
    });
    if (!check(first != a.left.end() && std::distance(a.left.begin(), first) >= 24000 &&
               std::distance(a.left.begin(), first) <= 24016,
               "quarter-note onset lands on the rounded absolute tick frame")) return false;

    const auto swingPattern = makePattern(kKickOnSwingOffbeat.data(), 1, 0.5f);
    const auto swung = render(128, swingPattern, 0, 20000);
    const auto swingFirst = std::find_if(swung.left.begin(), swung.left.end(), [](float value) {
        return std::abs(value) > 1.0e-7f;
    });
    if (!check(swingFirst != swung.left.end() && std::distance(swung.left.begin(), swingFirst) >= 16000 &&
               std::distance(swung.left.begin(), swingFirst) <= 16016,
               "eighth offbeat swing moves by the expected quarter-frame fraction")) return false;
    return true;
}

bool renderTo(RhythmRenderer& renderer, std::uint64_t& cursor, std::uint64_t target) {
    std::array<float, 256> left{};
    std::array<float, 256> right{};
    while (cursor < target) {
        const auto count = static_cast<std::uint32_t>(std::min<std::uint64_t>(256, target - cursor));
        if (!renderer.processBlock(cursor, left.data(), right.data(), count)) return false;
        cursor += count;
    }
    return true;
}

bool testTransitionsAndCommandPrecedence() {
    const auto pattern = makePattern(kKickAtStart.data(), 1);
    RhythmRenderer renderer;
    if (!check(renderer.prepare(testSpec(256), 120.0) && renderer.setPattern(&pattern) &&
               renderer.startAtFrame(0, true), "prepare transition fixture")) return false;
    std::uint64_t cursor = 0;
    if (!check(renderTo(renderer, cursor, 96000), "render intro bar")) return false;
    if (!check(renderer.currentSection() == RhythmSection::Intro && renderer.completedBars() == 0,
               "intro occupies its full first bar")) return false;
    if (!check(renderer.queueVariation(2) && renderer.queueFill(),
               "simultaneous variation and fill are accepted")) return false;
    std::array<float, 1> left{};
    std::array<float, 1> right{};
    if (!check(renderer.processBlock(cursor, left.data(), right.data(), 1), "advance to fill boundary")) return false;
    ++cursor;
    if (!check(renderer.currentSection() == RhythmSection::Fill && renderer.currentVariation() == 2,
               "fill runs while preserving its queued return variation")) return false;
    if (!check(renderTo(renderer, cursor, 192000), "render fill bar")) return false;
    if (!check(renderer.processBlock(cursor, left.data(), right.data(), 1), "advance after fill")) return false;
    ++cursor;
    if (!check(renderer.currentSection() == RhythmSection::VariationC && renderer.currentVariation() == 2,
               "fill returns to the queued variation on the next boundary")) return false;
    if (!check(renderer.queueEnding() && renderer.queueFill(), "queue ending over fill")) return false;
    if (!check(renderTo(renderer, cursor, 288000), "render variation bar")) return false;
    if (!check(renderer.processBlock(cursor, left.data(), right.data(), 1), "advance to ending")) return false;
    ++cursor;
    if (!check(renderer.currentSection() == RhythmSection::Ending,
               "ending has explicit priority over fill")) return false;
    if (!check(renderTo(renderer, cursor, 384000), "render ending bar")) return false;
    if (!check(renderer.processBlock(cursor, left.data(), right.data(), 1), "finish ending")) return false;
    if (!check(!renderer.playing() && renderer.currentSection() == RhythmSection::Stopped &&
               renderer.completedBars() == 4,
               "ending stops at its following bar boundary")) return false;
    return true;
}

bool testFractionalTempoAndVariableBlocks() {
    const auto pattern = makePattern(kKickAtStart.data(), 1);
    RhythmRenderer renderer;
    constexpr double newTempo = 137.3;
    constexpr double initialTempo = 123.456;
    if (!check(renderer.prepare(testSpec(512), initialTempo) && renderer.setPattern(&pattern) &&
               renderer.startAtFrame(0, false), "prepare tempo fixture")) return false;
    std::array<float, 512> left{};
    std::array<float, 512> right{};
    std::array<std::uint64_t, 9> observed{};
    std::uint32_t observedCount = 0;
    std::uint64_t frame = 0;
    std::uint64_t previousEvents = 0;
    bool tempoQueued = false;
    constexpr std::array<std::uint32_t, 4> blocks{{64, 128, 256, 512}};
    std::uint32_t blockIndex = 0;
    const auto ticksPerBar = 4ULL * kRhythmTicksPerQuarter;
    const auto q16 = [](double bpm) { return static_cast<double>(std::llround(bpm * 65536.0)) / 65536.0; };
    const double oldBar = static_cast<double>(ticksPerBar) * 48000.0 * 60.0 /
                          (q16(initialTempo) * kRhythmTicksPerQuarter);
    const double newBar = static_cast<double>(ticksPerBar) * 48000.0 * 60.0 /
                          (q16(newTempo) * kRhythmTicksPerQuarter);
    const std::uint64_t totalLimit = static_cast<std::uint64_t>(std::ceil(oldBar * 2 + newBar * 7 + 1024));
    while (frame < totalLimit && observedCount < observed.size()) {
        const auto count = static_cast<std::uint32_t>(std::min<std::uint64_t>(blocks[blockIndex++ % blocks.size()], totalLimit - frame));
        if (!renderer.processBlock(frame, left.data(), right.data(), count)) return check(false, "fractional tempo callback succeeds");
        frame += count;
        const auto events = renderer.triggeredEvents();
        if (events != previousEvents) {
            observed[observedCount++] = renderer.lastTriggeredFrame();
            previousEvents = events;
            if (renderer.completedBars() == 2 && !tempoQueued) {
                if (!renderer.queueTempo(newTempo)) return check(false, "queue bounded tempo change");
                tempoQueued = true;
            }
        }
    }
    if (!check(observedCount == observed.size(), "collect eight downbeat event timestamps")) return false;
    std::array<std::uint64_t, 9> expected{};
    expected[0] = 0;
    double exact = 0.0;
    for (std::uint32_t i = 1; i < expected.size(); ++i) {
        exact += i <= 2 ? oldBar : newBar;
        expected[i] = static_cast<std::uint64_t>(std::round(exact));
    }
    for (std::uint32_t i = 0; i < observed.size(); ++i) {
        if (!check(observed[i] == expected[i], "absolute downbeat matches fractional-tempo phase reference")) return false;
    }
    return true;
}

bool testNoAllocAndTimelineDiscontinuity() {
    const auto pattern = makePattern(kKickAtStart.data(), 1);
    RhythmRenderer renderer;
    if (!check(renderer.prepare(testSpec(256), 120.0) && renderer.setPattern(&pattern) &&
               renderer.startAtFrame(0, false), "prepare allocation fixture")) return false;
    std::array<float, 256> left{};
    std::array<float, 256> right{};
    gWatchedAllocations.store(0, std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_release);
    for (std::uint64_t block = 0; block < 64; ++block) {
        if (!renderer.processBlock(block * 256, left.data(), right.data(), 256)) {
            gWatchAllocations.store(false, std::memory_order_release);
            return check(false, "realtime callback succeeds during allocation watch");
        }
    }
    gWatchAllocations.store(false, std::memory_order_release);
    if (!check(gWatchedAllocations.load(std::memory_order_relaxed) == 0,
               "renderer callback performs no heap allocation")) return false;
    std::fill(left.begin(), left.end(), 1.0f);
    std::fill(right.begin(), right.end(), 1.0f);
    if (!check(!renderer.processBlock(64 * 256 + 1, left.data(), right.data(), 256),
               "reject discontinuous absolute frame timeline")) return false;
    if (!check(std::all_of(left.begin(), left.end(), [](float x) { return x == 0.0f; }) &&
               std::all_of(right.begin(), right.end(), [](float x) { return x == 0.0f; }),
               "timeline discontinuity returns silence and resets transport")) return false;
    return true;
}

bool testKitAudioFeaturesAndBrushSweep() {
    const auto kickPattern = makePattern(kKickAtStart.data(), 1);
    std::array<KickFeatures, 16> features{};
    std::array<std::uint64_t, 16> pcmHashes{};
    for (std::uint32_t kit = 0; kit < cleanRoomKitCount(); ++kit) {
        const auto rendered = render(256, kickPattern, kit, 8192);
        if (!check(rendered.eventCount > 0 && rendered.left.size() == 8192,
                   "each kit renders its kick voice")) return false;
        if (!check(std::all_of(rendered.left.begin(), rendered.left.end(), [](float x) { return std::isfinite(x); }),
                   "kit output remains finite")) return false;
        features[kit] = measureKick(rendered.left);
        pcmHashes[kit] = features[kit].pcm;
    }
    for (std::uint32_t i = 0; i < pcmHashes.size(); ++i) {
        for (std::uint32_t j = i + 1; j < pcmHashes.size(); ++j) {
            if (!check(pcmHashes[i] != pcmHashes[j], "all 16 kick profiles produce distinct PCM")) return false;
            const bool featureEqual = features[i].earlyEnergy == features[j].earlyEnergy &&
                features[i].bodyEnergy == features[j].bodyEnergy &&
                features[i].tailEnergy == features[j].tailEnergy &&
                features[i].crossings == features[j].crossings;
            if (!check(!featureEqual, "kit kick spectral/envelope feature vectors are distinguishable")) return false;
        }
    }

    const auto* brushKit = cleanRoomKitProfile(7);
    if (!check(brushKit && std::strcmp(brushKit->name, "BRUSH") == 0 &&
               brushKit->brushSweepAmplitude > 0.3f && brushKit->brushSweepSeconds > 0.4f,
               "BRUSH profile exposes a longer, softer procedural sweep")) return false;
    const auto brushPattern = makePattern(kBrushAtStart.data(), 1);
    const auto brush = render(128, brushPattern, 7, 18000);
    if (!check(brush.eventCount > 0 && std::any_of(brush.left.begin(), brush.left.begin() + 11000,
               [](float x) { return std::abs(x) > 1.0e-6f; }), "brush sweep produces audible stereo noise")) return false;
    if (!check(std::all_of(brush.left.begin() + 12000, brush.left.end(), [](float x) { return x == 0.0f; }),
               "brush sweep has a bounded event duration")) return false;
    return true;
}

} // namespace

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed)) {
        gWatchedAllocations.fetch_add(1, std::memory_order_relaxed);
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc{};
}

void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed)) {
        gWatchedAllocations.fetch_add(1, std::memory_order_relaxed);
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc{};
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    bool ok = true;
    ok = testValidationAndBounds() && ok;
    ok = testSampleAccurateSwingAndBlockInvariance() && ok;
    ok = testTransitionsAndCommandPrecedence() && ok;
    ok = testFractionalTempoAndVariableBlocks() && ok;
    ok = testNoAllocAndTimelineDiscontinuity() && ok;
    ok = testKitAudioFeaturesAndBrushSweep() && ok;
    if (!ok) return 1;
    std::puts("PASS: rhythm renderer sample timing, fractional tempo, transitions, noalloc, and kit audio tests");
    return 0;
}
