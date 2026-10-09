#include "webrc/dsp/rhythm.hpp"
#include "webrc/dsp/cleanroom_rhythm_data.hpp"

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

struct AudioFeatures {
    std::uint64_t attackEnergy = 0;
    std::uint64_t bodyEnergy = 0;
    std::uint64_t tailEnergy = 0;
    std::uint64_t lowBandEnergy = 0;
    std::uint64_t highBandEnergy = 0;
    std::uint64_t stereoDifference = 0;
    std::uint32_t crossings = 0;
};

AudioFeatures measureAudio(const std::vector<float>& left, const std::vector<float>& right) {
    double attack = 0.0;
    double body = 0.0;
    double tail = 0.0;
    double lowBand = 0.0;
    double highBand = 0.0;
    double stereoDifference = 0.0;
    double lowState = 0.0;
    double highState = 0.0;
    std::uint32_t crossings = 0;
    const double lowCoefficient = std::exp(-2.0 * 3.14159265358979323846 * 140.0 / 48000.0);
    const double highCoefficient = std::exp(-2.0 * 3.14159265358979323846 * 4200.0 / 48000.0);
    for (std::size_t i = 0; i < left.size(); ++i) {
        const double sample = left[i];
        const double lowSample = lowCoefficient * lowState + (1.0 - lowCoefficient) * sample;
        const double highStateNow = highCoefficient * highState + (1.0 - highCoefficient) * sample;
        lowState = lowSample;
        highState = highStateNow;
        const double highSample = sample - highStateNow;
        const double square = sample * sample;
        if (i < 256) attack += square;
        else if (i < 2048) body += square;
        else tail += square;
        lowBand += lowSample * lowSample;
        highBand += highSample * highSample;
        const double difference = static_cast<double>(left[i]) - right[i];
        stereoDifference += difference * difference;
        if (i > 0 && ((left[i] < 0.0f) != (left[i - 1] < 0.0f))) ++crossings;
    }
    const auto quantize = [](double value) {
        return static_cast<std::uint64_t>(std::llround(value * 1.0e12));
    };
    return {quantize(attack), quantize(body), quantize(tail), quantize(lowBand),
            quantize(highBand), quantize(stereoDifference), crossings};
}

bool featureVectorsDiffer(const AudioFeatures& a, const AudioFeatures& b) {
    return a.attackEnergy != b.attackEnergy || a.bodyEnergy != b.bodyEnergy ||
        a.tailEnergy != b.tailEnergy || a.lowBandEnergy != b.lowBandEnergy ||
        a.highBandEnergy != b.highBandEnergy || a.stereoDifference != b.stereoDifference ||
        a.crossings != b.crossings;
}

