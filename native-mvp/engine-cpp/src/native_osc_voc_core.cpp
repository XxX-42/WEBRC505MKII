#include "native_osc_voc_core.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::native {
namespace {

constexpr double kAttackSeconds = 0.004;
constexpr double kReleaseSeconds = 0.070;
constexpr float kVoiceSilenceThreshold = 1.0e-5f;
constexpr double kMaxInputMagnitude = 8.0;
constexpr double kMaxOutputMagnitude = 8.0;

[[nodiscard]] bool isIntegral(float value) noexcept {
    return std::isfinite(value) && std::floor(value) == value;
}

[[nodiscard]] float safePulsePhase(double phase) noexcept {
    double wrapped = std::fmod(phase, 1.0);
    if (wrapped < 0.0) {
        wrapped += 1.0;
    }
    return static_cast<float>(wrapped);
}

} // namespace

bool NativeOscVocCore::validWaveform(NativeOscVocWaveform waveform) noexcept {
    return waveform == NativeOscVocWaveform::Saw || waveform == NativeOscVocWaveform::Square ||
        waveform == NativeOscVocWaveform::Pulse;
}

float NativeOscVocCore::boundedSample(float sample) noexcept {
    if (!std::isfinite(sample)) {
        return 0.0f;
    }
    return std::clamp(sample, -static_cast<float>(kMaxInputMagnitude),
                      static_cast<float>(kMaxInputMagnitude));
}

float NativeOscVocCore::boundedOutput(double sample) noexcept {
    if (!std::isfinite(sample)) {
        return 0.0f;
    }
    return static_cast<float>(std::clamp(sample, -kMaxOutputMagnitude, kMaxOutputMagnitude));
}

double NativeOscVocCore::noteFrequency(int note, int octaveShift, int transposeSemitones) noexcept {
    const double semitones = static_cast<double>(note - 69) +
        (12.0 * static_cast<double>(octaveShift)) + static_cast<double>(transposeSemitones);
    return 440.0 * std::exp2(semitones / 12.0);
}

bool NativeOscVocCore::frequencyIsSupported(double frequencyHz) const noexcept {
    return sampleRate_ >= 8000U && std::isfinite(frequencyHz) && frequencyHz > 0.0 &&
        frequencyHz < static_cast<double>(sampleRate_) * 0.45;
}

bool NativeOscVocCore::prepare(std::uint32_t sampleRate, std::uint64_t firstFrame) noexcept {
    if (sampleRate < 8000U || sampleRate > 384000U ||
        firstFrame == std::numeric_limits<std::uint64_t>::max() || config_.bands < 8U ||
        config_.bands > kNativeVocoderMaxBands || !validWaveform(config_.waveform) ||
        config_.midiChannel < 0 || config_.midiChannel > 15 ||
        config_.octaveShift < -2 || config_.octaveShift > 2 ||
        config_.transposeSemitones < -24 || config_.transposeSemitones > 24 ||
        !std::isfinite(config_.pulseWidth) || config_.pulseWidth < 0.1f || config_.pulseWidth > 0.9f ||
        !std::isfinite(config_.wetMix) || config_.wetMix < 0.0f || config_.wetMix > 1.0f) {
        return false;
    }
    sampleRate_ = sampleRate;
    if (!filterBank_.prepare(sampleRate_, config_.bands)) {
        sampleRate_ = 0U;
        return false;
    }
    attackCoefficient_ = std::exp(-1.0 / (kAttackSeconds * static_cast<double>(sampleRate_)));
    releaseCoefficient_ = std::exp(-1.0 / (kReleaseSeconds * static_cast<double>(sampleRate_)));
    frameClock_ = firstFrame;
    publishedFrame_.store(firstFrame, std::memory_order_release);
    queuedOctaveShift_.store(config_.octaveShift, std::memory_order_release);
    queuedTransposeSemitones_.store(config_.transposeSemitones, std::memory_order_release);
    queuedMidiChannel_.store(config_.midiChannel, std::memory_order_release);
    overflowEventCount_.store(0U, std::memory_order_release);
    lateEventCount_.store(0U, std::memory_order_release);
    rejectedEventCount_.store(0U, std::memory_order_release);
    wetMixCurrent_ = config_.wetMix;
    wetMixTarget_ = config_.wetMix;
    wetMixStep_ = 0.0;
    wetMixRampRemaining_ = 0U;
    reset();
    return true;
}

