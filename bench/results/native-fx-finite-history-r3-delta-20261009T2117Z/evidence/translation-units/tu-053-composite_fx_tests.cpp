#include "webrc/dsp/composite_fx.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

namespace {

using namespace webrc::dsp;
constexpr double kPi = 3.141592653589793238462643383279502884;
std::atomic<bool> gWatchAllocations{false};
std::atomic<std::uint64_t> gWatchedAllocations{0};

bool check(bool condition, const char* message) {
    if (!condition) std::fprintf(stderr, "FAIL: %s\n", message);
    return condition;
}

ProcessSpec spec(std::uint32_t block = 256) { return {48000.0f, block, 2U}; }

StereoFrame source(std::uint64_t frame) {
    const double time = static_cast<double>(frame) / 48000.0;
    return {static_cast<float>(0.31 * std::sin(2.0 * kPi * 431.0 * time) +
                               0.09 * std::sin(2.0 * kPi * 73.0 * time)),
            static_cast<float>(-0.22 * std::sin(2.0 * kPi * 587.0 * time + 0.41) +
                               0.07 * std::sin(2.0 * kPi * 109.0 * time))};
}

std::uint32_t appendControls(CompositeFxKind kind, std::uint32_t offset, bool initial,
                             std::array<CompositeFxEvent, 16>& events,
                             std::uint32_t count = 0U) {
    events[count++] = {offset, CompositeFxControl::Wet, initial ? 1.0f : 0.75f};
    if (initial) events[count++] = {offset, CompositeFxControl::Active, 1.0f};
    switch (kind) {
    case CompositeFxKind::Radio:
        events[count++] = {offset, CompositeFxControl::RadioHighPassHz, initial ? 380.0f : 240.0f};
        events[count++] = {offset, CompositeFxControl::RadioLowPassHz, initial ? 3000.0f : 4200.0f};
        events[count++] = {offset, CompositeFxControl::RadioDrive, initial ? 3.5f : 2.0f};
        events[count++] = {offset, CompositeFxControl::RadioBitDepth, initial ? 9.0f : 12.0f};
        events[count++] = {offset, CompositeFxControl::RadioHoldFrames, initial ? 3.0f : 1.0f};
        events[count++] = {offset, CompositeFxControl::RadioBitMix, initial ? 0.45f : 0.25f};
        break;
    case CompositeFxKind::Sustainer:
        events[count++] = {offset, CompositeFxControl::SustainerThresholdDb, initial ? -27.0f : -18.0f};
        events[count++] = {offset, CompositeFxControl::SustainerRatio, initial ? 10.0f : 5.0f};
        events[count++] = {offset, CompositeFxControl::SustainerAttackMs, initial ? 5.0f : 20.0f};
        events[count++] = {offset, CompositeFxControl::SustainerReleaseMs, initial ? 350.0f : 700.0f};
        events[count++] = {offset, CompositeFxControl::SustainerRmsMix, initial ? 0.6f : 0.2f};
        events[count++] = {offset, CompositeFxControl::SustainerMakeupDb, initial ? 2.0f : 0.0f};
        break;
    case CompositeFxKind::SlowGear:
        events[count++] = {offset, CompositeFxControl::SlowGearAttackMs, initial ? 300.0f : 100.0f};
        events[count++] = {offset, CompositeFxControl::SlowGearReleaseMs, initial ? 200.0f : 650.0f};
        events[count++] = {offset, CompositeFxControl::SlowGearSensitivity, initial ? 2.0f : 1.5f};
        break;
    case CompositeFxKind::StereoEnhance:
        events[count++] = {offset, CompositeFxControl::StereoHighWidth, initial ? 1.8f : 1.25f};
        events[count++] = {offset, CompositeFxControl::StereoLowWidth, initial ? 0.05f : 0.6f};
        events[count++] = {offset, CompositeFxControl::StereoSmoothingMs, initial ? 15.0f : 45.0f};
        break;
    }
    return count;
}

template <typename Processor>
std::vector<StereoFrame> render(std::uint32_t blockFrames, std::uint32_t totalFrames) {
    Processor processor;
    if (!processor.prepare(spec(256))) return {};
    std::vector<StereoFrame> output(totalFrames);
    constexpr std::uint32_t changeAt = 17119U;
    constexpr std::uint32_t stopAt = 57003U;
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min(blockFrames, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) output[start + i] = source(start + i);
        std::array<CompositeFxEvent, 16> events{};
        std::uint32_t eventCount = 0;
        if (start == 0U) eventCount = appendControls(processor.kind(), 0U, true, events);
        if (start <= changeAt && changeAt < start + count)
            eventCount = appendControls(processor.kind(), changeAt - start, false, events, eventCount);
        if (start <= stopAt && stopAt < start + count)
            events[eventCount++] = {stopAt - start, CompositeFxControl::Active, 0.0f};
        if (!processor.processBlock(start, output.data() + start, count,
                                    eventCount == 0U ? nullptr : events.data(), eventCount)) return {};
        start += count;
    }
    return output;
}

