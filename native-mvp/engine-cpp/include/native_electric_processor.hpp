#pragma once

#include "native_fx_catalog.hpp"
#include "native_vocoder_core.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace webrc::native {

// Clean-room ELECTRIC voice-character reconstruction. Classic and Metallic
// use a bounded YIN/CMND tracker and fall back to dry audio until pitch
// confidence locks. Vocoder and Bit crush are pitch-independent: they work on
// unvoiced material, while silence produces silence (the vocoder has a short
// envelope release). This is not Roland DSP or a quality-admitted model.
class NativeElectricProcessor final : public NativeEffectProcessor {
public:
    enum class Character : std::uint8_t {
        Classic = 0U,
        Metallic = 1U,
        Vocoder = 2U,
        BitCrush = 3U,
    };

    enum class PitchStatus : std::uint8_t {
        Unprepared = 0U,
        InsufficientLevel,
        LowConfidence,
        Acquiring,
        Tracking,
    };

    static constexpr float kMinimumPitchConfidence = 0.78f;
    static constexpr float kMinimumTrackedHz = 60.0f;
    static constexpr float kMaximumTrackedHz = 1200.0f;
    static constexpr unsigned int kPitchLockAnalyses = 2U;
    static constexpr unsigned int kPitchDropAnalyses = 2U;

    explicit NativeElectricProcessor(const NativeEffectDescriptor& descriptor) noexcept;

    [[nodiscard]] Character character() const noexcept { return character_; }
    [[nodiscard]] PitchStatus pitchStatus() const noexcept { return pitchStatus_; }
    [[nodiscard]] bool pitchLocked() const noexcept { return pitchLocked_; }
    [[nodiscard]] float sourceFrequencyHz() const noexcept { return pitchLocked() ? trackedHz_ : 0.0f; }
    [[nodiscard]] float pitchConfidence() const noexcept { return trackerConfidence_; }
    [[nodiscard]] float snappedFrequencyHz() const noexcept { return snappedHz_; }
    [[nodiscard]] float effectiveFrequencyHz() const noexcept { return effectiveHz_; }
    [[nodiscard]] unsigned int trackerRate() const noexcept { return trackerRate_; }
    [[nodiscard]] unsigned int trackingLatencyUpperBoundSamples() const noexcept;

private:
    static constexpr std::size_t kAnalysisWindow = 512U;
    static constexpr unsigned int kMaximumLag = 256U;
    static constexpr unsigned int kTrackerHop = 64U;
    static constexpr std::size_t kVocoderBands = kNativeVocoderDefaultBands;
    static constexpr double kTwoPi = 6.283185307179586476925286766559;

    std::array<float, kAnalysisWindow> trackerRing_{};
    std::array<double, kMaximumLag + 1U> differences_{};
    std::array<double, kMaximumLag + 1U> normalizedDifferences_{};
    std::array<NativeVocoderOscillator, kNativeVocoderMaxBands> vocoderOscillators_{};
    std::array<float, kNativeVocoderMaxBands> vocoderCarriers_{};
    std::array<dsp::TptStateVariableFilter, 2U> toneFilters_{};
    dsp::ParameterSmoother pitchSnapPercent_{50.0f};
    dsp::ParameterSmoother toneHz_{5000.0f};
    dsp::ParameterSmoother mixPercent_{70.0f};
    NativeVocoderFilterBank vocoderFilterBank_{};

    Character character_ = Character::Classic;
    PitchStatus pitchStatus_ = PitchStatus::Unprepared;
    std::size_t trackerWrite_ = 0U;
    std::size_t trackerCount_ = 0U;
    unsigned int trackerRate_ = 0U;
    unsigned int minimumLag_ = 0U;
    unsigned int maximumLag_ = 0U;
    unsigned int decimationFactor_ = 1U;
    unsigned int decimationPhase_ = 0U;
    unsigned int trackerHopCount_ = 0U;
    unsigned int goodAnalyses_ = 0U;
    unsigned int badAnalyses_ = 0U;
    unsigned int filterUpdateCount_ = 0U;
    unsigned int vocoderOscillatorCount_ = 0U;
    double decimatorSum_ = 0.0;
    double envelope_ = 0.0;
    double envelopeAttackCoefficient_ = 0.0;
    double envelopeReleaseCoefficient_ = 0.0;
    double oscillatorPhase_ = 0.0;
    double oscillatorFrequencyCoefficient_ = 0.0;
    double smoothedOscillatorHz_ = 0.0;
    double crushPhase_ = 0.0;
    float trackedHz_ = 0.0f;
    float trackerConfidence_ = 0.0f;
    float snappedHz_ = 0.0f;
    float effectiveHz_ = 0.0f;
    float heldLeft_ = 0.0f;
    float heldRight_ = 0.0f;
    bool pitchLocked_ = false;
    bool officialActive_ = false;
    float officialShift_ = 0.0f;
    float officialFormant_ = 0.0f;
    float officialSpeed_ = 5.0f;
    float officialStability_ = 0.0f;
    unsigned int officialScale_ = 0U;
    int officialTargetMidi_ = -1;
    std::array<float, 24U> officialHarmonicWeights_{};
    float officialHarmonicNormalization_ = 1.0f;
    unsigned int officialHarmonicCounter_ = 0U;
    unsigned int officialPitchCounter_ = 0U;

    [[nodiscard]] bool configureToneFilters(float cutoffHz) noexcept;
    [[nodiscard]] bool configureVocoder() noexcept;
    void pushTrackerSample(float sample) noexcept;
    void analyzePitchFrame() noexcept;
    void resetPitchTracker() noexcept;
    void resetCharacterState() noexcept;
    [[nodiscard]] float filteredTone(float sample, unsigned int channel) noexcept;
    [[nodiscard]] float vocoderSample(float mono) noexcept;
    [[nodiscard]] float crushSample(float sample) const noexcept;
    [[nodiscard]] float officialSnappedFrequency(float frequencyHz) noexcept;
    [[nodiscard]] float officialCarrier(double phase, double frequencyHz) noexcept;
    void updateOfficialResponse() noexcept;

    [[nodiscard]] bool onPrepare() noexcept override;
    [[nodiscard]] bool onSetParameter(std::string_view parameterId, float value,
                                      std::uint64_t rampFrames) noexcept override;
    void onResetState() noexcept override;
    void processEffectFrame(float* frame, unsigned int channels) noexcept override;
};

} // namespace webrc::native
