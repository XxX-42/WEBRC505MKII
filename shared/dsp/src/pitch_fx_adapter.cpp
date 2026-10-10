#include "webrc/dsp/pitch_fx_adapter.hpp"

#include "webrc/dsp/pitch_profiles.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <new>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define WEBRC_PITCH_TRY try
#define WEBRC_PITCH_CATCH_ALL catch (...)
#else
#define WEBRC_PITCH_TRY if (true)
#define WEBRC_PITCH_CATCH_ALL else if (false)
#endif

namespace webrc::dsp {
namespace {

constexpr float kPi = 3.14159265358979323846f;
constexpr std::uint32_t kBendUpdateQuantum = 16U;
constexpr std::uint32_t kLiveMonoWindowFrames = 4096U;
constexpr std::uint32_t kLiveMonoHopFrames = 512U;
constexpr std::uint32_t kLiveMonoWorkUnits = 32768U;
constexpr float kLiveMonoMinimumHz = 40.0f;
constexpr float kLiveMonoMaximumHz = 1000.0f;
constexpr float kYinThreshold = 0.15f;
constexpr std::uint32_t kSignalsmithSeed = 0x50495443U;

bool isPitchOrdinal(std::uint16_t ordinal) noexcept {
    return ordinal == 14U || ordinal == 15U || ordinal == 18U;
}

bool isProfileValue(float value) noexcept {
    return std::isfinite(value) && std::floor(value) == value &&
           value >= 0.0f && value <= 2.0f;
}

bool addSize(std::size_t& total, std::size_t amount) noexcept {
    if (amount > std::numeric_limits<std::size_t>::max() - total) return false;
    total += amount;
    return true;
}

bool multiplySize(std::size_t left, std::size_t right, std::size_t& result) noexcept {
    if (left != 0U && right > std::numeric_limits<std::size_t>::max() / left) return false;
    result = left * right;
    return true;
}

PitchProfileId toProfileId(PitchFxProfile profile) noexcept {
    switch (profile) {
    case PitchFxProfile::LiveMono: return PitchProfileId::LiveMono;
    case PitchFxProfile::LivePoly: return PitchProfileId::LivePoly;
    case PitchFxProfile::HqRender: return PitchProfileId::HqRender;
    }
    return PitchProfileId::LiveMono;
}

bool profileAllowed(std::uint16_t ordinal, PitchFxProfile profile) noexcept {
    if (!isPitchOrdinal(ordinal)) return false;
    if (profile != PitchFxProfile::LiveMono && profile != PitchFxProfile::LivePoly &&
        profile != PitchFxProfile::HqRender) return false;
    return ordinal != 18U || profile != PitchFxProfile::LiveMono;
}

bool makeSettings(PitchFxProfile profile, const ProcessSpec& stereoSpec,
                  std::uint32_t seed, PitchProfileSettings& settings) noexcept {
    return makePitchProfileSettings(toProfileId(profile), stereoSpec.sampleRate,
                                    stereoSpec.maxBlockFrames, seed, settings,
                                    kLiveMonoWorkUnits);
}

float semitonesToRatio(float semitones) noexcept {
    return std::exp2(semitones / 12.0f);
}

StereoFrame panStereo(StereoFrame input, float pan) noexcept {
    // Same stereo-image panning law used by the shared ManualPan processor:
    // center is unchanged, while a hard edge folds both input channels into
    // that side with constant-power gains.
    const float bounded = std::clamp(pan, -1.0f, 1.0f);
    const float x = bounded <= 0.0f ? bounded + 1.0f : bounded;
    const float angle = x * kPi * 0.5f;
    const float leftGain = std::cos(angle);
    const float rightGain = std::sin(angle);
    if (bounded <= 0.0f)
        return {input.left + input.right * leftGain, input.right * rightGain};
    return {input.left * leftGain, input.right + input.left * rightGain};
}

float clean(float value) noexcept {
    return std::isfinite(value) && std::abs(value) > 1.0e-30f ? value : 0.0f;
}

} // namespace

struct PitchFxAdapter::PreparedState {
    explicit PreparedState(std::uint32_t seed) noexcept
        : stretch{{SignalsmithStretchAdapter(seed),
                   SignalsmithStretchAdapter(seed ^ 0x9e3779b9U)}} {}

