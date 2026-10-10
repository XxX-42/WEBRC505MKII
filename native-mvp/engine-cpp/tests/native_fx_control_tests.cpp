#include "native_fx_control.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <new>

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<std::uint32_t> allocations{0U};
}

void* operator new(std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocations.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

namespace {
using namespace webrc::dsp;
using namespace webrc::native;

bool require(bool value, const char* message) {
    if (!value) std::cerr << "FAIL: " << message << '\n';
    return value;
}

template <typename Function>
std::uint32_t countNewCalls(Function&& function) {
    allocations.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    function();
    countAllocations.store(false, std::memory_order_release);
    return allocations.load(std::memory_order_relaxed);
}

NativeFxBankConfig inputAndTrackPanners() {
    NativeFxBankConfig config{};
    auto& input = config.buses[0U][0U];
    input.enabled = true;
    input.ordinal = 30U;
    input.parameterCount = 2U;
    input.parameters[0U] = {FxParameterId::Active, 1.0f};
    input.parameters[1U] = {FxParameterId::Pan, 1.0f};

    auto& track = config.buses[1U][0U];
    track.enabled = true;
    track.ordinal = 30U;
    track.parameterCount = 2U;
    track.parameters[0U] = {FxParameterId::Active, 1.0f};
    track.parameters[1U] = {FxParameterId::Pan, 1.0f};
    return config;
}

bool testPrepareTimeSelectorAdmissionUsesRealPreampSlot() {
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U), "prepare software host for real PREAMP selector admission"))
        return false;
    NativeFxBank bank(host);
    NativeFxBankConfig config{};
    auto& preamp = config.buses[1U][0U];
    preamp.enabled = true;
    preamp.ordinal = 23U;
    preamp.parameterCount = 1U;
    preamp.parameters[0U] = {FxParameterId::AmpModel, 8.0f};
    if (!require(bank.configure(config).ok(),
                 "prepare a real PREAMP processor with a valid model selector")) return false;
    const auto selectorEvent = bank.postParameterEvent(1U, 0U, FxParameterId::AmpModel, 1.0f, 0U);
    if (selectorEvent.status != NativeFxBankStatus::PrepareTimeParameterNotAllowed)
        std::cerr << "PREAMP runtime selector result status="
                  << static_cast<unsigned int>(selectorEvent.status)
                  << " graph=" << static_cast<unsigned int>(selectorEvent.graphResult) << '\n';
    return require(selectorEvent.status == NativeFxBankStatus::PrepareTimeParameterNotAllowed,
                   "reject runtime mutation of a valid PREAMP prepare-time selector with its explicit policy status");
}

bool testSelectedPitchProfileUsesProfileAwareBankBudget() {
    struct ProfileCase { std::uint16_t ordinal; float profile; };
    constexpr std::array<ProfileCase, 8U> cases{{
        {14U, 0.0f}, {14U, 1.0f}, {14U, 2.0f},
        {15U, 0.0f}, {15U, 1.0f}, {15U, 2.0f},
        {18U, 1.0f}, {18U, 2.0f},
    }};
    const ProcessSpec spec{48000.0f, kNativeFxGraphMaximumFrames, 2U};
    for (const auto& profileCase : cases) {
        NativeFxBankConfig config{};
        auto& slot = config.buses[1U][0U];
        slot.enabled = true;
        slot.ordinal = profileCase.ordinal;
        slot.parameterCount = 1U;
        slot.parameters[0U] = {FxParameterId::PitchProfile, profileCase.profile};
        const FxParameterEvent selectedEvent{0U, FxParameterId::PitchProfile,
                                              profileCase.profile};
        const auto requirement = fxMemoryRequirementForParameters(
            profileCase.ordinal, spec, &selectedEvent, 1U);
        const auto alignment = fxAlignmentUpperBoundSamples(profileCase.ordinal, spec);
        const auto alignmentBytes = static_cast<std::uint64_t>(alignment.frames) *
                                    2U * sizeof(float);
        const auto expected = static_cast<std::uint64_t>(sizeof(NativeFxGraph)) +
            requirement.objectBytes + requirement.persistentPreparedBytes +
            requirement.prepareScratchBytes + alignmentBytes;
        if (!require(requirement.supported && alignment.supported,
                     "profile-aware helper reports a finite prepare peak for every supported selector"))
            return false;
        const auto actual = NativeFxBank::requiredCandidatePeakBytes(config);
        if (!require(actual == expected,
                     "NativeFxBank candidate admission uses the selected profile memory and startup path"))
            return false;
    }

    NativeFxBankConfig invalid{};
    auto& harmony = invalid.buses[1U][0U];
    harmony.enabled = true;
    harmony.ordinal = 18U;
    harmony.parameterCount = 1U;
    harmony.parameters[0U] = {FxParameterId::PitchProfile, 0.0f};
    return require(NativeFxBank::requiredCandidatePeakBytes(invalid) == 0U,
                   "unsupported LIVE_MONO harmony profile fails closed without a bank budget");
}

