#include "webrc/dsp/fft.hpp"

#include <cmath>
#include <limits>

namespace webrc::dsp::fft {

namespace {

float finiteOrZero(float value) noexcept {
    return std::isfinite(value) && std::abs(value) >= 1.0e-30f ? value : 0.0f;
}

} // namespace

bool isPowerOfTwo(std::size_t value) noexcept {
    return value != 0 && (value & (value - 1)) == 0;
}

bool transform(std::complex<float>* values, std::size_t count,
               Direction direction) noexcept {
    if (values == nullptr || !isPowerOfTwo(count) ||
        (direction != Direction::Forward && direction != Direction::Inverse)) {
        return false;
    }
    if (count == 1) {
        values[0] = {finiteOrZero(values[0].real()), finiteOrZero(values[0].imag())};
        return true;
    }

    for (std::size_t i = 0, j = 0; i < count; ++i) {
        if (i < j) {
            const auto temporary = values[i];
            values[i] = values[j];
            values[j] = temporary;
        }
        std::size_t bit = count >> 1;
        while (bit != 0 && (j & bit) != 0) {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        values[i] = {finiteOrZero(values[i].real()), finiteOrZero(values[i].imag())};
    }

    constexpr double kPi = 3.141592653589793238462643383279502884;
    const double sign = direction == Direction::Forward ? -1.0 : 1.0;
    for (std::size_t span = 2; span <= count; span <<= 1) {
        const std::size_t half = span >> 1;
        const double angleStep = sign * 2.0 * kPi / static_cast<double>(span);
        const std::complex<double> step(std::cos(angleStep), std::sin(angleStep));
        for (std::size_t base = 0; base < count; base += span) {
            std::complex<double> twiddle(1.0, 0.0);
            for (std::size_t offset = 0; offset < half; ++offset) {
                const auto even = std::complex<double>(values[base + offset].real(),
                                                       values[base + offset].imag());
                const auto oddInput = values[base + offset + half];
                const auto odd = std::complex<double>(oddInput.real(), oddInput.imag()) * twiddle;
                const auto low = even + odd;
                const auto high = even - odd;
                values[base + offset] = {static_cast<float>(low.real()),
                                         static_cast<float>(low.imag())};
                values[base + offset + half] = {static_cast<float>(high.real()),
                                                static_cast<float>(high.imag())};
                twiddle *= step;
            }
        }
        if (span == count) {
            break; // Avoid size_t overflow when count is the highest representable power of two.
        }
    }

    if (direction == Direction::Inverse) {
        const float scale = 1.0f / static_cast<float>(count);
        for (std::size_t i = 0; i < count; ++i) {
            values[i] *= scale;
        }
    }
    for (std::size_t i = 0; i < count; ++i) {
        values[i] = {finiteOrZero(values[i].real()), finiteOrZero(values[i].imag())};
    }
    return true;
}

} // namespace webrc::dsp::fft
