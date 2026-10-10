#pragma once

#include "multitrack_looper_core.hpp"
#include "native_fx_graph.hpp"
#include "webrc/dsp/rhythm.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>

namespace webrc::native {

constexpr std::uint32_t kNativeTrackHostQuantumFrames = 64;
constexpr std::uint32_t kNativeTrackHostMaximumCallbackFrames = 4096;
constexpr std::uint32_t kNativeTrackHostRhythmCommandCapacity = 128U;
constexpr std::uint64_t kDefaultNativeAudioAggregateMemoryBudgetBytes =
    512ULL * 1024ULL * 1024ULL;

struct NativeTrackHostStatus {
    std::array<TrackStatus, kNativeTrackCount> tracks{};
    std::uint64_t nextFrame = 0;
    std::uint64_t preparedHistoryBytes = 0;
    std::uint64_t aggregateMemoryBudgetBytes = 0;
    std::uint64_t preparedFixedBytes = 0;
    std::uint64_t preparedFxGraphBytes = 0;
    std::uint64_t candidateFxGraphBudgetBytes = 0;
    double tempoBpm = 120.0;
    bool fxGraphActive = false;
    // Producer generation identifies the latest accepted stage request;
    // active generation is published only after callback-boundary adoption.
    std::uint64_t fxGraphGeneration = 0U;
    std::uint64_t fxGraphActiveGeneration = 0U;
    std::uint64_t staleFxEventsDiscarded = 0U;
    std::uint64_t fxDspFaultCount = 0U;
    std::uint64_t lastFxDspFaultFrame = 0U;
    NativeFxGraphResult lastFxDspFault = NativeFxGraphResult::Ok;
    bool rhythmPrepared = false;
    bool rhythmPlaying = false;
    std::uint32_t rhythmPatternIndex = webrc::dsp::RhythmRenderer::kExternalPatternSelection;
    std::uint32_t rhythmKitIndex = 0U;
    std::uint8_t rhythmVariation = 0U;
    webrc::dsp::RhythmSection rhythmSection = webrc::dsp::RhythmSection::Stopped;
    std::uint32_t rhythmActiveVoices = 0U;
    std::uint64_t rhythmCompletedBars = 0U;
    std::uint64_t rhythmTriggeredEvents = 0U;
    std::uint64_t rhythmLastTriggeredFrame = 0U;
    std::uint64_t rejectedRhythmCommands = 0U;
    std::uint64_t lateRhythmCommands = 0U;
    std::uint64_t rhythmFaultCount = 0U;
    std::uint64_t lastRhythmFaultFrame = 0U;
    double rhythmTempoBpm = 120.0;
    double rhythmTempoTargetBpm = 120.0;
    bool rhythmTempoPending = false;
    float rhythmVolume = 1.0f;
    float rhythmVolumeTarget = 1.0f;
    bool rhythmVolumePending = false;
    MultiTrackProcessStats lastProcess{};
};

// Software-only host adapter between variable device callbacks and the
// fixed-quantum five-track core. It duplicates mono capture into stereo and
// splits larger callbacks into <=64-frame allocations-free core calls.
class NativeTrackHost {
public:
    NativeTrackHost() = default;
    NativeTrackHost(const NativeTrackHost&) = delete;
    NativeTrackHost& operator=(const NativeTrackHost&) = delete;

    bool prepare(std::uint32_t sampleRate,
                 std::uint32_t maxLoopSeconds = 60,
                 std::uint64_t memoryBudgetBytes = 0);

    [[nodiscard]] static std::uint64_t requiredFixedMemoryBytes() noexcept;
    [[nodiscard]] std::uint64_t candidateFxGraphBudgetBytes() const noexcept;

    bool processInputBlock(const float* inputInterleaved,
                           std::uint32_t inputChannels,
                           float* outputInterleavedStereo,
                           std::uint32_t frames,
                           MultiTrackProcessStats* stats = nullptr) noexcept;

