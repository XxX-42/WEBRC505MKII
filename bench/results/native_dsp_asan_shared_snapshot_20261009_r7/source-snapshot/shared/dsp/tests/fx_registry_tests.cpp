#include "webrc/dsp/fx_registry.hpp"

#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<unsigned> allocationCount{0};
int failures = 0;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}
} // namespace

void* operator new(std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1, std::memory_order_relaxed);
    if (void* memory = std::malloc(size == 0U ? 1U : size)) return memory;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    using namespace webrc::dsp;
    check(fxCatalogSize() == kFxCatalogSize, "catalog has the 53 stable Track FX entries");

    std::size_t inputCount = 0;
    std::size_t trackCount = 0;
    std::size_t implementedCount = 0;
    bool ordinalsStable = true;
    for (std::size_t i = 0; i < fxCatalogSize(); ++i) {
        const auto& descriptor = fxCatalogData()[i];
        ordinalsStable = ordinalsStable && descriptor.ordinal == i + 1U &&
                         findFxByOrdinal(descriptor.ordinal) == &descriptor &&
                         findFxById(descriptor.id) == &descriptor;
        inputCount += descriptor.inputFx ? 1U : 0U;
        trackCount += descriptor.trackFx ? 1U : 0U;
        implementedCount += descriptor.readiness == FxReadiness::ProcessorAvailable ? 1U : 0U;
        check(!descriptor.officialParameterContractValidated,
              "runtime reconstruction does not claim extracted official parameters");
    }
    check(ordinalsStable, "catalog ordinal and ID lookup are stable");
    check(inputCount == kInputFxCount && trackCount == kTrackFxCount,
          "catalog preserves 49 Input and 53 Track routing counts");
    check(implementedCount == 8U, "only the implemented filter, phaser, dynamics, EQ, delay, and reverb processors are advertised ready");
    check(findFxByOrdinal(0U) == nullptr && findFxByOrdinal(54U) == nullptr &&
          findFxById("rc505mkii.fx.not-real") == nullptr,
          "unknown identifiers do not resolve to a fallback processor");

    std::size_t parameterCount = 0;
    const auto* parameters = fxParameterDescriptors(1U, parameterCount);
    check(parameters != nullptr && parameterCount == 4U &&
          parameters[0].origin == FxParameterOrigin::ReconstructionSafeBounds,
          "filter parameters expose units, bounds, defaults, and provenance");
    parameterCount = 99U;
    check(fxParameterDescriptors(48U, parameterCount) == nullptr && parameterCount == 0U,
          "metadata-only processors publish no executable controls");

    check(createFxProcessor(48U) == nullptr, "metadata-only gate reverb does not silently fall back");
    const ProcessSpec spec{48000.0f, 64U, 2U};
    const auto filterMemory = fxMemoryRequirement(1U, spec);
    const auto delayMemory = fxMemoryRequirement(36U, spec);
    const auto reverbMemory = fxMemoryRequirement(47U, spec);
    check(filterMemory.supported && filterMemory.objectBytes > 0U &&
          filterMemory.persistentPreparedBytes == 0U && filterMemory.prepareScratchBytes == 0U,
          "fixed-state filter memory can be reserved before its factory and prepare call");
    check(delayMemory.supported && delayMemory.persistentPreparedBytes > 0U &&
          delayMemory.prepareScratchBytes == delayMemory.persistentPreparedBytes &&
          delayMemory.peakBytes() >= delayMemory.objectBytes + 2U * delayMemory.persistentPreparedBytes,
          "delay memory requirement accounts for live and transactional candidate rings");
    check(reverbMemory.supported && reverbMemory.persistentPreparedBytes > 0U &&
          reverbMemory.prepareScratchBytes == reverbMemory.persistentPreparedBytes,
          "FDN memory requirement includes prepared storage and replacement peak");
    check(!fxMemoryRequirement(48U, spec).supported &&
          !fxMemoryRequirement(47U, ProcessSpec{48000.0f,64U,1U}).supported &&
          !fxMemoryRequirement(36U, ProcessSpec{std::numeric_limits<float>::quiet_NaN(),64U,2U}).supported,
          "unsupported processor/spec combinations have no reserveable memory claim");
    std::array<float, 64> left{};
    std::array<float, 64> right{};
    std::array<float, 64> outLeft{};
    std::array<float, 64> outRight{};
    left[0] = 1.0f;
    right[0] = -0.75f;
    for (std::uint16_t ordinal = 1U; ordinal <= 3U; ++ordinal) {
        auto processor = createFxProcessor(ordinal);
        check(processor != nullptr && processor->ordinal() == ordinal,
              "implemented filter factory returns its exact stable kind");
        if (!processor) continue;
        check(processor->prepare(spec), "filter adapter prepares two planar channels");
        check(processor->fixedLatencySamples() == 0 && processor->latencyIsFrequencyDependent(),
              "filter reports zero inserted frames and phase-dependent group delay");
        check(processor->setParameter(FxParameterId::SmoothingMs, 0.0f) &&
              processor->setParameter(FxParameterId::FrequencyHz, 1700.0f) &&
              processor->setParameter(FxParameterId::Q, 0.9f) &&
              processor->setParameter(FxParameterId::Mix, 1.0f),
              "filter accepts bounded reconstruction controls");
        const float* input[] = {left.data(), right.data()};
        float* output[] = {outLeft.data(), outRight.data()};
        check(processor->processBlock(input, output, 2U, 64U), "filter renders 64 stereo frames");
        bool finite = true;
        double energy = 0.0;
        for (std::size_t i = 0; i < outLeft.size(); ++i) {
            finite = finite && std::isfinite(outLeft[i]) && std::isfinite(outRight[i]);
            energy += static_cast<double>(outLeft[i]) * outLeft[i];
        }
        check(finite && energy > 1.0e-4, "filter output is finite and carries impulse energy");
        check(!processor->setParameter(FxParameterId::FrequencyHz,
                                        std::numeric_limits<float>::quiet_NaN()) &&
              !processor->setParameter(FxParameterId::Q, 50.0f),
              "filter rejects non-finite and out-of-safe-range parameters");
    }

    for (const auto ordinal : {4U,25U,26U,36U,47U}) {
        auto processor = createFxProcessor(static_cast<std::uint16_t>(ordinal));
        check(processor != nullptr && processor->prepare(spec),
              "priority FX processor prepares in its native planar route");
        if (!processor) continue;
        check(processor->latencyIsFrequencyDependent() == (ordinal == 4U || ordinal == 26U || ordinal == 47U),
              "priority FX declares phase/group-delay or variable-delay model");
        if (ordinal == 36U) check(processor->fixedLatencySamples() == -1,
                                  "delay reports parameter-dependent rather than fixed latency");
        if (ordinal == 36U) check(processor->latencyModel() == FxLatencyModel::VariableDelay,
                                  "delay exposes its variable-latency model to graph admission");
        const float* input[] = {left.data(), right.data()};
        float* output[] = {outLeft.data(), outRight.data()};
        check(processor->processBlock(input, output, 2U, 64U),
              "priority FX processes stereo frames without an alternate fallback");
        bool finite = true;
        double energy = 0.0;
        for (std::size_t i = 0; i < outLeft.size(); ++i) {
            finite = finite && std::isfinite(outLeft[i]) && std::isfinite(outRight[i]);
            energy += static_cast<double>(outLeft[i]) * outLeft[i];
        }
        check(finite && energy > 1.0e-5, "priority FX produces finite nonzero stereo response");
        std::size_t count = 0;
        const auto* schema = fxParameterDescriptors(static_cast<std::uint16_t>(ordinal), count);
        check(schema != nullptr && count > 0U,
              "priority FX exposes an explicit reconstruction control schema");
        if (schema) {
            bool defaultsAccepted = true;
            for (std::size_t i = 0; i < count; ++i)
                defaultsAccepted = defaultsAccepted && processor->validParameter(schema[i].id, schema[i].defaultValue);
            check(defaultsAccepted, "every published reconstructed default is accepted by its processor");
        }
    }

    auto failedReprepare = createFxProcessor(1U);
    auto reprepareReference = createFxProcessor(1U);
    check(failedReprepare && reprepareReference && failedReprepare->prepare(spec) && reprepareReference->prepare(spec),
          "failed-reprepare preservation pair prepares");
    if (failedReprepare && reprepareReference) {
        check(failedReprepare->setParameter(FxParameterId::SmoothingMs, 0.0f) &&
              reprepareReference->setParameter(FxParameterId::SmoothingMs, 0.0f) &&
              failedReprepare->setParameter(FxParameterId::FrequencyHz, 17000.0f) &&
              reprepareReference->setParameter(FxParameterId::FrequencyHz, 17000.0f),
              "filter pair share a valid high-frequency state");
        check(!failedReprepare->prepare(ProcessSpec{8000.0f,64U,2U}),
              "reprepare rejects a frequency above the candidate Nyquist limit");
        std::array<float,64> aL{},aR{},bL{},bR{};
        const float* input[] = {left.data(),right.data()};
        float* aOut[] = {aL.data(),aR.data()};
        float* bOut[] = {bL.data(),bR.data()};
        check(failedReprepare->processBlock(input,aOut,2U,64U) &&
              reprepareReference->processBlock(input,bOut,2U,64U) && aL == bL && aR == bR,
              "failed filter reprepare preserves its previous active spec and DSP state");
    }

    auto eqRejectedBatch = createFxProcessor(26U);
    auto eqReference = createFxProcessor(26U);
    check(eqRejectedBatch && eqReference && eqRejectedBatch->prepare(spec) && eqReference->prepare(spec),
          "EQ coupled-parameter batch preservation pair prepares");
    if (eqRejectedBatch && eqReference) {
        check(eqRejectedBatch->setParameter(FxParameterId::SmoothingMs, 0.0f) &&
              eqReference->setParameter(FxParameterId::SmoothingMs, 0.0f),
              "EQ coupled-parameter preservation pair starts without ramps");
        const std::array<FxParameterEvent, 2> coupledInvalid{{
            {0U, FxParameterId::EqLowGainDb, 18.0f},
            {32U, FxParameterId::EqLowSlope, 1.5f},
        }};
        std::array<float,64> rejectedEqL{}, rejectedEqR{};
        rejectedEqL.fill(-99.0f);
        rejectedEqR.fill(-99.0f);
        float* rejectedEqOut[] = {rejectedEqL.data(),rejectedEqR.data()};
        const float* eqInput[] = {left.data(),right.data()};
        check(!eqRejectedBatch->processBlockWithEvents(eqInput,rejectedEqOut,2U,64U,
                                                        coupledInvalid.data(),coupledInvalid.size()),
              "invalid late shelf slope rejects the coupled EQ batch before its earlier gain event");
        check(rejectedEqL[0] == -99.0f && rejectedEqR[0] == -99.0f,
              "rejected coupled EQ batch leaves every output sample untouched");
        std::array<float,64> changedStateL{}, changedStateR{}, referenceStateL{}, referenceStateR{};
        float* changedStateOut[] = {changedStateL.data(),changedStateR.data()};
        float* referenceStateOut[] = {referenceStateL.data(),referenceStateR.data()};
        check(eqRejectedBatch->processBlock(eqInput,changedStateOut,2U,64U) &&
              eqReference->processBlock(eqInput,referenceStateOut,2U,64U) &&
              changedStateL == referenceStateL && changedStateR == referenceStateR,
              "rejected coupled EQ batch preserves coefficients and complete subsequent PCM state");
    }

    auto scheduled = createFxProcessor(1U);
    check(scheduled && scheduled->prepare(spec), "scheduled filter prepares");
    if (scheduled) {
        check(scheduled->setParameter(FxParameterId::SmoothingMs, 0.0f),
              "scheduled filter starts with immediate test controls");
        std::array<FxParameterEvent, 3> events{{
            {0U, FxParameterId::FrequencyHz, 500.0f},
            {32U, FxParameterId::FrequencyHz, 8000.0f},
            {32U, FxParameterId::Mix, 0.0f},
        }};
        const float* input[] = {left.data(), right.data()};
        float* output[] = {outLeft.data(), outRight.data()};
        check(scheduled->processBlockWithEvents(input, output, 2U, 64U,
                                                 events.data(), events.size()),
              "sample-offset control events split processing on the audio owner");
        const std::array<FxParameterEvent, 2> invalid{{
            {0U, FxParameterId::Mix, 0.25f},
            {40U, FxParameterId::Q, 50.0f},
        }};
        check(!scheduled->processBlockWithEvents(input, output, 2U, 64U,
                                                  invalid.data(), invalid.size()),
              "invalid event batches are rejected before any state mutation");
        const std::array<FxParameterEvent, 2> unordered{{
            {40U, FxParameterId::Mix, 0.5f},
            {20U, FxParameterId::Mix, 0.75f},
        }};
        check(!scheduled->processBlockWithEvents(input, output, 2U, 64U,
                                                  unordered.data(), unordered.size()),
              "unsorted event batches are rejected");
    }

    auto direct = createFxProcessor(1U);
    auto eventless = createFxProcessor(1U);
    check(direct && eventless && direct->prepare(spec) && eventless->prepare(spec),
          "direct and eventless equivalence pair prepares");
    if (direct && eventless) {
        std::array<float, 64> directLeft{};
        std::array<float, 64> directRight{};
        std::array<float, 64> eventlessLeft{};
        std::array<float, 64> eventlessRight{};
        float* directOut[] = {directLeft.data(), directRight.data()};
        float* eventlessOut[] = {eventlessLeft.data(), eventlessRight.data()};
        const float* input[] = {left.data(), right.data()};
        check(direct->processBlock(input, directOut, 2U, 64U) &&
              eventless->processBlockWithEvents(input, eventlessOut, 2U, 64U, nullptr, 0U),
              "empty-event scheduling follows exactly one direct block path");
        check(directLeft == eventlessLeft && directRight == eventlessRight,
              "empty-event processing is bit-identical to direct processing");

        std::array<float, 64> rejectedLeft{};
        std::array<float, 64> rejectedRight{};
        rejectedLeft.fill(-99.0f);
        rejectedRight.fill(-99.0f);
        float* rejectedOut[] = {rejectedLeft.data(), rejectedRight.data()};
        const FxParameterEvent invalidEvent{0U, FxParameterId::Q, 50.0f};
        check(!eventless->processBlockWithEvents(input, rejectedOut, 2U, 64U,
                                                  &invalidEvent, 1U),
              "invalid parameter event is rejected before processing starts");
        check(rejectedLeft[0] == -99.0f && rejectedRight[0] == -99.0f,
              "rejected parameter event leaves output untouched");
        check(direct->processBlock(input, directOut, 2U, 64U) &&
              eventless->processBlock(input, eventlessOut, 2U, 64U) &&
              directLeft == eventlessLeft && directRight == eventlessRight,
              "rejected parameter event leaves filter history unchanged");
        const FxParameterEvent validEvent{0U, FxParameterId::Mix, 0.25f};
        check(!eventless->processBlockWithEvents(input, rejectedOut, 2U, 65U,
                                                  &validEvent, 1U),
              "whole oversized block rejects before applying an offset-zero event");
        check(rejectedLeft[0] == -99.0f && rejectedRight[0] == -99.0f,
              "oversized-block rejection leaves sentinel output unchanged");
        check(direct->processBlock(input, directOut, 2U, 64U) &&
              eventless->processBlock(input, eventlessOut, 2U, 64U) &&
              directLeft == eventlessLeft && directRight == eventlessRight,
              "oversized-block rejection leaves filter history unchanged");
        check(!eventless->processBlockWithEvents(input, rejectedOut, 1U, 64U,
                                                  &validEvent, 1U) &&
              rejectedLeft[0] == -99.0f && rejectedRight[0] == -99.0f,
              "wrong-channel request rejects before applying a valid event or touching output");
        auto unprepared = createFxProcessor(1U);
        check(unprepared && !unprepared->processBlockWithEvents(input, rejectedOut, 2U, 64U,
                                                                 &validEvent, 1U) &&
              rejectedLeft[0] == -99.0f && rejectedRight[0] == -99.0f,
              "unprepared processor rejects event block without mutating caller output");
    }

    for (const auto ordinal : {1U,4U,25U,26U,36U,47U}) {
        auto noAlloc = createFxProcessor(static_cast<std::uint16_t>(ordinal));
        check(noAlloc && noAlloc->prepare(spec), "allocation probe adapter prepares outside the callback");
        if (!noAlloc) continue;
        FxParameterEvent event{32U, FxParameterId::Mix, 0.6f};
        if (ordinal == 1U) event = {32U,FxParameterId::FrequencyHz,3200.0f};
        else if (ordinal == 4U) event = {32U,FxParameterId::RateHz,0.8f};
        else if (ordinal == 25U) event = {32U,FxParameterId::ThresholdDb,-30.0f};
        else if (ordinal == 26U) event = {32U,FxParameterId::EqHighGainDb,3.0f};
        else if (ordinal == 36U) event = {32U,FxParameterId::Feedback,0.5f};
        else if (ordinal == 47U) event = {32U,FxParameterId::Wet,0.5f};
        const float* input[] = {left.data(), right.data()};
        float* output[] = {outLeft.data(), outRight.data()};
        allocationCount.store(0U, std::memory_order_relaxed);
        countAllocations.store(true, std::memory_order_relaxed);
        bool success = true;
        for (int block = 0; block < 8; ++block) {
            success = success && noAlloc->processBlockWithEvents(
                input, output, 2U, 64U, block == 0 ? &event : nullptr, block == 0 ? 1U : 0U);
        }
        countAllocations.store(false, std::memory_order_relaxed);
        check(success && allocationCount.load(std::memory_order_relaxed) == 0U,
              "adapter scheduled processing allocates nothing over repeated callbacks");
    }

    if (failures != 0) {
        std::fprintf(stderr, "FX registry tests failed: %d\n", failures);
        return 1;
    }
    std::puts("FX registry tests passed.");
    return 0;
}
