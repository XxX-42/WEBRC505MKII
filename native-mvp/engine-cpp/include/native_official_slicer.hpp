#pragma once

#include "dsp_primitives.hpp"
#include "native_official_fx.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace webrc::native {

// Manual control compatibility, not a reproduction of Roland's DSP or
// factory pattern tables. STEP LENGTH is a shared gate-duty percentage; the
// sixteen STEP LEVEL controls address independently stored levels. The edit
// index is a software convenience, not an extra manual audio parameter.
// PATTERN uses an explicitly software-authored table (all-open by default).
// Its ATTACK adds an onset accent: 1 + 3 * attack/100 * exp(-phase/0.1).
// This clean-room law is not a measured hardware timing/level curve.
// Both modes use a linked 4:1 compressor (5 ms attack, 80 ms release) before
// the slicer, and a 2 ms gate smoother. All state has fixed-size storage.
class NativeOfficialSlicer final {
public:
    enum class Mode { Step, Pattern };

    explicit NativeOfficialSlicer(Mode mode = Mode::Step) noexcept : mode_(mode) {
        for (auto& level : levels_) level.reset(100.0f);
        authoredPattern_.fill(1.0f);
        compGain_.reset(mode_ == Mode::Step ? 6.0f : 2.0f);
    }

    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept {
        if (sampleRate < 8000U || sampleRate > 192000U) return false;
        sampleRate_ = sampleRate;
        gateAlpha_ = std::exp(-1.0 / (sampleRate_ * 0.002));
        attackAlpha_ = std::exp(-1.0 / (sampleRate_ * 0.005));
        releaseAlpha_ = std::exp(-1.0 / (sampleRate_ * 0.080));
        prepared_ = true;
        reset();
        return true;
    }

    // Only a valid, supported actual knob activates official processing.
    // Unknown keys, PATTERN P01..P20, and auxiliary tempo/edit updates do not.
    [[nodiscard]] bool setParameter(std::string_view key, float value,
        std::uint64_t rampFrames = 0U) noexcept {
        const Control control = identify(key);
        if (control == Control::Unknown || !validControl(key, value)) return false;
        if (!active_) activateDefaults();
        switch (control) {
        case Control::Rate: rateValue_ = value; updateRate(rampFrames); break;
        case Control::Count: {
            const auto count = static_cast<unsigned int>(value);
            // The public domain already requires 1..16. Keep the divisor's
            // nonzero invariant explicit for strict optimized MSVC builds.
            if (count == 0U) return false;
            stepMax_ = count;
            step_ %= count;
            break;
        }
        case Control::Duty: duty_.setTarget(value, rampFrames); break;
        case Control::Level: levels_[levelIndex(key)].setTarget(value, rampFrames); break;
        case Control::Attack: attack_.setTarget(value, rampFrames); break;
        case Control::Depth: depth_.setTarget(value, rampFrames); break;
        case Control::Threshold: threshold_.setTarget(value, rampFrames); break;
        case Control::Gain: compGain_.setTarget(value, rampFrames); break;
        case Control::Unknown: return false;
        }
        return true;
    }

    [[nodiscard]] bool setTempo(float bpm, std::uint64_t rampFrames = 0U) noexcept {
        if (!std::isfinite(bpm) || bpm < 40.0f || bpm > 300.0f) return false;
        bpm_ = bpm;
        updateRate(rampFrames);
        return true;
    }

    [[nodiscard]] bool setQuarterNotesPerMeasure(float beats,
        std::uint64_t rampFrames = 0U) noexcept {
        if (!std::isfinite(beats) || beats < 0.125f || beats > 128.0f) return false;
        quarterNotesPerMeasure_ = beats;
        updateRate(rampFrames);
        return true;
    }

    [[nodiscard]] bool setStepIndex(unsigned int index) noexcept {
        if (mode_ != Mode::Step || index >= levels_.size()) return false;
        editIndex_ = index;
        return true;
    }

