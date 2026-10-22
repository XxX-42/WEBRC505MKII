#pragma once

#include "dsp_primitives.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <string_view>

namespace webrc::native::official_amp {

// Independently authored functional profiles shared with BrowserPreampDsp.ts.
// Names/order match the manual, not factory circuit values or measured IRs.
inline constexpr std::array<std::string_view, 12U> keys{{
    "official_amp_type", "official_spk_type", "official_gain", "official_t_comp",
    "official_bass", "official_middle", "official_treble", "official_presence",
    "official_mic_type", "official_mic_dis", "official_mic_pos", "official_e_level"
}};
inline constexpr std::array<float, 12U> defaults{{3, 1, 50, 0, 50, 50, 50, 50, 0, 0, 0, 50}};
inline constexpr std::array<float, 9U> drive{{.68f, .76f, .56f, 1.02f, 1.19f, 1.42f, 1.27f, 1.61f, 1.76f}};
inline constexpr std::array<float, 9U> shape{{1.08f, 1.31f, .85f, 1.72f, 2.05f, 2.68f, 2.32f, 3.05f, 3.48f}};
inline constexpr std::array<float, 9U> bias{{0, .052f, .005f, .091f, -.034f, .021f, -.086f, .047f, -.012f}};
inline constexpr std::array<float, 9U> blend{{.61f, .74f, .48f, .85f, .92f, .98f, .94f, 1, 1}};
inline constexpr std::array<float, 9U> sag{{.12f, .26f, .06f, .48f, .39f, .30f, .62f, .44f, .22f}};
inline constexpr std::array<float, 9U> attackMs{{2, 8, 1.2f, 12, 8, 3, 18, 5, 1.8f}};
inline constexpr std::array<float, 9U> releaseMs{{45, 110, 30, 145, 120, 75, 190, 105, 55}};
inline constexpr std::array<float, 9U> cabinetHighPass{{0, 94, 155, 116, 83, 71, 89, 59, 47}};
inline constexpr std::array<float, 9U> cabinetLowPass{{0, 5650, 6650, 6200, 5450, 5150, 6050, 4650, 4250}};
inline constexpr std::array<float, 9U> cabinetBodyHz{{0, 192, 305, 238, 180, 146, 202, 126, 106}};
inline constexpr std::array<float, 9U> cabinetBodyDb{{0, 2.3f, 1.4f, 2, 2.7f, 3.2f, 3.8f, 4.3f, 4.9f}};
inline constexpr std::array<float, 9U> cabinetPresenceHz{{0, 1900, 2450, 2210, 1840, 1720, 2180, 1630, 1490}};
inline constexpr std::array<float, 9U> cabinetBreakupHz{{0, 4050, 4700, 4390, 3980, 3760, 4450, 3510, 3190}};
inline constexpr std::array<float, 5U> micLow{{0, 2.6f, -.6f, 1.5f, 0}};
inline constexpr std::array<float, 5U> micPeakHz{{4350, 3450, 6850, 2850, 1000}};
inline constexpr std::array<float, 5U> micPeakDb{{4.2f, 2.8f, 2.1f, 1.6f, 0}};
inline constexpr std::array<float, 5U> micHigh{{-3.4f, -1.8f, 2.7f, .8f, 0}};

// Fixed local storage, including the temporary analytic filters: safe on the
// single DSP owner for control updates without heap allocation or locks.
template<std::size_t Taps>
void designCabinet(unsigned int rate, const std::array<float, 12U>& controls,
    std::array<float, Taps>& impulse) noexcept {
    const auto amp = static_cast<unsigned int>(controls[0]);
    const auto speaker = static_cast<unsigned int>(controls[1]);
    impulse.fill(0.0f);
    if (speaker == 0U) { impulse[0] = 1.0f; return; }
    const double width = speaker != 1U ? 1.0 : amp == 2U ? 1.5 : 1.13 - amp * .045;
    const double body = speaker != 1U ? 1.0 : amp == 2U ? .35 : .8 + amp * .07;
    const auto hz = [rate](double value) noexcept { return std::min(value, rate * .44); };
    std::array<dsp::Biquad, 6U> sections{};
    (void)sections[0].setParameters(dsp::BiquadType::HighPass, rate, hz(cabinetHighPass[speaker] * width), .71);
    (void)sections[1].setParameters(dsp::BiquadType::LowPass, rate, hz(cabinetLowPass[speaker] * width), .72);
    (void)sections[2].setParameters(dsp::BiquadType::Peaking, rate, hz(cabinetBodyHz[speaker]), .95, cabinetBodyDb[speaker] * body);
    (void)sections[3].setParameters(dsp::BiquadType::Peaking, rate, hz(cabinetPresenceHz[speaker] * width), .92, 2.1);
    (void)sections[4].setParameters(dsp::BiquadType::Peaking, rate, hz(cabinetBreakupHz[speaker] * width), 1.75, -4.1 - speaker * .12);
    for (std::size_t tap = 0U; tap < Taps; ++tap) {
        float sample = tap == 0U ? 1.0f : 0.0f;
        for (std::size_t section = 0U; section < 5U; ++section) sample = sections[section].process(sample);
        impulse[tap] = sample;
    }
    constexpr double twoPi = 6.283185307179586476925286766559;
    double real = 0.0, imaginary = 0.0;
    for (std::size_t tap = 0U; tap < Taps; ++tap) {
        const double angle = twoPi * 500.0 * static_cast<double>(tap) / rate;
        real += impulse[tap] * std::cos(angle);
        imaginary -= impulse[tap] * std::sin(angle);
    }
    const double normalization = 1.0 / std::max(1.0e-6, std::hypot(real, imaginary));
    const auto mic = static_cast<unsigned int>(controls[8]);
    const bool near = controls[9] == 1.0f;
    const double position = controls[10] * .1;
    for (auto& section : sections) section.reset();
    (void)sections[0].setParameters(dsp::BiquadType::LowShelf, rate, hz(210), .7071067811865476, micLow[mic]);
    (void)sections[1].setParameters(dsp::BiquadType::Peaking, rate, hz(micPeakHz[mic]), 1.1, micPeakDb[mic]);
    (void)sections[2].setParameters(dsp::BiquadType::HighShelf, rate, hz(5850), .7071067811865476, micHigh[mic]);
    (void)sections[3].setParameters(dsp::BiquadType::LowShelf, rate, hz(185), .7071067811865476, near ? 2.8 : -3.5);
    (void)sections[4].setParameters(dsp::BiquadType::HighShelf, rate, hz(4200 - 1000 * position), .7071067811865476, (near ? 0.0 : -2.2) - 11 * position);
    (void)sections[5].setParameters(dsp::BiquadType::Peaking, rate, hz(2750), .8, -3 * position);
    for (float& sample : impulse) {
        sample = static_cast<float>(sample * normalization);
        for (auto& section : sections) sample = section.process(sample);
        sample *= near ? 1.0f : .74f;
    }
}

} // namespace webrc::native::official_amp
