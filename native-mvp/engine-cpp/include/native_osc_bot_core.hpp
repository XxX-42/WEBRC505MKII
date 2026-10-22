#pragma once

#include "native_vocoder_core.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace webrc::native {

// OSC BOT's carrier-bank and step-sequencer storage is deliberately fixed-size.
inline constexpr std::size_t kNativeOscBotPatternCount = 8U;
inline constexpr std::size_t kNativeOscBotStepsPerPattern = 8U;
inline constexpr std::size_t kNativeOscBotMaxBands = kNativeVocoderMaxBands;

enum class NativeOscBotWaveform : std::uint8_t {
    Saw = 0U,
    Square = 1U,
    Triangle = 2U,
};

struct NativeOscBotConfig {
    std::size_t bands = kNativeVocoderDefaultBands;
    NativeOscBotWaveform waveform = NativeOscBotWaveform::Square;
    int pattern = 0;
    float toneCutoffHz = 3000.0f;
    float tempoBpm = 120.0f;
    // Linear wet amount in [0, 1]. The catalog-facing `mix` parameter is percent.
    float wetMix = 0.70f;
    bool enabled = true;
};

// Clean-room, sample-clocked OSC BOT voice. Every ERB band has its own
// polyBLEP carrier, modulator envelope and carrier band-pass. The authored
// eight-step patterns transpose the bank in semitones at sixteenth-note
// boundaries. This is a perceptual reconstruction, not factory firmware.
//
// The object is single-owner: prepare/configuration/reset and process must not
// race. All DSP storage is bounded and process methods allocate nothing.
class NativeOscBotCore final {
public:
    [[nodiscard]] bool prepare(std::uint32_t sampleRate,
                               std::uint64_t firstFrame = 0U) noexcept;
    [[nodiscard]] bool setConfig(const NativeOscBotConfig& config) noexcept;
    // Additive manual IDs: official_osc/tone/attack/note/mod_sens/balance.
    // In manual mode NOTE is a fixed carrier pitch, not a legacy pattern step.
    // IDs: bands (8..24), waveform (0..2), pattern (0..7), tone (100..16000 Hz),
    // tempo/bpm (30..300 BPM), and mix (0..100 percent). Only mix is ramped.
    [[nodiscard]] bool setParameter(std::string_view parameterId, float value,
                                    std::uint64_t rampFrames = 0U) noexcept;
    void reset() noexcept;

    [[nodiscard]] float processSample(float input) noexcept;
    [[nodiscard]] bool processMono(const float* input, float* output,
                                   std::size_t frames) noexcept;
    [[nodiscard]] bool processStereo(const float* interleavedInput,
                                     float* interleavedOutput,
                                     std::size_t frames) noexcept;
    [[nodiscard]] bool processInPlace(float* interleaved, std::size_t frames,
                                      std::size_t channels) noexcept;

    [[nodiscard]] const NativeOscBotConfig& config() const noexcept { return config_; }
    [[nodiscard]] std::uint32_t sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool prepared() const noexcept { return sampleRate_ != 0U; }
    // Absolute frame to be processed next.
    [[nodiscard]] std::uint64_t currentFrame() const noexcept { return frameClock_; }
    [[nodiscard]] std::size_t stepIndex() const noexcept { return activeStep_; }
    [[nodiscard]] std::uint64_t stepFrames() const noexcept { return stepFrames_; }
    [[nodiscard]] const NativeVocoderFilterBank& filterBank() const noexcept {
        return filterBank_;
    }

private:
    struct ToneFilter final {
        double a1 = 1.0;
        double a2 = 0.0;
        double a3 = 0.0;
        double k = 1.0 / 2.2;
        double integrator1 = 0.0;
        double integrator2 = 0.0;

        [[nodiscard]] bool configure(std::uint32_t sampleRate, float cutoffHz) noexcept;
        void reset() noexcept;
        [[nodiscard]] float process(float input) noexcept;
    };

    [[nodiscard]] static bool validWaveform(NativeOscBotWaveform waveform) noexcept;
    [[nodiscard]] static bool validTone(float value, std::uint32_t sampleRate) noexcept;
    [[nodiscard]] static bool validTempo(float value) noexcept;
    [[nodiscard]] static bool integral(float value) noexcept;
    [[nodiscard]] static float boundedInput(float value) noexcept;
    [[nodiscard]] static float boundedOutput(double value) noexcept;
    [[nodiscard]] static std::uint64_t computeStepFrames(std::uint32_t sampleRate,
                                                         float tempoBpm) noexcept;
    [[nodiscard]] bool processFrame(float modulator, float dryLeft, float dryRight,
                                    float* outputLeft, float* outputRight) noexcept;
    [[nodiscard]] float processWet(float modulator) noexcept;
    [[nodiscard]] float nextWetMix() noexcept;
    void advanceStepIfDue() noexcept;
    void updateCarrierBank() noexcept;

    std::uint32_t sampleRate_ = 0U;
    NativeOscBotConfig config_{};
    NativeVocoderOfficialShaping official_{};
    NativeOfficialVocoderOscillator officialOscillator_{};
    unsigned int officialWaveform_ = 0U;
    unsigned int officialNote_ = 36U; // C2, MIDI numbering with C4 = 60.
    NativeVocoderFilterBank filterBank_{};
    std::array<NativeVocoderOscillator, kNativeOscBotMaxBands> oscillators_{};
    std::array<bool, kNativeOscBotMaxBands> oscillatorPrepared_{};
    std::array<float, kNativeOscBotMaxBands> triangleIntegrators_{};
    std::array<float, kNativeOscBotMaxBands> bandCarriers_{};
    ToneFilter toneFilter_{};
    std::uint64_t frameClock_ = 0U;
    std::uint64_t initialFrame_ = 0U;
    std::uint64_t stepFrames_ = 1U;
    std::uint64_t framesUntilStep_ = 1U;
    std::size_t activeStep_ = 0U;
    float wetMixCurrent_ = 0.70f;
    float wetMixTarget_ = 0.70f;
    double wetMixStep_ = 0.0;
    std::uint64_t wetMixRampRemaining_ = 0U;
};

} // namespace webrc::native
