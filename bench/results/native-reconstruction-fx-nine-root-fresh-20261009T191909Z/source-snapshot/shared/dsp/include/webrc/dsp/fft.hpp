#pragma once

#include <complex>
#include <cstddef>
#include <cstdint>

namespace webrc::dsp::fft {

enum class Direction : std::uint8_t {
    Forward,
    Inverse,
};

[[nodiscard]] bool isPowerOfTwo(std::size_t value) noexcept;

// In-place radix-2 complex FFT. Inverse transforms include 1/N normalization.
// The caller owns scratch/storage; this function does not allocate.
[[nodiscard]] bool transform(std::complex<float>* values, std::size_t count,
                             Direction direction) noexcept;

} // namespace webrc::dsp::fft
