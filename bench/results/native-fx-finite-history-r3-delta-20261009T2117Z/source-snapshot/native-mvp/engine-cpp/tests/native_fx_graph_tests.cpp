#include "native_fx_graph.hpp"
#include "multitrack_looper_core.hpp"
#include "native_track_host.hpp"
#include "webrc/dsp/modulated_delay_fx.hpp"
#include "webrc/dsp/fx_registry.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <new>
#include <utility>

namespace {
std::atomic<bool> countHeapOperations{false};
std::atomic<std::uint32_t> heapAllocations{0U};
std::atomic<std::uint32_t> heapFrees{0U};
}

void* operator new(std::size_t size) {
    if (countHeapOperations.load(std::memory_order_relaxed))
        heapAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countHeapOperations.load(std::memory_order_relaxed))
        heapAllocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* memory = std::malloc(size)) return memory;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept {
    if (countHeapOperations.load(std::memory_order_relaxed))
        heapFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}
void operator delete[](void* memory) noexcept {
    if (countHeapOperations.load(std::memory_order_relaxed))
        heapFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}
void operator delete(void* memory, std::size_t) noexcept {
    if (countHeapOperations.load(std::memory_order_relaxed))
        heapFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}
void operator delete[](void* memory, std::size_t) noexcept {
    if (countHeapOperations.load(std::memory_order_relaxed))
        heapFrees.fetch_add(1U, std::memory_order_relaxed);
    std::free(memory);
}