    // Optional, independent auxiliary stereo input used by VOCODER20. The
    // carrier is distinct from inputInterleaved (the modulator/record source)
    // and is supplied as packed LR float frames. Null/0 means unavailable.
    bool processInputBlockWithCarrier(const float* inputInterleaved,
                                      std::uint32_t inputChannels,
                                      const float* carrierInterleaved,
                                      std::uint32_t carrierChannels,
                                      float* outputInterleavedStereo,
                                      std::uint32_t frames,
                                      MultiTrackProcessStats* stats = nullptr) noexcept;

    // Candidate graphs must be prepared with candidateFxGraphBudgetBytes(),
    // fully populated and sealed on a stopped/control thread. This budget
    // includes fixed host/core state, all five histories, and the active graph.
    // The audio thread adopts a fitting candidate at a block boundary;
    // reclaimRetiredFxGraph() destroys a completed prior graph off-thread and
    // only then returns its bytes to the aggregate admission ledger.
    [[nodiscard]] NativeFxGraphResult stageFxGraph(
        std::unique_ptr<NativeFxGraph>& candidate) noexcept;
    [[nodiscard]] NativeFxGraphResult postFxEvent(const NativeFxGraphEvent& event) noexcept;
    [[nodiscard]] NativeFxGraphResult postFxEvents(const NativeFxGraphEvent* events,
                                                   std::uint32_t eventCount) noexcept;
    [[nodiscard]] bool reclaimRetiredFxGraph() noexcept;

    bool postTrackCommand(const TrackCommand& command) noexcept;
    bool record(std::uint8_t trackIndex) noexcept;
    bool stop(std::uint8_t trackIndex) noexcept;
    bool play(std::uint8_t trackIndex) noexcept;
    bool toggleOverdub(std::uint8_t trackIndex) noexcept;
    bool clear(std::uint8_t trackIndex) noexcept;
    bool setInputRoute(std::uint8_t trackIndex, bool enabled) noexcept;
    bool setGain(std::uint8_t trackIndex, float gain) noexcept;
    bool setPan(std::uint8_t trackIndex, float pan) noexcept;
    bool setMute(std::uint8_t trackIndex, bool muted) noexcept;
    bool setSolo(std::uint8_t trackIndex, bool solo) noexcept;
    bool setTempo(double bpm) noexcept;
    // One timestamped command owns the shared transport tempo. The looper's
    // sample-locked PCM tempo metadata updates at this frame; RhythmRenderer
    // applies its pending tempo at the next bar boundary.
    bool setTempoAtFrame(std::uint64_t absoluteFrame, double bpm) noexcept;
    [[nodiscard]] std::uint64_t nextRhythmCommandFrame(
        std::uint32_t leadFrames = kNativeTrackHostQuantumFrames) const noexcept;
    [[nodiscard]] std::uint64_t nextSharedTempoCommandFrame(
        std::uint32_t leadFrames = kNativeTrackHostQuantumFrames) const noexcept;
    bool setMonitor(bool enabled) noexcept;

    // Rhythm commands are timestamped on the same absolute sample clock as
    // loop transport. They are admitted on a control thread and applied by
    // the audio owner; no renderer state is mutated by the producer thread.
    bool queueRhythmPatternKit(std::uint64_t absoluteFrame,
                               std::uint32_t patternIndex,
                               std::uint32_t kitIndex) noexcept;
    bool startRhythm(std::uint64_t absoluteFrame, bool playIntro = true) noexcept;
    bool queueRhythmVariation(std::uint64_t absoluteFrame,
                              std::uint8_t variation) noexcept;
    bool queueRhythmFill(std::uint64_t absoluteFrame) noexcept;
    bool queueRhythmEnding(std::uint64_t absoluteFrame) noexcept;
    bool stopRhythm(std::uint64_t absoluteFrame) noexcept;
    bool setRhythmTempoAtFrame(std::uint64_t absoluteFrame, double bpm) noexcept;
    bool setRhythmVolumeAtFrame(std::uint64_t absoluteFrame, float volume) noexcept;

