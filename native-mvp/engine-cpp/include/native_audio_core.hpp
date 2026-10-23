#pragma once

#include "looper_core.hpp"
#include "native_autopan_processor.hpp"
#include "native_osc_voc_processor.hpp"
#include "native_output_stage.hpp"
#include "native_pitch_processor.hpp"
#include "native_poly_pitch_processor.hpp"
#include "project_archive_codec.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "RtAudio.h"

namespace webrc::native {

inline constexpr std::size_t kNativeTrackCount = 5U;
inline constexpr std::uint64_t kNativeHistoryBudgetBytes = 512ULL * 1024ULL * 1024ULL;
inline constexpr std::uint64_t kNativeProjectImportPeakBudgetBytes = 3ULL * 1024ULL * 1024ULL * 1024ULL;

inline constexpr std::size_t kNativeCallbackDurationBins = 512U;
inline constexpr std::uint64_t kNativeCallbackDurationBinWidthNs = 50000U;
struct NativeCallbackTelemetryStatus {
    bool observed = false;
    std::uint64_t callbackCount = 0U;
    std::uint64_t hardwareCallbackCount = 0U;
    std::array<std::uint64_t, 3U> callbacksByKind{}; // duplex, input, output
    std::array<std::uint64_t, 3U> statusFlags{}; // input overflow, output underflow, unknown bits
    std::array<std::uint64_t, 3U> hardwareStatusFlags{};
    std::uint64_t audioQueueOverflow = 0U;
    std::uint64_t audioQueueUnderflow = 0U;
    std::uint64_t controlQueueReject = 0U;
    std::uint64_t oversizeCallback = 0U;
    std::uint64_t nonFiniteInput = 0U;
    std::uint64_t nonFiniteOutput = 0U;
    std::uint64_t deadlineMiss = 0U;
    std::uint64_t deadlineEvaluatedCallbacks = 0U;
    std::uint64_t runtimeResetCount = 0U;
    std::uint64_t timingSamples = 0U;
    std::uint64_t maximumDurationNs = 0U;
    std::optional<std::uint64_t> p99UpperBoundNs;
    std::optional<std::uint64_t> p999UpperBoundNs;
    std::array<unsigned int, 3U> latestSampleRate{};
    std::array<unsigned int, 3U> latestBufferFrames{};
    std::array<std::uint64_t, kNativeCallbackDurationBins> durationHistogram{};
};

enum class NativeProjectImportState : std::uint8_t { Idle = 0U, Prepared, Pending, Claimed, Committed, Cancelled };

struct NativeMemoryFxSlot {
    std::string effectId;
    std::map<std::string, float> parameters;
    bool bypassed = false;
};
// Control-thread description, ordered Input/shared Track/private Track 1..5.


struct NativeProjectImportStatus {
    bool found = false;
    std::uint64_t generation = 0U;
    NativeProjectImportState state = NativeProjectImportState::Idle;
    std::string error;
};

enum class NativeHistoryFailure : std::uint8_t { None = 0U, BudgetExceeded, SnapshotUnavailable, NoUndo, NoRedo, TrackMustBeStopped };

struct NativeTrackHistoryStatus {
    bool canUndo = false;
    bool canRedo = false;
    std::uint64_t retainedPcmBytes = 0U;
    NativeHistoryFailure unavailableReason = NativeHistoryFailure::None;
};

struct NativeTrackMarkStatus {
    bool exists = false;
    bool canSet = false;
    bool canClear = false;
    bool busy = false;
    std::uint64_t retainedPcmBytes = 0U;
    std::string unavailableReason = "noCommittedOverdub";
    std::uint64_t requestedGeneration = 0U;
    std::uint64_t appliedGeneration = 0U;
};

struct NativeTrackFxApplyStatus {
    bool requested = true;
    bool applied = true;
    bool controlFaulted = false;
    std::uint64_t requestedRevision = 0U;
    std::uint64_t appliedRevision = 0U;
    std::uint64_t semanticRevision = 0U;
    float peak = 0.0f;
    float rms = 0.0f;
};

enum class NativePitchMode : std::uint8_t { LiveMonoKeepPitch = 0, LivePolyPhaseVocoder };

enum class Backend : std::uint8_t {
    Wasapi = 0,
    Asio,
};

struct DeviceDescriptor {
    std::string id;
    std::string name;
    std::vector<unsigned int> sampleRates;
    bool isDefault = false;
    unsigned int maxInputChannels = 0U;
    unsigned int maxOutputChannels = 0U;
};

struct DeviceCatalog {
    std::vector<std::string> backends;
    std::map<std::string, std::vector<DeviceDescriptor>> inputsByBackend;
    std::map<std::string, std::vector<DeviceDescriptor>> outputsByBackend;
    std::map<std::string, std::string> defaultInputIdByBackend;
    std::map<std::string, std::string> defaultOutputIdByBackend;
    std::vector<unsigned int> bufferOptions;
};

struct EngineConfig {
    Backend backend = Backend::Wasapi;
    std::string inputDeviceId;
    std::string outputDeviceId;
    unsigned int sampleRate = 48000;
    unsigned int bufferFrames = 128;
    bool monitoringEnabled = false;
    std::uint64_t nativeLooperStorageBudgetBytes = LooperCore::kDefaultAggregateLoopStorageBudgetBytes;
};

struct EngineStatus {
    std::array<unsigned int, 7> mixerLevels{100U, 100U, 100U, 100U, 100U, 100U, 100U};
    bool bridgeHealthy = true;
    bool engineRunning = false;
    Backend backend = Backend::Wasapi;
    std::string inputDeviceId;
    std::string outputDeviceId;
    std::string inputDeviceName;
    std::string outputDeviceName;
    unsigned int sampleRate = 0;
    unsigned int bufferFrames = 0;
    bool monitoringEnabled = false;
    bool nativeOutputLowPassAvailable = true;
    bool nativeOutputLowPassEnabled = false;
    bool nativeOutputHighPassAvailable = true;
    bool nativeOutputHighPassEnabled = false;
    // Retained for JSON/source compatibility; Native distortion is unavailable.
    bool nativeOutputDriveAvailable = false;
    bool nativeOutputDriveEnabled = false;
    bool nativeReverbAvailable = true;
    bool nativeReverbEnabled = false;
    float nativeReverbWetMix = 0.25f;
    float nativeReverbRt60Seconds = 2.0f;
    float nativeReverbDampingCutoffHz = 7000.0f;
    unsigned int nativeReverbAlgorithmicLatencyFrames = 0;
    bool nativeTrackOutputBankAvailable = true;
    std::array<bool, 4> nativeTrackOutputSlotActive = NativeTrackOutputBank::kActiveSlots;
    bool nativeTrackOutputMultiTrackImplemented = false;
    bool nativeFractionalDelayAvailable = true;
    bool nativeFractionalDelayEnabled = false;
    NativeTrackOutputSlot nativeFractionalDelaySlot = NativeTrackOutputSlot::A;
    NativeFractionalDelayAlgorithm nativeFractionalDelayAlgorithm = NativeFractionalDelayAlgorithm::Lagrange4;
    float nativeFractionalDelayMs = 350.0f;
    float nativeFractionalDelayWetMix = 0.3f;
    float nativeFractionalDelayFeedback = 0.35f;
    float nativeFractionalDelayMaxMs = 2000.0f;
    bool nativeCompressorAvailable = true;
    bool nativeCompressorEnabled = false;
    NativeTrackOutputSlot nativeCompressorSlot = NativeTrackOutputSlot::A;
    NativeCompressorAlgorithm nativeCompressorAlgorithm = NativeCompressorAlgorithm::PeakCompressor;
    float nativeCompressorThresholdDb = -18.0f;
    float nativeCompressorRatio = 4.0f;
    float nativeCompressorAttackMs = 10.0f;
    float nativeCompressorReleaseMs = 120.0f;
    float nativeCompressorWetMix = 1.0f;
    float nativeCompressorMakeupDb = 0.0f;
    bool nativeChorusAvailable = true;
    bool nativeChorusEnabled = false;
    NativeTrackOutputSlot nativeChorusSlot = NativeTrackOutputSlot::A;
    NativeChorusAlgorithm nativeChorusAlgorithm = NativeChorusAlgorithm::StereoLfoLagrange4;
    float nativeChorusRateHz = 0.8f;
    float nativeChorusDepthMs = 5.0f;
    float nativeChorusFeedback = 0.0f;
    float nativeChorusWetMix = 0.25f;
    bool nativePhaserAvailable = true;
    bool nativePhaserEnabled = false;
    NativeTrackOutputSlot nativePhaserSlot = NativeTrackOutputSlot::A;
    NativePhaserAlgorithm nativePhaserAlgorithm = NativePhaserAlgorithm::AllpassSweep;
    unsigned int nativePhaserStages = 8U;
    float nativePhaserRateHz = 0.5f;
    float nativePhaserDepth = 0.65f;
    float nativePhaserFeedback = 0.0f;
    float nativePhaserWetMix = 0.5f;
    bool nativeAutoPanAvailable = true;
    bool nativeAutoPanEnabled = false;
    NativeTrackOutputSlot nativeAutoPanSlot = NativeTrackOutputSlot::A;
    NativeAutoPanAlgorithm nativeAutoPanAlgorithm = NativeAutoPanAlgorithm::EqualPowerMidSideLfo;
    float nativeAutoPanRateHz = 0.5f;
    float nativeAutoPanDepth = 0.7f;
    NativeAutoPanWaveform nativeAutoPanWaveform = NativeAutoPanWaveform::Sine;
    float nativeAutoPanWetMix = 1.0f;
    std::array<LoopTransportConfig, kNativeTrackCount> nativeMemoryLoopTransports{};
    std::array<std::string, NativeEffectBank::kSlotCount> nativeCatalogSlotEffectIds{};
    std::array<bool, NativeEffectBank::kSlotCount> nativeCatalogSlotBypassed{};
    std::array<std::string, NativeEffectBank::kSlotCount> nativeInputCatalogSlotEffectIds{};
    std::array<bool, NativeEffectBank::kSlotCount> nativeInputCatalogSlotBypassed{};
    struct NativePerTrackCatalogSlotStatus {
        std::string effectId;
        std::map<std::string, float> parameters; // Normalized authored controls for requestedRevision
        bool bypassed = false; // Last accepted control request
        bool appliedBypassed = false; // Published by the DSP owner
        bool prepared = false;
        bool processingFaulted = false;
        bool controlFaulted = false;
        std::uint64_t requestedRevision = 0U;
        std::uint64_t appliedRevision = 0U;
    };
    std::array<NativePerTrackCatalogSlotStatus, NativeEffectBank::kSlotCount> nativeInputCatalogSlots{};
    std::array<NativePerTrackCatalogSlotStatus, NativeEffectBank::kSlotCount> nativeCatalogSlots{};
    bool nativePerTrackCatalogAvailable = true;
    std::array<std::array<NativePerTrackCatalogSlotStatus, NativeEffectBank::kSlotCount>, kNativeTrackCount>
        nativePerTrackCatalogSlots{};
    std::uint64_t nativeCatalogControlFaultCount = 0U;
    bool nativeCatalogGraphAvailable = true;
    bool fullFxGraphImplemented = false;
    bool nativeRhythmAvailable = true;
    bool nativeRhythmEnabled = false;
    bool nativeRhythmPatternCatalogAvailable = false;
    unsigned int nativeRhythmPatternIndex = 1U;
    std::string nativeRhythmPatternId;
    std::string nativeRhythmGenre;
    std::string nativeRhythmPatternName;
    std::string nativeRhythmBeat;
    unsigned int nativeRhythmMeterNumerator = 4U;
    unsigned int nativeRhythmMeterDenominator = 4U;
    bool nativeRhythmEventsCleanRoomProcedural = true;
    bool nativePitchCorrectionAvailable = false;
    bool nativePitchCorrectionImplemented = false;
    bool nativePitchEnabled = false;
    // 0 preserves the legacy global summed-playback route; 1..5 targets one looper.
    std::uint8_t nativePitchTrackId = 0U;
    NativePitchMode nativePitchMode = NativePitchMode::LiveMonoKeepPitch;
    bool nativePitchReversePlayback = false;
    bool nativePitchActive = false;
    bool nativePitchVoiced = false;
    float nativePitchSemitones = 0.0f;
    float nativePitchFrequencyHz = 0.0f;
    float nativePitchConfidence = 0.0f;
    unsigned int nativePitchLatencySamples = 0U;
    NativePitchFallbackReason nativePitchFallbackReason = NativePitchFallbackReason::NotRequested;
    double nativeRhythmBpm = 120.0;
    unsigned int nativeRhythmKitIndex = 1;
    NativeRhythmVariation nativeRhythmVariation = NativeRhythmVariation::A;
    NativeRhythmSection nativeRhythmSection = NativeRhythmSection::Main;
    unsigned int nativeRhythmSwingPercent = 50U;
    NativeRhythmQuantizeGrid nativeRhythmQuantizeGrid = NativeRhythmQuantizeGrid::Sixteenth;
    unsigned int nativeRhythmVolume = 50U;
    LooperState state = LooperState::Empty;
    unsigned int nativeLooperTrackCount = 0U;
    bool nativeLooperMultiTrackImplemented = false;
    bool nativeLooperTracksStereo = false;
    unsigned int nativeLooperMaxRecordSeconds = 0U;
    std::uint64_t nativeLooperPreallocatedBytes = 0U;
    std::uint64_t nativeLooperStorageBudgetBytes = LooperCore::kDefaultAggregateLoopStorageBudgetBytes;
    double inputLatencyMs = 0.0;
    double outputLatencyMs = 0.0;
    double roundTripEstimateMs = 0.0;
    float inputPeak = 0.0f;
    float outputPeak = 0.0f;
    unsigned int xrunsOrDropouts = 0;
    NativeCallbackTelemetryStatus callbackTelemetry;
    std::string lastError;
    float loopProgress = 0.0f;
    std::array<LooperState, kNativeTrackCount> nativeTrackStates{};
    std::array<NativeVocoderCarrierStatus, kNativeTrackCount> nativeVocoderCarrierStatuses{};
    std::array<float, kNativeTrackCount> nativeTrackProgress{};
    std::array<std::uint64_t, kNativeTrackCount> nativeTrackContentRevision{};
    /** Host epoch for loop PCM/history and import-overwritten track-state changes. */
    std::uint64_t projectContentRevision = 0U;
    /** True only when project-relevant status fields were sampled without an epoch change. */
    bool projectContentRevisionSnapshotStable = false;
    std::array<LoopTransportStatus, kNativeTrackCount> nativeTrackLoopTransportStatus{};
    std::array<NativeTrackHistoryStatus, kNativeTrackCount> nativeTrackHistory{};
    bool nativeTrackFxApplyAvailable = true;
    std::array<NativeTrackFxApplyStatus, kNativeTrackCount> nativeTrackFxApply{};
    std::uint64_t nativeHistoryBudgetBytes = kNativeHistoryBudgetBytes;
    std::uint64_t nativeHistoryRetainedBytes = 0U;
    std::uint32_t nativeMarkVersion = 1U;
    std::array<NativeTrackMarkStatus, kNativeTrackCount> nativeTrackMarks{};
    std::uint64_t nativeMarkBudgetBytes = kNativeHistoryBudgetBytes;
    std::uint64_t nativeMarkRetainedBytes = 0U;
    double streamTimeSeconds = 0.0;
    unsigned long long callbackTicks = 0;
    std::uint64_t nativeSampleFrame = 0U;
    struct NativeOscVocSlotStatus {
        bool selected = false;
        std::uint64_t currentFrame = 0U;
        std::size_t queuedEvents = 0U;
        std::uint64_t overflowEventCount = 0U;
        std::uint64_t lateEventCount = 0U;
        std::uint64_t rejectedEventCount = 0U;
    };
    std::array<NativeOscVocSlotStatus, NativeEffectBank::kSlotCount> nativeInputOscVocSlots{};
    std::array<NativeOscVocSlotStatus, NativeEffectBank::kSlotCount> nativeTrackOscVocSlots{};
    struct NativeCatalogMidiSlotStatus {
        bool selected = false;
        std::string effectId;
        std::size_t queueCapacity = 0U;
        std::uint64_t currentFrame = 0U;
        std::size_t queuedEvents = 0U;
        std::uint64_t overflowEventCount = 0U;
        std::uint64_t lateEventCount = 0U;
        std::uint64_t rejectedEventCount = 0U;
    };
    std::array<NativeCatalogMidiSlotStatus, NativeEffectBank::kSlotCount> nativeInputCatalogMidiSlots{};
    std::array<NativeCatalogMidiSlotStatus, NativeEffectBank::kSlotCount> nativeTrackCatalogMidiSlots{};
    std::array<std::array<NativeCatalogMidiSlotStatus, NativeEffectBank::kSlotCount>, kNativeTrackCount>
        nativePerTrackCatalogMidiSlots{};
};

struct NativeOutputEffectCommand {
    NativeOutputEffect effect = NativeOutputEffect::LowPass;
    bool enabled = false;
};

struct NativeReverbCommand {
    NativeReverbConfig config{};
};

struct NativeFractionalDelayCommand {
    NativeFractionalDelayConfig config{};
};

struct NativeCompressorCommand {
    NativeCompressorConfig config{};
};

struct NativeChorusCommand {
    NativeChorusConfig config{};
};

struct NativePhaserCommand {
    NativePhaserConfig config{};
};

enum class NativeCatalogFxPath : std::uint8_t { Track, Input };

struct NativeCatalogFxCommand {
    enum class Type : std::uint8_t { SetParameter, SetBypassed };
    Type type = Type::SetParameter;
    NativeCatalogFxPath path = NativeCatalogFxPath::Track;
    NativeEffectSlot slot = NativeEffectSlot::A;
    std::uint8_t parameterIndex = 0U;
    float value = 0.0f;
    // Track 0 = legacy shared playback bank; Track 1..5 = pre-sum looper bank.
    // Input accepts only target 0.
    std::uint8_t trackId = 0U;
    std::uint64_t revision = 0U;
};

struct NativeTrackFxApplyCommand {
    std::uint8_t trackIndex = 0U;
    bool enabled = true;
    std::uint64_t revision = 0U;
};

struct NativePitchConfig {
    bool enabled = false;
    // 0 is the legacy global playback bus. Values 1..5 pitch one loop before
    // it is mixed with the other tracks and the shared A-D playback bank.
    std::uint8_t trackId = 0U;
    NativePitchMode mode = NativePitchMode::LiveMonoKeepPitch;
    float semitones = 0.0f;
    // Native LooperCore has no reverse transport command yet. This flag is a
    // route hint from the host so KeepPitch always falls back for reversed
    // playback until the pitch path supports reverse traversal.
    bool reversePlayback = false;
};

struct NativeMemorySettings {
    std::array<std::array<NativeMemoryFxSlot, 4U>, 7U> banks{};
    NativeRhythmConfig rhythm{};
    NativeReverbConfig reverb{};
    NativeFractionalDelayConfig delay{};
    NativeCompressorConfig compressor{};
    NativeChorusConfig chorus{};
    NativePhaserConfig phaser{};
    NativeAutoPanConfig autoPan{};
    NativePitchConfig pitch{};
    bool lowPass = false;
    bool highPass = false;
    std::array<unsigned int, 7U> mixerLevels{{100U, 100U, 100U, 100U, 100U, 100U, 100U}};
    std::array<bool, kNativeTrackCount> trackFxApply{{true, true, true, true, true}};
    std::array<LoopTransportConfig, kNativeTrackCount> loopTransports{};
};

struct NativePitchCommand {
    NativePitchConfig config{};
    bool resetProcessor = false;
};

struct NativeLoopTransportCommand {
    std::size_t trackIndex = 0U; // zero-based, matching recordTrack()/playTrack()
    LoopTransportConfig config{};
};

template <typename T, std::size_t Capacity>
class SpscRingQueue {
public:
    bool push(const T& value) noexcept {
        const auto write = writeIndex_.load(std::memory_order_relaxed);
        const auto next = increment(write);
        if (next == readIndex_.load(std::memory_order_acquire)) {
            return false;
        }
        buffer_[write] = value;
        writeIndex_.store(next, std::memory_order_release);
        return true;
    }

