#include "webrc/dsp/vocoder_fx.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kMaximumExactFrame = 9007199254740992.0;
constexpr float kVoiceIdleThreshold = 1.0e-6f;
constexpr float kDenormalThreshold = 1.0e-20f;

[[nodiscard]] bool finiteRange(float value, float minimum, float maximum) noexcept {
    return std::isfinite(value) && value >= minimum && value <= maximum;
}

[[nodiscard]] bool validWaveform(OscVocWaveform waveform) noexcept {
    return static_cast<std::uint8_t>(waveform) <=
           static_cast<std::uint8_t>(OscVocWaveform::Rect);
}

[[nodiscard]] OscillatorWaveform primitiveWaveform(OscVocWaveform waveform) noexcept {
    switch (waveform) {
    case OscVocWaveform::Saw: return OscillatorWaveform::Saw;
    case OscVocWaveform::Vintage: return OscillatorWaveform::Saw;
    case OscVocWaveform::Detune: return OscillatorWaveform::Saw;
    case OscVocWaveform::Square: return OscillatorWaveform::Square;
    case OscVocWaveform::Rect: return OscillatorWaveform::Saw;
    }
    return OscillatorWaveform::Sine;
}

[[nodiscard]] OscillatorWaveform rectanglePrimitiveWaveform(OscVocWaveform waveform) noexcept {
    return waveform == OscVocWaveform::Rect
        ? OscillatorWaveform::Saw : OscillatorWaveform::Square;
}

[[nodiscard]] float noteFrequency(std::uint8_t note, float cents) noexcept {
    return static_cast<float>(440.0 * std::exp2(
        (static_cast<double>(note) - 69.0 + static_cast<double>(cents) / 100.0) / 12.0));
}

[[nodiscard]] float renderOscillator(PolyBlepOscillator& main,
                                     PolyBlepOscillator& rectOffset,
                                     PolyBlepOscillator& vintageSine,
                                     OscVocWaveform waveform) noexcept {
    const float primary = main.next();
    const float shifted = rectOffset.next();
    const float sine = vintageSine.next();
    switch (waveform) {
    // The rising PolyBLEP saw's fundamental is phase-inverted relative to the
    // oscillator's sine output, so subtracting aligns fundamentals while
    // reducing its upper partials by 20 percent.
    case OscVocWaveform::Vintage: return 0.8f * primary - 0.2f * sine;
    case OscVocWaveform::Rect: return 0.5f * (primary - shifted);
    case OscVocWaveform::Saw:
    case OscVocWaveform::Detune:
    case OscVocWaveform::Square: return primary;
    }
    return 0.0f;
}

[[nodiscard]] float clean(float value) noexcept {
    return std::isfinite(value) && std::fabs(value) >= kDenormalThreshold ? value : 0.0f;
}

[[nodiscard]] float boundedDetectorInput(float value) noexcept {
    return std::clamp(clean(value), -8.0f, 8.0f);
}

} // namespace

std::size_t VocoderFxProcessor::requiredPrepareBytes(
    const ProcessSpec& spec, const VocoderFxOptions& options) noexcept {
    if (!validOptions(spec, options)) return 0U;
    // All bands, oscillators, MIDI voices and retirement tails are inline fixed
    // storage. There is no heap-backed state in this processor or its vocoder.
    return sizeof(VocoderFxProcessor);
}

bool VocoderFxProcessor::validOptions(const ProcessSpec& spec,
                                      const VocoderFxOptions& options) noexcept {
    const auto kind = static_cast<std::uint8_t>(options.kind);
    if (!validProcessSpec(spec) || spec.channels != 2U || spec.sampleRate > 192000.0f ||
        kind > static_cast<std::uint8_t>(VocoderFxKind::OscVocMidi) ||
        options.bandCount < 4U || options.bandCount > MultibandVocoder::kMaximumBands ||
        !finiteRange(options.minimumBandHz, 20.0f, 20000.0f) ||
        !finiteRange(options.maximumBandHz, 21.0f, 20000.0f) ||
        options.maximumBandHz <= options.minimumBandHz ||
        options.maximumBandHz >= 0.48f * spec.sampleRate ||
        !finiteRange(options.bandQ, 0.2f, 20.0f) ||
        !finiteRange(options.envelopeAttackMs, 0.1f, 500.0f) ||
        !finiteRange(options.envelopeReleaseMs, 1.0f, 3000.0f) ||
        !finiteRange(options.oscillatorAttackMs, 0.1f, 500.0f) ||
        !finiteRange(options.oscillatorReleaseMs, 1.0f, 3000.0f) ||
        !finiteRange(options.controlSmoothingMs, 1.0f, 100.0f) ||
        !finiteRange(options.carrierStereoWidth, 0.0f, 1.0f) ||
        !validWaveform(options.waveform)) return false;
    return true;
}

