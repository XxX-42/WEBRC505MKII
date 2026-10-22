#pragma once

#include "native_vocoder_core.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <string_view>

namespace webrc::native {

inline constexpr std::size_t kNativeOscVocMaxVoices = 8U;
inline constexpr std::size_t kNativeOscVocEventQueueCapacity = 128U;

enum class NativeOscVocWaveform : std::uint8_t {
    Saw = 0U,
    Square = 1U,
    // Difference of two phase-offset polyBLEP saws, with pulse width control.
    Pulse = 2U,
};

struct NativeOscVocConfig {
    std::size_t bands = kNativeVocoderDefaultBands;
    NativeOscVocWaveform waveform = NativeOscVocWaveform::Saw;
    int midiChannel = 0;
    // Legacy octave-count shift retained for the standalone core API. Runtime
    // catalog parameter `octave` is the user-facing semitone transpose.
    int octaveShift = 0;
    int transposeSemitones = 0;
    float pulseWidth = 0.5f;
    float wetMix = 1.0f;
    bool enabled = true;
};

// DSP-only OSC VOC (M) core. It consumes already-decoded MIDI note events; it
// does not open a MIDI device or parse MIDI byte streams. Event insertion is a
// bounded single-producer/single-consumer queue and must be timestamped before
// the corresponding sample is processed. `setConfig` and `reset` belong to
// the audio/control owner and must not race `process`.
class NativeOscVocCore final {
public:
    [[nodiscard]] bool prepare(std::uint32_t sampleRate, std::uint64_t firstFrame = 0U) noexcept;
    [[nodiscard]] bool setConfig(const NativeOscVocConfig& config) noexcept;
    // Additive manual IDs: official_carrier/tone/attack/octave/mod_sens/release/balance.
    // Discrete IDs: waveform (0..2), channel (0..15), octave (-24..24 semitones),
    // pulseWidth (0.1..0.9), and mix (0..100 percent). Only mix is ramped.
    [[nodiscard]] bool setParameter(std::string_view parameterId, float value,
                                    std::uint64_t rampFrames = 0U) noexcept;
    void reset() noexcept;

    // MIDI channel uses the zero-based range [0, 15]; note and velocity use
    // [0, 127]. A note-on with velocity zero is treated as a MIDI note-off.
    // Events must arrive in nondecreasing absolute-frame order and be queued
    // before their frame; a full queue or stale/out-of-order event is rejected.
    [[nodiscard]] bool queueNoteOn(int channel, int note, int velocity,
                                   std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] bool queueNoteOff(int channel, int note,
                                    std::uint64_t absoluteFrame) noexcept;
    [[nodiscard]] bool scheduleMidiNoteOn(int channel, int note, int velocity,
                                          std::uint64_t absoluteFrame) noexcept {
        return queueNoteOn(channel, note, velocity, absoluteFrame);
    }
    [[nodiscard]] bool scheduleMidiNoteOff(int channel, int note,
                                           std::uint64_t absoluteFrame) noexcept {
        return queueNoteOff(channel, note, absoluteFrame);
    }

    [[nodiscard]] float processSample(float modulator) noexcept;
    [[nodiscard]] bool processMono(const float* modulator, float* output,
                                   std::size_t frames) noexcept;
    [[nodiscard]] bool processBlock(const float* modulator, float* output,
                                    std::size_t frames) noexcept {
        return processMono(modulator, output, frames);
    }
    [[nodiscard]] bool processStereo(const float* interleavedInput, float* interleavedOutput,
                                     std::size_t frames) noexcept;
    [[nodiscard]] bool processInPlace(float* interleaved, std::size_t frames,
                                      std::size_t channels) noexcept;
    // Align the local sample clock to an external absolute callback cursor.
    // It only moves forward. Events made stale by a dropped/absent path block
    // are discarded and counted as late so they cannot sound at a later time.
    [[nodiscard]] bool synchronizeFrame(std::uint64_t absoluteFrame) noexcept;

