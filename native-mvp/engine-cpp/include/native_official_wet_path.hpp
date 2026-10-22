#pragma once

#include "dsp_primitives.hpp"
#include "native_official_fx.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <string_view>
#include <vector>

namespace webrc::native {

// Shared clean-room manual-interface wet routing. Storage is allocated only
// during prepare; controls/processing remain allocation-free on the owner.
class NativeOfficialWetPath final {
public:
    bool prepare(unsigned int rate, bool withPreDelay = false) noexcept {
        rate_ = rate;
        try {
            for (auto& channel : delay_) channel.assign(withPreDelay ? rate / 2U + 2U : 0U, 0.0f);
        } catch (...) { return false; }
        reset();
        return true;
    }
    void reset() noexcept {
        for (auto& channel : delay_) std::fill(channel.begin(), channel.end(), 0.0f);
        for (auto& filter : low_) filter.reset();
        for (auto& filter : high_) filter.reset();
        direct_.reset(direct_.target()); effect_.reset(effect_.target());
        preDelay_.reset(preDelay_.target()); lowHz_.reset(lowHz_.target()); highHz_.reset(highHz_.target());
        write_ = 0U; frames_ = 0U;
    }
    bool set(std::string_view id, float value, std::uint64_t ramp) noexcept {
        if (id == "official_d_level") direct_.setTarget(value * 0.01f, ramp);
        else if (id == "official_e_level") effect_.setTarget(value * 0.01f, ramp);
        else if (id == "official_pre_delay") preDelay_.setTarget(value, ramp);
        else if (id == "official_low_cut") {
            lowOff_ = value == official::kStepOff;
            if (!lowOff_) lowHz_.setTarget(value, ramp);
        } else if (id == "official_high_cut") {
            highOff_ = value == official::kStepOff;
            if (!highOff_) highHz_.setTarget(value, ramp);
        } else return false;
        return true;
    }
    void delayInput(float* frame, unsigned int channels) noexcept {
        const float milliseconds = preDelay_.next();
        if (delay_[0].empty()) return;
        const double samples = std::clamp(static_cast<double>(milliseconds) * rate_ * 0.001,
            0.0, static_cast<double>(delay_[0].size() - 2U));
        const auto whole = static_cast<std::size_t>(samples);
        const float fraction = static_cast<float>(samples - whole);
        const auto size = delay_[0].size();
        const auto first = (write_ + size - whole) % size;
        const auto second = (first + size - 1U) % size;
        for (unsigned int channel = 0U; channel < std::min(channels, 2U); ++channel) {
            delay_[channel][write_] = frame[channel];
            frame[channel] = delay_[channel][first] + (delay_[channel][second] - delay_[channel][first]) * fraction;
        }
        if (++write_ == size) write_ = 0U;
    }
    void mix(float* wet, const std::array<float, 2U>& dry, unsigned int channels, float wetEnvelope = 1.0f) noexcept {
        const float direct = direct_.next();
        const float effect = effect_.next() * wetEnvelope;
        const float lowHz = lowHz_.next();
        const float highHz = highHz_.next();
        if ((frames_++ % 8U) == 0U) {
            for (unsigned int channel = 0U; channel < 2U; ++channel) {
                (void)low_[channel].setParameters(rate_, std::min(static_cast<double>(lowHz), rate_ * 0.45), 0.70710678);
                (void)high_[channel].setParameters(rate_, std::min(static_cast<double>(highHz), rate_ * 0.45), 0.70710678);
            }
        }
        for (unsigned int channel = 0U; channel < std::min(channels, 2U); ++channel) {
            float value = wet[channel];
            const auto hp = low_[channel].process(value);
            if (!lowOff_) value = hp.highPass;
            const auto lp = high_[channel].process(value);
            if (!highOff_) value = lp.lowPass;
            wet[channel] = dry[channel] * direct + value * effect;
        }
    }
private:
    unsigned int rate_ = 48000U;
    dsp::ParameterSmoother direct_{1.0f}, effect_{0.5f}, preDelay_{0.0f};
    dsp::ParameterSmoother lowHz_{20.0f}, highHz_{12500.0f};
    std::array<dsp::TptStateVariableFilter, 2U> low_{}, high_{};
    std::array<std::vector<float>, 2U> delay_{};
    std::size_t write_ = 0U;
    std::uint64_t frames_ = 0U;
    bool lowOff_ = true, highOff_ = true;
};
} // namespace webrc::native
