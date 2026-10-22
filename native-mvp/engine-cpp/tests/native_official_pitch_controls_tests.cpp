#include "native_fx_catalog.hpp"
#include "native_electric_processor.hpp"
#include "native_hrm_auto_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <limits>
#include <memory>
#include <string_view>
#include <vector>

using namespace webrc::native;
namespace {
constexpr unsigned int kRate = 16000U;
constexpr double kPi = 3.14159265358979323846;
std::vector<float> tone(unsigned int frames, double frequency = 220.0, unsigned int channels = 1U) {
    std::vector<float> samples(static_cast<std::size_t>(frames) * channels);
    for (unsigned int f = 0U; f < frames; ++f) {
        const auto value = static_cast<float>(0.25 * std::sin(2.0 * kPi * frequency * f / kRate));
        for (unsigned int ch = 0U; ch < channels; ++ch) samples[f * channels + ch] = value;
    }
    return samples;
}
void process(NativeEffectProcessor& effect, std::vector<float>& audio, unsigned int channels = 1U) {
    const unsigned int frames = static_cast<unsigned int>(audio.size() / channels);
    for (unsigned int f = 0U; f < frames; f += 64U) {
        (void)effect.processInPlace(audio.data() + static_cast<std::size_t>(f) * channels, std::min(64U, frames - f), channels);
        assert(!effect.processingFaulted());
    }
    for (float sample : audio) assert(std::isfinite(sample));
}
double power(const std::vector<float>& data, double frequency) {
    double real = 0.0, imaginary = 0.0;
    for (std::size_t f = data.size() / 2U; f < data.size(); ++f) {
        const double phase = 2.0 * kPi * frequency * static_cast<double>(f) / kRate;
        real += data[f] * std::cos(phase); imaginary += data[f] * std::sin(phase);
    }
    return real * real + imaginary * imaginary;
}
std::unique_ptr<NativeEffectProcessor> make(std::string_view id) {
    auto result = createNativeEffectProcessor(id);
    assert(result && result->prepare(kRate));
    return result;
}
void testDomainsAndAllocationFreeCallback() {
    constexpr std::array<std::string_view, 8U> effects{{"transpose", "pitch_bend", "robot", "hrm_manual", "hrm_auto_m", "octave", "auto_riff", "electric"}};
    constexpr std::array<std::size_t, 8U> counts{{1U, 2U, 2U, 6U, 7U, 2U, 6U, 5U}};
    for (std::size_t i = 0U; i < effects.size(); ++i) {
        auto effect = make(effects[i]);
        std::size_t count = 0U;
        const auto* parameters = nativeEffectOfficialParameters(effects[i], count);
        assert(parameters && count == counts[i]);
        for (std::size_t p = 0U; p < count; ++p) {
            const auto& parameter = parameters[p];
            assert(effect->setParameter(parameter.id, parameter.defaultValue));
            assert(!effect->setParameter(parameter.id, std::numeric_limits<float>::quiet_NaN()));
            assert(!effect->setParameter(parameter.id, parameter.maximum + 1.0f));
            if (parameter.discrete) {
                for (std::size_t value = 0U; value < parameter.discreteValueCount; ++value) assert(effect->setParameter(parameter.id, parameter.discreteValues[value]));
                assert(effect->setParameter(parameter.id, parameter.defaultValue));
            }
        }
        assert(!effect->setParameter("official_mode", 1.0f));
        auto block = tone(128U, 220.0, 2U);
        test_alloc::beginTracking();
        for (std::size_t p = 0U; p < count; ++p) assert(effect->setParameter(parameters[p].id, parameters[p].defaultValue));
        (void)effect->processInPlace(block.data(), 128U, 2U);
        test_alloc::endTracking();
        assert(test_alloc::count() == 0U && !effect->processingFaulted());
    }
}
void testAudiblePitchBendAndRobot() {
    auto bend = make("pitch_bend");
    assert(bend->setParameter("official_pitch", 4.0f));
    assert(bend->setParameter("official_bend", 100.0f));
    auto audio = tone(kRate);
    process(*bend, audio);
    assert(power(audio, 3520.0) > power(audio, 220.0) * 20.0);
    assert(bend->setParameter("mix_percent", 0.0f)); // Legacy mix remains accepted after official editing.
    audio = tone(kRate); process(*bend, audio);
    assert(power(audio, 220.0) > power(audio, 3520.0) * 20.0);

    auto robot = make("robot");
    assert(robot->setParameter("official_note", 0.0f));
    audio = tone(kRate); process(*robot, audio);
    assert(power(audio, 261.625565) > power(audio, 220.0) * 5.0);
    assert(robot->setParameter("official_note", 9.0f));
    audio = tone(kRate, 330.0); process(*robot, audio);
    assert(power(audio, 440.0) > power(audio, 330.0) * 5.0);
}
void testIndependentHarmonyLevelsAndOctaveSelection() {
    auto manual = make("hrm_manual");
    assert(manual->setParameter("official_d_level", 0.0f));
    assert(manual->setParameter("official_hrm_level", 100.0f));
    assert(manual->setParameter("official_voice", 6.0f));
    auto audio = tone(kRate); process(*manual, audio);
    assert(power(audio, 261.625565) > power(audio, 220.0) * 5.0);
    assert(manual->setParameter("official_hrm_level", 0.0f));
    audio = tone(kRate); process(*manual, audio);
    for (std::size_t f = kRate / 2U; f < audio.size(); ++f) assert(audio[f] == 0.0f);
    assert(manual->setParameter("mix_percent", 100.0f));

    auto octave = make("octave");
    assert(octave->setParameter("official_octave", 1.0f));
    assert(octave->setParameter("official_oct_level", 100.0f));
    audio = tone(kRate); process(*octave, audio);
    assert(power(audio, 55.0) > power(audio, 110.0) * 10.0);
    assert(octave->setParameter("official_octave", 2.0f));
    audio = tone(kRate); process(*octave, audio);
    assert(power(audio, 55.0) > 10.0 && power(audio, 110.0) > 10.0);
}
void testAutomaticHarmonyMidiRouting() {
    auto effect = make("hrm_auto_m");
    auto* automatic = dynamic_cast<NativeHrmAutoProcessor*>(effect.get());
    assert(automatic);
    assert(automatic->setParameter("official_d_level", 0.0f));
    assert(automatic->setParameter("official_hrm_level", 100.0f));
    auto audio = tone(kRate); process(*automatic, audio);
    for (std::size_t f = kRate / 2U; f < audio.size(); ++f) assert(audio[f] == 0.0f);
    assert(automatic->queueMidiEvent(true, 1, 60, 100, automatic->currentFrame()));
    audio = tone(kRate); process(*automatic, audio);
    assert(power(audio, 261.625565) > power(audio, 220.0) * 5.0);
    assert(automatic->setParameter("official_hrm_mode", 0.0f));
    assert(automatic->setParameter("official_key", 2.0f)); // HYBRID: D major excludes held C, falls back to scale.
    audio = tone(kRate); process(*automatic, audio);
    assert(power(audio, 246.941651) > power(audio, 261.625565) * 5.0);
    assert(automatic->queueMidiEvent(false, 1, 60, 0, automatic->currentFrame()));
    audio = tone(kRate); process(*automatic, audio);
    for (std::size_t f = kRate / 2U; f < audio.size(); ++f) assert(audio[f] == 0.0f);
}
void testElectricPitchScaleSpeedAndFormant() {
    auto effect = make("electric");
    auto* electric = dynamic_cast<NativeElectricProcessor*>(effect.get());
    assert(electric);
    assert(electric->setParameter("official_shift", 12.0f));
    auto audio = tone(kRate); process(*electric, audio);
    assert(std::fabs(electric->effectiveFrequencyHz() - 440.0f) < 1.0f);
    assert(electric->setParameter("official_shift", 0.0f));
    assert(electric->setParameter("official_scale", 1.0f)); // C major
    audio = tone(kRate, 270.0); process(*electric, audio);
    assert(std::fabs(electric->snappedFrequencyHz() - 261.625565f) < 1.0f);
    assert(electric->setParameter("official_scale", 2.0f)); // C# major
    audio = tone(kRate, 270.0); process(*electric, audio);
    assert(std::fabs(electric->snappedFrequencyHz() - 277.182631f) < 1.0f);
    assert(electric->setParameter("official_scale", 0.0f));
    assert(electric->setParameter("official_speed", 0.0f));
    audio = tone(kRate); process(*electric, audio);
    assert(electric->setParameter("official_shift", 12.0f));
    audio = tone(kRate / 25U); process(*electric, audio);
    const float slow = electric->effectiveFrequencyHz();
    assert(slow > 220.0f && slow < 320.0f);
    assert(electric->setParameter("official_speed", 10.0f));
    audio = tone(kRate / 25U); process(*electric, audio);
    assert(electric->effectiveFrequencyHz() > 430.0f);

    assert(electric->setParameter("official_shift", 0.0f));
    assert(electric->setParameter("official_formant", -50.0f));
    audio = tone(kRate); process(*electric, audio);
    const double lowRatio = power(audio, 880.0) / std::max(1.0e-8, power(audio, 220.0));
    assert(electric->setParameter("official_formant", 50.0f));
    audio = tone(kRate); process(*electric, audio);
    const double highRatio = power(audio, 880.0) / std::max(1.0e-8, power(audio, 220.0));
    assert(highRatio > lowRatio * 2.0);

    assert(electric->setParameter("official_stability", 10.0f));
    audio = tone(kRate); process(*electric, audio);
    audio = tone(kRate / 2U, 220.0 * std::pow(2.0, 0.7 / 12.0)); process(*electric, audio);
    assert(std::fabs(electric->snappedFrequencyHz() - 220.0f) < 1.0f);
    assert(electric->setParameter("official_stability", -10.0f));
    audio = tone(kRate / 2U, 220.0 * std::pow(2.0, 0.7 / 12.0)); process(*electric, audio);
    assert(std::fabs(electric->snappedFrequencyHz() - 233.08188f) < 1.0f);
}
} // namespace
int main() {
    testDomainsAndAllocationFreeCallback();
    testAudiblePitchBendAndRobot();
    testIndependentHarmonyLevelsAndOctaveSelection();
    testAutomaticHarmonyMidiRouting();
    testElectricPitchScaleSpeedAndFormant();
    return 0;
}
