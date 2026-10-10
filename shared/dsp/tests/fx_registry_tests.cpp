#include "webrc/dsp/fx_registry.hpp"
#include "webrc/dsp/performance_fx.hpp"
#include "webrc/dsp/modulation_fx.hpp"

#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <new>
#include <utility>

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
    check(implementedCount == 53U, "only processor-backed entries in the tested 53-kind factory are advertised ready");
    check(findFxByOrdinal(0U) == nullptr && findFxByOrdinal(54U) == nullptr &&
          findFxById("rc505mkii.fx.not-real") == nullptr,
          "unknown identifiers do not resolve to a fallback processor");

    std::size_t parameterCount = 0;
    const auto* parameters = fxParameterDescriptors(1U, parameterCount);
    check(parameters != nullptr && parameterCount == 4U &&
          parameters[0].origin == FxParameterOrigin::ReconstructionSafeBounds,
          "filter parameters expose units, bounds, defaults, and provenance");
    check(static_cast<std::uint16_t>(FxParameterId::SynthFrequencyMacro) == 103U &&
          static_cast<std::uint16_t>(FxParameterId::PatternIndex) == 124U,
          "musical runtime parameter IDs occupy the agreed stable 103-124 range");

    const ProcessSpec pitchMemorySpec{48000.0f, 128U, 2U};
    const FxParameterEvent livePolySelector{0U, FxParameterId::PitchProfile, 1.0f};
    const FxParameterEvent hqSelector{0U, FxParameterId::PitchProfile, 2.0f};
    const FxParameterEvent invalidHrmMonoSelector{0U, FxParameterId::PitchProfile, 0.0f};
    const FxParameterEvent lateSelector{1U, FxParameterId::PitchProfile, 1.0f};
    const FxParameterEvent duplicateSelectors[] = {livePolySelector, livePolySelector};
    const auto manualDefaultMemory = fxMemoryRequirementForParameters(
        18U, pitchMemorySpec, nullptr, 0U);
    const auto manualPolyMemory = fxMemoryRequirementForParameters(
        18U, pitchMemorySpec, &livePolySelector, 1U);
    const auto manualHqMemory = fxMemoryRequirementForParameters(
        18U, pitchMemorySpec, &hqSelector, 1U);
    const auto manualWorstMemory = fxMemoryRequirement(18U, pitchMemorySpec);
    constexpr std::uint64_t wasmFxLedgerBytes = 48U * 1024U * 1024U;
    check(manualDefaultMemory.supported && manualPolyMemory.supported &&
          manualDefaultMemory.peakBytes() == manualPolyMemory.peakBytes() &&
          manualDefaultMemory.peakBytes() <= wasmFxLedgerBytes,
          "HRM MANUAL descriptor default resolves to the admitted LIVE_POLY prepared profile");
    check(manualHqMemory.supported && manualWorstMemory.supported &&
          manualHqMemory.peakBytes() == manualWorstMemory.peakBytes() &&
          manualHqMemory.peakBytes() > manualDefaultMemory.peakBytes() &&
          manualHqMemory.peakBytes() <= wasmFxLedgerBytes,
          "explicit HQ_RENDER remains the larger profile and fits the unchanged 48 MiB ledger after live-only scratch reduction");
    check(!fxMemoryRequirementForParameters(18U, pitchMemorySpec,
              &invalidHrmMonoSelector, 1U).supported &&
          !fxMemoryRequirementForParameters(18U, pitchMemorySpec,
              &lateSelector, 1U).supported &&
          !fxMemoryRequirementForParameters(18U, pitchMemorySpec,
              duplicateSelectors, 2U).supported &&
          !fxMemoryRequirementForParameters(18U, pitchMemorySpec, nullptr, 1U).supported,
          "invalid, late, duplicate, and malformed profile preflight fail closed");
    const auto manualDefaultWarmup = fxStartupWarmupUpperBoundSamplesForParameters(
        18U, pitchMemorySpec, nullptr, 0U);
    const auto manualPolyWarmup = fxStartupWarmupUpperBoundSamplesForParameters(
        18U, pitchMemorySpec, &livePolySelector, 1U);
    const auto manualHqWarmup = fxStartupWarmupUpperBoundSamplesForParameters(
        18U, pitchMemorySpec, &hqSelector, 1U);
    const auto manualWorstWarmup = fxStartupWarmupUpperBoundSamples(18U, pitchMemorySpec);
    check(manualDefaultWarmup.supported && manualPolyWarmup.supported &&
          manualDefaultWarmup.frames == manualPolyWarmup.frames &&
          manualHqWarmup.supported && manualWorstWarmup.supported &&
          manualHqWarmup.frames == manualWorstWarmup.frames &&
          manualHqWarmup.frames > manualDefaultWarmup.frames,
          "selected-profile startup history follows the same default and explicit selectors as memory");
    for (const auto ordinal : {14U, 15U}) {
        const auto defaultMemory = fxMemoryRequirementForParameters(
            static_cast<std::uint16_t>(ordinal), pitchMemorySpec, nullptr, 0U);
        const auto defaultWarmup = fxStartupWarmupUpperBoundSamplesForParameters(
            static_cast<std::uint16_t>(ordinal), pitchMemorySpec, nullptr, 0U);
        check(defaultMemory.supported && defaultWarmup.supported,
              "transpose and pitch bend resolve their descriptor-selected preflight profiles");
    }
    const std::array<std::pair<std::uint16_t, std::size_t>, 9> musicalDescriptorCounts{{
        {6U,5U},{10U,3U},{12U,8U},{16U,5U},{17U,7U},
        {19U,8U},{20U,5U},{21U,6U},{22U,9U},
    }};
    bool musicalDescriptorsValid = true;
    for (const auto& expected : musicalDescriptorCounts) {
        std::size_t actualCount = 0U;
        const auto* actual = fxParameterDescriptors(expected.first, actualCount);
        musicalDescriptorsValid = musicalDescriptorsValid && actual != nullptr &&
                                  actualCount == expected.second;
        for (std::size_t i = 0U; actual && i < actualCount; ++i)
            musicalDescriptorsValid = musicalDescriptorsValid &&
                actual[i].origin == FxParameterOrigin::ReconstructionSafeBounds;
    }
    check(musicalDescriptorsValid,
          "musical adapter descriptors expose only explicitly local reconstruction controls");
    parameterCount = 99U;
    check(fxParameterDescriptors(24U, parameterCount) != nullptr && parameterCount == 5U,
          "ordinal 24 publishes a concrete reconstruction control schema");
    check(static_cast<std::uint16_t>(FxParameterId::PitchProfile) == 125U &&
          static_cast<std::uint16_t>(FxParameterId::HarmonyVoice2Pan) == 135U,
          "pitch runtime controls use the stable global parameter ID range");
    check(fxParameterDescriptors(14U, parameterCount) != nullptr && parameterCount == 6U &&
          fxParameterDescriptors(15U, parameterCount) != nullptr && parameterCount == 5U &&
          fxParameterDescriptors(18U, parameterCount) != nullptr && parameterCount == 10U,
          "TRANSPOSE, PITCH BEND and HRM MANUAL expose distinct parameter schemas");
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
    const auto scatterMemory = fxMemoryRequirement(50U, spec);
    const auto repeatMemory = fxMemoryRequirement(51U, spec);
    const auto shiftMemory = fxMemoryRequirement(52U, spec);
    const auto vinylMemory = fxMemoryRequirement(53U, spec);
    const std::array<std::uint16_t, 9U> musicalOrdinals{{6U,10U,12U,16U,17U,19U,20U,21U,22U}};
    bool musicalMemorySupported = true;
    for (const auto ordinal : musicalOrdinals) {
        const auto memory = fxMemoryRequirement(ordinal, spec);
        musicalMemorySupported = musicalMemorySupported && memory.supported &&
            memory.objectBytes >= sizeof(void*) && memory.persistentPreparedBytes > 0U;
    }
    check(musicalMemorySupported,
          "nine musical factory entries expose positive prepared-memory reservations");
    for (const auto ordinal : {7U,9U,29U,30U,32U}) {
        const auto memory = fxMemoryRequirement(static_cast<std::uint16_t>(ordinal), spec);
        check(memory.supported && memory.objectBytes > 0U &&
              memory.persistentPreparedBytes == spec.maxBlockFrames * sizeof(StereoFrame) &&
              memory.prepareScratchBytes == memory.persistentPreparedBytes,
              "modulation registry reserves object and both stereo scratch buffers before prepare");
    }
    check(!fxMemoryRequirement(54U, spec).supported &&
          !fxMemoryRequirement(47U, ProcessSpec{48000.0f,64U,1U}).supported &&
          !fxMemoryRequirement(36U, ProcessSpec{std::numeric_limits<float>::quiet_NaN(),64U,2U}).supported,
          "unsupported processor/spec combinations have no reserveable memory claim");
    std::array<float, 64> left{};
    std::array<float, 64> right{};
    std::array<float, 64> outLeft{};
    std::array<float, 64> outRight{};
    left[0] = 1.0f;
    right[0] = -0.75f;

    bool musicalFactoryPass = true;
    for (const auto ordinal : musicalOrdinals) {
        auto processor = createFxProcessor(ordinal);
        std::size_t descriptorCount = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal, descriptorCount);
        const auto startup = fxStartupWarmupUpperBoundSamples(ordinal, spec);
        const auto alignment = fxAlignmentUpperBoundSamples(ordinal, spec);
        bool casePass = processor && processor->ordinal() == ordinal &&
            descriptors != nullptr && descriptorCount > 0U && startup.supported &&
            alignment.supported && processor->prepare(spec);
        for (std::size_t index = 0U; casePass && index < descriptorCount; ++index)
            casePass = descriptors[index].origin == FxParameterOrigin::ReconstructionSafeBounds &&
                       processor->validParameter(descriptors[index].id,
                                                 descriptors[index].defaultValue);
        if (casePass) {
            std::array<float, 64U> carrierLeft{};
            std::array<float, 64U> carrierRight{};
            const float* processInput[]{left.data(), right.data()};
            float* processOutput[]{outLeft.data(), outRight.data()};
            FxProcessContext context{};
            if (ordinal == 20U) {
                context.carrierLeft = carrierLeft.data();
                context.carrierRight = carrierRight.data();
                context.carrierFrames = 64U;
                context.carrierChannels = 2U;
            }
            casePass = processor->processBlockWithContext(processInput, processOutput,
                2U, 64U, nullptr, 0U, context);
            for (std::size_t frame = 0U; casePass && frame < 64U; ++frame)
                casePass = std::isfinite(outLeft[frame]) && std::isfinite(outRight[frame]);
            const auto fixedLatency = processor->fixedLatencySamples();
            casePass = casePass && processor->startupWarmupFrames() <= startup.frames &&
                (fixedLatency <= 0 || static_cast<std::uint32_t>(fixedLatency) <= alignment.frames);
        }
        musicalFactoryPass = musicalFactoryPass && casePass;
    }
    check(musicalFactoryPass,
          "all nine musical ordinals create, reserve, prepare, describe, report startup and process their real route");

    auto contextActual = createFxProcessor(1U);
    auto contextReference = createFxProcessor(1U);
    check(contextActual && contextReference && contextActual->prepare(spec) &&
          contextReference->prepare(spec), "context fallback test prepares paired ordinary processors");
    if (contextActual && contextReference) {
        std::array<float, 64> contextLeft{};
        std::array<float, 64> contextRight{};
        std::array<float, 64> carrierLeft{};
        std::array<float, 64> carrierRight{};
        std::array<float, 64> actualOutLeft{};
        std::array<float, 64> actualOutRight{};
        std::array<float, 64> referenceOutLeft{};
        std::array<float, 64> referenceOutRight{};
        for (std::size_t i = 0U; i < contextLeft.size(); ++i) {
            contextLeft[i] = 0.2f * std::sin(static_cast<float>(i) * 0.11f);
            contextRight[i] = -0.15f * std::cos(static_cast<float>(i) * 0.07f);
            carrierLeft[i] = 0.4f;
            carrierRight[i] = -0.3f;
            actualOutLeft[i] = actualOutRight[i] = 123.0f;
        }
        const float* contextInput[]{contextLeft.data(), contextRight.data()};
        float* actualOutput[]{actualOutLeft.data(), actualOutRight.data()};
        float* referenceOutput[]{referenceOutLeft.data(), referenceOutRight.data()};
        FxMidiEvent midi{};
        FxProcessContext midiContext{};
        midiContext.midiEvents = &midi;
        midiContext.midiEventCount = 1U;
        check(!contextActual->processBlockWithContext(contextInput, actualOutput, 2U, 64U,
                                                      nullptr, 0U, midiContext) &&
              actualOutLeft[0] == 123.0f && actualOutRight[0] == 123.0f,
              "ordinary processor rejects MIDI sidecar before touching output");
        FxProcessContext carrierContext{};
        carrierContext.carrierLeft = carrierLeft.data();
        carrierContext.carrierRight = carrierRight.data();
        carrierContext.carrierFrames = 64U;
        carrierContext.carrierChannels = 2U;
        check(!contextActual->processBlockWithContext(contextInput, actualOutput, 2U, 64U,
                                                      nullptr, 0U, carrierContext) &&
              actualOutLeft[0] == 123.0f && actualOutRight[0] == 123.0f,
              "ordinary processor rejects carrier sidecar before touching output");
        const FxProcessContext emptyContext{};
        check(contextActual->processBlockWithContext(contextInput, actualOutput, 2U, 64U,
                                                     nullptr, 0U, emptyContext) &&
              contextReference->processBlock(contextInput, referenceOutput, 2U, 64U),
              "empty context delegates to the ordinary processor path");
        bool outputsMatch = true;
        for (std::size_t i = 0U; i < contextLeft.size(); ++i)
            outputsMatch = outputsMatch && actualOutLeft[i] == referenceOutLeft[i] &&
                           actualOutRight[i] == referenceOutRight[i];
        check(outputsMatch, "rejected sidecars leave ordinary DSP state unchanged");
    }

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

    for (const auto ordinal : {4U,5U,7U,8U,9U,11U,13U,14U,15U,18U,23U,24U,25U,26U,27U,28U,
                               29U,30U,31U,32U,33U,34U,35U,36U,37U,38U,39U,
                               40U,41U,42U,43U,44U,45U,46U,47U,48U,49U,
                               50U,51U,52U,53U}) {
        auto processor = createFxProcessor(static_cast<std::uint16_t>(ordinal));
        const bool prepared = processor != nullptr && processor->prepare(spec);
        if (!prepared) std::fprintf(stderr, "priority prepare diagnostic ordinal=%u\n", ordinal);
        check(prepared,
              "priority FX processor prepares in its native planar route");
        if (!processor) continue;
        check(processor->latencyIsFrequencyDependent() ==
                  (ordinal == 4U || ordinal == 8U || ordinal == 23U || ordinal == 24U ||
                   ordinal == 26U || ordinal == 31U || ordinal == 40U || ordinal == 47U),
              "priority FX declares phase/group-delay or variable-delay model");
        if (ordinal == 23U || ordinal == 24U || ordinal == 28U)
            check(processor->fixedLatencySamples() == (ordinal == 23U ? 86 : ordinal == 24U ? 0 : 4096),
                  "new amp, distortion and octave adapters report their fixed path timing");
        if (ordinal == 7U || ordinal == 9U || ordinal == 29U || ordinal == 30U || ordinal == 32U)
            check(processor->fixedLatencySamples() == 0 &&
                  processor->latencyModel() == FxLatencyModel::Fixed,
                  "modulation processors report zero inserted frame latency");
        if (ordinal == 36U || ordinal == 5U || ordinal == 33U || ordinal == 37U ||
            ordinal == 39U || ordinal == 46U)
            check(processor->fixedLatencySamples() == -1,
                  "delay-family processors report parameter-dependent rather than fabricated fixed latency");
        if (ordinal == 36U || ordinal == 5U || ordinal == 33U || ordinal == 37U ||
            ordinal == 39U || ordinal == 46U)
            check(processor->latencyModel() == FxLatencyModel::VariableDelay,
                  "delay-family processors expose variable wet-path timing to graph admission");
        if (ordinal >= 50U && ordinal <= 52U)
            check(processor->fixedLatencySamples() == -1 &&
                  processor->latencyModel() == FxLatencyModel::VariableDelay,
                  "beat-synchronous wet paths report variable latency rather than a fabricated fixed delay");
        if (ordinal == 53U)
            check(processor->fixedLatencySamples() == 960 &&
                  processor->latencyModel() == FxLatencyModel::Fixed,
                  "Vinyl Flick reports its 20ms buffering at 48kHz");
        const float* input[] = {left.data(), right.data()};
        float* output[] = {outLeft.data(), outRight.data()};
        bool finite = true;
        double energy = 0.0;
        // Vinyl Flick deliberately has 20 ms of look-back latency. Feed and
        // inspect 16 contiguous 64-frame callbacks so the initial impulse has
        // time to emerge; a one-block impulse check would incorrectly call its
        // valid delayed output silent.
        const bool modulationOrdinal = ordinal == 7U || ordinal == 9U || ordinal == 29U ||
                                       ordinal == 30U || ordinal == 32U;
        if (modulationOrdinal)
            check(processor->setParameter(FxParameterId::Active, 1.0f),
                  "modulation processor accepts its activation parameter");
        const bool addedFamilyOrdinal = ordinal == 5U || ordinal == 8U || ordinal == 11U ||
            ordinal == 13U || ordinal == 27U || ordinal == 31U || ordinal == 33U ||
            ordinal == 34U || ordinal == 35U || ordinal == 37U || ordinal == 38U ||
            ordinal == 39U || ordinal == 46U || ordinal == 48U || ordinal == 49U ||
            ordinal == 23U || ordinal == 24U || ordinal == 28U ||
            (ordinal >= 40U && ordinal <= 45U);
        if (addedFamilyOrdinal)
            check(processor->validParameter(FxParameterId::Active, 1.0f) &&
                  processor->setParameter(FxParameterId::Active, 1.0f),
                  "new family adapter accepts its explicit active control");
        const std::uint32_t callbacks = (ordinal == 53U || modulationOrdinal) ? 16U
            : addedFamilyOrdinal ? 128U : 1U;
        bool processed = true;
        for (std::uint32_t callback = 0U; callback < callbacks; ++callback) {
            processed = processed && processor->processBlock(input, output, 2U, 64U);
            for (std::size_t i = 0; i < outLeft.size(); ++i) {
                finite = finite && std::isfinite(outLeft[i]) && std::isfinite(outRight[i]);
                energy += static_cast<double>(outLeft[i]) * outLeft[i];
            }
        }
        check(processed, "priority FX processes stereo frames without an alternate fallback");
        if (!(finite && energy > 1.0e-5))
            std::fprintf(stderr, "FX ordinal %u produced finite=%d energy=%.9g\n", ordinal,
                         finite ? 1 : 0, energy);
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
        if (ordinal >= 50U && ordinal <= 53U) {
            const FxParameterEvent active{32U, FxParameterId::Active, 1.0f};
            check(processor->processBlockWithEvents(input, output, 2U, 64U, &active, 1U),
                  "track-only effect applies activation at the exact sample offset");
            check(!processor->validParameter(FxParameterId::SubdivisionBeats, 1.0f) || ordinal != 53U,
                  "Vinyl Flick does not advertise tempo-grid controls it cannot use");
            if (ordinal == 53U) {
                const FxParameterEvent unsupported{0U, FxParameterId::TempoBpm, 120.0f};
                std::array<float,64> untouchedL{}, untouchedR{};
                untouchedL.fill(-55.0f);
                untouchedR.fill(-55.0f);
                float* untouched[] = {untouchedL.data(), untouchedR.data()};
                check(!processor->processBlockWithEvents(input, untouched, 2U, 64U, &unsupported, 1U) &&
                      untouchedL[0] == -55.0f && untouchedR[0] == -55.0f,
                      "Vinyl Flick rejects irrelevant beat-grid controls before changing output");
            }
        }
    }

    for (const auto ordinal : {5U,8U,11U,13U,23U,24U,27U,28U,31U,33U,34U,35U,37U,
                               38U,39U,40U,41U,42U,43U,44U,45U,46U,48U,49U}) {
        const auto memory = fxMemoryRequirement(static_cast<std::uint16_t>(ordinal), spec);
        check(memory.supported && memory.objectBytes > 0U &&
              memory.persistentPreparedBytes > 0U && memory.prepareScratchBytes > 0U &&
              memory.peakBytes() >= memory.objectBytes + memory.persistentPreparedBytes +
                                    memory.prepareScratchBytes,
              "new FX family exposes persistent and transactional candidate memory before prepare");
    }

    const std::array<std::uint16_t,5> modulationOrdinals{{7U,9U,29U,30U,32U}};
    const std::array<FxParameterId,5> modulationControlIds{{
        FxParameterId::BitDepth, FxParameterId::Waveform, FxParameterId::Pan,
        FxParameterId::Pan, FxParameterId::Depth
    }};
    const std::array<float,5> modulationControlValues{{12.0f,2.0f,0.4f,-0.35f,0.8f}};
    for (std::size_t i = 0U; i < modulationOrdinals.size(); ++i) {
        auto processor = createFxProcessor(modulationOrdinals[i]);
        check(processor && processor->prepare(spec),
              "typed modulation catalog ordinal constructs and prepares its real C++ core");
        if (!processor) continue;
        const auto control = modulationControlIds[i];
        const auto value = modulationControlValues[i];
        check(processor->validParameter(control, value) && processor->setParameter(control, value),
              "typed modulation adapter maps a family-specific parameter to its DSP control");
        check(!processor->validParameter(FxParameterId::ShiftBeats, 1.0f) &&
              !processor->validParameter(FxParameterId::Q, 2.0f),
              "modulation adapter rejects unrelated parameters without fallback mapping");
        const FxParameterEvent invalid{0U, FxParameterId::ShiftBeats, 1.0f};
        std::array<float,64> sentinelL{}, sentinelR{};
        sentinelL.fill(-12.0f); sentinelR.fill(-12.0f);
        float* sentinel[] = {sentinelL.data(), sentinelR.data()};
        const float* input[] = {left.data(), right.data()};
        check(!processor->processBlockWithEvents(input, sentinel, 2U, 64U, &invalid, 1U) &&
              sentinelL[0] == -12.0f && sentinelR[0] == -12.0f,
              "invalid modulation event is rejected before PCM or queued parameter state changes");
    }

    auto boundedPerformance = createFxProcessor(50U);
    check(boundedPerformance && boundedPerformance->prepare(spec),
          "performance adapter prepares its fixed event and stereo scratch storage");
    if (boundedPerformance) {
        std::array<FxParameterEvent, PerformanceFxProcessor::kMaximumControlEventsPerBlock + 1U> tooMany{};
        for (auto& event : tooMany) event = {0U, FxParameterId::Active, 1.0f};
        std::array<float,64> untouchedL{}, untouchedR{};
        untouchedL.fill(-77.0f);
        untouchedR.fill(-77.0f);
        const float* input[] = {left.data(), right.data()};
        float* untouched[] = {untouchedL.data(), untouchedR.data()};
        check(!boundedPerformance->processBlockWithEvents(input, untouched, 2U, 64U,
                                                          tooMany.data(), tooMany.size()) &&
              untouchedL[0] == -77.0f && untouchedR[0] == -77.0f,
              "oversized performance event batches are rejected before processing or control mutation");

        allocationCount.store(0U, std::memory_order_relaxed);
        countAllocations.store(true, std::memory_order_release);
        bool processed = true;
        for (std::uint32_t block = 0U; block < 16U; ++block) {
            const FxParameterEvent event{16U, FxParameterId::Active, (block & 1U) ? 0.0f : 1.0f};
            processed = processed && boundedPerformance->processBlockWithEvents(
                input, untouched, 2U, 64U, &event, 1U);
        }
        countAllocations.store(false, std::memory_order_release);
        check(processed && allocationCount.load(std::memory_order_relaxed) == 0U,
              "repeated sample-offset automation and 64-frame performance processing allocate nothing");
    }

    auto preampA = createFxProcessor(23U);
    auto preampB = createFxProcessor(23U);
    check(preampA && preampB && preampA->isPrepareTimeParameter(FxParameterId::AmpModel) &&
          preampA->isPrepareTimeParameter(FxParameterId::SpeakerModel) &&
          !preampA->isPrepareTimeParameter(FxParameterId::Drive),
          "PREAMP selectors are distinguished from sample-rate control parameters");
    if (preampA && preampB) {
        check(preampA->validParameter(FxParameterId::AmpModel, 0.0f) &&
              preampA->validParameter(FxParameterId::AmpModel, 8.0f) &&
              !preampA->validParameter(FxParameterId::AmpModel, 1.5f) &&
              preampA->setParameter(FxParameterId::AmpModel, 0.0f) &&
              preampB->setParameter(FxParameterId::AmpModel, 8.0f),
              "PREAMP integer selector values are validated and staged before prepare");
        check(preampA->prepare(spec) && preampB->prepare(spec) &&
              !preampA->setParameter(FxParameterId::AmpModel, 8.0f),
              "PREAMP selector configuration is immutable after its inactive instance is prepared");
        check(preampA->setParameter(FxParameterId::Active, 1.0f) &&
              preampB->setParameter(FxParameterId::Active, 1.0f),
              "prepared PREAMP models accept normal sample-accurate controls");
        std::array<float,64> preInL{}, preInR{}, preOutAL{}, preOutAR{}, preOutBL{}, preOutBR{};
        const float* preInput[] = {preInL.data(),preInR.data()};
        float* preOutputA[] = {preOutAL.data(),preOutAR.data()};
        float* preOutputB[] = {preOutBL.data(),preOutBR.data()};
        bool preProcessed = true;
        bool modelChangedPcm = false;
        for (std::uint32_t block = 0U; block < 8U; ++block) {
            for (std::uint32_t frame = 0U; frame < 64U; ++frame) {
                const auto absoluteFrame = block * 64U + frame;
                const float sample = 0.2f * std::sin(2.0f * 3.14159265358979323846f *
                    997.0f * static_cast<float>(absoluteFrame) / spec.sampleRate);
                preInL[frame] = sample;
                preInR[frame] = -0.37f * sample;
            }
            preProcessed = preProcessed && preampA->processBlock(preInput,preOutputA,2U,64U) &&
                           preampB->processBlock(preInput,preOutputB,2U,64U);
            for (std::size_t frame = 0U; frame < 64U; ++frame)
                modelChangedPcm = modelChangedPcm || std::abs(preOutAL[frame] - preOutBL[frame]) > 1.0e-5f ||
                                  std::abs(preOutAR[frame] - preOutBR[frame]) > 1.0e-5f;
        }
        check(preProcessed && modelChangedPcm,
              "different staged PREAMP selector models produce distinct finite stereo PCM");
    }

    auto octaveModes = createFxProcessor(28U);
    auto octaveReference = createFxProcessor(28U);
    check(octaveModes && octaveReference && octaveModes->prepare(spec) && octaveReference->prepare(spec),
          "OCTAVE selector model prepares the real one/two/dual voice processor");
    if (octaveModes && octaveReference) {
        check(octaveModes->validParameter(FxParameterId::OctaveMode, 0.0f) &&
              octaveModes->validParameter(FxParameterId::OctaveMode, 2.0f) &&
              !octaveModes->validParameter(FxParameterId::OctaveMode, 1.5f) &&
              !octaveModes->validParameter(FxParameterId::Semitones, -24.0f),
              "OCTAVE factory exposes only the three discrete published voice modes");
        const std::array<FxParameterEvent,2U> invalidModeBatch{{
            {0U,FxParameterId::Active,1.0f}, {32U,FxParameterId::OctaveMode,1.5f}
        }};
        std::array<float,64U> sentinelL{},sentinelR{};
        sentinelL.fill(-31.0f); sentinelR.fill(-31.0f);
        const float* octaveInput[] = {left.data(),right.data()};
        float* sentinelOutput[] = {sentinelL.data(),sentinelR.data()};
        check(!octaveModes->processBlockWithEvents(octaveInput,sentinelOutput,2U,64U,
                                                    invalidModeBatch.data(),invalidModeBatch.size()) &&
              sentinelL[0] == -31.0f && sentinelR[0] == -31.0f,
              "invalid OCTAVE mode event rejects the complete event block before PCM changes");
        check(octaveModes->setParameter(FxParameterId::Active,1.0f) &&
              octaveReference->setParameter(FxParameterId::Active,1.0f) &&
              octaveReference->setParameter(FxParameterId::OctaveMode,2.0f),
              "OCTAVE mode is updated through the typed registry control");
        std::array<float,64U> modeAL{},modeAR{},modeBL{},modeBR{};
        float* modeOutA[] = {modeAL.data(),modeAR.data()};
        float* modeOutB[] = {modeBL.data(),modeBR.data()};
        bool modeProcessed = true;
        bool modeDifference = false;
        for (std::uint32_t block = 0U; block < 96U; ++block) {
            modeProcessed = modeProcessed && octaveModes->processBlock(octaveInput,modeOutA,2U,64U) &&
                            octaveReference->processBlock(octaveInput,modeOutB,2U,64U);
            for (std::size_t frame = 0U; frame < 64U; ++frame)
                modeDifference = modeDifference || std::abs(modeAL[frame] - modeBL[frame]) > 1.0e-5f ||
                                 std::abs(modeAR[frame] - modeBR[frame]) > 1.0e-5f;
        }
        check(modeProcessed && modeDifference,
              "dual-down-octave mode changes the prepared stereo output path");
    }

    const ProcessSpec lowRateSpec{8000.0f, 64U, 2U};
    const auto longShiftMemory = fxMemoryRequirement(52U, lowRateSpec);
    check(longShiftMemory.supported &&
          longShiftMemory.persistentPreparedBytes > 6U * 8000U * sizeof(StereoFrame),
          "BeatShift memory reservation covers its advertised six-second 20-BPM range");
    std::size_t shiftParameterCount = 0U;
    const auto* shiftParameters = fxParameterDescriptors(52U, shiftParameterCount);
    bool shiftDescriptorBounds = false;
    for (std::size_t i = 0U; shiftParameters && i < shiftParameterCount; ++i) {
        if (shiftParameters[i].id == FxParameterId::ShiftBeats) {
            shiftDescriptorBounds = shiftParameters[i].minimum == 0.0f &&
                                    shiftParameters[i].maximum == 2.0f;
        }
    }
    check(shiftDescriptorBounds,
          "causal BeatShift registry control exposes the supported 0-to-2 beat domain");

    auto shiftAdapter = createFxProcessor(52U);
    auto shiftReference = createFxProcessor(52U);
    check(shiftAdapter && shiftReference && shiftAdapter->prepare(lowRateSpec) &&
          shiftReference->prepare(lowRateSpec),
          "BeatShift registry and PCM reference prepare the seven-second history path");
    if (shiftAdapter && shiftReference) {
        check(shiftAdapter->validParameter(FxParameterId::ShiftBeats, 0.0f) &&
              shiftAdapter->validParameter(FxParameterId::ShiftBeats, 2.0f) &&
              !shiftAdapter->validParameter(FxParameterId::ShiftBeats, -0.5f) &&
              !shiftAdapter->validParameter(FxParameterId::ShiftBeats, 2.01f),
              "BeatShift rejects negative and out-of-range shifts at the registry boundary");
        check(!shiftAdapter->setParameter(FxParameterId::ShiftBeats, -0.5f),
              "BeatShift direct parameter update rejects a negative shift transactionally");

        std::array<float,64> zeroL{}, zeroR{}, rejectedL{}, rejectedR{};
        rejectedL.fill(-44.0f);
        rejectedR.fill(-44.0f);
        const float* zeroInput[] = {zeroL.data(),zeroR.data()};
        float* rejectedOutput[] = {rejectedL.data(),rejectedR.data()};
        const std::array<FxParameterEvent,2> invalidShiftBatch{{
            {0U,FxParameterId::TempoBpm,20.0f},
            {0U,FxParameterId::ShiftBeats,-0.5f},
        }};
        check(!shiftAdapter->processBlockWithEvents(zeroInput,rejectedOutput,2U,64U,
                                                     invalidShiftBatch.data(),invalidShiftBatch.size()) &&
              rejectedL[0] == -44.0f && rejectedR[0] == -44.0f,
              "negative BeatShift event batch is rejected before its earlier tempo event or output mutation");

        const auto configureShift = [](FxProcessor& processor) {
            return processor.setParameter(FxParameterId::TempoBpm,20.0f) &&
                   processor.setParameter(FxParameterId::SubdivisionBeats,1.0f) &&
                   processor.setParameter(FxParameterId::ShiftBeats,2.0f) &&
                   processor.setParameter(FxParameterId::Wet,1.0f) &&
                   processor.setParameter(FxParameterId::Active,1.0f);
        };
        check(configureShift(*shiftAdapter) && configureShift(*shiftReference),
              "BeatShift accepts a causal two-beat target at 20 BPM");
        std::array<float,64> shiftInL{}, shiftInR{}, shiftedOutL{}, shiftedOutR{}, referenceOutL{}, referenceOutR{};
        bool processedShift = true;
        bool shiftPcmIdentical = true;
        constexpr std::uint64_t expectedDelayedFrame = 6U * 8000U + 40U;
        float delayedLeft = 0.0f;
        float delayedRight = 0.0f;
        const float* shiftInput[] = {shiftInL.data(),shiftInR.data()};
        float* shiftOutput[] = {shiftedOutL.data(),shiftedOutR.data()};
        float* referenceOutput[] = {referenceOutL.data(),referenceOutR.data()};
        for (std::uint64_t callback = 0U; callback <= expectedDelayedFrame / 64U; ++callback) {
            shiftInL.fill(0.0f);
            shiftInR.fill(0.0f);
            if (callback == 0U) {
                shiftInL[0] = 1.0f;
                shiftInR[0] = -0.75f;
            }
            const bool a = shiftAdapter->processBlock(shiftInput,shiftOutput,2U,64U);
            const bool b = shiftReference->processBlock(shiftInput,referenceOutput,2U,64U);
            processedShift = processedShift && a && b;
            if (!a || !b) break;
            shiftPcmIdentical = shiftPcmIdentical && shiftedOutL == referenceOutL &&
                                shiftedOutR == referenceOutR;
            if (expectedDelayedFrame / 64U == callback) {
                const auto offset = static_cast<std::size_t>(expectedDelayedFrame % 64U);
                delayedLeft = shiftedOutL[offset];
                delayedRight = shiftedOutR[offset];
            }
        }
        check(processedShift && shiftPcmIdentical,
              "rejected BeatShift set/event leaves all subsequent PCM bit-identical to a clean processor");
        check(std::fabs(delayedLeft - 1.0f) < 1.0e-3f &&
              std::fabs(delayedRight + 0.75f) < 1.0e-3f,
              "20-BPM two-beat BeatShift produces the stereo impulse after its full six-second delay");
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

    for (const auto ordinal : {1U,4U,5U,6U,7U,8U,9U,10U,11U,12U,13U,14U,15U,16U,17U,18U,19U,
                               21U,22U,23U,24U,25U,26U,27U,28U,
                               29U,30U,31U,32U,33U,34U,35U,36U,37U,38U,39U,
                               40U,41U,42U,43U,44U,45U,46U,47U,48U,49U}) {
        auto noAlloc = createFxProcessor(static_cast<std::uint16_t>(ordinal));
        const bool noAllocPrepared = noAlloc && noAlloc->prepare(spec);
        if (!noAllocPrepared) std::fprintf(stderr, "noalloc prepare diagnostic ordinal=%u\n", ordinal);
        check(noAllocPrepared, "allocation probe adapter prepares outside the callback");
        if (!noAlloc) continue;
        FxParameterEvent event{32U, FxParameterId::Mix, 0.6f};
        if (ordinal == 6U || ordinal == 10U || ordinal == 12U || ordinal == 14U ||
            ordinal == 15U || ordinal == 16U || ordinal == 17U || ordinal == 18U ||
            ordinal == 19U || ordinal == 21U || ordinal == 22U)
            event = {32U, FxParameterId::Active, 1.0f};
        if (ordinal == 1U) event = {32U,FxParameterId::FrequencyHz,3200.0f};
        else if (ordinal == 4U) event = {32U,FxParameterId::RateHz,0.8f};
        else if (ordinal == 25U) event = {32U,FxParameterId::ThresholdDb,-30.0f};
        else if (ordinal == 26U) event = {32U,FxParameterId::EqHighGainDb,3.0f};
        else if (ordinal == 36U) event = {32U,FxParameterId::Feedback,0.5f};
        else if (ordinal == 47U) event = {32U,FxParameterId::Wet,0.5f};
        else if (ordinal == 7U) event = {32U,FxParameterId::BitDepth,12.0f};
        else if (ordinal == 9U) event = {32U,FxParameterId::Waveform,2.0f};
        else if (ordinal == 29U) event = {32U,FxParameterId::Depth,0.75f};
        else if (ordinal == 30U) event = {32U,FxParameterId::Pan,0.5f};
        else if (ordinal == 32U) event = {32U,FxParameterId::RateHz,2.0f};
        else if (ordinal == 5U) event = {32U,FxParameterId::RateHz,0.7f};
        else if (ordinal == 8U) event = {32U,FxParameterId::Drive,3.0f};
        else if (ordinal == 11U) event = {32U,FxParameterId::Ratio,12.0f};
        else if (ordinal == 13U) event = {32U,FxParameterId::Sensitivity,3.0f};
        else if (ordinal == 27U) event = {32U,FxParameterId::LowGainDb,-3.0f};
        else if (ordinal == 31U) event = {32U,FxParameterId::StereoHighWidth,1.2f};
        else if (ordinal == 33U) event = {32U,FxParameterId::RateHz,4.0f};
        else if (ordinal == 34U) event = {32U,FxParameterId::PatternId,1.0f};
        else if (ordinal == 35U) event = {32U,FxParameterId::EdgeMilliseconds,2.0f};
        else if (ordinal == 37U) event = {32U,FxParameterId::Pan,0.5f};
        else if (ordinal == 38U) event = {32U,FxParameterId::Wet,0.6f};
        else if (ordinal == 39U) event = {32U,FxParameterId::DelayMs,300.0f};
        else if (ordinal == 46U) event = {32U,FxParameterId::RateHz,0.7f};
        else if (ordinal == 48U) event = {32U,FxParameterId::GateHoldMs,90.0f};
        else if (ordinal == 49U) event = {32U,FxParameterId::ReverbTimeSeconds,2.0f};
        else if (ordinal == 23U) event = {32U,FxParameterId::BassDb,3.0f};
        else if (ordinal == 24U) event = {32U,FxParameterId::Drive,2.0f};
        else if (ordinal == 28U) event = {32U,FxParameterId::OctaveMode,2.0f};
        else if (ordinal == 40U) event = {32U,FxParameterId::WowDepthMs,2.0f};
        else if (ordinal == 41U) event = {32U,FxParameterId::PitchRatio,1.2f};
        else if (ordinal == 42U) event = {32U,FxParameterId::WarpAmount,0.75f};
        else if (ordinal == 43U) event = {32U,FxParameterId::TwistMacro,0.25f};
        else if (ordinal == 44U) event = {32U,FxParameterId::SubdivisionBeats,0.5f};
        else if (ordinal == 45U) event = {32U,FxParameterId::Freeze,1.0f};
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
