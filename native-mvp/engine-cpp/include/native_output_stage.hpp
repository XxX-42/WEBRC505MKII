#pragma once

#include "dsp_primitives.hpp"
#include "native_fx_catalog.hpp"
#include "native_chorus_processor.hpp"
#include "native_fdn16_reverb_processor.hpp"
#include "native_phaser_processor.hpp"
#include "native_pitch_processor.hpp"
#include "native_poly_pitch_processor.hpp"
#include "looper_core.hpp"
#include "native_rhythm_engine.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::native {

enum class NativeOutputEffect : std::uint8_t {
    LowPass = 0,
    HighPass,
};

struct NativeReverbConfig {
    bool enabled = false;
    float wetMix = 0.25f;
    float rt60Seconds = 2.0f;
    float dampingCutoffHz = 7000.0f;
};

enum class NativeTrackOutputSlot : std::uint8_t {
    A = 0,
    B,
    C,
    D,
};

enum class NativeFractionalDelayAlgorithm : std::uint8_t {
    Lagrange4 = 0,
};

// The Native MVP has one LooperCore route. Slot A names that live route in the
// shared A-D bank; B-D remain inactive until a multi-track Native engine exists.
struct NativeTrackOutputBank {
    static constexpr std::array<const char*, 4> kSlotNames{{"A", "B", "C", "D"}};
    static constexpr std::array<bool, 4> kActiveSlots{{true, false, false, false}};

    [[nodiscard]] static constexpr bool isActive(NativeTrackOutputSlot slot) noexcept {
        return slot == NativeTrackOutputSlot::A;
    }
};

struct NativeFractionalDelayConfig {
    bool enabled = false;
    NativeTrackOutputSlot slot = NativeTrackOutputSlot::A;
    NativeFractionalDelayAlgorithm algorithm = NativeFractionalDelayAlgorithm::Lagrange4;
    float delayMs = 350.0f;
    float wetMix = 0.3f;
    float feedback = 0.35f;
};

enum class NativeCompressorAlgorithm : std::uint8_t {
    PeakCompressor = 0,
};

struct NativeCompressorConfig {
    bool enabled = false;
    NativeTrackOutputSlot slot = NativeTrackOutputSlot::A;
    NativeCompressorAlgorithm algorithm = NativeCompressorAlgorithm::PeakCompressor;
    float thresholdDb = -18.0f;
    float ratio = 4.0f;
    float attackMs = 10.0f;
    float releaseMs = 120.0f;
    float wetMix = 1.0f;
    float makeupDb = 0.0f;
};

enum class NativeChorusAlgorithm : std::uint8_t {
    StereoLfoLagrange4 = 0,
};

struct NativeChorusConfig {
    bool enabled = false;
    NativeTrackOutputSlot slot = NativeTrackOutputSlot::A;
    NativeChorusAlgorithm algorithm = NativeChorusAlgorithm::StereoLfoLagrange4;
    float rateHz = 0.8f;
    float depthMs = 5.0f;
    float feedback = 0.0f;
    float wetMix = 0.25f;
};

enum class NativePhaserAlgorithm : std::uint8_t {
    AllpassSweep = 0,
};

struct NativePhaserConfig {
    bool enabled = false;
    NativeTrackOutputSlot slot = NativeTrackOutputSlot::A;
    NativePhaserAlgorithm algorithm = NativePhaserAlgorithm::AllpassSweep;
    unsigned int stages = 8U;
    float rateHz = 0.5f;
    float depth = 0.65f;
    float feedback = 0.0f;
    float wetMix = 0.5f;
};