bool NativeOscVocCore::setConfig(const NativeOscVocConfig& config) noexcept {
    if (config.bands < 8U || config.bands > kNativeVocoderMaxBands || !validWaveform(config.waveform) ||
        config.midiChannel < 0 || config.midiChannel > 15 ||
        config.octaveShift < -2 || config.octaveShift > 2 ||
        config.transposeSemitones < -24 || config.transposeSemitones > 24 ||
        !std::isfinite(config.pulseWidth) || config.pulseWidth < 0.1f || config.pulseWidth > 0.9f ||
        !std::isfinite(config.wetMix) || config.wetMix < 0.0f || config.wetMix > 1.0f) {
        return false;
    }

    if (sampleRate_ != 0U && (config.octaveShift != config_.octaveShift ||
        config.transposeSemitones != config_.transposeSemitones)) {
        for (const auto& voice : voices_) {
            if (voice.active && !frequencyIsSupported(noteFrequency(
                static_cast<int>(voice.note), config.octaveShift, config.transposeSemitones))) {
                return false;
            }
        }
    }

    const bool bandsChanged = config.bands != config_.bands;
    const bool waveformChanged = config.waveform != config_.waveform;
    const bool pulseWidthChanged = config.pulseWidth != config_.pulseWidth;
    const bool octaveChanged = config.octaveShift != config_.octaveShift;
    const bool transposeChanged = config.transposeSemitones != config_.transposeSemitones;
    const bool channelChanged = config.midiChannel != config_.midiChannel;

    if (sampleRate_ != 0U && bandsChanged && !filterBank_.prepare(sampleRate_, config.bands)) {
        return false;
    }
    config_ = config;
    queuedOctaveShift_.store(config_.octaveShift, std::memory_order_release);
    queuedTransposeSemitones_.store(config_.transposeSemitones, std::memory_order_release);
    queuedMidiChannel_.store(config_.midiChannel, std::memory_order_release);
    wetMixCurrent_ = config_.wetMix;
    wetMixTarget_ = config_.wetMix;
    wetMixStep_ = 0.0;
    wetMixRampRemaining_ = 0U;

    if (sampleRate_ != 0U) {
        for (auto& voice : voices_) {
            if (!voice.active) {
                continue;
            }
            if (octaveChanged || transposeChanged) {
                const float frequency = static_cast<float>(noteFrequency(
                    static_cast<int>(voice.note), config_.octaveShift, config_.transposeSemitones));
                (void)voice.oscillatorA.setFrequency(frequency);
                (void)voice.oscillatorB.setFrequency(frequency);
            }
            if (waveformChanged || (pulseWidthChanged && config_.waveform == NativeOscVocWaveform::Pulse)) {
                configureVoiceWaveform(voice, config_.waveform, config_.pulseWidth);
            }
            if (channelChanged && voice.channel != static_cast<std::uint8_t>(config_.midiChannel)) {
                voice.gateOpen = false;
            }
        }
    }
    return true;
}