bool testHostSampleRateAndPreparedLatencyAdmission() {
    NativeTrackHost lowRateHost;
    if (!require(lowRateHost.prepare(8000U, 1U), "prepare host at 8 kHz for Nyquist admission"))
        return false;
    NativeFxBank lowRateBank(lowRateHost);
    NativeFxBankConfig wrongRate{};
    wrongRate.sampleRateHz = 48000U;
    if (!require(lowRateBank.configure(wrongRate).status == NativeFxBankStatus::InvalidSpec &&
                 !lowRateBank.configured(),
                 "reject a bank rate that disagrees with the actual prepared host before graph preparation"))
        return false;

    NativeFxBankConfig lowRateConfig{};
    lowRateConfig.sampleRateHz = 8000U;
    auto& filter = lowRateConfig.buses[1U][0U];
    filter.enabled = true;
    filter.ordinal = 1U;
    filter.parameterCount = 1U;
    filter.parameters[0U] = {FxParameterId::FrequencyHz, 1000.0f};
    const auto lowRateResult = lowRateBank.configure(lowRateConfig);
    if (!lowRateResult.ok())
        std::cerr << "low-rate configure status=" << static_cast<unsigned>(lowRateResult.status)
                  << " graph=" << static_cast<unsigned>(lowRateResult.graphResult) << '\n';
    if (!require(lowRateResult.ok(),
                 "configure a sample-rate-valid filter on the 8 kHz host")) return false;
    if (!require(lowRateBank.postParameterEvent(1U, 0U, FxParameterId::FrequencyHz,
                                                 4000.0f, 0U).status ==
                     NativeFxBankStatus::InvalidParameter,
                 "reject a 4 kHz event against the actual 8 kHz host before queuing it")) return false;
    if (!require(lowRateBank.postParameterEvent(1U, 0U, FxParameterId::FrequencyHz,
                                                 3900.0f, 0U).ok(),
                 "accept a frequency event inside the prepared sample-rate margin")) return false;

    NativeTrackHost referenceHost;
    if (!require(referenceHost.prepare(8000U, 1U),
                 "prepare a sample-rate-matched reference host")) return false;
    NativeFxBank referenceBank(referenceHost);
    if (!require(referenceBank.configure(lowRateConfig).ok(),
                 "configure the reference graph at the same 8 kHz rate")) return false;
    const auto capturedPlaybackEnergy = [](NativeTrackHost& target, double& energy) {
        std::array<float, 64U> monoInput{};
        std::array<float, 128U> stereoOutput{};
        std::uint32_t sourceFrame = 0U;
        if (!target.processInputBlock(nullptr, 1U, stereoOutput.data(), 64U) ||
            !target.record(0U)) return false;
        for (std::uint32_t block = 0U; block < 16U; ++block) {
            for (std::uint32_t frame = 0U; frame < 64U; ++frame) {
                const double phase = 6.283185307179586476925286766559 * 1500.0 *
                                     static_cast<double>(sourceFrame++) / 8000.0;
                monoInput[frame] = 0.5f * static_cast<float>(std::sin(phase));
            }
            if (!target.processInputBlock(monoInput.data(), 1U, stereoOutput.data(), 64U))
                return false;
        }
        if (!target.stop(0U) ||
            !target.processInputBlock(nullptr, 1U, stereoOutput.data(), 64U) ||
            !target.play(0U) ||
            !target.processInputBlock(nullptr, 1U, stereoOutput.data(), 64U)) return false;
        energy = 0.0;
        for (std::uint32_t block = 0U; block < 16U; ++block) {
            if (!target.processInputBlock(nullptr, 1U, stereoOutput.data(), 64U)) return false;
            for (std::uint32_t frame = 0U; frame < 64U; ++frame) {
                const double left = stereoOutput[frame * 2U];
                const double right = stereoOutput[frame * 2U + 1U];
                energy += left * left + right * right;
            }
        }
        return true;
    };
    double changedCutoffEnergy = 0.0;
    double defaultCutoffEnergy = 0.0;
    if (!require(capturedPlaybackEnergy(lowRateHost, changedCutoffEnergy) &&
                 capturedPlaybackEnergy(referenceHost, defaultCutoffEnergy),
                 "render equal software-recorded stereo takes through both prepared filter graphs"))
        return false;
    if (changedCutoffEnergy <= defaultCutoffEnergy * 1.5)
        std::cerr << "8 kHz filter playback energy changed=" << changedCutoffEnergy
                  << " default=" << defaultCutoffEnergy << '\n';
    if (!require(changedCutoffEnergy > defaultCutoffEnergy * 1.5,
                 "the admitted 3.9 kHz event changes recorded-track PCM, proving it survives callback validation"))
        return false;

    NativeTrackHost variableHost;
    if (!require(variableHost.prepare(48000U, 1U),
                 "prepare host for variable-latency slot mix admission")) return false;
    NativeFxBank variableBank(variableHost);
    NativeFxBankConfig variableConfig{};
    auto& delay = variableConfig.buses[1U][0U];
    delay.enabled = true;
    delay.ordinal = 5U;
    if (!require(variableBank.configure(variableConfig).ok(),
                 "prepare a modulated-delay slot with its valid unity outer mix")) return false;
    std::int32_t fixedLatency = 0;
    if (!require(variableBank.slotFixedLatencySamples(1U, 0U, fixedLatency) &&
                 fixedLatency < 0 && !variableBank.slotSupportsOuterMix(1U, 0U),
                 "cache fixed latency and outer-mix support from the actually prepared candidate slot"))
        return false;
    return require(variableBank.postSlotMixEvent(1U, 0U, 0.5f, 5.0f, 0U).status ==
                       NativeFxBankStatus::InvalidMix,
                   "reject a wet/dry mix on a variable-latency processor before posting a host event");
}