    bool pop(T& value) noexcept {
        const auto read = readIndex_.load(std::memory_order_relaxed);
        if (read == writeIndex_.load(std::memory_order_acquire)) {
            return false;
        }
        value = buffer_[read];
        readIndex_.store(increment(read), std::memory_order_release);
        return true;
    }

    [[nodiscard]] std::size_t size() const noexcept {
        const auto write = writeIndex_.load(std::memory_order_acquire);
        const auto read = readIndex_.load(std::memory_order_acquire);
        return write >= read ? write - read : Capacity - (read - write);
    }

    void clear() noexcept {
        readIndex_.store(0, std::memory_order_release);
        writeIndex_.store(0, std::memory_order_release);
    }

private:
    static constexpr std::size_t increment(std::size_t index) noexcept {
        return (index + 1) % Capacity;
    }

    std::array<T, Capacity> buffer_{};
    std::atomic<std::size_t> readIndex_{0};
    std::atomic<std::size_t> writeIndex_{0};
};

class NativeAudioCore {
public:
    // Revisions cross a JSON/JavaScript boundary, so stop before Number loses
    // integer precision. Imports fail closed at this sentinel.
    static constexpr std::uint64_t kMaximumSafeProjectContentRevision = 9007199254740991ULL;

    NativeAudioCore();
    ~NativeAudioCore();