// Output post-stage for the native looper. LP/HP state is fixed-size; FDN16
// delay storage is allocated only by prepare(). Recording and overdub buffers
// stay dry because this stage runs after LooperCore processes each block.
class NativeOutputStage final {
public:
    static constexpr unsigned int kMaxProcessFrames = 4096U;

    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    void setLowPassEnabled(bool enabled, std::uint64_t rampFrames = 64) noexcept;
    void setHighPassEnabled(bool enabled, std::uint64_t rampFrames = 64) noexcept;
    void setEffectEnabled(NativeOutputEffect effect, bool enabled, std::uint64_t rampFrames = 64) noexcept;
    [[nodiscard]] bool setReverbConfig(const NativeReverbConfig& config, std::uint64_t rampFrames = 64) noexcept;
    [[nodiscard]] bool setFractionalDelayConfig(const NativeFractionalDelayConfig& config, std::uint64_t rampFrames = 64) noexcept;
    [[nodiscard]] bool setCompressorConfig(const NativeCompressorConfig& config, std::uint64_t rampFrames = 64) noexcept;
    [[nodiscard]] bool setChorusConfig(const NativeChorusConfig& config, std::uint64_t rampFrames = 64) noexcept;
    [[nodiscard]] bool setPhaserConfig(const NativePhaserConfig& config, std::uint64_t rampFrames = 64) noexcept;

    // Processes the first two output channels in-place and returns the post-FX
    // peak. Channels beyond stereo are passed through unchanged.
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

