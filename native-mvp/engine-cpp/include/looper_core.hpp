#pragma once

#include <cstddef>
#include <cstdint>
#include <array>
#include <vector>

namespace webrc::native {

enum class LooperState : std::uint8_t {
    Empty = 0,
    Recording,
    Stopped,
    Playing,
    Overdubbing,
};

enum class CommandType : std::uint8_t {
    Record = 0,
    StopRecordOrPlayback,
    Play,
    ToggleOverdub,
    Clear,
    SetMonitoring,
};

// Source-aware effects that read the stored loop before tracks are summed.
// Off is the default and preserves the historical one-sample-per-frame path.
enum class LoopTransportMode : std::uint8_t {
    Off = 0,
    BeatShift,
    VinylFlick,
};

struct LoopTransportConfig {
    LoopTransportMode mode = LoopTransportMode::Off;
    // BEAT SHIFT: signed beat offset, tempo in beats per minute and a
    // click-free parameter-transition crossfade. Offsets may be fractional.
    float beatOffsetBeats = 0.0f;
    float bpm = 120.0f;
    float crossfadeMs = 5.0f;
    // VINYL FLICK: 0 is 1x, -100 is stop, +100 is 2x.
    float vinylSpeedPercent = 0.0f;
    float motorReturnSeconds = 1.0f;
    float brakePercent = 0.0f;
    float vinylMixPercent = 100.0f;
};

// Runtime reporting is per LooperCore. Transport is audible only while
// Playing; recording and overdub remain dry/canonical and are reported rather
// than silently treated as active. WaitingForPlayback means a valid config is
// queued for the next play pass, not that samples were transported.
enum class LoopTransportStatus : std::uint8_t {
    Disabled = 0,
    WaitingForLoop,
    WaitingForPlayback,
    Active,
    UnsupportedRecording,
    UnsupportedOverdubbing,
    UnsupportedPitchProcessing,
};

struct Command {
    CommandType type;
    bool boolValue = false;
    std::uint8_t trackIndex = 0U;
};

struct ProcessStats {
    LooperState state = LooperState::Empty;
    float loopProgress = 0.0f;
    float inputPeak = 0.0f;
    float outputPeak = 0.0f;
    LoopTransportStatus loopTransportStatus = LoopTransportStatus::Disabled;
};

struct LoopMetadata {
    LooperState state = LooperState::Empty;
    std::size_t recordedFrames = 0U;
    std::size_t finalizedFrames = 0U;
    std::size_t playhead = 0U;
};

class LooperCore {
public:
    static constexpr unsigned int kMaximumSampleRate = 192000U;
    static constexpr std::size_t kMaximumLoopSeconds = 300U;
    // The five stereo loop stores share a user-selectable bounded budget. The
    // default preserves 300 seconds at 48 kHz; higher rates can be admitted by
    // explicitly selecting a larger budget before stream setup.
    static constexpr std::uint64_t kDefaultAggregateLoopStorageBudgetBytes = 768ULL * 1024ULL * 1024ULL;
    static constexpr std::uint64_t kMinimumAggregateLoopStorageBudgetBytes = 64ULL * 1024ULL * 1024ULL;
    static constexpr std::uint64_t kMaximumAggregateLoopStorageBudgetBytes = 3ULL * 1024ULL * 1024ULL * 1024ULL;

    [[nodiscard]] static std::size_t maximumDurationSecondsForBudget(
        unsigned int sampleRate,
        unsigned int channels,
        std::size_t trackCount,
        std::size_t requestedSeconds = kMaximumLoopSeconds,
        std::uint64_t budgetBytes = kDefaultAggregateLoopStorageBudgetBytes
    ) noexcept;

    explicit LooperCore(unsigned int sampleRate = 48000, std::size_t maxLoopSeconds = 300, unsigned int channels = 1);

    // channels selects the stored track layout: one channel retains the
    // original mono behavior; two channels store an independent stereo pair.
    // The full bounded capacity is allocated and page-touched on the control
    // thread so first recording writes do not commit lazy pages in a callback.
    // False means the requested configuration exceeded limits or allocation
    // failed; on a changed format the looper remains unprepared and cannot
    // record until a later successful prepare.
    [[nodiscard]] bool prepare(unsigned int sampleRate, std::size_t maxLoopSeconds = 300, unsigned int channels = 1);
    void applyCommand(const Command& command);
    // Called from the callback owner (or while audio is stopped). Invalid
    // ranges and enum values are rejected without changing the active config.
    [[nodiscard]] bool setLoopTransportConfig(const LoopTransportConfig& config) noexcept;
    [[nodiscard]] static bool validLoopTransportConfig(const LoopTransportConfig& config) noexcept;
    [[nodiscard]] const LoopTransportConfig& loopTransportConfig() const noexcept { return loopTransportConfig_; }
    [[nodiscard]] LoopTransportStatus loopTransportStatus() const noexcept { return transportStatusForState(); }
    ProcessStats process(
        const float* inputInterleaved,
        float* outputInterleaved,
        unsigned int frames,
        unsigned int inputChannels,
        unsigned int outputChannels,
        // Optional dry loop-playback tap. It excludes live monitoring and
        // rhythm, allowing a later track-FX stage to affect playback without
        // changing the signal written by record/overdub.
        float* playbackOnlyInterleaved = nullptr,
        // Set false when a caller replaces this meter with a later output-stage
        // peak. Input metering and all audio/state processing remain enabled.
        bool measureOutputPeak = true
    );