bool VocoderFxProcessor::prepare(const ProcessSpec& spec,
                                 const VocoderFxOptions& options) {
    if (requiredPrepareBytes(spec, options) == 0U) return false;

    MultibandVocoder candidateVocoder{};
    if (!candidateVocoder.prepare(spec, options.bandCount, options.minimumBandHz,
                                  options.maximumBandHz, options.bandQ) ||
        !candidateVocoder.setEnvelopeTimes(options.envelopeAttackMs,
                                           options.envelopeReleaseMs) ||
        !candidateVocoder.setOutputGain(1.0f)) return false;

    auto candidateVoices = std::array<Voice, kVoiceCount>{};
    auto candidateRetired = std::array<RetiredVoice, kRetiredVoiceCount>{};
    const float initialNoteFrequency = noteFrequencyHz(60U);
    for (std::size_t index = 0U; index < candidateVoices.size(); ++index) {
        auto& voice = candidateVoices[index];
        if (!voice.oscillatorLeft.prepare(spec) || !voice.oscillatorRight.prepare(spec) ||
            !voice.vintageSineLeft.prepare(spec) || !voice.vintageSineRight.prepare(spec) ||
            !voice.rectangleLeft.prepare(spec) || !voice.rectangleRight.prepare(spec) ||
            !voice.oscillatorLeft.setFrequency(initialNoteFrequency) ||
            !voice.oscillatorRight.setFrequency(initialNoteFrequency) ||
            !voice.vintageSineLeft.setFrequency(initialNoteFrequency) ||
            !voice.vintageSineRight.setFrequency(initialNoteFrequency) ||
            !voice.rectangleLeft.setFrequency(initialNoteFrequency) ||
            !voice.rectangleRight.setFrequency(initialNoteFrequency)) return false;
        voice.waveform = options.waveform;
        voice.previousWaveform = options.waveform;
        voice.oscillatorLeft.setWaveform(primitiveWaveform(options.waveform));
        voice.oscillatorRight.setWaveform(primitiveWaveform(options.waveform));
        voice.vintageSineLeft.setWaveform(OscillatorWaveform::Sine);
        voice.vintageSineRight.setWaveform(OscillatorWaveform::Sine);
        voice.rectangleLeft.setWaveform(rectanglePrimitiveWaveform(options.waveform));
        voice.rectangleRight.setWaveform(rectanglePrimitiveWaveform(options.waveform));
        voice.oscillatorLeft.reset(0.0f);
        voice.oscillatorRight.reset(options.carrierStereoWidth * 0.5f);
        voice.vintageSineLeft.reset(0.0f);
        voice.vintageSineRight.reset(options.carrierStereoWidth * 0.5f);
        voice.rectangleLeft.reset(0.25f);
        voice.rectangleRight.reset(options.carrierStereoWidth * 0.5f + 0.25f);
        voice.previousWaveformLeft = voice.oscillatorLeft;
        voice.previousWaveformRight = voice.oscillatorRight;
        voice.previousVintageSineLeft = voice.vintageSineLeft;
        voice.previousVintageSineRight = voice.vintageSineRight;
        voice.previousRectangleLeft = voice.rectangleLeft;
        voice.previousRectangleRight = voice.rectangleRight;
    }
    for (auto& tail : candidateRetired) {
        if (!tail.oscillatorLeft.prepare(spec) || !tail.oscillatorRight.prepare(spec) ||
            !tail.vintageSineLeft.prepare(spec) || !tail.vintageSineRight.prepare(spec) ||
            !tail.rectangleLeft.prepare(spec) || !tail.rectangleRight.prepare(spec) ||
            !tail.oscillatorLeft.setFrequency(initialNoteFrequency) ||
            !tail.oscillatorRight.setFrequency(initialNoteFrequency) ||
            !tail.vintageSineLeft.setFrequency(initialNoteFrequency) ||
            !tail.vintageSineRight.setFrequency(initialNoteFrequency) ||
            !tail.rectangleLeft.setFrequency(initialNoteFrequency) ||
            !tail.rectangleRight.setFrequency(initialNoteFrequency)) return false;
        tail.waveform = options.waveform;
        tail.previousWaveform = options.waveform;
        tail.oscillatorLeft.setWaveform(primitiveWaveform(options.waveform));
        tail.oscillatorRight.setWaveform(primitiveWaveform(options.waveform));
        tail.vintageSineLeft.setWaveform(OscillatorWaveform::Sine);
        tail.vintageSineRight.setWaveform(OscillatorWaveform::Sine);
        tail.rectangleLeft.setWaveform(rectanglePrimitiveWaveform(options.waveform));
        tail.rectangleRight.setWaveform(rectanglePrimitiveWaveform(options.waveform));
        tail.vintageSineLeft.reset(0.0f);
        tail.vintageSineRight.reset(options.carrierStereoWidth * 0.5f);
        tail.rectangleLeft.reset(0.25f);
        tail.rectangleRight.reset(options.carrierStereoWidth * 0.5f + 0.25f);
        tail.previousWaveformLeft = tail.oscillatorLeft;
        tail.previousWaveformRight = tail.oscillatorRight;
        tail.previousVintageSineLeft = tail.vintageSineLeft;
        tail.previousVintageSineRight = tail.vintageSineRight;
        tail.previousRectangleLeft = tail.rectangleLeft;
        tail.previousRectangleRight = tail.rectangleRight;
    }

    spec_ = spec;
    options_ = options;
    vocoder_ = candidateVocoder;
    voices_ = candidateVoices;
    retired_ = candidateRetired;
    preparedBytes_ = sizeof(VocoderFxProcessor);
    const double smoothingSeconds = static_cast<double>(options.controlSmoothingMs) * 0.001;
    controlSmoothingCoefficient_ = 1.0 - std::exp(
        -1.0 / (smoothingSeconds * static_cast<double>(spec.sampleRate)));
    activeTarget_ = activeCurrent_ = 0.0f;
    mixTarget_ = mixCurrent_ = 1.0f;
    outputGainTarget_ = outputGainCurrent_ = 1.0f;
    updateVoiceEnvelopeCoefficients();
    noteAge_ = 0U;
    retiredVoiceOverflowCount_ = 0U;
    prepared_ = true;
    reset(0U);
    return true;
}