    [[nodiscard]] bool lowPassEnabled() const noexcept { return lowPassEnabled_; }
    [[nodiscard]] bool highPassEnabled() const noexcept { return highPassEnabled_; }
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] NativeEffectBank& trackFxBank() noexcept { return trackFxBank_; }
    [[nodiscard]] const NativeEffectBank& trackFxBank() const noexcept { return trackFxBank_; }
    [[nodiscard]] float* playbackOnlyScratch() noexcept { return playbackOnlyScratch_.data(); }
    [[nodiscard]] bool reverbEnabled() const noexcept { return reverbConfig_.enabled; }
    [[nodiscard]] float reverbWetMix() const noexcept { return reverbConfig_.wetMix; }
    [[nodiscard]] float reverbRt60Seconds() const noexcept { return reverbConfig_.rt60Seconds; }
    [[nodiscard]] unsigned int reverbMinimumDelayFrames() const noexcept { return reverbProcessor_.lineDelayFrames(0U); }
    [[nodiscard]] static unsigned int reverbMinimumDelayFramesForSampleRate(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool fractionalDelayEnabled() const noexcept { return fractionalDelayConfig_.enabled; }
    [[nodiscard]] float fractionalDelayMs() const noexcept { return fractionalDelayConfig_.delayMs; }
    [[nodiscard]] float fractionalDelayWetMix() const noexcept { return fractionalDelayConfig_.wetMix; }
    [[nodiscard]] float fractionalDelayFeedback() const noexcept { return fractionalDelayConfig_.feedback; }
    [[nodiscard]] NativeTrackOutputSlot fractionalDelaySlot() const noexcept { return fractionalDelayConfig_.slot; }
    [[nodiscard]] bool compressorEnabled() const noexcept { return compressorConfig_.enabled; }
    [[nodiscard]] float compressorThresholdDb() const noexcept { return compressorConfig_.thresholdDb; }
    [[nodiscard]] float compressorRatio() const noexcept { return compressorConfig_.ratio; }
    [[nodiscard]] float compressorAttackMs() const noexcept { return compressorConfig_.attackMs; }
    [[nodiscard]] float compressorReleaseMs() const noexcept { return compressorConfig_.releaseMs; }
    [[nodiscard]] float compressorWetMix() const noexcept { return compressorConfig_.wetMix; }
    [[nodiscard]] float compressorMakeupDb() const noexcept { return compressorConfig_.makeupDb; }
    [[nodiscard]] NativeTrackOutputSlot compressorSlot() const noexcept { return compressorConfig_.slot; }
    [[nodiscard]] bool chorusEnabled() const noexcept { return chorusConfig_.enabled; }
    [[nodiscard]] NativeTrackOutputSlot chorusSlot() const noexcept { return chorusConfig_.slot; }
    [[nodiscard]] NativeChorusAlgorithm chorusAlgorithm() const noexcept { return chorusConfig_.algorithm; }
    [[nodiscard]] float chorusRateHz() const noexcept { return chorusConfig_.rateHz; }
    [[nodiscard]] float chorusDepthMs() const noexcept { return chorusConfig_.depthMs; }
    [[nodiscard]] float chorusFeedback() const noexcept { return chorusConfig_.feedback; }
    [[nodiscard]] float chorusWetMix() const noexcept { return chorusConfig_.wetMix; }
    [[nodiscard]] bool phaserEnabled() const noexcept { return phaserConfig_.enabled; }
    [[nodiscard]] NativeTrackOutputSlot phaserSlot() const noexcept { return phaserConfig_.slot; }
    [[nodiscard]] NativePhaserAlgorithm phaserAlgorithm() const noexcept { return phaserConfig_.algorithm; }
    [[nodiscard]] unsigned int phaserStages() const noexcept { return phaserConfig_.stages; }
    [[nodiscard]] float phaserRateHz() const noexcept { return phaserConfig_.rateHz; }
    [[nodiscard]] float phaserDepth() const noexcept { return phaserConfig_.depth; }
    [[nodiscard]] float phaserFeedback() const noexcept { return phaserConfig_.feedback; }
    [[nodiscard]] float phaserWetMix() const noexcept { return phaserConfig_.wetMix; }

private:
    static constexpr unsigned int kFilterChannels = 2;
    static constexpr float kMaximumDelaySeconds = 2.0f;

    std::array<dsp::Biquad, kFilterChannels> lowPassFilters_{};
    std::array<dsp::Biquad, kFilterChannels> highPassFilters_{};
    std::array<std::vector<float>, kFilterChannels> fractionalDelayBuffers_{};
    std::array<std::size_t, kFilterChannels> fractionalDelayWriteIndices_{};
    dsp::ParameterSmoother lowPassMix_{0.0f};
    dsp::ParameterSmoother highPassMix_{0.0f};
    dsp::ParameterSmoother fractionalDelayMix_{0.0f};
    dsp::ParameterSmoother fractionalDelayFeedback_{0.0f};
    dsp::ParameterSmoother fractionalDelayFrames_{16800.0f};
    dsp::ParameterSmoother compressorMix_{0.0f};
    std::size_t fractionalDelayMaximumFrames_ = 0;
    unsigned int sampleRate_ = 0;
    NativeReverbConfig reverbConfig_{};
    NativeFdn16ReverbProcessor reverbProcessor_{};
    NativeFractionalDelayConfig fractionalDelayConfig_{};
    NativeCompressorConfig compressorConfig_{};
    NativeChorusConfig chorusConfig_{};
    NativeChorusProcessor chorusProcessor_{};
    NativePhaserConfig phaserConfig_{};
    NativePhaserProcessor phaserProcessor_{};
    float compressorEnvelope_ = 0.0f;
    float compressorAttackCoefficient_ = 0.0f;
    float compressorReleaseCoefficient_ = 0.0f;
    float compressorThresholdAmplitude_ = 0.12589254f;
    float compressorRatioExponent_ = 0.75f;
    float compressorMakeupGain_ = 1.0f;
    bool lowPassEnabled_ = false;
    bool highPassEnabled_ = false;
    NativeEffectBank trackFxBank_{};
    std::array<float, kMaxProcessFrames * 2U> playbackOnlyScratch_{};

    void processFractionalDelay(float inputLeft, float inputRight, float& outputLeft, float& outputRight) noexcept;
    void updateCompressorParameters() noexcept;
    void processCompressor(float inputLeft, float inputRight, float& outputLeft, float& outputRight) noexcept;
};

// Common output route used by RtAudio callbacks and device-free tests: loop
// recording/overdub updates happen first, the selected A-D Track FX chain is
// applied only to loop playback, generated rhythm is mixed next, then explicit
// global output effects run without writing back into loop storage.
[[nodiscard]] ProcessStats processNativeAudioBlock(
    LooperCore& looper,
    NativeOutputStage& outputStage,
    const float* inputInterleaved,
    float* outputInterleaved,
    unsigned int frames,
    unsigned int inputChannels,
    unsigned int outputChannels,
    NativeRhythmEngine* rhythmEngine = nullptr,
    std::uint64_t startFrame = 0,
    NativeEffectBank* trackFxBank = nullptr,
    float* playbackOnlyInterleaved = nullptr,
    NativePitchProcessor* pitchProcessor = nullptr,
    bool pitchRequested = false,
    bool reversePlayback = false,
    NativePitchRouteDecision* pitchRouteDecision = nullptr,
    NativePolyPitchProcessor* polyPitchProcessor = nullptr,
    bool polyPitchMode = false
);

} // namespace webrc::native