    ProcessSpec spec{};
    PitchFxProfile profile = PitchFxProfile::LivePoly;
    bool liveMono = false;
    bool harmony = false;
    // PSOLA sinc tables are embedded in each route. Keep them out of
    // Signalsmith-only profiles and instantiate exactly the two mono routes
    // used by TRANSPOSE/PITCH BEND.
    std::array<std::unique_ptr<LiveMonoPitchRoute>, 2> monoRoutes{};
    std::array<SignalsmithStretchAdapter, 2> stretch;
    // Single-pitch uses slots 0..1 (L/R); HRM MANUAL uses [voice*2 + channel].
    std::array<std::unique_ptr<float[]>, 4> scratch{};
    std::uint32_t scratchChannels = 0U;
};

PitchFxAdapter::PitchFxAdapter(std::uint16_t ordinal) noexcept : ordinal_(ordinal) {
    if (ordinal_ == 18U) {
        profile_ = PitchFxProfile::LivePoly;
        harmonyVoiceCount_ = 2U;
    } else {
        // TRANSPOSE exposes formant controls in its default profile. PITCH
        // BEND defaults to the lighter mono YIN/PSOLA route.
        profile_ = ordinal_ == 14U ? PitchFxProfile::LivePoly : PitchFxProfile::LiveMono;
    }
}

PitchFxAdapter::~PitchFxAdapter() = default;

std::size_t PitchFxAdapter::requiredPreparedStateBytes(
    std::uint16_t ordinal, const ProcessSpec& spec, PitchFxProfile profile) noexcept {
    if (!isPitchOrdinal(ordinal) || !profileAllowed(ordinal, profile) ||
        !validProcessSpec(spec) || spec.channels != 2U || spec.sampleRate > 192000.0f)
        return 0U;

    std::size_t total = sizeof(PreparedState);
    const std::uint32_t routeCount = ordinal == 18U ? 2U : 1U;
    if (profile == PitchFxProfile::LiveMono) {
        const ProcessSpec monoSpec{spec.sampleRate, spec.maxBlockFrames, 1U};
        LiveMonoPitchSettings monoSettings{monoSpec, kLiveMonoWindowFrames,
            kLiveMonoHopFrames, kLiveMonoWorkUnits, kLiveMonoMinimumHz,
            kLiveMonoMaximumHz, kYinThreshold};
        const auto routeBytes = LiveMonoPitchRoute::requiredPrepareBytes(monoSettings);
        if (routeBytes == 0U) return 0U;
        const auto channels = ordinal == 18U ? 0U : 2U;
        const auto routes = static_cast<std::size_t>(channels) * routeCount;
        std::size_t routeTotal = 0U;
        if (!multiplySize(routeBytes, routes, routeTotal) || !addSize(total, routeTotal)) return 0U;
    } else {
        PitchProfileSettings profileSettings{};
        if (!makeSettings(profile, spec, kSignalsmithSeed, profileSettings)) return 0U;
        const auto adapterBytes = SignalsmithStretchAdapter::requiredLivePrepareBytes(
            spec, profileSettings.signalsmith);
        if (adapterBytes == 0U) return 0U;
        std::size_t adapterTotal = 0U;
        if (!multiplySize(adapterBytes, routeCount, adapterTotal) ||
            !addSize(total, adapterTotal)) return 0U;
    }

    const std::size_t outputChannels = ordinal == 18U ? 4U : 2U;
    std::size_t scratchBytes = 0U;
    if (!multiplySize(outputChannels, spec.maxBlockFrames, scratchBytes) ||
        !multiplySize(scratchBytes, sizeof(float), scratchBytes) ||
        !addSize(total, scratchBytes)) return 0U;
    return total;
}

std::size_t PitchFxAdapter::maximumPreparedStateBytes(
    std::uint16_t ordinal, const ProcessSpec& spec) noexcept {
    if (!isPitchOrdinal(ordinal)) return 0U;
    std::size_t result = 0U;
    for (const auto profile : {PitchFxProfile::LiveMono, PitchFxProfile::LivePoly,
                               PitchFxProfile::HqRender}) {
        if (!profileAllowed(ordinal, profile)) continue;
        result = std::max(result, requiredPreparedStateBytes(ordinal, spec, profile));
    }
    return result;
}

std::uint32_t PitchFxAdapter::startupWarmupUpperBoundFrames(
    std::uint16_t ordinal, const ProcessSpec& spec, PitchFxProfile profile) noexcept {
    if (!isPitchOrdinal(ordinal) || !profileAllowed(ordinal, profile) ||
        !validProcessSpec(spec) || spec.channels != 2U || spec.sampleRate > 192000.0f)
        return 0U;
    if (profile == PitchFxProfile::LiveMono) {
        const double period = std::ceil(static_cast<double>(spec.sampleRate) /
                                        kLiveMonoMinimumHz);
        if (!std::isfinite(period) || period < 1.0 ||
            period > static_cast<double>(std::numeric_limits<std::uint32_t>::max() / 3U))
            return 0U;
        // Match the route's fixed 4096-frame YIN window and its PSOLA lookahead
        // of three maximum periods. The 192 kHz/40 Hz case is rejected by the
        // route preflight because that lag does not fit in this window.
        const ProcessSpec monoSpec{spec.sampleRate, spec.maxBlockFrames, 1U};
        LiveMonoPitchSettings monoSettings{monoSpec, kLiveMonoWindowFrames,
            kLiveMonoHopFrames, kLiveMonoWorkUnits, kLiveMonoMinimumHz,
            kLiveMonoMaximumHz, kYinThreshold};
        if (LiveMonoPitchRoute::requiredPrepareBytes(monoSettings) == 0U) return 0U;
        return kLiveMonoWindowFrames + kLiveMonoHopFrames +
               3U * static_cast<std::uint32_t>(period);
    }

    PitchProfileSettings profileSettings{};
    if (!makeSettings(profile, spec, kSignalsmithSeed, profileSettings)) return 0U;
    // Cold-start waiting bound is intentionally conservative and distinct from
    // Signalsmith's input/output latency getters; it is not measured latency.
    const auto frames = 2ULL * profileSettings.signalsmith.blockSamples +
                        profileSettings.signalsmith.intervalSamples;
    return frames <= std::numeric_limits<std::uint32_t>::max()
        ? static_cast<std::uint32_t>(frames) : 0U;
}

std::uint32_t PitchFxAdapter::maximumStartupWarmupUpperBoundFrames(
    std::uint16_t ordinal, const ProcessSpec& spec) noexcept {
    std::uint32_t result = 0U;
    bool supported = false;
    for (const auto profile : {PitchFxProfile::LiveMono, PitchFxProfile::LivePoly,
                               PitchFxProfile::HqRender}) {
        if (!profileAllowed(ordinal, profile)) continue;
        const auto frames = startupWarmupUpperBoundFrames(ordinal, spec, profile);
        if (frames == 0U && requiredPreparedStateBytes(ordinal, spec, profile) == 0U) continue;
        supported = true;
        result = std::max(result, frames);
    }
    return supported ? result : 0U;
}

bool PitchFxAdapter::prepareState(const ProcessSpec& spec,
                                  std::unique_ptr<PreparedState>& candidate) noexcept {
    if (requiredPreparedStateBytes(ordinal_, spec, profile_) == 0U) return false;
    candidate.reset(new (std::nothrow) PreparedState(kSignalsmithSeed));
    if (!candidate) return false;
    candidate->spec = spec;
    candidate->profile = profile_;
    candidate->liveMono = profile_ == PitchFxProfile::LiveMono;
    candidate->harmony = ordinal_ == 18U;
    candidate->scratchChannels = candidate->harmony ? 4U : 2U;
    for (std::uint32_t i = 0U; i < candidate->scratchChannels; ++i) {
        candidate->scratch[i].reset(new (std::nothrow) float[spec.maxBlockFrames]);
        if (!candidate->scratch[i]) return false;
        std::fill_n(candidate->scratch[i].get(), spec.maxBlockFrames, 0.0f);
    }

    if (candidate->liveMono) {
        if (ordinal_ == 18U) return false;
        const ProcessSpec monoSpec{spec.sampleRate, spec.maxBlockFrames, 1U};
        LiveMonoPitchSettings monoSettings{monoSpec, kLiveMonoWindowFrames,
            kLiveMonoHopFrames, kLiveMonoWorkUnits, kLiveMonoMinimumHz,
            kLiveMonoMaximumHz, kYinThreshold};
        WEBRC_PITCH_TRY {
            for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
                candidate->monoRoutes[channel].reset(new (std::nothrow) LiveMonoPitchRoute());
                if (!candidate->monoRoutes[channel] ||
                    !candidate->monoRoutes[channel]->prepare(monoSettings) ||
                    !candidate->monoRoutes[channel]->setPitchRatio(
                        semitonesToRatio(ordinal_ == 15U ? bendCurrentSemitones_ : semitones_)))
                    return false;
            }
        } WEBRC_PITCH_CATCH_ALL {
            return false;
        }
        return true;
    }