    [[nodiscard]] NativeTrackHostStatus status() const noexcept;
    [[nodiscard]] bool prepared() const noexcept { return static_cast<bool>(core_); }
    // Control-plane admission must use the host's prepared rate, not a caller
    // supplied rate that might disagree with the active callback graph.
    [[nodiscard]] std::uint32_t sampleRateHz() const noexcept {
        return core_ ? sampleRate_ : 0U;
    }

private:
    enum class RhythmCommandType : std::uint8_t {
        PatternKit,
        Start,
        Variation,
        Fill,
        Ending,
        Stop,
        Tempo,
        Volume,
    };
    struct RhythmCommand {
        std::uint64_t absoluteFrame = 0U;
        RhythmCommandType type = RhythmCommandType::Start;
        std::uint32_t patternIndex = 0U;
        std::uint32_t kitIndex = 0U;
        std::uint8_t variation = 0U;
        bool playIntro = true;
        double bpm = 120.0;
        float volume = 1.0f;
    };

    struct PublishedTrackStatus {
        std::atomic<std::uint64_t> sequence{0};
        std::atomic<std::uint8_t> state{static_cast<std::uint8_t>(TrackPlaybackState::Empty)};
        std::atomic<std::uint64_t> recordedFrames{0};
        std::atomic<std::uint64_t> loopFrames{0};
        std::atomic<std::uint64_t> playhead{0};
        std::atomic<float> gain{1.0f};
        std::atomic<float> pan{0.0f};
        std::atomic<bool> muted{false};
        std::atomic<bool> solo{false};
        std::atomic<bool> inputRouted{true};
        std::atomic<bool> bufferPrepared{false};
    };

    bool queue(TrackCommandType type, std::uint8_t trackIndex,
               float value = 0.0f, bool boolValue = false) noexcept;
    bool queueRhythmCommand(const RhythmCommand& command) noexcept;
    bool queueRhythmCommandLocked(const RhythmCommand& command) noexcept;
    bool setTempoAtFrameLocked(std::uint64_t absoluteFrame, double bpm) noexcept;
    void processRhythmChunk(std::uint64_t blockStartFrame,
                            std::uint32_t frames) noexcept;
    [[nodiscard]] bool peekRhythmCommand(RhythmCommand& command) const noexcept;
    void popRhythmCommand() noexcept;
    void applyRhythmCommand(const RhythmCommand& command,
                            std::uint64_t applyFrame) noexcept;
    void publishRhythmStatus() noexcept;
    void publishTrackStatuses() noexcept;

