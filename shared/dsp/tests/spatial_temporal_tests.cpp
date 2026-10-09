#include "webrc/dsp/fft.hpp"
#include "webrc/dsp/spatial_temporal.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <complex>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <vector>

namespace {

std::atomic<bool> gCountRuntimeAllocations{false};
std::atomic<std::uint64_t> gRuntimeNewCount{0};
std::atomic<std::uint64_t> gRuntimeDeleteCount{0};
int gFailures = 0;

void check(bool condition, const char* name) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", name);
        ++gFailures;
    }
}

bool near(float actual, float expected, float tolerance) {
    return std::isfinite(actual) && std::abs(actual - expected) <= tolerance;
}

void testFftRoundTrip() {
    constexpr std::size_t size = 512;
    std::array<std::complex<float>, size> values{};
    std::array<float, size> original{};
    for (std::size_t i = 0; i < size; ++i) {
        original[i] = static_cast<float>(0.35 * std::sin(2.0 * 3.141592653589793 * 17.0 * i / size) +
                                         0.17 * std::cos(2.0 * 3.141592653589793 * 53.0 * i / size));
        values[i] = {original[i], 0.0f};
    }
    check(webrc::dsp::fft::isPowerOfTwo(size), "FFT accepts power-of-two size");
    check(!webrc::dsp::fft::isPowerOfTwo(511), "FFT rejects non-power-of-two size");
    check(webrc::dsp::fft::transform(values.data(), size, webrc::dsp::fft::Direction::Forward),
          "forward FFT succeeds");
    check(webrc::dsp::fft::transform(values.data(), size, webrc::dsp::fft::Direction::Inverse),
          "inverse FFT succeeds");
    double error = 0.0;
    for (std::size_t i = 0; i < size; ++i) {
        error = std::max(error, std::abs(static_cast<double>(values[i].real() - original[i])));
        check(std::abs(values[i].imag()) < 2.0e-5f, "FFT round-trip imaginary residual is small");
    }
    check(error < 2.0e-5, "FFT round-trip reconstructs identity");
    values[7] = {std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN()};
    check(webrc::dsp::fft::transform(values.data(), size, webrc::dsp::fft::Direction::Forward),
          "FFT sanitizes non-finite input");
    for (const auto& value : values) {
        check(std::isfinite(value.real()) && std::isfinite(value.imag()), "FFT output stays finite");
    }
    std::array<std::complex<float>, 1> singleton{{{1.0e-39f, -1.0e-39f}}};
    check(webrc::dsp::fft::transform(singleton.data(), singleton.size(),
                                     webrc::dsp::fft::Direction::Forward) &&
          singleton[0] == std::complex<float>{0.0f, 0.0f},
          "FFT flushes subnormal scalar values");
    check(!webrc::dsp::fft::transform(values.data(), size, static_cast<webrc::dsp::fft::Direction>(99)),
          "FFT rejects invalid transform directions");

    constexpr std::size_t randomSize = 128;
    std::array<std::complex<float>, randomSize> randomSpectrum{};
    std::array<float, randomSize> randomInput{};
    std::uint32_t randomState = 0x1234abcdU;
    for (std::size_t i = 0; i < randomSize; ++i) {
        randomState = randomState * 1664525U + 1013904223U;
        const float noise = static_cast<float>(randomState >> 8) * (2.0f / 16777216.0f) - 1.0f;
        randomInput[i] = 0.65f * noise + static_cast<float>(0.25 * std::sin(
            2.0 * 3.141592653589793 * (5.0 * i + 0.015 * i * i) / randomSize));
        randomSpectrum[i] = {randomInput[i], 0.0f};
    }
    check(webrc::dsp::fft::transform(randomSpectrum.data(), randomSize,
                                     webrc::dsp::fft::Direction::Forward),
          "FFT transforms deterministic noise and swept tone");
    double maximumDftError = 0.0;
    for (std::size_t bin = 0; bin < randomSize; ++bin) {
        std::complex<double> reference{};
        for (std::size_t sample = 0; sample < randomSize; ++sample) {
            const double phase = -2.0 * 3.14159265358979323846 * bin * sample / randomSize;
            reference += static_cast<double>(randomInput[sample]) *
                         std::complex<double>(std::cos(phase), std::sin(phase));
        }
        const std::complex<double> actual(randomSpectrum[bin].real(), randomSpectrum[bin].imag());
        maximumDftError = std::max(maximumDftError, std::abs(actual - reference));
    }
    check(maximumDftError < 2.0e-4, "FFT bins match independent direct DFT reference");
}

void testNormalizedHadamard() {
    using namespace webrc::dsp;
    std::array<float, 16> values{};
    double inputEnergy = 0.0;
    for (std::size_t i = 0; i < values.size(); ++i) {
        values[i] = static_cast<float>(std::sin(static_cast<double>(i) * 0.61) +
                                       0.3 * std::cos(static_cast<double>(i) * 0.19));
        inputEnergy += values[i] * values[i];
    }
    const auto original = values;
    check(normalizedHadamard(values.data(), 16), "16-line Hadamard transform accepted");
    double outputEnergy = 0.0;
    for (const auto value : values) outputEnergy += value * value;
    check(std::abs(outputEnergy - inputEnergy) < 2.0e-5, "single-normalized Hadamard preserves energy");
    check(normalizedHadamard(values.data(), 16), "second 16-line Hadamard transform accepted");
    double inverseError = 0.0;
    for (std::size_t i = 0; i < values.size(); ++i) {
        inverseError = std::max(inverseError, std::abs(static_cast<double>(values[i] - original[i])));
    }
    check(inverseError < 2.0e-6, "orthonormal Hadamard is self-inverse");
    check(!normalizedHadamard(values.data(), 12), "unsupported Hadamard size rejected");
}

void testPrepareBudgetEstimates() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256, 2};
    const ProcessSpec maximumSpec{384000.0f, 8192, 2};
    check(PartitionedConvolver::requiredPrepareBytes(32, 51) > kPrepareAllocatorAllowanceBytes,
          "convolver estimator includes payload and allocator allowance");
    check(PartitionedConvolver::requiredPrepareBytes(31, 51) == 0 &&
          PartitionedConvolver::requiredPrepareBytes(32, std::numeric_limits<std::uint32_t>::max()) == 0,
          "convolver estimator rejects invalid partitions and overflowing IR lengths");
    check(FdnReverb::requiredPrepareBytes(spec, FdnLineCount::Eight) > kPrepareAllocatorAllowanceBytes,
          "FDN estimator includes line and early-ring payload");
    check(FdnReverb::requiredPrepareBytes(maximumSpec, FdnLineCount::Sixteen, 2.0f) == 0,
          "FDN estimator rejects a delay request above its memory cap");
    check(GranularTexture::requiredPrepareBytes(spec, 0.5f) > kPrepareAllocatorAllowanceBytes &&
          GranularTexture::requiredPrepareBytes(maximumSpec, 9.0f) == 0,
          "grain estimator accounts for stereo capture and rejects oversized capture");
    check(SpectralFreeze::requiredPrepareBytes(spec, 1024, 256) > kPrepareAllocatorAllowanceBytes &&
          SpectralFreeze::requiredPrepareBytes(spec, 1024, 300) == 0,
          "freeze estimator accepts supported STFT and rejects invalid overlap geometry");
    check(ReverseSegment::requiredPrepareBytes(spec, 8192) > kPrepareAllocatorAllowanceBytes &&
          ReverseSegment::requiredPrepareBytes(maximumSpec, 3000000) == 0,
          "reverse estimator includes stereo ring and rejects oversized history");
}

