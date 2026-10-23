#include "native_preamp_processor.hpp"
#include "native_dynamics_processor.hpp"
#include "native_official_domains.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <string_view>
#include <utility>
#include <vector>

using namespace webrc::native;

namespace {
constexpr unsigned int kRate = 48000U;
constexpr unsigned int kFrames = 12288U;
constexpr double kTwoPi = 6.283185307179586476925286766559;
using Control = std::pair<std::string_view, float>;

std::vector<float> fixture() {
    std::vector<float> samples(kFrames * 2U);
    std::uint32_t noise = 0x8493a57U;
    for (unsigned int frame = 0U; frame < kFrames; ++frame) {
        noise = noise * 1664525U + 1013904223U;
        const double random = (static_cast<double>(noise >> 8U) / 16777216.0) * 2.0 - 1.0;
        const double time = static_cast<double>(frame) / kRate;
        // Wideband music-like transient train with quiet sustains, not a
        // steady low-level tone that would hide detector/type differences.
        const unsigned int withinBurst = frame % 1536U;
        const double envelope = .06 + .94 * std::exp(-static_cast<double>(withinBurst) / 320.0);
        const double signal = .43 * std::sin(kTwoPi * 83 * time) + .23 * std::sin(kTwoPi * 701 * time) +
            .18 * std::sin(kTwoPi * 2873 * time) + .11 * std::sin(kTwoPi * 7321 * time) + .12 * random;
        samples[frame * 2U] = static_cast<float>(signal * envelope * 1.4);
        samples[frame * 2U + 1U] = static_cast<float>(signal * envelope * -.61 + .04 * std::sin(kTwoPi * 1319 * time));
    }
    return samples;
}

double rms(const std::vector<float>& samples) {
    double sum = 0.0;
    for (float value : samples) { assert(std::isfinite(value)); sum += static_cast<double>(value) * value; }
    return std::sqrt(sum / static_cast<double>(samples.size()));
}

double relativeDifference(const std::vector<float>& first, const std::vector<float>& second) {
    assert(first.size() == second.size());
    double sum = 0.0;
    for (std::size_t index = 0U; index < first.size(); ++index) {
        assert(std::isfinite(first[index]) && std::isfinite(second[index]));
        const double delta = static_cast<double>(first[index]) - second[index];
        sum += delta * delta;
    }
    return std::sqrt(sum / static_cast<double>(first.size())) / std::max(1.0e-9, rms(first));
}

template<class Processor>
std::vector<float> render(std::initializer_list<Control> controls, unsigned int block = kFrames) {
    Processor processor;
    assert(processor.prepare(kRate));
    for (const auto& control : controls) assert(processor.setOfficialParameter(control.first, control.second));
    processor.reset();
    auto samples = fixture();
    for (unsigned int position = 0U; position < kFrames; position += block) {
        const auto frames = std::min(block, kFrames - position);
        (void)processor.processInPlace(samples.data() + position * 2U, frames, 2U);
    }
    return samples;
}

template<class Processor>
void checkValidationAndLegacy(std::string_view effect, std::string_view validKey, float validValue) {
    Processor processor, untouched;
    assert(processor.prepare(kRate));
    assert(untouched.prepare(kRate));
    assert(!processor.officialControlsActive());
    assert(!processor.setOfficialParameter("official_missing", 0.0f));
    assert(!processor.setOfficialParameter(validKey, std::numeric_limits<float>::quiet_NaN()));
    assert(!processor.setOfficialParameter(validKey, std::numeric_limits<float>::infinity()));
    assert(!processor.setOfficialParameter(validKey, validValue + .25f));
    assert(!processor.officialControlsActive());
    auto a = fixture(), b = a;
    (void)processor.processInPlace(a.data(), kFrames, 2U);
    (void)untouched.processInPlace(b.data(), kFrames, 2U);
    assert(a == b); // Invalid official writes cannot silently opt legacy in.
    for (const auto& domain : official::kDomains) {
        if (domain.effect != effect) continue;
        if (domain.step > 0.0f) {
            assert(processor.setOfficialParameter(domain.key, domain.minimum));
            assert(processor.setOfficialParameter(domain.key, domain.maximum));
            assert(!processor.setOfficialParameter(domain.key, domain.minimum - 1.0f));
            assert(!processor.setOfficialParameter(domain.key, domain.maximum + 1.0f));
            assert(!processor.setOfficialParameter(domain.key, domain.minimum + .5f));
        } else {
            for (std::size_t index = 0U; index < domain.count; ++index)
                assert(processor.setOfficialParameter(domain.key, official::kDomainOptions[domain.offset + index]));
            assert(!processor.setOfficialParameter(domain.key, -1.0f));
            assert(!processor.setOfficialParameter(domain.key, static_cast<float>(domain.count)));
            assert(!processor.setOfficialParameter(domain.key, .5f));
        }
    }
    assert(processor.officialControlsActive());
    // After opt-in, invalid writes are still atomic with respect to sound.
    Processor reference = processor;
    assert(!processor.setOfficialParameter(validKey, 999.0f));
    a = fixture(); b = a;
    processor.reset(); reference.reset();
    (void)processor.processInPlace(a.data(), kFrames, 2U);
    (void)reference.processInPlace(b.data(), kFrames, 2U);
    assert(a == b);
}

void testDocumentedDefaultsAndUnknownType() {
    NativePreampProcessor partial, explicitDefaults;
    assert(partial.prepare(kRate) && explicitDefaults.prepare(kRate));
    assert(partial.setOfficialParameter("official_gain", 50));
    for (const auto& domain : official::kDomains)
        if (domain.effect == "preamp" && domain.hasDefault)
            assert(explicitDefaults.setOfficialParameter(domain.key, domain.defaultValue));
    partial.reset(); explicitDefaults.reset();
    auto a = fixture(), b = a;
    (void)partial.processInPlace(a.data(), kFrames, 2U);
    (void)explicitDefaults.processInPlace(b.data(), kFrames, 2U);
    assert(a == b);
    assert(partial.config().model == 0.0f && partial.config().gainPercent == 35.0f);
    assert(partial.latencyFrames() == 88U);
    assert(partial.setOfficialParameter("official_e_level", 0));
    assert(partial.setOfficialParameter("official_gain", 120));
    partial.reset();
    a = fixture();
    (void)partial.processInPlace(a.data(), kFrames, 2U);
    assert(rms(a) == 0.0); // Later writes cannot reapply and overwrite defaults.

    NativeDynamicsProcessor dynamics;
    assert(dynamics.prepare(kRate));
    const auto* type = official::parameterDomain("dynamics", "official_type");
    assert(type != nullptr && !type->hasDefault);
    assert(dynamics.setOfficialParameter("official_dynamics", 0));
    assert(dynamics.officialControlsActive() && !dynamics.officialTypeSpecified());
    assert(dynamics.setOfficialParameter("official_type", 0));
    assert(dynamics.officialTypeSpecified());
    assert(dynamics.config().thresholdDb == -18.0f && dynamics.config().ratio == 4.0f);
}

void testEveryPreampControlAndNamedProfileIsAudible() {
    const std::array<Control, 8U> minimums{{
        {"official_gain", 0.0f}, {"official_t_comp", -10.0f}, {"official_bass", 0.0f},
        {"official_middle", 0.0f}, {"official_treble", 0.0f}, {"official_presence", 0.0f},
        {"official_mic_dis", 0.0f}, {"official_e_level", 0.0f}
    }};
    const std::array<float, 8U> maximums{{120, 10, 100, 100, 100, 100, 1, 100}};
    for (std::size_t index = 0U; index < minimums.size(); ++index) {
        const auto a = render<NativePreampProcessor>({minimums[index]});
        const auto b = render<NativePreampProcessor>({{minimums[index].first, maximums[index]}});
        const auto delta = relativeDifference(b, a);
        std::printf("PREAMP %.*s endpoint relative difference %.6f\n", static_cast<int>(minimums[index].first.size()), minimums[index].first.data(), delta);
        assert(delta > .01); // At least a percent, not floating-point dust.
    }
    const std::array<std::pair<std::string_view, unsigned int>, 4U> enums{{
        {"official_amp_type", 9U}, {"official_spk_type", 9U}, {"official_mic_type", 5U}, {"official_mic_pos", 11U}
    }};
    for (const auto& entry : enums) {
        std::vector<std::vector<float>> outputs;
        for (unsigned int index = 0U; index < entry.second; ++index)
            outputs.push_back(render<NativePreampProcessor>({{entry.first, static_cast<float>(index)}}));
        double minimumDifference = 1.0;
        for (unsigned int first = 0U; first < entry.second; ++first) {
            assert(rms(outputs[first]) > .001);
            for (unsigned int second = first + 1U; second < entry.second; ++second)
                minimumDifference = std::min(minimumDifference, relativeDifference(outputs[first], outputs[second]));
        }
        std::printf("PREAMP %.*s minimum pairwise relative difference %.6f\n", static_cast<int>(entry.first.size()), entry.first.data(), minimumDifference);
        assert(minimumDifference > .003);
    }
    // OFF is a true speaker+mic bypass; no microphone control can color it.
    const auto off = render<NativePreampProcessor>({{"official_spk_type", 0.0f}});
    const auto offMic = render<NativePreampProcessor>({{"official_spk_type", 0.0f}, {"official_mic_type", 3.0f}, {"official_mic_dis", 1.0f}, {"official_mic_pos", 10.0f}});
    assert(off == offMic);
    const auto muted = render<NativePreampProcessor>({{"official_e_level", 0.0f}});
    assert(rms(muted) == 0.0);
}

void testEveryDynamicsTypeAndMacroIsAudible() {
    std::vector<std::vector<float>> outputs;
    for (unsigned int type = 0U; type < 19U; ++type) {
        // TYPE matters even at the documented macro default of zero.
        outputs.push_back(render<NativeDynamicsProcessor>({{"official_type", static_cast<float>(type)}, {"official_dynamics", 0.0f}}));
        const auto softer = render<NativeDynamicsProcessor>({{"official_type", static_cast<float>(type)}, {"official_dynamics", -20.0f}});
        const auto stronger = render<NativeDynamicsProcessor>({{"official_type", static_cast<float>(type)}, {"official_dynamics", 20.0f}});
        assert(relativeDifference(softer, stronger) > .003);
    }
    double minimumDifference = 1.0;
    for (unsigned int first = 0U; first < 19U; ++first) {
        assert(rms(outputs[first]) > .001);
        for (unsigned int second = first + 1U; second < 19U; ++second)
            minimumDifference = std::min(minimumDifference, relativeDifference(outputs[first], outputs[second]));
    }
    std::printf("DYNAMICS TYPE minimum pairwise relative difference %.6f\n", minimumDifference);
    assert(minimumDifference > .003);
}

template<class Processor>
void testPartitionResetFiniteAndNoAllocation(std::initializer_list<Control> controls) {
    assert(render<Processor>(controls, 1U) == render<Processor>(controls, 127U));
    Processor beforePrepare, afterPrepare;
    for (const auto& control : controls) assert(beforePrepare.setOfficialParameter(control.first, control.second));
    assert(beforePrepare.prepare(kRate) && afterPrepare.prepare(kRate));
    for (const auto& control : controls) assert(afterPrepare.setOfficialParameter(control.first, control.second));
    beforePrepare.reset(); afterPrepare.reset();
    auto early = fixture(), late = early;
    (void)beforePrepare.processInPlace(early.data(), kFrames, 2U);
    (void)afterPrepare.processInPlace(late.data(), kFrames, 2U);
    assert(early == late);
    Processor processor;
    assert(processor.prepare(kRate));
    for (const auto& control : controls) assert(processor.setOfficialParameter(control.first, control.second));
    processor.reset();
    auto first = fixture(), second = first;
    (void)processor.processInPlace(first.data(), kFrames, 2U);
    processor.reset();
    (void)processor.processInPlace(second.data(), kFrames, 2U);
    assert(first == second);

    std::array<float, 1024U> samples{};
    for (std::size_t index = 0U; index < samples.size(); ++index) samples[index] = .25f * std::sin(static_cast<float>(index));
    samples[0] = std::numeric_limits<float>::quiet_NaN();
    samples[1] = std::numeric_limits<float>::infinity();
    Processor initiallyLegacy;
    assert(initiallyLegacy.prepare(kRate));
    const auto before = test_alloc::count();
    test_alloc::beginTracking();
    // Include the first opt-in/default initialization, not just later writes.
    for (const auto& control : controls) assert(initiallyLegacy.setOfficialParameter(control.first, control.second));
    for (const auto& control : controls) assert(processor.setOfficialParameter(control.first, control.second));
    (void)processor.processInPlace(samples.data(), 512U, 2U);
    processor.reset();
    test_alloc::endTracking();
    assert(test_alloc::count() == before);
    for (float sample : samples) assert(std::isfinite(sample));

    // Supported endpoint rates, mono/stereo and extra-channel behavior.
    for (unsigned int rate : {8000U, 44100U, 96000U, 192000U}) {
        assert(processor.prepare(rate));
        for (unsigned int channels : {1U, 2U, 3U}) {
            samples.fill(.05f);
            (void)processor.processInPlace(samples.data(), 128U, channels);
            for (float sample : samples) assert(std::isfinite(sample));
            if (channels == 3U) for (unsigned int frame = 0U; frame < 128U; ++frame) assert(samples[frame * 3U + 2U] == .05f);
        }
    }
}
} // namespace

int main() {
    checkValidationAndLegacy<NativePreampProcessor>("preamp", "official_gain", 50);
    checkValidationAndLegacy<NativeDynamicsProcessor>("dynamics", "official_dynamics", 0);
    testDocumentedDefaultsAndUnknownType();
    testEveryPreampControlAndNamedProfileIsAudible();
    testEveryDynamicsTypeAndMacroIsAudible();
    testPartitionResetFiniteAndNoAllocation<NativePreampProcessor>({{"official_amp_type", 8.0f}, {"official_spk_type", 8.0f}, {"official_mic_type", 4.0f}, {"official_gain", 120.0f}, {"official_t_comp", 10.0f}});
    testPartitionResetFiniteAndNoAllocation<NativeDynamicsProcessor>({{"official_type", 18.0f}, {"official_dynamics", -20.0f}});
    std::puts("Native official PREAMP/DYNAMICS tests passed");
}
