#pragma once

#include "dsp_primitives.hpp"
#include "native_official_domains.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <string_view>
#include <vector>

namespace webrc::native {

// Clean-room manual FEEDBACK = finite repeat count, never feedback percent.
// Authored tap law .65^(repeat-1), alternating panning, and reverse edge
// windows are not claims about Roland's implementation. Storage is fixed at
// prepare: 17 * 3 seconds per channel (about 18.7 MiB stereo at 48 kHz).
// Half-note sync at the host minimum 40 BPM needs 3 seconds, independently
// of the numeric 2000 ms limit. Musical TIME is never measure-scaled.
class NativeOfficialCountedDelay final {
public:
    enum class Mode { Delay, Panning, Reverse, Modulated };

    explicit NativeOfficialCountedDelay(Mode mode = Mode::Delay) noexcept : mode_(mode) {}

    bool prepare(unsigned int rate) noexcept {
        if (rate < 8000U || rate > 192000U) return false;
        rate_ = rate;
        try {
            for (auto& channel : history_) channel.assign(51U * static_cast<std::size_t>(rate) + 4U, 0.0f);
        } catch (...) { return false; }
        updateTime(0U);
        reset();
        return true;
    }

    bool set(std::string_view key, float value, std::uint64_t ramp) noexcept {
        const std::string_view effect = mode_ == Mode::Panning ? "panning_delay" :
            mode_ == Mode::Reverse ? "reverse_delay" : mode_ == Mode::Modulated ? "mod_delay" : "fractional_delay";
        if (!official::validParameter(effect, key, value)) return false;
        if (key == "official_time") { time_ = value; updateTime(ramp); }
        else if (key == "official_feedback") repeats_ = static_cast<unsigned int>(value);
        else if (key == "official_mod_depth") depth_.setTarget(value * 0.01f, ramp);
        else return false;
        return true;
    }

    void setTempo(float bpm, std::uint64_t ramp) noexcept {
        if (!std::isfinite(bpm) || bpm < 40.0f || bpm > 300.0f) return;
        bpm_ = bpm; updateTime(ramp);
    }

    void reset() noexcept {
        // Do not clear 51 seconds of audio on the callback. The valid history
        // epoch and empty segment list make all previous contents unreachable.
        write_ = 0U;
        valid_ = 0U;
        phase_ = 0.0;
        timeSamples_.reset(timeSamples_.target());
        depth_.reset(depth_.target());
        activeSegment_ = static_cast<std::size_t>(std::llround(timeSamples_.current()));
        segmentPosition_ = captureStart_ = completed_ = segmentHead_ = 0U;
        segmentStarts_.fill(0U);
        segmentLengths_.fill(0U);
    }

