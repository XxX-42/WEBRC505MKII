#include "webrc/dsp/primitives.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <ostream>
#include <string>
#include <thread>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;
constexpr std::uint32_t kFrames = 64;
constexpr std::uint32_t kMeasuredBlocks = 20000;
constexpr float kSampleRate = 48000.0f;
volatile double gChecksum = 0.0;

struct DspStack {
    webrc::dsp::ParameterSmoother smoother;
    webrc::dsp::BiquadDf2T biquad;
    webrc::dsp::TptStateVariableFilter svf;
    webrc::dsp::AllPass1 allpass;
    webrc::dsp::LagrangeDelay delay;
    webrc::dsp::Lfo lfo;
    webrc::dsp::PolyBlepOscillator oscillator;
    webrc::dsp::AdaaCubicShaper shaper;
    webrc::dsp::DualDetectorCompressor compressor;
    webrc::dsp::DelayMatrix2 matrix;
    std::array<float, kFrames> source{};
    std::array<float, kFrames> rightSource{};
    std::array<float, kFrames> a{};
    std::array<float, kFrames> b{};
    std::array<float, kFrames> c{};
    std::array<float, kFrames> d{};
    std::array<float, kFrames> delaySamples{};
    std::array<float, 64> sincSource{};

    bool prepare() {
        const webrc::dsp::ProcessSpec spec{kSampleRate, kFrames, 2};
        if (!smoother.prepare(spec) || !biquad.prepare(spec) || !svf.prepare(spec) ||
            !allpass.prepare(spec) || !delay.prepare(spec, 2048) || !lfo.prepare(spec) ||
            !oscillator.prepare(spec) || !shaper.prepare(spec) || !compressor.prepare(spec)) {
            return false;
        }
        smoother.reset(0.25f);
        if (!smoother.setTarget(0.75f, 30.0f) || !biquad.setLowpass(8000.0f, 0.707f, 5.0f) ||
            !svf.setFrequencyQ(2400.0f, 0.8f, 5.0f) ||
            !allpass.setFrequency(3000.0f, 5.0f) || !lfo.setFrequency(4.2f) ||
            !oscillator.setFrequency(110.0f) ||
            !compressor.setParameters(-18.0f, 4.0f, 6.0f, 5.0f, 80.0f, 0.5f, 0.0f) ||
            !matrix.setFeedback(0.55f, 0.28f)) {
            return false;
        }
        oscillator.setWaveform(webrc::dsp::OscillatorWaveform::Saw);
        for (std::uint32_t i = 0; i < kFrames; ++i) {
            const double phase = 2.0 * 3.14159265358979323846 * 440.0 * i / kSampleRate;
            source[i] = static_cast<float>(0.2 * std::sin(phase));
            rightSource[i] = static_cast<float>(0.2 * std::cos(phase));
            delaySamples[i] = 180.25f;
        }
        for (std::size_t i = 0; i < sincSource.size(); ++i) {
            sincSource[i] = static_cast<float>(std::sin(2.0 * 3.14159265358979323846 * i / 64.0));
        }
        return true;
    }

    void processBlock() {
        (void)smoother.processBlock(a.data(), kFrames);
        (void)biquad.processBlock(source.data(), b.data(), kFrames);
        (void)svf.processBlock(b.data(), c.data(), d.data(), a.data(), kFrames);
        (void)allpass.processBlock(c.data(), b.data(), kFrames);
        (void)delay.processBlock(b.data(), c.data(), delaySamples.data(), kFrames);
        (void)shaper.processBlock(c.data(), d.data(), kFrames);
        (void)compressor.processBlock(d.data(), rightSource.data(), a.data(), b.data(), kFrames);
        (void)lfo.processBlock(c.data(), kFrames);
        (void)oscillator.processBlock(d.data(), kFrames);
        double sum = 0.0;
        for (std::uint32_t i = 0; i < kFrames; ++i) {
            const auto mixed = matrix.process({a[i], b[i]}, {c[i], d[i]});
            sum += mixed.left + mixed.right +
                   webrc::dsp::sinc8Read(sincSource.data(), sincSource.size(), 31.25 + i * 0.01,
                                         webrc::dsp::BoundaryMode::Wrap);
            sum += webrc::dsp::equalPowerCrossfade(c[i], d[i], a[i]);
        }
        gChecksum = gChecksum + sum;
    }
};