namespace {
using namespace webrc::dsp;
using namespace webrc::native;

bool require(bool condition, const char* message) {
    if (!condition) std::cerr << "FAIL: " << message << '\n';
    return condition;
}

bool prepareEmptyGraph(std::unique_ptr<NativeFxGraph>& graph,
                       const ProcessSpec& spec = {}) {
    graph = std::make_unique<NativeFxGraph>();
    return require(graph->prepare(spec) == NativeFxGraphResult::Ok,
                   "prepare a stereo graph off the audio callback");
}

bool configurePan(NativeFxGraph& graph, NativeFxBusAddress bus, float pan) {
    const std::array<NativeFxInitialParameter, 2U> initial{{
        {FxParameterId::Active, 1.0f},
        {FxParameterId::Pan, pan},
    }};
    return graph.configureSlot(bus, 0U, 30U, 1.0f, 5.0f,
                               initial.data(), static_cast<std::uint32_t>(initial.size())) ==
           NativeFxGraphResult::Ok;
}

void fill(std::array<StereoFrame, kNativeFxGraphMaximumFrames>& frames,
          float left, float right) {
    for (auto& frame : frames) frame = {left, right};
}

bool testUnsupportedAndBusEligibilityFailClosed() {
    NativeFxGraph graph;
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    if (!require(graph.prepare(spec) == NativeFxGraphResult::Ok,
                 "prepare a two-channel graph")) return false;
    if (!require(graph.configureSlot({NativeFxBusKind::Input, 0U}, 0U, 50U) ==
                     NativeFxGraphResult::InvalidRoute,
                 "reject track-only Beat Scatter from the input capture bus")) return false;
    if (!require(graph.configureSlot({NativeFxBusKind::Track, 0U}, 0U, 6U) ==
                     NativeFxGraphResult::UnsupportedOrdinal,
                 "reject metadata-only Synth instead of substituting another DSP")) return false;
    if (!require(graph.configureSlot({NativeFxBusKind::Track, 0U}, 4U, 30U) ==
                     NativeFxGraphResult::InvalidSlot,
                 "reject a slot index outside the fixed four-slot chain")) return false;

    NativeFxGraph tooSmall;
    if (!require(tooSmall.prepare(spec, sizeof(NativeFxGraph)) == NativeFxGraphResult::Ok,
                 "accept a budget that covers graph-owned fixed storage")) return false;
    if (!require(tooSmall.configureSlot({NativeFxBusKind::Input, 0U}, 0U, 1U) ==
                     NativeFxGraphResult::MemoryBudgetExceeded,
                 "preflight processor plus prepared-state replacement peak against memory budget")) return false;
    return require(graph.seal() == NativeFxGraphResult::Ok,
                   "seal a valid graph after rejected off-thread candidates");
}

bool testPreampSelectorsAreAppliedBeforeCandidatePrepare() {
    using namespace webrc::dsp;
    NativeFxGraph graph;
    const ProcessSpec spec{48000.0f, 64U, 2U};
    const std::array<NativeFxInitialParameter,6U> initial{{
        {FxParameterId::AmpModel,8.0f},
        {FxParameterId::SpeakerModel,8.0f},
        {FxParameterId::MicModel,3.0f},
        {FxParameterId::MicDistance,1.0f},
        {FxParameterId::MicPositionCm,5.0f},
        {FxParameterId::Active,1.0f},
    }};
    if (!require(graph.prepare(spec) == NativeFxGraphResult::Ok &&
                 graph.configureSlot({NativeFxBusKind::Input,0U},0U,23U,1.0f,5.0f,
                                     initial.data(),static_cast<std::uint32_t>(initial.size())) ==
                     NativeFxGraphResult::Ok && graph.seal() == NativeFxGraphResult::Ok,
                 "stage PREAMP selectors on a fresh inactive graph candidate before model prepare"))
        return false;

    std::array<StereoFrame,64U> input{};
    std::array<std::array<StereoFrame,64U>,5U> tracks{};
    std::array<StereoFrame,64U> send{};
    std::array<StereoFrame,64U> master{};
    NativeFxGraphBlock block{};
    block.inputCapture = input.data();
    for (std::size_t index=0U;index<tracks.size();++index) block.trackPlayback[index]=tracks[index].data();
    block.sendReturn=send.data();
    block.masterMix=master.data();
    std::uint64_t absoluteFrame=0U;
    bool finiteOutput=true;
    for (std::uint32_t callback=0U;callback<8U;++callback) {
        for (std::uint32_t frame=0U;frame<64U;++frame) {
            const float tone=0.2f*std::sin(2.0f*3.14159265358979323846f*997.0f*
                static_cast<float>(absoluteFrame)/spec.sampleRate);
            input[frame]={tone,-0.37f*tone};
            ++absoluteFrame;
        }
        if (!require(graph.processBlock(block,64U)==NativeFxGraphResult::Ok,
                     "process selected PREAMP model on the input-to-recording bus")) return false;
        for (const auto& sample:input)
            finiteOutput=finiteOutput&&std::isfinite(sample.left)&&std::isfinite(sample.right);
    }
    return require(finiteOutput,"selected PREAMP graph path returns finite stereo capture PCM");
}

bool testStartupWarmupQueriesAndPreampSampleRateBounds() {
    using namespace webrc::dsp;
    constexpr std::array<float, 4U> sampleRates{{24000.0f, 48000.0f,
                                                96000.0f, 192000.0f}};
    for (const float sampleRate : sampleRates) {
        const ProcessSpec spec{sampleRate, 64U, 2U};
        const auto upper = fxStartupWarmupUpperBoundSamples(23U, spec);
        const auto irFrames = static_cast<std::uint64_t>(std::ceil(
            static_cast<double>(sampleRate) * 0.019));
        const auto roundedDelay = [sampleRate](double milliseconds) {
            return static_cast<std::uint64_t>(std::floor(
                static_cast<double>(sampleRate) * milliseconds * 0.001 + 0.5));
        };
        const auto expected = static_cast<std::uint32_t>(86U + irFrames +
            roundedDelay(1.5) + roundedDelay(2.0));
        if (!require(upper.supported && upper.frames == expected,
                     "PREAMP preflight warmup bound scales its maximum IR and OffMic history"))
            return false;

        auto processor = createFxProcessor(23U);
        if (!require(processor != nullptr &&
                     processor->setParameter(FxParameterId::SpeakerModel, 8.0f) &&
                     processor->setParameter(FxParameterId::MicDistance, 0.0f) &&
                     processor->prepare(spec) &&
                     processor->startupWarmupFrames() == expected,
                     "prepared PREAMP reports selected startup history separately from fixed latency"))
            return false;
        if (!require(processor->fixedLatencySamples() == 86,
                     "PREAMP fixed mixed-path anchor remains separate from its startup bound"))
            return false;

        NativeFxGraph graph;
        const std::array<NativeFxInitialParameter, 2U> selectors{{
            {FxParameterId::SpeakerModel, 8.0f},
            {FxParameterId::MicDistance, 0.0f},
        }};
        if (!require(graph.prepare(spec) == NativeFxGraphResult::Ok &&
                     graph.configureSlot({NativeFxBusKind::Input, 0U}, 0U, 23U,
                         1.0f, 5.0f, selectors.data(),
                         static_cast<std::uint32_t>(selectors.size())) == NativeFxGraphResult::Ok &&
                     graph.transitionWarmupFrames() == expected &&
                     graph.configureSlot({NativeFxBusKind::Input, 0U}, 1U, 23U,
                         1.0f, 5.0f, selectors.data(),
                         static_cast<std::uint32_t>(selectors.size())) == NativeFxGraphResult::Ok &&
                     graph.transitionWarmupFrames() == 2U * expected,
                     "PREAMP startup windows sum across serial slots at every supported rate"))
            return false;
    }

    const ProcessSpec ordinarySpec{48000.0f, 64U, 2U};
    const auto ordinary = fxStartupWarmupUpperBoundSamples(1U, ordinarySpec);
    auto ordinaryProcessor = createFxProcessor(1U);
    return require(ordinary.supported && ordinary.frames == 0U && ordinaryProcessor &&
                   ordinaryProcessor->prepare(ordinarySpec) &&
                   ordinaryProcessor->startupWarmupFrames() == 0U,
                   "zero startup wait is explicit for a prepared filter, not confused with unsupported");
}

bool testFiniteHistoryWarmupBoundsAndPreparedInstances() {
    using namespace webrc::dsp;
    const ProcessSpec spec{48000.0f, 64U, 2U};
    const auto reverseFrames = 2U * 12000U - 480U;
    const auto fdnFrames = 4800U + 2U;
    const std::array<std::pair<std::uint16_t, std::uint32_t>, 22U> expected{{
        {5U, 1440U + ModulatedDelayFx::kInterpolationTaps},
        {7U, 64U},
        {24U, 22U},
        // ceil(sampleRate * 35 ms) is deliberately conservative at decimal
        // float conversion boundaries, then add all Lanczos taps.
        {33U, 1681U + ModulatedDelayFx::kInterpolationTaps},
        {36U, 96000U + 4U},
        {37U, 96000U + ModulatedDelayFx::kInterpolationTaps},
        {38U, reverseFrames},
        {39U, 96000U + ModulatedDelayFx::kInterpolationTaps},
        {40U, 58176U},
        {41U, 96000U},
        {42U, 1024U + fdnFrames},
        {43U, 96000U},
        {44U, 96000U},
        {45U, 1024U},
        {46U, 5760U + ModulatedDelayFx::kInterpolationTaps},
        {47U, fdnFrames},
        {48U, fdnFrames},
        {49U, fdnFrames + reverseFrames},
        {50U, 192000U + spec.maxBlockFrames + 14U},
        {51U, 72000U + 2U},
        {52U, 288240U + 4U},
        {53U, 192000U + spec.maxBlockFrames + 12U},
    }};
    for (const auto& item : expected) {
        const auto upper = fxStartupWarmupUpperBoundSamples(item.first, spec);
        const auto alignment = fxAlignmentUpperBoundSamples(item.first, spec);
        if (!upper.supported || upper.frames != item.second)
            std::cerr << "warmup bound mismatch ordinal=" << item.first
                      << " supported=" << upper.supported << " actual=" << upper.frames
                      << " expected=" << item.second << '\n';
        const auto expectedAlignment = item.first == 23U ? 86U
            : item.first == 24U ? 22U
            : item.first == 28U ? 4096U
            : (item.first == 42U || item.first == 45U) ? 1024U
            : item.first == 53U ? 960U : 0U;
        if (!require(upper.supported && upper.frames == item.second,
                     "finite-history startup upper bound matches module's supported read window"))
            return false;
        if (!require(alignment.supported && alignment.frames == expectedAlignment,
                     "fixed dry-alignment storage is bounded separately from startup history"))
            return false;
        auto processor = createFxProcessor(item.first);
        if (!require(processor && processor->prepare(spec) &&
                     processor->startupWarmupFrames() == item.second &&
                     (processor->fixedLatencySamples() < 0 ||
                      processor->fixedLatencySamples() <= static_cast<std::int32_t>(alignment.frames)),
                     "prepared FX reports the same finite-history bound used for preflight"))
            return false;
    }

    for (const auto ordinal : {47U, 48U, 49U, 40U, 42U, 44U, 50U, 51U, 52U, 53U}) {
        const auto upper = fxStartupWarmupUpperBoundSamples(
            static_cast<std::uint16_t>(ordinal), spec);
        if (!require(upper.supported && upper.frames > 0U,
                     "history-backed delay/reverb/performance adapter never reports false zero"))
            return false;
    }
    const auto filter = fxStartupWarmupUpperBoundSamples(1U, spec);
    const auto reverb = fxStartupWarmupUpperBoundSamples(47U, spec);
    return require(filter.supported && filter.frames == 0U &&
                   reverb.supported && reverb.frames == fdnFrames,
                   "zero finite history for an IIR filter is distinct from FDN ring fill; reverb tail is not settled");
}

bool testEveryReadyProcessorHasPreparedAlignmentCoverageAtSupportedRates() {
    using namespace webrc::dsp;
    constexpr std::array<float, 4U> sampleRates{{24000.0f, 48000.0f, 96000.0f, 192000.0f}};
    std::uint32_t availableAtReferenceRate = 0U;
    for (const auto sampleRate : sampleRates) {
        const ProcessSpec spec{sampleRate, 64U, 2U};
        for (std::size_t index = 0U; index < fxCatalogSize(); ++index) {
            const auto& descriptor = fxCatalogData()[index];
            if (descriptor.readiness != FxReadiness::ProcessorAvailable) continue;
            if (sampleRate == 48000.0f) ++availableAtReferenceRate;

            const auto memory = fxMemoryRequirement(descriptor.ordinal, spec);
            const auto startup = fxStartupWarmupUpperBoundSamples(descriptor.ordinal, spec);
            const auto alignment = fxAlignmentUpperBoundSamples(descriptor.ordinal, spec);
            auto processor = createFxProcessor(descriptor.ordinal);
            if (!require(memory.supported && startup.supported && alignment.supported &&
                         processor && processor->prepare(spec),
                         "each advertised processor prepares with startup/alignment preflight at each supported rate")) {
                std::cerr << "ordinal=" << descriptor.ordinal << " rate=" << sampleRate
                          << " memory=" << memory.supported << " startup=" << startup.supported
                          << " alignment=" << alignment.supported << '\n';
                return false;
            }
            if (!require(processor->startupWarmupFrames() <= startup.frames &&
                         (processor->fixedLatencySamples() < 0 ||
                          static_cast<std::uint32_t>(processor->fixedLatencySamples()) <= alignment.frames),
                         "prepared warmup and fixed latency fit their independently reported bounds")) {
                std::cerr << "ordinal=" << descriptor.ordinal << " rate=" << sampleRate
                          << " startup=" << processor->startupWarmupFrames() << '/' << startup.frames
                          << " fixedLatency=" << processor->fixedLatencySamples()
                          << " alignment=" << alignment.frames << '\n';
                return false;
            }
        }
    }
    return require(availableAtReferenceRate == 41U,
                   "coverage iterates all 41 factory-ready ordinals, not a hard-coded readiness interval");
}

bool testWetDryMixAlignsFixedLatencyAndRejectsVariableLatencyMix() {
    NativeFxGraph graph;
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    if (!require(graph.prepare(spec) == NativeFxGraphResult::Ok &&
                 graph.configureSlot({NativeFxBusKind::Track, 0U}, 0U, 53U, 0.0f) ==
                     NativeFxGraphResult::Ok &&
                 graph.seal() == NativeFxGraphResult::Ok,
                 "prepare a zero-wet Vinyl Flick chain with an aligned dry path")) return false;

    std::array<StereoFrame, 64U> track{};
    NativeFxGraphBlock block{};
    block.trackPlayback[0] = track.data();
    for (std::uint32_t callback = 0U; callback < 16U; ++callback) {
        fill(track, 0.2f, -0.1f);
        if (!require(graph.processBlockWithEvents(block, 64U, callback * 64U,
                                                  nullptr, 0U) == NativeFxGraphResult::Ok,
                     "run the fixed-latency track processor in bounded quanta")) return false;
        if (callback < 15U) {
            for (const auto& sample : track) {
                if (!require(std::abs(sample.left) < 1.0e-7f && std::abs(sample.right) < 1.0e-7f,
                             "outer dry mix remains delayed through the declared latency")) return false;
            }
        }
    }
    if (!require(std::abs(track[0].left - 0.2f) < 1.0e-7f &&
                 std::abs(track[0].right + 0.1f) < 1.0e-7f,
                 "aligned dry samples emerge after 960 frames without combing against wet output")) return false;

    NativeFxGraph variable;
    if (!require(variable.prepare(spec) == NativeFxGraphResult::Ok &&
                 variable.configureSlot({NativeFxBusKind::Track, 0U}, 0U, 51U, 0.5f) ==
                     NativeFxGraphResult::InvalidParameter &&
                 variable.configureSlot({NativeFxBusKind::Track, 0U}, 0U, 51U, 1.0f) ==
                     NativeFxGraphResult::Ok,
                 "fail closed on an unalignable outer mix for variable-latency Beat Repeat")) return false;
    return true;
}

bool testIndependentTrackStereoProcessors() {
    NativeFxGraph graph;
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    if (!require(graph.prepare(spec) == NativeFxGraphResult::Ok, "prepare five-track graph")) return false;
    if (!require(configurePan(graph, {NativeFxBusKind::Track, 0U}, 1.0f) &&
                 configurePan(graph, {NativeFxBusKind::Track, 1U}, -1.0f) &&
                 graph.seal() == NativeFxGraphResult::Ok,
                 "prepare independent right and left panners on two track buses")) return false;

    std::array<std::array<StereoFrame, 64U>, 5U> trackBuffers{};
    std::array<StereoFrame, 64U> input{};
    std::array<StereoFrame, 64U> send{};
    std::array<StereoFrame, 64U> master{};
    NativeFxGraphBlock block{};
    block.inputCapture = input.data();
    for (std::size_t track = 0U; track < trackBuffers.size(); ++track)
        block.trackPlayback[track] = trackBuffers[track].data();
    block.sendReturn = send.data();
    block.masterMix = master.data();

    for (std::uint32_t callback = 0U; callback < 24U; ++callback) {
        fill(trackBuffers[0], 0.2f, -0.1f);
        fill(trackBuffers[1], 0.3f, 0.05f);
        fill(trackBuffers[2], -0.12f, 0.07f);
        fill(trackBuffers[3], 0.0f, 0.0f);
        fill(trackBuffers[4], 0.0f, 0.0f);
        fill(input, 0.0f, 0.0f);
        fill(send, 0.0f, 0.0f);
        fill(master, 0.0f, 0.0f);
        if (!require(graph.processBlock(block, 64U) == NativeFxGraphResult::Ok,
                     "process all independent graph buses at the native 64-frame quantum")) return false;
    }

    const auto right = trackBuffers[0][63U];
    const auto left = trackBuffers[1][63U];
    const auto untouched = trackBuffers[2][63U];
    if (!require(std::abs(right.left) < 0.002f &&
                 std::abs(right.right - 0.1f) < 0.002f,
                 "right-pan Track 1 changes only its own stereo stream")) return false;
    if (!require(std::abs(left.left - 0.35f) < 0.002f &&
                 std::abs(left.right) < 0.002f,
                 "left-pan Track 2 applies the stereo crossfeed law independently")) return false;
    if (!require(std::abs(untouched.left + 0.12f) < 1.0e-6f &&
                 std::abs(untouched.right - 0.07f) < 1.0e-6f,
                 "unconfigured Track 3 is bit-transparent and not cross-fed")) return false;
    return require(graph.permanentProcessorBytes() > 0U && graph.configuredSlotCount() == 2U,
                   "expose two separately budgeted prepared track processors");
}

bool testInputFxIsPlacedBeforeRecordedHistory() {
    NativeFxGraph graph;
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    if (!require(graph.prepare(spec) == NativeFxGraphResult::Ok &&
                 configurePan(graph, {NativeFxBusKind::Input, 0U}, 1.0f) &&
                 graph.seal() == NativeFxGraphResult::Ok,
                 "prepare a real stereo input FX route")) return false;

    MultiTrackLooperCore core;
    if (!require(core.prepare(48000U, 64U) && core.prepareTrackBuffer(0U, 1U),
                 "prepare one stereo recording history for point-placement test")) return false;
    if (!require(core.postCommand({0U, TrackCommandType::Record, 0U, false, 0.0f}),
                 "start recording before the input effect")) return false;

    std::array<StereoFrame, 64U> capture{};
    std::array<float, 128U> coreInput{};
    std::array<float, 128U> coreOutput{};
    std::array<float, 128U> coreSilence{};
    NativeFxGraphBlock block{};
    block.inputCapture = capture.data();
    for (auto& sample : capture) sample = {0.2f, -0.1f};
    for (std::uint32_t warmup = 0U; warmup < 24U; ++warmup) {
        if (!require(graph.processBlock(block, 64U) == NativeFxGraphResult::Ok,
                     "settle the input pan before checking the recorded capture")) return false;
        for (auto& sample : capture) sample = {0.2f, -0.1f};
    }
    if (!require(graph.processBlock(block, 64U) == NativeFxGraphResult::Ok,
                 "process the input bus before handing it to the recorder")) return false;
    for (std::size_t frame = 0U; frame < capture.size(); ++frame) {
        coreInput[frame * 2U] = capture[frame].left;
        coreInput[frame * 2U + 1U] = capture[frame].right;
    }
    if (!require(core.processBlock(coreInput.data(), coreOutput.data(), 64U, 0U),
                 "record the post-input-FX stereo samples")) return false;

    if (!require(core.postCommand({64U, TrackCommandType::Stop, 0U, false, 0.0f}) &&
                 core.processBlock(coreSilence.data(), coreOutput.data(), 64U, 64U),
                 "finalize the loop after the filtered capture")) return false;
    if (!require(core.postCommand({128U, TrackCommandType::Play, 0U, false, 0.0f}),
                 "play the recorded post-FX buffer")) return false;
    for (std::uint64_t start = 128U; start < 128U + 12U * 64U; start += 64U) {
        if (!require(core.processBlock(coreSilence.data(), coreOutput.data(), 64U, start),
                     "render the recorded signal through the software-only core")) return false;
    }
    const StereoFrame last{coreOutput[126U], coreOutput[127U]};
    return require(std::abs(last.left) < 0.002f && std::abs(last.right - 0.1f) < 0.002f,
                   "playback contains the panned input-FX output rather than the dry source");
}

bool testBoundedEventsAreTransactionalAndTimestamped() {
    std::unique_ptr<NativeFxGraph> graph;
    if (!require(prepareEmptyGraph(graph), "build event-test graph")) return false;
    if (!require(configurePan(*graph, {NativeFxBusKind::Input, 0U}, 0.0f) &&
                 graph->seal() == NativeFxGraphResult::Ok,
                 "configure a center-panned input processor")) return false;

    NativeFxGraphExchange exchange;
    if (!require(exchange.stage(graph) == NativeFxGraphResult::Ok && !graph,
                 "stage the immutable graph by ownership transfer")) return false;
    std::array<StereoFrame, 64U> input{};
    for (auto& frame : input) frame = {0.2f, -0.1f};
    NativeFxGraphBlock block{};
    block.inputCapture = input.data();
    if (!require(exchange.processBlock(block, 64U, 0U) == NativeFxGraphResult::Ok &&
                 exchange.hasActiveGraph() && !exchange.reclaimRetired(),
                 "activate the first graph exactly at a block boundary")) return false;

    const NativeFxGraphEvent valid{64U, {NativeFxBusKind::Input, 0U}, 0U,
        NativeFxGraphEventKind::ProcessorParameter, FxParameterId::Pan, 1.0f, 5.0f};
    const NativeFxGraphEvent invalid{64U, {NativeFxBusKind::Input, 0U}, 0U,
        NativeFxGraphEventKind::ProcessorParameter, FxParameterId::FrequencyHz, 400.0f, 5.0f};
    if (!require(exchange.postEvent(valid) == NativeFxGraphResult::Ok &&
                 exchange.postEvent(invalid) == NativeFxGraphResult::Ok &&
                 exchange.postEvent({63U, {NativeFxBusKind::Input, 0U}, 0U,
                     NativeFxGraphEventKind::SlotMix, FxParameterId::Mix, 0.5f, 5.0f}) ==
                     NativeFxGraphResult::TimestampOutOfOrder,
                 "accept a bounded ordered event batch and reject timestamp regression")) return false;
    NativeFxGraphStats stats{};
    input.fill({0.2f, -0.1f});
    const auto rejected = exchange.processBlock(block, 64U, 64U, &stats);
    if (!require(rejected == NativeFxGraphResult::EventBatchRejected &&
                 stats.rejectedEvents == 2U &&
                 std::abs(input[63U].left - 0.2f) < 1.0e-7f &&
                 std::abs(input[63U].right + 0.1f) < 1.0e-7f,
                 "reject the whole batch before any audio or processor state changes")) return false;

    input.fill({0.2f, -0.1f});
    if (!require(exchange.processBlock(block, 64U, 128U, &stats) == NativeFxGraphResult::Ok &&
                 std::abs(input[63U].left - 0.2f) < 1.0e-6f &&
                 std::abs(input[63U].right + 0.1f) < 1.0e-6f,
                 "prove the earlier valid pan event did not leak out of a rejected transaction")) return false;
    return require(stats.processedBusMask == 1U,
                   "report the input bus as the only processed FX route");
}

bool testGraphGenerationDiscardsOldFutureControls() {
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    const NativeFxBusAddress inputBus{NativeFxBusKind::Input, 0U};
    auto makeFilterGraph = [&spec, inputBus](std::uint16_t ordinal) {
        auto graph = std::make_unique<NativeFxGraph>();
        if (graph->prepare(spec) != NativeFxGraphResult::Ok) return std::unique_ptr<NativeFxGraph>{};
        if (graph->configureSlot(inputBus, 0U, ordinal) != NativeFxGraphResult::Ok ||
            graph->seal() != NativeFxGraphResult::Ok)
            return std::unique_ptr<NativeFxGraph>{};
        return graph;
    };

    NativeFxGraphExchange exchange;
    auto oldGraph = makeFilterGraph(1U); // LPF
    const auto oldGraphBytes = oldGraph ? oldGraph->estimatedPermanentBytes() : 0U;
    if (!require(oldGraph && exchange.stage(oldGraph) == NativeFxGraphResult::Ok,
                 "stage an LPF graph with a stable first generation")) return false;
    std::array<StereoFrame, 64U> input{};
    NativeFxGraphBlock block{};
    block.inputCapture = input.data();
    if (!require(exchange.processBlock(block, 64U, 0U) == NativeFxGraphResult::Ok &&
                 exchange.activeGraphBytes() == oldGraphBytes,
                 "activate the original LPF configuration")) return false;
    input.fill({0.2f, -0.1f});
    if (!require(exchange.processBlock(block, 64U, 64U) == NativeFxGraphResult::Ok,
                 "finish the first-install dry-to-FX fade before staging a replacement")) return false;
    const auto oldGeneration = exchange.producerGeneration();
    const NativeFxGraphEvent futureOldControl{
        512U, inputBus, 0U, NativeFxGraphEventKind::ProcessorParameter,
        FxParameterId::FrequencyHz, 18000.0f, 5.0f, oldGeneration};
    if (!require(oldGeneration == 1U && exchange.postEvent(futureOldControl) == NativeFxGraphResult::Ok,
                 "queue a future LPF event with its originating generation")) return false;

    auto newGraph = makeFilterGraph(2U); // BPF accepts the same FrequencyHz ID.
    const auto newGraphBytes = newGraph ? newGraph->estimatedPermanentBytes() : 0U;
    if (!require(newGraph && exchange.stage(newGraph) == NativeFxGraphResult::Ok &&
                 exchange.activeGraphBytes() == oldGraphBytes &&
                 exchange.producerGeneration() == oldGeneration + 1U,
                 "stage a same-slot BPF replacement without publishing it before the boundary")) return false;
    const NativeFxGraphEvent postStageOldControl{
        4096U, inputBus, 0U, NativeFxGraphEventKind::ProcessorParameter,
        FxParameterId::FrequencyHz, 12000.0f, 5.0f, oldGeneration};
    if (!require(exchange.postEvent(postStageOldControl) == NativeFxGraphResult::InvalidEvent &&
                 exchange.queuedEventCount() == 1U,
                 "reject explicit stale-generation events after stage without enqueueing them")) return false;
    const NativeFxGraphEvent nearNewControl{
        128U, inputBus, 0U, NativeFxGraphEventKind::ProcessorParameter,
        FxParameterId::FrequencyHz, 4000.0f, 5.0f, exchange.producerGeneration()};
    if (!require(exchange.postEvent(nearNewControl) == NativeFxGraphResult::Ok,
                 "new generation resets timestamp order despite an old future event")) return false;
    input.fill({0.2f, -0.1f});
    NativeFxGraphStats stats{};
    if (!require(exchange.processBlock(block, 64U, 128U, &stats) == NativeFxGraphResult::Ok &&
                 exchange.activeGraphBytes() == newGraphBytes &&
                 stats.staleGenerationEventsDiscarded == 1U && stats.eventsApplied == 1U &&
                 exchange.staleGenerationEventCount() == 1U,
                 "discard the old-generation future event and apply near new-generation automation")) return false;
    if (!require(!exchange.reclaimRetired(),
                 "keep the prior graph until the two-quantum output crossfade finishes")) return false;

    auto reference = makeFilterGraph(2U);
    std::array<StereoFrame, 64U> referenceInput{};
    referenceInput.fill({0.2f, -0.1f});
    NativeFxGraphBlock referenceBlock{};
    referenceBlock.inputCapture = referenceInput.data();
    const NativeFxGraphEvent referenceControl{
        128U, inputBus, 0U, NativeFxGraphEventKind::ProcessorParameter,
        FxParameterId::FrequencyHz, 4000.0f, 5.0f, 0U};
    if (!require(reference && reference->processBlockWithEvents(
                     referenceBlock, 64U, 128U, &referenceControl, 1U) == NativeFxGraphResult::Ok &&
                 reference->processBlockWithEvents(referenceBlock, 64U, 192U,
                     nullptr, 0U) == NativeFxGraphResult::Ok,
                 "advance a clean BPF reference through both replacement blocks")) return false;

    std::array<StereoFrame, 64U> actualInput{};
    actualInput.fill({0.2f, -0.1f});
    block.inputCapture = actualInput.data();
    if (!require(exchange.processBlock(block, 64U, 192U, &stats) == NativeFxGraphResult::Ok &&
                 stats.staleGenerationEventsDiscarded == 0U && stats.eventsApplied == 0U,
                 "finish the graph crossfade without replaying stale controls")) return false;
    referenceInput.fill({0.2f, -0.1f});
    if (!require(reference->processBlockWithEvents(referenceBlock, 64U, 256U,
                                                   nullptr, 0U) == NativeFxGraphResult::Ok,
                 "advance the clean BPF reference through the same frame")) return false;
    const auto retired = exchange.reclaimRetired();
    return require(retired &&
                   std::abs(actualInput.back().left - referenceInput.back().left) < 1.0e-7f &&
                   std::abs(actualInput.back().right - referenceInput.back().right) < 1.0e-7f,
                   "retire off-callback and end on the clean BPF output after stale control rejection");
}

bool testFirstGraphInstallCrossfadesFromDry() {
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    auto graph = std::make_unique<NativeFxGraph>();
    if (!require(graph->prepare(spec) == NativeFxGraphResult::Ok &&
                 graph->configureSlot({NativeFxBusKind::Input, 0U}, 0U, 2U) ==
                     NativeFxGraphResult::Ok &&
                 graph->seal() == NativeFxGraphResult::Ok,
                 "prepare a stateful BPF for the first graph-install transition")) return false;
    NativeFxGraphExchange exchange;
    if (!require(exchange.stage(graph) == NativeFxGraphResult::Ok,
                 "stage the first graph from the dry host path")) return false;
    std::array<StereoFrame, 64U> input{};
    input.fill({0.3f, -0.2f});
    NativeFxGraphBlock block{};
    block.inputCapture = input.data();
    float previousLeft = 0.3f;
    float previousRight = -0.2f;
    float maximumStep = 0.0f;
    for (std::uint32_t callback = 0U; callback < 2U; ++callback) {
        input.fill({0.3f, -0.2f});
        if (!require(exchange.processBlock(block, 64U, callback * 64U) == NativeFxGraphResult::Ok,
                     "render the first two callbacks while the graph fades in")) return false;
        for (const auto& sample : input) {
            maximumStep = std::max(maximumStep, std::abs(sample.left - previousLeft));
            maximumStep = std::max(maximumStep, std::abs(sample.right - previousRight));
            previousLeft = sample.left;
            previousRight = sample.right;
        }
    }
    return require(maximumStep < 0.03f && !exchange.reclaimRetired(),
                   "first install transitions from dry with bounded sample steps and no retired graph");
}

bool testLatencyEffectTransitionsWarmBeforeFadingAndBoundedToneSteps() {
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    const NativeFxBusAddress trackBus{NativeFxBusKind::Track, 0U};
    const std::array<NativeFxInitialParameter, 1U> active{{
        {FxParameterId::Active, 1.0f}}};
    auto makeTransitionGraph = [&spec, &trackBus, &active](std::uint16_t ordinal) {
        auto graph = std::make_unique<NativeFxGraph>();
        if (graph->prepare(spec) != NativeFxGraphResult::Ok) return std::unique_ptr<NativeFxGraph>{};
        const auto configured = ordinal == 52U || ordinal == 53U
            ? graph->configureSlot(trackBus, 0U, ordinal, 1.0f, 5.0f,
                                   active.data(), static_cast<std::uint32_t>(active.size()))
            : graph->configureSlot(trackBus, 0U, ordinal);
        if (configured != NativeFxGraphResult::Ok || graph->seal() != NativeFxGraphResult::Ok)
            return std::unique_ptr<NativeFxGraph>{};
        return graph;
    };
    auto render = [&](NativeFxGraphExchange& exchange, std::uint64_t frame,
                      auto sampleAt, float& maximumStep, float& previousOutput,
                      bool& hasPreviousOutput, bool expectDry) {
        std::array<StereoFrame, kNativeFxGraphMaximumFrames> buffer{};
        for (std::uint32_t index = 0U; index < buffer.size(); ++index) {
            const auto sample = sampleAt(frame + index);
            buffer[index] = {sample, sample * -0.55f};
        }
        NativeFxGraphBlock block{};
        block.trackPlayback[0] = buffer.data();
        if (exchange.processBlock(block, static_cast<std::uint32_t>(buffer.size()), frame) !=
            NativeFxGraphResult::Ok) return false;
        for (std::uint32_t index = 0U; index < buffer.size(); ++index) {
            const auto absolute = frame + index;
            const auto original = sampleAt(absolute);
            if (expectDry && std::abs(buffer[index].left - original) > 1.0e-6f) return false;
            if (hasPreviousOutput)
                maximumStep = std::max(maximumStep,
                    std::abs(buffer[index].left - previousOutput));
            previousOutput = buffer[index].left;
            hasPreviousOutput = true;
        }
        return true;
    };

    // The fixed time-axis delay is 20 ms, but the candidate must process the
    // full retained history before becoming live so a subsequent legal flick
    // can read any point in the prepared four-second horizon.
    auto vinyl = makeTransitionGraph(53U);
    if (!vinyl) return require(false, "prepare a Vinyl graph with Active enabled");
    const auto vinylWarmup = fxStartupWarmupUpperBoundSamples(53U, spec).frames;
    auto vinylProcessor = createFxProcessor(53U);
    if (!require(vinylWarmup == 192000U + spec.maxBlockFrames + 12U && vinylProcessor &&
                 vinylProcessor->prepare(spec) && vinylProcessor->fixedLatencySamples() == 960 &&
                 vinyl->transitionWarmupFrames() == vinylWarmup,
                 "separate Vinyl's 20 ms fixed latency from its full finite-history warmup")) return false;
    NativeFxGraphExchange cold;
    if (!require(cold.stage(vinyl) == NativeFxGraphResult::Ok,
                 "stage a cold full-history Vinyl graph")) return false;
    auto dc = [](std::uint64_t) { return 0.2f; };
    float coldMaximumStep = 0.0f;
    float coldPrevious = 0.0f;
    bool coldHasPrevious = false;
    const auto vinylWarmupBlocks = (vinylWarmup + 63U) / 64U;
    for (std::uint64_t frame = 0U; frame < vinylWarmupBlocks * 64U + 128U; frame += 64U) {
        if (!render(cold, frame, dc, coldMaximumStep, coldPrevious, coldHasPrevious,
                    frame < vinylWarmup))
            return require(false, "hold the first-install dry signal through Vinyl warmup");
    }
    if (!require(coldMaximumStep < 0.01f && !cold.reclaimRetired(),
                 "cold dry-to-Vinyl transition stays continuous across DC and has no old graph"))
        return false;

    // Beat Shift reports variable algorithmic latency, while its accepted
    // automation can request a six-second 20 BPM trajectory; the candidate
    // warms the whole retained horizon before publication.
    auto shift = makeTransitionGraph(52U);
    const auto shiftWarmup = fxStartupWarmupUpperBoundSamples(52U, spec).frames;
    auto shiftProcessor = createFxProcessor(52U);
    if (!require(shiftWarmup == 288240U + 4U && shiftProcessor &&
                 shiftProcessor->prepare(spec) && shiftProcessor->fixedLatencySamples() == -1 &&
                 shift && shift->transitionWarmupFrames() == shiftWarmup,
                 "apply Beat Shift's full history warmup while latency remains variable")) return false;
    NativeFxGraphExchange beatShift;
    if (!require(beatShift.stage(shift) == NativeFxGraphResult::Ok,
                 "stage a cold Beat Shift graph")) return false;
    auto lowTone = [](std::uint64_t frame) {
        return static_cast<float>(0.15 * std::sin(2.0 * 3.14159265358979323846 * 55.0 *
                                                  static_cast<double>(frame) / 48000.0));
    };
    float shiftMaximumStep = 0.0f;
    float shiftPrevious = 0.0f;
    bool shiftHasPrevious = false;
    const auto shiftWarmupBlocks = (shiftWarmup + 63U) / 64U;
    const auto shiftCallbacks = shiftWarmupBlocks + 2U;
    for (std::uint64_t frame = 0U; frame < shiftCallbacks * 64U; frame += 64U) {
        if (!render(beatShift, frame, lowTone, shiftMaximumStep, shiftPrevious, shiftHasPrevious,
                    frame < shiftWarmup))
            return require(false, "hold the first-install dry signal through Beat Shift warmup");
    }
    if (!require(shiftMaximumStep < 0.006f && !beatShift.reclaimRetired(),
                 "cold dry-to-Beat Shift transition bounds 55 Hz sample steps")) return false;

    // Now exercise a live LPF-to-Vinyl replacement and then a Vinyl clear.
    auto lpf = makeTransitionGraph(1U);
    NativeFxGraphExchange replacement;
    if (!require(lpf && replacement.stage(lpf) == NativeFxGraphResult::Ok,
                 "stage the source graph for an old-to-new latency transition")) return false;
    float replacementMaximumStep = 0.0f;
    float replacementPrevious = 0.0f;
    bool replacementHasPrevious = false;
    for (std::uint64_t frame = 0U; frame < 2U * 64U; frame += 64U) {
        if (!render(replacement, frame, lowTone, replacementMaximumStep,
                    replacementPrevious, replacementHasPrevious, false))
            return require(false, "settle the old zero-latency LPF graph");
    }
    auto newVinyl = makeTransitionGraph(53U);
    if (!require(newVinyl && replacement.stage(newVinyl) == NativeFxGraphResult::Ok,
                 "stage a cold Vinyl graph over the live LPF")) return false;
    const auto replacementStart = 2U * 64U;
    const auto replacementCallbacks = (vinylWarmup + kNativeFxGraphSwapCrossfadeFrames + 63U) / 64U;
    for (std::uint64_t frame = replacementStart;
         frame < replacementStart + replacementCallbacks * 64U; frame += 64U) {
        if (!render(replacement, frame, lowTone, replacementMaximumStep,
                    replacementPrevious, replacementHasPrevious,
                    false))
            return require(false, "warm the replacement while keeping the LPF audible");
    }
    if (!require(replacementMaximumStep < 0.006f && replacement.reclaimRetired(),
                 "LPF-to-Vinyl transition warms the candidate and bounds 55 Hz steps"))
        return false;

    auto clear = std::make_unique<NativeFxGraph>();
    if (!require(clear->prepare(spec) == NativeFxGraphResult::Ok &&
                 clear->seal() == NativeFxGraphResult::Ok &&
                 replacement.stage(clear) == NativeFxGraphResult::Ok,
                 "stage a true empty graph to clear the latency effect")) return false;
    float clearMaximumStep = 0.0f;
    float clearPrevious = 0.0f;
    bool clearHasPrevious = false;
    const auto clearStart = replacementStart + replacementCallbacks * 64U;
    for (std::uint64_t frame = clearStart; frame < clearStart + 2U * 64U; frame += 64U) {
        if (!render(replacement, frame, lowTone, clearMaximumStep,
                    clearPrevious, clearHasPrevious, false))
            return require(false, "render old-to-clear transition on the low-frequency tone");
    }
    if (!require(clearMaximumStep < 0.006f && replacement.reclaimRetired(),
                 "clearing Vinyl crossfades its delayed output without a low-tone step"))
        return false;
    return true;
}

bool testSerialLatencyWarmupSumsSlotsAndTrackMasterPath() {
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    const NativeFxInitialParameter active{FxParameterId::Active, 1.0f};
    const auto makeVinylChain = [&spec, &active](std::uint32_t count) {
        auto graph = std::make_unique<NativeFxGraph>();
        if (graph->prepare(spec) != NativeFxGraphResult::Ok) return std::unique_ptr<NativeFxGraph>{};
        for (std::uint32_t slot = 0U; slot < count; ++slot) {
            if (graph->configureSlot({NativeFxBusKind::Master, 0U},
                                     static_cast<std::uint8_t>(slot), 53U, 1.0f, 5.0f,
                                     &active, 1U) != NativeFxGraphResult::Ok)
                return std::unique_ptr<NativeFxGraph>{};
        }
        if (graph->seal() != NativeFxGraphResult::Ok) return std::unique_ptr<NativeFxGraph>{};
        return graph;
    };
    for (const std::uint32_t count : {2U, 4U}) {
        auto graph = makeVinylChain(count);
        if (!require(graph && graph->transitionWarmupFrames() == count * 192076U,
                     "sum finite-history warmup for every serial Vinyl slot")) return false;
    }

    // Input, one track and Master are a conservative serial route bound. The
    // current Vinyl adapter is track-capable but not input-capable, so use a
    // zero-latency input EQ and verify the actual Track -> Master contribution.
    auto path = std::make_unique<NativeFxGraph>();
    if (!require(path && path->prepare(spec) == NativeFxGraphResult::Ok &&
                 path->configureSlot({NativeFxBusKind::Input, 0U}, 0U, 26U) == NativeFxGraphResult::Ok &&
                 path->configureSlot({NativeFxBusKind::Track, 0U}, 0U, 53U, 1.0f, 5.0f,
                                    &active, 1U) == NativeFxGraphResult::Ok &&
                 path->configureSlot({NativeFxBusKind::Master, 0U}, 0U, 53U, 1.0f, 5.0f,
                                    &active, 1U) == NativeFxGraphResult::Ok &&
                 path->seal() == NativeFxGraphResult::Ok &&
                 path->transitionWarmupFrames() == 2U * 192076U,
                 "account the serial Track -> Master finite-history chain on the looper path"))
        return false;

    const auto renderTransition = [](NativeFxGraphExchange& exchange, std::uint64_t firstFrame,
                                     std::uint64_t frameCount, std::uint32_t dryFrames,
                                     const auto& sampleAt, float dryTolerance,
                                     float maxStepLimit, const char* label) {
        StereoFrame previous{};
        bool havePrevious = false;
        float maxStep = 0.0f;
        std::array<StereoFrame, kNativeFxGraphMaximumFrames> blockBuffer{};
        for (std::uint64_t offset = 0U; offset < frameCount; offset += blockBuffer.size()) {
            const auto frame = firstFrame + offset;
            for (std::uint32_t index = 0U; index < blockBuffer.size(); ++index) {
                const float sample = sampleAt(frame + index);
                blockBuffer[index] = {sample, sample * -0.55f};
            }
            NativeFxGraphBlock block{};
            block.masterMix = blockBuffer.data();
            if (exchange.processBlock(block, static_cast<std::uint32_t>(blockBuffer.size()), frame) !=
                NativeFxGraphResult::Ok) return false;
            for (std::uint32_t index = 0U; index < blockBuffer.size(); ++index) {
                const auto currentFrame = offset + index;
                const float source = sampleAt(frame + index);
                if (currentFrame < dryFrames &&
                    (std::abs(blockBuffer[index].left - source) > dryTolerance ||
                     std::abs(blockBuffer[index].right - source * -0.55f) > dryTolerance))
                    return false;
                if (havePrevious) {
                    maxStep = std::max(maxStep, std::abs(blockBuffer[index].left - previous.left));
                    maxStep = std::max(maxStep, std::abs(blockBuffer[index].right - previous.right));
                }
                previous = blockBuffer[index];
                havePrevious = true;
            }
        }
        if (maxStep >= maxStepLimit) {
            std::cerr << "FAIL: " << label << " max sample step=" << maxStep << '\n';
            return false;
        }
        return true;
    };
    const auto dc = [](std::uint64_t) { return 0.2f; };
    const auto tone = [](std::uint64_t frame) {
        return static_cast<float>(0.15 * std::sin(2.0 * 3.14159265358979323846 * 55.0 *
                                                  static_cast<double>(frame) / 48000.0));
    };
    using Waveform = float (*)(std::uint64_t);
    const std::array<Waveform, 2U> waveforms{{+dc, +tone}};

    NativeFxGraphExchange looperPath;
    if (!require(looperPath.stage(path) == NativeFxGraphResult::Ok,
                 "stage the actual Input -> Track -> Master graph path")) return false;
    float pathMaximumStep = 0.0f;
    StereoFrame pathPrevious{};
    bool pathHasPrevious = false;
    std::array<StereoFrame, 64U> input{};
    std::array<StereoFrame, 64U> track{};
    std::array<StereoFrame, 64U> send{};
    std::array<StereoFrame, 64U> master{};
    const auto pathWarmupFrames = 2U * 192076U;
    const auto pathCallbacks = (pathWarmupFrames + kNativeFxGraphSwapCrossfadeFrames + 63U) / 64U;
    for (std::uint64_t frame = 0U; frame < pathCallbacks * 64U;
         frame += 64U) {
        for (std::uint32_t index = 0U; index < input.size(); ++index) {
            const auto sample = tone(frame + index);
            input[index] = {sample, sample * -0.55f};
            track[index] = {sample, sample * -0.55f};
            send[index] = {};
            master[index] = {};
        }
        NativeFxGraphBlock block{};
        block.inputCapture = input.data();
        block.trackPlayback[0] = track.data();
        block.sendReturn = send.data();
        block.masterMix = master.data();
        if (looperPath.beginBlock(block, 64U, frame) != NativeFxGraphResult::Ok ||
            looperPath.processInputBus() != NativeFxGraphResult::Ok) return false;
        for (std::uint8_t index = 0U; index < 5U; ++index)
            if (looperPath.processTrackBus(index) != NativeFxGraphResult::Ok) return false;
        for (std::uint32_t index = 0U; index < track.size(); ++index)
            master[index] = track[index];
        if (looperPath.processSendBus() != NativeFxGraphResult::Ok ||
            looperPath.processMasterBus() != NativeFxGraphResult::Ok ||
            looperPath.endBlock() != NativeFxGraphResult::Ok) return false;
        for (std::uint32_t index = 0U; index < master.size(); ++index) {
            const auto absolute = frame + index;
            const auto expectedDry = tone(absolute);
            if (absolute < pathWarmupFrames &&
                (std::abs(master[index].left - expectedDry) > 1.0e-6f ||
                 std::abs(master[index].right - expectedDry * -0.55f) > 1.0e-6f))
                return require(false, "keep actual serial Track -> Master output dry through full warmup");
            if (pathHasPrevious) {
                pathMaximumStep = std::max(pathMaximumStep,
                    std::abs(master[index].left - pathPrevious.left));
                pathMaximumStep = std::max(pathMaximumStep,
                    std::abs(master[index].right - pathPrevious.right));
            }
            pathPrevious = master[index];
            pathHasPrevious = true;
        }
    }
    if (!require(pathMaximumStep < 0.006f,
                 "bound the actual Track -> Master cold fixed-latency transition step"))
        return false;

    for (const std::uint32_t count : {2U, 4U}) {
        const auto warmup = count * 192076U;
        const auto callbacks = (warmup + kNativeFxGraphSwapCrossfadeFrames + 63U) /
                               kNativeFxGraphMaximumFrames;
        const auto duration = callbacks * kNativeFxGraphMaximumFrames;
        for (const auto sampleAt : waveforms) {
            auto coldGraph = makeVinylChain(count);
            NativeFxGraphExchange cold;
            if (!require(coldGraph && cold.stage(coldGraph) == NativeFxGraphResult::Ok,
                         "stage a cold multi-slot fixed-latency graph")) return false;
            if (!require(renderTransition(cold, 0U, callbacks * 64U, warmup, sampleAt,
                                         1.0e-6f, 0.006f,
                                         "cold dry-to-serial-Vinyl DC/tone transition") &&
                         !cold.reclaimRetired(),
                         "keep cold output dry for summed warmup before a bounded transition"))
                return false;
        }

        for (const auto sampleAt : waveforms) {
            auto oldGraph = std::make_unique<NativeFxGraph>();
            if (!require(oldGraph && oldGraph->prepare(spec) == NativeFxGraphResult::Ok &&
                         oldGraph->configureSlot({NativeFxBusKind::Master, 0U}, 0U, 1U) ==
                             NativeFxGraphResult::Ok && oldGraph->seal() == NativeFxGraphResult::Ok,
                         "prepare a zero-latency source for a multi-slot replacement")) return false;
            NativeFxGraphExchange replace;
            if (!require(replace.stage(oldGraph) == NativeFxGraphResult::Ok,
                         "stage the zero-latency source graph")) return false;
            const std::uint64_t sourceFrames = 3U * 64U;
            for (std::uint64_t frame = 0U; frame < sourceFrames; frame += 64U) {
                std::array<StereoFrame, 64U> data{};
                for (std::uint32_t i = 0U; i < data.size(); ++i) {
                    const auto sample = sampleAt(frame + i);
                    data[i] = {sample, sample * -0.55f};
                }
                NativeFxGraphBlock block{};
                block.masterMix = data.data();
                if (replace.processBlock(block, 64U, frame) != NativeFxGraphResult::Ok) return false;
            }
            auto candidate = makeVinylChain(count);
            if (!require(candidate && replace.stage(candidate) == NativeFxGraphResult::Ok,
                         "stage a serial multi-slot replacement graph")) return false;
            if (!require(renderTransition(replace, sourceFrames, duration, 0U, sampleAt,
                                         0.0f, 0.006f,
                                         "zero-latency-to-serial-Vinyl DC/tone replacement") &&
                         replace.reclaimRetired(),
                         "complete replacement after serial Vinyl warmup and crossfade")) return false;

            auto empty = std::make_unique<NativeFxGraph>();
            if (!require(empty->prepare(spec) == NativeFxGraphResult::Ok &&
                         empty->seal() == NativeFxGraphResult::Ok &&
                         replace.stage(empty) == NativeFxGraphResult::Ok,
                         "stage a dry graph to clear a serial latency chain")) return false;
            const auto clearFrame = sourceFrames + duration;
            if (!require(renderTransition(replace, clearFrame, 2U * 64U, 0U, sampleAt,
                                         0.0f, 0.006f, "serial-Vinyl-to-dry DC/tone clear") &&
                         replace.reclaimRetired(),
                         "clear the serial latency chain without an adjacent-sample discontinuity"))
                return false;
        }
    }
    return true;
}

bool testSlotReplacementPreflightIncludesOldProcessorState() {
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    const auto oldRequirement = webrc::dsp::fxMemoryRequirement(1U, spec);
    const auto candidateRequirement = webrc::dsp::fxMemoryRequirement(26U, spec);
    const auto oldPeak = oldRequirement.peakBytes();
    const auto candidatePeak = candidateRequirement.peakBytes();
    const auto budget = sizeof(NativeFxGraph) + std::max(oldPeak, candidatePeak);
    NativeFxGraph graph;
    const NativeFxBusAddress trackBus{NativeFxBusKind::Track, 0U};
    if (!require(oldRequirement.supported && candidateRequirement.supported &&
                 graph.prepare(spec, budget) == NativeFxGraphResult::Ok &&
                 graph.configureSlot(trackBus, 0U, 1U) == NativeFxGraphResult::Ok,
                 "admit one processor under a budget sufficient for either configuration alone")) return false;
    const auto permanentBefore = graph.permanentProcessorBytes();
    const auto projected = graph.configureSlot(trackBus, 0U, 26U);
    return require(projected == NativeFxGraphResult::MemoryBudgetExceeded &&
                   graph.slotOrdinal(trackBus, 0U) == 1U &&
                   graph.permanentProcessorBytes() == permanentBefore,
                   "reject replacement before prepare when old and candidate peak states exceed budget");
}

bool testCoupledFxInitialAndAutomatedParametersAreTransactional() {
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    const NativeFxBusAddress inputBus{NativeFxBusKind::Input, 0U};
    NativeFxGraph radio;
    const std::array<NativeFxInitialParameter, 2U> validRadio{{
        {FxParameterId::RadioHighPassHz, 500.0f},
        {FxParameterId::RadioLowPassHz, 6000.0f},
    }};
    if (!require(radio.prepare(spec) == NativeFxGraphResult::Ok &&
                 radio.configureSlot(inputBus, 0U, 8U, 1.0f, 5.0f,
                     validRadio.data(), static_cast<std::uint32_t>(validRadio.size())) ==
                     NativeFxGraphResult::Ok,
                 "validate a final-valid Radio cutoff pair before queuing either update")) return false;
    NativeFxGraph invalidRadio;
    const std::array<NativeFxInitialParameter, 2U> invalidRadioPair{{
        {FxParameterId::RadioHighPassHz, 500.0f},
        {FxParameterId::RadioLowPassHz, 400.0f},
    }};
    if (!require(invalidRadio.prepare(spec) == NativeFxGraphResult::Ok &&
                 invalidRadio.configureSlot(inputBus, 0U, 8U, 1.0f, 5.0f,
                     invalidRadioPair.data(), static_cast<std::uint32_t>(invalidRadioPair.size())) ==
                     NativeFxGraphResult::InvalidParameter &&
                 !invalidRadio.hasSlot(inputBus, 0U),
                 "reject the whole initial Radio pair without installing a partial slot")) return false;

    constexpr std::array<std::uint16_t, 5U> ordinals{{5U, 33U, 37U, 39U, 46U}};
    constexpr std::array<float, 5U> upperBoundsMs{{30.0f, 35.0f, 2000.0f, 2000.0f, 120.0f}};
    for (std::size_t index = 0U; index < ordinals.size(); ++index) {
        NativeFxGraph graph;
        NativeFxGraph reference;
        if (!require(graph.prepare(spec) == NativeFxGraphResult::Ok &&
                     reference.prepare(spec) == NativeFxGraphResult::Ok &&
                     graph.configureSlot(inputBus, 0U, ordinals[index]) == NativeFxGraphResult::Ok &&
                     reference.configureSlot(inputBus, 0U, ordinals[index]) == NativeFxGraphResult::Ok &&
                     graph.seal() == NativeFxGraphResult::Ok &&
                     reference.seal() == NativeFxGraphResult::Ok,
                     "prepare paired graphs for every modulated-delay adapter")) return false;
        std::array<StereoFrame, 64U> audio{};
        NativeFxGraphBlock block{};
        block.inputCapture = audio.data();
        std::array<NativeFxGraphEvent, 2U> invalidEvents{{
            {0U, inputBus, 0U, NativeFxGraphEventKind::ProcessorParameter,
             FxParameterId::DelayMs, upperBoundsMs[index] - 0.5f},
            {32U, inputBus, 0U, NativeFxGraphEventKind::ProcessorParameter,
             FxParameterId::ModulationDepthMs, 0.0f},
        }};
        audio.fill({0.17f, -0.09f});
        const auto rejected = graph.processBlockWithEvents(
            block, 64U, 0U, invalidEvents.data(), static_cast<std::uint32_t>(invalidEvents.size()));
        if (!require(rejected == NativeFxGraphResult::InvalidParameter &&
                     std::abs(audio[0].left - 0.17f) < 1.0e-7f &&
                     std::abs(audio[0].right + 0.09f) < 1.0e-7f,
                     "reject transiently unsafe delay/depth before touching PCM")) return false;

        audio.fill({0.17f, -0.09f});
        std::array<StereoFrame, 64U> referenceAudio{};
        referenceAudio.fill({0.17f, -0.09f});
        NativeFxGraphBlock referenceBlock{};
        referenceBlock.inputCapture = referenceAudio.data();
        if (!require(graph.processBlock(block, 64U) == NativeFxGraphResult::Ok &&
                     reference.processBlock(referenceBlock, 64U) == NativeFxGraphResult::Ok,
                     "continue both processors after rejecting the complete automation batch")) return false;
        for (std::size_t frame = 0U; frame < audio.size(); ++frame) {
            if (!require(audio[frame].left == referenceAudio[frame].left &&
                         audio[frame].right == referenceAudio[frame].right,
                         "rejected coupled automation leaves processor history bit-identical")) return false;
        }

        const std::array<NativeFxGraphEvent, 2U> validEvents{{
            {64U, inputBus, 0U, NativeFxGraphEventKind::ProcessorParameter,
             FxParameterId::ModulationDepthMs, 0.0f},
            {96U, inputBus, 0U, NativeFxGraphEventKind::ProcessorParameter,
             FxParameterId::DelayMs, upperBoundsMs[index] - 0.5f},
        }};
        audio.fill({0.17f, -0.09f});
        if (!require(graph.processBlockWithEvents(
                     block, 64U, 64U, validEvents.data(), static_cast<std::uint32_t>(validEvents.size())) ==
                     NativeFxGraphResult::Ok,
                     "accept a safe sequence that lowers modulation depth before raising base delay")) return false;
    }

    NativeFxGraph timeline;
    if (!require(timeline.prepare(spec) == NativeFxGraphResult::Ok &&
                 timeline.configureSlot(inputBus, 0U, 39U) == NativeFxGraphResult::Ok &&
                 timeline.seal() == NativeFxGraphResult::Ok,
                 "prepare a time-aware Mod Delay graph for convenience API continuity")) return false;
    std::array<StereoFrame, 64U> audio{};
    audio.fill({0.1f, -0.07f});
    NativeFxGraphBlock block{};
    block.inputCapture = audio.data();
    return require(timeline.processBlock(block, 64U) == NativeFxGraphResult::Ok &&
                   timeline.processBlock(block, 64U) == NativeFxGraphResult::Ok,
                   "consecutive processBlock calls advance the absolute DSP timeline");
}

bool testNativeHostRunsInputAndTrackFxOnTheCorrectSideOfRecordingAndMix() {
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U), "prepare five-track software host without opening hardware"))
        return false;

    auto graph = std::make_unique<NativeFxGraph>();
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    const std::array<NativeFxInitialParameter, 2U> panner{{
        {FxParameterId::Active, 1.0f}, {FxParameterId::Pan, 1.0f}}};
    if (!require(graph->prepare(spec, host.candidateFxGraphBudgetBytes()) == NativeFxGraphResult::Ok &&
                 graph->configureSlot({NativeFxBusKind::Input, 0U}, 0U, 30U, 1.0f, 5.0f,
                                      panner.data(), static_cast<std::uint32_t>(panner.size())) ==
                     NativeFxGraphResult::Ok &&
                 graph->configureSlot({NativeFxBusKind::Track, 0U}, 0U, 30U, 1.0f, 5.0f,
                                      panner.data(), static_cast<std::uint32_t>(panner.size())) ==
                     NativeFxGraphResult::Ok && graph->seal() == NativeFxGraphResult::Ok &&
                 host.stageFxGraph(graph) == NativeFxGraphResult::Ok && !graph,
                 "stage input and Track 1 panners as one prepared Native graph")) return false;

    if (!require(host.setPan(0U, -1.0f),
                 "queue the separate post-Track-FX pan control")) return false;
    std::array<float, 256U> input{};
    std::array<float, 256U> output{};
    for (std::uint32_t frame = 0U; frame < 128U; ++frame) {
        input[frame * 2U] = 0.2f;
        input[frame * 2U + 1U] = -0.1f;
    }
    for (std::uint32_t callback = 0U; callback < 10U; ++callback) {
        if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U),
                     "settle input FX and track-mix controls on the software callback")) return false;
    }
    if (!require(host.status().fxGraphActive && host.status().fxGraphGeneration == 1U,
                 "publish that the prepared graph is active in Native host status")) return false;

    if (!require(host.record(0U), "queue recording on the first track")) return false;
    for (std::uint32_t callback = 0U; callback < 1U; ++callback) {
        if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U),
                     "reach the sample-accurate record command")) return false;
    }
    if (!require(host.processInputBlock(input.data(), 2U, output.data(), 128U),
                 "record 128 input-FX processed stereo frames")) return false;
    if (!require(host.stop(0U), "queue stop after the recorded stereo block")) return false;
    if (!require(host.processInputBlock(input.data(), 2U, output.data(), 128U),
                 "finish the scheduled take")) return false;
    if (!require(host.play(0U), "queue playback through the independent Track FX chain")) return false;
    if (!require(host.processInputBlock(input.data(), 2U, output.data(), 128U),
                 "reach the sample-accurate play command")) return false;
    for (std::uint32_t callback = 0U; callback < 10U; ++callback) {
        if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U),
                     "render Track FX before the per-track pan/gain mix")) return false;
    }
    const auto status = host.status();
    if (!require(status.tracks[0].state == TrackPlaybackState::Playing &&
                 status.tracks[0].loopFrames >= 128U && status.lastProcess.outputPeak > 0.08f,
                 "recorded history remains available for five-track playback")) return false;
    const auto left = output[126U];
    const auto right = output[127U];
    if (!(left > 0.08f && std::abs(right) < 0.01f))
        std::cerr << "host graph order sample=" << left << "," << right
                  << " state=" << static_cast<int>(status.tracks[0].state)
                  << " rec=" << status.tracks[0].recordedFrames
                  << " loop=" << status.tracks[0].loopFrames
                  << " peak=" << status.lastProcess.outputPeak << "\n";
    if (!require(left > 0.08f && std::abs(right) < 0.01f,
                 "input pan was recorded before history and Track FX precedes the hard-left track pan"))
        return false;
    return require(!host.reclaimRetiredFxGraph(),
                   "the active Native graph remains host-owned until replaced");
}

