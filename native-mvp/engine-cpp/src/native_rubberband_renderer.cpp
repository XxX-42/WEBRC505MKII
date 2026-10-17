#include "native_rubberband_renderer.hpp"

#include <rubberband/RubberBandStretcher.h>

#include <algorithm>
#include <cmath>
#include <exception>
#include <limits>
#include <utility>

namespace native_mvp {
namespace {

constexpr std::size_t kDefaultChunkFrames = 4096;
constexpr std::size_t kMaximumChunkFrames = 65536;

RubberBandRenderResult failure(RubberBandRenderError error,
                               const std::string& message,
                               std::size_t channels,
                               std::uint32_t sampleRate,
                               int engineVersion = 0) {
  RubberBandRenderResult result;
  result.error = error;
  result.message = message;
  result.channels = channels;
  result.sampleRate = sampleRate;
  result.engineVersion = engineVersion;
  return result;
}

}  // namespace

RubberBandRenderResult NativeRubberBandRenderer::render(
    const std::vector<float>& interleavedInput,
    std::size_t inputFrames,
    std::size_t channels,
    std::uint32_t sampleRate,
    double semitones,
    double durationRatio,
    RubberBandEngine engine,
    std::size_t inputChunkFrames) {
  if (inputFrames == 0 || channels == 0 || sampleRate < 8000 ||
      sampleRate > 192000 || !std::isfinite(semitones) ||
      !std::isfinite(durationRatio) || durationRatio <= 0.0) {
    return failure(RubberBandRenderError::InvalidArgument,
                   "Frames, channels, sample rate, pitch, and duration ratio "
                   "must be valid (sample rate 8000-192000 Hz)",
                   channels, sampleRate);
  }
  if (inputFrames > std::numeric_limits<std::size_t>::max() / channels ||
      interleavedInput.size() != inputFrames * channels) {
    return failure(RubberBandRenderError::InvalidArgument,
                   "Interleaved input size must equal frames times channels",
                   channels, sampleRate);
  }
  for (float sample : interleavedInput) {
    if (!std::isfinite(sample)) {
      return failure(RubberBandRenderError::NonFiniteInput,
                     "Input contains a non-finite sample", channels,
                     sampleRate);
    }
  }

  int engineOption = 0;
  int expectedEngineVersion = 0;
  switch (engine) {
    case RubberBandEngine::R2Faster:
      engineOption = RubberBand::RubberBandStretcher::OptionEngineFaster;
      expectedEngineVersion = 2;
      break;
    case RubberBandEngine::R3Finer:
      engineOption = RubberBand::RubberBandStretcher::OptionEngineFiner;
      expectedEngineVersion = 3;
      break;
    default:
      return failure(RubberBandRenderError::InvalidArgument,
                     "Unsupported Rubber Band engine selection", channels,
                     sampleRate);
  }

  const double pitchScale = std::exp2(semitones / 12.0);
  const long double expectedFrames =
      static_cast<long double>(inputFrames) * durationRatio;
  if (!std::isfinite(pitchScale) || pitchScale <= 0.0 ||
      expectedFrames > static_cast<long double>(
                           std::numeric_limits<std::size_t>::max() / channels)) {
    return failure(RubberBandRenderError::InvalidArgument,
                   "Pitch or output duration is outside the representable range",
                   channels, sampleRate);
  }

  std::size_t chunkFrames = inputChunkFrames == 0 ? kDefaultChunkFrames
                                                  : inputChunkFrames;
  chunkFrames = std::min(chunkFrames, kMaximumChunkFrames);

  RubberBandRenderResult result;
  result.channels = channels;
  result.sampleRate = sampleRate;

  try {
    const int options =
        RubberBand::RubberBandStretcher::OptionProcessOffline | engineOption |
        RubberBand::RubberBandStretcher::OptionThreadingNever;
    RubberBand::RubberBandStretcher stretcher(
        sampleRate, channels, options, durationRatio, pitchScale);

    // The v3+ API's run-time engine query also makes an older/incompatible
    // library impossible to mistake for the requested R3 engine. A binary
    // linked against the v3+ API will fail to link if this symbol is absent.
    const int actualEngine = stretcher.getEngineVersion();
    result.engineVersion = actualEngine;
    if (actualEngine != expectedEngineVersion) {
      return failure(RubberBandRenderError::EngineMismatch,
                     "Rubber Band reported engine R" +
                         std::to_string(actualEngine) +
                         " but the requested engine was R" +
                         std::to_string(expectedEngineVersion),
                     channels, sampleRate, actualEngine);
    }

    const std::size_t processLimit = stretcher.getProcessSizeLimit();
    if (processLimit == 0) {
      return failure(RubberBandRenderError::LibraryUnavailable,
                     "Rubber Band reported a zero process-size limit",
                     channels, sampleRate, actualEngine);
    }
    chunkFrames = std::min(chunkFrames, processLimit);
    stretcher.setExpectedInputDuration(inputFrames);
    stretcher.setMaxProcessSize(chunkFrames);

    std::vector<std::vector<float>> inputPlanes(
        channels, std::vector<float>(chunkFrames));
    std::vector<std::vector<float>> outputPlanes(
        channels, std::vector<float>(chunkFrames));
    std::vector<const float*> inputPointers(channels);
    std::vector<float*> outputPointers(channels);
    for (std::size_t channel = 0; channel < channels; ++channel) {
      inputPointers[channel] = inputPlanes[channel].data();
      outputPointers[channel] = outputPlanes[channel].data();
    }

    auto deinterleave = [&](std::size_t offset, std::size_t frameCount) {
      for (std::size_t frame = 0; frame < frameCount; ++frame) {
        const std::size_t sourceIndex = (offset + frame) * channels;
        for (std::size_t channel = 0; channel < channels; ++channel) {
          inputPlanes[channel][frame] =
              interleavedInput[sourceIndex + channel];
        }
      }
    };

    // Pass one: the complete audio is studied before any process() call.
    for (std::size_t offset = 0; offset < inputFrames;) {
      const std::size_t count = std::min(chunkFrames, inputFrames - offset);
      deinterleave(offset, count);
      stretcher.study(inputPointers.data(), count, offset + count == inputFrames);
      offset += count;
    }

    const long double reserveFrames = std::ceil(expectedFrames) + chunkFrames;
    if (reserveFrames <= static_cast<long double>(
                             std::numeric_limits<std::size_t>::max() / channels)) {
      result.interleaved.reserve(
          static_cast<std::size_t>(reserveFrames) * channels);
    }

    auto drainOutput = [&](bool finalInput) -> bool {
      for (;;) {
        const int available = stretcher.available();
        if (available == -1) {
          if (!finalInput) {
            result.error = RubberBandRenderError::ProcessingFailed;
            result.message =
                "Rubber Band reported completion before final input was sent";
            return false;
          }
          return true;
        }
        if (available < -1) {
          result.error = RubberBandRenderError::ProcessingFailed;
          result.message = "Rubber Band returned an invalid availability state";
          return false;
        }
        if (available == 0) {
          if (finalInput) {
            result.error = RubberBandRenderError::ProcessingFailed;
            result.message =
                "Rubber Band stopped producing output before final completion";
            return false;
          }
          return true;
        }

        const std::size_t request = std::min(
            static_cast<std::size_t>(available), chunkFrames);
        const std::size_t retrieved =
            stretcher.retrieve(outputPointers.data(), request);
        if (retrieved == 0 || retrieved > request) {
          result.error = RubberBandRenderError::ProcessingFailed;
          result.message = "Rubber Band failed to retrieve available output";
          return false;
        }
        if (retrieved > result.interleaved.max_size() / channels -
                            result.frames) {
          result.error = RubberBandRenderError::ProcessingFailed;
          result.message = "Rubber Band output exceeds addressable buffer size";
          return false;
        }
        for (std::size_t frame = 0; frame < retrieved; ++frame) {
          for (std::size_t channel = 0; channel < channels; ++channel) {
            const float sample = outputPlanes[channel][frame];
            if (!std::isfinite(sample)) {
              result.error = RubberBandRenderError::NonFiniteOutput;
              result.message = "Rubber Band produced a non-finite sample";
              return false;
            }
            result.interleaved.push_back(sample);
          }
        }
        result.frames += retrieved;
      }
    };

    // Pass two: feed bounded chunks and drain every available output frame.
    for (std::size_t offset = 0; offset < inputFrames;) {
      const std::size_t count = std::min(chunkFrames, inputFrames - offset);
      deinterleave(offset, count);
      const bool isFinal = offset + count == inputFrames;
      stretcher.process(inputPointers.data(), count, isFinal);
      if (!drainOutput(isFinal)) {
        result.interleaved.clear();
        result.frames = 0;
        return result;
      }
      offset += count;
    }

    if (result.frames == 0) {
      result.interleaved.clear();
      return failure(RubberBandRenderError::ZeroOutput,
                     "Rubber Band completed without producing audio frames",
                     channels, sampleRate, actualEngine);
    }
    if (result.interleaved.size() != result.frames * channels) {
      return failure(RubberBandRenderError::ProcessingFailed,
                     "Rubber Band output channel/frame count is inconsistent",
                     channels, sampleRate, actualEngine);
    }
    if (std::abs(static_cast<long double>(result.frames) - expectedFrames) >
        1.0L) {
      return failure(RubberBandRenderError::ProcessingFailed,
                     "Rubber Band output duration does not match the requested "
                     "time ratio",
                     channels, sampleRate, actualEngine);
    }
    return result;
  } catch (const std::exception& exception) {
    const std::string reason = exception.what();
    const bool stillInitializing = result.engineVersion == 0;
    return failure(stillInitializing ? RubberBandRenderError::LibraryUnavailable
                                     : RubberBandRenderError::ProcessingFailed,
                   std::string("Rubber Band ") +
                       (stillInitializing ? "initialization failed: "
                                          : "offline render failed: ") +
                       reason,
                   channels, sampleRate, result.engineVersion);
  } catch (...) {
    const bool stillInitializing = result.engineVersion == 0;
    return failure(stillInitializing ? RubberBandRenderError::LibraryUnavailable
                                     : RubberBandRenderError::ProcessingFailed,
                   stillInitializing
                       ? "Rubber Band initialization failed with an unknown error"
                       : "Rubber Band offline render failed with an unknown error",
                   channels, sampleRate, result.engineVersion);
  }
}

}  // namespace native_mvp