std::vector<double> measure(DspStack& stack, std::uint32_t blocks) {
    std::vector<double> microseconds;
    microseconds.reserve(blocks);
    for (std::uint32_t i = 0; i < blocks; ++i) {
        const auto start = Clock::now();
        stack.processBlock();
        const auto stop = Clock::now();
        microseconds.push_back(std::chrono::duration<double, std::micro>(stop - start).count());
    }
    return microseconds;
}

double percentile(const std::vector<double>& sorted, double p) {
    if (sorted.empty()) return 0.0;
    const auto rank = static_cast<std::size_t>(std::ceil(p * sorted.size()));
    return sorted[std::max<std::size_t>(1U, rank) - 1U];
}

std::vector<double> sortedCopy(const std::vector<double>& values) {
    auto sorted = values;
    std::sort(sorted.begin(), sorted.end());
    return sorted;
}

void report(const char* label, const std::vector<double>& values) {
    const auto sorted = sortedCopy(values);
    std::printf("%s blocks=%zu P50=%.3f us P95=%.3f us P99=%.3f us P99.9=%.3f us max=%.3f us\n",
                label, sorted.size(), percentile(sorted, 0.50), percentile(sorted, 0.95),
                percentile(sorted, 0.99), percentile(sorted, 0.999), sorted.back());
}

std::string jsonString(const char* input) {
    std::string output;
    if (!input) return output;
    for (const unsigned char ch : std::string(input)) {
        switch (ch) {
        case '"': output += "\\\""; break;
        case '\\': output += "\\\\"; break;
        case '\b': output += "\\b"; break;
        case '\f': output += "\\f"; break;
        case '\n': output += "\\n"; break;
        case '\r': output += "\\r"; break;
        case '\t': output += "\\t"; break;
        default:
            if (ch < 0x20) output += '?';
            else output += static_cast<char>(ch);
        }
    }
    return output;
}

void writeSamples(std::ostream& out, const std::vector<double>& samples) {
    out << '[';
    for (std::size_t i = 0; i < samples.size(); ++i) {
        if (i != 0) out << ',';
        out << std::setprecision(10) << samples[i];
    }
    out << ']';
}

void writeStats(std::ostream& out, const std::vector<double>& samples) {
    const auto sorted = sortedCopy(samples);
    out << "{\"blocks\":" << sorted.size() << ",\"P50Us\":" << percentile(sorted, 0.50)
        << ",\"P95Us\":" << percentile(sorted, 0.95) << ",\"P99Us\":"
        << percentile(sorted, 0.99) << ",\"P999Us\":" << percentile(sorted, 0.999)
        << ",\"maxUs\":" << sorted.back() << '}';
}