double normalizedFeatureDistance(const AudioFeatures& a, const AudioFeatures& b,
                                 const std::array<double, 7>& scales) {
    const std::array<double, 7> av{{static_cast<double>(a.attackEnergy),
        static_cast<double>(a.bodyEnergy), static_cast<double>(a.tailEnergy),
        static_cast<double>(a.lowBandEnergy), static_cast<double>(a.highBandEnergy),
        static_cast<double>(a.stereoDifference), static_cast<double>(a.crossings)}};
    const std::array<double, 7> bv{{static_cast<double>(b.attackEnergy),
        static_cast<double>(b.bodyEnergy), static_cast<double>(b.tailEnergy),
        static_cast<double>(b.lowBandEnergy), static_cast<double>(b.highBandEnergy),
        static_cast<double>(b.stereoDifference), static_cast<double>(b.crossings)}};
    double squareDistance = 0.0;
    for (std::size_t i = 0; i < av.size(); ++i) {
        const double scale = scales[i] > 0.0 ? scales[i] : 1.0;
        const double delta = (av[i] - bv[i]) / scale;
        squareDistance += delta * delta;
    }
    return std::sqrt(squareDistance / static_cast<double>(av.size()));
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
    pattern = makePattern(kKickAtQuarter.data(), 1);
    if (!check(renderer.setPattern(&pattern), "restore a valid pattern before timestamp check")) return false;
    const RhythmEvent outOfBar[] = {{3840, RhythmInstrument::Kick, 90, false, 0}};
    pattern.variations[0] = {outOfBar, 1};
    if (!check(!renderer.setPattern(&pattern), "reject tick at the exclusive bar boundary")) return false;
    const RhythmEvent invalidSwing[] = {{720, RhythmInstrument::Kick, 90, true, 0}};
    pattern = makePattern(invalidSwing, 1, 0.5f);
    if (!check(!renderer.setPattern(&pattern), "reject swing marker away from an eighth offbeat")) return false;
    const RhythmEvent duplicateEvents[] = {
        {480, RhythmInstrument::Kick, 90, true, 0},
        {480, RhythmInstrument::Kick, 80, true, 0},
    };
    pattern = makePattern(duplicateEvents, 2, 0.5f);
    if (!check(!renderer.setPattern(&pattern), "reject duplicate instrument/tick collisions")) return false;
    const RhythmEvent unsortedEvents[] = {
        {960, RhythmInstrument::Kick, 90, false, 0},
        {480, RhythmInstrument::Snare, 80, true, 0},
    };
    pattern = makePattern(unsortedEvents, 2, 0.5f);
    if (!check(!renderer.setPattern(&pattern), "reject events not ordered by tick")) return false;
    std::array<RhythmEvent, RhythmRenderer::kMaxEventsPerSection + 1U> tooMany{};
    for (std::uint32_t index = 0; index < tooMany.size(); ++index) {
        const auto instrument = static_cast<RhythmInstrument>(index % static_cast<std::uint32_t>(RhythmInstrument::Count));
        tooMany[index] = { (index / static_cast<std::uint32_t>(RhythmInstrument::Count)) * 240U,
                           instrument, 80, false,
                           instrument == RhythmInstrument::BrushSweep ? 480U : 0U };
    }
    pattern = makePattern(tooMany.data(), static_cast<std::uint32_t>(tooMany.size()));
    if (!check(!renderer.setPattern(&pattern), "reject list exceeding the fixed event pool")) return false;
    if (!check(!renderer.queueTempo(std::numeric_limits<float>::quiet_NaN()), "reject nonfinite tempo")) return false;
    if (!check(!renderer.queueTempo(401.0f), "reject out-of-range tempo")) return false;
    if (!check(!renderer.startAtFrame(std::numeric_limits<std::uint64_t>::max()),
               "reject timestamps beyond exact binary64 frame range")) return false;
    return true;
}