    [[nodiscard]] const NativeOscVocConfig& config() const noexcept { return config_; }
    [[nodiscard]] std::uint32_t sampleRate() const noexcept { return sampleRate_; }
    [[nodiscard]] std::uint64_t currentFrame() const noexcept {
        return publishedFrame_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::size_t queuedEventCount() const noexcept;
    [[nodiscard]] std::size_t activeVoiceCount() const noexcept;
    [[nodiscard]] std::uint64_t overflowEventCount() const noexcept {
        return overflowEventCount_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::uint64_t lateEventCount() const noexcept {
        return lateEventCount_.load(std::memory_order_acquire);
    }
    [[nodiscard]] std::uint64_t rejectedEventCount() const noexcept {
        return rejectedEventCount_.load(std::memory_order_acquire);
    }
    // Used by the engine adapter when the path-wide callback clock has
    // advanced beyond this slot before its next DSP block is processed.
    void recordLateEvent() noexcept {
        lateEventCount_.fetch_add(1U, std::memory_order_acq_rel);
    }
    void recordRejectedEvent() noexcept {
        rejectedEventCount_.fetch_add(1U, std::memory_order_acq_rel);
    }
    [[nodiscard]] const NativeVocoderFilterBank& filterBank() const noexcept { return filterBank_; }

private:
    enum class EventType : std::uint8_t { NoteOn, NoteOff };

    struct Event final {
        std::uint64_t frame = 0U;
        float frequencyHz = 0.0f;
        std::uint8_t note = 0U;
        std::uint8_t channel = 0U;
        std::uint8_t velocity = 0U;
        EventType type = EventType::NoteOff;
    };

    struct Voice final {
        NativeVocoderOscillator oscillatorA{};
        NativeVocoderOscillator oscillatorB{};
        NativeOfficialVocoderOscillator officialOscillator{};
        std::uint64_t age = 0U;
        float amplitude = 0.0f;
        float targetAmplitude = 0.0f;
        std::uint8_t note = 0U;
        std::uint8_t channel = 0U;
        bool active = false;
        bool gateOpen = false;
    };

    [[nodiscard]] bool enqueueEvent(const Event& event) noexcept;
    [[nodiscard]] static bool validWaveform(NativeOscVocWaveform waveform) noexcept;
    [[nodiscard]] static float boundedSample(float sample) noexcept;
    [[nodiscard]] static float boundedOutput(double sample) noexcept;
    [[nodiscard]] static double noteFrequency(int note, int octaveShift, int transposeSemitones) noexcept;
    [[nodiscard]] bool frequencyIsSupported(double frequencyHz) const noexcept;
    void dispatchDueEvents(std::uint64_t frame) noexcept;
    void startVoice(const Event& event) noexcept;
    void releaseVoice(std::uint8_t channel, std::uint8_t note) noexcept;
    void configureVoiceWaveform(Voice& voice, NativeOscVocWaveform waveform,
                                float pulseWidth) noexcept;
    [[nodiscard]] float renderCarrierSample() noexcept;
    [[nodiscard]] float processMonoFrame(float modulator, float dryLeft, float dryRight,
                                         float* outputLeft, float* outputRight) noexcept;
    void publishFrame() noexcept;

    std::uint32_t sampleRate_ = 0U;
    NativeOscVocConfig config_{};
    NativeVocoderOfficialShaping official_{};
    unsigned int officialWaveform_ = 0U;
    NativeVocoderFilterBank filterBank_{};
    std::array<Voice, kNativeOscVocMaxVoices> voices_{};
    std::array<float, kNativeVocoderMaxBands> bandCarriers_{};
    std::array<Event, kNativeOscVocEventQueueCapacity> events_{};
    std::atomic<std::uint64_t> eventHead_{0U};
    std::atomic<std::uint64_t> eventTail_{0U};
    std::atomic<std::uint64_t> publishedFrame_{0U};
    std::atomic<int> queuedOctaveShift_{0};
    std::atomic<int> queuedTransposeSemitones_{0};
    std::atomic<int> queuedMidiChannel_{0};
    std::atomic<std::uint64_t> overflowEventCount_{0U};
    std::atomic<std::uint64_t> lateEventCount_{0U};
    std::atomic<std::uint64_t> rejectedEventCount_{0U};
    std::uint64_t frameClock_ = 0U;
    std::uint64_t lastQueuedFrame_ = 0U;
    std::uint64_t voiceAge_ = 0U;
    bool hasQueuedFrame_ = false;
    double attackCoefficient_ = 0.0;
    double releaseCoefficient_ = 0.0;
    float wetMixCurrent_ = 1.0f;
    float wetMixTarget_ = 1.0f;
    double wetMixStep_ = 0.0;
    std::uint64_t wetMixRampRemaining_ = 0U;
};

} // namespace webrc::native