    PitchProfileSettings profileSettings{};
    if (!makeSettings(profile_, spec, kSignalsmithSeed, profileSettings)) return false;
    const std::uint32_t voices = candidate->harmony ? 2U : 1U;
    for (std::uint32_t voice = 0U; voice < voices; ++voice) {
        auto& stretch = candidate->stretch[voice];
        auto voiceSettings = profileSettings.signalsmith;
        if (candidate->harmony && voice != 0U)
            voiceSettings.seed = (kSignalsmithSeed ^ 0x9e3779b9U) & 0x7fffffffU;
        const auto required = SignalsmithStretchAdapter::requiredLivePrepareBytes(
            spec, voiceSettings);
        if (required == 0U || !stretch.prepareLive(spec, voiceSettings, required)) return false;
        const float ratio = candidate->harmony
            ? semitonesToRatio(harmonySemitones_[voice])
            : semitonesToRatio(ordinal_ == 15U ? bendCurrentSemitones_ : semitones_);
        const float formant = candidate->harmony ? harmonyFormant_[voice] : formantFactor_;
        const bool compensation = candidate->harmony || formantCompensation_;
        if (!stretch.setTransposeFactor(ratio) || !stretch.setFormantFactor(formant, compensation))
            return false;
    }
    return true;
}

bool PitchFxAdapter::prepare(const ProcessSpec& spec) noexcept {
    if (ordinal_ != 14U && ordinal_ != 15U && ordinal_ != 18U) return false;
    if (ordinal_ == 18U && (profile_ == PitchFxProfile::LiveMono || harmonyVoiceCount_ > 2U))
        return false;
    if (ordinal_ != 18U && profile_ == PitchFxProfile::LiveMono &&
        (formantFactor_ != 1.0f || formantCompensation_)) return false;
    if (ordinal_ == 15U) {
        const float activeSemitones = bendCurrentSemitones_;
        if (profile_ == PitchFxProfile::LiveMono && std::abs(activeSemitones) > 12.0f) return false;
    }
    std::unique_ptr<PreparedState> candidate;
    if (!prepareState(spec, candidate)) return false;
    state_.swap(candidate);
    spec_ = spec;
    prepared_ = true;
    wetCurrent_ = wetTarget_;
    return true;
}