double rms(const std::vector<StereoFrame>& frames, std::size_t begin, std::size_t end,
           bool side = false) {
    double energy = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        const auto sample = side ? frames[i].left - frames[i].right : frames[i].left;
        energy += static_cast<double>(sample) * sample;
    }
    return end > begin ? std::sqrt(energy / static_cast<double>(end - begin)) : 0.0;
}

double rmsChannel(const std::vector<StereoFrame>& frames, std::size_t begin,
                  std::size_t end, bool right) {
    double energy = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        const auto sample = right ? frames[i].right : frames[i].left;
        energy += static_cast<double>(sample) * sample;
    }
    return end > begin ? std::sqrt(energy / static_cast<double>(end - begin)) : 0.0;
}

template <typename Processor>
bool testBlockScheduleInvariant(const char* label) {
    constexpr std::uint32_t frames = 65536U;
    const auto output64 = render<Processor>(64U, frames);
    const auto output256 = render<Processor>(256U, frames);
    if (!check(output64.size() == frames && output256.size() == frames, label)) return false;
    double maximumDifference = 0.0;
    double effectDifference = 0.0;
    double stereoDifference = 0.0;
    for (std::uint32_t i = 0; i < frames; ++i) {
        maximumDifference = std::max(maximumDifference,
            std::max(std::fabs(static_cast<double>(output64[i].left) - output256[i].left),
                     std::fabs(static_cast<double>(output64[i].right) - output256[i].right)));
        stereoDifference += std::fabs(static_cast<double>(output64[i].left) - output64[i].right);
        if (i >= 6000U && i < 50000U) {
            const auto dry = source(i);
            effectDifference += std::fabs(static_cast<double>(output64[i].left) - dry.left) +
                                std::fabs(static_cast<double>(output64[i].right) - dry.right);
        }
        if (!std::isfinite(output64[i].left) || !std::isfinite(output64[i].right) ||
            std::fabs(output64[i].left) > 8.0f || std::fabs(output64[i].right) > 8.0f) return false;
    }
    if (!check(maximumDifference < 2.0e-6, "64/256 block schedules have identical PCM") ||
        !check(rms(output64, 1000U, 50000U) > 0.005, "effect produces nonzero stereo audio") ||
        !check(stereoDifference / frames > 0.001, "independent stereo input remains distinct") ||
        !check(effectDifference > 20.0, "processor measurably changes the dry signal")) {
        std::fprintf(stderr, "%s maxBlockDiff=%.9g effectDifference=%.9g\n", label,
                     maximumDifference, effectDifference);
        return false;
    }
    return true;
}

bool testValidationTransactions() {
    RadioFx radio;
    if (!check(CompositeFxProcessor::requiredPrepareBytes(spec(), CompositeFxKind::Radio) > 0U,
               "radio reports its fixed prepare budget") ||
        !check(CompositeFxProcessor::requiredPrepareBytes({48000.0f, 64U, 1U},
                   CompositeFxKind::Radio) == 0U,
               "composite family rejects non-stereo ProcessSpec") ||
        !check(radio.prepare(spec(64U)), "radio prepares")) return false;
    std::array<StereoFrame, 8> block{};
    block[0] = {0.2f, -0.1f};
    const auto original = block;
    const std::array<CompositeFxEvent, 3> invalid{{
        {0U, CompositeFxControl::Active, 1.0f},
        {0U, CompositeFxControl::RadioHighPassHz, 1000.0f},
        {0U, CompositeFxControl::RadioLowPassHz, 500.0f},
    }};
    if (!check(!radio.processBlock(0U, block.data(), 8U, invalid.data(),
                                   static_cast<std::uint32_t>(invalid.size())),
               "crossed radio cutoffs are rejected before processing") ||
        !check(block[0].left == original[0].left && block[0].right == original[0].right &&
               radio.activeGain() == 0.0f,
               "invalid control transaction preserves audio and processor state")) return false;
    std::array<CompositeFxEvent, 2> unordered{{
        {4U, CompositeFxControl::Wet, 0.5f},
        {2U, CompositeFxControl::Wet, 0.8f},
    }};
    return check(!radio.processBlock(0U, block.data(), 8U, unordered.data(),
                                    static_cast<std::uint32_t>(unordered.size())),
                 "unordered automation is rejected transactionally");
}