bool testHostAggregateBudgetPreflightsCandidateAgainstHistoryAndActiveGraph() {
    const ProcessSpec spec{8000.0f, kNativeFxGraphMaximumFrames, 2U};
    auto graphBytesFor = [&spec](std::uint16_t ordinal) -> std::uint64_t {
        NativeFxGraph graph;
        if (graph.prepare(spec) != NativeFxGraphResult::Ok ||
            graph.configureSlot({NativeFxBusKind::Master, 0U}, 0U, ordinal) !=
                NativeFxGraphResult::Ok || graph.seal() != NativeFxGraphResult::Ok)
            return 0U;
        return graph.estimatedPermanentBytes();
    };
    const auto lpfBytes = graphBytesFor(1U);
    const auto vinylBytes = graphBytesFor(53U);
    const auto historyBytes = MultiTrackLooperCore::requiredTrackBufferBytes(8000U, 1U) *
                              kNativeTrackCount;
    const auto fixedBytes = NativeTrackHost::requiredFixedMemoryBytes();
    if (!require(lpfBytes > 0U && vinylBytes > lpfBytes,
                 "derive exact prepared graph accounting for a filter and fixed-latency adapter"))
        return false;

    // Leave one byte less than the simultaneous old-LPF + Vinyl candidate
    // peak. History + fixed host/core storage are accounted first.
    const auto aggregateBudget = fixedBytes + historyBytes + lpfBytes + vinylBytes - 1U;
    NativeTrackHost host;
    if (!require(host.prepare(8000U, 1U, aggregateBudget),
                 "prepare histories inside the aggregate host memory ceiling")) return false;
    auto candidateBudget = host.candidateFxGraphBudgetBytes();
    if (!require(candidateBudget == lpfBytes + vinylBytes - 1U,
                 "candidate graph budget excludes prepared history and fixed host memory"))
        return false;

    auto active = std::make_unique<NativeFxGraph>();
    if (!require(active->prepare(spec, candidateBudget) == NativeFxGraphResult::Ok &&
                 active->configureSlot({NativeFxBusKind::Master, 0U}, 0U, 1U) ==
                     NativeFxGraphResult::Ok && active->seal() == NativeFxGraphResult::Ok &&
                 active->estimatedPermanentBytes() == lpfBytes &&
                 host.stageFxGraph(active) == NativeFxGraphResult::Ok,
                 "preflight and stage an active LPF within remaining aggregate memory")) return false;

    std::array<float, 256U> silence{};
    if (!require(host.processInputBlock(nullptr, 1U, silence.data(), 128U),
                 "activate the graph and finish the initial transition in software")) return false;
    const auto afterActive = host.status();
    if (!require(afterActive.fxGraphActive && afterActive.preparedFxGraphBytes == lpfBytes &&
                 afterActive.candidateFxGraphBudgetBytes == vinylBytes - 1U,
                 "the active graph consumes its exact bytes in the aggregate ledger")) return false;

    auto replacement = std::make_unique<NativeFxGraph>();
    if (!require(replacement->prepare(spec, afterActive.candidateFxGraphBudgetBytes) ==
                     NativeFxGraphResult::Ok &&
                 replacement->configureSlot({NativeFxBusKind::Master, 0U}, 0U, 53U) ==
                     NativeFxGraphResult::MemoryBudgetExceeded,
                 "reject a replacement before processor/vector allocation when active+candidate peak exceeds ceiling"))
        return false;
    const auto unchanged = host.status();
    return require(unchanged.fxGraphActive && unchanged.fxGraphGeneration == 1U &&
                   unchanged.preparedFxGraphBytes == lpfBytes &&
                   unchanged.candidateFxGraphBudgetBytes == vinylBytes - 1U,
                   "failed aggregate candidate preflight preserves the active graph and its budget");
}

