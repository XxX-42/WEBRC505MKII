#pragma once

#include "native_fx_graph.hpp"
#include "native_track_host.hpp"

#include <array>
#include <cstddef>
#include <cstdint>

namespace webrc::native {

constexpr std::uint8_t kNativeFxBankBusCount = kNativeFxGraphBusCount;
constexpr std::uint8_t kNativeFxBankSlotsPerBus = kNativeFxGraphSlotsPerBus;
constexpr std::uint8_t kNativeFxBankMaximumParameters =
    static_cast<std::uint8_t>(kNativeFxGraphParameterCapacity);
constexpr std::uint32_t kNativeFxBankMaximumEventBatch = 64U;

// Bus indexes are stable protocol positions:
// 0=input, 1..5=track 0..4, 6=send, 7=master.
struct NativeFxBankSlotConfig {
    bool enabled = false;
    std::uint16_t ordinal = 0U;
    float mix = 1.0f;
    float smoothingMs = 5.0f;
    std::array<NativeFxInitialParameter, kNativeFxGraphParameterCapacity> parameters{};
    std::uint8_t parameterCount = 0U;
};

struct NativeFxBankConfig {
    std::uint32_t sampleRateHz = 48000U;
    std::uint32_t channels = 2U;
    std::uint32_t maxBlockFrames = kNativeFxGraphMaximumFrames;
    std::array<std::array<NativeFxBankSlotConfig, kNativeFxBankSlotsPerBus>,
               kNativeFxBankBusCount> buses{};
};

enum class NativeFxBankEventKind : std::uint8_t {
    ProcessorParameter,
    SlotMix,
    Midi,
};

struct NativeFxBankEvent {
    std::uint64_t absoluteFrame = 0U;
    std::uint8_t busIndex = 0U;
    std::uint8_t slotIndex = 0U;
    NativeFxBankEventKind kind = NativeFxBankEventKind::ProcessorParameter;
    webrc::dsp::FxParameterId parameter = webrc::dsp::FxParameterId::FrequencyHz;
    float value = 0.0f;
    float smoothingMs = 5.0f;
    webrc::dsp::FxMidiEventType midiType = webrc::dsp::FxMidiEventType::NoteOn;
    std::uint8_t midiChannel = 0U;
    std::uint8_t midiNote = 60U;
    std::uint8_t midiVelocity = 100U;
};

enum class NativeFxBankStatus : std::uint8_t {
    Ok,
    HostNotPrepared,
    InvalidConfiguration,
    InvalidSpec,
    InvalidBus,
    InvalidSlot,
    InvalidMix,
    UnsupportedOrdinal,
    InvalidRoute,
    TooManyParameters,
    DuplicateParameter,
    InvalidParameter,
    PrepareTimeParameterNotAllowed,
    TooManyEvents,
    InvalidEvent,
    EventOrderRejected,
    MemoryBudgetUnavailable,
    MemoryBudgetExceeded,
    AllocationFailed,
    ControlEventRejected,
    GraphPrepareFailed,
    GraphConfigureFailed,
    GraphSealFailed,
    StageFailed,
};

struct NativeFxBankResult {
    NativeFxBankStatus status = NativeFxBankStatus::InvalidConfiguration;
    NativeFxGraphResult graphResult = NativeFxGraphResult::Ok;
    std::uint8_t busIndex = 0xffU;
    std::uint8_t slotIndex = 0xffU;

    [[nodiscard]] bool ok() const noexcept { return status == NativeFxBankStatus::Ok; }
};

// Control-thread configuration owner for one prepared NativeTrackHost sample
// rate and one staged immutable FX graph. The constructor's sample rate must
// match the already-prepared host, allowing a mismatch to reject before any
// graph or processor prepare work begins.
// validateConfiguration() is a non-allocating metadata/spec check. configure()
// then checks the prepared host, its actual sample rate, and the aggregate
// candidate budget before using one temporary processor at a time to validate
// coupled runtime controls and prepare selectors. It next prepares/configures/
// seals a new graph and asks NativeTrackHost to stage it. The stored snapshot
// changes only after stageFxGraph succeeds; every failure leaves the previous
// accepted bank configuration intact. Calls are serialized by the caller on
// a control thread. Audio processing remains owned by NativeTrackHost.
class NativeFxBank {
public:
    explicit NativeFxBank(NativeTrackHost& host) noexcept : host_(&host) {}
    NativeFxBank(const NativeFxBank&) = delete;
    NativeFxBank& operator=(const NativeFxBank&) = delete;

    [[nodiscard]] NativeFxBankResult configure(const NativeFxBankConfig& candidate) noexcept;
    // Validates all addressed slots against the complete prospective parameter
    // state, then publishes the whole ordered batch to the host in one enqueue.
    // The accepted configuration snapshot changes only after that enqueue succeeds.
    [[nodiscard]] NativeFxBankResult postEvents(const NativeFxBankEvent* events,
                                               std::uint32_t eventCount) noexcept;
    [[nodiscard]] NativeFxBankResult postParameterEvent(
        std::uint8_t busIndex, std::uint8_t slotIndex,
        webrc::dsp::FxParameterId parameter, float value,
        std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] NativeFxBankResult postSlotMixEvent(
        std::uint8_t busIndex, std::uint8_t slotIndex,
        float mix, float smoothingMs, std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] bool slotFixedLatencySamples(std::uint8_t busIndex,
                                               std::uint8_t slotIndex,
                                               std::int32_t& samples) const noexcept;
    [[nodiscard]] bool slotSupportsOuterMix(std::uint8_t busIndex,
                                            std::uint8_t slotIndex) const noexcept;

    [[nodiscard]] bool configured() const noexcept { return configured_; }
    [[nodiscard]] const NativeFxBankConfig* configuration() const noexcept {
        return configured_ ? &configuration_ : nullptr;
    }

    [[nodiscard]] static NativeFxBankResult validateConfiguration(
        const NativeFxBankConfig& candidate) noexcept;
    [[nodiscard]] static std::uint64_t requiredCandidatePeakBytes(
        const NativeFxBankConfig& candidate) noexcept;

private:
    NativeTrackHost* host_ = nullptr;
    NativeFxBankConfig configuration_{};
    std::array<std::array<bool, kNativeFxBankSlotsPerBus>, kNativeFxBankBusCount>
        outerMixSupported_{};
    std::array<std::array<std::int32_t, kNativeFxBankSlotsPerBus>, kNativeFxBankBusCount>
        fixedLatencySamples_{};
    bool configured_ = false;
};

} // namespace webrc::native
