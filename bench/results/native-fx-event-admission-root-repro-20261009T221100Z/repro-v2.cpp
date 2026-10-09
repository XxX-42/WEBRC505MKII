#include "native_fx_graph.hpp"
#include "webrc/dsp/fx_registry.hpp"

#include <array>
#include <iostream>
#include <memory>

// Diagnostic against explicitly captured libraries, not a whole-product pass.
int main() {
    using namespace webrc::native;
    using namespace webrc::dsp;
    auto graph = std::make_unique<NativeFxGraph>();
    const ProcessSpec spec{48000.0f, 64U, 2U};
    const NativeFxBusAddress input{NativeFxBusKind::Input, 0U};
    const std::array<NativeFxInitialParameter, 2U> initial{{
        {FxParameterId::Active, 1.0f}, {FxParameterId::Wet, 1.0f}}};
    if (graph->prepare(spec) != NativeFxGraphResult::Ok ||
        graph->configureSlot(input, 0U, 11U, 1.0f, 5.0f,
                             initial.data(), initial.size()) != NativeFxGraphResult::Ok ||
        graph->seal() != NativeFxGraphResult::Ok) return 2;
    auto processor = createFxProcessor(11U);
    if (!processor) return 3;
    const auto slotCapacity = processor->maximumParameterEventsPerBlock();
    NativeFxGraphExchange exchange;
    if (exchange.stage(graph) != NativeFxGraphResult::Ok) return 4;
    std::array<StereoFrame, 64U> pcm{};
    pcm.fill({0.2f, -0.1f});
    NativeFxGraphBlock block{};
    block.inputCapture = pcm.data();
    if (exchange.processBlock(block, 64U, 0U) != NativeFxGraphResult::Ok) return 5;
    std::array<NativeFxGraphEvent, 40U> events{};
    for (auto& event : events) {
        event.absoluteFrame = 64U;
        event.bus = input;
        event.slotIndex = 0U;
        event.kind = NativeFxGraphEventKind::ProcessorParameter;
        event.parameter = FxParameterId::Wet;
        event.value = 0.7f;
    }
    const auto first = exchange.postEvents(events.data(), events.size());
    const auto second = exchange.postEvents(events.data(), events.size());
    const auto before = pcm;
    NativeFxGraphStats stats{};
    const auto processed = exchange.processBlock(block, 64U, 64U, &stats);
    bool untouched = true;
    for (std::size_t index = 0U; index < pcm.size(); ++index)
        untouched = untouched && pcm[index].left == before[index].left &&
                    pcm[index].right == before[index].right;
    const bool reproduced = slotCapacity == 64U && first == NativeFxGraphResult::Ok &&
        second == NativeFxGraphResult::Ok && processed == NativeFxGraphResult::EventBatchRejected &&
        stats.rejectedEvents == 80U && untouched;
    std::cout << "{\"slotOrdinal\":11,\"slotCapacity\":" << slotCapacity
              << ",\"first40Accepted\":" << (first == NativeFxGraphResult::Ok ? "true" : "false")
              << ",\"second40Accepted\":" << (second == NativeFxGraphResult::Ok ? "true" : "false")
              << ",\"callbackEventBatchRejected\":"
              << (processed == NativeFxGraphResult::EventBatchRejected ? "true" : "false")
              << ",\"rejectedEvents\":" << stats.rejectedEvents
              << ",\"busPcmUntouched\":" << (untouched ? "true" : "false")
              << ",\"admissionGapReproduced\":" << (reproduced ? "true" : "false") << "}\n";
    return reproduced ? 0 : 1;
}