void VocoderFxProcessor::reset(std::uint64_t absoluteFrame) noexcept {
    if (!prepared_) return;
    const auto maxFrame = static_cast<std::uint64_t>(kMaximumExactFrame);
    expectedFrame_ = std::min(absoluteFrame, maxFrame);
    processingFrame_ = expectedFrame_;
    hasExpectedFrame_ = true;
    noteAge_ = 0U;
    retiredVoiceOverflowCount_ = 0U;
    vocoder_.reset();
    for (auto& voice : voices_) {
        voice.note = 0U;
        voice.envelope = 0.0f;
        voice.targetEnvelope = 0.0f;
        voice.velocityGain = 1.0f;
        voice.age = 0U;
        voice.startedFrame = expectedFrame_;
        voice.active = false;
        voice.oscillatorLeft.setWaveform(primitiveWaveform(options_.waveform));
        voice.oscillatorRight.setWaveform(primitiveWaveform(options_.waveform));
        voice.vintageSineLeft.setWaveform(OscillatorWaveform::Sine);
        voice.vintageSineRight.setWaveform(OscillatorWaveform::Sine);
        voice.rectangleLeft.setWaveform(rectanglePrimitiveWaveform(options_.waveform));
        voice.rectangleRight.setWaveform(rectanglePrimitiveWaveform(options_.waveform));
        voice.oscillatorLeft.setFrequency(noteFrequencyHz(60U));
        voice.oscillatorRight.setFrequency(noteFrequencyHz(60U));
        voice.vintageSineLeft.setFrequency(noteFrequencyHz(60U));
        voice.vintageSineRight.setFrequency(noteFrequencyHz(60U));
        voice.rectangleLeft.setFrequency(noteFrequencyHz(60U));
        voice.rectangleRight.setFrequency(noteFrequencyHz(60U));
        voice.oscillatorLeft.reset(0.0f);
        voice.oscillatorRight.reset(options_.carrierStereoWidth * 0.5f);
        voice.vintageSineLeft.reset(0.0f);
        voice.vintageSineRight.reset(options_.carrierStereoWidth * 0.5f);
        voice.rectangleLeft.reset(0.25f);
        voice.rectangleRight.reset(options_.carrierStereoWidth * 0.5f + 0.25f);
        voice.waveform = options_.waveform;
        voice.previousWaveform = options_.waveform;
        voice.previousWaveformLeft = voice.oscillatorLeft;
        voice.previousWaveformRight = voice.oscillatorRight;
        voice.previousVintageSineLeft = voice.vintageSineLeft;
        voice.previousVintageSineRight = voice.vintageSineRight;
        voice.previousRectangleLeft = voice.rectangleLeft;
        voice.previousRectangleRight = voice.rectangleRight;
        voice.waveformFadeRemaining = 0U;
    }
    for (auto& tail : retired_) {
        tail.gain = 0.0f;
        tail.remaining = 0U;
    }
    activeCurrent_ = activeTarget_;
    mixCurrent_ = mixTarget_;
    outputGainCurrent_ = outputGainTarget_;
}

bool VocoderFxProcessor::validateEvent(const VocoderFxEvent& event) const noexcept {
    switch (event.control) {
    case VocoderFxControl::Active:
    case VocoderFxControl::Mix:
        return finiteRange(event.value, 0.0f, 1.0f);
    case VocoderFxControl::OutputDb:
        return finiteRange(event.value, -60.0f, 12.0f);
    case VocoderFxControl::EnvelopeAttackMs:
        return finiteRange(event.value, 0.1f, 500.0f);
    case VocoderFxControl::EnvelopeReleaseMs:
        return finiteRange(event.value, 1.0f, 3000.0f);
    case VocoderFxControl::MidiNoteOn:
        return options_.kind == VocoderFxKind::OscVocMidi &&
               finiteRange(event.value, 0.0f, 1.0f) &&
               noteFrequencyHz(event.midiNote) <= 0.45f * spec_.sampleRate;
    case VocoderFxControl::MidiNoteOff:
        return options_.kind == VocoderFxKind::OscVocMidi && event.value == 0.0f;
    case VocoderFxControl::MidiAllNotesOff:
        return options_.kind == VocoderFxKind::OscVocMidi && event.value == 0.0f;
    case VocoderFxControl::Waveform:
        return options_.kind == VocoderFxKind::OscVocMidi &&
               finiteRange(event.value, 0.0f, 4.0f) &&
               std::floor(event.value) == event.value;
    }
    return false;
}