bool testGeneratedCleanRoomTables() {
    if (!check(cleanRoomRhythmPatternCount() == 240 && cleanRoomRhythmPattern(240) == nullptr,
               "generated pattern accessor exposes exactly 240 entries")) return false;
    if (!check(std::strlen(cleanRoomRhythmPatternsSha256()) == 64 &&
               std::strlen(cleanRoomKitProfilesSha256()) == 64,
               "generated pattern and kit tables expose input hashes")) return false;
    RhythmRenderer renderer;
    if (!check(renderer.prepare(testSpec(), 120.0), "prepare generated table validation")) return false;
    for (std::uint32_t index = 0; index < cleanRoomRhythmPatternCount(); ++index) {
        const auto* pattern = cleanRoomRhythmPattern(index);
        if (!check(pattern != nullptr && renderer.setPattern(pattern),
                   "every generated A-D/intro/fill/end table validates for runtime")) return false;
    }
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

    constexpr double swingTempo = 137.3;
    const auto fractionalSwingPattern = makePattern(kKickOnSwingOffbeat.data(), 1, 0.35f);
    RhythmRenderer fractionalSwing;
    if (!check(fractionalSwing.prepare(testSpec(512), swingTempo) &&
               fractionalSwing.setPattern(&fractionalSwingPattern) &&
               fractionalSwing.startAtFrame(0, false), "prepare fractional swing fixture")) return false;
    const double q16SwingTempo = static_cast<double>(std::llround(swingTempo * 65536.0)) / 65536.0;
    const double quarterFrames = 48000.0 * 60.0 / q16SwingTempo;
    const auto expectedSwingFrame = static_cast<std::uint64_t>(std::round(
        quarterFrames * (0.5 + 0.35 / 3.0)));
    constexpr std::array<std::uint32_t, 4> swingBlocks{{64, 128, 256, 512}};
    std::uint64_t swingFrame = 0;
    std::uint32_t swingBlockIndex = 0;
    std::array<float, 512> fractionalLeft{};
    std::array<float, 512> fractionalRight{};
    while (fractionalSwing.triggeredEvents() == 0 && swingFrame < expectedSwingFrame + 512U) {
        const auto count = swingBlocks[swingBlockIndex++ % swingBlocks.size()];
        if (!check(fractionalSwing.processBlock(swingFrame, fractionalLeft.data(),
                                                fractionalRight.data(), count),
                   "fractional swing callback succeeds across variable blocks")) return false;
        swingFrame += count;
    }
    if (!check(fractionalSwing.lastTriggeredFrame() == expectedSwingFrame,
               "fractional swing rounds the combined exact frame once")) return false;

    RhythmRenderer lateStart;
    const auto startPattern = makePattern(kKickAtStart.data(), 1);
    if (!check(lateStart.prepare(testSpec(128), 120.0) &&
               lateStart.setPattern(&startPattern) && lateStart.startAtFrame(37, false),
               "prepare future-start fixture")) return false;
    std::array<float, 128> startLeft{};
    std::array<float, 128> startRight{};
    if (!check(lateStart.processBlock(0, startLeft.data(), startRight.data(), 128),
               "process block spanning the requested start")) return false;
    if (!check(lateStart.lastTriggeredFrame() == 37,
               "future start event timestamp is sample accurate inside a block")) return false;

    RhythmRenderer clampedStart;
    if (!check(clampedStart.prepare(testSpec(128), 120.0) &&
               clampedStart.setPattern(&startPattern) && clampedStart.startAtFrame(0, false),
               "prepare late-start clamp fixture")) return false;
    startLeft.fill(0.0f);
    startRight.fill(0.0f);
    if (!check(clampedStart.processBlock(64, startLeft.data(), startRight.data(), 128),
               "process first block after requested start")) return false;
    if (!check(clampedStart.lastTriggeredFrame() == 64,
               "late requested start clamps to the first available frame without catch-up")) return false;
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
    if (!check(renderer.queueVariation(1) && renderer.queueVariation(2) && renderer.queueFill(),
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
    if (!check(renderer.queueEnding() && renderer.queueStop() && renderer.queueFill(),
               "queue ending over stop and fill")) return false;
    if (!check(renderTo(renderer, cursor, 288000), "render variation bar")) return false;
    if (!check(renderer.processBlock(cursor, left.data(), right.data(), 1), "advance to ending")) return false;
    ++cursor;
    if (!check(renderer.currentSection() == RhythmSection::Ending,
               "ending has explicit priority over fill")) return false;
    if (!check(renderer.queueFill() && renderer.queueVariation(3) && renderer.queueTempo(155.5),
               "terminal-ending controls can be queued but remain bounded")) return false;
    if (!check(renderTo(renderer, cursor, 384000), "render ending bar")) return false;
    if (!check(renderer.processBlock(cursor, left.data(), right.data(), 1), "finish ending")) return false;
    ++cursor;
    if (!check(!renderer.playing() && renderer.currentSection() == RhythmSection::Stopped &&
               renderer.completedBars() == 4,
               "ending stops at its following bar boundary")) return false;
    if (!check(renderer.tempoBpm() < 120.001 && renderer.tempoBpm() > 119.999,
               "tempo queued during the ending is discarded on terminal stop")) return false;
    if (!check(renderer.startAtFrame(cursor, false), "renderer can restart after terminal stop")) return false;
    if (!check(renderer.processBlock(cursor, left.data(), right.data(), 1), "start the restarted transport")) return false;
    ++cursor;
    if (!check(renderTo(renderer, cursor, 480000), "render restarted variation bar")) return false;
    if (!check(renderer.processBlock(cursor, left.data(), right.data(), 1), "advance restarted bar boundary")) return false;
    ++cursor;
    if (!check(renderer.currentSection() == RhythmSection::VariationA && renderer.playing(),
               "terminal fill/variation commands do not leak into a later start")) return false;

    RhythmRenderer stopRenderer;
    if (!check(stopRenderer.prepare(testSpec(256), 120.0) &&
               stopRenderer.setPattern(&pattern) && stopRenderer.startAtFrame(0, false),
               "prepare stop-versus-fill fixture")) return false;
    cursor = 0;
    if (!check(renderTo(stopRenderer, cursor, 96000), "render initial variation bar")) return false;
    if (!check(stopRenderer.queueStop() && stopRenderer.queueFill(), "queue stop over fill")) return false;
    if (!check(stopRenderer.processBlock(cursor, left.data(), right.data(), 1), "advance stop boundary")) return false;
    if (!check(!stopRenderer.playing() && stopRenderer.currentSection() == RhythmSection::Stopped,
               "stop outranks fill at a bar boundary")) return false;
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
                if (!renderer.queueTempo(160.0) || !renderer.queueTempo(newTempo)) {
                    return check(false, "queue bounded latest-wins tempo changes");
                }
                tempoQueued = true;
            }
        }
    }
    if (!check(observedCount == observed.size(), "collect eight downbeat event timestamps")) return false;
    std::array<std::uint64_t, 9> expected{};
    expected[0] = 0;
    double exact = 0.0;
    for (std::uint32_t i = 1; i < expected.size(); ++i) {
        // The control is queued after the event at bar 2, so it is consumed
        // at the bar-3 boundary and changes the following interval.
        exact += i <= 3 ? oldBar : newBar;
        expected[i] = static_cast<std::uint64_t>(std::round(exact));
    }
    for (std::uint32_t i = 0; i < observed.size(); ++i) {
        if (observed[i] != expected[i]) {
            std::fprintf(stderr, "timestamp[%u] observed=%llu expected=%llu\n", i,
                         static_cast<unsigned long long>(observed[i]),
                         static_cast<unsigned long long>(expected[i]));
            return check(false, "absolute downbeat matches fractional-tempo phase reference");
        }
    }
    if (!check(std::abs(renderer.tempoBpm() - q16(newTempo)) < 1.0e-12,
               "latest queued Q16.16 tempo becomes active")) return false;
    return true;
}

