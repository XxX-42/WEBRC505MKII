#include "native_vocoder_core.hpp"
#include "native_osc_voc_core.hpp"
#include "native_osc_bot_core.hpp"
#include "native_official_fx.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <string_view>
#include <utility>
#include <vector>

using namespace webrc::native;
namespace {
constexpr std::uint32_t kRate = 48000U;
constexpr std::size_t kFrames = 24000U;
constexpr double kPi = 3.14159265358979323846;
using Edit = std::pair<std::string_view, float>;
using Audio = std::vector<float>;
Audio modulator(std::size_t frames = kFrames) {
    Audio audio(frames);
    std::uint32_t random = 23U;
    for (std::size_t f = 0U; f < frames; ++f) {
        random = 1664525U * random + 1013904223U;
        const double noise = static_cast<double>(random >> 8U) / 16777216.0 - 0.5;
        audio[f] = static_cast<float>(0.2 * noise + 0.12 * std::sin(2.0 * kPi * 220.0 * f / kRate) +
            0.10 * std::sin(2.0 * kPi * 1150.0 * f / kRate) +
            0.08 * std::sin(2.0 * kPi * 3100.0 * f / kRate));
    }
    return audio;
}
double rms(const Audio& audio, std::size_t first = 0U, std::size_t last = 0U) {
    if (last == 0U) last = audio.size();
    double sum = 0.0;
    for (std::size_t i = first; i < last; ++i) {
        assert(std::isfinite(audio[i]));
        sum += static_cast<double>(audio[i]) * audio[i];
    }
    return std::sqrt(sum / static_cast<double>(last - first));
}
double difference(const Audio& a, const Audio& b) {
    assert(a.size() == b.size());
    double sum = 0.0;
    for (std::size_t i = 0U; i < a.size(); ++i) {
        const double delta = static_cast<double>(a[i]) - b[i];
        sum += delta * delta;
    }
    return std::sqrt(sum / static_cast<double>(a.size()));
}
double spectralPower(const Audio& audio, double frequency) {
    double real = 0.0, imaginary = 0.0;
    const std::size_t first = audio.size() / 2U;
    for (std::size_t i = first; i < audio.size(); ++i) {
        const double phase = 2.0 * kPi * frequency * static_cast<double>(i) / kRate;
        real += audio[i] * std::cos(phase);
        imaginary += audio[i] * std::sin(phase);
    }
    return real * real + imaginary * imaginary;
}
Audio renderVocoder(std::initializer_list<Edit> edits, bool beforePrepare = false) {
    NativeVocoderCore core;
    NativeVocoderConfig config;
    config.carrier = NativeVocoderCarrier::Saw;
    assert(core.setConfig(config));
    if (!beforePrepare) assert(core.prepare(kRate));
    assert(core.setParameter("official_balance", 100.0f));
    for (const auto& edit : edits) assert(core.setParameter(edit.first, edit.second));
    if (beforePrepare) assert(core.prepare(kRate));
    const auto input = modulator();
    Audio output(input.size());
    assert(core.process(input.data(), nullptr, output.data(), output.size()));
    return output;
}
Audio renderBot(std::initializer_list<Edit> edits, bool beforePrepare = false) {
    NativeOscBotCore core;
    if (!beforePrepare) assert(core.prepare(kRate));
    assert(core.setParameter("official_note", 60.0f));
    assert(core.setParameter("official_balance", 100.0f));
    for (const auto& edit : edits) assert(core.setParameter(edit.first, edit.second));
    if (beforePrepare) assert(core.prepare(kRate));
    const auto input = modulator();
    Audio output(input.size());
    assert(core.processMono(input.data(), output.data(), output.size()));
    return output;
}
Audio renderVoc(std::initializer_list<Edit> edits, bool noteOn = true,
    std::uint64_t noteOff = 0U, bool beforePrepare = false) {
    NativeOscVocCore core;
    if (!beforePrepare) assert(core.prepare(kRate));
    assert(core.setParameter("official_balance", 100.0f));
    for (const auto& edit : edits) assert(core.setParameter(edit.first, edit.second));
    if (beforePrepare) assert(core.prepare(kRate));
    if (noteOn) assert(core.queueNoteOn(0, 60, 127, 0U));
    if (noteOff != 0U) assert(core.queueNoteOff(0, 60, noteOff));
    const auto input = modulator();
    Audio output(input.size());
    assert(core.processMono(input.data(), output.data(), output.size()));
    if (noteOn && noteOff == 0U) assert(core.activeVoiceCount() == 1U);
    return output;
}
void assertAudible(const Audio& a, const Audio& b) {
    assert(rms(a) > 1.0e-6 && rms(b) > 1.0e-6);
    assert(difference(a, b) > std::min(rms(a), rms(b)) * 0.05);
}
void testAllVocoderControls() {
    assertAudible(renderVocoder({{"official_tone", -50.0f}}), renderVocoder({{"official_tone", 50.0f}}));
    const auto fast = renderVocoder({{"official_attack", 0.0f}});
    const auto slow = renderVocoder({{"official_attack", 100.0f}});
    assert(rms(fast, 0U, 4000U) > rms(slow, 0U, 4000U) * 5.0);
    assert(rms(renderVocoder({{"official_mod_sens", 50.0f}})) >
        rms(renderVocoder({{"official_mod_sens", -50.0f}})) * 20.0);
    assert(difference(renderVocoder({{"official_balance", 0.0f}}), modulator()) == 0.0);
    const auto wet = renderVocoder({});
    const auto half = renderVocoder({{"official_balance", 50.0f}});
    auto expected = modulator();
    for (std::size_t i = 0U; i < expected.size(); ++i) expected[i] = 0.5f * (expected[i] + wet[i]);
    assert(difference(half, expected) < 1.0e-8);
}
void testAllOscBotControls() {
    std::array<Audio, 5U> waves;
    for (unsigned int i = 0U; i < waves.size(); ++i) waves[i] = renderBot({{"official_osc", static_cast<float>(i)}});
    for (std::size_t a = 0U; a < waves.size(); ++a)
        for (std::size_t b = a + 1U; b < waves.size(); ++b) assertAudible(waves[a], waves[b]);
    assertAudible(renderBot({{"official_tone", -50.0f}}), renderBot({{"official_tone", 50.0f}}));
    assert(rms(renderBot({{"official_attack", 0.0f}}), 0U, 4000U) >
        rms(renderBot({{"official_attack", 100.0f}}), 0U, 4000U) * 5.0);
    assert(rms(renderBot({{"official_mod_sens", 50.0f}})) >
        rms(renderBot({{"official_mod_sens", -50.0f}})) * 20.0);
    const auto note = renderBot({{"official_note", 69.0f}});
    assert(spectralPower(note, 440.0) > spectralPower(note, 261.625565) * 100.0);
    assertAudible(note, waves[0U]);
    assert(difference(renderBot({{"official_balance", 0.0f}}), modulator()) == 0.0);
    const auto half = renderBot({{"official_balance", 50.0f}});
    auto expected = modulator();
    for (std::size_t i = 0U; i < expected.size(); ++i) expected[i] = 0.5f * (expected[i] + waves[0U][i]);
    assert(difference(half, expected) < 1.0e-8);
    // Legacy tempo/pattern cannot secretly override the official fixed-note mode.
    assert(difference(renderBot({{"pattern", 7.0f}, {"tempo", 300.0f}}), waves[0U]) == 0.0);
}
void testAllOscVocControlsAndGates() {
    assert(rms(renderVoc({}, false)) == 0.0); // No MIDI note means no carrier.
    std::array<Audio, 5U> waves;
    for (unsigned int i = 0U; i < waves.size(); ++i) waves[i] = renderVoc({{"official_carrier", static_cast<float>(i)}});
    for (std::size_t a = 0U; a < waves.size(); ++a)
        for (std::size_t b = a + 1U; b < waves.size(); ++b) assertAudible(waves[a], waves[b]);
    assertAudible(renderVoc({{"official_tone", -50.0f}}), renderVoc({{"official_tone", 50.0f}}));
    assert(rms(renderVoc({{"official_attack", 0.0f}}), 0U, 4000U) >
        rms(renderVoc({{"official_attack", 100.0f}}), 0U, 4000U) * 10.0);
    assert(rms(renderVoc({{"official_mod_sens", 50.0f}})) >
        rms(renderVoc({{"official_mod_sens", -50.0f}})) * 20.0);
    for (unsigned int octave = 0U; octave < 4U; ++octave) {
        const auto shifted = renderVoc({{"official_octave", static_cast<float>(octave)}});
        const double frequency = 261.625565 * std::exp2(static_cast<double>(octave) - 2.0);
        assert(spectralPower(shifted, frequency) > spectralPower(shifted, frequency + 30.0) * 20.0);
        if (octave != 2U) assertAudible(shifted, waves[0U]);
    }
    const auto fastRelease = renderVoc({{"official_release", 0.0f}}, true, 6000U);
    const auto slowRelease = renderVoc({{"official_release", 100.0f}}, true, 6000U);
    assert(rms(slowRelease, 18000U) > rms(fastRelease, 18000U) * 100.0);
    assert(difference(renderVoc({{"official_balance", 0.0f}}, false), modulator()) == 0.0);
    const auto half = renderVoc({{"official_balance", 50.0f}});
    auto expected = modulator();
    for (std::size_t i = 0U; i < expected.size(); ++i) expected[i] = 0.5f * (expected[i] + waves[0U][i]);
    assert(difference(half, expected) < 1.0e-8);
    NativeOscVocCore core;
    assert(core.prepare(kRate));
    assert(core.setParameter("official_balance", 100));
    assert(core.queueNoteOn(0, 60, 127, 100U));
    std::array<float, 100U> input{}, output{};
    input.fill(0.25f);
    assert(core.processMono(input.data(), output.data(), output.size()));
    for (const auto sample : output) assert(sample == 0.0f);
    assert(core.activeVoiceCount() == 0U);
    (void)core.processSample(0.25f);
    assert(core.activeVoiceCount() == 1U);
    assert(core.queueNoteOn(0, 60, 0, 101U)); // Velocity zero is a real note-off.
    for (unsigned int i = 0U; i < kRate * 2U; ++i) (void)core.processSample(0.25f);
    assert(core.activeVoiceCount() == 0U);
}
void testDomainsDefaultsAndPrepareOrder() {
    NativeVocoderCore vocoder;
    NativeOscVocCore voc;
    NativeOscBotCore bot;
    assert(vocoder.prepare(kRate) && voc.prepare(kRate) && bot.prepare(kRate));
    assert(!vocoder.setParameter("official_carrier", 0));
    assert(!vocoder.setParameter("official_carrier_thru", 1));
    assert(!vocoder.officialControlsActive());
    assert(!vocoder.setParameter("official_tone", 0.5f));
    assert(!voc.setParameter("official_carrier", 5));
    assert(!voc.setParameter("official_octave", -1));
    assert(!voc.setParameter("official_octave", 1.5f));
    assert(!bot.setParameter("official_note", 23));
    assert(!bot.setParameter("official_note", 128));
    assert(!bot.setParameter("official_note", 60.5f));
    assert(!bot.setParameter("official_tone", std::numeric_limits<float>::quiet_NaN()));
    for (int note = 24; note <= 127; ++note) assert(bot.setParameter("official_note", static_cast<float>(note)));
    assert(vocoder.setParameter("official_tone", 0) && vocoder.config().wetMix == 0.5f);
    assert(voc.setParameter("official_tone", 0) && voc.config().wetMix == 0.5f && voc.config().octaveShift == 0);
    NativeOscBotCore defaultBot;
    assert(defaultBot.prepare(kRate));
    assert(defaultBot.setParameter("official_tone", 0) && defaultBot.config().wetMix == 0.5f);
    auto input = modulator(), expected = modulator();
    assert(defaultBot.processMono(input.data(), input.data(), input.size()));
    const auto defaultWet = renderBot({{"official_note", 36.0f}});
    for (std::size_t i = 0U; i < expected.size(); ++i) expected[i] = 0.5f * (expected[i] + defaultWet[i]);
    assert(difference(input, expected) < 1.0e-8);
    assert(difference(renderVocoder({{"official_tone", 12.0f}}, true), renderVocoder({{"official_tone", 12.0f}})) == 0.0);
    assert(difference(renderVoc({{"official_carrier", 2.0f}}, true, 0U, true), renderVoc({{"official_carrier", 2.0f}})) == 0.0);
    assert(difference(renderBot({{"official_osc", 4.0f}}, true), renderBot({{"official_osc", 4.0f}})) == 0.0);
}
void testAllocationFreeChangesResetAndRender() {
    NativeVocoderCore vocoder;
    NativeOscVocCore voc;
    NativeOscBotCore bot;
    assert(vocoder.prepare(kRate) && voc.prepare(kRate) && bot.prepare(kRate));
    std::array<float, 512U> audio{};
    audio.fill(0.1f);
    test_alloc::beginTracking();
    // Includes first opt-in/default initialization, not just subsequent changes.
    for (const auto& domain : official::kDomains) {
        if (domain.effect != "vocoder" && domain.effect != "osc_voc_m" && domain.effect != "osc_bot") continue;
        if (domain.key == "official_carrier_thru" ||
            (domain.effect == "vocoder" && domain.key == "official_carrier")) continue;
        assert(domain.hasDefault);
        if (domain.effect == "vocoder") assert(vocoder.setParameter(domain.key, domain.defaultValue));
        else if (domain.effect == "osc_voc_m") assert(voc.setParameter(domain.key, domain.defaultValue));
        else assert(bot.setParameter(domain.key, domain.defaultValue));
    }
    assert(voc.queueNoteOn(0, 60, 127, 0U));
    assert(vocoder.process(audio.data(), nullptr, audio.data(), audio.size()));
    assert(voc.processStereo(audio.data(), audio.data(), audio.size() / 2U));
    assert(bot.processStereo(audio.data(), audio.data(), audio.size() / 2U));
    vocoder.reset(); voc.reset(); bot.reset();
    assert(voc.queueNoteOn(0, 60, 127, voc.currentFrame()));
    for (unsigned int wave = 0U; wave < 5U; ++wave) {
        assert(voc.setParameter("official_carrier", static_cast<float>(wave)));
        assert(bot.setParameter("official_osc", static_cast<float>(wave)));
        assert(bot.setParameter("official_note", static_cast<float>(24U + wave * 20U)));
        assert(voc.processMono(audio.data(), audio.data(), audio.size()));
        assert(bot.processMono(audio.data(), audio.data(), audio.size()));
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == 0U);
    for (const float sample : audio) assert(std::isfinite(sample));
}
} // namespace
int main() {
    testAllVocoderControls();
    testAllOscBotControls();
    testAllOscVocControlsAndGates();
    testDomainsDefaultsAndPrepareOrder();
    testAllocationFreeChangesResetAndRender();
}
