#include "webrc/dsp/pitch_fx_adapter.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <utility>
#include <vector>

namespace {
std::atomic<bool> countAllocations{false};
std::atomic<unsigned> allocationCount{0U};
int failures = 0;

void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}

double toneAmplitude(const std::vector<float>& samples, std::uint32_t first,
                     std::uint32_t frames, double frequencyHz, double sampleRate) {
    double cosine = 0.0;
    double sine = 0.0;
    constexpr double twoPi = 6.28318530717958647692;
    for (std::uint32_t i = 0U; i < frames; ++i) {
        const double phase = twoPi * frequencyHz * static_cast<double>(first + i) / sampleRate;
        cosine += samples[first + i] * std::cos(phase);
        sine += samples[first + i] * std::sin(phase);
    }
    return 2.0 * std::hypot(cosine, sine) / static_cast<double>(frames);
}

double maxAdjacentDelta(const std::vector<float>& samples, std::uint32_t first,
                        std::uint32_t frames) {
    double maximum = 0.0;
    const auto end = std::min<std::size_t>(samples.size(),
        static_cast<std::size_t>(first) + frames);
    for (std::size_t i = std::max<std::size_t>(1U, first); i < end; ++i)
        maximum = std::max(maximum, std::abs(static_cast<double>(samples[i] - samples[i - 1U])));
    return maximum;
}

void fillStereoTones(std::vector<float>& left, std::vector<float>& right,
                     double leftHz, double rightHz, double sampleRate) {
    constexpr double twoPi = 6.28318530717958647692;
    for (std::size_t i = 0U; i < left.size(); ++i) {
        const double time = static_cast<double>(i) / sampleRate;
        left[i] = static_cast<float>(0.22 * std::sin(twoPi * leftHz * time));
        right[i] = static_cast<float>(0.17 * std::sin(twoPi * rightHz * time + 0.31));
    }
}

bool process(webrc::dsp::PitchFxAdapter& processor, const std::vector<float>& left,
             const std::vector<float>& right, std::vector<float>& outputLeft,
             std::vector<float>& outputRight, std::uint32_t blockFrames) {
    const float* input[]{left.data(), right.data()};
    float* output[]{outputLeft.data(), outputRight.data()};
    for (std::uint32_t cursor = 0U; cursor < left.size(); cursor += blockFrames) {
        const auto frames = std::min<std::uint32_t>(blockFrames,
            static_cast<std::uint32_t>(left.size() - cursor));
        const float* chunkInput[]{input[0] + cursor, input[1] + cursor};
        float* chunkOutput[]{output[0] + cursor, output[1] + cursor};
        if (!processor.processBlock(chunkInput, chunkOutput, 2U, frames)) return false;
    }
    return true;
}
} // namespace

