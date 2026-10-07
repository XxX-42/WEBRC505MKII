#include "looper_core.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <iomanip>
#include <iostream>
#include <numeric>
#include <string>
#include <vector>

using webrc::native::Command;
using webrc::native::CommandType;
using webrc::native::LooperCore;

using Clock = std::chrono::steady_clock;

struct Distribution {
    double p50Us;
    double p95Us;
    double p99Us;
    double maxUs;
};

template <typename F>
Distribution measure(F&& fn, std::size_t count) {
    std::vector<double> values;
    values.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
        const auto start = Clock::now();
        fn();
        const auto end = Clock::now();
        values.push_back(std::chrono::duration<double, std::micro>(end - start).count());
    }
    std::sort(values.begin(), values.end());
    const auto percentile = [&values](double p) {
        return values[static_cast<std::size_t>(std::ceil(p * (values.size() - 1)))];
    };
    return {percentile(0.50), percentile(0.95), percentile(0.99), values.back()};
}

int firstNonZero(const std::vector<float>& stereo) {
    for (std::size_t frame = 0; frame < stereo.size() / 2; ++frame) {
        if (std::fabs(stereo[frame * 2]) > 1.0e-6f) {
            return static_cast<int>(frame);
        }
    }
    return -1;
}

void printTiming(const char* kind, const char* scenario, unsigned int rate, unsigned int frames,
                 std::size_t iterations, const Distribution& d) {
    const double budgetMs = static_cast<double>(frames) / rate * 1000.0;
    std::cout << kind << ',' << scenario << ',' << rate << ',' << frames << ','
              << std::fixed << std::setprecision(6) << budgetMs << ',' << iterations << ','
              << std::setprecision(3) << d.p50Us << ',' << d.p95Us << ',' << d.p99Us << ',' << d.maxUs << ",,,,," << "\n";
}

void printLag(const char* scenario, unsigned int rate, unsigned int frames, int pulseAt,
              int outputAt, double observed, double expected) {
    std::cout << "lag," << scenario << ',' << rate << ',' << frames << ','
              << std::fixed << std::setprecision(6)
              << static_cast<double>(frames) / rate * 1000.0 << ",1,,,,,"
              << pulseAt << ',' << outputAt << ',' << (outputAt - pulseAt) << ','
              << std::setprecision(6) << observed << ',' << expected << "\n";
}

void runLagChecks(unsigned int rate, unsigned int frames) {
    const int pulseAt = std::min<int>(7, static_cast<int>(frames) - 1);
    std::vector<float> pulse(frames, 0.0f), zeros(frames, 0.0f), output(frames * 2, 0.0f);
    pulse[pulseAt] = 0.25f;

    {
        LooperCore core(rate, 1);
        core.applyCommand({CommandType::SetMonitoring, true});
        core.process(pulse.data(), output.data(), frames, 1, 2);
        const int outAt = firstNonZero(output);
        printLag("monitor_thru", rate, frames, pulseAt, outAt,
                 outAt < 0 ? 0.0 : output[static_cast<std::size_t>(outAt) * 2], 0.25);
    }
    {
        LooperCore core(rate, 1);
        core.applyCommand({CommandType::SetMonitoring, true});
        core.applyCommand({CommandType::Record, false});
        std::fill(output.begin(), output.end(), 0.0f);
        core.process(pulse.data(), output.data(), frames, 1, 2);
        const int outAt = firstNonZero(output);
        printLag("record_monitor", rate, frames, pulseAt, outAt,
                 outAt < 0 ? 0.0 : output[static_cast<std::size_t>(outAt) * 2], 0.25);

        core.applyCommand({CommandType::StopRecordOrPlayback, false});
        core.applyCommand({CommandType::SetMonitoring, false});
        core.applyCommand({CommandType::Play, false});
        std::fill(output.begin(), output.end(), 0.0f);
        core.process(zeros.data(), output.data(), frames, 1, 2);
        const int playAt = firstNonZero(output);
        printLag("record_playback", rate, frames, pulseAt, playAt,
                 playAt < 0 ? 0.0 : output[static_cast<std::size_t>(playAt) * 2], 0.25);
    }
    {
        LooperCore core(rate, 1);
        std::vector<float> base(frames, 0.0f);
        base[pulseAt] = 0.25f;
        core.applyCommand({CommandType::Record, false});
        core.process(base.data(), output.data(), frames, 1, 2);
        core.applyCommand({CommandType::StopRecordOrPlayback, false});
        core.applyCommand({CommandType::Play, false});
        core.applyCommand({CommandType::ToggleOverdub, false});
        std::vector<float> dub(frames, 0.0f);
        dub[pulseAt] = 0.50f;
        std::fill(output.begin(), output.end(), 0.0f);
        core.process(dub.data(), output.data(), frames, 1, 2);
        const int outAt = firstNonZero(output);
        const double observed = outAt < 0 ? 0.0 : output[static_cast<std::size_t>(outAt) * 2];
        printLag("overdub_alignment", rate, frames, pulseAt, outAt, observed, 0.75);
    }
}