void testPartitionedConvolution() {
    using namespace webrc::dsp;
    constexpr std::uint32_t frames = 512;
    constexpr std::uint32_t partition = 32;
    constexpr std::uint32_t irFrames = 51;
    const ProcessSpec spec{48000.0f, 64, 2};
    std::array<float, irFrames> ll{};
    std::array<float, irFrames> lr{};
    std::array<float, irFrames> rl{};
    std::array<float, irFrames> rr{};
    ll[0] = 0.75f; ll[1] = 0.2f; ll[17] = -0.1f; ll[50] = 0.03f;
    lr[0] = 0.11f; lr[18] = 0.07f;
    rl[0] = -0.09f; rl[3] = 0.04f;
    rr[0] = 0.9f; rr[8] = -0.13f; rr[49] = 0.02f;
    std::array<float, frames> inputLeft{};
    std::array<float, frames> inputRight{};
    std::array<float, frames> outputLeft{};
    std::array<float, frames> outputRight{};
    inputLeft[0] = 1.0f;
    inputRight[0] = -0.5f;
    for (std::uint32_t i = 1; i < 100; ++i) {
        inputLeft[i] += 0.25f * std::sin(static_cast<float>(i) * 0.17f);
        inputRight[i] += 0.2f * std::cos(static_cast<float>(i) * 0.13f);
    }
    PartitionedConvolver convolver;
    check(convolver.prepare(spec, partition, irFrames, ll.data(), lr.data(), rl.data(), rr.data()),
          "partitioned convolver prepares true stereo matrix IR");
    PartitionedConvolver rejectsHuge;
    check(!rejectsHuge.prepare(spec, 2048, std::numeric_limits<std::uint32_t>::max(), ll.data(),
                               nullptr, nullptr, nullptr),
          "convolver rejects uint32 maximum IR length before reading IR memory");
    check(convolver.algorithmicLatencySamples() == partition, "partitioned convolver reports partition latency");
    for (std::uint32_t offset = 0; offset < frames; offset += spec.maxBlockFrames) {
        check(convolver.processBlock(inputLeft.data() + offset, inputRight.data() + offset,
                                     outputLeft.data() + offset, outputRight.data() + offset,
                                     spec.maxBlockFrames), "partitioned convolver processes fixed block");
    }
    double maxErrorLeft = 0.0;
    double maxErrorRight = 0.0;
    std::uint32_t firstBadLeft = frames;
    std::uint32_t firstBadRight = frames;
    for (std::uint32_t time = 0; time + partition < frames; ++time) {
        const std::uint32_t outputTime = time + partition;
        double expectedLeft = 0.0;
        double expectedRight = 0.0;
        for (std::uint32_t tap = 0; tap < irFrames && tap <= time; ++tap) {
            const auto inputIndex = time - tap;
            expectedLeft += ll[tap] * inputLeft[inputIndex] + lr[tap] * inputRight[inputIndex];
            expectedRight += rl[tap] * inputLeft[inputIndex] + rr[tap] * inputRight[inputIndex];
        }
        const auto errorLeft = std::abs(expectedLeft - outputLeft[outputTime]);
        const auto errorRight = std::abs(expectedRight - outputRight[outputTime]);
        if (errorLeft > maxErrorLeft) maxErrorLeft = errorLeft;
        if (errorRight > maxErrorRight) maxErrorRight = errorRight;
        if (errorLeft > 2.0e-4 && firstBadLeft == frames) firstBadLeft = time;
        if (errorRight > 2.0e-4 && firstBadRight == frames) firstBadRight = time;
    }
    check(maxErrorLeft < 2.0e-4, "partitioned convolution matches direct matrix convolution left");
    check(maxErrorRight < 2.0e-4, "partitioned convolution matches direct matrix convolution right");
    if (maxErrorLeft >= 2.0e-4 || maxErrorRight >= 2.0e-4) {
        std::fprintf(stderr, "Convolver max errors L=%.9g R=%.9g; first outputs %.6f %.6f %.6f %.6f\n",
                     maxErrorLeft, maxErrorRight, outputLeft[partition], outputLeft[partition + 1],
                     outputRight[partition], outputRight[partition + 1]);
        std::fprintf(stderr, "Convolver first mismatch input-time L=%u R=%u output=%.6f,%.6f\n",
                     firstBadLeft, firstBadRight,
                     firstBadLeft + partition < frames ? outputLeft[firstBadLeft + partition] : 0.0f,
                     firstBadRight + partition < frames ? outputRight[firstBadRight + partition] : 0.0f);
    }
    check(std::all_of(outputLeft.begin(), outputLeft.end(), [](float x) { return std::isfinite(x); }),
          "partitioned convolution impulse stays finite");

    std::array<float, 64> inPlaceL{};
    std::array<float, 64> inPlaceR{};
    inPlaceL[0] = 0.5f;
    PartitionedConvolver inPlace;
    check(inPlace.prepare(spec, partition, 1, ll.data(), nullptr, nullptr, rr.data()),
          "in-place convolver prepares");
    check(inPlace.processBlock(inPlaceL.data(), inPlaceR.data(), inPlaceL.data(), inPlaceR.data(), 64),
          "partitioned convolver supports exact in-place buffers");
}

struct FdnMetrics {
    double energy = 0.0;
    double leftEnergy = 0.0;
    double rightEnergy = 0.0;
    double crossEnergy = 0.0;
    double maximum = 0.0;
    std::vector<float> left;
    std::vector<float> right;
};

FdnMetrics renderFdn(float dampingHz, webrc::dsp::FdnLineCount lines) {
    using namespace webrc::dsp;
    constexpr std::uint32_t total = 96000;
    const ProcessSpec spec{48000.0f, 64, 2};
    FdnReverb reverb;
    reverb.prepare(spec, lines, 0.12f);
    reverb.setParameters(1.0f, dampingHz, 0.23f, 0.18f, 0.9995f, 1.0f, 0.0f);
    FdnMetrics metrics;
    metrics.left.resize(total);
    metrics.right.resize(total);
    for (std::uint32_t i = 0; i < total; ++i) {
        const auto output = reverb.processSample(i == 0 ? 1.0f : 0.0f, 0.0f);
        metrics.left[i] = output.left;
        metrics.right[i] = output.right;
        const double l = output.left;
        const double r = output.right;
        metrics.leftEnergy += l * l;
        metrics.rightEnergy += r * r;
        metrics.crossEnergy += l * r;
        metrics.energy += l * l + r * r;
        metrics.maximum = std::max(metrics.maximum, std::max(std::abs(l), std::abs(r)));
    }
    return metrics;
}

double rms(const std::vector<float>& samples, std::uint32_t begin, std::uint32_t end) {
    double energy = 0.0;
    for (std::uint32_t i = begin; i < end; ++i) {
        const double value = samples[i];
        energy += value * value;
    }
    return std::sqrt(energy / (end - begin));
}

double goertzelEnergy(const std::vector<float>& samples, std::uint32_t begin,
                      std::uint32_t end, double frequency, double sampleRate) {
    const double omega = 2.0 * 3.14159265358979323846 * frequency / sampleRate;
    const double coefficient = 2.0 * std::cos(omega);
    double s1 = 0.0;
    double s2 = 0.0;
    for (std::uint32_t i = begin; i < end; ++i) {
        const double s0 = samples[i] + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const double real = s1 - s2 * std::cos(omega);
    const double imag = s2 * std::sin(omega);
    return real * real + imag * imag;
}

double dominantFrequency(const std::vector<float>& samples, std::uint32_t begin,
                         std::uint32_t end, double minimumHz, double maximumHz,
                         double stepHz, double sampleRate) {
    double bestFrequency = minimumHz;
    double bestEnergy = -1.0;
    for (double frequency = minimumHz; frequency <= maximumHz; frequency += stepHz) {
        const double energy = goertzelEnergy(samples, begin, end, frequency, sampleRate);
        if (energy > bestEnergy) {
            bestEnergy = energy;
            bestFrequency = frequency;
        }
    }
    return bestFrequency;
}

struct DecayFit {
    double t20Seconds = 0.0;
    double t30Seconds = 0.0;
};

DecayFit bandDecayFit(const std::vector<float>& samples, double centerHz, double sampleRate) {
    const double omega = 2.0 * 3.14159265358979323846 * centerHz / sampleRate;
    const double cosine = std::cos(omega);
    const double alpha = std::sin(omega) / 2.0; // Q=1 band-pass section.
    const double inverseA0 = 1.0 / (1.0 + alpha);
    const double b0 = alpha * inverseA0;
    const double b2 = -alpha * inverseA0;
    const double a1 = -2.0 * cosine * inverseA0;
    const double a2 = (1.0 - alpha) * inverseA0;
    std::vector<double> energy(samples.size());
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        const double input = samples[i];
        const double output = b0 * input + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = input; y2 = y1; y1 = output;
        energy[i] = output * output;
    }
    double remaining = 0.0;
    for (auto it = energy.rbegin(); it != energy.rend(); ++it) {
        remaining += *it;
        *it = remaining;
    }
    const double total = energy.empty() ? 0.0 : energy.front();
    const auto crossing = [&](double targetDb) {
        const double targetRatio = std::pow(10.0, targetDb / 10.0);
        for (std::size_t i = 1; i < energy.size(); ++i) {
            if (energy[i] <= total * targetRatio && energy[i - 1] > total * targetRatio) {
                const double high = energy[i - 1];
                const double low = energy[i];
                const double fraction = (high == low) ? 0.0 :
                    (high - total * targetRatio) / (high - low);
                return (static_cast<double>(i - 1) + fraction) / sampleRate;
            }
        }
        return 0.0;
    };
    const double t5 = crossing(-5.0);
    const double t25 = crossing(-25.0);
    const double t35 = crossing(-35.0);
    return {(t25 - t5) * 3.0, (t35 - t5) * 2.0};
}

