#include "native_fx_catalog.hpp"
#include "native_official_fx.hpp"
#include "native_auto_riff_core.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>
#include <string_view>
#include <vector>

using namespace webrc::native;

namespace {
constexpr unsigned int kRate = 48000U;
constexpr unsigned int kFrames = 48000U;
constexpr std::array<std::string_view, 34U> kEffects{{
    "filter.lpf", "filter.bpf", "filter.hpf", "phaser", "flanger", "dist", "eq",
    "lo_fi", "radio", "ring_mod", "sustainer", "slow_gear",
    "auto_pan", "manual_pan", "tremolo", "vibrato",
    "reverb", "gate_reverb", "chorus", "stereo_enhance", "synth", "g2b", "isolator",
    "fractional_delay", "panning_delay", "reverse_delay", "mod_delay",
    "warp", "granular_delay", "beat_repeat", "beat_scatter", "reverse_reverb", "freeze", "twist"}};

std::vector<float> signal() {
    std::vector<float> result(kFrames * 2U);
    unsigned int noise = 0x12345678U;
    for (unsigned int i = 0U; i < kFrames; ++i) {
        noise = noise * 1664525U + 1013904223U;
        const float random = static_cast<float>(noise >> 8U) / 16777216.0f - 0.5f;
        const double t = static_cast<double>(i) / kRate;
        const float sample = 0.11f * static_cast<float>(std::sin(6.283185307179586 * 113.0 * t)) +
            0.09f * static_cast<float>(std::sin(6.283185307179586 * 873.0 * t)) +
            0.07f * static_cast<float>(std::sin(6.283185307179586 * 4177.0 * t)) + 0.06f * random;
        const float envelope = (i % 9600U) < 4800U ? 1.0f : 0.15f;
        result[2U * i] = sample * envelope;
        result[2U * i + 1U] = sample * envelope;
    }
    return result;
}

void setOfficialDefaults(NativeEffectProcessor& processor) {
    std::size_t count = 0U;
    const auto* parameters = nativeEffectOfficialParameters(processor.stableId(), count);
    assert(count != 0U);
    for (std::size_t i = 0U; i < count; ++i) {
        const bool accepted = processor.setParameter(parameters[i].id, parameters[i].defaultValue, 1U);
        if (!accepted) std::fprintf(stderr, "Rejected default: %.*s/%.*s=%g\n", static_cast<int>(processor.stableId().size()), processor.stableId().data(), static_cast<int>(parameters[i].id.size()), parameters[i].id.data(), parameters[i].defaultValue);
        assert(accepted);
    }
}

std::vector<float> render(std::string_view effect, std::string_view parameter = {}, float value = 0.0f,
                          unsigned int chunk = 127U) {
    auto processor = createNativeEffectProcessor(effect);
    assert(processor && processor->prepare(kRate));
    setOfficialDefaults(*processor);
    // Q and frequency controls only alter audible output when their band gain
    // is nonzero. This probe intentionally exercises that valid condition.
    if (effect == "eq") {
        assert(processor->setParameter("official_lo_mid", 12.0f, 1U));
        assert(processor->setParameter("official_hi_mid", -12.0f, 1U));
    }
    if (effect == "reverse_reverb") {
        assert(processor->setParameter("official_pre_delay", 0.0f, 1U));
        assert(processor->setParameter("official_gate_time", 0.1f, 1U));
    }
    if (effect == "twist" && parameter == "official_fall") assert(processor->setParameter("official_release", 1.0f, 1U));
    if (!parameter.empty()) {
        const bool accepted = processor->setParameter(parameter, value, 1U);
        if (!accepted) std::fprintf(stderr, "Rejected probe: %.*s/%.*s=%g\n", static_cast<int>(effect.size()), effect.data(), static_cast<int>(parameter.size()), parameter.data(), value);
        assert(accepted);
    }
    auto samples = signal();
    if (effect == "synth" || effect == "g2b") {
        for (unsigned int i = 0U; i < kFrames; ++i) {
            const float envelope = (i % 9600U) < 4800U ? 1.0f : 0.15f;
            samples[2U * i] = samples[2U * i + 1U] = 0.2f * envelope * static_cast<float>(std::sin(6.283185307179586 * 220.0 * i / kRate));
        }
    }
    if (effect == "stereo_enhance") {
        for (unsigned int i = 0U; i < kFrames; ++i) samples[2U * i + 1U] *= 0.35f;
    }
    if (effect == "slow_gear") {
        for (unsigned int i = 0U; i < kFrames; ++i) {
            const float probe = (i % 8000U) < 3000U ? 0.02f : 0.0f;
            samples[2U * i] = probe; samples[2U * i + 1U] = probe;
        }
    }
    const bool toggleOff = effect == "freeze" || effect == "twist";
    for (unsigned int offset = 0U; offset < kFrames;) {
        if (toggleOff && offset == kFrames / 2U) processor->setBypassed(true, 1U);
        auto frames = std::min(chunk, kFrames - offset);
        if (toggleOff && offset < kFrames / 2U) frames = std::min(frames, kFrames / 2U - offset);
        (void)processor->processInPlace(samples.data() + 2U * offset, frames, 2U);
        offset += frames;
    }
    for (float sample : samples) assert(std::isfinite(sample));
    assert(!processor->processingFaulted());
    return samples;
}

double difference(const std::vector<float>& a, const std::vector<float>& b) {
    double total = 0.0;
    for (std::size_t i = 4096U; i < a.size(); ++i) {
        const double delta = a[i] - b[i]; total += delta * delta;
    }
    return std::sqrt(total / static_cast<double>(a.size() - 4096U));
}

void testEveryAdvertisedControlHasAudioEffect() {
    std::size_t advertised = 0U;
    for (const auto effect : kEffects) {
        std::size_t count = 0U;
        const auto* parameters = nativeEffectOfficialParameters(effect, count);
        advertised += count;
        for (std::size_t i = 0U; i < count; ++i) {
            const auto& parameter = parameters[i];
            const auto low = render(effect, parameter.id, (parameter.id == "official_bitdepth" || (parameter.id == "official_time" && parameter.minimum < 0.0f)) ? 1.0f : parameter.minimum);
            const auto high = render(effect, parameter.id, parameter.maximum);
            const double rms = difference(low, high);
            if (rms <= 1.0e-5) {
                std::fprintf(stderr, "Inaudible control: %.*s/%.*s (%g)\n",
                    static_cast<int>(effect.size()), effect.data(),
                    static_cast<int>(parameter.id.size()), parameter.id.data(), rms);
            }
            assert(rms > 1.0e-5);
        }
        const auto contiguous = render(effect, {}, 0.0f, kFrames);
        const auto chopped = render(effect, {}, 0.0f, 13U);
        assert(difference(contiguous, chopped) < 1.0e-7);
    }
    assert(advertised == 157U);
}

void testIndependentLevelsAndLatency() {
    const auto input = signal();
    for (const auto effect : {"phaser", "flanger", "dist"}) {
        auto processor = createNativeEffectProcessor(effect);
        assert(processor && processor->prepare(kRate));
        setOfficialDefaults(*processor);
        assert(processor->setParameter("official_d_level", 100.0f, 1U));
        assert(processor->setParameter("official_e_level", 0.0f, 1U));
        auto output = input;
        (void)processor->processInPlace(output.data(), kFrames, 2U);
        const auto latency = processor->reportedLatencySamples();
        for (std::size_t i = 4096U; i < output.size(); ++i) {
            assert(std::fabs(output[i] - input[i - 2U * latency]) < 1.0e-6f);
        }
        assert(processor->setParameter("official_d_level", 0.0f, 1U));
        output = input;
        (void)processor->processInPlace(output.data(), kFrames, 2U);
        for (std::size_t i = 4096U; i < output.size(); ++i) assert(output[i] == 0.0f);
    }
}

void testModesTempoAndValidation() {
    const auto normal = render("phaser", "official_stage", 12.0f);
    const auto biPhase = render("phaser", "official_stage", -1.0f);
    assert(difference(normal, biPhase) > 1.0e-4);
    for (unsigned int first = 0U; first < 6U; ++first) {
        const auto a = render("dist", "official_type", static_cast<float>(first));
        for (unsigned int second = first + 1U; second < 6U; ++second) {
            const auto b = render("dist", "official_type", static_cast<float>(second));
            assert(difference(a, b) > 1.0e-5);
        }
    }
    for (const auto effect : {"filter.lpf", "filter.bpf", "filter.hpf", "phaser", "flanger"}) {
        assert(difference(render(effect, "official_bpm", 40.0f), render(effect, "official_bpm", 300.0f)) > 1.0e-5);
        auto processor = createNativeEffectProcessor(effect);
        assert(processor && processor->prepare(kRate));
        assert(!processor->setParameter("official_rate", -1000.0f));
        assert(!processor->setParameter("official_rate", -0.01f));
        assert(!processor->setParameter("official_step_rate", -999.0f));
        assert(!processor->setParameter("official_bpm", 0.0f));
        assert(!processor->setParameter("official_depth", std::numeric_limits<float>::quiet_NaN()));
        assert(processor->setParameter("official_rate", -0.125f));
        assert(processor->setParameter("official_step_rate", -1000.0f));
    }
}

void testStrictOfficialDomains() {
    std::size_t effects = 0U;
    const auto* catalog = nativeEffectCatalog(effects);
    for (std::size_t e = 0U; e < effects; ++e) {
        std::size_t count = 0U;
        const auto* parameters = nativeEffectOfficialParameters(catalog[e].id, count);
        if (count == 0U) continue;
        const bool variants = catalog[e].id == "tape_echo" || catalog[e].id == "roll";
        for (unsigned int variant = variants ? 1U : 0U; variant <= (variants ? 2U : 0U); ++variant) {
            auto processor = createNativeEffectProcessor(catalog[e].id);
            assert(processor && processor->prepare(kRate));
            processor->attachSourceTransport();
            processor->attachVocoderCarriers();
            assert(processor->setParameter("official_bpm", 120.0f));
            assert(processor->officialVariant() == 0U);
            if (variants) {
                assert(!processor->setParameter("official_variant", 0.0f));
                assert(!processor->setParameter(parameters[1U].id, parameters[1U].defaultValue));
                assert(processor->setParameter("official_variant", static_cast<float>(variant), 1U));
            }
            const auto domainId = nativeEffectOfficialDomainId(catalog[e].id, variant);
            for (std::size_t i = 0U; i < count; ++i) {
                const auto& p = parameters[i];
                if (p.id == "official_variant") continue;
                const auto* domain = official::parameterDomain(domainId, p.id);
                if (!domain) { assert(!processor->setParameter(p.id, p.defaultValue)); continue; }
                assert(processor->setParameter(p.id, domain->hasDefault ? domain->defaultValue : p.defaultValue, 1U));
                assert(!processor->setParameter(p.id, p.minimum - 1.0f, 1U));
                assert(!processor->setParameter(p.id, p.maximum + 1.0f, 1U));
                assert(!processor->setParameter(p.id, p.defaultValue + 0.12345f, 1U));
                assert(!processor->setParameter(p.id, std::numeric_limits<float>::quiet_NaN(), 1U));
                assert(!processor->setParameter(p.id, std::numeric_limits<float>::infinity(), 1U));
                if (domain->step > 0.0f) {
                    assert(processor->setParameter(p.id, domain->minimum, 1U));
                    assert(processor->setParameter(p.id, domain->maximum, 1U));
                }
                for (std::size_t choice = 0U; choice < domain->count; ++choice) {
                    const auto value = official::kDomainOptions[domain->offset + choice];
                    const bool supported = value >= p.minimum && value <= p.maximum;
                    assert(processor->setParameter(p.id, value, 1U) == supported);
                }
            }
        }
    }
    auto filter = createNativeEffectProcessor("filter.lpf");
    assert(filter && filter->prepare(kRate));
    for (const float invalid : {-3.14159f, -0.5f, -0.25f, 50.25f}) {
        assert(!filter->setParameter("official_rate", invalid));
        assert(!filter->setParameter("official_step_rate", invalid));
    }
    auto chorus = createNativeEffectProcessor("chorus");
    assert(chorus && chorus->prepare(kRate));
    assert(!chorus->setParameter("official_rate", -4.0f));
    assert(chorus->setParameter("official_rate", -2.0f));
    assert(chorus->setParameter("official_high_cut", 12500.0f));
    assert(chorus->setParameter("official_low_cut", 1234.5f));
    assert(!chorus->setParameter("official_low_cut", 1234.55f));
    assert(!chorus->setParameter("official_high_cut", 19.9f));
    assert(!chorus->setParameter("official_low_cut", -999.0f));
}

void testDefaultOptInAndTempoDoesNotActivate() {
    for (const auto effect : kEffects) {
        auto a = createNativeEffectProcessor(effect), b = createNativeEffectProcessor(effect);
        assert(a && b && a->prepare(kRate) && b->prepare(kRate));
        assert(a->setParameter("official_bpm", 140.0f));
        assert(a->setParameter("official_quarter_notes_per_measure", 3.0f));
        auto first = signal(), second = first;
        (void)a->processInPlace(first.data(), kFrames, 2U);
        (void)b->processInPlace(second.data(), kFrames, 2U);
        assert(difference(first, second) < 1.0e-7);
        a = createNativeEffectProcessor(effect); b = createNativeEffectProcessor(effect);
        assert(a->prepare(kRate) && b->prepare(kRate));
        std::size_t count = 0U;
        const auto* p = nativeEffectOfficialParameters(effect, count);
        assert(a->setParameter(p[count - 1U].id, p[count - 1U].defaultValue, 1U));
        setOfficialDefaults(*b);
        first = signal(); second = first;
        (void)a->processInPlace(first.data(), kFrames, 2U);
        (void)b->processInPlace(second.data(), kFrames, 2U);
        if (difference(first, second) >= 1.0e-7)
            std::fprintf(stderr, "Official opt-in mismatch: %.*s\n", static_cast<int>(effect.size()), effect.data());
        assert(difference(first, second) < 1.0e-7);
    }
}

void testMeasureAwareAuxiliaryTempo() {
    assert(official::rateHz(-4.0f, 120.0f, 3.0f) == 120.0f / 180.0f);
    assert(official::rateHz(-16.0f, 120.0f, 3.5f) == 120.0f / 840.0f);
    assert(official::rateHz(-2.0f, 120.0f, 3.0f) == official::rateHz(-2.0f, 120.0f, 7.0f));
    assert(official::rateHz(50.0f, 120.0f, 3.0f) == official::rateHz(50.0f, 120.0f, 7.0f));
    auto processor = createNativeEffectProcessor("filter.lpf");
    assert(processor && processor->prepare(kRate));
    for (float value : {0.0f, 0.124f, 128.001f, std::numeric_limits<float>::infinity()})
        assert(!processor->setParameter("official_quarter_notes_per_measure", value));
    for (float value : {0.125f, 3.0f, 3.5f, 128.0f})
        assert(processor->setParameter("official_quarter_notes_per_measure", value));
    NativeAutoRiffCore riff;
    assert(riff.prepare(kRate));
    assert(riff.setParameter("official_tempo", -4.0f));
    assert(riff.setQuarterNotesPerMeasure(3.0f));
    assert(riff.stepPeriodSamples() == 72000U);
    assert(riff.setParameter("official_tempo", -2.0f));
    assert(riff.setQuarterNotesPerMeasure(7.0f));
    assert(riff.stepPeriodSamples() == 48000U);
}

void testFiniteCountedDelayImpulses() {
    constexpr unsigned int rate = 8000U;
    for (const auto effect : {"fractional_delay", "panning_delay", "reverse_delay", "mod_delay"}) {
        for (const unsigned int repeats : {1U, 2U, 16U}) {
            const bool longest = repeats == 16U;
            const unsigned int period = longest ? 24000U : 80U;
            const unsigned int frames = (repeats + 2U) * period;
            auto processor = createNativeEffectProcessor(effect);
            assert(processor && processor->prepare(rate));
            assert(processor->setParameter("official_bpm", 40.0f));
            assert(!processor->setParameter("official_bpm", 39.999f));
            assert(processor->setParameter("official_quarter_notes_per_measure", 7.0f));
            assert(processor->setParameter("official_time", longest ? -2.0f : 10.0f, 1U));
            assert(!processor->setParameter("official_time", -4.0f, 1U));
            assert(processor->setParameter("official_feedback", static_cast<float>(repeats), 1U));
            assert(processor->setParameter("official_d_level", 0.0f, 1U));
            assert(processor->setParameter("official_e_level", 100.0f, 1U));
            if (std::string_view(effect) == "mod_delay")
                assert(processor->setParameter("official_mod_depth", 0.0f, 1U));
            std::vector<float> samples(static_cast<std::size_t>(frames) * 2U, 0.0f);
            samples[26U] = samples[27U] = 1.0f;
            (void)processor->processInPlace(samples.data(), frames, 2U);
            unsigned int echoes = 0U;
            for (unsigned int frame = 0U; frame < frames; ++frame) {
                if (std::fabs(samples[2U * frame]) + std::fabs(samples[2U * frame + 1U]) < 1.0e-7f) continue;
                ++echoes;
                const unsigned int expected = std::string_view(effect) == "reverse_delay"
                    ? (echoes + 1U) * period - 14U : echoes * period + 13U;
                assert(frame == expected);
                if (std::string_view(effect) == "panning_delay") {
                    assert(samples[2U * frame + (echoes % 2U == 1U ? 1U : 0U)] == 0.0f);
                }
            }
            assert(echoes == repeats); // Includes the last 48-second echo, and no seventeenth echo.
            processor->resetState();
            std::fill(samples.begin(), samples.end(), 0.0f);
            (void)processor->processInPlace(samples.data(), frames, 2U);
            for (const float sample : samples) assert(sample == 0.0f);
        }
    }
}

void testReverseReverbSwelling() {
    constexpr unsigned int rate = 8000U, frames = 12000U;
    const auto renderTail = [&](float gate) {
        auto p = createNativeEffectProcessor("reverse_reverb");
        assert(p && p->prepare(rate));
        assert(p->setParameter("official_time", 0.4f, 1U));
        assert(p->setParameter("official_pre_delay", 100.0f, 1U));
        assert(p->setParameter("official_gate_time", gate, 1U));
        assert(p->setParameter("official_d_level", 0.0f, 1U));
        assert(p->setParameter("official_e_level", 100.0f, 1U));
        std::vector<float> result(frames * 2U, 0.0f);
        result[0] = result[1] = 1.0f;
        (void)p->processInPlace(result.data(), frames, 2U);
        return result;
    };
    const auto a = renderTail(0.2f), b = renderTail(0.4f);
    for (unsigned int i = 0U; i < 2400U * 2U; ++i) assert(a[i] == 0.0f);
    double early = 0.0, late = 0.0;
    for (unsigned int i = 2800U * 2U; i < 3600U * 2U; ++i) early += a[i] * a[i];
    for (unsigned int i = 4800U * 2U; i < 5600U * 2U; ++i) late += a[i] * a[i];
    assert(late > early * 5.0 && late > 1.0e-7);
    double shiftedDifference = 0.0, shiftedEnergy = 0.0;
    for (unsigned int i = 4000U * 2U; i < frames * 2U; ++i) {
        const double delta = b[i] - a[i - 1600U * 2U];
        shiftedDifference += delta * delta; shiftedEnergy += b[i] * b[i];
    }
    // Float32 tap positions may move by one fractional-delay ULP; test the
    // physical 200 ms onset shift rather than demanding bitwise Float32 sums.
    assert(shiftedDifference < shiftedEnergy * 1.0e-4);
}

void testDenseGranularLengthAndMonoVinyl() {
    const auto renderDense = [](float length) {
        auto processor = createNativeEffectProcessor("granular_delay"); assert(processor && processor->prepare(kRate));
        assert(processor->setParameter("official_time", 0.0f, 1U));
        assert(processor->setParameter("official_feedback", length, 1U));
        assert(processor->setParameter("official_e_level", 100.0f, 1U));
        std::vector<float> samples(kRate * 3U * 2U);
        for (unsigned int frame = 0U; frame < kRate * 3U; ++frame) {
            const double t = static_cast<double>(frame) / kRate;
            samples[frame * 2U] = samples[frame * 2U + 1U] = 0.2f * static_cast<float>(std::sin(6.283185307179586 * (170.0 * t + 2400.0 * t * t)));
        }
        (void)processor->processInPlace(samples.data(), kRate * 3U, 2U);
        return samples;
    };
    const auto shorter = renderDense(90.0f), longer = renderDense(100.0f);
    double denseDifference = 0.0;
    for (std::size_t i = kRate * 4U; i < shorter.size(); ++i) {
        const double delta = shorter[i] - longer[i]; denseDifference += delta * delta;
    }
    assert(denseDifference / static_cast<double>(kRate * 2U) > 1.0e-6);
    for (const auto id : {"vinyl_flick", "beat_shift"}) {
        auto bare = createNativeEffectProcessor(id); assert(bare && bare->prepare(kRate));
        assert(!bare->setParameter(id == std::string_view("vinyl_flick") ? "official_flick" : "official_shift", 0.0f));
        assert(!bare->setParameter(id == std::string_view("vinyl_flick") ? "official_flick" : "official_shift", id == std::string_view("vinyl_flick") ? 50.0f : -1.0f));
    }
}

void testCatalogSmoothingAndFreezeOwnership() {
    for (const auto effect : {"tape_echo", "roll", "pattern_slicer", "step_slicer"}) {
        auto p = createNativeEffectProcessor(effect); assert(p && p->prepare(kRate));
        const bool tape = std::string_view(effect) == "tape_echo", roll = std::string_view(effect) == "roll";
        if (tape || roll) assert(p->setParameter("official_variant", 1.0f, 1U));
        if (tape) {
            assert(p->setParameter("official_d_level", 100.0f, 1U));
            assert(p->setParameter("official_e_level", 0.0f, 1U));
        } else if (roll) {
            assert(p->setParameter("official_time", 10.0f, 1U));
            assert(p->setParameter("official_balance", 0.0f, 1U));
        } else {
            assert(p->setParameter("official_depth", 0.0f, 1U));
            assert(p->setParameter("official_comp_threshold", 0.0f, 1U));
            assert(p->setParameter("official_comp_gain", 0.0f, 1U));
        }
        std::vector<float> warm(10000U, tape || roll ? 0.25f : 0.1f);
        (void)p->processInPlace(warm.data(), 5000U, 2U);
        if (roll) assert(p->setParameter("official_roll", 1.0f, 1U));
        assert(p->setParameter(tape ? "official_d_level" : roll ? "official_balance" : "official_comp_gain",
            tape ? 0.0f : roll ? 100.0f : 20.0f, 100U));
        std::vector<float> ramp(200U, roll ? 0.0f : tape ? 0.25f : 0.1f);
        (void)p->processInPlace(ramp.data(), 100U, 2U);
        if (tape) { assert(ramp[0] > 0.2f && ramp[0] < 0.25f); assert(std::fabs(ramp[198]) < 1.0e-5f); }
        else if (roll) { assert(ramp[0] > 0.0f && ramp[0] < 0.01f); assert(ramp[198] > 0.2f); }
        else { assert(ramp[0] > 0.1f && ramp[0] < 0.2f); assert(ramp[198] > 0.9f); }
    }
    auto held = createNativeEffectProcessor("freeze"), reference = createNativeEffectProcessor("freeze");
    assert(held && reference && held->prepare(kRate) && reference->prepare(kRate));
    for (auto* p : {held.get(), reference.get()}) {
        // This is the full frontend macro plus explicitly authored controls.
        assert(p->setParameter("freeze", 0.0f)); assert(p->setParameter("mix_percent", 0.0f));
        assert(p->setParameter("official_attack", 0.0f)); assert(p->setParameter("official_decay", 0.0f));
        assert(p->setParameter("official_sustain", 100.0f)); assert(p->setParameter("official_balance", 100.0f));
        auto warm = signal(); (void)p->processInPlace(warm.data(), kFrames, 2U);
    }
    for (unsigned int edit = 0U; edit < 3U; ++edit) {
        assert(held->setParameter("freeze", 0.0f));
        assert(held->setParameter("mix_percent", static_cast<float>(edit * 50U)));
        assert(held->setParameter("official_balance", 100.0f));
        std::vector<float> a(kFrames * 2U, 0.0f), b = a;
        (void)held->processInPlace(a.data(), kFrames, 2U);
        (void)reference->processInPlace(b.data(), kFrames, 2U);
        assert(difference(a, b) < 1.0e-7);
        std::vector<float> silence(a.size(), 0.0f); assert(difference(a, silence) > 0.01);
    }
    assert(held->setParameter("official_balance", 0.0f, 100U));
    std::vector<float> balanceRamp(200U, 0.0f);
    (void)held->processInPlace(balanceRamp.data(), 100U, 2U);
    assert(std::any_of(balanceRamp.begin(), balanceRamp.begin() + 180U, [](float sample) { return std::fabs(sample) > 1.0e-4f; }));
    assert(std::fabs(balanceRamp[198]) < 1.0e-7f);
    assert(held->setParameter("mix_percent", 100.0f));
    auto direct = signal(), original = direct; (void)held->processInPlace(direct.data(), kFrames, 2U);
    assert(difference(direct, original) < 1.0e-7);
}

void testScatterLengthOwnsLegacyMacroReplay() {
    for (const float length : {-0.125f, -1.0f, -4.0f, -1000.0f}) {
        const auto interval = length == -1000.0f ? 3000U : static_cast<unsigned int>(-length * kRate * 0.5f);
        const auto inputAt = [](unsigned int f) { return 0.2f + 0.05f * std::sin(static_cast<float>(f) * 0.017f); };
        const auto renderScatter = [=](unsigned int replayMode) {
            auto processor = createNativeEffectProcessor("beat_scatter");
            assert(processor && processor->prepare(kRate));
            assert(processor->setParameter("official_length", length, 1U));
            if (replayMode == 1U) {
                assert(processor->setParameter("slice_beats", 0.5f, 1U));
                assert(processor->setParameter("bpm", 60.0f, 1U));
                assert(processor->setParameter("mix_percent", 0.0f, 1U));
            }
            const auto frames = interval * 3U + 256U;
            std::vector<float> output(frames * 2U);
            for (unsigned int f = 0U; f < frames; ++f) { output[f * 2U] = inputAt(f); output[f * 2U + 1U] = -0.5f * inputAt(f); }
            const auto editAt = interval + 128U;
            (void)processor->processInPlace(output.data(), editAt, 2U);
            if (replayMode != 0U) {
                assert(processor->setParameter("slice_beats", 2.0f, 1U));
                assert(processor->setParameter("bpm", 240.0f, 1U));
                assert(processor->setParameter("mix_percent", 100.0f, 1U));
            }
            (void)processor->processInPlace(output.data() + editAt * 2U, frames - editAt, 2U);
            return output;
        };
        const auto expected = renderScatter(0U);
        for (const auto replayMode : {1U, 2U}) {
            const auto replayed = renderScatter(replayMode);
            assert(difference(expected, replayed) < 1.0e-7);
            unsigned int firstChanged = 0U;
            while (firstChanged < replayed.size() / 2U && std::fabs(replayed[firstChanged * 2U] - inputAt(firstChanged)) < 1.0e-6f) ++firstChanged;
            assert(firstChanged == (length == -1000.0f ? replayed.size() / 2U : interval));
        }
    }
}

void testVocoderCarrierDomainOwnershipAndLegacyPcm() {
    auto tested = createNativeEffectProcessor("vocoder"), untouched = createNativeEffectProcessor("vocoder");
    assert(tested && untouched && tested->prepare(kRate) && untouched->prepare(kRate));
    std::size_t count = 0U;
    const auto* descriptors = nativeEffectOfficialParameters("vocoder", count);
    for (std::size_t i = 0U; i < count; ++i) {
        assert(!tested->setParameter(descriptors[i].id, descriptors[i].defaultValue));
        assert(tested->vocoderCarrierTrack() == 0U);
    }
    tested->attachVocoderCarriers(); untouched->attachVocoderCarriers();
    for (float value = 0.0f; value <= 5.0f; value += 1.0f) {
        assert(!tested->setParameter("official_carrier", value));
        assert(tested->vocoderCarrierTrack() == 0U);
    }
    assert(!tested->setParameter("official_carrier_thru", 1.0f));
    assert(tested->setParameter("official_bpm", 120.0f));
    assert(tested->vocoderCarrierTrack() == 0U);
    auto legacyA = signal(), legacyB = legacyA;
    for (unsigned int offset = 0U; offset < kFrames; offset += 128U) {
        const auto frames = std::min(128U, kFrames - offset);
        (void)tested->processInPlace(legacyA.data() + offset * 2U, frames, 2U);
        (void)untouched->processInPlace(legacyB.data() + offset * 2U, frames, 2U);
    }
    assert(legacyA == legacyB); // Invalid routes and tempo never opt into official defaults.
    for (float value = 6.0f; value <= 10.0f; value += 1.0f) {
        assert(tested->setParameter("official_carrier", value));
        assert(tested->vocoderCarrierTrack() == static_cast<unsigned int>(value) - 5U);
    }
    const auto render = [&](bool replayLegacy, unsigned int chunk) {
        auto processor = createNativeEffectProcessor("vocoder"); assert(processor && processor->prepare(kRate));
        processor->attachVocoderCarriers();
        assert(processor->setParameter("official_balance", 100.0f));
        assert(processor->vocoderCarrierTrack() == 1U);
        if (replayLegacy) {
            assert(processor->setParameter("carrier", 2.0f));
            assert(processor->setParameter("mix_percent", 0.0f));
        }
        auto input = signal(); input.resize(512U);
        auto carrier = input;
        for (std::size_t i = 0U; i < carrier.size(); ++i) carrier[i] *= std::sin(static_cast<float>(i) * 0.29f);
        processor->bindVocoderCarrierBlock(carrier.data(), 256U);
        const auto before = test_alloc::count(); test_alloc::beginTracking();
        for (unsigned int offset = 0U; offset < 256U;) {
            const auto frames = std::min(chunk, 256U - offset);
            (void)processor->processInPlace(input.data() + offset * 2U, frames, 2U); offset += frames;
        }
        test_alloc::endTracking(); assert(test_alloc::count() == before);
        const auto result = input;
        for (const auto invalidFrames : {0U, 4097U}) {
            processor->bindVocoderCarrierBlock(carrier.data(), invalidFrames);
            std::fill(input.begin(), input.end(), 0.2f);
            (void)processor->processInPlace(input.data(), 256U, 2U);
            assert(std::all_of(input.begin(), input.end(), [](float x) { return x == 0.0f; }));
        }
        processor->bindVocoderCarrierBlock(nullptr, 256U);
        std::fill(input.begin(), input.end(), 0.2f);
        (void)processor->processInPlace(input.data(), 256U, 2U);
        assert(std::all_of(input.begin(), input.end(), [](float x) { return x == 0.0f; }));
        return result;
    };
    const auto first = render(false, 256U), replayed = render(true, 13U);
    assert(first == replayed);
    assert(std::any_of(first.begin(), first.end(), [](float x) { return std::abs(x) > 0.000001f; }));
}

void testAllocationFreeControlsAndProcessing() {
    auto samples = signal();
    for (const auto effect : kEffects) {
        auto processor = createNativeEffectProcessor(effect);
        assert(processor && processor->prepare(kRate));
        setOfficialDefaults(*processor);
        std::size_t count = 0U;
        const auto* parameters = nativeEffectOfficialParameters(effect, count);
        const auto before = test_alloc::count();
        test_alloc::beginTracking();
        for (std::size_t i = 0U; i < count; ++i) {
            assert(processor->setParameter(parameters[i].id, parameters[i].maximum, 128U));
        }
        assert(processor->setParameter("official_bpm", 180.0f));
        assert(processor->setParameter("official_quarter_notes_per_measure", 3.5f));
        (void)processor->processInPlace(samples.data(), 4096U, 2U);
        test_alloc::endTracking();
        assert(test_alloc::count() == before);
    }
}
} // namespace

int main() {
    testEveryAdvertisedControlHasAudioEffect();
    testIndependentLevelsAndLatency();
    testModesTempoAndValidation();
    testStrictOfficialDomains();
    testDefaultOptInAndTempoDoesNotActivate();
    testMeasureAwareAuxiliaryTempo();
    testFiniteCountedDelayImpulses();
    testReverseReverbSwelling();
    testDenseGranularLengthAndMonoVinyl();
    testCatalogSmoothingAndFreezeOwnership();
    testScatterLengthOwnsLegacyMacroReplay();
    testVocoderCarrierDomainOwnershipAndLegacyPcm();
    testAllocationFreeControlsAndProcessing();
    std::puts("Native official FX: 157 audible controls, isolated D/E, variants, sync, chunk invariance and zero allocations passed.");
}