bool testNoAllocAndTimelineDiscontinuity() {
    std::array<RhythmEvent, RhythmRenderer::kMaxEventsPerSection> denseEvents{};
    for (std::uint32_t index = 0; index < denseEvents.size(); ++index) {
        const auto instrument = static_cast<RhythmInstrument>(index % static_cast<std::uint32_t>(RhythmInstrument::Count));
        denseEvents[index] = {
            (index / static_cast<std::uint32_t>(RhythmInstrument::Count)) * 240U,
            instrument, static_cast<std::uint8_t>(72U + index % 48U), false,
            instrument == RhythmInstrument::BrushSweep ? 480U : 0U,
        };
    }
    const auto pattern = makePattern(denseEvents.data(), static_cast<std::uint32_t>(denseEvents.size()));
    RhythmRenderer renderer;
    if (!check(renderer.prepare(testSpec(256), 400.0) && renderer.setPattern(&pattern) &&
               renderer.startAtFrame(0, false), "prepare allocation fixture")) return false;
    std::array<float, 256> left{};
    std::array<float, 256> right{};
    gWatchedAllocations.store(0, std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_release);
    constexpr std::uint64_t kWatchedBlocks = 128;
    for (std::uint64_t block = 0; block < kWatchedBlocks; ++block) {
        if (!renderer.processBlock(block * 256, left.data(), right.data(), 256)) {
            gWatchAllocations.store(false, std::memory_order_release);
            return check(false, "realtime callback succeeds during allocation watch");
        }
    }
    gWatchAllocations.store(false, std::memory_order_release);
    if (!check(gWatchedAllocations.load(std::memory_order_relaxed) == 0,
               "dense 192-event callbacks and bar-boundary staging perform no heap allocation")) return false;
    if (!check(renderer.completedBars() >= 1, "allocation window crosses a bar transition")) return false;
    std::fill(left.begin(), left.end(), 1.0f);
    std::fill(right.begin(), right.end(), 1.0f);
    if (!check(!renderer.processBlock(kWatchedBlocks * 256 + 1, left.data(), right.data(), 256),
               "reject discontinuous absolute frame timeline")) return false;
    if (!check(std::all_of(left.begin(), left.end(), [](float x) { return x == 0.0f; }) &&
               std::all_of(right.begin(), right.end(), [](float x) { return x == 0.0f; }),
               "timeline discontinuity returns silence and resets transport")) return false;
    std::fill(left.begin(), left.end(), 1.0f);
    std::fill(right.begin(), right.end(), 1.0f);
    if (!check(!renderer.processBlock(std::numeric_limits<std::uint64_t>::max(),
                                     left.data(), right.data(), 256),
               "reject uint64 overflow / inexact absolute timeline")) return false;
    if (!check(std::all_of(left.begin(), left.end(), [](float x) { return x == 0.0f; }) &&
               std::all_of(right.begin(), right.end(), [](float x) { return x == 0.0f; }),
               "invalid absolute timeline is silenced")) return false;
    return true;
}