bool testRadioBandLimitAndStereo() {
    RadioFx radio;
    if (!radio.prepare(spec(256U))) return false;
    constexpr std::uint32_t frames = 96000U;
    std::vector<StereoFrame> output(frames);
    std::array<CompositeFxEvent, 16> events{};
    std::uint32_t eventCount = 0;
    events[eventCount++] = {0U, CompositeFxControl::Active, 1.0f};
    events[eventCount++] = {0U, CompositeFxControl::Wet, 1.0f};
    events[eventCount++] = {0U, CompositeFxControl::RadioHighPassHz, 400.0f};
    events[eventCount++] = {0U, CompositeFxControl::RadioLowPassHz, 2800.0f};
    events[eventCount++] = {0U, CompositeFxControl::RadioDrive, 3.0f};
    events[eventCount++] = {0U, CompositeFxControl::RadioBitDepth, 10.0f};
    events[eventCount++] = {0U, CompositeFxControl::RadioHoldFrames, 2.0f};
    events[eventCount++] = {0U, CompositeFxControl::RadioBitMix, 0.25f};
    for (std::uint32_t start = 0; start < frames;) {
        const auto count = std::min<std::uint32_t>(256U, frames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto time = static_cast<double>(start + i) / 48000.0;
            output[start + i] = {0.5f * static_cast<float>(std::sin(2.0 * kPi * 80.0 * time)),
                                 0.2f * static_cast<float>(std::sin(2.0 * kPi * 1000.0 * time))};
        }
        if (!radio.processBlock(start, output.data() + start, count,
                                start == 0U ? events.data() : nullptr,
                                start == 0U ? eventCount : 0U)) return false;
        start += count;
    }
    const double leftOutput = rms(output, 48000U, frames);
    const double rightOutput = rmsChannel(output, 48000U, frames, true);
    if (!check(leftOutput < 0.12, "radio high-pass attenuates the independent 80 Hz channel") ||
        !check(rightOutput > 0.08, "radio passband retains the independent 1 kHz stereo channel") ||
        !check(rightOutput > leftOutput * 1.5, "radio keeps both channel histories separate")) {
        std::fprintf(stderr, "Radio band-test left=%.6f side=%.6f\n", leftOutput, rightOutput);
        return false;
    }
    return true;
}

bool testRadioDriveAutomationContinuity() {
    RadioFx automated;
    RadioFx reference;
    if (!check(automated.prepare(spec(256U)) && reference.prepare(spec(256U)),
               "radio automation test processors prepare")) return false;
    constexpr std::uint32_t frames = 72000U;
    std::vector<StereoFrame> automatedBlock(256U);
    std::vector<StereoFrame> referenceBlock(256U);
    std::array<CompositeFxEvent, 8> initial{{
        {0U, CompositeFxControl::Active, 1.0f},
        {0U, CompositeFxControl::Wet, 1.0f},
        {0U, CompositeFxControl::RadioHighPassHz, 20.0f},
        {0U, CompositeFxControl::RadioLowPassHz, 12000.0f},
        {0U, CompositeFxControl::RadioDrive, 2.5f},
        {0U, CompositeFxControl::RadioBitMix, 0.0f},
    }};
    double maxAutomatedAudioStep = 0.0;
    std::uint32_t maxAutomatedAudioStepFrame = 0U;
    double accumulatedAutomationDifference = 0.0;
    double comparedSamples = 0.0;
    StereoFrame previousAutomated{};
    bool havePreviousOutput = false;
    for (std::uint32_t start = 0; start < frames;) {
        const auto count = std::min<std::uint32_t>(256U, frames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            const auto time = static_cast<double>(frame) / 48000.0;
            const auto phase = 2.0 * kPi * 73.0 * time;
            const StereoFrame input{0.2f * static_cast<float>(std::sin(phase)),
                                    0.12f * static_cast<float>(std::sin(phase + 0.47))};
            automatedBlock[i] = input;
            referenceBlock[i] = input;
        }
        std::array<CompositeFxEvent, 2> automation{};
        std::uint32_t automationCount = 0U;
        if (start == 0U) {
            if (!automated.processBlock(start, automatedBlock.data(), count,
                                        initial.data(), 6U) ||
                !reference.processBlock(start, referenceBlock.data(), count,
                                        initial.data(), 6U)) return false;
        } else {
            const auto firstChange = 24000U;
            const auto secondChange = 48000U;
            if (start <= firstChange && firstChange < start + count)
                automation[automationCount++] = {firstChange - start,
                    CompositeFxControl::RadioDrive, 12.0f};
            if (start <= secondChange && secondChange < start + count)
                automation[automationCount++] = {secondChange - start,
                    CompositeFxControl::RadioDrive, 0.1f};
            if (!automated.processBlock(start, automatedBlock.data(), count,
                                        automationCount == 0U ? nullptr : automation.data(),
                                        automationCount) ||
                !reference.processBlock(start, referenceBlock.data(), count, nullptr, 0U))
                return false;
        }
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            const float errorLeft = automatedBlock[i].left - referenceBlock[i].left;
            const float errorRight = automatedBlock[i].right - referenceBlock[i].right;
            if (frame >= 24000U && frame < 72000U) {
                if (havePreviousOutput) {
                    const auto step = std::max(
                        std::fabs(static_cast<double>(automatedBlock[i].left - previousAutomated.left)),
                        std::fabs(static_cast<double>(automatedBlock[i].right - previousAutomated.right)));
                    if (step > maxAutomatedAudioStep) {
                        maxAutomatedAudioStep = step;
                        maxAutomatedAudioStepFrame = frame;
                    }
                }
                accumulatedAutomationDifference += std::fabs(errorLeft) + std::fabs(errorRight);
                comparedSamples += 2.0;
            }
            previousAutomated = automatedBlock[i];
            havePreviousOutput = true;
        }
        start += count;
    }
    if (!check(maxAutomatedAudioStep < 0.05,
               "smoothed Radio drive automation stays sample-continuous") ||
        !check(accumulatedAutomationDifference / comparedSamples > 0.015,
               "Radio drive automation measurably changes the driven signal")) {
        std::fprintf(stderr, "Radio drive automation maxAudioStep=%.7f frame=%u meanDifference=%.7f\n",
                     maxAutomatedAudioStep, maxAutomatedAudioStepFrame,
                     accumulatedAutomationDifference / comparedSamples);
        return false;
    }
    std::printf("Radio drive automation: max audio step %.7f at frame %u; mean change %.7f\n",
                maxAutomatedAudioStep, maxAutomatedAudioStepFrame,
                accumulatedAutomationDifference / comparedSamples);
    return true;
}

