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

constexpr unsigned int kSampleRate = 48000U;
constexpr unsigned int kRadioLatencyFrames = 24U;
constexpr double kPi = 3.141592653589793238462643383279502884;

void configure(NativeEffectProcessor& processor, float band, float drive, float noise, float mix) {
    assert(processor.prepare(kSampleRate));
    assert(processor.setParameter("band", band, 1U));
    assert(processor.setParameter("drive", drive, 1U));
    assert(processor.setParameter("noise", noise, 1U));
    assert(processor.setParameter("mix", mix, 1U));
}

double rms(const std::vector<float>& samples, std::size_t begin, std::size_t end) {
    double energy = 0.0;
    for (std::size_t index = begin; index < end; ++index) {
        const double sample = samples[index];
        energy += sample * sample;
    }
    return std::sqrt(energy / static_cast<double>(end - begin));
}

std::vector<float> makeTone(unsigned int frames, double frequencyHz, unsigned int sampleRate = kSampleRate) {
    std::vector<float> input(frames);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        input[frame] = static_cast<float>(0.5 * std::sin(
            2.0 * kPi * frequencyHz * static_cast<double>(frame) / static_cast<double>(sampleRate)));
    }
    return input;
}

void testDescriptorBoundsAndFactory() {
    const auto* descriptor = findNativeEffectDescriptor("radio");
    assert(descriptor != nullptr && descriptor->sourceIndex == 8);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    auto radio = createNativeEffectProcessor("radio");
    assert(radio != nullptr && radio->stableId() == "radio");
    assert(radio->prepare(kSampleRate));
    const auto* band = findNativeEffectParameter("radio", "band");
    const auto* drive = findNativeEffectParameter("radio", "drive");
    const auto* noise = findNativeEffectParameter("radio", "noise");
    const auto* mix = findNativeEffectParameter("radio", "mix");
    assert(band != nullptr && band->discrete && band->discreteValueCount == 3U);
    assert(band->defaultValue == 0.0f && band->discreteValues[0] == 0.0f &&
           band->discreteValues[1] == 1.0f && band->discreteValues[2] == 2.0f);
    assert(drive != nullptr && drive->minimum == 0.0f && drive->maximum == 100.0f && drive->defaultValue == 35.0f);
    assert(noise != nullptr && noise->minimum == 0.0f && noise->maximum == 100.0f && noise->defaultValue == 8.0f);
    assert(mix != nullptr && mix->minimum == 0.0f && mix->maximum == 100.0f && mix->defaultValue == 70.0f);
    assert(!radio->setParameter("band", -1.0f));
    assert(!radio->setParameter("band", 1.5f));
    assert(!radio->setParameter("band", 3.0f));
    assert(!radio->setParameter("drive", -0.01f));
    assert(!radio->setParameter("drive", 100.01f));
    assert(!radio->setParameter("noise", -0.01f));
    assert(!radio->setParameter("noise", 100.01f));
    assert(!radio->setParameter("mix", -0.01f));
    assert(!radio->setParameter("mix", 100.01f));
    assert(radio->setParameter("band", 2.0f));
    assert(radio->setParameter("drive", 100.0f));
    assert(radio->setParameter("noise", 100.0f));
    assert(radio->setParameter("mix", 100.0f));
}