    DeviceCatalog getDeviceCatalog() const;
    std::optional<EngineConfig> getCurrentConfig() const;
    EngineStatus getStatus() const;
    // Channels 0 MAIN, 1 MASTER, 2..6 track playback. Software buses only.
    bool setMixerLevel(unsigned int channel, unsigned int percent, std::string& error);

    bool applyConfig(const EngineConfig& config, std::string& error);
    bool start(std::string& error);
    bool stop(std::string& error);

    bool record(std::string& error);
    bool stopRecordOrPlayback(std::string& error);
    bool play(std::string& error);
    bool toggleOverdub(std::string& error);
    bool clear(std::string& error);
    bool recordTrack(std::size_t trackIndex, std::string& error);
    bool stopTrack(std::size_t trackIndex, std::string& error);
    bool playTrack(std::size_t trackIndex, std::string& error);
    bool toggleTrackOverdub(std::size_t trackIndex, std::string& error);
    bool clearTrack(std::size_t trackIndex, std::string& error);
    bool setTrackMark(std::size_t trackIndex, std::uint64_t generation, std::string& error);
    bool clearTrackMark(std::size_t trackIndex, std::uint64_t generation, std::string& error);
    bool undoTrack(std::size_t trackIndex, std::string& error);
    bool redoTrack(std::size_t trackIndex, std::string& error);
    bool setMonitoring(bool enabled, std::string& error);
    bool setOutputLowPassEnabled(bool enabled, std::string& error);
    bool setOutputHighPassEnabled(bool enabled, std::string& error);
    bool setNativeReverbConfig(const NativeReverbConfig& config, std::string& error);
    bool setNativeFractionalDelayConfig(const NativeFractionalDelayConfig& config, std::string& error);
    bool setNativeCompressorConfig(const NativeCompressorConfig& config, std::string& error);
    bool setNativeChorusConfig(const NativeChorusConfig& config, std::string& error);
    bool setNativePhaserConfig(const NativePhaserConfig& config, std::string& error);
    bool setNativeAutoPanConfig(const NativeAutoPanConfig& config, std::string& error);
    bool setNativePitchConfig(const NativePitchConfig& config, std::string& error);
    // Configures a source-aware transport on one stored loop before Native
    // sums the tracks. This is intentionally separate from the shared A-D
    // post-sum Track catalog bank. Index is zero-based (0..4).
    bool setNativeLoopTransport(
        std::size_t trackIndex,
        const LoopTransportConfig& config,
        std::string& error
    );
    // Track target 0 preserves the shared post-sum playback bank. Targets
    // 1..5 select independent A->D chains before summing; Input only allows 0.
    // Per-track chains affect playback (including overdub playback and tails),
    // never stored PCM, live monitoring, or rhythm. Type/clear changes require
    // stopped audio; live parameter/bypass edits are queued at block boundaries.
    bool setNativeCatalogSlot(
        NativeEffectSlot slot,
        const std::string& effectId,
        const std::map<std::string, float>& parameters,
        bool bypassed,
        std::string& error,
        NativeCatalogFxPath path = NativeCatalogFxPath::Track,
        std::uint8_t trackId = 0U,
        bool replaceParameters = false
    );
    // The shared Track A-D gate is a per-loop selector across the recording
    // Input FX source and the postmix Track FX playback bus. A running engine
    // applies and acknowledges it at the next audio callback boundary.
    bool setNativeTrackFxApply(std::size_t trackId, bool enabled, std::uint64_t& requestedRevision, std::string& error);
    // MIDI channels at the bridge boundary are one-based (1..16). Events are
    // inserted into the selected slot's bounded SPSC queue under the control
    // mutex; no oscillator/filterbank state is changed on this thread.
    bool queueNativeOscVocMidiEvent(
        NativeCatalogFxPath path,
        NativeEffectSlot slot,
        bool noteOn,
        int channel,
        int note,
        int velocity,
        std::uint64_t absoluteFrame,
        std::string& error,
        std::uint8_t trackId = 0U
    );
    bool queueNativeCatalogMidiEvent(
        std::string_view effectId,
        NativeCatalogFxPath path,
        NativeEffectSlot slot,
        bool noteOn,
        int channel,
        int note,
        int velocity,
        std::uint64_t absoluteFrame,
        std::string& error,
        std::uint8_t trackId = 0U
    );
    bool setNativeRhythmConfig(const NativeRhythmConfig& config, std::string& error);