bool testSustainerCompressionAndStereoLink() {
    SustainerFx sustainer;
    if (!sustainer.prepare(spec(256U))) return false;
    constexpr std::uint32_t halfFrames = 96000U;
    std::array<CompositeFxEvent, 8> events{};
    std::uint32_t eventCount = 0;
    events[eventCount++] = {0U, CompositeFxControl::Active, 1.0f};
    events[eventCount++] = {0U, CompositeFxControl::Wet, 1.0f};
    events[eventCount++] = {0U, CompositeFxControl::SustainerThresholdDb, -24.0f};
    events[eventCount++] = {0U, CompositeFxControl::SustainerRatio, 10.0f};
    events[eventCount++] = {0U, CompositeFxControl::SustainerAttackMs, 5.0f};
    events[eventCount++] = {0U, CompositeFxControl::SustainerReleaseMs, 180.0f};
    events[eventCount++] = {0U, CompositeFxControl::SustainerRmsMix, 0.5f};
    events[eventCount++] = {0U, CompositeFxControl::SustainerMakeupDb, 0.0f};
    double highOutput = 0.0;
    double highOutputRight = 0.0;
    double lowOutput = 0.0;
    std::array<StereoFrame, 256> block{};
    for (std::uint32_t start = 0; start < halfFrames * 2U;) {
        const auto count = std::min<std::uint32_t>(256U, halfFrames * 2U - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto amplitude = start + i < halfFrames ? 0.8f : 0.2f;
            block[i] = {amplitude, -0.5f * amplitude};
        }
        if (!sustainer.processBlock(start, block.data(), count,
                                    start == 0U ? events.data() : nullptr,
                                    start == 0U ? eventCount : 0U)) return false;
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto absolute = start + i;
            if (absolute >= halfFrames - 4096U && absolute < halfFrames) {
                highOutput += std::fabs(block[i].left);
                highOutputRight += std::fabs(block[i].right);
            } else if (absolute >= halfFrames * 2U - 4096U) {
                lowOutput += std::fabs(block[i].left);
            }
        }
        start += count;
    }
    highOutput /= 4096.0;
    highOutputRight /= 4096.0;
    lowOutput /= 4096.0;
    if (!check(highOutput < 0.3, "sustainer compresses a loud sustained input") ||
        !check(lowOutput > 0.04, "sustainer preserves a lower level after the release settles") ||
        !check(std::fabs(highOutputRight * 2.0 - highOutput) < 1.0e-4,
               "sustainer applies linked gain without collapsing stereo separation") ||
        !check(highOutput / std::max(lowOutput, 1.0e-9) < 2.0,
               "sustainer reduces the test signal's 4:1 level ratio")) {
        std::fprintf(stderr, "Sustainer high=%.6f low=%.6f highR=%.6f\n",
                     highOutput, lowOutput, highOutputRight);
        return false;
    }
    return true;
}

