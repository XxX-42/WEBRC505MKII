#include "webrc/dsp/fft.hpp"
#include "webrc/dsp/pitch.hpp"
#include "webrc/dsp/signalsmith_adapter.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <cstdlib>
#include <cstdint>
#include <iostream>
#include <limits>
#include <new>
#include <vector>

namespace {
std::uint64_t gAllocationCalls = 0;
}

void* operator new(std::size_t size) {
    ++gAllocationCalls;
    if (void* memory = std::malloc(size)) return memory;
    std::abort();
}

void* operator new[](std::size_t size) {
    ++gAllocationCalls;
    if (void* memory = std::malloc(size)) return memory;
    std::abort();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

namespace {

constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr float kSampleRate = 48000.0f;

bool require(bool condition, const char* message) {
    if (!condition) std::cerr << "FAIL: " << message << '\n';
    return condition;
}

float sine(float frequency, std::uint64_t frame, float amplitude = 1.0f) {
    return amplitude * std::sin(static_cast<float>(2.0 * kPi * frequency * frame / kSampleRate));
}

float wrap(float phase) {
    return static_cast<float>(std::remainder(static_cast<double>(phase), 2.0 * kPi));
}

float phaseVocoderFrequency(float frequency, float pitchRatio) {
    constexpr std::uint32_t fftFrames = 2048;
    constexpr std::uint32_t hop = 256;
    const webrc::dsp::ProcessSpec spec{kSampleRate, hop, 1};
    webrc::dsp::PhaseVocoder vocoder;
    if (!vocoder.prepare(spec, fftFrames, hop, hop)) return -1.0f;
    std::vector<std::complex<float>> input(fftFrames);
    std::vector<std::complex<float>> output(fftFrames);
    const auto targetFrequency = frequency * pitchRatio;
    const auto outputBin = static_cast<std::uint32_t>(std::lround(targetFrequency * fftFrames / kSampleRate));
    float priorPhase = 0.0f;
    double phaseAdvance = 0.0;
    std::uint32_t phaseSamples = 0;

    for (std::uint32_t frame = 0; frame < 30; ++frame) {
        const std::uint64_t offset = static_cast<std::uint64_t>(frame) * hop;
        for (std::uint32_t sample = 0; sample < fftFrames; ++sample) {
            const double window = 0.5 - 0.5 * std::cos(2.0 * kPi * sample / (fftFrames - 1));
            input[sample] = {static_cast<float>(window * sine(frequency, offset + sample)), 0.0f};
        }
        if (!webrc::dsp::fft::transform(input.data(), fftFrames,
                                        webrc::dsp::fft::Direction::Forward) ||
            !vocoder.processSpectrumFrame(input.data(), output.data(), pitchRatio)) {
            return -1.0f;
        }
        const float phase = std::atan2(output[outputBin].imag(), output[outputBin].real());
        if (frame >= 4) {
            const float expectedBinAdvance = static_cast<float>(2.0 * kPi * outputBin * hop / fftFrames);
            phaseAdvance += wrap(phase - priorPhase - expectedBinAdvance);
            ++phaseSamples;
        }
        priorPhase = phase;
    }
    if (phaseSamples == 0) return -1.0f;
    const double binFrequency = static_cast<double>(outputBin) * kSampleRate / fftFrames;
    return static_cast<float>(binFrequency + phaseAdvance * kSampleRate /
                              (2.0 * kPi * hop * phaseSamples));
}

float positiveCrossingFrequency(const float* samples, std::uint32_t first,
                                std::uint32_t last) {
    double firstCrossing = -1.0;
    double lastCrossing = -1.0;
    std::uint32_t count = 0;
    for (std::uint32_t index = first + 1; index <= last; ++index) {
        if (samples[index - 1] <= 0.0f && samples[index] > 0.0f) {
            const double fraction = -samples[index - 1] /
                (static_cast<double>(samples[index]) - samples[index - 1]);
            const double crossing = static_cast<double>(index - 1) + fraction;
            if (firstCrossing < 0.0) firstCrossing = crossing;
            lastCrossing = crossing;
            ++count;
        }
    }
    return count > 1 && lastCrossing > firstCrossing
        ? static_cast<float>((count - 1) * kSampleRate / (lastCrossing - firstCrossing))
        : 0.0f;
}

double toneAmplitude(const float* samples, std::uint32_t first,
                     std::uint32_t frames, double frequencyHz) {
    double cosine = 0.0;
    double sineProjection = 0.0;
    for (std::uint32_t offset = 0; offset < frames; ++offset) {
        const double phase = 2.0 * kPi * frequencyHz * (first + offset) / kSampleRate;
        cosine += samples[first + offset] * std::cos(phase);
        sineProjection += samples[first + offset] * std::sin(phase);
    }
    return 2.0 * std::hypot(cosine, sineProjection) / frames;
}

} // namespace

int main() {
    using namespace webrc::dsp;
    bool ok = true;
    const ProcessSpec spec{kSampleRate, 512, 2};

    YinPitchDetector yin;
    ok &= require(yin.prepare(spec, 4096, 60.0f, 1200.0f, 0.15f), "prepare YIN");
    std::vector<float> pitchFrame(4096);
    PitchEstimate estimate{};
    for (const float frequency : {440.0f, 997.0f}) {
        for (std::uint32_t i = 0; i < pitchFrame.size(); ++i) pitchFrame[i] = sine(frequency, i);
        ok &= require(yin.analyze(pitchFrame.data(), static_cast<std::uint32_t>(pitchFrame.size()), estimate),
                      "YIN analyzes a full frame");
        ok &= require(estimate.voiced && std::abs(estimate.frequencyHz - frequency) < 1.0f,
                      "YIN estimates a non-bin-aligned 440/997 Hz fundamental within 1 Hz");
        ok &= require(estimate.confidence > 0.8f && estimate.rms > 0.6f,
                      "YIN reports confidence and RMS for a periodic tone");
    }
    std::fill(pitchFrame.begin(), pitchFrame.end(), 0.0f);
    ok &= require(yin.analyze(pitchFrame.data(), static_cast<std::uint32_t>(pitchFrame.size()), estimate) &&
                  !estimate.voiced && estimate.frequencyHz == 0.0f,
                  "YIN suppresses unvoiced silence");
    ok &= require(!yin.analyze(pitchFrame.data(), 128, estimate), "YIN rejects wrong frame size");
    ok &= require(YinPitchDetector::requiredPrepareBytes(spec, 4096, 60.0f, 1200.0f) > 0,
                  "YIN exposes a bounded prepare-memory estimate");
    ok &= require(!yin.prepare(spec, 4096, std::numeric_limits<float>::denorm_min(),
                              1200.0f, 0.15f),
                  "YIN rejects a finite tiny minimum frequency before converting its lag");
    for (std::uint32_t i = 0; i < pitchFrame.size(); ++i) pitchFrame[i] = sine(997.0f, i);
    ok &= require(yin.analyze(pitchFrame.data(), static_cast<std::uint32_t>(pitchFrame.size()), estimate) &&
                  estimate.voiced && std::abs(estimate.frequencyHz - 997.0f) < 1.0f,
                  "a rejected YIN reprepare preserves the previous configured detector");

    TdPsolaPitchShifter psola;
    ok &= require(TdPsolaPitchShifter::requiredPrepareBytes(8192) > 0 &&
                  psola.prepare(spec, 8192, 1024), "prepare TD-PSOLA buffer with bounded memory estimate");
    std::vector<float> source(8192);
    std::vector<float> shifted(8192);
    for (std::uint32_t i = 0; i < source.size(); ++i) source[i] = sine(440.0f, i, 0.5f);
    ok &= require(psola.processBuffer(source.data(), shifted.data(), 8192,
                                      kSampleRate / 440.0f, 1.5f),
                  "TD-PSOLA processes a prepared buffer");
    const float shiftedFrequency = positiveCrossingFrequency(shifted.data(), 1024, 7168);
    ok &= require(std::abs(shiftedFrequency - 660.0f) < 8.0f,
                  "TD-PSOLA pitch marks resynthesize a 440 Hz tone near 660 Hz");
    ok &= require(psola.processBuffer(source.data(), shifted.data(), 8192,
                                      kSampleRate / 440.0f, 1.0f),
                  "TD-PSOLA accepts identity ratio");
    ok &= require(std::equal(source.begin(), source.end(), shifted.begin()),
                  "TD-PSOLA identity ratio is sample exact");
    ok &= require(!psola.processBuffer(source.data(), shifted.data(), 8192,
                                       kSampleRate / 440.0f, 3.0f),
                  "TD-PSOLA rejects out-of-contract ratios");
    ok &= require(!psola.prepare(spec, 0, 1024) &&
                  psola.processBuffer(source.data(), shifted.data(), 8192,
                                      kSampleRate / 440.0f, 1.0f) &&
                  std::equal(source.begin(), source.end(), shifted.begin()),
                  "rejected offline PSOLA prepare preserves the previous prepared buffer processor");

    ProcessSpec liveSpec{kSampleRate, 512, 1};
    StreamingTdPsolaPitchShifter livePsola;
    ok &= require(livePsola.prepare(liveSpec, 512), "prepare bounded streaming TD-PSOLA");
    ok &= require(livePsola.latencySamples() == 1536 &&
                  livePsola.maximumBlockFrames() == 512,
                  "streaming PSOLA reports its fixed resynthesis delay and quantum cap");
    ok &= require(livePsola.setPitch(kSampleRate / 440.0f, 1.5f, true),
                  "configure voiced live PSOLA from the YIN period");
    std::vector<float> liveInput(48000);
    std::vector<float> liveOutput(48000);
    for (std::uint32_t i = 0; i < liveInput.size(); ++i) liveInput[i] = sine(440.0f, i, 0.5f);
    const std::uint64_t streamingAllocationsBefore = gAllocationCalls;
    for (std::uint32_t offset = 0; offset < liveInput.size(); offset += 128) {
        ok &= require(livePsola.processBlock(liveInput.data() + offset, liveOutput.data() + offset, 128),
                      "streaming PSOLA accepts each prepared 128-frame callback");
    }
    ok &= require(gAllocationCalls == streamingAllocationsBefore,
                  "streaming PSOLA processBlock performs no heap allocations");
    const float liveShiftedFrequency = positiveCrossingFrequency(
        liveOutput.data(), livePsola.latencySamples() + 2048,
        static_cast<std::uint32_t>(liveOutput.size()) - 2048);
    ok &= require(std::abs(liveShiftedFrequency - 660.0f) < 8.0f,
                  "streaming PSOLA maintains 440-to-660 Hz pitch across callback boundaries");

    StreamingTdPsolaPitchShifter splitPsola;
    ok &= require(splitPsola.prepare(liveSpec, 512) &&
                  splitPsola.setPitch(kSampleRate / 440.0f, 1.5f, true),
                  "prepare split-quantum streaming PSOLA");
    std::vector<float> splitOutput(liveInput.size());
    constexpr std::array<std::uint32_t, 4> splitSizes{64, 128, 256, 512};
    std::uint32_t splitOffset = 0;
    std::size_t splitIndex = 0;
    const std::uint64_t splitAllocationsBefore = gAllocationCalls;
    while (splitOffset < liveInput.size()) {
        const std::uint32_t frames = std::min<std::uint32_t>(splitSizes[splitIndex % splitSizes.size()],
            static_cast<std::uint32_t>(liveInput.size()) - splitOffset);
    ok &= require(splitPsola.processBlock(liveInput.data() + splitOffset,
                                             splitOutput.data() + splitOffset, frames),
                      "streaming PSOLA accepts varied prepared block lengths");
        splitOffset += frames;
        ++splitIndex;
    }
    ok &= require(gAllocationCalls == splitAllocationsBefore,
                  "streaming PSOLA variable block calls perform no heap allocations");
    ok &= require(std::equal(liveOutput.begin(), liveOutput.end(), splitOutput.begin()),
                  "streaming PSOLA PCM is invariant to callback block partitioning");

    // Exercise the full supported pitch-ratio interval from manual F0 input.
    // This isolates the resynthesizer from detector cadence and verifies that
    // changing the synthesis period does not collapse overlapping grains.
    for (const float ratio : {0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f}) {
        for (const float phase : {0.37f, static_cast<float>(0.37 + kPi)}) {
            StreamingTdPsolaPitchShifter ratioPsola;
            StreamingTdPsolaPitchShifter partitionedRatioPsola;
            const PitchEstimate manualF0{220.0f, kSampleRate / 220.0f, 0.99f, 0.3f, true};
            ok &= require(ratioPsola.prepare(liveSpec, 739) &&
                          ratioPsola.setPitchEstimate(manualF0, ratio) &&
                          partitionedRatioPsola.prepare(liveSpec, 739) &&
                          partitionedRatioPsola.setPitchEstimate(manualF0, ratio),
                          "streaming PSOLA prepares and accepts each legal ratio-grid point");
            std::vector<float> ratioOutput(liveInput.size());
            std::vector<float> partitionedRatioOutput(liveInput.size());
            constexpr std::array<std::uint32_t, 4> ratioPartitions{64U, 128U, 256U, 512U};
            std::uint32_t partitionOffset = 0U;
            std::size_t partitionIndex = 0U;
            const std::uint64_t allocationsBeforeRatio = gAllocationCalls;
            for (std::uint32_t offset = 0; offset < liveInput.size(); offset += 128) {
                for (std::uint32_t i = 0; i < 128; ++i) {
                    const auto frame = offset + i;
                    liveInput[frame] = 0.3f * std::sin(static_cast<float>(
                        2.0 * kPi * 220.0 * frame / kSampleRate + phase));
                }
                ok &= require(ratioPsola.processBlock(liveInput.data() + offset,
                                                     ratioOutput.data() + offset, 128),
                              "streaming PSOLA processes each legal ratio-grid fixture");
            }
            while (partitionOffset < liveInput.size()) {
                const auto frames = std::min<std::uint32_t>(
                    ratioPartitions[partitionIndex++ % ratioPartitions.size()],
                    static_cast<std::uint32_t>(liveInput.size()) - partitionOffset);
                ok &= require(partitionedRatioPsola.processBlock(
                                  liveInput.data() + partitionOffset,
                                  partitionedRatioOutput.data() + partitionOffset, frames),
                              "streaming PSOLA accepts 64/128/256/512 ratio-grid callbacks");
                partitionOffset += frames;
            }
            ok &= require(gAllocationCalls == allocationsBeforeRatio,
                          "ratio-grid PSOLA renders allocate no memory after prepare");
            ok &= require(std::equal(ratioOutput.begin(), ratioOutput.end(),
                                     partitionedRatioOutput.begin()),
                          "ratio-grid PSOLA output is sample exact across callback partitions");
            const auto warmStart = ratioPsola.latencySamples() + 8192U;
            const auto warmEnd = static_cast<std::uint32_t>(ratioOutput.size()) - 4096U;
            const float actualHz = positiveCrossingFrequency(ratioOutput.data(), warmStart, warmEnd);
            double outputEnergy = 0.0;
            for (std::uint32_t i = warmStart; i < warmEnd; ++i) {
                outputEnergy += static_cast<double>(ratioOutput[i]) * ratioOutput[i];
            }
            const double outputRms = std::sqrt(outputEnergy / (warmEnd - warmStart));
            const double expectedHz = 220.0 * ratio;
            ok &= require(std::abs(actualHz - expectedHz) <= std::max(4.0, expectedHz * 0.025),
                          "streaming PSOLA output frequency follows every legal ratio-grid point and phase");
            ok &= require(outputRms >= 0.16 && outputRms <= 0.24,
                          "streaming PSOLA preserves bounded sine energy across legal ratios and polarity");
        }
    }

    StreamingTdPsolaPitchShifter antiAliasPsola;
    ok &= require(antiAliasPsola.prepare(liveSpec, 480) &&
                  antiAliasPsola.setPitch(480.0f, 2.0f, true),
                  "prepare a ratio-2 sinc8 downsampling alias fixture");
    std::vector<float> aliasInput(48000U);
    std::vector<float> aliasOutput(48000U);
    for (std::uint32_t frame = 0U; frame < aliasInput.size(); ++frame) {
        aliasInput[frame] = 0.2f * sine(100.0f, frame) +
            0.05f * sine(18000.0f, frame);
    }
    for (std::uint32_t offset = 0U; offset < aliasInput.size(); offset += 128U) {
        ok &= require(antiAliasPsola.processBlock(aliasInput.data() + offset,
                                                 aliasOutput.data() + offset, 128U),
                      "ratio-2 bandlimited PSOLA processes the high-harmonic fixture");
    }
    const double shiftedFundamental = toneAmplitude(aliasOutput.data(), 32000U, 12000U, 200.0);
    const double foldedHighTone = toneAmplitude(aliasOutput.data(), 32000U, 12000U, 12000.0);
    ok &= require(std::abs(shiftedFundamental - 0.2) < 0.01 && foldedHighTone < 0.006,
                  "ratio-2 sinc8 downsampling preserves the 200 Hz component and suppresses the 18-to-12 kHz fold");

    ok &= require(livePsola.setPitch(0.0f, 1.5f, false),
                  "streaming PSOLA accepts an unvoiced fallback request");
    ok &= require(StreamingTdPsolaPitchShifter::requiredPrepareBytes(liveSpec, 512) > 0,
                  "streaming PSOLA exposes a bounded ring-memory estimate");
    ok &= require(!livePsola.prepare(liveSpec, 1) && livePsola.latencySamples() == 1536,
                  "a rejected streaming PSOLA prepare preserves the active ring and latency");

    StreamingTdPsolaPitchShifter identityPsola;
    ok &= require(identityPsola.prepare(liveSpec, 512) &&
                  identityPsola.setPitch(kSampleRate / 440.0f, 1.0f, true),
                  "prepare an identity-ratio streaming PSOLA amplitude fixture");
    std::vector<float> identityOutput(48000);
    double identityEnergy = 0.0;
    double identityResidualEnergy = 0.0;
    float identityPeak = 0.0f;
    float identityResidualPeak = 0.0f;
    for (std::uint32_t offset = 0; offset < identityOutput.size(); offset += 128) {
        for (std::uint32_t i = 0; i < 128; ++i) {
            liveInput[offset + i] = sine(440.0f, offset + i, 0.5f);
        }
        ok &= require(identityPsola.processBlock(liveInput.data() + offset,
                                                identityOutput.data() + offset, 128),
                      "identity PSOLA processes callback-sized blocks");
    }
    for (std::uint32_t i = identityPsola.latencySamples() + 4096;
         i < identityOutput.size(); ++i) {
        identityEnergy += static_cast<double>(identityOutput[i]) * identityOutput[i];
        identityPeak = std::max(identityPeak, std::abs(identityOutput[i]));
        const float residual = identityOutput[i] - liveInput[i - identityPsola.latencySamples()];
        identityResidualEnergy += static_cast<double>(residual) * residual;
        identityResidualPeak = std::max(identityResidualPeak, std::abs(residual));
    }
    const double identitySamples = static_cast<double>(identityOutput.size() -
        (identityPsola.latencySamples() + 4096));
    const double identityRms = std::sqrt(identityEnergy / identitySamples);
    ok &= require(std::abs(identityRms - 0.5 / std::sqrt(2.0)) < 0.002 &&
                  identityPeak <= 0.501f,
                  "identity wet/dry transition preserves unity amplitude without a +3 dB bump");
    ok &= require(identityResidualEnergy < 1.0e-8 && identityResidualPeak < 1.0e-5f,
                  "identity-ratio transition leaves no residual, grain-edge step, or modulation");

    // Run the real YIN -> voiced-hysteresis -> streaming-PSOLA chain over an
    // onset, noisy fractional low tone, continuous glide to the upper range,
    // sustained high tone, and offset. This is a signal/latency fixture, not a
    // real-time CPU benchmark.
    constexpr std::uint32_t trackingFrameFrames = 2048;
    constexpr std::uint32_t trackingMaximumPeriod = 600;
    constexpr std::uint32_t trackingOnset = 4096;
    constexpr std::uint32_t trackingLowFrames = 24576;
    constexpr std::uint32_t trackingGlideFrames = 24576;
    constexpr std::uint32_t trackingHighFrames = 12288;
    constexpr std::uint32_t trackingTailFrames = 12288;
    constexpr std::uint32_t trackingOffset = trackingOnset + trackingLowFrames +
        trackingGlideFrames + trackingHighFrames;
    constexpr std::uint32_t trackingFrames = trackingOffset + trackingTailFrames;
    const ProcessSpec trackingSpec{kSampleRate, 128, 1};
    YinPitchDetector trackingYin;
    StreamingTdPsolaPitchShifter trackingPsola;
    ok &= require(trackingYin.prepare(trackingSpec, trackingFrameFrames, 80.0f, 1000.0f, 0.20f) &&
                  trackingPsola.prepare(trackingSpec, trackingMaximumPeriod),
                  "prepare complete 80-to-1000 Hz YIN/streaming-PSOLA path");
    std::vector<float> trackingInput(trackingFrames, 0.0f);
    std::vector<float> trackingOutput(trackingFrames, 0.0f);
    double trackingPhase = 0.0;
    std::uint32_t noiseState = 0x19a4c31dU;
    for (std::uint32_t frame = 0; frame < trackingFrames; ++frame) {
        float frequency = 0.0f;
        if (frame >= trackingOnset && frame < trackingOnset + trackingLowFrames) {
            frequency = 82.3f;
        } else if (frame < trackingOnset + trackingLowFrames + trackingGlideFrames &&
                   frame >= trackingOnset + trackingLowFrames) {
            const float glide = static_cast<float>(frame - trackingOnset - trackingLowFrames) /
                                trackingGlideFrames;
            frequency = 82.3f + glide * (997.3f - 82.3f);
        } else if (frame >= trackingOnset + trackingLowFrames + trackingGlideFrames &&
                   frame < trackingOffset) {
            frequency = 997.3f;
        }
        if (frequency > 0.0f) {
            trackingPhase += 2.0 * kPi * frequency / kSampleRate;
            noiseState = noiseState * 1664525U + 1013904223U;
            const float noise = (static_cast<float>(noiseState >> 8U) / 16777215.0f - 0.5f) * 0.004f;
            trackingInput[frame] = 0.5f * static_cast<float>(std::sin(trackingPhase)) + noise;
        }
    }

    std::array<float, trackingFrameFrames> trackingAnalysis{};
    std::uint32_t firstVoicedEstimateFrame = 0;
    std::uint32_t lastVoicedEstimateFrame = 0;
    std::uint32_t voicedEstimateCount = 0;
    double lowEstimateHzSum = 0.0;
    double highEstimateHzSum = 0.0;
    std::uint32_t lowEstimateCount = 0;
    std::uint32_t highEstimateCount = 0;
    const std::uint64_t trackingAllocationsBefore = gAllocationCalls;
    for (std::uint32_t offset = 0; offset < trackingFrames; offset += 128) {
        PitchEstimate trackingEstimate{};
        if (offset + 128 >= trackingFrameFrames) {
            const std::uint32_t analysisStart = offset + 128 - trackingFrameFrames;
            std::copy_n(trackingInput.data() + analysisStart, trackingFrameFrames,
                        trackingAnalysis.begin());
            ok &= require(trackingYin.analyze(trackingAnalysis.data(), trackingFrameFrames,
                                              trackingEstimate),
                          "YIN analyzes each rolling tracking window");
            if (trackingEstimate.voiced) {
                if (firstVoicedEstimateFrame == 0) firstVoicedEstimateFrame = offset + 127;
                lastVoicedEstimateFrame = offset + 127;
                ++voicedEstimateCount;
                if (offset >= trackingOnset + 4096 &&
                    offset < trackingOnset + trackingLowFrames - 4096) {
                    lowEstimateHzSum += trackingEstimate.frequencyHz;
                    ++lowEstimateCount;
                } else if (offset >= trackingOffset - 4096 &&
                           offset < trackingOffset) {
                    highEstimateHzSum += trackingEstimate.frequencyHz;
                    ++highEstimateCount;
                }
            }
        }
        ok &= require(trackingPsola.setPitchEstimate(trackingEstimate, 1.25f),
                      "live PSOLA follows the rolling YIN estimate with hysteresis");
        ok &= require(trackingPsola.processBlock(trackingInput.data() + offset,
                                                 trackingOutput.data() + offset, 128),
                      "combined YIN/PSOLA path processes actual 128-frame blocks");
    }
    ok &= require(gAllocationCalls == trackingAllocationsBefore,
                  "combined YIN and streaming PSOLA callback path allocates no memory");
    const float trackingLowOutputHz = positiveCrossingFrequency(
        trackingOutput.data(), trackingOnset + trackingPsola.latencySamples() + 4096,
        trackingOnset + trackingLowFrames + trackingPsola.latencySamples() - 4096);
    const float trackingHighOutputHz = positiveCrossingFrequency(
        trackingOutput.data(), trackingOffset - trackingHighFrames +
            trackingPsola.latencySamples() + 2048,
        trackingOffset + trackingPsola.latencySamples() - 2048);
    std::uint32_t firstAudibleOutputFrame = 0;
    std::uint32_t lastAudibleOutputFrame = 0;
    for (std::uint32_t frame = 0; frame < trackingOutput.size(); ++frame) {
        if (std::abs(trackingOutput[frame]) > 0.05f) {
            if (firstAudibleOutputFrame == 0) firstAudibleOutputFrame = frame;
            lastAudibleOutputFrame = frame;
        }
    }
    std::cout << "live-chain first-voiced=" << firstVoicedEstimateFrame
              << " (" << (firstVoicedEstimateFrame - trackingOnset)
              << " samples after input onset)"
              << " last-voiced=" << lastVoicedEstimateFrame
              << " count=" << voicedEstimateCount
              << " YIN-window=" << trackingFrameFrames
              << " PSOLA-buffer=" << trackingPsola.latencySamples()
              << " conservative-window-plus-buffer="
              << (trackingFrameFrames + trackingPsola.latencySamples())
              << " samples (" << 1000.0 * (trackingFrameFrames + trackingPsola.latencySamples()) /
                    kSampleRate << " ms); burst-first/last=" << firstAudibleOutputFrame << '/'
              << lastAudibleOutputFrame << "; measured-output=" << trackingLowOutputHz
              << '/' << trackingHighOutputHz << " Hz; measured-YIN="
              << lowEstimateHzSum / std::max(1U, lowEstimateCount) << '/'
              << highEstimateHzSum / std::max(1U, highEstimateCount) << " Hz\n";
    ok &= require(firstVoicedEstimateFrame >= trackingOnset &&
                  firstVoicedEstimateFrame <= trackingOnset + trackingFrameFrames * 2U &&
                  lastVoicedEstimateFrame < trackingFrames && voicedEstimateCount > 100,
                  "YIN tracks a noisy voiced onset through the upper-range tone and releases at offset");
    ok &= require(firstAudibleOutputFrame >= trackingOnset + trackingPsola.latencySamples() &&
                  firstAudibleOutputFrame <= trackingOnset + trackingPsola.latencySamples() + 128 &&
                  lastAudibleOutputFrame >= trackingOffset + trackingPsola.latencySamples() - 128 &&
                  lastAudibleOutputFrame <= trackingOffset + trackingPsola.latencySamples() + 128,
                  "integrated voice burst onset/offset aligns with measured streaming PSOLA buffering");
    ok &= require(std::abs(trackingLowOutputHz - 82.3f * 1.25f) < 3.0f &&
                  std::abs(trackingHighOutputHz - 997.3f * 1.25f) < 12.0f,
                  "measured live-chain output follows fractional 82.3/997.3 Hz pitches after transposition");

    StreamingTdPsolaPitchShifter delayedDry;
    ok &= require(delayedDry.prepare(liveSpec, 512) && delayedDry.setPitch(0.0f, 1.0f, false),
                  "prepare delayed dry fallback for an unvoiced input");
    std::array<float, 128> impulseInput{};
    std::array<float, 128> impulseOutput{};
    std::vector<float> delayedImpulse(2048, 0.0f);
    for (std::uint32_t offset = 0; offset < delayedImpulse.size(); offset += 128) {
        impulseInput.fill(0.0f);
        if (offset <= 100 && 100 < offset + impulseInput.size()) impulseInput[100 - offset] = 1.0f;
        ok &= require(delayedDry.processBlock(impulseInput.data(), impulseOutput.data(), 128),
                      "unvoiced fallback processes a prepared block");
        std::copy(impulseOutput.begin(), impulseOutput.end(), delayedImpulse.begin() + offset);
    }
    ok &= require(delayedImpulse[100 + delayedDry.latencySamples()] == 1.0f,
                  "unvoiced fallback preserves input with the documented streaming delay");

    for (const float frequency : {440.0f, 997.0f}) {
        const float measured = phaseVocoderFrequency(frequency, 1.0f);
        ok &= require(std::abs(measured - frequency) < 0.5f,
                      "phase-vocoder phase increment measures non-bin 440/997 Hz in radians/sample");
    }
    const float shiftedPv = phaseVocoderFrequency(440.0f, 1.25f);
    ok &= require(std::abs(shiftedPv - 550.0f) < 1.0f,
                  "phase-vocoder spectral remap yields a 550 Hz frequency estimate");
    PhaseVocoder invalidVocoder;
    ok &= require(!invalidVocoder.prepare(spec, 1000, 128, 128),
                  "phase-vocoder rejects non-power-of-two STFT sizes");
    ok &= require(PhaseVocoder::requiredPrepareBytes(2048) > 0,
                  "phase-vocoder exposes a bounded scratch-memory estimate");
    PhaseVocoder retainedVocoder;
    ok &= require(retainedVocoder.prepare(spec, 2048, 256, 256),
                  "prepare phase-vocoder for staged-configuration check");
    ok &= require(!retainedVocoder.prepare(spec, 1000, 128, 128) &&
                  retainedVocoder.fftFrames() == 2048,
                  "rejected phase-vocoder prepare preserves the current frame configuration");

    MultibandVocoder vocoder;
    ok &= require(vocoder.prepare(spec, 16, 80.0f, 10000.0f, 1.25f),
                  "prepare 16-band linked-stereo browser vocoder");
    std::array<float, 512> modL{};
    std::array<float, 512> modR{};
    std::array<float, 512> carL{};
    std::array<float, 512> carR{};
    std::array<float, 512> outL{};
    std::array<float, 512> outR{};
    double outputEnergy = 0.0;
    double channelRatioError = 0.0;
    std::uint64_t absoluteFrame = 0;
    const std::uint64_t vocoderAllocationsBefore = gAllocationCalls;
    for (std::uint32_t block = 0; block < static_cast<std::uint32_t>(kSampleRate / 512); ++block) {
        for (std::uint32_t i = 0; i < modL.size(); ++i, ++absoluteFrame) {
            modL[i] = sine(220.0f, absoluteFrame, 0.5f);
            modR[i] = modL[i];
            carL[i] = sine(500.0f, absoluteFrame, 0.8f);
            carR[i] = 0.5f * carL[i];
        }
        ok &= require(vocoder.processBlock(modL.data(), modR.data(), carL.data(), carR.data(),
                                           outL.data(), outR.data(), 512),
                      "vocoder processes one prepared block without allocation");
        for (std::uint32_t i = 128; i < outL.size(); ++i) {
            outputEnergy += static_cast<double>(outL[i]) * outL[i];
            channelRatioError += std::abs(outR[i] - 0.5f * outL[i]);
        }
    }
    ok &= require(outputEnergy > 1.0, "vocoder filterbank yields non-silent carrier output");
    ok &= require(gAllocationCalls == vocoderAllocationsBefore,
                  "vocoder processBlock performs no heap allocations");
    ok &= require(channelRatioError < 1.0e-3, "vocoder keeps a linked stereo carrier image");
    ok &= require(vocoder.bandCount() == 16, "Browser vocoder preset has exactly 16 bands");
    ok &= require(MultibandVocoder::requiredPrepareBytes() >= sizeof(MultibandVocoder),
                  "fixed-array multiband vocoder exposes its prepared-state memory budget");
    ok &= require(!vocoder.prepare(spec, 3, 80.0f, 10000.0f, 1.25f) &&
                  vocoder.bandCount() == 16,
                  "rejected multiband-vocoder prepare preserves the active filterbank");
    ok &= require(!vocoder.processBlock(nullptr, modR.data(), carL.data(), carR.data(),
                                        outL.data(), outR.data(), 1),
                  "vocoder rejects invalid process buffers");

    SignalsmithStretchAdapter stretch(0x50524cU);
    SignalsmithStretchSettings stretchSettings{};
    stretchSettings.mode = PitchQualityMode::LiveMono;
    stretchSettings.channels = 1;
    stretchSettings.blockSamples = 512;
    stretchSettings.intervalSamples = 128;
    stretchSettings.splitComputation = false;
    stretchSettings.seed = 0x50524cU;
    ProcessSpec monoSpec{kSampleRate, 128, 1};
    constexpr std::size_t stretchBudget = 64U * 1024U * 1024U;
    const std::size_t stretchRequiredBytes =
        SignalsmithStretchAdapter::requiredPrepareBytes(monoSpec, stretchSettings);
    ok &= require(stretchRequiredBytes > 0 && stretchRequiredBytes < stretchBudget,
                  "Signalsmith adapter publishes a bounded conservative prepare estimate");
    ok &= require(stretch.prepare(monoSpec, stretchSettings, stretchBudget),
                  "prepare seeded Signalsmith adapter within an explicit staging budget");
    ok &= require(stretch.inputLatencySamples() > 0 && stretch.outputLatencySamples() > 0,
                  "Signalsmith reports separately measured input/output algorithm latency");
    ok &= require(stretch.setTransposeFactor(1.5f) && stretch.setFormantFactor(1.0f, false),
                  "Signalsmith configures transpose and formant policy");
    SignalsmithStretchAdapter stretchControl(0x50524cU);
    ok &= require(stretchControl.prepare(monoSpec, stretchSettings, stretchBudget) &&
                  stretchControl.setTransposeFactor(1.5f) &&
                  stretchControl.setFormantFactor(1.0f, false),
                  "prepare deterministic peer for staged-replacement PCM comparison");
    std::array<float, 128> stretchInput{};
    std::array<float, 128> stretchOutput{};
    std::array<float, 128> stretchControlOutput{};
    const float* inputChannels[1] = {stretchInput.data()};
    float* outputChannels[1] = {stretchOutput.data()};
    float* controlOutputChannels[1] = {stretchControlOutput.data()};
    double stretchOutputEnergy = 0.0;
    absoluteFrame = 0;
    const std::uint64_t stretchAllocationsBefore = gAllocationCalls;
    for (std::uint32_t block = 0; block < 128; ++block) {
        for (std::uint32_t i = 0; i < stretchInput.size(); ++i, ++absoluteFrame) {
            stretchInput[i] = sine(440.0f, absoluteFrame, 0.5f);
        }
        ok &= require(stretch.process(inputChannels, 128, outputChannels, 128),
                      "Signalsmith processes an actual callback block");
        ok &= require(stretchControl.process(inputChannels, 128, controlOutputChannels, 128),
                      "deterministic peer follows the same callback stream");
        for (float sample : stretchOutput) {
            ok &= require(std::isfinite(sample), "Signalsmith output stays finite");
            stretchOutputEnergy += static_cast<double>(sample) * sample;
        }
    }
    ok &= require(gAllocationCalls == stretchAllocationsBefore,
                  "Signalsmith process path performs no heap allocations after prepare");
    ok &= require(stretchOutputEnergy > 0.01, "Signalsmith callback stream yields non-silent PCM");
    ok &= require(!stretch.process(inputChannels, 129, outputChannels, 128),
                  "Signalsmith rejects blocks above its prepared callback maximum");

    const auto previousInputLatency = stretch.inputLatencySamples();
    const auto previousOutputLatency = stretch.outputLatencySamples();
    auto rejectedSeedSettings = stretchSettings;
    ++rejectedSeedSettings.seed;
    ok &= require(!stretch.prepare(monoSpec, rejectedSeedSettings, stretchBudget),
                  "Signalsmith rejects a seed that differs from its immutable constructor seed");
    auto rejectedSizeSettings = stretchSettings;
    rejectedSizeSettings.blockSamples = 32;
    ok &= require(!stretch.prepare(monoSpec, rejectedSizeSettings, stretchBudget),
                  "Signalsmith rejects invalid replacement settings before staging");
    ok &= require(stretch.prepared() && stretch.settings().seed == stretchSettings.seed &&
                  stretch.settings().blockSamples == stretchSettings.blockSamples &&
                  stretch.inputLatencySamples() == previousInputLatency &&
                  stretch.outputLatencySamples() == previousOutputLatency,
                  "rejected prepare preserves the active engine metadata and latency");
    ok &= require(!stretch.prepare(monoSpec, stretchSettings, stretchRequiredBytes),
                  "replacement is rejected when the budget omits active-plus-staged peak memory");
    ok &= require(stretch.prepared() && stretch.inputLatencySamples() == previousInputLatency,
                  "an under-budget replacement leaves the active processor usable");

    for (std::uint32_t i = 0; i < stretchInput.size(); ++i) {
        stretchInput[i] = sine(440.0f, absoluteFrame + i, 0.5f);
    }
    absoluteFrame += stretchInput.size();
    ok &= require(stretch.process(inputChannels, 128, outputChannels, 128) &&
                  stretchControl.process(inputChannels, 128, controlOutputChannels, 128),
                  "active and control engines continue after all rejected replacements");
    ok &= require(std::equal(stretchOutput.begin(), stretchOutput.end(),
                             stretchControlOutput.begin()),
                  "rejected prepare calls preserve the active engine's next PCM exactly");

    stretchInput.fill(0.0f);
    stretchInput[0] = std::numeric_limits<float>::quiet_NaN();
    stretchInput[1] = std::numeric_limits<float>::infinity();
    stretchInput[2] = -std::numeric_limits<float>::infinity();
    ok &= require(stretch.process(inputChannels, 128, outputChannels, 128),
                  "Signalsmith accepts buffers containing nonfinite input samples after sanitizing");
    ok &= require(std::all_of(stretchOutput.begin(), stretchOutput.end(),
                              [](float sample) { return std::isfinite(sample); }),
                  "Signalsmith emits only finite PCM after NaN/Inf input");
    for (std::uint32_t i = 0; i < stretchInput.size(); ++i) {
        stretchInput[i] = sine(440.0f, absoluteFrame + i, 0.5f);
    }
    absoluteFrame += stretchInput.size();
    ok &= require(stretch.process(inputChannels, 128, outputChannels, 128) &&
                  std::all_of(stretchOutput.begin(), stretchOutput.end(),
                              [](float sample) { return std::isfinite(sample); }),
                  "finite input recovers with finite output after nonfinite input sanitation");

    if (!ok) return 1;
    std::cout << "PASS: YIN; buffer/streaming TD-PSOLA; phase-vocoder spectral frames; "
                 "16-band linked-stereo vocoder; seeded Signalsmith adapter\n";
    std::cout << "PSOLA 440->" << shiftedFrequency << " Hz; PV 440->" << shiftedPv
              << " Hz; streaming PSOLA latency=" << livePsola.latencySamples()
              << " samples; Signalsmith input/output latency=" << stretch.inputLatencySamples()
              << '/' << stretch.outputLatencySamples() << " samples\n";
    return 0;
}
