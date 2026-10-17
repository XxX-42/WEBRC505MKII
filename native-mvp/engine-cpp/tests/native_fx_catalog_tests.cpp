#include "native_fx_catalog.hpp"
#include "native_electric_processor.hpp"
#include "native_alloc_tracker.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <initializer_list>
#include <limits>
#include <string_view>
#include <utility>
#include <vector>

using namespace webrc::native;

namespace {

constexpr double kPi = 3.14159265358979323846;

double estimatePositiveCrossingHz(const std::vector<float>& signal, std::size_t begin, std::size_t end,
                                  unsigned int sampleRate) {
    assert(end > begin + 1U);
    std::size_t crossings = 0U;
    for (std::size_t index = begin + 1U; index < end; ++index) {
        if (signal[index - 1U] <= 0.0f && signal[index] > 0.0f) ++crossings;
    }
    return static_cast<double>(crossings) * static_cast<double>(sampleRate) /
        static_cast<double>(end - begin);
}

void expectNear(float actual, float expected, float tolerance = 1.0e-5f) {
    assert(std::isfinite(actual));
    assert(std::fabs(actual - expected) <= tolerance);
}

double dftMagnitude(const std::vector<float>& signal, std::size_t begin, std::size_t frames,
                    unsigned int sampleRate, double frequencyHz) {
    assert(begin + frames <= signal.size() && frames > 0U);
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t offset = 0U; offset < frames; ++offset) {
        const double phase = 2.0 * kPi * frequencyHz * static_cast<double>(offset) /
            static_cast<double>(sampleRate);
        const double sample = signal[begin + offset];
        real += sample * std::cos(phase);
        imaginary -= sample * std::sin(phase);
    }
    return std::hypot(real, imaginary) / static_cast<double>(frames);
}

double segmentRms(const std::vector<float>& signal, std::size_t begin, std::size_t frames) {
    assert(begin + frames <= signal.size() && frames > 0U);
    double energy = 0.0;
    for (std::size_t offset = 0U; offset < frames; ++offset) {
        const double sample = signal[begin + offset];
        assert(std::isfinite(sample));
        energy += sample * sample;
    }
    return std::sqrt(energy / static_cast<double>(frames));
}

void configureFilter(NativeEffectBank& bank, NativeEffectSlot slot, std::string_view id, float cutoff) {
    assert(bank.setEffect(slot, id));
    assert(bank.setParameter(slot, "cutoff_hz", cutoff, 1U));
    assert(bank.setParameter(slot, "q", 0.8f, 1U));
}

void configurePhaser(NativeEffectBank& bank, NativeEffectSlot slot) {
    assert(bank.setEffect(slot, "phaser"));
    assert(bank.setParameter(slot, "stages", 8.0f, 1U));
    assert(bank.setParameter(slot, "rate_hz", 2.1f, 1U));
    assert(bank.setParameter(slot, "depth", 0.95f, 1U));
    assert(bank.setParameter(slot, "feedback", 0.3f, 1U));
    assert(bank.setParameter(slot, "wet_mix", 0.8f, 1U));
}

void configureAutoPan(NativeEffectBank& bank, NativeEffectSlot slot, float waveform) {
    assert(bank.setEffect(slot, "auto_pan"));
    assert(bank.setParameter(slot, "rate_hz", 1.7f, 1U));
    assert(bank.setParameter(slot, "depth", 0.95f, 1U));
    assert(bank.setParameter(slot, "waveform", waveform, 1U));
    assert(bank.setParameter(slot, "wet_mix", 1.0f, 1U));
}

void configureTremolo(NativeEffectProcessor& tremolo, float waveform) {
    assert(tremolo.setParameter("rate_hz", 1.0f, 1U));
    assert(tremolo.setParameter("depth", 1.0f, 1U));
    assert(tremolo.setParameter("waveform", waveform, 1U));
    assert(tremolo.setParameter("wet_mix", 1.0f, 1U));
}

