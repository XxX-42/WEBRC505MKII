#include "webrc/dsp/primitives.hpp"

#include <array>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <ostream>

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr std::size_t kFrames = 32;

void writeArray(std::ostream& out, const float* values, std::size_t count) {
    out << '[';
    for (std::size_t i = 0; i < count; ++i) {
        if (i != 0) out << ',';
        out << std::setprecision(9) << values[i];
    }
    out << ']';
}

} // namespace

int main(int argc, char** argv) {
    using namespace webrc::dsp;
    constexpr float sampleRate = 48000.0f;
    const ProcessSpec spec{sampleRate, 64, 2};
    std::array<float, kFrames> input{};
    std::array<float, kFrames> rightInput{};
    std::array<float, kFrames> rightOutput{};
    std::array<float, kFrames> low{};
    std::array<float, kFrames> band{};
    std::array<float, kFrames> high{};
    for (std::size_t i = 0; i < kFrames; ++i) {
        input[i] = static_cast<float>(0.4 * std::sin(2.0 * kPi * 731.0 * i / sampleRate) +
                                      0.07 * std::cos(2.0 * kPi * 89.0 * i / sampleRate));
        rightInput[i] = static_cast<float>(0.23 * std::cos(2.0 * kPi * 317.0 * i / sampleRate));
    }

    BiquadDf2T biquad;
    TptStateVariableFilter svf;
    AllPass1 allpass;
    AdaaCubicShaper shaper;
    DualDetectorCompressor compressor;
    PolyBlepOscillator oscillator;
    if (!biquad.prepare(spec) || !biquad.setLowpass(1800.0f, 0.70710678f, 0.0f) ||
        !svf.prepare(spec) || !svf.setFrequencyQ(1200.0f, 0.8f, 0.0f) ||
        !allpass.prepare(spec) || !allpass.setFrequency(3000.0f, 0.0f) ||
        !shaper.prepare(spec) || !shaper.setDrive(2.0f) ||
        !compressor.prepare(spec) ||
        !compressor.setParameters(-18.0f, 3.5f, 5.0f, 4.0f, 90.0f, 0.35f, 1.5f) ||
        !oscillator.prepare(spec) || !oscillator.setFrequency(997.0f)) {
        std::cerr << "golden runner setup failed\n";
        return 2;
    }
    oscillator.setWaveform(OscillatorWaveform::Triangle);

    std::array<float, kFrames> biquadOut{};
    std::array<float, kFrames> allpassOut{};
    std::array<float, kFrames> shaperOut{};
    std::array<float, kFrames> compressorLeft{};
    std::array<float, kFrames> compressorRight{};
    std::array<float, kFrames> oscillatorOut{};
    const bool processed = biquad.processBlock(input.data(), biquadOut.data(), kFrames) &&
                           svf.processBlock(input.data(), low.data(), band.data(), high.data(),
                                            kFrames) &&
                           allpass.processBlock(input.data(), allpassOut.data(), kFrames) &&
                           shaper.processBlock(input.data(), shaperOut.data(), kFrames) &&
                           compressor.processBlock(input.data(), rightInput.data(),
                                                   compressorLeft.data(), compressorRight.data(),
                                                   kFrames) &&
                           oscillator.processBlock(oscillatorOut.data(), kFrames);
    if (!processed) {
        std::cerr << "golden runner processing failed\n";
        return 3;
    }

    std::ofstream file;
    std::ostream* out = &std::cout;
    if (argc > 1) {
        file.open(argv[1], std::ios::out | std::ios::trunc);
        if (!file) {
            std::cerr << "cannot open golden output path\n";
            return 4;
        }
        out = &file;
    }
    *out << "{\n  \"schemaVersion\":1,\n  \"producer\":\"native shared C++ DSP core\",\n"
         << "  \"sampleRate\":48000,\n  \"frames\":" << kFrames << ",\n  \"fixtures\":{\n";
    *out << "    \"biquad_lowpass\":{\"parameters\":{\"frequencyHz\":1800,\"q\":0.70710678},\"input\":";
    writeArray(*out, input.data(), kFrames);
    *out << ",\"output\":";
    writeArray(*out, biquadOut.data(), kFrames);
    *out << "},\n    \"allpass1\":{\"parameters\":{\"phaseCenterHz\":3000},\"input\":";
    writeArray(*out, input.data(), kFrames);
    *out << ",\"output\":";
    writeArray(*out, allpassOut.data(), kFrames);
    *out << "},\n    \"tpt_svf\":{\"parameters\":{\"frequencyHz\":1200,\"q\":0.8},\"input\":";
    writeArray(*out, input.data(), kFrames);
    *out << ",\"low\":";
    writeArray(*out, low.data(), kFrames);
    *out << ",\"band\":";
    writeArray(*out, band.data(), kFrames);
    *out << ",\"high\":";
    writeArray(*out, high.data(), kFrames);
    *out << "},\n    \"adaa_cubic\":{\"parameters\":{\"drive\":2},\"input\":";
    writeArray(*out, input.data(), kFrames);
    *out << ",\"output\":";
    writeArray(*out, shaperOut.data(), kFrames);
    *out << "},\n    \"dual_detector_compressor\":{\"parameters\":{\"thresholdDb\":-18,\"ratio\":3.5,\"kneeDb\":5,\"attackMs\":4,\"releaseMs\":90,\"rmsMix\":0.35,\"makeupDb\":1.5},\"inputLeft\":";
    writeArray(*out, input.data(), kFrames);
    *out << ",\"inputRight\":";
    writeArray(*out, rightInput.data(), kFrames);
    *out << ",\"outputLeft\":";
    writeArray(*out, compressorLeft.data(), kFrames);
    *out << ",\"outputRight\":";
    writeArray(*out, compressorRight.data(), kFrames);
    *out << "},\n    \"polyblep_triangle\":{\"parameters\":{\"frequencyHz\":997},\"output\":";
    writeArray(*out, oscillatorOut.data(), kFrames);
    *out << "}\n  }\n}\n";
    return *out ? 0 : 5;
}
