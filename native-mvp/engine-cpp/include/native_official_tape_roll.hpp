#pragma once

#include "dsp_primitives.hpp"
#include "native_official_domains.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>
#include <vector>

namespace webrc::native {

// Clean-room implementation of the documented TAPE ECHO control interfaces.
// The three linear-interpolated heads (1x/2x/3x TIME, .55/.30/.15 weights),
// fixed 6 kHz record/repro damping and contractive soft saturation are authored
// choices, not hardware-sound equivalence. INTENSITY is .95 * value/100.
// ECHO1's speed law is 2000 * .0005^(value/100) ms; BASS/TREBLE map to +/-20 dB.
// ECHO2 accepts numeric ms or only the schema's verified musical note values.
// Half-note sync at 40 BPM needs 3 seconds, not the numeric 2000 ms maximum.
// Shelves/cuts affect only wet output. D.LEVEL and E.LEVEL are independent.
// All storage is allocated at prepare; resets invalidate history in O(1).
// Use all state-changing methods on the single DSP owner thread.
class NativeOfficialTapeEcho final {
public:
    bool prepare(unsigned int sampleRate) noexcept {
        if (sampleRate < 8000U || sampleRate > 192000U) return false;
        try {
            std::array<std::vector<float>, 2U> next;
            for (auto& channel : next) channel.assign(9U * static_cast<std::size_t>(sampleRate) + 4U, 0.0f);
            history_.swap(next);
        } catch (...) { return false; }
        rate_ = sampleRate;
        toneAlpha_ = static_cast<float>(1.0 - std::exp(-6.28318530717958647692 *
            std::min(6000.0, sampleRate * 0.45) / sampleRate));
        updateTime(0U);
        reset();
        return true;
    }

    // Re-selecting the active branch is a no-op; switching clears all branch state.
    bool setVariant(unsigned int variant) noexcept {
        if (variant != 1U && variant != 2U) return false;
        if (variant == variant_) return true;
        variant_ = variant;
        repeatRate_ = variant == 1U ? 50.0f : 200.0f;
        intensity_.reset(0.475f);
        direct_.reset(1.0f); effect_.reset(0.5f);
        bass_.reset(0.0f); treble_.reset(0.0f);
        lowHz_.reset(20.0f); highHz_.reset(12500.0f);
        lowFlat_ = highFlat_ = true;
        updateTime(0U);
        reset();
        return true;
    }

    bool setParameter(std::string_view key, float value, std::uint64_t rampFrames = 0U) noexcept {
        if (!official::validParameter(variant_ == 1U ? "tape_echo1" : "tape_echo2", key, value)) return false;
        if (key == "official_repeat_rate") { repeatRate_ = value; updateTime(rampFrames); }
        else if (key == "official_intensity") intensity_.setTarget(value * 0.0095f, rampFrames);
        else if (key == "official_d_level") direct_.setTarget(value * 0.01f, rampFrames);
        else if (key == "official_e_level") effect_.setTarget(value * 0.01f, rampFrames);
        else if (key == "official_bass") bass_.setTarget(value * 0.4f, rampFrames);
        else if (key == "official_treble") treble_.setTarget(value * 0.4f, rampFrames);
        else if (key == "official_low_cut") {
            lowFlat_ = value == kFlat;
            if (!lowFlat_) lowHz_.setTarget(value, rampFrames);
        } else if (key == "official_high_cut") {
            highFlat_ = value == kFlat;
            if (!highFlat_) highHz_.setTarget(value, rampFrames);
        } else return false;
        coefficientCountdown_ = 0U;
        return true;
    }

    bool setTempo(float bpm, std::uint64_t rampFrames = 0U) noexcept {
        if (!std::isfinite(bpm) || bpm < 40.0f || bpm > 300.0f) return false;
        bpm_ = bpm;
        updateTime(rampFrames);
        return true;
    }

