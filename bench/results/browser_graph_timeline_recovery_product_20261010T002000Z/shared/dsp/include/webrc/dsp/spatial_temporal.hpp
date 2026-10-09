#pragma once

#include "webrc/dsp/primitives.hpp"

#include <array>
#include <complex>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace webrc::dsp {

constexpr std::uint32_t kSpatialTemporalApiVersion = 1;
// Budget APIs include a fixed allocator/metadata allowance in addition to the
// signal payload. No-exception hosts must budget active + staged graphs before
// prepare(), because std::vector OOM is fail-fast on those toolchains.
constexpr std::size_t kPrepareAllocatorAllowanceBytes = 64U * 1024U;

// Heap-backed prepare() methods invalidate an existing instance while rebuilding.
// Build a fresh inactive instance, check its byte estimate and prepare result,
// then swap it into the graph away from the audio callback. Estimates include
// payload plus the allowance above; they are not a substitute for the host's
// total active+staged graph budget on no-exception runtimes.

// In-place orthonormal Walsh-Hadamard transform for 8/16-channel FDN state.
// A single 1/sqrt(N) normalization is applied after all butterfly stages.
[[nodiscard]] bool normalizedHadamard(float* values, std::uint32_t count) noexcept;

// prepare() allocates and invalidates an existing instance while rebuilding.
// Prepare a fresh inactive object and swap it into an audio graph only after
// success; no audio-thread construction or in-place graph replacement.
class PartitionedConvolver {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(std::uint32_t partitionFrames,
                                                          std::uint32_t impulseFrames) noexcept;
    // Uniform overlap-save FDL with four independently configurable matrix IRs:
    // LL/LR/RL/RR. Null IR pointers mean an all-zero branch. IR spectra and all
    // streaming buffers are allocated/precomputed here, never in processBlock.
    bool prepare(const ProcessSpec& spec, std::uint32_t partitionFrames,
                 std::uint32_t impulseFrames, const float* impulseLL,
                 const float* impulseLR, const float* impulseRL,
                 const float* impulseRR);
    void reset() noexcept;
    bool processBlock(const float* inputLeft, const float* inputRight,
                      float* outputLeft, float* outputRight,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t partitionFrames() const noexcept { return partitionFrames_; }
    [[nodiscard]] std::uint32_t impulseFrames() const noexcept { return impulseFrames_; }
    [[nodiscard]] std::uint32_t algorithmicLatencySamples() const noexcept { return partitionFrames_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }

private:
    void finishInputPartition() noexcept;

    ProcessSpec spec_{};
    std::uint32_t partitionFrames_ = 0;
    std::uint32_t fftFrames_ = 0;
    std::uint32_t impulseFrames_ = 0;
    std::uint32_t impulsePartitions_ = 0;
    std::uint32_t inputFill_ = 0;
    std::uint32_t outputRead_ = 0;
    std::uint32_t historyWrite_ = 0;
    bool prepared_ = false;
    std::array<std::vector<std::complex<float>>, 4> impulseSpectra_;
    std::array<std::vector<std::complex<float>>, 2> inputSpectrumHistory_;
    std::array<std::vector<std::complex<float>>, 2> fftScratch_;
    std::array<std::vector<std::complex<float>>, 2> sumScratch_;
    std::array<std::vector<float>, 2> previousInput_;
    std::array<std::vector<float>, 2> currentInput_;
    std::array<std::vector<float>, 2> outputQueue_;
};

enum class FdnLineCount : std::uint8_t {
    Eight = 8,
    Sixteen = 16,
};

class FdnReverb {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec,
                                                          FdnLineCount lineCount,
                                                          float maximumDelaySeconds = 0.12f) noexcept;
    bool prepare(const ProcessSpec& spec, FdnLineCount lineCount = FdnLineCount::Eight,
                 float maximumDelaySeconds = 0.12f);
    void reset() noexcept;
    bool setEarlyImpulseResponse(std::uint32_t frames, const float* ll,
                                 const float* lr, const float* rl,
                                 const float* rr) noexcept;
    bool setParameters(float rt60Seconds, float dampingHz, float modulationRateHz,
                       float modulationDepthMs, float maximumFeedback,
                       float wet, float smoothingMs = 20.0f) noexcept;
    [[nodiscard]] StereoFrame processSample(float inputLeft, float inputRight) noexcept;
    bool processBlock(const float* inputLeft, const float* inputRight,
                      float* outputLeft, float* outputRight,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] FdnLineCount lineCount() const noexcept { return lineCount_; }
    // No whole-sample buffer is inserted. Fractional-delay interpolation has
    // frequency-dependent small-signal group delay.
    [[nodiscard]] std::uint32_t algorithmicLatencySamples() const noexcept { return 0; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] float currentRt60Seconds() const noexcept { return currentRt60_; }

private:
    struct EarlyTap {
        std::uint32_t delay = 0;
        float ll = 0.0f;
        float lr = 0.0f;
        float rl = 0.0f;
        float rr = 0.0f;
    };