bool testSustainerMakeupAutomationContinuity() {
    SustainerFx sustainer;
    if (!sustainer.prepare(spec(256U))) return false;
    constexpr std::uint32_t changeFrame = 24000U;
    constexpr std::uint32_t deactivateFrame = 48000U;
    constexpr std::uint32_t totalFrames = 72000U;
    std::array<CompositeFxEvent, 8> initial{{
        {0U, CompositeFxControl::Active, 1.0f},
        {0U, CompositeFxControl::Wet, 1.0f},
        {0U, CompositeFxControl::SustainerThresholdDb, -60.0f},
        {0U, CompositeFxControl::SustainerRatio, 1.0f},
        {0U, CompositeFxControl::SustainerAttackMs, 10.0f},
        {0U, CompositeFxControl::SustainerReleaseMs, 100.0f},
        {0U, CompositeFxControl::SustainerRmsMix, 0.0f},
        {0U, CompositeFxControl::SustainerMakeupDb, 24.0f},
    }};
    const std::array<CompositeFxEvent, 3> hardControlChange{{
        {0U, CompositeFxControl::SustainerThresholdDb, -55.0f},
        {0U, CompositeFxControl::SustainerRatio, 20.0f},
        {0U, CompositeFxControl::SustainerMakeupDb, -24.0f},
    }};
    const std::array<CompositeFxEvent, 2> deactivate{{
        {0U, CompositeFxControl::Active, 0.0f},
        {0U, CompositeFxControl::Wet, 0.0f},
    }};
    std::array<StereoFrame, 256> block{};
    double beforeSum = 0.0;
    double afterSum = 0.0;
    std::uint32_t beforeCount = 0U;
    std::uint32_t afterCount = 0U;
    double maxOutputStep = 0.0;
    float previousOutput = 0.0f;
    bool hasPreviousOutput = false;
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min<std::uint32_t>(256U, totalFrames - start);
        block.fill({0.05f, -0.025f});
        const auto containsChange = start <= changeFrame && changeFrame < start + count;
        const auto containsDeactivate = start <= deactivateFrame && deactivateFrame < start + count;
        const CompositeFxEvent* blockEvents = nullptr;
        std::uint32_t blockEventCount = 0U;
        if (start == 0U) {
            blockEvents = initial.data();
            blockEventCount = static_cast<std::uint32_t>(initial.size());
        } else if (containsChange) {
            blockEvents = hardControlChange.data();
            blockEventCount = static_cast<std::uint32_t>(hardControlChange.size());
        } else if (containsDeactivate) {
            blockEvents = deactivate.data();
            blockEventCount = static_cast<std::uint32_t>(deactivate.size());
        }
        if (!sustainer.processBlock(start, block.data(), count,
                                    blockEvents, blockEventCount))
            return false;
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            if (frame >= 20000U && frame < changeFrame) {
                beforeSum += block[i].left;
                ++beforeCount;
            }
            if (frame >= 36000U && frame < deactivateFrame) {
                afterSum += block[i].left;
                ++afterCount;
            }
            if (frame >= 1000U && hasPreviousOutput) {
                maxOutputStep = std::max(maxOutputStep,
                    std::fabs(static_cast<double>(block[i].left - previousOutput)));
            }
            previousOutput = block[i].left;
            hasPreviousOutput = true;
        }
        start += count;
    }
    const auto beforeMean = beforeSum / std::max<std::uint32_t>(1U, beforeCount);
    const auto afterMean = afterSum / std::max<std::uint32_t>(1U, afterCount);
    if (!check(beforeCount > 1000U && afterCount > 1000U,
               "sustainer makeup test collected steady windows") ||
        !check(beforeMean > 0.5 && afterMean < 0.02,
               "sustainer follows threshold, ratio and both +24/-24 dB makeup targets") ||
        !check(maxOutputStep < 0.01,
               "sustainer parameter, active and wet changes have no sample jump")) {
        std::fprintf(stderr, "Sustainer makeup before=%.6f after=%.6f maxStep=%.7f\n",
                     beforeMean, afterMean, maxOutputStep);
        return false;
    }
    std::printf("Sustainer hard automation: output %.6f to %.6f; max step %.7f\n",
                beforeMean, afterMean, maxOutputStep);
    return true;
}