    // Caller must own audio/transport state; this is not a concurrent snapshot API.
    // Same-block, read-only finalized Playing tap. No monitoring, recording,
    // overdub, cursor advance or allocation. Invalid capacity/layout is rejected
    // before writes; unavailable playback returns false with explicit silence.
    [[nodiscard]] bool previewPlayback(float* destination, unsigned int frames,
        unsigned int outputChannels, unsigned int capacityFrames) const noexcept;

    [[nodiscard]] LooperState state() const noexcept;
    [[nodiscard]] bool monitoringEnabled() const noexcept;
    [[nodiscard]] unsigned int sampleRate() const noexcept;
    [[nodiscard]] std::uint64_t loopLengthSamples() const noexcept;
    [[nodiscard]] std::size_t storageBytes() const noexcept;
    [[nodiscard]] std::size_t capacityFrames() const noexcept;

    // Copies the finalized mono loop to a caller-owned buffer. The caller must
    // guarantee that no callback can apply a loop-mutating command for the
    // duration of this copy. NativeAudioCore provides that callback-boundary
    // pin; this method deliberately does not add locking to the audio path.
    [[nodiscard]] bool copyFinalizedLoopSnapshot(
        float* destination,
        std::size_t destinationFrames,
        std::size_t& copiedFrames
    ) const noexcept;

    // Copies a finalized loop as interleaved stereo. Mono loops are duplicated
    // to L/R. destinationFrames is a frame count, so the destination must hold
    // at least destinationFrames * 2 samples.
    [[nodiscard]] bool copyFinalizedStereoLoopSnapshot(
        float* destination,
        std::size_t destinationFrames,
        std::size_t& copiedFrames
    ) const noexcept;

    [[nodiscard]] unsigned int channels() const noexcept;
    [[nodiscard]] LoopMetadata metadata() const noexcept;
    // Caller must hold a callback-boundary pin. Restores transport metadata
    // only; PCM storage and its full prepared capacity are never replaced.
    void restoreMetadata(const LoopMetadata& metadata) noexcept;
    // Swaps finalized PCM with a caller-owned interleaved stereo buffer, one
    // frame at a time. Control-thread only, while the callback is pinned.
    [[nodiscard]] bool exchangeFinalizedStereoSamples(float* samples, std::size_t frames) noexcept;
    // O(1) full-capacity storage swap for a staged project import. The caller
    // must provide the same prepared stereo capacity; the vector receives the
    // old storage so it can be reclaimed later on the control thread. No
    // allocation, copy, or destruction occurs in this method.
    [[nodiscard]] bool swapImportedStereoStorage(
        std::vector<float>& fullCapacitySamples,
        std::size_t frames
    ) noexcept;

private:
    void clearLoop();
    static float clampSample(float value) noexcept;
    [[nodiscard]] double wrappedLoopPosition(double position) const noexcept;
    void readLoopAt(double position, bool useLagrange4, float& left, float& right) const noexcept;
    [[nodiscard]] double beatShiftPosition(double canonicalPosition, double normalizedOffset) const noexcept;
    struct PlaybackCursor {
        std::size_t playhead;
        std::size_t fadeRemaining;
        double vinylPosition;
        double vinylSpeed;
        double vinylAcceleration;
    };
    [[nodiscard]] PlaybackCursor playbackCursor() const noexcept;
    void commitPlaybackCursor(const PlaybackCursor& cursor) noexcept;
    void readPlayingFrame(PlaybackCursor& cursor, float& left, float& right) const noexcept;
    void advanceVinylPlatter(PlaybackCursor& cursor) const noexcept;
    [[nodiscard]] LoopTransportStatus transportStatusForState() const noexcept;
    void updateBeatShiftOffsets() noexcept;
    void prepareTransportCrossfadeLut() noexcept;
    void getTransportCrossfadeGains(double progress, double& oldGain, double& newGain) const noexcept;

    unsigned int sampleRate_;
    std::size_t maxLoopSeconds_;
    std::size_t capacityFrames_;
    unsigned int channels_;
    std::vector<float> loopBuffer_;
    LooperState state_;
    bool monitoringEnabled_;
    std::size_t recordedFrames_;
    std::size_t finalizedFrames_;
    std::size_t playhead_;
    LoopTransportConfig loopTransportConfig_{};
    LoopTransportConfig previousLoopTransportConfig_{};
    std::size_t transportFadeFrames_ = 0U;
    std::size_t transportFadeRemaining_ = 0U;
    double fadeStartVinylPosition_ = 0.0;
    double fadeStartVinylSpeed_ = 1.0;
    double vinylReadPosition_ = 0.0;
    double vinylSpeedRatio_ = 1.0;
    double vinylAcceleration_ = 0.0;
    double beatShiftOffsetSamples_ = 0.0;
    double previousBeatShiftOffsetSamples_ = 0.0;
    static constexpr std::size_t kTransportCrossfadeLutSize = 1024U;
    std::array<float, kTransportCrossfadeLutSize + 1U> transportFadeOldGainLut_{};
    std::array<float, kTransportCrossfadeLutSize + 1U> transportFadeNewGainLut_{};
};

} // namespace webrc::native