void testFdnReverb() {
    using namespace webrc::dsp;
    const auto eight = renderFdn(4500.0f, FdnLineCount::Eight);
    const auto sixteen = renderFdn(4500.0f, FdnLineCount::Sixteen);
    check(eight.energy > 0.01 && sixteen.energy > 0.01, "FDN8/16 respond to impulse");
    check(eight.maximum < 2.0 && sixteen.maximum < 2.0, "FDN8/16 feedback stays bounded");
    check(eight.leftEnergy > 0.0 && eight.rightEnergy > 0.0, "FDN has two nonzero stereo outputs");
    const double correlation = eight.crossEnergy / std::sqrt(eight.leftEnergy * eight.rightEnergy);
    check(std::abs(correlation) < 0.995, "FDN stereo impulse outputs are decorrelated");
    const double correlation16 = sixteen.crossEnergy /
        std::sqrt(sixteen.leftEnergy * sixteen.rightEnergy);
    check(std::abs(correlation16) < 0.995, "16-line FDN also produces two decorrelated outputs");
    check(rms(eight.left, 48000, 60000) < rms(eight.left, 4800, 12000),
          "FDN tail energy decays over time");

    const auto decay100 = bandDecayFit(eight.left, 100.0, 48000.0);
    const auto decay1k = bandDecayFit(eight.left, 1000.0, 48000.0);
    const auto decay4k = bandDecayFit(eight.left, 4000.0, 48000.0);
    const auto decay16_100 = bandDecayFit(sixteen.left, 100.0, 48000.0);
    const auto decay16_1k = bandDecayFit(sixteen.left, 1000.0, 48000.0);
    const auto decay16_4k = bandDecayFit(sixteen.left, 4000.0, 48000.0);
    check(decay100.t20Seconds > 0.2 && decay100.t20Seconds < 2.0 &&
          decay100.t30Seconds > 0.2 && decay100.t30Seconds < 2.0,
          "FDN 100-Hz band T20/T30 measures a bounded decay");
    check(decay1k.t20Seconds > 0.2 && decay1k.t20Seconds < 2.0 &&
          decay1k.t30Seconds > 0.2 && decay1k.t30Seconds < 2.0,
          "FDN 1-kHz band T20/T30 measures a bounded decay");
    check(decay4k.t20Seconds > 0.1 && decay4k.t20Seconds < 2.0 &&
          decay4k.t30Seconds > 0.1 && decay4k.t30Seconds < 2.0,
          "FDN 4-kHz band T20/T30 measures a bounded decay");
    check(decay4k.t20Seconds < decay100.t20Seconds * 1.5,
          "FDN damping bounds the 4-kHz band relative to low frequency");
    check(decay16_100.t20Seconds > 0.2 && decay16_100.t30Seconds > 0.2 &&
          decay16_1k.t20Seconds > 0.2 && decay16_1k.t30Seconds > 0.2 &&
          decay16_4k.t20Seconds > 0.1 && decay16_4k.t30Seconds > 0.1,
          "FDN16 produces measurable low/mid/high-band T20/T30");
    std::printf("FDN8 stereoCorr=%.5f band T20/T30 seconds: 100Hz %.3f/%.3f, 1kHz %.3f/%.3f, 4kHz %.3f/%.3f\n",
                correlation,
                decay100.t20Seconds, decay100.t30Seconds, decay1k.t20Seconds,
                decay1k.t30Seconds, decay4k.t20Seconds, decay4k.t30Seconds);
    std::printf("FDN16 stereoCorr=%.5f band T20/T30 seconds: 100Hz %.3f/%.3f, 1kHz %.3f/%.3f, 4kHz %.3f/%.3f\n",
                correlation16, decay16_100.t20Seconds, decay16_100.t30Seconds,
                decay16_1k.t20Seconds, decay16_1k.t30Seconds,
                decay16_4k.t20Seconds, decay16_4k.t30Seconds);

    FdnReverb early;
    check(early.prepare({48000.0f, 64, 2}, FdnLineCount::Eight), "FDN early FIR prepares");
    std::array<float, 8> earlyLL{};
    std::array<float, 8> earlyLR{};
    std::array<float, 8> earlyRL{};
    std::array<float, 8> earlyRR{};
    earlyLL[0] = 0.9f; earlyLR[0] = 0.2f;
    earlyRL[0] = -0.3f; earlyRR[0] = 0.8f;
    check(early.setEarlyImpulseResponse(static_cast<std::uint32_t>(earlyLL.size()),
                                        earlyLL.data(), earlyLR.data(),
                                        earlyRL.data(), earlyRR.data()), "FDN installs bounded 2x2 early FIR");
    check(early.setParameters(1.0f, 8000.0f, 0.0f, 0.0f, 0.999f, 1.0f, 0.0f),
          "FDN parameters accept disabled modulation");
    const auto earlyImpulse = early.processSample(1.0f, 0.5f);
    check(near(earlyImpulse.left, 1.0f, 1.0e-5f) && near(earlyImpulse.right, 0.1f, 1.0e-5f),
          "FDN early FIR uses distinct stereo matrix impulse taps");

    const auto dark = renderFdn(500.0f, FdnLineCount::Eight);
    const auto bright = renderFdn(12000.0f, FdnLineCount::Eight);
    const double darkEarly = goertzelEnergy(dark.left, 4800, 24000, 4000.0, 48000.0);
    const double darkLate = goertzelEnergy(dark.left, 48000, 67200, 4000.0, 48000.0);
    const double brightEarly = goertzelEnergy(bright.left, 4800, 24000, 4000.0, 48000.0);
    const double brightLate = goertzelEnergy(bright.left, 48000, 67200, 4000.0, 48000.0);
    const double darkRatio = darkLate / std::max(darkEarly, 1.0e-20);
    const double brightRatio = brightLate / std::max(brightEarly, 1.0e-20);
    check(darkRatio < brightRatio, "FDN damping shortens high-frequency RT60 band");
}