bool testCompletePrevalidationAndFailedReconfigurePreservesSnapshot() {
    NativeFxBankConfig config = inputAndTrackPanners();
    if (!require(NativeFxBank::validateConfiguration(config).ok() &&
                 NativeFxBank::requiredCandidatePeakBytes(config) > sizeof(NativeFxGraph),
                 "validate an 8-bus, four-slot bank and compute its prepare peak")) return false;

    auto invalidLastSlot = config;
    invalidLastSlot.buses[7U][3U].enabled = true;
    invalidLastSlot.buses[7U][3U].ordinal = 54U; // Outside the stable catalog.
    if (!require(NativeFxBank::validateConfiguration(invalidLastSlot).status ==
                     NativeFxBankStatus::UnsupportedOrdinal,
                 "reject a bad processor in the last slot before building any graph")) return false;

    auto duplicate = config;
    duplicate.buses[0U][0U].parameterCount = 3U;
    duplicate.buses[0U][0U].parameters[2U] = {FxParameterId::Pan, 0.0f};
    if (!require(NativeFxBank::validateConfiguration(duplicate).status ==
                     NativeFxBankStatus::DuplicateParameter,
                 "reject duplicate initial parameter identifiers transactionally")) return false;

    auto send = config;
    send.buses[6U][0U].enabled = true;
    send.buses[6U][0U].ordinal = 1U;
    if (!require(NativeFxBank::validateConfiguration(send).status ==
                     NativeFxBankStatus::InvalidRoute,
                 "reject a send bus insert until NativeTrackHost routes a send source")) return false;

    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U), "prepare the software-only track host")) return false;
    NativeFxBank bank(host);
    const auto configured = bank.configure(config);
    if (!require(configured.ok() && bank.configured() && bank.configuration() != nullptr,
                 "stage a fully validated bank through the actual Native host")) return false;
    if (!require(!host.status().fxGraphActive,
                 "staging is distinct from adoption by the audio callback")) return false;
    std::array<float, 128U> silentOutput{};
    if (!require(host.processInputBlock(nullptr, 1U, silentOutput.data(), 64U) &&
                 host.status().fxGraphActive,
                 "the software callback adopts the staged graph at its next block boundary")) return false;

    const auto accepted = *bank.configuration();
    const auto generationBeforeFailure = host.status().fxGraphGeneration;
    auto invalidReplacement = config;
    invalidReplacement.buses[7U][3U].enabled = true;
    invalidReplacement.buses[7U][3U].ordinal = 54U;
    const auto rejected = bank.configure(invalidReplacement);
    return require(rejected.status == NativeFxBankStatus::UnsupportedOrdinal &&
                   bank.configuration() != nullptr &&
                   bank.configuration()->buses[0U][0U].ordinal == accepted.buses[0U][0U].ordinal &&
                   bank.configuration()->buses[1U][0U].parameters[1U].value ==
                       accepted.buses[1U][0U].parameters[1U].value &&
                   host.status().fxGraphGeneration == generationBeforeFailure &&
                   host.status().fxGraphActive,
                   "failed whole-bank validation leaves the prior accepted configuration and staged graph intact");
}