    // Takes an exact copy of the finalized mono loop without reading mutable
    // LooperCore storage until the audio callback has pinned loop mutations.
    // The callback remains non-blocking and continues playback during the copy.
    bool captureLoopSnapshot(
        std::vector<float>& samples,
        unsigned int& sampleRate,
        std::string& error
    );

    // Captures one independently addressable Native track as interleaved
    // stereo (mono source tracks are duplicated to L/R).
    bool captureTrackSnapshot(
        std::size_t trackIndex,
        std::vector<float>& interleavedStereo,
        unsigned int& sampleRate,
        std::string& error,
        std::size_t maximumFrameCount = std::numeric_limits<std::size_t>::max(),
        std::uint64_t* contentRevision = nullptr
    );

    // Reads callback-pinned loop dimensions without copying PCM. This lets a
    // caller reject an over-budget HQ render before allocating either the
    // track snapshot or the offline renderer output.
    bool getTrackSnapshotMetadata(
        std::size_t trackIndex,
        std::size_t& frameCount,
        unsigned int& sampleRate,
        std::string& error,
        std::uint64_t* contentRevision = nullptr
    );

    // Stages a validated archive on the control thread and publishes it as a
    // generation-tagged full-bank swap at the next audio callback boundary.
    // The callback performs no allocation, PCM copy, or destruction. A caller
    // must poll status and may cancel only while the callback has not claimed
    // the generation.
    bool beginProjectArchiveImport(
        DecodedProjectArchive&& archive,
        std::uint64_t encodedBytes,
        std::uint64_t expectedProjectContentRevision,
        std::uint64_t& generation,
        std::string& error,
        std::unique_ptr<NativeMemorySettings> memory = nullptr
    );
    bool commitPreparedMemory(std::uint64_t generation, std::string& error);
    [[nodiscard]] NativeProjectImportStatus getProjectArchiveImportStatus(std::uint64_t generation);
    bool cancelProjectArchiveImport(
        std::uint64_t generation,
        NativeProjectImportStatus& status,
        std::string& error
    );

private:
    friend struct NativeAudioCoreTestAccess;

