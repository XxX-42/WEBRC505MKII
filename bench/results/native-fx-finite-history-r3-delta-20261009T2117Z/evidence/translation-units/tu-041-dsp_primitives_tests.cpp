#include "webrc/dsp/primitives.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <iterator>
#include <limits>
#include <new>

namespace {

std::atomic<bool> gCountAllocations{false};
std::atomic<unsigned> gAllocationCount{0};
int gFailures = 0;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++gFailures;
    }
}

double phaseAt(const float* input, const float* output, std::size_t frames,
               double frequency, double sampleRate) {
    const double omega = 2.0 * 3.14159265358979323846 * frequency / sampleRate;
    double inSin = 0.0;
    double inCos = 0.0;
    double outSin = 0.0;
    double outCos = 0.0;
    for (std::size_t i = 0; i < frames; ++i) {
        const double sine = std::sin(omega * static_cast<double>(i));
        const double cosine = std::cos(omega * static_cast<double>(i));
        inSin += input[i] * sine;
        inCos += input[i] * cosine;
        outSin += output[i] * sine;
        outCos += output[i] * cosine;
    }
    const double inPhase = std::atan2(inCos, inSin);
    const double outPhase = std::atan2(outCos, outSin);
    double phase = outPhase - inPhase;
    while (phase > 3.14159265358979323846) phase -= 2.0 * 3.14159265358979323846;
    while (phase < -3.14159265358979323846) phase += 2.0 * 3.14159265358979323846;
    return phase;
}

double dftMagnitude(const float* samples, std::size_t frames, std::size_t bin) {
    double cosine = 0.0;
    double sine = 0.0;
    for (std::size_t n = 0; n < frames; ++n) {
        const double angle = 2.0 * 3.14159265358979323846 * bin * n / frames;
        cosine += samples[n] * std::cos(angle);
        sine += samples[n] * std::sin(angle);
    }
    return 2.0 * std::hypot(cosine, sine) / frames;
}

} // namespace

