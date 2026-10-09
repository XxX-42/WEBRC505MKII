#pragma once

#include "webrc/dsp/spatial_temporal.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp {

constexpr std::uint32_t kRhythmTicksPerQuarter = 960;

enum class RhythmInstrument : std::uint8_t {
    Kick = 0,
    Snare,
    ClosedHat,
    OpenHat,
    Ride,
    TomLow,
    TomHigh,
    Clap,
    Rim,
    CongaLow,
    CongaHigh,
    Shaker,
    BrushSweep,
    Count,
};

struct RhythmEvent {
    std::uint32_t tick = 0;
    RhythmInstrument instrument = RhythmInstrument::Kick;
    std::uint8_t velocity = 100;
    bool swingable = false;
    std::uint32_t durationTicks = 0;
};

struct RhythmEventList {
    const RhythmEvent* events = nullptr;
    std::uint32_t count = 0;
};

struct RhythmPatternView {
    std::uint16_t numerator = 4;
    std::uint16_t denominator = 4;
    float swingAmount = 0.0f;
    std::array<RhythmEventList, 4> variations{};
    RhythmEventList intro{};
    RhythmEventList fill{};
    RhythmEventList ending{};
};

struct CleanRoomKitProfile {
    const char* name = "";
    KickVoiceParameters kick{};
    SnareVoiceParameters snare{};
    HiHatVoiceParameters closedHat{};
    HiHatVoiceParameters openHat{};
    DrumVoiceParameters modal{};
    float brushSweepAmplitude = 0.13f;
    float brushSweepSeconds = 0.18f;
    float brushSweepHighpassHz = 4200.0f;
};

[[nodiscard]] std::uint32_t cleanRoomKitCount() noexcept;
[[nodiscard]] const CleanRoomKitProfile* cleanRoomKitProfile(std::uint32_t index) noexcept;

enum class RhythmSection : std::uint8_t {
    Stopped,
    Intro,
    VariationA,
    VariationB,
    VariationC,
    VariationD,
    Fill,
    Ending,
};

// Non-owning, immutable pattern view plus fixed-size event/brush staging areas.
// Set the view and kit while stopped, then start on the audio thread at an
// absolute frame. The view and all event arrays must outlive playback. Queue
// calls are UI-thread-safe while prepare/reset is quiescent. A host timeline
// discontinuity resets transport and clears queued commands; callers should
// reissue any controls they still want after the timeline is re-established.
// At a bar boundary,
// variation updates the resume variation, then ending takes priority over stop,
// and stop takes priority over fill; variation plus fill means "fill, then
// resume that variant".
// Multiple queued variation values and tempo values are latest-wins before a
// boundary. Repeated fill/ending/stop requests coalesce into sticky flag bits;
// ending > stop > fill, while a queued variation is retained across a fill.
// Prepare and queued tempos quantize positive BPM to unsigned Q16.16 with
// round-to-nearest/half-away-from-zero, then apply on a downbeat; binary64
// absolute frame phase is carried through changes to avoid per-bar rounding
// drift. This renderer accepts absolute timestamps below 2^53 frames so every
// integer frame remains exactly representable in its binary64 phase accumulator.
// Commands queued during the terminal Ending bar are discarded when it stops.
// Requested starts older than the first processed frame clamp to that frame.
// processBlock expects contiguous frame ranges; a gap/backwards timestamp
// silences and resets transport, returning false.
class RhythmRenderer {
public:
    static constexpr std::uint32_t kMaxEventsPerSection = 192;

    bool prepare(const ProcessSpec& spec, double bpm) noexcept;
    void reset() noexcept;
    bool setPattern(const RhythmPatternView* pattern) noexcept;
    bool setKit(std::uint32_t kitIndex) noexcept;
    bool startAtFrame(std::uint64_t absoluteFrame, bool playIntro = true) noexcept;
    bool queueVariation(std::uint8_t variation) noexcept;
    bool queueFill() noexcept;
    bool queueEnding() noexcept;
    bool queueStop() noexcept;
    bool queueTempo(double bpm) noexcept;
    bool processBlock(std::uint64_t blockStartFrame, float* outputLeft, float* outputRight,
                      std::uint32_t frames) noexcept;