    void reset() noexcept {
        write_ = valid_ = 0U;
        coefficientCountdown_ = 0U;
        filtersDirty_ = true;
        feedbackTone_.fill(0.0f); reproTone_.fill(0.0f);
        for (auto& filter : bassFilter_) filter.reset();
        for (auto& filter : trebleFilter_) filter.reset();
        for (auto& filter : lowFilter_) filter.reset();
        for (auto& filter : highFilter_) filter.reset();
        delaySamples_.reset(delaySamples_.target()); intensity_.reset(intensity_.target());
        direct_.reset(direct_.target()); effect_.reset(effect_.target());
        bass_.reset(bass_.target()); treble_.reset(treble_.target());
        lowHz_.reset(lowHz_.target()); highHz_.reset(highHz_.target());
    }

    void process(float* frame, unsigned int channels) noexcept {
        if (frame == nullptr || channels == 0U || history_[0].empty()) return;
        const float delay = delaySamples_.next(), feedback = intensity_.next();
        const float direct = direct_.next(), effect = effect_.next();
        const float bass = bass_.next(), treble = treble_.next();
        const float low = lowHz_.next(), high = highHz_.next();
        if (coefficientCountdown_ == 0U) {
            // Design only changed, active filters. Steady callback cost does not
            // include redundant trigonometry or unused-branch coefficient work.
            if (variant_ == 1U) {
                if (filtersDirty_ || bass != appliedBass_)
                    for (auto& filter : bassFilter_)
                        (void)filter.setParameters(dsp::BiquadType::LowShelf, rate_, 250.0, 0.70710678, bass);
                if (filtersDirty_ || treble != appliedTreble_)
                    for (auto& filter : trebleFilter_)
                        (void)filter.setParameters(dsp::BiquadType::HighShelf, rate_, std::min(4000.0, rate_ * 0.4), 0.70710678, treble);
                appliedBass_ = bass; appliedTreble_ = treble;
            } else {
                if (filtersDirty_ || low != appliedLow_)
                    for (auto& filter : lowFilter_)
                        (void)filter.setParameters(dsp::BiquadType::HighPass, rate_, std::min(static_cast<double>(low), rate_ * 0.45));
                if (filtersDirty_ || high != appliedHigh_)
                    for (auto& filter : highFilter_)
                        (void)filter.setParameters(dsp::BiquadType::LowPass, rate_, std::min(static_cast<double>(high), rate_ * 0.45));
                appliedLow_ = low; appliedHigh_ = high;
            }
            filtersDirty_ = false;
            coefficientCountdown_ = 8U;
        }
        --coefficientCountdown_;
        const std::array<float, 2U> dry{bounded(frame[0]), bounded(channels > 1U ? frame[1] : frame[0])};
        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            const float head1 = read(channel, delay);
            const float head2 = read(channel, 2.0 * delay), head3 = read(channel, 3.0 * delay);
            feedbackTone_[channel] += toneAlpha_ * (head1 - feedbackTone_[channel]);
            const float record = bounded(dry[channel] + feedback * feedbackTone_[channel]);
            // Each branch has derivative <= 1, maintaining a contractive loop.
            history_[channel][write_] = 0.75f * record + 0.25f * std::tanh(2.75f * record) / 2.75f;
            const float heads = 0.55f * head1 + 0.30f * head2 + 0.15f * head3;
            reproTone_[channel] += toneAlpha_ * (heads - reproTone_[channel]);
            float wet = reproTone_[channel];
            if (variant_ == 1U) {
                wet = bassFilter_[channel].process(wet);
                wet = trebleFilter_[channel].process(wet);
            } else {
                const float lowCut = lowFilter_[channel].process(wet);
                if (!lowFlat_) wet = lowCut;
                const float highCut = highFilter_[channel].process(wet);
                if (!highFlat_) wet = highCut;
            }
            if (channel < channels) frame[channel] = bounded(dry[channel] * direct + wet * effect);
        }
        valid_ = std::min(valid_ + 1U, history_[0].size() - 1U);
        if (++write_ == history_[0].size()) write_ = 0U;
    }