    std::unique_ptr<MultiTrackLooperCore> core_;
    NativeFxGraphExchange fxGraphExchange_;
    mutable std::mutex commandProducerMutex_;
    mutable std::mutex fxProducerMutex_;
    mutable std::mutex rhythmProducerMutex_;
    std::unique_ptr<webrc::dsp::RhythmRenderer> rhythmRenderer_;
    std::array<RhythmCommand, kNativeTrackHostRhythmCommandCapacity> rhythmCommands_{};
    std::atomic<std::uint64_t> rhythmCommandWrite_{0U};
    std::atomic<std::uint64_t> rhythmCommandRead_{0U};
    std::uint64_t lastRhythmCommandFrame_ = 0U;
    bool hasRhythmCommandFrame_ = false;
    std::array<float, kNativeTrackHostQuantumFrames> rhythmLeftScratch_{};
    std::array<float, kNativeTrackHostQuantumFrames> rhythmRightScratch_{};
    std::array<float, kNativeTrackHostQuantumFrames> rhythmGainScratch_{};
    float rhythmVolumeCurrent_ = 1.0f;
    float rhythmVolumeTarget_ = 1.0f;
    float rhythmVolumeStep_ = 0.0f;
    std::uint32_t rhythmVolumeRemaining_ = 0U;
    std::array<PublishedTrackStatus, kNativeTrackCount> publishedTracks_{};
    std::array<float, kNativeTrackHostQuantumFrames * 2U> inputScratch_{};
    std::array<float, kNativeTrackHostQuantumFrames * 2U> outputScratch_{};
    std::array<webrc::dsp::StereoFrame, kNativeTrackHostQuantumFrames> fxInputScratch_{};
    std::array<std::array<webrc::dsp::StereoFrame, kNativeTrackHostQuantumFrames>,
               kNativeTrackCount> fxTrackScratch_{};
    std::array<webrc::dsp::StereoFrame, kNativeTrackHostQuantumFrames> fxSendScratch_{};
    std::array<webrc::dsp::StereoFrame, kNativeTrackHostQuantumFrames> fxMasterScratch_{};
    std::array<float, kNativeTrackHostQuantumFrames> fxCarrierLeftScratch_{};
    std::array<float, kNativeTrackHostQuantumFrames> fxCarrierRightScratch_{};
    std::array<std::array<float, kNativeTrackHostQuantumFrames * 2U>,
               kNativeTrackCount> trackStemScratch_{};
    std::uint32_t sampleRate_ = 48000U;
    std::atomic<std::uint64_t> nextFrame_{0};
    std::uint64_t lastQueuedFrame_ = 0;
    bool hasQueuedFrame_ = false;
    std::atomic<std::uint64_t> preparedHistoryBytes_{0};
    std::atomic<std::uint64_t> aggregateMemoryBudgetBytes_{0};
    std::atomic<std::uint64_t> preparedFixedBytes_{0};
    std::atomic<double> tempoBpm_{120.0};
    std::atomic<std::uint64_t> lastProcessFrames_{0};
    std::atomic<std::uint64_t> lastProcessLateCommands_{0};
    std::atomic<std::uint64_t> lastProcessDroppedCommands_{0};
    std::atomic<float> lastProcessInputPeak_{0.0f};
    std::atomic<float> lastProcessOutputPeak_{0.0f};
    std::atomic<std::uint32_t> lastProcessActiveTracks_{0};
    std::atomic<std::uint32_t> lastProcessRecordingTracks_{0};
    std::atomic<std::uint64_t> fxDspFaultCount_{0U};
    std::atomic<std::uint64_t> lastFxDspFaultFrame_{0U};
    std::atomic<std::uint8_t> lastFxDspFaultCode_{
        static_cast<std::uint8_t>(NativeFxGraphResult::Ok)};
    std::atomic<bool> rhythmPreparedPublished_{false};
    std::atomic<std::uint64_t> rhythmStatusSequence_{0U};
    std::atomic<bool> rhythmPlayingPublished_{false};
    std::atomic<std::uint32_t> rhythmPatternIndexPublished_{
        webrc::dsp::RhythmRenderer::kExternalPatternSelection};
    std::atomic<std::uint32_t> rhythmKitIndexPublished_{0U};
    std::atomic<std::uint8_t> rhythmVariationPublished_{0U};
    std::atomic<std::uint8_t> rhythmSectionPublished_{
        static_cast<std::uint8_t>(webrc::dsp::RhythmSection::Stopped)};
    std::atomic<std::uint32_t> rhythmActiveVoicesPublished_{0U};
    std::atomic<std::uint64_t> rhythmCompletedBarsPublished_{0U};
    std::atomic<std::uint64_t> rhythmTriggeredEventsPublished_{0U};
    std::atomic<std::uint64_t> rhythmLastTriggeredFramePublished_{0U};
    std::atomic<std::uint64_t> rejectedRhythmCommands_{0U};
    std::atomic<std::uint64_t> lateRhythmCommands_{0U};
    std::atomic<std::uint64_t> rhythmFaultCount_{0U};
    std::atomic<std::uint64_t> lastRhythmFaultFrame_{0U};
    std::atomic<double> rhythmTempoBpmPublished_{120.0};
    std::atomic<double> rhythmTempoTargetBpmPublished_{120.0};
    std::atomic<float> rhythmVolumePublished_{1.0f};
    std::atomic<float> rhythmVolumeTargetPublished_{1.0f};
};

} // namespace webrc::native