bool NativeOscVocCore::setParameter(std::string_view parameterId, float value,
                                    std::uint64_t rampFrames) noexcept {
    NativeOscVocConfig candidate = config_;
    if (parameterId == "waveform") {
        if (!isIntegral(value) || value < 0.0f || value > 2.0f) {
            return false;
        }
        candidate.waveform = static_cast<NativeOscVocWaveform>(static_cast<std::uint8_t>(value));
        return setConfig(candidate);
    }
    if (parameterId == "channel") {
        if (!isIntegral(value) || value < 0.0f || value > 15.0f) {
            return false;
        }
        candidate.midiChannel = static_cast<int>(value);
        return setConfig(candidate);
    }
    if (parameterId == "octave") {
        if (!isIntegral(value) || value < -24.0f || value > 24.0f) {
            return false;
        }
        candidate.transposeSemitones = static_cast<int>(value);
        return setConfig(candidate);
    }
    if (parameterId == "pulseWidth") {
        candidate.pulseWidth = value;
        return setConfig(candidate);
    }
    if (parameterId == "mix") {
        if (!std::isfinite(value) || value < 0.0f || value > 100.0f) {
            return false;
        }
        const float start = wetMixCurrent_;
        candidate.wetMix = value * 0.01f;
        if (!setConfig(candidate)) {
            return false;
        }
        if (rampFrames != 0U && start != wetMixTarget_) {
            wetMixCurrent_ = start;
            wetMixRampRemaining_ = rampFrames;
            wetMixStep_ = (static_cast<double>(wetMixTarget_) - static_cast<double>(wetMixCurrent_)) /
                static_cast<double>(wetMixRampRemaining_);
        }
        return true;
    }
    return false;
}

void NativeOscVocCore::reset() noexcept {
    filterBank_.reset();
    for (auto& voice : voices_) {
        voice.active = false;
        voice.gateOpen = false;
        voice.amplitude = 0.0f;
        voice.targetAmplitude = 0.0f;
        voice.age = 0U;
    }
    bandCarriers_.fill(0.0f);
    const std::uint64_t head = eventHead_.load(std::memory_order_acquire);
    eventTail_.store(head, std::memory_order_release);
    lastQueuedFrame_ = 0U;
    hasQueuedFrame_ = false;
    voiceAge_ = 0U;
    publishedFrame_.store(frameClock_, std::memory_order_release);
}

bool NativeOscVocCore::queueNoteOn(int channel, int note, int velocity,
                                   std::uint64_t absoluteFrame) noexcept {
    if (sampleRate_ == 0U || channel < 0 || channel > 15 || note < 0 || note > 127 ||
        velocity < 0 || velocity > 127 ||
        absoluteFrame == std::numeric_limits<std::uint64_t>::max() ||
        channel != queuedMidiChannel_.load(std::memory_order_acquire)) {
        rejectedEventCount_.fetch_add(1U, std::memory_order_acq_rel);
        return false;
    }
    Event event;
    event.frame = absoluteFrame;
    event.note = static_cast<std::uint8_t>(note);
    event.channel = static_cast<std::uint8_t>(channel);
    event.velocity = static_cast<std::uint8_t>(velocity);
    if (velocity == 0) {
        event.type = EventType::NoteOff;
    } else {
        const int octave = queuedOctaveShift_.load(std::memory_order_acquire);
        const int transpose = queuedTransposeSemitones_.load(std::memory_order_acquire);
        const double frequency = noteFrequency(note, octave, transpose);
        if (!frequencyIsSupported(frequency)) {
            rejectedEventCount_.fetch_add(1U, std::memory_order_acq_rel);
            return false;
        }
        event.type = EventType::NoteOn;
        event.frequencyHz = static_cast<float>(frequency);
    }
    return enqueueEvent(event);
}

bool NativeOscVocCore::queueNoteOff(int channel, int note,
                                    std::uint64_t absoluteFrame) noexcept {
    if (sampleRate_ == 0U || channel < 0 || channel > 15 || note < 0 || note > 127 ||
        absoluteFrame == std::numeric_limits<std::uint64_t>::max() ||
        channel != queuedMidiChannel_.load(std::memory_order_acquire)) {
        rejectedEventCount_.fetch_add(1U, std::memory_order_acq_rel);
        return false;
    }
    Event event;
    event.frame = absoluteFrame;
    event.note = static_cast<std::uint8_t>(note);
    event.channel = static_cast<std::uint8_t>(channel);
    event.type = EventType::NoteOff;
    return enqueueEvent(event);
}