bool testSlowGearSwellAndLinkedStereo() {
    SlowGearFx slowGear;
    if (!slowGear.prepare(spec(256U))) return false;
    std::array<CompositeFxEvent, 5> events{{
        {0U, CompositeFxControl::Active, 1.0f},
        {0U, CompositeFxControl::Wet, 1.0f},
        {0U, CompositeFxControl::SlowGearAttackMs, 300.0f},
        {0U, CompositeFxControl::SlowGearReleaseMs, 500.0f},
        {0U, CompositeFxControl::SlowGearSensitivity, 2.0f},
    }};
    double early = 0.0;
    double late = 0.0;
    double lateRight = 0.0;
    std::array<StereoFrame, 256> block{};
    for (std::uint32_t start = 0; start < 48000U;) {
        const auto count = std::min<std::uint32_t>(256U, 48000U - start);
        block.fill({0.6f, -0.3f});
        if (!slowGear.processBlock(start, block.data(), count,
                                   start == 0U ? events.data() : nullptr,
                                   start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U)) return false;
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto absolute = start + i;
            if (absolute >= 4800U && absolute < 5056U) early += std::fabs(block[i].left);
            if (absolute >= 28800U && absolute < 29056U) {
                late += std::fabs(block[i].left);
                lateRight += std::fabs(block[i].right);
            }
        }
        start += count;
    }
    early /= 256.0;
    late /= 256.0;
    lateRight /= 256.0;
    if (!check(late > early * 2.5, "slow gear creates a measurable attack swell") ||
        !check(std::fabs(lateRight - 0.5 * late) < 1.0e-4,
               "slow gear keeps detector gain linked across L/R")) {
        std::fprintf(stderr, "SlowGear early=%.6f lateL=%.6f lateR=%.6f\n", early, late, lateRight);
        return false;
    }
    return true;
}

bool testSlowGearHighFrequencySteadyEnvelope() {
    SlowGearFx slowGear;
    if (!slowGear.prepare(spec(256U))) return false;
    std::array<CompositeFxEvent, 2> events{{
        {0U, CompositeFxControl::Active, 1.0f},
        {0U, CompositeFxControl::Wet, 1.0f},
    }};
    std::array<double, 4> minGain{{1.0e9, 1.0e9, 1.0e9, 1.0e9}};
    std::array<double, 4> maxGain{{-1.0e9, -1.0e9, -1.0e9, -1.0e9}};
    std::array<StereoFrame, 256> block{};
    constexpr std::uint32_t totalFrames = 96000U;
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min<std::uint32_t>(256U, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            const float sample = 0.6f * static_cast<float>(std::sin(
                2.0 * kPi * 12000.0 * static_cast<double>(frame) / 48000.0));
            block[i] = {sample, -0.5f * sample};
        }
        if (!slowGear.processBlock(start, block.data(), count,
                                   start == 0U ? events.data() : nullptr,
                                   start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U))
            return false;
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            const float input = 0.6f * static_cast<float>(std::sin(
                2.0 * kPi * 12000.0 * static_cast<double>(frame) / 48000.0));
            if (frame >= 48000U && std::fabs(input) > 0.1f) {
                const auto phase = frame & 3U;
                const auto gain = static_cast<double>(block[i].left / input);
                minGain[phase] = std::min(minGain[phase], gain);
                maxGain[phase] = std::max(maxGain[phase], gain);
            }
        }
        start += count;
    }
    double worstPhaseRange = 0.0;
    for (std::size_t phase = 0; phase < minGain.size(); ++phase)
        worstPhaseRange = std::max(worstPhaseRange, maxGain[phase] - minGain[phase]);
    if (!check(worstPhaseRange < 0.01,
               "12 kHz steady carrier does not repeatedly rearm Slow Gear per waveform peak")) {
        std::fprintf(stderr, "SlowGear 12kHz maximum same-phase gain range=%.7f\n",
                     worstPhaseRange);
        return false;
    }
    std::printf("Slow Gear 12 kHz steady carrier: max same-phase gain range %.7f\n",
                worstPhaseRange);
    return true;
}