bool testRejectedConfigurePreflightDoesNotAllocateProcessors() {
    const auto valid = inputAndTrackPanners();
    NativeFxBankResult metadataResult{};
    std::uint64_t peakBytes = 0U;
    const auto metadataAllocations = countNewCalls([&] {
        metadataResult = NativeFxBank::validateConfiguration(valid);
        peakBytes = NativeFxBank::requiredCandidatePeakBytes(valid);
    });
    if (!require(metadataResult.ok() && peakBytes > sizeof(NativeFxGraph) &&
                 metadataAllocations == 0U,
                 "metadata validation and candidate peak estimation make no processor allocations"))
        return false;

    NativeTrackHost unpreparedHost;
    NativeFxBank unpreparedBank(unpreparedHost);
    NativeFxBankResult unpreparedResult{};
    const auto unpreparedAllocations = countNewCalls([&] {
        unpreparedResult = unpreparedBank.configure(valid);
    });
    if (!require(unpreparedResult.status == NativeFxBankStatus::HostNotPrepared &&
                 unpreparedAllocations == 0U,
                 "unprepared-host rejection happens before constructing a shadow processor"))
        return false;

    NativeTrackHost rateHost;
    if (!require(rateHost.prepare(8000U, 1U), "prepare host for mismatched-rate allocation guard"))
        return false;
    NativeFxBank rateBank(rateHost);
    NativeFxBankResult rateResult{};
    const auto rateAllocations = countNewCalls([&] {
        rateResult = rateBank.configure(valid);
    });
    if (!require(rateResult.status == NativeFxBankStatus::InvalidSpec &&
                 rateAllocations == 0U,
                 "sample-rate mismatch rejects before processor construction"))
        return false;

    NativeFxBankConfig nyquistInvalid{};
    nyquistInvalid.sampleRateHz = 8000U;
    auto& highFilter = nyquistInvalid.buses[1U][0U];
    highFilter.enabled = true;
    highFilter.ordinal = 1U;
    highFilter.parameterCount = 1U;
    highFilter.parameters[0U] = {FxParameterId::FrequencyHz, 3950.0f};
    NativeFxBankResult nyquistResult{};
    const auto nyquistAllocations = countNewCalls([&] {
        nyquistResult = rateBank.configure(nyquistInvalid);
    });
    if (!require(nyquistResult.status == NativeFxBankStatus::InvalidParameter &&
                 nyquistAllocations == 0U,
                 "Nyquist-invalid parameter is rejected by metadata checks with zero allocations"))
        return false;

    const std::uint64_t oneByteBudget = NativeTrackHost::requiredFixedMemoryBytes() +
        MultiTrackLooperCore::requiredTrackBufferBytes(48000U, 1U) * kNativeTrackCount + 1U;
    NativeTrackHost underfundedHost;
    if (!require(underfundedHost.prepare(48000U, 1U, oneByteBudget) &&
                 underfundedHost.candidateFxGraphBudgetBytes() == 1U,
                 "prepare a host with exactly one byte left for an FX candidate")) return false;
    NativeFxBank underfundedBank(underfundedHost);
    NativeFxBankResult budgetResult{};
    const auto budgetAllocations = countNewCalls([&] {
        budgetResult = underfundedBank.configure(valid);
    });
    return require(budgetResult.status == NativeFxBankStatus::MemoryBudgetExceeded &&
                   budgetAllocations == 0U && !underfundedBank.configured(),
                   "one-byte candidate budget rejects before any shadow or graph allocation");
}