void PitchFxAdapter::reset() noexcept {
    if (!prepared_ || !state_) return;
    for (auto& route : state_->monoRoutes) if (route) route->reset();
    for (auto& stretch : state_->stretch) stretch.reset();
    for (std::uint32_t i = 0U; i < state_->scratchChannels; ++i)
        std::fill_n(state_->scratch[i].get(), spec_.maxBlockFrames, 0.0f);
    bendCurrentSemitones_ = bendTargetSemitones_;
    bendRampRemaining_ = 0U;
    wetCurrent_ = wetTarget_;
    wetRampRemaining_ = 0U;
    applyCurrentPitchRatio();
    if (ordinal_ == 18U) {
        for (std::uint32_t voice = 0U; voice < 2U; ++voice)
            (void)retargetHarmonyVoice(voice, harmonySemitones_[voice], harmonyFormant_[voice]);
    }
}

bool PitchFxAdapter::validateBlockRequest(std::uint32_t channels,
                                          std::uint32_t frames) const noexcept {
    return prepared_ && state_ && channels == 2U && frames > 0U &&
           frames <= spec_.maxBlockFrames && state_->profile == profile_;
}

bool PitchFxAdapter::validParameter(FxParameterId id, float value) const noexcept {
    if (!std::isfinite(value)) return false;
    if (id == FxParameterId::Active) return value == 0.0f || value == 1.0f;
    if (id == FxParameterId::Mix) return value >= 0.0f && value <= 1.0f;
    if (id == FxParameterId::PitchProfile)
        return isProfileValue(value) && profileAllowed(ordinal_, static_cast<PitchFxProfile>(
            static_cast<std::uint8_t>(value))) &&
            (static_cast<PitchFxProfile>(static_cast<std::uint8_t>(value)) != PitchFxProfile::LiveMono ||
             ordinal_ != 18U);
    if (ordinal_ == 14U) {
        if (id == FxParameterId::Semitones) return value >= -12.0f && value <= 12.0f;
        if (id == FxParameterId::FormantFactor)
            return value >= 0.5f && value <= 2.0f &&
                   (profile_ != PitchFxProfile::LiveMono || value == 1.0f);
        if (id == FxParameterId::FormantCompensation)
            return value == 0.0f || (profile_ != PitchFxProfile::LiveMono && value == 1.0f);
        return false;
    }
    if (ordinal_ == 15U) {
        if (id == FxParameterId::Semitones) return value >= -12.0f && value <= 12.0f;
        if (id == FxParameterId::BendSmoothingMs) return value >= 1.0f && value <= 500.0f;
        return false;
    }
    if (ordinal_ == 18U) {
        if (id == FxParameterId::HarmonyVoiceCount)
            return value >= 0.0f && value <= 2.0f && std::floor(value) == value;
        if (id == FxParameterId::HarmonyVoice1Semitones ||
            id == FxParameterId::HarmonyVoice2Semitones)
            return value >= -24.0f && value <= 24.0f;
        if (id == FxParameterId::HarmonyVoice1Formant ||
            id == FxParameterId::HarmonyVoice2Formant)
            return value >= 0.5f && value <= 2.0f;
        if (id == FxParameterId::HarmonyVoice1Pan ||
            id == FxParameterId::HarmonyVoice2Pan)
            return value >= -1.0f && value <= 1.0f;
        return false;
    }
    return false;
}