bool testSlowGearOnsetAndFadeContinuity() {
    SlowGearFx slowGear;
    if (!slowGear.prepare(spec(256U))) return false;
    std::array<CompositeFxEvent, 2> events{{
        {0U, CompositeFxControl::Active, 1.0f},
        {0U, CompositeFxControl::Wet, 1.0f},
    }};
    constexpr std::uint32_t burstStart = 48000U;
    constexpr std::uint32_t burstEnd = burstStart + 1440U;
    constexpr std::uint32_t totalFrames = 120000U;
    std::array<StereoFrame, 256> block{};
    double baseGainSum = 0.0;
    std::uint32_t baseGainCount = 0U;
    double onsetGainSum = 0.0;
    std::uint32_t onsetGainCount = 0U;
    double maxAdjacentGainStep = 0.0;
    double previousGain = 0.0;
    bool havePreviousGain = false;
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min<std::uint32_t>(256U, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            const auto amplitude = frame >= burstStart && frame < burstEnd ? 0.9 : 0.25;
            const auto phase = 2.0 * kPi * 997.0 * static_cast<double>(frame) / 48000.0;
            float left = static_cast<float>(amplitude * std::sin(phase));
            float right = static_cast<float>(-0.5 * amplitude * std::sin(phase + 0.31));
            if (frame == 24000U) left += 0.95f; // isolated impulse in the sustained section
            block[i] = {left, right};
        }
        if (!slowGear.processBlock(start, block.data(), count,
                                   start == 0U ? events.data() : nullptr,
                                   start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U))
            return false;
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto frame = start + i;
            const auto amplitude = frame >= burstStart && frame < burstEnd ? 0.9 : 0.25;
            const auto phase = 2.0 * kPi * 997.0 * static_cast<double>(frame) / 48000.0;
            float input = static_cast<float>(amplitude * std::sin(phase));
            if (frame == 24000U) input += 0.95f;
            if (std::fabs(input) <= 0.12f) continue;
            const double gain = static_cast<double>(block[i].left / input);
            if (frame >= 12000U && frame < burstStart - 1200U) {
                baseGainSum += gain;
                ++baseGainCount;
            }
            if (frame >= burstStart + 480U && frame < burstStart + 1200U) {
                onsetGainSum += gain;
                ++onsetGainCount;
            }
            if (frame >= 12000U && havePreviousGain)
                maxAdjacentGainStep = std::max(maxAdjacentGainStep,
                                                std::fabs(gain - previousGain));
            previousGain = gain;
            havePreviousGain = true;
        }
        start += count;
    }
    const double baseGain = baseGainSum / std::max<std::uint32_t>(1U, baseGainCount);
    const double onsetGain = onsetGainSum / std::max<std::uint32_t>(1U, onsetGainCount);
    if (!check(onsetGainCount > 100U && baseGainCount > 100U,
               "Slow Gear onset test collected stable gain windows") ||
        !check(onsetGain < baseGain * 0.85,
               "a sustained level onset rearms the swell from a lower gain") ||
        !check(maxAdjacentGainStep < 0.03,
               "impulse, onset and fade change Slow Gear gain without a discontinuity")) {
        std::fprintf(stderr, "SlowGear baseGain=%.6f onsetGain=%.6f maxGainStep=%.6f\n",
                     baseGain, onsetGain, maxAdjacentGainStep);
        return false;
    }
    std::printf("Slow Gear onset/fade: base gain %.6f, onset gain %.6f, max step %.6f\n",
                baseGain, onsetGain, maxAdjacentGainStep);
    return true;
}

bool testStereoEnhanceFrequencyDependentWidth() {
    StereoEnhancerFx enhancer;
    if (!enhancer.prepare(spec(256U))) return false;
    constexpr std::uint32_t sectionFrames = 96000U;
    constexpr std::uint32_t totalFrames = sectionFrames * 2U;
    std::vector<StereoFrame> output(totalFrames);
    std::array<CompositeFxEvent, 5> events{{
        {0U, CompositeFxControl::Active, 1.0f},
        {0U, CompositeFxControl::Wet, 1.0f},
        {0U, CompositeFxControl::StereoHighWidth, 2.0f},
        {0U, CompositeFxControl::StereoLowWidth, 0.0f},
        {0U, CompositeFxControl::StereoSmoothingMs, 10.0f},
    }};
    for (std::uint32_t start = 0; start < totalFrames;) {
        const auto count = std::min<std::uint32_t>(256U, totalFrames - start);
        for (std::uint32_t i = 0; i < count; ++i) {
            const auto absolute = start + i;
            const auto time = static_cast<double>(absolute) / 48000.0;
            const auto frequency = absolute < sectionFrames ? 40.0 : 1000.0;
            const float side = 0.25f * static_cast<float>(std::sin(2.0 * kPi * frequency * time));
            output[absolute] = {side, -side};
        }
        if (!enhancer.processBlock(start, output.data() + start, count,
                                  start == 0U ? events.data() : nullptr,
                                  start == 0U ? static_cast<std::uint32_t>(events.size()) : 0U)) return false;
        start += count;
    }
    const auto lowSide = rms(output, 48000U, sectionFrames, true);
    const auto highSide = rms(output, sectionFrames + 48000U, totalFrames, true);
    if (!check(lowSide < 0.28, "stereo enhancer folds low-frequency side content") ||
        !check(highSide > 0.60, "stereo enhancer expands high-frequency side content")) {
        std::fprintf(stderr, "StereoEnhance side RMS low=%.6f high=%.6f\n", lowSide, highSide);
        return false;
    }
    return true;
}