bool testRetiredGraphBytesStayReservedUntilControlThreadDestroysTheGraph() {
    const ProcessSpec spec{8000.0f, kNativeFxGraphMaximumFrames, 2U};
    auto graphBytesFor = [&spec](std::uint16_t ordinal) -> std::uint64_t {
        NativeFxGraph graph;
        if (graph.prepare(spec) != NativeFxGraphResult::Ok ||
            graph.configureSlot({NativeFxBusKind::Master, 0U}, 0U, ordinal) !=
                NativeFxGraphResult::Ok || graph.seal() != NativeFxGraphResult::Ok)
            return 0U;
        return graph.estimatedPermanentBytes();
    };
    const auto filterBytes = graphBytesFor(1U);
    const auto vinylBytes = graphBytesFor(53U);
    const auto vinylRequirement = webrc::dsp::fxMemoryRequirement(53U, spec);
    const auto vinylPrepareScratchBytes = vinylRequirement.prepareScratchBytes;
    const auto historyBytes = MultiTrackLooperCore::requiredTrackBufferBytes(8000U, 1U) *
                              kNativeTrackCount;
    const auto fixedBytes = NativeTrackHost::requiredFixedMemoryBytes();
    NativeTrackHost host;
    if (!require(filterBytes != 0U && vinylBytes != 0U &&
                 vinylRequirement.supported &&
                 host.prepare(8000U, 1U, fixedBytes + historyBytes + filterBytes + vinylBytes +
                                         vinylPrepareScratchBytes),
                 "reserve histories, both graph generations, and candidate prepare scratch"))
        return false;

    auto filter = std::make_unique<NativeFxGraph>();
    if (!require(filter->prepare(spec, host.candidateFxGraphBudgetBytes()) == NativeFxGraphResult::Ok &&
                 filter->configureSlot({NativeFxBusKind::Master, 0U}, 0U, 1U) ==
                     NativeFxGraphResult::Ok && filter->seal() == NativeFxGraphResult::Ok &&
                 filter->estimatedPermanentBytes() == filterBytes &&
                 host.stageFxGraph(filter) == NativeFxGraphResult::Ok,
                 "stage the first filter graph within the aggregate admission ceiling")) return false;

    constexpr std::uint32_t hostCallbackFrames = 4096U;
    std::array<float, static_cast<std::size_t>(hostCallbackFrames) * 2U> output{};
    if (!require(host.processInputBlock(nullptr, 1U, output.data(), 128U) &&
                 host.status().preparedFxGraphBytes == filterBytes,
                 "activate the first graph and clear its zero-latency transition")) return false;

    auto vinyl = std::make_unique<NativeFxGraph>();
    const auto beforeCandidate = host.candidateFxGraphBudgetBytes();
    const auto prepareResult = vinyl->prepare(spec, beforeCandidate);
    const auto configureResult = vinyl->configureSlot({NativeFxBusKind::Master, 0U}, 0U, 53U);
    const auto sealResult = vinyl->seal();
    const auto candidatePermanentBytes = vinyl->estimatedPermanentBytes();
    const auto stageResult = host.stageFxGraph(vinyl);
    if (beforeCandidate != vinylBytes + vinylPrepareScratchBytes ||
        prepareResult != NativeFxGraphResult::Ok ||
        configureResult != NativeFxGraphResult::Ok || sealResult != NativeFxGraphResult::Ok ||
        candidatePermanentBytes != vinylBytes || stageResult != NativeFxGraphResult::Ok)
        std::cerr << "retirement admission: before=" << beforeCandidate
                  << " bytes=" << vinylBytes << " scratch=" << vinylPrepareScratchBytes
                  << " prepare=" << static_cast<unsigned>(prepareResult)
                  << " configure=" << static_cast<unsigned>(configureResult)
                  << " seal=" << static_cast<unsigned>(sealResult)
                  << " actual=" << candidatePermanentBytes
                  << " stage=" << static_cast<unsigned>(stageResult) << '\n';
    if (!require(beforeCandidate == vinylBytes + vinylPrepareScratchBytes &&
                 prepareResult == NativeFxGraphResult::Ok &&
                 configureResult == NativeFxGraphResult::Ok &&
                 sealResult == NativeFxGraphResult::Ok &&
                 candidatePermanentBytes == vinylBytes &&
                 stageResult == NativeFxGraphResult::Ok,
                 "admit the candidate only after reserving its peak alongside the active graph"))
        return false;

    const auto vinylWarmupFrames = fxStartupWarmupUpperBoundSamples(53U, spec).frames;
    const auto warmAndFadeFrames = static_cast<std::uint64_t>(vinylWarmupFrames) +
                                   kNativeFxGraphSwapCrossfadeFrames;
    const auto hostFrames = ((warmAndFadeFrames + hostCallbackFrames - 1U) /
                             hostCallbackFrames) * hostCallbackFrames;
    for (std::uint64_t offset = 0U; offset < hostFrames; offset += hostCallbackFrames) {
        if (!require(host.processInputBlock(nullptr, 1U, output.data(), hostCallbackFrames),
                     "process bounded software callbacks while Vinyl fills its full history"))
            return false;
    }
    if (!require(host.status().fxGraphGeneration == 2U,
                 "finish Vinyl's finite-history warmup and graph crossfade"))
        return false;
    auto duringRetirement = host.status();
    if (!require(duringRetirement.fxGraphGeneration == 2U &&
                 duringRetirement.preparedFxGraphBytes == filterBytes + vinylBytes &&
                 duringRetirement.candidateFxGraphBudgetBytes == 0U,
                 "keep the old generation's bytes resident and block admission before retirement"))
        return false;

    heapFrees.store(0U, std::memory_order_relaxed);
    countHeapOperations.store(true, std::memory_order_release);
    const auto reclaimed = host.reclaimRetiredFxGraph();
    countHeapOperations.store(false, std::memory_order_release);
    const auto frees = heapFrees.load(std::memory_order_relaxed);
    const auto afterReclaim = host.status();
    return require(reclaimed && frees > 0U &&
                   afterReclaim.preparedFxGraphBytes == vinylBytes &&
                   afterReclaim.candidateFxGraphBudgetBytes == filterBytes +
                       vinylPrepareScratchBytes,
                   "destroy the old graph before releasing its bytes back to candidate admission");
}

