#include "native_output_stage.hpp"

#include <array>
#include <chrono>
#include <cstdint>
#include <iostream>

using namespace webrc::native;

int main() {
    constexpr unsigned int sampleRate = 48000;
    constexpr unsigned int framesPerBlock = 64;
    constexpr std::uint64_t blocks = 20000;

    LooperCore looper(sampleRate, 1);
    NativeOutputStage outputStage;
    NativeRhythmEngine rhythm;
    if (!outputStage.prepare(sampleRate) || !rhythm.prepare(sampleRate)) {
        return 1;
    }
    outputStage.setHighPassEnabled(true, 0);
    NativeReverbConfig reverbConfig;
    reverbConfig.enabled = true;
    reverbConfig.wetMix = 0.35f;
    reverbConfig.rt60Seconds = 1.8f;
    if (!outputStage.setReverbConfig(reverbConfig, 0)) {
        return 1;
    }
    NativeFractionalDelayConfig delayConfig;
    delayConfig.enabled = true;
    delayConfig.delayMs = 150.5f;
    delayConfig.wetMix = 0.2f;
    delayConfig.feedback = 0.25f;
    NativeCompressorConfig compressorConfig;
    compressorConfig.enabled = true;
    compressorConfig.thresholdDb = -18.0f;
    compressorConfig.ratio = 4.0f;
    compressorConfig.attackMs = 10.0f;
    compressorConfig.releaseMs = 120.0f;
    NativeChorusConfig chorusConfig;
    chorusConfig.enabled = true;
    chorusConfig.rateHz = 0.8f;
    chorusConfig.depthMs = 10.0f;
    chorusConfig.feedback = 0.15f;
    chorusConfig.wetMix = 0.2f;
    if (!outputStage.setFractionalDelayConfig(delayConfig, 0) ||
        !outputStage.setCompressorConfig(compressorConfig, 0) ||
        !outputStage.setChorusConfig(chorusConfig, 0)) {
        return 1;
    }
    NativeRhythmConfig config;
    config.enabled = true;
    config.bpm = 127.0;
    config.kitIndex = 16;
    config.variation = NativeRhythmVariation::D;
    config.section = NativeRhythmSection::Fill;
    if (!rhythm.setConfig(config, 0)) {
        return 1;
    }

    std::array<float, framesPerBlock> input{};
    input.fill(0.8f);
    looper.applyCommand({CommandType::SetMonitoring, true});
    std::array<float, framesPerBlock * 2> output{};
    double sink = 0.0;
    const auto start = std::chrono::steady_clock::now();
    std::uint64_t startFrame = 0;
    for (std::uint64_t block = 0; block < blocks; ++block) {
        const auto stats = processNativeAudioBlock(
            looper,
            outputStage,
            input.data(),
            output.data(),
            framesPerBlock,
            1,
            2,
            &rhythm,
            startFrame
        );
        sink += stats.outputPeak;
        startFrame += framesPerBlock;
    }
    const auto elapsed = std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now() - start
    ).count();
    const double totalFrames = static_cast<double>(blocks * framesPerBlock);
    const double framesPerSecond = elapsed > 0
        ? totalFrames * 1'000'000.0 / static_cast<double>(elapsed)
        : 0.0;
    std::cout << "Native looper/rhythm/FDN16/delay/chorus/compressor chain: " << totalFrames << " frames in "
              << elapsed << " us (" << framesPerSecond << " frames/s), sink=" << sink << '\n';
    return 0;
}