bool testKitAudioFeaturesAndBrushSweep() {
    const auto compareVoiceAcrossKits = [](RhythmInstrument instrument,
                                           const char* label,
                                           std::uint32_t frames) {
        const RhythmEvent event{0, instrument, 100, false,
                                instrument == RhythmInstrument::BrushSweep ? 480U : 0U};
        const auto pattern = makePattern(&event, 1);
        std::array<AudioFeatures, 16> featureSets{};
        std::array<std::uint64_t, 16> pcmHashes{};
        for (std::uint32_t kit = 0; kit < cleanRoomKitCount(); ++kit) {
            const auto rendered = render(256, pattern, kit, frames);
            if (!check(rendered.eventCount > 0 && rendered.left.size() == frames,
                       label)) return false;
            if (!check(std::all_of(rendered.left.begin(), rendered.left.end(), [](float x) { return std::isfinite(x); }) &&
                       std::all_of(rendered.right.begin(), rendered.right.end(), [](float x) { return std::isfinite(x); }),
                       "kit voice output remains finite")) return false;
            featureSets[kit] = measureAudio(rendered.left, rendered.right);
            pcmHashes[kit] = pcmHash(rendered.left);
        }
        for (std::uint32_t i = 0; i < featureSets.size(); ++i) {
            for (std::uint32_t j = i + 1; j < featureSets.size(); ++j) {
                if (!check(pcmHashes[i] != pcmHashes[j], "same event seed yields profile-specific PCM")) return false;
                if (!check(featureVectorsDiffer(featureSets[i], featureSets[j]),
                           "same event seed yields a measurable timbre/envelope feature difference")) return false;
            }
        }
        std::array<double, 7> scales{};
        for (const auto& features : featureSets) {
            const std::array<double, 7> values{{static_cast<double>(features.attackEnergy),
                static_cast<double>(features.bodyEnergy), static_cast<double>(features.tailEnergy),
                static_cast<double>(features.lowBandEnergy), static_cast<double>(features.highBandEnergy),
                static_cast<double>(features.stereoDifference), static_cast<double>(features.crossings)}};
            for (std::size_t i = 0; i < scales.size(); ++i) scales[i] = std::max(scales[i], values[i]);
        }
        double minimumDistance = std::numeric_limits<double>::infinity();
        for (std::uint32_t i = 0; i < featureSets.size(); ++i) {
            for (std::uint32_t j = i + 1; j < featureSets.size(); ++j) {
                minimumDistance = std::min(minimumDistance,
                    normalizedFeatureDistance(featureSets[i], featureSets[j], scales));
            }
        }
        if (!check(std::isfinite(minimumDistance) && minimumDistance > 0.0,
                   "same-seed kit profiles have nonzero normalized numeric feature distance")) return false;
        std::printf("KIT_NUMERIC_FEATURES instrument=%u min_normalized_distance=%.9g; proxy metrics only, no perceptual/listening evaluation\n",
                    static_cast<unsigned>(instrument), minimumDistance);
        return true;
    };

    if (!compareVoiceAcrossKits(RhythmInstrument::Kick, "each kit renders its kick voice", 8192) ||
        !compareVoiceAcrossKits(RhythmInstrument::Snare, "each kit renders its snare voice", 8192) ||
        !compareVoiceAcrossKits(RhythmInstrument::ClosedHat, "each kit renders its hat voice", 8192) ||
        !compareVoiceAcrossKits(RhythmInstrument::TomLow, "each kit renders its modal body voice", 8192) ||
        !compareVoiceAcrossKits(RhythmInstrument::BrushSweep, "each kit renders its timed brush articulation", 18000)) {
        return false;
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

    constexpr std::uint32_t kOverlapEvents = 40;
    std::array<RhythmEvent, kOverlapEvents> overlapEvents{};
    for (std::uint32_t i = 0; i < kOverlapEvents; ++i) {
        overlapEvents[i] = {i * 2U, RhythmInstrument::BrushSweep, 100, false, 240};
    }
    const auto overlapPattern = makePattern(overlapEvents.data(), kOverlapEvents);
    RhythmRenderer overlapRenderer;
    if (!check(overlapRenderer.prepare({8000.0f, 64, 2}, 400.0) &&
               overlapRenderer.setPattern(&overlapPattern) && overlapRenderer.setKit(7) &&
               overlapRenderer.startAtFrame(0, false),
               "prepare the minimum-rate dense brush overlap fixture")) return false;
    std::array<float, 512> overlapLeft{};
    std::array<float, 512> overlapRight{};
    std::uint32_t maxActiveBrushes = 0;
    std::uint32_t maxRetiringBrushes = 0;
    gWatchedAllocations.store(0, std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_release);
    bool overlapRenderOk = true;
    for (std::uint32_t offset = 0; offset < overlapLeft.size(); offset += 64) {
        if (!overlapRenderer.processBlock(offset, overlapLeft.data() + offset,
                                          overlapRight.data() + offset, 64)) {
            overlapRenderOk = false;
            break;
        }
        maxActiveBrushes = std::max(maxActiveBrushes, overlapRenderer.activeBrushSweepVoices());
        maxRetiringBrushes = std::max(maxRetiringBrushes, overlapRenderer.retiringBrushSweepVoices());
    }
    gWatchAllocations.store(false, std::memory_order_release);
    if (!check(overlapRenderOk && overlapRenderer.triggeredEvents() == kOverlapEvents,
               "all overlapping brush sweeps trigger through the fixed voice pool")) return false;
    if (!check(gWatchedAllocations.load(std::memory_order_relaxed) == 0,
               "brush voice steals and retirement crossfades allocate no heap memory")) return false;
    if (!check(maxActiveBrushes == RhythmRenderer::kBrushSweepVoiceCount && maxRetiringBrushes > 0,
               "dense brush stream exercises active capacity and old/new retirement crossfades")) return false;
    if (!check(overlapLeft[0] == 0.0f && overlapRight[0] == 0.0f,
               "brush attack begins at exact zero at the first event frame")) return false;
    double energy = 0.0;
    double peak = 0.0;
    double maxStep = 0.0;
    double maxEventBoundaryStep = 0.0;
    for (std::size_t i = 0; i < overlapLeft.size(); ++i) {
        if (!std::isfinite(overlapLeft[i]) || !std::isfinite(overlapRight[i])) return false;
        energy += static_cast<double>(overlapLeft[i]) * overlapLeft[i] +
                  static_cast<double>(overlapRight[i]) * overlapRight[i];
        peak = std::max({peak, std::abs(static_cast<double>(overlapLeft[i])),
                         std::abs(static_cast<double>(overlapRight[i]))});
        if (i > 0) {
            const double step = std::max(std::abs(static_cast<double>(overlapLeft[i] - overlapLeft[i - 1])),
                                         std::abs(static_cast<double>(overlapRight[i] - overlapRight[i - 1])));
            maxStep = std::max(maxStep, step);
            for (std::uint32_t event = 1; event < kOverlapEvents; ++event) {
                const auto expectedFrame = static_cast<std::size_t>(std::llround(event * 2.5));
                if (i + 1 >= expectedFrame && i <= expectedFrame + 1U) {
                    maxEventBoundaryStep = std::max(maxEventBoundaryStep, step);
                }
            }
        }
    }
    const double rms = std::sqrt(energy / (2.0 * overlapLeft.size()));
    std::printf("BRUSH_OVERLAP sample_rate=8000 bpm=400 events=%u max_active=%u max_retiring=%u rms=%.9g peak=%.9g max_step=%.9g event_boundary_max_step=%.9g normalized_step=%.9g\n",
                kOverlapEvents, maxActiveBrushes, maxRetiringBrushes, rms, peak,
                maxStep, maxEventBoundaryStep, maxStep / std::max(rms, 1.0e-15));
    if (!check(rms > 0.0 && peak < 0.5 && maxStep < 0.12 && maxEventBoundaryStep < 0.12,
               "brush attack and steal crossfades keep dense-stream boundary steps bounded")) return false;
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
    ok = testGeneratedCleanRoomTables() && ok;
    ok = testSampleAccurateSwingAndBlockInvariance() && ok;
    ok = testTransitionsAndCommandPrecedence() && ok;
    ok = testFractionalTempoAndVariableBlocks() && ok;
    ok = testNoAllocAndTimelineDiscontinuity() && ok;
    ok = testKitAudioFeaturesAndBrushSweep() && ok;
    if (!ok) return 1;
    std::puts("PASS: rhythm renderer sample timing, fractional tempo, transitions, noalloc, and kit audio tests");
    return 0;
}