    void processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept {
        if (interleaved == nullptr || channels == 0U) return;
        for (unsigned int i = 0U; i < frames; ++i) process(interleaved + static_cast<std::size_t>(i) * channels, channels);
    }
    unsigned int variant() const noexcept { return variant_; }
    float delayMilliseconds() const noexcept { return delaySamples_.target() * 1000.0f / rate_; }

private:
    static constexpr float kFlat = -1000.0f;
    static float bounded(float value) noexcept { return std::isfinite(value) ? std::clamp(value, -8.0f, 8.0f) : 0.0f; }
    void updateTime(std::uint64_t rampFrames) noexcept {
        const double milliseconds = variant_ == 1U ? 2000.0 * std::pow(0.0005, repeatRate_ * 0.01) :
            repeatRate_ < 0.0f ? -repeatRate_ * 60000.0 / bpm_ : repeatRate_;
        delaySamples_.setTarget(static_cast<float>(milliseconds * rate_ * 0.001), rampFrames);
    }
    float read(unsigned int channel, double delay) const noexcept {
        const auto whole = static_cast<std::size_t>(delay);
        const float fraction = static_cast<float>(delay - whole);
        const auto capacity = history_[channel].size();
        const auto first = (write_ + capacity - whole) % capacity;
        const auto second = (first + capacity - 1U) % capacity;
        const float a = whole <= valid_ ? history_[channel][first] : 0.0f;
        const float b = whole + 1U <= valid_ ? history_[channel][second] : 0.0f;
        return a + fraction * (b - a);
    }
    unsigned int rate_ = 48000U, variant_ = 1U, coefficientCountdown_ = 0U;
    float repeatRate_ = 50.0f, bpm_ = 120.0f, toneAlpha_ = 0.54406187f;
    dsp::ParameterSmoother delaySamples_{2146.6252f}, intensity_{0.475f};
    dsp::ParameterSmoother direct_{1.0f}, effect_{0.5f}, bass_{0.0f}, treble_{0.0f};
    dsp::ParameterSmoother lowHz_{20.0f}, highHz_{12500.0f};
    std::array<std::vector<float>, 2U> history_{};
    std::array<dsp::Biquad, 2U> bassFilter_{}, trebleFilter_{}, lowFilter_{}, highFilter_{};
    std::array<float, 2U> feedbackTone_{}, reproTone_{};
    std::size_t write_ = 0U, valid_ = 0U;
    float appliedBass_ = 0.0f, appliedTreble_ = 0.0f, appliedLow_ = 20.0f, appliedHigh_ = 12500.0f;
    bool lowFlat_ = true, highFlat_ = true, filtersDirty_ = true;
};

// Capture/repeat counterpart to BrowserOfficialRollDsp. OFF initially listens
// silently. ON snapshots the latest complete TIME interval, or waits for it.
// ON repeats its first 1/2, 1/4, 1/8 or 1/16 indefinitely. Division edits restart
// the fraction without replacing the snapshot. OFF restarts that fraction for
// exactly FEEDBACK (ROLL1) / REPEAT (ROLL2) cycles, then silences the wet signal.
// INF is exclusive to ROLL2. The count is not a recursive feedback coefficient.
// TIME/BPM edits resample the existing captured audio into the new duration;
// they change pitch, not time-stretch. Count edits preserve already played cycles.
// The manual marks no ROLL default: initial OFF is a safe SOFTWARE fallback,
// not a claimed factory default. Both variants share an authored DSP model;
// equality with Roland's previous/new proprietary algorithms is not claimed.
// Four fixed arrays are allocated only at prepare. Capture copying is bounded
// by 3 seconds (half note at 40 BPM); reset invalidates history without clearing.
class NativeOfficialRoll final {
public:
    bool prepare(unsigned int sampleRate) noexcept {
        if (sampleRate < 8000U || sampleRate > 192000U) return false;
        try {
            std::array<std::vector<float>, 2U> nextSource, nextCaptured;
            for (auto& channel : nextSource) channel.assign(3U * static_cast<std::size_t>(sampleRate), 0.0f);
            for (auto& channel : nextCaptured) channel.assign(3U * static_cast<std::size_t>(sampleRate), 0.0f);
            source_.swap(nextSource); captured_.swap(nextCaptured);
        } catch (...) { return false; }
        rate_ = sampleRate;
        updateTime();
        reset();
        return true;
    }