bool VocoderFxProcessor::validateEvents(std::uint64_t blockStartFrame,
                                        std::uint32_t frames,
                                        const VocoderFxEvent* events,
                                        std::uint32_t eventCount) const noexcept {
    if (eventCount > kMaximumControlEventsPerBlock ||
        (eventCount > 0U && events == nullptr)) return false;
    std::uint32_t previousOffset = 0U;
    bool havePrevious = false;
    std::uint32_t lastPositiveNoteOnOffset = 0U;
    bool hasPositiveNoteOn = false;
    for (std::uint32_t index = 0U; index < eventCount; ++index) {
        const auto& event = events[index];
        if (event.frameOffset >= frames ||
            (havePrevious && event.frameOffset < previousOffset) || !validateEvent(event))
            return false;
        if (event.control == VocoderFxControl::MidiNoteOn && event.value > 0.0f) {
            lastPositiveNoteOnOffset = event.frameOffset;
            hasPositiveNoteOn = true;
        }
        previousOffset = event.frameOffset;
        havePrevious = true;
    }
    if (!hasPositiveNoteOn) return true;

    // Preflight voice steals on a compact copy before touching audio or state.
    // Chords at one timestamp are valid, but every active voice displaced by a
    // chord needs its own still-live 64-sample retirement slot. The simulation
    // follows the exact per-frame envelope/tail countdown through the last
    // note-on in this block, so an over-capacity chord rejects transactionally.
    struct SimVoice {
        std::uint8_t note = 0U;
        float envelope = 0.0f;
        float targetEnvelope = 0.0f;
        std::uint64_t age = 0U;
        std::uint64_t startedFrame = 0U;
        bool active = false;
    };
    std::array<SimVoice, kVoiceCount> simulatedVoices{};
    std::array<std::uint32_t, kRetiredVoiceCount> simulatedTailRemaining{};
    for (std::size_t index = 0U; index < voices_.size(); ++index) {
        simulatedVoices[index] = {voices_[index].note, voices_[index].envelope,
                                  voices_[index].targetEnvelope, voices_[index].age,
                                  voices_[index].startedFrame,
                                  voices_[index].active};
    }
    for (std::size_t index = 0U; index < retired_.size(); ++index)
        simulatedTailRemaining[index] = retired_[index].remaining;
    std::uint64_t simulatedAge = noteAge_;

    const auto advance = [&](std::uint32_t sampleCount) noexcept {
        for (std::uint32_t sample = 0U; sample < sampleCount; ++sample) {
            for (auto& voice : simulatedVoices) {
                if (!voice.active) continue;
                const float coefficient = voice.targetEnvelope > voice.envelope
                    ? oscillatorAttackCoefficient_ : oscillatorReleaseCoefficient_;
                voice.envelope = clean(voice.envelope + coefficient *
                    (voice.targetEnvelope - voice.envelope));
                if (voice.targetEnvelope == 0.0f &&
                    voice.envelope <= kVoiceIdleThreshold) {
                    voice.envelope = 0.0f;
                    voice.active = false;
                }
            }
            for (auto& remaining : simulatedTailRemaining)
                if (remaining > 0U) --remaining;
        }
    };
    const auto releaseNote = [&](std::uint8_t note) noexcept {
        for (auto& voice : simulatedVoices)
            if (voice.active && voice.note == note) voice.targetEnvelope = 0.0f;
    };
    const auto simulateNoteOn = [&](std::uint8_t note,
                                    std::uint64_t absoluteFrame) noexcept {
        SimVoice* selected = nullptr;
        for (auto& voice : simulatedVoices) {
            if (voice.active && voice.note == note) {
                selected = &voice;
                break;
            }
        }
        if (selected == nullptr) {
            for (auto& voice : simulatedVoices) {
                if (!voice.active) {
                    selected = &voice;
                    break;
                }
            }
        }
        if (selected == nullptr) {
            selected = nullptr;
            for (auto& voice : simulatedVoices) {
                if (voice.startedFrame == absoluteFrame) continue;
                if (selected == nullptr) {
                    selected = &voice;
                    continue;
                }
                if (voice.envelope < selected->envelope ||
                    (voice.envelope == selected->envelope && voice.age < selected->age))
                    selected = &voice;
            }
            if (selected == nullptr) {
                selected = &simulatedVoices[0U];
                for (auto& voice : simulatedVoices) {
                    if (voice.envelope < selected->envelope ||
                        (voice.envelope == selected->envelope && voice.age < selected->age))
                        selected = &voice;
                }
            }
        }
        if (selected->active && selected->envelope > kVoiceIdleThreshold) {
            auto tail = std::find(simulatedTailRemaining.begin(),
                                  simulatedTailRemaining.end(), 0U);
            if (tail == simulatedTailRemaining.end()) return false;
            *tail = kVoiceStealFadeSamples;
        }
        selected->note = note;
        selected->envelope = 0.0f;
        selected->targetEnvelope = 1.0f;
        selected->age = simulatedAge;
        if (simulatedAge != std::numeric_limits<std::uint64_t>::max()) ++simulatedAge;
        selected->startedFrame = absoluteFrame;
        selected->active = true;
        return true;
    };

    std::uint32_t cursor = 0U;
    std::uint32_t eventIndex = 0U;
    while (eventIndex < eventCount && events[eventIndex].frameOffset <= lastPositiveNoteOnOffset) {
        const std::uint32_t groupOffset = events[eventIndex].frameOffset;
        advance(groupOffset - cursor);
        while (eventIndex < eventCount && events[eventIndex].frameOffset == groupOffset) {
            const auto& event = events[eventIndex++];
            switch (event.control) {
            case VocoderFxControl::MidiNoteOn:
                if (event.value == 0.0f) releaseNote(event.midiNote);
                else if (!simulateNoteOn(event.midiNote, blockStartFrame + groupOffset))
                    return false;
                break;
            case VocoderFxControl::MidiNoteOff:
                releaseNote(event.midiNote);
                break;
            case VocoderFxControl::MidiAllNotesOff:
                for (auto& voice : simulatedVoices)
                    if (voice.active) voice.targetEnvelope = 0.0f;
                break;
            default:
                break;
            }
        }
        advance(1U);
        cursor = groupOffset + 1U;
    }
    return true;
}

