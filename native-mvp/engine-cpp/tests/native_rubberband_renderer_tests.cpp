#include "native_rubberband_renderer.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <cstddef>
#include <iostream>
#include <limits>
#include <vector>

namespace {

constexpr std::uint32_t kSampleRate = 48000;
constexpr std::size_t kInputFrames = kSampleRate;
constexpr double kPi = 3.14159265358979323846;

std::vector<float> makeStereoTones() {
  std::vector<float> input(kInputFrames * 2);
  for (std::size_t frame = 0; frame < kInputFrames; ++frame) {
    const double seconds = static_cast<double>(frame) / kSampleRate;
    input[frame * 2] = static_cast<float>(0.55 * std::sin(2.0 * kPi * 440.0 * seconds));
    input[frame * 2 + 1] =
        static_cast<float>(0.45 * std::sin(2.0 * kPi * 660.0 * seconds + 0.23));
  }
  return input;
}

double goertzelMagnitude(const std::vector<float>& interleaved,
                         std::size_t channels,
                         std::size_t channel,
                         std::size_t startFrame,
                         std::size_t frames,
                         double frequency) {
  const double omega = 2.0 * kPi * frequency / kSampleRate;
  const double coefficient = 2.0 * std::cos(omega);
  double previous = 0.0;
  double previous2 = 0.0;
  for (std::size_t i = 0; i < frames; ++i) {
    const double hann =
        0.5 - 0.5 * std::cos(2.0 * kPi * static_cast<double>(i) /
                             static_cast<double>(frames - 1));
    const double sample =
        interleaved[(startFrame + i) * channels + channel] * hann;
    const double current = sample + coefficient * previous - previous2;
    previous2 = previous;
    previous = current;
  }
  return std::sqrt(std::max(0.0, previous * previous + previous2 * previous2 -
                                     coefficient * previous * previous2));
}

double peakNear(const std::vector<float>& interleaved,
                std::size_t channel,
                std::size_t startFrame,
                std::size_t frames,
                double expectedFrequency) {
  double peakMagnitude = 0.0;
  double peakFrequency = 0.0;
  for (int step = -40; step <= 40; ++step) {
    const double frequency = expectedFrequency + static_cast<double>(step) * 0.25;
    const double magnitude =
        goertzelMagnitude(interleaved, 2, channel, startFrame, frames, frequency);
    if (magnitude > peakMagnitude) {
      peakMagnitude = magnitude;
      peakFrequency = frequency;
    }
  }
  if (std::abs(peakFrequency - expectedFrequency) > expectedFrequency * 0.01) {
    std::cerr << "Expected peak near " << expectedFrequency << " Hz, found "
              << peakFrequency << " Hz\n";
  }
  assert(std::abs(peakFrequency - expectedFrequency) <= expectedFrequency * 0.01);
  return peakMagnitude;
}

void testEngine(native_mvp::RubberBandEngine engine, int expectedVersion) {
  const auto input = makeStereoTones();
  const auto rendered = native_mvp::NativeRubberBandRenderer::render(
      input, kInputFrames, 2, kSampleRate, 12.0, 1.25, engine, 777);
  if (!rendered) {
    std::cerr << "Rubber Band render failed: " << rendered.message << '\n';
  }
  assert(rendered);
  assert(rendered.engineVersion == expectedVersion);
  assert(rendered.channels == 2);
  assert(rendered.sampleRate == kSampleRate);
  assert(rendered.frames == 60000);
  assert(rendered.interleaved.size() == rendered.frames * 2);

  constexpr std::size_t analysisFrames = 16384;
  const std::size_t analysisStart = (rendered.frames - analysisFrames) / 2;
  const double leftTarget = peakNear(rendered.interleaved, 0, analysisStart,
                                     analysisFrames, 880.0);
  const double rightTarget = peakNear(rendered.interleaved, 1, analysisStart,
                                      analysisFrames, 1320.0);
  const double leftOriginal = goertzelMagnitude(rendered.interleaved, 2, 0,
                                                analysisStart, analysisFrames,
                                                440.0);
  const double rightOriginal = goertzelMagnitude(rendered.interleaved, 2, 1,
                                                 analysisStart, analysisFrames,
                                                 660.0);
  assert(leftTarget > 50.0);
  assert(rightTarget > 50.0);
  assert(leftTarget > leftOriginal * 3.0);
  assert(rightTarget > rightOriginal * 3.0);
}

void testInvalidInput() {
  std::vector<float> bad = {0.0f, std::numeric_limits<float>::quiet_NaN()};
  const auto result = native_mvp::NativeRubberBandRenderer::render(
      bad, 1, 2, kSampleRate, 0.0, 1.0,
      native_mvp::RubberBandEngine::R2Faster);
  assert(!result);
  assert(result.error == native_mvp::RubberBandRenderError::NonFiniteInput);
  assert(result.interleaved.empty());
}

}  // namespace

int main() {
  testInvalidInput();
  testEngine(native_mvp::RubberBandEngine::R2Faster, 2);
  testEngine(native_mvp::RubberBandEngine::R3Finer, 3);
  std::cout << "native_rubberband_renderer_tests passed\n";
  return 0;
}