bool testTimedControlsAndRealInputRecordTrackMixOrdering() {
    const auto config = inputAndTrackPanners();
    const ProcessSpec spec{48000.0f, kNativeTrackHostQuantumFrames, 2U};
    NativeFxGraph permanentProbe;
    if (!require(permanentProbe.prepare(spec) == NativeFxGraphResult::Ok,
                 "prepare a control-side graph to derive the exact steady ledger")) return false;
    for (std::uint8_t bus = 0U; bus < 2U; ++bus) {
        const auto& slot = config.buses[bus][0U];
        const auto address = bus == 0U ? NativeFxBusAddress{NativeFxBusKind::Input, 0U}
                                       : NativeFxBusAddress{NativeFxBusKind::Track, 0U};
        if (!require(permanentProbe.configureSlot(address, 0U, slot.ordinal, slot.mix,
                     slot.smoothingMs, slot.parameters.data(), slot.parameterCount) ==
                     NativeFxGraphResult::Ok,
                     "derive the bank graph's steady processor byte estimate")) return false;
    }
    if (!require(permanentProbe.seal() == NativeFxGraphResult::Ok,
                 "seal the byte-estimation probe")) return false;
    const auto candidatePeak = NativeFxBank::requiredCandidatePeakBytes(config);
    const auto steadyGraphBytes = permanentProbe.estimatedPermanentBytes();
    const auto historyBytes = MultiTrackLooperCore::requiredTrackBufferBytes(48000U, 1U) *
                              kNativeTrackCount;
    const auto aggregateBudget = NativeTrackHost::requiredFixedMemoryBytes() + historyBytes +
                                 candidatePeak + steadyGraphBytes - 1U;
    NativeTrackHost host;
    if (!require(candidatePeak > steadyGraphBytes && host.prepare(48000U, 1U, aggregateBudget),
                 "prepare software histories with room for one candidate but not old-plus-new peaks")) return false;
    NativeFxBank bank(host);
    if (!require(bank.configure(config).ok(),
                 "configure input and track FX through the new control-thread service")) return false;
    const auto currentFrame = host.status().nextFrame;
    if (!require(bank.postParameterEvent(0U, 0U, FxParameterId::Pan, 1.0f,
                                         currentFrame + 64U).ok(),
                 "queue a timestamped parameter event through NativeTrackHost")) return false;
    if (!require(!host.status().fxGraphActive,
                 "a queued control is bound to a staged graph before that graph is active")) return false;
    if (!require(bank.postParameterEvent(1U, 0U, FxParameterId::AmpModel, 1.0f,
                                         currentFrame + 64U).status ==
                     NativeFxBankStatus::InvalidParameter,
                 "reject a parameter that is not part of the selected slot's runtime contract")) return false;

    std::array<float, 256U> input{};
    std::array<float, 256U> output{};
    for (std::uint32_t frame = 0U; frame < 128U; ++frame) {
        input[frame * 2U] = 0.2f;
        input[frame * 2U + 1U] = -0.1f;
    }
    if (!require(host.setPan(0U, -1.0f),
                 "set the post-Track-FX host pan to hard left")) return false;
    for (std::uint32_t callback = 0U; callback < 10U; ++callback) {
        if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U),
                     "run the staged graph on NativeTrackHost's software callback path")) return false;
        if (callback == 0U && !require(host.status().fxGraphActive,
                                       "callback boundary adopts the pending graph before its queued event is applied")) return false;
    }
    if (!require(host.status().fxGraphActive,
                 "activate the configured graph at a software block boundary")) return false;
    if (!require(host.candidateFxGraphBudgetBytes() == candidatePeak - 1U,
                 "active graph remains charged while only candidate construction headroom is reusable")) return false;

    const auto oldConfiguration = *bank.configuration();
    const auto replacement = bank.configure(config);
    if (!require(replacement.status == NativeFxBankStatus::MemoryBudgetExceeded &&
                 bank.configuration()->buses[0U][0U].ordinal ==
                     oldConfiguration.buses[0U][0U].ordinal &&
                 host.status().fxGraphActive,
                 "reject an underfunded graph replacement without dropping the active graph or its bank snapshot")) return false;

    if (!require(host.record(0U), "queue Track 1 record command")) return false;
    if (!require(host.processInputBlock(input.data(), 2U, output.data(), 64U) &&
                 host.processInputBlock(input.data(), 2U, output.data(), 128U),
                 "record the input-bus-panned signal into the actual five-track history")) return false;
    if (!require(host.stop(0U) && host.processInputBlock(input.data(), 2U, output.data(), 128U),
                 "finish the take after input FX has run")) return false;
    if (!require(host.play(0U) && host.processInputBlock(input.data(), 2U, output.data(), 128U),
                 "start playback of the input-FX recording")) return false;

    allocations.store(0U, std::memory_order_relaxed);
    countAllocations.store(true, std::memory_order_release);
    bool processOk = true;
    for (std::uint32_t callback = 0U; callback < 10U; ++callback)
        processOk = host.processInputBlock(input.data(), 2U, output.data(), 64U) && processOk;
    countAllocations.store(false, std::memory_order_release);
    if (!require(processOk, "render the recorded stereo track through its FX before mixing")) return false;
    if (!require(allocations.load(std::memory_order_relaxed) == 0U,
                 "the software callback path stays allocation-free after graph staging")) return false;

    const auto status = host.status();
    if (!require(status.tracks[0U].state == TrackPlaybackState::Playing &&
                 status.tracks[0U].loopFrames >= 128U,
                 "the transformed input reached the track's recorded loop history")) return false;
    const auto left = output[126U];
    const auto right = output[127U];
    if (!(left > 0.08f && std::abs(right) < 0.01f))
        std::cerr << "NativeFxBank route sample=" << left << ',' << right << '\n';
    return require(left > 0.08f && std::abs(right) < 0.01f,
                   "Input FX was recorded, Track FX ran before the host hard-left track mix, and stereo routing reached output");
}

bool testMemoryPreflightRejectsBeforeBankSnapshotChanges() {
    NativeFxBankConfig config = inputAndTrackPanners();
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U), "prepare a host for aggregate FX budget rejection")) return false;
    NativeFxBank bank(host);
    if (!require(bank.configure(config).ok(), "stage initial valid config")) return false;
    const auto original = *bank.configuration();
    auto muchLarger = config;
    for (std::uint8_t track = 0U; track < 5U; ++track) {
        auto& slot = muchLarger.buses[static_cast<std::uint8_t>(track + 1U)][0U];
        slot.enabled = true;
        slot.ordinal = 47U;
    }
    // The pending graph consumes staging admission until an audio boundary;
    // attempting another replacement must not overwrite the saved snapshot.
    const auto rejected = bank.configure(muchLarger);
    return require(!rejected.ok() && bank.configuration() != nullptr &&
                   bank.configuration()->buses[1U][0U].ordinal == original.buses[1U][0U].ordinal,
                   "memory/staging rejection preserves the old bank configuration");
}