bool writeJson(const char* path, const std::vector<double>& startup,
               const std::vector<double>& steady, const char* revision,
               const char* sourceHash, const char* buildFlags, const char* cpu,
               const char* os) {
    std::ofstream file;
    std::ostream* out = &std::cout;
    if (path && path[0] != '\0') {
        file.open(path, std::ios::out | std::ios::trunc);
        if (!file) return false;
        out = &file;
    }
    *out << "{\n  \"schemaVersion\":1,\n  \"benchmark\":\"native_shared_dsp_primitives_stack\",\n"
         << "  \"scope\":\"software-only; synchronous 64-frame primitive stack; not full graph, device callback, or XRUN test\",\n"
         << "  \"timingMethod\":\"one steady_clock interval per complete processBlock stack; timer overhead included\",\n"
         << "  \"sourceCommit\":\"" << jsonString(revision) << "\",\n"
         << "  \"sourceFingerprintSha256\":\"" << jsonString(sourceHash) << "\",\n"
         << "  \"compiler\":\"";
#if defined(_MSC_VER)
    *out << "MSVC " << _MSC_VER;
#elif defined(__clang__)
    *out << "Clang " << __clang_version__;
#elif defined(__GNUC__)
    *out << "GCC " << __VERSION__;
#else
    *out << "unknown";
#endif
    *out << "\",\n  \"compilerFlags\":\"" << jsonString(buildFlags) << "\",\n"
         << "  \"cpuModel\":\"" << jsonString(cpu) << "\",\n"
         << "  \"os\":\"" << jsonString(os) << "\",\n"
         << "  \"sampleRateHz\":" << kSampleRate << ",\n"
         << "  \"blockFrames\":" << kFrames << ",\n"
         << "  \"blockBudgetUs\":" << (1.0e6 * kFrames / kSampleRate) << ",\n"
         << "  \"startup\":{\"summary\":";
    writeStats(*out, startup);
    *out << ",\"samplesUs\":";
    writeSamples(*out, startup);
    *out << "},\n  \"steadyState\":{\"summary\":";
    writeStats(*out, steady);
    *out << ",\"samplesUs\":";
    writeSamples(*out, steady);
    *out << "}\n}\n";
    return static_cast<bool>(*out);
}

} // namespace

int main() {
    DspStack stack;
    if (!stack.prepare()) {
        std::fprintf(stderr, "DSP stack preparation failed\n");
        return 2;
    }

    std::printf("scope=software-only shared Gate1 primitive stack; not full graph, device callback, or XRUN test\n");
    std::printf("sample_rate_hz=%.0f block_frames=%u block_budget_us=%.3f measured_blocks=%u threads=%u\n",
                kSampleRate, kFrames, 1.0e6 * kFrames / kSampleRate, kMeasuredBlocks,
                std::thread::hardware_concurrency());
#if defined(_MSC_VER)
    std::printf("compiler=MSVC %d\n", _MSC_VER);
#elif defined(__clang__)
    std::printf("compiler=Clang %s\n", __clang_version__);
#elif defined(__GNUC__)
    std::printf("compiler=GCC %s\n", __VERSION__);
#else
    std::printf("compiler=unknown\n");
#endif
#if defined(_WIN32)
    std::puts("platform=Windows");
#elif defined(__APPLE__)
    std::puts("platform=Apple");
#elif defined(__linux__)
    std::puts("platform=Linux");
#else
    std::puts("platform=unknown");
#endif

    // The first window begins from newly prepared state and captures startup/cache effects.
    const auto startup = measure(stack, 1024);
    report("startup_first_1024", startup);
    for (std::uint32_t i = 0; i < 1024; ++i) stack.processBlock();
    const auto steady = measure(stack, kMeasuredBlocks);
    report("steady_state", steady);
    const char* outputPath = std::getenv("WEBRC_DSP_BENCH_JSON");
    if (!writeJson(outputPath, startup, steady,
                   std::getenv("WEBRC_DSP_SOURCE_REV"),
                   std::getenv("WEBRC_DSP_SOURCE_HASH"),
                   std::getenv("WEBRC_DSP_BUILD_FLAGS"),
                   std::getenv("WEBRC_DSP_CPU"),
                   std::getenv("WEBRC_DSP_OS"))) {
        std::fprintf(stderr, "failed writing machine-readable benchmark JSON\n");
        return 4;
    }
    if (outputPath && outputPath[0] != '\0') std::printf("json=%s\n", outputPath);
    std::printf("checksum=%.9g\n", gChecksum);
    return std::isfinite(gChecksum) ? 0 : 3;
}
