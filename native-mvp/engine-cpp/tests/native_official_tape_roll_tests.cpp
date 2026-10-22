#include "native_official_tape_roll.hpp"
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

using namespace webrc::native;

namespace {
constexpr unsigned int kRate = 8000U;
constexpr unsigned int kFrames = 8000U;
using Control = std::pair<std::string_view, float>;

std::vector<float> fixture(unsigned int frames = kFrames) {
    std::vector<float> samples(static_cast<std::size_t>(frames) * 2U);
    std::uint32_t noise = 0x505ec401U;
    for (unsigned int i = 0U; i < frames; ++i) {
        noise = noise * 1664525U + 1013904223U;
        const double random = static_cast<double>(noise >> 8U) / 8388608.0 - 1.0;
        const double t = static_cast<double>(i) / kRate;
        const double envelope = .25 + .75 * std::exp(-static_cast<double>(i % 503U) / 90.0);
        const double sample = envelope * (.23 * std::sin(6.28318530717958647692 * 83 * t) +
            .13 * std::sin(6.28318530717958647692 * 617 * t) +
            .11 * std::sin(6.28318530717958647692 * 3271 * t) + .12 * random);
        samples[2U * i] = static_cast<float>(sample);
        samples[2U * i + 1U] = static_cast<float>(-.61 * sample + .03 * random);
    }
    return samples;
}

double difference(const std::vector<float>& a, const std::vector<float>& b) {
    assert(a.size() == b.size());
    double delta = 0.0, energy = 0.0;
    for (std::size_t i = 0U; i < a.size(); ++i) {
        assert(std::isfinite(a[i]) && std::isfinite(b[i]));
        delta += (a[i] - b[i]) * (a[i] - b[i]);
        energy += a[i] * a[i];
    }
    return std::sqrt(delta / std::max(energy, 1.0e-20));
}

template<class Processor>
void renderChunks(Processor& processor, std::vector<float>& samples, unsigned int chunk) {
    const auto frames = static_cast<unsigned int>(samples.size() / 2U);
    for (unsigned int offset = 0U; offset < frames; offset += chunk)
        processor.processInPlace(samples.data() + static_cast<std::size_t>(offset) * 2U, std::min(chunk, frames - offset), 2U);
}

std::vector<float> renderTape(unsigned int variant, std::initializer_list<Control> controls = {}, unsigned int chunk = kFrames) {
    NativeOfficialTapeEcho tape;
    assert(tape.prepare(kRate)); assert(tape.setVariant(variant));
    assert(tape.setParameter("official_d_level", 0.0f));
    assert(tape.setParameter("official_e_level", 100.0f));
    if (variant == 2U) assert(tape.setParameter("official_repeat_rate", 12.0f));
    for (const auto& control : controls) assert(tape.setParameter(control.first, control.second));
    tape.reset();
    auto samples = fixture();
    renderChunks(tape, samples, chunk);
    return samples;
}

void checkDomainsAndBranches() {
    NativeOfficialTapeEcho tape;
    NativeOfficialRoll roll;
    assert(!tape.prepare(7999U)); assert(!tape.prepare(192001U));
    assert(!roll.prepare(7999U)); assert(!roll.prepare(192001U));
    assert(tape.prepare(kRate)); assert(roll.prepare(kRate));
    for (unsigned int variant : {1U, 2U}) {
        assert(tape.setVariant(variant)); assert(roll.setVariant(variant));
        const std::string_view tapeId = variant == 1U ? "tape_echo1" : "tape_echo2";
        const std::string_view rollId = variant == 1U ? "roll1" : "roll2";
        unsigned int tapeCount = 0U, rollCount = 0U;
        for (const auto& domain : official::kDomains) {
            const auto verify = [&](auto& processor) {
                assert(!processor.setParameter(domain.key, std::numeric_limits<float>::quiet_NaN()));
                assert(!processor.setParameter(domain.key, std::numeric_limits<float>::infinity()));
                if (domain.hasDefault) assert(processor.setParameter(domain.key, domain.defaultValue));
                if (domain.step != 0.0f) {
                    assert(processor.setParameter(domain.key, domain.minimum));
                    assert(processor.setParameter(domain.key, domain.maximum));
                    assert(!processor.setParameter(domain.key, domain.maximum + domain.step));
                    assert(!processor.setParameter(domain.key, domain.minimum + domain.step * .25f));
                }
                for (std::size_t i = 0U; i < domain.count; ++i)
                    assert(processor.setParameter(domain.key, official::kDomainOptions[domain.offset + i]));
            };
            if (domain.effect == tapeId) { ++tapeCount; verify(tape); }
            if (domain.effect == rollId) { ++rollCount; verify(roll); }
        }
        assert(tapeCount == 6U && rollCount == 4U);
        assert(!tape.setParameter("official_variant", static_cast<float>(variant)));
        assert(!roll.setParameter("official_variant", static_cast<float>(variant)));
        assert(!tape.setParameter("official_unknown", 0.0f));
        assert(!roll.setParameter("official_unknown", 0.0f));
        for (float invalid : {-4.0f, -0.5f, -0.25f, -1000.0f, 0.0f}) {
            assert(!roll.setParameter("official_time", invalid));
            if (variant == 2U) assert(!tape.setParameter("official_repeat_rate", invalid));
        }
        assert(!roll.setParameter(variant == 1U ? "official_repeat" : "official_feedback", 50.0f));
        assert(!tape.setParameter(variant == 1U ? "official_low_cut" : "official_bass", variant == 1U ? 1000.0f : 0.0f));
        assert(!tape.setParameter(variant == 1U ? "official_high_cut" : "official_treble", variant == 1U ? 1000.0f : 0.0f));
        const auto* rollDomain = official::parameterDomain(rollId, "official_roll");
        assert(rollDomain != nullptr && !rollDomain->hasDefault);
        assert(!roll.setParameter("official_roll", 5.0f));
        assert(!roll.setParameter("official_roll", 1.5f));
    }
    assert(!tape.setVariant(0U)); assert(!tape.setVariant(3U));
    assert(!roll.setVariant(0U)); assert(!roll.setVariant(3U));
    for (float invalid : {0.0f, 39.99f, 300.01f, std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN()}) {
        assert(!tape.setTempo(invalid)); assert(!roll.setTempo(invalid));
    }
    assert(tape.setVariant(1U));
    assert(!tape.setParameter("official_repeat_rate", 200.0f));
    assert(!tape.setParameter("official_repeat_rate", -1.0f));
    assert(roll.setVariant(1U)); assert(!roll.setParameter("official_feedback", -1000.0f));
    assert(roll.setVariant(2U)); assert(roll.setParameter("official_repeat", -1000.0f));
    assert(roll.setVariant(1U)); assert(roll.repeatCount() == 50 && roll.selectedRoll() == 0U);
}

void checkTiming() {
    NativeOfficialTapeEcho tape;
    NativeOfficialRoll roll;
    assert(tape.prepare(kRate)); assert(roll.prepare(kRate));
    assert(tape.setParameter("official_repeat_rate", 0.0f)); assert(std::abs(tape.delayMilliseconds() - 2000.0f) < .01f);
    assert(tape.setParameter("official_repeat_rate", 50.0f)); assert(std::abs(tape.delayMilliseconds() - 44.72135955f) < .001f);
    assert(tape.setParameter("official_repeat_rate", 100.0f)); assert(std::abs(tape.delayMilliseconds() - 1.0f) < .001f);
    assert(tape.setVariant(2U)); assert(std::abs(tape.delayMilliseconds() - 200.0f) < .001f);
    for (float bpm : {40.0f, 120.0f, 300.0f}) {
        assert(tape.setTempo(bpm)); assert(roll.setTempo(bpm));
        for (float note : {-2.0f, -1.0f, -0.125f}) {
            assert(tape.setParameter("official_repeat_rate", note));
            assert(roll.setParameter("official_time", note));
            assert(std::abs(tape.delayMilliseconds() + note * 60000.0f / bpm) < .01f);
            assert(roll.timeFrames() == static_cast<std::size_t>(std::llround(-note * 60.0 * kRate / bpm)));
        }
        assert(tape.setParameter("official_repeat_rate", 2000.0f));
        assert(roll.setParameter("official_time", 1000.0f));
        assert(std::abs(tape.delayMilliseconds() - 2000.0f) < .001f);
        assert(roll.timeFrames() == kRate);
    }
    // Verify real onset, not just a parameter getter, including 3-second sync.
    assert(tape.setTempo(40.0f));
    for (float time : {1.0f, 2000.0f, -2.0f}) {
        assert(tape.setParameter("official_repeat_rate", time));
        assert(tape.setParameter("official_intensity", 0.0f));
        assert(tape.setParameter("official_d_level", 0.0f));
        assert(tape.setParameter("official_e_level", 100.0f));
        tape.reset();
        const auto expected = static_cast<unsigned int>(std::llround(tape.delayMilliseconds() * kRate * .001));
        for (unsigned int i = 0U; i <= expected; ++i) {
            float frame[2]{i == 0U ? .5f : 0.0f, 0.0f}; tape.process(frame, 2U);
            if (i < expected) assert(frame[0] == 0.0f);
            else assert(frame[0] > .1f);
            assert(frame[1] == 0.0f);
        }
    }
}

void checkTapeAudibilityAndMix() {
    for (unsigned int variant : {1U, 2U}) {
        const auto baseline = renderTape(variant);
        for (const auto& control : std::initializer_list<Control>{
            {"official_repeat_rate", variant == 1U ? 80.0f : 53.0f},
            {"official_intensity", 100.0f}, {"official_d_level", 100.0f}, {"official_e_level", 120.0f}}) {
            const auto changed = renderTape(variant, {control});
            assert(difference(baseline, changed) > .01);
        }
        if (variant == 1U) {
            for (const auto& control : std::initializer_list<Control>{{"official_bass", -50.0f}, {"official_bass", 50.0f},
                    {"official_treble", -50.0f}, {"official_treble", 50.0f}})
                assert(difference(baseline, renderTape(variant, {control})) > .01);
        } else {
            assert(difference(baseline, renderTape(variant, {{"official_low_cut", 1200.0f}})) > .1);
            assert(difference(baseline, renderTape(variant, {{"official_high_cut", 200.0f}})) > .1);
            assert(baseline == renderTape(variant, {{"official_low_cut", -1000.0f}, {"official_high_cut", -1000.0f}}));
        }
        const auto wet120 = renderTape(variant, {{"official_e_level", 120.0f}});
        for (std::size_t i = 0U; i < baseline.size(); ++i) assert(std::abs(wet120[i] - baseline[i] * 1.2f) < 1.0e-6f);
        const auto dry = renderTape(variant, {{"official_d_level", 100.0f}, {"official_e_level", 0.0f}});
        assert(dry == fixture());
        const auto mute = renderTape(variant, {{"official_d_level", 0.0f}, {"official_e_level", 0.0f}});
        for (float sample : mute) assert(sample == 0.0f);
        if (variant == 2U) assert(dry == renderTape(variant, {{"official_d_level", 100.0f}, {"official_e_level", 0.0f},
            {"official_low_cut", 12500.0f}, {"official_high_cut", 20.0f}}));
        else assert(dry == renderTape(variant, {{"official_d_level", 100.0f}, {"official_e_level", 0.0f},
            {"official_bass", -50.0f}, {"official_treble", 50.0f}}));
    }
}

void setupRoll(NativeOfficialRoll& roll, unsigned int variant = 2U, float time = 8.0f) {
    assert(roll.prepare(kRate)); assert(roll.setVariant(variant));
    assert(roll.setParameter("official_time", time)); assert(roll.setParameter("official_balance", 100.0f));
}

void preload(NativeOfficialRoll& roll) {
    for (std::size_t i = 0U; i < roll.timeFrames(); ++i) {
        float frame[2]{static_cast<float>(.1 + .001 * i), static_cast<float>(-.2 - .002 * i)};
        roll.process(frame, 2U); assert(frame[0] == 0.0f && frame[1] == 0.0f);
    }
}

void checkRollCaptureAndCount() {
    for (unsigned int variant : {1U, 2U}) {
        NativeOfficialRoll roll; setupRoll(roll, variant); preload(roll);
        assert(!roll.isPlaying()); assert(!roll.hasCapturedSlice());
        const std::string_view repeatKey = variant == 1U ? "official_feedback" : "official_repeat";
        assert(roll.setParameter("official_roll", 1.0f));
        assert(roll.hasCapturedSlice() && roll.isPlaying() && !roll.isCapturePending());
        assert(roll.activeCycleFrames() == 32U);
        for (unsigned int division = 1U; division <= 4U; ++division) {
            assert(roll.setParameter("official_roll", static_cast<float>(division)));
            assert(roll.activeCycleFrames() == (64U >> division));
            for (unsigned int i = 0U; i < 3U * roll.activeCycleFrames(); ++i) {
                float frame[2]{4.0f, -4.0f}; roll.process(frame, 2U);
                const auto position = i % roll.activeCycleFrames();
                assert(std::abs(frame[0] - static_cast<float>(.1 + .001 * position)) < 1.0e-7f);
                assert(std::abs(frame[1] - static_cast<float>(-.2 - .002 * position)) < 1.0e-7f);
            }
        }
        assert(roll.setParameter(repeatKey, 3.0f)); assert(roll.setParameter("official_roll", 0.0f));
        for (unsigned int i = 0U; i < 12U; ++i) {
            float frame[2]{}; roll.process(frame, 2U);
            assert(std::abs(frame[0] - static_cast<float>(.1 + .001 * (i % 4U))) < 1.0e-7f);
        }
        assert(roll.completedReleaseRepeats() == 3U && !roll.isPlaying() && roll.hasCapturedSlice());
        float silent[2]{}; roll.process(silent, 2U); assert(silent[0] == 0.0f && silent[1] == 0.0f);
        // OFF->ON takes new live source history instead of the old frozen input.
        for (unsigned int i = 0U; i < 64U; ++i) { float frame[2]{.7f, -.4f}; roll.process(frame, 2U); }
        assert(roll.setParameter("official_roll", 1.0f));
        float refreshed[2]{}; roll.process(refreshed, 2U); assert(refreshed[0] == .7f && refreshed[1] == -.4f);
        for (unsigned int count : {1U, 50U, 100U}) {
            assert(roll.setParameter(repeatKey, static_cast<float>(count)));
            assert(roll.setParameter("official_roll", 0.0f));
            for (std::size_t i = 0U; i < count * roll.activeCycleFrames(); ++i) {
                float frame[2]{.7f, -.4f}; roll.process(frame, 2U); assert(frame[0] == .7f);
            }
            assert(!roll.isPlaying() && roll.completedReleaseRepeats() == count);
            float frame[2]{.7f, -.4f}; roll.process(frame, 2U); assert(frame[0] == 0.0f);
            for (unsigned int i = 0U; i < 64U; ++i) { float next[2]{.7f, -.4f}; roll.process(next, 2U); }
            assert(roll.setParameter("official_roll", 1.0f));
        }
    }
}

void checkRollTransitionsAndResampling() {
    NativeOfficialRoll roll; setupRoll(roll);
    assert(roll.setParameter("official_roll", 1.0f)); assert(roll.isCapturePending());
    for (unsigned int i = 0U; i < 64U; ++i) {
        float frame[2]{static_cast<float>(i) / 100.0f, -.3f}; roll.process(frame, 2U);
        assert(frame[0] == 0.0f); // Capture finishes after the final sample's output.
    }
    assert(roll.isPlaying());
    float first[2]{2.0f, 2.0f}; roll.process(first, 2U); assert(first[0] == 0.0f && first[1] == -.3f);
    assert(roll.setParameter("official_time", 16.0f)); assert(roll.activeCycleFrames() == 64U);
    for (unsigned int i = 0U; i < 20U; ++i) {
        float frame[2]{2.0f, 2.0f}; roll.process(frame, 2U);
        assert(std::abs(frame[0] - static_cast<float>(i) / 200.0f) < 1.0e-7f);
    }
    assert(roll.setParameter("official_repeat", 5.0f)); assert(roll.setParameter("official_roll", 0.0f));
    for (unsigned int i = 0U; i < 128U; ++i) { float frame[2]{}; roll.process(frame, 2U); }
    assert(roll.completedReleaseRepeats() == 2U);
    assert(roll.setParameter("official_repeat", 3.0f));
    for (unsigned int i = 0U; i < 64U; ++i) { float frame[2]{}; roll.process(frame, 2U); }
    assert(roll.completedReleaseRepeats() == 3U && !roll.isPlaying());
    roll.reset(); assert(roll.setParameter("official_time", 8.0f)); preload(roll);
    assert(roll.setParameter("official_roll", 4.0f));
    assert(roll.setParameter("official_repeat", -1000.0f)); assert(roll.setParameter("official_roll", 0.0f));
    for (unsigned int i = 0U; i < 804U; ++i) { float frame[2]{}; roll.process(frame, 2U); assert(frame[0] > 0.0f); }
    assert(roll.isPlaying() && roll.completedReleaseRepeats() == 201U);
    assert(roll.setParameter("official_repeat", 100.0f)); assert(!roll.isPlaying());
    assert(roll.setVariant(1U)); assert(roll.repeatCount() == 50 && !roll.hasCapturedSlice());
    assert(!roll.isPlaying() && !roll.isCapturePending() && roll.selectedRoll() == 0U);
    assert(roll.setParameter("official_time", 8.0f)); assert(roll.setParameter("official_roll", 1.0f));
    for (unsigned int i = 0U; i < 10U; ++i) { float frame[2]{.4f, .4f}; roll.process(frame, 2U); }
    assert(roll.setParameter("official_roll", 0.0f)); assert(!roll.isCapturePending());
    assert(roll.setParameter("official_balance", 100.0f));
    for (unsigned int i = 0U; i < 100U; ++i) { float frame[2]{.4f, .4f}; roll.process(frame, 2U); assert(frame[0] == 0.0f); }
    // ROLL is the captured effect, BALANCE is independently audible.
    assert(roll.setParameter("official_roll", 1.0f));
    assert(roll.setParameter("official_balance", 0.0f));
    float dry[2]{-.7f, .9f}; roll.process(dry, 2U); assert(dry[0] == -.7f && dry[1] == .9f);
    assert(roll.setParameter("official_balance", 50.0f));
    float mixed[2]{-.8f, .8f}; roll.process(mixed, 2U); assert(std::abs(mixed[0] + .2f) < 1.0e-7f);
}

void checkResetChunkingAndStaleBranches() {
    for (unsigned int variant : {1U, 2U}) {
        assert(renderTape(variant) == renderTape(variant, {}, 1U));
        assert(renderTape(variant) == renderTape(variant, {}, 137U));
        NativeOfficialTapeEcho tape, fresh;
        assert(tape.prepare(kRate)); assert(fresh.prepare(kRate));
        assert(tape.setVariant(variant == 1U ? 2U : 1U));
        assert(tape.setParameter(variant == 1U ? "official_low_cut" : "official_bass", variant == 1U ? 1200.0f : 50.0f));
        auto old = fixture(); renderChunks(tape, old, 97U);
        assert(tape.setVariant(variant)); assert(fresh.setVariant(variant));
        auto a = fixture(), b = a; renderChunks(tape, a, 59U); renderChunks(fresh, b, kFrames); assert(a == b);
        tape.reset(); auto c = fixture(); renderChunks(tape, c, 173U); assert(a == c);
        NativeOfficialRoll rollA, rollB; setupRoll(rollA, variant); setupRoll(rollB, variant);
        assert(rollA.setParameter("official_roll", 2.0f)); assert(rollB.setParameter("official_roll", 2.0f));
        a = fixture(); b = a; renderChunks(rollA, a, 1U); renderChunks(rollB, b, 137U); assert(a == b);
        rollA.reset(); c = fixture(); renderChunks(rollA, c, 191U); assert(a == c);
        assert(rollA.setVariant(variant == 1U ? 2U : 1U));
        assert(rollA.setVariant(variant)); assert(!rollA.hasCapturedSlice());
        assert(rollA.setParameter("official_balance", 100.0f));
        float zero[2]{}; rollA.process(zero, 2U); assert(zero[0] == 0.0f && zero[1] == 0.0f);
    }
}

void checkReprepareAndSameVariant() {
    NativeOfficialTapeEcho tape, reference;
    const auto configureTape = [](NativeOfficialTapeEcho& processor, unsigned int rate) {
        assert(processor.prepare(rate)); assert(processor.setVariant(2U));
        for (const auto& control : std::initializer_list<Control>{{"official_repeat_rate", -1.0f},
                {"official_intensity", 73.0f}, {"official_d_level", 0.0f}, {"official_e_level", 115.0f},
                {"official_low_cut", 51.2f}, {"official_high_cut", 2900.3f}})
            assert(processor.setParameter(control.first, control.second));
        assert(processor.setTempo(300.0f));
    };
    configureTape(tape, kRate); configureTape(reference, kRate);
    auto a = fixture(), b = a;
    tape.processInPlace(a.data(), 2000U, 2U); reference.processInPlace(b.data(), 2000U, 2U);
    assert(tape.setVariant(2U)); // A same-variant selection must not clear audio or controls.
    tape.processInPlace(a.data() + 4000U, kFrames - 2000U, 2U);
    reference.processInPlace(b.data() + 4000U, kFrames - 2000U, 2U);
    assert(a == b);
    assert(tape.prepare(16000U)); configureTape(reference, 16000U);
    a = fixture(); b = a; renderChunks(tape, a, 73U); renderChunks(reference, b, 157U); assert(a == b);
    assert(tape.variant() == 2U && std::abs(tape.delayMilliseconds() - 200.0f) < .001f);
    assert(!tape.prepare(1U)); // Invalid reprepare leaves the prior state intact.
    tape.reset();
    for (unsigned int i = 0U; i < 10000U; ++i) { float frame[2]{}; tape.process(frame, 2U); assert(frame[0] == 0.0f); }

    NativeOfficialRoll roll, fresh;
    setupRoll(roll); preload(roll);
    assert(roll.setParameter("official_repeat", -1000.0f));
    assert(roll.setParameter("official_roll", 2.0f));
    assert(roll.setVariant(2U));
    assert(roll.isPlaying() && roll.hasCapturedSlice() && roll.repeatCount() == -1000);
    float first[2]{}; roll.process(first, 2U); assert(first[0] == .1f);
    assert(roll.prepare(16000U));
    assert(roll.variant() == 2U && roll.selectedRoll() == 2U && roll.repeatCount() == -1000);
    assert(roll.timeFrames() == 128U && roll.activeCycleFrames() == 32U);
    assert(!roll.hasCapturedSlice() && roll.isCapturePending());
    assert(fresh.prepare(16000U)); assert(fresh.setVariant(2U));
    assert(fresh.setParameter("official_time", 8.0f)); assert(fresh.setParameter("official_balance", 100.0f));
    assert(fresh.setParameter("official_repeat", -1000.0f)); assert(fresh.setParameter("official_roll", 2.0f));
    a = fixture(); b = a; renderChunks(roll, a, 61U); renderChunks(fresh, b, 191U); assert(a == b);
    assert(!roll.prepare(1U)); assert(roll.hasCapturedSlice());
    // Sync timing follows tempo while retaining the captured content.
    assert(roll.setParameter("official_time", -1.0f)); assert(roll.setTempo(40.0f));
    assert(roll.timeFrames() == 24000U && roll.hasCapturedSlice());
    assert(roll.setTempo(300.0f)); assert(roll.timeFrames() == 3200U && roll.hasCapturedSlice());
}

void checkRatesAndMono() {
    for (unsigned int rate : {8000U, 44100U, 48000U, 192000U}) {
        NativeOfficialTapeEcho tape;
        NativeOfficialRoll roll;
        assert(tape.prepare(rate)); assert(roll.prepare(rate));
        assert(tape.setVariant(2U)); assert(tape.setTempo(40.0f));
        assert(tape.setParameter("official_repeat_rate", -2.0f));
        assert(std::abs(tape.delayMilliseconds() - 3000.0f) < .01f);
        assert(tape.setParameter("official_repeat_rate", 1.0f));
        assert(roll.setParameter("official_time", 1.0f));
        assert(roll.setParameter("official_roll", 4.0f));
        assert(roll.setParameter("official_balance", 100.0f));
        for (unsigned int i = 0U; i < 2048U; ++i) {
            float tapeFrame[2]{.25f, 7.0f}, rollFrame[2]{.25f, 7.0f};
            tape.process(tapeFrame, 1U); roll.process(rollFrame, 1U);
            assert(std::isfinite(tapeFrame[0]) && std::isfinite(rollFrame[0]));
            assert(tapeFrame[1] == 7.0f && rollFrame[1] == 7.0f);
        }
        assert(roll.hasCapturedSlice());
    }
}

void checkNoAllocAndFinite() {
    NativeOfficialTapeEcho tape;
    NativeOfficialRoll roll;
    assert(tape.prepare(kRate)); assert(roll.prepare(kRate));
    const auto before = test_alloc::count();
    test_alloc::beginTracking();
    for (unsigned int variant : {1U, 2U}) {
        assert(tape.setVariant(variant)); assert(roll.setVariant(variant));
        assert(tape.setTempo(40.0f, 64U)); assert(roll.setTempo(40.0f));
        const std::string_view tapeId = variant == 1U ? "tape_echo1" : "tape_echo2";
        const std::string_view rollId = variant == 1U ? "roll1" : "roll2";
        for (const auto& domain : official::kDomains) {
            if (domain.effect == tapeId) assert(tape.setParameter(domain.key, domain.step != 0.0f ? domain.maximum : official::kDomainOptions[domain.offset], 31U));
            if (domain.effect == rollId) assert(roll.setParameter(domain.key, domain.step != 0.0f ? domain.maximum : official::kDomainOptions[domain.offset], 31U));
        }
        assert(roll.setParameter("official_time", -2.0f)); assert(roll.setParameter("official_roll", 1.0f));
        for (unsigned int i = 0U; i < 25000U; ++i) {
            const float input = i % 37U == 0U ? std::numeric_limits<float>::infinity() : i % 19U == 0U ?
                std::numeric_limits<float>::quiet_NaN() : (i % 2U == 0U ? 1.0e20f : -1.0e20f);
            float tapeFrame[2]{input, -input}, rollFrame[2]{input, -input};
            tape.process(tapeFrame, 2U); roll.process(rollFrame, 2U);
            for (float sample : tapeFrame) assert(std::isfinite(sample) && std::abs(sample) <= 8.0f);
            for (float sample : rollFrame) assert(std::isfinite(sample) && std::abs(sample) <= 8.0f);
        }
        assert(roll.hasCapturedSlice());
        assert(roll.setParameter("official_roll", 0.0f));
        tape.reset(); roll.reset();
        tape.process(nullptr, 2U); roll.process(nullptr, 2U);
        float frame[2]{}; tape.process(frame, 0U); roll.process(frame, 0U);
        tape.processInPlace(nullptr, 64U, 2U); roll.processInPlace(nullptr, 64U, 2U);
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == before);
}
} // namespace

int main() {
    checkDomainsAndBranches();
    checkTiming();
    checkTapeAudibilityAndMix();
    checkRollCaptureAndCount();
    checkRollTransitionsAndResampling();
    checkResetChunkingAndStaleBranches();
    checkReprepareAndSameVariant();
    checkRatesAndMono();
    checkNoAllocAndFinite();
    std::puts("Native official tape/roll controls: all checks passed");
}