    static constexpr unsigned int kMaxCallbackFrames = 4096;

    struct AudioBlock {
        unsigned int frames = 0;
        std::array<float, kMaxCallbackFrames * 2> samples{};
    };

    struct ProjectImportTransaction {
        std::uint64_t generation = 0U;
        std::uint64_t expectedProjectContentRevision = 0U;
        std::array<std::vector<float>, kNativeTrackCount> candidateStereoStorage{};
        std::array<std::size_t, kNativeTrackCount> frameCounts{};
        std::array<LoopMetadata, kNativeTrackCount> previousMetadata{};
        std::unique_ptr<NativeMemorySettings> memory;
        std::array<NativeEffectBank, 7U> candidateFxBanks{};
        std::unique_ptr<NativeOutputStage> candidateOutputStage;
        std::unique_ptr<NativePitchProcessor> candidatePitch;
        std::unique_ptr<NativePolyPitchProcessor> candidatePolyPitch;
        std::array<std::uint64_t, kNativeTrackCount> gateRevisions{};
    };

    DeviceCatalog buildCatalog() const;
    std::vector<RtAudio::Api> compiledApis() const;
    bool ensureAudioInstanceLocked(std::unique_ptr<RtAudio>& instance, Backend backend, std::string& error);
    bool validateConfigLocked(EngineConfig& config, std::string& error) const;
    bool validateLoopStorageBudgetLocked(unsigned int sampleRate, std::uint64_t budgetBytes, std::string& error) const;
    bool prepareLoopStorageLocked(unsigned int sampleRate, std::uint64_t budgetBytes, std::string& error);
    // Caller holds commandProducerMutex_; reclamation is control-thread-only.
    void reclaimInactiveHistoryPcmLocked() noexcept;
    bool hasNonEmptyTrackLocked() const noexcept;
    bool openStreamLocked(std::string& error);
    void closeStreamLocked() noexcept;
    void resetRuntimeStateLocked() noexcept;
    void applyOutputStageCommands() noexcept;
    void applyNativeReverbCommands() noexcept;
    void applyNativeFractionalDelayCommands() noexcept;
    void applyNativeCompressorCommands() noexcept;
    void applyNativeChorusCommands() noexcept;
    void applyNativePhaserCommands() noexcept;
    void applyNativeCatalogFxCommands() noexcept;
    void applyNativeTrackFxApplyCommands() noexcept;
    void publishSharedCatalogProcessingFaults(std::size_t bankIndex, bool bufferAvailable = true) noexcept;
    [[nodiscard]] const float* processInputFxForCallback(
        const float* inputInterleaved,
        unsigned int frames,
        unsigned int* processedChannels = nullptr
    ) noexcept;
    [[nodiscard]] ProcessStats processNativeTracksForCallback(
        const float* rawInputInterleaved,
        const float* processedInputInterleaved,
        float* outputInterleaved,
        unsigned int frames,
        unsigned int rawInputChannels,
        unsigned int processedInputChannels,
        NativePitchRouteDecision* pitchRouteDecision
    ) noexcept;
    void applyNativePitchCommands() noexcept;
    void applyNativeLoopTransportCommands() noexcept;
    void applyOfficialSourceTransports() noexcept;
    void prepareVocoderCarriers(unsigned int frames) noexcept;
    [[nodiscard]] bool processLoopSnapshotRequestAtCallback() noexcept;
    [[nodiscard]] std::size_t processHistoryPinAtCallback() noexcept;
    [[nodiscard]] bool applyProjectImportAtCallback() noexcept;
    void finalizeProjectImportLocked();
    bool configureNativeCatalogSlotLocked(
        NativeEffectSlot slot,
        const std::string& effectId,
        const std::map<std::string, float>& parameters,
        bool bypassed,
        std::string& error,
        NativeCatalogFxPath path,
        std::uint8_t trackId = 0U,
        bool replaceParameters = false
    );
    void applyNativeRhythmCommands() noexcept;
    [[nodiscard]] LooperCore& looperForTrack(std::size_t trackIndex) noexcept;
    [[nodiscard]] const LooperCore& looperForTrack(std::size_t trackIndex) const noexcept;
    [[nodiscard]] bool queueTrackCommand(CommandType type, std::size_t trackIndex, std::string& error);
    void applyTrackCommandAtCallback(const Command& command) noexcept;
    [[nodiscard]] bool restoreTrackHistory(std::size_t trackIndex, bool redo, std::string& error);
    void invalidateTrackMarkLocked(std::size_t trackIndex) noexcept;
    [[nodiscard]] std::string trackMarkUnavailableReasonLocked(std::size_t trackIndex) const;
    bool setOutputEffectEnabled(NativeOutputEffect effect, bool enabled, std::string& error);
    void updateLastErrorLocked(const std::string& error) const;
    const DeviceDescriptor* findDeviceLocked(const std::vector<DeviceDescriptor>& devices, const std::string& id) const;