void testCatalogAndBounds() {
    std::size_t count = 0U;
    const auto* catalog = nativeEffectCatalog(count);
    assert(catalog != nullptr);
    assert(count == 52U);
    const std::array<std::string_view, 52U> ids{{
        "filter.lpf", "filter.bpf", "filter.hpf", "phaser", "flanger", "dynamics", "dist", "reverb", "gate_reverb", "beat_repeat", "beat_scatter", "roll", "freeze", "warp", "tape_echo", "reverse_delay", "reverse_reverb", "fractional_delay", "mod_delay", "panning_delay", "twist", "granular_delay", "auto_pan", "manual_pan", "chorus", "tremolo", "ring_mod", "eq", "isolator", "stereo_enhance", "lo_fi", "radio", "sustainer", "vibrato", "slow_gear", "pattern_slicer", "step_slicer", "vinyl_flick", "preamp", "synth", "g2b", "transpose", "pitch_bend", "hrm_manual", "octave", "vocoder", "osc_voc_m", "osc_bot", "auto_riff", "hrm_auto_m", "robot", "electric"
    }};
    for (std::size_t index = 0U; index < ids.size(); ++index) {
        assert(catalog[index].id == ids[index]);
        assert(findNativeEffectDescriptor(ids[index]) == &catalog[index]);
        assert(createNativeEffectProcessor(ids[index]) != nullptr);
    }
    assert(findNativeEffectDescriptor("missing.reverb") == nullptr);
    assert(findNativeEffectParameter("filter.lpf", "cutoff_hz") != nullptr);
    assert(findNativeEffectParameter("filter.lpf", "not_a_parameter") == nullptr);
    assert(createNativeEffectProcessor("missing.reverb") == nullptr);
    assert(!nativeEffectSupportsPerTrackInsert("missing.reverb"));
    assert(!nativeEffectSupportsPerTrackInsert("beat_shift"));
    assert(!nativeEffectSupportsPerTrackInsert("vinyl_flick"));
    NativeEffectBank unknownBank;
    assert(unknownBank.prepare(48000U));
    assert(!unknownBank.setEffect(NativeEffectSlot::A, "missing.reverb"));
    assert(unknownBank.processor(NativeEffectSlot::A) == nullptr);
    const auto* vocoderDescriptor = findNativeEffectDescriptor("vocoder");
    assert(vocoderDescriptor != nullptr && vocoderDescriptor->sourceIndex == 20);
    assert(vocoderDescriptor->inputAvailable && vocoderDescriptor->trackAvailable);
    assert(findNativeEffectParameter("vocoder", "bands") != nullptr);
    assert(findNativeEffectParameter("vocoder", "carrier") != nullptr);
    assert(findNativeEffectParameter("vocoder", "mix_percent") != nullptr);
    const auto* electricDescriptor = findNativeEffectDescriptor("electric");
    assert(electricDescriptor != nullptr && electricDescriptor->sourceIndex == 17);
    assert(electricDescriptor->inputAvailable && electricDescriptor->trackAvailable);
    assert(findNativeEffectParameter("electric", "character") != nullptr);
    assert(findNativeEffectParameter("electric", "pitch-snap") != nullptr);
    assert(findNativeEffectParameter("electric", "tone") != nullptr);
    assert(findNativeEffectParameter("electric", "mix") != nullptr);
    const auto* autoRiffDescriptor = findNativeEffectDescriptor("auto_riff");
    assert(autoRiffDescriptor != nullptr && autoRiffDescriptor->sourceIndex == 12);
    assert(autoRiffDescriptor->inputAvailable && autoRiffDescriptor->trackAvailable);
    assert(findNativeEffectParameter("auto_riff", "bpm") != nullptr);
    assert(findNativeEffectParameter("auto_riff", "scale") != nullptr);
    assert(findNativeEffectParameter("auto_riff", "rate_beats") != nullptr);
    assert(findNativeEffectParameter("auto_riff", "sensitivity_percent") != nullptr);
    assert(findNativeEffectParameter("auto_riff", "mix_percent") != nullptr);
    const auto* hrmAutoDescriptor = findNativeEffectDescriptor("hrm_auto_m");
    assert(hrmAutoDescriptor != nullptr && hrmAutoDescriptor->sourceIndex == 19);
    assert(hrmAutoDescriptor->inputAvailable && hrmAutoDescriptor->trackAvailable);
    assert(findNativeEffectParameter("hrm_auto_m", "key") != nullptr);
    assert(findNativeEffectParameter("hrm_auto_m", "scale") != nullptr);
    assert(findNativeEffectParameter("hrm_auto_m", "midi-channel") != nullptr);
    assert(findNativeEffectParameter("hrm_auto_m", "mix_percent") != nullptr);
    const auto* robotDescriptor = findNativeEffectDescriptor("robot");
    assert(robotDescriptor != nullptr && robotDescriptor->sourceIndex == 16);
    assert(robotDescriptor->inputAvailable && robotDescriptor->trackAvailable);
    assert(robotDescriptor->name.find("clean-room") != std::string_view::npos);
    assert(robotDescriptor->parameterCount == 3U);
    const auto* robotPitch = findNativeEffectParameter("robot", "pitch_semitones");
    const auto* robotFormant = findNativeEffectParameter("robot", "formant_semitones");
    const auto* robotMix = findNativeEffectParameter("robot", "mix_percent");
    assert(robotPitch != nullptr && robotPitch->minimum == -24.0f && robotPitch->maximum == 24.0f &&
        robotPitch->defaultValue == 0.0f);
    assert(robotFormant != nullptr && robotFormant->minimum == -12.0f && robotFormant->maximum == 12.0f &&
        robotFormant->defaultValue == 0.0f);
    assert(robotMix != nullptr && robotMix->minimum == 0.0f && robotMix->maximum == 100.0f &&
        robotMix->defaultValue == 100.0f);
    const auto* oscVocMDescriptor = findNativeEffectDescriptor("osc_voc_m");
    assert(oscVocMDescriptor != nullptr && oscVocMDescriptor->sourceIndex == 21);
    assert(oscVocMDescriptor->inputAvailable && oscVocMDescriptor->trackAvailable);
    assert(findNativeEffectParameter("osc_voc_m", "waveform") != nullptr);
    assert(findNativeEffectParameter("osc_voc_m", "midi-channel") != nullptr);
    assert(findNativeEffectParameter("osc_voc_m", "octave") != nullptr);
    assert(findNativeEffectParameter("osc_voc_m", "mix") != nullptr);
    const auto* oscBotDescriptor = findNativeEffectDescriptor("osc_bot");
    assert(oscBotDescriptor != nullptr && oscBotDescriptor->sourceIndex == 22);
    assert(oscBotDescriptor->inputAvailable && oscBotDescriptor->trackAvailable);
    assert(oscBotDescriptor->name.find("clean-room") != std::string_view::npos);
    assert(findNativeEffectParameter("osc_bot", "bands") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "waveform") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "pattern") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "tone") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "tempo") != nullptr);
    assert(findNativeEffectParameter("osc_bot", "mix") != nullptr);
    const auto* synthDescriptor = findNativeEffectDescriptor("synth");
    assert(synthDescriptor != nullptr && synthDescriptor->sourceIndex == 6);
    assert(synthDescriptor->inputAvailable && synthDescriptor->trackAvailable);
    assert(synthDescriptor->parameterCount == 5U);
    assert(findNativeEffectParameter("synth", "sensitivity") != nullptr);
    assert(findNativeEffectParameter("synth", "waveform") != nullptr);
    assert(findNativeEffectParameter("synth", "octave") != nullptr);
    assert(findNativeEffectParameter("synth", "tone") != nullptr);
    assert(findNativeEffectParameter("synth", "mix") != nullptr);
    const auto* g2bDescriptor = findNativeEffectDescriptor("g2b");
    assert(g2bDescriptor != nullptr && g2bDescriptor->sourceIndex == 10);
    assert(g2bDescriptor->inputAvailable && g2bDescriptor->trackAvailable);
    assert(findNativeEffectParameter("g2b", "tracking_percent") != nullptr);
    assert(findNativeEffectParameter("g2b", "blend_percent") != nullptr);
    assert(findNativeEffectParameter("g2b", "body_hz") != nullptr);
    const auto* transposeDescriptor = findNativeEffectDescriptor("transpose");
    assert(transposeDescriptor != nullptr && transposeDescriptor->sourceIndex == 14);
    assert(transposeDescriptor->inputAvailable && transposeDescriptor->trackAvailable);
    const auto* transposeShift = findNativeEffectParameter("transpose", "shift_semitones");
    const auto* transposeMix = findNativeEffectParameter("transpose", "mix_percent");
    assert(transposeShift != nullptr && transposeShift->minimum == -24.0f &&
        transposeShift->maximum == 24.0f && transposeShift->defaultValue == 0.0f);
    assert(transposeMix != nullptr && transposeMix->minimum == 0.0f &&
        transposeMix->maximum == 100.0f && transposeMix->defaultValue == 100.0f);
    const auto* pitchBendDescriptor = findNativeEffectDescriptor("pitch_bend");
    assert(pitchBendDescriptor != nullptr && pitchBendDescriptor->sourceIndex == 15);
    assert(pitchBendDescriptor->inputAvailable && pitchBendDescriptor->trackAvailable);
    assert(pitchBendDescriptor->parameterCount == 4U);
    const auto* pitchBendRange = findNativeEffectParameter("pitch_bend", "range");
    const auto* pitchBendTime = findNativeEffectParameter("pitch_bend", "time_ms");
    const auto* pitchBendDirection = findNativeEffectParameter("pitch_bend", "direction");
    const auto* pitchBendMix = findNativeEffectParameter("pitch_bend", "mix_percent");
    assert(pitchBendRange != nullptr && pitchBendRange->minimum == 0.0f &&
        pitchBendRange->maximum == 24.0f && pitchBendRange->defaultValue == 12.0f);
    assert(pitchBendTime != nullptr && pitchBendTime->minimum == 20.0f &&
        pitchBendTime->maximum == 4000.0f && pitchBendTime->defaultValue == 500.0f);
    assert(pitchBendDirection != nullptr && pitchBendDirection->minimum == 0.0f &&
        pitchBendDirection->maximum == 1.0f && pitchBendDirection->defaultValue == 0.0f &&
        pitchBendDirection->discrete && pitchBendDirection->discreteValueCount == 2U);
    assert(pitchBendMix != nullptr && pitchBendMix->minimum == 0.0f &&
        pitchBendMix->maximum == 100.0f && pitchBendMix->defaultValue == 100.0f);
    auto pitchBend = createNativeEffectProcessor("pitch_bend");
    assert(pitchBend != nullptr && pitchBend->prepare(48000U));
    assert(pitchBend->reportedLatencySamples() == 1920U);
    assert(!pitchBend->setParameter("range", -0.01f, 1U));
    assert(!pitchBend->setParameter("range", 24.01f, 1U));
    assert(!pitchBend->setParameter("time_ms", 19.99f, 1U));
    assert(!pitchBend->setParameter("time_ms", 4000.1f, 1U));
    assert(!pitchBend->setParameter("direction", 0.5f, 1U));
    assert(!pitchBend->setParameter("direction", 2.0f, 1U));
    assert(!pitchBend->setParameter("mix_percent", 100.1f, 1U));
    assert(pitchBend->setParameter("range", 24.0f, 1U));
    assert(pitchBend->setParameter("time_ms", 20.0f, 1U));
    assert(pitchBend->setParameter("direction", 1.0f, 1U));
    assert(pitchBend->setParameter("mix_percent", 0.0f, 1U));
    const auto* manualHarmonistDescriptor = findNativeEffectDescriptor("hrm_manual");
    assert(manualHarmonistDescriptor != nullptr && manualHarmonistDescriptor->sourceIndex == 18);
    assert(manualHarmonistDescriptor->inputAvailable && manualHarmonistDescriptor->trackAvailable);
    assert(manualHarmonistDescriptor->parameterCount == 4U);
    const auto* voice1Interval = findNativeEffectParameter("hrm_manual", "voice_1_interval");
    const auto* voice2Interval = findNativeEffectParameter("hrm_manual", "voice_2_interval");
    const auto* harmonyPan = findNativeEffectParameter("hrm_manual", "pan_percent");
    const auto* harmonyMix = findNativeEffectParameter("hrm_manual", "mix_percent");
    assert(voice1Interval != nullptr && voice1Interval->minimum == -24.0f &&
        voice1Interval->maximum == 24.0f && voice1Interval->defaultValue == 7.0f);
    assert(voice2Interval != nullptr && voice2Interval->minimum == -24.0f &&
        voice2Interval->maximum == 24.0f && voice2Interval->defaultValue == 12.0f);
    assert(harmonyPan != nullptr && harmonyPan->minimum == -100.0f &&
        harmonyPan->maximum == 100.0f && harmonyPan->defaultValue == 0.0f);
    assert(harmonyMix != nullptr && harmonyMix->minimum == 0.0f &&
        harmonyMix->maximum == 100.0f && harmonyMix->defaultValue == 70.0f);
    auto manualHarmonist = createNativeEffectProcessor("hrm_manual");
    assert(manualHarmonist != nullptr && manualHarmonist->prepare(48000U));
    assert(manualHarmonist->reportedLatencySamples() == 1920U);
    assert(!manualHarmonist->setParameter("voice_1_interval", -24.01f, 1U));
    assert(!manualHarmonist->setParameter("voice_1_interval", 24.01f, 1U));
    assert(!manualHarmonist->setParameter("voice_2_interval", -24.01f, 1U));
    assert(!manualHarmonist->setParameter("voice_2_interval", 24.01f, 1U));
    assert(!manualHarmonist->setParameter("pan_percent", -100.01f, 1U));
    assert(!manualHarmonist->setParameter("pan_percent", 100.01f, 1U));
    assert(!manualHarmonist->setParameter("mix_percent", 100.01f, 1U));

    const auto* octaveDescriptor = findNativeEffectDescriptor("octave");
    assert(octaveDescriptor != nullptr && octaveDescriptor->sourceIndex == 28);
    assert(octaveDescriptor->inputAvailable && octaveDescriptor->trackAvailable);
    assert(octaveDescriptor->parameterCount == 4U);
    const auto* octaveMinus24 = findNativeEffectParameter("octave", "minus_24_level");
    const auto* octaveMinus12 = findNativeEffectParameter("octave", "minus_12_level");
    const auto* octavePlus12 = findNativeEffectParameter("octave", "plus_12_level");
    const auto* octaveMix = findNativeEffectParameter("octave", "mix_percent");
    assert(octaveMinus24 != nullptr && octaveMinus24->minimum == 0.0f &&
        octaveMinus24->maximum == 100.0f && octaveMinus24->defaultValue == 0.0f);
    assert(octaveMinus12 != nullptr && octaveMinus12->minimum == 0.0f &&
        octaveMinus12->maximum == 100.0f && octaveMinus12->defaultValue == 40.0f);
    assert(octavePlus12 != nullptr && octavePlus12->minimum == 0.0f &&
        octavePlus12->maximum == 100.0f && octavePlus12->defaultValue == 0.0f);
    assert(octaveMix != nullptr && octaveMix->minimum == 0.0f &&
        octaveMix->maximum == 100.0f && octaveMix->defaultValue == 70.0f);
    auto octave = createNativeEffectProcessor("octave");
    assert(octave != nullptr && octave->prepare(48000U));
    assert(octave->reportedLatencySamples() == 1920U);
    assert(!octave->setParameter("minus_24_level", -0.01f, 1U));
    assert(!octave->setParameter("minus_12_level", 100.01f, 1U));
    assert(!octave->setParameter("plus_12_level", 100.01f, 1U));
    assert(!octave->setParameter("mix_percent", 100.01f, 1U));
    assert(!octave->setParameter("tracking_percent", 60.0f, 1U));
    assert(!octave->setParameter("formant", 0.0f, 1U));
    assert(!octave->setParameter("formant_percent", 50.0f, 1U));
    assert(octave->setParameter("minus_24_level", 100.0f, 1U));
    assert(octave->setParameter("minus_12_level", 0.0f, 1U));
    assert(octave->setParameter("plus_12_level", 100.0f, 1U));
    assert(octave->setParameter("mix_percent", 0.0f, 1U));
    const auto* preampDescriptor = findNativeEffectDescriptor("preamp");
    assert(preampDescriptor != nullptr && preampDescriptor->sourceIndex == 23);
    assert(preampDescriptor->inputAvailable && preampDescriptor->trackAvailable);
    const auto* preampModel = findNativeEffectParameter("preamp", "model");
    const auto* preampGain = findNativeEffectParameter("preamp", "gain");
    const auto* preampBass = findNativeEffectParameter("preamp", "bass");
    const auto* preampMiddle = findNativeEffectParameter("preamp", "middle");
    const auto* preampTreble = findNativeEffectParameter("preamp", "treble");
    const auto* preampLevel = findNativeEffectParameter("preamp", "level");
    assert(preampModel != nullptr && preampModel->minimum == 0.0f && preampModel->maximum == 4.0f &&
        preampModel->defaultValue == 0.0f && preampModel->discrete && preampModel->discreteValueCount == 5U);
    assert(preampGain != nullptr && preampGain->minimum == 0.0f && preampGain->maximum == 100.0f &&
        preampGain->defaultValue == 35.0f);
    assert(preampBass != nullptr && preampBass->minimum == -12.0f && preampBass->maximum == 12.0f &&
        preampBass->defaultValue == 0.0f);
    assert(preampMiddle != nullptr && preampMiddle->minimum == -12.0f && preampMiddle->maximum == 12.0f &&
        preampMiddle->defaultValue == 0.0f);
    assert(preampTreble != nullptr && preampTreble->minimum == -12.0f && preampTreble->maximum == 12.0f &&
        preampTreble->defaultValue == 0.0f);
    assert(preampLevel != nullptr && preampLevel->minimum == -24.0f && preampLevel->maximum == 12.0f &&
        preampLevel->defaultValue == 0.0f);
    auto preamp = createNativeEffectProcessor("preamp");
    assert(preamp != nullptr && preamp->prepare(48000U));
    assert(!preamp->setParameter("model", 1.5f, 1U));
    assert(!preamp->setParameter("gain", 100.1f, 1U));
    assert(!preamp->setParameter("bass", -12.1f, 1U));
    assert(!preamp->setParameter("middle", 12.1f, 1U));
    assert(!preamp->setParameter("treble", std::numeric_limits<float>::infinity(), 1U));
    assert(!preamp->setParameter("level", -24.1f, 1U));
    assert(preamp->setParameter("model", 4.0f, 1U));
    assert(preamp->setParameter("gain", 100.0f, 1U));
    assert(preamp->setParameter("bass", -12.0f, 1U));
    assert(preamp->setParameter("middle", 12.0f, 1U));
    assert(preamp->setParameter("treble", -12.0f, 1U));
    assert(preamp->setParameter("level", 12.0f, 1U));
    std::array<float, 256U> preampCallbackBlock{};
    preampCallbackBlock.fill(0.25f);
    const auto allocationsBeforePreampCallback = test_alloc::count();
    test_alloc::beginTracking();
    const float preampCallbackPeak = preamp->processInPlace(preampCallbackBlock.data(), 128U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBeforePreampCallback);
    assert(std::isfinite(preampCallbackPeak) && preampCallbackPeak <= 4.0f);
    const auto* vinylFlickDescriptor = findNativeEffectDescriptor("vinyl_flick");
    assert(vinylFlickDescriptor != nullptr && vinylFlickDescriptor->sourceIndex == 53);
    assert(!vinylFlickDescriptor->inputAvailable && vinylFlickDescriptor->trackAvailable);
    const auto* vinylSpeed = findNativeEffectParameter("vinyl_flick", "speed_percent");
    const auto* vinylReturn = findNativeEffectParameter("vinyl_flick", "motor_return_seconds");
    const auto* vinylBrake = findNativeEffectParameter("vinyl_flick", "brake_percent");
    const auto* vinylMix = findNativeEffectParameter("vinyl_flick", "mix_percent");
    assert(vinylSpeed != nullptr && vinylSpeed->minimum == -100.0f && vinylSpeed->maximum == 100.0f &&
        vinylSpeed->defaultValue == -100.0f);
    assert(vinylReturn != nullptr && vinylReturn->minimum == 0.05f && vinylReturn->maximum == 10.0f &&
        vinylReturn->defaultValue == 1.5f);
    assert(vinylBrake != nullptr && vinylBrake->minimum == 0.0f && vinylBrake->maximum == 100.0f &&
        vinylBrake->defaultValue == 35.0f);
    assert(vinylMix != nullptr && vinylMix->minimum == 0.0f && vinylMix->maximum == 100.0f &&
        vinylMix->defaultValue == 100.0f);
    auto vinylFlick = createNativeEffectProcessor("vinyl_flick");
    assert(vinylFlick != nullptr && vinylFlick->prepare(48000U));
    assert(!vinylFlick->setParameter("speed_percent", -100.1f, 1U));
    assert(!vinylFlick->setParameter("motor_return_seconds", 0.049f, 1U));
    assert(!vinylFlick->setParameter("brake_percent", 100.1f, 1U));
    assert(!vinylFlick->setParameter("mix_percent", 100.1f, 1U));
    assert(vinylFlick->setParameter("speed_percent", 0.0f, 1U));
    assert(vinylFlick->setParameter("motor_return_seconds", 10.0f, 1U));
    assert(vinylFlick->setParameter("brake_percent", 100.0f, 1U));
    assert(vinylFlick->setParameter("mix_percent", 50.0f, 1U));
    const auto* manualPanDescriptor = findNativeEffectDescriptor("manual_pan");
    assert(manualPanDescriptor != nullptr && manualPanDescriptor->sourceIndex == 30);
    assert(!manualPanDescriptor->inputAvailable && manualPanDescriptor->trackAvailable);
    const auto* manualPanPosition = findNativeEffectParameter("manual_pan", "position");
    assert(manualPanPosition != nullptr && manualPanPosition->minimum == -100.0f &&
        manualPanPosition->maximum == 100.0f && manualPanPosition->defaultValue == 0.0f);
    auto manualPan = createNativeEffectProcessor("manual_pan");
    assert(manualPan != nullptr && manualPan->stableId() == "manual_pan");
    assert(manualPan->prepare(48000U));
    assert(!manualPan->setParameter("position", -100.1f, 1U));
    assert(!manualPan->setParameter("position", 100.1f, 1U));
    assert(manualPan->setParameter("position", 100.0f, 1U));
    const auto* beatScatterDescriptor = findNativeEffectDescriptor("beat_scatter");
    assert(beatScatterDescriptor != nullptr && beatScatterDescriptor->sourceIndex == 50);
    assert(!beatScatterDescriptor->inputAvailable && beatScatterDescriptor->trackAvailable);
    const auto* scatterSlice = findNativeEffectParameter("beat_scatter", "slice_beats");
    const auto* scatterAmount = findNativeEffectParameter("beat_scatter", "scatter_percent");
    const auto* scatterPitch = findNativeEffectParameter("beat_scatter", "pitch_semitones");
    const auto* scatterRepeats = findNativeEffectParameter("beat_scatter", "repeats");
    const auto* scatterMix = findNativeEffectParameter("beat_scatter", "mix_percent");
    assert(scatterSlice != nullptr && scatterSlice->minimum == 0.25f && scatterSlice->maximum == 4.0f &&
        scatterSlice->defaultValue == 0.25f && scatterSlice->discrete && scatterSlice->discreteValueCount == 5U);
    assert(scatterAmount != nullptr && scatterAmount->minimum == 0.0f && scatterAmount->maximum == 100.0f &&
        scatterAmount->defaultValue == 50.0f);
    assert(scatterPitch != nullptr && scatterPitch->minimum == -24.0f && scatterPitch->maximum == 24.0f &&
        scatterPitch->defaultValue == 0.0f);
    assert(scatterRepeats != nullptr && scatterRepeats->minimum == 1.0f && scatterRepeats->maximum == 16.0f &&
        scatterRepeats->defaultValue == 4.0f);
    assert(scatterMix != nullptr && scatterMix->minimum == 0.0f && scatterMix->maximum == 100.0f &&
        scatterMix->defaultValue == 50.0f);
    auto beatScatter = createNativeEffectProcessor("beat_scatter");
    assert(beatScatter != nullptr && beatScatter->prepare(48000U));
    assert(!beatScatter->setParameter("bpm", std::numeric_limits<float>::quiet_NaN(), 1U));
    assert(!beatScatter->setParameter("bpm", 39.0f, 1U));
    assert(!beatScatter->setParameter("slice_beats", 0.75f, 1U));
    assert(!beatScatter->setParameter("scatter_percent", 100.1f, 1U));
    assert(!beatScatter->setParameter("pitch_semitones", -24.1f, 1U));
    assert(!beatScatter->setParameter("repeats", 16.1f, 1U));
    assert(!beatScatter->setParameter("mix_percent", 100.1f, 1U));
    assert(beatScatter->setParameter("bpm", 300.0f, 1U));
    assert(beatScatter->setParameter("slice_beats", 4.0f, 1U));
    assert(beatScatter->setParameter("scatter_percent", 100.0f, 1U));
    assert(beatScatter->setParameter("pitch_semitones", 24.0f, 1U));
    assert(beatScatter->setParameter("repeats", 16.0f, 1U));
    assert(beatScatter->setParameter("mix_percent", 100.0f, 1U));

    const auto* rollDescriptor = findNativeEffectDescriptor("roll");
    assert(rollDescriptor != nullptr && rollDescriptor->sourceIndex == 44);
    assert(rollDescriptor->inputAvailable && rollDescriptor->trackAvailable);
    const auto* rollSlice = findNativeEffectParameter("roll", "slice_beats");
    const auto* rollDecay = findNativeEffectParameter("roll", "decay_percent");
    const auto* rollPitch = findNativeEffectParameter("roll", "pitch_semitones");
    const auto* rollDirection = findNativeEffectParameter("roll", "direction");
    const auto* rollMix = findNativeEffectParameter("roll", "mix_percent");
    assert(rollSlice != nullptr && rollSlice->minimum == 0.25f && rollSlice->maximum == 4.0f &&
        rollSlice->defaultValue == 0.5f && rollSlice->discrete && rollSlice->discreteValueCount == 5U);
    assert(rollDecay != nullptr && rollDecay->minimum == 0.0f && rollDecay->maximum == 100.0f &&
        rollDecay->defaultValue == 20.0f);
    assert(rollPitch != nullptr && rollPitch->minimum == -24.0f && rollPitch->maximum == 24.0f &&
        rollPitch->defaultValue == 0.0f);
    assert(rollDirection != nullptr && rollDirection->discrete && rollDirection->discreteValueCount == 3U);
    assert(rollMix != nullptr && rollMix->minimum == 0.0f && rollMix->maximum == 100.0f &&
        rollMix->defaultValue == 50.0f);
    auto roll = createNativeEffectProcessor("roll");
    assert(roll != nullptr && roll->stableId() == "roll" && roll->prepare(48000U));
    assert(!roll->setParameter("bpm", 39.0f, 1U));
    assert(!roll->setParameter("slice_beats", 0.75f, 1U));
    assert(!roll->setParameter("decay_percent", 100.1f, 1U));
    assert(!roll->setParameter("pitch_semitones", 24.1f, 1U));
    assert(!roll->setParameter("direction", 1.5f, 1U));
    assert(!roll->setParameter("mix_percent", 100.1f, 1U));
    assert(roll->setParameter("bpm", 120.0f, 1U));
    assert(roll->setParameter("slice_beats", 0.25f, 1U));
    assert(roll->setParameter("decay_percent", 20.0f, 1U));
    assert(roll->setParameter("pitch_semitones", -12.0f, 1U));
    assert(roll->setParameter("direction", 2.0f, 1U));
    assert(roll->setParameter("mix_percent", 100.0f, 1U));
    std::vector<float> rollInput(6000U * 2U);
    for (std::size_t frame = 0U; frame < 6000U; ++frame) {
        const float sample = static_cast<float>(frame) / 6000.0f;
        rollInput[frame * 2U] = sample;
        rollInput[(frame * 2U) + 1U] = -sample;
    }
    (void)roll->processInPlace(rollInput.data(), 6000U, 2U);
    assert(std::fabs(rollInput[100U] - (50.0f / 6000.0f)) < 1.0e-6f);
    assert(std::fabs(rollInput[101U] + (50.0f / 6000.0f)) < 1.0e-6f);
    std::array<float, 64U * 2U> rollPlayback{};
    for (std::size_t frame = 0U; frame < 64U; ++frame) {
        rollPlayback[frame * 2U] = -0.4f;
        rollPlayback[(frame * 2U) + 1U] = 0.4f;
    }
    (void)roll->processInPlace(rollPlayback.data(), 64U, 2U);
    assert(rollPlayback[40U] > 0.0f);
    assert(rollPlayback[41U] < 0.0f);

    const auto* freezeDescriptor = findNativeEffectDescriptor("freeze");
    assert(freezeDescriptor != nullptr && freezeDescriptor->sourceIndex == 45);
    assert(freezeDescriptor->inputAvailable && freezeDescriptor->trackAvailable);
    const auto* freezeCapture = findNativeEffectParameter("freeze", "capture_ms");
    const auto* freezeMode = findNativeEffectParameter("freeze", "mode");
    const auto* freezePitch = findNativeEffectParameter("freeze", "pitch_semitones");
    const auto* freezeState = findNativeEffectParameter("freeze", "freeze");
    const auto* freezeMix = findNativeEffectParameter("freeze", "mix_percent");
    assert(freezeCapture != nullptr && freezeCapture->minimum == 2.0f &&
        freezeCapture->maximum == 2000.0f && freezeCapture->defaultValue == 250.0f);
    assert(freezeMode != nullptr && freezeMode->discrete &&
        freezeMode->minimum == 0.0f && freezeMode->maximum == 1.0f &&
        freezeMode->discreteValueCount == 1U && freezeMode->discreteValues[0U] == 0.0f);
    assert(freezePitch != nullptr && freezePitch->minimum == -24.0f &&
        freezePitch->maximum == 24.0f && freezePitch->defaultValue == 0.0f);
    assert(freezeState != nullptr && freezeState->discrete && freezeState->discreteValueCount == 2U);
    assert(freezeMix != nullptr && freezeMix->minimum == 0.0f &&
        freezeMix->maximum == 100.0f && freezeMix->defaultValue == 50.0f);
    auto freeze = createNativeEffectProcessor("freeze");
    assert(freeze != nullptr && freeze->stableId() == "freeze" && freeze->prepare(8000U));
    assert(!freeze->setParameter("capture_ms", 1.99f, 0U));
    assert(!freeze->setParameter("capture_ms", 2000.1f, 0U));
    assert(!freeze->setParameter("mode", 1.0f, 0U));
    assert(!freeze->setParameter("pitch_semitones", 24.1f, 0U));
    assert(!freeze->setParameter("freeze", 0.5f, 0U));
    assert(!freeze->setParameter("mix_percent", 100.1f, 0U));
    assert(freeze->setParameter("capture_ms", 20.0f, 0U));
    assert(freeze->setParameter("mode", 0.0f, 0U));
    assert(freeze->setParameter("pitch_semitones", 12.0f, 0U));
    assert(freeze->setParameter("mix_percent", 100.0f, 0U));
    // An explicit trigger can arrive before pre-roll is ready. It is retained
    // while the host is bypassed, with dry-through and no callback allocation.
    assert(freeze->setParameter("freeze", 1.0f, 0U));
    freeze->setBypassed(true, 0U);
    std::vector<float> freezePreRoll(200U * 2U);
    for (std::size_t frame = 0U; frame < 200U; ++frame) {
        const float sample = static_cast<float>(std::sin(static_cast<double>(frame) * 0.11));
        freezePreRoll[frame * 2U] = sample;
        freezePreRoll[frame * 2U + 1U] = -sample * 0.5f;
    }
    const auto freezePreRollOriginal = freezePreRoll;
    const auto allocationsBeforeFreezeCallback = test_alloc::count();
    test_alloc::beginTracking();
    const auto freezePeak = freeze->processInPlace(freezePreRoll.data(), 200U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBeforeFreezeCallback);
    assert(std::isfinite(freezePeak));
    for (std::size_t index = 0U; index < freezePreRoll.size(); ++index) {
        assert(std::fabs(freezePreRoll[index] - freezePreRollOriginal[index]) < 1.0e-6f);
    }
    freeze->setBypassed(false, 0U);
    std::array<float, 64U * 2U> freezePlayback{};
    const auto freezePlaybackPeak = freeze->processInPlace(freezePlayback.data(), 64U, 2U);
    assert(std::isfinite(freezePlaybackPeak) && freezePlaybackPeak > 0.01f);
    assert(std::fabs(freezePlayback[0U] + freezePlayback[1U] * 2.0f) < 1.0e-4f);
    assert(freeze->setParameter("freeze", 0.0f, 0U));
    std::array<float, 8U> freezeRelease{{0.2f, -0.1f, 0.3f, -0.2f, 0.4f, -0.3f, 0.5f, -0.4f}};
    (void)freeze->processInPlace(freezeRelease.data(), 4U, 2U);
    assert(std::isfinite(freezeRelease[0U]) && std::isfinite(freezeRelease[1U]));
    const auto* isolatorDescriptor = findNativeEffectDescriptor("isolator");
    assert(isolatorDescriptor != nullptr && isolatorDescriptor->sourceIndex == 27);
    assert(isolatorDescriptor->inputAvailable && isolatorDescriptor->trackAvailable);
    assert(findNativeEffectParameter("isolator", "low_crossover_hz") != nullptr);
    assert(findNativeEffectParameter("isolator", "gate_bpm") != nullptr);
    const auto* granularDescriptor = findNativeEffectDescriptor("granular_delay");
    assert(granularDescriptor != nullptr && granularDescriptor->sourceIndex == 41);
    assert(granularDescriptor->inputAvailable && granularDescriptor->trackAvailable);
    assert(findNativeEffectParameter("granular_delay", "grain_size_ms") != nullptr);

    const auto* vibratoDescriptor = findNativeEffectDescriptor("vibrato");
    assert(vibratoDescriptor != nullptr && vibratoDescriptor->sourceIndex == 33);
    assert(vibratoDescriptor->inputAvailable && vibratoDescriptor->trackAvailable);
    assert(findNativeEffectParameter("vibrato", "rate_hz") != nullptr);
    assert(findNativeEffectParameter("vibrato", "depth") != nullptr);
    assert(findNativeEffectParameter("vibrato", "delay_ms") != nullptr);
    assert(findNativeEffectParameter("vibrato", "mix_percent") != nullptr);

    auto loFi = createNativeEffectProcessor("lo_fi");
    assert(loFi != nullptr && loFi->stableId() == "lo_fi");
    assert(loFi->prepare(48000U));
    const auto* bitDepth = findNativeEffectParameter("lo_fi", "bit_depth");
    const auto* reducedRate = findNativeEffectParameter("lo_fi", "sample_rate_hz");
    const auto* postFilter = findNativeEffectParameter("lo_fi", "filter_hz");
    const auto* loFiMix = findNativeEffectParameter("lo_fi", "mix_percent");
    assert(bitDepth != nullptr && bitDepth->minimum == 4.0f && bitDepth->maximum == 24.0f && bitDepth->defaultValue == 12.0f);
    assert(reducedRate != nullptr && reducedRate->minimum == 500.0f && reducedRate->maximum == 48000.0f);
    assert(postFilter != nullptr && postFilter->minimum == 20.0f && postFilter->maximum == 20000.0f);
    assert(loFiMix != nullptr && loFiMix->minimum == 0.0f && loFiMix->maximum == 100.0f && loFiMix->defaultValue == 70.0f);
    assert(!loFi->setParameter("bit_depth", 3.9f, 1U));
    assert(!loFi->setParameter("sample_rate_hz", 499.0f, 1U));
    assert(!loFi->setParameter("filter_hz", 20001.0f, 1U));
    assert(!loFi->setParameter("mix_percent", 100.1f, 1U));
    assert(loFi->setParameter("bit_depth", 4.0f, 1U));
    assert(loFi->setParameter("sample_rate_hz", 12000.0f, 1U));
    assert(loFi->setParameter("mix_percent", 100.0f, 1U));

    auto filter = createNativeEffectProcessor("filter.lpf");
    assert(filter != nullptr);
    assert(filter->prepare(48000U));
    assert(!filter->setParameter("cutoff_hz", 19.0f));
    assert(!filter->setParameter("cutoff_hz", 20001.0f));
    assert(!filter->setParameter("q", std::nanf("")));
    assert(!filter->setParameter("missing", 1.0f));
    assert(filter->setParameter("cutoff_hz", 20000.0f, 1U));

    auto phaser = createNativeEffectProcessor("phaser");
    assert(phaser != nullptr);
    assert(phaser->prepare(48000U));
    const auto* stages = findNativeEffectParameter("phaser", "stages");
    assert(stages != nullptr && stages->discrete && stages->discreteValueCount == 3U);
    assert(stages->discreteValues[0] == 4.0f && stages->discreteValues[1] == 8.0f && stages->discreteValues[2] == 12.0f);
    assert(!phaser->setParameter("stages", 6.0f, 1U));
    assert(!phaser->setParameter("feedback", 0.91f, 1U));
    assert(phaser->setParameter("stages", 12.0f, 1U));

    auto flanger = createNativeEffectProcessor("flanger");
    assert(flanger != nullptr && flanger->stableId() == "flanger");
    assert(flanger->prepare(48000U));
    const auto* flangerDelay = findNativeEffectParameter("flanger", "delay_ms");
    const auto* flangerRate = findNativeEffectParameter("flanger", "rate_hz");
    const auto* flangerDepth = findNativeEffectParameter("flanger", "depth");
    const auto* flangerFeedback = findNativeEffectParameter("flanger", "feedback");
    const auto* flangerWet = findNativeEffectParameter("flanger", "wet_mix");
    assert(flangerDelay != nullptr && flangerDelay->minimum == 0.2f && flangerDelay->maximum == 10.0f &&
           flangerDelay->defaultValue == 3.0f);
    assert(flangerRate != nullptr && flangerRate->minimum == 0.05f && flangerRate->maximum == 20.0f);
    assert(flangerDepth != nullptr && flangerDepth->minimum == 0.0f && flangerDepth->maximum == 1.0f);
    assert(flangerFeedback != nullptr && flangerFeedback->minimum == -0.95f && flangerFeedback->maximum == 0.95f);
    assert(flangerWet != nullptr && flangerWet->minimum == 0.0f && flangerWet->maximum == 1.0f);
    assert(!flanger->setParameter("delay_ms", 0.19f, 1U));
    assert(!flanger->setParameter("rate_hz", 20.01f, 1U));
    assert(!flanger->setParameter("depth", 1.01f, 1U));
    assert(!flanger->setParameter("feedback", -0.951f, 1U));
    assert(!flanger->setParameter("wet_mix", 1.01f, 1U));
    assert(flanger->setParameter("delay_ms", 10.0f, 1U));
    assert(flanger->setParameter("feedback", -0.95f, 1U));
    assert(flanger->setParameter("wet_mix", 1.0f, 1U));

    auto dynamics = createNativeEffectProcessor("dynamics");
    assert(dynamics != nullptr && dynamics->stableId() == "dynamics");
    assert(dynamics->prepare(48000U));
    const auto* threshold = findNativeEffectParameter("dynamics", "threshold_db");
    const auto* ratio = findNativeEffectParameter("dynamics", "ratio");
    const auto* knee = findNativeEffectParameter("dynamics", "knee_db");
    const auto* attack = findNativeEffectParameter("dynamics", "attack_ms");
    const auto* release = findNativeEffectParameter("dynamics", "release_ms");
    const auto* detector = findNativeEffectParameter("dynamics", "detector");
    assert(threshold != nullptr && threshold->minimum == -60.0f && threshold->maximum == 0.0f);
    assert(ratio != nullptr && ratio->minimum == 1.0f && ratio->maximum == 20.0f);
    assert(knee != nullptr && knee->minimum == 0.0f && knee->maximum == 24.0f);
    assert(attack != nullptr && attack->minimum == 0.1f && attack->maximum == 100.0f);
    assert(release != nullptr && release->minimum == 5.0f && release->maximum == 1000.0f);
    assert(detector != nullptr && detector->discrete && detector->discreteValueCount == 2U);
    assert(!dynamics->setParameter("threshold_db", -60.1f, 1U));
    assert(!dynamics->setParameter("ratio", 20.1f, 1U));
    assert(!dynamics->setParameter("detector", 0.5f, 1U));
    assert(dynamics->setParameter("threshold_db", -24.0f, 128U));
    assert(dynamics->setParameter("ratio", 8.0f, 128U));
    assert(dynamics->setParameter("detector", 1.0f, 128U));

    auto distortion = createNativeEffectProcessor("dist");
    assert(distortion != nullptr && distortion->stableId() == "dist");
    assert(distortion->prepare(48000U));
    assert(findNativeEffectParameter("dist", "drive_db") != nullptr);
    assert(findNativeEffectParameter("dist", "mix_percent") != nullptr);
    assert(!distortion->setParameter("drive_db", -0.1f, 1U));
    assert(!distortion->setParameter("drive_db", 36.1f, 1U));
    assert(!distortion->setParameter("mix_percent", 100.1f, 1U));
    assert(!distortion->setParameter("type", 1.0f, 1U));
    assert(distortion->setParameter("drive_db", 24.0f, 128U));
    assert(distortion->setParameter("mix_percent", 70.0f, 128U));

    auto reverb = createNativeEffectProcessor("reverb");
    assert(reverb != nullptr && reverb->stableId() == "reverb");
    assert(reverb->prepare(48000U));
    assert(findNativeEffectParameter("reverb", "decay_seconds") != nullptr);
    assert(findNativeEffectParameter("reverb", "damping_cutoff_hz") != nullptr);
    assert(findNativeEffectParameter("reverb", "wet_mix") != nullptr);
    assert(!reverb->setParameter("decay_seconds", 20.1f, 1U));
    assert(!reverb->setParameter("damping_cutoff_hz", 16000.1f, 1U));
    assert(!reverb->setParameter("wet_mix", 1.01f, 1U));
    assert(!reverb->setParameter("pre_delay_ms", 20.0f, 1U));
    assert(reverb->setParameter("decay_seconds", 4.0f, 128U));
    assert(reverb->setParameter("damping_cutoff_hz", 10000.0f, 128U));
    assert(reverb->setParameter("wet_mix", 0.6f, 128U));

    const auto* gateReverbDescriptor = findNativeEffectDescriptor("gate_reverb");
    assert(gateReverbDescriptor != nullptr && gateReverbDescriptor->sourceIndex == 48);
    assert(gateReverbDescriptor->inputAvailable && gateReverbDescriptor->trackAvailable);
    auto gateReverb = createNativeEffectProcessor("gate_reverb");
    assert(gateReverb != nullptr && gateReverb->stableId() == "gate_reverb");
    assert(gateReverb->prepare(48000U));
    const auto* gateThreshold = findNativeEffectParameter("gate_reverb", "threshold_db");
    const auto* gateHysteresis = findNativeEffectParameter("gate_reverb", "hysteresis_db");
    const auto* gateHold = findNativeEffectParameter("gate_reverb", "hold_ms");
    const auto* gateRelease = findNativeEffectParameter("gate_reverb", "release_ms");
    assert(gateThreshold != nullptr && gateThreshold->minimum == -60.0f && gateThreshold->maximum == 0.0f);
    assert(gateHysteresis != nullptr && gateHysteresis->minimum == 0.0f && gateHysteresis->maximum == 24.0f);
    assert(gateHold != nullptr && gateHold->minimum == 0.0f && gateHold->maximum == 2000.0f);
    assert(gateRelease != nullptr && gateRelease->minimum == 10.0f && gateRelease->maximum == 2000.0f);
    assert(!gateReverb->setParameter("threshold_db", -60.1f, 1U));
    assert(!gateReverb->setParameter("hysteresis_db", 24.1f, 1U));
    assert(!gateReverb->setParameter("hold_ms", 2000.1f, 1U));
    assert(!gateReverb->setParameter("release_ms", 9.9f, 1U));
    assert(!gateReverb->setParameter("decay_seconds", 0.09f, 1U));
    assert(!gateReverb->setParameter("damping_cutoff_hz", 20000.1f, 1U));
    assert(!gateReverb->setParameter("wet_mix", 1.01f, 1U));
    assert(gateReverb->setParameter("decay_seconds", 8.0f, 128U));
    assert(gateReverb->setParameter("damping_cutoff_hz", 20000.0f, 128U));
    assert(gateReverb->setParameter("wet_mix", 1.0f, 128U));
    assert(gateReverb->setParameter("threshold_db", -6.0f, 128U));
    assert(gateReverb->setParameter("hysteresis_db", 3.0f, 128U));
    assert(gateReverb->setParameter("hold_ms", 100.0f, 128U));
    assert(gateReverb->setParameter("release_ms", 30.0f, 128U));

    auto beatRepeat = createNativeEffectProcessor("beat_repeat");
    assert(beatRepeat != nullptr && beatRepeat->stableId() == "beat_repeat");
    assert(beatRepeat->prepare(48000U));
    const auto* division = findNativeEffectParameter("beat_repeat", "division");
    const auto* direction = findNativeEffectParameter("beat_repeat", "direction");
    assert(division != nullptr && division->discrete && division->discreteValueCount == 5U);
    assert(direction != nullptr && direction->discrete && direction->discreteValueCount == 3U);
    assert(findNativeEffectParameter("beat_repeat", "bpm") != nullptr);
    assert(!beatRepeat->setParameter("division", 0.75f, 1U));
    assert(!beatRepeat->setParameter("direction", 1.5f, 1U));
    assert(!beatRepeat->setParameter("bpm", 29.9f, 1U));
    assert(beatRepeat->setParameter("bpm", 90.0f, 1U));
    assert(beatRepeat->setParameter("division", 0.25f, 1U));
    assert(beatRepeat->setParameter("direction", 2.0f, 1U));
    assert(beatRepeat->setParameter("mix_percent", 75.0f, 128U));

    auto tapeEcho = createNativeEffectProcessor("tape_echo");
    assert(tapeEcho != nullptr && tapeEcho->stableId() == "tape_echo");
    assert(tapeEcho->prepare(48000U));
    const auto* tapeTime = findNativeEffectParameter("tape_echo", "time_ms");
    const auto* tapeFeedback = findNativeEffectParameter("tape_echo", "feedback_percent");
    const auto* tapeWow = findNativeEffectParameter("tape_echo", "wow_flutter_percent");
    const auto* tapeSaturation = findNativeEffectParameter("tape_echo", "saturation_percent");
    const auto* tapeTone = findNativeEffectParameter("tape_echo", "tone_hz");
    const auto* tapeMix = findNativeEffectParameter("tape_echo", "mix_percent");
    assert(tapeTime != nullptr && tapeTime->minimum == 20.0f && tapeTime->maximum == 2000.0f);
    assert(tapeFeedback != nullptr && tapeFeedback->maximum == 95.0f);
    assert(tapeWow != nullptr && tapeWow->maximum == 100.0f);
    assert(tapeSaturation != nullptr && tapeSaturation->maximum == 100.0f);
    assert(tapeTone != nullptr && tapeTone->minimum == 500.0f && tapeTone->maximum == 16000.0f);
    assert(tapeMix != nullptr && tapeMix->maximum == 100.0f);
    assert(!tapeEcho->setParameter("time_ms", 19.9f, 1U));
    assert(!tapeEcho->setParameter("feedback_percent", 95.1f, 1U));
    assert(!tapeEcho->setParameter("wow_flutter_percent", 100.1f, 1U));
    assert(!tapeEcho->setParameter("saturation_percent", -0.1f, 1U));
    assert(!tapeEcho->setParameter("tone_hz", 499.0f, 1U));
    assert(!tapeEcho->setParameter("mix_percent", 100.1f, 1U));
    assert(tapeEcho->setParameter("time_ms", 20.0f, 1U));
    assert(tapeEcho->setParameter("feedback_percent", 0.0f, 1U));
    assert(tapeEcho->setParameter("wow_flutter_percent", 0.0f, 1U));
    assert(tapeEcho->setParameter("saturation_percent", 0.0f, 1U));
    assert(tapeEcho->setParameter("tone_hz", 16000.0f, 1U));
    assert(tapeEcho->setParameter("mix_percent", 100.0f, 1U));

    const auto* reverseDescriptor = findNativeEffectDescriptor("reverse_delay");
    assert(reverseDescriptor != nullptr && reverseDescriptor->sourceIndex == 38);
    assert(reverseDescriptor->inputAvailable && reverseDescriptor->trackAvailable);
    auto reverseDelay = createNativeEffectProcessor("reverse_delay");
    assert(reverseDelay != nullptr && reverseDelay->stableId() == "reverse_delay");
    assert(reverseDelay->prepare(8000U));
    const auto* reverseBpm = findNativeEffectParameter("reverse_delay", "bpm");
    const auto* reverseBeats = findNativeEffectParameter("reverse_delay", "segment_beats");
    const auto* reverseFeedback = findNativeEffectParameter("reverse_delay", "feedback_percent");
    const auto* reverseCrossfade = findNativeEffectParameter("reverse_delay", "crossfade_ms");
    const auto* reverseMix = findNativeEffectParameter("reverse_delay", "mix_percent");
    assert(reverseBpm != nullptr && reverseBpm->minimum == 30.0f && reverseBpm->maximum == 300.0f);
    assert(reverseBeats != nullptr && reverseBeats->minimum == 0.25f && reverseBeats->maximum == 4.0f &&
        reverseBeats->defaultValue == 1.0f && reverseBeats->discrete && reverseBeats->discreteValueCount == 5U);
    assert(reverseFeedback != nullptr && reverseFeedback->minimum == 0.0f &&
        reverseFeedback->maximum == 95.0f && reverseFeedback->defaultValue == 20.0f);
    assert(reverseCrossfade != nullptr && reverseCrossfade->minimum == 1.0f &&
        reverseCrossfade->maximum == 100.0f && reverseCrossfade->defaultValue == 20.0f);
    assert(reverseMix != nullptr && reverseMix->minimum == 0.0f &&
        reverseMix->maximum == 100.0f && reverseMix->defaultValue == 30.0f);
    assert(!reverseDelay->setParameter("bpm", 300.1f, 1U));
    assert(!reverseDelay->setParameter("segment_beats", 0.75f, 1U));
    assert(!reverseDelay->setParameter("feedback_percent", 95.1f, 1U));
    assert(!reverseDelay->setParameter("crossfade_ms", 0.9f, 1U));
    assert(!reverseDelay->setParameter("mix_percent", 100.1f, 1U));
    assert(reverseDelay->setParameter("bpm", 300.0f, 1U));
    assert(reverseDelay->setParameter("segment_beats", 0.25f, 1U));
    assert(reverseDelay->setParameter("feedback_percent", 95.0f, 1U));
    assert(reverseDelay->setParameter("crossfade_ms", 100.0f, 1U));
    assert(reverseDelay->setParameter("mix_percent", 100.0f, 1U));

    auto delay = createNativeEffectProcessor("fractional_delay");
    assert(delay != nullptr);
    assert(delay->prepare(48000U));
    assert(!delay->setParameter("delay_ms", 2000.1f, 1U));
    assert(!delay->setParameter("feedback", 0.96f, 1U));
    assert(delay->setParameter("delay_ms", 10.0f, 1U));

    const auto* modDelayDescriptor = findNativeEffectDescriptor("mod_delay");
    assert(modDelayDescriptor != nullptr && modDelayDescriptor->name == "MOD DELAY");
    assert(modDelayDescriptor->sourceIndex == 39);
    assert(modDelayDescriptor->inputAvailable && modDelayDescriptor->trackAvailable);
    const std::array<std::string_view, 5U> modDelayParameterIds{{
        "rate_hz", "depth_ms", "delay_ms", "feedback", "wet_mix"
    }};
    for (const auto parameterId : modDelayParameterIds) {
        assert(findNativeEffectParameter("mod_delay", parameterId) != nullptr);
    }
    auto modDelay = createNativeEffectProcessor("mod_delay");
    assert(modDelay != nullptr && modDelay->stableId() == "mod_delay");
    assert(modDelay->prepare(48000U));
    assert(!modDelay->setParameter("rate_hz", 10.1f, 1U));
    assert(!modDelay->setParameter("depth_ms", 50.1f, 1U));
    assert(!modDelay->setParameter("delay_ms", 9.9f, 1U));
    assert(!modDelay->setParameter("delay_ms", 2000.1f, 1U));
    assert(!modDelay->setParameter("feedback", 0.96f, 1U));
    assert(!modDelay->setParameter("wet_mix", 1.01f, 1U));
    assert(modDelay->setParameter("rate_hz", 0.8f, 64U));
    assert(modDelay->setParameter("depth_ms", 6.0f, 64U));
    assert(modDelay->setParameter("delay_ms", 20.0f, 64U));
    assert(modDelay->setParameter("feedback", 0.6f, 64U));
    assert(modDelay->setParameter("wet_mix", 0.8f, 64U));
    std::array<float, 512U> modDelayProbe{};
    modDelayProbe[0U] = 0.7f;
    modDelayProbe[1U] = -0.4f;
    const std::size_t modDelayAllocationsBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    const float modDelayPeak = modDelay->processInPlace(modDelayProbe.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == modDelayAllocationsBefore);
    assert(std::isfinite(modDelayPeak) && modDelayPeak <= 8.0f);
    for (const float sample : modDelayProbe) {
        assert(std::isfinite(sample));
        assert(std::fabs(sample) <= 8.0f);
    }

    const auto* panningDelayDescriptor = findNativeEffectDescriptor("panning_delay");
    assert(panningDelayDescriptor != nullptr);
    assert(panningDelayDescriptor->sourceIndex == 37);
    assert(panningDelayDescriptor->inputAvailable && panningDelayDescriptor->trackAvailable);
    assert(findNativeEffectParameter("panning_delay", "time_ms") != nullptr);
    const auto* panningFeedback = findNativeEffectParameter("panning_delay", "feedback_percent");
    const auto* panningPan = findNativeEffectParameter("panning_delay", "pan_percent");
    const auto* panningMix = findNativeEffectParameter("panning_delay", "mix_percent");
    assert(panningFeedback != nullptr && panningFeedback->minimum == 0.0f &&
           panningFeedback->maximum == 95.0f && panningFeedback->defaultValue == 30.0f);
    assert(panningPan != nullptr && panningPan->minimum == -100.0f &&
           panningPan->maximum == 100.0f && panningPan->defaultValue == 70.0f);
    assert(panningMix != nullptr && panningMix->maximum == 100.0f && panningMix->defaultValue == 25.0f);
    auto panningDelay = createNativeEffectProcessor("panning_delay");
    assert(panningDelay != nullptr && panningDelay->stableId() == "panning_delay");
    assert(panningDelay->prepare(48000U));
    assert(!panningDelay->setParameter("time_ms", 0.9f, 1U));
    assert(!panningDelay->setParameter("feedback_percent", 95.1f, 1U));
    assert(!panningDelay->setParameter("pan_percent", 100.1f, 1U));
    assert(!panningDelay->setParameter("mix_percent", -0.1f, 1U));
    assert(panningDelay->setParameter("time_ms", 1.0f, 1U));
    assert(panningDelay->setParameter("feedback_percent", 95.0f, 1U));
    assert(panningDelay->setParameter("pan_percent", -100.0f, 1U));
    assert(panningDelay->setParameter("mix_percent", 100.0f, 1U));

    const auto* twistDescriptor = findNativeEffectDescriptor("twist");
    assert(twistDescriptor != nullptr && twistDescriptor->sourceIndex == 43);
    assert(twistDescriptor->inputAvailable && twistDescriptor->trackAvailable);
    assert(twistDescriptor->parameterCount == 3U);
    const auto* twistAmount = findNativeEffectParameter("twist", "amount_percent");
    const auto* twistTrajectory = findNativeEffectParameter("twist", "trajectory");
    const auto* twistMix = findNativeEffectParameter("twist", "mix_percent");
    assert(twistAmount != nullptr && twistAmount->minimum == -100.0f &&
        twistAmount->maximum == 100.0f && twistAmount->defaultValue == 0.0f);
    assert(twistTrajectory != nullptr && twistTrajectory->discrete &&
        twistTrajectory->discreteValueCount == 4U && twistTrajectory->defaultValue == 0.0f);
    assert(twistTrajectory->discreteValues[0] == 0.0f && twistTrajectory->discreteValues[1] == 1.0f &&
        twistTrajectory->discreteValues[2] == 2.0f && twistTrajectory->discreteValues[3] == 3.0f);
    assert(twistMix != nullptr && twistMix->minimum == 0.0f &&
        twistMix->maximum == 100.0f && twistMix->defaultValue == 50.0f);
    auto twist = createNativeEffectProcessor("twist");
    assert(twist != nullptr && twist->stableId() == "twist" && twist->prepare(48000U));
    assert(!twist->setParameter("amount_percent", -100.01f, 1U));
    assert(!twist->setParameter("amount_percent", 100.01f, 1U));
    assert(!twist->setParameter("trajectory", 0.5f, 1U));
    assert(!twist->setParameter("trajectory", 4.0f, 1U));
    assert(!twist->setParameter("mix_percent", 100.01f, 1U));
    assert(twist->setParameter("amount_percent", -100.0f, 1U));
    assert(twist->setParameter("trajectory", 3.0f, 1U));
    assert(twist->setParameter("mix_percent", 100.0f, 1U));

    auto autoPan = createNativeEffectProcessor("auto_pan");
    assert(autoPan != nullptr);
    assert(autoPan->stableId() == "auto_pan");
    assert(autoPan->prepare(48000U));
    const auto* waveform = findNativeEffectParameter("auto_pan", "waveform");
    assert(waveform != nullptr && waveform->discrete && waveform->discreteValueCount == 3U);
    assert(waveform->discreteValues[0] == 0.0f && waveform->discreteValues[1] == 1.0f &&
           waveform->discreteValues[2] == 2.0f);
    assert(!autoPan->setParameter("rate_hz", 0.049f, 1U));
    assert(!autoPan->setParameter("rate_hz", 20.01f, 1U));
    assert(!autoPan->setParameter("depth", -0.01f, 1U));
    assert(!autoPan->setParameter("depth", 1.01f, 1U));
    assert(!autoPan->setParameter("waveform", 0.5f, 1U));
    assert(!autoPan->setParameter("waveform", 3.0f, 1U));
    assert(!autoPan->setParameter("wet_mix", -0.01f, 1U));
    assert(!autoPan->setParameter("wet_mix", 1.01f, 1U));
    assert(autoPan->setParameter("rate_hz", 20.0f, 1U));
    assert(autoPan->setParameter("depth", 1.0f, 1U));
    assert(autoPan->setParameter("waveform", 2.0f, 1U));
    assert(autoPan->setParameter("wet_mix", 1.0f, 1U));

    auto chorus = createNativeEffectProcessor("chorus");
    assert(chorus != nullptr && chorus->stableId() == "chorus");
    assert(chorus->prepare(48000U));
    const auto* chorusRate = findNativeEffectParameter("chorus", "rate_hz");
    assert(chorusRate != nullptr && chorusRate->minimum == 0.1f && chorusRate->maximum == 8.0f &&
           chorusRate->defaultValue == 0.8f && chorusRate->smoothingMs == 20U);
    assert(!chorus->setParameter("rate_hz", 0.09f, 1U));
    assert(!chorus->setParameter("rate_hz", 8.01f, 1U));
    assert(!chorus->setParameter("depth_ms", -0.01f, 1U));
    assert(!chorus->setParameter("depth_ms", 25.01f, 1U));
    assert(!chorus->setParameter("feedback", 0.96f, 1U));
    assert(!chorus->setParameter("wet_mix", 1.01f, 1U));
    assert(chorus->setParameter("rate_hz", 8.0f, 1U));
    assert(chorus->setParameter("depth_ms", 0.0f, 1U));
    assert(chorus->setParameter("feedback", 0.95f, 1U));
    assert(chorus->setParameter("wet_mix", 1.0f, 1U));

    auto tremolo = createNativeEffectProcessor("tremolo");
    assert(tremolo != nullptr && tremolo->stableId() == "tremolo");
    assert(tremolo->prepare(48000U));
    const auto* tremoloWave = findNativeEffectParameter("tremolo", "waveform");
    assert(tremoloWave != nullptr && tremoloWave->discrete && tremoloWave->discreteValueCount == 3U);
    assert(tremoloWave->smoothingMs == 20U);
    assert(!tremolo->setParameter("rate_hz", 0.049f, 1U));
    assert(!tremolo->setParameter("rate_hz", 20.01f, 1U));
    assert(!tremolo->setParameter("depth", -0.01f, 1U));
    assert(!tremolo->setParameter("depth", 1.01f, 1U));
    assert(!tremolo->setParameter("waveform", 0.5f, 1U));
    assert(!tremolo->setParameter("waveform", 3.0f, 1U));
    assert(!tremolo->setParameter("wet_mix", -0.01f, 1U));
    assert(!tremolo->setParameter("wet_mix", 1.01f, 1U));
    assert(tremolo->setParameter("rate_hz", 20.0f, 1U));
    assert(tremolo->setParameter("depth", 1.0f, 1U));
    assert(tremolo->setParameter("waveform", 2.0f, 1U));
    assert(tremolo->setParameter("wet_mix", 1.0f, 1U));

    auto ringMod = createNativeEffectProcessor("ring_mod");
    assert(ringMod != nullptr && ringMod->stableId() == "ring_mod");
    const auto* carrier = findNativeEffectParameter("ring_mod", "carrier_hz");
    assert(carrier != nullptr && carrier->minimum == 20.0f && carrier->maximum == 20000.0f &&
           carrier->defaultValue == 440.0f && carrier->smoothingMs == 20U);
    const auto* ringDepth = findNativeEffectParameter("ring_mod", "depth");
    const auto* ringWet = findNativeEffectParameter("ring_mod", "wet_mix");
    assert(ringDepth != nullptr && ringDepth->smoothingMs == 20U);
    assert(ringWet != nullptr && ringWet->smoothingMs == 10U);
    assert(ringMod->prepare(48000U));
    assert(!ringMod->setParameter("carrier_hz", 19.99f, 1U));
    assert(!ringMod->setParameter("carrier_hz", 20000.1f, 1U));
    assert(!ringMod->setParameter("depth", -0.01f, 1U));
    assert(!ringMod->setParameter("depth", 1.01f, 1U));
    assert(!ringMod->setParameter("wet_mix", -0.01f, 1U));
    assert(!ringMod->setParameter("wet_mix", 1.01f, 1U));
    assert(ringMod->setParameter("carrier_hz", 20000.0f, 1U));
    assert(ringMod->setParameter("depth", 0.0f, 1U));
    assert(ringMod->setParameter("wet_mix", 0.0f, 1U));

    auto lateBoundRing = createNativeEffectProcessor("ring_mod");
    assert(lateBoundRing && lateBoundRing->prepare(24000U));
    assert(!lateBoundRing->setParameter("carrier_hz", 10800.0f, 1U));
    assert(!lateBoundRing->setParameter("carrier_hz", 11000.0f, 1U));
    assert(lateBoundRing->setParameter("carrier_hz", 10799.0f, 1U));

    auto earlyBoundRing = createNativeEffectProcessor("ring_mod");
    assert(earlyBoundRing && earlyBoundRing->setParameter("carrier_hz", 4000.0f, 1U));
    assert(!earlyBoundRing->prepare(8000U));

    auto equalizer = createNativeEffectProcessor("eq");
    assert(equalizer != nullptr && equalizer->stableId() == "eq");
    const auto* eqDescriptor = findNativeEffectDescriptor("eq");
    assert(eqDescriptor != nullptr && eqDescriptor->name == "EQ" && eqDescriptor->parameterCount == 10U);
    const std::array<std::string_view, 10U> eqParameterIds{{
        "low_frequency_hz", "low_gain_db", "mid1_frequency_hz", "mid1_q", "mid1_gain_db",
        "mid2_frequency_hz", "mid2_q", "mid2_gain_db", "high_frequency_hz", "high_gain_db"
    }};
    for (const auto parameterId : eqParameterIds) {
        assert(findNativeEffectParameter("eq", parameterId) != nullptr);
    }
    assert(findNativeEffectParameter("eq", "missing") == nullptr);
    assert(!equalizer->prepare(7999U));
    assert(equalizer->prepare(8000U));
    assert(!equalizer->setParameter("low_frequency_hz", 19.99f, 1U));
    assert(!equalizer->setParameter("low_frequency_hz", 500.01f, 1U));
    assert(!equalizer->setParameter("low_gain_db", -15.01f, 1U));
    assert(!equalizer->setParameter("high_gain_db", 15.01f, 1U));
    assert(!equalizer->setParameter("mid1_frequency_hz", std::nanf(""), 1U));
    assert(!equalizer->setParameter("mid1_q", 0.099f, 1U));
    assert(!equalizer->setParameter("mid2_q", 12.01f, 1U));
    // Descriptor values stay stable across sample rates; out-of-Nyquist
    // corners are safely clamped by the processor at design time.
    assert(equalizer->setParameter("low_frequency_hz", 500.0f, 1U));
    assert(equalizer->setParameter("low_gain_db", 15.0f, 1U));
    assert(equalizer->setParameter("mid1_frequency_hz", 8000.0f, 1U));
    assert(equalizer->setParameter("mid1_q", 12.0f, 1U));
    assert(equalizer->setParameter("mid1_gain_db", -15.0f, 1U));
    assert(equalizer->setParameter("mid2_frequency_hz", 12000.0f, 1U));
    assert(equalizer->setParameter("mid2_q", 0.1f, 1U));
    assert(equalizer->setParameter("mid2_gain_db", 15.0f, 1U));
    assert(equalizer->setParameter("high_frequency_hz", 20000.0f, 1U));
    assert(equalizer->setParameter("high_gain_db", -15.0f, 1U));
    std::array<float, 64U> lowRateStress{};
    lowRateStress.fill(0.25f);
    (void)equalizer->processInPlace(lowRateStress.data(), 32U, 2U);
    for (const float sample : lowRateStress) assert(std::isfinite(sample));

    auto stereoEnhance = createNativeEffectProcessor("stereo_enhance");
    assert(stereoEnhance != nullptr && stereoEnhance->stableId() == "stereo_enhance");
    const auto* stereoDescriptor = findNativeEffectDescriptor("stereo_enhance");
    assert(stereoDescriptor != nullptr && stereoDescriptor->parameterCount == 4U);
    assert(stereoEnhance->prepare(48000U));
    assert(!stereoEnhance->setParameter("width", -0.01f, 1U));
    assert(!stereoEnhance->setParameter("width", 200.01f, 1U));
    assert(!stereoEnhance->setParameter("low_mono_cutoff_hz", 19.99f, 1U));
    assert(!stereoEnhance->setParameter("low_mono_cutoff_hz", 1000.01f, 1U));
    assert(!stereoEnhance->setParameter("decorrelation", 100.01f, 1U));
    assert(!stereoEnhance->setParameter("wet_mix", std::nanf(""), 1U));
    assert(stereoEnhance->setParameter("width", 180.0f, 64U));
    assert(stereoEnhance->setParameter("low_mono_cutoff_hz", 300.0f, 64U));
    assert(stereoEnhance->setParameter("decorrelation", 80.0f, 64U));
    assert(stereoEnhance->setParameter("wet_mix", 75.0f, 64U));
    std::array<float, 128U> stereoProbe{};
    for (std::size_t frame = 0U; frame < stereoProbe.size() / 2U; ++frame) {
        stereoProbe[frame * 2U] = 0.3f * std::sin(static_cast<float>(frame) * 0.12f);
        stereoProbe[frame * 2U + 1U] = 0.2f * std::cos(static_cast<float>(frame) * 0.08f);
    }
    const float stereoPeak = stereoEnhance->processInPlace(stereoProbe.data(), 64U, 2U);
    assert(std::isfinite(stereoPeak) && stereoPeak > 0.0f);
    for (const float sample : stereoProbe) assert(std::isfinite(sample));
}