    [[nodiscard]] bool prepared() const noexcept { return prepared_; }
    [[nodiscard]] bool playing() const noexcept { return playing_; }
    [[nodiscard]] double tempoBpm() const noexcept { return bpm_; }
    [[nodiscard]] RhythmSection currentSection() const noexcept { return section_; }
    [[nodiscard]] std::uint8_t currentVariation() const noexcept { return variation_; }
    [[nodiscard]] std::uint64_t completedBars() const noexcept { return barIndex_; }
    [[nodiscard]] std::uint32_t activeVoices() const noexcept { return voices_.activeVoices(); }
    [[nodiscard]] std::uint64_t triggeredEvents() const noexcept { return triggeredEvents_; }
    [[nodiscard]] std::uint64_t lastTriggeredFrame() const noexcept { return lastTriggeredFrame_; }

    [[nodiscard]] static constexpr std::uint32_t algorithmicLatencySamples() noexcept { return 0; }
    [[nodiscard]] static std::size_t requiredMemoryBytes() noexcept;

private:
    enum PendingFlag : std::uint32_t {
        FillPending = 1U << 0U,
        EndingPending = 1U << 1U,
        StopPending = 1U << 2U,
    };
    struct StagedEvent {
        std::uint64_t frame = 0;
        RhythmInstrument instrument = RhythmInstrument::Kick;
        std::uint8_t velocity = 0;
        std::uint32_t durationFrames = 0;
    };
    struct BrushSweepVoice {
        std::uint64_t randomLeft = 1;
        std::uint64_t randomRight = 2;
        std::uint32_t remaining = 0;
        float amplitude = 0.0f;
        float envelope = 0.0f;
        float envelopeStep = 0.0f;
        float lowLeft = 0.0f;
        float lowRight = 0.0f;
        float lowCoefficient = 0.0f;
        bool active = false;
    };

    [[nodiscard]] bool validatePattern(const RhythmPatternView& pattern) const noexcept;
    [[nodiscard]] bool beginPlayback(std::uint64_t currentFrame) noexcept;
    [[nodiscard]] bool beginNextBar(std::uint64_t barStartFrame) noexcept;
    [[nodiscard]] bool loadSectionEvents(std::uint64_t barStartFrame) noexcept;
    [[nodiscard]] std::uint64_t frameForTicks(std::uint64_t ticks) const noexcept;
    [[nodiscard]] std::uint64_t absoluteFrameAt(double exactFrame) const noexcept;
    void applyPendingTempo() noexcept;
    void trigger(const StagedEvent& event, std::uint64_t absoluteFrame) noexcept;
    void triggerBrushSweep(const StagedEvent& event, std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] StereoFrame processBrushSweeps() noexcept;
    [[nodiscard]] StereoFrame processVoice() noexcept;

    DrumVoicePool voices_{};
    std::array<StagedEvent, kMaxEventsPerSection> stagedEvents_{};
    std::array<BrushSweepVoice, 4> brushSweepVoices_{};
    std::atomic<std::uint32_t> pendingFlags_{0};
    std::atomic<std::uint32_t> pendingVariation_{0};
    std::atomic<std::uint32_t> pendingTempoQ16_16_{0};
    const RhythmPatternView* pattern_ = nullptr;
    CleanRoomKitProfile kit_{};
    ProcessSpec spec_{};
    std::uint64_t requestedStartFrame_ = 0;
    std::uint64_t barOriginFrame_ = 0;
    std::uint64_t nextBarFrame_ = 0;
    double barOriginExactFrame_ = 0.0;
    double nextBarExactFrame_ = 0.0;
    std::uint64_t expectedBlockFrame_ = 0;
    std::uint64_t barIndex_ = 0;
    std::uint64_t triggeredEvents_ = 0;
    std::uint64_t lastTriggeredFrame_ = 0;
    double bpm_ = 120.0;
    double framesPerTick_ = 0.0;
    std::uint32_t stagedCount_ = 0;
    std::uint32_t stagedCursor_ = 0;
    std::uint32_t kitIndex_ = 0;
    std::uint8_t variation_ = 0;
    RhythmSection section_ = RhythmSection::Stopped;
    bool startRequested_ = false;
    bool startWithIntro_ = true;
    bool playbackArmed_ = false;
    bool hasExpectedBlockFrame_ = false;
    bool playing_ = false;
    bool prepared_ = false;
};

} // namespace webrc::dsp