    static int audioCallback(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int nBufferFrames,
        double streamTime,
        RtAudioStreamStatus status,
        void* userData
    );

    static int inputAudioCallback(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int nBufferFrames,
        double streamTime,
        RtAudioStreamStatus status,
        void* userData
    );

    static int outputAudioCallback(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int nBufferFrames,
        double streamTime,
        RtAudioStreamStatus status,
        void* userData
    );

    int handleAudioCallback(
        void* outputBuffer,
        void* inputBuffer,
        unsigned int nBufferFrames,
        RtAudioStreamStatus status
    );

    int handleInputAudioCallback(
        void* inputBuffer,
        unsigned int nBufferFrames,
        RtAudioStreamStatus status
    );

    int handleOutputAudioCallback(
        void* outputBuffer,
        unsigned int nBufferFrames,
        RtAudioStreamStatus status
    );

    struct CallbackTelemetryScope {
        std::chrono::steady_clock::time_point started;
        NativeAudioCore& core;
        void* output;
        unsigned int frames;
        unsigned int kind;
        unsigned int sampleRate;
        CallbackTelemetryScope(NativeAudioCore& owner, unsigned int callbackKind, void* outputBuffer,
            const void* inputBuffer, unsigned int bufferFrames, RtAudioStreamStatus status) noexcept;
        ~CallbackTelemetryScope() noexcept;
    };
    void recordCallbackDuration(unsigned int kind, unsigned int frames, unsigned int sampleRate, std::uint64_t durationNs) noexcept;
    void markHardwareStreamOpened() noexcept;

    mutable std::mutex controlMutex_;
    std::mutex loopSnapshotMutex_;
    std::mutex commandProducerMutex_;
    mutable std::string lastError_;
    std::unique_ptr<RtAudio> audio_;
    std::unique_ptr<RtAudio> captureAudio_;
    std::optional<EngineConfig> currentConfig_;
    DeviceCatalog deviceCatalog_;
    LooperCore looper_;
    std::array<LooperCore, kNativeTrackCount - 1U> additionalLoopers_;
    std::size_t nativeLooperMaxRecordSeconds_ = 0U;
    std::uint64_t nativeLooperPreallocatedBytes_ = 0U;
    std::unique_ptr<ProjectImportTransaction> projectImportTransaction_;
    std::atomic<ProjectImportTransaction*> projectImportTransactionPointer_{nullptr};
    mutable std::atomic<unsigned int> projectGraphReaders_{0U};
    std::atomic<NativeProjectImportState> projectImportState_{NativeProjectImportState::Idle};
    std::atomic<std::uint64_t> projectImportActiveGeneration_{0U};
    std::uint64_t projectImportNextGeneration_ = 0U;
    std::uint64_t projectImportLastGeneration_ = 0U;
    NativeProjectImportState projectImportLastState_ = NativeProjectImportState::Idle;
    std::string projectImportLastError_;
    std::atomic<bool> projectImportCancelledByCallback_{false};
    std::array<float, kMaxCallbackFrames * 2U> nativeTrackMixScratch_{};
    std::array<std::array<float, kMaxCallbackFrames * 2U>, kNativeTrackCount> nativeVocoderCarrierScratch_{};
    std::array<std::atomic<NativeVocoderCarrierStatus>, kNativeTrackCount> nativeVocoderCarrierStatuses_{};
    std::array<float, kMaxCallbackFrames * 2U> nativeTrackPlaybackScratch_{};
    std::array<float, kMaxCallbackFrames * 2U> nativeTrackDryPlaybackScratch_{};
    std::array<float, kMaxCallbackFrames * 2U> nativePitchTargetDryScratch_{};
    std::array<float, kMaxCallbackFrames * 2U> nativePitchTargetProcessedScratch_{};
    unsigned int inputChannels_ = 1;
    unsigned int outputChannels_ = 2;