bool testGraphSwapRetiresOffCallbackAndCallbackAllocatesNothing() {
    std::unique_ptr<NativeFxGraph> first;
    if (!require(prepareEmptyGraph(first) &&
                 first->seal() == NativeFxGraphResult::Ok,
                 "prepare and seal the initial empty graph")) return false;
    NativeFxGraphExchange exchange;
    if (!require(exchange.stage(first) == NativeFxGraphResult::Ok, "stage initial graph")) return false;

    std::array<StereoFrame, 64U> input{};
    std::array<StereoFrame, 64U> track{};
    std::array<StereoFrame, 64U> send{};
    std::array<StereoFrame, 64U> master{};
    NativeFxGraphBlock block{};
    block.inputCapture = input.data();
    block.trackPlayback[0] = track.data();
    block.sendReturn = send.data();
    block.masterMix = master.data();
    if (!require(exchange.processBlock(block, 64U, 0U) == NativeFxGraphResult::Ok,
                 "activate the initial graph")) return false;
    if (!require(exchange.processBlock(block, 64U, 64U) == NativeFxGraphResult::Ok,
                 "complete the initial dry-to-graph fade before requesting a replacement")) return false;

    auto second = std::make_unique<NativeFxGraph>();
    if (!require(second->prepare({48000.0f, 64U, 2U}) == NativeFxGraphResult::Ok &&
                 configurePan(*second, {NativeFxBusKind::Track, 0U}, 1.0f) &&
                 second->seal() == NativeFxGraphResult::Ok &&
                 exchange.stage(second) == NativeFxGraphResult::Ok,
                 "prepare and stage a complete replacement graph off the callback")) return false;

    track.fill({0.2f, -0.1f});
    std::fill(input.begin(), input.end(), StereoFrame{});
    std::fill(send.begin(), send.end(), StereoFrame{});
    std::fill(master.begin(), master.end(), StereoFrame{});
    heapAllocations.store(0U, std::memory_order_relaxed);
    heapFrees.store(0U, std::memory_order_relaxed);
    countHeapOperations.store(true, std::memory_order_release);
    auto processOk = true;
    for (std::uint32_t callback = 0U; callback < 32U; ++callback) {
        processOk = processOk && exchange.processBlock(block, 64U, 128U + callback * 64U) ==
            NativeFxGraphResult::Ok;
    }
    countHeapOperations.store(false, std::memory_order_release);
    if (!require(processOk, "process block callbacks while the graph swaps at a boundary")) return false;
    if (!require(heapAllocations.load(std::memory_order_relaxed) == 0U &&
                 heapFrees.load(std::memory_order_relaxed) == 0U,
                 "audio processing and graph replacement neither allocate nor destroy objects")) return false;
    if (!require(exchange.reclaimRetired(),
                 "destroy the previous graph on the control thread before reopening admission")) return false;
    auto blockedCandidate = std::make_unique<NativeFxGraph>();
    if (!require(blockedCandidate->prepare({48000.0f, 64U, 2U}) == NativeFxGraphResult::Ok &&
                 blockedCandidate->seal() == NativeFxGraphResult::Ok &&
                 exchange.stage(blockedCandidate) == NativeFxGraphResult::Ok,
                 "permit the next swap after control reclaims the prior graph")) return false;
    return require(exchange.processBlock(block, 64U, 128U + 32U * 64U) == NativeFxGraphResult::Ok,
                   "activate the follow-up graph without retiring in the callback");
}

} // namespace