    // Re-selecting the active branch is a no-op; switching clears all branch state.
    bool setVariant(unsigned int variant) noexcept {
        if (variant != 1U && variant != 2U) return false;
        if (variant == variant_) return true;
        variant_ = variant;
        time_ = -1.0f; repeats_ = 50; roll_ = 0U; playbackDivision_ = 1U;
        balance_.reset(0.5f);
        updateTime();
        reset();
        return true;
    }

    bool setParameter(std::string_view key, float value, std::uint64_t rampFrames = 0U) noexcept {
        if (!official::validParameter(variant_ == 1U ? "roll1" : "roll2", key, value)) return false;
        if (key == "official_balance") { balance_.setTarget(value * 0.01f, rampFrames); return true; }
        const auto previousRoll = roll_;
        const auto previousFrames = baseFrames_;
        if (key == "official_time") { time_ = value; updateTime(); }
        else if (key == "official_feedback" || key == "official_repeat") repeats_ = static_cast<int>(value);
        else if (key == "official_roll") roll_ = static_cast<unsigned int>(value);
        else return false;
        applyTransition(previousRoll, previousFrames);
        return true;
    }

    bool setTempo(float bpm, std::uint64_t = 0U) noexcept {
        if (!std::isfinite(bpm) || bpm < 40.0f || bpm > 300.0f) return false;
        const auto previousFrames = baseFrames_;
        bpm_ = bpm; updateTime();
        applyTransition(roll_, previousFrames);
        return true;
    }

    void reset() noexcept {
        sourceWrite_ = sourceFrames_ = capturedFrames_ = cyclePosition_ = 0U;
        completedReleaseRepeats_ = 0U;
        pendingCapture_ = roll_ != 0U;
        playing_ = false;
        if (roll_ != 0U) playbackDivision_ = 1U << roll_;
        balance_.reset(balance_.target());
        updateCycle();
    }

    void process(float* frame, unsigned int channels) noexcept {
        if (frame == nullptr || channels == 0U || source_[0].empty()) return;
        const std::array<float, 2U> dry{bounded(frame[0]), bounded(channels > 1U ? frame[1] : frame[0])};
        std::array<float, 2U> wet{};
        if (playing_ && fragmentFrames_ != 0U && cycleFrames_ != 0U) {
            const double position = static_cast<double>(cyclePosition_) * fragmentFrames_ / cycleFrames_;
            const auto first = static_cast<std::size_t>(position);
            const auto second = first + 1U < fragmentFrames_ ? first + 1U : 0U;
            const auto fraction = static_cast<float>(position - first);
            for (unsigned int channel = 0U; channel < 2U; ++channel)
                wet[channel] = captured_[channel][first] + fraction * (captured_[channel][second] - captured_[channel][first]);
            if (++cyclePosition_ >= cycleFrames_) {
                cyclePosition_ = 0U;
                if (roll_ == 0U) {
                    if (completedReleaseRepeats_ < std::numeric_limits<std::uint64_t>::max()) ++completedReleaseRepeats_;
                    if (repeats_ != kInfinite && completedReleaseRepeats_ >= static_cast<std::uint64_t>(repeats_)) playing_ = false;
                }
            }
        }
        const float mix = balance_.next();
        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            source_[channel][sourceWrite_] = dry[channel];
            if (channel < channels) frame[channel] = bounded((1.0f - mix) * dry[channel] + mix * wet[channel]);
        }
        if (++sourceWrite_ == source_[0].size()) sourceWrite_ = 0U;
        sourceFrames_ = std::min(source_[0].size(), sourceFrames_ + 1U);
        // The final input sample belongs to the capture, not also its first loop.
        if (pendingCapture_) captureIfReady();
    }

    void processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept {
        if (interleaved == nullptr || channels == 0U) return;
        for (unsigned int i = 0U; i < frames; ++i) process(interleaved + static_cast<std::size_t>(i) * channels, channels);
    }
    unsigned int variant() const noexcept { return variant_; }
    bool hasCapturedSlice() const noexcept { return capturedFrames_ != 0U; }
    bool isCapturePending() const noexcept { return pendingCapture_; }
    bool isPlaying() const noexcept { return playing_; }
    std::size_t timeFrames() const noexcept { return baseFrames_; }
    std::size_t activeCycleFrames() const noexcept { return cycleFrames_; }
    std::uint64_t completedReleaseRepeats() const noexcept { return completedReleaseRepeats_; }
    unsigned int selectedRoll() const noexcept { return roll_; }
    int repeatCount() const noexcept { return repeats_; }

