#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

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

// Authored, control-compatible oscillator colors. These five algorithms are
// clean-room choices, not models of the manufacturer's factory waveforms.
// The legacy oscillator and its enum remain unchanged.
class NativeOfficialVocoderOscillator final {
public:
    [[nodiscard]] bool prepare(std::uint32_t sampleRate, float frequencyHz,
                               unsigned int waveform) noexcept;
    [[nodiscard]] bool setFrequency(float frequencyHz) noexcept;
    [[nodiscard]] bool setWaveform(unsigned int waveform) noexcept;
    void reset() noexcept;
    [[nodiscard]] float processSample() noexcept;
private:
    NativeVocoderOscillator first_{};
    NativeVocoderOscillator second_{};
    std::uint32_t sampleRate_ = 0U;
    unsigned int waveform_ = 0U;
    float frequencyHz_ = 0.0f;
    double vintageLow_ = 0.0;
    double vintageCoefficient_ = 0.0;
};

// Shared authored tone tilt, modulator input gain and envelope-time laws.
// Constructing/preparing this object never opts an old project into new DSP.
class NativeVocoderOfficialShaping final {
public:
    void prepare(std::uint32_t sampleRate) noexcept;
    void activate(std::string_view effect) noexcept;
    [[nodiscard]] bool setParameter(std::string_view effect,
                                    std::string_view key, float value) noexcept;
    void reset() noexcept { toneLow_ = 0.0; }
    [[nodiscard]] bool active() const noexcept { return active_; }
    [[nodiscard]] float modulator(float sample) const noexcept;
    [[nodiscard]] float tone(float sample) noexcept;
    [[nodiscard]] float attackSeconds() const noexcept;
    [[nodiscard]] float releaseSeconds() const noexcept;
private:
    bool active_ = false;
    float tone_ = 0.0f;
    float attack_ = 50.0f;
    float release_ = 50.0f;
    float sensitivityGain_ = 1.0f;
    double toneCoefficient_ = 0.0;
    double toneLow_ = 0.0;
    double lowGain_ = 1.0;
    double highGain_ = 1.0;
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
    [[nodiscard]] bool setEnvelopeTimes(float attackSeconds, float releaseSeconds) noexcept;
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
    // Supported manual controls: tone, attack, mod_sens and balance. Carrier
    // bus selection/thru deliberately remain unsupported until real buses exist.
    [[nodiscard]] bool setParameter(std::string_view parameterId, float value) noexcept;
    [[nodiscard]] bool officialControlsActive() const noexcept { return official_.active(); }
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
    NativeVocoderOfficialShaping official_{};
    NativeVocoderFilterBank filterBank_{};
    std::array<NativeVocoderOscillator, kNativeVocoderMaxBands> oscillators_{};
    std::array<float, kNativeVocoderMaxBands> bandCarriers_{};
};

} // namespace webrc::native
