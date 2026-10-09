#pragma once

#include "webrc/dsp/fx_registry.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace webrc::native {

constexpr std::uint32_t kNativeFxGraphMaximumFrames = 64U;
constexpr std::uint32_t kNativeFxGraphSlotsPerBus = 4U;
constexpr std::uint32_t kNativeFxGraphBusCount = 8U;
constexpr std::uint32_t kNativeFxGraphEventCapacity = 256U;
constexpr std::uint32_t kNativeFxGraphEventQueueCapacity = 512U;
constexpr std::uint32_t kNativeFxGraphParameterCapacity = 64U;
constexpr std::uint32_t kNativeFxGraphSwapCrossfadeFrames = 128U;

enum class NativeFxBusKind : std::uint8_t {
    Input = 0,
    Track = 1,
    Send = 2,
    Master = 3,
};

struct NativeFxBusAddress {
    NativeFxBusKind kind = NativeFxBusKind::Input;
    std::uint8_t trackIndex = 0U;
};

enum class NativeFxGraphEventKind : std::uint8_t {
    ProcessorParameter = 0,
    SlotMix = 1,
};

struct NativeFxGraphEvent {
    std::uint64_t absoluteFrame = 0U;
    NativeFxBusAddress bus{};
    std::uint8_t slotIndex = 0U;
    NativeFxGraphEventKind kind = NativeFxGraphEventKind::ProcessorParameter;
    webrc::dsp::FxParameterId parameter = webrc::dsp::FxParameterId::FrequencyHz;
    float value = 0.0f;
    // Used only by SlotMix; this is the outer slot crossfade time constant.
    float smoothingMs = 5.0f;
    // Zero asks the control-side exchange to stamp its current generation.
    // A nonzero value binds the event to the graph configuration that created it.
    std::uint64_t graphGeneration = 0U;
};

struct NativeFxInitialParameter {
    webrc::dsp::FxParameterId parameter = webrc::dsp::FxParameterId::FrequencyHz;
    float value = 0.0f;
};

enum class NativeFxGraphResult : std::uint8_t {
    Ok = 0,
    NotPrepared,
    AlreadySealed,
    InvalidSpec,
    UnsupportedOrdinal,
    InvalidRoute,
    InvalidBus,
    InvalidSlot,
    InvalidParameter,
    MemoryBudgetExceeded,
    GraphNotSealed,
    BlockTooLarge,
    InvalidBlock,
    MissingBusBuffer,
    InvalidEvent,
    TooManyEvents,
    EventQueueFull,
    TimestampOutOfOrder,
    NoActiveGraph,
    SwapBusy,
    SpecMismatch,
    EventBatchRejected,
};

struct NativeFxGraphBlock {
    // Input FX runs before the host records this buffer.
    webrc::dsp::StereoFrame* inputCapture = nullptr;
    // Each track has an independent FX state and signal buffer before mixing.
    std::array<webrc::dsp::StereoFrame*, 5U> trackPlayback{};
    // The caller supplies the already-built send return and master mix buses.
    webrc::dsp::StereoFrame* sendReturn = nullptr;
    webrc::dsp::StereoFrame* masterMix = nullptr;
};

struct NativeFxGraphStats {
    std::uint32_t eventsApplied = 0U;
    std::uint32_t lateEventsAppliedAtBlockStart = 0U;
    std::uint32_t rejectedEvents = 0U;
    std::uint32_t staleGenerationEventsDiscarded = 0U;
    std::uint32_t processedBusMask = 0U;
};

// One stopped/control-thread-built graph. prepare/configure/seal/reset/destruction
// are never callback operations. Once sealed, only one audio owner may process it.
// The graph has fixed scratch storage for a 64-frame stereo quantum and no callback
// allocation, locking, or object retirement.
class NativeFxGraph {
public:
    NativeFxGraph() = default;
    ~NativeFxGraph() = default;
    NativeFxGraph(const NativeFxGraph&) = delete;
    NativeFxGraph& operator=(const NativeFxGraph&) = delete;

    [[nodiscard]] NativeFxGraphResult prepare(const webrc::dsp::ProcessSpec& spec,
                                              std::uint64_t memoryBudgetBytes = 0U) noexcept;
    [[nodiscard]] NativeFxGraphResult configureSlot(
        NativeFxBusAddress bus, std::uint8_t slotIndex, std::uint16_t ordinal,
        float mix = 1.0f, float smoothingMs = 5.0f,
        const NativeFxInitialParameter* initialParameters = nullptr,
        std::uint32_t initialParameterCount = 0U) noexcept;
    [[nodiscard]] NativeFxGraphResult clearSlot(NativeFxBusAddress bus,
                                                std::uint8_t slotIndex) noexcept;
    [[nodiscard]] NativeFxGraphResult seal() noexcept;