bool PitchFxAdapter::isPrepareTimeParameter(FxParameterId id) const noexcept {
    return id == FxParameterId::PitchProfile;
}

bool PitchFxAdapter::setParameter(FxParameterId id, float value) noexcept {
    if (!validParameter(id, value) || (prepared_ && isPrepareTimeParameter(id))) return false;
    if (id == FxParameterId::Active) {
        active_ = value != 0.0f;
        wetTarget_ = active_ ? wet_ : 0.0f;
        wetRampRemaining_ = std::max<std::uint32_t>(1U,
            static_cast<std::uint32_t>(std::ceil(spec_.sampleRate > 0.0f
                ? spec_.sampleRate * 0.005f : 240.0f)));
        return true;
    }
    if (id == FxParameterId::Mix) {
        wet_ = value;
        wetTarget_ = active_ ? wet_ : 0.0f;
        wetRampRemaining_ = std::max<std::uint32_t>(1U,
            static_cast<std::uint32_t>(std::ceil(spec_.sampleRate > 0.0f
                ? spec_.sampleRate * 0.005f : 240.0f)));
        return true;
    }
    if (id == FxParameterId::PitchProfile) {
        const auto selected = static_cast<PitchFxProfile>(static_cast<std::uint8_t>(value));
        if (selected == PitchFxProfile::LiveMono && ordinal_ == 18U) return false;
        if (selected == PitchFxProfile::LiveMono && ordinal_ == 14U &&
            (formantFactor_ != 1.0f || formantCompensation_)) return false;
        profile_ = selected;
        return true;
    }
    if (ordinal_ == 14U && id == FxParameterId::Semitones) {
        if (prepared_ && !retargetPitch(value)) return false;
        semitones_ = value;
        return true;
    }
    if (ordinal_ == 14U && id == FxParameterId::FormantFactor) {
        if (profile_ == PitchFxProfile::LiveMono) {
            if (value != 1.0f) return false;
            formantFactor_ = value;
            return true;
        }
        if (prepared_ && !state_->stretch[0].setFormantFactor(value, formantCompensation_))
            return false;
        formantFactor_ = value;
        return true;
    }
    if (ordinal_ == 14U && id == FxParameterId::FormantCompensation) {
        const bool enabled = value != 0.0f;
        if (profile_ == PitchFxProfile::LiveMono) {
            if (enabled) return false;
            formantCompensation_ = false;
            return true;
        }
        if (prepared_ && !state_->stretch[0].setFormantFactor(formantFactor_, enabled)) return false;
        formantCompensation_ = enabled;
        return true;
    }
    if (ordinal_ == 15U && id == FxParameterId::Semitones) {
        bendTargetSemitones_ = value;
        const auto ramp = static_cast<double>(spec_.sampleRate) * bendSmoothingMs_ * 0.001;
        bendRampRemaining_ = std::max<std::uint32_t>(1U,
            static_cast<std::uint32_t>(std::ceil(std::max(1.0, ramp))));
        if (!prepared_) bendCurrentSemitones_ = value;
        return true;
    }
    if (ordinal_ == 15U && id == FxParameterId::BendSmoothingMs) {
        bendSmoothingMs_ = value;
        return true;
    }
    if (ordinal_ == 18U) {
        std::uint32_t voice = 0U;
        if (id == FxParameterId::HarmonyVoiceCount) {
            harmonyVoiceCount_ = static_cast<std::uint32_t>(value);
            return true;
        }
        if (id == FxParameterId::HarmonyVoice1Semitones ||
            id == FxParameterId::HarmonyVoice1Formant) voice = 0U;
        else if (id == FxParameterId::HarmonyVoice2Semitones ||
                 id == FxParameterId::HarmonyVoice2Formant) voice = 1U;
        if (id == FxParameterId::HarmonyVoice1Semitones ||
            id == FxParameterId::HarmonyVoice2Semitones) {
            if (prepared_ && !retargetHarmonyVoice(voice, value, harmonyFormant_[voice])) return false;
            harmonySemitones_[voice] = value;
            return true;
        }
        if (id == FxParameterId::HarmonyVoice1Formant ||
            id == FxParameterId::HarmonyVoice2Formant) {
            if (prepared_ && !retargetHarmonyVoice(voice, harmonySemitones_[voice], value)) return false;
            harmonyFormant_[voice] = value;
            return true;
        }
        if (id == FxParameterId::HarmonyVoice1Pan || id == FxParameterId::HarmonyVoice2Pan) {
            harmonyPan_[id == FxParameterId::HarmonyVoice1Pan ? 0U : 1U] = value;
            return true;
        }
    }
    return false;
}

