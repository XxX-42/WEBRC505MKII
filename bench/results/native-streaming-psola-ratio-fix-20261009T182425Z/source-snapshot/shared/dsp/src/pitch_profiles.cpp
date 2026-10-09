#include "webrc/dsp/pitch_profiles.hpp"

#include <cmath>
#include <limits>

namespace webrc::dsp {
namespace {

bool sameSpec(const ProcessSpec& left, const ProcessSpec& right) noexcept {
    return left.sampleRate == right.sampleRate &&
           left.maxBlockFrames == right.maxBlockFrames &&
           left.channels == right.channels;
}

bool sameLiveMonoSettings(const LiveMonoPitchSettings& left,
                          const LiveMonoPitchSettings& right) noexcept {
    return sameSpec(left.spec, right.spec) &&
           left.analysisWindowFrames == right.analysisWindowFrames &&
           left.analysisHopFrames == right.analysisHopFrames &&
           left.analysisWorkUnitsPerCallback == right.analysisWorkUnitsPerCallback &&
           left.minimumFrequencyHz == right.minimumFrequencyHz &&
           left.maximumFrequencyHz == right.maximumFrequencyHz &&
           left.yinThreshold == right.yinThreshold;
}

bool sameStretchSettings(const SignalsmithStretchSettings& left,
                         const SignalsmithStretchSettings& right) noexcept {
    return left.mode == right.mode && left.channels == right.channels &&
           left.blockSamples == right.blockSamples &&
           left.intervalSamples == right.intervalSamples &&
           left.splitComputation == right.splitComputation && left.seed == right.seed;
}

bool addWouldOverflow(std::size_t left, std::size_t right) noexcept {
    return right > std::numeric_limits<std::size_t>::max() - left;
}

} // namespace

bool makePitchProfileSettings(PitchProfileId profile, float sampleRate,
                              std::uint32_t maxBlockFrames, std::uint32_t seed,
                              PitchProfileSettings& output,
                              std::uint32_t liveMonoWorkBudget) noexcept {
    const auto maskedSeed = seed & 0x7fffffffU;
    PitchProfileSettings candidate{};
    candidate.profile = profile;
    candidate.spec = {sampleRate, maxBlockFrames,
                      profile == PitchProfileId::LiveMono ? 1U : 2U};
    if (!validProcessSpec(candidate.spec) || sampleRate > 192000.0f) return false;

    switch (profile) {
    case PitchProfileId::LiveMono:
        if (liveMonoWorkBudget == 0U) return false;
        candidate.liveMono = {candidate.spec, 4096U, 512U, liveMonoWorkBudget,
                              40.0f, 1000.0f, 0.15f};
        break;
    case PitchProfileId::LivePoly:
        candidate.signalsmith = {PitchQualityMode::LivePoly, 2U, 4096U, 1024U,
                                 true, maskedSeed};
        break;
    case PitchProfileId::HqRender:
        candidate.signalsmith = {PitchQualityMode::HqRender, 2U, 8192U, 1024U,
                                 false, maskedSeed};
        break;
    default:
        return false;
    }
    output = candidate;
    return true;
}

PitchProfileProcessor::PitchProfileProcessor(std::uint32_t seed) noexcept
    : seed_(seed & 0x7fffffffU), signalsmith_(seed_) {}

std::size_t PitchProfileProcessor::requiredPrepareBytes(
    const PitchProfileSettings& settings) noexcept {
    const auto workBudget = settings.profile == PitchProfileId::LiveMono
        ? settings.liveMono.analysisWorkUnitsPerCallback : 32768U;
    PitchProfileSettings expected{};
    if (!makePitchProfileSettings(settings.profile, settings.spec.sampleRate,
                                  settings.spec.maxBlockFrames, settings.signalsmith.seed,
                                  expected, workBudget) ||
        !sameSpec(settings.spec, expected.spec)) return 0U;

    std::size_t engineBytes = 0U;
    if (settings.profile == PitchProfileId::LiveMono) {
        if (!sameLiveMonoSettings(settings.liveMono, expected.liveMono)) return 0U;
        engineBytes = LiveMonoPitchRoute::requiredPrepareBytes(settings.liveMono);
    } else {
        if (!sameStretchSettings(settings.signalsmith, expected.signalsmith)) return 0U;
        engineBytes = SignalsmithStretchAdapter::requiredPrepareBytes(
            settings.spec, settings.signalsmith);
    }
    if (engineBytes == 0U || addWouldOverflow(engineBytes, sizeof(PitchProfileProcessor))) return 0U;
    return engineBytes + sizeof(PitchProfileProcessor);
}

bool PitchProfileProcessor::prepare(const PitchProfileSettings& settings,
                                    std::size_t activePlusCandidateBudgetBytes) noexcept {
    if (prepared_ && settings.profile != settings_.profile) return false;
    if (settings.profile != PitchProfileId::LiveMono &&
        settings.signalsmith.seed != seed_) return false;

    const auto candidateBytes = requiredPrepareBytes(settings);
    if (candidateBytes == 0U) return false;
    std::size_t stagingPeak = candidateBytes;
    if (prepared_) {
        if (addWouldOverflow(stagingPeak, preparedBytes_)) return false;
        stagingPeak += preparedBytes_;
    }
    if (stagingPeak > activePlusCandidateBudgetBytes) return false;

    const bool ready = settings.profile == PitchProfileId::LiveMono
        ? liveMono_.prepare(settings.liveMono)
        : signalsmith_.prepare(settings.spec, settings.signalsmith,
                               activePlusCandidateBudgetBytes);
    if (!ready) return false;
    settings_ = settings;
    preparedBytes_ = candidateBytes;
    prepared_ = true;
    return true;
}

void PitchProfileProcessor::reset() noexcept {
    if (!prepared_) return;
    if (settings_.profile == PitchProfileId::LiveMono) liveMono_.reset();
    else signalsmith_.reset();
}

bool PitchProfileProcessor::setPitchRatio(float ratio) noexcept {
    if (!prepared_) return false;
    return settings_.profile == PitchProfileId::LiveMono
        ? liveMono_.setPitchRatio(ratio)
        : signalsmith_.setTransposeFactor(ratio);
}

bool PitchProfileProcessor::processMono(const float* input, float* output,
                                        std::uint32_t frames) noexcept {
    if (!prepared_ || settings_.profile != PitchProfileId::LiveMono) return false;
    return liveMono_.processBlock(input, output, frames);
}

bool PitchProfileProcessor::processStereo(const float* inputLeft, const float* inputRight,
                                          float* outputLeft, float* outputRight,
                                          std::uint32_t frames) noexcept {
    if (!prepared_ || settings_.profile == PitchProfileId::LiveMono ||
        inputLeft == nullptr || inputRight == nullptr ||
        outputLeft == nullptr || outputRight == nullptr || frames == 0U ||
        frames > settings_.spec.maxBlockFrames) return false;
    const float* inputs[2]{inputLeft, inputRight};
    float* outputs[2]{outputLeft, outputRight};
    return signalsmith_.process(inputs, frames, outputs, frames);
}

PitchProfileLatency PitchProfileProcessor::latency() const noexcept {
    PitchProfileLatency result{};
    if (!prepared_) return result;
    if (settings_.profile == PitchProfileId::LiveMono) {
        result.model = PitchProfileLatencyModel::DetectorWindowPlusResynthesisLookahead;
        result.declaredWindowPlusResynthesisSamples =
            liveMono_.declaredDetectorPlusResynthesisLatencySamples();
        return result;
    }
    result.model = PitchProfileLatencyModel::SignalsmithEngineInputAndOutputGetters;
    result.inputSamples = signalsmith_.inputLatencySamples();
    result.outputSamples = signalsmith_.outputLatencySamples();
    return result;
}

} // namespace webrc::dsp