void testEveryAdvertisedPerTrackInsertFactoryRuns64FrameBlockInAThroughD() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 64U;
    constexpr unsigned int channels = 2U;
    const std::array<NativeEffectSlot, NativeEffectBank::kSlotCount> slots{{
        NativeEffectSlot::A, NativeEffectSlot::B, NativeEffectSlot::C, NativeEffectSlot::D,
    }};
    std::size_t catalogCount = 0U;
    const auto* catalog = nativeEffectCatalog(catalogCount);
    assert(catalog != nullptr);

    std::size_t advertisedCount = 0U;
    for (std::size_t effectIndex = 0U; effectIndex < catalogCount; ++effectIndex) {
        const auto& descriptor = catalog[effectIndex];
        const bool advertised = nativeEffectSupportsPerTrackInsert(descriptor.id);
        assert(advertised == (descriptor.trackAvailable && descriptor.id != "vinyl_flick" &&
            descriptor.id != "beat_shift"));
        if (!advertised) continue;
        ++advertisedCount;

        for (const auto slot : slots) {
            NativeEffectBank bank;
            assert(bank.prepare(sampleRate));
            assert(bank.setEffect(slot, descriptor.id));
            const auto* processor = bank.processor(slot);
            assert(processor != nullptr);
            assert(processor->stableId() == descriptor.id);
            assert(processor->sampleRate() == sampleRate);

            std::array<float, frames * channels> signal{};
            for (unsigned int frame = 0U; frame < frames; ++frame) {
                const float sample = 0.1f * std::sin(static_cast<float>(frame) * 0.19f);
                signal[static_cast<std::size_t>(frame) * channels] = sample;
                signal[(static_cast<std::size_t>(frame) * channels) + 1U] = -sample;
            }
            const float peak = bank.processInPlace(signal.data(), frames, channels);
            assert(std::isfinite(peak));
            for (const float sample : signal) assert(std::isfinite(sample));
            // processingFaulted is the same per-processor health state exposed
            // in Native's catalog-slot status payload.
            assert(!processor->processingFaulted());
            assert(bank.effectId(slot) == descriptor.id);
        }
    }
    assert(advertisedCount == 51U);
}

void testAutoRiffCatalogAdapterRoutesAndProcessesWithoutCallbackAllocations() {
    NativeEffectBank inputBank;
    NativeEffectBank trackBank;
    assert(inputBank.setEffect(NativeEffectSlot::A, "auto_riff"));
    assert(trackBank.setEffect(NativeEffectSlot::D, "auto_riff"));
    assert(inputBank.prepare(48000U));
    assert(trackBank.prepare(48000U));
    assert(inputBank.effectId(NativeEffectSlot::A) == "auto_riff");
    assert(trackBank.effectId(NativeEffectSlot::D) == "auto_riff");
    assert(inputBank.processor(NativeEffectSlot::A)->reportedLatencySamples() == 1920U);
    assert(trackBank.processor(NativeEffectSlot::D)->reportedLatencySamples() == 1920U);
    for (const auto slot : {NativeEffectSlot::A, NativeEffectSlot::D}) {
        auto& bank = slot == NativeEffectSlot::A ? inputBank : trackBank;
        assert(bank.setParameter(slot, "bpm", 300.0f, 1U));
        assert(bank.setParameter(slot, "scale", 1.0f, 1U));
        assert(bank.setParameter(slot, "rate_beats", 0.25f, 1U));
        assert(bank.setParameter(slot, "sensitivity_percent", 70.0f, 1U));
        assert(bank.setParameter(slot, "mix_percent", 100.0f, 1U));
        assert(!bank.setParameter(slot, "rate_beats", 0.3f, 1U));
    }

    std::vector<float> stereo(4096U * 2U, 0.0f);
    for (std::size_t frame = 0U; frame < 4096U; ++frame) {
        const float value = static_cast<float>(0.25 * std::sin(2.0 * kPi * 440.0 *
            static_cast<double>(frame) / 48000.0));
        stereo[frame * 2U] = value;
        stereo[frame * 2U + 1U] = value;
    }
    const std::size_t allocationsBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    const float inputPeak = inputBank.processInPlace(stereo.data(), 4096U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == allocationsBefore);
    assert(std::isfinite(inputPeak) && inputPeak > 0.0f);
    for (const float sample : stereo) assert(std::isfinite(sample));
}

void testRobotCatalogAdapterPitchFormantAndNoCallbackAllocations() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t frames = sampleRate;
    NativeEffectBank inputBank;
    NativeEffectBank trackBank;
    assert(inputBank.setEffect(NativeEffectSlot::A, "robot"));
    assert(trackBank.setEffect(NativeEffectSlot::D, "robot"));
    assert(inputBank.prepare(sampleRate));
    assert(trackBank.prepare(sampleRate));
    assert(inputBank.effectId(NativeEffectSlot::A) == "robot");
    assert(trackBank.effectId(NativeEffectSlot::D) == "robot");
    assert(inputBank.processor(NativeEffectSlot::A)->reportedLatencySamples() == 1920U);
    assert(trackBank.processor(NativeEffectSlot::D)->reportedLatencySamples() == 1920U);

    for (const auto& [bank, slot] : {std::pair{&inputBank, NativeEffectSlot::A},
                                    std::pair{&trackBank, NativeEffectSlot::D}}) {
        assert(bank->setParameter(slot, "pitch_semitones", 7.0f, 1U));
        assert(bank->setParameter(slot, "formant_semitones", -3.0f, 1U));
        assert(bank->setParameter(slot, "mix_percent", 100.0f, 1U));
        assert(!bank->setParameter(slot, "pitch_semitones", -24.01f, 1U));
        assert(!bank->setParameter(slot, "pitch_semitones", 24.01f, 1U));
        assert(!bank->setParameter(slot, "formant_semitones", -12.01f, 1U));
        assert(!bank->setParameter(slot, "formant_semitones", 12.01f, 1U));
        assert(!bank->setParameter(slot, "mix_percent", 100.01f, 1U));
    }

    std::vector<float> inputTone(frames);
    std::vector<float> trackTone(frames);
    for (std::size_t frame = 0U; frame < frames; ++frame) {
        const float value = static_cast<float>(0.3 * std::sin(2.0 * kPi * 220.0 *
            static_cast<double>(frame) / static_cast<double>(sampleRate)));
        inputTone[frame] = value;
        trackTone[frame] = value;
    }

    constexpr std::array<unsigned int, 8U> blockPattern{{1U, 17U, 256U, 31U, 1024U, 83U, 4096U, 127U}};
    const auto processArbitraryBlocks = [&](NativeEffectBank& bank, NativeEffectSlot slot,
                                            std::vector<float>& audio) {
        std::size_t cursor = 0U;
        std::size_t blockIndex = 0U;
        while (cursor < audio.size()) {
            const unsigned int blockFrames = static_cast<unsigned int>(std::min<std::size_t>(
                blockPattern[blockIndex % blockPattern.size()], audio.size() - cursor));
            (void)bank.processor(slot)->processInPlace(audio.data() + cursor, blockFrames, 1U);
            cursor += blockFrames;
            ++blockIndex;
        }
    };
    const std::size_t allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    processArbitraryBlocks(inputBank, NativeEffectSlot::A, inputTone);
    processArbitraryBlocks(trackBank, NativeEffectSlot::D, trackTone);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    const double inputHz = estimatePositiveCrossingHz(inputTone, 24000U, inputTone.size(), sampleRate);
    const double trackHz = estimatePositiveCrossingHz(trackTone, 24000U, trackTone.size(), sampleRate);
    assert(inputHz > 300.0 && inputHz < 360.0);
    assert(trackHz > 300.0 && trackHz < 360.0);
    for (const float sample : inputTone) assert(std::isfinite(sample));
    for (const float sample : trackTone) assert(std::isfinite(sample));

    auto dryRobot = createNativeEffectProcessor("robot");
    assert(dryRobot != nullptr && dryRobot->prepare(sampleRate));
    assert(dryRobot->setParameter("mix_percent", 0.0f, 1U));
    std::array<float, 2048U> ramp{};
    for (std::size_t frame = 0U; frame < ramp.size(); ++frame) {
        ramp[frame] = static_cast<float>(frame) / 2048.0f;
    }
    const auto original = ramp;
    (void)dryRobot->processInPlace(ramp.data(), static_cast<unsigned int>(ramp.size()), 1U);
    for (std::size_t frame = 0U; frame < ramp.size(); ++frame) {
        const float expected = frame >= 1920U ? original[frame - 1920U] : 0.0f;
        assert(std::fabs(ramp[frame] - expected) < 1.0e-5f);
    }
}

