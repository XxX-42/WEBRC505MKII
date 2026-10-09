#pragma once

#include <cstdint>

namespace webrc::dsp {

// Typed MIDI data for musical processors. This is an in-process C++ contract;
// C ABI users should mirror the field widths in a versioned POD record rather
// than depend on compiler enum layout.
enum class FxMidiEventType : std::uint8_t {
    NoteOn,
    NoteOff,
    AllNotesOff,
};

struct FxMidiEvent {
    std::uint32_t frameOffset = 0U;
    FxMidiEventType type = FxMidiEventType::NoteOn;
    std::uint8_t channel = 0U;
    std::uint8_t note = 60U;
    std::uint8_t velocity = 100U;
};

// Optional process sidecar. VOCODER20 requires exactly two non-null carrier
// planes whose frame count equals the current audio block. Other processors
// reject a supplied carrier. MIDI records are a separate typed stream and are
// merged transactionally with the float parameter stream by the bridge.
struct FxProcessContext {
    const float* carrierLeft = nullptr;
    const float* carrierRight = nullptr;
    std::uint32_t carrierFrames = 0U;
    std::uint32_t carrierChannels = 0U;
    const FxMidiEvent* midiEvents = nullptr;
    std::uint32_t midiEventCount = 0U;
};

} // namespace webrc::dsp