    SpscRingQueue<Command, 64> commandQueue_;
    enum class HistoryKind : std::uint8_t { None = 0U, Metadata, Pcm };
    struct TrackHistoryRecord {
        LoopMetadata before{};
        LoopMetadata after{};
        HistoryKind kind = HistoryKind::None;
        bool valid = false;
        bool applied = false;
        std::size_t pcmFrames = 0U;
    };
    std::array<TrackHistoryRecord, kNativeTrackCount> historyRecords_{};
    std::array<std::vector<float>, kNativeTrackCount> historyPcm_{};
    std::array<bool, kNativeTrackCount> recordingHistoryPending_{};
    std::array<std::atomic<bool>, kNativeTrackCount> historyCanUndo_{};
    std::array<std::atomic<bool>, kNativeTrackCount> historyCanRedo_{};
    std::array<std::atomic<NativeHistoryFailure>, kNativeTrackCount> historyFailure_{};
    std::array<std::atomic<bool>, kNativeTrackCount> overdubSnapshotReady_{};
    std::array<std::atomic<std::size_t>, kNativeTrackCount> overdubSnapshotFrames_{};
    std::array<std::atomic<bool>, kNativeTrackCount> historyPcmActive_{};
    std::array<LoopMetadata, kNativeTrackCount> pendingOverdubBefore_{};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> historyPcmBytes_{};
    // Marks are separate finalized stereo copies. The callback only publishes
    // eligibility transitions; it never allocates, copies, or destroys mark PCM.
    std::array<std::vector<float>, kNativeTrackCount> markPcm_{};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> markPcmBytes_{};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> markCandidateBytes_{};
    std::array<std::atomic<bool>, kNativeTrackCount> markEligibleAfterOverdub_{};
    std::array<std::atomic<bool>, kNativeTrackCount> markBusy_{};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> markRequestedGeneration_{};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> markAppliedGeneration_{};
    std::atomic<std::uint64_t> historyRetainedBytes_{0U};
    std::atomic<std::uint64_t> historyPinNextGeneration_{0U};
    std::atomic<std::uint64_t> historyPinRequestGeneration_{0U};
    std::atomic<std::uint64_t> historyPinAcknowledgedGeneration_{0U};
    std::atomic<std::uint64_t> historyPinCancelledGeneration_{0U};
    std::atomic<std::uint64_t> historyPinReleaseGeneration_{0U};
    std::atomic<std::uint64_t> historyPinReleasedGeneration_{0U};
    std::atomic<std::size_t> historyPinTrackIndex_{kNativeTrackCount};
    std::atomic<std::size_t> historyPinAcknowledgedTrackIndex_{kNativeTrackCount};
    std::uint64_t historyPinnedGeneration_ = 0U;
    std::size_t historyPinnedTrackIndex_ = kNativeTrackCount;
    SpscRingQueue<NativeOutputEffectCommand, 32> outputStageCommandQueue_;
    SpscRingQueue<NativeReverbCommand, 16> nativeReverbCommandQueue_;
    SpscRingQueue<NativeFractionalDelayCommand, 16> nativeFractionalDelayCommandQueue_;
    SpscRingQueue<NativeCompressorCommand, 16> nativeCompressorCommandQueue_;
    SpscRingQueue<NativeChorusCommand, 16> nativeChorusCommandQueue_;
    SpscRingQueue<NativePhaserCommand, 16> nativePhaserCommandQueue_;
    SpscRingQueue<NativeCatalogFxCommand, 64> nativeCatalogFxCommandQueue_;
    SpscRingQueue<NativeTrackFxApplyCommand, 32> nativeTrackFxApplyCommandQueue_;
    std::array<bool, kNativeTrackCount> nativeTrackFxApplyRequested_{{true, true, true, true, true}};
    std::array<std::uint64_t, kNativeTrackCount> nativeTrackFxApplyRequestedRevision_{};
    std::array<bool, kNativeTrackCount> nativeTrackFxApplyRuntime_{{true, true, true, true, true}};
    std::array<std::uint64_t, kNativeTrackCount> nativeTrackFxApplyRuntimeRevision_{};
    std::array<std::atomic<bool>, kNativeTrackCount> nativeTrackFxApplyApplied_{};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> nativeTrackFxApplyAppliedRevision_{};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> nativeTrackFxApplySemanticRevision_{};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> nativeTrackFxApplyFaultRevision_{};
    std::array<std::atomic<float>, kNativeTrackCount> nativeTrackFxApplyPeak_{};
    std::array<std::atomic<float>, kNativeTrackCount> nativeTrackFxApplyRms_{};
    SpscRingQueue<NativePitchCommand, 16> nativePitchCommandQueue_;
    SpscRingQueue<NativeLoopTransportCommand, 16> nativeLoopTransportCommandQueue_;
    // Callback-owned underlying routes. Official shared Track A is an overlay;
    // bypass/removal restores each independently authored route, not generic OFF.
    std::array<LoopTransportConfig, kNativeTrackCount> nativeBaseLoopTransportConfigs_{};
    std::array<LoopTransportConfig, kNativeTrackCount> nativeMemoryLoopTransportSettings_{};
    std::array<bool, kNativeTrackCount> nativeOfficialSourcePitchConflict_{};
    SpscRingQueue<NativeRhythmConfig, 16> nativeRhythmCommandQueue_;
    SpscRingQueue<AudioBlock, 8> outputQueue_;
    std::unique_ptr<NativeOutputStage> outputStage_{std::make_unique<NativeOutputStage>()};
    NativeEffectBank nativeInputFxBank_{};
    // Exactly 5 x 4 individually owned processor slots. Selection and all
    // storage preparation happen while stopped, on the control thread.
    std::array<NativeEffectBank, kNativeTrackCount> nativePerTrackFxBanks_{};
    std::array<std::array<bool, NativeEffectBank::kSlotCount>, kNativeTrackCount> nativePerTrackSlotBypassed_{};
    std::array<std::array<std::uint64_t, NativeEffectBank::kSlotCount>, kNativeTrackCount> nativePerTrackSlotRevision_{};
    struct PublishedTrackFxSlot {
        std::atomic<bool> appliedBypassed{false};
        std::atomic<bool> processingFaulted{false};
        std::atomic<std::uint64_t> appliedRevision{0U};
        std::atomic<std::uint64_t> controlFaultRevision{0U};
    };
    std::array<std::array<PublishedTrackFxSlot, NativeEffectBank::kSlotCount>, kNativeTrackCount> nativePerTrackFxPublished_{};
    // Input index 0, shared Track index 1; private tracks retain their existing storage.
    std::array<std::array<PublishedTrackFxSlot, NativeEffectBank::kSlotCount>, 2U> nativeSharedFxPublished_{};
    std::array<std::array<std::uint64_t, NativeEffectBank::kSlotCount>, 2U> nativeSharedSlotRevision_{};
    std::atomic<std::uint64_t> nativeCatalogControlFaultCount_{0U};
    std::array<float, kMaxCallbackFrames * 2U> nativeInputFxScratch_{};
    std::unique_ptr<NativePitchProcessor> nativePitchProcessor_{std::make_unique<NativePitchProcessor>()};
    std::unique_ptr<NativePolyPitchProcessor> nativePolyPitchProcessor_{std::make_unique<NativePolyPitchProcessor>()};
    NativeRhythmEngine nativeRhythmEngine_;
    NativeReverbConfig nativeReverbConfig_{};
    NativeFractionalDelayConfig nativeFractionalDelayConfig_{};
    NativeCompressorConfig nativeCompressorConfig_{};
    NativeChorusConfig nativeChorusConfig_{};
    NativePhaserConfig nativePhaserConfig_{};
    NativeAutoPanConfig nativeAutoPanConfig_{};
    NativePitchConfig nativePitchConfig_{};
    // These fields are owned by the audio callback; control changes cross the
    // boundary through nativePitchCommandQueue_.
    bool nativePitchRuntimeEnabled_ = false;
    std::uint8_t nativePitchRuntimeTrackId_ = 0U;
    NativePitchMode nativePitchRuntimeMode_ = NativePitchMode::LiveMonoKeepPitch;
    bool nativePitchRuntimeReverse_ = false;
    std::array<bool, NativeEffectBank::kSlotCount> nativeCatalogSlotBypassed_{};
    // Control-thread shadows include accepted-but-not-yet-consumed variant edits.
    // Reading the callback's processor here would race and could validate against
    // an obsolete branch while an earlier selector command is still queued.
    // Authored-key bookkeeping belongs exclusively to the control thread.
    // Full replacement with removals is rejected live rather than falsely
    // acknowledging a reset while old DSP state remains latched.
    std::array<std::array<std::map<std::string, float>, NativeEffectBank::kSlotCount>, kNativeTrackCount + 2U> nativeCatalogAuthoredParameters_{};
    std::array<unsigned int, NativeEffectBank::kSlotCount> nativeInputOfficialVariants_{};
    std::array<unsigned int, NativeEffectBank::kSlotCount> nativeTrackOfficialVariants_{};
    std::array<std::array<unsigned int, NativeEffectBank::kSlotCount>, kNativeTrackCount> nativePerTrackOfficialVariants_{};
    std::array<bool, NativeEffectBank::kSlotCount> nativeInputCatalogSlotBypassed_{};
    std::array<std::atomic<unsigned int>, 7> mixerLevels_{{100U, 100U, 100U, 100U, 100U, 100U, 100U}};
    NativeRhythmConfig nativeRhythmConfig_{};
    std::uint64_t callbackFrameCursor_ = 0;
    std::atomic<std::uint64_t> publishedCallbackFrameCursor_{0U};
    std::atomic<bool> engineRunning_{false};
    std::atomic<bool> outputLowPassEnabled_{false};
    std::atomic<bool> outputHighPassEnabled_{false};
    std::atomic<bool> nativePitchActive_{false};
    std::atomic<bool> nativePitchVoiced_{false};
    std::atomic<float> nativePitchFrequencyHz_{0.0f};
    std::atomic<float> nativePitchConfidence_{0.0f};
    std::atomic<NativePitchFallbackReason> nativePitchFallbackReason_{NativePitchFallbackReason::NotRequested};
    std::atomic<int> looperState_{static_cast<int>(LooperState::Empty)};
    std::atomic<float> loopProgress_{0.0f};
    std::array<std::atomic<int>, kNativeTrackCount> trackStates_{{
        static_cast<int>(LooperState::Empty), static_cast<int>(LooperState::Empty),
        static_cast<int>(LooperState::Empty), static_cast<int>(LooperState::Empty),
        static_cast<int>(LooperState::Empty)
    }};
    std::array<std::atomic<std::uint64_t>, kNativeTrackCount> trackContentRevision_{};
    // The global epoch also changes for Play/Stop transitions because project
    // import replaces those states; per-track content revisions remain PCM/history-only.
    std::atomic<std::uint64_t> projectContentRevision_{0U};
    std::array<std::atomic<float>, kNativeTrackCount> trackProgress_{{0.0f, 0.0f, 0.0f, 0.0f, 0.0f}};
    std::array<std::atomic<LoopTransportStatus>, kNativeTrackCount> trackLoopTransportStatus_{{
        LoopTransportStatus::Disabled, LoopTransportStatus::Disabled, LoopTransportStatus::Disabled,
        LoopTransportStatus::Disabled, LoopTransportStatus::Disabled
    }};
    std::atomic<float> inputPeak_{0.0f};
    std::atomic<float> outputPeak_{0.0f};
    std::atomic<unsigned int> xrunsOrDropouts_{0};
    // Lifetime diagnostics: resetRuntimeStateLocked does not erase evidence.
    std::atomic<bool> hardwareStreamOpened_{false};
    std::array<std::atomic<std::uint64_t>, 3U> telemetryCallbacksByKind_{};
    std::atomic<std::uint64_t> telemetryHardwareCallbacks_{0U};
    std::array<std::atomic<std::uint64_t>, 3U> telemetryStatusFlags_{};
    std::array<std::atomic<std::uint64_t>, 3U> telemetryHardwareStatusFlags_{};
    std::atomic<std::uint64_t> telemetryAudioQueueOverflow_{0U};
    std::atomic<std::uint64_t> telemetryAudioQueueUnderflow_{0U};
    std::atomic<std::uint64_t> telemetryControlQueueReject_{0U};
    std::atomic<std::uint64_t> telemetryOversizeCallback_{0U};
    std::atomic<std::uint64_t> telemetryNonFiniteInput_{0U};
    std::atomic<std::uint64_t> telemetryNonFiniteOutput_{0U};
    std::array<std::atomic<std::uint64_t>, 3U> telemetryDeadlineMisses_{};
    std::array<std::atomic<std::uint64_t>, 3U> telemetryDeadlineEvaluated_{};
    std::atomic<std::uint64_t> telemetryRuntimeResetCount_{0U};
    std::array<std::atomic<std::uint64_t>, kNativeCallbackDurationBins> telemetryDurationHistogram_{};
    // RtAudio serializes callbacks within each stream/kind; split streams use separate slots.
    std::array<std::atomic<std::uint64_t>, 3U> telemetryMaximumDurationNs_{};
    std::array<std::atomic<unsigned int>, 3U> telemetryLatestSampleRate_{};
    std::array<std::atomic<unsigned int>, 3U> telemetryLatestBufferFrames_{};
    std::atomic<unsigned long long> callbackTicks_{0};
    std::atomic<bool> renderPrimed_{false};
    std::atomic<bool> loopSnapshotRequested_{false};
    std::atomic<bool> loopSnapshotAcknowledged_{false};
    std::atomic<bool> loopSnapshotReleaseRequested_{false};
    std::atomic<bool> loopSnapshotReleaseAcknowledged_{true};
    std::atomic<bool> loopSnapshotEligible_{false};
    std::atomic<LooperState> loopSnapshotState_{LooperState::Empty};
    std::atomic<std::uint64_t> loopSnapshotContentRevision_{0U};
    std::atomic<std::size_t> loopSnapshotTrackIndex_{0U};
    std::atomic<std::uint64_t> loopSnapshotNextGeneration_{0U};
    std::atomic<std::uint64_t> loopSnapshotRequestGeneration_{0U};
    std::atomic<std::uint64_t> loopSnapshotAcknowledgedGeneration_{0U};
    std::atomic<std::uint64_t> loopSnapshotCancelledGeneration_{0U};
    std::atomic<std::uint64_t> loopSnapshotReleaseGeneration_{0U};
    std::atomic<std::uint64_t> loopSnapshotReleasedGeneration_{0U};
    // Only the single active loop-processing callback reads/writes this flag.
    bool loopSnapshotPinned_ = false;
};

std::string backendToString(Backend backend);
std::string looperStateToString(LooperState state);
std::optional<Backend> backendFromString(const std::string& raw);

} // namespace webrc::native
