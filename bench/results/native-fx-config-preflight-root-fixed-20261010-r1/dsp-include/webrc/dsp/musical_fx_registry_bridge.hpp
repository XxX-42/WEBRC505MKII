#pragma once

#include "webrc/dsp/fx_registry.hpp"
#include "webrc/dsp/musical_fx_adapter.hpp"
#include "webrc/dsp/musical_fx_context.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>

namespace webrc::dsp {

// FxProcessor host bridge for the nine shared musical adapters. Runtime
// parameters remain reconstruction-safe controls. Published Roland UI facts
// are separate metadata and are never treated as processor curves here.
//
// Typed carrier/MIDI access is exposed through the FxProcessor polymorphic
// context entry so hosts do not need to downcast this bridge.
class MusicalFxRegistryBridge final : public FxProcessor {
public:
    static constexpr std::uint32_t kMaximumEventsPerBlock = 64U;

    explicit MusicalFxRegistryBridge(std::uint16_t ordinal) noexcept;
    ~MusicalFxRegistryBridge() override = default;
    MusicalFxRegistryBridge(const MusicalFxRegistryBridge&) = delete;
    MusicalFxRegistryBridge& operator=(const MusicalFxRegistryBridge&) = delete;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        std::uint16_t ordinal, const ProcessSpec& spec,
        const MusicalFxOptions* options = nullptr) noexcept;
    [[nodiscard]] std::size_t replacementPeakBytes(const ProcessSpec& spec) const noexcept;

    // Optional clean-room processor options can be selected only before
    // prepare. Factory-created instances use the declared defaults.
    [[nodiscard]] bool setOptions(const MusicalFxOptions& options) noexcept;
    void setMaximumPreparePeakBytes(std::size_t bytes) noexcept;
    [[nodiscard]] std::size_t preparedBytes() const noexcept { return preparedBytes_; }
    [[nodiscard]] const MusicalFxAdapter& adapter() const noexcept { return adapter_; }

    [[nodiscard]] std::uint16_t ordinal() const noexcept override { return ordinal_; }
    [[nodiscard]] bool prepare(const ProcessSpec& spec) noexcept override;
    void reset() noexcept override;
    [[nodiscard]] bool validateBlockRequest(std::uint32_t channels,
                                            std::uint32_t frames) const noexcept override;
    [[nodiscard]] bool validParameter(FxParameterId id, float value) const noexcept override;
    [[nodiscard]] bool validateParameterEvents(const FxParameterEvent* events,
                                               std::uint32_t eventCount) const noexcept override;
    [[nodiscard]] bool canAcceptParameterEvents(std::uint32_t eventCount) const noexcept override;
    [[nodiscard]] std::uint32_t maximumParameterEventsPerBlock() const noexcept override {
        return kMaximumEventsPerBlock;
    }
    [[nodiscard]] bool setParameter(FxParameterId id, float value) noexcept override;
    [[nodiscard]] bool processBlock(const float* const* inputPlanar,
                                    float* const* outputPlanar,
                                    std::uint32_t channels,
                                    std::uint32_t frames) noexcept override;

    // Atomic parameter-only counterpart with the FxProcessor signature. It
    // deliberately avoids the base implementation's chunk/setter fallback;
    // that fallback cannot satisfy ordinal 20's mandatory carrier contract.
    [[nodiscard]] bool processBlockWithEvents(
        const float* const* inputPlanar, float* const* outputPlanar,
        std::uint32_t channels, std::uint32_t frames,
        const FxParameterEvent* events, std::uint32_t eventCount) noexcept override;

    // Atomic host entry for a combined parameter+typed-MIDI block. Parameter
    // and MIDI inputs must each be ordered by frameOffset. Their merged event
    // count, including any direct setters queued through FxProcessor, is at
    // most 64. At equal offsets parameters are applied before MIDI.
    [[nodiscard]] bool processBlockWithContext(
        const float* const* inputPlanar, float* const* outputPlanar,
        std::uint32_t channels, std::uint32_t frames,
        const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount,
        const FxProcessContext& context) noexcept override;

    [[nodiscard]] bool processBlockWithMusicalEvents(
        const float* const* inputPlanar, float* const* outputPlanar,
        std::uint32_t channels, std::uint32_t frames,
        const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount,
        const FxMidiEvent* midiEvents, std::uint32_t midiEventCount) noexcept;

    [[nodiscard]] bool processBlockWithCarrier(
        const float* const* modulatorPlanar, const float* carrierLeft,
        const float* carrierRight, float* const* outputPlanar,
        std::uint32_t channels, std::uint32_t frames,
        const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount) noexcept;

    [[nodiscard]] std::int32_t fixedLatencySamples() const noexcept override;
    [[nodiscard]] std::uint32_t startupWarmupFrames() const noexcept override;
    [[nodiscard]] bool latencyIsFrequencyDependent() const noexcept override;

private:
    struct MappedParameter {
        MusicalFxParameter parameter = MusicalFxParameter::Active;
        float value = 0.0f;
    };

    [[nodiscard]] static bool makeDefaultOptions(std::uint16_t ordinal,
                                                MusicalFxOptions& options) noexcept;
    [[nodiscard]] bool mapParameter(FxParameterId id, float value,
                                    MappedParameter& mapped) const noexcept;
    [[nodiscard]] bool parameterValueValid(MusicalFxParameter parameter,
                                           float value) const noexcept;
    [[nodiscard]] bool validateContext(const FxProcessContext& context,
                                       std::uint32_t frames) const noexcept;
    [[nodiscard]] bool processInternal(
        const float* const* inputPlanar, float* const* outputPlanar,
        const float* carrierLeft, const float* carrierRight,
        std::uint32_t channels, std::uint32_t frames,
        const FxParameterEvent* parameterEvents, std::uint32_t parameterEventCount,
        const FxProcessContext& context) noexcept;

    const std::uint16_t ordinal_;
    MusicalFxOptions options_{};
    MusicalFxAdapter adapter_{};
    ProcessSpec spec_{};
    std::unique_ptr<StereoFrame[]> audioScratch_{};
    std::unique_ptr<StereoFrame[]> carrierScratch_{};
    std::array<MusicalFxEvent, kMaximumEventsPerBlock> pendingSetters_{};
    std::uint32_t pendingSetterCount_ = 0U;
    std::uint64_t nextFrame_ = 0U;
    std::size_t preparedBytes_ = 0U;
    std::size_t maximumPreparePeakBytes_ = std::numeric_limits<std::size_t>::max();
    bool prepared_ = false;
};

} // namespace webrc::dsp
