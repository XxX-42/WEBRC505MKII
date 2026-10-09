#pragma once

#include "webrc/dsp/live_mono_pitch.hpp"
#include "webrc/dsp/signalsmith_adapter.hpp"

#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

enum class PitchProfileId : std::uint8_t {
    LiveMono = 1,
    LivePoly = 2,
    HqRender = 3,
};

struct PitchProfileSettings {
    PitchProfileId profile = PitchProfileId::LiveMono;
    ProcessSpec spec{};
    LiveMonoPitchSettings liveMono{};
    SignalsmithStretchSettings signalsmith{};
};

// Constructs the distinct, versioned processing configurations used by Native
// and Web clients. LIVE_MONO is incremental YIN -> streaming TD-PSOLA; LIVE_POLY
// and HQ_RENDER both use the pinned Signalsmith engine but have different
// windows and split-computation behavior. This is a configuration builder, not
// a claim that either Signalsmith profile has passed a real-time admission gate.
[[nodiscard]] bool makePitchProfileSettings(PitchProfileId profile,
                                            float sampleRate,
                                            std::uint32_t maxBlockFrames,
                                            std::uint32_t seed,
                                            PitchProfileSettings& output,
                                            std::uint32_t liveMonoWorkBudget = 32768U) noexcept;

enum class PitchProfileLatencyModel : std::uint8_t {
    Unavailable = 0,
    DetectorWindowPlusResynthesisLookahead = 1,
    SignalsmithEngineInputAndOutputGetters = 2,
};

struct PitchProfileLatency {
    PitchProfileLatencyModel model = PitchProfileLatencyModel::Unavailable;
    // Populated for LIVE_MONO; this is a declared component bound, not a
    // measured end-to-end or callback-to-output latency.
    std::uint64_t declaredWindowPlusResynthesisSamples = 0U;
    // Populated from Signalsmith's API for LIVE_POLY/HQ_RENDER. Keep the two
    // independently reported quantities separate; do not add or rename them
    // as a single observed graph latency.
    std::int32_t inputSamples = 0;
    std::int32_t outputSamples = 0;
};

// A single-route processor wrapper. The selected profile is immutable after
// the first successful prepare; change profiles by preparing a separate
// candidate off the audio thread and swapping the containing graph. Calls are
// single-owner and process methods do not allocate.
class PitchProfileProcessor {
public:
    explicit PitchProfileProcessor(std::uint32_t seed = 1U) noexcept;
    PitchProfileProcessor(const PitchProfileProcessor&) = delete;
    PitchProfileProcessor& operator=(const PitchProfileProcessor&) = delete;

    [[nodiscard]] static std::size_t requiredPrepareBytes(
        const PitchProfileSettings& settings) noexcept;
    bool prepare(const PitchProfileSettings& settings,
                 std::size_t activePlusCandidateBudgetBytes) noexcept;
    void reset() noexcept;
    bool setPitchRatio(float ratio) noexcept;

    // Valid only for LIVE_MONO. It deliberately requires mono buffers rather
    // than silently downmixing or duplicating stereo.
    bool processMono(const float* input, float* output, std::uint32_t frames) noexcept;
    // Valid only for LIVE_POLY/HQ_RENDER and processes independent stereo
    // channels through the shared Signalsmith adapter.
    bool processStereo(const float* inputLeft, const float* inputRight,
                       float* outputLeft, float* outputRight,
                       std::uint32_t frames) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] PitchProfileId profile() const noexcept { return settings_.profile; }
    [[nodiscard]] const PitchProfileSettings& settings() const noexcept { return settings_; }
    [[nodiscard]] PitchProfileLatency latency() const noexcept;
    [[nodiscard]] const LiveMonoPitchRoute& liveMonoRoute() const noexcept { return liveMono_; }

private:
    const std::uint32_t seed_;
    PitchProfileSettings settings_{};
    LiveMonoPitchRoute liveMono_{};
    SignalsmithStretchAdapter signalsmith_;
    std::size_t preparedBytes_ = 0U;
    bool prepared_ = false;
};

} // namespace webrc::dsp
