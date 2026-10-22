#pragma once

#include "dsp_primitives.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

namespace webrc::native {

// Authored rising-tail kernel for REVERSE REVERB, not a reversed-input delay.
// GATE TIME locates the start of the growing tail; TIME is its finite duration.
// A short upstream diffuser makes the 128 signed taps overlap. The quadratic
// rising weights, tap placements and normalization are clean-room choices.
// PRE DELAY and direct/effect routing are handled by NativeOfficialWetPath.
class NativeOfficialReverseReverb final {
public:
    bool prepare(unsigned int rate) noexcept {
        if (rate < 8000U || rate > 192000U) return false;
        rate_ = rate;
        try {
            for (auto& channel : history_) channel.assign(11U * static_cast<std::size_t>(rate) + 4U, 0.0f);
        } catch (...) { return false; }
        double energy = 0.0;
        std::uint32_t random = 0x52565242U;
        for (std::size_t i = 0U; i < kTaps; ++i) {
            const double position = static_cast<double>(i) / (kTaps - 1U);
            const float weight = static_cast<float>(0.0125 + position * position);
            energy += weight * weight;
            random = random * 1664525U + 1013904223U;
            weights_[0][i] = (random & 0x10000U) != 0U ? weight : -weight;
            random = random * 1664525U + 1013904223U;
            weights_[1][i] = (random & 0x10000U) != 0U ? weight : -weight;
        }
        const float normalization = static_cast<float>(1.0 / std::sqrt(energy));
        for (auto& channel : weights_) for (auto& weight : channel) weight *= normalization;
        reset();
        return true;
    }
    void setTime(float seconds, std::uint64_t ramp) noexcept { time_.setTarget(seconds, ramp); }
    void setGateTime(float seconds, std::uint64_t ramp) noexcept { gate_.setTarget(seconds, ramp); }
    void reset() noexcept {
        write_ = valid_ = frames_ = 0U;
        time_.reset(time_.target()); gate_.reset(gate_.target());
        updateOffsets(time_.current(), gate_.current());
    }
    void process(float* frame, unsigned int channels) noexcept {
        if (channels == 0U || history_[0].empty()) return;
        const float duration = time_.next(), onset = gate_.next();
        if ((frames_++ % 8U) == 0U) updateOffsets(duration, onset);
        history_[0][write_] = std::isfinite(frame[0]) ? frame[0] : 0.0f;
        history_[1][write_] = channels > 1U && std::isfinite(frame[1]) ? frame[1] : history_[0][write_];
        std::array<float, 2U> wet{};
        for (std::size_t tap = 0U; tap < kTaps; ++tap) {
            const float left = read(0U, offsets_[tap]), right = read(1U, offsets_[tap]);
            wet[0] += (0.85f * left + 0.15f * right) * weights_[0][tap];
            wet[1] += (0.85f * right + 0.15f * left) * weights_[1][tap];
        }
        frame[0] = std::clamp(wet[0], -8.0f, 8.0f);
        if (channels > 1U) frame[1] = std::clamp(wet[1], -8.0f, 8.0f);
        valid_ = std::min(valid_ + 1U, history_[0].size() - 1U);
        if (++write_ == history_[0].size()) write_ = 0U;
    }
private:
    void updateOffsets(float duration, float onset) noexcept {
        for (std::size_t tap = 0U; tap < kTaps; ++tap)
            offsets_[tap] = (onset + duration * static_cast<float>(tap) / (kTaps - 1U)) * rate_;
    }
    float read(unsigned int channel, float delay) const noexcept {
        const auto whole = static_cast<std::size_t>(delay);
        const float fraction = delay - whole;
        const auto size = history_[channel].size();
        const auto a = (write_ + size - whole) % size, b = (a + size - 1U) % size;
        const float first = whole <= valid_ ? history_[channel][a] : 0.0f;
        const float second = whole + 1U <= valid_ ? history_[channel][b] : 0.0f;
        return first + (second - first) * fraction;
    }
    static constexpr std::size_t kTaps = 128U;
    unsigned int rate_ = 48000U;
    std::size_t write_ = 0U, valid_ = 0U, frames_ = 0U;
    dsp::ParameterSmoother time_{3.0f}, gate_{0.5f};
    std::array<std::vector<float>, 2U> history_{};
    std::array<std::array<float, kTaps>, 2U> weights_{};
    std::array<float, kTaps> offsets_{};
};
} // namespace webrc::native