void* operator new(std::size_t size) {
    if (gCountAllocations.load(std::memory_order_relaxed)) {
        gAllocationCount.fetch_add(1, std::memory_order_relaxed);
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (gCountAllocations.load(std::memory_order_relaxed)) {
        gAllocationCount.fetch_add(1, std::memory_order_relaxed);
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    using namespace webrc::dsp;
    constexpr float sampleRate = 48000.0f;
    const ProcessSpec spec{sampleRate, 64, 2};
    check(validProcessSpec(spec), "valid ProcessSpec accepted");
    check(!validProcessSpec({0.0f, 64, 2}), "zero sample rate rejected");

    const auto center = equalPowerPan(0.0f);
    check(std::fabs(center.left - 0.70710678f) < 1.0e-6f &&
              std::fabs(center.right - 0.70710678f) < 1.0e-6f,
          "equal-power center pan");
    check(std::fabs(equalPowerCrossfade(1.0f, 1.0f, 0.5f) - 1.41421356f) < 1.0e-6f,
          "equal-power crossfade center has +3 dB coherent sum");

    ParameterSmoother smoother;
    check(smoother.prepare(spec), "smoother prepare");
    smoother.reset(0.0f);
    check(!smoother.setTarget(std::numeric_limits<float>::max(), 10.0f),
          "smoother rejects extreme finite target");
    check(smoother.setTarget(1.0f, 10.0f), "smoother accepts ordinary target");
    float smoothOut[64]{};
    check(smoother.processBlock(smoothOut, 64), "smoother block");
    check(smoothOut[0] > 0.0f && smoothOut[0] < 1.0f && smoothOut[63] > smoothOut[0],
          "smoother makes monotone finite progress");
    check(!smoother.processBlock(smoothOut, 65), "smoother rejects oversize block");

    BiquadDf2T biquad;
    check(biquad.prepare(spec), "biquad prepare");
    check(!biquad.setCoefficients({1.0, 0.0, 0.0, 0.0, 1.1}, 0.0f),
          "biquad rejects unstable denominator");
    check(biquad.setLowpass(1000.0f, 0.70710678f, 0.0f), "RBJ lowpass coefficients");
    for (const float edgeRate : {48000.0f, 96000.0f, 384000.0f}) {
        BiquadDf2T edgeBiquad;
        const ProcessSpec edgeSpec{edgeRate, 64, 1};
        check(edgeBiquad.prepare(edgeSpec), "biquad prepare across supported sample rates");
        check(edgeBiquad.setLowpass(0.5f, 50.0f, 0.0f),
              "biquad accepts minimum cutoff/high-Q edge");
        check(std::fabs(edgeBiquad.coefficients().b0) > 0.0,
              "biquad preserves small double-precision low-cutoff numerator");
        bool lowEdgeFinite = true;
        for (int i = 0; i < 4096; ++i) {
            const float value = edgeBiquad.processSample(i == 0 ? 1.0f : 0.0f);
            lowEdgeFinite &= std::isfinite(value);
        }
        check(lowEdgeFinite, "biquad low-frequency high-Q impulse remains finite");
        check(edgeBiquad.setHighpass(edgeRate * 0.49f, 50.0f, 0.0f),
              "biquad accepts 0.49 Nyquist-normalized high-Q cutoff");
        bool highEdgeFinite = true;
        for (int i = 0; i < 4096; ++i) {
            const float value = edgeBiquad.processSample(i == 0 ? 1.0f : 0.0f);
            highEdgeFinite &= std::isfinite(value);
        }
        check(highEdgeFinite, "biquad near-Nyquist high-Q impulse remains finite");
        check(!edgeBiquad.setLowpass(edgeRate * 0.5f, 0.707f, 0.0f),
              "biquad rejects Nyquist cutoff");
    }
    check(!biquad.setCoefficients({std::numeric_limits<double>::max(), 0.0, 0.0, 0.0, 0.0},
                                  0.0f),
          "biquad rejects unbounded raw numerator coefficients");
    constexpr std::size_t analysisFrames = 48000;
    float* input = static_cast<float*>(std::malloc(sizeof(float) * analysisFrames));
    float* output = static_cast<float*>(std::malloc(sizeof(float) * analysisFrames));
    check(input && output, "test signal storage allocation");
    if (input && output) {
        for (std::size_t i = 0; i < analysisFrames; ++i) {
            input[i] = static_cast<float>(std::sin(2.0 * 3.14159265358979323846 * 1000.0 * i /
                                                   sampleRate));
        }
        biquad.reset();
        for (std::size_t i = 0; i < analysisFrames; ++i) output[i] = biquad.processSample(input[i]);
        double ratio = 0.0;
        double inEnergy = 0.0;
        double outEnergy = 0.0;
        for (std::size_t i = analysisFrames / 2; i < analysisFrames; ++i) {
            inEnergy += static_cast<double>(input[i]) * input[i];
            outEnergy += static_cast<double>(output[i]) * output[i];
        }
        ratio = std::sqrt(outEnergy / inEnergy);
        check(std::fabs(ratio - 0.7071) < 0.025, "RBJ lowpass -3 dB at cutoff");

        BiquadDf2T shelf;
        check(shelf.prepare(spec) && shelf.setLowShelf(800.0f, 0.0f, 1.0f, 0.0f),
              "RBJ low shelf unity setup");
        double unityShelfError = 0.0;
        for (std::size_t i = 0; i < analysisFrames; ++i) {
            input[i] = static_cast<float>(0.5 * std::sin(
                2.0 * 3.14159265358979323846 * 1000.0 * i / sampleRate));
            output[i] = shelf.processSample(input[i]);
            unityShelfError = std::max(unityShelfError,
                                       std::fabs(static_cast<double>(output[i] - input[i])));
        }
        check(unityShelfError < 1.0e-6,
              "RBJ shelf at 0 dB is unity across the band");

        shelf.reset();
        check(shelf.setLowShelf(500.0f, 6.0f, 1.0f, 0.0f),
              "RBJ low shelf positive gain setup");
        for (std::size_t i = 0; i < analysisFrames; ++i) {
            input[i] = static_cast<float>(0.25 * std::sin(
                2.0 * 3.14159265358979323846 * 100.0 * i / sampleRate));
            output[i] = shelf.processSample(input[i]);
        }
        double lowInEnergy = 0.0;
        double lowOutEnergy = 0.0;
        for (std::size_t i = analysisFrames / 2; i < analysisFrames; ++i) {
            lowInEnergy += static_cast<double>(input[i]) * input[i];
            lowOutEnergy += static_cast<double>(output[i]) * output[i];
        }
        const double lowShelfGain = std::sqrt(lowOutEnergy / lowInEnergy);
        check(std::fabs(lowShelfGain - std::pow(10.0, 6.0 / 20.0)) < 0.04,
              "RBJ low shelf measures +6 dB well below its corner");

        shelf.reset();
        check(shelf.setHighShelf(4000.0f, -6.0f, 1.0f, 0.0f),
              "RBJ high shelf negative gain setup");
        for (std::size_t i = 0; i < analysisFrames; ++i) {
            input[i] = static_cast<float>(0.25 * std::sin(
                2.0 * 3.14159265358979323846 * 16000.0 * i / sampleRate));
            output[i] = shelf.processSample(input[i]);
        }
        double highInEnergy = 0.0;
        double highOutEnergy = 0.0;
        for (std::size_t i = analysisFrames / 2; i < analysisFrames; ++i) {
            highInEnergy += static_cast<double>(input[i]) * input[i];
            highOutEnergy += static_cast<double>(output[i]) * output[i];
        }
        const double highShelfGain = std::sqrt(highOutEnergy / highInEnergy);
        check(std::fabs(highShelfGain - std::pow(10.0, -6.0 / 20.0)) < 0.04,
              "RBJ high shelf measures -6 dB well above its corner");
        check(!shelf.setLowShelf(1000.0f, 37.0f, 1.0f, 0.0f) &&
                  !shelf.setHighShelf(1000.0f, 6.0f, 0.0f, 0.0f),
              "RBJ shelves reject out-of-range gain and slope");

        double maxAutomatedShelfOutput = 0.0;
        shelf.reset();
        shelf.setLowShelf(100.0f, -36.0f, 0.1f, 0.0f);
        for (std::size_t i = 0; i < analysisFrames; ++i) {
            if (i % 256U == 0U) {
                const float gain = (i / 256U) % 2U == 0U ? 36.0f : -36.0f;
                const float frequency = (i / 512U) % 2U == 0U ? 120.0f : 12000.0f;
                check(shelf.setLowShelf(frequency, gain, 0.1f, 5.0f) &&
                          shelf.setHighShelf(frequency, -gain, 1.0f, 5.0f),
                      "RBJ shelf automation accepts legal coefficient transitions");
            }
            input[i] = static_cast<float>(0.2 * std::sin(
                2.0 * 3.14159265358979323846 * 700.0 * i / sampleRate));
            output[i] = shelf.processSample(input[i]);
            check(std::isfinite(output[i]), "RBJ shelf automation remains finite");
            maxAutomatedShelfOutput = std::max(maxAutomatedShelfOutput,
                                               std::fabs(static_cast<double>(output[i])));
        }
        check(maxAutomatedShelfOutput < 20.0,
              "RBJ shelf rapid smoothing stays bounded through +/-36 dB automation");
    }

    AllPass1 allpass;
    check(allpass.prepare(spec), "allpass prepare");
    check(allpass.setFrequency(3000.0f, 0.0f), "allpass set phase-center frequency");
    if (input && output) {
        for (std::size_t i = 0; i < analysisFrames; ++i) {
            input[i] = static_cast<float>(std::sin(2.0 * 3.14159265358979323846 * 3000.0 * i /
                                                   sampleRate));
            output[i] = allpass.processSample(input[i]);
        }
        const double phase = phaseAt(input, output, analysisFrames, 3000.0, sampleRate);
        check(std::fabs(phase + 3.14159265358979323846 * 0.5) < 0.025,
              "APF recurrence places -90 degree phase center at configured frequency");
        double inEnergy = 0.0;
        double outEnergy = 0.0;
        for (std::size_t i = analysisFrames / 2; i < analysisFrames; ++i) {
            inEnergy += static_cast<double>(input[i]) * input[i];
            outEnergy += static_cast<double>(output[i]) * output[i];
        }
        check(std::fabs(std::sqrt(outEnergy / inEnergy) - 1.0) < 2.0e-4,
              "APF magnitude remains unity");
    }

    TptStateVariableFilter svf;
    check(svf.prepare(spec), "TPT SVF prepare");
    check(svf.setFrequencyQ(1200.0f, 0.70710678f, 0.0f), "TPT SVF parameters");
    svf.reset();
    for (int i = 0; i < 20000; ++i) {
        const auto value = svf.processSample(i == 0 ? 1.0f : 0.0f);
        check(std::isfinite(value.low) && std::isfinite(value.band) && std::isfinite(value.high),
              "TPT SVF impulse response finite");
    }
    check(svf.setFrequencyQ(4000.0f, 2.0f, 10.0f), "TPT SVF smoothed update");
    for (int i = 0; i < 1000; ++i) (void)svf.processSample(0.0f);

    LagrangeDelay delay;
    check(delay.prepare(spec, 128), "Lagrange delay prepare allocates ring");
    float delayResponse[32]{};
    for (int i = 0; i < 32; ++i) delayResponse[i] = delay.processSample(i == 0 ? 1.0f : 0.0f, 8.5f);
    check(std::fabs(delayResponse[8]) + std::fabs(delayResponse[9]) > 0.8f,
          "fractional Lagrange delay has response around 8.5 samples");
    const float sincSource[8] = {0, 1, 2, 3, 4, 5, 6, 7};
    check(sinc8Read(sincSource, 8, std::numeric_limits<double>::max(), BoundaryMode::Zero) == 0.0f,
          "sinc8 zero boundary safely rejects huge position");
    check(std::isfinite(sinc8Read(sincSource, 8, -1.0e200, BoundaryMode::Clamp)),
          "sinc8 clamp handles huge negative position");
    check(std::isfinite(sinc8Read(sincSource, 8, 1.0e200, BoundaryMode::Wrap)),
          "sinc8 wrap handles huge finite position");

    Lfo lfo;
    check(lfo.prepare(spec) && lfo.setFrequency(5.0f), "LFO prepare/frequency");
    float lfoBlock[64]{};
    check(lfo.processBlock(lfoBlock, 64), "LFO block");
    check(std::all_of(std::begin(lfoBlock), std::end(lfoBlock),
                      [](float value) { return std::isfinite(value); }), "LFO finite output");
    check(lfo.prepare({96000.0f, 64, 2}), "LFO can be prepared again at a new sample rate");
    lfo.reset();
    check(std::fabs(lfo.next()) < 1.0e-7f, "reprepared LFO resets phase and frequency increment");

    PolyBlepOscillator oscillator;
    check(oscillator.prepare(spec), "polyBLEP oscillator prepare");
    oscillator.setWaveform(OscillatorWaveform::Triangle);
    oscillator.reset(0.25f);
    check(std::fabs(oscillator.next()) < 1.0e-6f,
          "triangle oscillator starts at phase-consistent value");
    check(oscillator.setFrequency(100.0f), "oscillator frequency");
    oscillator.reset(0.0f);
    const float phaseZeroExpected = -1.0f + 4.0f * (100.0f / sampleRate) / 3.0f;
    check(std::fabs(oscillator.next() - phaseZeroExpected) < 1.0e-6f,
          "polyBLAMP triangle first sample matches integrated phase correction");
    const float triangleFrequencies[] = {100.0f, 997.0f, 5000.0f, 10000.0f, 19200.0f};
    for (const float frequency : triangleFrequencies) {
        check(oscillator.setFrequency(frequency), "triangle frequency sweep point accepted");
        oscillator.reset(0.0f);
        double triangleMean = 0.0;
        double trianglePeak = 0.0;
        for (int i = 0; i < 48000; ++i) {
            const auto value = oscillator.next();
            triangleMean += value;
            trianglePeak = std::max(trianglePeak, std::fabs(static_cast<double>(value)));
        }
        triangleMean /= 48000.0;
        check(std::fabs(triangleMean) < 0.01,
              "polyBLAMP triangle has low DC across a one-second frequency sweep");
        check(trianglePeak < 1.1, "polyBLAMP triangle remains bounded across sweep");
    }
    float bandlimitedTriangle[5]{};
    float naiveTriangle[5]{};
    check(oscillator.setFrequency(19200.0f), "triangle alias probe frequency");
    oscillator.reset(0.0f);
    for (int i = 0; i < 5; ++i) {
        bandlimitedTriangle[i] = oscillator.next();
        const double phase = std::fmod(i * 0.4, 1.0);
        naiveTriangle[i] = static_cast<float>(phase < 0.5 ? -1.0 + 4.0 * phase
                                                          : 3.0 - 4.0 * phase);
    }
    check(dftMagnitude(bandlimitedTriangle, 5, 1) < dftMagnitude(naiveTriangle, 5, 1) * 0.8,
          "polyBLAMP triangle reduces the first aliased harmonic versus naive triangle");
    check(oscillator.prepare({96000.0f, 64, 2}), "oscillator repeated prepare at new rate");
    const auto preparedTriangle = oscillator.next();
    check(std::fabs(preparedTriangle - (-1.0f)) < 1.0e-6f,
          "reprepared triangle starts at phase zero with no stale frequency increment");

    AdaaCubicShaper shaper;
    check(shaper.prepare(spec) && shaper.setDrive(2.0f), "ADAA shaper prepare/drive");
    const float hugePositive = shaper.processSample(std::numeric_limits<float>::max());
    shaper.reset();
    const float hugeNegative = shaper.processSample(-std::numeric_limits<float>::max());
    check(std::isfinite(hugePositive) && std::isfinite(hugeNegative),
          "unclamped ADAA handles full finite float input range");
    check(std::fabs(hugePositive - 1.0f) < 1.0e-5f &&
              std::fabs(hugeNegative + 1.0f) < 1.0e-5f,
          "ADAA saturated cubic outer antiderivative has linear extension");
    const auto invalidAdaa = shaper.processSample(std::numeric_limits<float>::infinity());
    check(std::isfinite(invalidAdaa), "ADAA sanitizes non-finite input");

    DualDetectorCompressor compressor;
    check(compressor.prepare(spec), "compressor prepare");
    check(compressor.setParameters(-12.0f, 4.0f, 0.0f, 5.0f, 80.0f, 0.5f, 0.0f),
          "compressor parameters");
    const auto hugeCompressed = compressor.processSample(std::numeric_limits<float>::max(),
                                                         std::numeric_limits<float>::max());
    const auto invalidCompressed = compressor.processSample(
        std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity());
    check(std::isfinite(hugeCompressed.left) && std::isfinite(hugeCompressed.right),
          "compressor detector does not overflow on huge finite input");
    check(std::isfinite(invalidCompressed.left) && std::isfinite(invalidCompressed.right),
          "compressor sanitizes NaN and infinity");
    for (int i = 0; i < 96000; ++i) (void)compressor.processSample(0.1f, -0.1f);
    const auto recovered = compressor.processSample(0.1f, -0.1f);
    check(std::isfinite(recovered.left) && std::fabs(recovered.left - 0.1f) <= 0.001f,
          "compressor recovers to unity within 2 s after invalid/extreme detector input");

    DelayMatrix2 matrix;
    check(matrix.setFeedback(0.7f, 0.2f), "stable delay feedback matrix accepted");
    check(std::max(std::fabs(matrix.sameChannelFeedback() + matrix.crossChannelFeedback()),
                   std::fabs(matrix.sameChannelFeedback() - matrix.crossChannelFeedback())) < 1.0f,
          "delay feedback spectral radius remains below unity");
    Pcg32 rngA;
    Pcg32 rngB;
    rngA.seed(1234, 7);
    rngB.seed(1234, 7);
    bool deterministic = true;
    for (int i = 0; i < 1000; ++i) deterministic &= rngA.nextU32() == rngB.nextU32();
    check(deterministic, "PCG stream is deterministic for fixed seed");

    // Prepare each legal maximum before guarding. Exercise non-silent blocks and
    // parameter updates over many callbacks; no processor may allocate on either path.
    bool allBlocksOk = true;
    unsigned totalAllocations = 0;
    const auto runAllocationScenario = [&](std::uint32_t maxBlock) {
        const ProcessSpec localSpec{sampleRate, maxBlock, 2};
        BiquadDf2T guardBiquad;
        ParameterSmoother guardSmoother;
        TptStateVariableFilter guardSvf;
        AllPass1 guardAllpass;
        LagrangeDelay guardDelay;
        AdaaCubicShaper guardShaper;
        DualDetectorCompressor guardCompressor;
        Lfo guardLfo;
        PolyBlepOscillator guardOscillator;
        DelayMatrix2 guardMatrix;
        Pcg32 guardRng;
        bool setupOk = guardBiquad.prepare(localSpec) && guardSmoother.prepare(localSpec) &&
                       guardBiquad.setLowShelf(1000.0f, 0.0f, 1.0f, 0.0f) &&
                       guardSvf.prepare(localSpec) &&
                       guardSvf.setFrequencyQ(1000.0f, 0.707f, 0.0f) &&
                       guardAllpass.prepare(localSpec) &&
                       guardAllpass.setFrequency(1000.0f, 0.0f) &&
                       guardDelay.prepare(localSpec, 256) && guardShaper.prepare(localSpec) &&
                       guardCompressor.prepare(localSpec) && guardLfo.prepare(localSpec) &&
                       guardLfo.setFrequency(5.0f) && guardOscillator.prepare(localSpec) &&
                       guardOscillator.setFrequency(440.0f) &&
                       guardCompressor.setParameters(-18.0f, 3.0f, 4.0f, 5.0f, 80.0f,
                                                     0.5f, 0.0f) &&
                       guardMatrix.setFeedback(0.5f, 0.2f);
        guardSmoother.reset(0.25f);
        setupOk = setupOk && guardSmoother.setTarget(0.75f, 25.0f);
        guardRng.seed(17, 31);
        std::array<float, 256> blockIn{};
        std::array<float, 256> blockRight{};
        std::array<float, 256> blockA{};
        std::array<float, 256> blockB{};
        std::array<float, 256> blockC{};
        std::array<float, 256> blockD{};
        std::array<float, 256> blockE{};
        std::array<float, 256> blockDelaySamples{};
        std::array<float, 64> sincSource{};
        for (std::size_t i = 0; i < blockIn.size(); ++i) {
            blockIn[i] = 0.15f * std::sin(static_cast<float>(0.031 * i));
            blockRight[i] = 0.13f * std::cos(static_cast<float>(0.027 * i));
            blockDelaySamples[i] = 24.25f + static_cast<float>(i % 7) * 0.125f;
        }
        for (std::size_t i = 0; i < sincSource.size(); ++i) {
            sincSource[i] = static_cast<float>(guardRng.nextBipolar());
        }
        const std::uint32_t frameChoices[3] = {64, 128, 256};
        const unsigned choiceCount = maxBlock >= 256 ? 3U : maxBlock >= 128 ? 2U : 1U;
        gAllocationCount.store(0, std::memory_order_relaxed);
        gCountAllocations.store(true, std::memory_order_relaxed);
        for (unsigned block = 0; block < 48; ++block) {
            if (block % 6 == 0) {
                const float shift = static_cast<float>(block % 12) * 35.0f;
                const float shelfGain = block % 12 < 6 ? 6.0f : -6.0f;
                setupOk = setupOk && guardBiquad.setLowShelf(250.0f + shift, shelfGain,
                                                              0.7f, 3.0f) &&
                          guardBiquad.setHighShelf(5000.0f + shift, -shelfGain,
                                                   0.8f, 3.0f) &&
                          guardSvf.setFrequencyQ(800.0f + shift, 1.1f, 3.0f) &&
                          guardAllpass.setFrequency(1400.0f + shift, 3.0f) &&
                          guardLfo.setFrequency(4.0f + shift * 0.001f) &&
                          guardOscillator.setFrequency(330.0f + shift) &&
                          guardSmoother.setTarget(0.3f + shift * 0.0001f, 10.0f);
            }
            const auto frames = frameChoices[block % choiceCount];
            setupOk = setupOk && guardSmoother.processBlock(blockC.data(), frames) &&
                      guardBiquad.processBlock(blockIn.data(), blockA.data(), frames) &&
                      guardSvf.processBlock(blockA.data(), blockB.data(), blockC.data(),
                                            blockD.data(), frames) &&
                      guardAllpass.processBlock(blockB.data(), blockA.data(), frames) &&
                      guardDelay.processBlock(blockA.data(), blockB.data(),
                                              blockDelaySamples.data(), frames) &&
                      guardShaper.processBlock(blockB.data(), blockC.data(), frames) &&
                      guardCompressor.processBlock(blockC.data(), blockRight.data(),
                                                   blockD.data(), blockE.data(), frames) &&
                      guardLfo.processBlock(blockA.data(), frames) &&
                      guardOscillator.processBlock(blockB.data(), frames);
            for (std::uint32_t i = 0; i < frames; ++i) {
                const auto mixed = guardMatrix.process({blockD[i], blockE[i]},
                                                       {blockA[i], blockB[i]});
                const auto noise = sinc8Read(sincSource.data(), sincSource.size(),
                                             20.25 + (i % 23) * 0.11, BoundaryMode::Wrap);
                blockC[i] = equalPowerCrossfade(mixed.left, noise, 0.5f);
            }
        }
        gCountAllocations.store(false, std::memory_order_relaxed);
        const auto allocations = gAllocationCount.load(std::memory_order_relaxed);
        totalAllocations += allocations;
        return setupOk;
    };
    allBlocksOk &= runAllocationScenario(64);
    allBlocksOk &= runAllocationScenario(128);
    allBlocksOk &= runAllocationScenario(256);
    check(allBlocksOk, "prepared DSP blocks and automation accept 64/128/256 frame calls");
    check(totalAllocations == 0,
          "continuous non-silent processing and parameter updates allocate no heap memory");

    std::free(input);
    std::free(output);
    if (gFailures != 0) {
        std::fprintf(stderr, "%d DSP primitive test(s) failed\n", gFailures);
        return 1;
    }
    std::puts("DSP primitive tests passed");
    return 0;
}