void testGranularDeterminism() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 64, 2};
    GranularTexture a;
    GranularTexture b;
    check(a.prepare(spec, 1.0f) && b.prepare(spec, 1.0f), "grain pools prepare");
    check(a.setParameters(80.0f, 40.0f, 1.25f, 0.5f, 0.8f, 91234) &&
          b.setParameters(80.0f, 40.0f, 1.25f, 0.5f, 0.8f, 91234), "grain parameters accept deterministic seed");
    bool exact = true;
    double energy = 0.0;
    for (std::uint32_t i = 0; i < 12000; ++i) {
        const float input = std::sin(static_cast<float>(i) * 0.021f) * 0.5f;
        const auto left = a.processSample(input, input * 0.4f);
        const auto right = b.processSample(input, input * 0.4f);
        exact = exact && left.left == right.left && left.right == right.right;
        energy += left.left * left.left + left.right * left.right;
        check(std::isfinite(left.left) && std::isfinite(left.right), "grain pool output finite");
    }
    check(exact, "same grain seed reproduces output exactly");
    check(a.activeGrains() > 0 && energy > 0.1, "grain pool runs active windows from continuous capture");

    GranularTexture singleGrain;
    check(singleGrain.prepare(spec, 0.1f), "single-grain edge case prepares");
    check(singleGrain.setParameters(20.0f, 1.0f, 1.0f, 0.0f, 1.0f, 17),
          "single-grain edge case uses wet-only deterministic parameters");
    bool observed = false;
    std::uint32_t age = 0;
    float first = 1.0f;
    float second = 1.0f;
    float last = 1.0f;
    float peak = 0.0f;
    for (std::uint32_t i = 0; i < 51000; ++i) {
        const auto output = singleGrain.processSample(0.75f, 0.75f);
        if (singleGrain.activeGrains() > 0) {
            if (!observed) {
                observed = true;
                first = output.left;
            } else if (age == 1) {
                second = output.left;
            }
            if (age < 960) {
                peak = std::max(peak, std::abs(output.left));
                last = output.left;
            }
            ++age;
        } else if (observed && age > 0) {
            break;
        }
    }
    check(observed && peak > 0.2f, "single granular window reaches a useful wet peak");
    check(std::abs(first) < 1.0e-7f && std::abs(last) < 1.0e-4f,
          "single grain uses Hann endpoints instead of edge normalization gain");
    check(std::abs(second) < 0.01f, "single grain opens smoothly at its first samples");
}

void testSpectralFreeze() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 64, 2};
    constexpr std::uint32_t window = 256;
    constexpr std::uint32_t total = 4096;
    SpectralFreeze freeze;
    check(freeze.prepare(spec, window, 64), "spectral freeze prepares fixed STFT");
    check(freeze.algorithmicLatencySamples() == window, "spectral freeze reports window latency");
    std::array<float, total> input{};
    std::array<float, total> inputR{};
    std::array<float, total> out{};
    std::array<float, total> outR{};
    for (std::uint32_t i = 0; i < total; ++i) {
        input[i] = 0.35f * std::sin(static_cast<float>(i) * 0.071f) + (i == 0 ? 0.5f : 0.0f);
        inputR[i] = 0.2f * std::cos(static_cast<float>(i) * 0.043f);
    }
    for (std::uint32_t offset = 0; offset < total; offset += spec.maxBlockFrames) {
        check(freeze.processBlock(input.data() + offset, inputR.data() + offset,
                                  out.data() + offset, outR.data() + offset, spec.maxBlockFrames),
              "spectral freeze bypass frame processed");
    }
    double maxError = 0.0;
    for (std::uint32_t i = window; i < total; ++i) {
        maxError = std::max(maxError, std::abs(static_cast<double>(out[i] - input[i - window])));
        maxError = std::max(maxError, std::abs(static_cast<double>(outR[i] - inputR[i - window])));
    }
    check(maxError < 4.0e-4, "STFT overlap-add reconstructs delayed identity");
    if (maxError >= 4.0e-4) {
        std::uint32_t worst = 0;
        double worstError = 0.0;
        for (std::uint32_t i = window; i < total; ++i) {
            const double error = std::abs(static_cast<double>(out[i] - input[i - window]));
            if (error > worstError) { worstError = error; worst = i; }
        }
        std::fprintf(stderr, "Freeze identity max error %.9g at %u output %.6f expected %.6f\n",
                     maxError, worst, out[worst], input[worst - window]);
    }

    freeze.reset();
    for (std::uint32_t i = 0; i < 1024; ++i) {
        (void)freeze.processSample(0.6f * std::sin(static_cast<float>(i) * 0.0576f),
                                   0.4f * std::cos(static_cast<float>(i) * 0.0576f));
    }
    check(freeze.setFreeze(true), "freeze toggle requests spectral capture");
    double frozenEnergy = 0.0;
    for (std::uint32_t i = 0; i < 2048; ++i) {
        const auto output = freeze.processSample(0.0f, 0.0f);
        frozenEnergy += output.left * output.left + output.right * output.right;
    }
    check(frozenEnergy > 0.1, "phase-locked frozen spectrum sustains after input ends");
    check(freeze.setFreeze(false), "spectral freeze releases");

    constexpr std::uint32_t freezeWindow = 1024;
    constexpr std::uint32_t hop = 256;
    constexpr std::uint32_t warmSamples = 4096;
    constexpr std::uint32_t measuredSamples = 16384;
    constexpr std::uint32_t totalSamples = 8192 + measuredSamples;
    SpectralFreeze pitchHold;
    check(pitchHold.prepare(spec, freezeWindow, hop) && pitchHold.setMix(1.0f),
          "non-bin spectral freeze prepares wet-only pitch test");
    std::vector<float> frozenLeft;
    std::vector<float> frozenRight;
    frozenLeft.reserve(warmSamples + totalSamples);
    frozenRight.reserve(warmSamples + totalSamples);
    const auto feedTone = [&](std::uint32_t frames) {
        for (std::uint32_t i = 0; i < frames; ++i) {
            const auto absolute = static_cast<double>(frozenLeft.size());
            const auto output = pitchHold.processSample(
                0.5f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 440.0 * absolute / 48000.0)),
                0.4f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 997.0 * absolute / 48000.0)));
            frozenLeft.push_back(output.left);
            frozenRight.push_back(output.right);
        }
    };
    feedTone(warmSamples);
    check(pitchHold.setFreeze(true),
          "non-bin spectral freeze captures the last complete frame at the event");
    // Stop the input on the exact freeze event. A later analysis hop therefore
    // contains silence and must not replace the last populated spectrum.
    for (std::uint32_t i = 0; i < totalSamples; ++i) {
        const auto output = pitchHold.processSample(0.0f, 0.0f);
        frozenLeft.push_back(output.left);
        frozenRight.push_back(output.right);
    }
    const std::uint32_t measureBegin = 8192;
    const std::uint32_t measureEnd = measureBegin + measuredSamples;
    const double leftFrequency = dominantFrequency(frozenLeft, measureBegin, measureEnd,
                                                   430.0, 450.0, 0.1, 48000.0);
    const double rightFrequency = dominantFrequency(frozenRight, measureBegin, measureEnd,
                                                    987.0, 1007.0, 0.1, 48000.0);
    const double earlyRms = rms(frozenLeft, measureBegin, measureBegin + 4096);
    const double lateRms = rms(frozenLeft, measureEnd - 4096, measureEnd);
    check(std::abs(leftFrequency - 440.0) <= 0.5 && std::abs(rightFrequency - 997.0) <= 0.5,
          "phase-locked freeze holds non-bin 440 Hz and 997 Hz after input stops at the trigger");
    check(earlyRms > 0.05 && lateRms > 0.05 &&
          lateRms / earlyRms > 0.65 && lateRms / earlyRms < 1.45,
          "frozen non-bin tones sustain with bounded amplitude drift");
    std::printf("Freeze held tones: L=%.1f Hz R=%.1f Hz; RMS %.5f -> %.5f\n",
                leftFrequency, rightFrequency, earlyRms, lateRms);
}