    [[nodiscard]] NativeFxGraphResult processBlock(
        const NativeFxGraphBlock& block, std::uint32_t frames,
        NativeFxGraphStats* stats = nullptr) noexcept;
    [[nodiscard]] NativeFxGraphResult processBlockWithEvents(
        const NativeFxGraphBlock& block, std::uint32_t frames,
        std::uint64_t absoluteStartFrame, const NativeFxGraphEvent* events,
        std::uint32_t eventCount, NativeFxGraphStats* stats = nullptr) noexcept;

    // Explicit bus phases let the Native host place Input before capture and
    // Track FX before summing the five stereo stems. beginBlock validates and
    // copies the complete bounded event batch before any DSP state advances.
    [[nodiscard]] NativeFxGraphResult beginBlock(
        const NativeFxGraphBlock& block, std::uint32_t frames,
        std::uint64_t absoluteStartFrame, const NativeFxGraphEvent* events,
        std::uint32_t eventCount, NativeFxGraphStats* stats = nullptr) noexcept;
    [[nodiscard]] NativeFxGraphResult processInputBus() noexcept;
    [[nodiscard]] NativeFxGraphResult processTrackBus(std::uint8_t trackIndex) noexcept;
    [[nodiscard]] NativeFxGraphResult processSendBus() noexcept;
    [[nodiscard]] NativeFxGraphResult processMasterBus() noexcept;
    [[nodiscard]] NativeFxGraphResult endBlock(NativeFxGraphStats* stats = nullptr) noexcept;
    void cancelBlock() noexcept;

    [[nodiscard]] bool sealed() const noexcept { return sealed_; }
    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] const webrc::dsp::ProcessSpec& spec() const noexcept { return spec_; }
    [[nodiscard]] std::uint64_t memoryBudgetBytes() const noexcept { return memoryBudgetBytes_; }
    [[nodiscard]] std::uint64_t permanentProcessorBytes() const noexcept {
        return permanentProcessorBytes_;
    }
    [[nodiscard]] std::uint64_t estimatedPermanentBytes() const noexcept;
    // Samples the candidate must run before its output is eligible for a
    // graph-swap crossfade. Includes declared startup delay for time-based FX.
    [[nodiscard]] std::uint32_t transitionWarmupFrames() const noexcept {
        return transitionWarmupFrames_;
    }
    [[nodiscard]] std::uint32_t configuredSlotCount() const noexcept { return configuredSlotCount_; }
    [[nodiscard]] bool hasSlot(NativeFxBusAddress bus, std::uint8_t slotIndex) const noexcept;
    [[nodiscard]] std::uint16_t slotOrdinal(NativeFxBusAddress bus,
                                            std::uint8_t slotIndex) const noexcept;
    [[nodiscard]] std::uint64_t generation() const noexcept { return generation_; }