void testStereoBandLimitsAndMixLatency() {
    constexpr unsigned int frames = 2U * kSampleRate;
    auto narrow = createNativeEffectProcessor("radio");
    auto fm = createNativeEffectProcessor("radio");
    assert(narrow != nullptr && fm != nullptr);
    configure(*narrow, 0.0f, 0.0f, 0.0f, 100.0f);
    configure(*fm, 2.0f, 0.0f, 0.0f, 100.0f);
    auto lowToneNarrow = makeTone(frames, 30.0);
    auto lowToneFm = lowToneNarrow;
    (void)narrow->processInPlace(lowToneNarrow.data(), frames, 1U);
    (void)fm->processInPlace(lowToneFm.data(), frames, 1U);
    const double lowNarrowRms = rms(lowToneNarrow, kSampleRate, frames);
    const double lowFmRms = rms(lowToneFm, kSampleRate, frames);
    assert(lowFmRms > lowNarrowRms * 2.5);

    auto wide = createNativeEffectProcessor("radio");
    auto fmHigh = createNativeEffectProcessor("radio");
    assert(wide != nullptr && fmHigh != nullptr);
    configure(*wide, 1.0f, 0.0f, 0.0f, 100.0f);
    configure(*fmHigh, 2.0f, 0.0f, 0.0f, 100.0f);
    auto highToneWide = makeTone(frames, 10000.0);
    auto highToneFm = highToneWide;
    (void)wide->processInPlace(highToneWide.data(), frames, 1U);
    (void)fmHigh->processInPlace(highToneFm.data(), frames, 1U);
    assert(rms(highToneFm, kSampleRate, frames) > rms(highToneWide, kSampleRate, frames) * 2.5);

    auto dryRadio = createNativeEffectProcessor("radio");
    assert(dryRadio != nullptr);
    configure(*dryRadio, 1.0f, 100.0f, 100.0f, 0.0f);
    constexpr unsigned int dryFrames = 160U;
    std::vector<float> dry = makeTone(dryFrames, 713.0);
    const auto original = dry;
    (void)dryRadio->processInPlace(dry.data(), dryFrames, 1U);
    for (unsigned int frame = 0U; frame < dryFrames; ++frame) {
        const float expected = frame < kRadioLatencyFrames ? 0.0f : original[frame - kRadioLatencyFrames];
        assert(dry[frame] == expected);
    }
}

void testDeterministicNoiseDropoutAndChunkInvariantNoAllocation() {
    constexpr unsigned int frames = 2U * kSampleRate;
    auto noisyA = createNativeEffectProcessor("radio");
    auto noisyB = createNativeEffectProcessor("radio");
    auto clean = createNativeEffectProcessor("radio");
    assert(noisyA != nullptr && noisyB != nullptr && clean != nullptr);
    configure(*noisyA, 1.0f, 45.0f, 100.0f, 100.0f);
    configure(*noisyB, 1.0f, 45.0f, 100.0f, 100.0f);
    configure(*clean, 1.0f, 45.0f, 0.0f, 100.0f);
    auto source = makeTone(frames, 1000.0);
    auto oneBlock = source;
    auto chunked = source;
    auto cleanOutput = source;

    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)noisyA->processInPlace(oneBlock.data(), frames, 1U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    constexpr std::array<unsigned int, 6U> chunks{{1U, 7U, 64U, 255U, 1024U, 31U}};
    std::size_t offset = 0U;
    std::size_t chunk = 0U;
    while (offset < frames) {
        const unsigned int count = static_cast<unsigned int>(std::min<std::size_t>(
            chunks[chunk % chunks.size()], frames - offset));
        (void)noisyB->processInPlace(chunked.data() + offset, count, 1U);
        offset += count;
        ++chunk;
    }
    (void)clean->processInPlace(cleanOutput.data(), frames, 1U);

    std::size_t changedNoiseSamples = 0U;
    std::size_t dropoutLikeRun = 0U;
    std::size_t longestDropoutLikeRun = 0U;
    for (std::size_t index = 0U; index < oneBlock.size(); ++index) {
        assert(std::isfinite(oneBlock[index]));
        assert(oneBlock[index] == chunked[index]);
        const float noiseDifference = std::fabs(oneBlock[index] - cleanOutput[index]);
        if (noiseDifference > 1.0e-4f) ++changedNoiseSamples;
        if (noiseDifference > 0.08f) {
            ++dropoutLikeRun;
            longestDropoutLikeRun = std::max(longestDropoutLikeRun, dropoutLikeRun);
        } else {
            dropoutLikeRun = 0U;
        }
    }
    assert(changedNoiseSamples > frames / 2U);
    // The deterministic stream includes multi-millisecond dropout envelopes,
    // which produce runs well beyond the low-level colored-noise difference.
    assert(longestDropoutLikeRun > 20U);
}

} // namespace

int main() {
    testDescriptorBoundsAndFactory();
    testStereoBandLimitsAndMixLatency();
    testDeterministicNoiseDropoutAndChunkInvariantNoAllocation();
}