void VocoderFxProcessor::applyEvent(const VocoderFxEvent& event) noexcept {
    switch (event.control) {
    case VocoderFxControl::Active:
        activeTarget_ = event.value;
        break;
    case VocoderFxControl::Mix:
        mixTarget_ = event.value;
        break;
    case VocoderFxControl::OutputDb:
        outputGainTarget_ = static_cast<float>(std::pow(10.0,
            static_cast<double>(event.value) / 20.0));
        break;
    case VocoderFxControl::EnvelopeAttackMs:
        options_.envelopeAttackMs = event.value;
        (void)vocoder_.setEnvelopeTimes(options_.envelopeAttackMs,
                                        options_.envelopeReleaseMs);
        break;
    case VocoderFxControl::EnvelopeReleaseMs:
        options_.envelopeReleaseMs = event.value;
        (void)vocoder_.setEnvelopeTimes(options_.envelopeAttackMs,
                                        options_.envelopeReleaseMs);
        break;
    case VocoderFxControl::MidiNoteOn:
        if (event.value == 0.0f) noteOff(event.midiNote);
        else noteOn(event.midiNote, event.value);
        break;
    case VocoderFxControl::MidiNoteOff:
        noteOff(event.midiNote);
        break;
    case VocoderFxControl::MidiAllNotesOff:
        for (auto& voice : voices_) {
            if (voice.active) voice.targetEnvelope = 0.0f;
        }
        break;
    case VocoderFxControl::Waveform:
        setWaveform(static_cast<OscVocWaveform>(static_cast<std::uint8_t>(event.value)));
        break;
    }
}

void VocoderFxProcessor::setWaveform(OscVocWaveform waveform) noexcept {
    if (!validWaveform(waveform) || waveform == options_.waveform) return;
    options_.waveform = waveform;
    for (auto& voice : voices_) {
        if (!voice.active) continue;
        voice.previousWaveformLeft = voice.oscillatorLeft;
        voice.previousWaveformRight = voice.oscillatorRight;
        voice.previousVintageSineLeft = voice.vintageSineLeft;
        voice.previousVintageSineRight = voice.vintageSineRight;
        voice.previousRectangleLeft = voice.rectangleLeft;
        voice.previousRectangleRight = voice.rectangleRight;
        voice.previousWaveform = voice.waveform;
        voice.waveformFadeRemaining = kVoiceStealFadeSamples;
        voice.waveform = waveform;
        const float leftCents = waveform == OscVocWaveform::Detune ? -8.0f : 0.0f;
        const float rightCents = waveform == OscVocWaveform::Detune ? 8.0f : 0.0f;
        voice.oscillatorLeft.setFrequency(noteFrequency(voice.note, leftCents));
        voice.oscillatorRight.setFrequency(noteFrequency(voice.note, rightCents));
        voice.vintageSineLeft.setFrequency(noteFrequency(voice.note, leftCents));
        voice.vintageSineRight.setFrequency(noteFrequency(voice.note, rightCents));
        voice.rectangleLeft.setFrequency(noteFrequency(voice.note, leftCents));
        voice.rectangleRight.setFrequency(noteFrequency(voice.note, rightCents));
        voice.oscillatorLeft.setWaveform(primitiveWaveform(waveform));
        voice.oscillatorRight.setWaveform(primitiveWaveform(waveform));
        voice.rectangleLeft.setWaveform(rectanglePrimitiveWaveform(waveform));
        voice.rectangleRight.setWaveform(rectanglePrimitiveWaveform(waveform));
    }
}