private:
    friend class NativeFxGraphExchange;
    void setGeneration(std::uint64_t generation) noexcept { generation_ = generation; }

    struct CachedParameter {
        webrc::dsp::FxParameterId id = webrc::dsp::FxParameterId::FrequencyHz;
        float target = 0.0f;
    };

    struct Slot {
        std::unique_ptr<webrc::dsp::FxProcessor> processor;
        webrc::dsp::ParameterSmoother mixSmoother;
        std::array<CachedParameter, kNativeFxGraphParameterCapacity> cachedParameters{};
        std::vector<float> dryAlignLeft;
        std::vector<float> dryAlignRight;
        std::uint8_t cachedParameterCount = 0U;
        std::uint16_t ordinal = 0U;
        std::uint64_t estimatedPermanentBytes = 0U;
        std::uint32_t dryAlignWrite = 0U;
        std::int32_t latencySamples = 0;
        std::uint32_t startupWarmupFrames = 0U;
        bool outerMixSupported = true;
        bool configured = false;
    };

    [[nodiscard]] static bool validBusAddress(NativeFxBusAddress bus) noexcept;
    [[nodiscard]] static std::uint32_t busIndex(NativeFxBusAddress bus) noexcept;
    [[nodiscard]] static bool busAccepts(const webrc::dsp::FxDescriptor& descriptor,
                                         NativeFxBusAddress bus) noexcept;
    [[nodiscard]] static bool addFits(std::uint64_t a, std::uint64_t b,
                                     std::uint64_t& sum) noexcept;
    void recomputeTransitionWarmupFrames() noexcept;
    [[nodiscard]] Slot* findSlot(NativeFxBusAddress bus, std::uint8_t slotIndex) noexcept;
    [[nodiscard]] const Slot* findSlot(NativeFxBusAddress bus,
                                       std::uint8_t slotIndex) const noexcept;
    [[nodiscard]] NativeFxGraphResult validateBlock(const NativeFxGraphBlock& block,
                                                    std::uint32_t frames) const noexcept;
    [[nodiscard]] NativeFxGraphResult validateEvents(
        const NativeFxGraphBlock& block, std::uint32_t frames,
        std::uint64_t absoluteStartFrame, const NativeFxGraphEvent* events,
        std::uint32_t eventCount) const noexcept;
    [[nodiscard]] bool validShadowParameters(const Slot& slot) const noexcept;
    [[nodiscard]] NativeFxGraphResult processBus(NativeFxBusAddress bus,
                                                 webrc::dsp::StereoFrame* samples,
                                                 std::uint32_t frames,
                                                 std::uint64_t absoluteStartFrame,
                                                 const NativeFxGraphEvent* events,
                                                 std::uint32_t eventCount,
                                                 NativeFxGraphStats& stats) noexcept;
    [[nodiscard]] NativeFxGraphResult processSlot(Slot& slot,
                                                  NativeFxBusAddress bus,
                                                  std::uint8_t slotIndex,
                                                 std::uint32_t frames,
                                                 std::uint64_t absoluteStartFrame,
                                                  const NativeFxGraphEvent* events,
                                                  std::uint32_t eventCount) noexcept;
    [[nodiscard]] NativeFxGraphResult processCurrentBus(NativeFxBusAddress bus,
                                            webrc::dsp::StereoFrame* samples) noexcept;

    webrc::dsp::ProcessSpec spec_{};
    std::array<Slot, kNativeFxGraphBusCount * kNativeFxGraphSlotsPerBus> slots_{};
    std::array<std::array<float, kNativeFxGraphMaximumFrames>, 2U> work_{};
    std::array<std::array<float, kNativeFxGraphMaximumFrames>, 2U> result_{};
    // Reused only by the audio owner while validating a single slot's batch.
    mutable std::array<float, kNativeFxGraphParameterCapacity> parameterValidationScratch_{};
    NativeFxGraphBlock currentBlock_{};
    std::array<NativeFxGraphEvent, kNativeFxGraphEventCapacity> currentEvents_{};
    NativeFxGraphStats currentStats_{};
    std::uint64_t memoryBudgetBytes_ = 0U;
    std::uint64_t generation_ = 0U;
    std::uint64_t currentBlockStartFrame_ = 0U;
    std::uint64_t permanentProcessorBytes_ = 0U;
    std::uint32_t transitionWarmupFrames_ = 0U;
    std::uint32_t configuredSlotCount_ = 0U;
    std::uint32_t currentEventCount_ = 0U;
    std::uint32_t currentFrames_ = 0U;
    std::uint8_t nextTrackBus_ = 0U;
    bool currentBlockOpen_ = false;
    bool inputBusDone_ = false;
    bool sendBusDone_ = false;
    bool masterBusDone_ = false;
    bool prepared_ = false;
    bool sealed_ = false;
    std::uint64_t nextBlockFrame_ = 0U;
};

// The exchange owns the live-event queue, so producers never dereference a graph
// that the audio owner may retire. stage() takes ownership only on success.
// processBlock() activates one staged immutable graph at the next block boundary.
// reclaimRetired() destroys retired graphs on the caller thread, never on the
// audio callback. Swap admission remains closed until destruction completes.
class NativeFxGraphExchange {
public:
    NativeFxGraphExchange() = default;
    ~NativeFxGraphExchange();
    NativeFxGraphExchange(const NativeFxGraphExchange&) = delete;
    NativeFxGraphExchange& operator=(const NativeFxGraphExchange&) = delete;