void testReverseReverbInputAndTrackBanksDiffuseReversedSegmentsWithoutCallbackAllocations() {
    NativeEffectBank inputBank;
    NativeEffectBank trackBank;
    assert(inputBank.setEffect(NativeEffectSlot::A, "reverse_reverb"));
    assert(trackBank.setEffect(NativeEffectSlot::D, "reverse_reverb"));
    assert(inputBank.prepare(8000U));
    assert(trackBank.prepare(8000U));
    assert(inputBank.effectId(NativeEffectSlot::A) == "reverse_reverb");
    assert(trackBank.effectId(NativeEffectSlot::D) == "reverse_reverb");

    const auto configure = [](NativeEffectBank& bank, NativeEffectSlot slot) {
        assert(bank.setParameter(slot, "bpm", 300.0f, 1U));
        assert(bank.setParameter(slot, "segment_beats", 0.25f, 1U));
        assert(bank.setParameter(slot, "feedback_percent", 0.0f, 1U));
        assert(bank.setParameter(slot, "crossfade_ms", 20.0f, 1U));
        assert(bank.setParameter(slot, "decay_seconds", 2.0f, 1U));
        assert(bank.setParameter(slot, "damping_cutoff_hz", 8000.0f, 1U));
        assert(bank.setParameter(slot, "mix_percent", 100.0f, 1U));
    };
    configure(inputBank, NativeEffectSlot::A);
    configure(trackBank, NativeEffectSlot::D);

    const auto renderImpulse = [](NativeEffectBank& bank) {
        constexpr std::size_t kFrames = 4096U;
        std::vector<float> impulse(kFrames * 2U, 0.0f);
        // Keep the impulse away from the captured segment's endpoint: the
        // configured reverse overlap intentionally fades that endpoint out.
        impulse[200U] = 1.0f;
        impulse[201U] = 1.0f;
        const std::size_t allocationCount = test_alloc::count();
        test_alloc::beginTracking();
        constexpr std::array<unsigned int, 7U> blockPattern{{1U, 31U, 127U, 17U, 256U, 83U, 64U}};
        std::size_t cursor = 0U;
        std::size_t blockIndex = 0U;
        while (cursor < kFrames) {
            const auto blockFrames = static_cast<unsigned int>(std::min<std::size_t>(
                blockPattern[blockIndex % blockPattern.size()], kFrames - cursor));
            (void)bank.processInPlace(impulse.data() + cursor * 2U, blockFrames, 2U);
            cursor += blockFrames;
            ++blockIndex;
        }
        test_alloc::endTracking();
        assert(test_alloc::count() == allocationCount);
        double beforeSegmentReturnEnergy = 0.0;
        double returnedEnergy = 0.0;
        double peak = 0.0;
        for (std::size_t frame = 0U; frame < kFrames; ++frame) {
            const float left = impulse[frame * 2U];
            const float right = impulse[(frame * 2U) + 1U];
            assert(std::isfinite(left) && std::isfinite(right));
            const double energy = static_cast<double>(left) * left + static_cast<double>(right) * right;
            if (frame < 1200U) beforeSegmentReturnEnergy += energy;
            if (frame >= 1200U) returnedEnergy += energy;
            peak = std::max(peak, std::max(std::fabs(static_cast<double>(left)), std::fabs(static_cast<double>(right))));
        }
        // At full wet, the first beat-sized segment is intentionally silent
        // while being captured. The later non-zero response is the reversed
        // impulse diffused through the FDN, not dry leakage.
        assert(beforeSegmentReturnEnergy == 0.0);
        assert(returnedEnergy > 1.0e-8);
        assert(peak > 1.0e-5);
    };
    renderImpulse(inputBank);
    renderImpulse(trackBank);
}

void testTransposeSignalsmithFxLatencyAlignedMixAndAudio() {
    constexpr unsigned int sampleRate = 48000U;
    auto dryProbe = createNativeEffectProcessor("transpose");
    assert(dryProbe != nullptr && dryProbe->prepare(sampleRate));
    assert(dryProbe->reportedLatencySamples() == 1920U);
    assert(!dryProbe->setParameter("shift_semitones", -24.1f, 1U));
    assert(!dryProbe->setParameter("shift_semitones", 24.1f, 1U));
    assert(!dryProbe->setParameter("mix_percent", 100.1f, 1U));
    assert(dryProbe->setParameter("shift_semitones", 12.0f, 1U));
    assert(dryProbe->setParameter("mix_percent", 0.0f, 1U));
    std::vector<float> impulse(4096U, 0.0f);
    impulse[0U] = 0.75f;
    const std::size_t allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)dryProbe->processInPlace(impulse.data(), static_cast<unsigned int>(impulse.size()), 1U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    for (std::size_t index = 0U; index < impulse.size(); ++index) {
        const float expected = index == 1920U ? 0.75f : 0.0f;
        expectNear(impulse[index], expected, 2.0e-5f);
    }

    auto stereoResetProbe = createNativeEffectProcessor("transpose");
    assert(stereoResetProbe != nullptr && stereoResetProbe->prepare(sampleRate));
    assert(stereoResetProbe->setParameter("mix_percent", 0.0f, 1U));
    std::array<float, 2U> staleStereoFrame{{0.25f, 0.75f}};
    (void)stereoResetProbe->processInPlace(staleStereoFrame.data(), 1U, 2U);
    stereoResetProbe->resetState();
    std::array<float, 2U> afterResetFrame{};
    (void)stereoResetProbe->processInPlace(afterResetFrame.data(), 1U, 2U);
    expectNear(afterResetFrame[0U], 0.0f);
    expectNear(afterResetFrame[1U], 0.0f);

    auto wetProbe = createNativeEffectProcessor("transpose");
    assert(wetProbe != nullptr && wetProbe->prepare(sampleRate));
    assert(wetProbe->setParameter("shift_semitones", 12.0f, 1U));
    constexpr double sourceFrequency = 220.0;
    std::vector<float> tone(static_cast<std::size_t>(sampleRate) * 2U);
    for (std::size_t index = 0U; index < tone.size(); ++index) {
        tone[index] = static_cast<float>(0.3 * std::sin(2.0 * kPi * sourceFrequency *
            static_cast<double>(index) / static_cast<double>(sampleRate)));
    }
    const std::array<unsigned int, 5U> chunkFrames{{1U, 63U, 127U, 256U, 1024U}};
    std::size_t offsetFrames = 0U;
    std::size_t chunkIndex = 0U;
    while (offsetFrames < tone.size()) {
        const auto frames = static_cast<unsigned int>(std::min<std::size_t>(
            chunkFrames[chunkIndex % chunkFrames.size()], tone.size() - offsetFrames));
        (void)wetProbe->processInPlace(tone.data() + offsetFrames, frames, 1U);
        offsetFrames += frames;
        ++chunkIndex;
    }
    const std::size_t measurementStart = 1920U + sampleRate / 3U;
    const std::size_t measurementEnd = measurementStart + sampleRate / 2U;
    const double observedHz = estimatePositiveCrossingHz(tone, measurementStart, measurementEnd, sampleRate);
    assert(observedHz > 440.0 * 0.96 && observedHz < 440.0 * 1.04);
    double energy = 0.0;
    for (std::size_t index = measurementStart; index < measurementEnd; ++index) {
        assert(std::isfinite(tone[index]));
        energy += static_cast<double>(tone[index]) * tone[index];
    }
    assert(energy > 1.0);
}

void testPitchBendOneShotSweepDirectionRetriggerAndAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t dftFrames = 8192U;
    constexpr double sourceHz = 220.0;
    const auto makeTone = [](std::size_t frames) {
        std::vector<float> signal(frames);
        for (std::size_t frame = 0U; frame < frames; ++frame) {
            signal[frame] = static_cast<float>(0.3 * std::sin(2.0 * kPi * sourceHz *
                static_cast<double>(frame) / static_cast<double>(sampleRate)));
        }
        return signal;
    };
    const auto processChunks = [](NativeEffectProcessor& processor, std::vector<float>& signal) {
        constexpr std::array<unsigned int, 5U> chunks{{127U, 1024U, 63U, 2048U, 4096U}};
        std::size_t offset = 0U;
        std::size_t chunkIndex = 0U;
        while (offset < signal.size()) {
            const auto frames = static_cast<unsigned int>(std::min<std::size_t>(
                chunks[chunkIndex % chunks.size()], signal.size() - offset));
            (void)processor.processInPlace(signal.data() + offset, frames, 1U);
            offset += frames;
            ++chunkIndex;
        }
    };

    auto up = createNativeEffectProcessor("pitch_bend");
    assert(up != nullptr && up->prepare(sampleRate));
    assert(up->setParameter("range", 12.0f, 1U));
    assert(up->setParameter("time_ms", 2000.0f, 1U));
    assert(up->setParameter("direction", 0.0f, 1U));
    assert(up->setParameter("mix_percent", 100.0f, 1U));
    auto upTone = makeTone(static_cast<std::size_t>(sampleRate) * 3U);
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    processChunks(*up, upTone);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    const std::size_t latency = up->reportedLatencySamples();
    const std::size_t earlyBegin = latency + sampleRate / 5U;
    const std::size_t midBegin = latency + (sampleRate * 9U) / 10U;
    const std::size_t endBegin = latency + (sampleRate * 22U) / 10U;
    const double earlyExpected = sourceHz * std::exp2((0.2 + 0.5 * dftFrames / sampleRate) * 6.0 / 12.0);
    const double midExpected = sourceHz * std::exp2((0.9 + 0.5 * dftFrames / sampleRate) * 6.0 / 12.0);
    const double earlyLevel = dftMagnitude(upTone, earlyBegin, dftFrames, sampleRate, earlyExpected);
    const double midLevel = dftMagnitude(upTone, midBegin, dftFrames, sampleRate, midExpected);
    const double endLevel = dftMagnitude(upTone, endBegin, dftFrames, sampleRate, 440.0);
    assert(segmentRms(upTone, earlyBegin, dftFrames) > 0.05);
    assert(segmentRms(upTone, midBegin, dftFrames) > 0.05);
    assert(segmentRms(upTone, endBegin, dftFrames) > 0.05);
    assert(earlyLevel > dftMagnitude(upTone, earlyBegin, dftFrames, sampleRate, 220.0) * 1.1);
    assert(midLevel > dftMagnitude(upTone, midBegin, dftFrames, sampleRate, 220.0) * 1.5);
    assert(midLevel > dftMagnitude(upTone, midBegin, dftFrames, sampleRate, 440.0) * 1.2);
    assert(endLevel > dftMagnitude(upTone, endBegin, dftFrames, sampleRate, 220.0) * 1.5);

    auto down = createNativeEffectProcessor("pitch_bend");
    assert(down != nullptr && down->prepare(sampleRate));
    assert(down->setParameter("range", 12.0f, 1U));
    assert(down->setParameter("time_ms", 400.0f, 1U));
    assert(down->setParameter("direction", 1.0f, 1U));
    assert(down->setParameter("mix_percent", 100.0f, 1U));
    auto downTone = makeTone(static_cast<std::size_t>(sampleRate));
    processChunks(*down, downTone);
    const std::size_t downEndBegin = down->reportedLatencySamples() + sampleRate * 6U / 10U;
    const double downLevel = dftMagnitude(downTone, downEndBegin, dftFrames, sampleRate, 110.0);
    assert(segmentRms(downTone, downEndBegin, dftFrames) > 0.05);
    assert(downLevel > dftMagnitude(downTone, downEndBegin, dftFrames, sampleRate, 220.0) * 1.5);

    auto retrigger = createNativeEffectProcessor("pitch_bend");
    assert(retrigger != nullptr && retrigger->prepare(sampleRate));
    assert(retrigger->setParameter("range", 12.0f, 1U));
    assert(retrigger->setParameter("time_ms", 400.0f, 1U));
    assert(retrigger->setParameter("mix_percent", 100.0f, 1U));
    auto firstRun = makeTone(static_cast<std::size_t>(sampleRate));
    processChunks(*retrigger, firstRun);
    const auto firstEnd = retrigger->reportedLatencySamples() + sampleRate * 6U / 10U;
    assert(dftMagnitude(firstRun, firstEnd, dftFrames, sampleRate, 440.0) >
        dftMagnitude(firstRun, firstEnd, dftFrames, sampleRate, 220.0) * 1.5);

    // Repeatedly requesting the existing state is not a transition and must
    // not restart the completed one-shot.
    retrigger->setBypassed(false, 1U);
    auto stillHeld = makeTone(sampleRate / 3U);
    processChunks(*retrigger, stillHeld);
    const auto heldStart = retrigger->reportedLatencySamples() + sampleRate / 10U;
    assert(dftMagnitude(stillHeld, heldStart, dftFrames, sampleRate, 440.0) >
        dftMagnitude(stillHeld, heldStart, dftFrames, sampleRate, 220.0) * 1.5);

    auto bypassBuffer = makeTone(sampleRate / 5U);
    auto restarted = makeTone(sampleRate);
    const auto allocationsBeforeRestart = test_alloc::count();
    test_alloc::beginTracking();
    retrigger->setBypassed(true, 1U);
    processChunks(*retrigger, bypassBuffer);
    retrigger->setBypassed(true, 1U);
    retrigger->setBypassed(false, 1U);
    processChunks(*retrigger, restarted);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBeforeRestart);
    const auto restartedEarly = retrigger->reportedLatencySamples() + sampleRate / 20U;
    const auto restartedEnd = retrigger->reportedLatencySamples() + sampleRate * 6U / 10U;
    assert(dftMagnitude(restarted, restartedEarly, 4096U, sampleRate, 260.0) >
        dftMagnitude(restarted, restartedEarly, 4096U, sampleRate, 440.0) * 1.2);
    assert(dftMagnitude(restarted, restartedEnd, dftFrames, sampleRate, 440.0) >
        dftMagnitude(restarted, restartedEnd, dftFrames, sampleRate, 220.0) * 1.5);

    auto mixZero = createNativeEffectProcessor("pitch_bend");
    assert(mixZero != nullptr && mixZero->prepare(sampleRate));
    assert(mixZero->setParameter("mix_percent", 0.0f, 1U));
    std::vector<float> impulse(4096U, 0.0f);
    impulse[0U] = 0.75f;
    (void)mixZero->processInPlace(impulse.data(), static_cast<unsigned int>(impulse.size()), 1U);
    for (std::size_t index = 0U; index < impulse.size(); ++index) {
        expectNear(impulse[index], index == 1920U ? 0.75f : 0.0f, 2.0e-5f);
    }

    auto unsupportedChannels = createNativeEffectProcessor("pitch_bend");
    assert(unsupportedChannels != nullptr && unsupportedChannels->prepare(sampleRate));
    std::array<float, 3U * 64U> threeChannelBlock{};
    threeChannelBlock.fill(0.25f);
    (void)unsupportedChannels->processInPlace(threeChannelBlock.data(), 64U, 3U);
    assert(unsupportedChannels->processingFaulted());
    for (std::size_t frame = 0U; frame < threeChannelBlock.size() / 3U; ++frame) {
        expectNear(threeChannelBlock[frame * 3U + 2U], 0.25f);
    }
}

void testPitchBendActivationPreservesPitchPipelineContinuity() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr double sourceHz = 220.0;
    constexpr std::size_t firstWindowFrames = sampleRate * 40U / 1000U;
    constexpr std::size_t fullWindowFrames = sampleRate * 60U / 1000U;
    const auto makeTone = [](std::size_t firstFrame, std::size_t frames) {
        std::vector<float> signal(frames);
        for (std::size_t frame = 0U; frame < frames; ++frame) {
            signal[frame] = static_cast<float>(0.3 * std::sin(2.0 * kPi * sourceHz *
                static_cast<double>(firstFrame + frame) / static_cast<double>(sampleRate)));
        }
        return signal;
    };
    const auto processChunks = [](NativeEffectProcessor& processor, std::vector<float>& signal) {
        constexpr std::array<unsigned int, 4U> chunks{{127U, 1024U, 63U, 2048U}};
        std::size_t offset = 0U;
        std::size_t chunkIndex = 0U;
        while (offset < signal.size()) {
            const auto frames = static_cast<unsigned int>(std::min<std::size_t>(
                chunks[chunkIndex % chunks.size()], signal.size() - offset));
            (void)processor.processInPlace(signal.data() + offset, frames, 1U);
            offset += frames;
            ++chunkIndex;
        }
    };

    auto effect = createNativeEffectProcessor("pitch_bend");
    assert(effect != nullptr && effect->prepare(sampleRate));
    assert(effect->setParameter("range", 12.0f, 1U));
    assert(effect->setParameter("time_ms", 500.0f, 1U));
    assert(effect->setParameter("mix_percent", 100.0f, 1U));

    // Keep a zero-semitone Signalsmith stream warm while bypassed. On release,
    // its first wet samples should be continuous; resetting here would flush
    // the pitch engine's 40 ms stream pipeline exactly as the wet mix opens.
    effect->setBypassed(true, 1U);
    const std::size_t warmFrames = sampleRate / 2U;
    auto bypassedTone = makeTone(0U, warmFrames);
    processChunks(*effect, bypassedTone);
    const double bypassRms = segmentRms(bypassedTone, warmFrames - firstWindowFrames, firstWindowFrames);
    assert(bypassRms > 0.15);

    auto releasedTone = makeTone(warmFrames, fullWindowFrames);
    const auto allocationsBeforeRelease = test_alloc::count();
    test_alloc::beginTracking();
    effect->setBypassed(false, 1U);
    processChunks(*effect, releasedTone);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBeforeRelease);

    // Measure from sample zero after release, deliberately before applying
    // reportedLatencySamples(). A reset-flushed pitch stream leaves this window
    // silent even though latency-corrected measurements later recover.
    const double first40MsRms = segmentRms(releasedTone, 0U, firstWindowFrames);
    const double first60MsRms = segmentRms(releasedTone, 0U, fullWindowFrames);
    assert(first40MsRms > bypassRms * 0.65);
    assert(first60MsRms > bypassRms * 0.7);
}

void testManualHarmonistTwoVoicesAdditivePanAndAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr double sourceHz = 220.0;
    constexpr std::size_t signalFrames = static_cast<std::size_t>(sampleRate) * 2U;
    constexpr std::size_t dftFrames = 8192U;
    const auto makeTone = [](std::size_t frames) {
        std::vector<float> signal(frames);
        for (std::size_t frame = 0U; frame < frames; ++frame) {
            signal[frame] = static_cast<float>(0.3 * std::sin(2.0 * kPi * sourceHz *
                static_cast<double>(frame) / static_cast<double>(sampleRate)));
        }
        return signal;
    };
    const auto processVariableBlocks = [](NativeEffectProcessor& processor, std::vector<float>& signal) {
        constexpr std::array<unsigned int, 6U> chunks{{127U, 1024U, 63U, 2048U, 4096U, 8192U}};
        std::size_t offset = 0U;
        std::size_t chunkIndex = 0U;
        while (offset < signal.size()) {
            const auto frames = static_cast<unsigned int>(std::min<std::size_t>(
                chunks[chunkIndex % chunks.size()], signal.size() - offset));
            (void)processor.processInPlace(signal.data() + offset, frames, 1U);
            offset += frames;
            ++chunkIndex;
        }
    };
    const auto makePrepared = [&]() {
        auto effect = createNativeEffectProcessor("hrm_manual");
        assert(effect != nullptr && effect->prepare(sampleRate));
        assert(effect->setParameter("voice_1_interval", 7.0f, 1U));
        assert(effect->setParameter("voice_2_interval", 12.0f, 1U));
        return effect;
    };

    auto defaultMix = makePrepared();
    auto defaultTone = makeTone(signalFrames);
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    processVariableBlocks(*defaultMix, defaultTone);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    auto dryOnly = makePrepared();
    assert(dryOnly->setParameter("mix_percent", 0.0f, 1U));
    auto dryTone = makeTone(signalFrames);
    processVariableBlocks(*dryOnly, dryTone);

    auto fullMix = makePrepared();
    assert(fullMix->setParameter("mix_percent", 100.0f, 1U));
    auto fullTone = makeTone(signalFrames);
    processVariableBlocks(*fullMix, fullTone);

    const std::size_t measurementStart = defaultMix->reportedLatencySamples() + sampleRate / 2U;
    const double dryFundamental = dftMagnitude(dryTone, measurementStart, dftFrames, sampleRate, sourceHz);
    const double defaultFundamental = dftMagnitude(defaultTone, measurementStart, dftFrames, sampleRate, sourceHz);
    const double defaultVoice1 = dftMagnitude(defaultTone, measurementStart, dftFrames, sampleRate, 330.0);
    const double defaultVoice2 = dftMagnitude(defaultTone, measurementStart, dftFrames, sampleRate, 440.0);
    const double fullVoice1 = dftMagnitude(fullTone, measurementStart, dftFrames, sampleRate, 330.0);
    const double fullVoice2 = dftMagnitude(fullTone, measurementStart, dftFrames, sampleRate, 440.0);
    assert(segmentRms(defaultTone, measurementStart, dftFrames) > 0.15);
    assert(std::fabs(defaultFundamental - dryFundamental) < dryFundamental * 0.15);
    assert(defaultVoice1 > 0.015 && defaultVoice2 > 0.015);
    assert(defaultVoice1 > dftMagnitude(dryTone, measurementStart, dftFrames, sampleRate, 330.0) * 3.0);
    assert(defaultVoice2 > dftMagnitude(dryTone, measurementStart, dftFrames, sampleRate, 440.0) * 3.0);
    assert(defaultVoice1 / fullVoice1 > 0.55 && defaultVoice1 / fullVoice1 < 0.85);
    assert(defaultVoice2 / fullVoice2 > 0.55 && defaultVoice2 / fullVoice2 < 0.85);

    auto panned = makePrepared();
    assert(panned->setParameter("pan_percent", 100.0f, 1U));
    assert(panned->setParameter("mix_percent", 100.0f, 1U));
    std::vector<float> stereo(signalFrames * 2U);
    for (std::size_t frame = 0U; frame < signalFrames; ++frame) {
        const float sample = static_cast<float>(0.3 * std::sin(2.0 * kPi * sourceHz *
            static_cast<double>(frame) / static_cast<double>(sampleRate)));
        stereo[frame * 2U] = sample;
        stereo[frame * 2U + 1U] = sample;
    }
    std::size_t stereoOffset = 0U;
    constexpr std::array<unsigned int, 5U> stereoChunks{{128U, 2048U, 257U, 4096U, 8192U}};
    std::size_t stereoChunkIndex = 0U;
    while (stereoOffset < signalFrames) {
        const auto frames = static_cast<unsigned int>(std::min<std::size_t>(
            stereoChunks[stereoChunkIndex % stereoChunks.size()], signalFrames - stereoOffset));
        (void)panned->processInPlace(stereo.data() + stereoOffset * 2U, frames, 2U);
        stereoOffset += frames;
        ++stereoChunkIndex;
    }
    std::vector<float> left(signalFrames);
    std::vector<float> right(signalFrames);
    for (std::size_t frame = 0U; frame < signalFrames; ++frame) {
        left[frame] = stereo[frame * 2U];
        right[frame] = stereo[frame * 2U + 1U];
    }
    const double leftFundamental = dftMagnitude(left, measurementStart, dftFrames, sampleRate, sourceHz);
    const double rightFundamental = dftMagnitude(right, measurementStart, dftFrames, sampleRate, sourceHz);
    const double leftVoice1 = dftMagnitude(left, measurementStart, dftFrames, sampleRate, 330.0);
    const double rightVoice1 = dftMagnitude(right, measurementStart, dftFrames, sampleRate, 330.0);
    const double rightVoice2 = dftMagnitude(right, measurementStart, dftFrames, sampleRate, 440.0);
    assert(std::fabs(leftFundamental - rightFundamental) < leftFundamental * 0.1);
    assert(rightVoice1 > 0.015 && rightVoice2 > 0.015);
    assert(rightVoice1 > leftVoice1 * 3.0);

    auto monoPan = makePrepared();
    assert(monoPan->setParameter("pan_percent", 25.0f, 1U));
    auto monoInput = makeTone(sampleRate / 2U);
    const auto originalMono = monoInput;
    (void)monoPan->processInPlace(monoInput.data(), static_cast<unsigned int>(monoInput.size()), 1U);
    assert(monoPan->processingFaulted());
    const auto latency = monoPan->reportedLatencySamples();
    for (std::size_t frame = latency + 64U; frame < monoInput.size(); ++frame) {
        expectNear(monoInput[frame], originalMono[frame - latency], 2.0e-6f);
    }

    // The fault bit is diagnostic and remains latched, but correcting the
    // unsupported pan must restore wet harmony processing without resetState.
    assert(monoPan->setParameter("pan_percent", 0.0f, 1U));
    auto centeredMono = makeTone(sampleRate / 2U);
    (void)monoPan->processInPlace(centeredMono.data(), static_cast<unsigned int>(centeredMono.size()), 1U);
    assert(monoPan->processingFaulted());
    const auto centeredStart = latency + sampleRate / 10U;
    assert(dftMagnitude(centeredMono, centeredStart, dftFrames, sampleRate, 330.0) > 0.015);
    assert(dftMagnitude(centeredMono, centeredStart, dftFrames, sampleRate, 440.0) > 0.015);
}