bool PitchFxAdapter::validateParameterEvents(const FxParameterEvent* events,
                                             std::uint32_t eventCount) const noexcept {
    if ((eventCount != 0U && events == nullptr) || eventCount > 64U) return false;
    auto candidateProfile = profile_;
    float candidateFormant = formantFactor_;
    bool candidateCompensation = formantCompensation_;
    for (std::uint32_t i = 0U; i < eventCount; ++i) {
        const auto& event = events[i];
        if ((prepared_ && isPrepareTimeParameter(event.parameter)) || !std::isfinite(event.value))
            return false;
        if (ordinal_ == 14U && event.parameter == FxParameterId::PitchProfile) {
            if (!isProfileValue(event.value)) return false;
            candidateProfile = static_cast<PitchFxProfile>(static_cast<std::uint8_t>(event.value));
            if (!profileAllowed(ordinal_, candidateProfile)) return false;
            continue;
        }
        if (ordinal_ == 14U && event.parameter == FxParameterId::FormantFactor) {
            if (event.value < 0.5f || event.value > 2.0f ||
                (candidateProfile == PitchFxProfile::LiveMono && event.value != 1.0f)) return false;
            candidateFormant = event.value;
            continue;
        }
        if (ordinal_ == 14U && event.parameter == FxParameterId::FormantCompensation) {
            if ((event.value != 0.0f && event.value != 1.0f) ||
                (candidateProfile == PitchFxProfile::LiveMono && event.value != 0.0f)) return false;
            candidateCompensation = event.value != 0.0f;
            continue;
        }
        // Other fields use the currently prepared backend's parameter rules.
        if (!validParameter(event.parameter, event.value)) return false;
    }
    return ordinal_ != 14U || candidateProfile != PitchFxProfile::LiveMono ||
           (candidateFormant == 1.0f && !candidateCompensation);
}

