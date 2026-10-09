#include "webrc/dsp/reconstruction_fx_adapter.hpp"

#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <vector>

namespace {

bool gCountAllocations = false;
std::size_t gAllocations = 0U;

[[nodiscard]] bool require(bool condition, const char* message) {
    if (!condition) std::fprintf(stderr, "FAIL: %s\n", message);
    return condition;
}

webrc::dsp::ReconstructionFxConfiguration configurationFor(std::uint16_t ordinal,
                                                            std::array<float, 16U>& ir) {
    webrc::dsp::ReconstructionFxConfiguration config{};
    config.temporal.maximumDelaySeconds = 0.25f;
    config.temporal.granularCaptureSeconds = 0.25f;
    config.temporal.freezeWindowFrames = 256U;
    config.temporal.freezeHopFrames = 64U;
    config.randomSeed = 0x123456789abcdef0ULL;
    config.octave.windowFrames = 256U;
    config.octave.hopFrames = 64U;
    config.preamp.cabinetPartitionFrames = 16U;
    config.cabinetIr = {static_cast<std::uint32_t>(ir.size()), ir.data(), nullptr};
    if (ordinal == 24U) config.distortion.model = webrc::dsp::DistortionModel::AdaaCubic4x;
    return config;
}

std::array<webrc::dsp::ReconstructionFxEvent, 5U> eventsFor(std::uint16_t ordinal,
                                                            std::uint32_t& count) {
    using Control = webrc::dsp::ReconstructionFxControl;
    std::array<webrc::dsp::ReconstructionFxEvent, 5U> events{};
    events[0] = {0U, Control::Active, 1.0f};
    events[1] = {0U, Control::Mix, 1.0f};
    count = 2U;
    auto add = [&](Control control, float value) { events[count++] = {0U, control, value}; };
    switch (ordinal) {
    case 40U:
        add(Control::DelayMs, 50.0f);
        add(Control::Feedback, 0.4f);
        add(Control::Drive, 2.0f);
        break;
    case 41U:
        add(Control::GrainMs, 120.0f);
        add(Control::DensityHz, 30.0f);
        add(Control::PitchRatio, 1.25f);
        break;
    case 42U:
        add(Control::WarpAmount, 0.8f);
        add(Control::ReverbTimeSeconds, 2.5f);
        add(Control::DampingHz, 6000.0f);
        break;
    case 43U:
        add(Control::DelayMs, 30.0f);
        add(Control::TwistMacro, 0.7f);
        add(Control::Feedback, 0.4f);
        break;
    case 44U:
        add(Control::TempoBpm, 120.0f);
        add(Control::SubdivisionBeats, 0.25f);
        add(Control::Feedback, 0.5f);
        break;
    case 45U: add(Control::Freeze, 1.0f); break;
    case 23U:
        add(Control::Drive, 7.0f);
        add(Control::BassDb, 6.0f);
        add(Control::PresenceDb, 3.0f);
        break;
    case 24U:
        add(Control::Drive, 12.0f);
        add(Control::ToneHz, 6500.0f);
        add(Control::OutputDb, -3.0f);
        break;
    case 28U: add(Control::Semitones, -12.0f); break;
    default: break;
    }
    return events;
}

bool testOrdinal(std::uint16_t ordinal) {
    using namespace webrc::dsp;
    ProcessSpec spec{48000.0f, 64U, 2U};
    std::array<float, 16U> ir{};
    ir[0] = 0.8f;
    ir[5] = -0.12f;
    ir[11] = 0.06f;
    const auto config = configurationFor(ordinal, ir);
    const auto required = ReconstructionFxAdapter::requiredPrepareBytes(spec, ordinal, config);
    if (!require(required >= sizeof(ReconstructionFxAdapter), "supported adapter preflight")) return false;

    ReconstructionFxAdapter adapter{};
    if (!require(adapter.prepare(spec, ordinal, config), "adapter prepare")) return false;
    if (!require(adapter.prepared() && adapter.ordinal() == ordinal &&
                 adapter.preparedBytes() == required, "adapter prepared state/bytes")) return false;

    std::uint32_t eventCount = 0U;
    auto events = eventsFor(ordinal, eventCount);
    std::vector<StereoFrame> block(spec.maxBlockFrames);
    std::size_t processedSamples = 0U;
    for (std::uint32_t frame = 0U; frame < spec.maxBlockFrames; ++frame) {
        const double t = static_cast<double>(processedSamples + frame) / spec.sampleRate;
        block[frame] = {0.21f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 220.0 * t)),
                        -0.17f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 337.0 * t + 0.2))};
    }

    gAllocations = 0U;
    gCountAllocations = true;
    for (std::uint32_t call = 0U; call < 64U; ++call) {
        for (std::uint32_t frame = 0U; frame < spec.maxBlockFrames; ++frame) {
            const double t = static_cast<double>(call * spec.maxBlockFrames + frame) /
                             static_cast<double>(spec.sampleRate);
            block[frame] = {0.21f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 220.0 * t)),
                            -0.17f * static_cast<float>(std::sin(2.0 * 3.141592653589793 * 337.0 * t + 0.2))};
        }
        const auto* callEvents = call == 0U ? events.data() : nullptr;
        const auto callEventCount = call == 0U ? eventCount : 0U;
        if (!adapter.processBlock(static_cast<std::uint64_t>(call) * spec.maxBlockFrames,
                                  block.data(), spec.maxBlockFrames,
                                  callEvents, callEventCount)) {
            gCountAllocations = false;
            return require(false, "adapter 64-frame process");
        }
        for (const auto& sample : block) {
            if (!std::isfinite(sample.left) || !std::isfinite(sample.right)) {
                gCountAllocations = false;
                return require(false, "adapter finite output");
            }
        }
    }
    gCountAllocations = false;
    if (!require(gAllocations == 0U, "adapter callback performs no allocation")) return false;

    const auto latency = adapter.latency();
    if (!require(latency.fixedSamples >= 0 ||
                 latency.kind == ReconstructionFxLatencyKind::VariableDelay,
                 "latency model is explicit")) return false;
    return true;
}