void testOctaveThreeFixedVoicesAdditiveMixAndAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr double sourceHz = 220.0;
    constexpr std::size_t signalFrames = static_cast<std::size_t>(sampleRate) * 2U;
    constexpr std::size_t dftFrames = 9600U;
    const auto makeTone = []() {
        std::vector<float> signal(signalFrames);
        for (std::size_t frame = 0U; frame < signal.size(); ++frame) {
            signal[frame] = static_cast<float>(0.3 * std::sin(2.0 * kPi * sourceHz *
                static_cast<double>(frame) / static_cast<double>(sampleRate)));
        }
        return signal;
    };
    const auto processVariableBlocks = [](NativeEffectProcessor& processor, std::vector<float>& signal) {
        constexpr std::array<unsigned int, 6U> chunks{{127U, 1024U, 63U, 2048U, 4096U, 8192U}};
        std::size_t offset = 0U;
        std::size_t chunkIndex = 0U;
        while (offset < signal.size()) {
            const auto frames = static_cast<unsigned int>(std::min<std::size_t>(
                chunks[chunkIndex % chunks.size()], signal.size() - offset));
            (void)processor.processInPlace(signal.data() + offset, frames, 1U);
            offset += frames;
            ++chunkIndex;
        }
    };
    const auto makePrepared = []() {
        auto effect = createNativeEffectProcessor("octave");
        assert(effect != nullptr && effect->prepare(sampleRate));
        return effect;
    };
    const auto configureSingleVoice = [](NativeEffectProcessor& effect, std::string_view activeLevel) {
        assert(effect.setParameter("minus_24_level", activeLevel == "minus_24_level" ? 100.0f : 0.0f, 1U));
        assert(effect.setParameter("minus_12_level", activeLevel == "minus_12_level" ? 100.0f : 0.0f, 1U));
        assert(effect.setParameter("plus_12_level", activeLevel == "plus_12_level" ? 100.0f : 0.0f, 1U));
        assert(effect.setParameter("mix_percent", 100.0f, 1U));
    };

    auto dryOnly = makePrepared();
    assert(dryOnly->setParameter("mix_percent", 0.0f, 1U));
    auto dryTone = makeTone();
    processVariableBlocks(*dryOnly, dryTone);
    const std::size_t measurementStart = dryOnly->reportedLatencySamples() + sampleRate / 2U;
    const double dryFundamental = dftMagnitude(dryTone, measurementStart, dftFrames, sampleRate, sourceHz);
    for (std::size_t frame = dryOnly->reportedLatencySamples() + 64U; frame < dryTone.size(); ++frame) {
        const auto sourceFrame = frame - dryOnly->reportedLatencySamples();
        expectNear(dryTone[frame], static_cast<float>(0.3 * std::sin(2.0 * kPi * sourceHz *
            static_cast<double>(sourceFrame) / static_cast<double>(sampleRate))), 2.0e-6f);
    }

    constexpr std::array<std::string_view, 3U> levelIds{{
        "minus_24_level", "minus_12_level", "plus_12_level",
    }};
    constexpr std::array<double, 3U> expectedHz{{55.0, 110.0, 440.0}};
    constexpr std::array<double, 3U> minimumVoiceMagnitudes{{0.005, 0.03, 0.1}};
    std::array<double, 3U> fullVoiceMagnitude{};
    for (std::size_t voice = 0U; voice < levelIds.size(); ++voice) {
        auto effect = makePrepared();
        configureSingleVoice(*effect, levelIds[voice]);
        auto tone = makeTone();
        processVariableBlocks(*effect, tone);
        assert(std::all_of(tone.begin(), tone.end(), [](float sample) { return std::isfinite(sample); }));
        fullVoiceMagnitude[voice] = dftMagnitude(tone, measurementStart, dftFrames, sampleRate, expectedHz[voice]);
        assert(fullVoiceMagnitude[voice] > minimumVoiceMagnitudes[voice]);
        assert(std::fabs(dftMagnitude(tone, measurementStart, dftFrames, sampleRate, sourceHz) -
            dryFundamental) < dryFundamental * 0.15);
        for (std::size_t competing = 0U; competing < expectedHz.size(); ++competing) {
            if (competing == voice) continue;
            assert(fullVoiceMagnitude[voice] > dftMagnitude(
                tone, measurementStart, dftFrames, sampleRate, expectedHz[competing]) * 1.5);
        }
    }

    auto defaultMix = makePrepared();
    auto defaultTone = makeTone();
    processVariableBlocks(*defaultMix, defaultTone);
    const double defaultMinus12 = dftMagnitude(
        defaultTone, measurementStart, dftFrames, sampleRate, 110.0);
    assert(defaultMinus12 / fullVoiceMagnitude[1] > 0.20);
    assert(defaultMinus12 / fullVoiceMagnitude[1] < 0.36);
    assert(std::fabs(dftMagnitude(defaultTone, measurementStart, dftFrames, sampleRate, sourceHz) -
        dryFundamental) < dryFundamental * 0.15);

    // All three prepared Signalsmith streams are exercised under callback
    // allocation tracking with irregular host blocks, including 8192 frames.
    auto allVoices = makePrepared();
    assert(allVoices->setParameter("minus_24_level", 100.0f, 1U));
    assert(allVoices->setParameter("minus_12_level", 100.0f, 1U));
    assert(allVoices->setParameter("plus_12_level", 100.0f, 1U));
    assert(allVoices->setParameter("mix_percent", 100.0f, 1U));
    auto allTone = makeTone();
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    processVariableBlocks(*allVoices, allTone);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(std::all_of(allTone.begin(), allTone.end(), [](float sample) { return std::isfinite(sample); }));
    assert(segmentRms(allTone, measurementStart, dftFrames) > 0.15);
    for (std::size_t voice = 0U; voice < expectedHz.size(); ++voice) {
        assert(dftMagnitude(allTone, measurementStart, dftFrames, sampleRate, expectedHz[voice]) >
            minimumVoiceMagnitudes[voice]);
    }

    // A stereo Track bus must keep distinct left/right source content through
    // the pitch voices instead of collapsing it to a mono harmony bus.
    auto stereoProcessor = makePrepared();
    assert(stereoProcessor->setParameter("minus_24_level", 0.0f, 1U));
    assert(stereoProcessor->setParameter("minus_12_level", 100.0f, 1U));
    assert(stereoProcessor->setParameter("plus_12_level", 0.0f, 1U));
    assert(stereoProcessor->setParameter("mix_percent", 100.0f, 1U));
    std::vector<float> stereo(signalFrames * 2U);
    for (std::size_t frame = 0U; frame < signalFrames; ++frame) {
        stereo[frame * 2U] = static_cast<float>(0.3 * std::sin(2.0 * kPi * 220.0 *
            static_cast<double>(frame) / static_cast<double>(sampleRate)));
        stereo[frame * 2U + 1U] = static_cast<float>(0.3 * std::sin(2.0 * kPi * 330.0 *
            static_cast<double>(frame) / static_cast<double>(sampleRate)));
    }
    std::size_t stereoOffset = 0U;
    constexpr std::array<unsigned int, 5U> stereoChunks{{128U, 2048U, 257U, 4096U, 8192U}};
    std::size_t stereoChunkIndex = 0U;
    while (stereoOffset < signalFrames) {
        const auto frames = static_cast<unsigned int>(std::min<std::size_t>(
            stereoChunks[stereoChunkIndex % stereoChunks.size()], signalFrames - stereoOffset));
        (void)stereoProcessor->processInPlace(stereo.data() + stereoOffset * 2U, frames, 2U);
        stereoOffset += frames;
        ++stereoChunkIndex;
    }
    std::vector<float> left(signalFrames);
    std::vector<float> right(signalFrames);
    for (std::size_t frame = 0U; frame < signalFrames; ++frame) {
        left[frame] = stereo[frame * 2U];
        right[frame] = stereo[frame * 2U + 1U];
    }
    assert(dftMagnitude(left, measurementStart, dftFrames, sampleRate, 110.0) > 0.015);
    assert(dftMagnitude(right, measurementStart, dftFrames, sampleRate, 165.0) > 0.015);
    assert(dftMagnitude(left, measurementStart, dftFrames, sampleRate, 110.0) >
        dftMagnitude(right, measurementStart, dftFrames, sampleRate, 110.0) * 3.0);
    assert(dftMagnitude(right, measurementStart, dftFrames, sampleRate, 165.0) >
        dftMagnitude(left, measurementStart, dftFrames, sampleRate, 165.0) * 3.0);
}

void testPitchBendTrajectoryEditsRestartWhileMixDoesNot() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr std::size_t dftFrames = 4096U;
    const auto makeTone = [](std::size_t frames) {
        std::vector<float> signal(frames);
        for (std::size_t frame = 0U; frame < frames; ++frame) {
            signal[frame] = static_cast<float>(0.3 * std::sin(2.0 * kPi * 220.0 *
                static_cast<double>(frame) / static_cast<double>(sampleRate)));
        }
        return signal;
    };
    const auto processChunks = [](NativeEffectProcessor& processor, std::vector<float>& signal) {
        std::size_t offset = 0U;
        while (offset < signal.size()) {
            const auto frames = static_cast<unsigned int>(std::min<std::size_t>(
                1024U, signal.size() - offset));
            (void)processor.processInPlace(signal.data() + offset, frames, 1U);
            offset += frames;
        }
    };
    const auto verifyControlRestart = [&](std::string_view parameter, float value,
                                          double expectedHz, double staleHz) {
        auto effect = createNativeEffectProcessor("pitch_bend");
        assert(effect != nullptr && effect->prepare(sampleRate));
        assert(effect->setParameter("range", 12.0f, 1U));
        assert(effect->setParameter("time_ms", 400.0f, 1U));
        assert(effect->setParameter("direction", 0.0f, 1U));
        assert(effect->setParameter("mix_percent", 100.0f, 1U));
        auto initial = makeTone(sampleRate / 5U);
        processChunks(*effect, initial);
        assert(effect->setParameter(parameter, value, 1U));
        auto continuation = makeTone(sampleRate / 2U);
        processChunks(*effect, continuation);
        const std::size_t begin = effect->reportedLatencySamples() + sampleRate * 4U / 100U;
        assert(segmentRms(continuation, begin, dftFrames) > 0.05);
        const double expected = dftMagnitude(continuation, begin, dftFrames, sampleRate, expectedHz);
        const double stale = dftMagnitude(continuation, begin, dftFrames, sampleRate, staleHz);
        assert(expected > stale * 1.15);
    };

    // Each trajectory-defining edit restarts from zero while the effect is
    // active, matching the Browser PITCH BEND controls.
    verifyControlRestart("range", 6.0f, 237.0, 282.0);
    verifyControlRestart("time_ms", 800.0f, 237.0, 282.0);
    verifyControlRestart("direction", 1.0f, 190.0, 135.0);

    auto mixEdit = createNativeEffectProcessor("pitch_bend");
    assert(mixEdit != nullptr && mixEdit->prepare(sampleRate));
    assert(mixEdit->setParameter("range", 12.0f, 1U));
    assert(mixEdit->setParameter("time_ms", 400.0f, 1U));
    assert(mixEdit->setParameter("mix_percent", 100.0f, 1U));
    auto initial = makeTone(sampleRate / 5U);
    processChunks(*mixEdit, initial);
    assert(mixEdit->setParameter("mix_percent", 50.0f, 1U));
    auto continuation = makeTone(sampleRate / 2U);
    processChunks(*mixEdit, continuation);
    const std::size_t begin = mixEdit->reportedLatencySamples() + sampleRate * 4U / 100U;
    assert(segmentRms(continuation, begin, dftFrames) > 0.05);
    const double continued = dftMagnitude(continuation, begin, dftFrames, sampleRate, 362.0);
    const double restarted = dftMagnitude(continuation, begin, dftFrames, sampleRate, 254.0);
    assert(continued > restarted * 1.15);
}

void testPatternSlicerEnvelopeTempoAndAllocation() {
    const auto* descriptor = findNativeEffectDescriptor("pattern_slicer");
    assert(descriptor != nullptr && descriptor->sourceIndex == 34);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    const auto* pattern = findNativeEffectParameter("pattern_slicer", "pattern");
    const auto* rate = findNativeEffectParameter("pattern_slicer", "rate");
    const auto* depth = findNativeEffectParameter("pattern_slicer", "depth");
    const auto* edge = findNativeEffectParameter("pattern_slicer", "edge_ms");
    const auto* bpm = findNativeEffectParameter("pattern_slicer", "bpm");
    assert(pattern != nullptr && pattern->discrete && pattern->discreteValueCount == 8U);
    assert(rate != nullptr && rate->discrete && rate->discreteValueCount == 5U);
    assert(depth != nullptr && depth->minimum == 0.0f && depth->maximum == 100.0f);
    assert(edge != nullptr && edge->minimum == 0.5f && edge->maximum == 20.0f);
    assert(bpm != nullptr && bpm->minimum == 30.0f && bpm->maximum == 300.0f);

    auto slicer = createNativeEffectProcessor("pattern_slicer");
    assert(slicer != nullptr && slicer->prepare(8000U));
    assert(!slicer->setParameter("pattern", 1.5f, 1U));
    assert(!slicer->setParameter("rate", 0.75f, 1U));
    assert(!slicer->setParameter("depth", 100.1f, 1U));
    assert(!slicer->setParameter("edge_ms", 0.49f, 1U));
    assert(!slicer->setParameter("bpm", 300.1f, 1U));
    assert(slicer->setParameter("pattern", 0.0f, 1U));
    assert(slicer->setParameter("rate", 0.25f, 1U));
    assert(slicer->setParameter("depth", 100.0f, 1U));
    assert(slicer->setParameter("edge_ms", 0.5f, 1U));
    assert(slicer->setParameter("bpm", 120.0f, 1U));

    std::vector<float> signal(2010U, 1.0f);
    const std::size_t before = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)slicer->processInPlace(signal.data(), static_cast<unsigned int>(signal.size()), 1U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == before);
    // At 120 BPM and a quarter of a beat per step, each step is 1,000 frames
    // at 8 kHz. Pattern 1 alternates open and closed steps with 4-frame edges.
    expectNear(signal[0], 0.0f);
    expectNear(signal[4], 1.0f);
    expectNear(signal[999], 1.0f);
    expectNear(signal[1000], 1.0f);
    expectNear(signal[1001], 0.8535534f, 1.0e-4f);
    expectNear(signal[1002], 0.5f, 1.0e-4f);
    expectNear(signal[1003], 0.1464466f, 1.0e-4f);
    expectNear(signal[1004], 0.0f);

    auto whole = createNativeEffectProcessor("pattern_slicer");
    auto chunked = createNativeEffectProcessor("pattern_slicer");
    assert(whole != nullptr && chunked != nullptr);
    assert(whole->prepare(8000U) && chunked->prepare(8000U));
    for (auto* processor : {whole.get(), chunked.get()}) {
        assert(processor->setParameter("pattern", 6.0f, 1U));
        assert(processor->setParameter("rate", 0.5f, 1U));
        assert(processor->setParameter("depth", 80.0f, 1U));
        assert(processor->setParameter("edge_ms", 1.0f, 1U));
        assert(processor->setParameter("bpm", 91.0f, 1U));
    }
    std::vector<float> wholeSignal(4096U, 0.75f);
    auto chunkedSignal = wholeSignal;
    (void)whole->processInPlace(wholeSignal.data(), static_cast<unsigned int>(wholeSignal.size()), 1U);
    std::size_t processed = 0U;
    while (processed < chunkedSignal.size()) {
        const unsigned int frames = static_cast<unsigned int>(std::min<std::size_t>(113U, chunkedSignal.size() - processed));
        (void)chunked->processInPlace(chunkedSignal.data() + processed, frames, 1U);
        processed += frames;
    }
    for (std::size_t index = 0U; index < wholeSignal.size(); ++index) {
        expectNear(chunkedSignal[index], wholeSignal[index], 1.0e-6f);
    }
}

void testStepSlicerEditableSequenceTempoPanFilterAndChunking() {
    const auto* descriptor = findNativeEffectDescriptor("step_slicer");
    assert(descriptor != nullptr && descriptor->sourceIndex == 35);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(descriptor->parameterCount == 22U);
    const auto* stepCount = findNativeEffectParameter("step_slicer", "step_count");
    const auto* rate = findNativeEffectParameter("step_slicer", "rate_beats");
    const auto* bpm = findNativeEffectParameter("step_slicer", "bpm");
    const auto* depth = findNativeEffectParameter("step_slicer", "depth_percent");
    const auto* pan = findNativeEffectParameter("step_slicer", "pan_depth_percent");
    const auto* filter = findNativeEffectParameter("step_slicer", "filter_hz");
    assert(stepCount != nullptr && stepCount->discrete && stepCount->discreteValueCount == 3U);
    assert(rate != nullptr && rate->discrete && rate->discreteValueCount == 5U);
    assert(bpm != nullptr && bpm->minimum == 30.0f && bpm->maximum == 300.0f);
    assert(depth != nullptr && depth->minimum == 0.0f && depth->maximum == 100.0f);
    assert(pan != nullptr && pan->minimum == 0.0f && pan->maximum == 100.0f);
    assert(filter != nullptr && filter->minimum == 20.0f && filter->maximum == 20000.0f);
    const auto* firstStep = findNativeEffectParameter("step_slicer", "step_01");
    const auto* lastStep = findNativeEffectParameter("step_slicer", "step_16");
    assert(firstStep != nullptr && firstStep->minimum == 0.0f && firstStep->maximum == 100.0f &&
        firstStep->defaultValue == 100.0f);
    assert(lastStep != nullptr && lastStep->minimum == 0.0f && lastStep->maximum == 100.0f &&
        lastStep->defaultValue == 100.0f);

    auto slicer = createNativeEffectProcessor("step_slicer");
    assert(slicer != nullptr && slicer->stableId() == "step_slicer" && slicer->prepare(8000U));
    assert(!slicer->setParameter("step_count", 12.0f, 1U));
    assert(!slicer->setParameter("rate_beats", 0.75f, 1U));
    assert(!slicer->setParameter("bpm", 300.1f, 1U));
    assert(!slicer->setParameter("depth_percent", 100.1f, 1U));
    assert(!slicer->setParameter("pan_depth_percent", -0.1f, 1U));
    assert(!slicer->setParameter("filter_hz", 19.99f, 1U));
    assert(!slicer->setParameter("step_01", 100.1f, 1U));
    assert(!slicer->setParameter("step_17", 0.0f, 1U));
    assert(slicer->setParameter("step_count", 4.0f, 1U));
    assert(slicer->setParameter("rate_beats", 0.25f, 1U));
    assert(slicer->setParameter("bpm", 120.0f, 1U));
    assert(slicer->setParameter("depth_percent", 100.0f, 1U));
    assert(slicer->setParameter("pan_depth_percent", 0.0f, 1U));
    assert(slicer->setParameter("filter_hz", 20000.0f, 1U));
    assert(slicer->setParameter("step_01", 100.0f, 1U));
    assert(slicer->setParameter("step_02", 0.0f, 1U));
    assert(slicer->setParameter("step_03", 100.0f, 1U));
    assert(slicer->setParameter("step_04", 0.0f, 1U));

    // At 8 kHz, 120 BPM, and a quarter-beat step, each step lasts exactly
    // 1,000 samples. The editable second step fades from full to silent over
    // the fixed 2 ms raised-cosine boundary.
    std::vector<float> tempoProbe(2020U, 1.0f);
    const std::size_t before = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)slicer->processInPlace(tempoProbe.data(), static_cast<unsigned int>(tempoProbe.size()), 1U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == before);
    expectNear(tempoProbe[500U], 1.0f, 0.01f);
    expectNear(tempoProbe[1000U], 1.0f, 0.02f);
    expectNear(tempoProbe[1008U], 0.5f, 0.03f);
    expectNear(tempoProbe[1016U], 0.0f);

    auto panSlicer = createNativeEffectProcessor("step_slicer");
    assert(panSlicer != nullptr && panSlicer->prepare(8000U));
    assert(panSlicer->setParameter("step_count", 4.0f, 1U));
    assert(panSlicer->setParameter("rate_beats", 0.25f, 1U));
    assert(panSlicer->setParameter("bpm", 120.0f, 1U));
    assert(panSlicer->setParameter("depth_percent", 0.0f, 1U));
    assert(panSlicer->setParameter("pan_depth_percent", 100.0f, 1U));
    assert(panSlicer->setParameter("filter_hz", 20000.0f, 1U));
    std::vector<float> stereoPan(1032U * 2U, 1.0f);
    (void)panSlicer->processInPlace(stereoPan.data(), 1032U, 2U);
    expectNear(stereoPan[32U], 1.0f, 0.01f);
    expectNear(stereoPan[33U], 0.0f);
    expectNear(stereoPan[1016U * 2U], 0.0f);
    expectNear(stereoPan[1016U * 2U + 1U], 1.0f, 0.01f);

    auto filtered = createNativeEffectProcessor("step_slicer");
    auto bright = createNativeEffectProcessor("step_slicer");
    assert(filtered != nullptr && bright != nullptr);
    assert(filtered->prepare(48000U) && bright->prepare(48000U));
    for (auto* processor : {filtered.get(), bright.get()}) {
        assert(processor->setParameter("step_count", 4.0f, 1U));
        assert(processor->setParameter("rate_beats", 0.25f, 1U));
        assert(processor->setParameter("bpm", 120.0f, 1U));
        assert(processor->setParameter("depth_percent", 0.0f, 1U));
        assert(processor->setParameter("pan_depth_percent", 0.0f, 1U));
    }
    assert(filtered->setParameter("filter_hz", 500.0f, 1U));
    assert(bright->setParameter("filter_hz", 20000.0f, 1U));
    constexpr unsigned int filterFrames = 24000U;
    std::vector<float> lowpassProbe(filterFrames);
    std::vector<float> openProbe(filterFrames);
    for (unsigned int frame = 0U; frame < filterFrames; ++frame) {
        const float sample = std::sin(2.0f * 3.14159265358979323846f * 4400.0f *
            static_cast<float>(frame) / 48000.0f);
        lowpassProbe[frame] = sample;
        openProbe[frame] = sample;
    }
    (void)filtered->processInPlace(lowpassProbe.data(), filterFrames, 1U);
    (void)bright->processInPlace(openProbe.data(), filterFrames, 1U);
    double lowRms = 0.0;
    double openRms = 0.0;
    for (unsigned int frame = 6000U; frame < filterFrames; ++frame) {
        lowRms += static_cast<double>(lowpassProbe[frame]) * lowpassProbe[frame];
        openRms += static_cast<double>(openProbe[frame]) * openProbe[frame];
    }
    lowRms = std::sqrt(lowRms / static_cast<double>(filterFrames - 6000U));
    openRms = std::sqrt(openRms / static_cast<double>(filterFrames - 6000U));
    assert(lowRms > 0.0 && lowRms < openRms * 0.25);

    auto whole = createNativeEffectProcessor("step_slicer");
    auto chunked = createNativeEffectProcessor("step_slicer");
    assert(whole != nullptr && chunked != nullptr);
    assert(whole->prepare(48000U) && chunked->prepare(48000U));
    for (auto* processor : {whole.get(), chunked.get()}) {
        assert(processor->setParameter("step_count", 16.0f, 1U));
        assert(processor->setParameter("rate_beats", 0.5f, 1U));
        assert(processor->setParameter("bpm", 91.0f, 1U));
        assert(processor->setParameter("depth_percent", 83.0f, 1U));
        assert(processor->setParameter("pan_depth_percent", 68.0f, 1U));
        assert(processor->setParameter("filter_hz", 7000.0f, 1U));
        assert(processor->setParameter("step_01", 100.0f, 1U));
        assert(processor->setParameter("step_02", 25.0f, 1U));
        assert(processor->setParameter("step_07", 0.0f, 1U));
        assert(processor->setParameter("step_16", 70.0f, 1U));
    }
    constexpr unsigned int variableFrames = 12037U;
    std::vector<float> wholeSignal(static_cast<std::size_t>(variableFrames) * 2U);
    std::vector<float> splitSignal(wholeSignal.size());
    for (unsigned int frame = 0U; frame < variableFrames; ++frame) {
        const float left = 0.6f * std::sin(static_cast<float>(frame) * 0.031f);
        const float right = 0.4f * std::cos(static_cast<float>(frame) * 0.023f);
        wholeSignal[static_cast<std::size_t>(frame) * 2U] = left;
        wholeSignal[static_cast<std::size_t>(frame) * 2U + 1U] = right;
        splitSignal[static_cast<std::size_t>(frame) * 2U] = left;
        splitSignal[static_cast<std::size_t>(frame) * 2U + 1U] = right;
    }
    (void)whole->processInPlace(wholeSignal.data(), variableFrames, 2U);
    constexpr std::array<unsigned int, 7U> blockPattern{{1U, 17U, 127U, 3U, 511U, 64U, 29U}};
    unsigned int processed = 0U;
    std::size_t block = 0U;
    while (processed < variableFrames) {
        const unsigned int count = std::min(blockPattern[block % blockPattern.size()], variableFrames - processed);
        (void)chunked->processInPlace(splitSignal.data() + static_cast<std::size_t>(processed) * 2U, count, 2U);
        processed += count;
        ++block;
    }
    for (std::size_t index = 0U; index < wholeSignal.size(); ++index) {
        expectNear(splitSignal[index], wholeSignal[index], 1.0e-6f);
    }

    NativeEffectBank bank;
    assert(bank.setEffect(NativeEffectSlot::A, "step_slicer"));
    assert(bank.setParameter(NativeEffectSlot::A, "step_count", 16.0f, 1U));
    assert(bank.setParameter(NativeEffectSlot::A, "rate_beats", 0.25f, 1U));
    assert(bank.setParameter(NativeEffectSlot::A, "step_02", 0.0f, 1U));
    assert(bank.prepare(48000U));
    std::vector<float> bankSignal(256U * 2U, 0.25f);
    const std::size_t bankBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)bank.processInPlace(bankSignal.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == bankBefore);
}

void testGateReverbEnvelopeChunkingAndNoCallbackAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = sampleRate * 3U / 5U;
    NativeEffectBank oneBlock;
    NativeEffectBank splitBlocks;
    for (NativeEffectBank* bank : {&oneBlock, &splitBlocks}) {
        assert(bank->setEffect(NativeEffectSlot::A, "gate_reverb"));
        assert(bank->setParameter(NativeEffectSlot::A, "decay_seconds", 8.0f, 128U));
        assert(bank->setParameter(NativeEffectSlot::A, "damping_cutoff_hz", 20000.0f, 128U));
        assert(bank->setParameter(NativeEffectSlot::A, "wet_mix", 1.0f, 128U));
        assert(bank->setParameter(NativeEffectSlot::A, "threshold_db", -6.0f, 128U));
        assert(bank->setParameter(NativeEffectSlot::A, "hysteresis_db", 3.0f, 128U));
        assert(bank->setParameter(NativeEffectSlot::A, "hold_ms", 100.0f, 128U));
        assert(bank->setParameter(NativeEffectSlot::A, "release_ms", 30.0f, 128U));
        assert(bank->prepare(sampleRate));
    }

    std::vector<float> input(static_cast<std::size_t>(frames) * 2U, 0.0f);
    input[0] = 1.0f;
    input[1] = 0.7f;
    auto whole = input;
    auto chunked = input;
    const auto allocationCount = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)oneBlock.processInPlace(whole.data(), frames, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == allocationCount);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 17U, 257U, 31U, 1024U, 63U, 511U}};
    const auto chunkedAllocationCount = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    unsigned int rendered = 0U;
    std::size_t chunkIndex = 0U;
    while (rendered < frames) {
        const unsigned int count = std::min(chunks[chunkIndex % chunks.size()], frames - rendered);
        (void)splitBlocks.processInPlace(chunked.data() + static_cast<std::size_t>(rendered) * 2U, count, 2U);
        rendered += count;
        ++chunkIndex;
    }
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == chunkedAllocationCount);

    double heldTailEnergy = 0.0;
    double releasedTailEnergy = 0.0;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            const std::size_t index = static_cast<std::size_t>(frame) * 2U + channel;
            assert(std::isfinite(whole[index]) && std::fabs(whole[index]) <= 32.0f);
            assert(std::isfinite(chunked[index]) && std::fabs(chunked[index]) <= 32.0f);
            assert(std::fabs(whole[index] - chunked[index]) < 1.0e-6f);
            const double energy = static_cast<double>(whole[index]) * whole[index];
            if (frame >= sampleRate * 4U / 100U && frame < sampleRate * 9U / 100U) {
                heldTailEnergy += energy;
            }
            if (frame >= sampleRate / 2U && frame < sampleRate * 55U / 100U) {
                releasedTailEnergy += energy;
            }
        }
    }
    assert(heldTailEnergy > 1.0e-7);
    assert(releasedTailEnergy < 1.0e-14);

    // A below-threshold stereo-linked signal stays dry even as it traverses
    // arbitrary block sizes; the reverb sidechain cannot open on one quiet ear.
    NativeEffectProcessor* quietGate = oneBlock.processor(NativeEffectSlot::A);
    assert(quietGate != nullptr);
    quietGate->resetState();
    std::vector<float> quiet(4096U * 2U, 0.01f);
    (void)quietGate->processInPlace(quiet.data(), 4096U, 2U);
    for (std::size_t index = 0U; index < quiet.size(); ++index) assert(std::fabs(quiet[index] - 0.01f) < 1.0e-6f);
}

