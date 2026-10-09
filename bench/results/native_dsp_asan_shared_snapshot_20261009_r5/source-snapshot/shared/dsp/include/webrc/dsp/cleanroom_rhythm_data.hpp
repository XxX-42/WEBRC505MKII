#pragma once

#include "webrc/dsp/rhythm.hpp"

namespace webrc::dsp {

[[nodiscard]] std::uint32_t cleanRoomRhythmPatternCount() noexcept;
[[nodiscard]] const RhythmPatternView* cleanRoomRhythmPattern(std::uint32_t index) noexcept;
[[nodiscard]] const char* cleanRoomRhythmPatternsSha256() noexcept;

} // namespace webrc::dsp