void VocoderFxProcessor::noteOn(std::uint8_t note, float velocity) noexcept {
    Voice* selected = nullptr;
    for (auto& voice : voices_) {
        if (voice.active && voice.note == note) {
            selected = &voice;
            break;
        }
    }
    if (selected == nullptr) {
        for (auto& voice : voices_) {
            if (!voice.active) {
                selected = &voice;
                break;
            }
        }
    }
    if (selected == nullptr) {
        for (auto& voice : voices_) {
            if (!voice.active || voice.startedFrame == processingFrame_) continue;
            if (selected == nullptr || voice.envelope < selected->envelope ||
                (voice.envelope == selected->envelope && voice.age < selected->age))
                selected = &voice;
        }
        if (selected == nullptr) {
            selected = &voices_[0U];
            for (auto& voice : voices_) {
                if (voice.envelope < selected->envelope ||
                    (voice.envelope == selected->envelope && voice.age < selected->age))
                    selected = &voice;
            }
        }
    }
    if (selected->active) retireVoice(*selected);

    const float leftCents = options_.waveform == OscVocWaveform::Detune ? -8.0f : 0.0f;
    const float rightCents = options_.waveform == OscVocWaveform::Detune ? 8.0f : 0.0f;
    selected->oscillatorLeft.setWaveform(primitiveWaveform(options_.waveform));
    selected->oscillatorRight.setWaveform(primitiveWaveform(options_.waveform));
    selected->vintageSineLeft.setWaveform(OscillatorWaveform::Sine);
    selected->vintageSineRight.setWaveform(OscillatorWaveform::Sine);
    selected->oscillatorLeft.setFrequency(noteFrequency(note, leftCents));
    selected->oscillatorRight.setFrequency(noteFrequency(note, rightCents));
    selected->vintageSineLeft.setFrequency(noteFrequency(note, leftCents));
    selected->vintageSineRight.setFrequency(noteFrequency(note, rightCents));
    selected->rectangleLeft.setWaveform(rectanglePrimitiveWaveform(options_.waveform));
    selected->rectangleRight.setWaveform(rectanglePrimitiveWaveform(options_.waveform));
    selected->rectangleLeft.setFrequency(noteFrequency(note, leftCents));
    selected->rectangleRight.setFrequency(noteFrequency(note, rightCents));
    selected->oscillatorLeft.reset(0.0f);
    selected->oscillatorRight.reset(options_.carrierStereoWidth * 0.5f);
    selected->vintageSineLeft.reset(0.0f);
    selected->vintageSineRight.reset(options_.carrierStereoWidth * 0.5f);
    selected->rectangleLeft.reset(0.25f);
    selected->rectangleRight.reset(options_.carrierStereoWidth * 0.5f + 0.25f);
    selected->waveform = options_.waveform;
    selected->previousWaveform = options_.waveform;
    selected->previousWaveformLeft = selected->oscillatorLeft;
    selected->previousWaveformRight = selected->oscillatorRight;
    selected->previousVintageSineLeft = selected->vintageSineLeft;
    selected->previousVintageSineRight = selected->vintageSineRight;
    selected->previousRectangleLeft = selected->rectangleLeft;
    selected->previousRectangleRight = selected->rectangleRight;
    selected->waveformFadeRemaining = 0U;
    selected->note = note;
    selected->envelope = 0.0f;
    selected->targetEnvelope = 1.0f;
    selected->velocityGain = velocity;
    selected->age = noteAge_;
    if (noteAge_ != std::numeric_limits<std::uint64_t>::max()) ++noteAge_;
    selected->startedFrame = processingFrame_;
    selected->active = true;
}

void VocoderFxProcessor::noteOff(std::uint8_t note) noexcept {
    for (auto& voice : voices_) {
        if (voice.active && voice.note == note) voice.targetEnvelope = 0.0f;
    }
}