void testGateReverbThresholdHysteresis() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 5000U;
    auto hysteretic = createNativeEffectProcessor("gate_reverb");
    auto nonHysteretic = createNativeEffectProcessor("gate_reverb");
    assert(hysteretic != nullptr && nonHysteretic != nullptr);
    assert(hysteretic->prepare(sampleRate) && nonHysteretic->prepare(sampleRate));
    for (NativeEffectProcessor* effect : {hysteretic.get(), nonHysteretic.get()}) {
        assert(effect->setParameter("decay_seconds", 8.0f, 0U));
        assert(effect->setParameter("damping_cutoff_hz", 20000.0f, 0U));
        assert(effect->setParameter("wet_mix", 1.0f, 0U));
        assert(effect->setParameter("threshold_db", -6.0f, 0U));
        assert(effect->setParameter("hold_ms", 0.0f, 0U));
        assert(effect->setParameter("release_ms", 10.0f, 0U));
    }
    assert(hysteretic->setParameter("hysteresis_db", 3.0f, 0U));
    assert(nonHysteretic->setParameter("hysteresis_db", 0.0f, 0U));

    std::vector<float> hysteresisProbe(static_cast<std::size_t>(frames) * 2U, 0.4f);
    auto noHysteresisProbe = hysteresisProbe;
    hysteresisProbe[0] = noHysteresisProbe[0] = 1.0f;
    hysteresisProbe[1] = noHysteresisProbe[1] = 0.8f;
    (void)hysteretic->processInPlace(hysteresisProbe.data(), frames, 2U);
    (void)nonHysteretic->processInPlace(noHysteresisProbe.data(), frames, 2U);

    double hysteresisDifferenceEnergy = 0.0;
    for (unsigned int frame = 1500U; frame < frames; ++frame) {
        for (unsigned int channel = 0U; channel < 2U; ++channel) {
            const std::size_t index = static_cast<std::size_t>(frame) * 2U + channel;
            assert(std::isfinite(hysteresisProbe[index]) && std::isfinite(noHysteresisProbe[index]));
            const double difference = static_cast<double>(hysteresisProbe[index] - noHysteresisProbe[index]);
            hysteresisDifferenceEnergy += difference * difference;
        }
    }
    assert(hysteresisDifferenceEnergy > 0.01);
}

void testGranularDelaySignalSegmentationAndAllocation() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 12000U;
    auto whole = createNativeEffectProcessor("granular_delay");
    auto split = createNativeEffectProcessor("granular_delay");
    assert(whole && split);
    assert(whole->prepare(sampleRate) && split->prepare(sampleRate));
    for (auto* processor : {whole.get(), split.get()}) {
        assert(processor->setParameter("grain_size_ms", 40.0f, 1U));
        assert(processor->setParameter("density_hz", 24.0f, 1U));
        assert(processor->setParameter("pitch_semitones", 5.0f, 1U));
        assert(processor->setParameter("position_jitter_percent", 0.0f, 1U));
        assert(processor->setParameter("feedback_percent", 0.0f, 1U));
        assert(processor->setParameter("mix_percent", 100.0f, 1U));
    }

    std::vector<float> input(static_cast<std::size_t>(frames) * 2U, 0.0f);
    input[0U] = 1.0f;
    input[1U] = -0.5f;
    auto wholeOutput = input;
    auto splitOutput = input;
    const auto allocationCount = test_alloc::count();
    test_alloc::beginTracking();
    (void)whole->processInPlace(wholeOutput.data(), frames, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationCount);

    constexpr std::array<unsigned int, 7U> chunks{{1U, 17U, 64U, 3U, 127U, 8U, 31U}};
    unsigned int offset = 0U;
    std::size_t chunkIndex = 0U;
    while (offset < frames) {
        const unsigned int chunk = std::min(chunks[chunkIndex % chunks.size()], frames - offset);
        (void)split->processInPlace(splitOutput.data() + static_cast<std::size_t>(offset) * 2U, chunk, 2U);
        offset += chunk;
        ++chunkIndex;
    }

    double wetEnergy = 0.0;
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        expectNear(wholeOutput[index], splitOutput[index], 1.0e-6f);
        assert(std::isfinite(wholeOutput[index]));
        if (index >= 2U * 400U) wetEnergy += std::fabs(static_cast<double>(wholeOutput[index]));
    }
    assert(wetEnergy > 0.1);

    const auto resetAllocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    whole->resetState();
    test_alloc::endTracking();
    assert(test_alloc::count() == resetAllocationsBefore);
    std::vector<float> silence(2048U * 2U, 0.0f);
    (void)whole->processInPlace(silence.data(), 2048U, 2U);
    for (const float sample : silence) expectNear(sample, 0.0f, 1.0e-6f);
}

void testLoFiSampleHoldDitherFilterAndChunking() {
    auto whole = createNativeEffectProcessor("lo_fi");
    auto chunked = createNativeEffectProcessor("lo_fi");
    assert(whole && chunked && whole->prepare(48000U) && chunked->prepare(48000U));
    for (auto* effect : {whole.get(), chunked.get()}) {
        assert(effect->setParameter("bit_depth", 4.0f, 1U));
        assert(effect->setParameter("sample_rate_hz", 12000.0f, 1U));
        assert(effect->setParameter("mix_percent", 100.0f, 1U));
    }

    std::array<float, 12U> probe{{0.2f, 0.9f, -0.4f, 0.6f, 0.7f, -0.9f, 0.1f, -0.2f, 0.3f, 0.8f, -0.1f, 0.5f}};
    const double alpha = 1.0 - std::exp(-2.0 * 3.14159265358979323846 * 12000.0 / 48000.0);
    dsp::DeterministicRng expectedRandom;
    expectedRandom.seed(0x9e3779b97f4a7c15ULL);
    const auto quantized = [&expectedRandom](float input) {
        constexpr double inverseRngRange = 1.0 / 4294967296.0;
        const double dither = static_cast<double>(expectedRandom.nextUInt32()) * inverseRngRange -
            static_cast<double>(expectedRandom.nextUInt32()) * inverseRngRange;
        return static_cast<float>(std::clamp(std::round(static_cast<double>(input) * 8.0 + dither) / 8.0, -1.0, 1.0));
    };
    const float firstHeld = quantized(probe[0]);
    const float secondHeld = quantized(probe[8]);
    std::array<float, 5U> expected{};
    for (std::size_t frame = 0U; frame < expected.size(); ++frame) {
        const double held = frame < 4U ? static_cast<double>(firstHeld) : static_cast<double>(secondHeld);
        const double previous = frame == 0U ? 0.0 : static_cast<double>(expected[frame - 1U]);
        expected[frame] = static_cast<float>(previous + alpha * (held - previous));
    }
    (void)whole->processInPlace(probe.data(), 6U, 2U);
    for (std::size_t frame = 0U; frame < expected.size(); ++frame) {
        expectNear(probe[frame * 2U], expected[frame], 1.0e-5f);
    }

    whole->resetState();
    chunked->resetState();
    std::array<float, 514U> input{};
    for (std::size_t index = 0U; index < input.size(); ++index) {
        input[index] = 0.7f * std::sin(static_cast<float>(index) * 0.061f);
    }
    std::array<float, 514U> outputA = input;
    std::array<float, 514U> outputB = input;
    const std::size_t before = test_alloc::count();
    test_alloc::beginTracking();
    (void)whole->processInPlace(outputA.data(), 257U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == before);
    constexpr std::array<unsigned int, 6U> chunks{{1U, 17U, 63U, 64U, 31U, 81U}};
    unsigned int frameOffset = 0U;
    for (const unsigned int frames : chunks) {
        (void)chunked->processInPlace(outputB.data() + static_cast<std::size_t>(frameOffset) * 2U, frames, 2U);
        frameOffset += frames;
    }
    assert(frameOffset == 257U);
    for (std::size_t index = 0U; index < outputA.size(); ++index) {
        assert(std::isfinite(outputA[index]));
        assert(outputA[index] == outputB[index]);
    }
}

float measureEqualizerTone(
    float frequencyHz,
    std::initializer_list<std::pair<std::string_view, float>> parameters = {}
) {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 48000U;
    constexpr unsigned int skipFrames = frames / 2U;
    auto equalizer = createNativeEffectProcessor("eq");
    assert(equalizer && equalizer->prepare(sampleRate));
    for (const auto& parameter : parameters) {
        assert(equalizer->setParameter(parameter.first, parameter.second, 1U));
    }

    std::vector<float> tone(frames);
    constexpr double kPi = 3.14159265358979323846;
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        tone[frame] = 0.5f * static_cast<float>(std::sin(
            2.0 * kPi * static_cast<double>(frequencyHz) * static_cast<double>(frame) /
            static_cast<double>(sampleRate)
        ));
    }
    (void)equalizer->processInPlace(tone.data(), frames, 1U);
    double squareSum = 0.0;
    for (unsigned int frame = skipFrames; frame < frames; ++frame) {
        const double sample = tone[frame];
        assert(std::isfinite(sample));
        squareSum += sample * sample;
    }
    return static_cast<float>(std::sqrt(squareSum / static_cast<double>(frames - skipFrames)));
}

void testEqualizerNeutralitySectionsAndFrequencyControls() {
    constexpr unsigned int frames = 4096U;
    auto equalizer = createNativeEffectProcessor("eq");
    assert(equalizer && equalizer->prepare(48000U));
    std::array<float, frames * 2U> stereo{};
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float position = static_cast<float>(frame);
        stereo[static_cast<std::size_t>(frame) * 2U] = 0.4f * std::sin(position * 0.071f);
        stereo[static_cast<std::size_t>(frame) * 2U + 1U] = 0.3f * std::cos(position * 0.053f);
    }
    const auto dry = stereo;
    (void)equalizer->processInPlace(stereo.data(), frames, 2U);
    for (std::size_t index = 0U; index < stereo.size(); ++index) {
        expectNear(stereo[index], dry[index], 2.0e-5f);
    }

    struct BandControl final {
        std::string_view frequencyParameter;
        std::string_view gainParameter;
        float frequencyHz;
        float probeHz;
    };
    constexpr std::array<BandControl, 4U> bands{{
        {"low_frequency_hz", "low_gain_db", 300.0f, 80.0f},
        {"mid1_frequency_hz", "mid1_gain_db", 1300.0f, 1300.0f},
        {"mid2_frequency_hz", "mid2_gain_db", 6000.0f, 6000.0f},
        {"high_frequency_hz", "high_gain_db", 4000.0f, 14000.0f},
    }};
    for (const auto& band : bands) {
        const float boosted = measureEqualizerTone(band.probeHz, {
            {band.frequencyParameter, band.frequencyHz}, {band.gainParameter, 9.0f}
        });
        const float cut = measureEqualizerTone(band.probeHz, {
            {band.frequencyParameter, band.frequencyHz}, {band.gainParameter, -9.0f}
        });
        assert(boosted > cut * 1.8f);
    }

    // Moving each of the four section frequencies changes its response at a
    // fixed probe tone, including both shelving corners and both peak centers.
    const float lowAt100 = measureEqualizerTone(120.0f, {{"low_frequency_hz", 100.0f}, {"low_gain_db", 12.0f}});
    const float lowAt400 = measureEqualizerTone(120.0f, {{"low_frequency_hz", 400.0f}, {"low_gain_db", 12.0f}});
    assert(std::fabs(lowAt100 - lowAt400) > 0.03f);
    const float mid1At500 = measureEqualizerTone(500.0f, {{"mid1_frequency_hz", 500.0f}, {"mid1_gain_db", 12.0f}});
    const float mid1At1500 = measureEqualizerTone(500.0f, {{"mid1_frequency_hz", 1500.0f}, {"mid1_gain_db", 12.0f}});
    assert(std::fabs(mid1At500 - mid1At1500) > 0.05f);
    const float mid2At2500 = measureEqualizerTone(2500.0f, {{"mid2_frequency_hz", 2500.0f}, {"mid2_gain_db", 12.0f}});
    const float mid2At7500 = measureEqualizerTone(2500.0f, {{"mid2_frequency_hz", 7500.0f}, {"mid2_gain_db", 12.0f}});
    assert(std::fabs(mid2At2500 - mid2At7500) > 0.05f);
    const float highAt4000 = measureEqualizerTone(6000.0f, {{"high_frequency_hz", 4000.0f}, {"high_gain_db", 12.0f}});
    const float highAt12000 = measureEqualizerTone(6000.0f, {{"high_frequency_hz", 12000.0f}, {"high_gain_db", 12.0f}});
    assert(std::fabs(highAt4000 - highAt12000) > 0.03f);

    const float broadPeak = measureEqualizerTone(1000.0f, {
        {"mid1_frequency_hz", 500.0f}, {"mid1_q", 0.5f}, {"mid1_gain_db", 12.0f}
    });
    const float narrowPeak = measureEqualizerTone(1000.0f, {
        {"mid1_frequency_hz", 500.0f}, {"mid1_q", 8.0f}, {"mid1_gain_db", 12.0f}
    });
    assert(broadPeak > narrowPeak * 1.1f);
    const float broadSecondPeak = measureEqualizerTone(6000.0f, {
        {"mid2_frequency_hz", 4000.0f}, {"mid2_q", 0.5f}, {"mid2_gain_db", 12.0f}
    });
    const float narrowSecondPeak = measureEqualizerTone(6000.0f, {
        {"mid2_frequency_hz", 4000.0f}, {"mid2_q", 8.0f}, {"mid2_gain_db", 12.0f}
    });
    assert(broadSecondPeak > narrowSecondPeak * 1.1f);
}

void testEqualizerSmoothingChunkingResetBypassAndPlaybackChain() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int totalFrames = 4096U;
    constexpr unsigned int changeAt = 13U;
    auto whole = createNativeEffectProcessor("eq");
    auto split = createNativeEffectProcessor("eq");
    auto unchanged = createNativeEffectProcessor("eq");
    assert(whole && split && unchanged);
    assert(whole->prepare(sampleRate) && split->prepare(sampleRate) && unchanged->prepare(sampleRate));
    for (auto* processor : {whole.get(), split.get(), unchanged.get()}) {
        assert(processor->setParameter("mid1_gain_db", 4.0f, 1U));
    }

    std::vector<float> input(static_cast<std::size_t>(totalFrames) * 2U);
    for (unsigned int frame = 0U; frame < totalFrames; ++frame) {
        const float n = static_cast<float>(frame);
        input[static_cast<std::size_t>(frame) * 2U] = 0.3f * std::sin(n * 0.13f);
        input[static_cast<std::size_t>(frame) * 2U + 1U] = 0.27f * std::cos(n * 0.19f);
    }
    auto wholeOutput = input;
    auto splitOutput = input;
    auto unchangedOutput = input;
    (void)whole->processInPlace(wholeOutput.data(), changeAt, 2U);
    (void)split->processInPlace(splitOutput.data(), changeAt, 2U);
    (void)unchanged->processInPlace(unchangedOutput.data(), changeAt, 2U);
    for (auto* processor : {whole.get(), split.get()}) {
        assert(processor->setParameter("low_frequency_hz", 330.0f, 211U));
        assert(processor->setParameter("mid1_frequency_hz", 1200.0f, 211U));
        assert(processor->setParameter("mid1_gain_db", 12.0f, 211U));
        assert(processor->setParameter("mid1_q", 3.0f, 211U));
        assert(processor->setParameter("high_gain_db", -6.0f, 211U));
    }
    const unsigned int remaining = totalFrames - changeAt;
    (void)whole->processInPlace(wholeOutput.data() + static_cast<std::size_t>(changeAt) * 2U, remaining, 2U);
    (void)unchanged->processInPlace(unchangedOutput.data() + static_cast<std::size_t>(changeAt) * 2U, remaining, 2U);
    constexpr std::array<unsigned int, 7U> chunks{{1U, 3U, 5U, 7U, 13U, 2U, 19U}};
    unsigned int processed = 0U;
    std::size_t chunkIndex = 0U;
    while (processed < remaining) {
        const unsigned int chunk = std::min(chunks[chunkIndex % chunks.size()], remaining - processed);
        (void)split->processInPlace(
            splitOutput.data() + static_cast<std::size_t>(changeAt + processed) * 2U, chunk, 2U
        );
        processed += chunk;
        ++chunkIndex;
    }
    double changedEnergy = 0.0;
    double unchangedEnergy = 0.0;
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        expectNear(wholeOutput[index], splitOutput[index], 1.0e-7f);
        const double difference = static_cast<double>(wholeOutput[index]) - unchangedOutput[index];
        changedEnergy += difference * difference;
        unchangedEnergy += static_cast<double>(unchangedOutput[index]) * unchangedOutput[index];
    }
    assert(changedEnergy > unchangedEnergy * 1.0e-4);

    // Reset restores the smoothed target values and filter states, so replay
    // is deterministic and equivalent to a fresh processor with those targets.
    whole->resetState();
    auto replay = input;
    auto fresh = createNativeEffectProcessor("eq");
    assert(fresh && fresh->prepare(sampleRate));
    assert(fresh->setParameter("low_frequency_hz", 330.0f, 1U));
    assert(fresh->setParameter("mid1_frequency_hz", 1200.0f, 1U));
    assert(fresh->setParameter("mid1_gain_db", 12.0f, 1U));
    assert(fresh->setParameter("mid1_q", 3.0f, 1U));
    assert(fresh->setParameter("high_gain_db", -6.0f, 1U));
    (void)whole->processInPlace(replay.data(), totalFrames, 2U);
    auto freshReplay = input;
    (void)fresh->processInPlace(freshReplay.data(), totalFrames, 2U);
    for (std::size_t index = 0U; index < replay.size(); ++index) {
        expectNear(replay[index], freshReplay[index], 1.0e-7f);
    }

    whole->setBypassed(true, 1U);
    auto bypassInput = input;
    (void)whole->processInPlace(bypassInput.data(), 64U, 2U);
    for (std::size_t index = 0U; index < 128U; ++index) {
        expectNear(bypassInput[index], input[index]);
    }

    NativeEffectBank bank;
    assert(bank.prepare(sampleRate));
    assert(bank.setEffect(NativeEffectSlot::A, "eq"));
    assert(bank.setEffect(NativeEffectSlot::D, "eq"));
    assert(bank.effectId(NativeEffectSlot::A) == "eq");
    assert(bank.effectId(NativeEffectSlot::D) == "eq");
    assert(bank.setParameter(NativeEffectSlot::A, "low_gain_db", 7.0f, 1U));
    assert(bank.setParameter(NativeEffectSlot::D, "mid2_gain_db", -5.0f, 1U));

    auto firstStandalone = createNativeEffectProcessor("eq");
    auto lastStandalone = createNativeEffectProcessor("eq");
    assert(firstStandalone && firstStandalone->prepare(sampleRate));
    assert(lastStandalone && lastStandalone->prepare(sampleRate));
    assert(firstStandalone->setParameter("low_gain_db", 7.0f, 1U));
    assert(lastStandalone->setParameter("mid2_gain_db", -5.0f, 1U));
    auto chainOutput = input;
    auto manualOutput = input;
    (void)bank.processInPlace(chainOutput.data(), 128U, 2U);
    (void)firstStandalone->processInPlace(manualOutput.data(), 128U, 2U);
    (void)lastStandalone->processInPlace(manualOutput.data(), 128U, 2U);
    for (std::size_t index = 0U; index < 256U; ++index) expectNear(chainOutput[index], manualOutput[index], 1.0e-7f);
}

void testRingModCarrierCoherenceResetAndBypass() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 96U;
    auto ringMod = createNativeEffectProcessor("ring_mod");
    assert(ringMod && ringMod->prepare(sampleRate));
    assert(ringMod->setParameter("carrier_hz", 1000.0f, 1U));
    assert(ringMod->setParameter("depth", 1.0f, 1U));
    assert(ringMod->setParameter("wet_mix", 1.0f, 1U));

    std::array<float, frames * 2U> stereo{};
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        stereo[static_cast<std::size_t>(frame) * 2U] = 1.0f;
        stereo[static_cast<std::size_t>(frame) * 2U + 1U] = 0.5f;
    }
    const auto original = stereo;
    (void)ringMod->processInPlace(stereo.data(), frames, 2U);
    expectNear(stereo[12U * 2U], 1.0f, 1.0e-5f);
    expectNear(stereo[36U * 2U], -1.0f, 1.0e-5f);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float left = stereo[static_cast<std::size_t>(frame) * 2U];
        const float right = stereo[static_cast<std::size_t>(frame) * 2U + 1U];
        expectNear(right, left * 0.5f, 1.0e-6f); // shared phase accumulator keeps stereo coherent.
    }

    ringMod->resetState();
    stereo = original;
    (void)ringMod->processInPlace(stereo.data(), frames, 2U);
    expectNear(stereo[12U * 2U], 1.0f, 1.0e-5f);
    expectNear(stereo[36U * 2U], -1.0f, 1.0e-5f);

    ringMod->setBypassed(true, 1U);
    stereo = original;
    (void)ringMod->processInPlace(stereo.data(), frames, 2U);
    for (std::size_t index = 0U; index < stereo.size(); ++index) expectNear(stereo[index], original[index]);
}

void testRingModArbitraryBlockSegmentationAndResponse() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 4096U;
    constexpr unsigned int changeAt = 17U;
    auto wholeTail = createNativeEffectProcessor("ring_mod");
    auto splitTail = createNativeEffectProcessor("ring_mod");
    auto fixedCarrier = createNativeEffectProcessor("ring_mod");
    assert(wholeTail && splitTail && fixedCarrier);
    assert(wholeTail->prepare(sampleRate));
    assert(splitTail->prepare(sampleRate));
    assert(fixedCarrier->prepare(sampleRate));
    for (auto* effect : {wholeTail.get(), splitTail.get(), fixedCarrier.get()}) {
        assert(effect->setParameter("carrier_hz", 440.0f, 1U));
        assert(effect->setParameter("depth", 1.0f, 1U));
        assert(effect->setParameter("wet_mix", 1.0f, 1U));
    }

    std::vector<float> input(frames, 1.0f);
    auto wholeOutput = input;
    auto splitOutput = input;
    auto fixedOutput = input;
    (void)wholeTail->processInPlace(wholeOutput.data(), changeAt, 1U);
    (void)splitTail->processInPlace(splitOutput.data(), changeAt, 1U);
    (void)fixedCarrier->processInPlace(fixedOutput.data(), changeAt, 1U);
    assert(wholeTail->setParameter("carrier_hz", 1700.0f, 120U));
    assert(splitTail->setParameter("carrier_hz", 1700.0f, 120U));
    const unsigned int remainder = frames - changeAt;
    (void)wholeTail->processInPlace(wholeOutput.data() + changeAt, remainder, 1U);
    (void)fixedCarrier->processInPlace(fixedOutput.data() + changeAt, remainder, 1U);

    constexpr std::array<unsigned int, 8U> chunks{{1U, 7U, 2U, 31U, 3U, 64U, 5U, 11U}};
    unsigned int processed = 0U;
    std::size_t chunkIndex = 0U;
    while (processed < remainder) {
        const unsigned int chunk = std::min(chunks[chunkIndex % chunks.size()], remainder - processed);
        (void)splitTail->processInPlace(splitOutput.data() + changeAt + processed, chunk, 1U);
        processed += chunk;
        ++chunkIndex;
    }

    double changedVsFixed = 0.0;
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        expectNear(wholeOutput[index], splitOutput[index], 1.0e-7f);
        if (index >= changeAt) {
            changedVsFixed += std::fabs(static_cast<double>(wholeOutput[index]) - fixedOutput[index]);
        }
    }
    assert(changedVsFixed > 100.0);
}

void testChorusEchoAndReset() {
    auto chorus = createNativeEffectProcessor("chorus");
    assert(chorus && chorus->prepare(48000U));
    assert(chorus->setParameter("rate_hz", 0.1f, 1U));
    assert(chorus->setParameter("depth_ms", 0.0f, 1U));
    assert(chorus->setParameter("feedback", 0.0f, 1U));
    assert(chorus->setParameter("wet_mix", 1.0f, 1U));

    constexpr unsigned int frames = 2000U;
    std::vector<float> impulse(frames, 0.0f);
    impulse[0] = 1.0f;
    (void)chorus->processInPlace(impulse.data(), frames, 1U);
    assert(std::fabs(impulse[1440U]) > 0.95f); // 30 ms center delay at 48 kHz.
    for (unsigned int frame = 0U; frame < 1400U; ++frame) expectNear(impulse[frame], 0.0f, 1.0e-6f);

    chorus->resetState();
    std::vector<float> silence(frames, 0.0f);
    (void)chorus->processInPlace(silence.data(), frames, 1U);
    for (const float sample : silence) expectNear(sample, 0.0f, 1.0e-6f);
}

void testTremoloWaveformsAndBypass() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = sampleRate;
    std::array<std::vector<float>, 3U> outputs{};
    for (unsigned int shape = 0U; shape < 3U; ++shape) {
        auto tremolo = createNativeEffectProcessor("tremolo");
        assert(tremolo && tremolo->prepare(sampleRate));
        configureTremolo(*tremolo, static_cast<float>(shape));
        outputs[shape].assign(frames, 1.0f);
        const float peak = tremolo->processInPlace(outputs[shape].data(), frames, 1U);
        assert(std::isfinite(peak) && peak <= 1.0f && peak > 0.99f);
        const auto [minimum, maximum] = std::minmax_element(outputs[shape].begin(), outputs[shape].end());
        assert(*minimum < 1.0e-4f && *maximum > 0.99f);
        for (const float sample : outputs[shape]) assert(std::isfinite(sample));
    }
    for (unsigned int lhs = 0U; lhs < 3U; ++lhs) {
        for (unsigned int rhs = lhs + 1U; rhs < 3U; ++rhs) {
            double difference = 0.0;
            for (std::size_t index = 0U; index < outputs[lhs].size(); ++index) {
                difference += std::fabs(static_cast<double>(outputs[lhs][index]) - outputs[rhs][index]);
            }
            assert(difference > 100.0);
        }
    }

    auto bypass = createNativeEffectProcessor("tremolo");
    assert(bypass && bypass->prepare(sampleRate));
    configureTremolo(*bypass, 2.0f);
    bypass->setBypassed(true, 1U);
    std::array<float, 16U> passthrough{{
        0.5f, -0.4f, 0.2f, -0.1f, 0.8f, -0.7f, 0.0f, 0.1f,
        0.3f, 0.2f, -0.3f, 0.6f, -0.9f, 0.25f, 0.12f, -0.42f
    }};
    const auto before = passthrough;
    (void)bypass->processInPlace(passthrough.data(), 8U, 2U);
    for (std::size_t index = 0U; index < passthrough.size(); ++index) expectNear(passthrough[index], before[index]);
}