template <typename Processor>
bool testNoAllocation(const char* label) {
    Processor processor;
    if (!processor.prepare(spec(64U))) return false;
    std::array<CompositeFxEvent, 64> events{};
    events[0] = {0U, CompositeFxControl::Active, 1.0f};
    for (std::uint32_t i = 1U; i < events.size(); ++i) {
        const auto alternate = (i & 1U) == 0U;
        switch (processor.kind()) {
        case CompositeFxKind::Radio:
            events[i] = {i, CompositeFxControl::RadioHighPassHz, alternate ? 800.0f : 100.0f};
            break;
        case CompositeFxKind::Sustainer:
            switch (i % 6U) {
            case 0U: events[i] = {i, CompositeFxControl::SustainerThresholdDb, alternate ? -20.0f : -50.0f}; break;
            case 1U: events[i] = {i, CompositeFxControl::SustainerRatio, alternate ? 12.0f : 2.0f}; break;
            case 2U: events[i] = {i, CompositeFxControl::SustainerAttackMs, alternate ? 50.0f : 0.5f}; break;
            case 3U: events[i] = {i, CompositeFxControl::SustainerReleaseMs, alternate ? 500.0f : 50.0f}; break;
            case 4U: events[i] = {i, CompositeFxControl::SustainerRmsMix, alternate ? 0.8f : 0.2f}; break;
            default: events[i] = {i, CompositeFxControl::SustainerMakeupDb, alternate ? 6.0f : -3.0f}; break;
            }
            break;
        case CompositeFxKind::SlowGear:
            switch (i % 3U) {
            case 0U: events[i] = {i, CompositeFxControl::SlowGearAttackMs, alternate ? 900.0f : 50.0f}; break;
            case 1U: events[i] = {i, CompositeFxControl::SlowGearReleaseMs, alternate ? 1200.0f : 50.0f}; break;
            default: events[i] = {i, CompositeFxControl::SlowGearSensitivity, alternate ? 5.0f : 0.5f}; break;
            }
            break;
        case CompositeFxKind::StereoEnhance:
            switch (i % 3U) {
            case 0U: events[i] = {i, CompositeFxControl::StereoHighWidth, alternate ? 2.0f : 0.2f}; break;
            case 1U: events[i] = {i, CompositeFxControl::StereoLowWidth, alternate ? 0.8f : 0.1f}; break;
            default: events[i] = {i, CompositeFxControl::StereoSmoothingMs, alternate ? 20.0f : 0.0f}; break;
            }
            break;
        }
    }
    std::array<StereoFrame, 64> block{};
    for (std::uint32_t i = 0; i < block.size(); ++i) block[i] = source(i);
    gWatchedAllocations.store(0, std::memory_order_relaxed);
    gWatchAllocations.store(true, std::memory_order_relaxed);
    const auto processed = processor.processBlock(0U, block.data(), 64U,
        events.data(), static_cast<std::uint32_t>(events.size()));
    gWatchAllocations.store(false, std::memory_order_relaxed);
    return check(processed && gWatchedAllocations.load(std::memory_order_relaxed) == 0U, label);
}

} // namespace

void* operator new(std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gWatchedAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}
void* operator new[](std::size_t size) {
    if (gWatchAllocations.load(std::memory_order_relaxed))
        gWatchedAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc{};
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    bool ok = true;
    ok = testValidationTransactions() && ok;
    ok = testRadioBandLimitAndStereo() && ok;
    ok = testRadioDriveAutomationContinuity() && ok;
    ok = testSustainerCompressionAndStereoLink() && ok;
    ok = testSustainerMakeupAutomationContinuity() && ok;
    ok = testSlowGearSwellAndLinkedStereo() && ok;
    ok = testSlowGearHighFrequencySteadyEnvelope() && ok;
    ok = testSlowGearOnsetAndFadeContinuity() && ok;
    ok = testStereoEnhanceFrequencyDependentWidth() && ok;
    ok = testNoAllocation<RadioFx>("radio event application and render allocate no memory") && ok;
    ok = testNoAllocation<SustainerFx>("sustainer event application and render allocate no memory") && ok;
    ok = testNoAllocation<SlowGearFx>("slow gear event application and render allocate no memory") && ok;
    ok = testNoAllocation<StereoEnhancerFx>("stereo enhancer event application and render allocate no memory") && ok;
    ok = testBlockScheduleInvariant<RadioFx>("radio block-schedule invariant") && ok;
    ok = testBlockScheduleInvariant<SustainerFx>("sustainer block-schedule invariant") && ok;
    ok = testBlockScheduleInvariant<SlowGearFx>("slow gear block-schedule invariant") && ok;
    ok = testBlockScheduleInvariant<StereoEnhancerFx>("stereo enhancer block-schedule invariant") && ok;
    if (!ok) return 1;
    std::puts("PASS: radio, sustainer, slow gear and stereo enhance; stereo response, sample events, block invariance and noalloc");
    return 0;
}
