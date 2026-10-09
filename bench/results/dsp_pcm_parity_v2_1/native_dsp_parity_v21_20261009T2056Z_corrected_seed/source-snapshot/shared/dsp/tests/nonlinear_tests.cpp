#include "webrc/dsp/nonlinear.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
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

double magnitudeAtBin(const float* samples, std::size_t count, std::size_t bin) {
    const double coefficient = 2.0 * std::cos(2.0 * 3.14159265358979323846 * bin / count);
    double state1 = 0.0;
    double state2 = 0.0;
    for (std::size_t i = 0; i < count; ++i) {
        const double state0 = samples[i] + coefficient * state1 - state2;
        state2 = state1;
        state1 = state0;
    }
    const double power = std::max(0.0, state1 * state1 + state2 * state2 -
                                         coefficient * state1 * state2);
    return 2.0 * std::sqrt(power) / static_cast<double>(count);
}

double energyCentroid(const float* samples, std::size_t count) {
    double weightedEnergy = 0.0;
    double totalEnergy = 0.0;
    for (std::size_t i = 0; i < count; ++i) {
        const double energy = static_cast<double>(samples[i]) * samples[i];
        weightedEnergy += static_cast<double>(i) * energy;
        totalEnergy += energy;
    }
    return totalEnergy > 0.0 ? weightedEnergy / totalEnergy : 0.0;
}

double phaseAtBin(const float* samples, std::size_t count, std::size_t bin) {
    double real = 0.0;
    double imaginary = 0.0;
    for (std::size_t i = 0; i < count; ++i) {
        const double phase = 2.0 * 3.14159265358979323846 * bin * i / count;
        real += samples[i] * std::cos(phase);
        imaginary -= samples[i] * std::sin(phase);
    }
    return std::atan2(imaginary, real);
}

double wrapPhase(double phase) {
    while (phase > 3.14159265358979323846) phase -= 2.0 * 3.14159265358979323846;
    while (phase < -3.14159265358979323846) phase += 2.0 * 3.14159265358979323846;
    return phase;
}

struct AliasMetrics {
    std::uint32_t fundamentalBin = 0;
    std::uint32_t foldedHarmonicBin = 0;
    double frequencyHz = 0.0;
    double memoryless = 0.0;
    double adaa1x = 0.0;
    double oversample2x = 0.0;
    double oversample4x = 0.0;
};

struct ImdMetrics {
    double lowerProductHz = 0.0;
    double upperProductHz = 0.0;
    std::array<double, 3> lowerMagnitude{};
    std::array<double, 3> upperMagnitude{};
};
} // namespace

