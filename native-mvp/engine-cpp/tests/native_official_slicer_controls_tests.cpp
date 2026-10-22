#include "native_official_slicer.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <initializer_list>
#include <limits>
#include <string_view>
#include <utility>
#include <vector>

using webrc::native::NativeOfficialSlicer;
using Mode = NativeOfficialSlicer::Mode;
using Edit = std::pair<std::string_view, float>;
using Audio = std::vector<float>;
namespace {
constexpr unsigned int kRate = 48000U;
constexpr std::size_t kFrames = 96000U;
constexpr double kPi = 3.14159265358979323846;
constexpr std::array<std::string_view, 16U> kLevelKeys{{
    "official_step_level_1", "official_step_level_2", "official_step_level_3", "official_step_level_4",
    "official_step_level_5", "official_step_level_6", "official_step_level_7", "official_step_level_8",
    "official_step_level_9", "official_step_level_10", "official_step_level_11", "official_step_level_12",
    "official_step_level_13", "official_step_level_14", "official_step_level_15", "official_step_level_16",
}};
constexpr std::array<Edit, 7U> kStepDefaults{{
    {"official_rate", -1.0f}, {"official_step_max", 16.0f}, {"official_step_length", 50.0f},
    {"official_step_level", 100.0f}, {"official_depth", 100.0f},
    {"official_comp_threshold", -30.0f}, {"official_comp_gain", 6.0f},
}};
constexpr std::array<Edit, 6U> kPatternDefaults{{
    {"official_rate", -1.0f}, {"official_duty", 50.0f}, {"official_attack", 35.0f},
    {"official_depth", 100.0f}, {"official_comp_threshold", -30.0f}, {"official_comp_gain", 2.0f},
}};
float parameter(const NativeOfficialSlicer& core, std::string_view key) {
    float value = -9999.0f;
    assert(core.getParameter(key, value));
    return value;
}
void baseline(NativeOfficialSlicer& core, Mode mode, bool unevenLevels = true) {
    assert(core.setParameter("official_rate", 100.0f));
    assert(core.setParameter("official_comp_threshold", 0.0f));
    assert(core.setParameter("official_comp_gain", 0.0f));
    if (mode == Mode::Step && unevenLevels) {
        for (std::size_t i = 0U; i < kLevelKeys.size(); ++i)
            assert(core.setParameter(kLevelKeys[i], static_cast<float>(20U + i * 5U)));
    }
}
Audio render(Mode mode, std::initializer_list<Edit> edits, bool unevenLevels = true,
    std::size_t frames = kFrames) {
    NativeOfficialSlicer core(mode);
    assert(core.prepare(kRate));
    baseline(core, mode, unevenLevels);
    for (const auto& edit : edits) assert(core.setParameter(edit.first, edit.second));
    Audio result(frames * 2U);
    for (std::size_t f = 0U; f < frames; ++f) {
        const float signal = static_cast<float>(0.35 + 0.18 * std::sin(2.0 * kPi * 137.0 * f / kRate));
        std::array<float, 2U> frame{{signal, signal * 0.5f}};
        core.process(frame.data(), 2U);
        result[2U * f] = frame[0];
        result[2U * f + 1U] = frame[1];
    }
    return result;
}
double rms(const Audio& audio) {
    double sum = 0.0;
    for (const float value : audio) {
        assert(std::isfinite(value));
        sum += static_cast<double>(value) * value;
    }
    return std::sqrt(sum / audio.size());
}
double difference(const Audio& a, const Audio& b) {
    assert(a.size() == b.size());
    double sum = 0.0;
    for (std::size_t i = 0U; i < a.size(); ++i) {
        const double delta = static_cast<double>(a[i]) - b[i];
        sum += delta * delta;
    }
    return std::sqrt(sum / a.size());
}
void audible(const Audio& a, const Audio& b) {
    assert(rms(a) > 1.0e-6 && rms(b) > 1.0e-6);
    assert(difference(a, b) > 0.02 * std::min(rms(a), rms(b)));
}
void testActivationAndDefaults() {
    for (const auto mode : {Mode::Step, Mode::Pattern}) {
        NativeOfficialSlicer core(mode);
        assert(!core.active());
        assert(!core.prepare(7999U));
        assert(!core.prepare(192001U));
        assert(core.prepare(kRate));
        assert(core.setTempo(211.0f));
        assert(core.setQuarterNotesPerMeasure(3.0f));
        if (mode == Mode::Step) assert(core.setStepIndex(7U));
        else {
            const std::array<float, 4U> pattern{{1.0f, 0.0f, 0.5f, 0.0f}};
            assert(core.setAuthoredPattern(pattern.data(), pattern.size()));
        }
        assert(!core.active());
        std::array<float, 2U> unchanged{{0.25f, -0.125f}};
        core.process(unchanged.data(), 2U);
        assert(unchanged[0] == 0.25f && unchanged[1] == -0.125f);
        assert(!core.setParameter("official_pattern", 0.0f));
        assert(!core.setParameter("official_bpm", 120.0f));
        assert(!core.setParameter("official_step_index", 3.0f));
        assert(!core.setParameter("official_rate", -0.5f));
        assert(!core.active());
        assert(core.setParameter("official_depth", 33.0f));
        assert(core.active());
        if (mode == Mode::Step) {
            for (const auto& entry : kStepDefaults)
                assert(parameter(core, entry.first) == (entry.first == "official_depth" ? 33.0f : entry.second));
            for (const auto key : kLevelKeys) assert(parameter(core, key) == 100.0f);
            assert(core.setParameter("official_step_level", 41.0f));
            assert(parameter(core, "official_step_level_8") == 41.0f);
            assert(parameter(core, "official_step_level_1") == 100.0f);
        } else {
            for (const auto& entry : kPatternDefaults)
                assert(parameter(core, entry.first) == (entry.first == "official_depth" ? 33.0f : entry.second));
        }
        assert(core.setParameter("official_comp_threshold", -7.0f));
        assert(core.setParameter("official_comp_gain", 11.0f));
        assert(core.setParameter("official_rate", -4.0f));
        assert(std::fabs(core.targetRateHz() - 211.0f / 180.0f) < 1.0e-6f);
        assert(parameter(core, "official_depth") == 33.0f);
        assert(parameter(core, "official_comp_threshold") == -7.0f);
        core.reset();
        assert(core.active());
        assert(parameter(core, "official_comp_gain") == 11.0f);
        assert(core.prepare(96000U));
        assert(parameter(core, "official_depth") == 33.0f);
        assert(parameter(core, "official_rate") == -4.0f);
    }
    // Every supported knob can independently be the first activating control.
    for (const auto& entry : kStepDefaults) {
        NativeOfficialSlicer core;
        assert(core.setParameter(entry.first, entry.second));
        assert(core.active());
        assert(core.prepare(kRate));
        for (const auto& expected : kStepDefaults) assert(parameter(core, expected.first) == expected.second);
    }
    for (const auto& entry : kPatternDefaults) {
        NativeOfficialSlicer core(Mode::Pattern);
        assert(core.setParameter(entry.first, entry.second));
        assert(core.active());
        for (const auto& expected : kPatternDefaults) assert(parameter(core, expected.first) == expected.second);
    }
    for (const auto key : kLevelKeys) {
        NativeOfficialSlicer core;
        assert(core.setParameter(key, 39.0f));
        assert(core.active());
        assert(parameter(core, key) == 39.0f);
        assert(parameter(core, "official_step_max") == 16.0f);
    }
}
void testStrictDomains() {
    for (const auto mode : {Mode::Step, Mode::Pattern}) {
        const auto effect = mode == Mode::Step ? "step_slicer" : "pattern_slicer";
        for (const auto& domain : webrc::native::official::kDomains) {
            if (domain.effect != effect || domain.key == "official_pattern") continue;
            NativeOfficialSlicer core(mode);
            assert(!core.active());
            for (const float invalid : {std::numeric_limits<float>::quiet_NaN(),
                std::numeric_limits<float>::infinity(), -std::numeric_limits<float>::infinity()})
                assert(!core.setParameter(domain.key, invalid));
            assert(!core.active());
            if (domain.step > 0.0f) {
                assert(!core.setParameter(domain.key, domain.maximum + 1.0f));
                assert(!core.setParameter(domain.key, std::nextafter(domain.minimum, domain.maximum)));
                for (float value = domain.minimum; value <= domain.maximum; value += domain.step)
                    assert(core.setParameter(domain.key, value));
                assert(!core.setParameter(domain.key, domain.minimum + 0.5f));
                const float before = parameter(core, domain.key);
                assert(!core.setParameter(domain.key, 0.125f));
                assert(parameter(core, domain.key) == before);
            }
            for (std::size_t i = 0U; i < domain.count; ++i)
                assert(core.setParameter(domain.key, webrc::native::official::kDomainOptions[domain.offset + i]));
        }
        NativeOfficialSlicer core(mode);
        for (const auto invalidKey : {"official_pattern", "official_STEP_LEVEL", "official_step_level_0",
            "official_step_level_17", "official_step_level_01", "official_step_level_1junk", "rate", "bpm"})
            assert(!core.setParameter(invalidKey, 0.0f));
        for (const float invalidRate : {-1000.0f, -32.0f, -3.0f, -0.5f, -0.25f, 100.00001f, 50.5f})
            assert(!core.setParameter("official_rate", invalidRate));
        for (const float bad : {0.0f, 39.99f, 300.01f, std::numeric_limits<float>::quiet_NaN()})
            assert(!core.setTempo(bad));
        for (const float bad : {0.0f, 0.1249f, 128.001f, std::numeric_limits<float>::infinity()})
            assert(!core.setQuarterNotesPerMeasure(bad));
        assert(core.setTempo(40.0f));
        assert(core.setTempo(300.0f));
        assert(core.setQuarterNotesPerMeasure(0.125f));
        assert(core.setQuarterNotesPerMeasure(128.0f));
        assert(!core.active());
        assert(!core.setStepIndex(16U));
        assert(!core.setStepIndex(std::numeric_limits<unsigned int>::max()));
        if (mode == Mode::Step) {
            assert(!core.setParameter("official_duty", 50.0f));
            assert(!core.setParameter("official_attack", 35.0f));
        } else {
            assert(!core.setStepIndex(0U));
            for (const auto key : kLevelKeys) assert(!core.setParameter(key, 50.0f));
            assert(!core.setParameter("official_step_max", 16.0f));
        }
    }
}
void testRateAndMeter() {
    NativeOfficialSlicer core;
    assert(core.setParameter("official_rate", 0.0f));
    assert(std::fabs(core.targetRateHz() - 0.05f) < 1.0e-7f);
    assert(core.setParameter("official_rate", 50.0f));
    assert(std::fabs(core.targetRateHz() - 1.0f) < 1.0e-6f);
    assert(core.setParameter("official_rate", 100.0f));
    assert(std::fabs(core.targetRateHz() - 20.0f) < 1.0e-6f);
    for (const float rate : {-16.0f, -8.0f, -4.0f, -2.0f, -1.0f, -0.125f}) {
        assert(core.setTempo(120.0f));
        assert(core.setQuarterNotesPerMeasure(4.0f));
        assert(core.setParameter("official_rate", rate));
        const float base = core.targetRateHz();
        assert(std::fabs(base - 2.0f / -rate) < 1.0e-6f);
        assert(core.setQuarterNotesPerMeasure(3.0f));
        const float expected = rate <= -4.0f ? base * 4.0f / 3.0f : base;
        assert(std::fabs(core.targetRateHz() - expected) < 1.0e-6f);
        assert(core.setTempo(240.0f));
        assert(std::fabs(core.targetRateHz() - expected * 2.0f) < 2.0e-6f);
    }
    // Verify an actual slow measure clock is not clamped to a numeric RATE.
    assert(core.prepare(8000U));
    assert(core.setTempo(40.0f));
    assert(core.setQuarterNotesPerMeasure(128.0f));
    assert(core.setParameter("official_rate", -16.0f));
    assert(core.targetRateHz() < 0.002f);
    assert(core.setTempo(300.0f));
    assert(core.setQuarterNotesPerMeasure(0.125f));
    assert(core.setParameter("official_rate", -4.0f));
    assert(core.targetRateHz() == 40.0f);
    core.reset();
    for (unsigned int f = 0U; f < 199U; ++f) { float x = 0.2f; core.process(&x, 1U); }
    assert(core.stepIndex() == 0U);
    float x = 0.2f;
    core.process(&x, 1U);
    assert(core.stepIndex() == 1U);
}
void testEveryAudibleControl() {
    for (const auto mode : {Mode::Step, Mode::Pattern}) {
        audible(render(mode, {{"official_rate", 55.0f}}), render(mode, {{"official_rate", 100.0f}}));
        audible(render(mode, {{"official_depth", 0.0f}}), render(mode, {{"official_depth", 100.0f}}));
        audible(render(mode, {{"official_comp_threshold", -30.0f}}), render(mode, {{"official_comp_threshold", 0.0f}}));
        audible(render(mode, {{"official_comp_gain", 0.0f}}), render(mode, {{"official_comp_gain", 12.0f}}));
    }
    audible(render(Mode::Step, {{"official_step_max", 1.0f}}), render(Mode::Step, {{"official_step_max", 16.0f}}));
    audible(render(Mode::Step, {{"official_step_length", 1.0f}}), render(Mode::Step, {{"official_step_length", 100.0f}}));
    audible(render(Mode::Pattern, {{"official_duty", 1.0f}}), render(Mode::Pattern, {{"official_duty", 99.0f}}));
    audible(render(Mode::Pattern, {{"official_attack", 0.0f}}), render(Mode::Pattern, {{"official_attack", 100.0f}}));
    for (const auto key : kLevelKeys) {
        // More than two complete 16-step cycles, so every independent level
        // is actually visited and distinguished from the other fifteen.
        audible(render(Mode::Step, {{key, 0.0f}}, false), render(Mode::Step, {{key, 100.0f}}, false));
    }
    assert(difference(render(Mode::Step, {{"official_step_level", 23.0f}}, false),
        render(Mode::Step, {{"official_step_level_1", 23.0f}}, false)) == 0.0);
}
void testCompressorLawAndStereo() {
    NativeOfficialSlicer core;
    assert(core.prepare(kRate));
    assert(core.setParameter("official_depth", 0.0f));
    assert(core.setParameter("official_comp_threshold", -20.0f));
    assert(core.setParameter("official_comp_gain", 0.0f));
    std::array<float, 2U> frame{};
    for (std::size_t f = 0U; f < kFrames; ++f) {
        frame = {{0.8f, -0.2f}};
        core.process(frame.data(), 2U);
        assert(std::fabs(frame[0] + 4.0f * frame[1]) < 1.0e-7f);
    }
    const double expected = 0.8 * std::pow(8.0, -0.75);
    assert(std::fabs(frame[0] - expected) < 1.0e-6);
    assert(core.setParameter("official_comp_gain", 20.0f));
    frame = {{0.8f, -0.2f}};
    core.process(frame.data(), 2U);
    assert(std::fabs(frame[0] - 10.0 * expected) < 1.0e-5);
    assert(core.setParameter("official_comp_threshold", 0.0f));
    assert(core.setParameter("official_comp_gain", 0.0f));
    frame = {{0.8f, -0.2f}};
    core.process(frame.data(), 2U);
    assert(frame[0] == 0.8f && frame[1] == -0.2f);
}
void testPatternRetentionAndValidation() {
    const std::array<float, 8U> pattern{{1.0f, 0.0f, 0.4f, 0.0f, 1.0f, 0.0f, 0.2f, 0.0f}};
    NativeOfficialSlicer patterned(Mode::Pattern), neutral(Mode::Pattern);
    assert(patterned.setAuthoredPattern(pattern.data(), pattern.size()));
    assert(!patterned.active());
    assert(!patterned.setAuthoredPattern(nullptr, 1U));
    assert(!patterned.setAuthoredPattern(pattern.data(), 0U));
    assert(!patterned.setAuthoredPattern(pattern.data(), 17U));
    const std::array<float, 2U> invalid{{1.0f, std::numeric_limits<float>::quiet_NaN()}};
    assert(!patterned.setAuthoredPattern(invalid.data(), invalid.size()));
    const std::array<float, 2U> tooHigh{{0.0f, 1.01f}}, tooLow{{0.0f, -0.01f}};
    assert(!patterned.setAuthoredPattern(tooHigh.data(), tooHigh.size()));
    assert(!patterned.setAuthoredPattern(tooLow.data(), tooLow.size()));
    assert(patterned.prepare(kRate));
    assert(neutral.prepare(kRate));
    baseline(patterned, Mode::Pattern);
    baseline(neutral, Mode::Pattern);
    double differenceSum = 0.0;
    for (std::size_t f = 0U; f < kFrames; ++f) {
        float a = 0.3f, b = 0.3f;
        patterned.process(&a, 1U);
        neutral.process(&b, 1U);
        differenceSum += std::fabs(a - b);
    }
    assert(differenceSum > 1000.0);
    NativeOfficialSlicer step;
    assert(!step.setAuthoredPattern(pattern.data(), pattern.size()));
    assert(!step.active());
}
Audio automated(Mode mode, std::size_t blockSize) {
    NativeOfficialSlicer core(mode);
    assert(core.prepare(kRate));
    baseline(core, mode);
    Audio result(kFrames);
    for (std::size_t start = 0U; start < kFrames; start += blockSize) {
        const auto end = std::min(start + blockSize, kFrames);
        for (std::size_t f = start; f < end; ++f) {
            if (f == 137U) assert(core.setParameter("official_depth", 37.0f, 781U));
            if (f == 1103U) assert(core.setParameter("official_rate", -0.125f, 439U));
            if (f == 3501U) assert(core.setTempo(179.0f, 311U));
            if (f == 7109U) assert(core.setParameter("official_comp_threshold", -17.0f, 913U));
            if (f == 15111U) assert(core.setParameter("official_comp_gain", 7.0f, 711U));
            if (f == 19007U && mode == Mode::Step) assert(core.setParameter("official_step_max", 7.0f));
            if (f == 23021U) assert(core.setParameter(mode == Mode::Step ? "official_step_length" : "official_duty", 87.0f, 1027U));
            float value = static_cast<float>(0.2 * std::sin(2.0 * kPi * 173.0 * f / kRate));
            core.process(&value, 1U);
            result[f] = value;
        }
    }
    return result;
}
void testChunksAndReset() {
    for (const auto mode : {Mode::Step, Mode::Pattern}) {
        const auto reference = automated(mode, 1U);
        for (const std::size_t chunk : {17U, 128U, 511U, 4096U}) assert(difference(reference, automated(mode, chunk)) == 0.0);
        NativeOfficialSlicer a(mode), b(mode);
        assert(a.prepare(kRate) && b.prepare(kRate));
        baseline(a, mode);
        baseline(b, mode);
        assert(a.setParameter("official_depth", 37.0f, 10000U));
        assert(b.setParameter("official_depth", 37.0f));
        for (unsigned int f = 0U; f < 731U; ++f) { float value = 0.2f; a.process(&value, 1U); }
        a.reset();
        b.reset();
        for (unsigned int f = 0U; f < 8000U; ++f) {
            std::array<float, 2U> left{{0.3f, -0.2f}}, right = left;
            a.process(left.data(), 2U);
            b.process(right.data(), 2U);
            assert(left == right);
        }
        // Setter smoothing must make a gain automation less abrupt.
        assert(a.setParameter("official_depth", 0.0f));
        assert(a.setParameter("official_comp_threshold", 0.0f));
        assert(a.setParameter("official_comp_gain", 0.0f));
        a.reset();
        float before = 0.2f;
        a.process(&before, 1U);
        assert(a.setParameter("official_comp_gain", 20.0f, 4800U));
        float after = 0.2f;
        a.process(&after, 1U);
        assert(std::fabs(after - before) < 0.0002f);
    }
}
void testFiniteAndNoHeap() {
    using namespace webrc::native;
    for (const auto mode : {Mode::Step, Mode::Pattern}) {
        NativeOfficialSlicer core(mode);
        assert(core.prepare(kRate));
        baseline(core, mode);
        const std::array<float, 6U> badAudio{{std::numeric_limits<float>::quiet_NaN(),
            std::numeric_limits<float>::infinity(), -std::numeric_limits<float>::infinity(),
            std::numeric_limits<float>::max(), -std::numeric_limits<float>::max(), 1.0e-35f}};
        const std::array<float, 4U> pattern{{1.0f, 0.0f, 0.5f, 0.0f}};
        const auto initialAllocations = test_alloc::count();
        test_alloc::beginTracking();
        for (unsigned int iteration = 0U; iteration < 512U; ++iteration) {
            assert(core.setTempo(40.0f + iteration % 261U, 127U));
            assert(core.setQuarterNotesPerMeasure(iteration % 2U == 0U ? 0.125f : 128.0f, 257U));
            assert(core.setParameter("official_rate", iteration % 2U == 0U ? -4.0f : 100.0f, 128U));
            assert(core.setParameter("official_depth", static_cast<float>(iteration % 101U), 64U));
            assert(core.setParameter("official_comp_threshold", iteration % 2U == 0U ? -30.0f : 0.0f, 17U));
            assert(core.setParameter("official_comp_gain", iteration % 2U == 0U ? 20.0f : 0.0f, 29U));
            if (mode == Mode::Step) {
                assert(core.setParameter("official_step_max", 1.0f + iteration % 16U));
                assert(core.setParameter("official_step_length", 1.0f + iteration % 100U, 33U));
                assert(core.setStepIndex(iteration % 16U));
                assert(core.setParameter(kLevelKeys[iteration % 16U], static_cast<float>(iteration % 101U), 12U));
            } else {
                assert(core.setParameter("official_duty", 1.0f + iteration % 99U, 33U));
                assert(core.setParameter("official_attack", static_cast<float>(iteration % 101U), 32U));
                assert(core.setAuthoredPattern(pattern.data(), pattern.size()));
            }
            if (iteration % 17U == 0U) core.reset();
            for (const float input : badAudio) {
                std::array<float, 3U> frame{{input, -input, 123.0f}};
                core.process(frame.data(), 3U);
                assert(std::isfinite(frame[0]) && std::isfinite(frame[1]));
                assert(std::fabs(frame[0]) <= 8.0f && std::fabs(frame[1]) <= 8.0f);
                assert(frame[2] == 123.0f);
                if (!std::isfinite(input)) assert(frame[0] == 0.0f && frame[1] == 0.0f);
            }
            for (unsigned int f = 0U; f < 257U; ++f) {
                std::array<float, 2U> frame{{7.9f, -7.9f}};
                core.process(frame.data(), 2U);
                assert(std::isfinite(frame[0]) && std::fabs(frame[0]) <= 8.0f);
                assert(std::isfinite(frame[1]) && std::fabs(frame[1]) <= 8.0f);
            }
            core.process(nullptr, 0U);
            core.process(nullptr, 2U);
        }
        core.reset();
        test_alloc::endTracking();
        assert(test_alloc::count() == initialAllocations);
    }
}
} // namespace
int main() {
    testActivationAndDefaults();
    testStrictDomains();
    testRateAndMeter();
    testEveryAudibleControl();
    testCompressorLawAndStereo();
    testPatternRetentionAndValidation();
    testChunksAndReset();
    testFiniteAndNoHeap();
    std::puts("Native official slicer controls: all tests passed");
}