bool testAtomicParameterBatchesAndRouteSpecificHarmonyMode() {
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U), "prepare the host for batched parameter admission"))
        return false;
    NativeFxBank bank(host);
    NativeFxBankConfig config{};
    auto& radio = config.buses[0U][0U];
    radio.enabled = true;
    radio.ordinal = 8U;
    if (!require(bank.configure(config).ok(), "stage a real Radio processor with its default passband"))
        return false;
    std::array<float, 128U> silence{};
    if (!require(host.processInputBlock(nullptr, 1U, silence.data(), 64U),
                 "adopt the Radio graph before posting automation")) return false;

    const auto original = *bank.configuration();
    const auto frame = host.status().nextFrame;
    const std::array<NativeFxBankEvent, 2U> invalidPair{{
        {frame, 0U, 0U, NativeFxBankEventKind::ProcessorParameter,
         FxParameterId::RadioHighPassHz, 5000.0f, 5.0f},
        {frame, 0U, 0U, NativeFxBankEventKind::ProcessorParameter,
         FxParameterId::RadioLowPassHz, 3000.0f, 5.0f},
    }};
    const auto rejectedPair = bank.postEvents(invalidPair.data(),
                                               static_cast<std::uint32_t>(invalidPair.size()));
    if (!require(rejectedPair.status == NativeFxBankStatus::InvalidParameter &&
                 bank.configuration()->buses[0U][0U].parameterCount ==
                     original.buses[0U][0U].parameterCount,
                 "reject a same-frame invalid Radio passband without changing its accepted target snapshot"))
        return false;

    const std::array<NativeFxBankEvent, 2U> validPair{{
        {frame, 0U, 0U, NativeFxBankEventKind::ProcessorParameter,
         FxParameterId::RadioHighPassHz, 1000.0f, 5.0f},
        {frame, 0U, 0U, NativeFxBankEventKind::ProcessorParameter,
         FxParameterId::RadioLowPassHz, 3000.0f, 5.0f},
    }};
    if (!require(bank.postEvents(validPair.data(), static_cast<std::uint32_t>(validPair.size())).ok() &&
                 bank.configuration()->buses[0U][0U].parameterCount == 2U &&
                 bank.configuration()->buses[0U][0U].parameters[0U].value == 1000.0f &&
                 host.status().nextFrame == frame,
                 "accept a valid compound same-frame passband as the target before callback application"))
        return false;

    auto tooMany = std::array<NativeFxBankEvent, kNativeFxBankMaximumEventBatch + 1U>{};
    for (auto& event : tooMany) {
        event = {host.status().nextFrame, 0U, 0U,
                 NativeFxBankEventKind::ProcessorParameter, FxParameterId::RadioLowPassHz,
                 3200.0f, 5.0f};
    }
    if (!require(bank.postEvents(tooMany.data(), static_cast<std::uint32_t>(tooMany.size())).status ==
                     NativeFxBankStatus::TooManyEvents,
                 "reject a 65-event batch before any prefix can be queued")) return false;

    auto outOfOrder = validPair;
    outOfOrder[0U].absoluteFrame = frame + 64U;
    outOfOrder[1U].absoluteFrame = frame;
    if (!require(bank.postEvents(outOfOrder.data(), static_cast<std::uint32_t>(outOfOrder.size())).status ==
                     NativeFxBankStatus::EventOrderRejected,
                 "reject a globally out-of-order event batch")) return false;

    NativeFxBankConfig harmony{};
    auto& autoHarmony = harmony.buses[1U][0U];
    autoHarmony.enabled = true;
    autoHarmony.ordinal = 19U;
    autoHarmony.parameterCount = 1U;
    autoHarmony.parameters[0U] = {FxParameterId::ModeIndex, 2.0f};
    NativeTrackHost harmonyHost;
    if (!require(harmonyHost.prepare(48000U, 1U),
                 "prepare an isolated host for HRM AUTO mode admission")) return false;
    NativeFxBank autoBank(harmonyHost);
    const auto autoConfigure = autoBank.configure(harmony);
    if (!autoConfigure.ok())
        std::cerr << "HRM Auto configure status=" << static_cast<unsigned int>(autoConfigure.status)
                  << " graph=" << static_cast<unsigned int>(autoConfigure.graphResult) << '\n';
    if (!require(autoConfigure.ok(),
                 "allow the implemented automatic mode for HRM AUTO (M)")) return false;
    const NativeFxBankEvent midiMode{harmonyHost.status().nextFrame, 1U, 0U,
        NativeFxBankEventKind::ProcessorParameter, FxParameterId::ModeIndex, 1.0f, 5.0f};
    if (!require(autoBank.postEvents(&midiMode, 1U).status == NativeFxBankStatus::PrepareTimeParameterNotAllowed &&
                 autoBank.configuration()->buses[1U][0U].parameters[0U].value == 2.0f,
                 "reject runtime prepare-time selector mutation without changing the accepted Auto Harmony target"))
        return false;
    if (!require(autoBank.postParameterEvent(1U, 0U, FxParameterId::ModeIndex, 1.0f,
                                              harmonyHost.status().nextFrame).status ==
                     NativeFxBankStatus::PrepareTimeParameterNotAllowed,
                 "keep the legacy single-event API behind the prepare-time selector policy"))
        return false;
    autoHarmony.parameters[0U].value = 1.0f;
    if (!require(NativeFxBank::validateConfiguration(harmony).ok(),
                 "allow HRM AUTO (M)'s Hybrid/MIDI mode when selected during bank preparation")) return false;

    NativeFxBankConfig externalContext{};
    externalContext.buses[1U][0U].enabled = true;
    externalContext.buses[1U][0U].ordinal = 20U;
    if (!require(NativeFxBank::validateConfiguration(externalContext).status ==
                     NativeFxBankStatus::InvalidRoute,
                 "reject VOCODER while its required external carrier is not routed")) return false;
    externalContext.buses[1U][0U].ordinal = 21U;
    return require(NativeFxBank::validateConfiguration(externalContext).ok(),
                   "allow OSC VOC(M) when Native routes typed sample-accurate MIDI");
}

