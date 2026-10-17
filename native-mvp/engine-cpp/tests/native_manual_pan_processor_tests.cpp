#include "native_fx_catalog.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <memory>
#include <vector>

using namespace webrc::native;

namespace {

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

std::unique_ptr<NativeEffectProcessor> makePrepared() {
    auto processor = createNativeEffectProcessor("manual_pan");
    assert(processor != nullptr && processor->stableId() == "manual_pan");
    assert(processor->prepare(48000U));
    return processor;
}

void testStereoCenterAndEqualPowerEdges() {
    auto processor = makePrepared();
    std::array<float, 2U> frame{{0.6f, -0.3f}};
    (void)processor->processInPlace(frame.data(), 1U, 2U);
    expectNear(frame[0], 0.6f);
    expectNear(frame[1], -0.3f);

    assert(processor->setParameter("position", -100.0f, 1U));
    frame = {{0.6f, -0.3f}};
    (void)processor->processInPlace(frame.data(), 1U, 2U);
    expectNear(frame[0], 0.6f);
    expectNear(frame[1], 0.0f);

    assert(processor->setParameter("position", 100.0f, 1U));
    frame = {{0.6f, -0.3f}};
    (void)processor->processInPlace(frame.data(), 1U, 2U);
    expectNear(frame[0], 0.0f);
    expectNear(frame[1], -0.3f);

    assert(processor->setParameter("position", 50.0f, 1U));
    frame = {{0.6f, -0.3f}};
    (void)processor->processInPlace(frame.data(), 1U, 2U);
    constexpr float kSqrtTwo = 1.4142135623730950488f;
    const float expectedLeftGain = std::cos(3.0f * 3.14159265358979323846f / 8.0f) * kSqrtTwo;
    expectNear(frame[0], 0.6f * expectedLeftGain);
    expectNear(frame[1], -0.3f);
}

void testMonoChannelCountAndAdditionalChannels() {
    auto processor = makePrepared();
    assert(processor->setParameter("position", -100.0f, 1U));
    std::array<float, 3U> mono{{0.4f, -0.2f, 0.8f}};
    (void)processor->processInPlace(mono.data(), 3U, 1U);
    expectNear(mono[0], 0.4f);
    expectNear(mono[1], -0.2f);
    expectNear(mono[2], 0.8f);

    assert(processor->setParameter("position", 100.0f, 1U));
    std::array<float, 6U> threeChannels{{0.5f, -0.25f, 0.75f, -0.5f, 0.25f, -0.75f}};
    (void)processor->processInPlace(threeChannels.data(), 2U, 3U);
    expectNear(threeChannels[0], 0.0f);
    expectNear(threeChannels[1], -0.25f);
    expectNear(threeChannels[2], 0.75f);
    expectNear(threeChannels[3], 0.0f);
    expectNear(threeChannels[4], 0.25f);
    expectNear(threeChannels[5], -0.75f);
}

void testSmoothingAndVariableBlockEquivalence() {
    constexpr std::size_t kFrames = 257U;
    std::vector<float> input(kFrames * 2U);
    for (std::size_t frame = 0U; frame < kFrames; ++frame) {
        input[frame * 2U] = std::sin(static_cast<float>(frame) * 0.07f) * 0.7f;
        input[frame * 2U + 1U] = std::cos(static_cast<float>(frame) * 0.11f) * 0.7f;
    }
    auto whole = makePrepared();
    auto chunked = makePrepared();
    assert(whole->setParameter("position", -100.0f, 100U));
    assert(chunked->setParameter("position", -100.0f, 100U));
    auto expected = input;
    auto actual = input;
    const float wholePeak = whole->processInPlace(expected.data(), static_cast<unsigned int>(kFrames), 2U);

    constexpr std::array<unsigned int, 7U> blocks{{1U, 7U, 64U, 31U, 127U, 3U, 24U}};
    std::size_t processed = 0U;
    std::size_t blockIndex = 0U;
    float chunkedPeak = 0.0f;
    while (processed < kFrames) {
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            blocks[blockIndex % blocks.size()], kFrames - processed));
        chunkedPeak = std::max(chunkedPeak, chunked->processInPlace(
            actual.data() + processed * 2U, count, 2U));
        processed += count;
        ++blockIndex;
    }
    assert(actual == expected);
    expectNear(chunkedPeak, wholePeak);
    assert(std::all_of(actual.begin(), actual.end(), [](float value) {
        return std::isfinite(value) && std::fabs(value) <= 0.7f;
    }));

    auto smoothed = makePrepared();
    assert(smoothed->setParameter("position", -100.0f, 4U));
    std::array<float, 8U> ramped{{1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f}};
    (void)smoothed->processInPlace(ramped.data(), 4U, 2U);
    constexpr float kPi = 3.14159265358979323846f;
    constexpr float kSqrtTwo = 1.4142135623730950488f;
    for (std::size_t frame = 0U; frame < 4U; ++frame) {
        const float position = -0.25f * static_cast<float>(frame + 1U);
        const float rightGain = std::sin((position + 1.0f) * kPi * 0.25f) * kSqrtTwo;
        expectNear(ramped[frame * 2U], 1.0f);
        expectNear(ramped[frame * 2U + 1U], rightGain);
    }
}

void testProcessingDoesNotAllocate() {
    auto processor = makePrepared();
    assert(processor->setParameter("position", 75.0f, 256U));
    std::array<float, 512U> audio{};
    for (std::size_t index = 0U; index < audio.size(); ++index) {
        audio[index] = (index % 2U == 0U) ? 0.25f : -0.5f;
    }
    test_alloc::beginTracking();
    (void)processor->processInPlace(audio.data(), 256U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == 0U);
}

} // namespace

int main() {
    testStereoCenterAndEqualPowerEdges();
    testMonoChannelCountAndAdditionalChannels();
    testSmoothingAndVariableBlockEquivalence();
    testProcessingDoesNotAllocate();
    return 0;
}