    // Preserve an existing software-authored pattern without assigning it a
    // Roland factory name/number. Invalid input is transactional: no changes.
    [[nodiscard]] bool setAuthoredPattern(const float* levels, std::size_t count) noexcept {
        if (mode_ != Mode::Pattern || levels == nullptr || count == 0U ||
            count > authoredPattern_.size()) return false;
        for (std::size_t i = 0U; i < count; ++i) {
            if (!std::isfinite(levels[i]) || levels[i] < 0.0f || levels[i] > 1.0f) return false;
        }
        for (std::size_t i = 0U; i < count; ++i) authoredPattern_[i] = levels[i];
        authoredCount_ = static_cast<unsigned int>(count);
        step_ %= authoredCount_;
        return true;
    }

    [[nodiscard]] bool active() const noexcept { return active_; }
    [[nodiscard]] unsigned int stepIndex() const noexcept { return step_; }
    [[nodiscard]] float targetRateHz() const noexcept { return rateHz_.target(); }

    // Values are in displayed units, including the selected STEP LEVEL alias.
    [[nodiscard]] bool getParameter(std::string_view key, float& value) const noexcept {
        switch (identify(key)) {
        case Control::Rate: value = rateValue_; break;
        case Control::Count: value = static_cast<float>(stepMax_); break;
        case Control::Duty: value = duty_.target(); break;
        case Control::Level: value = levels_[levelIndex(key)].target(); break;
        case Control::Attack: value = attack_.target(); break;
        case Control::Depth: value = depth_.target(); break;
        case Control::Threshold: value = threshold_.target(); break;
        case Control::Gain: value = compGain_.target(); break;
        case Control::Unknown: return false;
        }
        return true;
    }

    void reset() noexcept {
        phase_ = 0.0;
        step_ = 0U;
        gate_ = 1.0;
        envelope_ = 0.0;
        rateHz_.reset(rateHz_.target());
        duty_.reset(duty_.target());
        attack_.reset(attack_.target());
        depth_.reset(depth_.target());
        threshold_.reset(threshold_.target());
        compGain_.reset(compGain_.target());
        for (auto& level : levels_) level.reset(level.target());
    }

    // Inactive/unprepared processing is a no-op so the catalog may retain its
    // existing legacy path until a supported official knob is actually used.
    void process(float* frame, unsigned int channels) noexcept {
        if (!prepared_ || !active_ || frame == nullptr || channels == 0U) return;
        const float left = bounded(frame[0]);
        const float right = channels > 1U ? bounded(frame[1]) : left;
        const double amplitude = std::max(std::fabs(left), std::fabs(right));
        const double alpha = amplitude > envelope_ ? attackAlpha_ : releaseAlpha_;
        envelope_ = alpha * envelope_ + (1.0 - alpha) * amplitude;
        if (envelope_ < 1.0e-20) envelope_ = 0.0;
        const double threshold = threshold_.next();
        const double above = std::max(0.0, 20.0 * std::log10(std::max(1.0e-12, envelope_)) - threshold);
        const double compression = std::pow(10.0, (compGain_.next() - 0.75 * above) / 20.0);
        const double hz = rateHz_.next();
        const double duty = duty_.next() * 0.01;
        const double depth = depth_.next() * 0.01;
        const double attack = attack_.next() * 0.01;
        float currentLevel = 0.0f;
        for (std::size_t i = 0U; i < levels_.size(); ++i) {
            const float level = levels_[i].next();
            if (i == step_) currentLevel = level * 0.01f;
        }
        double target = 0.0;
        if (phase_ < duty) {
            if (mode_ == Mode::Step) target = currentLevel;
            else {
                const double onset = 1.0 + 3.0 * attack * std::exp(-phase_ / 0.1);
                target = authoredPattern_[step_] * onset;
            }
        }
        gate_ = gateAlpha_ * gate_ + (1.0 - gateAlpha_) * target;
        if (gate_ < 1.0e-20) gate_ = 0.0;
        const double gain = (1.0 - depth + depth * gate_) * compression;
        frame[0] = bounded(static_cast<float>(left * gain));
        if (channels > 1U) frame[1] = bounded(static_cast<float>(right * gain));
        phase_ += hz / sampleRate_;
        // Eliminate only tiny floating-point residue around exact sample
        // boundaries; scheduling is sample-clocked and block-size independent.
        if (phase_ >= 1.0 - 1.0e-12) {
            phase_ = std::max(0.0, phase_ - 1.0);
            const unsigned int count = mode_ == Mode::Step ? stepMax_ : authoredCount_;
            step_ = (step_ + 1U) % count;
        }
    }

private:
    enum class Control { Unknown, Rate, Count, Duty, Level, Attack, Depth, Threshold, Gain };
    inline static constexpr std::array<std::string_view, 16U> kLevelKeys{{
        "official_step_level_1", "official_step_level_2", "official_step_level_3", "official_step_level_4",
        "official_step_level_5", "official_step_level_6", "official_step_level_7", "official_step_level_8",
        "official_step_level_9", "official_step_level_10", "official_step_level_11", "official_step_level_12",
        "official_step_level_13", "official_step_level_14", "official_step_level_15", "official_step_level_16",
    }};

