#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::native {

inline constexpr std::size_t kNativeVocoderMaxBands = 24U;
inline constexpr std::size_t kNativeVocoderDefaultBands = 16U;

enum class NativeVocoderCarrier : std::uint8_t {
    VoiceInput = 0U,
    Saw = 1U,
    Square = 2U,
};

enum class NativeVocoderWaveform : std::uint8_t {
    Saw = 0U,
    Square = 1U,
};

struct NativeVocoderConfig {
    std::size_t bands = kNativeVocoderDefaultBands;
    NativeVocoderCarrier carrier = NativeVocoderCarrier::VoiceInput;
    float wetMix = 1.0f;
    // Formant translation is intentionally unsupported by this filterbank.
    // Non-zero requests are rejected rather than approximated.
    float formantShiftSemitones = 0.0f;
    bool enabled = true;
};

// A small sample-clocked polyBLEP oscillator. It is also useful to future
// MIDI-driven carrier banks, which can share the vocoder's analyzer/filterbank.
class NativeVocoderOscillator final {
public:
    [[nodiscard]] bool prepare(std::uint32_t sampleRate, float frequencyHz,
                               NativeVocoderWaveform waveform) noexcept;
    [[nodiscard]] bool setFrequency(float frequencyHz) noexcept;
    [[nodiscard]] bool setWaveform(NativeVocoderWaveform waveform) noexcept;
    void reset(double phase = 0.0) noexcept;
    [[nodiscard]] float processSample() noexcept;

    [[nodiscard]] float frequencyHz() const noexcept { return frequencyHz_; }
    [[nodiscard]] double phase() const noexcept { return phase_; }

private:
    [[nodiscard]] static float polyBlep(double phase, double phaseIncrement) noexcept;

    std::uint32_t sampleRate_ = 0U;
    float frequencyHz_ = 0.0f;
    double phase_ = 0.0;
    NativeVocoderWaveform waveform_ = NativeVocoderWaveform::Saw;
};

// Reusable analysis and carrier filterbank. Analyze one modulator sample, then
// use its envelopes with an external per-band carrier (e.g. MIDI oscillators),
// or filter a voice carrier through matching bands before synthesis. No method
// allocates; storage is fixed at kNativeVocoderMaxBands.
class NativeVocoderFilterBank final {
public:
    [[nodiscard]] bool prepare(std::uint32_t sampleRate,
                               std::size_t bandCount = kNativeVocoderDefaultBands) noexcept;
    void reset() noexcept;
    void analyzeModulatorSample(float sample) noexcept;
    [[nodiscard]] float filterCarrierSample(std::size_t band, float sample) noexcept;
    [[nodiscard]] float synthesizeSample(const float* bandCarriers,
                                         std::size_t carrierCount) const noexcept;

    [[nodiscard]] std::size_t bandCount() const noexcept { return bandCount_; }
    [[nodiscard]] std::uint32_t sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] float centerFrequencyHz(std::size_t band) const noexcept;
    [[nodiscard]] float envelope(std::size_t band) const noexcept;
    [[nodiscard]] const std::array<float, kNativeVocoderMaxBands>& envelopes() const noexcept {
        return envelopes_;
    }

private:
    struct BandPass final {
        double b0 = 0.0;
        double b1 = 0.0;
        double b2 = 0.0;
        double a1 = 0.0;
        double a2 = 0.0;
        double z1 = 0.0;
        double z2 = 0.0;

        void configure(double sampleRate, double centerHz, double q) noexcept;
        void reset() noexcept;
        [[nodiscard]] float process(float sample) noexcept;
    };

    std::uint32_t sampleRate_ = 0U;
    std::size_t bandCount_ = 0U;
    std::array<float, kNativeVocoderMaxBands> centers_{};
    std::array<float, kNativeVocoderMaxBands> envelopes_{};
    std::array<BandPass, kNativeVocoderMaxBands> modulatorFilters_{};
    std::array<BandPass, kNativeVocoderMaxBands> carrierFilters_{};
    double attackCoefficient_ = 0.0;
    double releaseCoefficient_ = 0.0;
};

// Mono, clean-room vocoder core. `modulator` is always the dry input. In
// VoiceInput mode, a null `voiceCarrier` uses the modulator as the carrier;
// otherwise it is the independent carrier signal. For Saw/Square modes,
// `voiceCarrier` is ignored. Arbitrary block sizes and in-place output are
// supported. The object is single-owner and its process path does not allocate.
class NativeVocoderCore final {
public:
    [[nodiscard]] bool prepare(std::uint32_t sampleRate) noexcept;
    [[nodiscard]] bool setConfig(const NativeVocoderConfig& config) noexcept;
    void reset() noexcept;
    [[nodiscard]] bool process(const float* modulator,
                               const float* voiceCarrier,
                               float* output,
                               std::size_t frames) noexcept;

    [[nodiscard]] const NativeVocoderConfig& config() const noexcept { return config_; }
    [[nodiscard]] const NativeVocoderFilterBank& filterBank() const noexcept { return filterBank_; }
    [[nodiscard]] NativeVocoderFilterBank& filterBank() noexcept { return filterBank_; }
    [[nodiscard]] std::uint32_t sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] bool prepared() const noexcept { return sampleRate_ != 0U; }

private:
    [[nodiscard]] bool configureOscillators() noexcept;

    std::uint32_t sampleRate_ = 0U;
    NativeVocoderConfig config_{};
    NativeVocoderFilterBank filterBank_{};
    std::array<NativeVocoderOscillator, kNativeVocoderMaxBands> oscillators_{};
    std::array<float, kNativeVocoderMaxBands> bandCarriers_{};
};

} // namespace webrc::native