void testFreezeOverlapConfigurations() {
    using namespace webrc::dsp;
    struct Configuration { std::uint32_t window; std::uint32_t hop; };
    constexpr std::array<Configuration, 3> configurations{{{256, 128}, {512, 128}, {1024, 256}}};
    const ProcessSpec spec{48000.0f, 256, 2};
    constexpr std::uint32_t total = 8192;
    std::vector<float> input(total);
    std::vector<float> inputRight(total);
    std::vector<float> output(total);
    std::vector<float> outputRight(total);
    for (std::uint32_t i = 0; i < total; ++i) {
        input[i] = 0.3f * std::sin(static_cast<float>(i) * 0.031f) +
                   0.11f * std::cos(static_cast<float>(i) * 0.19f) + (i == 0 ? 0.5f : 0.0f);
        inputRight[i] = 0.24f * std::cos(static_cast<float>(i) * 0.057f);
    }
    constexpr std::array<std::uint32_t, 3> blocks{64, 128, 256};
    for (const auto config : configurations) {
        SpectralFreeze freeze;
        check(SpectralFreeze::requiredPrepareBytes(spec, config.window, config.hop) > 0,
              "freeze configuration reports its bounded prepare budget");
        check(freeze.prepare(spec, config.window, config.hop) && freeze.setMix(1.0f),
              "freeze overlap configuration prepares");
        std::uint32_t offset = 0;
        std::uint32_t blockIndex = 0;
        while (offset < total) {
            const auto frames = std::min(blocks[blockIndex++ % blocks.size()], total - offset);
            check(freeze.processBlock(input.data() + offset, inputRight.data() + offset,
                                      output.data() + offset, outputRight.data() + offset, frames),
                  "freeze handles variable blocks across STFT hops");
            offset += frames;
        }
        double maximumError = 0.0;
        for (std::uint32_t i = config.window; i < total; ++i) {
            maximumError = std::max(maximumError,
                std::max(std::abs(static_cast<double>(output[i] - input[i - config.window])),
                         std::abs(static_cast<double>(outputRight[i] - inputRight[i - config.window]))));
        }
        check(maximumError < 4.0e-4, "Hann WOLA reconstructs identity at selected N/H");
        check(freeze.algorithmicLatencySamples() == config.window,
              "freeze reports the tested STFT window latency");
        std::printf("Freeze WOLA N=%u H=%u maxIdentityError=%.8g\n",
                    config.window, config.hop, maximumError);
    }
}

void testReverseSegment() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 64, 2};
    constexpr std::uint32_t segment = 64;
    constexpr std::uint32_t crossfadeFrames = 8;
    std::array<float, 4 * segment> left{};
    std::array<float, 4 * segment> right{};
    for (std::uint32_t i = 0; i < left.size(); ++i) {
        left[i] = static_cast<float>(i) / 512.0f;
        right[i] = -0.7f * left[i];
    }

    ReverseSegment reverse;
    check(reverse.prepare(spec, 256, segment, 0), "reverse segment prepares bounded capture/read buffers");
    check(reverse.algorithmicLatencySamples() == 2 * segment,
          "reverse segment reports two-segment capture latency");
    for (std::uint32_t i = 0; i < 2 * segment; ++i) {
        const auto output = reverse.processSample(left[i], right[i]);
        check(near(output.left, left[i], 1.0e-7f), "reverse warmup passes live audio during two segment captures");
    }
    double startupFadeError = 0.0;
    double startupMaximumStep = 0.0;
    double startupBoundaryStep = 0.0;
    float previousStartup = left[2 * segment - 1];
    for (std::uint32_t i = 0; i < segment; ++i) {
        const auto output = reverse.processSample(left[2 * segment + i], right[2 * segment + i]);
        const double u = static_cast<double>(i) / (segment - 1U);
        const float expected = static_cast<float>(std::cos(u * 3.141592653589793 * 0.5)) *
                                   left[2 * segment + i] +
                               static_cast<float>(std::sin(u * 3.141592653589793 * 0.5)) *
                                   left[segment - 1U - i];
        startupFadeError = std::max(startupFadeError,
            std::abs(static_cast<double>(output.left - expected)));
        startupMaximumStep = std::max(startupMaximumStep,
            std::abs(static_cast<double>(output.left - previousStartup)));
        if (i == 0) startupBoundaryStep = std::abs(static_cast<double>(output.left - previousStartup));
        previousStartup = output.left;
    }
    check(startupFadeError < 1.0e-7 && startupBoundaryStep < 0.01 &&
          std::isfinite(startupMaximumStep) && startupMaximumStep < 0.5,
          "reverse startup fades continuously from live input into the first reverse head");
    check(near(previousStartup, left[0], 1.0e-7f),
          "reverse startup transition reaches the complete first reversed segment");
    for (std::uint32_t i = 0; i < segment; ++i) {
        const auto output = reverse.processSample(left[3 * segment + i], right[3 * segment + i]);
        check(near(output.left, left[2 * segment - 1 - i], 1.0e-7f),
              "reverse head advances to second captured segment without a gap");
    }

    ReverseSegment crossfade;
    check(crossfade.prepare(spec, 256, segment, crossfadeFrames),
          "two-head reverse with overlap prepares");
    check(crossfade.algorithmicLatencySamples() == 2 * segment - crossfadeFrames,
          "overlapped reverse reports actual warmup latency");
    check(!crossfade.setSegment(segment, 1), "one-sample reverse crossfade is rejected");
    const std::uint32_t overlapLatency = 2 * segment - crossfadeFrames;
    for (std::uint32_t i = 0; i < overlapLatency; ++i) {
        (void)crossfade.processSample(left[i], right[i]);
    }
    std::array<float, segment> overlapOutput{};
    for (std::uint32_t i = 0; i < segment; ++i) {
        overlapOutput[i] = crossfade.processSample(left[overlapLatency + i],
                                                   right[overlapLatency + i]).left;
    }
    double crossfadeMaxFormulaError = 0.0;
    for (std::uint32_t i = segment - crossfadeFrames; i < segment; ++i) {
        const auto fadePosition = i - (segment - crossfadeFrames);
        const double u = static_cast<double>(fadePosition) / (crossfadeFrames - 1U);
        const float gainA = static_cast<float>(std::cos(u * 3.141592653589793 * 0.5));
        const float gainB = static_cast<float>(std::sin(u * 3.141592653589793 * 0.5));
        const float reverseA = left[segment - 1U - i];
        const float reverseB = left[2U * segment - crossfadeFrames - 1U - fadePosition];
        const float expected = gainA * reverseA + gainB * reverseB;
        crossfadeMaxFormulaError = std::max(crossfadeMaxFormulaError,
            std::abs(static_cast<double>(overlapOutput[i] - expected)));
    }
    check(crossfadeMaxFormulaError < 1.0e-7,
          "reverse overlap matches cos/sin two-reverse-segment crossfade formula");
    check(near(overlapOutput[segment - crossfadeFrames],
               left[crossfadeFrames - 1U], 1.0e-7f), "reverse overlap begins at pure reverse A");
    check(near(overlapOutput[segment - 1],
               left[2U * segment - 2U * crossfadeFrames], 1.0e-7f),
          "reverse overlap ends at pure reverse B");
    const auto firstAfterSeam = crossfade.processSample(left[overlapLatency + segment],
                                                        right[overlapLatency + segment]);
    check(std::abs(firstAfterSeam.left - overlapOutput.back()) < 0.01f,
          "reverse overlap continues into the second head without a block-boundary jump");

    constexpr std::uint32_t longSegment = 128;
    constexpr std::uint32_t longCrossfade = 16;
    constexpr std::uint32_t longStride = longSegment - longCrossfade;
    constexpr std::uint32_t longLatency = 2 * longSegment - longCrossfade;
    constexpr std::uint32_t longTotal = longLatency + 130 * longStride + longSegment;
    ReverseSegment longRun;
    check(longRun.prepare({48000.0f, 256, 2}, longSegment, longSegment, longCrossfade),
          "long-running reverse absolute-frame history prepares");
    std::vector<float> longLeft(longTotal);
    std::vector<float> longRight(longTotal);
    std::vector<float> longOutLeft(longTotal);
    std::vector<float> longOutRight(longTotal);
    for (std::uint32_t i = 0; i < longTotal; ++i) {
        longLeft[i] = std::sin(static_cast<float>(i) * 0.017f) + static_cast<float>(i % 97) * 0.001f;
        longRight[i] = 0.4f * std::cos(static_cast<float>(i) * 0.013f) -
                       static_cast<float>(i % 53) * 0.002f;
    }
    constexpr std::array<std::uint32_t, 3> blockSizes{64, 128, 256};
    std::uint32_t offset = 0;
    std::uint32_t blockIndex = 0;
    while (offset < longTotal) {
        const auto frames = std::min(blockSizes[blockIndex++ % blockSizes.size()], longTotal - offset);
        check(longRun.processBlock(longLeft.data() + offset, longRight.data() + offset,
                                   longOutLeft.data() + offset, longOutRight.data() + offset, frames),
              "long reverse accepts variable block sizes");
        offset += frames;
    }
    double maximumLongError = 0.0;
    for (std::uint32_t time = 0; time < longTotal; ++time) {
        float expectedLeft = longLeft[time];
        float expectedRight = longRight[time];
        if (time >= longLatency) {
            const auto elapsed = time - longLatency;
            std::uint32_t segmentNumber = 0;
            std::uint32_t position = 0;
            if (elapsed < longSegment) {
                position = elapsed;
            } else {
                const auto afterFirst = elapsed - longSegment;
                segmentNumber = 1U + afterFirst / longStride;
                position = longCrossfade + afterFirst % longStride;
            }
            const auto startA = segmentNumber * longStride;
            const auto sourceA = startA + longSegment - 1U - position;
            expectedLeft = longLeft[sourceA];
            expectedRight = longRight[sourceA];
            if (position >= longSegment - longCrossfade) {
                const auto fadePosition = position - (longSegment - longCrossfade);
                const double u = static_cast<double>(fadePosition) / (longCrossfade - 1U);
                const float gainA = static_cast<float>(std::cos(u * 3.141592653589793 * 0.5));
                const float gainB = static_cast<float>(std::sin(u * 3.141592653589793 * 0.5));
                const auto sourceB = (segmentNumber + 1U) * longStride + longSegment - 1U - fadePosition;
                expectedLeft = gainA * expectedLeft + gainB * longLeft[sourceB];
                expectedRight = gainA * expectedRight + gainB * longRight[sourceB];
            }
            const auto initialFadeFrames = std::min<std::uint32_t>(
                ReverseSegment::kInitialTransitionFrames, longSegment - longCrossfade);
            if (elapsed < initialFadeFrames) {
                const double u = static_cast<double>(elapsed) / (initialFadeFrames - 1U);
                const float liveGain = static_cast<float>(std::cos(u * 3.141592653589793 * 0.5));
                const float reverseGain = static_cast<float>(std::sin(u * 3.141592653589793 * 0.5));
                expectedLeft = liveGain * longLeft[time] + reverseGain * expectedLeft;
                expectedRight = liveGain * longRight[time] + reverseGain * expectedRight;
            }
        }
        maximumLongError = std::max(maximumLongError,
            std::max(std::abs(static_cast<double>(longOutLeft[time] - expectedLeft)),
                     std::abs(static_cast<double>(longOutRight[time] - expectedRight))));
    }
    check(maximumLongError < 1.0e-6,
          "130 overlapped reverse segments read complete absolute frames with distinct stereo channels");
}

