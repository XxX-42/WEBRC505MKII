#pragma once

#include <cstddef>

namespace webrc::native::test_alloc {

[[nodiscard]] std::size_t count() noexcept;
void beginTracking() noexcept;
void endTracking() noexcept;

} // namespace webrc::native::test_alloc
