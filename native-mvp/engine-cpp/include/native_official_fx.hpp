#pragma once

#include "native_official_domains.hpp"

#include <algorithm>
#include <cmath>

namespace webrc::native::official {

// RC-505mkII display/control compatibility, not a claim of Roland DSP parity.
// Positive 0..100 values use an explicitly clean-room logarithmic speed law.
// A negative value is a duration in quarter-note beats; -1000 is STEP OFF.
inline constexpr float kStepOff = -1000.0f;
inline bool validRate(float value, bool allowOff = false) noexcept {
    return std::isfinite(value) && ((allowOff && value == kStepOff) ||
        (value >= 0.0f && value <= 100.0f && value == std::floor(value)) ||
        value == -16.0f || value == -8.0f || value == -4.0f || value == -2.0f || value == -1.0f || value == -0.125f);
}
inline bool validCut(float value) noexcept {
    return validParameter("chorus", "official_low_cut", value);
}
inline float rateHz(float value, float bpm, float quarterNotesPerMeasure = 4.0f) noexcept {
    if (value == kStepOff) return 0.0f;
    if (value < 0.0f) {
        const float beats = -value * (value <= -4.0f ? quarterNotesPerMeasure * 0.25f : 1.0f);
        return bpm / (60.0f * beats);
    }
    return 0.05f * std::pow(400.0f, value * 0.01f);
}
inline float cutoffHz(float value) noexcept {
    return 20.0f * std::pow(1000.0f, value * 0.01f);
}

} // namespace webrc::native::official
