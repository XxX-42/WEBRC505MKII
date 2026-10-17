#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace native_mvp {

// Rubber Band's documented offline engines. Keep the choice explicit rather
// than relying on its default (R2) so callers can persist/report the quality
// mode that they requested.
enum class RubberBandEngine {
  R2Faster,
  R3Finer,
};

enum class RubberBandRenderError {
  None,
  InvalidArgument,
  NonFiniteInput,
  LibraryUnavailable,
  EngineMismatch,
  ProcessingFailed,
  NonFiniteOutput,
  ZeroOutput,
};

struct RubberBandRenderResult {
  RubberBandRenderError error = RubberBandRenderError::None;
  std::string message;
  std::vector<float> interleaved;
  std::size_t frames = 0;
  std::size_t channels = 0;
  std::uint32_t sampleRate = 0;
  int engineVersion = 0;

  explicit operator bool() const noexcept {
    return error == RubberBandRenderError::None;
  }
};

// Whole-buffer offline pitch/time rendering. Input and output are interleaved
// floats; `durationRatio` is output duration / input duration. Rubber Band's
// Offline mode necessarily reads all input once for study(), then again for
// process(), so this class is deliberately not suitable for audio callbacks.
class NativeRubberBandRenderer final {
 public:
  // `inputChunkFrames` bounds the frame count supplied to each process() call.
  // Zero selects 4096. Values above 65536 are capped to keep temporary planar
  // buffers bounded. Study chunks are bounded by the same value.
  static RubberBandRenderResult render(
      const std::vector<float>& interleavedInput,
      std::size_t inputFrames,
      std::size_t channels,
      std::uint32_t sampleRate,
      double semitones,
      double durationRatio,
      RubberBandEngine engine,
      std::size_t inputChunkFrames = 4096);
};

}  // namespace native_mvp