void* operator new(std::size_t size) {
    if (gCountAllocations.load(std::memory_order_relaxed))
        gAllocationCount.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0 ? 1 : size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (gCountAllocations.load(std::memory_order_relaxed))
        gAllocationCount.fetch_add(1, std::memory_order_relaxed);
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
    const ProcessSpec spec{sampleRate, 256, 2};

    WdfSymmetricDiode diode;
    check(diode.prepare(spec), "F23 WDF symmetric diode prepare");
    for (const double incident : {-32.0, -4.0, -1.0, -0.1, 0.0, 0.1, 1.0, 4.0, 32.0}) {
        const auto sample = diode.processPort(static_cast<float>(incident));
        const double residual = sample.voltage + 1000.0 * sample.current - sample.incident;
        const double incidentWave = sample.voltage + 1000.0 * sample.current;
        const double reflectedWave = sample.voltage - 1000.0 * sample.current;
        check(std::isfinite(sample.voltage) && std::isfinite(sample.current) &&
                  std::isfinite(sample.reflected),
              "F23 WDF port stays finite over bounded incident-wave range");
        check(std::fabs(residual) < 2.0e-7 &&
                  std::fabs(incidentWave - sample.incident) < 2.0e-7 &&
                  std::fabs(reflectedWave - sample.reflected) < 2.0e-7,
              "F23 diode solution satisfies incident/reflected wave equations");
        check(sample.voltage * sample.current >= -1.0e-12,
              "F23 passive diode absorbs rather than creates port power");
    }
    check(std::fabs(diode.processSample(1.0f) + diode.processSample(-1.0f)) < 1.0e-6f,
          "F23 antiparallel diode response is odd symmetric");
    check(std::fabs(diode.processSample(1.0f)) < 1.0f,
          "F23 diode network produces nonlinear limiting for large input");
    check(!diode.setParameters(0.0, 2.0e-9, 0.02585, 1.0) &&
              !diode.setParameters(1000.0, 2.0e-9, 0.02585, 9.0),
          "F23 rejects invalid or out-of-range circuit parameters");
    std::size_t wdfParameterCases = 0;
    for (const double resistance : {1.0, 50.0, 1000.0, 1.0e6}) {
        for (const double saturation : {1.0e-12, 2.0e-9, 1.0e-3}) {
            for (const double thermal : {0.005, 0.02585, 0.2}) {
                for (const double ideality : {0.5, 1.0, 4.0}) {
                    check(diode.setParameters(resistance, saturation, thermal, ideality),
                          "F23 accepts tested legal diode parameter corner");
                    for (const float incident : {-32.0f, -1.0f, -0.1f, 0.1f, 1.0f, 32.0f}) {
                        const auto sample = diode.processPort(incident);
                        const double expectedIncident = std::clamp(
                            static_cast<double>(incident), -32.0, 32.0);
                        check(std::isfinite(sample.voltage) && std::isfinite(sample.current) &&
                                  std::isfinite(sample.reflected) &&
                                  std::fabs(sample.voltage + resistance * sample.current -
                                            expectedIncident) < 2.0e-6 &&
                                  std::fabs(sample.reflected -
                                            (sample.voltage - resistance * sample.current)) < 2.0e-6 &&
                                  std::fabs(sample.reflected) <= std::fabs(expectedIncident) + 2.0e-6 &&
                                  sample.voltage * sample.current >= -2.0e-9,
                              "F23 parameter-grid point satisfies wave residual and passivity bounds");
                        ++wdfParameterCases;
                    }
                }
            }
        }
    }
    std::printf("F23 checked accepted-parameter diode points: %zu\n", wdfParameterCases);

    OversampledNonlinear twoX;
    OversampledNonlinear fourX;
    check(twoX.prepare(spec, OversamplingFactor::x2, NonlinearModel::AdaaCubic) &&
              fourX.prepare(spec, OversamplingFactor::x4, NonlinearModel::AdaaCubic),
          "F07 half-band oversamplers prepare for 2x and 4x");
    check(twoX.setDrive(10.0f) && fourX.setDrive(10.0f),
          "F07 ADAA drive accepts bounded nonlinear gain");
    check(std::fabs(twoX.firGroupDelaySamples() - 14.5) < 1.0e-12 &&
              std::fabs(fourX.firGroupDelaySamples() - 21.75) < 1.0e-12 &&
              std::fabs(twoX.adaaLowFrequencyGroupDelaySamples() - 0.25) < 1.0e-12 &&
              std::fabs(fourX.adaaLowFrequencyGroupDelaySamples() - 0.125) < 1.0e-12 &&
              std::fabs(twoX.lowFrequencySmallSignalGroupDelaySamples() - 14.75) < 1.0e-12 &&
              std::fabs(fourX.lowFrequencySmallSignalGroupDelaySamples() - 21.875) < 1.0e-12,
          "F07 separately reports FIR and ADAA small-signal group-delay estimates");
    OversampledNonlinear linearTwoX;
    OversampledNonlinear linearFourX;
    check(linearTwoX.prepare(spec, OversamplingFactor::x2,
                             NonlinearModel::WdfSymmetricDiode) &&
              linearFourX.prepare(spec, OversamplingFactor::x4,
                                  NonlinearModel::WdfSymmetricDiode) &&
              linearTwoX.setDiodeParameters(1.0, 1.0e-12, 0.02585, 1.0) &&
              linearFourX.setDiodeParameters(1.0, 1.0e-12, 0.02585, 1.0),
          "F07 linearized WDF paths prepare for FIR latency verification");
    std::array<float, 256> latencyImpulse{};
    std::array<float, 256> latencyTwoX{};
    std::array<float, 256> latencyFourX{};
    latencyImpulse[0] = 0.001f;
    linearTwoX.processBlock(latencyImpulse.data(), latencyTwoX.data(), 256);
    linearFourX.processBlock(latencyImpulse.data(), latencyFourX.data(), 256);
    const double measuredTwoXCentroid = energyCentroid(latencyTwoX.data(), latencyTwoX.size());
    const double measuredFourXCentroid = energyCentroid(latencyFourX.data(), latencyFourX.size());
    std::printf("F07 linear-path impulse energy centroid: 2x=%.6f 4x=%.6f base samples\n",
                measuredTwoXCentroid, measuredFourXCentroid);
    check(std::fabs(measuredTwoXCentroid - linearTwoX.firGroupDelaySamples()) < 0.5 &&
              std::fabs(measuredFourXCentroid - linearFourX.firGroupDelaySamples()) < 0.5,
          "F07 measured linear impulse centroids agree with decimation-phase FIR delay");

    constexpr std::size_t phaseWarmup = 512;
    constexpr std::size_t phaseFrames = 4800;
    constexpr std::size_t phaseBin = 100;
    OversampledNonlinear phaseAdaaTwoX;
    OversampledNonlinear phaseLinearTwoX;
    OversampledNonlinear phaseAdaaFourX;
    OversampledNonlinear phaseLinearFourX;
    bool phaseSetup = phaseAdaaTwoX.prepare(spec, OversamplingFactor::x2,
                                           NonlinearModel::AdaaCubic) &&
        phaseLinearTwoX.prepare(spec, OversamplingFactor::x2,
                                NonlinearModel::WdfSymmetricDiode) &&
        phaseAdaaFourX.prepare(spec, OversamplingFactor::x4,
                               NonlinearModel::AdaaCubic) &&
        phaseLinearFourX.prepare(spec, OversamplingFactor::x4,
                                 NonlinearModel::WdfSymmetricDiode) &&
        phaseAdaaTwoX.setDrive(1.0f) && phaseAdaaFourX.setDrive(1.0f) &&
        phaseLinearTwoX.setDiodeParameters(1.0, 1.0e-12, 0.02585, 1.0) &&
        phaseLinearFourX.setDiodeParameters(1.0, 1.0e-12, 0.02585, 1.0);
    std::array<float, phaseFrames> phaseAdaaTwoSamples{};
    std::array<float, phaseFrames> phaseLinearTwoSamples{};
    std::array<float, phaseFrames> phaseAdaaFourSamples{};
    std::array<float, phaseFrames> phaseLinearFourSamples{};
    std::array<float, phaseFrames> phaseInputSamples{};
    for (std::size_t frame = 0; frame < phaseWarmup + phaseFrames; ++frame) {
        const float input = static_cast<float>(0.01 * std::sin(
            2.0 * 3.14159265358979323846 * 1000.0 * frame / sampleRate));
        const float a2 = phaseAdaaTwoX.processSample(input);
        const float l2 = phaseLinearTwoX.processSample(input);
        const float a4 = phaseAdaaFourX.processSample(input);
        const float l4 = phaseLinearFourX.processSample(input);
        if (frame >= phaseWarmup) {
            const auto index = frame - phaseWarmup;
            phaseInputSamples[index] = input;
            phaseAdaaTwoSamples[index] = a2;
            phaseLinearTwoSamples[index] = l2;
            phaseAdaaFourSamples[index] = a4;
            phaseLinearFourSamples[index] = l4;
        }
    }
    const double angularFrequency = 2.0 * 3.14159265358979323846 * 1000.0 / sampleRate;
    const double inputPhase = phaseAtBin(phaseInputSamples.data(), phaseFrames, phaseBin);
    const double measuredFirDelayTwo = -wrapPhase(
        phaseAtBin(phaseLinearTwoSamples.data(), phaseFrames, phaseBin) - inputPhase) /
        angularFrequency;
    const double measuredFirDelayFour = -wrapPhase(
        phaseAtBin(phaseLinearFourSamples.data(), phaseFrames, phaseBin) - inputPhase) /
        angularFrequency;
    const double measuredAdaaDelayTwo = -wrapPhase(
        phaseAtBin(phaseAdaaTwoSamples.data(), phaseFrames, phaseBin) -
        phaseAtBin(phaseLinearTwoSamples.data(), phaseFrames, phaseBin)) / angularFrequency;
    const double measuredAdaaDelayFour = -wrapPhase(
        phaseAtBin(phaseAdaaFourSamples.data(), phaseFrames, phaseBin) -
        phaseAtBin(phaseLinearFourSamples.data(), phaseFrames, phaseBin)) / angularFrequency;
    std::printf("F07 ADAA extra 1 kHz phase delay: 2x=%.6f 4x=%.6f base samples\n",
                measuredAdaaDelayTwo, measuredAdaaDelayFour);
    const double measuredTotalDelayTwo = measuredFirDelayTwo + measuredAdaaDelayTwo;
    const double measuredTotalDelayFour = measuredFirDelayFour + measuredAdaaDelayFour;
    std::printf("F07 measured 1 kHz delay: FIR 2x=%.6f 4x=%.6f; total ADAA 2x=%.6f 4x=%.6f\n",
                measuredFirDelayTwo, measuredFirDelayFour,
                measuredTotalDelayTwo, measuredTotalDelayFour);
    check(phaseSetup && std::fabs(measuredFirDelayTwo - 14.5) < 0.05 &&
              std::fabs(measuredFirDelayFour - 21.75) < 0.05 &&
              std::fabs(measuredAdaaDelayTwo - 0.25) < 0.05 &&
              std::fabs(measuredAdaaDelayFour - 0.125) < 0.05 &&
              std::fabs(measuredTotalDelayTwo - 14.75) < 0.05 &&
              std::fabs(measuredTotalDelayFour - 21.875) < 0.05,
          "F07 measured FIR, ADAA, and combined 1 kHz group delays match the report");
    check(!twoX.setDrive(std::numeric_limits<float>::infinity()) &&
              !twoX.processBlock(nullptr, nullptr, 1),
          "F07 rejects non-finite controls and invalid process buffers");

    constexpr std::size_t analysisFrames = 16384;
    constexpr std::size_t warmupFrames = 4096;
    constexpr std::size_t totalFrames = analysisFrames + warmupFrames;
    constexpr std::size_t fundamentalBin = 1792; // 5.25 kHz at 48 kHz / 16,384.
    constexpr std::size_t ninthHarmonicAliasBin = 256; // 750 Hz alias of the 9th harmonic.
    AdaaCubicShaper oneX;
    check(oneX.prepare(spec) && oneX.setDrive(10.0f), "F07 one-times ADAA reference setup");
    twoX.reset();
    fourX.reset();
    std::array<float, analysisFrames> oneXOutput{};
    std::array<float, analysisFrames> naiveOutput{};
    std::array<float, analysisFrames> twoXOutput{};
    std::array<float, analysisFrames> fourXOutput{};
    for (std::size_t frame = 0; frame < totalFrames; ++frame) {
        const float input = static_cast<float>(0.8 * std::sin(
            2.0 * 3.14159265358979323846 * 5250.0 * frame / sampleRate));
        const float one = oneX.processSample(input);
        const float driven = input * 10.0f;
        const float naive = driven >= 1.0f ? 1.0f :
            (driven <= -1.0f ? -1.0f : 1.5f * driven - 0.5f * driven * driven * driven);
        const float two = twoX.processSample(input);
        const float four = fourX.processSample(input);
        if (frame >= warmupFrames) {
            const auto index = frame - warmupFrames;
            oneXOutput[index] = one;
            naiveOutput[index] = naive;
            twoXOutput[index] = two;
            fourXOutput[index] = four;
        }
    }
    const double aliasOne = magnitudeAtBin(oneXOutput.data(), analysisFrames,
                                            ninthHarmonicAliasBin);
    const double aliasNaive = magnitudeAtBin(naiveOutput.data(), analysisFrames,
                                              ninthHarmonicAliasBin);
    const double aliasTwo = magnitudeAtBin(twoXOutput.data(), analysisFrames,
                                            ninthHarmonicAliasBin);
    const double aliasFour = magnitudeAtBin(fourXOutput.data(), analysisFrames,
                                             ninthHarmonicAliasBin);
    const double fundamentalTwo = magnitudeAtBin(twoXOutput.data(), analysisFrames,
                                                  fundamentalBin);
    const double fundamentalFour = magnitudeAtBin(fourXOutput.data(), analysisFrames,
                                                   fundamentalBin);
    std::printf("F07 750 Hz aliased harmonic magnitude: naive=%.9g 1xADAA=%.9g 2x=%.9g 4x=%.9g\n",
                aliasNaive, aliasOne, aliasTwo, aliasFour);
    check(aliasTwo < aliasNaive * 0.001 && aliasTwo < aliasOne,
          "F07 2x oversampling suppresses a measured fold versus clipping and 1x ADAA");
    check(aliasFour < aliasNaive * 0.001 && aliasFour < aliasOne,
          "F07 4x oversampling suppresses a measured fold versus clipping and 1x ADAA");
    check(fundamentalTwo > 0.1 && fundamentalFour > 0.1 &&
              std::fabs(fundamentalTwo - fundamentalFour) < 0.12,
          "F07 oversampled output preserves in-band fundamental level");

    constexpr std::array<std::uint32_t, 3> additionalFundamentalBins{{2389, 3413, 4779}};
    std::array<AliasMetrics, additionalFundamentalBins.size()> additionalAliasMetrics{};
    for (std::size_t caseIndex = 0; caseIndex < additionalFundamentalBins.size(); ++caseIndex) {
        const auto toneBin = additionalFundamentalBins[caseIndex];
        auto& metrics = additionalAliasMetrics[caseIndex];
        metrics.fundamentalBin = toneBin;
        metrics.frequencyHz = static_cast<double>(toneBin) * sampleRate / analysisFrames;
        const auto rawAliasBin = static_cast<std::uint32_t>(
            (9ULL * toneBin) % analysisFrames);
        metrics.foldedHarmonicBin = rawAliasBin > analysisFrames / 2
            ? static_cast<std::uint32_t>(analysisFrames) - rawAliasBin : rawAliasBin;
        AdaaCubicShaper additionalOneX;
        OversampledNonlinear additionalTwoX;
        OversampledNonlinear additionalFourX;
        bool prepared = additionalOneX.prepare(spec) && additionalOneX.setDrive(10.0f) &&
            additionalTwoX.prepare(spec, OversamplingFactor::x2, NonlinearModel::AdaaCubic) &&
            additionalTwoX.setDrive(10.0f) &&
            additionalFourX.prepare(spec, OversamplingFactor::x4, NonlinearModel::AdaaCubic) &&
            additionalFourX.setDrive(10.0f);
        std::array<float, analysisFrames> additionalNaive{};
        std::array<float, analysisFrames> additionalOne{};
        std::array<float, analysisFrames> additionalTwo{};
        std::array<float, analysisFrames> additionalFour{};
        for (std::size_t frame = 0; frame < warmupFrames + analysisFrames; ++frame) {
            const float input = static_cast<float>(0.8 * std::sin(
                2.0 * 3.14159265358979323846 * toneBin * frame / analysisFrames));
            const float driven = input * 10.0f;
            const float naive = driven >= 1.0f ? 1.0f :
                (driven <= -1.0f ? -1.0f : 1.5f * driven - 0.5f * driven * driven * driven);
            const float one = additionalOneX.processSample(input);
            const float two = additionalTwoX.processSample(input);
            const float four = additionalFourX.processSample(input);
            if (frame >= warmupFrames) {
                const auto index = frame - warmupFrames;
                additionalNaive[index] = naive;
                additionalOne[index] = one;
                additionalTwo[index] = two;
                additionalFour[index] = four;
            }
        }
        metrics.memoryless = magnitudeAtBin(additionalNaive.data(), analysisFrames,
                                             metrics.foldedHarmonicBin);
        metrics.adaa1x = magnitudeAtBin(additionalOne.data(), analysisFrames,
                                         metrics.foldedHarmonicBin);
        metrics.oversample2x = magnitudeAtBin(additionalTwo.data(), analysisFrames,
                                               metrics.foldedHarmonicBin);
        metrics.oversample4x = magnitudeAtBin(additionalFour.data(), analysisFrames,
                                               metrics.foldedHarmonicBin);
        std::printf("F07 folded harmonic tone %.2f Hz at bin %u: memoryless=%.9g 1xADAA=%.9g 2x=%.9g 4x=%.9g\n",
                    metrics.frequencyHz, metrics.foldedHarmonicBin, metrics.memoryless,
                    metrics.adaa1x, metrics.oversample2x, metrics.oversample4x);
        check(prepared && metrics.memoryless > 1.0e-7 &&
                  metrics.oversample2x < metrics.memoryless &&
                  metrics.oversample4x < metrics.memoryless,
              "F07 2x/4x oversampling reduces a measured ninth-harmonic fold at additional coherent tones");
    }

    constexpr std::uint32_t imdToneBinA = 1300;
    constexpr std::uint32_t imdToneBinB = 1638;
    constexpr std::uint32_t imdLowerBin = 2 * imdToneBinA - imdToneBinB;
    constexpr std::uint32_t imdUpperBin = 2 * imdToneBinB - imdToneBinA;
    AdaaCubicShaper imdOneX;
    OversampledNonlinear imdTwoX;
    OversampledNonlinear imdFourX;
    const bool imdPrepared = imdOneX.prepare(spec) && imdOneX.setDrive(5.0f) &&
        imdTwoX.prepare(spec, OversamplingFactor::x2, NonlinearModel::AdaaCubic) &&
        imdTwoX.setDrive(5.0f) &&
        imdFourX.prepare(spec, OversamplingFactor::x4, NonlinearModel::AdaaCubic) &&
        imdFourX.setDrive(5.0f);
    std::array<float, analysisFrames> imdOutputOne{};
    std::array<float, analysisFrames> imdOutputTwo{};
    std::array<float, analysisFrames> imdOutputFour{};
    for (std::size_t frame = 0; frame < warmupFrames + analysisFrames; ++frame) {
        const double phaseA = 2.0 * 3.14159265358979323846 * imdToneBinA * frame / analysisFrames;
        const double phaseB = 2.0 * 3.14159265358979323846 * imdToneBinB * frame / analysisFrames;
        const float input = static_cast<float>(0.4 * std::sin(phaseA) + 0.4 * std::sin(phaseB));
        const float one = imdOneX.processSample(input);
        const float two = imdTwoX.processSample(input);
        const float four = imdFourX.processSample(input);
        if (frame >= warmupFrames) {
            const auto index = frame - warmupFrames;
            imdOutputOne[index] = one;
            imdOutputTwo[index] = two;
            imdOutputFour[index] = four;
        }
    }
    ImdMetrics imdMetrics;
    imdMetrics.lowerProductHz = static_cast<double>(imdLowerBin) * sampleRate / analysisFrames;
    imdMetrics.upperProductHz = static_cast<double>(imdUpperBin) * sampleRate / analysisFrames;
    imdMetrics.lowerMagnitude = {{
        magnitudeAtBin(imdOutputOne.data(), analysisFrames, imdLowerBin),
        magnitudeAtBin(imdOutputTwo.data(), analysisFrames, imdLowerBin),
        magnitudeAtBin(imdOutputFour.data(), analysisFrames, imdLowerBin)}};
    imdMetrics.upperMagnitude = {{
        magnitudeAtBin(imdOutputOne.data(), analysisFrames, imdUpperBin),
        magnitudeAtBin(imdOutputTwo.data(), analysisFrames, imdUpperBin),
        magnitudeAtBin(imdOutputFour.data(), analysisFrames, imdUpperBin)}};
    std::printf("F07 dual-tone IMD products %.2f/%.2f Hz (1x,2x,4x): lower=%.7g/%.7g/%.7g upper=%.7g/%.7g/%.7g\n",
                imdMetrics.lowerProductHz, imdMetrics.upperProductHz,
                imdMetrics.lowerMagnitude[0], imdMetrics.lowerMagnitude[1], imdMetrics.lowerMagnitude[2],
                imdMetrics.upperMagnitude[0], imdMetrics.upperMagnitude[1], imdMetrics.upperMagnitude[2]);
    const auto relativeDifference = [](double value, double reference) {
        return std::fabs(value - reference) / std::max(std::fabs(reference), 1.0e-12);
    };
    check(imdPrepared && imdMetrics.lowerMagnitude[0] > 0.001 &&
              imdMetrics.upperMagnitude[0] > 0.001 &&
              relativeDifference(imdMetrics.lowerMagnitude[1], imdMetrics.lowerMagnitude[0]) < 0.35 &&
              relativeDifference(imdMetrics.lowerMagnitude[2], imdMetrics.lowerMagnitude[0]) < 0.35 &&
              relativeDifference(imdMetrics.upperMagnitude[1], imdMetrics.upperMagnitude[0]) < 0.35 &&
              relativeDifference(imdMetrics.upperMagnitude[2], imdMetrics.upperMagnitude[0]) < 0.35,
          "F07 oversampling preserves measurable in-band dual-tone third-order IMD products");

    constexpr std::size_t splitFrames = 1024;
    const auto checkBlockSplit = [&](OversamplingFactor factor, NonlinearModel model) {
        OversampledNonlinear samplePath;
        OversampledNonlinear blockPath;
        bool valid = samplePath.prepare(spec, factor, model) &&
                     blockPath.prepare(spec, factor, model);
        if (model == NonlinearModel::AdaaCubic) {
            valid = valid && samplePath.setDrive(3.0f) && blockPath.setDrive(3.0f);
        } else {
            valid = valid && samplePath.setDiodeParameters(1200.0, 3.0e-9, 0.031, 1.2) &&
                    blockPath.setDiodeParameters(1200.0, 3.0e-9, 0.031, 1.2);
        }
        // Keep the array extent literal here: MSVC's C++17 frontend does not
        // treat a lambda-local constexpr as a valid non-type template argument.
        std::array<float, 1024> inputSamples{};
        std::array<float, 1024> sampleOutput{};
        std::array<float, 1024> blockOutput{};
        for (std::size_t i = 0; i < splitFrames; ++i) {
            inputSamples[i] = 0.45f * std::sin(static_cast<float>(0.037 * i)) +
                              0.2f * std::cos(static_cast<float>(0.011 * i));
        }
        const std::uint32_t chunks[] = {64, 128, 256};
        std::size_t offset = 0;
        unsigned chunk = 0;
        while (offset < splitFrames) {
            const auto frames = static_cast<std::uint32_t>(std::min<std::size_t>(
                chunks[chunk % 3U], splitFrames - offset));
            if (model == NonlinearModel::AdaaCubic) {
                const float drive = chunk % 2U == 0U ? 4.0f : 2.5f;
                valid = valid && samplePath.setDrive(drive) && blockPath.setDrive(drive);
            } else if (chunk % 2U == 0U) {
                valid = valid && samplePath.setDiodeParameters(1200.0 + chunk * 2.0,
                    3.0e-9, 0.031, 1.2) && blockPath.setDiodeParameters(
                    1200.0 + chunk * 2.0, 3.0e-9, 0.031, 1.2);
            }
            for (std::uint32_t i = 0; i < frames; ++i) {
                sampleOutput[offset + i] = samplePath.processSample(inputSamples[offset + i]);
            }
            valid = valid && blockPath.processBlock(inputSamples.data() + offset,
                blockOutput.data() + offset, frames);
            for (std::uint32_t i = 0; i < frames; ++i) {
                valid = valid && sampleOutput[offset + i] == blockOutput[offset + i];
            }
            offset += frames;
            ++chunk;
        }
        return valid;
    };
    check(checkBlockSplit(OversamplingFactor::x2, NonlinearModel::AdaaCubic) &&
              checkBlockSplit(OversamplingFactor::x4, NonlinearModel::AdaaCubic) &&
              checkBlockSplit(OversamplingFactor::x2, NonlinearModel::WdfSymmetricDiode) &&
              checkBlockSplit(OversamplingFactor::x4, NonlinearModel::WdfSymmetricDiode),
          "F07/F23 sample-stream and 64/128/256 block paths produce identical PCM across automation boundaries");

    OversampledNonlinear diodeFourX;
    check(diodeFourX.prepare(spec, OversamplingFactor::x4,
                             NonlinearModel::WdfSymmetricDiode) &&
              diodeFourX.setDiodeParameters(1000.0, 2.0e-9, 0.02585, 1.0),
          "F07 oversampled WDF distortion path prepares with explicit model parameters");
    std::array<float, 256> impulse{};
    std::array<float, 256> impulseOutput{};
    impulse[0] = 0.001f;
    check(diodeFourX.processBlock(impulse.data(), impulseOutput.data(),
                                  static_cast<std::uint32_t>(impulse.size())),
          "F07/F23 oversampled WDF block process");
    check(std::all_of(impulseOutput.begin(), impulseOutput.end(),
                      [](float value) { return std::isfinite(value); }),
          "F07/F23 nonlinear output remains finite through filter startup");
    check(!diodeFourX.processBlock(impulse.data(), impulseOutput.data(), 257),
          "F07 oversampler rejects blocks beyond prepared maximum");

    std::array<float, 256> rtInput{};
    std::array<float, 256> rtOutput{};
    for (std::size_t i = 0; i < rtInput.size(); ++i) {
        rtInput[i] = 0.35f * std::sin(static_cast<float>(0.071 * i));
    }
    bool rtConfiguration = diodeFourX.setDiodeParameters(1000.0, 2.0e-9, 0.02585, 1.0);
    gAllocationCount.store(0, std::memory_order_relaxed);
    gCountAllocations.store(true, std::memory_order_relaxed);
    std::uint64_t processedFrames = 0;
    for (int block = 0; block < 36; ++block) {
        const std::uint32_t frames = block % 3 == 0 ? 64U : (block % 3 == 1 ? 128U : 256U);
        if (block % 4 == 0) {
            rtConfiguration = rtConfiguration && diodeFourX.setDiodeParameters(
                1000.0 + block * 5.0, 2.0e-9, 0.02585, 1.0);
        }
        rtConfiguration = rtConfiguration && diodeFourX.processBlock(
            rtInput.data(), rtOutput.data(), frames);
        processedFrames += frames;
    }
    gCountAllocations.store(false, std::memory_order_relaxed);
    check(rtConfiguration && processedFrames > 4096,
          "F07/F23 automation and varied block sizes process after prepare");
    check(gAllocationCount.load(std::memory_order_relaxed) == 0,
          "F07/F23 nonlinear processing and parameter updates allocate no heap memory");

    if (const char* metricsPath = std::getenv("WEBRC_DSP_NONLINEAR_JSON");
        metricsPath && metricsPath[0] != '\0') {
        std::ofstream report(metricsPath, std::ios::out | std::ios::trunc);
        if (!report) {
            check(false, "F07 nonlinear metric report opens for writing");
        } else {
            report.precision(12);
            report << "{\n"
                    << "  \"schemaVersion\": 1,\n"
                    << "  \"scope\": \"shared-core nonlinear measurements; software-only; no device/XRUN claim\",\n"
                    << "  \"sampleRateHz\": " << sampleRate << ",\n"
                    << "  \"wdfParameterGridCases\": " << wdfParameterCases << ",\n"
                    << "  \"firImpulseEnergyCentroidBaseSamples\": {\"x2\": "
                    << measuredTwoXCentroid << ", \"x4\": " << measuredFourXCentroid << "},\n"
                    << "  \"phaseDelayAtHz\": {\"frequencyHz\": 1000, \"firOnlyBaseSamples\": {\"x2\": "
                    << measuredFirDelayTwo << ", \"x4\": " << measuredFirDelayFour
                    << "}, \"adaaExtraBaseSamples\": {\"x2\": " << measuredAdaaDelayTwo
                    << ", \"x4\": " << measuredAdaaDelayFour << "}, \"totalBaseSamples\": {\"x2\": "
                    << measuredTotalDelayTwo << ", \"x4\": " << measuredTotalDelayFour << "}},\n"
                    << "  \"foldedHarmonicAtHz\": 750,\n"
                    << "  \"aliasMagnitude\": {\"memoryless\": " << aliasNaive
                    << ", \"adaa1x\": " << aliasOne << ", \"oversample2x\": " << aliasTwo
                    << ", \"oversample4x\": " << aliasFour << "},\n"
                    << "  \"additionalCoherentToneAliasMagnitude\": [\n";
            for (std::size_t index = 0; index < additionalAliasMetrics.size(); ++index) {
                const auto& measurement = additionalAliasMetrics[index];
                report << "    {\"toneBin\": " << measurement.fundamentalBin
                       << ", \"frequencyHz\": " << measurement.frequencyHz
                       << ", \"foldedHarmonicBin\": " << measurement.foldedHarmonicBin
                       << ", \"memoryless\": " << measurement.memoryless
                       << ", \"adaa1x\": " << measurement.adaa1x
                       << ", \"oversample2x\": " << measurement.oversample2x
                       << ", \"oversample4x\": " << measurement.oversample4x << "}"
                       << (index + 1U == additionalAliasMetrics.size() ? "\n" : ",\n");
            }
            report << "  ],\n"
                    << "  \"dualToneImd\": {\"inputBins\": [" << imdToneBinA << ", " << imdToneBinB
                    << "], \"productHz\": [" << imdMetrics.lowerProductHz << ", "
                    << imdMetrics.upperProductHz << "], \"lowerProductMagnitude1x2x4x\": ["
                    << imdMetrics.lowerMagnitude[0] << ", " << imdMetrics.lowerMagnitude[1] << ", "
                    << imdMetrics.lowerMagnitude[2] << "], \"upperProductMagnitude1x2x4x\": ["
                    << imdMetrics.upperMagnitude[0] << ", " << imdMetrics.upperMagnitude[1] << ", "
                    << imdMetrics.upperMagnitude[2] << "]},\n"
                    << "  \"inBandFundamentalMagnitude\": {\"x2\": " << fundamentalTwo
                    << ", \"x4\": " << fundamentalFour << "},\n"
                    << "  \"testsPassed\": " << (gFailures == 0 ? "true" : "false") << "\n"
                    << "}\n";
            if (!report) check(false, "F07 nonlinear metric report writes complete JSON");
        }
    }

    if (gFailures != 0) {
        std::fprintf(stderr, "%d nonlinear test(s) failed\n", gFailures);
        return 1;
    }
    std::puts("Nonlinear/WDF tests passed");
    return 0;
}