bool testTransactionalRejection() {
    using namespace webrc::dsp;
    ProcessSpec spec{48000.0f, 64U, 2U};
    std::array<float, 16U> ir{};
    ir[0] = 1.0f;
    const auto config = configurationFor(24U, ir);
    ReconstructionFxAdapter adapter{};
    if (!adapter.prepare(spec, 24U, config)) return false;

    std::array<StereoFrame, 64U> actual{};
    std::array<StereoFrame, 64U> expected{};
    for (std::size_t i = 0U; i < actual.size(); ++i) {
        const float value = 0.3f * std::sin(static_cast<float>(i) * 0.173f);
        actual[i] = expected[i] = {value, -0.4f * value};
    }
    const std::array<ReconstructionFxEvent, 2U> invalid{{
        {0U, ReconstructionFxControl::Drive, 18.0f},
        {12U, ReconstructionFxControl::Semitones, 12.0f},
    }};
    if (!require(!adapter.processBlock(0U, actual.data(), 64U, invalid.data(),
                                       static_cast<std::uint32_t>(invalid.size())),
                 "unsupported later event is rejected")) return false;
    for (std::size_t i = 0U; i < actual.size(); ++i)
        if (!require(actual[i].left == expected[i].left && actual[i].right == expected[i].right,
                     "rejected events leave caller PCM untouched")) return false;

    const std::array<ReconstructionFxEvent, 2U> valid{{
        {0U, ReconstructionFxControl::Active, 1.0f},
        {0U, ReconstructionFxControl::Drive, 18.0f},
    }};
    ReconstructionFxAdapter untouchedControl{};
    if (!require(untouchedControl.prepare(spec, 24U, config), "control adapter prepare")) return false;
    if (!require(adapter.processBlock(0U, actual.data(), 64U, valid.data(),
                                      static_cast<std::uint32_t>(valid.size())) &&
                 untouchedControl.processBlock(0U, expected.data(), 64U, valid.data(),
                                      static_cast<std::uint32_t>(valid.size())),
                 "valid process at original frame after rejection")) return false;
    for (std::size_t i = 0U; i < actual.size(); ++i)
        if (!require(std::fabs(actual[i].left - expected[i].left) <= 1.0e-7f &&
                     std::fabs(actual[i].right - expected[i].right) <= 1.0e-7f,
                     "rejected batch leaves adapter state untouched")) return false;
    return true;
}

bool testSupportedMatrix() {
    using namespace webrc::dsp;
    constexpr std::array<std::uint16_t, 9U> ordinals{{23U,24U,28U,40U,41U,42U,43U,44U,45U}};
    for (const auto ordinal : ordinals) {
        if (!require(isReconstructionFxOrdinal(ordinal), "ordinal is in candidate adapter map")) return false;
        if (!require(reconstructionFxSupportsControl(ordinal, ReconstructionFxControl::Active) &&
                     reconstructionFxSupportsControl(ordinal, ReconstructionFxControl::Mix),
                     "common control map")) return false;
        if (!testOrdinal(ordinal)) return false;
    }
    if (!require(!isReconstructionFxOrdinal(22U) &&
                 ReconstructionFxAdapter::requiredPrepareBytes(
                     ProcessSpec{48000.0f,64U,2U}, 22U) == 0U,
                 "unimplemented ordinal remains unavailable")) return false;
    std::array<float, 16U> invalidIr{};
    ReconstructionFxConfiguration invalidPreamp{};
    invalidPreamp.cabinetIr = {static_cast<std::uint32_t>(invalidIr.size()),
                               invalidIr.data(), nullptr};
    if (!require(ReconstructionFxAdapter::requiredPrepareBytes(
                     ProcessSpec{48000.0f,64U,2U}, 23U, invalidPreamp) == 0U,
                 "PREAMP invalid cabinet IR is rejected by preflight")) return false;
    return testTransactionalRejection();
}

} // namespace

void* operator new(std::size_t size) {
    if (gCountAllocations) ++gAllocations;
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}

void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    if (!testSupportedMatrix()) return 1;
    std::puts("Reconstruction FX adapter tests passed.");
    return 0;
}