    [[nodiscard]] float readModulated(std::uint32_t line, double delay) const noexcept;
    [[nodiscard]] float readRing(const std::vector<float>& ring, std::uint32_t write,
                                 std::int64_t offset) const noexcept;
    void updateSmoothedParameters() noexcept;

    static constexpr std::size_t kMaximumLines = 16;
    static constexpr std::size_t kMaximumEarlyTaps = 64;
    static constexpr std::uint32_t kMaximumEarlyDelayMs = 100;
    ProcessSpec spec_{};
    FdnLineCount lineCount_ = FdnLineCount::Eight;
    std::uint32_t activeLines_ = 8;
    std::array<std::vector<float>, kMaximumLines> delayLines_;
    std::array<std::uint32_t, kMaximumLines> delayLengths_{};
    std::array<std::uint32_t, kMaximumLines> writePositions_{};
    std::array<float, kMaximumLines> dampingStates_{};
    std::array<float, kMaximumLines> targetFeedback_{};
    std::array<float, kMaximumLines> currentFeedback_{};
    std::array<double, kMaximumLines> modPhaseOffsetSin_{};
    std::array<double, kMaximumLines> modPhaseOffsetCos_{};
    std::vector<float> earlyLeftRing_;
    std::vector<float> earlyRightRing_;
    std::uint32_t earlyWritePosition_ = 0;
    std::array<EarlyTap, kMaximumEarlyTaps> earlyTaps_{};
    std::uint32_t earlyTapCount_ = 0;
    float targetRt60_ = 1.2f;
    float targetDampingHz_ = 8000.0f;
    float targetModRateHz_ = 0.17f;
    float targetModDepthMs_ = 0.15f;
    float targetMaximumFeedback_ = 0.9995f;
    float targetWet_ = 0.65f;
    float currentRt60_ = 1.2f;
    float currentDampingHz_ = 8000.0f;
    float currentModRateHz_ = 0.17f;
    float currentModDepthMs_ = 0.15f;
    float currentMaximumFeedback_ = 0.9995f;
    float currentWet_ = 0.65f;
    float targetDampingCoefficient_ = 0.0f;
    float currentDampingCoefficient_ = 0.0f;
    float parameterSmoothingCoefficient_ = 1.0f;
    double modulationSine_ = 0.0;
    double modulationCosine_ = 1.0;
    double modulationStepSine_ = 0.0;
    double modulationStepCosine_ = 1.0;
    std::uint32_t modulationStepCountdown_ = 0;
    std::uint32_t modulationRenormalizeCountdown_ = 0;
    bool prepared_ = false;
};

class GranularTexture {
public:
    static constexpr std::size_t kGrainCount = 32;
    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec,
                                                          float captureSeconds = 2.0f) noexcept;
    bool prepare(const ProcessSpec& spec, float captureSeconds = 2.0f);
    void reset() noexcept;
    bool setParameters(float grainMs, float densityHz, float pitchRatio,
                       float positionSpread, float mix, std::uint64_t seed) noexcept;
    [[nodiscard]] StereoFrame processSample(float inputLeft, float inputRight) noexcept;
    bool processBlock(const float* inputLeft, const float* inputRight,
                      float* outputLeft, float* outputRight,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t activeGrains() const noexcept;
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }

private:
    struct Grain {
        double readPosition = 0.0;
        double readStep = 1.0;
        std::uint32_t age = 0;
        std::uint32_t length = 0;
        float pan = 0.0f;
        bool active = false;
    };
    [[nodiscard]] std::uint32_t randomU32() noexcept;
    [[nodiscard]] float randomUnit() noexcept;
    void spawnGrain() noexcept;
    [[nodiscard]] float readCapture(const std::vector<float>& data, double position) const noexcept;

    ProcessSpec spec_{};
    std::vector<float> captureLeft_;
    std::vector<float> captureRight_;
    std::array<Grain, kGrainCount> grains_{};
    std::uint32_t captureWrite_ = 0;
    std::uint64_t capturedFrames_ = 0;
    std::uint64_t randomState_ = 0x9e3779b97f4a7c15ULL;
    std::uint32_t grainFrames_ = 2400;
    std::uint64_t seed_ = 0x9e3779b97f4a7c15ULL;
    double densityHz_ = 20.0;
    double densityPhase_ = 0.0;
    double pitchRatio_ = 1.0;
    float positionSpread_ = 0.5f;
    float mix_ = 1.0f;
    bool prepared_ = false;
};

class SpectralFreeze {
public:
    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec,
                                                          std::uint32_t windowFrames,
                                                          std::uint32_t hopFrames) noexcept;
    bool prepare(const ProcessSpec& spec, std::uint32_t windowFrames = 1024,
                 std::uint32_t hopFrames = 256);
    void reset() noexcept;
    bool setFreeze(bool freeze) noexcept;
    bool setMix(float mix) noexcept;
    [[nodiscard]] StereoFrame processSample(float inputLeft, float inputRight) noexcept;
    bool processBlock(const float* inputLeft, const float* inputRight,
                      float* outputLeft, float* outputRight,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t windowFrames() const noexcept { return windowFrames_; }
    [[nodiscard]] std::uint32_t hopFrames() const noexcept { return hopFrames_; }
    [[nodiscard]] std::uint32_t algorithmicLatencySamples() const noexcept { return windowFrames_; }
    [[nodiscard]] bool frozen() const noexcept { return freezeRequested_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }

private:
    struct ChannelState {
        std::vector<float> inputRing;
        std::vector<float> outputOverlap;
        std::vector<float> delayedDry;
        std::vector<std::complex<float>> spectrum;
        std::vector<std::complex<float>> frozenSpectrum;
        std::vector<float> magnitude;
        std::vector<float> frozenMagnitude;
        std::vector<float> phase;
        std::vector<float> previousPhase;
        std::vector<float> frozenPhase;
        std::vector<float> frozenPhaseOffset;
        std::vector<float> phaseAdvance;
        std::vector<float> frozenOmega;
        std::vector<std::uint32_t> peakOwner;
        std::vector<std::uint32_t> peakList;
        std::vector<float> scratch;
        bool hasAnalysisFrame = false;
        bool hasPhaseAdvance = false;
    };
    void processFrame(ChannelState& channel, std::uint32_t channelIndex,
                      std::uint64_t frameEnd) noexcept;
    void captureFrozenState(ChannelState& channel) noexcept;
    [[nodiscard]] float ringSample(const std::vector<float>& ring,
                                   std::int64_t absoluteIndex) const noexcept;

    ProcessSpec spec_{};
    std::uint32_t windowFrames_ = 0;
    std::uint32_t hopFrames_ = 0;
    std::uint32_t overlapFrames_ = 0;
    std::uint32_t outputRingFrames_ = 0;
    std::uint32_t windowWrite_ = 0;
    std::uint64_t sampleCounter_ = 0;
    std::array<ChannelState, 2> channels_;
    std::vector<float> window_;
    std::vector<float> olaNormalization_;
    bool freezeRequested_ = false;
    bool capturePending_ = false;
    float mix_ = 1.0f;
    bool prepared_ = false;
};