void testTremoloParameterSmoothing() {
    constexpr unsigned int sampleRate = 48000U;
    auto tremolo = createNativeEffectProcessor("tremolo");
    assert(tremolo && tremolo->prepare(sampleRate));
    assert(tremolo->setParameter("rate_hz", 1.0f, 1U));
    assert(tremolo->setParameter("depth", 0.0f, 1U));
    assert(tremolo->setParameter("waveform", 2.0f, 1U));
    assert(tremolo->setParameter("wet_mix", 1.0f, 1U));

    std::vector<float> beforeTarget(sampleRate / 2U, 1.0f);
    (void)tremolo->processInPlace(beforeTarget.data(), static_cast<unsigned int>(beforeTarget.size()), 1U);
    // At the square-wave peak the modulation is now held high for half a cycle.
    std::vector<float> ramped(960U, 1.0f);
    assert(tremolo->setParameter("depth", 1.0f)); // 20 ms metadata ramp = 960 frames.
    (void)tremolo->processInPlace(ramped.data(), static_cast<unsigned int>(ramped.size()), 1U);
    assert(ramped.front() > 0.99f);
    assert(ramped[479U] > 0.45f && ramped[479U] < 0.55f);
    assert(ramped.back() < 1.0e-4f);
    for (std::size_t index = 1U; index < ramped.size(); ++index) {
        assert(ramped[index] <= ramped[index - 1U] + 1.0e-5f);
    }
}

void testWorkingFiltersAndPhaser() {
    std::array<std::array<float, 2U>, 3U> firstSamples{};
    const std::array<std::string_view, 3U> ids{{"filter.lpf", "filter.bpf", "filter.hpf"}};
    for (std::size_t index = 0U; index < ids.size(); ++index) {
        auto effect = createNativeEffectProcessor(ids[index]);
        assert(effect && effect->prepare(48000U));
        assert(effect->setParameter("cutoff_hz", 1000.0f, 1U));
        assert(effect->setParameter("q", 0.70710678f, 1U));
        std::array<float, 8U> impulse{{1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f}};
        const auto peak = effect->processInPlace(impulse.data(), 8U, 1U);
        assert(std::isfinite(peak) && peak > 0.0f);
        firstSamples[index] = {{impulse[0], impulse[1]}};
        for (const float sample : impulse) assert(std::isfinite(sample));
    }
    assert(std::fabs(firstSamples[0][0] - firstSamples[1][0]) > 1.0e-3f);
    assert(std::fabs(firstSamples[1][0] - firstSamples[2][0]) > 1.0e-3f);
    assert(std::fabs(firstSamples[0][0] - firstSamples[2][0]) > 1.0e-3f);

    auto phaser = createNativeEffectProcessor("phaser");
    assert(phaser && phaser->prepare(48000U));
    assert(phaser->setParameter("wet_mix", 1.0f, 1U));
    std::array<float, 16U> impulse{{1.0f}};
    (void)phaser->processInPlace(impulse.data(), 16U, 1U);
    assert(std::fabs(impulse[0] - 1.0f) > 1.0e-3f);
    for (const float sample : impulse) assert(std::isfinite(sample));
}

void testFilterControlRateSegmentationAndResponse() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int totalFrames = 4096U;
    constexpr unsigned int changeAtFrame = 13U;
    constexpr unsigned int rampFrames = 96U;

    auto oneBlock = createNativeEffectProcessor("filter.lpf");
    auto irregularBlocks = createNativeEffectProcessor("filter.lpf");
    auto unchangedReference = createNativeEffectProcessor("filter.lpf");
    assert(oneBlock && irregularBlocks && unchangedReference);
    assert(oneBlock->prepare(sampleRate));
    assert(irregularBlocks->prepare(sampleRate));
    assert(unchangedReference->prepare(sampleRate));
    for (auto* filter : {oneBlock.get(), irregularBlocks.get(), unchangedReference.get()}) {
        assert(filter->setParameter("cutoff_hz", 500.0f, 1U));
        assert(filter->setParameter("q", 0.70710678f, 1U));
    }

    std::vector<float> input(totalFrames, 0.0f);
    for (unsigned int frame = 0U; frame < totalFrames; ++frame) {
        input[frame] = 0.4f * std::sin(2.0f * 3.14159265358979323846f * 6000.0f *
                                       static_cast<float>(frame) / static_cast<float>(sampleRate));
    }
    auto oneBlockOutput = input;
    auto irregularOutput = input;
    auto referenceOutput = input;

    (void)oneBlock->processInPlace(oneBlockOutput.data(), changeAtFrame, 1U);
    (void)irregularBlocks->processInPlace(irregularOutput.data(), changeAtFrame, 1U);
    (void)unchangedReference->processInPlace(referenceOutput.data(), changeAtFrame, 1U);
    assert(oneBlock->setParameter("cutoff_hz", 9000.0f, rampFrames));
    assert(irregularBlocks->setParameter("cutoff_hz", 9000.0f, rampFrames));

    const unsigned int remainder = totalFrames - changeAtFrame;
    (void)oneBlock->processInPlace(oneBlockOutput.data() + changeAtFrame, remainder, 1U);
    unsigned int processed = 0U;
    constexpr std::array<unsigned int, 7U> chunks{{1U, 3U, 5U, 7U, 13U, 2U, 19U}};
    std::size_t chunkIndex = 0U;
    while (processed < remainder) {
        const unsigned int frames = std::min(chunks[chunkIndex % chunks.size()], remainder - processed);
        (void)irregularBlocks->processInPlace(irregularOutput.data() + changeAtFrame + processed, frames, 1U);
        processed += frames;
        ++chunkIndex;
    }
    (void)unchangedReference->processInPlace(referenceOutput.data() + changeAtFrame, remainder, 1U);

    double changedResponseEnergy = 0.0;
    double oldResponseEnergy = 0.0;
    for (std::size_t index = 0U; index < oneBlockOutput.size(); ++index) {
        expectNear(oneBlockOutput[index], irregularOutput[index], 1.0e-7f);
        if (index >= changeAtFrame) {
            changedResponseEnergy += static_cast<double>(oneBlockOutput[index]) * oneBlockOutput[index];
            oldResponseEnergy += static_cast<double>(referenceOutput[index]) * referenceOutput[index];
        }
    }
    assert(changedResponseEnergy > oldResponseEnergy * 10.0);
}

void testAutoPanCatalogWaveformsAndBypass() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 4800U;
    std::array<std::vector<float>, 3U> outputs{};
    for (unsigned int waveform = 0U; waveform < 3U; ++waveform) {
        auto autoPan = createNativeEffectProcessor("auto_pan");
        assert(autoPan && autoPan->prepare(sampleRate));
        assert(autoPan->setParameter("rate_hz", 1.0f, 1U));
        assert(autoPan->setParameter("depth", 1.0f, 1U));
        assert(autoPan->setParameter("waveform", static_cast<float>(waveform), 1U));
        assert(autoPan->setParameter("wet_mix", 1.0f, 1U));

        outputs[waveform].resize(static_cast<std::size_t>(frames) * 2U);
        for (unsigned int frame = 0U; frame < frames; ++frame) {
            // Mono-centered stereo reveals the panning envelope directly.
            outputs[waveform][static_cast<std::size_t>(frame) * 2U] = 0.5f;
            outputs[waveform][static_cast<std::size_t>(frame) * 2U + 1U] = 0.5f;
        }
        const float peak = autoPan->processInPlace(outputs[waveform].data(), frames, 2U);
        assert(std::isfinite(peak) && peak > 0.5f);
        double deviation = 0.0;
        for (std::size_t index = 0U; index < outputs[waveform].size(); ++index) {
            assert(std::isfinite(outputs[waveform][index]));
            deviation += std::fabs(static_cast<double>(outputs[waveform][index]) - 0.5);
        }
        assert(deviation > 100.0);
    }

    // The three stable enum values produce distinct phase envelopes over a
    // cycle, which catches accidental waveform aliasing in the factory.
    for (unsigned int lhs = 0U; lhs < 3U; ++lhs) {
        for (unsigned int rhs = lhs + 1U; rhs < 3U; ++rhs) {
            double difference = 0.0;
            for (std::size_t index = 0U; index < outputs[lhs].size(); ++index) {
                difference += std::fabs(static_cast<double>(outputs[lhs][index]) - outputs[rhs][index]);
            }
            assert(difference > 100.0);
        }
    }

    auto bypass = createNativeEffectProcessor("auto_pan");
    assert(bypass && bypass->prepare(sampleRate));
    assert(bypass->setParameter("rate_hz", 4.0f, 1U));
    assert(bypass->setParameter("depth", 1.0f, 1U));
    assert(bypass->setParameter("waveform", 2.0f, 1U));
    assert(bypass->setParameter("wet_mix", 1.0f, 1U));
    bypass->setBypassed(true, 1U);
    std::array<float, 16U> passthrough{{
        0.5f, -0.4f, 0.2f, -0.1f, 0.8f, -0.7f, 0.0f, 0.1f,
        0.3f, 0.2f, -0.3f, 0.6f, -0.9f, 0.25f, 0.12f, -0.42f
    }};
    const auto before = passthrough;
    (void)bypass->processInPlace(passthrough.data(), 8U, 2U);
    assert(bypass->isBypassed());
    for (std::size_t index = 0U; index < passthrough.size(); ++index) {
        expectNear(passthrough[index], before[index]);
    }
}

void testDelayEchoAndReset() {
    auto delay = createNativeEffectProcessor("fractional_delay");
    assert(delay && delay->prepare(48000U));
    assert(delay->setParameter("delay_ms", 10.0f, 1U));
    assert(delay->setParameter("feedback", 0.5f, 1U));
    assert(delay->setParameter("wet_mix", 1.0f, 1U));

    constexpr unsigned int frames = 1100U;
    std::vector<float> impulse(frames, 0.0f);
    impulse[0] = 1.0f;
    (void)delay->processInPlace(impulse.data(), frames, 1U);
    assert(std::fabs(impulse[480U]) > 0.95f);
    assert(std::fabs(impulse[960U]) > 0.45f);

    delay->resetState();
    std::vector<float> silence(1100U, 0.0f);
    (void)delay->processInPlace(silence.data(), static_cast<unsigned int>(silence.size()), 1U);
    for (const float sample : silence) expectNear(sample, 0.0f, 1.0e-6f);
}

void testTwistTrajectorySweepFeedbackMixSegmentationAndReset() {
    constexpr unsigned int sampleRate = 8000U;
    constexpr unsigned int impulseFrames = 4000U;
    constexpr std::array<float, 4U> expectedDelayMs{{69.3f, 48.4f, 93.0f, 71.3f}};
    std::array<unsigned int, 4U> arrivalFrames{};
    for (unsigned int trajectory = 0U; trajectory < expectedDelayMs.size(); ++trajectory) {
        auto twist = createNativeEffectProcessor("twist");
        assert(twist && twist->prepare(sampleRate));
        assert(twist->setParameter("amount_percent", 43.0f, 1U));
        assert(twist->setParameter("trajectory", static_cast<float>(trajectory), 1U));
        assert(twist->setParameter("mix_percent", 100.0f, 1U));
        std::vector<float> impulse(static_cast<std::size_t>(impulseFrames) * 2U, 0.0f);
        impulse[0U] = 1.0f;
        impulse[1U] = 1.0f;
        (void)twist->processInPlace(impulse.data(), impulseFrames, 2U);
        unsigned int arrival = impulseFrames;
        for (unsigned int frame = 0U; frame < impulseFrames; ++frame) {
            if (std::fabs(impulse[static_cast<std::size_t>(frame) * 2U]) >= 0.01f) {
                arrival = frame;
                break;
            }
        }
        arrivalFrames[trajectory] = arrival;
        const auto expectedFrame = static_cast<unsigned int>(std::lround(
            expectedDelayMs[trajectory] * static_cast<float>(sampleRate) / 1000.0f));
        assert(arrival > 0U && std::abs(static_cast<int>(arrival) - static_cast<int>(expectedFrame)) <= 2);
    }
    for (std::size_t lhs = 0U; lhs < arrivalFrames.size(); ++lhs) {
        for (std::size_t rhs = lhs + 1U; rhs < arrivalFrames.size(); ++rhs) {
            assert(arrivalFrames[lhs] != arrivalFrames[rhs]);
        }
    }

    // A rising signed macro shortens the read-head delay, producing an upward
    // Doppler shift on a sustained tone rather than merely changing static EQ.
    constexpr unsigned int primingFrames = sampleRate * 2U / 5U;
    constexpr unsigned int sweepFrames = sampleRate;
    auto sweep = createNativeEffectProcessor("twist");
    assert(sweep && sweep->prepare(sampleRate));
    assert(sweep->setParameter("amount_percent", -80.0f, 1U));
    assert(sweep->setParameter("trajectory", 0.0f, 1U));
    assert(sweep->setParameter("mix_percent", 100.0f, 1U));
    std::vector<float> rendered;
    rendered.reserve(static_cast<std::size_t>(primingFrames + sweepFrames));
    for (unsigned int frame = 0U; frame < primingFrames; ++frame) {
        float sample = 0.5f * std::sin(2.0f * kPi * 330.0f * static_cast<float>(frame) / sampleRate);
        (void)sweep->processInPlace(&sample, 1U, 1U);
        rendered.push_back(sample);
    }
    for (unsigned int frame = 0U; frame < sweepFrames;) {
        constexpr unsigned int controlQuantum = 64U;
        const unsigned int blockFrames = std::min(controlQuantum, sweepFrames - frame);
        const float amount = -80.0f + (160.0f * static_cast<float>(frame) / static_cast<float>(sweepFrames));
        assert(sweep->setParameter("amount_percent", amount, blockFrames));
        std::array<float, controlQuantum> block{};
        for (unsigned int offset = 0U; offset < blockFrames; ++offset) {
            const unsigned int absoluteFrame = primingFrames + frame + offset;
            block[offset] = 0.5f * std::sin(2.0f * kPi * 330.0f * static_cast<float>(absoluteFrame) / sampleRate);
        }
        (void)sweep->processInPlace(block.data(), blockFrames, 1U);
        rendered.insert(rendered.end(), block.begin(), block.begin() + blockFrames);
        frame += blockFrames;
    }
    const auto measuredHz = estimatePositiveCrossingHz(
        rendered, primingFrames + (sampleRate * 2U / 5U), primingFrames + (sampleRate * 9U / 10U), sampleRate);
    assert(measuredHz > 340.0);

    auto saturated = createNativeEffectProcessor("twist");
    assert(saturated && saturated->prepare(sampleRate));
    assert(saturated->setParameter("amount_percent", 100.0f, 1U));
    assert(saturated->setParameter("mix_percent", 100.0f, 1U));
    constexpr unsigned int feedbackFrames = 80000U;
    std::vector<float> alternating(static_cast<std::size_t>(feedbackFrames) * 2U);
    for (unsigned int frame = 0U; frame < feedbackFrames; ++frame) {
        const float sample = frame % 17U < 8U ? 8.0f : -8.0f;
        alternating[static_cast<std::size_t>(frame) * 2U] = sample;
        alternating[static_cast<std::size_t>(frame) * 2U + 1U] = -sample;
    }
    const std::size_t allocationCountBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    const float peak = saturated->processInPlace(alternating.data(), feedbackFrames, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == allocationCountBefore);
    assert(std::isfinite(peak) && peak <= 8.0f);
    for (const float sample : alternating) assert(std::isfinite(sample) && std::fabs(sample) <= 8.0f);

    // Positive and negative macro extremes pan the same delayed mono signal
    // to opposite stereo sides; the filter stays bounded and finite.
    std::array<double, 2U> positiveEnergy{};
    std::array<double, 2U> negativeEnergy{};
    for (const bool negative : {false, true}) {
        auto panned = createNativeEffectProcessor("twist");
        assert(panned && panned->prepare(sampleRate));
        assert(panned->setParameter("amount_percent", negative ? -100.0f : 100.0f, 1U));
        assert(panned->setParameter("mix_percent", 100.0f, 1U));
        constexpr unsigned int panningFrames = 6000U;
        std::vector<float> steady(static_cast<std::size_t>(panningFrames) * 2U, 0.5f);
        (void)panned->processInPlace(steady.data(), panningFrames, 2U);
        auto& energy = negative ? negativeEnergy : positiveEnergy;
        for (unsigned int frame = panningFrames - 500U; frame < panningFrames; ++frame) {
            for (unsigned int channel = 0U; channel < 2U; ++channel) {
                const float sample = steady[static_cast<std::size_t>(frame) * 2U + channel];
                assert(std::isfinite(sample) && std::fabs(sample) <= 8.0f);
                energy[channel] += static_cast<double>(sample) * sample;
            }
        }
    }
    assert(positiveEnergy[1U] > positiveEnergy[0U] * 100.0);
    assert(negativeEnergy[0U] > negativeEnergy[1U] * 100.0);

    auto wet = createNativeEffectProcessor("twist");
    auto bypass = createNativeEffectProcessor("twist");
    assert(wet && bypass && wet->prepare(sampleRate) && bypass->prepare(sampleRate));
    assert(wet->setParameter("amount_percent", 75.0f, 1U));
    assert(wet->setParameter("trajectory", 1.0f, 1U));
    assert(wet->setParameter("mix_percent", 0.0f, 1U));
    assert(bypass->setParameter("amount_percent", 100.0f, 1U));
    assert(bypass->setParameter("mix_percent", 100.0f, 1U));
    bypass->setBypassed(true, 1U);
    std::array<float, 128U> dryInput{};
    for (std::size_t index = 0U; index < dryInput.size(); ++index) {
        dryInput[index] = static_cast<float>(static_cast<int>(index % 19U) - 9) / 10.0f;
    }
    const auto expectedDry = dryInput;
    auto dryMixOutput = dryInput;
    auto bypassOutput = dryInput;
    (void)wet->processInPlace(dryMixOutput.data(), 64U, 2U);
    (void)bypass->processInPlace(bypassOutput.data(), 64U, 2U);
    for (std::size_t index = 0U; index < expectedDry.size(); ++index) {
        expectNear(dryMixOutput[index], expectedDry[index]);
        expectNear(bypassOutput[index], expectedDry[index]);
    }

    auto whole = createNativeEffectProcessor("twist");
    auto segmented = createNativeEffectProcessor("twist");
    assert(whole && segmented && whole->prepare(sampleRate) && segmented->prepare(sampleRate));
    for (auto* processor : {whole.get(), segmented.get()}) {
        assert(processor->setParameter("amount_percent", 35.0f, 1U));
        assert(processor->setParameter("trajectory", 2.0f, 1U));
        assert(processor->setParameter("mix_percent", 86.0f, 1U));
    }
    constexpr unsigned int totalFrames = 10003U;
    std::vector<float> source(static_cast<std::size_t>(totalFrames) * 2U);
    for (unsigned int frame = 0U; frame < totalFrames; ++frame) {
        source[static_cast<std::size_t>(frame) * 2U] = 0.3f * std::sin(0.071f * static_cast<float>(frame));
        source[static_cast<std::size_t>(frame) * 2U + 1U] = 0.2f * std::cos(0.053f * static_cast<float>(frame));
    }
    auto wholeOutput = source;
    auto segmentedOutput = source;
    (void)whole->processInPlace(wholeOutput.data(), totalFrames, 2U);
    constexpr std::array<unsigned int, 7U> chunks{{1U, 7U, 31U, 64U, 257U, 3U, 511U}};
    unsigned int processed = 0U;
    std::size_t chunkIndex = 0U;
    while (processed < totalFrames) {
        const unsigned int frames = std::min(chunks[chunkIndex % chunks.size()], totalFrames - processed);
        (void)segmented->processInPlace(
            segmentedOutput.data() + static_cast<std::size_t>(processed) * 2U, frames, 2U);
        processed += frames;
        ++chunkIndex;
    }
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        expectNear(wholeOutput[index], segmentedOutput[index], 1.0e-7f);
    }

    auto reset = createNativeEffectProcessor("twist");
    auto fresh = createNativeEffectProcessor("twist");
    assert(reset && fresh && reset->prepare(sampleRate) && fresh->prepare(sampleRate));
    for (auto* processor : {reset.get(), fresh.get()}) {
        assert(processor->setParameter("amount_percent", -50.0f, 1U));
        assert(processor->setParameter("trajectory", 1.0f, 1U));
        assert(processor->setParameter("mix_percent", 100.0f, 1U));
    }
    std::array<float, 512U> prior{};
    prior[0U] = 1.0f;
    (void)reset->processInPlace(prior.data(), 256U, 2U);
    reset->resetState();
    std::array<float, 512U> resetInput{};
    resetInput[2U] = 0.5f;
    resetInput[101U] = -0.3f;
    auto afterReset = resetInput;
    auto freshOutput = resetInput;
    (void)reset->processInPlace(afterReset.data(), 256U, 2U);
    (void)fresh->processInPlace(freshOutput.data(), 256U, 2U);
    for (std::size_t index = 0U; index < afterReset.size(); ++index) {
        expectNear(afterReset[index], freshOutput[index], 1.0e-7f);
    }
}

void testFourSlotSerialOrderAndBypass() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 4096U;
    NativeEffectBank forward;
    NativeEffectBank reverse;
    assert(forward.prepare(sampleRate));
    assert(reverse.prepare(sampleRate));
    configureFilter(forward, NativeEffectSlot::A, "filter.lpf", 700.0f);
    configurePhaser(forward, NativeEffectSlot::B);
    configurePhaser(reverse, NativeEffectSlot::A);
    configureFilter(reverse, NativeEffectSlot::B, "filter.lpf", 700.0f);

    std::vector<float> input(frames, 0.0f);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float n = static_cast<float>(frame);
        input[frame] = (frame == 0U ? 0.7f : 0.0f) +
            0.24f * std::sin(n * 0.117f) + 0.12f * std::sin(n * 0.391f);
    }
    auto forwardSignal = input;
    auto reverseSignal = input;
    (void)forward.processInPlace(forwardSignal.data(), frames, 1U);
    (void)reverse.processInPlace(reverseSignal.data(), frames, 1U);

    // A concrete chain result must equal the corresponding standalone
    // processors in the bank's declared A -> B serial order.
    auto manualLowPass = createNativeEffectProcessor("filter.lpf");
    auto manualPhaser = createNativeEffectProcessor("phaser");
    assert(manualLowPass && manualLowPass->prepare(sampleRate));
    assert(manualPhaser && manualPhaser->prepare(sampleRate));
    assert(manualLowPass->setParameter("cutoff_hz", 700.0f, 1U));
    assert(manualLowPass->setParameter("q", 0.8f, 1U));
    assert(manualPhaser->setParameter("stages", 8.0f, 1U));
    assert(manualPhaser->setParameter("rate_hz", 2.1f, 1U));
    assert(manualPhaser->setParameter("depth", 0.95f, 1U));
    assert(manualPhaser->setParameter("feedback", 0.3f, 1U));
    assert(manualPhaser->setParameter("wet_mix", 0.8f, 1U));
    auto manual = input;
    (void)manualLowPass->processInPlace(manual.data(), frames, 1U);
    (void)manualPhaser->processInPlace(manual.data(), frames, 1U);
    for (std::size_t index = 0U; index < manual.size(); ++index) expectNear(forwardSignal[index], manual[index], 1.0e-6f);

    double orderDifference = 0.0;
    for (std::size_t index = 0U; index < forwardSignal.size(); ++index) {
        orderDifference += std::fabs(static_cast<double>(forwardSignal[index]) - reverseSignal[index]);
    }
    assert(orderDifference > 0.1);
    assert(forward.effectId(NativeEffectSlot::A) == "filter.lpf");
    assert(forward.effectId(NativeEffectSlot::B) == "phaser");
    assert(NativeEffectBank::kSlotNames[0] == "A" && NativeEffectBank::kSlotNames[3] == "D");

    assert(forward.setEffect(NativeEffectSlot::C, "filter.hpf"));
    assert(forward.setEffect(NativeEffectSlot::D, "fractional_delay"));
    assert(forward.setEffect(NativeEffectSlot::D, "reverb"));
    assert(forward.effectId(NativeEffectSlot::D) == "reverb");
    assert(!forward.setEffect(static_cast<NativeEffectSlot>(4U), "filter.lpf"));

    auto bypass = createNativeEffectProcessor("filter.lpf");
    assert(bypass && bypass->prepare(sampleRate));
    bypass->setBypassed(true, 1U);
    std::array<float, 12U> passthrough{{0.5f, -0.4f, 0.2f, -0.1f, 0.8f, -0.7f, 0.0f, 0.1f, 0.3f, 0.2f, -0.3f, 0.6f}};
    const auto before = passthrough;
    (void)bypass->processInPlace(passthrough.data(), 6U, 2U);
    assert(bypass->isBypassed());
    for (std::size_t index = 0U; index < passthrough.size(); ++index) expectNear(passthrough[index], before[index]);

    NativeEffectBank slots;
    assert(slots.prepare(sampleRate));
    for (unsigned int index = 0U; index < 4U; ++index) {
        const auto slot = static_cast<NativeEffectSlot>(index);
        assert(slots.setEffect(slot, "filter.lpf"));
        assert(slots.effectId(slot) == "filter.lpf");
    }
    assert(!slots.setParameter(NativeEffectSlot::A, "cutoff_hz", 0.0f));
    assert(slots.clearSlot(NativeEffectSlot::D));
    assert(slots.effectId(NativeEffectSlot::D).empty());
}

void testFilterStateResetAndExtraChannels() {
    auto filter = createNativeEffectProcessor("filter.hpf");
    assert(filter && filter->prepare(48000U));
    std::array<float, 12U> threeChannel{{1.0f, 0.0f, 0.25f, 0.0f, 0.0f, -0.5f, 0.0f, 0.0f, 0.75f, 0.0f, 0.0f, -0.25f}};
    const std::array<float, 4U> extras{{threeChannel[2], threeChannel[5], threeChannel[8], threeChannel[11]}};
    (void)filter->processInPlace(threeChannel.data(), 4U, 3U);
    assert(threeChannel[2] == extras[0] && threeChannel[5] == extras[1]);
    assert(threeChannel[8] == extras[2] && threeChannel[11] == extras[3]);

    filter->resetState();
    std::array<float, 4U> silence{};
    (void)filter->processInPlace(silence.data(), 4U, 1U);
    for (const float sample : silence) expectNear(sample, 0.0f);
}