void testPlatterAndDrumVoice() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 64, 2};
    PlatterInertia platter;
    check(platter.prepare(spec), "platter model prepares");
    check(platter.setInertia(2.0f, 0.9f) && platter.setTargetSpeed(0.0f), "platter accepts inertia/target");
    for (std::uint32_t i = 0; i < 48000; ++i) {
        (void)platter.nextSpeedRatio();
    }
    check(std::abs(platter.currentSpeedRatio()) < 0.01f, "second-order platter decelerates smoothly to stop");
    check(std::isfinite(platter.currentPhaseCycles()) && std::isfinite(platter.currentAcceleration()),
          "platter phase and acceleration remain finite");

    DrumModalVoice voiceA;
    DrumModalVoice voiceB;
    check(voiceA.prepare(spec) && voiceB.prepare(spec), "modal/noise drum voices prepare");
    DrumVoiceParameters parameters;
    parameters.fundamentalHz = 58.0f;
    parameters.decaySeconds = 0.9f;
    parameters.tone = 0.65f;
    parameters.noise = 0.28f;
    parameters.amplitude = 0.8f;
    parameters.stereoWidth = 0.0f;
    parameters.seed = 20261009;
    check(voiceA.trigger(parameters) && voiceB.trigger(parameters), "modal voice triggers seeded synthesis");
    double energy = 0.0;
    bool same = true;
    double peak = 0.0;
    double earlyEnergy = 0.0;
    double lateEnergy = 0.0;
    for (std::uint32_t i = 0; i < 48000; ++i) {
        const auto a = voiceA.processSample();
        const auto b = voiceB.processSample();
        same = same && a.left == b.left && a.right == b.right;
        energy += a.left * a.left + a.right * a.right;
        peak = std::max(peak, std::max(std::abs(static_cast<double>(a.left)),
                                       std::abs(static_cast<double>(a.right))));
        if (i < 12000) earlyEnergy += a.left * a.left;
        if (i >= 36000) lateEnergy += a.left * a.left;
        check(near(a.left, a.right, 1.0e-7f), "zero-width modal/noise voice is mono");
        check(std::isfinite(a.left) && std::isfinite(a.right), "modal voice output finite");
    }
    check(energy > 0.1, "modal/noise voice emits an audible finite excitation");
    check(same, "seeded drum voice is deterministic");
    check(peak < 0.95 && earlyEnergy > lateEnergy && lateEnergy < earlyEnergy * 0.1,
          "normalized modal initial conditions stay bounded and decay");
}