class ReverseSegment {
public:
    static constexpr std::uint32_t kInitialTransitionFrames = 64;
    [[nodiscard]] static std::size_t requiredPrepareBytes(const ProcessSpec& spec,
                                                          std::uint32_t maximumSegmentFrames) noexcept;
    bool prepare(const ProcessSpec& spec, std::uint32_t maximumSegmentFrames,
                 std::uint32_t segmentFrames, std::uint32_t crossfadeFrames);
    void reset() noexcept;
    bool setSegment(std::uint32_t segmentFrames, std::uint32_t crossfadeFrames) noexcept;
    [[nodiscard]] StereoFrame processSample(float inputLeft, float inputRight) noexcept;
    bool processBlock(const float* inputLeft, const float* inputRight,
                      float* outputLeft, float* outputRight,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t segmentFrames() const noexcept { return segmentFrames_; }
    [[nodiscard]] std::uint32_t algorithmicLatencySamples() const noexcept {
        return 2U * segmentFrames_ - crossfadeFrames_;
    }
    // Output stays live during the reported warmup latency, then fades into
    // the first reversed head over kInitialTransitionFrames without changing
    // the source-history latency. Later segment joins use F25 equal-power
    // reverse-to-reverse crossfades.
    [[nodiscard]] std::uint32_t initialTransitionFrames() const noexcept { return initialTransitionFrames_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }

private:
    [[nodiscard]] float readHistory(const std::vector<float>& history,
                                    std::uint64_t absoluteFrame) const noexcept;
    ProcessSpec spec_{};
    std::array<std::vector<float>, 2> history_;
    std::uint32_t maximumSegmentFrames_ = 0;
    std::uint32_t historyFrames_ = 0;
    std::uint32_t segmentFrames_ = 0;
    std::uint32_t crossfadeFrames_ = 0;
    std::uint32_t initialTransitionFrames_ = kInitialTransitionFrames;
    std::uint32_t initialTransitionPosition_ = 0;
    std::uint64_t inputFrames_ = 0;
    bool prepared_ = false;
};

class PlatterInertia {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset(float speedRatio = 1.0f) noexcept;
    bool setTargetSpeed(float speedRatio) noexcept;
    bool setInertia(float naturalFrequencyHz, float dampingRatio) noexcept;
    bool processBlock(float* speedRatios, double* phaseCycles, float* accelerations,
                      std::uint32_t frames) noexcept;
    [[nodiscard]] float nextSpeedRatio() noexcept;
    [[nodiscard]] double nextPhaseCycles() noexcept;
    [[nodiscard]] float currentSpeedRatio() const noexcept { return speedRatio_; }
    [[nodiscard]] float currentAcceleration() const noexcept { return acceleration_; }
    [[nodiscard]] double currentPhaseCycles() const noexcept { return phaseCycles_; }
    [[nodiscard]] std::uint32_t algorithmicLatencySamples() const noexcept { return 0; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }

private:
    ProcessSpec spec_{};
    double sampleRate_ = 48000.0;
    float targetSpeedRatio_ = 1.0f;
    float speedRatio_ = 1.0f;
    float velocity_ = 0.0f;
    float acceleration_ = 0.0f;
    float naturalFrequencyHz_ = 1.5f;
    float dampingRatio_ = 0.8f;
    double phaseCycles_ = 0.0;
    bool prepared_ = false;
};

struct DrumVoiceParameters {
    float fundamentalHz = 55.0f;
    float decaySeconds = 0.8f;
    float tone = 0.5f;
    float noise = 0.0f;
    float amplitude = 0.8f;
    float stereoWidth = 0.0f;
    std::uint64_t seed = 1;
};

struct KickVoiceParameters {
    float startFrequencyHz = 150.0f;
    float endFrequencyHz = 45.0f;
    float sweepSeconds = 0.08f;
    float decaySeconds = 0.65f;
    float amplitude = 0.9f;
};

class DrumKickVoice {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool trigger(const KickVoiceParameters& parameters) noexcept;
    [[nodiscard]] StereoFrame processSample() noexcept;
    bool processBlock(float* outputLeft, float* outputRight, std::uint32_t frames) noexcept;
    [[nodiscard]] bool active() const noexcept { return active_; }

private:
    ProcessSpec spec_{};
    double sampleRate_ = 48000.0;
    double phase_ = 0.0;
    double elapsedSeconds_ = 0.0;
    float startFrequencyHz_ = 150.0f;
    float endFrequencyHz_ = 45.0f;
    float sweepSeconds_ = 0.08f;
    float decaySeconds_ = 0.65f;
    float amplitude_ = 0.9f;
    bool active_ = false;
    bool prepared_ = false;
};

struct SnareVoiceParameters {
    float bodyFrequencyHz = 185.0f;
    float bodyDecaySeconds = 0.3f;
    float noiseDecaySeconds = 0.22f;
    float noiseLevel = 0.8f;
    float amplitude = 0.75f;
    float stereoWidth = 0.0f;
    std::uint64_t seed = 1;
};

class DrumSnareVoice {
public:
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool trigger(const SnareVoiceParameters& parameters) noexcept;
    [[nodiscard]] StereoFrame processSample() noexcept;
    bool processBlock(float* outputLeft, float* outputRight, std::uint32_t frames) noexcept;
    [[nodiscard]] bool active() const noexcept { return active_; }

private:
    [[nodiscard]] float randomBipolar() noexcept;
    ProcessSpec spec_{};
    double sampleRate_ = 48000.0;
    double bodyCoefficient1_ = 0.0;
    double bodyCoefficient2_ = 0.0;
    double bodyY1_ = 0.0;
    double bodyY2_ = 0.0;
    double noiseEnvelope_ = 0.0;
    double noiseDecayCoefficient_ = 0.0;
    float noiseLevel_ = 0.8f;
    float amplitude_ = 0.75f;
    float stereoWidth_ = 0.0f;
    float lowState_ = 0.0f;
    float bandState_ = 0.0f;
    float sideLowState_ = 0.0f;
    float sideBandState_ = 0.0f;
    float highpassCoefficient_ = 0.0f;
    float lowpassCoefficient_ = 0.0f;
    std::uint64_t randomState_ = 1;
    bool active_ = false;
    bool prepared_ = false;
};

struct HiHatVoiceParameters {
    float baseFrequencyHz = 4200.0f;
    float decaySeconds = 0.18f;
    float noiseLevel = 0.5f;
    float amplitude = 0.6f;
    float stereoWidth = 0.0f;
    std::uint64_t seed = 1;
};

class DrumHiHatVoice {
public:
    static constexpr std::size_t kPartialCount = 6;
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool trigger(const HiHatVoiceParameters& parameters) noexcept;
    [[nodiscard]] StereoFrame processSample() noexcept;
    bool processBlock(float* outputLeft, float* outputRight, std::uint32_t frames) noexcept;
    [[nodiscard]] bool active() const noexcept { return active_; }

private:
    [[nodiscard]] float randomBipolar() noexcept;
    ProcessSpec spec_{};
    double sampleRate_ = 48000.0;
    std::array<double, kPartialCount> phase_{};
    std::array<double, kPartialCount> frequencies_{};
    std::array<float, kPartialCount> weights_{};
    double elapsedSeconds_ = 0.0;
    float decaySeconds_ = 0.18f;
    float noiseLevel_ = 0.5f;
    float amplitude_ = 0.6f;
    float stereoWidth_ = 0.0f;
    float highpassState_ = 0.0f;
    float sideHighpassState_ = 0.0f;
    float highpassCoefficient_ = 0.0f;
    double noiseEnvelope_ = 0.0;
    double noiseDecayCoefficient_ = 0.0;
    std::uint64_t randomState_ = 1;
    bool active_ = false;
    bool prepared_ = false;
};

class DrumModalVoice {
public:
    static constexpr std::size_t kModalCount = 8;
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool trigger(const DrumVoiceParameters& parameters) noexcept;
    bool setNoiseLevel(float level) noexcept;
    [[nodiscard]] StereoFrame processSample() noexcept;
    bool processBlock(float* outputLeft, float* outputRight, std::uint32_t frames) noexcept;
    [[nodiscard]] bool active() const noexcept { return active_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }

private:
    ProcessSpec spec_{};
    [[nodiscard]] float randomBipolar() noexcept;
    double sampleRate_ = 48000.0;
    std::array<double, kModalCount> coefficient1_{};
    std::array<double, kModalCount> coefficient2_{};
    std::array<double, kModalCount> modalY1_{};
    std::array<double, kModalCount> modalY2_{};
    std::array<float, kModalCount> modalWeights_{};
    std::array<float, kModalCount> modalPan_{};
    double noiseEnvelope_ = 0.0;
    double noiseDecayCoefficient_ = 0.0;
    float noiseLevel_ = 0.0f;
    float amplitude_ = 0.8f;
    float stereoWidth_ = 0.0f;
    std::uint64_t randomState_ = 1;
    bool active_ = false;
    bool prepared_ = false;
};

class DrumModalVoicePool {
public:
    static constexpr std::size_t kVoiceCount = 8;
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool trigger(const DrumVoiceParameters& parameters) noexcept;
    [[nodiscard]] StereoFrame processSample() noexcept;
    bool processBlock(float* outputLeft, float* outputRight, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t activeVoices() const noexcept;

private:
    std::array<DrumModalVoice, kVoiceCount> voices_{};
    ProcessSpec spec_{};
    std::uint32_t nextVoice_ = 0;
    bool prepared_ = false;
};

// Fixed mixed pool for the mathematical drum voices. It prefers idle slots,
// then steals the quietest active slot with a 64-sample transient tail. A fixed
// headroom factor keeps other voices' gain independent of trigger/expiry events.
// Sample playback and kit/rhythm routing remain higher layers.
class DrumVoicePool {
public:
    static constexpr std::size_t kVoiceCount = 8;
    bool prepare(const ProcessSpec& spec) noexcept;
    void reset() noexcept;
    bool triggerModal(const DrumVoiceParameters& parameters) noexcept;
    bool triggerKick(const KickVoiceParameters& parameters) noexcept;
    bool triggerSnare(const SnareVoiceParameters& parameters) noexcept;
    bool triggerHiHat(const HiHatVoiceParameters& parameters) noexcept;
    [[nodiscard]] StereoFrame processSample() noexcept;
    bool processBlock(float* outputLeft, float* outputRight, std::uint32_t frames) noexcept;
    [[nodiscard]] std::uint32_t activeVoices() const noexcept;

private:
    enum class VoiceType : std::uint8_t { None, Modal, Kick, Snare, HiHat };
    struct Slot {
        DrumModalVoice modal;
        DrumKickVoice kick;
        DrumSnareVoice snare;
        DrumHiHatVoice hiHat;
        VoiceType type = VoiceType::None;
        StereoFrame lastOutput{};
        StereoFrame stealTail{};
        std::uint32_t stealTailRemaining = 0;
        float levelEstimate = 0.0f;
        [[nodiscard]] bool active() const noexcept;
        [[nodiscard]] bool sourceActive() const noexcept;
        [[nodiscard]] bool available() const noexcept;
        void beginStealFade() noexcept;
        [[nodiscard]] StereoFrame process() noexcept;
    };
    [[nodiscard]] Slot& acquireSlot() noexcept;
    std::array<Slot, kVoiceCount> voices_{};
    ProcessSpec spec_{};
    std::uint32_t nextVoice_ = 0;
    bool prepared_ = false;
};

} // namespace webrc::dsp
