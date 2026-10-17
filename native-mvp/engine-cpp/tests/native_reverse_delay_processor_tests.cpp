#include "native_reverse_delay_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <limits>
#include <vector>

using namespace webrc::native;

namespace {

void expectNear(float actual, float expected, float tolerance = 2.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

NativeReverseDelayConfig shortSegmentConfig() {
    NativeReverseDelayConfig config;
    config.bpm = 300.0f;
    config.segmentBeats = 0.25f;
    config.feedbackPercent = 0.0f;
    config.crossfadeMs = 1.0f;
    config.mixPercent = 100.0f;
    return config;
}

void testPrepareBoundsAndSampleClockedTempoLatch() {
    NativeReverseDelayProcessor processor;
    assert(!processor.prepare(7999U));
    assert(processor.prepare(8000U));
    assert(processor.sampleRate() == 8000U);
    assert(processor.maxSegmentFrames() == 64001U);

    auto config = shortSegmentConfig();
    assert(processor.setConfig(config, 0U));
    auto status = processor.status();
    assert(status.activeSegmentFrames == 400U);
    assert(status.wetLookaheadFrames == 800U);
    assert(status.causalSegmentLatencyFrames == 1200U);
    assert(status.maxSegmentFrames <= static_cast<std::size_t>(processor.sampleRate()) * 8U + 1U);

    std::vector<float> partial(399U * 2U, 0.125f);
    (void)processor.processInPlace(partial.data(), 399U, 2U);
    auto changed = config;
    changed.bpm = 150.0f;
    changed.segmentBeats = 0.5f;
    assert(processor.setConfig(changed, 0U));
    status = processor.status();
    assert(status.captureFrames == 399U);
    assert(status.activeSegmentFrames == 400U); // Tempo changes latch at the next edge.

    std::array<float, 2U> finalFrame{{0.125f, 0.125f}};
    (void)processor.processInPlace(finalFrame.data(), 1U, 2U);
    status = processor.status();
    assert(status.boundaryCount == 1U);
    assert(status.hasCapturedSegment);
    assert(status.playbackFrames == 400U);
    assert(status.activeSegmentFrames == 1600U);
    assert(status.captureFrames == 0U);
    assert(status.causalSegmentLatencyFrames == 2400U);

    assert(!processor.prepare(192001U));
    assert(processor.sampleRate() == 8000U); // Invalid re-prepare preserves the prepared state.
}

void testReverseOrderAndCausalOverlapCrossfade() {
    constexpr unsigned int rate = 8000U;
    constexpr std::size_t segmentFrames = 400U;
    NativeReverseDelayProcessor processor;
    assert(processor.prepare(rate));
    auto config = shortSegmentConfig();
    assert(processor.setConfig(config, 0U));

    const std::size_t lookahead = processor.status().wetLookaheadFrames;
    const std::size_t fadeFrames = 8U; // 1 ms at 8 kHz.
    const std::size_t totalFrames = (3U * segmentFrames) + lookahead;
    std::vector<float> audio(totalFrames * 2U, 0.0f);
    std::array<float, segmentFrames> firstSegment{};
    std::array<float, segmentFrames> secondSegment{};
    for (std::size_t frame = 0U; frame < segmentFrames; ++frame) {
        firstSegment[frame] = 0.2f + static_cast<float>(frame) * 0.0001f;
        secondSegment[frame] = -0.4f + static_cast<float>(frame) * 0.0001f;
        audio[frame * 2U] = firstSegment[frame];
        audio[frame * 2U + 1U] = firstSegment[frame];
        audio[(segmentFrames + frame) * 2U] = secondSegment[frame];
        audio[(segmentFrames + frame) * 2U + 1U] = secondSegment[frame];
    }

    (void)processor.processInPlace(audio.data(), static_cast<unsigned int>(totalFrames), 2U);
    for (std::size_t frame = 0U; frame < segmentFrames + lookahead; ++frame) {
        expectNear(audio[frame * 2U], 0.0f, 1.0e-7f);
    }

    // The captured segment is read backward only after all 400 frames arrive.
    for (std::size_t reverseFrame = 0U; reverseFrame < segmentFrames - fadeFrames; ++reverseFrame) {
        const std::size_t outputFrame = segmentFrames + lookahead + reverseFrame;
        expectNear(audio[outputFrame * 2U], firstSegment[segmentFrames - 1U - reverseFrame]);
        expectNear(audio[outputFrame * 2U + 1U], firstSegment[segmentFrames - 1U - reverseFrame]);
    }

    // At the next edge, the held tail of segment zero is equal-power crossed
    // into the reverse head of segment one. Both sources contribute in the
    // interior of the non-zero fade window.
    for (std::size_t fadeIndex = 0U; fadeIndex < fadeFrames; ++fadeIndex) {
        const float position = static_cast<float>(fadeIndex + 1U) / static_cast<float>(fadeFrames);
        const auto gains = dsp::equalPowerCrossfadeGains(position);
        const float oldTail = firstSegment[fadeFrames - 1U - fadeIndex];
        const float newHead = secondSegment[segmentFrames - 1U - fadeIndex];
        const float expected = oldTail * gains.first + newHead * gains.second;
        const std::size_t outputFrame = (2U * segmentFrames) + lookahead - fadeFrames + fadeIndex;
        expectNear(audio[outputFrame * 2U], expected);
        expectNear(audio[outputFrame * 2U + 1U], expected);
        if (fadeIndex > 0U && fadeIndex + 1U < fadeFrames) {
            assert(std::fabs(audio[outputFrame * 2U] - oldTail) > 1.0e-4f);
            assert(std::fabs(audio[outputFrame * 2U] - newHead) > 1.0e-4f);
        }
    }

    // The first F samples of segment one were consumed by the overlap; the
    // remaining reverse read order continues without a gap or block reset.
    for (std::size_t reverseFrame = 0U; reverseFrame < segmentFrames - fadeFrames; ++reverseFrame) {
        const std::size_t outputFrame = (2U * segmentFrames) + lookahead + reverseFrame;
        expectNear(audio[outputFrame * 2U], secondSegment[segmentFrames - 1U - fadeFrames - reverseFrame]);
    }
}

void testHostileInputsFeedbackBoundsAndFinitePassthrough() {
    constexpr unsigned int rate = 8000U;
    constexpr std::size_t frames = 6000U;
    NativeReverseDelayProcessor processor;
    assert(processor.prepare(rate));
    auto config = shortSegmentConfig();
    config.feedbackPercent = 95.0f;
    config.crossfadeMs = 100.0f;
    assert(processor.setConfig(config, 0U));

    std::vector<float> audio(frames * 3U, 0.0f);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float hostile = frame % 3U == 0U
            ? std::numeric_limits<float>::max()
            : (frame % 3U == 1U ? std::numeric_limits<float>::quiet_NaN() : -1.0e30f);
        audio[frame * 3U] = hostile;
        audio[frame * 3U + 1U] = hostile;
        audio[frame * 3U + 2U] = frame % 2U == 0U
            ? std::numeric_limits<float>::infinity()
            : 0.25f;
    }
    (void)processor.processInPlace(audio.data(), static_cast<unsigned int>(frames), 3U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float left = audio[frame * 3U];
        const float right = audio[frame * 3U + 1U];
        assert(std::isfinite(left) && std::fabs(left) <= 16.0f);
        assert(std::isfinite(right) && std::fabs(right) <= 16.0f);
        if (frame % 2U == 0U) expectNear(audio[frame * 3U + 2U], 0.0f);
        else expectNear(audio[frame * 3U + 2U], 0.25f);
    }
    const auto status = processor.status();
    assert(status.boundaryCount > 2U);
    assert(status.crossfadeFrames <= status.activeSegmentFrames / 2U);
    assert(status.wetLookaheadFrames <= static_cast<std::size_t>(rate) / 10U);
}

void testArbitraryChunkSizesAreInvariant() {
    constexpr unsigned int rate = 8000U;
    constexpr std::size_t frames = 12037U;
    NativeReverseDelayProcessor contiguous;
    NativeReverseDelayProcessor chunked;
    assert(contiguous.prepare(rate));
    assert(chunked.prepare(rate));
    auto config = shortSegmentConfig();
    config.feedbackPercent = 72.0f;
    config.crossfadeMs = 37.0f;
    config.mixPercent = 84.0f;
    assert(contiguous.setConfig(config, 0U));
    assert(chunked.setConfig(config, 0U));

    std::vector<float> source(frames * 2U);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float sample = static_cast<float>(0.35 * std::sin(0.071 * static_cast<double>(frame)));
        source[frame * 2U] = sample;
        source[frame * 2U + 1U] = -sample * 0.7f;
    }
    auto whole = source;
    auto pieces = source;
    (void)contiguous.processInPlace(whole.data(), static_cast<unsigned int>(frames), 2U);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 37U, 509U, 2U, 127U, 1024U, 13U}};
    std::size_t offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const auto count = std::min<std::size_t>(chunks[chunkIndex % chunks.size()], frames - offset);
        (void)chunked.processInPlace(
            pieces.data() + (offset * 2U),
            static_cast<unsigned int>(count),
            2U
        );
        offset += count;
        ++chunkIndex;
    }

    for (std::size_t sample = 0U; sample < whole.size(); ++sample) {
        expectNear(pieces[sample], whole[sample], 1.0e-6f);
    }
}

void testProcessCallbackDoesNotAllocate() {
    NativeReverseDelayProcessor processor;
    assert(processor.prepare(8000U));
    auto config = shortSegmentConfig();
    config.feedbackPercent = 95.0f;
    config.mixPercent = 80.0f;
    assert(processor.setConfig(config, 0U));
    std::vector<float> audio(2048U * 2U, 0.15f);

    test_alloc::beginTracking();
    for (unsigned int block = 0U; block < 4U; ++block) {
        (void)processor.processInPlace(audio.data(), 2048U, 2U);
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == 0U);
}

} // namespace

int main() {
    testPrepareBoundsAndSampleClockedTempoLatch();
    testReverseOrderAndCausalOverlapCrossfade();
    testHostileInputsFeedbackBoundsAndFinitePassthrough();
    testArbitraryChunkSizesAreInvariant();
    testProcessCallbackDoesNotAllocate();
}