    [[nodiscard]] std::size_t levelIndex(std::string_view key) const noexcept {
        for (std::size_t i = 0U; i < kLevelKeys.size(); ++i) if (key == kLevelKeys[i]) return i;
        return editIndex_;
    }
    [[nodiscard]] Control identify(std::string_view key) const noexcept {
        if (key == "official_rate") return Control::Rate;
        if (key == "official_depth") return Control::Depth;
        if (key == "official_comp_threshold") return Control::Threshold;
        if (key == "official_comp_gain") return Control::Gain;
        if (mode_ == Mode::Step) {
            if (key == "official_step_max") return Control::Count;
            if (key == "official_step_length") return Control::Duty;
            if (key == "official_step_level") return Control::Level;
            for (const auto candidate : kLevelKeys) if (key == candidate) return Control::Level;
        } else {
            if (key == "official_duty") return Control::Duty;
            if (key == "official_attack") return Control::Attack;
        }
        return Control::Unknown;
    }
    [[nodiscard]] bool validControl(std::string_view key, float value) const noexcept {
        if (identify(key) == Control::Level) key = "official_step_level";
        return official::validParameter(mode_ == Mode::Step ? "step_slicer" : "pattern_slicer", key, value);
    }
    void updateRate(std::uint64_t rampFrames) noexcept {
        rateHz_.setTarget(official::rateHz(rateValue_, bpm_, quarterNotesPerMeasure_), rampFrames);
    }
    void activateDefaults() noexcept {
        // Auxiliary BPM, meter, edit index and authored pattern intentionally
        // survive activation. Defaults are applied once, never on each edit.
        rateValue_ = -1.0f;
        stepMax_ = 16U;
        duty_.reset(50.0f);
        attack_.reset(35.0f);
        depth_.reset(100.0f);
        threshold_.reset(-30.0f);
        compGain_.reset(mode_ == Mode::Step ? 6.0f : 2.0f);
        for (auto& level : levels_) level.reset(100.0f);
        updateRate(0U);
        active_ = true;
    }
    [[nodiscard]] static float bounded(float value) noexcept {
        return std::isfinite(value) ? std::clamp(value, -8.0f, 8.0f) : 0.0f;
    }

    Mode mode_;
    unsigned int sampleRate_ = 48000U, stepMax_ = 16U, authoredCount_ = 1U, step_ = 0U, editIndex_ = 0U;
    float bpm_ = 120.0f, quarterNotesPerMeasure_ = 4.0f, rateValue_ = -1.0f;
    bool prepared_ = false, active_ = false;
    dsp::ParameterSmoother rateHz_{2.0f}, duty_{50.0f}, attack_{35.0f}, depth_{100.0f},
        threshold_{-30.0f}, compGain_{6.0f};
    std::array<dsp::ParameterSmoother, 16U> levels_;
    std::array<float, 16U> authoredPattern_{};
    double phase_ = 0.0, gate_ = 1.0, envelope_ = 0.0;
    double gateAlpha_ = 0.0, attackAlpha_ = 0.0, releaseAlpha_ = 0.0;
};

} // namespace webrc::native