void testDrumVoicesAndPool() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256, 2};

    DrumKickVoice kick;
    check(kick.prepare(spec), "swept kick voice prepares");
    KickVoiceParameters kickParameters;
    kickParameters.startFrequencyHz = 180.0f;
    kickParameters.endFrequencyHz = 42.0f;
    kickParameters.sweepSeconds = 0.07f;
    kickParameters.decaySeconds = 0.4f;
    kickParameters.amplitude = 0.85f;
    check(kick.trigger(kickParameters), "kick accepts exponential pitch sweep");
    std::vector<float> kickOutput;
    kickOutput.reserve(200000);
    for (std::uint32_t i = 0; i < 200000; ++i) {
        const auto sample = kick.processSample();
        kickOutput.push_back(sample.left);
    }
    std::vector<std::uint32_t> kickCrossings;
    for (std::uint32_t i = 1; i < kickOutput.size(); ++i) {
        if (kickOutput[i - 1] <= 0.0f && kickOutput[i] > 0.0f) kickCrossings.push_back(i);
    }
    const double firstKickHz = kickCrossings.size() > 2 ?
        48000.0 / (kickCrossings[1] - kickCrossings[0]) : 0.0;
    const double lateKickHz = kickCrossings.size() > 8 ?
        48000.0 / (kickCrossings[kickCrossings.size() - 1] - kickCrossings[kickCrossings.size() - 2]) : 0.0;
    const auto kickPeak = std::max_element(kickOutput.begin(), kickOutput.end(),
        [](float a, float b) { return std::abs(a) < std::abs(b); });
    check(firstKickHz > lateKickHz * 1.5 && lateKickHz > 30.0,
          "kick sine oscillator sweeps downward exponentially");
    check(kickPeak != kickOutput.end() && std::abs(*kickPeak) < 0.95f && !kick.active(),
          "kick envelope is bounded and reaches idle");

    DrumSnareVoice snareA;
    DrumSnareVoice snareB;
    check(snareA.prepare(spec) && snareB.prepare(spec), "snare bandpass/body voices prepare");
    SnareVoiceParameters snareParameters;
    snareParameters.bodyFrequencyHz = 185.0f;
    snareParameters.bodyDecaySeconds = 0.28f;
    snareParameters.noiseDecaySeconds = 0.19f;
    snareParameters.noiseLevel = 0.8f;
    snareParameters.amplitude = 0.65f;
    snareParameters.stereoWidth = 0.0f;
    snareParameters.seed = 20261009;
    check(snareA.trigger(snareParameters) && snareB.trigger(snareParameters),
          "snare accepts seeded band-passed-noise plus body parameters");
    double snarePeak = 0.0;
    double snareEnergy = 0.0;
    bool snareMono = true;
    bool snareDeterministic = true;
    for (std::uint32_t i = 0; i < 96000; ++i) {
        const auto a = snareA.processSample();
        const auto b = snareB.processSample();
        snareMono = snareMono && a.left == a.right;
        snareDeterministic = snareDeterministic && a.left == b.left && a.right == b.right;
        snarePeak = std::max(snarePeak, std::max(std::abs(static_cast<double>(a.left)),
                                                 std::abs(static_cast<double>(a.right))));
        snareEnergy += a.left * a.left + a.right * a.right;
    }
    check(snareMono && snareDeterministic && snarePeak < 0.95 && snareEnergy > 0.1,
          "snare is seeded, stereo-width controlled, finite and bounded");
    check(!snareA.active() && !snareB.active(), "snare noise/body envelopes return to idle");

    DrumHiHatVoice hatA;
    DrumHiHatVoice hatB;
    check(hatA.prepare(spec) && hatB.prepare(spec), "metallic hi-hat voices prepare");
    HiHatVoiceParameters hatParameters;
    hatParameters.baseFrequencyHz = 4200.0f;
    hatParameters.decaySeconds = 0.18f;
    hatParameters.noiseLevel = 0.45f;
    hatParameters.amplitude = 0.55f;
    hatParameters.stereoWidth = 0.0f;
    hatParameters.seed = 811;
    check(hatA.trigger(hatParameters) && hatB.trigger(hatParameters),
          "hi-hat accepts inharmonic partial and high-pass-noise parameters");
    std::vector<float> hatOutput;
    hatOutput.reserve(48000);
    double hatPeak = 0.0;
    bool hatMono = true;
    bool hatDeterministic = true;
    for (std::uint32_t i = 0; i < 48000; ++i) {
        const auto a = hatA.processSample();
        const auto b = hatB.processSample();
        hatOutput.push_back(a.left);
        hatMono = hatMono && a.left == a.right;
        hatDeterministic = hatDeterministic && a.left == b.left && a.right == b.right;
        hatPeak = std::max(hatPeak, std::max(std::abs(static_cast<double>(a.left)),
                                             std::abs(static_cast<double>(a.right))));
    }
    const double partialA = goertzelEnergy(hatOutput, 0, 24000, 4200.0, 48000.0);
    const double partialB = goertzelEnergy(hatOutput, 0, 24000, 5636.4, 48000.0);
    check(hatMono && hatDeterministic && hatPeak < 0.95 && partialA > 1.0 && partialB > 0.2,
          "hi-hat contains bounded inharmonic tones and a deterministic high-pass noise tail");
    check(!hatA.active() && !hatB.active(), "hi-hat envelope returns to idle");

    DrumModalVoicePool poolA;
    DrumModalVoicePool poolB;
    check(poolA.prepare(spec) && poolB.prepare(spec), "fixed eight-voice modal pool prepares");
    DrumVoiceParameters modal;
    modal.fundamentalHz = 95.0f;
    modal.decaySeconds = 0.12f;
    modal.noise = 0.1f;
    modal.stereoWidth = 0.2f;
    modal.seed = 33;
    for (std::uint32_t voice = 0; voice < 8; ++voice) {
        modal.seed += voice;
        check(poolA.trigger(modal) && poolB.trigger(modal), "fixed voice pool triggers without allocation");
    }
    check(poolA.activeVoices() == DrumModalVoicePool::kVoiceCount,
          "fixed voice pool reports all active voices");
    bool poolDeterministic = true;
    for (std::uint32_t i = 0; i < 1024; ++i) {
        const auto a = poolA.processSample();
        const auto b = poolB.processSample();
        poolDeterministic = poolDeterministic && a.left == b.left && a.right == b.right;
        check(std::isfinite(a.left) && std::isfinite(a.right) &&
              std::abs(a.left) <= 1.0f && std::abs(a.right) <= 1.0f,
              "fixed voice pool output is finite and bounded");
    }
    check(poolDeterministic, "fixed modal voice pool is deterministic");

    DrumVoicePool mixedA;
    DrumVoicePool mixedB;
    check(mixedA.prepare(spec) && mixedB.prepare(spec), "fixed mixed drum voice pool prepares all voice families");
    DrumVoiceParameters mixedModal = modal;
    KickVoiceParameters mixedKick;
    mixedKick.amplitude = 0.55f;
    SnareVoiceParameters mixedSnare;
    mixedSnare.seed = 919;
    HiHatVoiceParameters mixedHat;
    mixedHat.seed = 727;
    const auto triggerMixed = [&](DrumVoicePool& target) {
        return target.triggerModal(mixedModal) && target.triggerKick(mixedKick) &&
               target.triggerSnare(mixedSnare) && target.triggerHiHat(mixedHat) &&
               target.triggerModal(mixedModal) && target.triggerKick(mixedKick) &&
               target.triggerSnare(mixedSnare) && target.triggerHiHat(mixedHat);
    };
    check(triggerMixed(mixedA) && triggerMixed(mixedB), "mixed drum pool triggers all four voice families");
    check(mixedA.activeVoices() == DrumVoicePool::kVoiceCount,
          "mixed fixed pool reports eight active voices");
    bool mixedDeterministic = true;
    double mixedPeak = 0.0;
    for (std::uint32_t i = 0; i < 200000; ++i) {
        const auto a = mixedA.processSample();
        const auto b = mixedB.processSample();
        mixedDeterministic = mixedDeterministic && a.left == b.left && a.right == b.right;
        mixedPeak = std::max(mixedPeak, std::max(std::abs(static_cast<double>(a.left)),
                                                 std::abs(static_cast<double>(a.right))));
        check(std::isfinite(a.left) && std::isfinite(a.right), "mixed drum pool remains finite");
    }
    check(mixedDeterministic && mixedPeak <= 1.0,
          "mixed drum pool is deterministic and bounds simultaneous voice output");
    check(mixedA.activeVoices() == 0, "mixed drum voice pool returns to idle after tails");
    check(mixedA.triggerKick(mixedKick) && mixedA.activeVoices() == 1,
          "mixed drum pool reuses an idle slot before stealing a voice");

    DrumVoicePool modalControl;
    DrumVoicePool modalPlusKick;
    DrumKickVoice kickReference;
    check(modalControl.prepare(spec) && modalPlusKick.prepare(spec) && kickReference.prepare(spec),
          "fixed-gain/steal regression fixtures prepare");
    DrumVoiceParameters longModal = modal;
    longModal.fundamentalHz = 67.0f;
    longModal.decaySeconds = 3.0f;
    longModal.amplitude = 0.6f;
    longModal.noise = 0.0f;
    longModal.seed = 0x811;
    KickVoiceParameters shortKick;
    shortKick.startFrequencyHz = 110.0f;
    shortKick.endFrequencyHz = 42.0f;
    shortKick.sweepSeconds = 0.025f;
    shortKick.decaySeconds = 0.04f;
    shortKick.amplitude = 0.32f;
    check(modalControl.triggerModal(longModal) && modalPlusKick.triggerModal(longModal),
          "matched modal tails start at identical state");
    for (std::uint32_t i = 0; i < 2048; ++i) {
        const auto control = modalControl.processSample();
        const auto combined = modalPlusKick.processSample();
        check(near(control.left, combined.left, 1.0e-7f) && near(control.right, combined.right, 1.0e-7f),
              "unrelated idle-slot state does not alter a sustained voice");
    }
    check(modalPlusKick.triggerKick(shortKick) && kickReference.trigger(shortKick),
          "short kick uses an idle slot while a modal tail is active");
    double fixedGainError = 0.0;
    bool modalTailFinite = true;
    for (std::uint32_t i = 0; i < 8192; ++i) {
        const auto control = modalControl.processSample();
        const auto combined = modalPlusKick.processSample();
        const auto reference = kickReference.processSample();
        const double expectedKick = reference.left * 0.3535533905932737622;
        fixedGainError = std::max(fixedGainError,
            std::abs(static_cast<double>(combined.left - control.left) - expectedKick));
        modalTailFinite = modalTailFinite && std::isfinite(combined.right);
        if (i > 4096) {
            check(near(control.left, combined.left, 1.0e-7f) &&
                  near(control.right, combined.right, 1.0e-7f),
                  "kick expiry leaves the other voice at its unchanged fixed gain");
        }
    }
    check(modalTailFinite && fixedGainError < 3.0e-6,
          "adding and expiring a voice never renormalizes the existing modal tail");

    DrumVoicePool stealControl;
    DrumVoicePool stealCandidate;
    check(stealControl.prepare(spec) && stealCandidate.prepare(spec), "voice-steal fixtures prepare");
    DrumVoiceParameters stealModal = longModal;
    stealModal.decaySeconds = 8.0f;
    for (std::uint32_t i = 0; i < DrumVoicePool::kVoiceCount; ++i) {
        stealModal.seed += i + 1;
        check(stealControl.triggerModal(stealModal) && stealCandidate.triggerModal(stealModal),
              "voice-steal fixtures fill all fixed slots");
    }
    for (std::uint32_t i = 0; i < 2048; ++i) {
        const auto a = stealControl.processSample();
        const auto b = stealCandidate.processSample();
        check(near(a.left, b.left, 1.0e-7f) && near(a.right, b.right, 1.0e-7f),
              "voice-steal fixtures begin with identical active tails");
    }
    const auto beforeSteal = stealCandidate.processSample();
    (void)stealControl.processSample();
    check(stealCandidate.triggerKick(shortKick), "full pool steals only after checking for idle slots");
    const auto afterSteal = stealCandidate.processSample();
    const double stealBoundaryStep = std::max(
        std::abs(static_cast<double>(afterSteal.left - beforeSteal.left)),
        std::abs(static_cast<double>(afterSteal.right - beforeSteal.right)));
    check(std::isfinite(stealBoundaryStep) && stealBoundaryStep < 0.25,
          "64-sample replacement tail bounds the voice-steal boundary transient");
}