bool PitchFxAdapter::retargetPitch(float semitones) noexcept {
    if (!prepared_ || !state_) return true;
    if (profile_ == PitchFxProfile::LiveMono) {
        const float ratio = semitonesToRatio(semitones);
        if (ratio < 0.5f || ratio > 2.0f) return false;
        return state_->monoRoutes[0] && state_->monoRoutes[1] &&
               state_->monoRoutes[0]->setPitchRatio(ratio) &&
               state_->monoRoutes[1]->setPitchRatio(ratio);
    }
    return state_->stretch[0].setTransposeFactor(semitonesToRatio(semitones));
}

bool PitchFxAdapter::retargetHarmonyVoice(std::uint32_t voice, float semitones,
                                          float formantFactor) noexcept {
    if (!prepared_ || !state_) return true;
    if (ordinal_ != 18U || voice >= 2U || state_->liveMono) return false;
    return state_->stretch[voice].setTransposeFactor(semitonesToRatio(semitones)) &&
           state_->stretch[voice].setFormantFactor(formantFactor, true);
}

void PitchFxAdapter::applyCurrentPitchRatio() noexcept {
    if ((ordinal_ != 14U && ordinal_ != 15U) || !prepared_ || !state_) return;
    const float ratio = semitonesToRatio(ordinal_ == 15U ? bendCurrentSemitones_ : semitones_);
    if (profile_ == PitchFxProfile::LiveMono) {
        if (state_->monoRoutes[0]) (void)state_->monoRoutes[0]->setPitchRatio(ratio);
        if (state_->monoRoutes[1]) (void)state_->monoRoutes[1]->setPitchRatio(ratio);
    } else {
        (void)state_->stretch[0].setTransposeFactor(ratio);
    }
}

bool PitchFxAdapter::processSinglePitch(const float* const* input,
                                        float* const* output,
                                        std::uint32_t frames) noexcept {
    if (input == nullptr || output == nullptr || !state_) return false;
    const std::uint32_t chunkLimit = ordinal_ == 15U ? kBendUpdateQuantum : frames;
    std::uint32_t cursor = 0U;
    while (cursor < frames) {
        const auto chunk = std::min(chunkLimit, frames - cursor);
        if (ordinal_ == 15U && bendRampRemaining_ > 0U) {
            const auto advance = std::min(chunk, bendRampRemaining_);
            bendCurrentSemitones_ += (bendTargetSemitones_ - bendCurrentSemitones_) *
                static_cast<float>(advance) / static_cast<float>(bendRampRemaining_);
            bendRampRemaining_ -= advance;
            if (bendRampRemaining_ == 0U) bendCurrentSemitones_ = bendTargetSemitones_;
            applyCurrentPitchRatio();
        }

        if (profile_ == PitchFxProfile::LiveMono) {
            for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
                if (!state_->monoRoutes[channel] || !state_->monoRoutes[channel]->processBlock(
                        input[channel] + cursor, state_->scratch[channel].get(), chunk)) return false;
            }
        } else {
            std::array<const float*, 2> in{{input[0] + cursor, input[1] + cursor}};
            std::array<float*, 2> out{{state_->scratch[0].get(), state_->scratch[1].get()}};
            if (!state_->stretch[0].process(in.data(), chunk, out.data(), chunk)) return false;
        }

        const float currentSemitones = ordinal_ == 15U ? bendCurrentSemitones_ : semitones_;
        float pitchEngagement = 1.0f;
        const bool neutralFormant = ordinal_ == 15U ||
            (!formantCompensation_ && formantFactor_ == 1.0f);
        if (neutralFormant) {
            // The streaming backend is not dry/wet time-aligned near unity.
            // Taper its contribution continuously over the closest quarter
            // semitone so a bend crossing zero cannot switch abruptly from
            // exact dry to a full, phase-shifted wet signal.
            constexpr float kUnityBlendFullSemitones = 0.25f;
            const float engagement = std::clamp(
                std::abs(currentSemitones) / kUnityBlendFullSemitones, 0.0f, 1.0f);
            pitchEngagement = engagement * engagement * (3.0f - 2.0f * engagement);
        }
        for (std::uint32_t frame = 0U; frame < chunk; ++frame) {
            if (wetRampRemaining_ > 0U) {
                wetCurrent_ += (wetTarget_ - wetCurrent_) / static_cast<float>(wetRampRemaining_);
                --wetRampRemaining_;
                if (wetRampRemaining_ == 0U) wetCurrent_ = wetTarget_;
            }
            const auto outputFrame = cursor + frame;
            for (std::uint32_t channel = 0U; channel < 2U; ++channel) {
                const auto dry = clean(input[channel][outputFrame]);
                // Keep the backend warm at unity, but taper its unaligned
                // contribution smoothly near unity. This makes the exact
                // identity point continuous; it does not qualify non-unity
                // dry/wet phase alignment.
                const auto wet = clean(state_->scratch[channel][frame]);
                output[channel][outputFrame] = dry + (wet - dry) * (wetCurrent_ * pitchEngagement);
            }
        }
        cursor += chunk;
    }
    return true;
}