    [[nodiscard]] NativeFxGraphResult stage(std::unique_ptr<NativeFxGraph>& candidate) noexcept;
    [[nodiscard]] NativeFxGraphResult postEvent(const NativeFxGraphEvent& event) noexcept;
    [[nodiscard]] NativeFxGraphResult processBlock(const NativeFxGraphBlock& block,
                                                   std::uint32_t frames,
                                                   std::uint64_t absoluteStartFrame,
                                                   NativeFxGraphStats* stats = nullptr) noexcept;
    [[nodiscard]] NativeFxGraphResult beginBlock(const NativeFxGraphBlock& block,
                                                 std::uint32_t frames,
                                                 std::uint64_t absoluteStartFrame,
                                                 NativeFxGraphStats* stats = nullptr) noexcept;
    [[nodiscard]] NativeFxGraphResult processInputBus() noexcept;
    [[nodiscard]] NativeFxGraphResult processTrackBus(std::uint8_t trackIndex) noexcept;
    [[nodiscard]] NativeFxGraphResult processSendBus() noexcept;
    [[nodiscard]] NativeFxGraphResult processMasterBus() noexcept;
    [[nodiscard]] NativeFxGraphResult endBlock(NativeFxGraphStats* stats = nullptr) noexcept;
    void cancelBlock() noexcept;
    [[nodiscard]] bool reclaimRetired() noexcept;
    // Valid for an off-thread candidate preflight while no graph transition is
    // in flight. The active graph is immutable after seal, so its prepared-byte
    // estimate is stable while processing.
    [[nodiscard]] bool canStageCandidate() const noexcept {
        return !swapInFlight_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::uint64_t activeGraphBytes() const noexcept;
    [[nodiscard]] std::uint64_t residentGraphBytes() const noexcept;
    [[nodiscard]] bool hasActiveGraph() const noexcept {
        return active_.load(std::memory_order_acquire) != nullptr;
    }
    [[nodiscard]] std::uint32_t queuedEventCount() const noexcept;
    [[nodiscard]] std::uint64_t staleGenerationEventCount() const noexcept {
        return staleGenerationEventCount_.load(std::memory_order_relaxed);
    }
    [[nodiscard]] std::uint64_t producerGeneration() const noexcept {
        return producerGeneration_.load(std::memory_order_acquire);
    }

private:
    struct QueuedEvent {
        NativeFxGraphEvent event{};
    };

    [[nodiscard]] NativeFxGraph* activatePendingAtBoundary() noexcept;
    [[nodiscard]] std::uint64_t eventQueueDepth() const noexcept;
    void copyCrossfadeBus(NativeFxBusAddress bus, const webrc::dsp::StereoFrame* source,
                          std::uint32_t frames) noexcept;
    void blendCrossfadeBus(webrc::dsp::StereoFrame* current,
                           const webrc::dsp::StereoFrame* previous,
                           std::uint32_t frames) noexcept;
    [[nodiscard]] NativeFxGraphResult processPreviousBus(NativeFxBusAddress bus) noexcept;

    std::array<QueuedEvent, kNativeFxGraphEventQueueCapacity> eventQueue_{};
    std::array<NativeFxGraphEvent, kNativeFxGraphEventCapacity> dueEvents_{};
    std::atomic<std::uint64_t> eventWrite_{0U};
    std::atomic<std::uint64_t> eventRead_{0U};
    std::atomic<NativeFxGraph*> pending_{nullptr};
    std::atomic<NativeFxGraph*> active_{nullptr};
    std::atomic<NativeFxGraph*> retired_{nullptr};
    // Published independently of active_ so control/status readers never
    // dereference a graph that may concurrently move to retired_ and be freed.
    std::atomic<std::uint64_t> activeGraphBytes_{0U};
    // Counts active + pending + crossfade/retired graph storage. It remains
    // charged until reclaimRetired() has destroyed an old graph.
    std::atomic<std::uint64_t> residentGraphBytes_{0U};
    std::atomic<bool> swapInFlight_{false};
    std::atomic<std::uint64_t> staleGenerationEventCount_{0U};
    NativeFxGraph* processingGraph_ = nullptr;
    NativeFxGraph* crossfadeGraph_ = nullptr;
    NativeFxGraphBlock crossfadeBlock_{};
    std::array<webrc::dsp::StereoFrame, kNativeFxGraphMaximumFrames> crossfadeInput_{};
    std::array<std::array<webrc::dsp::StereoFrame, kNativeFxGraphMaximumFrames>, 5U> crossfadeTracks_{};
    std::array<webrc::dsp::StereoFrame, kNativeFxGraphMaximumFrames> crossfadeSend_{};
    std::array<webrc::dsp::StereoFrame, kNativeFxGraphMaximumFrames> crossfadeMaster_{};
    std::uint32_t crossfadeProgress_ = 0U;
    std::uint32_t crossfadeWarmupRemaining_ = 0U;
    // First install crossfades from the untouched host bus instead of starting
    // a newly prepared stateful processor at an abrupt all-wet boundary.
    bool crossfadeFromDry_ = false;
    std::uint64_t producerLastFrame_ = 0U;
    std::atomic<std::uint64_t> producerGeneration_{0U};
    bool producerHasFrame_ = false;
    webrc::dsp::ProcessSpec expectedSpec_{};
    bool expectedSpecSet_ = false;
    bool currentBlockOpen_ = false;
    NativeFxGraphStats currentStats_{};
};

} // namespace webrc::native
