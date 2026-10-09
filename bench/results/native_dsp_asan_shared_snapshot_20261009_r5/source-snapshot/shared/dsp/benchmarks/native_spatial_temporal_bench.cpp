#include "webrc/dsp/fft.hpp"
#include "webrc/dsp/spatial_temporal.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdint>
#include <cstdio>
#include <vector>

namespace {

using namespace webrc::dsp;
constexpr double kPi = 3.141592653589793238462643383279502884;
constexpr double kSampleRate = 48000.0;

double rms(const std::vector<float>& samples, std::size_t begin, std::size_t end) {
    double energy = 0.0;
    for (std::size_t i = begin; i < end; ++i) energy += static_cast<double>(samples[i]) * samples[i];
    return end > begin ? std::sqrt(energy / static_cast<double>(end - begin)) : 0.0;
}

double goertzelEnergy(const std::vector<float>& samples, std::size_t begin,
                      std::size_t end, double frequency) {
    const double omega = 2.0 * kPi * frequency / kSampleRate;
    const double coefficient = 2.0 * std::cos(omega);
    double s1 = 0.0;
    double s2 = 0.0;
    for (std::size_t i = begin; i < end; ++i) {
        const double s0 = samples[i] + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    const double real = s1 - s2 * std::cos(omega);
    const double imag = s2 * std::sin(omega);
    return real * real + imag * imag;
}

double dominantFrequency(const std::vector<float>& samples, std::size_t begin,
                         std::size_t end, double minHz, double maxHz, double stepHz) {
    double bestHz = minHz;
    double bestEnergy = -1.0;
    for (double hz = minHz; hz <= maxHz; hz += stepHz) {
        const double energy = goertzelEnergy(samples, begin, end, hz);
        if (energy > bestEnergy) { bestEnergy = energy; bestHz = hz; }
    }
    return bestHz;
}

struct DecayFit { double t20 = 0.0; double t30 = 0.0; };

DecayFit fitBandDecay(const std::vector<float>& samples, double centerHz) {
    const double omega = 2.0 * kPi * centerHz / kSampleRate;
    const double cosine = std::cos(omega);
    const double alpha = std::sin(omega) * 0.5; // RBJ Q=1 band-pass.
    const double inverseA0 = 1.0 / (1.0 + alpha);
    const double b0 = alpha * inverseA0;
    const double b2 = -alpha * inverseA0;
    const double a1 = -2.0 * cosine * inverseA0;
    const double a2 = (1.0 - alpha) * inverseA0;
    std::vector<double> edc(samples.size());
    double x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        const double x = samples[i];
        const double y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        edc[i] = y * y;
    }
    double remaining = 0.0;
    for (auto it = edc.rbegin(); it != edc.rend(); ++it) { remaining += *it; *it = remaining; }
    if (edc.empty() || edc.front() <= 0.0) return {};
    const auto crossing = [&edc](double levelDb) {
        const double threshold = edc.front() * std::pow(10.0, levelDb / 10.0);
        for (std::size_t i = 1; i < edc.size(); ++i) {
            if (edc[i] <= threshold && edc[i - 1] > threshold) {
                const double d = edc[i - 1] - edc[i];
                const double fraction = d > 0.0 ? (edc[i - 1] - threshold) / d : 0.0;
                return (static_cast<double>(i - 1) + fraction) / kSampleRate;
            }
        }
        return 0.0;
    };
    return {(crossing(-25.0) - crossing(-5.0)) * 3.0,
            (crossing(-35.0) - crossing(-5.0)) * 2.0};
}

struct FdnQuality {
    double correlation = 0.0;
    std::array<DecayFit, 3> decay{};
};

FdnQuality measureFdn(FdnLineCount count) {
    constexpr std::size_t frames = 96000;
    FdnReverb reverb;
    reverb.prepare({48000.0f, 256, 2}, count, 0.12f);
    reverb.setParameters(1.0f, 4500.0f, 0.23f, 0.18f, 0.9995f, 1.0f, 0.0f);
    std::vector<float> left(frames), right(frames);
    double l2 = 0.0, r2 = 0.0, lr = 0.0;
    for (std::size_t i = 0; i < frames; ++i) {
        const auto out = reverb.processSample(i == 0 ? 1.0f : 0.0f, 0.0f);
        left[i] = out.left; right[i] = out.right;
        l2 += static_cast<double>(out.left) * out.left;
        r2 += static_cast<double>(out.right) * out.right;
        lr += static_cast<double>(out.left) * out.right;
    }
    FdnQuality result;
    result.correlation = lr / std::sqrt(std::max(1.0e-30, l2 * r2));
    result.decay = {fitBandDecay(left, 100.0), fitBandDecay(left, 1000.0), fitBandDecay(left, 4000.0)};
    return result;
}

struct Timing {
    double p50 = 0, p99 = 0, p999 = 0, maximum = 0;
    std::uint32_t over60Percent = 0, over80Percent = 0, over100Percent = 0;
    std::vector<double> startupElapsedNs;
    std::vector<double> rawElapsedNs;
};

template <class Callback>
Timing timeCallback(std::uint32_t frames, Callback&& callback) {
    constexpr std::size_t startupSamples = 32;
    constexpr std::size_t measuredSamples = 2500;
    const double callbackBudgetNs = static_cast<double>(frames) / kSampleRate * 1.0e9;
    Timing timing;
    timing.startupElapsedNs.reserve(startupSamples);
    timing.rawElapsedNs.reserve(measuredSamples);
    const auto measureOne = [&](std::vector<double>& destination) {
        const auto start = std::chrono::steady_clock::now();
        callback(frames);
        const auto stop = std::chrono::steady_clock::now();
        const double elapsed = std::chrono::duration<double, std::nano>(stop - start).count();
        destination.push_back(elapsed);
        return elapsed;
    };
    for (std::size_t i = 0; i < startupSamples; ++i) (void)measureOne(timing.startupElapsedNs);
    for (std::size_t i = 0; i < measuredSamples; ++i) {
        const double elapsed = measureOne(timing.rawElapsedNs);
        if (elapsed > callbackBudgetNs * 0.60) ++timing.over60Percent;
        if (elapsed > callbackBudgetNs * 0.80) ++timing.over80Percent;
        if (elapsed > callbackBudgetNs) ++timing.over100Percent;
    }
    std::vector<double> sorted = timing.rawElapsedNs;
    std::sort(sorted.begin(), sorted.end());
    const auto at = [&sorted](double q) {
        const auto index = static_cast<std::size_t>(std::ceil(q * sorted.size()) - 1.0);
        return sorted[std::min(index, sorted.size() - 1)];
    };
    timing.p50 = at(0.50);
    timing.p99 = at(0.99);
    timing.p999 = at(0.999);
    timing.maximum = sorted.back();
    return timing;
}

void printTiming(const char* name, const Timing& timing) {
    (void)name;
    std::printf("\"p50_ns\":%.1f,\"p99_ns\":%.1f,\"p999_ns\":%.1f,\"max_ns\":%.1f,",
                timing.p50, timing.p99, timing.p999, timing.maximum);
    std::printf("\"deadline_overrun_counts\":{\"over_60pct_budget\":%u,\"over_80pct_budget\":%u,\"over_100pct_budget\":%u},",
                timing.over60Percent, timing.over80Percent, timing.over100Percent);
    std::printf("\"startup_elapsed_ns\":[");
    for (std::size_t i = 0; i < timing.startupElapsedNs.size(); ++i) {
        if (i != 0) std::printf(",");
        std::printf("%.1f", timing.startupElapsedNs[i]);
    }
    std::printf("],\"raw_elapsed_ns\":[");
    for (std::size_t i = 0; i < timing.rawElapsedNs.size(); ++i) {
        if (i != 0) std::printf(",");
        std::printf("%.1f", timing.rawElapsedNs[i]);
    }
    std::printf("]");
}

double measureFftDftError() {
    constexpr std::size_t size = 128;
    std::array<std::complex<float>, size> values{};
    std::array<float, size> input{};
    std::uint32_t state = 0x1234abcdU;
    for (std::size_t i = 0; i < size; ++i) {
        state = state * 1664525U + 1013904223U;
        const double noise = static_cast<double>(state >> 8) * (2.0 / 16777216.0) - 1.0;
        input[i] = static_cast<float>(0.65 * noise + 0.25 * std::sin(
            2.0 * kPi * (5.0 * i + 0.015 * i * i) / size));
        values[i] = {input[i], 0.0f};
    }
    const bool transformed = fft::transform(values.data(), size, fft::Direction::Forward);
    if (!transformed) return 1.0e30;
    double maxError = 0.0;
    for (std::size_t bin = 0; bin < size; ++bin) {
        std::complex<double> reference{};
        for (std::size_t sample = 0; sample < size; ++sample) {
            const double phase = -2.0 * kPi * static_cast<double>(bin * sample) / size;
            reference += static_cast<double>(input[sample]) *
                         std::complex<double>(std::cos(phase), std::sin(phase));
        }
        maxError = std::max(maxError, std::abs(std::complex<double>(values[bin].real(), values[bin].imag()) - reference));
    }
    return maxError;
}

double measureConvolverResidual() {
    constexpr std::uint32_t partition = 32, irFrames = 51, total = 512;
    const ProcessSpec spec{48000.0f, 256, 2};
    std::array<float, irFrames> ll{}, lr{}, rl{}, rr{};
    ll[0] = 0.75f; ll[1] = 0.2f; ll[17] = -0.1f; ll[50] = 0.03f;
    lr[0] = 0.11f; lr[18] = 0.07f;
    rl[0] = -0.09f; rl[3] = 0.04f;
    rr[0] = 0.9f; rr[8] = -0.13f; rr[49] = 0.02f;
    std::array<float, total> inL{}, inR{}, outL{}, outR{};
    inL[0] = 1.0f; inR[0] = -0.5f;
    for (std::uint32_t i = 1; i < 100; ++i) {
        inL[i] += 0.25f * std::sin(static_cast<float>(i) * 0.17f);
        inR[i] += 0.2f * std::cos(static_cast<float>(i) * 0.13f);
    }
    PartitionedConvolver convolver;
    convolver.prepare(spec, partition, irFrames, ll.data(), lr.data(), rl.data(), rr.data());
    for (std::uint32_t offset = 0; offset < total; offset += 64)
        convolver.processBlock(inL.data() + offset, inR.data() + offset,
                               outL.data() + offset, outR.data() + offset, 64);
    double error = 0.0;
    for (std::uint32_t t = 0; t + partition < total; ++t) {
        double expectedL = 0, expectedR = 0;
        for (std::uint32_t tap = 0; tap < irFrames && tap <= t; ++tap) {
            expectedL += ll[tap] * inL[t - tap] + lr[tap] * inR[t - tap];
            expectedR += rl[tap] * inL[t - tap] + rr[tap] * inR[t - tap];
        }
        error = std::max(error, std::max(std::abs(expectedL - outL[t + partition]),
                                         std::abs(expectedR - outR[t + partition])));
    }
    return error;
}

double measureFreezeIdentity(std::uint32_t windowFrames, std::uint32_t hopFrames) {
    constexpr std::uint32_t total = 8192;
    SpectralFreeze freeze;
    freeze.prepare({48000.0f, 256, 2}, windowFrames, hopFrames);
    double maxError = 0.0;
    for (std::uint32_t i = 0; i < total; ++i) {
        const float input = static_cast<float>(0.31 * std::sin(i * 0.071) + 0.17 * std::cos(i * 0.021));
        const auto output = freeze.processSample(input, -0.7f * input);
        if (i >= windowFrames) {
            maxError = std::max(maxError, std::max(
                std::abs(static_cast<double>(output.left - (0.31 * std::sin((i - windowFrames) * 0.071) +
                                                             0.17 * std::cos((i - windowFrames) * 0.021)))),
                std::abs(static_cast<double>(output.right + 0.7 * (0.31 * std::sin((i - windowFrames) * 0.071) +
                                                                    0.17 * std::cos((i - windowFrames) * 0.021))))));
        }
    }
    return maxError;
}

struct DrumQuality { double peak = 0.0, rmsValue = 0.0; bool idle = false; };

DrumQuality measureKick() {
    DrumKickVoice voice;
    voice.prepare({48000.0f, 256, 2});
    voice.trigger({180.0f, 42.0f, 0.07f, 0.4f, 0.85f});
    double peak = 0.0, energy = 0.0;
    constexpr std::size_t frames = 200000;
    for (std::size_t i = 0; i < frames; ++i) {
        const auto out = voice.processSample();
        peak = std::max(peak, std::abs(static_cast<double>(out.left)));
        if (i < 4800) energy += static_cast<double>(out.left) * out.left;
    }
    return {peak, std::sqrt(energy / 4800.0), !voice.active()};
}

DrumQuality measureSnare() {
    DrumSnareVoice voice;
    voice.prepare({48000.0f, 256, 2});
    SnareVoiceParameters parameters;
    parameters.seed = 20261009;
    voice.trigger(parameters);
    double peak = 0.0, energy = 0.0;
    constexpr std::size_t frames = 96000;
    for (std::size_t i = 0; i < frames; ++i) {
        const auto out = voice.processSample();
        peak = std::max(peak, std::abs(static_cast<double>(out.left)));
        if (i < 4800) energy += static_cast<double>(out.left) * out.left;
    }
    return {peak, std::sqrt(energy / 4800.0), !voice.active()};
}

DrumQuality measureHat() {
    DrumHiHatVoice voice;
    voice.prepare({48000.0f, 256, 2});
    HiHatVoiceParameters parameters;
    parameters.seed = 811;
    voice.trigger(parameters);
    double peak = 0.0, energy = 0.0;
    constexpr std::size_t frames = 48000;
    for (std::size_t i = 0; i < frames; ++i) {
        const auto out = voice.processSample();
        peak = std::max(peak, std::abs(static_cast<double>(out.left)));
        if (i < 4800) energy += static_cast<double>(out.left) * out.left;
    }
    return {peak, std::sqrt(energy / 4800.0), !voice.active()};
}

void printDrum(const char* name, const DrumQuality& q) {
    std::printf("{\"name\":\"%s\",\"peak\":%.9g,\"attack_rms\":%.9g,\"idle_after_render\":%s}",
                name, q.peak, q.rmsValue, q.idle ? "true" : "false");
}

} // namespace