void VocoderFxProcessor::retireVoice(Voice& voice) noexcept {
    if (!voice.active || voice.envelope <= kVoiceIdleThreshold) return;
    RetiredVoice* selected = nullptr;
    for (auto& tail : retired_) {
        if (tail.remaining == 0U) {
            selected = &tail;
            break;
        }
    }
    if (selected == nullptr) {
        // validateEvents preflights all same-frame chords and rejects the block
        // before processing when no complete set of tails is available. Keep a
        // deterministic fallback here as a last-resort guard if this method is
        // called under a future contract that bypasses block validation.
        ++retiredVoiceOverflowCount_;
        selected = &*std::min_element(retired_.begin(), retired_.end(),
            [](const RetiredVoice& left, const RetiredVoice& right) {
                return left.remaining < right.remaining;
            });
    }
    selected->oscillatorLeft = voice.oscillatorLeft;
    selected->oscillatorRight = voice.oscillatorRight;
    selected->vintageSineLeft = voice.vintageSineLeft;
    selected->vintageSineRight = voice.vintageSineRight;
    selected->rectangleLeft = voice.rectangleLeft;
    selected->rectangleRight = voice.rectangleRight;
    selected->previousWaveformLeft = voice.previousWaveformLeft;
    selected->previousWaveformRight = voice.previousWaveformRight;
    selected->previousVintageSineLeft = voice.previousVintageSineLeft;
    selected->previousVintageSineRight = voice.previousVintageSineRight;
    selected->previousRectangleLeft = voice.previousRectangleLeft;
    selected->previousRectangleRight = voice.previousRectangleRight;
    selected->waveform = voice.waveform;
    selected->previousWaveform = voice.previousWaveform;
    selected->waveformFadeRemaining = voice.waveformFadeRemaining;
    selected->gain = clean(voice.envelope * voice.velocityGain);
    selected->remaining = kVoiceStealFadeSamples;
}

void VocoderFxProcessor::updateVoiceEnvelopeCoefficients() noexcept {
    const double sampleRate = static_cast<double>(spec_.sampleRate);
    const double attackSeconds = static_cast<double>(options_.oscillatorAttackMs) * 0.001;
    const double releaseSeconds = static_cast<double>(options_.oscillatorReleaseMs) * 0.001;
    oscillatorAttackCoefficient_ = static_cast<float>(1.0 - std::exp(
        -1.0 / std::max(1.0, sampleRate * attackSeconds)));
    oscillatorReleaseCoefficient_ = static_cast<float>(1.0 - std::exp(
        -1.0 / std::max(1.0, sampleRate * releaseSeconds)));
}

float VocoderFxProcessor::noteFrequencyHz(std::uint8_t note) noexcept {
    return static_cast<float>(440.0 * std::exp2(
        (static_cast<double>(note) - 69.0) / 12.0));
}

StereoFrame VocoderFxProcessor::renderCarrier() noexcept {
    double left = 0.0;
    double right = 0.0;
    for (auto& voice : voices_) {
        if (!voice.active) continue;
        const float coefficient = voice.targetEnvelope > voice.envelope
            ? oscillatorAttackCoefficient_ : oscillatorReleaseCoefficient_;
        voice.envelope = clean(voice.envelope + coefficient *
            (voice.targetEnvelope - voice.envelope));
        if (voice.targetEnvelope == 0.0f && voice.envelope <= kVoiceIdleThreshold) {
            voice.envelope = 0.0f;
            voice.active = false;
            continue;
        }
        float voiceLeft = renderOscillator(voice.oscillatorLeft, voice.rectangleLeft,
                                           voice.vintageSineLeft,
                                           voice.waveform);
        float voiceRight = renderOscillator(voice.oscillatorRight, voice.rectangleRight,
                                            voice.vintageSineRight,
                                            voice.waveform);
        if (voice.waveformFadeRemaining > 0U) {
            const float oldLeft = renderOscillator(voice.previousWaveformLeft,
                voice.previousRectangleLeft, voice.previousVintageSineLeft,
                voice.previousWaveform);
            const float oldRight = renderOscillator(voice.previousWaveformRight,
                voice.previousRectangleRight, voice.previousVintageSineRight,
                voice.previousWaveform);
            const float phase = static_cast<float>(kVoiceStealFadeSamples -
                voice.waveformFadeRemaining) /
                static_cast<float>(kVoiceStealFadeSamples - 1U);
            voiceLeft = equalPowerCrossfade(oldLeft, voiceLeft, phase);
            voiceRight = equalPowerCrossfade(oldRight, voiceRight, phase);
            --voice.waveformFadeRemaining;
        }
        left += static_cast<double>(voiceLeft) *
                voice.envelope * voice.velocityGain;
        right += static_cast<double>(voiceRight) *
                 voice.envelope * voice.velocityGain;
    }
    for (auto& tail : retired_) {
        if (tail.remaining == 0U) continue;
        const float fade = static_cast<float>(tail.remaining) /
                           static_cast<float>(kVoiceStealFadeSamples);
        float tailLeft = renderOscillator(tail.oscillatorLeft,
            tail.rectangleLeft, tail.vintageSineLeft, tail.waveform);
        float tailRight = renderOscillator(tail.oscillatorRight,
            tail.rectangleRight, tail.vintageSineRight, tail.waveform);
        if (tail.waveformFadeRemaining > 0U) {
            const float oldLeft = renderOscillator(tail.previousWaveformLeft,
                tail.previousRectangleLeft, tail.previousVintageSineLeft,
                tail.previousWaveform);
            const float oldRight = renderOscillator(tail.previousWaveformRight,
                tail.previousRectangleRight, tail.previousVintageSineRight,
                tail.previousWaveform);
            const float phase = static_cast<float>(kVoiceStealFadeSamples -
                tail.waveformFadeRemaining) /
                static_cast<float>(kVoiceStealFadeSamples - 1U);
            tailLeft = equalPowerCrossfade(oldLeft, tailLeft, phase);
            tailRight = equalPowerCrossfade(oldRight, tailRight, phase);
            --tail.waveformFadeRemaining;
        }
        left += static_cast<double>(tailLeft) * tail.gain * fade;
        right += static_cast<double>(tailRight) * tail.gain * fade;
        --tail.remaining;
        if (tail.remaining == 0U) tail.gain = 0.0f;
    }
    const double polyphonyHeadroom = 1.0 / std::sqrt(static_cast<double>(kVoiceCount));
    return {clean(static_cast<float>(left * polyphonyHeadroom)),
            clean(static_cast<float>(right * polyphonyHeadroom))};
}