private:
    static constexpr int kInfinite = -1000;
    static float bounded(float value) noexcept { return std::isfinite(value) ? std::clamp(value, -8.0f, 8.0f) : 0.0f; }
    void updateTime() noexcept {
        const double seconds = time_ > 0.0f ? time_ * 0.001 : -time_ * 60.0 / bpm_;
        baseFrames_ = std::max<std::size_t>(1U, static_cast<std::size_t>(std::llround(seconds * rate_)));
    }
    void updateCycle() noexcept {
        cycleFrames_ = std::max<std::size_t>(1U, static_cast<std::size_t>(std::llround(static_cast<double>(baseFrames_) / playbackDivision_)));
        fragmentFrames_ = capturedFrames_ != 0U ? std::max<std::size_t>(1U,
            static_cast<std::size_t>(std::llround(static_cast<double>(capturedFrames_) / playbackDivision_))) : 0U;
    }
    void applyTransition(unsigned int previousRoll, std::size_t previousFrames) noexcept {
        if (previousRoll == 0U && roll_ != 0U) {
            capturedFrames_ = 0U; playing_ = false; pendingCapture_ = true;
            completedReleaseRepeats_ = 0U;
            playbackDivision_ = 1U << roll_;
            cyclePosition_ = 0U; updateCycle(); captureIfReady();
        } else if (previousRoll != 0U && roll_ == 0U) {
            pendingCapture_ = false; completedReleaseRepeats_ = 0U; cyclePosition_ = 0U;
            updateCycle();
        } else if (roll_ != 0U) {
            playbackDivision_ = 1U << roll_;
            if (previousRoll != roll_ || previousFrames != baseFrames_) { cyclePosition_ = 0U; updateCycle(); }
            if (pendingCapture_) captureIfReady();
        } else if (previousFrames != baseFrames_) { cyclePosition_ = 0U; updateCycle(); }
        if (roll_ == 0U && repeats_ != kInfinite && completedReleaseRepeats_ >= static_cast<std::uint64_t>(repeats_)) playing_ = false;
    }
    void captureIfReady() noexcept {
        if (!pendingCapture_ || sourceFrames_ < baseFrames_ || source_[0].empty()) return;
        const auto capacity = source_[0].size();
        auto source = (sourceWrite_ + capacity - baseFrames_) % capacity;
        for (std::size_t i = 0U; i < baseFrames_; ++i) {
            captured_[0][i] = source_[0][source]; captured_[1][i] = source_[1][source];
            if (++source == capacity) source = 0U;
        }
        capturedFrames_ = baseFrames_;
        pendingCapture_ = false; playing_ = true; cyclePosition_ = 0U;
        updateCycle();
    }
    unsigned int rate_ = 48000U, variant_ = 1U, roll_ = 0U, playbackDivision_ = 1U;
    float time_ = -1.0f, bpm_ = 120.0f;
    int repeats_ = 50;
    dsp::ParameterSmoother balance_{0.5f};
    std::array<std::vector<float>, 2U> source_{}, captured_{};
    std::size_t sourceWrite_ = 0U, sourceFrames_ = 0U, capturedFrames_ = 0U;
    std::size_t baseFrames_ = 24000U, fragmentFrames_ = 0U, cycleFrames_ = 24000U, cyclePosition_ = 0U;
    std::uint64_t completedReleaseRepeats_ = 0U;
    bool pendingCapture_ = false, playing_ = false;
};
} // namespace webrc::native