void setupLoop(LooperCore& core, unsigned int frames, const std::vector<float>& input,
               std::vector<float>& scratch) {
    core.applyCommand({CommandType::Record, false});
    core.process(input.data(), scratch.data(), frames, 1, 2);
    core.applyCommand({CommandType::StopRecordOrPlayback, false});
    core.applyCommand({CommandType::Play, false});
}

void runProcessBench(unsigned int rate, unsigned int frames) {
    constexpr std::size_t iterations = 5000;
    constexpr std::size_t warmup = 250;
    std::vector<float> input(frames, 0.125f);
    std::vector<float> output(frames * 2, 0.0f);

    {
        LooperCore core(rate, 90);
        core.applyCommand({CommandType::Clear, false});
        core.applyCommand({CommandType::SetMonitoring, true});
        for (std::size_t i = 0; i < warmup; ++i) core.process(input.data(), output.data(), frames, 1, 2);
        const auto d = measure([&] { core.process(input.data(), output.data(), frames, 1, 2); }, iterations);
        printTiming("core_process", "thru", rate, frames, iterations, d);
    }
    {
        LooperCore core(rate, 90);
        core.applyCommand({CommandType::Clear, false});
        core.applyCommand({CommandType::Record, false});
        for (std::size_t i = 0; i < warmup; ++i) core.process(input.data(), output.data(), frames, 1, 2);
        const auto d = measure([&] { core.process(input.data(), output.data(), frames, 1, 2); }, iterations);
        printTiming("core_process", "record", rate, frames, iterations, d);
    }
    {
        LooperCore core(rate, 90);
        core.applyCommand({CommandType::Clear, false});
        setupLoop(core, frames, input, output);
        for (std::size_t i = 0; i < warmup; ++i) core.process(input.data(), output.data(), frames, 1, 2);
        const auto d = measure([&] { core.process(input.data(), output.data(), frames, 1, 2); }, iterations);
        printTiming("core_process", "playback", rate, frames, iterations, d);
    }
    {
        LooperCore core(rate, 90);
        core.applyCommand({CommandType::Clear, false});
        setupLoop(core, frames, input, output);
        core.applyCommand({CommandType::ToggleOverdub, false});
        for (std::size_t i = 0; i < warmup; ++i) core.process(input.data(), output.data(), frames, 1, 2);
        const auto d = measure([&] { core.process(input.data(), output.data(), frames, 1, 2); }, iterations);
        printTiming("core_process", "overdub", rate, frames, iterations, d);
    }
}

void runCommandBench(unsigned int rate) {
    constexpr std::size_t seconds = 300;
    constexpr std::size_t iterations = 101;
    LooperCore core(rate, seconds);
    core.applyCommand({CommandType::Clear, false}); // fault-in pages outside timed calls
    core.applyCommand({CommandType::Record, false}); // warm path
    core.applyCommand({CommandType::Clear, false});
    std::vector<double> recordUs;
    std::vector<double> clearUs;
    recordUs.reserve(iterations);
    clearUs.reserve(iterations);
    for (std::size_t i = 0; i < iterations; ++i) {
        auto start = Clock::now();
        core.applyCommand({CommandType::Record, false});
        auto end = Clock::now();
        recordUs.push_back(std::chrono::duration<double, std::micro>(end - start).count());

        start = Clock::now();
        core.applyCommand({CommandType::Clear, false});
        end = Clock::now();
        clearUs.push_back(std::chrono::duration<double, std::micro>(end - start).count());
    }
    auto distribution = [](std::vector<double>& values) {
        std::sort(values.begin(), values.end());
        const auto percentile = [&values](double p) {
            return values[static_cast<std::size_t>(std::ceil(p * (values.size() - 1)))];
        };
        return Distribution{percentile(0.50), percentile(0.95), percentile(0.99), values.back()};
    };
    printTiming("command_apply", "record_start_300s", rate, 128, iterations, distribution(recordUs));
    printTiming("command_apply", "clear_300s", rate, 128, iterations, distribution(clearUs));
}

int main() {
    std::cout << "kind,scenario,sample_rate,block_frames,block_budget_ms,samples,p50_us,p95_us,p99_us,max_us,input_pulse_frame,output_pulse_frame,sample_lag,observed_sample,expected_sample\n";
    for (const auto rate : {44100u, 48000u, 96000u}) {
        runCommandBench(rate);
        for (const auto frames : {64u, 128u, 256u, 512u}) {
            runLagChecks(rate, frames);
            runProcessBench(rate, frames);
        }
    }
}