bool NativeOscVocCore::enqueueEvent(const Event& event) noexcept {
    if (event.frame == std::numeric_limits<std::uint64_t>::max()) {
        rejectedEventCount_.fetch_add(1U, std::memory_order_acq_rel);
        return false;
    }
    if (event.frame < publishedFrame_.load(std::memory_order_acquire)) {
        lateEventCount_.fetch_add(1U, std::memory_order_acq_rel);
        return false;
    }
    if (hasQueuedFrame_ && event.frame < lastQueuedFrame_) {
        rejectedEventCount_.fetch_add(1U, std::memory_order_acq_rel);
        return false;
    }
    const std::uint64_t head = eventHead_.load(std::memory_order_relaxed);
    const std::uint64_t tail = eventTail_.load(std::memory_order_acquire);
    if (head - tail >= static_cast<std::uint64_t>(kNativeOscVocEventQueueCapacity)) {
        overflowEventCount_.fetch_add(1U, std::memory_order_acq_rel);
        return false;
    }
    events_[static_cast<std::size_t>(head % static_cast<std::uint64_t>(kNativeOscVocEventQueueCapacity))] = event;
    // A second timestamp check narrows the producer/consumer boundary race.
    // The queue remains SPSC; MIDI events should be queued before their frame.
    if (event.frame < publishedFrame_.load(std::memory_order_acquire)) {
        lateEventCount_.fetch_add(1U, std::memory_order_acq_rel);
        return false;
    }
    eventHead_.store(head + 1U, std::memory_order_release);
    lastQueuedFrame_ = event.frame;
    hasQueuedFrame_ = true;
    return true;
}

float NativeOscVocCore::processSample(float modulator) noexcept {
    if (sampleRate_ == 0U || frameClock_ == std::numeric_limits<std::uint64_t>::max()) {
        return 0.0f;
    }
    float output = 0.0f;
    (void)processMonoFrame(modulator, modulator, modulator, &output, nullptr);
    return output;
}

bool NativeOscVocCore::processMono(const float* modulator, float* output,
                                   std::size_t frames) noexcept {
    if (sampleRate_ == 0U) {
        return false;
    }
    if (frames == 0U) {
        return true;
    }
    if (modulator == nullptr || output == nullptr ||
        frames > (std::numeric_limits<std::uint64_t>::max() - frameClock_)) {
        return false;
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float sample = boundedSample(modulator[frame]);
        (void)processMonoFrame(sample, sample, sample, &output[frame], nullptr);
    }
    return true;
}

bool NativeOscVocCore::processStereo(const float* interleavedInput, float* interleavedOutput,
                                     std::size_t frames) noexcept {
    if (sampleRate_ == 0U) {
        return false;
    }
    if (frames == 0U) {
        return true;
    }
    if (interleavedInput == nullptr || interleavedOutput == nullptr ||
        frames > (std::numeric_limits<std::uint64_t>::max() - frameClock_) ||
        frames > (std::numeric_limits<std::size_t>::max() / 2U)) {
        return false;
    }
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const std::size_t offset = frame * 2U;
        const float left = boundedSample(interleavedInput[offset]);
        const float right = boundedSample(interleavedInput[offset + 1U]);
        const float modulator = boundedSample(0.5f * (left + right));
        (void)processMonoFrame(modulator, left, right,
            &interleavedOutput[offset], &interleavedOutput[offset + 1U]);
    }
    return true;
}

bool NativeOscVocCore::processInPlace(float* interleaved, std::size_t frames,
                                      std::size_t channels) noexcept {
    if (channels == 1U) {
        return processMono(interleaved, interleaved, frames);
    }
    if (channels == 2U) {
        return processStereo(interleaved, interleaved, frames);
    }
    return false;
}