void* operator new(std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void* operator new[](std::size_t size) {
    if (countAllocations.load(std::memory_order_relaxed))
        allocationCount.fetch_add(1U, std::memory_order_relaxed);
    if (void* result = std::malloc(size == 0U ? 1U : size)) return result;
    throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete[](void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }
void operator delete[](void* memory, std::size_t) noexcept { std::free(memory); }

int main() {
    using namespace webrc::dsp;
    constexpr double sampleRate = 48000.0;
    constexpr std::uint32_t block = 128U;
    const ProcessSpec spec{static_cast<float>(sampleRate), block, 2U};

    const auto* transposeEntry = findFxByOrdinal(14U);
    const auto* bendEntry = findFxByOrdinal(15U);
    const auto* harmonyEntry = findFxByOrdinal(18U);
    check(transposeEntry && transposeEntry->readiness == FxReadiness::ProcessorAvailable &&
          bendEntry && bendEntry->readiness == FxReadiness::ProcessorAvailable &&
          harmonyEntry && harmonyEntry->readiness == FxReadiness::ProcessorAvailable,
          "catalog maps the canonical TRANSPOSE, PITCH BEND, and HRM MANUAL entries to processors");

    std::array<std::pair<std::uint16_t, std::size_t>, 3U> schemas{{
        {14U, 6U}, {15U, 5U}, {18U, 10U}
    }};
    bool schemasValid = true;
    for (const auto [ordinal, expectedCount] : schemas) {
        std::size_t count = 0U;
        const auto* descriptors = fxParameterDescriptors(ordinal, count);
        schemasValid = schemasValid && descriptors && count == expectedCount;
        for (std::size_t i = 0U; descriptors && i < count; ++i)
            schemasValid = schemasValid &&
                descriptors[i].origin == FxParameterOrigin::ReconstructionSafeBounds;
    }
    check(schemasValid, "each pitch FX publishes its own reconstruction-only parameter schema");

    const auto transposeMemory = fxMemoryRequirement(14U, spec);
    const auto bendMemory = fxMemoryRequirement(15U, spec);
    const auto harmonyMemory = fxMemoryRequirement(18U, spec);
    check(transposeMemory.supported && bendMemory.supported && harmonyMemory.supported &&
          transposeMemory.objectBytes >= sizeof(PitchFxAdapter) &&
          transposeMemory.persistentPreparedBytes > 0U &&
          transposeMemory.prepareScratchBytes == transposeMemory.persistentPreparedBytes &&
          bendMemory.peakBytes() > bendMemory.objectBytes &&
          harmonyMemory.persistentPreparedBytes > transposeMemory.persistentPreparedBytes,
          "memory preflight includes candidate backend and stereo scratch for each allowed profile");
    check(!fxMemoryRequirement(18U, ProcessSpec{48000.0f, block, 1U}).supported,
          "manual harmony rejects mono process shapes instead of duplicating one channel");

    // Reproduce create_v2's ordering: apply selected profile first, then all
    // serialized descriptor values. Neutral formant defaults must be valid in
    // LIVE_MONO; nonidentity formant controls remain rejected transactionally.
    auto monoTransposeBase = createFxProcessor(14U);
    auto* monoTranspose = dynamic_cast<PitchFxAdapter*>(monoTransposeBase.get());
    std::size_t transposeCount = 0U;
    const auto* transposeParameters = fxParameterDescriptors(14U, transposeCount);
    bool monoDefaultsAccepted = monoTranspose != nullptr &&
        monoTranspose->setParameter(FxParameterId::PitchProfile,
                                    static_cast<float>(PitchFxProfile::LiveMono));
    for (std::size_t i = 0U; monoDefaultsAccepted && i < transposeCount; ++i) {
        const auto value = transposeParameters[i].id == FxParameterId::PitchProfile
            ? static_cast<float>(PitchFxProfile::LiveMono)
            : transposeParameters[i].defaultValue;
        monoDefaultsAccepted = monoTranspose->validParameter(transposeParameters[i].id, value) &&
                               monoTranspose->setParameter(transposeParameters[i].id, value);
    }
    monoDefaultsAccepted = monoDefaultsAccepted && monoTranspose->prepare(spec);
    check(monoDefaultsAccepted,
          "factory accepts every serialized default after selecting the valid LIVE_MONO profile");
    if (monoDefaultsAccepted) {
        const auto oldFormant = monoTranspose->latencyReport();
        check(!monoTranspose->setParameter(FxParameterId::FormantFactor, 1.2f) &&
              !monoTranspose->setParameter(FxParameterId::FormantCompensation, 1.0f),
              "LIVE_MONO rejects nonidentity formant controls");
        check(oldFormant.profile == PitchFxProfile::LiveMono,
              "rejected formant controls leave the selected profile intact");

        constexpr std::uint32_t frames = 2048U;
        std::vector<float> left(frames, 0.0f), right(frames, 0.0f);
        std::vector<float> outLeft(frames, -9.0f), outRight(frames, -9.0f);
        left[0] = 0.37f;
        right[0] = -0.23f;
        const bool mixSet = monoTranspose->setParameter(FxParameterId::Mix, 1.0f);
        const bool activeSet = monoTranspose->setParameter(FxParameterId::Active, 1.0f);
        check(process(*monoTranspose, left, right, outLeft, outRight, block),
              "unity TRANSPOSE processes the impulse through the prepared LIVE_MONO route");
        bool exact = true;
        for (std::uint32_t i = 0U; i < frames; ++i)
            exact = exact && outLeft[i] == left[i] && outRight[i] == right[i];
        const auto report = monoTranspose->latencyReport();
        check(mixSet && activeSet && exact && monoTranspose->fixedLatencySamples() == -1 &&
              report.unityWetUsesBitExactInput && !report.nonUnityDryWetAlignmentMeasured,
              "unity wet/dry impulse path is sample-aligned by exact bypass while non-unity alignment remains unmeasured");
    }

    // Static TRANSPOSE uses the same ratio on independent stereo streams. This
    // checks both output channels against different source tones.
    constexpr std::uint32_t renderFrames = 48000U;
    std::vector<float> left(renderFrames), right(renderFrames), outLeft(renderFrames), outRight(renderFrames);
    fillStereoTones(left, right, 220.0, 330.0, sampleRate);
    auto transposeBase = createFxProcessor(14U);
    auto* transpose = dynamic_cast<PitchFxAdapter*>(transposeBase.get());
    bool transposePrepared = transpose &&
        transpose->setParameter(FxParameterId::Mix, 1.0f) &&
        transpose->setParameter(FxParameterId::Active, 1.0f) &&
        transpose->setParameter(FxParameterId::Semitones, 12.0f) &&
        transpose->prepare(spec);
    bool transposeRendered = transposePrepared && process(*transpose, left, right, outLeft, outRight, block);
    const auto l440 = transposeRendered ? toneAmplitude(outLeft, 16000U, 16000U, 440.0, sampleRate) : 0.0;
    const auto l660 = transposeRendered ? toneAmplitude(outLeft, 16000U, 16000U, 660.0, sampleRate) : 0.0;
    const auto r440 = transposeRendered ? toneAmplitude(outRight, 16000U, 16000U, 440.0, sampleRate) : 0.0;
    const auto r660 = transposeRendered ? toneAmplitude(outRight, 16000U, 16000U, 660.0, sampleRate) : 0.0;
    const auto l220Residual = transposeRendered ? toneAmplitude(outLeft, 16000U, 16000U, 220.0, sampleRate) : 0.0;
    const auto r330Residual = transposeRendered ? toneAmplitude(outRight, 16000U, 16000U, 330.0, sampleRate) : 0.0;
    std::fprintf(stderr,
        "TRANSPOSE probe: in=(0.220@220Hz,0.170@330Hz), target=(L440 %.6g [%.1f%%], R660 %.6g [%.1f%%]), residual=(L220 %.6g,R330 %.6g), leakage=(L660 %.6g,R440 %.6g)\n",
        l440, 100.0 * l440 / 0.22, r660, 100.0 * r660 / 0.17,
        l220Residual, r330Residual, l660, r440);
    // This is a frequency-routing/function probe only. The output gain values
    // are emitted above; it does not assert transparent timbre or gain.
    check(transposeRendered && l440 > 1.0e-3 && l440 > l660 * 4.0 &&
          r660 > 1.0e-3 && r660 > r440 * 4.0,
          "TRANSPOSE routes each independent input tone to its octave target (functional probe only)");

    // PITCH BEND follows a changing semitone target over a finite smoothing
    // interval. The steady segment must differ from the original frequency.
    auto bendBase = createFxProcessor(15U);
    auto* bend = dynamic_cast<PitchFxAdapter*>(bendBase.get());
    bool bendPrepared = bend && bend->setParameter(FxParameterId::Mix, 1.0f) &&
        bend->setParameter(FxParameterId::Active, 1.0f) && bend->prepare(spec);
    std::fill(outLeft.begin(), outLeft.end(), 0.0f);
    std::fill(outRight.begin(), outRight.end(), 0.0f);
    if (bendPrepared) {
        const float* in[]{left.data(), right.data()};
        float* out[]{outLeft.data(), outRight.data()};
        bool ok = true;
        for (std::uint32_t cursor = 0U; cursor < 8192U; cursor += block) {
            const float* ci[]{in[0] + cursor, in[1] + cursor};
            float* co[]{out[0] + cursor, out[1] + cursor};
            ok = ok && bend->processBlock(ci, co, 2U, block);
        }
        FxParameterEvent event{0U, FxParameterId::Semitones, 12.0f};
        const float* eventIn[]{in[0] + 8192U, in[1] + 8192U};
        float* eventOut[]{out[0] + 8192U, out[1] + 8192U};
        ok = ok && bend->processBlockWithEvents(eventIn, eventOut, 2U, block, &event, 1U);
        for (std::uint32_t cursor = 8192U + block; ok && cursor < renderFrames; cursor += block) {
            const float* ci[]{in[0] + cursor, in[1] + cursor};
            float* co[]{out[0] + cursor, out[1] + cursor};
            ok = bend->processBlock(ci, co, 2U, block);
        }
        bendPrepared = ok;
    }
    const auto bendL440 = bendPrepared ? toneAmplitude(outLeft, 24000U, 16000U, 440.0, sampleRate) : 0.0;
    const auto bendR660 = bendPrepared ? toneAmplitude(outRight, 24000U, 16000U, 660.0, sampleRate) : 0.0;
    if (!bendPrepared || bendL440 <= 0.06 || bendR660 <= 0.04)
        std::fprintf(stderr, "bend diagnostics prepared=%d L440=%.6g R660=%.6g\n",
                     bendPrepared ? 1 : 0, bendL440, bendR660);
    check(bendPrepared && bendL440 > 0.06 && bendR660 > 0.04,
          "PITCH BEND reaches its smoothed octave target while preserving stereo source identity");

    // A continuous semitone ramp crosses exact unity. The wet backend remains
    // unaligned, so the adapter tapers its contribution around zero; this PCM
    // check guards against the former hard unity bypass switch.
    constexpr std::uint32_t crossingWarmFrames = 16000U;
    constexpr std::uint32_t crossingFrames = 2048U;
    constexpr std::uint32_t crossingFrameInRamp = 480U;
    std::vector<float> crossingInL(crossingWarmFrames + crossingFrames);
    std::vector<float> crossingInR(crossingWarmFrames + crossingFrames);
    std::vector<float> crossingOutL(crossingInL.size(), 0.0f);
    std::vector<float> crossingOutR(crossingInR.size(), 0.0f);
    fillStereoTones(crossingInL, crossingInR, 220.0, 330.0, sampleRate);
    auto crossingBase = createFxProcessor(15U);
    auto* crossing = dynamic_cast<PitchFxAdapter*>(crossingBase.get());
    bool crossingOk = crossing && crossing->setParameter(FxParameterId::Mix, 1.0f) &&
        crossing->setParameter(FxParameterId::Active, 1.0f) &&
        crossing->setParameter(FxParameterId::BendSmoothingMs, 20.0f) &&
        crossing->setParameter(FxParameterId::Semitones, 0.2f) && crossing->prepare(spec);
    const float* crossingInputs[]{crossingInL.data(), crossingInR.data()};
    float* crossingOutputs[]{crossingOutL.data(), crossingOutR.data()};
    for (std::uint32_t cursor = 0U; crossingOk && cursor < crossingWarmFrames; cursor += block) {
        const float* chunkInput[]{crossingInputs[0] + cursor, crossingInputs[1] + cursor};
        float* chunkOutput[]{crossingOutputs[0] + cursor, crossingOutputs[1] + cursor};
        crossingOk = crossing->processBlock(chunkInput, chunkOutput, 2U, block);
    }
    const FxParameterEvent crossUnity{0U, FxParameterId::Semitones, -0.2f};
    if (crossingOk) {
        const float* chunkInput[]{crossingInputs[0] + crossingWarmFrames,
                                  crossingInputs[1] + crossingWarmFrames};
        float* chunkOutput[]{crossingOutputs[0] + crossingWarmFrames,
                             crossingOutputs[1] + crossingWarmFrames};
        crossingOk = crossing->processBlockWithEvents(chunkInput, chunkOutput, 2U, block,
                                                       &crossUnity, 1U);
    }
    for (std::uint32_t cursor = crossingWarmFrames + block;
         crossingOk && cursor < crossingInL.size(); cursor += block) {
        const float* chunkInput[]{crossingInputs[0] + cursor, crossingInputs[1] + cursor};
        float* chunkOutput[]{crossingOutputs[0] + cursor, crossingOutputs[1] + cursor};
        crossingOk = crossing->processBlock(chunkInput, chunkOutput, 2U, block);
    }
    const auto transitionWindow = crossingWarmFrames + crossingFrameInRamp - 128U;
    const auto outStepL = crossingOk ? maxAdjacentDelta(crossingOutL, transitionWindow, 256U) : 0.0;
    const auto outStepR = crossingOk ? maxAdjacentDelta(crossingOutR, transitionWindow, 256U) : 0.0;
    const auto inStepL = maxAdjacentDelta(crossingInL, transitionWindow, 256U);
    const auto inStepR = maxAdjacentDelta(crossingInR, transitionWindow, 256U);
    std::fprintf(stderr,
        "PITCH BEND unity-crossing step: L output %.6g/input %.6g, R output %.6g/input %.6g\n",
        outStepL, inStepL, outStepR, inStepR);
    check(crossingOk && outStepL <= inStepL * 4.0 + 1.0e-3 &&
          outStepR <= inStepR * 4.0 + 1.0e-3,
          "PITCH BEND crossing unity has no large hard-bypass sample step on either channel");

    // HRM MANUAL is a different route: two fixed, non-scale-quantized voice
    // intervals, with per-voice pan. L and R begin at different fundamentals.
    auto harmonyBase = createFxProcessor(18U);
    auto* harmony = dynamic_cast<PitchFxAdapter*>(harmonyBase.get());
    bool harmonyPrepared = harmony && harmony->setParameter(FxParameterId::Mix, 1.0f) &&
        harmony->setParameter(FxParameterId::Active, 1.0f) &&
        harmony->setParameter(FxParameterId::HarmonyVoice1Semitones, 7.0f) &&
        harmony->setParameter(FxParameterId::HarmonyVoice2Semitones, -5.0f) &&
        harmony->setParameter(FxParameterId::HarmonyVoice1Pan, -1.0f) &&
        harmony->setParameter(FxParameterId::HarmonyVoice2Pan, 1.0f) && harmony->prepare(spec);
    std::fill(outLeft.begin(), outLeft.end(), 0.0f);
    std::fill(outRight.begin(), outRight.end(), 0.0f);
    const bool harmonyRendered = harmonyPrepared &&
        process(*harmony, left, right, outLeft, outRight, block);
    const auto harmonyLeftTarget = harmonyRendered
        ? toneAmplitude(outLeft, 16000U, 16000U, 220.0 * std::pow(2.0, 7.0 / 12.0), sampleRate) : 0.0;
    const auto harmonyRightTarget = harmonyRendered
        ? toneAmplitude(outRight, 16000U, 16000U, 330.0 * std::pow(2.0, -5.0 / 12.0), sampleRate) : 0.0;
    const auto harmonyLeftUnshifted = harmonyRendered
        ? toneAmplitude(outLeft, 16000U, 16000U, 220.0, sampleRate) : 0.0;
    const auto harmonyRightUnshifted = harmonyRendered
        ? toneAmplitude(outRight, 16000U, 16000U, 330.0, sampleRate) : 0.0;
    std::fprintf(stderr,
        "HRM MANUAL probe: target=(L %.6g@%.3fHz,R %.6g@%.3fHz), unshifted=(L %.6g@220Hz,R %.6g@330Hz)\n",
        harmonyLeftTarget, 220.0 * std::pow(2.0, 7.0 / 12.0),
        harmonyRightTarget, 330.0 * std::pow(2.0, -5.0 / 12.0),
        harmonyLeftUnshifted, harmonyRightUnshifted);
    // Preserve a low functional floor while reporting the actual gain. These
    // values do not qualify the sound quality or dry/wet alignment.
    check(harmonyRendered && harmonyLeftTarget > 1.0e-3 && harmonyRightTarget > 1.0e-3 &&
          harmonyLeftTarget > harmonyLeftUnshifted * 1.1 &&
          harmonyRightTarget > harmonyRightUnshifted * 1.1,
          "HRM MANUAL renders its fixed intervals with independent stereo pan routes (functional probe only)");

    // A coupled invalid batch is rejected before output or DSP state changes.
    auto batchBase = createFxProcessor(14U);
    auto* batch = dynamic_cast<PitchFxAdapter*>(batchBase.get());
    auto referenceBase = createFxProcessor(14U);
    auto* reference = dynamic_cast<PitchFxAdapter*>(referenceBase.get());
    const ProcessSpec shortSpec{48000.0f, 64U, 2U};
    bool paired = batch && reference &&
        batch->setParameter(FxParameterId::PitchProfile, static_cast<float>(PitchFxProfile::LiveMono)) &&
        reference->setParameter(FxParameterId::PitchProfile, static_cast<float>(PitchFxProfile::LiveMono)) &&
        batch->prepare(shortSpec) && reference->prepare(shortSpec);
    if (paired) {
        std::array<float, 64U> inL{}, inR{}, outL{}, outR{}, refL{}, refR{};
        for (std::size_t i = 0U; i < 64U; ++i) {
            inL[i] = 0.2f * std::sin(static_cast<float>(i) * 0.13f);
            inR[i] = -0.16f * std::cos(static_cast<float>(i) * 0.09f);
            outL[i] = outR[i] = -91.0f;
        }
        const float* in[]{inL.data(), inR.data()};
        float* out[]{outL.data(), outR.data()};
        const FxParameterEvent invalid[]{
            {0U, FxParameterId::Semitones, 7.0f},
            {0U, FxParameterId::FormantFactor, 1.2f},
        };
        const bool rejected = !batch->processBlockWithEvents(in, out, 2U, 64U, invalid, 2U);
        bool untouched = true;
        for (std::size_t i = 0U; i < 64U; ++i) untouched = untouched && outL[i] == -91.0f && outR[i] == -91.0f;
        float* outAgain[]{outL.data(), outR.data()};
        float* refOut[]{refL.data(), refR.data()};
        const bool resumed = batch->processBlock(in, outAgain, 2U, 64U) &&
                             reference->processBlock(in, refOut, 2U, 64U);
        bool identical = resumed;
        for (std::size_t i = 0U; i < 64U; ++i)
            identical = identical && outL[i] == refL[i] && outR[i] == refR[i];
        if (!rejected || !untouched || !identical)
            std::fprintf(stderr, "batch diagnostics rejected=%d untouched=%d resumed=%d identical=%d\n",
                         rejected ? 1 : 0, untouched ? 1 : 0, resumed ? 1 : 0, identical ? 1 : 0);
        check(rejected && untouched && identical,
              "rejected coupled formant batch leaves output and subsequent DSP PCM untouched");
    }

    // Guard actual audio processing (not prepare or vector construction) for
    // allocations across all three processor identities.
    bool noAllocSetup = true;
    for (const auto ordinal : {14U, 15U, 18U}) {
        auto base = createFxProcessor(static_cast<std::uint16_t>(ordinal));
        auto* pitch = dynamic_cast<PitchFxAdapter*>(base.get());
        noAllocSetup = noAllocSetup && pitch && pitch->prepare(spec);
        if (!noAllocSetup) break;
        std::array<float, block> inL{}, inR{}, outL{}, outR{};
        const float* in[]{inL.data(), inR.data()};
        float* out[]{outL.data(), outR.data()};
        countAllocations.store(true, std::memory_order_relaxed);
        bool ok = true;
        for (unsigned i = 0U; i < 16U; ++i)
            ok = ok && pitch->processBlock(in, out, 2U, block);
        countAllocations.store(false, std::memory_order_relaxed);
        noAllocSetup = noAllocSetup && ok;
    }
    if (!noAllocSetup || allocationCount.load(std::memory_order_relaxed) != 0U)
        std::fprintf(stderr, "noalloc diagnostics setup=%d allocations=%u\n",
                     noAllocSetup ? 1 : 0, allocationCount.load(std::memory_order_relaxed));
    check(noAllocSetup && allocationCount.load(std::memory_order_relaxed) == 0U,
          "TRANSPOSE, PITCH BEND, and HRM MANUAL process callbacks without C++ heap allocation");

    if (failures != 0) {
        std::fprintf(stderr, "%d pitch adapter test(s) failed\n", failures);
        return 1;
    }
    std::puts("Pitch FX adapter tests passed.");
    return 0;
}