int main() {
    const bool passed = testUnsupportedAndBusEligibilityFailClosed() &&
        testPreampSelectorsAreAppliedBeforeCandidatePrepare() &&
        testStartupWarmupQueriesAndPreampSampleRateBounds() &&
        testFiniteHistoryWarmupBoundsAndPreparedInstances() &&
        testEveryReadyProcessorHasPreparedAlignmentCoverageAtSupportedRates() &&
        testWetDryMixAlignsFixedLatencyAndRejectsVariableLatencyMix() &&
        testIndependentTrackStereoProcessors() && testInputFxIsPlacedBeforeRecordedHistory() &&
        testBoundedEventsAreTransactionalAndTimestamped() &&
        testFirstGraphInstallCrossfadesFromDry() &&
        testLatencyEffectTransitionsWarmBeforeFadingAndBoundedToneSteps() &&
        testSerialLatencyWarmupSumsSlotsAndTrackMasterPath() &&
        testGraphGenerationDiscardsOldFutureControls() &&
        testSlotReplacementPreflightIncludesOldProcessorState() &&
        testCoupledFxInitialAndAutomatedParametersAreTransactional() &&
        testNativeHostRunsInputAndTrackFxOnTheCorrectSideOfRecordingAndMix() &&
        testHostAggregateBudgetPreflightsCandidateAgainstHistoryAndActiveGraph() &&
        testRetiredGraphBytesStayReservedUntilControlThreadDestroysTheGraph() &&
        testGraphSwapRetiresOffCallbackAndCallbackAllocatesNothing();
    if (passed) std::cout << "Native prepared FX graph tests passed.\n";
    return passed ? 0 : 1;
}