void VocoderFxProcessor::advanceControls() noexcept {
    const float coefficient = static_cast<float>(controlSmoothingCoefficient_);
    activeCurrent_ += coefficient * (activeTarget_ - activeCurrent_);
    mixCurrent_ += coefficient * (mixTarget_ - mixCurrent_);
    outputGainCurrent_ += coefficient * (outputGainTarget_ - outputGainCurrent_);
    activeCurrent_ = std::clamp(clean(activeCurrent_), 0.0f, 1.0f);
    mixCurrent_ = std::clamp(clean(mixCurrent_), 0.0f, 1.0f);
    outputGainCurrent_ = std::clamp(clean(outputGainCurrent_), 0.0f, 4.0f);
}

bool VocoderFxProcessor::processBlock(std::uint64_t blockStartFrame,
                                      StereoFrame* interleaved,
                                      std::uint32_t frames,
                                      const VocoderFxEvent* events,
                                      std::uint32_t eventCount) noexcept {
    if (options_.kind != VocoderFxKind::OscVocMidi) return false;
    return processBlockInternal(blockStartFrame, interleaved, nullptr, frames,
                                events, eventCount);
}

bool VocoderFxProcessor::processBlockWithCarrier(
    std::uint64_t blockStartFrame, StereoFrame* interleaved,
    const StereoFrame* carrier, std::uint32_t frames,
    const VocoderFxEvent* events, std::uint32_t eventCount) noexcept {
    if (options_.kind != VocoderFxKind::Vocoder || carrier == nullptr) return false;
    return processBlockInternal(blockStartFrame, interleaved, carrier, frames,
                                events, eventCount);
}

bool VocoderFxProcessor::processBlockInternal(std::uint64_t blockStartFrame,
                                      StereoFrame* interleaved,
                                      const StereoFrame* externalCarrier,
                                      std::uint32_t frames,
                                      const VocoderFxEvent* events,
                                      std::uint32_t eventCount) noexcept {
    const auto maximumExact = static_cast<std::uint64_t>(kMaximumExactFrame);
    if (!prepared_ || interleaved == nullptr || frames > spec_.maxBlockFrames ||
        blockStartFrame > maximumExact || frames > maximumExact - blockStartFrame ||
        !validateEvents(blockStartFrame, frames, events, eventCount) ||
        (hasExpectedFrame_ && blockStartFrame != expectedFrame_)) return false;

    std::uint32_t eventIndex = 0U;
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        processingFrame_ = blockStartFrame + frame;
        while (eventIndex < eventCount && events[eventIndex].frameOffset == frame)
            applyEvent(events[eventIndex++]);

        advanceControls();
        auto& sample = interleaved[frame];
        const float dryLeft = clean(sample.left);
        const float dryRight = clean(sample.right);
        const auto carrier = externalCarrier == nullptr
            ? renderCarrier()
            : StereoFrame{boundedDetectorInput(externalCarrier[frame].left),
                          boundedDetectorInput(externalCarrier[frame].right)};
        const auto wet = vocoder_.processSample(boundedDetectorInput(dryLeft),
                                                boundedDetectorInput(dryRight),
                                                carrier.left, carrier.right);
        const float effectAmount = activeCurrent_ * mixCurrent_;
        sample.left = clean(dryLeft * (1.0f - effectAmount) +
                            wet.left * outputGainCurrent_ * effectAmount);
        sample.right = clean(dryRight * (1.0f - effectAmount) +
                             wet.right * outputGainCurrent_ * effectAmount);
    }
    expectedFrame_ = blockStartFrame + frames;
    hasExpectedFrame_ = true;
    return true;
}

std::uint32_t VocoderFxProcessor::activeVoices() const noexcept {
    std::uint32_t count = 0U;
    for (const auto& voice : voices_) if (voice.active) ++count;
    return count;
}

std::uint32_t VocoderFxProcessor::retiredVoices() const noexcept {
    std::uint32_t count = 0U;
    for (const auto& tail : retired_) if (tail.remaining > 0U) ++count;
    return count;
}

} // namespace webrc::dsp
