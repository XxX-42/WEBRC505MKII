#pragma once

#include "dsp_primitives.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string_view>
#include <vector>

namespace webrc::native {

// Stable parameter semantics for the incrementally assembled Native FX graph.
// IDs are serialized/control-plane names: keep them stable when adding UI or
// bridge integration. `smoothingMs` is the default ramp for parameter edits;
// callers may override it by passing a non-zero rampFrames value.
struct NativeEffectParameterDescriptor {
    std::string_view id;
    std::string_view label;
    float minimum = 0.0f;
    float maximum = 1.0f;
    float defaultValue = 0.0f;
    unsigned int smoothingMs = 10U;
    bool discrete = false;
    const float* discreteValues = nullptr;
    std::size_t discreteValueCount = 0U;
};

struct NativeEffectDescriptor {
    std::string_view id;
    std::string_view name;
    const NativeEffectParameterDescriptor* parameters = nullptr;
    std::size_t parameterCount = 0U;
    bool inputAvailable = true;
    bool trackAvailable = true;
    // Index in the supplied Native/Browser FX catalog, when this mapping is
    // explicitly known. -1 means this clean-room Native catalog has no
    // verified source-index mapping for the effect.
    int sourceIndex = -1;
};

[[nodiscard]] const NativeEffectDescriptor* nativeEffectCatalog(std::size_t& count) noexcept;
[[nodiscard]] const NativeEffectDescriptor* findNativeEffectDescriptor(std::string_view stableId) noexcept;
// Whether the Native host may advertise this ID in ordered per-track A-D
// insert banks. Source-aware loop transports use a different pre-insert route.
[[nodiscard]] bool nativeEffectSupportsPerTrackInsert(std::string_view stableId) noexcept;
[[nodiscard]] const NativeEffectParameterDescriptor* findNativeEffectParameter(
    std::string_view stableEffectId,
    std::string_view parameterId
) noexcept;

class NativeEffectProcessor {
public:
    virtual ~NativeEffectProcessor() = default;

    [[nodiscard]] std::string_view stableId() const noexcept { return descriptor_->id; }
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] unsigned int reportedLatencySamples() const noexcept { return algorithmicLatencySamples(); }
    [[nodiscard]] bool isBypassed() const noexcept { return bypassed_; }
    [[nodiscard]] bool processingFaulted() const noexcept { return processingFaulted_; }

    // prepare() is a control-thread operation. Any memory required by an
    // effect is allocated here, never from processInPlace().
    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setParameter(std::string_view parameterId, float value, std::uint64_t rampFrames = 0U) noexcept;
    void setBypassed(bool bypassed, std::uint64_t rampFrames = 0U) noexcept;
    void resetState() noexcept;

    // Processes the first two channels in-place. Additional channels pass
    // through unchanged. The processor is single-owner and lock-free; callers
    // must apply control changes on its DSP-owner thread or via their queue.
    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;

protected:
    explicit NativeEffectProcessor(const NativeEffectDescriptor& descriptor) noexcept;
    [[nodiscard]] std::uint64_t defaultRampFrames(unsigned int smoothingMs) const noexcept;
    [[nodiscard]] virtual bool onPrepare() noexcept = 0;
    [[nodiscard]] virtual bool onSetParameter(
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames
    ) noexcept = 0;
    virtual void onBypassChanged(bool bypassed) noexcept { (void)bypassed; }
    virtual void onResetState() noexcept = 0;
    virtual void processEffectFrame(float* frame, unsigned int channels) noexcept = 0;
    [[nodiscard]] virtual bool processEffectBlock(
        float* interleaved,
        unsigned int frames,
        unsigned int channels
    ) noexcept;
    [[nodiscard]] virtual unsigned int algorithmicLatencySamples() const noexcept { return 0U; }
    [[nodiscard]] virtual bool usesBaseWetMix() const noexcept { return false; }

private:
    const NativeEffectDescriptor* descriptor_;
    unsigned int sampleRate_ = 0U;
    bool bypassed_ = false;
    dsp::ParameterSmoother bypassMix_{0.0f};
    dsp::ParameterSmoother wetMix_{1.0f};
    std::vector<float> dryDelayRing_{};
    std::vector<std::uint64_t> dryDelayGenerationTags_{};
    std::array<float, 4096U * 2U> dryScratch_{};
    unsigned int dryDelayFrames_ = 0U;
    unsigned int dryDelayWriteFrame_ = 0U;
    std::uint64_t dryDelayGeneration_ = 1U;
    bool processingFaulted_ = false;
};

// Returns nullptr for unknown or not-yet-implemented IDs. The factory only
// exposes effects with working processors; descriptor-only ideas stay out of
// this catalog until they are wired and tested.
[[nodiscard]] std::unique_ptr<NativeEffectProcessor> createNativeEffectProcessor(std::string_view stableId);

enum class NativeEffectSlot : std::uint8_t { A = 0U, B, C, D };

// Four effect slots, processed serially A -> B -> C -> D. Slot objects and
// their delay storage are created/prepared from the control thread. Audio
// processing does not allocate. Replacing an effect should be synchronized
// with the audio owner (for example, while stopped or while applying a queued
// graph command at a block boundary).
class NativeEffectBank final {
public:
    static constexpr std::size_t kSlotCount = 4U;
    static constexpr std::array<std::string_view, kSlotCount> kSlotNames{{"A", "B", "C", "D"}};

    [[nodiscard]] bool prepare(unsigned int sampleRate) noexcept;
    [[nodiscard]] bool setEffect(NativeEffectSlot slot, std::string_view stableId);
    [[nodiscard]] bool clearSlot(NativeEffectSlot slot) noexcept;
    [[nodiscard]] bool setParameter(
        NativeEffectSlot slot,
        std::string_view parameterId,
        float value,
        std::uint64_t rampFrames = 0U
    ) noexcept;
    [[nodiscard]] bool setBypassed(NativeEffectSlot slot, bool bypassed, std::uint64_t rampFrames = 0U) noexcept;
    void resetState() noexcept;

    [[nodiscard]] std::string_view effectId(NativeEffectSlot slot) const noexcept;
    [[nodiscard]] bool isBypassed(NativeEffectSlot slot) const noexcept;
    [[nodiscard]] bool hasEffects() const noexcept;
    [[nodiscard]] NativeEffectProcessor* processor(NativeEffectSlot slot) noexcept;
    [[nodiscard]] const NativeEffectProcessor* processor(NativeEffectSlot slot) const noexcept;

    [[nodiscard]] float processInPlace(float* interleaved, unsigned int frames, unsigned int channels) noexcept;
    [[nodiscard]] unsigned int sampleRate() const noexcept { return sampleRate_; }

private:
    [[nodiscard]] static bool validSlot(NativeEffectSlot slot) noexcept;
    std::array<std::unique_ptr<NativeEffectProcessor>, kSlotCount> slots_{};
    unsigned int sampleRate_ = 0U;
};

} // namespace webrc::native