void PitchFxAdapter::applyHarmonyPanMix(const float* const* input,
                                       float* const* output,
                                       std::uint32_t frames) noexcept {
    for (std::uint32_t frame = 0U; frame < frames; ++frame) {
        if (wetRampRemaining_ > 0U) {
            wetCurrent_ += (wetTarget_ - wetCurrent_) / static_cast<float>(wetRampRemaining_);
            --wetRampRemaining_;
            if (wetRampRemaining_ == 0U) wetCurrent_ = wetTarget_;
        }
        StereoFrame voices{};
        for (std::uint32_t voice = 0U; voice < harmonyVoiceCount_; ++voice) {
            const auto left = clean(state_->scratch[voice * 2U][frame]);
            const auto right = clean(state_->scratch[voice * 2U + 1U][frame]);
            const auto panned = panStereo({left, right}, harmonyPan_[voice]);
            voices.left += panned.left;
            voices.right += panned.right;
        }
        if (harmonyVoiceCount_ > 0U) {
            const float voiceGain = wetCurrent_ / static_cast<float>(harmonyVoiceCount_);
            voices.left *= voiceGain;
            voices.right *= voiceGain;
        }
        output[0][frame] = clean(input[0][frame]) * (1.0f - wetCurrent_) + voices.left;
        output[1][frame] = clean(input[1][frame]) * (1.0f - wetCurrent_) + voices.right;
    }
}

bool PitchFxAdapter::processHarmony(const float* const* input,
                                    std::uint32_t frames) noexcept {
    if (input == nullptr || !state_ || state_->liveMono) return false;
    for (std::uint32_t voice = 0U; voice < 2U; ++voice) {
        std::array<const float*, 2> in{{input[0], input[1]}};
        std::array<float*, 2> out{{state_->scratch[voice * 2U].get(),
                                   state_->scratch[voice * 2U + 1U].get()}};
        if (!state_->stretch[voice].process(in.data(), frames, out.data(), frames)) return false;
    }
    return true;
}

bool PitchFxAdapter::processBlock(const float* const* input,
                                 float* const* output,
                                 std::uint32_t channels,
                                 std::uint32_t frames) noexcept {
    if (!validateBlockRequest(channels, frames) || input == nullptr || output == nullptr ||
        !input[0] || !input[1] || !output[0] || !output[1]) return false;
    if (ordinal_ == 18U) {
        if (!processHarmony(input, frames)) return false;
        applyHarmonyPanMix(input, output, frames);
        return true;
    }
    return processSinglePitch(input, output, frames);
}

std::uint32_t PitchFxAdapter::startupWarmupFrames() const noexcept {
    return prepared_ ? startupWarmupUpperBoundFrames(ordinal_, spec_, profile_) : 0U;
}

PitchFxLatencyReport PitchFxAdapter::latencyReport() const noexcept {
    PitchFxLatencyReport report{};
    report.profile = profile_;
    if (!prepared_ || !state_) return report;
    report.startupWarmupUpperBoundFrames = startupWarmupFrames();
    if (profile_ == PitchFxProfile::LiveMono) {
        report.detectorWindowFrames = kLiveMonoWindowFrames;
        report.detectorHopFrames = kLiveMonoHopFrames;
        report.psolaLookaheadFrames = state_->monoRoutes[0]
            ? state_->monoRoutes[0]->resynthesisLatencySamples() : 0U;
    } else {
        report.signalsmithInputFrames = state_->stretch[0].inputLatencySamples();
        report.signalsmithOutputFrames = state_->stretch[0].outputLatencySamples();
    }
    return report;
}

} // namespace webrc::dsp
