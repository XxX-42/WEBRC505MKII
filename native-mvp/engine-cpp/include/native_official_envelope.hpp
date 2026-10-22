#pragma once
#include "native_official_domains.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string_view>
namespace webrc::native {
// Authored linear-amplitude ADSR. Manual 0..100 time scales are mapped
// exponentially; these transfer curves are not measured hardware data.
class NativeOfficialFreezeEnvelope final {
public:
    void prepare(unsigned int rate) noexcept { rate_ = rate; reset(); }
    bool set(std::string_view key, float value, std::uint64_t rampFrames = 0U) noexcept {
        if (!official::validParameter("freeze", key, value)) return false;
        if (key == "official_attack") { attack_ = value; if (stage_ == Stage::Attack) begin(Stage::Attack, 1.0f, attackFrames()); }
        else if (key == "official_decay") { decay_ = value; if (stage_ == Stage::Decay) begin(Stage::Decay, sustain_, decayFrames()); }
        else if (key == "official_release") { release_ = value; if (stage_ == Stage::Release) begin(Stage::Release, 0.0f, releaseFrames()); }
        else if (key == "official_sustain") { sustain_ = value * 0.01f; if (stage_ == Stage::Sustain) begin(Stage::Sustain, sustain_, rampFrames != 0U ? rampFrames : std::max(1U, rate_ / 100U)); else if (stage_ == Stage::Decay) begin(Stage::Decay, sustain_, decayFrames()); }
        else if (key == "official_balance") {
            balanceTarget_ = value * 0.01f; balanceRemaining_ = rampFrames;
            if (rampFrames == 0U) balance_ = balanceTarget_;
            else balanceStep_ = static_cast<double>(balanceTarget_ - balance_) / static_cast<double>(rampFrames);
        }
        else return false;
        return true;
    }
    void attack() noexcept { begin(Stage::Attack, 1.0f, attackFrames()); }
    void release() noexcept { begin(Stage::Release, 0.0f, releaseFrames()); }
    void reset() noexcept { balance_ = balanceTarget_; balanceRemaining_ = 0U; gain_ = 0; target_ = 0; step_ = 0; remaining_ = 0; stage_ = Stage::Idle; }
    float next() noexcept {
        if (balanceRemaining_ != 0U) {
            balance_ = static_cast<float>(balance_ + balanceStep_);
            if (--balanceRemaining_ == 0U) balance_ = balanceTarget_;
        }
        if (remaining_ != 0U) {
            gain_ = static_cast<float>(gain_ + step_);
            if (--remaining_ == 0U) {
                gain_ = target_;
                if (stage_ == Stage::Attack) begin(Stage::Decay, sustain_, decayFrames());
                else if (stage_ == Stage::Decay) stage_ = Stage::Sustain;
                else if (stage_ == Stage::Release) stage_ = Stage::Idle;
            }
        }
        return gain_;
    }
    bool idle() const noexcept { return stage_ == Stage::Idle; }
    float balance() const noexcept { return balance_; }
    std::uint64_t releaseFrames() const noexcept { return timeFrames(release_, 2.0, 2500.0); }
private:
    enum class Stage { Idle, Attack, Decay, Sustain, Release };
    Stage stage_ = Stage::Idle;
    unsigned int rate_ = 48000U;
    float attack_ = 30, decay_ = 30, release_ = 30, sustain_ = 0.3f, balance_ = 0.5f;
    float balanceTarget_ = 0.5f;
    double balanceStep_ = 0.0;
    std::uint64_t balanceRemaining_ = 0U;
    float gain_ = 0, target_ = 0;
    double step_ = 0;
    std::uint64_t remaining_ = 0;
    std::uint64_t timeFrames(float value, double minimumMs, double ratio) const noexcept {
        return static_cast<std::uint64_t>(std::max(1.0, std::round(rate_ * minimumMs * std::pow(ratio, value * 0.01) / 1000.0)));
    }
    std::uint64_t attackFrames() const noexcept { return timeFrames(attack_, 2.0, 1000.0); }
    std::uint64_t decayFrames() const noexcept { return timeFrames(decay_, 10.0, 200.0); }
    void begin(Stage stage, float target, std::uint64_t frames) noexcept {
        stage_ = stage; target_ = target; remaining_ = std::max<std::uint64_t>(1U, frames);
        step_ = static_cast<double>(target_ - gain_) / static_cast<double>(remaining_);
    }
};
} // namespace webrc::native
