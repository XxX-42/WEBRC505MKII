#include "webrc/dsp/live_mono_pitch.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace webrc::dsp {
namespace {

std::uint32_t maximumPeriodSamples(const LiveMonoPitchSettings& settings) noexcept {
    if (!std::isfinite(settings.spec.sampleRate) || !std::isfinite(settings.minimumFrequencyHz) ||
        settings.minimumFrequencyHz <= 0.0f) return 0U;
    const double period = std::ceil(static_cast<double>(settings.spec.sampleRate) /
                                    settings.minimumFrequencyHz);
    if (!std::isfinite(period) || period < 4.0 || period > 8192.0) return 0U;
    return static_cast<std::uint32_t>(period);
}

} // namespace

std::size_t LiveMonoPitchRoute::requiredPrepareBytes(
    const LiveMonoPitchSettings& settings) noexcept {
    if (!validProcessSpec(settings.spec) || settings.spec.channels != 1U ||
        settings.spec.sampleRate > 192000.0f ||
        !std::isfinite(settings.yinThreshold) || settings.yinThreshold <= 0.0f ||
        settings.yinThreshold >= 1.0f || settings.analysisHopFrames == 0U ||
        settings.analysisHopFrames > settings.analysisWindowFrames) return 0U;
    const auto yinBytes = IncrementalYinDetector::requiredPrepareBytes(
        settings.spec, settings.analysisWindowFrames, settings.minimumFrequencyHz,
        settings.maximumFrequencyHz, settings.analysisWorkUnitsPerCallback);
    const auto maximumPeriod = maximumPeriodSamples(settings);
    const auto shifterBytes = StreamingTdPsolaPitchShifter::requiredPrepareBytes(
        settings.spec, maximumPeriod);
    if (yinBytes == 0U || shifterBytes == 0U ||
        yinBytes > std::numeric_limits<std::size_t>::max() - shifterBytes) return 0U;
    if (yinBytes + shifterBytes > std::numeric_limits<std::size_t>::max() - sizeof(LiveMonoPitchRoute))
        return 0U;
    return sizeof(LiveMonoPitchRoute) + yinBytes + shifterBytes;
}

bool LiveMonoPitchRoute::prepare(const LiveMonoPitchSettings& settings) {
    if (requiredPrepareBytes(settings) == 0U) return false;
    const auto maximumPeriod = maximumPeriodSamples(settings);
    IncrementalYinDetector candidateDetector;
    StreamingTdPsolaPitchShifter candidateShifter;
    if (!candidateDetector.prepare(settings.spec, settings.analysisWindowFrames,
                                  settings.minimumFrequencyHz, settings.maximumFrequencyHz,
                                  settings.yinThreshold, settings.analysisHopFrames,
                                  settings.analysisWorkUnitsPerCallback) ||
        !candidateShifter.prepare(settings.spec, maximumPeriod)) return false;
    detector_ = std::move(candidateDetector);
    shifter_ = std::move(candidateShifter);
    settings_ = settings;
    pitchRatio_ = 1.0f;
    forwardedAnalysisCount_ = 0U;
    prepared_ = true;
    return true;
}

void LiveMonoPitchRoute::reset() noexcept {
    if (!prepared_) return;
    detector_.reset();
    shifter_.reset();
    pitchRatio_ = 1.0f;
    forwardedAnalysisCount_ = 0U;
}

bool LiveMonoPitchRoute::setPitchRatio(float ratio) noexcept {
    if (!prepared_ || !std::isfinite(ratio) || ratio < 0.5f || ratio > 2.0f) return false;
    const auto& estimate = detector_.latestEstimate();
    if (detector_.analysisCount() != 0U &&
        !shifter_.setPitchEstimate(estimate, ratio)) return false;
    pitchRatio_ = ratio;
    return true;
}

bool LiveMonoPitchRoute::processBlock(const float* monoInput, float* monoOutput,
                                     std::uint32_t frames) noexcept {
    if (!prepared_ || monoInput == nullptr || monoOutput == nullptr || frames == 0U ||
        frames > settings_.spec.maxBlockFrames) return false;
    if (!detector_.processBlock(monoInput, frames)) return false;
    if (detector_.analysisCount() != forwardedAnalysisCount_) {
        if (!shifter_.setPitchEstimate(detector_.latestEstimate(), pitchRatio_)) return false;
        forwardedAnalysisCount_ = detector_.analysisCount();
    }
    return shifter_.processBlock(monoInput, monoOutput, frames);
}

std::uint32_t LiveMonoPitchRoute::latestEstimateAgeFrames() const noexcept {
    if (!prepared_ || detector_.analysisCount() == 0U) return 0U;
    const auto now = detector_.totalInputFrames();
    const auto end = detector_.latestWindowEndFrame();
    const auto age = now >= end ? now - end : 0U;
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(
        age, std::numeric_limits<std::uint32_t>::max()));
}

} // namespace webrc::dsp