int main() {
    const auto fdn8 = measureFdn(FdnLineCount::Eight);
    const auto fdn16 = measureFdn(FdnLineCount::Sixteen);
    const auto kick = measureKick();
    const auto snare = measureSnare();
    const auto hat = measureHat();
    const double fftError = measureFftDftError();
    const double convolverError = measureConvolverResidual();
    const std::array<std::array<std::uint32_t, 2>, 3> windows{{{{256, 128}}, {{512, 128}}, {{1024, 256}}}};
    std::array<double, 3> identityErrors{};
    for (std::size_t i = 0; i < windows.size(); ++i)
        identityErrors[i] = measureFreezeIdentity(windows[i][0], windows[i][1]);

    std::printf("{\"schema\":\"webrc.spatial-temporal-bench.v2\",\"fixture\":{\"sample_rate_hz\":48000,\"seed_fft\":305441741,\"seed_drum\":20261009,\"seed_hat\":811,\"fdn_impulse\":\"left unit impulse\",\"fdn_rt60_target_seconds\":1.0,\"fdn_damping_hz\":4500,\"fdn_modulation_rate_hz\":0.23,\"fdn_modulation_depth_ms\":0.18,\"freeze_window_hop\":[[256,128],[512,128],[1024,256]],\"callback_startup_sample_count\":32,\"callback_raw_sample_count\":2500,\"callback_raw_sample_order\":\"chronological\",\"deadline_overrun_budgets_percent\":[60,80,100]},");
    std::printf("\"quality\":{\"fft_independent_dft_max_error\":%.12g,\"convolver_max_residual\":%.12g,\"convolver_partition_latency_samples\":32,",
                fftError, convolverError);
    std::printf("\"fdn8\":{\"stereo_correlation\":%.9g,\"bands_hz\":[100,1000,4000],\"t20_seconds\":[%.9g,%.9g,%.9g],\"t30_seconds\":[%.9g,%.9g,%.9g]},",
                fdn8.correlation, fdn8.decay[0].t20, fdn8.decay[1].t20, fdn8.decay[2].t20,
                fdn8.decay[0].t30, fdn8.decay[1].t30, fdn8.decay[2].t30);
    std::printf("\"fdn16\":{\"stereo_correlation\":%.9g,\"bands_hz\":[100,1000,4000],\"t20_seconds\":[%.9g,%.9g,%.9g],\"t30_seconds\":[%.9g,%.9g,%.9g]},",
                fdn16.correlation, fdn16.decay[0].t20, fdn16.decay[1].t20, fdn16.decay[2].t20,
                fdn16.decay[0].t30, fdn16.decay[1].t30, fdn16.decay[2].t30);

    // Freeze non-bin tones: capture a 440 Hz left and 997 Hz right, then analyze held output.
    SpectralFreeze freeze;
    freeze.prepare({48000.0f, 256, 2}, 1024, 256);
    double inputEnergy = 0.0, outputEnergy = 0.0;
    std::vector<float> heldLeft(48000), heldRight(48000);
    for (std::uint32_t i = 0; i < 12288; ++i) {
        const auto out = freeze.processSample(static_cast<float>(0.5 * std::sin(2.0 * kPi * 440.0 * i / 48000.0)),
                                              static_cast<float>(0.5 * std::sin(2.0 * kPi * 997.0 * i / 48000.0)));
        if (i >= 8192) { inputEnergy += out.left * out.left; }
    }
    freeze.setFreeze(true);
    for (std::uint32_t i = 0; i < 48000; ++i) {
        const auto out = freeze.processSample(0.0f, 0.0f);
        heldLeft[i] = out.left; heldRight[i] = out.right;
        outputEnergy += out.left * out.left + out.right * out.right;
    }
    const double heldLeftRms = rms(heldLeft, 12000, 44000);
    const double heldRightRms = rms(heldRight, 12000, 44000);
    (void)inputEnergy;
    std::printf("\"spectral_freeze\":{\"window_frames\":1024,\"hop_frames\":256,\"latency_samples\":1024,\"held_left_hz\":%.3f,\"held_right_hz\":%.3f,\"held_left_rms\":%.9g,\"held_right_rms\":%.9g,\"held_total_energy\":%.9g,\"wola_identity\":[",
                dominantFrequency(heldLeft, 12000, 44000, 420.0, 460.0, 0.25),
                dominantFrequency(heldRight, 12000, 44000, 970.0, 1020.0, 0.25),
                heldLeftRms, heldRightRms, outputEnergy);
    for (std::size_t i = 0; i < windows.size(); ++i) {
        if (i != 0) std::printf(",");
        std::printf("{\"window_frames\":%u,\"hop_frames\":%u,\"max_identity_error\":%.12g}",
                    windows[i][0], windows[i][1], identityErrors[i]);
    }
    std::printf("]},\"drum_voices\":[");
    printDrum("kick_exponential_sweep", kick); std::printf(",");
    printDrum("snare_noise_plus_body", snare); std::printf(",");
    printDrum("hihat_inharmonic_partials_plus_noise", hat);
    std::printf("]},\"callback_timing\":[");

    std::array<float, 256> inL{}, inR{}, outL{}, outR{};
    std::array<double, 256> phases{};
    for (std::uint32_t i = 0; i < 256; ++i) {
        inL[i] = 0.1f * std::sin(static_cast<float>(i) * 0.019f);
        inR[i] = 0.1f * std::cos(static_cast<float>(i) * 0.023f);
    }
    const std::array<std::uint32_t, 3> blockSizes{64, 128, 256};
    bool first = true;
    for (const auto frames : blockSizes) {
        const ProcessSpec spec{48000.0f, 256, 2};
        FdnReverb fdn8Runtime, fdn16Runtime;
        fdn8Runtime.prepare(spec, FdnLineCount::Eight);
        fdn16Runtime.prepare(spec, FdnLineCount::Sixteen);
        fdn8Runtime.setParameters(1.0f, 4500, 0.23f, 0.18f, 0.9995f, 0.65f, 0.0f);
        fdn16Runtime.setParameters(1.0f, 4500, 0.23f, 0.18f, 0.9995f, 0.65f, 0.0f);
        PartitionedConvolver conv;
        std::array<float, 4096> ir{}; ir[0] = 1.0f; ir[127] = 0.2f; ir[1024] = -0.1f;
        conv.prepare(spec, 128, static_cast<std::uint32_t>(ir.size()), ir.data(), nullptr, nullptr, ir.data());
        GranularTexture grains;
        grains.prepare(spec, 0.5f); grains.setParameters(80, 150, 1.07f, 0.5f, 0.7f, 0x20261009ULL);
        SpectralFreeze spectral;
        spectral.prepare(spec, 1024, 256); spectral.setFreeze(true);
        ReverseSegment reverse;
        reverse.prepare(spec, 8192, 8192, 1024);
        PlatterInertia platter; platter.prepare(spec); platter.setTargetSpeed(0.83f);
        DrumVoicePool drumPool; drumPool.prepare(spec);
        DrumVoiceParameters modal; modal.noise = 0.2f; modal.seed = 0x2305;
        KickVoiceParameters kickParams;
        SnareVoiceParameters snareParams;
        HiHatVoiceParameters hatParams;
        for (std::uint32_t voice = 0; voice < 8; ++voice) {
            modal.seed += voice;
            switch (voice % 4) {
                case 0: drumPool.triggerModal(modal); break;
                case 1: drumPool.triggerKick(kickParams); break;
                case 2: snareParams.seed += voice; drumPool.triggerSnare(snareParams); break;
                default: hatParams.seed += voice; drumPool.triggerHiHat(hatParams); break;
            }
        }

        const auto append = [&](const char* name, const Timing& timing) {
            if (!first) std::printf(","); first = false;
            std::printf("{\"name\":\"%s\",\"block_frames\":%u,\"sample_rate_hz\":48000,\"callback_budget_ns\":%.1f,",
                        name, frames, static_cast<double>(frames) / kSampleRate * 1.0e9);
            printTiming("distribution", timing);
            std::printf("}");
        };
        append("fdn8", timeCallback(frames, [&](std::uint32_t n) { fdn8Runtime.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), n); }));
        append("fdn16", timeCallback(frames, [&](std::uint32_t n) { fdn16Runtime.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), n); }));
        append("partitioned_convolver_4096_ir", timeCallback(frames, [&](std::uint32_t n) { conv.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), n); }));
        append("granular_32_voice_pool", timeCallback(frames, [&](std::uint32_t n) { grains.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), n); }));
        append("spectral_freeze_1024_256", timeCallback(frames, [&](std::uint32_t n) { spectral.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), n); }));
        append("reverse_segment_8192_1024", timeCallback(frames, [&](std::uint32_t n) { reverse.processBlock(inL.data(), inR.data(), outL.data(), outR.data(), n); }));
        append("platter_inertia", timeCallback(frames, [&](std::uint32_t n) { platter.processBlock(outL.data(), phases.data(), outR.data(), n); }));
        append("drum_mixed_8_voice_pool", timeCallback(frames, [&](std::uint32_t n) { drumPool.processBlock(outL.data(), outR.data(), n); }));
    }
    std::printf("]}\n");
    return 0;
}