void testPreparedBankProcessingDoesNotAllocate() {
    NativeEffectBank bank;
    assert(bank.setEffect(NativeEffectSlot::A, "filter.lpf"));
    assert(bank.setEffect(NativeEffectSlot::B, "phaser"));
    assert(bank.setEffect(NativeEffectSlot::C, "fractional_delay"));
    configureAutoPan(bank, NativeEffectSlot::D, 1.0f);
    assert(bank.prepare(48000U));
    std::array<float, 512U> audio{};
    for (std::size_t index = 0U; index < audio.size(); ++index) {
        audio[index] = 0.2f * std::sin(static_cast<float>(index) * 0.07f);
    }
    const std::size_t before = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)bank.processInPlace(audio.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == before);

    NativeEffectBank chorusAndTremolo;
    assert(chorusAndTremolo.setEffect(NativeEffectSlot::A, "chorus"));
    assert(chorusAndTremolo.setEffect(NativeEffectSlot::B, "tremolo"));
    assert(chorusAndTremolo.prepare(48000U));
    std::array<float, 512U> stereo{};
    for (std::size_t index = 0U; index < stereo.size(); ++index) {
        stereo[index] = 0.2f * std::sin(static_cast<float>(index) * 0.07f);
    }
    const std::size_t chorusBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)chorusAndTremolo.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == chorusBefore);

    NativeEffectBank ringModBank;
    assert(ringModBank.setEffect(NativeEffectSlot::A, "ring_mod"));
    assert(ringModBank.prepare(48000U));
    const std::size_t ringBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)ringModBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == ringBefore);

    NativeEffectBank equalizerBank;
    assert(equalizerBank.setEffect(NativeEffectSlot::A, "eq"));
    assert(equalizerBank.setParameter(NativeEffectSlot::A, "mid1_gain_db", 8.0f, 128U));
    assert(equalizerBank.prepare(48000U));
    const std::size_t equalizerBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)equalizerBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == equalizerBefore);

    NativeEffectBank stereoEnhanceBank;
    assert(stereoEnhanceBank.setEffect(NativeEffectSlot::A, "stereo_enhance"));
    assert(stereoEnhanceBank.setParameter(NativeEffectSlot::A, "width", 165.0f, 128U));
    assert(stereoEnhanceBank.setEffect(NativeEffectSlot::D, "stereo_enhance"));
    assert(stereoEnhanceBank.prepare(48000U));
    const std::size_t stereoEnhanceBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)stereoEnhanceBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == stereoEnhanceBefore);

    NativeEffectBank flangerBank;
    assert(flangerBank.setEffect(NativeEffectSlot::A, "flanger"));
    assert(flangerBank.setParameter(NativeEffectSlot::A, "rate_hz", 2.0f, 128U));
    assert(flangerBank.setParameter(NativeEffectSlot::A, "depth", 0.9f, 128U));
    assert(flangerBank.setParameter(NativeEffectSlot::A, "feedback", 0.7f, 128U));
    assert(flangerBank.setParameter(NativeEffectSlot::A, "wet_mix", 0.8f, 128U));
    assert(flangerBank.setEffect(NativeEffectSlot::D, "flanger"));
    assert(flangerBank.prepare(48000U));
    const std::size_t flangerBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)flangerBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == flangerBefore);

    NativeEffectBank dynamicsBank;
    assert(dynamicsBank.setEffect(NativeEffectSlot::A, "dynamics"));
    assert(dynamicsBank.setParameter(NativeEffectSlot::A, "threshold_db", -24.0f, 256U));
    assert(dynamicsBank.setParameter(NativeEffectSlot::A, "ratio", 8.0f, 256U));
    assert(dynamicsBank.setParameter(NativeEffectSlot::A, "detector", 1.0f, 256U));
    assert(dynamicsBank.setEffect(NativeEffectSlot::D, "dynamics"));
    assert(dynamicsBank.prepare(48000U));
    const std::size_t dynamicsBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)dynamicsBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == dynamicsBefore);

    NativeEffectBank distortionBank;
    assert(distortionBank.setEffect(NativeEffectSlot::A, "dist"));
    assert(distortionBank.setParameter(NativeEffectSlot::A, "drive_db", 24.0f, 128U));
    assert(distortionBank.setEffect(NativeEffectSlot::D, "dist"));
    assert(distortionBank.prepare(48000U));
    const std::size_t distortionBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)distortionBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == distortionBefore);

    NativeEffectBank reverbBank;
    assert(reverbBank.setEffect(NativeEffectSlot::A, "reverb"));
    assert(reverbBank.setParameter(NativeEffectSlot::A, "decay_seconds", 4.0f, 128U));
    assert(reverbBank.setEffect(NativeEffectSlot::D, "reverb"));
    assert(reverbBank.prepare(48000U));
    const std::size_t reverbBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)reverbBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == reverbBefore);

    NativeEffectBank beatRepeatBank;
    assert(beatRepeatBank.setEffect(NativeEffectSlot::A, "beat_repeat"));
    assert(beatRepeatBank.setParameter(NativeEffectSlot::A, "division", 0.25f, 128U));
    assert(beatRepeatBank.setParameter(NativeEffectSlot::A, "direction", 2.0f, 128U));
    assert(beatRepeatBank.setEffect(NativeEffectSlot::D, "beat_repeat"));
    assert(beatRepeatBank.prepare(48000U));
    const std::size_t beatRepeatBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)beatRepeatBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == beatRepeatBefore);

    NativeEffectBank tapeEchoBank;
    assert(tapeEchoBank.setEffect(NativeEffectSlot::A, "tape_echo"));
    assert(tapeEchoBank.setParameter(NativeEffectSlot::A, "time_ms", 20.0f, 0U));
    assert(tapeEchoBank.setParameter(NativeEffectSlot::A, "feedback_percent", 0.0f, 0U));
    assert(tapeEchoBank.setParameter(NativeEffectSlot::A, "wow_flutter_percent", 0.0f, 0U));
    assert(tapeEchoBank.setParameter(NativeEffectSlot::A, "saturation_percent", 0.0f, 0U));
    assert(tapeEchoBank.setParameter(NativeEffectSlot::A, "tone_hz", 16000.0f, 0U));
    assert(tapeEchoBank.setParameter(NativeEffectSlot::A, "mix_percent", 100.0f, 0U));
    assert(tapeEchoBank.prepare(48000U));
    std::vector<float> tapeEchoImpulse(2400U * 2U, 0.0f);
    tapeEchoImpulse[0] = 1.0f;
    const std::size_t tapeEchoBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)tapeEchoBank.processInPlace(tapeEchoImpulse.data(), 2400U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == tapeEchoBefore);
    double tapeEchoEnergy = 0.0;
    for (std::size_t frame = 900U; frame < tapeEchoImpulse.size() / 2U; ++frame) {
        const float left = tapeEchoImpulse[frame * 2U];
        const float right = tapeEchoImpulse[frame * 2U + 1U];
        assert(std::isfinite(left) && std::isfinite(right));
        tapeEchoEnergy += static_cast<double>(left) * left + static_cast<double>(right) * right;
    }
    assert(tapeEchoEnergy > 1.0e-8);

    NativeEffectBank panningDelayBank;
    assert(panningDelayBank.setEffect(NativeEffectSlot::A, "panning_delay"));
    assert(panningDelayBank.setParameter(NativeEffectSlot::A, "time_ms", 25.0f, 64U));
    assert(panningDelayBank.setParameter(NativeEffectSlot::A, "feedback_percent", 70.0f, 64U));
    assert(panningDelayBank.setParameter(NativeEffectSlot::A, "pan_percent", -35.0f, 64U));
    assert(panningDelayBank.setParameter(NativeEffectSlot::A, "mix_percent", 80.0f, 64U));
    assert(panningDelayBank.setEffect(NativeEffectSlot::D, "panning_delay"));
    assert(panningDelayBank.prepare(48000U));
    assert(panningDelayBank.effectId(NativeEffectSlot::A) == "panning_delay");
    assert(panningDelayBank.effectId(NativeEffectSlot::D) == "panning_delay");
    const std::size_t panningDelayBefore = webrc::native::test_alloc::count();
    webrc::native::test_alloc::beginTracking();
    (void)panningDelayBank.processInPlace(stereo.data(), 256U, 2U);
    webrc::native::test_alloc::endTracking();
    assert(webrc::native::test_alloc::count() == panningDelayBefore);
}

void testElectricPitchConfidenceCharactersSmoothingAndRealtimeSafety() {
    constexpr unsigned int sampleRate = 48000U;
    constexpr unsigned int frames = 24000U;
    constexpr float inputHz = 445.0f;
    std::vector<float> signal(static_cast<std::size_t>(frames) * 2U);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = 0.28f * std::sin(static_cast<float>(2.0 * kPi * inputHz *
            static_cast<double>(frame) / sampleRate));
        signal[static_cast<std::size_t>(frame) * 2U] = sample;
        signal[(static_cast<std::size_t>(frame) * 2U) + 1U] = sample;
    }

    auto electricEffect = createNativeEffectProcessor("electric");
    auto* electric = dynamic_cast<NativeElectricProcessor*>(electricEffect.get());
    assert(electric != nullptr);
    assert(electric->setParameter("character", 0.0f));
    assert(electric->setParameter("pitch-snap", 100.0f));
    assert(electric->setParameter("tone", 16000.0f));
    assert(electric->setParameter("mix", 100.0f));
    assert(!electric->setParameter("character", 1.5f));
    assert(!electric->setParameter("pitch-snap", 100.1f));
    assert(electric->prepare(sampleRate));
    assert(electric->trackerRate() <= 16000U && electric->trackerRate() >= 4000U);
    assert(electric->trackingLatencyUpperBoundSamples() > 0U);

    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    const float peak = electric->processInPlace(signal.data(), frames, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);
    assert(std::isfinite(peak) && peak > 0.01f);
    assert(electric->pitchLocked());
    assert(electric->pitchStatus() == NativeElectricProcessor::PitchStatus::Tracking);
    assert(electric->pitchConfidence() >= NativeElectricProcessor::kMinimumPitchConfidence);
    assert(std::fabs(electric->sourceFrequencyHz() - inputHz) < 4.0f);
    const float expectedMidi = 69.0f + 12.0f * std::log2(electric->sourceFrequencyHz() / 440.0f);
    const float expectedSnap = 440.0f * std::pow(2.0f, (std::round(expectedMidi) - 69.0f) / 12.0f);
    assert(std::fabs(electric->snappedFrequencyHz() - expectedSnap) < 0.05f);
    assert(std::fabs(electric->effectiveFrequencyHz() - expectedSnap) < 0.5f);
    assert(electric->setParameter("pitch-snap", 50.0f, 1U));
    auto midpointProbe = signal;
    (void)electric->processInPlace(midpointProbe.data(), 480U, 2U);
    const float expectedMidpoint = electric->sourceFrequencyHz() +
        (electric->snappedFrequencyHz() - electric->sourceFrequencyHz()) * 0.5f;
    assert(std::fabs(electric->effectiveFrequencyHz() - expectedMidpoint) < 1.0f);

    // Every character is an audible DSP path on a sustained voiced input.
    // Classic is a quantized envelope-followed oscillator, Metallic is a
    // pitch-related ring modulator, Vocoder is a filterbank/carrier resynth,
    // and Bit crush is sample hold plus a six-bit quantizer.
    std::array<std::vector<float>, 4U> rendered{};
    for (unsigned int character = 0U; character < rendered.size(); ++character) {
        auto effect = createNativeEffectProcessor("electric");
        auto* processor = dynamic_cast<NativeElectricProcessor*>(effect.get());
        assert(processor != nullptr);
        assert(processor->setParameter("character", static_cast<float>(character)));
        assert(processor->setParameter("pitch-snap", 100.0f));
        assert(processor->setParameter("tone", 16000.0f));
        assert(processor->setParameter("mix", 100.0f));
        assert(processor->prepare(sampleRate));
        rendered[character] = signal;
        (void)processor->processInPlace(rendered[character].data(), frames, 2U);
        assert(processor->pitchLocked());
        for (const float sample : rendered[character]) assert(std::isfinite(sample));
        double differenceEnergy = 0.0;
        for (std::size_t sample = 4096U * 2U; sample < rendered[character].size(); ++sample) {
            const double difference = static_cast<double>(rendered[character][sample] - signal[sample]);
            differenceEnergy += difference * difference;
        }
        assert(std::sqrt(differenceEnergy / static_cast<double>(rendered[character].size() - 8192U)) > 0.015);
    }
    for (unsigned int first = 0U; first < rendered.size(); ++first) {
        for (unsigned int second = first + 1U; second < rendered.size(); ++second) {
            double differenceEnergy = 0.0;
            for (std::size_t sample = 8192U; sample < rendered[first].size(); ++sample) {
                const double difference = static_cast<double>(rendered[first][sample] - rendered[second][sample]);
                differenceEnergy += difference * difference;
            }
            assert(std::sqrt(differenceEnergy / static_cast<double>(rendered[first].size() - 8192U)) > 0.002);
        }
    }

    // Classic/Metallic explicitly require sufficient level and a stable YIN
    // confidence. Broadband, unvoiced input remains sample-identical to dry.
    std::vector<float> noise(12000U);
    std::uint32_t randomState = 0x12345678U;
    for (float& sample : noise) {
        randomState ^= randomState << 13U;
        randomState ^= randomState >> 17U;
        randomState ^= randomState << 5U;
        sample = (static_cast<float>(randomState & 0xffffU) / 32767.5f - 1.0f) * 0.15f;
    }
    for (const unsigned int character : {0U, 1U}) {
        auto effect = createNativeEffectProcessor("electric");
        auto* processor = dynamic_cast<NativeElectricProcessor*>(effect.get());
        assert(processor != nullptr);
        assert(processor->setParameter("character", static_cast<float>(character)));
        assert(processor->setParameter("mix", 100.0f));
        assert(processor->prepare(sampleRate));
        auto noiseOutput = noise;
        (void)processor->processInPlace(noiseOutput.data(), static_cast<unsigned int>(noiseOutput.size()), 1U);
        assert(!processor->pitchLocked());
        assert(processor->pitchStatus() == NativeElectricProcessor::PitchStatus::LowConfidence ||
            processor->pitchStatus() == NativeElectricProcessor::PitchStatus::Acquiring);
        for (std::size_t index = 0U; index < noise.size(); ++index) {
            assert(std::fabs(noiseOutput[index] - noise[index]) < 1.0e-6f);
        }
    }

    // A previously locked note is released after two consecutive failed
    // confidence analyses; the last noise tail is then passed through dry.
    auto transitionEffect = createNativeEffectProcessor("electric");
    auto* transition = dynamic_cast<NativeElectricProcessor*>(transitionEffect.get());
    assert(transition != nullptr);
    assert(transition->setParameter("character", 0.0f));
    assert(transition->setParameter("mix", 100.0f));
    assert(transition->prepare(sampleRate));
    auto voicedPrefix = signal;
    (void)transition->processInPlace(voicedPrefix.data(), 6000U, 2U);
    assert(transition->pitchLocked());
    auto transitionedNoise = noise;
    (void)transition->processInPlace(transitionedNoise.data(),
        static_cast<unsigned int>(transitionedNoise.size()), 1U);
    assert(!transition->pitchLocked());
    assert(transition->pitchStatus() == NativeElectricProcessor::PitchStatus::LowConfidence ||
        transition->pitchStatus() == NativeElectricProcessor::PitchStatus::InsufficientLevel);
    for (std::size_t index = transitionedNoise.size() - 4096U; index < transitionedNoise.size(); ++index) {
        assert(std::fabs(transitionedNoise[index] - noise[index]) < 1.0e-6f);
    }

    // Silence is transparent across all character modes, including Vocoder's
    // envelope release and the Bit crush sample-hold clock.
    std::vector<float> silence(8192U * 2U, 0.0f);
    for (unsigned int character = 0U; character < 4U; ++character) {
        auto effect = createNativeEffectProcessor("electric");
        auto* processor = dynamic_cast<NativeElectricProcessor*>(effect.get());
        assert(processor != nullptr);
        assert(processor->setParameter("character", static_cast<float>(character)));
        assert(processor->setParameter("mix", 100.0f));
        assert(processor->prepare(sampleRate));
        auto silentOutput = silence;
        (void)processor->processInPlace(silentOutput.data(), 8192U, 2U);
        for (float sample : silentOutput) assert(sample == 0.0f);
    }

    // Mix is linearly ramped rather than stepped when changed during DSP.
    auto smoothingEffect = createNativeEffectProcessor("electric");
    auto* smoothing = dynamic_cast<NativeElectricProcessor*>(smoothingEffect.get());
    assert(smoothing != nullptr);
    assert(smoothing->setParameter("character", 1.0f));
    assert(smoothing->setParameter("mix", 0.0f, 1U));
    assert(smoothing->prepare(sampleRate));
    std::vector<float> lockSignal(static_cast<std::size_t>(frames) * 2U, 0.0f);
    for (unsigned int frame = 0U; frame < frames; ++frame) {
        const float sample = 0.25f * std::sin(static_cast<float>(2.0 * kPi * 220.0 * frame / sampleRate));
        lockSignal[static_cast<std::size_t>(frame) * 2U] = sample;
        lockSignal[(static_cast<std::size_t>(frame) * 2U) + 1U] = sample;
    }
    (void)smoothing->processInPlace(lockSignal.data(), frames, 2U);
    assert(smoothing->pitchLocked());
    assert(smoothing->setParameter("mix", 100.0f, 480U));
    auto rampSignal = signal;
    (void)smoothing->processInPlace(rampSignal.data(), 480U, 2U);
    double earlyDifferenceEnergy = 0.0;
    double finalDifferenceEnergy = 0.0;
    for (std::size_t frame = 0U; frame < 16U; ++frame) {
        const double difference = static_cast<double>(rampSignal[frame * 2U] - signal[frame * 2U]);
        earlyDifferenceEnergy += difference * difference;
    }
    for (std::size_t frame = 448U; frame < 480U; ++frame) {
        const double difference = static_cast<double>(rampSignal[frame * 2U] - signal[frame * 2U]);
        finalDifferenceEnergy += difference * difference;
    }
    assert(std::sqrt(earlyDifferenceEnergy / 16.0) < 0.02);
    assert(std::sqrt(finalDifferenceEnergy / 32.0) > 0.01);
    assert(smoothing->setParameter("mix", 0.0f, 1U));
}

void testWarpGranularFdnFreezeChunkingBypassResetAndAllocation() {
    const auto* descriptor = findNativeEffectDescriptor("warp");
    assert(descriptor != nullptr && descriptor->sourceIndex == 42);
    assert(descriptor->inputAvailable && descriptor->trackAvailable);
    assert(descriptor->name.find("experimental") != std::string_view::npos);
    const auto* capture = findNativeEffectParameter("warp", "capture_beats");
    const auto* smear = findNativeEffectParameter("warp", "smear_percent");
    const auto* pitch = findNativeEffectParameter("warp", "pitch_semitones");
    const auto* feedback = findNativeEffectParameter("warp", "feedback_percent");
    const auto* freeze = findNativeEffectParameter("warp", "freeze");
    const auto* mix = findNativeEffectParameter("warp", "mix_percent");
    assert(capture != nullptr && capture->defaultValue == 1.0f && capture->discreteValueCount == 5U);
    assert(smear != nullptr && smear->minimum == 0.0f && smear->maximum == 100.0f);
    assert(pitch != nullptr && pitch->minimum == -24.0f && pitch->maximum == 24.0f);
    assert(feedback != nullptr && feedback->minimum == 0.0f && feedback->maximum == 95.0f);
    assert(freeze != nullptr && freeze->discrete && freeze->discreteValueCount == 2U);
    assert(mix != nullptr && mix->minimum == 0.0f && mix->maximum == 100.0f && mix->defaultValue == 40.0f);

    auto whole = createNativeEffectProcessor("warp");
    auto chunks = createNativeEffectProcessor("warp");
    assert(whole != nullptr && chunks != nullptr);
    assert(whole->reportedLatencySamples() == 0U && chunks->reportedLatencySamples() == 0U);
    assert(whole->prepare(8000U) && chunks->prepare(8000U));
    for (auto* processor : {whole.get(), chunks.get()}) {
        assert(processor->setParameter("bpm", 300.0f, 1U));
        assert(processor->setParameter("capture_beats", 0.25f, 1U));
        assert(processor->setParameter("smear_percent", 75.0f, 1U));
        assert(processor->setParameter("pitch_semitones", -7.0f, 1U));
        assert(processor->setParameter("feedback_percent", 95.0f, 1U));
        assert(processor->setParameter("freeze", 1.0f, 1U));
        assert(processor->setParameter("mix_percent", 100.0f, 1U));
        assert(!processor->setParameter("capture_beats", 0.75f, 1U));
        assert(!processor->setParameter("pitch_semitones", 24.1f, 1U));
        assert(!processor->setParameter("feedback_percent", 95.1f, 1U));
        assert(!processor->setParameter("freeze", 0.5f, 1U));
        assert(!processor->setParameter("mix_percent", 100.1f, 1U));
    }

    constexpr unsigned int kFrames = 8192U;
    std::vector<float> source(static_cast<std::size_t>(kFrames) * 2U);
    for (unsigned int frame = 0U; frame < kFrames; ++frame) {
        const float sample = 0.4f * std::sin(static_cast<float>(2.0 * kPi * 220.0 * frame / 8000.0));
        source[frame * 2U] = sample;
        source[(frame * 2U) + 1U] = -0.75f * sample;
    }
    auto wholeOutput = source;
    auto chunkOutput = source;
    const auto allocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    (void)whole->processInPlace(wholeOutput.data(), kFrames, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == allocationsBefore);

    unsigned int offset = 0U;
    constexpr std::array<unsigned int, 7U> chunkSizes{1U, 17U, 63U, 256U, 7U, 511U, 83U};
    std::size_t chunkIndex = 0U;
    const auto chunkAllocationsBefore = test_alloc::count();
    test_alloc::beginTracking();
    while (offset < kFrames) {
        const unsigned int count = std::min(chunkSizes[chunkIndex % chunkSizes.size()], kFrames - offset);
        (void)chunks->processInPlace(chunkOutput.data() + static_cast<std::size_t>(offset) * 2U, count, 2U);
        offset += count;
        ++chunkIndex;
    }
    test_alloc::endTracking();
    assert(test_alloc::count() == chunkAllocationsBefore);
    double difference = 0.0;
    double dryDifference = 0.0;
    for (std::size_t index = 0U; index < wholeOutput.size(); ++index) {
        assert(std::isfinite(wholeOutput[index]));
        assert(std::fabs(wholeOutput[index]) <= 8.0f);
        difference += std::fabs(static_cast<double>(wholeOutput[index] - chunkOutput[index]));
        dryDifference += std::fabs(static_cast<double>(wholeOutput[index] - source[index]));
    }
    assert(difference < 1.0e-4);
    assert(dryDifference > 1.0);

    whole->resetState();
    auto replay = source;
    (void)whole->processInPlace(replay.data(), kFrames, 2U);
    for (std::size_t index = 0U; index < replay.size(); ++index) {
        assert(std::fabs(replay[index] - wholeOutput[index]) < 1.0e-6f);
    }

    whole->resetState();
    whole->setBypassed(true, 1U);
    auto bypass = source;
    (void)whole->processInPlace(bypass.data(), 512U, 2U);
    for (std::size_t index = 0U; index < 512U * 2U; ++index) {
        assert(std::fabs(bypass[index] - source[index]) < 1.0e-6f);
    }

    // At 192 kHz, the 8-second capture banks remain preallocated and callback
    // processing still performs no allocation.
    auto maximumRate = createNativeEffectProcessor("warp");
    assert(maximumRate != nullptr && maximumRate->prepare(192000U));
    assert(maximumRate->setParameter("bpm", 30.0f, 1U));
    assert(maximumRate->setParameter("capture_beats", 4.0f, 1U));
    std::array<float, 64U * 2U> maxRateBlock{};
    const auto maxRateAllocations = test_alloc::count();
    test_alloc::beginTracking();
    (void)maximumRate->processInPlace(maxRateBlock.data(), 64U, 2U);
    test_alloc::endTracking();
    assert(test_alloc::count() == maxRateAllocations);
}

} // namespace

int main() {
    testCatalogAndBounds();
    testEveryAdvertisedPerTrackInsertFactoryRuns64FrameBlockInAThroughD();
    testElectricPitchConfidenceCharactersSmoothingAndRealtimeSafety();
    testAutoRiffCatalogAdapterRoutesAndProcessesWithoutCallbackAllocations();
    testRobotCatalogAdapterPitchFormantAndNoCallbackAllocations();
    testReverseReverbInputAndTrackBanksDiffuseReversedSegmentsWithoutCallbackAllocations();
    testTransposeSignalsmithFxLatencyAlignedMixAndAudio();
    testPitchBendOneShotSweepDirectionRetriggerAndAllocation();
    testPitchBendActivationPreservesPitchPipelineContinuity();
    testManualHarmonistTwoVoicesAdditivePanAndAllocation();
    testOctaveThreeFixedVoicesAdditiveMixAndAllocation();
    testPitchBendTrajectoryEditsRestartWhileMixDoesNot();
    testPatternSlicerEnvelopeTempoAndAllocation();
    testStepSlicerEditableSequenceTempoPanFilterAndChunking();
    testGateReverbEnvelopeChunkingAndNoCallbackAllocation();
    testGateReverbThresholdHysteresis();
    testGranularDelaySignalSegmentationAndAllocation();
    testLoFiSampleHoldDitherFilterAndChunking();
    testEqualizerNeutralitySectionsAndFrequencyControls();
    testEqualizerSmoothingChunkingResetBypassAndPlaybackChain();
    testRingModCarrierCoherenceResetAndBypass();
    testRingModArbitraryBlockSegmentationAndResponse();
    testWorkingFiltersAndPhaser();
    testFilterControlRateSegmentationAndResponse();
    testAutoPanCatalogWaveformsAndBypass();
    testChorusEchoAndReset();
    testTremoloWaveformsAndBypass();
    testTremoloParameterSmoothing();
    testDelayEchoAndReset();
    testTwistTrajectorySweepFeedbackMixSegmentationAndReset();
    testWarpGranularFdnFreezeChunkingBypassResetAndAllocation();
    testFourSlotSerialOrderAndBypass();
    testFilterStateResetAndExtraChannels();
    testPreparedBankProcessingDoesNotAllocate();
    return 0;
}