    void process(float* frame, unsigned int channels) noexcept {
        if (channels == 0U || history_[0].empty()) return;
        history_[0][write_] = bounded(frame[0]);
        history_[1][write_] = bounded(channels > 1U ? frame[1] : frame[0]);
        const float time = timeSamples_.next(), depth = depth_.next();
        float left = 0.0f, right = 0.0f, gain = 1.0f;
        if (mode_ == Mode::Reverse) {
            const double position = static_cast<double>(segmentPosition_) / std::max<std::size_t>(1U, activeSegment_ - 1U);
            const double edgeFrames = std::min(rate_ * 0.003, activeSegment_ * 0.125);
            const double edge = std::min({1.0, (segmentPosition_ + 0.5) / edgeFrames,
                (activeSegment_ - segmentPosition_ - 0.5) / edgeFrames});
            const float window = static_cast<float>(std::sin(1.57079632679489661923 * edge));
            for (unsigned int repeat = 0U; repeat < std::min(repeats_, completed_); ++repeat) {
                const std::size_t slot = (segmentHead_ + 16U - repeat) % 16U;
                const double positionInHistory = segmentStarts_[slot] + (segmentLengths_[slot] - 1U) * (1.0 - position);
                left += gain * readAt(0U, positionInHistory);
                right += gain * readAt(1U, positionInHistory);
                gain *= 0.65f;
            }
            left *= window; right *= window;
        } else {
            const double maxTime = (time_ < 0.0f ? 3.0 : 2.0) * rate_;
            const double excursion = mode_ == Mode::Modulated ? depth * std::max(0.0,
                std::min({rate_ * 0.012, time * 0.25, time - rate_ * 0.001, maxTime - time})) : 0.0;
            const double leftTime = time + excursion * std::sin(phase_);
            const double rightTime = time + excursion * std::cos(phase_);
            for (unsigned int repeat = 1U; repeat <= repeats_; ++repeat) {
                const float l = readAt(0U, write_ - repeat * leftTime);
                const float r = readAt(1U, write_ - repeat * rightTime);
                if (mode_ == Mode::Panning) {
                    if ((repeat % 2U) == 1U) left += gain * 0.5f * (l + r);
                    else right += gain * 0.5f * (l + r);
                } else { left += gain * l; right += gain * r; }
                gain *= 0.65f;
            }
        }
        frame[0] = bounded(left);
        if (channels > 1U) frame[1] = bounded(right);
        phase_ += 6.28318530717958647692 * 0.37 / rate_;
        if (phase_ >= 6.28318530717958647692) phase_ -= 6.28318530717958647692;
        valid_ = std::min(valid_ + 1U, history_[0].size() - 1U);
        if (++write_ == history_[0].size()) write_ = 0U;
        if (mode_ == Mode::Reverse && ++segmentPosition_ >= activeSegment_) {
            segmentHead_ = (segmentHead_ + 1U) % 16U;
            segmentStarts_[segmentHead_] = captureStart_;
            segmentLengths_[segmentHead_] = activeSegment_;
            completed_ = std::min(16U, completed_ + 1U);
            captureStart_ = write_;
            segmentPosition_ = 0U;
            activeSegment_ = static_cast<std::size_t>(std::llround(timeSamples_.target()));
        }
    }

private:
    static float bounded(float value) noexcept { return std::isfinite(value) ? std::clamp(value, -8.0f, 8.0f) : 0.0f; }
    void updateTime(std::uint64_t ramp) noexcept {
        const double seconds = time_ < 0.0f ? -time_ * 60.0 / bpm_ : time_ * 0.001;
        const float samples = static_cast<float>(std::clamp(seconds, 0.001, 3.0) * rate_);
        timeSamples_.setTarget(samples, ramp);
        if (valid_ == 0U) activeSegment_ = static_cast<std::size_t>(std::llround(samples));
    }
    float readAt(unsigned int channel, double position) const noexcept {
        const auto capacity = history_[channel].size();
        position = std::fmod(position, static_cast<double>(capacity));
        if (position < 0.0) position += capacity;
        const auto first = static_cast<std::size_t>(position);
        const float fraction = static_cast<float>(position - first);
        const auto sample = [&](std::size_t index) noexcept {
            const auto age = (write_ + capacity - index) % capacity;
            return age <= valid_ ? history_[channel][index] : 0.0f;
        };
        const float a = sample(first), b = sample((first + 1U) % capacity);
        return a + (b - a) * fraction;
    }
    Mode mode_;
    unsigned int rate_ = 48000U, repeats_ = 16U, completed_ = 0U;
    float time_ = 200.0f, bpm_ = 120.0f;
    dsp::ParameterSmoother timeSamples_{9600.0f}, depth_{0.5f};
    std::array<std::vector<float>, 2U> history_{};
    std::array<std::size_t, 16U> segmentStarts_{}, segmentLengths_{};
    std::size_t write_ = 0U, valid_ = 0U, activeSegment_ = 9600U, segmentPosition_ = 0U, captureStart_ = 0U, segmentHead_ = 0U;
    double phase_ = 0.0;
};
} // namespace webrc::native