bool testTypedMidiAdmissionIsAtomicAndRunsInTheAudioBlock() {
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U), "prepare a software host for typed OSC VOC MIDI")) return false;
    if (!require(host.setMonitor(true), "enable deterministic software monitoring")) return false;
    NativeTrackHost referenceHost;
    if (!require(referenceHost.prepare(48000U, 1U) && referenceHost.setMonitor(true),
                 "prepare an identical reference host for MIDI batch atomicity")) return false;
    NativeFxBank bank(host);
    NativeFxBank referenceBank(referenceHost);
    NativeFxBankConfig configuration{};
    auto& oscillator = configuration.buses[0U][0U];
    oscillator.enabled = true;
    oscillator.ordinal = 21U;
    oscillator.parameterCount = 3U;
    oscillator.parameters[0U] = {FxParameterId::Active, 1.0f};
    oscillator.parameters[1U] = {FxParameterId::Mix, 1.0f};
    oscillator.parameters[2U] = {FxParameterId::Waveform, 0.0f};
    if (!require(bank.configure(configuration).ok() && referenceBank.configure(configuration).ok(),
                 "prepare identical typed-MIDI OSC VOC processors"))
        return false;

    std::array<float, 128U> silence{};
    std::array<float, 128U> hostOutput{};
    std::array<float, 128U> referenceOutput{};
    if (!require(host.processInputBlock(silence.data(), 2U, hostOutput.data(), 64U) &&
                 referenceHost.processInputBlock(silence.data(), 2U, referenceOutput.data(), 64U),
                 "adopt both OSC VOC graphs before MIDI events")) return false;
    const auto frame = host.status().nextFrame;

    std::array<NativeFxBankEvent, 2U> invalid{};
    invalid[0].absoluteFrame = frame + 7U;
    invalid[0].busIndex = 0U;
    invalid[0].slotIndex = 0U;
    invalid[0].kind = NativeFxBankEventKind::Midi;
    invalid[0].midiType = FxMidiEventType::NoteOn;
    invalid[0].midiChannel = 0U;
    invalid[0].midiNote = 60U;
    invalid[0].midiVelocity = 100U;
    invalid[1] = invalid[0];
    invalid[1].absoluteFrame = frame + 51U;
    invalid[1].midiType = FxMidiEventType::NoteOff;
    invalid[1].midiVelocity = 0U;
    invalid[1].midiChannel = 1U;
    const auto generation = host.status().fxGraphGeneration;
    const auto invalidResult = bank.postEvents(invalid.data(), static_cast<std::uint32_t>(invalid.size()));
    if (!require(invalidResult.status == NativeFxBankStatus::InvalidEvent &&
                 host.status().fxGraphGeneration == generation,
                 "reject a malformed MIDI tail without queueing any valid prefix or restaging the graph"))
        return false;

    std::array<float, 128U> sine{};
    for (std::uint32_t sample = 0U; sample < 64U; ++sample) {
        const float value = 0.25f * std::sin(6.2831853071795864769f * 220.0f *
                                             static_cast<float>(sample) / 48000.0f);
        sine[sample * 2U] = value;
        sine[sample * 2U + 1U] = -0.5f * value;
    }
    if (!require(host.processInputBlock(sine.data(), 2U, hostOutput.data(), 64U) &&
                 referenceHost.processInputBlock(sine.data(), 2U, referenceOutput.data(), 64U),
                 "render both hosts after the rejected MIDI transaction")) return false;
    const auto noMidiOutput = hostOutput;
    if (!require(hostOutput == referenceOutput,
                 "a rejected typed-MIDI tail leaves exact output identical to a no-event reference"))
        return false;

    const auto midiFrame = host.status().nextFrame;
    std::array<NativeFxBankEvent, 2U> valid = invalid;
    valid[0].absoluteFrame = midiFrame + 7U;
    valid[1].absoluteFrame = midiFrame + 51U;
    valid[1].midiChannel = 0U;
    if (!require(bank.postEvents(valid.data(), static_cast<std::uint32_t>(valid.size())).ok() &&
                 referenceBank.postEvents(valid.data(), static_cast<std::uint32_t>(valid.size())).ok(),
                 "admit the same ordered NoteOn/NoteOff pair to both deterministic hosts")) return false;
    if (!require(host.processInputBlock(sine.data(), 2U, hostOutput.data(), 64U) &&
                 referenceHost.processInputBlock(sine.data(), 2U, referenceOutput.data(), 64U),
                 "process sample-offset MIDI through both NativeTrackHost graphs")) return false;
    const auto status = host.status();
    double midiPcmDifference = 0.0;
    for (std::size_t index = 0U; index < hostOutput.size(); ++index)
        midiPcmDifference = std::max(midiPcmDifference,
            std::abs(static_cast<double>(hostOutput[index]) - noMidiOutput[index]));
    return require(hostOutput == referenceOutput && midiPcmDifference > 1.0e-5 &&
                   status.fxDspFaultCount == 0U && status.lastFxDspFault == NativeFxGraphResult::Ok &&
                   std::all_of(hostOutput.begin(), hostOutput.end(), [](float sample) {
                       return std::isfinite(sample);
                   }),
                   "valid typed MIDI changes deterministic stereo PCM with finite output and no DSP fault");
}

