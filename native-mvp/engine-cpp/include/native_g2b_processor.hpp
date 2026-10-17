#pragma once

#include "native_fx_catalog.hpp"

#include <array>
#include <cstddef>
#include <string_view>

namespace webrc::native {

// Provisional clean-room G2B-style monophonic sub-octave processor. It uses a
// short YIN/CMND tracker to estimate the input fundamental, explicitly
// resynthesizes a band-limited square wave at half that frequency, filters it
// with a body low-pass, then blends it with the dry input. It is not a Roland
// model and has not passed sound-quality acceptance.
class NativeG2BProcessor final : public NativeEffectProcessor {
public:
    explicit NativeG2BProcessor(const NativeEffectDescriptor& descriptor) noexcept;

    // Worst-case tracker startup/update delay: one full analysis window plus
    // one hop. This is the delay before a new estimate can drive the wet path,
    // not a compensated dry-path latency.
    [[nodiscard]] unsigned int trackingLatencyUpperBoundSamples() const noexcept;

private:
    static constexpr std::size_t kAnalysisWindow = 512U;
    static constexpr unsigned int kMinimumLag = 7U;
    static constexpr unsigned int kMaximumLag = 300U;
    static constexpr unsigned int kTrackerHop = 96U;

    std::array<float, kAnalysisWindow> trackerRing_{};
    std::array<double, kMaximumLag + 1U> difference_{};
    std::array<double, kMaximumLag + 1U> cmnd_{};
    dsp::ParameterSmoother trackingPercent_{65.0f};
    dsp::ParameterSmoother blendPercent_{65.0f};
    dsp::ParameterSmoother bodyHz_{180.0f};
    dsp::TptStateVariableFilter bodyFilter_{};
    std::size_t trackerWrite_ = 0U;
    std::size_t trackerCount_ = 0U;
    unsigned int decimationFactor_ = 1U;
    unsigned int decimationPhase_ = 0U;
    unsigned int trackerHopCount_ = 0U;
    unsigned int filterUpdateCount_ = 0U;
    unsigned int trackerRate_ = 0U;
    double decimatorState_ = 0.0;
    double envelope_ = 0.0;
    double attackCoefficient_ = 0.0;
    double releaseCoefficient_ = 0.0;
    double oscillatorPhase_ = 0.0;
    float trackedHz_ = 0.0f;

    [[nodiscard]] bool configureBodyFilter(float cutoffHz) noexcept;
    [[nodiscard]] double inputGate(float trackingPercent) const noexcept;
    void pushTrackerSample(float sample, float trackingPercent) noexcept;
    [[nodiscard]] bool onPrepare() noexcept override;
    [[nodiscard]] bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept override;
    void onResetState() noexcept override;
    void processEffectFrame(float* frame, unsigned int channels) noexcept override;
};

} // namespace webrc::native