void testNoRealtimeAllocationOrDelete() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 256, 2};
    std::array<float, 256> inL{};
    std::array<float, 256> inR{};
    std::array<float, 256> outL{};
    std::array<float, 256> outR{};
    std::array<double, 256> phases{};
    std::array<float, 256> ir{};
    ir[0] = 1.0f;
    PartitionedConvolver convolver;
    FdnReverb fdn;
    GranularTexture grains;
    SpectralFreeze freeze;
    ReverseSegment reverse;
    PlatterInertia platter;
    DrumModalVoice drum;
    DrumKickVoice kick;
    DrumSnareVoice snare;
    DrumHiHatVoice hat;
    DrumModalVoicePool pool;
    DrumVoicePool mixedPool;
    check(convolver.prepare(spec, 32, 64, ir.data(), nullptr, nullptr, ir.data()), "allocation test convolver prepares");
    check(fdn.prepare(spec), "allocation test FDN prepares");
    check(grains.prepare(spec, 0.5f) && grains.setParameters(50, 100, 1.1f, 0.5f, 0.5f, 1001), "allocation test grains prepare");
    check(freeze.prepare(spec, 256, 64), "allocation test freeze prepares");
    check(reverse.prepare(spec, 128, 64, 8), "allocation test reverse prepares");
    check(platter.prepare(spec), "allocation test platter prepares");
    check(drum.prepare(spec), "allocation test drum prepares");
    check(kick.prepare(spec) && kick.trigger(KickVoiceParameters{}), "allocation test kick prepares");
    check(snare.prepare(spec) && snare.trigger(SnareVoiceParameters{}), "allocation test snare prepares");
    check(hat.prepare(spec) && hat.trigger(HiHatVoiceParameters{}), "allocation test hat prepares");
    check(pool.prepare(spec) && pool.trigger(DrumVoiceParameters{}), "allocation test fixed modal pool prepares");
    check(mixedPool.prepare(spec), "allocation test mixed drum pool prepares");
    check(mixedPool.triggerKick(KickVoiceParameters{}) &&
          mixedPool.triggerSnare(SnareVoiceParameters{}) &&
          mixedPool.triggerHiHat(HiHatVoiceParameters{}) &&
          mixedPool.triggerModal(DrumVoiceParameters{}),
          "allocation test mixed drum pool triggers all voice families");
    DrumVoiceParameters parameters;
    parameters.noise = 0.25f;
    drum.trigger(parameters);
    for (std::uint32_t i = 0; i < 320; ++i) {
        (void)freeze.processSample(0.2f, -0.1f); // Warm state to include STFT FFT blocks under the guard.
    }
    freeze.setFreeze(true);
    std::array<std::complex<float>, 32> fftValues{};
    for (std::size_t i = 0; i < fftValues.size(); ++i) fftValues[i] = {static_cast<float>(i), 0.0f};
    const auto newBefore = gRuntimeNewCount.load();
    const auto deleteBefore = gRuntimeDeleteCount.load();
    gCountRuntimeAllocations.store(true);
    check(fft::transform(fftValues.data(), fftValues.size(), fft::Direction::Forward),
          "FFT runs under allocation guard");
    constexpr std::array<std::uint32_t, 3> blockSizes{64, 128, 256};
    for (const auto frames : blockSizes) {
      for (int block = 0; block < 32; ++block) {
        check(convolver.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), frames),
              "convolver runs under callback allocation guard");
        check(fdn.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), frames),
              "FDN runs under callback allocation guard");
        check(grains.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), frames),
              "grain pool runs under callback allocation guard");
        check(freeze.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), frames),
              "freeze runs under callback allocation guard");
        check(reverse.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), frames),
              "reverse history runs under callback allocation guard");
        check(platter.processBlock(outL.data(), phases.data(), outR.data(), frames),
              "platter runs under callback allocation guard");
        check(drum.processBlock(outL.data(), outR.data(), frames), "modal voice runs under callback allocation guard");
        check(kick.processBlock(outL.data(), outR.data(), frames), "kick runs under callback allocation guard");
        check(snare.processBlock(outL.data(), outR.data(), frames), "snare runs under callback allocation guard");
        check(hat.processBlock(outL.data(), outR.data(), frames), "hi-hat runs under callback allocation guard");
        check(pool.processBlock(outL.data(), outR.data(), frames), "fixed voice pool runs under callback allocation guard");
        check(mixedPool.processBlock(outL.data(), outR.data(), frames),
              "mixed drum pool runs under callback allocation guard");
      }
    }
    gCountRuntimeAllocations.store(false);
    check(gRuntimeNewCount.load() == newBefore, "real-time methods do not call new/new[]");
    check(gRuntimeDeleteCount.load() == deleteBefore, "real-time methods do not call delete/delete[]");
    std::printf("Callback allocation guard across 64/128/256 frames: new=%llu delete=%llu\n",
                static_cast<unsigned long long>(gRuntimeNewCount.load() - newBefore),
                static_cast<unsigned long long>(gRuntimeDeleteCount.load() - deleteBefore));
}

} // namespace

void* operator new(std::size_t size) {
    if (gCountRuntimeAllocations.load(std::memory_order_relaxed)) {
        gRuntimeNewCount.fetch_add(1, std::memory_order_relaxed);
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) {
        return memory;
    }
    throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
    if (gCountRuntimeAllocations.load(std::memory_order_relaxed)) {
        gRuntimeNewCount.fetch_add(1, std::memory_order_relaxed);
    }
    if (void* memory = std::malloc(size == 0 ? 1 : size)) {
        return memory;
    }
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept {
    if (memory != nullptr && gCountRuntimeAllocations.load(std::memory_order_relaxed)) {
        gRuntimeDeleteCount.fetch_add(1, std::memory_order_relaxed);
    }
    std::free(memory);
}

void operator delete[](void* memory) noexcept {
    if (memory != nullptr && gCountRuntimeAllocations.load(std::memory_order_relaxed)) {
        gRuntimeDeleteCount.fetch_add(1, std::memory_order_relaxed);
    }
    std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept { ::operator delete(memory); }
void operator delete[](void* memory, std::size_t) noexcept { ::operator delete[](memory); }

int main() {
    testFftRoundTrip();
    testNormalizedHadamard();
    testPrepareBudgetEstimates();
    testPartitionedConvolution();
    testFdnReverb();
    testGranularDeterminism();
    testSpectralFreeze();
    testFreezeOverlapConfigurations();
    testReverseSegment();
    testPlatterAndDrumVoice();
    testDrumVoicesAndPool();
    testNoRealtimeAllocationOrDelete();
    if (gFailures != 0) {
        std::fprintf(stderr, "%d spatial/temporal DSP assertion(s) failed.\n", gFailures);
        return 1;
    }
    std::printf("Spatial/temporal DSP tests passed.\n");
    return 0;
}