bool testPendingPerSlotParameterEventCapacity() {
    NativeTrackHost host;
    if (!require(host.prepare(48000U, 1U), "prepare the host for pending per-slot event accounting"))
        return false;
    NativeFxBank bank(host);
    NativeFxBankConfig config{};
    auto& sustainer = config.buses[0U][0U];
    sustainer.enabled = true;
    sustainer.ordinal = 11U;
    if (!require(bank.configure(config).ok(), "stage Sustainer for its per-callback event bound"))
        return false;
    std::array<float, 128U> silence{};
    if (!require(host.processInputBlock(nullptr, 1U, silence.data(), 64U),
                 "adopt Sustainer before queueing event batches")) return false;

    auto processor = webrc::dsp::createFxProcessor(11U);
    if (!require(processor && processor->maximumParameterEventsPerBlock() == 64U,
                 "Sustainer advertises the expected per-callback event bound")) return false;

    const auto frame = host.status().nextFrame;
    std::array<NativeFxBankEvent, 40U> first{};
    std::array<NativeFxBankEvent, 40U> second{};
    std::array<NativeFxBankEvent, 24U> final{};
    const auto fill = [frame](auto& batch, float value) {
        for (auto& event : batch) {
            event = {frame, 0U, 0U, NativeFxBankEventKind::ProcessorParameter,
                     FxParameterId::Wet, value, 5.0f};
        }
    };
    fill(first, 0.25f);
    fill(second, 0.75f);
    fill(final, 0.5f);

    if (!require(bank.postEvents(first.data(), static_cast<std::uint32_t>(first.size())).ok(),
                 "accept the first 40 Sustainer events")) return false;
    const auto acceptedFirst = *bank.configuration();
    const auto secondResult = bank.postEvents(second.data(),
                                               static_cast<std::uint32_t>(second.size()));
    if (!require(secondResult.status == NativeFxBankStatus::ControlEventRejected &&
                 secondResult.graphResult == NativeFxGraphResult::TooManyEvents &&
                 bank.configuration()->buses[0U][0U].parameters[0U].value == 0.25f,
                 "reject the second 40-event batch and preserve the first accepted target"))
        return false;
    if (!require(bank.configuration()->buses[0U][0U].parameters[0U].value ==
                     acceptedFirst.buses[0U][0U].parameters[0U].value,
                 "rejected queue admission leaves the full accepted bank snapshot unchanged"))
        return false;
    return require(bank.postEvents(final.data(), static_cast<std::uint32_t>(final.size())).ok() &&
                   bank.configuration()->buses[0U][0U].parameters[0U].value == 0.5f,
                   "accept 40+24 pending events exactly at Sustainer's 64-event bound");
}

} // namespace

int main() {
    const bool ok = testCompletePrevalidationAndFailedReconfigurePreservesSnapshot() &&
                    testRejectedConfigurePreflightDoesNotAllocateProcessors() &&
                    testPrepareTimeSelectorAdmissionUsesRealPreampSlot() &&
                    testSelectedPitchProfileUsesProfileAwareBankBudget() &&
                    testHostSampleRateAndPreparedLatencyAdmission() &&
                    testTimedControlsAndRealInputRecordTrackMixOrdering() &&
                    testMemoryPreflightRejectsBeforeBankSnapshotChanges() &&
                    testAtomicParameterBatchesAndRouteSpecificHarmonyMode() &&
                    testTypedMidiAdmissionIsAtomicAndRunsInTheAudioBlock() &&
                    testPendingPerSlotParameterEventCapacity();
    if (ok) std::cout << "NativeFxBank control tests passed.\n";
    return ok ? 0 : 1;
}