bool NativeOscVocCore::synchronizeFrame(std::uint64_t absoluteFrame) noexcept {
    if (sampleRate_ == 0U || absoluteFrame < frameClock_ ||
        absoluteFrame == std::numeric_limits<std::uint64_t>::max()) {
        return false;
    }
    std::uint64_t tail = eventTail_.load(std::memory_order_acquire);
    const std::uint64_t head = eventHead_.load(std::memory_order_acquire);
    while (tail < head) {
        const Event& event = events_[static_cast<std::size_t>(tail %
            static_cast<std::uint64_t>(kNativeOscVocEventQueueCapacity))];
        if (event.frame >= absoluteFrame) break;
        lateEventCount_.fetch_add(1U, std::memory_order_acq_rel);
        ++tail;
    }
    if (tail != eventTail_.load(std::memory_order_relaxed)) {
        eventTail_.store(tail, std::memory_order_release);
    }
    frameClock_ = absoluteFrame;
    publishFrame();
    return true;
}

std::size_t NativeOscVocCore::queuedEventCount() const noexcept {
    const std::uint64_t head = eventHead_.load(std::memory_order_acquire);
    const std::uint64_t tail = eventTail_.load(std::memory_order_acquire);
    return static_cast<std::size_t>(head - tail);
}

std::size_t NativeOscVocCore::activeVoiceCount() const noexcept {
    std::size_t count = 0U;
    for (const auto& voice : voices_) {
        if (voice.active) {
            ++count;
        }
    }
    return count;
}

void NativeOscVocCore::dispatchDueEvents(std::uint64_t frame) noexcept {
    std::uint64_t tail = eventTail_.load(std::memory_order_relaxed);
    const std::uint64_t head = eventHead_.load(std::memory_order_acquire);
    while (tail < head) {
        const Event event = events_[static_cast<std::size_t>(tail %
            static_cast<std::uint64_t>(kNativeOscVocEventQueueCapacity))];
        if (event.frame > frame) {
            break;
        }
        if (event.frame == frame && event.channel == static_cast<std::uint8_t>(config_.midiChannel)) {
            if (event.type == EventType::NoteOn) {
                startVoice(event);
            } else {
                releaseVoice(event.channel, event.note);
            }
        }
        ++tail;
    }
    eventTail_.store(tail, std::memory_order_release);
}

void NativeOscVocCore::startVoice(const Event& event) noexcept {
    if (!frequencyIsSupported(static_cast<double>(event.frequencyHz))) {
        return;
    }
    Voice* selected = nullptr;
    for (auto& voice : voices_) {
        if (voice.active && voice.channel == event.channel && voice.note == event.note) {
            selected = &voice;
            break;
        }
        if (!voice.active && selected == nullptr) {
            selected = &voice;
        }
    }
    if (selected == nullptr) {
        selected = &voices_[0U];
        for (auto& voice : voices_) {
            if (voice.age < selected->age) {
                selected = &voice;
            }
        }
    }

    const NativeVocoderWaveform firstWaveform = config_.waveform == NativeOscVocWaveform::Square
        ? NativeVocoderWaveform::Square : NativeVocoderWaveform::Saw;
    if (!selected->oscillatorA.prepare(sampleRate_, event.frequencyHz, firstWaveform) ||
        !selected->oscillatorB.prepare(sampleRate_, event.frequencyHz, NativeVocoderWaveform::Saw)) {
        selected->active = false;
        return;
    }
    selected->oscillatorB.reset(1.0 - static_cast<double>(config_.pulseWidth));
    selected->note = event.note;
    selected->channel = event.channel;
    selected->amplitude = 0.0f;
    selected->targetAmplitude = static_cast<float>(event.velocity) / 127.0f;
    selected->gateOpen = true;
    selected->active = true;
    selected->age = ++voiceAge_;
}

void NativeOscVocCore::releaseVoice(std::uint8_t channel, std::uint8_t note) noexcept {
    for (auto& voice : voices_) {
        if (voice.active && voice.channel == channel && voice.note == note) {
            voice.gateOpen = false;
        }
    }
}

void NativeOscVocCore::configureVoiceWaveform(Voice& voice, NativeOscVocWaveform waveform,
                                               float pulseWidth) noexcept {
    const NativeVocoderWaveform firstWaveform = waveform == NativeOscVocWaveform::Square
        ? NativeVocoderWaveform::Square : NativeVocoderWaveform::Saw;
    (void)voice.oscillatorA.setWaveform(firstWaveform);
    (void)voice.oscillatorB.setWaveform(NativeVocoderWaveform::Saw);
    if (waveform == NativeOscVocWaveform::Pulse) {
        voice.oscillatorB.reset(static_cast<double>(safePulsePhase(
            voice.oscillatorA.phase() + 1.0 - static_cast<double>(pulseWidth))));
    }
}

float NativeOscVocCore::renderCarrierSample() noexcept {
    double carrier = 0.0;
    for (auto& voice : voices_) {
        if (!voice.active) {
            continue;
        }
        const float oscillatorA = voice.oscillatorA.processSample();
        const float oscillatorB = voice.oscillatorB.processSample();
        if (voice.gateOpen) {
            voice.amplitude = static_cast<float>(static_cast<double>(voice.amplitude) +
                ((static_cast<double>(voice.targetAmplitude) - static_cast<double>(voice.amplitude)) *
                 (1.0 - attackCoefficient_)));
        } else {
            voice.amplitude = static_cast<float>(static_cast<double>(voice.amplitude) * releaseCoefficient_);
            if (voice.amplitude <= kVoiceSilenceThreshold) {
                voice.active = false;
                voice.amplitude = 0.0f;
                voice.targetAmplitude = 0.0f;
                continue;
            }
        }

        float waveformSample = oscillatorA;
        if (config_.waveform == NativeOscVocWaveform::Pulse) {
            waveformSample = oscillatorA - oscillatorB;
        }
        carrier += static_cast<double>(waveformSample) * static_cast<double>(voice.amplitude);
    }
    return boundedOutput(carrier);
}

float NativeOscVocCore::processMonoFrame(float modulator, float dryLeft, float dryRight,
                                         float* outputLeft, float* outputRight) noexcept {
    dispatchDueEvents(frameClock_);
    filterBank_.analyzeModulatorSample(boundedSample(modulator));
    const float carrier = renderCarrierSample();
    for (std::size_t band = 0U; band < filterBank_.bandCount(); ++band) {
        bandCarriers_[band] = filterBank_.filterCarrierSample(band, carrier);
    }
    const float wet = filterBank_.synthesizeSample(bandCarriers_.data(), filterBank_.bandCount());

    if (wetMixRampRemaining_ != 0U) {
        wetMixCurrent_ = static_cast<float>(static_cast<double>(wetMixCurrent_) + wetMixStep_);
        --wetMixRampRemaining_;
        if (wetMixRampRemaining_ == 0U) {
            wetMixCurrent_ = wetMixTarget_;
            wetMixStep_ = 0.0;
        }
    }
    const double mix = config_.enabled ? static_cast<double>(wetMixCurrent_) : 0.0;
    const float outputL = boundedOutput((static_cast<double>(boundedSample(dryLeft)) * (1.0 - mix)) +
                                        (static_cast<double>(wet) * mix));
    const float outputR = boundedOutput((static_cast<double>(boundedSample(dryRight)) * (1.0 - mix)) +
                                        (static_cast<double>(wet) * mix));
    if (outputLeft != nullptr) {
        *outputLeft = outputL;
    }
    if (outputRight != nullptr) {
        *outputRight = outputR;
    }

    if (frameClock_ != std::numeric_limits<std::uint64_t>::max()) {
        ++frameClock_;
        publishFrame();
    }
    return outputL;
}

void NativeOscVocCore::publishFrame() noexcept {
    publishedFrame_.store(frameClock_, std::memory_order_release);
}

} // namespace webrc::native
